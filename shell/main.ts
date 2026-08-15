// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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
import { claimProject, registerProjectLockIpc } from './project-lock';
import { initAssetProtocol, hydrateAssetRootsFromState } from './asset-protocol';
import { registerFsIpc } from './ipc-fs';
import { registerBootIpc } from './ipc-boot';
import { registerAiToolsIpc } from './ipc-ai-tools';
import { registerSearchIpc } from './ipc-search';
import { registerEditIpc } from './ipc-edit';
import { registerMiscIpc } from './ipc-misc';
import { registerMediaIpc } from './ipc-media';
import { registerTimelineIpc } from './ipc-timeline';
import { registerGitDiffIpc } from './ipc-git-diff';
import { registerSmartSearchIpc, IndexService } from './ipc-smart-search';
import { registerStateHandlersIpc } from './ipc-state-handlers';
import { hardenSession, registerExitHandlers } from './shutdown';
import { crashNetInit } from './crash-net';
import { checkRank0Components } from './component-checker';
import { startPyBroker, stopPyBroker, setPyBrokerEventHandler } from './py-broker';
import { startGaeaProcess, stopGaeaProcess, isGaeaProcessRunning, getGaeaProcessPid, cleanupAllGaeaProcesses, startGaeaWatchdog, stopGaeaWatchdog, onGaeaProcessStatusChange, setGaeaUserDataPath, registerGoodsMeta, GaeaLifecycle, syncOsGaeaAutoStart, getOsGaeaAutoStart, getOsGaeaFullState, getGoodsSetting, setGoodsSetting, getAllGoodsSettings, startOsStateWatch } from './gaea-process';
import { registerKopeIpc } from './ipc-kope';
import { registerRoamIpc } from './ipc-roam';
import { registerAiStateIpc } from './ipc-ai-state';
import { registerWsStateIpc, wsStateGetKey } from './ipc-ws-state';
import { registerSearchStateIpc } from './ipc-search-state';
import { registerKmdIpc } from './ipc-kmd';

import { setAuthPhone, setAuthToken } from './auth-state';
import { startWqPing, stopWqPing, notifyAuthReady } from './wq-ping';
import { initAuthBrain, registerAuthBrainIpc, getAuthBrain } from './auth-brain';

// ── 服务 ──

import { AudioEngine } from './audio-engine';
import { registerAudioIpc, playSfxFile } from './ipc-audio';
import { registerSquadIpc } from './ipc-squads';
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
    const ok = app.setAsDefaultProtocolClient('qqqide');
    console.log('[protocol] setAsDefaultProtocolClient (packaged) → ' + (ok ? 'OK' : 'FAILED'));
} else {
    const ok = app.setAsDefaultProtocolClient('qqqide', process.execPath, [app.getAppPath()]);
    console.log('[protocol] setAsDefaultProtocolClient (dev, execPath=' + process.execPath + ') → ' + (ok ? 'OK' : 'FAILED'));
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
    } else if (_url.includes('gh555.com')) {
        // gh555.com / cnk.gh555.com — Cloudflare 证书，但也可能在 dev 环境
        // 被 sp_tunnel 代理拦截导致 CN 不匹配，统一放行
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});

// ── 自定义协议 qqqide:// — 外部浏览器登录回调（2026-07-31 T6 主通道） ──
app.on('second-instance', (_event, argv) => {
    console.log('[protocol] second-instance fired, argv count=' + argv.length);
    const url = argv.find((a: string) => a.startsWith('qqqide://'));
    console.log('[protocol] second-instance url=' + (url || 'NONE'));
    if (url) handleLegacyAuthProtocolUrl(url);
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('open-url', (event, url) => {
    event.preventDefault();
    console.log('[protocol] open-url fired, url=' + url);
    handleLegacyAuthProtocolUrl(url);
});

function handleLegacyAuthProtocolUrl(url: string): void {
    console.log('[protocol] handleLegacyAuthProtocolUrl: ' + url);
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'auth') {
            const token = parsed.searchParams.get('token');
            const phone = parsed.searchParams.get('phone') || '';
            const countryISO2 = parsed.searchParams.get('country_iso2') || '';
            const purchased = parsed.searchParams.get('purchased') === '1';
            console.log('[protocol] parsed: token=' + (token ? token.slice(0, 8) + '...' : 'MISSING') + ' phone=' + phone.slice(-4));
            if (token) {
                authBrain.setAuth(token, phone, countryISO2, purchased);
                setAuthPhone(phone);
                setAuthToken(token);
                notifyAuthReady();
                console.log('[protocol] auth saved via legacy path, phone=' + phone.slice(-4));
            }
        } else {
            console.log('[protocol] hostname is not "auth": ' + parsed.hostname);
        }
    } catch (e) {
        console.warn('[protocol] bad auth url:', e);
    }
}

function checkStartupAuthUrl(): void {
    const url = process.argv.find((a: string) => a.startsWith('qqqide://'));
    console.log('[protocol] checkStartupAuthUrl: ' + (url || 'none'));
    if (url) handleLegacyAuthProtocolUrl(url);
}

// ── 启动配置 + 标志 ──
const bootConfig: BootConfig = loadBootConfig(portable.root);
const { isOffline: isOfflineFlag, isDev: isDevFlag } = extractFlags();

// ── 单例服务 ──

const audioEngine = new AudioEngine(portable.root);
// ★ 退出兜底: 最后一个窗口不一定是第一个窗口(mainWindow closed 路径可能永不触发)
//   before-quit 统一兜底停音频引擎 — 幂等(已停则 no-op), 覆盖全部退出路径
app.on('before-quit', () => { try { audioEngine.stop(); } catch { /* ignore */ } });
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


const indexService = new IndexService(portable.root);

// ── 认证中心大脑（2026-07-31 T3）──
const authBrain = initAuthBrain(portable.userData, portable.root, APP_VERSION, isDevFlag);

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
    { scheme: 'qqqide', privileges: { standard: true, secure: true, supportFetchAPI: true } },
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
        () => lastBootMode,
        () => mainWindow
    );
    registerMiscIpc(
        portable.root, portable.cache, APP_VERSION, isDevFlag,
        lspBridge, downloadService, stateStore,
        () => mainWindow, bootConfig,  // lspBridge=null (LSP OFF)
        hashService, cacheStore
    );
    registerTimelineIpc(portable.root, bootConfig);
    registerGitDiffIpc(portable.root, bootConfig);
    registerSmartSearchIpc(indexService);
    registerStateHandlersIpc(stateStore, stateCloud, _projectStateStores, _qgfInstances, () => mainWindow);
    registerAudioIpc(audioEngine, portable.root);
    registerQzSpawnIpc(qzSpawn);
    registerRoamIpc();
    registerAiStateIpc();
    registerWsStateIpc();
    registerSearchStateIpc();
    registerKopeIpc();
    registerKmdIpc(portable.root);
    registerGaeaProcessIpc();
    registerMediaIpc(mediaService);
    registerAuthBrainIpc(getAuthBrain());
    registerDesktopShortcutIpc();
    registerSquadIpc();
    registerProjectLockIpc();
}

// ── 桌面快捷方式 IPC — PowerShell COM 创建/删除 .lnk（2026-07-28 v2 修复路径） ──
function registerDesktopShortcutIpc(): void {
    ipcMain.handle('qqqide:desktop:sync-shortcut', async (_e, enabled: boolean) => {
        if (process.platform !== 'win32') return { ok: true, skipped: true };
        try {
            // ★ 双位置：桌面 + 开始菜单（Win11 无桌面图标用户走开始菜单）
            const lnkPaths = [
                path.join(os.homedir(), 'Desktop', 'qqqide.lnk'),
                path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'qqqide.lnk')
            ];

            // ★ portable.root 在打包模式下 = gh555.com/，qqqide.exe 在上层
            //    开发模式下 portable.root = 项目根，qqqide.exe 就在下面
            let targetExe = path.join(portable.root, 'qqqide.exe');
            let rootDir = portable.root;
            if (!fs.existsSync(targetExe)) {
                // 打包模式：往上找
                rootDir = path.dirname(portable.root);
                targetExe = path.join(rootDir, 'qqqide.exe');
            }
            if (!fs.existsSync(targetExe)) return { ok: true, skipped: true, reason: 'no-qqqide-exe' };

            // ★ 图标：优先用 joker.exe,0（electron-builder 保证有图标）
            //    开发模式 fallback → shell/icon.ico → targetExe 自身
            let iconLocation = '';
            const jokerExe = path.join(portable.root, 'joker.exe');
            if (fs.existsSync(jokerExe)) {
                iconLocation = jokerExe + ',0';
            } else {
                const icoPath = path.join(portable.root, 'shell', 'icon.ico');
                if (fs.existsSync(icoPath)) {
                    iconLocation = icoPath;
                } else {
                    iconLocation = targetExe + ',0';
                }
            }

            if (enabled) {
                // 创建/更新快捷方式（桌面 + 开始菜单 Programs 根 = Win11「所有应用」最显著层）
                // ★ PS 单引号字符串内反斜杠为字面量 → 直接用单斜杠路径，禁止双写（双斜杠会写进 .lnk 的 WorkDir）
                //   唯一需要转义的是单引号（路径含 ' 时 → '' 为 PS 转义）
                const psQ = (s: string) => s.replace(/'/g, "''");
                const parts = [
                    '$ws = New-Object -ComObject WScript.Shell;'
                ];
                for (const lnkPath of lnkPaths) {
                    // 父目录不存在则跳过（如无桌面目录的改造型 Win11）
                    if (!fs.existsSync(path.dirname(lnkPath))) continue;
                    parts.push(
                        '$s = $ws.CreateShortcut(\'' + psQ(lnkPath) + '\');',
                        '$s.TargetPath = \'' + psQ(targetExe) + '\';',
                        '$s.WorkingDirectory = \'' + psQ(rootDir) + '\';',
                        '$s.IconLocation = \'' + psQ(iconLocation) + '\';',
                        '$s.Save();'
                    );
                }
                require('child_process').execSync(
                    'powershell -NoProfile -Command "' + parts.join(' ') + '"',
                    { timeout: 15000, windowsHide: true }
                );
                return { ok: true, action: 'created' };
            } else {
                // 关闭时不删除 — 用户可自行手动删除
                return { ok: true, action: 'skipped' };
            }
        } catch (e: any) {
            return { ok: false, error: e && e.message };
        }
    });
}

// ── Gaea Process IPC — 通用 gaea process-type goods 进程管理 ──
/** 出厂默认自动启动映射（首次安装时生效，用户勾选后持久化覆盖） */
const _PROCESS_GOODS_AUTOSTART_DEFAULTS: Record<string, boolean> = {
    'kope-a': false,       // 出厂关闭（2026-08-12: 与 window-there 对齐，全部默认关闭）
    'window-there': false, // 出厂关闭
};

function registerGaeaProcessIpc(): void {
    // ★ 初始化跨窗口状态检测基础
    setGaeaUserDataPath(portable.userData);
    registerGoodsMeta('kope-a', false);
    registerGoodsMeta('window-there', false);
    // ★ OS 级状态文件监听：跨 IDE 实例启停 → 外观秒同步（2026-08-06）
    startOsStateWatch('kope-a');
    startOsStateWatch('window-there');

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
            // ★ OS 级状态为唯一真理（跨绿色包/跨窗口同步），本地 DB 仅作降级
            const osVal = getOsGaeaAutoStart(goodsId);
            if (osVal !== null) return osVal;
            const val = await stateStore.get('qqqide', goodsId + '.autoStart');
            if (val !== undefined && val !== null) return !!val;
            // 都未设置 → 出厂默认值
            const def = _PROCESS_GOODS_AUTOSTART_DEFAULTS[goodsId];
            return def ?? false;
        } catch (e) { return false; }
    });

    ipcMain.handle('qqqide:gaea-process:set-auto-start', async (_e, goodsId: string, v: boolean, meta?: { scriptPath?: string; runtime?: string; lifecycle?: string; allowMultiple?: boolean }) => {
        try {
            // ★ 最终意图写入顺序（F118）: OS 级状态文件（同步 fs，永不失败）先写，
            //   本地 DB 仅降级兜底（DB 失败绝不阻断意图落盘）
            syncOsGaeaAutoStart(goodsId, v);
            try { await stateStore.setNow('qqqide', goodsId + '.autoStart', v); } catch (e) { /* 降级可用 */ }
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

    // ★ Goods 设置（OS 级持久化，跨绿色包）
    ipcMain.handle('qqqide:gaea-process:get-settings', async (_e, goodsId: string) => {
        return getAllGoodsSettings(goodsId);
    });

    ipcMain.handle('qqqide:gaea-process:set-setting', async (_e, goodsId: string, key: string, value: any) => {
        setGoodsSetting(goodsId, key, value);
        return true;
    });
}

// ── App 就绪 ── 就绪 ──
app.whenReady().then(async () => {
    // ★ 天罗地网: 必须在任何窗口/服务之前初始化 — 崩溃记录网络 (2026-08-08 F14)
    try { crashNetInit(portable.userData); } catch (e) { try { console.warn('[crash-net] init failed:', e); } catch (_) { } }

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

    // ★ 编队热键事件（py-broker 常驻 pynput 监听 Space+key）→ 召回成功播放 kj3 音效
    setPyBrokerEventHandler((ev: any) => {
        if (!ev || ev.event !== 'summon') { return; }
        try { console.log('[squad] summon', ev.squad, ev.ok ? 'OK' : 'miss', ev.folder || ''); } catch { /* ignore */ }
        if (ev.ok) {
            try { playSfxFile(audioEngine, portable.root, 'yz:kj3.mp3'); } catch (e) {}
        }
    });

    // ★ Gaea process auto-start: 遍历所有注册的 process-type goods
    (async () => {
        try {
            const processGoods = [
                { id: 'kope-a', script: 'goods/kope-a/q3.py', runtime: 'python', lifecycle: 'independent' as GaeaLifecycle, allowMultiple: false, defaultAutoStart: false },
                { id: 'window-there', script: 'goods/window-there/q3.py', runtime: 'python', lifecycle: 'attached' as GaeaLifecycle, allowMultiple: false, defaultAutoStart: false },
            ];
            for (const g of processGoods) {
                try {
                    // ★ 启动决策同 get-auto-start 优先级：OS 级状态 → 本地 DB → 出厂默认
                    const osVal = getOsGaeaAutoStart(g.id);
                    let autoStart: boolean | null = null;
                    if (osVal !== null) autoStart = osVal;
                    else autoStart = await stateStore.get('qqqide', g.id + '.autoStart');
                    // ★ 最终意图 = autoStart（OS 级，任一窗口最后一次人工操作）
                    const intent = autoStart ?? g.defaultAutoStart;
                    // ★ 会话恢复（2026-08-09）: 上次退出时该 goods 正在运行（attached）→ 本次启动恢复运行
                    const osFull = getOsGaeaFullState(g.id);
                    const runningAtExit = !!(osFull && osFull.runningAtExit);
                    if (intent || runningAtExit) {
                        const result = startGaeaProcess(portable.root, g.id, g.script, g.runtime, g.lifecycle, g.allowMultiple);
                        if (result.ok) {
                            console.log('[' + g.id + '] auto-started pid=' + result.pid + (result.alreadyRunning ? ' (already running)' : ''));
                        } else {
                            console.log('[' + g.id + '] auto-start failed:', result.error);
                        }
                        // ★ 看门狗只服从最终意图(autoStart=true)（F118）:
                        //   runningAtExit 会话恢复不武装看门狗 → 否则 toggle 灰 + ● 停止后仍被拉起
                        if (!g.allowMultiple && intent) {
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

    // ★ 主窗口关闭：不再连带销毁其他项目窗口（多窗口相互独立，2026-08-08 修复全窗关闭事故）
    //   音频/gaea/ping 清理仅在最后一个窗口关闭时执行（window-all-closed → quit 同刻）
    mainWindow.on('closed', () => {
        mainWindow = null;
        const alive = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
        if (alive.length === 0) {
            try { audioEngine.stop(); } catch { /* ignore */ }
            try { cleanupAllGaeaProcesses(); } catch { /* ignore */ }
            try { stopWqPing(); } catch { /* ignore */ }
        }
    });

    // Register IPC (after window exists)
    registerAllIpc();

    // ★ 音频引擎预启动 — 消灭首响延迟（懒启动 Python ~200ms 是慢半拍的第一层）
    audioEngine.ensure().catch(() => { /* 组件缺失时静默 */ });

    // Register exit handlers
    registerExitHandlers(portable.root, portable.logs, stateStore, bootConfig, _qgfInstances);

    // Boot
    // ★ 多窗口还原 — 第一步：确保主窗口加载正确的项目文件夹
    //   恢复链: 绿色包级 global.sq3 → OS 级 ws.sq3（2026-08-09 删包/换包后 OS 兜底）
    const readOpenWindows = async (): Promise<any[]> => {
        try {
            let v: any = await stateStore.get('qqqide', 'open_windows');
            if (!v) { try { v = await wsStateGetKey('openWindows'); } catch { /* ignore */ } }
            return (v && Array.isArray(v)) ? v : [];
        } catch { return []; }
    };
    try {
        const openWindows = await readOpenWindows();
        if (openWindows && openWindows.length > 0) {
            const w0 = openWindows[0];
            if (w0 && w0.mainFolder) {
                const n0 = w0.mainFolder.replace(/\\/g, '/').replace(/\/$/, '');
                if (n0) {
                    // ★ 项目锁仲裁（2026-08-10 冠军架构）：恢复前 claim，被其他实例占用 →
                    //   不注入 folder（空白窗口），绝不复现 dev+绿色包双开同一项目
                    const claimRes = claimProject(mainWindow.id, n0);
                    if (claimRes.ok) {
                        // ★ 注入主窗口 URL — 必须在 loadURL 之前
                        const sep = bootConfig.url.includes('?') ? '&' : '?';
                        bootConfig.url = bootConfig.url + sep + 'restore=1&folder=' + encodeURIComponent(n0);
                        // ★ 预注册，防止 restore 阶段重复创建
                        _windowProjectMap.set(mainWindow.id, n0);
                        _projectWindowMap.set(n0, mainWindow.id);
                    } else {
                        console.warn('[restore] main project locked by another instance, opening blank window:', n0, 'reason=' + claimRes.reason);
                    }
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
            const openWindows = await readOpenWindows();
            if (openWindows && openWindows.length > 1) {
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
                    // ★ 路径不存在 → 跳过（项目可能已被删除或移动）
                    if (!fs.existsSync(normalized)) { console.warn('[restore] skip missing project:', normalized); continue; }
                    // 已在其他窗口打开 → 跳过
                    if (_projectWindowMap.has(normalized)) continue;

                    const newWin = createWindow(portable.root, portable.cache, APP_VERSION, lspBridge, downloadService, stateStore);
                    // ★ 项目锁仲裁：被其他实例占用 → 不还原该窗口（destroy 未加载窗口，零副作用）
                    const claimRes = claimProject(newWin.id, normalized);
                    if (!claimRes.ok) {
                        console.warn('[restore] skip window, project locked by another instance:', normalized, 'reason=' + claimRes.reason);
                        try { newWin.destroy(); } catch (_) { }
                        continue;
                    }
                    // ★ 每窗口翼状态覆盖值 → restoreWindowBounds 优先采纳（多窗口各自还原自己的翼）
                    (newWin as any).__qqqRestoreWings = w.wings || null;
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
                        // ★ 清理地图条目，否则陈旧条目会阻止合法的后续还原
                        _windowProjectMap.delete(newWin.id);
                        _projectWindowMap.delete(normalized);
                        try { newWin.close(); } catch (_) { }
                    });
                    restored++;
                    // ★ 间隔延长到 500ms，给前一个窗口的 kope-a/goods 进程足够启动时间
                    await new Promise(r => setTimeout(r, 500));
                }
                if (restored > 0) console.log('[restore] ' + restored + ' additional window(s) restored');
            }
        } catch (e) {
            console.warn('[restore] multi-window restore failed:', e);
        }
    })();

    // ★ 认证中心大脑恢复登录态（2026-07-31 T3）
    // auth-brain.restore() 内建 safeStorage + phone.txt 双路径兜底
    authBrain.restore().then((restored: boolean) => {
        if (restored) {
            // 同步到旧 auth-state（wq-ping 兼容）
            setAuthPhone(authBrain.phone);
            setAuthToken(authBrain.token);
            notifyAuthReady();
        }
    });

    // ★ ping reporter (non-blocking, first ping with 30-120s random delay)
    try {
        const bootLogPath = path.join(portable.userData, 'alphal', 'wq-ping.log');
        fs.mkdirSync(path.dirname(bootLogPath), { recursive: true });
        fs.appendFileSync(bootLogPath, new Date().toISOString() + ' [main.ts] calling startWqPing userData=' + portable.userData + '\n');
    } catch (_) { }
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
