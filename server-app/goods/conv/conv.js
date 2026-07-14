// ============================================================================
// goods/conv/conv.js — Conversation Inspector Goods
//
// 提供：
//   ① X 区 tab: 上下文背包（每格内容一字不漏）
//   ② 功能：格子编辑、选中格子开新对话
// ============================================================================
(function () {
    'use strict';

    if (!window.qqqGaea) {
        window.addEventListener('DOMContentLoaded', function () {
            if (window.qqqGaea) registerConv();
        });
        return;
    }

    registerConv();

    function registerConv() {
        window.qqqGaea.register({
            id: 'conv',
            title: '上下文背包',
            version: '1.0.0',
            protoVer: 2,

            // X 区 tab：全屏工具页
            tabs: {
                conv: {
                    title: '📋 上下文背包',
                    closable: true,
                    build: function (pane) {
                        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqqide/goods/conv/conv-ui.html';
                        iframe.style.cssText = 'width:100%;height:100%;border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                    }
                }
            },

            commands: ['conv.openCells'],
            provides: [],
            uses: []
        });
    }
})();
