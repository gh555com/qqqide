// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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

  // ── 主题化滚动条（注:style）— 100% 等同 a 窗口（.tier-popup-panel）风格 ──
  var _scrollStyle = document.createElement('style');
  _scrollStyle.textContent =
    '#qqqide-overlay-content ::-webkit-scrollbar{width:5px;height:5px}' +
    '#qqqide-overlay-content ::-webkit-scrollbar-track{background:transparent}' +
    '#qqqide-overlay-content ::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.35);border-radius:3px}' +
    '#qqqide-overlay-content ::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,0.55)}' +
    '#qqqide-overlay-content ::-webkit-scrollbar-corner{background:transparent}' +
    '#qqqide-overlay-content>div::-webkit-scrollbar{display:none}';
  document.head.appendChild(_scrollStyle);

  // ── 链接主题色（2026-08-21：禁蓝色链接——悬浮预览层内 <a> 一律继承前景色，仅保留下划线）──
  var _ovLinkStyle = document.createElement('style');
  _ovLinkStyle.textContent =
    '#qqq-ai-overlay-content a{color:inherit;text-decoration:underline;}' +
    '#qqq-ai-overlay-content a:hover{color:inherit;text-decoration:underline;}' +
    '#qqq-ai-overlay-content a.qqq-path-link{color:inherit;text-decoration:none;cursor:auto}' +
    '#qqq-ai-overlay-content .qqq-path-link.qqq-path-ok{text-decoration:underline dotted;text-underline-offset:2px;cursor:pointer}' +
    '#qqq-ai-overlay-content .qqq-path-link.qqq-path-ok:hover{text-decoration:underline;background:rgba(181,137,0,0.18)}';
  document.head.appendChild(_ovLinkStyle);

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

  // ★ 悬浮预览内路径链接 → Roam 定位（2026-09-06：代码块/表格 View 展开场景，_roamRevealText 同闭包）
  // ★ 2026-09-07 门控：仅已确认存在（面板探针打过 .qqq-path-ok）直接跳；未确认拷贝 → 主窗口直连裁决一次
  contentEl.addEventListener('click', function (e) {
    var _pl = e.target && e.target.closest ? e.target.closest('.qqq-path-link') : null;
    if (!_pl) return;
    e.preventDefault();
    e.stopPropagation();
    var _p = _pl.getAttribute('data-p') || _pl.textContent || '';
    var _c = _pl.getAttribute('data-c') || '';
    if (_pl.classList.contains('qqq-path-ok')) { _roamRevealText(_p, _c); return; }
    _ovProbeThen(_p, _c, _pl, function () { _roamRevealText(_p, _c); });
  });

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
  // ★ 图片本地路径（open-image 消息 localPath 透传；dataUrl 缩略图场景的文件/路径按钮靠它）
  var _ovLocalPath = null;

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

  // Copy button — 固定文字，禁止 i18n 覆写和动画（防按钮变宽→焦点窃取→Ctrl+C 失效）
  var _ovSavedRange = null;  // ★ 保存最后选区，点击复制按钮时选区已被浏览器清掉，用此恢复
  var copyBtnLabel = window._i('shell.overlay.copy', '复制到剪贴板');
  var copyBtn = tbBtn('\uD83D\uDCCB ' + copyBtnLabel, copyBtnLabel);
  // ★ 不设 data-i18n — i18n updateDom 会覆写 textContent 导致按钮变宽→焦点变化→Ctrl+C 截断
  function doCopy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
    function fallbackCopy(t) {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { }
      document.body.removeChild(ta);
    }
  }
  copyBtn.addEventListener('mousedown', function (e) {
    // ★ 在浏览器清掉选区之前，先保存当前 Range（click 事件触发时选区已空）
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
      _ovSavedRange = sel.getRangeAt(0).cloneRange();
    } else {
      _ovSavedRange = null;
    }
  });
  copyBtn.addEventListener('click', function () {
    var sel = window.getSelection();
    var text = sel && sel.toString().trim();
    // 若当前选区已被清空，回退到 mousedown 时保存的 Range
    if (!text && _ovSavedRange) {
      text = _ovSavedRange.toString().trim();
    }
    if (text) {
      doCopy(text);
      // ★ 复制后恢复选区（黄色高亮不丢）
      if (_ovSavedRange) {
        try {
          var s = window.getSelection();
          s.removeAllRanges();
          s.addRange(_ovSavedRange);
        } catch (_) { }
      }
      return;
    }
    // ★ 文本优先 — img.src 仅当无文本内容时兜底（防代码块内含 <img> 时复制 file:// URL）
    var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper') || contentEl.querySelector('div');
    if (wrapper) {
      var txt = wrapper.innerText || wrapper.textContent || '';
      if (txt.trim()) { doCopy(txt); return; }
    }
    var img = contentEl.querySelector('img');
    if (img) { doCopy(img.src); return; }
  });

  // ★ 图片专用三按钮（内存/文件/路径）——仅图片预览显示；表格/代码块隐藏，保持原样
  var memBtn = tbBtn(window._i('shell.overlay.mem', '内存'), window._i('shell.overlay.memTitle', '图片进入内存（剪贴板图像），可直接粘贴到聊天或画布'));
  var fileBtn = tbBtn(window._i('shell.overlay.file', '文件'), window._i('shell.overlay.fileTitle', '复制图片文件，可粘贴到聊天/Roam/资源管理器'));
  var pathBtn = tbBtn(window._i('shell.overlay.path', '路径'), window._i('shell.overlay.pathTitle', '复制图片路径'));

  // 当前 overlay 图片 src（仅图片预览存在 <img>）
  function _currentOverlayImgSrc() {
    var img = contentEl.querySelector('img');
    return img ? img.src : null;
  }
  // src → 本地文件路径：file:/// URL 解码 / 裸盘符路径（A4/徽章/灯箱直传形态）直接收
  function _localPathFromSrc(src) {
    if (typeof src !== 'string') return null;
    if (/^file:\/\//i.test(src)) {
      var p = src.replace(/^file:\/\/\//i, '');
      try { p = decodeURIComponent(p); } catch (_) { }
      return p;
    }
    if (/^[A-Za-z]:[\\/]/.test(src)) return src;
    return null;
  }
  function _ovToast(msg, type) {
    if (window.qqqideQoast) window.qqqideQoast.show(msg, { type: type || 'info', duration: 2500 });
  }

  // 内存 — 图片进剪贴板（图像数据），可直接粘贴到聊天/画布
  memBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) { _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return; }
    var p = _ovLocalPath || _localPathFromSrc(src);
    var payload = p ? { path: p } : (/^data:/i.test(src) ? { dataUrl: src } : null);
    if (!payload || !bridge || !bridge.clipboard || !bridge.clipboard.writeImage) {
      _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeImage(payload).then(function (ok) {
      _ovToast(ok ? window._i('shell.overlay.memOk', '图片已进入内存，可直接粘贴') : window._i('shell.overlay.copyFailed', '复制失败'), ok ? 'success' : 'error');
    }).catch(function () { _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
  });

  // 文件 — 复制图片文件本体（CF_HDROP），可粘贴到聊天/Roam/资源管理器
  fileBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) return;
    var p = _ovLocalPath || _localPathFromSrc(src);
    if (!p) { _ovToast(window._i('shell.overlay.noLocalFile', '该图片无本地文件，无法复制文件'), 'info'); return; }
    if (!bridge || !bridge.clipboard || !bridge.clipboard.writeFiles) {
      _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeFiles([p]).then(function (ok) {
      _ovToast(ok ? window._i('shell.overlay.fileOk', '文件已复制，可直接粘贴') : window._i('shell.overlay.copyFailed', '复制失败'), ok ? 'success' : 'error');
    }).catch(function () { _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
  });

  // 路径 — 复制图片文件路径
  pathBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) return;
    var p = _ovLocalPath || _localPathFromSrc(src);
    if (!p) {
      if (/^data:/i.test(src)) { _ovToast(window._i('shell.overlay.noLocalPath', '该图片无本地路径'), 'info'); return; }
      _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    if (!bridge || !bridge.clipboard || !bridge.clipboard.writeText) {
      _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeText(p).then(function () {
      _ovToast(window._i('shell.overlay.copied', '已复制'), 'success');
    }).catch(function () { _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
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
  toolbar.appendChild(memBtn);
  toolbar.appendChild(fileBtn);
  toolbar.appendChild(pathBtn);
  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(closeBtnEl);

  overlay.appendChild(contentEl);
  overlay.appendChild(toolbar);
  // ★ 挂到 #qqq-main + inset:0 → 悬浮城 = 菜单行 + 中区（含中AI面板）+ 状态栏；
  //    左右翼是 #qqq-main 的兄弟节点（shell-wings _applyWings 通过 main 的 left/right 让位）
  //    → 天然不覆盖翼板，100% 等同历史悬浮城区域
  var _mainEl = document.getElementById('qqq-main');
  (_mainEl || document.body).appendChild(overlay);

  function close() {
    _ovLocalPath = null;
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

  // ★ Ctrl+C：让浏览器原生处理（tabIndex=-1 防焦点窃取已确保原生复制通路畅通）
  //    不设自定义拦截 — preventDefault 会阻断浏览器维持选区，导致黄色高亮消失
  //    Escape 仍然手动处理
  document.addEventListener('keydown', function (e) {
    if (overlay.style.display === 'none') return;
    if (e.key === 'Escape') { close(); return; }
  });

  // ── 选中高亮全文匹配（CSS Highlight API）──
  overlay.addEventListener('mouseup', function (e) {
    if (overlay.style.display === 'none') return;
    if (e.target.closest('#qqq-ai-overlay-toolbar')) return;
    if (e.target.closest('button')) return;
    // ★ 保存当前选区 Range（供复制按钮恢复用）
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
      _ovSavedRange = sel.getRangeAt(0).cloneRange();
    }
    setTimeout(function () {
      if (overlay.style.display === 'none') return;
      var sel2 = window.getSelection();
      var text = sel2 && sel2.toString().trim();
      if (text && text.length >= 1 && text !== _ovLastMatchText) {
        _ovApplyHighlights(text);
      } else if (!text) {
        _ovClearHighlights();
      }
    }, 80);
  });

  overlay.addEventListener('mousedown', function (e) {
    if (overlay.style.display === 'none') return;
    // 工具栏/D-pad 区域不触发高亮清除（否则点复制按钮会消掉选区）
    if (e.target.closest('#qqq-ai-overlay-toolbar')) return;
    if (e.target.closest('button')) return;
    setTimeout(function () {
      if (overlay.style.display === 'none') return;
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
    // ★ roam iframe 命令回执（2026-09-08）：命令已消费即停发。旧实现零确认——首次导航成功后
    //   仍每 300ms 重发满 25 次（7.5s），期间用户任何手动导航都被下一条重发拉回目标目录 = 硬控。
    //   独立 type 分支必须先于 qqqide-overlay 过滤（ack 消息走 roam 自身 type）
    if (e.data && e.data.type === 'qqq-roam-cmd-ack') {
      if (_roamCmdTimer && e.data.reqId && String(e.data.reqId) === String(_roamCmdToken)) {
        clearInterval(_roamCmdTimer);
        _roamCmdTimer = null;
      }
      return;
    }
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
      _ovLocalPath = e.data.localPath || null;
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
        // 内容区可用空间：overlay = 悬浮城（菜单+中区含中AI+状态栏，不含左右翼），扣除工具栏 64px + 内边距 32px×2
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
      // ★ 图片模式：三按钮（内存/文件/路径），复制按钮隐藏
      copyBtn.style.display = 'none';
      memBtn.style.display = '';
      fileBtn.style.display = '';
      pathBtn.style.display = '';
    }

    if (e.data.action === 'open-table') {
      _ovLocalPath = null;
      try {
        // 强制清理上一轮残留状态（含 close 函数恢复）
        close = _baseClose;
        _stopRepeat();
        overlay.style.display = 'none';
        contentEl.innerHTML = '';
        contentEl.style.overflow = 'hidden';
        zoomScale = 1.0;
        _dragX = 0; _dragY = 0;

        // ★ 先让 overlay 布局生效再测可用空间：display:none 时 clientWidth=0，
        //   旧代码回退 window.innerWidth = 全窗口宽（含左右翼）→ clipBox 按错误宽度
        //   创建 → fitZoom 偏大 → 自动放大两级后超出真实悬浮城边界（小分辨率+翼开必现）
        //   overlay 挂 #qqq-main → clientWidth 即悬浮城宽（菜单+中区含中AI+状态栏，不含左右翼）
        overlay.style.visibility = 'hidden';
        overlay.style.display = 'block';
        var _availW = Math.max(200, overlay.clientWidth - 64);
        var _availH = Math.max(150, overlay.clientHeight - 64 - 64);

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
          if (!c.style.whiteSpace || c.style.whiteSpace === '') c.style.whiteSpace = 'nowrap';
        }
        var ths = wrapper.querySelectorAll('th');
        for (var hi = 0; hi < ths.length; hi++) {
          ths[hi].style.background = 'var(--card-bg,#1e1e1e)';
        }

        // ★ 表格块展开：原样保留 AI 面板渲染结果，不覆盖样式
        // pre/code 保持原 CSS class（如 .lang-xxx），不强制改写换行/断字

        clipBox.appendChild(wrapper);
        contentEl.appendChild(clipBox);

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
        // ★ 表格/代码块模式：复制按钮原样，三按钮隐藏
        copyBtn.style.display = '';
        memBtn.style.display = 'none';
        fileBtn.style.display = 'none';
        pathBtn.style.display = 'none';
      } catch (_) {
        // 出错时强制复位，避免 overlay 残留 invisible 阻挡 UI
        overlay.style.display = 'none';
        overlay.style.visibility = '';
        contentEl.innerHTML = '';
        dpad.style.display = 'none';
      }
    }

    // ★ AI 面板图片 hover「Roam」按钮：激活 roam tab + 聚焦 + 跳到目录选中文件
    if (e.data.action === 'reveal-in-roam') {
      if (typeof e.data.src === 'string' && /^file:\/\//i.test(e.data.src)) _roamRevealText(e.data.src, '');
      else _roamQoast('该图片无本地文件，无法在 Roam 定位');
      return;
    }
    // ★ 本地路径存在性探针（2026-09-07）：AI 面板权威渲染后批量确认，存在才允许显示为链接
    if (e.data.action === 'lpl-probe') {
      _lplHandleProbe(e);
      return;
    }
    // ★ AI 回复本地路径链接：Roam 定位目录/文件（2026-09-06）
    if (e.data.action === 'roam-reveal-path') {
      _roamRevealText(e.data.text || '', e.data.ctx || '');
      return;
    }
  });

  // ═══ Roam 定位引擎（2026-09-06 泛化）：任意本地路径 → 激活 roam + 跳转/选中 ═══
  // 支持：盘符绝对 / 相对路径（依 AI 视口阵营逐根解析，主文件夹优先）/ 树图裸文件名（ctx 拼接）
  // 边界兜底：不存在/已删除 → 爬升最近存在祖先 + toast，绝不静默死链；
  //           roam tab/iframe 未就绪 → 自建 tab + 轮询重发（7.5s 上限）。
  function _roamQoast(msg) {
    try {
      if (window.qqqideQoast && window.qqqideQoast.show) window.qqqideQoast.show(msg, { type: 'info', duration: 3500 });
    } catch (_) { }
  }
  function _roamFs() { try { return window.qqqideBridge && window.qqqideBridge.fs; } catch (_) { return null; } }
  function _roamStat(p) {
    var fs = _roamFs();
    if (!fs || !fs.stat) return Promise.resolve(null);
    return fs.stat(p).catch(function () { return null; });
  }
  function _roamRoots() {
    var out = [];
    try {
      var vp = window.qqqideViewport;
      var ps = vp && vp.getProjects ? vp.getProjects() : null;
      if (ps) {
        for (var i = 0; i < ps.length; i++) {
          if (ps[i] && ps[i].path) out.push(String(ps[i].path).replace(/\\/g, '/').replace(/\/+$/, ''));
        }
      }
    } catch (_) { }
    return out;
  }
  function _roamJoin(base, rel) {
    var b = String(base || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var r = String(rel || '').replace(/\\/g, '/');
    while (r.indexOf('./') === 0) r = r.slice(2);
    return b + '/' + r;
  }
  function _roamParent(p) {
    var s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var i = s.lastIndexOf('/');
    if (i <= 0) return /^[A-Za-z]:$/.test(s) ? s + '/' : null;
    return s.slice(0, i);
  }
  function _roamShort(p) {
    var s = String(p || '');
    return s.length > 52 ? '…' + s.slice(s.length - 51) : s;
  }
  // 逐级上爬：返回第一个仍存在滴祖先（含自身）
  async function _roamClimb(p) {
    var cur = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!cur) return null;
    var fs = _roamFs();
    if (!fs) return null;
    for (var guard = 0; guard < 80 && cur; guard++) {
      // 盘根歧义兜底：fs.stat('E:') 语义=E盘cwd，必须带尾斜杠才等价盘根
      if (/^[A-Za-z]:$/.test(cur)) cur = cur + '/';
      var st = await fs.stat(cur).catch(function () { return null; });
      if (st) return { path: cur, isDir: !!st.isDir };
      var nx = _roamParent(cur);
      if (!nx || nx === cur) return null;
      cur = nx;
    }
    return null;
  }
  // 激活 roam tab（缺则硬建）+ 轮询向 iframe 发命令
  function _roamEnsureTab() {
    try {
      var gaeaGrp = window.qqqTabs && window.qqqTabs.getGaeaGroup ? window.qqqTabs.getGaeaGroup() : null;
      if (!gaeaGrp) return false;
      var roamTab = gaeaGrp.tabs.find(function (t) { return t.gaeaId === 'roam'; });
      if (!roamTab && window.qqqTabs.addGaeaTab) {
        try {
          window.qqqTabs.addGaeaTab('roam', 'Roam', function (pane) {
            pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
            var iframe = document.createElement('iframe');
            iframe.src = '/qqqide/goods/file-explorer/q2-roam.html';
            iframe.style.cssText = 'width:100%; height:100%; border:none;';
            iframe.setAttribute('frameborder', '0');
            pane.appendChild(iframe);
          }, { closable: false });
          roamTab = gaeaGrp.tabs.find(function (t) { return t.gaeaId === 'roam'; });
        } catch (_) { }
      }
      if (roamTab && window.qqqTabs.activateTab) {
        try { window.qqqTabs.activateTab(gaeaGrp, roamTab.id); } catch (_) { }
      }
      return !!roamTab;
    } catch (_) { return false; }
  }
  // Roam 命令单飞发送器（2026-09-08 ack 回路）：命令带 reqId，iframe 消费后回执 → 立即停发。
  // 单飞 = 新命令先清旧发送器（快速连点两个链接时旧命令不得继续把用户拉来拉去）；
  // 25 次/7.5s 仅作 iframe 未就绪（懒加载/重建）兜底，正常路径 ~300ms 内 ack 即停，零硬控。
  var _roamCmdTimer = null, _roamCmdToken = 0;
  function _roamSendCmd(cmd, path) {
    if (!path) return;
    if (_roamCmdTimer) { clearInterval(_roamCmdTimer); _roamCmdTimer = null; }
    _roamEnsureTab();
    var token = ++_roamCmdToken;
    var sent = 0;
    var wasNull = true;
    var timer = setInterval(function () {
      var it = document.querySelector('iframe[src*="q2-roam"]');
      if (it && it.contentWindow) {
        try {
          // iframe 首次出现才抢焦点——旧实现每 300ms focus 一次，7.5s 内反复抢焦点同样在硬控用户
          if (wasNull) { try { it.contentWindow.focus(); } catch (_) { } wasNull = false; }
          it.contentWindow.postMessage({ type: 'qqq-roam-cmd', cmd: cmd, path: path, reqId: token }, '*');
        } catch (_) { }
      }
      sent++;
      if (sent >= 25 || _roamCmdToken !== token) {   // 达上限 / 被新命令顶替 → 自清
        clearInterval(timer);
        if (_roamCmdTimer === timer) _roamCmdTimer = null;
      }
    }, 300);
    _roamCmdTimer = timer;
  }
  function _roamRevealHit(path, st) {
    if (st && st.isDir) _roamSendCmd('roam.navTo', path);
    else _roamSendCmd('roam.revealFile', path);
  }
  // ═══ 命中裁决（2026-09-07 共享）：点击定位与存在性探针同一裁决，零双写漂移 ═══
  // 返回 { hit:{path,isDir} | null, first:爬升基准, err:fs 不可用 }；只做①直接候选 ②ctx 裸名拼接，不爬升。
  async function _roamResolveHits(text, ctx) {
    var fs = _roamFs();
    if (!fs || !fs.stat) return { hit: null, first: null, err: true };
    var t = String(text || '').trim();
    var wasFileUrl = /^file:\/\/\//i.test(t);
    if (wasFileUrl) {
      t = t.replace(/^file:\/\/\//i, '');
      try { t = decodeURIComponent(t); } catch (_) { }
    }
    t = t.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!t) return { hit: null, first: null, err: false };
    var isAbs = /^[A-Za-z]:\//.test(t);
    var roots = _roamRoots();
    var hasSep = t.indexOf('/') !== -1;
    // ① 直接候选：绝对原样；相对逐根拼接（主文件夹优先）
    var direct = [];
    if (isAbs) {
      direct.push(t.length === 2 ? t + '/' : t);
    } else if (hasSep) {
      if (!roots.length) direct.push(t);
      for (var ri = 0; ri < roots.length; ri++) direct.push(_roamJoin(roots[ri], t));
    }
    var fallback = direct[0] || (isAbs ? t : (roots.length ? _roamJoin(roots[0], t) : t));
    for (var di = 0; di < direct.length; di++) {
      var stD = await fs.stat(direct[di]).catch(function () { return null; });
      if (stD) return { hit: { path: direct[di], isDir: !!stD.isDir }, first: fallback, err: false };
    }
    // ② 裸文件名 + ctx：先解析 ctx 锚点（绝对或逐根），文件取父目录，再拼名
    if (!hasSep && !isAbs && ctx) {
      var c = String(ctx).replace(/\\/g, '/').replace(/\/+$/, '');
      var cAbs = /^[A-Za-z]:\//.test(c);
      var cbases = cAbs ? [c] : [];
      if (!cAbs) for (var ci = 0; ci < roots.length; ci++) cbases.push(_roamJoin(roots[ci], c));
      for (var cbi = 0; cbi < cbases.length; cbi++) {
        var stC = await fs.stat(cbases[cbi]).catch(function () { return null; });
        if (!stC) continue;
        var dirC = stC.isDir ? cbases[cbi] : _roamParent(cbases[cbi]);
        if (!dirC) continue;
        var leaf = _roamJoin(dirC, t);
        var stL = await fs.stat(leaf).catch(function () { return null; });
        if (stL) return { hit: { path: leaf, isDir: !!stL.isDir }, first: fallback, err: false };
      }
    }
    return { hit: null, first: fallback, err: false };
  }
  // 唯一入口：text=候选路径原文，ctx=树图上文目录（可选）——命中直达；未命中爬升最近祖先，杜绝死链
  async function _roamRevealText(text, ctx) {
    var r = await _roamResolveHits(text, ctx);
    if (r.err) { _roamQoast('Roam 定位暂不可用，请稍后再试'); return; }
    var orig = String(text || '').trim();
    if (!r.first) { _roamQoast('该路径无本地文件，无法在 Roam 定位'); return; }
    if (r.hit) { _roamRevealHit(r.hit.path, { isDir: r.hit.isDir }); return; }
    var near = await _roamClimb(r.first);
    if (near) {
      _roamQoast('路径已不存在（可能被移动/删除）：' + _roamShort(orig) + ' → 已定位到最近目录 ' + _roamShort(near.path));
      _roamSendCmd('roam.navTo', near.path);
    } else {
      _roamQoast('未在磁盘上找到：' + _roamShort(orig));
    }
  }
  // ★ 全局入口（2026-09-11）：timeline diff 窗口 op 菜单「Roam」→ 主进程 executeJavaScript 调用。
  //   与 AI 面板本地链接点击共用同一台机器（_roamRevealText），差异仅在消息入口：
  //   面板走 postMessage(roam-reveal-path)，diff 窗口走 IPC → 此函数。
  window.__qqq_roamRevealPath = function (text, ctx) {
    try { _roamRevealText(text, ctx || ''); } catch (_) { }
  };

  // ═══ 存在性探针裁决（2026-09-07）：面板批量确认 + 悬浮预览拷贝兜底共用 ═══
  var _lplOvCache = new Map();   // 主窗口侧会话缓存（key=p+ctx → true/false，FIFO 上限 3000）
  function _lplOvSet(key, ok) {
    _lplOvCache.set(key, ok);
    if (_lplOvCache.size > 3000) {
      var it = _lplOvCache.keys().next();
      if (!it.done) _lplOvCache.delete(it.value);
    }
  }
  async function _lplOvCheck(p, c) {
    var key = String(c || '') + '\u0001' + String(p || '');
    var st = _lplOvCache.get(key);
    if (st !== undefined) return !!st;
    var ok = false;
    try { var r = await _roamResolveHits(p, c); ok = !!(r && r.hit); } catch (_) { ok = false; }
    _lplOvSet(key, ok);
    return ok;
  }
  // AI 面板 lpl-probe：逐条裁决（顺序 await 防 stat 风暴），结果回传发起方 iframe
  async function _lplHandleProbe(e) {
    var items = (e.data && Array.isArray(e.data.items)) ? e.data.items.slice(0, 900) : [];
    var results = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var p = String(it.p || '');
      var c = String(it.c || '');
      var ok = false;
      try { ok = await _lplOvCheck(p, c); } catch (_) { ok = false; }
      results.push({ p: p, c: c, ok: ok });
    }
    try {
      if (e.source && e.source.postMessage) {
        e.source.postMessage({ type: 'qqq-lpl-probe-result', reqId: e.data.reqId || '', results: results }, '*');
      }
    } catch (_) { }
  }
  // 悬浮预览内未确认拷贝链接：主窗口直连裁决——存在则激活并跳转，不存在解除为纯文本
  async function _ovProbeThen(p, c, el, onOk) {
    var ok = false;
    try { ok = await _lplOvCheck(p, c); } catch (_) { ok = false; }
    if (!el.isConnected) return;
    if (ok) {
      el.classList.add('qqq-path-ok');
      if (!el.title) el.title = '在 Roam 中打开';
      if (onOk) onOk();
    } else {
      try {
        var tn = el.ownerDocument.createTextNode(el.textContent || '');
        if (el.parentNode) el.parentNode.replaceChild(tn, el);
      } catch (_) { }
    }
  }

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
