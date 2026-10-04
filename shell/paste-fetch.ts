// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// paste-fetch.ts — 网页粘贴媒体下载机器（唯一入口；老 q3 dow.js 移植）
//
// 定位: 渲染层网页粘贴（paste-router → html-paste）抽取出的媒体 URL → 主进程流式下载
//       （无 CORS 限制）→ 落盘 → sha256 → 同目录指纹去重 → 返回最终路径。
//
// ★ 11 项安全开关（老 q3 downloadSecurityLevel 三档语义，唯一真相 = 本文件 resolveSecurityProfile）:
//   0 档 = 全关（最宽松）/ 1 档 = 开 4 项（协议限制/重定向限制/下载锁/Header 清洗）/ 2 档 = 全开
//   1  SSRF 默认拦截       — 内网/本机/保留网段 DNS 解析拦截
//   2  协议+凭据守卫        — 仅 http/https，禁止 user:pass@
//   3  重定向协议限制       — 30x 只能跳 http/https
//   4  baseDir 越界防护     — 最终落盘路径必须在 destDir 内
//   5  下载锁（.qlok）      — 同目标路径并发串行化 + 陈旧锁清理
//   6  Header 清洗         — CRLF/非法 header 名拒绝
//   7  content-length 预检  — 声明超限提前拒绝
//   8  严格 Range          — 未发 Range 却回 206 → 拒收（防错位）
//   9  符号链接防护        — 落点 symlink/非普通文件拒绝
//   10 yt-dlp 输出限制      — stdout/stderr 字节帽（防打印型攻击拖垮）
//   11 fail-fast           — 可疑即失败（清晰边界替代模糊降级）
//
// ★ 下载路径: 平台/分片视频（YouTube/B站/m3u8/mpd…）→ yt-dlp；其余 → 直连 HTTP
//   （重试退避 / 反盗链 Referer+Origin 增强重试 / 断点语义 = 每次全新下载 + 完成后去重）
//
// ★ 去重/命名（与主进程 copyFile 去重引擎同语义）: 下载到临时 .part → sha256（流式）+
//   指纹（size+头/中/尾 md5）→ 扫同目录同尺寸候选指纹比对 → 命中删新复用既有；
//   未命中 → 唯一化命名（name_1.ext，公共约定 6）落盘。
//
// IPC（main.ts 注册）:
//   qqqide:paste-dl:fetch  (payload) → {ok, results:[{tag,url,ok,path,name,bytes,sha256,reused,error}], stats}
//   qqqide:paste-dl:cancel (jobId)   → boolean
//   进度: webContents.send('qqqide:paste-dl:progress', {jobId,done,total,ok,fail,bytes,curName,curPct})
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import * as net from 'net';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { pipeline, Transform } from 'stream';
import { spawn } from 'child_process';
import * as iconv from 'iconv-lite';
import { getComponentBin } from './component-checker';
import { getDataDir } from './portable-paths';
import { mi } from './main-i18n';

// ════════════════════════════════════════════════════════════════════════════
// 安全档位（老 q3 resolveSecurityProfile 逐字段移植）
// ════════════════════════════════════════════════════════════════════════════

export interface SecuritySwitches {
    enableSSRFProtection: boolean;
    enableUrlProtocolAndCredsGuard: boolean;
    enableRedirectProtocolGuard: boolean;
    enableBaseDirGuard: boolean;
    enableDownloadLock: boolean;
    enableHeaderSanitize: boolean;
    enableContentLengthRangePrecheck: boolean;
    enableStrictRangeChecks: boolean;
    enableSymlinkGuard: boolean;
    enableProbeOutputLimit: boolean;
    enableFailFast: boolean;
}

export function resolveSecurityProfile(level: number): SecuritySwitches {
    if (Number(level) === 2) {
        return {
            enableSSRFProtection: true,
            enableUrlProtocolAndCredsGuard: true,
            enableRedirectProtocolGuard: true,
            enableBaseDirGuard: true,
            enableDownloadLock: true,
            enableHeaderSanitize: true,
            enableContentLengthRangePrecheck: true,
            enableStrictRangeChecks: true,
            enableSymlinkGuard: true,
            enableProbeOutputLimit: true,
            enableFailFast: true,
        };
    }
    if (Number(level) === 1) {
        return {
            enableSSRFProtection: false,
            enableUrlProtocolAndCredsGuard: true,
            enableRedirectProtocolGuard: true,
            enableBaseDirGuard: false,
            enableDownloadLock: true,
            enableHeaderSanitize: true,
            enableContentLengthRangePrecheck: false,
            enableStrictRangeChecks: false,
            enableSymlinkGuard: false,
            enableProbeOutputLimit: false,
            enableFailFast: false,
        };
    }
    return {
        enableSSRFProtection: false,
        enableUrlProtocolAndCredsGuard: false,
        enableRedirectProtocolGuard: false,
        enableBaseDirGuard: false,
        enableDownloadLock: false,
        enableHeaderSanitize: false,
        enableContentLengthRangePrecheck: false,
        enableStrictRangeChecks: false,
        enableSymlinkGuard: false,
        enableProbeOutputLimit: false,
        enableFailFast: false,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// 通用小件
// ════════════════════════════════════════════════════════════════════════════

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
}

function pipelineP(...streams: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
        (pipeline as any)(...streams, (err: any) => (err ? reject(err) : resolve()));
    });
}

function isRetryableHttpStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isWorthAntiHotlinkRetry(status: number): boolean {
    return status === 401 || status === 403 || status === 406;
}

function isRetryableNetworkError(err: any): boolean {
    const code = String((err && err.code) || '');
    const msg = String((err && err.message) || '');
    const set = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'];
    if (set.indexOf(code) >= 0) return true;
    if (code.indexOf('ERR_HTTP2') === 0) return true;
    if (msg.toLowerCase().indexOf('socket hang up') >= 0) return true;
    return false;
}

function computeBackoffMs(attemptIndex: number, retryAfterMs?: number): number {
    const base = 250;
    const exp = Math.min(6000, base * Math.pow(2, Math.max(0, attemptIndex - 1)));
    const jitter = Math.floor(Math.random() * 150);
    const normal = exp + jitter;
    return retryAfterMs && retryAfterMs > 0 ? Math.max(retryAfterMs, normal) : normal;
}

export function parseRetryAfterMs(retryAfter: any): number {
    if (!retryAfter) return 0;
    const v = String(retryAfter).trim();
    if (!v) return 0;
    const sec = Number(v);
    if (isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 60000);
    const t = Date.parse(v);
    if (isFinite(t)) return Math.max(0, Math.min(t - Date.now(), 60000));
    return 0;
}

// ── header 清洗（CRLF/非法名；switch 6） ──
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export function sanitizeHeaders(input: any, failFast: boolean): { ok: boolean; headers?: Record<string, string>; error?: string } {
    const out: Record<string, string> = {};
    const src = input && typeof input === 'object' ? input : {};
    for (const k0 of Object.keys(src)) {
        const k = String(k0 || '').trim();
        if (!k) continue;
        if (k.indexOf('\r') >= 0 || k.indexOf('\n') >= 0 || !HEADER_NAME_RE.test(k)) {
            if (failFast) return { ok: false, error: 'invalid_header_name' };
            continue;
        }
        const v0 = (src as any)[k0];
        const arr = Array.isArray(v0) ? v0.map((x: any) => String(x)) : [String(v0)];
        const vv = arr.map((s: string) => s.replace(/[\r\n]+/g, ' ').trim()).join(', ');
        if (!vv) continue;
        out[k.toLowerCase()] = vv;
    }
    return { ok: true, headers: out };
}

// ── 路径/符号链接守卫 ──
function isPathInsideBaseDir(filePath: string, baseDir: string): boolean {
    try {
        const absFile = path.resolve(String(filePath || ''));
        const absBase = path.resolve(String(baseDir || ''));
        if (!absBase.endsWith(path.sep)) {
            return absFile === absBase || absFile.startsWith(absBase + path.sep);
        }
        return absFile.startsWith(absBase);
    } catch {
        return false;
    }
}

function lstatIfExists(p: string): fs.Stats | null {
    try { return fs.lstatSync(p); } catch { return null; }
}

function ensureNotSymlink(p: string, failFast: boolean): { ok: boolean; error?: string } {
    const st = lstatIfExists(p);
    if (!st) return { ok: true };
    if (st.isSymbolicLink()) return { ok: false, error: 'symlink_not_allowed' };
    if (st.isDirectory()) return { ok: false, error: 'path_is_directory' };
    if (!st.isFile()) return { ok: false, error: 'path_not_regular_file' };
    return { ok: true };
}

// ── 下载锁（switch 5；老 q3 acquireDownloadQlok） ──
async function acquireDownloadQlok(destPath: string, ctl: JobCtl, waitMs = 15000): Promise<{ ok: boolean; error?: string; release?: () => void }> {
    const qlokPath = String(destPath) + '.qlok';
    const pollMs = 120;
    const staleMs = 60000;
    const start = Date.now();
    try { fs.mkdirSync(path.dirname(qlokPath), { recursive: true }); } catch { /* ignore */ }
    while (true) {
        if (ctl.cancelled) return { ok: false, error: 'cancelled' };
        let fd: number | null = null;
        try {
            fd = fs.openSync(qlokPath, 'wx');
            try { fs.writeFileSync(fd, process.pid + '\n' + Date.now() + '\n'); } catch { /* ignore */ }
            try { fs.closeSync(fd); } catch { /* ignore */ }
            return {
                ok: true,
                release: () => { try { fs.unlinkSync(qlokPath); } catch { /* ignore */ } },
            };
        } catch {
            try { if (fd !== null) fs.closeSync(fd); } catch { /* ignore */ }
            try {
                const st = fs.statSync(qlokPath);
                if (staleMs > 0 && Date.now() - st.mtimeMs > staleMs) {
                    try { fs.unlinkSync(qlokPath); } catch { /* ignore */ }
                    continue;
                }
            } catch { /* ignore */ }
            if (Date.now() - start >= waitMs) return { ok: false, error: 'dest_locked' };
            await sleep(pollMs);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// SSRF 检查（switch 1；老 q3 移植）
// ════════════════════════════════════════════════════════════════════════════

function ipv4ToInt(ip: string): number | null {
    const parts = String(ip).split('.').map((x) => Number(x));
    if (parts.length !== 4 || parts.some((n) => !isFinite(n) || n < 0 || n > 255)) return null;
    return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}
function inCidrV4(ipInt: number, baseInt: number, maskBits: number): boolean {
    const mask = maskBits === 0 ? 0 : ((0xffffffff << (32 - maskBits)) >>> 0);
    return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}
export function isNonPublicIPv4(ip: string): boolean {
    const x = ipv4ToInt(ip);
    if (x === null) return true;
    const blocks: Array<[string, number]> = [
        ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
        ['192.168.0.0', 16], ['100.64.0.0', 10], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15],
        ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
    ];
    for (const [b, m] of blocks) {
        const bi = ipv4ToInt(b);
        if (bi !== null && inCidrV4(x, bi, m)) return true;
    }
    return false;
}
function isNonPublicIPv6(ip: string): boolean {
    const s = String(ip || '').toLowerCase();
    if (s.startsWith('::ffff:')) {
        const v4 = s.slice('::ffff:'.length);
        const last = v4.split(':').pop();
        if (last && net.isIP(last) === 4) return isNonPublicIPv4(last);
    }
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true;
    if (s.startsWith('ff')) return true;
    if (s.startsWith('2001:db8')) return true;
    return false;
}
export function isNonPublicIp(ip: string): boolean {
    const t = net.isIP(ip);
    if (t === 4) return isNonPublicIPv4(ip);
    if (t === 6) return isNonPublicIPv6(ip);
    return true;
}
export function isLocalHostname(hostname: string): boolean {
    const h = String(hostname || '').toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === 'local' || h.endsWith('.local')) return true;
    return false;
}
function dnsLookupAll(hostname: string, timeoutMs: number): Promise<Array<{ address: string; family: number }>> {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(Object.assign(new Error('dns_timeout'), { code: 'ETIMEDOUT' }));
        }, Math.max(1, Number(timeoutMs) || 3000));
        dns.lookup(hostname, { all: true }, (err, addresses: any) => {
            if (done) return;
            clearTimeout(timer);
            done = true;
            if (err) reject(err);
            else resolve(addresses || []);
        });
    });
}

// ════════════════════════════════════════════════════════════════════════════
// 文件名/嗅探/指纹
// ════════════════════════════════════════════════════════════════════════════

function sanitizeFileName(name: string): string {
    let s = String(name || '');
    try { s = decodeURIComponent(s); } catch { /* keep raw */ }
    s = s.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\.+/, '').trim();
    if (s.length > 100) {
        const dot = s.lastIndexOf('.');
        const ext = dot > 0 && s.length - dot <= 8 ? s.slice(dot) : '';
        s = s.slice(0, 100 - ext.length) + ext;
    }
    return s;
}

function baseNameFromUrl(u: URL): string {
    let seg = '';
    try {
        const parts = u.pathname.split('/').filter(Boolean);
        seg = parts.length ? parts[parts.length - 1] : '';
    } catch { /* ignore */ }
    return sanitizeFileName(seg);
}

const _IMG_MIME_EXT: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico', 'image/tiff': '.tif',
};
const _VID_MIME_EXT: Record<string, string> = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
    'video/x-matroska': '.mkv', 'video/mpeg': '.mpg', 'video/ogg': '.ogv', 'video/x-flv': '.flv',
};

export function extFromMime(mime: string, kind: string): string {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (_IMG_MIME_EXT[m]) return _IMG_MIME_EXT[m];
    if (_VID_MIME_EXT[m]) return _VID_MIME_EXT[m];
    return kind === 'video' ? '.mp4' : '.png';
}

const _KNOWN_MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?|mp4|webm|mov|m4v|avi|mkv|flv|ogv|ogg|wmv|mpg|mpeg)$/i;

export function sniffVideoMagic(buf: Buffer): boolean {
    if (!buf || buf.length < 12) return false;
    const s4 = buf.slice(4, 8).toString('latin1');
    if (s4 === 'ftyp' || s4 === 'moov' || s4 === 'mdat') return true;
    if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return true; // EBML (webm/mkv)
    if (buf.slice(0, 4).toString('latin1') === 'RIFF') return true;                            // AVI/WAV
    if (buf.slice(0, 3).toString('latin1') === 'FLV') return true;
    if (buf.slice(0, 4).toString('latin1') === 'OggS') return true;
    if (buf[0] === 0x47) return true;                                                          // MPEG-TS
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0xBA) return true; // MPEG-PS
    return false;
}

/** 指纹 = size + 头/中/尾各 128B md5（与主进程 copyFile 去重引擎同语义；空文件含尺寸键） */
function fingerprintFile(fp: string): string {
    try {
        const st = fs.statSync(fp);
        const size = st.size;
        const h = crypto.createHash('md5');
        h.update('s' + size + '|');
        const fd = fs.openSync(fp, 'r');
        try {
            const chunk = Buffer.alloc(128);
            const positions = size > 384 ? [0, Math.floor(size / 2) - 64, size - 128] : [0];
            for (const p of positions) {
                const pos = Math.max(0, p);
                const n = fs.readSync(fd, chunk, 0, 128, pos);
                h.update(chunk.subarray(0, n));
            }
        } finally {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        return h.digest('hex');
    } catch {
        return '';
    }
}

function readHeadBytes(fp: string, n: number): Buffer {
    try {
        const fd = fs.openSync(fp, 'r');
        try {
            const buf = Buffer.alloc(n);
            const got = fs.readSync(fd, buf, 0, n, 0);
            return buf.subarray(0, got);
        } finally {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    } catch {
        return Buffer.alloc(0);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 网页解码机（编码检测增强；老 q3 _decodeHtmlBytesSmart 移植 + 扩充）
// 链路: BOM → Content-Type charset → <meta charset> → 严格 UTF-8 → GBK 兜底；
//       声明与实际冲突（解码出 U+FFFD）时与启发式竞品对比、选替换符更少者。
// ════════════════════════════════════════════════════════════════════════════

const _tdUtf8Fatal = new TextDecoder('utf-8', { fatal: true });

const _CHARSET_ALIASES: Record<string, string> = {
    'utf-8': 'utf-8', 'utf8': 'utf-8', 'unicode-1-1-utf-8': 'utf-8',
    'gbk': 'gbk', 'gb2312': 'gbk', 'gb-2312': 'gbk', 'x-gbk': 'gbk', 'gb_2312-80': 'gbk',
    'gb18030': 'gb18030',
    'big5': 'big5', 'big-5': 'big5', 'big5-hkscs': 'big5', 'cn-big5': 'big5',
    'shift_jis': 'shiftjis', 'shift-jis': 'shiftjis', 'sjis': 'shiftjis', 'x-sjis': 'shiftjis', 'windows-31j': 'shiftjis', 'ms_kanji': 'shiftjis',
    'euc-jp': 'euc-jp', 'euc-kr': 'euc-kr', 'ks_c_5601-1987': 'euc-kr',
    'iso-8859-1': 'windows-1252', 'latin1': 'windows-1252', 'latin-1': 'windows-1252', 'windows-1252': 'windows-1252', 'cp1252': 'windows-1252',
    'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf16': 'utf-16le', 'utf16le': 'utf-16le',
    'utf-16be': 'utf-16be', 'utf16be': 'utf-16be',
    'ascii': 'utf-8', 'us-ascii': 'utf-8',
};

/** 规范化字符集标签；未知返回 ''（调用方走启发式） */
export function resolveCharset(label: string): string {
    const l = String(label || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
    if (!l) return '';
    if (_CHARSET_ALIASES[l]) return _CHARSET_ALIASES[l];
    try { if (iconv.encodingExists(l)) return l; } catch { /* ignore */ }
    return '';
}

function _charsetFromContentType(ct: string): string {
    const m = /charset\s*=\s*["']?\s*([a-z0-9._:\-]+)/i.exec(String(ct || ''));
    return m ? resolveCharset(m[1]) : '';
}

function _charsetFromMeta(buf: Buffer): string {
    try {
        const head = buf.subarray(0, Math.min(buf.length, 8192)).toString('latin1');
        const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9._:\-]+)/i.exec(head);
        return m ? resolveCharset(m[1]) : '';
    } catch { return ''; }
}

function _replacementCount(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xFFFD) n++;
    return n;
}

function _decodeHeuristic(buf: Buffer): { text: string; charset: string } {
    // 严格 UTF-8（含截断头回退 ≤3 字节——尾部多字节序列被切不误判 GBK）
    for (let back = 0; back <= 3; back++) {
        const slice = back === 0 ? buf : buf.subarray(0, buf.length - back);
        try {
            _tdUtf8Fatal.decode(slice);
            return { text: iconv.decode(slice, 'utf-8'), charset: 'utf-8' };
        } catch { /* 下一档 */ }
    }
    try { return { text: iconv.decode(buf, 'gbk'), charset: 'gbk' }; } catch { /* fall */ }
    return { text: buf.toString('utf8'), charset: 'utf-8' };
}

/** 网页字节 → 文本。contentTypeHeader = 原始 Content-Type 响应头（含 charset 参数）。 */
export function decodeHtmlBuffer(buf: Buffer, contentTypeHeader?: string): { text: string; charset: string } {
    if (!buf || !buf.length) return { text: '', charset: 'utf-8' };
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { text: iconv.decode(buf.subarray(3), 'utf-8'), charset: 'utf-8' };
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: iconv.decode(buf.subarray(2), 'utf-16le'), charset: 'utf-16le' };
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return { text: iconv.decode(buf.subarray(2), 'utf-16be'), charset: 'utf-16be' };

    const declared = _charsetFromContentType(contentTypeHeader || '') || _charsetFromMeta(buf);
    if (declared) {
        let text = '';
        try { text = iconv.decode(buf, declared); } catch { text = ''; }
        if (text && !_replacementCount(text)) return { text, charset: declared };
        if (text) {
            // 声明与实际冲突 → 与启发式竞品对比、选替换符更少者
            const alt = _decodeHeuristic(buf);
            if (_replacementCount(alt.text) < _replacementCount(text)) return alt;
            return { text, charset: declared };
        }
    }
    return _decodeHeuristic(buf);
}

// ════════════════════════════════════════════════════════════════════════════
// 平台/分片视频判定（老 q3 dow.js isPlatformOrSegmentVideo）
// ════════════════════════════════════════════════════════════════════════════

export function isPlatformOrSegmentVideo(url: string): boolean {
    const s = String(url || '');
    const patterns = [
        /youtube\.com|youtu\.be/i,
        /bilibili\.com|b23\.tv/i,
        /twitter\.com|x\.com/i,
        /vimeo\.com/i,
        /dailymotion\.com/i,
        /tiktok\.com|douyin\.com/i,
        /weibo\.com/i,
        /\.m3u8(\?|$)/i,
        /\.mpd(\?|$)/i,
    ];
    return patterns.some((p) => p.test(s));
}

export function platformVideoName(url: string): string {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        let m = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{6,})/.exec(url);
        if (!m) m = /(BV[0-9A-Za-z]{8,})/.exec(url);
        if (!m) m = /\/status\/(\d{6,})/.exec(url);
        if (!m) m = /\/video\/(\d{6,})/.exec(url);
        if (m) return sanitizeFileName(host + '_' + m[1]);
        return sanitizeFileName(host + '_' + Date.now().toString(36));
    } catch {
        return sanitizeFileName('video_' + Date.now().toString(36));
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 抖音专用捕获
//   yt-dlp 对其 web API 已失效——detail 接口需要页面 JS 现算的 a_bogus 签名
//   （任何静态请求器都拿不到；yt-dlp 实测恒 403「Fresh cookies needed」）。
//   改用隐藏窗口载入真实视频页 → CDP 抓取【页面自身发出的】detail 响应体 →
//   取最高码率档直链 → 走常规下载链（Referer=抖音域）。
// ════════════════════════════════════════════════════════════════════════════

export function isDouyinUrl(url: string): boolean {
    try {
        const h = new URL(String(url || '')).hostname.toLowerCase();
        return h === 'douyin.com' || h.endsWith('.douyin.com') || h === 'iesdouyin.com' || h.endsWith('.iesdouyin.com');
    } catch { return false; }
}

/**
 * 抖音页面 URL 归一化：/video/{id}、/note/{id} 原样；分享页 ?modal_id= / ?vid= 参数 → /video/{id}；
 * v.douyin.com 短链原样（隐藏窗口跟随重定向自动落位）。ok=false = 链接未指向具体视频（如作者主页无 modal_id）。
 */
export function douyinPageUrl(url: string): { ok: boolean; pageUrl: string; videoId: string } {
    try {
        const u = new URL(String(url || ''));
        const h = u.hostname.toLowerCase();
        if (h === 'v.douyin.com') return { ok: true, pageUrl: u.href, videoId: '' };
        const m = /^\/(?:video|note)\/(\d{6,})/.exec(u.pathname || '');
        if (m) return { ok: true, pageUrl: u.href, videoId: m[1] };
        const mid = String(u.searchParams.get('modal_id') || u.searchParams.get('vid') || '');
        if (/^\d{6,}$/.test(mid)) return { ok: true, pageUrl: 'https://www.douyin.com/video/' + mid, videoId: mid };
        return { ok: false, pageUrl: '', videoId: '' };
    } catch { return { ok: false, pageUrl: '', videoId: '' }; }
}

// ════════════════════════════════════════════════════════════════════════════
// 任务接口
// ════════════════════════════════════════════════════════════════════════════

// ── yt-dlp cookies 约定文件（风控站点自救唯一入口；详铁律 §4.17） ─────────────
// 落点双目录（按优先级）：① {Data}/yt-dlp —— 持久保险库（随包更新不灭；用户投放推荐位，
//   由 qoast「打开 cookies 文件夹」按钮直达）② yt-dlp 组件目录 —— dev 便利 / 历史兼容。
// 命名宽松（老 q3 语义）：精确 cookies.txt 优先；否则「文件名含 cookies 的 .txt」取最新 mtime
//（浏览器扩展导出常见名如 www.youtube.com_cookies.txt，无需改名；多个文件时最新者生效）。
// 空文件视为不存在；每次下载即时扫描（放入即生效，零重启）。
export interface CookiesFileEntry { path: string; name: string; mtimeMs: number; size: number; }

/** 纯函数：从候选条目挑选生效的 cookies 文件（精确名优先 → 最新 mtime；空/非 .txt/非 cookies 名剔除）。 */
export function pickCookiesFile(entries: CookiesFileEntry[]): string | null {
    const ok = (entries || []).filter((e) => e && e.size > 0 && /\.txt$/i.test(String(e.name)) && /cookies/i.test(String(e.name)));
    if (!ok.length) return null;
    const exact = ok.filter((e) => String(e.name).toLowerCase() === 'cookies.txt');
    const pool = exact.length ? exact : ok;
    let best = pool[0];
    for (const e of pool) { if (e.mtimeMs > best.mtimeMs) best = e; }
    return best.path;
}

/** 扫描双目录挑出 cookies 文件；无 → null。（每次调用即时读盘，无缓存。） */
function _findCookiesFile(binDir: string): string | null {
    const dirs: string[] = [];
    try { dirs.push(path.join(getDataDir(), 'yt-dlp')); } catch { /* ignore */ }
    if (binDir) dirs.push(binDir);
    const entries: CookiesFileEntry[] = [];
    const seen = new Set<string>();
    for (const d of dirs) {
        let key = '';
        try { key = path.resolve(d); } catch { key = String(d); }
        if (!key || seen.has(key)) continue;
        seen.add(key);
        let names: string[] = [];
        try { names = fs.readdirSync(d); } catch { continue; }
        for (const name of names) {
            if (!/\.txt$/i.test(name) || !/cookies/i.test(name)) continue;
            try {
                const fp = path.join(d, name);
                const st = fs.statSync(fp);
                if (st.isFile()) entries.push({ path: fp, name, mtimeMs: st.mtimeMs, size: st.size });
            } catch { /* ignore */ }
        }
    }
    return pickCookiesFile(entries);
}

// ★ 使用说明文件名刻意不含 "cookies" 字样 —— 防被上述扫描当 cookies 文件选中。
const COOKIES_README_NAME = '如何修复下载验证（请读我）.txt';
const COOKIES_README_TEXT = '\uFEFF' + [
    'qqqide · cookies 使用说明',
    '========================',
    '用途：部分视频网站（如 YouTube）会要求登录/人机验证。cookies 文件可让下载通过验证。',
    '',
    '获取 cookies —— 方式一（推荐）：',
    '· 在 qqqide 里使用下载提示中的「在 qd 内登录」按钮，登录后 cookies 会自动保存到本文件夹',
    '· 若自动保存未触发，可点击登录窗口右下角的「保存」按钮手动保存（其它站点同样适用）',
    '',
    '方式二（浏览器扩展导出）：',
    '1. 在浏览器（Chrome / Edge / Firefox）安装扩展「Get cookies.txt LOCALLY」',
    '2. 登录并打开目标网站（如 youtube.com），点击扩展图标 → Export',
    '3. 把导出的 .txt 文件放入本文件夹（文件名含 cookies 即可，无需改名；多个文件时取最新）',
    '4. 回到 qqqide 重新粘贴链接下载',
    '',
    '说明：',
    '· 部分站点/网络环境下，仅有 cookies 仍可能被验证拦截——可尝试更换网络/代理节点',
    '· cookies 过期或失效后会再次提示验证失败——重新导出或再次在 qd 内登录即可',
    '· 导出 B 站等其它站点的 cookies 放进来，对应站点下载同样受益',
    '· 安全：cookies 文件等同账号登录凭证，请勿分享或上传到 git 仓库',
    '',
    '—— English ——',
    'Use the "Sign in inside qd" button in the download error message to get cookies',
    'automatically (or click the Save button at the bottom-right of the sign-in window),',
    'or export with the "Get cookies.txt LOCALLY" browser extension and',
    'put the .txt file in this folder (any name containing "cookies"; newest one wins).',
    'If downloads are still blocked, try a different network/proxy node.',
    'Never share this file or commit it to a git repository.',
    '',
].join('\n');

// ── cookies 一键获取：qd 内登录窗口（「在 qd 内登录」；老项目插件路线的内置化）─────
// 机理：打开真实浏览器窗口（独立 persist 分区；入口页 = 触发风控的站点，缺省 YouTube 首页）→
//   用户在窗口内登录目标站点 → 每 2s 轮询该会话 cookies，检出登录态（YouTube SID/LOGIN_INFO/
//   __Secure-1PSID 或 B 站 SESSDATA）→ 序列化 Netscape 格式 → 与现有 cookies 文件「同域同路径
//   同名新者优先」合并 → 原子写入 {Data}/yt-dlp/cookies.txt（精确名——扫描首选）→
//   广播 cookies-saved（渲染层自动重试）。
//   ★ 站点无关手动保存: 页面右下角注入「保存」按钮（console 标记 + qqqide-cookies:save 伪协议，
//     主进程双路拦截）—— 自动检测表不覆盖的站点由用户一键保存，不依赖站点清单。
//   ★ 空白窗防线（2026-10-04 实测事故）: YouTube 首页含 fonts.googleapis.com 样式表，CN 网络下该
//     请求长期挂起 → 浏览器解析器阻塞（其后 inline script 永不执行 → body 从未创建 → 空白窗卡死
//     15 分钟+，实测）。修法 = 会话级取消 google fonts（缺失只回落系统字体，功能零影响；实测取消后
//     6s 内完整加载）+ 加载看门狗（body 超时未出现/渲染进程失联 → 自动重载 ≤2 次）+ 现场日志。
// ★ yt-dlp 回写防线：`--cookies` 语义 = 「read cookies from and dump cookie jar in」（--help 原文）——
//   风控站点下发的 Set-Cookie 作废指令会被回写进该文件；故 yt-dlp 只允许吃临时副本（_fetchViaYtdlp），
//   用户投放的 cookies 文件永远只读（实测事故：直传用户文件三连运行 22→17→12 条逐次减血）。
const HARVEST_PARTITION = 'persist:qqq-ytdlp-cookies';
const HARVEST_TICK_MS = 2000;
const HARVEST_MAX_RELOADS = 2;
const HARVEST_LOG_CAP = 256 * 1024;
const HARVEST_SAVE_MARK = '__qqq_cookie_save__';
let _harvestWin: any = null;
let _harvestTimer: any = null;

/** 纯函数：站点根 URL 归一（登录窗入口页）: http/https → `${protocol}//${host}/`；非法/缺省 → YouTube 首页。 */
export function siteRootOf(url?: string | null): string {
    try {
        const u = new URL(String(url || ''));
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.protocol + '//' + u.host + '/';
    } catch { /* ignore */ }
    return 'https://www.youtube.com/';
}

/** 登录窗事件留痕（Data/Logs/cookies-harvest.log，256KB 截断；排障唯一现场）。 */
function _hLog(line: string): void {
    try {
        const dir = path.join(getDataDir(), 'Logs');
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, 'cookies-harvest.log');
        try { if (fs.statSync(p).size > HARVEST_LOG_CAP) fs.writeFileSync(p, ''); } catch { /* ignore */ }
        fs.appendFileSync(p, new Date().toISOString() + ' ' + line + '\n');
    } catch { /* ignore */ }
}

/** 手动保存按钮注入脚本（页面右下角；点击 → console 标记 + qqqide-cookies:save 双路回传）。
 *  幂等（SPA 重渲染不重复注入）；样式直角橙块；不设 cursor（光标纪律）。 */
export function cookieBtnScript(label: string): string {
    const L = JSON.stringify(String(label || 'Save cookies'));
    return '(function(){try{if(window.__qqqCookieSaveBtn)return;' +
        "var d=document.createElement('div');d.id='qqq-cookie-save-btn';" +
        "d.setAttribute('style','position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#ffa02a;color:#1a1a1a;font:600 13px/1.35 Tahoma,\"Microsoft YaHei\",sans-serif;padding:9px 14px;border:1px solid rgba(0,0,0,.28);border-radius:0;box-shadow:0 2px 12px rgba(0,0,0,.45);user-select:none');" +
        'd.textContent=' + L + ';' +
        "d.addEventListener('click',function(){try{console.error('" + HARVEST_SAVE_MARK + "');}catch(e){}try{location.href='qqqide-cookies:save';}catch(e){}});" +
        '(document.documentElement||document.body).appendChild(d);window.__qqqCookieSaveBtn=1;}catch(e){}})();';
}

/** 纯函数：Electron cookies 列表 → Netscape cookies 文本（#HttpOnly_ 前缀规范 + 制表符结构防线）。 */
export function serializeCookiesToNetscape(list: any[]): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    const rows = (Array.isArray(list) ? list : []).slice().sort((a: any, b: any) =>
        String((a && a.domain) || '').localeCompare(String((b && b.domain) || '')) ||
        String((a && a.path) || '').localeCompare(String((b && b.path) || '')) ||
        String((a && a.name) || '').localeCompare(String((b && b.name) || '')));
    for (const c of rows) {
        if (!c || !c.name) continue;
        const name = String(c.name);
        const value = String(c.value == null ? '' : c.value);
        if (/[\t\r\n]/.test(name) || /[\t\r\n]/.test(value)) continue;
        const domain = String(c.domain || '');
        if (!domain) continue;
        const cpath = String(c.path || '/');
        const key = domain + '|' + cpath + '|' + name;
        if (seen.has(key)) continue;
        seen.add(key);
        const flag = domain.charAt(0) === '.' ? 'TRUE' : 'FALSE';
        const secure = c.secure ? 'TRUE' : 'FALSE';
        const exp = Math.floor(Number(c.expirationDate) || 0);
        lines.push((c.httpOnly ? '#HttpOnly_' : '') + domain + '\t' + flag + '\t' + cpath + '\t' + secure + '\t' + exp + '\t' + name + '\t' + value);
    }
    if (!lines.length) return '';
    const head = '# Netscape HTTP Cookie File\n# https://curl.haxx.se/rfc/cookie_spec.html\n# Saved by qd (qqqide)\n\n';
    return head + lines.join('\n') + '\n';
}

/** 纯函数：合并新旧 Netscape 文本（同 domain|path|name 新者胜；旧文件其它站点 cookies 保留）。 */
export function mergeNetscapeCookies(existingText: string | null, newText: string): string {
    const map = new Map<string, string>();
    const order: string[] = [];
    const eat = (text: string | null) => {
        for (const raw of String(text || '').split(/\r?\n/)) {
            let line = raw;
            if (!line || (line.charAt(0) === '#' && line.indexOf('#HttpOnly_') !== 0)) continue;
            let http = false;
            if (line.indexOf('#HttpOnly_') === 0) { http = true; line = line.slice(10); }
            const p = line.split('\t');
            if (p.length < 7) continue;
            const key = p[0] + '|' + p[2] + '|' + p[5];
            if (!map.has(key)) order.push(key);
            map.set(key, (http ? '#HttpOnly_' : '') + line);
        }
    };
    eat(existingText);
    eat(newText);
    const head = '# Netscape HTTP Cookie File\n# https://curl.haxx.se/rfc/cookie_spec.html\n# Merged by qd (qqqide)\n\n';
    return head + order.map((k) => map.get(k)).join('\n') + (order.length ? '\n' : '');
}

/** 打开 qd 内登录窗口（cookies 一键获取）。siteUrl = 触发风控的下载 URL（决定入口页）；已有窗口 → 置前。 */
export function openCookiesHarvest(siteUrl?: string | null): { ok: boolean; already?: boolean; error?: string } {
    try {
        if (_harvestWin && !_harvestWin.isDestroyed()) { _harvestWin.show(); _harvestWin.focus(); return { ok: true, already: true }; }
    } catch { /* ignore */ }
    let win: any;
    try {
        win = new BrowserWindow({
            width: 1080,
            height: 780,
            autoHideMenuBar: true,
            backgroundColor: '#1e1e1e',
            title: 'qd (qqqide) — cookies',
            webPreferences: { partition: HARVEST_PARTITION, backgroundThrottling: false },
        });
        try { if (win.setMenuBarVisibility) win.setMenuBarVisibility(false); } catch { /* ignore */ }
    } catch (e: any) { return { ok: false, error: String((e && e.message) || e) }; }
    _harvestWin = win;
    const wc = win.webContents;
    const entryUrl = siteRootOf(siteUrl);
    _hLog('open ' + entryUrl);
    try { wc.setUserAgent(UA_BROWSER); } catch { /* ignore */ }
    try {
        const ses = wc.session;
        ses.setPermissionRequestHandler((_w: any, _p: any, cb: any) => cb(false));
        ses.setPermissionCheckHandler(() => false);
        try { ses.setSpellCheckerEnabled(false); } catch { /* ignore */ }
        // ★ CN 网络防空转: google fonts 请求长期挂起 → 解析器阻塞 → 空白窗（详段首注释）。取消即可。
        try {
            ses.webRequest.onBeforeRequest(
                { urls: ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] },
                (_d: any, cb: any) => { try { cb({ cancel: true }); } catch { /* ignore */ } },
            );
        } catch { /* ignore */ }
    } catch { /* ignore */ }

    let closed = false;
    let saving = false;
    let reloads = 0;
    let waitedMs = 0;
    let bodySeen = false;
    let lastFail = '';

    const settle = (payload: any) => {
        if (closed) return;
        try { clearInterval(_harvestTimer); } catch { /* ignore */ }
        _harvestTimer = null;
        try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
        if (payload && payload.ok) {
            try {
                for (const w of BrowserWindow.getAllWindows()) {
                    try { if (!w.isDestroyed()) w.webContents.send('qqqide:paste-dl:cookies-saved', payload); } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
        }
    };

    /** 收集 + 合并 + 落盘当前会话 cookies（auto = 检出登录态自动触发；manual = 窗口内按钮）。 */
    const saveNow = async (why: 'auto' | 'manual') => {
        if (closed || saving) return false;
        saving = true;
        try {
            const all = await wc.session.cookies.get({});
            const list = Array.isArray(all) ? all : [];
            const text = serializeCookiesToNetscape(list);
            if (!text) { _hLog('save(' + why + ') no cookies'); return false; }
            const dir = path.join(getDataDir(), 'yt-dlp');
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, 'cookies.txt');
            let existing: string | null = null;
            try { existing = _findCookiesFile(''); } catch { existing = null; }
            let existingText: string | null = null;
            if (existing) { try { existingText = fs.readFileSync(existing, 'utf8'); } catch { existingText = null; } }
            const merged = mergeNetscapeCookies(existingText, text);
            const tmp = target + '.tmp';
            fs.writeFileSync(tmp, merged, 'utf8');
            fs.renameSync(tmp, target);
            _hLog('save(' + why + ') ok n=' + list.length + ' merged=' + !!existing);
            settle({ ok: true, path: target, merged: !!existing, manual: why === 'manual' });
            return true;
        } catch (e: any) {
            _hLog('save(' + why + ') FAIL ' + String((e && e.message) || e));
            return false;
        } finally { saving = false; }
    };

    try {
        wc.setWindowOpenHandler(({ url }: any) => {
            const t = String(url || '');
            if (t.indexOf('qqqide-cookies:') === 0) { void saveNow('manual'); return { action: 'deny' }; }
            try { if (/^https?:/i.test(t)) wc.loadURL(t); } catch { /* ignore */ }
            return { action: 'deny' };
        });
    } catch { /* ignore */ }
    try {
        // 全局 will-navigate 加固会把非应用源主帧导航甩到系统浏览器 → 本窗自建放行（仅 http/https）；
        // qqqide-cookies:save = 窗口内「保存」按钮伪协议 → 手动保存（不产生真实导航）。
        wc.removeAllListeners('will-navigate');
        wc.on('will-navigate', (e: any, target: string) => {
            const t = String(target || '');
            if (t.indexOf('qqqide-cookies:') === 0) { e.preventDefault(); void saveNow('manual'); return; }
            try {
                const proto = new URL(t).protocol;
                if (proto !== 'http:' && proto !== 'https:') e.preventDefault();
            } catch { e.preventDefault(); }
        });
    } catch { /* ignore */ }
    try {
        // 手动保存按钮第二路（console 标记；双路冗余防伪协议被 Chromium 早期拦截）
        wc.on('console-message', (_e: any, _level: number, message: string) => {
            if (String(message || '').indexOf(HARVEST_SAVE_MARK) >= 0) { void saveNow('manual'); }
        });
        wc.on('did-fail-load', (_e: any, code: number, desc: string, url: string, isMainFrame: boolean) => {
            if (!isMainFrame || code === -3) return;   // -3 = ERR_ABORTED（重载/跳转常态，忽略）
            lastFail = code + ':' + desc;
            _hLog('did-fail-load ' + lastFail + ' ' + String(url || '').slice(0, 140));
        });
        wc.on('render-process-gone', (_e: any, details: any) => {
            _hLog('render-process-gone ' + JSON.stringify(details || {}));
            if (!closed && reloads < HARVEST_MAX_RELOADS) {
                reloads++; waitedMs = 0; lastFail = '';
                try { wc.reload(); } catch { /* ignore */ }
            }
        });
        const inject = () => {
            if (closed) return;
            let label = '登录完成后点此保存 cookies';
            try { const s = mi('pasteDl.cookieBtn'); if (s && s !== 'pasteDl.cookieBtn') label = s; } catch { /* ignore */ }
            try { wc.executeJavaScript(cookieBtnScript(label), true).catch(() => { /* ignore */ }); } catch { /* ignore */ }
        };
        wc.on('dom-ready', inject);
        wc.on('did-finish-load', inject);
    } catch { /* ignore */ }

    const check = async () => {
        if (!_harvestWin || _harvestWin !== win || closed) return;
        try {
            const all = await wc.session.cookies.get({});
            const list = Array.isArray(all) ? all : [];
            const authed = list.some((c: any) => (c.name === 'SID' || c.name === 'LOGIN_INFO' || c.name === '__Secure-1PSID') && /(^|\.)youtube\.com$/i.test(String(c.domain || '')))
                || list.some((c: any) => c.name === 'SESSDATA' && /bilibili/i.test(String(c.domain || '')));
            if (authed) { await saveNow('auto'); return; }
        } catch { /* 轮询单次失败静默（窗口仍开着，2s 后重试） */ }
        // —— 加载看门狗: body 未出现（或渲染进程失联）→ 超时自动重载（≤2 次）；body 出现即停 ——
        if (bodySeen) return;
        waitedMs += HARVEST_TICK_MS;
        let st = 'no';
        try {
            const r: any = await Promise.race([
                wc.executeJavaScript('!!document.body', true),
                new Promise((res) => setTimeout(() => res('__hung'), 2500)),
            ]);
            st = (r === '__hung') ? 'hung' : (r ? 'yes' : 'no');
        } catch { st = 'no'; }
        if (st === 'yes') { bodySeen = true; _hLog('body ok at ' + Math.round(waitedMs / 1000) + 's'); return; }
        const limitMs = (st === 'hung') ? 15000 : 30000;
        if (waitedMs < limitMs && !(lastFail && waitedMs >= 10000)) return;
        if (reloads < HARVEST_MAX_RELOADS) {
            reloads++;
            _hLog('watchdog reload ' + reloads + '/' + HARVEST_MAX_RELOADS + ' state=' + st + ' waited=' + Math.round(waitedMs / 1000) + 's');
            waitedMs = 0; lastFail = '';
            try { wc.reload(); } catch { /* ignore */ }
        } else {
            _hLog('give-up blank state=' + st + ' reloads=' + reloads);
            bodySeen = true;   // 停止看门狗防循环；cookies 轮询继续（窗口内按钮仍可手动保存）
        }
    };
    _harvestTimer = setInterval(() => { void check(); }, HARVEST_TICK_MS);
    win.on('closed', () => {
        closed = true;
        try { clearInterval(_harvestTimer); } catch { /* ignore */ }
        _harvestTimer = null;
        if (_harvestWin === win) _harvestWin = null;
        _hLog('closed');
    });
    try { wc.loadURL(entryUrl); } catch { /* ignore */ }
    return { ok: true };
}

export interface PasteFetchTask {
    url: string;
    kind?: 'image' | 'video';
    destDir: string;
    referrer?: string;
    maxBytes?: number;
    tag?: string;
}

export interface PasteFetchResult {
    tag?: string;
    url: string;
    kind: string;
    ok: boolean;
    path?: string;
    name?: string;
    bytes?: number;
    sha256?: string;
    reused?: boolean;
    error?: string;
}

interface JobCtl {
    jobId: string;
    cancelled: boolean;
    reqs: Set<http.ClientRequest>;
    procs: Set<any>;
}

/** 抖音捕获结果（隐藏窗口 → detail 响应体解析） */
interface DouyinCaptureResult {
    ok: boolean;
    error?: string;
    mediaUrls?: string[];
    title?: string;
    awemeId?: string;
    fileName?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// MediaFetcher — 下载执行机
// ════════════════════════════════════════════════════════════════════════════

const MAX_TASKS_PER_JOB = 200;
const MAX_PAGE_BYTES = 6 * 1024 * 1024;        // 网页抓取上限（嗅探只读头部，超帽截断断开）
const CONCURRENCY = 3;
const PER_FILE_TIMEOUT_MS = 30 * 60 * 1000;   // 单文件总时长上限 30min
const IDLE_TIMEOUT_MS = 45 * 1000;            // 连接空闲 45s → 判死
const YTDLP_STALL_MS = 120 * 1000;            // yt-dlp 无输出 120s → 判死
const YTDLP_TIMEOUT_MS = 60 * 60 * 1000;      // yt-dlp 总时长上限 60min

export class MediaFetcher {
    constructor(private _root: string) { }

    private _jobs = new Map<string, JobCtl>();
    /** 抖音捕获串行链（同一时刻至多一个隐藏捕获窗——防并发多窗/验证码风暴） */
    private _dyCaptureChain: Promise<any> = Promise.resolve();

    cancel(jobId: string): boolean {
        const ctl = this._jobs.get(String(jobId));
        if (!ctl) return false;
        ctl.cancelled = true;
        for (const req of Array.from(ctl.reqs)) {
            try { req.destroy(new Error('cancelled')); } catch { /* ignore */ }
        }
        for (const proc of Array.from(ctl.procs)) {
            killTree(proc);
        }
        return true;
    }

    /**
     * 网页抓取（URL 粘贴 → 视频嗅探；老 q3 dow.js probeAndSelect 的 extractVideoUrlsFromWebPage 段）。
     * 重定向守卫同下载链 → 读入内存（≥MAX_PAGE_BYTES 截断）→ 智能解码（BOM/header/meta/启发式）。
     * 响应实为图片/视频（无扩展名直链）→ 不读 body，回报 directKind 交渲染层走下载机。
     * jobId 与下载共用 _jobs 表 → 现有 cancel(jobId) 可直接取消抓取。
     */
    async fetchPage(payload: any): Promise<any> {
        const jobId = String((payload && payload.jobId) || ('pf_' + Date.now().toString(36)));
        const url = String((payload && payload.url) || '');
        const levelRaw = Number(payload && payload.securityLevel);
        const security = resolveSecurityProfile(isFinite(levelRaw) ? levelRaw : 1);
        const base: any = { ok: false, url };
        if (!url) return { ...base, error: 'invalid_url' };
        let u: URL;
        try { u = new URL(url); } catch { return { ...base, error: 'invalid_url' }; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ...base, error: 'protocol_not_allowed' };
        if (security.enableUrlProtocolAndCredsGuard && (u.username || u.password)) return { ...base, error: 'url_credentials_not_allowed' };
        if (security.enableSSRFProtection) {
            const ss = await this._ssrfCheck(u);
            if (!ss.ok) return { ...base, error: ss.error };
        }

        const ctl: JobCtl = { jobId, cancelled: false, reqs: new Set(), procs: new Set() };
        this._jobs.set(jobId, ctl);
        try {
            const headers: Record<string, string> = {
                'user-agent': UA_BROWSER,
                'accept': 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
                'accept-encoding': 'gzip, deflate',
            };
            const r = await this._requestFollowing(url, headers, security, ctl, () => {});
            const res = r.res;
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) { res.resume(); return { ...base, error: 'http_' + status, status }; }

            const ctypeRaw = String((res.headers['content-type'] as any) || '');
            const ctype = ctypeRaw.split(';')[0].trim().toLowerCase();
            if (/^video\//.test(ctype)) { res.resume(); return { ok: true, url, finalUrl: r.finalUrl, directKind: 'video', mime: ctype }; }
            if (/^image\//.test(ctype)) { res.resume(); return { ok: true, url, finalUrl: r.finalUrl, directKind: 'image', mime: ctype }; }
            if (ctype && ctype !== 'text/html' && ctype !== 'application/xhtml+xml' && ctype !== 'text/plain' && ctype !== 'text/xml' && ctype !== 'application/xml') {
                res.resume();
                return { ...base, error: 'not_html', mime: ctype };
            }

            const capRaw = Number(payload && payload.maxBytes);
            const cap = isFinite(capRaw) && capRaw > 0 ? Math.min(capRaw, 32 * 1024 * 1024) : MAX_PAGE_BYTES;
            const got = await this._readToBuffer(res, cap, ctl);
            if (ctl.cancelled) return { ...base, error: 'cancelled' };
            if (!got.total) return { ...base, error: 'empty_file' };
            const dec = decodeHtmlBuffer(got.buf, ctypeRaw);
            return { ok: true, url, finalUrl: r.finalUrl, html: dec.text, charset: dec.charset, bytes: got.total, truncated: got.truncated, status };
        } catch (e: any) {
            if (ctl.cancelled) return { ...base, error: 'cancelled' };
            const msg = String((e && e.message) || e);
            return { ...base, error: msg === 'timeout' ? 'download_timeout' : msg };
        } finally {
            this._jobs.delete(jobId);
        }
    }

    /** 响应流 → 内存缓冲（解压 + 字节帽；超帽截断并断开连接） */
    private _readToBuffer(res: http.IncomingMessage, maxBytes: number, ctl: JobCtl): Promise<{ buf: Buffer; total: number; truncated: boolean }> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let total = 0;
            let truncated = false;
            let done = false;
            const finish = (err?: any) => {
                if (done) return;
                done = true;
                if (err) { reject(err); return; }
                resolve({ buf: Buffer.concat(chunks), total, truncated });
            };
            const enc = String((res.headers['content-encoding'] as any) || '').toLowerCase();
            let stream: any = res;
            if (enc.includes('br') && typeof (zlib as any).createBrotliDecompress === 'function') stream = res.pipe((zlib as any).createBrotliDecompress());
            else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
            else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
            stream.on('data', (c: Buffer) => {
                if (done) return;
                if (total + c.length > maxBytes) {
                    const keep = Math.max(0, maxBytes - total);
                    if (keep > 0) chunks.push(c.subarray(0, keep));
                    total += c.length;
                    truncated = true;
                    try { res.destroy(); } catch { /* ignore */ }
                    finish();
                    return;
                }
                chunks.push(c);
                total += c.length;
            });
            stream.on('end', () => finish());
            stream.on('error', (e: any) => finish(e));
        });
    }

    async run(payload: any, sender: any): Promise<any> {
        const jobId = String((payload && payload.jobId) || ('pp_' + Date.now().toString(36)));
        const tasks: PasteFetchTask[] = Array.isArray(payload && payload.tasks) ? payload.tasks.slice(0, MAX_TASKS_PER_JOB) : [];
        const levelRaw = Number(payload && payload.securityLevel);
        const security = resolveSecurityProfile(isFinite(levelRaw) ? levelRaw : 1);
        const overrides = payload && payload.securityOverrides;
        if (overrides && typeof overrides === 'object') {
            for (const k of Object.keys(overrides)) {
                if (k in security) (security as any)[k] = !!overrides[k];
            }
        }

        const ctl: JobCtl = { jobId, cancelled: false, reqs: new Set(), procs: new Set() };
        this._jobs.set(jobId, ctl);
        this._sweepStaleTemps(tasks);   // 会话残骸清扫（崩溃/强退中断留下的 .ppdl_*/.qlok——详方法注释）

        const total = tasks.length;
        let done = 0, ok = 0, fail = 0, bytes = 0;
        let lastEmit = 0;
        let curName = '', curPct = -1;

        const emit = (force?: boolean) => {
            const now = Date.now();
            if (!force && now - lastEmit < 120) return;
            lastEmit = now;
            try {
                if (sender && !sender.isDestroyed()) {
                    sender.send('qqqide:paste-dl:progress', { jobId, done, total, ok, fail, bytes, curName, curPct });
                }
            } catch { /* ignore */ }
        };

        const results: PasteFetchResult[] = new Array(tasks.length);
        const queue = tasks.map((t, i) => ({ t, i }));

        const worker = async () => {
            while (queue.length) {
                const item = queue.shift();
                if (!item) break;
                const task = item.t || ({} as PasteFetchTask);
                let r: PasteFetchResult;
                try {
                    r = await this._fetchOne(task, security, ctl, (n, name) => {
                        bytes += n;
                        curName = name || curName;
                        emit();
                    }, (pct) => { curPct = pct; emit(); });
                } catch (e: any) {
                    r = { url: String(task.url || ''), kind: String(task.kind || 'image'), ok: false, error: (ctl.cancelled ? 'cancelled' : String((e && e.message) || e)) };
                }
                r.tag = task.tag;
                results[item.i] = r;
                done++;
                if (r.ok) ok++; else fail++;
                curPct = -1;
                curName = r.name || curName;
                emit(true);
            }
        };

        try {
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, tasks.length || 1)) }, () => worker()));
        } finally {
            this._jobs.delete(jobId);   // 异常路径也收尸（防 _jobs 泄漏）
        }
        emit(true);
        return { ok: true, jobId, results, stats: { total, ok, fail, bytes, cancelled: ctl.cancelled } };
    }

    // ── 单任务分派 ──
    private async _fetchOne(
        task: PasteFetchTask,
        security: SecuritySwitches,
        ctl: JobCtl,
        onBytes: (n: number, name: string) => void,
        onPct: (pct: number) => void,
    ): Promise<PasteFetchResult> {
        const url = String((task && task.url) || '');
        const kind = task.kind === 'video' ? 'video' : 'image';
        const destDir = String((task && task.destDir) || '');
        const base: PasteFetchResult = { url, kind, ok: false };
        if (ctl.cancelled) return { ...base, error: 'cancelled' };
        if (!url) return { ...base, error: 'invalid_url' };
        if (/^blob:/i.test(url)) return { ...base, error: 'blob_url_unavailable' };
        if (!destDir) return { ...base, error: 'no_dest_dir' };

        let u: URL;
        try { u = new URL(url); } catch { return { ...base, error: 'invalid_url' }; }

        // ── switch 2: 协议 + 凭据 ──
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return { ...base, error: 'protocol_not_allowed' };
        }
        if (security.enableUrlProtocolAndCredsGuard && (u.username || u.password)) {
            return { ...base, error: 'url_credentials_not_allowed' };
        }

        // ── header 清洗（switch 6） ──
        const hdrRes = sanitizeHeaders({ 'user-agent': UA_BROWSER, 'accept': '*/*' }, security.enableHeaderSanitize && security.enableFailFast);
        if (!hdrRes.ok) return { ...base, error: hdrRes.error || 'invalid_header_name' };

        try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* ignore */ }
        if (!fs.existsSync(destDir)) return { ...base, error: 'no_dest_dir' };

        // ── switch 1: SSRF ──
        if (security.enableSSRFProtection) {
            const ss = await this._ssrfCheck(u);
            if (!ss.ok) return { ...base, error: ss.error };
        }

        // ── 分派: 抖音 → 浏览器同源捕获（yt-dlp 通不过其 detail API 风控，详捕获段注释）──
        if (kind === 'video' && isDouyinUrl(url)) {
            return await this._fetchViaDouyinCapture(url, kind, destDir, security, ctl, onBytes);
        }
        // ── 分派: 平台/分片视频 → yt-dlp；否则直连 ──
        if (kind === 'video' && isPlatformOrSegmentVideo(url)) {
            return await this._fetchViaYtdlp(url, kind, destDir, security, ctl, onPct);
        }
        return await this._fetchDirect(url, u, kind, destDir, String(task.referrer || ''), task.maxBytes, security, ctl, onBytes);
    }

    private async _ssrfCheck(u: URL): Promise<{ ok: boolean; error?: string }> {
        const host = u.hostname;
        if (isLocalHostname(host)) return { ok: false, error: 'ssrf_blocked_local_hostname' };
        if (net.isIP(host)) {
            return isNonPublicIp(host) ? { ok: false, error: 'ssrf_blocked_ip_literal' } : { ok: true };
        }
        try {
            const addrs = await dnsLookupAll(host, 3000);
            for (const a of addrs) {
                if (isNonPublicIp(a.address)) return { ok: false, error: 'ssrf_blocked_resolved_private_ip' };
            }
        } catch {
            return { ok: false, error: 'dns_failed' };
        }
        return { ok: true };
    }

    // ════ 直连 HTTP 下载（重试/反盗链/重定向守卫/字节帽/解压）════
    private async _fetchDirect(
        url: string,
        u: URL,
        kind: string,
        destDir: string,
        referrer: string,
        maxBytesRaw: any,
        security: SecuritySwitches,
        ctl: JobCtl,
        onBytes: (n: number, name: string) => void,
        overrideName?: string,
    ): Promise<PasteFetchResult> {
        const maxBytes = Math.max(0, Number(maxBytesRaw) || (kind === 'video' ? 5000 * 1048576 : 200 * 1048576));
        const base: PasteFetchResult = { url, kind, ok: false };
        const partName = '.ppdl_' + crypto.randomBytes(6).toString('hex') + '.part';
        const partPath = path.join(destDir, partName);

        // 目标展示名（显式覆盖名优先——抖音按作品标题命名；否则 URL 尾段，无扩展名时后续按 MIME 补）
        let desiredName = overrideName ? sanitizeFileName(overrideName) : baseNameFromUrl(u);

        let attempt = 0;
        let referrerBoost = false;
        let lastErr = '';
        const deadline = Date.now() + PER_FILE_TIMEOUT_MS;

        while (attempt < 4) {
            attempt++;
            if (ctl.cancelled) { cleanupPart(partPath); return { ...base, error: 'cancelled' }; }
            if (Date.now() > deadline) { cleanupPart(partPath); return { ...base, error: 'download_timeout' }; }

            let req: http.ClientRequest | null = null;
            try {
                const headers: Record<string, string> = { 'user-agent': UA_BROWSER, 'accept': '*/*' };
                let ref = String(referrer || '');
                if (referrerBoost && !ref) ref = u.origin + '/';
                if (ref) {
                    headers['referer'] = ref;
                    try { headers['origin'] = new URL(ref).origin; } catch { headers['origin'] = u.origin; }
                }

                const r = await this._requestFollowing(url, headers, security, ctl, (rq) => { req = rq; });
                const res = r.res;
                const status = res.statusCode || 0;

                // ── 反盗链增强重试（401/403/406 → 补 Referer/Origin 再试） ──
                if (isWorthAntiHotlinkRetry(status) && !referrerBoost) {
                    referrerBoost = true;
                    res.resume();
                    lastErr = 'http_' + status;
                    continue;
                }
                // ── 可重试状态（退避） ──
                if (isRetryableHttpStatus(status) && attempt < 4) {
                    const wait = computeBackoffMs(attempt, parseRetryAfterMs(res.headers['retry-after']));
                    res.resume();
                    lastErr = 'http_' + status;
                    await sleep(wait);
                    continue;
                }
                if (status < 200 || status >= 300) {
                    res.resume();
                    cleanupPart(partPath);
                    return { ...base, error: 'http_' + status };
                }

                // ── switch 8: 严格 Range（未发 Range 却回 206 → 拒收） ──
                if (security.enableStrictRangeChecks && status === 206) {
                    res.resume();
                    cleanupPart(partPath);
                    return { ...base, error: 'range_mismatch' };
                }

                // ── switch 7: content-length 预检 ──
                const clRaw = res.headers['content-length'];
                const cl = clRaw ? parseInt(String(Array.isArray(clRaw) ? clRaw[0] : clRaw), 10) : NaN;
                if (security.enableContentLengthRangePrecheck && isFinite(cl) && cl > 0 && maxBytes > 0 && cl > maxBytes) {
                    res.resume();
                    cleanupPart(partPath);
                    return { ...base, error: 'declared_too_large' };
                }

                // ── 图片拿到 text/* → 反盗链/登录墙页面（纠正性拒绝） ──
                const ctype = String((res.headers['content-type'] as any) || '').split(';')[0].trim().toLowerCase();
                if (kind === 'image' && ctype.indexOf('text/') === 0) {
                    res.resume();
                    cleanupPart(partPath);
                    return { ...base, error: 'not_an_image' };
                }
                if (kind === 'image' && security.enableFailFast && ctype && ctype.indexOf('image/') !== 0 && ctype !== 'application/octet-stream' && ctype !== 'binary/octet-stream') {
                    res.resume();
                    cleanupPart(partPath);
                    return { ...base, error: 'not_an_image' };
                }

                // ── 补扩展名（无扩展名 → 按 MIME 补；已有扩展名原样保留） ──
                if (!/\.[a-z0-9]{1,6}$/i.test(desiredName)) {
                    desiredName = (desiredName || ('paste_' + Date.now().toString(36))) + extFromMime(ctype, kind);
                }

                // ── 流式写盘（解压 → 限流/计数/哈希 → 文件） ──
                const n = await this._streamToFile(res, partPath, maxBytes, ctl, onBytes, desiredName);
                if (ctl.cancelled) { cleanupPart(partPath); return { ...base, error: 'cancelled' }; }

                // ── 视频魔数校验（下载完整性） ──
                if (kind === 'video') {
                    const head = readHeadBytes(partPath, 64);
                    if (!sniffVideoMagic(head)) {
                        cleanupPart(partPath);
                        return { ...base, error: 'invalid_media' };
                    }
                }

                // ── 收尾: 指纹去重 → 唯一命名 → 锁 → 落盘 ──
                return await this._finalizeFile(partPath, destDir, desiredName, kind, n.sha256, security, ctl, url);
            } catch (e: any) {
                if (ctl.cancelled) { cleanupPart(partPath); return { ...base, error: 'cancelled' }; }
                if (req) { try { (req as any).destroy(); } catch { /* ignore */ } }
                const msg = String((e && e.message) || e);
                if (msg === 'file_too_large') { cleanupPart(partPath); return { ...base, error: 'file_too_large' }; }
                if (isRetryableNetworkError(e) && attempt < 4) {
                    lastErr = msg;
                    await sleep(computeBackoffMs(attempt));
                    continue;
                }
                cleanupPart(partPath);
                return { ...base, error: msg === 'download_timeout' ? 'download_timeout' : (lastErr || msg || 'network_error') };
            }
        }
        cleanupPart(partPath);
        return { ...base, error: lastErr || 'too_many_attempts' };
    }

    /** 跟随重定向请求（switch 3 协议守卫；最大 6 跳）；返回最终 2xx/非重定向响应 */
    private _requestFollowing(
        url: string,
        headers: Record<string, string>,
        security: SecuritySwitches,
        ctl: JobCtl,
        onReq: (req: http.ClientRequest) => void,
        hops = 0,
    ): Promise<{ res: http.IncomingMessage; finalUrl: string }> {
        return new Promise((resolve, reject) => {
            if (ctl.cancelled) { reject(new Error('cancelled')); return; }
            if (hops > 6) { reject(new Error('too_many_redirects')); return; }
            let u: URL;
            try { u = new URL(url); } catch { reject(new Error('invalid_url')); return; }
            const lib = u.protocol === 'https:' ? https : http;
            const req = lib.request({
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: (u.pathname || '/') + (u.search || ''),
                method: 'GET',
                headers,
                timeout: 20000,
            }, (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    const loc = String(Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location);
                    res.resume();
                    let nextUrl = '';
                    try { nextUrl = new URL(loc, url).href; } catch { reject(new Error('bad_redirect')); return; }
                    try {
                        const nu = new URL(nextUrl);
                        if (security.enableRedirectProtocolGuard && nu.protocol !== 'http:' && nu.protocol !== 'https:') {
                            reject(new Error('redirect_protocol_blocked'));
                            return;
                        }
                        if (security.enableSSRFProtection) {
                            // 重定向目标重检 SSRF（内网跳转封堵）
                            this._ssrfCheck(nu).then((ss) => {
                                if (!ss.ok) { reject(new Error(ss.error || 'ssrf_blocked')); return; }
                                this._requestFollowing(nextUrl, headers, security, ctl, onReq, hops + 1).then(resolve, reject);
                            }, reject);
                            return;
                        }
                    } catch { /* fall through */ }
                    this._requestFollowing(nextUrl, headers, security, ctl, onReq, hops + 1).then(resolve, reject);
                    return;
                }
                resolve({ res, finalUrl: url });
            });
            ctl.reqs.add(req);
            onReq(req);
            req.on('timeout', () => { try { req.destroy(new Error('download_timeout')); } catch { /* ignore */ } });
            req.on('error', (err) => { ctl.reqs.delete(req); reject(err); });
            req.on('close', () => { ctl.reqs.delete(req); });
            req.end();
        });
    }

    /** 响应流 → 解压 → 限流/计数/哈希 → .part 文件；返回 { bytes, sha256 } */
    private _streamToFile(
        res: http.IncomingMessage,
        partPath: string,
        maxBytes: number,
        ctl: JobCtl,
        onBytes: (n: number, name: string) => void,
        name: string,
    ): Promise<{ bytes: number; sha256: string }> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            let total = 0;
            const ws = fs.createWriteStream(partPath, { flags: 'w' });
            const limiter = new Transform({
                transform(chunk: Buffer, _enc: any, cb: any) {
                    total += chunk.length;
                    if (maxBytes > 0 && total > maxBytes) { cb(new Error('file_too_large')); return; }
                    hash.update(chunk);
                    onBytes(chunk.length, name);
                    cb(null, chunk);
                },
            });
            const enc = String((res.headers['content-encoding'] as any) || '').toLowerCase();
            let dec: any = null;
            if (enc.includes('br') && typeof (zlib as any).createBrotliDecompress === 'function') dec = (zlib as any).createBrotliDecompress();
            else if (enc.includes('gzip')) dec = zlib.createGunzip();
            else if (enc.includes('deflate')) dec = zlib.createInflate();

            const stages: any[] = [res];
            if (dec) stages.push(dec);
            stages.push(limiter, ws);

            pipelineP(...stages).then(() => {
                if (total <= 0) { reject(new Error('empty_file')); return; }
                resolve({ bytes: total, sha256: hash.digest('hex') });
            }).catch((e: any) => {
                reject(e);
            });
        });
    }

    /** 收尾: 指纹去重（同目录同尺寸候选比对）→ 唯一命名 → 锁（switch 5）→ symlink 守卫（switch 9）→ rename 落盘 */
    private async _finalizeFile(
        partPath: string,
        destDir: string,
        desiredName: string,
        kind: string,
        sha256: string,
        security: SecuritySwitches,
        ctl: JobCtl,
        srcUrl?: string,
    ): Promise<PasteFetchResult> {
        const base: PasteFetchResult = { url: String(srcUrl || ''), kind, ok: false };
        let size = 0;
        try { size = fs.statSync(partPath).size; } catch { /* ignore */ }
        if (!size) { cleanupPart(partPath); return { ...base, error: 'empty_file' }; }

        const fp = fingerprintFile(partPath);

        // ── 去重扫描（同目录；只比对同尺寸候选） ──
        const dup = this._dedupScan(destDir, partPath, size, fp);
        if (dup) {
            cleanupPart(partPath);
            return { url: String(srcUrl || ''), kind, ok: true, path: dup.path, name: dup.name, bytes: size, sha256, reused: true };
        }

        // ── 唯一命名（公共约定 6: name_1.ext） ──
        let finalName = sanitizeFileName(desiredName) || ('paste_' + Date.now().toString(36) + (kind === 'video' ? '.mp4' : '.png'));
        const dot = finalName.lastIndexOf('.');
        const stem = dot > 0 ? finalName.slice(0, dot) : finalName;
        const ext = dot > 0 ? finalName.slice(dot) : '';
        let finalPath = path.join(destDir, finalName);
        let n = 0;
        while (fs.existsSync(finalPath) && n < 999) {
            n++;
            finalName = stem + '_' + n + ext;
            finalPath = path.join(destDir, finalName);
        }

        // ── switch 4: baseDir 越界防护 ──
        if (security.enableBaseDirGuard && !isPathInsideBaseDir(finalPath, destDir)) {
            cleanupPart(partPath);
            return { ...base, error: 'path_traversal_blocked' };
        }

        // ── switch 9: 符号链接防护 ──
        if (security.enableSymlinkGuard) {
            const sg = ensureNotSymlink(finalPath, true);
            if (!sg.ok) { cleanupPart(partPath); return { ...base, error: sg.error }; }
        }

        // ── switch 5: 下载锁 ──
        let lock: { ok: boolean; error?: string; release?: () => void } = { ok: true };
        if (security.enableDownloadLock) {
            lock = await acquireDownloadQlok(finalPath, ctl);
            if (!lock.ok) { cleanupPart(partPath); return { ...base, error: lock.error || 'dest_locked' }; }
        }

        try {
            if (ctl.cancelled) { cleanupPart(partPath); return { ...base, error: 'cancelled' }; }
            // ★ 加锁后重查唯一名（双检防覆盖）：并发同名任务（同页两个 image.png）在锁外各自
            //   existsSync 都取到同一候选名，若不重查，后者 rename/copy 会静默覆盖前者 = 内容丢失。
            if (security.enableDownloadLock) {
                let n2 = n;
                while (fs.existsSync(finalPath) && n2 < 999) { n2++; finalName = stem + '_' + n2 + ext; finalPath = path.join(destDir, finalName); }
                if (security.enableSymlinkGuard) {
                    const sg2 = ensureNotSymlink(finalPath, true);
                    if (!sg2.ok) { cleanupPart(partPath); return { ...base, error: sg2.error }; }
                }
            }
            let renamed = false;
            for (let i = 0; i < 3 && !renamed; i++) {
                try { fs.renameSync(partPath, finalPath); renamed = true; }
                catch { await sleep(120 * (i + 1)); }
            }
            if (!renamed) {
                // rename 失败降级：复制替换（绝不先删目标；目标此时不存在）
                try {
                    fs.copyFileSync(partPath, finalPath);
                    cleanupPart(partPath);
                    renamed = true;
                } catch { /* ignore */ }
            }
            if (!renamed) { cleanupPart(partPath); return { ...base, error: 'write_failed' }; }
            return { url: String(srcUrl || ''), kind, ok: true, path: finalPath, name: finalName, bytes: size, sha256, reused: false };
        } finally {
            if (lock.release) lock.release();
        }
    }

    /** 同目录去重扫描（size + 指纹比对；命中返回既有文件） */
    private _dedupScan(destDir: string, excludePath: string, size: number, fp: string): { path: string; name: string } | null {
        if (!fp) return null;
        try {
            const entries = fs.readdirSync(destDir, { withFileTypes: true });
            let checked = 0;
            for (const ent of entries) {
                if (checked >= 2000) break;
                if (!ent.isFile()) continue;
                const nm = ent.name;
                if (/^\.ppdl_/.test(nm) || /\.part$/i.test(nm) || /\.qlok$/i.test(nm) || /\.(tmp|crdownload)$/i.test(nm)) continue;
                const cand = path.join(destDir, nm);
                if (cand === excludePath) continue;
                checked++;
                let st: fs.Stats;
                try { st = fs.statSync(cand); } catch { continue; }
                if (st.size !== size) continue;
                const cfp = fingerprintFile(cand);
                if (cfp && cfp === fp) return { path: cand, name: nm };
            }
        } catch { /* ignore */ }
        return null;
    }

    /**
     * 会话残骸清扫：崩溃/强退/断电中断的下载留下的 `.ppdl_*`（.part / yt-dlp 前缀件）与 `*.qlok`
     * 锁遗留——超过 10 分钟未更新的视为死物删除（活跃下载持续写入 mtime 恒新：直连静默 20s 即判死、
     * yt-dlp 停走 120s 判死——阈值对多实例并存安全；目录残骸永不积累）。
     */
    private _sweepStaleTemps(tasks: PasteFetchTask[]): void {
        const dirs = new Set<string>();
        for (const t of tasks) {
            const d = String((t && t.destDir) || '');
            if (d) dirs.add(d);
        }
        if (!dirs.size) return;
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const dir of dirs) {
            let entries: string[] = [];
            try { entries = fs.readdirSync(dir); } catch { continue; }
            for (const nm of entries) {
                if (!/^\.ppdl_/.test(nm) && !/\.qlok$/i.test(nm)) continue;
                const fp = path.join(dir, nm);
                try {
                    const st = fs.statSync(fp);
                    if (st.isFile() && st.mtimeMs < cutoff) {
                        try { fs.unlinkSync(fp); } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
        }
    }

    // ════ 抖音捕获下载（隐藏窗口 + CDP） ════
    private async _fetchViaDouyinCapture(
        url: string,
        kind: string,
        destDir: string,
        security: SecuritySwitches,
        ctl: JobCtl,
        onBytes: (n: number, name: string) => void,
    ): Promise<PasteFetchResult> {
        const base: PasteFetchResult = { url, kind, ok: false };
        let cap: DouyinCaptureResult;
        try {
            const run = this._dyCaptureChain.then(
                () => this._captureDouyin(url, ctl),
                () => this._captureDouyin(url, ctl),
            );
            this._dyCaptureChain = run.then(() => undefined, () => undefined);
            cap = await run;
        } catch {
            cap = { ok: false, error: 'douyin_capture_failed' };
        }
        if (ctl.cancelled) return { ...base, error: 'cancelled' };
        if (!cap.ok || !cap.mediaUrls || !cap.mediaUrls.length) {
            return { ...base, error: (cap && cap.error) || 'douyin_extract_failed' };
        }
        const fileName = String(cap.fileName || 'douyin.mp4');
        let lastErr = '';
        // 多镜像依次尝试（detail JSON 自带 2~3 个 CDN 镜像）——首个失败才轮到下一个
        for (const mu of cap.mediaUrls.slice(0, 3)) {
            if (ctl.cancelled) return { ...base, error: 'cancelled' };
            let u: URL;
            try { u = new URL(mu); } catch { continue; }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
            if (security.enableSSRFProtection) {
                const ss = await this._ssrfCheck(u);
                if (!ss.ok) { lastErr = ss.error || 'ssrf_blocked'; continue; }
            }
            const r = await this._fetchDirect(mu, u, 'video', destDir, 'https://www.douyin.com/', undefined, security, ctl, onBytes, fileName);
            if (r.ok) return { ...r, url };   // 报告用 url = 原始抖音链接（非 CDN 直链）
            lastErr = r.error || lastErr;
        }
        return { ...base, error: lastErr || 'douyin_download_failed' };
    }

    /**
     * 隐藏窗口载入抖音视频页 → CDP 抓取页面自身发出的 /aweme/v1/web/aweme/detail/ 响应体
     * （带页面现算的 a_bogus 签名与全套 cookie）→ 解析最高码率档直链 + 标题名。
     * 兜底：硬超时前用 performance 资源表扫 douyinvod 直链（画质=页面自适应档）。
     * 任何窗口路径异常 → 结构化错误码（渲染层本地化）。
     */
    private _captureDouyin(rawUrl: string, ctl: JobCtl): Promise<DouyinCaptureResult> {
        const norm = douyinPageUrl(rawUrl);
        if (!norm.ok) return Promise.resolve({ ok: false, error: 'douyin_need_link' });
        return new Promise((resolve) => {
            let done = false;
            let win: any = null;
            let hardTimer: any = null;
            let reloadTimer: any = null;
            let cancelPoll: any = null;
            let navCount = 0;
            let netReady = false;
            let captured = false;
            const pending = new Map<string, string>();

            const finish = (r: DouyinCaptureResult) => {
                if (done) return; done = true;
                try { clearTimeout(hardTimer); clearTimeout(reloadTimer); clearInterval(cancelPoll); } catch { /* ignore */ }
                try {
                    if (win && !win.isDestroyed()) {
                        try { win.webContents.debugger.detach(); } catch { /* ignore */ }
                        win.destroy();
                    }
                } catch { /* ignore */ }
                resolve(r);
            };

            const parseDetail = (body: string): DouyinCaptureResult & { error?: string } => {
                try {
                    const obj = JSON.parse(body);
                    const ad = obj && obj.aweme_detail;
                    if (!ad) return { ok: false, error: 'douyin_extract_failed' };
                    if (norm.videoId && ad.aweme_id && String(ad.aweme_id) !== norm.videoId) return { ok: false, error: '__stale__' };
                    const v = ad.video || {};
                    let best: { br: number; urls: string[] } | null = null;
                    for (const g of (Array.isArray(v.bit_rate) ? v.bit_rate : [])) {
                        const urls = ((((g || {}).play_addr || {}).url_list) || []).filter((x: any) => /^https?:/.test(String(x))).map(String);
                        if (!urls.length) continue;
                        const br = Number((g || {}).bit_rate) || 0;
                        if (!best || br > best.br) best = { br, urls };
                    }
                    if (!best) {
                        const urls = (((v.play_addr || {}).url_list) || []).filter((x: any) => /^https?:/.test(String(x))).map(String);
                        if (urls.length) best = { br: 0, urls };
                    }
                    if (!best) {
                        if (Array.isArray(ad.images) && ad.images.length) return { ok: false, error: 'douyin_image_post' };
                        return { ok: false, error: 'douyin_extract_failed' };
                    }
                    const title = String(ad.desc || '').replace(/\s+/g, ' ').trim();
                    let stem = sanitizeFileName(title).replace(/[. ]+$/, '');
                    if (!stem) stem = 'douyin_' + String(ad.aweme_id || Date.now().toString(36));
                    return { ok: true, mediaUrls: best.urls, title, awemeId: String(ad.aweme_id || ''), fileName: stem.slice(0, 80) + '.mp4' };
                } catch { return { ok: false, error: 'douyin_extract_failed' }; }
            };

            try {
                win = new BrowserWindow({
                    show: false,
                    width: 1200,
                    height: 800,
                    webPreferences: {
                        partition: 'persist:qqq-paste-douyin',   // 暖 cookie 复用（更快、更少验证码）
                        backgroundThrottling: false,             // 隐藏页全速跑页面 JS（签名计算/拉流）
                    },
                });
            } catch { resolve({ ok: false, error: 'douyin_capture_failed' }); return; }

            const wc = win.webContents;
            // 弹窗全拒（登录/分享弹层不得外开系统浏览器）
            try { wc.setWindowOpenHandler(() => ({ action: 'deny' })); } catch { /* ignore */ }
            try { wc.setUserAgent(UA_BROWSER); } catch { /* ignore */ }
            try { wc.setAudioMuted(true); } catch { /* ignore */ }
            // ★ 全局 will-navigate 加固（shutdown.hardenWebContents）对本窗不适用：它会把非应用源的
            //   主帧导航重定向到系统浏览器。本窗撤除全局监听、自建白名单版（仅放行字节系域；其余静默拦住）。
            try {
                wc.removeAllListeners('will-navigate');
                wc.on('will-navigate', (e: any, target: string) => {
                    try {
                        const h = new URL(String(target)).hostname.toLowerCase();
                        const okHost = h === 'douyin.com' || h.endsWith('.douyin.com') || h.endsWith('.iesdouyin.com') || h.endsWith('.bytedance.com') || h.endsWith('.douyinvod.com');
                        if (!okHost) e.preventDefault();
                    } catch { e.preventDefault(); }
                });
            } catch { /* ignore */ }

            try { wc.debugger.attach('1.3'); } catch { /* 已附加/不可用 → 超时兜底 */ }
            wc.debugger.on('message', async (_ev: any, method: string, params: any) => {
                try {
                    if (method === 'Network.responseReceived') {
                        const du = (params && params.response && params.response.url) || '';
                        if (du.indexOf('/aweme/v1/web/aweme/detail/') >= 0) pending.set(params.requestId, du);
                    } else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
                        const rid = params.requestId;
                        pending.delete(rid);
                        const r = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: rid });
                        let body = r && r.body ? String(r.body) : '';
                        if (r && r.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
                        const parsed = parseDetail(body);
                        if (parsed.error === '__stale__') return;   // 非目标视频 → 继续等
                        captured = true;
                        finish(parsed);
                    }
                } catch { /* ignore */ }
            });

            wc.on('dom-ready', async () => {
                if (!netReady) {
                    netReady = true;
                    // Network.enable 在无导航时挂起（Electron 22 实测）→ dom-ready 后再开
                    try {
                        await Promise.race([
                            wc.debugger.sendCommand('Network.enable'),
                            new Promise((r2) => setTimeout(r2, 6000)),
                        ]);
                    } catch { /* ignore */ }
                }
                // 保险：本次导航 4.5s 内未捕获 → 重载（Network 域已开，重载必捕获）；至多 2 次
                try { clearTimeout(reloadTimer); } catch { /* ignore */ }
                reloadTimer = setTimeout(() => {
                    if (!captured && !done && navCount < 2) {
                        navCount++;
                        try { wc.reload(); } catch { /* ignore */ }
                    }
                }, 4500);
            });

            cancelPoll = setInterval(() => { if (ctl.cancelled && !done) finish({ ok: false, error: 'cancelled' }); }, 400);
            hardTimer = setTimeout(async () => {
                if (done) return;
                // 兜底 A：performance 资源表扫 douyinvod 直链（画质=页面自适应档）
                try {
                    const res = await wc.executeJavaScript(`(function(){
                        try {
                            var rs = performance.getEntriesByType('resource').map(function(e){ return e.name; });
                            var m = rs.filter(function(u){ return u.indexOf('douyinvod') >= 0; });
                            var t = document.title || '';
                            return JSON.stringify({ m: m.slice(0, 4), t: t });
                        } catch (e) { return ''; }
                    })()`);
                    const info = res ? JSON.parse(String(res)) : null;
                    if (info && info.m && info.m.length) {
                        let stem = sanitizeFileName(String(info.t || '').replace(/\s*[-–—]\s*抖音\s*$/, '')).replace(/[. ]+$/, '');
                        if (!stem) stem = 'douyin_' + (norm.videoId || Date.now().toString(36));
                        finish({ ok: true, mediaUrls: info.m, fileName: stem.slice(0, 80) + '.mp4' });
                        return;
                    }
                } catch { /* ignore */ }
                if (!done) finish({ ok: false, error: 'douyin_capture_timeout' });
            }, 30000);

            wc.loadURL(norm.pageUrl).catch(() => { /* 载入失败 → 硬超时兜底 */ });
        });
    }

    // ════ yt-dlp 平台/分片视频下载 ════
    private async _fetchViaYtdlp(
        url: string,
        kind: string,
        destDir: string,
        security: SecuritySwitches,
        ctl: JobCtl,
        onPct: (pct: number) => void,
    ): Promise<PasteFetchResult> {
        const base: PasteFetchResult = { url, kind, ok: false };
        const bin = getComponentBin(this._root, 'yt-dlp');
        if (!bin) return { ...base, error: 'yt-dlp_not_installed' };
        const ffmpeg = getComponentBin(this._root, 'ffmpeg');

        const prefix = '.ppdl_ytdl_' + crypto.randomBytes(5).toString('hex');
        const outTpl = path.join(destDir, prefix + '.%(ext)s');
        const args = [
            url,
            '-o', outTpl,
            '--no-playlist',
            '--no-warnings',
            '--no-update',
            '--newline',
            '-f', 'bestvideo*+bestaudio/best',
            '--merge-output-format', 'mp4',
        ];
        if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));
        // JS 运行时（YouTube 等站点 EJS 挑战；来源 = quickjs 组件 或 与 yt-dlp 同目录的 qjs.exe）
        const jsRt = this._resolveJsRuntime(bin);
        if (jsRt) args.push('--js-runtimes', jsRt);
        // cookies 约定文件（风控站点自救通道 — 详铁律 §4.17）：落点双目录 {Data}/yt-dlp（持久保险库，
        // 随包更新不灭 · 推荐）→ yt-dlp 组件目录（兼容）；命名宽松：精确 cookies.txt 优先，否则「文件名
        // 含 cookies 的 .txt」取最新（扩展导出名无需改名）；空文件视为不存在；每次调用即时扫描零重启。
        // ★ 临时副本喂给 yt-dlp —— `--cookies` 含「dump cookie jar back into the file」语义：风控下发的
        //   Set-Cookie 作废指令会回写；直传用户文件 = 三连运行把 22 条登录 cookies 减血至 12 条残骸（实测事故）。
        //   副本名带任务前缀 → 随 _cleanupYtdlpOutputs / 残留清理一并删除；用户文件永远只读。
        try {
            const ck = _findCookiesFile(path.dirname(bin));
            if (ck) {
                try {
                    const ckTemp = path.join(destDir, prefix + '.cookies.txt');
                    fs.copyFileSync(ck, ckTemp);
                    args.push('--cookies', ckTemp);
                } catch { /* 副本失败 → 不带 cookies（不冒险直传用户文件） */ }
            }
        } catch { /* ignore */ }

        const outLimit = security.enableProbeOutputLimit ? 2 * 1024 * 1024 : 64 * 1024 * 1024;

        const exitInfo = await new Promise<{ code: number | null; tail: string; reason?: string }>((resolve) => {
            let outBytes = 0;
            let tail = '';
            let killed = false;
            let stallTimer: any = null;
            let hardTimer: any = null;

            const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            ctl.procs.add(child);

            const finish = (code: number | null, reason?: string) => {
                if (killed) return;
                killed = true;
                clearTimeout(stallTimer);
                clearTimeout(hardTimer);
                ctl.procs.delete(child);
                try { killTree(child); } catch { /* ignore */ }
                resolve({ code, tail, reason });
            };

            const resetStall = () => {
                clearTimeout(stallTimer);
                stallTimer = setTimeout(() => finish(null, 'download_stalled'), YTDLP_STALL_MS);
            };
            hardTimer = setTimeout(() => finish(null, 'download_timeout'), YTDLP_TIMEOUT_MS);
            resetStall();

            const onData = (buf: Buffer) => {
                resetStall();
                outBytes += buf.length;
                if (outBytes > outLimit) { finish(null, 'probe_output_too_large'); return; }
                const s = buf.toString('utf8');
                tail = (tail + s).slice(-600);
                const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(s);
                if (m) {
                    const pct = parseFloat(m[1]);
                    if (isFinite(pct)) onPct(pct);
                }
            };
            child.stdout?.on('data', onData);
            child.stderr?.on('data', onData);
            child.on('error', (e: any) => finish(null, 'ytdlp_spawn_failed: ' + String(e && e.message || e)));
            child.on('close', (code: number | null) => {
                if (!killed) {
                    clearTimeout(stallTimer);
                    clearTimeout(hardTimer);
                    ctl.procs.delete(child);
                    resolve({ code, tail });
                }
            });
        });

        if (ctl.cancelled || exitInfo.reason === 'cancelled') {
            this._cleanupYtdlpOutputs(destDir, prefix);
            return { ...base, error: 'cancelled' };
        }
        if (exitInfo.reason) {
            this._cleanupYtdlpOutputs(destDir, prefix);
            return { ...base, error: exitInfo.reason };
        }
        if (exitInfo.code !== 0) {
            this._cleanupYtdlpOutputs(destDir, prefix);
            const tl = String(exitInfo.tail || '');
            if (/not a bot|Sign in to confirm/i.test(tl)) return { ...base, error: 'ytdlp_bot_wall' };
            return { ...base, error: 'ytdlp_failed' };
        }

        // 找产物（可能合并后 .mp4，也可能原格式单文件）
        let produced: string | null = null;
        let producedSize = -1;
        try {
            const entries = fs.readdirSync(destDir);
            for (const nm of entries) {
                if (nm.indexOf(prefix) !== 0) continue;
                const fp = path.join(destDir, nm);
                try {
                    const st = fs.statSync(fp);
                    if (st.isFile() && st.size > producedSize) { produced = fp; producedSize = st.size; }
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
        if (!produced || producedSize <= 0) {
            this._cleanupYtdlpOutputs(destDir, prefix);
            return { ...base, error: 'ytdlp_output_missing' };
        }

        // 视频魔数校验
        const head = readHeadBytes(produced, 64);
        if (!sniffVideoMagic(head)) {
            try { fs.unlinkSync(produced); } catch { /* ignore */ }
            return { ...base, error: 'invalid_media' };
        }

        // sha256（对产物整文件；yt-dlp 产物无法流式复用）
        let sha256 = '';
        try {
            sha256 = await hashFileAsync(produced);
        } catch { /* keep empty */ }

        const extMatch = /\.[a-z0-9]{1,6}$/i.exec(produced);
        const desiredName = platformVideoName(url) + (extMatch ? extMatch[0] : '.mp4');

        // 其余同前缀残留文件清理（如分离音轨）
        try {
            const entries = fs.readdirSync(destDir);
            for (const nm of entries) {
                if (nm.indexOf(prefix) !== 0) continue;
                const fp = path.join(destDir, nm);
                if (fp === produced) continue;
                try { fs.unlinkSync(fp); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }

        // 收尾走统一 finalize（把产物当 part 处理）
        const fin = await this._finalizeFile(produced, destDir, desiredName, kind, sha256, security, ctl, url);
        if (!fin.ok && !fin.path) {
            try { fs.unlinkSync(produced); } catch { /* ignore */ }
        }
        return fin;
    }

    // JS 运行时解析（qjs 自编译组件优先；与 yt-dlp 同目录兜底；缺失 → 不传参由 yt-dlp 自行降级）
    private _resolveJsRuntime(ytdlpBin: string): string | null {
        try {
            const qjs = getComponentBin(this._root, 'quickjs');
            if (qjs && fs.existsSync(qjs)) return 'quickjs:' + qjs;
        } catch { /* ignore */ }
        try {
            const side = path.join(path.dirname(ytdlpBin), 'qjs.exe');
            if (fs.existsSync(side)) return 'quickjs:' + side;
        } catch { /* ignore */ }
        return null;
    }

    private _cleanupYtdlpOutputs(destDir: string, prefix: string): void {
        try {
            const entries = fs.readdirSync(destDir);
            for (const nm of entries) {
                if (nm.indexOf(prefix) !== 0) continue;
                try { fs.unlinkSync(path.join(destDir, nm)); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════

function cleanupPart(partPath: string): void {
    try { fs.unlinkSync(partPath); } catch { /* ignore */ }
}

function killTree(proc: any): void {
    try {
        if (!proc || !proc.pid) return;
        if (process.platform === 'win32') {
            try {
                spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            } catch { /* ignore */ }
        } else {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

function hashFileAsync(fp: string): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            const h = crypto.createHash('sha256');
            const rs = fs.createReadStream(fp);
            rs.on('data', (c) => h.update(c));
            rs.on('end', () => resolve(h.digest('hex')));
            rs.on('error', reject);
        } catch (e) { reject(e); }
    });
}

// ════════════════════════════════════════════════════════════════════════════
// IPC 注册（main.ts registerAllIpc 调用）
// ════════════════════════════════════════════════════════════════════════════

export function registerPasteFetchIpc(portableRoot: string): void {
    const fetcher = new MediaFetcher(portableRoot);
    ipcMain.handle('qqqide:paste-dl:fetch', async (e, payload: any) => {
        try {
            return await fetcher.run(payload, e.sender);
        } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err), results: [] };
        }
    });
    ipcMain.handle('qqqide:paste-dl:cancel', (_e, jobId: string) => {
        try { return fetcher.cancel(String(jobId || '')); } catch { return false; }
    });
    // 网页抓取（URL 粘贴 → 视频嗅探；与下载共用 jobId 取消表）
    ipcMain.handle('qqqide:paste-dl:fetch-page', async (_e, payload: any) => {
        try { return await fetcher.fetchPage(payload); } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });
    // cookies 文件夹（风控自救「打开 cookies 文件夹」按钮入口）——确保目录存在 + 落双语使用说明；
    // 返回目录给渲染层走既有 shell.openPath 通道打开（win32 = cmd 短命 relay，外部窗口不进统计圈）。
    ipcMain.handle('qqqide:paste-dl:cookies-dir', async () => {
        try {
            const dir = path.join(getDataDir(), 'yt-dlp');
            fs.mkdirSync(dir, { recursive: true });
            try {
                const rd = path.join(dir, COOKIES_README_NAME);
                if (!fs.existsSync(rd)) fs.writeFileSync(rd, COOKIES_README_TEXT, 'utf8');
            } catch { /* ignore */ }
            return { ok: true, dir };
        } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });
    // cookies 一键获取（「在 qd 内登录」按钮入口）：打开真实浏览器窗口 → 登录 → 自动保存 → 广播 cookies-saved
    ipcMain.handle('qqqide:paste-dl:cookie-login', async (_e, payload: any) => {
        try { return openCookiesHarvest(payload && payload.siteUrl); } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });
}
