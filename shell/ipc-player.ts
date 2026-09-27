// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-player.ts — 独立悬浮播放器窗（qd 播放器，2026-09-26 q319 v6）
//   打开三路：悬浮层 ↗ 弹出 / Roam ➕「加入播放列表」/ 工作台 Player 行。
//   退回一路（v6）：窗内 ↙「退回悬浮层」→ returnOverlay 整体交接回主窗悬浮层（主窗收 qqqide:player:return 后开层，本窗自关）。
//   状态 OS 级持久化 player-state.json（列表/当前轨/模式/倍速/音量/窗口几何/置顶）；
//   出声独占：claim 广播（悬浮层 ↔ 播放器窗互相自动暂停——各自渲染层监听自理）；
//   生命周期：不入编队（不 claimSquad）/ 不入项目锁 / 不入窗口恢复（无项目文件夹注册）；
//   最后一个 qd 窗口关闭 → 播放器随实例退（不隐身续播）。
//   ★ mac 配方：alwaysOnTop('screen-saver') + setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})
//     → 跨 Space / 覆盖全屏应用（浮层标准配方）；win/linux 仅 alwaysOnTop。
// ============================================================================
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getDataDir, getOsBaseDir } from './portable-paths';

let _playerWin: BrowserWindow | null = null;
let _state: any = null;
let _saveTimer: any = null;
let _boundsTimer: any = null;
let _pendingHandoff: any = null;
let _bootUrl = '';
let _root = '';
let _appVersion = '';
let _registered = false;

function _stateFile(): string { return path.join(getOsBaseDir(), 'qqqide', 'player-state.json'); }

function _loadState(): any {
    if (_state) { return _state; }
    try {
        const raw = fs.readFileSync(_stateFile(), 'utf8');
        const o = JSON.parse(raw);
        if (o && typeof o === 'object') { _state = o; return _state; }
    } catch { /* 首次运行 */ }
    _state = { list: [], index: 0, rate: 1, loop: 'off', shuffle: false, volume: 1, muted: false, bounds: null, pinned: true, dockSide: 'right', card: null };
    return _state;
}

/** 窗内播放器卡几何校验（v5）：仅接受完整数值矩形；缺值/非法 → null（保留旧值） */
function _clampCardGeom(g: any): any {
    try {
        if (!g || typeof g.x !== 'number' || typeof g.y !== 'number' || typeof g.w !== 'number' || typeof g.h !== 'number') { return null; }
        return {
            x: g.x | 0, y: g.y | 0,
            w: Math.max(300, Math.min(4096, g.w | 0)),
            h: Math.max(120, Math.min(2160, g.h | 0)),
        };
    } catch { return null; }
}

function _saveStateNow(): void {
    try {
        const f = _stateFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = f + '.' + process.pid + '.' + Date.now() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(_state || {}), 'utf8');
        fs.renameSync(tmp, f);
    } catch { /* 静默（下次再写） */ }
}
function _saveStateDebounced(): void {
    if (_saveTimer) { clearTimeout(_saveTimer); }
    _saveTimer = setTimeout(() => { _saveTimer = null; _saveStateNow(); }, 700);
}

/** 几何校验：吸附到最近显示器 workArea 内（防跑出屏幕外不可见） */
function _clampBounds(b: any): any {
    try {
        if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') { return null; }
        const w = Math.max(320, Math.min(4096, b.w | 0));
        const h = Math.max(60, Math.min(2160, b.h | 0));
        const disp = screen.getDisplayMatching({ x: b.x | 0, y: b.y | 0, width: w, height: h });
        const wa = disp.workArea;
        const x = Math.min(Math.max(b.x | 0, wa.x - 40), wa.x + wa.width - 80);
        const y = Math.min(Math.max(b.y | 0, wa.y - 10), wa.y + wa.height - 40);
        return { x, y, w, h };
    } catch { return null; }
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
    let base = String(_bootUrl || '').replace(/\/*$/, '/');
    try {
        if (fs.existsSync(path.join(getDataDir(), 'webapp', 'index.html'))) {
            base = 'qqqide-webapp://app/qqqide/';
        }
    } catch { /* ignore */ }
    return base + 'player/player.html';
}

function _sendToPlayer(channel: string, payload: any): void {
    try {
        if (_playerWin && !_playerWin.isDestroyed()) { _playerWin.webContents.send(channel, payload); }
    } catch { /* ignore */ }
}

export function openPlayerWindow(handoff?: any): { ok: boolean; reused?: boolean } {
    if (handoff) { _pendingHandoff = handoff; }
    if (_playerWin && !_playerWin.isDestroyed()) {
        try { if (_playerWin.isMinimized()) { _playerWin.restore(); } } catch { /* ignore */ }
        try { _playerWin.show(); _playerWin.focus(); } catch { /* ignore */ }
        if (handoff) { _deliverHandoff(); }
        return { ok: true, reused: true };
    }
    const st = _loadState();
    const b = _clampBounds(st.bounds) || {};
    const win = new BrowserWindow({
        x: b.x, y: b.y,
        width: b.w || 560, height: b.h || 320,
        minWidth: 320, minHeight: 60,
        frame: false, show: false,
        backgroundColor: '#0b0b0b',
        title: 'qd (qqqide) Player',
        resizable: true, maximizable: false, minimizable: true,
        fullscreenable: true,
        acceptFirstMouse: true,   // mac：首次点击 = 激活 + 命中控件（悬浮小窗体验）
        alwaysOnTop: st.pinned !== false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: false,
            additionalArguments: [
                `--qqqide-root=${_root}`,
                `--qqqide-version=${_appVersion}`,
            ],
        },
    });
    try { win.removeMenu(); } catch { /* ignore */ }
    _playerWin = win;
    win.on('move', () => _scheduleBoundsSave());
    win.on('resize', () => _scheduleBoundsSave());
    win.on('closed', () => { _playerWin = null; _saveStateNow(); });
    win.once('ready-to-show', () => {
        try { win.show(); win.focus(); } catch { /* ignore */ }
    });
    _applyAlwaysOnTop(win, st.pinned !== false);
    win.loadURL(_pageUrl()).catch(() => {
        console.warn('[player] loadURL failed');
        try { win.close(); } catch { /* ignore */ }
    });
    return { ok: true };
}

function _scheduleBoundsSave(): void {
    if (_boundsTimer) { clearTimeout(_boundsTimer); }
    _boundsTimer = setTimeout(() => {
        _boundsTimer = null;
        if (!_playerWin || _playerWin.isDestroyed()) { return; }
        try {
            const b = _playerWin.getBounds();
            const st = _loadState();
            st.bounds = { x: b.x, y: b.y, w: b.width, h: b.height };
            _saveStateDebounced();
        } catch { /* ignore */ }
    }, 400);
}

function _deliverHandoff(): void {
    if (!_pendingHandoff) { return; }
    const p = _pendingHandoff;
    _pendingHandoff = null;
    _sendToPlayer('qqqide:player:handoff', p);
}

/** 最后一个 qd（非播放器）窗口关闭 → 播放器随实例退（不隐身续播） */
function _closePlayerIfOrphan(): void {
    if (!_playerWin || _playerWin.isDestroyed()) { return; }
    try {
        const others = BrowserWindow.getAllWindows().filter((w) => w !== _playerWin && !w.isDestroyed());
        if (others.length === 0) { _playerWin.close(); }
    } catch { /* ignore */ }
}

function _broadcastClaim(from: string): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
            try { w.webContents.send('qqqide:player:claim', String(from || '')); } catch { /* ignore */ }
        }
    }
}

/** 列表项归一：{ src, localPath, name }（与悬浮层播放列表同构） */
function _mkItem(p: string): any {
    const np = String(p).replace(/\\/g, '/');
    return { src: 'file:///' + np, localPath: np, name: np.split('/').pop() || '' };
}

export function registerPlayerIpc(root: string, bootUrl: string, appVersion: string): void {
    if (_registered) { return; }
    _registered = true;
    _root = root;
    _bootUrl = bootUrl;
    _appVersion = appVersion;
    _loadState();

    // 孤立回收网：任何窗口关闭后核查（播放器自身除外）
    const track = (w: BrowserWindow) => { try { w.on('closed', _closePlayerIfOrphan); } catch { /* ignore */ } };
    try { BrowserWindow.getAllWindows().forEach(track); } catch { /* ignore */ }
    app.on('browser-window-created', (_e, w) => track(w));
    // ★ 退出放行：菜单退出/系统退出 → 播放器随实例退（不阻塞 window-all-closed）
    app.on('before-quit', () => {
        try { if (_playerWin && !_playerWin.isDestroyed()) { _playerWin.destroy(); } } catch { /* ignore */ }
        _playerWin = null;
        _saveStateNow();
    });

    ipcMain.handle('qqqide:player:open', () => {
        try { return openPlayerWindow(); } catch { return { ok: false }; }
    });

    ipcMain.handle('qqqide:player:getState', () => {
        const handoff = _pendingHandoff;
        _pendingHandoff = null;
        return { ok: true, state: _loadState(), handoff: handoff || null };
    });

    ipcMain.handle('qqqide:player:setState', (_e, patch: any) => {
        try {
            const st = _loadState();
            if (patch && typeof patch === 'object') {
                if (Array.isArray(patch.list)) { st.list = patch.list.slice(0, 2000); }
                if (typeof patch.index === 'number') { st.index = Math.max(0, patch.index | 0); }
                if (typeof patch.rate === 'number') { st.rate = patch.rate; }
                if (patch.loop === 'off' || patch.loop === 'all' || patch.loop === 'one') { st.loop = patch.loop; }
                if (typeof patch.shuffle === 'boolean') { st.shuffle = patch.shuffle; }
                if (typeof patch.volume === 'number') { st.volume = Math.max(0, Math.min(1, patch.volume)); }
                if (typeof patch.muted === 'boolean') { st.muted = patch.muted; }
                if (patch.dockSide === 'left' || patch.dockSide === 'right') { st.dockSide = patch.dockSide; }
                // ★ 窗内播放器卡状态（v5）：{ open, dockSide, video:{x,y,w,h}, audio:{...} }——几何缺值保留旧值
                if (patch.card && typeof patch.card === 'object') {
                    const c = patch.card;
                    const prev = (st.card && typeof st.card === 'object') ? st.card : {};
                    const next: any = {
                        open: !!c.open,
                        dockSide: (c.dockSide === 'left' ? 'left' : 'right'),
                    };
                    const gv = _clampCardGeom(c.video); if (gv) { next.video = gv; } else if (prev.video) { next.video = prev.video; }
                    const ga = _clampCardGeom(c.audio); if (ga) { next.audio = ga; } else if (prev.audio) { next.audio = prev.audio; }
                    st.card = next;
                }
                if (typeof patch.pinned === 'boolean') {
                    st.pinned = patch.pinned;
                    if (_playerWin && !_playerWin.isDestroyed()) { _applyAlwaysOnTop(_playerWin, patch.pinned); }
                }
            }
            _saveStateDebounced();
            return { ok: true };
        } catch { return { ok: false }; }
    });

    // 悬浮层 ↗ 一键弹出：整体交接（列表 + 当前轨 + 模式/倍速/音量 + 进度/播放态）
    ipcMain.handle('qqqide:player:popOut', (_e, state: any) => {
        try {
            const st = _loadState();
            if (state && typeof state === 'object') {
                if (Array.isArray(state.list)) { st.list = state.list.slice(0, 2000); }
                if (typeof state.index === 'number') { st.index = Math.max(0, state.index | 0); }
                if (typeof state.rate === 'number') { st.rate = state.rate; }
                if (state.loop === 'off' || state.loop === 'all' || state.loop === 'one') { st.loop = state.loop; }
                if (typeof state.shuffle === 'boolean') { st.shuffle = state.shuffle; }
                if (typeof state.volume === 'number') { st.volume = Math.max(0, Math.min(1, state.volume)); }
                if (typeof state.muted === 'boolean') { st.muted = state.muted; }
                if (state.dockSide === 'left' || state.dockSide === 'right') { st.dockSide = state.dockSide; }
                _saveStateNow();
                openPlayerWindow({
                    play: !state.paused,
                    time: state.time || 0,
                    list: st.list, index: st.index,
                    rate: st.rate, loop: st.loop, shuffle: st.shuffle,
                    volume: st.volume, muted: st.muted, dockSide: st.dockSide,
                });
                return { ok: true };
            }
            openPlayerWindow();
            return { ok: true };
        } catch { return { ok: false }; }
    });

    // ★ 播放器窗 ↙「退回悬浮层」（v6，2026-09-26 q319）：整体交接回主窗口悬浮层——主窗收 qqqide:player:return
    //   后开层（列表+进度+模式）+ 本窗随后自关；无主窗口/空列表 → { ok:false }（渲染层 toast，本窗不动、声音不断）。
    //   状态照存（再次 ↗ 弹出零丢失）；交接送达 = 主窗渲染层立即复灌悬浮层（claim 广播亦会让本窗先暂停）
    ipcMain.handle('qqqide:player:returnOverlay', (_e, state: any) => {
        try {
            const st = _loadState();
            if (state && typeof state === 'object') {
                if (Array.isArray(state.list)) { st.list = state.list.slice(0, 2000); }
                if (typeof state.index === 'number') { st.index = Math.max(0, state.index | 0); }
                if (typeof state.rate === 'number') { st.rate = state.rate; }
                if (state.loop === 'off' || state.loop === 'all' || state.loop === 'one') { st.loop = state.loop; }
                if (typeof state.shuffle === 'boolean') { st.shuffle = state.shuffle; }
                if (typeof state.volume === 'number') { st.volume = Math.max(0, Math.min(1, state.volume)); }
                if (typeof state.muted === 'boolean') { st.muted = state.muted; }
                if (state.dockSide === 'left' || state.dockSide === 'right') { st.dockSide = state.dockSide; }
                _saveStateNow();
            }
            if (!Array.isArray(st.list) || !st.list.length) { return { ok: false, reason: 'empty' }; }
            const mains = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== _playerWin);
            const mw = mains.find((w) => (w.webContents.getURL() || '').indexOf('/qqqide/') !== -1);
            if (!mw) { return { ok: false, reason: 'no-main' }; }
            mw.webContents.send('qqqide:player:return', {
                list: st.list, index: st.index,
                time: (state && typeof state.time === 'number' && isFinite(state.time)) ? Math.max(0, state.time) : 0,
                paused: !!(state && state.paused),
                rate: st.rate, loop: st.loop, shuffle: st.shuffle,
                volume: st.volume, muted: st.muted, dockSide: st.dockSide,
            });
            // 交接已送达主窗 → 本窗稍后自关（声音由悬浮层接管）
            setTimeout(() => { try { if (_playerWin && !_playerWin.isDestroyed()) { _playerWin.close(); } } catch { /* ignore */ } }, 80);
            return { ok: true };
        } catch { return { ok: false }; }
    });

    // Roam ➕「加入播放列表」：追加进列表（空闲则起播）；已开 → queue 事件；未开 → 建窗携交接
    ipcMain.handle('qqqide:player:add', (_e, pathsIn: any) => {
        try {
            const paths = Array.isArray(pathsIn) ? pathsIn.filter((p: any) => typeof p === 'string' && p) : [];
            if (!paths.length) { return { ok: true, added: 0, ignored: 0 }; }
            const st = _loadState();
            if (!Array.isArray(st.list)) { st.list = []; }
            const wasOpen = !!(_playerWin && !_playerWin.isDestroyed());
            let added = 0;
            let startIndex = st.list.length;
            for (const p of paths) {
                const item = _mkItem(p);
                if (st.list.some((it: any) => it && it.localPath === item.localPath)) { continue; }
                st.list.push(item);
                added++;
            }
            if (added > 0) {
                st.index = Math.min(st.index || 0, st.list.length - 1);
                if (startIndex >= st.list.length) { startIndex = st.list.length - added > 0 ? st.list.length - added : 0; }
                _saveStateNow();
            }
            if (wasOpen) {
                if (added > 0) { _sendToPlayer('qqqide:player:queue', { play: true }); }
                try { _playerWin!.show(); } catch { /* ignore */ }
            } else if (added > 0) {
                openPlayerWindow({
                    play: true,
                    time: 0,
                    list: st.list, index: startIndex,
                    rate: st.rate, loop: st.loop, shuffle: st.shuffle,
                    volume: st.volume, muted: st.muted, dockSide: st.dockSide,
                });
            }
            return { ok: true, added, ignored: paths.length - added };
        } catch { return { ok: false, added: 0, ignored: 0 }; }
    });

    ipcMain.on('qqqide:player:claim', (_e, from: string) => { _broadcastClaim(from); });

    // 截图「📂 Roam 定位」（播放器窗 → 主窗口 Roam 引擎；无主窗口 → 系统定位兜底）
    ipcMain.handle('qqqide:player:reveal', (_e, p: string) => {
        try {
            const mains = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== _playerWin);
            const mw = mains.find((w) => (w.webContents.getURL() || '').indexOf('/qqqide/') !== -1) || mains[0];
            if (mw) {
                mw.webContents.executeJavaScript(
                    `(function(){ if (window.__qqq_roamRevealPath) window.__qqq_roamRevealPath(${JSON.stringify(String(p || ''))}); })()`
                ).catch(() => { /* ignore */ });
                return { ok: true };
            }
            try { shell.showItemInFolder(String(p || '')); } catch { /* ignore */ }
            return { ok: true, fallback: true };
        } catch { return { ok: false }; }
    });

    ipcMain.handle('qqqide:player:close', () => {
        try {
            if (_playerWin && !_playerWin.isDestroyed()) { _playerWin.close(); }
            return { ok: true };
        } catch { return { ok: false }; }
    });
}
