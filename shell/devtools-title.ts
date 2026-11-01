// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// devtools-title.ts — DevTools 独立窗标题（「🔧」+ 项目名）唯一入口
//
// 配对铁律：detached DevTools 的原生 owner 恒为 0 —— Win32 侧无法反查宿主 BrowserWindow，
//   因此任何「全局枚举 + 扫荡改名」都会把 A 窗的 DevTools 改成 B 窗的项目名（跨窗误改）。
//   归属唯一可信来源 = 打开前快照现存窗体句柄 → 打开后差集 = 本窗口的 DevTools 窗体；
//   认领结果按 winId 登记，此后改名只认登记过的句柄。配对不上 = 什么都不改（绝不猜）。
//
// 契约：打开通道必须走 window-manager.openDevToolsTracked（先落配对基准再 openDevTools）；
//   devtools-opened → titleDevTools（生产/开发同一条路径）；devtools-closed → forgetDevToolsWindow。
// ============================================================================

import { BrowserWindow } from 'electron';
import { listDevToolsWindows, renameDevToolsHwnd, renameDevToolsLoose, isPyBrokerReady } from './py-broker';

const DT_PREFIX = 'Developer Tools';
// ★ 必须用 \u{...} 码点转义：JS 的 \U 不是合法转义（会退化成字面 "U0001f527"）
const DT_WRENCH = '\u300c\u{1F527}\u300d';

/** 认领重试阶梯（ms）——原生窗体在 devtools-opened 之后才出现，必须短等 */
const CLAIM_LADDER = [0, 400, 1200, 2600, 5000];
/** 收尾核对：DevTools 前端刷新可能覆盖原生标题，到点核一次（只核一次，不成环） */
const VERIFY_DELAY = 8000;

const _hwndByWinId = new Map<number, number>();
const _baselineByWinId = new Map<number, Set<number>>();

let _projNameOf: (winId: number) => string = () => 'qqqide';

/** 项目名解析器注册（window-manager 提供：_windowProjectMap → basename） */
export function setDevToolsProjectNameResolver(fn: (winId: number) => string): void {
    if (typeof fn === 'function') { _projNameOf = fn; }
}

export function devToolsTitleOf(projName: string): string {
    return DT_WRENCH + (projName || 'qqqide');
}

function _winId(win: BrowserWindow): number {
    try { return win && !win.isDestroyed() ? win.id : 0; } catch { return 0; }
}

function _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** mac / Linux：原生窗体不可按句柄枚举时，直接改 DevTools 页面的 document.title
 *  （分离式 DevTools 的窗口标题跟随文档标题——零 TCC / 零枚举，进程内即达）。 */
async function _applyTitleViaJs(win: BrowserWindow, title: string): Promise<boolean> {
    try {
        const dt: any = (win.webContents as any).devToolsWebContents;
        if (!dt) { return false; }
        try { await dt.executeJavaScript('(function(){try{document.title=' + JSON.stringify(title) + ';}catch(e){}})()', true); } catch { /* 页面标题失败不影响原生标题 */ }
        // ★ mac 原生窗标题不跟 document.title：直接拿 DevTools 的 BrowserWindow 设标题
        //   （进程内 API，零 TCC / 零 osascript —— 后者在 VM 上实测 System Events 恒超时）
        try {
            const bw = BrowserWindow.fromWebContents(dt);
            if (bw && !bw.isDestroyed()) { bw.setTitle(title); return true; }
        } catch { /* 回退页面标题 */ }
        return false;
    } catch { return false; }
}

/** 句柄当前归属（null = 未登记） */
function _ownerOf(hwnd: number): number | null {
    for (const [wid, h] of _hwndByWinId) { if (h === hwnd) { return wid; } }
    return null;
}

/** 打开 DevTools 前调用：快照现存 DevTools 句柄（差集基准） */
export async function prepareDevToolsOpen(win: BrowserWindow): Promise<void> {
    const winId = _winId(win);
    if (!winId || !isPyBrokerReady()) { return; }
    const wins = await listDevToolsWindows();
    _baselineByWinId.set(winId, new Set(wins.map((w) => w.hwnd)));
}

/** 差集认领：返回本窗口的 DevTools 句柄；配对不上 → 0（绝不猜） */
async function _claim(winId: number): Promise<number> {
    const wins = await listDevToolsWindows();
    if (wins.length === 0) { return 0; }
    // 已归别的窗口 → 绝不碰
    const free = wins.filter((w) => {
        const owner = _ownerOf(w.hwnd);
        return owner === null || owner === winId;
    });
    const base = _baselineByWinId.get(winId);
    const fresh = base ? free.filter((w) => !base.has(w.hwnd)) : free;
    if (fresh.length === 1) { return fresh[0].hwnd; }
    // 多个新候选（两窗几乎同时开 DevTools）→ 只认「还没改名」的唯一一个，仍多义则放弃本次
    const unrenamed = fresh.filter((w) => w.title.startsWith(DT_PREFIX));
    return unrenamed.length === 1 ? unrenamed[0].hwnd : 0;
}

/** mac：DevTools 前端加载完会自己写回默认标题 → 3s 后重设一次（只一次，不成环） */
function _scheduleReapplyMac(win: BrowserWindow, title: string): void {
    setTimeout(() => {
        try { if (win && !win.isDestroyed()) { void _applyTitleViaJs(win, title); } } catch { /* ignore */ }
    }, 3000);
}

function _scheduleVerify(winId: number, title: string): void {
    setTimeout(() => {
        void (async () => {
            try {
                const hwnd = _hwndByWinId.get(winId);
                if (!hwnd) { return; }
                const wins = await listDevToolsWindows();
                const cur = wins.find((w) => w.hwnd === hwnd);
                if (cur && cur.title !== title) {
                    await renameDevToolsHwnd(hwnd, title);
                    console.log('[devtools] title re-applied winId=' + winId + ' hwnd=' + hwnd);
                }
            } catch { /* ignore */ }
        })();
    }, VERIFY_DELAY);
}

/**
 * 给本窗口的 DevTools 窗体改名 = 「🔧」+ 项目名。
 * 已登记 → 只改登记句柄；未登记 → 差集认领（重试阶梯）→ 改名；配对不上 → 保守兜底，绝不扫荡。
 */
export async function titleDevTools(win: BrowserWindow, projName?: string): Promise<boolean> {
    const winId = _winId(win);
    if (!winId) { return false; }
    const title = devToolsTitleOf(projName || _projNameOf(winId));

    // DevTools 未开 且 无登记 → 零开销返回（开机 claimProject 的延迟改名走这里）
    let opened = false;
    try { opened = win.webContents.isDevToolsOpened(); } catch { /* ignore */ }
    const known = _hwndByWinId.get(winId) || 0;
    if (!opened && !known) { _baselineByWinId.delete(winId); return false; }

    if (known) {
        if (await renameDevToolsHwnd(known, title)) { _scheduleVerify(winId, title); return true; }
        _hwndByWinId.delete(winId);   // 登记句柄已失效（DevTools 关掉重开）
    }

    // mac：原生句柄枚举不可用（list-devtools 恒空）——直接走文档标题，免 9s 空等阶梯
    if (process.platform === 'darwin') {
        for (const delay of [0, 400, 1200]) {
            if (delay) { await _sleep(delay); }
            if (!_winId(win)) { return false; }
            // ★ mac 原生窗标题不跟 document.title（DevTools 前端只写页面标题）——两路同发：
            //   ① 页面标题（Process/Window 菜单与 Cmd+Tab 显示） ② DevTools 自己的 BrowserWindow.setTitle（标题栏）
            if (await _applyTitleViaJs(win, title)) {
                console.log('[devtools] mac title winId=' + winId + ' = ' + title);
                _scheduleReapplyMac(win, title);
                return true;
            }
            // ★ 禁止 mac 走 osascript/System Events：实测会弹「控制 System Events」自动化授权框，
            //   用户不点时子进程恒超时（= 静默失败），比不改名更糟。页面标题已足矣（Process/Window 菜单可见）。
            return false;
        }
        return false;
    }

    for (const delay of CLAIM_LADDER) {
        if (delay) { await _sleep(delay); }
        if (!_winId(win)) { return false; }
        const hwnd = await _claim(winId);
        if (!hwnd) { continue; }
        if (await renameDevToolsHwnd(hwnd, title)) {
            _hwndByWinId.set(winId, hwnd);
            console.log('[devtools] claimed winId=' + winId + ' hwnd=' + hwnd + ' title=' + title);
            _scheduleVerify(winId, title);
            return true;
        }
    }

    // 配对不上（DevTools 由非本机通道打开等）→ 保守兜底：只改 owner 证明 / 唯一未改名候选
    const ok = await renameDevToolsLoose(win, title);
    if (ok) { console.log('[devtools] loose rename winId=' + winId + ' title=' + title); }
    return ok;
}

/** 便捷入口：按窗口当前项目名改名（调用方无需知道项目名） */
export function titleDevToolsForWindow(win: BrowserWindow): void {
    void titleDevTools(win).catch(() => { /* ignore */ });
}

/** DevTools 关闭 / 窗口销毁 → 注销登记 */
export function forgetDevToolsWindow(winId: number): void {
    if (!winId) { return; }
    _hwndByWinId.delete(winId);
    _baselineByWinId.delete(winId);
}
