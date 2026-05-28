// ============================================================================
// state-cloud.ts
// Cloud sync submodule for StateStore. "完全手动" mode (老 qqq AQ 模式):
// nothing is auto-pushed; user must explicitly invoke pull() / push() / sync().
//
// Protocol (sympatico with q3/global.js USER_DATA endpoints):
//   POST https://gh555.com/api/gaea/qqq/state/pull
//     body: { phone, token, device_id, device_name, keys: ['ns/key', ...] }
//     resp: { ok, blobs: { 'ns/key': { data, ts, etag, v, form } } }
//   POST https://gh555.com/api/gaea/qqq/state/push
//     body: { phone, token, device_id, device_name, blobs: { 'ns/key': { data, ts, v, form, deleted } } }
//     resp: { ok, accepted: [...], rejected: [{ key, reason }] }
//
// Auth: read ~/.qqq/auth.json (same file qqq has always used). Missing → return
// { ok: false, reason: 'no-auth' } gracefully.
//
// data field is the value, JSON-serialisable. For blob form we still send the
// decoded value (already in memory) — the server stores opaque JSON. Devices
// re-encode locally on pull. This keeps the wire schema human-readable.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { StateStore } from './state-sqlite';

const AUTH_FILE = path.join(os.homedir(), '.qqq', 'auth.json');
const CLOUD_BASE = process.env.QQQ_CLOUD_BASE || 'https://gh555.com';
const REQ_TIMEOUT_MS = 12000;

interface Auth { phone: string; token: string; device_name?: string; }

interface CloudBlob { data: any; ts: number; v: number; form: string; etag?: string; deleted?: boolean; }

export interface PullResult { ok: boolean; reason?: string; pulled: string[]; conflicts: string[]; }
export interface PushResult { ok: boolean; reason?: string; pushed: string[]; failed: string[]; }
export interface SyncResult { ok: boolean; reason?: string; pull?: PullResult; push?: PushResult; }

function readAuth(): Auth | null {
    try {
        if (!fs.existsSync(AUTH_FILE)) { return null; }
        const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
        if (!j || !j.phone || !j.token) { return null; }
        return { phone: String(j.phone), token: String(j.token), device_name: j.device_name || os.hostname() };
    } catch { return null; }
}

function httpsPostJson(urlStr: string, body: any): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        let u: URL;
        try { u = new URL(urlStr); } catch (e) { return reject(e); }
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;
        const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
        const req = lib.request({
            method: 'POST',
            protocol: u.protocol,
            host: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + (u.search || ''),
            headers: {
                'content-type': 'application/json',
                'content-length': String(data.length),
                'user-agent': 'qqq-shell-state-cloud/1',
            },
            timeout: REQ_TIMEOUT_MS,
        }, res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks as any).toString('utf8');
                let json: any = null;
                try { json = raw ? JSON.parse(raw) : {}; }
                catch { json = { _raw: raw }; }
                resolve({ status: res.statusCode || 0, json });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.write(data as any);
        req.end();
    });
}

export class StateCloud {
    private store: StateStore;

    constructor(store: StateStore) {
        this.store = store;
        // Hook: when a cloud-enabled key gets dirty, we just observe (no auto-push).
        // The hook exists so we can later add "background staging" without API change.
        this.store.onCloudDirty = (_ns, _key) => { /* manual mode: noop */ };
    }

    // -----------------------------------------------------------------------
    // List all cloud-eligible keys from currently registered namespaces.
    // -----------------------------------------------------------------------
    private async _enumerateCloudKeys(): Promise<string[]> {
        const out: string[] = [];
        for (const ns of this.store.getRegisteredNs()) {
            const sc = this.store.getSchema(ns);
            if (!sc || !sc.cloud) { continue; }
            const keys = await this.store.list(ns);
            // safeNames may differ from logical keys; for cloud we use ns + '/' + safeKey
            // unconditionally since both sides use the same sanitiser. Logical-vs-safe
            // round-trip is preserved because the client never derives logical from safe.
            for (const k of keys) { out.push(ns + '/' + k); }
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // pull(): GET server blobs for all cloud keys; merge into local via store.
    // -----------------------------------------------------------------------
    async pull(): Promise<PullResult> {
        const auth = readAuth();
        if (!auth) { return { ok: false, reason: 'no-auth', pulled: [], conflicts: [] }; }

        const keys = await this._enumerateCloudKeys();
        const body = {
            phone: auth.phone,
            token: auth.token,
            device_id: this.store.getDeviceId(),
            device_name: auth.device_name,
            keys,
        };
        let resp;
        try { resp = await httpsPostJson(CLOUD_BASE + '/api/gaea/qqq/state/pull', body); }
        catch (e: any) { return { ok: false, reason: 'network: ' + (e && e.message), pulled: [], conflicts: [] }; }
        if (resp.status !== 200 || !resp.json || !resp.json.ok) {
            return { ok: false, reason: 'http ' + resp.status + ': ' + (resp.json && resp.json.error), pulled: [], conflicts: [] };
        }
        const blobs: Record<string, CloudBlob> = (resp.json.blobs || {});
        const pulled: string[] = [];
        const conflicts: string[] = [];
        for (const fullKey of Object.keys(blobs)) {
            const slash = fullKey.indexOf('/');
            if (slash <= 0) { continue; }
            const ns = fullKey.slice(0, slash);
            const key = fullKey.slice(slash + 1);
            const sc = this.store.getSchema(ns);
            if (!sc) { continue; }
            const blob = blobs[fullKey];
            if (blob.deleted) {
                try { await this.store.del(ns, key); pulled.push(fullKey); } catch { /* ignore */ }
                continue;
            }
            try {
                // Merge: read current local, ask schema.merger (else LWW by ts).
                const local = await this.store.get(ns, key);
                let merged: any;
                if (sc.merger) {
                    merged = sc.merger(local, blob.data, { ns, key });
                } else {
                    // LWW by ts
                    const localTs = 0; // local meta not exposed; treat as 0 → remote wins on equal-or-newer
                    merged = (blob.ts >= localTs) ? blob.data : local;
                }
                await this.store.setNow(ns, key, merged);
                pulled.push(fullKey);
            } catch (e) {
                console.warn('[cloud.pull] merge failed', fullKey, e);
                conflicts.push(fullKey);
            }
        }
        return { ok: true, pulled, conflicts };
    }

    // -----------------------------------------------------------------------
    // push(): send all outbox-queued payloads, drop on success.
    // -----------------------------------------------------------------------
    async push(): Promise<PushResult> {
        const auth = readAuth();
        if (!auth) { return { ok: false, reason: 'no-auth', pushed: [], failed: [] }; }

        const entries = this.store.listOutbox();
        if (entries.length === 0) { return { ok: true, pushed: [], failed: [] }; }

        // collapse: keep only the LAST outbox entry per (ns,key)
        const lastByKey = new Map<string, { seq: string; payload: any }>();
        for (const ent of entries) {
            try {
                const raw = fs.readFileSync(ent.file, 'utf8');
                const p = JSON.parse(raw);
                if (!p || !p.ns || !p.key) { continue; }
                lastByKey.set(p.ns + '/' + p.key, { seq: ent.seq, payload: p });
            } catch (e) {
                console.warn('[cloud.push] bad outbox entry', ent.file, e);
            }
        }

        const blobs: Record<string, CloudBlob> = {};
        for (const [fullKey, item] of lastByKey.entries()) {
            const sc = this.store.getSchema(item.payload.ns);
            if (!sc) { continue; }
            blobs[fullKey] = {
                data: item.payload.value,
                ts: item.payload.ts || Date.now(),
                v: sc.v,
                form: sc.form,
                deleted: !!item.payload.deleted,
            };
        }

        const body = {
            phone: auth.phone,
            token: auth.token,
            device_id: this.store.getDeviceId(),
            device_name: auth.device_name,
            blobs,
        };
        let resp;
        try { resp = await httpsPostJson(CLOUD_BASE + '/api/gaea/qqq/state/push', body); }
        catch (e: any) { return { ok: false, reason: 'network: ' + (e && e.message), pushed: [], failed: Object.keys(blobs) }; }
        if (resp.status !== 200 || !resp.json || !resp.json.ok) {
            return { ok: false, reason: 'http ' + resp.status + ': ' + (resp.json && resp.json.error), pushed: [], failed: Object.keys(blobs) };
        }
        const accepted: string[] = Array.isArray(resp.json.accepted) ? resp.json.accepted : Object.keys(blobs);
        const rejected: { key: string; reason: string }[] = Array.isArray(resp.json.rejected) ? resp.json.rejected : [];
        const failedKeys = new Set(rejected.map(r => r.key));

        // Drop outbox entries for all successfully sent keys.
        for (const ent of entries) {
            try {
                const raw = fs.readFileSync(ent.file, 'utf8');
                const p = JSON.parse(raw);
                const fullKey = p.ns + '/' + p.key;
                if (!failedKeys.has(fullKey)) {
                    this.store.dropOutbox(ent.seq);
                }
            } catch { /* leave on disk for next retry */ }
        }
        this.store.markSyncedAt(Date.now());
        return { ok: true, pushed: accepted, failed: rejected.map(r => r.key) };
    }

    // -----------------------------------------------------------------------
    // sync(): three-step pull → flush → push.
    // -----------------------------------------------------------------------
    async sync(): Promise<SyncResult> {
        const auth = readAuth();
        if (!auth) { return { ok: false, reason: 'no-auth' }; }
        const pullR = await this.pull();
        // After pull merges in, flush any dirty (the merge may have written via setNow,
        // but a no-op flush is cheap and guarantees all in-flight saves land).
        try { await this.store.flush(); } catch { /* ignore */ }
        const pushR = await this.push();
        return {
            ok: pullR.ok && pushR.ok,
            reason: !pullR.ok ? pullR.reason : (!pushR.ok ? pushR.reason : undefined),
            pull: pullR,
            push: pushR,
        };
    }
}
