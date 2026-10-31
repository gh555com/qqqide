// ci/tests/enter-send-only.test.js — 「Enter 恒发送 / 停止只归按钮字面」回归守卫。
// 事故机制（两代）：
//   ① Enter 支里写着 `if (streaming) { stopStream(); return; }`——_sending 在流式中恒真，
//      该支永远不可达（死代码），却把「回车可能变成停楼」的歧义留给了下一位读者。
//   ② 发送钮里 `if (_agBtn._stopState === 'sending') stopStream(); ... if (streaming) stopStream(); else {发送}`
//      ——fatal 全封顶时字面显示 Send，点击却先撞上停流分支（stop() 对非 sending 幂等空转）= 点了既不
//      停也不发（真黑洞）。
// 守卫：Enter 唯一语义 = 发送；停止唯一入口 = 发送钮字面 Stop（点击分派恒由 _sendBtnTruth 推导）；
//   两入口共用唯一闸门 _gateBeforeSend（拒绝必在冻结前）；死机制（_compressing / uncleanShutdown）零残留。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const INPUT = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-input.js'), 'utf8');
const SEND = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-send.js'), 'utf8');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.js$/.test(name)) out.push(p);
  }
  return out;
}

test('enter: Enter 只走发送闸门 —— 分支里不许出现停楼', () => {
  // Enter 块体：从 keydown 注册到块尾（首个 `});` 收口），块内禁 stopStream
  const i = INPUT.indexOf("$input.addEventListener('keydown', function (e) {\n    if (e.key === 'Enter' && !e.shiftKey) {");
  assert.ok(i > 0, 'Enter 发送入口缺失/形态变更');
  const body = INPUT.slice(i, INPUT.indexOf('\n});', i));
  assert.ok(body.indexOf('stopStream') < 0, 'Enter 支回潮：回车被允许停楼');
  assert.match(body, /if \(_gateBeforeSend\(\)\) _freezeAndSendFromInput\(\);/,
    'Enter 未走唯一闸门 + 冻结发送');
});

test('enter: 死支 `if (streaming) stopStream()` 零残留', () => {
  assert.ok(!/if \(streaming\)\s*\{\s*stopStream\(\);\s*(return;)?\s*\}/.test(INPUT),
    'Enter/按钮旧停流死支回潮');
});

test('button: 点击分派恒由 _sendBtnTruth 推导（字面=动作）', () => {
  const i = INPUT.indexOf('$sendBtn.onclick = function () {');
  assert.ok(i > 0, '发送钮点击入口缺失/形态变更');
  const body = INPUT.slice(i, INPUT.indexOf('\n};', i));
  assert.match(body, /var _t = _sendBtnTruth\(\);/, '点击未从真理机取字面（第二套判定回潮）');
  assert.match(body, /if \(_t\.inert\) return;/, 'Stop...（stopping）未 inert');
  assert.match(body, /_t\.st === 'fatal'[\s\S]*?_capRedBoxAndSeal/, 'fatal 活跃红框未走封顶收口');
  assert.match(body, /else stopStream\(\);/, 'sending 态点击未停楼');
  assert.match(body, /if \(_gateBeforeSend\(\)\) _freezeAndSendFromInput\(\);/, 'Send 字面点击未走同一发送路径');
});

test('button: stopStream 唯一调用者 = 发送钮（禁第二处停楼入口）', () => {
  const hits = INPUT.match(/stopStream\(\)/g) || [];
  assert.strictEqual(hits.length, 1, 'panel-input 停楼调用点应为 1 处（发现 ' + hits.length + '）');
  assert.ok(INPUT.indexOf('stopStream()') > INPUT.indexOf('$sendBtn.onclick'),
    '停楼调用不在发送钮内');
});

test('gate: 两入口共用唯一闸门 + 闸门与发送目标同源', () => {
  assert.strictEqual((INPUT.match(/function _gateBeforeSend\(\)/g) || []).length, 1,
    '_gateBeforeSend 必须唯一');
  const busy = INPUT.match(/_limitQoast\('send-busy'\)/g) || [];
  assert.strictEqual(busy.length, 1, '忙提示散落（应只在闸门内 1 处，发现 ' + busy.length + '）');
  assert.ok(!/_sendActive\(questActiveId\)/.test(INPUT), '闸门未与发送目标同源（仍在读全局 questActiveId）');
  assert.match(INPUT, /var _qid = _panelSendTarget\(\);[\s\S]*?_sendActive\(_qid\)/, '闸门未按发送目标判忙');
  assert.match(INPUT, /if \(_agGate && _agGate\._stopState === 'fatal'\)/, 'fatal 未在冻结前预拦（会白清编辑框）');
});

test('死机制零残留：_compressing / _uncleanShutdown', () => {
  const files = walk(path.join(R, 'server-app'), []);
  const bad = [];
  for (const f of files) {
    // service-worker.js = 版本变更日志归档（注释里会逐个点名历史机制），不参与源码扫描
    if (path.basename(f) === 'service-worker.js') continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/_compressing\b/.test(src) || /_uncleanShutdown\b/.test(src)) bad.push(path.relative(R, f));
  }
  assert.deepStrictEqual(bad, [], '死机制回潮（全库零写入者的状态标志）：' + bad.join(', '));
});

test('面板级按钮/封顶函数读面板真身（不读可变指针）', () => {
  assert.match(INPUT, /function updateQueueBtn\(\) \{\s*\n\s*var _ag = \(typeof _resolveBtnAgent === 'function'\) \? _resolveBtnAgent\(\) : null;/,
    'updateQueueBtn 未走面板真身');
  assert.match(SEND, /function _capRedBoxAndSeal\(\) \{\s*\n\s*var ag = \(typeof _resolveBtnAgent === 'function'\) \? _resolveBtnAgent\(\) : _activeAgent;/,
    '_capRedBoxAndSeal 未走面板真身');
});
