// ci/tests/share-import.test.js — 一键继问落地语义守卫（2026-10-30 q449）。
// 守的是什么：
//   ① 快照导入必须【落成新任务】，不准灌进读者当前正在写的那个任务（跨会话串内容）。
//   ② 「找回原任务」在原理上不存在（原任务在分享者机器上，快照自足、无 quest 引用）——
//      源码里不准出现任何按 id 找回原 quest 的调用。
//   ③ 落点被守卫拦下（旧任务还在回复）必须如实告知，禁静默塞进当前输入框当成功。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PANEL = fs.readFileSync(path.join(ROOT, 'server-app', 'ai-panel', 'panel-share.js'), 'utf8');
const ZH = JSON.parse(fs.readFileSync(path.join(ROOT, 'server-app', 'locales', 'zh.json'), 'utf8'));

function sliceImport() {
    // importShare 函数体（从 function importShare 到 _landAsNewQuest 之后的 catch 收尾）
    const i = PANEL.indexOf('function importShare(');
    assert.ok(i > 0, 'panel-share.js 必须仍有 importShare');
    const j = PANEL.indexOf('// ─── 对外导出', i);
    assert.ok(j > i, 'importShare 之后必须有对外导出段（结构变更请同步本测试）');
    return PANEL.slice(i, j);
}

test('分享导入：落成新任务（createNewQuest），不是在当前输入框里就地拼接', () => {
    const body = sliceImport();
    assert.ok(body.indexOf('_landAsNewQuest(') > 0, 'importShare 必须经 _landAsNewQuest 落地');
    assert.ok(body.indexOf('$input.value =') < 0, 'importShare 内禁直写 $input（会污染读者当前任务）');
    const land = PANEL.slice(PANEL.indexOf('function _landAsNewQuest('));
    assert.ok(land.indexOf('createNewQuest(') > 0, '_landAsNewQuest 必须调 createNewQuest');
    assert.ok(land.indexOf('_isDraft(') > 0, '落点校验必须含草稿态判定（草稿=新任务）');
});

test('分享导入：守卫拦下时如实告知落点（禁把「没建成新任务」当成功）', () => {
    const land = PANEL.slice(PANEL.indexOf('function _landAsNewQuest('), PANEL.indexOf('function importShare('));
    assert.ok(land.indexOf("T('ai.share.importBusy'") > 0, '被拦下必须报 ai.share.importBusy');
    assert.ok(land.indexOf("'warning'") > 0, '该提示必须是 warning 级（用户要能看出落点不同）');
});

test('分享导入：快照自足 —— 禁按 id 找回原 quest，图片仍走 asset:N 展开', () => {
    const body = sliceImport();
    assert.ok(!/switchQuest\s*\(/.test(body), '禁在导入链里切回某个既有 quest（原任务不在本机）');
    assert.ok(/\]\(\s*asset:\(\\d\{1,3\}\)\s*\)/.test(body) || body.indexOf('asset:') > 0, '图片必须仍以 asset:N 展开为该分享的资产地址');
    assert.ok(body.indexOf("SHARE_WEB + encodeURIComponent(mid) + '.json'") > 0, '快照来源必须是本条分享的 .json（自足读取）');
});

test('分享导入：i18n 文案与新语义一致（新任务 / 如实告知）', () => {
    const share = ZH.ai && ZH.ai.share;
    assert.ok(share, 'zh.json 必须有 ai.share.*');
    assert.ok(String(share.imported || '').indexOf('新任务') >= 0, 'imported 文案必须写明「新任务」');
    assert.ok(String(share.importBusy || '').length > 0, '必须有 importBusy（兜底落点提示）');
    assert.ok(String(share.imported || '').indexOf('已导入分享快照') < 0, '旧文案「已导入分享快照」已废（语义不准）');
});
