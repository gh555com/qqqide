// ci/tests/player-reveal.test.js — 截图「Roam 定位」跨进程裁决回归（纯函数）
// 背景（2026-10-03 q319）：播放器单宿主化后，「Roam 定位」必须跨进程落到同安装 IDE 主窗——
// 选窗序 / 请求陈腐 / 缺失爬升三条纯裁决以此锁定（IO 编排在 player-host.ts / ipc-player.ts）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const pr = require(path.join(__dirname, '.build', 'player-reveal.cjs'));

test('pickRevealWindowId：选窗序唯一（聚焦→最后聚焦→发起窗→任一）', () => {
    const alive = [11, 22, 33];
    // ① 当场聚焦 → 恒聚焦窗（压过一切，含发起窗）
    assert.strictEqual(pr.pickRevealWindowId({ pid: 100, winId: 22 }, { selfPid: 100, focusedId: 33, lastFocusedId: 11, aliveIds: alive }), 33);
    // ② 无聚焦 → 最后聚焦窗（「你正在操作滴」主语义；压过发起窗）
    assert.strictEqual(pr.pickRevealWindowId({ pid: 100, winId: 22 }, { selfPid: 100, focusedId: null, lastFocusedId: 11, aliveIds: alive }), 11);
    // ③ 无聚焦/无焦点历史 → 发起窗（同进程且存活）
    assert.strictEqual(pr.pickRevealWindowId({ pid: 100, winId: 22 }, { selfPid: 100, focusedId: null, lastFocusedId: null, aliveIds: alive }), 22);
    // 发起窗 pid 不同（陈旧/跨实例）→ 任一（数组首）
    assert.strictEqual(pr.pickRevealWindowId({ pid: 999, winId: 22 }, { selfPid: 100, focusedId: null, lastFocusedId: null, aliveIds: alive }), 11);
    // 发起窗已关（winId 不在存活集）→ 任一
    assert.strictEqual(pr.pickRevealWindowId({ pid: 100, winId: 77 }, { selfPid: 100, focusedId: null, lastFocusedId: null, aliveIds: alive }), 11);
    // 聚焦/最后聚焦均已关 → 逐一降级到任一
    assert.strictEqual(pr.pickRevealWindowId(null, { selfPid: 100, focusedId: 99, lastFocusedId: 77, aliveIds: alive }), 11);
    // 无聚焦时最后聚焦已关 → 发起窗兜底
    assert.strictEqual(pr.pickRevealWindowId({ pid: 100, winId: 22 }, { selfPid: 100, focusedId: null, lastFocusedId: 77, aliveIds: alive }), 22);
    // 零窗 → null
    assert.strictEqual(pr.pickRevealWindowId(null, { selfPid: 100, focusedId: 11, lastFocusedId: 11, aliveIds: [] }), null);
    // 脏 src（只有 pid）→ 不炸
    assert.strictEqual(pr.pickRevealWindowId({ pid: 100 }, { selfPid: 100, focusedId: null, lastFocusedId: 11, aliveIds: alive }), 11);
});

test('revealReqStale：陈腐 = ts≤0/NaN 或超龄（默认 60s）', () => {
    const now = 1000000;
    assert.strictEqual(pr.revealReqStale(now - 1000, now), false);
    assert.strictEqual(pr.revealReqStale(now - 60001, now), true);   // 刚过 60s 线
    assert.strictEqual(pr.revealReqStale(now - 59000, now), false);  // 未过线
    assert.strictEqual(pr.revealReqStale(0, now), true);
    assert.strictEqual(pr.revealReqStale(NaN, now), true);
    assert.strictEqual(pr.revealReqStale(now - 5000, now, 1000), true);
    assert.strictEqual(pr.revealReqStale(now - 500, now, 1000), false);
});

test('climbRevealTarget：命中即原样；缺失爬升最近存在祖先；全无 null', () => {
    const exist = new Set(['E:/', 'E:/a', 'E:/a/b']);
    const ex = (s) => exist.has(s);
    assert.strictEqual(pr.climbRevealTarget('E:/a/b', ex), 'E:/a/b');
    assert.strictEqual(pr.climbRevealTarget('E:/a/b/c.png', ex), 'E:/a/b');
    assert.strictEqual(pr.climbRevealTarget('E:/a/x/y/z.png', ex), 'E:/a');
    assert.strictEqual(pr.climbRevealTarget('E:/nope/zz', () => false), null);
    assert.strictEqual(pr.climbRevealTarget('', ex), null);
});
