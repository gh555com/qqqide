// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/search/search.js — qqqide search goods manifest
//
// 高性能项目搜索器。注册为 gaea goods，在 X 区 gaea 标签组打开搜索面板。
// 支持多实例：每个文件夹可打开独立搜索标签，标签名 = 手绘图标(search) + 文件夹名
//   （图标挂载 = core/tab-manager.js TAB_ICON_MAP，非本文件职责）。
// 外部触发：AI 视口豆腐块放大镜按钮 → 打开搜索标签 + 自动填入对应目录。
//
// ★ 投递契约（唯一发送入口 = _postToTab，定向到单卡；禁广播——跨卡污染根因）：
//   tab→iframe { type:'qqqide-search-set-scope', path, query, run, focus }
//     path=搜索范围（变了才写）；query=回填搜索词（字符串即写，绝不触发搜索）；
//     run=true 才执行搜索 —— 唯一自动搜索开关（恢复/仅设范围一律不带）；
//     focus=true 才聚焦搜索框（恢复不抢焦点）。
//   iframe→tab { type:'qqqide-search-title', path, query }（标签标题随搜索上下文）。
//   iframe 未建（懒建卡未激活）/未真就绪 → 存 tab._searchPending 单一待发槽，
//   构建完成 load 时补发（最新覆盖——同一意图绝不重复执行）。
//   ★ 就绪唯一判定 = _iframeReady（非 about:blank + readyState complete + 搜索卡真身就位）——
//     禁以 readyState 单独判就绪：初始空文档恒为 complete，消息会被空文档吞掉。
// ★ 恢复 ≠ 搜索：重启恢复的卡只回填范围 + 搜索词，停在空闲态（回车才搜）；
//   恢复卡懒建（tab-manager opts.lazy，未激活连 iframe 都不建）+ 不抢活跃标签/焦点。
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
            title: 'search',
            version: '1.0.0',
            protoVer: 2,

            tabs: {
                search: {
                    title: 'search',
                    closable: true,
                    // ★ 多实例：每次「打开」= 再开一个新标签（菜单行2 按钮同语义；单例即弃）
                    multi: true,
                    build: _buildSearchPane,
                },
            },
        });
    }

    // ---- per-tab metadata (tabId → {folderPath, query}) ----
    var _searchTabMeta = {};

    // ---- 面板构建（唯一构建体；tab-manager 懒建卡首次激活时回调）----
    function _buildSearchPane(pane, tab) {
        pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
        var iframe = document.createElement('iframe');
        iframe.src = '/qqqide/goods/search/search-ui.html';
        iframe.style.cssText = 'width:100%; height:100%; border:none;';
        iframe.setAttribute('frameborder', '0');
        // ★ 就绪信号 = load（监听器先于导航完成挂上 → 此后定向投递必达接收端监听器）
        iframe.addEventListener('load', function () {
            iframe._srchLoaded = true;
            _flushPending(tab, iframe);
        });
        pane.appendChild(iframe);
        pane._searchIframe = iframe;
    }

    // ---- 投递机：定向单卡（禁广播）；iframe 未建/未加载 → 单一待发槽，load 补发 ----
    function _iframeOf(tabId) {
        var pane = document.querySelector('.qqq-tab-pane[data-tab-id="' + tabId + '"]');
        if (!pane) return null;
        return pane._searchIframe || pane.querySelector('iframe[src*="search-ui.html"]');
    }
    // ★ 真就绪判定（唯一）：初始 about:blank 的 readyState 恒为 'complete'——若据此判就绪，
    //   消息会投给空文档被吞掉（待发槽已被清空 → 真文档 load 时不再补发 → 搜索范围静默退回主项目）。
    //   故必须同时满足：非 about:blank + readyState complete + 搜索卡真身已就位（脚本尾 message 监听已挂）。
    function _iframeReady(iframe) {
        if (!iframe) return false;
        if (iframe._srchLoaded) return true;
        try {
            var w = iframe.contentWindow, d = w && w.document;
            if (!d) return false;
            var href = String(w.location.href || '');
            if (!href || href === 'about:blank') return false;   // 仍是初始空文档
            if (d.readyState !== 'complete') return false;
            if (!d.getElementById('sp')) return false;           // search-ui 未就位（监听未挂 → 投递即丢）
            iframe._srchLoaded = true;
            return true;
        } catch (_) { return false; }
    }
    // 投递成功才清待发槽；未真就绪一律保留（load 主路补发）
    function _flushPending(tab, iframe) {
        var msg = tab && tab._searchPending;
        if (!msg) return false;
        if (!_iframeReady(iframe)) return false;
        tab._searchPending = null;
        try { iframe.contentWindow.postMessage(msg, '*'); }
        catch (_) { tab._searchPending = msg; return false; }
        return true;
    }
    function _tryFlush(tab) {
        if (!tab || !tab._searchPending) return;
        var iframe = _iframeOf(tab.id);
        if (!iframe) return;   // 懒建卡未激活（iframe 未建）→ 留待激活构建后 load 补发
        _flushPending(tab, iframe);
    }
    function _postToTab(tab, msg) {
        if (!tab) return;
        tab._searchPending = msg;
        _tryFlush(tab);
        setTimeout(function () { _tryFlush(tab); }, 400);    // 加载竞态兜底（主路 = load 事件）
        setTimeout(function () { _tryFlush(tab); }, 1200);
        setTimeout(function () { _tryFlush(tab); }, 3000);    // 冷启动/慢盘兜底（重复投递零副作用：槽已空即 no-op）
    }

    // ---- 外部 API: 打开搜索标签并填入搜索范围（+ 可选执行搜索词）----
    // folderPath: 目标文件夹路径（设为搜索范围）
    // newWindow:  true → 总是打开新标签（多实例）；false/省略 → 复用已有
    // query:      非空 → 打开后执行该搜索（唯一「显式搜索」出口；省略/空 = 只设范围不搜）
    window.qqqideOpenSearch = function (folderPath, newWindow, query) {
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
        var tabTitle = folderName ? folderName : 'search';
        var q = (typeof query === 'string') ? query : '';

        var tab = null;
        if (newWindow) {
            // Multi-instance: always create new tab
            tab = window.qqqTabs.addGaeaTab('search', tabTitle, _buildSearchPane, { closable: true, multi: true });
        } else {
            // Try to reuse existing（duplicate 检查在 addGaeaTab 内 → 命中即激活并返回原卡）
            var existing = gaeaGrp.tabs.find(function (t) { return t.gaeaId === 'search'; });
            if (existing) {
                tab = window.qqqTabs.addGaeaTab('search', tabTitle, null, { closable: true });
            } else {
                tab = window.qqqTabs.addGaeaTab('search', tabTitle, _buildSearchPane, { closable: true });
            }
        }

        // Store metadata for tab title persistence（复用卡：空 query 不清旧词）
        if (tab) {
            tab._searchFolder = folderPath || '';
            if (q) tab._searchQuery = q;
            _searchTabMeta[tab.id] = { folderPath: folderPath || '', query: q || (tab._searchQuery || '') };
            _persistSearchTabs();
            var msg = { type: 'qqqide-search-set-scope', path: folderPath || '', focus: true };
            if (q) { msg.query = q; msg.run = true; }
            _postToTab(tab, msg);
        }
    };

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
                tabTitle = folderName + ': ' + shortQuery;
            } else {
                tabTitle = folderName ? folderName : 'search';
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
        return window.qgs.project(root + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
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
                    title: t.title,
                    active: t.id === grp.activeTabId      // 恢复只活跃这一张（tab-manager opts.activate）
                });
            }
        }
        db.set('search.tabs', tabs.length > 0 ? tabs : null).catch(function () { });
    }

    var _restoreRetries = 0;
    // ★ 恢复 ≠ 搜索（唯一自动搜索开关 = 消息里的 run）：本函数只回填范围 + 搜索词（停空闲态，
    //   回车才搜）；恢复卡懒建（lazy，未激活连 iframe 都不建）+ 不抢活跃标签/焦点。
    function _restoreSearchTabs() {
        if (_restoreRetries > 30) return;  // give up after ~18s
        _restoreRetries++;
        var db = _searchOnlyDb();
        if (!db) { setTimeout(_restoreSearchTabs, 600); return; }
        if (!window.qqqTabs || !window.qqqTabs.addGaeaTab) { setTimeout(_restoreSearchTabs, 400); return; }
        db.get('search.tabs').then(function (tabs) {
            if (!Array.isArray(tabs) || tabs.length === 0) return;
            var pick = null;
            for (var i = 0; i < tabs.length; i++) {
                var t = tabs[i];
                if (!t.folderPath) continue;
                var p = t.folderPath.replace(/\\/g, '/').replace(/\/$/, '');
                var idx = p.lastIndexOf('/');
                var folderName = idx >= 0 ? p.slice(idx + 1) : p;
                var tab = window.qqqTabs.addGaeaTab('search', t.title || folderName, _buildSearchPane, {
                    closable: true, multi: true,
                    lazy: true,             // 未激活的卡连 iframe 都不建（启动期零解析）
                    activate: false         // 一律不抢——活跃回认在循环后单点裁决
                });
                if (!tab) continue;
                tab._searchFolder = t.folderPath;
                tab._searchQuery = t.query || '';
                _searchTabMeta[tab.id] = { folderPath: t.folderPath, query: t.query || '' };
                // 回填走定向投递（懒建卡先入待发槽，首次激活构建完成 load 时补发）
                _postToTab(tab, { type: 'qqqide-search-set-scope', path: t.folderPath, query: t.query || '' });
                if (t.active) pick = tab;     // 与列表同记录原子落盘（同一次写盘 = 内部自洽）
            }
            // 唯一激活点：仅退出时活跃的那张卡恢复活跃（无此卡则维持现状——绝不抢）
            if (pick) {
                var grp2 = window.qqqTabs.getGaeaGroup && window.qqqTabs.getGaeaGroup();
                if (grp2) window.qqqTabs.activateTab(grp2, pick.id);
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
