// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-menu.js — 菜单栏（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window.qqqDefaultMenuSchema, window._i
// 导出: window._shHandleMenuCmd (供 shell-rpc.js 的 bootKeyHook 使用)
// 功能: 菜单弹出/高亮/命令分发 + "开新窗口" hover 最近文件夹下拉
//       项目资产持久化 → only.sq3 (tab-manager + shell.js 各自负责)
// ============================================================================

var _shellActiveMenubarPopup = null;
var _shellMenubarPopupMode = null;  // null | 'click' | 'hover'
var _shellMenubarHideTimer = null;  // hover close timer
var HOVER_CLOSE_DELAY = 800;
var _shellMenuRecentDropdown = null;   // "开新窗口" hover 的最近文件夹下拉
var _shellMenuRecentHoverTimer = null; // 延迟关闭计时器（1s）
var _shellMenuRecentLoading = false;   // 防并发 async 创建
var _shellGlobalMouseDownBound = false; // 全局 mousedown 只注册一次

// ★ 导师子菜单（hover 弹出）
var _shellEvangelistSubDropdown = null;
var _shellEvangelistSubTimer = null;
var EVANGELIST_SUB_CLOSE_DELAY = 800; // 0.8s 关闭延迟

// ★ Gaea process 状态变更事件驱动（非轮询）—— 更新当前弹出菜单中的按钮
(function () {
  var br = window.qqqideBridge;
  if (br && br.gaeaProcess && br.gaeaProcess.onStatusChanged) {
    br.gaeaProcess.onStatusChanged(function (goodsId, running, pid) {
      if (!_shellActiveMenubarPopup) return;
      var btn = _shellActiveMenubarPopup.querySelector('button[data-gp-id="' + goodsId + '"]');
      if (!btn) return;
      if (running) {
        btn.textContent = '关停';
        btn.style.background = 'var(--primary-color)';
        btn.style.color = '#1e1e1e';
      } else {
        btn.textContent = '启动';
        btn.style.background = 'var(--card-bg)';
        btn.style.color = 'var(--text-primary)';
      }
    });
  }
})();

// ★ 开新窗口 hover 下拉的关闭延迟（ms）— 光标离开 1s 后自动消失
var RECENT_DROPDOWN_CLOSE_DELAY = 1000;

function _shellCloseMenubarPopup() {
  clearTimeout(_shellMenubarHideTimer);
  _shellMenubarHideTimer = null;
  _shellMenubarPopupMode = null;
  if (_shellActiveMenubarPopup) { try { _shellActiveMenubarPopup.remove(); } catch (_) { } _shellActiveMenubarPopup = null; }
  _closeMenuRecentDropdown();
  _closeEvangelistSubDropdown();
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
      if (r && !r.ok) {
        console.warn('[shell-menu] newWindow failed:', r);
        // ★ 锁拦截必须可见（F-2026-08-06）：静默失败会诱导用户手动添加错项目 → 主文件夹错乱
        if (r.locked && window.qqqideQoast) {
          window.qqqideQoast.show('⚠️ 该项目已在另一个窗口打开，请直接使用该窗口，或关闭它后再开', { duration: 6000, type: 'warn' });
        }
      }
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

      // ★ 登录 + 激活状态检测（per-user，非全局装机量）
      (function (labelEl) {
        var ql = window.qqqLogin;
        var isLoggedIn = ql && ql.isLoggedIn();
        if (!isLoggedIn) return;
        // 同步快速路径：本地缓存已有 purchased
        if (ql.isPurchased()) {
          labelEl.textContent = (window._i && window._i('shell.menu.activated', '已激活')) || '已激活';
          return;
        }
        // 异步兜底：服务端确认（窗口生命周期只查一次），查到后更新标签
        ql.checkPurchased().then(function(purchased) {
          if (purchased) {
            labelEl.textContent = (window._i && window._i('shell.menu.activated', '已激活')) || '已激活';
          }
        });
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
        if (isLoggedIn) {
          // ★ 已登录: 先服务端同步检测购买状态（窗口生命周期只查一次），再决定跳转目标
          var login = window.qqqLogin;
          login.checkPurchased().then(function(purchased) {
            if (purchased) {
              // ★ 更新标签为"已激活"（可能之前显示"激活"）
              actLab.textContent = (window._i && window._i('shell.menu.activated', '已激活')) || '已激活';
              if (bridge && bridge.shell && bridge.shell.openExternal) {
                bridge.shell.openExternal('https://www.gh555.com/gaea/d/qqqide?lang=zh#profile');
              }
            } else {
              if (bridge && bridge.shell && bridge.shell.openExternal) {
                bridge.shell.openExternal('https://www.gh555.com/gaea/d/qqqide?lang=zh#price');
              }
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

    // ★ Gaea Process 行 — 解耦设计：中间●=进程状态(可点击启停)，右边toggle=自启动开关
    if (s.hasGaeaProcess) {
      const gpId = s.hasGaeaProcess;
      const gpRow = document.createElement('div');
      gpRow.style.cssText =
        'display:flex; align-items:center; padding:8px 14px; margin:0; line-height:1.3; ' +
        'font-size:13px; color:var(--text-primary); ' +
        'white-space:nowrap; user-select:none; cursor:default; gap:8px;';

      const gpLab = document.createElement('span');
      gpLab.textContent = (s.i18n && window._i) ? window._i(s.i18n, s.label) : (s.label || gpId);
      gpLab.style.cssText = 'flex:1 1 auto; font-weight:600;';
      gpRow.appendChild(gpLab);

      // capture script/runtime/lifecycle/allowMultiple from schema item
      const gpScript = s.gpScript || '';
      const gpRuntime = s.gpRuntime || 'python';
      const gpLifecycle = s.gpLifecycle || 'attached';
      const gpAllowMultiple = s.gpAllowMultiple !== false;

      // ── 右边: 自启动 pill toggle ──
      const gpToggle = document.createElement('div');
      gpToggle.title = '自启动';
      gpToggle.style.cssText =
        'position:relative; width:44px; height:24px; border-radius:12px; ' +
        'background:var(--border-color); transition:background 200ms; ' +
        'flex-shrink:0; cursor:default;';
      const gpKnob = document.createElement('div');
      gpKnob.style.cssText =
        'position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; ' +
        'background:#fdf6e3; box-shadow:0 1px 3px rgba(0,0,0,0.25); transition:left 200ms;';
      gpToggle.appendChild(gpKnob);

      // ── 中间: 进程状态指示灯（独立按钮，可点击启停）──
      const gpDot = document.createElement('span');
      gpDot.title = '启停';
      gpDot.style.cssText =
        'width:16px; height:16px; clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%); flex-shrink:0; ' +
        'background:var(--border-color); transition:background 200ms; ' +
        'cursor:default;';

      // ★ 两套独立状态
      let _gpToggleReady = false;
      let _gpToggleOn = false;    // 自启动开关状态
      let _gpRunning = false;     // 进程实际运行状态
      let _gpDotReady = false;

      // ── UI 更新函数（解耦，互不干扰）──
      function _setGpToggleUI(on) {
        _gpToggleOn = on;
        gpToggle.style.background = on ? '#859900' : 'var(--border-color)';
        gpKnob.style.left = on ? '22px' : '2px';
      }
      // state: true=绿色运行, false=灰色停止, 'yellow'=过渡中
      function _setGpDotUI(state) {
        if (state === 'yellow') {
          gpDot.style.background = '#b58900';
        } else {
          _gpRunning = state;
          gpDot.style.background = state ? '#859900' : 'var(--border-color)';
        }
      }

      // ── 刷新自启动开关 ──
      function _refreshGpToggle() {
        var br = window.qqqideBridge;
        if (!br || !br.gaeaProcess) { _gpToggleReady = true; return; }
        br.gaeaProcess.getAutoStart(gpId).then(function (v) {
          _setGpToggleUI(!!v);
          _gpToggleReady = true;
        }).catch(function () {
          _setGpToggleUI(false);
          _gpToggleReady = true;
        });
      }

      // ── 刷新进程运行状态（poll + push 双轨）──
      function _refreshGpDot() {
        var br = window.qqqideBridge;
        if (!br || !br.gaeaProcess) { _gpDotReady = true; return; }
        br.gaeaProcess.status(gpId).then(function (r) {
          _setGpDotUI(!!(r && r.running));
          _gpDotReady = true;
        }).catch(function () {
          _gpDotReady = true;
        });
      }

      // ── 启动时加载 ──
      _refreshGpToggle();
      _refreshGpDot();

      // ★ 出厂自启动兜底：若 Toggle ON 但进程未运行 → 自动拉活
      // 初始两个请求都完成后再判定，避免竞态误判
      var _gpBootCheckAttempts = 0;
      var _gpBootCheckTimer = setInterval(function () {
        _gpBootCheckAttempts++;
        if (_gpToggleReady && _gpDotReady && _gpToggleOn && !_gpRunning) {
          clearInterval(_gpBootCheckTimer);
          var meta = { scriptPath: gpScript, runtime: gpRuntime, lifecycle: gpLifecycle, allowMultiple: gpAllowMultiple };
          var br2 = window.qqqideBridge;
          if (br2 && br2.gaeaProcess) {
            br2.gaeaProcess.setAutoStart(gpId, true, meta).then(function () {
              _refreshGpDot();
            }).catch(function () {});
          }
        } else if (_gpRunning || _gpBootCheckAttempts >= 10) {
          clearInterval(_gpBootCheckTimer);
        }
      }, 300);

      // ── 5s poll 兜底（push 事件可能漏，poll 保证最终一致）──
      var _gpPollTimer = setInterval(function () {
        _refreshGpDot();
      }, 5000);

      // ── push 事件驱动：进程状态变更立即更新 ● ──
      var _gpStatusUnsub = null;
      (function () {
        var br = window.qqqideBridge;
        if (br && br.gaeaProcess && br.gaeaProcess.onStatusChanged) {
          _gpStatusUnsub = br.gaeaProcess.onStatusChanged(function (goodsId, running, pid) {
            if (goodsId === gpId) _setGpDotUI(!!running);
          });
        }
      })();

      // ── 右边 toggle 点击：纯自启动开关，不影响进程 ──
      gpToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (!_gpToggleReady) return;
        var br = window.qqqideBridge;
        if (!br || !br.gaeaProcess) return;

        var newOn = !_gpToggleOn;
        var meta = { scriptPath: gpScript, runtime: gpRuntime, lifecycle: gpLifecycle, allowMultiple: gpAllowMultiple };

        _setGpToggleUI(newOn);
        _gpToggleReady = false;

        // 超时兜底：10s 后强制恢复，防止 IPC 挂死导致 toggle 不可点
        var _toggleTimeout = setTimeout(function () {
          _gpToggleReady = true;
          _refreshGpToggle();
        }, 10000);

        br.gaeaProcess.setAutoStart(gpId, newOn, meta).then(function () {
          clearTimeout(_toggleTimeout);
          _gpToggleReady = true;
          br.gaeaProcess.getAutoStart(gpId).then(function (v) {
            _setGpToggleUI(!!v);
          }).catch(function () {});
          // toggle ON → 主进程启动+watchdog → poll/push 更新 ●
          // toggle OFF → 主进程停watchdog → 进程继续跑，● 不变
        }).catch(function () {
          clearTimeout(_toggleTimeout);
          _setGpToggleUI(!newOn);
          _gpToggleReady = true;
        });
      });

      // ── 中间 ● 点击：纯进程启停，不自作聪明联动 toggle ──
      gpDot.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (!_gpDotReady) return;
        var br = window.qqqideBridge;
        if (!br || !br.gaeaProcess) return;

        _gpDotReady = false;

        if (_gpRunning) {
          // ── 运行中 → 停止：立即变黄 → IPC → 刷新真实状态 ──
          _setGpDotUI('yellow');
          var _stopTimeout = setTimeout(function () {
            _gpDotReady = true;
            _refreshGpDot();
          }, 10000);

          br.gaeaProcess.stop(gpId).then(function () {
            clearTimeout(_stopTimeout);
            _refreshGpDot();
            _gpDotReady = true;
            // 若自启动开着 → watchdog ≤5s 自动拉回 → push/poll 更新 ● 为绿
          }).catch(function () {
            clearTimeout(_stopTimeout);
            _refreshGpDot();
            _gpDotReady = true;
          });
        } else {
          // ── 已停止 → 启动：立即变黄 → IPC → 刷新真实状态 ──
          _setGpDotUI('yellow');
          var _startTimeout = setTimeout(function () {
            _gpDotReady = true;
            _refreshGpDot();
          }, 10000);

          br.gaeaProcess.start(gpId, gpScript, gpRuntime, gpLifecycle, gpAllowMultiple).then(function () {
            clearTimeout(_startTimeout);
            _refreshGpDot();
            _gpDotReady = true;
          }).catch(function () {
            clearTimeout(_startTimeout);
            _refreshGpDot();
            _gpDotReady = true;
          });
        }
      });

      // ── popup 关闭时清理 poll timer ──
      (function (timer, unsub) {
        var origClose = _shellCloseMenubarPopup;
        var _wrapped = false;
        // 用 MutationObserver 监听 popup 是否被移除
        var obs = new MutationObserver(function () {
          if (!document.body.contains(gpRow)) {
            if (timer) clearInterval(timer);
            if (unsub && typeof unsub === 'function') unsub();
            obs.disconnect();
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
      })(_gpPollTimer, _gpStatusUnsub);

      gpRow.appendChild(gpDot);
      gpRow.appendChild(gpToggle);
      
      (function (rEl) {
        rEl.addEventListener('mouseenter', function () { rEl.style.background = 'var(--background-color)'; });
        rEl.addEventListener('mouseleave', function () { rEl.style.background = ''; });
        rEl.addEventListener('click', function () { _showGoodsSettings(gpId); });
      })(gpRow);

      pop.appendChild(gpRow);
      continue;
    }

    // ★ 导师行：hover 右侧弹出子菜单（我滴导师 / 我滴学生）
    if (s.cmd === 'evangelist.designate') {
      var evRow = document.createElement('div');
      evRow.style.cssText =
        'display:flex; align-items:center; padding:11px 14px; margin:0; line-height:1.3; ' +
        'font-size:13px; color:var(--text-primary); ' +
        'white-space:nowrap; user-select:none; cursor:default;';

      var evLab = document.createElement('span');
      evLab.style.cssText = 'flex:1 1 auto;';
      evLab.className = 'qqq-evangelist-menu-label';
      evLab.textContent = (s.i18n && window._i) ? window._i(s.i18n, s.label) : (s.label || '');
      evRow.appendChild(evLab);

      // 无箭头 — 跟开新窗口一样 hover 弹出，无需视觉指示

      (function (rEl) {
        rEl.addEventListener('mouseenter', function () {
          rEl.style.background = 'var(--background-color)';
          if (_shellEvangelistSubTimer) clearTimeout(_shellEvangelistSubTimer);
          var popRect = pop.getBoundingClientRect();
          _showEvangelistSubDropdown(popRect.right, rEl.getBoundingClientRect().top);
          // ★ hover 触发刷新导师信息 + 学生数
          _fetchEvangelistMentor();
        });
        rEl.addEventListener('mouseleave', function () {
          rEl.style.background = '';
          _startEvangelistSubDropdownCloseTimer();
        });
      })(evRow);

      evRow.addEventListener('click', function (e) {
        e.stopPropagation();
        _shellCloseMenubarPopup();
        _closeEvangelistSubDropdown();
        window._shHandleMenuCmd('evangelist.designate');
      });

      pop.appendChild(evRow);
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

  // ★ hover 模式：光标进出 popup 控制自动隐藏
  pop.addEventListener('mouseenter', function () {
    clearTimeout(_shellMenubarHideTimer);
  });
  pop.addEventListener('mouseleave', function () {
    if (_shellMenubarPopupMode === 'hover') {
      _shellMenubarHideTimer = setTimeout(_shellCloseMenubarPopup, HOVER_CLOSE_DELAY);
    }
  });
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
  if (cmd === 'evangelist.designate') {
    // ★ 指定导师：需登录，如果已有导师则显示导师信息，否则弹出键入框
    var login = window.qqqLogin;
    if (!login || !login.isLoggedIn()) {
      if (login && login.login) { login.login(); }
      if (window.qqqideQoast) window.qqqideQoast.show('请先登录后再指定导师', { type: 'warning', duration: 5000 });
      return;
    }
    var mentorPhone = window._evangelistMentorPhone;
    if (mentorPhone && mentorPhone.length > 0) {
      if (window.qqqideQoast) window.qqqideQoast.show('你滴导师是 ' + mentorPhone, { type: 'info', duration: 6000 });
      return;
    }
    _showEvangelistDesignatePopup();
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

// ★ 指定导师弹窗
function _showEvangelistDesignatePopup() {
  // 关闭已有弹窗
  var ex = document.querySelector('.qqq-evangelist-overlay');
  if (ex) ex.remove();

  var overlay = document.createElement('div');
  overlay.className = 'qqq-evangelist-overlay';
  overlay.style.cssText = 'position:fixed;z-index:999999;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.25);padding:24px;min-width:360px;max-width:440px;';

  var title = document.createElement('h3');
  title.textContent = '指定导师';
  title.style.cssText = 'margin:0 0 8px;font-size:16px;color:var(--text-primary);';
  box.appendChild(title);

  var desc = document.createElement('p');
  desc.textContent = '键入导师滴完整手机号（如 8618283073262）';
  desc.style.cssText = 'margin:0 0 16px;font-size:13px;color:var(--text-muted);';
  box.appendChild(desc);

  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '8618283073262';
  input.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;border:1px solid var(--border-color);border-radius:4px;background:var(--background-color);color:var(--text-primary);outline:none;margin-bottom:16px;';
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') _doEvangelistSubmit(); });
  box.appendChild(input);

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

  var cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'padding:8px 20px;border:1px solid var(--border-color);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:13px;';
  cancelBtn.addEventListener('click', function () { overlay.remove(); });
  btnRow.appendChild(cancelBtn);

  var submitBtn = document.createElement('button');
  submitBtn.textContent = '确定';
  submitBtn.style.cssText = 'padding:8px 24px;border:none;border-radius:4px;background:#b58900;color:#fff;cursor:pointer;font-size:13px;font-weight:bold;';
  btnRow.appendChild(submitBtn);

  function _doEvangelistSubmit() {
    var phone = input.value.trim();
    if (!phone) { if (window.qqqideQoast) window.qqqideQoast.show('请键入导师手机号', { type: 'warning', duration: 3000 }); return; }
    if (!/^[0-9]{10,15}$/.test(phone)) { if (window.qqqideQoast) window.qqqideQoast.show('手机号格式不对，请键入纯数字（如 8618283073262）', { type: 'warning', duration: 4000 }); return; }

    // ★ 二次确认弹窗（终身一次绑定）
    _showEvangelistConfirmPopup(phone, overlay);
  }

  submitBtn.addEventListener('click', _doEvangelistSubmit);
  box.appendChild(btnRow);

  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(function () { input.focus(); }, 100);
}

// ★ 二次确认弹窗（终身绑定提醒）
function _showEvangelistConfirmPopup(phone, parentOverlay) {
  var cfOverlay = document.createElement('div');
  cfOverlay.className = 'qqq-evangelist-confirm-overlay';
  cfOverlay.style.cssText = 'position:fixed;z-index:9999999;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;';

  var cfBox = document.createElement('div');
  cfBox.style.cssText = 'background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.35);padding:28px;min-width:340px;max-width:400px;text-align:center;';

  var cfTitle = document.createElement('h3');
  cfTitle.textContent = '确认绑定导师';
  cfTitle.style.cssText = 'margin:0 0 16px;font-size:17px;color:var(--text-primary);';
  cfBox.appendChild(cfTitle);

  var cfWarn = document.createElement('p');
  cfWarn.textContent = '终身只能绑定一次、请确认无误';
  cfWarn.style.cssText = 'margin:0 0 6px;font-size:14px;color:#e67e22;font-weight:700;';
  cfBox.appendChild(cfWarn);

  var cfPhone = document.createElement('p');
  cfPhone.textContent = '导师手机号：' + phone;
  cfPhone.style.cssText = 'margin:0 0 20px;font-size:13px;color:var(--text-secondary);';
  cfBox.appendChild(cfPhone);

  var cfBtnRow = document.createElement('div');
  cfBtnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;';

  var cfCancel = document.createElement('button');
  cfCancel.textContent = '取消';
  cfCancel.style.cssText = 'padding:9px 24px;border:1px solid var(--border-color);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:14px;';
  cfCancel.addEventListener('click', function () { cfOverlay.remove(); });
  cfBtnRow.appendChild(cfCancel);

  var cfConfirm = document.createElement('button');
  cfConfirm.textContent = '确认绑定';
  cfConfirm.style.cssText = 'padding:9px 28px;border:none;border-radius:4px;background:#e67e22;color:#fff;cursor:pointer;font-size:14px;font-weight:700;';
  cfConfirm.addEventListener('click', function () {
    cfConfirm.disabled = true;
    cfConfirm.textContent = '提交中...';
    var login = window.qqqLogin;
    var token = login ? login.getAuthToken() : '';
    fetch('https://www.gh555.com/api/evangelist/designate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ mentor_phone: phone })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        window._evangelistMentorPhone = phone;
        // ★ 立即刷新菜单标签 + 子菜单
        _refreshEvangelistMenuLabel();
        _refreshEvangelistSubDropdown();
        if (window.qqqideQoast) window.qqqideQoast.show('导师指定成功！', { type: 'success', duration: 5000 });
        cfOverlay.remove();
        if (parentOverlay) parentOverlay.remove();
      } else {
        var msg = d.msg || d.code || '指定失败';
        if (window.qqqideQoast) window.qqqideQoast.show(msg, { type: 'error', duration: 6000 });
        cfConfirm.disabled = false;
        cfConfirm.textContent = '确认绑定';
      }
    }).catch(function () {
      if (window.qqqideQoast) window.qqqideQoast.show('网络错误，请重试', { type: 'error', duration: 5000 });
      cfConfirm.disabled = false;
      cfConfirm.textContent = '确认绑定';
    });
  });
  cfBtnRow.appendChild(cfConfirm);

  cfBox.appendChild(cfBtnRow);
  cfOverlay.addEventListener('mousedown', function (e) { if (e.target === cfOverlay) cfOverlay.remove(); });
  cfOverlay.appendChild(cfBox);
  document.body.appendChild(cfOverlay);
}

// ★ 全局 mousedown：点击外部关闭 popup 和下拉（只注册一次）
function _ensureGlobalMouseDown() {
  if (_shellGlobalMouseDownBound) return;
  _shellGlobalMouseDownBound = true;
  // ★ capture 阶段：比 bubble 更早拦截，防 stopPropagation 阻断
  document.addEventListener('mousedown', function (e) {
    // 先检查导师子菜单
    if (_shellEvangelistSubDropdown) {
      if (_shellEvangelistSubDropdown.contains(e.target)) return;
      _closeEvangelistSubDropdown();
    }
    // 检查最近文件夹下拉
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
  }, true);
  // ★ 点击 iframe 内区域 → 父窗口失焦 → 自动关闭菜单（iframe 内 mousedown 不冒泡到父 document）
  window.addEventListener('blur', function () {
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

    // ★ 的梦gaea：hover 弹出 goods 下拉（0.8s 延迟隐藏），单击切换弹出/收起，长按 800ms 打开外部浏览器
    if (item.label === '的梦gaea') {
      (function (anchorSpan, menuItem) {
        var _gaeaPressTimer = null;   // 长按计时器
        var _gaeaLongPressed = false; // 长按已触发标志（防 mouseup 误触发单击）

        function _gaeaOpenExternal() {
          var url = 'https://www.gh555.com/gaea?lang=zh';
          if (window.qqqideBridge && window.qqqideBridge.shell && window.qqqideBridge.shell.openExternal) {
            window.qqqideBridge.shell.openExternal(url);
          } else {
            window.open(url, '_blank');
          }
        }

        // 单击 → 切换弹出/收起面板（click 模式，固定不自动隐藏）
        function _gaeaTogglePopup() {
          if (_shellActiveMenubarPopup && _shellActiveMenubarPopup._anchor === anchorSpan) {
            _shellCloseMenubarPopup();
          } else {
            _shellOpenMenubarPopup(anchorSpan, menuItem);
            if (_shellActiveMenubarPopup) {
              _shellActiveMenubarPopup._anchor = anchorSpan;
              _shellMenubarPopupMode = 'click';
            }
          }
        }

        anchorSpan.addEventListener('mousedown', function () {
          _gaeaLongPressed = false;
          _gaeaPressTimer = setTimeout(function () {
            _gaeaLongPressed = true;
            _gaeaPressTimer = null;
            _gaeaOpenExternal();
          }, 800);
        });
        anchorSpan.addEventListener('mouseup', function () {
          if (_gaeaPressTimer) {
            clearTimeout(_gaeaPressTimer);
            _gaeaPressTimer = null;
            _gaeaTogglePopup();
          }
        });
        // 长按后松手冒出的 click：吞掉，不执行任何动作
        anchorSpan.addEventListener('click', function (e) {
          e.stopPropagation();
          if (_gaeaLongPressed) _gaeaLongPressed = false;
        });
        // hover → 弹出 goods 列表
        anchorSpan.addEventListener('mouseenter', function () {
          clearTimeout(_shellMenubarHideTimer);
          if (_shellActiveMenubarPopup && _shellActiveMenubarPopup._anchor === anchorSpan) return;
          if (_shellActiveMenubarPopup) _shellCloseMenubarPopup();
          _shellOpenMenubarPopup(anchorSpan, menuItem);
          if (_shellActiveMenubarPopup) {
            _shellActiveMenubarPopup._anchor = anchorSpan;
            _shellMenubarPopupMode = 'hover';
          }
        });
        // 光标离开标签 → 清除长按计时器 + hover 模式 0.8s 延迟隐藏
        anchorSpan.addEventListener('mouseleave', function () {
          if (_gaeaPressTimer) {
            clearTimeout(_gaeaPressTimer);
            _gaeaPressTimer = null;
          }
          if (_shellMenubarPopupMode === 'hover') {
            _shellMenubarHideTimer = setTimeout(_shellCloseMenubarPopup, HOVER_CLOSE_DELAY);
          }
        });
      })(span, item);
    } else {
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
    }
    $bar.appendChild(span);
  }

  // ★ 监听主题切换 → 更新图标滤镜
  var _themeObs = new MutationObserver(function () { _updateMenuIcon(); });
  _themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ★ 导师子菜单：hover 弹出于主菜单右侧
function _showEvangelistSubDropdown(left, top) {
  _closeEvangelistSubDropdown();
  var dd = document.createElement('div');
  dd.className = 'qqq-evangelist-sub';
  dd.style.cssText =
    'position:fixed; z-index:9999999; left:' + Math.round(left) + 'px; top:' + Math.round(top) + 'px; ' +
    'background:var(--card-bg); border:1px solid var(--border-color); border-radius:6px; ' +
    'box-shadow:0 6px 24px rgba(0,0,0,0.25); min-width:200px; padding:4px 0;';

  var mentorPhone = window._evangelistMentorPhone || '';
  var studentCount = window._evangelistStudentCount || 0;
  var mentorStudentCount = window._evangelistMentorStudentCount || 0;

  // 行1：我滴导师：xx (N) — 点击跳转导师风采页
  var r1 = document.createElement('div');
  r1.className = 'qqq-ev-sub-line';
  r1.style.cssText =
    'padding:9px 16px; font-size:13px; color:var(--text-primary); white-space:nowrap; ' +
    'cursor:' + (mentorPhone ? 'pointer' : 'pointer') + ';';
  r1.textContent = '我滴导师：' + (mentorPhone || '无') +
    (mentorPhone && mentorStudentCount > 0 ? ' (' + mentorStudentCount + ')' : '');
  if (!mentorPhone) {
    r1.style.color = '#b58900';
  }
  r1.addEventListener('click', function (e) {
    e.stopPropagation();
    _shellCloseMenubarPopup();
    _closeEvangelistSubDropdown();
    if (mentorPhone) {
      // 有导师 → 打开导师风采展示页
      var url = 'https://www.gh555.com/gaea/d/qqqide?lang=zh#evangelist&mentor=' + mentorPhone;
      if (window.qqqideBridge && window.qqqideBridge.shell && window.qqqideBridge.shell.openExternal) {
        window.qqqideBridge.shell.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    } else {
      // 无导师 → 指定导师
      window._shHandleMenuCmd('evangelist.designate');
    }
  });
  (function (el) {
    el.addEventListener('mouseenter', function () { el.style.background = 'var(--background-color)'; });
    el.addEventListener('mouseleave', function () { el.style.background = ''; });
  })(r1);
  dd.appendChild(r1);

  // 分隔线
  var sep = document.createElement('div');
  sep.style.cssText = 'margin:4px 0; border-top:1px solid var(--border-color);';
  dd.appendChild(sep);

  // 行2：我滴学生 — 点击打开认领学生弹窗
  var r2 = document.createElement('div');
  r2.className = 'qqq-ev-sub-line';
  r2.style.cssText =
    'padding:9px 16px; font-size:13px; color:var(--text-secondary); white-space:nowrap; ' +
    'cursor:pointer;';
  r2.textContent = '我滴学生：' + studentCount + '人';
  r2.addEventListener('click', function (e) {
    e.stopPropagation();
    _shellCloseMenubarPopup();
    _closeEvangelistSubDropdown();
    _showEvangelistClaimPopup();
  });
  (function (el) {
    el.addEventListener('mouseenter', function () { el.style.background = 'var(--background-color)'; });
    el.addEventListener('mouseleave', function () { el.style.background = ''; });
  })(r2);
  dd.appendChild(r2);

  dd.addEventListener('mouseenter', function () {
    if (_shellEvangelistSubTimer) { clearTimeout(_shellEvangelistSubTimer); _shellEvangelistSubTimer = null; }
  });
  dd.addEventListener('mouseleave', function () {
    _startEvangelistSubDropdownCloseTimer();
  });

  document.body.appendChild(dd);
  _shellEvangelistSubDropdown = dd;
}

function _startEvangelistSubDropdownCloseTimer() {
  if (_shellEvangelistSubTimer) clearTimeout(_shellEvangelistSubTimer);
  _shellEvangelistSubTimer = setTimeout(function () {
    _closeEvangelistSubDropdown();
  }, EVANGELIST_SUB_CLOSE_DELAY);
}

function _closeEvangelistSubDropdown() {
  if (_shellEvangelistSubDropdown) {
    try { _shellEvangelistSubDropdown.remove(); } catch (_) { }
    _shellEvangelistSubDropdown = null;
  }
  if (_shellEvangelistSubTimer) { clearTimeout(_shellEvangelistSubTimer); _shellEvangelistSubTimer = null; }
}

// ★ 认领学生弹窗（客户端内，等同于网站端「➕ 认领学生」）
function _showEvangelistClaimPopup() {
  var login = window.qqqLogin;
  if (!login || !login.isLoggedIn()) {
    if (login && login.login) { login.login(); }
    if (window.qqqideQoast) window.qqqideQoast.show('请先登录后再认领学生', { type: 'warning', duration: 5000 });
    return;
  }
  var ex = document.querySelector('.qqq-evangelist-claim-overlay');
  if (ex) ex.remove();

  var overlay = document.createElement('div');
  overlay.className = 'qqq-evangelist-claim-overlay';
  overlay.style.cssText = 'position:fixed;z-index:999999;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.25);padding:24px;min-width:360px;max-width:440px;';

  var title = document.createElement('h3');
  title.textContent = '➕ 认领学生';
  title.style.cssText = 'margin:0 0 4px;font-size:16px;color:var(--text-primary);';
  box.appendChild(title);

  var hint = document.createElement('p');
  hint.textContent = '填学生手机号和载入日期，只能试一次。';
  hint.style.cssText = 'margin:0 0 16px;font-size:12px;color:var(--text-muted);';
  box.appendChild(hint);

  var lbl1 = document.createElement('label');
  lbl1.textContent = '学生完整手机号';
  lbl1.style.cssText = 'display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);';
  box.appendChild(lbl1);

  var inputPhone = document.createElement('input');
  inputPhone.type = 'text';
  inputPhone.placeholder = '例如：8615812345678';
  inputPhone.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;border:1px solid var(--border-color);border-radius:4px;background:var(--background-color);color:var(--text-primary);outline:none;margin-bottom:14px;';
  box.appendChild(inputPhone);

  var lbl2 = document.createElement('label');
  lbl2.textContent = '学生载入日期';
  lbl2.style.cssText = 'display:block;margin-bottom:4px;font-size:13px;color:var(--text-secondary);';
  box.appendChild(lbl2);

  var inputDate = document.createElement('input');
  inputDate.type = 'date';
  inputDate.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;border:1px solid var(--border-color);border-radius:4px;background:var(--background-color);color:var(--text-primary);outline:none;margin-bottom:20px;';
  box.appendChild(inputDate);

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

  var cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'padding:8px 20px;border:1px solid var(--border-color);border-radius:4px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:13px;';
  cancelBtn.addEventListener('click', function () { overlay.remove(); });
  btnRow.appendChild(cancelBtn);

  var submitBtn = document.createElement('button');
  submitBtn.textContent = '确认认领';
  submitBtn.style.cssText = 'padding:8px 24px;border:none;border-radius:4px;background:#d4a04a;color:#fff;cursor:pointer;font-size:13px;font-weight:700;';
  btnRow.appendChild(submitBtn);

  function _doClaimSubmit() {
    var phone = inputPhone.value.trim();
    var dateVal = inputDate.value;
    if (!phone) { if (window.qqqideQoast) window.qqqideQoast.show('请键入学生手机号', { type: 'warning', duration: 3000 }); return; }
    if (!/^[0-9]{10,15}$/.test(phone)) { if (window.qqqideQoast) window.qqqideQoast.show('手机号格式不对', { type: 'warning', duration: 4000 }); return; }
    if (!dateVal) { if (window.qqqideQoast) window.qqqideQoast.show('请选择载入日期', { type: 'warning', duration: 3000 }); return; }
    var loginDate = dateVal.replace(/-/g, '');

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中...';
    var token = login.getAuthToken();
    fetch('https://www.gh555.com/api/evangelist/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ student_phone: phone, login_date: loginDate })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        if (window.qqqideQoast) window.qqqideQoast.show('认领成功！', { type: 'success', duration: 5000 });
        overlay.remove();
        _fetchEvangelistMentor();
      } else {
        var msg = d.msg || d.code || '认领失败';
        if (window.qqqideQoast) window.qqqideQoast.show(msg, { type: 'error', duration: 6000 });
        submitBtn.disabled = false;
        submitBtn.textContent = '确认认领';
      }
    }).catch(function () {
      if (window.qqqideQoast) window.qqqideQoast.show('网络错误，请重试', { type: 'error', duration: 5000 });
      submitBtn.disabled = false;
      submitBtn.textContent = '确认认领';
    });
  }

  submitBtn.addEventListener('click', _doClaimSubmit);
  inputPhone.addEventListener('keydown', function (e) { if (e.key === 'Enter') _doClaimSubmit(); });
  box.appendChild(btnRow);

  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  setTimeout(function () { inputPhone.focus(); }, 100);
}

// ★ 拉取当前用户滴导师信息 + 学生数（返回 Promise，完成后自动刷新 UI）
// ★ 缓存到 global.sq3，重启兜底。学生数只增不减（monotonic）
function _fetchEvangelistMentor() {
  var login = window.qqqLogin;
  if (!login || !login.isLoggedIn()) {
    // 未登录：不清空缓存值（可能是临时断线），仅刷新 UI
    _refreshEvangelistSubDropdown();
    _refreshEvangelistMenuLabel();
    return Promise.resolve();
  }
  var token = login.getAuthToken();
  if (!token) {
    _refreshEvangelistSubDropdown();
    _refreshEvangelistMenuLabel();
    return Promise.resolve();
  }
  // ★ 先从缓存读旧值作为兜底
  var prevSC = window._evangelistStudentCount || 0;
  var prevMSC = window._evangelistMentorStudentCount || 0;
  try {
    var cacheStore = window.qgs && window.qgs('qqqide.evangelist');
    if (cacheStore) {
      var csc = cacheStore.get('studentCount');
      var cmsc = cacheStore.get('mentorStudentCount');
      if (typeof csc === 'number' && csc > prevSC) prevSC = csc;
      if (typeof cmsc === 'number' && cmsc > prevMSC) prevMSC = cmsc;
    }
  } catch (_) { }

  return fetch('https://www.gh555.com/api/evangelist/my-mentor', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.ok) {
      var mentorPhone = d.has_mentor ? (d.mentor_phone || '') : '';
      var studentCount = d.student_count || 0;
      var mentorStudentCount = d.mentor_student_count || 0;

      // ★ 单调递增：学生数只增不减，防止 API 临时故障返回 0 覆盖真实值
      if (studentCount < prevSC) studentCount = prevSC;
      if (mentorStudentCount < prevMSC) mentorStudentCount = prevMSC;

      window._evangelistMentorPhone = mentorPhone;
      window._evangelistStudentCount = studentCount;
      window._evangelistMentorStudentCount = mentorStudentCount;

      // ★ 缓存到 global.sq3 兜底
      try {
        var store = window.qgs && window.qgs('qqqide.evangelist');
        if (store) {
          store.set('mentorPhone', mentorPhone);
          store.set('studentCount', studentCount);
          store.set('mentorStudentCount', mentorStudentCount);
          store.set('cachedAt', Date.now());
        }
      } catch (_) { }
    }
    // API 返回 !ok → 保持旧值不变，不清零
    _refreshEvangelistSubDropdown();
    _refreshEvangelistMenuLabel();
  }).catch(function () {
    // 网络失败保持旧值，不覆盖
  });
}

// ★ 从 global.sq3 缓存恢复（启动时兜底）
function _loadEvangelistCache() {
  try {
    var store = window.qgs && window.qgs('qqqide.evangelist');
    if (!store) return;
    var mp = store.get('mentorPhone');
    var sc = store.get('studentCount');
    var msc = store.get('mentorStudentCount');
    if (typeof mp === 'string') window._evangelistMentorPhone = mp;
    if (typeof sc === 'number') window._evangelistStudentCount = sc;
    if (typeof msc === 'number') window._evangelistMentorStudentCount = msc;
  } catch (_) { }
}

// ★ 更新菜单中"导师"标签（指定/登录/fetch 后调用）
function _refreshEvangelistMenuLabel() {
  var lab = document.querySelector('.qqq-evangelist-menu-label');
  if (!lab) return;
  var mentorPhone = window._evangelistMentorPhone;
  if (mentorPhone && mentorPhone.length > 0) {
    lab.textContent = '导师：' + mentorPhone;
  } else {
    lab.textContent = (window._i) ? window._i('shell.menu.evangelist', '导师') : '导师';
  }
}
window._refreshEvangelistMenuLabel = _refreshEvangelistMenuLabel;

// ★ 刷新导师子菜单内容（fetch 完成后调用，仅当子菜单可见时）
function _refreshEvangelistSubDropdown() {
  var dd = _shellEvangelistSubDropdown;
  if (!dd) return;
  var mentorPhone = window._evangelistMentorPhone || '';
  var studentCount = window._evangelistStudentCount || 0;
  var mentorStudentCount = window._evangelistMentorStudentCount || 0;
  var lines = dd.querySelectorAll('.qqq-ev-sub-line');
  if (lines.length >= 2) {
    lines[0].textContent = '我滴导师：' + (mentorPhone || '无') +
      (mentorPhone && mentorStudentCount > 0 ? ' (' + mentorStudentCount + ')' : '');
    if (!mentorPhone) {
      lines[0].style.color = '#b58900';
      lines[0].style.cursor = 'pointer';
    } else {
      lines[0].style.color = 'var(--text-primary)';
      lines[0].style.cursor = 'pointer';
    }
    lines[1].textContent = '我滴学生：' + studentCount + '人';
  }
}

// ═══════════════════════════════════════════════════════════════
// Goods 设置弹出窗口
// ═══════════════════════════════════════════════════════════════

var _goodsSettingsModal = null;

function _closeGoodsSettings() {
  if (_goodsSettingsModal) {
    try { _goodsSettingsModal.remove(); } catch (_) { }
    _goodsSettingsModal = null;
  }
}

function _showGoodsSettings(goodsId) {
  _closeGoodsSettings();

  var bridge = window.qqqideBridge;

  var overlay = document.createElement('div');
  overlay.className = 'qqq-goods-settings-overlay';
  overlay.style.cssText =
    'position:fixed; z-index:200000; inset:0; ' +
    'background:rgba(0,0,0,0.35); ' +
    'display:flex; align-items:center; justify-content:center;';

  var modal = document.createElement('div');
  modal.className = 'qqq-goods-settings-modal';
  modal.style.cssText =
    'background:var(--card-bg); border:1px solid var(--border-color); ' +
    'border-radius:8px; padding:24px 28px; min-width:360px; max-width:480px; ' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.28); ' +
    'color:var(--text-primary); font-size:13px; line-height:1.6;';

  // ── 标题行 ──
  var titleRow = document.createElement('div');
  titleRow.style.cssText =
    'display:flex; align-items:center; margin-bottom:16px; gap:8px;';

  var titleText = document.createElement('span');
  titleText.textContent = (goodsId === 'kope-a') ? 'kope-a 设置' : 'window there 设置';
  titleText.style.cssText = 'font-weight:700; font-size:15px; flex:1;';
  titleRow.appendChild(titleText);

  var closeBtn = document.createElement('span');
  closeBtn.textContent = '\u2715';  // ✕
  closeBtn.style.cssText =
    'cursor:default; font-size:16px; color:var(--text-muted); opacity:0.6; ' +
    'padding:2px 6px; border-radius:3px;';
  closeBtn.addEventListener('mouseenter', function () { closeBtn.style.opacity = '1'; closeBtn.style.background = 'var(--background-color)'; });
  closeBtn.addEventListener('mouseleave', function () { closeBtn.style.opacity = '0.6'; closeBtn.style.background = ''; });
  closeBtn.addEventListener('click', function (e) { e.stopPropagation(); _closeGoodsSettings(); });
  titleRow.appendChild(closeBtn);
  modal.appendChild(titleRow);

  // ── 介绍文字 ──
  var intro = document.createElement('div');
  intro.style.cssText =
    'color:var(--text-muted); font-size:12px; line-height:1.6; margin-bottom:20px; ' +
    'padding:12px; background:var(--background-color); border-radius:6px;';
  if (goodsId === 'kope-a') {
    intro.textContent = '用右下角滴卡片，或者一个音效提示你已经复制成功，点击右下角卡片滴下半区域可以让该卡片进入或退出编辑模式。';
  } else {
    intro.textContent = '记录和还原窗口滴位置和尺寸。记录：1、确保当前要记录滴那个窗口在屏幕上显示但没有获得焦点，简单讲就是不要让要记录滴窗口是焦点窗口。2、光标到达该窗口范围内。3、按3下 w 键。还原：1、同样确保要还原滴那个窗口在屏幕上显示但没有获得焦点。2、同样光标进入该窗口范围。3、按3下 x 键。';
  }
  modal.appendChild(intro);

  // ── kope-a 专属设置：是否弹出卡片 ──
  if (goodsId === 'kope-a') {
    var settingRow = document.createElement('div');
    settingRow.style.cssText =
      'display:flex; align-items:center; padding:10px 0; gap:12px; ' +
      'border-top:1px solid var(--border-color);';

    var settingLabel = document.createElement('span');
    settingLabel.textContent = '启用卡片';
    settingLabel.style.cssText = 'flex:1; font-weight:600;';
    settingRow.appendChild(settingLabel);

    // ── toggle switch for showCard ──
    var cardToggle = document.createElement('div');
    cardToggle.title = '是否弹出卡片';
    cardToggle.style.cssText =
      'position:relative; width:44px; height:24px; border-radius:12px; ' +
      'background:var(--border-color); transition:background 200ms; ' +
      'flex-shrink:0; cursor:default;';
    var cardKnob = document.createElement('div');
    cardKnob.style.cssText =
      'position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; ' +
      'background:#fdf6e3; box-shadow:0 1px 3px rgba(0,0,0,0.25); transition:left 200ms;';
    cardToggle.appendChild(cardKnob);

    var _cardToggleReady = true;
    function _setCardToggleUI(on) {
      cardToggle.style.background = on ? '#859900' : 'var(--border-color)';
      cardKnob.style.left = on ? '22px' : '2px';
    }

    // 加载当前设置
    if (bridge && bridge.gaeaProcess && bridge.gaeaProcess.getSettings) {
      bridge.gaeaProcess.getSettings(goodsId).then(function (s) {
        var showCard = s && s.showCard !== undefined ? s.showCard : true;
        _setCardToggleUI(showCard);
      }).catch(function () {
        _setCardToggleUI(true);
      });
    } else {
      _setCardToggleUI(true);
    }

    cardToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!_cardToggleReady) return;
      _cardToggleReady = false;

      var currentOn = cardToggle.style.background === 'rgb(133, 153, 0)' || cardToggle.style.background === '#859900';
      var newOn = !currentOn;
      _setCardToggleUI(newOn);

      if (bridge && bridge.gaeaProcess && bridge.gaeaProcess.setSetting) {
        bridge.gaeaProcess.setSetting(goodsId, 'showCard', newOn).then(function () {
          _cardToggleReady = true;
        }).catch(function () {
          _setCardToggleUI(!newOn);
          _cardToggleReady = true;
        });
      } else {
        _cardToggleReady = true;
      }
    });

    settingRow.appendChild(cardToggle);
    modal.appendChild(settingRow);
  }

  overlay.appendChild(modal);

  // 点击背景关闭
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) _closeGoodsSettings();
  });

  // ESC 关闭
  function _onEsc(e) {
    if (e.key === 'Escape') { _closeGoodsSettings(); document.removeEventListener('keydown', _onEsc); }
  }
  document.addEventListener('keydown', _onEsc);

  document.body.appendChild(overlay);
  _goodsSettingsModal = overlay;
}

async function bootMenu() {
  var bridge = window.qqqideBridge;
  var schema = window.qqqDefaultMenuSchema;
  if (!schema) return;
  try { await bridge.menu.set(schema); } catch (e) { console.warn('[shell] menu.set failed', e); }
  _shellRenderMenubarLabels(schema);
  // ★ 先从缓存恢复（兜底），再异步拉取服务器最新数据
  _loadEvangelistCache();
  _fetchEvangelistMentor();
  window.addEventListener('qqq-lang-change', function () { _shellRenderMenubarLabels(schema); });
  bridge.menu.onFired(function (cmd) {
    window._shHandleMenuCmd(cmd);
  });

  window.addEventListener('beforeunload', function () {
    _flushProjectAssets();
  });
}
