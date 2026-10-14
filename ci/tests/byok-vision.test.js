// ci/tests/byok-vision.test.js — BYOK 视觉通道回归守卫（2026-10-14，上游 PR #1 合入跟进）。
// ① 信号真理源：_stopCtrl 单处创建且位于贴图预分析之前（防「上一楼层残留信号污染预分析」回潮——
//    残留 aborted 信号会让预分析静默返回 null、零网络调用）；agent-vision / tools-exec-effect
//    两处 BYOK 分叉恒取 _stopCtrl（abortController 仅兜底）。
// ② 视觉请求口径：max_tokens 仅显式配置才发送（与对话通道同一条铁律）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const LOOP = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'agent-loop.js'), 'utf8');
const VISION = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'agent-vision.js'), 'utf8');
const TOOLS = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'tools-exec-effect.js'), 'utf8');
const BYOK = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'byok.js'), 'utf8');

test('agent-loop: _stopCtrl 单处创建且位于贴图预分析之前', () => {
  const creates = LOOP.match(/_stopCtrl = new AbortController\(\)/g) || [];
  assert.strictEqual(creates.length, 1, '_stopCtrl 必须只有一处创建（防多源分叉）');
  const ci = LOOP.indexOf('self._stopCtrl = new AbortController();');
  const ai = LOOP.indexOf('await self._analyzeImages(');
  assert.ok(ci > -1 && ai > -1, '缺少创建点或预分析调用点');
  assert.ok(ci < ai, '创建点必须位于 _analyzeImages 之前（预分析需拿到本楼层干净信号）');
});

test('agent-vision: _callVision 信号优先本楼层 _stopCtrl', () => {
  assert.match(VISION, /_floorSig = \(self\._stopCtrl && self\._stopCtrl\.signal\)/, '须优先取本楼层真理源 _stopCtrl');
  assert.match(VISION, /self\.abortController && self\.abortController\.signal/, 'abortController 应仅作兜底（不得删除）');
});

test('tools-exec-effect: analyze_image BYOK 分叉信号同源 + 视觉 max_tokens 显式才发', () => {
  const i = TOOLS.indexOf('qqqByok.visionActive && qqqByok.visionActive()');
  assert.ok(i > -1, '缺少 analyze_image 的 BYOK 视觉分叉');
  const seg = TOOLS.slice(i, i + 1400);
  assert.ok(seg.indexOf('qqqByok.visionChat({') > -1, '缺失 visionChat 调用');
  assert.ok(seg.indexOf('_stopCtrl') > -1, 'BYOK 分叉须取 _stopCtrl（与贴图预分析同源）');
  assert.match(BYOK, /if \(mt > 0\) body\.max_tokens = mt;/, '视觉请求 max_tokens 仅显式配置才发送');
});
