// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// help-menu.js — 菜单行2 help 按钮（inbox 右边）· hover 三行菜单
//
// 结构（hover help → 菜单；hover 行 → 右侧子菜单）:
//   contact    → QQ / 邮箱 / 电话号码（点击复制到剪贴板 + qoast 提示）
//   video      → B 站合集策展视频（点击外部浏览器直接观看）
//   community  → 评论 / 更新日志 / 公告 / 官方文档（粗体）/ 活动（点击外部浏览器）
//
// 挂载点: gaea-host.js renderTabBar() 尾部 → window.qqqHelpMenu.mount(#qqq-goods-bar)
//         （工具栏每次重建（goods 注册/切换/移除）自动重挂；mount 内先 close 防孤儿菜单）
// 视频清单唯一维护点: 本文件 HELP_VIDEOS（来源 B 站合集 8697102，2026-09-15 人工策展——
//         剔除非核心内容，名称已提炼为短名；新增视频 = 此处加一行）
// 文案: zh.json "help" 段（_i 中文回退，其余语言待翻译管线）；菜单行标签（contact/video/community）恒英文（用户定案）
// 打开方式: 一律系统外部浏览器（bridge.shell.openExternal，window.open 兜底）
// 交互: 纯 hover（进入即展开，250ms 延迟关闭）；Esc / 点击别处 / 窗口 resize 即关；
//       全按钮与菜单行零自定义 cursor（光标铁律）
// ============================================================================

; (function () {
  'use strict';

  var PAGE = 'https://www.gh555.com/gaea/d/qqqide';

  // ★ 视频策展清单（唯一维护点）— B 站合集 space.bilibili.com/543721433/lists/8697102
  var HELP_VIDEOS = [
    { t: 'qqqide 总览', u: 'https://www.bilibili.com/video/BV1KiNM6JE73' },
    { t: 'qqqide 是怎样做出来的', u: 'https://www.bilibili.com/video/BV1UGth6kEdR' },
    { t: '1/10 内存占用', u: 'https://www.bilibili.com/video/BV1dX3p6sEQq' },
    { t: '粘贴一切滴编辑器', u: 'https://www.bilibili.com/video/BV19KGw6FEmZ' },
    { t: '在一切历史中检索', u: 'https://www.bilibili.com/video/BV1nV3b6jEZL' },
    { t: '极快找回一条历史任务', u: 'https://www.bilibili.com/video/BV13t8g6fE2w' },
    { t: '把历史喂给 AI', u: 'https://www.bilibili.com/video/BV1JEMy67Ekv' },
    { t: 'AI 处理图片', u: 'https://www.bilibili.com/video/BV1pp326PEVQ' },
    { t: '独创三通并行', u: 'https://www.bilibili.com/video/BV1LH346AEs7' },
    { t: '全量文件时间线', u: 'https://www.bilibili.com/video/BV1ih3d6UEJk' },
    { t: 'Roam 文件中枢', u: 'https://www.bilibili.com/video/BV1PD826SEMT' },
    { t: '换账号不丢历史', u: 'https://www.bilibili.com/video/BV1Qo3X6NEmM' },
    { t: '不一样的 vibe coding', u: 'https://www.bilibili.com/video/BV13TTd6hEhu' },
    { t: '大型项目开发实战', u: 'https://www.bilibili.com/video/BV1cn3y6oE8W' },
    { t: '用户评价', u: 'https://www.bilibili.com/video/BV1DG836ZEVo' }
  ];

  var HOVER_CLOSE_DELAY = 250;

  var _btnEl = null;
  var _rootEl = null;       // 三行主菜单
  var _rootRowEls = [];     // [{key, el}] 主菜单行（高亮管理）
  var _subEl = null;        // 右侧子菜单
  var _subKey = null;       // 当前子菜单归属行 key
  var _allTimer = null;     // 整体关闭计时器
  var _subTimer = null;     // 子菜单关闭计时器
  var _globalBound = false;

  function _i(key, fb) { try { return window._i ? window._i(key, fb) : fb; } catch (e) { return fb; } }

  // ── 样式（自包含注入，家族外观对齐品牌下拉：卡片底/边框/悬浮色全走主题变量） ──
  function _ensureStyle() {
    if (document.getElementById('qqq-help-menu-style')) return;
    var s = document.createElement('style');
    s.id = 'qqq-help-menu-style';
    s.textContent = [
      '.qqq-help-btn:hover, .qqq-help-btn.qqq-help-open { background: var(--background-color) !important; opacity: .85; }',
      '.qqq-help-menu, .qqq-help-sub {',
      '  position: fixed; z-index: 999999;',
      '  background: var(--card-bg, #fdf6e3);',
      '  border: 1px solid var(--border-color, #d6d6d6);',
      '  border-radius: 6px;',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.12);',
      '  padding: 4px 0; margin: 0;',
      '  opacity: 0; pointer-events: none;',
      '  transition: opacity .12s ease, transform .12s ease;',
      '  font-family: Tahoma, sans-serif; font-size: 13px;',
      '  max-height: calc(100vh - 12px); overflow-y: auto; overflow-x: hidden;',
      '}',
      '.qqq-help-menu { min-width: 148px; transform: translateY(-4px); }',
      '.qqq-help-sub { min-width: 168px; max-width: 320px; z-index: 1000000; transform: translateX(-4px); }',
      '.qqq-help-menu.open, .qqq-help-sub.open { opacity: 1; pointer-events: auto; }',
      '.qqq-help-menu.open { transform: translateY(0); }',
      '.qqq-help-sub.open { transform: translateX(0); }',
      '.qqq-help-row { display: flex; align-items: center; justify-content: space-between; padding: 7px 12px; color: var(--text-primary, #586e75); }',
      '.qqq-help-row:hover, .qqq-help-row.active { background: var(--hover-bg, rgba(0,0,0,0.06)); }',
      '.qqq-help-arrow { opacity: .55; margin-left: 16px; font-size: 12px; }',
      '.qqq-help-sub-row { padding: 7px 12px; color: var(--text-primary, #586e75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.qqq-help-sub-row:hover { background: var(--hover-bg, rgba(0,0,0,0.06)); }',
      '.qqq-help-sub-row.bold { font-weight: 700; }',
      '.qqq-help-contact { display: flex; align-items: center; }',
      '.qqq-help-contact-label { min-width: 58px; opacity: .85; margin-right: 10px; }',
      '.qqq-help-contact-val { font-weight: 600; }'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── 计时器 ──
  function _clearTimers() {
    if (_allTimer) { clearTimeout(_allTimer); _allTimer = null; }
    if (_subTimer) { clearTimeout(_subTimer); _subTimer = null; }
  }
  function _scheduleAll() {
    _clearTimers();
    _allTimer = setTimeout(_closeAll, HOVER_CLOSE_DELAY);
  }
  function _scheduleSub() {
    if (_subTimer) clearTimeout(_subTimer);
    _subTimer = setTimeout(_removeSub, HOVER_CLOSE_DELAY);
  }

  // ── 全局收尾监听（外点关闭 / Esc / resize） ──
  function _containsAny(t) {
    if (!t) return false;
    if (_rootEl && _rootEl.contains(t)) return true;
    if (_subEl && _subEl.contains(t)) return true;
    if (_btnEl && _btnEl.contains(t)) return true;
    return false;
  }
  function _onDocClick(e) {
    if (_containsAny(e && e.target)) return;
    _closeAll();
  }
  function _onEsc(e) {
    if (e && e.key === 'Escape') _closeAll();
  }
  function _bindGlobal() {
    if (_globalBound) return;
    _globalBound = true;
    document.addEventListener('click', _onDocClick);
    document.addEventListener('keydown', _onEsc, true);
    window.addEventListener('resize', _closeAll);
  }
  function _unbindGlobal() {
    if (!_globalBound) return;
    _globalBound = false;
    document.removeEventListener('click', _onDocClick);
    document.removeEventListener('keydown', _onEsc, true);
    window.removeEventListener('resize', _closeAll);
  }

  // ── 主菜单 ──
  var ROWS = [
    { key: 'contact', label: 'contact' },
    { key: 'video', label: 'video' },
    { key: 'community', label: 'community' }
  ];

  function _buildRoot() {
    var root = document.createElement('div');
    root.className = 'qqq-help-menu';
    root.addEventListener('mouseenter', _clearTimers);
    root.addEventListener('mouseleave', _scheduleAll);
    _rootRowEls = [];
    ROWS.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'qqq-help-row';
      row.dataset.sub = d.key;
      var lab = document.createElement('span');
      lab.textContent = d.label;
      var arr = document.createElement('span');
      arr.className = 'qqq-help-arrow';
      arr.textContent = '\u203A';
      row.appendChild(lab);
      row.appendChild(arr);
      row.addEventListener('mouseenter', function () { _clearTimers(); _showSub(d.key, row); });
      row.addEventListener('mouseleave', _scheduleSub);
      _rootRowEls.push({ key: d.key, el: row });
      root.appendChild(row);
    });
    return root;
  }

  function _showRoot() {
    if (_rootEl && _rootEl.parentNode) return;
    if (!_btnEl) return;
    _ensureStyle();
    _removeRoot();
    var root = _buildRoot();
    document.body.appendChild(root);
    _rootEl = root;
    // 定位：按钮下方，右缘/下缘防出界
    var r = _btnEl.getBoundingClientRect();
    var w = root.offsetWidth || 148, h = root.offsetHeight || 100;
    var left = r.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(4, r.top - h - 4);
    root.style.left = left + 'px';
    root.style.top = top + 'px';
    requestAnimationFrame(function () { if (_rootEl) _rootEl.classList.add('open'); });
    if (_btnEl) _btnEl.classList.add('qqq-help-open');
    _bindGlobal();
  }

  function _removeRoot() {
    if (_rootEl) { try { _rootEl.remove(); } catch (e) { } _rootEl = null; }
    _rootRowEls = [];
  }

  function _markActiveRow(rowEl) {
    for (var i = 0; i < _rootRowEls.length; i++) {
      var it = _rootRowEls[i];
      if (it.el === rowEl) { try { it.el.classList.add('active'); } catch (e) { } }
      else { try { it.el.classList.remove('active'); } catch (e) { } }
    }
  }

  // ── 子菜单数据 ──
  function _subRows(key) {
    if (key === 'contact') {
      return [
        { label: 'QQ', value: '524906522' },
        { label: _i('help.email', '邮箱'), value: 'info@gh555.com' },
        { label: _i('help.phone', '电话号码'), value: '+86 19232854249' }
      ];
    }
    if (key === 'video') {
      return HELP_VIDEOS.map(function (v) { return { label: v.t, url: v.u }; });
    }
    if (key === 'community') {
      return [
        { label: _i('help.comments', '评论'), url: PAGE + '#comments' },
        { label: _i('help.changelog', '更新日志'), url: PAGE + '#changelog' },
        { label: _i('help.announcements', '公告'), url: PAGE + '#announcements' },
        { label: _i('help.docs', '官方文档'), url: PAGE + '#docs/doc-20260727-140345', bold: true },
        { label: _i('help.activity', '活动'), url: PAGE + '#video' }
      ];
    }
    return [];
  }

  function _positionSub(rowEl) {
    if (!_subEl || !_rootEl || !rowEl) return;
    var rowRect = rowEl.getBoundingClientRect();
    var rootRect = _rootEl.getBoundingClientRect();
    var w = _subEl.offsetWidth || 180, h = _subEl.offsetHeight || 100;
    var left = rootRect.right + 2;
    if (left + w > window.innerWidth - 8) left = rootRect.left - w - 2; // 右侧放不下 → 翻到左侧
    if (left < 8) left = 8;
    var top = rowRect.top;
    if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    if (top < 4) top = 4;
    _subEl.style.left = left + 'px';
    _subEl.style.top = top + 'px';
    if (!_subEl.classList.contains('open')) {
      requestAnimationFrame(function () { if (_subEl) _subEl.classList.add('open'); });
    }
  }

  function _showSub(key, rowEl) {
    // 同一行的子菜单已开 → 仅校正位置（行间折返不重建不闪烁）
    if (_subEl && _subKey === key && _subEl.parentNode) { _markActiveRow(rowEl); _positionSub(rowEl); return; }
    _removeSub(); // 注: 会清 active 标记 —— 必须先于 _markActiveRow
    _markActiveRow(rowEl);
    var sub = document.createElement('div');
    sub.className = 'qqq-help-sub';
    var rows = _subRows(key);
    rows.forEach(function (r) {
      var el = document.createElement('div');
      if (key === 'contact') {
        el.className = 'qqq-help-sub-row qqq-help-contact';
        var lb = document.createElement('span');
        lb.className = 'qqq-help-contact-label';
        lb.textContent = r.label;
        var vl = document.createElement('span');
        vl.className = 'qqq-help-contact-val';
        vl.textContent = r.value;
        el.appendChild(lb);
        el.appendChild(vl);
        el.addEventListener('click', function () { _copyValue(r.label, r.value); });
      } else {
        el.className = 'qqq-help-sub-row' + (r.bold ? ' bold' : '');
        el.textContent = r.label;
        el.addEventListener('click', function () { _openExternal(r.url); });
      }
      sub.appendChild(el);
    });
    sub.addEventListener('mouseenter', _clearTimers);
    sub.addEventListener('mouseleave', _scheduleAll);
    document.body.appendChild(sub);
    _subEl = sub;
    _subKey = key;
    _positionSub(rowEl);
  }

  function _removeSub() {
    if (_subEl) { try { _subEl.remove(); } catch (e) { } _subEl = null; }
    _subKey = null;
    for (var i = 0; i < _rootRowEls.length; i++) {
      try { _rootRowEls[i].el.classList.remove('active'); } catch (e) { }
    }
  }

  function _closeAll() {
    _clearTimers();
    _removeSub();
    _removeRoot();
    if (_btnEl) { try { _btnEl.classList.remove('qqq-help-open'); } catch (e) { } }
    _unbindGlobal();
  }

  // ── 动作 ──
  function _openExternal(url) {
    _closeAll();
    try {
      var br = window.qqqideBridge;
      if (br && br.shell && typeof br.shell.openExternal === 'function') {
        br.shell.openExternal(url);
        return;
      }
    } catch (e) { }
    try { window.open(url, '_blank'); } catch (e) { }
  }

  function _legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { }
  }

  function _copyValue(label, value) {
    _closeAll();
    var done = function () {
      try {
        if (window.qqqideQoast && typeof window.qqqideQoast.show === 'function') {
          window.qqqideQoast.show(label + ' ' + value + ' ' + _i('help.copied', '已复制'), { type: 'success', duration: 5000 });
        }
      } catch (e) { }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () { _legacyCopy(value); done(); });
      } else {
        _legacyCopy(value);
        done();
      }
    } catch (e) {
      _legacyCopy(value);
      done();
    }
  }

  // ── 挂载（gaea-host renderTabBar 调用；工具栏重建即先复位，防孤儿菜单） ──
  function mount(tabBarEl) {
    if (!tabBarEl) return;
    _closeAll();
    if (_btnEl && _btnEl.parentNode === tabBarEl) return; // 防御：已在（理论不发生）
    _ensureStyle();
    var btn = document.createElement('button');
    btn.className = 'gaea-tab-btn qqq-help-btn';
    btn.textContent = 'help';
    btn.style.cssText =
      'height:22px; padding:0 10px; margin:0 1px; border:1px solid var(--border-color); border-radius:3px;' +
      'background:transparent; color:var(--text-primary); font-size:12px;' +
      'transition: background 0.15s;';
    btn.addEventListener('mouseenter', function () { _clearTimers(); _showRoot(); });
    btn.addEventListener('mouseleave', _scheduleAll);
    tabBarEl.appendChild(btn);
    _btnEl = btn;
  }

  window.qqqHelpMenu = { mount: mount, close: _closeAll };
})();
