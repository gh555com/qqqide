// ============================================================================
// tab-manager.js - QQQ Shell v2 tab group manager
//
// Up to 3 tab groups in X-upper area:
//   Group 0 (gaea): always visible, hosts Roam / git / search tabs
//   Group 1 (file): appears when a file is opened, disappears when empty
//   Group 2 (file): appears on split-right, disappears when empty
//
// API: window.qqqTabs = {
//   init(hostEl),
//   addGaeaTab(id, title, renderFn),
//   openFile(filePath, content, lang),
//   splitRight(),
//   closeTab(groupIdx, tabId),
//   showOutput(), hideOutput(),
//   getGroups(), getActiveGroup(),
// }
// ============================================================================
(function () {
  'use strict';

  const MIN_W = 123;
  const MAX_GROUPS = 3;

  let hostEl = null;          // #qqq-x-upper
  const groups = [];          // [{ idx, type, el, barEl, contentEl, tabs[], activeTabId }]
  let _nextTabId = 1;

  // ---- DOM builders ----
  function createGroupEl(type) {
    const g = document.createElement('div');
    g.className = 'qqq-tab-group';
    g.style.flex = '1 1 0';
    g.style.minWidth = MIN_W + 'px';

    const bar = document.createElement('div');
    bar.className = 'qqq-tab-bar';

    const content = document.createElement('div');
    content.className = 'qqq-tab-content';

    g.appendChild(bar);
    g.appendChild(content);

    // Mouse wheel on tab bar -> switch tabs
    bar.addEventListener('wheel', e => {
      e.preventDefault();
      const grp = groups.find(gr => gr.barEl === bar);
      if (!grp || grp.tabs.length < 2) return;
      const curIdx = grp.tabs.findIndex(t => t.id === grp.activeTabId);
      if (curIdx < 0) return;
      const next = e.deltaY > 0
        ? (curIdx + 1) % grp.tabs.length
        : (curIdx - 1 + grp.tabs.length) % grp.tabs.length;
      activateTab(grp, grp.tabs[next].id);
    }, { passive: false });

    return { el: g, barEl: bar, contentEl: content };
  }

  function createSashBetweenGroups() {
    const s = document.createElement('div');
    s.className = 'qqq-sash qqq-sash-v';
    s.setAttribute('data-sash', 'tab-group');
    return s;
  }

  // ---- Tab button ----
  function createTabBtn(tab, grp) {
    const btn = document.createElement('button');
    btn.className = 'qqq-tab-btn';
    btn.dataset.tabId = tab.id;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'qqq-tab-name';
    nameSpan.textContent = tab.title;
    btn.appendChild(nameSpan);

    // close button (not on gaea-fixed tabs unless explicitly closable)
    if (tab.closable !== false) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'qqq-tab-close';
      closeBtn.textContent = '\u00D7';
      closeBtn.title = 'Close';
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        closeTabById(grp, tab.id);
      });
      btn.appendChild(closeBtn);
    }

    btn.addEventListener('click', () => {
      activateTab(grp, tab.id);
    });

    // Right-click context menu: open in right-most file group
    if (tab.filePath) {
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        console.log('[tab-manager] contextmenu on tab:', tab.filePath, 'groups:', groups.length, 'fileGroups:', groups.filter(g => g.type === 'file').length);
        openFileInRightGroup(tab.filePath);
      });
    }

    return btn;
  }

  // ---- Tab pane ----
  function createTabPane(tab) {
    const pane = document.createElement('div');
    pane.className = 'qqq-tab-pane';
    pane.dataset.tabId = tab.id;
    return pane;
  }

  // ---- Activate tab ----
  function activateTab(grp, tabId) {
    grp.activeTabId = tabId;
    // update bar
    grp.barEl.querySelectorAll('.qqq-tab-btn').forEach(b => {
      b.classList.toggle('qqq-tab-active', b.dataset.tabId === String(tabId));
    });
    // update panes
    grp.contentEl.querySelectorAll('.qqq-tab-pane').forEach(p => {
      p.classList.toggle('qqq-tab-pane-active', p.dataset.tabId === String(tabId));
    });
    // fire callback
    const tab = grp.tabs.find(t => t.id === tabId);
    if (tab && tab.onActivate) tab.onActivate(tab);
  }

  // ---- Close tab ----
  function closeTabById(grp, tabId) {
    const idx = grp.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    const tab = grp.tabs[idx];

    // remove DOM
    const btn = grp.barEl.querySelector(`[data-tab-id="${tabId}"]`);
    if (btn) btn.remove();
    const pane = grp.contentEl.querySelector(`.qqq-tab-pane[data-tab-id="${tabId}"]`);
    if (pane) pane.remove();

    // fire cleanup
    if (tab.onClose) tab.onClose(tab);

    grp.tabs.splice(idx, 1);

    if (grp.tabs.length === 0 && grp.type === 'file') {
      // remove entire file group
      removeGroup(grp);
    } else if (grp.activeTabId === tabId && grp.tabs.length > 0) {
      // activate neighbor
      const newIdx = Math.min(idx, grp.tabs.length - 1);
      activateTab(grp, grp.tabs[newIdx].id);
    }
  }

  // ---- Add/remove groups ----
  function addGroup(type) {
    if (groups.length >= MAX_GROUPS) return null;

    const dom = createGroupEl(type);
    const grp = {
      idx: groups.length,
      type: type,
      el: dom.el,
      barEl: dom.barEl,
      contentEl: dom.contentEl,
      tabs: [],
      activeTabId: null,
    };

    // insert sash before new group (if not first)
    if (groups.length > 0) {
      const sash = createSashBetweenGroups();
      hostEl.appendChild(sash);
      grp._sashEl = sash;
    }

    hostEl.appendChild(grp.el);
    groups.push(grp);
    reindexGroups();
    rebindAllSashes();
    return grp;
  }

  function removeGroup(grp) {
    const idx = groups.indexOf(grp);
    if (idx < 0) return;

    // remove sash
    if (grp._sashEl) { grp._sashEl.remove(); grp._sashEl = null; }
    grp.el.remove();
    groups.splice(idx, 1);
    reindexGroups();

    // reset flex on remaining groups
    groups.forEach(g => { g.el.style.flex = '1 1 0'; });
    rebindAllSashes();
  }

  // Rebind ALL inter-group sashes so each one knows about every group on
  // its left/right side, enabling cascading compression. Without this,
  // dragging the left sash with 3 groups will saturate at the immediate
  // neighbor's MIN width and lock up.
  function rebindAllSashes() {
    for (let i = 1; i < groups.length; i++) {
      const grp = groups[i];
      const sash = grp._sashEl;
      if (!sash) continue;
      // Replace node to drop previous mousedown listener
      const fresh = sash.cloneNode(false);
      sash.parentNode.replaceChild(fresh, sash);
      grp._sashEl = fresh;
      // leftPanels: groups[0..i-1] in order, last entry is the immediate left neighbor
      // rightPanels: groups[i..N-1] in order, first entry is the immediate right neighbor
      const leftPanels = [];
      for (let j = 0; j < i; j++) {
        const g = groups[j];
        leftPanels.push({
          getW: () => g.el.offsetWidth,
          setW: w => { g.el.style.flex = '0 0 ' + w + 'px'; },
          min: MIN_W,
        });
      }
      const rightPanels = [];
      for (let j = i; j < groups.length; j++) {
        const g = groups[j];
        rightPanels.push({
          getW: () => g.el.offsetWidth,
          setW: w => { g.el.style.flex = '0 0 ' + w + 'px'; },
          min: MIN_W,
        });
      }
      window.qqqSash.bindV(fresh, leftPanels, rightPanels);
    }
  }

  function reindexGroups() {
    groups.forEach((g, i) => { g.idx = i; });
  }

  // ---- Public: add gaea tab ----
  function addGaeaTab(id, title, renderFn, opts) {
    let gaeaGrp = groups.find(g => g.type === 'gaea');
    if (!gaeaGrp) {
      gaeaGrp = addGroup('gaea');
    }
    if (!gaeaGrp) return null;

    // check duplicate
    const existing = gaeaGrp.tabs.find(t => t.gaeaId === id);
    if (existing) {
      activateTab(gaeaGrp, existing.id);
      return existing;
    }

    const tabId = _nextTabId++;
    const tab = {
      id: tabId,
      gaeaId: id,
      title: title,
      closable: (opts && opts.closable !== undefined) ? opts.closable : false,
      onActivate: null,
      onClose: null,
    };

    const btn = createTabBtn(tab, gaeaGrp);
    gaeaGrp.barEl.appendChild(btn);

    const pane = createTabPane(tab);
    gaeaGrp.contentEl.appendChild(pane);

    // render content
    if (renderFn) {
      try { renderFn(pane, tab); }
      catch (e) { pane.textContent = 'render error: ' + (e && e.message); }
    }

    gaeaGrp.tabs.push(tab);
    activateTab(gaeaGrp, tabId);
    return tab;
  }

  // ---- Public: open file in file group ----
  function openFile(filePath, opts) {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;

    // find existing tab with same path (in any file group)
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      const existing = grp.tabs.find(t => t.filePath === filePath);
      if (existing) {
        activateTab(grp, existing.id);
        return existing;
      }
    }

    // find or create file group
    let fileGrp = groups.find(g => g.type === 'file');
    if (!fileGrp) {
      fileGrp = addGroup('file');
    }
    if (!fileGrp) return null; // max groups reached

    const tabId = _nextTabId++;
    const tab = {
      id: tabId,
      title: fileName,
      filePath: filePath,
      closable: true,
      onActivate: null,
      onClose: null,
    };

    const btn = createTabBtn(tab, fileGrp);
    fileGrp.barEl.appendChild(btn);

    const pane = createTabPane(tab);
    fileGrp.contentEl.appendChild(pane);

    // The actual content (Monaco editor) will be rendered by the caller
    // via tab.paneEl reference
    tab.paneEl = pane;

    fileGrp.tabs.push(tab);
    activateTab(fileGrp, tabId);

    // fire open event
    if (opts && opts.onRender) {
      try { opts.onRender(pane, tab); }
      catch (e) { pane.textContent = 'render error: ' + (e && e.message); }
    }

    return tab;
  }

  // ---- Public: split right ----
  function splitRight() {
    const fileGroups = groups.filter(g => g.type === 'file');
    if (fileGroups.length >= 2) return null; // already at max file groups (2)
    return addGroup('file');
  }

  // ---- Public: open file in right-most (3rd) group ----
  function openFileInRightGroup(filePath) {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const fileGroups = groups.filter(g => g.type === 'file');
    console.log('[tab-manager] openFileInRightGroup:', filePath, 'fileGroups.length:', fileGroups.length, 'MAX_GROUPS:', MAX_GROUPS);

    // Find or create the right-most file group
    let targetGrp;
    if (fileGroups.length >= 2) {
      targetGrp = fileGroups[fileGroups.length - 1]; // use the last file group
      console.log('[tab-manager] reusing existing right group');
    } else {
      // Need to create another file group
      targetGrp = addGroup('file');
      console.log('[tab-manager] addGroup result:', targetGrp ? 'OK' : 'NULL', 'groups now:', groups.length);
    }
    if (!targetGrp) return null;

    // Check if already open in this group
    const existing = targetGrp.tabs.find(t => t.filePath === filePath);
    if (existing) {
      activateTab(targetGrp, existing.id);
      return existing;
    }

    const tabId = _nextTabId++;
    const tab = { id: tabId, title: fileName, filePath: filePath, closable: true, onActivate: null, onClose: null };
    const btn = createTabBtn(tab, targetGrp);
    targetGrp.barEl.appendChild(btn);
    const pane = createTabPane(tab);
    targetGrp.contentEl.appendChild(pane);
    tab.paneEl = pane;
    targetGrp.tabs.push(tab);
    activateTab(targetGrp, tabId);

    // fire open event for editor
    document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: pane } }));
    return tab;
  }

  // ---- Public: close tab ----
  function closeTab(groupIdx, tabId) {
    const grp = groups[groupIdx];
    if (!grp) return;
    closeTabById(grp, tabId);
  }

  // ---- Persistence: save/restore open file tabs ----
  const TAB_STATE_NS = 'qqq.shell';
  const TAB_STATE_KEY = 'open_tabs';
  let _restored = false;

  function persistOpenTabs() {
    if (!_restored) return;
    if (!window.qgs || !window.qgs.simple) return;
    const state = window.qgs.simple(TAB_STATE_NS);
    const tabs = [];
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath) {
          tabs.push({
            path: t.filePath,
            groupIdx: grp.idx,
            active: t.id === grp.activeTabId,
          });
        }
      }
    }
    if (tabs.length === 0) {
      state.del(TAB_STATE_KEY).catch(() => {});
    } else {
      state.set(TAB_STATE_KEY, tabs).catch(() => {});
    }
  }

  async function restoreOpenTabs() {
    _restored = true;
    if (!window.qgs || !window.qgs.simple) return;
    try {
      const state = window.qgs.simple(TAB_STATE_NS);
      const tabs = await state.get(TAB_STATE_KEY);
      if (!Array.isArray(tabs) || tabs.length === 0) return;
      for (const t of tabs) {
        if (t.path) {
          document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: t.path, groupIdx: t.groupIdx } }));
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ---- Public: init ----
  function init(host) {
    hostEl = host;
    hostEl.innerHTML = '';
    // gaea group is always created on init
    addGroup('gaea');
    // Restore previously open file tabs
    setTimeout(() => restoreOpenTabs(), 100);
  }

  // Hook: save after every tab change
  const _origOpenFile = openFile;
  openFile = function(filePath, opts) {
    const result = _origOpenFile(filePath, opts);
    persistOpenTabs();
    return result;
  };

  const _origActivateTab = activateTab;
  activateTab = function(grp, tabId) {
    _origActivateTab(grp, tabId);
    persistOpenTabs();
  };

  const _origCloseTabById = closeTabById;
  closeTabById = function(grp, tabId) {
    _origCloseTabById(grp, tabId);
    persistOpenTabs();
  };

  // ---- Public: getters ----
  function getGroups() { return groups.slice(); }
  function getActiveGroup() { return groups[groups.length - 1] || null; }
  function getGaeaGroup() { return groups.find(g => g.type === 'gaea') || null; }

  window.qqqTabs = {
    init,
    addGaeaTab,
    openFile,
    openFileInRightGroup,
    splitRight,
    closeTab,
    getGroups,
    getActiveGroup,
    getGaeaGroup,
  };
})();
