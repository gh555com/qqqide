// ============================================================================
// ipc-fs.ts — 文件系统 IPC handlers
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { _sn } from './ipc-state';
import { _tlBlobPath, _gunzipSync } from './timeline-store';

const READ_FILE_MAX = 50 * 1024 * 1024; // 50MB guard

/** ★ 原子写入：tmp + rename，与 qgf.ts atomicWrite 同模式。
 *  进程崩溃 mid-write 时只有 tmp 损坏，目标文件始终完好。 */
async function _atomicWrite(absPath: string, data: Buffer): Promise<void> {
    const dir = path.dirname(absPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = absPath + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);
    await fs.promises.writeFile(tmp, data as any);
    try {
        await fs.promises.rename(tmp, absPath);
    } catch (e: any) {
        if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
            // Windows 文件锁/防病毒 → 降级为 copy+unlink，绝不先删后改
            try {
                const data = await fs.promises.readFile(tmp);
                await fs.promises.writeFile(absPath, data as any);
                try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
            } catch (e2) {
                try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
                throw e2;
            }
        } else {
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
            throw e;
        }
    }
}

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

    // ★ 原子写入：tmp + rename，防进程崩溃导致文件半写损坏
    //    与 qgf.ts atomicWrite 同模式，保证真理源文件（如 f{n}.json）永不损坏
    ipcMain.handle('qqqide:fs:writeBase64', async (_e, p: string, base64: string) => {
        try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        const buf = Buffer.from(base64 || '', 'base64');
        await _atomicWrite(p, buf);
        return true;
    });

    ipcMain.handle('qqqide:fs:write', async (_e, p: string, content: any) => {
        try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        await _atomicWrite(p, buf);
        return true;
    });

    ipcMain.handle('qqqide:fs:append', async (_e, p: string, content: string) => {
        try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        await fs.promises.appendFile(p, content, 'utf8');
        return true;
    });

    ipcMain.handle('qqqide:fs:list', async (_e, p: string, callerStack?: string) => {
        console.log('[fs:list]', p);
        const MAX = 3000;
        try {
            const names = await fs.promises.readdir(p, { withFileTypes: true });
            const entries = names.slice(0, MAX);
            // ★ 并行 stat 获取 mtime/size，零额外 IPC
            const stats = await Promise.all(entries.map(function (e) {
                return fs.promises.stat(path.join(p, e.name)).catch(function () { return null; });
            }));
            const result = entries.map(function (e, i) {
                var st = stats[i];
                return {
                    name: e.name,
                    isDir: e.isDirectory(),
                    mtimeMs: st ? st.mtimeMs : 0,
                    ctimeMs: st ? st.ctimeMs : 0,
                    size: st ? st.size : 0,
                };
            });
            if (names.length > MAX) {
                console.warn('[fs:list] TRUNCATED:', p, 'returned ' + MAX + '/' + names.length + ' entries');
            }
            return result;
        } catch (e: any) {
            // ENOENT is normal — quests/ or floor dir may not exist yet
            if (e?.code !== 'ENOENT' && callerStack) {
                console.warn('[fs:list] FAILED:', p, '\n' + callerStack, e?.message);
            }
            return [];
        }
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
    //   可选 sha256：读 timeline 中该文件的历史版本
    ipcMain.handle('qqqide:ai:read_file', async (_e, args: { path: string; start_line?: number; end_line?: number; sha256?: string }) => {
        try {
            // ── sha256 路径：读 timeline blob ──
            if (args.sha256) {
                // 从文件路径向上找到项目根（有 qqq/timeline/blobs/ 的目录）
                let root = path.dirname(args.path);
                while (root && root !== path.dirname(root)) {
                    if (fs.existsSync(path.join(root, 'qqq', 'timeline', 'blobs'))) break;
                    root = path.dirname(root);
                }
                if (!root || root === path.dirname(root)) {
                    return 'Error: cannot find project root (no qqq/timeline/blobs/) from ' + args.path;
                }
                const blobPath = _tlBlobPath(root, args.sha256);
                if (!fs.existsSync(blobPath)) {
                    return 'Error: blob not found for sha256 ' + args.sha256.slice(0, 12) + '... in ' + root;
                }
                const gzBuf = fs.readFileSync(blobPath);
                let content = _gunzipSync(gzBuf);
                // Line-range pagination (same as normal path)
                if (args.start_line != null || args.end_line != null) {
                    const lines = content.split('\n');
                    const start = Math.max(0, (args.start_line || 1) - 1);
                    const end = args.end_line != null ? Math.min(args.end_line, lines.length) : lines.length;
                    const header = '[paginated ' + (start + 1) + '-' + end + ' of ' + lines.length + ' lines]\n';
                    return header + lines.slice(start, end).join('\n');
                }
                return content;
            }

            // ── 正常路径：读磁盘文件 ──
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
