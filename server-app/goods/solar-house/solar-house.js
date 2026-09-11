// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/solar-house/solar-house.js — Solar House goods manifest（v4 读取器化终局架构）
//
// ★ 一万年终局架构（2026-09-09 定案）: 客户端 = 纯读取器。
//   - 游戏页面 100% 托管于服务器静态目录（https://cnk.gh555.com/static/solar/），
//     页面内含版本自更逻辑（同源 fetch ver.json → 版本变 → 整页 ?v= 滚新）。
//     服务器改玩法/修 bug = 替换静态文件 + bump ver.json → 一切旧客户端下次开局自动收敛，
//     客户端零升级、零三处同步、零 SW bump——本文件与菜单 manifest 永不再随玩法变更。
//   - 玩法规则 = 服务器权威陪跑监督（v4: 客户端同种子同代码本地镜像 25Hz 逐帧跑，
//     1s 一批事件上行, 服务器同种子重放 + 分数/HP 事后监督; 违规 = 本局中断不进榜）。
//   - token 交接（跨源 iframe 读不到 parent）: 页面就绪 → parent.postMessage 请求 →
//     本脚本（主窗口上下文）校验来源域名后回发 qqqLogin.getAuthToken()。
//   - ★ F88 客户端版本门槛（2026-09-10）: 回包同时上报本客户端版本（ver）→ 页面比对
//     服务器下限（ver.json.min_client）→ 低于下限一律拦截（不准许打开/游玩）。
//     旧客户端（≤0.3.222）不走本页（本地旧页面 + v3 旧通道），由服务端 v3 闸门直接拒绝。
// 玩法/协议规格唯一源: gaea/docs/Solar House 设计.md + internal/solar/v4param.go
// ============================================================================
(function () {
  'use strict';

  var SOLAR_ORIGIN = 'https://cnk.gh555.com'; // 游戏页部署域（同源 API/WS/静态）

  // ── token 桥: 远程游戏页跨源认证交接（一次性请求 + 变更推送） ──
  function authToken() {
    try {
      var w = window;
      while (w && !(w.qqqLogin && w.qqqLogin.getAuthToken)) w = w.parent;
      if (w && w.qqqLogin && w.qqqLogin.getAuthToken) return w.qqqLogin.getAuthToken() || '';
    } catch (_) { }
    return '';
  }
  // ── 本客户端版本（版本门槛上报用; 与左下角/ai-gateway 同源 = versions.json id）──
  function clientVer() {
    try {
      if (window.qqqBootInfo && window.qqqBootInfo.version) {
        var v = String(window.qqqBootInfo.version).replace(/^v/i, '').trim();
        if (v && v !== '?') return v;
      }
    } catch (_) { }
    try {
      var el = document.getElementById('qqq-status-version');
      if (el) {
        var t = (el.textContent || '').replace(/^v/i, '').trim();
        if (t && t !== '?') return t;
      }
    } catch (_) { }
    return '';
  }
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'qqq-solar-auth-req') return;
    if (e.origin !== SOLAR_ORIGIN) return; // 只认服务器部署域
    try {
      e.source.postMessage({ type: 'qqq-solar-auth', token: authToken(), ver: clientVer() }, e.origin);
    } catch (_) { }
  });

  // ★ F102: 释放中继——游戏页在跨源 iframe 内收不到「左键移到父窗口松开」的 mouseup（跨文档无捕获）→
  //   游戏页 LeftDown 卡死 → 手已松开却静默计数到阈值 = 网络版"自己进入"子弹时间（误入候选根因）。
  //   父窗口捕获 mouseup → postMessage 中继给游戏页做释放兜底（游戏页仅在本页认为已按下时消费;
  //   旧游戏页无此监听 = 零副作用）。
  window.addEventListener('mouseup', function (e) {
    if (e.button !== 0) return;
    try {
      var frs = document.querySelectorAll('iframe');
      for (var i = 0; i < frs.length; i++) {
        if ((frs[i].src || '').indexOf('/static/solar/') >= 0 && frs[i].contentWindow) {
          frs[i].contentWindow.postMessage({ t: 'qqq-solar-release' }, '*');
        }
      }
    } catch (_) { }
  });

  function registerSolarHouse() {
    window.qqqGaea.register({
      id: 'solar-house',
      title: 'Solar House',
      version: '4.0.0',   // 玩法/读卡器版本（服务器 ver.json 同步演进）
      protoVer: 2,       // host 协议声明：gaea-host 闸门拒 >2，必须 = host 支持的协议等级（2），勿写玩法版本号

      // ---- A 区主面板: 远程游戏页（读取器; 页面自更版本, 见文件头注释）----
      panel: {
        url: SOLAR_ORIGIN + '/static/solar/solar.html?v=0'
      },

      // ★ A 区 pin 宽度（gaea-host 通用: 切入记偏好 + pin 300; 切走还原）
      pinW: 300,

      services: {},
      commands: [],
      provides: [],
      uses: [],
    });
  }

  if (!window.qqqGaea) {
    console.warn('[solar-house] gaea host not ready, deferred');
    window.addEventListener('DOMContentLoaded', function () {
      if (window.qqqGaea) registerSolarHouse();
    });
    return;
  }
  registerSolarHouse();
})();
