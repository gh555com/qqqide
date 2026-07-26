// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// state-legacy-import.ts
// One-shot importer for well-known legacy files into StateStore.
// Runs after StateStore is registered but before the first window loads.
//
// Strategy: detect legacy file -> import -> rename .migrated. Idempotent
// (a second run will short-circuit because the legacy file is now .migrated).
//
// Known legacy paths:
//   ~/.qqq/clipboard-history/history.bin.gz   -> q4/clipboard_history (log, cloud)
//   ~/.qqq/roam/config.json                   -> q2.roam/config (doc, cloud)
//   ~/.qqq/roam/folder-prefs.json             -> q2.roam/folder_prefs (doc, cloud)
//   ~/.qqq/roam/history.json                  -> q2.roam/history (doc, local-only)
//
// These namespaces are registered here so the import works even before the
// matching qood is ported into qqq-shell-v2. When the qood eventually ports
// and re-registers with the same form, register() is idempotent.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as zlib from 'zlib';
import { StateStore } from './state-sqlite';

const QQQ_HOME = path.join(os.homedir(), '.qqq');

export function registerWellKnownSchemas(store: StateStore): void {
    // q4 clipboard: append-only event log, 5 MB quota, cloud sync, compact at 2 MB.
    try {
        store.register('q4', {
            v: 1,
            form: 'log',
            cloud: true,
            quotaBytes: 5 * 1024 * 1024,
            compactThresholdBytes: 2 * 1024 * 1024,
            // No merger here — q4 will re-register main-side once ported and can
            // supply a sha/pin-aware merger. Default union-by-stringify is fine
            // for plain text/image events.
        });
    } catch (e) { console.warn('[legacy] register q4 failed:', e); }

    // q2.roam: three independent doc keys.
    try {
        store.register('q2.roam', {
            v: 1,
            form: 'doc',
            cloud: true,
            quotaBytes: 500 * 1024,
            // Default LWW; folder_prefs uses shallow merge on demand
            merger: (local: any, remote: any, ctx) => {
                if (!local) { return remote; }
                if (!remote) { return local; }
                if (ctx && ctx.key === 'folder_prefs' && typeof local === 'object' && typeof remote === 'object') {
                    // Shallow merge by sub-key
                    return { ...local, ...remote };
                }
                return remote;
            },
        });
    } catch (e) { console.warn('[legacy] register q2.roam failed:', e); }
}

/** Run legacy file import once. Safe to call repeatedly. */
export async function importLegacyFiles(store: StateStore): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // ---- q4 clipboard history ----
    try {
        const histDir = path.join(QQQ_HOME, 'clipboard-history');
        const histFile = path.join(histDir, 'history.bin.gz');
        if (fs.existsSync(histFile)) {
            try {
                const buf = await fs.promises.readFile(histFile);
                const raw = zlib.gunzipSync(buf as any);
                // q4 format: msgpack OR NDJSON. We try NDJSON first (newer), fall back
                // to a "treat the whole gzip as a single blob" if parse fails.
                let events: any[] = [];
                const txt = raw.toString('utf8');
                let parsed = false;
                if (txt.startsWith('{') || txt.startsWith('[')) {
                    try {
                        const j = JSON.parse(txt);
                        if (Array.isArray(j)) { events = j; parsed = true; }
                        else if (j && Array.isArray(j.events)) { events = j.events; parsed = true; }
                    } catch { /* try NDJSON */ }
                }
                if (!parsed) {
                    // NDJSON
                    for (const line of txt.split(/\r?\n/)) {
                        const t = line.trim();
                        if (!t) { continue; }
                        try { events.push(JSON.parse(t)); } catch { /* skip */ }
                    }
                    parsed = events.length > 0;
                }
                if (parsed) {
                    await store.setNow('q4', 'clipboard_history', events);
                    try { fs.renameSync(histFile, histFile + '.migrated'); } catch { /* ignore */ }
                    imported.push('q4/clipboard_history (' + events.length + ' events)');
                } else {
                    skipped.push('q4/clipboard_history (unparseable; left untouched)');
                }
            } catch (e: any) {
                errors.push('q4 history: ' + (e && e.message));
            }
        } else {
            skipped.push('q4/clipboard_history (no legacy file)');
        }
    } catch (e: any) {
        errors.push('q4 scan: ' + (e && e.message));
    }

    // ---- q2.roam three prefs ----
    const roamMap: Array<[string, string]> = [
        ['config.json',       'config'],
        ['folder-prefs.json', 'folder_prefs'],
        ['history.json',      'history'],
    ];
    for (const [legacyName, keyName] of roamMap) {
        const f = path.join(QQQ_HOME, 'roam', legacyName);
        if (!fs.existsSync(f)) {
            skipped.push('q2.roam/' + keyName + ' (no legacy file)');
            continue;
        }
        try {
            const raw = await fs.promises.readFile(f, 'utf8');
            const j = JSON.parse(raw);
            await store.setNow('q2.roam', keyName, j);
            try { fs.renameSync(f, f + '.migrated'); } catch { /* ignore */ }
            imported.push('q2.roam/' + keyName);
        } catch (e: any) {
            errors.push('q2.roam/' + keyName + ': ' + (e && e.message));
        }
    }

    return { imported, skipped, errors };
}
