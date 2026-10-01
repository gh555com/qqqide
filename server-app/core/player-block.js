// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// player-block.js — 状态栏播放器豆腐块（qd 播放器遥控中心 · 2026-10-01 q319 用户定案）
//   定位：窗内播放器卡（core/player-card.js）会话的遥控中心——qqq 工作台 Player 行整体废除后的唯一替代面。
//   形态：状态栏固定宽按钮（♪/播放态均衡条 + n/N，恒 64px——对齐 wq 豆腐块节奏）+ hover 上弹播放控制卡
//         （对齐 wq 卡片交互：hover 即弹 / 点击钉住 / 点卡片外（含 iframe 内）关闭 / Esc 关闭；
//          窄窗 dense-3 随 wq 同退避隐藏）。
//   卡片内容（2026-10-01 用户定案：文字最小化——状态行已删）：轨名/计数 + [⏮][⏯][⏭] + [⤢ 展开][✕ 关闭]。
//   数据源双路（路由 = 收纳的悬浮层优先；双开罕见态播放中者优先）：
//       ① 窗内卡 window.qqqPlayerCard（getInfo/cmd/stow/close）② 悬浮层收纳窗 window.qqqOverlayStow（active/info/cmd/restore/closeSession）
//   'qqq-player-state' 事件两源共用。独立播放器窗自带界面，不在本块范围（其 [—] 收进状态栏 = 整机交接进卡收纳态）。
//   禁独立悬浮迷你条；禁回退 qqq 工作台槽位（用户定案 2026-10-01）。
// ============================================================================
(function () {
  'use strict';

  var _$el = null;
  var _card = null;
  var _shown = false;
  var _pinned = false;
  var _hideTimer = null;
  var _wired = false;

  // ── 图标（内联 SVG；preseed + display 切槽——禁 innerHTML 换节点，防吞点击）──
  var _V = {
    note: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:block;pointer-events:none"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
    prev: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:block;pointer-events:none"><path d="M6 6h2v12H6z"/><path d="M9.5 12l8.5 6V6z"/></svg>',
    next: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:block;pointer-events:none"><path d="M16 6h2v12h-2z"/><path d="M6 6l8.5 6L6 18z"/></svg>',
    play: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:block;pointer-events:none"><path d="M8 5v14l11-7z"/></svg>',
    tri: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="display:block;pointer-events:none"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:block;pointer-events:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
    expand: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:block;pointer-events:none"><path d="M21 11V3h-8v2h4.59L12 10.59l1.41 1.41L19 6.41V11h2zM3 13v8h8v-2H6.41L12 13.41l-1.41-1.41L5 17.59V13H3z"/></svg>',
    close: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:block;pointer-events:none"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
  };

  // ── i18n 助手（翻译 + 回退；同 shell-statusbar 模式）──
  function _T(k, fb, p) {
    var v = null;
    try { if (window.i18n && window.i18n.t) { var r = window.i18n.t(k, p); if (r && r !== k) v = r; } } catch (e) { }
    if (v === null) {
      v = fb;
      if (p) { for (var x in p) v = v.split('{' + x + '}').join(String(p[x])); }
    }
    return v;
  }

  // ── 数据源（窗内播放器卡；独立播放器窗自带界面不在本块范围）──
  function _pc() { try { return window.qqqPlayerCard || null; } catch (e) { return null; } }
  function _info() {
    try { var m = _pc(); return (m && m.getInfo) ? m.getInfo() : null; } catch (e) { return null; }
  }
  // ── 悬浮层收纳态（window.qqqOverlayStow；shell-overlay.js 提供——仅收纳时 active）──
  function _ovR() { try { return window.qqqOverlayStow || null; } catch (e) { return null; } }
  function _ovInfo() {
    try { var r = _ovR(); if (r && r.active && r.active()) { return r.info(); } } catch (e) { }
    return null;
  }
  // 路由 = 收纳悬浮层优先；双开（罕见）时播放中者优先
  function _target() {
    var ov = _ovInfo();
    var cd = _info();
    var ovOn = !!(ov && ov.open);
    var cdOn = !!(cd && cd.open);
    if (ovOn && cdOn) { return (ov.paused && !cd.paused) ? { k: 'card', inf: cd } : { k: 'ov', inf: ov }; }
    if (ovOn) { return { k: 'ov', inf: ov }; }
    return { k: 'card', inf: cd };
  }
  function _cmd(a) {
    try {
      if (_target().k === 'ov') { var r = _ovR(); if (r && r.cmd) { r.cmd(a); } return; }
      var m = _pc(); if (m && m.cmd) { m.cmd(a); }
    } catch (e) { }
  }
  function _stowExpand() {
    try {
      if (_target().k === 'ov') { var r = _ovR(); if (r && r.restore) { r.restore(); } return; }
      var m = _pc(); if (m && m.stow) { m.stow(false); }
    } catch (e) { }
  }
  function _closeSession() {
    try {
      if (_target().k === 'ov') { var r = _ovR(); if (r && r.closeSession) { r.closeSession(); } return; }
      var m = _pc(); if (m && m.close) { m.close(); }
    } catch (e) { }
  }

  // ═══ 状态栏按钮 ═══
  function _render() {
    if (!_$el) { return; }
    var inf = _target().inf;
    var active = !!(inf && inf.open);
    var playing = active && !inf.paused;
    _$el.classList.remove('qqq-pl-dim', 'qqq-pl-paused', 'qqq-pl-playing');
    _$el.classList.add(!active ? 'qqq-pl-dim' : (playing ? 'qqq-pl-playing' : 'qqq-pl-paused'));
    var valEl = _$el.querySelector('.qqq-pl-val');
    if (valEl) {
      valEl.textContent = active ? ((inf.total > 1) ? ((inf.index + 1) + '/' + inf.total) : '') : '--';
    }
    if (_shown) { _renderCard(); }
  }

  // ═══ 卡片（懒构建一次）═══
  function _ensureCard() {
    if (_card) { return; }
    _card = document.createElement('div');
    _card.className = 'qqq-pl-hover';
    _card.innerHTML =
      '<div class="qqq-pl-hover-head">' +
        '<span class="qqq-pl-hover-title"><i class="qqq-pl-hover-dot"></i>' + _T('shell.player.title', '播放器') + '</span>' +
        '<span class="qqq-pl-hover-cnt"></span>' +
      '</div>' +
      '<div class="qqq-pl-hover-name"></div>' +
      '<div class="qqq-pl-hover-ctl">' +
        '<button type="button" class="qqq-pl-cbtn qqq-pl-prev" data-no-cd></button>' +
        '<button type="button" class="qqq-pl-cbtn qqq-pl-toggle" data-no-cd></button>' +
        '<button type="button" class="qqq-pl-cbtn qqq-pl-next" data-no-cd></button>' +
        '<span class="qqq-pl-ctl-gap"></span>' +
        '<button type="button" class="qqq-pl-cbtn qqq-pl-expand" data-no-cd></button>' +
        '<button type="button" class="qqq-pl-cbtn qqq-pl-close" data-no-cd></button>' +
      '</div>';
    document.body.appendChild(_card);

    var bPrev = _card.querySelector('.qqq-pl-prev');
    var bNext = _card.querySelector('.qqq-pl-next');
    var bTg = _card.querySelector('.qqq-pl-toggle');
    var bExp = _card.querySelector('.qqq-pl-expand');
    var bCls = _card.querySelector('.qqq-pl-close');
    bPrev.innerHTML = _V.prev; bPrev.title = _T('shell.overlay.mprev', '上一个');
    bNext.innerHTML = _V.next; bNext.title = _T('shell.overlay.mnext', '下一个');
    bTg.innerHTML = '<span class="qqq-pl-ic0">' + _V.pause + '</span><span class="qqq-pl-ic1" style="display:none">' + _V.play + '</span>';
    bExp.innerHTML = _V.expand; bExp.title = _T('shell.player.restore', '展开播放器');
    bCls.innerHTML = _V.close; bCls.title = _T('common.close', '关闭');

    bPrev.addEventListener('click', function () { _cmd('prev'); _render(); });
    bTg.addEventListener('click', function () { _cmd('toggle'); _render(); });
    bNext.addEventListener('click', function () { _cmd('next'); _render(); });
    bExp.addEventListener('click', function () { _stowExpand(); _render(); });
    bCls.addEventListener('click', function () { _closeSession(); closeCard(); });

    // 卡片内点击不冒泡（防触 document 外部点击判定）
    _card.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function _setIcon(btn, idx) {
    if (!btn) { return; }
    var kids = btn.children;
    for (var i = 0; i < kids.length; i++) {
      try { kids[i].style.display = (i === idx) ? '' : 'none'; } catch (e) { }
    }
  }

  function _renderCard() {
    if (!_card) { return; }
    var inf = _target().inf;
    var active = !!(inf && inf.open);
    var $name = _card.querySelector('.qqq-pl-hover-name');
    var $cnt = _card.querySelector('.qqq-pl-hover-cnt');
    var $ctl = _card.querySelector('.qqq-pl-hover-ctl');
    var $prev = _card.querySelector('.qqq-pl-prev');
    var $next = _card.querySelector('.qqq-pl-next');
    var $tg = _card.querySelector('.qqq-pl-toggle');
    if (!active) {
      $name.textContent = _T('shell.player.blockEmpty', '暂无播放会话');
      $cnt.textContent = '';
      $ctl.style.display = 'none';
      return;
    }
    $ctl.style.display = '';
    $cnt.textContent = (inf.total > 1) ? ((inf.index + 1) + '/' + inf.total) : '';
    $name.textContent = inf.name || '';
    $prev.disabled = inf.total < 2;
    $next.disabled = inf.total < 2;
    $tg.disabled = !inf.total;
    _setIcon($tg, inf.paused ? 1 : 0);   // 0=暂停图标(在播) / 1=播放图标
    $tg.title = inf.paused ? _T('shell.overlay.mplay', '播放') : _T('shell.overlay.mpause', '暂停');
  }

  // ═══ 卡片定位 / 显隐（对齐 wq 卡：恒上弹不遮状态区）═══
  function position() {
    if (!_card || !_$el) { return; }
    var r = _$el.getBoundingClientRect();
    var w = _card.offsetWidth || 252;
    var h = _card.offsetHeight || 150;
    var x = r.right - w + 4;
    if (x < 4) { x = 4; }
    var y = r.top - h - 10;
    if (y < 4) { y = 4; }
    _card.style.left = x + 'px';
    _card.style.top = y + 'px';
  }

  function show() {
    if (!_shown) {
      _ensureCard();
      if (_$el.offsetParent === null) { return; }   // dense 退避隐藏中不弹
      _renderCard();
      position();
      _card.classList.add('qqq-pl-hover-show');
      _shown = true;
    } else {
      position();
    }
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  }

  function hide() {
    if (_pinned) { return; }
    if (!_shown) { return; }
    _card.classList.remove('qqq-pl-hover-show');
    _shown = false;
  }

  function hideSoon() {
    if (_pinned) { return; }
    if (_hideTimer) { clearTimeout(_hideTimer); }
    _hideTimer = setTimeout(hide, 350);
  }

  function closeCard() {
    _pinned = false;
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    if (_card) { _card.classList.remove('qqq-pl-hover-pinned'); _card.classList.remove('qqq-pl-hover-show'); }
    _shown = false;
  }

  // ═══ 交互接线（一次）═══
  function _wire() {
    if (_wired) { return; }
    _wired = true;

    // 点卡片外任何区域 = 关闭（取消固定 + 立即隐藏）；卡片内 / 按钮自身除外
    function closeByOutsideClick() {
      if (!_shown) { return; }
      closeCard();
    }
    document.addEventListener('click', function (e) {
      if (!_shown) { return; }
      var t = e.target;
      if (_card && _card.contains(t)) { return; }
      if (_$el && (t === _$el || _$el.contains(t))) { return; }
      closeByOutsideClick();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _shown) { closeByOutsideClick(); }
    });

    // 三面板/编辑器/goods/roam 均为独立 iframe document，主窗口 document click 收不到
    // iframe 内部点击 → 逐 iframe 绑定（同 MEM/wq 卡机制，标记挂 document 防重复）
    function bindFrameClick(f) {
      var doc;
      try { doc = f.contentDocument; } catch (err) { return; } // 跨域尽力而为
      if (!doc || doc.__qqqPlBound) { return; }
      doc.__qqqPlBound = true;
      doc.addEventListener('click', closeByOutsideClick, true);
    }
    function hookFrames() {
      var fs = document.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i];
        if (!f.__qqqPlLoadHooked) {
          f.__qqqPlLoadHooked = true;
          f.addEventListener('load', function () { bindFrameClick(this); });
        }
        bindFrameClick(f);
      }
    }
    hookFrames();
    if (document.body && typeof MutationObserver !== 'undefined') {
      new MutationObserver(hookFrames).observe(document.body, { childList: true, subtree: true });
    }

    // 窗口 resize 跟随定位
    window.addEventListener('resize', function () { if (_shown) { position(); } });

    // dense 退避隐藏按钮 → 卡片同步消失；恢复时重新定位
    var area = document.querySelector('.qqq-status-area');
    if (area && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () {
        if (!_shown) { return; }
        if (_$el.offsetParent === null) { closeCard(); }
        else { position(); }
      }).observe(area, { attributes: true, attributeFilter: ['class'] });
    }

    // 语言切换 → 卡片静态文案（构建期烧字）销毁重建，开着的保留开状态
    window.addEventListener('qqq-lang-change', function () {
      var wasShown = _shown;
      var wasPinned = _pinned;
      if (_card && _card.parentNode) { _card.parentNode.removeChild(_card); }
      _card = null;
      if (wasShown) {
        _ensureCard();
        _pinned = wasPinned;
        if (_pinned) { _card.classList.add('qqq-pl-hover-pinned'); }
        _card.classList.add('qqq-pl-hover-show');
        _renderCard();
        position();
      }
    });
  }

  // ═══ 状态栏注入 ═══
  function injectStatusBar() {
    if (_$el) { return; }
    _$el = document.getElementById('qqq-status-player');
    if (!_$el) {
      setTimeout(injectStatusBar, 500);   // HTML 未就绪（异常）→ 重试
      return;
    }
    _$el.classList.add('qqq-pl-btn');
    _$el.innerHTML =
      '<span class="qqq-pl-ico qqq-pl-note">' + _V.note + '</span>' +
      '<span class="qqq-pl-ico qqq-pl-tri">' + _V.tri + '</span>' +
      '<span class="qqq-pl-val">--</span>';

    // 交互：hover 弹卡 / 点击钉住 / 点外关闭（对齐 wq 卡）
    _$el.addEventListener('mouseenter', show);
    _$el.addEventListener('mouseleave', hideSoon);
    _$el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!_pinned) {
        _pinned = true;
        _ensureCard();
        _card.classList.add('qqq-pl-hover-pinned');
        show();
      } else {
        closeCard();
      }
    });

    _wire();
    _render();
  }

  // 状态变化（player-card 广播）→ 实时刷新；启动恢复（card.open 异步）→ 定时兜底重取
  window.addEventListener('qqq-player-state', function () { _render(); });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(injectStatusBar, 300);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(injectStatusBar, 300);
    });
  }
  try { setTimeout(_render, 1200); setTimeout(_render, 2600); } catch (_) { }

  window.qqqPlayerBlock = { render: _render, close: closeCard };
})();
