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
  // ★ restore 模式：优先从 qgs 窗口快照读取 layout
  if (window.location.search.indexOf('restore=1') !== -1) {
    try {
      var m = window.location.search.match(/[?&]folder=([^&]+)/);
      if (m && bridge && bridge.state && bridge.state.get) {
        var key = 'win_snap:' + decodeURIComponent(m[1]).replace(/\\/g, '/').replace(/\/$/, '');
        var snap = await bridge.state.get('qqqide', key).catch(function () { return null; });
        if (snap && snap.layout && typeof snap.layout === 'object') {
          if (typeof snap.layout.aZoneW === 'number') _shLayoutState.aZoneW = snap.layout.aZoneW;
          if (typeof snap.layout.outputH === 'number') _shLayoutState.outputH = snap.layout.outputH;
          if (typeof snap.layout.outputVisible === 'boolean') _shLayoutState.outputVisible = snap.layout.outputVisible;
          _shLayoutState.aZoneW = Math.max(_shMin, _shLayoutState.aZoneW || 220);
          _shLayoutState.outputH = Math.max(_shMin, _shLayoutState.outputH || 200);
          // 也写回 layout_v2 确保下次正常启动也能拿到
          if (bridge.state.set) bridge.state.set('qqqide', 'layout_v2', _shLayoutState).catch(function () { });
          return; // 快照成功 → 退出，不再走下面的逻辑
        }
      }
    } catch (_) { /* fall through */ }
  }
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

// ---- Editor font size (was zoom; window UI locked at 1.00) ----
// Press-and-hold: mousedown fires immediately, then a 300ms pause, then accel repeat.
//   Single click = one immediate fire only (mouseup before 300ms → no repeat).
//   Persistence: fast path (adjust) does NOT save. Only on mouseup we call set() once.
var _efsRepeatTimer = 0;
var _efsRepeatDelta = 0;
var _efsDelay = 0;
var _efsStopped = false;
var _efsLastSize = 0;

function applyFontSizeLabel(size) {
  var $label = document.getElementById('qqq-zoom-label');
  if ($label) $label.textContent = String(Math.round(size));
}

function _efsStartRepeat(delta) {
  var bridge = _shBridge;
  if (!bridge || !bridge.zoom) return;
  _efsStopped = false;
  _efsRepeatDelta = delta;
  _efsDelay = 160;
  if (_efsRepeatTimer) { clearTimeout(_efsRepeatTimer); _efsRepeatTimer = 0; }
  _efsRepeatTick();
  _efsRepeatTimer = setTimeout(function () {
    _efsRepeatTimer = 0;
    if (_efsStopped) return;
    _efsRepeatTickChained();
  }, 300);
}

async function _efsRepeatTickChained() {
  if (_efsStopped) return;
  var bridge = _shBridge;
  if (!bridge || !bridge.zoom) return;
  try {
    var s = await bridge.zoom.adjust(_efsRepeatDelta);
    _efsLastSize = s;
    applyFontSizeLabel(s);
  } catch (_) { }
  if (_efsStopped) return;
  _efsDelay = Math.max(25, _efsDelay * 0.88);
  _efsRepeatTimer = setTimeout(function () {
    _efsRepeatTimer = 0;
    if (_efsStopped) return;
    _efsRepeatTickChained();
  }, _efsDelay);
}

async function _efsRepeatTick() {
  var bridge = _shBridge;
  if (!bridge || !bridge.zoom) return;
  try {
    var s = await bridge.zoom.adjust(_efsRepeatDelta);
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
