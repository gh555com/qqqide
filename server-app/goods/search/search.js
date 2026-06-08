// ============================================================================
// goods/search/search.js — qqqide Search Goods Manifest
//
// 高性能项目搜索器。注册为 gaea goods，在 X 区 gaea 标签组打开搜索面板。
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

            // 无 A 区面板 — 搜索只在 X 区 gaea tab 展示
            panel: {
                build: function () { /* no A-zone panel */ }
            },

            // X 区 gaea tab: 搜索面板
            tabs: {
                search: {
                    title: '🔍 Search',
                    closable: true,
                    build: function (pane) {
                        pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqq-app/goods/search/search-ui.html';
                        iframe.style.cssText = 'width:100%; height:100%; border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                        // Store iframe ref for external control (scope auto-fill)
                        pane._searchIframe = iframe;
                    },
                },
            },
        });
    }

    // ---- 外部 API: 打开搜索标签并自动填入搜索范围 ----
    window.qqqideOpenSearch = function (folderPath) {
        // Ensure gaea tab is open
        if (window.qqqTabs) {
            var gaeaGrp = window.qqqTabs.getGaeaGroup();
            var existing = null;
            if (gaeaGrp) {
                existing = gaeaGrp.tabs.find(function (t) { return t.gaeaId === 'search'; });
            }
            if (existing) {
                // Activate existing tab
                window.qqqTabs.addGaeaTab('search', '🔍 Search', null, { closable: true });
            } else {
                // Re-register to create tab
                var def = window.qqqGaea && window.qqqGaea.get && window.qqqGaea.get('search');
                if (!def) {
                    // Tab not yet created, trigger through addGaeaTab
                    window.qqqTabs.addGaeaTab('search', '🔍 Search', function (pane) {
                        pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
                        var iframe = document.createElement('iframe');
                        iframe.src = '/qqq-app/goods/search/search-ui.html';
                        iframe.style.cssText = 'width:100%; height:100%; border:none;';
                        iframe.setAttribute('frameborder', '0');
                        pane.appendChild(iframe);
                        pane._searchIframe = iframe;
                    }, { closable: true });
                }
            }
        }

        // Wait for iframe to load, then set scope
        setTimeout(function () {
            _setSearchScope(folderPath);
        }, 300);
        // Retry in case iframe hasn't loaded yet
        setTimeout(function () {
            _setSearchScope(folderPath);
        }, 800);
    };

    function _setSearchScope(folderPath) {
        if (!folderPath) return;
        var gaeaGrp = window.qqqTabs && window.qqqTabs.getGaeaGroup();
        if (!gaeaGrp) return;
        // Find the search tab pane's iframe
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
