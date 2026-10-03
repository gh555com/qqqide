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
// ★ 播放器宿主域（--qqqide-play）：独立 userData（Data/player-host）→ 独立 SingletonLock，
//   与 IDE 域互不夺锁（双击媒体/IDE 转发均可直启；详 shell/player-host.ts）
const _playHostMode = process.argv.some((a: string) => a === '--qqqide-play' || a.indexOf('--qqqide-play=') === 0);
const portable = applyPortablePaths(_playHostMode ? { sessionDir: 'player-host' } : undefined);

import { app, BrowserWindow, dialog, protocol, nativeTheme, safeStorage, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ── 子模块 ──
import { loadBootConfig, extractFlags, bootSequence, getWebappBaseUrl, ensureLocalWebapp, onUiReady, scheduleOldSlotCleanup, BootMode, BootConfig } from './boot';
import { initMainI18n, refreshMainI18nLang, mi } from './main-i18n';
import { APP_VERSION, checkForcedUpdate } from './version';
import { editorFontSize, setEditorFontSize, createWindow, _windowProjectMap, _projectWindowMap, recordWindowOpen, setPackRoot, packWsKey } from './window-manager';
import { claimProject, registerProjectLockIpc } from './project-lock';
import { initAssetProtocol, hydrateAssetRootsFromState } from './asset-protocol';
import { registerFsIpc } from './ipc-fs';
import { registerBootIpc } from './ipc-boot';
import { registerAiToolsIpc } from './ipc-ai-tools';
import { registerSearchIpc } from './ipc-search';
import { registerEditIpc } from './ipc-edit';
import { registerMiscIpc } from './ipc-misc';
import { registerMediaIpc } from './ipc-media';
import { registerPlayerIpc, kickPlayerHostForRestore, noteHostAllWindowsClosed } from './ipc-player';
import { parsePlayFiles, ingestExternalFiles, injectHostRuntimePath, registerHostShellIpc, startIdeKeepalive, filesToItems, queuePlayerRequest, ensureIdeInstance, startIdeRevealWatch } from './player-host';
import { registerFileAssocIpc } from './ipc-fileassoc';
import { registerExportIpc } from './ipc-export';
import { registerTimelineIpc } from './ipc-timeline';
import { registerGitDiffIpc } from './ipc-git-diff';
import { registerSmartSearchIpc, IndexService } from './ipc-smart-search';
import { registerStateHandlersIpc } from './ipc-state-handlers';
import { hardenSession, registerExitHandlers, hardenWebContents } from './shutdown';
import { crashNetInit } from './crash-net';
import { isSmokeMode, runSmoke, smokeFailFast } from './smoke';
import { memMeterInit } from './mem-meter';
import { checkRank0Components } from './component-checker';
import { startPyBroker, stopPyBroker, setPyBrokerEventHandler } from './py-broker';
import { startGaeaProcess, stopGaeaProcess, isGaeaProcessRunning, getGaeaProcessPid, cleanupAllGaeaProcesses, startGaeaWatchdog, stopGaeaWatchdog, onGaeaProcessStatusChange, setGaeaUserDataPath, registerGoodsMeta, GaeaLifecycle, syncOsGaeaAutoStart, getOsGaeaAutoStart, getOsGaeaFullState, getGoodsSetting, setGoodsSetting, getAllGoodsSettings, startOsStateWatch } from './gaea-process';
import { registerKopeIpc, kopeWarmup } from './ipc-kope';
import { registerVigIpc } from './ipc-vig';
import { vigFlush, vigSquadSummon, vigStartFloorsSeed } from './vig';
import { registerRoamIpc } from './ipc-roam';
import { registerAiStateIpc } from './ipc-ai-state';
import { registerWsStateIpc, wsStateGetKey } from './ipc-ws-state';
import { registerSearchStateIpc } from './ipc-search-state';
import { registerKmdIpc } from './ipc-kmd';
import { registerQmdIpc } from './ipc-qmd';
import { registerSysPyIpc } from './ipc-syspy';
import { initUiZoom, registerUiZoomIpc } from './ui-zoom';

import { setAuthPhone, setAuthToken } from './auth-state';
import { startWqPing, stopWqPing, notifyAuthReady, setCurrentlyPlaying, triggerPlayingPing, setWqPingStateStore } from './wq-ping';
import { initAuthBrain, registerAuthBrainIpc, getAuthBrain } from './auth-brain';
import { startAutoUpdater } from './auto-updater';
import { registerUpdateHealthIpc } from './update-health';
import { startMacUpdater, registerMacUpdateIpc, maybeAutoApplyOnQuit } from './mac-updater';

// ── 服务 ──

import { AudioEngine } from './audio-engine';
import { registerAudioIpc, playSfxFile } from './ipc-audio';
import { registerSquadIpc } from './ipc-squads';
import { focusWindowBySlot } from './squad-manager';
import { registerSecureIpc } from './ipc-secure';
import { applyMenuSchema, MenuSchema } from './menu-builder';
import { MonacoHost } from './monaco-host';
import { QzSpawn, registerQzSpawnIpc } from './qz-spawn';
import { CacheStore } from './cache-store';
import { HashService } from './hash-service';
import { MediaService } from './media-service';
import { ExportService } from './export-service';
import { StateStore } from './state-sqlite';
import { StateCloud } from './state-cloud';
import { registerUserDataIpc } from './user-data-sync';
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
// ★ disable-features 唯一入口 = portable-paths.ts（applyPortablePaths 单一清单，2026-10-02 F61）——
//   实测同一 switch 重复 append 仅末值生效（前清单整份静默丢弃），此处禁再追加；ForcedColors/
//   AutoDarkMode/WinUseBrowserSpellChecker 等已并入那边唯一清单。
// ★ Windows 显示缩放无关（恒 100%）：强制 device scale factor = 1 —— 无视系统「显示缩放」百分比，
//   1 DIP = 1 物理像素 → 逻辑空间 = 物理分辨率（小逻辑屏下三面板可开 + 同屏行数最大化）。
//   必须在 app.whenReady() 前；仅 win32（mac Retina 缩放语义不同，不适用）。
if (process.platform === 'win32') {
    app.commandLine.appendSwitch('force-device-scale-factor', '1');
}
// ★ CDP devtools capture: 克隆 DevTools 另存为 100% 输出（Log.entryAdded）
//   多实例/快速重启并存时 8315 易被占（含死进程幽灵套接字——句柄继承致监听残留）——
//   后启动实例调试口静默失效（bind 失败不报错）。
//   IDE（含打包）从 8315 起探首个空闲口；宿主从 8316 起（8315 恒保留 IDE）。
//   实际端口 = global.__qqqCdpPort（单点——_setupCdpConsoleCapture 消费，禁再硬编码）。
// ★ 监听口快照（跨平台，2026-10-02 F53 mac 移植）：Windows = netstat -ano（":PORT" 格式）；
//   mac/linux = lsof（BSD netstat 的端口格式为 ".PORT"，与原正则不通用——恒探测失败 → 宿主/多实例右移失效）；
//   探测失败一律返回空串（视作全空闲 → 保持默认 8315，与旧行为一致）。
const _listenSnapshot = (): string => {
    try {
        const cp = require('child_process');
        if (process.platform === 'win32') {
            return cp.execSync('netstat -ano', { encoding: 'utf8', timeout: 3000, windowsHide: true });
        }
        try {
            return cp.execSync('lsof -nP -iTCP -sTCP:LISTEN', { encoding: 'utf8', timeout: 4000 });
        } catch (e: any) { return (e && e.stdout) ? String(e.stdout) : ''; }   // lsof 无监听 = exit 1 零输出
    } catch { return ''; }
};
let _cdpPort = '8315';
if (_playHostMode) {
    // ★ 播放器宿主域（2026-10-02）：8315 恒保留给 IDE（_setupCdpConsoleCapture 依赖）——宿主从 8316 起探首个空闲口。
    //   旧行为：宿主打包版也钉 8315 → 与在跑 IDE 冲突 → devtools 恒启动失败（bind 报错刷屏、宿主全盲）。
    const _ns = _listenSnapshot();
    for (let _p = 8316; _p <= 8324; _p++) {
        if (!new RegExp(':' + _p + '(\\s|$)').test(_ns)) { _cdpPort = String(_p); break; }
    }
} else {
    // ★ 打包版也探测（2026-10-02 实锤：快速重启/多实例并存时 8315 被占或幽灵残留 → 恒 8315 = 整会话无调试口）；
    //   8315 空闲则恒取 8315（行为与旧一致，仅被占时右移）
    const _ns = _listenSnapshot();
    for (let _p = 8315; _p <= 8324; _p++) {
        if (!new RegExp(':' + _p + '(\\s|$)').test(_ns)) { _cdpPort = String(_p); break; }
    }
}
(global as any).__qqqCdpPort = _cdpPort;
app.commandLine.appendSwitch('remote-debugging-port', _cdpPort);

// ── 自定义协议 qqqide:// — 浏览器登录成功后 push token 回 IDE（2026-06-29） ──
// dev 模式必须传 app path（否则 Electron 启动默认 app→把 URL 当模块路径→炸）
// prod 打包后 qqqide.exe 自带 app path，不需要
// ★ 播放器宿主域跳过（2026-10-02 v17 补）：协议关联 = IDE/登录域职责——宿主无 authBrain（open-url/second-instance
//   在宿主域零登录处理）；且 dev 宿主会把 qqqide:// 关联重写为 dev electron.exe → 跨包污染绿色包用户的登录回调。
if (_playHostMode) {
    console.log('[protocol] player-host: skip setAsDefaultProtocolClient (login-domain only)');
} else if (app.isPackaged) {
    const ok = app.setAsDefaultProtocolClient('qqqide');
    console.log('[protocol] setAsDefaultProtocolClient (packaged) → ' + (ok ? 'OK' : 'FAILED'));
} else if (process.argv.includes('--smoke')) {
    // ★ 冒烟测试: 零注册表写入（CI 完整性；常规 dev 分支不变）
    console.log('[protocol] smoke: skip setAsDefaultProtocolClient');
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
    // ★ 播放器宿主域：第二实例 = 又一次「用 qd 播放」请求（双击/关联多选）→ 收文件开新窗；
    //   其余第二实例语义（登录回调/拾回焦点）只在 IDE 域处理。
    if (_playHostMode) {
        try {
            const files = parsePlayFiles((argv || []) as string[]);
            console.log('[player-host] second-instance, argv=' + (argv || []).length + ' files=' + files.length);
            if (files.length) { ingestExternalFiles(files); }
        } catch (e: any) {
            console.log('[player-host] second-instance handler error: ' + ((e && e.message) || e));
        }
        return;
    }
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
    if (_playHostMode) { return; }   // 宿主域无登录/无 authBrain——qqqide:// 回调只归 IDE 域
    console.log('[protocol] open-url fired, url=' + url);
    handleLegacyAuthProtocolUrl(url);
});

// ── mac：Finder 双击媒体（系统默认播放器）→ 播放器域 ──────────────────────────
//   open-file 必须在 ready 前注册（launch 文档事件可先于 ready 到达）。
//   语义三分（2026-10-03）：
//     ① 宿主域 = 直开（external 批聚合——多选双击收敛一窗列表）
//     ② IDE 已启动完成 = 转发请求队列（宿主不活自动拉起；同 external 聚合语义）
//     ③ IDE 冷启且本进程即由文档打开触发（首个事件落在启动早期 1.5s 内）→ 交棒
//        宿主成功后本进程退场（对齐 Windows「双击媒体只开播放器」；失败/迟到
//        一律回退常规转发——文件绝不吞丢）。
let _macDocFiles: string[] = [];
let _macDocTimer: any = null;
let _macDocHandoff = false;
let _macBootDone = false;
let _macDocEarly = false;
const _macModT0 = Date.now();
// 诊断日志（GUI 启动的 stdout 入黑洞——open-file 链唯一现场；≤64KB 轮转）
function _macDocLog(msg: string): void {
    try {
        const dir = path.join(portable.userData, 'Logs');
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, 'open-file.log');
        try { if (fs.statSync(f).size > 65536) { fs.writeFileSync(f, ''); } } catch { /* 无文件 */ }
        fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
    } catch { /* ignore */ }
}
function _macDocForward(files: string[]): void {
    try { queuePlayerRequest('open', { list: filesToItems(files), index: 0, play: true, external: true }, 0); }
    catch (e: any) { console.warn('[open-file] forward err: ' + ((e && e.message) || e)); }
}
function _macDocRoute(): void {
    _macDocTimer = null;
    if (!_macDocFiles.length) { return; }
    const files = _macDocFiles;
    _macDocFiles = [];
    try {
        if (_playHostMode) { _macDocLog('route host files=' + files.length); ingestExternalFiles(files); return; }   // ① 宿主域：直开
        if (!_macBootDone && _macDocEarly && !_macDocHandoff) {      // ③ 冷启文档打开：交棒 + 退场
            _macDocHandoff = true;
            _macDocLog('route cold-handoff files=' + files.length + ' bootDone=' + _macBootDone + ' early=' + _macDocEarly);
            queuePlayerRequest('open', { list: filesToItems(files), index: 0, play: true, external: true }, 8000).then((r: any) => {
                _macDocLog('handoff result ok=' + (r && r.ok));
                if (r && r.ok) { app.exit(0); }
                else { _macDocForward(files); }
            }).catch((e: any) => {
                _macDocLog('handoff err ' + ((e && e.message) || e));
                _macDocForward(files);
            });
            return;
        }
        _macDocLog('route forward files=' + files.length + ' bootDone=' + _macBootDone + ' early=' + _macDocEarly);
        _macDocForward(files);                                        // ② 热态：常规转发
    } catch (e: any) { console.warn('[open-file] route err: ' + ((e && e.message) || e)); }
}
if (process.platform === 'darwin') {
    app.on('open-file', (event, p) => {
        try { event.preventDefault(); } catch { /* ignore */ }
        if (!p || typeof p !== 'string') { return; }
        const early = _macDocFiles.length === 0 && (Date.now() - _macModT0) < 1500;
        if (early) { _macDocEarly = true; }
        _macDocLog('recv +' + (Date.now() - _macModT0) + 'ms ' + p);
        _macDocFiles.push(p);
        if (_macDocTimer) { clearTimeout(_macDocTimer); }
        _macDocTimer = setTimeout(_macDocRoute, 250);
    });
}

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
// ★ 冒烟测试机（--smoke，详 shell/smoke.ts）: 数据目录隔离 + 业务子系统门控 + 起→探→退
const isSmokeFlag = isSmokeMode();

// ── 单例服务 ──

const audioEngine = new AudioEngine(portable.root);
// ★ 退出兜底: 最后一个窗口不一定是第一个窗口(mainWindow closed 路径可能永不触发)
//   before-quit 统一兜底停音频引擎 — 幂等(已停则 no-op), 覆盖全部退出路径
//   + mac 更新「退出即换」(v1): 就绪暂存存在时静默换装（助手等本进程退出后作业）
app.on('before-quit', () => { try { audioEngine.stop(); } catch { /* ignore */ } try { maybeAutoApplyOnQuit(); } catch { /* ignore */ } });
const monacoHost = new MonacoHost();
const qzSpawn = new QzSpawn(portable.root);
const cacheStore = new CacheStore(portable.cache);
const hashService = new HashService(cacheStore);
const mediaService = new MediaService(portable.root, qzSpawn, cacheStore, hashService);
const exportService = new ExportService(portable.root, mediaService);
const stateStore = new StateStore(portable.userData);
const stateCloud = new StateCloud(stateStore);
const _qgfInstances = new Map<string, Qgf>();
const _projectStateStores = new Map<string, StateStore>();
const downloadService = new DownloadService(portable.cache);


// ★ 2026-08-20 内存治理：索引根不再默认程序目录 — 由 search_smart IPC 按发起窗口的
//   主文件夹 setRoot（project-lock），启动零索引零内存，用完即焚。
const indexService = new IndexService(null);

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
    registerFsIpc(cacheStore);
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
        downloadService, stateStore,
        () => mainWindow, bootConfig,
        hashService, cacheStore
    );
    registerTimelineIpc(portable.root, bootConfig);
    registerGitDiffIpc(portable.root, bootConfig);
    registerSmartSearchIpc(indexService);
    registerStateHandlersIpc(stateStore, stateCloud, _projectStateStores, _qgfInstances, () => mainWindow);
    registerUserDataIpc();   // 云同步上传/下载（老 qqq AQ 模式：Pull-Merge-Push 零丢失）
    registerMacUpdateIpc();
    registerUpdateHealthIpc(portable.root);   // 升级健康快照（设置面板「升级健康位」数据源）
    registerAudioIpc(audioEngine, portable.root);
    registerWqPlayingIpc();
    registerVigIpc();
    registerQzSpawnIpc(qzSpawn);
    registerRoamIpc();
    registerAiStateIpc();
    registerWsStateIpc();
    registerSearchStateIpc();
    registerKopeIpc();
    try { kopeWarmup(); } catch { /* ignore */ }   // VIG：提前预热 kope 库（card.count 首 ping 即可带上）
    registerKmdIpc(portable.root);
    registerQmdIpc(portable.root);
    registerGaeaProcessIpc();
    registerMediaIpc(mediaService);
    registerPlayerIpc(portable.root, bootConfig.url, APP_VERSION);   // 独立悬浮播放器窗（2026-09-26 q319 v4）
    registerExportIpc(exportService);
    registerAuthBrainIpc(getAuthBrain());
    registerDesktopShortcutIpc();
    registerSysPyIpc(portable.root);
    registerSquadIpc();
    registerSecureIpc();
    registerProjectLockIpc();
    registerUiZoomIpc();
}

// ── wq 偿还 IPC — Savor 播放状态 → ping playing=true（2026-09-19） ──
function registerWqPlayingIpc(): void {
    ipcMain.handle('qqqide:wq:playing', (_e, on: boolean) => {
        try {
            setCurrentlyPlaying(!!on);
            if (on) { triggerPlayingPing(); }
            return { ok: true };
        } catch {
            return { ok: false };
        }
    });
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
    // ★ mac 更新健康探针（v1 退出即换专用）: --update-probe <outFile>
    //   助手在 quiet 换装后直接调用本二进制 → 验证「新包能启动」→ 写结果后立即退出。
    //   不进入正常启动（零窗口零服务）；自检失败或崩溃 = 无结果文件 → 助手自动回滚。
    if (process.platform === 'darwin' && process.argv.includes('--update-probe')) {
        let probeOk = true, probeNote = 'ok';
        const outIdx = process.argv.indexOf('--update-probe') + 1;
        const probeOut = (outIdx > 0 && outIdx < process.argv.length) ? process.argv[outIdx] : '';
        if (!gotTheLock) { probeNote = 'busy'; }   // 另一实例在跑（旧实例退出中/用户刚重开）——不判失败
        try { require('sql.js'); } catch (e: any) { probeOk = false; probeNote = 'dep:' + ((e && e.message) || String(e)); }
        try { (app as any).dock?.hide?.(); } catch { /* ignore */ }
        try {
            if (probeOut) fs.writeFileSync(probeOut, (probeOk ? 'ok ' : 'fail ') + probeNote + ' ' + APP_VERSION, 'utf8');
        } catch { /* ignore */ }
        app.exit(probeOk ? 0 : 1);
        return;
    }

    // ═══ 播放器宿主域（--qqqide-play；2026-10-02 v17 单宿主域）════════════════════════
    //   极简启动链：便携域 → 安全加固 → 资产协议 → 播放器/编队/媒体/文件系统 IPC →
    //   py-broker（编队热键独立——无 IDE 也能召回）→ 播放器运行时（恢复/argv/队列/零窗自退）。
    //   跳过面（刻意）：强制更新弹窗 / 组件自检 / gaea goods / wq-ping / 遥测 / 自动更新器
    //   （更新是 IDE/启动器职责）。第二实例（锁败者）：argv 已被持锁宿主 second-instance 接管 → 静默退。
    if (_playHostMode) {
        if (!gotTheLock) { app.quit(); return; }
        // ★ 退出语义（2026-10-02 v18 秒开修复 + v19 常温）：最后窗关闭 → 温水滞留（期内新窗即取消；到期 IDE 心跳存活即续期；空启立即退）
        //   ——滞留/退出唯一裁决 = ipc-player.noteHostAllWindowsClosed（末窗 closed 与 window-all-closed 双挂点，
        //   初启空窗 900ms 兜底自退）；双平台一致（mac 默认不退会致宿主零窗常驻）；
        //   py-broker 收尾与心跳清理在 ipc-player 的 before-quit 里。
        app.on('window-all-closed', () => {
            try { noteHostAllWindowsClosed(); } catch { /* ignore */ }
        });
        // ★ mac 激活语义（2026-10-03）：宿主在跑时「open app / 点 Dock」只会 activate（mac 单实例
        //   特性）——若无 IDE 实例在跑 → 拉起 IDE（对齐「图标=IDE」；否则「双击媒体→播放器」状态
        //   下用户回不去 IDE）。IDE 在跑时本处 no-op（activate 归 IDE 域自己处理）。
        if (process.platform === 'darwin') {
            app.on('activate', () => { try { ensureIdeInstance(); } catch { /* ignore */ } });
        }
        // ★ 冷启打点（2026-10-02）：分段落盘玩家日志（player-host.log）——测速与回归审计现场
        const _phT0 = Date.now();
        const _phMark = (m: string): void => { try { console.log('[player-host] boot +' + (Date.now() - _phT0) + 'ms ' + m); } catch { /* ignore */ } };
        try {
            injectHostRuntimePath(portable.root);
            hardenSession();
            hardenWebContents(bootConfig);
            initAssetProtocol(portable.root, portable.cache, portable.userData);
            if (!isDevFlag) { try { await ensureLocalWebapp(portable.root); } catch { /* 失败不阻塞 */ } }
            registerFsIpc(cacheStore);
            registerMediaIpc(mediaService);
            registerHostShellIpc();
            registerFileAssocIpc(portable.root);
            registerSquadIpc();
            _phMark('ipc ready');
            registerPlayerIpc(portable.root, bootConfig.url, APP_VERSION);   // 宿主域内部启动运行时（窗口先行）
            _phMark('runtime started');
            // ★ 冷启重排（2026-10-02）：py-broker（Python 冷启 + 磁盘）后置到窗口创建之后——
            //   首帧不再与 Python 冷启动争主线程/磁盘；热键就绪延后 ~1s 对首发体验无感。
            setImmediate(() => {
                if (!isSmokeFlag) { startPyBroker(portable.root); }
                setPyBrokerEventHandler((ev: any) => {
                if (!ev || ev.event !== 'summon' || !ev.ok) { return; }
                // ★ mac 兜底：NSRunningApplication 激活无法还原最小化窗口 → 本实例直接 restore/focus
                //   （Windows 不走此路径——py-broker SetForegroundWindow 已覆盖；宿主不发召回音效/不上报履历）
                if (process.platform === 'darwin') { try { focusWindowBySlot(String(ev.squad || '')); } catch { /* ignore */ } }
                });
                _phMark('py-broker scheduled');
            });
            // ★ 转码硬编预热（2026-10-02）：后台探测定硬编码器（-encoders 预筛 + 640x360 实编 ≈0.3~1s）——
            //   首次转码（渐进流首帧）零探测等待；失败 = 纯软编零回归（详 media-service.ensureHwEncoder / transcode-hw）
            setTimeout(() => { try { mediaService.ensureHwEncoder(); } catch { /* ignore */ } }, 4000);
        } catch (e: any) {
            try { console.warn('[player-host] boot failed:', (e && e.message) || e); } catch { /* ignore */ }
            try { app.quit(); } catch { /* ignore */ }
        }
        return;
    }

    // ★ 天罗地网: 必须在任何窗口/服务之前初始化 — 崩溃记录网络 (2026-08-08 F14)
    try { crashNetInit(portable.userData); } catch (e) { try { console.warn('[crash-net] init failed:', e); } catch (_) { } }

    // ★ 启动包内存真理机器: getAppMetrics 聚合 → 广播所有窗口 (2026-08-29; v3 传 userData 持久化 24h 曲线)
    try { memMeterInit(portable.userData); } catch (e) { try { console.warn('[mem-meter] init failed:', e); } catch (_) { } }

    // ★ 主进程 i18n（强制更新对话框/原生串）— 早于渲染层，先按 OS 语言初始化；
    //   state 就绪后下方 refreshMainI18nLang 再按用户历史选择刷新（boot 面板在此之后）
    try { await initMainI18n(portable.root); } catch { /* ignore */ }

    // ★ If another instance already holds the lock, quit immediately — don't create windows
    if (_shouldQuitEarly) {
        // ★ 冒烟测试: 单例锁被占 = 明确失败（exitCode=2，报告照写）——绝不静默退出码 0
        if (isSmokeFlag) { smokeFailFast(portable.userData, 'single-instance-lock-held', 2); return; }
        app.quit();
        return;
    }

    // ★ 强制更新检查 — 版本过低时弹窗要求重新下载绿色包（2026-07-23）
    const forced = checkForcedUpdate();
    if (forced.required) {
        // 下载直链 = CDN 分发（/qd 已交还网站营销 301，不再指向 webapp）
        const DOWNLOAD_URL = 'https://gh555.com/dl/qqqide';
        const result = dialog.showMessageBoxSync({
            type: 'warning',
            title: 'qd (qqqide) — ' + mi('main.update.title'),
            message: mi('main.update.message'),
            detail: [
                mi('main.update.current', { v: forced.currentVersion }),
                mi('main.update.min', { v: forced.minVersion }),
                '',
                mi('main.update.why'),
                mi('main.update.get'),
                '',
                mi('main.update.installTitle'),
                mi('main.update.s1'),
                mi('main.update.s2'),
                mi('main.update.s3'),
                '',
                mi('main.update.prefsTitle'),
                mi('main.update.prefs1'),
                mi('main.update.prefs2'),
                mi('main.update.prefs3'),
                mi('main.update.prefs4'),
                '',
                mi('main.update.cleanTitle'),
                mi('main.update.clean1'),
            ].join('\n'),
            buttons: [mi('main.update.download'), mi('main.update.exit')],
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

    // ★ 主进程 i18n 语言刷新（state 就绪 → 用户历史选择优先于 OS 语言；boot 面板出现于此之后）
    try { await refreshMainI18nLang(() => stateStore.get('qqq.i18n', 'lang')); } catch { /* ignore */ }

    // ★ 界面缩放机器（应用级 UI scale）：读 qqq.prefs/values.uiZoom → 窗口加载后应用（详 ui-zoom.ts）
    try { initUiZoom(stateStore); } catch { /* ignore */ }

    // ★ 编辑器字号启动恢复：global.sq3 qqqide/editorFontSize（写路径 = ipc-misc qqqide:zoom:set / ± 按钮 mouseup；
    //   漏掉本段 = 重启永远回 13——在此窗口创建前完成，渲染层启动即拿到恢复值）
    try {
        const fv: any = await stateStore.get('qqqide', 'editorFontSize');
        const fsz = Math.round(Number(fv && typeof fv === 'object' ? fv.size : fv));
        if (isFinite(fsz) && fsz >= 1 && fsz <= 128) { setEditorFontSize(fsz); }
    } catch { /* ignore */ }

    // Security hardening
    hardenSession();

    // ★ 组件自检（2026-09-24 启动减负）: 缺了 rank0 组件自动后台下载。原实现直接跑在
    //   启动关键路径上（python smoke/self_heal 同步 spawn + git 全树遍历与新用户首交互
    //   抢主线程）→ 挪到「UI 就绪」（渲染层可交互，正常 3~10s / 兜底 45s）后 1.5s 开跑；
    //   内部已缓存化+异步化（_dirSizeMB 24h TTL / _cmdOkAsync）→ 常规会话近零成本。
    onUiReady(() => {
        // ★ 冒烟测试: 组件自检（后台下载）与旧槽清理（扫描包根父目录）在 CI 无意义 → 跳过
        if (isSmokeFlag) { return; }
        setTimeout(() => { try { checkRank0Components(portable.root); } catch { /* ignore */ } }, 1500);
        // 旧槽异步清理: 交换后 gh555.com-old* 由启动器交换期同步删改为壳层就绪后台删
        scheduleOldSlotCleanup(portable.root);
    });

    // ★ 时序修复（2026-09-16）：webapp 运行副本先就位，再 spawn 任何 stdio 组件与 process goods——
    //   原时序 goods 自启早于副本刷新（升级首启 +28s 实锤）→ goods 跑旧代码（旧 OS 目录/旧锁路径）；
    //   且副本拷贝阻塞主线程数十秒 → py-broker ready 握手被误判超时（假超时重启实锤）。
    //   ensureLocalWebapp 幂等（戳一致零拷贝）；dev 模式跳过（懒拷贝走 dev server）。
    if (!isDevFlag) {
        // ★ 2026-09-24: ensureLocalWebapp 改 async 增量同步（戳不匹配时逐文件比对），
        //   await 保持「副本先就位再 spawn 组件」时序契约（goods 跑旧代码事故），
        //   但不再阻塞主进程事件循环。
        try { await ensureLocalWebapp(portable.root); } catch { /* 失败不阻塞启动 */ }
    }

    // ★ Python broker: 仅当已安装时启动（未安装则下次启动自动下载后再启）
    //   ★ 冒烟测试: 不启动（进程隔离；不与已运行实例争编队热键互斥量）
    if (!isSmokeFlag) { startPyBroker(portable.root); }

    // ★ 编队热键事件（py-broker 常驻 pynput 监听 Space+key）→ 召回成功播放 kj3 音效
    setPyBrokerEventHandler((ev: any) => {
        if (!ev || ev.event !== 'summon') { return; }
        try { console.log('[squad] summon', ev.squad, ev.ok ? 'OK' : 'miss', ev.folder || ''); } catch { /* ignore */ }
        if (ev.ok) {
            // ★ 编队履历: 召回成功记一次（槽位独立计数 → vig.json → wq-ping 搭便车上报）
            try { vigSquadSummon(String(ev.squad || '')); } catch { /* ignore */ }
            try { playSfxFile(audioEngine, portable.root, 'yz:kj3.mp3'); } catch (e) {}
            // ★ mac 兜底: NSRunningApplication 激活无法还原最小化窗口 →
            //   本实例窗口直接 restore/show/focus（winId+pid 双条件，他实例不碰）
            if (process.platform === 'darwin') {
                try { focusWindowBySlot(String(ev.squad || '')); } catch { /* ignore */ }
            }
        }
    });

    // ★ Gaea process auto-start: 遍历所有注册的 process-type goods
    //   ★ 冒烟测试: 跳过（不得拉起 python goods 子进程；CI 保持零业务进程）
    if (!isSmokeFlag) (async () => {
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

    // ★ 窗口拦截加固必须先于任何窗口创建：否则主窗口 webContents 无 setWindowOpenHandler，
    //   target=_blank 链接点击会弹裸窗口（2026-08-21 事故：overlay 链接双开浏览器+空窗口）
    hardenWebContents(bootConfig);

    // Create main windowdow
    mainWindow = createWindow(
        portable.root, portable.cache, APP_VERSION,
        downloadService, stateStore
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
        try { vigFlush(); } catch { /* ignore */ }
        }
    });

    // Register IPC (after window exists)
    registerAllIpc();

    // ★ 音频桥懒启动（2026-10-02 定案·极限低资源）：不再启动即 ensure——首个真实播放请求
    //   （qqqide:audio:play / play_music，engine.invoke 内部按需拉起）才拉起；整会话零声音 →
    //   零音频进程（-37MB）。首响代价 = 一次性拉起耗时（仅首个声音，此后全程热）。
    //   （历史「启动预启动消灭首响延迟」已删；冒烟同旧规：零业务进程。）

    // Register exit handlers
    registerExitHandlers(portable.root, portable.logs, stateStore, bootConfig, _qgfInstances);

    // Boot
    // ★ 多窗口还原 — 第一步：确保主窗口加载正确的项目文件夹
    //   恢复链: 绿色包级 global.sq3 → OS 级 ws.sq3（2026-08-09 删包/换包后 OS 兜底）
    //   ★ 2026-08-29 多实例修复: ws.sq3 窗口记忆按启动目录分槽 (openWindows.{root}),
    //     各启动目录只读自己的槽 → 不同实例窗口列表零互踩; 旧版整列表 key 兜底兼容
    // ★ 组还原两两间隔 (2026-08-16): 菜单退出整组还原时窗口错峰打开, 防竞争态
    const RESTORE_WINDOW_GAP_MS = 500;
    setPackRoot(portable.root);
    const readOpenWindows = async (): Promise<any[]> => {
        try {
            let v: any = await stateStore.get('qqqide', 'open_windows');
            if (!v) { try { v = await wsStateGetKey(packWsKey('openWindows')); } catch { /* ignore */ } }
            if (!v) { try { v = await wsStateGetKey('openWindows'); } catch { /* ignore */ } } // ★ 旧版遗留整列表 key 兜底 (分槽前数据)
            return (v && Array.isArray(v)) ? v : [];
        } catch { return []; }
    };
    // ★ 主窗口实际恢复到的文件夹 (2026-08-16): claim 失败时保持 null,
    //   后续多窗口还原据此判断是否预注册 open_windows[0]（claim 失败 → 交给还原循环尝试额外窗口）
    let _mainRestoreFolder: string | null = null;
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
                        // ★ 打开序记录 (2026-08-16): 主窗口恢复即入打开序日志 + 刷新存活快照
                        _mainRestoreFolder = n0;
                        recordWindowOpen(mainWindow.id, n0, stateStore);
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
    _macBootDone = true;   // mac open-file 冷启判定分界（此前到达的文档事件 = 本进程由文档打开触发）

    // ★ 冒烟测试机（--smoke）: 等渲染层就绪 → 经 preload 桥真实 IPC 探活 → 报告 + 退出码
    if (isSmokeFlag) {
        runSmoke({
            root: portable.root,
            userData: portable.userData,
            appVersion: APP_VERSION,
            getWindow: () => mainWindow,
            getBootMode: () => getLastBootMode(),
            // app.exit 跳过 before-quit → 音频引擎显式收尾（子进程 stdin EOF 双保险）
            onBeforeExit: () => { try { audioEngine.stop(); } catch { /* ignore */ } },
        });
    }

    // ★ 多窗口还原：读取上次退出保存的窗口列表，还原额外窗口
    (async () => {
        try {
            const openWindows = await readOpenWindows();
            if (openWindows && openWindows.length > 1) {
                // ★ 最后关闭窗口 (2026-08-25): openWindows 条目 lastClosed 标记 = 上次退出最后关闭的窗口。
                //   boot.ts 主窗口晚 show+focus 会抢焦点（“卡到 a”根因）→ 启动后焦点必须还给最后关闭的窗口
                let lastClosedFolder: string | null = null;
                const lastClosedEntry = openWindows.find((w: any) => !!(w && w.lastClosed));
                if (lastClosedEntry && lastClosedEntry.mainFolder) {
                    lastClosedFolder = lastClosedEntry.mainFolder.replace(/\\/g, '/').replace(/\/$/, '') || null;
                }
                if (lastClosedFolder && lastClosedFolder !== _mainRestoreFolder) {
                    // ★ 主窗口任何时刻 show（boot.ts 晚 show+focus 抢焦点）→ 焦点夺回给最后关闭窗口
                    mainWindow.on('show', () => {
                        const wid = _projectWindowMap.get(lastClosedFolder!);
                        const w = wid !== undefined ? BrowserWindow.fromId(wid) : null;
                        if (w && !w.isDestroyed()) { try { w.focus(); } catch (_) { } }
                    });
                }
                // ★ 预注册主窗口项目（open_windows[0]），防后续还原重复创建；
                //   仅当主窗口真的拿到了该文件夹（_mainRestoreFolder 非空）才预注册 —
                //   否则让还原循环尝试在额外窗口恢复（2026-08-16: 旧代码无条件注册 →
                //   claim 失败时该文件夹被 map 占据 → 永失恢复）
                const w0 = openWindows[0];
                if (w0 && w0.mainFolder) {
                    var n0 = w0.mainFolder.replace(/\\/g, '/').replace(/\/$/, '');
                    if (n0 && _mainRestoreFolder === n0) {
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

                    const newWin = createWindow(portable.root, portable.cache, APP_VERSION, downloadService, stateStore);
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
                    // ★ 打开序记录 (2026-08-16)
                    recordWindowOpen(newWin.id, normalized, stateStore);
                    // ★ 最后关闭窗口可见即置前 (2026-08-25)
                    if (lastClosedFolder && normalized === lastClosedFolder) {
                        newWin.on('show', () => { try { if (!newWin.isDestroyed()) newWin.focus(); } catch (_) { } });
                    }

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
                    // ★ 组还原两两间隔 (2026-08-16 定案 500ms): 给前一个窗口的 kope-a/goods 进程
                    //   足够启动时间 + 项目锁/阵营绑定错峰, 防多窗同时初始化竞争态
                    await new Promise(r => setTimeout(r, RESTORE_WINDOW_GAP_MS));
                }
                if (restored > 0) console.log('[restore] ' + restored + ' additional window(s) restored');
                // ★ 焦点仲裁轮询 (2026-08-25): 主窗口 boot.ts 晚 show+focus 抢焦点 → 轮询直到
                //   最后关闭窗口可见置前（任何时序的最终赢家 = lastClosed）
                if (lastClosedFolder && lastClosedFolder !== _mainRestoreFolder) {
                    let tries = 0;
                    const iv = setInterval(() => {
                        tries++;
                        const wid = _projectWindowMap.get(lastClosedFolder!);
                        const w = wid !== undefined ? BrowserWindow.fromId(wid) : null;
                        if (w && !w.isDestroyed() && w.isVisible()) {
                            try { w.focus(); } catch (_) { }
                            clearInterval(iv);
                        } else if (tries >= 10) {
                            clearInterval(iv); // 5s 兑底放弃 (窗口可能被锁跳过/路径不存在)
                        }
                    }, 500);
                }
            }
        } catch (e) {
            console.warn('[restore] multi-window restore failed:', e);
        }
    })();

    // ★ 播放器会话恢复（2026-10-02 v17 单宿主域）：有未关窗 → 拉起宿主（宿主自恢复，暂停态；按包分槽）
    try { kickPlayerHostForRestore(); } catch { /* ignore */ }

    // ★ IDE 存活心跳（2026-10-02 v19 常温）：60s 续写 ide-alive.json——宿主温水期据此续期（IDE 存活期恒温秒开）
    try { startIdeKeepalive(); } catch { /* ignore */ }

    // ★ 「Roam 定位」跨进程接收（2026-10-03）：宿主 reveals 队列 → 本进程任一主窗置前投递（详 player-host.ts）
    try { startIdeRevealWatch(); } catch { /* ignore */ }

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
    try { setWqPingStateStore(stateStore); } catch { /* ignore */ }
    // ★ 冒烟测试: 不上报（CI 设备不得写入生产遥测）
    if (!isSmokeFlag) { startWqPing(portable.userData); }
    // ★ 楼层履历离线播种（2026-09-22）：启动 60s 后扫最近项目 _qqq/quests/*/f* 一次性回填「总楼层」
    try { vigStartFloorsSeed(stateStore); } catch { /* ignore */ }

    // ★ 壳层后台更新器（2026-08-31 架构）: 下载/验签/解压 100% 在 IDE 正常运行期间执行
    //   ——C 启动器不再持有下载线程（启动/退出/第二实例零等待，点击必弹窗）
    try { startAutoUpdater(portable.root); } catch (e) { try { console.warn('[auto-updater] start failed:', e); } catch (_) { } }

    // ★ mac 应用内更新机制 v0（2026-09-18）: Windows 无此机制（C 启动器托管），
    //   仅 darwin + .app bundle 布局生效；其余平台函数内部直接 return。
    try { startMacUpdater(); } catch (e) { try { console.warn('[mac-updater] start failed:', e); } catch (_) { } }

    // ★ 2026-08-20 语义索引改为完全按需（懒加载 + 用完即焚，ghrun 同款语义）：
    //   启动零索引零内存；首次 search_smart 才按窗口主文件夹构建/读盘。此处不再 init()。

    // macOS: re-activate → recreate window
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createWindow(
                portable.root, portable.cache, APP_VERSION,
                downloadService, stateStore
            );
            bootSequence(
                mainWindow, bootConfig, portable.root, portable.cache,
                isDevFlag, isOfflineFlag, setLastBootMode, getLastBootMode
            );
        }
    });
});
