// ci/tests/guide-ack-session.test.js — 引导确认回合的会话落盘铁律（2026-10-29 根治回归守卫）。
// 背景：连发两次引导必中断——确认回复被当普通 assistant 消息写回会话，但它带不回思维链；
//   下一次携带 tools 的请求里，本轮在飞链上缺 reasoning 的 assistant 消息会被上游判 400
//   「reasoning_content must be passed back」。旧实现还把确认指令 pop 掉 → 用户引导原话从上下文消失。
// 三条钉子：① 确认指令只在请求副本（禁写 conversation）；② 引导原文以 [GUIDE] 用户消息永久入会话；
//   ③ 确认回复只有带 reasoning（或思维关档）才入会话；④ auto-repair 预算按次数计而非一击即死。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const LOOP = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'agent-loop.js'), 'utf8');
const GW = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'agent-gateway.js'), 'utf8');
const EXEC = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'agent-exec.js'), 'utf8');

function ackBlock() {
  const s = LOOP.indexOf("self._log('⚡ guide ack round: '");
  const e = LOOP.indexOf('// 确认回合结束 → 恢复被延迟的最终回复（若有）', s);
  assert.ok(s > -1 && e > s, '找不到引导确认回合代码段');
  return LOOP.slice(s, e);
}

test('引导确认回合：确认指令只活在请求副本（禁写会话）', () => {
  const seg = ackBlock();
  assert.ok(seg.indexOf('self.conversation.concat(') > -1, '确认回合必须用 conversation.concat 临时视图');
  assert.ok(seg.indexOf('content: _ackPrompt') !== -1, '缺失确认指令装载');
  // 禁把 _ackPrompt 直接 push 进 conversation
  assert.ok(!/conversation\.push\(\{[^}]*_ackPrompt/.test(seg), '确认指令禁写入 conversation（否则硬指令永久污染上下文）');
});

test('引导确认回合：引导原文以 [GUIDE] 用户消息永久入会话（_injected → 恢复渲染引导块）', () => {
  const seg = ackBlock();
  const m = seg.match(/self\.conversation\.push\(\{ role: 'user', content: '\[GUIDE\] ' \+ _guideText, _injected: true/);
  assert.ok(m, "引导原文必须以 { role:'user', content:'[GUIDE] '+_guideText, _injected:true } 入会话");
  assert.ok(seg.indexOf('self.conversation.pop()') === -1, '确认回合禁再 pop 会话（原实现 pop 掉原文 = 引导语义丢失）');
});

test('引导确认回合：确认回复仅在带 reasoning（或思维关档）时入会话', () => {
  const seg = ackBlock();
  assert.ok(seg.indexOf('_ackResp.reasoning_content || !_thinkOn') > -1, '确认回复入会话必须以 reasoning 或关档为前提');
  assert.ok(seg.indexOf("var _thinkOn = !!(tier && tier.thinking && tier.thinking.type !== 'disabled');") > -1, '缺失思维开关判定');
  // 禁无条件写入（旧回潮形态：push 里直接挂 reasoning || undefined 就完事）
  assert.ok(!/conversation\.push\(\{ role: 'assistant', content: _cleanAck, _guideAck: true, _guideText: _guideText/.test(seg), '禁回潮到无条件写入确认回复');
});

test('auto-repair：预算按次数计（非一击即死）+ 推理真因先做非破坏修复', () => {
  assert.ok(GW.indexOf('self._lastUpstreamErrorText = String(msg ||') > -1, '网关必须留上游 400 原文（auto-repair 分真因依据）');
  assert.ok(EXEC.indexOf('_repairReasoninglessAssistants = function') > -1, '缺失 _repairReasoninglessAssistants');
  assert.ok(LOOP.indexOf('(opts._repairCount || 0) < 3') > -1, 'auto-repair 预算必须为计数上限 3');
  assert.ok(!/opts\._repairAttempted\s*=/.test(LOOP), '禁回潮到一击即死布尔 _repairAttempted（旧赋值形态）');
});
