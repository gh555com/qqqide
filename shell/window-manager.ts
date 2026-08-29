// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// window-manager.ts — 窗口创建 / 缩放 / 边界持久化 / 全局快捷键
// ============================================================================

import { BrowserWindow, screen, globalShortcut } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { injectDevToolsConsoleButtons } from './devtools-inject';
import { renameDevToolsViaBroker } from './py-broker';
import { claimSquad, releaseSquad, broadcastSquadState } from './squad-manager';
import { releaseProject } from './project-lock';
import { SimpleWebSocket } from './cdp-sniffer';
import { crashNetLog, crashNetSnapshot } from './crash-net';
// import { LspBridge } from './lsp-bridge'; // LSP OFF — 2026-06-23
import { DownloadService } from './download-service';
import { StateStore } from './state-sqlite';
import { wsStateGetKey, wsStateSetKey } from './ipc-ws-state';
import { extractFlags } from './boot';

// ── 控制台全量 buffer（所有窗口共用，供 DevTools 复制/另存为按钮） ──
export const _consoleBuffer: string[] = [];
export const _consoleMaxLines = 20000;

// ---- Editor font size (replaces zoom — window UI locked at 1.0) ----
export let editorFontSize = 13;

export function setEditorFontSize(size: number): void {
    editorFontSize = size;
}

export function saveEditorFontSize(stateStore: StateStore): void {
    try { stateStore.set('qqqide', 'editorFontSize', { size: editorFontSize }); } catch { /* ignore */ }
}

/** Broadcast editor font size change to ALL windows (main + diff) */
export function broadcastEditorFontSize(size: number): void {
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            try { win.webContents.send('qqqide:zoom:changed', size); } catch { /* ignore */ }
        }
    }
}

// ---- Wing panel constants (must match shell-wings.js _shAiW) ----
export const WING_WIDTH = 389;
export const CENTER_MIN_W = 1100;
export const CENTER_MIN_H = 800;

/** Update window minimum size based on which wings are open */
export function updateWingMinSize(win: BrowserWindow, leftOpen: boolean, rightOpen: boolean): void {
    if (!win || win.isDestroyed()) return;
    const wingW = (leftOpen ? WING_WIDTH : 0) + (rightOpen ? WING_WIDTH : 0);
    win.setMinimumSize(CENTER_MIN_W + wingW, CENTER_MIN_H);
}

// ---- Wing open/closed state — 窗口记忆, 与 bounds 同链双写 (2026-08-09) ----
// ★ 翼开关状态从项目级 only.sq3 升入窗口记忆: 双写 global.sq3 wings_bulbs + OS 级 ws.sq3 windowWings
//   与 windowBounds 同一恢复链 → 重启后翼状态与窗口尺寸必然一致（旧 only.sq3 由 renderer 一次性迁移）
const _windowWingMap = new Map<number, { left: boolean; right: boolean }>();

export function setWindowWingState(win: BrowserWindow, leftOpen: boolean, rightOpen: boolean, stateStore?: StateStore): void {
    if (!win || win.isDestroyed()) return;
    const w = { left: !!leftOpen, right: !!rightOpen };
    _windowWingMap.set(win.id, w);
    updateWingMinSize(win, w.left, w.right);
    try {
        if (stateStore) stateStore.set('qqqide', 'wings_bulbs', w).catch(() => { });
        wsStateSetKey('windowWings', w).catch(() => { });
    } catch { /* ignore */ }
}

async function _readWingsFor(win: BrowserWindow, stateStore: StateStore): Promise<{ left: boolean; right: boolean }> {
    // 多窗口还原时每窗口覆盖值优先（openWindows 条目自带 wings）
    const ov = (win as any).__qqqRestoreWings;
    if (ov && typeof ov === 'object') return { left: !!ov.left, right: !!ov.right };
    try {
        let v: any = null;
        try { v = await stateStore.get('qqqide', 'wings_bulbs'); } catch { /* ignore */ }
        if (!v) { try { v = await wsStateGetKey('windowWings'); } catch { /* ignore */ } }
        if (v && typeof v === 'object') return { left: !!v.left, right: !!v.right };
    } catch { /* ignore */ }
    return { left: false, right: false };
}

export function getWindowWingState(win: BrowserWindow): { left: boolean; right: boolean } {
    return _windowWingMap.get(win.id) || { left: false, right: false };
}

function _pushWingsTo(win: BrowserWindow, w: { left: boolean; right: boolean }): void {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try { win.webContents.send('qqqide:wing:restore', w); } catch { /* ignore */ }
}

// ---- Window bounds ----
/** 恢复链: 绿色包级 global.sq3 → OS 级 ws.sq3 → 默认（2026-08-09: ws.sq3 OS 兜底, 删包不丢）
 *  ★ 2026-08-09: 翼状态与 bounds 同源同链恢复——先恢复翼（openWindows 每窗口覆盖 → global wings_bulbs → ws windowWings），
 *    再恢复 bounds；翼开而 bounds 不含翼宽（旧数据）→ 宽度钳到最小合理值，防中间区拉伸。*/
export async function restoreWindowBounds(win: BrowserWindow, stateStore: StateStore): Promise<void> {
    try {
        // ① 翼状态先恢复（map + 最小尺寸 + 推送 renderer，bounds 恢复后 CSS 即时就位）
        const wings = await _readWingsFor(win, stateStore);
        _windowWingMap.set(win.id, wings);
        updateWingMinSize(win, wings.left, wings.right);
        _pushWingsTo(win, wings);

        let v: any = null;
        try { v = await stateStore.get('qqqide', 'window_bounds'); } catch { /* ignore */ }
        if (!v) { try { v = await wsStateGetKey('windowBounds'); } catch { /* ignore */ } }
        if (!v) { return; }
        if (v.maximized) {
            win.maximize();
            return;
        }
        if (typeof v.w === 'number' && typeof v.h === 'number' && v.w > 0 && v.h > 0) {
            let w = v.w;
            const wingW = (wings.left ? WING_WIDTH : 0) + (wings.right ? WING_WIDTH : 0);
            if (wingW > 0 && w < CENTER_MIN_W + wingW) w = CENTER_MIN_W + wingW;
            const displays = screen.getAllDisplays();
            const anyOverlap = displays.some(d => {
                const dx = d.bounds.x, dy = d.bounds.y, dw = d.bounds.width, dh = d.bounds.height;
                return (v.x < dx + dw && v.x + w > dx && v.y < dy + dh && v.y + v.h > dy);
            });
            if (anyOverlap) {
                win.setBounds({ x: v.x || 0, y: v.y || 0, width: w, height: v.h });
            }
        }
    } catch (e) { /* ignore */ }
}

// ---- Global keyboard shortcuts ----
export function registerGlobalKey(accel: string, id: string, mainWindow: BrowserWindow | null): boolean {
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

// ---- Window↔Project maps (for project lock) ----
export const _windowProjectMap = new Map<number, string>();
export const _projectWindowMap = new Map<string, number>();

// ============================================================================
// ★ 窗口打开/关闭顺序记录 (2026-08-16 客户 bug 根治: 无法识别窗口关闭顺序)
//   数据模型 (双写 global.sq3 + OS 级 ws.sq3):
//     openWindows / open_windows        — 当前存活窗口快照 (打开序; 每次开窗/关窗即时落盘,
//                                          崩溃/被杀兜底 = 最近一次快照; 恢复集唯一权威)
//     windowOpenLog / window_open_log   — 打开序日志 (有界 FIFO, 审计用)
//     windowCloseLog / window_close_log — 关闭序日志 (mode='x' 单窗 / 'quitAll' 整组批次,
//                                          批次携带完整成员列表, 有界 FIFO)
//   核心语义:
//     ① 单窗 X 关闭 → 快照收缩为「剩余存活窗」; 最后一个 → 含自身快照
//        (重启只回到最后留存的那一个窗口; 之前关闭的窗口只留在 recents hover 列表)
//     ② 菜单退出 (quitAll) → 整组快照在 quitAll 瞬间写死, 后续 close 事件绝不收缩
//        (重启打开整组窗口, 两两间隔 500ms 防竞争态)
//     ③ 半销毁窗口 (_closingWinIds) 绝不入快照 — 快速连关时已关窗口绝不复活
// ============================================================================
const _WINDOW_LOG_MAX = 50;
const _windowOpenedAt = new Map<number, number>();          // winId → 打开时间戳
const _windowOpenLog: Array<{ mainFolder: string; openedAt: number }> = [];
const _windowCloseLog: Array<{ mainFolder: string; closedAt: number; mode: 'x' | 'quitAll'; batchId?: string; members?: any[] }> = [];
const _windowOpenLogged = new Map<number, string>();        // winId → folder (打开日志幂等)
const _closingWinIds = new Set<number>();                   // close 已放行、closed 未到 (半销毁)
let _quitAllBatch: { batchId: string; at: number; members: any[] } | null = null;

function _normFolder(p: string): string {
    return (p || '').replace(/\\/g, '/').replace(/\/$/, '');
}

// ★ 多实例窗口记忆隔离 (2026-08-29): ws.sq3 是 OS 级共享库 (dev+绿色包+多启动目录共用),
//   openWindows 是「整列表快照」语义 — 与共享单 key 结构性冲突: 实例 B 关窗 → B 的列表整体覆盖
//   A 的列表 → 重启只恢复最后写者, 其余实例窗口记忆全丢 (结构性必发生)。
//   修复: 窗口记忆 key 按启动目录分槽 openWindows.{root} — 不同启动目录零互踩;
//   同目录单实例 (launcher Mutex) 无同 key 并发。global.sq3 open_windows 在包内 (天然 per-pack) 不动。
let _packRoot = '';
export function setPackRoot(root: string): void {
    if (root) _packRoot = _normFolder(root);
}
function _detectPackRoot(): string {
    try {
        // 绿色包: {root}/gh555.com/joker.exe (execPath 含 /gh555.com/ 段); dev electron.exe 探测不到 → ''
        const exe = process.execPath.replace(/\\/g, '/');
        const i = exe.indexOf('/gh555.com/');
        if (i > 0) return exe.slice(0, i);
    } catch { /* ignore */ }
    return '';
}
/** ws.sq3 按启动目录分槽的 key; 探测失败 (dev) → 回退旧 key (dev 单实例无并发) */
export function packWsKey(base: string): string {
    if (!_packRoot) setPackRoot(_detectPackRoot());
    return _packRoot ? base + '.' + _packRoot : base;
}

function _persistOpenWindows(list: any[], stateStore: StateStore): void {
    try {
        stateStore.setNow('qqqide', 'open_windows', list).catch(() => { });
        wsStateSetKey(packWsKey('openWindows'), list).catch(() => { });
    } catch { /* ignore */ }
}

function _persistWindowLogs(stateStore: StateStore): void {
    try {
        stateStore.setNow('qqqide', 'window_open_log', _windowOpenLog.slice()).catch(() => { });
        stateStore.setNow('qqqide', 'window_close_log', _windowCloseLog.slice()).catch(() => { });
        wsStateSetKey(packWsKey('windowOpenLog'), _windowOpenLog.slice()).catch(() => { });
        wsStateSetKey(packWsKey('windowCloseLog'), _windowCloseLog.slice()).catch(() => { });
    } catch { /* ignore */ }
}

function _snapshotOf(win: BrowserWindow, folder: string): any | null {
    try {
        const n = _normFolder(folder);
        if (!n) return null;
        const b = win.getBounds();
        return {
            mainFolder: n,
            bounds: { x: b.x, y: b.y, w: b.width, h: b.height, maximized: win.isMaximized() },
            wings: _windowWingMap.get(win.id) || { left: false, right: false },
            openedAt: _windowOpenedAt.get(win.id) || Date.now(),
        };
    } catch { return null; }
}

/** 存活窗口快照 (打开序 = _windowProjectMap 插入序; 半销毁/已销毁窗口绝不含) */
function _snapshotOpenWindows(excludeWinId?: number): any[] {
    const list: any[] = [];
    const seen = new Set<string>();
    for (const [winId, folder] of _windowProjectMap) {
        if (winId === excludeWinId) continue;
        if (_closingWinIds.has(winId)) continue;
        const win = BrowserWindow.fromId(winId);
        if (!win || win.isDestroyed()) continue;
        const snap = _snapshotOf(win, folder);
        if (!snap || seen.has(snap.mainFolder)) continue;
        seen.add(snap.mainFolder);
        list.push(snap);
    }
    return list;
}

export function snapshotOpenWindows(): any[] {
    return _snapshotOpenWindows();
}

/** ★ 窗口项目注册时记录打开序 + 刷新存活快照 (崩溃兜底: 快照永远最新) */
export function recordWindowOpen(winId: number, folder: string, stateStore: StateStore): void {
    try {
        const n = _normFolder(folder);
        if (!n) return;
        if (_windowOpenLogged.get(winId) === n) return;  // 幂等: 同窗同项目只记一次
        _windowOpenLogged.set(winId, n);
        _windowOpenedAt.set(winId, Date.now());
        _windowOpenLog.push({ mainFolder: n, openedAt: _windowOpenedAt.get(winId)! });
        if (_windowOpenLog.length > _WINDOW_LOG_MAX) _windowOpenLog.shift();
        _persistWindowLogs(stateStore);
        const list = _snapshotOpenWindows();
        if (list.length > 0) _persistOpenWindows(list, stateStore);
    } catch (e: any) { console.warn('[window-manager] recordWindowOpen failed:', e && e.message); }
}

/** ★ 菜单退出整组关闭: quitAll 瞬间捕获全组快照写死, 防 close 事件逐步收缩 (2026-08-16) */
export function beginQuitAllBatch(stateStore: StateStore): void {
    try {
        if (_quitAllBatch) return;  // 幂等
        const members: any[] = [];
        for (const [winId, folder] of _windowProjectMap) {
            if (_closingWinIds.has(winId)) continue;
            const win = BrowserWindow.fromId(winId);
            if (!win || win.isDestroyed()) continue;
            const snap = _snapshotOf(win, folder);
            if (!snap) continue;
            snap.winId = winId;
            members.push(snap);
        }
        if (members.length === 0) return;
        _quitAllBatch = { batchId: Date.now() + '-' + Math.random().toString(36).slice(2, 8), at: Date.now(), members };
        // ★ 整组快照即时落盘 (不等 before-quit — 退出路径千变万化, 这里先写死)
        const list = members.map((m: any) => ({ mainFolder: m.mainFolder, bounds: m.bounds, wings: m.wings, openedAt: m.openedAt }));
        _persistOpenWindows(list, stateStore);
        // 关闭序日志: 整组批次 (成员列表随记录, 关闭顺序一目了然)
        _windowCloseLog.push({ mainFolder: '', closedAt: Date.now(), mode: 'quitAll', batchId: _quitAllBatch.batchId, members: list });
        if (_windowCloseLog.length > _WINDOW_LOG_MAX) _windowCloseLog.shift();
        _persistWindowLogs(stateStore);
        console.log('[window-manager] quitAll batch captured: ' + members.length + ' window(s)');
    } catch (e: any) { console.warn('[window-manager] beginQuitAllBatch failed:', e && e.message); }
}

/** ★ 关闭时立即保存剩余窗口列表 (2026-08-09 初版 / 2026-08-16 关闭序重构):
 *  剩余窗口活着 → 列表=剩余(打开序); 最后一个窗口关闭 → 列表=自身（退出后还原）;
 *  菜单退出批次 → 保留整组快照绝不收缩; 双写 global.sq3 open_windows + OS 级 ws.sq3 openWindows */
function _saveOpenWindowsNow(closingWin: BrowserWindow, stateStore: StateStore): void {
    try {
        _closingWinIds.add(closingWin.id);
        const selfFolder = _windowProjectMap.get(closingWin.id) || '';
        const selfFolderN = _normFolder(selfFolder);
        // ★ 菜单退出批次: 整组快照保留 (批次成员逐窗 close 事件全部写同一完整列表, 幂等)
        //   ★ lastClosed (2026-08-25): 批次按 close 到达顺序, 最后关闭的窗口标记置前 — 下次启动的活跃窗口
        if (_quitAllBatch && _quitAllBatch.members.some((m: any) => m.winId === closingWin.id)) {
            const list = _quitAllBatch.members
                .filter((m: any) => m.mainFolder)
                .map((m: any) => ({ mainFolder: m.mainFolder, bounds: m.bounds, wings: m.wings, openedAt: m.openedAt, lastClosed: _normFolder(m.mainFolder) === selfFolderN }));
            if (list.length > 0) _persistOpenWindows(list, stateStore);
            return; // 批次关闭不记单窗日志 (批记录已含完整成员列表)
        }
        // ★ 单窗 X 关闭: 存活快照 = 打开序 - 本窗 - 半销毁窗
        let list = _snapshotOpenWindows(closingWin.id);
        const self = _snapshotOf(closingWin, selfFolder);
        if (list.length === 0 && self) { self.lastClosed = true; list.push(self); } // 最后一个窗口 → 含自身快照 + 标记最后关闭
        // 关闭序日志 (仅记录带项目的窗口)
        const folder = _windowProjectMap.get(closingWin.id);
        if (folder) {
            const n = _normFolder(folder);
            if (n) {
                _windowCloseLog.push({ mainFolder: n, closedAt: Date.now(), mode: 'x' });
                if (_windowCloseLog.length > _WINDOW_LOG_MAX) _windowCloseLog.shift();
                _persistWindowLogs(stateStore);
            }
        }
        // ★ 空列表也写 (清陈旧恢复集 — 最后一个窗口无项目时, 绝不复活旧窗口)
        _persistOpenWindows(list, stateStore);
    } catch { /* ignore */ }
}

// ★ 关闭确认旁路：菜单退出时设置，跳过 Alt+F4 确认框
export function bypassCloseConfirm(win: BrowserWindow): void {
    (win as any).__qqqCloseBypass = true;
}

// ---- createWindow ----export function createWindow(
    portableRoot: string,
    portableCache: string,
    appVersion: string,
    // lspBridge: LspBridge,  // LSP OFF — 2026-06-23
    lspBridge: any,
    downloadService: DownloadService,
    stateStore: StateStore,): BrowserWindow {
    // ★ 窗口记忆分槽: 启动目录即实例身份 (多实例互踩修复 2026-08-29)
    setPackRoot(portableRoot);
    const preloadPath = path.join(__dirname, 'preload.js');
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: CENTER_MIN_W,
        minHeight: CENTER_MIN_H,
        show: false,
        frame: false,
        backgroundColor: '#fdf6e3',
        title: 'qqqide',
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: false,
            spellcheck: false,
            additionalArguments: [
                `--qqqide-root=${portableRoot}`,
                `--qqqide-version=${appVersion}`,
            ],
        },
    });

    // ★ 窗口编队认领: 创建即按序认领最近空闲槽位 (1 2 q w a s z x), 无空闲=null (>8窗口)
    claimSquad(win);
    // ★ 新窗口认领 → 广播（他窗下拉/按钮秒同步）
    broadcastSquadState();

    // ★ console-message 始终运行 — 捕获全量消息 (CDP 不再阻塞, 仅作补充)
    const _cmHandler = (
        _e: any, _level: number, message: string, _line: number, _sourceId: string
    ) => {
        // _level 0=verbose → 过滤（DevTools save 不显示 verbose）
        if (_level === 0) return;
        const src = (_sourceId || '').replace(/\\/g, '/');
        const file = src.split('/').pop() || '';
        const prefix = file && !file.startsWith('(') && _line ? file + ':' + _line + ' ' : '';
        _consoleBuffer.push(prefix + message);
        if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
    };
    win.webContents.on('console-message', _cmHandler);

    // ★ CDP 作为补充 (网络错误调用栈等) — 静默失败不影响 console-message 主线
    _setupCdpConsoleCapture(win).catch(() => {});

    win.removeMenu();

    win.once('ready-to-show', async () => {
        await restoreWindowBounds(win, stateStore);
        // ★ 不在 ready-to-show 就 show() — 等 boot 完成加载面板到 100% 才由 boot.ts 调用 show()
    });

    // ★ 关闭确认：Alt+F4 / 右上角 X → 通知 renderer 弹自定义确认框；菜单退出 → 跳过
    win.on('close', (e) => {
        if ((win as any).__qqqCloseBypass) {
            // ★ 窗口即将销毁（X 关闭/确认退出路径）— 立即捕获最终 bounds + 窗口列表（2026-08-09 修复:
            //   旧实现依赖 before-quit saveAllOpenWindows, 但 X 关闭时窗口已销毁 → open_windows 永不保存）
            try {
                const b = win.getBounds();
                const obj = { x: b.x, y: b.y, w: b.width, h: b.height, maximized: win.isMaximized() };
                stateStore.setNow('qqqide', 'window_bounds', obj).catch(() => { });
                wsStateSetKey('windowBounds', obj).catch(() => { });
                // ★ 翼状态与 bounds 同步落盘（最后关闭瞬间的真实翼状态）
                const wings = _windowWingMap.get(win.id) || { left: false, right: false };
                stateStore.setNow('qqqide', 'wings_bulbs', wings).catch(() => { });
                wsStateSetKey('windowWings', wings).catch(() => { });
                _saveOpenWindowsNow(win, stateStore);
            } catch { /* ignore */ }
            return; // 菜单退出已设旁路，直接放行
        }
        e.preventDefault();
        // ★ 武装键盘：确认框弹出期间 Enter=确认 / Escape=取消
        (win as any).__qqqConfirmArmed = true;
        // 通知 renderer 弹出确认框（renderer 样式同设置面板）
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            try { win.webContents.send('qqqide:confirm-close'); } catch (_) { }
        }
    });

    // ★ 确认框键盘键入（Enter=确认退出 / Escape=取消）— before-input-event 在浏览器进程捕获，
    //   焦点在左中右面板 iframe 内（document keydown 收不到）也能 100% 响应
    win.webContents.on('before-input-event', (event: any, input: any) => {
        if (!(win as any).__qqqConfirmArmed) { return; }
        if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') { return; }
        if (input.isComposing) { return; } // IME 组词回车不触发
        if (input.key === 'Enter') {
            event.preventDefault();
            (win as any).__qqqConfirmArmed = false;
            bypassCloseConfirm(win);
            // ★ 立即隐藏确认框（force 越过 1s 防抖）：确认退出永不防抖，窗口马上开始关闭
            try { win.webContents.send('qqqide:confirm-close-dismiss', true); } catch { /* ignore */ }
            try { win.close(); } catch { /* ignore */ }
        } else if (input.key === 'Escape') {
            event.preventDefault();
            try { win.webContents.send('qqqide:confirm-close-dismiss'); } catch { /* ignore */ }
        }
    });

    // ★ 渲染进程崩溃监控 + 自动恢复 (2026-08-08 F13):
    //   崩溃(含 V8 OOM) → 记录 reason + exitCode 到 Data/alphal/render-crash.log → 防抖 3s 自动 reload
    //   窗口不消失; 下次崩溃即可凭 reason 实锤根因 ('oom' = V8 堆耗尽)
    const _crashLogPath = path.join(portableRoot, 'Data', 'alphal', 'render-crash.log');
    win.webContents.on('render-process-gone', (_e, details) => {
        const reason = (details && details.reason) || 'unknown';
        try {
            fs.mkdirSync(path.dirname(_crashLogPath), { recursive: true });
            fs.appendFileSync(_crashLogPath,
                new Date().toISOString() + ' reason=' + reason +
                ' exitCode=' + ((details && details.exitCode) || 0) +
                ' win=' + win.id + '\n');
        } catch (_) { /* ignore */ }
        try { console.error('[window-manager] render-process-gone reason=' + reason + ' win=' + win.id); } catch (_) { }
        // ★ 天罗地网: 崩溃事件 + 全量快照 (主进程此刻仍存活, 必须立即落盘)
        try { crashNetLog({ kind: 'render-gone', winId: win.id, reason, exitCode: (details && details.exitCode) || 0 }); } catch (_) { }
        try { crashNetSnapshot('render-gone'); } catch (_) { }
        if (reason === 'clean-exit') { return; } // 正常关闭路径, 不恢复
        // 自动恢复: 崩溃/被杀/OOM → reload 保留窗口 (防抖 3s, 防崩溃循环风暴)
        const now = Date.now();
        const lastAt = (win as any).__qqqCrashReloadAt || 0;
        if (now - lastAt > 3000) {
            (win as any).__qqqCrashReloadAt = now;
            setTimeout(() => {
                try { if (!win.isDestroyed() && !win.webContents.isDestroyed()) { win.webContents.reload(); } } catch (_) { }
            }, 300);
        }
    });

    // 渲染进程卡死(JS 长任务/GC 停顿) — 只记录, 不杀(杀会丢未落盘数据)
    win.webContents.on('unresponsive', () => {
        try { console.error('[window-manager] renderer unresponsive win=' + win.id); } catch (_) { }
    });

    win.on('closed', () => {
        (win as any).__qqqConfirmArmed = false;
        // ★ 半销毁标记清除 (2026-08-16): 窗口彻底销毁, 不再污染存活快照
        _closingWinIds.delete(win.id);
        if (_quitAllBatch) {
            // 批次成员全部销毁 → 批次状态清空 (进程即将退出, 防陈旧状态污染)
            const alive = _quitAllBatch.members.some((m: any) => {
                const w = BrowserWindow.fromId(m.winId);
                return w && !w.isDestroyed() && !_closingWinIds.has(m.winId);
            });
            if (!alive) _quitAllBatch = null;
        }
        try { if (_boundsSaveTimer) { clearTimeout(_boundsSaveTimer); _boundsSaveTimer = null; } } catch (_) { }
        // ★ 无条件释放项目锁（2026-08-13 幽灵锁事故根因之一）：projectLock.claim（only-store）
        //   与 window.claimProject（注册 _windowProjectMap）是两条独立 IPC——时序竞态下
        //   claim 已成功但 map 未注册 → 旧逻辑条件释放被跳过 → _held 残留 + 心跳永续
        //   → 幽灵锁（绿色包误报 pid=9424=自己 实锤）。releaseProject 内部 _held 无条目时安全 return。
        try { releaseProject(win.id); } catch (_) { }
        // ★ 窗口关闭 → 编队槽位回到空闲 + 广播（他窗秒同步）
        try { releaseSquad(win.id); } catch (_) { }
        try { broadcastSquadState(); } catch (_) { }
        try {
            const ownedProject = _windowProjectMap.get(win.id);
            if (ownedProject) {
                _windowProjectMap.delete(win.id);
                _projectWindowMap.delete(ownedProject);
            }
        } catch (_) { }
    });

    // Window blur → dismiss AI viewport dropdown
    win.on('blur', () => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.executeJavaScript(
                "if(window.qqqideViewport&&window.qqqideViewport.closeDropdown)window.qqqideViewport.closeDropdown()"
            ).catch((e) => { try { console.warn('[main] blur dismiss failed:', e && e.message); } catch (_) { } });
        }
    });

    // Persist window bounds on resize/move (debounced 500ms)
    let _boundsSaveTimer: NodeJS.Timeout | null = null;
    // ★ 双写: 绿色包级 global.sq3 + OS 级 ws.sq3（删包/换包后 OS 兜底回写）
    const persistBounds = (b: Electron.Rectangle, maximized: boolean) => {
        const obj = { x: b.x, y: b.y, w: b.width, h: b.height, maximized };
        stateStore.set('qqqide', 'window_bounds', obj).catch(() => { });
        wsStateSetKey('windowBounds', obj).catch(() => { });
    };
    const saveBounds = () => {
        try {
            if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) { return; }
            persistBounds(win.getBounds(), false);
        } catch { /* ignore */ }
    };
    const debouncedSaveBounds = () => {
        if (_boundsSaveTimer) { clearTimeout(_boundsSaveTimer); }
        _boundsSaveTimer = setTimeout(saveBounds, 500);
    };
    win.on('resize', debouncedSaveBounds);
    win.on('move', debouncedSaveBounds);
    win.on('maximize', () => {
        try {
            stateStore.set('qqqide', 'window_bounds', { maximized: true }).catch(() => { });
            wsStateSetKey('windowBounds', { maximized: true }).catch(() => { });
        } catch { /* ignore */ }
    });
    win.on('unmaximize', () => { try { saveBounds(); } catch { /* ignore */ } });

    // Download progress
    downloadService.setProgressSender((entry) => {
        if (win && !win.isDestroyed()) {
            try { win.webContents.send('qqqide:download:progress', entry); } catch { /* ignore */ }
        }
    });

    // Lock window UI at 1.0 (no zoom — editor font size handles text scaling)
    win.webContents.on('did-finish-load', () => {
        win.webContents.setZoomFactor(1.0);
        // ★ 翼状态重推（Ctrl+R 热重载后 renderer 需重新应用；主进程 map 仍在）
        _pushWingsTo(win, _windowWingMap.get(win.id) || { left: false, right: false });
    });

    // Ctrl/Cmd + (+/-/0) editor font size shortcuts
    win.webContents.on('before-input-event', (ev, input) => {
        if (input.type !== 'keyDown') { return; }
        const ctrl = input.control || input.meta;
        if (!ctrl) { return; }
        const k = input.key;
        if (k === '=' || k === '+') {
            ev.preventDefault();
            editorFontSize = Math.min(128, editorFontSize + 1);
            saveEditorFontSize(stateStore);
            broadcastEditorFontSize(editorFontSize);
        } else if (k === '-' || k === '_') {
            ev.preventDefault();
            editorFontSize = Math.max(1, editorFontSize - 1);
            saveEditorFontSize(stateStore);
            broadcastEditorFontSize(editorFontSize);
        } else if (k === '0') {
            ev.preventDefault();
            editorFontSize = 13;
            saveEditorFontSize(stateStore);
            broadcastEditorFontSize(editorFontSize);
        }
    });

    // ★ 控制台按钮注入 — 无论 dev/prod，DevTools 打开就注入
    win.webContents.on('devtools-opened', () => {
        const dwc = (win.webContents as any).devToolsWebContents as WebContents;
        if (dwc && !dwc.isDestroyed()) {
            injectDevToolsConsoleButtons(dwc, win.webContents, () => _consoleBuffer.join('\n'), win);
        }
    });

    // Dev mode extras
    if (extractFlags().isDev) {        win.webContents.on('devtools-opened', () => {
            // ★ DevTools 窗口标题 → Python broker（跨平台: Win ctypes / Mac osascript / Linux wmctrl）
            // ★ 2026-08-23: 成功后即停 — 旧实现 renamed 成功仍打满 8 次重试（devtools 窗口已存在时
            //   EnumWindows 扫不到 → 8 条 FAILED 日志噪音）；devtools 重开触发新闭包重新循环，覆盖不丢。
            let _renameDone = false;
            const _doRename = async (attempt: number) => {
                const p = _windowProjectMap.get(win.id);
                const n = p ? path.basename(p) : 'qqqide';
                console.log('[devtools] rename attempt=' + attempt + ' winId=' + win.id + ' projPath=' + (p || '(none)') + ' name=' + n);
                const ok = await renameDevToolsViaBroker(win, n);
                if (ok) _renameDone = true;
            };
            for (let _ri = 1; _ri <= 8; _ri++) {
                setTimeout(() => { if (!_renameDone) _doRename(_ri); }, 1500 * _ri);
            }
        });
        win.webContents.openDevTools({ mode: 'detach' });
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
                }
            }
            // ★ 吃 F12：Chromium 默认 F12=DevTools，IDE 自己不用 F12，阻止窗口被劫持
            if (input.key === 'F12') {
                ev.preventDefault();
            }
        });
    }

    return win;
}

// ── CDP 控制台全量捕获 — Log.entryAdded = DevTools 另存为 100% 同源数据 ──
// ★ v8: 延迟启动 + 重试 + 完整覆盖
async function _setupCdpConsoleCapture(win: BrowserWindow): Promise<void> {
    const PORT = 8315;
    const allSockets: SimpleWebSocket[] = [];
    let _started = false;

    // Safe logger: console.log → EPIPE when stdout is broken (no console window)
    const _safeLog = (...args: any[]) => { try { console.log(...args); } catch {} };

    // DevTools Console 默认不显示的 source（intervention=性能建议, rendering=渲染, violation=违规, deprecation=弃用）
    const _NOISE_SOURCES = new Set(['intervention', 'rendering', 'violation', 'deprecation', 'recommendation']);

    const _handleEntry = (entry: any) => {
        // 跳过 DevTools Console 默认不显示的条目
        if (!entry || !entry.text) return;
        if (entry.level === 'verbose') return;
        if (entry.source && _NOISE_SOURCES.has(entry.source)) return;
        // Log 域 network 条目: 用 entry.url 补全文本
        // Console 域不覆盖网络错误 → Log 域是唯一来源
        if (entry.source === 'network') {
            const nUrl = (entry.url || '').replace(/\\/g, '/');
            const nFile = nUrl.split('/').pop() || nUrl;
            const nText = (entry.text || '');
            const nCallFrames: any[] = entry.stackTrace?.callFrames || [];
            const nLines: string[] = [];
            if (nCallFrames.length > 0) {
                const f0 = nCallFrames[0];
                const fUrl = ((f0.url || '').replace(/\\/g, '/').split('/').pop()) || f0.url;
                const fLine = f0.lineNumber || 0;
                nLines.push((fUrl && fLine ? fUrl + ':' + fLine + ' ' : '') + nUrl + ' ' + nText);
                for (let i = 1; i < nCallFrames.length; i++) {
                    const cf = nCallFrames[i];
                    const fn = cf.functionName || '<anonymous>';
                    const fu = ((cf.url || '').replace(/\\/g, '/').split('/').pop()) || cf.url;
                    nLines.push('    ' + fn + ' @ ' + fu + ':' + (cf.lineNumber || 0));
                }
            } else {
                nLines.push(nUrl + ' ' + nText);
            }
            for (const l of nLines) {
                _consoleBuffer.push(l);
                if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
            }
            return;
        }

        const url = (entry.url || '').replace(/\\/g, '/');
        const file = url.split('/').pop() || url;
        const line = entry.lineNumber || 0;
        const text = entry.text || '';
        const callFrames: any[] = entry.stackTrace?.callFrames || [];

        const lines: string[] = [];
        if (callFrames.length > 0) {
            const f0 = callFrames[0];
            const fUrl = ((f0.url || '').replace(/\\/g, '/').split('/').pop()) || f0.url;
            const fLine = f0.lineNumber || 0;
            lines.push((fUrl && fLine ? fUrl + ':' + fLine + ' ' : '') + text);
            for (let i = 1; i < callFrames.length; i++) {
                const cf = callFrames[i];
                const fn = cf.functionName || '<anonymous>';
                const fu = ((cf.url || '').replace(/\\/g, '/').split('/').pop()) || cf.url;
                lines.push('    ' + fn + ' @ ' + fu + ':' + (cf.lineNumber || 0));
            }
        } else if (file && line) {
            lines.push(file + ':' + line + ' ' + text);
        } else {
            lines.push(text);
        }
        for (const l of lines) {
            _consoleBuffer.push(l);
            if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
        }
    };

    // 去重 set: Console message 的 url+line+text 前80字符 作为 dedup key
    const _consoleDedup = new Set<string>();

    const _handleConsoleMsg = (msg: any) => {
        if (!msg || !msg.text) return;
        if (msg.level === 'verbose') return;
        if (msg.source && _NOISE_SOURCES.has(msg.source)) return;
        // Console 域 network 消息无 URL — 由 Log 域 _handleEntry 处理
        if (msg.source === 'network') return;
        const url = (msg.url || '').replace(/\\/g, '/');
        const file = url.split('/').pop() || url;
        const line = msg.line || 0;
        const text = msg.text || '';
        const callFrames: any[] = msg.stackTrace?.callFrames || [];

        // Dedup: same file+line+text prefix within 1s
        const dedupKey = file + ':' + line + ':' + text.slice(0, 80);
        if (_consoleDedup.has(dedupKey)) return;
        _consoleDedup.add(dedupKey);
        setTimeout(() => _consoleDedup.delete(dedupKey), 1000);

        const lines: string[] = [];
        if (callFrames.length > 0) {
            const f0 = callFrames[0];
            const fUrl = ((f0.url || '').replace(/\\/g, '/').split('/').pop()) || f0.url;
            const fLine = f0.lineNumber || 0;
            lines.push((fUrl && fLine ? fUrl + ':' + fLine + ' ' : '') + text);
            for (let i = 1; i < callFrames.length; i++) {
                const cf = callFrames[i];
                const fn = cf.functionName || '<anonymous>';
                const fu = ((cf.url || '').replace(/\\/g, '/').split('/').pop()) || cf.url;
                lines.push('    ' + fn + ' @ ' + fu + ':' + (cf.lineNumber || 0));
            }
        } else if (file && line) {
            lines.push(file + ':' + line + ' ' + text);
        } else {
            lines.push(text);
        }
        for (const l of lines) {
            _consoleBuffer.push(l);
            if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
        }
    };

    const _connectTarget = (wsUrl: string, label: string) => {
        try {
            const ws = new SimpleWebSocket(wsUrl);
            allSockets.push(ws);
            ws.on('open', () => {
                // ★ Console 域 → 完全格式化消息 (含网络错误的 GET URL net::ERR_*)
                ws.send(JSON.stringify({ id: 1, method: 'Console.enable', params: {} }));
                // ★ Log 域 → 原始日志引擎消息 (含栈帧, 兜底)
                ws.send(JSON.stringify({ id: 2, method: 'Log.enable', params: {} }));
                _safeLog('[main] CDP Console+Log enabled for ' + label);
            });
            ws.on('message', (data: string) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.method === 'Console.messageAdded' && msg.params?.message) {
                        _handleConsoleMsg(msg.params.message);
                    } else if (msg.method === 'Log.entryAdded' && msg.params?.entry) {
                        _handleEntry(msg.params.entry);
                    }
                } catch {}
            });
            ws.on('error', (err: Error) => {
                            _safeLog('[main] CDP WS error (' + label + '):', err.message);               try { ws.close(); } catch {}
            });
        } catch (e: any) {
                        _safeLog('[main] CDP connect failed (' + label + '):', e.message);    }
    };

    const _doCapture = async () => {
        if (_started) return;
        try {
            const targetsJson: string = await new Promise<string>((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
                    let data = '';
                    res.on('data', (chunk: string) => data += chunk);
                    res.on('end', () => resolve(data));
                });
                req.on('error', reject);
                req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
            });
            const targets: any[] = JSON.parse(targetsJson);
            let pageCount = 0;
            for (const t of targets) {
                if (t.type === 'page' && t.webSocketDebuggerUrl) {
                    _connectTarget(t.webSocketDebuggerUrl, 'page:' + (t.url || '').slice(0, 60));
                    pageCount++;
                }
            }
            // 浏览器级 CDP
            try {
                const versionJson: string = await new Promise<string>((resolve, reject) => {
                    const req = http.get(`http://127.0.0.1:${PORT}/json/version`, (res) => {
                        let data = '';
                        res.on('data', (chunk: string) => data += chunk);
                        res.on('end', () => resolve(data));
                    });
                    req.on('error', reject);
                    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
                });
                const vi = JSON.parse(versionJson);
                if (vi.webSocketDebuggerUrl) {
                    _connectTarget(vi.webSocketDebuggerUrl, 'browser');
                }
            } catch {}
            _safeLog('[main] CDP capture started: ' + pageCount + ' page(s) + browser');
            _started = true;
            // 不在此处 onActive — 等首条 CDP 数据到达才激活 (防中间空窗导致丢消息)

            // 轮询新 target
            const _poll = setInterval(async () => {
                try {
                    const resp: string = await new Promise<string>((resolve, reject) => {
                        const req = http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
                            let data = '';
                            res.on('data', (chunk: string) => data += chunk);
                            res.on('end', () => resolve(data));
                        });
                        req.on('error', reject);
                        req.setTimeout(2000, () => { req.destroy(); });
                    });
                    const list: any[] = JSON.parse(resp);
                    const known = new Set(allSockets.map(s => s.url));
                    for (const t of list) {
                        if (t.type === 'page' && t.webSocketDebuggerUrl && !known.has(t.webSocketDebuggerUrl)) {
                            _connectTarget(t.webSocketDebuggerUrl, 'new:' + (t.url || '').slice(0, 60));
                        }
                    }
                } catch {}
            }, 8000);

            win.on('closed', () => {
                clearInterval(_poll);
                for (const s of allSockets) { try { s.close(); } catch {} }
                allSockets.length = 0;
            });
        } catch (err: any) {
            _safeLog('[main] CDP capture init failed (retry in 2s):', err.message);
            setTimeout(_doCapture, 2000);
        }
    };

    // 延迟启动: CDP 端口在 DevTools open 之后才完全就绪
    setTimeout(_doCapture, 2000);
    setTimeout(() => { if (!_started) _doCapture(); }, 5000);
}
