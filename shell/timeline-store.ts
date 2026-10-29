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

// ═══ 路径键（唯一真理源，2026-10-29 定案：无损写入 + 撞名对账）═══
//   path_raw  = 调用方/磁盘给的原始路径，永不改写（stat 对账用的是它——POSIX 上反斜杠是合法文件名字符）
//   file_path = 显示路径（win32 才把 \ 转 / 并大写盘符；POSIX 原样）
//   path_key  = 无损规范键（显示路径 + 折叠 . / .. / 重复斜杠；绝不折叠大小写、绝不做 Unicode 归一）
//   fold_key  = 提示键（path_key 的 NFC + 全 Unicode 小写；只用来「发现可能的同一文件」，永不直接裁决）
//   norm_ver  = 规范版本戳（规则变更即 +1 → 开库时按纯函数重算；派生列永远可重算）
//
//   ★ 裁决铁律：path_key 查不到 ≠ 新文件，只是「可能的新文件」。只有撞 fold_key 且 stat 证明
//     同一 (dev,ino) 才归并；无证据一律分裂。方向恒为「裂而不并」——裂可自愈（下次写入撞上即归并），
//     并不可逆。
//   ★ 为什么不按平台猜大小写敏感：平台是卷的代理，卷是目录的代理，代理错了数据就错。
//     这里只问文件系统本身，且只在撞名那一刻问一次——规则再怎么改，代价都只是一次 stat。
export const TL_NORM_VER = 2;
const _TL_WIN = process.platform === 'win32';

export function _tlPathRaw(p: string): string {
    return String(p == null ? '' : p);
}

// 折叠 . / .. / 重复斜杠（纯函数；只消除信息量为零的差异）
//   ★ UNC 前缀 `//server/share` 必须原样保住两个斜杠——它是有义前缀，塌成一个就与同名 POSIX 绝对路径撞键
function _tlCollapseDots(s: string): string {
    if (!s) return s;
    const drive = /^([A-Za-z]):/.exec(s);
    const unc = !drive && s.slice(0, 2) === '//';
    const abs = !drive && !unc && s.charAt(0) === '/';
    const out: string[] = [];
    for (const seg of (drive ? s.slice(2) : s).split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!drive && !abs) out.push('..');
            continue;
        }
        out.push(seg);
    }
    const tail = out.join('/');
    if (drive) return drive[1].toUpperCase() + ':/' + tail;
    if (unc) return '//' + tail;
    if (abs) return '/' + tail;
    return tail;
}

export function _tlNormDisplayPath(p: string): string {
    const s = _tlPathRaw(p);
    if (!_TL_WIN) return s;                       // POSIX：反斜杠是合法文件名字符，改了就是毁数据
    let d = s.replace(/\\/g, '/');
    if (/^[a-z]:\//.test(d)) d = d.charAt(0).toUpperCase() + d.slice(1);
    return d;
}

export function _tlPathKey(p: string): string {
    return _tlCollapseDots(_tlNormDisplayPath(p));
}

// 提示键：NFC + 全 Unicode 小写。NFC 只在这里做——NTFS 不做 Unicode 归一，
//   NFC/NFD 在磁盘上可能是两个真文件，把归一写进 path_key 就是不可逆的误合并；
//   放这里则最坏多一次 stat 对账，APFS 上却能正确合并同一文件的两种组合式。
export function _tlFoldKey(p: string): string {
    let k = _tlPathKey(p);
    try { k = k.normalize('NFC'); } catch (_) { }
    try { return k.toLowerCase(); } catch (_) { return k; }
}

// ═══ 文件身份（只在撞名那一刻问文件系统；ino=0 → 无身份 → 不合并）═══
function _tlStatIdentity(rawPath: string): string | null {
    if (!rawPath) return null;
    try {
        const st: any = fs.statSync(rawPath, { bigint: true });
        if (!st || !st.ino || st.ino === BigInt(0)) return null;
        return String(st.dev) + ':' + String(st.ino);
    } catch (_) { return null; }
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
    const ck = _tlFoldKey(filePath);
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
    const ck = _tlFoldKey(filePath);
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
    await _tlEnqueue(dbPath + '|' + _tlFoldKey(filePath), async () => {
        const db = await _tlOpenDb(root);
        const sha = _sha256(text);
        if (!fs.existsSync(_tlBlobPath(root, sha))) _tlWriteBlob(root, sha, _gzipSync(text));
        _tlCommit(db, dbPath, root, { file_path: filePath, ts: Date.now(), blob_hash: sha, source: 'fs' });
    });
}

// ═══ 存量迁移（幂等，一次即净）：① 留底 ② 派生列按纯函数重算 ③ 旧组合并成果继承 ④ 重号重排 ═══
function _tlPreMigratePath(projectRoot: string): string {
    return path.join(_tlDir(projectRoot), 'timeline.db.pre-migrate');
}

function _tlNeedsNormUpgrade(db: any): boolean {
    try {
        const c = db.exec('SELECT COUNT(*) FROM versions WHERE norm_ver IS NULL OR norm_ver <> ' + TL_NORM_VER + " OR path_key IS NULL OR path_key = ''");
        if (c && c[0] && c[0].values && c[0].values[0] && (c[0].values[0][0] as number) > 0) return true;
    } catch (_) { }
    return false;
}

// 组内 file_seq 重排为 1..N（唯一入口；撞名归并与存量迁移共用）
export function _tlRenumberGroup(db: any, key: string): boolean {
    const ids: number[] = [];
    try {
        const q = db.prepare('SELECT id FROM versions WHERE path_key = ? ORDER BY ts ASC, id ASC');
        q.bind([key]);
        while (q.step()) ids.push(q.getAsObject().id as number);
        q.free();
    } catch (_) { return false; }
    if (ids.length === 0) return false;
    let up: any = null;
    try { up = db.prepare('UPDATE versions SET file_seq = ? WHERE id = ?'); } catch (_) { return false; }
    let ok = false;
    try {
        db.run('BEGIN');
        for (let i = 0; i < ids.length; i++) up.run([i + 1, ids[i]]);
        db.run('COMMIT');
        ok = true;
    } catch (e: any) {
        try { db.run('ROLLBACK'); } catch (_) { }
        console.warn('[timeline] seq renumber failed:', e && e.message);
    } finally { try { up.free(); } catch (_) { } }
    return ok;
}

// ═══ 组查询 / 归并（撞名对账的唯一实现）═══
function _tlGroupExists(db: any, key: string): boolean {
    try {
        const st = db.prepare('SELECT 1 AS x FROM versions WHERE path_key = ? LIMIT 1');
        st.bind([key]);
        const hit = st.step();
        st.free();
        return !!hit;
    } catch (_) { return false; }
}

function _tlGroupKeysByFold(db: any, fold: string, exclude: string): string[] {
    const out: string[] = [];
    try {
        const st = db.prepare('SELECT DISTINCT path_key FROM versions WHERE fold_key = ?');
        st.bind([fold]);
        while (st.step()) { const k = String(st.getAsObject().path_key || ''); if (k && k !== exclude) out.push(k); }
        st.free();
    } catch (_) { }
    return out;
}

// 组内最新一行的原始路径（stat 对账以它为真）
function _tlGroupRawPath(db: any, key: string): string | null {
    try {
        const st = db.prepare("SELECT COALESCE(NULLIF(path_raw, ''), file_path) AS r FROM versions WHERE path_key = ? ORDER BY ts DESC, id DESC LIMIT 1");
        st.bind([key]);
        let out: string | null = null;
        if (st.step()) out = String(st.getAsObject().r || '');
        st.free();
        return out || null;
    } catch (_) { return null; }
}

// 把 fromKeys 的全部历史归并到 toKey（显示路径/原始路径统一为本次的），并重排序号
function _tlMergeGroups(db: any, dbPath: string, fromKeys: string[], toKey: string, display: string, raw: string): boolean {
    if (!fromKeys.length) return false;
    let ok = false;
    let up: any = null;
    try {
        db.run('BEGIN');
        up = db.prepare('UPDATE versions SET path_key = ?, file_path = ?, path_raw = ? WHERE path_key = ?');
        for (const fk of fromKeys) up.run([toKey, display, raw, fk]);
        up.run([toKey, display, raw, toKey]);
        db.run('COMMIT');
        ok = true;
    } catch (e: any) {
        try { db.run('ROLLBACK'); } catch (_) { }
        console.warn('[timeline] merge groups failed:', e && e.message);
    } finally { try { if (up) up.free(); } catch (_) { } }
    if (ok) {
        _tlRenumberGroup(db, toKey);
        for (const fk of fromKeys) _tlLastByKey.delete(dbPath + '|' + fk);
        _tlLastByKey.delete(dbPath + '|' + toKey);
    }
    return ok;
}

// ═══ 写入侧键裁决（唯一会问文件系统的地方，且只在撞名那一刻）═══
export function _tlResolveWriteKey(db: any, dbPath: string, filePath: string): { key: string; display: string; raw: string; merged: boolean } {
    const raw = _tlPathRaw(filePath);
    const display = _tlNormDisplayPath(filePath);
    const key = _tlPathKey(filePath);
    if (_tlGroupExists(db, key)) return { key, display, raw, merged: false };   // 快路径：同键已有历史，零 IO
    const sibs = _tlGroupKeysByFold(db, _tlFoldKey(filePath), key);
    if (sibs.length === 0) return { key, display, raw, merged: false };         // 真新文件
    const mine = _tlStatIdentity(raw);
    if (!mine) return { key, display, raw, merged: false };                     // 无证据 → 分裂（下次写入可自愈）
    const same: string[] = [];
    for (const s of sibs) {
        const sraw = _tlGroupRawPath(db, s);
        if (sraw && _tlStatIdentity(sraw) === mine) same.push(s);
    }
    if (same.length === 0) return { key, display, raw, merged: false };         // 折叠撞名但 inode 不同 = 两个真文件
    const ok = _tlMergeGroups(db, dbPath, same, key, display, raw);
    if (ok) console.log('[timeline] merged sibling groups → ' + key);
    return { key, display, raw, merged: ok };
}

// ═══ 查询侧键裁决（可返回多个键；无证据只认本键，绝不自作主张外扩）═══
export function _tlReadKeys(db: any, filePath: string): string[] {
    const key = _tlPathKey(filePath);
    if (_tlGroupExists(db, key)) return [key];                          // 快路径：零 IO
    const cands = _tlGroupKeysByFold(db, _tlFoldKey(filePath), '');
    if (cands.length === 0) return [key];
    const mine = _tlStatIdentity(_tlPathRaw(filePath));
    if (!mine) return [key];
    const keep: string[] = [];
    for (const c of cands) {
        const cw = _tlGroupRawPath(db, c);
        if (cw && _tlStatIdentity(cw) === mine) keep.push(c);
    }
    return keep.length ? keep : [key];
}

// ═══ 廉价序号修复（每次开库都跑，与全量迁移无关）═══
//   重号重排（历史被拆成两段后归并的结果）+ 空序号补齐。只看序号、不重算路径、不 stat 任何文件。
export function _tlRepairSeqs(db: any): boolean {
    let changed = false;
    try {
        const groups: string[] = [];
        const g = db.prepare('SELECT path_key FROM versions GROUP BY path_key HAVING COUNT(file_seq) > COUNT(DISTINCT file_seq)');
        while (g.step()) groups.push(String(g.getAsObject().path_key || ''));
        g.free();
        for (const k of groups) { if (_tlRenumberGroup(db, k)) changed = true; }
        if (groups.length > 0) console.log('[timeline] seq renumbered groups: ' + groups.length);
    } catch (_) { }
    try {
        const groups: string[] = [];
        const g = db.prepare('SELECT DISTINCT path_key FROM versions WHERE file_seq IS NULL');
        while (g.step()) groups.push(String(g.getAsObject().path_key || ''));
        g.free();
        for (const k of groups) { if (_tlRenumberGroup(db, k)) changed = true; }
    } catch (_) { }
    return changed;
}

function _tlMigratePaths(db: any, projectRoot: string): boolean {
    const dbPath = _tlDbPath(projectRoot);

    // ── 旧分组快照（old path_key → file_path → 最近 ts）：无 stat 证据时继承旧合并结论，不回归 ──
    const oldGroups = new Map<string, Map<string, number>>();
    try {
        const d = db.prepare('SELECT path_key, file_path, MAX(ts) AS mts FROM versions GROUP BY path_key, file_path');
        while (d.step()) {
            const r = d.getAsObject();
            const ok = String(r.path_key || '');
            const fp = String(r.file_path || '');
            if (!ok || !fp) continue;
            let m = oldGroups.get(ok);
            if (!m) { m = new Map(); oldGroups.set(ok, m); }
            m.set(fp, Number(r.mts) || 0);
        }
        d.free();
    } catch (e: any) {
        console.warn('[timeline] migrate: snapshot old groups failed:', e && e.message);
    }

    // ── 派生列按纯函数重算（按 file_path 逐条：distinct path 比行数少 3~4 倍）──
    let changed = false;
    try {
        const paths: string[] = [];
        const d = db.prepare('SELECT DISTINCT file_path FROM versions');
        while (d.step()) paths.push(String(d.getAsObject().file_path || ''));
        d.free();
        let up: any = null;
        try {
            db.run('BEGIN');
            up = db.prepare('UPDATE versions SET file_path = ?, path_raw = ?, path_key = ?, fold_key = ?, norm_ver = ? WHERE file_path = ?');
            for (const fp of paths) {
                if (!fp) continue;
                up.run([_tlNormDisplayPath(fp), fp, _tlPathKey(fp), _tlFoldKey(fp), TL_NORM_VER, fp]);
            }
            db.run('COMMIT');
            changed = true;
            console.log('[timeline] path keys recomputed (norm v' + TL_NORM_VER + '): ' + paths.length + ' distinct paths');
        } catch (e: any) {
            try { db.run('ROLLBACK'); } catch (_) { }
            console.warn('[timeline] migrate: recompute failed:', e && e.message);
            return false;
        } finally { try { if (up) up.free(); } catch (_) { } }
    } catch (e: any) {
        console.warn('[timeline] migrate: list paths failed:', e && e.message);
        return false;
    }

    // ── 旧组合并成果：重算后裂开的组——有证据证明同一文件则归并，证明不同则保持裂（纠正旧误合并）──
    let mergedGroups = 0;
    for (const [, paths] of oldGroups) {
        const newKeys = new Set<string>();
        for (const fp of paths.keys()) newKeys.add(_tlPathKey(fp));
        if (newKeys.size <= 1) continue;
        const ids = new Map<string, string>();        // newKey → 文件身份
        for (const fp of paths.keys()) {
            const id = _tlStatIdentity(fp);
            if (id) ids.set(_tlPathKey(fp), id);
        }
        let toKey: string | null = null;
        if (ids.size === 0 || new Set(ids.values()).size === 1) {
            // 全部能证明是同一文件，或完全无证据 → 沿用旧合并结论；统一到组内最新写法
            let best = ''; let bestTs = -1;
            for (const [fp, ts] of paths) { if (ts > bestTs) { bestTs = ts; best = fp; } }
            if (best) toKey = _tlPathKey(best);
        }
        if (!toKey) continue;                          // 两个以上不同身份 = 真的是不同文件 → 保持分裂
        const from = Array.from(newKeys).filter((k) => k !== toKey);
        if (from.length === 0) continue;
        if (_tlMergeGroups(db, dbPath, from, toKey, _tlNormDisplayPath(toKey), toKey)) mergedGroups++;
    }
    if (mergedGroups > 0) console.log('[timeline] old groups re-merged: ' + mergedGroups);

    if (_tlRepairSeqs(db)) changed = true;

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
            'INSERT INTO versions (file_path, path_key, path_raw, fold_key, norm_ver, file_seq, ts, blob_hash, source, floor_id, added_lines, deleted_lines) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
        );
        for (const line of lines) {
            try {
                const row = JSON.parse(line);
                var raw = String(row.r || row.p || '');
                var fp = _tlNormDisplayPath(raw);
                // 归并后的键必须从 WAL 带回来（不能拿 p 重算——重算会把已归并的组又撕开）
                var pk = String(row.k || _tlPathKey(raw));
                var seq = (seqMap.get(pk) || 0) + 1;
                seqMap.set(pk, seq);
                stmt.run([fp, pk, raw, _tlFoldKey(pk), TL_NORM_VER, seq, row.t || 0, row.h || '', row.s || 'q', row.f || null, row.a || null, row.d || null]);
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
            file_seq INTEGER, path_key TEXT, path_raw TEXT, fold_key TEXT, norm_ver INTEGER
        )`);
        try { db.run('ALTER TABLE versions ADD COLUMN file_seq INTEGER'); } catch (_) { }
        try { db.run('ALTER TABLE versions ADD COLUMN added_lines INTEGER'); } catch (_) { }
        try { db.run('ALTER TABLE versions ADD COLUMN deleted_lines INTEGER'); } catch (_) { }
        try { db.run('ALTER TABLE versions ADD COLUMN path_key TEXT'); } catch (_) { }
        try { db.run('ALTER TABLE versions ADD COLUMN path_raw TEXT'); } catch (_) { }
        try { db.run('ALTER TABLE versions ADD COLUMN fold_key TEXT'); } catch (_) { }
        try { db.run('ALTER TABLE versions ADD COLUMN norm_ver INTEGER'); } catch (_) { }
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_path_ts ON versions(file_path, ts)');
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_path_seq ON versions(file_path, file_seq)');
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_key_ts ON versions(path_key, ts)');
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_key_seq ON versions(path_key, file_seq)');
        db.run('CREATE INDEX IF NOT EXISTS idx_versions_fold ON versions(fold_key)');
        db.run('PRAGMA journal_mode=DELETE');
        db.run('PRAGMA synchronous=FULL');
        db.run('PRAGMA busy_timeout=30000');

        // 3. 迁移前一次性留底 timeline.db.pre-migrate（迁移写坏时唯一的回滚通道；只在需要迁移时拷）
        const needNorm = _tlNeedsNormUpgrade(db);
        if (needNorm) {
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

        // 4. 回放 .wal（最多 99 行，上次压缩后未压缩的）——必须先于迁移：
        //    WAL 里的 path_key 是上次写入时的裁决结果，没回到库里时迁移看不到这些行；
        //    反过来（先迁移后回放）迁移刚归并的组会被回放按旧键重新撞开，且此后快路径永不再自愈。
        const replayed = _tlReplayWal(db, projectRoot);
        if (replayed > 0) {
            console.log('[timeline] replayed ' + replayed + ' wal entries');
        }

        // 5. 派生列：norm_ver 驱动的一次性全量重算（33k 行 ≈ 2s）；已迁移的库只做廉价序号修复——
        //    写入口兜底捕获一碰就会开库，每次开库都跑全量重算 = 首次保存卡两秒。
        const migrated = needNorm ? _tlMigratePaths(db, projectRoot) : _tlRepairSeqs(db);

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
    path_raw?: string | null;
}

export function _tlRecord(db: any, dbPath: string, projectRoot: string, row: TlRowIn, resolvedKey?: string): void {
    // ★ 显示路径在写入口就地归一（不变式：file_path 恒为显示形态）——否则快路径落库的是调用方原样
    //   （win32 上 `\\` 形态），同一文件在库里长出两种显示写法，界面/记忆库看到的是随机一种
    const display = _tlNormDisplayPath(row.file_path);
    const pathKey = resolvedKey || _tlPathKey(display);
    const rawPath = _tlPathRaw(row.path_raw || row.file_path);
    // ★ 计算 per-file 自增序号（AI 和人类用序号指代快照，如 #23）
    const fileSeq = _tlNextSeq(db, pathKey);

    // 内存 INSERT
    db.run(
        'INSERT INTO versions (file_path, path_key, path_raw, fold_key, norm_ver, file_seq, ts, blob_hash, source, floor_id, added_lines, deleted_lines) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [display, pathKey, rawPath, _tlFoldKey(pathKey), TL_NORM_VER, fileSeq, row.ts, row.blob_hash, row.source, row.floor_id || null, row.added_lines ?? null, row.deleted_lines ?? null]
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
    //   k = 裁决后的 path_key（归并过的组回放时必须原样恢复，不能拿 p 重算）· r = 原始路径
    const walLine = JSON.stringify({
        p: display, k: pathKey, r: rawPath, q: fileSeq, t: row.ts, h: row.blob_hash, s: row.source,
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
    let key = _tlPathKey(row.file_path);
    let last = _tlLastRow(db, dbPath, key);
    // 本键无历史 → 撞名对账（唯一会问文件系统的地方；同键有历史时零 IO）
    if (!last) {
        const res = _tlResolveWriteKey(db, dbPath, row.file_path);
        key = res.key;
        row = { ...row, file_path: res.display, path_raw: res.raw };
        // ★ 归并是「库里 UPDATE」而不是「追加一行」——WAL 记不到它。不立即落盘就会出现：
        //   刚归并的历史在下次启动被旧 WAL 行按旧键重新撞开（且此后快路径永不再自愈）。
        //   归并极罕见（只有历史真裂过才发生），所以这一次全量落盘代价可忽。
        if (res.merged) { try { _tlCompactSync(db, dbPath, projectRoot, true); } catch (_) { } }
        last = _tlLastRow(db, dbPath, key);
    }
    const ck = dbPath + '|' + key;

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

    _tlRecord(db, dbPath, projectRoot, row, key);
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
function _tlCompactSync(db: any, dbPath: string, projectRoot: string, force?: boolean): void {
    const walPath = _tlWalPath(projectRoot);
    const tmpDir = _tlTmpDir(projectRoot);
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) { }

    // 空 .wal 无需压缩（force = 库内做过不产生 WAL 的变更，如撞名归并，必须无条件落盘）
    let walSize = 0;
    try { walSize = fs.statSync(walPath).size; } catch (_) { }
    if (walSize === 0 && !force) return;

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
