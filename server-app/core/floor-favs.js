// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';
// ═══ floor-favs.js ═══
// 楼层收藏 · 主窗口（唯一真理源：数据 + 命名框 + 收藏夹面板 + 跳转路由）
//   · 数据落点 = 项目级 only.sq3 key `ai.floorFavs`（随项目迁移；条目自包含、带全局 id + updatedAt
//     ——为将来云端上传下载预留，云同步只需按 id LWW 合并，不回读项目数据）
//   · 星标按钮在 AI 面板 az 区（ai-panel/panel-fav.js 注入）——点星经 postMessage 请本机开命名框
//   · 收藏夹 = 全窗居中悬浮（开则渲染、关则 DOM 即毁，零常驻）；行点击 = 三面板智能路由跳转
//   · 跳转执行（孤儿楼层按需重建）在面板侧：ai-panel/panel-fav.js
//   消息协议：qqq-fav-open / qqq-fav-query / qqq-fav-jump-miss（面板→主）
//           qqq-fav-state / qqq-fav-jump（主→面板）

(function () {
  'use strict';
  if (window.top !== window.self) return;   // 仅主窗口（面板侧 = ai-panel/panel-fav.js）

  var KEY = 'ai.floorFavs';
  var MAX_ITEMS = 5000;    // 硬上限（防极端膨胀）
  var RENDER_CAP = 800;    // 面板一次性渲染上限（超出提示用搜索收窄）

  var _list = null;        // 内存缓存（null = 未加载）
  var _listRoot = null;    // 缓存所属主文件夹（换项目自动失效重载）
  var _loading = null;     // 加载单飞
  var _loadingRoot = null; // 单飞所属主文件夹
  var _panelOv = null;     // 收藏夹面板 overlay
  var _namerOv = null;     // 命名框 overlay
  var _filterLevel = 0;    // 收藏夹重要级别筛选（0=全部）

  function _i(key, fb, params) {
    try { return window._i ? window._i(key, fb, params) : fb; } catch (_) { return fb; }
  }
  function _toast(msg, opts) {
    try { if (window.qqqideQoast && window.qqqideQoast.show) window.qqqideQoast.show(msg, opts || {}); } catch (_) { }
  }
  function _folderFromUrl() {
    try {
      var m = window.location.search.match(/[?&]folder=([^&]+)/);
      if (m) return decodeURIComponent(m[1]).replace(/\\/g, '/').replace(/\/$/, '');
    } catch (_) { }
    return null;
  }
  function _root() {
    var r = (typeof window._workspaceRoot === 'string' && window._workspaceRoot) ? window._workspaceRoot : _folderFromUrl();
    return r ? String(r).replace(/\\/g, '/').replace(/\/$/, '') : null;
  }
  function _db() {
    var root = _root();
    if (!root || !window.qgs || typeof window.qgs.project !== 'function') return null;
    try { return window.qgs.project(root + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' }); } catch (_) { return null; }
  }
  function _newId() {
    return 'ff' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function _ymd(ts) {
    var d = new Date(ts || Date.now());
    if (isNaN(d.getTime())) d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function _autoName(question, questTitle, floorNum) {
    var q = String(question || '').replace(/\s+/g, ' ').trim();
    if (q) return q.length > 60 ? q.slice(0, 60) + '…' : q;
    if (questTitle) return questTitle + ' · f' + floorNum;
    return 'f' + floorNum;
  }
  function _norm(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var questId = String(raw.questId || '');
    var floorNum = parseInt(raw.floorNum, 10) || 0;
    if (!/^q\d+$/.test(questId) || floorNum <= 0) return null;
    var now = Date.now();
    var lv = parseInt(raw.level, 10);
    if (!(lv >= 1 && lv <= 3)) lv = 2;   // 重要级别（1-3；缺省/脏数据 → 2）
    return {
      id: String(raw.id || _newId()),
      questId: questId,
      floorNum: floorNum,
      name: String(raw.name || ''),
      level: lv,
      question: String(raw.question || ''),
      questTitle: String(raw.questTitle || ''),
      createdAt: parseInt(raw.createdAt, 10) || now,
      updatedAt: parseInt(raw.updatedAt, 10) || now
    };
  }
  function _find(questId, floorNum) {
    if (!_list) return null;
    for (var i = 0; i < _list.length; i++) {
      if (_list[i].questId === questId && _list[i].floorNum === floorNum) return _list[i];
    }
    return null;
  }
  function _ensureLoaded() {
    var root = _root();
    if (_list && _listRoot === root) return Promise.resolve(_list);
    _listRoot = root;
    _list = null;
    var db = _db();
    if (!db) { _list = []; return Promise.resolve(_list); }
    if (_loading && _loadingRoot === root) return _loading;
    _loadingRoot = root;
    _loading = db.get(KEY).then(function (v) {
      var arr = Array.isArray(v) ? v : [];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var it = _norm(arr[i]);
        if (it) out.push(it);
      }
      _list = out;
      _loading = null;
      _pushState();
      return _list;
    }).catch(function () {
      _list = [];
      _loading = null;
      return _list;
    });
    return _loading;
  }
  function _persist() {
    var db = _db();
    if (!db) return Promise.resolve(false);
    return Promise.resolve(db.setNow(KEY, _list)).then(function () { return true; })
      .catch(function () { return false; });
  }
  function _afterMutate() {
    return _persist().then(function (ok) {
      if (!ok) _toast('★ ' + _i('fav.saveFail', '收藏保存失败'), { type: 'error', duration: 6000 });
      _pushState();
      if (_panelOv) _renderPanel(_panelQuery());
    });
  }

  // ── 主窗口 → 全部 AI 面板：状态广播 ──
  function _panelWindows() {
    var out = [];
    var zones = ['qqq-wing-left', 'qqq-ai-zone', 'qqq-wing-right'];
    for (var i = 0; i < zones.length; i++) {
      var z = document.getElementById(zones[i]);
      var fr = z ? z.querySelector('iframe') : null;
      if (fr && fr.contentWindow) out.push(fr.contentWindow);
    }
    return out;
  }
  function _pushState() {
    var items = (_list || []).map(function (it) {
      return { id: it.id, questId: it.questId, floorNum: it.floorNum, name: it.name };
    });
    var ws = _panelWindows();
    for (var i = 0; i < ws.length; i++) {
      try { ws[i].postMessage({ type: 'qqq-fav-state', items: items }, '*'); } catch (_) { }
    }
  }

  // ── 跳转路由（三面板智能：归宿面板面板；无归属 → 中面板；翼未开 → 先开翼）──
  function _frameFor(panelId) {
    var zoneId = panelId === 0 ? 'qqq-wing-left' : panelId === 2 ? 'qqq-wing-right' : 'qqq-ai-zone';
    var zone = document.getElementById(zoneId);
    var fr = zone ? zone.querySelector('iframe') : null;
    return (fr && fr.contentWindow) ? fr : null;
  }
  function _ensureWingOpen(panelId) {
    var dotId = panelId === 0 ? 'qqq-bulb-1' : 'qqq-bulb-2';
    var dot = document.getElementById(dotId);
    if (dot && !dot.classList.contains('on')) { try { dot.click(); } catch (_) { } }
  }
  function _jump(item) {
    _closePanel();
    var questId = item.questId, floorNum = item.floorNum;
    var owner = undefined;
    try { if (typeof window.__qqq_getQuestOwner === 'function') owner = window.__qqq_getQuestOwner(questId); } catch (_) { }
    var target = 1;
    if (owner === 0 || owner === 1 || owner === 2) target = owner;
    var fr = _frameFor(target);
    if (!fr && target !== 1) {
      // 归属面板 iframe 不存在（陈旧归属）→ 释放后中面板兜底
      try { if (typeof window.__qqq_releaseQuest === 'function') window.__qqq_releaseQuest(questId, target); } catch (_) { }
      target = 1; fr = _frameFor(1);
    }
    if (!fr) { _toast('★ ' + _i('fav.noPanel', 'AI 面板尚未就绪'), { type: 'info', duration: 4000 }); return; }
    if (target === 0 || target === 2) _ensureWingOpen(target);
    try { fr.contentWindow.postMessage({ type: 'qqq-fav-jump', questId: questId, floorNum: floorNum }, '*'); } catch (_) { }
  }
  function _onJumpMiss(d) {
    var msg = d.reason === 'floor' ? _i('fav.floorGone', '该楼层数据不存在')
      : d.reason === 'card' ? _i('fav.cardGone', '任务数据未就绪或已被删除')
        : _i('fav.questGone', '该任务已不存在（可在收藏夹中移除该条）');
    _toast('★ ' + msg, { type: 'warning', duration: 5000 });
  }

  // 任务存活探测（共享 quest 索引；索引未就绪 → 视为存活，交给面板侧裁决）
  function _questAlive(questId) {
    try {
      var idx = window.__qqq_questIndex;
      if (!Array.isArray(idx) || !idx.length) return true;
      for (var i = 0; i < idx.length; i++) { if (idx[i] && idx[i].id === questId) return true; }
      return false;
    } catch (_) { return true; }
  }
  function _liveTitle(item) {
    try {
      var idx = window.__qqq_questIndex;
      if (Array.isArray(idx)) {
        for (var i = 0; i < idx.length; i++) {
          if (idx[i] && idx[i].id === item.questId && idx[i].title) return idx[i].title;
        }
      }
    } catch (_) { }
    return item.questTitle || '';
  }

  // ═══════════════════════════════════════════════════════════
  // 命名框（点星即弹：自动名已填 + 全选态——直接回车=用自动名，打字=覆盖）
  // ═══════════════════════════════════════════════════════════
  function _closeNamer() {
    if (_namerOv) { try { if (_namerOv.parentNode) _namerOv.parentNode.removeChild(_namerOv); } catch (_) { } }
    _namerOv = null;
  }
  function _openNamer(meta) {
    _closeNamer();
    var existing = _find(meta.questId, meta.floorNum);
    var ov = document.createElement('div');
    ov.className = 'qqq-fav-overlay';
    var box = document.createElement('div');
    box.className = 'qqq-fav-modal';

    // ★ 重要级别（1-3；默认两颗、可后改）：dialog 内星星点选，随条目落盘
    var lv = existing ? (existing.level || 2) : 2;
    var head = document.createElement('div');
    head.className = 'qqq-fav-namer-head';
    var title = document.createElement('div');
    title.className = 'qqq-fav-modal-title';
    var stars = document.createElement('div');
    stars.className = 'qqq-fav-namer-stars';
    stars.title = _i('fav.level', '重要级别');
    var starEls = [];
    for (var _si = 1; _si <= 3; _si++) {
      (function (idx) {
        var sb = document.createElement('button');
        sb.type = 'button';
        sb.tabIndex = -1;
        sb.className = 'qqq-fav-star';
        sb.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 防焦点转移（点星后可继续打字直接回车）
        sb.addEventListener('click', function (e) { e.stopPropagation(); lv = idx; _paint(); });
        stars.appendChild(sb);
        starEls.push(sb);
      })(_si);
    }
    function _paint() {
      for (var i = 0; i < starEls.length; i++) {
        var on = (i + 1) <= lv;
        starEls[i].textContent = on ? '\u2605' : '\u2606';
        if (on) starEls[i].classList.add('on'); else starEls[i].classList.remove('on');
      }
    }
    _paint();
    head.appendChild(title);
    head.appendChild(stars);
    var sub = document.createElement('div');
    sub.className = 'qqq-fav-modal-sub';
    // ★ 恒显示不可变编号 q{n} · f{m}（任务名可改可长——正文不留标题防溢出；悬停看全文）
    sub.textContent = meta.questId + ' \u00B7 f' + meta.floorNum;
    var _subTitle = _liveTitle({ questId: meta.questId, questTitle: meta.questTitle || '' });
    if (_subTitle) sub.title = _i('fav.questTip', 'quest：{0}', { 0: _subTitle });
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'qqq-fav-input';
    input.maxLength = 120;
    input.value = existing ? (existing.name || _autoName(existing.question, existing.questTitle, existing.floorNum))
      : _autoName(meta.question, meta.questTitle, meta.floorNum);

    var actions = document.createElement('div');
    actions.className = 'qqq-fav-actions';
    function _mkBtn(label, cls) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qqq-fav-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      return b;
    }
    var btnPrimary = _mkBtn(_i(existing ? 'fav.saveEdit' : 'fav.save', existing ? '保存' : '收藏'));
    var btnSecondary = null, btnDanger = null;
    if (existing) {
      btnDanger = _mkBtn(_i('fav.remove', '取消收藏'), 'danger');
      btnSecondary = _mkBtn(_i('fav.close', '关闭'));
    } else {
      btnSecondary = _mkBtn(_i('fav.cancel', '取消'));
    }
    actions.appendChild(btnPrimary);
    if (btnDanger) actions.appendChild(btnDanger);
    actions.appendChild(btnSecondary);

    function _close() { document.removeEventListener('keydown', _onKey, true); _closeNamer(); }
    function _commit() {
      var name = (input.value || '').trim();
      if (!name) name = _autoName(meta.question, meta.questTitle, meta.floorNum);
      var now = Date.now();
      var item = _find(meta.questId, meta.floorNum);
      if (item) {
        item.name = name;
        item.level = lv;
        if (meta.question) item.question = meta.question;
        if (meta.questTitle) item.questTitle = meta.questTitle;
        item.updatedAt = now;
      } else {
        _list.push({
          id: _newId(),
          questId: meta.questId,
          floorNum: meta.floorNum,
          name: name,
          level: lv,
          question: meta.question || '',
          questTitle: meta.questTitle || '',
          createdAt: now,
          updatedAt: now
        });
        if (_list.length > MAX_ITEMS) _list.splice(0, _list.length - MAX_ITEMS);
      }
      _close();
      _afterMutate();
    }
    function _removeFav() {
      var item = _find(meta.questId, meta.floorNum);
      if (item) {
        var idx = _list.indexOf(item);
        if (idx >= 0) _list.splice(idx, 1);
      }
      _close();
      _afterMutate();
    }
    var _onKey = function (e) {
      if (!e) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); _close(); return; }
      if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); _commit(); }
    };
    document.addEventListener('keydown', _onKey, true);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); _commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _close(); }
    });
    btnPrimary.addEventListener('click', function (e) { e.stopPropagation(); _commit(); });
    if (btnDanger) btnDanger.addEventListener('click', function (e) { e.stopPropagation(); _removeFav(); });
    btnSecondary.addEventListener('click', function (e) { e.stopPropagation(); _close(); });
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) _close(); });
    box.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    var foot = document.createElement('div');
    foot.className = 'qqq-fav-namer-foot';
    var dateEl = document.createElement('span');
    dateEl.className = 'qqq-fav-namer-date';
    dateEl.textContent = _ymd(existing ? (existing.createdAt || Date.now()) : Date.now());
    foot.appendChild(dateEl);
    foot.appendChild(actions);
    title.textContent = _i(existing ? 'fav.namerTitleEdit' : 'fav.namerTitle', existing ? '编辑收藏' : '收藏此楼层');
    input.placeholder = _i('fav.namePh', '收藏名称（直接回车用自动名）');
    box.appendChild(head);
    box.appendChild(sub);
    box.appendChild(input);
    box.appendChild(foot);
    ov.appendChild(box);
    document.body.appendChild(ov);
    _namerOv = ov;
    setTimeout(function () {
      try { input.focus(); input.select(); } catch (_) { }
    }, 0);
  }

  // ═══════════════════════════════════════════════════════════
  // 收藏夹面板（居中悬浮；开=渲染 / 关=DOM 即毁，零常驻）
  // ═══════════════════════════════════════════════════════════
  function _panelQuery() {
    if (!_panelOv) return '';
    var inp = _panelOv.querySelector('.qqq-fav-search');
    return inp ? String(inp.value || '') : '';
  }
  function _closePanel() {
    if (_panelOv) {
      try { document.removeEventListener('keydown', _panelKey, true); } catch (_) { }
      try { if (_panelOv._searchTimer) clearTimeout(_panelOv._searchTimer); } catch (_) { }
      try { window.removeEventListener('qqq-lang-change', _panelLangRefresh); } catch (_) { }
      try { if (_panelOv.parentNode) _panelOv.parentNode.removeChild(_panelOv); } catch (_) { }
    }
    _panelOv = null;
  }
  var _panelLangRefresh = function () { if (_panelOv) _renderPanel(_panelQuery()); };
  function _openPanel() {
    _ensureLoaded().then(function () {
      _closePanel();
      var ov = document.createElement('div');
      ov.className = 'qqq-fav-overlay';
      var panel = document.createElement('div');
      panel.className = 'qqq-fav-panel';
      var head = document.createElement('div');
      head.className = 'qqq-fav-head';
      var hTitle = document.createElement('div');
      hTitle.className = 'qqq-fav-title';
      var hCount = document.createElement('div');
      hCount.className = 'qqq-fav-count';
      head.appendChild(hTitle);
      head.appendChild(hCount);
      var search = document.createElement('input');
      search.type = 'text';
      search.className = 'qqq-fav-search';
      search.maxLength = 200;
      // ★ 重要级别筛选 chips：全部 / ★ / ★★ / ★★★（单选取值 0-3）
      var filterBar = document.createElement('div');
      filterBar.className = 'qqq-fav-filter';
      var chips = [];
      for (var _fi = 0; _fi < 4; _fi++) {
        (function (val) {
          var ch = document.createElement('button');
          ch.type = 'button';
          ch.className = 'qqq-fav-chip';
          ch.addEventListener('click', function () { _filterLevel = val; _renderPanel(_panelQuery()); });
          filterBar.appendChild(ch);
          chips.push(ch);
        })(_fi);
      }
      var listWrap = document.createElement('div');
      listWrap.className = 'qqq-fav-list';
      var foot = document.createElement('div');
      foot.className = 'qqq-fav-more';
      foot.style.display = 'none';
      panel.appendChild(head);
      panel.appendChild(search);
      panel.appendChild(filterBar);
      panel.appendChild(listWrap);
      panel.appendChild(foot);
      ov.appendChild(panel);
      // 行悬停即时提示框（quest 名全文；随面板销毁，随面板之外为零残留）
      var tip = document.createElement('div');
      tip.className = 'qqq-fav-tip';
      tip.style.display = 'none';
      ov.appendChild(tip);
      document.body.appendChild(ov);
      _panelOv = ov;
      _filterLevel = 0;             // 每次打开回到「全部」
      ov._searchTimer = null;
      ov._favChips = chips;
      ov._favTip = tip;
      panel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) _closePanel(); });
      document.addEventListener('keydown', _panelKey, true);
      search.addEventListener('input', function () {
        // 输入防抖：每次击键重渲染 800 行会卡手；120ms 合并
        clearTimeout(ov._searchTimer);
        ov._searchTimer = setTimeout(function () { _renderPanel(search.value); }, 120);
      });
      listWrap.addEventListener('scroll', _hideRowTip, { passive: true });
      listWrap.addEventListener('mouseleave', _hideRowTip);
      try { window.addEventListener('qqq-lang-change', _panelLangRefresh); } catch (_) { }
      _renderPanel('');
      setTimeout(function () { try { search.focus(); } catch (_) { } }, 0);
    });
  }
  function _panelKey(e) {
    if (e && e.key === 'Escape' && _panelOv) {
      e.stopPropagation(); e.preventDefault();
      _closePanel();
    }
  }
  function _metaText(item) {
    // ★ 不可变编号 + 收藏日期（任务名可改可长，不进此处——悬停看全文）
    return item.questId + ' \u00B7 f' + item.floorNum + ' \u00B7 ' + _ymd(item.createdAt);
  }
  function _renderPanel(query) {
    if (!_panelOv) return;
    var panel = _panelOv.querySelector('.qqq-fav-panel');
    if (!panel) return;
    var hTitle = panel.querySelector('.qqq-fav-title');
    var hCount = panel.querySelector('.qqq-fav-count');
    var search = panel.querySelector('.qqq-fav-search');
    var listWrap = panel.querySelector('.qqq-fav-list');
    var foot = panel.querySelector('.qqq-fav-more');
    if (hTitle) hTitle.textContent = '★ ' + _i('fav.title', '收藏夹');
    if (search && search.placeholder !== undefined) search.placeholder = _i('fav.searchPh', '搜索收藏（名称 / 任务 / 问题）');
    _hideRowTip();
    var chips = _panelOv._favChips || [];
    var _chipLabels = [_i('fav.filterAll', '全部'), '\u2605', '\u2605\u2605', '\u2605\u2605\u2605'];
    for (var ci = 0; ci < chips.length; ci++) {
      chips[ci].textContent = _chipLabels[ci] || '';
      if (ci === _filterLevel) chips[ci].classList.add('on'); else chips[ci].classList.remove('on');
    }
    var items = (_list || []).slice().sort(function (a, b) {
      // ★ 排序 = 收藏时间倒序（创建即身份）——改名/调级不挪行，检索时列表稳定
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    var q = String(query || '').trim().toLowerCase();
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (_filterLevel && (it.level || 2) !== _filterLevel) continue;
      if (q) {
        var hay = (it.name + '\n' + it.question + '\n' + it.questTitle + '\n' + it.questId + '\nf' + it.floorNum).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }
      rows.push(it);
    }
    if (hCount) hCount.textContent = _i('fav.count', '共 {0} 条', { 0: rows.length });
    listWrap.textContent = '';
    if (!rows.length) {
      var empty = document.createElement('div');
      empty.className = 'qqq-fav-empty';
      empty.textContent = q ? _i('fav.noMatch', '没有匹配的收藏') : _i('fav.empty', '还没有收藏 · 任意楼层点 ☆ 收藏它');
      listWrap.appendChild(empty);
      if (foot) foot.style.display = 'none';
      return;
    }
    var shown = Math.min(rows.length, RENDER_CAP);
    var frag = document.createDocumentFragment();
    for (var r = 0; r < shown; r++) frag.appendChild(_mkRow(rows[r]));
    listWrap.appendChild(frag);
    if (foot) {
      if (rows.length > shown) {
        foot.style.display = '';
        foot.textContent = _i('fav.more', '仅显示前 {0} 条，输入关键字缩小范围', { 0: shown });
      } else {
        foot.style.display = 'none';
      }
    }
  }
  // ★ 行悬停即时提示框（quest 名原文全文「一字不漏」；先显后量再定位，四边距恒 ≥8px）
  function _showRowTip(row, item) {
    if (!_panelOv || !_panelOv._favTip) return;
    var tip = _panelOv._favTip;
    var t = _liveTitle(item) || '';
    tip.textContent = t ? _i('fav.questTip', 'quest：{0}', { 0: t }) : item.questId;
    tip.style.display = 'block';
    var r = row.getBoundingClientRect();
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var x = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
    var y = r.bottom + 6;
    if (y + h > vh - 8) y = r.top - h - 6;
    if (y < 8) y = Math.max(8, Math.min(vh - h - 8, r.bottom + 6));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function _hideRowTip() {
    if (_panelOv && _panelOv._favTip) _panelOv._favTip.style.display = 'none';
  }
  // ★ 行内调级：本地重绘该行星星（不整表重建）；筛选态 → 级别变化可能移出视野，直落全量重渲染
  function _setLevel(item, lv, starsWrap) {
    if (!item || (item.level || 2) === lv) return;
    item.level = lv;
    item.updatedAt = Date.now();   // 云同步 LWW 语义需要（本地排序按 createdAt，不挪行）
    _persist().then(function (ok) {
      if (!ok) _toast('★ ' + _i('fav.saveFail', '收藏保存失败'), { type: 'error', duration: 6000 });
    });
    if (_filterLevel) { _renderPanel(_panelQuery()); return; }
    try {
      var btns = starsWrap ? starsWrap.querySelectorAll('.qqq-fav-star') : [];
      for (var i = 0; i < btns.length; i++) {
        var on = (i + 1) <= lv;
        btns[i].textContent = on ? '\u2605' : '\u2606';
        if (on) btns[i].classList.add('on'); else btns[i].classList.remove('on');
      }
    } catch (_) { }
  }
  function _mkRow(item) {
    var row = document.createElement('div');
    row.className = 'qqq-fav-row';
    var alive = _questAlive(item.questId);
    if (!alive) row.classList.add('deleted');
    var main = document.createElement('div');
    main.className = 'qqq-fav-row-main';
    var nm = document.createElement('div');
    nm.className = 'qqq-fav-name';
    nm.textContent = item.name || _autoName(item.question, item.questTitle, item.floorNum);
    var mt = document.createElement('div');
    mt.className = 'qqq-fav-meta';
    mt.textContent = _metaText(item) + (alive ? '' : ' · ' + _i('fav.deletedTag', '任务已删除'));
    main.appendChild(nm);
    main.appendChild(mt);
    // ★ 重要级别星标（行内可改；点第 n 颗 = 级别 n）
    var starsWrap = document.createElement('div');
    starsWrap.className = 'qqq-fav-row-stars';
    starsWrap.title = _i('fav.level', '重要级别');
    var _lvNow = item.level || 2;
    for (var _ri = 1; _ri <= 3; _ri++) {
      (function (idx) {
        var sb = document.createElement('button');
        sb.type = 'button';
        sb.className = 'qqq-fav-star';
        var on = idx <= _lvNow;
        sb.textContent = on ? '\u2605' : '\u2606';
        if (on) sb.classList.add('on');
        sb.addEventListener('click', function (e) {
          e.stopPropagation();
          _setLevel(item, idx, starsWrap);
        });
        starsWrap.appendChild(sb);
      })(_ri);
    }
    var acts = document.createElement('div');
    acts.className = 'qqq-fav-act';
    var bRename = document.createElement('button');
    bRename.type = 'button';
    bRename.className = 'qqq-fav-btn qqq-fav-icon';
    bRename.textContent = '\u270E';
    bRename.title = _i('fav.rename', '改名');
    var bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'qqq-fav-btn qqq-fav-icon danger';
    bDel.textContent = '\u2715';
    bDel.title = _i('fav.rowRemove', '移除');
    acts.appendChild(bRename);
    acts.appendChild(bDel);
    row.appendChild(main);
    row.appendChild(starsWrap);
    row.appendChild(acts);
    row.addEventListener('mouseenter', function () { _showRowTip(row, item); });
    row.addEventListener('mouseleave', _hideRowTip);
    row.addEventListener('click', function () {
      if (!_questAlive(item.questId)) {
        _toast('★ ' + _i('fav.questGone', '该任务已不存在（可在收藏夹中移除该条）'), { type: 'warning', duration: 5000 });
        return;
      }
      _jump(item);
    });
    bRename.addEventListener('click', function (e) {
      e.stopPropagation();
      _closePanel();
      _openNamer({
        questId: item.questId,
        floorNum: item.floorNum,
        question: item.question || '',
        questTitle: _liveTitle(item)
      });
    });
    bDel.addEventListener('click', function (e) {
      e.stopPropagation();
      var idx = _list.indexOf(item);
      if (idx >= 0) _list.splice(idx, 1);
      _afterMutate();
    });
    return row;
  }

  // ═══════════════════════════════════════════════════════════
  // 消息接线（面板 → 主窗口）
  // ═══════════════════════════════════════════════════════════
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.type) return;
    if (d.type === 'qqq-fav-query') {
      _ensureLoaded().then(function () { _pushState(); });
      return;
    }
    if (d.type === 'qqq-fav-open') {
      var meta = {
        questId: String(d.questId || ''),
        floorNum: parseInt(d.floorNum, 10) || 0,
        question: String(d.question || ''),
        questTitle: String(d.questTitle || '')
      };
      if (!/^q\d+$/.test(meta.questId) || meta.floorNum <= 0) return;
      _ensureLoaded().then(function () { _openNamer(meta); });
      return;
    }
    if (d.type === 'qqq-fav-jump-miss') { _onJumpMiss(d); return; }
  });

  window.qqqFloorFavs = {
    open: _openPanel,
    isFav: function (questId, floorNum) { return !!_find(questId, floorNum); },
    count: function () { return _list ? _list.length : 0; },
    refresh: function () { return _ensureLoaded().then(function () { _pushState(); }); }
  };
})();
