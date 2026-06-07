// ============================================================================
// goods/rage/rage.js — Rage Goods Manifest
//
// Rage = 整个 q3 移植集合。包含:
//   - A 区面板: 剪切板历史 + 船长卡片 (q4)
//   - X 区 tab: Roam 资源管理器 (q2)
//   - 后台服务: paste / codelens / decoration / viewzone / video
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
      title: 'Rage',
      version: '1.0.0',

      // ---- A 区主面板 ----
      panel: {
        url: '/qqq-app/goods/rage/rage.html'
      },

      // ---- X 区 gaea tab: Roam 资源管理器 ----
      tabs: {
        roam: {
          title: 'Roam',
          closable: false,
          build: function (pane) {
            pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
            var iframe = document.createElement('iframe');
            iframe.src = '/qqq-app/goods/file-explorer/q2-roam.html';
            iframe.style.cssText = 'width:100%; height:100%; border:none;';
            iframe.setAttribute('frameborder', '0');
            pane.appendChild(iframe);
          },
        },
      },

      // ---- 后台服务: Monaco 增强 ----
      services: {
        paste: {
          start: function (ctx) {
            if (window.qqqRagePaste && window.qqqRagePaste.start) {
              window.qqqRagePaste.start(ctx);
            }
          },
          stop: function () {
            if (window.qqqRagePaste && window.qqqRagePaste.stop) {
              window.qqqRagePaste.stop();
            }
          },
        },
        codelens: {
          start: function (ctx) {
            if (window.qqqRageCodelens && window.qqqRageCodelens.start) {
              window.qqqRageCodelens.start(ctx);
            }
          },
          stop: function () {
            if (window.qqqRageCodelens && window.qqqRageCodelens.stop) {
              window.qqqRageCodelens.stop();
            }
          },
        },
        decoration: {
          start: function (ctx) {
            if (window.qqqRageDecoration && window.qqqRageDecoration.start) {
              window.qqqRageDecoration.start(ctx);
            }
          },
          stop: function () {
            if (window.qqqRageDecoration && window.qqqRageDecoration.stop) {
              window.qqqRageDecoration.stop();
            }
          },
        },
        viewzone: {
          start: function (ctx) {
            if (window.qqqRageViewzone && window.qqqRageViewzone.start) {
              window.qqqRageViewzone.start(ctx);
            }
          },
          stop: function () {
            if (window.qqqRageViewzone && window.qqqRageViewzone.stop) {
              window.qqqRageViewzone.stop();
            }
          },
        },
        video: {
          start: function (ctx) {
            if (window.qqqRageVideo && window.qqqRageVideo.start) {
              window.qqqRageVideo.start(ctx);
            }
          },
          stop: function () {
            if (window.qqqRageVideo && window.qqqRageVideo.stop) {
              window.qqqRageVideo.stop();
            }
          },
        },
      },

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
