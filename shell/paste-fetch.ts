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

import { ipcMain } from 'electron';
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
// 任务接口
// ════════════════════════════════════════════════════════════════════════════

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
    ): Promise<PasteFetchResult> {
        const maxBytes = Math.max(0, Number(maxBytesRaw) || (kind === 'video' ? 5000 * 1048576 : 200 * 1048576));
        const base: PasteFetchResult = { url, kind, ok: false };
        const partName = '.ppdl_' + crypto.randomBytes(6).toString('hex') + '.part';
        const partPath = path.join(destDir, partName);

        // 目标展示名（URL 尾段；无扩展名时后续按 MIME 补）
        let desiredName = baseNameFromUrl(u);

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
            '--newline',
            '-f', 'bestvideo*+bestaudio/best',
            '--merge-output-format', 'mp4',
        ];
        if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));

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
}
