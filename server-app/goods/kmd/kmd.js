// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/kmd/kmd.js — kmd goods manifest（v1 行模式终端）
// ★ 2026-08-12: kmd 例外——X 区 file 分组 custom tab（中间/右侧 editor 分组），
//   不再进 gaea 分组。打开入口 = qqqGaea.open('kmd') → def.opener →
//   qqqTabs.openFileCustomTab('kmd', ...)（单例，tab 外观与普通文件一致）。
//   左 gaea 分组「豆腐块遥控器」（ssh 历史/高频命令）为 v1.1 计划，未实现。
// 职责双份：
//   ① goods 注册（opener 路由，打开 file 分组 custom tab，单例）
//   ② IPC 中转器：主进程 kmd 输出推送 → 对应 iframe postMessage
// iframe 通信协议：
//   iframe → parent: {type:'kmd:ready'} / {type:'kmd:exec', text} / {type:'kmd:kill', restart}
//   parent → iframe: {type:'kmd:init', sessionId, cwd, shellType} / {type:'kmd:out', stream, data}
//                     {type:'kmd:exit', code} / {type:'kmd:restarted'} / {type:'kmd:cd', cwd}
// roam 空区 x 键 / 右键 kmd → parent 收到 {type:'qqq-roam-open-kmd', path} → 打开 kmd 并定位到该目录
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
        var _pendingKmdCwd = null; // roam 空区 x 键/右键指定的一次性启动目录

        // ── roam 空区「kmd」→ 打开 kmd 并定位到指定目录（未打开：pending 由 build 消费；已打开：kmd:cd 原地切目录） ──
        window.addEventListener('message', function (e) {
            var d = e.data;
            if (!d || d.type !== 'qqq-roam-open-kmd') return;
            _pendingKmdCwd = d.path || null;
            var hasIframe = Object.keys(iframes).length > 0;
            if (window.qqqGaea) {
                try { window.qqqGaea.open('kmd'); } catch (_) { }
            }
            if (hasIframe) {
                for (var sid in iframes) {
                    try { iframes[sid].postMessage({ type: 'kmd:cd', cwd: _pendingKmdCwd }, '*'); } catch (_) { }
                }
            }
            _pendingKmdCwd = null; // 已消费（build 或 kmd:cd），防下次工具栏打开吃到陈旧目录
        });

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

        // ── 打开 kmd：X 区 file 分组 custom tab（中间/右侧 editor 分组，外观同普通文件标签） ──
        function openKmdTab() {
            if (!window.qqqTabs || !window.qqqTabs.openFileCustomTab) return false;
            window.qqqTabs.openFileCustomTab('kmd', '⌨ kmd', function (pane) {
                pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                var iframe = document.createElement('iframe');
                iframe.src = '/qqqide/goods/kmd/kmd-ui.html';
                iframe.style.cssText = 'width:100%;height:100%;border:none;';
                iframe.setAttribute('frameborder', '0');
                pane.appendChild(iframe);

                var sid = 'kmd-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
                // 工作空间根：主窗口直接读；AI 面板 iframe 设置的是 parent（同窗口）
                // ★ roam 空区指定目录优先（一次性消费，工具栏打开仍回工作空间根）
                var root = _pendingKmdCwd || window._workspaceRoot || '';
                _pendingKmdCwd = null;
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
            }, { closable: true });
            return true;
        }

        window.qqqGaea.register({
            id: 'kmd',
            title: 'kmd',
            version: '1.0.0',
            protoVer: 2,

            // ★ 打开路由：gaea-host.open('kmd') → opener → file 分组 custom tab（2026-08-12）
            opener: function () { return openKmdTab(); },

            commands: ['kmd.open'],
            provides: ['kmd'],
            uses: []
        });
    }
})();
