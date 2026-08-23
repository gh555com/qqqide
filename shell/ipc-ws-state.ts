// ============================================================================
// ipc-ws-state.ts — 工作空间记忆 OS 级持久化 (sql.js → %LOCALAPPDATA%/qqqide/ws.sq3)
//
// 语义 (2026-08-08 定案):
//   工作空间记忆 = 上次主文件夹 + 每主文件夹的出战阵营（辅文件夹列表）
//   独立 ws.sq3 库（kope/roam/ai 同款三级防线），与 ai.sq3 物理隔离：
//   → 彻底删除工作空间记忆只需删 ws.sq3，不污染 sortPrefs/scrollPositions/recent 等记忆块
//
// key 设计 (库内直根，无命名空间前缀):
//   lastMainFolder          — 上次主文件夹（字符串）
//   formation.{mainPath}    — 该主文件夹的阵营（辅路径数组）
//
// 恢复优先级（渲染层 ai-viewport.js 实现）:
//   启动目录 global.sq3 有记忆 → 本地优先；无记忆 → 本库兜底 + 回写 global.sq3
//
// 一次性迁移: ai.sq3 中 ai.workspace.* key → ws.sq3（迁移后从 ai.sq3 删除）
// 并发: 单进程内 JS 单写入者；跨进程（dev+绿色包同时运行）写前逐 key LWW 合并（updated_at 新者胜，
//   _saveDb → _mergeDiskIntoMemory）→ 并集写入，整库覆盖会丢对方 key（2026-08-08 升级）
// 跨窗口同步: set 后 broadcast 'qqqide:ws-state:changed' → 所有 BrowserWindow
// 恢复链: 主文件 → .prev → 重建 (铁律 8.2 goods 库三级防线同款)
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ipcMain, BrowserWindow } from 'electron';

const initSqlJs = require('sql.js');

// ── DB 路径 (OS 级唯一: %LOCALAPPDATA%/qqqide/ws.sq3, 与 ai.sq3/roam.sq3 同目录) ──
function getDbPath(): string {
    const localAppData = path.join(os.homedir(), 'AppData', 'Local');
    const dir = path.join(localAppData, 'qqqide');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'ws.sq3');
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
        console.warn('[ws-state] db corrupt, restoring from .prev');
        return prev;
    }
    console.warn('[ws-state] db corrupt, recreating');
    return new _SQL.Database(null);
}

// ★ 一次性迁移 (2026-08-08): ai.sq3 的 ai.workspace.* → ws.sq3（key 改名去前缀）
//   仅 ws.sq3 尚无数据时执行（幂等）；迁移后删除 ai.sq3 旧 key，保持 ai.sq3 纯净
function _migrateFromAiState(): void {
    try {
        const wsPath = getDbPath();
        // 逐 key 条件迁移（幂等，每次启动执行）: ws.sq3 已存在的 key 不覆盖（新数据优先），
        //   缺失的才迁入 → 旧壳层再次写入 ai.sq3 的旧 key 也会被持续收敛（2026-08-08）
        const aiPath = path.join(path.dirname(wsPath), 'ai.sq3');
        if (!fs.existsSync(aiPath)) return;
        let aiData: Buffer | null = null;
        let moved = 0;
        let cleanedOnly = 0;  // ws 已有该 key、仅删 ai.sq3 旧 key 的条数
        try {
            const aiDb = new _SQL.Database(fs.readFileSync(aiPath));
            try {
                const r = aiDb.exec("SELECT key, value FROM ai_state WHERE key LIKE 'ai.workspace.%'");
                if (r.length && r[0].values.length) {
                    for (const row of r[0].values) {
                        const oldKey = String(row[0]);
                        const val = row[1];
                        let newKey = '';
                        if (oldKey === 'ai.workspace.lastMainFolder') newKey = 'lastMainFolder';
                        else if (oldKey.indexOf('ai.workspace.formation.') === 0) newKey = oldKey.slice('ai.workspace.formation.'.length);
                        else continue;  // 非工作空间 key 不动
                        if (!newKey) continue;
                        const existsR = _db.exec('SELECT 1 FROM ws_state WHERE key=?', [newKey]);
                        if (existsR.length && existsR[0].values.length) {
                            // ws.sq3 已有该 key（新数据优先）→ 不覆盖；ai.sq3 旧 key 仍删（纯净收敛）
                            aiDb.run('DELETE FROM ai_state WHERE key=?', [oldKey]);
                            cleanedOnly++;
                            continue;
                        }
                        _db.run('INSERT OR REPLACE INTO ws_state (key, value, updated_at) VALUES (?,?,?)',
                            [newKey, val, Date.now()]);
                        aiDb.run('DELETE FROM ai_state WHERE key=?', [oldKey]);
                        moved++;
                    }
                }
                if (moved + cleanedOnly > 0) aiData = aiDb.export();  // 必须在 close 前导出
            } finally {
                aiDb.close();
            }
        } catch { /* ai.sq3 损坏/不可读 → 跳过迁移 */ }
        if (moved > 0 && aiData) {
            // 写回 ai.sq3（已迁移 key 删除，tmp+rename 原子，保持 ai.sq3 纯净）
            const aiTmp = aiPath + '.tmp';
            fs.writeFileSync(aiTmp, Buffer.from(aiData));
            fs.renameSync(aiTmp, aiPath);
            console.log('[ws-state] migrated ' + moved + ' key(s), cleaned ' + cleanedOnly + ' stale key(s) from ai.sq3 → ws.sq3');
        }
    } catch (e: any) {
        console.warn('[ws-state] ai.sq3 migration skipped:', e && e.message);
    }
}

async function _ensureDb(): Promise<void> {
    if (_db) return;
    if (_initPromise) { await _initPromise; return; }
    _initPromise = (async () => {
        _SQL = await initSqlJs();
        const dbPath = getDbPath();
        _db = _loadOrRecreate(dbPath, 'ws_state');
        _db.run('PRAGMA journal_mode=DELETE');
        _db.run(`CREATE TABLE IF NOT EXISTS ws_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0
        )`);
        _migrateFromAiState();
        _saveDb();
        _lastDiskMtime = fs.statSync(dbPath).mtimeMs;
    })();
    await _initPromise;
}

// ★ 逐 key LWW 合并（跨进程并发安全，2026-08-08）: 磁盘上 updated_at 更新或内存缺失的 key 采纳（并集写入）
//   替代旧"行数多则全采纳"——行数相等时整库覆盖会丢另一进程的 key
function _mergeDiskIntoMemory(dbPath: string): void {
    if (!fs.existsSync(dbPath)) return;
    let diskDb: any = null;
    try {
        diskDb = new _SQL.Database(fs.readFileSync(dbPath));
        const r = diskDb.exec('SELECT key, value, updated_at FROM ws_state');
        if (!r.length || !r[0].values.length) return;
        const mem = new Map<string, [string, number]>();
        const mr = _db.exec('SELECT key, value, updated_at FROM ws_state');
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
            _db.run('DELETE FROM ws_state');
            const stmt = _db.prepare('INSERT INTO ws_state (key, value, updated_at) VALUES (?,?,?)');
            for (const [k, v] of mem) stmt.run([k, v[0], v[1]]);
            stmt.free();
            console.warn('[ws-state] external db change detected, merged ' + mem.size + ' key(s) (LWW)');
        }
    } catch { /* 磁盘损坏/占用 → 跳过合并直接写盘（.prev 已兜底上一完好版） */ }
    finally { if (diskDb) { try { diskDb.close(); } catch { /* ignore */ } } }
}

function _saveDb(): void {
    if (!_db) return;
    const dbPath = getDbPath();
    try {
        // ★ 外部修改守卫（2026-08-08 升级）: 磁盘被其他进程改过 → 逐 key LWW 合并（updated_at 新者胜）
        //   并集写入，跨进程（dev+绿色包同时运行）零丢更新；旧"行数多则全采纳"在行数相等时丢对方 key
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
        console.warn('[ws-state] db save failed:', e.message);
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
        console.warn('[ws-state] reload failed, restoring:', e.message);
        if (_db) { try { _db.close(); } catch { /* ignore */ } }
        _db = _loadOrRecreate(dbPath, 'ws_state');
        _db.run('PRAGMA journal_mode=DELETE');
        _lastDiskMtime = 0; // 强制下次 _saveDb 重新评估外部修改
    }
}

// ── KV 操作 ──
function _get(key: string): any {
    _reloadIfChanged();
    const stmt = _db.prepare('SELECT value FROM ws_state WHERE key=?');
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
    _db.run('INSERT OR REPLACE INTO ws_state (key, value, updated_at) VALUES (?,?,?)',
        [key, json, Date.now()]);
    _saveDb();
}

function _del(key: string): void {
    _reloadIfChanged();
    _db.run('DELETE FROM ws_state WHERE key=?', [key]);
    _saveDb();
}

function _getAll(): Record<string, any> {
    _reloadIfChanged();
    const result: Record<string, any> = {};
    const stmt = _db.prepare('SELECT key, value FROM ws_state');
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

// ── 主进程直连访问器（window-manager/shutdown 用, 不走 IPC）──
export async function wsStateGetKey(key: string): Promise<any> {
    await _ensureDb();
    return _get(key);
}

export async function wsStateSetKey(key: string, value: any): Promise<void> {
    await _ensureDb();
    _set(key, value);
}

export async function wsStateDelKey(key: string): Promise<void> {
    await _ensureDb();
    _del(key);
}

// ── IPC 注册 ──
export function registerWsStateIpc(): void {
    ipcMain.handle('qqqide:ws-state:get', async (_e, key: string) => {
        await _ensureDb();
        return _get(key);
    });

    ipcMain.handle('qqqide:ws-state:set', async (_e, key: string, value: any) => {
        await _ensureDb();
        _set(key, value);
        // ★ 广播到所有窗口 → 跨窗口秒级同步
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                try { win.webContents.send('qqqide:ws-state:changed', { key, value }); } catch { /* ignore */ }
            }
        });
        return true;
    });

    ipcMain.handle('qqqide:ws-state:del', async (_e, key: string) => {
        await _ensureDb();
        _del(key);
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                try { win.webContents.send('qqqide:ws-state:changed', { key, value: null, deleted: true }); } catch { /* ignore */ }
            }
        });
        return true;
    });

    ipcMain.handle('qqqide:ws-state:getAll', async () => {
        await _ensureDb();
        return _getAll();
    });
}
