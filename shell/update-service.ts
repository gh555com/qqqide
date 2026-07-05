// ============================================================================
// update-service.ts — 双轨热更新统一入口（唯一真理源：PRODUCTION_URL + APP_VERSION）
//
// 铁律:
//   - 下载 URL 全部派生自 boot.ts 的 PRODUCTION_URL，改一处全改
//   - 版本检查统一走 version.ts 的 fetchServerVersionInfo
//   - _shellVersion = APP_VERSION（main.js 硬编码，bootstrap 替换后自动更新）
//   - _state.currentVersion = webapp 本地版本（Data/webapp-version 或 '0.0.0'）
//   两套版本互不干扰，check() 独立比较
// ============================================================================

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { spawnSync } from 'child_process';
import { PRODUCTION_URL } from './boot';
import { fetchServerVersionInfo } from './version';

// ★ 三条 URL 全部从 PRODUCTION_URL 派生（唯一真理源）
const UPDATE_MANIFEST_URL = PRODUCTION_URL + 'version.json';
const UPDATE_TAR_URL = PRODUCTION_URL + 'server-app.tar.gz';
const SHELL_TAR_URL = PRODUCTION_URL + 'shell-out.tar.gz';

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
    /** Shell 版本号 = APP_VERSION（唯一真理源，bootstrap 替换壳后自动更新） */
    private _shellVersion: string;
    private _state: UpdateState;
    private _abortController: AbortController | null = null;

    constructor(appRoot: string, shellVersion: string) {
        this._appRoot = appRoot;
        this._shellVersion = shellVersion || '0.0.0';
        this._statePath = path.join(appRoot, 'Data', 'update-state.json');
        this._state = this._loadState();
    }

    // ---- public API ----

    /** Check for updates (both shell + webapp). */
    async check(): Promise<CheckResult> {
        const info = await fetchServerVersionInfo(PRODUCTION_URL);
        this._state.lastCheck = Date.now();
        if (info) {
            this._state.lastVersion = info.shell || info.webapp || '';
        }
        this._saveState();

        const shellLatest = info?.shell || '';
        const webappLatest = info?.webapp || '';
        const localWebapp = this._readWebappVersion();

        const needWebapp = !!webappLatest && this._compareVersions(localWebapp, webappLatest) < 0;
        const needShell = !!shellLatest && this._compareVersions(this._shellVersion, shellLatest) < 0;
        return {
            latestVersion: webappLatest || localWebapp,
            currentVersion: localWebapp,
            needUpdate: needWebapp,
            latestShellVersion: shellLatest || this._shellVersion,
            currentShellVersion: this._shellVersion,
            needShellUpdate: needShell,
        };
    }

    /**
     * Download and stage webapp update (server-app.tar.gz).
     * 下载到 Data/webapp-staging/，下次启动 ensureLocalWebapp 自动替换。
     */
    async apply(): Promise<ApplyResult> {
        this._abortController = new AbortController();

        try {
            const info = await fetchServerVersionInfo(PRODUCTION_URL);
            const latestVersion = info?.webapp || info?.shell || '';
            if (!latestVersion) {
                return { success: false, version: '', error: 'Failed to fetch latest version' };
            }

            const stagingDir = path.join(this._appRoot, 'Data', 'webapp-staging');
            const dlDir = path.join(this._appRoot, 'Data', 'webapp-dl');
            const tarPath = path.join(dlDir, 'server-app.tar.gz');

            try { fs.mkdirSync(dlDir, { recursive: true }); } catch { }
            try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }

            const downloadOk = await this._downloadFile(UPDATE_TAR_URL, tarPath,
                this._abortController.signal);
            if (!downloadOk) {
                return { success: false, version: '', error: 'Download failed' };
            }

            try { fs.mkdirSync(stagingDir, { recursive: true }); } catch { }
            const extractOk = this._extractTarGz(tarPath, stagingDir);
            if (!extractOk) {
                try { fs.unlinkSync(tarPath); } catch { }
                return { success: false, version: '', error: 'Extraction failed' };
            }

            try { fs.unlinkSync(tarPath); } catch { }

            this._writeWebappVersion(latestVersion);
            this._state.currentVersion = latestVersion;
            this._state.lastApplied = latestVersion;
            this._saveState();

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
            const shellVersion = this._state.lastVersion || this._shellVersion;
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

    /**
     * 加载本地持久化状态。
     * 铁律：_state.currentVersion 只反映 webapp 版本，shell 版本始终以 _shellVersion 为准。
     */
    private _loadState(): UpdateState {
        const defaults: UpdateState = {
            lastCheck: 0,
            lastVersion: '',
            currentVersion: this._readWebappVersion(),
            lastApplied: '',
        };
        try {
            if (!fs.existsSync(this._statePath)) return defaults;
            const raw = fs.readFileSync(this._statePath, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                lastCheck: typeof parsed.lastCheck === 'number' ? parsed.lastCheck : 0,
                lastVersion: typeof parsed.lastVersion === 'string' ? parsed.lastVersion : '',
                currentVersion: typeof parsed.currentVersion === 'string' ? parsed.currentVersion : this._readWebappVersion(),
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

    // ---- low-level I/O ----

    /** Read local webapp version from Data/webapp-version. boot.ts 的 ensureLocalWebapp 确保初始存在。 */
    private _readWebappVersion(): string {
        try {
            const p = path.join(this._appRoot, 'Data', 'webapp-version');
            if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
        } catch { }
        return '0.0.0';
    }

    /** Write Data/webapp-version. */
    private _writeWebappVersion(v: string): void {
        try {
            fs.writeFileSync(path.join(this._appRoot, 'Data', 'webapp-version'), v, 'utf8');
        } catch { /* ignore */ }
    }

    /** Download a file from url to dest, with timeout + redirect + abort support. */
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

    /** Extract .tar.gz to destDir. */
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
