// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ui-zoom.js — 应用级界面缩放机器（qqq-prefs 'uiZoom' → 壳层 webContents zoom）
//
// 三路输入（统一收敛到 qqq-prefs / 壳层）：
//   ① 右上角设置面板「界面缩放」行（qqqSettings.set 桥 → qqqPrefs.set）→ onChange → 壳层热应用
//   ② 状态栏缩放徽章（本文件；恒显，非 100% 高亮；点击弹八档点选）→ qqqPrefs.set → 同上
//   ③ 应急快捷键 Ctrl+= / Ctrl+- / Ctrl+0（壳层主进程直控）→ bridge.uiZoom.onChanged
//      → 回写 qqq-prefs 内存（保设置面板一致 + 云同步标记）+ 发起窗口 toast
// 渲染：徽章 + 弹层（八档与 qqq-prefs 'uiZoom' enum 严格同值——两处同改）。
// 依赖：qqq-prefs.js（先行加载）。
// ============================================================================

(function () {
  'use strict';

  var LADDER = [80, 90, 100, 110, 125, 150, 175, 200];

  function _resetKey() {
    try { return /Mac/i.test(navigator.platform || '') ? '⌘+0' : 'Ctrl+0'; } catch (e) { return 'Ctrl+0'; }
  }

  function _toast(pct) {
    try {
      var key = _resetKey();
      var msg = window._i
        ? window._i('uiZoom.toast', '界面缩放 {p}%（{k} 复位）', { p: pct, k: key })
        : ('界面缩放 ' + pct + '%（' + key + ' 复位）');
      if (window.qqqideQoast && window.qqqideQoast.show) {
        window.qqqideQoast.show(msg, { duration: 3200, type: 'info' });
      }
    } catch (e) { /* ignore */ }
  }

  function _curPct() {
    try {
      var P = window.qqqPrefs;
      var v = (P && P.get) ? parseInt(P.get('uiZoom'), 10) : 100;
      return isFinite(v) ? v : 100;
    } catch (e) { return 100; }
  }

  function _push() {
    try {
      var pct = _curPct();
      var b = window.qqqideBridge;
      if (b && b.uiZoom && b.uiZoom.set) { b.uiZoom.set(pct); }
      _refreshBadge(pct);
    } catch (e) { /* ignore */ }
  }

  // ═══ 状态栏徽章（恒显按钮；非 100% 高亮）═══
  var _badge = null;

  function _ensureBadge() {
    if (_badge) { return; }
    var anchor = document.getElementById('qqq-status-online');
    if (!anchor || !anchor.parentNode) { return; }
    _badge = document.createElement('span');
    _badge.className = 'qqq-status-item qqq-zoom-badge';
    _badge.id = 'qqq-status-zoom';
    _badge.textContent = '100%';
    _badge.setAttribute('data-i18n-title', 'uiZoom.tip');
    _badge.title = (window._i ? window._i('uiZoom.tip', '调整界面缩放') : '调整界面缩放');
    _badge.addEventListener('click', function (e) {
      if (e && e.stopPropagation) { e.stopPropagation(); }
      _togglePop();
    });
    anchor.parentNode.insertBefore(_badge, anchor.nextSibling);
    _refreshBadge(_curPct());
  }

  function _refreshBadge(pct) {
    if (!_badge) { return; }
    var txt = pct + '%';
    if (_badge.textContent !== txt) { _badge.textContent = txt; }
    if (pct === 100) { _badge.classList.remove('qqq-zoom-hot'); }
    else { _badge.classList.add('qqq-zoom-hot'); }
    if (_pop && _pop.classList.contains('qqq-zoom-open')) { _paintPop(pct); }
  }

  // ═══ 弹层（八档点选；向上弹；点外面 / Esc / 失焦关）═══
  var _pop = null, _popWired = false;

  function _ensurePop() {
    if (_pop) { return; }
    _pop = document.createElement('div');
    _pop.className = 'qqq-zoom-pop';
    for (var i = 0; i < LADDER.length; i++) {
      (function (pct) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qqq-zoom-opt';
        btn.setAttribute('data-pct', String(pct));
        btn.textContent = pct + '%';
        btn.addEventListener('click', function () { _apply(pct); });
        _pop.appendChild(btn);
      })(LADDER[i]);
    }
    document.body.appendChild(_pop);
    if (!_popWired) {
      _popWired = true;
      document.addEventListener('mousedown', function (e) {
        if (!_pop || !_pop.classList.contains('qqq-zoom-open')) { return; }
        var t = e.target;
        if (_pop.contains(t)) { return; }
        if (_badge && (_badge === t || _badge.contains(t))) { return; }
        _closePop();
      }, true);
      document.addEventListener('keydown', function (e) {
        if (!_pop || !_pop.classList.contains('qqq-zoom-open')) { return; }
        if (e.key !== 'Escape') { return; }
        e.stopPropagation();
        _closePop();
      }, true);
      window.addEventListener('blur', function () { _closePop(); });
      window.addEventListener('resize', function () { if (_pop && _pop.classList.contains('qqq-zoom-open')) { _positionPop(); } });
    }
  }

  function _paintPop(pct) {
    var opts = _pop.querySelectorAll('.qqq-zoom-opt');
    for (var i = 0; i < opts.length; i++) {
      if (parseInt(opts[i].getAttribute('data-pct'), 10) === pct) { opts[i].classList.add('qqq-zoom-cur'); }
      else { opts[i].classList.remove('qqq-zoom-cur'); }
    }
  }

  function _positionPop() {
    if (!_badge || !_pop) { return; }
    var r = _badge.getBoundingClientRect();
    var pw = _pop.offsetWidth, ph = _pop.offsetHeight;
    var left = r.left;
    var maxL = window.innerWidth - pw - 8;
    if (left > maxL) { left = maxL; }
    if (left < 8) { left = 8; }
    _pop.style.left = Math.round(left) + 'px';
    _pop.style.top = Math.round(r.top - ph - 6) + 'px';
  }

  function _openPop() {
    _ensurePop();
    _bindFrameClose();
    _paintPop(_curPct());
    _pop.classList.add('qqq-zoom-open');
    _positionPop();
  }
  function _closePop() { if (_pop) { _pop.classList.remove('qqq-zoom-open'); } }
  function _togglePop() {
    _ensurePop();
    if (_pop.classList.contains('qqq-zoom-open')) { _closePop(); }
    else { _openPop(); }
  }

  // 点 iframe 内（三面板/goods/roam）也关弹层（主窗口 document 收不到 iframe 内部点击）
  function _bindFrameClose() {
    var fs = document.querySelectorAll('iframe');
    for (var i = 0; i < fs.length; i++) {
      (function (f) {
        try {
          var doc = f.contentDocument;
          if (!doc) { return; }
          if (!doc.__qqqZoomCloseBound) {
            doc.__qqqZoomCloseBound = true;
            doc.addEventListener('mousedown', function () { _closePop(); }, true);
          }
        } catch (e) { /* 跨域尽力而为 */ }
      })(fs[i]);
    }
  }

  // ═══ 提交（唯一入口 = qqq-prefs；onChange 链自动推壳层 + 刷新徽章）═══
  function _apply(pct) {
    _closePop();
    try {
      if (window.qqqPrefs && window.qqqPrefs.set) { window.qqqPrefs.set('uiZoom', String(pct)); }
    } catch (e) { /* ignore */ }
  }

  function _boot() {
    // ① 设置面板 / 徽章 / 云拉取 / 恢复默认 → 推壳层热应用 + 徽章刷新
    try {
      var P = window.qqqPrefs;
      if (P && P.onChange) {
        P.onChange(function (key) {
          if (key === null || key === 'uiZoom') { _push(); }
        });
      }
    } catch (e) { /* ignore */ }
    // ② 应急快捷键（壳层主进程直控）→ 同步偏好内存 + 发起窗 toast
    try {
      var b = window.qqqideBridge;
      if (b && b.uiZoom && b.uiZoom.onChanged) {
        b.uiZoom.onChanged(function (payload) {
          if (!payload || typeof payload.pct !== 'number' || !isFinite(payload.pct)) { return; }
          try {
            var P2 = window.qqqPrefs;
            if (P2 && String(P2.get('uiZoom')) !== String(payload.pct)) {
              P2.set('uiZoom', String(payload.pct));
            }
          } catch (e2) { /* ignore */ }
          _refreshBadge(payload.pct);
          if (payload.toast) { _toast(payload.pct); }
        });
      }
    } catch (e) { /* ignore */ }
    // ③ 状态栏徽章（恒显）
    _ensureBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }
})();
