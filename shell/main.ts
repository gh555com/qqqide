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

import { app, BrowserWindow, dialog, protocol, nativeTheme, safeStorage, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ── 子模块 ──
import { loadBootConfig, extractFlags, bootSequence, getWebappBaseUrl, BootMode, BootConfig } from './boot';
import { APP_VERSION, checkForcedUpdate } from './version';
import { editorFontSize, createWindow, _windowProjectMap, _projectWindowMap } from './window-manager';
import { initAssetProtocol, hydrateAssetRootsFromState } from './asset-protocol';
import { registerFsIpc } from './ipc-fs';
import { registerBootIpc } from './ipc-boot';
import { registerAiToolsIpc } from './ipc-ai-tools';
import { registerSearchIpc } from './ipc-search';
import { registerEditIpc } from './ipc-edit';
import { registerMiscIpc } from './ipc-misc';
import { registerTimelineIpc } from './ipc-timeline';
import { registerGitDiffIpc } from './ipc-git-diff';
import { registerSmartSearchIpc, IndexService } from './ipc-smart-search';
import { registerStateHandlersIpc } from './ipc-state-handlers';
import { hardenSession, registerExitHandlers } from './shutdown';
import { checkRank0Components } from './component-checker';
import { startPyBroker, stopPyBroker } from './py-broker';
import { startGaeaProcess, stopGaeaProcess, isGaeaProcessRunning, getGaeaProcessPid, cleanupAllGaeaProcesses, startGaeaWatchdog, stopGaeaWatchdog, onGaeaProcessStatusChange, GaeaLifecycle } from './gaea-process';
import { setAuthPhone, setAuthToken } from './auth-state';
import { startWqPing, stopWqPing } from './wq-ping';

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

// ── F12 已由 before-input-event 拦截（window-manager.ts），此处无额外逻辑。
// DevTools 窗口标题改名：Electron 22 detached DevTools 不暴露 BrowserWindow 引用
// → 尝试记录见 do/解决开发者控制台 复制按钮问题 §尝试10-12。

function handleAuthProtocolUrl(url: string): void {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'auth') {
            const token = parsed.searchParams.get('token');
            const phone = parsed.searchParams.get('phone');
            const countryISO2 = parsed.searchParams.get('country_iso2') || '';
            const purchased = parsed.searchParams.get('purchased') === '1';
            const sessionId = parsed.searchParams.get('session') || '';
            if (token && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('qqqide-auth', { token, phone: phone || '', country_iso2: countryISO2, purchased: purchased, session_id: sessionId });
                console.log('[protocol] auth token pushed to renderer, phone=' + (phone || '?') + ' cc=' + countryISO2 + ' sid=' + (sessionId ? sessionId.slice(0,8) : '-'));
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
    registerGitDiffIpc(portable.root, bootConfig);
    registerSmartSearchIpc(indexService);
    registerStateHandlersIpc(stateStore, stateCloud, _projectStateStores, _qgfInstances, () => mainWindow);
    registerQzSpawnIpc(qzSpawn);
    registerGaeaProcessIpc();
    registerAuthPersistIpc();
}

// ── Auth 持久化 IPCPC — safeStorage 加密存盘，重启自动恢复（2026-06-29） ──
function registerAuthPersistIpc(): void {
    const AUTH_FILE = path.join(portable.userData, 'alphal', 'auth.enc');
    const PHONE_FILE = path.join(portable.userData, 'alphal', 'phone.txt'); // ★ 纯文本兜底，防 safeStorage DPAPI 跨目录失效

    ipcMain.handle('qqqide:auth:save', async (_e, auth: { token: string; phone: string; device_name?: string } | null) => {
        // ★ 无条件更新共享内存（不依赖 safeStorage，保证 wq-ping 能读到 doer_id）
        if (auth && auth.phone) setAuthPhone(auth.phone);
        if (auth && auth.token) setAuthToken(auth.token);
        // ★ 纯文本兜底：写 phone.txt（wq-ping 终极 fallback，不受 safeStorage/DPAPI 影响）
        if (auth && auth.phone) {
            try {
                const dir = path.dirname(PHONE_FILE);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(PHONE_FILE, auth.phone, 'utf8');
            } catch (_) { }
        }
        if (!auth || !auth.token || !safeStorage.isEncryptionAvailable()) return false;
        try {
            const encrypted = safeStorage.encryptString(JSON.stringify(auth));
            const dir = path.dirname(AUTH_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(AUTH_FILE, new Uint8Array(encrypted));
            // update shared memory for wq-ping readDoerID
            if (auth.phone) setAuthPhone(auth.phone);
            if (auth.token) setAuthToken(auth.token);
            return true;
        } catch (e) { return false; }
    });

    ipcMain.handle('qqqide:auth:load', async () => {
        if (!safeStorage.isEncryptionAvailable()) return null;
        try {
            if (!fs.existsSync(AUTH_FILE)) return null;
            const encrypted = fs.readFileSync(AUTH_FILE);
            const auth = JSON.parse(safeStorage.decryptString(encrypted));
            // update shared memory for wq-ping readDoerID
            if (auth && auth.phone) setAuthPhone(auth.phone);
            if (auth && auth.token) setAuthToken(auth.token);
            return auth;
        } catch (e) { return null; }
    });

    // ★ 轻量级 IPC：仅设置共享内存电话号，不依赖 safeStorage
    ipcMain.handle('qqqide:auth:set-phone', async (_e, phone: string) => {
        if (phone && /^\d{7,20}$/.test(phone)) { setAuthPhone(phone); return true; }
        return false;
    });

    ipcMain.handle('qqqide:auth:clear', async () => {
        try {
            if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
            // clear shared memory
            setAuthPhone(''); setAuthToken('');
            return true;
        } catch (e) { return false; }
    });
}

// ── Gaea Process IPC — 通用 gaea process-type goods 进程管理 ──
/** 出厂默认自动启动映射（首次安装时生效，用户勾选后持久化覆盖） */
const _PROCESS_GOODS_AUTOSTART_DEFAULTS: Record<string, boolean> = {
    'kope-a': true,
    'window-there': true,
};

function registerGaeaProcessIpc(): void {
    ipcMain.handle('qqqide:gaea-process:start', async (_e, goodsId: string, scriptPath: string, runtime?: string, lifecycle?: string, allowMultiple?: boolean) => {
        return startGaeaProcess(portable.root, goodsId, scriptPath, runtime || 'python', (lifecycle as GaeaLifecycle) || 'attached', allowMultiple !== false);
    });

    ipcMain.handle('qqqide:gaea-process:stop', async (_e, goodsId: string) => {
        return stopGaeaProcess(goodsId);
    });

    ipcMain.handle('qqqide:gaea-process:status', async (_e, goodsId: string) => {
        return { running: isGaeaProcessRunning(goodsId), pid: getGaeaProcessPid(goodsId) };
    });

    ipcMain.handle('qqqide:gaea-process:get-auto-start', async (_e, goodsId: string) => {
        try {
            const val = await stateStore.get('qqqide', goodsId + '.autoStart');
            if (val !== undefined && val !== null) return !!val;
            // 未设置（出厂）→ 查询默认值
            const def = _PROCESS_GOODS_AUTOSTART_DEFAULTS[goodsId];
            return def ?? false;
        } catch (e) { return false; }
    });

    ipcMain.handle('qqqide:gaea-process:set-auto-start', async (_e, goodsId: string, v: boolean, meta?: { scriptPath?: string; runtime?: string; lifecycle?: string; allowMultiple?: boolean }) => {
        try {
            await stateStore.setNow('qqqide', goodsId + '.autoStart', v);
            if (v && meta && meta.scriptPath) {
                // ★ check ON + not running → start immediately + watchdog
                const runtime = meta.runtime || 'python';
                const lifecycle = (meta.lifecycle as GaeaLifecycle) || 'attached';
                const allowMultiple = meta.allowMultiple !== false;
                const result = startGaeaProcess(portable.root, goodsId, meta.scriptPath, runtime, lifecycle, allowMultiple);
                if (result.ok) {
                    console.log('[' + goodsId + '] auto-start (via checkbox) pid=' + result.pid + (result.alreadyRunning ? ' (already running)' : ''));
                }
                if (!allowMultiple) {
                    startGaeaWatchdog(portable.root, goodsId, meta.scriptPath, runtime, lifecycle);
                }
            } else if (!v) {
                // ★ check OFF → stop watchdog (leave process running, user controls manually)
                stopGaeaWatchdog(goodsId);
            }
            return true;
        } catch (e) { return false; }
    });
}

// ── App 就绪 ── 就绪 ──
app.whenReady().then(async () => {
    // ★ If another instance already holds the lock, quit immediately — don't create windows
    if (_shouldQuitEarly) {
        app.quit();
        return;
    }

    // ★ 强制更新检查 — 版本过低时弹窗要求重新下载绿色包（2026-07-23）
    const forced = checkForcedUpdate();
    if (forced.required) {
        const DOWNLOAD_URL = 'https://gh555.com/qqqide/';
        const result = dialog.showMessageBoxSync({
            type: 'warning',
            title: 'qqqide — 需要更新',
            message: '您的 qqqide 版本过低，必须重新下载安装。',
            detail: [
                '当前版本: ' + forced.currentVersion,
                '最低要求: ' + forced.minVersion,
                '',
                '由于架构升级，旧版本无法通过自动更新完成升级。',
                '请前往下载页面获取最新绿色包。',
                '',
                '【安装方法】',
                '① 关闭 IDE',
                '② 下载最新绿色包（约 94MB）',
                '③ 直接解压覆盖到原位置即可（推荐）',
                '',
                '【偏好保留】',
                '项目数据（对话记录/设置）在项目文件夹的 qqq/ 目录下，',
                '覆盖安装不会丢失。登录状态和应用偏好需要重新设置。',
                '如需保留: 先备份 gh555.com\\Data\\alphal\\ 文件夹，',
                '安装并首次运行后再复制回去。',
                '',
                '【干净安装】',
                '删除旧的 qqqide-win-x64 文件夹 → 解压新绿色包即可。',
            ].join('\n'),
            buttons: ['前往下载', '退出'],
            defaultId: 0,
            cancelId: 1,
        });
        if (result === 0) {
            shell.openExternal(DOWNLOAD_URL);
        }
        app.quit();
        return;
    }

    // Force light theme
    nativeTheme.themeSource = 'light';

    // Init asset protocol + roots
    initAssetProtocol(portable.root, portable.cache, portable.userData);

    // Register shell state (must be before hydrateAssetRootsFromState — needs qqqide ns)
    registerShellState();

    await hydrateAssetRootsFromState(stateStore);

    // Security hardening
    hardenSession();

    // ★ 组件自检: 缺了 rank0 组件自动后台下载（不阻塞启动）
    checkRank0Components(portable.root);

    // ★ Python broker: 仅当已安装时启动（未安装则下次启动自动下载后再启）
    startPyBroker(portable.root);

    // ★ Gaea process auto-start: 遍历所有注册的 process-type goods
    (async () => {
        try {
            const processGoods = [
                { id: 'kope-a', script: 'goods/kope-a/q3.py', runtime: 'python', lifecycle: 'independent' as GaeaLifecycle, allowMultiple: false, defaultAutoStart: true },
                { id: 'window-there', script: 'goods/window-there/q3.py', runtime: 'python', lifecycle: 'attached' as GaeaLifecycle, allowMultiple: false, defaultAutoStart: true },
            ];
            for (const g of processGoods) {
                try {
                    const autoStart = await stateStore.get('qqqide', g.id + '.autoStart');
                    if (autoStart ?? g.defaultAutoStart) {
                        const result = startGaeaProcess(portable.root, g.id, g.script, g.runtime, g.lifecycle, g.allowMultiple);
                        if (result.ok) {
                            console.log('[' + g.id + '] auto-started pid=' + result.pid + (result.alreadyRunning ? ' (already running)' : ''));
                        } else {
                            console.log('[' + g.id + '] auto-start failed:', result.error);
                        }
                        // ★ 单例 goods: 启动看门狗，进程死亡自动拉起
                        if (!g.allowMultiple) {
                            startGaeaWatchdog(portable.root, g.id, g.script, g.runtime, g.lifecycle);
                        }
                    }
                } catch (e) { /* skip this goods */ }
            }
        } catch (e) { /* ignore */ }
    })();

    // Create main windowdow
    mainWindow = createWindow(
        portable.root, portable.cache, APP_VERSION,
        lspBridge, downloadService, stateStore
    );

    // ★ Gaea process 状态变更 → 推送给渲染层（事件驱动，非轮询）
    onGaeaProcessStatusChange((goodsId, running, pid) => {
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) {
                w.webContents.send('qqqide:gaea-process:status-changed', { goodsId, running, pid });
            }
        });
    });

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
        try { cleanupAllGaeaProcesses(); } catch { /* ignore */ }
        try { stopWqPing(); } catch { /* ignore */ }
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

                    const baseUrl = getWebappBaseUrl(portable.root, bootConfig, isDevFlag);
                    const url = baseUrl + '?restore=1&folder=' + encodeURIComponent(normalized);
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

    // Preload phone from auth.enc into shared memory (for wq-ping readDoerID)
    // Avoids safeStorage(DPAPI) failures across install directory migration
    (function preloadAuthPhone() {
        try {
            // ★ 路径1：safeStorage 解密 auth.enc（主路径）
            if (safeStorage.isEncryptionAvailable()) {
                const authFile = path.join(portable.userData, 'alphal', 'auth.enc');
                if (fs.existsSync(authFile)) {
                    const encrypted = fs.readFileSync(authFile);
                    const auth = JSON.parse(safeStorage.decryptString(encrypted));
                    if (auth && auth.phone) { setAuthPhone(auth.phone); return; }
                    if (auth && auth.token) setAuthToken(auth.token);
                }
            }
        } catch (_) { /* safeStorage might fail across install migration */ }
        // ★ 路径2：纯文本 phone.txt 兜底（防 DPAPI 跨目录/跨用户失效）
        try {
            const phoneFile = path.join(portable.userData, 'alphal', 'phone.txt');
            if (fs.existsSync(phoneFile)) {
                const phone = fs.readFileSync(phoneFile, 'utf8').trim();
                if (phone && /^\d{7,20}$/.test(phone)) setAuthPhone(phone);
            }
        } catch (_) { }
    })();

    // ★ ping reporter (non-blocking, first ping with 30-120s random delay)
    startWqPing(portable.userData);

    // ★ rebuild semantic search index (non-blocking)
    indexService.init();

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
