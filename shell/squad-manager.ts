// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// squad-manager.ts — 窗口编队 OS 级唯一真理源 (%LOCALAPPDATA%/qqqide/squads.json)
//
// 语义 (2026-08-08 定案):
//   · 编队 = 窗口（非启动包路径）。8 槽位顺序: 1 2 q w a s z x。
//   · 窗口创建即按序认领最近空闲槽位；关闭即释放；>8 窗口无编队、不可召回。
//   · 窗口标题 = {squad}■{主文件夹名}（无编队则纯文件夹名）— 主进程唯一标题权威。
//   · 召唤: py-broker (pynput, Space+key) 读 squads.json → 校验 hwnd/pid → 前置激活。
//   · 写入: 仅 Electron 主进程单写入者，tmp+rename 原子落盘；py-broker 只读。
//   · 陈旧回收: 同进程按 winId 精确校验（BrowserWindow.fromId）；跨进程按 pid 存活。
//   · 广播: 状态变更 → 'qqqide:squad:changed' → 各窗口重新 get（秒同步标题+按钮）。
// ============================================================================

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const SQUAD_ORDER = ['1', '2', 'q', 'w', 'a', 's', 'z', 'x'];

const TITLE_PREFIX_RE = /^[1-2qwaszx]\u25A0/;

interface SquadEntry {
    winId: number;
    hwnd: string;   // 字符串存储，防 64 位精度丢失
    pid: number;
    folder: string;
    title: string;
    ts: number;
}

interface SquadRegistry {
    version: 1;
    updatedAt: number;
    slots: Record<string, SquadEntry | null>;
}

let _cache: SquadRegistry | null = null;

function registryPath(): string {
    const dir = path.join(os.homedir(), 'AppData', 'Local', 'qqqide');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return path.join(dir, 'squads.json');
}

function _empty(): SquadRegistry {
    const slots: Record<string, SquadEntry | null> = {};
    for (const k of SQUAD_ORDER) { slots[k] = null; }
    return { version: 1, updatedAt: Date.now(), slots };
}

function _load(): SquadRegistry {
    if (_cache) { return _cache; }
    try {
        const j = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
        if (j && j.version === 1 && j.slots && typeof j.slots === 'object') { _cache = j; return j; }
    } catch { /* 缺失/损坏 → 重建空注册表 */ }
    _cache = _empty();
    return _cache;
}

function _save(): void {
    const reg = _load();
    reg.updatedAt = Date.now();
    const p = registryPath();
    const tmp = p + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(reg, null, 1), 'utf-8');
        fs.renameSync(tmp, p);
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
}

/** 槽位是否陈旧可回收: 同进程 winId 精确验证；跨进程 pid 存活验证 */
function _isStale(e: SquadEntry): boolean {
    if (e.pid === process.pid) {
        const win = BrowserWindow.fromId(e.winId);
        return !win || win.isDestroyed();
    }
    try { process.kill(e.pid, 0); return false; } catch { return true; }
}

function _hwndOf(win: BrowserWindow): string {
    try {
        const h = win.getNativeWindowHandle();
        if (h && h.length >= 4) {
            return (h.length === 8 ? h.readBigUInt64LE(0) : h.readUInt32LE(0)).toString();
        }
    } catch { /* ignore */ }
    return '0';
}

function _folderName(folder: string): string {
    const f = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!f) { return ''; }
    return f.split('/').pop() || f;
}

function _titleText(squad: string | null, name: string): string {
    const n = _folderName(name) || 'qqqide';
    return squad ? squad + '\u25A0' + n : n;
}

function _stripPrefix(title: string): string {
    return String(title || '').replace(TITLE_PREFIX_RE, '');
}

/** 唯一标题权威：编队/文件夹变化 → 立即刷新 OS 标题 */
function _applyTitle(win: BrowserWindow, squad: string | null, name: string): void {
    if (!win || win.isDestroyed()) { return; }
    try { win.setTitle(_titleText(squad, name)); } catch { /* ignore */ }
}

export function getSquadOf(winId: number): string | null {
    const reg = _load();
    for (const k of SQUAD_ORDER) {
        const e = reg.slots[k];
        if (e && e.winId === winId) { return k; }
    }
    return null;
}

function _findFreeSlot(): string | null {
    const reg = _load();
    for (const k of SQUAD_ORDER) {
        const e = reg.slots[k];
        if (!e || _isStale(e)) { return k; }
    }
    return null;
}

/** 窗口创建即认领（顺序 1 2 q w a s z x，取最近空闲）；无空闲返回 null（>8 窗口） */
export function claimSquad(win: BrowserWindow): string | null {
    const slot = _findFreeSlot();
    if (slot) {
        const reg = _load();
        reg.slots[slot] = { winId: win.id, hwnd: _hwndOf(win), pid: process.pid, folder: '', title: '', ts: Date.now() };
        _save();
    }
    return slot;
}

/** 窗口关闭 → 槽位回到空闲 */
export function releaseSquad(winId: number): void {
    const reg = _load();
    let changed = false;
    for (const k of SQUAD_ORDER) {
        const e = reg.slots[k];
        if (e && e.winId === winId) { reg.slots[k] = null; changed = true; }
    }
    if (changed) { _save(); }
}

/** 文件夹/标题刷新（renderer setTitle 路径）→ 更新条目 + 应用 OS 标题 */
export function refreshWindowEntry(win: BrowserWindow, folder: string, rawTitle: string): void {
    const reg = _load();
    const clean = _stripPrefix(rawTitle);
    const folderClean = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
    for (const k of SQUAD_ORDER) {
        const e = reg.slots[k];
        if (e && e.winId === win.id) {
            e.folder = folderClean;
            e.title = _titleText(k, folderClean || clean);
            e.ts = Date.now();
            _save();
            _applyTitle(win, k, folderClean || clean);
            return;
        }
    }
    _applyTitle(win, null, folderClean || clean);
}

/** 手动改编队（UI 按钮下拉） */
export function setSquad(win: BrowserWindow, target: string, folder: string): { ok: boolean; reason?: string } {
    if (!SQUAD_ORDER.includes(target)) { return { ok: false, reason: 'invalid_slot' }; }
    const reg = _load();
    const current = getSquadOf(win.id);
    if (current === target) { return { ok: false, reason: 'same_slot' }; }
    const existing = reg.slots[target];
    if (existing && !_isStale(existing)) { return { ok: false, reason: 'occupied' }; }
    for (const k of SQUAD_ORDER) {
        const e = reg.slots[k];
        if (e && e.winId === win.id) { reg.slots[k] = null; }
    }
    const folderClean = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
    let name = folderClean;
    if (!name) {
        try { name = _stripPrefix(win.isDestroyed() ? '' : win.getTitle()); } catch { name = ''; }
    }
    reg.slots[target] = { winId: win.id, hwnd: _hwndOf(win), pid: process.pid, folder: folderClean, title: _titleText(target, name), ts: Date.now() };
    _save();
    _applyTitle(win, target, name);
    return { ok: true };
}

/** IPC get 状态快照 */
export function getSquadState(winId: number): {
    squad: string | null;
    order: string[];
    slots: Record<string, { winId: number; folder: string; title: string } | null>;
    updatedAt: number;
} {
    const reg = _load();
    const squad = getSquadOf(winId);
    const slots: Record<string, { winId: number; folder: string; title: string } | null> = {};
    for (const k of SQUAD_ORDER) {
        const e = reg.slots[k];
        slots[k] = e && !_isStale(e) ? { winId: e.winId, folder: e.folder, title: e.title } : null;
    }
    return { squad, order: SQUAD_ORDER, slots, updatedAt: reg.updatedAt };
}

/** 状态变更广播 → 各窗口收到后重新 get（秒同步标题+按钮） */
export function broadcastSquadState(): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) { continue; }
        try { win.webContents.send('qqqide:squad:changed'); } catch { /* ignore */ }
    }
}
