// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// player-reveal.ts — 截图「📂 Roam 定位」跨进程裁决纯逻辑（2026-10-03 q319 定案）
//
// 背景：播放器窗只存在于宿主进程（--qqqide-play）——「Roam 定位」必须跨进程抵达
// 同安装的某个 IDE 主窗（Roam 是 IDE 里的文件浏览器）。通道 = 文件系统请求队列
// （Data/player-host/reveals/，契约详 player-host.ts）；本文件只承载可单测的纯裁决
// （选窗序 / 请求陈腐 / 缺失爬升），IO 编排分居 player-host.ts（IDE 侧）与 ipc-player.ts（宿主侧）。
//
//   选窗序（唯一权威，禁旁路第二套；2026-10-03 用户定案 = 强制召回「你正在操作滴」IDE）：
//   ① 当前聚焦的 IDE 主窗（处理时刻有 = 用户注意力当场所在，最强信号）
//   ② 最后聚焦过的 IDE 主窗（本进程焦点历史最近一个——多窗主语义：「你正在操作滴」）
//   ③ 发起窗（打开/追加该播放窗的 IDE 窗；src={pid,winId} 同进程且窗存活——历史线索兜底）
//   ④ 任一存活 IDE 主窗（确定性兜底 = 数组序第一个）
// ============================================================================

import * as path from 'path';

export interface RevealSrc { pid: number; winId: number; }
export interface RevealPickCtx {
    selfPid: number;
    focusedId: number | null;
    lastFocusedId: number | null;
    aliveIds: number[];
}

/** 选窗序唯一入口。任何异常输入（null/已关窗/异进程 src）一律降级到下一级，绝不 throw。 */
export function pickRevealWindowId(src: RevealSrc | null | undefined, ctx: RevealPickCtx): number | null {
    const ids = (ctx && Array.isArray(ctx.aliveIds)) ? ctx.aliveIds.filter((n) => typeof n === 'number') : [];
    if (!ids.length) { return null; }
    const has = (n: any): boolean => typeof n === 'number' && ids.indexOf(n) >= 0;
    if (has(ctx.focusedId)) { return ctx.focusedId as number; }          // ① 当场聚焦
    if (has(ctx.lastFocusedId)) { return ctx.lastFocusedId as number; }  // ② 最后操作（「你正在操作滴」——主语义）
    if (src && typeof src.pid === 'number' && typeof src.winId === 'number'
        && src.pid === ctx.selfPid && has(src.winId)) {
        return src.winId;                                                // ③ 发起窗兜底（历史线索）
    }
    return ids[0];                                                       // ④ 任一存活
}

/** 请求陈腐上限：宿主超时已兜底系统定位——IDE 迟到读到陈腐请求必须拒执（防「惊喜定位」）。 */
export const REVEAL_REQ_MAX_AGE_MS = 60000;

/** 陈腐判定：ts≤0/NaN 或早于 maxAgeMs（默认 60s）→ 陈腐。 */
export function revealReqStale(ts: number, now: number, maxAgeMs: number = REVEAL_REQ_MAX_AGE_MS): boolean {
    if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) { return true; }
    return (now - ts) > maxAgeMs;
}

/** 缺失爬升：从 p 起逐级取父目录，返回首个 exists() 为真的路径；全无 → null。
 *  用于系统定位兜底（截图后文件被删/移动：落到最近存在的祖先，不做死链）。 */
export function climbRevealTarget(p: string, exists: (s: string) => boolean): string | null {
    let cur = String(p || '');
    if (!cur) { return null; }
    for (let i = 0; i < 64; i++) {
        let ok = false;
        try { ok = !!exists(cur); } catch { ok = false; }
        if (ok) { return cur; }
        const parent = path.dirname(cur);
        if (!parent || parent === cur) { return null; }
        cur = parent;
    }
    return null;
}
