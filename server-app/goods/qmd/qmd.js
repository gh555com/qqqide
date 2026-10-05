// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/qmd/qmd.js — qmd goods manifest（ConPTY 真终端，Win10 1809+ 专属）
// ★ 双产品定案（2026-09-07 F100）：kmd（行模式，极致检索）与 qmd（ConPTY，
//   极致交互）= 渲染架构对立的「一个核心两张脸」——同包双 goods 非独立分发。
//   链路：xterm.js 网格渲染 ←IPC→ 主进程会话 ←行协议→ qmd-conpty.exe ←ConPTY→ shell
//   招牌：本地 TUI（vim/top/htop）、REPL（python/node）、交互 CLI（ssh -t）全可用
//   平台边界：Win10 1809+（ConPTY 是 OS API）；Win7/8 永远 kmd 行模式（双轨共存）
// 打开入口 = qqqGaea.open('qmd') → def.opener → qqqTabs.openFileCustomTab('qmd-N', ...)
//   （customId 自增 + allowMulti 多开，同 kmd 模式）
// iframe 通信协议：
//   iframe → parent: {type:'qmd:ready'}（kmd 同款，随后收 qmd:init）
//   parent → iframe: {type:'qmd:init', sessionId, cwd, shellType, cols, rows}
//   iframe → parent: {type:'qmd:focus', on}（tab 可见性 → xterm 聚焦）
//   事件转发（主进程 → iframe）: qmd:session-ready / qmd:out / qmd:exit / qmd:restarted
//   ★ 键入输出不走 parent 中转：iframe 直连 parent.qqqideBridge.qmd
//     （spawn/write/resize/kill 直调主进程，kmd-ui 同款模式）
// ★ 2026-09-27 x 键长按召回（与 kmd 的 qqq-roam-open-kmd 对称）：
//   Roam/全局长按 x（600ms）→ {type:'qqq-roam-open-qmd', path, fileName} 或 window.__qqqQmdOpen(path)
//   → 打开【新】qmd 并定位到该目录；单文件选中 → fileName 会话就绪后预填键入区（不回车）；
//   liftKey='x' → qmd-ui 吞掉残留 x 自动重复（"帮用户抬起 x 键"）。
// ============================================================================
(function () {
    'use strict';

    if (!window.qqqGaea) {
        window.addEventListener('DOMContentLoaded', function () {
            if (window.qqqGaea) registerQmd();
        });
        return;
    }

    registerQmd();

    function registerQmd() {
        // ★ 2026-09-16 mac / 2026-10-05 linux：ConPTY 为 Windows OS API —— 非 Windows 不注册 qmd（终端用 kmd 行模式）
        var _isWin = /Win/i.test(navigator.platform || '');
        if (!_isWin) {
            // ★ 2026-09-27 x 长按优雅退化：非 Windows 无 ConPTY —— 仍须响应召回协议（否则长按 x 成死键）→ 回退 kmd
            window.__qqqQmdOpen = function (path) { try { if (window.__qqqKmdOpen) window.__qqqKmdOpen(path); } catch (_) { } return false; };
            window.addEventListener('message', function (e) {
                var d = e.data; if (!d || d.type !== 'qqq-roam-open-qmd') return;
                try { if (window.__qqqKmdOpen) window.__qqqKmdOpen(d.path || null); } catch (_) { }
            });
            console.log('[qmd] ConPTY 仅 Windows 支持 —— 跳过注册（mac/linux 请用 kmd；x 长按召回已退化到 kmd）');
            return;
        }
        var bridge = window.qqqideBridge;
        var iframes = {}; // sessionId → iframe.contentWindow
        var _tabs = {};   // sessionId → tab（右键再开用）
        var _qmdSeq = 0;  // qmd tab 自增序号
        var _pendingQmd = null; // 一次性启动 {cwd, fileName, liftKey}（roam 长按 x / 全局长按召回指定）

        // ── IPC → iframe 转发（单例注册，跨 tab 复用） ──
        var offReady = null, offOut = null, offExit = null, offRest = null;
        if (bridge && bridge.qmd) {
            offReady = bridge.qmd.onReady(function (m) {
                var w = m && iframes[m.id];
                if (!w) return;
                try { w.postMessage({ type: 'qmd:session-ready', pid: m.pid }, '*'); } catch (_) { }
            });
            offOut = bridge.qmd.onOutput(function (m) {
                var w = m && iframes[m.id];
                if (!w) return;
                try { w.postMessage({ type: 'qmd:out', data: m.data }, '*'); } catch (_) { }
            });
            offExit = bridge.qmd.onExit(function (m) {
                var w = m && iframes[m.id];
                if (!w) return;
                try { w.postMessage({ type: 'qmd:exit', code: m.code, error: m.error }, '*'); } catch (_) { }
            });
            offRest = bridge.qmd.onRestarted(function (m) {
                var w = m && iframes[m.id];
                if (!w) return;
                try { w.postMessage({ type: 'qmd:restarted' }, '*'); } catch (_) { }
            });
        }

        // ── ★ 2026-09-27 x 长按召回（与 kmd 的 qqq-roam-open-kmd 对称）：开放新 qmd 并定位 ──
        //   liftKey='x'：长按来自"按住 x 未抬起"，qmd-ui 需吞掉残留的 x 自动重复（"帮用户抬起 x 键"）
        function _playQmdSfx() {
            try {
                if (typeof _playRoamSfx === 'function') { _playRoamSfx('terminal'); return; }
                if (bridge && bridge.audio) { bridge.audio.play('yz:zs861.mp3').catch(function () { }); }
            } catch (_) { }
        }
        function _openNewQmd(path, fileName, liftKey) {
            _pendingQmd = { cwd: path || null, fileName: fileName || null, liftKey: liftKey || null };
            var ok = false;
            try { ok = openQmdTab(); } catch (_) { }
            if (!ok) _pendingQmd = null;
            if (ok) _playQmdSfx();
            return ok;
        }
        // 全局入口（shell-menu x 键呈递机器长按分支 / shell.js 兜底同款）
        window.__qqqQmdOpen = function (path, fileName) { return _openNewQmd(path, fileName, 'x'); };
        window.addEventListener('message', function (e) {
            var d = e.data;
            if (!d || d.type !== 'qqq-roam-open-qmd') return;
            _openNewQmd(d.path || null, d.fileName || null, 'x');
        });

        // ── 打开 qmd：X 区 file 分组 custom tab（同 kmd 模式） ──
        function openQmdTab(side) {
            if (!window.qqqTabs || !window.qqqTabs.openFileCustomTab) return false;
            _qmdSeq++;
            var customId = 'qmd-' + _qmdSeq;
            var title = _qmdSeq === 1 ? 'qmd' : 'qmd ' + _qmdSeq;
            // ★ 时序陷阱（F84 实锤）：openFileCustomTab 同步执行 renderFn(pane, tab)
            //   → 闭包 var tab 此刻 undefined → 从 renderFn 第二参数取真实 tab
            var tab = window.qqqTabs.openFileCustomTab(customId, title, function (pane, _tab) {
                tab = _tab || tab;
                if (!tab) return false;
                pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                var iframe = document.createElement('iframe');
                iframe.src = '/qqqide/goods/qmd/qmd-ui.html';
                iframe.style.cssText = 'width:100%;height:100%;border:none;';
                iframe.setAttribute('frameborder', '0');
                pane.appendChild(iframe);

                var sid = 'qmd-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
                // ★ 2026-09-27 roam 长按 x / 全局召回指定目录优先（一次性消费，工具栏打开仍回工作空间根）
                var root = (_pendingQmd && _pendingQmd.cwd) || window._workspaceRoot || '';
                var qmdFile = _pendingQmd ? _pendingQmd.fileName : null; // 单文件选中 → 会话就绪后预填键入区
                var qmdLift = _pendingQmd ? _pendingQmd.liftKey : null;  // 'x' → qmd-ui 吞残留 x 重复（帮用户抬起）
                _pendingQmd = null;
                if (!root && window.parent && window.parent._workspaceRoot) root = window.parent._workspaceRoot;

                // tab 可见性 → xterm 聚焦（切回 tab 可直接打字）
                tab._onVisible = function (v) {
                    var w = iframes[sid];
                    if (!w) return;
                    try { w.postMessage({ type: 'qmd:focus', on: !!v }, '*'); } catch (_) { }
                };

                var qmdInit = function (e) {
                    if (!e.data || e.data.type !== 'qmd:ready') return;
                    if (e.source !== iframe.contentWindow) return;
                    window.removeEventListener('message', qmdInit);
                    iframes[sid] = iframe.contentWindow;
                    _tabs[sid] = tab;
                    try {
                        iframe.contentWindow.postMessage({
                            type: 'qmd:init', sessionId: sid, cwd: root,
                            shellType: 'cmd', cols: 120, rows: 30, active: !!tab.active,
                            title: tab.title, // 命名键入框初始值（kmd F77 同款链路）
                            fileName: qmdFile || undefined, // 单文件选中 → 预填键入区（会话就绪后写入，不回车）
                            liftKey: qmdLift || undefined,  // 'x' → 吞掉残留 x 自动重复（帮用户抬起 x 键）
                        }, '*');
                    } catch (_) { }
                };
                window.addEventListener('message', qmdInit);

                // ★ 命名同步（2026-09-08 移植自 kmd F77）：qmd-ui 命名键入框 → 标签标题实时同步
                //   （tab-manager.setCustomTabTitle 侧有边界守卫：空标题忽略 + textContent 更新防注入）
                window.addEventListener('message', function (e) {
                    if (!e.data || e.source !== iframe.contentWindow) return;
                    if (e.data.type !== 'qmd:title') return;
                    var tb = _tabs[sid];
                    if (tb && window.qqqTabs.setCustomTabTitle) window.qqqTabs.setCustomTabTitle(tb.id, String(e.data.title || ''));
                });

                // tab 关闭（pane 从 DOM 移除）→ 杀会话
                var mo = new MutationObserver(function () {
                    if (!pane.isConnected) {
                        mo.disconnect();
                        delete iframes[sid];
                        delete _tabs[sid];
                        if (bridge && bridge.qmd) {
                            bridge.qmd.kill(sid).catch(function () { });
                        }
                    }
                });
                mo.observe(pane.parentNode || document.body, { childList: true });

                pane.__qmdSessionId = sid;
            }, { closable: true, allowMulti: true, group: side || null });
            if (tab) {
                tab.onReopen = function (s) { return openQmdTab(s); };
            }
            return !!tab;
        }

        window.qqqGaea.register({
            id: 'qmd',
            title: 'qmd',
            version: '1.0.0',
            protoVer: 2,

            opener: function () { return openQmdTab(); },

            commands: ['qmd.open'],
            provides: ['qmd'],
            uses: []
        });
    }
})();
