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
import { APP_VERSION, decideUpdate, fetchServerVersionInfo, fetchServerVersionInfoWithFallback, readLocalShellVersion, writeLocalShellVersion, readLocalWebappVersion, writeLocalWebappVersion } from './version';

// ── 全局启动锁：一旦 bootSequence 成功完成，绝不允许 fallback 再入侵窗口 ──
let bootCompleted = false;
export function isBootCompleted(): boolean { return bootCompleted; }

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
/** ★ 唯一真理源：IDE 部署根 URL。webapp 加载路径。 */
export const PRODUCTION_URL = 'https://gh555.com/qqqide/';

/** ★ 热更新 CDN 路由 (CF Worker → 302 OSS/R2)。版本检查/下载走此 URL。 */
export const UPDATE_BASE_URL = 'https://gh555.com/dl/qqqide-up/';

/** ★ 热更新兜底 URL (OSS 上海直连，绕过 CF)。当主 URL 不可达时使用。 */
export const UPDATE_FALLBACK_URL = 'https://gh555-shanghai.oss-cn-shanghai.aliyuncs.com/qqqide-up/';

// ----------------------------------------------------------------------------
// Boot configuration
// ----------------------------------------------------------------------------
export interface BootConfig {
    url: string;
    healthTimeoutMs: number;
}

export function loadBootConfig(_portableRoot: string): BootConfig {
    let cfg: BootConfig = { url: PRODUCTION_URL, healthTimeoutMs: 3000 };
    // env override (qz can set this)
    if (process.env.QQQIDE_URL) { cfg.url = process.env.QQQIDE_URL; }
    // CLI override --url=... — highest precedence
    for (const arg of process.argv.slice(1)) {
        if (arg.startsWith("--url=")) { cfg.url = arg.slice(6); }
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

// ═══ 启动进度报告 — C 语言启动器通过此文件读取进度 ═══
// portableRoot = {extractRoot}/gh555.com/ (绿色包 Electron 的 app root)
// C 启动器读取: {extractRoot}/gh555.com/loading-status
// 因此: path.join(portableRoot, 'loading-status') = C 启动器读的路径 ✅
// 格式: "N|文字" (进度%|阶段描述) 或 "ready" (启动完成)
function writeBootStatus(portableRoot: string, line: string): void {
    if (!portableRoot) return;
    try {
        fs.writeFileSync(path.join(portableRoot, 'loading-status'), line, 'utf-8');
    } catch (_) { }
}

// ----------------------------------------------------------------------------
// Shell hot-update: download shell-out.tar.gz from remote, stage for bootstrap
// ----------------------------------------------------------------------------
const SHELL_UPDATE_URL = 'shell-out.tar.gz';

export async function checkAndDownloadShellUpdate(
    bootConfig: BootConfig,
    portableRoot: string,
    portableCache: string,
    isDev: boolean,
    isOffline: boolean
): Promise<boolean> {
    if (isDev || isOffline) return false;

    const stagingDir = path.join(portableCache, 'staging', 'shell-out-next');
    const tarPath = path.join(portableCache, 'staging', 'shell-out.tar.gz');

    try {
        const updateUrl = UPDATE_BASE_URL + SHELL_UPDATE_URL;
        const lib = updateUrl.startsWith('https') ? https : http;

        // Fetch server version info — 工业级语义比较，防降级
        const versionInfo = await fetchServerVersionInfoWithFallback(UPDATE_BASE_URL, UPDATE_FALLBACK_URL);
        const latestVersion = versionInfo?.shell || '';
        if (!latestVersion) return false;

        const localVersion = readLocalShellVersion(portableRoot) || APP_VERSION;
        const decision = decideUpdate(localVersion, latestVersion, versionInfo?.min_shell);
        if (decision !== 'hot-update' && decision !== 'force-full-upgrade') {
            console.log('[shell-update]', decision, '— local=' + localVersion + ' server=' + latestVersion);
            return false;
        }
        console.log('[shell-update]', decision, '— local=' + localVersion + ' server=' + latestVersion);

        // Download shell-out.tar.gz
        console.log('[shell-update] downloading', updateUrl);
        try { fs.mkdirSync(path.dirname(tarPath), { recursive: true }); } catch { }

        writeBootStatus(portableRoot, '0|检查壳层更新…');
        const downloadOk = await new Promise<boolean>((resolve) => {
            var _trackDownload = function (resp: any, label: string) {
                var total = parseInt(resp.headers['content-length'] || '0', 10);
                var downloaded = 0;
                var lastPct = 0;
                var fstream = fs.createWriteStream(tarPath);
                resp.on('data', function (chunk: any) {
                    downloaded += chunk.length;
                    if (total > 0) {
                        var pct = Math.round(downloaded / total * 100);
                        if (pct !== lastPct) { lastPct = pct; writeBootStatus(portableRoot, pct + '|' + label); }
                    }
                });
                resp.pipe(fstream);
                return fstream;
            };
            const dlopts: any = { timeout: 60000 };
            if (updateUrl.startsWith('https')) { dlopts.rejectUnauthorized = false; }
            const req = lib.get(updateUrl, dlopts, (res) => {
                if (res.statusCode !== 200) {
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        const loc = res.headers.location;
                        if (loc) {
                            const lib2 = loc.startsWith('https') ? https : http;
                            const redirOpts: any = { timeout: 60000 };
                            if (loc.startsWith('https')) { redirOpts.rejectUnauthorized = false; }
                            const req2 = lib2.get(loc, redirOpts, (res2) => {
                                if (res2.statusCode !== 200) { resolve(false); return; }
                                var f2 = _trackDownload(res2, '下载壳层更新…');
                                f2.on('finish', () => resolve(true));
                                f2.on('error', () => resolve(false));
                            });
                            req2.on('error', () => resolve(false));
                            req2.on('timeout', () => { req2.destroy(); resolve(false); });
                            return;
                        }
                    }
                    resolve(false);
                    return;
                }
                var f1 = _trackDownload(res, '下载壳层更新…');
                f1.on('finish', () => resolve(true));
                f1.on('error', () => resolve(false));
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
            // ★ 清理半残 staging，防止下次启动 bootstrap 误 swap 进去
            try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }
            return false;
        }

        try { fs.unlinkSync(tarPath); } catch { }

        writeLocalShellVersion(portableRoot, latestVersion);

        console.log('[shell-update] staged for next restart:', stagingDir);
        return true;
    } catch (e: any) {
        console.log('[shell-update] error:', e.message || e);
        return false;
    }
}

// ----------------------------------------------------------------------------
// Webapp local loading: bundle server-app/ as webapp/ → first boot instant + offline
// ----------------------------------------------------------------------------
export const WEBAPP_PROTOCOL = 'qqqide-webapp';
let _webappProtocolRegistered = false;

/** Find or create local webapp/ at portableRoot/Data level. Returns dir path or null. */
export function ensureLocalWebapp(portableRoot: string): string | null {
    const localDir = path.join(portableRoot, 'Data', 'webapp');

    // ── Swap staged update if present (from previous background download) ──
    const stagingDir = path.join(portableRoot, 'Data', 'webapp-staging');
    if (fs.existsSync(stagingDir)) {
        // ★ 完整性校验：staging 必须有 index.html，否则是半残目录，直接删除
        if (!fs.existsSync(path.join(stagingDir, 'index.html'))) {
            bootLog('webapp: staging is incomplete (no index.html), discarding');
            try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }
        } else {
            bootLog('webapp: staged update detected, swapping…');
            try {
                const oldDir = localDir + '.old';
                if (fs.existsSync(localDir)) { fs.renameSync(localDir, oldDir); }
                fs.renameSync(stagingDir, localDir);
                if (fs.existsSync(oldDir)) { fs.rmSync(oldDir, { recursive: true, force: true }); }
                bootLog('webapp: staged update swapped → ' + localDir);
            } catch (e: any) {
                bootLog('webapp: swap failed — ' + (e.message || e));
                try {
                    const oldDir = localDir + '.old';
                    if (fs.existsSync(oldDir) && !fs.existsSync(localDir)) {
                        fs.renameSync(oldDir, localDir);
                        bootLog('webapp: rolled back .old → target');
                    }
                } catch (_) { }
                try { if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { }
            }
        }
    }

    // Already exists (from previous boot or copy)
    if (fs.existsSync(path.join(localDir, 'index.html'))) {
        // ★ 确保 webapp-version 存在（新便携包首次启动时 bootstrap 已替换壳，但 webapp 标记可能缺失）
        const verPath = path.join(portableRoot, 'Data', 'webapp-version');
        if (!fs.existsSync(verPath)) {
            try { fs.writeFileSync(verPath, APP_VERSION, 'utf8'); } catch { }
        }
        return localDir;
    }

    // Copy from packagege (resources/app/webapp/ or resources/app/server-app/)
    const candidates: string[] = [
        path.join(portableRoot, 'resources', 'app', 'webapp'),
        path.join(portableRoot, 'resources', 'app', 'server-app'),
        path.join(__dirname, 'webapp'),
        path.join(__dirname, '..', 'webapp'),
    ];
    for (const src of candidates) {
        if (fs.existsSync(path.join(src, 'index.html'))) {
               try {
                fs.cpSync(src, localDir, { recursive: true });
                bootLog('webapp: copied from package → ' + localDir);
                // ★ 写入 webapp-version 标记，确保 update-service 能读到正确本地版本
                try { fs.writeFileSync(path.join(portableRoot, 'Data', 'webapp-version'), APP_VERSION, 'utf8'); } catch { }
                return localDir;
            } catch (e: any) {
                bootLog('webapp: copy failed — ' + (e.message || e));
            }
        }
    }
    return null;
}

/** Register qqqide-webapp:// protocol to serve local webapp files. */
export function registerWebappProtocol(webappDir: string): void {
    if (_webappProtocolRegistered) return;
    _webappProtocolRegistered = true;
    // Lazy-load protocol from electron (available after app.whenReady)
    const _electron = require('electron');
    _electron.protocol.registerFileProtocol(WEBAPP_PROTOCOL, (request: any, callback: any) => {
        try {
            const u = new URL(request.url);
            let rel = decodeURIComponent(u.pathname);
            // strip /qqqide/ prefix
            rel = rel.replace(/^\/qqqide\//, '/');
            if (rel.startsWith('/')) rel = rel.slice(1);
            if (!rel) rel = 'index.html';
            const abs = path.join(webappDir, rel);
            // security: ensure we don't escape webappDir
            if (abs.startsWith(webappDir) && fs.existsSync(abs)) {
                callback({ path: abs });
            } else {
                callback({ error: -6 }); // FILE_NOT_FOUND
            }
        } catch {
            callback({ error: -2 }); // FAILED
        }
    });
}

/** 20s after boot, check server for newer webapp, download+extract to staging. */
async function backgroundCheckWebappUpdate(
    bootConfig: BootConfig,
    portableRoot: string,
): Promise<void> {
    try {
        // 1) Fetch server version info — 工业级语义比较
        const versionInfo = await fetchServerVersionInfoWithFallback(UPDATE_BASE_URL, UPDATE_FALLBACK_URL);
        if (!versionInfo) { bootLog('webapp-update: version check failed'); return; }
        const latestVersion = versionInfo.webapp || '';
        if (!latestVersion) { bootLog('webapp-update: no version info on server'); return; }

        // 2) Semver-based update decision（防降级：本地 > 服务器 → 跳过）
        const localVersion = readLocalWebappVersion(portableRoot) || '0.0.0';
        const decision = decideUpdate(localVersion, latestVersion);
        if (decision !== 'hot-update') {
            bootLog('webapp-update: ' + decision + ' — local=' + localVersion + ' server=' + latestVersion);
            return;
        }
        bootLog('webapp-update: hot-update — local=' + localVersion + ' server=' + latestVersion);

        // 3) Download server-app.tar.gz (gzip, works everywhere; xz not available on Windows)
        const dlUrl = UPDATE_BASE_URL + 'server-app.tar.gz';
        bootLog('webapp-update: downloading ' + dlUrl);
        const lib = dlUrl.startsWith('https') ? https : http;
        const dlDir = path.join(portableRoot, 'Data', 'webapp-dl');
        try { fs.mkdirSync(dlDir, { recursive: true }); } catch { }
        const tarPath = path.join(dlDir, 'server-app.tar.gz');

        writeBootStatus(portableRoot, '0|下载载荷更新…');
        // ★ 302 重定向跟随 + OSS 兜底（对齐 checkAndDownloadShellUpdate，否则 CF Worker 302 直接失败）
        const fallbackDlUrl = UPDATE_FALLBACK_URL + 'server-app.tar.gz';
        const dlOk = await new Promise<boolean>((resolve) => {
            var _trackW = function (resp: any) {
                var total = parseInt(resp.headers['content-length'] || '0', 10);
                var downloaded = 0;
                var lastPct = 0;
                var fstream = fs.createWriteStream(tarPath);
                resp.on('data', function (chunk: any) {
                    downloaded += chunk.length;
                    if (total > 0) {
                        var pct = Math.round(downloaded / total * 100);
                        if (pct !== lastPct) { lastPct = pct; writeBootStatus(portableRoot, pct + '|下载载荷更新…'); }
                    }
                });
                resp.pipe(fstream);
                return fstream;
            };
            var _doW = function (url: string, isFallback: boolean) {
                var lib3 = url.startsWith('https') ? https : http;
                var dopts: any = { timeout: 120000 };
                if (url.startsWith('https')) { dopts.rejectUnauthorized = false; }
                var r = lib3.get(url, dopts, function (res2) {
                    if (res2.statusCode !== 200) {
                        if (res2.statusCode === 301 || res2.statusCode === 302 || res2.statusCode === 307 || res2.statusCode === 308) {
                            var loc = res2.headers.location;
                            if (loc) { _doW(loc, isFallback); return; }
                        }
                        if (!isFallback) {
                            bootLog('webapp-update: primary failed (status=' + res2.statusCode + '), trying OSS fallback…');
                            _doW(fallbackDlUrl, true);
                            return;
                        }
                        bootLog('webapp-update: download failed (status=' + res2.statusCode + ')');
                        resolve(false);
                        return;
                    }
                    var f2 = _trackW(res2);
                    f2.on('finish', function () { resolve(true); });
                    f2.on('error', function () { resolve(false); });
                });
                r.on('error', function (e: any) {
                    if (!isFallback) {
                        bootLog('webapp-update: primary error ' + (e && e.message || e) + ', trying OSS fallback…');
                        _doW(fallbackDlUrl, true);
                        return;
                    }
                    resolve(false);
                });
                r.on('timeout', function () { r.destroy(); if (!isFallback) { _doW(fallbackDlUrl, true); } else { resolve(false); } });
            };
            _doW(dlUrl, false);
        });
        if (!dlOk) {
            bootLog('webapp-update: download failed');
            // ★ 清理 loading-status 防止 C 启动器显示僵尸进度
            try { fs.unlinkSync(path.join(portableRoot, 'loading-status')); } catch (_) { }
            return;
        }

        // 4) Extract to staging
        const stagingDir = path.join(portableRoot, 'Data', 'webapp-staging');
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }
        try { fs.mkdirSync(stagingDir, { recursive: true }); } catch { }
        const extractResult = spawnSync('tar', ['-xzf', tarPath, '-C', stagingDir], {
            stdio: 'pipe', timeout: 30000,
        });
        if (extractResult.status !== 0) {
            bootLog('webapp-update: extract failed, status=' + extractResult.status);
            try { fs.rmSync(tarPath); } catch { }
            // ★ 清理半残 staging，防止下次启动 ensureLocalWebapp 误 swap 进去
            try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { }
            try { fs.unlinkSync(path.join(portableRoot, 'loading-status')); } catch (_) { }
            return;
        }
        try { fs.unlinkSync(tarPath); } catch { }

        // 5) Write version marker
        writeLocalWebappVersion(portableRoot, latestVersion);

        // ★ 清理 loading-status（成功完成）
        try { fs.unlinkSync(path.join(portableRoot, 'loading-status')); } catch (_) { }

        bootLog('webapp-update: staged for next restart — ' + stagingDir);
    } catch (e: any) {
        bootLog('webapp-update: error — ' + (e.message || e));
        // ★ 异常也清理 loading-status
        try { fs.unlinkSync(path.join(portableRoot, 'loading-status')); } catch (_) { }
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
    // ★ 启动已完成 → 绝不覆盖已运行的 IDE
    if (bootCompleted) {
        bootLog('fallback: BLOCKED — boot already completed, refusing to replace IDE');
        return 'fallback';
    }
    bootLog('fallback: reason=' + reason);
    const candidates = [
        path.join(__dirname, '..', 'shell', 'boot-fallback.html'),
        path.join(__dirname, 'boot-fallback.html'),
        path.join(portableRoot, 'shell', 'boot-fallback.html'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                await mainWindow.loadFile(p, { query: { url: bootConfig.url, reason } });
            } catch (e) {
                bootLog('fallback: loadFile crashed — ' + (e && (e as Error).message || String(e)));
                // 最后的最后的兜底：data URL
                try { await mainWindow.loadURL('data:text/html,<h1>qqqide offline</h1><p>请重启应用</p>'); } catch (_) { }
            }
            return 'fallback';
        }
    }
    try { await mainWindow.loadURL('data:text/html,<h1>qqqide offline</h1><p>请重启应用</p>'); } catch (_) { }
    return 'fallback';
}

export async function loadRemoteWithCacheGuard(
    mainWindow: BrowserWindow | null,
    bootConfig: BootConfig,
    timeoutMs: number = 0,
    isDev: boolean = false,
    portableRoot: string = '',
): Promise<{ ok: boolean; mode: BootMode }> {
    if (!mainWindow) { bootLog('remote: no window'); return { ok: false, mode: 'fallback' }; }
    bootLog('remote: loading ' + bootConfig.url + (timeoutMs > 0 ? ' timeout=' + timeoutMs + 'ms' : ''));
    const wc = mainWindow.webContents;
    return new Promise<{ ok: boolean; mode: BootMode }>(resolve => {
        let settled = false;
        let timeoutTimer: NodeJS.Timeout | null = null;
        let panelTimer: NodeJS.Timeout | null = null;
        let progressTickId: NodeJS.Timeout | null = null;
        const PANEL_MAX_MS = 30000;     // 加载面板最多撑 30s
        const writeLoadingStatus = (line: string) => {
            writeBootStatus(portableRoot, line);
        };

        // ── 资源追踪（进度条用）+ 耗时统计 + 冷却期 ──
        let pendingReqs = 0;
        let doneReqs = 0;
        let domReadyFired = false;
        const session = wc.session;
        const reqStartTimes = new Map<string, number>();
        let cooldownTimer: NodeJS.Timeout | null = null;
        const COOLDOWN_MS = 4000; // 4 秒无新请求 → 真·完成（SPA 动态 import 链）
        const onBeforeReq = (details: any, cb: any) => {
            const now = Date.now();
            reqStartTimes.set(details.url, now);
            pendingReqs++;
            // 冷却期被打断 → 重置计时器
            if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
            const shortUrl = details.url?.slice(0, 100);
            bootLog('webReq: +' + pendingReqs + ' ' + details.resourceType + ' ' + shortUrl);
            cb({});
        };
        const onReqDone = (details: any) => {
            doneReqs++;
            pendingReqs = Math.max(0, pendingReqs - 1);
            const startTime = reqStartTimes.get(details.url);
            const elapsed = startTime ? Date.now() - startTime : -1;
            reqStartTimes.delete(details.url);
            if (elapsed > 1500) {
                bootLog('webReq: SLOW ' + elapsed + 'ms ' + details.resourceType + ' ' + details.url?.slice(0, 80));
            } else {
                bootLog('webReq: ✓' + elapsed + 'ms ' + details.resourceType + ' ' + details.url?.slice(0, 80));
            }
            tryCooldown();
        };
        const onReqErr = (details: any) => {
            pendingReqs = Math.max(0, pendingReqs - 1);
            const startTime = reqStartTimes.get(details.url);
            const elapsed = startTime ? Date.now() - startTime : -1;
            reqStartTimes.delete(details.url);
            bootLog('webReq: ERR ' + elapsed + 'ms ' + details.resourceType + ' ' + details.url?.slice(0, 80));
            tryCooldown();
        };
        const tryCooldown = () => {
            if (pendingReqs === 0 && doneReqs > 0 && !cooldownTimer) {
                bootLog('webReq: cooldown started — pending=0 done=' + doneReqs + ' wait=' + COOLDOWN_MS + 'ms');
                cooldownTimer = setTimeout(() => {
                    bootLog('webReq: cooldown expired — truly done (total=' + doneReqs + ')');
                    onAllReady();
                }, COOLDOWN_MS);
            }
        };

        // ── 加载面板 ──
        const injectLoadingPanel = () => {
            const css = `
                #__qqq_boot_panel{position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;
                background:#fdf6e3;display:flex;align-items:center;justify-content:center;
                font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}
                #__qqq_boot_panel .wrap{text-align:center;max-width:420px;padding:32px}
                #__qqq_boot_panel .spinner{width:36px;height:36px;margin:0 auto 20px;
                border:3px solid #eee8d5;border-top-color:#268bd2;border-radius:50%;
                animation:__qqq_spin .8s linear infinite}
                #__qqq_boot_panel .stage{color:#586e75;font-size:14px;margin-bottom:20px;min-height:20px}
                #__qqq_boot_panel .bar-bg{background:#eee8d5;border-radius:8px;height:8px;overflow:hidden}
                #__qqq_boot_panel .bar-fg{background:linear-gradient(90deg,#268bd2,#2aa198);height:100%;width:0%;transition:width .3s ease}
                #__qqq_boot_panel .pct{color:#93a1a1;font-size:12px;margin-top:8px}
                @keyframes __qqq_spin{to{transform:rotate(360deg)}}
            `.replace(/\n\s*/g, '');
            const html = '<div id="__qqq_boot_panel"><div class="wrap"><div class="spinner"></div><div class="stage">正在连接服务器…</div><div class="bar-bg"><div class="bar-fg" id="__qqq_boot_bar"></div></div><div class="pct" id="__qqq_boot_pct">0%</div></div></div>';
            wc.executeJavaScript(`
                try{
                    // ★ 彻底隐藏 IDE 内容 — 不是遮罩，是完全不显示
                    var hideCSS=document.createElement("style");
                    hideCSS.id="__qqq_boot_hide";
                    hideCSS.textContent="html>body>:not(#__qqq_boot_panel){display:none!important}";
                    document.head.appendChild(hideCSS);
                    // 注入面板
                    var panelCSS=document.createElement("style");
                    panelCSS.textContent=\`${css}\`;document.head.appendChild(panelCSS);
                    var d=document.createElement("div");
                    d.innerHTML=\`${html}\`;document.body.appendChild(d.firstElementChild);
                }catch(_){}
            `).catch(() => { });
        };
        const updateLoadingPanel = (stage: string, pct: number) => {
            writeLoadingStatus(pct + '|' + stage);
            wc.executeJavaScript(`
                try{
                    var s=document.getElementById("__qqq_boot_pct");
                    if(s&&s.parentElement){s.textContent="${pct}%"}
                    var b=document.getElementById("__qqq_boot_bar");
                    if(b){b.style.width="${pct}%"}
                    Array.from(document.querySelectorAll("#__qqq_boot_panel .stage")).forEach(function(e){e.textContent="${stage}"})
                }catch(_){}
            `.replace(/\n\s*/g, '')).catch(() => { });
        };
        const removeLoadingPanel = () => {
            if (panelTimer) { clearTimeout(panelTimer); panelTimer = null; }
            if (progressTickId) { clearInterval(progressTickId); progressTickId = null; }
            wc.executeJavaScript(`
                try{
                    var p=document.getElementById("__qqq_boot_panel");if(p)p.remove();
                    var h=document.getElementById("__qqq_boot_hide");if(h)h.remove();
                }catch(_){}
            `).catch(() => { });
        };
        const updateProgress = () => {
            const total = pendingReqs + doneReqs;
            if (total === 0) { return; }
            const pct = Math.min(94, Math.round(doneReqs / Math.max(total, 1) * 100));
            const stage = pct < 30 ? '正在加载页面结构…'
                : pct < 60 ? '正在加载组件脚本…'
                    : pct < 85 ? '正在加载样式资源…'
                        : '正在初始化 IDE…';
            updateLoadingPanel(stage, pct);
            // ★ Win7 上 dom-ready/did-stop-loading 均不触发，通过 webReq 冷却期判断完成
            if (pendingReqs === 0 && doneReqs > 0) {
                tryCooldown();
            }
        };
        let readyShown = false;     // onAllReady 防重入
        const onAllReady = () => {
            if (readyShown) { return; }
            readyShown = true;
            // ★ 最终清理：移除所有后续事件监听
            if (progressTickId) { clearInterval(progressTickId); progressTickId = null; }
            if (panelTimer) { clearTimeout(panelTimer); panelTimer = null; }
            if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
            // ★ 不清理 webRequest — 冷却期确保没有新请求，保留以观测后续动态加载
            wc.removeListener('did-start-navigation', onStartNav);
            wc.removeListener('did-navigate', onNavigate);
            wc.removeListener('dom-ready', onDomReady);
            wc.removeListener('did-finish-load', onFinish);
            wc.removeListener('did-stop-loading', onStopLoading);
            wc.removeListener('did-fail-load', onFail);
            bootLog('remote: all resources loaded + dom-ready → IDE ready');
            updateLoadingPanel('正在启动 IDE…', 100);
            writeLoadingStatus('ready');
            // ★ 重要：resolve Promise，否则 30s 超时会把 fallback 盖到 IDE 上
            finish(true, 'live');
            setTimeout(() => {
                removeLoadingPanel();
                // ★ 显示 Electron 窗口 — 此前一直隐藏，launcher 用小窗口展示进度
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.show();
                    mainWindow.focus();
                }
                bootLog('remote: panel removed, IDE shown');
            }, 400);  // 短暂延迟让用户看到 100%
        };

        // ── cleanup & finish ──
        const cleanupWebRequest = () => {
            try { session.webRequest.onBeforeRequest(null as any, null as any); } catch (_) { }
            try { session.webRequest.onCompleted(null as any, null as any); } catch (_) { }
            try { session.webRequest.onErrorOccurred(null as any, null as any); } catch (_) { }
        };
        const finish = (ok: boolean, mode: BootMode) => {
            if (settled) { return; }
            settled = true;
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            // ★ 不要让 finish 移除 dom-ready / did-stop-loading 监听器
            //    这些事件在 did-navigate 之后才异步触发，finish 在 onNavigate 里同步调用
            //    只有 onAllReady() 或 fallback 时才能安全移除
            if (!ok && mode === 'fallback') {
                cleanupWebRequest();
                wc.removeListener('did-start-navigation', onStartNav);
                wc.removeListener('did-navigate', onNavigate);
                wc.removeListener('dom-ready', onDomReady);
                wc.removeListener('did-finish-load', onFinish);
                wc.removeListener('did-stop-loading', onStopLoading);
                wc.removeListener('did-fail-load', onFail);
                removeLoadingPanel();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.show();
                    mainWindow.focus();
                }
                try { wc.stop(); } catch (_) { }
            }
            bootLog('remote: ' + (ok ? 'LOADED' : 'FAILED') + ' mode=' + mode);
            resolve({ ok, mode });
        };

        // ── 事件：启动追踪、注入面板、完成 ──
        const onStartNav = (_e: any, _url: string, _inFrame: boolean, _isMain: boolean) => {
            if (!_isMain) { return; }
            bootLog('remote: did-start-navigation ' + _url);
        };
        const onNavigate = (_e: any, _url: string, httpCode: number) => {
            bootLog('remote: did-navigate http=' + httpCode);
            if (httpCode >= 200 && httpCode < 400) {
                if (!isDev) { injectLoadingPanel(); updateLoadingPanel('正在解析页面…', 5); }
                // ★ 时间兜底进度 + 定期状态报告
                let lastPct = 5;
                let tickCount = 0;
                progressTickId = setInterval(() => {
                    tickCount++;
                    // 每 15 秒打一次心跳，知道卡在哪儿
                    if (tickCount % 6 === 0 && !domReadyFired) {
                        bootLog('webReq: heartbeat pending=' + pendingReqs + ' done=' + doneReqs + ' domReadyFired=' + domReadyFired + ' tickPct=' + lastPct);
                    }
                    if (domReadyFired || (pendingReqs === 0 && doneReqs > 0)) {
                        clearInterval(progressTickId!); progressTickId = null; return;
                    }
                    lastPct = Math.min(88, lastPct + 6);
                    const stage = lastPct < 35 ? '正在加载页面结构…'
                        : lastPct < 60 ? '正在加载组件脚本…'
                            : lastPct < 80 ? '正在加载样式资源…'
                                : '正在初始化 IDE…';
                    updateLoadingPanel(stage, lastPct);
                }, 2500);
                // 10 分钟终极兜底（跨洋弱网 + Win7 极端慢）
                panelTimer = setTimeout(() => {
                    bootLog('remote: ultimate fallback after 10min — force show (pending=' + pendingReqs + ' done=' + doneReqs + ')');
                    updateLoadingPanel('即将完成…', 95);
                    writeLoadingStatus('ready');  // ★ 告知 C 启动器可以关了
                    removeLoadingPanel();
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }, 600000);
                finish(true, 'live');
            } else {
                finish(false, 'fallback');
            }
        };
        const onDomReady = () => {
            bootLog('remote: dom-ready');
            domReadyFired = true;
            // ★ 兜底：webRequest 没追踪到资源时，dom-ready 本身就是强信号
            if (doneReqs === 0) {
                bootLog('remote: dom-ready fallback (no requests tracked) → 90%');
                updateLoadingPanel('正在初始化 IDE…', 90);
            }
            if (pendingReqs === 0) { onAllReady(); }
        };
        const onFinish = () => {
            bootLog('remote: did-finish-load (onload)');
        };
        // ★ did-stop-loading：比 onload/dom-ready 更可靠，浏览器加载指示器停止即触发
        const onStopLoading = () => {
            bootLog('remote: did-stop-loading');
            if (progressTickId) { clearInterval(progressTickId); progressTickId = null; }
            onAllReady();
        };
        const onFail = (_e: any, code: number, desc: string, validatedURL: string, isMain: boolean) => {
            if (!isMain) { return; }
            bootLog('remote: did-fail-load code=' + code + ' desc=' + desc + ' url=' + validatedURL);
            finish(false, 'fallback');
        };

        // ── 兜底超时 ──
        if (timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                bootLog('remote: TIMEOUT (did-navigate never fired) after ' + timeoutMs + 'ms');
                finish(false, 'fallback');
            }, timeoutMs);
        }
        // ★ 面板 timer 移到 onNavigate 里 — 不能从函数入口就开始计时

        wc.on('did-start-navigation', onStartNav);
        wc.on('did-navigate', onNavigate);
        wc.on('dom-ready', onDomReady);
        wc.on('did-finish-load', onFinish);
        wc.on('did-stop-loading', onStopLoading);
        wc.on('did-fail-load', onFail);

        // ★ 提前注册 webRequest 追踪 — 在 loadURL 之前，确保捕获所有子资源（无 filter=全量匹配）
        session.webRequest.onBeforeRequest(onBeforeReq as any);
        session.webRequest.onCompleted(onReqDone as any);
        session.webRequest.onErrorOccurred(onReqErr as any);

        // ★ 可重试连接错误：ERR_CONNECTION_REFUSED（dev 服务器抢跑）、ERR_FAILED（Win7 SSL）
        let loadRetries = 0;
        const doLoad = () => {
            mainWindow!.loadURL(bootConfig.url).catch(err => {
                const msg = err && (err as Error).message || String(err);
                bootLog('remote: loadURL error — ' + msg);
                const retryable = /ERR_FAILED|ERR_CONNECTION_REFUSED|ERR_TIMED_OUT|ERR_CONNECTION_RESET/i.test(msg);
                if (retryable && loadRetries < 5) {
                    loadRetries++;
                    bootLog('remote: retry ' + loadRetries + '/5 in 3s…');
                    setTimeout(doLoad, 3000);
                    return;
                }
                finish(false, 'fallback');
            });
        };
        doLoad();
    });
}

// ----------------------------------------------------------------------------
// Boot orchestrator
// ----------------------------------------------------------------------------

/**
 * Compute the effective base URL for loading the webapp.
 * Priority: local webapp bundle (qqqide-webapp://) > remote URL.
 */
export function getWebappBaseUrl(portableRoot: string, bootConfig: BootConfig, isDev: boolean): string {
    if (isDev) {
        return 'http://127.0.0.1:8090/qqqide/';
    }
    const webappDir = ensureLocalWebapp(portableRoot);
    if (webappDir) {
        registerWebappProtocol(webappDir);
        return WEBAPP_PROTOCOL + '://app/qqqide/index.html';
    }
    return bootConfig.url;
}

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
    // 0) Init boot file log + clean stale loading-status (from previous run)
    const bootT0 = Date.now();
    initBootLog(path.join(portableRoot, 'Data', 'Logs'));
    try { fs.unlinkSync(path.join(portableRoot, 'loading-status')); } catch (_) { }
    writeBootStatus(portableRoot, '0|正在启动…');

    // ★ 开发模式：直连本地 dev-server，不走网络
    const DEV_URL = 'http://127.0.0.1:8090/qqqide/';
    if (isDev) {
        bootConfig.url = DEV_URL;
        bootConfig.healthTimeoutMs = 500;  // 本地极快，不等
        bootLog('dev: forced local URL → ' + DEV_URL);
    }
    bootLog('url: ' + bootConfig.url);

    // ★★ 本地 webapp 优先：首次免网秒开，后续从本地加载 + 后台静默更新
    let effectiveUrl = getWebappBaseUrl(portableRoot, bootConfig, isDev);
    if (effectiveUrl.startsWith(WEBAPP_PROTOCOL)) {
        bootLog('local: using bundled webapp (no network needed for first boot)');
    } else {
        bootLog('local: no webapp found, will load from remote');
    }
    const isLocal = effectiveUrl.startsWith(WEBAPP_PROTOCOL);

    // ── 缓存破坏: 每次启动带上版本号，确保加载最新资源 ──
    const bootVersion = readLocalWebappVersion(portableRoot) || readLocalShellVersion(portableRoot) || APP_VERSION;
    const sep = effectiveUrl.includes('?') ? '&' : '?';
    effectiveUrl = effectiveUrl + sep + '_v=' + encodeURIComponent(bootVersion);
    bootLog('cache-bust: version=' + bootVersion);

    // 1) Show fallback — skip if local (instant boot, no "connecting…" needed)
    if (!isLocal) {
        try {
            await loadStaticFallback(mainWindow, bootConfig, portableRoot, 'connecting');
        } catch (e) {
            bootLog('seq: initial fallback crashed — ' + (e && (e as Error).message || String(e)));
        }
        bootLog('phase: fallback-shown ' + (Date.now() - bootT0) + 'ms');
    } else {
        bootLog('local: skipping fallback (instant boot)');
    }

    // 2) Check for shell-code hot-update (non-blocking, always try)
    checkAndDownloadShellUpdate(bootConfig, portableRoot, portableCache, isDev, isOffline).then(updated => {
        if (updated) {
            console.log('[boot] shell update staged — will apply on next restart');
        }
    }).catch(() => { });

    // 3) Health check — skip if local (local files don't need server)
    const healthy = isLocal ? false : isDev ? true : await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs, isOffline);
    if (isLocal) {
        bootLog('seq: local boot, skipping health check');
    } else if (healthy) {
        bootLog('seq: server OK (' + (Date.now() - bootT0) + 'ms)');
    } else {
        bootLog('seq: server unreachable (' + (Date.now() - bootT0) + 'ms)');
    }

    // 4) Try remote with 15s timeout
    //    loadURL() 会自动替换当前 fallback 页面，用户无缝过渡到正式应用
    const REMOTE_TIMEOUT_MS = 30000;  // 只等 HTML（did-navigate），不等子资源
    const loadConfig = { ...bootConfig, url: effectiveUrl };
    const { ok, mode } = await loadRemoteWithCacheGuard(mainWindow, loadConfig, REMOTE_TIMEOUT_MS, isDev, portableRoot);
    const bootT3 = Date.now();
    if (ok) {
        bootLog('seq: remote OK, boot complete — total ' + (bootT3 - bootT0) + 'ms');
        bootCompleted = true;
        setLastBootMode(mode);
        // ★★ 20s 后后台检查 webapp 更新（错过启动高峰，每窗口生命周期仅一次）
        if (!isDev) {
            const _url = bootConfig.url;  // always use remote URL for updates
            const _root = portableRoot;
            setTimeout(() => {
                backgroundCheckWebappUpdate({ ...bootConfig, url: _url }, _root).catch(() => { });
            }, 20000);
        }
    } else {
        // Reload fallback with actual error reason (was 'connecting' before)
        const reason = healthy ? 'load-failed' : 'no-network-no-cache';
        bootLog('seq: FAILED — staying on fallback, reason=' + reason + ' total ' + (bootT3 - bootT0) + 'ms');
        try {
            await loadStaticFallback(mainWindow, bootConfig, portableRoot, reason);
        } catch (e) {
            bootLog('seq: loadStaticFallback crashed — ' + (e && (e as Error).message || String(e)));
        }
        setLastBootMode('fallback');
    }
}
