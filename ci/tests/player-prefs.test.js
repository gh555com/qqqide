// ci/tests/player-prefs.test.js — 播放偏好跨窗继承机器回归（纯函数）
// 背景（2026-10-02 q319）：关掉上一个播放器窗后新窗丢失记忆（列表循环/随机/倍速）——
// 偏好机器上线后语义 = 全局偏好恒胜；无记录才落出厂默认（多文件列表循环开）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const pp = require(path.join(__dirname, '.build', 'player-prefs.cjs'));

test('coercePref：rate/volume 钳制、loop one→all、脏值 → undefined', () => {
    assert.strictEqual(pp.coercePref('rate', 17), 16);
    assert.strictEqual(pp.coercePref('rate', 0.01), 0.0625);
    assert.strictEqual(pp.coercePref('rate', 'x'), undefined);
    assert.strictEqual(pp.coercePref('volume', 2), 1.5);
    assert.strictEqual(pp.coercePref('volume', -1), 0);
    assert.strictEqual(pp.coercePref('loop', 'one'), 'all');
    assert.strictEqual(pp.coercePref('loop', 'all'), 'all');
    assert.strictEqual(pp.coercePref('loop', 'weird'), undefined);
    assert.strictEqual(pp.coercePref('shuffle', 1), undefined);
    assert.strictEqual(pp.coercePref('muted', true), true);
});

test('applyPrefsToSession：有偏好 = 记忆恒胜（多列表也沿用）', () => {
    const sess = { list: [{}, {}], rate: 1, loop: 'off', shuffle: false, follow: false, volume: 1, muted: false };
    pp.applyPrefsToSession(sess, { list: [{}, {}] }, { rate: 2.5, loop: 'off', shuffle: true, follow: true, volume: 0.8, muted: true });
    assert.strictEqual(sess.rate, 2.5);
    assert.strictEqual(sess.loop, 'off');        // ★ 记忆的 loop=off 压过「多文件列表循环开」出厂默认
    assert.strictEqual(sess.shuffle, true);
    assert.strictEqual(sess.follow, true);
    assert.strictEqual(sess.volume, 0.8);
    assert.strictEqual(sess.muted, true);
});

test('applyPrefsToSession：无偏好 = 出厂默认（多列表循环开 / 单文件关）', () => {
    const multi = { list: [{}, {}], rate: 1, loop: 'off', shuffle: false, follow: false, volume: 1, muted: false };
    pp.applyPrefsToSession(multi, {}, {});
    assert.strictEqual(multi.loop, 'all');
    const single = { list: [{}], rate: 1, loop: 'all', shuffle: false, follow: false, volume: 1, muted: false };
    pp.applyPrefsToSession(single, {}, {});
    assert.strictEqual(single.loop, 'off');
});

test('applyPrefsToSession：显式初值恒胜（payload 传了就不覆盖）', () => {
    // 真实流程：_normSession(payload) 先把显式值落进 sess，再由本函数补缺——所以 sess 已 = payload 值
    const sess = { list: [{}], rate: 0.75, loop: 'all', shuffle: false, follow: false, volume: 1, muted: false };
    pp.applyPrefsToSession(sess, { rate: 0.75, loop: 'all' }, { rate: 3, loop: 'off' });
    assert.strictEqual(sess.rate, 0.75);   // 不被偏好 3 覆盖
    assert.strictEqual(sess.loop, 'all');  // 不被偏好 off 覆盖
});

test('notePrefChanges：patch 里出现的字段才推进（取归一后的会话值）', () => {
    // 真实流程：setSession 先把 patch 应用进 sess，再采集——此处模拟已更新后的 sess
    const sess = { rate: 2, loop: 'all', shuffle: false, follow: true, volume: 0.5, muted: false };
    const pending = pp.notePrefChanges(null, { rate: 2, shuffle: false }, sess);
    assert.strictEqual(pending.rate, 2);
    assert.strictEqual(pending.shuffle, false);
    assert.strictEqual(pending.loop, undefined);     // patch 未带 loop → 不推进
    assert.strictEqual(pending.volume, undefined);
    assert.strictEqual(pending.follow, undefined);
});

test('mergePrefsIntoStore：字段级合并（不清空其他字段）', () => {
    const store = { version: 2, packs: {}, prefs: { rate: 1, shuffle: false } };
    const changed = pp.mergePrefsIntoStore(store, { rate: 1.5, muted: true });
    assert.strictEqual(changed, true);
    assert.strictEqual(store.prefs.rate, 1.5);
    assert.strictEqual(store.prefs.muted, true);
    assert.strictEqual(store.prefs.shuffle, false);   // 未提及字段原样保留
    assert.strictEqual(pp.mergePrefsIntoStore(store, null), false);
    assert.strictEqual(pp.mergePrefsIntoStore(store, {}), false);
});
