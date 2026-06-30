// ============================================================================
// shell-menu.js — 菜单栏（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window.qqqDefaultMenuSchema, window._i
// 导出: window._shHandleMenuCmd (供 shell-rpc.js 的 bootKeyHook 使用)
// 功能: 菜单弹出/高亮/命令分发 + "开新窗口" 行外嵌 square button + 最近文件夹下拉
//       窗口快照保存/恢复 (win_snap:{folderPath} in qgs)
// ============================================================================

var _shellActiveMenubarPopup = null;
var _shellMenuRecentDropdown = null;   // square button 的最近文件夹下拉
var _shellMenuRecentHoverTimer = null; // square button hover → 延迟显示下拉
var _shellMenuSqBtn = null;            // 外嵌 square ▶ button（挂在 popup 外面）

function _shellCloseMenubarPopup() {
  // 移除外嵌 square button
  if (_shellMenuSqBtn) { try { _shellMenuSqBtn.remove(); } catch (_) { } _shellMenuSqBtn = null; }
  if (_shellActiveMenubarPopup) { try { _shellActiveMenubarPopup.remove(); } catch (_) { } _shellActiveMenubarPopup = null; }
  _closeMenuRecentDropdown();
}

function _closeMenuRecentDropdown() {
  if (_shellMenuRecentDropdown) {
    try { _shellMenuRecentDropdown.remove(); } catch (_) { }
    _shellMenuRecentDropdown = null;
  }
  if (_shellMenuRecentHoverTimer) { clearTimeout(_shellMenuRecentHoverTimer); _shellMenuRecentHoverTimer = null; }
  // 恢复 square button 可见性
  if (_shellMenuSqBtn && _shellMenuSqBtn._sqRestore) { _shellMenuSqBtn._sqRestore(); }
}

// ---- 窗口快照：保存到 qgs global，key=win_snap:{normalizedPath} ----
function _saveWindowSnapshot() {
  var bridge = window.qqqideBridge;
  if (!bridge || !bridge.state) return;
  var root = (window._workspaceRoot || '');
  root = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (!root) return;

  var snap = { mainFolder: root, atime: Date.now() };

  // aux folders (from ai-viewport)
  if (window.qqqideViewport && window.qqqideViewport.getProjects) {
    var allProj = window.qqqideViewport.getProjects();
    snap.auxFolders = [];
    for (var pi = 1; pi < allProj.length; pi++) {
      snap.auxFolders.push(allProj[pi].path);
    }
  }

  // editor tabs (from qqqtabs)
  if (window.qqqTabs && window.qqqTabs.getGroups) {
    var groups = window.qqqTabs.getGroups();
    snap.editorTabs = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      if (g.type !== 'file') continue;
      for (var ti = 0; ti < g.tabs.length; ti++) {
        var t = g.tabs[ti];
        if (t.filePath) {
          snap.editorTabs.push({
            path: t.filePath,
            groupIdx: g.idx,
            active: t.id === g.activeTabId,
            preview: !!t.preview
          });
        }
      }
    }
    if (snap.editorTabs.length === 0) delete snap.editorTabs;
  }

  // layout
  if (window.qqqLayout && window.qqqLayout.getState) {
    snap.layout = window.qqqLayout.getState();
  }

  // theme
  snap.theme = document.documentElement.getAttribute('data-theme') || 'light';

  // ★ AI 面板快照不重复造轮子——only.sq3 (onlyStore) 已完整记录

  // ★ editor 光标位置
  if (window.qqqEditor && window.qqqEditor.getAllEditorPositions) {
    var cursorPos = window.qqqEditor.getAllEditorPositions();
    var cursorKeys = Object.keys(cursorPos);
    if (cursorKeys.length > 0) snap.editorPositions = cursorPos;
  }

  var key = 'win_snap:' + root;
  if (bridge.state.setNow) {
    bridge.state.setNow('qqqide', key, snap).catch(function () { });
  } else {
    bridge.state.set('qqqide', key, snap).catch(function () { });
  }
}

// ---- 读取快照 (从 qgs) ----
function _loadWindowSnapshot(folderPath) {
  var bridge = window.qqqideBridge;
  if (!bridge || !bridge.state) return Promise.resolve(null);
  var key = 'win_snap:' + folderPath.replace(/\\/g, '/').replace(/\/$/, '');
  return bridge.state.get('qqqide', key).catch(function () { return null; });
}

// ---- 显示 square button 的最近文件夹下拉（无标题行，直接显示列表）----
function _showMenuRecentDropdown(sqBtn, leftPx, topPx) {
  if (_shellMenuRecentDropdown) return;
  _closeMenuRecentDropdown();
  if (!sqBtn || !sqBtn.isConnected) return;

  var maxH = Math.max(200, window.innerHeight - topPx - 8);

  var dd = document.createElement('div');
  dd.className = 'qqq-menubar-recent-dropdown';
  dd.style.cssText =
    'position:fixed; z-index:100000; ' +
    'left:' + leftPx + 'px; top:' + topPx + 'px; ' +
    'min-width:280px; max-width:420px; max-height:' + maxH + 'px; ' +
    'overflow-y:auto; ' +
    'background:var(--card-bg); border:1px solid var(--border-color); ' +
    'border-radius:3px; box-shadow:0 4px 16px rgba(0,0,0,.18); padding:4px 0;';

  var bridge = window.qqqideBridge;
  function renderRows(folders) {
    if (!folders || folders.length === 0) {
      var emptyRow = document.createElement('div');
      emptyRow.style.cssText = 'padding:10px 12px; font-size:12px; color:var(--text-muted); font-style:italic;';
      emptyRow.textContent = window._i ? window._i('shell.viewport.noRecent', '暂无最近记录') : '暂无最近记录';
      dd.appendChild(emptyRow);
      return;
    }
    folders.forEach(function (f) {
      var row = document.createElement('div');
      row.style.cssText =
        'padding:8px 12px; font-size:12px; color:var(--text-primary); ' +
        'display:flex; align-items:center; gap:6px; white-space:nowrap;';

      var icon = document.createElement('span');
      icon.textContent = '\uD83D\uDCC1';
      icon.style.cssText = 'font-size:11px; flex-shrink:0;';

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px;';
      var name = f.name || '';
      if (!name && f.path) { var parts = f.path.replace(/\\/g, '/').split('/').filter(Boolean); name = parts[parts.length - 1] || f.path; }
      nameSpan.textContent = name.length > 24 ? name.slice(0, 24) + '...' : name;

      var pathSpan = document.createElement('span');
      pathSpan.style.cssText = 'color:var(--text-muted); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;';
      pathSpan.textContent = f.path;
      pathSpan.title = f.path;

      row.appendChild(icon);
      row.appendChild(nameSpan);
      row.appendChild(pathSpan);

      (function (r) {
        r.addEventListener('mouseenter', function () { r.style.background = 'var(--background-color)'; });
        r.addEventListener('mouseleave', function () { r.style.background = ''; });
      })(row);

      row.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        e.preventDefault();
        _closeMenuRecentDropdown();
        _shellCloseMenubarPopup();
        _bumpMenuRecent(f.path);
        _openWindowFromRecent(f.path);
      });

      dd.appendChild(row);
    });
  }

  // mouseleave → 延迟关闭（允许鼠标从按钮移到下拉）
  dd.addEventListener('mouseleave', function () {
    if (_shellMenuRecentHoverTimer) clearTimeout(_shellMenuRecentHoverTimer);
    _shellMenuRecentHoverTimer = setTimeout(function () {
      _shellMenuRecentHoverTimer = null;
      _closeMenuRecentDropdown();
    }, 200);
  });
  dd.addEventListener('mouseenter', function () {
    if (_shellMenuRecentHoverTimer) { clearTimeout(_shellMenuRecentHoverTimer); _shellMenuRecentHoverTimer = null; }
  });

  if (bridge && bridge.state) {
    bridge.state.get('qqqide', 'recent_folders').then(function (data) {
      if (_shellMenuRecentDropdown !== dd) return;
      while (dd.firstChild) { dd.removeChild(dd.firstChild); }
      var folders = (data && Array.isArray(data)) ? data.slice(0, 20) : [];
      renderRows(folders);
    }).catch(function () {
      if (_shellMenuRecentDropdown !== dd) return;
      while (dd.firstChild) { dd.removeChild(dd.firstChild); }
      renderRows([]);
    });
    var loadingRow = document.createElement('div');
    loadingRow.style.cssText = 'padding:10px 12px; font-size:12px; color:var(--text-muted);';
    loadingRow.textContent = '...';
    dd.appendChild(loadingRow);
  } else {
    renderRows([]);
  }

  document.body.appendChild(dd);
  _shellMenuRecentDropdown = dd;
}

// ---- 从最近文件夹打开新窗口 ----
function _openWindowFromRecent(folderPath) {
  var bridge = window.qqqideBridge;
  _saveWindowSnapshot();
  if (bridge && bridge.window && bridge.window.new) {
    bridge.window.new(folderPath).then(function (r) {
      if (r && !r.ok) { console.warn('[shell-menu] newWindow failed:', r); }
    }).catch(function (e) {
      console.error('[shell-menu] newWindow error:', e);
    });
  }
}

// ---- 写入最近文件夹到 global.sq3（与 ai-viewport.js 共享同一 key）----
function _bumpMenuRecent(folderPath) {
  var bridge = window.qqqideBridge;
  if (!bridge || !bridge.state) return;
  var name = '';
  try {
    var parts = folderPath.replace(/\\/g, '/').split('/').filter(Boolean);
    name = parts[parts.length - 1] || folderPath;
  } catch (_) { name = folderPath; }
  bridge.state.get('qqqide', 'recent_folders').then(function (data) {
    var list = (data && Array.isArray(data)) ? data.slice(0, 20) : [];
    list = list.filter(function (f) { return f.path !== folderPath; });
    list.unshift({ path: folderPath, name: name, atime: Date.now() });
    if (list.length > 20) list.length = 20;
    bridge.state.set('qqqide', 'recent_folders', list).catch(function () { });
  }).catch(function () { });
}

// ---- 创建外嵌 square ▶ button（高=行高，hover 即消失→直接展开列表）----
function _createSqBtn(pop, targetRow, cmd) {
  if (_shellMenuSqBtn) { try { _shellMenuSqBtn.remove(); } catch (_) { } }
  var popRect = pop.getBoundingClientRect();
  var rowRect = targetRow.getBoundingClientRect();
  var btnH = rowRect.height;
  var sqBtn = document.createElement('span');
  sqBtn.className = 'qqq-menu-sq-btn';
  sqBtn.style.cssText =
    'position:fixed; z-index:100001; ' +
    'display:inline-flex; align-items:center; justify-content:center; ' +
    'width:' + Math.round(btnH * 1.2) + 'px; height:' + btnH + 'px; ' +
    'left:' + popRect.right + 'px; top:' + rowRect.top + 'px; ' +
    'border-radius:2px; font-size:10px; color:var(--text-muted); ' +
    'background:var(--card-bg); border:1px solid var(--border-color); ' +
    'user-select:none; cursor:default;';
  sqBtn.textContent = '\u25B6';

  // hover → 按钮消失，直接展开最近文件夹列表
  sqBtn.addEventListener('mouseenter', function (e) {
    e.stopPropagation();
    sqBtn.style.display = 'none';
    _showMenuRecentDropdown(sqBtn, popRect.right, rowRect.top);
  });

  // 恢复回调 — 下拉关闭时调用
  sqBtn._sqRestore = function () {
    if (sqBtn.isConnected) sqBtn.style.display = '';
  };

  document.body.appendChild(sqBtn);
  _shellMenuSqBtn = sqBtn;
}

function _shellOpenMenubarPopup(anchorEl, item) {
  _shellCloseMenubarPopup();
  if (!item.sub || item.sub.length === 0) return;
  var rect = anchorEl.getBoundingClientRect();
  var pop = document.createElement('div');
  pop.className = 'qqq-menubar-popup';
  pop.style.cssText =
    'position:fixed; z-index:99999; ' +
    'left:' + rect.left + 'px; top:' + rect.bottom + 'px; ' +
    'min-width:180px; background:var(--card-bg); ' +
    'border:1px solid var(--border-color); border-radius:3px; ' +
    'box-shadow:0 4px 16px rgba(0,0,0,.18); padding:4px 0;';

  var hasRecentRow = null; // 记下 hasRecent 行，最后创建外嵌按钮

  for (var i = 0; i < item.sub.length; i++) {
    var s = item.sub[i];
    if (s.type === 'separator') {
      var sep = document.createElement('div');
      sep.style.cssText = 'height:1px; margin:4px 8px; background:var(--border-color);';
      pop.appendChild(sep);
      continue;
    }
    var row = document.createElement('div');
    // ★ 统一宽度，不再特殊加宽
    row.style.cssText =
      'display:flex; align-items:center; padding:5px 14px; ' +
      'font-size:12px; color:var(--text-primary); ' +
      'white-space:nowrap; user-select:none;';
    var lab = document.createElement('span');
    lab.textContent = (s.i18n && window._i) ? window._i(s.i18n, s.label) : (s.label || '');
    lab.style.cssText = 'flex:1 1 auto;';
    row.appendChild(lab);
    if (s.accel) {
      var acc = document.createElement('span');
      acc.textContent = s.accel;
      acc.style.cssText = 'margin-left:24px; color:var(--base1); font-size:11px;';
      row.appendChild(acc);
    }
    // ★ FIX: IIFE 捕获 row 引用，修复 hover 高亮偏移 bug
    (function (rowEl) {
      rowEl.addEventListener('mouseenter', function () { rowEl.style.background = 'var(--background-color)'; });
      rowEl.addEventListener('mouseleave', function () { rowEl.style.background = ''; });
    })(row);

    // 整行点击 → 执行命令
    row.addEventListener('click', (function (cmd) {
      return function (e) {
        if (e.target && e.target.closest && e.target.closest('.qqq-menu-sq-btn')) return;
        e.stopPropagation();
        _shellCloseMenubarPopup();
        if (cmd) window._shHandleMenuCmd(cmd);
      };
    })(s.cmd));
    pop.appendChild(row);

    if (s.hasRecent) hasRecentRow = { row: row, cmd: s.cmd };
  }
  document.body.appendChild(pop);
  _shellActiveMenubarPopup = pop;

  // ★ 外嵌 square ▶ button：挂在 popup 右边缘外侧，与 hasRecent 行对齐
  if (hasRecentRow) {
    // 延迟到下一帧，等 pop 布局完成
    requestAnimationFrame(function () {
      if (_shellActiveMenubarPopup === pop && hasRecentRow.row.isConnected) {
        _createSqBtn(pop, hasRecentRow.row, hasRecentRow.cmd);
      }
    });
  }
}

// handleMenuCmd — 菜单命令中枢，同时挂到 window 供 shell-rpc.js 的 keyHook 使用
window._shHandleMenuCmd = function handleMenuCmd(cmd) {
  var bridge = window.qqqideBridge;
  if (cmd === 'tools.toggleDevTools') {
    if (bridge.window && bridge.window.toggleDevTools) { bridge.window.toggleDevTools(); }
    return;
  }
  if (cmd === 'help.about') {
    bridge.dialog.message({ type: 'info', title: window._i('shell.about.title', '关于 qqq'), message: window._i('shell.about.version', 'qqq-shell v2'), detail: window._i('shell.about.desc', '便携 / Win7+ / 服务器热更') });
    return;
  }
  if (cmd === 'file.new' || cmd === 'file.open') {
    window.dispatchEvent(new CustomEvent('qqq-menu-cmd', { detail: { cmd: cmd } }));
    return;
  }
  if (cmd === 'file.newWindow') {
    _saveWindowSnapshot();
    if (bridge.window && bridge.window.new) {
      bridge.window.new().then(function (r) {
        if (r && !r.ok) { console.warn('[shell] new window failed'); }
      }).catch(function (e) {
        console.error('[shell-menu] bridge.window.new() error:', e);
      });
    }
    return;
  }
  if (cmd === 'file.exit') {
    _saveWindowSnapshot();
    if (bridge.app && bridge.app.quitAll) {
      bridge.app.quitAll();
    } else {
      bridge.window.close();
    }
    return;
  }
  if (cmd === 'zoom.in') { bridge.zoom && bridge.zoom.adjust(1); return; }
  if (cmd === 'zoom.out') { bridge.zoom && bridge.zoom.adjust(-1); return; }
  if (cmd === 'zoom.reset') { bridge.zoom && bridge.zoom.set(13); return; }
  if (cmd === 'editor.splitRight') {
    if (!window.qqqTabs) return;
    var groups = window.qqqTabs.getGroups();
    var activeFilePath = null;
    for (var i = groups.length - 1; i >= 0; i--) {
      var g = groups[i];
      if (g.type !== 'file') continue;
      var t = g.tabs.find(function (x) { return x.id === g.activeTabId; });
      if (t && t.filePath) { activeFilePath = t.filePath; break; }
    }
    if (activeFilePath) window.qqqTabs.openFileInRightGroup(activeFilePath);
    return;
  }
  if (cmd === 'window.activateRoam') {
    var it = document.querySelector('iframe[src*="q2-roam"]');
    if (it && it.contentWindow) { try { it.contentWindow.focus(); } catch (e) { } }
    return;
  }
  if (cmd === 'roam.openInIde' || cmd === 'roam.openMedia' ||
    cmd === 'roam.requestSize' || cmd === 'roam.scrollTop' ||
    cmd === 'roam.scrollBottom') {
    var it2 = document.querySelector('iframe[src*="q2-roam"]');
    if (it2 && it2.contentWindow) {
      try { it2.contentWindow.postMessage({ type: 'qqq-roam-cmd', cmd: cmd }, '*'); } catch (e) { }
    }
    return;
  }
};

// ★ 在 window 上暴露快照函数给其他模块使用
window._shSaveWindowSnapshot = _saveWindowSnapshot;
window._shLoadWindowSnapshot = _loadWindowSnapshot;

function _shellRenderMenubarLabels(schema) {
  var $bar = document.getElementById('qqq-menubar');
  if (!$bar || !schema) return;
  $bar.innerHTML = '';
  for (var i = 0; i < (schema.items || []).length; i++) {
    var item = schema.items[i];
    var span = document.createElement('span');
    span.className = 'qqq-menubar-label';
    span.textContent = (item.i18n && window._i) ? window._i(item.i18n, item.label) : (item.label || '');
    // ★ 视觉边界：加 subtle outline + 分隔线，明确点击范围
    span.style.cssText =
      'padding:0 10px; color:var(--text-primary); ' +
      'user-select:none; height:100%; display:inline-flex; align-items:center; ' +
      'border-right:1px solid var(--border-color); ' +
      'outline:1px solid transparent; outline-offset:-1px;';
    (function (sp) {
      sp.addEventListener('mouseenter', function () { sp.style.background = 'rgba(128,128,128,0.10)'; });
      sp.addEventListener('mouseleave', function () { sp.style.background = ''; });
    })(span);
    span.addEventListener('click', (function (anchorSpan, menuItem) {
      return function (e) {
        e.stopPropagation();
        if (_shellActiveMenubarPopup && _shellActiveMenubarPopup._anchor === anchorSpan) {
          _shellCloseMenubarPopup();
        } else {
          _shellOpenMenubarPopup(anchorSpan, menuItem);
          if (_shellActiveMenubarPopup) _shellActiveMenubarPopup._anchor = anchorSpan;
        }
      };
    })(span, item));
    $bar.appendChild(span);
  }
  // ★ 全局 mousedown：点击外部关闭 popup 和下拉
  //    修复 bug：点击不同 menubar label → 关闭当前 popup（label click handler 会打开新的）
  document.addEventListener('mousedown', function (e) {
    // 先检查最近文件夹下拉
    if (_shellMenuRecentDropdown) {
      if (_shellMenuRecentDropdown.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.qqq-menu-sq-btn')) return;
      _closeMenuRecentDropdown();
    }
    // 再检查菜单弹出
    if (!_shellActiveMenubarPopup) return;
    if (_shellActiveMenubarPopup.contains(e.target)) return;
    // ★ 点击外嵌 square button → 不关
    if (e.target.closest && e.target.closest('.qqq-menu-sq-btn')) return;
    // ★ 点击 popup 的 anchor label 自身 → 让 label click handler 处理 toggle
    if (_shellActiveMenubarPopup._anchor) {
      if (_shellActiveMenubarPopup._anchor === e.target) return;
      if (e.target.closest && e.target.closest('.qqq-menubar-label') === _shellActiveMenubarPopup._anchor) return;
    }
    _shellCloseMenubarPopup();
  });
}

async function bootMenu() {
  var bridge = window.qqqideBridge;
  var schema = window.qqqDefaultMenuSchema;
  if (!schema) return;
  try { await bridge.menu.set(schema); } catch (e) { console.warn('[shell] menu.set failed', e); }
  _shellRenderMenubarLabels(schema);
  window.addEventListener('qqq-lang-change', function () { _shellRenderMenubarLabels(schema); });
  bridge.menu.onFired(function (cmd) {
    window._shHandleMenuCmd(cmd);
  });

  window.addEventListener('beforeunload', function () {
    _saveWindowSnapshot();
  });
}
