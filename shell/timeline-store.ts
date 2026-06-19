// ============================================================================
// timeline-store.ts — 文件版本时间线存储 (SHA256去重 + gzip + SQLite索引)
// 存储: {projectRoot}/qqq/timeline/
//   blobs/{sha256[:2]}/{sha256}.gz  — 内容（不可变）
//   timeline.db                       — SQLite 版本索引
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { BrowserWindow } from 'electron';

export const _timelineDbs: Map<string, any> = new Map(); // projectRoot → sql.js Database
export const _diffWindows: Map<string, BrowserWindow> = new Map(); // filePath → BrowserWindow (单例)
// ★ 初始化锁：防止同时两个请求各开各的 DB（导致去重失效 + 数据覆盖）
const _tlInitLocks: Map<string, Promise<any>> = new Map();

export function _tlDir(projectRoot: string): string {
    return path.join(projectRoot, 'qqq', 'timeline');
}

export function _tlBlobPath(projectRoot: string, sha256: string): string {
    return path.join(_tlDir(projectRoot), 'blobs', sha256.slice(0, 2), sha256 + '.gz');
}

/** 打开或创建 timeline SQLite 数据库（加锁防双开） */
export async function _tlOpenDb(projectRoot: string): Promise<any> {
    const dbPath = path.join(_tlDir(projectRoot), 'timeline.db');
    let db = _timelineDbs.get(dbPath);
    if (db) return db;
    // ★ 同一 dbPath 同时只允许一个初始化
    const existingInit = _tlInitLocks.get(dbPath);
    if (existingInit) return existingInit;
    const initPromise = (async () => {
        try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (_) { }
        const initSqlJs = require('sql.js');
        const SQL = await initSqlJs();
        if (fs.existsSync(dbPath)) {
            try {
                const buf = fs.readFileSync(dbPath);
                db = new SQL.Database(buf);
            } catch (e) {
                console.warn('[timeline] corrupt db, starting fresh:', e);
                try { fs.renameSync(dbPath, dbPath + '.corrupt.' + Date.now()); } catch (_) { }
                db = new SQL.Database();
            }
        } else {
            db = new SQL.Database();
        }
        db.run(`CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        ts INTEGER NOT NULL,
        blob_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        floor_id TEXT,
        added_lines INTEGER,
        deleted_lines INTEGER
    )`);
        // 向前兼容：旧表无新列则补
        try { db.run('ALTER TABLE versions ADD COLUMN added_lines INTEGER'); } catch (_) { /* already exists */ }
        try { db.run('ALTER TABLE versions ADD COLUMN deleted_lines INTEGER'); } catch (_) { /* already exists */ }
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_path_ts ON versions(file_path, ts)');
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA synchronous=FULL');
        db.run('PRAGMA busy_timeout=30000');
        _timelineDbs.set(dbPath, db);
        // 清理历史孤儿 tmp（纯收益，零风险）
        _tlCleanStaleTmp(projectRoot);
        return db;
    })();
    _tlInitLocks.set(dbPath, initPromise);
    try { return await initPromise; } finally { _tlInitLocks.delete(dbPath); }
}

// ── 延迟批量化刷盘：避免每次 record 都全量导出 SQL.js DB ──
const _tlFlushTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const _tlFlushDebounceMs = 2000; // 2s 无新写入再刷盘

/** timeline tmp 目录 */
function _tlTmpDir(projectRoot: string): string {
    return path.join(_tlDir(projectRoot), '.tmp');
}

export function _tlFlushDb(db: any, dbPath: string): void {
    // 取消旧定时器，重新计时
    const existing = _tlFlushTimers.get(dbPath);
    if (existing) clearTimeout(existing);
    _tlFlushTimers.set(dbPath, setTimeout(() => {
        _tlFlushTimers.delete(dbPath);
        try {
            const projectRoot = path.dirname(path.dirname(path.dirname(dbPath))); // dbPath = {root}/qqq/timeline/timeline.db
            const tmpDir = _tlTmpDir(projectRoot);
            try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) { }
            const data = db.export();
            const tmp = path.join(tmpDir, 'timeline.db.tmp.' + Date.now());
            fs.writeFileSync(tmp, Buffer.from(data));
            fs.renameSync(tmp, dbPath);
        } catch (e) {
            console.warn('[timeline] flush failed:', e);
        }
    }, _tlFlushDebounceMs));
}

/** 强制立即刷盘（退出前调用） */
export function _tlFlushNow(db: any, dbPath: string): void {
    const timer = _tlFlushTimers.get(dbPath);
    if (timer) { clearTimeout(timer); _tlFlushTimers.delete(dbPath); }
    try {
        const projectRoot = path.dirname(path.dirname(path.dirname(dbPath)));
        const tmpDir = _tlTmpDir(projectRoot);
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) { }
        const data = db.export();
        const tmp = path.join(tmpDir, 'timeline.db.tmp.' + Date.now());
        fs.writeFileSync(tmp, Buffer.from(data));
        fs.renameSync(tmp, dbPath);
    } catch (e) {
        console.warn('[timeline] flushNow failed:', e);
    }
}

/** SHA256 hex (64 chars) */
export function _sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Gzip 压缩内容，返回 Buffer */
export function _gzipSync(content: string): Buffer {
    return zlib.gzipSync(Buffer.from(content, 'utf8'), { level: 6 });
}

/** Gunzip 解压，返回 string */
export function _gunzipSync(buf: Buffer): string {
    return zlib.gunzipSync(buf).toString('utf8');
}

/** 原子写入 blob（tmp 放在 .tmp/ 子目录，rename 到正式位置） */
export function _tlWriteBlob(projectRoot: string, sha256: string, gzBuf: Buffer): void {
    const blobPath = _tlBlobPath(projectRoot, sha256);
    const dir = path.dirname(blobPath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { }
    // 如果已存在，跳过（相同内容不可变）
    if (fs.existsSync(blobPath)) return;
    const tmpDir = _tlTmpDir(projectRoot);
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) { }
    const tmp = path.join(tmpDir, sha256 + '.tmp.' + Date.now());
    fs.writeFileSync(tmp, gzBuf);
    fs.renameSync(tmp, blobPath);
}

/** 清理孤儿 tmp 文件（.tmp/ 整个目录清空即可，零风险） */
function _tlCleanStaleTmp(projectRoot: string): void {
    const tmpDir = _tlTmpDir(projectRoot);
    try {
        if (!fs.existsSync(tmpDir)) return;
        const files = fs.readdirSync(tmpDir);
        for (const f of files) {
            try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) { }
        }
    } catch (_) { }
}
