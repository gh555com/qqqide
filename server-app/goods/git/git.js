// ============================================================================
// goods/git/git.js — Git Goods Manifest
// X 区 Git tab: 全功能 git 操作（不参与 A 区面板）
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
            version: '1.2.1',
            protoVer: 2,

            // X 区 tabs only — 不在 A 区
            tabs: {
                git: {
                    title: '🔀 Git',
                    closable: true,
                    build: function (pane) {
                        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqqide/goods/git/git-ui.html';
                        iframe.style.cssText = 'width:100%;height:100%;border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                    }
                }
            },

            commands: ['git.openGit'],
            provides: ['git'],
            uses: []
        });
    }
})();
