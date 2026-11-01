// ci/tests/dsecret-pending-loop.test.js — dsecret 待协同数「闭环」+ 焦点接力 契约守卫。
// 事故机制（多项目 AI 视口下必现）：
//   ① qoast 知道是哪个项目报了待协同，却把项目丢了 → 「去处理」打开控制台落主项目 → 一片空白
//   ② 项目下拉形同虚设（没有数字，看不出哪个项目还有东西）
//   ③ 数字若各算各的（UI 自己求和 / 引擎另算一份）→ 各项目之和 ≠ ALL（用户按和核账必定对不上）
// 守卫：计数与队列同一次计算（引擎 pendingView 一次给出 table + items）/
//   all = 行 count 之和（孤儿行也参与，绝不丢）/ ALL 哨兵两侧同值 /
//   焦点接力链（qoast → open(focusProject) → opener(ctx,opts) → init.focus → 零 IO 铺队列）/
//   ALL 视图批量按项归属回投（actMany），不跨项目串位。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const APP = path.join(R, 'server-app');
const SG = fs.readFileSync(path.join(APP, 'core', 'secret-guard.js'), 'utf8');
const HOST = fs.readFileSync(path.join(APP, 'core', 'gaea-host.js'), 'utf8');
const GW = fs.readFileSync(path.join(APP, 'goods', 'dsecret', 'dsecret.js'), 'utf8');
const UI = fs.readFileSync(path.join(APP, 'goods', 'dsecret', 'dsecret-ui.html'), 'utf8');

test('ALL 哨兵：引擎与 UI 同值（单侧改 = 汇总视图静默变空）', () => {
  assert.match(SG, /var PENDING_ALL = '__all__';/, '引擎 ALL 哨兵丢失/改名');
  assert.match(UI, /var ALL = '__all__';/, 'UI ALL 哨兵丢失/改名');
});

test('闭环靠构造：all = 各行 count 之和，孤儿项目也计入（不许漏项）', () => {
  const fn = SG.slice(SG.indexOf('function _pendingRows'));
  assert.ok(fn.length > 0, '_pendingRows 不存在');
  const body = fn.slice(0, fn.indexOf('function _copyItem'));
  assert.match(body, /all \+= n;/, '列表内项目未累计进 all');
  assert.match(body, /rows\.push\(\{ path: kk, name: _projBase\(kk\), count: ln, orphan: true \}\);\s*\n\s*all \+= ln;/, '孤儿行未计入 all（下方之和 ≠ ALL）');
  assert.match(body, /return \{ list: rows, all: all \};/, '未把 all 与行一起返回');
  // 计数与队列必须同源：items 只从同一张 _pendingT3 表产出
  const view = SG.slice(SG.indexOf('function _pendingView'));
  assert.match(view.slice(0, 700), /for \(var kk in _pendingT3\)/, '_pendingView 未直接遍历待协同表（第二套数据源）');
  assert.match(view.slice(0, 900), /return \{ table: table, items: items \};/, '未一次返回 table + items（计数与队列会分家）');
});

test('UI 不自己求和：只显示引擎给的数字（禁第二套算法）', () => {
  assert.match(UI, /_state\.allCount = table\.all \|\| 0;/, 'UI 未采用引擎给出的 all');
  assert.ok(!/_state\.allCount\s*=\s*[^;\n]*(reduce|\+\+|\+=)/.test(UI), 'UI 自行累加 allCount（闭环破裂根因）');
  assert.match(UI, /for \(var i = 0; i < _state\.rows\.length; i\+\+\) \{ if \(_state\.rows\[i\]\.path === k\) return _state\.rows\[i\]\.count \|\| 0; \}/, 'countOf 未从引擎行表取值');
  assert.match(UI, /_state\.allCount = table\.all \|\| 0;[\s\S]{0,260}renderQueueAll\(msg\.view\.items \|\| \[\]\)/, 'ALL 队列与 ALL 数字不同源');
});

test('焦点接力：qoast 带上项目 → opener 收 opts → init.focus → 零 IO 铺队列', () => {
  assert.match(SG, /onClick: function \(\) \{ _openDsecret\(key\); \}/, 'qoast 按钮丢项目（一片空白根因）');
  assert.match(SG, /window\.qqqGaea\.open\('dsecret', k \? \{ focusProject: k \} : undefined\)/, 'qoast 未把项目传给控制台');
  assert.match(HOST, /return def\.opener\(makeCtx\(id\), opts\);/, 'gaea-host 未透传 opts（opener 收不到 focusProject）');
  assert.match(GW, /opener: function \(ctx, opts\) \{ return openDsecretTab\(opts && opts\.focusProject\); \}/, 'dsecret opener 未消费 focusProject');
  assert.match(GW, /post\(win, 'dsecret:init', \{ enabled: enabled, projects: projects, current: current, focus: focus \}\);/, 'init 未携带 focus');
  assert.match(GW, /post\(_readyWin, 'dsecret:focus', \{ path: _focusWant \}\);/, '已开着的控制台收不到 focus（只能干瞪旧项目）');
  // 焦点路径必须零 IO：直达用快照，不许先扫盘
  const focusBlk = UI.slice(UI.indexOf("if (d.type === 'dsecret:focus')"));
  const blk = focusBlk.slice(0, focusBlk.indexOf("if (d.type === 'dsecret:pending-result')"));
  assert.match(blk, /loadPending\(true\);/, 'focus 未拉待协同快照');
  assert.ok(!/scan\(\)/.test(blk), 'focus 路径仍在扫盘（「去处理」不该付磁盘代价）');
});

test('ALL 视图：不扫盘 + 批量按项归属回投（不跨项目串位）', () => {
  assert.match(UI, /if \(p === ALL\) \{ enterAll\(\); return; \}   \/\/ ALL 不扫盘/, 'scan() 未拦 ALL（会拿哨兵当路径去 git status）');
  assert.match(UI, /var p = \(item && item\.proj\) \? item\.proj : curPath\(\);/, 'ALL 视图单条动作未按项所属项目回投');
  assert.match(GW, /run = sg\.actMany\(d\.paths, d\.action\)\.then\(function \(\) \{ return \[\]; \}\);/, '批量未走 actMany');
  assert.match(UI, /post\('dsecret:act', \{ path: curPath\(\), action: action, paths: allRowPaths\(\) \}\);/, 'ALL 批量未带项目集合');
  assert.match(UI, /\/\/ 项目视图批量走单项目入口[\s\S]{0,120}post\('dsecret:act', \{ path: curPath\(\), action: action \}\);/, '项目视图批量误走 actMany（状态行会报剩余 0）');
});
