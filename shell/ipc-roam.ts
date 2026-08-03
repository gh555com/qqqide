// ============================================================================
// ipc-roam.ts — Roam 资源管理器 OS 级持久化 (sql.js → roam.sq3, 唯一读写者)
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

async function _ensureDb(): Promise<void> {
    if (_db) return;
    if (_initPromise) { await _initPromise; return; }
    _initPromise = (async () => {
        _SQL = await initSqlJs();
        const dbPath = getDbPath();
        const buf = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
        _db = new _SQL.Database(buf);
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
    const buf = fs.readFileSync(dbPath);
    if (_db) _db.close();
    _db = new _SQL.Database(buf);
    _db.run('PRAGMA journal_mode=WAL');
    _lastDiskMtime = mtime;
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
}
