// ============================================================================
// core/entitlement.js — 正版验证唯一真理机器（2026-09-07）
//   一切「激活/VIP 专属功能」门（显示楼层 32/64、no-watermark、roam-name、byok）必须走本机:
//   功能注册表一行声明 → canUse（本地缓存同步）/ refresh（唯一现查通道）/ guard（标准拒绝 UX）。
//   ★ 唯一通道铁律：全项目「向服务端要激活状态」只有一条路 = qqqEntitlement.refresh()——
//     消费方禁直调 qqqLogin.checkPurchased（那是真值层，本机是它的唯一调用者）；禁另写探测请求。
//     现查成本三闸内建于本机（消费方零参数即最优）:
//       ① 已激活短路 —— 本地缓存 true 恒零请求（激活事实即时落盘，重启依旧零请求）
//       ② 在飞复用 —— 并发触发只发一次网络（真值层单飞）
//       ③ 合并窗 —— 同一档内最多一次：手势档 10s / 背景档 60s（唯一常量在本机）
//     网络失败不写新鲜戳（不把「没查到」当「已查过」），下次照常真查。
//   ★ 激活页回来自解锁：openActivation 武装一次性「回窗核查」——窗口重新获得焦点且距武装
//     ≥1.2s → 真查一次 → 命中即广播（各门/锁 UI 即时解灰，免点免重启）；未命中不重试。
//   真值校验唯一源 = window.qqqLogin（isPurchased 本地缓存 + checkPurchased 服务端确认）；本机只收敛
//   「门 + 现查策略 + 激活页 URL」，不重复造真值、不做 tier/角色/灰度重框架。
//   诚实边界: 客户端门是 UX 门——有服务端成本的功能（如云端去水印）真正裁决
//   在服务端计费点，本机只管门面一致 + 诚实提示。
//   挂载于主窗口 index.html（login.js 之后）；iframe 消费方走 parent.qqqEntitlement。
// ============================================================================
(function () {
  'use strict';

  // ★ 激活页 / 个人中心 URL 唯一真理源 —— 全项目禁止第二处硬编码
  //   （迁移对象: settings.js 楼层守卫、shell-menu.js 激活行；gaea-host GH HEALTH
  //     落地页品牌链接非激活门，不收敛）
  //   2026-09-28 设置本地化：官网「设置」标签移除——openProfile 优先转客户端设置中心（qqqCenter），
  //   PROFILE_URL 降为旧载荷回退；ACT_URL（激活页）语义不变。
  var ACT_URL = 'https://www.gh555.com/gaea/d/qqqide?lang=zh#price';
  var PROFILE_URL = 'https://www.gh555.com/gaea/d/qqqide?lang=zh#profile';

  // ★ 现查合并窗（唯一常量；消费方零参数即手势档——禁在各处另写窗口数值）
  //   GESTURE_MS: 用户显式手势（点 VIP 档 / 点启用 / 展开菜单 / 打开设置中心）
  //   AMBIENT_MS: 背景静默复查（面板探活等非点击场景）
  var GESTURE_MS = 10000;
  var AMBIENT_MS = 60000;
  // 回窗核查最小离开时长（同一次手势内的焦点抖动不算「从激活页回来」）
  var ARM_MIN_LEAVE_MS = 1200;

  // ★ 功能注册表 —— 新 VIP 功能 = 一行（值域校验/展示形态留在消费方，与权限门分离）
  var FEATURES = {
    'floor-cap-32': 1,
    'floor-cap-64': 1,
    'no-watermark': 1,  // 消除相框水印（2026-09-28 设置本地化：客户端行为门 = 设置中心 💎 行；真正裁决在服务端计费点）
    'roam-name': 1,     // 自定义漫游名字（2026-09-29：Roam 常驻标签标题可改；未激活/未设置恒「Roam」+ set 拒绝）
    'byok': 1           // 自带 API Key / 本地模型（2026-10-06：BYOK 层启用/发送/管线门 + intercept 纵深；平台代理通道另有服务端真裁决）
  };

  function _login() { return window.qqqLogin || null; }
  function _has(feat) { return FEATURES[feat] === 1; }
  // 激活真值（同步；禁在本文件外复制这段判定）
  function _purchased() {
    var login = _login();
    return !!(login && login.isPurchased && login.isPurchased());
  }

  // 外部浏览器打开（唯一外部通道；与全站 _blank 拦截同款降级双保险）
  function _open(url) {
    var bridge = window.qqqideBridge;
    try {
      if (bridge && bridge.shell && bridge.shell.openExternal) {
        bridge.shell.openExternal(url);
        return;
      }
    } catch (e) { }
    try { window.open(url, '_blank'); } catch (e) { }
  }

  // ── 激活页回来自解锁：武装 + 回窗一次性核查 ──
  var _armAt = 0;
  var _armWired = false;
  function _armReturn() {
    _armAt = Date.now();
    if (_armWired) return;
    _armWired = true;
    var kick = function () {
      if (!_armAt) return;
      if (Date.now() - _armAt < ARM_MIN_LEAVE_MS) return;
      try { if (document.visibilityState === 'hidden') return; } catch (e) { }
      _armAt = 0;               // 一次性：无论命中与否都撤武装（未激活不反复打服务端）
      if (_purchased()) return; // 期间别处已解锁（onChange 已广播）
      api.refresh({ force: true });
    };
    try { window.addEventListener('focus', kick); } catch (e) { }
    try { document.addEventListener('visibilitychange', kick); } catch (e) { }
  }

  var api = {
    // 同步判定（登录会话内本地缓存真值，零网络）
    canUse: function (feat) {
      if (!_has(feat)) return false;
      return _purchased();
    },
    // 同步「是否是激活用户」（无功能位语义，供偏好层等中性判定；禁消费方自读 qqqLogin）
    isActivated: function () { return _purchased(); },
    // ★ 唯一现查通道（全项目唯一）：向服务端确认激活态 → Promise<boolean>
    //   opts.force        无视合并窗真发（仅一次性事件：激活页回来自解锁）
    //   opts.mode          'ambient' = 背景档合并窗（60s）；省略 = 手势档（10s）
    //   opts.fresh        自定义合并窗 ms（一般不需要，优先用 mode）
    refresh: function (opts) {
      opts = opts || {};
      var login = _login();
      if (!login || !login.checkPurchased || !login.isPurchased) return Promise.resolve(_purchased());
      if (_purchased()) return Promise.resolve(true);   // 已激活短路：零请求
      var fresh = (opts.force === true) ? 0
        : (typeof opts.fresh === 'number' ? opts.fresh
          : (opts.mode === 'ambient' ? AMBIENT_MS : GESTURE_MS));
      return Promise.resolve(login.checkPurchased(true, fresh)).then(_purchased, _purchased);
    },
    // 兼容旧签名（check(feat, force)）；新代码直接用 refresh / guard
    check: function (feat, force) {
      return api.refresh({ force: force === true }).then(function () { return api.canUse(feat); });
    },
    // 门卫: 允许 → resolve(true)；拒绝 → onDeny（消费方红字等）+ 外部浏览器激活页 → resolve(false)
    //   默认手势档合并窗（点选即现查，连点只发一次）；opts.onDeny / opts.mode / opts.force
    guard: function (feat, opts) {
      opts = opts || {};
      if (api.canUse(feat)) return Promise.resolve(true);
      var deny = function () {
        if (typeof opts.onDeny === 'function') { try { opts.onDeny(); } catch (e) { } }
        api.openActivation();
      };
      var login = _login();
      if (!login || !login.checkPurchased) { deny(); return Promise.resolve(false); }
      return api.refresh({
        force: opts.force === true,
        mode: opts.mode,
        fresh: (typeof opts.freshMs === 'number' && opts.freshMs > 0) ? opts.freshMs : undefined
      }).then(function (ok) {
        if (ok) return true;
        deny();
        return false;
      }, function () { deny(); return false; });
    },
    // 唯一打开入口（菜单激活行/设置守卫共用；禁旁路 openExternal 激活页）
    //   打开即武装回窗核查：用户在浏览器完成激活 → 切回 IDE 自动解锁
    openActivation: function () { _armReturn(); _open(ACT_URL); },
    // ★ 2026-09-28 设置本地化：「已激活」入口优先打开客户端设置中心（qqqCenter = 云同步 + 设置全量本地化）；
    //   模块缺失（旧载荷）回退官网 #profile（URL 常量保留 = URL 唯一源）
    openProfile: function () {
      try { if (window.qqqCenter && window.qqqCenter.open) { window.qqqCenter.open(); return; } } catch (e) { }
      _open(PROFILE_URL);
    },
    // 登录/激活状态变更订阅（登录、登出、激活成功、跨窗口推送均触发 → UI 重渲染/解灰）
    onChange: function (fn) {
      var login = _login();
      if (login && login.onStateChange) {
        try { return login.onStateChange(fn); } catch (e) { }
      }
      return function () { };
    }
  };

  window.qqqEntitlement = api;
})();
