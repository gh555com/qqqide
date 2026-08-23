// ============================================================================
// ipc-kope.ts — kope-a 数据桥 (sql.js → kope.sq3, 唯一读写者)
//
// 架构:
//   panel.html → bridge.kope.* → 此模块 (sql.js) → kope.sq3
//   q3.py → kope_store.py (sqlite3) → kope.sq3 (仅 INSERT 新剪贴板条目)
//
// 并发: Python 只 INSERT，此模块只 SELECT/UPDATE/DELETE。WAL 模式天然并发安全。
// 每次写前从磁盘重读，防覆盖 Python 刚写入的新条目。
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ipcMain } from 'electron';

const initSqlJs = require('sql.js');

// ── DB 路径 (与 Python kope_store._get_db_dir 保持一致) ──
function getDbPath(): string {
    const localAppData = path.join(os.homedir(), 'AppData', 'Local');
    const dir = path.join(localAppData, 'kope-a');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'kope.sq3');
}

// ── 懒初始化 ──
let _SQL: any = null;
let _db: any = null;
let _initPromise: Promise<void> | null = null;
let _lastDiskMtime = 0;

// ★ 损坏自愈 (2026-08-06 F20 事故: C盘 ENOSPC 截断 kope.sq3 → no such table 刷屏)
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
        console.warn('[kope] db corrupt, restoring from .prev');
        return prev;
    }
    console.warn('[kope] db corrupt, recreating');
    return new _SQL.Database(null);
}

async function _ensureDb(): Promise<void> {
    if (_db) return;
    if (_initPromise) { await _initPromise; return; }
    _initPromise = (async () => {
        _SQL = await initSqlJs();
        const dbPath = getDbPath();
        _db = _loadOrRecreate(dbPath, 'clipboard_history');
        _db.run('PRAGMA journal_mode=DELETE');
        _db.run(`CREATE TABLE IF NOT EXISTS clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL UNIQUE,
            preview TEXT,
            size_bytes INTEGER DEFAULT 0,
            content_type TEXT DEFAULT 'text',
            pinned INTEGER DEFAULT 0,
            pinned_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )`);
        _db.run('CREATE INDEX IF NOT EXISTS idx_clipboard_pinned ON clipboard_history(pinned DESC, pinned_at DESC)');
        _db.run('CREATE INDEX IF NOT EXISTS idx_clipboard_updated ON clipboard_history(updated_at DESC)');
        _saveDb();
        _lastDiskMtime = fs.statSync(dbPath).mtimeMs;
    })();
    await _initPromise;
}

function _memoryRows(): number {
    try {
        const r = _db.exec('SELECT COUNT(*) FROM clipboard_history');
        return r.length && r[0].values.length ? r[0].values[0][0] : 0;
    } catch { return 0; }
}

function _countRowsFromDisk(dbPath: string): number {
    try {
        const db = new _SQL.Database(fs.readFileSync(dbPath));
        const r = db.exec('SELECT COUNT(*) FROM clipboard_history');
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
                    console.warn('[kope] external db change detected, adopting disk (rows ' + diskRows + ')');
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
        console.warn('[kope] db save failed:', e.message);
        try { if (fs.existsSync(dbPath + '.tmp')) fs.unlinkSync(dbPath + '.tmp'); } catch { /* ignore */ }
    }
}

function _reloadIfChanged(): void {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return;
    const mtime = fs.statSync(dbPath).mtimeMs;
    if (mtime <= _lastDiskMtime) return;
    // Python 写了新数据 → 从磁盘重读
    try {
        const buf = fs.readFileSync(dbPath);
        if (_db) _db.close();
        _db = new _SQL.Database(buf);
        _db.run('PRAGMA journal_mode=DELETE');
        _lastDiskMtime = mtime;
    } catch (e: any) {
        console.warn('[kope] reload failed, restoring:', e.message);
        if (_db) { try { _db.close(); } catch { /* ignore */ } }
        // ★ 损坏恢复链 (2026-08-06 F26 补漏): 主文件 → .prev → 重建，绝不直接空库
        _db = _loadOrRecreate(dbPath, 'clipboard_history');
        _db.run('PRAGMA journal_mode=DELETE');
        _lastDiskMtime = 0; // 强制下次 _saveDb 重新评估外部修改
    }
}

// ── 查询 ──
function _getHistory(limit: number, offset: number, keyword?: string): any[] {
    _reloadIfChanged();
    let sql = `SELECT id, content, content_hash, preview, size_bytes, content_type,
                      pinned, pinned_at, created_at, updated_at
               FROM clipboard_history `;
    const params: any[] = [];
    if (keyword) {
        const k = '%' + keyword + '%';
        sql += `WHERE preview LIKE ? OR content LIKE ? `;
        params.push(k, k);
    }
    sql += `ORDER BY pinned DESC, pinned_at DESC, updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const rows = _db.exec(sql, params);
    if (!rows.length) return [];
    const cols = rows[0].columns;
    const vals = rows[0].values;
    return vals.map((row: any[]) => {
        const obj: any = {};
        cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
        return obj;
    });
}

function _getStats(): any {
    _reloadIfChanged();
    const r = _db.exec(`SELECT COUNT(*) as total, SUM(pinned) as pinned, MAX(updated_at) as max_updated_at FROM clipboard_history`);
    if (!r.length) return { total: 0, pinned: 0, max_updated_at: '' };
    const row = r[0].values[0];
    return { total: row[0], pinned: row[1] || 0, max_updated_at: row[2] || '' };
}

function _togglePin(id: number): boolean {
    _reloadIfChanged();
    const r = _db.exec('SELECT pinned, pinned_at FROM clipboard_history WHERE id=?', [id]);
    if (!r.length || !r[0].values.length) return false;
    const cur = r[0].values[0];
    const newPinned = cur[0] ? 0 : 1;
    const pinnedAt = newPinned ? new Date().toISOString().replace('T', ' ').substring(0, 19) : null;
    _db.run('UPDATE clipboard_history SET pinned=?, pinned_at=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
        [newPinned, pinnedAt, id]);
    _saveDb();
    return true;
}

function _deleteItem(id: number): boolean {
    _reloadIfChanged();
    _db.run('DELETE FROM clipboard_history WHERE id=?', [id]);
    _saveDb();
    return true;
}

// ── IPC 注册 ──
export function registerKopeIpc(): void {
    ipcMain.handle('qqqide:kope:getHistory', async (_e, limit: number, offset: number, keyword?: string) => {
        await _ensureDb();
        return _getHistory(limit || 50, offset || 0, keyword || '');
    });

    ipcMain.handle('qqqide:kope:getStats', async () => {
        await _ensureDb();
        return _getStats();
    });

    ipcMain.handle('qqqide:kope:togglePin', async (_e, id: number) => {
        await _ensureDb();
        return _togglePin(id);
    });

    ipcMain.handle('qqqide:kope:deleteItem', async (_e, id: number) => {
        await _ensureDb();
        return _deleteItem(id);
    });
}
