// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// panel-expert.js — 文档地基「模式检测」（只读，不做任何推销）
//
// 这一域只有一个执行内核：server-app/eflow/eflow-core.js（EflowCore.run）。
// 本文件只回答一个问题：这个项目现在是什么状态？
//   none     — 白纸（没接、也没有自己的 rule）
//   standard — 已接 qd 背包（_qqq/alphal/expert/index.md 存在）
//   custom   — 用户自己的知识库（project.txt 里有自己的 rule"..."）
//
// ★ 入口（用户主动，全部显式）：
//   ① AI 面板底排「文档地基」按钮 → panel-eflow-ui.js（数字 + 四个动作）
//   ② ~New quest~ 卡片（发现层，见 panel-tasks.js）
//   ③ 对话里 AI 调 eflow 工具（tools-exec-eflow.js）
// ★ 没有第四条：不再有「首楼 100% / 之后 10% 概率往对话里塞一条规矩」的随机推销
//   （不可预期、不可复现、白耗一层回复）；要用只有用户自己点。
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

  function _normRoot(root) {
    return (root || '').replace(/\\/g, '/').replace(/\/$/, '');
  }
  function _standardDir(root) {
    return _normRoot(root) + '/_qqq/alphal/expert/';
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

  async function _checkStandardExists(projectRoot) {
    var bridge = _bridge();
    if (!bridge || !bridge.fs) return false;
    try {
      var stat = await bridge.fs.stat(_standardDir(projectRoot) + 'index.md');
      return !!(stat && !stat.isDir);
    } catch (e) {
      return false;
    }
  }

  async function _checkCustomDocs(projectRoot) {
    var bridge = _bridge();
    if (!bridge || !bridge.fs) return false;
    try {
      var text = await bridge.fs.read(_normRoot(projectRoot) + '/_qqq/alphal/rule/project.txt');
      if (text && text.trim()) return /rule"[^"]+"/.test(text);
    } catch (e) { /* silent */ }
    return false;
  }

  // ---- 状态检测（只读；绝不落盘骨架、绝不改 project.txt）----
  async function autoDetect(projectRoot) {
    if (!projectRoot) return MODE_NONE;
    var mode = _storeGet(KEY_MODE, MODE_NONE);
    if (await _checkStandardExists(projectRoot)) {
      if (mode !== MODE_STANDARD) _storeSetNow(KEY_MODE, MODE_STANDARD);
      _storeSetNow(KEY_LAST, Date.now());
      return MODE_STANDARD;
    }
    var hasCustom = await _checkCustomDocs(projectRoot);
    var next = hasCustom ? MODE_CUSTOM : MODE_NONE;
    if (mode !== next) _storeSetNow(KEY_MODE, next);
    _storeSetNow(KEY_LAST, Date.now());
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
    MODE_NONE: MODE_NONE,
    MODE_STANDARD: MODE_STANDARD,
    MODE_CUSTOM: MODE_CUSTOM,
    KEY_MODE: KEY_MODE
  };
})();

window.ExpertFlow = ExpertFlow;
