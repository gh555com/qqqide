// ============================================================================
// hash-service.ts
// File / buffer fingerprinting with mtime cache (h.js algorithm port).
//
//   - fast   : xxh64 (pure JS, branch-light) over up to 4 MB stream
//   - strong : sha256 via node crypto over full stream
//   - both   : compute fast first; then strong; both cached
//
// File-level cache key:  abspath + size + mtimeMs  (so edits invalidate)
// Stored at CacheStore.hashDbDir()/<sha256(key)>.json
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CacheStore } from './cache-store';

export interface HashResult {
    xxh64?: string;       // 16-hex lowercase
    sha256?: string;      // 64-hex lowercase
    size: number;
    mtimeMs?: number;
}

export class HashService {
    constructor(private cache: CacheStore) {}

    // -------------------------------------------------------------------------
    // xxh64 (pure JS, big-int based; matches h.js output)
    // -------------------------------------------------------------------------

    private static readonly PRIME64_1 = 0x9E3779B185EBCA87n;
    private static readonly PRIME64_2 = 0xC2B2AE3D27D4EB4Fn;
    private static readonly PRIME64_3 = 0x165667B19E3779F9n;
    private static readonly PRIME64_4 = 0x85EBCA77C2B2AE63n;
    private static readonly PRIME64_5 = 0x27D4EB2F165667C5n;
    private static readonly MASK64    = 0xFFFFFFFFFFFFFFFFn;

    private static rotl64(x: bigint, r: number): bigint {
        return ((x << BigInt(r)) | (x >> BigInt(64 - r))) & HashService.MASK64;
    }

    private static round(acc: bigint, input: bigint): bigint {
        let a = (acc + ((input & HashService.MASK64) * HashService.PRIME64_2)) & HashService.MASK64;
        a = HashService.rotl64(a, 31);
        return (a * HashService.PRIME64_1) & HashService.MASK64;
    }

    private static mergeRound(acc: bigint, val: bigint): bigint {
        const v = HashService.round(0n, val);
        let a = acc ^ v;
        a = (a * HashService.PRIME64_1 + HashService.PRIME64_4) & HashService.MASK64;
        return a;
    }

    /** xxh64 of an entire Buffer (seed = 0). */
    public static xxh64(buf: Buffer, seed: bigint = 0n): string {
        const len = buf.length;
        let h: bigint;
        let p = 0;
        if (len >= 32) {
            let v1 = (seed + HashService.PRIME64_1 + HashService.PRIME64_2) & HashService.MASK64;
            let v2 = (seed + HashService.PRIME64_2) & HashService.MASK64;
            let v3 = seed;
            let v4 = (seed - HashService.PRIME64_1) & HashService.MASK64;
            while (p + 32 <= len) {
                v1 = HashService.round(v1, buf.readBigUInt64LE(p)); p += 8;
                v2 = HashService.round(v2, buf.readBigUInt64LE(p)); p += 8;
                v3 = HashService.round(v3, buf.readBigUInt64LE(p)); p += 8;
                v4 = HashService.round(v4, buf.readBigUInt64LE(p)); p += 8;
            }
            h = (HashService.rotl64(v1, 1) + HashService.rotl64(v2, 7)
                + HashService.rotl64(v3, 12) + HashService.rotl64(v4, 18)) & HashService.MASK64;
            h = HashService.mergeRound(h, v1);
            h = HashService.mergeRound(h, v2);
            h = HashService.mergeRound(h, v3);
            h = HashService.mergeRound(h, v4);
        } else {
            h = (seed + HashService.PRIME64_5) & HashService.MASK64;
        }
        h = (h + BigInt(len)) & HashService.MASK64;
        while (p + 8 <= len) {
            const k1 = HashService.round(0n, buf.readBigUInt64LE(p));
            h ^= k1;
            h = ((HashService.rotl64(h, 27) * HashService.PRIME64_1) + HashService.PRIME64_4) & HashService.MASK64;
            p += 8;
        }
        if (p + 4 <= len) {
            h ^= ((BigInt(buf.readUInt32LE(p))) * HashService.PRIME64_1) & HashService.MASK64;
            h = ((HashService.rotl64(h, 23) * HashService.PRIME64_2) + HashService.PRIME64_3) & HashService.MASK64;
            p += 4;
        }
        while (p < len) {
            h ^= (BigInt(buf[p]) * HashService.PRIME64_5) & HashService.MASK64;
            h = (HashService.rotl64(h, 11) * HashService.PRIME64_1) & HashService.MASK64;
            p += 1;
        }
        h ^= h >> 33n;
        h = (h * HashService.PRIME64_2) & HashService.MASK64;
        h ^= h >> 29n;
        h = (h * HashService.PRIME64_3) & HashService.MASK64;
        h ^= h >> 32n;
        return h.toString(16).padStart(16, '0');
    }

    // -------------------------------------------------------------------------
    // Buffer hashing
    // -------------------------------------------------------------------------

    hashBuffer(buf: Buffer, mode: 'fast' | 'strong' | 'both' = 'fast'): HashResult {
        const r: HashResult = { size: buf.length };
        if (mode === 'fast' || mode === 'both') {
            r.xxh64 = HashService.xxh64(buf);
        }
        if (mode === 'strong' || mode === 'both') {
            r.sha256 = crypto.createHash('sha256').update(buf as any).digest('hex');
        }
        return r;
    }

    // -------------------------------------------------------------------------
    // File hashing (with mtime cache)
    // -------------------------------------------------------------------------

    private cacheKey(absPath: string, size: number, mtimeMs: number): string {
        return `hash:${absPath}|${size}|${Math.floor(mtimeMs)}`;
    }

    async hashFile(absPath: string, mode: 'fast' | 'strong' | 'both' = 'fast'): Promise<HashResult> {
        const stat = await fs.promises.stat(absPath);
        const key = this.cacheKey(absPath, stat.size, stat.mtimeMs);
        const cached = await this.cache.get(key) as HashResult | null;
        if (cached) {
            const need = (mode === 'fast' && cached.xxh64)
                || (mode === 'strong' && cached.sha256)
                || (mode === 'both' && cached.xxh64 && cached.sha256);
            if (need) { return cached; }
        }

        // Stream-compute whichever the cache is missing.
        const want = {
            fast: (mode === 'fast' || mode === 'both') && !(cached && cached.xxh64),
            strong: (mode === 'strong' || mode === 'both') && !(cached && cached.sha256),
        };

        const out: HashResult = { ...(cached || { size: stat.size }), size: stat.size, mtimeMs: stat.mtimeMs };

        if (want.strong || want.fast) {
            // For strong, use streaming sha256 (no memory cap).
            // For fast (xxh64), our current impl needs a full Buffer; cap at 64 MB.
            // For files larger than 64 MB, use sha256 only as the "fast" stand-in
            // (it's still hardware-accelerated and ~250 MB/s on modern CPUs).
            const FAST_CAP = 64 * 1024 * 1024;
            const useFullBuf = want.fast && stat.size <= FAST_CAP;

            if (useFullBuf) {
                const buf = await fs.promises.readFile(absPath);
                out.xxh64 = HashService.xxh64(buf);
                if (want.strong) {
                    out.sha256 = crypto.createHash('sha256').update(buf as any).digest('hex');
                }
            } else {
                // stream sha256; xxh64 unavailable for huge files
                const h = crypto.createHash('sha256');
                const stream = fs.createReadStream(absPath);
                await new Promise<void>((resolve, reject) => {
                    stream.on('data', d => h.update(d as any));
                    stream.on('end', () => resolve());
                    stream.on('error', reject);
                });
                if (want.strong) { out.sha256 = h.digest('hex'); }
                if (want.fast && !out.xxh64) {
                    // Fallback: first 12 hex of sha256 as a non-crypto-grade fast id
                    out.xxh64 = (out.sha256 || h.digest('hex')).slice(0, 16);
                }
            }
        }

        // Write back composite
        try { await this.cache.put(key, out); } catch { /* ignore */ }
        return out;
    }
}
