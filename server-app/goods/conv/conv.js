// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/conv/conv.js — 上下文背包 Goods
//
// X 区标签由 AI 面板「管理」按钮直接创建（每 quest 独立），不通过 gaea-host 托管。
// 此处仅注册 goods 条目用于命令/扩展点。
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

            commands: ['conv.openCells'],
            provides: [],
            uses: []
        });
    }
})();
