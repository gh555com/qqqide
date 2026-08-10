// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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

    // Mouse wheel on tab bar -> switch tabs (★ throttled 100ms to prevent rapid-fire layout)
    var _wheelLast = 0;
    bar.addEventListener('wheel', e => {
      e.preventDefault();
      var now = Date.now();
      if (now - _wheelLast < 100) return;
      _wheelLast = now;
      const grp = groups.find(gr => gr.barEl === bar);
      if (!grp || grp.tabs.length < 2) return;
      const curIdx = grp.tabs.findIndex(t => t.id === grp.activeTabId);
      if (curIdx < 0) return;
      var next = e.deltaY > 0 ? curIdx + 1 : curIdx - 1;
      if (next < 0 || next >= grp.tabs.length) return;
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
    // ★ 暂停旧活跃编辑器 layout（避免 display:none 时 Monaco 做无意义 layout）
    var oldTab = grp.tabs.find(function (t) { return t.id === grp.activeTabId; });
    if (oldTab && oldTab.filePath && window.qqqEditor && window.qqqEditor.suspendPaneLayout) {
      window.qqqEditor.suspendPaneLayout(oldTab.filePath);
    }

    grp.activeTabId = tabId;
    // update bar
    grp.barEl.querySelectorAll('.qqq-tab-btn').forEach(b => {
      b.classList.toggle('qqq-tab-active', b.dataset.tabId === String(tabId));
    });
    // update panes
    grp.contentEl.querySelectorAll('.qqq-tab-pane').forEach(p => {
      p.classList.toggle('qqq-tab-pane-active', p.dataset.tabId === String(tabId));
    });

    // ★ 恢复新活跃编辑器 layout（等下一帧 DOM 尺寸稳定后再 layout）
    var newTab = grp.tabs.find(function (t) { return t.id === tabId; });
    if (newTab && newTab.filePath && window.qqqEditor && window.qqqEditor.resumePaneLayout) {
      var _fp = newTab.filePath;
      requestAnimationFrame(function () {
        window.qqqEditor.resumePaneLayout(_fp);
      });
    }

    // fire callback
    if (newTab && newTab.onActivate) newTab.onActivate(newTab);
  }

  // ---- Close tab ----
  function closeTabById(grp, tabId) {
    const idx = grp.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    const tab = grp.tabs[idx];

    // ★ 关闭前暂停旧编辑器 layout（避免 pane.remove 触发 0×0 尺寸的昂贵 layout）
    if (tab.filePath && window.qqqEditor && window.qqqEditor.suspendPaneLayout) {
      window.qqqEditor.suspendPaneLayout(tab.filePath);
    }

    // remove tab button（轻量，无 DOM 依赖问题）
    const btn = grp.barEl.querySelector(`[data-tab-id="${tabId}"]`);
    if (btn) btn.remove();

    // ★ 延迟销毁编辑器 + 移除 pane DOM（放到下一个宏任务，避免同步阻塞 UI）
    //   MUST 先 dispose 编辑器再移除 pane：Monaco 内部 _detachModel 需要 DOM 父子关系完整，
    //   否则 removeChild 报 "not a child of this node"
    const pane = grp.contentEl.querySelector(`.qqq-tab-pane[data-tab-id="${tabId}"]`);
    if (tab.filePath && window.qqqEditor && window.qqqEditor.disposePaneEditor) {
      var _fp = tab.filePath;
      var _pane2 = pane;
      setTimeout(function () {
        window.qqqEditor.disposePaneEditor(_fp);
        if (_pane2 && _pane2.parentNode) _pane2.remove();
      }, 0);
    } else if (pane) {
      pane.remove();
    }

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

  // ★ 唯一真理中心机器：一切 tab dirty/preview 状态变更必须走此函数。
  //   patch 可含 {dirty, preview}，只更新传入的字段。
  //   穷举一切路径：setTabDirty / replaceFileInTab / openFileIn{Left,Right}Group 预览复用。
  function _setTabState(filePath, patch) {
    // 更新 tab 对象
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath !== filePath) continue;
        if ('dirty' in patch) t.dirty = patch.dirty;
        if ('preview' in patch) t.preview = patch.preview;
      }
    }
    // 刷新所有匹配 tab 的按钮标题（同一文件可跨分组打开）
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath !== filePath) continue;
        updateTabBtnTitle(t);
      }
    }
  }

  function setTabDirty(filePath, dirty) {
    var patch = { dirty: dirty };
    // First edit → pin the preview tab (exits preview mode)
    if (dirty) patch.preview = false;
    _setTabState(filePath, patch);
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

    // check duplicate (skip if multi-instance)
    if (!(opts && opts.multi)) {
      const existing = gaeaGrp.tabs.find(t => t.gaeaId === id);
      if (existing) {
        activateTab(gaeaGrp, existing.id);
        return existing;
      }
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

    // Non-closable tabs always at front (leftmost)
    var btn = createTabBtn(tab, gaeaGrp);
    if (id === 'roam') {
      btn.classList.add('qqq-tab-roam');
      // ★ Roam 标签召回提示（2026-08-09）: hover 瞬间弹出大字号 tooltip
      var _roamTip = null;
      function _showRoamTip() {
        if (!_roamTip) {
          _roamTip = document.createElement('div');
          _roamTip.className = 'qqq-roam-tip';
          _roamTip.textContent = '按 Tab 或 F2 键召回我';
          document.body.appendChild(_roamTip);
        }
        var r = btn.getBoundingClientRect();
        _roamTip.style.display = 'block';
        _roamTip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - _roamTip.offsetWidth - 4)) + 'px';
        var below = r.bottom + 8;
        _roamTip.style.top = (below + _roamTip.offsetHeight > window.innerHeight - 4 && r.top - _roamTip.offsetHeight - 8 > 0)
          ? (r.top - _roamTip.offsetHeight - 8) + 'px'
          : below + 'px';
      }
      function _hideRoamTip() { if (_roamTip) _roamTip.style.display = 'none'; }
      btn.addEventListener('mouseenter', _showRoamTip);
      btn.addEventListener('mouseleave', _hideRoamTip);
    }
    var pane = createTabPane(tab);

    if (tab.closable === false) {
      // Insert at position 0: before any closable tabs
      var firstClosableBtn = null;
      var firstClosablePane = null;
      for (var i = 0; i < gaeaGrp.barEl.children.length; i++) {
        var child = gaeaGrp.barEl.children[i];
        var tid = child.dataset && child.dataset.tabId;
        if (tid) {
          var t = gaeaGrp.tabs.find(function(tab) { return tab.id == tid; });
          if (t && t.closable !== false) { firstClosableBtn = child; break; }
        }
      }
      var paneIdx = firstClosableBtn ? Array.from(gaeaGrp.contentEl.children).indexOf(gaeaGrp.contentEl.querySelector('[data-tab-id="' + firstClosableBtn.dataset.tabId + '"]')) : -1;
      firstClosablePane = paneIdx >= 0 ? gaeaGrp.contentEl.children[paneIdx] : null;

      gaeaGrp.barEl.insertBefore(btn, firstClosableBtn);
      gaeaGrp.contentEl.insertBefore(pane, firstClosablePane);
      gaeaGrp.tabs.unshift(tab);
    } else {
      gaeaGrp.barEl.appendChild(btn);
      gaeaGrp.contentEl.appendChild(pane);
      gaeaGrp.tabs.push(tab);
    }

    // render content
    if (renderFn) {
      try { renderFn(pane, tab); }
      catch (e) { pane.textContent = 'render error: ' + (e && e.message); }
    }

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

    // ★ 中心机器：统一设置 tab 状态并刷新标题
    _setTabState(filePath, { dirty: false, preview: true });
    const btn = grp.barEl.querySelector(`[data-tab-id="${tab.id}"]`);
    if (btn) btn.dataset.filePath = filePath;

    activateTab(grp, tab.id);

    // Re-render content
    if (opts && opts.onRender) {
      try { opts.onRender(tab.paneEl, tab); }
      catch (e) { if (tab.paneEl) tab.paneEl.textContent = 'render error: ' + (e && e.message); }
    } else {
      // ★ 无 onRender → 广播渲染事件（与 openFileInRightGroup 同语义，pane 已清空）
      document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: tab.paneEl } }));
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
        _applyPaneOpts(filePath);
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
    } else {
      // ★ 无 onRender → 广播渲染事件（shell-rpc 监听 → 读文件 → Monaco 挂载）
      document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: pane } }));
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
      _applyPaneOpts(filePath);
      // ★ 文件已打开：直接触发 editor 搜索（如果有 _nextSearch）
      if (window._nextSearch) {
        var s = window._nextSearch; window._nextSearch = null;
        setTimeout(function () { _triggerEditorFind(s); }, 150);
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
      _setTabState(filePath, { dirty: false, preview: true });
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
    var realSearch = (searchText === '__FIND__') ? '' : searchText;
    try {
      var fc = ed.getContribution('editor.contrib.findController');
      if (fc && fc.start) {
        // 用 start() 打开搜索框，seedSearchStringFromSelection:'none' 防止从光标抓词
        fc.start({
          forceRevealReplace: false,
          seedSearchStringFromSelection: 'none',
          seedSearchStringFromNonEmptySelection: false,
          seedSearchStringFromGlobalClipboard: false,
          shouldFocus: 2,
          shouldAnimate: true,
          updateSearchScope: false,
          loop: true
        });
        // 有搜索词时设置搜索词
        if (realSearch) {
          fc.getState().change({ searchString: realSearch }, false);
          // 延迟二次确认
          setTimeout(function () {
            fc.getState().change({ searchString: realSearch }, false);
          }, 120);
        }
      } else {
        // fallback：直接用 action + DOM 写入
        ed.getAction('actions.find').run();
        if (realSearch) {
          var domNode = ed.getDomNode();
          if (domNode) {
            var _att = 0;
            var _try = function () {
              var fi = domNode.querySelector('.find-widget input[type="text"]') || domNode.querySelector('.find-widget .monaco-inputbox input');
              if (fi) {
                var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                ns.call(fi, realSearch);
                fi.dispatchEvent(new Event('input', { bubbles: true }));
              }
              if (++_att < 8) setTimeout(_try, 60);
            };
            setTimeout(_try, 60);
          }
        }
      }
    } catch (_) { }
  }

  // ★ 应用 _nextPaneOpts 的行/列跳转+搜索高亮+行背景（已有文件点击搜索列表时使用）
  var _tabJumpLineStyleInjected = false;
  function _applyPaneOpts(filePath) {
    var _paneOpts = window._nextPaneOpts || {};
    if (_paneOpts.line) {
      var line = _paneOpts.line, col = _paneOpts.col || 1, search = _paneOpts.search || '';
      window._nextPaneOpts = null;
      setTimeout(function () {
        // ★ 取目标文件对应的编辑器（面板编辑器优先）——getEditorInstance 只返回全局首个编辑器，
        //   文件已打开时会对错误的编辑器 setPosition → 跳转失效（用户需关闭标签重开才生效）
        var ed = window.qqqEditor && (window.qqqEditor.getEditorForFile ? window.qqqEditor.getEditorForFile(filePath) : window.qqqEditor.getEditorInstance());
        if (!ed || !ed.getModel) return;
        var model = ed.getModel();
        if (!model) return;
        try {
          var _jumpPos = { lineNumber: line, column: col };
          ed.setPosition(_jumpPos);
          ed.revealPositionInCenter(_jumpPos);
          // 行背景高亮（4s 自消）
          if (!_tabJumpLineStyleInjected) {
            _tabJumpLineStyleInjected = true;
            var style = document.createElement('style');
            style.textContent = '.qqq-jump-line{background:rgba(181,137,0,0.18)!important}[data-theme="dark"] .qqq-jump-line{background:rgba(181,137,0,0.25)!important}';
            document.head.appendChild(style);
          }
          var monaco = window.qqqEditor.getMonaco();
          if (monaco) {
            var deco = ed.deltaDecorations([], [{
              range: new monaco.Range(line, 1, line, 1),
              options: { isWholeLine: true, className: 'qqq-jump-line' }
            }]);
            setTimeout(function () { try { ed.deltaDecorations(deco, []); } catch (_) { } }, 4000);
          }
          // 搜索高亮：打开查找控件
          if (search && search.trim()) {
            setTimeout(function () {
              try {
                var fc = ed.getContribution('editor.contrib.findController');
                if (fc && fc.start) {
                  fc.start({
                    forceRevealReplace: false,
                    seedSearchStringFromSelection: 'none',
                    seedSearchStringFromNonEmptySelection: false,
                    seedSearchStringFromGlobalClipboard: false,
                    shouldFocus: 2, shouldAnimate: true,
                    updateSearchScope: false, loop: true
                  });
                  fc.getState().change({ searchString: search }, false);
                  setTimeout(function () { fc.getState().change({ searchString: search }, false); }, 120);
                }
              } catch (_) { }
            }, 200);
          }
        } catch (_) { }
      }, 400);
    } else {
      window._nextPaneOpts = null;
    }
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
      _setTabState(filePath, { dirty: false, preview: true });
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

  // ---- Persistence: editor tabs + gaea tabs + cursor positions → only.sq3 (项目资产) ----
  var _restored = false;
  var _persistTimer = null;
  var _restoreRetryTimer = null;

  function _folderFromUrl() {
    var m = window.location.search.match(/[?&]folder=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]).replace(/\\/g, '/').replace(/\/$/, ''); }
      catch (_) { }
    }
    return null;
  }

  function _onlyDb() {
    var root = window._workspaceRoot || _folderFromUrl();
    if (!root || !window.qgs || typeof window.qgs.project !== 'function') return null;
    return window.qgs.project(root + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
  }

  // ★ 收集 file tabs + gaea 活跃 tab ID + A 区活跃 good ID
  function _collectAllTabs() {
    var all = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var grp = groups[gi];
      if (grp.type !== 'file') continue;
      for (var ti = 0; ti < grp.tabs.length; ti++) {
        var t = grp.tabs[ti];
        if (t.filePath) {
          all.push({ path: t.filePath, groupIdx: grp.idx, active: t.id === grp.activeTabId, preview: !!t.preview });
        }
      }
    }
    return all;
  }

  function persistOpenTabs() {
    if (!_restored) return;
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(_doPersist, 250);
  }

  function _doPersist() {
    _persistTimer = null;
    var db = _onlyDb();
    if (!db) return;
    var all = _collectAllTabs();
    if (window.qqqEditor && window.qqqEditor.getAllEditorPositions) {
      var pos = window.qqqEditor.getAllEditorPositions();
      db.set('editor.positions', Object.keys(pos).length > 0 ? pos : null).catch(function () { });
    }
    if (all.length > 0) {
      db.set('editor.tabs', all).catch(function () { });
    }
    // ★ gaea 分组活跃 tab
    var gaeaGrp = getGaeaGroup();
    if (gaeaGrp && gaeaGrp.activeTabId) {
      var gaeaActive = null;
      for (var gi = 0; gi < gaeaGrp.tabs.length; gi++) {
        var t = gaeaGrp.tabs[gi];
        if (t.id === gaeaGrp.activeTabId) {
          gaeaActive = { gaeaId: t.gaeaId || t.id, title: t.title };
          break;
        }
      }
      if (gaeaActive) db.set('editor.gaeaActiveTab', gaeaActive).catch(function () { });
    }
  }

  // ★ 重试恢复：等 _workspaceRoot 就绪
  function _scheduleRestoreRetry() {
    if (_restoreRetryTimer) return;
    _restoreRetryTimer = setInterval(function () {
      if (_restored) { clearInterval(_restoreRetryTimer); _restoreRetryTimer = null; return; }
      if (_onlyDb()) {
        clearInterval(_restoreRetryTimer);
        _restoreRetryTimer = null;
        _doRestore();
      }
    }, 300);
  }

  async function _doRestore() {
    var db = _onlyDb();
    if (!db) { _scheduleRestoreRetry(); return; }
    try {
      // ★ 恢复 file tabs
      var all = await db.get('editor.tabs');
      if (Array.isArray(all) && all.length > 0) {
        var pos = await db.get('editor.positions').catch(function () { return null; });
        if (pos && typeof pos === 'object') { window.qqqPendingEditorPositions = pos; }
        for (var i = 0; i < all.length; i++) {
          var item = all[i];
          if (item.path) {
            document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: item.path, groupIdx: item.groupIdx, preview: !!item.preview } }));
          }
        }
        setTimeout(function () { window.qqqPendingEditorPositions = null; }, 4000);
      }
    } catch (e) { /* ignore */ }
    _restored = true;

    // ★ 延迟恢复 gaea 分组活跃 tab（等 goods 注册完毕）
    db.get('editor.gaeaActiveTab').then(function (gaeaTab) {
      if (!gaeaTab || !gaeaTab.gaeaId) return;
      setTimeout(function () {
        var grp = getGaeaGroup();
        if (!grp) return;
        for (var i = 0; i < grp.tabs.length; i++) {
          var t = grp.tabs[i];
          if ((t.gaeaId === gaeaTab.gaeaId || t.id === gaeaTab.gaeaId) && window.qqqTabs) {
            window.qqqTabs.activateTab(grp, t.id);
            break;
          }
        }
      }, 800);
    }).catch(function () { });

    // ★ 触发 A 区活性恢复
    document.dispatchEvent(new CustomEvent('qqq-a-zone-restore'));
  }

  function restoreOpenTabs() {
    // ★ fresh=1 永不恢复
    if (window.location.search.indexOf('fresh=1') !== -1) { _restored = true; return; }
    _doRestore();
  }

  // ★ Roam 硬创建函数：零依赖 goods/gaea-host，零异步
  function _createRoamTabHard() {
    addGaeaTab('roam', 'Roam', function (pane) {
      pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
      var iframe = document.createElement('iframe');
      iframe.src = '/qqqide/goods/file-explorer/q2-roam.html';
      iframe.style.cssText = 'width:100%; height:100%; border:none;';
      iframe.setAttribute('frameborder', '0');
      pane.appendChild(iframe);
    }, { closable: false });
  }

  function ensureRoamTab() {
    var gaeaGrp = getGaeaGroup();
    if (!gaeaGrp) return;
    var hasRoam = gaeaGrp.tabs.some(function(t) { return t.gaeaId === 'roam'; });
    if (hasRoam) return;
    _createRoamTabHard();
  }

  function init(host) {
    hostEl = host;
    hostEl.innerHTML = '';
    if (window.ResizeObserver) {
      new ResizeObserver(function() {
        _onGroupResize();
        ensureRoamTab();
      }).observe(hostEl);
    }
    window.addEventListener('resize', _onGroupResize);
    addGroup('gaea');
    // ★ Roam 永远是 gaea 分组的第一个标签，在所有持久化/异步逻辑之前同步创建
    _createRoamTabHard();
    setTimeout(function () { restoreOpenTabs(); }, 100);
  }

  // ---- closeTabById override: re-create Roam if closed + persist ----
  var _closeTabByIdHook = closeTabById;
  closeTabById = function (grp, tabId) {
    _closeTabByIdHook(grp, tabId);
    if (grp && grp.type === 'gaea') {
      setTimeout(function() { ensureRoamTab(); }, 50);
    }
    persistOpenTabs();
  };

  // Hook: save after every tab change
  var _origOpenFile = openFile;
  openFile = function (filePath, opts) {
    const result = _origOpenFile(filePath, opts);
    persistOpenTabs();
    return result;
  };

  var _origActivateTab = activateTab;
  activateTab = function (grp, tabId) {
    _origActivateTab(grp, tabId);
    persistOpenTabs();
  };

  // ---- Public: getters ----
  function getGroups() { return groups.slice(); }
  function getActiveGroup() { return groups[groups.length - 1] || null; }
  function getGaeaGroup() { return groups.find(g => g.type === 'gaea') || null; }

  // ---- Rename a gaea tab (update title in tab object + button DOM) ----
  function renameGaeaTab(tabId, newTitle) {
    var grp = getGaeaGroup();
    if (!grp) return;
    var tab = grp.tabs.find(function (t) { return t.id === tabId; });
    if (!tab) return;
    tab.title = newTitle;
    var btn = grp.barEl.querySelector('[data-tab-id="' + tabId + '"]');
    if (btn) {
      var nameSpan = btn.querySelector('.qqq-tab-name');
      if (nameSpan) nameSpan.textContent = newTitle;
    }
  }

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
    activateTab,
    getGroups,
    getActiveGroup,
    getGaeaGroup,
    renameGaeaTab,
    setTabDirty,
    persistOpenTabs,
    flushOpenTabs: function () { if (_persistTimer) { clearTimeout(_persistTimer); _doPersistOpenTabs(); } },
  };
})();