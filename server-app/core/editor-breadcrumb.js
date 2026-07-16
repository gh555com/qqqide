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
    var oldCopyRow = hostPane.querySelector('.qqq-breadcrumb-copy-row');
    if (oldCopyRow) oldCopyRow.remove();
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

    // hostPane 设为 flex 列布局：复制行 → 面包屑 → Monaco 容器
    hostPane.style.display = 'flex';
    hostPane.style.flexDirection = 'column';
    hostPane.style.overflow = 'hidden';

    // ═══ 1. 悬浮复制行（hover 面包屑时显示，独立 flex 行，不挡任何东西）═══
    var copyRow = document.createElement('div');
    copyRow.className = 'qqq-breadcrumb-copy-row';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'qqq-breadcrumb-copy-btn';
    copyBtn.textContent = '📋 ' + (filePath || '');
    copyBtn.title = _i('editor.copyPath', '点击复制完整路径');
    copyBtn.setAttribute('data-no-cd', '');
    copyBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var text = filePath || '';
      try {
        navigator.clipboard.writeText(text);
      } catch (_) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      var orig = copyBtn.textContent;
      copyBtn.textContent = '✓ 已复制';
      setTimeout(function () { copyBtn.textContent = '📋 ' + (filePath || ''); }, 800);
    });
    copyRow.appendChild(copyBtn);
    hostPane.appendChild(copyRow);

    // ═══ 2. 面包屑豆腐块 ═══
    var bar = document.createElement('div');
    bar.setAttribute('data-qqq-editor-breadcrumb', '1');
    bar.textContent = filePath || '';
    hostPane.appendChild(bar);

    // hover 面包屑或复制行 → 显示复制行；离开两者 → 隐藏
    var _hideTimer = null;
    function _showCopyRow() {
      if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
      copyRow.style.display = 'flex';
    }
    function _hideCopyRow() {
      _hideTimer = setTimeout(function () {
        copyRow.style.display = 'none';
      }, 200);
    }
    bar.addEventListener('mouseenter', _showCopyRow);
    bar.addEventListener('mouseleave', _hideCopyRow);
    copyRow.addEventListener('mouseenter', _showCopyRow);
    copyRow.addEventListener('mouseleave', _hideCopyRow);

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
