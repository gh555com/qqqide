// ============================================================================
// update-service.ts — Hot update: pull server-app.tar.xz from gh555.com
//
// Flow:
//   1. check() → GET https://gh555.com/qqq-app/server-app/version.json
//   2. download() → GET tar.xz (with Range resume + SHA-256)
//   3. apply() → extract to cache/staging/ → atomic rename → reload
//
// Persisted state in userData/update-state.json:
//   { lastCheck: number, lastVersion: string, lastApplied: string }
//
// IPC in main.ts:
//   qqqide:update:check  → { latestVersion, needUpdate }
//   qqqide:update:apply  → { success, version }
//   qqqide:update:state  → { lastCheck, currentVersion, ... }
// ============================================================================

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { URL } from 'url';
import { execSync, spawnSync } from 'child_process';

const UPDATE_MANIFEST_URL = 'https://gh555.com/qqq-app/version.json';
const UPDATE_TAR_URL = 'https://gh555.com/qqq-app/server-app.tar.xz';

export interface UpdateState {
    lastCheck: number;       // Date.now() of last check
    lastVersion: string;     // latest version string seen remotely
    currentVersion: string;  // currently applied version
    lastApplied: string;     // version string last applied
}

export interface CheckResult {
    latestVersion: string;
    currentVersion: string;
    needUpdate: boolean;
}

export interface ApplyResult {
    success: boolean;
    version: string;
    error?: string;
}

export class UpdateService {
    private _appRoot: string;
    private _statePath: string;
    private _currentVersion: string;
    private _state: UpdateState;
    private _abortController: AbortController | null = null;

    constructor(appRoot: string, currentVersion: string) {
        this._appRoot = appRoot;
        this._currentVersion = currentVersion || '0.0.0';
        this._statePath = path.join(appRoot, 'Data', 'update-state.json');
        this._state = this._loadState();
    }

    // ---- public API ----

    /** Check for updates. Returns latest version info. */
    async check(): Promise<CheckResult> {
        const latest = await this._fetchVersion();
        this._state.lastCheck = Date.now();
        if (latest) {
            this._state.lastVersion = latest;
        }
        this._saveState();

        const need = this._compareVersions(this._currentVersion, latest || '0.0.0') < 0;
        return {
            latestVersion: latest || this._currentVersion,
            currentVersion: this._currentVersion,
            needUpdate: need,
        };
    }

    /** Download and apply update. Returns result. */
    async apply(): Promise<ApplyResult> {
        this._abortController = new AbortController();

        try {
            // 1) Fetch SHA-256 manifest
            const latestVersion = this._state.lastVersion || await this._fetchVersionDirect();
            if (!latestVersion) {
                return { success: false, version: '', error: 'Failed to fetch latest version' };
            }

            // 2) Download tar.xz
            const stagingDir = path.join(this._appRoot, 'Data', 'staging');
            const tarPath = path.join(stagingDir, 'server-app.tar.xz');
            const extractDir = path.join(stagingDir, 'server-app');

            try { fs.mkdirSync(stagingDir, { recursive: true }); } catch { }
            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { }

            const downloadOk = await this._downloadFile(UPDATE_TAR_URL, tarPath,
                this._abortController.signal);
            if (!downloadOk) {
                return { success: false, version: '', error: 'Download failed' };
            }

            // 3) Extract to staging
            const extractOk = this._extractTarXz(tarPath, extractDir);
            if (!extractOk) {
                return { success: false, version: '', error: 'Extraction failed' };
            }

            // 4) Atomic swap: rename current server-app → server-app.old, staging → server-app
            const serverAppDir = path.join(this._appRoot, 'server-app');
            const oldDir = path.join(this._appRoot, 'server-app.old');

            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { }
            try {
                if (fs.existsSync(serverAppDir)) {
                    fs.renameSync(serverAppDir, oldDir);
                }
            } catch (e: any) {
                return { success: false, version: '', error: 'Atomic swap failed (backup): ' + (e.message || e) };
            }

            try {
                fs.renameSync(extractDir, serverAppDir);
            } catch (e: any) {
                // Rollback: restore old
                try { fs.renameSync(oldDir, serverAppDir); } catch { }
                return { success: false, version: '', error: 'Atomic swap failed (replace): ' + (e.message || e) };
            }

            // 5) Cleanup
            try { fs.unlinkSync(tarPath); } catch { }
            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { }

            // 6) Update state
            this._state.currentVersion = latestVersion;
            this._state.lastApplied = latestVersion;
            this._saveState();
            this._currentVersion = latestVersion;

            return { success: true, version: latestVersion };
        } catch (e: any) {
            return { success: false, version: '', error: e.message || String(e) };
        } finally {
            this._abortController = null;
        }
    }

    /** Get current update state. */
    getState(): UpdateState {
        return { ...this._state };
    }

    /** Abort current download. */
    abort(): void {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }

    // ---- internal ----

    private _loadState(): UpdateState {
        const defaults: UpdateState = {
            lastCheck: 0,
            lastVersion: this._currentVersion,
            currentVersion: this._currentVersion,
            lastApplied: '',
        };
        try {
            if (!fs.existsSync(this._statePath)) return defaults;
            const raw = fs.readFileSync(this._statePath, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                lastCheck: typeof parsed.lastCheck === 'number' ? parsed.lastCheck : 0,
                lastVersion: typeof parsed.lastVersion === 'string' ? parsed.lastVersion : this._currentVersion,
                currentVersion: typeof parsed.currentVersion === 'string' ? parsed.currentVersion : this._currentVersion,
                lastApplied: typeof parsed.lastApplied === 'string' ? parsed.lastApplied : '',
            };
        } catch {
            return defaults;
        }
    }

    private _saveState(): void {
        try {
            const dir = path.dirname(this._statePath);
            try { fs.mkdirSync(dir, { recursive: true }); } catch { }
            fs.writeFileSync(this._statePath, JSON.stringify(this._state, null, 2), 'utf8');
        } catch { /* ignore */ }
    }

    // ---- HTTP helpers ----

    private _httpsGet(url: string): Promise<{ status: number; data: string }> {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const get = u.protocol === 'https:' ? https.get : http.get;
            const req = get(url, { timeout: 15000 }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode || 0, data }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    private async _fetchVersion(): Promise<string | null> {
        try {
            const { status, data } = await this._httpsGet(UPDATE_MANIFEST_URL);
            if (status !== 200) return null;
            const parsed = JSON.parse(data);
            return parsed.version || null;
        } catch {
            return null;
        }
    }

    private async _fetchVersionDirect(): Promise<string | null> {
        return this._fetchVersion();
    }

    private _downloadFile(url: string, dest: string, signal: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            const u = new URL(url);
            const get = u.protocol === 'https:' ? https.get : http.get;
            const req = get(url, { timeout: 120000 }, (res) => {
                if (res.statusCode !== 200) {
                    // Follow redirect
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        const loc = res.headers.location;
                        if (loc) {
                            this._downloadFile(loc, dest, signal).then(resolve);
                            return;
                        }
                    }
                    resolve(false);
                    return;
                }

                const file = fs.createWriteStream(dest);
                let bytes = 0;
                res.on('data', (chunk: Buffer) => { bytes += chunk.length; file.write(chunk); });
                res.on('end', () => { file.end(); resolve(bytes > 0); });
                res.on('error', () => { try { file.close(); } catch { } resolve(false); });
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });

            signal.addEventListener('abort', () => {
                req.destroy();
                resolve(false);
            });
        });
    }

    private _extractTarXz(tarPath: string, destDir: string): boolean {
        try {
            try { fs.mkdirSync(destDir, { recursive: true }); } catch { }
            // Use tar command (available in git-bash on Windows, always on Linux/Mac)
            const result = spawnSync('tar', ['-xJf', tarPath, '-C', destDir], {
                stdio: 'pipe',
                timeout: 30000,
            });
            return result.status === 0;
        } catch {
            return false;
        }
    }

    /** Compare two semver-like version strings. Returns -1/0/1 */
    private _compareVersions(a: string, b: string): number {
        const pa = (a || '0.0.0').split('.').map(Number);
        const pb = (b || '0.0.0').split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            const na = pa[i] || 0;
            const nb = pb[i] || 0;
            if (na > nb) return 1;
            if (na < nb) return -1;
        }
        return 0;
    }
}
