// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// search-proto.ts — 搜索协议纯函数机（零 electron / 零 fs 依赖，可独立测试）
//
// ① NullParser   — ripgrep `--null --column ... --stats` 输出流解析器
//    线格式: <path>\0<line>:<col>:<text>\n  （每行一条；text 内无 \n，path 内可含 \n）
//    统计尾: 结尾无 \0 的纯文本块（N matches / N files searched / N bytes searched ...）
// ② CountsParser — `-c --null` 输出解析: <path>\0<count>\n（替换流程精确文件清单）
// ③ parseNullList — `--files --null` / `-l --null`: <path>\0<path>\0...（尾 NUL 保证完整）
// ④ byteColToChar — rg 列号 = 1-based 字节偏移 → 转字符列（编辑器跳转用）
// ⑤ normalizeQuery — \n 归一 / 固定串转义（搜索与替换唯一共用的语义源）
// ⑥ buildReplaceRegex / makeNameMatcher / relPath
//
// 独立测试: _qqq/tmp/proto-test.js（esbuild 单文件打包 → node 直跑）
// ============================================================================

import { StringDecoder } from 'string_decoder';

export const TEXT_CAP = 800;          // 单行展示文本字符上限（rg --max-columns 已按字节封顶，双保险）
export const SEARCH_MAX_DEPTH = 20;
export const SEARCH_MAX_FILE_MB = 5;
export const MAX_COLUMNS = 800;

// ── 行记录 ──
export interface RgRow {
    k: 'm' | 'n' | 'c';   // m=内容匹配 / n=文件名命中 / c=计数行（替换清单）
    f: string;            // 相对路径（正斜杠）
    l: number;            // 行号（n/c 行为 0）
    c: number;            // 字符列（1-based）
    t: string;            // 行文本
    n: number;            // m/n=1；c=计数
}

export interface RgStats {
    matches: number;
    matchedLines: number;
    filesMatched: number;
    filesSearched: number;
    bytesPrinted: number;
    bytesSearched: number;
    secondsSpentSearching: number;
    secondsWall: number;
}

// ── 路径归一: 反斜杠→正斜杠 + 剥搜索根前缀 ──
export function relPath(p: string, searchPath: string): string {
    const fwd = p.replace(/\\/g, '/');
    const norm = searchPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm && fwd.startsWith(norm + '/')) return fwd.slice(norm.length + 1);
    return fwd;
}

// ── 字节列 → 字符列（1-based；纯 ASCII 快路径）──
export function byteColToChar(text: string, byteCol: number): number {
    if (byteCol <= 1) return 1;
    const n = Math.min(text.length, byteCol - 1);
    let ascii = true;
    for (let i = 0; i < n; i++) {
        if (text.charCodeAt(i) > 127) { ascii = false; break; }
    }
    if (ascii) return byteCol;
    const b = Buffer.from(text, 'utf8');
    if (byteCol - 1 >= b.length) return text.length + 1;
    return b.subarray(0, byteCol - 1).toString('utf8').length + 1;
}

// ── 查询归一（搜索与替换唯一共用语义源）──
//   \n（两字符转义）→ 实际换行；固定串模式强制转正则并转义；全字加 \b。
export function normalizeQuery(raw: string, isRegex: boolean, wholeWord: boolean):
    { actual: string; hasNewline: boolean; forceRegex: boolean } {
    const hasNewline = raw.indexOf('\\n') !== -1 || raw.indexOf('\n') !== -1;
    let actual = raw;
    let forceRegex = false;
    if (hasNewline) {
        actual = raw.replace(/\\n/g, '\n');
        if (!isRegex) {
            forceRegex = true;
            actual = escapeRegExp(actual);
            if (wholeWord) actual = '\\b' + actual + '\\b';
        }
    }
    return { actual, hasNewline, forceRegex };
}

export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 替换正则（与 normalizeQuery 同源；换行恒容忍 CRLF）──
//   路径裁决: forceRegex（换行+固定串）= normalize 已转义+可含 \b；useRegex = 用户正则原样；
//   其余固定串 = 此处转义。wholeWord 除 normalize 已包过的场景外补包 \b（与旧替换语义一致）。
export function buildReplaceRegex(find: string, useRegex: boolean, caseSensitive: boolean, wholeWord: boolean):
    { re: RegExp | null; error?: string } {
    const norm = normalizeQuery(find, useRegex, wholeWord);
    let src: string;
    if (norm.forceRegex || useRegex) src = norm.actual;
    else src = escapeRegExp(norm.actual);
    if (wholeWord && !(norm.hasNewline && norm.forceRegex)) src = '\\b' + src + '\\b';
    // 字面换行 → \r?\n（CRLF 文件同时命中；与 rg --crlf 语义对齐）
    src = src.replace(/\n/g, '\\r?\\n');
    try {
        return { re: new RegExp(src, caseSensitive ? 'g' : 'gi') };
    } catch (e: any) {
        return { re: null, error: String(e && e.message || e) };
    }
}

// ── 文件名匹配器（--files 清单在 JS 侧过滤）──
export function makeNameMatcher(query: string, isRegex: boolean, caseSensitive: boolean, wholeWord: boolean):
    ((name: string) => boolean) | null {
    if (!query) return null;
    if (query.indexOf('\n') !== -1 || query.indexOf('\\n') !== -1) return null; // 换行查询对文件名无意义
    if (isRegex) {
        try {
            const re = new RegExp(query, caseSensitive ? '' : 'i');
            return (n) => re.test(n);
        } catch { return null; }
    }
    if (wholeWord) {
        try {
            const re = new RegExp('\\b' + escapeRegExp(query) + '\\b', caseSensitive ? '' : 'i');
            return (n) => re.test(n);
        } catch { return null; }
    }
    const q = caseSensitive ? query : query.toLowerCase();
    return (n) => (caseSensitive ? n : n.toLowerCase()).indexOf(q) !== -1;
}

// ── 统计尾解析 ──
const STAT_RES: Array<[RegExp, keyof RgStats]> = [
    [/^(\d+) matches$/, 'matches'],
    [/^(\d+) matched lines$/, 'matchedLines'],
    [/^(\d+) files contained matches$/, 'filesMatched'],
    [/^(\d+) files searched$/, 'filesSearched'],
    [/^(\d+) bytes printed$/, 'bytesPrinted'],
    [/^(\d+) bytes searched$/, 'bytesSearched'],
    [/^([\d.]+) seconds spent searching$/, 'secondsSpentSearching'],
    [/^([\d.]+) seconds$/, 'secondsWall'],
];

export function parseStatsLines(lines: string[]): RgStats | null {
    const st: Partial<RgStats> = {};
    let seen = false;
    for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        for (const [re, key] of STAT_RES) {
            const m = re.exec(s);
            if (m) { (st as any)[key] = parseFloat(m[1]); seen = true; break; }
        }
    }
    if (!seen || st.matches === undefined) return null;
    return {
        matches: st.matches || 0,
        matchedLines: st.matchedLines || 0,
        filesMatched: st.filesMatched || 0,
        filesSearched: st.filesSearched || 0,
        bytesPrinted: st.bytesPrinted || 0,
        bytesSearched: st.bytesSearched || 0,
        secondsSpentSearching: st.secondsSpentSearching || 0,
        secondsWall: st.secondsWall || 0,
    };
}

// ── NullParser: --null 匹配流 ──
export class NullParser {
    private dec = new StringDecoder('utf8');
    private buf = '';
    private searchPath: string;
    public badRecords = 0;

    constructor(searchPath: string) { this.searchPath = searchPath; }

    push(chunk: Buffer): RgRow[] {
        this.buf += this.dec.write(chunk);
        return this.scan(false);
    }

    finish(): { rows: RgRow[]; stats: RgStats | null } {
        this.buf += this.dec.end() as any || '';
        const rows = this.scan(true);
        const leftover = this.buf;
        this.buf = '';
        return { rows, stats: parseStatsLines(leftover.split('\n')) };
    }

    // completeOnly=false: 只吃完整「\0...\n」记录；true: 收尾允许缺尾 \n 的最后一条
    private scan(tail: boolean): RgRow[] {
        const rows: RgRow[] = [];
        for (;;) {
            const z = this.buf.indexOf('\u0000');
            if (z === -1) break;
            let nl = this.buf.indexOf('\n', z + 1);
            if (nl === -1) {
                if (!tail) break;
                nl = this.buf.length; // 收尾：最后一条可能缺 \n
            }
            const rawPath = this.buf.slice(0, z);
            const rec = this.buf.slice(z + 1, nl);
            this.buf = this.buf.slice(nl + 1 <= this.buf.length ? nl + 1 : this.buf.length);
            const row = this.parseRecord(rawPath, rec);
            if (row) rows.push(row);
            else this.badRecords++;
        }
        return rows;
    }

    private parseRecord(rawPath: string, rec: string): RgRow | null {
        const c1 = rec.indexOf(':');
        if (c1 < 1) return null;
        const c2 = rec.indexOf(':', c1 + 1);
        if (c2 < 0) return null;
        const l = parseInt(rec.slice(0, c1), 10);
        const cb = parseInt(rec.slice(c1 + 1, c2), 10);
        if (!isFinite(l) || !isFinite(cb)) return null;
        let text = rec.slice(c2 + 1);
        if (text.charCodeAt(text.length - 1) === 13) text = text.replace(/\r+$/, '');
        text = text.slice(0, TEXT_CAP);
        return {
            k: 'm',
            f: relPath(rawPath, this.searchPath),
            l,
            c: byteColToChar(text, cb),
            t: text,
            n: 1,
        };
    }
}

// ── CountsParser: -c --null 输出（<path>\0<count>\n）──
export class CountsParser {
    private dec = new StringDecoder('utf8');
    private buf = '';
    private searchPath: string;

    constructor(searchPath: string) { this.searchPath = searchPath; }

    push(chunk: Buffer): RgRow[] {
        this.buf += this.dec.write(chunk);
        return this.scan(false);
    }

    finish(): RgRow[] {
        this.buf += this.dec.end() as any || '';
        const rows = this.scan(true);
        this.buf = '';
        return rows;
    }

    private scan(tail: boolean): RgRow[] {
        const rows: RgRow[] = [];
        for (;;) {
            const nl = this.buf.indexOf('\n');
            if (nl === -1) {
                if (!tail) break;
                if (!this.buf) break;
                // 收尾：无 \n 的最后一条
            }
            const line = this.buf.slice(0, nl === -1 ? this.buf.length : nl);
            const z = line.indexOf('\u0000');
            this.buf = nl === -1 ? '' : this.buf.slice(nl + 1);
            if (z < 0) continue;
            const n = parseInt(line.slice(z + 1), 10);
            if (!isFinite(n)) continue;
            rows.push({ k: 'c', f: relPath(line.slice(0, z), this.searchPath), l: 0, c: 1, t: '', n });
        }
        return rows;
    }
}

// ── --files --null / -l --null: 尾 NUL 保证完整；无尾 NUL 的残段丢弃 ──
export function parseNullList(full: string): string[] {
    if (!full) return [];
    const complete = full.charAt(full.length - 1) === '\u0000';
    const parts = full.split('\u0000');
    if (!complete) parts.pop(); // 丢弃被杀断的残段
    return parts.filter(Boolean);
}

// ── 参数组（内容搜索 / 文件名清单 / 计数）──
export interface ArgOpts {
    query: string;
    isRegex: boolean;
    caseSensitive: boolean;
    wholeWord: boolean;
    includePattern?: string;
    excludePattern?: string;
    respectGitignore: boolean;
    slowDisk?: boolean;
    pcre2?: boolean;
}

function pushCommon(args: string[], o: ArgOpts): void {
    if (!o.respectGitignore) args.push('--no-ignore');
    args.push('--glob', '!.git', '--glob', '!node_modules');
    if (o.includePattern) {
        for (const p of o.includePattern.split(',').map(s => s.trim()).filter(Boolean)) args.push('--glob', p);
    }
    if (o.excludePattern) {
        for (const p of o.excludePattern.split(',').map(s => s.trim()).filter(Boolean)) args.push('--glob', '!' + p);
    }
}

export function buildContentArgs(o: ArgOpts, searchPath: string): { args: string[] } {
    const args: string[] = [
        '--null', '--column', '--no-heading', '--with-filename', '--line-number',
        '--color', 'never',
    ];
    pushCommon(args, o);
    args.push('--max-depth', String(SEARCH_MAX_DEPTH));
    args.push('--max-filesize', SEARCH_MAX_FILE_MB + 'M');
    args.push('--max-columns=' + MAX_COLUMNS);
    args.push('--stats');
    if (o.slowDisk) args.push('-j', '2'); // 慢盘（机械盘实测低吞吐）→ 限并发降寻道互斗

    const norm = normalizeQuery(o.query, o.isRegex, o.wholeWord);
    if (norm.hasNewline) { args.push('--multiline'); args.push('--crlf'); }
    if (!o.caseSensitive) args.push('--ignore-case');
    if (o.wholeWord && !norm.forceRegex) args.push('--word-regexp');
    if (!o.isRegex && !norm.forceRegex) args.push('--fixed-strings');
    if (o.pcre2) args.push('--pcre2');
    args.push('--regexp', norm.actual);
    args.push(searchPath);
    return { args };
}

export function buildFilesArgs(o: ArgOpts, searchPath: string): string[] {
    const args: string[] = ['--files', '--null'];
    pushCommon(args, o);
    args.push('--max-depth', String(SEARCH_MAX_DEPTH));
    args.push(searchPath);
    return args;
}

export function buildCountArgs(o: ArgOpts, searchPath: string): string[] {
    const args: string[] = ['--null', '-c', '--no-heading', '--color', 'never'];
    pushCommon(args, o);
    args.push('--max-depth', String(SEARCH_MAX_DEPTH));
    args.push('--max-filesize', SEARCH_MAX_FILE_MB + 'M');

    const norm = normalizeQuery(o.query, o.isRegex, o.wholeWord);
    if (norm.hasNewline) { args.push('--multiline'); args.push('--crlf'); }
    if (!o.caseSensitive) args.push('--ignore-case');
    if (o.wholeWord && !norm.forceRegex) args.push('--word-regexp');
    if (!o.isRegex && !norm.forceRegex) args.push('--fixed-strings');
    if (o.pcre2) args.push('--pcre2');
    args.push('--regexp', norm.actual);
    args.push(searchPath);
    return args;
}

// ── 正则解析错误裁决（仅真·正则错误才允许 --pcre2 重试；IO 错误不得触发重扫）──
export function isRegexParseError(stderr: string): boolean {
    const s = (stderr || '').toLowerCase();
    return s.indexOf('regex parse error') !== -1 || s.indexOf('error parsing regex') !== -1
        || s.indexOf('error compiling pattern') !== -1 || s.indexOf('unsupported') !== -1 && s.indexOf('regex') !== -1;
}

// ── 人类可读字节 ──
export function humanBytes(b: number): string {
    if (!isFinite(b) || b <= 0) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
    return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
