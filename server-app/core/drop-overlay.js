// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// drop-overlay.js — 主窗口文件拖放接收（2026-08-24）
//
// 覆盖 X 区编辑器（中/右分组 Monaco）: 文件拖入 = 粘贴一切（WYSIWYG）。
//   · 悬停编辑器 → 橙色虚线框贴合编辑器边界（= 接收范围）
//   · drop → 委托 paste-router.handleDrop（copyFile 进 _qqqvault/ + 📎 锚点）
//
// 全局守卫: 文件拖拽在主窗口任意位置 preventDefault（防浏览器默认导航），
//   但仅在编辑器上显示接收框。AI 面板/Roam 各自 iframe 内自管（panel-drop.js / q2-roam.js）。
//
// 加载点: index.html（paste-router.js 之后）
// ============================================================================

(function () {
  'use strict';
  if (parent !== window) return; // 仅主窗口（面板 iframe 各自处理）

  // ── 橙色接收框（贴合目标编辑器边界，pointer-events 穿透）──
  var _ov = document.createElement('div');
  _ov.id = 'qqq-drop-overlay';
  _ov.style.cssText =
    'position:fixed;display:none;pointer-events:none;z-index:999999;' +
    'border:3px dashed #e07020;border-radius:4px;' +
    'box-shadow:inset 0 0 0 2px rgba(224,112,32,0.12), 0 0 0 2px rgba(224,112,32,0.18);';
  document.body.appendChild(_ov);

  var _depth = 0;
  var _currentHost = null;

  function _isFileDrag(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    return Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
  }

  // 事件目标 → 所属编辑器宿主（[data-editor-mount] 为 pane 挂载点，.monaco-editor 兜底）
  function _editorHost(e) {
    var t = e.target;
    if (!t || !t.closest) return null;
    var h = t.closest('[data-editor-mount]');
    if (h) return h;
    return t.closest('.monaco-editor') || null;
  }

  function _showFor(host) {
    var r = host.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { _ov.style.display = 'none'; return; }
    _ov.style.left = r.left + 'px';
    _ov.style.top = r.top + 'px';
    _ov.style.width = r.width + 'px';
    _ov.style.height = r.height + 'px';
    _ov.style.display = 'block';
  }

  function _hideOv() {
    _ov.style.display = 'none';
    _currentHost = null;
  }

  document.addEventListener('dragenter', function (e) {
    if (!_isFileDrag(e)) return;
    e.preventDefault();
    _depth++;
    var h = _editorHost(e);
    if (h) { _currentHost = h; _showFor(h); }
  }, true);

  document.addEventListener('dragover', function (e) {
    if (!_isFileDrag(e)) return;
    e.preventDefault(); // 全主窗口允许 drop + 防浏览器默认导航
    var h = _editorHost(e);
    if (h && h !== _currentHost) { _currentHost = h; _showFor(h); }
  }, true);

  document.addEventListener('dragleave', function (e) {
    if (!_isFileDrag(e)) return;
    _depth--;
    if (_depth <= 0) { _depth = 0; _hideOv(); }
  }, true);

  // 失焦兜底（ALT+TAB 中途取消拖拽可能无 dragleave）
  window.addEventListener('blur', function () { _depth = 0; _hideOv(); });

  document.addEventListener('drop', function (e) {
    _depth = 0;
    _hideOv();
    if (!_isFileDrag(e)) return;
    e.preventDefault();
    var h = _editorHost(e);
    if (h && window.qqqPasteRouter && window.qqqPasteRouter.handleDrop) {
      window.qqqPasteRouter.handleDrop(e);
    }
  }, true);
})();
