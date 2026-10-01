// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ui-zoom.js — 应用级界面缩放机器（qqq-prefs 'uiZoom' → 壳层 webContents zoom）
//
// 唯一可见入口 = 状态栏缩放徽章（CPU 与时间分割线之间；恒显，非 100% 高亮）：
//   hover 显快捷键组 tooltip；点击弹八档点选层 → qqqPrefs.set → onChange → 壳层热应用。
// 其余输入（统一收敛到 qqq-prefs / 壳层）：
//   ① 应急快捷键 Ctrl+= / Ctrl+- / Ctrl+0（壳层主进程直控）→ bridge.uiZoom.onChanged
//      → _adopt 同步内存 + 徽章 + 发起窗口 toast
//   ② 云拉取 / 恢复默认新值 → qqqPrefs.onChange → 闸门上报壳层
// ★ 多窗口闭环（唯一语义 = 单值全窗同步；此前多窗口 90/100 互踢的根治）：
//   真相唯一 = 壳层 _factor；变更唯一来源 = 用户动作（徽章/快捷键）或云拉取新值；
//   壳层每次真变化全窗广播 'qqqide:ui-zoom:changed' → 各窗 _adopt()（同步内存+徽章，绝不回写上报）；
//   上报闸门 = _pushIfChanged：值相对 _lastSeen 无变化 → 零动作（陈旧窗口收到任意跨窗事件
//   读到旧内存值也绝不回推——禁恢复「无条件 _push」）。
// 渲染：徽章 + tooltip + 弹层（八档与 qqq-prefs 'uiZoom' enum 严格同值——两处同改）。
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

  var _lastSeen = null;   // 本窗口认定的全局真值（pct）；null = 尚未与壳层对齐（启动瞬间）

  function _curPct() {
    try {
      var P = window.qqqPrefs;
      var v = (P && P.get) ? parseInt(P.get('uiZoom'), 10) : 100;
      return isFinite(v) ? v : 100;
    } catch (e) { return 100; }
  }

  // ★ 上报闸门（多窗口互踢根治）：只有「本窗口认定的值」相对 _lastSeen 真变化才上报壳层。
  //   陈旧窗口收到任意跨窗事件（登录/权益/云同步全量 emit）读到旧内存值 → 与 _lastSeen 相同 → 零动作。
  function _pushIfChanged() {
    try {
      var pct = _curPct();
      if (_lastSeen === null) { _refreshBadge(pct); return; }                  // 未对齐 → 等 get 对齐，不上报
      if (String(pct) === String(_lastSeen)) { _refreshBadge(pct); return; }   // 零变化 → 零动作
      _lastSeen = pct;
      var b = window.qqqideBridge;
      if (b && b.uiZoom && b.uiZoom.set) { b.uiZoom.set(pct); }
      _refreshBadge(pct);
    } catch (e) { /* ignore */ }
  }

  // ★ 采用壳层真值（启动对齐 / 全窗广播）：同步偏好内存 + 徽章；绝不回写上报（防回声）。
  function _adopt(pct) {
    try {
      if (typeof pct !== 'number' || !isFinite(pct)) { return; }
      _lastSeen = pct;
      var P = window.qqqPrefs;
      if (P && P.get && P.set && String(P.get('uiZoom')) !== String(pct)) { P.set('uiZoom', String(pct)); }
      _refreshBadge(pct);
    } catch (e) { /* ignore */ }
  }

  // ═══ 状态栏徽章（恒显按钮；非 100% 高亮；位于 CPU 与时间分割线之间——分割线由 shell-main.css 落在时钟左侧）═══
  var _badge = null;

  function _ensureBadge() {
    if (_badge) { return; }
    var anchor = document.getElementById('qqq-status-mem') || document.getElementById('qqq-status-online');
    if (!anchor || !anchor.parentNode) { return; }
    _badge = document.createElement('span');
    _badge.className = 'qqq-status-item qqq-zoom-badge';
    _badge.id = 'qqq-status-zoom';
    _badge.textContent = '100%';
    _badge.addEventListener('mouseenter', function () {
      if (_tipTimer) { clearTimeout(_tipTimer); }
      _tipTimer = setTimeout(function () { _tipTimer = null; _showTip(); }, 140);
    });
    _badge.addEventListener('mouseleave', function () { _hideTip(); });
    _badge.addEventListener('click', function (e) {
      if (e && e.stopPropagation) { e.stopPropagation(); }
      _hideTip();
      _togglePop();
    });
    anchor.parentNode.insertBefore(_badge, anchor.nextSibling);
    // 徽章位置随窗口/密度级联漂移 → 位移即收（pop 由 _ensurePop 的 resize 钩重定位）
    window.addEventListener('resize', _hideTip);
    window.addEventListener('blur', _hideTip);
    window.addEventListener('qqq-lang-change', _hideTip);
    _refreshBadge(_curPct());
  }

  // ═══ 快捷键组 tooltip（hover 显；点击/移开/失焦/换语言即收）═══
  var _tip = null, _tipTimer = null;

  function _modLabel() {
    try { return /Mac/i.test(navigator.platform || '') ? '⌘' : 'Ctrl+'; } catch (e) { return 'Ctrl+'; }
  }

  function _tipText() {
    var m = _modLabel();
    try {
      if (window._i) { return window._i('uiZoom.hotkeys', '{m}= 放大 · {m}- 缩小 · {m}0 复位', { m: m }); }
    } catch (e) { /* ignore */ }
    return m + '= 放大 · ' + m + '- 缩小 · ' + m + '0 复位';
  }

  function _positionTip() {
    if (!_badge || !_tip) { return; }
    var r = _badge.getBoundingClientRect();
    var tw = _tip.offsetWidth, th = _tip.offsetHeight;
    var left = r.right - tw;
    var maxL = window.innerWidth - tw - 8;
    if (left > maxL) { left = maxL; }
    if (left < 8) { left = 8; }
    _tip.style.left = Math.round(left) + 'px';
    _tip.style.top = Math.round(r.top - th - 6) + 'px';
  }

  function _showTip() {
    if (_pop && _pop.classList.contains('qqq-zoom-open')) { return; }
    if (!_tip) {
      _tip = document.createElement('div');
      _tip.className = 'qqq-zoom-tip';
      document.body.appendChild(_tip);
    }
    _tip.textContent = _tipText();
    _tip.classList.add('qqq-zoom-tip-open');
    _positionTip();
  }
  function _hideTip() {
    if (_tipTimer) { clearTimeout(_tipTimer); _tipTimer = null; }
    if (_tip) { _tip.classList.remove('qqq-zoom-tip-open'); }
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
    var b = window.qqqideBridge;
    // ① 偏好变化（云拉取新值 / 恢复默认 / 徽章点击本地 set）→ 闸门上报（零变化零动作）
    try {
      var P = window.qqqPrefs;
      if (P && P.onChange) {
        P.onChange(function (key) {
          if (key === null || key === 'uiZoom') { _pushIfChanged(); }
        });
      }
    } catch (e) { /* ignore */ }
    // ② 壳层广播（每次真变化全窗同步 + 快捷键 toast）→ 采用真值（内存 + 徽章，不回写）
    try {
      if (b && b.uiZoom && b.uiZoom.onChanged) {
        b.uiZoom.onChanged(function (payload) {
          if (!payload || typeof payload.pct !== 'number' || !isFinite(payload.pct)) { return; }
          _adopt(payload.pct);
          if (payload.toast) { _toast(payload.pct); }
        });
      }
    } catch (e) { /* ignore */ }
    // ③ 启动对齐：读壳层真值（_factor 唯一权威）——防加载期错位 / 丢广播
    try {
      if (b && b.uiZoom && b.uiZoom.get) {
        var p = b.uiZoom.get();
        if (p && p.then) {
          p.then(function (v) {
            var n = parseInt(v, 10);
            if (isFinite(n) && _lastSeen === null) { _adopt(n); }
          }).catch(function () { /* ignore */ });
        }
      }
    } catch (e) { /* ignore */ }
    // ④ 状态栏徽章（恒显）
    _ensureBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }
})();
