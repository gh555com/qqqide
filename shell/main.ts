// 禁掉 Electron 开发模式安全警告（webSecurity/allowRunningInsecureContent/CSP unsafe-eval）
// 这些配置为项目必需（访问多源 HTTP/HTTPS、Monaco 动态执行），打包后不会显示
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// ============================================================================
// main.ts - Electron main process entry
// 导航 → 子模块职责一览（详细见 do/拓扑/架构 §目录结构）：
//   boot.ts            启动配置 / 健康检查 / 壳层热更 / 启动序列
//   window-manager.ts  窗口创建 / 缩放 / 边界持久化 / 全局快捷键
//   asset-protocol.ts  qqqide-asset:// 协议 / 资产根 / 磁盘空闲
//   ipc-state.ts       共享状态（qwr机器 _sn/_qe / Python路径 / 跳过列表）
//   ipc-boot.ts        启动信息 / 重试 / 探测 IPC
//   ipc-fs.ts          文件系统 IPC
//   ipc-ai-tools.ts    AI工具 IPC（search_text / find_files / list_files）
//   ipc-search.ts      高性能搜索引擎 IPC
//   ipc-edit.ts        编辑工具 IPC + qwr 保护
//   ipc-timeline.ts    Timeline 版本时间线 + Diff 窗口 IPC
//   ipc-misc.ts        窗口 / 对话框 / 资产根 / 磁盘 IPC
//   shutdown.ts        安全加固 / 退出处理器 / 崩溃兜底
// ============================================================================

import { applyPortablePaths, getAppRoot } from './portable-paths';
const portable = applyPortablePaths();

import { app, BrowserWindow, protocol, nativeTheme, safeStorage, ipcMain } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ── 子模块 ──
import { loadBootConfig, extractFlags, bootSequence, BootMode, BootConfig } from './boot';
import { APP_VERSION } from './version';
import { editorFontSize, createWindow, _windowProjectMap, _projectWindowMap } from './window-manager';
import { initAssetProtocol, hydrateAssetRootsFromState } from './asset-protocol';
import { registerFsIpc } from './ipc-fs';
import { registerBootIpc } from './ipc-boot';
import { registerAiToolsIpc } from './ipc-ai-tools';
import { registerSearchIpc } from './ipc-search';
import { registerEditIpc } from './ipc-edit';
import { registerMiscIpc } from './ipc-misc';
import { registerTimelineIpc } from './ipc-timeline';
import { registerSmartSearchIpc, IndexService } from './ipc-smart-search';
import { registerStateHandlersIpc } from './ipc-state-handlers';
import { hardenSession, registerExitHandlers } from './shutdown';

// ── 服务 ──
import { EngineHost } from './engines';
import { AudioEngine } from './audio-engine';
import { applyMenuSchema, MenuSchema } from './menu-builder';
import { MonacoHost } from './monaco-host';
import { QzSpawn, registerQzSpawnIpc } from './qz-spawn';
// import { LspBridge } from './lsp-bridge'; // LSP OFF — 2026-06-23
import { CacheStore } from './cache-store';
import { HashService } from './hash-service';
import { MediaService } from './media-service';
import { StateStore } from './state-sqlite';
import { StateCloud } from './state-cloud';
import { Qgf } from './qgf';
import { DownloadService } from './download-service';
import { UpdateService } from './update-service';

// ── Chromium flags (必须在 app.whenReady() 前) ──
// ★ 原 disableHardwareAcceleration() 注释于 2026-06-25
//   最初加它只为了省 ~40MB 内存（2026-06-06 快照），但代价是强制
//   SwiftShader CPU 软件合成 → GPU 进程纯 CPU 渲染 → 长期 ~55% 单核
//   空闲占用（PID 2160 累计 1878s CPU / 57min 窗口）。现在回到默认，
//   让 Chromium 自动裁决硬件/软件渲染，进入观察期。
// app.disableHardwareAcceleration(); // [COMMENTED OUT 2026-06-25]
app.commandLine.appendSwitch('forced-colors', 'none');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'ForcedColors,AutoDarkMode');
// ★ CDP devtools capture: 克隆 DevTools 另存为 100% 输出（Log.entryAdded）
app.commandLine.appendSwitch('remote-debugging-port', '8315');

// ── 自定义协议 qqqide:// — 浏览器登录成功后 push token 回 IDE（2026-06-29） ──
// dev 模式必须传 app path（否则 Electron 启动默认 app→把 URL 当模块路径→炸）
// prod 打包后 qqqide.exe 自带 app path，不需要
if (app.isPackaged) {
    app.setAsDefaultProtocolClient('qqqide');
} else {
    app.setAsDefaultProtocolClient('qqqide', process.execPath, [app.getAppPath()]);
}
const gotTheLock = app.requestSingleInstanceLock();
let _shouldQuitEarly = false;
if (!gotTheLock) {
    _shouldQuitEarly = true;
}

// ── 自签名证书信任（自建 Nginx 用自签 SSL，必须放行） ──
app.on('certificate-error', (event, _webContents, _url, _error, certificate, callback) => {
    // 信任 direct.gh555.com 域名下任何证书（自签 / 过期都过）
    if (certificate && certificate.issuerName && certificate.issuerName.includes('gh555')) {
        event.preventDefault();
        callback(true);
    } else if (_url.includes('direct.gh555.com')) {
        event.preventDefault();
        callback(true);
    } else if (_url.includes('47.105.67.51')) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});

// ── 自定义协议 qqqide:// — 浏览器登录成功 push token 回 IDE（2026-06-29） ──
app.on('second-instance', (_event, argv) => {
    const url = argv.find((a: string) => a.startsWith('qqqide://'));
    if (url) handleAuthProtocolUrl(url);
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAuthProtocolUrl(url);
});

// ── DevTools 窗口标题自动重命名 ──
// Electron 22 detached DevTools 创建独立 BrowserWindow。
// browser-window-created 钩子捕获 → 延迟匹配主窗口（devToolsWebContents 可能尚未赋值）。
// ★ URL 检测 + 标题检测双保险：刚创建时 URL 可能是 about:blank，标题已含 "Developer Tools"。
app.on('browser-window-created', (_e, bw) => {
    try {
        const url = bw.webContents?.getURL?.() || '';
        const title = bw.getTitle?.() || '';
        const isDevTools = url.startsWith('devtools://') || title.startsWith('Developer Tools');
        if (!isDevTools) return;
        const devWin = bw;
        // 延迟重试匹配主窗口（devToolsWebContents + _windowProjectMap 可能未就绪）
        const tryRename = (attempt: number) => {
            try {
                if (devWin.isDestroyed()) return;
                const allWins = BrowserWindow.getAllWindows();
                for (const mw of allWins) {
                    if (mw.isDestroyed()) continue;
                    const dwc = (mw.webContents as any).devToolsWebContents;
                    if (dwc && !dwc.isDestroyed() && dwc.id === devWin.webContents.id) {
                        const projPath = _windowProjectMap.get(mw.id);
                        const name = projPath ? path.basename(projPath) : 'qqq IDE';
                        devWin.setTitle(`「🔧」${name}`);
                        return;
                    }
                }
                if (attempt < 5) setTimeout(() => tryRename(attempt + 1), 500);
            } catch (_) { /* ignore */ }
        };
        setTimeout(() => tryRename(0), 400);
    } catch (_) { /* ignore */ }
});

function handleAuthProtocolUrl(url: string): void {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'auth') {
            const token = parsed.searchParams.get('token');
            const phone = parsed.searchParams.get('phone');
            if (token && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('qqq-ide-auth', { token, phone: phone || '' });
                console.log('[protocol] auth token pushed to renderer, phone=' + (phone || '?'));
            }
        }
    } catch (e) {
        console.warn('[protocol] bad auth url:', e);
    }
}

function checkStartupAuthUrl(): void {
    const url = process.argv.find((a: string) => a.startsWith('qqqide://'));
    if (url) handleAuthProtocolUrl(url);
}

// ── 启动配置 + 标志 ──
const bootConfig: BootConfig = loadBootConfig(portable.root);
const { isOffline: isOfflineFlag, isDev: isDevFlag } = extractFlags();

// ── 单例服务 ──
const engineHost = new EngineHost(portable.root);
const audioEngine = new AudioEngine(portable.root);
const monacoHost = new MonacoHost();
const qzSpawn = new QzSpawn(portable.root);
// const lspBridge = new LspBridge(portable.root); // LSP OFF — 2026-06-23
const lspBridge: any = null;
const cacheStore = new CacheStore(portable.cache);
const hashService = new HashService(cacheStore);
const mediaService = new MediaService(portable.root, qzSpawn, cacheStore, hashService);
const stateStore = new StateStore(portable.userData);
const stateCloud = new StateCloud(stateStore);
const _qgfInstances = new Map<string, Qgf>();
const _projectStateStores = new Map<string, StateStore>();
const downloadService = new DownloadService(portable.cache);
const updateService = new UpdateService(portable.root, APP_VERSION);
const indexService = new IndexService(portable.root);

// ── 主窗口引用 ──
let mainWindow: BrowserWindow | null = null;

// ── 启动模式跟踪 ──
let lastBootMode: BootMode = 'fallback';
function setLastBootMode(m: BootMode) { lastBootMode = m; }
function getLastBootMode(): BootMode { return lastBootMode; }

// ── 注册协议 (必须在 app.ready 前) ──
protocol.registerSchemesAsPrivileged([
    { scheme: 'qqqide-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: 'qqqide-webapp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ── Shell state 注册 ──
function registerShellState(): void {
    try {
        stateStore.register('qqqide', {
            v: 1, form: 'doc', cloud: true,
            merger: (local: any, remote: any, ctx) => {
                if (!local) { return remote; }
                if (!remote) { return local; }
                if (typeof local === 'object' && typeof remote === 'object' && !Array.isArray(local) && !Array.isArray(remote)) {
                    return { ...local, ...remote };
                }
                if (Array.isArray(local) && Array.isArray(remote)) {
                    const s = new Set([...local, ...remote]);
                    return Array.from(s);
                }
                return remote;
            },
        });
        stateStore.register('qqqide.timeline', {
            v: 1, form: 'doc', cloud: false,
        });
    } catch (e) {
        console.warn('[state] registerShellState failed:', e);
    }
}

// Forward state changes to renderer
stateStore.on('changed', (msg: any) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        try { mainWindow.webContents.send('qqqide:state:changed', msg); } catch { /* ignore */ }
    }
});

// ── 注册所有 IPC ──
function registerAllIpc(): void {
    registerFsIpc();
    registerAiToolsIpc();
    registerSearchIpc();
    registerEditIpc();
    registerBootIpc(
        portable.root, portable.userData, portable.cache, portable.logs,
        APP_VERSION, bootConfig,
        () => engineHost.isAlive(),
        () => lastBootMode,
        () => mainWindow
    );
    registerMiscIpc(
        portable.root, portable.cache, APP_VERSION, isDevFlag,
        lspBridge, downloadService, stateStore,
        updateService, () => mainWindow, bootConfig  // lspBridge=null (LSP OFF)
    );
    registerTimelineIpc(portable.root, bootConfig);
    registerSmartSearchIpc(indexService);
    registerStateHandlersIpc(stateStore, stateCloud, _projectStateStores, _qgfInstances, () => mainWindow);
    registerQzSpawnIpc(qzSpawn);
    registerAuthPersistIpc();
}

// ── Auth 持久化 IPC — safeStorage 加密存盘，重启自动恢复（2026-06-29） ──
function registerAuthPersistIpc(): void {
    const AUTH_FILE = path.join(portable.userData, 'alphal', 'auth.enc');

    ipcMain.handle('qqqide:auth:save', async (_e, auth: { token: string; phone: string; device_name?: string } | null) => {
        if (!auth || !auth.token || !safeStorage.isEncryptionAvailable()) return false;
        try {
            const encrypted = safeStorage.encryptString(JSON.stringify(auth));
            const dir = path.dirname(AUTH_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(AUTH_FILE, new Uint8Array(encrypted));
            return true;
        } catch (e) { return false; }
    });

    ipcMain.handle('qqqide:auth:load', async () => {
        if (!safeStorage.isEncryptionAvailable()) return null;
        try {
            if (!fs.existsSync(AUTH_FILE)) return null;
            const encrypted = fs.readFileSync(AUTH_FILE);
            return JSON.parse(safeStorage.decryptString(encrypted));
        } catch (e) { return null; }
    });

    ipcMain.handle('qqqide:auth:clear', async () => {
        try { if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE); return true; }
        catch (e) { return false; }
    });
}

// ── App 就绪 ──
app.whenReady().then(async () => {
    // ★ If another instance already holds the lock, quit immediately — don't create windows
    if (_shouldQuitEarly) {
        app.quit();
        return;
    }

    // Force light theme
    nativeTheme.themeSource = 'light';

    // Init asset protocol + roots
    initAssetProtocol(portable.root, portable.cache, portable.userData);
    await hydrateAssetRootsFromState(stateStore);

    // Register shell state
    registerShellState();

    // Security hardening
    hardenSession();

    // Create main window
    mainWindow = createWindow(
        portable.root, portable.cache, APP_VERSION,
        lspBridge, downloadService, stateStore
    );

    // ★ 检查是否由 qqqide:// 协议启动（登录推送用）
    checkStartupAuthUrl();

    // Main window closed → stop engine + destroy child windows
    mainWindow.on('closed', () => {
        try {
            const all = BrowserWindow.getAllWindows();
            all.forEach(w => {
                if (!w.isDestroyed() && w !== mainWindow) { try { w.destroy(); } catch { /* ignore */ } }
            });
        } catch { /* ignore */ }
        try { engineHost.stop(); } catch { /* ignore */ }
        try { audioEngine.stop(); } catch { /* ignore */ }
        mainWindow = null;
    });

    // Register IPC (after window exists)
    registerAllIpc();

    // Register exit handlers
    registerExitHandlers(portable.root, portable.logs, stateStore, bootConfig, _qgfInstances);

    // Boot
    // ★ 多窗口还原 — 第一步：确保主窗口加载正确的项目文件夹
    try {
        const openWindows = await stateStore.get('qqqide', 'open_windows');
        if (openWindows && Array.isArray(openWindows) && openWindows.length > 0) {
            const w0 = openWindows[0];
            if (w0 && w0.mainFolder) {
                const n0 = w0.mainFolder.replace(/\\/g, '/').replace(/\/$/, '');
                if (n0) {
                    // ★ 注入主窗口 URL — 必须在 loadURL 之前
                    const sep = bootConfig.url.includes('?') ? '&' : '?';
                    bootConfig.url = bootConfig.url + sep + 'restore=1&folder=' + encodeURIComponent(n0);
                    // ★ 预注册，防止 restore 阶段重复创建
                    _windowProjectMap.set(mainWindow.id, n0);
                    _projectWindowMap.set(n0, mainWindow.id);
                }
            }
        }
    } catch (_) { }
    await bootSequence(
        mainWindow, bootConfig, portable.root, portable.cache,
        isDevFlag, isOfflineFlag, setLastBootMode, getLastBootMode
    );

    // ★ 多窗口还原：读取上次退出保存的窗口列表，还原额外窗口
    (async () => {
        try {
            const openWindows = await stateStore.get('qqqide', 'open_windows');
            if (openWindows && Array.isArray(openWindows) && openWindows.length > 1) {
                // ★ 预注册主窗口项目（open_windows[0]），防后续还原重复创建
                const w0 = openWindows[0];
                if (w0 && w0.mainFolder) {
                    var n0 = w0.mainFolder.replace(/\\/g, '/').replace(/\/$/, '');
                    if (n0) {
                        _windowProjectMap.set(mainWindow.id, n0);
                        _projectWindowMap.set(n0, mainWindow.id);
                    }
                }
                let restored = 0;
                // 跳过第一个窗口（主窗口已创建）
                for (let i = 1; i < openWindows.length; i++) {
                    const w = openWindows[i];
                    if (!w.mainFolder) continue;
                    const normalized = w.mainFolder.replace(/\\/g, '/').replace(/\/$/, '');
                    if (!normalized) continue;
                    // 已在其他窗口打开 → 跳过
                    if (_projectWindowMap.has(normalized)) continue;

                    const newWin = createWindow(portable.root, portable.cache, APP_VERSION, lspBridge, downloadService, stateStore);
                    _windowProjectMap.set(newWin.id, normalized);
                    _projectWindowMap.set(normalized, newWin.id);

                    const url = bootConfig.url + '?restore=1&folder=' + encodeURIComponent(normalized);
                    newWin.loadURL(url).then(() => {
                        if (!newWin.isDestroyed()) {
                            try {
                                if (w.bounds && typeof w.bounds.w === 'number') {
                                    if (w.bounds.maximized) { newWin.maximize(); }
                                    else { newWin.setBounds({ x: w.bounds.x || 0, y: w.bounds.y || 0, width: w.bounds.w, height: w.bounds.h }); }
                                }
                            } catch (_) { }
                            newWin.show();
                        }
                    }).catch((err: any) => {
                        console.warn('[restore] window loadURL failed:', err && err.message);
                        try { newWin.close(); } catch (_) { }
                    });
                    restored++;
                    // 短暂间隔防并发创建风暴
                    await new Promise(r => setTimeout(r, 300));
                }
                if (restored > 0) console.log('[restore] ' + restored + ' additional window(s) restored');
            }
        } catch (e) {
            console.warn('[restore] multi-window restore failed:', e);
        }
    })();

    // ★ 异步建语义索引（不阻塞启动）
    indexService.init();;

    // macOS: re-activate → recreate window
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createWindow(
                portable.root, portable.cache, APP_VERSION,
                lspBridge, downloadService, stateStore
            );
            bootSequence(
                mainWindow, bootConfig, portable.root, portable.cache,
                isDevFlag, isOfflineFlag, setLastBootMode, getLastBootMode
            );
        }
    });
});
