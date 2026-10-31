// ci/tests/panel-pointer-split.test.js — 任务指针 × 面板指针解耦 回归守卫。
// 事故机制：_executeSend 曾把面板指针 _activeAgent 劫持成本次任务 agent（充当「任务指针」），
//   链尾再复位。劫持窗口内面板级派生态（_sending / streaming / _queue / 队列条 / 按钮 / 错误框）
//   全部指向后台任务：前台 Enter 被静默拒绝、队列条画别的任务、后台楼收尾掐掉前台的电子钟、
//   后台任务报错只剩半截状态（无红框无恢复入口）甚至画到前台任务头上。
// 守卫：① 任务目标恒局部 _tgt = pool[questId]，链任务执行期禁改写 _activeAgent
//   ② 面板级派生态恒由 questActiveId 直取真身（_panelAgent），不读可变指针
//   ③ 电子钟副作用仅对面板真身生效（setStreaming(val, agent)）
//   ④ 链尾复位机制（_restorePanelAgentHome）整体删除——无需劫持即无需复位
//   ⑤ 排水锁与错误归属按 quest/agent 持有，不跟面板走
//   ⑥ 版本推进（旧缓存会吞掉修复）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const PIPE = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-pipeline.js'), 'utf8');
const STATE = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-state.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-render.js'), 'utf8');
const SEND = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-send.js'), 'utf8');
const QUI = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-quest-ui.js'), 'utf8');
const CARD = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'card-pool.js'), 'utf8');
const SYNC = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-quest-sync.js'), 'utf8');
const SW = fs.readFileSync(path.join(R, 'server-app', 'service-worker.js'), 'utf8');

test('pipeline: 任务目标恒局部 _tgt —— 禁止把面板指针劫持成任务 agent', () => {
  assert.match(PIPE, /var _tgt = null;/, '缺少任务目标局部指针');
  assert.match(PIPE, /if \(_poolTgt && _poolTgt\[questId\]\) _tgt = _poolTgt\[questId\];/, '任务目标未从 pool[questId] 解析');
  assert.ok(!/_activeAgent\s*=\s*_poolTgt\[questId\]/.test(PIPE), '指针劫持回潮（_activeAgent = pool[questId]）');
  assert.ok(!/if \(_poolTgt && _poolTgt\[questId\]\) _activeAgent =/.test(PIPE), '指针劫持回潮（旧写法）');
  // 唯一允许改写面板指针的地方 = 草稿晋升（面板真的换任务了）
  const writes = PIPE.match(/_activeAgent = /g) || [];
  assert.ok(writes.length <= 2, '面板指针被多处改写（发现 ' + writes.length + ' 处；仅允许草稿晋升）');
  assert.match(PIPE, /_activeAgent = _getOrCreateAgent\(questActiveId\);\s*\n\s*_tgt = _activeAgent;/, '草稿晋升未同步任务目标');
});

test('pipeline: 发送闸门读本任务 agent（不是面板真身）', () => {
  assert.match(PIPE, /if \(_tgt && _tgt\._stopState === 'sending' && !isRecovery && !_isCompress\)/, '建楼闸门未读 _tgt');
  assert.match(PIPE, /if \(_tgt && _tgt\._stopState === 'stopping'\)/, '停止闸门未读 _tgt');
  assert.match(PIPE, /if \(_tgt && _tgt\._stopState === 'fatal' && !isRecovery\)/, 'fatal 闸门未读 _tgt');
  assert.match(PIPE, /if \(agent\._streaming && !_isCompress\)/, '流式闸门未读本任务 agent（跨 quest 误拦）');
  assert.ok(!/if \(streaming && !_isCompress\)/.test(PIPE), '流式闸门回潮（走面板 streaming 访问器）');
});

test('state: 面板级派生态恒解析面板真身 _panelAgent', () => {
  assert.match(STATE, /function _panelAgent\(\)/, '缺少面板真身解析唯一入口');
  assert.match(STATE, /var _qa = function \(\) \{ return _panelAgent\(\); \};/, '_queue 系访问器未走真身');
  assert.match(STATE, /get: function \(\) \{ var _ag = _panelAgent\(\); return !!\(_ag && _ag\._stopState === 'sending' && !_ag\._floorCompletedCleanly\); \}/, '_sending 未由真身派生');
  assert.match(STATE, /get: function \(\) \{ var _ag = _panelAgent\(\); return _ag \? _ag\._streaming : false; \}/, 'streaming 未由真身派生');
});

test('render: 电子钟副作用仅对面板真身生效', () => {
  assert.match(RENDER, /function setStreaming\(val, optAgent\)/, 'setStreaming 缺少 owner agent 形参');
  assert.match(RENDER, /if \(optAgent && optAgent !== _resolveBtnAgent\(\)\) return;/, '后台任务仍会拨本面板的电子钟');
  assert.match(RENDER, /function _resolveBtnAgent\(\) \{\s*\n\s*\/\/[^\n]*\n\s*return \(typeof _panelAgent === 'function'\)/, '_resolveBtnAgent 未收敛到 _panelAgent');
  assert.match(RENDER, /_activeAgent = _home;/, '1s 对账机缺少指针自愈');
});

test('pipeline: 链尾复位机制整体删除（无需劫持即无需复位）', () => {
  for (const [name, src] of [['panel-pipeline.js', PIPE], ['panel-quest-ui.js', QUI]]) {
    assert.ok(src.indexOf('_restorePanelAgentHome') < 0, name + ' 残留 _restorePanelAgentHome（废弃机制必须零残留）');
  }
});

test('pipeline: 错误归属恒本楼层 agent（不再按面板指针分叉）', () => {
  assert.ok(!/if \(_activeAgent === agent\) \{\s*\n\s*if \(aiDiv && aiDiv\._floorCompleted\)/.test(PIPE), 'onError 指针分叉回潮');
  assert.match(PIPE, /agent\._questErrorState\[_errFloorNum\]\.log\.push/, 'onError 未写红框真理源');
  assert.match(PIPE, /agent\.conversation\.push\(\{\s*\n\s*role: 'assistant',\s*\n\s*content: msg,/, 'onError 未写会话错误消息');
  assert.match(PIPE, /_renderQuestErrorBox\(agent, null, _errFloorNum\);/, 'onError 未渲染红框');
  const owned = SEND.match(/_qqqQuestId = agent\._questId \|\| questActiveId;/g) || [];
  assert.ok(owned.length >= 3, '红框「继续任务」归属未按 agent（发现 ' + owned.length + ' 处，需 ≥3）');
});

test('排水锁按 quest 持有（后台楼不得堵前台队列）', () => {
  assert.ok(!/var _queueBusy = false;/.test(STATE), '面板全局排水锁回潮');
  assert.ok(!/[^._\w]_queueBusy = /.test(PIPE.replace(/agent\._queueBusy/g, 'X')), 'pipeline 仍有裸 _queueBusy 赋值');
  assert.match(QUI, /if \(_aq && _aq\._queueBusy\) return;/, '排水前未检查目标 quest 自己的锁');
  assert.match(QUI, /if \(_aq\) _aq\._queueBusy = true;/, '排水未按 quest 上锁');
  assert.match(PIPE, /if \(agent\) agent\._queueBusy = false;/, '链收尾未释放本任务排水锁');
});

test('card: 「继续任务」链接归属恒本卡（禁读面板指针）', () => {
  assert.match(CARD, /CardPool\.prototype\._linkOwner = function \(node, card\) \{/, '缺少链接归属唯一入口');
  const calls = CARD.match(/cardPool\._linkOwner\(/g) || [];
  assert.ok(calls.length >= 2, '两处红框委托未走归属唯一入口（发现 ' + calls.length + ' 处）');
  assert.ok(!/var _curAgent = \(typeof _activeAgent !== 'undefined'\) \? _activeAgent : null;/.test(CARD), '红框委托回潮读面板指针');
  assert.match(CARD, /var _qid = \(card && card\.id\) \? card\.id : null;/, '归属未优先取本卡 id');
});

test('card: 驱逐守卫覆盖「楼未落定」三态（sending / stopping / _chainBusy）', () => {
  assert.match(CARD, /_evictAgent\._stopState === 'sending' \|\| _evictAgent\._stopState === 'stopping' \|\| _evictAgent\._chainBusy/, '驱逐守卫退回只看 sending（stopping 收尾窗 / 链上排队排水会被 abort+删池）');
});

test('input: 闸门 fatal 判定恒本次发送目标的 agent（不看按钮指针）', () => {
  const INPUT = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-input.js'), 'utf8');
  assert.match(INPUT, /_agGate = \(_qid && parent\.__qqq_agentPool\) \? \(parent\.__qqq_agentPool\[_qid\] \|\| null\) : null;/, '闸门 fatal 判定未按发送目标解析 agent');
});

test('sync: 跨面板 floor-completed 重连走真身解析', () => {
  assert.match(SYNC, /var _fcHome = \(typeof _panelAgent === 'function'\) \? _panelAgent\(\) : null;/, 'floor-completed 未走真身解析');
  assert.ok(!/_activeAgent\._activeAiDiv = /.test(SYNC), 'floor-completed 仍写可变指针');
});

test('service-worker: 版本推进到 v1271（阈值式——后续版本继续推进不再误报）', () => {
  const m = SW.match(/const CACHE_NAME = 'qqq-shell-v(\d+)';/);
  assert.ok(m, 'SW 版本号缺失/形态变更');
  assert.ok(Number(m[1]) >= 1271, 'SW 未推进（旧缓存将吞掉修复）：当前 v' + m[1]);
});
