// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-fs.ts — 文件系统 IPC handlers
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
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

// ============================================================================
// ★ 指纹去重（2026-08-24 移植 q3 h.js）— 采样 MD5 + 同目录去重
//   指纹 = size(8B) + 头128B + 中128B + 尾128B 的 MD5；空文件指纹 = path+mtime
//   （杜绝空文件互相去重）；缓存 mtime+size 校验（次秒级时间戳防 FS 精度抖动）。
//   语义对齐 q3: 去重仅限同目录（禁跨文件夹引用）；目标已存在同内容 → 跳过复制；
//   复制后同目录扫描命中 → 删新副本复用既有文件。
// ============================================================================
const _fingerprintCache = new Map<string, { mtime: number; size: number; fp: string }>();
const FINGERPRINT_HEAD = 128;
const FINGERPRINT_MID = 128;
const FINGERPRINT_TAIL = 128;

function _cacheKeyForPath(p: string): string {
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

function computeFingerprint(filePath: string): string | null {
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) return null;
        const size = st.size;
        const mtime = Math.floor(st.mtimeMs);
        const key = _cacheKeyForPath(filePath);
        const cached = _fingerprintCache.get(key);
        if (cached && cached.mtime === mtime && cached.size === size) return cached.fp;
        let fp: string;
        if (size === 0) {
            fp = crypto.createHash('md5').update('empty:0:' + key + ':' + mtime).digest('hex');
        } else {
            const chunks: Buffer[] = [];
            const sizeBuf = Buffer.alloc(8);
            sizeBuf.writeBigUInt64LE(BigInt(size));
            chunks.push(sizeBuf);
            const fd = fs.openSync(filePath, 'r');
            try {
                if (size <= FINGERPRINT_HEAD) {
                    const buf = Buffer.alloc(size);
                    fs.readSync(fd, buf, 0, size, 0);
                    chunks.push(buf);
                } else if (size <= FINGERPRINT_HEAD + FINGERPRINT_TAIL) {
                    const head = Buffer.alloc(FINGERPRINT_HEAD);
                    fs.readSync(fd, head, 0, FINGERPRINT_HEAD, 0);
                    chunks.push(head);
                    const tailSize = Math.min(FINGERPRINT_TAIL, size - FINGERPRINT_HEAD);
                    const tail = Buffer.alloc(tailSize);
                    fs.readSync(fd, tail, 0, tailSize, size - tailSize);
                    chunks.push(tail);
                } else {
                    const head = Buffer.alloc(FINGERPRINT_HEAD);
                    fs.readSync(fd, head, 0, FINGERPRINT_HEAD, 0);
                    chunks.push(head);
                    const midPos = Math.floor(size / 2) - Math.floor(FINGERPRINT_MID / 2);
                    const mid = Buffer.alloc(FINGERPRINT_MID);
                    fs.readSync(fd, mid, 0, FINGERPRINT_MID, midPos);
                    chunks.push(mid);
                    const tail = Buffer.alloc(FINGERPRINT_TAIL);
                    fs.readSync(fd, tail, 0, FINGERPRINT_TAIL, size - FINGERPRINT_TAIL);
                    chunks.push(tail);
                }
            } finally {
                fs.closeSync(fd);
            }
            fp = crypto.createHash('md5').update(Buffer.concat(chunks)).digest('hex');
        }
        _fingerprintCache.set(key, { mtime, size, fp });
        if (_fingerprintCache.size > 2000) _fingerprintCache.clear();
        return fp;
    } catch {
        return null;
    }
}

function prefillFingerprint(filePath: string, fingerprint: string): void {
    try {
        const st = fs.statSync(filePath);
        const key = _cacheKeyForPath(filePath);
        _fingerprintCache.set(key, { mtime: st.mtimeMs, size: st.size, fp: fingerprint });
    } catch { /* ignore */ }
}

// ★ 同目录指纹去重（q3 _tryLocalDeduplicate）— 仅限同文件夹，禁跨文件夹引用；
//   命中 → 删新副本返回既有文件路径；.part/.ytdl/.tmp 不参与扫描（下载中文件）
function _tryLocalDeduplicate(filePath: string): string {
    if (!filePath || !fs.existsSync(filePath)) return filePath;
    try {
        const currentFp = computeFingerprint(filePath);
        if (!currentFp) return filePath;
        const dir = path.dirname(filePath);
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const normSelf = _cacheKeyForPath(filePath);
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const f = entry.name;
            if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.tmp')) continue;
            const full = path.join(dir, f);
            if (_cacheKeyForPath(full) === normSelf) continue;
            const otherFp = computeFingerprint(full);
            if (otherFp === currentFp) {
                try {
                    fs.unlinkSync(filePath);
                    return full;
                } catch { /* 删除失败（占用/权限）→ 保留新副本 */ }
            }
        }
    } catch { /* ignore */ }
    return filePath;
}

// ★ 唯一路径（q3 getUniquePath 同款命名：name_1.ext —— 2026-09-03 从 " (1)" 对齐回 q3/用户预期）— 防覆盖
function getUniquePath(baseDir: string, originalName: string): string {
    const ext = path.extname(originalName);
    let nameWithoutExt = path.basename(originalName, ext);
    // 隐藏文件（.gitignore 等）特殊处理：extname 返回全名时视为无扩展名
    if (!nameWithoutExt && ext.startsWith('.')) {
        nameWithoutExt = ext;
    }
    let targetPath = path.join(baseDir, originalName);
    let counter = 1;
    while (fs.existsSync(targetPath)) {
        targetPath = path.join(baseDir, nameWithoutExt + '_' + counter + ext);
        counter++;
    }
    return targetPath;
}

// ============================================================================
// ★ ioast 任务级进度聚合 + 取消（2026-08-24）—
//   多路并发复制共享同一 streamId → 主进程按 streamId 聚合 total/copied，
//   渲染层收统一进度（不感知并发路数）；cancelCopy 置取消标志，
//   各复制路径检查后中止并清理半成品（目标必为本次新建，删除安全）。
// ============================================================================
const _copyAgg = new Map<string, { total: number; copied: number }>();
const _copyCancels = new Set<string>();
const _aggLastReport = new Map<string, number>();

function _aggAdd(streamId: string, total: number): void {
    if (!streamId || total <= 0) return;
    let agg = _copyAgg.get(streamId);
    if (!agg) { agg = { total: 0, copied: 0 }; _copyAgg.set(streamId, agg); }
    agg.total += total;
}

function _aggReport(e: any, streamId: string, force = false): void {
    const agg = _copyAgg.get(streamId);
    if (!agg || agg.total <= 0) return;
    const now = Date.now();
    const last = _aggLastReport.get(streamId) || 0;
    if (!force && now - last < 100) return; // 100ms 节流（进度条 10Hz 足够）
    _aggLastReport.set(streamId, now);
    try { e.sender.send('qqqide:fs:copy-progress', { streamId, copied: agg.copied, total: agg.total }); } catch { /* ignore */ }
}

function _aggCleanup(streamId: string): void {
    if (!streamId) return;
    _copyAgg.delete(streamId);
    _copyCancels.delete(streamId);
    _aggLastReport.delete(streamId);
}

function _copyCancelled(streamId: string): boolean {
    return !!streamId && _copyCancels.has(streamId);
}

function _cancelErr(streamId: string): Error {
    return new Error('copy cancelled (stream ' + streamId + ')');
}

// ============================================================================
// ★ 复制事务层（2026-08-24 移植 q3 TransactionManager）—
//   事务 id = streamId（渲染层任务即事务）。记录落盘 OS 级 copy-tx.json
//   （squads.json 同目录模式）→ 进程崩溃后下次启动 recover 精确清理半成品。
//   语义对齐 q3: ① tempFiles 预注册（取消/恢复可删未落地文件）
//   ② landedFiles 只记新文件（去重命中复用旧文件不记，绝不误删）
//   ③ 恢复 = tempFiles − landedFiles 精确差集（无时间猜测，安全方向）
//   ④ 200/100 截断（closed/过期优先，旧者先删）
//   取消清理不再整树 rm 目标目录（曾误删已落地文件）→ 按事务差集精确删。
// ============================================================================
interface CopyTx {
    id: string;
    targetDir: string;      // 粘贴目标目录
    tempFiles: string[];    // 本次任务创建的 dest（未落地/半成品，恢复时删）
    landedFiles: string[];  // 已成功落地的最终路径（恢复时保护）
    dirs: string[];         // 本次新建目录（恢复时仅删空目录）
    status: 'pending' | 'done' | 'cancelled';
    createdAt: number;
    lastActiveAt: number;
    ownerPid?: number;      // ★ 所属实例进程 pid (2026-08-29 多实例修复: 恢复前存活检查, 防误删他实例进行中复制)
}

function _txStorePath(): string {
    // %LOCALAPPDATA%/qqqide/ —— squads.json 同目录（USERPROFILE 推导，零 env 依赖）
    // QQQIDE_COPY_TX 环境变量可覆盖（测试隔离用）
    try {
        const override = process.env.QQQIDE_COPY_TX;
        if (override) return override;
        const base = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? process.env.USERPROFILE + '\\AppData\\Local' : '');
        return base ? path.join(base, 'qqqide', 'copy-tx.json') : '';
    } catch { return ''; }
}

const _txStore = new Map<string, CopyTx>();
let _txPersistTimer: any = null;
// ★ 本实例显式终结/回滚的事务 id（合并时跳过——防「删除后写前合并把旧快照读回 → 记录复活」）
const _txRemoved = new Set<string>();

function _txLoadFromDisk(): void {
    const p = _txStorePath();
    if (!p || !fs.existsSync(p)) return;
    try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (raw && Array.isArray(raw.transactions)) {
            for (const t of raw.transactions) {
                if (!t || typeof t.id !== 'string' || !t.id) continue;
                if (_txRemoved.has(t.id)) continue; // 本实例已删除 → 绝不复活
                if (_txStore.has(t.id)) continue; // 内存新态优先（LWW：磁盘只补缺不覆盖）
                _txStore.set(t.id, {
                    id: t.id,
                    targetDir: typeof t.targetDir === 'string' ? t.targetDir : '',
                    tempFiles: Array.isArray(t.tempFiles) ? t.tempFiles : [],
                    landedFiles: Array.isArray(t.landedFiles) ? t.landedFiles : [],
                    dirs: Array.isArray(t.dirs) ? t.dirs : [],
                    status: t.status === 'pending' ? 'pending' : (t.status === 'done' ? 'done' : 'cancelled'),
                    createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
                    lastActiveAt: typeof t.lastActiveAt === 'number' ? t.lastActiveAt : Date.now(),
                    ownerPid: typeof t.ownerPid === 'number' ? t.ownerPid : undefined
                });
            }
        }
    } catch { /* 损坏 → 忽略（下一轮原子写重建干净状态） */ }
}

// ★ 200/100 截断（q3 权重语义）：closed（done/cancelled）+2、>60 天 +1，权重高者先删，平局旧者先删
function _txTruncate(list: CopyTx[]): CopyTx[] {
    if (list.length <= 200) return list;
    const SIXTY_DAYS = 5184000000;
    const now = Date.now();
    const getWeight = (t: CopyTx) => {
        let w = 0;
        if (t.status === 'done' || t.status === 'cancelled') w += 2;
        if (now - t.createdAt > SIXTY_DAYS) w += 1;
        return w;
    };
    const sorted = [...list].sort((a, b) => {
        const wA = getWeight(a), wB = getWeight(b);
        if (wA !== wB) return wB - wA;
        return a.createdAt - b.createdAt;
    });
    const del = new Set(sorted.slice(0, 100).map(t => t.id));
    return list.filter(t => !del.has(t.id));
}

function _txPersistNow(): void {
    const p = _txStorePath();
    if (!p) return;
    try {
        // ★ 写前磁盘合并（dev+绿色包同跑互不覆盖）：磁盘条目不在内存 → 补入
        _txLoadFromDisk();
        const list = _txTruncate([..._txStore.values()]);
        _txPersistTimer = null;
        _atomicWrite(p, Buffer.from(JSON.stringify({ transactions: list }), 'utf8')).catch(() => { /* 写失败不阻塞复制 */ });
    } catch { /* ignore */ }
}

function _txPersist(): void {
    if (_txPersistTimer) return;
    _txPersistTimer = setTimeout(_txPersistNow, 300); // 300ms 防抖（崩溃窗口内缺失条目=残留半成品不删，安全方向）
}

// 惰性创建事务（streamId 首次出现时；targetDir = 粘贴目标）
function _txEnsure(streamId: string, targetDir: string): void {
    if (!streamId) return;
    if (_txStore.has(streamId)) return;
    const now = Date.now();
    _txStore.set(streamId, {
        id: streamId,
        targetDir: targetDir || '',
        tempFiles: [],
        landedFiles: [],
        dirs: [],
        status: 'pending',
        createdAt: now,
        lastActiveAt: now,
        ownerPid: process.pid  // ★ 归属实例 pid — 他实例启动恢复据此判断是否存活, 存活则绝不动
    });
    _txPersistNow(); // 创建即时落盘（崩溃时事务必须可见）
}

// 注册半成品（dest 确定新建后、写流前调用；幂等）
function _txRegister(streamId: string, filePath: string): void {
    if (!streamId || !filePath) return;
    const tx = _txStore.get(streamId);
    if (!tx) return;
    const n = path.normalize(filePath);
    if (!tx.tempFiles.includes(n)) tx.tempFiles.push(n);
    tx.lastActiveAt = Date.now();
    _txPersist();
}

// 注册新建目录（目录复制；恢复时仅删空目录）
function _txRegisterDir(streamId: string, dirPath: string): void {
    if (!streamId || !dirPath) return;
    const tx = _txStore.get(streamId);
    if (!tx) return;
    const n = path.normalize(dirPath);
    if (!tx.dirs.includes(n)) tx.dirs.push(n);
    tx.lastActiveAt = Date.now();
    _txPersist();
}

// 落地：从 tempFiles 移除 dest，landedFiles 追加最终路径（仅新文件；去重命中复用旧文件不记）
function _txMarkLanded(streamId: string, dest: string, finalPath: string): void {
    if (!streamId) return;
    const tx = _txStore.get(streamId);
    if (!tx) return;
    const d = path.normalize(dest);
    tx.tempFiles = tx.tempFiles.filter(f => f !== d);
    const f = path.normalize(finalPath);
    if (f === d || fs.existsSync(f)) {
        if (!tx.landedFiles.includes(f)) tx.landedFiles.push(f);
    }
    tx.lastActiveAt = Date.now();
    _txPersist();
}

// 半成品已删 → 从 tempFiles 移除（取消 unlink 后调用，防恢复时再删一次）
function _txUnregister(streamId: string, filePath: string): void {
    if (!streamId || !filePath) return;
    const tx = _txStore.get(streamId);
    if (!tx) return;
    const n = path.normalize(filePath);
    tx.tempFiles = tx.tempFiles.filter(f => f !== n);
    _txPersist();
}

// ★ 事务级回滚（替代整树 rm）：tempFiles − landedFiles 精确删 + 空目录清理（从深到浅）
function _txRollback(streamId: string): void {
    const tx = _txStore.get(streamId);
    if (!tx) return;
    try {
        const landed = new Set(tx.landedFiles.map(f => _cacheKeyForPath(f)));
        for (const f of tx.tempFiles) {
            if (landed.has(_cacheKeyForPath(f))) continue;
            try {
                const st = fs.statSync(f);
                if (st.isDirectory()) fs.rmSync(f, { recursive: true, force: true });
                else fs.unlinkSync(f);
            } catch { /* 已删/占用/权限 → 跳过 */ }
        }
        // 空目录清理：叶子优先（dirs 按创建序，倒序遍历即深处优先）
        const dirs = [...tx.dirs];
        for (let i = dirs.length - 1; i >= 0; i--) {
            try {
                const st = fs.statSync(dirs[i]);
                if (st.isDirectory() && fs.readdirSync(dirs[i]).length === 0) {
                    fs.rmdirSync(dirs[i]);
                }
            } catch { /* ignore */ }
        }
        // 目标目录本身若为空且为本次新建的顶层目录 → 也删（仅当任务只复制了目录且全部回滚）
        try {
            const td = tx.targetDir;
            if (td && fs.existsSync(td)) {
                const st = fs.statSync(td);
                if (st.isDirectory() && fs.readdirSync(td).length === 0 && tx.dirs.includes(path.normalize(td))) {
                    fs.rmdirSync(td);
                }
            }
        } catch { /* ignore */ }
    } catch { /* ignore */ }
}

// 事务终结（渲染层任务收尾调用）：删除记录（removed 标记防合并复活）
function _txEnd(streamId: string): void {
    if (!streamId) return;
    _txStore.delete(streamId);
    _txRemoved.add(streamId);
    _txPersistNow();
}

// ★ 进程存活探测（仅探测不杀）: true=存活 / false=已死 / null=无记录不可判定
function _pidAlive(pid: number | undefined): boolean | null {
    if (typeof pid !== 'number' || !isFinite(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return true; }
    catch (e: any) { return (e && e.code === 'ESRCH') ? false : true; } // EPERM=存在; 其他异常按存活处理(安全方向)
}

// ★ 崩溃恢复（registerFsIpc 启动时异步执行）：pending 事务 → 差集精确清理 → 删记录
//   ★ 2026-08-29 多实例修复: 恢复判定 = ownerPid 存活检查（主）+ lastActiveAt 新鲜度（辅）。
//     实例 B 启动瞬间实例 A 正在复制大文件 → A 的 pending 事务 ownerPid 存活 → 跳过，绝不误删
//     他实例半成品（旧实现无归属校验，无条件全清 → A 复制必断）。安全方向: 不确定 → 不删
//     （残留半成品无害；删错他实例进行中文件 = 复制中断）。
//     活事务 lastActiveAt 距现在理论上无硬上界（单文件大复制期间不更新），
//     但 pid 存活 + 超 6h 无任何活动 → pid 必已被系统复用（原进程早死）→ 可清；
//     无 pid 记录（旧版遗留）→ 仅新鲜度判定，阈值放宽到 24h 防误伤旧版实例长复制。
const _TX_STALE_OWNED_MS = 6 * 3600 * 1000;    // pid 存活但超 6h 无活动 → pid 复用, 可清
const _TX_STALE_UNOWNED_MS = 24 * 3600 * 1000; // 无 pid 记录 (旧版) → 仅按新鲜度, 保守
async function _txRecover(): Promise<void> {
    try {
        _txLoadFromDisk();
        if (_txStore.size === 0) return;
        const pending = [..._txStore.values()].filter(t => t.status === 'pending');
        if (pending.length === 0) { _txStore.clear(); return; }
        let cleaned = 0, skipped = 0;
        const now = Date.now();
        for (const tx of pending) {
            let shouldClean: boolean;
            if (tx.ownerPid === process.pid) {
                shouldClean = false; // 自己的事务（启动时理论上不存在，防御）
            } else {
                const alive = _pidAlive(tx.ownerPid);
                if (alive === false) shouldClean = true;                                      // 主人已死 → 必清
                else if (alive === true) shouldClean = now - tx.lastActiveAt > _TX_STALE_OWNED_MS;   // 活进程但超 6h 无活动 → pid 复用
                else shouldClean = now - tx.lastActiveAt > _TX_STALE_UNOWNED_MS;               // 无 pid 记录 → 仅新鲜度
            }
            if (!shouldClean) { skipped++; continue; } // 他实例进行中/近期崩溃 → 保留, 由所属实例下次启动清理
            try {
                _txRollback(tx.id);
                cleaned += tx.tempFiles.length;
            } catch { /* 单事务失败不阻断 */ }
            _txStore.delete(tx.id);
            _txRemoved.add(tx.id);
        }
        _txPersistNow();
        if (cleaned > 0 || skipped > 0) {
            console.log('[copy-tx] recover: cleaned ' + cleaned + ' leftover item(s) from crashed tx, skipped ' + skipped + ' live/pending tx');
        }
    } catch { /* ignore */ }
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

    // ★ 取消复制（2026-08-24 ioast 中断）：置取消标志 → 各复制路径检查后中止 + 事务级半成品清理
    ipcMain.handle('qqqide:fs:cancelCopy', (_e, streamId: string) => {
        if (streamId) _copyCancels.add(streamId);
        return true;
    });

    // ★ 复制事务终结（渲染层批量任务收尾显式调用；进程崩溃则由 _txRecover 兜底）
    ipcMain.handle('qqqide:fs:copyTxEnd', (_e, streamId: string) => {
        if (streamId) _txEnd(streamId);
        return true;
    });

    // ★ copyFile — 流式复制 + 进度回调 + 指纹去重（通过 IPC event 通道）
    //  渲染层调 bridge.fs.copyFile(src, dest, onProgress) → 主进程流式复制
    //  ★ 2026-08-13 目录感知升级：src 为目录 → 递归复制（8 路并发 + 字节级进度）
    //     roam 粘贴文件夹 / 编辑框所见即所得粘贴文件夹 统一走此引擎（单一入口）
    //  ★ 2026-08-24 指纹去重（q3 语义）：
    //    ① src===dest（同目录粘贴）→ 先唯一化（防 createReadStream+createWriteStream 同路径截断）
    //    ② dest 已存在 → 指纹相同跳过复制（复用既有文件，零副本）；不同 → 唯一化（防覆盖）
    //    ③ 复制后 _tryLocalDeduplicate 同目录扫描（命中删新副本复用既有文件）
    //    返回最终落盘路径（string）——去重命中/唯一化改名后消费方可用返回值建锚点；
    //    旧布尔判断调用方（!== false / === false）语义不变（string 恒真）。
    ipcMain.handle('qqqide:fs:copyFile', async (e, src: string, dest: string, streamId?: string) => {
        try {
            const st = await fs.promises.stat(src);
            if (_copyCancelled(streamId)) throw _cancelErr(streamId);
            // ★ 同目录粘贴 src===dest 守卫：先唯一化，防自截断（F1 曾实锤 0 字节事故）
            if (_cacheKeyForPath(path.resolve(src)) === _cacheKeyForPath(path.resolve(dest))) {
                dest = getUniquePath(path.dirname(dest), path.basename(dest));
            }
            if (st.isDirectory()) {
                // ── 目录：递归复制；目标已存在 → 唯一化（q3 语义，防合并覆盖）──
                 if (fs.existsSync(dest)) dest = getUniquePath(path.dirname(dest), path.basename(dest));
                await fs.promises.mkdir(dest, { recursive: true });
                // ★ 事务：目标目录 + 新建顶层目录注册（必须在复制前——
                //   worker 的 _txRegister 依赖事务已存在，注册迟到即半成品记录全丢）
                _txEnsure(streamId, path.dirname(dest));
                _txRegisterDir(streamId, dest);
                try {
                    await _copyDirRecursive(e, src, dest, streamId);
                } catch (err) {
                    // ★ 取消 → 事务级精确回滚（tempFiles − landedFiles 差集，不再整树 rm——
                    //   曾误删已落地文件；目录仅删空的，有文件落地的保留）
                    if (_copyCancelled(streamId)) {
                        _txRollback(streamId);
                    }
                    throw err;
                }
                return dest;
            }
            // ── 文件 ──
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            // ★ 事务：目标目录确定后惰性创建（targetDir = 粘贴目标）
            _txEnsure(streamId, path.dirname(dest));
            // ★ 同目录判定（2026-09-03 原地粘贴 100% 假成功修复）：
            //   去重 skip/回收仅限「跨目录复制」——目标文件夹已有一份相同内容才算重复；
            //   同目录/原地粘贴 = 用户显式「复制一份」，必须唯一化建新副本且事后绝不回收。
            const sameDir = _cacheKeyForPath(path.resolve(path.dirname(src))) === _cacheKeyForPath(path.resolve(path.dirname(dest)));
            // ★ dest 已存在 → 指纹判断：仅跨目录同内容跳过复制（去重命中复用），
            //   不同内容或同目录 → 唯一化（防覆盖；q3 autoRename=true 语义）
            if (fs.existsSync(dest)) {
                if (!sameDir) {
                    const sfp = computeFingerprint(src);
                    const dfp = computeFingerprint(dest);
                    if (sfp && dfp === sfp) {
                        if (sfp) prefillFingerprint(dest, sfp);
                        return dest;
                    }
                }
                dest = getUniquePath(path.dirname(dest), path.basename(dest));
            }
            // ★ 事务：dest 确定新建 → 注册半成品（取消/崩溃恢复时精确删）
            _txRegister(streamId, dest);
            const totalSize = st.size;
            const readStream = fs.createReadStream(src, { highWaterMark: 1024 * 1024 }); // 1MB chunks
            const writeStream = fs.createWriteStream(dest);

            if (streamId && totalSize > 0) _aggAdd(streamId, totalSize);
            readStream.on('data', (chunk: Buffer) => {
                if (_copyCancelled(streamId)) {
                    // ★ 取消 → 立即中止流。必须 destroy(error)——无参 destroy 不触发 'error' 事件，
                    //   promise 永不 settle → 复制永久挂起（2026-08-24 实测）。
                    readStream.destroy(_cancelErr(streamId));
                    writeStream.destroy();
                    return;
                }
                const agg = _copyAgg.get(streamId);
                if (agg) agg.copied += chunk.length;
                _aggReport(e, streamId);
            });

            try {
                await new Promise<boolean>((resolve, reject) => {
                    readStream.on('error', reject);
                    writeStream.on('error', reject);
                    writeStream.on('finish', () => resolve(true));
                    readStream.pipe(writeStream);
                });
            } catch (err) {
                // ★ 取消/流中断 → 半成品删除 + 事务登记移除（dest 为本次新建）
                if (_copyCancelled(streamId)) {
                    _txUnregister(streamId, dest);
                    try { await fs.promises.unlink(dest); } catch { /* ignore */ }
                    throw _cancelErr(streamId);
                }
                throw err;
            }
            // ★ 收尾强制刷新（100ms 节流窗口内最后一帧不丢，UI 进度恒达 100%）
            _aggReport(e, streamId, true);
            // ★ 复制完成但取消已置位（finish 与取消竞态）→ 删掉并报取消
            if (_copyCancelled(streamId)) {
                _txUnregister(streamId, dest);
                try { await fs.promises.unlink(dest); } catch { /* ignore */ }
                throw _cancelErr(streamId);
            }
            // ★ 复制后同目录指纹去重：仅跨目录才执行（q3 autoRename=true 语义——同目录/原地
            //   复制必保留新副本；旧实现无条件事后去重 → 副本与源文件同指纹被回收删掉 →
            //   「1 copied 但文件没出现」100% 假成功，2026-09-03 实锤修复）
            //   命中 → 新副本已删，返回既有文件路径；landed 记最终路径（绝不误删既有）
            const finalPath = sameDir ? dest : _tryLocalDeduplicate(dest);
            _txMarkLanded(streamId, dest, finalPath);
            return finalPath;
        } catch (e: any) {
            // ★ 2026-08-24: ENOENT 静默 return false → 渲染层若不检查返回值即"假成功"
            //   （roam 粘贴曾实锤: 路径乱码 stat 失败仍显示 "1 copied"）。必须抛错让调用方感知。
            if (e.code === 'ENOENT') throw new Error('copyFile source not found: ' + src);
            throw e;
        } finally {
            // ★ 聚合/取消记录清理（成功、失败、取消三路径统一回收）
            if (streamId) _aggCleanup(streamId);
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
        if (streamId && totalBytes > 0) _aggAdd(streamId, totalBytes);
        const report = () => {
            if (streamId && totalBytes > 0) _aggReport(e, streamId);
        };
        const worker = async (): Promise<void> => {
            while (true) {
                if (_copyCancelled(streamId)) throw _cancelErr(streamId);
                const i = idx++;
                if (i >= files.length) return;
                const f = files[i];
                const rel = path.relative(src, f);
                let out = path.join(dest, rel);
                await fs.promises.mkdir(path.dirname(out), { recursive: true });
                // ★ 2026-08-24 指纹去重（q3 语义）：目标已存在 → 指纹相同跳过复制（零副本）；
                //   不同 → 唯一化（防覆盖，合并语义改为不覆盖）。
                if (fs.existsSync(out)) {
                    const sfp = computeFingerprint(f);
                    const dfp = computeFingerprint(out);
                    if (sfp && dfp === sfp) {
                        if (sfp) prefillFingerprint(out, sfp);
                        continue;
                    }
                    out = getUniquePath(path.dirname(out), path.basename(out));
                }
                // ★ 事务：dest 确定新建 → 注册半成品（q3 预注册语义；取消/恢复时精确删）
                _txRegister(streamId, out);
                await new Promise<void>((resolve, reject) => {
                    const rs = fs.createReadStream(f, { highWaterMark: 1024 * 1024 });
                    const ws = fs.createWriteStream(out);
                    rs.on('data', (chunk: Buffer) => {
                        // ★ destroy(error)：无参 destroy 不触发 'error' → promise 永不 settle（实测挂起）
                        if (_copyCancelled(streamId)) { rs.destroy(_cancelErr(streamId)); ws.destroy(); return; }
                        copiedBytes += chunk.length;
                        const agg = _copyAgg.get(streamId);
                        if (agg) agg.copied += chunk.length;
                        report();
                    });
                    rs.on('error', reject);
                    ws.on('error', reject);
                    ws.on('finish', () => resolve());
                    rs.pipe(ws);
                });
                // ★ 复制后同目录指纹去重（命中 → 新副本已删；复用旧文件不记 landed）
                const fin = _tryLocalDeduplicate(out);
                _txMarkLanded(streamId, out, fin);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONC, files.length || 1) }, () => worker()));
        _aggReport(e, streamId, true); // 收尾强制刷新（节流窗口内最后一帧不丢）
        return true;
    }

    // ★ 崩溃恢复（启动即跑，不阻塞）：pending 事务半成品精确清理
    _txRecover().catch(() => { /* ignore */ });

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
