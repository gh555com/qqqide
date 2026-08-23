// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// state-sqlite.ts — SQLite-backed 唯一真理持久化机器 (optimized)
// Replaces state-store.ts (837 lines hand-rolled FS) with ~550 lines of SQLite.
//
// Zero breaking API changes vs state-store.ts:
//   - Same constructor signature: new StateStore(userDataDir)
//   - Same public methods: register/get/set/setNow/append/del/list/flush/flushSync/stats
//   - Same EventEmitter: 'changed' event
//   - Same cloud hooks: onCloudDirty, listOutbox, dropOutbox, markSyncedAt
//
// ★ 三大优化：
//   1. batched _saveDb — 多个 key 写入合并为一次 db.export()（50ms 窗口）
//   2. flush() 修复 — 先触发所有 pending debounce 写入，再导出
//   3. 内存读缓存 — get()/append() 命中缓存跳过 SQL 查询
//
// sql.js async WASM init is lazy: first call to any method triggers it.
// After init, all DB operations are synchronous (sql.js runs in-process).
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// sql.js is external (not bundled by esbuild) — loaded from node_modules at runtime.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require('sql.js');

// ---------------------------------------------------------------------------
// Public types (identical to state-store.ts)
// ---------------------------------------------------------------------------

export type StateForm = 'doc' | 'blob' | 'log';

export interface SchemaMigrator {
    from: number;
    to: number;
    run: (old: any) => any;
}

export type Merger = (local: any, remote: any, ctx?: { ns: string; key: string }) => any;

export interface NsSchema {
    v: number;
    form: StateForm;
    quotaBytes?: number;
    merger?: Merger;
    migrators?: SchemaMigrator[];
    cloud?: boolean;
    debounceMs?: number;
    compactThresholdBytes?: number;
}

export interface StatsSnapshot {
    dirtyKeys: number;
    queuedOutbox: number;
    lastSyncAt?: number;
    namespaces: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// StateStore (SQLite-backed, optimized)
// ---------------------------------------------------------------------------

export class StateStore extends EventEmitter {
    private _db: any = null;            // sql.js Database (null until WASM loaded)
    private _SQL: any = null;           // sql.js module
    private _ready: Promise<void> | null = null;
    private _readyOk = false;

    private dbPath: string;
    private outboxDir: string;
    private deviceId: string;
    private outboxSeq = 0;
    private lastSyncAt?: number;

    private schemas: Map<string, NsSchema> = new Map();

    // debounce timers (key = ns\u0000key)
    private _debouncers: Map<string, NodeJS.Timeout> = new Map();
    // ★ pending 写入值 (key = ns\u0000key) — flush/flushSync/setNow 时重放, 绝不丢弃 (2026-08-09 修复)
    private _pendingWrites: Map<string, { ns: string; key: string; sc: NsSchema; value: any }> = new Map();
    // dirty tracking for stats
    private _dirtySet: Set<string> = new Set();
    // ★ batched DB export (avoids per-key db.export() → one export per ~50ms window)
    private _saveDbPending = false;
    private _saveDbTimer: NodeJS.Timeout | null = null;
    // ★ 项目级库磁盘合并签名（2026-08-09 F3: 防跨进程/跨实例整库互踩）
    //   仅 dbPath 构造的 project store 启用（global 单实例无竞争）
    private _enableDiskMerge = false;
    private _mergeSig = '';
    // ★ .prev 轮换备份（2026-08-09 F3: 损坏恢复链 主 → .prev → .bak → 空库）
    private _prevEnabled = false;
    // ★ in-memory read cache (avoids append() re-reading from DB each time)
    private _memCache: Map<string, any> = new Map();
    // ★ 全局数据库标记：用于阻止 quest 相关 namespace 误写入全局 global.sq3
    private _isGlobal: boolean = false;

    /** Hook for state-cloud.ts */
    public onCloudDirty: ((ns: string, key: string) => void) | null = null;

    // ----- constructor --------------------------------------------------------

    /**
     * @param userDataDir  Electron userData path (for global Data/alphal/global.sq3).
     *                      When dbPath is provided, userDataDir is only used for deviceId fallback.
     * @param dbPath       Optional explicit SQLite file path. When set, the DB is created
     *                      at this exact path (e.g. project-level quest.sq3).
     */
    constructor(userDataDir: string, dbPath?: string) {
        super();
        this.setMaxListeners(0);
        if (dbPath) {
            // Project-level: db at exact path, outbox alongside it
            const dbDir = path.dirname(dbPath);
            try { fs.mkdirSync(dbDir, { recursive: true }); } catch { /* ignore */ }
            this.dbPath = dbPath;
            this.outboxDir = path.join(dbDir, 'outbox');
            this._isGlobal = false;
            // ★ 项目级库（only.sq3/quest.sq3）启用磁盘合并 + .prev 轮换：
            //   多窗口/多实例（dev+绿色包同跑）并发写同一文件时防整库覆盖丢失
            this._enableDiskMerge = true;
            this._prevEnabled = true;
        } else {
            // Global: db in userData/alphal/ (global.sq3 + backups/outbox)
            const alphalDir = path.join(userDataDir, 'alphal');
            try { fs.mkdirSync(alphalDir, { recursive: true }); } catch { /* ignore */ }
            this.dbPath = path.join(alphalDir, 'global.sq3');
            this.outboxDir = path.join(alphalDir, 'outbox');
            this._isGlobal = true;
        }
        try { fs.mkdirSync(this.outboxDir, { recursive: true }); } catch { /* ignore */ }
        this.deviceId = this._loadOrCreateDeviceId(path.dirname(this.outboxDir));
        this._restoreOutboxSeq();
        console.log('[state-sqlite] db=', this.dbPath, 'device=', this.deviceId);
    }

    // ----- init (lazy, triggered on first use) --------------------------------

    private _init(): Promise<void> {
        if (this._ready) return this._ready;
        this._ready = this._doInit();
        return this._ready;
    }

    private async _doInit(): Promise<void> {
        try {
            this._SQL = await initSqlJs();
            // Load or create DB
            if (fs.existsSync(this.dbPath)) {
                try {
                    const buf = fs.readFileSync(this.dbPath);
                    this._db = new this._SQL.Database(buf);
                } catch (e) {
                    console.warn('[state-sqlite]failed to load global.sq33, starting fresh:', e);
                    // Quarantine corrupt DB
                    const bak = this.dbPath + '.corrupt.' + Date.now();
                    try { fs.renameSync(this.dbPath, bak); } catch { /* ignore */ }
                    // ★ 恢复链：.prev（轮换备份）→ .bak（旧格式）→ 空库（2026-08-09 F3）
                    if (!this._tryRestoreBackup()) {
                        this._db = new this._SQL.Database();
                    }
                }
            } else {
                // ★ 文件不存在 → 尝试 .prev/.bak 恢复（可能是上次腐败隔离后还没来得及写新数据）
                if (!this._tryRestoreBackup()) {
                    this._db = new this._SQL.Database();
                }
            }

            // ★ 清理残留 .tmp 文件（原子写入失败/进程崩溃的遗孤）
            this._cleanStaleTmp();

            // ★ 初始化 schema — 若已加载的 DB 内部页损坏（"disk image is malformed"），
            //    构造函数可能不报错但首次 SQL 执行才暴露 → 隔离旧文件 + 空库重试
            try {
                this._initSchema();
            } catch (sqlError) {
                console.warn('[state-sqlite] schema init failed (internal corruption?), quarantine & start fresh:', sqlError);
                const bak = this.dbPath + '.corrupt.' + Date.now();
                try { fs.renameSync(this.dbPath, bak); } catch { /* ignore */ }
                this._db = new this._SQL.Database();
                // Retry on fresh DB
                this._initSchema();
            }

            this._readyOk = true;
            console.log('[state-sqlite] ready, schemas:', this.schemas.size);
        } catch (e) {
            console.error('[state-sqlite] init FAILED:', e);
            // ★ 失败后重置 ready，允下次调用重试（否则 this._ready 永久 reject）
            this._ready = null;
            throw e;
        }
    }

    private _ensureReady(): Promise<void> {
        return this._init();
    }

    private _assertReady(): void {
        if (!this._readyOk || !this._db) {
            this._init().catch(() => { });
        }
    }

    /** Create/reset schema on current DB instance */
    private _initSchema(): void {
        this._db.run(`CREATE TABLE IF NOT EXISTS state (
            ns TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT,
            meta TEXT,
            updated_at INTEGER DEFAULT 0,
            PRIMARY KEY (ns, key)
        )`);
        this._db.run('CREATE INDEX IF NOT EXISTS idx_state_ns ON state(ns)');
        this._db.run('PRAGMA journal_mode=DELETE');
        this._db.run('PRAGMA synchronous=FULL');
        this._db.run('PRAGMA busy_timeout=30000');
        // Load persisted schemas from registry table
        this._loadSchemas();
    }

    // ★ 启动时恢复/清理残留 .tmp 文件（进程崩溃遗孤 → 恢复而非丢弃）
    private _cleanStaleTmp(): void {
        const dir = path.dirname(this.dbPath);
        const mainDb = this.dbPath;
        const mainExists = fs.existsSync(mainDb);
        const mainMtime = mainExists ? fs.statSync(mainDb).mtimeMs : 0;
        try {
            const files = fs.readdirSync(dir);
            const prefix = path.basename(mainDb);
            for (const f of files) {
                if (!f.includes('.tmp.')) continue;
                if (!f.startsWith(prefix)) continue;  // 只处理同名 db 的 tmp
                const fullPath = path.join(dir, f);
                const tmpMtime = fs.statSync(fullPath).mtimeMs;
                if (!mainExists || tmpMtime > mainMtime) {
                    // tmp 比主 db 新（或主 db 不存在）→ 恢复！
                    console.log('[state-sqlite] recovering from tmp:', fullPath, '→', mainDb);
                    try { fs.renameSync(fullPath, mainDb); } catch {
                        // rename 失败（跨设备？）→ 拷贝
                        try { fs.copyFileSync(fullPath, mainDb); fs.unlinkSync(fullPath); } catch { /* ignore */ }
                    }
                } else {
                    // 主 db 更新或等新 → tmp 是垃圾
                    try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
        // outbox tmp 恢复
        try {
            const outboxFiles = fs.readdirSync(this.outboxDir);
            for (const f of outboxFiles) {
                if (!f.includes('.tmp.')) continue;
                const fullPath = path.join(this.outboxDir, f);
                // 目标文件名 = 去掉 .tmp.{timestamp}
                const targetName = f.replace(/\.tmp\.\d+$/, '');
                const targetPath = path.join(this.outboxDir, targetName);
                if (!fs.existsSync(targetPath)) {
                    try { fs.renameSync(fullPath, targetPath); } catch { /* ignore */ }
                } else {
                    try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
    }

    // ----- device id ----------------------------------------------------------

    private _loadOrCreateDeviceId(stateDir: string): string {
        const f = path.join(stateDir, 'device.id');
        try {
            if (fs.existsSync(f)) {
                const s = fs.readFileSync(f, 'utf8').trim();
                if (s && s.length >= 8) return s;
            }
        } catch { /* ignore */ }
        const id = 'dev_' + crypto.randomBytes(8).toString('hex');
        try { fs.writeFileSync(f, id, 'utf8'); } catch { /* ignore */ }
        return id;
    }

    private _restoreOutboxSeq(): void {
        try {
            const files = fs.readdirSync(this.outboxDir);
            for (const f of files) {
                const m = f.match(/^(\d+)\.json$/);
                if (m) {
                    const n = parseInt(m[1], 10);
                    if (n > this.outboxSeq) this.outboxSeq = n;
                }
            }
        } catch { /* ignore */ }
    }


    // ----- sql.js helpers (compatible with all versions) --------------------

    /** Execute SELECT via step()+getAsObject(), compatible with sql.js >=1.4 */
    private _stmtAll(sql: string, params?: any[]): any[] {
        if (!this._db) return [];
        const stmt = this._db.prepare(sql);
        try {
            if (params && params.length) { stmt.bind(params); }
            const rows: any[] = [];
            while (stmt.step()) {
                rows.push(stmt.getAsObject());
            }
            return rows;
        } finally {
            stmt.free();
        }
    }

    /** Get single row via step()+getAsObject(), compatible with sql.js >=1.4 */
    private _stmtGet(sql: string, params: any[]): any | null {
        if (!this._db) return null;
        try {
            const stmt = this._db.prepare(sql);
            try {
                stmt.bind(params);
                if (stmt.step()) {
                    return stmt.getAsObject();
                }
                return null;
            } finally {
                stmt.free();
            }
        } catch (e: any) {
            if (e && e.message && /disk image is malformed/i.test(e.message)) {
                console.warn('[state-sqlite] ⚠ runtime corruption detected in _stmtGet — quarantining & rebuilding');
                this._quarantineAndRebuild();
            }
            throw e;
        }
    }

    /** Run DML via step()+getRowsModified(), compatible with sql.js >=1.4 */
    private _stmtRun(sql: string, params: any[]): { changes: number } {
        if (!this._db) return { changes: 0 };
        try {
            const stmt = this._db.prepare(sql);
            try {
                stmt.bind(params);
                stmt.step();
                return { changes: this._db.getRowsModified() };
            } finally {
                stmt.free();
            }
        } catch (e: any) {
            if (e && e.message && /disk image is malformed/i.test(e.message)) {
                console.warn('[state-sqlite] ⚠ runtime corruption detected in _stmtRun — quarantining & rebuilding');
                this._quarantineAndRebuild();
            }
            throw e;
        }
    }

    /** ★ 运行时腐败隔离： rename 坏库 → .prev 恢复或空库 → 重建 schema → 标记脏数据全部重写 */
    private _quarantineAndRebuild(): void {
        try {
            // 1. 隔离坏库
            const bak = this.dbPath + '.corrupt.' + Date.now();
            try { fs.renameSync(this.dbPath, bak); } catch { /* ignore */ }
            // 2. 优先从 .prev/.bak 恢复（2026-08-09 F3：防隔离即全丢），失败才建空库
            if (!this._tryRestoreBackup()) {
                this._db = new this._SQL.Database();
            }
            // 3. 重建 schema（从 registry 恢复所有 namespace）
            this._initSchema();
            // 4. 清除缓存 + 标记所有脏 key（触发下次 save 全部重写）
            this._memCache.clear();
            // 将所有已注册 namespace 的数据标记为脏（保证下次 save 写入空值）
            for (const [id] of this._debouncers) {
                this._dirtySet.add(id);
            }
            console.warn('[state-sqlite] ⚠ quarantined corrupt db → ' + bak + ', fresh db ready (data loss may have occurred)');
        } catch (e2) {
            console.error('[state-sqlite] CRITICAL: quarantine failed:', e2);
        }
    }

    /** ★ 验证导出的 SQLite 数据是否有效：打开 → SELECT 1 → true/false */
    private _tryValidateDb(data: Uint8Array): boolean {
        try {
            const testDb = new this._SQL.Database(data);
            try {
                testDb.exec('SELECT 1');
                return true;
            } finally {
                testDb.close();
            }
        } catch {
            return false;
        }
    }

    /** ★ 恢复链：.prev（最新轮换备份）→ .bak.{ts}（旧格式）→ 失败。成功返回 true。 */
    private _tryRestoreBackup(): boolean {
        try {
            const dir = path.dirname(this.dbPath);
            const base = path.basename(this.dbPath);
            // 1. .prev 轮换备份（每次落盘前 copy，最新完好版）
            const prevPath = path.join(dir, base + '.prev');
            if (fs.existsSync(prevPath)) {
                try {
                    const buf = fs.readFileSync(prevPath);
                    this._db = new this._SQL.Database(buf);
                    this._db.exec('SELECT 1'); // 验证可读
                    console.warn('[state-sqlite] ⚠ restored from .prev: ' + prevPath);
                    return true;
                } catch { /* .prev 也坏 → 继续 */ }
            }
            // 2. 旧格式 .bak.{ts}（历史遗留）
            const bakFiles = fs.readdirSync(dir)
                .filter((f: string) => f.startsWith(base + '.bak.'))
                .sort()
                .reverse();
            for (const bakFile of bakFiles) {
                const bakPath = path.join(dir, bakFile);
                try {
                    const buf = fs.readFileSync(bakPath);
                    this._db = new this._SQL.Database(buf);
                    // 验证可读
                    this._db.exec('SELECT 1');
                    console.warn('[state-sqlite] ⚠ restored from backup: ' + bakPath);
                    return true;
                } catch {
                    // 该 bak 也坏了，继续尝试下一个
                }
            }
        } catch {
            // 目录不存在或无备份文件
        }
        return false;
    }

    // ----- schema registry ----------------------------------------------------

    private _loadSchemas(): void {
        try {
            this._db.run(`CREATE TABLE IF NOT EXISTS registry (
                ns TEXT PRIMARY KEY,
                v INTEGER NOT NULL,
                form TEXT NOT NULL,
                cloud INTEGER DEFAULT 0,
                quota_bytes INTEGER
            )`);
            const rows = this._stmtAll('SELECT * FROM registry');
            for (const r of rows) {
                this.schemas.set(r.ns, {
                    v: r.v,
                    form: r.form as StateForm,
                    cloud: !!r.cloud,
                    quotaBytes: r.quota_bytes || undefined,
                });
            }
        } catch (e) {
            console.warn('[state-sqlite] _loadSchemas failed:', e);
        }
    }

    private _persistSchema(ns: string, sc: NsSchema): void {
        if (!this._readyOk || !this._db) return;
        try {
            this._db.run(
                `INSERT OR REPLACE INTO registry (ns, v, form, cloud, quota_bytes) VALUES (?,?,?,?,?)`,
                [ns, sc.v, sc.form, sc.cloud ? 1 : 0, sc.quotaBytes || null]
            );
        } catch (e) {
            console.warn('[state-sqlite] _persistSchema failed:', e);
        }
    }

    // ----- public introspection -----------------------------------------------

    getDeviceId(): string { return this.deviceId; }
    getRootDir(): string { return path.dirname(this.dbPath); }
    getOutboxDir(): string { return this.outboxDir; }

    getRegisteredNs(): string[] { return Array.from(this.schemas.keys()); }
    getSchema(ns: string): NsSchema | undefined { return this.schemas.get(ns); }

    sql(query: string, params?: any[]): any {
        try {
            if (params && params.length) {
                if (query.trim().toUpperCase().startsWith('SELECT')) {
                    return this._stmtAll(query, params);
                }
                this._db.run(query, params);
                this._scheduleSaveDb();
                return { changes: this._db.getRowsModified() };
            }
            if (query.trim().toUpperCase().startsWith('SELECT')) {
                return this._stmtAll(query);
            }
            this._db.run(query);
            this._scheduleSaveDb();
            return { changes: this._db.getRowsModified() };
        } catch (e: any) {
            console.warn('[state-sqlite] sql error:', query, e);
            throw e;
        }
    }

    stats(): StatsSnapshot {
        let outbox = 0;
        try { outbox = fs.readdirSync(this.outboxDir).filter(f => f.endsWith('.json')).length; } catch { /* ignore */ }
        return {
            dirtyKeys: this._dirtySet.size,
            queuedOutbox: outbox,
            lastSyncAt: this.lastSyncAt,
            namespaces: this.schemas.size,
        };
    }

    markSyncedAt(t: number): void { this.lastSyncAt = t; }

    // ----- registration -------------------------------------------------------

    register(ns: string, schema: NsSchema): void {
        if (!ns || typeof ns !== 'string') throw new Error('state.register: bad ns');
        if (!schema || !schema.form || !['doc', 'blob', 'log'].includes(schema.form)) {
            throw new Error('state.register: bad schema.form, must be doc/blob/log');
        }
        if (typeof schema.v !== 'number' || schema.v < 1) {
            throw new Error('state.register: schema.v must be >=1');
        }

        // 🔴 铁律：全局 state.sq3 禁止注册 quest/AI 相关 namespace
        // quest 数据仅允许存在于项目级 quest.sq3/only.sq3
        if (this._isGlobal) {
            const FORBIDDEN_NS = ['qqq.ai', 'qqq.only', 'qqq.quest'];
            if (FORBIDDEN_NS.includes(ns) || ns.startsWith('qqq.ai.') || ns.startsWith('qqq.quest.')) {
                throw new Error(
                    `state.register: ns "${ns}" is FORBIDDEN in global global.sq3. ` +
                    `Quest/AI data MUST use project-level SQLite (quest.sq3/only.sq3). ` +
                    `Refusing to register.`
                );
            }
        }

        const existing = this.schemas.get(ns);
        if (existing) {
            if (existing.form !== schema.form) {
                throw new Error(`state.register: ns "${ns}" form mismatch (existing=${existing.form}, new=${schema.form})`);
            }
            // Already registered with matching form — no-op (avoid IPC noise & redundant DB write)
            return;
        }
        this.schemas.set(ns, schema);
        this._persistSchema(ns, schema);
        console.log('[state-sqlite] register ns=', ns, 'v=', schema.v, 'form=', schema.form, 'cloud=', !!schema.cloud);
    }

    // ----- encode / decode ----------------------------------------------------

    private _encode(form: StateForm, value: any): string {
        if (form === 'doc') {
            return JSON.stringify(value);
        }
        if (form === 'blob') {
            return JSON.stringify(value);
        }
        // log: value is array of events → JSON array
        if (!Array.isArray(value)) value = [];
        return JSON.stringify(value);
    }

    private _decode(form: StateForm, raw: string): any {
        if (!raw) return form === 'log' ? [] : null;
        try {
            return JSON.parse(raw);
        } catch {
            return form === 'log' ? [] : null;
        }
    }

    // ----- public API: get / set / setNow / append / del / list ----------------

    async get(ns: string, key: string): Promise<any> {
        await this._ensureReady();
        this._requireSchema(ns);
        // ★ Check memory cache first (avoids DB query for recently written/read keys)
        const cid = ns + '\x00' + key;
        const cached = this._memCache.get(cid);
        if (cached !== undefined) return cached;
        try {
            const row = this._stmtGet('SELECT value FROM state WHERE ns=? AND key=?', [ns, key]);
            if (!row || row.value === null || row.value === undefined) {
                const sc = this.schemas.get(ns)!;
                return sc.form === 'log' ? [] : null;
            }
            const sc = this.schemas.get(ns)!;
            const val = this._decode(sc.form, row.value);
            this._memCache.set(cid, val);  // ★ cache for next read
            return val;
        } catch (e) {
            console.warn('[state-sqlite] get error', ns, key, e);
            const sc = this.schemas.get(ns);
            return (sc && sc.form === 'log') ? [] : null;
        }
    }

    async set(ns: string, key: string, value: any): Promise<void> {
        await this._ensureReady();
        const sc = this._requireSchema(ns);
        if (sc.form === 'log' && !Array.isArray(value)) {
            throw new Error(`state.set on log form requires an array; ns=${ns} key=${key}`);
        }
        this._markDirty(ns, key, sc, value);
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async setNow(ns: string, key: string, value: any): Promise<void> {
        await this._ensureReady();
        const sc = this._requireSchema(ns);
        if (sc.form === 'log' && !Array.isArray(value)) {
            throw new Error(`state.setNow on log form requires an array; ns=${ns} key=${key}`);
        }
        // ★ 先重放全部 pending debounced 写入（其他 key），再写本 key（2026-08-09 修复: 旧实现直接丢弃）
        // This ensures atomic: one export includes all pending writes + this setNow write
        this._flushPendingWrites();
        this._writeKey(ns, key, sc, value);
        this._dirtySet.delete(ns + '\x00' + key);
        // ★ setNow = immediate export, but async to not block event loop
        await this._doSaveDb();
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async append(ns: string, key: string, event: any): Promise<void> {
        await this._ensureReady();
        const sc = this._requireSchema(ns);
        if (sc.form !== 'log') throw new Error(`state.append only valid for form=log; ns=${ns}`);
        // ★ Check memory cache first (avoids DB SELECT on every append)
        const cid = ns + '\x00' + key;
        let arr = this._memCache.get(cid);
        if (arr === undefined) {
            arr = await this.get(ns, key); // first miss → DB read + caches result
        }
        if (!Array.isArray(arr)) arr = [];
        arr.push(event);
        this._memCache.set(cid, arr); // ★ update cache immediately
        this._markDirty(ns, key, sc, arr);
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async del(ns: string, key: string): Promise<boolean> {
        await this._ensureReady();
        this._requireSchema(ns);
        try {
            const id = ns + '\x00' + key;
            const t = this._debouncers.get(id);
            if (t) { clearTimeout(t); this._debouncers.delete(id); }
            this._dirtySet.delete(id);
            this._pendingWrites.delete(id); // ★ pending 一并清除
            this._memCache.delete(id); // ★ clear cache

            const info = this._stmtRun('DELETE FROM state WHERE ns=? AND key=?', [ns, key]);
            const any = info.changes > 0;
            if (any) {
                this.emit('changed', { ns, key, value: null, deleted: true });
                const sc = this.schemas.get(ns);
                if (sc && sc.cloud) { this._queueOutbox(ns, key, null, true); }
            }
            return any;
        } catch (e) {
            console.warn('[state-sqlite] del error', ns, key, e);
            return false;
        }
    }

    async list(ns: string): Promise<string[]> {
        await this._ensureReady();
        this._requireSchema(ns);
        try {
            const rows = this._stmtAll('SELECT key FROM state WHERE ns=?', [ns]);
            return rows.map((r: any) => r.key);
        } catch (e) {
            return [];
        }
    }

    // ----- internal: dirty + debounce + write ---------------------------------

    private _markDirty(ns: string, key: string, sc: NsSchema, value: any): void {
        const id = ns + '\x00' + key;
        this._dirtySet.add(id);
        // ★ 保存 pending 值 — flush/flushSync/setNow 可重放（2026-08-09 修复: 旧实现只存 timer，值在闭包，flush 时丢）
        this._pendingWrites.set(id, { ns, key, sc, value });

        // Cancel existing debounce
        const existing = this._debouncers.get(id);
        if (existing) clearTimeout(existing);

        const debounceMs = typeof sc.debounceMs === 'number' ? sc.debounceMs : DEFAULT_DEBOUNCE_MS;
        this._debouncers.set(id, setTimeout(() => {
            this._debouncers.delete(id);
            this._dirtySet.delete(id);
            this._pendingWrites.delete(id);
            try { this._writeKey(ns, key, sc, value); } catch (e) {
                console.warn('[state-sqlite] debounced write error', ns, key, e);
            }
        }, debounceMs));
    }

    /** ★ 重放全部 pending debounced 写入（取消 timer 并立即落库，防 flush/退出丢数据，2026-08-09） */
    private _flushPendingWrites(): void {
        for (const [id, pw] of this._pendingWrites) {
            const t = this._debouncers.get(id);
            if (t) { clearTimeout(t); this._debouncers.delete(id); }
            this._dirtySet.delete(id);
            this._pendingWrites.delete(id);
            try { this._writeKey(pw.ns, pw.key, pw.sc, pw.value); } catch (e) {
                console.warn('[state-sqlite] pending write replay error', pw.ns, pw.key, e);
            }
        }
    }

    private _writeKey(ns: string, key: string, sc: NsSchema, value: any): void {
        if (!this._readyOk || !this._db) return;
        try {
            const encoded = this._encode(sc.form, value);
            const meta = JSON.stringify({
                v: sc.v,
                ts: Date.now(),
                deviceId: this.deviceId,
                form: sc.form,
            });
            this._db.run(
                `INSERT OR REPLACE INTO state (ns, key, value, meta, updated_at) VALUES (?,?,?,?,?)`,
                [ns, key, encoded, meta, Date.now()]
            );
            // ★ update memory cache
            this._memCache.set(ns + '\x00' + key, value);
            // ★ batched export (50ms window) instead of per-key export
            this._scheduleSaveDb();
            if (sc.cloud) { this._queueOutbox(ns, key, value, false); }
            this.emit('changed', { ns, key, value, deleted: false });
        } catch (e) {
            console.warn('[state-sqlite] _writeKey error', ns, key, e);
        }
    }

    // ★ Schedule batched DB export (50ms window, multiple writes share one export)
    private _scheduleSaveDb(): void {
        this._saveDbPending = true;
        if (this._saveDbTimer) return; // timer already running
        this._saveDbTimer = setTimeout(() => {
            this._saveDbTimer = null;
            if (!this._saveDbPending) return;
            this._doSaveDb();
        }, 50);
    }

    // ★ async export — yields to event loop during file I/O, avoids blocking main process
    private async _doSaveDb(): Promise<void> {
        if (!this._readyOk || !this._db) return;
        this._saveDbPending = false;
        if (this._saveDbTimer) { clearTimeout(this._saveDbTimer); this._saveDbTimer = null; }
        // ★ 先重放 debounce 中的 pending 写入 → 内存 DB 即全量（2026-08-09）
        this._flushPendingWrites();
        // ★ 写前磁盘合并（仅项目级库）：另一实例已落盘的 key 补入内存，防整库互踩
        this._mergeDiskIntoMemory();
        // ★ 写前 .prev 轮换（仅项目级库）：保留上一完好版，损坏可回退
        if (this._prevEnabled) { try { await fs.promises.copyFile(this.dbPath, this.dbPath + '.prev'); } catch { /* ignore */ } }
        const tmp = this.dbPath + '.tmp.' + Date.now();
        try {
            const data = this._db.export();
            // ★ 写入前验证：export 出的数据是否有效 SQLite（防 WASM 内存腐败扩散）
            if (!this._tryValidateDb(data)) {
                console.error('[state-sqlite] CRITICAL: exported data is invalid SQLite — SKIPPING save to prevent corruption (dbPath=' + this.dbPath + ')');
                return;
            }
            const buf = Buffer.from(data);
            // 确保父目录存在（兜底：构造函数中已创建，但可能被外部删除）
            try { fs.mkdirSync(path.dirname(this.dbPath), { recursive: true }); } catch { /* ignore */ }
            await fs.promises.writeFile(tmp, buf as any);
            // 原子 rename，含重试（Windows 上可能因瞬时文件锁失败）
            await this._atomicRename(tmp, this.dbPath);
        } catch (e) {
            console.warn('[state-sqlite] _doSaveDb failed:', e);
        } finally {
            // 无论如何清理 tmp 文件，防止堆积
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
        }
    }

    /** 原子 rename，带重试和降级策略。绝不先删后改（防崩溃丢数据）。 */
    private async _atomicRename(tmp: string, dest: string): Promise<void> {
        // 第 1 次：直接 rename（Linux/macOS 原子替换；现代 Windows 也支持）
        try {
            await fs.promises.rename(tmp, dest);
            return;
        } catch (e: any) {
            // 非 EEXIST/EPERM/EACCES → 未可恢复，抛出
            if (!e || (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES')) {
                throw e;
            }
        }
        // Windows 文件锁/防病毒 → 降级为 copy+unlink（无先删后改的丢数据窗口）
        const data = await fs.promises.readFile(tmp);
        await fs.promises.writeFile(dest, data);
        // writeFile 成功后 dest 已有完整数据，安全删除 tmp
        try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
    }

    /** Synchronous flush for crash/shutdown — must not use async I/O */
    private _doSaveDbSync(): void {
        if (!this._readyOk || !this._db) return;
        this._saveDbPending = false;
        if (this._saveDbTimer) { clearTimeout(this._saveDbTimer); this._saveDbTimer = null; }
        // ★ 先重放 debounce 中的 pending 写入 → 内存 DB 即全量（2026-08-09）
        this._flushPendingWrites();
        // ★ 写前磁盘合并 + .prev 轮换（仅项目级库）
        this._mergeDiskIntoMemory();
        if (this._prevEnabled) { try { fs.copyFileSync(this.dbPath, this.dbPath + '.prev'); } catch { /* ignore */ } }
        const tmp = this.dbPath + '.tmp.' + Date.now();
        try {
            const data = this._db.export();
            // ★ 写入前验证：export 出的数据是否有效 SQLite（防 WASM 内存腐败扩散）
            if (!this._tryValidateDb(data)) {
                console.error('[state-sqlite] CRITICAL: exported data is invalid SQLite — SKIPPING save to prevent corruption (dbPath=' + this.dbPath + ')');
                return;
            }
            const buf = Buffer.from(data);
            try { fs.mkdirSync(path.dirname(this.dbPath), { recursive: true }); } catch { /* ignore */ }
            fs.writeFileSync(tmp, buf as any);
            // 原子 rename（绝不先删后改，防崩溃丢数据）
            try {
                fs.renameSync(tmp, this.dbPath);
            } catch (e: any) {
                if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
                    // 降级：copy + unlink（无先删后改的丢数据窗口）
                    const data = fs.readFileSync(tmp);
                    fs.writeFileSync(this.dbPath, data);
                    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
                } else {
                    throw e;
                }
            }
        } catch (e) {
            console.warn('[state-sqlite] _doSaveDb failed:', e);
        } finally {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        }
    }

    // ★ 写前磁盘合并（2026-08-09 F3）：另一实例/窗口已落盘的 key 补入内存 DB。
    //   只补缺（内存已有 → 跳过，LWW 保留本实例更新），绝不覆盖本实例数据。
    //   签名不变（mtime+size）则跳过，正常单实例场景零开销。
    private _mergeDiskIntoMemory(): void {
        if (!this._enableDiskMerge || !this._readyOk || !this._db) return;
        try {
            if (!fs.existsSync(this.dbPath)) return;
            const st = fs.statSync(this.dbPath);
            const sig = st.mtimeMs + ':' + st.size;
            if (sig === this._mergeSig) return;
            const buf = fs.readFileSync(this.dbPath);
            if (!buf || !buf.length) return;
            const disk = new this._SQL.Database(buf);
            try {
                disk.exec('SELECT 1'); // 验证磁盘文件可读
                const stmt = disk.prepare('SELECT ns, key, value, meta FROM state');
                try {
                    while (stmt.step()) {
                        const row = stmt.getAsObject();
                        const exists = this._stmtGet('SELECT 1 FROM state WHERE ns=? AND key=?', [row.ns, row.key]);
                        if (!exists) {
                            this._db.run(
                                'INSERT OR REPLACE INTO state (ns, key, value, meta, updated_at) VALUES (?,?,?,?,?)',
                                [row.ns, row.key, row.value, row.meta, Date.now()]
                            );
                        }
                    }
                } finally { stmt.free(); }
                this._mergeSig = sig;
            } finally { disk.close(); }
        } catch { /* 磁盘损坏/不可读 → 跳过合并，保持现状 */ }
    }

    // ----- flush --------------------------------------------------------------

    async flush(): Promise<void> {
        if (!this._readyOk || !this._db) return;
        // ★ 先重放全部 pending debounced 写入，再导出（2026-08-09 修复: 旧实现取消 timer 即丢值）
        this._flushPendingWrites();
        await this._doSaveDb();
    }

    /** Synchronous flush for crash/shutdown. */
    flushSync(): void {
        if (!this._readyOk || !this._db) return;
        // ★ 先重放全部 pending debounced 写入，再同步导出（2026-08-09 修复）
        this._flushPendingWrites();
        this._dirtySet.clear();
        this._memCache.clear();
        this._doSaveDbSync();
    }

    async flushOne(ns: string, key: string): Promise<void> {
        const id = ns + '\x00' + key;
        const t = this._debouncers.get(id);
        if (t) { clearTimeout(t); this._debouncers.delete(id); }
        this._dirtySet.delete(id);
        this._pendingWrites.delete(id);
        this._memCache.delete(id);
        await this._doSaveDb();
    }

    /** Atomically increment a counter key and return the NEW value.
     *  Zero-race: all IPC calls serialize in the main process, and SQLite
     *  operations are synchronous within that single thread. */
    async atomicIncr(ns: string, key: string): Promise<number> {
        await this._ensureReady();
        const sc = this._requireSchema(ns);
        if (sc.form !== 'doc') throw new Error(`atomicIncr only valid for form=doc; ns=${ns}`);
        // Read current value, default 0, increment, write back immediately
        let cur = 0;
        try {
            const row = this._stmtGet('SELECT value FROM state WHERE ns=? AND key=?', [ns, key]);
            if (row && row.value !== null && row.value !== undefined) {
                cur = parseInt(row.value, 10) || 0;
            }
        } catch { /* ignore */ }
        const next = cur + 1;
        // Write immediately (no debounce — counter must be durable right away)
        const encoded = this._encode(sc.form, next);
        const meta = JSON.stringify({ v: sc.v, ts: Date.now(), deviceId: this.deviceId, form: sc.form });
        this._db.run(
            `INSERT OR REPLACE INTO state (ns, key, value, meta, updated_at) VALUES (?,?,?,?,?)`,
            [ns, key, encoded, meta, Date.now()]
        );
        // Update memory cache
        this._memCache.set(ns + '\x00' + key, next);
        // Force immediate export (counter must survive crash)
        await this._doSaveDb();
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
        // Also queue outbox if cloud
        if (sc.cloud) { this._queueOutbox(ns, key, next, false); }
        this.emit('changed', { ns, key, value: next, deleted: false });
        return next;
    }

    // ----- schema helpers -----------------------------------------------------

    private _requireSchema(ns: string): NsSchema {
        const sc = this.schemas.get(ns);
        if (!sc) throw new Error(`state: ns "${ns}" not registered`);
        return sc;
    }

    // ----- outbox (cloud sync queue; state-cloud.ts drains it) ----------------

    private _queueOutbox(ns: string, key: string, value: any, deleted: boolean): void {
        let tmp = '';
        try {
            this.outboxSeq += 1;
            const seq = String(this.outboxSeq).padStart(12, '0');
            const f = path.join(this.outboxDir, seq + '.json');
            const payload = { seq, ns, key, ts: Date.now(), deleted, value: deleted ? null : value };
            tmp = f + '.tmp.' + Date.now();
            fs.writeFileSync(tmp, JSON.stringify(payload));
            try {
                fs.renameSync(tmp, f);
            } catch {
                // ★ 降级 copy+unlink，绝不先删目标文件
                try {
                    const data = fs.readFileSync(tmp);
                    fs.writeFileSync(f, data);
                } catch { /* ignore */ }
            }
        } catch (e) {
            console.warn('[state-sqlite] _queueOutbox failed:', e);
        } finally {
            // 兜底清理：rename 成功后 tmp 已不存在（unlink 静默失败）
            if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
        }
    }

    listOutbox(): { seq: string; file: string }[] {
        const out: { seq: string; file: string }[] = [];
        try {
            const files = fs.readdirSync(this.outboxDir).filter(f => f.endsWith('.json')).sort();
            for (const f of files) {
                out.push({ seq: f.replace(/\.json$/, ''), file: path.join(this.outboxDir, f) });
            }
        } catch { /* ignore */ }
        return out;
    }

    dropOutbox(seq: string): boolean {
        const f = path.join(this.outboxDir, seq + '.json');
        try { fs.unlinkSync(f); return true; } catch { return false; }
    }

    // ----- merge-on-save (delegated to schema.merger) -------------------------

    // SQLite WAL mode provides natural isolation. Multi-window merge is handled
    // at the application level (q4.js) rather than at the storage level.
    // The 'merger' property in NsSchema is still used by state-cloud.ts for
    // cloud sync merge logic.

    // ----- onChange convenience -----------------------------------------------

    onChange(ns: string, key: string, cb: (val: any, deleted: boolean) => void): () => void {
        const h = (msg: { ns: string; key: string; value: any; deleted: boolean }) => {
            if (msg.ns === ns && msg.key === key) cb(msg.value, msg.deleted);
        };
        this.on('changed', h);
        return () => { this.off('changed', h); };
    }
}
