// ============================================================================
// login.js — 登录模块
// 注入: 排行榜🏆 / LV经验条 / GE余额 / 手机号 / 登录按钮 → 菜单行2
// ============================================================================

(function () {
  'use strict';

  var _authData = null;
  var _initDone = false;
  var _stateListeners = [];
  var _$loginBtn = null;
  var _$phoneBtn = null;
  var _$geLabel = null;
  var _$lvBar = null;
  var _$lvLevel = null;
  var _$lvProgress = null;
  var _$ldrBtn = null;
  var _balanceGe = null;
  var _balanceLastFetch = 0;
  var _balanceTimer = null;
  var _lvData = null;
  var _lvLastFetch = 0;
  var _$ldrOverlay = null;
  var _$ldrPanel = null;

  var API_BASE = 'https://gh555.com/api';
  var LOGIN_URL = 'https://gh555.com/login';
  var POLL_INTERVAL_MS = 3000;
  var POLL_TIMEOUT_MS = 600000;
  var BALANCE_POLL_MS = 60000;
  var NO_DRAG = '-webkit-app-region:no-drag;';

  // ── 登录并发控制 ──
  var _loginAbortCtrl = null;   // AbortController：取消旧登录轮询
  var _loginGen = 0;            // 代际计数器：抑制过期 toast

  var _bootInfo = null;
  var _flagCssReady = false;
  var _flagCssPending = null;  // Promise | null

  // ★ 预加载 flag-icons CSS（fetch→内联注入，绕过 CSP style-src）
  function _loadFlagCss() {
    if (_flagCssReady) return Promise.resolve(true);
    if (_flagCssPending) return _flagCssPending;
    var FLAG_CSS_URL = 'https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/css/flag-icons.min.css';
    _flagCssPending = fetch(FLAG_CSS_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (css) {
      var style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
      _flagCssReady = true;
      return true;
    }).catch(function () {
      _flagCssReady = true;  // 静默降级，不再重试
      return false;
    });
    return _flagCssPending;
  }

  function _buildDeviceName() {
    var info = _bootInfo;
    var ide = 'qqqide', plat = 'Win';
    if (info && info.platform) {
      if (info.platform === 'darwin') plat = 'macOS';
      else if (info.platform === 'linux') plat = 'Linux';
      else plat = info.platform.charAt(0).toUpperCase() + info.platform.slice(1);
    }
    var arch = (info && info.arch === 'arm64') ? 'arm64' : 'x64';
    return ide + '_' + plat + '_' + arch;
  }

  function _generateSessionId() {
    var arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    var hex = '';
    for (var i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
    return hex;
  }

  function _setAuthData(token, phone, countryIso2) {
    _authData = { token: token, phone: phone, device_name: _buildDeviceName(), ts: Date.now() };
    if (countryIso2) _authData.countryIso2 = countryIso2;
    _persistAuthAsync();
  }

  function _clearAuthData() { _authData = null; }

  function _persistAuthAsync() {
    if (!_authData) return;
    try {
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.saveAuth) {
        window.qqqideBridge.auth.saveAuth({ token: _authData.token, phone: _authData.phone, device_name: _authData.device_name });
      }
    } catch (e) { }
  }

  async function _restoreAuth() {
    if (_authData && _authData.token) return true;
    try {
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.loadAuth) {
        var saved = await window.qqqideBridge.auth.loadAuth();
        if (saved && saved.token && saved.phone) {
          _authData = saved; _authData.ts = Date.now();
          // ★ 立即显示 LV 区域 + 奖杯（零等待）
          _lvShow();
          return true;
        }
      }
    } catch (e) { }
    return false;
  }

  // ★ 立即显示 LV 区域（不等待数据）
  function _lvShow() {
    if (_$lvBar) _$lvBar.style.display = 'inline-flex';
    if (_$ldrBtn) _$ldrBtn.style.display = '';
  }

  async function _httpsGet(urlPath) {
    var resp = await fetch(API_BASE + urlPath, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  async function _ensureBootInfo() {
    if (_bootInfo) return _bootInfo;
    try {
      if (window.qqqideBridge && window.qqqideBridge.boot && window.qqqideBridge.boot.getInfo) {
        _bootInfo = await window.qqqideBridge.boot.getInfo();
      }
    } catch (e) { }
    return _bootInfo;
  }

  // ── GE 余额 ──
  function _startBalancePoll() {
    _stopBalancePoll();
    _fetchBalance(true);
    _balanceTimer = setInterval(function () { _fetchBalance(false); }, BALANCE_POLL_MS);
  }

  function _stopBalancePoll() {
    if (_balanceTimer) { clearInterval(_balanceTimer); _balanceTimer = null; }
  }

  async function _fetchBalance(force) {
    if (!_authData || !_authData.token) return;
    var now = Date.now();
    if (!force && now - _balanceLastFetch < BALANCE_POLL_MS) return;
    _balanceLastFetch = now;
    try {
      var resp = await fetch(API_BASE + '/wallet/balance', {
        headers: { 'Authorization': 'Bearer ' + _authData.token }
      });
      var data = await resp.json();
      if (data && data.ok && typeof data.balance !== 'undefined') {
        _balanceGe = data.balance;
        _updateGeLabel();
      }
    } catch (e) { console.warn('[login] balance fetch error:', e.message); }
  }

  function _updateGeLabel() {
    if (!_$geLabel) return;
    if (_balanceGe !== null && _balanceGe !== undefined) {
      _$geLabel.textContent = Math.round(_balanceGe) + ' ge';
      _$geLabel.style.display = '';
    } else {
      _$geLabel.style.display = 'none';
    }
  }

  // ── LV（事件驱动：每间 house 的 billing 都直接触发动画）──
  var _lvAccWge = null;  // 本地累计总 wge（null=未从服务器初始化）

  function _setupLvListener() {
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'qqq-lv-tick') {
        var costWge = e.data.geCost || 0;
        // GE 乐观扣减
        var costGe = costWge / 10000;
        if (_balanceGe !== null && _balanceGe !== undefined && costGe > 0) {
          _balanceGe = Math.max(0, _balanceGe - costGe);
          _updateGeLabel();
        }
        // ★ LV 本地即时动画（不等服务器！每间 house 独立触发）
        if (_lvAccWge !== null && costWge > 0) {
          _lvAccWge += costWge;
          var WL = 10 * 10000;
          var lvFloor = Math.floor(_lvAccWge / WL);
          var lvPct = (_lvAccWge % WL) / WL * 100;
          _lvAnimate(lvFloor, lvPct);
        }
        // 服务器真理后台静默拉取（只同步 _lvAccWge 基准，不动画）
        _fetchLv();
        // 免费预算
        if (e.data.freeWindow) {
          try { if (typeof fetchFreeBudget === 'function') fetchFreeBudget(); } catch (_) { }
        }
      }
    });
  }

  async function _fetchLv() {
    if (!_authData || !_authData.token) return;
    try {
      var resp = await fetch(API_BASE + '/qqq/lv', {
        headers: { 'Authorization': 'Bearer ' + _authData.token }
      });
      var data = await resp.json();
      if (data && data.ok) {
        _lvData = data;
        var firstTime = (_lvAccWge === null);
        var WL = 10 * 10000;
        var servFloor = data.level_floor != null ? data.level_floor : 0;
        var servPct = Math.min(data.progress_pct || 0, 100);
        var servWge = servFloor * WL + (servPct / 100) * WL;
        // 只前进不后退
        if (_lvAccWge === null || servWge > _lvAccWge) {
          _lvAccWge = servWge;
        }
        _lvLastGe = data.total_consumed_ge || '';
        // ★ 首次启动：snap 两层到服务器基准（不播动画，顶层盖住中层）
        if (firstTime) {
          _lvDisplaySnap(servPct, servFloor);
        }
        if (_$lvBar) _$lvBar.style.display = 'inline-flex';
        if (_$lvLevel && servFloor >= 0) _$lvLevel.textContent = 'Lv' + servFloor;
        if (_$ldrBtn) _$ldrBtn.style.display = '';
      }
    } catch (e) { /* silent */ }
  }

  // ★ 快照定位：中层+顶层同时到位，零过渡，盖上 #c4b187
  function _lvDisplaySnap(pct, lvFloor) {
    if (_$lvBar) _$lvBar.style.display = 'inline-flex';
    if (_$lvLevel && lvFloor >= 0) _$lvLevel.textContent = 'Lv' + lvFloor;
    _lvPrevFloor = lvFloor;
    _lvAnim = null;
    if (_lvAnimFrame) { cancelAnimationFrame(_lvAnimFrame); _lvAnimFrame = null; }
    if (_$lvGlow) _$lvGlow.style.width = pct + '%';
    if (_$lvSolid) {
      _$lvSolid.style.transition = 'none';
      _$lvSolid.style.width = pct + '%';
      _$lvSolid.style.background = '#c4b187';
    }
  }

  // ═══ LV 3 层动画引擎（rAF 驱动，精确时长 + 保证 1px 间隙） ═══
  // 中层 (_$lvGlow): #ffffdd 象牙白，瞬移，z-index:1
  // 顶层 (_$lvSolid): 始终 #c4b187（调试统一色），追上后变色逻辑保留但暂同色，z-index:2
  var _$lvGlow = null;
  var _$lvSolid = null;
  var _lvPrevFloor = -1;
  var _lvAnim = null;      // { startTime, startPct, targetPct, duration, gen }
  var _lvAnimFrame = null; // rAF id
  var _lvChaseGen = 0;
  var TRACK_PX = 60;       // 血条总宽 60px

  // 中层瞬移
  function _lvSnapGlow(pct) {
    if (!_$lvGlow) return;
    _$lvGlow.style.width = pct + '%';
  }

  // ★ 升级特效：金环爆闪 + LV 文字弹跳
  function _lvLevelUpBurst() {
    if (!_$lvBar) return;
    var track = _$lvBar.querySelector('.qqq-lv-track');
    // ① 轨道白闪
    if (track) {
      track.style.boxShadow = '0 0 18px 4px #fff, 0 0 36px 8px #c4b187';
      track.style.filter = 'brightness(2)';
      setTimeout(function () {
        track.style.boxShadow = '';
        track.style.filter = '';
      }, 400);
    }
    // ② LV 文字弹跳
    if (_$lvLevel) {
      _$lvLevel.style.transform = 'scale(1.5)';
      _$lvLevel.style.color = '#c4b187';
      _$lvLevel.style.textShadow = '0 0 12px #c4b187';
      setTimeout(function () {
        _$lvLevel.style.transform = '';
        _$lvLevel.style.color = '';
        _$lvLevel.style.textShadow = '';
      }, 500);
    }
    // ③ 整条 bar 光晕
    _$lvBar.style.filter = 'drop-shadow(0 0 14px #c4b187)';
    setTimeout(function () { _$lvBar.style.filter = ''; }, 600);
  }

  // 顶层 rAF 追赶（每间 house 独立调用）
  function _lvChaseSolid(targetPct, isLevelUp) {
    if (!_$lvSolid) return;
    if (isLevelUp) _lvLevelUpBurst();
    var gen = ++_lvChaseGen;
    var now = performance.now();
    var baseDuration = isLevelUp ? 500 : 10000;

    // 计算当前顶层实际宽度（px）
    var curPx = parseFloat(_$lvSolid.style.width) || 0;

    // 如果已有动画且代数相邻 → 延长本次追赶（不重置起点）
    if (_lvAnim && _lvAnim.gen === gen - 1) {
      var elapsed = now - _lvAnim.startTime;
      var remain = Math.max(0, _lvAnim.duration - elapsed);
      // 新时长 = max(基础时长, 剩余时长) —— 永不缩短
      baseDuration = Math.max(baseDuration, remain);
      // 起点用当前动画位置
      curPx = _lvAnim.startPct + (_lvAnim.targetPct - _lvAnim.startPct) * Math.min(elapsed / _lvAnim.duration, 1);
    }

    // 追赶色 = 停止色 #c4b187（调试：统一颜色，看中层透出效果）
    _$lvSolid.style.background = '#c4b187';
    _$lvSolid.style.transition = 'none';

    _lvAnim = { startTime: now, startPct: curPx, targetPct: targetPct, duration: baseDuration, gen: gen };

    if (!_lvAnimFrame) {
      _lvAnimFrame = requestAnimationFrame(_lvTick);
    }
  }

  // rAF 帧
  function _lvTick() {
    _lvAnimFrame = null;
    if (!_lvAnim || !_$lvSolid) return;

    var a = _lvAnim;
    var now = performance.now();
    var elapsed = now - a.startTime;
    var progress = Math.min(elapsed / a.duration, 1);

    // 赛贝尔变速：前慢后快，t^2.5 曲线
    var eased = Math.pow(progress, 2.5);  // 50%→17.7%, 75%→49%, 90%→77%
    var curPct = a.startPct + (a.targetPct - a.startPct) * eased;

    // ★ 保证至少 1px 间隙（60px 轨 = 1.667%），除非已到满时
    var gapPct = a.targetPct - curPct;
    var gapPx = gapPct / 100 * TRACK_PX;
    if (gapPx < 1 && progress < 1) {
      curPct = a.targetPct - (1 / TRACK_PX * 100);
    }

    _$lvSolid.style.width = Math.max(0, curPct) + '%';

    if (progress >= 1) {
      // ★ 追赶结束
      _$lvSolid.style.background = '#c4b187';
      _lvAnim = null;
    } else if (_lvAnim) {
      // 检查是否被新 billing 覆盖（gen 变了说明 _lvTick 已重启）
      if (_lvAnim.gen === a.gen) {
        _lvAnimFrame = requestAnimationFrame(_lvTick);
      }
    }
  }

  // ── LV 升级特效 ──
  function _lvLevelUpGlow() {
    // LV 文字弹跳 + 金色光晕
    if (_$lvLevel) {
      _$lvLevel.style.transition = 'none';
      _$lvLevel.style.transform = 'scale(1.55)';
      _$lvLevel.style.color = '#ffd700';
      _$lvLevel.style.textShadow = '0 0 8px #ffd700, 0 0 22px #ff8c00, 0 0 40px #ff4500';
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          _$lvLevel.style.transition = 'transform 0.55s cubic-bezier(0.175,0.885,0.32,1.275), color 0.8s ease-out, text-shadow 1s ease-out';
          _$lvLevel.style.transform = 'scale(1)';
          _$lvLevel.style.color = '';
          _$lvLevel.style.textShadow = '';
        });
      });
      // 动画结束后清理 transition，避免残留
      setTimeout(function() { if (_$lvLevel) _$lvLevel.style.transition = ''; }, 1200);
    }
    // 经验条金色脉冲
    if (_$lvSolid) {
      _$lvSolid.style.transition = 'none';
      _$lvSolid.style.background = '#ffd700';
      _$lvSolid.style.boxShadow = '0 0 12px #ffd700, 0 0 24px #ff8c00';
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          _$lvSolid.style.transition = 'box-shadow 1.2s ease-out, background 0.7s ease-out';
          _$lvSolid.style.boxShadow = '';
          _$lvSolid.style.background = '#c4b187';
        });
      });
      setTimeout(function() { if (_$lvSolid) _$lvSolid.style.transition = ''; }, 1400);
    }
  }

  function _lvBurstParticles() {
    var barRect = _$lvBar.getBoundingClientRect();
    var cx = barRect.left + barRect.width / 2;
    var cy = barRect.top + barRect.height / 2;
    var container = document.createElement('div');
    container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99998;';
    document.body.appendChild(container);
    var colors = ['#ffd700', '#ffaa00', '#ff8c00', '#fff8dc', '#ffec8b', '#ffd700', '#fff3b0'];
    var count = 28;
    for (var i = 0; i < count; i++) {
      var p = document.createElement('div');
      var a = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.35;
      var d = 25 + Math.random() * 70;
      var s = 1.5 + Math.random() * 4.5;
      var dur = 0.45 + Math.random() * 0.8;
      var color = colors[Math.floor(Math.random() * colors.length)];
      p.style.cssText = 'position:fixed;left:' + cx + 'px;top:' + cy + 'px;width:' + s + 'px;height:' + s + 'px;background:' + color + ';border-radius:50%;pointer-events:none;z-index:99998;transition:all ' + dur + 's cubic-bezier(0,0.65,0.18,1);opacity:1;box-shadow:0 0 ' + (s * 2) + 'px ' + color + ';';
      container.appendChild(p);
      (function(p, a, d, cx, cy) {
        requestAnimationFrame(function() {
          p.style.left = (cx + Math.cos(a) * d) + 'px';
          p.style.top = (cy + Math.sin(a) * d) + 'px';
          p.style.opacity = '0';
          p.style.transform = 'scale(0.15)';
        });
      })(p, a, d, cx, cy);
    }
    setTimeout(function() { container.remove(); }, 2000);
  }

  function _lvExpandRing() {
    var barRect = _$lvBar.getBoundingClientRect();
    var cx = barRect.left + barRect.width / 2;
    var cy = barRect.top + barRect.height / 2;
    var r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (cx - 6) + 'px;top:' + (cy - 6) + 'px;width:12px;height:12px;border-radius:50%;border:2.5px solid #ffd700;pointer-events:none;z-index:99997;transition:all 0.9s cubic-bezier(0,0.45,0.12,1);opacity:0.9;box-shadow:0 0 6px #ffd700;';
    document.body.appendChild(r);
    requestAnimationFrame(function() {
      r.style.left = (cx - 50) + 'px'; r.style.top = (cy - 50) + 'px';
      r.style.width = '100px'; r.style.height = '100px';
      r.style.opacity = '0'; r.style.borderWidth = '0.8px';
    });
    setTimeout(function() { r.remove(); }, 1100);
  }

  // ★ 动画入口（每间 house 直接调用）
  function _lvAnimate(lvFloor, lvPct) {
    if (!_$lvBar) return;
    _$lvBar.style.display = 'inline-flex';
    if (_$lvLevel) _$lvLevel.textContent = 'Lv' + lvFloor;
    var isLevelUp = (_lvPrevFloor >= 0 && lvFloor > _lvPrevFloor);
    _lvPrevFloor = lvFloor;
    // ① 中层瞬移
    _lvSnapGlow(lvPct);
    // ② 顶层 rAF 追赶
    _lvChaseSolid(lvPct, isLevelUp);
    if (_$ldrBtn) _$ldrBtn.style.display = '';
    // ③ 升级特效：金色光晕 + 粒子爆发 + 光环扩散（暂注释，可能与别人重复）
    // if (isLevelUp) { _lvLevelUpGlow(); _lvBurstParticles(); _lvExpandRing(); }
  }

  // 服务器真理回调（仅登录/登出用——不触发动画）
  function _updateLvUI() {
    if (!_$lvBar) return;
    var d = _lvData;
    if (d && typeof d.level === 'number' && d.level >= 0) {
      _lvSyncFromServer();
      if (_$ldrBtn) _$ldrBtn.style.display = '';
    } else {
      _$lvBar.style.display = 'none';
      _lvAccWge = null;
      if (_$ldrBtn) _$ldrBtn.style.display = 'none';
    }
  }

  // ── 排行榜悬浮面板 ──

  function _ldrEnsurePanel() {
    if (_$ldrOverlay) return;
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var bg = isDark ? '#1e1e1e' : '#fdf6e3';
    var border = isDark ? '#333' : '#d3c6aa';
    var titleClr = isDark ? '#dcd8d0' : '#656360';

    _$ldrOverlay = document.createElement('div');
    _$ldrOverlay.className = 'qqq-ldr-overlay';
    _$ldrOverlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:9998;';
    _$ldrOverlay.addEventListener('click', function (e) { if (e.target === _$ldrOverlay) _ldrClose(); });

    _$ldrPanel = document.createElement('div');
    _$ldrPanel.className = 'qqq-ldr-panel';
    _$ldrPanel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:700px;max-width:94vw;max-height:80vh;overflow-y:auto;z-index:9999;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.35);background:' + bg + ';';
    _$ldrPanel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid ' + border + ';">' +
      '<span style="font-size:15px;font-weight:bold;color:' + titleClr + ';">🏆 排行榜</span>' +
      '<button id="qqq-ldr-close" style="width:22px;height:22px;border:1px solid ' + border + ';border-radius:3px;background:transparent;color:' + titleClr + ';font-size:13px;line-height:20px;text-align:center;cursor:pointer;">✕</button>' +
      '</div>' +
      '<div style="display:flex;min-height:300px;">' +
      '<div style="flex:1;padding:10px 12px;border-right:1px solid ' + border + ';">' +
      '<div style="font-size:13px;font-weight:bold;color:' + titleClr + ';margin-bottom:8px;">🏆 历史总排行</div>' +
      '<div id="qqq-ldr-left"></div></div>' +
      '<div style="flex:1;padding:10px 12px;">' +
      '<div style="font-size:13px;font-weight:bold;color:' + titleClr + ';margin-bottom:8px;">📅 上赛季排行</div>' +
      '<div id="qqq-ldr-right"></div></div>' +
      '</div>';
    _$ldrOverlay.appendChild(_$ldrPanel);
    document.body.appendChild(_$ldrOverlay);
    document.getElementById('qqq-ldr-close').addEventListener('click', _ldrClose);
  }

  function _ldrClose() {
    if (_$ldrOverlay) _$ldrOverlay.style.display = 'none';
  }

  function _ldrOpen() {
    if (_$ldrOverlay && _$ldrOverlay.style.display !== 'none') { _ldrClose(); return; }
    var token = _authData && _authData.token ? _authData.token : '';
    if (!token) return;

    _ldrEnsurePanel();
    var $left = document.getElementById('qqq-ldr-left');
    var $right = document.getElementById('qqq-ldr-right');
    var loading = '<div style="color:var(--text-dim,#888);padding:20px;text-align:center;">加载中...</div>';
    if ($left) $left.innerHTML = loading;
    if ($right) $right.innerHTML = loading;
    _$ldrOverlay.style.display = '';

    fetch(API_BASE + '/qqq/leaderboard', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        var build = function (list) {
          var s = '';
          for (var i = 0; i < list.length; i++) {
            var e = list[i];
            s += '<div style="display:flex;align-items:center;padding:5px 0;font-size:12px;gap:6px;">' +
              '<span style="width:24px;color:var(--text-dim,#888);text-align:right;">#' + e.rank + '</span>' +
              '<span style="width:18px;">' + e.flag + '</span>' +
              '<span style="flex:1;">' + e.phone + '</span>' +
              '<span style="min-width:40px;color:var(--text-dim,#888);text-align:right;">' + e.days_alive + 'd</span>' +
              '<span style="min-width:44px;color:#b58900;text-align:right;">' + e.total_ge + ' ge</span>' +
              '<span style="min-width:60px;color:#6c71c4;text-align:right;font-weight:bold;">Lv' + e.level_str + '</span>' +
              '</div>';
          }
          return s;
        };
        if ($left) $left.innerHTML = build(d.all_time);
        if ($right) $right.innerHTML = build(d.last_season);
      } else {
        if ($left) $left.innerHTML = '<div style="color:var(--text-dim,#888);padding:20px;text-align:center;">加载失败</div>';
      }
    }).catch(function () {
      if ($left) $left.innerHTML = '<div style="color:var(--text-dim,#888);padding:20px;text-align:center;">加载失败</div>';
    });
  }

  // ── 登录流程 ──
  // ★ 二次点击取消旧登录、打开新浏览器、新 sessionID，不给用户任何卡死机会
  async function _doLogin() {
    // ① 取消上一次登录（如果存在）：中断轮询 + 取消 push 监听
    if (_loginAbortCtrl) {
      try { _loginAbortCtrl.abort(); } catch (e) { }
      _loginAbortCtrl = null;
    }
    var myGen = ++_loginGen;        // 代际号，用于抑制过期 toast
    var ctrl = new AbortController();
    _loginAbortCtrl = ctrl;
    var signal = ctrl.signal;
    var pushDone = false, _unsubPush = null;
    try {
      var sessionId = _generateSessionId();
      var deviceName = _buildDeviceName();
      var loginUrl = LOGIN_URL + '?from=ide&session=' + sessionId +
        '&device_name=' + encodeURIComponent(deviceName) + '&goods=qqqide';

      try {
        if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.onAuthPush) {
          _unsubPush = window.qqqideBridge.auth.onAuthPush(function (data) {
            if (pushDone || !data || !data.token) return;
            pushDone = true;
            _setAuthData(data.token, data.phone || '', data.country_iso2 || '');
            _notifyStateChange();
          });
        }
      } catch (e) { }

      // ★ 每次点击都打开新浏览器（新 sessionID），绝不跳过
      try { window.qqqideBridge.shell.openExternal(loginUrl); }
      catch (e) { try { window.open(loginUrl, '_blank'); } catch (e2) { } }

      _updateLoginButtonState(true);

      var startTime = Date.now(), pollCount = 0;
      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        if (signal.aborted || pushDone) break;
        // ★ Abortable sleep：abort 时立即跳出
        await new Promise(function (r) {
          var t = setTimeout(r, POLL_INTERVAL_MS);
          var onAbort = function () { clearTimeout(t); r(); };
          signal.addEventListener('abort', onAbort, { once: true });
        });
        if (signal.aborted || pushDone) break;
        pollCount++;
        try {
          var resp = await _httpsGet('/gaea/qqqide/auth/poll?session=' + sessionId +
            '&device_name=' + encodeURIComponent(deviceName));
          if (resp && resp.ok && resp.token) {
            _setAuthData(resp.token, resp.phone || '', resp.country_iso2 || '');
            _notifyStateChange();
            pushDone = true;
            break;
          }
        } catch (e) {
          if (signal.aborted) break;
          if (pollCount % 10 === 0) console.warn('[login] poll #' + pollCount + ' error:', e.message);
        }
      }
      // ★ 被取消不算超时，返回标记让调用方跳过 toast
      return pushDone ? { token: _authData.token, phone: _authData.phone } : (signal.aborted ? { _cancelled: true } : null);
    } finally {
      if (_unsubPush) { try { _unsubPush(); } catch (e) { } }
      _loginAbortCtrl = null;
      _updateLoginButtonState(false);
    }
  }

  function _updateLoginButtonState(active) {
    if (!_$loginBtn) return;
    if (active) {
      _$loginBtn.textContent = '⏳';
      _$loginBtn.style.cursor = 'wait';
      _$loginBtn.style.opacity = '0.6';
      _$loginBtn.title = '登录中，点击重新打开浏览器';
    } else {
      _$loginBtn.textContent = '\uD83D\uDD12';
      _$loginBtn.style.cursor = '';
      _$loginBtn.style.opacity = '';
      _$loginBtn.title = '';
    }
  }

  function _notifyStateChange() {
    var loggedIn = !!(_authData && _authData.token);
    var phoneTail = loggedIn && _authData.phone ? _authData.phone.slice(-4) : '';
    _updateButtons(loggedIn, phoneTail);
    if (loggedIn) {
      _lvShow();            // ★ 立即显示 LV 区域 + 奖杯
      _startBalancePoll();
      _fetchLv();  // ★ 异步拉服务器基准，填入真实数据
      // 触发状态栏免费预算刷新
      try { if (typeof fetchFreeBudget === 'function') fetchFreeBudget(); } catch (e) { }
      try {
        if (window.qqqideBridge && window.qqqideBridge.cloud && window.qqqideBridge.cloud.setAuth) {
          window.qqqideBridge.cloud.setAuth({ phone: _authData.phone, token: _authData.token, device_name: _authData.device_name });
        }
      } catch (e) { }
    } else {
      _stopBalancePoll();
      _balanceGe = null;
      _lvData = null;
      _updateGeLabel();
      // ★ 登出：隐藏 LV 区域
      if (_$lvBar) _$lvBar.style.display = 'none';
      _lvAccWge = null;
      _lvAnim = null;
      if (_lvAnimFrame) { cancelAnimationFrame(_lvAnimFrame); _lvAnimFrame = null; }
      if (_$ldrBtn) _$ldrBtn.style.display = 'none';
      try {
        if (window.qqqideBridge && window.qqqideBridge.cloud && window.qqqideBridge.cloud.setAuth) {
          window.qqqideBridge.cloud.setAuth(null);
        }
      } catch (e) { }
    }
    for (var i = 0; i < _stateListeners.length; i++) {
      try { _stateListeners[i](loggedIn, phoneTail, _authData && _authData.phone); } catch (e) { }
    }
  }

  // ── 自定义即时 tooltip（零延迟）──
  var _$lvTip = null;
  function _lvShowTip(e) {
    if (!_$lvTip) {
      _$lvTip = document.createElement('div');
      _$lvTip.className = 'qqq-lv-tip';
      _$lvTip.style.cssText = 'position:fixed;z-index:99999;padding:4px 10px;font-size:32px;color:#fbe9bc;font-family:Consolas,monospace;background:rgba(0,0,0,0.88);border:1px solid #444;border-radius:3px;pointer-events:none;white-space:nowrap;display:none;font-weight:300;';
      document.body.appendChild(_$lvTip);
    }
    if (!_$lvBar || !_$lvBar.style.display || _$lvBar.style.display === 'none') return;
    var d = _lvData;
    if (!d) return;
    var rect = _$lvBar.getBoundingClientRect();
    var sh = (d.season_short || '?');
    var m = sh.match(/^(\([^)]+\))\s+(.+)$/);
    if (m) {
      _$lvTip.innerHTML = '<span style="color:#fbe9bc">' + m[1] + '</span> <b style="color:#fbe9bc">' + m[2] + ':</b><span style="color:#fbe9bc;font-size:44px">' + (d.total_consumed_ge || '0') + '</span>';
    } else {
      _$lvTip.innerHTML = '<b style="color:#fbe9bc">' + sh + ':</b><span style="color:#fbe9bc;font-size:44px">' + (d.total_consumed_ge || '0') + '</span>';
    }
    var cx = e && e.clientX ? e.clientX : rect.left + rect.width / 2;
    _$lvTip.style.left = (cx - _$lvTip.offsetWidth / 2) + 'px';
    _$lvTip.style.top = (rect.bottom + 4) + 'px';
    _$lvTip.style.display = '';
  }
  function _lvHideTip() { if (_$lvTip) _$lvTip.style.display = 'none'; }

  // ── 按钮注入 ──
  function _injectLoginButton() {
    if (_$loginBtn || _$phoneBtn) return;
    // ★ 锚点：优先 settings 齿轮（保持顺序：[login注入]→[齿轮]→[灯泡]）
    var $settingsBtn = document.querySelector('.qqq-settings-btn');
    var $bulbs = document.getElementById('qqq-bulbs');
    var $parent, $refNode;
    if ($settingsBtn) { $parent = $settingsBtn.parentNode; $refNode = $settingsBtn; }
    else if ($bulbs) { $parent = $bulbs.parentNode; $refNode = $bulbs; }
    else { return; }

    // 排行榜按钮 🏆
    _$ldrBtn = document.createElement('button');
    _$ldrBtn.className = 'qqq-ldr-btn';
    _$ldrBtn.textContent = '\uD83C\uDFC6';
    _$ldrBtn.style.cssText = NO_DRAG + 'font-size:14px;background:transparent;border:none;border-radius:4px;color:var(--text-secondary,#999);cursor:pointer;padding:0;margin:0 -5px 0 0;display:none;line-height:1;vertical-align:middle;';
    _$ldrBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); _ldrOpen(); });

    // LV 经验条
    _$lvBar = document.createElement('span');
    _$lvBar.className = 'qqq-lv-bar';
    _$lvBar.style.cssText = NO_DRAG + 'display:none;align-items:center;margin-right:12px;gap:3px;font-size:11px;white-space:nowrap;position:relative;'; _$lvBar.addEventListener('mouseenter', _lvShowTip);
    _$lvBar.addEventListener('mousemove', _lvShowTip);
    _$lvBar.addEventListener('mouseleave', _lvHideTip);
    _$lvLevel = document.createElement('span');
    _$lvLevel.className = 'qqq-lv-level';
    _$lvLevel.style.cssText = 'color:var(--text-primary,#e8e8e8);font-weight:bold;font-variant-numeric:tabular-nums;min-width:44px;text-align:right;';

    var $lvTrack = document.createElement('span');
    $lvTrack.className = 'qqq-lv-track';
    $lvTrack.style.cssText = 'display:inline-block;position:relative;width:60px;height:12px;background:var(--bg-tertiary,#555);overflow:hidden;border-radius:1px;';

    // 中层：象牙白 #ffffdd 真理信标，瞬间更新，z-index:1
    _$lvGlow = document.createElement('span');
    _$lvGlow.className = 'qqq-lv-glow';
    _$lvGlow.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:0%;background:#ffffdd;z-index:1;';

    // 顶层：停止时 #c4b187，追赶时 #8a6410，z-index:2
    _$lvSolid = document.createElement('span');
    _$lvSolid.className = 'qqq-lv-solid';
    _$lvSolid.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:0%;background:#c4b187;z-index:2;';
    $lvTrack.appendChild(_$lvGlow);
    $lvTrack.appendChild(_$lvSolid);
    _$lvBar.appendChild(_$lvLevel);
    _$lvBar.appendChild($lvTrack);

    // GE 余额
    _$geLabel = document.createElement('span');
    _$geLabel.className = 'qqq-ge-label';
    _$geLabel.style.cssText = NO_DRAG + 'font-size:12px;font-weight:bold;color:var(--text-primary);margin-right:6px;display:none;align-self:center;font-variant-numeric:tabular-nums;white-space:nowrap;';

    // 登录按钮
    _$loginBtn = document.createElement('button');
    _$loginBtn.className = 'qqq-login-btn';
    _$loginBtn.textContent = '\uD83D\uDD12';
    _$loginBtn.style.cssText = NO_DRAG + 'border:1px solid var(--border-color,#444);border-radius:4px;background:transparent;color:var(--text-secondary,#999);cursor:pointer;padding:1px 6px;font-size:13px;';
    _$loginBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var expectedGen = _loginGen + 1;  // 快照：本轮期望的代际号
      _doLogin().then(function (result) {
        // ★ 本代已过期（被新点击替代）→ 静默忽略，不弹 toast
        if (_loginGen !== expectedGen) return;
        // ★ 被取消 → 不弹 toast（新登录已接管）
        if (result && result._cancelled) return;
        if (!result && window.qqqideQoast) window.qqqideQoast.show('登录超时，请重试', { duration: 5000 });
      }).catch(function (err) { console.error('[login] error:', err); });
    });

    // 手机号按钮
    _$phoneBtn = document.createElement('button');
    _$phoneBtn.className = 'qqq-login-btn qqq-phone-btn';
    _$phoneBtn.title = '已登录 — 点击打开菜单';
    _$phoneBtn.style.cssText = NO_DRAG + 'display:none;position:relative;';
    _$phoneBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var ex = document.querySelector('.qqq-phone-dropdown');
      if (ex) { ex.remove(); return; }
      var dd = document.createElement('div');
      dd.className = 'qqq-phone-dropdown';
      // 零空气：padding:0，border-radius 只右上角，虚线边框
      dd.style.cssText = 'position:absolute;top:calc(100% + 2px);right:0;background:var(--background-color);border:2px dashed var(--border-color);border-radius:0 8px 6px 6px;box-shadow:0 6px 20px rgba(0,0,0,0.15);z-index:99999;min-width:120px;padding:0;overflow:hidden;';
      // ge 流水
      var flow = document.createElement('a');
      flow.textContent = 'ge 流水';
      flow.href = 'https://gh555.com/viewer/geflow';
      flow.target = '_blank';
      flow.style.cssText = 'display:block;height:32px;line-height:32px;padding:0 16px;cursor:pointer;font-size:13px;color:var(--text-primary);white-space:nowrap;text-decoration:none;';
      flow.addEventListener('mouseenter', function () { flow.style.background = 'var(--gold-hover-bg)'; });
      flow.addEventListener('mouseleave', function () { flow.style.background = ''; });
      flow.addEventListener('click', function () { dd.remove(); });
      dd.appendChild(flow);
      // 退出登录（零间隙，无分隔线）
      var logout = document.createElement('div');
      logout.textContent = '退出登录';
      logout.style.cssText = 'display:block;height:32px;line-height:32px;padding:0 16px;cursor:pointer;font-size:13px;color:var(--red);white-space:nowrap;';
      logout.addEventListener('mouseenter', function () { logout.style.background = 'var(--gold-hover-bg)'; });
      logout.addEventListener('mouseleave', function () { logout.style.background = ''; });
      logout.addEventListener('click', function (ev) { ev.stopPropagation(); dd.remove(); api.logout(); });
      dd.appendChild(logout);
      _$phoneBtn.appendChild(dd);
      // mousedown capture：点击外部立即关闭
      var closer = function (ev2) {
        if (!dd.contains(ev2.target) && ev2.target !== _$phoneBtn) {
          dd.remove();
          document.removeEventListener('mousedown', closer, true);
        }
      };
      requestAnimationFrame(function () {
        document.addEventListener('mousedown', closer, true);
      });
    });

    // 插入: [🏆] [LV] [GE] [手机号] [登录] → refNode
    $parent.insertBefore(_$ldrBtn, $refNode);
    $parent.insertBefore(_$lvBar, $refNode);
    $parent.insertBefore(_$geLabel, $refNode);
    $parent.insertBefore(_$phoneBtn, $refNode);
    $parent.insertBefore(_$loginBtn, $refNode);
  }

  function _updateButtons(isLoggedIn, phoneTail) {
    if (_$loginBtn) _$loginBtn.style.display = isLoggedIn ? 'none' : '';
    if (_$phoneBtn) {
      if (isLoggedIn && phoneTail) {
        var cc = (_authData && _authData.countryIso2) ? _authData.countryIso2.toLowerCase() : '';
        // ★ 先设文字（无国旗），等 CSS 加载完再补国旗
        _$phoneBtn.textContent = phoneTail;
        _$phoneBtn.style.display = 'inline-flex';
        _loadFlagCss().then(function (ok) {
          if (ok && cc && _$phoneBtn) {
            _$phoneBtn.innerHTML = '<span class="fi fi-' + cc + '" style="margin-right:5px;vertical-align:middle;"></span>' + phoneTail;
          } else if (!cc && _$phoneBtn) {
            _$phoneBtn.textContent = phoneTail;
          }
        });
      } else {
        _$phoneBtn.style.display = 'none';
      }
    }
    _updateGeLabel();
    // ★ LV 区全权由 _fetchLv（REST）或 _lvAnimate（billing）管理显示/隐藏
    // _updateButtons 不再干预，避免竞态遮盖
  }

  // ── 公开 API ──
  var api = {
    init: function () {
      if (_initDone) return;
      _initDone = true;
      _setupLvListener();     // ★ 注册 billing 事件 → LV 拉取监听
      _injectLoginButton(); // ★ 无条件注入 DOM，不受 bootInfo/bridge 影响
      _ensureBootInfo().then(function () {
        _restoreAuth().then(function () { _notifyStateChange(); });
      }).catch(function () {
        _restoreAuth().then(function () { _notifyStateChange(); });
      });
    },
    isLoggedIn: function () { return !!(_authData && _authData.token); },
    getAuthToken: function () { return (_authData && _authData.token) ? _authData.token : ''; },
    getPhone: function () { return (_authData && _authData.phone) ? _authData.phone : ''; },
    getPhoneTail: function () { var p = api.getPhone(); return p ? p.slice(-4) : ''; },
    getCountryIso2: function () { return (_authData && _authData.countryIso2) ? _authData.countryIso2 : ''; },
    getBalanceGe: function () { return _balanceGe; },
    getLvData: function () { return _lvData; },
    login: function () { return _doLogin().then(function (r) { return (r && r._cancelled) ? null : r; }); },
    logout: function () {
      _clearAuthData();
      _notifyStateChange();
      try { if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.clearAuth) window.qqqideBridge.auth.clearAuth(); } catch (e) { }
      if (window.qqqideQoast) window.qqqideQoast.show('已退出登录', { duration: 3000 });
    },
    onStateChange: function (fn) {
      _stateListeners.push(fn);
      return function () { var i = _stateListeners.indexOf(fn); if (i >= 0) _stateListeners.splice(i, 1); };
    }
  };

  window.qqqLogin = api;
  setTimeout(function () { api.init(); }, 200);
})();
