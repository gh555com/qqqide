// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// state-sqlite.ts — SQLite-backed 唯一真理持久化机器 (optimized)
// 旧 state-store.ts（839 行 FS 手写店）已于 2026-09-27 死代码清盘删除（零 import）；本店为其零迁移替代。
//
// 与旧店的零破坏 API：
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
import { hasSqliteHeader, hasSqliteHeaderOnDisk, writeFileDurable, writeFileDurableSync } from './db-durable';

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

// ★ 关键键镜像：整库级损坏（全零文件/掉电/隔离重建）时「用户亲手产生、不可再生」的小体量数据
//   必须能回魂 → 每次写入额外落一份 JSON 快照 {dbDir}/mirror/{ns}.{key}.json；
//   启动时仅当库里该键缺失才用镜像补回（库里有值一律不动）。新增条目 = 下表加一行。
const MIRROR_KEYS: Array<{ ns: string; key: string }> = [
    { ns: 'qqq.only', key: 'ai.floorFavs' },
];



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
    // ★ outbox 去重索引（2026-09-27）：fullKey(ns/key) → 最新 seq。同键只留一条——
    //   旧 append-only + 云同步完全手动（渲染层无调用方，永不排空）→ 无界积压（实测 1858 条/10 键）
    private outboxIndex: Map<string, string> = new Map();
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
    //   2026-09-17: 全局库同样启用（实锤配置丢失事故 —— 以前只有项目库有备份，全局库丢失即全丢）
    private _prevEnabled = false;
    private _lastSaveErrLogAt = 0;
    // ★ 落盘 tmp 序号（2026-09-19）：与 pid 一起保证 tmp 名全局唯一——
    //   同毫秒并发保存曾互踩（同一 tmp 被截断/重复 rename → ENOENT、0 字节主库）
    private _saveSeq = 0;
    // ★ 落盘失败重试（2026-11-22）：锁类错误（另一实例/杀软/索引器持句柄）不再「一次失败就丢本次写」
    private _saveRetryTimer: NodeJS.Timeout | null = null;
    private _saveRetryCount = 0;
    private _pendingParked = false;
    // ★ 删除墓碑（2026-11-22）：内存删了但还没落盘时，写前磁盘合并不得把它从磁盘“救”回来
    private _deletedKeys: Set<string> = new Set();
    private _sessionSnapDone = false;
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
            // ★ 2026-09-17: 全局库启用 .prev 轮换 —— 实锤「升级后齿轮配置清空」（load 失败后
            //   隔离改名失败被静默吞掉 → 空库被后续 save 覆写，恢复链形同虚设）。
            //   全局库是单实例场景（启动器 Mutex），无需磁盘合并，只需主→.prev→.bak 恢复链。
            this._prevEnabled = true;
        }
        try { fs.mkdirSync(this.outboxDir, { recursive: true }); } catch { /* ignore */ }
        this.deviceId = this._loadOrCreateDeviceId(path.dirname(this.outboxDir));
        this._restoreOutboxSeq();
        this._compactOutbox();
        console.log('[state-sqlite] db=', this.dbPath, 'device=', this.deviceId);
    }

    // ----- 状态库事件日志（2026-09-17）------------------------------------------
    //   全局库是「配置丢失」事故的唯一现场：此前 load 失败/检疫/重建只进 console，
    //   生产环境无处可查（boot.log 不收录主进程 console）→ 事故零痕迹。
    //   持久化生命周期事件（每启动 ≥1 行，异常附详情），供事后取证。
    private _stateLog(message: string): void {
        try {
            const f = path.join(path.dirname(this.dbPath), 'state-events.log');
            try {
                const st = fs.statSync(f);
                if (st.size > 256 * 1024) {
                    try { fs.renameSync(f, f + '.old'); } catch { try { fs.unlinkSync(f); } catch { /* ignore */ } }
                }
            } catch { /* 文件不存在 */ }
            fs.appendFileSync(f, new Date().toISOString() + ' | ' + message + '\n', 'utf8');
        } catch { /* 日志失败绝不影响主流程 */ }
    }

    /** ★ 隔离旧库文件（带兜底）——rename 失败绝不静默（旧实现吞错 → 旧库被后续 save 覆写、零痕迹） */
    private _salvageOldFile(reason: string): void {
        try {
            if (!fs.existsSync(this.dbPath)) { this._stateLog('salvage skip (no file) reason=' + reason); return; }
            const target = this.dbPath + '.corrupt.' + Date.now();
            try {
                fs.renameSync(this.dbPath, target);
                this._stateLog('salvage ok (rename) reason=' + reason + ' -> ' + path.basename(target));
                return;
            } catch { /* 被占用/杀软锁 → 降级副本保现场 */ }
            try {
                fs.copyFileSync(this.dbPath, target);
                this._stateLog('salvage ok (copy) reason=' + reason + ' -> ' + path.basename(target));
            } catch (e2: any) {
                this._stateLog('salvage FAILED (rename+copy) reason=' + reason + ' err=' + String(e2 && e2.message));
            }
        } catch (e: any) {
            this._stateLog('salvage ex reason=' + reason + ' err=' + String(e && e.message));
        }
    }

    /** ★ 上一条同库 boot 行的 rows（取证用；取不到返回 -1） */
    private _prevBootRows(dbBase: string): number {
        try {
            const f = path.join(path.dirname(this.dbPath), 'state-events.log');
            const lines = fs.readFileSync(f, 'utf8').split('\n');
            let last = -1;
            for (const ln of lines) {
                if (ln.indexOf('boot ok rows=') < 0) continue;
                if (ln.indexOf('db=' + dbBase + ' ') < 0) continue;
                const m = ln.match(/boot ok rows=(\d+)/);
                if (m) last = parseInt(m[1], 10);
            }
            return last;
        } catch { return -1; }
    }

    /** ★ 启动世代快照 {db}.good.{ts}（最多留 2 份）——.prev 只覆盖上一版，挡不住多次连续的坏写 */
    private _snapshotBoot(): void {
        try {
            const cnt = ((this._stmtGet('SELECT COUNT(*) AS c FROM state', []) as any) || {}).c || 0;
            if (!cnt) return;
            const dir = path.dirname(this.dbPath);
            const base = path.basename(this.dbPath);
            let payload: Buffer | null = null;
            try {
                if (fs.existsSync(this.dbPath) && this._hasSqliteHeaderOnDisk(this.dbPath)) payload = fs.readFileSync(this.dbPath);
            } catch { payload = null; }
            if (!payload) {
                const data = this._db.export();
                if (!data || data.length < 1024 || !this._hasSqliteHeader(data)) return;
                payload = Buffer.from(data);
            }
            // 体积上限：单库 >32MB 不做世代快照（副本成本超过回收价值）
            if (payload.length > 32 * 1024 * 1024) {
                this._stateLog('boot snapshot skipped (too large) bytes=' + payload.length);
                return;
            }
            const target = path.join(dir, base + '.good.' + Date.now());
            const part = target + '.partial';
            this._writeFileDurableSync(part, payload);
            fs.renameSync(part, target);
            const goods = fs.readdirSync(dir)
                .filter((f: string) => f.startsWith(base + '.good.') && !f.endsWith('.partial'))
                .sort();
            for (let i = 0; i < goods.length - 2; i++) { try { fs.unlinkSync(path.join(dir, goods[i])); } catch { /* ignore */ } }
            this._stateLog('boot snapshot ' + path.basename(target) + ' rows=' + cnt + ' bytes=' + payload.length);
        } catch { /* 快照失败绝不影响启动 */ }
    }

    // ----- 关键键镜像（防整库级损坏清零）------------------------------------

    private _isMirrorKey(ns: string, key: string): boolean {
        for (const m of MIRROR_KEYS) { if (m.ns === ns && m.key === key) return true; }
        return false;
    }

    private _mirrorPath(ns: string, key: string): string {
        return path.join(path.dirname(this.dbPath), 'mirror', ns + '.' + key + '.json');
    }

    /** 写 JSON 快照（原子 tmp+rename）；任何失败都不影响主流程 */
    private _writeMirror(ns: string, key: string, value: any): void {
        try {
            const f = this._mirrorPath(ns, key);
            try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* ignore */ }
            const body = JSON.stringify(value === undefined ? null : value);
            const tmp = f + '.tmp.' + Date.now() + '.' + process.pid;
            fs.writeFileSync(tmp, body, 'utf8');
            try { fs.renameSync(tmp, f); }
            catch {
                try { fs.writeFileSync(f, body, 'utf8'); } catch { /* ignore */ }
                try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    /** 启动补回：库里该键缺失时用镜像回魂（库里有值一律不动；空数组/null = 用户已清空，不复活） */
    private _restoreMirrorKeys(): void {
        for (const m of MIRROR_KEYS) {
            try {
                const f = this._mirrorPath(m.ns, m.key);
                const mirrorExists = fs.existsSync(f);
                let row: any = null;
                try { row = this._stmtGet('SELECT value FROM state WHERE ns=? AND key=?', [m.ns, m.key]); } catch { row = null; }
                if (row && row.value) {
                    // ★ 首次保护（老库存量数据）：镜像还不存在 → 用现有值种一份，不等用户下一次编辑
                    if (!mirrorExists) {
                        try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* ignore */ }
                        try { this._writeFileDurableSync(f, Buffer.from(String(row.value), 'utf8')); } catch { /* ignore */ }
                    }
                    continue;
                }
                if (!mirrorExists) continue;
                const val = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (val === null || val === undefined) continue;
                if (Array.isArray(val) && val.length === 0) continue;
                this._db.run(
                    'INSERT OR REPLACE INTO state (ns, key, value, meta, updated_at) VALUES (?,?,?,?,?)',
                    [m.ns, m.key, JSON.stringify(val), JSON.stringify({ v: 1, ts: Date.now(), deviceId: this.deviceId, form: 'doc', src: 'mirror' }), Date.now()]
                );
                this._memCache.set(m.ns + '\x00' + m.key, val);
                this._scheduleSaveDb();
                this._stateLog('mirror restored ' + m.ns + '/' + m.key + ' items=' + (Array.isArray(val) ? val.length : 1));
                console.warn('[state-sqlite] ⚠ key restored from mirror:', m.ns, m.key);
            } catch { /* ignore */ }
        }
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
            // ★ 先接管残留 tmp/.pending（顺带清理），再读主库——顺序反了会出现
            //   「内存载的是旧库、盘上已被提升成新库」的错位，下一次 save 再把新数据盖掉
            this._cleanStaleTmp();
            // Load or create DB
            if (fs.existsSync(this.dbPath)) {
                try {
                    const buf = fs.readFileSync(this.dbPath);
                    // ★ 0 字节/退化文件视为损坏（2026-09-19）：sql.js 对空 buffer 静默开空库——
                    //   配置会「被清空」且不走恢复链；强制抛错 → 检疫 + .prev/.bak 恢复链接管
                    if (buf.length < 1024) {
                        throw new Error('degenerate db file (' + buf.length + ' B) — treat as corrupt');
                    }
                    this._db = new this._SQL.Database(buf);
                } catch (e: any) {
                    console.warn('[state-sqlite] failed to load db, starting fresh:', e);
                    this._stateLog('LOAD FAILED err=' + String(e && e.message) + ' — salvage + recovery chain');
                    this._salvageOldFile('load-failed');
                    // ★ 2026-09-17: 解除“只补缺”合并开关——写出前先回收旧文件残余 key，
                    //   防“加载失败→空库→第一次 save 覆写”静默丢配置（本事故的直接死法）
                    this._enableDiskMerge = true;
                    // ★ 恢复链：.prev（轮换备份）→ .bak（旧格式）→ 空库（2026-08-09 F3）
                    if (!this._tryRestoreBackup()) {
                        this._db = new this._SQL.Database();
                        this._stateLog('recovery chain exhausted — EMPTY DB (prefs will look reset)');
                    }
                }
            } else {
                // ★ 文件不存在 → 尝试 .prev/.bak 恢复（可能是上次腐败隔离后还没来得及写新数据）
                this._stateLog('no db file at boot — recovery chain');
                if (!this._tryRestoreBackup()) {
                    this._db = new this._SQL.Database();
                }
            }



            // ★ 初始化 schema — 若已加载的 DB 内部页损坏（"disk image is malformed"），
            //    构造函数可能不报错但首次 SQL 执行才暴露 → 隔离旧文件 + 空库重试
            try {
                this._initSchema();
            } catch (sqlError: any) {
                console.warn('[state-sqlite] schema init failed (internal corruption?), quarantine & restore:', sqlError);
                this._stateLog('SCHEMA INIT FAILED err=' + String(sqlError && sqlError.message));
                this._salvageOldFile('schema-init-failed');
                this._enableDiskMerge = true;   // ★ 同上：写前回收旧文件残余 key
                // ★ 恢复链（2026-11-22）：schema 级损坏以前直接建空库 —— 用户资产清零，且第一次
                //   save 就把好备份轮换成空库，最后一条生路一并没了。现在与 load-failed 同等对待。
                if (!this._tryRestoreBackup()) {
                    this._db = new this._SQL.Database();
                    this._stateLog('schema-init recovery exhausted — EMPTY DB');
                }
                // Retry on restored/new DB（补齐索引与 registry）
                this._initSchema();
            }

            // ★ 启动取证行（2026-09-17）: 每启动一行——rows 突降即「配置丢失」现场
            try {
                const _c = this._stmtGet('SELECT COUNT(*) AS c FROM state', []);
                const _rows = ((_c && _c.c) || 0);
                const _base = path.basename(this.dbPath);
                const _prevRows = this._prevBootRows(_base);
                this._stateLog('boot ok db=' + _base + ' rows=' + _rows + ' schemas=' + this.schemas.size + ' bytes=' + (() => { try { return fs.statSync(this.dbPath).size; } catch { return 0; } })());
                // ★ 断崖取证：行数腰斩即「数据丢了」的显式信号（日志不再需要人肉对比）
                if (_prevRows >= 20 && _rows < _prevRows / 2) {
                    this._stateLog('DISCONTINUITY db=' + _base + ' rows ' + _prevRows + ' → ' + _rows + ' (see .pending/.prev/.good/mirror)');
                }
            } catch { /* ignore */ }

            this._readyOk = true;
            console.log('[state-sqlite] ready, schemas:', this.schemas.size);
            // ★ 启动世代快照 + 关键键镜像补回（都在 ready 之后：写盘定时器才真正生效）
            this._snapshotBoot();
            this._restoreMirrorKeys();
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
                // ★ 主库头坏（全零/垃圾）时无条件让位给完好 tmp（2026-11-22）
                const mainValid = mainExists && this._hasSqliteHeaderOnDisk(mainDb);
                if (!mainExists || !mainValid || tmpMtime > mainMtime) {
                    // ★ 提升前验证（2026-09-19）：硬杀进程可留下 0 字节/半截 tmp——
                    //   盲目提升会把好库覆盖成坏库（0 字节 global.sq3 事故链的一环）
                    let _tmpOk = false;
                    try { const _b = fs.readFileSync(fullPath); _tmpOk = _b.length >= 1024 && this._tryValidateDb(_b as any); } catch { _tmpOk = false; }
                    if (_tmpOk) {
                        // tmp 比主 db 新（或主 db 不存在）且完好 → 恢复！
                        console.log('[state-sqlite] recovering from tmp:', fullPath, '→', mainDb);
                        try { fs.renameSync(fullPath, mainDb); } catch {
                            // rename 失败（跨设备？）→ 拷贝
                            try { fs.copyFileSync(fullPath, mainDb); fs.unlinkSync(fullPath); } catch { /* ignore */ }
                        }
                    } else {
                        console.warn('[state-sqlite] invalid/stale tmp ignored & removed:', fullPath);
                        try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
                    }
                } else {
                    // 主 db 更新或等新 → tmp 是垃圾
                    try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
                }
            }
        } catch { /* ignore */ }
        // ★ .pending（上次落盘失败的完整导出）接管：完好且比主库新 → 提升；否则清掉
        try {
            const pend = this.dbPath + '.pending';
            if (fs.existsSync(pend)) {
                let okP = false;
                let pm = 0;
                try { pm = fs.statSync(pend).mtimeMs; okP = this._tryValidateDb(fs.readFileSync(pend)); } catch { okP = false; }
                let mm = 0;
                try { mm = fs.statSync(this.dbPath).mtimeMs; } catch { mm = 0; }
                if (okP && pm > mm) {
                    try { fs.renameSync(pend, this.dbPath); this._stateLog('adopted .pending → ' + path.basename(this.dbPath)); } catch { /* ignore */ }
                } else {
                    try { fs.unlinkSync(pend); } catch { /* ignore */ }
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

    /** ★ outbox 去重压缩（2026-09-27）：同一 ns/key 只保留最新 seq 一条，建立去重索引。
     *  背景：outbox 是 append-only 队列，而云同步（state-cloud）为「完全手动」mode——
     *  渲染层无调用方 → 永不排空。实测绿色包一个月积压 1858 条 / 仅 10 个键。
     *  启动折叠一次（保最新，余者删 + 索引重建）；写入路径同键先写新再删旧（详 _queueOutbox）。 */
    private _compactOutbox(): void {
        try {
            const files = fs.readdirSync(this.outboxDir).filter(f => /^\d+\.json$/.test(f));
            const best = new Map<string, { seq: string; file: string }>();
            let removed = 0;
            for (const f of files) {
                let j: any = null;
                try { j = JSON.parse(fs.readFileSync(path.join(this.outboxDir, f), 'utf8')); } catch { continue; }
                if (!j || !j.ns || !j.key) { continue; }
                const fk = j.ns + '/' + j.key;
                const seq = f.replace(/\.json$/, '');
                const cur = best.get(fk);
                if (!cur) { best.set(fk, { seq, file: f }); continue; }
                if (seq > cur.seq) {
                    try { fs.unlinkSync(path.join(this.outboxDir, cur.file)); removed++; } catch { /* ignore */ }
                    best.set(fk, { seq, file: f });
                } else {
                    try { fs.unlinkSync(path.join(this.outboxDir, f)); removed++; } catch { /* ignore */ }
                }
            }
            this.outboxIndex.clear();
            for (const [fk, v] of best) { this.outboxIndex.set(fk, v.seq); }
            if (removed > 0) { console.log('[state-sqlite] outbox compacted: -' + removed + ' (kept ' + best.size + ')'); }
        } catch (e) { console.warn('[state-sqlite] _compactOutbox failed:', e); }
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
            // 1. 隔离坏库（rename 失败 → 留副本，绝不静默丢现场）
            this._stateLog('runtime malformed db — salvage + rebuild');
            this._salvageOldFile('runtime-malformed');
            this._enableDiskMerge = true;   // ★ 同上：写前回收旧文件残余 key
            // 2. 优先从 .prev/.bak 恢复（2026-08-09 F3：防隔离即全丢），失败才建空库
            if (!this._tryRestoreBackup()) {
                this._db = new this._SQL.Database();
                this._stateLog('runtime rebuild: recovery chain exhausted — EMPTY DB');
            }
            // 3. 重建 schema（从 registry 恢复所有 namespace）
            this._initSchema();
            // 4. 清除缓存 + 标记所有脏 key（触发下次 save 全部重写）
            this._memCache.clear();
            // 将所有已注册 namespace 的数据标记为脏（保证下次 save 写入空值）
            for (const [id] of this._debouncers) {
                this._dirtySet.add(id);
            }
            console.warn('[state-sqlite] ⚠ corrupt db quarantined (salvaged), fresh db ready (data loss may have occurred)');
        } catch (e2) {
            console.error('[state-sqlite] CRITICAL: quarantine failed:', e2);
        }
    }

    /** ★ 验证 SQLite 数据是否有效：头魔数 → 打开 → 真读 sqlite_master。
     *  2026-11-22：旧实现只跑 SELECT 1 —— 该语句不读页 1，全零/垃圾文件照样「验证通过」
     *  （实测：10MB 全零文件 new Database() 不报错、SELECT 1 通过，只有读 sqlite_master 才炸
     *  "file is not a database"）→ 校验必须落到页 1 才算校验。 */
    private _tryValidateDb(data: Uint8Array | Buffer): boolean {
        try {
            if (!data || data.length < 1024) return false;
            if (!this._hasSqliteHeader(data)) return false;
            const testDb = new this._SQL.Database(data as any);
            try {
                testDb.exec('SELECT name FROM sqlite_master LIMIT 1');
                return true;
            } finally {
                testDb.close();
            }
        } catch {
            return false;
        }
    }

    /** 头魔数校验（页 1 前 16 字节）——唯一实现：db-durable */
    private _hasSqliteHeader(data: Uint8Array | Buffer): boolean { return hasSqliteHeader(data); }

    /** 快速头校验（只读前 16 字节，不载入整库）——唯一实现：db-durable */
    private _hasSqliteHeaderOnDisk(file: string): boolean { return hasSqliteHeaderOnDisk(file); }

    /** ★ 采纳某个备份文件为当前库（全量校验通过才采纳）。成功返回 true。 */
    private _adoptDbFile(file: string, label: string): boolean {
        try {
            const buf = fs.readFileSync(file);
            if (!this._tryValidateDb(buf)) return false;
            const db = new this._SQL.Database(buf);
            try { db.exec('SELECT name FROM sqlite_master LIMIT 1'); } catch { try { db.close(); } catch { /* ignore */ } return false; }
            if (this._db) { try { this._db.close(); } catch { /* ignore */ } }
            this._db = db;
            console.warn('[state-sqlite] ⚠ restored from ' + label + ': ' + file);
            this._stateLog('restored from ' + label + ' (' + path.basename(file) + ') bytes=' + buf.length);
            return true;
        } catch { return false; }
    }

    /** ★ 恢复链：.pending（上次落盘失败的完整导出）→ .prev（轮换备份）→ .good.{ts}（启动世代快照）
     *  → .bak.{ts}（旧格式）→ 失败。成功返回 true。每一档都过全量校验，坏档跳过。 */
    private _tryRestoreBackup(): boolean {
        try {
            const dir = path.dirname(this.dbPath);
            const base = path.basename(this.dbPath);
            // 1. .pending —— 最近一次「导出有效但 rename 未落地」的最新数据
            const pendPath = path.join(dir, base + '.pending');
            if (fs.existsSync(pendPath) && this._adoptDbFile(pendPath, '.pending')) {
                try { fs.unlinkSync(pendPath); } catch { /* ignore */ }
                return true;
            }
            // 2. .prev 轮换备份（每次落盘前 copy，最新完好版）
            const prevPath = path.join(dir, base + '.prev');
            if (fs.existsSync(prevPath) && this._adoptDbFile(prevPath, '.prev')) return true;
            // 3. .good.{ts} 启动世代快照（新 → 旧）
            let goods: string[] = [];
            try { goods = fs.readdirSync(dir).filter((f: string) => f.startsWith(base + '.good.') && !f.endsWith('.partial')); } catch { goods = []; }
            for (const g of goods.sort().reverse()) {
                if (this._adoptDbFile(path.join(dir, g), 'good-snapshot')) return true;
            }
            // 4. 旧格式 .bak.{ts}（历史遗留）
            let baks: string[] = [];
            try { baks = fs.readdirSync(dir).filter((f: string) => f.startsWith(base + '.bak.')); } catch { baks = []; }
            for (const b of baks.sort().reverse()) {
                if (this._adoptDbFile(path.join(dir, b), 'bak')) return true;
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
                // ★ 删除墓碑：写前磁盘合并不得把刚删的 key 从磁盘补回来
                this._deletedKeys.add(ns + '\x00' + key);
                // ★ 删除同步到镜像（写 null → 启动时不会把已删数据复活）
                if (this._isMirrorKey(ns, key)) { this._writeMirror(ns, key, null); }
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
            // ★ 该 key 已被重新赋值 → 撤销删除墓碑
            this._deletedKeys.delete(ns + '\x00' + key);
            // ★ update memory cache
            this._memCache.set(ns + '\x00' + key, value);
            // ★ 关键键镜像（库外 JSON 快照）——整库级损坏时的回魂源
            if (this._isMirrorKey(ns, key)) { this._writeMirror(ns, key, value); }
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
        // ★ 写前 .prev 轮换（项目级库 + 全局库）：保留上一完好版，损坏可回退
        //   ★ 轮换闸门（2026-11-22）：主库本身不是合法 SQLite → 不许覆盖 .prev
        //   （否则「坏主库 → 污染好备份」二次毁灭，丢失链的一环）
        if (this._prevEnabled && this._hasSqliteHeaderOnDisk(this.dbPath)) { try { await fs.promises.copyFile(this.dbPath, this.dbPath + '.prev'); } catch { /* ignore */ } }
        const tmp = this.dbPath + '.tmp.' + Date.now() + '.' + process.pid + '.' + (++this._saveSeq);
        try {
            const data = this._db.export();
            // ★ 空/退化导出守卫（2026-09-19）：export 偶发 0 字节（空库/并发竞态）——
            //   一旦落盘即把主库变 0 字节（实锤事故：global.sq3 被写空）→ 一律拒写
            if (!data || data.length < 1024) {
                console.error('[state-sqlite] CRITICAL: empty/degenerate export (' + (data ? data.length : 0) + ' B) — SKIPPING save (dbPath=' + this.dbPath + ')');
                this._stateLog('CRITICAL: empty export — save skipped');
                return;
            }
            // ★ 写入前验证：export 出的数据是否有效 SQLite（防 WASM 内存腐败扩散）
            if (!this._tryValidateDb(data)) {
                console.error('[state-sqlite] CRITICAL: exported data is invalid SQLite — SKIPPING save to prevent corruption (dbPath=' + this.dbPath + ')');
                this._stateLog('CRITICAL: invalid export — save skipped');
                return;
            }
            const buf = Buffer.from(data);
            // 确保父目录存在（兜底：构造函数中已创建，但可能被外部删除）
            try { fs.mkdirSync(path.dirname(this.dbPath), { recursive: true }); } catch { /* ignore */ }
            // ★ 写 + fsync（2026-11-22）：不 fsync 的写只停在系统页缓存，掉电后
            //   NTFS 只保住文件长度、内容全 0（本次丢收藏的直接成因）
            await this._writeFileDurable(tmp, buf);
            // 原子 rename，含重试（Windows 上可能因瞬时文件锁失败）
            await this._atomicRename(tmp, this.dbPath);
            this._saveRetryCount = 0;
            this._deletedKeys.clear();
            this._clearPendingPark();
            this._maybeSessionSnapshot();
        } catch (e: any) {
            console.warn('[state-sqlite] _doSaveDb failed:', e);
            this._logSaveError(e);
            // ★ 本次导出完好但未落地 → 留成 .pending（下次启动/重试接管），并延迟重试
            this._parkPending(tmp);
            this._scheduleSaveRetry();
        } finally {
            // 无论如何清理 tmp 文件，防止堆积
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
        }
    }

    /** ★ 保存失败日志（节流 1/分钟，防锁持续时刷爆日志本体） */
    private _logSaveError(e: any): void {
        const now = Date.now();
        if (now - this._lastSaveErrLogAt < 60000) return;
        this._lastSaveErrLogAt = now;
        this._stateLog('SAVE FAILED err=' + String(e && (e.code || e.message)));
    }

    /** 原子 rename，带重试。绝不原地覆盖（原地 = 先截断后写，写入期掉电/被杀就得到
     *  「长度对但内容全零」的库——本次丢收藏的现场形态就是这个）。 */
    private async _atomicRename(tmp: string, dest: string): Promise<void> {
        let lastErr: any = null;
        for (let i = 0; i < 4; i++) {
            try {
                await fs.promises.rename(tmp, dest);
                return;
            } catch (e: any) {
                lastErr = e;
                const code = e && e.code;
                // 锁类错误（另一实例/杀软/索引器持句柄）可重试；其它直接抛
                if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
                await new Promise(r => setTimeout(r, 40 * (i + 1)));
            }
        }
        // 四轮均被锁 → 放弃本次落地（绝不原地覆写），交给 .pending + 延迟重试
        throw lastErr || new Error('rename failed (locked)');
    }

    /** ★ 写 + fsync（真落盘）——唯一实现：db-durable */
    private async _writeFileDurable(file: string, buf: Buffer): Promise<void> { return writeFileDurable(file, buf); }

    private _writeFileDurableSync(file: string, buf: Buffer): void { writeFileDurableSync(file, buf); }

    /** ★ 本会话首次存入数据后补一份启动快照（只一次）——掉电后下一个会话才有可回退的跨会话副本 */
    private _maybeSessionSnapshot(): void {
        if (this._sessionSnapDone) return;
        this._sessionSnapDone = true;
        const t = setTimeout(() => { try { this._snapshotBoot(); } catch { /* ignore */ } }, 3000);
        try { t.unref(); } catch { /* ignore */ }
    }

    /** ★ 把未落地的完好导出留成 {db}.pending（下次启动或重试时接管），不丢本次写 */
    private _parkPending(tmp: string): void {
        try {
            if (!fs.existsSync(tmp)) return;
            const pend = this.dbPath + '.pending';
            try { fs.renameSync(tmp, pend); }
            catch { try { fs.copyFileSync(tmp, pend); } catch { /* ignore */ } }
            this._pendingParked = true;
            this._stateLog('save parked as .pending (rename blocked) db=' + path.basename(this.dbPath));
        } catch { /* ignore */ }
    }

    /** 落盘成功后清掉旧 .pending（它已包含在本次写入里） */
    private _clearPendingPark(): void {
        if (!this._pendingParked) return;
        this._pendingParked = false;
        try { fs.unlinkSync(this.dbPath + '.pending'); } catch { /* ignore */ }
    }

    /** ★ 落盘失败延迟重试（锁是瞬时的：2s/4s/6s… 最多 5 次；数据一直留在内存） */
    private _scheduleSaveRetry(): void {
        if (this._saveRetryTimer) return;
        if (this._saveRetryCount >= 5) return;
        this._saveRetryCount++;
        const delay = 2000 * this._saveRetryCount;
        this._saveRetryTimer = setTimeout(() => {
            this._saveRetryTimer = null;
            try { void this._doSaveDb(); } catch { /* ignore */ }
        }, delay);
        try { this._saveRetryTimer.unref(); } catch { /* ignore */ }
    }

    /** Synchronous flush for crash/shutdown — must not use async I/O */
    private _doSaveDbSync(): void {
        if (!this._readyOk || !this._db) return;
        this._saveDbPending = false;
        if (this._saveDbTimer) { clearTimeout(this._saveDbTimer); this._saveDbTimer = null; }
        // ★ 先重放 debounce 中的 pending 写入 → 内存 DB 即全量（2026-08-09）
        this._flushPendingWrites();
        // ★ 写前磁盘合并 + .prev 轮换（合并仅项目级/丢库自愈场景；.prev 全库启用）
        this._mergeDiskIntoMemory();
        if (this._prevEnabled && this._hasSqliteHeaderOnDisk(this.dbPath)) { try { fs.copyFileSync(this.dbPath, this.dbPath + '.prev'); } catch { /* ignore */ } }
        const tmp = this.dbPath + '.tmp.' + Date.now() + '.' + process.pid + '.' + (++this._saveSeq);
        try {
            const data = this._db.export();
            // ★ 空/退化导出守卫（2026-09-19）：export 偶发 0 字节（空库/并发竞态）——
            //   一旦落盘即把主库变 0 字节（实锤事故：global.sq3 被写空）→ 一律拒写
            if (!data || data.length < 1024) {
                console.error('[state-sqlite] CRITICAL: empty/degenerate export (' + (data ? data.length : 0) + ' B) — SKIPPING save (dbPath=' + this.dbPath + ')');
                this._stateLog('CRITICAL: empty export — save skipped');
                return;
            }
            // ★ 写入前验证：export 出的数据是否有效 SQLite（防 WASM 内存腐败扩散）
            if (!this._tryValidateDb(data)) {
                console.error('[state-sqlite] CRITICAL: exported data is invalid SQLite — SKIPPING save to prevent corruption (dbPath=' + this.dbPath + ')');
                this._stateLog('CRITICAL: invalid export — save skipped (sync)');
                return;
            }
            const buf = Buffer.from(data);
            try { fs.mkdirSync(path.dirname(this.dbPath), { recursive: true }); } catch { /* ignore */ }
            this._writeFileDurableSync(tmp, buf);
            // 原子 rename（绝不先删后改；锁类错误短重试，仍失败就留 .pending）
            let renamed = false;
            let lastSyncErr: any = null;
            for (let i = 0; i < 3 && !renamed; i++) {
                try { fs.renameSync(tmp, this.dbPath); renamed = true; }
                catch (e: any) {
                    lastSyncErr = e;
                    const code = e && e.code;
                    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
                }
            }
            if (!renamed) throw lastSyncErr || new Error('rename failed (locked)');
            this._saveRetryCount = 0;
            this._deletedKeys.clear();
            this._clearPendingPark();
        } catch (e: any) {
            console.warn('[state-sqlite] _doSaveDb failed:', e);
            this._logSaveError(e);
            this._parkPending(tmp);
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
                        // ★ 本实例刚删的 key 不参与合并（否则「删了又回」）
                        if (this._deletedKeys.has(row.ns + '\x00' + row.key)) continue;
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
            // ★ 去重（2026-09-27）：同 ns/key 只保留最新一条——写新成功后删旧（删失败留给下次启动折叠）
            const fk = ns + '/' + key;
            const oldSeq = this.outboxIndex.get(fk);
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
            this.outboxIndex.set(fk, seq);
            if (oldSeq && oldSeq !== seq) { try { fs.unlinkSync(path.join(this.outboxDir, oldSeq + '.json')); } catch { /* ignore */ } }
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
        try { fs.unlinkSync(f); } catch { return false; }
        for (const [fk, s] of this.outboxIndex) { if (s === seq) { this.outboxIndex.delete(fk); break; } }
        return true;
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
