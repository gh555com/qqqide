// ci/tests/export-target.test.js — 导出目标裁决唯一出口 + 工作台合页指示器分组映射。
//   两源文件均为浏览器全局守卫 IIFE（无模块依赖）→ vm 沙箱注入 window/document 桩直接加载。
//   契约（详铁律 §4.12）：合页指示器 / 悬停淡紫目标框 / 导出本体三处同源 = window.qqqExport.resolveTarget()。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_EXPORT = fs.readFileSync(path.join(ROOT, 'server-app', 'core', 'export-machine.js'), 'utf8');
const SRC_TOOLS = fs.readFileSync(path.join(ROOT, 'server-app', 'core', 'qqq-tools.js'), 'utf8');

function mkEd(filePath, opts) {
  opts = opts || {};
  return {
    _qqqFilePath: filePath || '',
    getModel() { return { isDisposed: () => !!opts.disposedModel }; },
    hasTextFocus() { return !!opts.focus; },
  };
}

// 加载 export-machine.js（window/document 桩）；返回 ctx（window.qqqExport 就绪）
function loadExportMachine(eds, mounts, activeGetter) {
  const document = { querySelectorAll: (sel) => (sel === '[data-editor-mount]' ? mounts : []) };
  const ctx = { console, document };
  ctx.window = { monaco: { editor: { getEditors: () => eds } } };
  if (activeGetter) { ctx.window.qqqEditor = { getEditorInstance: activeGetter }; }
  vm.createContext(ctx);
  vm.runInContext(SRC_EXPORT, ctx, { filename: 'export-machine.js' });
  return ctx;
}

// 加载 qqq-tools.js（同 ctx；qqqExport/qqqTabs 桩）
function loadTools(qqqExport, groups) {
  const ctx = { console, document: { querySelectorAll: () => [] } };
  ctx.window = { qqqExport, qqqTabs: { getGroups: () => groups } };
  vm.createContext(ctx);
  vm.runInContext(SRC_TOOLS, ctx, { filename: 'qqq-tools.js' });
  return ctx.window.qqqToolsMenu;
}

test('resolveTarget: 真焦点优先（存在焦点编辑器 → 用它，不管活跃机器）', () => {
  const edFocus = mkEd('E:/x/q', { focus: true });
  const edOther = mkEd('E:/y/all.txt');
  const m1 = { _qqqEd: edFocus };
  const exp = loadExportMachine([edFocus, edOther], [m1], () => edOther).window.qqqExport;
  const t = exp.resolveTarget();
  assert.strictEqual(t.ed, edFocus);
  assert.strictEqual(t.filePath, 'E:/x/q');
  assert.strictEqual(t.mountEl, m1);
});

test('resolveTarget: 失焦后回落活跃编辑器机器（工作台按钮触发实景：焦点恒空）', () => {
  const edA = mkEd('E:/x/q');            // 无焦点
  const edB = mkEd('E:/y/all.txt');      // 无焦点
  const m2 = { _qqqEd: edB };
  const exp = loadExportMachine([edA, edB], [m2], () => edB).window.qqqExport;
  const t = exp.resolveTarget();
  assert.strictEqual(t.ed, edB);
  assert.strictEqual(t.filePath, 'E:/y/all.txt');
  assert.strictEqual(t.mountEl, m2);
});

test('resolveTarget: 活跃编辑器已销毁（model disposed）→ 兜底首个带文件的存活编辑器', () => {
  const edDead = mkEd('E:/dead', { disposedModel: true });
  const edAlive = mkEd('E:/alive.js');
  const exp = loadExportMachine([edDead, edAlive], [], () => edDead).window.qqqExport;
  const t = exp.resolveTarget();
  assert.strictEqual(t.ed, edAlive);
  assert.strictEqual(t.filePath, 'E:/alive.js');
});

test('resolveTarget: 无编辑器 → { ed:null, filePath:"", mountEl:null }', () => {
  const exp = loadExportMachine([], [], null).window.qqqExport;
  const t = exp.resolveTarget();
  assert.strictEqual(t.ed, null);
  assert.strictEqual(t.filePath, '');
  assert.strictEqual(t.mountEl, null);
});

test('resolveTarget: 编辑器无对应挂载点（未挂载）→ mountEl 为 null 但目标仍成立', () => {
  const ed = mkEd('E:/x/q', { focus: true });
  const exp = loadExportMachine([ed], [], null).window.qqqExport;
  const t = exp.resolveTarget();
  assert.strictEqual(t.ed, ed);
  assert.strictEqual(t.mountEl, null);
});

// ── 合页指示器分组映射（qqq-tools.expTarget：诊断/单测入口）──

function mkGroups() {
  const elA = { tag: 'groupA' };
  const elB = { tag: 'groupB' };
  const groups = [
    { type: 'gaea', el: { tag: 'gaea' }, tabs: [], activeTabId: 1 },
    { type: 'file', el: elA, tabs: [{ id: 11, filePath: 'E:/x/q' }], activeTabId: 11 },
    { type: 'file', el: elB, tabs: [{ id: 22, filePath: 'E:/y/all.txt' }], activeTabId: 22 },
  ];
  return { groups, elA, elB };
}

test('合页映射: mountEl 归属优先（目标 mount 属第一文件组 → fillIdx 0）', () => {
  const { groups, elA } = mkGroups();
  const mountEl = { closest: (sel) => (sel === '.qqq-tab-group' ? elA : null) };
  const tools = loadTools({ resolveTarget: () => ({ ed: {}, filePath: 'E:/x/q', mountEl }) }, groups);
  const st = tools.expTarget();
  assert.strictEqual(st.groups, 2);       // gaea 组被排除（合页只画文件分组）
  assert.strictEqual(st.fillIdx, 0);
  assert.strictEqual(st.hasMount, true);
});

test('合页映射: mountEl 缺失 → 按路径回落（命中第二组活动标签 → fillIdx 1）', () => {
  const { groups } = mkGroups();
  const tools = loadTools({ resolveTarget: () => ({ ed: {}, filePath: 'E:\\y\\all.txt', mountEl: null }) }, groups);
  const st = tools.expTarget();
  assert.strictEqual(st.fillIdx, 1);      // 反斜杠写法归一后仍命中
});

test('合页映射: 目标在非活动标签 → 命中所属分组（活动优先不误配）', () => {
  const elA = { tag: 'groupA' };
  const groups = [
    { type: 'file', el: elA, tabs: [{ id: 11, filePath: 'E:/x/q' }, { id: 12, filePath: 'E:/x/r' }], activeTabId: 12 },
  ];
  const mountEl = { closest: (sel) => (sel === '.qqq-tab-group' ? elA : null) };
  const tools = loadTools({ resolveTarget: () => ({ ed: {}, filePath: 'E:/x/q', mountEl }) }, groups);
  assert.strictEqual(tools.expTarget().fillIdx, 0);
});

test('合页映射: 无目标（全未挂载/无文档）→ fillIdx -1 且不崩', () => {
  const { groups } = mkGroups();
  const tools = loadTools({ resolveTarget: () => ({ ed: null, filePath: '', mountEl: null }) }, groups);
  const st = tools.expTarget();
  assert.strictEqual(st.fillIdx, -1);
  assert.strictEqual(st.filePath, '');
});

test('合页映射: qqqExport 缺席（旧窗口/模块未载）→ 静默回落 -1', () => {
  const { groups } = mkGroups();
  const tools = loadTools(undefined, groups);
  assert.strictEqual(tools.expTarget().fillIdx, -1);
});
