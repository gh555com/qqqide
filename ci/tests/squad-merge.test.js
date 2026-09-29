// ci/tests/squad-merge.test.js — 窗口编队写前合并三律（释放即真相 / 陈旧即焚 / LWW）
// 对象: shell/squad-manager.ts 的 _mergeSlotsForSave（esbuild bundle → .build/squad-manager.cjs；
//   isStale / selfPid 注入 → 脱离 Electron 可测）
// 语义锚: 铁律 §4.5「合并三律」——① 双方皆有 → ts 新者胜；胜者陈旧 → 落 null
//   ② 仅我有 → 活窗重断言（刷心跳），其余清除 ③ 仅磁盘有 → 他实例未陈旧 → 恢复；本实例已释放 → 不复活
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fx = require(path.join(__dirname, '.build', 'squad-manager.cjs'));
const { _mergeSlotsForSave, SQUAD_ORDER } = fx;

const SELF = 555;
const OTHER = 777;

const ALIVE = () => false;                 // 恒不陈旧
const STALE_IF_MARKED = (e) => e._stale === true;

function entry(over) {
  return Object.assign(
    { winId: 1, hwnd: '0', pid: SELF, folder: 'C:/x', title: 'x', ts: 1000 },
    over
  );
}
function reg(slots) {
  const s = {};
  for (const k of SQUAD_ORDER) s[k] = null;
  Object.assign(s, slots);
  return { version: 1, updatedAt: 0, slots: s };
}

// ── ① 双方皆有: LWW + 陈旧即焚 ──

test('① 双方皆有 → ts 新者胜（磁盘新）', () => {
  const mine = reg({ q: entry({ pid: SELF, ts: 100 }) });
  const disk = reg({ q: entry({ pid: OTHER, ts: 200 }) });
  _mergeSlotsForSave(mine, disk, SELF, ALIVE);
  assert.equal(mine.slots.q.pid, OTHER);
  assert.equal(mine.slots.q.ts, 200);
});

test('① 双方皆有 → ts 新者胜（我新）', () => {
  const mine = reg({ q: entry({ pid: SELF, ts: 300 }) });
  const disk = reg({ q: entry({ pid: OTHER, ts: 200 }) });
  _mergeSlotsForSave(mine, disk, SELF, ALIVE);
  assert.equal(mine.slots.q.pid, SELF);
  assert.equal(mine.slots.q.ts, 300);
});

test('① 双方皆有 → ts 平局归我（严格大于才换主）', () => {
  const mine = reg({ q: entry({ pid: SELF, ts: 200 }) });
  const disk = reg({ q: entry({ pid: OTHER, ts: 200 }) });
  _mergeSlotsForSave(mine, disk, SELF, ALIVE);
  assert.equal(mine.slots.q.pid, SELF);
});

test('① 胜者已陈旧 → 直接落 null（陈旧即焚，鬼条目不永续磁盘）', () => {
  const mine = reg({ q: entry({ pid: SELF, ts: 100 }) });
  const disk = reg({ q: entry({ pid: OTHER, ts: 200, _stale: true }) });
  _mergeSlotsForSave(mine, disk, SELF, STALE_IF_MARKED);
  assert.equal(mine.slots.q, null);
});

test('① 我方胜者已陈旧 → 同样落 null', () => {
  const mine = reg({ q: entry({ pid: SELF, ts: 300, _stale: true }) });
  const disk = reg({ q: entry({ pid: OTHER, ts: 200 }) });
  _mergeSlotsForSave(mine, disk, SELF, STALE_IF_MARKED);
  assert.equal(mine.slots.q, null);
});

// ── ② 仅我有（磁盘无）: 活窗重断言 / 其余清除 ──

test('② 仅我有 + 本实例活窗 → 保留并刷心跳（ts 前进）', () => {
  const mine = reg({ w: entry({ pid: SELF, ts: 1 }) });
  _mergeSlotsForSave(mine, reg({}), SELF, ALIVE);
  assert.equal(mine.slots.w.pid, SELF);
  assert.ok(mine.slots.w.ts > 1, 'ts should be refreshed, got ' + mine.slots.w.ts);
});

test('② 仅我有 + 本实例已死窗口（陈旧）→ 清除', () => {
  const mine = reg({ w: entry({ pid: SELF, ts: 1, _stale: true }) });
  _mergeSlotsForSave(mine, reg({}), SELF, STALE_IF_MARKED);
  assert.equal(mine.slots.w, null);
});

test('② 仅我有 + 他实例残留 → 清除（禁复活他实例已释放的槽）', () => {
  const mine = reg({ w: entry({ pid: OTHER, ts: 999 }) });
  _mergeSlotsForSave(mine, reg({}), SELF, ALIVE);
  assert.equal(mine.slots.w, null);
});

// ── ③ 仅磁盘有: 他实例未陈旧恢复 / 本实例已释放不复活 ──

test('③ 仅磁盘有 + 他实例未陈旧 → 恢复', () => {
  const mine = reg({});
  const disk = reg({ a: entry({ pid: OTHER, ts: 500 }) });
  _mergeSlotsForSave(mine, disk, SELF, ALIVE);
  assert.equal(mine.slots.a.pid, OTHER);
  assert.equal(mine.slots.a.ts, 500);
});

test('③ 仅磁盘有 + 他实例已陈旧 → 不恢复（落 null）', () => {
  const mine = reg({});
  const disk = reg({ a: entry({ pid: OTHER, ts: 500, _stale: true }) });
  _mergeSlotsForSave(mine, disk, SELF, STALE_IF_MARKED);
  assert.equal(mine.slots.a, null);
});

test('③ 仅磁盘有 + 本实例条目（已释放）→ 绝不复活（2026-08-16 bug 防回归）', () => {
  const mine = reg({});
  const disk = reg({ a: entry({ pid: SELF, ts: 500 }) });
  _mergeSlotsForSave(mine, disk, SELF, ALIVE);
  assert.equal(mine.slots.a, null);
});

// ── 防御: 磁盘态无效 → 内存态直写（不动任何槽）──

test('磁盘 JSON 缺失/结构无效 → 内存态原样保留', () => {
  const mine = reg({ q: entry({ pid: SELF, ts: 100 }) });
  const before = JSON.stringify(mine);
  _mergeSlotsForSave(mine, null, SELF, ALIVE);
  _mergeSlotsForSave(mine, {}, SELF, ALIVE);
  _mergeSlotsForSave(mine, { version: 2, slots: {} }, SELF, ALIVE);
  assert.equal(JSON.stringify(mine), before);
});

test('双 null 槽保持 null（空槽零共谋）', () => {
  const mine = reg({});
  _mergeSlotsForSave(mine, reg({}), SELF, ALIVE);
  for (const k of SQUAD_ORDER) assert.equal(mine.slots[k], null);
});
