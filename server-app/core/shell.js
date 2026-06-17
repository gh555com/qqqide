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
  aZoneW: 220,
  outputH: 200,
  outputVisible: false,
};

async function loadState() {
  var bridge = _shBridge;
  // 1) try StateStore first
  try {
    if (bridge && bridge.state && bridge.state.get) {
      var v = await bridge.state.get('qqqide', 'layout_v2');
      if (v && typeof v === 'object') {
        if (typeof v.aZoneW === 'number') _shLayoutState.aZoneW = v.aZoneW;
        if (typeof v.outputH === 'number') _shLayoutState.outputH = v.outputH;
        if (typeof v.outputVisible === 'boolean') _shLayoutState.outputVisible = v.outputVisible;
      }
    }
  } catch (_) { /* fall through to defaults */ }
  // 2) migration: if StateStore had no value, try old localStorage key
  var _stillDefault = _shLayoutState.aZoneW === 220 && _shLayoutState.outputH === 200 && !_shLayoutState.outputVisible;
  if (_stillDefault) {
    try {
      var raw = localStorage.getItem('qqq-layout-v2');
      if (raw) {
        var old = JSON.parse(raw);
        if (typeof old.aZoneW === 'number') _shLayoutState.aZoneW = old.aZoneW;
        if (typeof old.outputH === 'number') _shLayoutState.outputH = old.outputH;
        if (typeof old.outputVisible === 'boolean') _shLayoutState.outputVisible = old.outputVisible;
        // one-time migrate: push to StateStore, remove localStorage
        try { localStorage.removeItem('qqq-layout-v2'); } catch (_) { }
        try { if (bridge && bridge.state && bridge.state.set) bridge.state.set('qqqide', 'layout_v2', _shLayoutState); } catch (_) { }
      }
    } catch (_) { }
  }
  _shLayoutState.aZoneW = Math.max(_shMin, _shLayoutState.aZoneW || 220);
  _shLayoutState.outputH = Math.max(_shMin, _shLayoutState.outputH || 200);
}

function persistState() {
  var bridge = _shBridge;
  // Authoritative: StateStore (debounced, atomic, cloud=true via qqqide).
  try {
    if (bridge && bridge.state && bridge.state.set) {
      bridge.state.set('qqqide', 'layout_v2', {
        aZoneW: _shLayoutState.aZoneW,
        outputH: _shLayoutState.outputH,
        outputVisible: _shLayoutState.outputVisible,
      }).catch(function () { });
    }
  } catch (_) { /* ignore */ }
}

// ---- CSS variable helpers ----
function applyLayout() {
  var aEl = document.getElementById('qqq-a-zone');
  if (aEl && !aEl.classList.contains('qqq-collapsed')) {
    aEl.style.flexBasis = _shLayoutState.aZoneW + 'px';
    aEl.style.width = _shLayoutState.aZoneW + 'px';
  }
  var oEl = document.getElementById('qqq-x-output');
  if (oEl) {
    oEl.style.flexBasis = _shLayoutState.outputH + 'px';
    oEl.style.height = _shLayoutState.outputH + 'px';
  }
}

// ---- Window resize: proportional scaling, frozen min panels stay frozen ----
var _shPrevWinW = 0;
var _shPrevWinH = 0;

function onWindowResize() {
  var winW = window.innerWidth;
  var winH = window.innerHeight;
  if (_shPrevWinW === 0) { _shPrevWinW = winW; _shPrevWinH = winH; }

  var aEl = document.getElementById('qqq-a-zone');
  if (aEl && !aEl.classList.contains('qqq-collapsed')) {
    var oldA = _shLayoutState.aZoneW;
    // available middle width = win - AI - sash
    var oldAvail = _shPrevWinW - _shAiW - _shSashW;
    var newAvail = winW - _shAiW - _shSashW;
    if (oldAvail > 0 && newAvail > 0) {
      if (oldA <= _shMin) {
        // frozen at min, keep at min
        _shLayoutState.aZoneW = _shMin;
      } else {
        var ratio = oldA / oldAvail;
        _shLayoutState.aZoneW = Math.max(_shMin, Math.round(ratio * newAvail));
      }
    }
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

  _shPrevWinW = winW;
  _shPrevWinH = winH;
  applyLayout();
}

// ---- Window controls ----
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

// ---- Zoom +/- buttons (step 0.05) ----
function applyZoomCompensation(f) {
  document.documentElement.style.setProperty('--ai-zone-w', (_shAiW / f) + 'px');
  var $label = document.getElementById('qqq-zoom-label');
  if ($label) $label.textContent = f.toFixed(2);
}
function bootZoomButtons() {
  var bridge = _shBridge;
  var $in = document.getElementById('qqq-zoom-in');
  var $out = document.getElementById('qqq-zoom-out');
  if (!bridge.zoom) return;
  if ($in) $in.addEventListener('click', async function () {
    var f = await bridge.zoom.adjust(0.05);
    applyZoomCompensation(f);
  });
  if ($out) $out.addEventListener('click', async function () {
    var f = await bridge.zoom.adjust(-0.05);
    applyZoomCompensation(f);
  });
  // Listen for zoom changes from keyboard shortcuts (main process)
  if (bridge.zoom.onChanged) {
    bridge.zoom.onChanged(function (f) {
      applyZoomCompensation(f);
    });
  }
  // Initial compensation on boot
  bridge.zoom.get().then(applyZoomCompensation);
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
  // Roam tab is now provided by rage goods (via gaea-host tabs protocol).
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
        setW: function (w) { _shLayoutState.aZoneW = w; aEl.style.flexBasis = w + 'px'; aEl.style.width = w + 'px'; },
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

  _shPrevWinW = window.innerWidth;
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
  catch (e) { boot = { version: '?', engineAlive: false, platform: 'browser', arch: 'na' }; }
  // Expose boot info for iframes (q2-roam, etc.)
  window.qqqBootInfo = boot;
  bootStatusbar(boot);
  fillBootInfo(boot);

  // Resize grip
  bootResizeGrip();

  // Hook file explorer -> tabs
  hookFileExplorerToTabs();

  // KeyHook (loads bindings + globalShortcut + window/iframe dispatchers)
  await bootKeyHook();

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
