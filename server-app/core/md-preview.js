// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// md-preview.js — Markdown 实时预览机器（主窗口侧，2026-09-20）
//
// 定位：编辑器伴生「侧栏预览」——不做弹窗（弹窗留给快照评审 git/timeline：
//   那些是取快照来评审的一次性模态；md 预览是编辑的伴生视图，任务本质不同）。
//   预览 tab 落 X 区对侧 file 分组（custom tab，同 kmd/dm 范式）：
//     编辑器在左组 → 预览去右组；编辑器在右组 → 预览去左组；只有一组 → 新建对侧组。
//
// 数据流（唯一真源 = 编辑器 Monaco model）：
//   ① 该文件有编辑器 → 订阅 model.onDidChangeContent（150ms 防抖；大文档 450ms）
//      → 脏缓冲区实时同步（未保存也可见）；model 销毁（编辑器 tab 全关）→ 降级磁盘模式
//   ② 磁盘模式 → bridge.fs.read（编码机器）读盘；窗口聚焦 + 预览 tab 激活时 stat
//      比对 mtime/size 增量重读（外部修改自愈）
//   ③ 内容经 postMessage 推给 mdview iframe（seq 单调，latest-wins 防乱序）
//
// 唯一渲染机 = core/md-render.js（window.renderMarkdown）——与 AI 面板共享，禁第二套。
// 渲染承载 = goods/mdview/mdview.html（iframe 隔离；主题走 qqqide-theme-change 标准协议；
//   表格 View/图片点击 → qqqide-overlay 消息 → 主窗口 shell-overlay 悬浮预览层，零新协议）。
//
// 打开入口：① 手动——编辑器右下角悬浮 👁（editor-breadcrumb.js）/ 键盘 Ctrl+K V（Monaco action，不进菜单）
//   ② 自动（设置 mdview.auto，出厂默认开）——任何成功「打开文件」请求命中 .md → 确保其预览存在
// 契约：同文件单预览（重复触发 = 激活已有 tab）；tab 关闭 → 全量清理（listener/定时器/pending）。
// ★ 自动预览 v4 极简语义（2026-09-21 定案）：打开动作 ⇒ 预览在；已有预览零动作（不激活不抢焦点）；
//   不管关闭、不接标签切换、零隐藏状态（无账本/无落定定时器/无 sessionStorage）；恢复期由 tab-manager 静默。
// ============================================================================

(function () {
    'use strict';

    var _IFRAME_SRC = '/qqqide/goods/mdview/mdview.html';
    // 超大文档守卫：>1.5M 字符停自动实时（提示条手动刷新仍可用）
    var MDVIEW_MAX_CHARS = 1500000;
    var _FMTS = /\.(md|markdown)$/i;

    var _views = {};        // normPath → view
    var _actions = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

    function _bridge() { return window.qqqideBridge; }
    function _i(key, fb) { return (window._i ? window._i(key, fb) : fb); }
    function _norm(p) { return String(p || '').replace(/\\/g, '/'); }
    function _baseName(p) { var s = _norm(p); var i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
    function _isMd(p) { return _FMTS.test(String(p || '')); }

    // 编辑器查找：原格式 miss → 反斜杠/正斜杠变体重试（路径格式双式兜底）
    function _getEd(p) {
        if (!window.qqqEditor || !window.qqqEditor.getEditorForFile) return null;
        var ed = null;
        try { ed = window.qqqEditor.getEditorForFile(p); } catch (_) { }
        if (ed) return ed;
        var alt = p.indexOf('\\') >= 0 ? p.replace(/\\/g, '/') : p.replace(/\//g, '\\');
        try { ed = window.qqqEditor.getEditorForFile(alt); } catch (_) { }
        return ed || null;
    }

    function _fileGroups() {
        try { return (window.qqqTabs.getGroups() || []).filter(function (g) { return g.type === 'file'; }); } catch (_) { return []; }
    }

    function _viewBySource(src) {
        for (var k in _views) {
            var v = _views[k];
            if (v && v.iframe && v.iframe.contentWindow === src) return v;
        }
        return null;
    }

    function _post(view, msg) {
        try {
            if (view.iframe && view.iframe.contentWindow) {
                view.iframe.contentWindow.postMessage(msg, '*');
            }
        } catch (_) { }
    }

    // ready 前发送 → 挂起为 pending（latest-wins，ready 后 flush）
    function _send(view, msg) {
        if (view.destroyed) return;
        if (!view.ready) { view.pending = msg; return; }
        _post(view, msg);
    }

    // ---- 内容投递：内容不变零重渲染；超限降级状态 ----
    function _deliver(view, content, mode) {
        if (view.destroyed) return;
        if (typeof content !== 'string') content = '';
        if (content.length > MDVIEW_MAX_CHARS) { _deliverStatus(view, 'too-large'); return; }
        if (view.lastSent === content && view.lastStatus === 'ok') return;
        view.lastSent = content;
        view.lastStatus = 'ok';
        _send(view, { type: 'mdview:update', seq: ++view.seq, status: 'ok', mode: mode, content: content });
    }

    function _deliverStatus(view, status) {
        if (view.destroyed) return;
        if (view.lastStatus === status) return;
        view.lastStatus = status;
        view.lastSent = null;   // 状态恢复后必须重发（清内容去重基线）
        _send(view, { type: 'mdview:update', seq: ++view.seq, status: status });
    }

    // ---- 数据源 ----
    function _dropListeners(view) {
        for (var i = 0; i < view.listeners.length; i++) {
            try { view.listeners[i].dispose(); } catch (_) { }
        }
        view.listeners.length = 0;
    }

    function _bindSource(view) {
        var ed = _getEd(view.filePath);
        var model = null;
        try { model = (ed && ed.getModel) ? ed.getModel() : null; } catch (_) { model = null; }
        if (model && !model.isDisposed()) {
            view.mode = 'model';
            view.model = model;
            try {
                view.listeners.push(model.onDidChangeContent(function () { _schedulePush(view); }));
                view.listeners.push(model.onWillDispose(function () {
                    _dropListeners(view);
                    view.model = null;
                    view.mode = 'disk';
                    _pushSource(view);   // 编辑器关闭 → 读盘接管
                }));
            } catch (_) { }
            _pushFromModel(view);
        } else {
            view.mode = 'disk';
            _pushSource(view);
        }
    }

    function _schedulePush(view) {
        if (view.timer) clearTimeout(view.timer);
        var delay = (view.lastSent && view.lastSent.length > 512 * 1024) ? 450 : 150;
        view.timer = setTimeout(function () {
            view.timer = null;
            _pushFromModel(view);
        }, delay);
    }

    function _pushFromModel(view) {
        if (view.destroyed || !view.model) return;
        var content = '';
        try { content = view.model.getValue(); } catch (_) { return; }
        _deliver(view, content, 'model');
    }

    function _pushSource(view) {
        if (view.destroyed) return;
        if (view.mode === 'model' && view.model) { _pushFromModel(view); return; }
        var br = _bridge();
        if (!br || !br.fs || !br.fs.read) return;
        (function () {
            var p = view.filePath;
            br.fs.stat(p).then(function (st) {
                if (view.destroyed) return;
                if (!st) { _deliverStatus(view, 'missing'); return; }
                view.stat = { mtimeMs: st.mtimeMs, size: st.size };
                return br.fs.read(p).then(function (content) {
                    if (view.destroyed) return;
                    if (typeof content !== 'string') { _deliverStatus(view, 'missing'); return; }
                    _deliver(view, content, 'disk');
                });
            }).catch(function () {
                if (!view.destroyed) _deliverStatus(view, 'missing');
            });
        })();
    }

    // 迟绑定升级：disk 模式下编辑器实例后来才就绪（打开预览先于 Monaco 挂载）→ 升级为 model 模式
    function _tryUpgrade(view) {
        if (view.destroyed || view.mode === 'model') return false;
        var ed = _getEd(view.filePath);
        var model = null;
        try { model = (ed && ed.getModel) ? ed.getModel() : null; } catch (_) { model = null; }
        if (model && !model.isDisposed()) { _bindSource(view); return true; }
        return false;
    }

    // tab 激活（可见）→ 显示通知（iframe 滚动恢复保险）+ 数据刷新（disk=stat 重查 / model=保险重拉）
    function _onShown(view) {
        if (view.destroyed) return;
        _post(view, { type: 'mdview:shown' });
        if (view.mode === 'disk' && _tryUpgrade(view)) return;   // 升级成功 → _bindSource 已推首帧
        if (view.mode === 'model' && view.model) _pushFromModel(view);
        else _pushSource(view);
    }

    function _destroyView(view) {
        if (!view || view.destroyed) return;
        view.destroyed = true;
        if (view.timer) { clearTimeout(view.timer); view.timer = null; }
        _dropListeners(view);
        view.model = null;
        if (_views[view.norm] === view) delete _views[view.norm];
    }

    // ---- 挂载视图（custom tab pane 内嵌 mdview iframe）----
    function _mountView(norm, filePath, pane, tab) {
        var old = _views[norm];
        if (old) _destroyView(old);   // 同文件双挂防呆
        var view = {
            norm: norm, filePath: filePath, pane: pane, tab: tab || null,
            iframe: null, ready: false, seq: 0,
            lastSent: null, lastStatus: '', pending: null,
            mode: 'disk', model: null, listeners: [],
            timer: null, destroyed: false,
        };
        _views[norm] = view;

        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:var(--background-color);';
        var iframe = document.createElement('iframe');
        iframe.src = _IFRAME_SRC;
        iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;background:var(--background-color);';
        iframe.setAttribute('frameborder', '0');
        pane.appendChild(iframe);
        view.iframe = iframe;

        if (tab) {
            tab._onVisible = function (v) { if (v) _onShown(view); };
            tab.onClose = function () { _destroyView(view); };
        }
        _bindSource(view);
    }

    // ---- 打开入口（幂等：同文件单预览，重复触发 = 激活已有 tab）----
    function open(filePath) {
        if (!filePath || !window.qqqTabs || !window.qqqTabs.openFileCustomTab) return false;
        var norm = _norm(filePath);
        var fgs = _fileGroups();
        // 源组 = 该文件 tab 所在组；同文件多组（split view）时优先「当前激活 tab 命中」的组
        //（用户正在右组编辑 → 预览应对侧去左组；取第一个会落错侧——2026-09-20 边界修复）
        var srcGrp = null, srcActive = null;
        for (var i = 0; i < fgs.length; i++) {
            var ts = fgs[i].tabs || [];
            for (var j = 0; j < ts.length; j++) {
                if (ts[j].filePath && _norm(ts[j].filePath) === norm) {
                    if (!srcGrp) srcGrp = fgs[i];
                    if (ts[j].id === fgs[i].activeTabId) { srcActive = fgs[i]; break; }
                }
            }
            if (srcActive) break;
        }
        if (srcActive) srcGrp = srcActive;
        // 对侧目标：编辑器在最后一组（右）→ 'left'；否则 'right'（只有一组时自动新建对侧组）
        var side = 'right';
        if (fgs.length >= 2 && srcGrp && srcGrp === fgs[fgs.length - 1]) side = 'left';

        var customId = 'mdview:' + norm;
        var title = '\uD83D\uDC41 ' + _baseName(filePath);   // 👁 文件名（免翻译）
        var tab = window.qqqTabs.openFileCustomTab(customId, title, function (pane, _tab) {
            _mountView(norm, filePath, pane, _tab || null);
        }, { group: side });

        if (tab && !tab._mdwired) {
            tab._mdwired = true;
            // 右键「在右/左组再开」→ 语义 = 激活已有（同文件单预览不双开）
            tab.onReopen = function () { open(filePath); return tab; };
        }
        // 兜底：tab 已存在但 view 缺失（异常路径）→ 就地重建
        if (tab && !_views[norm] && tab.paneEl) {
            try { tab.paneEl.innerHTML = ''; _mountView(norm, filePath, tab.paneEl, tab); } catch (_) { }
        }
        return !!tab;
    }

    // ---- ★ 自动打开（2026-09-21 v4 极简语义；设置 mdview.auto，出厂默认开）----
    //   唯一调用方 = tab-manager 三个打开函数包装（每次成功「打开动作」：新标签 / 预览位替换 / 点亮已开）。
    //   已有预览 → 零动作（不激活、不切换、不抢焦点——自动永不扰动现状）；不管关闭、不接标签切换、零隐藏状态。
    function _autoEnabled() {
        try {
            if (window.qqqSettings && typeof window.qqqSettings.get === 'function') {
                var v = window.qqqSettings.get('mdview.auto', true);
                return v !== false && v !== 'false';
            }
        } catch (_) { }
        var d = window.qqqideDefaults || {};
        return d['mdview.auto'] !== false && d['mdview.auto'] !== 'false';
    }

    function onFileOpened(filePath) {
        if (!filePath || !_isMd(filePath)) return false;
        if (!_autoEnabled()) return false;
        var cur = _views[_norm(filePath)];
        if (cur && !cur.destroyed) return false;   // 已有预览 → 零动作
        return open(filePath);
    }

    // 编辑器挂载完成通知（editor.js openInPane 尾部调用）→ disk 模式迟绑定升级（disk → model）。
    // 自动预览常在 Monaco 挂载前打开（disk 模式先出首帧）；缺此收敛，预览停在磁盘模式、脏缓冲编辑不实时。
    function onEditorMounted(filePath) {
        if (!filePath) return;
        var v = _views[_norm(filePath)];
        if (!v || v.destroyed) return;
        if (_tryUpgrade(v)) return;
        if (v.mode === 'model' && v.model) _pushFromModel(v);
    }

    // ---- 全局消息：mdview iframe → 主窗口 ----
    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || typeof d.type !== 'string' || d.type.indexOf('mdview:') !== 0) return;
        var view = _viewBySource(e.source);
        if (!view) return;
        if (d.type === 'mdview:ready') {
            view.ready = true;
            _post(view, { type: 'mdview:init', filePath: view.filePath, fileName: _baseName(view.filePath) });
            if (view.pending) { _post(view, view.pending); view.pending = null; }
            return;
        }
        if (d.type === 'mdview:request-refresh') {
            if (view.mode === 'model' && view.model) _pushFromModel(view);
            else _pushSource(view);
            return;
        }
        if (d.type === 'mdview:open-external') {
            var url = String(d.url || '');
            if (/^(https?:|mailto:|tel:)/i.test(url)) {
                try {
                    var br = _bridge();
                    if (br && br.shell && br.shell.openExternal) br.shell.openExternal(url);
                } catch (_) { }
            }
            return;
        }
        if (d.type === 'mdview:open-file') {
            var p = String(d.path || '');
            if (p && window.qqqTabs && window.qqqTabs.openFile) window.qqqTabs.openFile(p);
            return;
        }
        if (d.type === 'mdview:roam') {
            var rp = String(d.path || '');
            if (rp && typeof window.__qqq_roamRevealPath === 'function') window.__qqq_roamRevealPath(rp);
            return;
        }
    });

    // 窗口聚焦 → disk 模式视图重查外部修改（model 模式由 editor.js 聚焦检测链覆盖）；顺带迟绑定升级
    window.addEventListener('focus', function () {
        for (var k in _views) {
            var v = _views[k];
            if (!v || v.destroyed || v.mode !== 'disk') continue;
            if (_tryUpgrade(v)) continue;
            _pushSource(v);
        }
    });

    // ---- Monaco action（仅注册键位 Ctrl+K V，不进任何菜单；editor.js 每次编辑器创建后调用）----
    window.__qqqMdAttachAction = function (ed, monaco, filePath) {
        if (!ed || !monaco) return;
        if (_actions) {
            var prev = _actions.get(ed);
            if (prev && prev.disp && prev.disp.dispose) { try { prev.disp.dispose(); } catch (_) { } }
        }
        var disp = null;
        try {
            disp = ed.addAction({
                id: 'qqq-md-preview',
                label: _i('mdview.action', '预览 Markdown'),
                keybindings: [monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV)],
                precondition: 'editorLangId == markdown',
                run: function () {
                    var fp = filePath;
                    if (!fp && window.qqqEditor && window.qqqEditor.currentFile) fp = window.qqqEditor.currentFile();
                    if (fp && _isMd(fp)) open(fp);
                },
            });
        } catch (_) { }
        if (_actions && disp) _actions.set(ed, { disp: disp });
    };

    window.qqqMdPreview = {
        open: open,
        onFileOpened: onFileOpened,
        onEditorMounted: onEditorMounted,
        isMd: _isMd,
        _views: _views,
    };
})();
