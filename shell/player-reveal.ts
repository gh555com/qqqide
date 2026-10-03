// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// player-reveal.ts — 截图「📂 Roam 定位」跨进程裁决纯逻辑（2026-10-03 q319 定案）
//
// 背景：播放器窗只存在于宿主进程（--qqqide-play）——「Roam 定位」必须跨进程抵达
// 同安装的某个 IDE 主窗（Roam 是 IDE 里的文件浏览器）。通道 = 文件系统请求队列
// （Data/player-host/reveals/，契约详 player-host.ts）；本文件只承载可单测的纯裁决
// （选窗序 / 请求陈腐 / 缺失爬升），IO 编排分居 player-host.ts（IDE 侧）与 ipc-player.ts（宿主侧）。
//
// 选窗序（唯一权威，禁旁路第二套）：
//   ① 发起窗（打开/追加该播放窗的 IDE 窗；src={pid,winId} 同进程且窗存活）
//   ② 当前聚焦的 IDE 主窗（用户此刻注意力所在；点播放器按钮时宿主持焦点，通常落到下一级）
//   ③ 最后聚焦过的 IDE 主窗（本进程焦点历史——多窗用户「上一活跃窗」语义）
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
    if (src && typeof src.pid === 'number' && typeof src.winId === 'number'
        && src.pid === ctx.selfPid && has(src.winId)) {
        return src.winId;
    }
    if (has(ctx.focusedId)) { return ctx.focusedId as number; }
    if (has(ctx.lastFocusedId)) { return ctx.lastFocusedId as number; }
    return ids[0];
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
