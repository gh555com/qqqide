// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// help-menu.js — 菜单行2 help 按钮（inbox 右边）· 数据驱动多级菜单（hover 逐级展开）
//
// 数据源（唯一真理）: {Data}/help-menu.json（Data = 运行时数据目录，boot:info.userData 解析；
//   缺失/损坏 → 内置默认树 DEFAULT_TREE 兜底。读取走 bridge.fs.read（编码机器）。
//   编辑器: op/帮助菜单编辑器.py（可视化增删改查 + 拖拽调级排序；保存后本机下次打开菜单即生效）。
// schema v1: { v:1, items:[ { label, i18n?, action?, value?, qoast?, bold?, hideValue?, children?[] } ] }
//   action 空/缺省 = 无动作（纯目录或纯文本行）｜url 打开网址｜copy 复制 + qoast｜
//   command 内置动作（命令表 COMMANDS，与 op 工具清单镜像）｜download 下载文件（走下载机）｜
//   image 图片/二维码悬浮预览（shell-overlay open-image）｜separator 分隔线
//   渲染: 有 children 才画箭头（没有 = 啥也不打）；hover 逐级展开（无限级）；单击 = 执行本行行为。
//   文案: 有 i18n 键则按语言显示（label 为回退），否则 label 原样。
//
// 挂载点: gaea-host.js renderTabBar() 尾部 → window.qqqHelpMenu.mount(#qqq-goods-bar)
//         （工具栏每次重建（goods 注册/切换/移除）自动重挂；mount 内先 close 防孤儿菜单）
// 默认树内容三处同源: 本文件 DEFAULT_TREE ↔ Data/help-menu.json ↔ op 工具内置种子
// 打开方式: 一律系统外部浏览器（bridge.shell.openExternal，window.open 兜底）
// 交互: 纯 hover（进入即展开，250ms 延迟关闭）；Esc / 点击别处 / 窗口 resize 即关；
//       全按钮与菜单行零自定义 cursor（光标铁律）
// ★ openAt(anchorEl)（2026-10-02）: 菜单重锚入口——「⋯ 收纳机器」（core/shell-menu-fit.js）
//   的 help 行 hover 级联调用；锚定为菜单行按钮（缺省）时行为零变化，锚定其它元素时
//   改「行右侧级联」定位并返回根元素（菜单本体 100% 复用，禁第二实现）
// ============================================================================

; (function () {
  'use strict';

  var PAGE = 'https://www.gh555.com/gaea/d/qqqide';
  var LIVE_URL = 'https://live.bilibili.com/23005203';

  // ★ 视频策展清单（仅默认树兜底用；日常维护改 Data/help-menu.json）
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
  var DATA_FILE = 'help-menu.json';
  var TREE_TTL_MS = 1000;   // 新鲜度窗口：打开菜单时距上次读取超窗才后台刷新（防 hover 级联刷屏）
  var MAX_DEPTH = 20;       // 防御：异常深树截断（正常使用远达不到）
  var VALID_ACTIONS = ['', 'url', 'copy', 'command', 'download', 'image', 'separator'];

  // ★ 默认树（文件缺失兜底；内容与 Data/help-menu.json、op 工具种子三处同源）
  var DEFAULT_TREE = {
    v: 1,
    items: [
      { label: 'live', action: 'url', value: LIVE_URL },
      {
        label: 'contact', children: [
          { label: 'QQ', action: 'copy', value: '524906522' },
          { label: '邮箱', i18n: 'help.email', action: 'copy', value: 'info@gh555.com' },
          { label: '电话号码', i18n: 'help.phone', action: 'copy', value: '+86 19232854249' }
        ]
      },
      {
        label: 'video', children: HELP_VIDEOS.map(function (v) {
          return { label: v.t, action: 'url', value: v.u };
        })
      },
      {
        label: 'community', children: [
          { label: '评论', i18n: 'help.comments', action: 'url', value: PAGE + '#comments' },
          { label: '更新日志', i18n: 'help.changelog', action: 'url', value: PAGE + '#changelog' },
          { label: '公告', i18n: 'help.announcements', action: 'url', value: PAGE + '#announcements' },
          { label: '官方文档', i18n: 'help.docs', bold: true, action: 'url', value: PAGE + '#docs/add-project' },
          { label: '活动', i18n: 'help.activity', action: 'url', value: PAGE + '#video' }
        ]
      }
    ]
  };

  // ★ 内置动作表（command 行为可选项；与 op/帮助菜单编辑器.py 内清单镜像同步——改一处必须同改另一处）
  var COMMANDS = {
    'settings': {
      run: function () { try { if (window.qqqSettings && window.qqqSettings.open) window.qqqSettings.open(); } catch (e) { } }
    },
    'logs': { run: function () { _openDir('logs'); } },
    'data-dir': { run: function () { _openDir('data'); } },
    'install-dir': { run: function () { _openDir('root'); } }
  };

  var _btnEl = null;
  var _anchorEl = null;     // 动态锚点（openAt 用；缺省 = _btnEl）
  var _rootEl = null;       // 主菜单
  var _chain = [];          // 打开的逐级子菜单链：_chain[level] = {rowEl, subEl}（level 行的子菜单落于此）
  var _tree = { v: 1, items: _normList(DEFAULT_TREE.items) };   // ★ 恒为 {v,items} 形状（数组形状会让 _tree.items 为 undefined → 首开必炸）
  var _treeTs = 0;          // 上次读取数据文件的墙钟
  var _fetching = false;
  var _parseWarned = false; // 解析失败只提示一次（禁静默：失败必须可见）
  var _renderWarned = false; // 渲染异常回退只提示一次
  var _bootPromise = null;  // boot:info 缓存（Data/Logs/安装目录）
  var _allTimer = null;     // 整体关闭计时器
  var _globalBound = false;

  function _i(key, fb) { try { return window._i ? window._i(key, fb) : fb; } catch (e) { return fb; } }
  function _bridge() { try { return window.qqqideBridge || null; } catch (e) { return null; } }
  function _labelOf(item) { return item.i18n ? _i(item.i18n, item.label || item.i18n) : (item.label || '\u2014'); }

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
      '.qqq-help-row, .qqq-help-sub-row { display: flex; align-items: center; padding: 7px 12px; color: var(--text-primary, #586e75); }',
      '.qqq-help-row:hover, .qqq-help-row.active, .qqq-help-sub-row:hover, .qqq-help-sub-row.active { background: var(--hover-bg, rgba(0,0,0,0.06)); }',
      '.qqq-help-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.qqq-help-arrow { margin-left: auto; padding-left: 16px; opacity: .55; font-size: 12px; }',
      '.qqq-help-sub-row.bold { font-weight: 700; }',
      '.qqq-help-contact-label { flex: 0 0 auto; min-width: 58px; opacity: .85; margin-right: 10px; }',
      '.qqq-help-contact-val { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.qqq-help-sep { height: 0; border-top: 1px solid var(--border-color, #d6d6d6); margin: 4px 8px; opacity: .7; }'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── 计时器 ──
  function _clearTimers() {
    if (_allTimer) { clearTimeout(_allTimer); _allTimer = null; }
  }
  function _scheduleAll() {
    _clearTimers();
    _allTimer = setTimeout(_closeAll, HOVER_CLOSE_DELAY);
  }

  // ── 全局收尾监听（外点关闭 / Esc / resize） ──
  function _containsAny(t) {
    if (!t) return false;
    if (_rootEl && _rootEl.contains(t)) return true;
    if (_btnEl && _btnEl.contains(t)) return true;
    if (_anchorEl && _anchorEl.contains(t)) return true;
    for (var i = 0; i < _chain.length; i++) {
      var e = _chain[i];
      if (e && e.subEl && e.subEl.contains(t)) return true;
    }
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

  // ── 数据加载（文件 → 归一化树；缺失/损坏保底） ──
  function _normNode(n, depth) {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return null;
    var action = (typeof n.action === 'string') ? n.action.toLowerCase() : '';
    if (VALID_ACTIONS.indexOf(action) < 0) { action = ''; }   // 未识别 → 退化为惰性行（不误伤数据）
    var item = {
      label: (typeof n.label === 'string') ? n.label : '',
      i18n: (typeof n.i18n === 'string') ? n.i18n : '',
      action: action,
      value: (typeof n.value === 'string') ? n.value : '',
      qoast: (typeof n.qoast === 'string') ? n.qoast : '',
      bold: !!n.bold,
      hideValue: !!n.hideValue,
      children: []
    };
    if (Array.isArray(n.children)) {
      for (var i = 0; i < n.children.length; i++) {
        var c = _normNode(n.children[i], depth + 1);
        if (c) item.children.push(c);
      }
    }
    if (!item.label && !item.i18n && item.action !== 'separator' && !item.children.length) return null;
    return item;
  }
  function _normList(raw) {
    var out = [];
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        var n = _normNode(raw[i], 1);
        if (n) out.push(n);
      }
    }
    return out;
  }
  function _parseTree(text) {
    var s = String(text).replace(/^\uFEFF/, '').trim();
    if (!s) return null;
    var obj;
    try { obj = JSON.parse(s); } catch (e) { return null; }
    var raw = (obj && Array.isArray(obj.items)) ? obj.items : (Array.isArray(obj) ? obj : null);
    if (!raw) return null;
    return { v: 1, items: _normList(raw) };
  }
  function _bootInfo() {
    if (_bootPromise) return _bootPromise;
    _bootPromise = new Promise(function (resolve) {
      var br = _bridge();
      if (!br || !br.boot || !br.boot.getInfo) { resolve(null); return; }
      br.boot.getInfo().then(function (info) { resolve(info || null); }, function () { resolve(null); });
    });
    return _bootPromise;
  }
  function _fetchTree() {
    if (_fetching) return;
    _fetching = true;
    _treeTs = Date.now();
    _bootInfo().then(function (info) {
      var dir = (info && (info.userData || info.dataDir)) || '';
      var br = _bridge();
      if (!dir || !br || !br.fs || !br.fs.read) return null;
      return br.fs.read(String(dir).replace(/[\\/]+$/, '') + '/' + DATA_FILE);
    }).then(function (text) {
      _fetching = false;
      if (typeof text !== 'string' || !text) return;   // 文件不存在 → 保持内置默认
      var t = _parseTree(text);
      if (!t) {
        try { console.warn('[qqqHelpMenu] ' + DATA_FILE + ' 解析失败，沿用当前菜单'); } catch (e) { }
        if (!_parseWarned) {
          _parseWarned = true;
          try {
            if (window.qqqideQoast && window.qqqideQoast.show) {
              window.qqqideQoast.show('[help] ' + DATA_FILE + ' 格式有误，已临时回退内置默认菜单', { type: 'error', duration: 12000 });
            }
          } catch (e) { }
        }
        return;
      }
      if (!t.items.length) {
        try { console.warn('[qqqHelpMenu] ' + DATA_FILE + ' 为空（items: []），沿用内置默认'); } catch (e) { }
        return;
      }
      _tree = t;
      if (_rootEl && _rootEl.parentNode) _rebuildOpen();   // 开着菜单 → 当场换新（编辑器保存即可见）
    }).catch(function () { _fetching = false; });
  }
  function _kickRefresh() {
    var now = Date.now();
    if (!_fetching && (now - _treeTs) > TREE_TTL_MS) _fetchTree();
  }

  // ── 行渲染（统一构建器：有无 children 决定箭头；行为决定整行内容与点击） ──
  function _buildRow(item, level) {
    var row = document.createElement('div');
    if (item.action === 'separator') {
      row.className = 'qqq-help-sep';
      return row;
    }
    row.className = (level === 0) ? 'qqq-help-row' : 'qqq-help-sub-row';
    if (item.bold) row.className += ' bold';
    var hasKids = !!(item.children && item.children.length);
    if (item.action === 'copy' && item.value && !item.hideValue) {
      // 联系方式行：名称 + 值两列（点击复制 + qoast）
      row.className += ' qqq-help-contact';
      var lb = document.createElement('span');
      lb.className = 'qqq-help-contact-label';
      lb.textContent = _labelOf(item);
      var vl = document.createElement('span');
      vl.className = 'qqq-help-contact-val';
      vl.textContent = item.value;
      row.appendChild(lb);
      row.appendChild(vl);
    } else {
      var lab = document.createElement('span');
      lab.className = 'qqq-help-label';
      lab.textContent = _labelOf(item);
      row.appendChild(lab);
    }
    if (hasKids) {
      var arr = document.createElement('span');
      arr.className = 'qqq-help-arrow';
      arr.textContent = '\u203A';
      row.appendChild(arr);
    }
    row.addEventListener('mouseenter', function () { _rowEnter(item, row, level); });
    row.addEventListener('click', function () { _rowClick(item); });
    return row;
  }

  // 当前生效条目：数据文件给了非空树就用它，否则恒回内置默认（空树/坏树绝不接管 → 防空白菜单）
  function _items() {
    if (_tree && Array.isArray(_tree.items) && _tree.items.length) return _tree.items;
    return _normList(DEFAULT_TREE.items);
  }

  function _buildMenu(items, cls, level) {
    var el = document.createElement('div');
    el.className = cls;
    if (!Array.isArray(items)) items = _items();
    for (var i = 0; i < items.length; i++) el.appendChild(_buildRow(items[i], level));
    return el;
  }

  function _buildRoot() {
    var root = _buildMenu(_items(), 'qqq-help-menu', 0);
    root.addEventListener('mouseenter', _clearTimers);
    root.addEventListener('mouseleave', _scheduleAll);
    return root;
  }

  function _anchorCur() { return _anchorEl || _btnEl; }

  // 定位：菜单行按钮（缺省）→ 按钮下方；⋯ 收纳行动态锚点 → 行右侧级联（放不下翻左/上收）
  function _positionRoot() {
    var anchor = _anchorCur();
    if (!_rootEl || !anchor) return;
    var r = anchor.getBoundingClientRect();
    var w = _rootEl.offsetWidth || 148, h = _rootEl.offsetHeight || 100;
    var left, top;
    if (anchor === _btnEl) {
      left = r.left;
      if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      if (left < 8) left = 8;
      top = r.bottom + 4;
      if (top + h > window.innerHeight - 8) top = Math.max(4, r.top - h - 4);
    } else {
      left = r.right + 4;
      if (left + w > window.innerWidth - 8) left = r.left - w - 4;
      if (left < 8) left = 8;
      top = r.top;
      if (top + h > window.innerHeight - 8) top = Math.max(4, window.innerHeight - h - 8);
    }
    _rootEl.style.left = left + 'px';
    _rootEl.style.top = top + 'px';
  }

  // 子菜单定位：右贴父面板（放不下翻左）、纵向对齐本行（越界钳回）
  function _positionSub(entry, level) {
    if (!entry || !entry.subEl || !entry.rowEl) return;
    var sub = entry.subEl;
    var parentEl = (level === 0) ? _rootEl : (_chain[level - 1] && _chain[level - 1].subEl);
    if (!parentEl) return;
    var pr = parentEl.getBoundingClientRect();
    var rr = entry.rowEl.getBoundingClientRect();
    var w = sub.offsetWidth || 180, h = sub.offsetHeight || 120;
    var left = pr.right + 2;
    if (left + w > window.innerWidth - 8) left = pr.left - w - 2;
    if (left < 8) left = 8;
    var top = rr.top;
    if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    if (top < 4) top = 4;
    sub.style.left = left + 'px';
    sub.style.top = top + 'px';
  }

  function _showRoot() {
    var anchor = _anchorCur();
    if (!anchor) return;
    try { _kickRefresh(); } catch (e0) { }
    if (_rootEl && _rootEl.parentNode) { _positionRoot(); return; } // 已开：重定位（⋯ 行间切换复用）
    try {
      _ensureStyle();
      _truncateChain(0);
      _removeRoot();
      var root = _buildRoot();
      document.body.appendChild(root);
      _rootEl = root;
      _positionRoot();
      requestAnimationFrame(function () { if (_rootEl) _rootEl.classList.add('open'); });
      try { anchor.classList.add('qqq-help-open'); } catch (e) { }
      _bindGlobal();
    } catch (e) {
      // ★ 渲染异常绝不静默成「啥也没有」：回内置默认树重试一次 + 一次性可见提示
      try { console.error('[qqqHelpMenu] 渲染失败，已回退内置默认菜单：', e); } catch (er) { }
      _tree = { v: 1, items: _normList(DEFAULT_TREE.items) };
      try {
        _truncateChain(0);
        _removeRoot();
        var root2 = _buildRoot();
        document.body.appendChild(root2);
        _rootEl = root2;
        _positionRoot();
        root2.classList.add('open');
        anchor.classList.add('qqq-help-open');
        _bindGlobal();
      } catch (e2) { try { console.error('[qqqHelpMenu] 回退渲染仍失败：', e2); } catch (er2) { } }
      if (!_renderWarned) {
        _renderWarned = true;
        try {
          if (window.qqqideQoast && window.qqqideQoast.show) {
            window.qqqideQoast.show('[help] 菜单渲染异常，已回退内置默认', { type: 'error', duration: 12000 });
          }
        } catch (er3) { }
      }
    }
  }

  // ★ ⋯ 收纳机器唯一外接口: 重锚到任意元素打开（返回根元素；重复调用 = 重定位复用）
  function openAt(anchorEl) {
    if (!anchorEl) return null;
    if (_anchorEl && _anchorEl !== anchorEl) { try { _anchorEl.classList.remove('qqq-help-open'); } catch (e) { } }
    _anchorEl = anchorEl;
    _clearTimers();
    _showRoot();
    return _rootEl;
  }

  function _removeRoot() {
    if (_rootEl) { try { _rootEl.remove(); } catch (e) { } _rootEl = null; }
  }

  // ── 逐级子菜单链 ──
  function _truncateChain(from) {
    for (var i = _chain.length - 1; i >= from; i--) {
      var e = _chain[i];
      if (!e) continue;
      try { if (e.subEl) e.subEl.remove(); } catch (er) { }
      try { if (e.rowEl) e.rowEl.classList.remove('active'); } catch (er) { }
      _chain[i] = null;
    }
    if (_chain.length > from) _chain.length = from;
  }

  function _markActive(rowEl) {
    var parent = rowEl.parentNode;
    if (parent) {
      var rows = parent.querySelectorAll('.qqq-help-row.active, .qqq-help-sub-row.active');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('active');
    }
    try { rowEl.classList.add('active'); } catch (e) { }
  }

  function _rowEnter(item, rowEl, level) {
    _clearTimers();
    var same = !!(_chain[level] && _chain[level].rowEl === rowEl);
    _truncateChain(level + (same ? 1 : 0));   // 同行走深清（保留本行子菜单）；换行从本层重开
    if (same) return;
    if (item.children && item.children.length) _openSub(item, rowEl, level);
  }

  function _openSub(item, rowEl, level) {
    var sub = _buildMenu(item.children, 'qqq-help-sub', level + 1);
    sub.addEventListener('mouseenter', _clearTimers);
    sub.addEventListener('mouseleave', _scheduleAll);
    document.body.appendChild(sub);
    var entry = { rowEl: rowEl, subEl: sub };
    _chain[level] = entry;
    _markActive(rowEl);
    _positionSub(entry, level);
    requestAnimationFrame(function () { if (_chain[level] === entry) sub.classList.add('open'); });
  }

  function _closeAll() {
    _clearTimers();
    _truncateChain(0);
    _removeRoot();
    var a = _anchorCur();
    if (a) { try { a.classList.remove('qqq-help-open'); } catch (e) { } }
    _anchorEl = null;
    _unbindGlobal();
  }

  // 数据更新时的原地重建（保持锚点与开启态）
  function _rebuildOpen() {
    var anchor = _anchorCur();
    if (!_rootEl || !_rootEl.parentNode) return;
    _truncateChain(0);
    _removeRoot();
    var root = _buildRoot();
    document.body.appendChild(root);
    _rootEl = root;
    _positionRoot();
    if (anchor) { try { anchor.classList.add('qqq-help-open'); } catch (e) { } }
    requestAnimationFrame(function () { if (_rootEl) _rootEl.classList.add('open'); });
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

  function _copyValue(label, value, tpl) {
    _closeAll();
    var done = function () {
      var msg;
      if (tpl) {
        msg = String(tpl).replace(/\{value\}/g, value).replace(/\{label\}/g, label);
      } else {
        msg = label + ' ' + value + ' ' + _i('help.copied', '已复制');
      }
      try {
        if (window.qqqideQoast && typeof window.qqqideQoast.show === 'function') {
          window.qqqideQoast.show(msg, { type: 'success', duration: 5000 });
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

  function _openDir(which) {
    _bootInfo().then(function (info) {
      if (!info) return;
      var p = (which === 'logs') ? info.logsDir : (which === 'data') ? (info.userData || info.dataDir) : info.appRoot;
      if (!p) return;
      try {
        var br = _bridge();
        if (br && br.shell && br.shell.openPath) br.shell.openPath(p);
      } catch (e) { }
    });
  }

  function _runCommand(id) {
    _closeAll();
    var c = COMMANDS[id];
    if (!c) { try { console.warn('[qqqHelpMenu] 未知内置动作: ' + id); } catch (e) { } return; }
    try { c.run(); } catch (e) { }
  }

  function _fileNameFromUrl(u) {
    try {
      var s = String(u).split(/[?#]/)[0];
      var seg = (s.split('/').pop() || '');
      try { seg = decodeURIComponent(seg); } catch (e2) { }
      return /\.[a-z0-9]{1,8}$/i.test(seg) ? seg : '';
    } catch (e) { return ''; }
  }

  function _download(url) {
    _closeAll();
    try {
      if (window.qqqideDownload && typeof window.qqqideDownload.save === 'function') {
        window.qqqideDownload.save(url, _fileNameFromUrl(url), {});   // 统一下载机（对话框/进度/重名不覆盖）
        return;
      }
    } catch (e) { }
    try {
      var br = _bridge();
      if (br && br.download && br.download.start) { br.download.start({ url: url }); return; }
    } catch (e) { }
    _openExternal(url);
  }

  function _showImage(v) {
    _closeAll();
    var val = String(v == null ? '' : v);
    var src = v, local = null;
    // 本机绝对路径（盘符 / UNC / POSIX）→ 唯一机器规范成 file URL；'//' 开头为协议相对 URL，不收
    if (/^[a-zA-Z]:[\\/]/.test(val) || /^\\\\/.test(val) || (val.charAt(0) === '/' && val.charAt(1) !== '/')) {
      local = v;
      src = window.qqqFileUrl(val);
    }
    try { window.postMessage({ type: 'qqqide-overlay', action: 'open-image', src: src, localPath: local }, '*'); } catch (e) { }
  }

  function _rowClick(item) {
    var act = item.action;
    if (act === 'url' && item.value) { _openExternal(item.value); return; }
    if (act === 'copy' && item.value) { _copyValue(_labelOf(item), item.value, item.qoast); return; }
    if (act === 'command' && item.value) { _runCommand(item.value); return; }
    if (act === 'download' && item.value) { _download(item.value); return; }
    if (act === 'image' && item.value) { _showImage(item.value); return; }
    if (item.children && item.children.length) return;   // 纯目录行：点击不做事（hover 已展开）
    _closeAll();                                          // 纯文本行：点击仅收起
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
    btn.addEventListener('mouseenter', function () { _anchorEl = null; _clearTimers(); _showRoot(); });
    btn.addEventListener('mouseleave', _scheduleAll);
    tabBarEl.appendChild(btn);
    _btnEl = btn;
    _kickRefresh();   // 预热：首次 hover 之前先读一次数据文件（首开即最新）
  }

  // 手动刷新数据（调试/工具联动用；正常无需调用——打开菜单自动按 TTL 刷新）
  function reload() { _treeTs = 0; _fetchTree(); }

  // 自检（调试/工具联动用）：当前生效条目数 + 是否已落数据文件 + 最近一次渲染错误
  function diag() {
    return { items: _items().length, treeItems: _tree.items.length, mounted: !!_btnEl, open: !!(_rootEl && _rootEl.parentNode) };
  }

  window.qqqHelpMenu = { mount: mount, close: _closeAll, openAt: openAt, reload: reload, diag: diag };
})();
