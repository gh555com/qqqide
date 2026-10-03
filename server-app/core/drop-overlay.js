// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// drop-overlay.js — 主窗口拖放接收（2026-08-24；2026-10-03 网页内容接管）
//
// 覆盖 X 区编辑器（中/右分组 Monaco）:
//   · 悬停编辑器 → 橙色虚线框贴合编辑器边界（= 接收范围）
//   · 系统文件（Files）→ paste-router.handleDrop（copyFile 进 _qqqvault/ + 📎 锚点）
//   · ★ 网页内容（浏览器选区/图片/链接：无 Files 但有 text/html / text/uri-list）
//     → 同一条 rich 管线（html-paste 转换 + 媒体下载 + 📎 相框）——paste-router._handleWebDrop
//
// 全局守卫:
//   · 拖拽在主窗口任意位置 preventDefault（防浏览器默认导航——尤其链接/URL 拖入）
//   · 悬停编辑器时 stopPropagation——Monaco 原生落点指示（dnd-target 点线）整体让位：
//     我们全接管（防双指示 + 防「拦截 drop 后 Monaco 指示残留」）
//   · 内部拖拽（本窗口 DOM 选区：设置面板里选中的文字等）→ 完全不接管（保 Monaco 原生语义）
//   · ★ 光标纪律（铁律 §4.3）：全程不写 cursor、不写 dataTransfer.dropEffect
//
// AI 面板/Roam/收件箱各自 iframe 内自管（panel-drop.js / q2-roam.js / dm-ui.html，仅系统文件）。
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
  var _kind = null;          // 'files' | 'web' —— 本次拖入会话分类（进入窗口首击定格）
  var _currentHost = null;
  var _internalDragAt = 0;   // 本窗口 DOM 选区内部拖拽（dragstart 时刻置位）

  // 内部拖拽标记：主窗口 document 内发起的 dragstart（设置面板/状态区等 DOM 选区拖拽）
  // → 网页内容接管必须让路（例：把面板里选中的文字拖进编辑器 = 走 Monaco 原生落点插入）。
  // dragend/失焦即清；60s TTL 兜底（正常拖拽必有 dragend）。
  document.addEventListener('dragstart', function () { _internalDragAt = Date.now(); }, true);
  document.addEventListener('dragend', function () { _internalDragAt = 0; }, true);

  function _isInternalDrag() {
    return _internalDragAt > 0 && (Date.now() - _internalDragAt) < 60000;
  }

  // 拖拽分类: 'files'（系统文件）/ 'web'（网页内容：html 或 uri-list）/ null（不接管）
  function _dragKind(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types) return null;
    var t = dt.types;
    var has = function (k) { return Array.prototype.indexOf.call(t, k) !== -1; };
    if (has('Files')) return 'files';
    if (_isInternalDrag()) return null;
    if (has('text/html') || has('text/uri-list')) return 'web';
    return null;
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
    var k = _dragKind(e);
    if (!k) return;
    e.preventDefault();
    _depth++;
    _kind = k;
    var h = _editorHost(e);
    if (h) {
      e.stopPropagation();   // Monaco 落点指示让位（我们全接管）
      _currentHost = h;
      _showFor(h);
    }
  }, true);

  document.addEventListener('dragover', function (e) {
    var k = _dragKind(e) || _kind;
    if (!k) return;
    e.preventDefault();      // 全主窗口允许 drop + 防默认导航（链接/URL 拖入不进导航）
    var h = _editorHost(e);
    if (h) {
      e.stopPropagation();
      if (h !== _currentHost) { _currentHost = h; _showFor(h); }
    }
  }, true);

  document.addEventListener('dragleave', function (e) {
    if (!_kind) return;
    if (_editorHost(e)) e.stopPropagation();   // 与 enter/over 对称：Monaco 全程无感
    _depth--;
    if (_depth <= 0) { _depth = 0; _kind = null; _hideOv(); }
  }, true);

  // 失焦兜底（ALT+TAB 中途取消拖拽可能无 dragleave）
  window.addEventListener('blur', function () { _depth = 0; _kind = null; _hideOv(); _internalDragAt = 0; });

  document.addEventListener('drop', function (e) {
    var k = _kind || _dragKind(e);   // 极少数无 dragenter 的直达 drop 兜底
    _depth = 0;
    _kind = null;
    _hideOv();
    if (!k) return;                  // 内部拖拽/纯文本 → Monaco 原生
    e.preventDefault();
    e.stopPropagation();
    var h = _editorHost(e);
    if (h && window.qqqPasteRouter && window.qqqPasteRouter.handleDrop) {
      try {
        var pr = window.qqqPasteRouter.handleDrop(e);
        if (pr && pr.catch) pr.catch(function (err) { console.warn('[drop-overlay] handleDrop failed:', err); });
      } catch (err) { console.warn('[drop-overlay] handleDrop failed:', err); }
    }
  }, true);
})();
