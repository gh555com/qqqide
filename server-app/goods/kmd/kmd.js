// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/kmd/kmd.js — Kmd Goods Manifest（v1 行模式终端）
// X 区 tab（同 git）：终端 = 普通 tab editor 形态
// 职责双份：
//   ① goods 注册（X 区 tab，gaea 分组，单例）
//   ② IPC 中转器：主进程 kmd 输出推送 → 对应 iframe postMessage
// iframe 通信协议：
//   iframe → parent: {type:'kmd:ready'} / {type:'kmd:exec', text} / {type:'kmd:kill', restart}
//   parent → iframe: {type:'kmd:init', sessionId, cwd, shellType} / {type:'kmd:out', stream, data}
//                     {type:'kmd:exit', code} / {type:'kmd:restarted'}
// ============================================================================
(function () {
    'use strict';

    if (!window.qqqGaea) {
        window.addEventListener('DOMContentLoaded', function () {
            if (window.qqqGaea) registerKmd();
        });
        return;
    }

    registerKmd();

    function registerKmd() {
        var bridge = window.qqqideBridge;
        var iframes = {}; // sessionId → iframe.contentWindow

        // ── IPC → iframe 转发（单例注册，跨 tab 复用） ──
        var offOut = null, offExit = null, offRest = null;
        if (bridge && bridge.kmd) {
            offOut = bridge.kmd.onOutput(function (m) {
                var w = m && iframes[m.id];
                if (!w) return;
                try { w.postMessage({ type: 'kmd:out', stream: m.stream, data: m.data }, '*'); } catch (_) { }
            });
            offExit = bridge.kmd.onExit(function (m) {
                var w = m && iframes[m.id];
                if (!w) return;
                try { w.postMessage({ type: 'kmd:exit', code: m.code }, '*'); } catch (_) { }
            });
            offRest = bridge.kmd.onRestarted(function (m) {
                var w = m && iframes[m.id];
                if (!w) return;
                try { w.postMessage({ type: 'kmd:restarted' }, '*'); } catch (_) { }
            });
        }

        window.qqqGaea.register({
            id: 'kmd',
            title: 'Kmd',
            version: '1.0.0',
            protoVer: 2,

            // X 区 tabs only — 不在 A 区（同 git）
            tabs: {
                kmd: {
                    title: '⌨ Kmd',
                    closable: true,
                    build: function (pane) {
                        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqqide/goods/kmd/kmd-ui.html';
                        iframe.style.cssText = 'width:100%;height:100%;border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);

                        var sid = 'kmd-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
                        // 工作空间根：主窗口直接读；AI 面板 iframe 设置的是 parent（同窗口）
                        var root = window._workspaceRoot || '';
                        if (!root && window.parent && window.parent._workspaceRoot) root = window.parent._workspaceRoot;

                        // iframe ready → init（带上会话 id / cwd / 默认 shell）
                        var kmdInit = function (e) {
                            if (!e.data || e.data.type !== 'kmd:ready') return;
                            if (e.source !== iframe.contentWindow) return;
                            window.removeEventListener('message', kmdInit);
                            iframes[sid] = iframe.contentWindow;
                            try {
                                iframe.contentWindow.postMessage({ type: 'kmd:init', sessionId: sid, cwd: root, shellType: 'cmd' }, '*');
                            } catch (_) { }
                        };
                        window.addEventListener('message', kmdInit);

                        // iframe → 主进程（执行 / 终止）
                        window.addEventListener('message', function (e) {
                            if (!e.data || e.source !== iframe.contentWindow) return;
                            if (!bridge || !bridge.kmd) return;
                            if (e.data.type === 'kmd:exec') {
                                bridge.kmd.write(sid, String(e.data.text || '')).catch(function () { });
                            } else if (e.data.type === 'kmd:kill') {
                                bridge.kmd.kill(sid, { restart: !!e.data.restart }).catch(function () { });
                            }
                        });

                        // tab 关闭（pane 从 DOM 移除）→ 杀会话
                        var mo = new MutationObserver(function () {
                            if (!pane.isConnected) {
                                mo.disconnect();
                                delete iframes[sid];
                                if (bridge && bridge.kmd) {
                                    bridge.kmd.kill(sid).catch(function () { });
                                }
                            }
                        });
                        mo.observe(pane.parentNode || document.body, { childList: true });

                        pane.__kmdSessionId = sid;
                    }
                }
            },

            commands: ['kmd.open'],
            provides: ['kmd'],
            uses: []
        });
    }
})();
