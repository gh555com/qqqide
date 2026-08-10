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
//   · ★ 跨实例中心大脑（2026-08-10）: 认领=读-改-写非原子 → dev+绿色包同跑并发认领同槽
//     时 LWW 只保证后写者赢，败者内存与磁盘分裂（按钮/下拉/标题全部各说各话）。
//     修复: ① 写后验证+重试（claim/set 写盘后立即回读确认槽位仍属自己）② fs.watch 目录
//     监听 squads.json（gaea-process 状态文件同款: 200ms 防抖 + error 指数退避重建 1s→30s
//     + 30s 兜底 poll）→ 外部写盘即时 _loadFresh → 窗口失去槽位自动重认领空闲槽 →
//     标题/按钮/下拉秒纠正并广播 ③ tmp 名 pid 后缀防双写互踩 ④ getSquadState 强刷磁盘。
//   · ★ .prev 恢复链（2026-08-10 F18）: 全项目最后一块持久化缺口。写前轮换（主文件完好
//     才轮换，损坏不覆盖既有 .prev）+ 读路径两级恢复链 主文件→.prev（损坏自动回退上一
//     完好版，不直接建空库），与 goods 库三级防线同款（铁律 8.2）。
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

/** 读磁盘原始内容（不碰 _cache）；失败返回 null
 *  ★ 两级恢复链（2026-08-10 F18）: 主文件损坏 → 自动回退 .prev（上一完好版），
 *  双损才返回 null（调用方各自兜底: _loadFresh 保留内存态 / watcher 等下次事件） */
function _readDisk(): SquadRegistry | null {
    const p = registryPath();
    for (const f of [p, p + '.prev']) {
        try {
            const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
            if (j && j.version === 1 && j.slots && typeof j.slots === 'object') { return j; }
        } catch { /* ignore */ }
    }
    return null;
}

/** 写前 .prev 轮换（2026-08-10 F18）: 主文件完好才轮换（.prev 恒为上一完好版）；
 *  主文件缺失/损坏 → 跳过，绝不把损坏内容覆盖到既有 .prev 上 */
function _rotatePrev(): void {
    const p = registryPath();
    try {
        const stat = fs.statSync(p);
        if (!stat.isFile()) { return; }
        JSON.parse(fs.readFileSync(p, 'utf-8')); // 完好性校验
        fs.copyFileSync(p, p + '.prev');
    } catch { /* 缺失/损坏 → 不轮换，保留既有 .prev */ }
}

function _loadFresh(): SquadRegistry {
    const disk = _readDisk();
    if (disk) { _cache = disk; return disk; }
    if (_cache) { return _cache; } // 磁盘读失败 → 保留内存态，绝不整库清空
    _cache = _empty();
    return _cache;
}

/** 写前磁盘合并（2026-08-10 F15 缺口2）: 跨实例（dev+绿色包同跑）防互踩 —
 *  重读磁盘 → 槽位级合并，本实例条目与他实例条目均按 ts 新者胜，绝不整库覆盖
 *  （整库覆盖会让后写实例把先写实例的槽位蒸发 → 召回 miss + 下拉错乱）。
 *  与 sq3 库「写前合并只补缺不覆盖」同款模式（铁律 8.2）。 */
function _save(): void {
    const reg = _load();
    reg.updatedAt = Date.now();
    try {
        const j = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
        if (j && j.version === 1 && j.slots && typeof j.slots === 'object') {
            for (const k of SQUAD_ORDER) {
                const mine = reg.slots[k];
                const theirs = j.slots[k];
                if (mine && theirs) {
                    reg.slots[k] = (theirs.ts ?? 0) > (mine.ts ?? 0) ? theirs : mine;
                } else if (!mine && theirs) {
                    reg.slots[k] = theirs;   // 他实例刚写入的槽位不得被本实例旧内存态抹掉
                }
            }
        }
    } catch { /* 磁盘缺失/损坏 → 内存态直写 */ }
    const p = registryPath();
    _rotatePrev(); // 写前轮换 .prev（F18: 保留上一完好版，磁盘损坏可回退）
    const tmp = p + '.tmp-' + process.pid; // pid 后缀防跨实例双写互踩（固定名会互相覆盖 tmp）
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

/** 窗口创建即认领（顺序 1 2 q w a s z x，取最近空闲）；无空闲返回 null（>8 窗口）
 *  写后验证（2026-08-10）: 认领后立即回读磁盘确认槽位仍属自己——跨实例并发认领同槽时
 *  LWW 会让后写者赢，败者必须立刻发现并重选，绝不带着分裂状态活下来。 */
export function claimSquad(win: BrowserWindow): string | null {
    _manualNone.delete(win.id); // 自动认领 → 清除主动 none 标记
    for (let attempt = 0; attempt < 3; attempt++) {
        _loadFresh(); // 认领前看磁盘真相（防陈旧缓存抢到已被他实例占用的槽位）
        const slot = _findFreeSlot();
        if (!slot) { return null; }
        const reg = _load();
        reg.slots[slot] = { winId: win.id, hwnd: _hwndOf(win), pid: process.pid, folder: '', title: '', ts: Date.now() };
        _save();
        // 写后验证：槽位在磁盘上必须仍是自己（防被并发写盘顶掉）
        const mine = _loadFresh().slots[slot];
        if (mine && mine.winId === win.id && mine.pid === process.pid) { return slot; }
    }
    return null; // 3 次全被抢 → 放弃（watcher 自愈会再找机会）
}

/** 窗口关闭 → 槽位回到空闲 */
export function releaseSquad(winId: number): void {
    _manualNone.delete(winId);
    const reg = _loadFresh(); // 释放前看磁盘真相（防释放路径凭旧缓存把他人条目误清）
    let changed = false;
    for (const k of SQUAD_ORDER) {
        const e = reg.slots[k];
        if (e && e.winId === winId) { reg.slots[k] = null; changed = true; }
    }
    if (changed) { _save(); }
}

/** 文件夹/标题刷新（renderer setTitle 路径）→ 更新条目 + 应用 OS 标题 */
export function refreshWindowEntry(win: BrowserWindow, folder: string, rawTitle: string): void {
    const reg = _loadFresh(); // 看磁盘真相：条目已被他实例顶掉 → 走下方无条目分支（去前缀）
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

/** 手动改编队（UI 按钮下拉）; target='none' → 解除编队（无分组, 标题去前缀, 不可召回） */
export function setSquad(win: BrowserWindow, target: string, folder: string): { ok: boolean; reason?: string } {
    if (target === 'none' || target === '') {
        const current = getSquadOf(win.id);
        if (current === null) { return { ok: false, reason: 'same_slot' }; }
        _manualNone.add(win.id); // 主动 none → watcher 自愈不再自动重认领
        const reg = _loadFresh();
        for (const k of SQUAD_ORDER) {
            const e = reg.slots[k];
            if (e && e.winId === win.id) { reg.slots[k] = null; }
        }
        _save();
        let name = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!name) {
            try { name = _stripPrefix(win.isDestroyed() ? '' : win.getTitle()); } catch { name = ''; }
        }
        _applyTitle(win, null, name);
        return { ok: true };
    }
    if (!SQUAD_ORDER.includes(target)) { return { ok: false, reason: 'invalid_slot' }; }
    _manualNone.delete(win.id); // 手动选组 → 恢复可自动认领
    const reg = _loadFresh(); // 改编队前看磁盘真相（防陈旧缓存把已占槽位判为空闲）
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
    // 写后验证：目标槽位被并发抢占 → 如实报 occupied（内存已是磁盘真值，下拉刷新后正确）
    const mine = _loadFresh().slots[target];
    if (!mine || mine.winId !== win.id || mine.pid !== process.pid) { return { ok: false, reason: 'occupied' }; }
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
    const reg = _loadFresh(); // 每次 get 强刷磁盘真相（watcher 未就绪/被顶期间下拉也绝不分裂）
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

// ═══════════════════════════════════════════════════════════════
// 跨实例中心大脑 — fs.watch 监听 squads.json（2026-08-10）
// 原理: gaea-process 状态文件监听同款（F22 验证模式）——文件系统即 IPC。
//       其他启动路径实例写盘 → 本实例 watcher 事件 → 200ms 防抖 →
//       _loadFresh 重读 → 窗口失去槽位自动重认领 / 标题纠正 → 广播秒同步。
// 自愈: error → 指数退避重建（1s→30s cap）；30s 兜底 poll 防 watcher 静默死亡。
// 自写去重: 磁盘与 _cache 逐槽位 (pid,winId,ts) 全等 → 跳过，零噪音。
// ═══════════════════════════════════════════════════════════════

let _watcher: fs.FSWatcher | null = null;
let _watchTimer: NodeJS.Timeout | null = null;
let _watchRetry: { timer: NodeJS.Timeout; backoff: number } | null = null;
let _watchPoll: NodeJS.Timeout | null = null;
let _watchStarted = false;
let _tmpCleaned = false;
/** 主动 none 的窗口（winId）→ 被顶掉/条目蒸发时绝不自动重认领（用户意图优先） */
const _manualNone = new Set<number>();

function _cleanStaleTmp(): void {
    if (_tmpCleaned) { return; }
    _tmpCleaned = true;
    try {
        const dir = path.join(os.homedir(), 'AppData', 'Local', 'qqqide');
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith('squads.json.tmp-')) {
                try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
}

function _sameEntry(a: SquadEntry | null, b: SquadEntry | null): boolean {
    if (!a || !b) { return a === b; }
    return a.pid === b.pid && a.winId === b.winId && a.ts === b.ts;
}

/** watcher/poll 触发 → 磁盘即真理：合并 + 自愈（重认领/标题纠正）+ 广播 */
function _onRegistryChanged(): void {
    const disk = _readDisk();
    if (!disk) { return; } // 磁盘不可读（瞬时空窗）→ 等下次事件/poll
    const mem = _cache;
    if (mem) {
        let same = true;
        for (const k of SQUAD_ORDER) {
            if (!_sameEntry(disk.slots[k], mem.slots[k])) { same = false; break; }
        }
        _cache = disk;
        if (same) { return; } // 自写/无实质变化 → 零噪音
    } else {
        _cache = disk;
    }
    // 自愈：本进程窗口槽位纠正 + 被顶掉者自动重认领
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) { continue; }
        const slot = getSquadOf(win.id); // 读 _cache（=磁盘真值）
        if (!slot) {
            if (_manualNone.has(win.id)) { continue; } // 主动 none，不打扰
            claimSquad(win); // 被顶/条目蒸发 → 自动重认领空闲槽（内部写后验证+广播时机由调用方定）
            continue;
        }
        // 标题纠正：磁盘槽位 vs 窗口当前标题前缀（防标题分裂）
        try {
            const t = win.getTitle();
            if (!t.startsWith(slot + '\u25A0')) {
                _applyTitle(win, slot, _stripPrefix(t));
            }
        } catch { /* ignore */ }
    }
    broadcastSquadState();
}

/** 启动跨实例监听（registerSquadIpc 时调用一次；幂等） */
export function startSquadWatcher(): void {
    if (_watchStarted) { return; }
    _watchStarted = true;
    _cleanStaleTmp();
    // ★ 30s 兜底 poll 总是启动：watcher 静默死亡（目录被删/句柄失效无 error）也有界收敛
    _watchPoll = setInterval(_onRegistryChanged, 30000);
    _startWatcher();
}

function _startWatcher(): void {
    try {
        const dir = path.join(os.homedir(), 'AppData', 'Local', 'qqqide');
        fs.mkdirSync(dir, { recursive: true });
        const watcher = fs.watch(dir, (_evt, filename) => {
            // 有事件 = watcher 活着 → 取消挂起的重建退避
            if (_watchRetry) { clearTimeout(_watchRetry.timer); _watchRetry = null; }
            const name = filename ? String(filename) : '';
            if (name === 'squads.json' || name.startsWith('squads.json.tmp-')) {
                if (_watchTimer) { clearTimeout(_watchTimer); }
                _watchTimer = setTimeout(() => { _watchTimer = null; _onRegistryChanged(); }, 200);
            }
        });
        // error（目录被删等）→ 关闭 → 指数退避重建 1s→2s→…→30s cap
        watcher.on('error', () => {
            console.warn('[squad] registry watch error, rebuild with backoff');
            try { watcher.close(); } catch { /* ignore */ }
            if (_watcher === watcher) { _watcher = null; }
            const delay = _watchRetry ? Math.min(_watchRetry.backoff * 2, 30000) : 1000;
            _watchRetry = {
                timer: setTimeout(() => { _watchRetry = null; _startWatcher(); }, delay),
                backoff: delay,
            };
        });
        _watcher = watcher;
        console.log('[squad] registry watch started: ' + dir);
    } catch (e: any) {
        console.warn('[squad] registry watch failed: ' + (e && e.message ? e.message : e) + ' (30s poll fallback active)');
    }
}
