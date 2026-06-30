// ============================================================================
// login.js — 登录模块
//
// 入口：window.qqqLogin.init() — 自动注入登录按钮/GE余额/LV经验条/排行榜到菜单行2
//
// API：
//   window.qqqLogin.isLoggedIn()      — 是否已登录
//   window.qqqLogin.getPhone()        — 获取手机号
//   window.qqqLogin.getPhoneTail()    — 获取手机尾号（如 "8204"）
//   window.qqqLogin.getAuthToken()    — 获取 JWT token（AI 调用用）
//   window.qqqLogin.login()           — 触发登录流程
//   window.qqqLogin.logout()          — 退出登录
//   window.qqqLogin.onStateChange(fn) — 监听登录态变更
//   window.qqqLogin.getLvData()       — 获取当前 LV 数据
//
// 铁律：
//   · token 仅存内存，不写磁盘（零残留、零复活）
//   · 颜色走 §3 配色机器
//   · 不触碰 cursor（§19）
// ============================================================================

(function () {
  'use strict';

  // ── 状态 ──
  var _authData = null;        // { token, phone, device_name, ts }
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
  var _lvData = null;          // { level, levelStr, levelFloor, nextLevelGe, progressPct, seasonBonus, seasonId }
  var _lvLastFetch = 0;
  var _lvTimer = null;

  // ── 常量 ──
  var API_BASE = 'https://gh555.com/api';
  var LOGIN_URL = 'https://gh555.com/login';
  var POLL_INTERVAL_MS = 3000;
  var POLL_TIMEOUT_MS = 600000; // 10 分钟
  var BALANCE_POLL_MS = 60000;  // 每分钟刷新余额
  var LV_POLL_MS = 30000;       // 每 30s 刷新 LV

  // ── 启动信息缓存 ──
  var _bootInfo = null;

  function _buildDeviceName() {
    var info = _bootInfo;
    var ide = 'qqqide';
    var plat = 'Win';
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
    for (var i = 0; i < arr.length; i++) {
      hex += arr[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function _setAuthData(token, phone) {
    _authData = { token: token, phone: phone, device_name: _buildDeviceName(), ts: Date.now() };
    _persistAuthAsync();
  }

  function _clearAuthData() {
    _authData = null;
  }

  function _persistAuthAsync() {
    if (!_authData) return;
    try {
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.saveAuth) {
        window.qqqideBridge.auth.saveAuth({
          token: _authData.token,
          phone: _authData.phone,
          device_name: _authData.device_name
        });
      }
    } catch (e) { /* ignore */ }
  }

  async function _restoreAuth() {
    if (_authData && _authData.token) return;
    try {
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.loadAuth) {
        var saved = await window.qqqideBridge.auth.loadAuth();
        if (saved && saved.token && saved.phone) {
          _authData = saved;
          _authData.ts = Date.now();
          console.log('[login] restored auth from storage, phone=***' + saved.phone.slice(-4));
        }
      }
    } catch (e) { /* ignore */ }
  }

  async function _httpsGet(urlPath) {
    var url = API_BASE + urlPath;
    var resp = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  async function _ensureBootInfo() {
    if (_bootInfo) return _bootInfo;
    try {
      if (window.qqqideBridge && window.qqqideBridge.boot && window.qqqideBridge.boot.getInfo) {
        _bootInfo = await window.qqqideBridge.boot.getInfo();
      }
    } catch (e) { /* ignore */ }
    return _bootInfo;
  }

  // ── GE 余额拉取 ──
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
      var resp = await fetch('https://direct.gh555.com:8444/api/wallet/balance', {
        headers: { 'Authorization': 'Bearer ' + _authData.token }
      });
      var data = await resp.json();
      if (data && data.ok && typeof data.balance !== 'undefined') {
        _balanceGe = data.balance; // ★ 服务端已做银行家四舍五入
        _updateGeLabel();
      } else {
        console.warn('[login] balance fetch unexpected response:', JSON.stringify(data).slice(0, 200));
      }
    } catch (e) { console.warn('[login] balance fetch error:', e.message); }
  }

  function _updateGeLabel() {
    if (_$geLabel) {
      if (_balanceGe !== null && _balanceGe !== undefined) {
        _$geLabel.textContent = _balanceGe + ' ge';
        _$geLabel.style.display = '';
      } else {
        _$geLabel.style.display = 'none';
      }
    }
  }

  // ── LV 拉取 ──
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
      if (data && data.ok) {
        _lvData = data;
        _updateLvUI();
      }
    } catch (e) { console.warn('[login] lv fetch error:', e.message); }
  }

  function _updateLvUI() {
    if (!_$lvBar) return;
    var d = _lvData;
    if (d && d.level >= 0) {
      _$lvBar.style.display = '';
      if (_$lvLevel) _$lvLevel.textContent = 'Lv' + d.levelStr;
      if (_$lvProgress) _$lvProgress.style.width = Math.min(d.progressPct || 0, 100) + '%';
      if (_$ldrBtn) _$ldrBtn.style.display = '';
    } else {
      _$lvBar.style.display = 'none';
      if (_$ldrBtn) _$ldrBtn.style.display = 'none';
    }
  }

  // ── 排行榜窗口 ──
  function _openLeaderboard() {
    // 构建排行榜 HTML 页面，通过 data URL 或新建 BrowserWindow
    var token = _authData && _authData.token ? _authData.token : '';
    if (!token) return;

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>排行榜</title>' +
      '<style>body{margin:0;font-family:system-ui,sans-serif;background:#1a1a1a;color:#e8e8e8;}' +
      '.container{display:flex;height:100vh;}.col{flex:1;padding:16px;overflow-y:auto;}' +
      '.col+.col{border-left:1px solid #333;}' +
      'h2{font-size:15px;margin:0 0 12px;color:#999;}' +
      '.row{display:flex;align-items:center;padding:6px 0;font-size:13px;gap:8px;}' +
      '.rank{width:28px;color:#888;text-align:right;}.phone{flex:1;}.lv{color:#6c71c4;min-width:60px;text-align:right;}' +
      '.ge{color:#b58900;min-width:50px;text-align:right;}.days{color:#586e75;min-width:50px;text-align:right;}' +
      '.flag{width:20px;}' +
      '.err{color:#dc322f;padding:20px;}' +
      '</style></head><body>' +
      '<div class="container">' +
      '<div class="col" id="allTime"><h2>🏆 历史总排行</h2><div class="err">加载中...</div></div>' +
      '<div class="col" id="lastSeason"><h2>📅 上赛季排行</h2><div class="err">加载中...</div></div>' +
      '</div>' +
      '<script>' +
      'var t="' + token + '";' +
      'function render(el,list){el.innerHTML=list.map(function(e){return \'<div class="row"><span class="rank">#\'+e.rank+\'</span><span class="flag">\'+e.flag+\'</span><span class="phone">\'+e.phone+\'</span><span class="days">\'+e.days_alive+\'d</span><span class="ge">\'+e.total_ge+\' ge</span><span class="lv">Lv\'+e.level_str+\'</span></div>\';}).join("");}' +
      'fetch("https://gh555.com/api/qqq/leaderboard",{headers:{"Authorization":"Bearer "+t}})' +
      '.then(function(r){return r.json();}).then(function(d){' +
      'if(d.ok){render(document.getElementById("allTime"),d.all_time);' +
      'render(document.getElementById("lastSeason"),d.last_season);' +
      '}else{document.getElementById("allTime").innerHTML=\'<div class="err">加载失败</div>\';}' +
      '}).catch(function(){' +
      'document.getElementById("allTime").innerHTML=\'<div class="err">加载失败</div>\';' +
      '});' +
      '<\/script></body></html>';

    // 用 Electron BrowserWindow 打开
    try {
      if (window.qqqideBridge && window.qqqideBridge.shell && window.qqqideBridge.shell.loadHtml) {
        window.qqqideBridge.shell.loadHtml(html, '排行榜 - qqq IDE');
      } else {
        // Fallback: data URL
        var url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
        window.open(url, '_blank', 'width=700,height=500');
      }
    } catch (e) {
      var url2 = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
      window.open(url2, '_blank', 'width=700,height=500');
    }
  }

  // ── 登录流程 ──
  async function _doLogin() {
    if (_polling) return null;
    _polling = true;

    var pushDone = false;
    var _unsubPush = null;

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
            console.log('[login] token pushed from browser, phone=' + (data.phone || '?'));
            _setAuthData(data.token, data.phone || '');
            _notifyStateChange();
          });
        }
      } catch (e) { /* auth push not available */ }

      try {
        window.qqqideBridge.shell.openExternal(loginUrl);
      } catch (e) {
        try { window.open(loginUrl, '_blank'); } catch (e2) { /* ignore */ }
      }

      var startTime = Date.now();
      var pollCount = 0;
      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        if (pushDone) { console.log('[login] push already got token, stop polling'); break; }
        await new Promise(function (r) { setTimeout(r, POLL_INTERVAL_MS); });
        pollCount++;
        try {
          var resp = await _httpsGet('/gaea/qqqide/auth/poll?session=' + sessionId +
            '&device_name=' + encodeURIComponent(deviceName));
          if (resp && resp.ok && resp.token) {
            console.log('[login] poll #' + pollCount + ' got token');
            _setAuthData(resp.token, resp.phone || '');
            _notifyStateChange();
            pushDone = true;
            break;
          }
          if (pollCount % 10 === 0) {
            console.log('[login] poll #' + pollCount + ': waiting...');
          }
        } catch (e) {
          console.warn('[login] poll #' + pollCount + ' error:', e.message);
        }
      }

      if (pushDone) return { token: _authData.token, phone: _authData.phone };
      return null;
    } finally {
      if (_unsubPush) { try { _unsubPush(); } catch (e) { /* ignore */ } }
      _polling = false;
    }
  }

  function _notifyStateChange() {
    var isLoggedIn = !!(_authData && _authData.token);
    var phoneTail = isLoggedIn && _authData.phone ? _authData.phone.slice(-4) : '';
    _updateButtons(isLoggedIn, phoneTail);
    if (isLoggedIn) {
      _startBalancePoll();
      _startLvPoll();
      try {
        if (window.qqqideBridge && window.qqqideBridge.cloud && window.qqqideBridge.cloud.setAuth) {
          window.qqqideBridge.cloud.setAuth({
            phone: _authData.phone,
            token: _authData.token,
            device_name: _authData.device_name
          });
        }
      } catch (e) { /* ignore */ }
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
      } catch (e) { /* ignore */ }
    }
    for (var i = 0; i < _stateListeners.length; i++) {
      try { _stateListeners[i](isLoggedIn, phoneTail, _authData && _authData.phone); } catch (e) { /* ignore */ }
    }
  }

  // ── 按钮注入 ──
  function _injectLoginButton() {
    if (_$loginBtn || _$phoneBtn) return;

    var $settingsBtn = document.querySelector('.qqq-settings-btn');
    var $bulbs = document.getElementById('qqq-bulbs');

    var $parent;
    var $refNode;
    if ($settingsBtn) {
      $parent = $settingsBtn.parentNode;
      $refNode = $settingsBtn;
    } else if ($bulbs) {
      $parent = $bulbs.parentNode;
      $refNode = $bulbs;
    } else {
      return;
    }

    // ── 排行榜按钮（LV bar 左边） ──
    _$ldrBtn = document.createElement('button');
    _$ldrBtn.className = 'qqq-ldr-btn';
    _$ldrBtn.setAttribute('data-i18n-title', 'lv.leaderboard');
    _$ldrBtn.title = '排行榜';
    _$ldrBtn.textContent = '🏆';
    _$ldrBtn.style.cssText = 'font-size:14px;background:transparent;border:1px solid var(--border-color,#444);border-radius:4px;color:var(--text-secondary,#999);cursor:pointer;padding:1px 5px;margin-right:4px;display:none;line-height:1.2;';
    _$ldrBtn.addEventListener('click', function (e) {
      e.preventDefault();
      _openLeaderboard();
    });

    // ── LV 经验条容器 ──
    _$lvBar = document.createElement('span');
    _$lvBar.className = 'qqq-lv-bar';
    _$lvBar.style.cssText = 'display:none;align-items:center;margin-right:6px;gap:3px;font-size:11px;white-space:nowrap;';
    _$lvBar.title = '赛季等级：每 100 ge 消费升一级';

    _$lvLevel = document.createElement('span');
    _$lvLevel.className = 'qqq-lv-level';
    _$lvLevel.style.cssText = 'color:var(--text-primary,#e8e8e8);font-weight:bold;font-variant-numeric:tabular-nums;min-width:50px;text-align:right;';

    var $lvTrack = document.createElement('span');
    $lvTrack.className = 'qqq-lv-track';
    $lvTrack.style.cssText = 'display:inline-block;width:60px;height:6px;background:var(--bg-tertiary,#333);border-radius:3px;overflow:hidden;';

    _$lvProgress = document.createElement('span');
    _$lvProgress.className = 'qqq-lv-fill';
    _$lvProgress.style.cssText = 'display:block;height:100%;width:0%;background:linear-gradient(90deg,#859900,#b58900);border-radius:3px;transition:width .5s;';

    $lvTrack.appendChild(_$lvProgress);
    _$lvBar.appendChild(_$lvLevel);
    _$lvBar.appendChild($lvTrack);

    // GE 余额标签（登录态可见，在手机号左边）
    _$geLabel = document.createElement('span');
    _$geLabel.className = 'qqq-ge-label';
    _$geLabel.style.cssText = 'font-size:12px;font-weight:bold;color:var(--text-primary);margin-right:6px;display:none;align-self:center;font-variant-numeric:tabular-nums;white-space:nowrap;';

    // 登录按钮
    _$loginBtn = document.createElement('button');
    _$loginBtn.className = 'qqq-login-btn';
    _$loginBtn.setAttribute('data-i18n-title', 'login.title');
    _$loginBtn.title = '登录';
    _$loginBtn.textContent = '\uD83D\uDD12';
    _$loginBtn.addEventListener('click', function (e) {
      e.preventDefault();
      _doLogin().then(function (result) {
        if (result) {
          console.log('[login] success, phone:', result.phone);
        } else {
          if (window.qqqideQoast) {
            window.qqqideQoast.show('登录超时，请重试', { duration: 5000 });
          }
        }
      }).catch(function (err) {
        console.error('[login] error:', err);
      });
    });

    // 手机号按钮
    _$phoneBtn = document.createElement('button');
    _$phoneBtn.className = 'qqq-login-btn qqq-phone-btn';
    _$phoneBtn.title = '已登录 — 点击打开菜单';
    _$phoneBtn.style.display = 'none';
    _$phoneBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var _existing = document.querySelector('.qqq-phone-dropdown');
      if (_existing) { _existing.remove(); return; }
      var _dd = document.createElement('div');
      _dd.className = 'qqq-phone-dropdown';
      _dd.style.cssText = 'position:absolute;top:100%;right:0;margin-top:4px;background:var(--bg-secondary,#252525);border:1px solid var(--border-color,#444);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:99999;min-width:120px;padding:4px 0;';
      var _logoutItem = document.createElement('div');
      _logoutItem.className = 'qqq-phone-dropdown-item';
      _logoutItem.textContent = '退出登录';
      _logoutItem.style.cssText = 'padding:8px 16px;cursor:pointer;font-size:13px;color:var(--text-primary,#e8e8e8);white-space:nowrap;transition:background .15s;';
      _logoutItem.addEventListener('mouseenter', function () { _logoutItem.style.background = 'var(--hover-bg,#333)'; });
      _logoutItem.addEventListener('mouseleave', function () { _logoutItem.style.background = ''; });
      _logoutItem.addEventListener('click', function (ev) {
        ev.stopPropagation();
        _dd.remove();
        api.logout();
      });
      _dd.appendChild(_logoutItem);
      _$phoneBtn.style.position = 'relative';
      _$phoneBtn.appendChild(_dd);
      setTimeout(function () {
        var _closeDd = function (ev2) {
          if (!_dd.contains(ev2.target) && ev2.target !== _$phoneBtn) {
            _dd.remove();
            document.removeEventListener('click', _closeDd);
          }
        };
        document.addEventListener('click', _closeDd);
      }, 0);
    });

    // 插入顺序：[排行榜] [LV经验条] [GE标签] [手机号] [登录按钮] → refNode
    $parent.insertBefore(_$ldrBtn, $refNode);
    $parent.insertBefore(_$lvBar, $refNode);
    $parent.insertBefore(_$geLabel, $refNode);
    $parent.insertBefore(_$phoneBtn, $refNode);
    $parent.insertBefore(_$loginBtn, $refNode);
  }

  function _updateButtons(isLoggedIn, phoneTail) {
    if (_$loginBtn) {
      _$loginBtn.style.display = isLoggedIn ? 'none' : '';
    }
    if (_$phoneBtn) {
      if (isLoggedIn && phoneTail) {
        _$phoneBtn.textContent = phoneTail;
        _$phoneBtn.style.display = '';
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
      _ensureBootInfo().then(function () {
        _injectLoginButton();
        _restoreAuth().then(function () {
          _notifyStateChange();
        });
      }).catch(function () {
        _restoreAuth().then(function () {
          _notifyStateChange();
        });
      });
    },

    isLoggedIn: function () {
      return !!(_authData && _authData.token);
    },

    getAuthToken: function () {
      return (_authData && _authData.token) ? _authData.token : '';
    },

    getPhone: function () {
      return (_authData && _authData.phone) ? _authData.phone : '';
    },

    getPhoneTail: function () {
      var phone = api.getPhone();
      return phone ? phone.slice(-4) : '';
    },

    getBalanceGe: function () {
      return _balanceGe;
    },

    getLvData: function () {
      return _lvData;
    },

    login: function () {
      return _doLogin();
    },

    logout: function () {
      _clearAuthData();
      _notifyStateChange();
      try {
        if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.clearAuth) {
          window.qqqideBridge.auth.clearAuth();
        }
      } catch (e) { /* ignore */ }
      if (window.qqqideQoast) {
        window.qqqideQoast.show('已退出登录', { duration: 3000 });
      }
    },

    onStateChange: function (fn) {
      _stateListeners.push(fn);
      return function () {
        var idx = _stateListeners.indexOf(fn);
        if (idx >= 0) _stateListeners.splice(idx, 1);
      };
    }
  };

  window.qqqLogin = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(function () { api.init(); }, 200);
    });
  } else {
    setTimeout(function () { api.init(); }, 200);
  }

})();
