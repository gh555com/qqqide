// ============================================================================
// ipc-roam.ts — roam 资源管理器 OS 级持久化 (sql.js → roam.sq3, 唯一读写者)
//
// 架构:
//   q2-roam.html → bridge.roam.* → 此模块 (sql.js) → %LOCALAPPDATA%/qqqide/roam.sq3
//
// 并发: 仅 JS 单写入者 + 跨进程逐 key LWW 合并 (2026-09-08, ws/search 同款算法);
//       目录 watcher 监听 roam.sq3 原子替换 → reload + diff → 广播 → 跨实例秒级一致
// 跨窗口/跨实例同步: set 或外部变更后 broadcast 'qqqide:roam:changed' {key,value} → shell-rpc → iframe _onRoamChanged
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
let _lastDiskSize = 0;   // ★ 2026-09-08: mtime+size 双签名 (state-sqlite 同款惯例, 同 ms 双写也检出)

function _diskChanged(dbPath: string): boolean {
    try {
        const s = fs.statSync(dbPath);
        return s.mtimeMs > _lastDiskMtime || (s.mtimeMs === _lastDiskMtime && s.size !== _lastDiskSize);
    } catch { return false; }
}
function _markDiskSynced(dbPath: string): void {
    try {
        const s = fs.statSync(dbPath);
        _lastDiskMtime = s.mtimeMs;
        _lastDiskSize = s.size;
    } catch { /* 保持旧签名 */ }
}

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
        _db.run('PRAGMA journal_mode=DELETE');
        _db.run(`CREATE TABLE IF NOT EXISTS roam_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0
        )`);
        _saveDb();
        _markDiskSynced(dbPath);
        _ensureDbWatcher();   // ★ 2026-09-08: 首次使用即开始监听跨实例变更
    })();
    await _initPromise;
}

// ★ 逐 key LWW 合并 (2026-09-08, ws/search 同款算法, schema 自带 updated_at 零迁移):
//   磁盘上 updated_at 更新或内存缺失的 key 采纳 (并集写入) → 跨实例 (dev+绿色包同跑) 零丢 key。
//   roam 无 del IPC、7 key 永不删行 → 并集语义无 q3 union 的删除复活问题。
//   自己刚 set 的 key 必带最新 ts → 永远不被外部旧值反超 → setter 写入永不静默丢弃
//   (旧守卫「磁盘行数更多 → 整库采纳」会把 setter 自己的写放弃, 2026-09-08 废除)
function _mergeDiskIntoMemory(dbPath: string): void {
    if (!fs.existsSync(dbPath)) return;
    let diskDb: any = null;
    try {
        diskDb = new _SQL.Database(fs.readFileSync(dbPath));
        const r = diskDb.exec('SELECT key, value, updated_at FROM roam_state');
        if (!r.length || !r[0].values.length) return;
        const mem = new Map<string, [string, number]>();
        const mr = _db.exec('SELECT key, value, updated_at FROM roam_state');
        if (mr.length && mr[0].values.length) {
            for (const row of mr[0].values) mem.set(String(row[0]), [String(row[1]), Number(row[2])]);
        }
        let changed = false;
        for (const row of r[0].values) {
            const k = String(row[0]);
            const cur = mem.get(k);
            if (!cur || Number(row[2]) > cur[1]) {
                mem.set(k, [String(row[1]), Number(row[2])]);
                changed = true;
            }
        }
        if (changed) {
            _db.run('DELETE FROM roam_state');
            const stmt = _db.prepare('INSERT INTO roam_state (key, value, updated_at) VALUES (?,?,?)');
            for (const [k, v] of mem) stmt.run([k, v[0], v[1]]);
            stmt.free();
            console.warn('[roam] external db change detected, merged ' + mem.size + ' key(s) (LWW)');
        }
    } catch { /* 磁盘损坏/占用 → 跳过合并直接写盘 (.prev 已兜底上一完好版) */ }
    finally { if (diskDb) { try { diskDb.close(); } catch { /* ignore */ } } }
}

function _saveDb(): void {
    if (!_db) return;
    const dbPath = getDbPath();
    try {
        // ★ 外部修改守卫 (2026-09-08 升级): 磁盘签名变化 → 逐 key LWW 合并 (updated_at 新者胜 + 并集写入)
        //   跨实例零丢 key；自己的写入永不因外部变更被放弃 (旧「行数更多则整库采纳」语义已废)
        if (_lastDiskMtime > 0 && fs.existsSync(dbPath) && _diskChanged(dbPath)) {
            _mergeDiskIntoMemory(dbPath);
        }
        // ★ 写前保留上一完好版 (.prev) — 任何损坏可回退 (2026-08-06 F26)
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, dbPath + '.prev');
        }
        const data = _db.export();
        const tmp = dbPath + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(data));
        fs.renameSync(tmp, dbPath);   // ★ 原子替换（铁律 8.2）— ENOSPC/断电不再截断主库
        _markDiskSynced(dbPath);   // 落盘即记签名 → 自己的 watcher 回声天然跳过
    } catch (e: any) {
        // 磁盘满/占用 → 保留内存态，不破坏磁盘文件
        console.warn('[roam] db save failed:', e.message);
        try { if (fs.existsSync(dbPath + '.tmp')) fs.unlinkSync(dbPath + '.tmp'); } catch { /* ignore */ }
    }
}

function _reloadIfChanged(): boolean {
    const dbPath = getDbPath();
    if (!_db || !fs.existsSync(dbPath)) return false;
    if (!_diskChanged(dbPath)) return false;   // 签名未变 (含自己刚落盘的回声) → 零动作
    try {
        const buf = fs.readFileSync(dbPath);
        _db.close();
        _db = new _SQL.Database(buf);
        _db.run('PRAGMA journal_mode=DELETE');
        _markDiskSynced(dbPath);
        return true;
    } catch (e: any) {
        console.warn('[roam] reload failed, restoring:', e.message);
        if (_db) { try { _db.close(); } catch { /* ignore */ } }
        // ★ 损坏恢复链 (2026-08-06 F26 补漏): 主文件 → .prev → 重建，绝不直接空库
        _db = _loadOrRecreate(dbPath, 'roam_state');
        _db.run('PRAGMA journal_mode=DELETE');
        _lastDiskMtime = 0; _lastDiskSize = 0; // 强制下次 _saveDb 重新评估外部修改
        return true;
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

// ── 跨实例秒级同步 (2026-09-08 定案) ──
// 监听 %LOCALAPPDATA%/qqqide 目录 roam.sq3 的原子替换 (tmp+rename → 目录 rename 事件) →
//   reload (整库采纳, 写方都是 LWW 并集 → 采纳恒为超集零丢失) → diff 逐 key 广播现有频道
//   'qqqide:roam:changed' {key,value} → shell-rpc → iframe _onRoamChanged (内存态+重渲染, 零改动)
// 数据正确性零依赖 watcher (get/set 前 _reloadIfChanged + LWW 已保证收敛) — watcher 只负责
//   把别的实例的写入即时推给本实例 UI；自写回声由 _diskChanged 签名判定天然跳过。
// 与 squads watcher 同目录并存 = 本仓库既定模式 (每实例一 watcher)。
const DB_WATCH_DEBOUNCE_MS = 200;
let _dbWatcher: fs.FSWatcher | null = null;
let _dbWatchTimer: NodeJS.Timeout | null = null;
let _dbWatchRetryTimer: NodeJS.Timeout | null = null;
let _dbWatchBackoffMs = 1000;

function _snapshotRows(): Record<string, { raw: string; ts: number }> | null {
    if (!_db) return null;
    const out: Record<string, { raw: string; ts: number }> = {};
    try {
        const stmt = _db.prepare('SELECT key, value, updated_at FROM roam_state');
        while (stmt.step()) {
            const r = stmt.getAsObject();
            out[String(r.key)] = { raw: String(r.value), ts: Number(r.updated_at) };
        }
        stmt.free();
    } catch { return null; }
    return out;
}

function _broadcastKey(key: string, value: any): void {
    BrowserWindow.getAllWindows().forEach(win => {
        if (win.isDestroyed()) return;
        try { win.webContents.send('qqqide:roam:changed', { key, value }); } catch { /* ignore */ }
    });
}

function _onExternalDbChange(): void {
    if (!_db) return;
    const before = _snapshotRows();
    if (!_reloadIfChanged()) return;          // 自写回声 / 无变化 → 零动作
    const after = _snapshotRows();
    if (!before || !after) return;
    const changed: string[] = [];
    for (const k of Object.keys(after)) {
        const b = before[k];
        if (!b || b.raw !== after[k].raw || b.ts !== after[k].ts) changed.push(k);
    }
    for (const k of Object.keys(before)) { if (!after[k]) changed.push(k); }  // 重建删行（罕见）→ iframe 忽略 null
    if (!changed.length) return;
    for (const k of changed) {
        const row = after[k];
        let value: any = null;
        if (row) { try { value = JSON.parse(row.raw); } catch { value = row.raw; } }
        _broadcastKey(k, value);
    }
}

function _disposeDbWatcher(): void {
    if (_dbWatchTimer) { clearTimeout(_dbWatchTimer); _dbWatchTimer = null; }
    if (_dbWatcher) { try { _dbWatcher.close(); } catch { /* ignore */ } _dbWatcher = null; }
}

function _scheduleDbWatcherRetry(): void {
    if (_dbWatchRetryTimer) return;
    _dbWatchRetryTimer = setTimeout(() => {
        _dbWatchRetryTimer = null;
        _ensureDbWatcher();
    }, _dbWatchBackoffMs);
    _dbWatchBackoffMs = Math.min(_dbWatchBackoffMs * 2, 30000);   // 指数退避 1s → 30s cap
}

function _ensureDbWatcher(): void {
    if (_dbWatcher || !_db) return;
    const dir = path.dirname(getDbPath());
    if (!fs.existsSync(dir)) return;
    try {
        _dbWatcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
            const fn = filename ? (Buffer.isBuffer(filename) ? filename.toString() : String(filename)) : '';
            if (fn && fn !== 'roam.sq3') return;   // .tmp/其他文件噪音忽略；null=无法区分 → 交给签名判定
            if (_dbWatchTimer) clearTimeout(_dbWatchTimer);
            _dbWatchTimer = setTimeout(() => {
                _dbWatchTimer = null;
                _onExternalDbChange();
            }, DB_WATCH_DEBOUNCE_MS);
        });
        _dbWatcher.on('error', () => { _disposeDbWatcher(); _scheduleDbWatcherRetry(); });
        _dbWatchBackoffMs = 1000;   // 建好即复位退避
    } catch {
        _dbWatcher = null;
        _scheduleDbWatcherRetry();
    }
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
