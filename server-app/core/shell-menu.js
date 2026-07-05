// ============================================================================
// shell-menu.js — 菜单栏（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window.qqqDefaultMenuSchema, window._i
// 导出: window._shHandleMenuCmd (供 shell-rpc.js 的 bootKeyHook 使用)
// 功能: 菜单弹出/高亮/命令分发 + "开新窗口" 行 hover 右侧展开最近文件夹下拉
//       窗口快照保存/恢复 (win_snap:{folderPath} in qgs)
// ============================================================================

var _shellActiveMenubarPopup = null;
var _shellMenuRecentDropdown = null;   // "开新窗口" hover 的最近文件夹下拉
var _shellMenuRecentHoverTimer = null; // 延迟关闭计时器

function _shellCloseMenubarPopup() {
  if (_shellActiveMenubarPopup) { try { _shellActiveMenubarPopup.remove(); } catch (_) { } _shellActiveMenubarPopup = null; }
  _closeMenuRecentDropdown();
}

function _closeMenuRecentDropdown() {
  if (_shellMenuRecentDropdown) {
    try { _shellMenuRecentDropdown.remove(); } catch (_) { }
    _shellMenuRecentDropdown = null;
  }
  if (_shellMenuRecentHoverTimer) { clearTimeout(_shellMenuRecentHoverTimer); _shellMenuRecentHoverTimer = null; }
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

// ---- hover "开新窗口" 行 → 右侧展开最近文件夹列表 ----
function _showMenuRecentDropdown(leftPx, topPx) {
  if (_shellMenuRecentDropdown) return;
  _closeMenuRecentDropdown();

  var bridge = window.qqqideBridge;
  if (!bridge || !bridge.state) return;

  // ★ 先查数据，有记录才弹列表
  bridge.state.get('qqqide', 'recent_folders').then(function (data) {
    var folders = (data && Array.isArray(data)) ? data.slice(0, 20) : [];
    // 去重：同 path 只保留最靠前的一条
    var seen = {};
    folders = folders.filter(function (f) {
      var p = (f.path || '').replace(/\\/g, '/').replace(/\/$/, '');
      if (seen[p]) return false;
      seen[p] = true;
      return true;
    });
    if (!folders || folders.length === 0) return; // 无记录 → 不弹

    var dd = document.createElement('div');
    dd.className = 'qqq-menubar-recent-dropdown';
    var maxH = Math.max(200, window.innerHeight - topPx - 8);
    dd.style.cssText =
      'position:fixed; z-index:100000; ' +
      'left:' + leftPx + 'px; top:' + (topPx - 38) + 'px; ' +
      'min-width:280px; max-width:420px; max-height:' + maxH + 'px; ' +
      'overflow-y:auto; ' +
      'background:var(--card-bg); border:1px solid var(--border-color); ' +
      'border-radius:3px; box-shadow:0 4px 16px rgba(0,0,0,.18); padding:0;';

    folders.forEach(function (f) {
      var row = document.createElement('div');
      row.style.cssText =
        'padding:14px 12px; margin:0; line-height:1.3; font-size:13px; color:var(--text-primary); ' +
        'display:flex; align-items:center; gap:6px; white-space:nowrap; cursor:default;';

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

    dd.addEventListener('mouseleave', function () {
      if (_shellMenuRecentHoverTimer) clearTimeout(_shellMenuRecentHoverTimer);
      _shellMenuRecentHoverTimer = setTimeout(function () {
        _shellMenuRecentHoverTimer = null;
        _closeMenuRecentDropdown();
      }, 150);
    });
    dd.addEventListener('mouseenter', function () {
      if (_shellMenuRecentHoverTimer) { clearTimeout(_shellMenuRecentHoverTimer); _shellMenuRecentHoverTimer = null; }
    });

    document.body.appendChild(dd);
    _shellMenuRecentDropdown = dd;
  }).catch(function () { });
}

// ---- 从最近文件夹打开新窗口 ----
function _openWindowFromRecent(folderPath) {
  var bridge = window.qqqideBridge;
  _saveWindowSnapshot();
  // ★ 为新窗口种子辅文件夹：将当前窗口的视口项目（除去目标自身）写入目标 key
  //    新窗口 restore 时 _restoreFromProjKey 会读取并还原辅文件夹
  try {
    var curProj = window.qqqideViewport ? window.qqqideViewport.getProjects() : [];
    if (curProj && curProj.length > 0) {
      var normalizedTarget = folderPath.replace(/\\/g, '/').replace(/\/$/, '');
      var seed = [];
      for (var i = 0; i < curProj.length; i++) {
        var p = curProj[i];
        var np = p.path.replace(/\\/g, '/').replace(/\/$/, '');
        if (np === normalizedTarget) continue; // 目标自身不重复
        seed.push({ path: np, name: p.name });
      }
      // 目标在最前（主文件夹）+ 原窗口其他项目作为辅文件夹
      var targetProj = [{ path: normalizedTarget, name: '' }];
      try {
        var parts = normalizedTarget.split('/').filter(Boolean);
        targetProj[0].name = parts[parts.length - 1] || normalizedTarget;
      } catch (_) { targetProj[0].name = normalizedTarget; }
      var fullSeed = targetProj.concat(seed);
      if (bridge && bridge.state) {
        var seedKey = 'ai_viewport:' + normalizedTarget;
        bridge.state.set('qqqide', seedKey, fullSeed).catch(function () { });
      }
    }
  } catch (_) { }
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
    'box-shadow:0 4px 16px rgba(0,0,0,.18); padding:0;';

  for (var i = 0; i < item.sub.length; i++) {
    var s = item.sub[i];
    if (s.type === 'separator') {
      var sep = document.createElement('div');
      sep.style.cssText = 'height:1px; margin:4px 8px; background:var(--border-color);';
      pop.appendChild(sep);
      continue;
    }

    // ★ kope-a 行：自定义渲染（标签 + 启动/停止按钮 + 自动启动勾选框）
    if (s.hasKopeA) {
      var kopeRow = document.createElement('div');
      kopeRow.style.cssText =
        'display:flex; align-items:center; padding:8px 14px; margin:0; line-height:1.3; ' +
        'font-size:13px; color:var(--text-primary); ' +
        'white-space:nowrap; user-select:none; cursor:default; gap:8px;';

      var kopeLab = document.createElement('span');
      kopeLab.textContent = (s.i18n && window._i) ? window._i(s.i18n, s.label) : (s.label || '');
      kopeLab.style.cssText = 'flex:0 0 auto; font-weight:600;';
      kopeRow.appendChild(kopeLab);

      // 启动 / 停止按钮
      var kopeBtn = document.createElement('button');
      kopeBtn.style.cssText =
        'padding:2px 10px; border:1px solid var(--border-color); border-radius:3px; ' +
        'background:var(--card-bg); color:var(--text-primary); font-size:11px; cursor:default; ' +
        'min-width:56px;';

      function _refreshKopeBtn() {
        var br = window.qqqideBridge;
        if (br && br.kopeA) {
          br.kopeA.status().then(function (st) {
            if (st && st.running) {
              kopeBtn.textContent = '停止';
              kopeBtn.style.background = 'var(--primary-color)';
              kopeBtn.style.color = '#1e1e1e';
            } else {
              kopeBtn.textContent = '启动';
              kopeBtn.style.background = 'var(--card-bg)';
              kopeBtn.style.color = 'var(--text-primary)';
            }
          }).catch(function () {
            kopeBtn.textContent = '启动';
          });
        }
      }
      _refreshKopeBtn();

      kopeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        var br = window.qqqideBridge;
        if (!br || !br.kopeA) return;
        if (kopeBtn.textContent === '停止') {
          br.kopeA.stop().then(function () { _refreshKopeBtn(); }).catch(function () {});
        } else {
          br.kopeA.start().then(function (r) {
            if (r && r.ok) {
              _refreshKopeBtn();
            } else {
              var errMsg = (r && r.error) || '启动失败';
              if (br.dialog && br.dialog.message) {
                br.dialog.message({ type: 'info', title: 'kope-a', message: errMsg });
              } else {
                alert('kope-a: ' + errMsg);
              }
            }
          }).catch(function (e2) {
            alert('kope-a 启动失败: ' + (e2 && e2.message || e2));
          });
        }
      });
      kopeRow.appendChild(kopeBtn);

      // 自动启动勾选框
      var kopeCb = document.createElement('input');
      kopeCb.type = 'checkbox';
      kopeCb.style.cssText = 'margin:0 0 0 4px; cursor:default;';
      var _kopeCbReady = false;
      (function () {
        var br = window.qqqideBridge;
        if (br && br.kopeA) {
          br.kopeA.getAutoStart().then(function (v) {
            kopeCb.checked = !!v;
            _kopeCbReady = true;
          }).catch(function () { kopeCb.checked = false; _kopeCbReady = true; });
        }
      })();

      kopeCb.addEventListener('change', function (e) {
        e.stopPropagation();
        if (!_kopeCbReady) return;
        var br = window.qqqideBridge;
        if (br && br.kopeA) {
          br.kopeA.setAutoStart(kopeCb.checked).catch(function () {});
        }
      });
      kopeCb.addEventListener('click', function (e) { e.stopPropagation(); });

      var kopeAutoLab = document.createElement('span');
      kopeAutoLab.textContent = '自启';
      kopeAutoLab.style.cssText = 'font-size:11px; color:var(--text-muted);';

      kopeRow.appendChild(kopeCb);
      kopeRow.appendChild(kopeAutoLab);

      (function (rEl) {
        rEl.addEventListener('mouseenter', function () { rEl.style.background = 'var(--background-color)'; });
        rEl.addEventListener('mouseleave', function () { rEl.style.background = ''; });
      })(kopeRow);

      pop.appendChild(kopeRow);
      continue;
    }

    var row = document.createElement('div');
    row.style.cssText =
      'display:flex; align-items:center; padding:11px 14px; margin:0; line-height:1.3; ' +
      'font-size:13px; color:var(--text-primary); ' +
      'white-space:nowrap; user-select:none; cursor:default;';
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

    (function (rowEl) {
      rowEl.addEventListener('mouseenter', function () { rowEl.style.background = 'var(--background-color)'; });
      rowEl.addEventListener('mouseleave', function () { rowEl.style.background = ''; });
    })(row);

    // ★ "开新窗口" 行：hover → 右侧展开最近文件夹列表；点击 → 空白新窗口
    if (s.hasRecent) {
      // ★ 捕获 s.cmd 到局部变量 — 修复 var 循环变量被覆盖导致点击"开新窗口"执行 file.exit 的 bug
      var _recentCmd = s.cmd;
      row.addEventListener('mouseenter', function () {
        if (_shellMenuRecentHoverTimer) clearTimeout(_shellMenuRecentHoverTimer);
        var popRect = pop.getBoundingClientRect();
        var rowRect = row.getBoundingClientRect();
        _showMenuRecentDropdown(popRect.right, rowRect.top);
      });
      row.addEventListener('mouseleave', function () {
        if (_shellMenuRecentHoverTimer) clearTimeout(_shellMenuRecentHoverTimer);
        _shellMenuRecentHoverTimer = setTimeout(function () {
          _shellMenuRecentHoverTimer = null;
          if (_shellMenuRecentDropdown) return;
          _closeMenuRecentDropdown();
        }, 120);
      });

      // 点击行 → 空白新窗口（不传 folderPath）
      row.addEventListener('click', function (e) {
        e.stopPropagation();
        _closeMenuRecentDropdown();
        _shellCloseMenubarPopup();
        window._shHandleMenuCmd(_recentCmd);
      });
    } else {
      row.addEventListener('click', (function (cmd) {
        return function (e) {
          e.stopPropagation();
          _shellCloseMenubarPopup();
          if (cmd) window._shHandleMenuCmd(cmd);
        };
      })(s.cmd));
    }
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  _shellActiveMenubarPopup = pop;
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
  document.addEventListener('mousedown', function (e) {
    // 先检查最近文件夹下拉
    if (_shellMenuRecentDropdown) {
      if (_shellMenuRecentDropdown.contains(e.target)) return;
      _closeMenuRecentDropdown();
    }
    // 再检查菜单弹出
    if (!_shellActiveMenubarPopup) return;
    if (_shellActiveMenubarPopup.contains(e.target)) return;
    // ★ 点击 popup 的 anchor label → 让 label click handler 处理 toggle
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
