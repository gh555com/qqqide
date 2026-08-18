// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/kmd/kmd.js — kmd goods manifest（v1 行模式终端）
// ★ 2026-08-12: kmd 例外——X 区 file 分组 custom tab（中间/右侧 editor 分组），
//   不再进 gaea 分组。打开入口 = qqqGaea.open('kmd') → def.opener →
//   qqqTabs.openFileCustomTab('kmd-N', ...)（★ 2026-08-18 多开：customId 自增 + allowMulti，
//   每次点击开新 kmd tab；命名输入框 kmd:title 实时同步标签标题，详见 do/kmd）。
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
        var _tabs = {};   // sessionId → tab（命名同步用，2026-08-18 多开）
        var _kmdSeq = 0;  // kmd tab 自增序号（customId 唯一 + 默认标题序号）
        var lastSid = null; // 最近创建的会话（roam x 键 cd 目标，2026-08-18 多开后不再广播全部）
        var _pendingKmdCwd = null; // roam 空区 x 键/右键指定的一次性启动目录

        // ── roam 空区「kmd」→ 打开 kmd 并定位到指定目录 ──
        // ★ 2026-08-18 多开：已有会话 → 只对最近创建的 kmd 发 kmd:cd 原地切目录；无 → 新建（pending 由 build 消费）
        window.addEventListener('message', function (e) {
            var d = e.data;
            if (!d || d.type !== 'qqq-roam-open-kmd') return;
            _pendingKmdCwd = d.path || null;
            if (lastSid && iframes[lastSid]) {
                try { iframes[lastSid].postMessage({ type: 'kmd:cd', cwd: _pendingKmdCwd }, '*'); } catch (_) { }
                _pendingKmdCwd = null; // 已消费（kmd:cd），防下次工具栏打开吃到陈旧目录
            } else if (window.qqqGaea) {
                try { window.qqqGaea.open('kmd'); } catch (_) { }
            }
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
        // ★ 2026-08-18 多开：customId 自增唯一 + allowMulti → 每次打开新建 kmd tab；
        //   命名输入框 kmd:title → setCustomTabTitle 实时同步标签标题（多 kmd 窗口的基础）
        // ★ 2026-08-18: side 参数——右键「在右/左组再开」重开入口（同组右键菜单 onReopen）
        function openKmdTab(side) {
            if (!window.qqqTabs || !window.qqqTabs.openFileCustomTab) return false;
            _kmdSeq++;
            var customId = 'kmd-' + _kmdSeq;
            var title = _kmdSeq === 1 ? '⌨ kmd' : '⌨ kmd ' + _kmdSeq;
            var tab = window.qqqTabs.openFileCustomTab(customId, title, function (pane) {
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

                // iframe ready → init（带上会话 id / cwd / 默认 shell / 默认标题）
                var kmdInit = function (e) {
                    if (!e.data || e.data.type !== 'kmd:ready') return;
                    if (e.source !== iframe.contentWindow) return;
                    window.removeEventListener('message', kmdInit);
                    iframes[sid] = iframe.contentWindow;
                    _tabs[sid] = tab;
                    lastSid = sid;
                    try {
                        iframe.contentWindow.postMessage({ type: 'kmd:init', sessionId: sid, cwd: root, shellType: 'cmd', title: tab.title }, '*');
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

                // ★ 命名同步（2026-08-18）：kmd-ui 命名输入框 → 标签标题实时同步（tab-manager 侧有边界守卫）
                window.addEventListener('message', function (e) {
                    if (!e.data || e.source !== iframe.contentWindow) return;
                    if (e.data.type !== 'kmd:title') return;
                    var tb = _tabs[sid];
                    if (tb && window.qqqTabs.setCustomTabTitle) window.qqqTabs.setCustomTabTitle(tb.id, String(e.data.title || ''));
                });

                // tab 关闭（pane 从 DOM 移除）→ 杀会话
                var mo = new MutationObserver(function () {
                    if (!pane.isConnected) {
                        mo.disconnect();
                        delete iframes[sid];
                        delete _tabs[sid];
                        if (bridge && bridge.kmd) {
                            bridge.kmd.kill(sid).catch(function () { });
                        }
                    }
                });
                mo.observe(pane.parentNode || document.body, { childList: true });

                pane.__kmdSessionId = sid;
            }, { closable: true, allowMulti: true, group: side || null });
            // ★ 2026-08-18: 右键菜单「在右/左组再开」——goods 自管重开（新会话/标题序号/内部注册表）
            if (tab) {
                tab.onReopen = function (s) { return openKmdTab(s); };
            }
            return !!tab;
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
