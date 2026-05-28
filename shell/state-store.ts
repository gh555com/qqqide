// ============================================================================
// state-store.ts
// "唯一真理持久化机器" — the ONE storage machine for qqq + all gaea goods.
//
// Three forms (declared per-namespace at register() time, immutable at runtime):
//   - doc  : plain JSON (best for <1 MB structured prefs)
//   - blob : JSON + gzip (best for medium/large binary-ish dumps, e.g. q4 events)
//   - log  : append-only NDJSON (best for event streams; size-threshold compact)
//
// Physical layout, rooted under <userData>/state/ :
//   registry.json                   ← ns -> schema snapshot
//   ns/<safe-ns>/<safe-key>.{json|bin|log}
//   ns/<safe-ns>/<safe-key>.meta.json
//   locks/<safe-ns>__<safe-key>.lock      ← cross-process write lock
//   outbox/<seq>.json                     ← cloud push retry queue
//   corrupt/<safe-ns>__<safe-key>.<ts>.{...}   ← isolated corrupted payloads
//
// Atomicity: every write goes tmp + rename + Windows unlink-fallback.
// Concurrency: per-key file lock + merge-on-save (delegates to schema.merger).
// Crash protection: caller wires flush()/flushSync() into app lifecycle.
// Cloud sync: handled in state-cloud.ts; this module only marks outbox entries.
//
// Zero new deps — uses only node fs/zlib/crypto.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Public types
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
    /** log only: when log file exceeds this size, compact via merger or last-wins. */
    compactThresholdBytes?: number;
}

export interface MetaJson {
    v: number;
    ts: number;
    deviceId: string;
    etag?: string;
    sha256: string;
    sizeBytes: number;
    form: StateForm;
    events?: number;
}

export interface StatsSnapshot {
    dirtyKeys: number;
    queuedOutbox: number;
    lastSyncAt?: number;
    namespaces: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface KeyState {
    ns: string;
    key: string;
    safeNs: string;
    safeKey: string;
    /** in-memory authoritative value (or array of events for log form). */
    value: any;
    /** true if value differs from on-disk and needs flush. */
    dirty: boolean;
    /** chained save promise — guarantees serial saves per key. */
    saveChain: Promise<void>;
    /** debounce timer handle. */
    debounceTimer?: NodeJS.Timeout;
    /** false until first load attempt completes. */
    loaded: boolean;
    /** cached meta from last successful save/load. */
    meta?: MetaJson;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_LOG_COMPACT_BYTES = 2 * 1024 * 1024; // 2 MB
const LOCK_STALE_MS = 60 * 1000;
const MAX_SAFE_NAME = 200;

const BAD_CHARS_RE = /[/\\:*?"<>|\x00-\x1f]/g;

/** Sanitise a ns/key segment to a filesystem-safe name. */
function safeName(s: string): string {
    if (s === null || s === undefined) { return '_'; }
    let v = String(s).replace(BAD_CHARS_RE, '_').replace(/^\.+/, '_').trim();
    if (!v) { v = '_'; }
    if (v.length > MAX_SAFE_NAME) {
        const h = crypto.createHash('sha256').update(v).digest('hex').slice(0, 32);
        v = v.slice(0, MAX_SAFE_NAME - 33) + '_' + h;
    }
    return v;
}

function nowMs(): number { return Date.now(); }

function sha256Hex(buf: Buffer | string): string {
    return crypto.createHash('sha256').update(buf as any).digest('hex');
}

/** Atomic write: writes tmp file then renames over target. Windows-safe. */
async function atomicWrite(absPath: string, data: Buffer | string): Promise<void> {
    const dir = path.dirname(absPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = absPath + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    await fs.promises.writeFile(tmp, buf as any);
    try {
        await fs.promises.rename(tmp, absPath);
    } catch (e: any) {
        // Windows: rename onto existing may fail; fall back to unlink+rename.
        if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
            try { await fs.promises.unlink(absPath); } catch { /* ignore */ }
            await fs.promises.rename(tmp, absPath);
        } else {
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
            throw e;
        }
    }
}

function atomicWriteSync(absPath: string, data: Buffer | string): void {
    const dir = path.dirname(absPath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const tmp = absPath + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    fs.writeFileSync(tmp, buf as any);
    try {
        fs.renameSync(tmp, absPath);
    } catch (e: any) {
        if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
            try { fs.unlinkSync(absPath); } catch { /* ignore */ }
            fs.renameSync(tmp, absPath);
        } else {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            throw e;
        }
    }
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export class StateStore extends EventEmitter {
    private rootDir: string;
    private nsDir: string;
    private locksDir: string;
    private outboxDir: string;
    private corruptDir: string;
    private registryFile: string;

    private deviceId: string;
    private outboxSeq = 0;
    private lastSyncAt?: number;

    private schemas: Map<string, NsSchema> = new Map();
    private states: Map<string, KeyState> = new Map();

    /** Hook so state-cloud.ts can subscribe to dirty events without polling. */
    public onCloudDirty: ((ns: string, key: string) => void) | null = null;

    constructor(userDataDir: string) {
        super();
        this.setMaxListeners(0);
        this.rootDir = path.join(userDataDir, 'state');
        this.nsDir = path.join(this.rootDir, 'ns');
        this.locksDir = path.join(this.rootDir, 'locks');
        this.outboxDir = path.join(this.rootDir, 'outbox');
        this.corruptDir = path.join(this.rootDir, 'corrupt');
        this.registryFile = path.join(this.rootDir, 'registry.json');
        for (const d of [this.rootDir, this.nsDir, this.locksDir, this.outboxDir, this.corruptDir]) {
            try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
        }
        this.deviceId = this._loadOrCreateDeviceId();
        this._restoreOutboxSeq();
        console.log('[state] root=', this.rootDir, 'device=', this.deviceId);
    }

    // ----- device id (stable per machine, generated once) ---------------------

    private _loadOrCreateDeviceId(): string {
        const f = path.join(this.rootDir, 'device.id');
        try {
            if (fs.existsSync(f)) {
                const s = fs.readFileSync(f, 'utf8').trim();
                if (s && s.length >= 8) { return s; }
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
                    if (n > this.outboxSeq) { this.outboxSeq = n; }
                }
            }
        } catch { /* ignore */ }
    }

    // ----- public introspection ----------------------------------------------

    public getDeviceId(): string { return this.deviceId; }
    public getRootDir(): string { return this.rootDir; }
    public getOutboxDir(): string { return this.outboxDir; }

    public getRegisteredNs(): string[] { return Array.from(this.schemas.keys()); }
    public getSchema(ns: string): NsSchema | undefined { return this.schemas.get(ns); }

    public stats(): StatsSnapshot {
        let dirty = 0;
        for (const st of this.states.values()) { if (st.dirty) { dirty++; } }
        let outbox = 0;
        try { outbox = fs.readdirSync(this.outboxDir).filter(f => f.endsWith('.json')).length; } catch { /* ignore */ }
        return {
            dirtyKeys: dirty,
            queuedOutbox: outbox,
            lastSyncAt: this.lastSyncAt,
            namespaces: this.schemas.size,
        };
    }

    public markSyncedAt(t: number): void { this.lastSyncAt = t; }

    // ----- registration -------------------------------------------------------

    register(ns: string, schema: NsSchema): void {
        if (!ns || typeof ns !== 'string') { throw new Error('state.register: bad ns'); }
        if (!schema || !schema.form || !['doc', 'blob', 'log'].includes(schema.form)) {
            throw new Error('state.register: bad schema.form, must be doc/blob/log');
        }
        if (typeof schema.v !== 'number' || schema.v < 1) {
            throw new Error('state.register: schema.v must be >=1');
        }
        const existing = this.schemas.get(ns);
        if (existing) {
            // Allow same-version re-register (idempotent). Form must match.
            if (existing.form !== schema.form) {
                throw new Error(`state.register: ns "${ns}" form mismatch (existing=${existing.form}, new=${schema.form})`);
            }
        }
        this.schemas.set(ns, schema);
        this._persistRegistry();
        console.log('[state] register ns=', ns, 'v=', schema.v, 'form=', schema.form, 'cloud=', !!schema.cloud);
    }

    private _persistRegistry(): void {
        try {
            const snap: any = {};
            for (const [ns, sc] of this.schemas.entries()) {
                snap[ns] = { v: sc.v, form: sc.form, cloud: !!sc.cloud, quotaBytes: sc.quotaBytes || null };
            }
            atomicWriteSync(this.registryFile, JSON.stringify(snap, null, 2));
        } catch (e) {
            console.warn('[state] _persistRegistry failed:', e);
        }
    }

    // ----- path helpers -------------------------------------------------------

    private _payloadPath(safeNs: string, safeKey: string, form: StateForm): string {
        const dir = path.join(this.nsDir, safeNs);
        const ext = form === 'doc' ? '.json' : form === 'blob' ? '.bin' : '.log';
        return path.join(dir, safeKey + ext);
    }

    private _metaPath(safeNs: string, safeKey: string): string {
        return path.join(this.nsDir, safeNs, safeKey + '.meta.json');
    }

    private _lockPath(safeNs: string, safeKey: string): string {
        return path.join(this.locksDir, safeNs + '__' + safeKey + '.lock');
    }

    private _resolveKeyState(ns: string, key: string): KeyState {
        const id = ns + '\u0000' + key;
        let st = this.states.get(id);
        if (!st) {
            st = {
                ns, key,
                safeNs: safeName(ns),
                safeKey: safeName(key),
                value: undefined,
                dirty: false,
                saveChain: Promise.resolve(),
                loaded: false,
            };
            this.states.set(id, st);
        }
        return st;
    }

    private _requireSchema(ns: string): NsSchema {
        const sc = this.schemas.get(ns);
        if (!sc) { throw new Error(`state: ns "${ns}" not registered`); }
        return sc;
    }

    // ----- encode / decode ----------------------------------------------------

    private _encode(form: StateForm, value: any): Buffer {
        if (form === 'doc') {
            return Buffer.from(JSON.stringify(value), 'utf8');
        }
        if (form === 'blob') {
            const json = Buffer.from(JSON.stringify(value), 'utf8');
            return zlib.gzipSync(json as any);
        }
        // log: value MUST be an array of events
        if (!Array.isArray(value)) { value = []; }
        const lines = (value as any[]).map(ev => JSON.stringify(ev)).join('\n');
        return Buffer.from(lines + (lines ? '\n' : ''), 'utf8');
    }

    private _decode(form: StateForm, buf: Buffer): any {
        if (form === 'doc') {
            return JSON.parse(buf.toString('utf8'));
        }
        if (form === 'blob') {
            const json = zlib.gunzipSync(buf as any).toString('utf8');
            return JSON.parse(json);
        }
        // log: parse NDJSON to array
        const txt = buf.toString('utf8');
        const out: any[] = [];
        for (const line of txt.split(/\r?\n/)) {
            const t = line.trim();
            if (!t) { continue; }
            try { out.push(JSON.parse(t)); } catch { /* skip bad line */ }
        }
        return out;
    }

    // ----- file lock (pid + atime, stale > LOCK_STALE_MS preempts) ------------

    private async _acquireLock(safeNs: string, safeKey: string): Promise<string> {
        const lp = this._lockPath(safeNs, safeKey);
        await fs.promises.mkdir(path.dirname(lp), { recursive: true });
        const tries = 40; // ~2s max
        for (let i = 0; i < tries; i++) {
            try {
                // O_EXCL guarantees atomic create
                const fd = fs.openSync(lp, 'wx');
                fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: nowMs() }));
                fs.closeSync(fd);
                return lp;
            } catch (e: any) {
                if (e && e.code === 'EEXIST') {
                    // Maybe stale?
                    let stale = false;
                    try {
                        const raw = fs.readFileSync(lp, 'utf8');
                        const info = JSON.parse(raw);
                        if (typeof info.ts === 'number' && (nowMs() - info.ts) > LOCK_STALE_MS) {
                            stale = true;
                        }
                    } catch { stale = true; }
                    if (stale) {
                        try { fs.unlinkSync(lp); } catch { /* ignore */ }
                        continue;
                    }
                    await new Promise(r => setTimeout(r, 50));
                    continue;
                }
                throw e;
            }
        }
        // give up but proceed anyway — better than blocking forever
        console.warn('[state] _acquireLock timeout', lp);
        return lp;
    }

    private _releaseLock(lp: string): void {
        try { fs.unlinkSync(lp); } catch { /* ignore */ }
    }

    // ----- corrupt isolation --------------------------------------------------

    private _quarantine(safeNs: string, safeKey: string, form: StateForm, reason: string): void {
        try {
            const src = this._payloadPath(safeNs, safeKey, form);
            if (!fs.existsSync(src)) { return; }
            const ext = path.extname(src);
            const ts = nowMs();
            const dst = path.join(this.corruptDir, safeNs + '__' + safeKey + '.' + ts + ext);
            fs.mkdirSync(this.corruptDir, { recursive: true });
            fs.renameSync(src, dst);
            // metadata too
            const meta = this._metaPath(safeNs, safeKey);
            if (fs.existsSync(meta)) {
                fs.renameSync(meta, path.join(this.corruptDir, safeNs + '__' + safeKey + '.' + ts + '.meta.json'));
            }
            console.warn('[state] quarantined', src, '->', dst, 'reason=', reason);
        } catch (e) {
            console.warn('[state] _quarantine failed:', e);
        }
    }

    // ----- migration ----------------------------------------------------------

    private _runMigrators(ns: string, fromV: number, toV: number, value: any): any {
        const sc = this._requireSchema(ns);
        if (!sc.migrators || sc.migrators.length === 0) { return value; }
        let cur = value;
        let v = fromV;
        // Build a quick chain map
        const byFrom: Record<number, SchemaMigrator> = {};
        for (const m of sc.migrators) { byFrom[m.from] = m; }
        while (v < toV) {
            const m = byFrom[v];
            if (!m) {
                console.warn(`[state] no migrator from v${v} for ns ${ns}; stopping at v${v}`);
                break;
            }
            try {
                cur = m.run(cur);
                v = m.to;
            } catch (e) {
                console.warn('[state] migrator threw at', ns, 'v', v, e);
                break;
            }
        }
        return cur;
    }

    // ----- load (lazy, on first get/set) --------------------------------------

    private async _loadFromDisk(st: KeyState): Promise<void> {
        const sc = this._requireSchema(st.ns);
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        const metaP = this._metaPath(st.safeNs, st.safeKey);
        if (!fs.existsSync(payload)) {
            st.value = sc.form === 'log' ? [] : null;
            st.loaded = true;
            return;
        }
        let meta: MetaJson | undefined;
        try {
            if (fs.existsSync(metaP)) {
                const raw = await fs.promises.readFile(metaP, 'utf8');
                meta = JSON.parse(raw);
            }
        } catch (e) {
            console.warn('[state] bad meta for', st.ns, st.key, e);
        }
        try {
            const buf = await fs.promises.readFile(payload);
            let val = this._decode(sc.form, buf);
            const onDiskV = meta && typeof meta.v === 'number' ? meta.v : 1;
            if (onDiskV < sc.v) {
                val = this._runMigrators(st.ns, onDiskV, sc.v, val);
                st.value = val;
                st.dirty = true; // write back migrated form
                st.meta = { ...(meta || {} as any), v: sc.v, ts: nowMs(), deviceId: this.deviceId, sha256: '', sizeBytes: buf.length, form: sc.form };
            } else {
                st.value = val;
                st.meta = meta;
            }
            st.loaded = true;
        } catch (e) {
            console.warn('[state] decode failed for', st.ns, st.key, '— quarantining:', e);
            this._quarantine(st.safeNs, st.safeKey, sc.form, String(e));
            st.value = sc.form === 'log' ? [] : null;
            st.loaded = true;
        }
    }

    private async _ensureLoaded(st: KeyState): Promise<void> {
        if (!st.loaded) { await this._loadFromDisk(st); }
    }

    // ----- public API: get / set / append / del / list ------------------------

    async get(ns: string, key: string): Promise<any> {
        this._requireSchema(ns);
        const st = this._resolveKeyState(ns, key);
        await this._ensureLoaded(st);
        return st.value;
    }

    async set(ns: string, key: string, value: any): Promise<void> {
        const sc = this._requireSchema(ns);
        if (sc.form === 'log') {
            // For log form, set replaces the entire event list — caller must pass array.
            if (!Array.isArray(value)) {
                throw new Error(`state.set on log form requires an array; ns=${ns} key=${key}`);
            }
        }
        const st = this._resolveKeyState(ns, key);
        await this._ensureLoaded(st);
        st.value = value;
        st.dirty = true;
        this._scheduleSave(st, sc);
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async setNow(ns: string, key: string, value: any): Promise<void> {
        const sc = this._requireSchema(ns);
        if (sc.form === 'log' && !Array.isArray(value)) {
            throw new Error(`state.setNow on log form requires an array; ns=${ns} key=${key}`);
        }
        const st = this._resolveKeyState(ns, key);
        await this._ensureLoaded(st);
        st.value = value;
        st.dirty = true;
        await this._flushKey(st, sc);
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async append(ns: string, key: string, event: any): Promise<void> {
        const sc = this._requireSchema(ns);
        if (sc.form !== 'log') { throw new Error(`state.append only valid for form=log; ns=${ns}`); }
        const st = this._resolveKeyState(ns, key);
        await this._ensureLoaded(st);
        if (!Array.isArray(st.value)) { st.value = []; }
        st.value.push(event);
        st.dirty = true;
        this._scheduleSave(st, sc);
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async del(ns: string, key: string): Promise<boolean> {
        const sc = this._requireSchema(ns);
        const st = this._resolveKeyState(ns, key);
        // cancel pending debounce
        if (st.debounceTimer) { clearTimeout(st.debounceTimer); st.debounceTimer = undefined; }
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        const meta = this._metaPath(st.safeNs, st.safeKey);
        let any = false;
        try { if (fs.existsSync(payload)) { await fs.promises.unlink(payload); any = true; } } catch { /* ignore */ }
        try { if (fs.existsSync(meta)) { await fs.promises.unlink(meta); any = true; } } catch { /* ignore */ }
        // forget memory state
        this.states.delete(ns + '\u0000' + key);
        if (any) {
            this.emit('changed', { ns, key, value: null, deleted: true });
            if (sc.cloud) { this._queueOutbox(ns, key, null, true); }
        }
        return any;
    }

    async list(ns: string): Promise<string[]> {
        this._requireSchema(ns);
        const dir = path.join(this.nsDir, safeName(ns));
        const out: string[] = [];
        try {
            const files = await fs.promises.readdir(dir);
            for (const f of files) {
                if (f.endsWith('.meta.json')) { continue; }
                if (f.endsWith('.tmp')) { continue; }
                if (f.endsWith('.json') || f.endsWith('.bin') || f.endsWith('.log')) {
                    const base = f.replace(/\.(json|bin|log)$/, '');
                    out.push(base);
                }
            }
        } catch { /* nonexistent ns dir = empty */ }
        return out;
    }

    // ----- save chain ---------------------------------------------------------

    private _scheduleSave(st: KeyState, sc: NsSchema): void {
        const debounceMs = typeof sc.debounceMs === 'number' ? sc.debounceMs : DEFAULT_DEBOUNCE_MS;
        if (st.debounceTimer) { clearTimeout(st.debounceTimer); }
        st.debounceTimer = setTimeout(() => {
            st.debounceTimer = undefined;
            // Enqueue onto saveChain, ignore returned promise (caller can flush()).
            st.saveChain = st.saveChain.then(() => this._doSaveOnce(st, sc)).catch(e => {
                console.warn('[state] save error', st.ns, st.key, e);
            });
        }, debounceMs);
    }

    private async _flushKey(st: KeyState, sc: NsSchema): Promise<void> {
        if (st.debounceTimer) { clearTimeout(st.debounceTimer); st.debounceTimer = undefined; }
        st.saveChain = st.saveChain.then(() => this._doSaveOnce(st, sc));
        await st.saveChain;
    }

    /** Force-flush all currently dirty keys; resolves when done. */
    async flush(): Promise<void> {
        const tasks: Promise<void>[] = [];
        for (const st of this.states.values()) {
            const sc = this.schemas.get(st.ns);
            if (!sc) { continue; }
            if (st.dirty || st.debounceTimer) {
                tasks.push(this._flushKey(st, sc));
            }
        }
        await Promise.all(tasks);
    }

    /** Flush all dirty keys synchronously — for crash / SIGTERM. */
    flushSync(): void {
        for (const st of this.states.values()) {
            const sc = this.schemas.get(st.ns);
            if (!sc) { continue; }
            if (st.debounceTimer) { clearTimeout(st.debounceTimer); st.debounceTimer = undefined; }
            if (!st.dirty) { continue; }
            try { this._doSaveOnceSync(st, sc); } catch (e) {
                console.warn('[state] flushSync error', st.ns, st.key, e);
            }
        }
    }

    async flushOne(ns: string, key: string): Promise<void> {
        const sc = this._requireSchema(ns);
        const st = this._resolveKeyState(ns, key);
        await this._flushKey(st, sc);
    }

    // ----- the actual save (async) --------------------------------------------

    private async _doSaveOnce(st: KeyState, sc: NsSchema): Promise<void> {
        if (!st.dirty) { return; }
        const lp = await this._acquireLock(st.safeNs, st.safeKey);
        try {
            // merge-on-save: if disk version is newer than our last-load, merge.
            await this._mergeFromDisk(st, sc);

            // encode + write
            let buf = this._encode(sc.form, st.value);

            // quota check
            if (sc.quotaBytes && buf.length > sc.quotaBytes) {
                console.warn(`[state] quota exceeded ${st.ns}/${st.key}: ${buf.length} > ${sc.quotaBytes}`);
                // For log form, auto-compact (trim oldest half) before failing.
                if (sc.form === 'log' && Array.isArray(st.value)) {
                    const arr = st.value as any[];
                    arr.splice(0, Math.floor(arr.length / 2));
                    st.value = arr;
                    buf = this._encode(sc.form, st.value);
                }
                if (buf.length > sc.quotaBytes) {
                    throw new Error('quota exceeded after compact');
                }
            }

            // log compaction trigger
            if (sc.form === 'log') {
                const threshold = sc.compactThresholdBytes || DEFAULT_LOG_COMPACT_BYTES;
                if (buf.length > threshold) {
                    // Compact via merger if provided, else simple last-wins by event.k if any.
                    const compacted = this._compactLog(st, sc);
                    if (compacted) {
                        st.value = compacted;
                        buf = this._encode(sc.form, st.value);
                    }
                }
            }

            const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
            await atomicWrite(payload, buf);

            const meta: MetaJson = {
                v: sc.v,
                ts: nowMs(),
                deviceId: this.deviceId,
                sha256: sha256Hex(buf),
                sizeBytes: buf.length,
                form: sc.form,
                events: sc.form === 'log' && Array.isArray(st.value) ? st.value.length : undefined,
            };
            await atomicWrite(this._metaPath(st.safeNs, st.safeKey), JSON.stringify(meta, null, 2));
            st.meta = meta;
            st.dirty = false;

            if (sc.cloud) { this._queueOutbox(st.ns, st.key, st.value, false); }
            this.emit('changed', { ns: st.ns, key: st.key, value: st.value, deleted: false });
        } finally {
            this._releaseLock(lp);
        }
    }

    private _doSaveOnceSync(st: KeyState, sc: NsSchema): void {
        if (!st.dirty) { return; }
        // best-effort sync write — no lock (we are in shutdown)
        const buf = this._encode(sc.form, st.value);
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        atomicWriteSync(payload, buf);
        const meta: MetaJson = {
            v: sc.v,
            ts: nowMs(),
            deviceId: this.deviceId,
            sha256: sha256Hex(buf),
            sizeBytes: buf.length,
            form: sc.form,
            events: sc.form === 'log' && Array.isArray(st.value) ? st.value.length : undefined,
        };
        atomicWriteSync(this._metaPath(st.safeNs, st.safeKey), JSON.stringify(meta, null, 2));
        st.meta = meta;
        st.dirty = false;
        if (sc.cloud) { this._queueOutbox(st.ns, st.key, st.value, false); }
    }

    // ----- merge-on-save ------------------------------------------------------

    private async _mergeFromDisk(st: KeyState, sc: NsSchema): Promise<void> {
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        const metaP = this._metaPath(st.safeNs, st.safeKey);
        if (!fs.existsSync(payload) || !fs.existsSync(metaP)) { return; }
        let diskMeta: MetaJson | undefined;
        try {
            diskMeta = JSON.parse(await fs.promises.readFile(metaP, 'utf8'));
        } catch { return; }
        // If disk version is older or equal to our cached meta ts, no need to merge.
        if (st.meta && diskMeta && diskMeta.ts <= st.meta.ts && diskMeta.deviceId === this.deviceId) {
            return;
        }
        // Different device or newer ts → read & merge.
        let diskVal: any;
        try {
            const buf = await fs.promises.readFile(payload);
            diskVal = this._decode(sc.form, buf);
            const onDiskV = diskMeta && typeof diskMeta.v === 'number' ? diskMeta.v : 1;
            if (onDiskV < sc.v) {
                diskVal = this._runMigrators(st.ns, onDiskV, sc.v, diskVal);
            }
        } catch (e) {
            console.warn('[state] _mergeFromDisk decode failed', st.ns, st.key, e);
            return;
        }
        try {
            if (sc.form === 'log' && Array.isArray(diskVal) && Array.isArray(st.value)) {
                // log default merge: union by JSON-stringified event (idempotent append)
                const seen = new Set<string>();
                const out: any[] = [];
                for (const ev of diskVal) {
                    const k = JSON.stringify(ev);
                    if (!seen.has(k)) { seen.add(k); out.push(ev); }
                }
                for (const ev of st.value) {
                    const k = JSON.stringify(ev);
                    if (!seen.has(k)) { seen.add(k); out.push(ev); }
                }
                st.value = sc.merger ? sc.merger(diskVal, st.value, { ns: st.ns, key: st.key }) : out;
            } else {
                st.value = sc.merger
                    ? sc.merger(diskVal, st.value, { ns: st.ns, key: st.key })
                    // default: last-write-wins by ts; we are saving, so our value wins
                    : st.value;
            }
        } catch (e) {
            console.warn('[state] merger threw — keeping in-memory value', st.ns, st.key, e);
        }
    }

    // ----- log compaction (best-effort, opt-in via threshold) -----------------

    private _compactLog(st: KeyState, sc: NsSchema): any[] | null {
        if (!Array.isArray(st.value)) { return null; }
        // If user gave a merger, ask it to do the compaction (pass empty as local).
        if (sc.merger) {
            try {
                const compacted = sc.merger([], st.value, { ns: st.ns, key: st.key });
                if (Array.isArray(compacted)) { return compacted; }
            } catch (e) {
                console.warn('[state] compactLog merger threw', st.ns, st.key, e);
            }
        }
        // default: keep last half
        const arr = st.value as any[];
        return arr.slice(Math.floor(arr.length / 2));
    }

    // ----- outbox (cloud-sync queue; state-cloud.ts drains it) ----------------

    private _queueOutbox(ns: string, key: string, value: any, deleted: boolean): void {
        try {
            this.outboxSeq += 1;
            const seq = String(this.outboxSeq).padStart(12, '0');
            const f = path.join(this.outboxDir, seq + '.json');
            const payload = { seq, ns, key, ts: nowMs(), deleted, value: deleted ? null : value };
            atomicWriteSync(f, JSON.stringify(payload));
        } catch (e) {
            console.warn('[state] _queueOutbox failed:', e);
        }
    }

    public listOutbox(): { seq: string; file: string }[] {
        const out: { seq: string; file: string }[] = [];
        try {
            const files = fs.readdirSync(this.outboxDir).filter(f => f.endsWith('.json')).sort();
            for (const f of files) { out.push({ seq: f.replace(/\.json$/, ''), file: path.join(this.outboxDir, f) }); }
        } catch { /* ignore */ }
        return out;
    }

    public dropOutbox(seq: string): boolean {
        const f = path.join(this.outboxDir, seq + '.json');
        try { fs.unlinkSync(f); return true; } catch { return false; }
    }

    // ----- onChange convenience -----------------------------------------------

    onChange(ns: string, key: string, cb: (val: any, deleted: boolean) => void): () => void {
        const h = (msg: { ns: string; key: string; value: any; deleted: boolean }) => {
            if (msg.ns === ns && msg.key === key) { cb(msg.value, msg.deleted); }
        };
        this.on('changed', h);
        return () => { this.off('changed', h); };
    }
}
