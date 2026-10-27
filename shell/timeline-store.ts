// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// timeline-store.ts — 文件版本时间线存储（极简架构，2026-06-21）
//
// 存储: {projectRoot}/_qqq/timeline/
//   blobs/{sha256[:2]}/{sha256}.gz    — 内容（未可变，SHA256 寻址，永不删除）
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
    return path.join(projectRoot, '_qqq', 'timeline');
}

export function _tlBlobPath(projectRoot: string, sha256: string): string {
    const dir = path.join(_tlDir(projectRoot), 'blobs', sha256.slice(0, 2));
    if (sha256.length >= 64) {
        return path.join(dir, sha256 + '.gz');
    }
    // ★ 2026-08-18: 支持 12 位短前缀（timeline_versions 返回的 sha=xxx 截断格式）——
    //   旧实现直接拼 12 位文件名 → blob 永远不存在。扫描目录找唯一前缀匹配；
    //   多匹配（冲突概率≈0）取字典序最大，尽力而为。
    try {
        const hits = fs.readdirSync(dir).filter(f => f.startsWith(sha256) && f.endsWith('.gz'));
        if (hits.length === 1) return path.join(dir, hits[0]);
        if (hits.length > 1) return path.join(dir, hits.sort().pop()!);
    } catch { /* dir missing */ }
    return path.join(dir, sha256 + '.gz');
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

// ═══ 路径归一（唯一真理源）：file_path = 显示路径，path_key = 查找键 ═══
//   非 linux（大小写不敏感文件系统）查找键整体折叠大小写——同一文件绝不被拆成两段历史；
//   linux 保留原样（大小写敏感，折叠会把两个不同文件并成一个）。
const _TL_CASE_FOLD = process.platform !== 'linux';

export function _tlNormDisplayPath(p: string): string {
    let s = String(p || '').replace(/\\/g, '/');
    if (/^[a-z]:\//.test(s)) s = s[0].toUpperCase() + s.slice(1);
    return s;
}

export function _tlPathKey(p: string): string {
    const s = _tlNormDisplayPath(p);
    return _TL_CASE_FOLD ? s.toLowerCase() : s;
}

// ═══ per-file 串行队列：写入口兜底捕获与显式 record 同键排队（顺序确定，绝不双写）═══
const _tlQueues: Map<string, Promise<any>> = new Map();

export function _tlEnqueue<T>(key: string, job: () => Promise<T>): Promise<T | null> {
    const prev = _tlQueues.get(key) || Promise.resolve();
    const next: Promise<any> = prev.then(job, job).catch(() => null);
    _tlQueues.set(key, next);
    const drop = () => { if (_tlQueues.get(key) === next) _tlQueues.delete(key); };
    next.then(drop, drop);
    return next;
}

// ═══ 最近一行缓存（dbPath|pathKey → row）：内容级去重 / 溯源补全的唯一依据 ═══
const _tlLastByKey: Map<string, any> = new Map();

export function _tlLastRow(db: any, dbPath: string, key: string): any {
    const ck = dbPath + '|' + key;
    if (_tlLastByKey.has(ck)) return _tlLastByKey.get(ck);
    let row: any = null;
    try {
        const st = db.prepare('SELECT id, file_seq, ts, blob_hash, source, floor_id, added_lines, deleted_lines FROM versions WHERE path_key = ? ORDER BY ts DESC, id DESC LIMIT 1');
        st.bind([key]);
        if (st.step()) row = st.getAsObject();
        st.free();
    } catch (_) { /* 列不存在 → 视为无历史 */ }
    _tlLastByKey.set(ck, row);
    return row;
}

function _tlNextSeq(db: any, key: string): number {
    try {
        const st = db.prepare('SELECT COALESCE(MAX(file_seq), 0) + 1 AS ns FROM versions WHERE path_key = ?');
        st.bind([key]);
        let ns = 1;
        if (st.step()) ns = st.getAsObject().ns as number;
        st.free();
        return ns;
    } catch (_) { return 1; }
}

// ═══ 项目根解析（自动捕获专用）：最近一个含 _qqq 的祖先目录 ═══
const _tlRootCache: Map<string, string | null> = new Map();

export function _tlResolveProjectRoot(filePath: string): string | null {
    let dir = path.dirname(_tlNormDisplayPath(filePath));
    const chain: string[] = [];
    let found: string | null = null;
    for (let i = 0; i < 12; i++) {
        if (_tlRootCache.has(dir)) { found = _tlRootCache.get(dir) as string | null; break; }
        chain.push(dir);
        try { if (fs.existsSync(path.join(dir, '_qqq'))) { found = dir; break; } } catch (_) { }
        const up = path.dirname(dir);
        if (!up || up === dir) break;
        dir = up;
    }
    // ★ 只缓存命中：负结果缓存会让「首写时尚无 _qqq、随后才建 _qqq」的目录整场会话都抓不到时间线
    if (found) for (const d of chain) _tlRootCache.set(d, found);
    return found;
}

// ═══ 自动捕获范围：只记「用户可见资产」（内部状态 / 缓存 / 二进制 / 超大一律不入）═══
const TL_CAPTURE_MAX_CHARS = 1024 * 1024;

export function _tlShouldCapture(filePath: string, text: any): boolean {
    if (typeof text !== 'string' || text.length === 0) return false;
    if (text.length > TL_CAPTURE_MAX_CHARS) return false;
    if (text.indexOf('\0') !== -1) return false;
    const p = _tlNormDisplayPath(filePath);
    if (!p) return false;
    if (/\/(?:node_modules|\.git|_qqq|\.trash)(?:\/|$)/.test(p)) return false;
    if (/\/Data\/(?:Cache|Code Cache|GPUCache|DawnCache|CrashDumps|Logs|Temp|Session Storage|Local Storage|IndexedDB|blob_storage|Service Worker|VideoDecodeStats|shared_proto_db|databases|Network|Partitions|WebStorage)\//i.test(p)) return false;
    if (/\.tmp\./.test(p)) return false;
    return true;
}

// ═══ 写入口兜底捕获（显式 record 优先）═══
//   fs:write 落盘后延迟 TL_CLAIM_MS 才入库；窗口内同文件发生显式 record → 认领并取消兜底。
//   语义：编辑器 / AI 工具 / 恢复链各自的显式快照（带溯源与行数）永不被兜底行抢占或重复。
const TL_CLAIM_MS = 1500;
const _tlPending: Map<string, { file: string; text: string; timer: any }> = new Map();

function _tlDropPending(ck: string): void {
    const pend = _tlPending.get(ck);
    if (!pend) return;
    try { clearTimeout(pend.timer); } catch (_) { }
    _tlPending.delete(ck);
}

// ★ 按内容认领：待捕获内容与本次显式记录一致才作废（sha 省略 = 按路径认领，旧行为）
//   只比路径会把「1.5s 内两次不同内容的写」里的前一版一起吞掉——中间版本凭空消失。
export function _tlClaimPath(filePath: string, sha?: string): void {
    const ck = _tlPathKey(filePath);
    const pend = _tlPending.get(ck);
    if (!pend) return;
    if (sha) {
        let pendSha = '';
        try { pendSha = _sha256(pend.text); } catch (_) { }
        if (pendSha !== sha) return;
    }
    _tlDropPending(ck);
}

export function _tlScheduleCapture(filePath: string, text: any): void {
    if (!_tlShouldCapture(filePath, text)) return;
    const ck = _tlPathKey(filePath);
    _tlDropPending(ck);
    const timer = setTimeout(() => {
        const pend = _tlPending.get(ck);
        if (!pend) return;
        _tlPending.delete(ck);
        _tlCaptureNow(pend.file, pend.text).catch(() => { /* 捕获失败绝不阻塞写 */ });
    }, TL_CLAIM_MS);
    try { if (timer && typeof (timer as any).unref === 'function') (timer as any).unref(); } catch (_) { }
    _tlPending.set(ck, { file: filePath, text: text, timer });
}

async function _tlCaptureNow(filePath: string, text: string): Promise<void> {
    const root = _tlResolveProjectRoot(filePath);
    if (!root) return;   // 不在任何项目根内 → 无时间线可归属（如绿色包自带的 Data）
    const dbPath = _tlDbPath(root);
    const key = _tlPathKey(filePath);
    await _tlEnqueue(dbPath + '|' + key, async () => {
        const db = await _tlOpenDb(root);
        const sha = _sha256(text);
        if (!fs.existsSync(_tlBlobPath(root, sha))) _tlWriteBlob(root, sha, _gzipSync(text));
        _tlCommit(db, dbPath, root, { file_path: _tlNormDisplayPath(filePath), ts: Date.now(), blob_hash: sha, source: 'fs' });
    });
}

// ═══ 存量迁移（幂等，一次即净）：① 迁移前留底 ② path_key 回填 + Unicode 折叠纠偏 ③ 重号重排 ═══
function _tlPreMigratePath(projectRoot: string): string {
    return path.join(_tlDir(projectRoot), 'timeline.db.pre-migrate');
}

function _tlNeedsMigration(db: any): boolean {
    try {
        const c = db.exec("SELECT COUNT(*) FROM versions WHERE path_key IS NULL OR path_key = ''");
        if (c && c[0] && c[0].values && c[0].values[0] && (c[0].values[0][0] as number) > 0) return true;
    } catch (_) { }
    try {
        const g = db.prepare('SELECT path_key FROM versions GROUP BY path_key HAVING COUNT(file_seq) > COUNT(DISTINCT file_seq) LIMIT 1');
        const hit = g.step();
        g.free();
        if (hit) return true;
    } catch (_) { }
    return false;
}

function _tlMigratePathKey(db: any): boolean {
    let changed = false;

    // 回填用单条 SQL（不逐行 update——sql.js 下逐行会拖慢首次启动）：char(92)='\'
    //   注意：SQL 的 lower() 只折叠 ASCII（CJK 无大小写，实际差异只剩非 ASCII 大写）——紧随其后按 JS 口径纠偏
    let pendCount = 0;
    try {
        const c = db.exec("SELECT COUNT(*) FROM versions WHERE path_key IS NULL OR path_key = ''");
        if (c && c[0] && c[0].values && c[0].values[0]) pendCount = c[0].values[0][0] as number;
    } catch (_) { }
    if (pendCount > 0) {
        const expr = _TL_CASE_FOLD
            ? "lower(replace(file_path, char(92), '/'))"
            : "replace(file_path, char(92), '/')";
        try {
            db.run('UPDATE versions SET path_key = ' + expr + " WHERE path_key IS NULL OR path_key = ''");
            changed = true;
            console.log('[timeline] path_key backfilled: ' + pendCount);
        } catch (e: any) {
            console.warn('[timeline] path_key backfill failed:', e && e.message);
        }
    }

    // ★ SQL 的 lower() 只折叠 ASCII，运行时 _tlPathKey 用 JS toLowerCase（全 Unicode）——
    //   非 ASCII 大写的路径会被回填成与查找键不同的值（同一文件再裂一次）。回填发生的这次启动里按 JS 口径纠偏。
    if (pendCount > 0) {
        try {
            const pairs: string[][] = [];
            const d = db.prepare('SELECT file_path, path_key FROM versions GROUP BY file_path, path_key');
            while (d.step()) { const r = d.getAsObject(); pairs.push([String(r.file_path || ''), String(r.path_key || '')]); }
            d.free();
            const fixes: string[][] = [];
            for (const pr of pairs) { const want = _tlPathKey(pr[0]); if (want !== pr[1]) fixes.push([want, pr[0]]); }
            if (fixes.length > 0) {
                db.run('BEGIN');
                const up = db.prepare('UPDATE versions SET path_key = ? WHERE file_path = ?');
                for (const f of fixes) up.run(f);
                up.free();
                db.run('COMMIT');
                changed = true;
                console.log('[timeline] path_key unicode-fold fixed: ' + fixes.length);
            }
        } catch (e: any) {
            try { db.run('ROLLBACK'); } catch (_) { }
            console.warn('[timeline] path_key unicode fold failed:', e && e.message);
        }
    }

    // 同一 path_key 出现重号（历史上被大小写拆成两段）→ 按时间重排为 1..N
    try {
        const groups: string[] = [];
        const g = db.prepare('SELECT path_key FROM versions GROUP BY path_key HAVING COUNT(file_seq) > COUNT(DISTINCT file_seq)');
        while (g.step()) groups.push(String(g.getAsObject().path_key || ''));
        g.free();
        for (const k of groups) {
            const ids: number[] = [];
            const q = db.prepare('SELECT id FROM versions WHERE path_key = ? ORDER BY ts ASC, id ASC');
            q.bind([k]);
            while (q.step()) ids.push(q.getAsObject().id as number);
            q.free();
            try {
                db.run('BEGIN');
                const up = db.prepare('UPDATE versions SET file_seq = ? WHERE id = ?');
                for (let i = 0; i < ids.length; i++) up.run([i + 1, ids[i]]);
                up.free();
                db.run('COMMIT');
                changed = true;
            } catch (e: any) {
                try { db.run('ROLLBACK'); } catch (_) { }
                console.warn('[timeline] seq renumber failed:', e && e.message);
            }
        }
        if (groups.length > 0) console.log('[timeline] seq renumbered groups: ' + groups.length);
    } catch (_) { }

    return changed;
}

// ═══ 强制落盘（export → .db + .bak，不动 .wal）═══
export function _tlFlushDb(db: any, dbPath: string, projectRoot: string): void {
    const tmpDir = _tlTmpDir(projectRoot);
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) { }
    const data = db.export();
    const tmp = path.join(tmpDir, 'timeline.db.tmp.' + Date.now());
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, dbPath);
    const bakPath = _tlBakPath(projectRoot);
    const bakTmp = path.join(tmpDir, 'timeline.db.bak.tmp.' + Date.now());
    fs.writeFileSync(bakTmp, Buffer.from(data));
    try { fs.renameSync(bakTmp, bakPath); } catch (_) {
        try { fs.writeFileSync(bakPath, Buffer.from(data)); } catch (_) { }
        try { fs.unlinkSync(bakTmp); } catch (_) { }
    }
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
        // ★ 序号计数器按 path_key（同一文件的大小写变体共用一套编号）
        var seqMap: Map<string, number> = new Map();
        // 预查询已有最大序号（WAL 条目续接 DB 中已有编号）
        var seqInitStmt = db.prepare('SELECT path_key, COALESCE(MAX(file_seq), 0) as mx FROM versions GROUP BY path_key');
        while (seqInitStmt.step()) {
            var sr = seqInitStmt.getAsObject();
            seqMap.set(String(sr.path_key || ''), sr.mx);
        }
        seqInitStmt.free();
        const stmt = db.prepare(
            'INSERT INTO versions (file_path, path_key, file_seq, ts, blob_hash, source, floor_id, added_lines, deleted_lines) VALUES (?,?,?,?,?,?,?,?,?)'
        );
        for (const line of lines) {
            try {
                const row = JSON.parse(line);
                var fp = _tlNormDisplayPath(row.p || '');
                var pk = _tlPathKey(fp);
                var seq = (seqMap.get(pk) || 0) + 1;
                seqMap.set(pk, seq);
                stmt.run([fp, pk, seq, row.t || 0, row.h || '', row.s || 'q', row.f || null, row.a || null, row.d || null]);
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
        try { db.run('ALTER TABLE versions ADD COLUMN path_key TEXT'); } catch (_) { }
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_path_ts ON versions(file_path, ts)');
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_path_seq ON versions(file_path, file_seq)');
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_key_ts ON versions(path_key, ts)');
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_key_seq ON versions(path_key, file_seq)');
        db.run('PRAGMA journal_mode=DELETE');
        db.run('PRAGMA synchronous=FULL');
        db.run('PRAGMA busy_timeout=30000');

        // 3. 存量迁移：path_key 回填（历史上被大小写拆开的两段合并）+ 重号重排（幂等）
        //    迁移前一次性留底 timeline.db.pre-migrate（迁移写坏时唯一的回滚通道；只在需要迁移时拷）
        if (_tlNeedsMigration(db)) {
            try {
                const pm = _tlPreMigratePath(projectRoot);
                if (!fs.existsSync(pm) && fs.existsSync(dbPath)) {
                    fs.copyFileSync(dbPath, pm);
                    console.log('[timeline] pre-migrate backup: ' + pm);
                }
            } catch (e: any) {
                console.warn('[timeline] pre-migrate backup failed:', e && e.message);
            }
        }
        const migrated = _tlMigratePathKey(db);

        // 4. 回放 .wal（最多 99 行，上次压缩后未压缩的）
        const replayed = _tlReplayWal(db, projectRoot);
        if (replayed > 0) {
            console.log('[timeline] replayed ' + replayed + ' wal entries');
        }

        _timelineDbs.set(dbPath, db);
        _tlWalCounts.set(dbPath, replayed);
        _tlCleanStaleTmp(projectRoot);

        // 5. 有回放数据 → 立即压缩到 .db + .bak（清 .wal）；仅迁移 → 直接落盘（否则下次启动重跑）
        if (replayed > 0) {
            try { _tlCompactSync(db, dbPath, projectRoot); } catch (_) { }
        } else if (migrated) {
            try { _tlFlushDb(db, dbPath, projectRoot); } catch (_) { }
        }
        _tlLastByKey.clear();

        return db;
    })();

    _tlInitLocks.set(dbPath, initPromise);
    try { return await initPromise; } finally { _tlInitLocks.delete(dbPath); }
}

// ═══ 写入一条快照 → 内存 INSERT + 追加 .wal（零延迟） ═══
export interface TlRowIn {
    file_path: string; ts: number; blob_hash: string; source: string;
    floor_id?: string | null; added_lines?: number | null; deleted_lines?: number | null;
}

export function _tlRecord(db: any, dbPath: string, projectRoot: string, row: TlRowIn): void {
    const pathKey = _tlPathKey(row.file_path);
    // ★ 计算 per-file 自增序号（AI 和人类用序号指代快照，如 #23）
    const fileSeq = _tlNextSeq(db, pathKey);

    // 内存 INSERT
    db.run(
        'INSERT INTO versions (file_path, path_key, file_seq, ts, blob_hash, source, floor_id, added_lines, deleted_lines) VALUES (?,?,?,?,?,?,?,?,?)',
        [row.file_path, pathKey, fileSeq, row.ts, row.blob_hash, row.source, row.floor_id || null, row.added_lines ?? null, row.deleted_lines ?? null]
    );

    let newId: number | null = null;
    try {
        const r = db.exec('SELECT last_insert_rowid() AS id');
        if (r && r[0] && r[0].values && r[0].values[0]) newId = r[0].values[0][0] as number;
    } catch (_) { }
    _tlLastByKey.set(dbPath + '|' + pathKey, {
        id: newId, file_seq: fileSeq, ts: row.ts, blob_hash: row.blob_hash, source: row.source,
        floor_id: row.floor_id || null, added_lines: row.added_lines ?? null, deleted_lines: row.deleted_lines ?? null,
    });

    // 追加 .wal（字段缩写，每行 ~100 字节）
    const walLine = JSON.stringify({
        p: row.file_path, q: fileSeq, t: row.ts, h: row.blob_hash, s: row.source,
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

// ═══ 统一提交（唯一真理机）：内容未变 → 不新建版本，只补溯源；内容已变 → 新建 ═══
export function _tlCommit(db: any, dbPath: string, projectRoot: string, row: TlRowIn): { recorded: boolean; upgraded?: boolean; reason?: string; file_seq?: number } {
    const key = _tlPathKey(row.file_path);
    const ck = dbPath + '|' + key;
    const last = _tlLastRow(db, dbPath, key);

    if (last && last.blob_hash === row.blob_hash) {
        // 同一内容再报到：兜底行（fs）让位给更权威的来源；缺溯源/行数就地补全
        const wantSrc = row.source || '';
        const betterSrc = !!(wantSrc && wantSrc !== 'fs' && last.source === 'fs');
        const fillFloor = !!(row.floor_id && !last.floor_id);
        const fillLines = (last.added_lines == null && row.added_lines != null) || (last.deleted_lines == null && row.deleted_lines != null);
        if (betterSrc || fillFloor || fillLines) {
            const next = {
                id: last.id, file_seq: last.file_seq, ts: last.ts, blob_hash: last.blob_hash,
                source: betterSrc ? wantSrc : last.source,
                floor_id: row.floor_id || last.floor_id || null,
                added_lines: row.added_lines ?? last.added_lines,
                deleted_lines: row.deleted_lines ?? last.deleted_lines,
            };
            try {
                db.run('UPDATE versions SET source = ?, floor_id = ?, added_lines = ?, deleted_lines = ? WHERE id = ?',
                    [next.source, next.floor_id, next.added_lines, next.deleted_lines, last.id]);
                _tlLastByKey.set(ck, next);
                return { recorded: false, upgraded: true, file_seq: next.file_seq };
            } catch (_) { /* 升级失败 → 按同内容跳过 */ }
        }
        return { recorded: false, reason: 'same-content', file_seq: last.file_seq };
    }

    _tlRecord(db, dbPath, projectRoot, row);
    const after = _tlLastRow(db, dbPath, key);
    return { recorded: true, file_seq: after ? after.file_seq : undefined };
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

    // 1+2. 全量快照 → .db + .bak
    _tlFlushDb(db, dbPath, projectRoot);

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
