// ============================================================================
// shell-menu.js — 菜单栏（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window.qqqDefaultMenuSchema, window._i
// 导出: window._shHandleMenuCmd (供 shell-rpc.js 的 bootKeyHook 使用)
// 功能: 菜单弹出/高亮/命令分发 + "开新窗口" hover 最近文件夹下拉
//       项目资产持久化 → only.sq3 (tab-manager + shell.js 各自负责)
// ============================================================================

var _shellActiveMenubarPopup = null;
var _shellMenuRecentDropdown = null;   // "开新窗口" hover 的最近文件夹下拉
var _shellMenuRecentHoverTimer = null; // 延迟关闭计时器（1s）
var _shellMenuRecentLoading = false;   // 防并发 async 创建
var _shellGlobalMouseDownBound = false; // 全局 mousedown 只注册一次

// ★ 开新窗口 hover 下拉的关闭延迟（ms）— 光标离开 1s 后自动消失
var RECENT_DROPDOWN_CLOSE_DELAY = 1000;

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
  _shellMenuRecentLoading = false;
}

// ★ 统一关闭计时器：光标离开下拉/开新窗口行 1s 后关闭
function _startRecentDropdownCloseTimer() {
  if (_shellMenuRecentHoverTimer) clearTimeout(_shellMenuRecentHoverTimer);
  _shellMenuRecentHoverTimer = setTimeout(function () {
    _shellMenuRecentHoverTimer = null;
    _closeMenuRecentDropdown();
  }, RECENT_DROPDOWN_CLOSE_DELAY);
}

// ---- 项目资产刷新：确保 only.sq3 同步落盘 ----
function _flushProjectAssets() {
  if (window.qqqTabs && window.qqqTabs.flushOpenTabs) window.qqqTabs.flushOpenTabs();
  if (typeof persistState === 'function') persistState();
  // recent folders → global.sq3（跨项目）
  try {
    var bridge = window.qqqideBridge;
    if (bridge && bridge.state) {
      bridge.state.get('qqqide', 'recent_folders').then(function (data) {
        var list = (data && Array.isArray(data)) ? data : [];
        if (list.length > 0) bridge.state.setNow('qqqide', 'recent_folders', list).catch(function () { });
      }).catch(function () { });
    }
  } catch (_) { }
}

// ---- hover "开新窗口" 行 → 右侧展开最近文件夹列表 ----
function _showMenuRecentDropdown(leftPx, topPx) {
  // ★ 已渲染 → 锁死，禁止重排重绘
  if (_shellMenuRecentDropdown) return;
  // ★ 正在异步加载数据 → 不重复触发
  if (_shellMenuRecentLoading) return;
  _closeMenuRecentDropdown();
  _shellMenuRecentLoading = true;

  var bridge = window.qqqideBridge;
  if (!bridge || !bridge.state) { _shellMenuRecentLoading = false; return; }

  // ★ 捕获位置参数，防止闭包引用在异步期间变化
  var capturedTop = topPx;
  var capturedLeft = leftPx;

  bridge.state.get('qqqide', 'recent_folders').then(function (data) {
    var folders = (data && Array.isArray(data)) ? data.slice(0, 20) : [];
    // 去重：同 path 只保留最靠前的一条（数据已按 atime 排序，直接去重即可）
    var seen = {};
    folders = folders.filter(function (f) {
      var p = (f.path || '').replace(/\\/g, '/').replace(/\/$/, '');
      if (seen[p]) return false;
      seen[p] = true;
      return true;
    });
    if (!folders || folders.length === 0) { _shellMenuRecentLoading = false; return; }

    var dd = document.createElement('div');
    dd.className = 'qqq-menubar-recent-dropdown';
    var maxH = Math.max(200, window.innerHeight - capturedTop - 8);
    dd.style.cssText =
      'position:fixed; z-index:100000; ' +
      'left:' + capturedLeft + 'px; top:' + capturedTop + 'px; ' +
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

    // ★ 光标离开下拉区域 → 1s 后自动关闭
    dd.addEventListener('mouseleave', function () {
      _startRecentDropdownCloseTimer();
    });
    dd.addEventListener('mouseenter', function () {
      if (_shellMenuRecentHoverTimer) { clearTimeout(_shellMenuRecentHoverTimer); _shellMenuRecentHoverTimer = null; }
    });

    document.body.appendChild(dd);
    _shellMenuRecentDropdown = dd;
    _shellMenuRecentLoading = false;
  }).catch(function () { _shellMenuRecentLoading = false; });
}

// ---- 从最近文件夹打开新窗口 ----
function _openWindowFromRecent(folderPath) {
  var bridge = window.qqqideBridge;
  _flushProjectAssets();
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

    // ★ 激活行：动态标签 + 状态检测
    if (s.hasActivation) {
      var actRow = document.createElement('div');
      actRow.style.cssText =
        'display:flex; align-items:center; padding:11px 14px; margin:0; line-height:1.3; ' +
        'font-size:13px; color:var(--text-primary); ' +
        'white-space:nowrap; user-select:none; cursor:default;';

      var actLab = document.createElement('span');
      actLab.textContent = (s.i18n && window._i) ? window._i(s.i18n, s.label) : (s.label || '');
      actLab.style.cssText = 'flex:1 1 auto;';
      actRow.appendChild(actLab);

      // 异步检测登录 + 激活状态，更新标签
      (function (labelEl) {
        var isLoggedIn = window.qqqLogin && window.qqqLogin.isLoggedIn();
        if (isLoggedIn) {
          fetch('https://direct-cn.gh555.com/api/goods/qqqide/stats').then(function (r) { return r.json(); }).then(function (d) {
            if (d && d.ok && d.total_installations > 0) {
              labelEl.textContent = (window._i && window._i('shell.menu.activated', '已激活')) || '已激活';
            }
          }).catch(function () { });
        }
      })(actLab);

      (function (rEl) {
        rEl.addEventListener('mouseenter', function () { rEl.style.background = 'var(--background-color)'; });
        rEl.addEventListener('mouseleave', function () { rEl.style.background = ''; });
      })(actRow);

      actRow.addEventListener('click', function (e) {
        e.stopPropagation();
        _shellCloseMenubarPopup();
        var bridge = window.qqqideBridge;
        var isLoggedIn = window.qqqLogin && window.qqqLogin.isLoggedIn();
        var token = window.qqqLogin && window.qqqLogin.getAuthToken();
        if (isLoggedIn && token) {
          // 已登录: 检测激活状态
          fetch('/api/goods/qqqide/stats').then(function (r) { return r.json(); }).then(function (d) {
            if (d && d.ok && d.total_installations > 0) {
              if (bridge && bridge.shell && bridge.shell.openExternal) {
                bridge.shell.openExternal('https://www.gh555.com/gaea/d/qqqide?lang=zh#profile');
              }
            } else {
              if (bridge && bridge.shell && bridge.shell.openExternal) {
                bridge.shell.openExternal('https://www.gh555.com/gaea/d/qqqide?lang=zh#price');
              }
            }
          }).catch(function () {
            if (bridge && bridge.shell && bridge.shell.openExternal) {
              bridge.shell.openExternal('https://www.gh555.com/gaea/d/qqqide?lang=zh#price');
            }
          });
        } else {
          // 未登录: 直接跳转 price
          if (bridge && bridge.shell && bridge.shell.openExternal) {
            bridge.shell.openExternal('https://www.gh555.com/gaea/d/qqqide?lang=zh#price');
          }
        }
      });
      pop.appendChild(actRow);
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
          br.kopeA.stop().then(function () { _refreshKopeBtn(); }).catch(function () { });
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
          br.kopeA.setAutoStart(kopeCb.checked).catch(function () { });
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
        _showMenuRecentDropdown(popRect.right, popRect.top);
      });
      // ★ 光标离开行 → 启动 1s 关闭计时器（进入下拉会自动清除）
      row.addEventListener('mouseleave', function () {
        _startRecentDropdownCloseTimer();
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
    _flushProjectAssets();
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
    _flushProjectAssets();
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

// ★ 在 window 上暴露给其他模块使用
window._shFlushProjectAssets = _flushProjectAssets;

// ★ 全局 mousedown：点击外部关闭 popup 和下拉（只注册一次）
function _ensureGlobalMouseDown() {
  if (_shellGlobalMouseDownBound) return;
  _shellGlobalMouseDownBound = true;
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

function _shellRenderMenubarLabels(schema) {
  var $bar = document.getElementById('qqq-menubar');
  if (!$bar || !schema) return;
  $bar.innerHTML = '';

  // ★ 确保全局 mousedown 只注册一次
  _ensureGlobalMouseDown();

  // ★ 更新菜单图标颜色（响应主题切换）
  function _updateMenuIcon() {
    var icon = document.getElementById('qqq-menu-icon');
    if (!icon) return;
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    icon.style.filter = isDark ? 'invert(1)' : 'none';
  }

  for (var i = 0; i < (schema.items || []).length; i++) {
    var item = schema.items[i];
    var span = document.createElement('span');
    span.className = 'qqq-menubar-label';

    // ★ 第一个菜单按钮：图标 + 文字
    if (i === 0 && item.label === 'qqqide') {
      var iconImg = document.createElement('img');
      iconImg.id = 'qqq-menu-icon';
      iconImg.src = 'assets/qqqide.png';
      iconImg.style.cssText = 'width:16px; height:16px; margin-right:5px; vertical-align:middle;';
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      iconImg.style.filter = isDark ? 'invert(1)' : 'none';
      span.appendChild(iconImg);

      var textNode = document.createTextNode((item.i18n && window._i) ? window._i(item.i18n, item.label) : (item.label || ''));
      span.appendChild(textNode);
    } else {
      span.textContent = (item.i18n && window._i) ? window._i(item.i18n, item.label) : (item.label || '');
    }

    span.style.cssText =
      'padding:0 10px; color:var(--text-primary); ' +
      'user-select:none; height:100%; display:inline-flex; align-items:center; ' +
      'white-space:nowrap; flex-shrink:0; ' +
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

  // ★ 监听主题切换 → 更新图标滤镜
  var _themeObs = new MutationObserver(function () { _updateMenuIcon(); });
  _themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
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
    _flushProjectAssets();
  });
}
