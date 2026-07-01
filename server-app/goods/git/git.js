// ============================================================================
// goods/git/git.js — Git Goods Manifest
//
// 提供：
//   ① A 区面板: Git 快速状态
//   ② X 区 Git tab: 传统 git 操作（status/diff/commit/log/branch）
//
// Timeline 已迁移至独立 BrowserWindow (timeline/diff-window.js)，此处不再保留
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
                    iframe.src = '/qqqide/goods/git/git-ui.html?mode=panel';
                    iframe.style.cssText = 'width:100%;height:100%;border:none;';
                    iframe.setAttribute('frameborder', '0');
                    host.appendChild(iframe);
                    host._gitPanelIframe = iframe;
                }
            },

            // X 区 tabs
            tabs: {
                git: {
                    title: '🔀 Git',
                    closable: true,
                    build: function (pane) {
                        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqqide/goods/git/git-ui.html?mode=git';
                        iframe.style.cssText = 'width:100%;height:100%;border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                        pane._gitIframe = iframe;
                    }
                }
            },

            commands: ['git.openGit'],
            provides: ['git'],
            uses: []
        });
    }
})();
