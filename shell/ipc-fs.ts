// ============================================================================
// ipc-fs.ts — 文件系统 IPC handlers
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { _sn } from './ipc-state';

const READ_FILE_MAX = 50 * 1024 * 1024; // 50MB guard

export function registerFsIpc(): void {
    ipcMain.handle('qqqide:fs:exists', async (_e, p: string) => fs.existsSync(p));

    ipcMain.handle('qqqide:fs:read', async (_e, p: string) => {
        try { return await fs.promises.readFile(p, 'utf8'); } catch (e: any) {
            if (e.code === 'ENOENT') return null;
            throw e;
        }
    });

    ipcMain.handle('qqqide:fs:readBase64', async (_e, p: string) => {
        try { const buf = await fs.promises.readFile(p); return buf.toString('base64'); } catch (e: any) {
            if (e.code === 'ENOENT') return null;
            throw e;
        }
    });

    ipcMain.handle('qqqide:fs:writeBase64', async (_e, p: string, base64: string) => {
        try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        const buf = Buffer.from(base64 || '', 'base64');
        await fs.promises.writeFile(p, buf as any);
        return true;
    });

    ipcMain.handle('qqqide:fs:write', async (_e, p: string, content: any) => {
        try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        await fs.promises.writeFile(p, content);
        return true;
    });

    ipcMain.handle('qqqide:fs:append', async (_e, p: string, content: string) => {
        try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        await fs.promises.appendFile(p, content, 'utf8');
        return true;
    });

    ipcMain.handle('qqqide:fs:list', async (_e, p: string, callerStack?: string) => {
        console.log('[fs:list]', p);
        const result: string[] = [];
        const MAX = 2000;
        let dir: fs.Dir | null = null;
        try {
            dir = await fs.promises.opendir(p);
            let dirent: fs.Dirent | null;
            while ((dirent = await dir.read()) !== null) {
                if (result.length >= MAX) break;
                result.push(dirent.isDirectory() ? dirent.name + '/' : dirent.name);
            }
        } catch {
            if (callerStack) { console.warn('[fs:list] FAILED:', p, '\n' + callerStack); }
            return [];
        } finally {
            if (dir) { try { await dir.close(); } catch (_) { } }
        }
        return result;
    });

    ipcMain.handle('qqqide:fs:stat', async (_e, p: string) => {
        try {
            const s = await fs.promises.stat(p);
            return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory(), isFile: s.isFile() };
        } catch { return null; }
    });

    ipcMain.handle('qqqide:fs:mkdir', async (_e, p: string) => {
        await fs.promises.mkdir(p, { recursive: true });
        return true;
    });

    ipcMain.handle('qqqide:fs:remove', async (_e, p: string) => {
        try {
            const s = await fs.promises.stat(p);
            if (s.isDirectory()) await fs.promises.rm(p, { recursive: true, force: true });
            else await fs.promises.unlink(p);
        } catch (e: any) {
            if (e && e.code !== 'ENOENT') throw e;
        }
        return true;
    });

    ipcMain.handle('qqqide:fs:rename', async (_e, oldP: string, newP: string) => {
        await fs.promises.rename(oldP, newP);
        return true;
    });

    // ★ read_file — 主进程直接读，1 IPC，50MB 守卫 + qwr 快照
    ipcMain.handle('qqqide:ai:read_file', async (_e, args: { path: string; start_line?: number; end_line?: number }) => {
        try {
            const st = await fs.promises.stat(args.path);
            if (st.size > READ_FILE_MAX) {
                return 'Error: file ' + path.basename(args.path) + ' is ' + (st.size / 1024 / 1024).toFixed(1) + 'MB. Use start_line/end_line to paginate.';
            }
            let content = await fs.promises.readFile(args.path, 'utf8');
            // Record snapshot for qwr machine (external modification detection)
            try { _sn[args.path] = { mtimeMs: st.mtimeMs, size: st.size }; } catch { /* best-effort */ }
            // Line-range pagination
            if (args.start_line != null || args.end_line != null) {
                const lines = content.split('\n');
                const start = Math.max(0, (args.start_line || 1) - 1);
                const end = args.end_line != null ? Math.min(args.end_line, lines.length) : lines.length;
                const header = '[paginated ' + (start + 1) + '-' + end + ' of ' + lines.length + ' lines]\n';
                return header + lines.slice(start, end).join('\n');
            }
            return content;
        } catch (e: any) {
            if (e.code === 'ENOENT') return 'Error: file not found: ' + args.path;
            if (e.code === 'EACCES') return 'Error: permission denied: ' + args.path;
            return 'Error reading file: ' + (e.message || e);
        }
    });
}
