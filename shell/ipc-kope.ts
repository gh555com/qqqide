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

async function _ensureDb(): Promise<void> {
    if (_db) return;
    if (_initPromise) { await _initPromise; return; }
    _initPromise = (async () => {
        _SQL = await initSqlJs();
        const dbPath = getDbPath();
        const buf = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
        _db = new _SQL.Database(buf);
        _db.run('PRAGMA journal_mode=WAL');
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

function _saveDb(): void {
    if (!_db) return;
    const dbPath = getDbPath();
    const data = _db.export();
    const buf = Buffer.from(data);
    fs.writeFileSync(dbPath, buf);
    _lastDiskMtime = fs.statSync(dbPath).mtimeMs;
}

function _reloadIfChanged(): void {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return;
    const mtime = fs.statSync(dbPath).mtimeMs;
    if (mtime <= _lastDiskMtime) return;
    // Python 写了新数据 → 从磁盘重读
    const buf = fs.readFileSync(dbPath);
    if (_db) _db.close();
    _db = new _SQL.Database(buf);
    _db.run('PRAGMA journal_mode=WAL');
    _lastDiskMtime = mtime;
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
