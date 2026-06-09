// ============================================================================
// goods/git/git.js — Git + Timeline Goods Manifest
//
// 双功能 goods：
//   ① Timeline tab (X 区): AI 楼层文件快照 diff 查看器（接收 A4 点击事件）
//   ② Git tab (X 区): 传统 git 操作面板（status/diff/commit/log/branch）
//
// A4 联动: 父窗口 message 'qqq-a4-open-diff' → 打开 Timeline tab → 显示 diff
// ============================================================================
(function () {
    'use strict';

    if (!window.qqqGaea) {
        window.addEventListener('DOMContentLoaded', function () {
            if (window.qqqGaea) registerGit();
        });
        return;
    }

    registerGit();

    function registerGit() {
        window.qqqGaea.register({
            id: 'git',
            title: 'Git',
            version: '1.0.0',
            protoVer: 2,

            // A 区面板: Git 快速状态
            panel: {
                build: function (host) {
                    host.style.cssText = 'width:100%;height:100%;overflow:hidden;';
                    var iframe = document.createElement('iframe');
                    iframe.src = '/qqq-app/goods/git/git-ui.html?mode=panel';
                    iframe.style.cssText = 'width:100%;height:100%;border:none;';
                    iframe.setAttribute('frameborder', '0');
                    host.appendChild(iframe);
                    host._gitPanelIframe = iframe;
                }
            },

            // X 区 tabs
            tabs: {
                timeline: {
                    title: '⏱ Timeline',
                    closable: true,
                    build: function (pane) {
                        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqq-app/goods/git/git-ui.html?mode=timeline';
                        iframe.style.cssText = 'width:100%;height:100%;border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                        pane._timelineIframe = iframe;
                    }
                },
                git: {
                    title: '🔀 Git',
                    closable: true,
                    build: function (pane) {
                        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqq-app/goods/git/git-ui.html?mode=git';
                        iframe.style.cssText = 'width:100%;height:100%;border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                        pane._gitIframe = iframe;
                    }
                }
            },

            commands: ['git.openTimeline', 'git.openGit'],
            provides: ['timeline', 'git'],
            uses: []
        });

        // ---- A4 diff 联动: 监听 AI iframe 的 postMessage ----
        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'qqq-a4-open-diff') return;
            _openTimelineDiff(e.data);
        });

        // ---- 外部 API ----
        window.qqqideOpenTimeline = function (data) {
            _openTimelineDiff(data);
        };
    }

    function _openTimelineDiff(data) {
        // Ensure timeline tab is open
        if (window.qqqTabs) {
            window.qqqTabs.addGaeaTab('timeline', '⏱ Timeline', function (pane) {
                pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                var iframe = document.createElement('iframe');
                iframe.src = '/qqq-app/goods/git/git-ui.html?mode=timeline';
                iframe.style.cssText = 'width:100%;height:100%;border:none;';
                iframe.setAttribute('frameborder', '0');
                pane.appendChild(iframe);
                pane._timelineIframe = iframe;
            }, { closable: true });
        }

        // Send diff data to timeline iframe
        setTimeout(function () { _sendToTimeline(data); }, 200);
        setTimeout(function () { _sendToTimeline(data); }, 600);
    }

    function _sendToTimeline(data) {
        // Find all timeline iframes and send data
        var iframes = document.querySelectorAll('iframe[src*="git-ui.html?mode=timeline"]');
        for (var i = 0; i < iframes.length; i++) {
            try {
                iframes[i].contentWindow.postMessage({
                    type: 'qqqide-show-diff',
                    path: data.path,
                    before: data.before,
                    after: data.after,
                    op: data.op,
                    added: data.added,
                    deleted: data.deleted
                }, '*');
            } catch (_) { }
        }
    }
})();
