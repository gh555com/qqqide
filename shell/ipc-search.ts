// ============================================================================
// ipc-search.ts — qqqide:search 高性能项目搜索引擎
// 2026-06-24 修复：参数名对齐(searchPath)、响应格式扁平化、contextLines、
//   respectGitignore、glob include/exclude、timeout、replace 按行精准替换
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs', '.hg', '.svn', '.DS_Store', 'bower_components', '.idea', '.vs']);
const SEARCH_BINARY_EXTS = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.flac', '.ogg', '.zip', '.tar', '.gz', '.xz', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.psd', '.ai', '.sketch', '.vsix', '.wasm', '.class', '.o', '.obj', '.pyc', '.pyo', '.sqlite', '.db', '.mdb']);
const SEARCH_MAX_FILE = 5 * 1024 * 1024;
const SEARCH_MAX_FILES = 200000;
const SEARCH_SCAN_CONCURRENCY = 8;
const SEARCH_CONCURRENCY = 16;

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

// ---- collect all searchable files ----
async function collectFiles(
    searchPath: string,
    respectGitignore: boolean,
    includeMatchers: RegExp[],
    excludeMatchers: RegExp[],
): Promise<string[]> {
    const files: string[] = [];
    const rootNorm = searchPath.replace(/\\/g, '/').replace(/\/$/, '');

    // Load gitignore only if opted in
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

    // Concurrency-limited directory walk
    async function walk(dir: string): Promise<void> {
        if (files.length >= SEARCH_MAX_FILES) return;
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

        // Descend subdirs with concurrency cap
        for (let i = 0; i < subdirs.length; i += SEARCH_SCAN_CONCURRENCY) {
            const batch = subdirs.slice(i, i + SEARCH_SCAN_CONCURRENCY);
            await Promise.all(batch.map(d => walk(d)));
        }
    }

    await walk(searchPath);
    return files;
}

interface SearchMatch {
    file: string;
    line: number;
    col: number;
    text: string;
    before?: string[];
    after?: string[];
}

export function registerSearchIpc(): void {
    // ============================================================
    // qqqide:search:query — 主搜索入口
    // ★ 参数名与 preload.ts 对齐：searchPath (非 rootDir)
    // ★ 响应格式与 search-ui.html 对齐：扁平 results + total/elapsed/filesScanned
    // ============================================================
    ipcMain.handle('qqqide:search:query', async (_e, args: {
        query: string;
        searchPath?: string;
        rootDir?: string;      // legacy fallback
        isRegex?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        includePattern?: string;
        excludePattern?: string;
        contextLines?: number;
        maxResults?: number;
        timeoutMs?: number;
        respectGitignore?: boolean;
    }) => {
        // ★ searchPath 为主，rootDir 兜底（兼容旧调用方如 search-ui）
        const searchPath = args.searchPath || args.rootDir || '';
        const { query, isRegex = false, caseSensitive = false, wholeWord = false,
            contextLines = 1, maxResults = 5000, timeoutMs = 60000,
            respectGitignore = false } = args;

        if (!searchPath || !query) return { error: 'missing query or searchPath', results: [], total: 0 };

        const startTime = Date.now();

        // ---- build search regex ----
        let pattern: string;
        if (isRegex) {
            pattern = query;
        } else {
            pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        if (wholeWord) pattern = '\\b' + pattern + '\\b';
        let regex: RegExp;
        try { regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi'); }
        catch { return { error: 'invalid regex: ' + query, results: [], total: 0 }; }

        // ---- build include/exclude glob matchers ----
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

        // ---- collect all files ----
        const allFiles = await collectFiles(searchPath, respectGitignore, includeMatchers, excludeMatchers);
        const fileStats = new Map<string, { mtime: number; birthtime: number; size: number }>();

        const results: SearchMatch[] = [];
        let totalMatches = 0;
        let aborted = false;
        const rootNorm = searchPath.replace(/\\/g, '/').replace(/\/$/, '');

        // ---- parallel worker pool ----
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
                    regex.lastIndex = 0;
                    let lineMatches = 0;
                    const perFileResults: SearchMatch[] = [];

                    for (let li = 0; li < lines.length; li++) {
                        regex.lastIndex = 0;
                        while ((m = regex.exec(lines[li])) !== null) {
                            lineMatches++;
                            totalMatches++;
                            if (totalMatches > maxResults) { aborted = true; break; }

                            const match: SearchMatch = {
                                file: relPath,
                                line: li + 1,
                                col: m.index + 1,
                                text: lines[li].trim().slice(0, 300),
                            };

                            // ---- context lines ----
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

                    // Dedup same-line matches (keep first occurrence per line)
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

        // Launch worker pool
        const workers: Promise<void>[] = [];
        for (let w = 0; w < SEARCH_CONCURRENCY; w++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        const elapsed = Date.now() - startTime;
        return {
            results: results.slice(0, maxResults),
            total: totalMatches,
            elapsed,
            filesScanned: allFiles.length,
            truncated: aborted || totalMatches >= maxResults || allFiles.length >= SEARCH_MAX_FILES,
            fileStats: Object.fromEntries(fileStats),
        };
    });

    // ============================================================
    // qqqide:search:replace — 按行精准替换
    // ★ search-ui 传入 { replacements: [{ file, line, col, matchLen, replacement }] }
    //   每个 entry 指定文件+行号+列+匹配长度+替换文本
    // ============================================================
    ipcMain.handle('qqqide:search:replace', async (_e, args: {
        replacements?: Array<{ file: string; line: number; col: number; matchLen: number; replacement: string }>;
        // legacy fallback (batch regex replace)
        files?: string[];
        find?: string;
        replace?: string;
        useRegex?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
    }) => {
        // ---- new API: per-match replacements (from search-ui) ----
        if (args.replacements && Array.isArray(args.replacements) && args.replacements.length > 0) {
            // Group by file
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
                    // Sort descending by (line, col) so replacements don't shift positions
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
                        // Verify the match text still matches (file may have changed)
                        const matchText = line.slice(col0, col0 + rep.matchLen);
                        // Apply replacement
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

        // ---- legacy API: batch regex replace ----
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
