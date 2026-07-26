// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// panel-health.js — 模块健康检查（2026-07-14 新增）
//
// 问题：模块 IIFE 加载失败（语法错误/运行时异常）→ prototype 扩展丢失
//       → 下游 typeof xxx === 'function' 优雅降级 → 功能静默死亡，用户零感知
//
// 解决：启动时检查所有关键模块的预期导出是否存在。
//       任一缺失 → 红色横幅告警，列出失败模块名。
//       用户可见，Ctrl+R 热重载修复。
// ============================================================================
(function () {
    'use strict';

    // 等待所有模块加载完成（panel-send.js 最后加载，此处延迟一帧）
    setTimeout(function () {
        var checks = [
            // AI 核心
            { name: 'content-gateway.js', test: function () { return typeof ContentGateway !== 'undefined'; } },
            { name: 'ai-gateway.js', test: function () { return typeof AiGateway !== 'undefined'; } },
            { name: 'tools-defs.js', test: function () { return typeof getTools === 'function'; } },
            { name: 'agent-loop.js (AgentLoop)', test: function () { return typeof AgentLoop !== 'undefined'; } },
            // AgentLoop.prototype 扩展（各子模块追加）
            { name: 'agent-gateway.js (_callGateway)', test: function () { return typeof AgentLoop !== 'undefined' && typeof AgentLoop.prototype._callGateway === 'function'; } },
            { name: 'agent-sse.js (_parseSSE)', test: function () { return typeof AgentLoop !== 'undefined' && typeof AgentLoop.prototype._parseSSE === 'function'; } },
            { name: 'agent-exec.js (_executeToolCallsParallel)', test: function () { return typeof AgentLoop !== 'undefined' && typeof AgentLoop.prototype._executeToolCallsParallel === 'function'; } },
            { name: 'agent-context.js (_rebuildBackpack)', test: function () { return typeof AgentLoop !== 'undefined' && typeof AgentLoop.prototype._rebuildBackpack === 'function'; } },
            { name: 'agent-context.js (_compressContext)', test: function () { return typeof AgentLoop !== 'undefined' && typeof AgentLoop.prototype._compressContext === 'function'; } },
            // 数据层
            { name: 'quest-store.js', test: function () { return typeof questStore !== 'undefined'; } },
            { name: 'card-pool.js', test: function () { return typeof cardPool !== 'undefined'; } },
            { name: 'only-store.js', test: function () { return typeof onlyStore !== 'undefined'; } },
            // 面板
            { name: 'panel-state.js', test: function () { return typeof _panelId !== 'undefined'; } },
        ];

        var failed = [];
        for (var i = 0; i < checks.length; i++) {
            try {
                if (!checks[i].test()) failed.push(checks[i].name);
            } catch (e) {
                failed.push(checks[i].name + ' (threw: ' + (e.message || e) + ')');
            }
        }

        if (failed.length > 0) {
            console.error('[HEALTH] ' + failed.length + ' module(s) failed to load:', failed.join(', '));

            // 红色横幅 — 置顶，不可关闭
            var banner = document.createElement('div');
            banner.id = 'health-banner';
            banner.style.cssText =
                'background:#dc322f;color:#fdf6e3;padding:6px 12px;font-size:12px;text-align:center;' +
                'position:sticky;top:0;z-index:9999;flex-shrink:0;';
            banner.textContent = '⚠ ' + failed.length + ' module(s) failed: ' + failed.slice(0, 3).join(', ') +
                (failed.length > 3 ? ' +' + (failed.length - 3) + ' more' : '') +
                '. Press Ctrl+R to reload.';
            var root = document.getElementById('qqq-main') || document.body;
            root.insertBefore(banner, root.firstChild);
        }

        // 暴露供 DevTools 调试
        window.__qqqHealth = { checks: checks, failed: failed, ok: failed.length === 0 };
    }, 100);
})();
