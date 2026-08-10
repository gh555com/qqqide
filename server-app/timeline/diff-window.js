// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// timeline/diff-window.js — 主入口 + DOM + UI
// ============================================================================
    'use strict';

    var bridge = window.qqqideBridge;
    var params = new URLSearchParams(location.search);
    var FILE_PATH = params.get('path') || '';
    var PROJECT_ROOT = params.get('projectRoot') || '';
    var INIT_BEFORE = params.get('before') || '';
    var INIT_AFTER = params.get('after') || '';
    // 主题：URL 参数优先，同步到 qqqideTheme + THEME 变量
    var _urlDark = params.get('theme') === 'dark';
    if (typeof qqqideTheme !== 'undefined') qqqideTheme.apply(_urlDark);
    // ★ 以 qqqideTheme 的最终状态为准（localStorage 预设 + URL 覆盖后的结果）
    var _isDark = (typeof qqqideTheme !== 'undefined') ? qqqideTheme.isDark() : _urlDark;
    var THEME = _isDark ? 'solarized-dark' : 'solarized-light';

    var _versions = [];
    var _lastContent = null;
    var _lastMtimeMs = null;
    var _markedBefore = INIT_BEFORE;
    var _markedAfter = INIT_AFTER;
    // 项目级持久化偏好：仅差异模式（true=仅差异 / false=全文对比），默认全文
    var _diffOnly = false;
    var _isLastOnRight = false;
    var _PREF_NS = 'qqqide.timeline';
    var _diffEditor = null;
    var _monacoLoaded = false;
    var _editorFontSize = 13;
    var _editing = false;
    var _editDirty = false;
    var _editOriginalContent = '';
    var _editSnapshotBase = '';
    var _editSnapshotSeq = 0;

    var $titleInput = document.getElementById('title-input');

    // ★ contenteditable：分隔符 \ / 自动红色高亮 + 光标安全
    function _titleGetText() {
        return ($titleInput.textContent || '').replace(/\n/g, '');
    }
    function _titleCursorOffset() {
        var sel = window.getSelection();
        if (!sel.rangeCount) return 0;
        var range = sel.getRangeAt(0);
        if (!$titleInput.contains(range.startContainer)) return 0;
        var pre = document.createRange();
        pre.setStart($titleInput, 0);
        pre.setEnd(range.startContainer, range.startOffset);
        return pre.toString().replace(/\n/g, '').length;
    }
    function _titleRestoreCursor(offset) {
        var sel = window.getSelection();
        var walker = document.createTreeWalker($titleInput, NodeFilter.SHOW_TEXT);
        var count = 0;
        while (walker.nextNode()) {
            var node = walker.currentNode;
            var len = (node.textContent || '').length;
            if (count + len >= offset) {
                var range = document.createRange();
                range.setStart(node, Math.max(0, offset - count));
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                return;
            }
            count += len;
        }
        // clamp to end
        var w2 = document.createTreeWalker($titleInput, NodeFilter.SHOW_TEXT);
        var lastNode = null;
        while (w2.nextNode()) lastNode = w2.currentNode;
        if (lastNode) {
            var range = document.createRange();
            range.setStart(lastNode, lastNode.textContent.length);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }
    function _titleRebuild(raw) {
        var offset = _titleCursorOffset();
        var html = '';
        for (var i = 0; i < raw.length; i++) {
            var ch = raw[i];
            if (ch === '\\' || ch === '/') {
                html += '<span class="sep">' + _escHtml(ch) + '<\/span>';
            } else {
                html += _escHtml(ch);
            }
        }
        $titleInput.innerHTML = html;
        if (raw.length > 0) _titleRestoreCursor(Math.min(offset, raw.length));
    }
    function _titleSetText(raw) {
        _titleRebuild(raw || '');
    }

    var $selLeft = document.getElementById('sel-left');
    var $selRight = document.getElementById('sel-right');
    // 自定义下拉 DOM
    var $ddLeftBtn = document.getElementById('dd-left-btn');
    var $ddLeftList = document.getElementById('dd-left-list');
    var $ddLeft = document.getElementById('dd-left');
    var $ddRightBtn = document.getElementById('dd-right-btn');
    var $ddRightList = document.getElementById('dd-right-list');
    var $ddRight = document.getElementById('dd-right');
    var $markerLeft = document.getElementById('marker-left');
    var $markerRight = document.getElementById('marker-right');
    var $diffContainer = document.getElementById('diff-container');
    var $emptyState = document.getElementById('empty-state');
    var $btnDiffOnly = document.getElementById('btn-diff-only');
    var $btnEdit = document.getElementById('btn-edit');
    var $editStatus = document.getElementById('edit-status');
    var $esStatus = $editStatus ? $editStatus.querySelector('.es-status') : null;
    var $esSnap = $editStatus ? $editStatus.querySelector('.es-snap') : null;

    // ═══ 文件搜索历史 + 模糊匹配 ═══
    var $inputWrap = document.getElementById('input-wrap');
    var $btnHistory = document.getElementById('btn-history');
    var $fuzzyDropdown = document.getElementById('fuzzy-dropdown');
    var $fuzzyList = document.getElementById('fuzzy-list');
    var _fileHistory = [];       // 最近搜索历史 [{path, ts}]
    var _historyLoaded = false;
    var _fuzzyIdx = -1;          // 当前高亮索引
    var _fuzzyVisible = false;
    var HISTORY_KEY = 'fileHistory';
    var HISTORY_MAX = 50;

    // 加载历史
    (async function _loadHistory() {
        try {
            if (bridge && bridge.state) {
                var raw = await bridge.state.get(_PREF_NS, HISTORY_KEY);
                if (Array.isArray(raw)) _fileHistory = raw;
            }
        } catch (_) { }
        _historyLoaded = true;
    })();

    // 保存历史（去重 + 限长 + 新在前）
    function _addHistory(filePath) {
        if (!filePath) return;
        // 去重：移除同路径旧条目
        _fileHistory = _fileHistory.filter(function (h) { return h.path !== filePath; });
        _fileHistory.unshift({ path: filePath, ts: Date.now() });
        if (_fileHistory.length > HISTORY_MAX) _fileHistory.length = HISTORY_MAX;
        _saveHistory();
    }

    var _saveHistoryTimer = 0;
    function _saveHistory() {
        clearTimeout(_saveHistoryTimer);
        _saveHistoryTimer = setTimeout(function () {
            try {
                if (bridge && bridge.state) {
                    bridge.state.setNow(_PREF_NS, HISTORY_KEY, _fileHistory.slice(0, HISTORY_MAX));
                }
            } catch (_) { }
        }, 500);
    }

    // 模糊匹配：query 的每个字符按顺序在 path 中出现（大小写不敏感）
    function _fuzzyMatch(query, path) {
        var q = query.toLowerCase();
        var p = path.toLowerCase();
        var qi = 0;
        for (var pi = 0; pi < p.length && qi < q.length; pi++) {
            if (p[pi] === q[qi]) qi++;
        }
        return qi === q.length;
    }

    // 构建模糊匹配下拉
    function _buildFuzzyList(query) {
        $fuzzyList.innerHTML = '';
        _fuzzyIdx = -1;
        // _fuzzyIdxMap: DOM顺序 → _fileHistory 实际索引
        var idxMap = [];
        if (!query || !query.trim()) {
            for (var i = 0; i < _fileHistory.length; i++) {
                idxMap.push(i);
                _appendFuzzyItem(_fileHistory[i].path, i);
            }
        } else {
            var q = query.trim();
            for (var j = 0; j < _fileHistory.length; j++) {
                if (_fuzzyMatch(q, _fileHistory[j].path)) {
                    idxMap.push(j);
                    _appendFuzzyItem(_fileHistory[j].path, j);
                }
            }
        }
        _fuzzyVisible = $fuzzyList.children.length > 0;
        $fuzzyDropdown.style.display = _fuzzyVisible ? '' : 'none';
        // 存储映射供键盘选择使用
        $fuzzyList._idxMap = idxMap;
    }

    function _appendFuzzyItem(path, idx) {
        var div = document.createElement('div');
        div.className = 'fuzzy-item';
        div.dataset.idx = idx;
        div.innerHTML = '<span class="fi-icon">📄</span>' + _escHtml(path);
        div.addEventListener('mousedown', function (e) {
            e.preventDefault(); // 防止 blur 先于 click 关闭下拉
            _selectHistory(path);
        });
        $fuzzyList.appendChild(div);
    }

    function _highlightFuzzy(idx) {
        var items = $fuzzyList.querySelectorAll('.fuzzy-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('active', i === idx);
            if (i === idx) items[i].scrollIntoView({ block: 'nearest' });
        }
    }

    function _selectHistory(path) {
        _titleSetText(path);
        _closeFuzzy();
        _openFileByPath(path);
    }

    function _closeFuzzy() {
        _fuzzyVisible = false;
        _fuzzyIdx = -1;
        $fuzzyDropdown.style.display = 'none';
    }

    // 打开文件（按路径加载版本）
    function _openFileByPath(filePath) {
        if (!filePath) return;
        FILE_PATH = filePath;
        _titleSetText(filePath);
        $titleInput.title = filePath;
        _addHistory(filePath);
        // 通知主进程更新 diffWindows 映射
        try { if (bridge && bridge.timeline && bridge.timeline.setPath) bridge.timeline.setPath(filePath); } catch (_) { }
        loadVersions(filePath);
    }

    // ▼ 历史按钮：切换下拉
    if ($btnHistory) {
        $btnHistory.addEventListener('click', function (e) {
            e.stopPropagation();
            if (_fuzzyVisible) {
                _closeFuzzy();
            } else {
                _buildFuzzyList('');
            }
        });
    }

    // ═══ 键入框事件（contenteditable） ═══
    if ($titleInput) {
        // ★ 每次键入后重建红色分隔符 + 保留光标
        $titleInput.addEventListener('input', function () {
            _titleRebuild(_titleGetText());
            _buildFuzzyList(_titleGetText());
        });
        // ★ 粘贴后清洗换行并重建
        $titleInput.addEventListener('paste', function (e) {
            e.preventDefault();
            var text = (e.clipboardData || window.clipboardData).getData('text/plain');
            text = text.replace(/[\r\n]+/g, '');
            if (text) {
                var sel = window.getSelection();
                if (sel.rangeCount && $titleInput.contains(sel.anchorNode)) {
                    sel.getRangeAt(0).deleteContents();
                    sel.getRangeAt(0).insertNode(document.createTextNode(text));
                    sel.collapseToEnd();
                }
            }
            _titleRebuild(_titleGetText());
        });

        // Enter 键：打开文件
        $titleInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (_fuzzyVisible && _fuzzyIdx >= 0) {
                    var idxMap = $fuzzyList._idxMap || [];
                    var realIdx = idxMap[_fuzzyIdx];
                    if (typeof realIdx === 'number' && _fileHistory[realIdx]) {
                        _selectHistory(_fileHistory[realIdx].path);
                    }
                } else {
                    _closeFuzzy();
                    _openFileByPath(_titleGetText().trim());
                }
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!_fuzzyVisible) { _buildFuzzyList(_titleGetText()); }
                var items = $fuzzyList.querySelectorAll('.fuzzy-item');
                if (items.length) {
                    _fuzzyIdx = Math.min(_fuzzyIdx + 1, items.length - 1);
                    _highlightFuzzy(_fuzzyIdx);
                }
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (_fuzzyVisible) {
                    _fuzzyIdx = Math.max(_fuzzyIdx - 1, 0);
                    _highlightFuzzy(_fuzzyIdx);
                }
                return;
            }
            if (e.key === 'Escape') {
                _closeFuzzy();
                return;
            }
        });

        // 聚焦时显示历史
        $titleInput.addEventListener('focus', function () {
            if (!_fuzzyVisible) _buildFuzzyList(_titleGetText());
        });

        // 点击外部关闭下拉
        document.addEventListener('click', function (e) {
            if (_fuzzyVisible && $inputWrap && !$inputWrap.contains(e.target)) {
                _closeFuzzy();
            }
        });
    }

    // ═══ OP 按钮 — 操作下拉 ═══
    var $btnOp = document.getElementById('btn-op');
    var $opDropdown = document.getElementById('op-dropdown');
    var _opVisible = false;

    function _showOpDropdown() {
        _opVisible = true;
        $opDropdown.style.display = '';
        // ★ 动态标签：读取焦点面板方向（Roam 右键菜单传统 ←喂给 AI/喂给 AI/喂给 AI→）
        try {
            if (bridge && bridge.timeline && bridge.timeline.getAiTarget) {
                bridge.timeline.getAiTarget().then(function (t) {
                    var lbl = document.getElementById('op-feed-label');
                    if (lbl) lbl.textContent = t === 0 ? '←喂给 AI' : t === 2 ? '喂给 AI→' : '喂给 AI';
                }).catch(function () { });
            }
        } catch (_) { }
    }
    function _hideOpDropdown() {
        _opVisible = false;
        $opDropdown.style.display = 'none';
    }

    if ($btnOp) {
        $btnOp.addEventListener('click', function (e) {
            e.stopPropagation();
            if (_opVisible) { _hideOpDropdown(); } else { _showOpDropdown(); }
        });
    }

    // op 下拉项点击
    if ($opDropdown) {
        $opDropdown.addEventListener('click', function (e) {
            e.stopPropagation();
            var item = e.target.closest('.op-item');
            if (!item) return;
            var action = item.dataset.action;
            var fp = FILE_PATH || _titleGetText().trim();
            if (!fp) return;
            if (action === 'open') {
                // 在 X 区 editor 打开文件
                try { if (bridge && bridge.timeline && bridge.timeline.openInEditor) bridge.timeline.openInEditor(fp); } catch (_) { }
            } else if (action === 'feed') {
                // 喂给 AI
                try { if (bridge && bridge.timeline && bridge.timeline.feedToAi) bridge.timeline.feedToAi(fp); } catch (_) { }
            }
            _hideOpDropdown();
        });
    }

    // 点击外部关闭 op 下拉
    document.addEventListener('click', function (e) {
        if (_opVisible && $btnOp && !$btnOp.contains(e.target) && $opDropdown && !$opDropdown.contains(e.target)) {
            _hideOpDropdown();
        }
    });

    // ═══ 窗口控制 ═══
    var $btnMax = document.getElementById('btn-max');
    if ($btnMax) $btnMax.addEventListener('click', function () {
        if (bridge && bridge.window) {
            bridge.window.isMaximized().then(function (maxed) {
                if (maxed) { bridge.window.unmaximize(); }
                else { bridge.window.maximize(); }
            });
        }
    });

    // ★ 大号关闭按钮 + 右键关闭窗口
    var $btnBigClose = document.getElementById('big-close');
    var $bigCloseTip = document.getElementById('big-close-tip');
    function _closeWindow() { if (bridge && bridge.window) bridge.window.close(); }
    if ($btnBigClose) $btnBigClose.addEventListener('click', _closeWindow);
    // ★ 自定义 tooltip：高对比度、瞬间弹出、跟随光标
    if ($btnBigClose && $bigCloseTip) {
        $btnBigClose.addEventListener('mouseenter', function (e) {
            $bigCloseTip.style.display = '';
            $bigCloseTip.style.left = (e.clientX + 14) + 'px';
            $bigCloseTip.style.top = (e.clientY - 28) + 'px';
        });
        $btnBigClose.addEventListener('mousemove', function (e) {
            $bigCloseTip.style.left = (e.clientX + 14) + 'px';
            $bigCloseTip.style.top = (e.clientY - 28) + 'px';
        });
        $btnBigClose.addEventListener('mouseleave', function () {
            $bigCloseTip.style.display = 'none';
        });
    }
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); _closeWindow(); });

    // ★ 编辑按钮 tooltip（动态文本，靠左显示防超出屏幕）
    var $btnEditTip = document.getElementById('btn-edit-tip');
    if ($btnEdit && $btnEditTip) {
        $btnEdit.addEventListener('mouseenter', function (e) {
            $btnEditTip.textContent = _editing ? _i('timeline.editTooltipExit', '退出编辑时不会自动保存') : _i('timeline.editTooltip', '编辑当前磁盘最新文件（而非任何一个历史快照）');
            $btnEditTip.style.display = '';
            $btnEditTip.style.left = 'auto';
            $btnEditTip.style.right = (window.innerWidth - e.clientX + 14) + 'px';
            $btnEditTip.style.top = (e.clientY - 28) + 'px';
        });
        $btnEdit.addEventListener('mousemove', function (e) {
            $btnEditTip.style.left = 'auto';
            $btnEditTip.style.right = (window.innerWidth - e.clientX + 14) + 'px';
            $btnEditTip.style.top = (e.clientY - 28) + 'px';
        });
        $btnEdit.addEventListener('mouseleave', function () {
            $btnEditTip.style.display = 'none';
        });
    }

    // ═══ 监听主进程推送 diff 更新（同文件再次点击 A4 时复用窗口） ═══
    if (bridge && bridge.timeline && bridge.timeline.onDiffUpdate) {
        bridge.timeline.onDiffUpdate(function (data) {
            // 仅当推送的文件路径与当前一致时才处理（用户可能已切换到其他文件）
            if (data.filePath && data.filePath !== FILE_PATH) return;
            _markedBefore = data.beforeBlobHash || '';
            _markedAfter = data.afterBlobHash || '';
            loadVersions(FILE_PATH);
        });
    }

