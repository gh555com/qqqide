// ============================================================================
// goods/search/search.js — qqqide Search Goods Manifest
//
// 高性能项目搜索器。注册为 gaea goods，在 X 区 gaea 标签组打开搜索面板。
// 支持多实例：每个文件夹可打开独立搜索标签，标签名 🔍 + 文件夹名。
// 外部触发：AI 视口豆腐块放大镜按钮 → 打开搜索标签 + 自动填入对应目录。
// ============================================================================
(function () {
    'use strict';

    if (!window.qqqGaea) {
        window.addEventListener('DOMContentLoaded', () => {
            if (window.qqqGaea) registerSearch();
        });
        return;
    }

    registerSearch();

    function registerSearch() {
        window.qqqGaea.register({
            id: 'search',
            title: 'Search',
            version: '1.0.0',
            protoVer: 2,

            panel: {
                build: function () { /* no A-zone panel */ }
            },

            tabs: {
                search: {
                    title: '🔍 Search',
                    closable: true,
                    build: function (pane) {
                        pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqqide/goods/search/search-ui.html';
                        iframe.style.cssText = 'width:100%; height:100%; border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                        pane._searchIframe = iframe;
                    },
                },
            },
        });
    }

    // ---- 外部 API: 打开搜索标签并自动填入搜索范围 ----
    // opts.targetFolder: 目标文件夹路径（设为搜索范围）
    // opts.newWindow: true → 总是打开新标签（多实例）；false/省略 → 复用已有
    window.qqqideOpenSearch = function (folderPath, newWindow) {
        if (!window.qqqTabs) return;

        var gaeaGrp = window.qqqTabs.getGaeaGroup();
        if (!gaeaGrp) return;

        // Extract folder name for tab title
        var folderName = '';
        if (folderPath) {
            var p = folderPath.replace(/\\/g, '/').replace(/\/$/, '');
            var idx = p.lastIndexOf('/');
            folderName = idx >= 0 ? p.slice(idx + 1) : p;
        }
        var tabTitle = folderName ? '🔍 ' + folderName : '🔍 Search';

        if (newWindow) {
            // Multi-instance: always create new tab
            var buildFn = function (pane) {
                pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
                var iframe = document.createElement('iframe');
                iframe.src = '/qqqide/goods/search/search-ui.html';
                iframe.style.cssText = 'width:100%; height:100%; border:none;';
                iframe.setAttribute('frameborder', '0');
                pane.appendChild(iframe);
                pane._searchIframe = iframe;
            };
            window.qqqTabs.addGaeaTab('search', tabTitle, buildFn, { closable: true, multi: true });
        } else {
            // Try to reuse existing
            var existing = gaeaGrp.tabs.find(function (t) { return t.gaeaId === 'search'; });
            if (existing) {
                window.qqqTabs.addGaeaTab('search', tabTitle, null, { closable: true });
            } else {
                var def = window.qqqGaea && window.qqqGaea.get && window.qqqGaea.get('search');
                var buildFn2 = null;
                if (def && def.tabs && def.tabs.search && typeof def.tabs.search.build === 'function') {
                    buildFn2 = def.tabs.search.build;
                }
                if (!buildFn2) {
                    buildFn2 = function (pane) {
                        pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqqide/goods/search/search-ui.html';
                        iframe.style.cssText = 'width:100%; height:100%; border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                        pane._searchIframe = iframe;
                    };
                }
                window.qqqTabs.addGaeaTab('search', tabTitle, buildFn2, { closable: true });
            }
        }

        // Wait for iframe to load, then set scope
        setTimeout(function () {
            _setSearchScope(folderPath);
        }, 300);
        setTimeout(function () {
            _setSearchScope(folderPath);
        }, 800);
    };

    function _setSearchScope(folderPath) {
        if (!folderPath) return;
        var panes = document.querySelectorAll('.qqq-tab-pane');
        for (var i = 0; i < panes.length; i++) {
            var iframe = panes[i]._searchIframe || panes[i].querySelector('iframe[src*="search-ui.html"]');
            if (iframe && iframe.contentWindow) {
                try {
                    iframe.contentWindow.postMessage({ type: 'qqqide-search-set-scope', path: folderPath }, '*');
                } catch (_) { }
            }
        }
    }
})();
