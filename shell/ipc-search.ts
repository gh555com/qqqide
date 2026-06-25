// ============================================================================
// ipc-search.ts — qqqide:search 高性能项目搜索引擎 (v2 — ripgrep-first)
//
// 双引擎架构:
//   Tier 1: ripgrep (rg) — Rust, mmap, SIMD, 多线程, 零拷贝 I/O
//   Tier 2: JS 回退 — 纯 Node.js, 异步并发, 兜底
//
// 策略: 优先 spawn ripgrep (--json 输出), 失败/不存在/超时 → JS 回退.
// 响应格式: 扁平 results[] + total/elapsed/filesScanned/truncated/fileStats
// ============================================================================

import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs', '.hg', '.svn', '.DS_Store', 'bower_components', '.idea', '.vs']);
const SEARCH_BINARY_EXTS = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.flac', '.ogg', '.zip', '.tar', '.gz', '.xz', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.psd', '.ai', '.sketch', '.vsix', '.wasm', '.class', '.o', '.obj', '.pyc', '.pyo', '.sqlite', '.db', '.mdb']);
const SEARCH_MAX_FILE = 5 * 1024 * 1024;
const SEARCH_MAX_FILES = 200000;
const SEARCH_SCAN_CONCURRENCY = 8;
const SEARCH_CONCURRENCY = 16;
const SEARCH_MAX_DEPTH = 20;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════
interface SearchMatch {
    file: string;
    line: number;
    col: number;
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

interface RipgrepEntry {
    type: 'match' | 'context';
    file: string;
    line: number;
    col?: number;
    text: string;
}

// ═══════════════════════════════════════════════════════════════
// ripgrep binary finder
// ═══════════════════════════════════════════════════════════════
function _findRipgrep(): string | null {
    const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const tries: string[] = [];

    // 1. Components dir (userData)
    try {
        const ud = app.getPath('userData');
        tries.push(path.join(ud, 'components', 'ripgrep', rgName));
    } catch { /* app not ready yet */ }

    // 2. App resources (packaged)
    try {
        if ((process as any).resourcesPath) {
            tries.push(path.join((process as any).resourcesPath, 'components', 'ripgrep', rgName));
        }
    } catch { /* n/a */ }

    // 3. engines/ dir (dev mode, relative to shell-out/)
    tries.push(path.join(__dirname, '..', 'engines', 'ripgrep', rgName));
    tries.push(path.join(__dirname, '..', '..', 'engines', 'ripgrep', rgName));

    for (const p of tries) {
        try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
    }

    // 4. PATH (return bare name — spawn will search)
    return rgName;
}

// ═══════════════════════════════════════════════════════════════
// ripgrep search (Tier 1)
// ═══════════════════════════════════════════════════════════════
async function _tryRipgrepSearch(
    searchPath: string,
    query: string,
    isRegex: boolean,
    caseSensitive: boolean,
    wholeWord: boolean,
    includePattern: string | undefined,
    excludePattern: string | undefined,
    contextLines: number,
    maxResults: number,
    timeoutMs: number,
    respectGitignore: boolean,
): Promise<SearchResult | null> {

    const rgPath = _findRipgrep();
    if (!rgPath) return null;

    const startTime = Date.now();
    const args: string[] = [
        '--json',
        '--no-heading',
        '--with-filename',
        '--line-number',
        '--column',
        '--color', 'never',
        '--max-depth', String(SEARCH_MAX_DEPTH),
        '--max-filesize', String(Math.round(SEARCH_MAX_FILE / (1024 * 1024))) + 'M',
    ];

    if (!caseSensitive) args.push('--ignore-case');
    if (wholeWord) args.push('--word-regexp');
    if (!isRegex) args.push('--fixed-strings');
    if (!respectGitignore) args.push('--no-ignore');
    // Always skip VCS dirs + node_modules (safety net)
    args.push('--glob', '!.git');
    args.push('--glob', '!node_modules');

    if (includePattern) {
        for (const p of includePattern.split(',').map(s => s.trim()).filter(Boolean)) {
            args.push('--glob', p);
        }
    }
    if (excludePattern) {
        for (const p of excludePattern.split(',').map(s => s.trim()).filter(Boolean)) {
            args.push('--glob', '!' + p);
        }
    }
    if (contextLines > 0) {
        args.push('--context', String(contextLines));
    }
    // max-count in ripgrep is per-file limit; we cap total ourselves
    args.push('--regexp', query);
    args.push(searchPath);

    return new Promise((resolve) => {
        let rg: ChildProcess;
        try {
            rg = spawn(rgPath, args, {
                cwd: searchPath,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch {
            return resolve(null);
        }

        let stdout = '';
        let stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
            killed = true;
            try { rg.kill('SIGTERM'); } catch { /* ignore */ }
            // SIGKILL after 2s grace
            setTimeout(() => { try { rg.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
        }, timeoutMs);

        rg.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        rg.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

        rg.on('error', () => {
            clearTimeout(timer);
            resolve(null);
        });

        rg.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (killed) {
                // Partial results if we got some output before timeout
                if (stdout.length > 0) {
                    const parsed = _parseRipgrepJson(stdout, maxResults, contextLines, searchPath);
                    parsed.elapsed = Date.now() - startTime;
                    parsed.truncated = true;
                    return resolve(parsed);
                }
                return resolve(null);
            }
            // code 0 = matches found, code 1 = no matches, code 2 = error
            if (code === 2) {
                // Try to parse partial output anyway (some errors are non-fatal)
                if (stdout.length > 0) {
                    const parsed = _parseRipgrepJson(stdout, maxResults, contextLines, searchPath);
                    parsed.elapsed = Date.now() - startTime;
                    return resolve(parsed);
                }
                return resolve(null);
            }
            const parsed = _parseRipgrepJson(stdout, maxResults, contextLines, searchPath);
            parsed.elapsed = Date.now() - startTime;
            // Count files scanned from unique paths in raw output
            const fileSet = new Set<string>();
            for (const line of stdout.split('\n')) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.data && obj.data.path && obj.data.path.text) {
                        fileSet.add(obj.data.path.text);
                    }
                } catch { /* skip unparseable */ }
            }
            parsed.filesScanned = fileSet.size;
            resolve(parsed);
        });
    });
}

function _parseRipgrepJson(
    raw: string,
    maxResults: number,
    contextLines: number,
    _searchPath: string,
): SearchResult {
    const fileEntries = new Map<string, RipgrepEntry[]>();
    const seenFiles = new Set<string>();

    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (!obj || !obj.type) continue;

            if (obj.type === 'begin' || obj.type === 'match' || obj.type === 'context') {
                const fpath = (obj.data && obj.data.path && obj.data.path.text) || '';
                if (!fpath) continue;
                seenFiles.add(fpath);

                if (obj.type === 'match') {
                    const lineNum: number = obj.data.line_number || 0;
                    const text: string = (obj.data.lines && obj.data.lines.text) || '';
                    const submatch = obj.data.submatches && obj.data.submatches[0];
                    const col = submatch ? (submatch.start || 0) + 1 : 1;
                    const cleanText = text.replace(/\r?\n$/, '').slice(0, 300);

                    if (!fileEntries.has(fpath)) fileEntries.set(fpath, []);
                    fileEntries.get(fpath)!.push({
                        type: 'match',
                        file: fpath,
                        line: lineNum,
                        col,
                        text: cleanText,
                    });
                } else if (obj.type === 'context' && contextLines > 0) {
                    const lineNum: number = obj.data.line_number || 0;
                    const text: string = (obj.data.lines && obj.data.lines.text) || '';
                    const cleanText = text.replace(/\r?\n$/, '').slice(0, 200);

                    if (!fileEntries.has(fpath)) fileEntries.set(fpath, []);
                    fileEntries.get(fpath)!.push({
                        type: 'context',
                        file: fpath,
                        line: lineNum,
                        text: cleanText,
                    });
                }
            }
        } catch { /* skip malformed JSON lines */ }
    }

    // Build results with before/after context
    const results: SearchMatch[] = [];
    for (const [, entries] of fileEntries) {
        // Group: first collect all match lines, then for each match assign context
        const matches = entries.filter(e => e.type === 'match');
        const contexts = entries.filter(e => e.type === 'context');

        for (const m of matches) {
            const before: string[] = [];
            const after: string[] = [];

            for (const c of contexts) {
                const dist = c.line - m.line;
                if (dist < 0 && Math.abs(dist) <= contextLines) {
                    before.push(c.text);
                } else if (dist > 0 && dist <= contextLines) {
                    after.push(c.text);
                }
            }

            // Dedup: only keep first match per line per file
            const dup = results.find(r => r.file === m.file && r.line === m.line);
            if (dup) continue;

            if (results.length >= maxResults) break;

            const match: SearchMatch = {
                file: m.file,
                line: m.line,
                col: m.col || 1,
                text: m.text,
            };
            if (before.length > 0) match.before = before;
            if (after.length > 0) match.after = after;
            results.push(match);
        }
    }

    // Quick fileStats for matched files (mtime/size for sort UI)
    const fileStats: Record<string, { mtime: number; birthtime: number; size: number }> = {};
    const uniqueFiles = new Set(results.map(r => r.file));
    for (const fp of uniqueFiles) {
        try {
            const absFp = path.join(_searchPath, fp);
            const st = fs.statSync(absFp);
            fileStats[fp] = { mtime: st.mtimeMs, birthtime: st.birthtimeMs, size: st.size };
        } catch { /* skip */ }
    }

    return {
        results,
        total: results.length,
        elapsed: 0, // filled by caller
        filesScanned: seenFiles.size,
        truncated: results.length >= maxResults,
        fileStats,
    };
}

// ═══════════════════════════════════════════════════════════════
// JS fallback search (Tier 2) — original implementation
// ═══════════════════════════════════════════════════════════════

// ---- glob pattern to regex ----
function globToRegex(pattern: string): RegExp {
    const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '[[GLOBSTAR]]')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/\?/g, '[^/\\\\]')
        .replace(/\[\[GLOBSTAR\]\]/g, '.*');
    return new RegExp('^' + re + '$', 'i');
}

// ---- .gitignore parser ----
function parseIgnoreFile(content: string): (rel: string, isDir: boolean) => boolean {
    const rules: Array<{ pattern: RegExp; negate: boolean; dirOnly: boolean }> = [];
    for (const raw of content.split('\n')) {
        let line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        let negate = false;
        if (line.startsWith('!')) { negate = true; line = line.slice(1); }
        const dirOnly = line.endsWith('/');
        if (dirOnly) line = line.slice(0, -1);
        let pattern = line.replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '[[GLOBSTAR]]')
            .replace(/\*/g, '[^/]*')
            .replace(/\[\[GLOBSTAR\]\]/g, '.*')
            .replace(/\?/g, '[^/]');
        if (!pattern.startsWith('/')) pattern = '(^|/)' + pattern;
        rules.push({ pattern: new RegExp(pattern), negate, dirOnly });
    }
    return (rel: string, isDir: boolean): boolean => {
        let ignored = false;
        for (const r of rules) {
            if (r.dirOnly && !isDir) continue;
            if (r.pattern.test('/' + rel)) {
                ignored = !r.negate;
            }
        }
        return ignored;
    };
}

async function _collectFilesJs(
    searchPath: string,
    respectGitignore: boolean,
    includeMatchers: RegExp[],
    excludeMatchers: RegExp[],
): Promise<string[]> {
    const files: string[] = [];
    const rootNorm = searchPath.replace(/\\/g, '/').replace(/\/$/, '');

    let gitignoreTest: ((rel: string, isDir: boolean) => boolean) | null = null;
    if (respectGitignore) {
        for (const ignName of ['.gitignore', '.qqqignore']) {
            const ignPath = path.join(searchPath, ignName);
            try {
                if (fs.existsSync(ignPath)) {
                    gitignoreTest = parseIgnoreFile(fs.readFileSync(ignPath, 'utf8'));
                    break;
                }
            } catch { /* ignore */ }
        }
    }

    async function walk(dir: string, depth: number): Promise<void> {
        if (files.length >= SEARCH_MAX_FILES) return;
        if (depth > SEARCH_MAX_DEPTH) return;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch { return; }

        const subdirs: string[] = [];
        for (const ent of entries) {
            if (files.length >= SEARCH_MAX_FILES) return;
            const full = path.join(dir, ent.name);
            const rel = full.replace(/\\/g, '/').slice(rootNorm.length + 1);

            if (ent.isDirectory()) {
                if (SEARCH_SKIP_DIRS.has(ent.name)) continue;
                if (ent.name.startsWith('.') && ent.name !== '.') continue;
                if (gitignoreTest && gitignoreTest(rel, true)) continue;
                if (excludeMatchers.some(m => m.test(rel) || m.test(rel + '/'))) continue;
                subdirs.push(full);
            } else if (ent.isFile() || ent.isSymbolicLink()) {
                const ext = path.extname(ent.name).toLowerCase();
                if (SEARCH_BINARY_EXTS.has(ext)) continue;
                if (gitignoreTest && gitignoreTest(rel, false)) continue;
                if (includeMatchers.length > 0 && !includeMatchers.some(m => m.test(ent.name) || m.test(rel))) continue;
                if (excludeMatchers.some(m => m.test(ent.name) || m.test(rel))) continue;
                files.push(full);
            }
        }

        for (let i = 0; i < subdirs.length; i += SEARCH_SCAN_CONCURRENCY) {
            const batch = subdirs.slice(i, i + SEARCH_SCAN_CONCURRENCY);
            await Promise.all(batch.map(d => walk(d, depth + 1)));
        }
    }

    await walk(searchPath, 0);
    return files;
}

// ═══════════════════════════════════════════════════════════════
// IPC registration
// ═══════════════════════════════════════════════════════════════
export function registerSearchIpc(): void {

    // ── qqqide:search:query ──
    ipcMain.handle('qqqide:search:query', async (_e, args: {
        query: string;
        searchPath?: string;
        rootDir?: string;
        isRegex?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        includePattern?: string;
        excludePattern?: string;
        contextLines?: number;
        maxResults?: number;
        timeoutMs?: number;
        respectGitignore?: boolean;
    }): Promise<SearchResult> => {

        const searchPath = args.searchPath || args.rootDir || '';
        const { query, isRegex = false, caseSensitive = false, wholeWord = false,
            contextLines = 1, maxResults = 5000, timeoutMs = 60000,
            respectGitignore = false } = args;

        if (!searchPath || !query) return { error: 'missing query or searchPath', results: [], total: 0, elapsed: 0, filesScanned: 0, truncated: false, fileStats: {} };

        // ── Tier 1: try ripgrep ──
        const rgResult = await _tryRipgrepSearch(
            searchPath, query, isRegex, caseSensitive, wholeWord,
            args.includePattern, args.excludePattern,
            contextLines, maxResults, timeoutMs, respectGitignore,
        );
        if (rgResult) return rgResult;

        // ── Tier 2: JS fallback ──
        const startTime = Date.now();

        let pattern: string;
        if (isRegex) {
            pattern = query;
        } else {
            pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        if (wholeWord) pattern = '\\b' + pattern + '\\b';
        let regex: RegExp;
        try { regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi'); }
        catch { return { error: 'invalid regex: ' + query, results: [], total: 0, elapsed: 0, filesScanned: 0, truncated: false, fileStats: {} }; }

        const includeMatchers: RegExp[] = [];
        const excludeMatchers: RegExp[] = [];
        if (args.includePattern) {
            for (const p of args.includePattern.split(',').map(s => s.trim()).filter(Boolean)) {
                try { includeMatchers.push(globToRegex(p)); } catch { /* ignore */ }
            }
        }
        if (args.excludePattern) {
            for (const p of args.excludePattern.split(',').map(s => s.trim()).filter(Boolean)) {
                try { excludeMatchers.push(globToRegex(p)); } catch { /* ignore */ }
            }
        }

        const allFiles = await _collectFilesJs(searchPath, respectGitignore, includeMatchers, excludeMatchers);
        const fileStats = new Map<string, { mtime: number; birthtime: number; size: number }>();

        const results: SearchMatch[] = [];
        let totalMatches = 0;
        let aborted = false;
        const rootNorm = searchPath.replace(/\\/g, '/').replace(/\/$/, '');

        let fileIdx = 0;
        async function worker(): Promise<void> {
            while (!aborted) {
                const idx = fileIdx++;
                if (idx >= allFiles.length) return;
                if (totalMatches >= maxResults) { aborted = true; return; }
                if (Date.now() - startTime > timeoutMs) { aborted = true; return; }

                const fpath = allFiles[idx];
                try {
                    const st = await fs.promises.stat(fpath);
                    if (st.size > SEARCH_MAX_FILE) continue;

                    const relPath = fpath.replace(/\\/g, '/').slice(rootNorm.length + 1);
                    fileStats.set(relPath, { mtime: st.mtimeMs, birthtime: st.birthtimeMs, size: st.size });

                    const content = await fs.promises.readFile(fpath, 'utf8');
                    const lines = content.split('\n');

                    let m: RegExpExecArray | null;
                    const perFileResults: SearchMatch[] = [];

                    for (let li = 0; li < lines.length; li++) {
                        regex.lastIndex = 0;
                        while ((m = regex.exec(lines[li])) !== null) {
                            totalMatches++;
                            if (totalMatches > maxResults) { aborted = true; break; }

                            const match: SearchMatch = {
                                file: relPath,
                                line: li + 1,
                                col: m.index + 1,
                                text: lines[li].trim().slice(0, 300),
                            };

                            if (contextLines > 0) {
                                const before: string[] = [];
                                for (let b = 1; b <= contextLines && li - b >= 0; b++) {
                                    before.unshift(lines[li - b].trim().slice(0, 200));
                                }
                                if (before.length > 0) match.before = before;

                                const after: string[] = [];
                                for (let a = 1; a <= contextLines && li + a < lines.length; a++) {
                                    after.push(lines[li + a].trim().slice(0, 200));
                                }
                                if (after.length > 0) match.after = after;
                            }

                            perFileResults.push(match);
                            if (m[0].length === 0) regex.lastIndex++;
                        }
                        if (aborted) break;
                    }

                    const seenLines = new Set<number>();
                    for (const r of perFileResults) {
                        if (!seenLines.has(r.line)) {
                            seenLines.add(r.line);
                            results.push(r);
                        }
                    }
                } catch {
                    // skip unreadable files
                }
            }
        }

        const workers: Promise<void>[] = [];
        for (let w = 0; w < SEARCH_CONCURRENCY; w++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        return {
            results: results.slice(0, maxResults),
            total: totalMatches,
            elapsed: Date.now() - startTime,
            filesScanned: allFiles.length,
            truncated: aborted || totalMatches >= maxResults || allFiles.length >= SEARCH_MAX_FILES,
            fileStats: Object.fromEntries(fileStats),
        };
    });

    // ── qqqide:search:replace ──
    ipcMain.handle('qqqide:search:replace', async (_e, args: {
        replacements?: Array<{ file: string; line: number; col: number; matchLen: number; replacement: string }>;
        files?: string[];
        find?: string;
        replace?: string;
        useRegex?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
    }) => {
        if (args.replacements && Array.isArray(args.replacements) && args.replacements.length > 0) {
            const byFile = new Map<string, Array<{ line: number; col: number; matchLen: number; replacement: string }>>();
            for (const r of args.replacements) {
                if (!byFile.has(r.file)) byFile.set(r.file, []);
                byFile.get(r.file)!.push(r);
            }

            let totalReplaced = 0;
            let filesChanged = 0;
            const errors: string[] = [];

            for (const [fpath, reps] of byFile) {
                try {
                    reps.sort((a, b) => b.line - a.line || b.col - a.col);
                    const content = await fs.promises.readFile(fpath, 'utf8');
                    const lines = content.split('\n');
                    let changed = false;

                    for (const rep of reps) {
                        const li = rep.line - 1;
                        if (li < 0 || li >= lines.length) continue;
                        const col0 = rep.col - 1;
                        const line = lines[li];
                        if (col0 + rep.matchLen > line.length) continue;
                        lines[li] = line.slice(0, col0) + rep.replacement + line.slice(col0 + rep.matchLen);
                        changed = true;
                        totalReplaced++;
                    }

                    if (changed) {
                        await fs.promises.writeFile(fpath, lines.join('\n'), 'utf8');
                        filesChanged++;
                    }
                } catch (e: any) {
                    errors.push(fpath + ': ' + (e.message || e));
                }
            }
            return { replaced: totalReplaced, files: filesChanged, errors };
        }

        const { files, find, replace: replaceText, useRegex = false, caseSensitive = false, wholeWord = false } = args;
        if (!files || !find) return { replaced: 0, files: 0, errors: [] };

        let pattern: RegExp;
        try {
            let flags = 'g';
            if (!caseSensitive) flags += 'i';
            if (useRegex) {
                pattern = new RegExp(find, flags);
            } else {
                let esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (wholeWord) esc = '\\b' + esc + '\\b';
                pattern = new RegExp(esc, flags);
            }
        } catch (e: any) {
            return { replaced: 0, files: 0, errors: [e.message] };
        }

        let totalReplaced = 0;
        let filesChanged = 0;
        const errors: string[] = [];

        for (const fp of files) {
            try {
                const content = await fs.promises.readFile(fp, 'utf8');
                const newContent = content.replace(pattern, replaceText);
                if (newContent !== content) {
                    await fs.promises.writeFile(fp, newContent, 'utf8');
                    totalReplaced += (content.match(pattern) || []).length;
                    filesChanged++;
                }
            } catch (e: any) {
                errors.push(fp + ': ' + (e.message || e));
            }
        }
        return { replaced: totalReplaced, files: filesChanged, errors };
    });
}
