// ============================================================================
// cache-store.ts
// Two-tier portable cache rooted at $QQQIDE_QDIR/cache (or portable.cache):
//   - KV  : cache/kv/<safekey>.json
//   - file: cache/h/<aa>/<aabbcc...><ext>     (bucketed by content sig)
//
// Designed to be the canonical sink for:
//   - hash-service mtime cache
//   - media-service ffmpeg outputs (thumb/transcode), keyed by input sig
//   - paste-everything dedup'd blobs
//
// Keys are arbitrary user strings; they are hashed to a safe filename internally.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export interface CachePutOpts {
    /** When true the value is a base64-encoded Buffer (default: auto-detect Buffer). */
    base64?: boolean;
    /** Optional extension for file-bucket layout (used when bucketPath() is used by caller). */
    ext?: string;
    /** Optional TTL in ms (records mtime check on get; older means miss). */
    ttlMs?: number;
}

interface KvEntry {
    v: any;
    t: number;          // write time
    ttl?: number;       // ttl ms
}

export class CacheStore {
    private kvDir: string;
    private bucketRoot: string;
    private hashDir: string;

    constructor(public root: string) {
        this.kvDir = path.join(root, 'kv');
        this.bucketRoot = path.join(root, 'h');     // file bucket
        this.hashDir = path.join(root, 'hash');     // hash-service mtime db
        for (const d of [root, this.kvDir, this.bucketRoot, this.hashDir]) {
            try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
        }
    }

    // ----- safe key -> filename ------------------------------------------------
    private keyToFile(key: string): string {
        const h = crypto.createHash('sha256').update(String(key)).digest('hex');
        return path.join(this.kvDir, h.slice(0, 2), h + '.json');
    }

    // ----- KV API -------------------------------------------------------------

    async has(key: string): Promise<boolean> {
        const p = this.keyToFile(key);
        return fs.existsSync(p);
    }

    async get(key: string): Promise<any> {
        const p = this.keyToFile(key);
        try {
            const raw = await fs.promises.readFile(p, 'utf8');
            const ent = JSON.parse(raw) as KvEntry;
            if (ent.ttl && (Date.now() - ent.t) > ent.ttl) { return null; }
            return ent.v;
        } catch { return null; }
    }

    async put(key: string, value: any, opts?: CachePutOpts): Promise<boolean> {
        const p = this.keyToFile(key);
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        const ent: KvEntry = { v: value, t: Date.now() };
        if (opts && opts.ttlMs) { ent.ttl = opts.ttlMs; }
        try {
            await fs.promises.writeFile(p, JSON.stringify(ent), 'utf8');
            return true;
        } catch (e) {
            console.warn('[cache] put failed:', key, e);
            return false;
        }
    }

    async del(key: string): Promise<boolean> {
        const p = this.keyToFile(key);
        try { await fs.promises.unlink(p); return true; }
        catch { return false; }
    }

    /** Absolute filesystem path of the KV entry for a key (may not exist). */
    async path(key: string): Promise<string> {
        return this.keyToFile(key);
    }

    // ----- File bucket --------------------------------------------------------

    /**
     * Resolve the bucketed path for a content signature (typically a hex hash).
     * `sig` is the full hash; bucket = first 2 chars.
     * Returns absolute path, regardless of whether the file exists.
     */
    bucketPath(sig: string, ext?: string): string {
        const clean = String(sig || '').replace(/[^a-zA-Z0-9]/g, '');
        if (!clean) { throw new Error('bucketPath: empty sig'); }
        const bucket = clean.slice(0, 2).toLowerCase();
        const dir = path.join(this.bucketRoot, bucket);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
        const safeExt = ext && /^\.[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : '';
        return path.join(dir, clean + safeExt);
    }

    /** Hash-service mtime db dir (kept separate so we can clean independently). */
    hashDbDir(): string { return this.hashDir; }
}
