// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-player.ts — 独立播放器窗（qd 播放器 · 2026-10-02 q319 单宿主大整改 v9）
//   唯一播放形态：Roam Q（单/多选媒体）→ 每次都开新窗口（从不复用；用户自管窗口——
//   多窗 = 多视频/多列表独立播放，零出声互斥）。悬浮层/窗内卡/状态栏豆腐块/收纳交接
//   （stow/return/cardHandoff/popOut/popIn/claim）全部旧机制已删除（2026-10-02 定案）。
//   ★ v17 单宿主域（2026-10-02 q319 定案）: 一切播放器窗只活在宿主进程（joker.exe --qqqide-play）——
//   IDE 进程不再自建播放器窗；Q/右键加入/恢复 = 请求队列转发（player-host.ts 文件系统 IPC；宿主独立
//   userData=Data/player-host 独立单例锁）；双击媒体 = 文件关联直启宿主/转发。IDE 退出与播放无关；
//   宿主最后窗关闭 → 温水滞留 30 分钟（2026-10-02 秒开修复 + v19 常温：期内新窗即取消；到期读 IDE 心跳——IDE 存活即续期〔IDE 存活期恒温〕；IDE 退出/崩溃按温水期真退；空启不滞留）。
//   本模块在宿主域 = 执行面（建窗/恢复/追加全功能）；IDE 域 = 转发面（会话写方唯一 = 宿主——IDE 域 _persist no-op）。
//   编队一等公民：开窗即 claimSquad 默认槽 + 标题 {槽}■{当前轨名}（轨变即刷，refreshWindowEntry）；
//   关窗即 releaseSquad；热键可召回。不隶属任何 IDE 窗口（无 parent/无项目锁）——
//   其他 IDE 窗口关完与它无关；全部窗口（IDE+播放器）都关完才随实例退。
//   持久化：OS 级 player-state.json v2 = 按包分槽会话集 {version:2, packs:{<包根>: {sessions:[...]}}, prefs:{...}}——
//   退出时仍打开的播放器窗下次启动原样恢复（暂停态；与 IDE 窗口 openWindows 同语义）；手动关闭的窗口不恢复。
//   ★ 播放偏好跨窗继承（2026-10-02）：prefs 顶层 = {rate/loop/shuffle/follow/volume/muted}（store 顶层·跨包共享，与 lastPos 同域）——
//   任一窗变更即字段级推进（setSession）；新窗出生读之（显式初值恒胜）；无记录 = 出厂默认（多文件列表 循环开）；
//   恢复窗读自身会话并即刻回种偏好（装载即 _save(true)）。纯逻辑 = shell/player-prefs.ts。
//   旧版 v1 单会话文件首启自动迁移为一条会话。QQQIDE_PLAYER_STATE / QQQIDE_SQUADS_FILE 可覆盖（探针）。
//   ★ v13 新窗位置（2026-10-02 q319 定案）：lastPos（store 顶层·跨包共享）= 上次关闭位置〔getNormalBounds·含退出时关闭〕→ 新窗沿用；
//   无记忆（历史首窗）= 光标所在显示器 workArea 正中；与既有播放器窗重叠（≤8px）→ +28,+28 逐次轻错位；完全离屏 → 钳回最近显示器 workArea（详 _resolveOpenGeom）。
//   ★ mac 配方：alwaysOnTop('screen-saver') + setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})。
//   ★ 窗口外观（v18，2026-10-02 q319）：win32 弃 transparent（layered 窗 drag 区双击被系统吞掉——真机探针实证零消息零最大化；
//   非透明窗恢复系统双击头部条 = 最大化/还原〔双向实证〕+ drag/Aero Snap 全保留；环 = border-box 渐变照常渲染〔像素实证与透明窗逐点一致〕）；
//   他平台维持 transparent。+ CSS 零圆角（IDE 传统直角——真机探针实证 radius 0 时系统不叠加圆角：背窗取色法）
//   + 橙→绿渐变环（与暗主题内置面板同原语，player.html 绘制）；默认几何 音频 860×540 / 视频 940×600；最小恒 540×320（★ 2026-10-03 二轮：宽 600→540 = 左右空气墙清零后 UI 行新地板，详 _PLAYER_MIN_W；高 320 = 编队下拉 8 槽+none ≈296px 装得下 + 240p 视频 x1 可达；2026-10-02 360→320）。
//   ★ 加入播放列表（2026-10-02 q319）：Roam 右键行 → qqqide:player:append——文件夹递归收集媒体（上限 500，报数截断）
//   → 目标 = 最近活跃播放器窗（lastActive = 最后聚焦/最后打开）纯追加（重复路径跳过；不动当前轨/不打断播放）；
//   零窗 → 新建窗装下这批（暂停态）。行可见性：文件夹恒显 / 文件侧仅媒体显（roam 侧判断，零探测）。
// ============================================================================
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getOsBaseDir } from './portable-paths';
import { prefsFromStore, applyPrefsToSession, notePrefChanges, mergePrefsIntoStore } from './player-prefs';
import { climbRevealTarget } from './player-reveal';
import { claimSquad, releaseSquad, refreshWindowEntry, broadcastSquadState } from './squad-manager';
import { getWebappBaseUrl } from './boot';
import { isPlayerHostMode, queuePlayerRequest, startPlayerHostLoop, filesToItems, parsePlayFiles, clearPlayerHostState, playerHostAlive, ensurePlayerHostAlive, touchPlayerHostState, ideKeepaliveFresh, requestIdeReveal } from './player-host';
import { stopPyBroker } from './py-broker';

// ★ 播放器窗最小尺寸（2026-10-03 二轮 q395 用户定案；v20 骨架）：宽 = UI 行「恒单行」地板（最小缩放极限——三路同钳：
//   建窗 minWidth / grip 主进程 clamp（getMinimumSize 动态读）/ OS 拖拽 WM_GETMINMAXINFO）；
//   实测：隔离探针（真页面+真引擎）最紧档（trx 最紧档 + uic 压紧 + 最长计数 500/500 + 最宽倍速 0.06×）530px 内零溢出；
//   取 540（余量 10）——左右空气墙清零（行侧距/dock 外边距→0）后 600→540；仍保 352 宽小视频 x1（目标窗宽 570）可达；
//   禁回 500 以下（会换两行——历史实锤）；>500 条目的超长计数由 .ovmb-uic .ovmb-pos 上限 52px 截断兜底。
const _PLAYER_MIN_W = 540;
const _PLAYER_MIN_H = 320;

// 音频扩展名（仅用于开窗默认尺寸/最小高判定；与引擎 _AUDIO_EXTS / roam 白名单同口径）
const _AUDIO_EXTS: Record<string, 1> = { '.mp3': 1, '.wav': 1, '.flac': 1, '.m4a': 1, '.aac': 1, '.ogg': 1, '.oga': 1, '.opus': 1, '.weba': 1, '.wma': 1, '.aiff': 1, '.aif': 1, '.ape': 1, '.ac3': 1, '.mka': 1, '.amr': 1, '.au': 1 };
// 视频扩展名（Roam 右键「加入播放列表」文件夹递归收集白名单；与 roam _OVERLAY_VIDEO_EXTS / Q 键同口径——注意 .ts 排除）
const _VIDEO_EXTS: Record<string, 1> = { '.mp4': 1, '.m4v': 1, '.webm': 1, '.mkv': 1, '.mov': 1, '.ogv': 1, '.avi': 1, '.wmv': 1, '.flv': 1, '.rmvb': 1, '.rm': 1, '.mpg': 1, '.mpeg': 1, '.m2ts': 1, '.mts': 1, '.3gp': 1, '.vob': 1, '.asf': 1, '.f4v': 1, '.ogm': 1 };

interface PSession {
    list: any[];
    index: number;
    rate: number;
    loop: string;
    shuffle: boolean;
    follow: boolean;
    volume: number;
    muted: boolean;
    dockSide: string;
    pinned: boolean;
    bounds: any;
    name: string;
}
interface PWin { win: BrowserWindow; session: PSession; autoplay: boolean; saveTimer: any; boundsTimer: any; lastActive: number; src: { pid: number; winId: number } | null; }

// ★ 秒开诊断打点（2026-10-02）：窗创建/亮相/滞留事件时刻（相对本模块求值）→ player-host.log
const _modT0 = Date.now();
let _packRoot = '';
let _bootUrl = '';
let _appVersion = '';
let _registered = false;
let _quitting = false;
const _wins = new Map<number, PWin>();

function _stateFile(): string {
    return process.env.QQQIDE_PLAYER_STATE || path.join(getOsBaseDir(), 'qqqide', 'player-state.json');
}
function _packKey(): string { return String(_packRoot || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }

function _readStore(): any {
    try {
        const o = JSON.parse(fs.readFileSync(_stateFile(), 'utf8'));
        if (o && typeof o === 'object' && o.version === 2 && o.packs && typeof o.packs === 'object') { return o; }
    } catch { /* 首次运行/损坏 → 空库 */ }
    return { version: 2, packs: {} };
}
function _writeStore(store: any): void {
    try {
        const f = _stateFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = f + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
        fs.renameSync(tmp, f);
    } catch { /* 静默（下次再写） */ }
}
function _listSessions(): PSession[] {
    const out: PSession[] = [];
    for (const e of _wins.values()) { if (!e.win.isDestroyed()) { out.push(e.session); } }
    return out;
}
let _restoring = false;   // 恢复批次进行中：抑制落盘（防「恢复 3 窗只开 1 窗」的半截列表覆写完整列表）
function _persist(): void {
    // ★ 会话写方唯一 = 宿主（2026-10-02）：IDE 域 _wins 恒空——旧行为在 IDE 退出时以空列表覆写本包槽，
    //   会把宿主「仍打开的窗」快照清掉（下次启动恢复失效）；IDE 域一律 no-op。
    if (!isPlayerHostMode()) { return; }
    if (_restoring) { return; }
    try {
        const fresh = _readStore();   // 磁盘最新（其他实例/包的槽保留——只换本包槽；tmp+rename 原子）
        fresh.packs[_packKey()] = { sessions: _listSessions() };
        _stampPrefs(fresh);           // ★ 偏好字段级合并（待写集非空才写）
        _writeStore(fresh);
    } catch { /* ignore */ }
}
function _persistSoon(en: PWin): void {
    if (en.saveTimer) { clearTimeout(en.saveTimer); }
    en.saveTimer = setTimeout(() => { en.saveTimer = null; _persist(); }, 700);
}

// ── ★ 播放偏好跨窗继承机器（2026-10-02 q319 定案；纯逻辑 = shell/player-prefs.ts）──
//   记忆字段 = {rate/loop/shuffle/follow/volume/muted}（store 顶层 prefs·跨包共享，与 lastPos 同域）——
//   写点 = 任一窗 setSession 真变化（字段级累计，_persist / 关窗写盘时并入）；读点 = 新窗出生（显式初值恒胜）。
let _pendingPrefs: any = null;
function _applyPrefs(sess: PSession, payload: any): void {
    try { applyPrefsToSession(sess, payload, prefsFromStore(_readStore())); } catch { /* ignore */ }
}
function _stampPrefs(fresh: any): void {
    try { if (_pendingPrefs) { mergePrefsIntoStore(fresh, _pendingPrefs); _pendingPrefs = null; } } catch { /* ignore */ }
}

/** v1（单会话旧文件）→ v2 迁移（一次性；空列表直接弃用）。 */
function _ensureStoreV2(): void {
    let raw: any = null;
    try { raw = JSON.parse(fs.readFileSync(_stateFile(), 'utf8')); } catch { raw = null; }
    if (raw && raw.version === 2 && raw.packs) { return; }
    const sessions: any[] = [];
    if (raw && Array.isArray(raw.list) && raw.list.length) {
        sessions.push({
            list: raw.list.slice(0, 2000), index: raw.index | 0,
            rate: raw.rate, loop: raw.loop, shuffle: raw.shuffle, follow: false,
            volume: raw.volume, muted: raw.muted, dockSide: raw.dockSide,
            pinned: raw.pinned !== false, bounds: raw.bounds || null, name: '',
        });
    }
    // ★ v1 存量值顺手种入偏好（首启迁移即得跨窗记忆，零手工）
    const prefs: any = {};
    if (raw) {
        if (typeof raw.rate === 'number' && isFinite(raw.rate)) { prefs.rate = raw.rate; }
        if (raw.loop === 'one' || raw.loop === 'all' || raw.loop === 'off') { prefs.loop = (raw.loop === 'off') ? 'off' : 'all'; }
        if (typeof raw.shuffle === 'boolean') { prefs.shuffle = raw.shuffle; }
        if (typeof raw.volume === 'number' && isFinite(raw.volume)) { prefs.volume = raw.volume; }
        if (typeof raw.muted === 'boolean') { prefs.muted = raw.muted; }
    }
    _writeStore({ version: 2, packs: { [_packKey()]: { sessions } }, prefs });
}

/** 几何校验：吸附到最近显示器 workArea 内（防跑出屏幕外不可见） */
function _clampBounds(b: any): any {
    try {
        if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') { return null; }
        const w = Math.max(320, Math.min(3840, b.w | 0));
        const h = Math.max(200, Math.min(2160, b.h | 0));
        const disp = screen.getDisplayMatching({ x: b.x | 0, y: b.y | 0, width: w, height: h });
        const wa = disp.workArea;
        const x = Math.min(Math.max(b.x | 0, wa.x - 40), wa.x + wa.width - 80);
        const y = Math.min(Math.max(b.y | 0, wa.y - 10), wa.y + wa.height - 40);
        return { x, y, w, h };
    } catch { return null; }
}

function _kindOf(item: any): string {
    const s = String((item && (item.localPath || item.src || item.name)) || '').toLowerCase();
    const i = s.lastIndexOf('.');
    return (i >= 0 && _AUDIO_EXTS[s.substring(i)]) ? 'audio' : 'video';
}
function _baseName(item: any): string {
    const p = String((item && (item.localPath || item.name || item.src)) || '').replace(/\\/g, '/');
    return p.split('/').pop() || '';
}

function _normSession(src: any): PSession {
    const s: PSession = { list: [], index: 0, rate: 1, loop: 'off', shuffle: false, follow: false, volume: 1, muted: false, dockSide: 'right', pinned: true, bounds: null, name: '' };
    if (!src || typeof src !== 'object') { return s; }
    if (Array.isArray(src.list)) { s.list = src.list.filter((it: any) => it && typeof it.localPath === 'string' && it.localPath).slice(0, 2000); }
    if (typeof src.index === 'number') {
        s.index = s.list.length ? Math.max(0, Math.min(s.list.length - 1, src.index | 0)) : 0;
    }
    if (typeof src.rate === 'number' && isFinite(src.rate)) { s.rate = Math.max(0.0625, Math.min(16, src.rate)); }
    if (src.loop === 'one') { s.loop = 'all'; }   // 存量 'one' 归一 'all'（单曲循环档已合并）
    else if (src.loop === 'off' || src.loop === 'all') { s.loop = src.loop; }
    if (typeof src.shuffle === 'boolean') { s.shuffle = src.shuffle; }
    if (typeof src.follow === 'boolean') { s.follow = src.follow; }
    if (typeof src.volume === 'number' && isFinite(src.volume)) { s.volume = Math.max(0, Math.min(1.5, src.volume)); }
    if (typeof src.muted === 'boolean') { s.muted = src.muted; }
    if (src.dockSide === 'left' || src.dockSide === 'right') { s.dockSide = src.dockSide; }
    if (typeof src.pinned === 'boolean') { s.pinned = src.pinned; }
    if (typeof src.name === 'string') { s.name = src.name.slice(0, 200); }
    s.bounds = _clampBounds(src.bounds);
    return s;
}

function _applyAlwaysOnTop(win: BrowserWindow, pinned: boolean): void {
    try {
        win.setAlwaysOnTop(!!pinned, 'screen-saver');
        if (process.platform === 'darwin') {
            try { win.setVisibleOnAllWorkspaces(!!pinned, { visibleOnFullScreen: true }); } catch { /* mac 配方失败静默 */ }
        }
    } catch { /* ignore */ }
}

function _pageUrl(): string {
    // ★ 2026-10-02 v17：统一走 getWebappBaseUrl——dev = 127.0.0.1:8090 实时源（播放器开发即刷新）；
    //   prod = Data/webapp 运行副本（qqqide-webapp://；本调用含协议注册副作用）→ 缺失回退远端 URL。
    // ★ 2026-10-02 绿包实锤修复：getWebappBaseUrl 两形态——打包返回「页面 URL」（…/qqqide/index.html）、
    //   dev 返回「目录 URL」（…/qqqide/）；必须先把 index.html 剥掉再拼子页，否则打包版拼成
    //   …/index.html/player/player.html → ERR_FILE_NOT_FOUND（绿包播放器窗全黑实锤，dev 永不暴露）。
    const _baseDir = (s: any): string => String(s || '').replace(/index\.html?$/i, '').replace(/\/*$/, '/');
    try {
        const isDev = process.argv.includes('--dev') || process.env.QQQIDE_DEV === '1';
        const base = getWebappBaseUrl(_packRoot, { url: String(_bootUrl || ''), healthTimeoutMs: 3000 }, isDev);
        return _baseDir(base) + 'player/player.html';
    } catch {
        return _baseDir(_bootUrl) + 'player/player.html';
    }
}

/** ★ 新窗位置机器（2026-10-02 q319 v13 定案；禁回退「相对焦点窗级联」）：
 *  ① 记忆优先 = lastPos（上次关闭的播放器窗位置；store 顶层跨包共享）→ 新窗沿用
 *  ② 无记忆（历史首窗）= 光标所在显示器 workArea 正中（绝对居中）
 *  ③ 与既有播放器窗重叠（≤8px）→ +28,+28 逐次轻错位（≤16 次——防完全重叠糊死）
 *  ④ 完全离屏（显示器拓扑变化）→ 钳回最近显示器 workArea（部分在屏保持原样——尊重用户半拖出屏意图） */
function _pullIntoDisplays(x: number, y: number, w: number, h: number): { x: number; y: number } {
    try {
        const all = screen.getAllDisplays();
        for (const d of all) {
            const b = d.bounds;
            if (x < b.x + b.width && x + w > b.x && y < b.y + b.height && y + h > b.y) { return { x, y }; }
        }
        let best: any = null, bestD = Infinity;
        const cx = x + w / 2, cy = y + h / 2;
        for (const d of all) {
            const b = d.bounds;
            const dx = (b.x + b.width / 2) - cx, dy = (b.y + b.height / 2) - cy;
            const dist = dx * dx + dy * dy;
            if (dist < bestD) { bestD = dist; best = d; }
        }
        const wa = ((best || screen.getPrimaryDisplay()) as any).workArea;
        return {
            x: Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.width - w)),
            y: Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - h)),
        };
    } catch { return { x, y }; }
}
function _occupiedByPlayer(x: number, y: number): boolean {
    for (const en of _wins.values()) {
        try {
            if (en.win.isDestroyed()) { continue; }
            const b = en.win.getBounds();
            if (Math.abs(b.x - x) <= 8 && Math.abs(b.y - y) <= 8) { return true; }
        } catch { /* ignore */ }
    }
    return false;
}
function _resolveOpenGeom(kind: string): any {
    const w = kind === 'audio' ? 860 : 940;   // ★ v11：默认几何放大（单曲 mp3 也要看得清列表）
    const h = kind === 'audio' ? 540 : 600;
    let px = 0, py = 0;
    let last: any = null;
    try { last = _readStore().lastPos || null; } catch { last = null; }
    if (last && typeof last.x === 'number' && typeof last.y === 'number') {
        px = last.x | 0; py = last.y | 0;                         // ① 记忆优先
    } else {
        let wa: any = null;                                       // ② 历史首窗 = 光标所在显示器正中
        try { wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; } catch { /* ignore */ }
        if (!wa) { try { wa = screen.getPrimaryDisplay().workArea; } catch { wa = { x: 0, y: 0, width: 1280, height: 800 }; } }
        px = Math.round(wa.x + (wa.width - w) / 2);
        py = Math.round(wa.y + (wa.height - h) / 2);
    }
    let c = _pullIntoDisplays(px, py, w, h); px = c.x; py = c.y;  // ④ 离屏钳回
    for (let i = 0; i < 16 && _occupiedByPlayer(px, py); i++) {   // ③ 与既有播放器窗重叠 → 轻错位
        c = _pullIntoDisplays(px + 28, py + 28, w, h); px = c.x; py = c.y;
    }
    return { x: px, y: py, w, h };
}

// ═══ 宿主温水期（2026-10-02 秒开修复；v19 常温升级）═══
//   语义：宿主最后窗关闭后不立即退——滞留 HOST_LINGER_MS 供下次 Q/双击秒开（冷启 ≈ 进程冷启 ~0.9s
//   + 窗口渲染；温水 = 仅窗口渲染）。期内任何新窗即取消滞留；到期复查：零窗且 IDE 心跳断供才真退。
//   ★ 常温（v19）：到期读 ide-alive.json（IDE 主进程 60s 续写）——IDE 存活即续期＝IDE 全存活期恒温
//   （免「每 IDE 会话一次冷启」）；IDE 退出/崩溃 → 心跳断供 → 按温水期正常退（零常驻语义恢复）。
//   从未建窗（空启）不享受温水——维持零常驻（防 requestless 拉起残留）。
const HOST_LINGER_MS = (() => {
    const v = parseInt(String(process.env.QQQIDE_PLAYER_LINGER_MS || ''), 10);
    return (isFinite(v) && v > 0) ? v : 30 * 60 * 1000;   // 探针可覆盖（QQQIDE_PLAYER_LINGER_MS）
})();
let _hadWindow = false;
let _lingerTimer: any = null;
function _cancelHostLinger(why: string): void {
    if (_lingerTimer) {
        clearTimeout(_lingerTimer);
        _lingerTimer = null;
        console.log('[player-host] idle linger canceled (' + why + ')');
    }
}
/** 武装/续期温水计时器（到期：零窗 + IDE 心跳断供 → 真退；IDE 存活 → 续期）。 */
function _armHostLinger(): void {
    if (_lingerTimer) { return; }
    console.log('[player-host] idle linger started (+' + Math.round(HOST_LINGER_MS / 1000) + 's; warm for next open)');
    _lingerTimer = setTimeout(() => {
        _lingerTimer = null;
        try {
            if (_quitting || _wins.size > 0) { return; }
            if (ideKeepaliveFresh()) {                  // ★ IDE 存活 → 续期（常温：IDE 在跑 = 宿主不退）
                console.log('[player-host] linger extended (ide alive)');
                _armHostLinger();
                return;
            }
            console.log('[player-host] linger expired → quit');
            app.quit();
        } catch { /* ignore */ }
    }, HOST_LINGER_MS);
}
/** window-all-closed / 末窗 closed 汇入点（双挂点——事件顺序任一可靠即达）：有窗史 → 温水滞留；空启 → 立即退。 */
export function noteHostAllWindowsClosed(): void {
    try {
        if (_quitting) { return; }
        if (_wins.size > 0) { return; }                 // 防御：仍有窗（理论不可达）
        if (!_hadWindow) { app.quit(); return; }        // 空启（从未建窗）——零常驻
        _armHostLinger();
    } catch { /* ignore */ }
}

/** 打开新播放器窗（从不复用——每次 Q 都是新窗口；restore=true = 启动恢复（暂停态））。 */
export function openPlayerWindow(payload?: any): { ok: boolean; winId?: number; reason?: string } {
    const p = (payload && typeof payload === 'object') ? payload : {};
    const sess = _normSession(p.restore ? p.session : p);
    if (!p.restore) { _applyPrefs(sess, p); }   // ★ 跨窗记忆：新窗从全局偏好初始化（恢复窗读自身会话）
    if (!sess.list.length) { return { ok: false, reason: 'empty' }; }
    _hadWindow = true;
    _cancelHostLinger('new window');
    const kind = _kindOf(sess.list[sess.index] || sess.list[0]);
    const geom = sess.bounds || _resolveOpenGeom(kind);
    const win = new BrowserWindow({
        x: geom.x, y: geom.y,
        // ★ v20：存量几何低于新最小尺寸的（旧会话 500 窄窗）直接抬到地板——防以子地板尺寸建窗（行会溢出）
        width: Math.max(_PLAYER_MIN_W, geom.w | 0), height: Math.max(_PLAYER_MIN_H, geom.h | 0),
        minWidth: _PLAYER_MIN_W,  // ★ v20：UI 行恒单行地板＝最小缩放极限（实测 588 + 余量；禁回 500——换两行实锤）
        minHeight: _PLAYER_MIN_H, // ★ 2026-10-02：360→320——320 = 编队下拉（8 槽+none ≈296px）装得下 + 240p 小视频 x1（像素 1:1）可达地板（360 曾把 x1 钳在半路——小视频 ✓ 恒不亮实锤）
        frame: false, show: false,
        // ★ v18（2026-10-02）：win32 弃 transparent——layered 窗的 drag 区双击被系统吞掉（探针实证：零消息/零最大化）；
        // 非透明窗 = 系统双击头部条原生最大化/还原 + drag/Aero 全保留；环 border-box 渐变照常渲染（像素实证与透明窗逐点一致）。
        transparent: process.platform !== 'win32',
        backgroundColor: process.platform === 'win32' ? '#0b0b0b' : '#00000000',
        title: 'qd (qqqide) Player',
        resizable: true, maximizable: true, minimizable: true, fullscreenable: true,
        acceptFirstMouse: true,
        alwaysOnTop: sess.pinned !== false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: false,
            additionalArguments: [`--qqqide-root=${_packRoot}`, `--qqqide-version=${_appVersion}`],
        },
    });
    try { win.removeMenu(); } catch { /* ignore */ }
    (win as any).__qqqPlayerWin = true;
    // ★ 发起窗侧记（选窗序①）：本次开窗请求来自哪个 IDE 窗——宿主「Roam 定位」优先回原窗（恢复窗/外源恒 null）
    const entry: PWin = {
        win, session: sess, autoplay: p.restore ? false : (p.play !== false), saveTimer: null, boundsTimer: null, lastActive: Date.now(),
        src: (p && p.__src && typeof p.__src.pid === 'number' && typeof p.__src.winId === 'number') ? { pid: p.__src.pid | 0, winId: p.__src.winId | 0 } : null,
    };
    _wins.set(win.id, entry);
    try { console.log('[player-host] win created +' + (Date.now() - _modT0) + 'ms (id=' + win.id + ')'); } catch { /* ignore */ }
    win.on('focus', () => { entry.lastActive = Date.now(); });
    // 编队：开窗即认领默认槽位 + 标题 {槽}■{轨名}（编队标题唯一权威 = squad-manager）
    try {
        claimSquad(win);
        refreshWindowEntry(win, '', sess.name || _baseName(sess.list[sess.index] || sess.list[0]));
        broadcastSquadState();
    } catch { /* ignore */ }
    _applyAlwaysOnTop(win, sess.pinned !== false);
    const _scheduleBounds = (): void => {
        if (entry.boundsTimer) { clearTimeout(entry.boundsTimer); }
        entry.boundsTimer = setTimeout(() => {
            entry.boundsTimer = null;
            if (win.isDestroyed()) { return; }
            try { const b = win.getBounds(); entry.session.bounds = { x: b.x, y: b.y, w: b.width, h: b.height }; } catch { /* ignore */ }
            _persist();
        }, 400);
    };
    win.on('move', _scheduleBounds);
    win.on('resize', _scheduleBounds);
    // 最大化状态回推渲染层（▢ ⇄ ❐ 图标切换；2026-10-02 v10）
    const _sendMaxState = (): void => {
        try { if (!win.isDestroyed()) { win.webContents.send('qqqide:player:maxstate', win.isMaximized()); } } catch { /* ignore */ }
    };
    win.on('maximize', _sendMaxState);
    win.on('unmaximize', _sendMaxState);
    const winId = win.id;
    // ★ 位置记忆（v13）：关闭前先取正常态几何（closed 后窗口已销毁读不到；最大化/最小化下也返回正常态位置）
    let _normAtClose: any = null;
    win.on('close', () => { try { _normAtClose = win.getNormalBounds(); } catch { /* ignore */ } });
    win.on('closed', () => {
        _wins.delete(winId);
        if (_wins.size === 0) { noteHostAllWindowsClosed(); }   // 温水滞留（与 window-all-closed 双挂点）
        try { releaseSquad(winId); broadcastSquadState(); } catch { /* ignore */ }
        // ★ lastPos 写入（v13）：任何关闭（含退出时）都记位置；主动关闭才收敛会话（退出中保留供下次恢复）
        try {
            const fresh = _readStore();
            if (_normAtClose) { fresh.lastPos = { x: _normAtClose.x | 0, y: _normAtClose.y | 0 }; }
            if (!_quitting) { fresh.packs[_packKey()] = { sessions: _listSessions() }; }
            _stampPrefs(fresh);   // ★ 偏好落盘（关窗即刷）
            _writeStore(fresh);
        } catch { /* ignore */ }
    });
    // ★ 开窗链诊断打点（2026-10-02 实测补充）：dom ready（脚本全量求值完）/ 首媒体起播 / 加载失败——
    //   与既有 boot / win created / win shown 同一现场（player-host.log；ASCII 串恒守）。
    //   实测口径（2026-10-02）：暖路径 created→shown ≈0.2~0.4s、shown→dom ready ≈+0.14s、dom ready→media ≈+0.3s（Chromium 媒体管线上线，主线程空转等）。
    win.webContents.on('dom-ready', () => { try { console.log('[player-host] dom ready +' + (Date.now() - _modT0) + 'ms (id=' + winId + ')'); } catch { /* ignore */ } });
    win.webContents.on('media-started-playing', () => { try { console.log('[player-host] media started +' + (Date.now() - _modT0) + 'ms (id=' + winId + ')'); } catch { /* ignore */ } });
    win.webContents.on('did-fail-load', (_e: any, code: number, desc: string) => { try { console.log('[player-host] load failed ' + code + ' ' + String(desc || '').slice(0, 80) + ' (id=' + winId + ')'); } catch { /* ignore */ } });
    win.once('ready-to-show', () => {
        try { console.log('[player-host] win shown +' + (Date.now() - _modT0) + 'ms (id=' + winId + ')'); } catch { /* ignore */ }
        try { win.show(); win.focus(); } catch { /* ignore */ }
    });
    win.loadURL(_pageUrl()).catch(() => {
        console.warn('[player] loadURL failed');
        try { win.close(); } catch { /* ignore */ }
    });
    if (!p.restore) { _persist(); }   // 入档即写（恢复批次由 restorePlayerSessions 统一落盘一次）
    return { ok: true, winId: win.id };
}

/** 启动恢复：把「上次退出时仍打开」的播放器窗原样恢复（暂停态；按包分槽——多实例互不串）。 */
export function restorePlayerSessions(): void {
    try {
        const st = _readStore();
        const pack = st.packs[_packKey()];
        const list = (pack && Array.isArray(pack.sessions)) ? pack.sessions : [];
        _restoring = true;
        try {
            for (const s of list) {
                try { if (s && Array.isArray(s.list) && s.list.length) { openPlayerWindow({ restore: true, session: s }); } } catch { /* ignore */ }
            }
        } finally { _restoring = false; }
        _persist();   // 恢复完统一落盘一次（与恢复前列表等值——原子替换，半截永不覆写）
    } catch { _restoring = false; }
}

/** 上次退出时仍有未关播放器窗？（宿主自恢复的触发条件——IDE 启动时据此决定是否拉宿主） */
export function hasRestorableSessions(): boolean {
    try {
        const st = _readStore();
        const pack = st.packs[_packKey()];
        const list = (pack && Array.isArray(pack.sessions)) ? pack.sessions : [];
        return list.some((s: any) => s && Array.isArray(s.list) && s.list.length > 0);
    } catch { return false; }
}

/** IDE 启动钩子：有可恢复会话且宿主不在 → 拉起宿主（宿主自恢复；IDE 域零窗口操作）。 */
export function kickPlayerHostForRestore(): void {
    try {
        if (isPlayerHostMode()) { return; }
        if (!hasRestorableSessions()) { return; }
        if (playerHostAlive()) { return; }   // 宿主在跑 = 窗口是活的（sessions 仅快照）——绝不重复拉起
        ensurePlayerHostAlive();
    } catch { /* ignore */ }
}

// ═══ 外部文件批聚合（2026-10-02 v17 补）═══
//   Windows 多选「双击打开」= Explorer 逐文件启动命令（或按 MultiSelectModel=Player 一次调用传全部——fa-ps 已注册）→
//   逐进程转发到宿主。语义 = 同一批（相邻到达 ≤ _EXT_BATCH_MS 滑动窗）聚合进首窗列表——与 Q 多选=一窗列表
//   一致（单文件双击零延迟立即开窗；超窗 = 用户有意连开 → 恒开新窗）；追加绝不动当前轨/不打断播放。
//   ★ 仅 external（argv/second-instance）来源参与聚合；IDE 转发的 Q/右键加入（queue 来源）恒走各自语义。
let _lastExtWinId = -1;
let _lastExtAt = 0;
const _EXT_BATCH_MS = 1200;
function _openExternalFiles(items: any[]): any {
    const now = Date.now();
    if (_lastExtWinId >= 0 && (now - _lastExtAt) < _EXT_BATCH_MS) {
        const en = _wins.get(_lastExtWinId) || null;
        if (en && !en.win.isDestroyed()) {
            try {
                const exist = new Set<string>();
                for (const it of en.session.list) { exist.add(String((it && it.localPath) || '').replace(/\\/g, '/').toLowerCase()); }
                const fresh = items.filter((it) => !exist.has(String((it && it.localPath) || '').replace(/\\/g, '/').toLowerCase()));
                const room = Math.max(0, 2000 - en.session.list.length);
                const add = fresh.slice(0, room);
                if (add.length) {
                    for (const it of add) { en.session.list.push(it); }
                    en.lastActive = Date.now();
                    _persist();
                    try { en.win.webContents.send('qqqide:player:append', { items: add }); } catch { /* ignore */ }
                }
                _lastExtAt = now;
                return { ok: true, merged: add.length, winId: _lastExtWinId };
            } catch { /* 落回新窗 */ }
        }
    }
    const r = openPlayerWindow({ list: items, index: 0, play: true });
    if (r && r.ok && typeof r.winId === 'number') { _lastExtWinId = r.winId; _lastExtAt = now; }
    return r;
}

// ═══ 宿主运行时（--qqqide-play；2026-10-02 v17 单宿主域）═══
//   启动序（禁乱序）：① 先写心跳（防 IDE 误判失活重复拉启）② 恢复上次未关会话（暂停态）
//   ③ 本进程 argv 文件（双击/多选直启）④ 队列循环入位（watch + 启动清扫 + 二实例早到批次）
//   ⑤ 零窗自退（既无会话也无请求 = 空启，不当常驻）——有窗史则走温水滞留（详上「宿主温水期」）。
//   ★ 禁把④（含启动清扫）排到②之前：清扫开窗会先落盘一笔会话，②再读盘恢复 → 同窗双开（探针实锤）。
function _dispatchRequest(req: any): any {
    if (!req || typeof req !== 'object') { return { ok: false, reason: 'bad_request' }; }
    if (req.kind === 'open') {
        const p = req.payload || {};
        if (p.external && Array.isArray(p.list)) { return _openExternalFiles(p.list); }   // 外部文件批聚合（v17 补）
        return openPlayerWindow(p);
    }
    if (req.kind === 'append') { return _appendToPlayer(req.payload || {}); }
    return { ok: false, reason: 'unknown_kind' };
}
function _startHostRuntime(): void {
    touchPlayerHostState();                                    // ① 心跳先写
    try { restorePlayerSessions(); } catch { /* ignore */ }    // ② 恢复（早于清扫——禁乱序）
    try {
        const files = parsePlayFiles(process.argv);
        if (files.length) { _dispatchRequest({ kind: 'open', payload: { list: filesToItems(files), index: 0, play: true, external: true } }); }
    } catch { /* ignore */ }                                   // ③ argv 直启
    startPlayerHostLoop((req: any) => _dispatchRequest(req));  // ④ 队列循环（watch + 启动清扫）
    const emptyTimer = setTimeout(() => {
        // ★ 零窗自退（空启：既无会话也无请求 = 不当常驻）；已进入温水滞留的宿主不在此列（滞留自有到期退出）
        try { if (_wins.size === 0 && !_quitting && !_lingerTimer) { app.quit(); } } catch { /* ignore */ }
    }, 900);
    if (typeof (emptyTimer as any).unref === 'function') { (emptyTimer as any).unref(); }
}

// ═══ 加入播放列表（2026-10-02 q319）：Roam 右键行 → 媒体收集 → 最近活跃播放器窗纯追加 / 无窗新建（暂停态）═══
const _MPL_MAX = 500;            // 单次加入上限（文件夹递归收集截断报数）
const _MPL_SCAN_MAX = 100000;    // 扫描节点上限（防病态大目录）
const _MPL_SCAN_MS = 8000;       // 扫描时间预算（右键动作不挂死）
function _isMediaPath(p: string): boolean {
    const s = String(p || '').toLowerCase();
    const i = s.lastIndexOf('.');
    if (i < 0) { return false; }
    const ext = s.substring(i);
    return !!(_AUDIO_EXTS[ext] || _VIDEO_EXTS[ext]);
}
/** 路径自然序（01/02/10 顺序；与 roam naturalCompare 同语义——仅文件夹内容排序用，显式文件保持选择原序） */
function _naturalCmp(a: string, b: string): number {
    const re = /(\d+)|(\D+)/g;
    const ap = String(a).match(re) || [];
    const bp = String(b).match(re) || [];
    const n = Math.max(ap.length, bp.length);
    for (let i = 0; i < n; i++) {
        const x = ap[i] || '', y = bp[i] || '';
        const xn = parseInt(x, 10), yn = parseInt(y, 10);
        if (!isNaN(xn) && !isNaN(yn)) { if (xn !== yn) { return xn - yn; } }
        else {
            const xl = x.toLowerCase(), yl = y.toLowerCase();
            if (xl !== yl) { return xl < yl ? -1 : 1; }
            if (x !== y) { return x < y ? -1 : 1; }
        }
    }
    return 0;
}
/** 递归收集文件夹内媒体（符号链接跳过防环；媒体上限/扫描节点/时间三重闸门 → trunc 报数） */
async function _collectDirMedia(dir: string, out: string[], st: { n: number; trunc: boolean; deadline: number }): Promise<void> {
    if (out.length >= _MPL_MAX) { st.trunc = true; return; }
    if (st.n >= _MPL_SCAN_MAX || Date.now() > st.deadline) { st.trunc = true; return; }
    try {
        const ents = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of ents) {
            if (out.length >= _MPL_MAX) { st.trunc = true; return; }
            if (st.n >= _MPL_SCAN_MAX || Date.now() > st.deadline) { st.trunc = true; return; }
            st.n++;
            if (e.isSymbolicLink()) { continue; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { await _collectDirMedia(full, out, st); }
            else if (e.isFile() && _isMediaPath(e.name)) { out.push(full); }
        }
    } catch { /* 读失败/单目录异常 → 跳过 */ }
}
/** 目标窗 = 最近活跃（最后聚焦/最后打开；禁回退「第一个」——多窗用户自管） */
function _pickActiveWin(): PWin | null {
    let best: PWin | null = null;
    for (const en of _wins.values()) {
        try { if (en.win.isDestroyed()) { continue; } } catch { continue; }
        if (!best || (en.lastActive || 0) > (best.lastActive || 0)) { best = en; }
    }
    return best;
}
function _trackTitle(en: PWin): string {
    try {
        const it = en.session.list[en.session.index] || en.session.list[0] || null;
        return en.session.name || (it ? _baseName(it) : '');
    } catch { return ''; }
}
/** Roam 右键「加入播放列表」全权处理：收集媒体 → 最近活跃窗纯追加（重复跳过；不动当前轨/不打断播放）；
 *  无窗 → 新建窗装下这批（暂停态）。返回 {ok, added, dup, ignored, truncated, created, title}。 */
async function _appendToPlayer(payload: any): Promise<any> {
    try {
        const raw = (payload && Array.isArray(payload.paths)) ? payload.paths : [];
        const paths = raw.filter((p: any) => typeof p === 'string' && p).slice(0, 200);
        if (!paths.length) { return { ok: false, reason: 'empty' }; }
        const media: string[] = [];
        const st = { n: 0, trunc: false, deadline: Date.now() + _MPL_SCAN_MS };
        let ignored = 0;
        for (const p of paths) {
            if (media.length >= _MPL_MAX) { st.trunc = true; break; }
            let isDir = false, isFile = false;
            try { const s = await fs.promises.stat(p); isDir = s.isDirectory(); isFile = s.isFile(); } catch { /* 不可达 → ignored */ }
            if (isDir) {
                const sub: string[] = [];
                await _collectDirMedia(p, sub, st);
                sub.sort(_naturalCmp);              // 文件夹内容 = 路径自然序（01/02/10）
                for (const f of sub) { media.push(f); }
            } else if (isFile && _isMediaPath(p)) { media.push(p); }   // 显式文件 = 保持选择原序
            else { ignored++; }
        }
        if (!media.length) { return { ok: false, reason: 'none', ignored: ignored }; }
        const seen = new Set<string>();          // 批内去重（保序）+ 上限
        const uniq: string[] = [];
        for (const p of media) {
            const k = p.replace(/\\/g, '/').toLowerCase();
            if (seen.has(k)) { continue; }
            seen.add(k); uniq.push(p);
            if (uniq.length >= _MPL_MAX) { st.trunc = true; break; }
        }
        const mkItem = (p: string) => { const fp = p.replace(/\\/g, '/'); return { src: 'file:///' + fp, localPath: fp, name: path.basename(p) }; };
        const tgt = _pickActiveWin();
        if (tgt) {
            const exist = new Set<string>();
            for (const it of tgt.session.list) { exist.add(String((it && it.localPath) || '').replace(/\\/g, '/').toLowerCase()); }
            let fresh = uniq.filter((p) => !exist.has(p.replace(/\\/g, '/').toLowerCase()));
            const dup = uniq.length - fresh.length;
            const room = Math.max(0, 2000 - tgt.session.list.length);
            if (fresh.length > room) { fresh = fresh.slice(0, room); st.trunc = true; }
            if (fresh.length) {
                const items = fresh.map(mkItem);
                for (const it of items) { tgt.session.list.push(it); }
                tgt.lastActive = Date.now();
                if (payload && payload.__src && typeof payload.__src.winId === 'number') {
                    tgt.src = { pid: payload.__src.pid | 0, winId: payload.__src.winId | 0 };   // 发起窗随最新一次加入推进
                }
                _persist();
                try { if (!tgt.win.isDestroyed()) { tgt.win.webContents.send('qqqide:player:append', { items }); } } catch { /* ignore */ }
                return { ok: true, added: items.length, dup, ignored, truncated: st.trunc, created: false, title: _trackTitle(tgt) };
            }
            return { ok: true, added: 0, dup, ignored, truncated: false, created: false, title: _trackTitle(tgt) };
        }
        const items = uniq.map(mkItem);
        const r = openPlayerWindow({ list: items, index: 0, play: false, __src: (payload && payload.__src) || null });   // 无窗 → 新建（暂停态；携发起窗侧记）
        if (!r.ok) { return { ok: false, reason: r.reason || 'open_failed' }; }
        return { ok: true, added: items.length, dup: 0, ignored, truncated: st.trunc, created: true, title: _baseName(items[0]) };
    } catch { return { ok: false, reason: 'error' }; }
}

function _entryOf(e: any): PWin | null {
    try {
        const win = BrowserWindow.fromWebContents(e.sender);
        return win ? (_wins.get(win.id) || null) : null;
    } catch { return null; }
}

/** 发起窗侧记（IDE 域）：本次请求来自哪个 IDE 窗（{pid,winId}）——宿主「Roam 定位」据此优先回原窗（选窗序①）。 */
function _srcOf(e: any): { pid: number; winId: number } | null {
    try {
        if (isPlayerHostMode()) { return null; }
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed()) { return null; }
        return { pid: process.pid, winId: win.id };
    } catch { return null; }
}

/** 系统文件管理器兜底定位（宿主跨进程通道失败时统一收口）：存在 → 选中；缺失 → 爬升最近存在祖先；全无 → 失败。 */
function revealViaFileManager(p: string): { ok: boolean; reason?: string } {
    let s = String(p || '').trim();
    if (!s) { return { ok: false, reason: 'empty' }; }
    try { s = path.normalize(s); } catch { /* keep */ }
    const exists = (c: string): boolean => { try { return fs.existsSync(c); } catch { return false; } };
    try {
        if (exists(s)) { shell.showItemInFolder(s); return { ok: true }; }
        const near = climbRevealTarget(s, exists);
        if (near) {
            let isDir = false;
            try { isDir = fs.statSync(near).isDirectory(); } catch { /* ignore */ }
            if (isDir) { shell.openPath(near); } else { shell.showItemInFolder(near); }
            return { ok: true };
        }
    } catch { /* ignore */ }
    return { ok: false, reason: 'missing' };
}

export function registerPlayerIpc(root: string, bootUrl: string, appVersion: string): void {
    if (_registered) { return; }
    _registered = true;
    _packRoot = root;
    _bootUrl = bootUrl;
    _appVersion = appVersion;
    _ensureStoreV2();

    // 退出放行：退出中窗口关闭 = 保留会话（下次启动恢复）；不再有任何「随实例退」连带关闭（播放器独立）
    app.on('before-quit', () => {
        _quitting = true;
        _persist();
        if (isPlayerHostMode()) {
            try { clearPlayerHostState(); } catch { /* ignore */ }        // 宿主退出：失活即时可判
            try { stopPyBroker(); } catch { /* ignore */ }               // ★ v17 补：显式停 py-broker（与 IDE 域对称——
            //   禁单靠 stdin EOF 兜底：宿主 spawn 的 broker 必须随宿主确定性收尾，防孤儿持有热键互斥量）
        }
    });

    // ★ 单宿主域分派（2026-10-02 v17）：宿主域 = 本进程执行；IDE 域 = 请求队列转发（player-host.ts）
    ipcMain.handle('qqqide:player:open', (e, payload: any) => {
        try {
            if (isPlayerHostMode()) { return openPlayerWindow(payload); }
            const src = _srcOf(e);   // ★ 发起窗侧记（选窗序①：宿主「Roam 定位」优先回原窗）
            return queuePlayerRequest('open', Object.assign({}, payload || {}, src ? { __src: src } : {}), 0);   // 队列入档 + 宿主失活自动拉起（每次 Q 都开新窗语义在宿主内保持）
        } catch { return { ok: false }; }
    });

    // ★ 加入播放列表（2026-10-02 q319）：Roam 右键行 → 收集媒体 → 目标窗纯追加 / 无窗新建（暂停态）
    ipcMain.handle('qqqide:player:append', (e, payload: any) => {
        try {
            if (isPlayerHostMode()) { return _appendToPlayer(payload); }
            const src = _srcOf(e);   // ★ 发起窗侧记（追加亦属发起行为——最新一次加入推进侧记）
            return queuePlayerRequest('append', Object.assign({}, payload || {}, src ? { __src: src } : {}), 8000);   // 带回复等待（roam 依结果出 qoast）
        } catch { return { ok: false, reason: 'error' }; }
    });

    // 本窗会话（渲染层启动即取；autoplay = 全新打开 true / 启动恢复 false）
    ipcMain.handle('qqqide:player:session', (e) => {
        const en = _entryOf(e);
        if (!en) { return { ok: false }; }
        return { ok: true, session: en.session, autoplay: en.autoplay };
    });

    ipcMain.handle('qqqide:player:setSession', (e, patch: any) => {
        try {
            const en = _entryOf(e);
            if (!en) { return { ok: false }; }
            const s = en.session;
            if (patch && typeof patch === 'object') {
                if (Array.isArray(patch.list)) { s.list = patch.list.filter((it: any) => it && typeof it.localPath === 'string' && it.localPath).slice(0, 2000); }
                if (typeof patch.index === 'number') { s.index = s.list.length ? Math.max(0, Math.min(s.list.length - 1, patch.index | 0)) : 0; }
                if (typeof patch.rate === 'number' && isFinite(patch.rate)) { s.rate = Math.max(0.0625, Math.min(16, patch.rate)); }
                if (patch.loop === 'one') { s.loop = 'all'; }   // 存量 'one' 归一 'all'（单曲循环档已合并）
                else if (patch.loop === 'off' || patch.loop === 'all') { s.loop = patch.loop; }
                if (typeof patch.shuffle === 'boolean') { s.shuffle = patch.shuffle; }
                if (typeof patch.follow === 'boolean') { s.follow = patch.follow; }
                if (typeof patch.volume === 'number' && isFinite(patch.volume)) { s.volume = Math.max(0, Math.min(1.5, patch.volume)); }
                if (typeof patch.muted === 'boolean') { s.muted = patch.muted; }
                if (patch.dockSide === 'left' || patch.dockSide === 'right') { s.dockSide = patch.dockSide; }
                _pendingPrefs = notePrefChanges(_pendingPrefs, patch, s);   // ★ 偏好字段级推进（跨窗记忆写点）
            }
            _persistSoon(en);
            return { ok: true };
        } catch { return { ok: false }; }
    });

    // 标题（当前轨名）→ 编队标题 {槽}■{名} 唯一权威刷新
    ipcMain.handle('qqqide:player:setTitle', (e, name: string) => {
        try {
            const en = _entryOf(e);
            if (!en) { return { ok: false }; }
            const n = String(name || '').slice(0, 200);
            en.session.name = n;
            refreshWindowEntry(en.win, '', n || _baseName(en.session.list[en.session.index]));
            _persistSoon(en);
            return { ok: true };
        } catch { return { ok: false }; }
    });

    ipcMain.handle('qqqide:player:setPin', (e, on: boolean) => {
        try {
            const en = _entryOf(e);
            if (!en) { return { ok: false }; }
            en.session.pinned = !!on;
            _applyAlwaysOnTop(en.win, !!on);
            _persistSoon(en);
            return { ok: true };
        } catch { return { ok: false }; }
    });

    // 窗控（2026-10-02 v10）：最小化 / 最大化·还原（状态经 qqqide:player:maxstate 事件回推——渲染层切图标）
    ipcMain.handle('qqqide:player:minimize', (e) => {
        try { const en = _entryOf(e); if (en && !en.win.isDestroyed()) { en.win.minimize(); } return { ok: true }; } catch { return { ok: false }; }
    });

    ipcMain.handle('qqqide:player:maximize', (e) => {
        try {
            const en = _entryOf(e);
            if (!en || en.win.isDestroyed()) { return { ok: false }; }
            if (en.win.isMaximized()) { en.win.unmaximize(); } else { en.win.maximize(); }
            return { ok: true, maximized: en.win.isMaximized() };
        } catch { return { ok: false }; }
    });

    ipcMain.handle('qqqide:player:close', (e) => {
        try { const en = _entryOf(e); if (en) { en.win.close(); } return { ok: true }; } catch { return { ok: false }; }
    });

    // 截图「📂 Roam 定位」（2026-10-03 q319 跨进程重设计）：宿主域 = 请求同安装 IDE（reveals 队列 → 「正在操作滴」IDE
    //   主窗强制召回〔选窗序详 player-reveal.ts；restore+moveTop+focus〕 + 投递 __qqq_roamRevealPath → ack 裁决——旧「进程内找主窗」在单宿主域结构性必败〔宿主进程恒无
    //   IDE 窗〕只剩系统定位兜底）；无 IDE/无窗/投递失败/超时 → 系统文件管理器兜底（爬升最近存在祖先）。
    //   IDE 域分支 = 进程内防御直投（正常不可达——播放器窗只存在于宿主进程）。
    ipcMain.handle('qqqide:player:reveal', async (e, p: string) => {
        const target = String(p || '');
        if (isPlayerHostMode()) {
            const en = _entryOf(e);
            const r = await requestIdeReveal(target, (en && en.src) ? en.src : null);
            if (r && r.ok) { return { ok: true, via: 'roam' }; }
            const fb = revealViaFileManager(target);
            return { ok: fb.ok, via: 'fs', reason: (r && r.reason) || fb.reason };
        }
        try {
            const self = BrowserWindow.fromWebContents(e.sender);
            const mw = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== self && (w as any).__qqqMainWindow);
            if (mw) {
                mw.webContents.executeJavaScript(
                    `(function(){ if (window.__qqq_roamRevealPath) window.__qqq_roamRevealPath(${JSON.stringify(target)}); })()`
                ).catch(() => { /* ignore */ });
                return { ok: true, via: 'roam' };
            }
            const fb = revealViaFileManager(target);
            return { ok: fb.ok, via: 'fs', reason: 'no_window' };
        } catch { return { ok: false }; }
    });

    // 「Roam 定位」标签决策（2026-10-03）：宿主域按同安装 IDE 心跳是否新鲜 → 'roam' | 'fs'
    //   （仅决定截图提示按钮文案；click 仍由 reveal 恒活裁决兜底；旧宿主无此通道 → 前端回落 Roam 文案）
    ipcMain.handle('qqqide:player:reveal-mode', () => {
        try {
            if (isPlayerHostMode()) { return { ok: true, mode: ideKeepaliveFresh() ? 'roam' : 'fs' }; }
            return { ok: true, mode: 'roam' };
        } catch { return { ok: false, mode: 'roam' }; }
    });

    // ★ 宿主域：运行时就绪（心跳/恢复/argv/队列/零窗自退）——置于全部 handler 注册之后
    if (isPlayerHostMode()) { _startHostRuntime(); }
}
