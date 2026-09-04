// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// tab-manager.js - QQQ Shell v2 tab group manager
//
// Up to 3 tab groups in X-upper area:
//   Group 0 (gaea): always visible, hosts roam / git / search tabs
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

  // ★ 2026-09-04：宽度底线唯一源 = window.__LAYOUT_CONST（qqqide-theme.js §1b 注入），此处兜底
  const _LC = function () { return window.__LAYOUT_CONST || {}; };
  const MIN_W = _LC().PANEL_MIN || 123;    // 文件分组底线
  const MIN_GAEA = _LC().GAEA_MIN || 180;  // gaea 常驻分组底线（roam/git/search 内容密集，独立加宽）
  const MAX_GROUPS = 3;

  let hostEl = null;          // #qqq-x-upper
  const groups = [];          // [{ idx, type, el, barEl, contentEl, tabs[], activeTabId }]
  let _nextTabId = 1;
  let _activeTabMenu = null; // track open right-click context menu
  let _groupRatios = null;    // null=flex equal; {ratios:[0.3,0.7]} for proportional restore on resize
  let _resizeTimer = null;
  var _pinnedPaths = {};    // ★ 文档级 pin 真理（2026-08-16）：filePath → true = 已编辑过 → 正体（全分组一致）；未编辑 → 斜体预览
  var _deletedPaths = {};    // ★ 文件已删除缓存（2026-08-17）：filePath → true = 磁盘文件已删除，tab 显示灰色+删除线

  // ---- DOM builders ----
  function createGroupEl(type) {
    const g = document.createElement('div');
    g.className = 'qqq-tab-group';
    g.style.flex = '1 1 0';
    const minW = (type === 'gaea') ? MIN_GAEA : MIN_W;
    g.style.minWidth = minW + 'px';

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
    // ★ 2026-08-18: custom tab（kmd 等）同样挂载——菜单支持在右/左组重开 + 关闭其他/关闭所有
    if (tab.filePath || tab.custom) {
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

  // ---- Tab deleted state (file removed from disk) ----
  function _setTabDeleted(filePath, deleted) {
    _deletedPaths[filePath] = !!deleted;
    // Update all tabs with this filePath
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath !== filePath) continue;
        t.deleted = !!deleted;
      }
    }
    // Refresh all matching tab buttons
    for (const grp of groups) {
      if (grp.type !== 'file') continue;
      for (const t of grp.tabs) {
        if (t.filePath !== filePath) continue;
        updateTabBtnTitle(t);
      }
    }
  }

  async function _checkFileDeleted(filePath) {
    if (!filePath || !window.bridge || !window.bridge.fs || !window.bridge.fs.stat) return;
    try {
      var st = await window.bridge.fs.stat(filePath);
      var exists = !!(st && st.isFile);
      // Read current deleted state from any tab with this filePath
      var currentDeleted = false;
      for (const grp of groups) {
        if (grp.type !== 'file') continue;
        const t = grp.tabs.find(function(t2) { return t2.filePath === filePath; });
        if (t) { currentDeleted = !!t.deleted; break; }
      }
      if (!exists !== !currentDeleted) {
        _setTabDeleted(filePath, !exists);
      }
    } catch (_) { /* stat error (network issue) — don't change state */ }
  }

  // ---- Activate tab ----
  function activateTab(grp, tabId) {
    // ★ 暂停旧活跃编辑器 layout（避免 display:none 时 Monaco 做无意义 layout）
    var oldTab = grp.tabs.find(function (t) { return t.id === grp.activeTabId; });
    if (oldTab && oldTab.filePath && window.qqqEditor && window.qqqEditor.suspendPaneLayout) {
      window.qqqEditor.suspendPaneLayout(oldTab.filePath, oldTab.paneEl);
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
      var _pe = newTab.paneEl;
      requestAnimationFrame(function () {
        window.qqqEditor.resumePaneLayout(_fp, _pe);
      });
    }

    // ★ 2026-08-25: custom tab 可见性事件驱动通知（kmd here 指示牌/焦点态零轮询）——
    //   tab 切走/切回唯一中心路径（点击/滚轮/右键重开/单例激活/恢复全收敛于此）；
    //   active 标志供 renderFn/kmd:init 初始态兜底（快速切走窗口期消息丢失时 kmd:init 读真实值）
    if (newTab && newTab !== oldTab) {
      // 同 tab 重复激活（单例复用路径）→ 零派发零翻转，状态不变
      if (oldTab && oldTab._onVisible) oldTab._onVisible(false);
      if (oldTab) oldTab.active = false;
      if (newTab._onVisible) newTab._onVisible(true);
      newTab.active = true;
    }

    // fire callback
    if (newTab && newTab.onActivate) newTab.onActivate(newTab);

    // ★ 2026-08-17: 激活后异步检查文件是否存在
    if (newTab && newTab.filePath) {
      _checkFileDeleted(newTab.filePath);
    }
  }

  // ---- Close tab ----
  function closeTabById(grp, tabId) {
    const idx = grp.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    const tab = grp.tabs[idx];

    // ★ 关闭前暂停旧编辑器 layout（避免 pane.remove 触发 0×0 尺寸的昂贵 layout）
    if (tab.filePath && window.qqqEditor && window.qqqEditor.suspendPaneLayout) {
      window.qqqEditor.suspendPaneLayout(tab.filePath, tab.paneEl);
    }

    // remove tab button（轻量，无 DOM 依赖问题）
    const btn = grp.barEl.querySelector(`[data-tab-id="${tabId}"]`);
    if (btn) btn.remove();

    // ★ 同步销毁编辑器 + 移除 pane DOM（2026-08-15 改同步——根治 not-a-child 崩溃）：
    //   ① MUST 先 dispose 编辑器再移除 pane：Monaco 内部 _detachModel 需要 DOM 父子关系完整
    //   ② 旧 setTimeout(0) 异步方案有竞态——关最后一个文件 tab 时 removeGroup 同步删整个 group DOM，
    //      宏任务再跑 dispose → 编辑器在已脱离文档的树上销毁 → Monaco view 内部 unguarded removeChild 抛
    //      "The node to be removed is not a child of this node"（2026-08-15 客户日志实锤）
    const pane = grp.contentEl.querySelector(`.qqq-tab-pane[data-tab-id="${tabId}"]`);
    if (tab.filePath && window.qqqEditor && window.qqqEditor.disposePaneEditor) {
      window.qqqEditor.disposePaneEditor(tab.filePath, pane);
    }
    if (pane && pane.parentNode) pane.remove();

    // fire cleanup
    if (tab.onClose) tab.onClose(tab);

    grp.tabs.splice(idx, 1);

    // ★ 2026-08-21: 关闭最后一个同路径 tab → 释放文档级真理（pin/dirty/deleted）
    //   否则全部关闭后重开同一文件仍显示正体（_pinnedPaths 残留）——预期是斜体预览
    if (tab.filePath) {
      var _stillAny = false;
      for (var _g of groups) {
        if (_g.type !== 'file') continue;
        if (_g.tabs.some(function (t) { return t.filePath === tab.filePath; })) { _stillAny = true; break; }
      }
      if (!_stillAny) {
        delete _pinnedPaths[tab.filePath];
        delete _deletedPaths[tab.filePath];
      }
    }

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
        // ★ 2026-08-17: 文件已删除状态——灰色+删除线（CSS class，.qqq-tab-deleted）
        btn.classList.toggle('qqq-tab-deleted', !!t.deleted);
      }
    }
  }

  // ★ 唯一真理中心机器：一切 tab dirty/preview 状态变更必须走此函数。
  //   patch 可含 {dirty, preview}，只更新传入的字段。
  //   穷举一切路径：setTabDirty / replaceFileInTab / openFileIn{Left,Right}Group 预览复用。
  //   ★ 2026-08-16 定案：dirty 与 preview/pin 同为文档级真理（路径级）——
  //     一个文档无论在哪个分组，斜体(预览)/正体(已编辑)/星号(脏) 必须 100% 一致（用户明确要求）。
  function _setTabState(filePath, patch) {
    // 更新 tab 对象（全量广播所有分组同文件 tab）
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
    // 首次编辑 → 文档级 pin（全部分组同文件 tab 一并正体；保存后不复位斜体，VS Code 同款）
    if (dirty) { _pinnedPaths[filePath] = true; patch.preview = false; }
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
    // ★ 2026-08-18: custom tab（kmd）走 onReopen（goods 自管新会话/标题序号）或通用复刻
    if (tab.custom) {
      if (isFirstFileGroup) {
        addRow(window._i('shell.tab.openRight', '在右侧再开'), () => { _reopenCustomInGroup(tab, 'right'); });
      } else if (isSecondFileGroup) {
        addRow(window._i('shell.tab.openLeft', '在左侧再开'), () => { _reopenCustomInGroup(tab, 'left'); });
      }
    } else if (tab.filePath) {
      if (isFirstFileGroup) {
        addRow(window._i('shell.tab.openRight', '在右侧再开'), () => { openFileInRightGroup(tab.filePath); });
      } else if (isSecondFileGroup) {
        addRow(window._i('shell.tab.openLeft', '在左侧再开'), () => { openFileInLeftGroup(tab.filePath); });
      }
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
    // ★ 文件分组硬上限 2（中间+右侧）——gaea 常驻组不计；任何路径不得创建第 3 个文件分组
    if (type === 'file' && groups.filter(g => g.type === 'file').length >= 2) return null;

    const dom = createGroupEl(type);
    const grp = {
      idx: groups.length,
      type: type,
      minW: (type === 'gaea') ? MIN_GAEA : MIN_W,
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
    // ★ 2026-09-04：组增减后统一按实测宽度水密舱重分配（消除 px/flex 混合态与空缝）
    if (groups.length >= 2) { _saveGroupRatios(); _onGroupResize(); }
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

    // ★ 2026-09-04：剩余组按实测宽度水密舱重分配（单组回弹 flex 填满；多组等比吃回释放空间，零空缝零跳变）
    if (groups.length <= 1) {
      _groupRatios = null;
      groups.forEach(g => { g.el.style.flex = '1 1 0'; });
    } else {
      _saveGroupRatios();
      _onGroupResize();
    }
    rebindAllSashes();
  }

  // Rebind ALL inter-group sashes（★ 2026-09-04 级联废除）：每条 sash 只绑定紧邻两分组——
  // 拖拽重分配仅发生在 G(i-1)⎮G(i) 之间，远端分组（含 gaea G0）数学上不可能被波及。
  function rebindAllSashes() {
    for (let i = 1; i < groups.length; i++) {
      const grp = groups[i];
      const sash = grp._sashEl;
      if (!sash) continue;
      // Replace node to drop previous mousedown listener
      const fresh = sash.cloneNode(false);
      sash.parentNode.replaceChild(fresh, sash);
      grp._sashEl = fresh;
      const left = groups[i - 1];
      const right = groups[i];
      window.qqqideSash.bindV(fresh,
        {
          getW: () => left.el.offsetWidth,
          setW: w => { left.el.style.flex = '0 0 ' + w + 'px'; _saveGroupRatios(); },
          min: left.minW || MIN_W,
        },
        {
          getW: () => right.el.offsetWidth,
          setW: w => { right.el.style.flex = '0 0 ' + w + 'px'; _saveGroupRatios(); },
          min: right.minW || MIN_W,
        }
      );
    }
  }

  // Save group width ratios for proportional restore on window resize
  function _saveGroupRatios() {
    if (groups.length < 2) { _groupRatios = null; return; }
    const totalW = groups.reduce((s, g) => s + g.el.offsetWidth, 0);
    if (totalW <= 0) { _groupRatios = null; return; }
    _groupRatios = { ratios: groups.map(g => g.el.offsetWidth / totalW) };
  }

  // On window resize / group count change: 水密舱重分配（2026-09-04 闭环）
  // 保证（availW ≥ Σ底线 时）: Σ分配 = availW 且每组 ≥ 自身底线；Σ底线 > availW（物理极限）→ 各保底线，溢出由容器裁切。
  function _onGroupResize() {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      _resizeTimer = null;
      if (!hostEl || groups.length < 2) return;
      if (!_groupRatios || !_groupRatios.ratios || _groupRatios.ratios.length !== groups.length) {
        // No custom ratios → reset to equal flex（各组 min-width 内联兜底）
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
      const n = groups.length;
      const mins = groups.map(g => g.minW || MIN_W);
      const sumMin = mins.reduce((s, m) => s + m, 0);
      // 后缀底线和：hi_idx = availW − usedW − suffixMin[idx+1]
      const suffixMin = new Array(n + 1).fill(0);
      for (let i = n - 1; i >= 0; i--) suffixMin[i] = suffixMin[i + 1] + mins[i];
      if (availW < sumMin) {
        // 物理极限：各保底线，溢出由容器裁切（正确退化，不再互相压缩）
        groups.forEach((g, i) => { g.el.style.flex = '0 0 ' + mins[i] + 'px'; });
        return;
      }
      let usedW = 0;
      for (let idx = 0; idx < n - 1; idx++) {
        const hi = availW - usedW - suffixMin[idx + 1];
        const target = Math.round(_groupRatios.ratios[idx] * availW);
        const w = Math.min(Math.max(target, mins[idx]), Math.max(hi, mins[idx]));
        groups[idx].el.style.flex = '0 0 ' + w + 'px';
        usedW += w;
      }
      groups[n - 1].el.style.flex = '0 0 ' + (availW - usedW) + 'px';
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
      // ★ roam 标签召回提示（2026-08-09）: hover 瞬间弹出大字号 tooltip
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

    // ★ 先销毁旧编辑器再清空 pane——innerHTML='' 直接杀 DOM 会让 Monaco widget 变孤儿
    //   （JS 存活 + DOM 全毁），其 model 稍后被 dispose 时 onWillDispose → setModel(null) →
    //   view 内部 unguarded removeChild → "not a child" 崩溃（2026-08-15 实锤）
    var _oldPath = tab.filePath;
    if (_oldPath && _oldPath !== filePath && tab.paneEl &&
        window.qqqEditor && window.qqqEditor.disposePaneEditor) {
      try { window.qqqEditor.disposePaneEditor(_oldPath, tab.paneEl); } catch (_) {}
    }
    // Clean old pane content
    if (tab.paneEl) { tab.paneEl.innerHTML = ''; }

    // Update tab identity
    tab.filePath = filePath;
    tab.title = fileName;
    // ★ dirty 从编辑器真理读：_paneDirtyMap 残留 true（同文件另一格编辑器未保存）时
    //   新预览 tab 必须如实显示星号，不能硬编码 false（旧实现 → 编辑时 _markDirty 不触发 → 星号永不出现）
    tab.dirty = !!(window.qqqEditor && window.qqqEditor.isPathDirty && window.qqqEditor.isPathDirty(filePath));
    // ★ 文档级真理：已编辑过的文档（_pinnedPaths）新开仍正体；从未编辑 → 斜体预览
    tab.preview = !_pinnedPaths[filePath];

    // ★ 中心机器：统一设置 tab 状态并刷新标题（dirty+preview 全量广播——文档状态跨分组 100% 一致）
    _setTabState(filePath, { dirty: tab.dirty, preview: tab.preview });
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
      // ★ 文档级真理：preview = 未编辑过（_pinnedPaths 无记录）；dirty 读编辑器真理
      preview: !_pinnedPaths[filePath],
      dirty: !!(window.qqqEditor && window.qqqEditor.isPathDirty && window.qqqEditor.isPathDirty(filePath)),
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
      // ★ 先销毁旧编辑器再清空 pane（防孤儿 widget → not-a-child，同 replaceFileInTab）
      var _oldPathR = previewTab.filePath;
      if (_oldPathR && _oldPathR !== filePath && previewTab.paneEl &&
          window.qqqEditor && window.qqqEditor.disposePaneEditor) {
        try { window.qqqEditor.disposePaneEditor(_oldPathR, previewTab.paneEl); } catch (_) {}
      }
      if (previewTab.paneEl) previewTab.paneEl.innerHTML = '';
      previewTab.filePath = filePath;
      previewTab.title = fileName;
      // ★ dirty 从编辑器真理读（同 replaceFileInTab）
      previewTab.dirty = !!(window.qqqEditor && window.qqqEditor.isPathDirty && window.qqqEditor.isPathDirty(filePath));
      // ★ 文档级真理：已编辑过 → 正体（全组一致）；从未编辑 → 斜体预览
      previewTab.preview = !_pinnedPaths[filePath];
      _setTabState(filePath, { dirty: previewTab.dirty, preview: previewTab.preview });
      const btn = targetGrp.barEl.querySelector(`[data-tab-id="${previewTab.id}"]`);
      if (btn) btn.dataset.filePath = filePath;
      activateTab(targetGrp, previewTab.id);
      document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: previewTab.paneEl } }));
      persistOpenTabs();
      return previewTab;
    }

    const tabId = _nextTabId++;
    const tab = { id: tabId, title: fileName, filePath: filePath, closable: true, onActivate: null, onClose: null, preview: !_pinnedPaths[filePath], dirty: !!(window.qqqEditor && window.qqqEditor.isPathDirty && window.qqqEditor.isPathDirty(filePath)) };
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
      // ★ 先销毁旧编辑器再清空 pane（防孤儿 widget → not-a-child，同 replaceFileInTab）
      var _oldPathL = previewTab.filePath;
      if (_oldPathL && _oldPathL !== filePath && previewTab.paneEl &&
          window.qqqEditor && window.qqqEditor.disposePaneEditor) {
        try { window.qqqEditor.disposePaneEditor(_oldPathL, previewTab.paneEl); } catch (_) {}
      }
      if (previewTab.paneEl) previewTab.paneEl.innerHTML = '';
      previewTab.filePath = filePath;
      previewTab.title = fileName;
      // ★ dirty 从编辑器真理读（同 replaceFileInTab）
      previewTab.dirty = !!(window.qqqEditor && window.qqqEditor.isPathDirty && window.qqqEditor.isPathDirty(filePath));
      // ★ 文档级真理：已编辑过 → 正体（全组一致）；从未编辑 → 斜体预览
      previewTab.preview = !_pinnedPaths[filePath];
      _setTabState(filePath, { dirty: previewTab.dirty, preview: previewTab.preview });
      const btn = targetGrp.barEl.querySelector(`[data-tab-id="${previewTab.id}"]`);
      if (btn) btn.dataset.filePath = filePath;
      activateTab(targetGrp, previewTab.id);
      document.dispatchEvent(new CustomEvent('qqq-file-open-in-pane', { detail: { path: filePath, pane: previewTab.paneEl } }));
      persistOpenTabs();
      return previewTab;
    }

    const tabId = _nextTabId++;
    const tab = { id: tabId, title: fileName, filePath: filePath, closable: true, onActivate: null, onClose: null, preview: !_pinnedPaths[filePath], dirty: !!(window.qqqEditor && window.qqqEditor.isPathDirty && window.qqqEditor.isPathDirty(filePath)) };
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

  // ---- Public: open custom tab in file group (kmd terminal etc.) ----
  // ★ 2026-08-12: kmd 例外——X 区中间/右侧 editor 分组（非 gaea 分组）。
  //   单例语义（customId 已打开 → 激活返回，opts.allowMulti=true 跳过——kmd 多开 2026-08-18）；
  //   内容由 renderFn 渲染（iframe/任意 DOM）；无 filePath → 不触发 Monaco 挂载、
  //   不进 editor.tabs 持久化（_collectAllTabs 只收 filePath）；
  //   ★ 2026-08-18: 右键菜单支持（custom tab 在右/左组重开——onReopen 回调优先，
  //   否则 tab-manager 通用复刻 renderFn）；opts.group = 'right' | 'left' | 组对象 指定目标分组；
  //   tab 关闭走常规 closeTabById（pane.remove + onClose）。
  function openFileCustomTab(customId, title, renderFn, opts) {
    opts = opts || {};
    // 单例：任何 file 分组已打开同 customId → 激活（allowMulti=true 时跳过，每次新建）
    if (!opts.allowMulti) {
      for (const grp of groups) {
        if (grp.type !== 'file') continue;
        const existing = grp.tabs.find(t => t.customId === customId);
        if (existing) {
          activateTab(grp, existing.id);
          return existing;
        }
      }
    }
    // 目标分组：opts.group 指定（'right'/'left'/组对象）→ 默认第一个 file 分组
    let fileGrp = null;
    if (opts.group === 'right') {
      const fgs = groups.filter(g => g.type === 'file');
      fileGrp = fgs.length >= 2 ? fgs[fgs.length - 1] : addGroup('file');
    } else if (opts.group === 'left') {
      const fgs = groups.filter(g => g.type === 'file');
      fileGrp = fgs.length >= 1 ? fgs[0] : addGroup('file');
    } else if (opts.group && typeof opts.group === 'object') {
      fileGrp = opts.group;
    }
    if (!fileGrp) {
      fileGrp = groups.find(g => g.type === 'file');
      if (!fileGrp) fileGrp = addGroup('file');
    }
    if (!fileGrp) return null;

    const tabId = _nextTabId++;
    const tab = { id: tabId, customId: customId, title: title, closable: true, onActivate: null, onClose: null, custom: true, preview: false, dirty: false };
    // ★ 2026-08-18: 保存渲染闭包供右键「重开」通用复刻（goods 注册 onReopen 则优先）
    tab._custom = { renderFn: renderFn, opts: opts };
    const btn = createTabBtn(tab, fileGrp);
    fileGrp.barEl.appendChild(btn);
    const pane = createTabPane(tab);
    fileGrp.contentEl.appendChild(pane);
    tab.paneEl = pane;
    fileGrp.tabs.push(tab);
    activateTab(fileGrp, tabId);

    if (renderFn) {
      try { renderFn(pane, tab); }
      catch (e) { pane.textContent = 'render error: ' + (e && e.message); }
    }
    return tab;
  }

  // ★ 2026-08-18: 右键「在右/左组再开」custom tab（kmd 等）
  //   优先 tab.onReopen（goods 自管：新会话/标题序号/内部注册表）；未注册 → 通用复刻 renderFn。
  function _reopenCustomInGroup(tab, side) {
    // goods 自管重开（kmd.js: openKmdTab(side)）——内部会话注册/标题序号由 goods 闭包掌控
    if (typeof tab.onReopen === 'function') {
      try { return tab.onReopen(side); } catch (_) { return null; }
    }
    // 通用复刻：同 renderFn/opts 新建 tab
    var c = tab._custom;
    if (!c) return null;
    const fgs = groups.filter(g => g.type === 'file');
    let targetGrp = null;
    if (side === 'right') {
      targetGrp = fgs.length >= 2 ? fgs[fgs.length - 1] : addGroup('file');
    } else {
      targetGrp = fgs.length >= 1 ? fgs[0] : addGroup('file');
    }
    if (!targetGrp) return null;
    if (!c.opts.allowMulti) {
      const existing = targetGrp.tabs.find(t => t.customId === tab.customId);
      if (existing) { activateTab(targetGrp, existing.id); return existing; }
    }
    const tabId = _nextTabId++;
    const nt = { id: tabId, customId: tab.customId, title: tab.title, closable: true, onActivate: null, onClose: null, custom: true, preview: false, dirty: false, onReopen: tab.onReopen };
    nt._custom = c;
    const btn = createTabBtn(nt, targetGrp);
    targetGrp.barEl.appendChild(btn);
    const pane = createTabPane(nt);
    targetGrp.contentEl.appendChild(pane);
    nt.paneEl = pane;
    targetGrp.tabs.push(nt);
    activateTab(targetGrp, tabId);
    if (c.renderFn) {
      try { c.renderFn(pane, nt); }
      catch (e) { pane.textContent = 'render error: ' + (e && e.message); }
    }
    return nt;
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
            // ★ 重建文档级 pin 真理（持久化 preview=false = 已编辑过 → 正体，跨分组一致）
            if (!item.preview) _pinnedPaths[item.path] = true;
            document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: item.path, groupIdx: item.groupIdx } }));
            // ★ 2026-08-17: 恢复后检查文件是否存在（已删除的文件显示灰色+删除线）
            setTimeout(function(fp) { _checkFileDeleted(fp); }, 500, item.path);
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

  // ★ roam 硬创建函数：零依赖 goods/gaea-host，零异步
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
    // ★ roam 永远是 gaea 分组的第一个标签，在所有持久化/异步逻辑之前同步创建
    _createRoamTabHard();
    setTimeout(function () { restoreOpenTabs(); }, 100);
  }

  // ---- closeTabById override: re-create roam if closed + persist ----
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

  // ---- Rename custom/file tab（kmd 命名：实时同步 + 边界守卫） ----
  // 守卫：空标题忽略（保留原标题）；按 code point 计数（emoji/中文按字符）超 40 截断；
  //       textContent 更新（防 HTML 注入）。
  function setCustomTabTitle(tabId, title) {
    var t = String(title == null ? '' : title).trim();
    if (!t) return null;
    var cps = Array.from(t);
    if (cps.length > 40) { t = cps.slice(0, 40).join(''); }
    for (const grp of groups) {
      const tab = grp.tabs.find(x => x.id === tabId);
      if (!tab) continue;
      tab.title = t;
      const btn = grp.barEl.querySelector('[data-tab-id="' + tabId + '"]');
      if (btn) {
        const nameSpan = btn.querySelector('.qqq-tab-name');
        if (nameSpan) nameSpan.textContent = t;
      }
      return tab;
    }
    return null;
  }

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
    if (!path) return;
    // ★ 2026-08-16 定案：dirty/preview 全量广播——文档状态跨分组 100% 一致
    setTabDirty(path, dirty);
  });

  window.qqqTabs = {
    init,
    addGaeaTab,
    openFile,
    openFileInRightGroup,
    openFileInLeftGroup,
    openFileCustomTab,
    setCustomTabTitle,
    splitRight,
    closeTab,
    activateTab,
    getGroups,
    getActiveGroup,
    getGaeaGroup,
    renameGaeaTab,
    setTabDirty,
    setTabDeleted: _setTabDeleted,
    persistOpenTabs,
    flushOpenTabs: function () { if (_persistTimer) { clearTimeout(_persistTimer); _doPersistOpenTabs(); } },
  };
})();