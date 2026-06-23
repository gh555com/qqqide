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
        const LOADING_STATUS_PATH = portableRoot ? path.join(portableRoot, 'loading-status') : '';
        const writeLoadingStatus = (line: string) => {
            if (!LOADING_STATUS_PATH) { return; }
            try { fs.writeFileSync(LOADING_STATUS_PATH, line, 'utf-8'); } catch (_) { }
        };

        // ── 资源追踪（进度条用） ──
        let pendingReqs = 0;
        let doneReqs = 0;
        let domReadyFired = false;
        const session = wc.session;
        const reqFilter = { urls: ['*://*/*'] };
        const onBeforeReq = (details: any, cb: any) => {
            if (details.resourceType === 'mainFrame') { cb({}); return; }
            pendingReqs++;
            cb({});
        };
        const onReqDone = (details: any) => {
            if (details.resourceType === 'mainFrame') { return; }
            doneReqs++;
            pendingReqs = Math.max(0, pendingReqs - 1);
            updateProgress();
        };
        const onReqErr = (details: any) => {
            if (details.resourceType === 'mainFrame') { return; }
            pendingReqs = Math.max(0, pendingReqs - 1);
            updateProgress();
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
            const pct = Math.min(98, Math.round(doneReqs / Math.max(total, 1) * 100));
            const stage = pct < 30 ? '正在加载页面结构…'
                : pct < 60 ? '正在加载组件脚本…'
                    : pct < 85 ? '正在加载样式资源…'
                        : '正在初始化 IDE…';
            updateLoadingPanel(stage, pct);
            // 资源都加载完 + dom-ready → 就绪
            if (pendingReqs === 0 && domReadyFired) {
                onAllReady();
            }
        };
        const onAllReady = () => {
            if (settled) { return; }
            bootLog('remote: all resources loaded + dom-ready → IDE ready');
            updateLoadingPanel('正在启动 IDE…', 100);
            writeLoadingStatus('ready');
            setTimeout(() => {
                if (settled) { return; }
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
            try { session.webRequest.onBeforeRequest(reqFilter, null as any); } catch (_) { }
            try { session.webRequest.onCompleted(reqFilter, null as any); } catch (_) { }
            try { session.webRequest.onErrorOccurred(reqFilter, null as any); } catch (_) { }
        };
        const finish = (ok: boolean, mode: BootMode) => {
            if (settled) { return; }
            settled = true;
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
            cleanupWebRequest();
            wc.removeListener('did-start-navigation', onStartNav);
            wc.removeListener('did-navigate', onNavigate);
            wc.removeListener('dom-ready', onDomReady);
            wc.removeListener('did-finish-load', onFinish);
            wc.removeListener('did-stop-loading', onStopLoading);
            wc.removeListener('did-fail-load', onFail);
            if (!ok && mode === 'fallback') {
                removeLoadingPanel();
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
                // ★ 时间兜底进度：每 2s 推进，写 loading-status 文件给 C 启动器
                let lastPct = 5;
                progressTickId = setInterval(() => {
                    if (domReadyFired) { clearInterval(progressTickId!); progressTickId = null; return; }
                    lastPct = Math.min(88, lastPct + 6);
                    const stage = lastPct < 35 ? '正在加载页面结构…'
                        : lastPct < 60 ? '正在加载组件脚本…'
                        : lastPct < 80 ? '正在加载样式资源…'
                        : '正在初始化 IDE…';
                    updateLoadingPanel(stage, lastPct);
                }, 2500);
                // 10 分钟终极兜底（跨洋弱网 + Win7 极端慢）
                panelTimer = setTimeout(() => {
                    bootLog('remote: ultimate fallback after 10min — force show');
                    updateLoadingPanel('即将完成…', 95);
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

        // ★ 提前注册 webRequest 追踪 — 在 loadURL 之前，确保捕获所有子资源
        session.webRequest.onBeforeRequest(reqFilter, onBeforeReq);
        session.webRequest.onCompleted(reqFilter, onReqDone);
        session.webRequest.onErrorOccurred(reqFilter, onReqErr);

        // ★ ERR_FAILED 重试：Win7 + Chromium 108 SSL 预热问题
        let loadRetries = 0;
        const doLoad = () => {
            mainWindow!.loadURL(bootConfig.url).catch(err => {
                const msg = err && (err as Error).message || String(err);
                bootLog('remote: loadURL error — ' + msg);
                if (msg.includes('ERR_FAILED') && loadRetries < 2) {
                    loadRetries++;
                    bootLog('remote: ERR_FAILED retry ' + loadRetries + '/2, waiting 3s...');
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
    initBootLog(path.join(portableRoot, 'userData', 'Logs'));
    try { fs.unlinkSync(path.join(portableRoot, 'loading-status')); } catch (_) { }

    // ★ 开发模式：直连本地 dev-server，不走网络
    const DEV_URL = 'http://127.0.0.1:8090/qqq-app/';
    if (isDev) {
        bootConfig.url = DEV_URL;
        bootConfig.healthTimeoutMs = 500;  // 本地极快，不等
        bootLog('dev: forced local URL → ' + DEV_URL);
    }
    bootLog('url: ' + bootConfig.url);

    // 1) Show fallback IMMEDIATELY → 窗口在 <1s 内弹出，用户看到"连接中…"
    await loadStaticFallback(mainWindow, bootConfig, portableRoot, 'connecting');

    // 2) Check for shell-code hot-update (non-blocking)
    checkAndDownloadShellUpdate(bootConfig, portableCache, isDev, isOffline).then(updated => {
        if (updated) {
            console.log('[boot] shell update staged — will apply on next restart');
        }
    }).catch(() => { });

    // 3) Health check (fast, 3s timeout) — skip in dev mode (localhost)
    const healthy = isDev ? true : await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs, isOffline);
    if (healthy) {
        bootLog('seq: server OK');
    } else {
        bootLog('seq: server unreachable');
    }

    // 4) Try remote with 15s timeout
    //    loadURL() 会自动替换当前 fallback 页面，用户无缝过渡到正式应用
    const REMOTE_TIMEOUT_MS = 30000;  // 只等 HTML（did-navigate），不等子资源
    const { ok, mode } = await loadRemoteWithCacheGuard(mainWindow, bootConfig, REMOTE_TIMEOUT_MS, isDev, portableRoot);
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
