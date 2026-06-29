// ============================================================================
// login.js — 登录模块（照搬 q3/global.js 认证流程，适配 Electron 环境）
//
// 入口：window.qqqLogin.init() — 自动注入登录按钮/GE余额到菜单行2
//
// API：
//   window.qqqLogin.isLoggedIn()      — 是否已登录
//   window.qqqLogin.getPhone()        — 获取手机号
//   window.qqqLogin.getPhoneTail()    — 获取手机尾号（如 "8204"）
//   window.qqqLogin.getAuthToken()    — 获取 JWT token（AI 调用用）
//   window.qqqLogin.login()           — 触发登录流程
//   window.qqqLogin.logout()          — 退出登录
//   window.qqqLogin.onStateChange(fn) — 监听登录态变更
//
// 铁律：
//   · 认证 token 存 ~/.qqq/auth.json（与 q3 共享，跨 IDE 互认）
//   · 颜色走 §3 配色机器
//   · 不触碰 cursor（§19）
// ============================================================================

(function () {
  'use strict';

  // ── 状态 ──
  var _authData = null;        // { token, phone, device_name, ts }
  var _homeDir = null;
  var _initDone = false;
  var _polling = false;
  var _stateListeners = [];
  var _$loginBtn = null;
  var _$phoneBtn = null;
  var _$geLabel = null;
  var _balanceGe = null;
  var _balanceLastFetch = 0;
  var _balanceTimer = null;

  // ── 常量 ──
  var API_BASE = 'https://gh555.com/api';
  var LOGIN_URL = 'https://gh555.com/login';
  var AUTH_FILE = '.qqq/auth.json';
  var POLL_INTERVAL_MS = 3000;
  var POLL_TIMEOUT_MS = 600000; // 10 分钟
  var BALANCE_POLL_MS = 60000;  // 每分钟刷新余额

  // ── 启动信息缓存 ──
  var _bootInfo = null;

  function _getHomeDir() {
    if (_homeDir) return _homeDir;
    if (window._appHomeDir) return window._appHomeDir;
    return null;
  }

  function _authPath() {
    var h = _getHomeDir();
    if (!h) return null;
    return h.replace(/\\/g, '/') + '/' + AUTH_FILE;
  }

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

  async function _loadAuthToken() {
    var p = _authPath();
    if (!p) return null;
    try {
      var exists = await window.qqqideBridge.fs.exists(p);
      if (!exists) return null;
      var raw = await window.qqqideBridge.fs.read(p);
      if (raw && typeof raw === 'string' && raw.trim()) {
        var data = JSON.parse(raw);
        if (data && data.token) {
          _authData = data;
          return data;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function _saveAuthToken(token, phone) {
    var h = _getHomeDir();
    if (!h) return false;
    try {
      var authPath = h.replace(/\\/g, '/') + '/' + AUTH_FILE;
      var data = {
        token: token,
        phone: phone,
        device_name: _buildDeviceName(),
        ts: Date.now()
      };
      _authData = data;
      await window.qqqideBridge.fs.write(authPath, JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      console.error('[login] save auth failed:', e);
      return false;
    }
  }

  async function _clearAuthToken() {
    _authData = null;
    var p = _authPath();
    if (!p) return;
    try {
      await window.qqqideBridge.fs.remove(p);
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
        _homeDir = _bootInfo.homedir || _bootInfo.userData || '';
        window._appHomeDir = _homeDir;
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
      if (data && data.ok && typeof data.balance_ge !== 'undefined') {
        _balanceGe = data.balance_ge;
        _updateGeLabel();
      }
    } catch (e) { /* 静默失败 */ }
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

  // ── 登录流程 ──
  async function _doLogin() {
    if (_polling) return null;
    _polling = true;

    try {
      var existing = await _loadAuthToken();
      if (existing && existing.token) {
        _notifyStateChange();
        return existing;
      }

      var sessionId = _generateSessionId();
      var deviceName = _buildDeviceName();
      var loginUrl = LOGIN_URL + '?from=ide&session=' + sessionId +
        '&device_name=' + encodeURIComponent(deviceName) + '&goods=qqq';

      try {
        window.qqqideBridge.shell.openExternal(loginUrl);
      } catch (e) {
        try { window.open(loginUrl, '_blank'); } catch (e2) { /* ignore */ }
      }

      var startTime = Date.now();
      var pollCount = 0;
      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        await new Promise(function (r) { setTimeout(r, POLL_INTERVAL_MS); });
        pollCount++;
        try {
          var resp = await _httpsGet('/gaea/qqq/auth/poll?session=' + sessionId +
            '&device_name=' + encodeURIComponent(deviceName));
          if (resp && resp.ok && resp.token) {
            await _saveAuthToken(resp.token, resp.phone || '');
            _notifyStateChange();
            return { token: resp.token, phone: resp.phone || '' };
          }
        } catch (e) {
          if (pollCount <= 3) {
            console.warn('[login] poll #' + pollCount + ' error:', e.message);
          }
        }
      }

      return null;
    } finally {
      _polling = false;
    }
  }

  function _notifyStateChange() {
    var isLoggedIn = !!(_authData && _authData.token);
    var phoneTail = isLoggedIn && _authData.phone ? _authData.phone.slice(-4) : '';
    _updateButtons(isLoggedIn, phoneTail);
    if (isLoggedIn) {
      _startBalancePoll();
    } else {
      _stopBalancePoll();
      _balanceGe = null;
      _updateGeLabel();
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
    _$phoneBtn.title = '已登录 — 点击打开个人中心';
    _$phoneBtn.style.display = 'none';
    _$phoneBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var url = 'https://gh555.com/gaea/d/qqq?ref=qqqide#profile';
      try {
        window.qqqideBridge.shell.openExternal(url);
      } catch (err) {
        try { window.open(url, '_blank'); } catch (e2) { /* ignore */ }
      }
    });

    // 插入顺序：[GE标签] [手机号] [登录按钮] → refNode（settings/bulbs）
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
  }

  // ── 公开 API ──
  var api = {
    init: function () {
      if (_initDone) return;
      _initDone = true;

      _ensureBootInfo().then(function () {
        _injectLoginButton();
        return _loadAuthToken();
      }).then(function () {
        _notifyStateChange();
      }).catch(function () {
        _notifyStateChange();
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

    login: function () {
      return _doLogin();
    },

    logout: function () {
      return _clearAuthToken().then(function () {
        _notifyStateChange();
        if (window.qqqideQoast) {
          window.qqqideQoast.show('已退出登录', { duration: 3000 });
        }
      });
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
