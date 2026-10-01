// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-search.ts — qqqide:search 搜索引擎 v2 (ripgrep 专线 · 流式 · 单飞 · 可取消)
//
// 唯一引擎: ripgrep 14.x (Rust · mmap零拷贝 · SIMD正则 · 多线程 · PCRE2 JIT)
// 未找到 ripgrep → 返回清晰错误提示
//
// v2 契约（与 goods/search UI 配对）:
//   · start/cancel  + 流式事件 'qqqide:search:stream'（batch/phase/done/meta）
//   · 单飞: per (窗口, clientId) 旧搜索必被杀（最新意图优先）；reqId 序号兜底
//   · 全局并发上限 4（超出排队）；命中上限（默认5000，达到即杀进程提前收工）
//   · 60s 超时 → 保留部分结果；显式取消 → 保留部分结果
//   · 协议: `--null --column --max-columns=800 --stats` 紧凑帧（替换 JSON 大输出）
//   · 文件名 pass: rg --files --null 清单 + 12s 缓存（过期则并行重扫补差集）
//   · 慢盘自适应 -j2（按上次完成运行的实测吞吐判定）
//   · replace: 编码机读写（原编码回写）+ $ 免转义 + CRLF 容忍 + 二进制跳过
//   · query = 兼容包装（旧壳层/旧载荷过渡），内部复用同一引擎
// ============================================================================

import { ipcMain, app } from 'electron';
import type { WebContents } from 'electron';
import { mi } from './main-i18n';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { decodeFile, encodeFile } from './file-encoding';
import * as P from './search-proto';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════
const MAX_ACTIVE = 4;              // 全局并发搜索上限（超出排队）
const DEFAULT_CAP = 5000;          // 命中上限（达到即杀进程提前收工）
const BATCH_MS = 120;              // 批量推进渲染层间隔
const BATCH_MAX_ROWS = 300;        // 单批上限
const NAME_WALK_TIMEOUT = 20000;   // 文件名清单扫描超时
const NAME_CACHE_FRESH_MS = 8000;  // 清单新鲜窗（窗口内不重扫；过期则并行重扫补差集）
const NAME_CACHE_MAX = 8;          // 清单缓存条数（LRU）
const COUNT_ROWS_CAP = 20000;      // listFiles(-c) 行数上限
const SLOW_MBPS = 12;              // 慢盘判定：实测吞吐 < 12MB/s → -j2

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════
interface SearchMatch {
    file: string;
    line: number;
    col: number;
    matchLen?: number;
    matchText?: string;
    text: string;
    before?: string[];
    after?: string[];
}

interface SearchResult {
    error?: string;
    results: SearchMatch[];
    total: number;
    elapsed: number;
    filesScanned: number;
    truncated: boolean;
    fileStats: Record<string, { mtime: number; birthtime: number; size: number }>;
}

interface StartOpts {
    query: string;
    searchPath: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    includePattern?: string;
    excludePattern?: string;
    maxResults?: number;
    timeoutMs?: number;
    respectGitignore?: boolean;
    matchFilenames?: boolean;
    listFiles?: boolean;           // 替换流程：只回文件+计数（rg -c）
}

interface FileStat { mtime: number; birthtime: number; size: number; }

type KillReason = 'new' | 'cancel' | 'cap' | 'timeout' | 'sender-gone' | null;

interface SearchEntry {
    key: string;
    senderId: number;
    clientId: string;
    reqId: number;
    wc: WebContents;
    opts: StartOpts;
    collect: P.RgRow[] | null;      // 非 null = 兼容包装（query）收集模式，不发流事件
    resolveLegacy: ((r: SearchResult) => void) | null;
    state: 'queued' | 'running';
    dead: boolean;                  // 排队中被取消等 —— 永不起跑
    doneEmitted: boolean;
    killReason: KillReason;
    // procs & parsers
    rgPath: string;
    contentProc: ChildProcess | null;
    nameProc: ChildProcess | null;
    parser: P.NullParser | null;
    countsParser: P.CountsParser | null;
    contentClosed: boolean;
    nameClosed: boolean;
    nameBuf: Buffer[];
    // streaming
    pending: P.RgRow[];
    flushTimer: NodeJS.Timeout | null;
    attempt: number;                // spawn 代际令牌（防 error→close 双响/重试竞态）
    total: number;                  // 已发 m+n 行数（上限计数）
    countRows: number;
    fileSet: Set<string>;
    emittedNames: Set<string>;
    emittedMatches: number;
    truncated: boolean;
    cancelled: boolean;
    timedOut: boolean;
    pcre2: boolean;
    triedPcre2: boolean;
    // lifecycle
    startedAt: number;
    timeoutMs: number;
    timeoutTimer: NodeJS.Timeout | null;
    safetyTimer: NodeJS.Timeout | null;
    contentDone: boolean;
    nameDone: boolean;
    stats: P.RgStats | null;
    spawnError: string | null;
    errMessage: string | null;
}

// ═══════════════════════════════════════════════════════════════
// ripgrep binary finder
// ═══════════════════════════════════════════════════════════════
// ★ 唯一解析器（本文件 + ipc-ai-tools.ts 共用）：已知安装点候选列表
function _rgCandidates(): { tries: string[]; rgName: string } {
    const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const tries: string[] = [];

    // 1. Components dir (userData/components/ripgrep/) — downloaded by components.py
    try { tries.push(path.join(app.getPath('userData'), 'components', 'ripgrep', rgName)); } catch { /* app not ready */ }

    // 2. engines/ripgrep/ (dev + packaged — __dirname relative to shell-out/main.js)
    tries.push(path.join(__dirname, '..', 'engines', 'ripgrep', rgName));
    tries.push(path.join(__dirname, '..', '..', 'engines', 'ripgrep', rgName));

    // 2b. Platform-suffixed binary (cross-platform dev — rg-linux-x64, rg-mac-arm64, etc.)
    const platSuffix: Record<string, string> = { win32: 'win-x64', linux: 'linux-x64', darwin: 'darwin-' + (process.arch === 'arm64' ? 'arm64' : 'x64') };
    const suffix = platSuffix[process.platform];
    if (suffix) {
        const baseName = rgName.endsWith('.exe') ? rgName.slice(0, -4) : rgName;
        const suffixed = baseName + '-' + suffix + (process.platform === 'win32' ? '.exe' : '');
        tries.push(path.join(__dirname, '..', 'engines', 'ripgrep', suffixed));
        tries.push(path.join(__dirname, '..', '..', 'engines', 'ripgrep', suffixed));
    }
    return { tries, rgName };
}

/**
 * 严格解析：仅已知安装点命中才返回绝对路径（不做 PATH 兜底）。
 * 供 AI 搜索工具判定「rg 能不能用」——不可用 → 明确走 JS 兜底，绝不 spawn 裸名撞商店存根。
 */
export function findRipgrepBin(): string | null {
    const { tries } = _rgCandidates();
    for (const p of tries) {
        try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
    }
    return null;
}

function _findRipgrep(): string {
    const found = findRipgrepBin();
    if (found) return found;
    const { rgName } = _rgCandidates();
    console.log('[search] ripgrep not found in known paths, trying PATH:', rgName);
    return rgName;
}

// ═══════════════════════════════════════════════════════════════
// Search engine — registry / admission / streaming
// ═══════════════════════════════════════════════════════════════
const entries = new Map<string, SearchEntry>();
const queue: SearchEntry[] = [];
const watchedWc = new Set<number>();

// 文件名清单缓存（key = 根|参数指纹；值 = 相对路径数组）
const nameCache = new Map<string, { list: string[]; ts: number }>();
// 慢盘判定（根 → 上次实测 MB/s）
const rootMbps = new Map<string, number>();

// 通过原图统计的吞吐判定慢盘（机械盘寻道互斗 → -j2 反而更快）
function updateDiskProfile(root: string, stats: P.RgStats | null, wallMs: number): void {
    if (!stats || stats.bytesSearched < 64 * 1024 * 1024) return; // 样本太小不可判
    const secs = Math.max(0.05, stats.secondsWall || wallMs / 1000);
    const mbps = stats.bytesSearched / secs / (1024 * 1024);
    const prev = rootMbps.get(root);
    if (mbps < SLOW_MBPS) rootMbps.set(root, mbps);
    else if (mbps > SLOW_MBPS * 3) rootMbps.delete(root);
    else if (prev !== undefined) rootMbps.set(root, mbps);
}

function isSlowRoot(root: string): boolean {
    const v = rootMbps.get(root);
    return v !== undefined && v < SLOW_MBPS;
}

// ── 事件出口 ──
function sendEvent(entry: SearchEntry, payload: Record<string, any>): void {
    if (entry.collect) return; // 兼容收集模式：不发流事件
    try {
        if (!entry.wc.isDestroyed()) {
            entry.wc.send('qqqide:search:stream', { clientId: entry.clientId, ...payload });
        }
    } catch { /* sender 已亡 */ }
}

function flushPending(entry: SearchEntry): void {
    if (!entry.pending.length) return;
    const rows = entry.pending.splice(0, entry.pending.length);
    sendEvent(entry, { kind: 'batch', reqId: entry.reqId, rows, total: entry.total });
}

function scheduleFlush(entry: SearchEntry): void {
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        flushPending(entry);
    }, BATCH_MS);
}

// ── 行注入（唯一入口：上限裁决 + 收集 + 批量推送）──
function emitRows(entry: SearchEntry, rows: P.RgRow[]): void {
    for (const row of rows) {
        if (row.k === 'c') {
            if (entry.countRows >= COUNT_ROWS_CAP) continue;
            entry.countRows++;
        } else {
            if (entry.total >= (entry.opts.maxResults || DEFAULT_CAP)) {
                if (!entry.truncated) {
                    entry.truncated = true;
                    capKill(entry);
                }
                continue;
            }
            entry.total++;
            if (row.k === 'm') entry.emittedMatches++;
            entry.fileSet.add(row.f);
        }
        entry.pending.push(row);
        if (entry.collect) entry.collect.push(row);
    }
    if (entry.pending.length >= BATCH_MAX_ROWS) flushPending(entry);
    else if (entry.pending.length) scheduleFlush(entry);
}

// ── 杀 ──
function killProc(proc: ChildProcess | null): void {
    if (!proc) return;
    try { proc.kill(); } catch { /* ignore */ }
    // Windows 兜底：2s 仍未退 → taskkill /F
    if (process.platform === 'win32' && proc.pid && proc.exitCode === null) {
        setTimeout(() => {
            try {
                if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
                    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true, stdio: 'ignore' });
                }
            } catch { /* ignore */ }
        }, 2000);
    }
}

function killEntry(entry: SearchEntry, reason: KillReason): void {
    if (entry.doneEmitted) return;
    if (reason === 'cancel') entry.cancelled = true;
    if (reason === 'timeout') entry.timedOut = true;
    if (!entry.killReason || entry.killReason === 'cap') entry.killReason = reason;
    if (entry.state === 'queued') { entry.dead = true; removeFromQueue(entry); }
    killProc(entry.contentProc);
    killProc(entry.nameProc);
    // 安全网：kill 之后 4s 仍未收尾 → 强制收尾（防 close 事件悬空）
    if (!entry.safetyTimer) {
        entry.safetyTimer = setTimeout(() => {
            if (!entry.doneEmitted) {
                entry.contentDone = true;
                entry.nameDone = true;
                finalizeDone(entry);
            }
        }, 4000);
    }
}

function capKill(entry: SearchEntry): void {
    if (entry.doneEmitted) return;
    entry.killReason = entry.killReason || 'cap';
    killProc(entry.contentProc);
    killProc(entry.nameProc);
}

function removeFromQueue(entry: SearchEntry): void {
    const i = queue.indexOf(entry);
    if (i >= 0) queue.splice(i, 1);
}

// ── 内容搜索 ──
function spawnContent(entry: SearchEntry): void {
    const { args } = P.buildContentArgs({
        query: entry.opts.query,
        isRegex: !!entry.opts.isRegex,
        caseSensitive: !!entry.opts.caseSensitive,
        wholeWord: !!entry.opts.wholeWord,
        includePattern: entry.opts.includePattern,
        excludePattern: entry.opts.excludePattern,
        respectGitignore: !!entry.opts.respectGitignore,
        slowDisk: isSlowRoot(entry.opts.searchPath),
        pcre2: entry.pcre2,
    }, entry.opts.searchPath);

    entry.contentClosed = false;
    const attempt = ++entry.attempt;
    entry.parser = new P.NullParser(entry.opts.searchPath);
    let proc: ChildProcess;
    try {
        proc = spawn(entry.rgPath, args, {
            cwd: entry.opts.searchPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (e: any) {
        entry.spawnError = e && e.message || String(e);
        entry.contentDone = true;
        entry.contentClosed = true;
        maybeFinish(entry);
        return;
    }
    entry.contentProc = proc;
    let stderr = '';
    proc.stdout!.on('data', (c: Buffer) => {
        if (attempt !== entry.attempt || entry.parser === null) return;
        const rows = entry.parser.push(c);
        if (rows.length) emitRows(entry, rows);
    });
    proc.stderr!.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    proc.on('error', (err: Error) => {
        if (attempt !== entry.attempt) return;
        entry.spawnError = err.message;
        onContentClose(entry, -1, stderr, attempt);
    });
    proc.on('close', (code: number | null, _signal: string | null) => {
        onContentClose(entry, code === null ? -1 : code, stderr, attempt);
    });
}

function onContentClose(entry: SearchEntry, code: number, stderr: string, attempt: number): void {
    if (attempt !== entry.attempt || entry.contentClosed) return;
    entry.contentClosed = true;

    const fin = entry.parser ? entry.parser.finish() : { rows: [], stats: null };
    if (fin.rows.length) emitRows(entry, fin.rows);
    entry.parser = null;
    if (fin.stats) entry.stats = fin.stats;

    // 被杀（取消/超时/上限/窗口关）→ 保留部分结果直接收尾
    if (entry.killReason) { entry.contentDone = true; maybeFinish(entry); return; }

    // 正则不被支持 → 一次性 --pcre2 重试（仅真·正则解析错误且尚未产出任何匹配）
    if (code === 2 && !entry.triedPcre2 && entry.emittedMatches === 0 && P.isRegexParseError(stderr)) {
        entry.triedPcre2 = true;
        entry.pcre2 = true;
        spawnContent(entry);
        return;
    }

    if (code === 2 && entry.emittedMatches === 0) {
        const msg = stderr.split('\n').map(s => s.trim()).filter(Boolean).slice(-2).join('; ');
        entry.errMessage = msg || mi('main.search.rgExit2');
        entry.contentDone = true;
        maybeFinish(entry);
        return;
    }
    if (entry.spawnError && entry.emittedMatches === 0) {
        entry.errMessage = (entry.spawnError === 'ENOENT' ? mi('main.search.rgMissing') : mi('main.search.rgError', { err: entry.spawnError }));
        entry.contentDone = true;
        maybeFinish(entry);
        return;
    }
    entry.contentDone = true;
    maybeFinish(entry);
}

// ── 文件名 pass（缓存 + 过期重扫补差集）──
function nameCacheKey(entry: SearchEntry): string {
    const o = entry.opts;
    return [o.searchPath, !!o.respectGitignore, o.includePattern || '', o.excludePattern || ''].join('|');
}

function emitNameMatches(entry: SearchEntry, list: string[], matcher: (n: string) => boolean): void {
    for (const raw of list) {
        const rel = P.relPath(raw, entry.opts.searchPath);
        const base = rel.replace(/\\/g, '/').split('/').pop() || rel;
        if (!base || entry.emittedNames.has(rel)) continue;
        if (!matcher(base)) continue;
        entry.emittedNames.add(rel);
        emitRows(entry, [{ k: 'n', f: rel, l: 0, c: 1, t: base, n: 1 }]);
    }
}

function runNamePass(entry: SearchEntry): void {
    const matcher = P.makeNameMatcher(entry.opts.query, !!entry.opts.isRegex, !!entry.opts.caseSensitive, !!entry.opts.wholeWord);
    if (!matcher || entry.opts.listFiles) { entry.nameDone = true; maybeFinish(entry); return; }

    const key = nameCacheKey(entry);
    const cached = nameCache.get(key);
    if (cached) {
        emitNameMatches(entry, cached.list, matcher);
        if (Date.now() - cached.ts <= NAME_CACHE_FRESH_MS) { entry.nameDone = true; maybeFinish(entry); return; }
    }

    entry.nameBuf = [];
    entry.nameClosed = false;
    let proc: ChildProcess;
    try {
        proc = spawn(entry.rgPath, P.buildFilesArgs({
            query: entry.opts.query,
            isRegex: !!entry.opts.isRegex,
            caseSensitive: !!entry.opts.caseSensitive,
            wholeWord: !!entry.opts.wholeWord,
            includePattern: entry.opts.includePattern,
            excludePattern: entry.opts.excludePattern,
            respectGitignore: !!entry.opts.respectGitignore,
        }, entry.opts.searchPath), {
            cwd: entry.opts.searchPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch {
        entry.nameDone = true;
        maybeFinish(entry);
        return;
    }
    entry.nameProc = proc;
    let overflow = false;
    proc.stdout!.on('data', (c: Buffer) => {
        if (entry.nameBuf.length < 512) entry.nameBuf.push(c); // 512 块 ≈ 数十 MB 安全帽
        else overflow = true;
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killProc(proc); }, NAME_WALK_TIMEOUT);
    // ★ 缓存投毒防线：仅「正常完整扫完」才写缓存——被杀/超时/溢出/错误一律只播差集不落缓存
    const done = (ok: boolean) => {
        if (entry.nameClosed) return;
        entry.nameClosed = true;
        clearTimeout(timer);
        const text = Buffer.concat(entry.nameBuf).toString('utf8');
        const list = P.parseNullList(text);
        const cacheSafe = ok && !timedOut && !overflow && !entry.killReason && !entry.doneEmitted;
        if (cacheSafe) {
            nameCache.set(key, { list, ts: Date.now() });
            // LRU 修剪
            if (nameCache.size > NAME_CACHE_MAX) {
                let oldestKey: string | null = null, oldestTs = Infinity;
                for (const [k, v] of nameCache) { if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; } }
                if (oldestKey && oldestKey !== key) nameCache.delete(oldestKey);
            }
        }
        emitNameMatches(entry, list, matcher);
        entry.nameDone = true;
        maybeFinish(entry);
    };
    proc.on('error', () => done(false));
    proc.on('close', (code: number | null) => done(code !== null));
}

// ── listFiles 模式（rg -c：替换流程精确文件清单）──
function spawnCounts(entry: SearchEntry): void {
    entry.countsParser = new P.CountsParser(entry.opts.searchPath);
    entry.contentClosed = false;
    const attempt = ++entry.attempt;
    let proc: ChildProcess;
    try {
        proc = spawn(entry.rgPath, P.buildCountArgs({
            query: entry.opts.query,
            isRegex: !!entry.opts.isRegex,
            caseSensitive: !!entry.opts.caseSensitive,
            wholeWord: !!entry.opts.wholeWord,
            includePattern: entry.opts.includePattern,
            excludePattern: entry.opts.excludePattern,
            respectGitignore: !!entry.opts.respectGitignore,
            pcre2: entry.pcre2,
        }, entry.opts.searchPath), {
            cwd: entry.opts.searchPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (e: any) {
        entry.spawnError = e && e.message || String(e);
        entry.contentDone = true;
        entry.contentClosed = true;
        maybeFinish(entry);
        return;
    }
    entry.contentProc = proc;
    let stderr = '';
    proc.stdout!.on('data', (c: Buffer) => {
        if (attempt !== entry.attempt || entry.countsParser === null) return;
        const rows = entry.countsParser.push(c);
        if (rows.length) emitRows(entry, rows);
    });
    proc.stderr!.on('data', (c: Buffer) => { stderr += c.toString('utf8'); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    const close = (code: number) => {
        if (attempt !== entry.attempt || entry.contentClosed) return;
        entry.contentClosed = true;
        const rows = entry.countsParser ? entry.countsParser.finish() : [];
        entry.countsParser = null;
        if (rows.length) emitRows(entry, rows);
        if (code === 2 && !entry.triedPcre2 && entry.countRows === 0 && P.isRegexParseError(stderr)) {
            entry.triedPcre2 = true;
            entry.pcre2 = true;
            spawnCounts(entry);
            return;
        }
        if (code === 2 && entry.countRows === 0) {
            const msg = stderr.split('\n').map(s => s.trim()).filter(Boolean).slice(-2).join('; ');
            entry.errMessage = msg || mi('main.search.rgExit2');
        }
        entry.contentDone = true;
        entry.nameDone = true;
        maybeFinish(entry);
    };
    proc.on('error', (err: Error) => {
        if (attempt !== entry.attempt) return;
        entry.spawnError = err.message;
        close(-1);
    });
    proc.on('close', (code: number | null) => close(code === null ? -1 : code));
}

// ── 收尾 ──
function maybeFinish(entry: SearchEntry): void {
    if (entry.contentDone && entry.nameDone) finalizeDone(entry);
}

async function statFileSet(entry: SearchEntry): Promise<Record<string, FileStat>> {
    const out: Record<string, FileStat> = {};
    const files = Array.from(entry.fileSet);
    const CONC = 32;
    let idx = 0;
    async function worker(): Promise<void> {
        for (;;) {
            const i = idx++;
            if (i >= files.length) return;
            const rel = files[i];
            try {
                const st = await fs.promises.stat(path.join(entry.opts.searchPath, rel));
                out[rel] = { mtime: st.mtimeMs, birthtime: st.birthtimeMs, size: st.size };
            } catch { /* skip */ }
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, files.length) }, worker));
    return out;
}

function buildLegacyResult(entry: SearchEntry, stats: Record<string, FileStat>): SearchResult {
    const rows = entry.collect || [];
    const results: SearchMatch[] = [];
    for (const r of rows) {
        if (r.k === 'c') continue;
        if (r.k === 'n') {
            results.push({ file: r.f, line: 1, col: 1, matchText: r.t, text: r.t });
        } else {
            results.push({ file: r.f, line: r.l, col: r.c, matchText: '', text: r.t });
        }
    }
    return {
        results,
        total: results.length,
        elapsed: Date.now() - entry.startedAt,
        filesScanned: entry.stats ? entry.stats.filesSearched : entry.fileSet.size,
        truncated: entry.truncated,
        fileStats: stats,
    };
}

function finalizeDone(entry: SearchEntry): void {
    if (entry.doneEmitted) return;
    entry.doneEmitted = true;
    if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
    if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = null; }
    if (entry.safetyTimer) { clearTimeout(entry.safetyTimer); entry.safetyTimer = null; }

    const silent = entry.killReason === 'new' || entry.killReason === 'sender-gone';
    if (!silent) flushPending(entry);
    const wallMs = Date.now() - entry.startedAt;

    if (entry.stats) updateDiskProfile(entry.opts.searchPath, entry.stats, wallMs);

    if (entry.collect && entry.resolveLegacy) {
        // 兼容包装：计算 fileStats 后返回
        const resolve = entry.resolveLegacy;
        entry.resolveLegacy = null;
        statFileSet(entry).then((stats) => {
            resolve(buildLegacyResult(entry, stats));
        }).catch(() => resolve(buildLegacyResult(entry, {})));
        cleanupEntry(entry);
        return;
    }

    if (!silent) {
        sendEvent(entry, {
            kind: 'done',
            reqId: entry.reqId,
            total: entry.total,
            files: entry.fileSet.size,
            truncated: entry.truncated,
            cancelled: entry.cancelled,
            timedOut: entry.timedOut,
            pcre2: entry.pcre2,
            error: entry.errMessage || undefined,
            wallMs,
            stats: entry.stats ? {
                filesSearched: entry.stats.filesSearched,
                bytesSearched: entry.stats.bytesSearched,
                searchMs: Math.round(entry.stats.secondsWall * 1000),
            } : null,
        });
        // fileStats（排序用）— done 之后异步补发，不阻塞收尾
        if (entry.fileSet.size) {
            const wc = entry.wc;
            const clientId = entry.clientId;
            const reqId = entry.reqId;
            statFileSet(entry).then((fileStats) => {
                try {
                    if (!wc.isDestroyed()) wc.send('qqqide:search:stream', { clientId, kind: 'meta', reqId, fileStats });
                } catch { /* ignore */ }
            }).catch(() => { /* ignore */ });
        }
    }
    cleanupEntry(entry);
}

function cleanupEntry(entry: SearchEntry): void {
    killProc(entry.contentProc);
    killProc(entry.nameProc);
    if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
    if (entry.timeoutTimer) { clearTimeout(entry.timeoutTimer); entry.timeoutTimer = null; }
    if (entry.safetyTimer) { clearTimeout(entry.safetyTimer); entry.safetyTimer = null; }
    // ★ 身份守卫：同 key 已被新搜索顶替时，旧搜索的异步收尾绝不可误删新条目
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    pumpQueue();
}

function runningCount(): number {
    let n = 0;
    for (const e of entries.values()) if (e.state === 'running' && !e.doneEmitted) n++;
    return n;
}

function pumpQueue(): void {
    while (queue.length && runningCount() < MAX_ACTIVE) {
        const e = queue.shift()!;
        if (e.dead || e.doneEmitted) continue;
        runEntry(e);
    }
}

function runEntry(entry: SearchEntry): void {
    entry.state = 'running';
    entry.startedAt = Date.now();
    sendEvent(entry, { kind: 'phase', reqId: entry.reqId, stage: 'run' });

    entry.rgPath = _findRipgrep();
    entry.timeoutTimer = setTimeout(() => {
        if (entry.doneEmitted) return;
        entry.timedOut = true;
        killEntry(entry, 'timeout');
    }, Math.max(5000, entry.timeoutMs));

    if (entry.opts.listFiles) spawnCounts(entry);
    else spawnContent(entry);

    runNamePass(entry);
}

function newEntry(wc: WebContents, clientId: string, reqId: number, opts: StartOpts,
    collect: P.RgRow[] | null, resolveLegacy: ((r: SearchResult) => void) | null, keyPrefix?: string): SearchEntry {
    const key = (keyPrefix || '') + wc.id + ':' + clientId;
    const entry: SearchEntry = {
        key,
        senderId: wc.id,
        clientId,
        reqId,
        wc,
        opts,
        collect,
        resolveLegacy,
        state: 'queued',
        dead: false,
        doneEmitted: false,
        killReason: null,
        rgPath: '',
        contentProc: null,
        nameProc: null,
        parser: null,
        countsParser: null,
        contentClosed: false,
        nameClosed: false,
        nameBuf: [],
        pending: [],
        flushTimer: null,
        attempt: 0,
        total: 0,
        countRows: 0,
        fileSet: new Set(),
        emittedNames: new Set(),
        emittedMatches: 0,
        truncated: false,
        cancelled: false,
        timedOut: false,
        pcre2: false,
        triedPcre2: false,
        startedAt: Date.now(),
        timeoutMs: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 60000,
        timeoutTimer: null,
        safetyTimer: null,
        contentDone: false,
        nameDone: false,
        stats: null,
        spawnError: null,
        errMessage: null,
    };
    return entry;
}

function watchSender(wc: WebContents, senderId: number): void {
    if (watchedWc.has(senderId)) return;
    watchedWc.add(senderId);
    try {
        wc.once('destroyed', () => {
            watchedWc.delete(senderId);
            for (const entry of Array.from(entries.values())) {
                if (entry.senderId === senderId) killEntry(entry, 'sender-gone');
            }
        });
    } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// IPC registration
// ═══════════════════════════════════════════════════════════════
let legacySeq = 0;

export function registerSearchIpc(): void {

    // ── qqqide:search:start（流式 v2）──
    ipcMain.handle('qqqide:search:start', async (e, args: StartOpts & { clientId?: string; reqId?: number }) => {
        const wc = e.sender;
        const clientId = String(args.clientId || 'default').slice(0, 64);
        const reqId = Number(args.reqId) || 0;
        const searchPath = args.searchPath || '';
        const query = args.query || '';
        if (!searchPath || !query) return { ok: false, error: mi('main.search.noQuery') };
        if (query.length > 2000) return { ok: false, error: mi('main.search.tooLong') };

        watchSender(wc, wc.id);

        // 单飞：同 (窗口, clientId) 旧搜索必杀（最新意图优先；静默，不出 done）
        const key = wc.id + ':' + clientId;
        const prev = entries.get(key);
        if (prev && !prev.doneEmitted) killEntry(prev, 'new');

        const opts: StartOpts = {
            query,
            searchPath,
            isRegex: !!args.isRegex,
            caseSensitive: !!args.caseSensitive,
            wholeWord: !!args.wholeWord,
            includePattern: args.includePattern,
            excludePattern: args.excludePattern,
            maxResults: Math.min(Math.max(args.maxResults || DEFAULT_CAP, 1), 200000),
            timeoutMs: args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 60000,
            respectGitignore: !!args.respectGitignore,
            matchFilenames: args.matchFilenames !== false,
            listFiles: !!args.listFiles,
        };
        const entry = newEntry(wc, clientId, reqId, opts, null, null);
        entries.set(key, entry);
        if (runningCount() >= MAX_ACTIVE) {
            queue.push(entry);
            sendEvent(entry, { kind: 'phase', reqId, stage: 'queued' });
        } else {
            runEntry(entry);
        }
        return { ok: true, reqId };
    });

    // ── qqqide:search:cancel ──
    ipcMain.handle('qqqide:search:cancel', async (e, args: { clientId?: string }) => {
        const wc = e.sender;
        const clientId = String(args && args.clientId || 'default').slice(0, 64);
        const entry = entries.get(wc.id + ':' + clientId);
        if (entry && !entry.doneEmitted) {
            if (entry.state === 'queued') {
                // 排队中的取消：无进行中工作 → 直接广播终局
                entry.dead = true;
                removeFromQueue(entry);
                entry.cancelled = true;
                entry.doneEmitted = true;
                sendEvent(entry, {
                    kind: 'done', reqId: entry.reqId, total: entry.total, files: entry.fileSet.size,
                    truncated: entry.truncated, cancelled: true, timedOut: false, pcre2: false,
                    wallMs: Date.now() - entry.startedAt, stats: null,
                });
                entries.delete(entry.key);
            } else {
                killEntry(entry, 'cancel');
            }
        }
        return { ok: true };
    });

    // ── qqqide:search:query（兼容包装：旧载荷过渡期；一次性返回完整结果）──
    ipcMain.handle('qqqide:search:query', async (e, args: {
        query: string;
        searchPath?: string;
        rootDir?: string;
        isRegex?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        includePattern?: string;
        excludePattern?: string;
        contextLines?: number;   // 已退役（旧 UI 恒传 0）——接受但忽略
        maxResults?: number;
        timeoutMs?: number;
        respectGitignore?: boolean;
        matchFilenames?: boolean;
    }): Promise<SearchResult> => {
        const wc = e.sender;
        const searchPath = args.searchPath || args.rootDir || '';
        const query = args.query || '';
        if (!searchPath || !query) {
            return { error: mi('main.search.noQuery'), results: [], total: 0, elapsed: 0, filesScanned: 0, truncated: false, fileStats: {} };
        }
        watchSender(wc, wc.id);
        const opts: StartOpts = {
            query,
            searchPath,
            isRegex: !!args.isRegex,
            caseSensitive: !!args.caseSensitive,
            wholeWord: !!args.wholeWord,
            includePattern: args.includePattern,
            excludePattern: args.excludePattern,
            maxResults: Math.min(Math.max(args.maxResults || DEFAULT_CAP, 1), 200000),
            timeoutMs: args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 60000,
            respectGitignore: !!args.respectGitignore,
            matchFilenames: args.matchFilenames !== false,
        };
        const clientId = '__legacy__' + (++legacySeq);
        const entry = newEntry(wc, clientId, 0, opts, [], null, 'legacy:');
        const promise = new Promise<SearchResult>((resolve) => { entry.resolveLegacy = resolve; });
        if (runningCount() >= MAX_ACTIVE) queue.push(entry);
        else runEntry(entry);
        return await promise;
    });

    // ── qqqide:search:replace（编码机读写 + $ 免转义 + CRLF 容忍）──
    ipcMain.handle('qqqide:search:replace', async (e, args: {
        files?: string[];
        find?: string;
        replace?: string;
        useRegex?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        searchPath?: string;
    }) => {
        const files = args.files || [];
        const find = args.find || '';
        if (!files.length || !find) return { replaced: 0, files: 0, errors: [] };

        const built = P.buildReplaceRegex(find, !!args.useRegex, !!args.caseSensitive, !!args.wholeWord);
        if (!built.re) return { replaced: 0, files: 0, errors: ['Invalid regex: ' + (built.error || '')] };
        const re = built.re;

        const sp = args.searchPath || '';
        let totalReplaced = 0, filesChanged = 0, processed = 0;
        const totalFiles = files.length;
        const errors: string[] = [];
        const replaceText = args.replace === undefined ? '' : String(args.replace);

        for (const fpath of files) {
            const absFp = path.isAbsolute(fpath) ? fpath : path.join(sp, fpath);
            let changed = false;
            try {
                const { text } = await decodeFile(absFp);
                if (text.indexOf('\u0000') !== -1) {
                    errors.push(mi('main.search.skipBinary', { f: fpath }));
                } else {
                    const crlf = text.indexOf('\r\n') !== -1;
                    const repUse = crlf ? replaceText.replace(/\n/g, '\r\n') : replaceText;
                    let cnt = 0;
                    const newText = text.replace(re, () => { cnt++; return repUse; });
                    if (cnt > 0 && newText !== text) {
                        await encodeFile(absFp, newText);
                        totalReplaced += cnt;
                        filesChanged++;
                        changed = true;
                    }
                }
            } catch (err: any) {
                errors.push(fpath + ': ' + (err && err.message || err));
            }
            processed++;
            if (e.sender && !e.sender.isDestroyed()) {
                e.sender.send('qqqide:search:replace:progress', {
                    current: processed, total: totalFiles, file: fpath,
                    replaced: totalReplaced, errors: errors.slice(),
                    changed, absPath: absFp,
                });
            }
        }
        return { replaced: totalReplaced, files: filesChanged, errors };
    });

    // ── 应用退出：全量收尸（防 Windows 孤儿 rg 进程）──
    app.on('before-quit', () => {
        for (const entry of Array.from(entries.values())) killEntry(entry, 'sender-gone');
        queue.length = 0;
    });
}
