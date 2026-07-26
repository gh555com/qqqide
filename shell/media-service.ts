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

    // -------------------------------------------------------------------------
    // binary resolution
    // -------------------------------------------------------------------------

    private resolveBin(name: 'ffmpeg' | 'ffprobe'): string | null {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const envKey = name === 'ffmpeg' ? 'QQQ_FFMPEG' : 'QQQ_FFPROBE';
        const overrideEnv = process.env[envKey];
        if (overrideEnv && fs.existsSync(overrideEnv)) { return overrideEnv; }
        const qdir = process.env.QQQIDE_QDIR;
        const tries: string[] = [];
        if (qdir) { tries.push(path.join(qdir, 'components', 'ffmpeg', name + ext)); }
        tries.push(path.join(this.appRoot, 'engines', 'ffmpeg', name + ext));
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

        // Cache key = content-sig + params
        const sig = (await this.hash.hashFile(opts.src, 'fast')).xxh64 || 'no-hash';
        const paramKey = `thumb|${w}x${h}|t=${ts}|f=${format}|q=${quality}|${fit}`;
        const fullKey = `${sig}|${paramKey}`;
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

        const sig = (await this.hash.hashFile(opts.src, 'fast')).xxh64 || 'no-hash';
        const paramKey = `tx|${opts.format}|${opts.vbr || ''}|${opts.abr || ''}|${(opts.extraArgs || []).join(',')}`;
        const fullKey = `${sig}|${paramKey}`;
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

        // Cache result keyed by sig
        const sig = (await this.hash.hashFile(src, 'fast')).xxh64 || 'no-hash';
        const cacheKey = `probe:${sig}`;
        const cached = await this.cache.get(cacheKey) as MediaResult | null;
        if (cached) { return { ...cached, cached: true }; }

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

    // -------------------------------------------------------------------------
    private shortHash(s: string): string {
        // Stable 16-hex from string (sha256 first 16 hex)
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
    }
}
