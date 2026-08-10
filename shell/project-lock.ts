// ============================================================================
// project-lock.ts — 项目锁仲裁中心（2026-08-10 冠军架构定案，F20 落地）
// ============================================================================
// CP 悲观硬互斥：与 squad（AP 乐观）模型不同——项目锁冲突代价 = 两个窗口写同一
// quest.sq3/only.sq3/all.json → 数据损坏，必须"拿不到就拒"，绝不共存。
//
// 设计（对比旧渲染层 claimLock 的三大结构性缺陷）：
//   · 单一入口：主进程 claimProject() 强制仲裁，boot 恢复 ×2 + 菜单新窗口 + 手动
//     添加（渲染层 query 预检）全部收敛于此。
//   · 原子抢锁：fs.writeFileSync(flag:'wx') = 内核 O_EXCL，消灭 stat→read→write
//     三步竞态（旧实现两个窗口同时启动 100% 双绑）。
//   · 活体注册表：锁内容 {instanceId, pid, hwnd, winId, folder, bootAt, atime}——
//     instanceId 区分同实例（可聚焦/接管）vs 跨实例（硬拒绝）；pid 双保险存活判定。
//   · 心跳上移主进程（10s，tmp+rename 原子写 + 写前/写后双重归属校验）：渲染层
//     reload 崩溃不再造成锁真空（旧 60s 陈旧窗口期 → 现在零窗口期）。
//   · 僵尸收敛：陈旧 25s 且 pid 不活 → unlink + wx 重抢；并发清除者只有一个赢家，
//     败者读回活锁拒绝（数学收敛）。
//   · watcher 兜底：锁文件被外部删除/替换 → 停止心跳 + 广播 lock-lost → 渲染层
//     重新仲裁（极端时序最后防线）。
// 锁文件: {project}/_qqq/alphal/.lock（保持路径不变，旧格式 {pid:0,atime} 兼容：
//         pid<=0 视为不活，仅按 atime 判断）。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'crypto';

const INSTANCE_ID = randomUUID();
const HEARTBEAT_MS = 10000;   // 主进程心跳（渲染层崩溃不影响锁有效）
const STALE_MS = 25000;       // 新格式锁陈旧判定（2.5 心跳周期容错，旧实现 60s → 零真空窗口）
const STALE_MS_LEGACY = 60000; // 旧格式锁（{pid:0,atime}，旧渲染层 30s 心跳）兼容阈值——
                              //   25s 阈值会周期性误杀旧壳层活锁（30s 周期内 5s 窗口 atime>25s），
                              //   导致新壳层抢锁双开（2026-08-10 绿色包旧壳层 + dev 新壳层实测事故）
const WATCH_DEBOUNCE_MS = 200;

interface LockHolder {
    instanceId: string;
    pid: number;
    hwnd: number;
    winId: number;
    folder: string;
    bootAt: number;
    atime: number;
}

interface HeldLock {
    folder: string;
    timer: NodeJS.Timeout | null;
    watcher: fs.FSWatcher | null;
}

// winId → 持有中的锁（同实例多窗口各持各的；同 folder 仅一窗口可持）
const _held = new Map<number, HeldLock>();
const _watchDebounce = new Map<number, number>();

function _norm(folder: string): string {
    return String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
}
function _lockPath(folder: string): string {
    return _norm(folder) + '/_qqq/alphal/.lock';
}
function _readLock(lp: string): LockHolder | null {
    try {
        const d = JSON.parse(fs.readFileSync(lp, 'utf-8'));
        if (!d || typeof d !== 'object') return null;
        return d as LockHolder;
    } catch { return null; }
}
function _pidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false; // 旧格式 pid=0 占位 → 不活
    try { process.kill(pid, 0); return true; }
    catch (e: any) { return !!(e && e.code === 'EPERM'); }
}
function _isMine(cur: LockHolder | null, winId: number): boolean {
    return !!(cur && cur.instanceId === INSTANCE_ID && cur.winId === winId);
}
function _writeLockAtomic(lp: string, data: LockHolder): boolean {
    const tmp = lp + '.tmp.' + process.pid;
    try {
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
        fs.renameSync(tmp, lp);
        return true;
    } catch {
        try { fs.unlinkSync(tmp); } catch { }
        return false;
    }
}
function _nativeHwnd(winId: number): number {
    try {
        const win = BrowserWindow.fromId(winId);
        if (!win || win.isDestroyed()) return 0;
        const buf: Buffer = (win as any).getNativeWindowHandle();
        if (buf && buf.length >= 4) return buf.readUInt32LE(0);
    } catch { }
    return 0;
}
function _focusWindow(winId: number): void {
    try {
        const win = BrowserWindow.fromId(winId);
        if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    } catch { }
}

// ── 锁丢失广播（极端时序/外部删除 → 渲染层重新仲裁） ──
function _broadcastLockLost(folder: string, winId: number): void {
    try {
        for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
                w.webContents.send('qqqide:project:lock-lost', { folder, winId });
            }
        }
    } catch { }
}
function _onLostLock(winId: number, folder: string): void {
    const h = _held.get(winId);
    if (!h) return;
    _stopHeartbeat(winId);
    console.warn('[project-lock] win=' + winId + ' LOST lock: ' + folder);
    _broadcastLockLost(folder, winId);
}
function _onLockFileChanged(winId: number, folder: string): void {
    const now = Date.now();
    const last = _watchDebounce.get(winId) || 0;
    if (now - last < WATCH_DEBOUNCE_MS) return;
    _watchDebounce.set(winId, now);
    if (!_held.has(winId)) return; // 已释放（自身 unlink 触发）
    const cur = _readLock(_lockPath(folder));
    if (!_isMine(cur, winId)) _onLostLock(winId, folder);
}

// ── 心跳（写前校验归属 → tmp+rename 原子写 → 写后校验防极端覆盖） ──
function _startHeartbeat(winId: number, folder: string): void {
    _stopHeartbeat(winId);
    const lp = _lockPath(folder);
    const timer = setInterval(() => {
        const cur = _readLock(lp);
        if (!_isMine(cur, winId)) { _onLostLock(winId, folder); return; }
        const next: LockHolder = { ...(cur as LockHolder), atime: Date.now() };
        if (!_writeLockAtomic(lp, next)) { _onLostLock(winId, folder); return; }
        const after = _readLock(lp);
        if (!_isMine(after, winId)) { _onLostLock(winId, folder); return; }
    }, HEARTBEAT_MS);
    let watcher: fs.FSWatcher | null = null;
    try { watcher = fs.watch(lp, () => _onLockFileChanged(winId, folder)); } catch { }
    _held.set(winId, { folder, timer, watcher });
}
function _stopHeartbeat(winId: number): void {
    const h = _held.get(winId);
    if (!h) return;
    if (h.timer) { clearInterval(h.timer); h.timer = null; }
    if (h.watcher) { try { h.watcher.close(); } catch { } h.watcher = null; }
    _held.delete(winId);
    _watchDebounce.delete(winId);
}

// ── 唯一仲裁入口 ──
export function claimProject(winId: number, folderRaw: string): { ok: boolean; reason?: string; holder?: LockHolder | null } {
    const folder = _norm(folderRaw);
    if (!folder) return { ok: false, reason: 'no-folder', holder: null };
    const lp = _lockPath(folder);

    // 幂等：本窗口已持有 → 刷新 atime
    const held = _held.get(winId);
    if (held && held.folder === folder) {
        const cur = _readLock(lp);
        if (_isMine(cur, winId)) _writeLockAtomic(lp, { ...(cur as LockHolder), atime: Date.now() });
        return { ok: true };
    }
    // 同实例其他窗口已持有 → 聚焦对方（同实例可接管语义保留）
    for (const [wid, hh] of _held) {
        if (hh.folder === folder && wid !== winId) {
            _focusWindow(wid);
            return { ok: false, reason: 'same-instance-other-window', holder: _readLock(lp) };
        }
    }

    const entry: LockHolder = {
        instanceId: INSTANCE_ID, pid: process.pid, hwnd: _nativeHwnd(winId),
        winId, folder, bootAt: Date.now(), atime: Date.now(),
    };
    try { fs.mkdirSync(path.dirname(lp), { recursive: true }); } catch { }

    // ★ 原子抢锁（内核 O_EXCL）
    try {
        fs.writeFileSync(lp, JSON.stringify(entry), { flag: 'wx' });
        _startHeartbeat(winId, folder);
        return { ok: true };
    } catch (e: any) {
        if (!e || e.code !== 'EEXIST') return { ok: false, reason: 'write-failed', holder: null };
    }

    // EEXIST → 读锁判定归属
    let cur = _readLock(lp);
    if (!cur) {
        // 损坏锁（原子写方案下只可能外力破坏）→ 清后重抢
        try { fs.unlinkSync(lp); } catch { }
        try {
            fs.writeFileSync(lp, JSON.stringify(entry), { flag: 'wx' });
            _startHeartbeat(winId, folder);
            return { ok: true };
        } catch { return { ok: false, reason: 'race-lost', holder: null }; }
    }
    if (cur.instanceId === INSTANCE_ID) {
        _focusWindow(cur.winId);
        return { ok: false, reason: 'same-instance-other-window', holder: cur };
    }
    // ★ 旧格式锁（渲染层 30s 心跳）必须用 60s 阈值，否则新壳层周期性误判僵尸抢锁（双开事故）
    const stale = Date.now() - (cur.atime || 0) >= (cur.instanceId ? STALE_MS : STALE_MS_LEGACY);
    if (!stale || _pidAlive(cur.pid)) {
        return { ok: false, reason: 'locked', holder: cur }; // ★ 硬拒绝：跨实例活锁
    }
    // 僵尸锁 → 清除重抢（并发清除者唯一 wx 赢家，败者读回活锁拒绝）
    try { fs.unlinkSync(lp); } catch { }
    try {
        fs.writeFileSync(lp, JSON.stringify(entry), { flag: 'wx' });
        _startHeartbeat(winId, folder);
        return { ok: true };
    } catch {
        const again = _readLock(lp);
        if (again && again.instanceId !== INSTANCE_ID) return { ok: false, reason: 'locked', holder: again };
        return { ok: false, reason: 'race-lost', holder: null };
    }
}

// ── 释放（校验 instanceId+winId，绝不误删他人锁） ──
export function releaseProject(winId: number, folderRaw?: string): void {
    const h = _held.get(winId);
    if (!h) return;
    if (folderRaw && h.folder !== _norm(folderRaw)) return;
    const lp = _lockPath(h.folder);
    _stopHeartbeat(winId);
    try {
        const cur = _readLock(lp);
        if (_isMine(cur, winId)) fs.unlinkSync(lp);
    } catch { }
}

// ── 查询（渲染层预检/兜底用；self = 是否本实例持有的锁） ──
export function queryProjectLock(folderRaw: string): { locked: boolean; holder?: LockHolder | null; stale?: boolean; self?: boolean } {
    const folder = _norm(folderRaw);
    if (!folder) return { locked: false, holder: null, stale: false, self: false };
    const cur = _readLock(_lockPath(folder));
    if (!cur) return { locked: false, holder: null, stale: false, self: false };
    const fresh = Date.now() - (cur.atime || 0) < (cur.instanceId ? STALE_MS : STALE_MS_LEGACY);
    const alive = fresh || _pidAlive(cur.pid);
    return { locked: alive, holder: cur, stale: !alive, self: cur.instanceId === INSTANCE_ID };
}

// ── IPC 注册 ──
export function registerProjectLockIpc(): void {
    ipcMain.handle('qqqide:project:claim', (_e, folder: string) => {
        const win = BrowserWindow.fromWebContents(_e.sender);
        if (!win) return { ok: false, reason: 'no-window', holder: null };
        return claimProject(win.id, folder);
    });
    ipcMain.handle('qqqide:project:release', (_e, folder?: string) => {
        const win = BrowserWindow.fromWebContents(_e.sender);
        if (win) releaseProject(win.id, folder);
        return { ok: true };
    });
    ipcMain.handle('qqqide:project:query', (_e, folder: string) => queryProjectLock(folder));
}
