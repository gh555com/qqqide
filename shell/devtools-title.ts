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
const DT_WRENCH = '\u300c\U0001f527\u300d';

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
