// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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

    // ---- per-tab metadata (tabId → {folderPath, query}) ----
    var _searchTabMeta = {};

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

        var tab = null;
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
            tab = window.qqqTabs.addGaeaTab('search', tabTitle, buildFn, { closable: true, multi: true });
        } else {
            // Try to reuse existing
            var existing = gaeaGrp.tabs.find(function (t) { return t.gaeaId === 'search'; });
            if (existing) {
                tab = window.qqqTabs.addGaeaTab('search', tabTitle, null, { closable: true });
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
                tab = window.qqqTabs.addGaeaTab('search', tabTitle, buildFn2, { closable: true });
            }
        }

        // Store metadata for tab title persistence
        if (tab) {
            tab._searchFolder = folderPath || '';
            tab._searchQuery = '';
            _searchTabMeta[tab.id] = { folderPath: folderPath || '', query: '' };
            _persistSearchTabs();
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

    // ---- Listen for tab-rename requests from search iframe ----
    window.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'qqqide-search-title') {
            var newPath = e.data.path || '';
            var query = e.data.query || '';
            var folderName = '';
            if (newPath) {
                var p = newPath.replace(/\\/g, '/').replace(/\/$/, '');
                var idx = p.lastIndexOf('/');
                folderName = idx >= 0 ? p.slice(idx + 1) : p;
            }
            var tabTitle;
            if (query) {
                var shortQuery = query.length > 40 ? query.slice(0, 40) + '...' : query;
                tabTitle = '🔍 ' + folderName + ': ' + shortQuery;
            } else {
                tabTitle = folderName ? '🔍 ' + folderName : '🔍 Search';
            }
            // Find which pane contains this iframe and rename its tab
            var srcWindow = e.source;
            var panes = document.querySelectorAll('.qqq-tab-pane');
            for (var i = 0; i < panes.length; i++) {
                var iframe = panes[i]._searchIframe || panes[i].querySelector('iframe[src*="search-ui.html"]');
                if (iframe && iframe.contentWindow === srcWindow) {
                    var tabId = parseInt(panes[i].dataset.tabId);
                    if (tabId && window.qqqTabs && window.qqqTabs.renameGaeaTab) {
                        window.qqqTabs.renameGaeaTab(tabId, tabTitle);
                    }
                    // Update metadata
                    var gaeaGrp2 = window.qqqTabs && window.qqqTabs.getGaeaGroup && window.qqqTabs.getGaeaGroup();
                    if (gaeaGrp2) {
                        var tab2 = gaeaGrp2.tabs.find(function (t) { return t.id === tabId; });
                        if (tab2) {
                            tab2._searchFolder = newPath;
                            tab2._searchQuery = query;
                            _searchTabMeta[tabId] = { folderPath: newPath, query: query };
                        }
                    }
                    _persistSearchTabs();
                    break;
                }
            }
        }
    });

    // ---- Persistence: only.sq3 backed ----
    function _searchOnlyDb() {
        var root = window._workspaceRoot;
        if (!root) {
            try {
                var vp = window.qqqideViewport;
                if (vp) { var m = vp.getMainProject(); if (m && m.path) root = m.path; }
            } catch (_) { }
        }
        if (!root || !window.qgs || typeof window.qgs.project !== 'function') return null;
        return window.qgs.project(root + '/qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
    }

    function _persistSearchTabs() {
        var db = _searchOnlyDb();
        if (!db) return;
        var grp = window.qqqTabs && window.qqqTabs.getGaeaGroup && window.qqqTabs.getGaeaGroup();
        if (!grp) return;
        var tabs = [];
        for (var i = 0; i < grp.tabs.length; i++) {
            var t = grp.tabs[i];
            if (t.gaeaId === 'search' && t.closable !== false) {
                tabs.push({
                    folderPath: t._searchFolder || '',
                    query: t._searchQuery || '',
                    title: t.title
                });
            }
        }
        db.set('search.tabs', tabs.length > 0 ? tabs : null).catch(function () { });
    }

    var _restoreRetries = 0;
    function _restoreSearchTabs() {
        if (_restoreRetries > 30) return;  // give up after ~18s
        _restoreRetries++;
        var db = _searchOnlyDb();
        if (!db) { setTimeout(_restoreSearchTabs, 600); return; }
        if (!window.qqqTabs || !window.qqqTabs.addGaeaTab) { setTimeout(_restoreSearchTabs, 400); return; }
        db.get('search.tabs').then(function (tabs) {
            if (!Array.isArray(tabs) || tabs.length === 0) return;
            for (var i = 0; i < tabs.length; i++) {
                var t = tabs[i];
                if (!t.folderPath) continue;
                var folderName = '';
                var p = t.folderPath.replace(/\\/g, '/').replace(/\/$/, '');
                var idx = p.lastIndexOf('/');
                folderName = idx >= 0 ? p.slice(idx + 1) : p;
                var tabTitle = t.title || ('🔍 ' + folderName);
                var buildFn = function (pane) {
                    pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
                    var iframe = document.createElement('iframe');
                    iframe.src = '/qqqide/goods/search/search-ui.html';
                    iframe.style.cssText = 'width:100%; height:100%; border:none;';
                    iframe.setAttribute('frameborder', '0');
                    pane.appendChild(iframe);
                    pane._searchIframe = iframe;
                };
                var tab = window.qqqTabs.addGaeaTab('search', tabTitle, buildFn, { closable: true, multi: true });
                if (tab) {
                    tab._searchFolder = t.folderPath;
                    tab._searchQuery = t.query || '';
                    _searchTabMeta[tab.id] = { folderPath: t.folderPath, query: t.query || '' };
                    // Set scope in iframe after load
                    (function (fp, q) {
                        setTimeout(function () {
                            var panes = document.querySelectorAll('.qqq-tab-pane');
                            for (var j = 0; j < panes.length; j++) {
                                var iframe = panes[j]._searchIframe || panes[j].querySelector('iframe[src*="search-ui.html"]');
                                if (iframe && iframe.contentWindow) {
                                    try {
                                        iframe.contentWindow.postMessage({ type: 'qqqide-search-set-scope', path: fp, query: q || '' }, '*');
                                    } catch (_) { }
                                }
                            }
                        }, 600);
                    })(t.folderPath, t.query);
                }
            }
        }).catch(function () { });
    }

    // Periodic persistence to catch tab closes (every 8s)
    setInterval(function () {
        _persistSearchTabs();
    }, 8000);

    // Restore on startup
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(_restoreSearchTabs, 1500);
        });
    } else {
        setTimeout(_restoreSearchTabs, 1500);
    }
})();
