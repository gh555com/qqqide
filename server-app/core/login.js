// ============================================================================
// login.js — 登录模块
// 注入: 排行榜🏆 / LV经验条 / GE余额 / 手机号 / 登录按钮 → 菜单行2
// ============================================================================

(function () {
  'use strict';

  var _authData = null;
  var _initDone = false;
  var _polling = false;
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
  var _lvTimer = null;
  var _$ldrOverlay = null;
  var _$ldrPanel = null;

  var API_BASE = 'https://gh555.com/api';
  var LOGIN_URL = 'https://gh555.com/login';
  var POLL_INTERVAL_MS = 3000;
  var POLL_TIMEOUT_MS = 600000;
  var BALANCE_POLL_MS = 60000;
  var LV_POLL_MS = 10000;
  var NO_DRAG = '-webkit-app-region:no-drag;';

  var _bootInfo = null;

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

  function _setAuthData(token, phone) {
    _authData = { token: token, phone: phone, device_name: _buildDeviceName(), ts: Date.now() };
    _persistAuthAsync();
  }

  function _clearAuthData() { _authData = null; }

  function _persistAuthAsync() {
    if (!_authData) return;
    try {
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.saveAuth) {
        window.qqqideBridge.auth.saveAuth({ token: _authData.token, phone: _authData.phone, device_name: _authData.device_name });
      }
    } catch (e) {}
  }

  async function _restoreAuth() {
    if (_authData && _authData.token) return;
    try {
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.loadAuth) {
        var saved = await window.qqqideBridge.auth.loadAuth();
        if (saved && saved.token && saved.phone) { _authData = saved; _authData.ts = Date.now(); }
      }
    } catch (e) {}
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
    } catch (e) {}
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

  // ── LV ──
  function _startLvPoll() {
    _stopLvPoll();
    _fetchLv(true);
    _lvTimer = setInterval(function () { _fetchLv(false); }, LV_POLL_MS);
  }

  function _stopLvPoll() {
    if (_lvTimer) { clearInterval(_lvTimer); _lvTimer = null; }
  }

  async function _fetchLv(force) {
    if (!_authData || !_authData.token) return;
    var now = Date.now();
    if (!force && now - _lvLastFetch < LV_POLL_MS) return;
    _lvLastFetch = now;
    try {
      var resp = await fetch(API_BASE + '/qqq/lv', {
        headers: { 'Authorization': 'Bearer ' + _authData.token }
      });
      var data = await resp.json();
      if (data && data.ok) { _lvData = data; _updateLvUI(); }
    } catch (e) { console.warn('[login] lv fetch error:', e.message); }
  }

  // ═══ LV 3 层动画引擎 ═══
  var _$lvGlow = null;
  var _$lvSolid = null;
  var _lvLastGe = '';
  var _lvPrevFloor = -1;

  function _lvGust() {
    var t = _$lvBar && _$lvBar.querySelector('.qqq-lv-track');
    if (!t) return;
    t.style.boxShadow = 'inset 0 0 12px 3px #b58900';
    t.style.filter = 'brightness(1.4)';
    setTimeout(function () { t.style.boxShadow = ''; t.style.filter = ''; }, 500);
  }

  function _lvUpdateGlow(pct) {
    if (!_$lvGlow) return;
    _$lvGlow.style.transition = 'none';
    _$lvGlow.style.width = pct + '%';
  }

  function _lvChaseSolid(targetPct, isLevelUp) {
    if (!_$lvSolid) return;
    _lvClearSolidTimer();
    if (isLevelUp) {
      // 升级：闪电填满 → 庆祝 → 复位
      _$lvSolid.style.transition = 'width 0.25s ease-out';
      _$lvSolid.style.width = '100%';
      _lvSolidTimer(300, function () {
        _$lvSolid.style.transition = 'none';
        _$lvSolid.style.width = '0%';
        _lvSolidTimer(100, function () {
          _$lvSolid.style.transition = 'width 10s linear';
          _$lvSolid.style.width = targetPct + '%';
        });
      });
    } else {
      _$lvSolid.style.transition = 'width 10s linear';
      _$lvSolid.style.width = targetPct + '%';
    }
  }

  var _lvSolidTimerId = null;
  function _lvSolidTimer(ms, fn) {
    _lvSolidTimerId = setTimeout(function () { _lvSolidTimerId = null; fn(); }, ms);
  }
  function _lvClearSolidTimer() {
    if (_lvSolidTimerId) { clearTimeout(_lvSolidTimerId); _lvSolidTimerId = null; }
  }

  function _updateLvUI() {
    if (!_$lvBar) return;
    var d = _lvData;
    if (d && typeof d.level === 'number' && d.level >= 0) {
      _$lvBar.style.display = 'inline-flex';
      var newFloor = d.level_floor != null ? d.level_floor : 0;
      var newPct = Math.min(d.progress_pct || 0, 100);
      var newGe = d.total_consumed_ge || '';
      if (_$lvLevel) _$lvLevel.textContent = 'Lv' + newFloor;
      if (!newGe || newGe === _lvLastGe) return;
      _lvLastGe = newGe;
      var isLevelUp = (_lvPrevFloor >= 0 && newFloor > _lvPrevFloor);
      _lvPrevFloor = newFloor;
      _lvGust();
      _lvUpdateGlow(newPct);
      _lvChaseSolid(newPct, isLevelUp);
      if (_$ldrBtn) _$ldrBtn.style.display = '';
    } else {
      _$lvBar.style.display = 'none';
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
  async function _doLogin() {
    if (_polling) return null;
    _polling = true;
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
            _setAuthData(data.token, data.phone || '');
            _notifyStateChange();
          });
        }
      } catch (e) {}

      try { window.qqqideBridge.shell.openExternal(loginUrl); }
      catch (e) { try { window.open(loginUrl, '_blank'); } catch (e2) {} }

      var startTime = Date.now(), pollCount = 0;
      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        if (pushDone) break;
        await new Promise(function (r) { setTimeout(r, POLL_INTERVAL_MS); });
        pollCount++;
        try {
          var resp = await _httpsGet('/gaea/qqqide/auth/poll?session=' + sessionId +
            '&device_name=' + encodeURIComponent(deviceName));
          if (resp && resp.ok && resp.token) {
            _setAuthData(resp.token, resp.phone || '');
            _notifyStateChange();
            pushDone = true;
            break;
          }
        } catch (e) {
          if (pollCount % 10 === 0) console.warn('[login] poll #' + pollCount + ' error:', e.message);
        }
      }
      return pushDone ? { token: _authData.token, phone: _authData.phone } : null;
    } finally {
      if (_unsubPush) { try { _unsubPush(); } catch (e) {} }
      _polling = false;
    }
  }

  function _notifyStateChange() {
    var loggedIn = !!(_authData && _authData.token);
    var phoneTail = loggedIn && _authData.phone ? _authData.phone.slice(-4) : '';
    _updateButtons(loggedIn, phoneTail);
    if (loggedIn) {
      _startBalancePoll();
      _startLvPoll();
      // 触发状态栏免费预算刷新
      try { if (typeof fetchFreeBudget === 'function') fetchFreeBudget(); } catch (e) {}
      try {
        if (window.qqqideBridge && window.qqqideBridge.cloud && window.qqqideBridge.cloud.setAuth) {
          window.qqqideBridge.cloud.setAuth({ phone: _authData.phone, token: _authData.token, device_name: _authData.device_name });
        }
      } catch (e) {}
    } else {
      _stopBalancePoll();
      _stopLvPoll();
      _balanceGe = null;
      _lvData = null;
      _updateGeLabel();
      _updateLvUI();
      try {
        if (window.qqqideBridge && window.qqqideBridge.cloud && window.qqqideBridge.cloud.setAuth) {
          window.qqqideBridge.cloud.setAuth(null);
        }
      } catch (e) {}
    }
    for (var i = 0; i < _stateListeners.length; i++) {
      try { _stateListeners[i](loggedIn, phoneTail, _authData && _authData.phone); } catch (e) {}
    }
  }

  // ── 自定义即时 tooltip（零延迟）──
  var _$lvTip = null;
  function _lvShowTip(e) {
    if (!_$lvTip) {
      _$lvTip = document.createElement('div');
      _$lvTip.className = 'qqq-lv-tip';
      _$lvTip.style.cssText = 'position:fixed;z-index:99999;padding:4px 10px;font-size:32px;color:#93a1a1;background:rgba(0,0,0,0.88);border:1px solid #444;border-radius:3px;pointer-events:none;white-space:nowrap;display:none;font-weight:300;';
      document.body.appendChild(_$lvTip);
    }
    if (!_$lvBar || !_$lvBar.style.display || _$lvBar.style.display === 'none') return;
    var d = _lvData;
    if (!d) return;
    var rect = _$lvBar.getBoundingClientRect();
    var sh = (d.season_short || '?');
    var m = sh.match(/^(\([^)]+\))\s+(.+)$/);
    if (m) {
      _$lvTip.innerHTML = '<span>' + m[1] + '</span> <b>' + m[2] + ':</b><span style="color:#b58900;font-size:44px">' + (d.total_consumed_ge || '0') + '</span>';
    } else {
      _$lvTip.innerHTML = '<b>' + sh + ':</b><span style="color:#b58900;font-size:44px">' + (d.total_consumed_ge || '0') + '</span>';
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
      _$lvBar.style.cssText = NO_DRAG + 'display:none;align-items:center;margin-right:12px;gap:3px;font-size:11px;white-space:nowrap;position:relative;';    _$lvBar.addEventListener('mouseenter', _lvShowTip);
    _$lvBar.addEventListener('mousemove', _lvShowTip);
    _$lvBar.addEventListener('mouseleave', _lvHideTip);
    _$lvLevel = document.createElement('span');
    _$lvLevel.className = 'qqq-lv-level';
    _$lvLevel.style.cssText = 'color:var(--text-primary,#e8e8e8);font-weight:bold;font-variant-numeric:tabular-nums;min-width:44px;text-align:right;';

    var $lvTrack = document.createElement('span');
    $lvTrack.className = 'qqq-lv-track';
    $lvTrack.style.cssText = 'display:inline-block;position:relative;width:60px;height:12px;background:var(--bg-tertiary,#555);overflow:hidden;border-radius:1px;';

    // 中间层：高光黄色，瞬间更新
    _$lvGlow = document.createElement('span');
    _$lvGlow.className = 'qqq-lv-glow';
    _$lvGlow.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:0%;background:#b58900;box-shadow:0 0 6px 1px #b58900;z-index:1;';

    // 顶层：#aa8d00，慢追
    _$lvSolid = document.createElement('span');
    _$lvSolid.className = 'qqq-lv-solid';
    _$lvSolid.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:0%;background:#aa8d00;z-index:2;';

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
      _doLogin().then(function (result) {
        if (!result && window.qqqideQoast) window.qqqideQoast.show('登录超时，请重试', { duration: 5000 });
      }).catch(function (err) { console.error('[login] error:', err); });
    });

    // 手机号按钮
    _$phoneBtn = document.createElement('button');
    _$phoneBtn.className = 'qqq-login-btn qqq-phone-btn';
    _$phoneBtn.title = '已登录 — 点击打开菜单';
    _$phoneBtn.style.cssText = NO_DRAG + 'display:none;';
    _$phoneBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var ex = document.querySelector('.qqq-phone-dropdown');
      if (ex) { ex.remove(); return; }
      var dd = document.createElement('div');
      dd.className = 'qqq-phone-dropdown';
      dd.style.cssText = 'position:absolute;top:100%;right:0;margin-top:4px;background:var(--bg-secondary,#252525);border:1px solid var(--border-color,#444);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:99999;min-width:120px;padding:4px 0;';
      var li = document.createElement('div');
      li.className = 'qqq-phone-dropdown-item';
      li.textContent = '退出登录';
      li.style.cssText = 'padding:8px 16px;cursor:pointer;font-size:13px;color:var(--text-primary,#e8e8e8);white-space:nowrap;transition:background .15s;';
      li.addEventListener('mouseenter', function () { li.style.background = 'var(--hover-bg,#333)'; });
      li.addEventListener('mouseleave', function () { li.style.background = ''; });
      li.addEventListener('click', function (ev) { ev.stopPropagation(); dd.remove(); api.logout(); });
      dd.appendChild(li);
      _$phoneBtn.style.position = 'relative';
      _$phoneBtn.appendChild(dd);
      setTimeout(function () {
        var closer = function (ev2) {
          if (!dd.contains(ev2.target) && ev2.target !== _$phoneBtn) { dd.remove(); document.removeEventListener('click', closer); }
        };
        document.addEventListener('click', closer);
      }, 0);
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
        _$phoneBtn.textContent = phoneTail;
        _$phoneBtn.style.display = 'inline-flex';
      } else {
        _$phoneBtn.style.display = 'none';
      }
    }
    _updateGeLabel();
    _updateLvUI();
  }

  // ── 公开 API ──
  var api = {
    init: function () {
      if (_initDone) return;
      _initDone = true;
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
    getBalanceGe: function () { return _balanceGe; },
    getLvData: function () { return _lvData; },
    login: function () { return _doLogin(); },
    logout: function () {
      _clearAuthData();
      _notifyStateChange();
      try { if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.clearAuth) window.qqqideBridge.auth.clearAuth(); } catch (e) {}
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
