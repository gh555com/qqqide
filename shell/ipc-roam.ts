// ============================================================================
// ipc-roam.ts — roam 资源管理器 OS 级持久化 (sql.js → roam.sq3, 唯一读写者)
//
// 架构:
//   q2-roam.html → bridge.roam.* → 此模块 (sql.js) → %LOCALAPPDATA%/qqqide/roam.sq3
//
// 并发: 仅 JS 单写入者。WAL 模式天然并发安全。
// 跨窗口同步: set 后 broadcast 'qqqide:roam:changed' → 所有 BrowserWindow → iframe 重载
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ipcMain, BrowserWindow } from 'electron';

const initSqlJs = require('sql.js');

// ── DB 路径 (OS 级唯一: %LOCALAPPDATA%/qqqide/roam.sq3) ──
function getDbPath(): string {
    const localAppData = path.join(os.homedir(), 'AppData', 'Local');
    const dir = path.join(localAppData, 'qqqide');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'roam.sq3');
}

// ── 懒初始化 ──
let _SQL: any = null;
let _db: any = null;
let _initPromise: Promise<void> | null = null;
let _lastDiskMtime = 0;

// ★ 损坏自愈 (2026-08-06 F20 事故: C盘 ENOSPC → roam.sq3 0字节 → OS get failed 刷屏)
//   三级恢复链: 主文件 → .prev(上一完好版) → 重建全新 DB，绝不带着损坏库继续跑
function _loadOrRecreate(dbPath: string, table: string): any {
    const tryLoad = (p: string): any | null => {
        if (!fs.existsSync(p)) return null;
        try {
            const db = new _SQL.Database(fs.readFileSync(p));
            const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
            if (r.length && r[0].values.length) return db;
            db.close();
        } catch { /* fall through */ }
        return null;
    };
    const db = tryLoad(dbPath);
    if (db) return db;
    // ★ .prev 回退 (2026-08-06 F26): 主文件损坏 → 上一完好版自动顶上
    const prev = tryLoad(dbPath + '.prev');
    if (prev) {
        console.warn('[roam] db corrupt, restoring from .prev');
        return prev;
    }
    console.warn('[roam] db corrupt, recreating');
    return new _SQL.Database(null);
}

async function _ensureDb(): Promise<void> {
    if (_db) return;
    if (_initPromise) { await _initPromise; return; }
    _initPromise = (async () => {
        _SQL = await initSqlJs();
        const dbPath = getDbPath();
        _db = _loadOrRecreate(dbPath, 'roam_state');
        _db.run('PRAGMA journal_mode=WAL');
        _db.run(`CREATE TABLE IF NOT EXISTS roam_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0
        )`);
        _saveDb();
        _lastDiskMtime = fs.statSync(dbPath).mtimeMs;
    })();
    await _initPromise;
}

function _memoryRows(): number {
    try {
        const r = _db.exec('SELECT COUNT(*) FROM roam_state');
        return r.length && r[0].values.length ? r[0].values[0][0] : 0;
    } catch { return 0; }
}

function _countRowsFromDisk(dbPath: string): number {
    try {
        const db = new _SQL.Database(fs.readFileSync(dbPath));
        const r = db.exec('SELECT COUNT(*) FROM roam_state');
        db.close();
        return r.length && r[0].values.length ? r[0].values[0][0] : 0;
    } catch { return -1; }
}

function _saveDb(): void {
    if (!_db) return;
    const dbPath = getDbPath();
    try {
        // ★ 外部修改守卫 (2026-08-06 F26): 迁移/其他实例改过磁盘且行数更多 → 以磁盘为准，不覆盖
        if (_lastDiskMtime > 0 && fs.existsSync(dbPath)) {
            const mtime = fs.statSync(dbPath).mtimeMs;
            if (mtime > _lastDiskMtime) {
                const diskRows = _countRowsFromDisk(dbPath);
                if (diskRows > _memoryRows()) {
                    console.warn('[roam] external db change detected, adopting disk (rows ' + diskRows + ')');
                    _reloadIfChanged();
                    return;
                }
            }
        }
        // ★ 写前保留上一完好版 (.prev) — 任何损坏可回退 (2026-08-06 F26)
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, dbPath + '.prev');
        }
        const data = _db.export();
        const tmp = dbPath + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(data));
        fs.renameSync(tmp, dbPath);   // ★ 原子替换（铁律 8.2）— ENOSPC/断电不再截断主库
        _lastDiskMtime = fs.statSync(dbPath).mtimeMs;
    } catch (e: any) {
        // 磁盘满/占用 → 保留内存态，不破坏磁盘文件
        console.warn('[roam] db save failed:', e.message);
        try { if (fs.existsSync(dbPath + '.tmp')) fs.unlinkSync(dbPath + '.tmp'); } catch { /* ignore */ }
    }
}

function _reloadIfChanged(): void {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return;
    const mtime = fs.statSync(dbPath).mtimeMs;
    if (mtime <= _lastDiskMtime) return;
    try {
        const buf = fs.readFileSync(dbPath);
        if (_db) _db.close();
        _db = new _SQL.Database(buf);
        _db.run('PRAGMA journal_mode=WAL');
        _lastDiskMtime = mtime;
    } catch (e: any) {
        console.warn('[roam] reload failed, restoring:', e.message);
        if (_db) { try { _db.close(); } catch { /* ignore */ } }
        // ★ 损坏恢复链 (2026-08-06 F26 补漏): 主文件 → .prev → 重建，绝不直接空库
        _db = _loadOrRecreate(dbPath, 'roam_state');
        _db.run('PRAGMA journal_mode=WAL');
        _lastDiskMtime = 0; // 强制下次 _saveDb 重新评估外部修改
    }
}

// ── KV 操作 ──
function _get(key: string): any {
    _reloadIfChanged();
    const stmt = _db.prepare('SELECT value FROM roam_state WHERE key=?');
    try {
        stmt.bind([key]);
        if (stmt.step()) {
            const row = stmt.getAsObject();
            return JSON.parse(row.value);
        }
        return null;
    } finally {
        stmt.free();
    }
}

function _set(key: string, value: any): void {
    _reloadIfChanged();
    const json = JSON.stringify(value);
    _db.run('INSERT OR REPLACE INTO roam_state (key, value, updated_at) VALUES (?,?,?)',
        [key, json, Date.now()]);
    _saveDb();
}

function _getAll(): Record<string, any> {
    _reloadIfChanged();
    const result: Record<string, any> = {};
    const stmt = _db.prepare('SELECT key, value FROM roam_state');
    try {
        while (stmt.step()) {
            const row = stmt.getAsObject();
            try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
        }
    } finally {
        stmt.free();
    }
    return result;
}

// ── 自动感知外部变化 (2026-08-08, q3 autoWatchChanges 移植, 默认开启, 不做偏好设置) ──
// q3 语义对齐: 6s 冷却(事件后忽略窗口) + 临时下载文件智能过滤
//   .crdownload 等存在=新下载开始(smart) / 已删=下载完成改名(800ms 后强制刷新) / change=下载中完全忽略
const WATCH_COOLDOWN_MS = 6000;
const DOWNLOAD_COMPLETE_DELAY_MS = 800;
const TEMP_DOWNLOAD_EXTS = ['.crdownload', '.part', '.download', '.partial', '.tmp'];

interface RoamDirWatch {
    watcher: fs.FSWatcher | null;
    lastRefresh: number;
    pendingTimer: NodeJS.Timeout | null;
    burstTimer: NodeJS.Timeout | null;   // ★ 2026-08-09: Windows 事件突发合并 (一次操作连发 rename+change+rename → 一次广播)
}
const _roamWatches = new Map<string, RoamDirWatch>();  // dir → watch 状态 (多窗口同目录共享一个 watcher + 冷却)
const _roamWinDirs = new Map<number, string>();         // webContents id → dir

function _isTempDownload(fname: string | null | undefined): boolean {
    if (!fname) return false;
    const fn = Buffer.isBuffer(fname) ? fname.toString() : String(fname);
    const lower = fn.toLowerCase();
    return TEMP_DOWNLOAD_EXTS.some(ext => lower.endsWith(ext));
}

function _broadcastFsChanged(dir: string): void {
    BrowserWindow.getAllWindows().forEach(win => {
        if (win.isDestroyed()) return;
        if (_roamWinDirs.get(win.webContents.id) !== dir) return;
        try { win.webContents.send('qqqide:roam:fs-changed', { dir }); } catch { /* ignore */ }
    });
}

function _smartRefresh(dir: string): void {
    const st = _roamWatches.get(dir);
    if (!st) return;
    const now = Date.now();
    if (now - st.lastRefresh < WATCH_COOLDOWN_MS) return;  // 冷却期内忽略
    // ★ 2026-08-09 突发合并: Windows 一次真实变更常连发多个事件(rename+change 对、重复事件) → 250ms 尾随合并为一次广播
    if (st.burstTimer) clearTimeout(st.burstTimer);
    st.burstTimer = setTimeout(() => {
        st.burstTimer = null;
        st.lastRefresh = Date.now();  // 冷却从实际广播时刻起算 (q3 语义: cooldown 从 refresh 起)
        _broadcastFsChanged(dir);
    }, 250);
}

function _forceRefresh(dir: string): void {
    const st = _roamWatches.get(dir);
    if (!st) return;
    st.lastRefresh = Date.now();
    _broadcastFsChanged(dir);
}

function _scheduleDownloadCompleteRefresh(dir: string): void {
    const st = _roamWatches.get(dir);
    if (!st) return;
    if (st.pendingTimer) clearTimeout(st.pendingTimer);
    st.pendingTimer = setTimeout(() => {
        st.pendingTimer = null;
        _forceRefresh(dir);
    }, DOWNLOAD_COMPLETE_DELAY_MS);
}

function _createWatch(dir: string): void {
    const st: RoamDirWatch = { watcher: null, lastRefresh: 0, pendingTimer: null, burstTimer: null };
    _roamWatches.set(dir, st);
    try {
        st.watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
            if (eventType === 'rename') {
                if (_isTempDownload(filename)) {
                    // 临时下载文件: 存在=新下载开始 / 已删=下载完成改名 → 延迟强制刷新
                    const fp = path.join(dir, Buffer.isBuffer(filename) ? filename.toString() : String(filename));
                    let exists = false;
                    try { exists = fs.existsSync(fp); } catch { exists = false; }
                    if (exists) _smartRefresh(dir);
                    else _scheduleDownloadCompleteRefresh(dir);
                    return;
                }
                _smartRefresh(dir);
            } else if (eventType === 'change') {
                if (_isTempDownload(filename)) return;  // 下载中持续写入 → 完全忽略, 防噪音刷新
                _smartRefresh(dir);
            }
        });
        st.watcher.on('error', () => { _disposeWatch(dir); });  // 目录被删/权限变化 → 关闭, 下次导航重建
    } catch {
        st.watcher = null;  // 目录不存在/无权限 → 静默降级, 不阻塞导航
    }
}

function _disposeWatch(dir: string): void {
    const st = _roamWatches.get(dir);
    if (!st) return;
    if (st.pendingTimer) { clearTimeout(st.pendingTimer); st.pendingTimer = null; }
    if (st.burstTimer) { clearTimeout(st.burstTimer); st.burstTimer = null; }
    if (st.watcher) { try { st.watcher.close(); } catch { /* ignore */ } st.watcher = null; }
    let stillUsed = false;
    _roamWinDirs.forEach(d => { if (d === dir) stillUsed = true; });
    if (stillUsed) _createWatch(dir);  // 目录恢复场景自动重建
    else _roamWatches.delete(dir);
}

function _watchDir(winId: number, dir: string): void {
    const old = _roamWinDirs.get(winId);
    if (old === dir) return;
    if (old) {
        _roamWinDirs.delete(winId);
        let used = false;
        _roamWinDirs.forEach(d => { if (d === old) used = true; });
        if (!used) _disposeWatch(old);
    }
    if (!dir) return;
    _roamWinDirs.set(winId, dir);
    if (!_roamWatches.has(dir)) _createWatch(dir);
}

function _watchMark(winId: number): void {
    const dir = _roamWinDirs.get(winId);
    if (!dir) return;
    const st = _roamWatches.get(dir);
    if (st) st.lastRefresh = Date.now();  // roam 手动刷新后 6s 内 watcher 事件忽略 → 自身操作不双刷
}

// ── IPC 注册 ──
export function registerRoamIpc(): void {
    ipcMain.handle('qqqide:roam:get', async (_e, key: string) => {
        await _ensureDb();
        return _get(key);
    });

    ipcMain.handle('qqqide:roam:set', async (_e, key: string, value: any) => {
        await _ensureDb();
        _set(key, value);
        // ★ 广播到所有窗口 → 跨窗口秒级同步
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                try { win.webContents.send('qqqide:roam:changed', { key, value }); } catch { /* ignore */ }
            }
        });
        return true;
    });

    ipcMain.handle('qqqide:roam:getAll', async () => {
        await _ensureDb();
        return _getAll();
    });

    // ── 自动感知外部变化 (q3 autoWatchChanges 移植, 默认开) ──
    ipcMain.handle('qqqide:roam:watch', (e, dir: string) => {
        const winId = e.sender.id;
        _watchDir(winId, dir);
        e.sender.once('destroyed', () => {  // 窗口关闭 → 释放绑定, 无泄漏
            _roamWinDirs.delete(winId);
            let used = false;
            _roamWinDirs.forEach(x => { if (x === dir) used = true; });
            if (!used) _disposeWatch(dir);
        });
        return true;
    });

    ipcMain.handle('qqqide:roam:watch-mark', (e) => {
        _watchMark(e.sender.id);
        return true;
    });
}
