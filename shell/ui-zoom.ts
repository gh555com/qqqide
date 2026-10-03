// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ui-zoom.ts — 应用级界面缩放（与系统缩放解耦）
//
// 背景：win32 由 main.ts 强制 force-device-scale-factor=1（逻辑空间 = 物理分辨率），
//   用户自调界面大小走本机器：设置中心「界面缩放」= qqq-prefs 'uiZoom'（百分比）。
//
// 数据流：
//   持久化真理源 = qqq-prefs（全局库 ns 'qqq.prefs' key 'values' → .uiZoom；设置中心/云同步维护）
//   壳层启动直接读同一库（零渲染层依赖，窗口加载前就位）
//   渲染层 core/ui-zoom.js：变更入口（徽章点击/云拉取新值）经闸门上报 bridge.uiZoom.set(pct)；
//   壳层每次真变化全窗广播 → 各窗同步内存+徽章（★ 多窗口闭环；禁渲染层无条件回推——详 ui-zoom.js 头注释）
//
// 应用机制（Electron 22 实测，2026-09-29）：
//   webContents.setZoomFactor 同源 iframe 统一跟随（AI 三面板/goods 全覆盖）；
//   加载前设置不生效 → dom-ready + did-finish-load 双钩子；
//   跨源 iframe（Solar House 远程页）不随（Chromium per-origin zoom 边界）。
//   窗口最小尺寸随缩放等比（window-manager.updateWingMinSize，封顶工作区）。
//
// ★ 应急快捷键（Ctrl/Cmd + = / - / 0，浏览器同款）：主进程 before-input-event 直控——
//   步进档位 → setUiZoomPct（全窗即时生效）→ 落盘 qqq.prefs/values.uiZoom → 全窗广播
//   'qqqide:ui-zoom:changed'（core/ui-zoom.js 收侧同步偏好内存 + 发起窗 qoast）；
//   不经过渲染层——UI 异常时键盘仍可把窗口救回来。字号的旧 Ctrl+= 三键让位 Ctrl+Alt 三键。
// ============================================================================

import { app, BrowserWindow, ipcMain } from 'electron';
import { StateStore } from './state-sqlite';

const MIN_PCT = 50;
const MAX_PCT = 300;

// ★ 应急快捷键档位表 —— 与 server-app/core/qqq-prefs.js 'uiZoom' enum 严格同值（两处同改）
const UI_ZOOM_LADDER = [80, 90, 100, 110, 125, 150, 175, 200];

let _factor = 1;   // 1 = 100%
let _stateStore: StateStore | null = null;

// 缩放变更钩子（window-manager 注册最小尺寸刷新；单向依赖避免 import 循环）
const _listeners: Array<() => void> = [];

export function addUiZoomListener(fn: () => void): void {
    if (typeof fn === 'function') { _listeners.push(fn); }
}

export function getUiZoom(): number { return _factor; }

function _clampPct(v: any): number {
    let n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) { n = 100; }
    return Math.min(MAX_PCT, Math.max(MIN_PCT, n));
}

function _applyTo(win: BrowserWindow): void {
    try {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) { return; }
        // ★ 同值零动作：窗口已是目标缩放 → 不碰（防同值 apply 触发布局/回声链）
        const cur = win.webContents.getZoomFactor();
        if (typeof cur === 'number' && Math.abs(cur - _factor) < 1e-6) { return; }
        win.webContents.setZoomFactor(_factor);
    } catch { /* ignore */ }
}

function _applyAll(): void {
    for (const win of BrowserWindow.getAllWindows()) { _applyTo(win); }
}

/** 应用新缩放（百分比）——热生效：全部窗口 + 变更钩子；★ 同值零动作（防多窗口回声/风暴） */
export function setUiZoomPct(pct: any): number {
    const v = _clampPct(pct);
    if (v === Math.round(_factor * 100)) { return v; }
    _factor = v / 100;
    _applyAll();
    for (const fn of _listeners) { try { fn(); } catch { /* ignore */ } }
    return v;
}

// ═══ 应急快捷键（主进程直控）═══

function _persistUiZoom(v: number): void {
    const st = _stateStore;
    if (!st) { return; }
    try {
        st.get('qqq.prefs', 'values').then((values: any) => {
            let obj = values;
            if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { obj = null; } }
            if (!obj || typeof obj !== 'object') { obj = {}; }
            if (String(obj.uiZoom) === String(v)) { return; }
            obj.uiZoom = String(v);
            try { st.set('qqq.prefs', 'values', obj); } catch { /* ignore */ }
        }).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
}

function _broadcastUiZoom(pct: number, originWebContentsId: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) { continue; }
        try {
            win.webContents.send('qqqide:ui-zoom:changed', { pct: pct, qoast: win.webContents.id === originWebContentsId });
        } catch { /* ignore */ }
    }
}

/** 应急快捷键步进（主进程直控；渲染层全挂也能救回窗口）——步进/落盘/广播一站齐，返回新百分比 */
export function handleUiZoomShortcut(step: 'in' | 'out' | 'reset', originWebContentsId: number): number {
    const cur = Math.round(_factor * 100);
    let next = cur;
    if (step === 'reset') { next = 100; }
    else if (step === 'in') {
        for (const v of UI_ZOOM_LADDER) { if (v > cur) { next = v; break; } }
    } else {
        for (let i = UI_ZOOM_LADDER.length - 1; i >= 0; i--) { if (UI_ZOOM_LADDER[i] < cur) { next = UI_ZOOM_LADDER[i]; break; } }
    }
    if (next !== cur) { setUiZoomPct(next); }
    _persistUiZoom(next);
    _broadcastUiZoom(next, originWebContentsId);
    return next;
}

/** 启动初始化：读持久化值（qqq.prefs/values.uiZoom）→ 应用全部窗口 + 挂钩后续新窗口 */
export function initUiZoom(stateStore: StateStore): void {
    _stateStore = stateStore;
    try {
        stateStore.get('qqq.prefs', 'values').then((values: any) => {
            try {
                let v = values;
                if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
                if (v && typeof v === 'object' && v.uiZoom !== undefined) { setUiZoomPct(v.uiZoom); }
            } catch { /* ignore */ }
        }).catch(() => { /* 库未就绪 → 保持默认 100% */ });
    } catch { /* ignore */ }

    // 新窗口（主窗口/附加窗口/Diff/时间线/播放器统一覆盖）：加载后应用（加载前设置不生效——实测）
    // ★ 加载完成同时播报当前真值——渲染层据此对齐（防加载期丢广播 → 陈旧内存日后拽值）
    app.on('browser-window-created', (_e, win) => {
        try {
            win.webContents.on('dom-ready', () => _applyTo(win));
            win.webContents.on('did-finish-load', () => {
                _applyTo(win);
                try { win.webContents.send('qqqide:ui-zoom:changed', { pct: Math.round(_factor * 100), qoast: false }); } catch { /* ignore */ }
            });
        } catch { /* ignore */ }
    });
    _applyAll();
}

export function registerUiZoomIpc(): void {
    ipcMain.handle('qqqide:ui-zoom:get', () => Math.round(_factor * 100));
    // ★ 渲染层上报入口（用户动作 / 云拉取新值）：真变化才落盘 + 全窗广播（各窗 _adopt 同步）；
    //   同值 = 零动作（含回声/风暴防护——任意窗口反复推同值时主进程零副作用）
    ipcMain.handle('qqqide:ui-zoom:set', (_e, pct: any) => {
        const v = _clampPct(pct);
        if (v === Math.round(_factor * 100)) { return v; }
        setUiZoomPct(v);
        _persistUiZoom(v);
        _broadcastUiZoom(v, -1);
        return v;
    });
}
