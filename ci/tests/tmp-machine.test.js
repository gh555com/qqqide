// ci/tests/tmp-machine.test.js — _qqq/tmp 轮转机器回归（纯函数：水位 / 判决三线 / 钉子 glob / 隔离时间戳）
// 语义锚点：tmp 默认可弃；要保命 = 改它（mtime）或钉它（.pin）；判决三线 = 熔断 → 年龄 → 水压。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const tm = require(path.join(__dirname, '.build', 'tmp-machine.cjs'));
const { TMP } = tm;

const DAY = 864e5;
const NOW = 1760000000000;             // 固定时基（避免实钟依赖）
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function f(rel, size, ageDays) { return { rel, abs: 'X:/tmp/' + rel, size, mtimeMs: NOW - ageDays * DAY }; }
function d(rel, ageDays) { return { rel, abs: 'X:/tmp/' + rel, mtimeMs: NOW - ageDays * DAY }; }
function sumSize(list) { return list.reduce((s, x) => s + x.size, 0); }

test('waterline：四档水位（大小 / 数量取最严）', () => {
    assert.strictEqual(tm.waterline(100 * MB, 10), 'calm');
    assert.strictEqual(tm.waterline(2 * GB, 10), 'soft');
    assert.strictEqual(tm.waterline(100 * MB, TMP.COUNT_FUSE + 1), 'soft');   // 数量过线也是 soft
    assert.strictEqual(tm.waterline(5 * GB, 10), 'hard');
    assert.strictEqual(tm.waterline(10 * GB, 10), 'panic');
});

test('effGraceMs：宽限随水位压缩 7d → 24h → 6h', () => {
    assert.strictEqual(tm.effGraceMs('calm'), 7 * DAY);
    assert.strictEqual(tm.effGraceMs('soft'), 7 * DAY);
    assert.strictEqual(tm.effGraceMs('hard'), DAY);
    assert.strictEqual(tm.effGraceMs('panic'), 6 * 36e5);
});

test('globToRe：* 不跨段 / ** 跨段 / ? 单字符', () => {
    assert.ok(tm.globToRe('*.log').test('a.log'));
    assert.ok(!tm.globToRe('*.log').test('a/b.log'));
    const dd = tm.globToRe('dir/**');
    assert.ok(dd.test('dir/'));
    assert.ok(dd.test('dir/a'));
    assert.ok(dd.test('dir/a/b'));
    assert.ok(!dd.test('dirx/a'));
    assert.ok(tm.globToRe('**/tmp.txt').test('tmp.txt'));
    assert.ok(tm.globToRe('**/tmp.txt').test('x/y/tmp.txt'));
    assert.ok(tm.globToRe('?.bak').test('a.bak'));
    assert.ok(!tm.globToRe('?.bak').test('ab.bak'));
    assert.ok(tm.globToRe('publish-backups/**').test('publish-backups/readme.md'));
});

test('parseTrashTs：{base36}~{名} → 隔离时刻；无效 → null', () => {
    const ts = Date.now();
    assert.strictEqual(tm.parseTrashTs(ts.toString(36) + '~a.txt'), ts);
    assert.strictEqual(tm.parseTrashTs('no-tilde'), null);
    assert.strictEqual(tm.parseTrashTs('123~x'), null);       // 过小 → 无效
    assert.strictEqual(tm.parseTrashTs('~x'), null);
});

test('planSweep：熔断——单文件 >1GB 且落定 ≥1h 直删（无视年龄）', () => {
    const files = [f('dump.txt', 1.5 * GB, 2 / 24)];          // 2 小时前落定
    const p = tm.planSweep(files, [], sumSize(files), files.length, NOW);
    assert.strictEqual(p.deleteList.length, 1);
    assert.strictEqual(p.deleteList[0].rel, 'dump.txt');
    // 落定不足 1h（正在写）→ 宽限保护，不动
    const files2 = [f('writing.bin', 1.5 * GB, 30 / 1440)];   // 30 分钟
    const p2 = tm.planSweep(files2, [], sumSize(files2), files2.length, NOW);
    assert.strictEqual(p2.deleteList.length + p2.quarantineList.length, 0);
});

test('planSweep：年龄线——≥30 天清；≤64MB 隔离、超 64MB 直删', () => {
    const files = [f('small.tmp', 1 * MB, 31), f('big.zip', 100 * MB, 31)];
    const p = tm.planSweep(files, [], sumSize(files), files.length, NOW);
    assert.deepStrictEqual(p.quarantineList.map((x) => x.rel), ['small.tmp']);
    assert.deepStrictEqual(p.deleteList.map((x) => x.rel), ['big.zip']);
});

test('planSweep：水压线——超软线清到回落线（最老优先，需过宽限）', () => {
    // 10 × 300MB（8 天老）→ 3GB soft；清 6 个 → 剩 1.2GB ≤ 回落线
    const files = [];
    for (let i = 0; i < 10; i++) { files.push(f('blob' + i, 300 * MB, 8)); }
    const p = tm.planSweep(files, [], sumSize(files), files.length, NOW);
    assert.strictEqual(p.level, 'soft');
    assert.strictEqual(p.deleteList.length, 6);
    assert.strictEqual(p.levelAfter, 'calm');
    // 同样的量但全是 1 天新文件 → 7d 宽限保护，零清理
    const fresh = [];
    for (let i = 0; i < 10; i++) { fresh.push(f('new' + i, 300 * MB, 1)); }
    const p2 = tm.planSweep(fresh, [], sumSize(fresh), fresh.length, NOW);
    assert.strictEqual(p2.deleteList.length + p2.quarantineList.length, 0);
    assert.strictEqual(p2.levelAfter, 'soft');                 // 如实：仍超线
});

test('planSweep：硬压档——宽限缩至 24h', () => {
    const files = [f('a', 2 * GB, 2), f('b', 2 * GB, 2), f('c', 2 * GB, 2)];   // 6GB → hard
    const p = tm.planSweep(files, [], sumSize(files), files.length, NOW);
    assert.strictEqual(p.level, 'hard');
    assert.strictEqual(p.graceMs, DAY);
    assert.strictEqual(p.deleteList.length, 3);                // 2 天 ≥ 24h 宽限 → 全清到回落
});

test('planSweep：极压档——宽限缩至 6h', () => {
    const files = [];
    for (let i = 0; i < 11; i++) { files.push(f('v' + i, 1 * GB, 8 / 24)); }   // 11GB，8 小时老
    const p = tm.planSweep(files, [], sumSize(files), files.length, NOW);
    assert.strictEqual(p.level, 'panic');
    assert.strictEqual(p.graceMs, 6 * 36e5);
    assert.strictEqual(p.deleteList.length, 10);               // 清到 ≤1.2GB（剩 1 个 = 1GB）
    assert.strictEqual(p.levelAfter, 'calm');
});

test('planSweep：数量熔断——>2 万件清到 1.5 万', () => {
    const files = [];
    for (let i = 0; i < 25000; i++) { files.push(f('f' + i, 1024, 8)); }
    const p = tm.planSweep(files, [], sumSize(files), files.length, NOW);
    assert.strictEqual(p.level, 'soft');
    const cleared = p.deleteList.length + p.quarantineList.length;
    assert.strictEqual(cleared, 10000);
    assert.strictEqual(25000 - cleared, TMP.COUNT_TO);
});

test('planSweep：时钟回拨（mtime 在未来）→ age 钳 0 → 宽限保护', () => {
    const files = [{ rel: 'future.tmp', abs: 'X:/future.tmp', size: 10 * MB, mtimeMs: NOW + 5 * DAY }];
    const p = tm.planSweep(files, [], sumSize(files), files.length, NOW);
    assert.strictEqual(p.deleteList.length + p.quarantineList.length, 0);
});

test('planSweep：mtime=0（无效）→ 视为最老候选仍过隔离/直删分级', () => {
    const files = [{ rel: 'zero.bin', abs: 'X:/zero.bin', size: 20 * MB, mtimeMs: 0 }];
    const p = tm.planSweep(files, [], sumSize(files), files.length, NOW);
    assert.strictEqual(p.quarantineList.length, 1);
});

test('planSweep：空目录候选（过宽限才进；内含新目录不动）', () => {
    const dirs = [d('old-empty', 10), d('just-made', 1)];
    const p = tm.planSweep([], dirs, 0, 0, NOW);
    assert.deepStrictEqual(p.rmdirList.map((x) => x.rel), ['old-empty']);
});

test('planSweep：空输入零输出（静水期只清年龄线）', () => {
    const p = tm.planSweep([], [], 0, 0, NOW);
    assert.strictEqual(p.level, 'calm');
    assert.strictEqual(p.deleteList.length + p.quarantineList.length + p.rmdirList.length, 0);
});
