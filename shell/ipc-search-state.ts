// ============================================================================
// ipc-search-state.ts — goods search 搜索记忆 OS 级持久化 (sql.js → search.sq3)
//
// 语义 (2026-08-09 F6 定案):
//   搜索记忆 = 5 个编辑框历史（srch.h0 搜索词 / h1 替换文本 / h2 范围路径 / h3 仅限 / h4 排除）
//   用户技能偏好（跨项目通用）→ OS 级单一真理源 %LOCALAPPDATA%/qqqide/search.sq3
//   （F3 铁律: key 为路径/用户偏好 → OS 级；D 方案包级 = 不同启动包记忆分叉，否）
//
// 并发 (2026-08-08 ws-state 同款, 防大脑分裂):
//   单进程内 JS 单写入者；跨进程（dev+绿色包+多窗口同时运行）写前逐 key LWW 合并
//   （updated_at 新者胜 + 并集写入）→ 任何写者零丢对方 key，多窗口写大脑不分裂
//   替代旧"行数多则全采纳"整库覆盖（行数相等时丢对方 key）
//
// 防线: 三级恢复链 主文件 → .prev → 重建（铁律 8.2 goods 库同款）+ tmp+rename 原子替换
// 跨窗口同步: set 后 broadcast 'qqqide:search-state:changed' → 所有 BrowserWindow → iframe 刷新
// 迁移: 由 goods/search/search-ui.html 逐 key 幂等执行（only.sq3 → search.sq3, 迁后删旧 key）
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ipcMain, BrowserWindow } from 'electron';

const initSqlJs = require('sql.js');

// ── DB 路径 (OS 级唯一: %LOCALAPPDATA%/qqqide/search.sq3, 与 ai.sq3/roam.sq3/ws.sq3 同目录) ──
function getDbPath(): string {
    const localAppData = path.join(os.homedir(), 'AppData', 'Local');
    const dir = path.join(localAppData, 'qqqide');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'search.sq3');
}

// ── 懒初始化 ──
let _SQL: any = null;
let _db: any = null;
let _initPromise: Promise<void> | null = null;
let _lastDiskMtime = 0;

// ★ 损坏自愈: 三级恢复链 主文件 → .prev → 重建，绝不带着损坏库继续跑
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
    const prev = tryLoad(dbPath + '.prev');
    if (prev) {
        console.warn('[search-state] db corrupt, restoring from .prev');
        return prev;
    }
    console.warn('[search-state] db corrupt, recreating');
    return new _SQL.Database(null);
}

async function _ensureDb(): Promise<void> {
    if (_db) return;
    if (_initPromise) { await _initPromise; return; }
    _initPromise = (async () => {
        _SQL = await initSqlJs();
        const dbPath = getDbPath();
        _db = _loadOrRecreate(dbPath, 'search_state');
        _db.run('PRAGMA journal_mode=DELETE');
        _db.run(`CREATE TABLE IF NOT EXISTS search_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0
        )`);
        _saveDb();
        _lastDiskMtime = fs.statSync(dbPath).mtimeMs;
    })();
    await _initPromise;
}

// ★ 逐 key LWW 合并（跨进程并发安全，2026-08-08 ws-state 同款）:
//   磁盘上 updated_at 更新或内存缺失的 key 采纳（并集写入）→ 多窗口/多绿色包零丢 key
function _mergeDiskIntoMemory(dbPath: string): void {
    if (!fs.existsSync(dbPath)) return;
    let diskDb: any = null;
    try {
        diskDb = new _SQL.Database(fs.readFileSync(dbPath));
        const r = diskDb.exec('SELECT key, value, updated_at FROM search_state');
        if (!r.length || !r[0].values.length) return;
        const mem = new Map<string, [string, number]>();
        const mr = _db.exec('SELECT key, value, updated_at FROM search_state');
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
            _db.run('DELETE FROM search_state');
            const stmt = _db.prepare('INSERT INTO search_state (key, value, updated_at) VALUES (?,?,?)');
            for (const [k, v] of mem) stmt.run([k, v[0], v[1]]);
            stmt.free();
            console.warn('[search-state] external db change detected, merged ' + mem.size + ' key(s) (LWW)');
        }
    } catch { /* 磁盘损坏/占用 → 跳过合并直接写盘（.prev 已兜底上一完好版） */ }
    finally { if (diskDb) { try { diskDb.close(); } catch { /* ignore */ } } }
}

function _saveDb(): void {
    if (!_db) return;
    const dbPath = getDbPath();
    try {
        // ★ 外部修改守卫（2026-08-08 升级）: 磁盘被其他进程改过 → 逐 key LWW 合并（updated_at 新者胜）
        //   并集写入，跨进程（dev+绿色包同时运行）零丢更新
        if (_lastDiskMtime > 0 && fs.existsSync(dbPath)) {
            const mtime = fs.statSync(dbPath).mtimeMs;
            if (mtime > _lastDiskMtime) {
                _mergeDiskIntoMemory(dbPath);
            }
        }
        // ★ 写前保留上一完好版 (.prev)
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, dbPath + '.prev');
        }
        const data = _db.export();
        const tmp = dbPath + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(data));
        fs.renameSync(tmp, dbPath);   // ★ 原子替换（铁律 8.2）
        _lastDiskMtime = fs.statSync(dbPath).mtimeMs;
    } catch (e: any) {
        console.warn('[search-state] db save failed:', e.message);
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
        _db.run('PRAGMA journal_mode=DELETE');
        _lastDiskMtime = mtime;
    } catch (e: any) {
        console.warn('[search-state] reload failed, restoring:', e.message);
        if (_db) { try { _db.close(); } catch { /* ignore */ } }
        _db = _loadOrRecreate(dbPath, 'search_state');
        _db.run('PRAGMA journal_mode=DELETE');
        _lastDiskMtime = 0; // 强制下次 _saveDb 重新评估外部修改
    }
}

// ── KV 操作 ──
function _get(key: string): any {
    _reloadIfChanged();
    const stmt = _db.prepare('SELECT value FROM search_state WHERE key=?');
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
    _db.run('INSERT OR REPLACE INTO search_state (key, value, updated_at) VALUES (?,?,?)',
        [key, json, Date.now()]);
    _saveDb();
}

function _del(key: string): void {
    _reloadIfChanged();
    _db.run('DELETE FROM search_state WHERE key=?', [key]);
    _saveDb();
}

function _getAll(): Record<string, any> {
    _reloadIfChanged();
    const result: Record<string, any> = {};
    const stmt = _db.prepare('SELECT key, value FROM search_state');
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

// ── 广播（跨窗口秒级同步: iframe 经 parent.qqqideBridge.searchState.onChanged 订阅）──
function _broadcast(msg: { key: string; value: any; deleted?: boolean }): void {
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
            try { win.webContents.send('qqqide:search-state:changed', msg); } catch { /* ignore */ }
        }
    });
}

// ── IPC 注册 ──
export function registerSearchStateIpc(): void {
    ipcMain.handle('qqqide:search-state:get', async (_e, key: string) => {
        await _ensureDb();
        return _get(key);
    });

    ipcMain.handle('qqqide:search-state:set', async (_e, key: string, value: any) => {
        await _ensureDb();
        _set(key, value);
        _broadcast({ key, value });
        return true;
    });

    ipcMain.handle('qqqide:search-state:setNow', async (_e, key: string, value: any) => {
        await _ensureDb();
        _set(key, value);   // _set 已同步落盘（tmp+rename），setNow 语义一致
        _broadcast({ key, value });
        return true;
    });

    ipcMain.handle('qqqide:search-state:del', async (_e, key: string) => {
        await _ensureDb();
        _del(key);
        _broadcast({ key, value: null, deleted: true });
        return true;
    });

    ipcMain.handle('qqqide:search-state:getAll', async () => {
        await _ensureDb();
        return _getAll();
    });
}
