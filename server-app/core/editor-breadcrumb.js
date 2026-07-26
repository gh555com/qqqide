// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// editor-breadcrumb.js — 极简面包屑（独立豆腐块）+ 悬浮按钮行
//
// 1. 顶端面包屑：独立 DOM 块，占真实高度，文字可选中/复制，不可编辑
//    自动换行撑高，下方一切（Monaco / Ctrl+F / 小地图）被其高度挤开
// 2. 底端悬浮三按钮：undo ↶ / redo ↷ / minimap toggle（在 Monaco 容器内 absolute）
//
// API: window.qqqEditorBreadcrumb = { create(hostPane, filePath, monacoEditor, monaco) }
// ============================================================================
(function () {
  'use strict';

  var _i = window._i || function (k, f) { return f || k; };

  // ── 按住连点引擎（undo/redo 长按持续触发）──
  var _repeatTimer = null;
  var _repeatInterval = null;

  function startRepeat(callback) {
    stopRepeat();
    _repeatTimer = setTimeout(function () {
      _repeatTimer = null;
      try { callback(); } catch (_) { }
      _repeatInterval = setInterval(function () {
        try { callback(); } catch (_) { }
      }, 50);
    }, 300);
  }

  function stopRepeat() {
    if (_repeatTimer) { clearTimeout(_repeatTimer); _repeatTimer = null; }
    if (_repeatInterval) { clearInterval(_repeatInterval); _repeatInterval = null; }
  }

  // ── 主入口 ──
  function create(hostPane, filePath, monacoEditor, monaco) {
    // 清理旧元素
    var oldBar = hostPane.querySelector('[data-qqq-editor-breadcrumb]');
    if (oldBar) oldBar.remove();
    var oldMc = hostPane.querySelector('[data-qqq-editor-monaco]');
    if (oldMc) {
      // 把 Monaco DOM 从旧容器里取回 hostPane（安全）
      var oldMcEditor = oldMc.querySelector('.monaco-editor');
      if (oldMcEditor && oldMcEditor.parentNode === oldMc && oldMc.parentNode === hostPane) {
        hostPane.appendChild(oldMcEditor);
      }
      oldMc.remove();
    }
    var oldBtns = hostPane.querySelector('[data-qqq-editor-float-btns]');
    if (oldBtns) oldBtns.remove();

    // hostPane 设为 flex 列布局：面包屑在上 → Monaco 容器在下
    hostPane.style.display = 'flex';
    hostPane.style.flexDirection = 'column';
    hostPane.style.overflow = 'hidden';

    // ═══ 1. 面包屑豆腐块（独立占高，可选可复制，不可编辑）═══
    var bar = document.createElement('div');
    bar.setAttribute('data-qqq-editor-breadcrumb', '1');
    bar.textContent = filePath || '';

    // 悬浮复制按钮（hover 面包屑时出现在右侧）
    var copyBtn = document.createElement('button');
    copyBtn.className = 'qqq-breadcrumb-copy-btn';
    copyBtn.textContent = '📋';
    copyBtn.title = _i('editor.copyPath', '复制路径');
    copyBtn.setAttribute('data-no-cd', '');
    copyBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var text = filePath || '';
      // Electron 22 — execCommand 比 clipboard API 更可靠
      var worked = false;
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        worked = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (_) { }
      if (worked) {
        copyBtn.textContent = '✓';
        setTimeout(function () { copyBtn.textContent = '📋'; }, 800);
      }
    });
    bar.appendChild(copyBtn);

    // 修复：body 级 user-select:none 导致 Chromium 不触发 copy 事件。
    // ★ 根因：bar tabindex=-1 不会被点击聚焦，keydown 永远到不了 bar。
    // 解决：在 document capture 阶段拦截 Ctrl+C，检测选区是否在任一面包屑内。
    if (!window.__qqqBreadcrumbCopyInstalled) {
      window.__qqqBreadcrumbCopyInstalled = true;
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'c' || (!e.ctrlKey && !e.metaKey)) return;
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        // 检查选区是否在任一面包屑内
        var node = sel.anchorNode;
        var inBreadcrumb = false;
        while (node) {
          if (node.getAttribute && node.getAttribute('data-qqq-editor-breadcrumb') === '1') {
            inBreadcrumb = true; break;
          }
          node = node.parentNode;
        }
        if (!inBreadcrumb) return;
        var text = sel.toString();
        if (!text) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {}
      }, true);
    }

    hostPane.appendChild(bar);

    // ═══ 2. Monaco 容器（包含编辑器 + 悬浮按钮）═══
    var mc = document.createElement('div');
    mc.setAttribute('data-qqq-editor-monaco', '1');

    // 将 Monaco 编辑器 DOM 从 hostPane 移入容器
    var monacoDom = monacoEditor.getDomNode();
    if (monacoDom && monacoDom.parentNode === hostPane) {
      mc.appendChild(monacoDom);
    }
    hostPane.appendChild(mc);

    // ═══ 3. 悬浮按钮行（在 Monaco 容器内，absolute 右下角）═══
    var btns = document.createElement('div');
    btns.setAttribute('data-qqq-editor-float-btns', '1');

    function _makeFloatBtn(text, title, onPress) {
      var btn = document.createElement('button');
      btn.className = 'qqq-editor-float-btn';
      btn.textContent = text;
      btn.title = title;
      btn.setAttribute('data-no-cd', '');
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        try { onPress(); } catch (_) { }
        startRepeat(onPress);
      });
      btn.addEventListener('mouseup', stopRepeat);
      btn.addEventListener('mouseleave', stopRepeat);
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      return btn;
    }

    // Undo ↶
    btns.appendChild(_makeFloatBtn('\u21B6',
      _i('editor.undo', '撤销 (Ctrl+Z)'),
      function () {
        if (window.qqqCharUndo) { window.qqqCharUndo.undo(monacoEditor); }
        else { try { monacoEditor.trigger('keyboard', 'undo', null); } catch (_) { } }
      }));

    // Redo ↷
    btns.appendChild(_makeFloatBtn('\u21B7',
      _i('editor.redo', '重做 (Ctrl+Y)'),
      function () {
        if (window.qqqCharUndo) { window.qqqCharUndo.redo(monacoEditor); }
        else { try { monacoEditor.trigger('keyboard', 'redo', null); } catch (_) { } }
      }));

    // Minimap toggle
    var mmOn = false;
    try { mmOn = monacoEditor.getOption(monaco.editor.EditorOption.minimap).enabled; } catch (_) { }
    var mmBtn = document.createElement('button');
    mmBtn.className = 'qqq-editor-float-btn';
    mmBtn.setAttribute('data-no-cd', '');
    mmBtn.textContent = mmOn ? '\uD83D\uDDFA' : '\u25A1';
    mmBtn.title = _i('editor.minimap', '小地图');
    mmBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      try {
        var cur = monacoEditor.getOption(monaco.editor.EditorOption.minimap).enabled;
        var next = !cur;
        monacoEditor.updateOptions({ minimap: { enabled: next } });
        mmBtn.textContent = next ? '\uD83D\uDDFA' : '\u25A1';
        if (window.qqqEditor && window.qqqEditor.saveMinimapPref && filePath) {
          window.qqqEditor.saveMinimapPref(filePath, next);
        }
      } catch (_) { }
    });
    btns.appendChild(mmBtn);

    mc.appendChild(btns);
  }

  window.qqqEditorBreadcrumb = { create: create };

})();
