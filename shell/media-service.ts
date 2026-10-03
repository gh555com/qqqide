// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// media-service.ts
// ffmpeg-backed thumbnail / transcode / probe, driven by the qz subsystem
// and cached by content signature so the same input + params never re-runs.
//
// ffmpeg resolution order:
//   1. process.env.QQQ_FFMPEG  (explicit override)
//   2. getComponentBin(appRoot, 'ffmpeg')  — manifest 中央机器，双布局自动解析
//      (dev {root}/engines ｜ 绿色包 {root}/resources/app/engines + 平台子目录)
//   3. $QQQIDE_QDIR/components/ffmpeg/ffmpeg(.exe)
//   4. 手拼双布局兜底（dev + resources/app 两套 engines 根）
//   5. system PATH (qz.which('ffmpeg'))
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
import { vigBump } from './vig';
import { getComponentBin } from './component-checker';
import { hwEncCandidatesFor, hwProbeArgs, HwEncCand } from './transcode-hw';

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

// ── 悬浮层播放/预览转码兜底（2026-09-21）────────────────────────────────────
export interface PlayableOpts {
    src: string;                        // absolute source path
    kind: 'video' | 'audio' | 'image';  // 请求方语义（决定产物形态）
    reqId?: string;                     // 进度/取消关联 id（渲染层生成）
}
export interface PlayableResult {
    ok: boolean;
    path?: string;                      // 浏览器可直接播放/显示的产物路径
    ext?: string;                       // mp4 | webm | m4a | mp3 | png
    duration?: number;
    cached?: boolean;
    cancelled?: boolean;
    error?: string;
    stderr?: string;
}

// ── 渐进转码（MSE 边转边播；2026-10-02：「闪电」核心）───────────────────────
export interface PlayableStreamOpts {
    src: string;
    kind?: 'video' | 'audio';           // image 不走流（经典路径）
    reqId?: string;                     // 取消/进度关联（与经典共一取消入口）
    token?: string;                     // 事件流归属令牌（渲染层生成；缺省 = reqId）
}
export interface PlayableStreamStart {
    ok: boolean;
    mode?: 'stream' | 'cache';
    codec?: string;                     // MSE codecs 串（如 avc1.64001F,mp4a.40.2）
    duration?: number;
    isVideo?: boolean;
    path?: string;                      // mode:'cache' 时直接可用产物
    ext?: string;
    cached?: boolean;
    cancelled?: boolean;
    error?: string;
    sent?: boolean;                     // 失败时是否已下送过任何分片（false = 帧流从未开始——硬编失败可安全软件重跑）
}

/** fMP4 顶层 box 枚举（[start,end) 内连续 box → {t:类型, ps/pe:负载区间}）。 */
function _topBoxes(buf: Buffer, start: number, end: number): Array<{ t: string; ps: number; pe: number }> {
    const out: Array<{ t: string; ps: number; pe: number }> = [];
    let o = start;
    while (o + 8 <= end) {
        let size = buf.readUInt32BE(o);
        let hs = 8;
        if (size === 1) { if (o + 16 > end) { break; } size = Number(buf.readBigUInt64BE(o + 8)); hs = 16; }
        if (size < hs || o + size > end) { break; }
        out.push({ t: buf.toString('ascii', o + 4, o + 8), ps: o + hs, pe: o + size });
        o += size;
    }
    return out;
}
function _pickBox(buf: Buffer, start: number, end: number, type: string): { t: string; ps: number; pe: number } | null {
    for (const b of _topBoxes(buf, start, end)) { if (b.t === type) { return b; } }
    return null;
}
/** fMP4 初始段 → MSE 编解码串（moov→trak→mdia→stsd 首条目；avc1→avcC 三字节 / mp4a→.40.2）。 */
function _parseFmp4Codec(init: Buffer): { video?: string; audio?: string } {
    const out: { video?: string; audio?: string } = {};
    const moov = _pickBox(init, 0, init.length, 'moov');
    if (!moov) { return out; }
    for (const trak of _topBoxes(init, moov.ps, moov.pe)) {
        if (trak.t !== 'trak') { continue; }
        const mdia = _pickBox(init, trak.ps, trak.pe, 'mdia'); if (!mdia) { continue; }
        const hdlr = _pickBox(init, mdia.ps, mdia.pe, 'hdlr');
        const minf = _pickBox(init, mdia.ps, mdia.pe, 'minf');
        if (!hdlr || !minf || hdlr.ps + 12 > hdlr.pe) { continue; }
        const htype = init.toString('ascii', hdlr.ps + 8, hdlr.ps + 12);
        const stbl = _pickBox(init, minf.ps, minf.pe, 'stbl'); if (!stbl) { continue; }
        const stsd = _pickBox(init, stbl.ps, stbl.pe, 'stsd'); if (!stsd) { continue; }
        const entries = _topBoxes(init, stsd.ps + 8, stsd.pe);
        if (!entries.length) { continue; }
        const e = entries[0];
        if (htype === 'vide' && e.t === 'avc1') {
            // ★ 探针实锤（2026-10-02）：VisualSampleEntry 负载有 78 字节定长头（reserved/dataref/宽高/压缩名…）——
            //   子 box（avcC）从 e.ps+78 才开始；从 e.ps 直扫会把定长头当 box 头误读 → avcC 恒 null（视频 codec 丢失实锤）。
            const _vstart = Math.min(e.pe, e.ps + 78);
            const avcC = _pickBox(init, _vstart, e.pe, 'avcC');
            if (avcC && avcC.ps + 4 <= avcC.pe) {
                const hx = (n: number): string => ('0' + n.toString(16).toUpperCase()).slice(-2);
                out.video = 'avc1.' + hx(init[avcC.ps + 1]) + hx(init[avcC.ps + 2]) + hx(init[avcC.ps + 3]);
            }
        } else if (htype === 'soun' && e.t === 'mp4a') {
            out.audio = 'mp4a.40.2';
        }
    }
    return out;
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

    // ── 状态栏 wq 卡片：缓存占用统计（2026-09-27）────────────────────────────
    //   媒体缓存 = 命中索引（预览/文本胶片 entries）size 累加，上限 CACHE_MAX_SIZE 40MB；
    //   转码缓存 = play 目录扫描（排除 .part/.prog 中间物），上限 PLAY_CACHE_MAX 2GB。
    //   纯只读轻量（卡片打开时调用，零生成/零淘汰副作用）。
    async cacheStats(): Promise<{
        ok: boolean;
        mediaBytes: number; mediaCount: number; mediaMax: number; mediaTarget: number;
        hit: number; miss: number; broken: number;
        playBytes: number; playCount: number; playMax: number;
        error?: string;
    }> {
        try {
            await this._loadIdx();
            const idx = this._idx!;
            let mediaBytes = 0, mediaCount = 0;
            for (const e of Object.values(idx.entries)) {
                mediaBytes += Number(e && e.size) || 0;
                mediaCount++;
            }
            await this._loadBroken();
            let playBytes = 0, playCount = 0;
            try {
                const d = this._playDir();
                for (const name of fs.readdirSync(d)) {
                    if (/\.part\./.test(name) || /\.prog$/.test(name)) { continue; }
                    try {
                        const st = fs.statSync(path.join(d, name));
                        if (st.isFile()) { playBytes += st.size; playCount++; }
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
            return {
                ok: true,
                mediaBytes, mediaCount, mediaMax: MediaService.CACHE_MAX_SIZE, mediaTarget: MediaService.CACHE_TARGET_SIZE,
                hit: idx.stats.hit || 0, miss: idx.stats.miss || 0,
                broken: this._broken ? this._broken.size : 0,
                playBytes, playCount, playMax: MediaService.PLAY_CACHE_MAX,
            };
        } catch (e: any) {
            return {
                ok: false,
                mediaBytes: 0, mediaCount: 0, mediaMax: MediaService.CACHE_MAX_SIZE, mediaTarget: MediaService.CACHE_TARGET_SIZE,
                hit: 0, miss: 0, broken: 0,
                playBytes: 0, playCount: 0, playMax: MediaService.PLAY_CACHE_MAX,
                error: e?.message || 'cachestats_exception',
            };
        }
    }

    /** 缓存命中收尾：hit 统计 + atime + dur 解析（索引优先，免读盘） */
    private async _onHit(cacheKey: string, dst: string): Promise<{ dur: number }> {
        await this._loadIdx();
        this._idx!.stats.hit++;
        try { vigBump('cache', { hit: 1 }); } catch { /* ignore */ }
        let dur: number | null = null;
        const e = this._idx!.entries[cacheKey];
        if (e && typeof e.dur === 'number') { dur = e.dur; }
        else { dur = MediaService._webpDurationFromFile(dst); }
        let size = 0;
        try { size = fs.statSync(dst).size; } catch { /* ignore */ }
        const durN = dur ?? 0;
        await this._touch(cacheKey, dst, size, durN);
        return { dur: durN };
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
        // ★ 中央机器（component-checker，manifest 驱动）——自动解析双布局：
        //   dev {root}/engines ｜ 绿色包 {root}/resources/app/engines（含平台子目录）。
        //   旧实现手拼 {appRoot}/engines/... → 绿色包恒 null → 媒体帧/文本胶片全降级图标帧（2026-09-27 事故）。
        try {
            const bin = getComponentBin(this.appRoot, name);
            if (bin) { return bin; }
        } catch { /* manifest 不可读 → 走手拼兜底 */ }
        const qdir = process.env.QQQIDE_QDIR;
        const tries: string[] = [];
        if (qdir) { tries.push(path.join(qdir, 'components', name, name + ext)); }
        // 双布局手拼兜底（镜像 qz-spawn resolveGhrunBin）: dev 与绿色包 resources/app 两套 engines 根
        const roots = [this.appRoot, path.join(this.appRoot, 'resources', 'app')];
        for (const root of roots) {
            // Platform-specific subdirectory: engines/{name}/{platform}/{name}.exe
            tries.push(path.join(root, 'engines', name, this._platformKey(), name + ext));
            // Legacy: ffprobe used to live in engines/ffmpeg/ (pre-split)
            if (name === 'ffprobe') {
                tries.push(path.join(root, 'engines', 'ffmpeg', this._platformKey(), name + ext));
                tries.push(path.join(root, 'engines', 'ffmpeg', name + ext));
            }
            // Flat layout (legacy)
            tries.push(path.join(root, 'engines', name + ext));
        }
        for (const p of tries) {
            try { if (fs.existsSync(p)) { return p; } } catch { /* skip */ }
        }
        return this.qz.which(name);
    }

    private ensureResolved(): void {
        // 正结果一次锁定；负结果下次调用重试——ffprobe 是 rank1 后台组件，
        //   首启未装时若不重试将整会话恒 null（bg_download 完成后无法自愈）。
        if (this._resolved && this._ffmpegPath && this._ffprobePath) { return; }
        if (!this._ffmpegPath) { this._ffmpegPath = this.resolveBin('ffmpeg'); }
        if (!this._ffprobePath) { this._ffprobePath = this.resolveBin('ffprobe'); }
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
            try { vigBump('cache', { hit: 1 }); } catch { /* ignore */ }
            return { ok: true, path: dst, cached: true };
        }
        try { vigBump('cache', { miss: 1 }); } catch { /* ignore */ }

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
            try { vigBump('cache', { hit: 1 }); } catch { /* ignore */ }
            return { ok: true, path: dst, cached: true };
        }
        if (!opts.dst) { try { vigBump('cache', { miss: 1 }); } catch { /* ignore */ } }

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

    // =========================================================================
    // playable — 悬浮层播放/预览转码兜底（2026-09-21）
    //   Chromium 原生解不了的格式（avi/wmv/flv/rmvb/prores-mov/psd/tiff…）→ ffmpeg 转浏览器可播产物：
    //   ① 视频智能快路径：编码已支持（h264/hevc/av1/vp8/vp9）→ -c copy 重封装（秒级零损失）
    //   ② 编码不支持 → libx264 重编码（veryfast/crf23/yuv420p + aac）
    //   ③ 音频：aac copy；mp3 一律重编码 aac——2026-10-02 实证：Chromium 严格解码（脏 mp3 bitstream 一包解码失败
    //      即整体拒播；ffmpeg CLI 容错跳过 vs Chromium 零容忍），老 AVI（Nandub/DivX 时代）mp3 常态带病，copy 必炸
    //   ④ 图片（psd/tiff）：抽单帧 png
    //   独立缓存区 {cache}/play（2GB 上限 LRU；产物名 = stat 指纹 + 方案版本 PLAY_PLAN_VER）+ -progress 文件轮询进度 + 可取消 + broken 熔断
    // =========================================================================

    private _playInflight = new Map<string, Promise<PlayableResult>>();
    private _playLive = new Map<string, { kill: () => void }>();
    private _playCancelled = new Set<string>();
    // ★ 渐进转码会话表（2026-10-02）：reqId → { pending（ack 前在途字节）, paused, ctl（stdout 背压）, kill }
    private _streamLive = new Map<string, { pending: number; paused: boolean; ctl: { pause: () => void; resume: () => void } | null; kill: (() => void) | null }>();
    private static readonly PLAY_CACHE_MAX = 2 * 1073741824;
    private static readonly PLAY_CACHE_TARGET = 1536 * 1048576;
    /** 产物方案版本：转码规则变更必须 bump——旧规则产物自动失效（禁复用旧规则产物）
     *  ★ 硬编优选（2026-10-02）刻意不 bump：hw/sw 产物皆合法可播（qp30 与 crf23 画质/体积双对标，详 transcode-hw），
     *    存量缓存继续命中；bump 会把全网已转好的文件重转一遍 = 纯粹的用户等待（正确性零收益）。 */
    private static readonly PLAY_PLAN_VER = '_p2';
    // ★ 硬编码器探测机（2026-10-02；进程内一次——宿主启动 4s 后后台预热 + 首个转码请求兜底 await）
    private _hwEnc: HwEncCand | null = null;
    private _hwProbed = false;
    private _hwProbeJob: Promise<void> | null = null;
    private _hwFails = 0;

    private _playDir(): string {
        const d = path.join(this.cache.root, 'play');
        try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
        return d;
    }

    /** 容量纪律：2GB 上限 → mtime LRU 淘汰到 1.5GB；陈旧 .part/.prog 中间物顺手清 */
    private _playSweep(): void {
        try {
            const d = this._playDir();
            const now = Date.now();
            const files: Array<{ p: string; m: number; s: number }> = [];
            let total = 0;
            for (const name of fs.readdirSync(d)) {
                const p = path.join(d, name);
                try {
                    const st = fs.statSync(p);
                    if (!st.isFile()) { continue; }
                    if (/\.part\./.test(name) || /\.prog$/.test(name)) {
                        if (now - st.mtimeMs > 10 * 60_000) { fs.rmSync(p, { force: true }); }
                        continue;
                    }
                    files.push({ p, m: st.mtimeMs, s: st.size });
                    total += st.size;
                } catch { /* ignore */ }
            }
            if (total <= MediaService.PLAY_CACHE_MAX) { return; }
            files.sort((a, b) => a.m - b.m);
            for (const f of files) {
                if (total <= MediaService.PLAY_CACHE_TARGET) { break; }
                try { fs.rmSync(f.p, { force: true }); total -= f.s; } catch { /* 使用中跳过 */ }
            }
        } catch { /* ignore */ }
    }

    /** ffmpeg -progress 文件解析：末条 out_time_us（us）→ 退 out_time_ms（历史实为 us）/ out_time=HH:MM:SS */
    private static _parseProgUs(txt: string): number | null {
        let last: number | null = null; let r: RegExpExecArray | null;
        const g1 = /out_time_us=(\d+)/g;
        while ((r = g1.exec(txt))) { last = Number(r[1]); }
        if (last != null) { return last; }
        const g2 = /out_time_ms=(\d+)/g;
        while ((r = g2.exec(txt))) { last = Number(r[1]); }
        if (last != null) { return last; }
        const g3 = /out_time=(\d+):(\d+):(\d+\.?\d*)/g; let lastS: number | null = null;
        while ((r = g3.exec(txt))) { lastS = Number(r[1]) * 3600 + Number(r[2]) * 60 + Number(r[3]); }
        return lastS != null ? Math.round(lastS * 1e6) : null;
    }

    /** 产物头校验（防截断/坏产物缓存为「坏命中」——与 webp RIFF 校验同哲学） */
    private static _isValidPlayableOut(p: string, ext: string): boolean {
        try {
            const st = fs.statSync(p);
            if (st.size <= 32) { return false; }
            const fd = fs.openSync(p, 'r');
            const b = Buffer.alloc(16);
            const n = fs.readSync(fd, b, 0, 16, 0);
            fs.closeSync(fd);
            if (n < 8) { return false; }
            const a4 = (o: number): string => b.toString('ascii', o, o + 4);
            if (ext === 'mp4' || ext === 'm4a') { return a4(4) === 'ftyp'; }
            if (ext === 'webm') { return b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3; }
            // 魔数必逐字节（a4() 固定读 4 字符对 "PNG" 这类 3 字符前缀恒假——误删合法产物实锤坑）
            if (ext === 'png') { return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47; }
            return true;
        } catch { return false; }
    }

    /** 双流探测（视频+音频编码 / 时长 / 宽高）——ffprobe JSON 优先，ffmpeg -i 解析兜底 */
    private async _probeStreams(src: string): Promise<{ vcodec: string; acodec: string; duration: number; w: number; h: number } | null> {
        this.ensureResolved();
        if (this._ffprobePath) {
            const r = await this.qz.spawn({
                cmd: this._ffprobePath,
                args: ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', src],
                timeout: 20_000, stallMs: 10_000, captureOutput: true,
            });
            if (r.exitCode === 0 && r.stdout) {
                try {
                    const j = JSON.parse(r.stdout);
                    const streams = (j && j.streams) || [];
                    const v = streams.find((s: any) => s && s.codec_type === 'video') || {};
                    const a = streams.find((s: any) => s && s.codec_type === 'audio') || {};
                    const dur = Number((j.format && j.format.duration) || v.duration || a.duration || 0);
                    return {
                        vcodec: String(v.codec_name || '').toLowerCase(),
                        acodec: String(a.codec_name || '').toLowerCase(),
                        duration: isFinite(dur) ? dur : 0,
                        w: Number(v.width) || 0,
                        h: Number(v.height) || 0,
                    };
                } catch { /* fall through */ }
            }
        }
        if (this._ffmpegPath) {
            const r = await this.qz.spawn({
                cmd: this._ffmpegPath, args: ['-hide_banner', '-i', src],
                timeout: 20_000, stallMs: 10_000, captureOutput: true,
            });
            const txt = r.stderr || '';
            const mv = txt.match(/Stream #\d+:\d+.*?: Video: ([A-Za-z0-9_]+)/);
            const ma = txt.match(/Stream #\d+:\d+.*?: Audio: ([A-Za-z0-9_]+)/);
            if (mv || ma) {
                const md = txt.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
                const mr = txt.match(/Stream #\d+:\d+.*?: Video: .*?\b(\d{2,5})x(\d{2,5})\b/);
                return {
                    vcodec: mv ? mv[1].toLowerCase() : '',
                    acodec: ma ? ma[1].toLowerCase() : '',
                    duration: md ? (Number(md[1]) * 3600 + Number(md[2]) * 60 + Number(md[3])) : 0,
                    w: mr ? Number(mr[1]) : 0,
                    h: mr ? Number(mr[2]) : 0,
                };
            }
        }
        return null;
    }

    /** 硬编码器探测（进程内一次）：① -encoders 预筛（廉价）② 逐候选真机试编（640x360 合成源——presence ≠ 可用）。
     *  失败即锁（同进程零重探）；QQQIDE_TX_HW=0 逃生开关。任何失败 = 纯软编（libx264），零回归。 */
    async ensureHwEncoder(): Promise<void> {
        if (this._hwProbed) { return; }
        if (!this._hwProbeJob) {
            this._hwProbeJob = this._probeHwEncoder().finally(() => { this._hwProbed = true; this._hwProbeJob = null; });
        }
        return this._hwProbeJob;
    }
    private async _probeHwEncoder(): Promise<void> {
        try {
            if (String(process.env.QQQIDE_TX_HW || '') === '0') { return; }
            this.ensureResolved();
            if (!this._ffmpegPath) { return; }
            const cands = hwEncCandidatesFor(process.platform);
            if (!cands.length) { return; }
            let encTxt = '';
            try {
                const r = await this.qz.spawn({ cmd: this._ffmpegPath, args: ['-hide_banner', '-encoders'], timeout: 15_000, stallMs: 10_000, captureOutput: true });
                encTxt = (r.stdout || '') + (r.stderr || '');
            } catch { return; }
            for (const cand of cands) {
                if (encTxt.indexOf(cand.name) < 0) { continue; }   // 构建未编入 → 不必试编
                try {
                    const r = await this.qz.spawn({ cmd: this._ffmpegPath, args: hwProbeArgs(cand), timeout: 20_000, stallMs: 15_000, captureOutput: true });
                    if (r.exitCode === 0) {
                        this._hwEnc = cand;
                        try { console.log('[media] hw encoder: ' + cand.name); } catch { /* ignore */ }
                        return;
                    }
                } catch { /* 本候选失败 → 下一候选 */ }
            }
        } catch { /* 探测失败 = 纯软编 */ }
    }
    /** 硬编实跑失败降级：探针过 ≠ 全文件适用（极端尺寸/色深/会话耗尽）——连续 2 次真失败 → 本进程降回软编。 */
    private _noteHwFailure(): void {
        this._hwFails++;
        if (this._hwFails >= 2) {
            this._hwEnc = null;
            try { console.warn('[media] hw encoder demoted after ' + this._hwFails + ' real failures -> libx264'); } catch { /* ignore */ }
        }
    }

    /** 转码方案决策（快路径 = 同编码 copy 重封装；不可 copy 才重编码——硬编可用时优先，qp30 对标 x264 crf23）
     *  ★ 2026-10-02：mp3 音轨一律重编码 aac（Chromium 严格解码——脏 mp3 流一包解码失败即整体拒播；
     *    老 AVI〔Nandub/DivX 时代〕mp3 常态带病：copy 进 mp4/mkv 均被 PIPELINE_ERROR_DECODE 拒绝，实锤）。
     *  ★ 奇偶守卫：重编码目标 yuv420p 要求偶数边长——源为奇数宽高时加整像素安全缩放（源不为奇数则零开销）。
     *  ★ enc = 「本方案是否重编码」显式字段（硬编时代 args 不再含 libx264，禁回字符串嗅探）；hw = 命中的硬编码器名。 */
    private _planPlayable(kind: 'video' | 'audio' | 'image', meta: { vcodec: string; acodec: string; w?: number; h?: number },
        forceSw?: boolean): { ext: string; args: string[]; enc: boolean; hw?: string } {
        if (kind === 'image') {
            return { ext: 'png', args: ['-frames:v', '1', '-c:v', 'png', '-update', '1'], enc: false };
        }
        const a = meta.acodec, v = meta.vcodec;
        if (kind === 'audio' || !v) {
            if (a === 'aac') { return { ext: 'm4a', args: ['-vn', '-c:a', 'copy'], enc: false }; }
            return { ext: 'm4a', args: ['-vn', '-c:a', 'aac', '-b:a', '192k'], enc: true };
        }
        const aArgs = a ? (a === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']) : ['-an'];
        const mapArgs = ['-map', '0:v:0'].concat(a ? ['-map', '0:a:0'] : []);
        if (v === 'h264' || v === 'hevc' || v === 'av1') {
            return { ext: 'mp4', args: mapArgs.concat(['-c:v', 'copy'], aArgs), enc: false };
        }
        if ((v === 'vp8' || v === 'vp9') && (!a || a === 'opus' || a === 'vorbis')) {
            return { ext: 'webm', args: mapArgs.concat(['-c:v', 'copy'], a ? ['-c:a', 'copy'] : ['-an']), enc: false };
        }
        const hw = (!forceSw && this._hwEnc) ? this._hwEnc : null;
        const vArgs = hw ? hw.args.slice() : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
        if ((meta.w && meta.w % 2) || (meta.h && meta.h % 2)) {
            vArgs.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
        }
        return {
            ext: 'mp4',
            args: mapArgs.concat(vArgs, aArgs),
            enc: true,
            hw: hw ? hw.name : undefined,
        };
    }

    /** 转码兜底入口：产物就绪返回路径；进度经 onProgress(pct)；reqId 供取消关联 */
    async playable(opts: PlayableOpts, onProgress?: (pct: number) => void): Promise<PlayableResult> {
        if (!opts || !opts.src) { return { ok: false, error: 'no_src' }; }
        if (!fs.existsSync(opts.src)) { return { ok: false, error: 'src_missing' }; }
        this.ensureResolved();
        if (!this._ffmpegPath) { return { ok: false, error: 'ffmpeg_not_found' }; }

        const kind: 'video' | 'audio' | 'image' = (opts.kind === 'audio' || opts.kind === 'image') ? opts.kind : 'video';
        const st = await this._srcStat(opts.src);
        if (!st) { return { ok: false, error: 'src_missing' }; }
        if (await this._brokenHit(st)) { return { ok: false, error: 'known_broken' }; }

        // ★ 缓存快路径（2026-09-21，零风险纯收益）：产物名 = stat 指纹（路径|mtime|size）+ 方案版本（PLAY_PLAN_VER）
        //   ——同 sig 必同源同方案；★ 方案版本（2026-10-02）：转码规则变更 bump 版本 → 旧规则产物自动失效（禁复用）
        //   命中直返，跳过 ffprobe 进程（~100-300ms/次）；产物落盘均经校验，坏产物从不落盘。
        //   下方 probe→plan→dst 检查保留为兜底（方案漂移等边界）。
        const _fastExts: string[] = kind === 'image' ? ['png'] : ['mp4', 'webm', 'm4a'];
        for (const _fe of _fastExts) {
            const _fp = path.join(this._playDir(), st.sig + MediaService.PLAY_PLAN_VER + '.' + _fe);
            if (fs.existsSync(_fp)) {
                try { vigBump('cache', { hit: 1 }); } catch { /* ignore */ }
                try { const now = new Date(); fs.utimesSync(_fp, now, now); } catch { /* ignore */ }
                return { ok: true, path: _fp, ext: _fe, duration: 0, cached: true };
            }
        }

        const meta = await this._probeStreams(opts.src);
        if (!meta || (!meta.vcodec && !meta.acodec)) { return { ok: false, error: 'probe_failed' }; }

        await this.ensureHwEncoder();   // ★ 硬编探测（进程内一次；上方缓存快路径已命中则不付探测成本）
        const plan = this._planPlayable(kind, meta);
        const dst = path.join(this._playDir(), st.sig + MediaService.PLAY_PLAN_VER + '.' + plan.ext);
        if (fs.existsSync(dst)) {
            try { vigBump('cache', { hit: 1 }); } catch { /* ignore */ }
            try { const now = new Date(); fs.utimesSync(dst, now, now); } catch { /* ignore */ }
            return { ok: true, path: dst, ext: plan.ext, duration: meta.duration, cached: true };
        }
        const ik = 'play:' + dst;
        const pending = this._playInflight.get(ik);
        if (pending) { return await pending; }
        try { vigBump('cache', { miss: 1 }); } catch { /* ignore */ }
        const reqId = opts.reqId || '';
        const job = (async (): Promise<PlayableResult> => {
            let r = await this._genPlayable(opts.src, plan, dst, st, meta.duration, reqId, onProgress, !plan.hw);
            if (!r.ok && !r.cancelled && plan.hw && (r.error === 'ffmpeg_failed' || r.error === 'invalid_output')) {
                // ★ 硬编实跑失败（探针过但本文件不吃——极端尺寸/色深/会话耗尽/坏产物）：软件重跑一次
                //   （硬编那次不记熔断——markBroken 已按 !plan.hw 关闭；成败由软件这次裁决）
                this._noteHwFailure();
                const swPlan = this._planPlayable(kind, meta, true);
                r = await this._genPlayable(opts.src, swPlan, dst, st, meta.duration, reqId, onProgress, true);
            }
            return r;
        })();
        this._playInflight.set(ik, job);
        try { return await job; } finally { this._playInflight.delete(ik); }
    }

    private async _genPlayable(src: string, plan: { ext: string; args: string[] }, dst: string,
        st: { sig: string; mtimeMs: number; size: number }, duration: number,
        reqId: string, onProgress?: (pct: number) => void, markBroken: boolean = true): Promise<PlayableResult> {
        const tmp = dst.replace(new RegExp('\\.' + plan.ext + '$'), '.part.' + plan.ext);
        const prog = dst + '.prog';
        try { if (fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); } } catch { /* ignore */ }
        try { if (fs.existsSync(prog)) { fs.rmSync(prog, { force: true }); } } catch { /* ignore */ }

        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', prog, '-i', src]
            .concat(plan.args, [tmp]);

        let lastProgAt = Date.now();
        let lastPct = -1;
        let stalled = false;
        const timer = setInterval(() => {
            if (stalled) { return; }
            try {
                if (fs.existsSync(prog)) {
                    const pst = fs.statSync(prog);
                    if (pst.mtimeMs > lastProgAt) { lastProgAt = pst.mtimeMs; }
                    const txt = fs.readFileSync(prog, 'utf8');
                    const us = MediaService._parseProgUs(txt);
                    if (us != null && duration > 0.2 && onProgress) {
                        const pct = Math.max(0, Math.min(99, Math.round((us / 1e6) / duration * 100)));
                        if (pct !== lastPct) { lastPct = pct; try { onProgress(pct); } catch { /* ignore */ } }
                    }
                }
            } catch { /* ignore */ }
            // 停滞熔断：progress 文件 3 分钟零推进（正常 ~0.5s 一刷）→ 判真 hang 树杀
            if (Date.now() - lastProgAt > 180_000) {
                stalled = true;
                try { const h = this._playLive.get(reqId); if (h) { h.kill(); } } catch { /* ignore */ }
            }
        }, 600);
        try { if ((timer as any).unref) { (timer as any).unref(); } } catch { /* ignore */ }

        try {
            const r = await this.qz.spawn({
                cmd: this._ffmpegPath!,
                args,
                timeout: 2 * 3600_000,
                stallMs: 0,   // 输出静默是常态（-loglevel error）——停滞由 progress 文件轮询看门狗负责
                captureOutput: true,
                onProc: reqId ? (h: { pid?: number; kill: () => void }) => { this._playLive.set(reqId, h); } : undefined,
            });
            if (reqId) { this._playLive.delete(reqId); }
            if (reqId && this._playCancelled.has(reqId)) {
                this._playCancelled.delete(reqId);
                try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
                return { ok: false, cancelled: true, error: 'cancelled' };
            }
            if (stalled || r.exitCode !== 0 || !fs.existsSync(tmp)) {
                try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
                if (!stalled && markBroken) { await this._brokenMark(st, 'playable_ffmpeg_failed'); }
                return { ok: false, error: stalled ? 'stalled' : 'ffmpeg_failed', stderr: (r.stderr || '').slice(-400) };
            }
            try { if (fs.existsSync(dst)) { fs.rmSync(dst, { force: true }); } } catch { /* ignore */ }
            try { fs.renameSync(tmp, dst); } catch (e: any) {
                try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
                return { ok: false, error: 'rename_failed: ' + (e && e.message) };
            }
            if (!MediaService._isValidPlayableOut(dst, plan.ext)) {
                try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
                if (markBroken) { await this._brokenMark(st, 'playable_invalid_output'); }
                return { ok: false, error: 'invalid_output' };
            }
            await this._brokenClear(st.sig);
            try { onProgress && onProgress(100); } catch { /* ignore */ }
            setImmediate(() => { try { this._playSweep(); } catch { /* ignore */ } });
            return { ok: true, path: dst, ext: plan.ext, duration, cached: false };
        } finally {
            clearInterval(timer);
            try { if (fs.existsSync(prog)) { fs.rmSync(prog, { force: true }); } } catch { /* ignore */ }
            if (reqId) { this._playLive.delete(reqId); this._playCancelled.delete(reqId); }
        }
    }

    /** 取消：树杀在飞 ffmpeg + 标记（结果返回 cancelled，不写 broken）；经典与渐进流共用。 */
    cancelPlayable(reqId: string): boolean {
        if (!reqId) { return false; }
        try { this._playCancelled.add(reqId); } catch { /* ignore */ }
        if (this._playCancelled.size > 500) { this._playCancelled.clear(); this._playCancelled.add(reqId); }
        const h = this._playLive.get(reqId);
        if (h) { try { h.kill(); } catch { /* ignore */ } return true; }
        return false;
    }

    // =========================================================================
    // playableStream — 渐进转码（MSE 边转边播；2026-10-02「闪电」核心）
    //   重编码类文件不再等全量转码完成：ffmpeg 产出 fMP4（frag_keyframe+empty_moov）经 stdout 实时回传，
    //   渲染层按 seq 喂 MediaSource —— 首帧 ≈ 秒出（旧路径 = 全量转码 6s 后才开播）。
    //   字节同步镜像落盘 → 完成后校验 rename 为同一缓存产物（dst 命名与经典路径完全同源——
    //   渐进产物二次打开 = 原生直放；copy 快路径/图片/缓存命中在内部直接走经典并当 cache 返回）。
    //   流控：渲染层周期性 ack；在途 >32MB 暂停 ffmpeg stdout，回落到 <12MB 恢复；
    //   停顿看门狗 = -progress 文件 3min 零推进树杀（与经典同口径）。
    //   终局经 send({token, kind:'done'|'fail'}) 事件；本函数返回值 = 启动结果（moov 解析后即回）。
    //   ★ 渐进路径不写 broken 熔断（解析/流失败一律由回退的经典路径裁决，防误禁）。
    // =========================================================================
    async playableStream(opts: PlayableStreamOpts, send: (evt: any) => void, onProgress?: (pct: number) => void): Promise<PlayableStreamStart> {
        if (!opts || !opts.src) { return { ok: false, error: 'no_src' }; }
        if (!fs.existsSync(opts.src)) { return { ok: false, error: 'src_missing' }; }
        this.ensureResolved();
        if (!this._ffmpegPath) { return { ok: false, error: 'ffmpeg_not_found' }; }
        const kind: 'video' | 'audio' = (opts.kind === 'audio') ? 'audio' : 'video';
        const reqId = String(opts.reqId || '');
        const token = String(opts.token || reqId || '');
        if (!token) { return { ok: false, error: 'no_token' }; }
        const st = await this._srcStat(opts.src);
        if (!st) { return { ok: false, error: 'src_missing' }; }
        if (await this._brokenHit(st)) { return { ok: false, error: 'known_broken' }; }
        // 缓存快路径（与经典同命名——命中即直放；零 ffprobe 进程）
        const _fastExts: string[] = kind === 'audio' ? ['m4a', 'mp4'] : ['mp4'];
        for (const _fe of _fastExts) {
            const _fp = path.join(this._playDir(), st.sig + MediaService.PLAY_PLAN_VER + '.' + _fe);
            if (fs.existsSync(_fp)) {
                try { vigBump('cache', { hit: 1 }); } catch { /* ignore */ }
                try { const now = new Date(); fs.utimesSync(_fp, now, now); } catch { /* ignore */ }
                return { ok: true, mode: 'cache', path: _fp, ext: _fe, cached: true };
            }
        }
        const meta = await this._probeStreams(opts.src);
        if (!meta || (!meta.vcodec && !meta.acodec)) { return { ok: false, error: 'probe_failed' }; }
        await this.ensureHwEncoder();   // ★ 硬编探测（进程内一次；上方缓存快路径已命中则不付探测成本）
        const plan = this._planPlayable(kind, meta);
        const dst = path.join(this._playDir(), st.sig + MediaService.PLAY_PLAN_VER + '.' + plan.ext);
        if (fs.existsSync(dst)) {
            try { vigBump('cache', { hit: 1 }); } catch { /* ignore */ }
            try { const now = new Date(); fs.utimesSync(dst, now, now); } catch { /* ignore */ }
            return { ok: true, mode: 'cache', path: dst, ext: plan.ext, duration: meta.duration, cached: true };
        }
        // 非重编码方案（copy 重封装）/图片 → 经典全量（秒级）当缓存命中返回
        const isEncode = plan.enc;   // ★ 源 = 方案字段（硬编时代 args 不再含 libx264——禁回字符串嗅探；audio 重编码亦由此覆盖）
        if (!isEncode) {
            try { vigBump('cache', { miss: 1 }); } catch { /* ignore */ }
            const r = await this.playable({ src: opts.src, kind, reqId: reqId || undefined }, onProgress);
            if (r.ok && r.path) { return { ok: true, mode: 'cache', path: r.path, ext: r.ext, duration: r.duration || meta.duration, cached: !!r.cached }; }
            return { ok: false, cancelled: r.cancelled, error: r.error || 'classic_failed' };
        }
        try { vigBump('cache', { miss: 1 }); } catch { /* ignore */ }
        let res = await this._openStreamJob(opts.src, plan, dst, st, meta, reqId, token, send, onProgress);
        if (!res.ok && !res.cancelled && plan.hw && !res.sent && (res.error === 'ffmpeg_failed' || res.error === 'invalid_output')) {
            // ★ 硬编起步失败且一帧未发（sent=false）→ 软件重跑一次——渲染层从未收到分片，无感切换（详 media-service §硬编）
            this._noteHwFailure();
            const swPlan = this._planPlayable(kind, meta, true);
            res = await this._openStreamJob(opts.src, swPlan, dst, st, meta, reqId, token, send, onProgress);
        }
        return res;
    }

    /** ack 背压通道：渲染层每消费一批字节回执；解除暂停阈值 <12MB。 */
    streamAck(reqId: string, bytes: number): boolean {
        const s = reqId ? this._streamLive.get(reqId) : null;
        if (!s) { return false; }
        s.pending = Math.max(0, s.pending - Math.max(0, bytes | 0));
        if (s.paused && s.pending < 12 * 1048576 && s.ctl) {
            s.paused = false;
            try { s.ctl.resume(); } catch { /* ignore */ }
        }
        return true;
    }

    private _openStreamJob(src: string, plan: { ext: string; args: string[] }, dst: string,
        st: { sig: string; mtimeMs: number; size: number },
        meta: { vcodec: string; acodec: string; duration: number; w: number; h: number },
        reqId: string, token: string, send: (evt: any) => void, onProgress?: (pct: number) => void): Promise<PlayableStreamStart> {
        return new Promise<PlayableStreamStart>((resolveStart) => {
            let startResolved = false;
            let startOk = false;
            const resolveOnce = (r: PlayableStreamStart): void => { if (!startResolved) { startResolved = true; resolveStart(r); } };
            (async () => {
                const ext = plan.ext;
                const tmp = dst.replace(new RegExp('\\.' + ext + '$'), '.part.stream' + (reqId ? '-' + reqId : '') + '.' + ext);
                const prog = dst + '.prog';
                try { if (fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); } } catch { /* ignore */ }
                try { if (fs.existsSync(prog)) { fs.rmSync(prog, { force: true }); } } catch { /* ignore */ }
                let ws: fs.WriteStream | null = null;
                try { ws = fs.createWriteStream(tmp, { flags: 'w' }); } catch { ws = null; }
                // 写流收尾器（★ 顺序铁律）：成功路径必须先 flush 全部字节再校验/rename（否则 rename 拿到半截文件）；
                // 失败路径必须先 destroy 释放句柄再 rm tmp（Windows 对打开中的文件 rm 会失败 → 残件泄露）。幂等。
                let wsClosed = false;
                const closeWs = async (flush: boolean): Promise<void> => {
                    if (wsClosed) { return; }
                    wsClosed = true;
                    const w = ws; ws = null;
                    if (!w) { return; }
                    try {
                        if (flush) {
                            w.end();
                            await new Promise<void>((res) => { try { w.once('close', () => res()); } catch { res(); } setTimeout(res, 4000); });
                        } else {
                            w.destroy();
                            await new Promise<void>((res) => { try { w.once('close', () => res()); } catch { res(); } setTimeout(res, 500); });
                        }
                    } catch { /* ignore */ }
                };
                const live: { pending: number; paused: boolean; ctl: { pause: () => void; resume: () => void } | null; kill: (() => void) | null } =
                    { pending: 0, paused: false, ctl: null, kill: null };
                if (reqId) { this._streamLive.set(reqId, live); }

                // ── 字节流处理：镜像落盘 + 顶层 box 分帧（init=ftyp+moov；seg=moof+mdat 对）──
                let acc: Buffer = Buffer.alloc(0);
                let initDone = false;
                let initBuf: Buffer = Buffer.alloc(0);
                let segCur: Buffer[] | null = null;
                let segBytes = 0;
                let seq = 0;
                const sendUnit = (kit: 'init' | 'seg', buf: Buffer): void => {
                    if (!buf || !buf.length) { return; }
                    seq++;
                    try { send({ token, seq, kind: kit, b64: buf.toString('base64') }); } catch { /* ignore */ }
                    live.pending += buf.length;
                    if (live.pending > 32 * 1048576 && !live.paused && live.ctl) {
                        live.paused = true;
                        try { live.ctl.pause(); } catch { /* ignore */ }
                    }
                };
                const flushSegment = (): void => {
                    if (!segCur || !segCur.length) { segCur = null; segBytes = 0; return; }
                    const buf = segCur.length === 1 ? segCur[0] : Buffer.concat(segCur, segBytes);
                    segCur = null; segBytes = 0;
                    sendUnit('seg', buf);
                };
                const feed = (d: Buffer): void => {
                    try { if (ws) { ws.write(d); } } catch { /* ignore */ }
                    acc = acc.length ? Buffer.concat([acc, d]) : d;
                    while (acc.length >= 8) {
                        let size = acc.readUInt32BE(0);
                        let hs = 8;
                        if (size === 1) { if (acc.length < 16) { break; } size = Number(acc.readBigUInt64BE(8)); hs = 16; }
                        if (size < hs) { acc = Buffer.alloc(0); break; }          // 结构损坏——停帧（终局由 exit 码裁决）
                        if (acc.length < size) { break; }
                        const type = acc.toString('ascii', 4, 8);
                        const box = Buffer.from(acc.subarray(0, size));
                        acc = acc.subarray(size);
                        if (!initDone) {
                            if (type === 'ftyp' || type === 'moov' || type === 'free' || type === 'skip') {
                                initBuf = initBuf.length ? Buffer.concat([initBuf, box]) : box;
                            }
                            if (type === 'moov') {
                                initDone = true;
                                const parsed = _parseFmp4Codec(initBuf);
                                const codecStr = parsed.video && parsed.audio ? (parsed.video + ',' + parsed.audio) : (parsed.video || parsed.audio || '');
                                if (!codecStr) {
                                    resolveOnce({ ok: false, error: 'codec_parse_failed' });
                                    try { if (live.kill) { live.kill(); } } catch { /* ignore */ }
                                    break;
                                }
                                startOk = true;
                                resolveOnce({ ok: true, mode: 'stream', codec: codecStr, duration: meta.duration, isVideo: !!meta.vcodec });
                                sendUnit('init', initBuf);
                            }
                            continue;
                        }
                        if (type === 'moof') { flushSegment(); segCur = [box]; segBytes = box.length; }
                        else if (type === 'mdat') { if (!segCur) { segCur = []; segBytes = 0; } segCur.push(box); segBytes += box.length; flushSegment(); }
                        else if (segCur) { segCur.push(box); segBytes += box.length; }
                    }
                };

                // 进度轮询 + 停顿看门狗（与经典同口径：progress 文件 3min 零推进 → 树杀）
                let lastProgAt = Date.now();
                let lastPct = -1;
                let stalled = false;
                const timer = setInterval(() => {
                    if (stalled) { return; }
                    try {
                        if (fs.existsSync(prog)) {
                            const pst = fs.statSync(prog);
                            if (pst.mtimeMs > lastProgAt) { lastProgAt = pst.mtimeMs; }
                            const txt = fs.readFileSync(prog, 'utf8');
                            const us = MediaService._parseProgUs(txt);
                            if (us != null && meta.duration > 0.2 && onProgress) {
                                const pct = Math.max(0, Math.min(99, Math.round((us / 1e6) / meta.duration * 100)));
                                if (pct !== lastPct) { lastPct = pct; try { onProgress(pct); } catch { /* ignore */ } }
                            }
                        }
                    } catch { /* ignore */ }
                    if (Date.now() - lastProgAt > 180_000) {
                        stalled = true;
                        try { if (live.kill) { live.kill(); } } catch { /* ignore */ }
                    }
                }, 600);
                try { if ((timer as any).unref) { (timer as any).unref(); } } catch { /* ignore */ }

                try {
                    const isVideo = !!meta.vcodec;
                    const extra = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'];
                    const gop = isVideo ? ['-g', '48', '-keyint_min', '48', '-sc_threshold', '0'] : [];
                    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', prog, '-i', src]
                        .concat(plan.args, gop, extra, ['-f', 'mp4', 'pipe:1']);
                    const r = await this.qz.spawn({
                        cmd: this._ffmpegPath!,
                        args,
                        timeout: 2 * 3600_000,
                        stallMs: 0,
                        captureOutput: true,
                        onStdoutChunk: (d: Buffer, ctl: { pause: () => void; resume: () => void }) => { live.ctl = ctl; feed(d); },
                        onProc: (h: { pid?: number; kill: () => void }) => { live.kill = h.kill; if (reqId) { this._playLive.set(reqId, h); } },
                    });
                    if (reqId) { this._playLive.delete(reqId); }
                    const cancelled = reqId ? (this._playCancelled.has(reqId) ? (this._playCancelled.delete(reqId), true) : false) : false;
                    if (cancelled) {
                        await closeWs(false);
                        try { if (fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); } } catch { /* ignore */ }
                        if (startResolved && startOk) { try { send({ token, kind: 'fail', cancelled: true }); } catch { /* ignore */ } }
                        resolveOnce({ ok: false, cancelled: true, error: 'cancelled', sent: !!(startResolved && startOk) });
                        return;
                    }
                    if (stalled || r.exitCode !== 0 || !fs.existsSync(tmp)) {
                        await closeWs(false);
                        try { if (fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); } } catch { /* ignore */ }
                        if (startResolved && startOk) { try { send({ token, kind: 'fail', error: stalled ? 'stalled' : 'ffmpeg_failed' }); } catch { /* ignore */ } }
                        resolveOnce({ ok: false, error: stalled ? 'stalled' : 'ffmpeg_failed', sent: !!(startResolved && startOk) });
                        return;
                    }
                    await closeWs(true);   // ★ 全量字节落盘后才校验/rename（顺序反了 = rename 拿到半截文件）
                    if (!MediaService._isValidPlayableOut(tmp, ext)) {
                        try { if (fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); } } catch { /* ignore */ }
                        if (startResolved && startOk) { try { send({ token, kind: 'fail', error: 'invalid_output' }); } catch { /* ignore */ } }
                        resolveOnce({ ok: false, error: 'invalid_output', sent: !!(startResolved && startOk) });
                        return;
                    }
                    try { if (fs.existsSync(dst)) { fs.rmSync(dst, { force: true }); } } catch { /* ignore */ }
                    try { fs.renameSync(tmp, dst); } catch {
                        try { if (fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); } } catch { /* ignore */ }
                        if (startResolved && startOk) { try { send({ token, kind: 'fail', error: 'rename_failed' }); } catch { /* ignore */ } }
                        resolveOnce({ ok: false, error: 'rename_failed' });
                        return;
                    }
                    await this._brokenClear(st.sig);
                    try { onProgress && onProgress(100); } catch { /* ignore */ }
                    setImmediate(() => { try { this._playSweep(); } catch { /* ignore */ } });
                    if (startResolved && startOk) { try { send({ token, kind: 'done' }); } catch { /* ignore */ } }
                    resolveOnce({ ok: false, error: 'already-finished' });   // 理论不可达（保底：永不悬挂）
                } catch (e: any) {
                    await closeWs(false);
                    try { if (fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); } } catch { /* ignore */ }
                    if (startResolved && startOk) { try { send({ token, kind: 'fail', error: 'stream_error' }); } catch { /* ignore */ } }
                    resolveOnce({ ok: false, error: 'stream_error: ' + ((e && e.message) || e) });
                } finally {
                    clearInterval(timer);
                    if (reqId) { this._playLive.delete(reqId); this._streamLive.delete(reqId); }
                    await closeWs(false);   // 幂等兑底（已收尾则零动作）
                    try { if (fs.existsSync(prog)) { fs.rmSync(prog, { force: true }); } } catch { /* ignore */ }
                }
            })().catch((e: any) => {
                resolveOnce({ ok: false, error: 'stream_job_error: ' + ((e && e.message) || e) });
            });
        });
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
        try { vigBump('cache', { miss: 1 }); } catch { /* ignore */ }
        const job = this._genPreview({ src: opts.src }, meta, mode, quality, tw, th, dst, cacheKey, st);
        this._inflight.set(ik, job);
        try { return await job; } finally { this._inflight.delete(ik); }
    }

    /** 预览生成主体（成功写索引 + broken 清；失败 broken 熔断） */
    private async _genPreview(opts: { src: string }, meta: any, mode: PreviewMode, quality: number,
        tw: number, th: number, dst: string, cacheKey: string,
        st: { sig: string; mtimeMs: number; size: number }): Promise<PreviewResult> {
            const ff = this._ffmpegPath;
            if (!ff) { return { ok: false, error: 'ffmpeg_not_found' }; }
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
            cmd: ff,
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
        try { vigBump('cache', { miss: 1 }); } catch { /* ignore */ }
        const job = this._genTextPreview(opts.src, scheme, fontSize, dst, cacheKey, st);
        this._inflight.set(ik, job);
        try { return await job; } finally { this._inflight.delete(ik); }
    }

    private async _genTextPreview(src: string, scheme: string, fontSize: number, dst: string, cacheKey: string,
        st: { sig: string; mtimeMs: number; size: number }): Promise<PreviewResult> {
            const ff = this._ffmpegPath;
            if (!ff) { return { ok: false, error: 'ffmpeg_not_found' }; }
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
            cmd: ff,
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
