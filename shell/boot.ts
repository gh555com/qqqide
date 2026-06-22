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
// Boot file log — 启动日志落地到 cache/boot.log，诊断连接失败
// ----------------------------------------------------------------------------
let _bootLogPath: string | null = null;
function bootLog(msg: string) {
    if (!_bootLogPath) { return; }
    const ts = new Date().toISOString();
    try {
        fs.appendFileSync(_bootLogPath, `[${ts}] ${msg}\n`);
    } catch (_) { }
}
function initBootLog(logsDir: string) {
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) { }
    _bootLogPath = path.join(logsDir, 'boot.log');
    bootLog('=== qqqide boot start ===');
    bootLog('version: ' + APP_VERSION);
    bootLog('platform: ' + os.platform() + ' ' + os.release());
}

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
    bootLog('health: check ' + urlStr);
    return new Promise(resolve => {
        if (isOffline) { bootLog('health: SKIP (offline mode)'); return resolve(false); }
        let healthUrl: string;
        try {
            const u = new URL('health', urlStr.endsWith('/') ? urlStr : urlStr + '/');
            healthUrl = u.toString();
        } catch {
            bootLog('health: FAIL — bad URL');
            return resolve(false);
        }
        const lib = healthUrl.startsWith('https') ? https : http;
        const opts: any = { timeout: timeoutMs };
        if (healthUrl.startsWith('https')) { opts.rejectUnauthorized = false; }
        const req = lib.get(healthUrl, opts, res => {
            const ok = !!(res.statusCode && res.statusCode >= 200 && res.statusCode < 400);
            res.resume();
            bootLog('health: ' + (ok ? 'OK ' + res.statusCode : 'FAIL status=' + res.statusCode));
            resolve(ok);
        });
        req.on('error', (err) => { bootLog('health: FAIL — ' + (err && (err as any).message || String(err))); resolve(false); });
        req.on('timeout', () => { bootLog('health: FAIL — timeout ' + timeoutMs + 'ms'); req.destroy(); resolve(false); });
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
                const opts2: any = { timeout: 5000 };
                if (versionUrl.startsWith('https')) { opts2.rejectUnauthorized = false; }
                const req = lib.get(versionUrl, opts2, (res) => {
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
            const dlopts: any = { timeout: 30000 };
            if (updateUrl.startsWith('https')) { dlopts.rejectUnauthorized = false; }
            const req = lib.get(updateUrl, dlopts, (res) => {
                if (res.statusCode !== 200) {
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        const loc = res.headers.location;
                        if (loc) {
                            const lib2 = loc.startsWith('https') ? https : http;
                            const redirOpts: any = { timeout: 30000 };
                            if (loc.startsWith('https')) { redirOpts.rejectUnauthorized = false; }
                            const req2 = lib2.get(loc, redirOpts, (res2) => {
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
    bootLog('fallback: reason=' + reason);
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
    bootConfig: BootConfig,
    timeoutMs: number = 0
): Promise<{ ok: boolean; mode: BootMode }> {
    if (!mainWindow) { bootLog('remote: no window'); return { ok: false, mode: 'fallback' }; }
    bootLog('remote: loading ' + bootConfig.url + (timeoutMs > 0 ? ' timeout=' + timeoutMs + 'ms' : ''));
    const wc = mainWindow.webContents;
    return new Promise<{ ok: boolean; mode: BootMode }>(resolve => {
        let settled = false;
        let timeoutTimer: NodeJS.Timeout | null = null;
        const finish = (ok: boolean, mode: BootMode) => {
            if (settled) { return; }
            settled = true;
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            wc.removeListener('did-finish-load', onFinish);
            wc.removeListener('did-fail-load', onFail);
            bootLog('remote: ' + (ok ? 'LOADED' : 'FAILED') + ' mode=' + mode);
            resolve({ ok, mode });
        };
        const onFinish = () => {
            finish(true, 'live');
        };
        const onFail = (_e: any, code: number, desc: string, validatedURL: string, isMain: boolean) => {
            if (!isMain) { return; }
            bootLog('remote: did-fail-load code=' + code + ' desc=' + desc + ' url=' + validatedURL);
            finish(false, 'fallback');
        };
        if (timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                bootLog('remote: TIMEOUT after ' + timeoutMs + 'ms');
                finish(false, 'fallback');
            }, timeoutMs);
        }
        wc.on('did-finish-load', onFinish);
        wc.on('did-fail-load', onFail);
        mainWindow!.loadURL(bootConfig.url).catch(err => {
            bootLog('remote: loadURL error — ' + (err && (err as Error).message || String(err)));
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
    // 0) Init boot file log for diagnostics
    initBootLog(path.join(portableRoot, 'logs'));
    bootLog('url: ' + bootConfig.url);

    // 1) Show fallback IMMEDIATELY → 窗口在 <1s 内弹出，用户看到"连接中…"
    await loadStaticFallback(mainWindow, bootConfig, portableRoot, 'connecting');

    // 2) Check for shell-code hot-update (non-blocking)
    checkAndDownloadShellUpdate(bootConfig, portableCache, isDev, isOffline).then(updated => {
        if (updated) {
            console.log('[boot] shell update staged — will apply on next restart');
        }
    }).catch(() => { });

    // 3) Health check (fast, 3s timeout)
    const healthy = await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs, isOffline);
    if (healthy) {
        bootLog('seq: server OK');
    } else {
        bootLog('seq: server unreachable');
    }

    // 4) Try remote with 15s timeout
    //    loadURL() 会自动替换当前 fallback 页面，用户无缝过渡到正式应用
    const REMOTE_TIMEOUT_MS = 15000;
    const { ok, mode } = await loadRemoteWithCacheGuard(mainWindow, bootConfig, REMOTE_TIMEOUT_MS);
    if (ok) {
        bootLog('seq: remote OK, boot complete');
        setLastBootMode(mode);
    } else {
        // Reload fallback with actual error reason (was 'connecting' before)
        const reason = healthy ? 'load-failed' : 'no-network-no-cache';
        bootLog('seq: FAILED — staying on fallback, reason=' + reason);
        await loadStaticFallback(mainWindow, bootConfig, portableRoot, reason);
        setLastBootMode('fallback');
    }
}
