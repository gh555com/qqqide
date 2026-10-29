// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// player-vig.ts — 播放器履历（vig 'player' 模块）采集机
//
// 职责:
//   1. 域分派（唯一写者纪律）:
//      宿主域（--qqqide-play 播放器宿主进程）→ {Data}/alphal/player-vig.host.json
//      IDE 域                                  → vig.json 'player' 模块（复用 vig.ts 采集机）
//      两域同写一个文件会互相覆盖 → 分文件，ping 时求和合并（与 winthere/card 动态回读同式）
//   2. wq-ping 每次 ping 合并 IDE 侧 + 宿主侧 → body.vig.player（服务端 device_vig.player_*）
//
// 字段（3 个计分维度，2026-10-29 定案）:
//   M1 播放核心   n 起播次数 / sec 实播秒 / a 音频次数 / v 视频次数
//   M2 兼容链路   nat 原生直放成功次数 / tx 进转码兜底次数 / tw 转码累计等待秒
//   M3 系统身份   def 成功接管系统默认播放器次数 / defn 最近一次接管到的类数（计数器外的 gauge）
//   t0 首次使用 Unix 秒（模块约定）
//
// 语义铁律:
//   · 纯计数（无内容/无路径/无文件名）——绝不携带用户媒体信息
//   · 计数（n/sec/a/v/nat/tx/tw/def）单调累加；gauge（defn）取最大值，不走累加
//   · 写盘 tmp+rename 原子写 + 800ms 防抖（崩溃最多丢 1 秒内计数）
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { ipcMain } from 'electron';
import { getDataDir } from './portable-paths';
import { vigBump, vigSet } from './vig';

const MAX_N = 1_000_000;
const MAX_BIG = Number.MAX_SAFE_INTEGER;
const SAVE_DEBOUNCE_MS = 800;

/** 计数键（累加） */
const COUNT_KEYS = ['n', 'sec', 'a', 'v', 'nat', 'tx', 'tw', 'def'] as const;
/** 全部键（含 gauge defn 与 t0） */
const ALL_KEYS = ['n', 'sec', 'a', 'v', 'nat', 'tx', 'tw', 'def', 'defn', 't0'] as const;

let _hostMode = false;
let _bag: Record<string, number> | null = null;
let _timer: ReturnType<typeof setTimeout> | null = null;

function _file(): string {
    return path.join(getDataDir(), 'alphal', 'player-vig.host.json');
}

function _clamp(k: string, v: number): number {
    if (!Number.isFinite(v) || v < 0) return 0;
    if (k === 'sec' || k === 'tw' || k === 't0') return Math.min(Math.floor(v), MAX_BIG);
    return Math.min(Math.floor(v), MAX_N);
}

/** t0 合法性（与服务端 clampT0 同义：早于 2020 或晚于当前 → 丢弃） */
function _t0Ok(v: number): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    return Number.isFinite(v) && v >= 1577836800 && v <= nowSec;
}

function _empty(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const k of ALL_KEYS) o[k] = 0;
    return o;
}

function _loadHost(): Record<string, number> {
    if (_bag) return _bag;
    const bag = _empty();
    try {
        const d: any = JSON.parse(fs.readFileSync(_file(), 'utf8'));
        if (d && typeof d === 'object') {
            for (const k of ALL_KEYS) {
                const v = Number(d[k]);
                if (!Number.isFinite(v) || v <= 0) continue;
                if (k === 't0') { if (_t0Ok(v)) bag.t0 = Math.floor(v); continue; }
                bag[k] = _clamp(k, v);
            }
        }
    } catch { /* 首次运行 */ }
    _bag = bag;
    return bag;
}

/** 立即落盘（原子 tmp+rename）。退出/低频场景可直接调；常规埋点走防抖。 */
export function playerVigFlush(): void {
    if (!_bag) return;
    const fp = _file();
    const tmp = fp + '.tmp';
    try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(_bag), 'utf8');
        fs.renameSync(tmp, fp);
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
}

function _saveSoon(): void {
    if (_timer) return;
    _timer = setTimeout(() => { _timer = null; playerVigFlush(); }, SAVE_DEBOUNCE_MS);
    try { if (_timer && (_timer as any).unref) { (_timer as any).unref(); } } catch { /* ignore */ }
}

/** 宿主域：增量累加（唯一写者 = 播放器宿主进程）。t0 首次自动落值。 */
export function playerHostVigBump(add: Record<string, number>): void {
    if (!add || typeof add !== 'object') return;
    const bag = _loadHost();
    let touched = false;
    for (const k of Object.keys(add)) {
        if (k === 't0') continue;
        if (k === 'defn') continue;                         // gauge 不走累加
        if (!(COUNT_KEYS as readonly string[]).includes(k)) continue;
        const v = Number((add as any)[k]) || 0;
        if (!(v > 0)) continue;                 // 负值/零一律忽略（计数只能前进）
        bag[k] = _clamp(k, (bag[k] || 0) + v);
        touched = true;
    }
    if (touched) {
        if (!bag.t0 || bag.t0 <= 0) bag.t0 = Math.floor(Date.now() / 1000);
        _saveSoon();
    }
}

/** 域分派埋点（壳层内部调用点：ipc-fileassoc 等；渲染层走 qqqide:player:vig 同链）。 */
export function playerVigBump(add: Record<string, number>): void {
    try {
        if (_hostMode) { playerHostVigBump(add); return; }
        vigBump('player', add);
    } catch { /* ignore */ }
}

/** gauge 写（defn = 最近一次接管类数）：宿主域取最大；IDE 域覆盖写。 */
export function playerVigGauge(patch: Record<string, number>): void {
    try {
        const defn = _clamp('defn', Number(patch && patch.defn) || 0);
        if (defn <= 0) return;
        if (_hostMode) {
            const bag = _loadHost();
            if (defn > (bag.defn || 0)) { bag.defn = defn; _saveSoon(); }
            return;
        }
        vigSet('player', { defn });
    } catch { /* ignore */ }
}

/** 宿主侧外部读数（wq-ping 每 ping 合并；无文件/全零 → null）。 */
export function playerHostVigExternal(): Record<string, number> | null {
    try {
        const d: any = JSON.parse(fs.readFileSync(_file(), 'utf8'));
        if (!d || typeof d !== 'object') return null;
        const out: Record<string, number> = {};
        let any = false;
        for (const k of ALL_KEYS) {
            const v = Number(d[k]);
            if (!Number.isFinite(v) || v <= 0) continue;
            if (k === 't0') { if (_t0Ok(v)) out.t0 = Math.floor(v); continue; }
            out[k] = _clamp(k, v);
            any = true;
        }
        return any ? out : null;
    } catch { return null; }
}

/** 合并 IDE 侧 + 宿主侧（计数求和；defn 取大；t0 取最早正数）。无数据返回 undefined。 */
export function mergePlayerVig(ide: any, host: any): Record<string, number> | undefined {
    const a = (ide && typeof ide === 'object') ? ide : null;
    const b = (host && typeof host === 'object') ? host : null;
    if (!a && !b) return undefined;
    if (!a) return b;
    if (!b) return a;
    const sum: Record<string, number> = {};
    for (const k of ALL_KEYS) {
        const va = Number(a[k]) || 0;
        const vb = Number(b[k]) || 0;
        if (k === 't0') {
            const pos = [va, vb].filter((x) => x > 0);
            sum[k] = pos.length ? Math.min(...pos) : 0;
        } else if (k === 'defn') {
            sum[k] = Math.max(va, vb);
        } else {
            sum[k] = va + vb;
        }
    }
    const out: Record<string, number> = { n: sum.n };
    for (const k of ['sec', 'a', 'v', 'nat', 'tx', 'tw', 'def', 'defn', 't0']) {
        if (sum[k] > 0) out[k] = sum[k];
    }
    return out;
}

// ── IPC（两域共用同一频道；行为按域分派）──────────────────────────────────
//   qqqide:player:vig (add) — 渲染层埋点（媒体引擎 mount 内唯一调用点）
export function registerPlayerVigIpc(hostMode: boolean): void {
    _hostMode = !!hostMode;
    ipcMain.handle('qqqide:player:vig', (_e, add: Record<string, number>) => {
        try {
            playerVigBump((add && typeof add === 'object') ? add : {});
            return { ok: true };
        } catch { return { ok: false }; }
    });
}
