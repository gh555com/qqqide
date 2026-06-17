// ============================================================================
// ipc-search.ts — qqqide:search 高性能项目搜索引擎
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

async function collectFiles(rootDir: string): Promise<string[]> {
    const files: string[] = [];
    const ignoreMatchers: Array<(rel: string, isDir: boolean) => boolean> = [];

    // Try .gitignore first, fallback to .qqqignore
    for (const ignName of ['.gitignore', '.qqqignore']) {
        const ignPath = path.join(rootDir, ignName);
        try {
            if (fs.existsSync(ignPath)) {
                ignoreMatchers.push(parseIgnoreFile(fs.readFileSync(ignPath, 'utf8')));
            }
        } catch { /* ignore */ }
    }

    const isIgnored = (rel: string, isDir: boolean): boolean => {
        for (const m of ignoreMatchers) { if (m(rel, isDir)) return true; }
        return false;
    };

    async function walk(dir: string, relBase: string): Promise<void> {
        if (files.length >= SEARCH_MAX_FILES) return;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const ent of entries) {
            if (files.length >= SEARCH_MAX_FILES) return;
            const rel = relBase ? relBase + '/' + ent.name : ent.name;
            if (ent.isDirectory()) {
                if (SEARCH_SKIP_DIRS.has(ent.name)) continue;
                if (ent.name.startsWith('.')) continue;
                if (isIgnored(rel + '/', true)) continue;
                await walk(path.join(dir, ent.name), rel);
            } else if (ent.isFile() || ent.isSymbolicLink()) {
                const ext = path.extname(ent.name).toLowerCase();
                if (SEARCH_BINARY_EXTS.has(ext)) continue;
                if (isIgnored(rel, false)) continue;
                files.push(path.join(dir, ent.name));
            }
        }
    }

    await walk(rootDir, '');
    return files;
}

function searchInContent(content: string, query: string, caseSensitive: boolean, wholeWord: boolean, useRegex: boolean): Array<{ line: number; col: number; text: string }> {
    const results: Array<{ line: number; col: number; text: string }> = [];
    const lines = content.split('\n');
    let pattern: RegExp;
    try {
        let flags = 'g';
        if (!caseSensitive) flags += 'i';
        if (useRegex) {
            pattern = new RegExp(query, flags);
        } else {
            let esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (wholeWord) esc = '\\b' + esc + '\\b';
            pattern = new RegExp(esc, flags);
        }
    } catch {
        return results;
    }

    for (let i = 0; i < lines.length; i++) {
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(lines[i])) !== null) {
            results.push({ line: i + 1, col: match.index + 1, text: lines[i].trim().slice(0, 300) });
            if (match[0].length === 0) pattern.lastIndex++;
        }
    }
    return results;
}

export function registerSearchIpc(): void {
    ipcMain.handle('qqqide:search', async (_e, args: {
        rootDir: string;
        query: string;
        caseSensitive?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
        includePattern?: string;
        excludePattern?: string;
        maxResults?: number;
        contextLines?: number;
    }) => {
        const { rootDir, query, caseSensitive = false, wholeWord = false, useRegex = false, maxResults = 200, contextLines = 0 } = args;
        if (!rootDir || !query) return { results: [], totalFiles: 0, totalMatches: 0, truncated: false };

        const allFiles = await collectFiles(rootDir);
        const results: any[] = [];
        let totalMatches = 0;
        let truncated = false;
        let scanned = 0;

        // Filter by include/exclude patterns
        let fileList = allFiles;
        if (args.includePattern) {
            try {
                const re = new RegExp(args.includePattern, 'i');
                fileList = fileList.filter(f => re.test(f));
            } catch { /* ignore */ }
        }
        if (args.excludePattern) {
            try {
                const re = new RegExp(args.excludePattern, 'i');
                fileList = fileList.filter(f => !re.test(f));
            } catch { /* ignore */ }
        }

        // Process files in parallel batches
        const batches: string[][] = [];
        for (let i = 0; i < fileList.length; i += SEARCH_CONCURRENCY) {
            batches.push(fileList.slice(i, i + SEARCH_CONCURRENCY));
        }

        for (const batch of batches) {
            if (results.length >= maxResults) { truncated = true; break; }
            const batchResults = await Promise.all(batch.map(async (filePath) => {
                try {
                    const st = fs.statSync(filePath);
                    if (st.size > SEARCH_MAX_FILE) return null;
                    const content = fs.readFileSync(filePath, 'utf8');
                    const matches = searchInContent(content, query, caseSensitive, wholeWord, useRegex);
                    if (matches.length === 0) return null;
                    const relPath = filePath.replace(rootDir, '').replace(/^[\\/]/, '');
                    const matchEntries = matches.slice(0, 20).map(m => ({
                        line: m.line,
                        col: m.col,
                        text: m.text,
                    }));
                    return {
                        file: relPath,
                        fullPath: filePath,
                        matches: matchEntries,
                        matchCount: matches.length,
                    };
                } catch {
                    return null;
                }
            }));
            for (const r of batchResults) {
                if (!r) continue;
                scanned++;
                totalMatches += r.matchCount;
                results.push(r);
                if (results.length >= maxResults) { truncated = true; break; }
            }
        }

        return {
            results: results.slice(0, maxResults),
            totalFiles: scanned,
            totalMatches,
            truncated: truncated || allFiles.length >= SEARCH_MAX_FILES,
        };
    });

    // search:replace — 批量替换
    ipcMain.handle('qqqide:search:replace', async (_e, args: {
        files: string[];
        find: string;
        replace: string;
        useRegex?: boolean;
        caseSensitive?: boolean;
        wholeWord?: boolean;
    }) => {
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
                const content = fs.readFileSync(fp, 'utf8');
                const newContent = content.replace(pattern, replaceText);
                if (newContent !== content) {
                    fs.writeFileSync(fp, newContent, 'utf8');
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
