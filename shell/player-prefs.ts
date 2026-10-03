// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// player-prefs.ts — 播放偏好跨窗继承机器（纯逻辑；唯一消费者 = shell/ipc-player.ts 宿主域）
//
// 语义（2026-10-02 q319 定案「跨窗记忆完美闭环」）：
//   记忆字段 = { rate, loop, shuffle, follow, volume, muted }（store 顶层 prefs·跨包共享，与 lastPos 同域）
//   写点 = 任一窗 setSession 真变化（字段级累计 → 写盘时并入 store，跨实例/跨包字段级 LWW 不互踩）
//   读点 = 新窗出生（显式初值恒胜；无偏好记录 → 出厂默认 = 多文件列表循环开/单文件关，其余同会话默认）
//   恢复窗 = 读自身会话（装载后渲染层即刻回写一次 → 偏好自然推进为「最近使用」）
//   无广播：多窗各自独立播放，全局 = 最后一次变更。A-B/进度（per-file）、窗口几何（会话/lastPos）、
//   拉伸档（即席动作）、置顶（会话属性）= 明确不继承。
// ============================================================================

export const PREF_FIELDS = ['rate', 'loop', 'shuffle', 'follow', 'volume', 'muted'] as const;

/** 从 store 提取偏好对象（拷贝；缺失/脏数据 → 空对象）。 */
export function prefsFromStore(store: any): any {
    return (store && store.prefs && typeof store.prefs === 'object') ? { ...store.prefs } : {};
}

/** 字段值归一（脏值 → undefined = 不采用）；'one' 归一 'all'（存量）。 */
export function coercePref(field: string, v: any): any {
    if (field === 'rate') { return (typeof v === 'number' && isFinite(v)) ? Math.max(0.0625, Math.min(16, v)) : undefined; }
    if (field === 'loop') {
        if (v === 'one') { return 'all'; }
        return (v === 'off' || v === 'all') ? v : undefined;
    }
    if (field === 'shuffle' || field === 'follow' || field === 'muted') { return (typeof v === 'boolean') ? v : undefined; }
    if (field === 'volume') { return (typeof v === 'number' && isFinite(v)) ? Math.max(0, Math.min(1.5, v)) : undefined; }
    return undefined;
}

/** 新窗初值注入（仅非 restore 路径调用）：显式 payload 初值恒胜；无偏好 → 出厂默认（多文件列表 循环开）。 */
export function applyPrefsToSession(sess: any, payload: any, prefs: any): void {
    if (!sess || typeof sess !== 'object') { return; }
    const has = (k: string): boolean => !!(payload && typeof payload === 'object' && payload[k] !== undefined);
    const P = (prefs && typeof prefs === 'object') ? prefs : {};
    if (!has('rate')) { const v = coercePref('rate', P.rate); if (v !== undefined) { sess.rate = v; } }
    if (!has('loop')) {
        const v = coercePref('loop', P.loop);
        if (v !== undefined) { sess.loop = v; }
        else { sess.loop = (Array.isArray(sess.list) && sess.list.length > 1) ? 'all' : 'off'; }   // 出厂默认（旧「多文件列表打开重置」语义上移）
    }
    if (!has('shuffle')) { const v = coercePref('shuffle', P.shuffle); if (v !== undefined) { sess.shuffle = v; } }
    if (!has('follow')) { const v = coercePref('follow', P.follow); if (v !== undefined) { sess.follow = v; } }
    if (!has('volume')) { const v = coercePref('volume', P.volume); if (v !== undefined) { sess.volume = v; } }
    if (!has('muted')) { const v = coercePref('muted', P.muted); if (v !== undefined) { sess.muted = v; } }
}

/** setSession 真变化 → 累计待写字段（字段级；patch 里出现的字段才推进）。返回累计后的待写集。 */
export function notePrefChanges(pending: any, patch: any, sess: any): any {
    const P = (pending && typeof pending === 'object') ? pending : {};
    if (!patch || typeof patch !== 'object' || !sess || typeof sess !== 'object') { return P; }
    if (typeof patch.rate === 'number') { P.rate = sess.rate; }
    if (patch.loop !== undefined) { P.loop = sess.loop; }
    if (typeof patch.shuffle === 'boolean') { P.shuffle = sess.shuffle; }
    if (typeof patch.follow === 'boolean') { P.follow = sess.follow; }
    if (typeof patch.volume === 'number') { P.volume = sess.volume; }
    if (typeof patch.muted === 'boolean') { P.muted = sess.muted; }
    return P;
}

/** 待写字段并入 store.prefs（字段级合并——跨实例各写各的字段不互踩）；有并入返回 true。 */
export function mergePrefsIntoStore(store: any, pending: any): boolean {
    if (!store || typeof store !== 'object' || !pending || typeof pending !== 'object') { return false; }
    let changed = false;
    const P = (store.prefs && typeof store.prefs === 'object') ? store.prefs : {};
    for (const k of PREF_FIELDS) {
        if (pending[k] !== undefined) { P[k] = pending[k]; changed = true; }
    }
    if (changed) { store.prefs = P; }
    return changed;
}
