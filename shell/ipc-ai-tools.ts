// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-ai-tools.ts — AI 工具 IPC: search_text / find_files / list_files
//
// ★ 2026-09-18 rg 化（大仓实锤：纯 JS 遍历 8GB 仓库全树搜索必超时）：
//   主引擎 = ripgrep（包内 engines/ripgrep；65k 文件全树 0.3~2.3s）；
//   降级链 = ripgrep → --pcre2 重试（rust 引擎不支持的 lookaround/backref）→ JS 遍历兜底。
//   超时保留部分结果（惰性 partial）+ 即时中止扫描；超时文案带耗时与范围（取证友好）。
//   全树扫描类最多 2 路并发（批量并发 = 超时事故放大器，F1 q303 五连搜实锤）。
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { AI_SKIP_DIRS, AI_SKIP_EXTS, AI_MAX_FILE_SIZE, aiGlobToRegex, aiTimeout } from './ipc-state';
import { findRipgrepBin } from './ipc-search';

// ── 全树扫描并发闸门（槽位直接移交，无窗口期）─────────────────────────────
const AI_SCAN_MAX_CONCURRENT = 2;
let _aiScanActive = 0;
const _aiScanQueue: Array<() => void> = [];

function _aiScanRelease(): void {
    const next = _aiScanQueue.shift();
    if (next) { next(); return; } // 槽位直接移交（_aiScanActive 不变）
    _aiScanActive--;
}

function _aiScanSlot<T>(fn: () => Promise<T>): Promise<T> {
    const gate = new Promise<void>(resolve => {
        if (_aiScanActive >= AI_SCAN_MAX_CONCURRENT) { _aiScanQueue.push(resolve); return; }
        _aiScanActive++;
        resolve();
    });
    return gate.then(fn).then(
        v => { _aiScanRelease(); return v; },
        e => { _aiScanRelease(); throw e; },
    );
}

// ── 超时文案（耗时 + 范围）─────────────────────────────────────────────────
function _scopeLabel(searchPaths: string[]): string {
    if (!searchPaths || searchPaths.length === 0) return '(none)';
    let first = String(searchPaths[0]);
    if (first.length > 90) first = first.slice(0, 50) + '…' + first.slice(-35);
    return searchPaths.length > 1 ? first + ' +' + (searchPaths.length - 1) + ' more' : first;
}
function _timeoutTag(ms: number, searchPaths: string[]): string {
    return '[TIMEOUT ' + Math.round(ms / 1000) + 's · scope: ' + _scopeLabel(searchPaths) + ']';
}

// ── ripgrep 公共参数 ────────────────────────────────────────────────────────
// 目录排除用尾斜杠纯目录语义（"!tmp" 会连同名文件一起杀，"!tmp/" 只杀目录——实测）
function _rgSkipGlobArgs(withExts: boolean): string[] {
    const out: string[] = [];
    for (const d of AI_SKIP_DIRS) out.push('--glob', '!' + d + '/');
    if (withExts) { for (const e of AI_SKIP_EXTS) out.push('--glob', '!' + '*' + e); }
    return out;
}

interface RgTextResult { status: 'ok' | 'timeout' | 'regex' | 'spawn' | 'empty'; lines: string[]; }

function _runRgText(rgPath: string, query: string, searchPaths: string[], maxResults: number, timeoutMs: number, pcre2: boolean): Promise<RgTextResult> {
    const args: string[] = [
        // 深度边界实测校准：rg 的 --max-depth 计数含文件本身（-d 9 ≡ 旧 JS 引擎 depth>8 语义，文件最多 8 层目录）
        '--json', '--max-depth', '9',
        '--max-filesize', Math.round(AI_MAX_FILE_SIZE / 1048576) + 'M',
        '-i',          // AI 搜索恒不区分大小写（与原 JS 引擎一致）
        '--no-ignore', // 与原 JS 遍历语义一致：不因 .gitignore 漏文件；噪声目录由 AI_SKIP_DIRS 排除
        '--hidden', '--glob', '!.*/', // 隐藏「文件」参与、隐藏「目录」排除（与原 JS 语义精确对齐）
    ];
    args.push(..._rgSkipGlobArgs(true));
    if (pcre2) args.push('--pcre2');
    args.push('--regexp', query, '--', ...searchPaths);

    return new Promise<RgTextResult>(resolve => {
        let proc: ChildProcess;
        try {
            proc = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch { return resolve({ status: 'spawn', lines: [] }); }

        let settled = false;
        let killedBy: 'timeout' | 'cap' | null = null;
        let stderr = '';
        const lines: string[] = [];
        const seen = new Set<string>(); // 同行去重（rg 每个 submatch 一条，原 JS 每行仅一条）
        let buf = '';

        const finish = (st: RgTextResult['status']) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ status: st, lines });
        };
        const timer = setTimeout(() => {
            killedBy = 'timeout';
            try { proc.kill('SIGTERM'); } catch { }
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch { } }, 500);
        }, timeoutMs);

        proc.stdout!.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            try {
                while (true) {
                    if (lines.length >= maxResults) { buf = ''; break; }
                    const i = buf.indexOf('\n');
                    if (i < 0) break;
                    const raw = buf.slice(0, i); buf = buf.slice(i + 1);
                    if (!raw.trim()) continue;
                    let obj: any;
                    try { obj = JSON.parse(raw); } catch { continue; }
                    if (!obj || obj.type !== 'match') continue;
                    const d = obj.data || {};
                    const fp = String((d.path && d.path.text) || '');
                    const ln = Number(d.line_number) || 0;
                    if (!fp || !ln) continue;
                    const key = fp + ':' + ln;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const text = String((d.lines && d.lines.text) || '').replace(/\r?\n$/, '').trim();
                    lines.push(path.normalize(fp) + ':' + ln + ':' + text.slice(0, 200));
                    if (lines.length >= maxResults) { killedBy = 'cap'; try { proc.kill('SIGTERM'); } catch { } }
                }
            } catch { /* 解析异常不拖垮流 */ }
        });
        proc.stderr!.on('data', (c: Buffer) => { if (stderr.length < 8192) stderr += c.toString('utf8'); });
        proc.on('error', () => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: 'spawn', lines }); });
        proc.on('close', (code: number | null) => {
            if (settled) return;
            // ① 超时/封顶先行裁决——此时 code=null/1（被杀进程），绝不可流入「正则错误」分支。
            //    进程恰在此刻自然完成（code=0）→ 如实按完成处理，不给完整结果误贴 TIMEOUT 标签。
            if (killedBy === 'timeout') return finish(code === 0 || lines.length >= maxResults ? 'ok' : 'timeout');
            if (killedBy === 'cap') return finish('ok');
            // ② 仅「真·正则解析错误」判 regex（rust: "regex parse error" / pcre2: "PCRE2: error compiling pattern"）。
            //    code=2 也可能是「根不存在/权限拒绝」等 IO 错误（stderr 无上述关键字）——旧按 stderr 非空即
            //    误判 → 触发 pcre2 全量重扫 + JS 三重扫（代价事故）；关键字门杜绝，且 ASCII 关键字不受 GBK 解码影响。
            if ((code === 2 || code === null) && lines.length === 0 && /regex parse error|error compiling pattern/i.test(stderr)) {
                settled = true; clearTimeout(timer);
                return resolve({ status: 'regex', lines });
            }
            if (code === 1 && lines.length === 0) return finish('empty');
            return finish('ok');
        });
    });
}

interface RgFilesResult { status: 'ok' | 'timeout' | 'spawn'; lines: string[]; }

function _runRgFiles(rgPath: string, pattern: string, searchPaths: string[], maxResults: number, timeoutMs: number): Promise<RgFilesResult> {
    // 与 search_text 同源：-d 9 ≡ 旧 JS 引擎 depth>8（实测校准，详 ipc-ai-tools 头注释）
    const args: string[] = ['--files', '--max-depth', '9', '--no-ignore'];
    args.push(..._rgSkipGlobArgs(false));
    args.push('--', ...searchPaths);

    return new Promise<RgFilesResult>(resolve => {
        let proc: ChildProcess;
        try {
            proc = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch { return resolve({ status: 'spawn', lines: [] }); }

        let settled = false;
        let killedBy: 'timeout' | null = null;
        const files: string[] = [];
        let buf = '';

        const finish = (code?: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // JS 精确过滤（与旧引擎同语义：name 或 rel 全匹配）+ 目录派生（rg --files 只列文件）
            const regex = aiGlobToRegex(pattern);
            const bases = searchPaths.map(p => p.replace(/\\/g, '/').replace(/\/+$/, ''));
            const out: string[] = [];
            const dirSeen = new Set<string>();
            for (const f0 of files) {
                const f = path.normalize(String(f0));
                const fwd = f.replace(/\\/g, '/');
                let base: string | null = null;
                for (const b of bases) {
                    if (fwd === b || fwd.startsWith(b + '/')) { base = b; break; }
                }
                const rel = base ? fwd.slice(base.length + 1) : fwd;
                if (regex.test(path.basename(f)) || regex.test(rel)) out.push(f);
                let dir = path.dirname(f);
                while (base && dir.replace(/\\/g, '/').length > base.length) {
                    if (dirSeen.has(dir)) break; // 祖先链去重（首次已溯至 base）
                    dirSeen.add(dir);
                    const dirRel = dir.replace(/\\/g, '/').slice(base.length + 1);
                    if (regex.test(path.basename(dir)) || regex.test(dirRel)) out.push(dir + '/');
                    dir = path.dirname(dir);
                }
            }
            out.sort();
            // 超时裁决：被杀（code≠0）才算 timeout；恰逢自然完成（code=0）如实按 ok
            resolve({ status: (killedBy === 'timeout' && code !== 0) ? 'timeout' : 'ok', lines: out.slice(0, maxResults) });
        };

        const timer = setTimeout(() => {
            killedBy = 'timeout';
            try { proc.kill('SIGTERM'); } catch { }
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch { } }, 500);
        }, timeoutMs);

        proc.stdout!.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            let i: number;
            while ((i = buf.indexOf('\n')) >= 0) {
                const l = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (l) files.push(l);
            }
        });
        proc.on('error', () => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: 'spawn', lines: [] }); });
        proc.on('close', (code: number | null) => finish(code));
    });
}

export function registerAiToolsIpc(): void {

    // ── search_text — 正则递归搜索（rg 主引擎 → pcre2 重试 → JS 兜底）──
    ipcMain.handle('qqqide:ai:search_text', async (_e, args: { query: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => {
        const query = args.query;
        const searchPaths: string[] = (args.paths && args.paths.length ? args.paths : (args.path ? [args.path] : [])).filter(p => typeof p === 'string' && p.length > 0);
        const maxResults = args.maxResults || 30;
        const timeoutMs = args.timeoutMs || 30000;
        if (!query) return 'Error: missing query';
        if (searchPaths.length === 0) return 'Error: no search paths — provide path/paths, or ensure the AI viewport has project folders';

        return _aiScanSlot(async () => {
            // ① ripgrep 主通道
            const rgPath = findRipgrepBin();
            if (rgPath) {
                let res = await _runRgText(rgPath, query, searchPaths, maxResults, timeoutMs, false);
                if (res.status === 'regex') {
                    res = await _runRgText(rgPath, query, searchPaths, maxResults, timeoutMs, true);
                }
                if (res.status !== 'spawn' && res.status !== 'regex') {
                    const body = res.lines.length > 0 ? res.lines.join('\n') : 'No matches found.';
                    if (res.status === 'timeout') {
                        return res.lines.length > 0
                            ? body + '\n' + _timeoutTag(timeoutMs, searchPaths)
                            : _timeoutTag(timeoutMs, searchPaths);
                    }
                    return body;
                }
                // rg 起不来 / 两次都拒识 → 落 JS 兜底
            }

            // ② JS 遍历兜底（原引擎；超时保留部分结果 + 即时中止）
            let regex: RegExp;
            try { regex = new RegExp(query, 'i'); }
            catch { regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

            const matches: string[] = [];
            let aborted = false;

            const doSearch = async (): Promise<string> => {
                async function walk(dir: string, depth: number): Promise<void> {
                    if (aborted || depth > 8 || matches.length >= maxResults) return;
                    let entries: fs.Dirent[];
                    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                    catch { return; }
                    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
                    for (const ent of entries) {
                        if (aborted || matches.length >= maxResults) break;
                        if (ent.name.startsWith('.') && ent.isDirectory()) continue;
                        if (ent.isDirectory() && AI_SKIP_DIRS.includes(ent.name)) continue;
                        const full = path.join(dir, ent.name);
                        if (ent.isDirectory()) {
                            await walk(full, depth + 1);
                        } else {
                            const extMatch = ent.name.match(/\.([a-z0-9]+)$/i);
                            const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';
                            if (AI_SKIP_EXTS.includes(ext)) continue;
                            try {
                                const st = await fs.promises.stat(full);
                                if (!st || st.size > AI_MAX_FILE_SIZE) continue;
                                const content = await fs.promises.readFile(full, 'utf8');
                                // 二进制跳过（NUL 探测）：防字节垃圾混入结果（.sq3/.map 等未列黑名单的二进制）
                                if (content.indexOf('\u0000') !== -1) continue;
                                const lines = content.split('\n');
                                for (let li = 0; li < lines.length && !aborted && matches.length < maxResults; li++) {
                                    if (regex.test(lines[li])) {
                                        matches.push(full + ':' + (li + 1) + ':' + lines[li].trim().slice(0, 200));
                                    }
                                }
                            } catch { /* skip unreadable */ }
                        }
                    }
                }
                for (const d of searchPaths) {
                    if (aborted || matches.length >= maxResults) break;
                    await walk(d, 0);
                }
                return matches.length > 0 ? matches.join('\n') : 'No matches found.';
            };

            return Promise.race([
                doSearch(),
                aiTimeout(timeoutMs, () => (matches.length > 0 ? matches.join('\n') + '\n' : ''), () => { aborted = true; }, _timeoutTag(timeoutMs, searchPaths)),
            ]);
        });
    });

    // ── find_files — glob 文件名递归搜索（rg --files 主引擎 → JS 兜底）──
    ipcMain.handle('qqqide:ai:find_files', async (_e, args: { pattern: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => {
        const pattern = args.pattern;
        const searchPaths: string[] = (args.paths && args.paths.length ? args.paths : (args.path ? [args.path] : [])).filter(p => typeof p === 'string' && p.length > 0);
        const maxResults = args.maxResults || 50;
        const timeoutMs = args.timeoutMs || 15000;
        if (!pattern || searchPaths.length === 0) return 'Error: missing pattern or paths';

        return _aiScanSlot(async () => {
            // ① ripgrep --files 主通道
            const rgPath = findRipgrepBin();
            if (rgPath) {
                const res = await _runRgFiles(rgPath, pattern, searchPaths, maxResults, timeoutMs);
                if (res.status !== 'spawn') {
                    const body = res.lines.length > 0 ? res.lines.join('\n') : 'No files found.';
                    if (res.status === 'timeout') {
                        return res.lines.length > 0
                            ? body + '\n' + _timeoutTag(timeoutMs, searchPaths)
                            : _timeoutTag(timeoutMs, searchPaths);
                    }
                    return body;
                }
            }

            // ② JS 遍历兜底（原引擎）
            const regex = aiGlobToRegex(pattern);
            const baseDirs = searchPaths.map(p => p.replace(/\\/g, '/').replace(/\/$/, ''));
            const matches: string[] = [];
            let aborted = false;

            const doSearch = async (): Promise<string> => {
                async function walk(dir: string, depth: number, baseDir: string): Promise<void> {
                    if (aborted || depth > 8 || matches.length >= maxResults) return;
                    let entries: fs.Dirent[];
                    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                    catch { return; }
                    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
                    for (const ent of entries) {
                        if (aborted || matches.length >= maxResults) break;
                        if (ent.name.startsWith('.')) continue;
                        if (ent.isDirectory() && AI_SKIP_DIRS.includes(ent.name)) continue;
                        const full = path.join(dir, ent.name);
                        const rel = baseDir ? full.replace(/\\/g, '/').slice(baseDir.length + 1) : full;
                        if (regex.test(ent.name) || regex.test(rel)) {
                            matches.push(full + (ent.isDirectory() ? '/' : ''));
                        }
                        if (ent.isDirectory()) await walk(full, depth + 1, baseDir);
                    }
                }
                for (let d = 0; d < searchPaths.length && matches.length < maxResults; d++) {
                    await walk(searchPaths[d], 0, baseDirs[d]);
                }
                return matches.length > 0 ? matches.join('\n') : 'No files found.';
            };

            return Promise.race([
                doSearch(),
                aiTimeout(timeoutMs, () => (matches.length > 0 ? matches.join('\n') + '\n' : ''), () => { aborted = true; }, _timeoutTag(timeoutMs, searchPaths)),
            ]);
        });
    });

    // ── list_files — 递归列目录 ──
    ipcMain.handle('qqqide:ai:list_files', async (_e, args: { path: string; maxResults?: number; timeoutMs?: number }) => {
        const searchPath = args.path;
        const maxResults = args.maxResults || 200;
        const timeoutMs = args.timeoutMs || 15000;
        if (!searchPath) return 'Error: missing path';

        const matches: string[] = [];
        let aborted = false;

        const doSearch = async (): Promise<string> => {
            async function walk(dir: string, depth: number): Promise<void> {
                if (aborted || depth > 8 || matches.length >= maxResults) return;
                let entries: fs.Dirent[];
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                catch { return; }
                entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
                for (const ent of entries) {
                    if (aborted || matches.length >= maxResults) break;
                    if (ent.name.startsWith('.')) continue;
                    if (ent.isDirectory() && AI_SKIP_DIRS.includes(ent.name)) continue;
                    const full = path.join(dir, ent.name);
                    matches.push(full + (ent.isDirectory() ? '/' : ''));
                    if (ent.isDirectory()) await walk(full, depth + 1);
                }
            }
            await walk(searchPath, 0);
            return matches.length > 0 ? matches.join('\n') : 'No files found.';
        };

        return Promise.race([
            doSearch(),
            aiTimeout(timeoutMs, () => (matches.length > 0 ? matches.join('\n') + '\n' : ''), () => { aborted = true; }, _timeoutTag(timeoutMs, [searchPath])),
        ]);
    });
}
