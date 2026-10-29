// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// browser-host.ts — 受控浏览器域（--qqqide-browser）
//
// qd 自带内核即浏览器：本域把同一颗内核以「受控浏览器」身份跑起来——
// 独立 userData（Data/browser-host → 独立 SingletonLock，与 IDE 域/播放器宿主域互不夺锁），
// 原生 CDP 调试口（8335 段）对外提供标准端点：本机工具链（kit/qdbrowser.py 起）连接后
// 即可导航 / 读结构 / 输入 / 截图——零外部浏览器依赖（新电脑、Win7、无 Chrome 全可用）。
//
// ★ 档案槽（多身份）：--qqqide-browser-profile=<Data 下相对路径> 换 userData 目录——
//   默认槽 = browser-host（历史路径，登录态原地保留）；具名槽 = browser-profiles/<槽>/builtin。
//   每槽一套独立 userData（独立 SingletonLock + 独立 CDP 口）→ 多个身份可并行在跑。
//   模型：**内核是消耗品，档案是资产**——本域只提供内置内核；外部内核（用户机器已装的
//   Chrome/Edge）由工具链 kit/browser_engine.py 拉起，档案槽目录同构（…/<槽>/external）。
//   ★ 登录态不跳内核通用（cookie 存储布局不同）——槽位首次使用后即钉住内核。
//
// 契约文件：
//   {档案目录}/host.json                        存活心跳 {v,engine,slot,profile,pid,ts,cdpPort,startedAt,hidden}（4s 刷）。
//                                                兼作「权威端点」：工具链跨 TEMP 作用域发现同一实例
//                                                （IDE 内跑的 kit 与终端 kit 互见——根治报告文件随 TEMP 分裂）。
//                                                ★ 外部内核同路径同字段（kit 启动时写；存活由 CDP 探测裁决）。
//   --qqqide-browser-report=<path>               就绪报告（原子写）{ok,pid,cdpPort,dataDir,hostJson,ts,reused,ver,hidden,engine,slot}
//                                                已运行实例被二次拉起时由持锁实例补写 reused:true。
//   --qqqide-browser-slot=<slot>                 档案槽名（窗口标题与心跳标注；默认 default）
//   --qqqide-browser-url=<url>                   首次启动直接加载；二次实例 = 导航主窗（不开新窗）
//   --qqqide-browser-hidden                      静默档（无可见窗口；实例级属性，见下）
//   --qqqide-browser-exit-with=<pid>             跟随监督进程（监督方退出 → 本域退出）
//   --qqqide-browser-idle-exit=<分钟>            空闲自退（默认 hidden=30 / 可见=关；0=禁）
//
// 窗口：单例受控浏览器窗。
//   ★ hidden = 实例级属性：一旦隐藏，任何二次请求都不会弹窗/抢焦点（防批量任务中途冒窗）；
//     需要可见时先 stop 再 ensure（登录态存 profile，不丢）。
//   导航策略 = 仅 http/https/about（拦 file:/自定义协议——远程页面禁触本机协议处理器）；
//   window.open → http/https/about:blank 放行（加固参数新窗）；★ hidden 档子窗继承隐藏（不冒可见窗）；
//   下载 → {Data}/browser-host/Downloads（重名 name_1.ext；启动后台浅清 30 天龄 + 2GB 硬线）；
//   权限 = 白名单三项（fullscreen/clipboard-read/clipboard-sanitized-write），其余全拒。
//   不可最小化（最小化=渲染帧停产 → CDP 截图挂起）；遮挡渲染暂停由本域专属
//   CalculateNativeWinOcclusion 禁用兜住（帧供给不因窗口状态中断——截图/驱动依赖帧）。
// 生命周期：关掉最后一个窗 = 退出（登录态存 profile，长期保留）。
//   ★ 空闲自退：无 CDP 客户端连接（netstat/lsof 实测）且无页面活动达 N 分钟 → 退出——
//     防「隐形孤儿进程」常驻（AI 忘记 stop / 监督方已亡）。探测失败一律视作活跃（绝不误杀）。
// 文案：窗口标题/起始页走主进程 i18n（main.browserHost.*，13 语言）；显示层品牌恒 "qd (qqqide)"。
//
// ★ 交换守卫注记：本域带可见窗口时，launcher 视为「本包 joker 可见窗」→ 推迟下次启动的原子交换
//   （与播放器宿主窗同语义，交换前关窗/退出即释放；hidden 档无可见窗，不推迟）。
// ============================================================================

import { app, BrowserWindow, session } from 'electron';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { initMainI18n, mi, getMainLang } from './main-i18n';

// ── flags ──

/** 本进程是否为受控浏览器域（--qqqide-browser；含 --qqqide-browser= 前缀式）。 */
export function isBrowserHostMode(): boolean {
    return process.argv.some((a) => a === '--qqqide-browser' || a.indexOf('--qqqide-browser=') === 0);
}

const FLAG_REPORT = 'qqqide-browser-report';
const FLAG_SLOT = 'qqqide-browser-slot';
const FLAG_URL = 'qqqide-browser-url';
const FLAG_HIDDEN = 'qqqide-browser-hidden';
const FLAG_EXIT_WITH = 'qqqide-browser-exit-with';
const FLAG_IDLE_EXIT = 'qqqide-browser-idle-exit';

function _flag(name: string, argv?: string[]): string | null {
    const p = '--' + name + '=';
    for (const a of (argv || process.argv)) { if (a.indexOf(p) === 0) { return a.slice(p.length); } }
    return null;
}

// ── 状态 ──
let _userData = '';
let _profile = '';          // Data 下相对档案路径（browser-host / browser-profiles/<槽>/builtin）
let _slot = 'default';      // 档案槽名（人类可读维度；窗口标题与心跳标注）
let _cdpPort = '';
let _startedAt = 0;
let _ready = false;
let _hidden = false;
let _heartbeatTimer: NodeJS.Timeout | null = null;
let _exitWithTimer: NodeJS.Timeout | null = null;
let _idleTimer: NodeJS.Timeout | null = null;
let _idleExitMs = 0;
let _lastActivityAt = 0;
const _pendingSecondInstance: string[][] = [];

/** 受控浏览器数据目录（{Data}/browser-host）。 */
export function browserHostDataDir(): string { return _userData; }

/** 活跃脉冲（空闲自退计时重置）：页面导航/加载/标题变更/下载/二次实例/一切 webContents 事件。 */
function _bumpActivity(): void { _lastActivityAt = Date.now(); }

// ── 预就绪（app.whenReady 前由 main.ts 调用）：命令行开关 ──
export function browserHostPreReady(): void {
    // CDP WebSocket 放行（新版内核发 Origin 头时必需；仅本域进程、仅 localhost 调试口。
    // ★ 内核升级注意：remote-allow-origins='*' 在 Electron 22 是 no-op——换新内核后应改为
    //   精确 origin 列表，勿沿用通配符。）
    app.commandLine.appendSwitch('remote-allow-origins', '*');
    // 自动化帧/计时保障（跨平台）：内核不因窗口退居后台/被遮挡而降优先级或节流计时器——
    // CDP 截图依赖持续产帧、AI 场景脚本依赖定时器按时抖动（隐藏档无窗口运行时同样受益）。
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
}

// ── 就绪启动（main.ts 的 whenReady 分支调用）──
export function browserHostRun(opts: { root: string; userData: string; cdpPort: string; profile?: string }): void {
    _userData = opts.userData;
    _profile = opts.profile || 'browser-host';
    _slot = (_flag(FLAG_SLOT) || 'default').trim() || 'default';
    _cdpPort = opts.cdpPort;
    _startedAt = Date.now();
    _lastActivityAt = _startedAt;
    console.log('[browser-host] boot pid=' + process.pid + ' cdpPort=' + _cdpPort +
        ' slot=' + _slot + ' userData=' + _userData);

    // 文案 i18n（窗口标题/起始页；无 state 库 → 按 OS 语言决议。不带 persistedGetter 时同步完成）
    try { initMainI18n(opts.root).catch(() => { /* 缺失词条走内置英文兜底 */ }); } catch { /* ignore */ }

    _hardenSession();

    // 下载落点（受控浏览器下载禁外甩、禁 C 盘：恒落 {Data}/browser-host/Downloads，重名 name_1.ext）
    try { session.defaultSession.on('will-download', (_e, item) => { _saveDownload(item); }); } catch { /* ignore */ }

    // 导航策略 + 新窗策略（本进程全部 webContents，含 window.open 子窗）
    app.on('web-contents-created', (_e, wc) => { _wireContents(wc); });

    // 主窗
    const hidden = process.argv.includes('--' + FLAG_HIDDEN);
    _hidden = hidden;
    // mac：隐藏档不占 Dock（静默批处理零存在感；可见档保持常态）
    if (hidden && process.platform === 'darwin') { try { app.dock.hide(); } catch { /* ignore */ } }
    _mainWindowCreate({ url: _flag(FLAG_URL), show: !hidden });

    // 心跳 + 收尾
    _writeHostState();
    _heartbeatTimer = setInterval(() => { _writeHostState(); }, 4000);
    try { (_heartbeatTimer as any).unref?.(); } catch { /* ignore */ }
    app.on('will-quit', () => {
        try { if (_heartbeatTimer) { clearInterval(_heartbeatTimer); } } catch { /* ignore */ }
        try { if (_exitWithTimer) { clearInterval(_exitWithTimer); } } catch { /* ignore */ }
        try { if (_idleTimer) { clearInterval(_idleTimer); } } catch { /* ignore */ }
        try { fs.unlinkSync(_hostStateFile()); } catch { /* ignore */ }
        try { const rp = _flag(FLAG_REPORT); if (rp) { fs.unlinkSync(rp); } } catch { /* ignore */ }
    });

    // 空闲自退（防隐形孤儿：无 CDP 客户端 + 无页面活动；默认 hidden=30min / 可见=关）
    _armIdleExit(hidden);

    // 监督进程跟随（可选：监督方退出 → 本域退出）
    const exitWith = parseInt(_flag(FLAG_EXIT_WITH) || '', 10);
    if (exitWith > 0) {
        _exitWithTimer = setInterval(() => {
            if (!_isPidAlive(exitWith)) { try { app.quit(); } catch { /* ignore */ } }
        }, 3000);
        try { (_exitWithTimer as any).unref?.(); } catch { /* ignore */ }
    }

    // 下载目录浅清（不阻塞启动：30 天龄 + 2GB 硬线，见 _pruneDownloads）
    try {
        const t = setTimeout(() => { try { _pruneDownloads(); } catch { /* ignore */ } }, 10000);
        (t as any).unref?.();
    } catch { /* ignore */ }

    // 就绪报告（调用方据此发现端口）
    _ready = true;
    _writeReport(false);
    _flushPending();
}

// ── 空闲自退 ──

function _armIdleExit(hidden: boolean): void {
    const raw = _flag(FLAG_IDLE_EXIT);
    let ms = 0;
    if (raw !== null) {
        const mins = parseFloat(raw);
        if (!isNaN(mins) && mins > 0) { ms = Math.round(mins * 60000); }
    } else if (hidden) {
        ms = 30 * 60000;
    }
    _idleExitMs = ms;
    if (_idleExitMs <= 0) { return; }
    // 节奏自适应（阈值/4，15s~60s 夹逼；测试用极小值也灵敏）
    const period = Math.max(15000, Math.min(60000, Math.round(_idleExitMs / 4)));
    _idleTimer = setInterval(_idleTick, period);
    try { (_idleTimer as any).unref?.(); } catch { /* ignore */ }
    console.log('[browser-host] idle-exit armed: ' + (_idleExitMs / 60000) + 'min (period ' + period + 'ms)');
}

/** 进程存活判定。★ POSIX 僵尸修正（真机 mac/linux 实测）：监督方被 kill 后未被父进程收割时
 *  变成僵尸（Z）——`process.kill(pid, 0)` 对僵尸仍返回成功 → exit-with 永不触发。
 *  Linux 读 /proc/<pid>/stat 状态位；macOS 用 ps 确认（仅 exit-with 启用时每 3s 一次）；
 *  探测异常一律「维持存活」（绝不误杀活监督方）。 */
function _isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); } catch { return false; }
    try {
        if (process.platform === 'linux') {
            const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            const close = st.lastIndexOf(')');
            const state = st.slice(close + 2, close + 3);
            return state !== 'Z';
        }
        if (process.platform === 'darwin') {
            let out = '';
            try {
                out = execSync('ps -o stat= -p ' + pid, { encoding: 'utf8', timeout: 3000 });
            } catch (e: any) {
                if (e && e.status === 1) { return false; }   // ps：无此进程
                return true;                                  // 其余故障 → 维持存活
            }
            const s = (out || '').trim();
            if (!s) { return false; }
            return s.charAt(0) !== 'Z';                       // Z = 僵尸（已死未收割）
        }
    } catch { /* 探测失败 → 维持存活 */ }
    return true;
}

/** CDP 已建立客户端连接数；-1 = 探测失败（视作活跃——绝不误杀）。 */
function _cdpClientCount(): number {
    try {
        if (process.platform === 'win32') {
            const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 4000, windowsHide: true });
            const re = new RegExp(':' + _cdpPort + '(\\s|$)');
            let n = 0;
            for (const l of out.split('\n')) { if (l.indexOf('ESTABLISHED') !== -1 && re.test(l)) { n++; } }
            return n;
        }
        if (process.platform === 'linux') {
            // /proc/net/tcp(6) 直读（零外部依赖——lsof 在最小化安装里可能缺席）。
            // 行格式：local_address = HEXIP:HEXPORT，st=01 为 ESTABLISHED；本端端口命中即一条客户端连接。
            const port = parseInt(_cdpPort, 10);
            let n = 0;
            for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
                let txt = '';
                try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
                const lines = txt.split('\n');
                for (let i = 1; i < lines.length; i++) {
                    const seg = lines[i].trim().split(/\s+/);
                    if (seg.length < 4) { continue; }
                    const lp = (seg[1] || '').split(':')[1];
                    if (seg[3] === '01' && lp && parseInt(lp, 16) === port) { n++; }
                }
            }
            return n;
        }
        try {
            const out = execSync('lsof -nP -iTCP:' + _cdpPort + ' -sTCP:ESTABLISHED', { encoding: 'utf8', timeout: 4000 });
            let n = 0;
            for (const l of out.split('\n')) { if (l.indexOf('(ESTABLISHED)') !== -1) { n++; } }
            return n;
        } catch (e: any) {
            return (e && e.status === 1) ? 0 : -1;   // lsof 无匹配 = 0；其余故障 = 未知
        }
    } catch { return -1; }
}

function _idleTick(): void {
    if (_idleExitMs <= 0) { return; }
    const n = _cdpClientCount();
    if (n !== 0) { _bumpActivity(); return; }              // 有客户端 / 探测失败 → 活跃
    if (Date.now() - _lastActivityAt < _idleExitMs) { return; }
    console.log('[browser-host] idle exit (' + Math.round(_idleExitMs / 60000) + 'min no client / no page activity)');
    try { app.quit(); } catch { /* ignore */ }
}

// ── 第二实例（持锁实例侧由 main.ts 的 second-instance 转发）──
export function browserHostSecondInstance(argv: string[]): void {
    if (!_ready) { _pendingSecondInstance.push(argv || []); return; }
    _applySecondInstance(argv || []);
}

function _flushPending(): void {
    while (_pendingSecondInstance.length) {
        const a = _pendingSecondInstance.shift();
        try { _applySecondInstance(a || []); } catch { /* ignore */ }
    }
}

// 二次实例语义：① 携带 url → 导航主窗（不开新窗）；② 无 url → 唤起主窗；③ 恒补写报告 reused:true。
// ★ hidden 实例绝不弹窗/抢焦点（实例级属性；任何二次请求都不改变——防批量任务中途冒窗）。
function _applySecondInstance(argv: string[]): void {
    const url = _flag(FLAG_URL, argv);
    const wantHidden = _hidden || argv.includes('--' + FLAG_HIDDEN);
    const report = _flag(FLAG_REPORT, argv);
    console.log('[browser-host] second-instance url=' + (url || 'NONE') + ' report=' + (report ? 'yes' : 'no') + ' hidden=' + (_hidden ? 'yes' : 'no'));
    _bumpActivity();
    const primary = _primaryWindow();
    if (url && /^https?:/i.test(url)) {
        if (primary) {
            try { primary.loadURL(url); } catch { /* ignore */ }
            if (!wantHidden) { _popWindow(primary); }
        } else {
            _mainWindowCreate({ url, show: !wantHidden });
        }
    } else if (!wantHidden && primary) {
        _popWindow(primary);
    }
    if (report) { _writeReportTo(report, true); }
}

function _popWindow(w: BrowserWindow): void {
    try { if (w.isMinimized()) { w.restore(); } } catch { /* ignore */ }
    try { w.show(); w.focus(); } catch { /* ignore */ }
}

// ── 启动失败报告（main.ts 兜底路径调用，让调用方拿到原因而不是干等超时）──
export function browserHostReportFailure(err: any): void {
    const reportPath = _flag(FLAG_REPORT);
    if (!reportPath) { return; }
    try {
        _atomicWriteJson(reportPath, {
            ok: false, ver: 1,
            error: String((err && err.message) || err || 'boot failed'),
            ts: Date.now(),
        });
    } catch { /* ignore */ }
}

// ── 窗口 ──
let _mainWindow: BrowserWindow | null = null;

function _primaryWindow(): BrowserWindow | null {
    if (_mainWindow && !_mainWindow.isDestroyed()) { return _mainWindow; }
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) { return w; } }
    return null;
}

const _SAFE_PREFS = {
    backgroundThrottling: false,   // 隐藏/最小化不节流（自动化批处理必需）
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
};

function _mainWindowCreate(o: { url: string | null; show: boolean }): BrowserWindow {
    const win = new BrowserWindow({
        width: 1280, height: 820, minWidth: 560, minHeight: 420,
        show: o.show, skipTaskbar: !o.show, autoHideMenuBar: true,
        minimizable: false,   // 最小化=帧停产（CDP 截图会挂起）——收起来请关闭窗口（下次任务自动重开）
        title: _winTitle(), backgroundColor: '#161616',
        webPreferences: { ..._SAFE_PREFS } as any,
    });
    if (!_mainWindow) { _mainWindow = win; }
    win.on('closed', () => { if (_mainWindow === win) { _mainWindow = null; } });
    try { win.loadURL(o.url || _startPageUrl()); } catch { /* ignore */ }
    return win;
}

function _escHtml(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 窗口标题：正式品牌位保持 i18n 词条原样；具名档案槽追加 「 · <槽>」——多身份并行时
 *  人一眼能分出哪个窗是哪个身份（默认槽不追加，与历史一致）。 */
function _winTitle(): string {
    const base = mi('main.browserHost.title');
    return (_slot && _slot !== 'default') ? (base + ' · ' + _slot) : base;
}

function _startPageUrl(): string {
    const title = _escHtml(_winTitle());
    const hosted = _escHtml(mi('main.browserHost.startHosted'));
    const monitor = _escHtml(mi('main.browserHost.startMonitor'));
    const hint = _escHtml(mi('main.browserHost.startHint'));
    // 语言/方向自适（阿拉伯语 RTL；其余 LTR）
    let langAttr = 'zh-CN';
    let dirAttr = 'ltr';
    try {
        const l = getMainLang();
        langAttr = (l === 'zh') ? 'zh-CN' : (l === 'zh-tw') ? 'zh-TW' : l;
        dirAttr = (l === 'ar') ? 'rtl' : 'ltr';
    } catch { /* 保持默认 */ }
    const html = '<!doctype html><html lang="' + langAttr + '" dir="' + dirAttr + '"><head><meta charset="utf-8"><title>' + title + '</title>' +
        '<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;' +
        'background:#161616;color:#e8e5df;font:14px/1.9 system-ui,"Microsoft YaHei",sans-serif}' +
        '.c{max-width:480px;padding:0 32px}.t{font-size:20px;font-weight:600;margin-bottom:10px;color:#e4b04f}' +
        '.s{color:#9b968d}.h{margin-top:18px;font-size:12px;color:#6f6a63}</style></head><body><div class="c">' +
        '<div class="t">' + title + '</div>' +
        '<div>' + hosted + '</div>' +
        '<div class="s">' + monitor + '</div>' +
        '<div class="h">' + hint + '</div>' +
        '</div></body></html>';
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ── 会话加固（本域自己的策略，独立于 IDE 域 hardenSession）──
const _PERM_ALLOW = new Set<string>(['fullscreen', 'clipboard-read', 'clipboard-sanitized-write']);

function _hardenSession(): void {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(_PERM_ALLOW.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => _PERM_ALLOW.has(permission));
    try { ses.setSpellCheckerEnabled(false); } catch { /* 旧内核无此 API */ }
}

// ── webContents 策略（导航白名单 + 新窗策略 + 活动脉冲）──
function _wireContents(wc: any): void {
    _bumpActivity();
    try {
        wc.setWindowOpenHandler(({ url }: { url: string }) => {
            if (/^https?:/i.test(url) || url === 'about:blank') {
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: {
                        autoHideMenuBar: true, backgroundColor: '#161616',
                        minimizable: false,
                        show: !_hidden,          // ★ hidden 档子窗继承隐藏（静默批处理不漏可见窗）
                        skipTaskbar: _hidden,
                        webPreferences: { ..._SAFE_PREFS } as any,
                    },
                };
            }
            return { action: 'deny' };
        });
    } catch { /* ignore */ }
    const gate = (e: any, url: string): void => {
        if (!/^(https?|about):/i.test(url)) { e.preventDefault(); }   // 远程内容不得触发 file:/自定义协议处理器
    };
    try { wc.on('will-navigate', (e: any, url: string) => gate(e, url)); } catch { /* ignore */ }
    try { wc.on('will-redirect', (e: any, url: string) => gate(e, url)); } catch { /* ignore */ }
    // 活动脉冲：一切导航/加载/标题变更/子窗创建 = 活跃（空闲自退的页面侧信号）
    for (const ev of ['did-start-navigation', 'did-navigate', 'did-navigate-in-page', 'did-finish-load', 'page-title-updated', 'did-create-window']) {
        try { wc.on(ev, () => { _bumpActivity(); }); } catch { /* 旧内核缺事件则跳过 */ }
    }
}

// ── 下载 ──
function _saveDownload(item: any): void {
    _bumpActivity();
    try {
        const dir = path.join(_userData, 'Downloads');
        fs.mkdirSync(dir, { recursive: true });
        const name = String(item.getFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_');
        item.setSavePath(_uniquePath(path.join(dir, name)));
        item.once('done', (_e: any, state: string) => {
            console.log('[browser-host] download ' + state + ' -> ' + item.getSavePath());
        });
    } catch (e: any) {
        console.warn('[browser-host] download save failed: ' + ((e && e.message) || e));
    }
}

function _uniquePath(p: string): string {
    try { if (!fs.existsSync(p)) { return p; } } catch { return p; }
    const dir = path.dirname(p);
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    for (let i = 1; i < 1000; i++) {
        const cand = path.join(dir, base + '_' + i + ext);
        try { if (!fs.existsSync(cand)) { return cand; } } catch { return cand; }
    }
    return p;
}

// 下载目录浅清（启动后台跑）：① 30 天龄直清；② 总量 >2GB 时按最老优先清到 1.5GB（不碰 24h 内新文件）。
function _pruneDownloads(): void {
    const dir = path.join(_userData, 'Downloads');
    const AGE_MS = 30 * 24 * 3600 * 1000;
    const FRESH_MS = 24 * 3600 * 1000;
    const HARD = 2 * 1024 * 1024 * 1024;
    const SOFT = 1536 * 1024 * 1024;
    const files: { p: string; size: number; mtime: number }[] = [];
    const walk = (d: string, depth: number): void => {
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            try {
                if (e.isDirectory()) { if (depth < 4) { walk(p, depth + 1); } }
                else if (e.isFile()) {
                    const st = fs.statSync(p);
                    files.push({ p, size: st.size, mtime: st.mtimeMs });
                }
            } catch { /* 占用/权限 → 跳过 */ }
        }
    };
    walk(dir, 0);
    if (!files.length) { return; }
    const now = Date.now();
    const keep: typeof files = [];
    let total = 0;
    let removed = 0;
    for (const f of files) {
        if (now - f.mtime > AGE_MS) {
            try { fs.unlinkSync(f.p); removed++; } catch { keep.push(f); total += f.size; }
        } else { keep.push(f); total += f.size; }
    }
    if (total > HARD) {
        keep.sort((a, b) => a.mtime - b.mtime);
        for (const f of keep) {
            if (total <= SOFT) { break; }
            if (now - f.mtime < FRESH_MS) { continue; }
            try { fs.unlinkSync(f.p); removed++; total -= f.size; } catch { /* ignore */ }
        }
    }
    if (removed) { console.log('[browser-host] downloads pruned: ' + removed + ' file(s)'); }
}

// ── 状态/报告文件（原子写）──
function _hostStateFile(): string { return path.join(_userData, 'host.json'); }

function _writeHostState(): void {
    try {
        _atomicWriteJson(_hostStateFile(), {
            v: 1, engine: 'builtin', slot: _slot, profile: _profile,
            pid: process.pid, ts: Date.now(),
            cdpPort: parseInt(_cdpPort, 10) || 0, startedAt: _startedAt, hidden: _hidden,
        });
    } catch { /* 下次再写 */ }
}

function _writeReport(reused: boolean): void { _writeReportTo(_flag(FLAG_REPORT), reused); }

function _writeReportTo(reportPath: string | null, reused: boolean): void {
    if (!reportPath) { return; }
    try {
        _atomicWriteJson(reportPath, {
            ok: true, ver: 1, mode: 'browser-host', reused: !!reused,
            engine: 'builtin', slot: _slot, profile: _profile,
            pid: process.pid, cdpPort: parseInt(_cdpPort, 10) || 0,
            dataDir: _userData, hostJson: _hostStateFile(), ts: Date.now(),
            hidden: _hidden,   // 隐藏档（无窗口）：kit 截图前据此决定是否 screencast 唤醒帧
        });
    } catch { /* ignore */ }
}

function _atomicWriteJson(file: string, obj: any): void {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
}
