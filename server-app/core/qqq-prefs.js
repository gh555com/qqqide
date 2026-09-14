// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-prefs.js — 用户偏好机器（q3 老项目 23 项偏好 100% 移植）
//
// ★ 语义（与老项目逐字一致）:
//   · 本地永远不保存配置 —— set() 只改本次会话内存，重启即回默认模板
//   · 未激活用户 = 出厂默认值模板（老项目 default 原值，一项不差）
//   · 已激活用户 = 官网（#profile）保存配置 → 客户端自动拉取生效（pullCloud）
//
// 数据方向: defaults（唯一起点） ← session overrides（本次会话，可丢弃）
//                                ← cloud config（正版，官网保存，自动拉取）
// 读取优先: session > cloud > default
//
// 暴露: window.qqqPrefs
// 依赖: window.qqqLogin（激活判定，可选——缺失按未激活处理）
// ============================================================================

(function () {
  'use strict';

  // ═══ 偏好注册表 — 23 项，键名/默认值/枚举 = 老 q3 package.json 原值 ═══
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
    'ioEngine': {
      type: 'enum', default: 'v16  auto',
      enum: ['v16  auto', 'Exclude Python'],
      desc: '☀️ IO 引擎（排除 Python = 安静、省约 50MB 内存）',
    },
    'transactionLevel': {
      type: 'enum', default: 'half',
      enum: ['full', 'half'],
      desc: '☀️ 事务包裹级别：full=一切耗时操作带进度条+反悔+回滚；half=轻便操作直接粘贴',
    },
    'guide': {
      type: 'enum', default: '',
      enum: ['', '1', '2', '3'],
      desc: '偏好指引：1=获取正版；2=云端储存偏好；3=拉取云端配置',
    },

    // ── 👁️ 观察 / 相框 / 预览 ──
    'performanceMode': {
      type: 'enum', default: 'optmum',
      enum: ['extreme', 'accelerated', 'optmum'],
      desc: '☀️ 性能模式：extreme=只保留首帧，质量47；accelerated=动图/视频最多前2秒，7fps，质量47，不显示进度条；optmum=动图保留完整时长，视频截取首中尾共4秒，原始fps，质量71',
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
    'cleanFreak': {
      type: 'enum', default: 'add',
      enum: ['never', 'add', 'add & remove'],
      desc: '👁️ 洁癖（防遮挡）：保存文档前自动确保暗号下方有足够空行',
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
      desc: '👁️ codelens level：0=none；1=open file；7=全套（open folder/rename/copy/open/qode）',
    },
    'takeOverCodelensStyle': {
      type: 'bool', default: true,
      desc: '👁️ 接管 codelens 样式（红色 13 号大小）',
    },

    // ── 🛸 漫游器（roam） ──
    'szDisplayMode': {
      type: 'enum', default: 'nothing',
      enum: ['nothing', 'size', 'ctime', 'mtime'],
      desc: '🛸 sz 区显示：文件大小 / 创建时间 / 修改时间',
    },
    'sortBy': {
      type: 'enum', default: 'name',
      enum: ['name', 'size', 'ctime', 'mtime'],
      desc: '🛸 排序方式',
    },
    'autoWatchChanges': {
      type: 'bool', default: false,
      desc: '🛸 自动感知外部变化（外部程序修改当前目录时自动刷新列表）',
    },
    'roamAsStartPage': {
      type: 'bool', default: true,
      desc: '🛸 尝试用 qqq Roam 做开始页面',
    },
    'roamName': {
      type: 'string', default: '的梦gaea',
      desc: '🛸 漫游器命名',
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
  };

  var ORDER = Object.keys(REGISTRY);

  // ═══ 状态 ═══
  var _session = {};          // 本次会话覆盖（永不落盘）
  var _cloud = null;          // 云端配置（正版用户拉取）
  var _listeners = [];
  var _log = function () { };

  function _warn(msg) {
    try { console.warn('[qqqPrefs] ' + msg); } catch (e) { /* */ }
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

  // ═══ 取值：session > cloud > default ═══
  function sourceOf(key) {
    if (Object.prototype.hasOwnProperty.call(_session, key)) return 'session';
    if (_cloud && Object.prototype.hasOwnProperty.call(_cloud, key)) return 'cloud';
    return 'default';
  }

  function get(key) {
    var def = REGISTRY[key];
    if (!def) { _warn('unknown key: ' + key); return undefined; }
    if (Object.prototype.hasOwnProperty.call(_session, key)) return _session[key];
    if (_cloud && Object.prototype.hasOwnProperty.call(_cloud, key)) return _cloud[key];
    return def.default;
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
    return { ok: true, value: String(value) };
  }

  // ═══ 写：仅本次会话内存（本地永不保存——铁律）═══
  function set(key, value) {
    var v = _validate(key, value);
    if (!v.ok) { _warn('set(' + key + ') rejected: ' + v.reason); return false; }
    _session[key] = v.value;
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

  // ═══ 云端拉取（正版用户；官网 #profile 保存 → 自动拉取生效）═══
  //   契约就绪前保持关闭：URL 为空 = 明确返回 not-wired（绝不假装成功）
  var CLOUD_PULL_URL = '';   // TODO(prefs-cloud): 服务端配置接口就绪后填入

  var _pulling = null;
  function pullCloud() {
    if (!isActivated()) {
      return Promise.resolve({ ok: false, reason: 'not-activated' });
    }
    if (!CLOUD_PULL_URL) {
      return Promise.resolve({ ok: false, reason: 'endpoint-not-wired' });
    }
    if (_pulling) return _pulling;
    var token = '';
    try {
      if (window.qqqLogin && window.qqqLogin.getAuthToken) token = window.qqqLogin.getAuthToken() || '';
    } catch (e) { /* */ }

    _pulling = fetch(CLOUD_PULL_URL, {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      cache: 'no-store',
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      _pulling = null;
      if (!j || !j.config || typeof j.config !== 'object') {
        return { ok: false, reason: 'bad-response' };
      }
      var next = {};
      var keys = Object.keys(j.config);
      for (var i = 0; i < keys.length; i++) {
        var v = _validate(keys[i], j.config[keys[i]]);
        if (v.ok) next[keys[i]] = v.value;
      }
      _cloud = next;
      _emit(null);
      return { ok: true, count: Object.keys(next).length };
    }).catch(function (e) {
      _pulling = null;
      return { ok: false, reason: 'network', message: e && e.message };
    });
    return _pulling;
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
    onChange: onChange,
  };

  // ★ 已激活用户：启动自动拉取云端配置（未接线时静默 no-op）
  if (isActivated()) {
    try { pullCloud(); } catch (e) { /* */ }
  }
})();
