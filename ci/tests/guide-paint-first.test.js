// ci/tests/guide-paint-first.test.js — 「引导消息带图」上屏时序回归守卫。
// 事故机制：$guideBtn.onclick 旧实现先把编辑条清空，再 await _analyzeImages（单张图「提交 + 流轮询」
//   5~30s，轮询上限 120s × 2 次），块与状态行要等识别完才创建 —— 这段时间楼层里零痕迹，
//   用户无法分辨「引导已发出」与「界面卡死」。
// 守卫：
//   ① 块 + 状态行必须先于视觉识别落楼层（任意 await 之前）；
//   ② _guideMode（引导窗口丢弃流式残料）不得在识别前置位 —— 识别期间 AI 必须继续正常渲染；
//   ③ 楼层在识别期间已结束 → 如实收口（marker 标「未送达」+ 内容回填编辑条 + 绝不调 injectGuide）；
//   ④ 新 i18n 键必须在 zh.json 存在（键生命周期 = 引用生命周期）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(R, 'server-app', 'ai-panel', 'panel-quest-ui.js'), 'utf8');
const ZH = JSON.parse(fs.readFileSync(path.join(R, 'server-app', 'locales', 'zh.json'), 'utf8'));

const START = UI.indexOf('$guideBtn.onclick = async function () {');
const END = UI.indexOf('\n};\n', START);

test('guide: 处理函数可定位（形态未变）', () => {
  assert.ok(START > 0 && END > START, '$guideBtn.onclick 缺失或被改写');
});

const BODY = START > 0 && END > START ? UI.slice(START, END) : '';

test('guide: 块 + 状态行先于视觉识别上屏（空窗根治）', () => {
  const paint = BODY.indexOf('_aiDiv._contentWrap.appendChild(_gBlock);');
  const marker = BODY.indexOf('_aiDiv._contentWrap.appendChild(_gMarker);');
  const vision = BODY.indexOf('await _gAg._analyzeImages(');
  assert.ok(paint > 0, '引导块未建立');
  assert.ok(marker > 0, '引导状态行未建立');
  assert.ok(vision > 0, '视觉识别调用点缺失');
  assert.ok(paint < vision, '引导块仍在识别之后才上屏（空窗回潮）');
  assert.ok(marker < vision, '状态行仍在识别之后才上屏');
  // 上屏之后必须滚动到位（否则块在视口外 = 等同没上屏）
  assert.ok(BODY.indexOf('scrollToBottom(true);') > 0 && BODY.indexOf('scrollToBottom(true);') < vision,
    '引导块上屏后未滚动到底');
});

test('guide: 识别期间不置 _guideMode（AI 继续正常渲染）', () => {
  const vision = BODY.indexOf('await _gAg._analyzeImages(');
  const mode = BODY.indexOf('_aiDiv._guideMode = true;');
  assert.ok(mode > 0, '引导模式置位点缺失');
  assert.ok(mode > vision, '_guideMode 在识别前置位 → 识别期间流式渲染被吞（假死回潮）');
});

test('guide: 识别期间状态行如实标注（识别中 → 已分析/未完成）', () => {
  assert.match(BODY, /_qq\('ai\.guideImagesAnalyzing',/, '缺少「识别中」状态行');
  assert.match(BODY, /_qq\('ai\.guideVisionBusy',/, '缺少「识别图片中」状态行');
  assert.match(BODY, /_gNote\.textContent = _gNoteTextOf\(\);/, '识别结束未定稿状态行');
  assert.match(BODY, /_qq\('ai\.guideImagesAnalyzed',[\s\S]{0,160}_qq\('ai\.guideImagesPending',/,
    '状态行未按识别结果二分（已分析 / 未完成）');
});

test('guide: 楼层已结束 → 不注入死楼层 + 内容回填编辑条', () => {
  const live = BODY.indexOf("var _gLive = !!(_gAg && _gAg._stopState === 'sending' && !_gAg._floorCompletedCleanly");
  const inject = BODY.indexOf('_gAg.injectGuide(guideText);');
  const ended = BODY.indexOf('_qq(\'ai.guideFloorEnded\'');
  assert.ok(live > 0, '楼层存活判定缺失（会向已完结楼层注入引导）');
  assert.ok(ended > 0, '楼层已结束未如实标注');
  assert.ok(live < inject, '存活判定必须在注入之前');
  assert.ok(BODY.indexOf('return;', live) < inject, '已结束分支必须提前返回（禁落到注入）');
  assert.match(BODY, /_gAg\._currentFloorNum === _gFloorNum/, '缺楼层同一性校验（新楼会接走旧楼的引导）');
  assert.match(BODY, /if \(questActiveId === _gAg\._questId && !getInputText\(\)\.trim\(\)\) \{[\s\S]{0,400}\$input\.value = text;/,
    '已结束分支未回填文本（内容静默消失）/ 未校验面板任务同一性（会写进别的任务的编辑框）');
  assert.match(BODY, /saveQuestData\(_gAg, _gFloorNum\)/, '落盘未携本任务 agent（切走后退回面板指针）');
  assert.match(BODY, /pendingImages\.push\(\{ id: pendingImages\.length \+ 1/, '已结束分支未回填图片');
});

test('guide: 目标 agent 单一来源（禁读面板指针之外的散落真身）', () => {
  // 允许点：① _gAg 初始化那一句（含注释行）② 无其它 —— 散落的 _activeAgent 会让引导落错楼层
  const stray = BODY.split('\n').filter((l) => l.indexOf('_activeAgent') >= 0)
    .filter((l) => !/^\s*\/\//.test(l) && l.indexOf('var _gAg = (typeof _activeAgent') < 0);
  assert.deepStrictEqual(stray, [], '引导处理函数里出现散落的 _activeAgent：' + stray.join(' | '));
  assert.match(BODY, /var _gAg = \(typeof _activeAgent !== 'undefined' && _activeAgent\)/,
    '_gAg 初始化形态变更');
});

test('guide: 新 i18n 键在 zh.json 存在（唯一真理源）', () => {
  for (const k of ['guideImagesAnalyzing', 'guideVisionBusy', 'guideFloorEnded', 'guideImagesAnalyzed', 'guideImagesPending']) {
    assert.strictEqual(typeof ZH.ai[k], 'string', 'zh.json 缺键 ai.' + k);
  }
});
