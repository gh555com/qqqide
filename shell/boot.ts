// ============================================================================
// boot.ts — 启动配置 / 健康检查 / 壳层热更 / 启动序列
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { spawnSync } from 'child_process';
import { BrowserWindow } from 'electron';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------
export const APP_VERSION = '0.0.2';
export const DEFAULT_REMOTE_URL = 'http://127.0.0.1:8090/qqq-app/';

// ----------------------------------------------------------------------------
// Boot configuration
// ----------------------------------------------------------------------------
export interface BootConfig {
    url: string;
    healthTimeoutMs: number;
}

export function loadBootConfig(portableRoot: string): BootConfig {
    const cfgPath = path.join(portableRoot, 'config.json');
    let cfg: BootConfig = { url: DEFAULT_REMOTE_URL, healthTimeoutMs: 3000 };
    // (1) config.json (lowest precedence beyond defaults)
    if (fs.existsSync(cfgPath)) {
        try {
            const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (j.url) { cfg.url = j.url; }
            if (j.healthTimeoutMs) { cfg.healthTimeoutMs = j.healthTimeoutMs; }
        } catch (e) {
            console.warn('[main] bad config.json:', e);
        }
    } else {
        // First-run: drop template config.json
        try {
            const tpl = {
                url: DEFAULT_REMOTE_URL,
                healthTimeoutMs: 3000,
                _comment: 'qz/VM-snapshot friendly. Edit url to point at your server. NEVER stored in AppData.'
            };
            fs.writeFileSync(cfgPath, JSON.stringify(tpl, null, 2), 'utf8');
            console.log('[main] wrote default config.json ->', cfgPath);
        } catch (e) {
            console.warn('[main] could not write default config.json:', e);
        }
    }
    // (2) env override (qz can set this) - beats config.json
    if (process.env.QQQIDE_URL) { cfg.url = process.env.QQQIDE_URL; }
    // (3) CLI override --url=... - highest precedence
    for (const arg of process.argv.slice(1)) {
        if (arg.startsWith('--url=')) { cfg.url = arg.slice(6); }
    }
    return cfg;
}

export function extractFlags(): { isOffline: boolean; isDev: boolean } {
    return {
        isOffline: process.argv.includes('--offline'),
        isDev: process.argv.includes('--dev') || process.env.QQQIDE_DEV === '1',
    };
}

// ----------------------------------------------------------------------------
// Health check
// ----------------------------------------------------------------------------
export function healthCheck(urlStr: string, timeoutMs: number, isOffline: boolean): Promise<boolean> {
    return new Promise(resolve => {
        if (isOffline) { return resolve(false); }
        let healthUrl: string;
        try {
            const u = new URL('health', urlStr.endsWith('/') ? urlStr : urlStr + '/');
            healthUrl = u.toString();
        } catch {
            return resolve(false);
        }
        const lib = healthUrl.startsWith('https') ? https : http;
        const req = lib.get(healthUrl, { timeout: timeoutMs }, res => {
            const ok = !!(res.statusCode && res.statusCode >= 200 && res.statusCode < 400);
            res.resume();
            resolve(ok);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

// ----------------------------------------------------------------------------
// Shell hot-update: download shell-out.tar.gz from remote, stage for bootstrap
// ----------------------------------------------------------------------------
const SHELL_UPDATE_URL = 'shell-out.tar.gz';

export async function checkAndDownloadShellUpdate(
    bootConfig: BootConfig,
    portableCache: string,
    isDev: boolean,
    isOffline: boolean
): Promise<boolean> {
    if (isDev || isOffline) return false;

    const stagingDir = path.join(portableCache, 'staging', 'shell-out-next');
    const tarPath = path.join(portableCache, 'staging', 'shell-out.tar.gz');

    try {
        const baseUrl = bootConfig.url.endsWith('/') ? bootConfig.url : bootConfig.url + '/';
        const updateUrl = baseUrl + SHELL_UPDATE_URL;
        const lib = updateUrl.startsWith('https') ? https : http;

        // Fetch version.json first to get latest shell version
        let latestVersion = '';
        try {
            const versionUrl = baseUrl + 'version.json';
            const vResp = await new Promise<{ status: number; data: string }>((resolve, reject) => {
                const req = lib.get(versionUrl, { timeout: 5000 }, (res) => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', (c: string) => data += c);
                    res.on('end', () => resolve({ status: res.statusCode || 0, data }));
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
            if (vResp.status === 200) {
                const v = JSON.parse(vResp.data);
                latestVersion = v.shell_version || v.version || '';
            }
        } catch { /* version check is optional */ }

        // Compare with local version
        const localVersionPath = path.join(portableCache, 'shell-version');
        let localVersion = '';
        try {
            if (fs.existsSync(localVersionPath)) {
                localVersion = fs.readFileSync(localVersionPath, 'utf8').trim();
            }
        } catch { }

        if (latestVersion && localVersion === latestVersion) {
            return false; // Already up to date
        }

        // Download shell-out.tar.gz
        console.log('[shell-update] downloading', updateUrl);
        try { fs.mkdirSync(path.dirname(tarPath), { recursive: true }); } catch { }

        const downloadOk = await new Promise<boolean>((resolve) => {
            const req = lib.get(updateUrl, { timeout: 30000 }, (res) => {
                if (res.statusCode !== 200) {
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        const loc = res.headers.location;
                        if (loc) {
                            const lib2 = loc.startsWith('https') ? https : http;
                            const req2 = lib2.get(loc, { timeout: 30000 }, (res2) => {
                                if (res2.statusCode !== 200) { resolve(false); return; }
                                const file = fs.createWriteStream(tarPath);
                                res2.pipe(file);
                                file.on('finish', () => resolve(true));
                                file.on('error', () => resolve(false));
                            });
                            req2.on('error', () => resolve(false));
                            req2.on('timeout', () => { req2.destroy(); resolve(false); });
                            return;
                        }
                    }
                    resolve(false);
                    return;
                }
                const file = fs.createWriteStream(tarPath);
                res.pipe(file);
                file.on('finish', () => resolve(true));
                file.on('error', () => resolve(false));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });

        if (!downloadOk) {
            console.log('[shell-update] download failed or not available');
            return false;
        }

        // Extract to staging
        console.log('[shell-update] extracting to', stagingDir);
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }
        try { fs.mkdirSync(stagingDir, { recursive: true }); } catch { }

        const extractResult = spawnSync('tar', ['-xzf', tarPath, '-C', stagingDir], {
            stdio: 'pipe',
            timeout: 15000,
        });

        if (extractResult.status !== 0) {
            console.log('[shell-update] extract failed, status:', extractResult.status);
            try { fs.rmSync(tarPath); } catch { }
            return false;
        }

        try { fs.unlinkSync(tarPath); } catch { }

        if (latestVersion) {
            try {
                fs.mkdirSync(path.dirname(localVersionPath), { recursive: true });
                fs.writeFileSync(localVersionPath, latestVersion, 'utf8');
            } catch { }
        }

        console.log('[shell-update] staged for next restart:', stagingDir);
        return true;
    } catch (e: any) {
        console.log('[shell-update] error:', e.message || e);
        return false;
    }
}

// ----------------------------------------------------------------------------
// Boot fallback + remote load
// ----------------------------------------------------------------------------
export type BootMode = 'live' | 'cache' | 'fallback';

export async function loadStaticFallback(
    mainWindow: BrowserWindow | null,
    bootConfig: BootConfig,
    portableRoot: string,
    reason: string
): Promise<BootMode> {
    if (!mainWindow) { return 'fallback'; }
    console.warn('[boot] static fallback:', reason);
    const candidates = [
        path.join(__dirname, '..', 'shell', 'boot-fallback.html'),
        path.join(__dirname, 'boot-fallback.html'),
        path.join(portableRoot, 'shell', 'boot-fallback.html'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            await mainWindow.loadFile(p, { query: { url: bootConfig.url, reason } });
            return 'fallback';
        }
    }
    await mainWindow.loadURL('data:text/html,<h1>qqq IDE offline</h1>');
    return 'fallback';
}

export async function loadRemoteWithCacheGuard(
    mainWindow: BrowserWindow | null,
    bootConfig: BootConfig
): Promise<{ ok: boolean; mode: BootMode }> {
    if (!mainWindow) { return { ok: false, mode: 'fallback' }; }
    const wc = mainWindow.webContents;
    return new Promise<{ ok: boolean; mode: BootMode }>(resolve => {
        let settled = false;
        const finish = (ok: boolean, mode: BootMode) => {
            if (settled) { return; }
            settled = true;
            wc.removeListener('did-finish-load', onFinish);
            wc.removeListener('did-fail-load', onFail);
            resolve({ ok, mode });
        };
        const onFinish = () => {
            finish(true, 'live');
        };
        const onFail = (_e: any, code: number, desc: string, validatedURL: string, isMain: boolean) => {
            if (!isMain) { return; }
            console.warn('[boot] did-fail-load', code, desc, validatedURL);
            finish(false, 'fallback');
        };
        wc.on('did-finish-load', onFinish);
        wc.on('did-fail-load', onFail);
        mainWindow!.loadURL(bootConfig.url).catch(err => {
            console.warn('[boot] loadURL threw:', err && (err as Error).message);
            finish(false, 'fallback');
        });
    });
}

// ----------------------------------------------------------------------------
// Boot orchestrator
// ----------------------------------------------------------------------------
export async function bootSequence(
    mainWindow: BrowserWindow | null,
    bootConfig: BootConfig,
    portableRoot: string,
    portableCache: string,
    isDev: boolean,
    isOffline: boolean,
    setLastBootMode: (m: BootMode) => void,
    getLastBootMode: () => BootMode,
): Promise<void> {
    // Check for shell-code hot-update (non-blocking)
    checkAndDownloadShellUpdate(bootConfig, portableCache, isDev, isOffline).then(updated => {
        if (updated) {
            console.log('[boot] shell update staged — will apply on next restart');
        }
    }).catch(() => { });

    const healthy = await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs, isOffline);
    if (healthy) {
        console.log('[boot] server OK ->', bootConfig.url);
    } else {
        console.warn('[boot] server unreachable; relying on PWA cache (if any)');
    }
    const { ok, mode } = await loadRemoteWithCacheGuard(mainWindow, bootConfig);
    if (!ok) {
        const m = await loadStaticFallback(mainWindow, bootConfig, portableRoot, healthy ? 'load-failed' : 'no-network-no-cache');
        setLastBootMode(m);
    } else if (!healthy) {
        setLastBootMode('cache');
        console.log('[boot] served from PWA cache');
    } else {
        setLastBootMode(mode);
    }
}
