// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// editor-breadcrumb.js — 极简面包屑（独立豆腐块）+ 悬浮按钮行
//
// 1. 顶端面包屑：独立 DOM 块（2026-09-27——真·单列内联流：flex 三列整体废除，全部部件同处一条文字流）
//    串行编队：路径文本 → 编码按钮 → 复制按钮 → Roam 按钮 → 时间线按钮（2026-09-27 回中间位 + 末尾 Roam；2026-09-28 末位新增时间线）；路径吃满整行宽度折行（换行次数最少 = 上下空间最省）
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

  // ── 时间线根目录解析（2026-09-28）——文件自寻主，与时间线记录侧同一口径：
  //   ① 逐级向上找 _qqq/timeline 或 .git（panel-a4 钩子 Q「文件自寻主」同规则——绝大多数时间线记录写于此根）
  //   ② window._workspaceRoot（主窗口全局，由 AI 面板绑定工作空间时写入——可能为空，禁作唯一来源）
  //   ③ bridge.sync.getProjectPath()（主进程当前项目路径）
  //   命中即回调；全失败回调 ''（调用方拒绝开空窗）。返回恒为正斜杠/无尾斜杠字符串。
  function _resolveTimelineRoot(filePath, done) {
    var b = window.qqqideBridge;
    function _ws() {
      try {
        var w = window._workspaceRoot || '';
        if (w) return String(w).replace(/\\/g, '/').replace(/\/$/, '');
      } catch (_) { }
      return '';
    }
    function _proc() {
      try {
        if (b && b.sync && b.sync.getProjectPath) {
          b.sync.getProjectPath().then(function (p) {
            done(p ? String(p).replace(/\\/g, '/').replace(/\/$/, '') : '');
          }).catch(function () { done(''); });
          return;
        }
      } catch (_) { }
      done('');
    }
    if (!filePath || !b || !b.fs || !b.fs.stat) return _proc();
    var dir = String(filePath).replace(/\\/g, '/').replace(/\/[^\/]*$/, '');
    var depth = 0;
    function step() {
      if (!dir || dir.length <= 3 || depth >= 12) {
        var w = _ws();
        if (w) return done(w);
        return _proc();
      }
      depth++;
      var cur = dir;
      function down() { dir = cur.replace(/\/[^\/]*$/, ''); step(); }
      b.fs.stat(cur + '/_qqq/timeline').then(function (st) {
        if (st && st.isDir) return done(cur);
        b.fs.stat(cur + '/.git').then(function (st2) {
          if (st2 && st2.isDir) return done(cur);
          down();
        }).catch(down);
      }).catch(down);
    }
    step();
  }

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

  // ═══ 面包屑即时 hover 文字框（零延迟；多编辑器/多分组共用单例）═══
  //   用途：Roam 按钮 = 文件大小（Roam 风格千分位原文打印）/ 时间线按钮 = 版本库收录版本数（只打一个数字）
  //   视觉唯一源 = shell-main.css .qqq-breadcrumb-tip（同「状态栏活动豆腐块」即时框 .qqq-act-tip 同款）
  var _bcTip = null;        // 单例提示框 element
  var _bcTipAnchor = null;  // 当前锚点按钮（编辑器/分组重建时防悬停卡死）

  function _ensureBcTip() {
    if (_bcTip && document.body.contains(_bcTip)) return _bcTip;
    _bcTip = document.createElement('div');
    _bcTip.className = 'qqq-breadcrumb-tip';
    document.body.appendChild(_bcTip);
    return _bcTip;
  }

  function _showBcTip(btn, text) {
    var tip = _ensureBcTip();
    if (tip.__qqqSig !== text) { tip.textContent = text; tip.__qqqSig = text; }
    tip.style.display = 'block';            // 先显形再量尺寸（display:none 下 offsetWidth 恒 0）
    var r = btn.getBoundingClientRect();
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var x = r.left + r.width / 2 - w / 2;
    var y = r.bottom + 6;                   // 面包屑在顶部：默认按钮下方
    var vw = window.innerWidth, vh = window.innerHeight;
    x = Math.max(8, Math.min(vw - w - 8, x));
    if (y + h > vh - 8) y = Math.max(8, r.top - h - 6);   // 下方放不下 → 翻到按钮上方
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
    _bcTipAnchor = btn;
  }

  function _hideBcTip() {
    if (_bcTip) _bcTip.style.display = 'none';
    _bcTipAnchor = null;
  }

  // 千分位（与 Roam addThousandSep 逐字同算法）：字节数 → "1,593,270"
  function _addThousandSep(num) {
    var n = Math.floor(Number(num));
    if (!isFinite(n) || n < 0) n = 0;
    var s = String(n), parts = [];
    for (var i = s.length; i > 0; i -= 3) parts.unshift(s.slice(Math.max(0, i - 3), i));
    return parts.join(',');
  }

  // ── 主入口 ──
  function create(hostPane, filePath, monacoEditor, monaco) {
    // 清理旧元素
    var oldBar = hostPane.querySelector('[data-qqq-editor-breadcrumb]');
    if (oldBar) oldBar.remove();
    // hover 文字框如锚在被移除的旧按钮上 → 立即收起（防悬停中重建残留）
    if (_bcTipAnchor && !document.contains(_bcTipAnchor)) _hideBcTip();
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

    // 复制按钮 — 恒显内联 · 淡雅统一档（2026-09-27：外观 = 编码徽标同款（灰边框+次文字色+透明底），悬浮 → 显著档（金边+实底）；不再等光标 hover、不再占右侧独立列——紧随编码按钮）
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

    // Roam 按钮 — 恒显内联 · 淡雅统一档（2026-09-27：外观与编码徽标/复制按钮零差异，悬浮 → 显著档）：点击 = 在 Roam 中定位该文件（定位机器唯一入口 = shell-overlay __qqq_roamRevealPath——
    //   与 codelens 🗀qqq 同源零第二实现：命中 revealFile 选中+滚动（Roam 未开则召回/加开 tab）/ 缺失自动爬升最近祖先 + qoast 裁决）
    var roamBtn = document.createElement('button');
    roamBtn.className = 'qqq-breadcrumb-roam-btn';
    roamBtn.textContent = 'Roam';
    // ★ hover 即时文字框（2026-10-01 q390 用户定案）：只打印当前文件大小（Roam 风格千分位原文，如 1,593,270）
    //   ——两键原生 title 已删（防与即时框双弹）；显示/定位/隐藏 = _showBcTip / _hideBcTip（同「状态栏活动豆腐块」即时框）
    var _roamHover = false, _roamSizeCache = null, _roamSizePending = false;
    function _roamFetchSize() {
      if (_roamSizePending || !filePath) return;
      var b = window.qqqideBridge;
      if (!b || !b.fs || !b.fs.stat) return;
      _roamSizePending = true;
      b.fs.stat(filePath).then(function (st) {
        _roamSizePending = false;
        if (!st || typeof st.size !== 'number') return;
        _roamSizeCache = st.size;
        if (_roamHover) _showBcTip(roamBtn, _addThousandSep(st.size));   // 悬停仍在 → 就位即刷新
      }).catch(function () { _roamSizePending = false; });
    }
    roamBtn.addEventListener('mouseenter', function () {
      if (!filePath) return;
      _roamHover = true;
      if (_roamSizeCache != null) _showBcTip(roamBtn, _addThousandSep(_roamSizeCache));   // 已知值立显（零等待）
      _roamFetchSize();   // 同时拉磁盘真值（文件可能刚被改）
    });
    roamBtn.addEventListener('mouseleave', function () { _roamHover = false; _hideBcTip(); });
    roamBtn.setAttribute('data-no-cd', '');
    roamBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      _roamHover = false;   // 点击后即收框（指针仍悬停也不再回弹）
      _hideBcTip();
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

    // 时间线按钮 — 恒显内联 · 淡雅统一档（2026-09-28 用户定案）：点击 = 打开该文件的版本时间线窗口
    //   唯一入口 = bridge.timeline.openDiffWindow（与 AI 视口右键「时间线」/ A4 快照点击同源零第二实现；
    //   单文件单例窗口——已在开则聚焦并刷新）；projectRoot 经 _resolveTimelineRoot 三层解析（文件自寻主优先——
    //   ✘ 旧实现单取 window._workspaceRoot：绑定期为空 → 空根开窗 →「缺少参数」空白窗）
    var tlBtn = document.createElement('button');
    tlBtn.className = 'qqq-breadcrumb-timeline-btn';
    tlBtn.textContent = '\uD83D\uDD58'; // 时钟图标（文字按钮「timeline」太宽，图标化 ≈28px）
    // ★ hover 即时文字框（2026-10-01 q390 用户定案）：只打印版本时间线库收录的版本数（一个数字）
    //   根解析沿用 _resolveTimelineRoot（与点击开窗同口径——hover 数 = 该窗口将展示的库存）；原生 title 已删
    var _tlHover = false, _tlCountCache = null, _tlRootCache = '', _tlPending = false, _tlLastTs = 0;
    function _tlFetchCount() {
      if (_tlPending || !filePath) return;
      var b = window.qqqideBridge;
      if (!b || !b.timeline || !b.timeline.versions) return;
      if (_tlCountCache != null && (Date.now() - _tlLastTs) < 3000) return;   // 3s 内复用缓存（版本入库低频，防连悬打 IPC）
      _tlPending = true;
      function _done(n) {
        _tlPending = false;
        _tlLastTs = Date.now();
        _tlCountCache = n;
        if (_tlHover) _showBcTip(tlBtn, _addThousandSep(n));
      }
      function _query(root) {
        if (!root) { _done(0); return; }   // 全链解析失败 = 库存查无版本（点击侧仍会如实 qoast）
        _tlRootCache = root;
        b.timeline.versions({ projectRoot: root, filePath: filePath }).then(function (list) {
          _done((list && list.length) || 0);
        }).catch(function () { _tlPending = false; });
      }
      if (_tlRootCache) _query(_tlRootCache);
      else _resolveTimelineRoot(filePath, _query);
    }
    tlBtn.addEventListener('mouseenter', function () {
      if (!filePath) return;
      _tlHover = true;
      if (_tlCountCache != null) _showBcTip(tlBtn, _addThousandSep(_tlCountCache));
      _tlFetchCount();
    });
    tlBtn.addEventListener('mouseleave', function () { _tlHover = false; _hideBcTip(); });
    tlBtn.setAttribute('data-no-cd', '');
    tlBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      _tlHover = false;   // 点击后即收框（指针仍悬停也不再回弹）
      _hideBcTip();
      var p = filePath || '';
      if (!p) return;
      var b = window.qqqideBridge;
      if (!b || !b.timeline || !b.timeline.openDiffWindow) return;
      function _tlFailToast() {
        // 打开链失败必须如实提示（禁静默吞错——「点击零反应」体验根治）
        try {
          if (window.qqqideQoast) window.qqqideQoast.show(_i('editor.timelineOpenFail', '时间线窗口打开失败，请稍后重试'), { type: 'warn', duration: 5000 });
        } catch (_) { }
      }
      _resolveTimelineRoot(p, function (root) {
        if (!root) {
          // 全链解析失败：不开空窗（旧实现带空根开窗 = 空白窗「缺少参数」），如实提示
          try {
            if (window.qqqideQoast) window.qqqideQoast.show(_i('editor.timelineNoRoot', '无法确定该文件的项目根目录，时间线不可用'), { type: 'warn', duration: 5000 });
          } catch (_) { }
          return;
        }
        try {
          var r = b.timeline.openDiffWindow({ filePath: p, projectRoot: root });
          if (r && r.then) {
            r.then(function (res) { if (res && res.ok === false) { _tlFailToast(); } }).catch(_tlFailToast);
          }
        } catch (_) { _tlFailToast(); }
      });
    });
    bar.appendChild(tlBtn);

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
