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
  let _activeTabMenu = null; // track open right-click context menu
  let _groupRatios = null;    // null=flex equal; {ratios:[0.3,0.7]} for proportional restore on resize
  let _resizeTimer = null;

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
    nameSpan.style.fontStyle = tab.preview ? 'italic' : 'normal';
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

    // Right-click context menu: only for file groups (not gaea)
    if (tab.filePath) {
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e, grp, tab);
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

  // ---- Close others / close all ----
  function closeOthersInGroup(grp, keepTabId) {
    const tabsToClose = grp.tabs.filter(t => t.id !== keepTabId);
    for (const t of tabsToClose) {
      if (grp.tabs.find(x => x.id === t.id)) closeTabById(grp, t.id);
    }
  }

  function closeAllInGroup(grp) {
    const tabsToClose = [...grp.tabs];
    for (const t of tabsToClose) {
      if (grp.tabs.find(x => x.id === t.id)) closeTabById(grp, t.id);
    }
  }

  // ---- Tab dirty state (asterisk) ----
  function findFileTabByFilePath(filePath) {
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      const t = grp.tabs.find(t => t.filePath === filePath);
      if (t) return { grp, tab: t };
    }
    return null;
  }

  function updateTabBtnTitle(tab) {
    // find all tab buttons for this tab across all groups (same filePath)
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath !== tab.filePath) continue;
        const btn = grp.barEl.querySelector(`[data-tab-id="${t.id}"]`);
        if (!btn) continue;
        const nameSpan = btn.querySelector('.qqq-tab-name');
        if (!nameSpan) continue;
        const baseName = t.filePath.split(/[/\\]/).pop() || t.title;
        nameSpan.textContent = t.dirty ? '* ' + baseName : baseName;
        nameSpan.style.fontStyle = t.preview ? 'italic' : 'normal';
      }
    }
  }

  function setTabDirty(filePath, dirty) {
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath !== filePath) continue;
        t.dirty = dirty;
        // First edit → pin the preview tab (exits preview mode)
        if (dirty && t.preview) {
          t.preview = false;
        }
      }
    }
    // Update title display
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath !== filePath) continue;
        updateTabBtnTitle(t);
      }
    }
  }

  // ---- Context menu for file tabs ----
  function closeTabMenu() {
    if (_activeTabMenu) { try { _activeTabMenu.remove(); } catch (_) { } _activeTabMenu = null; }
  }

  function showTabContextMenu(e, grp, tab) {
    closeTabMenu();
    const fileGroups = groups.filter(g => g.type === 'file');
    const isFirstFileGroup = fileGroups.length > 0 && grp === fileGroups[0];
    const isSecondFileGroup = fileGroups.length > 1 && grp === fileGroups[fileGroups.length - 1];

    const pop = document.createElement('div');
    pop.className = 'qqq-tab-context-menu';
    pop.style.cssText =
      'position:fixed; z-index:99999; ' +
      'left:' + e.clientX + 'px; top:' + e.clientY + 'px; ' +
      'min-width:140px; background:var(--card-bg); ' +
      'border:1px solid var(--border-color); border-radius:3px; ' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18); padding:4px 0;';

    function addRow(label, onClick) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex; align-items:center; padding:5px 14px; ' +
        'cursor:pointer; font-size:12px; color:var(--text-primary); ' +
        'white-space:nowrap; user-select:none;';
      row.textContent = label;
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--background-color)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTabMenu();
        onClick();
      });
      pop.appendChild(row);
    }

    // Row 1: open in adjacent group
    if (isFirstFileGroup) {
      addRow(window._i('shell.tab.openRight', '在右侧再开'), () => { openFileInRightGroup(tab.filePath); });
    } else if (isSecondFileGroup) {
      addRow(window._i('shell.tab.openLeft', '在左侧再开'), () => { openFileInLeftGroup(tab.filePath); });
    }

    // Row 2: close others
    if (grp.tabs.length > 1) {
      addRow(window._i('editor.tabs.closeOthers', '关闭其他'), () => { closeOthersInGroup(grp, tab.id); });
    }

    // Row 3: close all
    if (grp.tabs.length > 0) {
      addRow(window._i('editor.tabs.closeAll', '关闭所有'), () => { closeAllInGroup(grp); });
    }

    document.body.appendChild(pop);
    _activeTabMenu = pop;

    // global click to close
    setTimeout(() => {
      document.addEventListener('mousedown', _onDocMouseDownForTabMenu, { once: true });
    }, 0);
  }

  function _onDocMouseDownForTabMenu(e) {
    if (!_activeTabMenu) return;
    if (_activeTabMenu.contains(e.target)) {
      // re-register for next click
      setTimeout(() => {
        document.addEventListener('mousedown', _onDocMouseDownForTabMenu, { once: true });
      }, 0);
      return;
    }
    closeTabMenu();
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

    // reset flex on remaining groups + clear stale ratios
    _groupRatios = null;
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
          setW: w => { g.el.style.flex = '0 0 ' + w + 'px'; _saveGroupRatios(); },
          min: MIN_W,
        });
      }
      const rightPanels = [];
      for (let j = i; j < groups.length; j++) {
        const g = groups[j];
        rightPanels.push({
          getW: () => g.el.offsetWidth,
          setW: w => { g.el.style.flex = '0 0 ' + w + 'px'; _saveGroupRatios(); },
          min: MIN_W,
        });
      }
      window.qqqideSash.bindV(fresh, leftPanels, rightPanels);
    }
  }

  // Save group width ratios for proportional restore on window resize
  function _saveGroupRatios() {
    if (groups.length < 2) { _groupRatios = null; return; }
    const totalW = groups.reduce((s, g) => s + g.el.offsetWidth, 0);
    if (totalW <= 0) { _groupRatios = null; return; }
    _groupRatios = { ratios: groups.map(g => g.el.offsetWidth / totalW) };
  }

  // On window resize, restore group proportions if they were manually adjusted
  function _onGroupResize() {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      _resizeTimer = null;
      if (!hostEl || groups.length < 2) return;
      if (!_groupRatios || !_groupRatios.ratios || _groupRatios.ratios.length !== groups.length) {
        // No custom ratios → reset to equal flex
        groups.forEach(g => { g.el.style.flex = '1 1 0'; });
        return;
      }
      // Calculate available width (host width minus sashes)
      const hostW = hostEl.offsetWidth;
      let sashTotal = 0;
      for (let i = 1; i < groups.length; i++) {
        const sash = groups[i]._sashEl;
        if (sash) sashTotal += sash.offsetWidth;
      }
      const availW = hostW - sashTotal;
      if (availW <= 0) return;
      // Assign each group, give last group the remainder to avoid rounding gaps
      let usedW = 0;
      const lastIdx = groups.length - 1;
      for (let idx = 0; idx < lastIdx; idx++) {
        const w = Math.max(MIN_W, Math.round(_groupRatios.ratios[idx] * availW));
        groups[idx].el.style.flex = '0 0 ' + w + 'px';
        usedW += w;
      }
      const lastW = Math.max(MIN_W, availW - usedW);
      groups[lastIdx].el.style.flex = '0 0 ' + lastW + 'px';
    }, 50);
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

  // ---- Public: replace preview tab content (switches file in-place) ----
  function replaceFileInTab(grp, tab, filePath, opts) {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;

    // Clean old pane content
    if (tab.paneEl) { tab.paneEl.innerHTML = ''; }

    // Update tab identity
    tab.filePath = filePath;
    tab.title = fileName;
    tab.dirty = false;
    tab.preview = true;

    // Refresh button title (italic for preview) + dataset for context menu
    updateTabBtnTitle(tab);
    const btn = grp.barEl.querySelector(`[data-tab-id="${tab.id}"]`);
    if (btn) btn.dataset.filePath = filePath;

    activateTab(grp, tab.id);

    // Re-render content
    if (opts && opts.onRender) {
      try { opts.onRender(tab.paneEl, tab); }
      catch (e) { if (tab.paneEl) tab.paneEl.textContent = 'render error: ' + (e && e.message); }
    }

    persistOpenTabs();
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

    // Preview mode: reuse existing preview tab if any (not yet pinned)
    const previewTab = fileGrp.tabs.find(t => t.preview);
    if (previewTab) {
      return replaceFileInTab(fileGrp, previewTab, filePath, opts);
    }

    // No preview tab — create new one (preview mode)
    const tabId = _nextTabId++;
    const tab = {
      id: tabId,
      title: fileName,
      filePath: filePath,
      closable: true,
      onActivate: null,
      onClose: null,
      preview: (opts && typeof opts.preview === 'boolean') ? opts.preview : true,
      dirty: false,
    };

    const btn = createTabBtn(tab, fileGrp);
    btn.dataset.filePath = filePath;
    fileGrp.barEl.appendChild(btn);

    const pane = createTabPane(tab);
    fileGrp.contentEl.appendChild(pane);
    tab.paneEl = pane;

    fileGrp.tabs.push(tab);
    activateTab(fileGrp, tabId);

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

    // Find or create the right-most file group
    let targetGrp;
    if (fileGroups.length >= 2) {
      targetGrp = fileGroups[fileGroups.length - 1]; // use the last file group
    } else {
      targetGrp = addGroup('file');
    }
    if (!targetGrp) return null;

    // Check if already open in this group
    const existing = targetGrp.tabs.find(t => t.filePath === filePath);
    if (existing) {
      activateTab(targetGrp, existing.id);
      // ★ 文件已打开：直接触发 editor 搜索（如果有 _nextSearch）
      if (window._nextSearch) {
        var s = window._nextSearch; window._nextSearch = null;
        setTimeout(function() { _triggerEditorFind(s); }, 150);
      }
      return existing;
    }

    // Preview mode: reuse existing preview tab
    const previewTab = targetGrp.tabs.find(t => t.preview);
    if (previewTab) {
      if (previewTab.paneEl) previewTab.paneEl.innerHTML = '';
      previewTab.filePath = filePath;
      previewTab.title = fileName;
      previewTab.dirty = false;
      previewTab.preview = true;
      updateTabBtnTitle(previewTab);
      const btn = targetGrp.barEl.querySelector(`[data-tab-id="${previewTab.id}"]`);
      if (btn) btn.dataset.filePath = filePath;
      activateTab(targetGrp, previewTab.id);
      document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: previewTab.paneEl } }));
      persistOpenTabs();
      return previewTab;
    }

    const tabId = _nextTabId++;
    const tab = { id: tabId, title: fileName, filePath: filePath, closable: true, onActivate: null, onClose: null, preview: true, dirty: false };
    const btn = createTabBtn(tab, targetGrp);
    btn.dataset.filePath = filePath;
    targetGrp.barEl.appendChild(btn);
    const pane = createTabPane(tab);
    targetGrp.contentEl.appendChild(pane);
    tab.paneEl = pane;
    targetGrp.tabs.push(tab);
    activateTab(targetGrp, tabId);
    document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: pane } }));
    persistOpenTabs();
    return tab;
  }

  // ★ 在活跃 editor 中触发查找
  function _triggerEditorFind(searchText) {
    if (!searchText) return;
    var ed = window.qqqEditor && window.qqqEditor.getEditorInstance();
    if (!ed) return;
    try {
      // 清空选区：先把光标移到行首零宽度，避免 Monaco 抓取 "floor"
      if (ed.setSelection) {
        ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 });
      }
      // 打开查找控件
      if (ed.getAction) {
        ed.getAction('actions.find').run();
      }
      // 强制写入搜索词（重试 6 次 × 80ms，对抗 Monaco 自动填入光标词）
      var _attempts = 0;
      var _trySet = function() {
        var fi = document.querySelector('.monaco-editor .find-widget .find-part .monaco-inputbox input');
        if (fi) {
          var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(fi, searchText);
          fi.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (++_attempts < 6) { setTimeout(_trySet, 80); }
      };
      setTimeout(_trySet, 80);
    } catch(_) {}
  }

  // ---- Public: open file in left (first) file group ----
  function openFileInLeftGroup(filePath) {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const fileGroups = groups.filter(g => g.type === 'file');
    if (fileGroups.length === 0) return openFile(filePath);
    const targetGrp = fileGroups[0];
    const existing = targetGrp.tabs.find(t => t.filePath === filePath);
    if (existing) { activateTab(targetGrp, existing.id); return existing; }

    // Preview mode: reuse existing preview tab
    const previewTab = targetGrp.tabs.find(t => t.preview);
    if (previewTab) {
      if (previewTab.paneEl) previewTab.paneEl.innerHTML = '';
      previewTab.filePath = filePath;
      previewTab.title = fileName;
      previewTab.dirty = false;
      previewTab.preview = true;
      updateTabBtnTitle(previewTab);
      const btn = targetGrp.barEl.querySelector(`[data-tab-id="${previewTab.id}"]`);
      if (btn) btn.dataset.filePath = filePath;
      activateTab(targetGrp, previewTab.id);
      document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: previewTab.paneEl } }));
      persistOpenTabs();
      return previewTab;
    }

    const tabId = _nextTabId++;
    const tab = { id: tabId, title: fileName, filePath: filePath, closable: true, onActivate: null, onClose: null, preview: true, dirty: false };
    const btn = createTabBtn(tab, targetGrp);
    btn.dataset.filePath = filePath;
    targetGrp.barEl.appendChild(btn);
    const pane = createTabPane(tab);
    targetGrp.contentEl.appendChild(pane);
    tab.paneEl = pane;
    targetGrp.tabs.push(tab);
    activateTab(targetGrp, tabId);
    document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: pane } }));
    persistOpenTabs();
    return tab;
  }

  // ---- Public: close tab ----
  function closeTab(groupIdx, tabId) {
    const grp = groups[groupIdx];
    if (!grp) return;
    closeTabById(grp, tabId);
  }

  // ---- Persistence: save/restore open file tabs ----
  const TAB_STATE_NS = 'qqqide';
  const TAB_STATE_KEY = 'open_tabs';
  let _restored = false;
  let _tabStateHandle = null;   // cached handle — NEVER call qgs.simple() more than once
  let _persistTimer = null;     // trailing debounce (250ms)

  function _tabState() {
    if (_tabStateHandle) return _tabStateHandle;
    if (!window.qgs || !window.qgs.simple) return null;
    _tabStateHandle = window.qgs.simple(TAB_STATE_NS);
    return _tabStateHandle;
  }

  function persistOpenTabs() {
    if (!_restored) return;
    // Trailing debounce: collapse rapid calls (restore 17 tabs → 1 write)
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(_doPersistOpenTabs, 250);
  }

  function _doPersistOpenTabs() {
    _persistTimer = null;
    const state = _tabState();
    if (!state) return;
    const tabs = [];
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath) {
          tabs.push({
            path: t.filePath,
            groupIdx: grp.idx,
            active: t.id === grp.activeTabId,
            preview: !!t.preview,
          });
        }
      }
    }
    if (tabs.length === 0) {
      state.del(TAB_STATE_KEY).catch(() => { });
    } else {
      state.set(TAB_STATE_KEY, tabs).catch(() => { });
    }
  }

  async function restoreOpenTabs() {
    _restored = true;
    // 新窗口（?fresh=1）：X 区空，不继承任何 editor tab
    if (window.location.search.indexOf('fresh=1') !== -1) return;
    const state = _tabState();
    if (!state) return;
    try {
      const tabs = await state.get(TAB_STATE_KEY);
      if (!Array.isArray(tabs) || tabs.length === 0) return;
      for (const t of tabs) {
        if (t.path) {
          document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: t.path, groupIdx: t.groupIdx, preview: !!t.preview } }));
        }
      }
    } catch (e) { /* ignore */ }
  }

  // ---- Public: init ----
  function init(host) {
    hostEl = host;
    hostEl.innerHTML = '';
    // Listen for host resize (covers window resize + A-zone sash drag)
    if (window.ResizeObserver) {
      new ResizeObserver(() => _onGroupResize()).observe(hostEl);
    }
    window.addEventListener('resize', _onGroupResize);
    // gaea group is always created on init
    addGroup('gaea');
    // Restore previously open file tabs
    setTimeout(() => restoreOpenTabs(), 100);
  }

  // Hook: save after every tab change
  const _origOpenFile = openFile;
  openFile = function (filePath, opts) {
    const result = _origOpenFile(filePath, opts);
    persistOpenTabs();
    return result;
  };

  const _origActivateTab = activateTab;
  activateTab = function (grp, tabId) {
    _origActivateTab(grp, tabId);
    persistOpenTabs();
  };

  const _origCloseTabById = closeTabById;
  closeTabById = function (grp, tabId) {
    _origCloseTabById(grp, tabId);
    persistOpenTabs();
  };

  // ---- Public: getters ----
  function getGroups() { return groups.slice(); }
  function getActiveGroup() { return groups[groups.length - 1] || null; }
  function getGaeaGroup() { return groups.find(g => g.type === 'gaea') || null; }

  // ---- Listen for tab dirty events from editor ----
  document.addEventListener('qqq-tab-dirty', e => {
    const path = e.detail && e.detail.path;
    const dirty = e.detail && e.detail.dirty;
    if (path) setTabDirty(path, dirty);
  });

  window.qqqTabs = {
    init,
    addGaeaTab,
    openFile,
    openFileInRightGroup,
    openFileInLeftGroup,
    splitRight,
    closeTab,
    getGroups,
    getActiveGroup,
    getGaeaGroup,
    setTabDirty,
  };
})();
