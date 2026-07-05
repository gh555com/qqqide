// ============================================================================
// update-service.ts — Hot update: pull server-app.tar.xz from gh555.com
//
// Flow:
//   1. check() → GET https://gh555.com/qqqide/version.json
//   2. apply() → download server-app.tar.xz → extract → atomic swap
//   3. upgradeShell() → download shell-out.tar.gz → stage for bootstrap
//
// Persisted state in Data/update-state.json:
//   { lastCheck: number, lastVersion: string, lastApplied: string }
//
// IPC handlers:
//   qqqide:update:check        → { latestVersion, needUpdate, needShellUpdate, ... }
//   qqqide:update:apply        → { success, version }
//   qqqide:update:upgrade-shell → { success, version }
//   qqqide:update:state        → { lastCheck, currentVersion, ... }
//   qqqide:update:abort        → void
// ============================================================================

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { spawnSync } from 'child_process';

const UPDATE_MANIFEST_URL = 'https://gh555.com/qqqide/version.json';
const UPDATE_TAR_URL = 'https://gh555.com/qqqide/server-app.tar.xz';
const SHELL_TAR_URL = 'https://gh555.com/qqqide/shell-out.tar.gz';

export interface UpdateState {
    lastCheck: number;
    lastVersion: string;
    currentVersion: string;
    lastApplied: string;
}

export interface CheckResult {
    latestVersion: string;       // webapp version from server
    currentVersion: string;      // local webapp version
    needUpdate: boolean;         // webapp needs hot-update
    latestShellVersion: string;  // shell version from server
    currentShellVersion: string; // APP_VERSION (baked-in)
    needShellUpdate: boolean;    // shell needs restart update
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

    /** Check for updates (both shell + webapp). */
    async check(): Promise<CheckResult> {
        const info = await this._fetchVersionInfo();
        this._state.lastCheck = Date.now();
        if (info) {
            this._state.lastVersion = info.shell || info.webapp || '';
        }
        this._saveState();

        const shellLatest = info?.shell || '';
        const webappLatest = info?.webapp || '';
        const localWebapp = this._readWebappVersion();

        const needWebapp = !!webappLatest && this._compareVersions(localWebapp, webappLatest) < 0;
        const needShell = !!shellLatest && this._compareVersions(this._currentVersion, shellLatest) < 0;
        return {
            latestVersion: webappLatest || localWebapp,
            currentVersion: localWebapp,
            needUpdate: needWebapp,
            latestShellVersion: shellLatest || this._currentVersion,
            currentShellVersion: this._currentVersion,
            needShellUpdate: needShell,
        };
    }

    /** Download and apply webapp update (server-app.tar.xz). */
    async apply(): Promise<ApplyResult> {
        this._abortController = new AbortController();

        try {
            const latestVersion = this._state.lastVersion || await this._fetchVersionDirect();
            if (!latestVersion) {
                return { success: false, version: '', error: 'Failed to fetch latest version' };
            }

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

            const extractOk = this._extractTarXz(tarPath, extractDir);
            if (!extractOk) {
                return { success: false, version: '', error: 'Extraction failed' };
            }

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
                try { fs.renameSync(oldDir, serverAppDir); } catch { }
                return { success: false, version: '', error: 'Atomic swap failed (replace): ' + (e.message || e) };
            }

            try { fs.unlinkSync(tarPath); } catch { }
            try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { }

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

    /** Download shell-out.tar.gz and stage for bootstrap to apply on next restart. */
    async upgradeShell(): Promise<ApplyResult> {
        this._abortController = new AbortController();

        try {
            const stagingDir = path.join(this._appRoot, 'Data', 'Cache', 'staging', 'shell-out-next');
            const tarPath = path.join(this._appRoot, 'Data', 'Cache', 'staging', 'shell-out.tar.gz');
            const stagingParent = path.dirname(tarPath);

            try { fs.mkdirSync(stagingParent, { recursive: true }); } catch { }
            try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }

            const downloadOk = await this._downloadFile(SHELL_TAR_URL, tarPath,
                this._abortController.signal);
            if (!downloadOk) {
                return { success: false, version: '', error: 'Shell download failed' };
            }

            try { fs.mkdirSync(stagingDir, { recursive: true }); } catch { }
            const extractResult = spawnSync('tar', ['-xzf', tarPath, '-C', stagingDir], {
                stdio: 'pipe',
                timeout: 15000,
            });
            if (extractResult.status !== 0) {
                try { fs.unlinkSync(tarPath); } catch { }
                return { success: false, version: '', error: 'Shell extract failed, status=' + extractResult.status };
            }

            if (!fs.existsSync(path.join(stagingDir, 'main.js'))) {
                try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }
                return { success: false, version: '', error: 'Staging missing main.js' };
            }

            try { fs.unlinkSync(tarPath); } catch { }

            const versionFile = path.join(this._appRoot, 'Data', 'shell-version');
            const shellVersion = this._state.lastVersion || this._currentVersion;
            try { fs.writeFileSync(versionFile, shellVersion, 'utf8'); } catch { }

            return { success: true, version: shellVersion };
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
            const opts: any = { timeout: 15000 };
            if (u.protocol === 'https:') { opts.rejectUnauthorized = false; }
            const req = get(url, opts, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode || 0, data }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    /** Fetch full version.json from server. */
    private async _fetchVersionInfo(): Promise<{ shell: string; webapp: string } | null> {
        try {
            const { status, data } = await this._httpsGet(UPDATE_MANIFEST_URL);
            if (status !== 200) return null;
            const parsed = JSON.parse(data);
            return {
                shell: parsed.shell || parsed.version || '',
                webapp: parsed.webapp || parsed.version || '',
            };
        } catch {
            return null;
        }
    }

    /** Read local webapp version from Data/webapp-version. */
    private _readWebappVersion(): string {
        try {
            const p = path.join(this._appRoot, 'Data', 'webapp-version');
            if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
        } catch { }
        return '0.0.0';
    }

    private async _fetchVersion(): Promise<string | null> {
        const info = await this._fetchVersionInfo();
        return info?.shell || null;
    }

    private async _fetchVersionDirect(): Promise<string | null> {
        return this._fetchVersion();
    }

    private _downloadFile(url: string, dest: string, signal: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            const u = new URL(url);
            const get = u.protocol === 'https:' ? https.get : http.get;
            const opts: any = { timeout: 120000 };
            if (u.protocol === 'https:') { opts.rejectUnauthorized = false; }
            const req = get(url, opts, (res) => {
                if (res.statusCode !== 200) {
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

    private _extractTarGz(tarPath: string, destDir: string): boolean {
        try {
            try { fs.mkdirSync(destDir, { recursive: true }); } catch { }
            const result = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], {
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
