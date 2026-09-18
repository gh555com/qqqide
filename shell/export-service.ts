// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// export-service.ts — 文档导出引擎（老 q3 q3.js executeExportDocCommand /
//   executeExportZipCommand 100% 语义移植，宿主从 VS Code 换成 qqqide 主进程）
//
// 职责链：
//   ① 渲染层解析锚点 → elements（text/media/path 有序列表）→ IPC 送至本服务
//   ② media 元素：ffmpeg 抽帧转 PNG（原分辨率 / 相框分辨率——qqqPrefs 两项配置）
//   ③ path 元素：文件 → 正文保留暗号 + 附件索引（SHA256 全量计算）；目录 → 仅保留暗号
//   ④ 生成 RTF(.doc) 或 DOCX（export-gen）→ 保存（默认文档旁；同名已存在 → 保存对话框）
//   ⑤ ZIP：当前文档 + 全部引用文件/目录（相对结构保留、目录递归、level 9 压缩）
//
// 进度：win.webContents.send('qqqide:export:progress', {jobId, phase, cur, total, ...})
// 取消：cancel(jobId) —— 杀活跃 ffmpeg + 中断循环 + 删半成品
// ============================================================================

import { BrowserWindow, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import { MediaService } from './media-service';
import { ZipWriter, sanitizeZipName } from './zip-writer';
import {
    ExportElement, ExportTexts, AttachmentEntry,
    generateRtfDocument, buildDocxParts, writeDocx, formatBytes,
} from './export-gen';

// ── 渲染层 → 壳层 的元素协议（有序）──
export type IncomingElement =
    | { t: 'text'; s: string }
    | { t: 'media'; p: string; mark: string }
    | { t: 'path'; p: string; mark: string };

export interface ExportTextsWire extends ExportTexts {
    mediaConversionFailedTmpl: string;   // "{0}" 占位
    filterLabelRtf: string;
    filterLabelDocx: string;
    filterLabelZip: string;
}

export interface ExportDocPayload {
    jobId: string;
    docPath: string;
    elements: IncomingElement[];
    format: 'rtf' | 'docx';
    includeCipher: boolean;
    useFrameResolution: boolean;
    texts: ExportTextsWire;
}

export interface ExportZipPayload {
    jobId: string;
    docPath: string;
    elements: IncomingElement[];
    texts: ExportTextsWire;
}

export interface ExportResult {
    ok: boolean;
    canceled?: boolean;
    path?: string;
    size?: number;
    attachments?: number;
    refs?: number;
    hasAnchors?: boolean;
    error?: string;
}

interface JobState {
    canceled: boolean;
    children: Set<cp.ChildProcess>;
}

const MEDIA_IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp|ico|tiff?|svg|avif)$/i;
const MEDIA_VIDEO_RE = /\.(mp4|mkv|webm|avi|mov|wmv|flv|rmvb|mpe?g|3gp|m4v|f4v|ts|mts|m2ts|vob)$/i;

function isMediaFile(p: string): boolean {
    return MEDIA_IMAGE_RE.test(p) || MEDIA_VIDEO_RE.test(p);
}

export class ExportService {
    private _jobs = new Map<string, JobState>();

    constructor(
        private appRoot: string,
        private media: MediaService,
    ) { }

    // ── 便捷工具 ──
    private _ffmpegBin(): string | null {
        try {
            const r = this.media.ffmpegPath();
            return (r && r.ffmpeg) || null;
        } catch { return null; }
    }

    private _job(jobId: string): JobState {
        let j = this._jobs.get(jobId);
        if (!j) { j = { canceled: false, children: new Set() }; this._jobs.set(jobId, j); }
        return j;
    }

    cancel(jobId: string): { ok: boolean } {
        const j = this._jobs.get(jobId);
        if (!j) { return { ok: false }; }
        j.canceled = true;
        for (const c of j.children) {
            try { c.kill(); } catch { /* ignore */ }
        }
        return { ok: true };
    }

    private _emit(win: BrowserWindow | null, msg: any): void {
        try {
            if (win && !win.isDestroyed()) { win.webContents.send('qqqide:export:progress', msg); }
        } catch { /* ignore */ }
    }

    private _texts(w: ExportTextsWire): { gen: ExportTexts; wire: ExportTextsWire } {
        const gen: ExportTexts = {
            attachmentIndex: w.attachmentIndex,
            colIndex: w.colIndex,
            colFileName: w.colFileName,
            colType: w.colType,
            colSize: w.colSize,
            colSha256Short: w.colSha256Short,
            fullSha256: w.fullSha256,
            mediaConversionFailed: (p: string) => String(w.mediaConversionFailedTmpl || '{0}').replace('{0}', p),
        };
        return { gen, wire: w };
    }

    // ═══════════════════════════════════════════════════════════
    // 媒体 → PNG（老 convertMediaToPng 逐字移植）
    // ═══════════════════════════════════════════════════════════
    private async _convertMediaToPng(filePath: string, useFrameResolution: boolean,
        jobId: string): Promise<{ buffer: Buffer; width: number; height: number } | null> {
        const ffmpeg = this._ffmpegBin();
        if (!ffmpeg) { return null; }

        let info: { width?: number; height?: number; duration?: number } | null = null;
        try { info = await this.media.probe(filePath); } catch { info = null; }

        const duration = (info && info.duration) || 0;
        const origW = (info && info.width) || 512;
        const origH = (info && info.height) || 288;
        let targetW = origW;
        let targetH = origH;
        let needScale = false;

        if (useFrameResolution) {
            if (origW > 512 || origH > 288) {
                const scale = Math.min(512 / origW, 288 / origH);
                targetW = Math.max(1, Math.round(origW * scale));
                targetH = Math.max(1, Math.round(origH * scale));
                needScale = true;
            }
            targetW = targetW % 2 === 0 ? targetW : targetW + 1;
            targetH = targetH % 2 === 0 ? targetH : targetH + 1;
        }

        const args: string[] = ['-hide_banner', '-loglevel', 'error'];
        if (duration > 0.5) {
            args.push('-ss', String(Math.floor(duration / 2)));
        }
        args.push('-i', filePath);
        if (needScale) {
            args.push('-vf', `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease:flags=lanczos`);
        }
        args.push('-frames:v', '1', '-f', 'image2', '-c:v', 'png');

        const rand = Math.random().toString(36).slice(2);
        const tmpFile = path.join(os.tmpdir(), `qqq_export_${rand}.png`);
        args.push('-y', tmpFile);

        const r = await this._runChild(ffmpeg, args, 60_000, jobId);
        if (r.canceled) { return null; }
        let buffer: Buffer | null = null;
        try {
            if (fs.existsSync(tmpFile)) {
                buffer = fs.readFileSync(tmpFile);
                fs.unlinkSync(tmpFile);
            }
        } catch { /* ignore */ }
        return buffer ? { buffer, width: targetW, height: targetH } : null;
    }

    /** 子进程执行（可取消/超时强杀——老 registerChildProcess 语义） */
    private _runChild(bin: string, args: string[], timeoutMs: number, jobId: string):
        Promise<{ code: number; stderr: string; canceled: boolean }> {
        const job = this._job(jobId);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (code: number, stderr: string, canceled: boolean) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                try { job.children.delete(child); } catch { /* ignore */ }
                resolve({ code, stderr, canceled });
            };
            let child: cp.ChildProcess;
            try {
                child = cp.spawn(bin, args, { windowsHide: true });
            } catch (e: any) {
                resolve({ code: -1, stderr: String(e && e.message), canceled: false });
                return;
            }
            job.children.add(child);
            let stderr = '';
            child.stderr?.on('data', (d: Buffer) => {
                if (stderr.length < 50_000) { stderr += d.toString(); }
            });
            child.on('error', (e: Error) => finish(-1, String(e && e.message), false));
            child.on('close', () => finish(0, stderr, job.canceled));
            const timer = setTimeout(() => {
                try { child.kill(); } catch { /* ignore */ }
                finish(-1, stderr, job.canceled);
            }, timeoutMs);
            if (job.canceled) {
                try { child.kill(); } catch { /* ignore */ }
            }
        });
    }

    private _sha256(filePath: string): Promise<string> {
        return new Promise((resolve) => {
            try {
                const hash = crypto.createHash('sha256');
                const stream = fs.createReadStream(filePath);
                stream.on('data', (c) => hash.update(c));
                stream.on('end', () => resolve(hash.digest('hex')));
                stream.on('error', () => resolve(''));
            } catch {
                resolve('');
            }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 保存路径决议（默认文档旁；同名已存在 → 保存对话框——老语义）
    // ═══════════════════════════════════════════════════════════
    private async _pickSavePath(win: BrowserWindow | null, defaultPath: string,
        filterLabel: string, ext: string): Promise<{ path: string | null; canceled: boolean }> {
        if (!fs.existsSync(defaultPath)) {
            return { path: defaultPath, canceled: false };
        }
        const filters = [{ name: filterLabel || ext.replace('.', '').toUpperCase(), extensions: [ext.replace('.', '')] }];
        try {
            const parent = win && !win.isDestroyed() ? win : undefined;
            const r = parent
                ? await dialog.showSaveDialog(parent, { defaultPath, filters })
                : await dialog.showSaveDialog({ defaultPath, filters });
            if (!r || r.canceled || !r.filePath) { return { path: null, canceled: true }; }
            return { path: r.filePath, canceled: false };
        } catch {
            return { path: null, canceled: true };
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ① 导出文档（RTF/.doc / DOCX）
    // ═══════════════════════════════════════════════════════════
    async doc(payload: ExportDocPayload, win: BrowserWindow | null): Promise<ExportResult> {
        const { jobId, docPath, elements, format, includeCipher, useFrameResolution } = payload;
        const job = this._job(jobId);
        const { gen, wire } = this._texts(payload.texts || ({} as ExportTextsWire));

        try {
            const docDir = path.dirname(docPath);
            const docFullName = path.basename(docPath);
            const docBaseName = path.basename(docPath, path.extname(docPath));
            const formatLabel = format === 'rtf' ? 'RTF' : 'DOCX';
            const fileExt = format === 'rtf' ? '.doc' : '.docx';
            const filterLabel = format === 'rtf' ? wire.filterLabelRtf : wire.filterLabelDocx;

            const mediaCount = elements.filter((e) => e.t === 'media').length;
            let processedMedia = 0;

            // ── 元素加工（media→PNG；path→stat 判文件/目录 + 附件收集）──
            const processed: ExportElement[] = [];
            const attachmentCandidates: (AttachmentEntry & { absPath: string })[] = [];
            const attachmentSeen = new Set<string>();
            const conversationCache = new Map<string, { buffer: Buffer; width: number; height: number } | null>();

            for (const elem of elements) {
                if (job.canceled) { return { ok: false, canceled: true }; }
                if (elem.t === 'text') {
                    processed.push({ type: 'text', content: elem.s });
                    continue;
                }
                if (elem.t === 'media') {
                    processedMedia++;
                    this._emit(win, {
                        jobId, phase: 'media', cur: processedMedia, total: mediaCount, name: path.basename(elem.p),
                    });
                    // 同文件复用缓存（老 conversionCache 语义：sha 指纹命中直接复用）
                    let png = conversationCache.get(elem.p);
                    if (png === undefined) {
                        png = await this._convertMediaToPng(elem.p, useFrameResolution, jobId);
                        conversationCache.set(elem.p, png);
                    }
                    if (png) {
                        processed.push({
                            type: 'image',
                            pngBuffer: png.buffer,
                            width: png.width,
                            height: png.height,
                            originalMark: includeCipher && elem.mark ? elem.mark : null,
                        });
                    } else {
                        processed.push({ type: 'image_error', path: elem.mark || elem.p });
                    }
                    continue;
                }
                // path：文件 → 正文保留暗号 + 附件索引；目录/缺失 → 仅保留暗号
                let st: fs.Stats | null = null;
                try { st = fs.statSync(elem.p); } catch { st = null; }
                processed.push({ type: 'text', content: elem.mark });
                if (st && st.isFile()) {
                    let realKey = elem.p;
                    try { realKey = fs.realpathSync(elem.p); } catch { /* ignore */ }
                    if (!attachmentSeen.has(realKey)) {
                        attachmentSeen.add(realKey);
                        attachmentCandidates.push({
                            name: path.basename(elem.p),
                            ext: path.extname(elem.p).toLowerCase(),
                            size: st.size,
                            sha256: '',
                            absPath: elem.p,
                        });
                    }
                }
            }

            if (processed.length === 0) {
                return { ok: false, error: 'empty_document' };
            }

            // ── 附件 SHA256（进度并入——老 computeFileSHA256 语义：失败回落空串）──
            const attTotal = attachmentCandidates.length;
            for (let i = 0; i < attTotal; i++) {
                if (job.canceled) { return { ok: false, canceled: true }; }
                this._emit(win, {
                    jobId, phase: 'hash', cur: i + 1, total: attTotal, name: attachmentCandidates[i].name,
                });
                attachmentCandidates[i].sha256 = await this._sha256(attachmentCandidates[i].absPath);
            }

            return await this._writeDocFile(win, jobId, {
                docDir, docBaseName, docFullName, format, filterLabel, fileExt, formatLabel,
                processed, attachments: attachmentCandidates, gen,
                hasAnchors: elements.some((e) => e.t === 'media' || e.t === 'path'),
            });
        } catch (e: any) {
            return { ok: false, error: String((e && e.message) || e) };
        } finally {
            this._jobs.delete(jobId);
        }
    }

    private async _writeDocFile(win: BrowserWindow | null, jobId: string, ctx: {
        docDir: string; docBaseName: string; docFullName: string;
        format: 'rtf' | 'docx'; filterLabel: string; fileExt: string; formatLabel: string;
        processed: ExportElement[]; attachments: AttachmentEntry[]; gen: ExportTexts;
        hasAnchors: boolean;
    }): Promise<ExportResult> {
        const job = this._job(jobId);
        const defaultPath = path.join(ctx.docDir, `${ctx.docBaseName}${ctx.fileExt}`);
        const pick = await this._pickSavePath(win, defaultPath, ctx.filterLabel, ctx.fileExt);
        if (pick.canceled || !pick.path) { return { ok: false, canceled: true }; }

        this._emit(win, { jobId, phase: 'generate', name: ctx.formatLabel });
        if (job.canceled) { return { ok: false, canceled: true }; }

        if (ctx.format === 'rtf') {
            const content = generateRtfDocument(ctx.processed, ctx.attachments, ctx.docFullName, ctx.gen);
            fs.writeFileSync(pick.path, content, 'utf8');
        } else {
            const parts = buildDocxParts(ctx.processed, ctx.attachments, ctx.docFullName, ctx.gen);
            await writeDocx(pick.path, parts);
        }

        let size = 0;
        try { size = fs.statSync(pick.path).size; } catch { /* ignore */ }
        return {
            ok: true, path: pick.path, size,
            attachments: ctx.attachments.length,
            hasAnchors: ctx.hasAnchors,
        };
    }

    // ═══════════════════════════════════════════════════════════
    // ② 导出 ZIP（当前文档 + 全部引用文件/目录，相对结构保留）
    // ═══════════════════════════════════════════════════════════
    async zip(payload: ExportZipPayload, win: BrowserWindow | null): Promise<ExportResult> {
        const { jobId, docPath, elements } = payload;
        const job = this._job(jobId);
        const { wire } = this._texts(payload.texts || ({} as ExportTextsWire));

        let zip: ZipWriter | null = null;
        let outPath: string | null = null;
        try {
            const docDir = path.dirname(docPath);
            const docFullName = path.basename(docPath);
            const docBaseName = path.basename(docPath, path.extname(docPath));

            // ── 引用收集（realpath 去重——老 scanQqqLinks 语义）──
            const seen = new Set<string>();
            const refs: { absPath: string; rel: string; isDir: boolean }[] = [];
            for (const elem of elements) {
                if (job.canceled) { return { ok: false, canceled: true }; }
                if (elem.t !== 'media' && elem.t !== 'path') { continue; }
                let st: fs.Stats | null = null;
                try { st = fs.statSync(elem.p); } catch { st = null; }
                if (!st) { continue; }
                let realKey = elem.p;
                try { realKey = fs.realpathSync(elem.p); } catch { /* ignore */ }
                if (seen.has(realKey)) { continue; }
                seen.add(realKey);
                let rel = path.relative(docDir, elem.p);
                if (!rel || rel === '.' || rel === './') { rel = path.basename(elem.p) || 'qqq_ref'; }
                refs.push({ absPath: elem.p, rel: sanitizeZipName(rel) || 'qqq_ref', isDir: st.isDirectory() });
            }

            // ── 条目清单（文件展开 + 尺寸合计 → 进度分母）──
            this._emit(win, { jobId, phase: 'prepare', name: docFullName });
            const entries: { src: string; name: string }[] = [];
            const dirEntries: string[] = [];
            let totalBytes = 0;
            try { totalBytes += fs.statSync(docPath).size; } catch { /* ignore */ }
            for (const ref of refs) {
                if (job.canceled) { return { ok: false, canceled: true }; }
                if (ref.isDir) {
                    dirEntries.push(ref.rel);
                    await this._walkDir(ref.absPath, ref.rel, entries, (n) => { totalBytes += n; });
                } else {
                    let sz = 0;
                    try { sz = fs.statSync(ref.absPath).size; } catch { /* ignore */ }
                    totalBytes += sz;
                    entries.push({ src: ref.absPath, name: ref.rel });
                }
            }

            // ── 保存路径决议 ──
            const defaultZip = path.join(docDir, `${docBaseName}.zip`);
            const pick = await this._pickSavePath(win, defaultZip, wire.filterLabelZip, '.zip');
            if (pick.canceled || !pick.path) { return { ok: false, canceled: true }; }
            outPath = pick.path;

            // ── 压缩（level 9；进度 = 已压缩字节增量累加，150ms 节流——老 archiver.on('progress') 语义）──
            zip = new ZipWriter(outPath);
            await zip.open();
            let processedBytes = 0;
            let doneEntries = 0;
            let lastTick = 0;
            const emitZipProgress = () => {
                const now = Date.now();
                if (now - lastTick < 150) { return; }
                lastTick = now;
                this._emit(win, {
                    jobId, phase: 'zip', bytes: processedBytes, total: totalBytes,
                    entries: doneEntries, entryTotal: entries.length + dirEntries.length + 1, name: docFullName,
                });
            };
            const stripe = async (name: string, src: string) => {
                let lastC = 0;
                await zip!.addFileFromDisk(name, src, (c) => {
                    processedBytes += (c - lastC);
                    lastC = c;
                    emitZipProgress();
                });
                doneEntries++;
                emitZipProgress();
            };

            await stripe(docFullName, docPath);
            for (const d of dirEntries) { await zip.addDir(d); doneEntries++; }
            for (const e of entries) {
                if (job.canceled) { throw new Error('canceled'); }
                await stripe(e.name, e.src);
            }

            await zip.finalize();
            zip = null;
            this._emit(win, { jobId, phase: 'done', bytes: totalBytes, total: totalBytes, entries: entries.length + 1, entryTotal: entries.length + 1, name: docFullName });

            let size = 0;
            try { size = fs.statSync(outPath).size; } catch { /* ignore */ }
            return { ok: true, path: outPath, size, refs: refs.length, hasAnchors: refs.length > 0 };
        } catch (e: any) {
            if (zip) { try { zip.abort(); } catch { /* ignore */ } }
            if (outPath) { try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ } }
            if (job.canceled || String(e && e.message) === 'canceled') {
                return { ok: false, canceled: true };
            }
            return { ok: false, error: String((e && e.message) || e) };
        } finally {
            this._jobs.delete(jobId);
        }
    }

    /** 递归收集目录内文件（zip 名 = 相对前缀/子路径） */
    private async _walkDir(absDir: string, zipPrefix: string, out: { src: string; name: string }[], onSize: (n: number) => void): Promise<void> {
        let dirents: fs.Dirent[];
        try {
            dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
        } catch { return; }
        for (const d of dirents) {
            const full = path.join(absDir, d.name);
            const zipName = zipPrefix ? `${zipPrefix}/${d.name}` : d.name;
            if (d.isDirectory()) {
                await this._walkDir(full, zipName, out, onSize);
            } else if (d.isFile()) {
                let sz = 0;
                try { sz = (await fs.promises.stat(full)).size; } catch { /* ignore */ }
                onSize(sz);
                out.push({ src: full, name: zipName });
            }
        }
    }
}
