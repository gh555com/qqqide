// ============================================================================
// shell-overlay.js — AI 悬浮预览层（图片 + 表格，全窗口）（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window._i, window.qqqideTheme
// ============================================================================

function bootAiOverlay() {
  var bridge = window.qqqideBridge;
  // 全局唯一 overlay ID（用于跨窗口协调：同时最多一个悬浮预览）
  var _overlayId = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  // IPC sync 替代 BroadcastChannel：跨窗口 overlay 协调
  var _ovUnsub = null;
  try {
    if (bridge && bridge.sync) {
      _ovUnsub = bridge.sync.onMessage(function (channel, data) {
        if (channel === 'overlay-open' && data && data.id !== _overlayId) {
          // 其他窗口打开了 overlay → 关闭自己的
          close();
        }
      });
    }
  } catch (_) { }

  var overlay = document.createElement('div');
  overlay.id = 'qqqide-overlay';
  overlay.style.cssText =
    'display:none; position:absolute; inset:0; z-index:99999; ' +
    'background:rgba(0,0,0,0.88);';

  // ── 主题化滚动条（注:style）──
  var _scrollStyle = document.createElement('style');
  _scrollStyle.textContent =
    '#qqqide-overlay-content ::-webkit-scrollbar{width:8px;height:8px}' +
    '#qqqide-overlay-content ::-webkit-scrollbar-track{background:rgba(255,255,255,0.05)}' +
    '#qqqide-overlay-content ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:4px}' +
    '#qqqide-overlay-content ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.35)}' +
    '#qqqide-overlay-content>div::-webkit-scrollbar{display:none}';
  document.head.appendChild(_scrollStyle);

  // ── 选中色 + 高亮匹配色 ──
  //    ::selection（用户拖选）= 实心 #ffd301
  //    ::highlight(ov-matches)（全文匹配）= 半透明同色，区分用户选区
  var _selStyle = document.createElement('style');
  _selStyle.textContent =
    '#qqq-ai-overlay-content ::selection{background:#ffd301;color:#000}' +
    '::highlight(ov-matches){background:rgba(255,140,110,0.38);color:inherit;border-radius:2px}';
  document.head.appendChild(_selStyle);

  var contentEl = document.createElement('div');
  contentEl.id = 'qqq-ai-overlay-content';
  contentEl.style.cssText =
    'position:absolute; top:0; left:0; right:0; bottom:64px; display:flex; align-items:center; ' +
    'justify-content:center; padding:32px; overflow:hidden;';

  // Bottom toolbar
  var toolbar = document.createElement('div');
  toolbar.id = 'qqq-ai-overlay-toolbar';
  toolbar.style.cssText =
    'position:absolute; bottom:0; left:0; right:0; height:64px; display:flex; ' +
    'align-items:center; justify-content:center; gap:16px; ' +
    'background:rgba(0,0,0,0.5); border-top:1px solid rgba(255,255,255,0.1);';

  function tbBtn(text, title, styles) {
    var b = document.createElement('button');
    b.textContent = text;
    b.title = title || '';
    b.tabIndex = -1;  // ★ 防焦点窃取：按钮不抢焦点，确保 Ctrl+C 原生复制可用
    b.style.cssText = 'padding:8px 18px; border:1px solid rgba(255,255,255,0.25); border-radius:6px; ' +
      'background:rgba(255,255,255,0.1); color:#fff; font-size:14px; ' +
      'user-select:none; line-height:1; outline:none; ' + (styles || '');
    return b;
  }

  var zoomScale = 1.0;
  // 拖拽偏移（图片和表格共用 translate）
  var _dragX = 0, _dragY = 0;

  // ── 选中高亮全文匹配（CSS Highlight API — 零 DOM 操作，不阻复制、零抖动）──
  var _ovLastMatchText = '';

  function _ovApplyHighlights(text) {
    _ovClearHighlights();
    if (!text || text.length < 1) return;
    _ovLastMatchText = text;
    // 找到表格/代码块的 wrapper
    var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper');
    if (!wrapper) {
      var d2 = contentEl.querySelector('div > div');
      if (d2 && !d2.querySelector('img')) wrapper = d2;
    }
    if (!wrapper) return;
    var tLower = text.toLowerCase();
    var ranges = [];
    var walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (!node.textContent || !node.textContent.trim()) continue;
      var lower = node.textContent.toLowerCase();
      var searchFrom = 0;
      while (searchFrom < lower.length) {
        var idx = lower.indexOf(tLower, searchFrom);
        if (idx < 0) break;
        var r = new Range();
        r.setStart(node, idx);
        r.setEnd(node, idx + text.length);
        ranges.push(r);
        searchFrom = idx + tLower.length;
      }
    }
    if (ranges.length > 0) {
      try {
        var hl = new Highlight();
        for (var ri = 0; ri < ranges.length; ri++) hl.add(ranges[ri]);
        CSS.highlights.set('ov-matches', hl);
      } catch (_) { /* CSS Highlight API 不可用则静默降级 */ }
    }
  }

  function _ovClearHighlights() {
    try { CSS.highlights.delete('ov-matches'); } catch (_) { }
    _ovLastMatchText = '';
  }
  function applyZoom() {
    var img = contentEl.querySelector('img');
    if (img) {
      img.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
      img.style.transition = 'transform 0.15s ease';
      return;
    }
    // 表格：wrapper 在 clipBox 内，统一采用 scale+translate（禁止 reflow，保持原始比例与换行）
    var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper');
    if (!wrapper) {
      // 回退：可能是旧版本无 class 的 div
      var div = contentEl.querySelector('div > div');
      if (div && !div.querySelector('img')) wrapper = div;
    }
    if (!wrapper) {
      var div2 = contentEl.querySelector('div');
      if (div2 && !div2.querySelector('img') && !div2.classList.contains('qqq-overlay-table-wrapper')) wrapper = div2;
    }
    if (wrapper) {
      wrapper.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
      wrapper.style.transition = 'transform 0.15s ease';
    }
  }

  // Copy button
  var copyBtn = tbBtn('', window._i('shell.overlay.copy', '复制到剪贴板'));
  copyBtn.setAttribute('data-i18n', 'shell.overlay.copy');
  copyBtn.textContent = '\uD83D\uDCCB \u590D\u5236';
  function doCopy(text) {
    var ok = false;
    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        copyBtn.textContent = '\u2705 ' + window._i('shell.overlay.copied', '已复制');
        setTimeout(function () { copyBtn.textContent = '\uD83D\uDCCB ' + window._i('shell.overlay.copy', '复制'); }, 1500);
      }).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
    function fallbackCopy(t) {
      // execCommand fallback
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok = true; } catch (ex) { }
      document.body.removeChild(ta);
      copyBtn.textContent = ok ? '\u2705 ' + window._i('shell.overlay.copied', '已复制') : '\u274C ' + window._i('shell.overlay.copyFailed', '失败');
      setTimeout(function () { copyBtn.textContent = '\uD83D\uDCCB ' + window._i('shell.overlay.copy', '复制'); }, 1500);
    }
  }
  copyBtn.addEventListener('click', function () {
    // Copy selected text first, fallback to all text
    var sel = window.getSelection();
    if (sel && sel.toString().trim()) {
      doCopy(sel.toString());
      return;
    }
    var img = contentEl.querySelector('img');
    if (img) { doCopy(img.src); return; }
    var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper') || contentEl.querySelector('div');
    if (wrapper) { doCopy(wrapper.innerText || wrapper.textContent); }
  });

  // Zoom out（跳过冷却护盾，准许快速连按）
  var zoomOutBtn = tbBtn('\u2212', window._i('shell.overlay.zoomOut', '缩小'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
  zoomOutBtn.setAttribute('data-no-cd', '');
  zoomOutBtn.addEventListener('click', function () {
    zoomScale = Math.max(0.25, zoomScale * 0.8);
    applyZoom();
  });

  // Zoom in（跳过冷却护盾，准许快速连按）
  var zoomInBtn = tbBtn('+', window._i('shell.overlay.zoomIn', '放大'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
  zoomInBtn.setAttribute('data-no-cd', '');
  zoomInBtn.addEventListener('click', function () {
    zoomScale = Math.min(5.0, zoomScale * 1.25);
    applyZoom();
  });

  // Close (extra large) — custom tooltip: high-contrast instant cursor-following
  var closeBtnEl = tbBtn('\u2715', '', 'font-size:24px; font-weight:bold; padding:8px 22px; ' +
    'background:rgba(220,50,47,0.5); border-color:rgba(220,50,47,0.7);');
  closeBtnEl.addEventListener('click', close);

  // ★ 自定义高对比度瞬间弹出 tooltip，跟随光标
  var _closeTt = document.createElement('div');
  _closeTt.textContent = '= Right Click';
  _closeTt.style.cssText = 'display:none;position:fixed;z-index:100001;pointer-events:none;' +
    'background:#000;color:#ffd301;padding:4px 10px;font-size:12px;font-weight:700;' +
    'font-family:system-ui,-apple-system,sans-serif;border:2px solid #ffd301;border-radius:4px;white-space:nowrap;' +
    'line-height:1.4;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.8);';
  document.body.appendChild(_closeTt);
  closeBtnEl.addEventListener('mouseenter', function (e) {
    _closeTt.style.display = '';
    _closeTt.style.left = (e.clientX + 16) + 'px';
    _closeTt.style.top = (e.clientY - 36) + 'px';
  });
  closeBtnEl.addEventListener('mousemove', function (e) {
    _closeTt.style.left = (e.clientX + 16) + 'px';
    _closeTt.style.top = (e.clientY - 36) + 'px';
  });
  closeBtnEl.addEventListener('mouseleave', function () {
    _closeTt.style.display = 'none';
  });

  // 右键关闭
  overlay.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    close();
  });

  toolbar.appendChild(copyBtn);
  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(closeBtnEl);

  overlay.appendChild(contentEl);
  overlay.appendChild(toolbar);
  // ★ 挂到 #qqq-main，遮罩仅覆盖中间区域，左右翼不受影响
  var _mainEl = document.getElementById('qqq-main');
  (_mainEl || document.body).appendChild(overlay);

  function close() {
    try { _stopRepeat(); } catch (_) { }
    try { _ovClearHighlights(); } catch (_) { }
    _closeTt.style.display = 'none';
    overlay.style.display = 'none';
    dpad.style.display = 'none';
    contentEl.innerHTML = '';
    contentEl.style.overflow = '';
    zoomScale = 1.0;
    _dragX = 0; _dragY = 0;
  }
  var _baseClose = close;  // 保存原始 close，用于恢复

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });

  document.addEventListener('keydown', function (e) {
    if (overlay.style.display === 'none') return;
    if (e.key === 'Escape') { close(); return; }
    // ★ Ctrl+C / Ctrl+Insert：绕过浏览器焦点路由，直接用剪贴板 API 复制选中文本
    if ((e.key === 'c' || e.key === 'C' || e.key === 'Insert') && (e.ctrlKey || e.metaKey)) {
      var sel = window.getSelection();
      var selText = sel && sel.toString().trim();
      if (selText) {
        e.preventDefault(); e.stopPropagation();
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(selText).catch(function () {
              // 静默回退
              var ta = document.createElement('textarea');
              ta.value = selText; ta.style.cssText = 'position:fixed;left:-9999px';
              document.body.appendChild(ta); ta.select();
              try { document.execCommand('copy'); } catch (_) { }
              document.body.removeChild(ta);
            });
          }
        } catch (_) { }
      }
    }
  });

  // ── 选中高亮全文匹配（CSS Highlight API）──
  overlay.addEventListener('mouseup', function (e) {
    if (overlay.style.display === 'none') return;
    if (e.target.closest('#qqq-ai-overlay-toolbar')) return;
    if (e.target.closest('button')) return;
    setTimeout(function () {
      if (overlay.style.display === 'none') return;
      var sel = window.getSelection();
      var text = sel && sel.toString().trim();
      if (text && text.length >= 1 && text !== _ovLastMatchText) {
        _ovApplyHighlights(text);
      } else if (!text) {
        _ovClearHighlights();
      }
    }, 80);
  });

  overlay.addEventListener('mousedown', function (e) {
    if (overlay.style.display === 'none') return;
    setTimeout(function () {
      var sel = window.getSelection();
      var newText = sel && sel.toString().trim();
      if (!newText || newText !== _ovLastMatchText) {
        _ovClearHighlights();
      }
    }, 100);
  });

  // Mouse wheel zoom（统一图片和表格，滚轮=缩放）
  overlay.addEventListener('wheel', function (e) {
    if (overlay.style.display === 'none') return;
    e.preventDefault(); e.stopPropagation();
    if (e.deltaY < 0) { zoomScale = Math.min(5.0, zoomScale * 1.15); }
    else { zoomScale = Math.max(0.25, zoomScale * 0.87); }
    applyZoom();
  }, { passive: false, capture: true });

  // ── 十字方向键（Game Boy 风格，独立控件，移动画布）──
  var dpad = document.createElement('div');
  dpad.style.cssText =
    'display:none; position:absolute; right:14px; bottom:78px; z-index:100000; ' +
    'width:96px; height:96px; user-select:none;';
  var BS = 32; // button size
  function _crossBtn(sym, top, left) {
    var b = document.createElement('button');
    b.textContent = sym; b.setAttribute('data-no-cd', '');
    b.tabIndex = -1;  // ★ 防焦点窃取
    b.style.cssText = 'position:absolute; width:' + BS + 'px; height:' + BS + 'px; padding:0; font-size:16px; line-height:1; ' +
      'border:1px solid rgba(255,255,255,0.35); border-radius:4px; background:rgba(0,0,0,0.55); ' +
      'color:#ccc; display:flex; align-items:center; justify-content:center; outline:none;';
    b.style.top = top + 'px'; b.style.left = left + 'px';
    return b;
  }
  var btnUp = _crossBtn('\u25B2', 0, BS);
  var btnLeft = _crossBtn('\u25C0', BS, 0);
  var btnCenter = _crossBtn('\u2302', BS, BS);
  var btnRight = _crossBtn('\u25B6', BS, BS * 2);
  var btnDown = _crossBtn('\u25BC', BS * 2, BS);
  btnCenter.title = window._i('shell.overlay.resetPosition', '重置位置');
  btnCenter.style.background = 'rgba(255,255,255,0.12)';
  btnCenter.style.borderColor = 'rgba(255,255,255,0.25)';
  var _initZoom = 1.0;
  function _nudge(dx, dy) {
    var step = 80;
    var s = zoomScale || 1;
    // 图片和表格统一用 _dragX/_dragY + translate，scrollLeft 在 transform scale 下无效
    _dragX -= dx * step / s;
    _dragY -= dy * step / s;
    applyZoom();
  }
  function _resetView() {
    _dragX = 0; _dragY = 0;
    var w = contentEl.querySelector('.qqq-overlay-table-wrapper') || contentEl.querySelector('img');
    if (w) { zoomScale = _initZoom; }
    else { zoomScale = 1.0; }
    applyZoom();
  }
  // ── 按住连点：mousedown 启动定时器，mouseup/mouseleave 停止 ──
  var _repeatTimer = 0, _repeatDelay = 150, _repeatInterval = 50;
  function _startRepeat(dx, dy) {
    _nudge(dx, dy);
    _repeatTimer = setTimeout(function () {
      _repeatTimer = setInterval(function () { _nudge(dx, dy); }, _repeatInterval);
    }, _repeatDelay);
  }
  function _stopRepeat() {
    if (_repeatTimer) { clearTimeout(_repeatTimer); clearInterval(_repeatTimer); _repeatTimer = 0; }
  }
  function _bindDpadBtn(btn, dx, dy) {
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); _startRepeat(dx, dy); });
    btn.addEventListener('mouseup', function (e) { e.preventDefault(); _stopRepeat(); });
    btn.addEventListener('mouseleave', function (e) { _stopRepeat(); });
  }
  _bindDpadBtn(btnUp, 0, -1);
  _bindDpadBtn(btnDown, 0, 1);
  _bindDpadBtn(btnLeft, -1, 0);
  _bindDpadBtn(btnRight, 1, 0);
  btnCenter.addEventListener('mousedown', function (e) { e.preventDefault(); _resetView(); });
  dpad.appendChild(btnUp); dpad.appendChild(btnLeft); dpad.appendChild(btnCenter);
  dpad.appendChild(btnRight); dpad.appendChild(btnDown);
  overlay.appendChild(dpad);

  // Listen for messages from AI iframe
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'qqqide-overlay') return;
    if (e.data.action === 'close') { close(); return; }

    // 跨窗口协调：广播自己的 overlay ID，其他窗口收到后自动关闭
    try {
      if (bridge && bridge.sync) {
        bridge.sync.broadcast('overlay-open', { id: _overlayId });
      }
    } catch (_) { }

    if (e.data.action === 'open-image') {
      // 强制清理上一轮残留状态（含 close 函数恢复）
      close = _baseClose;
      _stopRepeat();
      overlay.style.display = 'none';
      contentEl.innerHTML = '';
      contentEl.style.overflow = '';
      zoomScale = 1.0;
      _dragX = 0; _dragY = 0;
      // ★ 先让 overlay 可见以取得正确容器尺寸，再加载图片（避免缓存图 onload 同步触发时容器尺寸为 0）
      overlay.style.display = 'block';
      contentEl.style.overflow = 'hidden';
      // ── 边界适配：尝试 2x 放大，但绝不超出内容区可用空间 ──
      var img = new Image();
      img.onload = function () {
        var nw = img.naturalWidth, nh = img.naturalHeight;
        // 内容区可用空间：overlay 填充 #qqq-main，扣除工具栏 64px + 内边距 32px×2
        var availW = Math.max(200, (overlay.clientWidth || window.innerWidth) - 64);
        var availH = Math.max(150, (overlay.clientHeight || window.innerHeight) - 64 - 64);
        // 理想：2x 放大；上限：不超过可用空间
        var targetW = Math.min(nw * 2, availW);
        var targetH = Math.min(nh * 2, availH);
        // 统一缩放比：取宽高两个方向中更紧的那个，且不超 2.0（2x 封顶）
        var scale = Math.min(targetW / nw, targetH / nh, 2.0);
        // 若原图已大于可用空间，scale < 1.0 → 缩小适配
        var finalW = Math.round(nw * scale), finalH = Math.round(nh * scale);
        img.style.cssText =
          'width:' + finalW + 'px; height:' + finalH + 'px; ' +
          'object-fit:contain; box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
          'display:block; user-select:none; will-change:transform;';
        contentEl.appendChild(img);
        contentEl.style.overflow = 'visible';
        // ── 拖拽平移 ──
        var dragging = false, sx = 0, sy = 0, _raf = 0, _pending = false;
        function onMD(ev) {
          if (ev.button !== 0) return;
          dragging = true; sx = ev.clientX; sy = ev.clientY;
          img.style.transition = 'none';
          ev.preventDefault();
        }
        function onMM(ev) {
          if (!dragging) return;
          var s = zoomScale || 1;
          _dragX += (ev.clientX - sx) / s; _dragY += (ev.clientY - sy) / s;
          sx = ev.clientX; sy = ev.clientY;
          if (!_pending) {
            _pending = true;
            _raf = requestAnimationFrame(function () {
              _pending = false;
              img.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
            });
          }
        }
        function onMU() {
          dragging = false;
          if (_raf) { cancelAnimationFrame(_raf); _raf = 0; _pending = false; }
          img.style.transition = '';
        }
        img.addEventListener('mousedown', onMD);
        window.addEventListener('mousemove', onMM);
        window.addEventListener('mouseup', onMU);
        // ── 关闭时清理 ──
        var _origClose = close;
        close = function () {
          window.removeEventListener('mousemove', onMM);
          window.removeEventListener('mouseup', onMU);
          contentEl.style.overflow = '';
          close = _origClose;
          _origClose();
        };
      };
      img.src = e.data.src;
      dpad.style.display = 'block';
    }

    if (e.data.action === 'open-table') {
      try {
        // 强制清理上一轮残留状态（含 close 函数恢复）
        close = _baseClose;
        _stopRepeat();
        overlay.style.display = 'none';
        contentEl.innerHTML = '';
        contentEl.style.overflow = 'hidden';
        zoomScale = 1.0;
        _dragX = 0; _dragY = 0;

        // 内容区可用空间：overlay 尺寸未必可用（display=none），回退到 window 尺寸
        var _availW = Math.max(200, (overlay.clientWidth || window.innerWidth) - 64);
        var _availH = Math.max(150, (overlay.clientHeight || window.innerHeight) - 64 - 64);

        var clipBox = document.createElement('div');
        clipBox.style.cssText =
          'width:' + _availW + 'px; height:' + _availH + 'px; overflow:hidden; ' +
          'display:flex; align-items:center; justify-content:center;';

        var wrapper = document.createElement('div');
        wrapper.className = 'qqq-overlay-table-wrapper';
        var _overlayDark = window.qqqideTheme && window.qqqideTheme.isDark();
        wrapper.style.cssText =
          'background:' + (_overlayDark ? '#2a2a2a' : '#ede4cf') + '; color:var(--text-primary,#dcd8d0); ' +
          'border-radius:8px; padding:20px; user-select:text; ' +
          'box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
          'transform-origin:center center; ' +
          'transition:transform 0.15s ease; display:inline-block;';
        wrapper.innerHTML = e.data.html;

        var tables = wrapper.querySelectorAll('table');
        for (var ti = 0; ti < tables.length; ti++) {
          var tab = tables[ti];
          tab.style.borderCollapse = 'collapse';
          tab.style.fontSize = '13px';
          tab.style.tableLayout = 'auto';
          tab.style.width = 'auto';
        }
        var cells = wrapper.querySelectorAll('th,td');
        for (var ci = 0; ci < cells.length; ci++) {
          var c = cells[ci];
          c.style.border = '1px solid var(--border-color,#333)';
          if (!c.style.padding) c.style.padding = '4px 8px';
          if (!c.style.textAlign || c.style.textAlign === '') c.style.textAlign = 'left';
          c.style.whiteSpace = 'nowrap';
        }
        var ths = wrapper.querySelectorAll('th');
        for (var hi = 0; hi < ths.length; hi++) {
          ths[hi].style.background = 'var(--card-bg,#1e1e1e)';
        }

        // ★ 表格块展开：原样保留 AI 面板渲染结果，不覆盖样式
        // pre/code 保持原 CSS class（如 .lang-xxx），不强制改写换行/断字

        clipBox.appendChild(wrapper);
        contentEl.appendChild(clipBox);

        overlay.style.visibility = 'hidden';
        overlay.style.display = 'block';

        var tables2 = wrapper.querySelectorAll('table');
        for (var t2i = 0; t2i < tables2.length; t2i++) {
          var tb = tables2[t2i];
          var firstRow = tb.querySelector('tr');
          if (firstRow) {
            var colWidths = [];
            var rowCells = firstRow.children;
            for (var rci = 0; rci < rowCells.length; rci++) {
              colWidths.push(rowCells[rci].offsetWidth);
            }
            tb.style.tableLayout = 'fixed';
            tb.style.width = 'auto';
            var colgroup = document.createElement('colgroup');
            for (var cwi = 0; cwi < colWidths.length; cwi++) {
              var col = document.createElement('col');
              col.style.width = colWidths[cwi] + 'px';
              colgroup.appendChild(col);
            }
            if (tb.firstChild) {
              tb.insertBefore(colgroup, tb.firstChild);
            } else {
              tb.appendChild(colgroup);
            }
          }
        }

        var natW = wrapper.scrollWidth, natH = wrapper.scrollHeight;
        // fitZoom: 表格缩放后刚好不超出 clipBox 边界（可能 <1 需缩小，也可能 >1 表格本就小于视口）
        var fitZoom = Math.min(_availW / Math.max(1, natW), _availH / Math.max(1, natH));
        // _initZoom: 重置按钮用 — 取 fitZoom 和 1.0 中较小者（至多原样，不放大）
        _initZoom = Math.min(1, fitZoom);
        // 初始缩放：放大两级（1.25²=1.5625），但绝不超出边界 fitZoom
        zoomScale = Math.min(5.0, _initZoom * 1.5625, fitZoom);
        applyZoom();

        overlay.style.visibility = '';

        clipBox.addEventListener('wheel', function (we) {
          we.preventDefault(); we.stopPropagation();
          if (we.deltaY < 0) { zoomScale = Math.min(5.0, zoomScale * 1.15); }
          else { zoomScale = Math.max(0.25, zoomScale * 0.87); }
          applyZoom();
        }, { passive: false });

        dpad.style.display = 'block';
      } catch (_) {
        // 出错时强制复位，避免 overlay 残留 invisible 阻挡 UI
        overlay.style.display = 'none';
        overlay.style.visibility = '';
        contentEl.innerHTML = '';
        dpad.style.display = 'none';
      }
    }
  });

  // Theme sync
  if (window.qqqideTheme && window.qqqideTheme.onChange) {
    window.qqqideTheme.onChange(function (dark) {
      var wrapper = contentEl.querySelector('div > div') || contentEl.querySelector('div');
      if (wrapper) {
        wrapper.style.background = dark ? '#2a2a2a' : '#ede4cf';
        wrapper.style.color = dark ? '#dcd8d0' : '#656360';
      }
    });
  }
}
