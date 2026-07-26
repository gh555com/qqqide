// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// gaea-host.js — Gaea Goods Host (v2)
//
// A-Zone host that manages pluggable goods.
//
// Goods Protocol v2 (current). Add `protoVer: 2` to opt in.
// v1 goods (no protoVer) work forever — host maps legacy fields automatically.
//
//   window.qqqGaea.register({
//     id: 'rage',
//     title: 'Rage',
//     version: '1.0.0',
//     protoVer: 2,   // optional, defaults to 1
//     type: 'process',           // 'panel' (default) | 'process' (后台进程)
//     lifecycle: 'attached',     // 'attached'=随主窗口生死(默认) | 'independent'=独立程序
//     panel: { build(host, ctx) {} },           // A-zone main panel
//     tabs: { 'roam': { title:'Roam', build(host,ctx){} } },  // X-zone gaea tabs
//     services: { 'paste': { start(ctx){}, stop(){} } },       // background
//     commands: ['rage.exportDoc'],
//     provides: ['audio'],                      // cross-goods exports (reserved)
//     uses: [],                                 // cross-goods deps (reserved)
//   })
//
//   ctx = { bridge, monaco, state, onCommand }
//
// Legacy compat: { url } or { build } or { render } → mapped to panel.
// ============================================================================
(function () {
  'use strict';

  const bridge = window.qqqideBridge;
  const goods = new Map();       // id -> def (full manifest)
  const instances = new Map();   // id -> { iframe?, el?, destroy?, services:Map, tabs:Map }
  let _activeId = null;
  let _hostEl = null;
  let _contentEl = null;
  let _tabBarEl = null;
  let _switcherEl = null;
  let _ghHealthEl = null;
  let _built = false;
  const _pendingShow = [];
  // ★ A 区默认面板
  var _defaultPanelId = 'kope-a';

  // ---- ctx factory ----
  function makeCtx(id) {
    return {
      bridge: bridge,
      monaco: window.qqqEditor || null,
      state: (window.qgs && window.qgs.simple)
        ? window.qgs.simple(id, { cloud: true })
        : { get(){return Promise.resolve(null);}, set(){return Promise.resolve(false);} },
      onCommand(cmd, data) {
        document.dispatchEvent(new CustomEvent('qqq-command', { detail: { cmd, ...(data||{}) } }));
      },
    };
  }

  // ---- Build DOM ----
  function build(mount) {
    _hostEl = mount;
    _hostEl.innerHTML = '';
    _hostEl.style.cssText = 'height:100%; display:flex; flex-direction:column; overflow:hidden;';

    // ★ A 区顶部 — 货物切换下拉
    _switcherEl = document.createElement('div');
    _switcherEl.className = 'gaea-zone-switcher';
    _hostEl.appendChild(_switcherEl);

    // Tab bar moved to menu row 2 (qqq-goods-bar)
    _tabBarEl = document.getElementById('qqq-goods-bar');

    _contentEl = document.createElement('div');
    _contentEl.className = 'gaea-panel-body';
    _contentEl.style.cssText = 'flex:1; overflow:hidden; position:relative;';
    _hostEl.appendChild(_contentEl);

    // ★ GH Health 商标位 — A 区固定底部，独立于任何 goods
    _ghHealthEl = document.createElement('div');
    _ghHealthEl.className = 'gaea-gh-health';
    _ghHealthEl.textContent = 'GH HEALTH';
    _ghHealthEl.style.cssText = 'flex:0 0 auto; text-align:center; padding:9px 0; font-size:9px; opacity:0.5; cursor:pointer; font-family:Tahoma,sans-serif;';
    _ghHealthEl.addEventListener('click', function () {
      var br = window.qqqideBridge;
      if (br && br.shell && br.shell.openExternal) {
        br.shell.openExternal('https://www.gh555.com/gaea/d/qqqide');
      }
    });
    _hostEl.appendChild(_ghHealthEl);

    _built = true;

    _renderSwitcher();

    const pending = _pendingShow.splice(0);
    pending.forEach(id => show(id));
    // ★ 确保 Roam tab 在 gaea 分组中存在（rage 已完成注册）
    if (window.qqqTabs && window.qqqTabs.ensureRoamTab) {
      window.qqqTabs.ensureRoamTab();
    }
  }

  // ---- Tab bar (renders into menu row 2 toolbar) ----
  // ★ 菜单行2 仅 Search / Git 按钮（均无 A 区面板，点不切换 A 区）
  function renderTabBar() {
    if (!_tabBarEl) return;
    _tabBarEl.innerHTML = '';
    var toolbarIds = ['search', 'git'];
    for (var ti = 0; ti < toolbarIds.length; ti++) {
      var id = toolbarIds[ti];
      if (!goods.has(id)) continue;
      var def = goods.get(id);
      var btn = document.createElement('button');
      btn.className = 'gaea-tab-btn qqq-goods-btn';
      btn.textContent = def.title || id;
      btn.dataset.gaeaId = id;
      btn.title = def.title || id;
      btn.style.cssText =
        'height:22px; padding:0 10px; margin:0 1px; border:1px solid var(--border-color); border-radius:3px;' +
        'background:transparent;' +
        'color:var(--text-primary);' +
        'transition: background 0.15s;';
      (function (gid) {
        btn.addEventListener('click', function () { open(gid); });
      })(id);
      _tabBarEl.appendChild(btn);
    }
  }

  // ---- Show ----
  function show(id) {
    if (!goods.has(id)) return;
    if (!_built) { if (!_pendingShow.includes(id)) _pendingShow.push(id); return; }

    // Hide current
    if (_activeId && instances.has(_activeId)) {
      const inst = instances.get(_activeId);
      if (inst.iframe) inst.iframe.style.display = 'none';
      if (inst.el) inst.el.style.display = 'none';
    }

    // Create instance if first time
    if (!instances.has(id)) {
      const def = goods.get(id);
      const ctx = makeCtx(id);
      const inst = { services: new Map(), tabs: new Map(), destroy: null };

      // --- panel (A zone) ---
      const panelDef = def.panel || {};
      const panelBuild = panelDef.build || panelDef.render || def.build || def.render;
      const panelUrl = panelDef.url || def.url;

      if (panelUrl) {
        const iframe = document.createElement('iframe');
        iframe.src = panelUrl;
        iframe.style.cssText = 'width:100%; height:100%; border:none; overflow:hidden;';
        iframe.setAttribute('frameborder', '0');
        _contentEl.appendChild(iframe);
        inst.iframe = iframe;
      } else if (typeof panelBuild === 'function') {
        const el = document.createElement('div');
        el.style.cssText = 'width:100%; height:100%; overflow:hidden;';
        _contentEl.appendChild(el);
        inst.el = el;
        inst.destroy = panelBuild(el, ctx) || null;
      }

      // --- services ---
      if (def.services && typeof def.services === 'object') {
        Object.keys(def.services).forEach(svcName => {
          const svc = def.services[svcName];
          if (typeof svc.start === 'function') {
            try { svc.start(ctx); } catch(e) { console.warn('[gaea-host] service start error:', svcName, e); }
          }
          inst.services.set(svcName, svc);
        });
      }

      // --- tabs (X zone gaea group) ---
      if (def.tabs && typeof def.tabs === 'object' && window.qqqTabs) {
        Object.keys(def.tabs).forEach(tabId => {
          const tabDef = def.tabs[tabId];
          if (typeof tabDef.build === 'function') {
            const tab = window.qqqTabs.addGaeaTab(tabId, tabDef.title || tabId, tabDef.build, { closable: tabDef.closable !== false });
            if (tab) inst.tabs.set(tabId, tab);
          }
        });
      }

      // --- commands ---
      if (Array.isArray(def.commands)) {
        def.commands.forEach(cmd => {
          if (typeof def[cmd] === 'function') {
            document.addEventListener('qqq-command', (e) => {
              if (e.detail && e.detail.cmd === cmd) { try { def[cmd](ctx); } catch(ex) { /* ignore */ } }
            });
          }
        });
      }

      // --- provides / uses (reserved, no-op for now) ---
      inst._provides = def.provides || [];
      inst._uses = def.uses || [];

      instances.set(id, inst);
    }

    // Show target
    const inst = instances.get(id);

    // ★ 确保 X 区 gaea tabs 存在（首次注册 / 被关闭后重建 / 竞态修复）
    if (window.qqqTabs) {
      const def2 = goods.get(id);
      if (def2 && def2.tabs && typeof def2.tabs === 'object') {
        const gaeaGrp = window.qqqTabs.getGaeaGroup ? window.qqqTabs.getGaeaGroup() : null;
        Object.keys(def2.tabs).forEach(tabId => {
          const alreadyInDOM = gaeaGrp && gaeaGrp.tabs && gaeaGrp.tabs.some(function(t) { return t.gaeaId === tabId; });
          if (alreadyInDOM) return;
          const tabDef = def2.tabs[tabId];
          if (typeof tabDef.build === 'function') {
            var ct = window.qqqTabs.addGaeaTab(tabId, tabDef.title || tabId, tabDef.build, { closable: tabDef.closable !== false });
            if (ct) inst.tabs.set(tabId, ct);
          }
        });
      }
    }

    if (inst.iframe) inst.iframe.style.display = '';
    if (inst.el) inst.el.style.display = '';

    _activeId = id;
    renderTabBar();
    _renderSwitcher();
    _persistActive();
  }

  // ---- Open (manifest-driven routing, 2026-07-14) ----
  // 统一入口：根据 goods manifest 自动路由到 panel(A区) 或 tabs(X区)。
  // 消费者只需调 qqqGaea.open(id, opts)，不再硬编码 show()/addGaeaTab()。
  // opts.questId / opts.panelId — 透传给动态 tab 创建（如 conv 每 quest 独立标签）。
  function open(id, opts) {
    opts = opts || {};
    if (!goods.has(id)) return false;
    var def = goods.get(id);

    // ① Panel 路由（A 区）
    if (def.panel && (def.panel.build || def.panel.url || def.panel.render)) {
      show(id);
    }

    // ② Tab 路由（X 区 gaea 分组）— 静态 tabs（manifest 声明）
    if (def.tabs && typeof def.tabs === 'object' && window.qqqTabs) {
      var gaeaGrp = window.qqqTabs.getGaeaGroup ? window.qqqTabs.getGaeaGroup() : null;
      var tabIds = Object.keys(def.tabs);
      for (var ti = 0; ti < tabIds.length; ti++) {
        var tid = tabIds[ti];
        var already = gaeaGrp && gaeaGrp.tabs && gaeaGrp.tabs.some(function (t) { return t.gaeaId === tid; });
        if (already) continue;
        var tabDef = def.tabs[tid];
        if (typeof tabDef.build === 'function') {
          window.qqqTabs.addGaeaTab(tid, tabDef.title || tid, tabDef.build, { closable: tabDef.closable !== false });
        }
      }
      // 激活第一个 tab
      if (tabIds.length > 0 && gaeaGrp) {
        var g2 = window.qqqTabs.getGaeaGroup ? window.qqqTabs.getGaeaGroup() : gaeaGrp;
        var ft = g2 && g2.tabs && g2.tabs.find(function (t) { return t.gaeaId === tabIds[0]; });
        if (ft && g2.activeTabId !== ft.id) {
          window.qqqTabs.activateTab(g2, ft.id);
        }
      }
    }

    // ③ 动态 tab（provides 声明 'tab:xxx'，每 quest 独立标签）
    //    由消费者（如 AI 面板「管理」按钮）自行调用 addGaeaTab，
    //    本函数仅做路由提示。

    return true;
  }

  function _folderFromUrl() {
    var m = window.location.search.match(/[?&]folder=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]).replace(/\\/g, '/').replace(/\/$/, ''); }
      catch (_) { }
    }
    return null;
  }

  function _persistActive() {
    try {
      var root = window._workspaceRoot || _folderFromUrl();
      if (!root || !_activeId || !window.qgs || typeof window.qgs.project !== 'function') return;
      var db = window.qgs.project(root + '/qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
      if (db) db.set('editor.aZoneActive', _activeId).catch(function () { });
    } catch (_) { }
  }

  function _restoreActive() {
    try {
      var root = window._workspaceRoot || _folderFromUrl();
      if (!root || !window.qgs || typeof window.qgs.project !== 'function') return;
      var db = window.qgs.project(root + '/qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
      if (!db) return;
      db.get('editor.aZoneActive').then(function (savedId) {
        // 仅恢复拥有 panel 的 goods（纯 process 类 goods 不进入 A 区）
        if (savedId && typeof savedId === 'string' && goods.has(savedId) && _hasPanel(savedId)) {
          show(savedId);
        } else if (_defaultPanelId && goods.has(_defaultPanelId) && _hasPanel(_defaultPanelId)) {
          // 回退到默认面板
          show(_defaultPanelId);
        }
      }).catch(function () { });
    } catch (_) { }
  }

  // ★ 判断 goods 是否有 A 区面板能力
  function _hasPanel(id) {
    var def = goods.get(id);
    if (!def) return false;
    return !!(def.panel && (def.panel.url || def.panel.build || def.panel.render));
  }

  // ★ 列出所有有 A 区面板能力的 goods（供切换器使用）
  function listPanelGoods() {
    var result = [];
    goods.forEach(function (def, id) {
      if (_hasPanel(id)) result.push({ id: id, title: def.title || id });
    });
    return result;
  }

  // ★ 渲染 A 区顶部货物切换下拉
  function _renderSwitcher() {
    if (!_switcherEl) return;
    _switcherEl.innerHTML = '';
    var panelGoods = listPanelGoods();

    var sel = document.createElement('select');
    sel.style.cssText =
      'width:100%; padding:4px 6px; font-size:12px; font-family:Tahoma,sans-serif;' +
      'background:var(--card-bg); color:var(--text-primary); border:1px solid var(--border-color);' +
      'border-radius:3px; outline:none; cursor:pointer; -webkit-appearance:menulist;';

    for (var i = 0; i < panelGoods.length; i++) {
      var opt = document.createElement('option');
      opt.value = panelGoods[i].id;
      opt.textContent = panelGoods[i].title;
      if (panelGoods[i].id === _activeId) opt.selected = true;
      sel.appendChild(opt);
    }

    sel.addEventListener('change', function () {
      show(sel.value);
    });

    _switcherEl.appendChild(sel);
  }

  // 监听 A 区活性恢复事件（tab-manager 完成 restore 后触发）
  document.addEventListener('qqq-a-zone-restore', function () {
    setTimeout(_restoreActive, 500);
  });

  // ---- Register ----
  function register(def) {
    if (!def || !def.id) { console.warn('[gaea-host] register missing id'); return; }
    const id = def.id;

    // Normalize legacy format: {url} or {build} or {render} → panel
    if (!def.panel && (def.url || def.build || def.render)) {
      def.panel = {};
      if (def.url) def.panel.url = def.url;
      if (def.build) def.panel.build = def.build;
      if (def.render) def.panel.render = def.render;
    }

    // ---- Version compatibility check ----
    var protoVer = def.protoVer || 1; // default v1 if not declared
    if (protoVer > 2) {
      console.warn('[gaea-host] goods "' + id + '" requires proto v' + protoVer + ', host is v2. Skipping.');
      return;
    }

    goods.set(id, def);

    if (window.qqqAudio && def.audio) { window.qqqAudio.register(id, def); }

    // ★ 第一个注册的 panel goods → 自动展示。若默认面板后到 → 切换。
    if (!_activeId && !_pendingShow.length) {
      if (_hasPanel(id)) show(id);
    } else if (_defaultPanelId === id && _hasPanel(id) && _activeId !== id) {
      // 默认面板到达，且当前激活的不是默认面板 → 切换
      show(id);
    }
    if (_built) { renderTabBar(); _renderSwitcher(); }
  }

  // ---- Remove (full teardown) ----
  function remove(id) {
    if (instances.has(id)) {
      const inst = instances.get(id);

      // Stop services
      inst.services.forEach((svc, name) => {
        if (typeof svc.stop === 'function') {
          try { svc.stop(); } catch(e) { console.warn('[gaea-host] service stop error:', name, e); }
        }
      });

      // Remove X-zone tabs
      if (window.qqqTabs) {
        inst.tabs.forEach((tab, tabId) => {
          try { window.qqqTabs.closeTab(0, tab.id); } catch(e) { /* ignore */ }
        });
      }

      // Tear down panel
      if (typeof inst.destroy === 'function') { try { inst.destroy(); } catch(e) { /* ignore */ } }
      if (inst.iframe && inst.iframe.parentNode) inst.iframe.parentNode.removeChild(inst.iframe);
      if (inst.el && inst.el.parentNode) inst.el.parentNode.removeChild(inst.el);

      instances.delete(id);
    }
    if (window.qqqAudio) { window.qqqAudio.unregister(id); }
    if (_activeId === id) {
      _activeId = null;
      const first = goods.keys().next().value;
      if (first) show(first);
    }

    renderTabBar();
    _renderSwitcher();
  }

  // ---- Query ----}

  // ---- Query ----
  function list() { return Array.from(goods.values()); }
  function active() { return _activeId; }
  function get(id) { return instances.get(id) || null; }

  function next() {
    const ids = Array.from(goods.keys());
    if (ids.length < 2) return;
    const idx = ids.indexOf(_activeId);
    show(ids[(idx + 1) % ids.length]);
  }

  function prev() {
    const ids = Array.from(goods.keys());
    if (ids.length < 2) return;
    const idx = ids.indexOf(_activeId);
    show(ids[(idx - 1 + ids.length) % ids.length]);
  }

  // ---- Theme ----
  function syncTheme(dark) {
    instances.forEach((inst) => {
      if (inst.iframe && inst.iframe.contentWindow) {
        inst.iframe.contentWindow.postMessage({ type: 'qqqide-theme-change', dark }, '*');
      }
    });
  }
  if (window.qqqideTheme && window.qqqideTheme.onChange) {
    window.qqqideTheme.onChange(dark => syncTheme(dark));
  }

  // ---- Command routing (captain cards → cross-zone actions) ----
  document.addEventListener('qqq-command', (e) => {
    const cmd = e.detail && e.detail.cmd;
    if (!cmd) return;

    // qqq.q2 → activate Roam tab in X zone
    if (cmd === 'qqq.q2' && window.qqqTabs) {
      const gaeaGrp = window.qqqTabs.getGaeaGroup();
      if (gaeaGrp) {
        const roamTab = gaeaGrp.tabs.find(t => t.gaeaId === 'roam');
        if (roamTab) {
          gaeaGrp.tabs.forEach(t => {
            if (t.btnEl) t.btnEl.classList.toggle('active', t === roamTab);
            if (t.paneEl) t.paneEl.classList.toggle('active', t === roamTab);
          });
          gaeaGrp.activeTabId = roamTab.id;
        }
      }
    }
  });

  // ---- Expose ----
  window.qqqGaea = { build, register, remove, show, open, list, active, get, next, prev, syncTheme, listPanelGoods: listPanelGoods };
})();
