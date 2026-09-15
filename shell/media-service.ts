// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// media-service.ts
// ffmpeg-backed thumbnail / transcode / probe, driven by the qz subsystem
// and cached by content signature so the same input + params never re-runs.
//
// ffmpeg resolution order:
//   1. process.env.QQQ_FFMPEG  (explicit override)
//   2. $QQQIDE_QDIR/components/ffmpeg/ffmpeg(.exe)
//   3. <appRoot>/engines/ffmpeg/ffmpeg(.exe)
//   4. system PATH (qz.which('ffmpeg'))
//
// ffprobe is resolved analogously; falls back to `ffmpeg -i` parsing if absent.
//
// All spawns go through QzSpawn so they get tree-kill + deadline + stall watchdog.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { QzSpawn } from './qz-spawn';
import { CacheStore } from './cache-store';
import { HashService } from './hash-service';

export interface ThumbOpts {
    src: string;            // absolute source path
    w?: number;             // target width (default 256)
    h?: number;             // target height (default 256)
    ts?: number;            // video seek seconds (default 1.0)
    format?: 'png' | 'jpg' | 'webp';   // default 'jpg' (smaller)
    quality?: number;       // 1..31 for jpg (lower = better), default 5
    fit?: 'cover' | 'contain';         // default 'contain' (preserve aspect)
}

export interface TranscodeOpts {
    src: string;
    dst?: string;           // optional explicit destination; else cache bucket
    format: string;         // 'mp4' | 'webm' | 'mp3' | 'wav' | etc
    vbr?: string;           // e.g. '1000k'
    abr?: string;           // e.g. '128k'
    extraArgs?: string[];   // appended raw
}

export interface MediaResult {
    ok: boolean;
    path?: string;
    width?: number;
    height?: number;
    duration?: number;      // seconds
    codec?: string;
    cached?: boolean;
    error?: string;
    stderr?: string;
}

// ── WYSIWYG 相框预览（q3 q1.js 移植）────────────────────────────────────────
export type PreviewMode = 'extreme' | 'accelerated' | 'optmum';

export interface PreviewOpts {
    src: string;
    mode?: PreviewMode;         // default 'optmum'
}

export interface TextPreviewOpts {
    src: string;
    scheme?: 'light' | 'dark';  // textSlideColorScheme
    fontSize?: number;          // textSlideFontSize
}

export interface PreviewResult {
    ok: boolean;
    kind?: 'direct' | 'webp' | 'text';
    path?: string;
    width?: number;
    height?: number;
    duration?: number;          // preview animation duration (s); 0 = static
    animated?: boolean;
    sourceDuration?: number;
    cached?: boolean;
    error?: string;
    stderr?: string;
}

export class MediaService {
    private _ffmpegPath: string | null = null;
    private _ffprobePath: string | null = null;
    private _resolved = false;

    constructor(
        private appRoot: string,
        private qz: QzSpawn,
        private cache: CacheStore,
        private hash: HashService,
    ) {}

    // =========================================================================
    // ★ 缓存机器（老 q3 qqq.js geq() 全套语义移植）
    //   ① 键 = 源文件 stat 指纹（路径|mtime|size 哈希；零内容读取——老 computeFingerprint）
    //   ② in-flight 去重（同键并发复用同一生成 promise——老 taskKey=gen:{id}:{q}）
    //   ③ broken 熔断（失败指数退避 2min×2ⁿ 封顶 24h + 源变更自动解禁——老 brokenFiles）
    //   ④ 容量管理（40MB 上限 / 28MB 淘汰目标；atime LRU——老 CACHE_MAX_SIZE/CACHE_TARGET_SIZE）
    //   ⑤ 命中索引（size/dur 直读索引免读盘解析 + hit/miss 统计——老 cacheMeta）
    // =========================================================================
    private static readonly CACHE_MAX_SIZE = 40 * 1048576;
    private static readonly CACHE_TARGET_SIZE = 28 * 1048576;
    private static readonly BROKEN_BASE_TTL_MS = 2 * 60_000;
    private static readonly BROKEN_MAX_TTL_MS = 24 * 3600_000;

    private _inflight = new Map<string, Promise<any>>();
    private _sigMemo = new Map<string, { m: number; s: number; sig: string }>();
    private _broken: Map<string, any> | null = null;
    private _idx: { entries: Record<string, any>; stats: { hit: number; miss: number } } | null = null;
    private _idxTimer: any = null;
    private _brokenTimer: any = null;

    /** 源文件 stat 指纹（老 computeFingerprintCached：路径|mtime|size → sig；零内容读取） */
    private async _srcStat(absPath: string): Promise<{ sig: string; mtimeMs: number; size: number } | null> {
        try {
            const st = await fs.promises.stat(absPath);
            const k = absPath.toLowerCase();
            const m = this._sigMemo.get(k);
            if (m && m.m === st.mtimeMs && m.s === st.size) {
                return { sig: m.sig, mtimeMs: st.mtimeMs, size: st.size };
            }
            const sig = this.shortHash(k + '|' + Math.floor(st.mtimeMs) + '|' + st.size);
            this._sigMemo.set(k, { m: st.mtimeMs, s: st.size, sig });
            if (this._sigMemo.size > 5000) {
                const ks = Array.from(this._sigMemo.keys()).slice(0, 2500);
                for (const kk of ks) { this._sigMemo.delete(kk); }
            }
            return { sig, mtimeMs: st.mtimeMs, size: st.size };
        } catch { return null; }
    }

    // ── 命中索引（KV 持久化 + 防抖写盘）────────────────────────────────────
    private async _loadIdx(): Promise<void> {
        if (this._idx) return;
        let data: any = null;
        try { data = await this.cache.get('media:index'); } catch { /* ignore */ }
        this._idx = {
            entries: (data && data.entries) || {},
            stats: (data && data.stats) || { hit: 0, miss: 0 },
        };
    }
    private _idxFlushSoon(): void {
        if (this._idxTimer) return;
        this._idxTimer = setTimeout(() => {
            this._idxTimer = null;
            this._flushIdx().catch(() => { /* ignore */ });
        }, 1500);
        try { if (this._idxTimer && this._idxTimer.unref) { this._idxTimer.unref(); } } catch { /* ignore */ }
    }
    private async _flushIdx(): Promise<void> {
        if (!this._idx) return;
        try { await this.cache.put('media:index', { v: 1, entries: this._idx.entries, stats: this._idx.stats }); } catch { /* ignore */ }
    }
    private async _touch(key: string, file: string, size?: number, dur?: number): Promise<void> {
        await this._loadIdx();
        const idx = this._idx!;
        const e = idx.entries[key] || { file, size: 0, atime: 0, dur: 0 };
        e.file = file;
        e.atime = Date.now();
        if (size != null) { e.size = size; }
        if (dur != null) { e.dur = dur; }
        idx.entries[key] = e;
        this._idxFlushSoon();
    }
    /** 容量管理：超 40MB → 按 atime LRU 淘汰到 28MB（老 ensureCacheSpace 语义） */
    private async _ensureSpace(needed: number): Promise<void> {
        await this._loadIdx();
        const idx = this._idx!;
        const totalOf = (): number => Object.values(idx.entries).reduce((a: number, e: any) => a + (Number(e && e.size) || 0), 0);
        if (totalOf() + needed <= MediaService.CACHE_MAX_SIZE) return;
        const list = Object.entries(idx.entries).sort((a: any, b: any) => (a[1].atime || 0) - (b[1].atime || 0));
        let t = totalOf();
        for (const [k, e] of list) {
            if (t + needed <= MediaService.CACHE_TARGET_SIZE) break;
            try { fs.rmSync(e.file, { force: true }); } catch { /* ignore */ }
            t -= Number(e.size) || 0;
            delete idx.entries[k];
        }
        await this._flushIdx();
    }

    // ── broken 熔断（老 brokenFiles：指数退避 + 源变更解禁）──────────────────
    private async _loadBroken(): Promise<void> {
        if (this._broken) return;
        let data: any = null;
        try { data = await this.cache.get('media:broken'); } catch { /* ignore */ }
        this._broken = new Map(Object.entries((data && data.entries) || {}));
    }
    private async _brokenHit(st: { sig: string; mtimeMs: number; size: number }): Promise<boolean> {
        await this._loadBroken();
        const rec = this._broken!.get(st.sig);
        if (!rec) return false;
        const now = Date.now();
        if (rec.until && now > rec.until) { this._broken!.delete(st.sig); this._flushBrokenSoon(); return false; }
        // 源文件变更 → 自动解禁（老语义：mtime/size 任一变化）
        if ((rec.mtimeMs && rec.mtimeMs !== Math.floor(st.mtimeMs)) || (rec.size != null && rec.size !== st.size)) {
            this._broken!.delete(st.sig); this._flushBrokenSoon(); return false;
        }
        return true;
    }
    private async _brokenMark(st: { sig: string; mtimeMs: number; size: number }, reason: string): Promise<void> {
        await this._loadBroken();
        const prev = this._broken!.get(st.sig);
        const count = ((prev && prev.count) || 0) + 1;
        let ttl = MediaService.BROKEN_BASE_TTL_MS * Math.pow(2, Math.max(0, count - 1));
        ttl = Math.min(ttl, MediaService.BROKEN_MAX_TTL_MS);
        this._broken!.set(st.sig, {
            ts: Date.now(), until: Date.now() + ttl, count,
            reason: String(reason || 'unknown').slice(0, 160),
            mtimeMs: Math.floor(st.mtimeMs), size: st.size,
        });
        if (this._broken!.size > 2000) {
            const ks = Array.from(this._broken!.keys()).slice(0, 1000);
            for (const kk of ks) { this._broken!.delete(kk); }
        }
        this._flushBrokenSoon();
    }
    private async _brokenClear(sig: string): Promise<void> {
        await this._loadBroken();
        if (this._broken!.has(sig)) { this._broken!.delete(sig); this._flushBrokenSoon(); }
    }
    private _flushBrokenSoon(): void {
        if (this._brokenTimer) return;
        this._brokenTimer = setTimeout(() => {
            this._brokenTimer = null;
            const entries: Record<string, any> = {};
            if (this._broken) { for (const [k, v] of this._broken) { entries[k] = v; } }
            this.cache.put('media:broken', { v: 1, entries }).catch(() => { /* ignore */ });
        }, 1500);
        try { if (this._brokenTimer && this._brokenTimer.unref) { this._brokenTimer.unref(); } } catch { /* ignore */ }
    }

    /** 缓存命中收尾：hit 统计 + atime + dur 解析（索引优先，免读盘） */
    private async _onHit(cacheKey: string, dst: string): Promise<{ dur: number }> {
        await this._loadIdx();
        this._idx!.stats.hit++;
        let dur: number | null = null;
        const e = this._idx!.entries[cacheKey];
        if (e && typeof e.dur === 'number') { dur = e.dur; }
        else { dur = MediaService._webpDurationFromFile(dst); }
        let size = 0;
        try { size = fs.statSync(dst).size; } catch { /* ignore */ }
        await this._touch(cacheKey, dst, size, dur);
        return { dur };
    }

    // -------------------------------------------------------------------------
    // binary resolution
    // -------------------------------------------------------------------------

    private _platformKey(): string {
        const p = process.platform;
        const a = process.arch === 'x64' ? 'x64' : 'arm64';
        if (p === 'win32') return 'win32-x64';
        if (p === 'darwin') return a === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
        return 'linux-x64';
    }

    private resolveBin(name: 'ffmpeg' | 'ffprobe'): string | null {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const envKey = name === 'ffmpeg' ? 'QQQ_FFMPEG' : 'QQQ_FFPROBE';
        const overrideEnv = process.env[envKey];
        if (overrideEnv && fs.existsSync(overrideEnv)) { return overrideEnv; }
        const qdir = process.env.QQQIDE_QDIR;
        const tries: string[] = [];
        if (qdir) { tries.push(path.join(qdir, 'components', name, name + ext)); }
        // Platform-specific subdirectory: engines/{name}/{platform}/{name}.exe
        // ffprobe split from ffmpeg (rank1 bg_download) — resides in engines/ffprobe/
        tries.push(path.join(this.appRoot, 'engines', name, this._platformKey(), name + ext));
        // Legacy: ffprobe used to live in engines/ffmpeg/ (pre-split)
        if (name === 'ffprobe') {
            tries.push(path.join(this.appRoot, 'engines', 'ffmpeg', this._platformKey(), name + ext));
            tries.push(path.join(this.appRoot, 'engines', 'ffmpeg', name + ext));
        }
        // Flat layout (legacy)
        tries.push(path.join(this.appRoot, 'engines', name + ext));
        for (const p of tries) {
            try { if (fs.existsSync(p)) { return p; } } catch { /* skip */ }
        }
        return this.qz.which(name);
    }

    private ensureResolved(): void {
        if (this._resolved) { return; }
        this._ffmpegPath = this.resolveBin('ffmpeg');
        this._ffprobePath = this.resolveBin('ffprobe');
        this._resolved = true;
    }

    ffmpegPath(): { ffmpeg: string | null; ffprobe: string | null } {
        this.ensureResolved();
        return { ffmpeg: this._ffmpegPath, ffprobe: this._ffprobePath };
    }

    // -------------------------------------------------------------------------
    // thumb
    // -------------------------------------------------------------------------

    async thumb(opts: ThumbOpts): Promise<MediaResult> {
        if (!opts || !opts.src) { return { ok: false, error: 'no_src' }; }
        if (!fs.existsSync(opts.src)) { return { ok: false, error: 'src_missing' }; }
        this.ensureResolved();
        if (!this._ffmpegPath) {
            return { ok: false, error: 'ffmpeg_not_found' };
        }

        const w = Math.max(16, Math.min(2048, opts.w || 256));
        const h = Math.max(16, Math.min(2048, opts.h || 256));
        const ts = Math.max(0, opts.ts != null ? opts.ts : 1.0);
        const format = opts.format || 'jpg';
        const quality = opts.quality != null ? opts.quality : 5;
        const fit = opts.fit || 'contain';

        // Cache key = stat 指纹 + params（零内容读取）
        const st = await this._srcStat(opts.src);
        if (!st) { return { ok: false, error: 'src_missing' }; }
        const paramKey = `thumb|${w}x${h}|t=${ts}|f=${format}|q=${quality}|${fit}`;
        const fullKey = `${st.sig}|${paramKey}`;
        const dst = this.cache.bucketPath('thumb' + this.shortHash(fullKey), '.' + format);

        if (fs.existsSync(dst)) {
            return { ok: true, path: dst, cached: true };
        }

        // Build vf filter
        const vf = fit === 'cover'
            ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
            : `scale=${w}:${h}:force_original_aspect_ratio=decrease`;

        const args: string[] = [
            '-y', '-loglevel', 'error',
            '-ss', String(ts),
            '-i', opts.src,
            '-vframes', '1',
            '-vf', vf,
        ];
        if (format === 'jpg') { args.push('-q:v', String(quality)); }
        else if (format === 'webp') { args.push('-quality', String(Math.max(1, Math.min(100, 90 - quality * 4)))); }
        args.push(dst);

        const r = await this.qz.spawn({
            cmd: this._ffmpegPath,
            args,
            timeout: 30_000,
            stallMs: 15_000,
            captureOutput: true,
        });

        if (r.exitCode !== 0 || !fs.existsSync(dst)) {
            return {
                ok: false, error: 'ffmpeg_failed', stderr: r.stderr.slice(-500),
                path: dst,
            };
        }
        return { ok: true, path: dst, cached: false };
    }

    // -------------------------------------------------------------------------
    // transcode
    // -------------------------------------------------------------------------

    async transcode(opts: TranscodeOpts): Promise<MediaResult> {
        if (!opts || !opts.src || !opts.format) { return { ok: false, error: 'no_src_or_format' }; }
        if (!fs.existsSync(opts.src)) { return { ok: false, error: 'src_missing' }; }
        this.ensureResolved();
        if (!this._ffmpegPath) {
            return { ok: false, error: 'ffmpeg_not_found' };
        }

        const st = await this._srcStat(opts.src);
        const paramKey = `tx|${opts.format}|${opts.vbr || ''}|${opts.abr || ''}|${(opts.extraArgs || []).join(',')}`;
        const fullKey = `${(st ? st.sig : 'nostat')}|${paramKey}`;
        const dst = opts.dst || this.cache.bucketPath('tx' + this.shortHash(fullKey), '.' + opts.format);

        if (!opts.dst && fs.existsSync(dst)) {
            return { ok: true, path: dst, cached: true };
        }

        const args: string[] = ['-y', '-loglevel', 'error', '-i', opts.src];
        if (opts.vbr) { args.push('-b:v', opts.vbr); }
        if (opts.abr) { args.push('-b:a', opts.abr); }
        if (opts.extraArgs && opts.extraArgs.length) { args.push(...opts.extraArgs); }
        args.push(dst);

        const r = await this.qz.spawn({
            cmd: this._ffmpegPath,
            args,
            timeout: 30 * 60_000,
            stallMs: 60_000,
            captureOutput: true,
        });

        if (r.exitCode !== 0 || !fs.existsSync(dst)) {
            return { ok: false, error: 'ffmpeg_failed', stderr: r.stderr.slice(-500), path: dst };
        }
        return { ok: true, path: dst, cached: false };
    }

    // -------------------------------------------------------------------------
    // probe
    // -------------------------------------------------------------------------

    async probe(src: string): Promise<MediaResult> {
        if (!src || !fs.existsSync(src)) { return { ok: false, error: 'src_missing' }; }
        this.ensureResolved();

        // 缓存键 = stat 指纹（零内容读取）
        const st = await this._srcStat(src);
        if (!st) { return { ok: false, error: 'src_missing' }; }
        const cacheKey = `probe2:${st.sig}`;
        const cached = await this.cache.get(cacheKey) as MediaResult | null;
        if (cached) { return { ...cached, cached: true }; }

        // in-flight 去重（老 scheduleProbe：同文件并发探测只跑一次）
        const ik = 'probe:' + st.sig;
        const existing = this._inflight.get(ik);
        if (existing) { return await existing as MediaResult; }
        const job = this._probeInner(src, cacheKey);
        this._inflight.set(ik, job);
        try { return await job; } finally { this._inflight.delete(ik); }
    }

    private async _probeInner(src: string, cacheKey: string): Promise<MediaResult> {
        if (this._ffprobePath) {
            const args = [
                '-v', 'error',
                '-show_entries', 'stream=width,height,codec_name,duration:format=duration',
                '-of', 'json',
                src,
            ];
            const r = await this.qz.spawn({
                cmd: this._ffprobePath, args, timeout: 20_000, stallMs: 10_000, captureOutput: true,
            });
            if (r.exitCode === 0 && r.stdout) {
                try {
                    const j = JSON.parse(r.stdout);
                    const stream = (j.streams || [])[0] || {};
                    const duration = Number(stream.duration || (j.format && j.format.duration) || 0);
                    const out: MediaResult = {
                        ok: true,
                        width: Number(stream.width) || undefined,
                        height: Number(stream.height) || undefined,
                        codec: stream.codec_name || undefined,
                        duration: isFinite(duration) ? duration : undefined,
                    };
                    await this.cache.put(cacheKey, out, { ttlMs: 30 * 24 * 3600_000 });
                    return out;
                } catch { /* fall through */ }
            }
        }

        // Fallback: parse `ffmpeg -i` stderr
        if (this._ffmpegPath) {
            const r = await this.qz.spawn({
                cmd: this._ffmpegPath, args: ['-i', src],
                timeout: 20_000, stallMs: 10_000, captureOutput: true,
            });
            const txt = r.stderr || '';
            const out: MediaResult = { ok: true };
            const m1 = txt.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
            if (m1) { out.duration = Number(m1[1]) * 3600 + Number(m1[2]) * 60 + Number(m1[3]); }
            const m2 = txt.match(/Video:\s*([^,]+),[^,]*,\s*(\d+)x(\d+)/);
            if (m2) {
                out.codec = m2[1].trim();
                out.width = Number(m2[2]); out.height = Number(m2[3]);
            }
            if (out.duration || out.width) {
                await this.cache.put(cacheKey, out, { ttlMs: 30 * 24 * 3600_000 });
                return out;
            }
        }
        return { ok: false, error: 'probe_failed' };
    }

    // =========================================================================
    // preview — 相框媒体预览（q3 q1.js buildUnifiedWebPArgs 逐字移植）
    //   extreme     仅首帧                                   q=47
    //   accelerated 静态→首帧 / 动画→前 2s @7fps（14 帧）    q=47
    //   optmum      静态→首帧 / 短媒体(<10s)→完整时长 / 长视频→首中尾 3 段×1.33s  q=71
    //   直读通道    浏览器原生 + 静态 +（ico<4MB 或 <300KB 且 ≤512px）→ 原文件直出
    // =========================================================================

    private static readonly IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico',
        '.tiff', '.tif', '.svg', '.ai', '.eps', '.cdr', '.psd']);
    private static readonly VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv',
        '.rmvb', '.mpeg', '.mpg', '.3gp', '.m4v', '.f4v', '.ts', '.mts', '.m2ts', '.vob']);
    private static readonly AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.wma']);
    private static readonly SIMPLE_DIRECT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.svg', '.ico']);
    private static readonly VIDEO_CODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2', 'mpeg1',
        'wmv', 'vc1', 'flv', 'theora', 'avs', 'rv40', 'rv30', 'rv20', 'rv10', 'msmpeg4', 'h263'];

    /** GIF 动图检测（老 q1.js _isGifAnimated 移植：NETSCAPE/ANIMEXTS 或 >1 GCE 块） */
    private _isGifAnimatedHead(src: string): boolean {
        try {
            const fd = fs.openSync(src, 'r');
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, 4096, 0);
            fs.closeSync(fd);
            if (n < 13) { return false; }
            const s = buf.slice(0, n);
            if (s.includes(Buffer.from('NETSCAPE')) || s.includes(Buffer.from('ANIMEXTS'))) { return true; }
            let gce = 0;
            for (let i = 0; i < n - 1; i++) {
                if (s[i] === 0x21 && s[i + 1] === 0xF9) { gce++; if (gce > 1) { return true; } }
            }
            return false;
        } catch { return false; }
    }

    /** 输出完整性校验（老语义：防截断/损坏 webp 缓存为"坏命中"） */
    private static _isValidWebp(p: string): boolean {
        try {
            const fd = fs.openSync(p, 'r');
            const b = Buffer.alloc(12);
            const n = fs.readSync(fd, b, 0, 12, 0);
            fs.closeSync(fd);
            if (n < 12) { return false; }
            return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
        } catch { return false; }
    }

    /** WebP 动画时长（老 q1.js getWebPDurationFromBuffer 移植：ANMF 帧时长求和） */
    private static _webpDurationFromFile(p: string): number {
        try {
            const buf = fs.readFileSync(p);
            if (buf.length < 12) { return 0; }
            if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') { return 0; }
            let pos = 12, total = 0, frames = 0;
            while (pos < buf.length - 8) {
                const id = buf.toString('ascii', pos, pos + 4);
                const size = buf.readUInt32LE(pos + 4);
                if (id === 'ANMF') {
                    frames++;
                    if (pos + 23 < buf.length) {
                        total += buf[pos + 20] | (buf[pos + 21] << 8) | (buf[pos + 22] << 16);
                    }
                }
                pos = pos + 8 + size + (size % 2);
            }
            return frames > 1 ? total / 1000 : 0;
        } catch { return 0; }
    }

    /** 媒体分类（老 _getMediaInfoInternal 判定链移植） */
    private async _mediaMeta(src: string): Promise<any | null> {
        const ext = path.extname(src).toLowerCase();
        if (!MediaService.IMAGE_EXTS.has(ext) && !MediaService.VIDEO_EXTS.has(ext) && !MediaService.AUDIO_EXTS.has(ext)) {
            return null;
        }
        if (process.platform === 'win32' && (ext === '.exe' || ext === '.lnk')) { return null; }
        let size = 0;
        try { size = (await fs.promises.stat(src)).size; } catch { return null; }
        const pr = await this.probe(src);
        let w = pr.width || 0, h = pr.height || 0, dur = pr.duration || 0;
        const codec = String(pr.codec || '').toLowerCase();
        let type = 'unknown', isStatic = false, isMjpegStatic = false, needsConversion = false;
        if (codec) {
            if (codec.includes('mjpeg') || codec === 'jpeg') {
                if (dur <= 0.1) { type = 'image'; isStatic = true; isMjpegStatic = true; }
                else { type = 'video'; }
            } else if (['png', 'bmp', 'tiff', 'webp', 'svg', 'pdf'].some((x) => codec.includes(x))) {
                type = 'image';
                isStatic = dur <= 0.1;
            } else if (codec.includes('gif')) {
                const animated = dur > 0.1 || this._isGifAnimatedHead(src);
                if (!animated) { type = 'image'; isStatic = true; }
                else { type = 'animated_image'; if (dur <= 0.1) { dur = 3.0; } }
            } else if (MediaService.VIDEO_CODECS.some((x) => codec.includes(x))) {
                type = 'video';
            }
        }
        if (type === 'unknown' && (w > 0 || dur > 0)) {
            if (MediaService.VIDEO_EXTS.has(ext)) { type = 'video'; }
            else if (MediaService.IMAGE_EXTS.has(ext)) {
                type = 'image'; isStatic = true;
                if (['.ai', '.eps', '.psd', '.cdr', '.tiff', '.tif'].includes(ext)) { needsConversion = true; }
            } else if (MediaService.AUDIO_EXTS.has(ext)) { type = 'audio'; }
        }
        return { ext, size, width: w, height: h, duration: dur, codec, type, isStatic, isMjpegStatic, needsConversion };
    }

    async preview(opts: PreviewOpts): Promise<PreviewResult> {
        if (!opts || !opts.src) { return { ok: false, error: 'no_src' }; }
        if (!fs.existsSync(opts.src)) { return { ok: false, error: 'src_missing' }; }
        this.ensureResolved();

        const meta = await this._mediaMeta(opts.src);
        if (!meta) { return { ok: false, error: 'unsupported_type' }; }
        if (meta.type === 'audio' || meta.type === 'unknown') { return { ok: false, error: 'not_visual' }; }

        const mode: PreviewMode = (opts.mode === 'extreme' || opts.mode === 'accelerated') ? opts.mode : 'optmum';
        const quality = mode === 'optmum' ? 71 : 47;

        // ── 直读通道（老 shouldBypassCache 语义）──
        if (meta.isMjpegStatic) {
            return { ok: true, kind: 'direct', path: opts.src, width: meta.width || undefined, height: meta.height || undefined, duration: 0, sourceDuration: meta.duration };
        }
        const canDirect = MediaService.SIMPLE_DIRECT_EXTS.has(meta.ext) || (meta.ext === '.webp' && meta.isStatic);
        if (meta.isStatic && canDirect && !meta.needsConversion &&
            ((meta.ext === '.ico' && meta.size < 4 * 1048576) ||
             (meta.size < 307200 && meta.width > 0 && meta.height > 0 && meta.width <= 512 && meta.height <= 512))) {
            return { ok: true, kind: 'direct', path: opts.src, width: meta.width || undefined, height: meta.height || undefined, duration: 0, sourceDuration: meta.duration };
        }

        if (!this._ffmpegPath) { return { ok: false, error: 'ffmpeg_not_found' }; }

        // ── 目标尺寸（老 CACHE_BASE 512x288 口径）──
        let tw = 512, th = 288;
        if (meta.width && meta.height && !meta.needsConversion) {
            if (meta.width > 512 || meta.height > 288) {
                const s = Math.min(512 / meta.width, 288 / meta.height);
                tw = Math.max(1, Math.round(meta.width * s));
                th = Math.max(1, Math.round(meta.height * s));
            } else { tw = meta.width; th = meta.height; }
        }

        // ── 缓存键 = stat 指纹（零内容读取）+ 模式/尺寸/质量 ──
        const st = await this._srcStat(opts.src);
        if (!st) { return { ok: false, error: 'src_missing' }; }
        const fullKey = `${st.sig}|preview|${mode}|${tw}x${th}|q${quality}`;
        const cacheKey = 'pv' + this.shortHash(fullKey);
        const dst = this.cache.bucketPath(cacheKey, '.webp');
        if (fs.existsSync(dst)) {
            const h = await this._onHit(cacheKey, dst);
            return { ok: true, kind: 'webp', path: dst, width: tw, height: th, duration: h.dur, animated: h.dur > 0, cached: true, sourceDuration: meta.duration };
        }
        // broken 熔断：已知坏文件 TTL 内直接失败（防每轮重扫白等十几秒）
        if (await this._brokenHit(st)) {
            return { ok: false, error: 'known_broken' };
        }
        // in-flight 去重：同键并发复用同一生成（老 taskKey=gen:{id}:{q}）
        const ik = 'preview:' + cacheKey;
        const pending = this._inflight.get(ik);
        if (pending) { return await pending as PreviewResult; }
        const job = this._genPreview({ src: opts.src }, meta, mode, quality, tw, th, dst, cacheKey, st);
        this._inflight.set(ik, job);
        try { return await job; } finally { this._inflight.delete(ik); }
    }

    /** 预览生成主体（成功写索引 + broken 清；失败 broken 熔断） */
    private async _genPreview(opts: { src: string }, meta: any, mode: PreviewMode, quality: number,
        tw: number, th: number, dst: string, cacheKey: string,
        st: { sig: string; mtimeMs: number; size: number }): Promise<PreviewResult> {
        // ── 参数构建（老 buildUnifiedWebPArgs）──
        const scaleFilter = `scale=${tw}:${th}:force_original_aspect_ratio=decrease:flags=bilinear,format=yuva420p`;
        const args: string[] = ['-hide_banner', '-loglevel', 'error'];
        const isSourceStatic = meta.duration <= 0.1;
        const isSourceGifLike = !isSourceStatic && meta.duration < 10;
        let vf = `[0:v]${scaleFilter}[out_v]`;

        if (mode === 'extreme') {
            args.push('-ss', '0', '-i', opts.src);
            vf = `[0:v]${scaleFilter}[out_v]`;
            args.push('-frames:v', '1');
        } else if (mode === 'accelerated') {
            if (isSourceStatic) {
                args.push('-ss', '0', '-i', opts.src);
                vf = `[0:v]${scaleFilter}[out_v]`;
                args.push('-frames:v', '1');
            } else {
                args.push('-ss', '0', '-t', '2', '-i', opts.src);
                vf = `[0:v]fps=7,setpts=N/7/TB,${scaleFilter}[out_v]`;
                args.push('-frames:v', '14');
            }
        } else {
            if (isSourceStatic) {
                args.push('-ss', '0', '-i', opts.src);
                vf = `[0:v]${scaleFilter}[out_v]`;
                args.push('-frames:v', '1');
            } else if (isSourceGifLike) {
                args.push('-ss', '0', '-i', opts.src);
                vf = `[0:v]${scaleFilter}[out_v]`;
            } else {
                const seg = 1.33;
                const s1 = 1;
                const s2 = Math.floor(meta.duration / 2);
                const s3 = Math.max(s2 + seg + 0.5, meta.duration - seg - 1);
                args.push('-ss', String(s1), '-t', String(seg), '-i', opts.src);
                args.push('-ss', String(s2), '-t', String(seg), '-i', opts.src);
                args.push('-ss', String(s3), '-t', String(seg), '-i', opts.src);
                vf = `[0:v]fps=15,${scaleFilter}[v0];` +
                    `[1:v]fps=15,${scaleFilter}[v1];` +
                    `[2:v]fps=15,${scaleFilter}[v2];` +
                    `[v0][v1][v2]concat=n=3:v=1:a=0[out_v]`;
            }
        }
        args.push('-filter_complex', vf, '-map', '[out_v]');
        args.push('-c:v', 'libwebp', '-lossless', '0', '-compression_level', '0', '-q:v', String(quality),
            '-loop', '0', '-an', '-vsync', '0', '-f', 'webp');

        const tmpPath = dst + '.tmp';
        try { if (fs.existsSync(tmpPath)) { fs.unlinkSync(tmpPath); } } catch { /* ignore */ }
        const r = await this.qz.spawn({
            cmd: this._ffmpegPath,
            args: [...args, '-y', tmpPath],
            timeout: 30_000,
            stallMs: 20_000,
            captureOutput: true,
        });
        if (r.exitCode !== 0 || !fs.existsSync(tmpPath)) {
            try { if (fs.existsSync(tmpPath)) { fs.unlinkSync(tmpPath); } } catch { /* ignore */ }
            // 熔断记录（指数退避；源文件变更自动解禁）
            await this._brokenMark(st, (r.stderr || 'ffmpeg_failed').slice(-160));
            return { ok: false, error: 'ffmpeg_failed', stderr: (r.stderr || '').slice(-500) };
        }
        try { fs.renameSync(tmpPath, dst); } catch (e: any) {
            try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
            return { ok: false, error: 'rename_failed: ' + (e && e.message) };
        }
        // 输出校验（老语义：防截断/损坏 webp 缓存为"坏命中"）
        if (!MediaService._isValidWebp(dst)) {
            try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
            await this._brokenMark(st, 'invalid_webp_output');
            return { ok: false, error: 'invalid_output' };
        }
        const dur2 = MediaService._webpDurationFromFile(dst);
        let size2 = 0;
        try { size2 = fs.statSync(dst).size; } catch { /* ignore */ }
        await this._ensureSpace(size2);
        await this._touch(cacheKey, dst, size2, dur2);
        await this._brokenClear(st.sig);
        return { ok: true, kind: 'webp', path: dst, width: tw, height: th, duration: dur2, animated: dur2 > 0, cached: false, sourceDuration: meta.duration };
    }

    // =========================================================================
    // textPreview — 文本胶片（老 q1.js generateTextPreview 逐字移植）
    //   514x290 画布 + drawtext，底色/字色随 textSlideColorScheme，字号随 textSlideFontSize
    // =========================================================================

    private _fontPath(): string | null {
        const cands = process.platform === 'win32'
            ? ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\msyhbd.ttc', 'C:\\Windows\\Fonts\\simsun.ttc', 'C:\\Windows\\Fonts\\simhei.ttf']
            : process.platform === 'darwin'
                ? ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Light.ttc']
                : ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'];
        for (const f of cands) { try { if (fs.existsSync(f)) { return f; } } catch { /* ignore */ } }
        return null;
    }

    /** 4KB 头部解码（老 decodeTextBuffer：严格 UTF-8 → GBK → latin1） */
    private _decodeTextHead(buf: Buffer): string {
        try {
            const s = buf.toString('utf8');
            if (!s.includes('\uFFFD')) { return s; }
        } catch { /* ignore */ }
        try { return new TextDecoder('gbk').decode(buf); } catch { /* ignore */ }
        try { return new TextDecoder('gb2312').decode(buf); } catch { /* ignore */ }
        return buf.toString('latin1');
    }

    private _visualWidth(s: string): number {
        let w = 0;
        for (const ch of s) { w += ch.charCodeAt(0) > 0x2E7F ? 1.0 : 0.55; }
        return w;
    }

    async textPreview(opts: TextPreviewOpts): Promise<PreviewResult> {
        if (!opts || !opts.src) { return { ok: false, error: 'no_src' }; }
        if (!fs.existsSync(opts.src)) { return { ok: false, error: 'src_missing' }; }
        this.ensureResolved();
        if (!this._ffmpegPath) { return { ok: false, error: 'ffmpeg_not_found' }; }

        const scheme = opts.scheme === 'dark' ? 'dark' : 'light';
        let fontSize = Math.round(Number(opts.fontSize) || 14);
        fontSize = Math.max(1, Math.min(218, fontSize));

        const st = await this._srcStat(opts.src);
        if (!st) { return { ok: false, error: 'src_missing' }; }
        const fullKey = `${st.sig}|text|${scheme}|${fontSize}|q71`;
        const cacheKey = 'pt' + this.shortHash(fullKey);
        const dst = this.cache.bucketPath(cacheKey, '.webp');
        if (fs.existsSync(dst)) {
            await this._onHit(cacheKey, dst);
            return { ok: true, kind: 'text', path: dst, width: 514, height: 290, duration: 0, cached: true };
        }
        // in-flight 去重（同文本并发只跑一次）
        const ik = 'text:' + cacheKey;
        const pending = this._inflight.get(ik);
        if (pending) { return await pending as PreviewResult; }
        const job = this._genTextPreview(opts.src, scheme, fontSize, dst, cacheKey, st);
        this._inflight.set(ik, job);
        try { return await job; } finally { this._inflight.delete(ik); }
    }

    private async _genTextPreview(src: string, scheme: string, fontSize: number, dst: string, cacheKey: string,
        st: { sig: string; mtimeMs: number; size: number }): Promise<PreviewResult> {
        // ── 读头部 4KB + 解码 ──
        let text = '';
        try {
            const fd = fs.openSync(src, 'r');
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, 4096, 0);
            fs.closeSync(fd);
            text = this._decodeTextHead(n < 4096 ? buf.slice(0, n) : buf);
        } catch { return { ok: false, error: 'read_failed' }; }
        text = text.replace(/^\uFEFF/, '').replace(/^[\s\u00A0\u3000\u200B\r\n]+/, '');

        // ── 布局（老口径：514x290、行高 1.3x、padding 4）──
        const targetW = 514, targetH = 290;
        const lineHeight = Math.floor(fontSize * 1.3);
        const padding = 4;
        const usableW = targetW - padding * 2;
        const usableH = targetH - padding * 2;
        const maxLines = Math.max(1, Math.floor(usableH / lineHeight));
        const maxVisualWidth = usableW / fontSize;

        const lines = text.split('\n');
        const wrapped: string[] = [];
        for (const line of lines) {
            if (wrapped.length >= maxLines) { break; }
            if (line.length === 0) { wrapped.push(' '); continue; }
            if (this._visualWidth(line) <= maxVisualWidth) { wrapped.push(line); continue; }
            let cur = '';
            let curW = 0;
            for (const ch of line) {
                const cw = ch.charCodeAt(0) > 0x2E7F ? 1.0 : 0.55;
                if (curW + cw > maxVisualWidth) {
                    if (cur) { wrapped.push(cur); }
                    if (wrapped.length >= maxLines) { break; }
                    cur = ch; curW = cw;
                } else { cur += ch; curW += cw; }
            }
            if (cur && wrapped.length < maxLines) { wrapped.push(cur); }
        }
        let finalText = wrapped.join('\n');
        if (!finalText.trim()) { finalText = '[Empty File]'; }
        finalText = finalText.split('%').join('\uFF05');
        finalText = finalText.split('\\').join('\\\\');
        finalText = finalText.split("'").join("\\'");

        const rand = Math.random().toString(36).slice(2);
        const tmpTxt = path.join(os.tmpdir(), `qqq_txt_${rand}.txt`);
        try { fs.writeFileSync(tmpTxt, finalText, 'utf8'); } catch { return { ok: false, error: 'tmp_write_failed' }; }

        const bgColor = scheme === 'dark' ? '#1B1411' : '#fef6e3';
        const textColor = scheme === 'dark' ? '#E5E5E5' : '#333333';
        const fontPath = this._fontPath();

        const txtEsc = tmpTxt.replace(/\\/g, '/').replace(/:/g, '\\:');
        const parts: string[] = [`drawtext=textfile='${txtEsc}'`];
        parts.push(`fontsize=${fontSize}`);
        parts.push(`fontcolor=${textColor}`);
        parts.push(`x=${padding}`);
        parts.push(`y=${padding}`);
        parts.push(`line_spacing=${lineHeight - fontSize}`);
        if (fontPath) {
            const fontEsc = fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');
            parts.push(`fontfile='${fontEsc}'`);
        }

        const tmpPath = dst + '.tmp';
        try { if (fs.existsSync(tmpPath)) { fs.unlinkSync(tmpPath); } } catch { /* ignore */ }
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `color=c=${bgColor}:s=${targetW}x${targetH}:d=1`,
            '-vf', parts.join(':'),
            '-frames:v', '1',
            '-c:v', 'libwebp', '-lossless', '0', '-compression_level', '0', '-q:v', '71',
            '-f', 'webp',
            '-y', tmpPath,
        ];
        const r = await this.qz.spawn({
            cmd: this._ffmpegPath,
            args,
            timeout: 15_000,
            stallMs: 12_000,
            captureOutput: true,
        });
        try { if (fs.existsSync(tmpTxt)) { fs.unlinkSync(tmpTxt); } } catch { /* ignore */ }
        if (r.exitCode !== 0 || !fs.existsSync(tmpPath)) {
            try { if (fs.existsSync(tmpPath)) { fs.unlinkSync(tmpPath); } } catch { /* ignore */ }
            return { ok: false, error: 'ffmpeg_failed', stderr: (r.stderr || '').slice(-500) };
        }
        try { fs.renameSync(tmpPath, dst); } catch (e: any) {
            try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
            return { ok: false, error: 'rename_failed: ' + (e && e.message) };
        }
        let size2 = 0;
        try { size2 = fs.statSync(dst).size; } catch { /* ignore */ }
        await this._ensureSpace(size2);
        await this._touch(cacheKey, dst, size2, 0);
        return { ok: true, kind: 'text', path: dst, width: targetW, height: targetH, duration: 0, cached: false };
    }

    // -------------------------------------------------------------------------
    private shortHash(s: string): string {
        // Stable 16-hex from string (sha256 first 16 hex)
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
    }
}
