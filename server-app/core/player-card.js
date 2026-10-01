// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// player-card.js — 窗内播放器卡（qd 播放器 B 方案 · 2026-09-26 q319 v5）
//   定位：主窗口内的悬浮播放器卡（与 A=独立悬浮播放器窗 player/player.html 二选一使用）。
//   媒体行为 100% 共享 core/media-engine.js（禁第二套实现）；本文件只是第三个宿主：
//   卡片 DOM/拖拽/缩放/持久化/交接/出声独占 + 引擎挂载。
//   入口：悬浮层 ⧈ / 工作台 Player 卡的「窗内」按钮 / Roam ➕（卡开着时）/ 启动恢复（card.open）。
//   持久化（OS 级 player-state.json，与独立窗共用同一会话字段——两宿主互通、二选一不丢列表）：
//     card = { open, dockSide, stow, video:{x,y,w,h}, audio:{x,y,w,h} }（几何按媒体类型各记一套；stow = 收纳态）
//     会话 = { list, index, rate, loop, shuffle, volume, muted, dockSide }（写入即与 A 窗互通）
//   出声独占：卡起播 → claim('card')；他处起播 → 卡自动暂停。
//   ★ 最小化（2026-09-28 q319 v7）= 收纳（stow）：头部 — → 整卡隐藏、播放不断（仅隐 UI 不碰引擎）；
//    控制 / 展开唯一入口 = qqq 工作台 Player 槽（会话活跃时该槽渲染播放控制台；收纳态 qqq 按钮带 ♪ 徽标）；
//    stow 随 card 段持久化（壳层 ipc-player.ts 合并，跨重启保持）——禁再引入任何独立悬浮迷你条。
//   生命周期：不入编队/项目锁/窗口恢复；最后一个 qd 窗口关闭随实例退；Ctrl+R 重载后自动恢复（暂停态）。
// ============================================================================
(function () {
  'use strict';
  var bridge = window.qqqideBridge;
  var ME = (window.QQQMediaEngine && window.QQQMediaEngine.api) ? window.QQQMediaEngine.api : null;

  var cardEl = null, headEl = null, bodyEl = null, titleEl = null, emptyEl = null, resizeEl = null;
  var eng = null;
  var cur = { list: [], index: 0 };
  var card = { open: false, dockSide: 'right', video: null, audio: null, stow: false };
  var curKind = 'video';
  var saveTimer = 0, sessTimer = 0;
  var DEF_GEO = { video: { w: 760, h: 440 }, audio: { w: 680, h: 288 } };

  function _i(k, fb, p) { try { return window._i(k, fb, p); } catch (_) { return fb || k; } }
  function _toast(m, o) { try { if (window.qqqideQoast) { window.qqqideQoast.show(m, o || {}); } } catch (_) { } }
  function _needRestart() {
    _toast(_i('shell.player.needRestart', '播放器需要重启实例后可用'), { type: 'info', duration: 4000 });
  }
  function _overlayVisible() {
    try {
      var el = document.getElementById('qqqide-overlay');
      return !!(el && window.getComputedStyle(el).display !== 'none');
    } catch (_) { return false; }
  }

  // ── 样式（一次性注入；卡恒深色基调——与独立播放器窗同语言）──
  function _ensureStyle() {
    if (document.getElementById('qqq-player-card-style')) { return; }
    var st = document.createElement('style');
    st.id = 'qqq-player-card-style';
    st.textContent =
      '#qqq-player-card{position:fixed;z-index:99990;display:none;flex-direction:column;box-sizing:border-box;' +
      'background:#0b0b0b;border:1px solid rgba(255,255,255,0.16);border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,0.6);' +
      'overflow:hidden;color:#dcd8d0;font-family:system-ui,-apple-system,sans-serif}' +
      '#qqq-player-card.qpc-open{display:flex}' +
      '.qpc-head{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px 0 10px;flex:0 0 auto;' +
      'background:rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.09);user-select:none;touch-action:none}' +
      '.qpc-title{flex:1 1 auto;min-width:0;font-size:12px;color:#cfcbc2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}' +
      '.qpc-hbtn{width:22px;height:22px;padding:0;border:none;border-radius:6px;background:rgba(255,255,255,0.08);color:#cfcbc2;' +
      'font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;outline:none;flex:0 0 auto;' +
      'transition:background .12s,color .12s}' +
      '.qpc-hbtn:hover{background:rgba(255,255,255,0.22);color:#fff}' +
      '.qpc-hbtn.qpc-close:hover{background:rgba(220,50,47,0.6);color:#fff}' +
      '.qpc-body{position:relative;flex:1 1 auto;min-height:0;display:flex}' +
      '.qpc-empty{position:absolute;left:0;right:0;top:30px;bottom:0;display:none;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:8px;padding:18px;text-align:center;color:#8f8b83;font-size:12.5px;line-height:1.7}' +
      '.qpc-empty .qpc-note{font-size:24px;line-height:1;color:#ffd301;opacity:.75}' +
      '.qpc-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;z-index:6;touch-action:none;' +
      'background:linear-gradient(135deg,rgba(255,255,255,0) 46%,rgba(255,255,255,0.38) 50%,rgba(255,255,255,0) 54%),' +
      'linear-gradient(135deg,rgba(255,255,255,0) 62%,rgba(255,255,255,0.28) 66%,rgba(255,255,255,0) 70%)}' +
      // ★ 收纳（2026-09-28 q319 v7）：整卡隐藏、播放不断（display:none 不中断解码）；控制/展开 = qqq 工作台 Player 槽
      '#qqq-player-card.qpc-stow{display:none!important}';
    (document.head || document.documentElement).appendChild(st);
  }

  // ── DOM（单例；创建一次复用）──
  function _ensureDom() {
    if (cardEl) { return; }
    _ensureStyle();
    cardEl = document.createElement('div');
    cardEl.id = 'qqq-player-card';
    headEl = document.createElement('div');
    headEl.className = 'qpc-head';
    titleEl = document.createElement('span');
    titleEl.className = 'qpc-title';
    titleEl.textContent = _i('shell.player.title', '播放器');
    var minB = document.createElement('button');
    minB.className = 'qpc-hbtn qpc-min-btn';
    minB.tabIndex = -1;
    minB.setAttribute('data-no-cd', '');
    minB.title = _i('shell.player.minimize', '收纳到 qqq 工作台');
    minB.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:block;pointer-events:none"><path d="M6 19h12v2H6z"/></svg>';
    minB.addEventListener('click', function () { _setStow(true); });
    var popB = document.createElement('button');
    popB.className = 'qpc-hbtn';
    popB.tabIndex = -1;
    popB.setAttribute('data-no-cd', '');
    popB.title = _i('shell.overlay.mpopout', '弹出独立播放器');
    popB.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="display:block;pointer-events:none">' +
      '<path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';
    popB.addEventListener('click', _popOutToWindow);
    var closeB = document.createElement('button');
    closeB.className = 'qpc-hbtn qpc-close';
    closeB.tabIndex = -1;
    closeB.setAttribute('data-no-cd', '');
    closeB.title = _i('common.close', '关闭');
    closeB.textContent = '\u2715';
    closeB.addEventListener('click', function () { close(); });
    headEl.appendChild(titleEl);
    headEl.appendChild(minB);
    headEl.appendChild(popB);
    headEl.appendChild(closeB);
    bodyEl = document.createElement('div');
    bodyEl.className = 'qpc-body';
    emptyEl = document.createElement('div');
    emptyEl.className = 'qpc-empty';
    var note = document.createElement('div');
    note.className = 'qpc-note';
    note.textContent = '\u266A';
    var et = document.createElement('div');
    et.textContent = _i('shell.player.empty', '播放列表为空 — 在 Roam 中选中媒体右键「加入播放列表」，或从悬浮层 ↗ 弹出');
    emptyEl.appendChild(note);
    emptyEl.appendChild(et);
    resizeEl = document.createElement('div');
    resizeEl.className = 'qpc-resize';
    cardEl.appendChild(headEl);
    cardEl.appendChild(bodyEl);
    cardEl.appendChild(emptyEl);
    cardEl.appendChild(resizeEl);
    document.body.appendChild(cardEl);
    _hookDrag();
    _hookResize();
    window.addEventListener('resize', function () { if (card.open) { _applyGeom(); } });
  }

  function _showEmpty(on) { try { emptyEl.style.display = on ? 'flex' : 'none'; } catch (_) { } }

  // ── 拖拽（头部长条；跟随监听挂 document 捕获相位——指针移出头部/视口外 event 也不丢，pointerup 必达）──
  function _hookDrag() {
    var drag = null;
    function _mv(e) {
      if (!drag) { return; }
      var r = cardEl.getBoundingClientRect();
      var x = e.clientX - drag.dx, y = e.clientY - drag.dy;
      x = Math.max(-(r.width - 80), Math.min(x, window.innerWidth - 80));
      y = Math.max(0, Math.min(y, window.innerHeight - 30));
      cardEl.style.left = x + 'px';
      cardEl.style.top = y + 'px';
    }
    function _up() {
      if (!drag) { return; }
      drag = null;
      document.removeEventListener('pointermove', _mv, true);
      document.removeEventListener('pointerup', _up, true);
      document.removeEventListener('pointercancel', _up, true);
      _saveGeom();
    }
    function _bind(el) {
      if (!el) { return; }
      el.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) { return; }
        if (e.target && e.target.closest && e.target.closest('.qpc-hbtn')) { return; }
        var r = cardEl.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
        document.addEventListener('pointermove', _mv, true);
        document.addEventListener('pointerup', _up, true);
        document.addEventListener('pointercancel', _up, true);
        e.preventDefault();
      });
    }
    _bind(headEl);
  }

  // ── 右下角缩放（跟随监听挂 document 捕获相位——手柄仅 16px，光标必然逸出，靠捕获必达）──
  function _hookResize() {
    var rs = null;
    function _mv(e) {
      if (!rs) { return; }
      var w = Math.max(320, Math.min(rs.w0 + (e.clientX - rs.x0), window.innerWidth - 24));
      var h = Math.max(120, Math.min(rs.h0 + (e.clientY - rs.y0), window.innerHeight - 24));
      cardEl.style.width = w + 'px';
      cardEl.style.height = h + 'px';
    }
    function _up() {
      if (!rs) { return; }
      rs = null;
      document.removeEventListener('pointermove', _mv, true);
      document.removeEventListener('pointerup', _up, true);
      document.removeEventListener('pointercancel', _up, true);
      _saveGeom();
    }
    resizeEl.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) { return; }
      var r = cardEl.getBoundingClientRect();
      rs = { x0: e.clientX, y0: e.clientY, w0: r.width, h0: r.height };
      document.addEventListener('pointermove', _mv, true);
      document.addEventListener('pointerup', _up, true);
      document.addEventListener('pointercancel', _up, true);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // ── 几何（按媒体类型各一套；缺值取默认——右下角起浮）──
  function _geomKey() { return curKind === 'audio' ? 'audio' : 'video'; }
  function _applyGeom() {
    try {
      var key = _geomKey();
      var g = card[key] || null;
      var d = DEF_GEO[key];
      var w = (g && g.w) ? g.w : d.w;
      var h = (g && g.h) ? g.h : d.h;
      w = Math.max(320, Math.min(w, Math.max(320, window.innerWidth - 24)));
      h = Math.max(120, Math.min(h, Math.max(120, window.innerHeight - 24)));
      if (key === 'audio') { h = Math.max(h, 286); }   // ★ 专属播放控制行（2026-09-30）：内容变高——存量小几何自愈（旧默认 210 实测已裁 13px，行加入后实测需 ≥286）
      var x = (g && typeof g.x === 'number') ? g.x : Math.max(16, window.innerWidth - w - 24);
      var y = (g && typeof g.y === 'number') ? g.y : Math.max(16, window.innerHeight - h - 84);
      x = Math.max(-(w - 80), Math.min(x, window.innerWidth - 80));
      y = Math.max(0, Math.min(y, window.innerHeight - 30));
      cardEl.style.width = w + 'px';
      cardEl.style.height = h + 'px';
      cardEl.style.left = x + 'px';
      cardEl.style.top = y + 'px';
    } catch (_) { }
  }
  function _saveGeom() {
    try {
      var r = cardEl.getBoundingClientRect();
      card[_geomKey()] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (_) { }
    _saveCardSoon();
  }
  // ── 收纳 / 展开（唯一入口；收纳仅隐 UI——不碰引擎，播放不断；控制/展开入口 = qqq 工作台 Player 槽）──
  function _setStow(on) {
    if (!cardEl) { return; }
    on = !!on;
    if (on && !card.stow) {
      // 先捕获完整几何（展开时回原位）
      try {
        var r = cardEl.getBoundingClientRect();
        card[_geomKey()] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      } catch (_) { }
    }
    card.stow = on;
    try { cardEl.classList.toggle('qpc-stow', on); } catch (_) { }
    if (!on) { _applyGeom(); }
    if (on) { _toast(_i('shell.player.stowed', '已收纳到 qqq 工作台'), { type: 'info', duration: 2600 }); }
    _saveCardNow();
    _emit();
  }
  // ── 状态广播（收纳/展开/播放态/会话变化 → 工作台 Player 槽与 qqq 按钮 ♪ 徽标实时刷新）──
  function _emit() {
    try { window.dispatchEvent(new CustomEvent('qqq-player-state')); } catch (_) { }
    _updateBadge();
  }
  function _updateBadge() {
    try {
      var stowed = !!(card.open && card.stow);
      window.__qqqPlayerStowed = stowed;
      if (window.qqqToolsMenu && window.qqqToolsMenu.setPlayerBadge) { window.qqqToolsMenu.setPlayerBadge(stowed); }
    } catch (_) { }
  }

  // ── 持久化（OS 级 player-state.json：card 段 + 会话段——与独立窗互通）──
  function _saveCardSoon() {
    if (saveTimer) { clearTimeout(saveTimer); }
    saveTimer = setTimeout(function () { saveTimer = 0; _saveCardNow(); }, 500);
  }
  function _saveCardNow() {
    try {
      if (!bridge || !bridge.player || !bridge.player.setState) { return; }
      bridge.player.setState({ card: { open: !!card.open, dockSide: card.dockSide, video: card.video, audio: card.audio, stow: !!card.stow } });
    } catch (_) { }
  }
  function _saveSession() {
    try {
      if (!bridge || !bridge.player || !bridge.player.setState || !eng) { return; }
      var st = eng.getState();
      bridge.player.setState({
        list: st.list, index: st.index, rate: st.rate, loop: st.loop,
        shuffle: st.shuffle, volume: st.volume, muted: st.muted, dockSide: st.dockSide
      });
    } catch (_) { }
  }
  function _saveSessionDebounced() {
    if (sessTimer) { clearTimeout(sessTimer); }
    sessTimer = setTimeout(function () { sessTimer = 0; _saveSession(); }, 700);
  }

  // ── 引擎宿主（逐实例传入——不碰全局 configure，同页与悬浮层共存）──
  function _host() {
    return {
      bridge: bridge,
      rootEl: cardEl,
      i18n: function (k, fb, p) { return _i(k, fb, p); },
      toast: function (m, o) {
        var op = (typeof o === 'string') ? { type: o } : (o || {});
        if (!op.duration && !op.action) { op.duration = 3000; }
        _toast(m, op);
      },
      onClose: function () { close(); },     // 引擎主动收起（列表空/媒体失败）→ 同步收卡
      reopen: function (p) {
        _mountMedia({
          src: p.src, localPath: p.localPath,
          list: p.list || cur.list, index: (typeof p.index === 'number') ? p.index : cur.index,
          isTx: true, play: true
        });
      },
      reveal: function (p) {
        try { if (window.__qqq_roamRevealPath) { window.__qqq_roamRevealPath(String(p || '')); return; } } catch (_) { }
        try { if (bridge && bridge.shell && bridge.shell.showItemInFolder) { bridge.shell.showItemInFolder(String(p || '')); } } catch (_) { }
      },
      getLastDir: function () { return ''; },
      onPlayState: function (playing) {
        _emit();
        if (!playing) { return; }
        try { if (bridge && bridge.player && bridge.player.claim) { bridge.player.claim('card'); } } catch (_) { }
      },
      onState: function () { _saveSessionDebounced(); _emit(); },
      savePref: function (k, v) {
        if (k === 'dockSide') { card.dockSide = (v === 'left') ? 'left' : 'right'; _saveCardSoon(); }
      }
    };
  }

  // ── 挂载（统一入口：新开/交接/追加/启动恢复全走它）──
  function _mountMedia(o) {
    o = o || {};
    var list = (o.list && o.list.length) ? o.list : null;
    if (!list || !list.length) {
      curKind = 'video';
      _applyGeom();
      _showEmpty(true);
      try { bodyEl.innerHTML = ''; } catch (_) { }
      return;
    }
    var idx = (typeof o.index === 'number' && o.index >= 0 && o.index < list.length) ? o.index : 0;
    try { if (eng) { eng.destroy(); } } catch (_) { }
    eng = null;
    try { bodyEl.innerHTML = ''; } catch (_) { }
    cur.list = list;
    cur.index = idx;
    var item = list[idx] || {};
    curKind = ME ? ME.kindOf(item.localPath || o.localPath || o.src || '') : 'video';
    _applyGeom();
    _showEmpty(false);
    eng = ME ? ME.mount({
      container: bodyEl,
      host: _host(),
      mode: curKind,
      src: o.src || item.src || '',
      localPath: item.localPath || o.localPath || null,
      shotBase: item.localPath || o.localPath || null,
      list: list,
      index: idx,
      isTx: !!o.isTx,
      autoplay: o.play !== false,
      startTime: o.time || 0,
      initial: {
        rate: (typeof o.rate === 'number') ? o.rate : undefined,
        loop: o.loop, shuffle: o.shuffle,
        volume: (typeof o.volume === 'number') ? o.volume : undefined,
        muted: (typeof o.muted === 'boolean') ? o.muted : undefined,
        dockSide: card.dockSide
      }
    }) : null;
    _saveSession();
    _emit();
  }

  // ── 打开（handoff = 悬浮层 ⧈ 交接整机状态；缺省 = 恢复会话/空卡）──
  function open(handoff) {
    if (!bridge || !bridge.player || !bridge.player.getState || !ME) { _needRestart(); return; }
    _ensureDom();
    if (card.open && eng && !handoff) { cardEl.classList.add('qpc-open'); return; }   // 已开且无交接 → 零动作
    var _after = function (st) {
      var h = (handoff && handoff.list && handoff.list.length) ? handoff : null;
      cardEl.classList.add('qpc-open');
      card.open = true;
      if (h && (h.dockSide === 'left' || h.dockSide === 'right')) { card.dockSide = h.dockSide; }
      var list = h ? h.list : ((st && Array.isArray(st.list)) ? st.list : []);
      var index = h ? (h.index || 0) : ((st && st.index) || 0);
      if (!list || !list.length) {
        _mountMedia(null);   // 空态（占位提示；后续 appendPaths 即开播）——空列表恒展开态（提示可见）
        card.stow = false;
        try { cardEl.classList.remove('qpc-stow'); } catch (_) { }
        _applyGeom();
        _emit();
        _saveCardNow();
        return;
      }
      _mountMedia({
        list: list, index: index,
        play: h ? (h.paused === false) : false,   // 交接：直播中→续播；恢复：暂停态
        time: h ? (h.time || 0) : 0,
        rate: h ? h.rate : (st && st.rate), loop: h ? h.loop : (st && st.loop), shuffle: h ? h.shuffle : (st && st.shuffle),
        volume: h ? h.volume : (st && st.volume), muted: h ? h.muted : (st && st.muted)
      });
      try { cardEl.classList.toggle('qpc-stow', !!card.stow); } catch (_) { }
      if (!card.stow) { _applyGeom(); }
      _emit();
      _saveCardNow();
    };
    bridge.player.getState().then(function (r) {
      var st = (r && r.state) || {};
      if (st.card && typeof st.card === 'object') {
        card.dockSide = (st.card.dockSide === 'left') ? 'left' : 'right';
        card.video = st.card.video || card.video;
        card.audio = st.card.audio || card.audio;
        card.stow = !!(st.card.stow || st.card.mini);   // 旧 mini 字段迁移
      }
      _after(st);
    }).catch(function () { _after(null); });
  }

  function openFromHandoff(h) {
    if (!h || !h.list || !h.list.length) { return; }
    open(h);
  }

  function close() {
    try { if (eng) { eng.destroy(); } } catch (_) { }
    eng = null;
    try { bodyEl.innerHTML = ''; } catch (_) { }
    try { cardEl.classList.remove('qpc-open'); } catch (_) { }
    try { cardEl.classList.remove('qpc-stow'); } catch (_) { }
    card.open = false;
    card.stow = false;
    _showEmpty(false);
    _saveCardNow();
    _emit();
  }

  function isOpen() { try { return !!(cardEl && cardEl.classList.contains('qpc-open')); } catch (_) { return false; } }

  // ── 状态快照（qqq 工作台 Player 槽消费：open/stow/轨名/计数/播放态）──
  function _info() {
    var st = null;
    try { st = eng ? eng.getState() : null; } catch (_) { st = null; }
    var list = (st && st.list) || [];
    var idx = (st && typeof st.index === 'number') ? st.index : 0;
    var it = list[idx] || null;
    var name = '';
    if (it) { name = String(it.name || it.localPath || ''); if (name) { name = name.split(/[\\/]/).pop(); } }
    return {
      open: !!card.open,
      stow: !!card.stow,
      total: list.length,
      index: idx,
      name: name,
      paused: st ? !!st.paused : true
    };
  }
  // ── 播控（qqq 工作台 Player 槽唯一入口：播放开关 / 切轨）──
  function _cmd(a) {
    try {
      if (!eng) { return; }
      if (a === 'toggle') { eng.toggle(); }
      else if (a === 'next') { if (eng.next) { eng.next(); } }
      else if (a === 'prev') { if (eng.prev) { eng.prev(); } }
    } catch (_) { }
  }

  // ── 追加（Roam ➕ 且卡开着时唯一入口）：去重追加；播放中不打断；空闲则起播首个新增 ──
  function appendPaths(paths) {
    paths = (paths && paths.length) ? paths : [];
    var tracks = [];
    for (var i = 0; i < paths.length; i++) {
      var p = String(paths[i] || '');
      if (!p) { continue; }
      var np = p.replace(/\\/g, '/');
      tracks.push({ src: 'file:///' + np, localPath: np, name: np.split('/').pop() || '' });
    }
    if (!tracks.length) {
      _toast(_i('shell.player.addNone', '没有可加入的媒体文件'), { type: 'info', duration: 3000 });
      return;
    }
    if (!card.open || !eng) {
      open({ list: tracks, index: 0, paused: false, time: 0, dockSide: card.dockSide });
      _toast(_i('shell.player.added', '已加入播放列表：{n} 个', { n: tracks.length }), { type: 'success', duration: 3500 });
      return;
    }
    var known = {};
    try {
      var st = eng.getState();
      for (var j = 0; j < st.list.length; j++) { if (st.list[j] && st.list[j].localPath) { known[st.list[j].localPath] = 1; } }
    } catch (_) { }
    var fresh = [];
    for (var k = 0; k < tracks.length; k++) { if (!known[tracks[k].localPath]) { fresh.push(tracks[k]); } }
    var ignored = tracks.length - fresh.length;
    var added = 0;
    if (fresh.length) { try { added = eng.append(fresh, true); } catch (_) { added = 0; } }
    var msg;
    if (added > 0 && ignored > 0) { msg = _i('shell.player.addedIgnored', '已加入播放列表：{n} 个 · 忽略 {m} 个', { n: added, m: ignored }); }
    else if (added > 0) { msg = _i('shell.player.added', '已加入播放列表：{n} 个', { n: added }); }
    else { msg = _i('shell.player.addNone', '没有可加入的媒体文件'); }
    _toast(msg, { type: added > 0 ? 'success' : 'info', duration: 3500 });
    _saveSession();
  }

  // ── 交接出窗（↗ 头部按钮）：整机状态 → 独立播放器窗，成功即收卡 ──
  function _popOutToWindow() {
    try {
      if (!bridge || !bridge.player || !bridge.player.popOut || !eng) { return; }
      bridge.player.popOut(eng.getState()).then(function (r) { if (r && r.ok) { close(); } });
    } catch (_) { }
  }

  // ── 键盘（卡开着且悬浮层未开时接管：空格/1/2/Q/W/Z/X/←→/↑↓/M/L/R/A/S/F）──
  function _hookKeys() {
    document.addEventListener('keydown', function (e) {
      if (!eng || !cardEl || !cardEl.classList.contains('qpc-open')) { return; }
      if (_overlayVisible()) { return; }
      if (e.key === 'Escape') { try { if (eng.esc()) { e.stopPropagation(); } } catch (_) { } return; }
      try { eng.keys(e); } catch (_) { }
    });
  }

  // ── 出声独占（他处起播 → 卡自动暂停）──
  function _hookClaim() {
    try {
      if (bridge && bridge.player && bridge.player.onClaim) {
        bridge.player.onClaim(function (from) {
          if (from === 'card') { return; }
          try { if (eng) { eng.pause(); } } catch (_) { }
        });
      }
    } catch (_) { }
  }

  // ── 启动恢复（Ctrl+R / 重开窗口后：card.open 为真 → 恢复暂停态）──
  function _bootRestore() {
    try {
      if (!bridge || !bridge.player || !bridge.player.getState || !ME) { return; }
      bridge.player.getState().then(function (r) {
        var st = (r && r.state) || {};
        var c = st.card;
        if (!c || !c.open) { return; }
        card.dockSide = (c.dockSide === 'left') ? 'left' : 'right';
        card.video = c.video || null;
        card.audio = c.audio || null;
        card.stow = !!(c.stow || c.mini);   // 旧 mini 字段迁移
        _ensureDom();
        open(null);
      }).catch(function () { });
    } catch (_) { }
  }

  window.qqqPlayerCard = {
    open: open,
    openFromHandoff: openFromHandoff,
    close: close,
    isOpen: isOpen,
    appendPaths: appendPaths,
    stow: _setStow,
    cmd: _cmd,
    getInfo: _info
  };

  _hookKeys();
  _hookClaim();
  try { setTimeout(_bootRestore, 900); } catch (_) { }
})();
