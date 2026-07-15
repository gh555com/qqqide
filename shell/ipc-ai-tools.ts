// ============================================================================
// ipc-ai-tools.ts — AI 工具 IPC: search_text / find_files / list_files
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { AI_SKIP_DIRS, AI_SKIP_EXTS, AI_MAX_FILE_SIZE, aiGlobToRegex, aiTimeout } from './ipc-state';

export function registerAiToolsIpc(): void {
    // search_text — 正则递归搜索
    ipcMain.handle('qqqide:ai:search_text', async (_e, args: { query: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => {
        const query = args.query;
        const searchPaths: string[] = args.paths || (args.path ? [args.path] : []);
        const maxResults = args.maxResults || 30;
        const timeoutMs = args.timeoutMs || 30000;
        if (searchPaths.length === 0) return 'Error: no search paths';

        let regex: RegExp;
        try { regex = new RegExp(query, 'i'); }
        catch { regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

        const matches: string[] = [];

        const doSearch = async (): Promise<string> => {
            async function walk(dir: string, depth: number): Promise<void> {
                if (depth > 8 || matches.length >= maxResults) return;
                let entries: fs.Dirent[];
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                catch { return; }
                entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
                for (const ent of entries) {
                    if (matches.length >= maxResults) break;
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
                            const lines = content.split('\n');
                            for (let li = 0; li < lines.length && matches.length < maxResults; li++) {
                                if (regex.test(lines[li])) {
                                    matches.push(full + ':' + (li + 1) + ':' + lines[li].trim().slice(0, 200));
                                }
                            }
                        } catch { /* skip unreadable */ }
                    }
                }
            }
            for (const d of searchPaths) {
                if (matches.length >= maxResults) break;
                await walk(d, 0);
            }
            return matches.length > 0 ? matches.join('\n') : 'No matches found.';
        };

        return Promise.race([doSearch(), aiTimeout(timeoutMs, matches.length > 0 ? matches.join('\n') : '')]);
    });

    // find_files — glob 文件名递归搜索
    ipcMain.handle('qqqide:ai:find_files', async (_e, args: { pattern: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => {
        const pattern = args.pattern;
        const searchPaths: string[] = args.paths || (args.path ? [args.path] : []);
        const maxResults = args.maxResults || 50;
        const timeoutMs = args.timeoutMs || 15000;
        if (!pattern || searchPaths.length === 0) return 'Error: missing pattern or paths';

        const regex = aiGlobToRegex(pattern);
        const baseDirs = searchPaths.map(p => p.replace(/\\/g, '/').replace(/\/$/, ''));
        const matches: string[] = [];

        const doSearch = async (): Promise<string> => {
            async function walk(dir: string, depth: number, baseDir: string): Promise<void> {
                if (depth > 8 || matches.length >= maxResults) return;
                let entries: fs.Dirent[];
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                catch { return; }
                entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
                for (const ent of entries) {
                    if (matches.length >= maxResults) break;
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

        return Promise.race([doSearch(), aiTimeout(timeoutMs, matches.length > 0 ? matches.join('\n') : '')]);
    });

    // list_files — 递归列目录
    ipcMain.handle('qqqide:ai:list_files', async (_e, args: { path: string; maxResults?: number; timeoutMs?: number }) => {
        const searchPath = args.path;
        const maxResults = args.maxResults || 200;
        const timeoutMs = args.timeoutMs || 15000;
        if (!searchPath) return 'Error: missing path';

        const matches: string[] = [];

        const doSearch = async (): Promise<string> => {
            async function walk(dir: string, depth: number): Promise<void> {
                if (depth > 8 || matches.length >= maxResults) return;
                let entries: fs.Dirent[];
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                catch { return; }
                entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
                for (const ent of entries) {
                    if (matches.length >= maxResults) break;
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

        return Promise.race([doSearch(), aiTimeout(timeoutMs, matches.length > 0 ? matches.join('\n') : '')]);
    });
}
