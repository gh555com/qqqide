// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell.js — QQQ Shell v2 主引导（模块化拆分后保留核心编排逻辑）
// 拆出: shell-lang.js / shell-menu.js / shell-wings.js / shell-overlay.js
//       shell-statusbar.js / shell-rpc.js
// 加载顺序: 所有 shell-*.js 在 shell.js 之前，shell.js 最后
// ============================================================================

var _shBridge = window.qqqideBridge;
var _shMin = 123;
var _shSashW = 6;
// _shAiW = 389 定义在 shell-wings.js（先加载）

// ---- Layout state (persisted via StateStore, not localStorage) ----
var _shLayoutState = {
  aZoneW: 123,
  outputH: 200,
  outputVisible: false,
};

// ---- Layout persistence → only.sq3 (项目资产) ----
function _shFolderFromUrl() {
  var m = window.location.search.match(/[?&]folder=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]).replace(/\\/g, '/').replace(/\/$/, ''); }
    catch (_) { }
  }
  return null;
}

function _shOnlyDb() {
  var root = window._workspaceRoot || _shFolderFromUrl();
  if (!root || !window.qgs || typeof window.qgs.project !== 'function') return null;
  return window.qgs.project(root + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
}

async function loadState() {
  // ★ 真理源: only.sq3（项目资产）
  var db = _shOnlyDb();
  if (db) {
    try {
      var v = await db.get('layout');
      if (v && typeof v === 'object') {
        if (typeof v.aZoneW === 'number') _shLayoutState.aZoneW = v.aZoneW;
        if (typeof v.outputH === 'number') _shLayoutState.outputH = v.outputH;
        if (typeof v.outputVisible === 'boolean') _shLayoutState.outputVisible = v.outputVisible;
      }
    } catch (_) { }
  }
  _shLayoutState.aZoneW = Math.max(_shMin, _shLayoutState.aZoneW || 123);
  _shLayoutState.outputH = Math.max(_shMin, _shLayoutState.outputH || 200);
}

function persistState() {
  var db = _shOnlyDb();
  if (!db) return;
  try {
    db.set('layout', {
      aZoneW: _shLayoutState.aZoneW,
      outputH: _shLayoutState.outputH,
      outputVisible: _shLayoutState.outputVisible,
    }).catch(function () { });
  } catch (_) { }
}

// ★ F100 兜底直连：F2/Tab 非编辑态 → 激活 roam tab + 聚焦 iframe
// 不依赖 key-bindings.json / key-hook 配置链，独立注册 capture 监听（双保险）。
function bootRoamKeyFallback() {
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'F2' && e.key !== 'Tab' && e.key !== 'x') return;
    var el = document.activeElement;
    var tag = el && el.tagName ? el.tagName.toUpperCase() : '';
    var editing = el && (el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
    var p = el;
    while (p) {
      if (p.classList && (p.classList.contains('monaco-editor') || p.classList.contains('inputarea'))) { editing = true; break; }
      p = p.parentElement;
    }
    if (editing) return; // 编辑态不抢键
    // ★ 2026-08-18: x 键兜底直连——非编辑态打开一个新 kmd（key-hook 配置链再坏也不静默）
    if (e.key === 'x') {
      console.log('[shell] kmd-key fallback: x');
      if (window.__qqqKmdOpen) { try { window.__qqqKmdOpen(null); } catch (_ke) { } }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    console.log('[shell] roam-key fallback:', e.key);
    var grp = window.qqqTabs && window.qqqTabs.getGaeaGroup ? window.qqqTabs.getGaeaGroup() : null;
    if (grp) {
      var rt = grp.tabs.find(function (t) { return t.gaeaId === 'roam'; });
      if (rt && window.qqqTabs.activateTab) window.qqqTabs.activateTab(grp, rt.id);
    }
    var it = document.querySelector('iframe[src*="q2-roam"]');
    if (it && it.contentWindow) { try { it.contentWindow.focus(); } catch (_e) { } }
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// ---- CSS variable helpers ----
function applyLayout() {
  var aEl = document.getElementById('qqq-a-zone');
  if (aEl && !aEl.classList.contains('qqq-collapsed')) {
    aEl.style.flexBasis = _shLayoutState.aZoneW + 'px';
    aEl.style.width = _shLayoutState.aZoneW + 'px';
  }
  // ★ 同步 CSS 变量，保持唯一真理源
  document.documentElement.style.setProperty('--a-zone-w', (_shLayoutState.aZoneW || 123) + 'px');
  var oEl = document.getElementById('qqq-x-output');
  if (oEl) {
    oEl.style.flexBasis = _shLayoutState.outputH + 'px';
    oEl.style.height = _shLayoutState.outputH + 'px';
  }
}

// ---- Window resize: proportional scaling, frozen min panels stay frozen ----
var _shPrevAvailAX = 0; // available middle space for A+X (main - AI - sash), not raw winW
var _shPrevWinH = 0;

function onWindowResize() {
  var winW = window.innerWidth;
  var winH = window.innerHeight;

  var aEl = document.getElementById('qqq-a-zone');
  if (aEl && !aEl.classList.contains('qqq-collapsed')) {
    // ★ 计算 A+X 实际可用空间：必须扣掉翼板宽度（翼板在 #qqq-main 外但在 window 内）
    //    以及 AI 区实际渲染宽度（受 zoom 影响，不能用 _shAiW 常量）
    var wingW = (typeof _shellBulbState !== 'undefined' ? (_shellBulbState.left ? _shAiW : 0) + (_shellBulbState.right ? _shAiW : 0) : 0);
    var mainW = winW - wingW;
    var aiEl = document.getElementById('qqq-ai-zone');
    var aiW = aiEl ? aiEl.offsetWidth : _shAiW;
    var availAX = mainW - aiW - _shSashW;

    if (_shPrevAvailAX === 0) {
      _shPrevAvailAX = availAX;
      _shPrevWinH = winH;
      return;
    }

    if (availAX > 0 && _shPrevAvailAX > 0) {
      var oldA = _shLayoutState.aZoneW;
      if (oldA <= _shMin) {
        // frozen at min, keep at min
        _shLayoutState.aZoneW = _shMin;
      } else {
        var ratio = oldA / _shPrevAvailAX;
        _shLayoutState.aZoneW = Math.max(_shMin, Math.round(ratio * availAX));
      }
    }
    _shPrevAvailAX = availAX;
  }

  // output height proportional
  var xEl = document.getElementById('qqq-x-zone');
  if (xEl && _shLayoutState.outputVisible) {
    var oldXH = _shPrevWinH - 60 - 24; // approx menu + status
    var newXH = winH - 60 - 24;
    if (oldXH > 0 && newXH > 0) {
      var oldO = _shLayoutState.outputH;
      if (oldO <= _shMin) {
        _shLayoutState.outputH = _shMin;
      } else {
        var ratio2 = oldO / oldXH;
        _shLayoutState.outputH = Math.max(_shMin, Math.round(ratio2 * newXH));
      }
    }
  }

  _shPrevWinH = winH;
  applyLayout();
}

// ---- Window controls ----
var _closeConfirmOverlay = null;
var _closeConfirmActive = false;
var _closeConfirmUnblockAt = 0; // 1s 防抖：此时间之前不能取消/关闭遮罩

// ★ 执行关闭确认：关闭当前窗口，不影响其他窗口
function _executeCloseConfirm() {
  var bridge = _shBridge;
  // ★ 先关弹窗再关窗口，顺序不重要（destroy 是最终操作）
  hideCloseConfirm(true);
  // ★ 优先 closeConfirmed → win.destroy()（只关当前窗口）
  //   绝不 fallback 到 quitAll（那会关所有窗口）
  if (bridge.window && bridge.window.closeConfirmed) {
    try { bridge.window.closeConfirmed(); } catch (_) {
      // IPC 同步抛异常才 fallback（极少见）
      if (bridge.window.close) bridge.window.close();
    }
  } else if (bridge.window && bridge.window.close) {
    bridge.window.close();
  }
}

function showCloseConfirm() {
  if (_closeConfirmActive) return;
  _closeConfirmActive = true;
  _closeConfirmUnblockAt = Date.now() + 1000; // 1s 内只能点确认，不能取消
  var bridge = _shBridge;

  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var bg = isDark ? '#1e1e1e' : '#fdf6e3';
  var text = isDark ? '#dcd8d0' : '#656360';
  var border = isDark ? '#333333' : '#d3c6aa';
  var red = isDark ? '#ff4444' : '#dc322f';
  var muted = isDark ? '#555555' : '#bbb';

  _closeConfirmOverlay = document.createElement('div');
  _closeConfirmOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:999999;display:flex;align-items:center;justify-content:center;';
  _closeConfirmOverlay.addEventListener('click', function (e) {
    if (e.target === _closeConfirmOverlay) hideCloseConfirm();
  });

  var panel = document.createElement('div');
  panel.style.cssText = 'width:300px;max-width:90vw;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.35);padding:24px;text-align:center;background:' + bg + ';color:' + text + ';';
  panel.innerHTML =
    '<div style="font-size:16px;margin-bottom:20px;color:' + text + ';">确认退出？</div>' +
    '<div style="display:flex;gap:8px;">' +
    '<button id="qqq-exit-cancel" style="flex:1;padding:10px 0;border:1px solid ' + muted + ';border-radius:4px;background:transparent;color:' + muted + ';font-size:13px;cursor:default;">取消</button>' +
    '<button id="qqq-exit-confirm" data-no-cd style="flex:1;padding:10px 0;border:none;border-radius:4px;background:' + red + ';color:#fff;font-size:13px;font-weight:bold;">确认退出</button>' +
    '</div>';

  _closeConfirmOverlay.appendChild(panel);
  document.body.appendChild(_closeConfirmOverlay);

  var $confirm = document.getElementById('qqq-exit-confirm');
  var $cancel = document.getElementById('qqq-exit-cancel');
  if ($confirm) {
    // ★ 立即聚焦，用户可直接按回车退出（data-no-cd 绕过冷却护盾）
    $confirm.focus();
    $confirm.addEventListener('click', function () {
      _executeCloseConfirm();
    });
  }
  if ($cancel) {
    $cancel.addEventListener('click', hideCloseConfirm);
  }

  // 1s 后解封取消按钮样式
  setTimeout(function () {
    if ($cancel && _closeConfirmActive) {
      $cancel.style.color = text;
      $cancel.style.borderColor = border;
      $cancel.style.cursor = '';
    }
  }, 1000);

  // ★ 键盘：Enter=确认退出 / Escape=取消
  document.addEventListener('keydown', _onCloseConfirmKey);
}

function hideCloseConfirm(force) {
  // ★ 1s 防抖：刚弹出时不能取消（取消/Esc/遮罩点击），只能点确认
  //   force=true → 确认退出，绕过防抖，直接关闭
  if (!force && Date.now() < _closeConfirmUnblockAt) return;
  _closeConfirmActive = false;
  if (_closeConfirmOverlay) {
    _closeConfirmOverlay.remove();
    _closeConfirmOverlay = null;
  }
  document.removeEventListener('keydown', _onCloseConfirmKey);
  // ★ 通知主进程解除键盘武装（Enter 不再等于关闭）— 仅非 force 路径（force 后窗口即将关闭）
  if (!force) {
    var _bw = _shBridge;
    if (_bw && _bw.window && _bw.window.closeConfirmDismissed) {
      try { _bw.window.closeConfirmDismissed(); } catch (_) { }
    }
  }
}

function _onCloseConfirmKey(e) {
  if (e.key === 'Escape') { hideCloseConfirm(); }
  else if (e.key === 'Enter') { _executeCloseConfirm(); }
}

function bootWindowControls() {
  var bridge = _shBridge;
  var $min = document.getElementById('qqq-wc-min');
  var $max = document.getElementById('qqq-wc-max');
  var $close = document.getElementById('qqq-wc-close');
  if ($min) $min.addEventListener('click', function () { bridge.window.minimize(); });
  if ($max) $max.addEventListener('click', async function () {
    var isMax = await bridge.window.isMaximized();
    if (isMax) bridge.window.unmaximize(); else bridge.window.maximize();
  });
  if ($close) $close.addEventListener('click', function () { bridge.window.close(); });

  // ★ 监听主进程的关闭确认请求（Alt+F4 / 点击 X → main 发 IPC）
  if (bridge.window && bridge.window.onCloseConfirm) {
    bridge.window.onCloseConfirm(showCloseConfirm);
  }
  // ★ 主进程 Esc（webContents 级捕获，焦点在 iframe 内也生效）→ 隐藏确认框
  //   force=true（主进程 Enter 确认路径发出）→ 越过 1s 防抖立即隐藏；
  //   Esc 路径 force=false → 1s 防抖照常生效（弹窗至少存在 1 秒）
  if (bridge.window && bridge.window.onCloseConfirmDismiss) {
    bridge.window.onCloseConfirmDismiss(function (force) { hideCloseConfirm(!!force); });
  }
}

// ---- Theme toggle (委托唯一真理配色机器) ----
function bootThemeToggle() {
  var $btn = document.getElementById('qqq-theme-toggle');
  if (!$btn) return;
  var T = window.qqqideTheme;
  function syncBtn(dark) {
    $btn.textContent = dark ? '\u263C' : '\u263D';
    $btn.title = dark ? window._i('shell.theme.switchToLight', '切换到亮色') : window._i('shell.theme.switchToDark', '切换到暗色');
  }
  syncBtn(T.isDark());
  T.onChange(function (dark) {
    $btn.title = dark ? window._i('shell.theme.switchToLight', '切换到亮色') : window._i('shell.theme.switchToDark', '切换到暗色');
  });
  $btn.addEventListener('click', function () { T.apply(!T.isDark()); });
}

// ---- AI Viewport (titlebar row 1) ----
function bootAiViewport() {
  var host = document.getElementById('qqq-ai-viewport');
  if (!host || !window.qqqideViewport) return;
  window.qqqideViewport.build(host);
}

// ---- Editor font size (was zoom; window UI locked at 1.00) ----
// Press-and-hold: mousedown fires immediately (§43: first tick ±1), then 300ms pause,
//   then repeat at 200ms with ×10 jump (e.g. 17→18→28→38) to reduce Monaco pressure.
//   Single click = one immediate fire only (mouseup before 300ms → no repeat).
//   Persistence: fast path (adjust) does NOT save. Only on mouseup we call set() once.
var _efsRepeatTimer = 0;
var _efsRepeatDelta = 0;
var _efsDelay = 0;
var _efsStopped = false;
var _efsLastSize = 0;
var _efsRepeatGen = 0; // ★ per-click generation — stale async results discarded

function applyFontSizeLabel(size) {
  var $label = document.getElementById('qqq-zoom-label');
  if ($label) $label.textContent = String(Math.round(size));
}

function _efsStartRepeat(delta) {
  var bridge = _shBridge;
  if (!bridge || !bridge.zoom) return;
  _efsStopped = false;
  _efsRepeatDelta = delta;
  _efsLastSize = 0;
  _efsRepeatGen++; // ★ new gen — all in-flight async calls from previous clicks become stale
  var gen = _efsRepeatGen;
  if (_efsRepeatTimer) { clearTimeout(_efsRepeatTimer); _efsRepeatTimer = 0; }
  _efsRepeatTick(gen);
  _efsRepeatTimer = setTimeout(function () {
    _efsRepeatTimer = 0;
    if (_efsStopped) return;
    _efsRepeatTickChained(gen);
  }, 300);
}

async function _efsRepeatTickChained(gen) {
  if (_efsStopped || _efsRepeatGen !== gen) return;
  var bridge = _shBridge;
  if (!bridge || !bridge.zoom) return;
  try {
    // ★ Hold jump: delta ×10 to reduce Monaco pressure, e.g. 17→18→28→38 instead of 17→18→19→20
    var s = await bridge.zoom.adjust(_efsRepeatDelta * 10);
    if (_efsRepeatGen !== gen) return; // stale gen — discard
    _efsLastSize = s;
    applyFontSizeLabel(s);
  } catch (_) { }
  if (_efsStopped || _efsRepeatGen !== gen) return;
  _efsRepeatTimer = setTimeout(function () {
    _efsRepeatTimer = 0;
    if (_efsStopped) return;
    _efsRepeatTickChained(gen);
  }, 200);
}

async function _efsRepeatTick(gen) {
  if (_efsRepeatGen !== gen) return; // stale — another click started before async resolved
  var bridge = _shBridge;
  if (!bridge || !bridge.zoom) return;
  try {
    var s = await bridge.zoom.adjust(_efsRepeatDelta);
    if (_efsRepeatGen !== gen) return; // stale after await — discard
    _efsLastSize = s;
    applyFontSizeLabel(s);
  } catch (_) { }
}

function _efsStopRepeat() {
  _efsStopped = true;
  if (_efsRepeatTimer) { clearTimeout(_efsRepeatTimer); _efsRepeatTimer = 0; }
  _efsDelay = 0;
  // ★ Persist ONCE on mouseup (adjust ticks never save — fast path above)
  if (_efsLastSize) {
    var bridge = _shBridge;
    if (bridge && bridge.zoom) {
      try { bridge.zoom.set(_efsLastSize); } catch (_) { }
    }
  }
}

function bootZoomButtons() {
  var bridge = _shBridge;
  var $in = document.getElementById('qqq-zoom-in');
  var $out = document.getElementById('qqq-zoom-out');
  if (!bridge.zoom) return;

  if ($in) {
    $in.addEventListener('mousedown', function () { _efsStartRepeat(1); });
    $in.addEventListener('mouseup', _efsStopRepeat);
    $in.addEventListener('mouseleave', _efsStopRepeat);
  }
  if ($out) {
    $out.addEventListener('mousedown', function () { _efsStartRepeat(-1); });
    $out.addEventListener('mouseup', _efsStopRepeat);
    $out.addEventListener('mouseleave', _efsStopRepeat);
  }

  // Listen for changes from keyboard shortcuts (Ctrl+= / Ctrl+- / Ctrl+0)
  if (bridge.zoom.onChanged) {
    bridge.zoom.onChanged(function (s) {
      applyFontSizeLabel(s);
    });
  }
  // Initial label
  bridge.zoom.get().then(applyFontSizeLabel);
}

// ---- A Zone (gaea host) ----
function bootAZone() {
  var host = document.getElementById('qqq-a-zone');
  if (!host) return;
  if (window.qqqGaea) {
    window.qqqGaea.build(host);
  } else {
    host.innerHTML = '<div style="padding:12px; color:var(--base1); font-size:12px;">' + window._i('shell.gaeaHostLoading', 'gaea host 加载中....') + '</div>';
  }
}

// ---- Tab Manager (X zone upper) ----
function bootTabManager() {
  var xUpper = document.getElementById('qqq-x-upper');
  if (!xUpper || !window.qqqTabs) return;
  window.qqqTabs.init(xUpper);
  // roam tab is now provided by rage goods (via gaea-host tabs protocol).
}

// ---- AI Zone ----
function bootAiZone() {
  // ★ 中面板始终加载（左右翼在 bootBulbs 中预初始化）
  var centerHost = document.getElementById('qqq-ai-zone');
  if (centerHost && window.qqqidePanel) {
    window.qqqidePanel.build(centerHost, 1);
  }
}

// ---- Output panel ----
function bootOutputPanel() {
  var outEl = document.getElementById('qqq-x-output');
  var sashEl = document.getElementById('qqq-sash-output');
  var closeBtn = document.getElementById('qqq-output-close');

  if (!_shLayoutState.outputVisible && outEl) {
    outEl.classList.add('qqq-hidden');
    if (sashEl) sashEl.classList.add('qqq-hidden');
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      hideOutput();
    });
  }
}

function showOutput() {
  var outEl = document.getElementById('qqq-x-output');
  var sashEl = document.getElementById('qqq-sash-output');
  if (outEl) {
    outEl.classList.remove('qqq-hidden');
    outEl.style.flexBasis = _shLayoutState.outputH + 'px';
    outEl.style.height = _shLayoutState.outputH + 'px';
  }
  if (sashEl) sashEl.classList.remove('qqq-hidden');
  _shLayoutState.outputVisible = true;
  persistState();
}

function hideOutput() {
  var outEl = document.getElementById('qqq-x-output');
  var sashEl = document.getElementById('qqq-sash-output');
  if (outEl) outEl.classList.add('qqq-hidden');
  if (sashEl) sashEl.classList.add('qqq-hidden');
  _shLayoutState.outputVisible = false;
  persistState();
}

// ---- Sashes ----
function bootSashes() {
  // A-zone | X-zone sash
  var aSash = document.querySelector('[data-sash="a-right"]');
  var aEl = document.getElementById('qqq-a-zone');
  var xEl = document.getElementById('qqq-x-zone');
  if (aSash && aEl && xEl) {
    window.qqqideSash.bindV(aSash,
      [{
        getW: function () { return aEl.offsetWidth; },
        setW: function (w) { _shLayoutState.aZoneW = w; aEl.style.flexBasis = w + 'px'; aEl.style.width = w + 'px'; document.documentElement.style.setProperty('--a-zone-w', w + 'px'); },
        min: _shMin,
      }],
      [{
        getW: function () { return xEl.offsetWidth; },
        setW: function (w) { /* X zone is flex:1, auto-adjusts */ },
        min: _shMin,
      }]
    );
  }

  // Output sash (horizontal)
  var oSash = document.getElementById('qqq-sash-output');
  var xUpper = document.getElementById('qqq-x-upper');
  var oEl = document.getElementById('qqq-x-output');
  if (oSash && xUpper && oEl) {
    window.qqqideSash.bindH(oSash,
      [{
        getH: function () { return xUpper.offsetHeight; },
        setH: function (h) { /* upper auto-adjusts */ },
        min: _shMin,
      }],
      [{
        getH: function () { return oEl.offsetHeight; },
        setH: function (h) { _shLayoutState.outputH = h; oEl.style.flexBasis = h + 'px'; oEl.style.height = h + 'px'; },
        min: _shMin,
      }]
    );
  }
}

// ---- Resize grip ----
function bootResizeGrip() {
  var grip = document.getElementById('qqq-resize-grip');
  if (!grip || !_shBridge || !_shBridge.window) return;
  // In Electron, resize grip is handled via -webkit-app-region or IPC
}

// ---- Boot info ----
function fillBootInfo(boot) {
  // [silent] boot info
}

// ---- Main ----
async function main() {
  var bridge = _shBridge;
  await loadState();
  applyLayout();

  _shPrevWinH = window.innerHeight;
  window.addEventListener('resize', onWindowResize);

  bootWindowControls();
  bootThemeToggle();
  bootZoomButtons();
  bootAiViewport();
  bootLangSwitcher();

  // Unified RPC forwarder MUST be registered before any iframe loads
  bootRpcForwarder();

  // Tab manager MUST init before A Zone (gaea-host may create tabs)
  bootTabManager();

  // A Zone (gaea-host processes pending goods, may add tabs)
  bootAZone();

  // AI Zone
  bootAiZone();

  // 灯泡开关（左右 AI 面板 + 窗口弹性伸缩）
  bootBulbs();

  // AI Overlay (must be after AI zone to catch iframe messages)
  bootAiOverlay();
  // Output panel
  bootOutputPanel();

  // Sashes
  bootSashes();

  // Menu
  await bootMenu();

  // Boot info
  var boot;
  try { boot = await bridge.boot.getInfo(); }
  catch (e) { boot = { version: '?', platform: 'browser', arch: 'na' }; }
  // Expose boot info for iframes (q2-roam, etc.)
  window.qqqBootInfo = boot;
  bootStatusbar(boot);
  bootActivities(boot);
  fillBootInfo(boot);

  // Resize grip
  bootResizeGrip();

  // Hook file explorer -> tabs
  hookFileExplorerToTabs();

  // KeyHook (loads bindings + globalShortcut + window/iframe dispatchers)
  await bootKeyHook();

  // ★ F100 兜底直连：F2/Tab 非编辑态 → 激活 roam tab + 聚焦 iframe
  //    与 key-hook 配置链双保险：key-hook 成功则 stopPropagation 已拦（不重复），
  //    key-hook 任何一环失败（fetch/init/when）则由本监听兜底，保证功能永不静默失效
  bootRoamKeyFallback();

  // Expose layout API for sash persistence
  window.qqqLayout = {
    persist: persistState,
    showOutput: showOutput,
    hideOutput: hideOutput,
    getState: function () { return _shLayoutState; },
  };

  // [silent] qqqide ready
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
