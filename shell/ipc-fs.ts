// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-fs.ts — 文件系统 IPC handlers
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { _sn } from './ipc-state';
import { _tlBlobPath, _gunzipSync } from './timeline-store';

const READ_FILE_MAX = 50 * 1024 * 1024; // 50MB guard

// ★ agent 日志轮转：_qqq/new_log/agent-*.log 只保留 30 天（每日最多清一次）
let _agentLogRotateDay = '';

// ★ new_log JSONL 大小轮转：_qqq/new_log/*.jsonl 单文件 ≤2MB，超限滚为 .1（覆盖旧），总量 ≤4MB
async function _rotateJsonlBySize(p: string): Promise<void> {
    const dir = path.dirname(p);
    if (!p.endsWith('.jsonl') || !dir.endsWith(path.join('_qqq', 'new_log'))) return;
    try {
        const st = await fs.promises.stat(p);
        if (st.size < 2 * 1024 * 1024) return;
        const bak = p + '.1';
        try { await fs.promises.unlink(bak); } catch { /* 无旧备份 */ }
        await fs.promises.rename(p, bak);
    } catch (e: any) {
        if (e && e.code !== 'ENOENT') { /* 忽略 */ }
    }
}
async function _rotateAgentLogs(p: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (_agentLogRotateDay === today) return;
    const dir = path.dirname(p);
    if (!path.basename(p).startsWith('agent-') || !dir.endsWith(path.join('_qqq', 'new_log'))) return;
    _agentLogRotateDay = today;
    try {
        const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
        const names = await fs.promises.readdir(dir);
        for (const n of names) {
            if (!n.startsWith('agent-') || !n.endsWith('.log')) continue;
            try {
                const st = await fs.promises.stat(path.join(dir, n));
                if (st.mtimeMs < cutoff) await fs.promises.unlink(path.join(dir, n));
            } catch { /* 单文件失败不影响 */ }
        }
    } catch { /* 目录不存在/不可读 → 跳过 */ }
}

/** ★ 原子写入：tmp + rename，与 qgf.ts atomicWrite 同模式。
 *  进程崩溃 mid-write 时只有 tmp 损坏，目标文件始终完好。 */
async function _atomicWrite(absPath: string, data: Buffer): Promise<void> {
    const dir = path.dirname(absPath);
    try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* ignore — dir may already exist (e.g. drive root D:\) */ }
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
        // new_log JSONL 大小轮转：超 2MB 先滚 .1 再写（总量 ≤4MB）
        await _rotateJsonlBySize(p);
        await fs.promises.appendFile(p, content, 'utf8');
        // agent-*.log 顺带轮转（30 天保留，每日一次，零开销）
        _rotateAgentLogs(p).catch(function () { /* ignore */ });
        return true;
    });

    ipcMain.handle('qqqide:fs:list', async (_e, p: string, callerStack?: string) => {
        // 高频调用（扫盘/索引/建楼），不打印正常路径日志，仅 FAILED 时告警
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

    // ★ copyFile — 流式复制 + 进度回调（通过 IPC event 通道）
    //  渲染层调 bridge.fs.copyFile(src, dest, onProgress) → 主进程流式复制
    //  ★ 2026-08-13 目录感知升级：src 为目录 → 递归复制（8 路并发 + 字节级进度）
    //     roam 粘贴文件夹 / 编辑框所见即所得粘贴文件夹 统一走此引擎（单一入口）
    ipcMain.handle('qqqide:fs:copyFile', async (e, src: string, dest: string, streamId?: string) => {
        try {
            const st = await fs.promises.stat(src);
            if (st.isDirectory()) {
                // ── 目录：递归复制（合并语义，逐文件覆盖，同 robocopy /E）──
                await fs.promises.mkdir(dest, { recursive: true });
                return await _copyDirRecursive(e, src, dest, streamId);
            }
            // ── 文件：原流式路径 ──
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            const totalSize = st.size;
            const readStream = fs.createReadStream(src, { highWaterMark: 1024 * 1024 }); // 1MB chunks
            const writeStream = fs.createWriteStream(dest);

            if (streamId && totalSize > 0) {
                let copied = 0;
                readStream.on('data', (chunk: Buffer) => {
                    copied += chunk.length;
                    try {
                        e.sender.send('qqqide:fs:copy-progress', { streamId, copied, total: totalSize });
                    } catch { /* ignore */ }
                });
            }

            return new Promise<boolean>((resolve, reject) => {
                readStream.on('error', reject);
                writeStream.on('error', reject);
                writeStream.on('finish', () => resolve(true));
                readStream.pipe(writeStream);
            });
        } catch (e: any) {
            if (e.code === 'ENOENT') return false;
            throw e;
        }
    });

    // ★ 目录递归复制（2026-08-13）：readdir 收集全量文件清单 → 8 路并发流式复制
    //   合并语义：目标已存在目录 → 逐文件覆盖；字节级进度经 streamId 事件上报
    async function _copyDirRecursive(e: any, src: string, dest: string, streamId?: string): Promise<boolean> {
        // ① 收集文件清单（相对路径）+ 总字节
        const files: string[] = [];
        let totalBytes = 0;
        const walk = async (dir: string): Promise<void> => {
            let entries;
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    await walk(full);
                } else if (ent.isFile()) {
                    const fst = await fs.promises.stat(full).catch(() => null);
                    if (!fst) continue;
                    files.push(full);
                    totalBytes += fst.size;
                }
            }
        };
        await walk(src);

        // ② 8 路并发复制
        const CONC = 8;
        let idx = 0;
        let copiedBytes = 0;
        const report = () => {
            if (streamId && totalBytes > 0) {
                try { e.sender.send('qqqide:fs:copy-progress', { streamId, copied: copiedBytes, total: totalBytes }); } catch { /* ignore */ }
            }
        };
        const worker = async (): Promise<void> => {
            while (true) {
                const i = idx++;
                if (i >= files.length) return;
                const f = files[i];
                const rel = path.relative(src, f);
                const out = path.join(dest, rel);
                await fs.promises.mkdir(path.dirname(out), { recursive: true });
                await new Promise<void>((resolve, reject) => {
                    const rs = fs.createReadStream(f, { highWaterMark: 1024 * 1024 });
                    const ws = fs.createWriteStream(out);
                    rs.on('data', (chunk: Buffer) => { copiedBytes += chunk.length; report(); });
                    rs.on('error', reject);
                    ws.on('error', reject);
                    ws.on('finish', () => resolve());
                    rs.pipe(ws);
                });
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONC, files.length || 1) }, () => worker()));
        report();
        return true;
    }

    // ★ read_file — 主进程直接读，1 IPC，50MB 守卫 + qwr 快照
    //   可选 sha256：读 timeline 中该文件的历史版本
    ipcMain.handle('qqqide:ai:read_file', async (_e, args: { path: string; start_line?: number; end_line?: number; sha256?: string }) => {
        try {
            // ── sha256 路径：读 timeline blob ──
            if (args.sha256) {
                // 从文件路径向上找到项目根（有 _qqq/timeline/blobs/ 的目录）
                let root = path.dirname(args.path);
                while (root && root !== path.dirname(root)) {
                    if (fs.existsSync(path.join(root, '_qqq', 'timeline', 'blobs'))) break;
                    root = path.dirname(root);
                }
                if (!root || root === path.dirname(root)) {
                   return 'Error: cannot find project root (no _qqq/timeline/blobs/) from ' + args.path;;
                }
                const blobPath = _tlBlobPath(root, args.sha256);
                if (!fs.existsSync(blobPath)) {
                    return 'Error: blob not found for sha256 ' + args.sha256.slice(0, 12) + '... in ' + root;
                }
                const gzBuf = fs.readFileSync(blobPath);
                let content = _gunzipSync(gzBuf);
                // ★ 2026-08-18: U+FFFD 诊断提示（历史内容损伤 vs 工具解码错，AI 可区分）
                const _fffdN = (content.match(/\uFFFD/g) || []).length;
                const _fffdNote = _fffdN ? '\n\n[WARN] 该历史版本含 ' + _fffdN + ' 处 U+FFFD 替换字符（历史写入时编码已损伤，原始字节不可逆）\n' : '';
                // Line-range pagination (same as normal path)
                if (args.start_line != null || args.end_line != null) {
                    const lines = content.split('\n');
                    const start = Math.max(0, (args.start_line || 1) - 1);
                    const end = args.end_line != null ? Math.min(args.end_line, lines.length) : lines.length;
                    const header = '[paginated ' + (start + 1) + '-' + end + ' of ' + lines.length + ' lines]\n';
                    return header + _fffdNote + lines.slice(start, end).join('\n');
                }
                return content + _fffdNote;
            }

            // ── 正常路径：读磁盘文件 ──
            const st = await fs.promises.stat(args.path);
            if (st.size > READ_FILE_MAX) {
                return 'Error: file ' + path.basename(args.path) + ' is ' + (st.size / 1024 / 1024).toFixed(1) + 'MB. Use start_line/end_line to paginate.';
            }
            let content = await fs.promises.readFile(args.path, 'utf8');
            // Record snapshot for qwr machine (external modification detection)
            try { _sn[args.path] = { mtimeMs: st.mtimeMs, size: st.size }; } catch { /* best-effort */ }
            // ★ 2026-08-18: U+FFFD 诊断提示（内容损伤 vs 工具解码错，AI 可区分）
            const _fffdN = (content.match(/\uFFFD/g) || []).length;
            const _fffdNote = _fffdN ? '\n\n[WARN] 文件含 ' + _fffdN + ' 处 U+FFFD 替换字符（历史写入时编码已损伤，原始字节不可逆）\n' : '';
            // Line-range pagination
            if (args.start_line != null || args.end_line != null) {
                const lines = content.split('\n');
                const start = Math.max(0, (args.start_line || 1) - 1);
                const end = args.end_line != null ? Math.min(args.end_line, lines.length) : lines.length;
                const header = '[paginated ' + (start + 1) + '-' + end + ' of ' + lines.length + ' lines]\n';
                return header + _fffdNote + lines.slice(start, end).join('\n');
            }
            return content + _fffdNote;
        } catch (e: any) {
            if (e.code === 'ENOENT') return 'Error: file not found: ' + args.path;
            if (e.code === 'EACCES') return 'Error: permission denied: ' + args.path;
            return 'Error reading file: ' + (e.message || e);
        }
    });
}
