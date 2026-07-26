// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/kope-a/kope-a.js — kope-a 剪贴板监控 + A 区历史卡片面板
// type: process (后台 q3.py) + panel (A 区卡片面板)
// A 区默认面板 — 将来准许用户选择不同 goods 在 A 区展示
// ============================================================================
(function () {
  'use strict';

  const DEF = {
    id: 'kope-a',
    title: 'kope-a',
    version: '1.0.0',
    type: 'process',
    lifecycle: 'independent',
    audio: { mode: 'independent' },
    allowMultiple: false,

    // 后台进程：Python 剪贴板监控
    process: {
      script: 'goods/kope-a/q3.py',
      runtime: 'python',
    },

    // A 区面板：剪切板历史卡片（筛选框及以下，照抄 Q4）
    panel: {
      url: '/qqqide/goods/kope-a/panel.html'
    },

    // ── A 区插件切换接口（预留）──
    // 将来 goods 可声明 wantsAZone: true 表示希望竞争 A 区展示权。
    // 用户通过 A 区顶部下拉选择当前展示的 goods。
    // 当前仅 kope-a 拥有 A 区面板，故直接展示，无需选择器。
    wantsAZone: true,
  };

  if (!window.qqqGaea) {
    window.addEventListener('DOMContentLoaded', () => {
      if (window.qqqGaea) window.qqqGaea.register(DEF);
    });
    return;
  }

  window.qqqGaea.register(DEF);
})();
