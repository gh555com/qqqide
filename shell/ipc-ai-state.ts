// ============================================================================
// ipc-ai-state.ts — AI 视口 OS 级持久化 (sql.js → %LOCALAPPDATA%/qqqide/ai.sq3)
//
// 架构:
//   ai-viewport.js / navigator.js → bridge.aiState.* → 此模块 (sql.js) → ai.sq3
//
// 语义 (2026-08-07 F3 定案): key = 任意目录/文件绝对路径 → 偏好属于目录本身
//   → 必须 OS 级，跨主文件夹/跨绿色包/跨窗口一致。分层与 roam.fineScm 对齐。
//
// 迁入的 key (原错层在 only.sq3 项目级, 随主文件夹走 → 丢失):
//   ai.viewport.sortPrefs      — 每目录 N/M 排序
//   ai.viewport.scrollPositions — 每目录滚动位置
//   navigator.recent           — Ctrl+P 最近文件
//
// 并发: 仅 JS 单写入者。WAL 模式天然并发安全。
// 跨窗口同步: set 后 broadcast 'qqqide:ai-state:changed' → 所有 BrowserWindow
// 恢复链: 主文件 → .prev → 重建 (铁律 8.2 goods 库三级防线同款)
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ipcMain, BrowserWindow } from 'electron';

const initSqlJs = require('sql.js');

// ── DB 路径 (OS 级唯一: %LOCALAPPDATA%/qqqide/ai.sq3, 与 roam.sq3 同目录) ──
function getDbPath(): string {
    const localAppData = path.join(os.homedir(), 'AppData', 'Local');
    const dir = path.join(localAppData, 'qqqide');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'ai.sq3');
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
        console.warn('[ai-state] db corrupt, restoring from .prev');
        return prev;
    }
    console.warn('[ai-state] db corrupt, recreating');
    return new _SQL.Database(null);
}

async function _ensureDb(): Promise<void> {
    if (_db) return;
    if (_initPromise) { await _initPromise; return; }
    _initPromise = (async () => {
        _SQL = await initSqlJs();
        const dbPath = getDbPath();
        _db = _loadOrRecreate(dbPath, 'ai_state');
        _db.run('PRAGMA journal_mode=DELETE');
        _db.run(`CREATE TABLE IF NOT EXISTS ai_state (
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
        const r = _db.exec('SELECT COUNT(*) FROM ai_state');
        return r.length && r[0].values.length ? r[0].values[0][0] : 0;
    } catch { return 0; }
}

function _countRowsFromDisk(dbPath: string): number {
    try {
        const db = new _SQL.Database(fs.readFileSync(dbPath));
        const r = db.exec('SELECT COUNT(*) FROM ai_state');
        db.close();
        return r.length && r[0].values.length ? r[0].values[0][0] : 0;
    } catch { return -1; }
}

function _saveDb(): void {
    if (!_db) return;
    const dbPath = getDbPath();
    try {
        // ★ 外部修改守卫: 迁移/其他实例改过磁盘且行数更多 → 以磁盘为准，不覆盖
        if (_lastDiskMtime > 0 && fs.existsSync(dbPath)) {
            const mtime = fs.statSync(dbPath).mtimeMs;
            if (mtime > _lastDiskMtime) {
                const diskRows = _countRowsFromDisk(dbPath);
                if (diskRows > _memoryRows()) {
                    console.warn('[ai-state] external db change detected, adopting disk (rows ' + diskRows + ')');
                    _reloadIfChanged();
                    return;
                }
            }
        }
        // ★ 写前保留上一完好版 (.prev)
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, dbPath + '.prev');
        }
        const data = _db.export();
        const tmp = dbPath + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(data));
        fs.renameSync(tmp, dbPath);   // ★ 原子替换（铁律 8.2）— ENOSPC/断电不再截断主库
        _lastDiskMtime = fs.statSync(dbPath).mtimeMs;
    } catch (e: any) {
        console.warn('[ai-state] db save failed:', e.message);
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
        console.warn('[ai-state] reload failed, restoring:', e.message);
        if (_db) { try { _db.close(); } catch { /* ignore */ } }
        _db = _loadOrRecreate(dbPath, 'ai_state');
        _db.run('PRAGMA journal_mode=DELETE');
        _lastDiskMtime = 0; // 强制下次 _saveDb 重新评估外部修改
    }
}

// ── KV 操作 ──
function _get(key: string): any {
    _reloadIfChanged();
    const stmt = _db.prepare('SELECT value FROM ai_state WHERE key=?');
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
    _db.run('INSERT OR REPLACE INTO ai_state (key, value, updated_at) VALUES (?,?,?)',
        [key, json, Date.now()]);
    _saveDb();
}

function _del(key: string): void {
    _reloadIfChanged();
    _db.run('DELETE FROM ai_state WHERE key=?', [key]);
    _saveDb();
}

function _getAll(): Record<string, any> {
    _reloadIfChanged();
    const result: Record<string, any> = {};
    const stmt = _db.prepare('SELECT key, value FROM ai_state');
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

// ── IPC 注册 ──
export function registerAiStateIpc(): void {
    ipcMain.handle('qqqide:ai-state:get', async (_e, key: string) => {
        await _ensureDb();
        return _get(key);
    });

    ipcMain.handle('qqqide:ai-state:set', async (_e, key: string, value: any) => {
        await _ensureDb();
        _set(key, value);
        // ★ 广播到所有窗口 → 跨窗口秒级同步
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                try { win.webContents.send('qqqide:ai-state:changed', { key, value }); } catch { /* ignore */ }
            }
        });
        return true;
    });

    ipcMain.handle('qqqide:ai-state:del', async (_e, key: string) => {
        await _ensureDb();
        _del(key);
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
                try { win.webContents.send('qqqide:ai-state:changed', { key, value: null, deleted: true }); } catch { /* ignore */ }
            }
        });
        return true;
    });

    ipcMain.handle('qqqide:ai-state:getAll', async () => {
        await _ensureDb();
        return _getAll();
    });
}
