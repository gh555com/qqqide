// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/rage/rage.js — rage goods manifest
//
// rage = q3 移植集合。包含:
//   - A 区面板: 剪切板历史 + 船长卡片 (q4)
//   - X 区 tab: roam 资源管理器 (q2)
//   - 后台服务已迁移至 core/ (paste-router / anchor-map / content-widget / frame-renderer)
// ============================================================================
(function () {
  'use strict';

  if (!window.qqqGaea) {
    console.warn('[rage] gaea host not ready, deferred');
    window.addEventListener('DOMContentLoaded', () => {
      if (window.qqqGaea) registerRage();
    });
    return;
  }

  registerRage();

  function registerRage() {
    window.qqqGaea.register({
      id: 'rage',
      title: 'rage',
      version: '1.0.0',

      // ---- A 区主面板 ----
      panel: {
        url: '/qqqide/goods/rage/rage.html'
      },

      // ---- X 区 gaea tab: roam 资源管理器 ----
      tabs: {
        roam: {
          title: 'roam',
          closable: false,
          build: function (pane) {
            pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
            var iframe = document.createElement('iframe');
            iframe.src = '/qqqide/goods/file-explorer/q2-roam.html';
            iframe.style.cssText = 'width:100%; height:100%; border:none;';
            iframe.setAttribute('frameborder', '0');
            pane.appendChild(iframe);
          },
        },
      },

      // 后台服务已全量迁移至 core/ (paste-router / anchor-map / content-widget / frame-renderer)
      services: {},

      // ---- 全局命令 ----
      commands: [
        'rage.exportDoc',
        'rage.pure',
        'rage.exportZip',
      ],

      // ---- 跨 goods 能力声明 (预留) ----
      provides: ['clipboard', 'audio', 'weave', 'video'],
      uses: [],
    });

    // [silent] rage registered
  }
})();
