// ============================================================================
// main.ts - Electron main process entry
// MUST import portable-paths FIRST so paths are redirected before anything
// else touches them.
// ============================================================================

import { applyPortablePaths, getAppRoot } from './portable-paths';

// (1) Apply portable redirects BEFORE any electron module loads further.
// Note: importing 'electron' is fine since `app` is what we redirect through.
const portable = applyPortablePaths();

import { app, BrowserWindow, ipcMain, dialog, shell as electronShell, session, protocol, nativeTheme, globalShortcut, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { EngineHost } from './engines';
import { AudioEngine } from './audio-engine';
import { applyMenuSchema, MenuSchema } from './menu-builder';
import { MonacoHost } from './monaco-host';
import { spawn as cpSpawn, spawnSync, ChildProcess } from 'child_process';
import { QzSpawn, SpawnBrief } from './qz-spawn';
import { LspBridge } from './lsp-bridge';
import { CacheStore } from './cache-store';
import { HashService } from './hash-service';
import { MediaService } from './media-service';
import { StateStore, NsSchema } from './state-sqlite';
import { StateCloud } from './state-cloud';
import { Qg } from './qg';
import { DownloadService, DownloadOpts } from './download-service';
import { UpdateService } from './update-service';

// ----------------------------------------------------------------------------
// Chromium flags: MUST be set before app.whenReady()
// Force-disable Windows High Contrast / Forced Colors at the renderer level.
// CSS forced-color-adjust alone is insufficient; Chromium needs explicit opt-out.
// ----------------------------------------------------------------------------
app.commandLine.appendSwitch('forced-colors', 'none');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'ForcedColors,AutoDarkMode');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------
const APP_VERSION = '0.0.2';
const DEFAULT_REMOTE_URL = 'http://127.0.0.1:8090/qqq-app/';

// ----------------------------------------------------------------------------
// Boot configuration: read app-dir-local config.json (NEVER touches AppData)
// ----------------------------------------------------------------------------
interface BootConfig {
    url: string;
    healthTimeoutMs: number;
}

function loadBootConfig(): BootConfig {
    const cfgPath = path.join(portable.root, 'config.json');
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
        // First-run convenience: drop a template config.json next to the exe
        // so users (or the qz launcher) can edit URL without code changes.
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

const bootConfig = loadBootConfig();
const isOfflineFlag = process.argv.includes('--offline');
const isDevFlag = process.argv.includes('--dev') || process.env.QQQIDE_DEV === '1';

// ----------------------------------------------------------------------------
// Shell hot-update: download shell-out.tar.xz from remote, stage for bootstrap
// ----------------------------------------------------------------------------
const SHELL_UPDATE_URL = 'shell-out.tar.gz';  // relative to bootConfig.url

async function _checkAndDownloadShellUpdate(): Promise<boolean> {
    // Skip in dev mode — dev uses esbuild watch
    if (isDevFlag || isOfflineFlag) return false;

    const shellOutDir = path.join(__dirname); // shell-out/
    const stagingDir = path.join(portable.cache, 'staging', 'shell-out-next');
        const tarPath = path.join(portable.cache, 'staging', 'shell-out.tar.gz');

    try {
        // Build the full update URL
        const baseUrl = bootConfig.url.endsWith('/') ? bootConfig.url : bootConfig.url + '/';
        const updateUrl = baseUrl + SHELL_UPDATE_URL;

        // Check if remote file exists (HEAD request or just try downloading)
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

        // Compare with local version (stored in cache/shell-version)
        const localVersionPath = path.join(portable.cache, 'shell-version');
        let localVersion = '';
        try {
            if (fs.existsSync(localVersionPath)) {
                localVersion = fs.readFileSync(localVersionPath, 'utf8').trim();
            }
        } catch {}

        if (latestVersion && localVersion === latestVersion) {
            return false; // Already up to date
        }

        // Download shell-out.tar.xz
        console.log('[shell-update] downloading', updateUrl);
        try { fs.mkdirSync(path.dirname(tarPath), { recursive: true }); } catch {}

        const downloadOk = await new Promise<boolean>((resolve) => {
            const req = lib.get(updateUrl, { timeout: 30000 }, (res) => {
                if (res.statusCode !== 200) {
                    // Follow redirect
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        const loc = res.headers.location;
                        if (loc) {
                            // Simple redirect follow
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
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
        try { fs.mkdirSync(stagingDir, { recursive: true }); } catch {}

        const extractResult = spawnSync('tar', ['-xzf', tarPath, '-C', stagingDir], {
            stdio: 'pipe',
            timeout: 15000,
        });

        if (extractResult.status !== 0) {
            console.log('[shell-update] extract failed, status:', extractResult.status);
            try { fs.rmSync(tarPath); } catch {}
            return false;
        }

        // Cleanup tar
        try { fs.unlinkSync(tarPath); } catch {}

        // Save version
        if (latestVersion) {
            try {
                fs.mkdirSync(path.dirname(localVersionPath), { recursive: true });
                fs.writeFileSync(localVersionPath, latestVersion, 'utf8');
            } catch {}
        }

        console.log('[shell-update] staged for next restart:', stagingDir);
        return true;
    } catch (e: any) {
        console.log('[shell-update] error:', e.message || e);
        return false;
    }
}

// ----------------------------------------------------------------------------
// Health check: fetches <url>/health with timeout, no exception escapes.
// ----------------------------------------------------------------------------
function healthCheck(urlStr: string, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        if (isOfflineFlag) { return resolve(false); }
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

// Register custom protocol BEFORE app is ready so renderer can use it.
// `qqqide-asset://<resource>/<path>` maps to local files bundled with the shell.
//   resource = "monaco" -> node_modules/monaco-editor/min/<path>
//   resource = "shell"  -> shell/<path>
protocol.registerSchemesAsPrivileged([
    { scheme: 'qqqide-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ----------------------------------------------------------------------------
// Window
// ----------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
// 外嵌 AI 面板（僚机窗口）
// 架构铁律：不可拖动(movable:false)、不可调大小(resizable:false)、与主窗口同z-order
// 不可拖动+不可调大小本身已防篡改，无需 snapBack 弹回（避免抢焦点）
const _externalPanels: (BrowserWindow | null)[] = [null, null];
// 僚机关闭许可标志（仅 before-quit / window-all-closed / SIGINT / SIGTERM 设为 true）
let _allowExtClose = false;
// 窗口↔项目 双向映射（用于主文件夹锁：同一文件夹只能在一个窗口作为主文件夹）
const _windowProjectMap = new Map<number, string>();   // windowId → projectRoot
const _projectWindowMap = new Map<string, number>();   // projectRoot → windowId
const engineHost = new EngineHost(portable.root);
const audioEngine = new AudioEngine(portable.root);
const monacoHost = new MonacoHost();
const qzSpawn = new QzSpawn(portable.root);
const lspBridge = new LspBridge(portable.root);
const cacheStore = new CacheStore(portable.cache);
const hashService = new HashService(cacheStore);
const mediaService = new MediaService(portable.root, qzSpawn, cacheStore, hashService);
const stateStore = new StateStore(portable.userData);
const stateCloud = new StateCloud(stateStore);
// qg instances: one per project rootDir (lazy created on first IPC call)
const _qgInstances: Map<string, Qg> = new Map();
// Project-level StateStore instances (one per quest.sq3 dbPath)
const _projectStateStores: Map<string, StateStore> = new Map();
const downloadService = new DownloadService(portable.cache);
const updateService = new UpdateService(portable.root, APP_VERSION);

// ---- shell-side state registrations (zoom, asset_roots, window_layout) ----
// We register these before any IPC handler fires so renderer can read them.
function registerShellState(): void {
    try {
        stateStore.register('qqqide', {
            v: 1, form: 'doc', cloud: true,
            // merger: prefer remote scalars; for asset_roots merge as union of arrays
            merger: (local: any, remote: any, ctx) => {
                if (!local) { return remote; }
                if (!remote) { return local; }
                // Generic shallow merge: remote keys overwrite local
                if (typeof local === 'object' && typeof remote === 'object' && !Array.isArray(local) && !Array.isArray(remote)) {
                    return { ...local, ...remote };
                }
                // Arrays: union dedup (asset_roots)
                if (Array.isArray(local) && Array.isArray(remote)) {
                    const s = new Set([...local, ...remote]);
                    return Array.from(s);
                }
                return remote;
            },
        });
    } catch (e) {
        console.warn('[state] registerShellState failed:', e);
    }
}
// Forward stateStore changes to renderer (preload exposes onChange).
stateStore.on('changed', (msg: any) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        try { mainWindow.webContents.send('qqqide:state:changed', msg); } catch { /* ignore */ }
    }
});

// ---- Persisted zoom factor (UI scale, like VSCode View > Appearance > Zoom) ----
// Stored alongside config.json so qz/portable VM snapshots carry it.
// Module scope so IPC handlers below can read/write it.
// MIGRATION: legacy zoom.json (now read-only). Authoritative source is
// stateStore key 'qqqide/zoom' (doc, cloud=true). On boot we prefer that;
// if missing we one-time import from legacy zoom.json and rename it .migrated.
const zoomFile = path.join(portable.root, 'zoom.json');
let zoomFactor = 0.85; // default 15% smaller than 100%
async function _restoreWindowBounds(win: BrowserWindow): Promise<void> {
    try {
        const v = await stateStore.get('qqqide', 'window_bounds');
        if (!v) { return; }
        if (v.maximized) {
            win.maximize();
            return;
        }
        if (typeof v.w === 'number' && typeof v.h === 'number' && v.w > 0 && v.h > 0) {
            // Guard: ensure bounds are at least partially on-screen (handle monitor detach).
            const displays = screen.getAllDisplays();
            const anyOverlap = displays.some(d => {
                const dx = d.bounds.x, dy = d.bounds.y, dw = d.bounds.width, dh = d.bounds.height;
                return (v.x < dx + dw && v.x + v.w > dx && v.y < dy + dh && v.y + v.h > dy);
            });
            if (anyOverlap) {
                win.setBounds({ x: v.x || 0, y: v.y || 0, width: v.w, height: v.h });
            }
        }
    } catch (e) { /* ignore — don't block window creation */ }
}
async function restoreWindowBounds(win: BrowserWindow): Promise<void> {
    await _restoreWindowBounds(win);
}
function _loadZoomBoot(): void {
    // 1) legacy file load (only used if stateStore has no value yet — checked async later)
    try {
        if (fs.existsSync(zoomFile)) {
            const z = JSON.parse(fs.readFileSync(zoomFile, 'utf8'));
            if (typeof z.factor === 'number' && z.factor >= 0.5 && z.factor <= 2.0) {
                zoomFactor = z.factor;
            }
        }
    } catch (e) { /* ignore */ }
}
_loadZoomBoot();
async function _hydrateZoomFromState(): Promise<void> {
    try {
        const v = await stateStore.get('qqqide', 'zoom');
        if (v && typeof v.factor === 'number' && v.factor >= 0.5 && v.factor <= 2.0) {
            zoomFactor = v.factor;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.setZoomFactor(zoomFactor);
            }
        } else {
            // first run after migration: write the boot-loaded legacy value into state
            await stateStore.setNow('qqqide', 'zoom', { factor: zoomFactor });
            // rename legacy file to .migrated so we never reread it
            try {
                if (fs.existsSync(zoomFile)) { fs.renameSync(zoomFile, zoomFile + '.migrated'); }
            } catch { /* ignore */ }
        }
    } catch (e) {
        console.warn('[state] _hydrateZoomFromState failed:', e);
    }
}
const saveZoom = () => {
    // Authoritative write: through StateStore (debounced, atomic, cloud-eligible).
    try { stateStore.set('qqqide', 'zoom', { factor: zoomFactor }); } catch { /* ignore */ }
};

function createWindow(): BrowserWindow {
    // 新窗口创建 → 恢复正常保护模式（僚机关闭应改为隐藏而非销毁）
    _allowExtClose = false;
    const preloadPath = path.join(__dirname, 'preload.js');
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1100,
        minHeight: 800,
        show: false,
        frame: false,
        backgroundColor: '#fdf6e3', // solarized base3
        title: 'qqq IDE',
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: false, // allow cross-origin fetch (AI panel → gh555.com)
            // explicit: never share node features into renderer
            additionalArguments: [
                `--qqqide-root=${portable.root}`,
                `--qqqide-version=${APP_VERSION}`,
            ],
        },
    });
    win.removeMenu();
    win.once('ready-to-show', async () => {
        await restoreWindowBounds(win);
        win.show();
    });
    win.on('closed', () => {
        if (boundsSaveTimer) { clearTimeout(boundsSaveTimer); boundsSaveTimer = null; }
        try { lspBridge.removeTarget(win.webContents); } catch { /* ignore */ }
        // 清理窗口↔项目映射
        const ownedProject = _windowProjectMap.get(win.id);
        if (ownedProject) {
            _windowProjectMap.delete(win.id);
            _projectWindowMap.delete(ownedProject);
        }
        if (win === mainWindow) {
            // 关主窗口时清理所有僚机 + 引擎（第一道防线，before-quit 兜底）
            _allowExtClose = true;
            for (const extWin of _externalPanels) {
                if (extWin && !extWin.isDestroyed()) { try { extWin.close(); } catch { /* ignore */ } }
            }
            // 不要在这里重置 _allowExtClose，让 before-quit 也能关闭僚机
            try { engineHost.stop(); } catch { /* ignore */ }
            try { audioEngine.stop(); } catch { /* ignore */ }
            mainWindow = null;
        }
    });

    // Persist window bounds on resize/move (debounced 500ms).
    let boundsSaveTimer: NodeJS.Timeout | null = null;
    const saveBounds = () => {
        try {
            if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) { return; }
            const b = win.getBounds();
            stateStore.set('qqqide', 'window_bounds', { x: b.x, y: b.y, w: b.width, h: b.height, maximized: false }).catch(() => {});
        } catch { /* ignore */ }
    };
    const debouncedSaveBounds = () => {
        if (boundsSaveTimer) { clearTimeout(boundsSaveTimer); }
        boundsSaveTimer = setTimeout(saveBounds, 500);
    };
    win.on('resize', debouncedSaveBounds);
    win.on('move', debouncedSaveBounds);
    // Save maximized state (no debounce needed — it's a single event).
    win.on('maximize', () => { try { stateStore.set('qqqide', 'window_bounds', { maximized: true }).catch(() => {}); } catch { /* ignore */ } });
    win.on('unmaximize', () => { try { saveBounds(); } catch { /* ignore */ } });

    // Wire download progress → renderer
    downloadService.setProgressSender((entry) => {
        if (win && !win.isDestroyed()) {
            try { win.webContents.send('qqqide:download:progress', entry); } catch { /* ignore */ }
        }
    });

    // ---- Apply persisted zoom factor on every load ----
    // (zoomFactor/saveZoom are module-scope so IPC handlers can mutate too)
    win.webContents.on('did-finish-load', () => {
        win.webContents.setZoomFactor(zoomFactor);
        lspBridge.addTarget(win.webContents);
    });
    // Ctrl/Cmd + (+/-/0) zoom shortcuts
    win.webContents.on('before-input-event', (ev, input) => {
        if (input.type !== 'keyDown') { return; }
        const ctrl = input.control || input.meta;
        if (!ctrl) { return; }
        const k = input.key;
        if (k === '=' || k === '+') {
            ev.preventDefault();
            zoomFactor = Math.min(2.0, +(zoomFactor + 0.05).toFixed(2));
            win.webContents.setZoomFactor(zoomFactor);
            saveZoom();
            try { win.webContents.send('qqqide:zoom:changed', zoomFactor); } catch { /* ignore */ }
        } else if (k === '-' || k === '_') {
            ev.preventDefault();
            zoomFactor = Math.max(0.5, +(zoomFactor - 0.05).toFixed(2));
            win.webContents.setZoomFactor(zoomFactor);
            saveZoom();
            try { win.webContents.send('qqqide:zoom:changed', zoomFactor); } catch { /* ignore */ }
        } else if (k === '0') {
            ev.preventDefault();
            zoomFactor = 1.0;
            win.webContents.setZoomFactor(zoomFactor);
            saveZoom();
            try { win.webContents.send('qqqide:zoom:changed', zoomFactor); } catch { /* ignore */ }
        }
    });

    // Dev mode: DevTools open (detached), no cache, F5 reload, Ctrl+Shift+I devtools toggle
    if (isDevFlag) {
        win.webContents.openDevTools({ mode: 'detach' });
        injectDevToolsConsoleButtons(win.webContents);
        win.webContents.session.clearCache().catch(() => { });
        win.webContents.on('before-input-event', (ev, input) => {
            if (input.type !== 'keyDown') { return; }
            if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
                ev.preventDefault();
                win.webContents.reloadIgnoringCache();
            }
            if (input.control && input.shift && input.key.toLowerCase() === 'i') {
                ev.preventDefault();
                if (win.webContents.isDevToolsOpened()) {
                    win.webContents.closeDevTools();
                } else {
                    win.webContents.openDevTools({ mode: 'detach' });
                    injectDevToolsConsoleButtons(win.webContents);
                }
            }
        });
        console.log('[main] DEV MODE: DevTools detached, cache cleared, F5/Ctrl+R reload, Ctrl+Shift+I devtools');
    }

    return win;
}

// ----------------------------------------------------------------------------
// Boot sequence:
//   1. health probe (3s timeout)
//   2. health OK  -> loadURL(remote)
//   3. health FAIL -> still loadURL(remote): if SW previously installed, it
//      will serve last-good cached copy automatically (PWA strategy).
//   4. loadURL fails outright (no cache, no network) -> static boot-fallback.
// ----------------------------------------------------------------------------
let lastBootMode: 'live' | 'cache' | 'fallback' = 'fallback';

async function loadStaticFallback(reason: string): Promise<void> {
    if (!mainWindow) { return; }
    lastBootMode = 'fallback';
    console.warn('[boot] static fallback:', reason);
    const candidates = [
        path.join(__dirname, '..', 'shell', 'boot-fallback.html'),
        path.join(__dirname, 'boot-fallback.html'),
        path.join(portable.root, 'shell', 'boot-fallback.html'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            await mainWindow.loadFile(p, { query: { url: bootConfig.url, reason } });
            return;
        }
    }
    await mainWindow.loadURL('data:text/html,<h1>qqq IDE offline</h1>');
}

async function loadRemoteWithCacheGuard(): Promise<boolean> {
    // returns true if remote (live or sw-cached) loaded; false if it failed.
    if (!mainWindow) { return false; }
    const wc = mainWindow.webContents;
    return new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (ok: boolean, mode: typeof lastBootMode) => {
            if (settled) { return; }
            settled = true;
            lastBootMode = mode;
            wc.removeListener('did-finish-load', onFinish);
            wc.removeListener('did-fail-load', onFail);
            resolve(ok);
        };
        const onFinish = () => {
            // Distinguish live vs cache by re-running health asynchronously.
            // For simplicity here, mark live; renderer can re-check via IPC.
            finish(true, 'live');
        };
        const onFail = (_e: any, code: number, desc: string, validatedURL: string, isMain: boolean) => {
            if (!isMain) { return; }
            // Codes < -100 are typically connection-level. SW would have intercepted
            // if it had a cached response. So this means "no cache and no network".
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

async function boot(): Promise<void> {
    // Check for shell-code hot-update (non-blocking, downloads in background)
    _checkAndDownloadShellUpdate().then(updated => {
        if (updated) {
            console.log('[boot] shell update staged — will apply on next restart');
            // TODO: show a subtle notification to user via IPC
        }
    }).catch(() => {});

    mainWindow = createWindow();
    const healthy = await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs);
    if (healthy) {
        console.log('[boot] server OK ->', bootConfig.url);
    } else {
        console.warn('[boot] server unreachable; relying on PWA cache (if any)');
    }
    const ok = await loadRemoteWithCacheGuard();
    if (!ok) {
        // No live, no SW cache - show static fallback page.
        await loadStaticFallback(healthy ? 'load-failed' : 'no-network-no-cache');
    } else if (!healthy) {
        // Loaded from SW cache (server unreachable but cache served the page).
        lastBootMode = 'cache';
        console.log('[boot] served from PWA cache');
    }
}

// ----------------------------------------------------------------------------
// Asset protocol: serve shell-bundled assets (monaco etc) to the renderer.
// Plus `qqqide-asset://file/<encoded-abs-path>` for arbitrary local files,
// whitelisted to: portable.cache, user home (workspace), and explicit allow-list.
// ----------------------------------------------------------------------------
// Asset file allow-list: built-in roots + runtime workspace roots (persisted).
const _assetFileBuiltinRoots: string[] = [
    path.normalize(portable.cache),
    path.normalize(os.homedir()),
];
const _assetFileWorkspaceRoots = new Set<string>();
const _assetRootsStorePath = path.join(portable.userData, 'asset-roots.json');

function loadAssetRoots(): void {
    try {
        if (!fs.existsSync(_assetRootsStorePath)) { return; }
        const raw = fs.readFileSync(_assetRootsStorePath, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            for (const r of arr) {
                if (typeof r === 'string' && r) {
                    _assetFileWorkspaceRoots.add(path.normalize(r));
                }
            }
            console.log('[asset-roots] loaded', _assetFileWorkspaceRoots.size, 'workspace root(s)');
        }
    } catch (e) {
        console.warn('[asset-roots] load failed:', e);
    }
}

async function _hydrateAssetRootsFromState(): Promise<void> {
    try {
        const v = await stateStore.get('qqqide', 'asset_roots');
        if (Array.isArray(v) && v.length > 0) {
            for (const r of v) {
                if (typeof r === 'string' && r) {
                    _assetFileWorkspaceRoots.add(path.normalize(r));
                }
            }
            console.log('[asset-roots] hydrated', _assetFileWorkspaceRoots.size, 'from state');
        } else {
            // first run after migration: write boot-loaded legacy list into state
            const arr = Array.from(_assetFileWorkspaceRoots);
            await stateStore.setNow('qqqide', 'asset_roots', arr);
            try {
                if (fs.existsSync(_assetRootsStorePath)) {
                    fs.renameSync(_assetRootsStorePath, _assetRootsStorePath + '.migrated');
                }
            } catch { /* ignore */ }
        }
    } catch (e) {
        console.warn('[state] _hydrateAssetRootsFromState failed:', e);
    }
}

function persistAssetRoots(): void {
    // Authoritative write: through StateStore. Keep a debounced doc record so
    // multi-window concurrency uses the lock + merge-on-save logic.
    try {
        const arr = Array.from(_assetFileWorkspaceRoots);
        stateStore.set('qqqide', 'asset_roots', arr);
    } catch (e) {
        console.warn('[asset-roots] persist failed:', e);
    }
}

function addAssetRoot(absDir: string): boolean {
    if (!absDir || typeof absDir !== 'string') { return false; }
    if (!path.isAbsolute(absDir)) { return false; }
    let norm: string;
    try {
        norm = path.normalize(absDir);
    } catch { return false; }
    // Sanity: must be an existing directory; refuse files.
    try {
        const st = fs.statSync(norm);
        if (!st.isDirectory()) { return false; }
    } catch { return false; }
    if (_assetFileWorkspaceRoots.has(norm)) { return false; }
    _assetFileWorkspaceRoots.add(norm);
    persistAssetRoots();
    console.log('[asset-roots] added', norm);
    return true;
}

function isPathAllowed(abs: string): boolean {
    const norm = path.normalize(abs);
    for (const root of _assetFileBuiltinRoots) {
        if (norm === root || norm.startsWith(root + path.sep)) { return true; }
    }
    for (const root of _assetFileWorkspaceRoots) {
        if (norm === root || norm.startsWith(root + path.sep)) { return true; }
    }
    return false;
}

// Load persisted roots eagerly so the asset protocol works before any dialog.
loadAssetRoots();

function registerAssetProtocol(): void {
    // Resource roots map. Resolved relative to portable.root (app dir).
    const roots: Record<string, string> = {
        // monaco-editor min build
        monaco: path.join(portable.root, 'node_modules', 'monaco-editor', 'min'),
        // monaco-editor min-maps (source maps for DevTools)
        'monaco-maps': path.join(portable.root, 'node_modules', 'monaco-editor', 'min-maps'),
        // monaco-editor ESM build (for module workers)
        'monaco-esm': path.join(portable.root, 'node_modules', 'monaco-editor', 'esm'),
        // monaco individual dependency files (ESM→AMD converted by convert_monaco_esm.py)
        monaco_deps: path.join(portable.root, 'cache', 'monaco-deps'),
        // TypeScript compiler (for custom language service, bypasses broken Monaco TS worker)
        ts: path.join(portable.root, 'node_modules', 'typescript', 'lib'),
        // shell-bundled static files (e.g. boot-fallback)
        shell: path.join(portable.root, 'shell'),
    };
    protocol.registerFileProtocol('qqqide-asset', (request, callback) => {
        try {
            const url = new URL(request.url);
            const resource = url.hostname;          // 'monaco' / 'shell' / 'file'
            const subPath = decodeURIComponent(url.pathname); // '/vs/loader.js' or '/C:/foo/bar.png'

            // 'file' resource: arbitrary local file, whitelisted
            if (resource === 'file') {
                // pathname is '/<encoded-abs-path>' — strip leading '/'
                let abs = subPath.startsWith('/') ? subPath.slice(1) : subPath;
                // On Windows allow both 'C:/...' and '/C:/...'
                abs = path.normalize(abs);
                if (!path.isAbsolute(abs) || !isPathAllowed(abs)) {
                    console.warn('[qqqide-asset/file] denied:', abs);
                    return callback({ error: -10 /* ACCESS_DENIED */ });
                }
                if (!fs.existsSync(abs)) { return callback({ error: -6 /* FILE_NOT_FOUND */ }); }
                return callback({ path: abs });
            }

            const root = roots[resource];
            if (!root) { return callback({ error: -6 /* FILE_NOT_FOUND */ }); }
            // Prevent directory traversal: resolve and ensure under root.
            const resolved = path.normalize(path.join(root, subPath));
            if (!resolved.startsWith(root)) { return callback({ error: -10 /* ACCESS_DENIED */ }); }
            // Monaco: if file not in min build, try deps (individual ESM→AMD files)
            if (resource === 'monaco' && !fs.existsSync(resolved) && roots['monaco_deps']) {
                const fallback = path.normalize(path.join(roots['monaco_deps'], subPath));
                if (fallback.startsWith(roots['monaco_deps']) && fs.existsSync(fallback)) {
                    return callback({ path: fallback });
                }
            }
            // Monaco: source maps live in min-maps/ (sibling of min/), not min/min-maps/
            if (resource === 'monaco' && !fs.existsSync(resolved) && roots['monaco-maps']) {
                const mapsFallback = path.normalize(path.join(roots['monaco-maps'], subPath));
                if (mapsFallback.startsWith(roots['monaco-maps']) && fs.existsSync(mapsFallback)) {
                    return callback({ path: mapsFallback });
                }
            }
            callback({ path: resolved });
        } catch (e) {
            console.warn('[qqqide-asset] bad url:', request.url, e);
            callback({ error: -2 /* FAILED */ });
        }
    });
}

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// Disk-free batch: ports kp.py:get_disk_free_batch via engines/kp_bridge.py
// + 30s memoize on JS side; fallback to Node statfsSync when Python missing.
// ----------------------------------------------------------------------------
interface DiskFreeEntry { free?: number; total?: number; used?: number; path?: string; }
let _diskFreeCache: { t: number; key: string; data: Record<string, DiskFreeEntry> } | null = null;
const _DISK_FREE_TTL_MS = 30 * 1000;

function resolveKpBridge(): { script: string; python: string } | null {
    const candidates = [
        path.join(portable.root, 'engines', 'kp_bridge.py'),
        path.join(portable.root, 'resources', 'app', 'engines', 'kp_bridge.py'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            const py = process.env.QQQ_PYTHON
                || (process.platform === 'win32' ? 'python' : 'python3');
            return { script: p, python: py };
        }
    }
    return null;
}

function diskFreeNodeFallback(drives: string[]): Record<string, DiskFreeEntry> {
    const result: Record<string, DiskFreeEntry> = {};
    for (const d of drives || []) {
        try {
            const stats = (fs as any).statfsSync(d);
            const bsize = stats.bsize as number;
            const letter = (d.charAt(0) || 'X').toUpperCase();
            result[letter] = {
                free: (stats.bfree as number) * bsize,
                total: (stats.blocks as number) * bsize,
            };
        } catch { /* skip */ }
    }
    try {
        const desktop = path.join(os.homedir(), 'Desktop');
        let used = 0;
        const entries = fs.readdirSync(desktop);
        for (const e of entries) {
            try { used += fs.statSync(path.join(desktop, e)).size; } catch { /* skip */ }
        }
        result['DESKTOP'] = { used, path: desktop };
    } catch { result['DESKTOP'] = { used: 0 }; }
    result['RECYCLE'] = { used: 0 };
    return result;
}

async function diskFreeViaKpBridge(drives: string[]): Promise<Record<string, DiskFreeEntry> | null> {
    const kp = resolveKpBridge();
    if (!kp) { return null; }
    return await new Promise(resolve => {
        let proc: ChildProcess;
        try {
            proc = cpSpawn(kp.python, ['-u', kp.script], {
                cwd: portable.root,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                env: process.env,
            });
        } catch (e) {
            console.warn('[diskFree] kp_bridge spawn failed:', e);
            return resolve(null);
        }
        let out = ''; let err = '';
        const guard = setTimeout(() => {
            try { proc.kill('SIGKILL' as any); } catch { /* ignore */ }
        }, 8000);
        proc.stdout?.setEncoding('utf8');
        proc.stderr?.setEncoding('utf8');
        proc.stdout?.on('data', (d: string) => { out += d; });
        proc.stderr?.on('data', (d: string) => { err += d; });
        proc.on('error', (e: any) => {
            clearTimeout(guard);
            console.warn('[diskFree] kp_bridge error:', e && e.message);
            resolve(null);
        });
        proc.on('exit', (code: number | null) => {
            clearTimeout(guard);
            if (code !== 0) {
                if (err.trim()) { console.warn('[diskFree] kp_bridge stderr:', err.slice(0, 400)); }
                return resolve(null);
            }
            try {
                const j = JSON.parse(out.trim() || '{}');
                if (j && j.ok && j.data) { return resolve(j.data); }
                console.warn('[diskFree] kp_bridge bad payload:', String(j.error || '').slice(0, 300));
                resolve(null);
            } catch (e: any) {
                console.warn('[diskFree] kp_bridge json parse:', e && e.message, out.slice(0, 200));
                resolve(null);
            }
        });
        try {
            const payload = JSON.stringify({ action: 'disk_free_batch', drives: drives || [] });
            proc.stdin?.end(payload, 'utf8');
        } catch (e) {
            clearTimeout(guard);
            console.warn('[diskFree] kp_bridge stdin failed:', e);
            resolve(null);
        }
    });
}

async function diskFreeBatch(drives: string[]): Promise<Record<string, DiskFreeEntry>> {
    const key = JSON.stringify(drives || []);
    const now = Date.now();
    if (_diskFreeCache && _diskFreeCache.key === key && (now - _diskFreeCache.t) < _DISK_FREE_TTL_MS) {
        return _diskFreeCache.data;
    }
    let data = await diskFreeViaKpBridge(drives);
    if (!data) { data = diskFreeNodeFallback(drives); }
    _diskFreeCache = { t: now, key, data };
    return data;
}

// ----------------------------------------------------------------------------
// Global keyboard shortcut registration (per-window keys handled in renderer)
// ----------------------------------------------------------------------------
function registerGlobalKey(accel: string, id: string): boolean {
    try {
        const ok = globalShortcut.register(accel, () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                try { mainWindow.webContents.send('qqqide:key:global', { id, accel }); }
                catch { /* ignore */ }
            }
        });
        if (!ok) { console.warn('[key.global] register failed:', accel, id); }
        return ok;
    } catch (e) {
        console.warn('[key.global] threw:', accel, id, e);
        return false;
    }
}

// ----------------------------------------------------------------------------
// IPC handlers
// ----------------------------------------------------------------------------
function registerIpc(): void {
    // ---- boot info ----
    ipcMain.handle('qqqide:app:root', () => portable.root);

    ipcMain.handle('qqqide:boot:info', () => ({
        url: bootConfig.url,
        version: APP_VERSION,
        platform: process.platform,
        arch: process.arch,
        appRoot: portable.root,
        userData: portable.userData,
        cacheDir: portable.cache,
        logsDir: portable.logs,
        cwd: process.cwd(),
        homedir: os.homedir(),
        engineAlive: engineHost.isAlive(),
        bootMode: lastBootMode,
    }));

    // ---- boot retry (used by boot-fallback.html and renderer) ----
    ipcMain.handle('qqqide:boot:retry', async () => {
        if (!mainWindow) { return false; }
        const healthy = await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs);
        if (healthy) {
            console.log('[boot.retry] server OK -> reload');
            await mainWindow.loadURL(bootConfig.url);
            lastBootMode = 'live';
            return true;
        }
        // try cache anyway
        const ok = await loadRemoteWithCacheGuard();
        if (!ok) { await loadStaticFallback('retry-failed'); return false; }
        lastBootMode = 'cache';
        return true;
    });

    ipcMain.handle('qqqide:boot:probe', async () => {
        return healthCheck(bootConfig.url, Math.min(bootConfig.healthTimeoutMs, 2000));
    });

    // ---- fs (use engine if alive, else native fallback) ----
    ipcMain.handle('qqqide:fs:read', async (_e, p: string) => {
        return fs.promises.readFile(p, 'utf8');
    });
    // Read file as base64 for binary content (images for AI vision, etc.)
    ipcMain.handle('qqqide:fs:readBase64', async (_e, p: string) => {
        const buf = await fs.promises.readFile(p);
        return buf.toString('base64');
    });
    ipcMain.handle('qqqide:fs:writeBase64', async (_e, p: string, base64: string) => {
        // Binary write: decode base64 → Buffer → write atomically.
        // Auto-mkdir parent dir for paste/cache scenarios.
        try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        const buf = Buffer.from(base64 || '', 'base64');
        await fs.promises.writeFile(p, buf as any);
        return true;
    });
    ipcMain.handle('qqqide:fs:write', async (_e, p: string, content: any) => {
        // Auto-mkdir parent dir (zero-risk pure benefit, prevents ENOENT for .lock etc.)
        try { await fs.promises.mkdir(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        await fs.promises.writeFile(p, content);
        return true;
    });
    ipcMain.handle('qqqide:fs:list', async (_e, p: string, callerStack?: string) => {
        console.log('[fs:list]', p);
        // guard: reject non-directory paths gracefully
        try {
            const st = await fs.promises.stat(p);
            if (!st.isDirectory()) {
                console.warn('[fs:list] NOT_DIR:', p);
                if (callerStack) { console.warn('[fs:list] CALLER_STACK:\n' + callerStack); }
                return [];
            }
        } catch { return []; }
        const entries = await fs.promises.readdir(p, { withFileTypes: true });
        const result: string[] = [];
        const MAX = 500;
        for (const e of entries) {
            if (result.length >= MAX) break;
            result.push(e.isDirectory() ? e.name + '/' : e.name);
        }
        return result;
    });
    ipcMain.handle('qqqide:fs:stat', async (_e, p: string) => {
        try {
            const s = await fs.promises.stat(p);
            return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory(), isFile: s.isFile() };
        } catch { return null; }
    });
    ipcMain.handle('qqqide:fs:exists', async (_e, p: string) => fs.existsSync(p));
    ipcMain.handle('qqqide:fs:mkdir', async (_e, p: string) => {
        await fs.promises.mkdir(p, { recursive: true });
        return true;
    });
    ipcMain.handle('qqqide:fs:remove', async (_e, p: string) => {
        try {
            const s = await fs.promises.stat(p);
            if (s.isDirectory()) await fs.promises.rm(p, { recursive: true, force: true });
            else await fs.promises.unlink(p);
        } catch (e: any) {
            // ENOENT: 文件已不存在，移除目的已达，不报错
            if (e && e.code !== 'ENOENT') throw e;
        }
        return true;
    });
    ipcMain.handle('qqqide:fs:rename', async (_e, oldP: string, newP: string) => {
        await fs.promises.rename(oldP, newP);
        return true;
    });

    // ============================================================
    // AI 工具 — 主进程递归搜索 (消除 renderer IPC 洪水 + 超时防卡死)
    // ============================================================
    const AI_SKIP_DIRS = ['node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs', 'cache', 'temp', 'crashDumps'];
    const AI_SKIP_EXTS = ['.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.xz', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.vsix', '.lock', '.wasm'];
    const AI_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB in main process (no IPC serialization)

    function aiGlobToRegex(pattern: string): RegExp {
        const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp('^' + esc + '$', 'i');
    }

    function aiTimeout(ms: number, partial: string): Promise<string> {
        return new Promise(resolve => { setTimeout(() => resolve((partial || '') + '\n[TIMEOUT]'), ms); });
    }

    // search_text — 正则递归搜索
    ipcMain.handle('qqqide:ai:search_text', async (_e, args: { query: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => {
        const query = args.query;
        const searchPaths: string[] = args.paths || (args.path ? [args.path] : []);
        const maxResults = args.maxResults || 30;
        const timeoutMs = args.timeoutMs || 30000;
        if (searchPaths.length === 0) return 'Error: no search paths';

        let regex: RegExp;
        try { regex = new RegExp(query, 'i'); }
        catch { regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

        const matches: string[] = [];

        const doSearch = async (): Promise<string> => {
            async function walk(dir: string, depth: number): Promise<void> {
                if (depth > 8 || matches.length >= maxResults) return;
                let entries: fs.Dirent[];
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                catch { return; }
                for (const ent of entries) {
                    if (matches.length >= maxResults) break;
                    if (ent.name.startsWith('.') && ent.isDirectory()) continue;
                    if (ent.isDirectory() && AI_SKIP_DIRS.includes(ent.name)) continue;
                    const full = path.join(dir, ent.name);
                    if (ent.isDirectory()) {
                        await walk(full, depth + 1);
                    } else {
                        const extMatch = ent.name.match(/\.([a-z0-9]+)$/i);
                        const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';
                        if (AI_SKIP_EXTS.includes(ext)) continue;
                        try {
                            const st = await fs.promises.stat(full);
                            if (!st || st.size > AI_MAX_FILE_SIZE) continue;
                            const content = await fs.promises.readFile(full, 'utf8');
                            const lines = content.split('\n');
                            for (let li = 0; li < lines.length && matches.length < maxResults; li++) {
                                if (regex.test(lines[li])) {
                                    matches.push(full + ':' + (li + 1) + ':' + lines[li].trim().slice(0, 200));
                                }
                            }
                        } catch { /* skip unreadable */ }
                    }
                }
            }
            for (const d of searchPaths) {
                if (matches.length >= maxResults) break;
                await walk(d, 0);
            }
            return matches.length > 0 ? matches.join('\n') : 'No matches found.';
        };

        return Promise.race([doSearch(), aiTimeout(timeoutMs, matches.length > 0 ? matches.join('\n') : '')]);
    });

    // find_files — glob 文件名递归搜索
    ipcMain.handle('qqqide:ai:find_files', async (_e, args: { pattern: string; paths?: string[]; path?: string; maxResults?: number; timeoutMs?: number }) => {
        const pattern = args.pattern;
        const searchPaths: string[] = args.paths || (args.path ? [args.path] : []);
        const maxResults = args.maxResults || 50;
        const timeoutMs = args.timeoutMs || 15000;
        if (!pattern || searchPaths.length === 0) return 'Error: missing pattern or paths';

        const regex = aiGlobToRegex(pattern);
        const baseDirs = searchPaths.map(p => p.replace(/\\/g, '/').replace(/\/$/, ''));
        const matches: string[] = [];

        const doSearch = async (): Promise<string> => {
            async function walk(dir: string, depth: number, baseDir: string): Promise<void> {
                if (depth > 8 || matches.length >= maxResults) return;
                let entries: fs.Dirent[];
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                catch { return; }
                for (const ent of entries) {
                    if (matches.length >= maxResults) break;
                    if (ent.name.startsWith('.')) continue;
                    if (ent.isDirectory() && AI_SKIP_DIRS.includes(ent.name)) continue;
                    const full = path.join(dir, ent.name);
                    const rel = baseDir ? full.replace(/\\/g, '/').slice(baseDir.length + 1) : full;
                    if (regex.test(ent.name) || regex.test(rel)) {
                        matches.push(full + (ent.isDirectory() ? '/' : ''));
                    }
                    if (ent.isDirectory()) await walk(full, depth + 1, baseDir);
                }
            }
            for (let d = 0; d < searchPaths.length && matches.length < maxResults; d++) {
                await walk(searchPaths[d], 0, baseDirs[d]);
            }
            return matches.length > 0 ? matches.join('\n') : 'No files found.';
        };

        return Promise.race([doSearch(), aiTimeout(timeoutMs, matches.length > 0 ? matches.join('\n') : '')]);
    });

    // list_files — 递归列目录
    ipcMain.handle('qqqide:ai:list_files', async (_e, args: { path: string; maxResults?: number; timeoutMs?: number }) => {
        const searchPath = args.path;
        const maxResults = args.maxResults || 200;
        const timeoutMs = args.timeoutMs || 15000;
        if (!searchPath) return 'Error: missing path';

        const matches: string[] = [];

        const doSearch = async (): Promise<string> => {
            async function walk(dir: string, depth: number): Promise<void> {
                if (depth > 8 || matches.length >= maxResults) return;
                let entries: fs.Dirent[];
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                catch { return; }
                for (const ent of entries) {
                    if (matches.length >= maxResults) break;
                    if (ent.name.startsWith('.')) continue;
                    if (ent.isDirectory() && AI_SKIP_DIRS.includes(ent.name)) continue;
                    const full = path.join(dir, ent.name);
                    matches.push(full + (ent.isDirectory() ? '/' : ''));
                    if (ent.isDirectory()) await walk(full, depth + 1);
                }
            }
            await walk(searchPath, 0);
            return matches.length > 0 ? matches.join('\n') : 'No files found.';
        };

        return Promise.race([doSearch(), aiTimeout(timeoutMs, matches.length > 0 ? matches.join('\n') : '')]);
    });

    // read_file — 读文件 + 行切片 (1 IPC, 消除大文件序列化开销)
    // ==== qwr 机器 — 全局唯一真理写机器 ====
    const _qw = new Map<string, Promise<any>>();
    const _sn: Record<string, { mtimeMs: number; size: number }> = {};
    let _ac = 0;
    let _co = false;
    const _cw: Array<() => void> = [];
    const _ww: Array<() => void> = [];
    async function _qe(p: string, fn: () => Promise<any>): Promise<any> {
        const prev = _qw.get(p) || Promise.resolve();
        const next = prev.then(() => _qg(p, fn));
        _qw.set(p, next);
        next.finally(() => { if (_qw.get(p) === next) _qw.delete(p); });
        return next;
    }
    async function _qg(_p: string, fn: () => Promise<any>): Promise<any> {
        if (_co) await new Promise<void>(r => { _cw.push(r); });
        _ac++;
        try { return await fn(); }
        finally {
            _ac--;
            if (_ww.length && _ac === 0) { const w = _ww.splice(0); w.forEach(r => r()); }
        }
    }
    async function _qgc(fn: () => Promise<any>): Promise<any> {
        _co = true;
        if (_ac > 0) await new Promise<void>(r => { _ww.push(r); });
        try { return await fn(); }
        finally {
            _co = false;
            for (const k of Object.keys(_sn)) delete _sn[k];
            if (_cw.length) { const w = _cw.splice(0); w.forEach(r => r()); }
        }
    }
    ipcMain.handle('qqqide:ai:read_file', async (_e, args: { path: string; start_line?: number; end_line?: number }) => {
        const startLine = args.start_line || 1;
        const endLine = args.end_line || 0;
        try {
            const st = await fs.promises.stat(args.path);
            _sn[args.path] = { mtimeMs: st.mtimeMs, size: st.size };
            if (st.size > 50 * 1024 * 1024) return `Error: file too large (${(st.size / 1024 / 1024).toFixed(1)} MB, max 50 MB). Use start_line/end_line to paginate.`;
            let content = await fs.promises.readFile(args.path, 'utf8');
            content = content.replace(/\r\n/g, '\n');
            const lines = content.split('\n');
            const total = lines.length;
            const start = Math.max(0, startLine - 1);
            const end = endLine ? Math.min(total, endLine) : Math.min(total, start + 500);
            const slice = lines.slice(start, end).join('\n');
            if (total <= 500 && !args.start_line) return content;
            return `File has ${total} lines. Showing L${start + 1}-${end}:\n${slice}`;
        } catch (err: any) {
            return 'Error reading file: ' + (err.message || err);
        }
    });

    // edit_file helpers
    function aiNormalizeWhitespace(text: string): string {
        return text.replace(/[^\S\n]+/g, ' ').replace(/ +$/gm, '').replace(/^ +/gm, (m: string) => m.length > 0 ? ' ' : '');
    }
    function aiFindMatch(content: string, find: string): { start: number; end: number; matchLevel: number } | null {
        const idx1 = content.indexOf(find);
        if (idx1 !== -1) return { start: idx1, end: idx1 + find.length, matchLevel: 1 };
        if (content.indexOf('\r\n') !== -1) {
            const normContent = content.replace(/\r\n/g, '\n');
            const normFind = find.replace(/\r\n/g, '\n');
            if (normContent !== content || normFind !== find) {
                const idx1b = normContent.indexOf(normFind);
                if (idx1b !== -1) {
                    let origPos = 0;
                    for (let np = 0; np < idx1b; np++, origPos++) {
                        if (content[origPos] === '\r' && content[origPos + 1] === '\n') origPos++;
                    }
                    const origStart = origPos;
                    for (let np = idx1b; np < idx1b + normFind.length; np++, origPos++) {
                        if (content[origPos] === '\r' && content[origPos + 1] === '\n') origPos++;
                    }
                    return { start: origStart, end: origPos, matchLevel: 1 };
                }
            }
        }
        const nf = aiNormalizeWhitespace(find);
        const nc = aiNormalizeWhitespace(content);
        const idx2 = nc.indexOf(nf);
        if (idx2 !== -1) {
            const normBefore = nc.slice(0, idx2);
            const normAfter = nc.slice(0, idx2 + nf.length);
            const startLine2 = (normBefore.match(/\n/g) || []).length;
            const endLine2 = (normAfter.match(/\n/g) || []).length;
            const lines2 = content.split('\n');
            const oStart2 = lines2.slice(0, startLine2).join('\n').length + (startLine2 > 0 ? 1 : 0);
            const oEnd2 = lines2.slice(0, endLine2 + 1).join('\n').length;
            return { start: oStart2, end: oEnd2, matchLevel: 2 };
        }
        const findLines = find.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (findLines.length >= 2) {
            const contentLines = content.split('\n');
            for (let i = 0; i <= contentLines.length - findLines.length; i++) {
                let match = true;
                for (let j = 0; j < findLines.length; j++) {
                    if (contentLines[i + j].trim() !== findLines[j]) { match = false; break; }
                }
                if (match) {
                    const soff = contentLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
                    const eoff = contentLines.slice(0, i + findLines.length).join('\n').length;
                    return { start: soff, end: eoff, matchLevel: 3 };
                }
            }
        }
        return null;
    }

    // edit_file — 精准编辑 (三级降级匹配 + 原子性, 1 IPC 替代 read+write)
    ipcMain.handle('qqqide:ai:edit_file', async (_e, args: { path: string; edits: Array<{ find: string; replace: string; replace_all?: boolean }> }) => {
        return _qe(args.path, async () => {
            const edits = args.edits;
            if (!edits || edits.length === 0) return 'Error: no edits provided.';
            try {
                let content = await fs.promises.readFile(args.path, 'utf8');
                content = content.replace(/\r\n/g, '\n');
                const results: string[] = [];
                let totalApplied = 0;
                const matchPlan: Array<{ edit: typeof edits[0]; match: { start: number; end: number; matchLevel: number }; index: number }> = [];
                for (let i = 0; i < edits.length; i++) {
                    const edit = edits[i];
                    const m = aiFindMatch(content, edit.find);
                    if (!m) {
                        const firstLine = edit.find.split('\n')[0].trim();
                        const lines = content.split('\n');
                        let hint = '';
                        for (let li = 0; li < lines.length; li++) {
                            if (lines[li].indexOf(firstLine) !== -1) {
                                hint = `\nNearest match at line ${li + 1}:\n${lines.slice(Math.max(0, li - 1), li + 4).join('\n')}`;
                                break;
                            }
                        }
                        return `Error: edit #${i + 1} match failed — text not found in ${args.path.split(/[\\/]/).pop()}.${hint}`;
                    }
                    matchPlan.push({ edit, match: m, index: i });
                }
                for (let pi = 0; pi < matchPlan.length; pi++) {
                    const plan = matchPlan[pi];
                    const ed = plan.edit;
                    if (ed.replace_all) {
                        const count = content.split(ed.find).length - 1;
                        content = content.split(ed.find).join(ed.replace);
                        results.push(`#${pi + 1}: all (${count}x, L${plan.match.matchLevel})`);
                        totalApplied += count;
                    } else {
                        const m2 = aiFindMatch(content, ed.find);
                        if (m2) {
                            content = content.slice(0, m2.start) + ed.replace + content.slice(m2.end);
                            results.push(`L${m2.matchLevel}`);
                            totalApplied++;
                        } else {
                            results.push('skip(moved)');
                        }
                    }
                }
                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, content);
                try { const st2 = await fs.promises.stat(args.path); _sn[args.path] = { mtimeMs: st2.mtimeMs, size: st2.size }; } catch { /* ignore */ }
                const matchInfo = results.some(r => r.indexOf('L2') !== -1 || r.indexOf('L3') !== -1)
                    ? ' (whitespace-tolerant match used)' : '';
                return `\u2713 ${totalApplied} edit(s) applied to ${args.path.split(/[\\/]/).pop()}${matchInfo}`;
            } catch (err: any) {
                return 'Error editing file: ' + (err.message || err);
            }
        });
    });

    // create_file — 新建文件 (1 IPC)
    ipcMain.handle('qqqide:ai:create_file', async (_e, args: { path: string; content: string }) => {
        return _qe(args.path, async () => {
            try {
                try { await fs.promises.access(args.path); return `Error: file already exists: ${args.path}. Use edit_file to modify existing files.`; } catch { /* doesn't exist, proceed */ }
                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, args.content);
                try { const st2 = await fs.promises.stat(args.path); _sn[args.path] = { mtimeMs: st2.mtimeMs, size: st2.size }; } catch { /* ignore */ }
                return `File created: ${args.path} (${args.content.length} chars)`;
            } catch (err: any) {
                return 'Error creating file: ' + (err.message || err);
            }
        });
    });

    // delete_file — 删除文件 (1 IPC)
    ipcMain.handle('qqqide:ai:delete_file', async (_e, args: { path: string }) => {
        return _qe(args.path, async () => {
            try {
                try { await fs.promises.access(args.path); } catch { return `Error: file not found: ${args.path}`; }
                await fs.promises.unlink(args.path);
                delete _sn[args.path];
                return `Deleted: ${args.path}`;
            } catch (err: any) {
                return 'Error deleting file: ' + (err.message || err);
            }
        });
    });

    // write_file — 全量覆写 (1 IPC)
    ipcMain.handle('qqqide:ai:write_file', async (_e, args: { path: string; content: string }) => {
        return _qe(args.path, async () => {
            try {
                const snap = _sn[args.path];
                if (snap) { try { const st = await fs.promises.stat(args.path); if (st.mtimeMs !== snap.mtimeMs || st.size !== snap.size) return 'Error: file has been modified externally since last read. Please re-read the file and try again.'; } catch (_) { } }
                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, args.content);
                return `File written: ${args.path} (${args.content.length} chars)`;
            } catch (err: any) {
                return 'Error writing file: ' + (err.message || err);
            }
        });
    });

    ipcMain.handle('qqqide:fs:drives', async () => {
        const drives: string[] = [];
        if (process.platform === 'win32') {
            for (let i = 65; i <= 90; i++) {
                const d = String.fromCharCode(i) + ':\\';
                try { if (fs.existsSync(d)) drives.push(d); } catch { /* skip */ }
            }
            if (drives.length === 0) drives.push('C:\\');
        } else {
            drives.push('/');
        }
        return drives;
    });
    ipcMain.handle('qqqide:fs:diskFree', async (_e, drives: string[]) => {
        return await diskFreeBatch(drives);
    });

    // ---- dialogs ----
    ipcMain.handle('qqqide:dialog:open', async (_e, opts) => {
        if (!mainWindow) { return null; }
        const result = await dialog.showOpenDialog(mainWindow, opts || {});
        // Auto-extend asset-file whitelist for any selected directory (or
        // parent dir of selected files), so qqqide-asset://file/ can serve them.
        try {
            const wantsDir = !!(opts && Array.isArray(opts.properties) && opts.properties.indexOf('openDirectory') !== -1);
            if (result && Array.isArray(result.filePaths)) {
                for (const p of result.filePaths) {
                    if (!p) { continue; }
                    if (wantsDir) {
                        addAssetRoot(p);
                    } else {
                        const dir = path.dirname(p);
                        if (dir) { addAssetRoot(dir); }
                    }
                }
            }
        } catch (e) {
            console.warn('[qqqide:dialog:open] asset-root auto-extend failed:', e);
        }
        return result;
    });
    ipcMain.handle('qqqide:dialog:save', async (_e, opts) => {
        if (!mainWindow) { return null; }
        return dialog.showSaveDialog(mainWindow, opts || {});
    });
    ipcMain.handle('qqqide:dialog:message', async (_e, opts) => {
        if (!mainWindow) { return null; }
        return dialog.showMessageBox(mainWindow, opts || {});
    });

    // ---- asset-roots: programmatic API for renderer ----
    ipcMain.handle('qqqide:assetRoots:add', async (_e, absDir: string) => addAssetRoot(absDir));
    ipcMain.handle('qqqide:assetRoots:list', async () => Array.from(_assetFileWorkspaceRoots));
    ipcMain.handle('qqqide:assetRoots:remove', async (_e, absDir: string) => {
        if (!absDir) { return false; }
        const ok = _assetFileWorkspaceRoots.delete(path.normalize(absDir));
        if (ok) { persistAssetRoots(); }
        return ok;
    });

    // ---- window ----
    ipcMain.handle('qqqide:window:minimize', (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); });
    ipcMain.handle('qqqide:window:maximize', (e) => { BrowserWindow.fromWebContents(e.sender)?.maximize(); });
    ipcMain.handle('qqqide:window:unmaximize', (e) => { BrowserWindow.fromWebContents(e.sender)?.unmaximize(); });
    ipcMain.handle('qqqide:window:close', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win && !win.isDestroyed()) { win.close(); }
    });
    ipcMain.handle('qqqide:window:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);
    ipcMain.handle('qqqide:window:setTitle', (e, s: string) => { BrowserWindow.fromWebContents(e.sender)?.setTitle(String(s)); });
    ipcMain.handle('qqqide:window:toggleDevTools', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed()) { return; }
        const wc = win.webContents;
        if (wc.isDevToolsOpened()) {
            wc.closeDevTools();
        } else {
            wc.openDevTools({ mode: 'detach' });
            injectDevToolsConsoleButtons(wc);
        }
    });
    // 开新窗口（可选绑定主文件夹，否则空 AI 视口）
    // 主文件夹锁：若 folderPath 已被其他窗口作为主文件夹，拒绝创建并聚焦已有窗口
    ipcMain.handle('qqqide:window:new', async (_e, folderPath?: string) => {
        if (folderPath && typeof folderPath === 'string') {
            const normalized = folderPath.replace(/\\/g, '/').replace(/\/$/, '');
            // 第一层：内存映射查重（最快，零 I/O）
            const existingWinId = _projectWindowMap.get(normalized);
            if (existingWinId != null) {
                const existingWin = BrowserWindow.fromId(existingWinId);
                if (existingWin && !existingWin.isDestroyed()) {
                    if (existingWin.isMinimized()) existingWin.restore();
                    existingWin.focus();
                    return { ok: false, locked: true, existingWindowId: existingWinId };
                }
                // 窗口已销毁但映射残留，清理
                _projectWindowMap.delete(normalized);
                _windowProjectMap.delete(existingWinId);
            }
            // 第二层：检查磁盘锁文件（防御内存映射不一致的极端情况）
            const lockPath = normalized + '/qqq/alphal/.lock';
            try {
                const lockRaw = fs.readFileSync(lockPath, 'utf-8');
                const lockData = JSON.parse(lockRaw);
                const age = Date.now() - (lockData.atime || 0);
                if (age < 60000) {
                    // 锁有效但内存映射中无记录 → 可能存在另一个 qqq 进程或映射丢失
                    // 保守策略：拒绝创建，但不聚焦（不知道窗口）
                    return { ok: false, locked: true, existingWindowId: null };
                }
                // 僵尸锁：删除
                try { fs.unlinkSync(lockPath); } catch (_) {}
            } catch (_) { /* 锁文件不存在，正常 */ }
        }
        const newWin = createWindow();
        let url = bootConfig.url + '?fresh=1';
        if (folderPath && typeof folderPath === 'string') {
            url += '&folder=' + encodeURIComponent(folderPath);
        }
        const ok = await new Promise<boolean>(resolve => {
            let settled = false;
            const onFinish = () => { if (!settled) { settled = true; resolve(true); } };
            const onFail = () => { if (!settled) { settled = true; resolve(false); } };
            newWin.webContents.on('did-finish-load', onFinish);
            newWin.webContents.on('did-fail-load', onFail);
            newWin.loadURL(url).catch(() => resolve(false));
        });
        return { ok, id: newWin.id };
    });

    // 渲染层成功绑定主文件夹后注册映射（用于窗口间主文件夹锁）
    ipcMain.handle('qqqide:window:claimProject', (_e, projectRoot: string) => {
        const win = BrowserWindow.fromWebContents(_e.sender);
        if (!win) return false;
        const normalized = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
        // 清理旧映射（同一窗口切换项目）
        const oldProject = _windowProjectMap.get(win.id);
        if (oldProject && oldProject !== normalized) {
            _projectWindowMap.delete(oldProject);
        }
        _windowProjectMap.set(win.id, normalized);
        _projectWindowMap.set(normalized, win.id);
        return true;
    });

    // 渲染层释放主文件夹绑定（窗口关闭或切换项目时）
    ipcMain.handle('qqqide:window:releaseProject', (_e, projectRoot: string) => {
        const win = BrowserWindow.fromWebContents(_e.sender);
        if (!win) return false;
        const normalized = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
        const currentProject = _windowProjectMap.get(win.id);
        if (currentProject === normalized) {
            _windowProjectMap.delete(win.id);
            _projectWindowMap.delete(normalized);
        }
        return true;
    });

    // ---- zoom IPC ----
    ipcMain.handle('qqqide:zoom:get', () => zoomFactor);
    ipcMain.handle('qqqide:zoom:set', (_e, factor: number) => {
        const f = Math.max(0.5, Math.min(2.0, +Number(factor).toFixed(2)));
        zoomFactor = f;
        if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.setZoomFactor(f); }
        saveZoom();
        if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('qqqide:zoom:changed', f); } catch { /* ignore */ } }
        return f;
    });
    ipcMain.handle('qqqide:zoom:adjust', (_e, delta: number) => {
        const next = Math.max(0.5, Math.min(2.0, +(zoomFactor + Number(delta)).toFixed(2)));
        zoomFactor = next;
        if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.setZoomFactor(next); }
        saveZoom();
        if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('qqqide:zoom:changed', next); } catch { /* ignore */ } }
        return next;
    });

    // ---- menu ----
    ipcMain.handle('qqqide:menu:set', (_e, schema: MenuSchema | null) => {
        applyMenuSchema(schema, mainWindow);
        return true;
    });

    // ---- engine generic ----
    ipcMain.handle('qqqide:engine:invoke', async (_e, method: string, params: any) => {
        // Special case: 'spawn' command - route to unified qz subsystem
        if (method === 'spawn' && params && params.cmd) {
            return _qgc(async () => qzSpawn.spawn(params as SpawnBrief));
        }
        return engineHost.invoke(method, params);
    });
    ipcMain.handle('qqqide:engine:isAlive', () => engineHost.isAlive());

    // ---- ghrun (process spawning via qz subsystem) ----
    ipcMain.handle('qqqide:ghrun:exec', async (_e, cmd: string, args: string[], opts?: any) => {
        // Single funnel: always go through qzSpawn (ghrun → node)
        return _qgc(async () => qzSpawn.spawn({ cmd, args, ...(opts || {}) }));
    });
    ipcMain.handle('qqqide:ghrun:isAlive', () => qzSpawn.ghrunAlive());

    // ---- qz unified spawn (canonical entry; ghrun/engine helpers delegate here) ----
    ipcMain.handle('qqqide:qz:spawn', async (_e, brief: SpawnBrief) => {
        return _qgc(async () => qzSpawn.spawn(brief || ({} as SpawnBrief)));
    });
    ipcMain.handle('qqqide:qz:which', async (_e, cmd: string) => qzSpawn.which(cmd));
    ipcMain.handle('qqqide:qz:ghrunAlive', () => qzSpawn.ghrunAlive());
    ipcMain.handle('qqqide:qz:runnerAlive', () => false); // runner.py retired, ghrun absorbed all capabilities

    // ---- lsp (language intelligence — spawns gopls/pyright/clangd/rust-analyzer) ----
    ipcMain.handle('qqqide:lsp:startLanguage', async (_e, lang: string, rootUri: string) => {
        return lspBridge.startLanguage(lang, rootUri);
    });
    ipcMain.handle('qqqide:lsp:stopLanguage', async (_e, lang: string) => {
        await lspBridge.stopLanguage(lang);
    });
    ipcMain.handle('qqqide:lsp:openDocument', async (_e, filePath: string, text: string) => {
        return lspBridge.openDocument(filePath, text);
    });
    ipcMain.handle('qqqide:lsp:changeDocument', async (_e, filePath: string, changes: any[], version: number) => {
        await lspBridge.changeDocument(filePath, changes, version);
    });
    ipcMain.handle('qqqide:lsp:closeDocument', async (_e, filePath: string) => {
        await lspBridge.closeDocument(filePath);
    });
    ipcMain.handle('qqqide:lsp:getDiagnostics', async (_e, uri: string) => {
        return lspBridge.getDiagnostics(uri);
    });
    ipcMain.handle('qqqide:lsp:activeLanguages', () => lspBridge.activeLanguages());
    ipcMain.handle('qqqide:lsp:hover', async (_e, filePath: string, line: number, character: number) => {
        return lspBridge.hover(filePath, line, character);
    });

    // ---- ai hover — one-shot explanation for code symbols ----
    ipcMain.handle('qqqide:ai:hover', async (_e, context: string) => {
        const token = process.env.QQQ_AI_TOKEN || '';
        if (!token || !context) return null;
        try {
            const resp = await fetch('https://gh555.com/api/v3/ai/chat', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: context }],
                    max_tokens: 200,
                    temperature: 0.3,
                }),
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            return data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content : null;
        } catch (e) {
            return null;
        }
    });

    // ---- cache (KV + bucketed file cache rooted at portable.cache) ----
    ipcMain.handle('qqqide:cache:get', async (_e, key: string) => cacheStore.get(key));
    ipcMain.handle('qqqide:cache:put', async (_e, key: string, value: any, opts?: any) => cacheStore.put(key, value, opts));
    ipcMain.handle('qqqide:cache:has', async (_e, key: string) => cacheStore.has(key));
    ipcMain.handle('qqqide:cache:delete', async (_e, key: string) => cacheStore.del(key));
    ipcMain.handle('qqqide:cache:path', async (_e, key: string) => cacheStore.path(key));
    ipcMain.handle('qqqide:cache:bucketPath', async (_e, sig: string, ext?: string) => cacheStore.bucketPath(sig, ext));

    // ---- state (唯一真理持久化机器: doc / blob / log via shell/state-store.ts) ----
    ipcMain.handle('qqqide:state:register', async (_e, ns: string, schema: NsSchema) => {
        // Renderers can NOT pass functions through IPC, so merger/migrators are stripped.
        // For complex merging, schemas must be registered main-side (see registerShellState).
        const safeSchema: NsSchema = {
            v: schema.v, form: schema.form,
            quotaBytes: schema.quotaBytes, cloud: !!schema.cloud,
            debounceMs: schema.debounceMs, compactThresholdBytes: schema.compactThresholdBytes,
        };
        stateStore.register(ns, safeSchema);
        return true;
    });
    ipcMain.handle('qqqide:state:get', async (_e, ns: string, key: string) => stateStore.get(ns, key));
    ipcMain.handle('qqqide:state:set', async (_e, ns: string, key: string, v: any) => { await stateStore.set(ns, key, v); return true; });
    ipcMain.handle('qqqide:state:setNow', async (_e, ns: string, key: string, v: any) => { await stateStore.setNow(ns, key, v); return true; });
    ipcMain.handle('qqqide:state:append', async (_e, ns: string, key: string, ev: any) => { await stateStore.append(ns, key, ev); return true; });
    ipcMain.handle('qqqide:state:del', async (_e, ns: string, key: string) => stateStore.del(ns, key));
    ipcMain.handle('qqqide:state:list', async (_e, ns: string) => stateStore.list(ns));
    ipcMain.handle('qqqide:state:flush', async () => { await stateStore.flush(); return true; });
    ipcMain.handle('qqqide:state:flushOne', async (_e, ns: string, key: string) => { await stateStore.flushOne(ns, key); return true; });
    ipcMain.handle('qqqide:state:stats', () => stateStore.stats());
    ipcMain.handle('qqqide:state:cloud:pull', async () => stateCloud.pull());
    ipcMain.handle('qqqide:state:cloud:push', async () => stateCloud.push());
    ipcMain.handle('qqqide:state:cloud:sync', async () => stateCloud.sync());
    ipcMain.handle('qqqide:state:sql', async (_e, query: string, params?: any[]) => stateStore.sql(query, params));

    // ---- project-level StateStore (per-project quest.sq3) ----
    function _getProjectStateStore(dbPath: string): StateStore {
        let inst = _projectStateStores.get(dbPath);
        if (!inst) {
            inst = new StateStore(portable.userData, dbPath);
            // Forward change events to renderer
            inst.on('changed', (msg: any) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try { mainWindow.webContents.send('qqqide:state:project:changed', { ...msg, dbPath }); } catch { /* ignore */ }
                }
            });
            _projectStateStores.set(dbPath, inst);
        }
        return inst;
    }
    ipcMain.handle('qqqide:state:project:register', async (_e, dbPath: string, ns: string, schema: any) => {
        const safeSchema: NsSchema = {
            v: schema.v, form: schema.form,
            quotaBytes: schema.quotaBytes, cloud: false,
            debounceMs: schema.debounceMs, compactThresholdBytes: schema.compactThresholdBytes,
        };
        _getProjectStateStore(dbPath).register(ns, safeSchema);
        return true;
    });
    ipcMain.handle('qqqide:state:project:get', async (_e, dbPath: string, ns: string, key: string) => _getProjectStateStore(dbPath).get(ns, key));
    ipcMain.handle('qqqide:state:project:set', async (_e, dbPath: string, ns: string, key: string, v: any) => { await _getProjectStateStore(dbPath).set(ns, key, v); return true; });
    ipcMain.handle('qqqide:state:project:setNow', async (_e, dbPath: string, ns: string, key: string, v: any) => { await _getProjectStateStore(dbPath).setNow(ns, key, v); return true; });
    ipcMain.handle('qqqide:state:project:append', async (_e, dbPath: string, ns: string, key: string, ev: any) => { await _getProjectStateStore(dbPath).append(ns, key, ev); return true; });
    ipcMain.handle('qqqide:state:project:del', async (_e, dbPath: string, ns: string, key: string) => _getProjectStateStore(dbPath).del(ns, key));
    ipcMain.handle('qqqide:state:project:list', async (_e, dbPath: string, ns: string) => _getProjectStateStore(dbPath).list(ns));
    ipcMain.handle('qqqide:state:project:flush', async (_e, dbPath: string) => { await _getProjectStateStore(dbPath).flush(); return true; });
    ipcMain.handle('qqqide:state:project:flushOne', async (_e, dbPath: string, ns: string, key: string) => { await _getProjectStateStore(dbPath).flushOne(ns, key); return true; });
    ipcMain.handle('qqqide:state:project:stats', async (_e, dbPath: string) => _getProjectStateStore(dbPath).stats());

    // ---- qg (FS project-level state, per-project .qqq/qg/ instances) ----
    function _getQg(rootDir: string): Qg {
        let inst = _qgInstances.get(rootDir);
        if (!inst) {
            inst = new Qg(rootDir);
            // Forward qg change events to renderer
            inst.on('changed', (msg: any) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try { mainWindow.webContents.send('qqqide:qg:changed', { ...msg, rootDir }); } catch { /* ignore */ }
                }
            });
            _qgInstances.set(rootDir, inst);
        }
        return inst;
    }
    ipcMain.handle('qqqide:qg:register', async (_e, rootDir: string, ns: string, schema: any) => {
        const safeSchema = { v: schema.v, form: schema.form, cloud: false };
        _getQg(rootDir).register(ns, safeSchema);
        return true;
    });
    ipcMain.handle('qqqide:qg:get', async (_e, rootDir: string, ns: string, key: string) => _getQg(rootDir).get(ns, key));
    ipcMain.handle('qqqide:qg:set', async (_e, rootDir: string, ns: string, key: string, v: any) => { const qg = _getQg(rootDir); await qg.set(ns, key, v); return true; });
    ipcMain.handle('qqqide:qg:setNow', async (_e, rootDir: string, ns: string, key: string, v: any) => { const qg = _getQg(rootDir); await qg.setNow(ns, key, v); return true; });
    ipcMain.handle('qqqide:qg:append', async (_e, rootDir: string, ns: string, key: string, ev: any) => { const qg = _getQg(rootDir); await qg.append(ns, key, ev); return true; });
    ipcMain.handle('qqqide:qg:del', async (_e, rootDir: string, ns: string, key: string) => _getQg(rootDir).del(ns, key));
    ipcMain.handle('qqqide:qg:list', async (_e, rootDir: string, ns: string) => _getQg(rootDir).list(ns));
    ipcMain.handle('qqqide:qg:flush', async (_e, rootDir: string) => { const qg = _getQg(rootDir); await qg.flush(); return true; });
    ipcMain.handle('qqqide:qg:stats', async (_e, rootDir: string) => _getQg(rootDir).stats());
    ipcMain.handle('qqqide:qg:flushOne', async (_e, rootDir: string, ns: string, key: string) => { await _getQg(rootDir).flushOne(ns, key); return true; });

    // ---- hash (xxh64 fast + sha256 strong, with mtime cache) ----
    ipcMain.handle('qqqide:hash:file', async (_e, p: string, mode?: 'fast' | 'strong' | 'both') => hashService.hashFile(p, mode || 'fast'));
    ipcMain.handle('qqqide:hash:buffer', async (_e, b64: string, mode?: 'fast' | 'strong' | 'both') => hashService.hashBuffer(Buffer.from(b64, 'base64'), mode || 'fast'));

    // ---- media (ffmpeg-backed thumbnail / transcode / probe via qzSpawn) ----
    ipcMain.handle('qqqide:media:thumb', async (_e, opts: any) => mediaService.thumb(opts || {}));
    ipcMain.handle('qqqide:media:transcode', async (_e, opts: any) => mediaService.transcode(opts || {}));
    ipcMain.handle('qqqide:media:probe', async (_e, src: string) => mediaService.probe(src));
    ipcMain.handle('qqqide:media:ffmpegPath', () => mediaService.ffmpegPath());

    // ---- key (global shortcut registration; per-window/iframe handled in renderer) ----
    ipcMain.handle('qqqide:key:registerGlobal', async (_e, accel: string, id: string) => {
        return registerGlobalKey(accel, id);
    });
    ipcMain.handle('qqqide:key:unregisterGlobal', async (_e, accel: string) => {
        try { require('electron').globalShortcut.unregister(accel); } catch { /* ignore */ }
        return true;
    });
    ipcMain.handle('qqqide:key:unregisterAllGlobal', async () => {
        try { require('electron').globalShortcut.unregisterAll(); } catch { /* ignore */ }
        return true;
    });

    // ---- audio (route to miniaudio_v16.py via miniaudio_bridge.py) ----
    ipcMain.handle('qqqide:audio:play', async (_e, file: string, opts?: any) => {
        try {
            const action = (opts && opts.sfx) ? 'play_sfx' : 'play_music';
            return await audioEngine.invoke(action, { path: file, ...(opts || {}) });
        } catch (e: any) {
            console.warn('[audio.play]', e && e.message);
            return { ok: false, error: String(e && e.message) };
        }
    });
    ipcMain.handle('qqqide:audio:stop', async (_e, scope?: string) => {
        try {
            const action = scope === 'music' ? 'stop_music' : 'stop_all';
            return await audioEngine.invoke(action, {});
        } catch (e: any) {
            return { ok: false, error: String(e && e.message) };
        }
    });
    ipcMain.handle('qqqide:audio:invoke', async (_e, action: string, params: any) => {
        return audioEngine.invoke(action, params || {});
    });
    ipcMain.handle('qqqide:audio:isAlive', () => audioEngine.isAlive());

    // ---- system shell ----
    ipcMain.handle('qqqide:shell:openExternal', (_e, url: string) => electronShell.openExternal(url));
    ipcMain.handle('qqqide:shell:openPath', (_e, p: string) => electronShell.openPath(p));

    // ---- download (SmartHttpDownloader) ----
    // Progress events are sent via webContents; forwarder wired in createWindow.
    ipcMain.handle('qqqide:download:start', async (_e, opts: DownloadOpts) => {
        return downloadService.start(opts || ({} as DownloadOpts));
    });
    ipcMain.handle('qqqide:download:cancel', async (_e, id: string) => {
        return downloadService.cancel(id);
    });
    ipcMain.handle('qqqide:download:list', async () => {
        return downloadService.list();
    });

    // ---- clipboard ----
    ipcMain.handle('qqqide:clipboard:readText', () => {
        return require('electron').clipboard.readText();
    });
    ipcMain.handle('qqqide:clipboard:writeText', (_e: any, s: string) => {
        require('electron').clipboard.writeText(s);
    });
    ipcMain.handle('qqqide:clipboard:readImage', () => {
        const img = require('electron').clipboard.readImage();
        if (img.isEmpty()) return null;
        return img.toPNG().toString('base64');
    });
    ipcMain.handle('qqqide:clipboard:hasImage', () => {
        return !require('electron').clipboard.readImage().isEmpty();
    });

    // ---- update (hot reload: pull server-app.tar.xz from gh555.com) ----
    ipcMain.handle('qqqide:update:check', async () => {
        return updateService.check();
    });
    ipcMain.handle('qqqide:update:apply', async () => {
        return updateService.apply();
    });
    ipcMain.handle('qqqide:update:state', async () => {
        return updateService.getState();
    });
    ipcMain.handle('qqqide:update:abort', async () => {
        updateService.abort();
        return true;
    });

    // ---- monaco ----
    monacoHost.register();

    // ---- 外嵌 AI 面板（僚机：不可拖动、同层级、实时跟随、可独立聚焦、仅主窗口可控关闭） ----
    
    ipcMain.handle('qqqide:ai-panel:toggle-external', async (_e, index: number, open: boolean) => {
        if (index < 0 || index > 1) return false;
        const mw = mainWindow;
        if (!mw || mw.isDestroyed()) return false;

        if (open) {
            // 已存在且未销毁 → 直接显示
            const existing = _externalPanels[index];
            if (existing && !existing.isDestroyed()) {
                if (!existing.isVisible()) { existing.showInactive(); syncExtWin(index); }
                return true;
            }
            
            const mwBounds = mw.getBounds();
            const aiW = 389;
            const preloadPath = path.join(__dirname, 'preload.js');
            const xPos = index === 0 ? mwBounds.x - aiW : mwBounds.x + mwBounds.width;

            const expectedBounds = () => {
                const b = mw.getBounds();
                const sx = index === 0 ? b.x - aiW : b.x + b.width;
                return { x: sx, y: b.y, width: aiW, height: b.height };
            };

            const extWin = new BrowserWindow({
                width: aiW, height: mwBounds.height,
                x: xPos,
                y: mwBounds.y,
                skipTaskbar: true,
                frame: false,
                movable: false,
                resizable: false,
                focusable: true,
                show: false,
                backgroundColor: '#1e1e1e',
                title: 'qqq AI ' + (index === 0 ? 'L' : 'R'),
                webPreferences: {
                    preload: preloadPath,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: false,
                    webSecurity: false,
                },
            });
            extWin.removeMenu();
            
            // ★ 禁止独立关闭僚机（Alt+F4 / 系统菜单均拦截）
            extWin.on('close', (e) => {
                if (!_allowExtClose) {
                    e.preventDefault();
                    // 改为隐藏（与红色灯泡关闭行为一致）
                    extWin.hide();
                    return;
                }
            });

            extWin.loadURL(bootConfig.url + 'ai-panel/index.html?external=' + index).catch(() => { });

            // ── 实时同步引擎 ──
            const syncExt = () => { try { syncExtWin(index); } catch { /* ignore */ } };

            mw.on('move', syncExt);
            mw.on('resize', syncExt);
            let _rafPending = false;
            const syncExtRaf = () => {
                if (_rafPending) return;
                _rafPending = true;
                requestAnimationFrame(() => { _rafPending = false; try { syncExt(); } catch { /* ignore */ } });
            };
            mw.on('will-move' as any, syncExtRaf);
            mw.on('will-resize' as any, syncExtRaf);

            const onFocus = () => {
                try {
                    if (extWin.isDestroyed()) return;
                    if (extWin.isFocused()) return;
                    extWin.showInactive();
                    extWin.moveTop();
                } catch { /* ignore */ }
            };
            mw.on('focus', onFocus);

            const onMinimize = () => { try { if (!extWin.isDestroyed()) extWin.minimize(); } catch { /* ignore */ } };
            const onRestore = () => {
                try {
                    if (!extWin.isDestroyed()) extWin.restore();
                    if (!mw.isDestroyed()) mw.focus();
                } catch { /* ignore */ }
            };
            const onHide = () => { try { if (!extWin.isDestroyed()) extWin.hide(); } catch { /* ignore */ } };
            const onShow = () => {
                try {
                    if (!extWin.isDestroyed()) extWin.showInactive();
                    syncExt();
                } catch { /* ignore */ }
            };
            mw.on('minimize', onMinimize);
            mw.on('restore', onRestore);
            mw.on('hide', onHide);
            mw.on('show', onShow);

            extWin.on('closed', () => {
                _externalPanels[index] = null;
                if (!mw.isDestroyed()) {
                    mw.removeListener('move', syncExt);
                    mw.removeListener('resize', syncExt);
                    mw.removeListener('will-move' as any, syncExtRaf);
                    mw.removeListener('will-resize' as any, syncExtRaf);
                    mw.removeListener('focus', onFocus);
                    mw.removeListener('minimize', onMinimize);
                    mw.removeListener('restore', onRestore);
                    mw.removeListener('hide', onHide);
                    mw.removeListener('show', onShow);
                }
            });

            syncExt();
            extWin.showInactive();
            _externalPanels[index] = extWin;
            return true;
        } else {
            // 红色灯泡关闭 → 隐藏僚机（不销毁，保留内部状态）
            const extWin = _externalPanels[index];
            if (extWin && !extWin.isDestroyed()) {
                extWin.hide();
            }
            return true;
        }
    });
    
    // 僚机位置同步（提取为独立函数，供 toggle 和外部调用）
    function syncExtWin(index: number): void {
        try {
            const extWin = _externalPanels[index];
            const mw = mainWindow;
            if (!extWin || extWin.isDestroyed() || !mw || mw.isDestroyed()) return;
            if (!extWin.isVisible()) return;  // 隐藏中的僚机不强制同步位置
            const aiW = 389;
            const b = mw.getBounds();
            const x = index === 0 ? b.x - aiW : b.x + b.width;
            extWin.setBounds({ x, y: b.y, width: aiW, height: b.height });
        } catch {
            // 窗口可能在检查和操作之间被销毁（TOCTOU 竞态），安全吞掉
        }
    }

    // ═══ 跨窗口同步 IPC（替代 BroadcastChannel）═══
    // 项目路径存储（僚机初始化用）
    let _currentProjectPath: string | null = null;

    ipcMain.handle('qqqide:sync:get-project-path', () => _currentProjectPath);

    // 主题同步：僚机启动时获取主窗口当前主题
    ipcMain.handle('qqqide:sync:get-theme', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                return mainWindow.webContents.executeJavaScript('document.documentElement.getAttribute("data-theme") === "dark"');
            }
        } catch (_) { }
        return false;
    });

    ipcMain.handle('qqqide:sync:set-project-path', (e, p: string) => {
        // 仅主窗口有权推送项目路径（僚机跟随主窗口，不跟随新建窗口）
        const senderWin = BrowserWindow.fromWebContents(e.sender);
        if (senderWin !== mainWindow) return;
        _currentProjectPath = p;
        // 推送给僚机窗口（仅 external panels，不影响其他独立窗口）
        for (const extWin of _externalPanels) {
            if (extWin && !extWin.isDestroyed() && !extWin.webContents.isDestroyed()) {
                try { extWin.webContents.send('qqqide:sync:message', 'project-path', { path: p }); } catch { /* ignore */ }
            }
        }
    });

    // 通用消息广播：renderer → main → 其他 renderer
    ipcMain.handle('qqqide:sync:broadcast', (e, channel: string, data: any) => {
        const senderWC = e.sender;
        for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed() || win.webContents === senderWC) continue;
            if (win.webContents.isDestroyed()) continue;
            try { win.webContents.send('qqqide:sync:message', channel, data); } catch { /* ignore */ }
        }
    });
}

// ----------------------------------------------------------------------------
// Security: lock down session permissions
// ----------------------------------------------------------------------------
function hardenSession(): void {
    const ses = session.defaultSession;
    // Block new windows by default; renderer must use shell.openExternal
    ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));

    ses.webRequest.onHeadersReceived((details, cb) => {
        const headers = details.responseHeaders || {};
        // strip any X-Frame-Options to allow our iframe panels (still CSP-controlled)
        delete headers['x-frame-options'];
        delete headers['X-Frame-Options'];
        // CORS bypass for gh555.com API (AI chat gateway)
        if (details.url.includes('gh555.com')) {
            headers['access-control-allow-origin'] = ['*'];
            headers['access-control-allow-headers'] = ['Content-Type, Authorization'];
            headers['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, OPTIONS'];
            // Force OPTIONS preflight to pass by returning 200 status
            if (details.method === 'OPTIONS') {
                cb({ responseHeaders: headers, statusLine: 'HTTP/1.1 200 OK' });
                return;
            }
        }
        cb({ responseHeaders: headers });
    });
}

// ----------------------------------------------------------------------------
// App lifecycle
// ----------------------------------------------------------------------------
app.whenReady().then(async () => {
    // Force light theme at OS level - prevents Electron from using high-contrast rendering
    nativeTheme.themeSource = 'light';
    hardenSession();
    registerAssetProtocol();
    registerShellState();
    registerIpc();
    engineHost.start();
    await boot();
    // Hydrate shell-side prefs from StateStore (post-boot so renderer can read too).
    await _hydrateZoomFromState();
    await _hydrateAssetRootsFromState();
});

// ---- Crash / shutdown flush: StateStore flushSync on every exit path ----
let _flushedOnce = false;
function _flushStateSync(reason: string): void {
    if (_flushedOnce) { return; }
    _flushedOnce = true;
    try {
        console.log('[state] flushSync on', reason);
        stateStore.flushSync();
        for (const [rootDir, qg] of _qgInstances) {
            try { qg.flushSync(); } catch (e2) { console.warn('[qg] flushSync failed for', rootDir, e2); }
        }
        for (const [dbPath, pss] of _projectStateStores) {
            try { pss.flushSync(); } catch (e2) { console.warn('[project-state] flushSync failed for', dbPath, e2); }
        }
    } catch (e) {
        console.warn('[state] flushSync failed:', e);
    }
}
// ═══ 唯一退出路径：before-quit 统一清理所有资源 ═══
// 铁律：所有退出路径（窗口关闭/SIGINT/SIGTERM/托盘退出）最终汇聚于此
app.on('before-quit', async (e) => {
    // ★ 始终阻止默认退出 — 我们必须确保清理完成后再 app.exit(0)
    e.preventDefault();

    // ① 关闭所有僚机窗口（防止孤儿窗口残留）
    _allowExtClose = true;
    for (const extWin of _externalPanels) {
        if (extWin && !extWin.isDestroyed()) {
            try { extWin.close(); } catch { /* ignore */ }
        }
    }

    // ② 停止引擎子进程（q_win_x64.exe / ghrun.exe 等）
    //    必须在 state flush 之前，因为引擎可能持有 SQLite 连接
    try { engineHost.stop(); } catch { /* ignore */ }
    try { audioEngine.stop(); } catch { /* ignore */ }
    try { globalShortcut.unregisterAll(); } catch { /* ignore */ }

    // ③ 异步刷盘（优先），超时后走同步兜底
    //    跳过条件：如果是 SIGINT/SIGTERM 已同步刷过，_flushedOnce 为 true
    //    但仍需 app.exit(0) 确保退出（SIGINT/SIGTERM 路径不会自动退出）
    if (!_flushedOnce) {
        try {
            await stateStore.flush();
        } catch (err) {
            console.warn('[state] async flush before-quit failed:', err);
        }
        _flushStateSync('before-quit');
    }

    // ④ 硬退出：确保进程不留残影
    //     无论 _flushedOnce 状态如何，必须调用 app.exit(0)
    //     因为 e.preventDefault() 阻止了默认退出
    app.exit(0);
});
// SIGINT/SIGTERM: 同步刷盘后触发退出（汇聚到 before-quit 兜底）
process.on('SIGINT', () => { _flushStateSync('SIGINT'); try { app.quit(); } catch { process.exit(0); } });
process.on('SIGTERM', () => { _flushStateSync('SIGTERM'); try { app.quit(); } catch { process.exit(0); } });
// ═══ 全局异常兜底：刷盘 + 抑制已销毁窗口错误 ═══
process.on('uncaughtException', (err) => {
    // 已销毁窗口的异步回调抛错 → 安全吞掉（Electron 常态）
    if (err && err.message === 'Object has been destroyed') {
        console.warn('[main] uncaughtException (Object destroyed) suppressed');
        return;
    }
    console.error('[uncaughtException]', err);
    _flushStateSync('uncaughtException');
    // Also drop a crash log alongside other logs.
    try {
        const f = path.join(portable.logs, 'crash-' + Date.now() + '.log');
        fs.writeFileSync(f, String(err && (err as any).stack || err));
    } catch { /* ignore */ }
    // Let app continue if possible; do NOT exit silently.
});
process.on('unhandledRejection', (reason) => {
    console.warn('[unhandledRejection]', reason);
});

// ═══ DevTools Console 悬浮按钮注入（复制 / 另存为） ═══
function injectDevToolsConsoleButtons(wc: Electron.WebContents): void {
    // 等待 DevTools 加载完成后注入
    const tryInject = () => {
        const dwc = (wc as any).devToolsWebContents;
        if (!dwc) { return; }
        dwc.executeJavaScript(`
(function() {
  if (window.__qqq_dt_btns_installed) return;
  window.__qqq_dt_btns_installed = true;

  var style = document.createElement('style');
  style.textContent = [
    '#qqqide-dt-btns { position:fixed; bottom:12px; right:12px; display:flex; gap:6px; z-index:999999; opacity:0.3; transition:opacity 0.15s; }',
    '#qqqide-dt-btns:hover { opacity:1; }',
    '#qqqide-dt-btns button { padding:4px 10px; border:1px solid #888; border-radius:3px; background:#2a2a2a; color:#ccc; font-size:11px; cursor:pointer; white-space:nowrap; font-family:ui-monospace,monospace; }',
    '#qqqide-dt-btns button:hover { background:#3a3a3a; border-color:#ccc; }',
    '#qqqide-dt-toast { position:fixed; bottom:44px; right:12px; padding:4px 10px; border-radius:3px; background:rgba(0,0,0,0.85); color:#fff; font-size:11px; z-index:999999; pointer-events:none; opacity:0; transition:opacity 0.2s; font-family:ui-monospace,monospace; }'
  ].join('\\n');
  document.head.appendChild(style);

  var btns = document.createElement('div');
  btns.id = 'qqq-dt-btns';
  btns.innerHTML = '<button id="qqq-dt-copy">\u{1F4CB} \u590D\u5236</button><button id="qqq-dt-save">\u{1F4BE} \u53E6\u5B58\u4E3A</button>';

  var toast = document.createElement('div');
  toast.id = 'qqq-dt-toast';

  var _toastTimer = 0;
  function showToast(msg) {
    toast.textContent = msg;
    toast.style.opacity = '1';
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function() { toast.style.opacity = '0'; }, 1800);
  }

  // 从 Console 面板提取全部文本
  function getConsoleText() {
    var parts = [];
    // 尝试常见的 DevTools Console DOM 选择器
    var msgs = document.querySelectorAll('.console-message-text, .console-message, .source-code, [class*="console"] [class*="text"], [class*="console"] [class*="message"]');
    if (msgs.length === 0) {
      // 回退：取整个 body 可见文本（粗糙但有结果）
      var body = document.body;
      if (body) { parts.push(body.innerText); }
    } else {
      for (var i = 0; i < msgs.length; i++) {
        var t = (msgs[i].textContent || '').trim();
        if (t) parts.push(t);
      }
    }
    return parts.join('\\n');
  }

  // 仅在 Console 面板可见时显示按钮
  function updateVisibility() {
    var consolePanel = document.querySelector('.console-view, [aria-label="Console"], [class*="console"]');
    btns.style.display = consolePanel ? '' : 'none';
  }

  var copyBtn = document.getElementById('qqq-dt-copy');
  if (copyBtn) copyBtn.onclick = function() {
    var text = getConsoleText();
    if (!text) { showToast('\u63A7\u5236\u53F0\u6682\u65E0\u8F93\u51FA'); return; }
    navigator.clipboard.writeText(text).then(function() {
      showToast('\u5DF2\u590D\u5236 ' + text.split('\\n').length + ' \u884C');
    }).catch(function() { showToast('\u590D\u5236\u5931\u8D25'); });
  };

  var saveBtn = document.getElementById('qqq-dt-save');
  if (saveBtn) saveBtn.onclick = function() {
    var text = getConsoleText();
    if (!text) { showToast('\u63A7\u5236\u53F0\u6682\u65E0\u8F93\u51FA'); return; }
    var blob = new Blob([text], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'console_' + new Date().toISOString().slice(0,10) + '.log';
    a.click();
    showToast('\u5DF2\u4E0B\u8F7D');
  };

  document.body.appendChild(btns);
  document.body.appendChild(toast);

  // 监听面板切换（Console 可见时才显示按钮）
  updateVisibility();
  var observer = new MutationObserver(updateVisibility);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
})();
`).catch(() => { /* DevTools may not be ready yet */ });
    };

    // 立即尝试（DevTools 可能已打开），否则轮询等待
    if ((wc as any).devToolsWebContents) {
        tryInject();
        return;
    }
    let attempts = 0;
    const pollTimer = setInterval(() => {
        attempts++;
        if ((wc as any).devToolsWebContents) {
            clearInterval(pollTimer);
            tryInject();
        } else if (attempts >= 30) {
            clearInterval(pollTimer);
        }
    }, 500);
}



// ═══ 所有窗口关闭 → 触发退出（汇聚到 before-quit 统一清理）═══
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { app.quit(); }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { boot(); }
});

// Block all attempts to open new windows; force them through openExternal.
app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
        electronShell.openExternal(url);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
        // Only allow navigation to our remote root
        try {
            const target = new URL(url);
            const allowed = new URL(bootConfig.url);
            if (target.origin !== allowed.origin && !url.startsWith('file://')) {
                e.preventDefault();
                electronShell.openExternal(url);
            }
        } catch { e.preventDefault(); }
    });
});
