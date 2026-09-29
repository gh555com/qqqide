// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-prefs.js — 用户偏好机器（注册表 19 项 = q3 老项目移植 + 💎 removeWatermark/roamName + 设置本地化）
//
// ★ 语义（2026-09-28 用户定案 · 设置本地化 v2）:
//   · 本地持久化：所有用户 —— set() 即时生效并落盘 qgs.simple('qqq.prefs')（设备本地，重启保留）
//   · 云端同步：激活（正版）用户 —— 启动自动拉取 + 修改自动回传（GET/PATCH /api/profile，
//     与官网同库同结构；网站设置标签已移除，存量云配置经此无缝拉回）
//   · 刷新时序: session（本次会话） > cloud（激活用户云端） > local（本机落盘） > default（出厂）
//   · 离线/失败不丢：改动记入脏表（随 local 落盘），启动/下次改动时自动补传；恢复默认离线时挂 pending
//
// 数据方向: defaults（唯一起点） ← local（本机） ← cloud（激活用户） ← session
// 读取优先: session > cloud > local > default
//
// 暴露: window.qqqPrefs
// 依赖: window.qqqLogin（激活判定/令牌，可选——缺失按未激活处理）；window.qgs（本地库，可选）
// ============================================================================

(function () {
  'use strict';

  // ═══ 偏好注册表 — 键名/默认值/枚举 = 老 q3 package.json 原值（+ qqqide 补充项 removeWatermark）═══
  var REGISTRY = {
    // ── ☀️ 核心 ──
    'language': {
      type: 'enum', default: '中文',
      enum: ['中文', '繁體中文', 'English', '日本語', 'Deutsch', 'Русский', 'العربية',
        '한국어', 'Español', 'Français', 'Português BR', 'हिन्दी', 'Tiếng Việt'],
      desc: '☀️ 语言 / Language',
    },
    'theme': {
      type: 'enum', default: 'auto',
      enum: ['auto', 'dark', 'solarize light'],
      desc: '👁️ 面板主题：auto=跟随系统；dark=暖色暗色面板；solarize light=经典暖色亮色',
    },
    'guide': {
      type: 'enum', default: '',
      enum: ['', '1', '2', '3'],
      desc: '偏好指引：1=获取正版；2=云端储存偏好；3=拉取云端配置',
    },

    // ── 👁️ 观察 / 相框 / 预览 ──
    'uiZoom': {
      type: 'enum', default: '100',
      enum: ['80', '90', '100', '110', '125', '150', '175', '200'],
      desc: '👁️ 界面缩放：整个界面的显示比例（独立于系统缩放；屏幕大调小、字小了调大）',
    },
    'performanceMode': {
      type: 'enum', default: 'optmum',
      enum: ['extreme', 'accelerated', 'optmum'],
      desc: '👁️ 性能模式：extreme=只保留首帧，质量47；accelerated=动图/视频最多前2秒，7fps，质量47，不显示进度条；optmum=短媒体保留完整时长·原帧率；长媒体截取首中尾共4秒·15fps；质量71',
    },
    'frameSizeMode': {
      type: 'enum', default: 'fix',
      enum: ['large', 'small', 'fix'],
      desc: '👁️ 相框尺寸模式：large=512x288；small=256x144；fix=根据图片尺寸自动选择',
    },
    'enlargeSmallImages': {
      type: 'bool', default: false,
      desc: '👁️ 小于相框的预览图放大以填满相框（不勾选=保持原尺寸居中）',
    },
    'textSlideColorScheme': {
      type: 'enum', default: 'light',
      enum: ['light', 'dark'],
      desc: '👁️ 文本胶片底色',
    },
    'textSlideFontSize': {
      type: 'int', default: 14, min: 1, max: 218,
      desc: '👁️ 文本胶片字体大小',
    },
    'codelensLevel': {
      type: 'enum', default: '7',
      enum: ['0', '1', '7'],
      desc: '👁️ codelens level：0=none；1=open file；7=全套（open folder/rename/copy/open/qqqide）',
    },

    // ── 🛸 漫游器（roam） ──
    'szDisplayMode': {
      type: 'enum', default: 'nothing',
      enum: ['nothing', 'size', 'ctime', 'mtime'],
      // 消费方 = roam 全局默认（2026-09-29 接线；侧栏 S/C/M 按钮 = 每目录覆盖 fineScm，覆盖优先）
      desc: '🛸 sz 区显示：文件大小 / 创建时间 / 修改时间',
    },
    'sortBy': {
      type: 'enum', default: 'name',
      enum: ['name', 'size', 'ctime', 'mtime'],
      // 消费方 = roam 全局默认（2026-09-29 接线；侧栏 N/S/C/M 按钮 = 每目录覆盖 fineScm，覆盖优先）
      desc: '🛸 排序方式',
    },
    'autoWatchChanges': {
      type: 'bool', default: true,   // 2026-09-29 用户定案：默认开；关 = roam 释放 watcher（零性能开销）
      desc: '🛸 自动感知外部变化（外部程序修改当前目录时自动刷新列表）',
    },
    'roamName': {
      type: 'string', default: 'Roam', maxlen: 12, placeholder: '的梦gaea',
      premium: true, feat: 'roam-name',   // 💎 自定义漫游名字（未激活/未设置恒「Roam」；编辑框占位范例「的梦gaea」；上限 = tab-manager _ROAM_NAME_MAX 同值，两处同改）
      desc: '🛸 自定义漫游名字（最多 12 字，显示在 Roam 标签上）',
    },

    // ── 🍌 html 与富文本 / 下载 ──
    'autoDownload': {
      type: 'bool', default: true,
      desc: '🍌 是否在检测到视频时自动下载',
    },
    'downloadSecurityLevel': {
      type: 'enum', default: '1: 平衡',
      enum: ['0: 最宽松', '1: 平衡', '2: 最严格'],
      desc: '🍌 下载安全策略：0=11 项开关全关；1=开 4 项（协议限制/重定向限制/下载锁/Header 清洗）；2=全开',
    },
    'forceTextFlowScheme': {
      type: 'bool', default: false,
      desc: '🍌 强制消除 html 乱码（仅在顽固乱码时勾选，代价：牺牲排版精度）',
    },

    // ── 📦 doc 导出 ──
    'docExportImageResolution': {
      type: 'enum', default: 'original',
      enum: ['original', 'frame'],
      desc: '📦 导出图片分辨率：original=原始精度；frame=相框分辨率（文件更小、不被页面尺寸截断）',
    },
    'docExportIncludeCipher': {
      type: 'bool', default: true,
      desc: '📦 导出图片暗号字符串',
    },

    // ── 💎 正版专属（2026-09-28 设置本地化：网站标签移除后接管，正版用户可本地调整） ──
    'removeWatermark': {
      type: 'bool', default: true, premium: true, free: false, feat: 'no-watermark',
      desc: '💎 消除相框水印（正版功能；取消勾选后将显示水印）',
    },
  };

  var ORDER = Object.keys(REGISTRY);

  // ═══ 云端（官网同库；激活用户自动同步）═══
  var CLOUD_API = 'https://www.gh555.com/api/profile';
  var CLOUD_GOOD = 'qqqide';

  // ═══ 状态 ═══
  var _session = {};          // 本次会话覆盖（内存，最高优先）
  var _local = {};            // 本机持久化（qgs 'qqq.prefs'，所有用户）
  var _cloud = null;          // 云端配置（激活用户拉取）
  var _dirty = {};            // 待回传云端的键（离线/失败保值）
  var _resetPending = false;  // 恢复默认的云端清除未完成（离线时挂起，联网自动补）
  var _cloudLoaded = false;
  var _listeners = [];
  var _log = function () { };

  // ═══ 本地库句柄（qgs.simple；非云同步 ns——云同步走本模块自有通道）═══
  var _localHandle = null;
  var _loadRetryCount = 0;
  var _loadRetryTimer = null;
  var _persistTimer = null;

  function _warn(msg) {
    try { console.warn('[qqqPrefs] ' + msg); } catch (e) { /* */ }
  }
  function _has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function _handle() {
    if (!_localHandle && window.qgs && window.qgs.simple) {
      try { _localHandle = window.qgs.simple('qqq.prefs', { cloud: false }); } catch (e) { _localHandle = null; }
    }
    return _localHandle;
  }

  // ═══ 激活判定（qqqLogin 缺失 = 未激活）═══
  function isActivated() {
    try {
      if (window.qqqLogin && typeof window.qqqLogin.isPurchased === 'function') {
        return !!window.qqqLogin.isPurchased();
      }
    } catch (e) { /* */ }
    return false;
  }

  function _token() {
    try {
      if (window.qqqLogin && window.qqqLogin.getAuthToken) return window.qqqLogin.getAuthToken() || '';
    } catch (e) { /* */ }
    return '';
  }

  // ═══ 取值：session > cloud > local > default（premium 项对未激活用户恒为 free 语义）═══
  function sourceOf(key) {
    if (_has(_session, key)) return 'session';
    if (_cloud && _has(_cloud, key)) return 'cloud';
    if (_has(_local, key)) return 'local';
    return 'default';
  }

  function get(key) {
    var def = REGISTRY[key];
    if (!def) { _warn('unknown key: ' + key); return undefined; }
    if (def.premium && !isActivated()) {
      return (def.free !== undefined) ? def.free : def.default;   // 正版专属项：未激活 = 出厂免费语义（水印照显）
    }
    if (_has(_session, key)) return _session[key];
    if (_cloud && _has(_cloud, key)) return _cloud[key];
    if (_has(_local, key)) return _local[key];
    return def.default;
  }

  // ═══ 文本项净化（string 类型；唯一消费方 = roamName——上限 maxlen 按码点计，emoji/中文各算 1）═══
  //   控制符/零宽/HTML 剥除 + 收空白；清空 = 回出厂默认。与 tab-manager.js _ROAM_NAME_MAX 同值（两处同改）
  function _sanitizeStr(key, value) {
    var s = String(value == null ? '' : value);
    s = s.replace(/[\r\n]+/g, ' ');                                  // 换行 → 空格（标签单行显示）
    s = s.replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, '');  // 控制符 + 零宽字符
    s = s.replace(/<[^>]*>/g, '');                                   // HTML 标签
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) { s = REGISTRY[key].default; }
    var def = REGISTRY[key];
    if (def.maxlen) {
      var cps = Array.from(s);
      if (cps.length > def.maxlen) { s = cps.slice(0, def.maxlen).join(''); }
    }
    return s;
  }

  // ═══ 校验：枚举/类型/范围 ═══
  function _validate(key, value) {
    var def = REGISTRY[key];
    if (!def) return { ok: false, reason: 'unknown-key' };
    if (def.type === 'bool') return { ok: true, value: !!value };
    if (def.type === 'int') {
      var n = Number(value);
      if (!isFinite(n)) return { ok: false, reason: 'not-a-number' };
      n = Math.round(n);
      if (def.min !== undefined) n = Math.max(def.min, n);
      if (def.max !== undefined) n = Math.min(def.max, n);
      return { ok: true, value: n };
    }
    if (def.type === 'enum') {
      var s = String(value);
      if (def.enum.indexOf(s) < 0) return { ok: false, reason: 'not-in-enum' };
      return { ok: true, value: s };
    }
    return { ok: true, value: _sanitizeStr(key, value) };
  }

  // 老格式归一（网站时代存量值 → 客户端枚举；codelensLevel 老 3 = 全套）
  function _normLegacy(key, value) {
    if (key === 'codelensLevel' && String(value) === '3') return '7';
    return value;
  }

  // ═══ 本地持久化（debounce 400ms；reset/清零走 _persistNow 立即写）═══
  function _persistNow() {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    var h = _handle();
    if (!h) { return; }
    try { var p1 = h.set('values', _local); if (p1 && p1.catch) p1.catch(function () { }); } catch (e) { }
    try { var p2 = h.set('dirty', _dirty); if (p2 && p2.catch) p2.catch(function () { }); } catch (e) { }
    try { var p3 = h.set('resetPending', _resetPending ? 1 : 0); if (p3 && p3.catch) p3.catch(function () { }); } catch (e) { }
  }
  function _persistLocal() {
    if (_persistTimer) { return; }
    _persistTimer = setTimeout(function () {
      _persistTimer = null;
      _persistNow();
    }, 400);
  }

  // ═══ 本地加载（所有用户；失败退避重试 ≤3）═══
  function _scheduleLoadRetry() {
    if (_loadRetryTimer) { return; }
    if (_loadRetryCount >= 3) {
      try { console.warn('[qqqPrefs] local store load failed after retries — defaults/local-empty this session'); } catch (e) { }
      return;
    }
    var delay = [1000, 3000, 8000][_loadRetryCount] || 8000;
    _loadRetryCount++;
    _loadRetryTimer = setTimeout(function () {
      _loadRetryTimer = null;
      _loadLocal();
    }, delay);
  }
  function _loadLocal() {
    var h = _handle();
    if (!h) { _scheduleLoadRetry(); return; }
    try {
      h.get('values').then(function (v) {
        if (v && typeof v === 'object') {
          var ks = Object.keys(v);
          for (var i = 0; i < ks.length; i++) {
            var vv = _validate(ks[i], v[ks[i]]);
            if (vv.ok) { _local[ks[i]] = vv.value; }
          }
          _emit(null);
        }
        return h.get('dirty');
      }).then(function (d) {
        if (d && typeof d === 'object') {
          var dk = Object.keys(d);
          for (var j = 0; j < dk.length; j++) { if (REGISTRY[dk[j]]) { _dirty[dk[j]] = 1; } }
        }
        return h.get('resetPending');
      }).then(function (rp) {
        if (rp) { _resetPending = true; }
        _drainDirty();   // 启动补传（上次会话离线/失败的改动）
      }, function () { _scheduleLoadRetry(); });
    } catch (e) { _scheduleLoadRetry(); }
  }

  // ═══ 写：内存即时生效 + 本地落盘 + （激活）脏表回传 ═══
  function set(key, value) {
    var def = REGISTRY[key];
    if (!def) { _warn('set(' + key + ') unknown key'); return false; }
    if (def.premium && !isActivated()) { _warn('set(' + key + ') rejected: not-activated'); return false; }
    var v = _validate(key, value);
    if (!v.ok) { _warn('set(' + key + ') rejected: ' + v.reason); return false; }
    _session[key] = v.value;
    _local[key] = v.value;
    _persistLocal();
    if (isActivated()) { _dirty[key] = 1; _schedulePush(); }
    _emit(key);
    return true;
  }

  function clearSession(key) {
    if (key === undefined) { _session = {}; _emit(null); return; }
    delete _session[key];
    _emit(key);
  }

  // ═══ 全量快照（UI/诊断用）═══
  function list() {
    var out = [];
    for (var i = 0; i < ORDER.length; i++) {
      var k = ORDER[i];
      out.push({
        key: k,
        value: get(k),
        source: sourceOf(k),
        def: REGISTRY[k],
      });
    }
    return out;
  }

  // ═══ 云端拉取（激活用户；与官网设置同库 /api/profile）═══
  var _pulling = null;
  function pullCloud() {
    if (!isActivated()) {
      return Promise.resolve({ ok: false, reason: 'not-activated' });
    }
    var token = _token();
    if (!token) {
      return Promise.resolve({ ok: false, reason: 'not-login' });
    }
    if (_pulling) return _pulling;

    _pulling = fetch(CLOUD_API + '?good=' + CLOUD_GOOD, {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-store',
    }).then(function (r) {
      if (r.status === 401) { return { _status: 401 }; }
      return r.ok ? r.json() : null;
    }).then(function (j) {
      _pulling = null;
      if (j && j._status === 401) { return { ok: false, reason: 'auth-expired' }; }
      if (!j || !j.ok || !j.profile || typeof j.profile !== 'object') {
        return { ok: false, reason: 'bad-response' };
      }
      var next = {};
      var keys = Object.keys(j.profile);
      for (var i = 0; i < keys.length; i++) {
        var nv = _normLegacy(keys[i], j.profile[keys[i]]);
        var v = _validate(keys[i], nv);
        if (v.ok) next[keys[i]] = v.value;
      }
      _cloud = next;
      _cloudLoaded = true;
      // ★ 脏键（本机已改但未回传）优先——离线编辑不被云端旧值覆盖，并立即补传
      var dk = Object.keys(_dirty);
      for (var d = 0; d < dk.length; d++) {
        if (_local[dk[d]] !== undefined) { _session[dk[d]] = _local[dk[d]]; }
      }
      if (dk.length || _resetPending) { _schedulePush(); }
      _emit(null);
      return { ok: true, count: Object.keys(next).length };
    }).catch(function (e) {
      _pulling = null;
      return { ok: false, reason: 'network', message: e && e.message };
    });
    return _pulling;
  }

  // ═══ 云端回传（PATCH 单键；离线/失败保脏表下次补）═══
  var _pushTimer = null;
  function _schedulePush() {
    if (_pushTimer) { return; }
    _pushTimer = setTimeout(function () {
      _pushTimer = null;
      _flushPush();
    }, 900);
  }
  function _deleteCloud(token) {
    try {
      return fetch(CLOUD_API + '?good=' + CLOUD_GOOD, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token },
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (j) { return !!(j && j.ok); })
        .catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }
  function _flushPush() {
    if (!isActivated()) return;
    var token = _token();
    if (!token) return;
    if (_resetPending) {
      _deleteCloud(token).then(function (ok) {
        if (ok) { _resetPending = false; _persistNow(); }
      });
    }
    var keys = Object.keys(_dirty);
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        if (!REGISTRY[k]) { delete _dirty[k]; return; }
        var v = (_has(_local, k)) ? _local[k] : get(k);
        try {
          fetch(CLOUD_API, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token,
            },
            body: JSON.stringify({ good: CLOUD_GOOD, key: k, value: v }),
          }).then(function (r) {
            return r.ok ? r.json().catch(function () { return null; }) : null;
          }).then(function (j) {
            if (j && j.ok) {
              delete _dirty[k];
              if (_cloud) { _cloud[k] = v; }
              _persistNow();
            }
          }).catch(function () { /* 保脏表，下次补传 */ });
        } catch (e) { /* 保脏表 */ }
      })(keys[i]);
    }
  }
  function _drainDirty() {
    if (isActivated() && (Object.keys(_dirty).length || _resetPending)) { _schedulePush(); }
  }

  // ═══ 恢复默认（本地即清；激活用户连同云端配置删除——离线挂 pending 自动补）═══
  function resetAll() {
    _session = {};
    _local = {};
    _dirty = {};
    _cloud = {};
    var out = { ok: true, cloud: 'skipped' };
    if (isActivated()) {
      var token = _token();
      if (!token) {
        _resetPending = true;
        out.cloud = 'deferred';
      } else {
        _resetPending = true;   // 先挂标记（DELETE 在途失败也不丢意图）
        out.cloud = 'pending';
        _deleteCloud(token).then(function (ok) {
          if (ok) { _resetPending = false; _emit(null); }
          _persistNow();
        });
      }
    }
    _persistNow();
    _emit(null);
    return out;
  }

  // ═══ 变更广播 ═══
  function onChange(cb) {
    if (typeof cb === 'function') _listeners.push(cb);
  }

  function _emit(key) {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](key, key === null ? null : get(key)); } catch (e) { /* */ }
    }
  }

  // ═══ 云端状态查询（设置中心 UI 用）═══
  function cloudInfo() {
    return {
      loaded: !!_cloudLoaded,
      dirty: Object.keys(_dirty).length,
      resetPending: !!_resetPending,
    };
  }

  window.qqqPrefs = {
    REGISTRY: REGISTRY,
    ORDER: ORDER,
    get: get,
    set: set,
    clearSession: clearSession,
    list: list,
    sourceOf: sourceOf,
    isActivated: isActivated,
    pullCloud: pullCloud,
    resetAll: resetAll,
    cloudInfo: cloudInfo,
    onChange: onChange,
  };

  // ★ 启动：本地持久化总是加载（所有用户）；云端拉取仅激活用户
  try { _loadLocal(); } catch (e) { /* */ }
  if (isActivated()) {
    try { pullCloud(); } catch (e) { /* */ }
  }
  // ★ 登录/激活状态变更 → 刷新门与补传（拉取时机=激活刚确认且尚未拉过）
  try {
    if (window.qqqEntitlement && window.qqqEntitlement.onChange) {
      window.qqqEntitlement.onChange(function () {
        try {
          if (isActivated()) {
            if (!_cloudLoaded) { pullCloud(); }
            _drainDirty();
          }
        } catch (e) { /* */ }
        _emit(null);
      });
    }
  } catch (e) { /* */ }
})();
