// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-wings.js — 红色灯泡：左右翼开关 + 窗口伸缩（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window.qqqidePanel, window.qqqideViewport
// 常量: _shAiW = 389 (AI 面板宽度，shell.js 也引用)
// ============================================================================

var _shAiW = 389;  // AI panel width, shared with shell.js (onWindowResize)

var _shellBulbState = { left: false, right: false };
var _shellWingLocked = false; // 不应期锁：toggle 进行中拒绝一切重复点击

function bootBulbs() {
  var bridge = window.qqqideBridge;
  var d1 = document.getElementById('qqq-bulb-1');
  var d2 = document.getElementById('qqq-bulb-2');
  if (!d1 || !d2) return;

  // ★ 灯泡持久化 → only.sq3（项目资产）
  function _wingsFolderFromUrl() {
    var m = window.location.search.match(/[?&]folder=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]).replace(/\\/g, '/').replace(/\/$/, ''); }
      catch (_) { }
    }
    return null;
  }

  function _onlyDb() {
    var root = window._workspaceRoot || _wingsFolderFromUrl();
    if (!root || !window.qgs || typeof window.qgs.project !== 'function') return null;
    return window.qgs.project(root + '/qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
  }
  function _persistBulbs() {
    var db = _onlyDb();
    if (db) db.set('wings.bulbs', { left: _shellBulbState.left, right: _shellBulbState.right }).catch(function () { });
  }
  function _restoreBulbs() {
    var db = _onlyDb();
    if (!db) return;
    db.get('wings.bulbs').then(function (v) {
      if (v && typeof v === 'object') {
        if (typeof v.left === 'boolean') _shellBulbState.left = v.left;
        if (typeof v.right === 'boolean') _shellBulbState.right = v.right;
        if (_shellBulbState.left) d1.classList.add('on'); else d1.classList.remove('on');
        if (_shellBulbState.right) d2.classList.add('on'); else d2.classList.remove('on');
        _applyWings();
        try { if (bridge && bridge.window && bridge.window.setWingState) bridge.window.setWingState(_shellBulbState.left, _shellBulbState.right); } catch (_) { }
      }
    }).catch(function () { });
  }
  // 启动时工作空间未就绪→监听它出现后恢复
  var _bulbsWatchTimer = null;
  var _bulbsRestored = false;
  (function _watchBulbsRoot() {
    if (_bulbsRestored) return;
    if (typeof window._workspaceRoot === 'string' && window._workspaceRoot) {
      _bulbsRestored = true;
      if (_bulbsWatchTimer) { clearInterval(_bulbsWatchTimer); _bulbsWatchTimer = null; }
      _restoreBulbs();
      return;
    }
    if (!_bulbsWatchTimer) _bulbsWatchTimer = setInterval(function () {
      if (typeof window._workspaceRoot === 'string' && window._workspaceRoot) {
        clearInterval(_bulbsWatchTimer);
        _bulbsWatchTimer = null;
        _bulbsRestored = true;
        _restoreBulbs();
      }
    }, 300);
  })();

  var _main = document.getElementById('qqq-main');
  var _wl = document.getElementById('qqq-wing-left');
  var _wr = document.getElementById('qqq-wing-right');

  // ★ 预初始化：启动时即创建全部三个面板的 iframe（中面板在 bootAiZone 已建）
  //    翼板 iframe 在 width:0 容器内静默加载，首开时零等待
  function _preinitWings() {
    if (_wl && !_wl.querySelector('iframe') && window.qqqidePanel) {
      window.qqqidePanel.build(_wl, 0);
    }
    if (_wr && !_wr.querySelector('iframe') && window.qqqidePanel) {
      window.qqqidePanel.build(_wr, 2);
    }
  }

  function _applyWings() {
    var leftOn = _shellBulbState.left;
    var rightOn = _shellBulbState.right;

    if (_main) {
      _main.style.left = leftOn ? _shAiW + 'px' : '0';
      _main.style.right = rightOn ? _shAiW + 'px' : '0';
    } else {
      console.warn('[wings] _main NOT FOUND!');
    }

    if (_wl) {
      _wl.style.width = leftOn ? _shAiW + 'px' : '0';
    } else {
      console.warn('[wings] LEFT WING ELEMENT MISSING!');
    }

    if (_wr) {
      _wr.style.width = rightOn ? _shAiW + 'px' : '0';
    } else {
      console.warn('[wings] RIGHT WING ELEMENT MISSING!');
    }
  }

  // ★ 魔术遮罩（方案 B）：toggle 期间覆盖全窗口，阻塞一切交互 + 视觉遮盖
  var _wingMask = null;
  function _showMask() {
    if (_wingMask) return;
    _wingMask = document.createElement('div');
    _wingMask.className = 'qqq-wing-mask';
    var txt = document.createElement('div');
    txt.className = 'qqq-wing-mask-text';
    // 优先走 i18n，无则用硬编码回退
    txt.textContent = (window._i && window._i('wings.redrawing', '重绘中')) || '重绘中';
    _wingMask.appendChild(txt);
    // 捕获取消一切事件（click/keydown/滚轮等）
    _wingMask.addEventListener('keydown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
    _wingMask.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false, capture: true });
    _wingMask.addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);
    document.body.appendChild(_wingMask);
  }
  function _hideMask() {
    if (!_wingMask) return;
    _wingMask.remove();
    _wingMask = null;
  }

  // ★ 原子帧 toggle：不应期锁 → 魔术遮罩 → await 窗口缩放 → rAF 批处理 CSS → 收遮罩 → 解锁
  async function _toggle(index) {
    if (_shellWingLocked) return; // 不应期内拒绝一切操作
    _shellWingLocked = true;
    // 安全网：1.5s 后强制解锁 + 收遮罩（极端情况兜底）
    var safetyTimer = setTimeout(function () { _shellWingLocked = false; _hideMask(); }, 1500);

    // ① 立刻弹出魔术遮罩，等一帧确保已上屏，再动任何 UI
    _showMask();
    await new Promise(function (resolve) { requestAnimationFrame(resolve); });

    if (index === 0) _shellBulbState.left = !_shellBulbState.left;
    else _shellBulbState.right = !_shellBulbState.right;

    // 关闭 AI 视口下拉（防止 fixed 定位漂移到 0,0）
    if (window.qqqideViewport && window.qqqideViewport.closeDropdown) {
      window.qqqideViewport.closeDropdown();
    }

    // 灯泡红点（遮罩已覆盖，用户未可见）
    var dot = index === 0 ? d1 : d2;
    dot.classList.toggle('on', index === 0 ? _shellBulbState.left : _shellBulbState.right);

    // ② 窗口先就位（主进程同步 setBounds）
    var deltaLeft = 0, deltaRight = 0;
    if (index === 0) deltaLeft = _shellBulbState.left ? _shAiW : -_shAiW;
    else deltaRight = _shellBulbState.right ? _shAiW : -_shAiW;
    try {
      if (bridge && bridge.window && bridge.window.adjustBounds) {
        await bridge.window.adjustBounds(deltaLeft, deltaRight);
      }
    } catch (e) { console.warn('[wings] adjustBounds error:', e); }

    // ★ 通知主进程更新最小窗口尺寸（防止拖拽缩小到中间面板阈值以下）
    try {
      if (bridge && bridge.window && bridge.window.setWingState) {
        bridge.window.setWingState(_shellBulbState.left, _shellBulbState.right);
      }
    } catch (e) { console.warn('[wings] setWingState error:', e); }

    // ③ 窗口已就位，下一帧统一批处理 CSS，再等一帧收遮罩
    requestAnimationFrame(function () {
      _applyWings();
      _persistBulbs();
      requestAnimationFrame(function () {
        clearTimeout(safetyTimer);
        _hideMask();
        _shellWingLocked = false;
      });
    });
  }

  d1.addEventListener('click', function () { _toggle(0); });
  d2.addEventListener('click', function () { _toggle(1); });

  // 初始恢复：仅设 CSS（不调窗口尺寸，防重启累加）
  if (_shellBulbState.left) d1.classList.add('on');
  if (_shellBulbState.right) d2.classList.add('on');
  _applyWings();
  // 预初始化左右翼 iframe（width:0 容器内静默加载）
  _preinitWings();

  // ★ 启动时同步翼状态到主进程，确保最小窗口尺寸正确
  try {
    if (bridge && bridge.window && bridge.window.setWingState) {
      bridge.window.setWingState(_shellBulbState.left, _shellBulbState.right);
    }
  } catch (e) { console.warn('[wings] init setWingState error:', e); }
}
