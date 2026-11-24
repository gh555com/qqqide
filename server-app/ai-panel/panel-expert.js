// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// panel-expert.js — 文档地基「模式检测」＋「全局接管」
//
// 执行内核只有一个：server-app/eflow/eflow-core.js（EflowCore.run）。
// 本文件只做两件事：
//   ① 检测：这个项目现在是什么状态？（只读）
//        none     — 白纸（没接、也没有自己的 rule）
//        standard — 已接背包（_qqq/alphal/expert/index.md 存在）
//        custom   — 用户自己的知识库（project.txt 里有自己的 rule"..."）
//   ② 接管：全局开关为「开」时，白纸项目自动接入（幂等，不打扰）
//        开关真值 = {用户级目录}/alphal/eflow.json（win/dev = {appRoot}/Data，mac = bootinfo.userData）
//        —— 绝不往用户的 global.txt 写产品文案：规则文件归用户，产品状态归产品。
//
// ★ 入口（全部用户主动）：
//   ① ~New quest~ 卡片「AI 读懂我的项目」→ 全局接管（发现层，见 panel-tasks.js）
//   ② 对话里 AI 调 eflow 工具（tools-exec-eflow.js）——用户明确说要接入时才是项目级
// ★ 没有第三条：不再有「首楼 100% / 之后 10% 概率往对话里塞一条规矩」的随机推销。
// ★ 已有自己规则的项目，全局接管也一个字不动：只把每轮注入字数报出来，由人拍板。
//
// State keys in onlyStore:
//   qqq.expert.mode         — 'none' | 'standard' | 'custom'
//   qqq.expert.lastDetected — 最近一次检测时间戳（诊断用）
// ============================================================================

var ExpertFlow = (function () {
  'use strict';

  var KEY_MODE = 'qqq.expert.mode';
  var KEY_LAST = 'qqq.expert.lastDetected';

  var MODE_NONE = 'none';
  var MODE_STANDARD = 'standard';
  var MODE_CUSTOM = 'custom';

  var ADOPT_DELAY = 1500;      // 接管推迟到首屏之后（禁压在启动关键路径上）

  function _normRoot(root) {
    return (root || '').replace(/\\/g, '/').replace(/\/$/, '');
  }

  function _storeGet(key, fallback) {
    try {
      if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) return onlyStore.get(key, fallback);
    } catch (e) { /* silent */ }
    return fallback;
  }
  function _storeSetNow(key, value) {
    try {
      if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) onlyStore.setNow(key, value);
    } catch (e) { /* silent */ }
  }

  function _bridge() {
    try {
      if (typeof window !== 'undefined' && window.parent && window.parent.qqqideBridge) return window.parent.qqqideBridge;
    } catch (e) { /* silent */ }
    try { if (typeof window !== 'undefined' && window.qqqideBridge) return window.qqqideBridge; } catch (e) { /* silent */ }
    return null;
  }

  // 用户级目录（全局开关的家）
  async function _dataRoot(bridge) {
    try {
      if (bridge && bridge.boot && bridge.boot.getInfo) {
        var bi = await bridge.boot.getInfo();
        if (bi && bi.userData) return String(bi.userData).replace(/\\/g, '/').replace(/\/+$/, '');
      }
    } catch (e) { /* silent */ }
    try {
      var r = await bridge.app.root();
      if (r) return String(r).replace(/\\/g, '/').replace(/\/+$/, '') + '/Data';
    } catch (e) { /* silent */ }
    return '';
  }

  // 全局接管是否开着（开关文件读失败 = 关：默认什么都不做）
  async function globalOn() {
    var bridge = _bridge();
    if (!bridge || !bridge.fs || !bridge.fs.read) return false;
    var dr = await _dataRoot(bridge);
    if (!dr) return false;
    try {
      var raw = await bridge.fs.read(dr + '/alphal/eflow.json');
      if (!raw) return false;
      var o = JSON.parse(raw);
      return !!(o && o.global === true);
    } catch (e) { return false; }
  }

  // 项目归类只问内核（projectKind）：面板不再自带第二份「有没有自己的 rule」正则——
  //   那份副本曾经少了空格容忍（`rule "…"` 被判成白纸 → 调 upgrade → 被内核拒写 → 白弹失败提示）。
  async function _kind(projectRoot) {
    var bridge = _bridge();
    var core = (typeof EflowCore !== 'undefined') ? EflowCore : null;
    if (!bridge || !bridge.fs || !core || !core.projectKind || !core.bridgeIO) return '';
    var io = core.bridgeIO(bridge);
    if (!io) return '';
    try { return String((await core.projectKind(io, _normRoot(projectRoot))) || ''); } catch (e) { return ''; }
  }

  // ---- 全局接管：白纸项目 → 自动接入（幂等；一次会话只试一次）----
  var _adoptTried = {};

  function _toast(msg) {
    try { if (typeof _qoast === 'function') return _qoast(msg, { type: 'error', duration: 6000 }); } catch (e) { /* silent */ }
    try { console.warn('[eflow] ' + msg); } catch (e) { /* silent */ }
  }
  // i18n 助手（面板内唯一入口；缺 i18n 时回退中文原文）
  function _i18n(key, fb) {
    try { if (typeof window !== 'undefined' && typeof window._qq === 'function') return window._qq(key, fb); } catch (e) { /* silent */ }
    return fb;
  }

  async function _adopt(projectRoot) {
    var root = _normRoot(projectRoot);
    if (!root) return;
    var bridge = _bridge();
    if (!bridge || !bridge.fs) return;
    if (!(await globalOn())) return;
    var core = (typeof EflowCore !== 'undefined' && EflowCore && EflowCore.run) ? EflowCore : null;
    var io = (core && typeof core.bridgeIO === 'function') ? core.bridgeIO(bridge) : null;
    if (!core || !io) return;
    try {
      var r = await core.run('upgrade', io, root, { keepRules: true });
      if (r && r.ok) _storeSetNow(KEY_MODE, MODE_STANDARD);
      else if (r && /已经有自己的知识库|已经是 E-Flow/.test(String(r.text || ''))) {
        // 良性拒结：项目在检测后被用户/别人接管了，或它早就是 EF2 —— 不是失败，不出声
      } else {
        _toast(_i18n('ai.eflow.adoptFail', '文档地基自动接入没成功：') + ((r && r.text) || _i18n('settings.eflow.noOutput', '（没有输出）')));
      }
    } catch (e) {
      _toast(_i18n('ai.eflow.adoptErr', '文档地基自动接入失败：') + ((e && e.message) || e));
    }
  }

  function _scheduleAdopt(projectRoot) {
    var key = _normRoot(projectRoot);
    if (!key || _adoptTried[key]) return;
    _adoptTried[key] = true;
    setTimeout(function () { _adopt(key); }, ADOPT_DELAY);
  }

  // ---- 状态检测（只读；绝不落盘骨架、绝不改 project.txt）----
  async function autoDetect(projectRoot) {
    if (!projectRoot) return MODE_NONE;
    var kind = await _kind(projectRoot);
    // 内核/桥不可用：保持原判，不落盘、不改状态（禁把「读不到」当成「白纸」然后去接管）
    if (!kind) return _storeGet(KEY_MODE, MODE_NONE);
    var next = (kind === 'ef2' || kind === 'l0') ? MODE_STANDARD : (kind === 'custom' ? MODE_CUSTOM : MODE_NONE);
    var mode = _storeGet(KEY_MODE, MODE_NONE);
    if (mode !== next) _storeSetNow(KEY_MODE, next);
    _storeSetNow(KEY_LAST, Date.now());
    // 全局接管只碰白纸：有自己的规则 = 用户自己管，一个字都不动
    if (next === MODE_NONE) _scheduleAdopt(projectRoot);
    return next;
  }

  function getMode() { return _storeGet(KEY_MODE, MODE_NONE); }
  function setMode(mode) {
    if (mode === MODE_STANDARD || mode === MODE_CUSTOM || mode === MODE_NONE) _storeSetNow(KEY_MODE, mode);
  }

  return {
    autoDetect: autoDetect,
    getMode: getMode,
    setMode: setMode,
    globalOn: globalOn,
    MODE_NONE: MODE_NONE,
    MODE_STANDARD: MODE_STANDARD,
    MODE_CUSTOM: MODE_CUSTOM,
    KEY_MODE: KEY_MODE
  };
})();

window.ExpertFlow = ExpertFlow;
