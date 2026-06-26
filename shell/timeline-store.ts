// ============================================================================
// timeline-store.ts — 文件版本时间线存储（极简架构，2026-06-21）
//
// 存储: {projectRoot}/qqq/timeline/
//   blobs/{sha256[:2]}/{sha256}.gz    — 内容（不可变，SHA256 寻址，永不删除）
//   timeline.db                         — SQLite 索引（全量快照，每 100 条快照压缩一次）
//   timeline.db.bak                     — 索引备份（压缩后同步更新，损坏时自动恢复）
//   timeline.wal                        — 增量日志（NDJSON 追加，压缩后清空）
//
// 写入:
//   每条快照 → 内存 INSERT + append 一行到 .wal（零延迟）
//   第 100 条 → 压缩：db.export → .db + .bak → 清空 .wal（重置计数）
//   退出时 → 强制压缩一次（确保 .wal 不残留）
//
// 恢复:
//   启动 → 加载 .db（损坏→.bak→空库）→ 回放 .wal（最多 99 行未压缩的）→ 完整
//
// 铁律:
//   - blob 文件永不删除（内容寻址 + gzip，git 内核设计）
//   - SQLite 是纯缓存，.bak 是一份备份，.wal 是暂存器（最多 99 行）
//   - 所有写入走 tmp+rename 原子化
//   - SHA256 行尾归一化（CRLF/LF 视为相同内容）
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { BrowserWindow } from 'electron';

export const _timelineDbs: Map<string, any> = new Map();
export const _diffWindows: Map<string, BrowserWindow> = new Map();
const _tlInitLocks: Map<string, Promise<any>> = new Map();

const WAL_MAX_LINES = 100;

const _tlWalCounts: Map<string, number> = new Map();  // .wal 当前行数（用于阈值判断）

export function _tlDir(projectRoot: string): string {
    return path.join(projectRoot, 'Data', 'qqq', 'timeline');
}

export function _tlBlobPath(projectRoot: string, sha256: string): string {
    return path.join(_tlDir(projectRoot), 'blobs', sha256.slice(0, 2), sha256 + '.gz');
}

function _tlDbPath(projectRoot: string): string {
    return path.join(_tlDir(projectRoot), 'timeline.db');
}

function _tlBakPath(projectRoot: string): string {
    return path.join(_tlDir(projectRoot), 'timeline.db.bak');
}

function _tlWalPath(projectRoot: string): string {
    return path.join(_tlDir(projectRoot), 'timeline.wal');
}

function _tlTmpDir(projectRoot: string): string {
    return path.join(_tlDir(projectRoot), '.tmp');
}

// ── 回放 .wal 的内容到 DB，返回回放行数 ──
function _tlReplayWal(db: any, projectRoot: string): number {
    const walPath = _tlWalPath(projectRoot);
    if (!fs.existsSync(walPath)) return 0;
    let count = 0;
    try {
        const content = fs.readFileSync(walPath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length === 0) return 0;
        // ★ per-file 序号计数器（WAL 条目按追加顺序，同文件递增）
        var seqMap: Map<string, number> = new Map();
        // 预查询已有最大序号（WAL 条目续接 DB 中已有编号）
        var seqInitStmt = db.prepare('SELECT file_path, COALESCE(MAX(file_seq), 0) as mx FROM versions GROUP BY file_path');
        while (seqInitStmt.step()) {
            var sr = seqInitStmt.getAsObject();
            seqMap.set(sr.file_path, sr.mx);
        }
        seqInitStmt.free();
        const stmt = db.prepare(
            'INSERT INTO versions (file_path, file_seq, ts, blob_hash, source, floor_id, added_lines, deleted_lines) VALUES (?,?,?,?,?,?,?,?)'
        );
        for (const line of lines) {
            try {
                const row = JSON.parse(line);
                var fp = row.p || '';
                var seq = (seqMap.get(fp) || 0) + 1;
                seqMap.set(fp, seq);
                stmt.run([fp, seq, row.t || 0, row.h || '', row.s || 'q', row.f || null, row.a || null, row.d || null]);
                count++;
            } catch (_) { /* 跳过损坏行 */ }
        }
        stmt.free();
    } catch (e) {
        console.warn('[timeline] wal replay failed:', e && (e as any).message);
    }
    return count;
}

// ═══ 打开或创建 DB — 恢复：.db → .bak → 空库 → 回放 .wal ═══
export async function _tlOpenDb(projectRoot: string): Promise<any> {
    const dbPath = _tlDbPath(projectRoot);
    let db = _timelineDbs.get(dbPath);
    if (db) return db;

    const existingInit = _tlInitLocks.get(dbPath);
    if (existingInit) return existingInit;

    const initPromise = (async () => {
        try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (_) { }
        const initSqlJs = require('sql.js');
        const SQL = await initSqlJs();

        // 1. 加载主 DB（损坏 → 尝试 .bak → 空库）
        let dbLoaded = false;
        for (const tryPath of [dbPath, _tlBakPath(projectRoot)]) {
            if (!fs.existsSync(tryPath)) continue;
            try {
                const buf = fs.readFileSync(tryPath);
                db = new SQL.Database(buf);
                db.exec('SELECT 1');  // 验证真实可用
                dbLoaded = true;
                if (tryPath !== dbPath) {
                    console.warn('[timeline] main db corrupt, recovered from .bak');
                    try { fs.writeFileSync(dbPath, buf); } catch (_) { }
                }
                break;
            } catch (e) {
                console.warn('[timeline] db load failed:', tryPath, e && (e as any).message);
                try { fs.renameSync(tryPath, tryPath + '.corrupt.' + Date.now()); } catch (_) { }
                db = null;
            }
        }
        if (!dbLoaded || !db) db = new SQL.Database();

        // 2. 建表（幂等）
        db.run(`CREATE TABLE IF NOT EXISTS versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL, ts INTEGER NOT NULL, blob_hash TEXT NOT NULL,
            source TEXT NOT NULL, floor_id TEXT, added_lines INTEGER, deleted_lines INTEGER,
            file_seq INTEGER
        )`);
        try { db.run('ALTER TABLE versions ADD COLUMN file_seq INTEGER'); } catch (_) { }
        try { db.run('ALTER TABLE versions ADD COLUMN added_lines INTEGER'); } catch (_) { }
        try { db.run('ALTER TABLE versions ADD COLUMN deleted_lines INTEGER'); } catch (_) { }
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_path_ts ON versions(file_path, ts)');
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_path_seq ON versions(file_path, file_seq)');
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA synchronous=FULL');
        db.run('PRAGMA busy_timeout=30000');

        // 3. 回放 .wal（最多 99 行，上次压缩后未压缩的）
        const replayed = _tlReplayWal(db, projectRoot);
        if (replayed > 0) {
            console.log('[timeline] replayed ' + replayed + ' wal entries');
        }

        _timelineDbs.set(dbPath, db);
        _tlWalCounts.set(dbPath, replayed);
        _tlCleanStaleTmp(projectRoot);

        // 4. 有回放数据 → 立即压缩到 .db + .bak（清 .wal）
        if (replayed > 0) {
            try { _tlCompactSync(db, dbPath, projectRoot); } catch (_) { }
        }

        return db;
    })();

    _tlInitLocks.set(dbPath, initPromise);
    try { return await initPromise; } finally { _tlInitLocks.delete(dbPath); }
}

// ═══ 写入一条快照 → 内存 INSERT + 追加 .wal（零延迟） ═══
export function _tlRecord(
    db: any, dbPath: string, projectRoot: string,
    row: { file_path: string; ts: number; blob_hash: string; source: string; floor_id?: string | null; added_lines?: number | null; deleted_lines?: number | null }
): void {
    // ★ 计算 per-file 自增序号（AI 和人类用序号指代快照，如 #23）
    var fileSeq = 1;
    try {
        var seqStmt = db.prepare('SELECT COALESCE(MAX(file_seq), 0) + 1 as ns FROM versions WHERE file_path = ?');
        seqStmt.bind([row.file_path]);
        if (seqStmt.step()) { fileSeq = seqStmt.getAsObject().ns; }
        seqStmt.free();
    } catch (_) { /* 列不存在时静默降级 */ }

    // 内存 INSERT
    db.run(
        'INSERT INTO versions (file_path, file_seq, ts, blob_hash, source, floor_id, added_lines, deleted_lines) VALUES (?,?,?,?,?,?,?,?)',
        [row.file_path, fileSeq, row.ts, row.blob_hash, row.source, row.floor_id || null, row.added_lines || null, row.deleted_lines || null]
    );

    // 追加 .wal（字段缩写，每行 ~100 字节）
    const walLine = JSON.stringify({
        p: row.file_path, q: fileSeq, t: row.ts, h: row.blob_hash, s: row.source,
        f: row.floor_id || undefined,
        a: row.added_lines ?? undefined, d: row.deleted_lines ?? undefined,
    }) + '\n';ine = JSON.stringify({
        p: row.file_path, t: row.ts, h: row.blob_hash, s: row.source,
        f: row.floor_id || undefined,
        a: row.added_lines ?? undefined, d: row.deleted_lines ?? undefined,
    }) + '\n';

    const walPath = _tlWalPath(projectRoot);
    try { fs.mkdirSync(path.dirname(walPath), { recursive: true }); } catch (_) { }
    fs.appendFileSync(walPath, walLine, 'utf8');

    // 递增计数，达到阈值 → 立即压缩
    const count = (_tlWalCounts.get(dbPath) || 0) + 1;
    _tlWalCounts.set(dbPath, count);

    if (count >= WAL_MAX_LINES) {
        _tlCompactSync(db, dbPath, projectRoot);
    }
}

// ═══ 强制压缩（退出前调用） ═══
export function _tlFlushNow(db: any, dbPath: string, projectRoot: string): void {
    try { _tlCompactSync(db, dbPath, projectRoot); } catch (e) {
        console.warn('[timeline] flushNow failed:', e && (e as any).message);
    }
}

// ═══ 压缩：全量快照 → .db + .bak → 清空 .wal ═══
function _tlCompactSync(db: any, dbPath: string, projectRoot: string): void {
    const walPath = _tlWalPath(projectRoot);
    const tmpDir = _tlTmpDir(projectRoot);
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) { }

    // 空 .wal 无需压缩
    let walSize = 0;
    try { walSize = fs.statSync(walPath).size; } catch (_) { }
    if (walSize === 0) return;

    // 1. 全量快照 → .tmp → rename .db
    const data = db.export();
    const tmp = path.join(tmpDir, 'timeline.db.tmp.' + Date.now());
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, dbPath);

    // 2. 更新 .bak
    const bakPath = _tlBakPath(projectRoot);
    const bakTmp = path.join(tmpDir, 'timeline.db.bak.tmp.' + Date.now());
    fs.writeFileSync(bakTmp, Buffer.from(data));
    try { fs.renameSync(bakTmp, bakPath); } catch (_) {
        // rename 失败 → 降级 copy
        try { fs.writeFileSync(bakPath, Buffer.from(data)); } catch (_) { }
        try { fs.unlinkSync(bakTmp); } catch (_) { }
    }

    // 3. 清空 .wal（内容已全量进入 .db）
    try { fs.writeFileSync(walPath, '', 'utf8'); } catch (_) { }
    _tlWalCounts.set(dbPath, 0);
}

// ═══ SHA256（行尾归一化：CRLF/LF/CR 视为同一内容） ═══
export function _sha256(content: string): string {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ═══ Gzip 压缩/解压 ═══
export function _gzipSync(content: string): Buffer {
    return zlib.gzipSync(Buffer.from(content, 'utf8'), { level: 6 });
}

export function _gunzipSync(buf: Buffer): string {
    return zlib.gunzipSync(buf).toString('utf8');
}

// ═══ 原子写入 blob ═══
export function _tlWriteBlob(projectRoot: string, sha256: string, gzBuf: Buffer): void {
    const blobPath = _tlBlobPath(projectRoot, sha256);
    const dir = path.dirname(blobPath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { }
    if (fs.existsSync(blobPath)) return;
    const tmpDir = _tlTmpDir(projectRoot);
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) { }
    const tmp = path.join(tmpDir, sha256 + '.tmp.' + Date.now());
    fs.writeFileSync(tmp, gzBuf);
    fs.renameSync(tmp, blobPath);
}

// ═══ 清理孤儿 tmp ═══
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
