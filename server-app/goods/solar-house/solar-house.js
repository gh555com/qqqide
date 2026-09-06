// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/solar-house/solar-house.js — Solar House goods manifest
//
// Solar House = 服务器真理竖版躲避游戏（A 区面板，远程游戏非本地进程）:
//   - 菜单行2 qqq 下拉第二项（紧随 kope-a）
//   - 投 1 ge 开局 / 死亡可再投 1 ge 续命 / UTC 日榜前 10 发奖
//   - pinW 300: 切入 A 区 pin 300px（gaea-host 通用 pin 机制，切走还原用户偏好）
//   - 全部玩法逻辑在 gaea 服务器（客户端纯渲染 + 遥控杆，零逻辑零随机）
// 玩法/协议规格唯一源: gaea/docs/Solar House 设计.md
// ============================================================================
(function () {
  'use strict';

  if (!window.qqqGaea) {
    console.warn('[solar-house] gaea host not ready, deferred');
    window.addEventListener('DOMContentLoaded', function () {
      if (window.qqqGaea) registerSolarHouse();
    });
    return;
  }

  registerSolarHouse();

  function registerSolarHouse() {
    window.qqqGaea.register({
      id: 'solar-house',
      title: 'Solar House',
      version: '1.0.0',
      protoVer: 2,

      // ---- A 区主面板（远程游戏页面）----
      panel: {
        url: '/qqqide/goods/solar-house/solar.html'
      },

      // ★ A 区 pin 宽度（gaea-host 通用: 切入记偏好 + pin 300; 切走还原）
      pinW: 300,

      services: {},
      commands: [],
      provides: [],
      uses: [],
    });
  }
})();
