// ============================================================================
// ipc-search.ts — qqqide:search 搜索引擎 (ripgrep 专线)
//
// 唯一引擎: ripgrep 14.x (Rust · mmap零拷贝 · SIMD正则 · 多线程 · PCRE2 JIT)
// 未找到 ripgrep → 返回清晰错误提示 "ripgrep 未安装，运行 components.py ensure ripgrep"
// 跨平台: win/linux/mac 各一个独立二进制，零运行时依赖
//
// 响应格式: { results: [{file, line, col, text, before[], after[]}],
//              total, elapsed, filesScanned, truncated, fileStats }
// ============================================================================

import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════
const SEARCH_MAX_DEPTH = 20;
const SEARCH_MAX_FILE_MB = 5;

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

// ═══════════════════════════════════════════════════════════════
// ripgrep binary finder
// ═══════════════════════════════════════════════════════════════
function _findRipgrep(): string | null {
    const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const tries: string[] = [];

    // 1. Components dir (userData/components/ripgrep/) — downloaded by components.py
    try { tries.push(path.join(app.getPath('userData'), 'components', 'ripgrep', rgName)); } catch { /* app not ready */ }

    // 2. engines/ripgrep/ (dev + packaged — __dirname relative to shell-out/main.js)
    //    Dev:  __dirname = shell-out/  → ../engines/ripgrep/rg.exe = project/engines/ripgrep/rg.exe ✅
    //    Pkg:  __dirname = resources/app/shell-out/  → ../engines/ripgrep/rg.exe = resources/app/engines/ripgrep/rg.exe ✅
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

    for (const p of tries) {
        try { if (fs.existsSync(p)) { console.log('[search] ripgrep found:', p); return p; } } catch { /* skip */ }
    }

    // 4. PATH (bare name — spawn will search PATH for brew/apt/choco installs)
    console.log('[search] ripgrep not found in known paths, trying PATH:', rgName);
    return rgName;
}

// ═══════════════════════════════════════════════════════════════
// ripgrep search
// ═══════════════════════════════════════════════════════════════
async function _ripgrepSearch(
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
    matchFilenames: boolean,
): Promise<SearchResult> {

    const rgPath = _findRipgrep();
    if (!rgPath) {
        return { error: 'ripgrep 未安装。运行: python op/components.py ensure ripgrep', results: [], total: 0, elapsed: 0, filesScanned: 0, truncated: false, fileStats: {} };
    }

    const startTime = Date.now();
    console.log('[search] spawning ripgrep:', rgPath, 'query:', query.slice(0, 80));
    const args: string[] = [
        '--json',
        '--no-heading',
        '--with-filename',
        '--line-number',
        '--column',
        '--color', 'never',
        '--max-depth', String(SEARCH_MAX_DEPTH),
        '--max-filesize', String(SEARCH_MAX_FILE_MB) + 'M',
    ];

    // Multiline detection: query contains \n or actual newline → enable ripgrep multiline
    let actualQuery = query;
    let forceRegex = false;
    const hasNewline = query.indexOf('\\n') !== -1 || query.indexOf('\n') !== -1;
    if (hasNewline) {
        args.push('--multiline');
        args.push('--crlf');
        actualQuery = query.replace(/\\n/g, '\n');
        // --fixed-strings conflicts with --multiline; force regex mode
        if (!isRegex) {
            forceRegex = true;
            // Escape the fixed string for regex (but preserve actual newlines)
            actualQuery = actualQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (wholeWord) actualQuery = '\\b' + actualQuery + '\\b';
        }
    }

    if (!caseSensitive) args.push('--ignore-case');
    if (wholeWord && !forceRegex) args.push('--word-regexp');
    if (!isRegex && !forceRegex) args.push('--fixed-strings');
    if (!respectGitignore) args.push('--no-ignore');
    // Always skip VCS dirs + node_modules
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

    args.push('--regexp', actualQuery);
    args.push(searchPath);

    return new Promise((resolve) => {
        let rg: ChildProcess;
        try {
            rg = spawn(rgPath, args, {
                cwd: searchPath,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (e: any) {
            return resolve({ error: '无法启动 ripgrep: ' + (e.message || e), results: [], total: 0, elapsed: 0, filesScanned: 0, truncated: false, fileStats: {} });
        }

        let stdout = '';
        let killed = false;

        const timer = setTimeout(() => {
            killed = true;
            try { rg.kill('SIGTERM'); } catch { /* ignore */ }
            setTimeout(() => { try { rg.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
        }, timeoutMs);

        rg.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        // stderr consumed but not parsed (ripgrep outputs everything on stdout in --json mode)
        let stderr = '';
        rg.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

        rg.on('error', (err: Error) => {
            clearTimeout(timer);
            resolve({ error: 'ripgrep 进程错误: ' + err.message, results: [], total: 0, elapsed: 0, filesScanned: 0, truncated: false, fileStats: {} });
        });

        rg.on('close', async (code: number | null) => {
            clearTimeout(timer);

            if (killed || code === null && stdout.length === 0) {
                if (stdout.length > 0) {
                    const parsed = _parseRgJson(stdout, maxResults, contextLines, searchPath);
                    parsed.elapsed = Date.now() - startTime;
                    parsed.truncated = true;
                    return resolve(parsed);
                }
                return resolve({ error: '搜索超时', results: [], total: 0, elapsed: Date.now() - startTime, filesScanned: 0, truncated: true, fileStats: {} });
            }

            // code 0 = matches found, code 1 = no matches, code 2 = fatal error
            if (code === 2 && stdout.length === 0) {
                // Try to extract useful message from stderr
                const errMsg = stderr.split('\n').filter(Boolean).slice(-2).join('; ') || 'ripgrep 退出码 2';
                return resolve({ error: errMsg, results: [], total: 0, elapsed: Date.now() - startTime, filesScanned: 0, truncated: false, fileStats: {} });
            }

            const parsed = _parseRgJson(stdout, maxResults, contextLines, searchPath);
            parsed.elapsed = Date.now() - startTime;

            // Count files scanned from unique paths in raw output
            const fileSet = new Set<string>();
            for (const line of stdout.split('\n')) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.data && obj.data.path && obj.data.path.text) {
                        fileSet.add(obj.data.path.text);
                    }
                } catch { /* skip */ }
            }
            parsed.filesScanned = fileSet.size;

            // Filename matching — second pass
            if (matchFilenames && parsed.results.length < maxResults && !parsed.error) {
                try {
                    const fnameMatches = await _rgFilenameSearch(
                        searchPath, query, isRegex, caseSensitive, wholeWord,
                        includePattern, excludePattern, respectGitignore,
                        maxResults - parsed.results.length,
                    );
                    const existingFiles = new Set(parsed.results.map(r => r.file));
                    for (const m of fnameMatches.matches) {
                        if (!existingFiles.has(m.file)) {
                            parsed.results.push(m);
                            existingFiles.add(m.file);
                        }
                    }
                    parsed.total = parsed.results.length;
                    Object.assign(parsed.fileStats, fnameMatches.fileStats);
                } catch { /* filename search best-effort */ }
            }

            resolve(parsed);
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// Filename search — second pass via rg --files
// ═══════════════════════════════════════════════════════════════
async function _rgFilenameSearch(
    searchPath: string,
    query: string,
    isRegex: boolean,
    caseSensitive: boolean,
    wholeWord: boolean,
    includePattern: string | undefined,
    excludePattern: string | undefined,
    respectGitignore: boolean,
    maxResults: number,
): Promise<{ matches: SearchMatch[]; fileStats: Record<string, { mtime: number; birthtime: number; size: number }> }> {
    const rgPath = _findRipgrep();
    if (!rgPath) return { matches: [], fileStats: {} };

    const args: string[] = ['--files', '--no-heading', '--max-depth', String(SEARCH_MAX_DEPTH)];
    if (!respectGitignore) args.push('--no-ignore');
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
    args.push(searchPath);

    return new Promise((resolve) => {
        let stdout = '';
        try {
            const child = spawn(rgPath, args, { cwd: searchPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);

            child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
            child.on('close', () => {
                clearTimeout(timer);
                const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean);
                const matches: SearchMatch[] = [];
                const fileStats: Record<string, { mtime: number; birthtime: number; size: number }> = {};

                // Build filename matcher
                let fnameMatcher: (name: string) => boolean;
                if (isRegex) {
                    try {
                        const re = new RegExp(query, caseSensitive ? '' : 'i');
                        fnameMatcher = (n) => re.test(n);
                    } catch { fnameMatcher = () => false; }
                } else if (wholeWord) {
                    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp('\\b' + esc + '\\b', caseSensitive ? '' : 'i');
                    fnameMatcher = (n) => re.test(n);
                } else {
                    const q = caseSensitive ? query : query.toLowerCase();
                    fnameMatcher = (n) => (caseSensitive ? n : n.toLowerCase()).indexOf(q) !== -1;
                }

                const searchNorm = searchPath.replace(/\\/g, '/').replace(/\/$/, '');
                for (const rawPath of lines) {
                    if (matches.length >= maxResults) break;
                    const relPath = rawPath.replace(/\\/g, '/');
                    const displayPath = relPath.startsWith(searchNorm + '/') ? relPath.slice(searchNorm.length + 1) : relPath;
                    const fname = path.basename(displayPath);

                    if (fnameMatcher(fname)) {
                        const absFp = path.join(searchPath, displayPath);
                        matches.push({ file: displayPath, line: 1, col: 1, matchText: fname, text: fname });
                        // Quick stat
                        try {
                            const st = fs.statSync(absFp);
                            fileStats[displayPath] = { mtime: st.mtimeMs, birthtime: st.birthtimeMs, size: st.size };
                        } catch { /* skip */ }
                    }
                }
                resolve({ matches, fileStats });
            });
            child.on('error', () => resolve({ matches: [], fileStats: {} }));
        } catch { resolve({ matches: [], fileStats: {} }); }
    });
}

// ═══════════════════════════════════════════════════════════════
// ripgrep --json output parser
// ═══════════════════════════════════════════════════════════════
function _parseRgJson(
    raw: string,
    maxResults: number,
    contextLines: number,
    _searchPath: string,
): SearchResult {
    const fileEntries = new Map<string, Array<{ type: 'match' | 'context'; line: number; col?: number; matchLen?: number; matchText?: string; text: string }>>();
    const seenFiles = new Set<string>();

    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (!obj || !obj.type) continue;
            if (obj.type === 'summary' || obj.type === 'end') continue;

            const fpath: string = (obj.data && obj.data.path && obj.data.path.text) || '';
            if (!fpath) continue;
            seenFiles.add(fpath);

            const relPath = fpath.replace(/\\/g, '/');
            // Strip the search path prefix to get relative path
            const searchNorm = _searchPath.replace(/\\/g, '/').replace(/\/$/, '');
            const displayPath = relPath.startsWith(searchNorm + '/') ? relPath.slice(searchNorm.length + 1) : relPath;

            if (obj.type === 'match') {
                const lineNum: number = obj.data.line_number || 0;
                const text: string = (obj.data.lines && obj.data.lines.text) || '';
                const submatch = obj.data.submatches && obj.data.submatches[0];
                const matchText = (submatch && submatch.match && submatch.match.text) || '';
                const cleanText = text.replace(/\r?\n$/, '');
                // ripgrep returns byte offsets — convert to character offsets for JS slicing
                let col = 1, matchLen = matchText.length;
                if (submatch && cleanText && (submatch.start || 0) > 0) {
                    const lineBuf = Buffer.from(cleanText, 'utf8');
                    const byteStart: number = submatch.start || 0;
                    if (byteStart < lineBuf.length) {
                        col = lineBuf.slice(0, byteStart).toString('utf8').length + 1;
                    } else if (matchText) {
                        const ci = cleanText.indexOf(matchText);
                        if (ci !== -1) col = ci + 1;
                    }
                }
                const displayText = cleanText.slice(0, 300);

                if (!fileEntries.has(displayPath)) fileEntries.set(displayPath, []);
                fileEntries.get(displayPath)!.push({ type: 'match', file: displayPath, line: lineNum, col, matchText, matchLen, text: displayText });
            } else if (obj.type === 'context' && contextLines > 0) {
                const lineNum: number = obj.data.line_number || 0;
                const text: string = (obj.data.lines && obj.data.lines.text) || '';
                const cleanText = text.replace(/\r?\n$/, '').slice(0, 200);

                if (!fileEntries.has(displayPath)) fileEntries.set(displayPath, []);
                fileEntries.get(displayPath)!.push({ type: 'context', file: displayPath, line: lineNum, text: cleanText });
            }
        } catch { /* skip malformed JSON */ }
    }

    // Build results with context assignment
    const results: SearchMatch[] = [];
    for (const [filePath, entries] of fileEntries) {
        const matches = entries.filter(e => e.type === 'match');
        const contexts = entries.filter(e => e.type === 'context');

        for (const m of matches) {
            if (results.length >= maxResults) break;

            const match: SearchMatch = { file: filePath, line: m.line, col: m.col || 1, matchLen: m.matchLen, matchText: m.matchText, text: m.text };

            if (contextLines > 0) {
                const before = contexts.filter(c => c.line < m.line && m.line - c.line <= contextLines)
                    .sort((a, b) => a.line - b.line).map(c => c.text);
                const after = contexts.filter(c => c.line > m.line && c.line - m.line <= contextLines)
                    .sort((a, b) => a.line - b.line).map(c => c.text);
                if (before.length > 0) match.before = before;
                if (after.length > 0) match.after = after;
            }

            results.push(match);
        }
    }

    // Quick fileStats for matched files
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
        matchFilenames?: boolean;
    }): Promise<SearchResult> => {

        const searchPath = args.searchPath || args.rootDir || '';
        const { query, isRegex = false, caseSensitive = false, wholeWord = false,
            contextLines = 1, maxResults = 5000, timeoutMs = 60000,
            respectGitignore = false } = args;

        if (!searchPath || !query) {
            return { error: '缺少搜索关键词或搜索路径', results: [], total: 0, elapsed: 0, filesScanned: 0, truncated: false, fileStats: {} };
        }

        return await _ripgrepSearch(
            searchPath, query, isRegex, caseSensitive, wholeWord,
            args.includePattern, args.excludePattern,
            contextLines, maxResults, timeoutMs, respectGitignore,
            args.matchFilenames !== false,
        );
    });

    // ── qqqide:search:replace ──
    ipcMain.handle('qqqide:search:replace', async (_e, args: {
        replacements?: Array<{ file: string; line: number; col: number; matchLen: number; replacement: string; matchText?: string }>;
        searchPath?: string;
        files?: string[];
        find?: string;
        replace?: string;
        useRegex?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
    }) => {
        // Per-match replacements (primary API)
        if (args.replacements && Array.isArray(args.replacements) && args.replacements.length > 0) {
            const searchPath = args.searchPath || '';
            const byFile = new Map<string, Array<{ line: number; col: number; matchLen: number; replacement: string; matchText?: string }>>();
            for (const r of args.replacements) {
                if (!byFile.has(r.file)) byFile.set(r.file, []);
                byFile.get(r.file)!.push(r);
            }

            let totalReplaced = 0, filesChanged = 0, processed = 0;
            const totalFiles = byFile.size;
            const errors: string[] = [];

            for (const [fpath, reps] of byFile) {
                try {
                    // Resolve relative paths against searchPath
                    const absFp = path.isAbsolute(fpath) ? fpath : path.join(searchPath, fpath);
                    reps.sort((a, b) => b.line - a.line || b.col - a.col); // reverse: stable offsets
                    const content = await fs.promises.readFile(absFp, 'utf8');
                    const lines = content.split('\n');
                    let changed = false;

                    for (const rep of reps) {
                        const li = rep.line - 1;
                        if (li < 0 || li >= lines.length) continue;
                        const line = lines[li];
                        const mt: string = rep.matchText || '';
                        let idx = -1, len = rep.matchLen;
                        // Use matchText to locate — robust against byte/char offset mismatch
                        if (mt) {
                            len = mt.length;
                            // col is character offset from _parseRgJson (byte→char converted).
                            // Use it as the search start to disambiguate same-line multiple matches.
                            const startPos = Math.max(0, (rep.col || 1) - 1);
                            idx = line.indexOf(mt, startPos);
                            if (idx === -1) idx = line.indexOf(mt);
                        }
                        if (idx === -1) {
                            // No matchText — fall back to col-based (char offsets from _parseRgJson)
                            const col0 = rep.col - 1;
                            if (col0 + rep.matchLen > line.length) continue;
                            idx = col0;
                        }
                        if (idx + len > line.length) continue;
                        lines[li] = line.slice(0, idx) + rep.replacement + line.slice(idx + len);
                        changed = true;
                        totalReplaced++;
                    }

                    if (changed) {
                        await fs.promises.writeFile(absFp, lines.join('\n'), 'utf8');
                        filesChanged++;
                    }
                } catch (e: any) {
                    errors.push(fpath + ': ' + (e.message || e));
                }
                processed++;
                if (_e.sender && !_e.sender.isDestroyed()) {
                    _e.sender.send('qqqide:search:replace:progress', {
                        current: processed, total: totalFiles, file: fpath,
                        replaced: totalReplaced, errors: errors.slice(),
                    });
                }
            }
            return { replaced: totalReplaced, files: filesChanged, errors };
        }

        // Legacy batch regex replace
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

        let totalReplaced = 0, filesChanged = 0;
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
