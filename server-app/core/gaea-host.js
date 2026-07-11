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
  let _built = false;
  const _pendingShow = [];

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

    // Tab bar moved to menu row 2 (qqq-goods-bar)
    _tabBarEl = document.getElementById('qqq-goods-bar');

    _contentEl = document.createElement('div');
    _contentEl.className = 'gaea-panel-body';
    _contentEl.style.cssText = 'flex:1; overflow:hidden; position:relative;';
    _hostEl.appendChild(_contentEl);

    _built = true;

    const pending = _pendingShow.splice(0);
    pending.forEach(id => show(id));
  }

  // ---- Tab bar (renders into menu row 2 toolbar) ----
  function renderTabBar() {
    if (!_tabBarEl) return;
    _tabBarEl.innerHTML = '';
    goods.forEach((def, id) => {
      const btn = document.createElement('button');
      btn.className = 'gaea-tab-btn qqq-goods-btn';
      btn.textContent = def.title || id;
      btn.dataset.gaeaId = id;
      btn.title = def.title || id;
      btn.style.cssText =
        'height:22px; padding:0 10px; margin:0 1px; border:1px solid var(--border-color); border-radius:3px;' +
        'background:' + (id === _activeId ? 'var(--primary-color)' : 'transparent') + ';' +
        'color:' + (id === _activeId ? '#1e1e1e' : 'var(--text-primary)') + ';' +
undefined
        'transition: background 0.15s;';
      btn.addEventListener('click', () => show(id));
      _tabBarEl.appendChild(btn);
    });
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

    // ★ 重建已关闭的 X 区 gaea tabs（用户关闭 gaea tab 后需重建）
    if (window.qqqTabs && inst.tabs && inst.tabs.size > 0) {
      const def = goods.get(id);
      const gaeaGrp = window.qqqTabs.getGaeaGroup ? window.qqqTabs.getGaeaGroup() : null;
      inst.tabs.forEach((oldTab, tabId) => {
        const stillExists = gaeaGrp && gaeaGrp.tabs && gaeaGrp.tabs.some(t => t.gaeaId === tabId);
        if (!stillExists && def && def.tabs && def.tabs[tabId]) {
          const tabDef = def.tabs[tabId];
          if (typeof tabDef.build === 'function') {
            const newTab = window.qqqTabs.addGaeaTab(tabId, tabDef.title || tabId, tabDef.build, { closable: tabDef.closable !== false });
            if (newTab) inst.tabs.set(tabId, newTab);
          }
        }
      });
    }

    if (inst.iframe) inst.iframe.style.display = '';
    if (inst.el) inst.el.style.display = '';

    _activeId = id;
    renderTabBar();
    _persistActive();
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
        if (savedId && typeof savedId === 'string' && goods.has(savedId)) {
          show(savedId);
        }
      }).catch(function () { });
    } catch (_) { }
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

    if (!_activeId && !_pendingShow.length) { show(id); }
    if (_built) renderTabBar();
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
    goods.delete(id);

    if (_activeId === id) {
      _activeId = null;
      const first = goods.keys().next().value;
      if (first) show(first);
    }

    renderTabBar();
  }

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
  window.qqqGaea = { build, register, remove, show, list, active, get, next, prev, syncTheme };
})();
