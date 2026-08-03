// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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
  var _balanceGe = null;
  var _balanceLastFetch = 0;
  var _phoneDropdownCloser = null; // ★ 手机号下拉的全局 closer，用于 toggle 时清理
  var _balanceTimer = null;
  var _lvData = null;
  var _$ldrOverlay = null;
  var _$ldrPanel = null;
  var _$loginOverlay = null;
  var _$loginPanel = null;
  var _loginEscHandler = null;
  var _loginAuthUnsub = null;

  var API_BASE = 'https://direct-cn.gh555.com/api';
  var BALANCE_POLL_MS = 60000;
  var NO_DRAG = '-webkit-app-region:no-drag;';

  var _bootInfo = null;

  function _renderCountryBadge(cc) {
    if (!cc || cc.length !== 2) return '';
    var upper = cc.toUpperCase();
    // ★ 国旗 emoji：Unicode regional indicator  A=U+1F1E6
    var flag = String.fromCodePoint(0x1F1E6 + (upper.charCodeAt(0) - 65), 0x1F1E6 + (upper.charCodeAt(1) - 65));
    return '<span style="display:inline-flex;align-items:center;gap:2px;font-size:14px;line-height:16px;" title="' + upper + '">' + flag + '</span>';
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

  function _setAuthData(token, phone, countryIso2, purchased) {
    _authData = { token: token, phone: phone, device_name: _buildDeviceName(), ts: Date.now() };
    if (countryIso2) _authData.countryIso2 = countryIso2;
    if (purchased) _authData.purchased = true;
    _persistAuthAsync();
  }

  function _clearAuthData() { _authData = null; }

  function _persistAuthAsync() {
    if (!_authData) return;
    try {
      var br = window.qqqideBridge && window.qqqideBridge.auth;
      if (br) {
        // ★ 轻量：先同步 phone 到主进程共享内存（不依赖 safeStorage，保证 wq-ping 能读到）
        if (br.setPhone && _authData.phone) br.setPhone(_authData.phone);
        if (br.saveAuth) br.saveAuth({ token: _authData.token, phone: _authData.phone, device_name: _authData.device_name, country_iso2: _authData.countryIso2 || '', purchased: !!_authData.purchased });
      }
    } catch (e) { }
  }

  // ★ 2026-07-31 T3：从中心大脑恢复登录态（主进程 safeStorage → 所有窗口秒级同步）
  async function _restoreAuth() {
    if (_authData && _authData.token) return true;
    try {
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.getState) {
        var state = await window.qqqideBridge.auth.getState();
        if (state && state.loggedIn && state.phone) {
          _authData = {
            token: state.token || '', phone: state.phone, device_name: _buildDeviceName(), ts: Date.now(),
            countryIso2: state.countryIso2 || '', purchased: state.purchased || false
          };
          _balanceGe = state.balanceGe;
          _lvData = state.lvData;
          _lvShow();
          _updateGeLabel();
          return true;
        }
      }
      // 兜底：旧 loadAuth API
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.loadAuth) {
        var saved = await window.qqqideBridge.auth.loadAuth();
        if (saved && saved.token && saved.phone) {
          _authData = saved; _authData.ts = Date.now();
          if (saved.country_iso2 && !_authData.countryIso2) _authData.countryIso2 = saved.country_iso2;
          if (saved.purchased) _authData.purchased = true;
          _lvShow();
          return true;
        }
      }
    } catch (e) { }
    return false;
  }

  // ★ 立即显示 LV 区域 + 渲染（有旧数据用旧数据，无数据渲染零）
  function _lvShow() {
    _initLdr();
    _lvInjectShimmer();  // 预注入流光 keyframes，避免每 billing 查 head
    if (_$lvBar) _$lvBar.style.display = 'inline-flex';
    var d = _lvData;
    if (d && typeof d.level === 'number' && d.level >= 0) {
      var WL = 10 * 10000;
      var f = d.level_floor != null ? d.level_floor : 0;
      var p = Math.min(d.progress_pct || 0, 100);
      _lvDisplaySnap(p, f);
      _lvAccWge = f * WL + (p / 100) * WL;
    } else if (_lvAccWge === null) {
      // ★ 无数据时也渲染零值（保证启动时有 LV 区域可见）
      _lvDisplaySnap(0, 0);
      _lvAccWge = 0;
    }
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
      if (!resp.ok) return;
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
  var _lvAccWge = null;       // 本地累计总 wge（null=未从服务器初始化）
  var _lvLastBillingTs = 0;   // 最后一次 billing 时间戳，用于防回退

  function _setupLvListener() {
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'qqq-lv-tick') {
        var costWge = e.data.geCost || 0;
        var isFree = !!e.data.freeWindow;
        if (costWge > 0) {
          _lvLastBillingTs = Date.now();
          var costGe = costWge / 10000;
          if (_balanceGe !== null && _balanceGe !== undefined && costGe > 0) {
            _balanceGe = Math.max(0, _balanceGe - costGe);
            _updateGeLabel();
          }
          if (_lvAccWge !== null) {
            _lvAccWge += costWge;
            var WL = 10 * 10000;
            var lvFloor = Math.floor(_lvAccWge / WL);
            var lvPct = (_lvAccWge % WL) / WL * 100;
            _lvAnimate(lvFloor, lvPct);
          }
        }
        // ★ T3：转发 billing 到主进程中心大脑（中心大脑拉取服务器真理 + 广播所有窗口）
        try {
          if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.notifyBilling) {
            window.qqqideBridge.auth.notifyBilling(costWge);
          }
        } catch (_) { }
        // 本地拉取 LV（兼容旧版无中心大脑时）
        _fetchLv();
        if (isFree) {
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
        if (data.country_iso2 && (!_authData.countryIso2 || data.country_iso2 !== _authData.countryIso2)) {
          _authData.countryIso2 = data.country_iso2;
          _updateButtons(true, _authData.phone.slice(-4));
        }
        var WL = 10 * 10000;
        var servFloor = data.level_floor != null ? data.level_floor : 0;
        var servPct = Math.min(data.progress_pct || 0, 100);
        var servWge = servFloor * WL + (servPct / 100) * WL;
        if (_lvAccWge === null || servWge > _lvAccWge) {
          _lvAccWge = servWge;
        } else if (servWge < _lvAccWge && Date.now() - _lvLastBillingTs > 2000) {
          _lvAccWge = servWge;
        }
        if (!_lvAnim) { _lvDisplaySnap(servPct, servFloor); }
        if (_$lvBar) _$lvBar.style.display = 'inline-flex';
        if (_$lvLevel && servFloor >= 0) _$lvLevel.textContent = 'Lv' + servFloor;
      }
    } catch (e) {
      if (!_lvAnim) {
        var d = _lvData;
        if (d && typeof d.level === 'number' && d.level >= 0) {
          var w = 10 * 10000, f = d.level_floor != null ? d.level_floor : 0, p = Math.min(d.progress_pct || 0, 100);
          _lvDisplaySnap(p, f);
          if (_lvAccWge === null) _lvAccWge = f * w + (p / 100) * w;
        } else if (_lvAccWge === null) {
          _lvDisplaySnap(0, 0);
          _lvAccWge = 0;
        }
      }
    }
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

  // ★ 升级音频 — 走主路音量 × 固定系数
  var _lvAudioRegular = null, _lvAudioMilestone = null;
  function _lvEnsureAudio() {
    var mv = 1.0;
    try { if (window.qqqAudio) { mv = window.qqqAudio.getMainVolume(); } } catch (_) { }
    if (!_lvAudioRegular) {
      _lvAudioRegular = new Audio('assets/lv-up.mp3');
    }
    _lvAudioRegular.volume = 0.55 * mv;
    if (!_lvAudioMilestone) {
      _lvAudioMilestone = new Audio('assets/lv-up-milestone.mp3');
    }
    _lvAudioMilestone.volume = 0.65 * mv;
  }

  // 顶层 rAF 追赶（每间 house 独立调用）
  function _lvChaseSolid(targetPct, isLevelUp, lvFloor) {
    if (!_$lvSolid) return;
    // 升级时额外音频
    if (isLevelUp) { _lvEnsureAudio(); var isM = (lvFloor > 0 && lvFloor % 10 === 0); var aud = isM ? _lvAudioMilestone : _lvAudioRegular; if (aud) { aud.currentTime = 0; aud.play().catch(function () { }); } }
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

  // ── LV 流光特效（放大 1.5× → 金色流光 5s → 还原）──
  var _lvGlowTimer = null;   // 共享还原定时器（每次 billing 重置，保证文字永不消失）
  var _lvShimmerStyle = null;
  var _lvCachedBaseColor = '';
  var _lvCachedGrad = '';
  var _lvCachedKey = null;

  function _lvInjectShimmer() {
    if (_lvShimmerStyle) return;
    _lvShimmerStyle = document.createElement('style');
    _lvShimmerStyle.textContent = '@keyframes qq-lv-shimmer{0%{background-position:200% 0}100%{background-position:-100% 0}}';
    document.head.appendChild(_lvShimmerStyle);
  }

  function _lvLevelUpGlow() {
    if (!_$lvLevel) return;

    // ★ 取消旧还原定时器 + 立即清除旧流光残留（防文字永久消失）
    if (_lvGlowTimer) { clearTimeout(_lvGlowTimer); _lvGlowTimer = null; }
    _$lvLevel.style.animation = '';
    _$lvLevel.style.backgroundImage = '';
    _$lvLevel.style.backgroundSize = '';
    _$lvLevel.style.backgroundClip = '';
    _$lvLevel.style.webkitBackgroundClip = '';
    _$lvLevel.style.color = '';
    _$lvLevel.style.transition = '';

    // 缓存主题色
    var theme = document.documentElement.getAttribute('data-theme') || '';
    if (_lvCachedKey !== theme) {
      _lvCachedKey = theme;
      _lvCachedBaseColor = '#e8e8e8';
      try { var c = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim(); if (c) _lvCachedBaseColor = c; } catch (e) { }
      _lvCachedGrad = 'linear-gradient(90deg, ' + _lvCachedBaseColor + ' 0%, ' + _lvCachedBaseColor + ' 38%, #ffd700 46%, #fff8dc 50%, #ffd700 54%, ' + _lvCachedBaseColor + ' 62%, ' + _lvCachedBaseColor + ' 100%)';
    }

    // Phase 1: 放大 1.5× + 上移 1px
    _$lvLevel.style.transform = 'scale(1.5) translateY(-1px)';
    _$lvLevel.style.transformOrigin = 'center center';

    // Phase 2: rAF 启动流光
    requestAnimationFrame(function () {
      _$lvLevel.style.backgroundImage = _lvCachedGrad;
      _$lvLevel.style.backgroundSize = '300% 100%';
      _$lvLevel.style.backgroundClip = 'text';
      _$lvLevel.style.webkitBackgroundClip = 'text';
      _$lvLevel.style.color = 'transparent';
      _$lvLevel.style.animation = 'qq-lv-shimmer 1.6s linear infinite';

      // Phase 3: 5s 后还原（共享定时器，无条件执行）
      _lvGlowTimer = setTimeout(function () {
        _lvGlowTimer = null;
        _$lvLevel.style.animation = '';
        _$lvLevel.style.backgroundImage = '';
        _$lvLevel.style.backgroundSize = '';
        _$lvLevel.style.backgroundClip = '';
        _$lvLevel.style.webkitBackgroundClip = '';
        _$lvLevel.style.color = '';
        _$lvLevel.style.transition = 'all 0.7s ease-out';
        _$lvLevel.style.transform = '';
        _$lvLevel.style.transformOrigin = '';
        setTimeout(function () {
          _$lvLevel.style.transition = '';
        }, 800);
      }, 5000);
    });
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
    _lvChaseSolid(lvPct, isLevelUp, lvFloor);
    // ③ 升级流光特效（仅升级时触发）
    if (isLevelUp) _lvLevelUpGlow();
  }

  // ── 排行榜缓存（同赛季缓存，跨赛季自动失效）──
  var _ldrCache = null;  // { all_time: { data, seasonId, ts }, last_season: { data, seasonId, ts } }
  var _ldrFetching = false;

  function _getCurrentSeasonId() {
    var d = new Date();
    // ISO week: Mon=1 ... Sun=7
    var day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
  }

  var LDR_ROW_HTML = '<div style="display:flex;align-items:center;padding:5px 0;font-size:12px;gap:6px;">' +
    '<span style="width:24px;color:var(--text-dim,#888);text-align:right;">#{rank}</span>' +
    '<span style="width:18px;">{flag}</span>' +
    '<span style="flex:1;">{phone}</span>' +
    '<span style="min-width:70px;color:#b58900;text-align:right;font-weight:bold;">Lv{lv}</span>' +
    '</div>';

  function _ldrBuildRows(list) {
    var s = '';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var lvNum = parseFloat(e.level_str);
      var lvDisplay = isNaN(lvNum) ? e.level_str : (lvNum * 10).toFixed(4);
      s += LDR_ROW_HTML.replace('{rank}', e.rank).replace('{flag}', e.flag).replace('{phone}', e.phone)
        .replace('{lv}', lvDisplay);
    }
    return s;
  }

  var LDR_FREEBIE_ROW_HTML = '<div style="display:flex;align-items:center;padding:5px 0;font-size:12px;gap:6px;">' +
    '<span style="width:24px;color:var(--text-dim,#888);text-align:right;">#{rank}</span>' +
    '<span style="width:18px;">{flag}</span>' +
    '<span style="flex:1;">{phone}</span>' +
    '<span style="min-width:60px;color:#859900;text-align:right;font-weight:bold;">{ge} ge</span>' +
    '</div>';

  function _ldrBuildFreebieRows(list) {
    var s = '';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var ge = typeof e.freebie_ge === 'number' ? e.freebie_ge.toFixed(1) : '0.0';
      s += LDR_FREEBIE_ROW_HTML.replace('{rank}', e.rank).replace('{flag}', e.flag).replace('{phone}', e.phone)
        .replace('{ge}', ge);
    }
    return s;
  }

  var LDR_ERR_HTML = '<div style="color:var(--text-dim,#888);padding:20px;text-align:center;">加载失败</div>';
  var LDR_LOAD_HTML = '<div style="color:var(--text-dim,#888);padding:20px;text-align:center;">加载中...</div>';

  function _ldrClose() {
    if (_$ldrOverlay) _$ldrOverlay.style.display = 'none';
  }

  // 后台静默拉取（不显示 loading，不覆盖已有内容）
  function _ldrFetch(silent) {
    if (_ldrFetching) return;
    _ldrFetching = true;
    var token = _authData && _authData.token ? _authData.token : '';
    var $freebie = document.getElementById('qqq-ldr-freebie');
    var $left = document.getElementById('qqq-ldr-left');
    var $right = document.getElementById('qqq-ldr-right');
    var seasonId = _getCurrentSeasonId();

    fetch(API_BASE + '/qqq/leaderboard', {
      headers: { 'Authorization': 'Bearer ' + token }
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        _ldrCache = {
          freebie: { data: d.freebie, seasonId: seasonId, ts: Date.now() },
          all_time: { data: d.all_time, seasonId: seasonId, ts: Date.now() },
          last_season: { data: d.last_season, seasonId: seasonId, ts: Date.now() }
        };
        // 非静默模式 OR 面板仍开着 → 渲染
        if (!silent || (_$ldrOverlay && _$ldrOverlay.style.display !== 'none')) {
          if ($freebie && d.freebie) $freebie.innerHTML = _ldrBuildFreebieRows(d.freebie);
          else if ($freebie) $freebie.innerHTML = LDR_LOAD_HTML;
          if ($left) $left.innerHTML = _ldrBuildRows(d.all_time);
          if ($right) $right.innerHTML = _ldrBuildRows(d.last_season);
        }
      } else if (!silent) {
        if ($left) $left.innerHTML = LDR_ERR_HTML;
      }
    }).catch(function () {
      if (!silent && $left) $left.innerHTML = LDR_ERR_HTML;
    }).finally(function () {
      _ldrFetching = false;
    });
  }

  // 构建排行榜头部：个人赛季统计
  function _ldrUpdateHeader() {
    var $hdr = document.getElementById('qqq-ldr-header-text');
    if (!$hdr) return;
    var d = _lvData;
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var titleClr = isDark ? '#dcd8d0' : '#656360';

    // 上周最终等级 = last_season_level × 10，4 位小数
    var lastLv = (d && typeof d.last_season_level === 'number' && d.last_season_level > 0)
      ? 'lv' + (d.last_season_level * 10).toFixed(4) : '--';
    // 本周基座升高 = last_season_level（结算等级 ÷ 10），四舍五入 1 位小数
    var baseRise = (d && typeof d.last_season_level === 'number' && d.last_season_level > 0)
      ? d.last_season_level.toFixed(1) : '--';
    // 预计下周基座升高 = 本周到目前为止总消费 ÷ 100，1 位小数
    var projected = '--';
    if (d && d.total_consumed_ge) {
      var totalGe = parseFloat(d.total_consumed_ge);
      if (!isNaN(totalGe) && totalGe > 0) {
        projected = (totalGe / 100).toFixed(1);
      }
    }

    $hdr.innerHTML = '我上周最终等级: <b style="color:#b58900;">' + lastLv
      + '</b>，本周基座升高: <b style="color:#b58900;">' + baseRise
      + 'ge</b>。 预计下周基座将升高: <b style="color:#b58900;">' + projected + 'ge</b>'
      + '<span id="qqq-ldr-help" style="display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:22px;margin-left:8px;position:relative;vertical-align:middle;font-size:13px;font-weight:bold;border:1px solid var(--border-color,#555);border-radius:3px;padding:0 6px;pointer-events:auto;top:-1px;">?</span>';

    // ★ 绑定 help tooltip
    var $help = document.getElementById('qqq-ldr-help');
    if ($help) {
      $help.addEventListener('mouseenter', _ldrHelpShow);
      $help.addEventListener('mousemove', _ldrHelpShow);
      $help.addEventListener('mouseleave', _ldrHelpHide);
    }
  }

  // 免费预算规则 tooltip
  var _$ldrHelpTip = null;
  function _ldrHelpShow(e) {
    if (!_$ldrHelpTip) {
      _$ldrHelpTip = document.createElement('div');
      _$ldrHelpTip.style.cssText = 'position:fixed;z-index:99999;padding:12px 16px;font-size:13px;line-height:1.7;color:#93a1a1;background:rgba(0,0,0,0.92);border:1px solid #444;border-radius:4px;pointer-events:none;white-space:pre-wrap;max-width:400px;display:none;font-family:sans-serif;';
      document.body.appendChild(_$ldrHelpTip);
    }
    var rect = e && e.target ? e.target.getBoundingClientRect() : null;
    if (!rect) return;
    _$ldrHelpTip.innerHTML =
      '<b style="color:#b58900;">等级及免费额度规则</b><br><br>'
      + '一周共 13 个免费时段：<br>'
      + '• 周一至周六 × 12 个 2 小时段<br>'
      + '• 周日 × 1 个 24 小时段<br><br>'
      + '<b>每个时段的免费额度</b><br>'
      + '= 随机值（最大 1000 ge）+ <b>本周基座</b><br><br>'
      + 'UTC 时间一周作为一个赛季，<br>'
      + '例如：2026_28W1 代表 2026 年第 28 周，<br>'
      + '其对应总观历史滴第一个赛季即：W1。<br><br>'
      + '<b>本周基座</b> 仅由上赛季最终消费决定：<br>'
      + '基座 = 上赛季总消费 ÷ 100<br>'
      + '若上赛季消费 100 ge → 本周基座 = 1<br><br>'
      + '• 周一至周六：随机 + 基座 × 1<br>'
      + '• 周日：随机 + 基座 × 2（双倍）<br><br>'
      + '<b>等级</b> = 总消费 ÷ 10<br>'
      + '<b>预计下周基座</b> = 本周已消费 ÷ 100';
    _$ldrHelpTip.style.left = (rect.left + rect.width / 2 - 200) + 'px';
    _$ldrHelpTip.style.top = (rect.bottom + 4) + 'px';
    _$ldrHelpTip.style.display = '';
  }
  function _ldrHelpHide() {
    if (_$ldrHelpTip) _$ldrHelpTip.style.display = 'none';
  }

  function _ldrOpen() {
    if (_$ldrOverlay && _$ldrOverlay.style.display !== 'none') { _ldrClose(); return; }
    var token = _authData && _authData.token ? _authData.token : '';
    if (!token) return;

    _initLdr();
    _ldrUpdateHeader();
    var $freebie = document.getElementById('qqq-ldr-freebie');
    var $left = document.getElementById('qqq-ldr-left');
    var $right = document.getElementById('qqq-ldr-right');
    _$ldrOverlay.style.display = '';

    var seasonId = _getCurrentSeasonId();
    var hasCache = _ldrCache && _ldrCache.all_time && _ldrCache.all_time.seasonId === seasonId;

    if (hasCache) {
      // ★ 同赛季命中 → 即时渲染缓存，零闪烁
      if ($freebie && _ldrCache.freebie) $freebie.innerHTML = _ldrBuildFreebieRows(_ldrCache.freebie.data);
      if ($left) $left.innerHTML = _ldrBuildRows(_ldrCache.all_time.data);
      if ($right) $right.innerHTML = _ldrBuildRows(_ldrCache.last_season.data);
      // 超过 30 分钟 → 后台静默刷新
      if (Date.now() - _ldrCache.all_time.ts > 30 * 60 * 1000) {
        _ldrFetch(true);
      }
    } else {
      // ★ 无缓存或跨赛季 → 显示加载中，拉取新数据
      if ($freebie) $freebie.innerHTML = LDR_LOAD_HTML;
      if ($left) $left.innerHTML = LDR_LOAD_HTML;
      if ($right) $right.innerHTML = LDR_LOAD_HTML;
      _ldrFetch(false);
    }
  }

  var _ldrInited = false;
  function _initLdr() {
    if (_ldrInited) return;
    _ldrInited = true;
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
    _$ldrPanel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:850px;max-width:94vw;max-height:80vh;overflow-y:auto;z-index:9999;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.35);background:' + bg + ';';
    _$ldrPanel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid ' + border + ';">' +
      '<span id="qqq-ldr-header-text" style="font-size:13px;color:' + titleClr + ';"></span>' +
      '<button id="qqq-ldr-close" style="width:22px;height:22px;border:1px solid ' + border + ';border-radius:3px;background:transparent;color:' + titleClr + ';font-size:13px;line-height:20px;text-align:center;cursor:pointer;">✕</button>' +
      '</div>' +
      '<div style="display:flex;min-height:300px;">' +
      '<div style="flex:1;padding:10px 12px;border-right:1px solid ' + border + ';">' +
      '<div style="font-size:13px;font-weight:bold;color:' + titleClr + ';margin-bottom:8px;">🍀 白嫖榜</div>' +
      '<div id="qqq-ldr-freebie"></div></div>' +
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

  // ── 登录流程（外部浏览器主通道 + OS协议回调 + 主进程轮询兜底）──
  // ★ 2026-07-31 F34 简化：砍掉渲染层轮询（主进程 auth-brain 已有轮询），
  //   砍掉 BrowserWindow 分支。唯二通道：OS 协议回调 + 主进程轮询。
  var _loginActive = false;
  var _loginCleanup = null;
  var _loginUrl = '';
  async function _doLogin() {
    if (_loginActive) {
      console.log('[login] already active, re-opening browser');
      if (window.qqqideBridge && window.qqqideBridge.shell && _loginUrl) {
        window.qqqideBridge.shell.openExternal(_loginUrl);
      }
      return null;
    }
    _loginActive = true;
    _updateLoginButtonState(true);

    var bridge = window.qqqideBridge && window.qqqideBridge.auth;
    if (!bridge) {
      console.warn('[login] auth bridge not available');
      _loginActive = false;
      _updateLoginButtonState(false);
      return null;
    }

    var _qoast = null;
    var _qoastTimer = null;
    var _loginTimeout = null;

    function _finishLogin() {
      _loginActive = false;
      _loginCleanup = null;
      _updateLoginButtonState(false);
      if (_qoastTimer) { clearTimeout(_qoastTimer); _qoastTimer = null; }
      if (_loginTimeout) { clearTimeout(_loginTimeout); _loginTimeout = null; }
    }
    _loginCleanup = _finishLogin;

    // ★ 监听主进程广播 → 登录成功
    var _authUnsub = bridge.onAuthChanged(function (snap) {
      if (snap && snap.loggedIn) {
        console.log('[login] auth changed → logged in');
        if (_qoast) { _qoast.dismiss(); _qoast = null; }
        if (typeof _authUnsub === 'function') _authUnsub();
        _finishLogin();
      }
    });

    // ★ 显示复制链接 qoast（永久，含「复制登录链接」按钮）
    function _ensureCopyQoast(msg) {
      if (_qoast) return;
      _qoast = window.qqqideQoast && window.qqqideQoast.show(
        msg || '\u8BF7\u590D\u5236\u94FE\u63A5\u5728\u6D4F\u89C8\u5668\u4E2D\u5B8C\u6210\u767B\u5F55\uFF0C\u767B\u5F55\u6210\u529F\u540E\u81EA\u52A8\u8FD4\u56DE IDE',
        {
          duration: 0,
          type: 'info',
          action: {
            label: '\u590D\u5236\u767B\u5F55\u94FE\u63A5',
            onClick: function () {
              if (window.qqqideBridge && window.qqqideBridge.clipboard) {
                window.qqqideBridge.clipboard.writeText(_loginUrl);
              }
              window.qqqideQoast && window.qqqideQoast.show('\u94FE\u63A5\u5DF2\u590D\u5236\uFF0C\u8BF7\u7C98\u8D34\u5230\u6D4F\u89C8\u5668\u5730\u5740\u680F', { duration: 3000 });
            }
          }
        }
      );
    }

    try {
      console.log('[login] opening external browser...');
      if (bridge.openLoginExternal) {
        _loginUrl = await bridge.openLoginExternal() || '';
        console.log('[login] openLoginExternal returned: ' + (_loginUrl ? _loginUrl.slice(0, 80) + '...' : 'EMPTY'));

        // 3s 后若未登入 → 显示复制链接 qoast
        _qoastTimer = setTimeout(function () {
          if (!_authData || !_authData.token) {
            _ensureCopyQoast('\u6D4F\u89C8\u5668\u5DF2\u6253\u5F00\uFF0C\u5982\u672A\u81EA\u52A8\u767B\u5F55\u8BF7\u590D\u5236\u94FE\u63A5');
          }
        }, 3000);

        // 120s 总超时
        _loginTimeout = setTimeout(function () {
          console.warn('[login] 120s timeout');
          if (!_authData || !_authData.token) {
            if (_qoast) { _qoast.dismiss(); _qoast = null; }
            if (window.qqqideQoast) {
              window.qqqideQoast.show('\u767B\u5F55\u8D85\u65F6\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u540E\u91CD\u8BD5', { duration: 0, type: 'error' });
            }
          }
          if (typeof _authUnsub === 'function') _authUnsub();
          _finishLogin();
        }, 120000);

      } else {
        console.warn('[login] openLoginExternal bridge not available');
        if (window.qqqideQoast) window.qqqideQoast.show('\u767B\u5F55\u529F\u80FD\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u542F IDE', { duration: 0, type: 'error' });
        _finishLogin();
      }
    } catch (e) {
      console.warn('[login] external browser error:', e && e.message);
      if (window.qqqideQoast) {
        window.qqqideQoast.show('\u767B\u5F55\u7A97\u53E3\u65E0\u6CD5\u6253\u5F00\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5', { duration: 0, type: 'error' });
      }
      if (typeof _authUnsub === 'function') _authUnsub();
      _finishLogin();
    }
    return null;
  }

  function _updateLoginButtonState(active) {
    if (!_$loginBtn) return;
    if (active) {
      _$loginBtn.textContent = '\u23F3 \u767B\u5F55\u4E2D';
      _$loginBtn.style.cursor = 'wait';
      _$loginBtn.style.opacity = '0.6';
      _$loginBtn.title = '\u767B\u5F55\u4E2D\uFF0C\u70B9\u51FB\u91CD\u65B0\u6253\u5F00\u6D4F\u89C8\u5668';
    } else {
      _$loginBtn.textContent = '\uD83D\uDD12 \u767B\u5F55';
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
      _lvShow();            // ★ 立即显示 LV 区域 + 奖杯（主进程广播已推送 balance+lvData）
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
      _$lvTip.style.cssText = 'position:fixed;z-index:99999;padding:4px 10px;font-size:32px;color:#93a1a1;background:rgba(0,0,0,0.88);border:1px solid #444;border-radius:3px;pointer-events:none;white-space:nowrap;display:none;font-weight:300;';
      document.body.appendChild(_$lvTip);
    }
    if (!_$lvBar || !_$lvBar.style.display || _$lvBar.style.display === 'none') return;
    var d = _lvData;
    if (!d) return;
    var rect = _$lvBar.getBoundingClientRect();
    var sh = (d.season_short || '?');
    var cx = e && e.clientX ? e.clientX : rect.left + rect.width / 2;

    // ★ 第一行：赛季信息（格式: "2026_30W3:4.5574"）
    var paid = d.total_consumed_ge || '0';
    var free = d.total_free_ge || '0';
    var paidAll = d.total_consumed_all_ge || paid; // 历史总付费
    var m = sh.match(/^(\([^)]+\))\s+(.+)$/);
    var line1 = '';
    if (m) {
      line1 = '<span style="color:rgba(251,233,188,0.80);font-family:Consolas,monospace">' + m[1] + '</span> <b style="color:rgba(251,233,188,0.80);font-family:Consolas,monospace">' + m[2] + ':</b><span style="color:#b58900;font-size:44px">' + paid + '</span>';
    } else {
      line1 = '<b style="color:rgba(251,233,188,0.80);font-family:Consolas,monospace">' + sh + ':</b><span style="color:#b58900;font-size:44px">' + paid + '</span>';
    }
    // ★ 第二行：历史总付费 + 历史白嫖（居中大号，白嫖绿色）
    var line2 = '<div style="margin-top:4px;text-align:center;"><span style="color:#b58900;font-size:28px;font-family:Consolas,monospace">' + paidAll + '</span> <span style="color:rgba(251,233,188,0.50);font-size:22px;font-family:Consolas,monospace">+</span> <span style="color:#859900;font-size:28px;font-family:Consolas,monospace">' + free + '</span></div>';

    _$lvTip.innerHTML = line1 + line2;
    _$lvTip.style.left = (cx - _$lvTip.offsetWidth / 2) + 'px';
    _$lvTip.style.top = (rect.bottom + 4) + 'px';
    _$lvTip.style.display = '';
  }
  function _lvHideTip() { if (_$lvTip) _$lvTip.style.display = 'none'; }

  // ── 按钮注入（最多重试 5 次，等待菜单 DOM 就绪）──
  var _injectRetries = 0;
  var _INJECT_MAX_RETRIES = 5;
  var _INJECT_RETRY_MS = 400;
  function _injectLoginButton() {
    if (_$loginBtn || _$phoneBtn) return;
    // ★ 锚点：优先 settings 齿轮（保持顺序：[login注入]→[齿轮]→[灯泡]）
    var $settingsBtn = document.querySelector('.qqq-settings-btn');
    var $bulbs = document.getElementById('qqq-bulbs');
    var $parent, $refNode;
    if ($settingsBtn) { $parent = $settingsBtn.parentNode; $refNode = $settingsBtn; }
    else if ($bulbs) { $parent = $bulbs.parentNode; $refNode = $bulbs; }
    else {
      // ★ 菜单未就绪 → 重试（防竞态）
      _injectRetries++;
      if (_injectRetries <= _INJECT_MAX_RETRIES) {
        setTimeout(_injectLoginButton, _INJECT_RETRY_MS);
      }
      return;
    }

    // LV 经验条
    _$lvBar = document.createElement('span');
    _$lvBar.className = 'qqq-lv-bar';
    _$lvBar.style.cssText = NO_DRAG + 'display:none;align-items:center;margin-right:12px;gap:3px;font-size:11px;white-space:nowrap;position:relative;cursor:pointer;';
    _$lvBar.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); _ldrOpen(); });
    _$lvBar.addEventListener('mouseenter', _lvShowTip);
    _$lvBar.addEventListener('mousemove', _lvShowTip);
    _$lvBar.addEventListener('mouseleave', _lvHideTip);
    _$lvLevel = document.createElement('span');
    _$lvLevel.className = 'qqq-lv-level';
    _$lvLevel.style.cssText = 'color:var(--text-primary,#e8e8e8);font-weight:bold;font-variant-numeric:tabular-nums;min-width:44px;text-align:right;position:relative;z-index:3;';

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
    _$loginBtn.textContent = '\uD83D\uDD12 \u767B\u5F55';
    _$loginBtn.style.cssText = NO_DRAG + 'border:1px solid var(--border-color,#444);border-radius:4px;background:transparent;color:var(--text-secondary,#999);cursor:pointer;padding:1px 20px;font-size:13px;';
    _$loginBtn.addEventListener('click', function (e) {
      e.preventDefault();
      _doLogin().catch(function (err) { console.error('[login] error:', err); });
    });

    // 手机号按钮
    _$phoneBtn = document.createElement('button');
    _$phoneBtn.className = 'qqq-login-btn qqq-phone-btn';
    _$phoneBtn.title = '已登录 — 点击打开菜单';
    _$phoneBtn.style.cssText = NO_DRAG + 'display:none;position:relative;';
    _$phoneBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var ex = document.querySelector('.qqq-phone-dropdown');
      if (ex) {
        ex.remove();
        // ★ 清理旧的 closer 监听器（toggle 关闭时）
        if (_phoneDropdownCloser) {
          document.removeEventListener('mousedown', _phoneDropdownCloser, true);
          _phoneDropdownCloser = null;
        }
        return;
      }
      var dd = document.createElement('div');
      dd.className = 'qqq-phone-dropdown';
      // 零空气：padding:0，border-radius 只右上角，虚线边框
      dd.style.cssText = 'position:absolute;top:calc(100% + 2px);right:0;background:var(--background-color);border:2px dashed var(--border-color);border-radius:0 8px 6px 6px;box-shadow:0 6px 20px rgba(0,0,0,0.15);z-index:99999;min-width:120px;padding:0;overflow:hidden;';
      // ge 流水
      var flow = document.createElement('div');
      flow.textContent = 'ge 流水';
      flow.style.cssText = 'display:block;height:32px;line-height:32px;padding:0 16px;cursor:pointer;font-size:13px;color:var(--text-primary);white-space:nowrap;text-decoration:none;';
      flow.addEventListener('mouseenter', function () { flow.style.background = 'var(--gold-hover-bg)'; });
      flow.addEventListener('mouseleave', function () { flow.style.background = ''; });
      flow.addEventListener('click', function () {
        _cleanupPhoneDD();
        try {
          if (window.qqqideBridge && window.qqqideBridge.shell && window.qqqideBridge.shell.openExternal) {
            window.qqqideBridge.shell.openExternal('https://gh555.com/viewer/geflow');
          }
        } catch (_) { }
      });
      dd.appendChild(flow);
      // 退出登录（零间隙，无分隔线）
      var logout = document.createElement('div');
      logout.textContent = '退出登录';
      logout.style.cssText = 'display:block;height:32px;line-height:32px;padding:0 16px;cursor:pointer;font-size:13px;color:var(--red);white-space:nowrap;';
      logout.addEventListener('mouseenter', function () { logout.style.background = 'var(--gold-hover-bg)'; });
      logout.addEventListener('mouseleave', function () { logout.style.background = ''; });
      logout.addEventListener('click', function (ev) { ev.stopPropagation(); _cleanupPhoneDD(); api.logout(); });
      dd.appendChild(logout);
      _$phoneBtn.appendChild(dd);
      // ★ 统一清理 phone dropdown（DOM + closer 监听器 + blur 监听器）
      function _cleanupPhoneDD() {
        if (_phoneDropdownCloser) {
          document.removeEventListener('mousedown', _phoneDropdownCloser, true);
          _phoneDropdownCloser = null;
        }
        window.removeEventListener('blur', _onBlurPhone);
        if (dd && dd.parentNode) dd.remove();
      }
      // mousedown capture：点击外部立即关闭（click 在 mousedown→mouseup 之后，直接注册无竞态）
      var closer = function (ev2) {
        if (!dd.contains(ev2.target) && ev2.target !== _$phoneBtn) {
          _cleanupPhoneDD();
        }
      };
      _phoneDropdownCloser = closer;
      document.addEventListener('mousedown', closer, true);
      // ★ 点击 iframe 内区域 → 父窗口失焦 → 自动关闭下拉
      function _onBlurPhone() { _cleanupPhoneDD(); }
      window.addEventListener('blur', _onBlurPhone);
    });

    // ★ RULES 按钮 — 编辑全局/项目规则文件
    if (!document.getElementById('qqq-rules-btn-style')) {
      var _rs = document.createElement('style');
      _rs.id = 'qqq-rules-btn-style';
      _rs.textContent = '.qqq-rules-btn{color:#4a0d0d;font-weight:bold}[data-theme="dark"] .qqq-rules-btn{color:#f87171}';
      document.head.appendChild(_rs);
    }
    var _$rulesBtn = document.createElement('button');
    _$rulesBtn.className = 'qqq-rules-btn';
    _$rulesBtn.textContent = 'RULES';
    _$rulesBtn.style.cssText = NO_DRAG + 'border:1px solid var(--border-color,#444);border-radius:4px;background:transparent;cursor:pointer;padding:1px 6px;font-size:10px;margin-right:6px;';
    _$rulesBtn.addEventListener('click', async function (e) {
      e.preventDefault();
      try {
        var bridge = window.qqqideBridge;
        if (!bridge) return;
        var appRoot = await bridge.app.root();
        var appRootClean = appRoot.replace(/\\/g, '/').replace(/\/$/, '');
        var globalPath = appRootClean + '/Data/global.txt';
        var globalExists = await bridge.fs.exists(globalPath);
        if (!globalExists) {
          await bridge.fs.write(globalPath, '# qqq AI Global Rules\n# Write rules here that apply to ALL projects.\n# They will be injected at the start of every new conversation.\n# Rules are only sent once (first turn) \u2014 AI remembers them from conversation history.\n');
        }
        document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: globalPath } }));
        var projRoot = window._workspaceRoot;
        if (projRoot) {
          var projRootClean = projRoot.replace(/\\/g, '/').replace(/\/$/, '');
          var projDir = projRootClean + '/_qqq/alphal/rule';
          var projPath = projDir + '/project.txt';
          var projExists = await bridge.fs.exists(projPath);
          if (!projExists) {
            try { await bridge.fs.mkdir(projDir, { recursive: true }); } catch (_) { }
            await bridge.fs.write(projPath, '# You may optionally add must-read files below.\n# Format: rule"<path>" \u2014 <path> is an absolute file path (files only, directories not supported).\n# Total lines across all added items combined are preferably under ~2000.\n# You can clearly see the space they occupy in the context backpack. Loading on demand is better than carrying too much weight from the start.\n# You can add core architecture, iron rules, skill documents or indexes, for example:\n# rule"D:\\your\\project\\docs\\rules.md"\n# For the latest changes, see: https://www.gh555.com/gaea/d/qqqide#docs\n# Once you are comfortable using this, you may delete the instruction paragraph up to this point.\n');
          }
          if (window.qqqTabs && window.qqqTabs.openFileInRightGroup) {
            window.qqqTabs.openFileInRightGroup(projPath);
          } else {
            document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: projPath } }));
          }
        }
      } catch (_e) { console.warn('[rules] edit error:', _e); }
    });

    // 插入: [LV] [GE] [手机号] [登录] [RULES] → refNode
    $parent.insertBefore(_$lvBar, $refNode);
    $parent.insertBefore(_$geLabel, $refNode);
    $parent.insertBefore(_$phoneBtn, $refNode);
    $parent.insertBefore(_$loginBtn, $refNode);
    $parent.insertBefore(_$rulesBtn, $refNode);
  }

  function _updateButtons(isLoggedIn, phoneTail) {
    if (_$loginBtn) _$loginBtn.style.display = isLoggedIn ? 'none' : '';
    if (_$phoneBtn) {
      if (isLoggedIn && phoneTail) {
        var cc = (_authData && _authData.countryIso2) ? _authData.countryIso2.toLowerCase() : '';
        _$phoneBtn.style.display = 'inline-flex';
        if (cc) {
          _$phoneBtn.innerHTML = _renderCountryBadge(cc) + '<span style="margin-left:4px;">' + phoneTail + '</span>';
        } else {
          _$phoneBtn.textContent = phoneTail;
        }
      } else {
        _$phoneBtn.style.display = 'none';
      }
    }
    _updateGeLabel();
  }

  // ★ 2026-07-31 T3：订阅中心大脑认证变更 → 跨窗口秒级同步
  var _authSyncUnsub = null;
  function _setupAuthSync() {
    try {
      if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.onAuthChanged) {
        _authSyncUnsub = window.qqqideBridge.auth.onAuthChanged(function (snap) {
          if (!snap) return;
          if (snap.loggedIn && snap.phone) {
            // 中心大脑推送登录态 → 更新本地
            if (!_authData || _authData.phone !== snap.phone) {
              _authData = {
                token: snap.token || '', phone: snap.phone, device_name: _buildDeviceName(), ts: Date.now(),
                countryIso2: snap.countryIso2 || '', purchased: snap.purchased || false
              };
            } else {
              if (snap.token) _authData.token = snap.token;
              if (snap.countryIso2) _authData.countryIso2 = snap.countryIso2;
              if (snap.purchased) _authData.purchased = true;
            }
            if (snap.balanceGe !== null && snap.balanceGe !== undefined) {
              _balanceGe = snap.balanceGe;
            }
            if (snap.lvData) {
              _lvData = snap.lvData;
              var WL = 10 * 10000;
              var servWge = (_lvData.level_floor || 0) * WL + ((_lvData.progress_pct || 0) / 100) * WL;
              if (_lvAccWge === null || servWge > _lvAccWge || Date.now() - _lvLastBillingTs > 2000) {
                _lvAccWge = servWge;
              }
              if (!_lvAnim) _lvDisplaySnap(_lvData.progress_pct || 0, _lvData.level_floor || 0);
              if (_$lvLevel) _$lvLevel.textContent = 'Lv' + (_lvData.level_floor || 0);
            }
            _updateGeLabel();
            if (_$lvBar) _$lvBar.style.display = 'inline-flex';
          } else if (!snap.loggedIn) {
            // 中心大脑推送登出态 → 清除本地
            _clearAuthData();
          }
          _notifyStateChange();
        });
      }
    } catch (e) {
      console.warn('[login] setupAuthSync failed:', e);
    }
  }

  // ── 公开 API ──
  var api = {
    init: function () {
      if (_initDone) return;
      _initDone = true;
      _setupLvListener();     // ★ 注册 billing 事件 → LV 拉取监听
      _setupAuthSync();       // ★ 2026-07-31 T3：订阅中心大脑认证变更（跨窗口秒级同步）
      _injectLoginButton(); // ★ 无条件注入 DOM，不受 bootInfo/bridge 影响
      _ensureBootInfo().then(function () {
        _restoreAuth().then(function () { _notifyStateChange(); });
      }).catch(function () {
        _restoreAuth().then(function () { _notifyStateChange(); });
      });
    },
    isLoggedIn: function () { return !!(_authData && _authData.token); },
    isPurchased: function () { return !!(_authData && _authData.purchased); },
    // ★ 服务端同步购买状态（每次窗口生命周期最多查一次，点击菜单时触发）
    _purchasedServerChecked: false,
    checkPurchased: function () {
      var self = this;
      if (self._purchasedServerChecked) return Promise.resolve(self.isPurchased());
      if (!self.isLoggedIn()) return Promise.resolve(false);
      return fetch('https://www.gh555.com/api/me/goods', {
        headers: { 'Authorization': 'Bearer ' + self.getAuthToken() }
      }).then(function(r) { return r.json(); }).then(function(d) {
        self._purchasedServerChecked = true;
        if (d.ok && Array.isArray(d.goods)) {
          for (var i = 0; i < d.goods.length; i++) {
            if (d.goods[i].Slg === 'qqqide' || d.goods[i].slg === 'qqqide') {
              if (_authData) _authData.purchased = true;
              return true;
            }
          }
        }
        return self.isPurchased();
      }).catch(function() {
        self._purchasedServerChecked = true;
        return self.isPurchased();
      });
    },
    getAuthToken: function () { return (_authData && _authData.token) ? _authData.token : ''; },
    getPhone: function () { return (_authData && _authData.phone) ? _authData.phone : ''; },
    getPhoneTail: function () { var p = api.getPhone(); return p ? p.slice(-4) : ''; },
    getCountryIso2: function () { return (_authData && _authData.countryIso2) ? _authData.countryIso2 : ''; },
    getBalanceGe: function () { return _balanceGe; },
    getLvData: function () { return _lvData; },
    login: function () { return _doLogin(); },
    logout: function () {
      _clearAuthData();
      _notifyStateChange();
      // ★ T3：中心大脑退出登录 → 广播所有窗口
      try { if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.logout) window.qqqideBridge.auth.logout(); }
        catch (e) { if (window.qqqideBridge && window.qqqideBridge.auth && window.qqqideBridge.auth.clearAuth) window.qqqideBridge.auth.clearAuth(); }
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
