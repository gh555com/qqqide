// ============================================================================
// ipc-kope.ts — kope-a 剪切板历史 IPC 桥
// 主进程直接读写 kope.sq3 (sql.js)，渲染进程通过 bridge.kope.* 调用。
// 替代 HTTP API + 端口扫描 + SSE 重连，零网络栈，零连接管理。
//
// ★ 2026-07-25 修复: Python sqlite3 与本桥各自独立连接同一文件。
//   本桥每次查询前检查磁盘 mtime，有变更→重读，保证数据新鲜度。
//   写操作前也重读→合并→写回，防止覆盖 Python 侧的新增数据。
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ipcMain } from 'electron';

const initSqlJs = require('sql.js');

let _SQL: any = null;
let _db: any = null;
let _dbPath: string = '';
let _lastDiskMtime: number = 0;
let _readyPromise: Promise<void> | null = null;

// ═══════════════════════════════════════════════════════════════
// DB 路径 — 与 kope_store.py 保持一致
// ═══════════════════════════════════════════════════════════════

function getKopeDbPath(): string {
    const localappdata = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
    const dir = path.join(localappdata, 'kope-a');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'kope.sq3');
}

// ═══════════════════════════════════════════════════════════════
// 磁盘变更检测 — Python sqlite3 与本桥各开连接，必须检测磁盘变更
// ═══════════════════════════════════════════════════════════════

function _reloadIfChanged(): boolean {
    if (!_dbPath || !fs.existsSync(_dbPath)) return false;
    try {
        const stat = fs.statSync(_dbPath);
        if (stat.mtimeMs === _lastDiskMtime) return false;

        const buf = fs.readFileSync(_dbPath);
        const newDb = new _SQL.Database(buf);
        newDb.run('PRAGMA journal_mode=WAL');
        newDb.run('PRAGMA busy_timeout=3000');

        if (_db) _db.close();
        _db = newDb;
        _lastDiskMtime = stat.mtimeMs;
        return true;
    } catch (e) {
        return false;
    }
}

function _markSynced() {
    try {
        if (_dbPath && fs.existsSync(_dbPath)) {
            _lastDiskMtime = fs.statSync(_dbPath).mtimeMs;
        }
    } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

async function _ensureDb(): Promise<void> {
    if (_db) return;
    if (_readyPromise) return _readyPromise;

    _readyPromise = (async () => {
        _SQL = await initSqlJs();
        _dbPath = getKopeDbPath();

        if (fs.existsSync(_dbPath)) {
            try {
                const buf = fs.readFileSync(_dbPath);
                _db = new _SQL.Database(buf);
                _lastDiskMtime = fs.statSync(_dbPath).mtimeMs;
            } catch (e) {
                console.warn('[ipc-kope] failed to open db, starting fresh:', e);
                _db = new _SQL.Database();
            }
        } else {
            _db = new _SQL.Database();
        }

        _db.run('PRAGMA journal_mode=WAL');
        _db.run('PRAGMA busy_timeout=3000');

        _db.run(`CREATE TABLE IF NOT EXISTS clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL UNIQUE,
            preview TEXT NOT NULL DEFAULT '',
            size_bytes INTEGER DEFAULT 0,
            content_type TEXT DEFAULT 'text',
            pinned INTEGER DEFAULT 0,
            pinned_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )`);

        try { _db.run('CREATE INDEX IF NOT EXISTS idx_history_sort ON clipboard_history(pinned DESC, pinned_at DESC, updated_at DESC)'); } catch {}
        try { _db.run('CREATE INDEX IF NOT EXISTS idx_history_hash ON clipboard_history(content_hash)'); } catch {}

        console.log('[ipc-kope] ready, db=' + _dbPath);
    })();

    return _readyPromise;
}

function _flushDb() {
    if (!_db) return;
    try {
        const data = _db.export();
        const tmp = _dbPath + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(data));
        fs.renameSync(tmp, _dbPath);
        _markSynced();
    } catch (e) {
        console.error('[ipc-kope] flush failed:', e);
    }
}

// ═══════════════════════════════════════════════════════════════
// CRUD helpers
// ═══════════════════════════════════════════════════════════════

function _hashContent(content: string): string {
    return crypto.createHash('md5').update(content, 'utf8').digest('hex');
}

function _makePreview(content: string, maxLen: number = 200): string {
    let s = content.replace(/\n/g, ' ').replace(/\r/g, ' ').trim();
    if (s.length > maxLen) s = s.substring(0, maxLen) + '...';
    return s;
}

function _rowToItem(row: any): any {
    return {
        id: row.id,
        content: row.content,
        content_hash: row.content_hash,
        preview: row.preview,
        size_bytes: row.size_bytes,
        content_type: row.content_type,
        pinned: !!row.pinned,
        pinned_at: row.pinned_at || '',
        created_at: row.created_at || '',
        updated_at: row.updated_at || ''
    };
}

// ═══════════════════════════════════════════════════════════════
// IPC 注册
// ═══════════════════════════════════════════════════════════════

export function registerKopeIpc(): void {

    // ── getHistory ──
    ipcMain.handle('qqqide:kope:getHistory', async (_e, search: string, limit: number, offset: number) => {
        await _ensureDb();
        _reloadIfChanged();
        try {
            let sql: string;
            let params: any[];
            if (search) {
                sql = `SELECT * FROM clipboard_history WHERE preview LIKE ? OR content LIKE ?
                       ORDER BY pinned DESC, pinned_at DESC, updated_at DESC
                       LIMIT ? OFFSET ?`;
                const like = '%' + search + '%';
                params = [like, like, limit, offset];
            } else {
                sql = `SELECT * FROM clipboard_history
                       ORDER BY pinned DESC, pinned_at DESC, updated_at DESC
                       LIMIT ? OFFSET ?`;
                params = [limit, offset];
            }
            const rows = _db.exec(sql, params);
            const items: any[] = [];
            if (rows.length > 0 && rows[0].values) {
                const cols = rows[0].columns;
                for (const vals of rows[0].values) {
                    const obj: any = {};
                    for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i];
                    items.push(_rowToItem(obj));
                }
            }
            const countRow = _db.exec('SELECT COUNT(*) as total FROM clipboard_history');
            const total = countRow.length > 0 && countRow[0].values ? countRow[0].values[0][0] : 0;
            return { items, total, limit, offset };
        } catch (e: any) {
            console.error('[ipc-kope] getHistory error:', e);
            return { items: [], total: 0, limit, offset, error: e.message };
        }
    });

    // ── addOrUpdate — q3.py 调用的写入路径（JS 侧也保留供 panel 用）──
    ipcMain.handle('qqqide:kope:addOrUpdate', async (_e, content: string) => {
        await _ensureDb();
        _reloadIfChanged(); // ★ 先合并 Python 新增数据，再写
        try {
            const hash = _hashContent(content);
            const preview = _makePreview(content);
            const size = Buffer.byteLength(content, 'utf8');

            // 检查去重
            const existing = _db.exec('SELECT id FROM clipboard_history WHERE content_hash = ?', [hash]);
            if (existing.length > 0 && existing[0].values && existing[0].values.length > 0) {
                _db.run('UPDATE clipboard_history SET updated_at = datetime(\'now\',\'localtime\'), size_bytes = ? WHERE content_hash = ?',
                    [size, hash]);
            } else {
                _db.run('INSERT INTO clipboard_history (content, content_hash, preview, size_bytes) VALUES (?,?,?,?)',
                    [content, hash, preview, size]);
            }

            // 清理超量
            const countRow = _db.exec('SELECT COUNT(*) as c FROM clipboard_history');
            const count = countRow[0].values[0][0];
            if (count > 2000) {
                _db.run('DELETE FROM clipboard_history WHERE id IN (SELECT id FROM clipboard_history WHERE pinned=0 ORDER BY updated_at ASC LIMIT ?)',
                    [count - 2000]);
            }

            _flushDb();
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    });

    // ── togglePin ──
    ipcMain.handle('qqqide:kope:togglePin', async (_e, id: number) => {
        await _ensureDb();
        _reloadIfChanged(); // ★ 先合并 Python 新增数据
        try {
            const rows = _db.exec('SELECT pinned FROM clipboard_history WHERE id = ?', [id]);
            if (rows.length === 0 || !rows[0].values || rows[0].values.length === 0) {
                return { ok: false, error: 'not found' };
            }
            const pinned = rows[0].values[0][0];
            if (pinned) {
                _db.run('UPDATE clipboard_history SET pinned=0, pinned_at=NULL, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [id]);
            } else {
                _db.run('UPDATE clipboard_history SET pinned=1, pinned_at=datetime(\'now\',\'localtime\'), updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [id]);
            }
            _flushDb();
            return { ok: true, pinned: !pinned };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    });

    // ── deleteItem ──
    ipcMain.handle('qqqide:kope:deleteItem', async (_e, id: number) => {
        await _ensureDb();
        _reloadIfChanged(); // ★ 先合并 Python 新增数据
        try {
            _db.run('DELETE FROM clipboard_history WHERE id = ?', [id]);
            _flushDb();
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    });

    // ── getStats ──
    ipcMain.handle('qqqide:kope:getStats', async () => {
        await _ensureDb();
        _reloadIfChanged();
        try {
            const totalRow = _db.exec('SELECT COUNT(*) as c FROM clipboard_history');
            const total = totalRow[0].values[0][0];
            const pinnedRow = _db.exec('SELECT COUNT(*) as c FROM clipboard_history WHERE pinned=1');
            const pinned = pinnedRow[0].values[0][0];
            const maxRow = _db.exec('SELECT MAX(updated_at) as m FROM clipboard_history');
            const maxUpdated = maxRow[0].values[0][0] || '';
            return { total, pinned, max_updated_at: maxUpdated };
        } catch {
            return { total: 0, pinned: 0, max_updated_at: '' };
        }
    });

    console.log('[ipc-kope] registered 5 handlers (with disk-change detection)');
}
