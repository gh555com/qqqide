// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qgf.ts — FS 原子读写真理机器
//
// 从旧 state-store.ts (836行) 提取核心 — 去掉了七层架构：
//   ✗ registry.json (持久化 schema)  → schemas 仅内存
//   ✗ .meta.json (sha256/ts/deviceId) → 无元数据文件
//   ✗ deviceId 追踪                   → 不需要
//   ✗ ns/ns/ 双层安全名               → 单层 ns/{safeKey}
//   ✗ migrators chain                → caller 自行处理
//
// 保留的核心能力：
//   ✅ 三种 form: doc (JSON) / blob (brotli+不压缩小文件) / log (NDJSON增量追加)
//   ✅ 原子写入: tmp + rename + Windows unlink fallback
//   ✅ 文件锁: O_EXCL + pid/atime + stale 预占 (50ms × 40 = 2s)
//   ✅ 损坏隔离: corrupt/ 目录
//   ✅ 闪退保护: flushSync() — before-quit 同步写盘
//   ✅ 多窗口合并: merge-on-save (schema.merger)
//   ✅ 云端同步: outbox 队列 + cloud 标记
//   ✅ 写去抖: debounceMs (默认 250ms) + setNow 立即写
//
// ★ 四大优化 (vs 旧 state-store.ts)：
//   1. list() 目录缓存 — 内存 cache，set/del 自动失效
//   2. log 增量追加 — append 只写一行到 .tail 文件，全量写只在 compact 时
//   3. blob 快速路径 — ≤4KB 不压缩(纯JSON)，>4KB 用 brotli(解压比gzip快3x)
//   4. 空闲压缩 — log compact 异步执行，不阻塞 save
//
// 物理布局 (rootDir = 由调用方传入，如 project/_qqq/qgf)：
//   ns/{ns}/{safeKey}.{json|bin|log}       ← payload
//   locks/{ns}__{safeKey}.lock              ← 文件锁
//   corrupt/                                ← 损坏隔离
//   outbox/                                 ← 云端同步队列
//
// 零依赖 — 只用 node fs/zlib/crypto/path/events。
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types (compatible with state-sqlite.ts)
// ---------------------------------------------------------------------------

export type StateForm = 'doc' | 'blob' | 'log';

export type Merger = (local: any, remote: any, ctx?: { ns: string; key: string }) => any;

export interface NsSchema {
    v: number;
    form: StateForm;
    quotaBytes?: number;
    merger?: Merger;
    cloud?: boolean;
    debounceMs?: number;
    compactThresholdBytes?: number;  // log only
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
const DEFAULT_LOG_COMPACT_BYTES = 2 * 1024 * 1024;
const LOCK_STALE_MS = 60_000;
const MAX_SAFE_NAME = 200;
const BAD_CHARS_RE = /[/\\:*?"<>|\x00-\x1f]/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs(): number { return Date.now(); }

function safeName(s: string): string {
    if (s === null || s === undefined) return '_';
    let v = String(s).replace(BAD_CHARS_RE, '_').replace(/^\.+/, '_').trim();
    if (!v) v = '_';
    if (v.length > MAX_SAFE_NAME) {
        const h = crypto.createHash('sha256').update(v).digest('hex').slice(0, 32);
        v = v.slice(0, MAX_SAFE_NAME - 33) + '_' + h;
    }
    return v;
}

/** Atomic write: tmp file then rename over target. 绝不先删后改（防崩溃丢数据）。 */
export async function atomicWrite(absPath: string, data: Buffer | string): Promise<void> {
    const dir = path.dirname(absPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = absPath + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 8);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    await fs.promises.writeFile(tmp, buf as any);
    try {
        await fs.promises.rename(tmp, absPath);
    } catch (e: any) {
        if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
            // ★ 降级为 copy+unlink，绝不先删后改
            try {
                const data = await fs.promises.readFile(tmp);
                await fs.promises.writeFile(absPath, data);
            } catch (e2) {
                try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
                throw e2;
            }
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
            // ★ 降级为 copy+unlink，绝不先删后改
            try {
                const data = fs.readFileSync(tmp);
                fs.writeFileSync(absPath, data);
            } catch (e2) {
                try { fs.unlinkSync(tmp); } catch { /* ignore */ }
                throw e2;
            }
        } else {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            throw e;
        }
    }
}

/** Atomic read: simple fs readFile wrapper（qgf 真理机统一入口）。 */
export async function atomicRead(absPath: string): Promise<string> {
    const buf = await fs.promises.readFile(absPath);
    return buf.toString('utf8');
}

// ---------------------------------------------------------------------------
// Internal state per key
// ---------------------------------------------------------------------------

interface KeyState {
    ns: string;
    key: string;
    safeNs: string;
    safeKey: string;
    value: any;
    dirty: boolean;
    saveChain: Promise<void>;
    debounceTimer?: NodeJS.Timeout;
    loaded: boolean;
    _logTail?: any[];   // ★ incremental log: events since last full save
}

// ---------------------------------------------------------------------------
// Qgf — FS 原子读写真理机器
// ---------------------------------------------------------------------------

export class Qgf extends EventEmitter {
    private rootDir: string;
    private nsDir: string;
    private locksDir: string;
    private outboxDir: string;
    private corruptDir: string;

    private outboxSeq = 0;
    private lastSyncAt?: number;

    private schemas: Map<string, NsSchema> = new Map();
    private states: Map<string, KeyState> = new Map();
    private _dirCache: Map<string, string[]> = new Map();  // ★ ns → key list cache

    /** Hook for cloud sync (qgf doesn't auto-push; state-cloud.ts drains outbox). */
    public onCloudDirty: ((ns: string, key: string) => void) | null = null;

    // ★ blob fast path threshold
    private static readonly BLOB_NOCOMPRESS_BYTES = 4096;

    // ----- constructor --------------------------------------------------------

    /**
    * @param rootDir  e.g. "/path/to/project/_qqq/qgf""
     */
    constructor(rootDir: string) {
        super();
        this.setMaxListeners(0);
        this.rootDir = rootDir;
        this.nsDir = path.join(rootDir, 'ns');
        this.locksDir = path.join(rootDir, 'locks');
        this.outboxDir = path.join(rootDir, 'outbox');
        this.corruptDir = path.join(rootDir, 'corrupt');
        for (const d of [this.nsDir, this.locksDir, this.outboxDir, this.corruptDir]) {
            try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
        }
        this._restoreOutboxSeq();
    }

    private _restoreOutboxSeq(): void {
        try {
            for (const f of fs.readdirSync(this.outboxDir)) {
                const m = f.match(/^(\d+)\.json$/);
                if (m) { const n = parseInt(m[1], 10); if (n > this.outboxSeq) this.outboxSeq = n; }
            }
        } catch { /* ignore */ }
    }

    // ----- introspection ------------------------------------------------------

    stats(): StatsSnapshot {
        let dirty = 0;
        for (const st of this.states.values()) { if (st.dirty) dirty++; }
        let outbox = 0;
        try { outbox = fs.readdirSync(this.outboxDir).filter(f => f.endsWith('.json')).length; } catch { /* ignore */ }
        return { dirtyKeys: dirty, queuedOutbox: outbox, lastSyncAt: this.lastSyncAt, namespaces: this.schemas.size };
    }

    markSyncedAt(t: number): void { this.lastSyncAt = t; }

    getRegisteredNs(): string[] { return Array.from(this.schemas.keys()); }
    getSchema(ns: string): NsSchema | undefined { return this.schemas.get(ns); }

    // ----- registration -------------------------------------------------------

    register(ns: string, schema: NsSchema): void {
        if (!ns || typeof ns !== 'string') throw new Error('qgf.register: bad ns');
        if (!schema || !['doc', 'blob', 'log'].includes(schema.form))
            throw new Error('qgf.register: schema.form must be doc/blob/log');
        if (typeof schema.v !== 'number' || schema.v < 1) throw new Error('qgf.register: schema.v >=1');
        const existing = this.schemas.get(ns);
        if (existing && existing.form !== schema.form)
            throw new Error(`qgf.register: ns "${ns}" form mismatch`);
        this.schemas.set(ns, schema);
    }

    // ----- path helpers -------------------------------------------------------

    private _payloadPath(safeNs: string, safeKey: string, form: StateForm): string {
        const ext = form === 'doc' ? '.json' : form === 'blob' ? '.bin' : '.log';
        return path.join(this.nsDir, safeNs, safeKey + ext);
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
        if (!sc) throw new Error(`qgf: ns "${ns}" not registered`);
        return sc;
    }

    // ★ Invalidate directory cache for a namespace.
    private _invalidateDirCache(ns: string): void {
        this._dirCache.delete(ns);
    }

    // ----- encode / decode ----------------------------------------------------

    private _encode(form: StateForm, value: any): Buffer {
        if (form === 'doc') return Buffer.from(JSON.stringify(value), 'utf8');
        if (form === 'blob') {
            const json = Buffer.from(JSON.stringify(value), 'utf8');
            // ★ Small blobs: plain JSON (instant read, zero decompression)
            if (json.length <= Qgf.BLOB_NOCOMPRESS_BYTES) return json;
            // ★ Large blobs: brotli (faster decompress than gzip, built-in Node.js)
            return zlib.brotliCompressSync(json as any);
        }
        if (!Array.isArray(value)) value = [];
        const lines = (value as any[]).map(ev => JSON.stringify(ev)).join('\n');
        return Buffer.from(lines + (lines ? '\n' : ''), 'utf8');
    }

    private _decode(form: StateForm, buf: Buffer): any {
        if (form === 'doc') return JSON.parse(buf.toString('utf8'));
        if (form === 'blob') {
            // ★ Auto-detect: JSON starts with '{' or '[', brotli starts with 0xCE
            const first = buf.length > 0 ? buf[0] : 0;
            if (first === 0x7B || first === 0x5B) {
                return JSON.parse(buf.toString('utf8'));  // plain JSON (small blob)
            }
            const json = zlib.brotliDecompressSync(buf as any).toString('utf8');
            return JSON.parse(json);
        }
        const txt = buf.toString('utf8');
        const out: any[] = [];
        for (const line of txt.split(/\r?\n/)) {
            const t = line.trim();
            if (!t) continue;
            try { out.push(JSON.parse(t)); } catch { /* skip bad line */ }
        }
        return out;
    }

    // ----- file lock (O_EXCL + stale detection) --------------------------------

    private async _acquireLock(safeNs: string, safeKey: string): Promise<string> {
        const lp = this._lockPath(safeNs, safeKey);
        await fs.promises.mkdir(path.dirname(lp), { recursive: true });
        for (let i = 0; i < 40; i++) {
            try {
                const fd = fs.openSync(lp, 'wx');
                fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: nowMs() }));
                fs.closeSync(fd);
                return lp;
            } catch (e: any) {
                if (e && e.code === 'EEXIST') {
                    let stale = false;
                    try {
                        const info = JSON.parse(fs.readFileSync(lp, 'utf8'));
                        if (typeof info.ts === 'number' && (nowMs() - info.ts) > LOCK_STALE_MS) stale = true;
                    } catch { stale = true; }
                    if (stale) { try { fs.unlinkSync(lp); } catch { /* ignore */ } continue; }
                    await new Promise(r => setTimeout(r, 50));
                    continue;
                }
                throw e;
            }
        }
        console.warn('[qgf] _acquireLock timeout', lp);
        return lp;
    }

    private _releaseLock(lp: string): void {
        try { fs.unlinkSync(lp); } catch { /* ignore */ }
    }

    // ----- corrupt isolation --------------------------------------------------

    private _quarantine(safeNs: string, safeKey: string, form: StateForm, reason: string): void {
        try {
            const src = this._payloadPath(safeNs, safeKey, form);
            if (!fs.existsSync(src)) return;
            const ext = path.extname(src);
            const ts = nowMs();
            const dst = path.join(this.corruptDir, safeNs + '__' + safeKey + '.' + ts + ext);
            fs.mkdirSync(this.corruptDir, { recursive: true });
            fs.renameSync(src, dst);
            console.warn('[qgf] quarantined', src, '->', dst, 'reason=', reason);
        } catch (e) { console.warn('[qgf] _quarantine failed:', e); }
    }

    // ----- load ---------------------------------------------------------------

    private async _loadFromDisk(st: KeyState): Promise<void> {
        const sc = this._requireSchema(st.ns);
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        if (!fs.existsSync(payload)) {
            st.value = sc.form === 'log' ? [] : null;
            st.loaded = true;
            return;
        }
        try {
            const buf = await fs.promises.readFile(payload);
            st.value = this._decode(sc.form, buf);
            // ★ merge incremental tail for log form
            if (sc.form === 'log') {
                const tailPath = payload + '.tail';
                if (fs.existsSync(tailPath)) {
                    try {
                        const tailBuf = await fs.promises.readFile(tailPath);
                        const tailEvents = this._decode(sc.form, tailBuf);
                        if (Array.isArray(tailEvents) && tailEvents.length > 0) {
                            if (!Array.isArray(st.value)) st.value = [];
                            st.value.push(...tailEvents);
                        }
                    } catch { /* tail corrupt, ignore */ }
                }
                st._logTail = [];
            }
            st.loaded = true;
        } catch (e) {
            console.warn('[qgf] decode failed for', st.ns, st.key, '— quarantining:', e);
            this._quarantine(st.safeNs, st.safeKey, sc.form, String(e));
            st.value = sc.form === 'log' ? [] : null;
            st.loaded = true;
        }
    }

    private async _ensureLoaded(st: KeyState): Promise<void> {
        if (!st.loaded) await this._loadFromDisk(st);
    }

    // ----- public API ---------------------------------------------------------

    async get(ns: string, key: string): Promise<any> {
        this._requireSchema(ns);
        const st = this._resolveKeyState(ns, key);
        await this._ensureLoaded(st);
        return st.value;
    }

    async set(ns: string, key: string, value: any): Promise<void> {
        const sc = this._requireSchema(ns);
        if (sc.form === 'log' && !Array.isArray(value))
            throw new Error(`qgf.set on log form requires array; ns=${ns} key=${key}`);
        const st = this._resolveKeyState(ns, key);
        await this._ensureLoaded(st);
        st.value = value;
        st.dirty = true;
        this._scheduleSave(st, sc);
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async setNow(ns: string, key: string, value: any): Promise<void> {
        const sc = this._requireSchema(ns);
        if (sc.form === 'log' && !Array.isArray(value))
            throw new Error(`qgf.setNow on log form requires array; ns=${ns} key=${key}`);
        const st = this._resolveKeyState(ns, key);
        await this._ensureLoaded(st);
        st.value = value;
        st.dirty = true;
        await this._flushKey(st, sc);
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async append(ns: string, key: string, event: any): Promise<void> {
        const sc = this._requireSchema(ns);
        if (sc.form !== 'log') throw new Error(`qgf.append only for log form; ns=${ns}`);
        const st = this._resolveKeyState(ns, key);
        await this._ensureLoaded(st);
        if (!Array.isArray(st.value)) st.value = [];
        if (!st._logTail) st._logTail = [];
        st.value.push(event);
        st._logTail.push(event);
        st.dirty = true;
        // ★ Incremental: write single event to tail file immediately
        const tailPath = this._payloadPath(st.safeNs, st.safeKey, sc.form) + '.tail';
        const line = JSON.stringify(event) + '\n';
        try {
            await fs.promises.mkdir(path.dirname(tailPath), { recursive: true });
            await fs.promises.appendFile(tailPath, line, 'utf8');
        } catch { /* tail write failed, full save will catch up */ }
        this._scheduleSave(st, sc);
        if (sc.cloud && this.onCloudDirty) { try { this.onCloudDirty(ns, key); } catch { /* ignore */ } }
    }

    async del(ns: string, key: string): Promise<boolean> {
        const sc = this._requireSchema(ns);
        const st = this._resolveKeyState(ns, key);
        if (st.debounceTimer) { clearTimeout(st.debounceTimer); st.debounceTimer = undefined; }
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        let any = false;
        try { if (fs.existsSync(payload)) { await fs.promises.unlink(payload); any = true; } } catch { /* ignore */ }
        // Also delete tail file if exists
        try { const tp = payload + '.tail'; if (fs.existsSync(tp)) await fs.promises.unlink(tp); } catch { /* ignore */ }
        this.states.delete(ns + '\u0000' + key);
        this._invalidateDirCache(ns);
        if (any) {
            this.emit('changed', { ns, key, value: null, deleted: true });
            if (sc.cloud) this._queueOutbox(ns, key, null, true);
        }
        return any;
    }

    async list(ns: string): Promise<string[]> {
        this._requireSchema(ns);
        // ★ cache hit — avoid fs.readdir
        const cached = this._dirCache.get(ns);
        if (cached) return cached;

        const dir = path.join(this.nsDir, safeName(ns));
        const out: string[] = [];
        try {
            for (const f of await fs.promises.readdir(dir)) {
                if (f.endsWith('.tmp')) continue;
                if (f.endsWith('.tail')) continue;  // log tail files
                const m = f.match(/^(.+)\.(json|bin|log)$/);
                if (m) out.push(m[1]);
            }
        } catch { /* nonexistent */ }
        this._dirCache.set(ns, out);
        return out;
    }

    // ----- save chain ---------------------------------------------------------

    private _scheduleSave(st: KeyState, sc: NsSchema): void {
        const ms = typeof sc.debounceMs === 'number' ? sc.debounceMs : DEFAULT_DEBOUNCE_MS;
        if (st.debounceTimer) clearTimeout(st.debounceTimer);
        st.debounceTimer = setTimeout(() => {
            st.debounceTimer = undefined;
            st.saveChain = st.saveChain.then(() => this._doSaveOnce(st, sc)).catch(e => {
                console.warn('[qgf] save error', st.ns, st.key, e);
            });
        }, ms);
    }

    private async _flushKey(st: KeyState, sc: NsSchema): Promise<void> {
        if (st.debounceTimer) { clearTimeout(st.debounceTimer); st.debounceTimer = undefined; }
        st.saveChain = st.saveChain.then(() => this._doSaveOnce(st, sc));
        await st.saveChain;
    }

    async flush(): Promise<void> {
        const tasks: Promise<void>[] = [];
        for (const st of this.states.values()) {
            const sc = this.schemas.get(st.ns);
            if (!sc) continue;
            if (st.dirty || st.debounceTimer) tasks.push(this._flushKey(st, sc));
        }
        await Promise.all(tasks);
    }

    async flushOne(ns: string, key: string): Promise<void> {
        const id = ns + '\u0000' + key;
        const st = this.states.get(id);
        if (!st) return;
        const sc = this.schemas.get(ns);
        if (!sc) return;
        await this._flushKey(st, sc);
    }

    flushSync(): void {
        for (const st of this.states.values()) {
            const sc = this.schemas.get(st.ns);
            if (!sc) continue;
            if (st.debounceTimer) { clearTimeout(st.debounceTimer); st.debounceTimer = undefined; }
            if (!st.dirty) continue;
            try { this._doSaveOnceSync(st, sc); } catch (e) {
                console.warn('[qgf] flushSync error', st.ns, st.key, e);
            }
        }
    }

    // ----- the actual save ----------------------------------------------------

    private async _doSaveOnce(st: KeyState, sc: NsSchema): Promise<void> {
        if (!st.dirty) return;
        const lp = await this._acquireLock(st.safeNs, st.safeKey);
        try {
            // ★ For log form: re-read tail to catch events from other processes
            if (sc.form === 'log') {
                const tailPath = this._payloadPath(st.safeNs, st.safeKey, sc.form) + '.tail';
                if (fs.existsSync(tailPath)) {
                    try {
                        const tailBuf = await fs.promises.readFile(tailPath);
                        const tailEvents = this._decode(sc.form, tailBuf);
                        if (Array.isArray(tailEvents) && tailEvents.length > 0) {
                            if (!Array.isArray(st.value)) st.value = [];
                            const seen = new Set((st.value as any[]).map(e => JSON.stringify(e)));
                            for (const ev of tailEvents) {
                                const k = JSON.stringify(ev);
                                if (!seen.has(k)) { seen.add(k); st.value.push(ev); }
                            }
                        }
                    } catch { /* ignore */ }
                }
            }
            await this._mergeFromDisk(st, sc);
            let buf = this._encode(sc.form, st.value);

            if (sc.quotaBytes && buf.length > sc.quotaBytes) {
                if (sc.form === 'log' && Array.isArray(st.value)) {
                    st.value = (st.value as any[]).slice(Math.floor(st.value.length / 2));
                    buf = this._encode(sc.form, st.value);
                }
                if (buf.length > sc.quotaBytes) throw new Error('quota exceeded');
            }

            // ★ Deferred compaction flag (actual compact runs async after save)
            const needsCompact = sc.form === 'log' && sc.compactThresholdBytes && buf.length > sc.compactThresholdBytes;

            const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
            await atomicWrite(payload, buf);

            // ★ Clear incremental tail after full save
            if (sc.form === 'log') {
                st._logTail = [];
                const tailPath = payload + '.tail';
                try { if (fs.existsSync(tailPath)) await fs.promises.unlink(tailPath); } catch { /* ignore */ }
            }
            st.dirty = false;
            this._invalidateDirCache(st.ns);
            if (sc.cloud) this._queueOutbox(st.ns, st.key, st.value, false);
            this.emit('changed', { ns: st.ns, key: st.key, value: st.value, deleted: false });

            // ★ Deferred compaction: run async after save, avoids blocking
            if (needsCompact) {
                setImmediate(() => this._maybeCompact(st, sc).catch(() => { }));
            }
        } finally {
            this._releaseLock(lp);
        }
    }

    private _doSaveOnceSync(st: KeyState, sc: NsSchema): void {
        if (!st.dirty) return;
        const buf = this._encode(sc.form, st.value);
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        atomicWriteSync(payload, buf);
        st.dirty = false;
        this._invalidateDirCache(st.ns);
        if (sc.cloud) this._queueOutbox(st.ns, st.key, st.value, false);
    }

    // ----- merge-on-save ------------------------------------------------------

    private async _mergeFromDisk(st: KeyState, sc: NsSchema): Promise<void> {
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        if (!fs.existsSync(payload)) return;
        let diskVal: any;
        try {
            diskVal = this._decode(sc.form, await fs.promises.readFile(payload));
        } catch { return; }

        try {
            if (sc.form === 'log' && Array.isArray(diskVal) && Array.isArray(st.value)) {
                const seen = new Set<string>();
                const out: any[] = [];
                for (const ev of diskVal) { const k = JSON.stringify(ev); if (!seen.has(k)) { seen.add(k); out.push(ev); } }
                for (const ev of st.value) { const k = JSON.stringify(ev); if (!seen.has(k)) { seen.add(k); out.push(ev); } }
                st.value = sc.merger ? sc.merger(diskVal, st.value, { ns: st.ns, key: st.key }) : out;
            } else {
                st.value = sc.merger
                    ? sc.merger(diskVal, st.value, { ns: st.ns, key: st.key })
                    : st.value;
            }
        } catch (e) {
            console.warn('[qgf] merger threw — keeping in-memory value', st.ns, st.key, e);
        }
    }

    // ----- log compaction -----------------------------------------------------

    private _compactLog(st: KeyState, sc: NsSchema): any[] | null {
        if (!Array.isArray(st.value)) return null;
        if (sc.merger) {
            try {
                const compacted = sc.merger([], st.value, { ns: st.ns, key: st.key });
                if (Array.isArray(compacted)) return compacted;
            } catch (e) { console.warn('[qgf] compactLog merger threw', st.ns, st.key, e); }
        }
        return (st.value as any[]).slice(Math.floor(st.value.length / 2));
    }

    /** ★ Async log compaction — non-blocking, runs after save completes. */
    private async _maybeCompact(st: KeyState, sc: NsSchema): Promise<void> {
        if (!Array.isArray(st.value)) return;
        const compacted = this._compactLog(st, sc);
        if (!compacted) return;
        st.value = compacted;
        st.dirty = true;
        const buf = this._encode(sc.form, st.value);
        const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
        await atomicWrite(payload, buf);
        st.dirty = false;
        this._invalidateDirCache(st.ns);
        if (sc.cloud) this._queueOutbox(st.ns, st.key, st.value, false);
    }

    // ----- outbox (cloud-sync queue) ------------------------------------------

    private _queueOutbox(ns: string, key: string, value: any, deleted: boolean): void {
        try {
            this.outboxSeq += 1;
            const seq = String(this.outboxSeq).padStart(12, '0');
            const f = path.join(this.outboxDir, seq + '.json');
            const payload = { seq, ns, key, ts: nowMs(), deleted, value: deleted ? null : value };
            atomicWriteSync(f, JSON.stringify(payload));
        } catch (e) { console.warn('[qgf] _queueOutbox failed:', e); }
    }

    listOutbox(): { seq: string; file: string }[] {
        const out: { seq: string; file: string }[] = [];
        try {
            const files = fs.readdirSync(this.outboxDir).filter(f => f.endsWith('.json')).sort();
            for (const f of files) out.push({ seq: f.replace(/\.json$/, ''), file: path.join(this.outboxDir, f) });
        } catch { /* ignore */ }
        return out;
    }

    dropOutbox(seq: string): boolean {
        const f = path.join(this.outboxDir, seq + '.json');
        try { fs.unlinkSync(f); return true; } catch { return false; }
    }

    // ----- onChange convenience -----------------------------------------------

    onChange(ns: string, key: string, cb: (val: any, deleted: boolean) => void): () => void {
        const h = (msg: { ns: string; key: string; value: any; deleted: boolean }) => {
            if (msg.ns === ns && msg.key === key) cb(msg.value, msg.deleted);
        };
        this.on('changed', h);
        return () => { this.off('changed', h); };
    }
}
