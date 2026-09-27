// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// editor-breadcrumb.js — 极简面包屑（独立豆腐块）+ 悬浮按钮行
//
// 1. 顶端面包屑：独立 DOM 块（2026-09-27——真·单列内联流：flex 三列整体废除，三个部件同处一条文字流）
//    串行编队：路径文本 → 编码按钮 → 复制按钮 → Roam 按钮（2026-09-27 回中间位 + 末尾 Roam 定位）；路径吃满整行宽度折行（换行次数最少 = 上下空间最省）
//    路径恒完整显示（绝不省略号——放不下时自然折行）
//    文字可选中/复制，不可编辑；下方一切（Monaco / Ctrl+F / 小地图）被其高度挤开
// 2. 底端悬浮按钮行（Monaco 容器内 absolute 右下角）：md 预览 👁（仅 Markdown 文件）
//    / undo ↶ / redo ↷ / minimap toggle
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

    // 路径文本（2026-09-27 行序 = 路径 → 编码按钮 → 复制（编码按钮回中间位）；单列内联流里吃满整行宽度，可选中/复制；恒完整显示——超长自然折行，绝不省略号/截断）
    var pathSpan = document.createElement('span');
    pathSpan.className = 'qqq-breadcrumb-path';
    pathSpan.textContent = filePath || '';
    bar.appendChild(pathSpan);

    // ★ 编码徽标（恒醒态，紧随路径文本）：直接呈现 hover 外观（全不透明+可见边框）/ 非默认态标准 / 固定态金色+*
    //   点击 → 编码方案弹层（tab 右键行已删——本徽标 = 唯一恒定入口）；语义/渲染唯一源 = tab-manager 编码机器
    //   恒显保障（2026-09-27）：证据未到显示默认态占位；renderEncIndicator 创建即主动拉一次证据 → 到达即校正真值
    var encChip = document.createElement('span');
    encChip.className = 'qqq-enc-chip qqq-enc-auto';
    encChip.setAttribute('data-qqq-breadcrumb-enc', '1');
    encChip.hidden = true;
    if (filePath) {
      encChip.setAttribute('data-enc-path', filePath);
      encChip.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        try {
          if (window.qqqTabs && window.qqqTabs.openEncPopupForPath) window.qqqTabs.openEncPopupForPath(encChip, filePath);
        } catch (_) { }
      });
    }
    bar.appendChild(encChip);

    // 初始渲染：证据已在缓存 → 立即显形；否则默认态占位（恒显不空窗）；内部主动拉证据，到达即校正
    try {
      if (filePath && window.qqqTabs && window.qqqTabs.renderEncIndicator) window.qqqTabs.renderEncIndicator(encChip, filePath);
    } catch (_) { }

    // 复制按钮 — 恒显内联（2026-09-27：外观 = 旧 hover 态；不再等光标 hover、不再占右侧独立列——紧随编码按钮）
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

    // Roam 按钮 — 恒显内联（2026-09-27）：点击 = 在 Roam 中定位该文件（定位机器唯一入口 = shell-overlay __qqq_roamRevealPath——
    //   与 codelens 🗀qqq 同源零第二实现：命中 revealFile 选中+滚动（Roam 未开则召回/加开 tab）/ 缺失自动爬升最近祖先 + qoast 裁决）
    var roamBtn = document.createElement('button');
    roamBtn.className = 'qqq-breadcrumb-roam-btn';
    roamBtn.textContent = 'Roam';
    roamBtn.title = _i('editor.roamLocate', '在 Roam 中定位该文件');
    roamBtn.setAttribute('data-no-cd', '');
    roamBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var p = filePath || '';
      if (!p) return;
      try {
        if (typeof window.__qqq_roamRevealPath === 'function') { window.__qqq_roamRevealPath(p); return; }
      } catch (_) { }
      // 兜底（shell-overlay 未加载）：系统资源管理器定位（与 codelens 同款兜底链）
      try {
        var b = window.qqqideBridge;
        if (b && b.shell && b.shell.showItemInFolder) { b.shell.showItemInFolder(p); return; }
        var dir = p.replace(/[\\/][^\\/]*$/, '');
        if (b && b.shell && b.shell.openPath && dir && dir !== p) { b.shell.openPath(dir); }
      } catch (_) { }
    });
    bar.appendChild(roamBtn);

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

    // ★ Markdown 预览 👁（2026-09-20）：仅 .md/.markdown 文件——唯一可见入口（菜单备选已删：
    //   一个功能一处；后台标签先点亮即得入口）；判定 qqqMdPreview.isMd + 入口 .open
    if (filePath && window.qqqMdPreview && window.qqqMdPreview.isMd(filePath)) {
      var mdBtn = document.createElement('button');
      mdBtn.className = 'qqq-editor-float-btn';
      mdBtn.setAttribute('data-no-cd', '');
      mdBtn.textContent = '\uD83D\uDC41\uFE0F';
      mdBtn.title = _i('mdview.action', '预览 Markdown');
      mdBtn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        try { window.qqqMdPreview.open(filePath); } catch (_) { }
      });
      btns.appendChild(mdBtn);
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
