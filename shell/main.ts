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

import { app, BrowserWindow, protocol, nativeTheme } from 'electron';
import * as path from 'path';
import * as os from 'os';

// ── 子模块 ──
import { loadBootConfig, extractFlags, bootSequence, BootMode, BootConfig } from './boot';
import { initZoom, hydrateZoomFromState, saveZoom, zoomFactor, createWindow, _windowProjectMap, _projectWindowMap } from './window-manager';
import { initAssetProtocol, hydrateAssetRootsFromState } from './asset-protocol';
import { registerFsIpc } from './ipc-fs';
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
import { LspBridge } from './lsp-bridge';
import { CacheStore } from './cache-store';
import { HashService } from './hash-service';
import { MediaService } from './media-service';
import { StateStore } from './state-sqlite';
import { StateCloud } from './state-cloud';
import { Qgf } from './qgf';
import { DownloadService } from './download-service';
import { UpdateService } from './update-service';

// ── Chromium flags (必须在 app.whenReady() 前) ──
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('forced-colors', 'none');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'ForcedColors,AutoDarkMode');

// ── 自签名证书信任（自建 Nginx 用自签 SSL，必须放行） ──
app.on('certificate-error', (event, _webContents, _url, _error, certificate, callback) => {
    // 信任 direct.gh555.com 域名下任何证书（自签 / 过期都过）
    if (certificate && certificate.issuerName && certificate.issuerName.includes('gh555')) {
        event.preventDefault();
        callback(true);
    } else if (_url.includes('direct.gh555.com')) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});

// ── 启动配置 + 标志 ──
const bootConfig: BootConfig = loadBootConfig(portable.root);
const { isOffline: isOfflineFlag, isDev: isDevFlag } = extractFlags();
const APP_VERSION = '0.0.2';

// ── 单例服务 ──
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
        bootConfig, lspBridge, downloadService, stateStore,
        updateService, () => mainWindow
    );
    registerTimelineIpc(portable.root, bootConfig);
    registerSmartSearchIpc(indexService);
    registerStateHandlersIpc(stateStore, stateCloud, _projectStateStores, _qgfInstances, () => mainWindow);
    registerQzSpawnIpc(qzSpawn);
}

// ── App 就绪 ──
app.whenReady().then(async () => {
    // Force light theme
    nativeTheme.themeSource = 'light';

    // Init asset protocol + roots
    initAssetProtocol(portable.root, portable.cache, portable.userData);
    await hydrateAssetRootsFromState(stateStore);

    // Init zoom
    initZoom(portable.root, stateStore);
    await hydrateZoomFromState(stateStore);

    // Register shell state
    registerShellState();

    // Security hardening
    hardenSession();

    // Create main window
    mainWindow = createWindow(
        portable.root, portable.cache, APP_VERSION, isDevFlag,
        lspBridge, downloadService, stateStore
    );

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
    await bootSequence(
        mainWindow, bootConfig, portable.root, portable.cache,
        isDevFlag, isOfflineFlag, setLastBootMode, getLastBootMode
    );

    // ★ 异步建语义索引（不阻塞启动）
    indexService.init();

    // macOS: re-activate → recreate window
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createWindow(
                portable.root, portable.cache, APP_VERSION, isDevFlag,
                lspBridge, downloadService, stateStore
            );
            bootSequence(
                mainWindow, bootConfig, portable.root, portable.cache,
                isDevFlag, isOfflineFlag, setLastBootMode, getLastBootMode
            );
        }
    });
});
