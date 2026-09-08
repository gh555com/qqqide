// ============================================================================
// core/entitlement.js — 正版验证唯一真理机器（2026-09-07）
//   一切「激活/VIP 专属功能」门（当前: 显示楼层 32/64；将来: 去水印等）必须走本机:
//   功能注册表一行声明 → canUse（本地缓存同步）/ check（服务端确认）/ guard（标准拒绝 UX）。
//   真值校验唯一源 = window.qqqLogin（isPurchased 本地缓存 + checkPurchased 服务端
//   每窗口生命周期一次 + onStateChange 状态广播）；本机只收敛「门」与激活页 URL，
//   不重复造真值、不做 tier/角色/灰度重框架。
//   诚实边界: 客户端门是 UX 门——有服务端成本的功能（如云端去水印）真正裁决
//   在服务端计费点，本机只管门面一致 + 诚实提示。
//   挂载于主窗口 index.html（login.js 之后）；iframe 消费方走 parent.qqqEntitlement。
// ============================================================================
(function () {
  'use strict';

  // ★ 激活页 / 个人中心 URL 唯一真理源 —— 全项目禁止第二处硬编码
  //   （迁移对象: settings.js 楼层守卫、shell-menu.js 激活行；gaea-host GH HEALTH
  //     落地页品牌链接非激活门，不收敛）
  var ACT_URL = 'https://www.gh555.com/gaea/d/qqqide?lang=zh#price';
  var PROFILE_URL = 'https://www.gh555.com/gaea/d/qqqide?lang=zh#profile';

  // ★ 功能注册表 —— 新 VIP 功能 = 一行（值域校验/展示形态留在消费方，与权限门分离）
  var FEATURES = {
    'floor-cap-32': 1,
    'floor-cap-64': 1
    // 'no-watermark': 1   ← 将来有服务端成本的功能在此注册，真正裁决在服务端计费点
  };

  function _login() { return window.qqqLogin || null; }
  function _has(feat) { return FEATURES[feat] === 1; }

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

  var api = {
    // 同步判定（登录会话内本地缓存真值，零网络）
    canUse: function (feat) {
      if (!_has(feat)) return false;
      var login = _login();
      return !!(login && login.isPurchased && login.isPurchased());
    },
    // 服务端确认（共享 qqqLogin 窗口级去重），失败诚实回退本地缓存
    check: function (feat) {
      var login = _login();
      if (!login || !login.checkPurchased) return Promise.resolve(api.canUse(feat));
      return login.checkPurchased().then(function () { return api.canUse(feat); });
    },
    // 门卫: 允许 → resolve(true)；拒绝 → onDeny（消费方红字等）+ 外部浏览器激活页 → resolve(false)
    guard: function (feat, opts) {
      opts = opts || {};
      if (api.canUse(feat)) return Promise.resolve(true);
      var deny = function () {
        if (typeof opts.onDeny === 'function') { try { opts.onDeny(); } catch (e) { } }
        _open(ACT_URL);
      };
      var login = _login();
      if (!login || !login.checkPurchased) { deny(); return Promise.resolve(false); }
      return login.checkPurchased().then(function (ok) {
        if (ok) return true;
        deny();
        return false;
      }).catch(function () { deny(); return false; });
    },
    // 唯一打开入口（菜单激活行/设置守卫共用；禁旁路 openExternal 激活页）
    openActivation: function () { _open(ACT_URL); },
    openProfile: function () { _open(PROFILE_URL); },
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
