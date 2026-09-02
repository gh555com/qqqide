// ============================================================================
// goods/dm/dm.js — inbox goods manifest
//
// 纯 X 区 gaea 分组标签，不占 A 区，不出现在品牌下拉。
// 工具栏 inbox 按钮 + 未读徽章由 gaea-host.js 管理。
// ============================================================================
(function () {
  'use strict';

  if (!window.qqqGaea) {
    window.addEventListener('DOMContentLoaded', function () {
      if (window.qqqGaea) registerInbox();
    });
    return;
  }

  registerInbox();

  function registerInbox() {
    window.qqqGaea.register({
      id: 'inbox',
      title: 'inbox',
      version: '2.2.0',  // 2026-09-01: 对话备注昵称（双方独立，仅自己可见）
      protoVer: 2,

      // 仅 X 区标签 — 无 A 区 panel
      tabs: {
        inbox: {
          title: '📬 inbox',
          closable: true,
          build: function (pane) {
            pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
            var iframe = document.createElement('iframe');
            iframe.src = '/qqqide/goods/dm/dm-ui.html';
            iframe.style.cssText = 'width:100%;height:100%;border:none;';
            iframe.setAttribute('frameborder', '0');
            pane.appendChild(iframe);
          }
        }
      }
    });
  }
})();
