// ============================================================================
// timeline/diff-window.js — Monaco Diff 独立 BrowserWindow 逻辑
// ============================================================================
(function () {
    'use strict';

    var bridge = window.qqqideBridge;
    var params = new URLSearchParams(location.search);
    var FILE_PATH = params.get('path') || '';
    var PROJECT_ROOT = params.get('projectRoot') || '';
    var INIT_BEFORE = params.get('before') || '';
    var INIT_AFTER = params.get('after') || '';
    // 主题：优先 URL 参数，其次系统偏好，默认 dark（使用 solarized 以匹配 X 区 editor）
    var THEME = params.get('theme') === 'light' ? 'solarized-light' : 'solarized-dark';

    var _versions = [];
    var _lastContent = null;
    var _lastMtimeMs = null;
    var _markedBefore = INIT_BEFORE;
    var _markedAfter = INIT_AFTER;
    // 全局持久化偏好：差异模式（false=差异块 / true=全文），默认差异
    var _showFull = false;
    var _isLastOnRight = false;
    var _PREF_NS = 'qqqide.timeline';
    var _diffEditor = null;
    var _monacoLoaded = false;

    var $titleInput = document.getElementById('title-input');
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
    var $statAdded = document.getElementById('stat-added');
    var $statDeleted = document.getElementById('stat-deleted');
    var $statChanges = document.getElementById('stat-changes');
    var $statMode = document.getElementById('stat-mode');
    var $btnFull = document.getElementById('btn-full');
    var $btnHideUnchanged = document.getElementById('btn-hide-unchanged');
    var $btnAcceptLeft = document.getElementById('btn-accept-left');
    var $btnSaveLast = document.getElementById('btn-save-last');

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
        $titleInput.value = path;
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
        $titleInput.value = filePath;
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

    // 输入框事件
    if ($titleInput) {
        // Enter 键：打开文件
        $titleInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (_fuzzyVisible && _fuzzyIdx >= 0) {
                    // 选中下拉项：通过 idxMap 找到 _fileHistory 实际索引
                    var idxMap = $fuzzyList._idxMap || [];
                    var realIdx = idxMap[_fuzzyIdx];
                    if (typeof realIdx === 'number' && _fileHistory[realIdx]) {
                        _selectHistory(_fileHistory[realIdx].path);
                    }
                } else {
                    _closeFuzzy();
                    _openFileByPath($titleInput.value.trim());
                }
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!_fuzzyVisible) { _buildFuzzyList($titleInput.value); }
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

        // 输入时模糊匹配
        $titleInput.addEventListener('input', function () {
            _buildFuzzyList($titleInput.value);
        });

        // 聚焦时显示历史
        $titleInput.addEventListener('focus', function () {
            if (!_fuzzyVisible) _buildFuzzyList($titleInput.value);
        });

        // 点击外部关闭下拉
        document.addEventListener('click', function (e) {
            if (_fuzzyVisible && $inputWrap && !$inputWrap.contains(e.target)) {
                _closeFuzzy();
            }
        });
    }

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

    // ═══ 入口 ═══
    if (!FILE_PATH || !PROJECT_ROOT) {
        $emptyState.textContent = '缺少参数';
    } else {
        $titleInput.value = FILE_PATH;
        $titleInput.title = FILE_PATH;
        loadVersions(FILE_PATH);
    }
    // ★ Ctrl+Z 逐字回退
    if ($titleInput && typeof window._qqqUndoAttach === 'function') {
        window._qqqUndoAttach($titleInput);
    }

    // ═══ 加载版本列表 ═══
    var _loading = false;
    async function loadVersions(filePath) {
        if (_loading) return; // 防并发重入
        _loading = true;
        try {
            $emptyState.textContent = '加载版本列表…';
            $emptyState.style.display = '';
            $diffContainer.style.display = 'none';
            try {
                _versions = await bridge.timeline.versions({ projectRoot: PROJECT_ROOT, filePath: filePath });
            } catch (e) {
                console.error('[diff] versions failed:', e);
                _versions = [];
            }
            try {
                _lastContent = await bridge.timeline.readCurrent(filePath);
                var st = await bridge.timeline.stat(filePath);
                if (st) _lastMtimeMs = st.mtimeMs;
            } catch (_) {
                _lastContent = null;
                _lastMtimeMs = null;
            }
            if (_versions.length === 0 && !_lastContent) {
                $emptyState.textContent = '该文件没有历史版本';
                return;
            }
            // 加载全局持久化偏好（跨窗口记忆）
            try {
                if (bridge && bridge.state) {
                    var pref = await bridge.state.get(_PREF_NS, 'showFull');
                    if (typeof pref === 'boolean') _showFull = pref;
                }
            } catch (_) { }
            populateDropdowns();
            // ★ Monaco 加载超时保护（15s），防止永久白屏
            var monacoOk = await Promise.race([
                loadMonaco().then(function () { return true; }),
                new Promise(function (r) { setTimeout(function () { r(false); }, 15000); })
            ]);
            if (!monacoOk) {
                $emptyState.textContent = 'Monaco 加载超时，请检查网络或重启窗口';
                return;
            }
            $emptyState.style.display = 'none';
            $diffContainer.style.display = '';
        } finally {
            _loading = false;
        }
    }

    var _options = []; // 下拉选项缓存，供 updateOneMarker 查合并条目

    // ═══ 解析 floor_id → 可读溯源串 "q38 f14 h3 r2" ═══
    function _parseFloorId(floorId) {
        if (!floorId) return '';
        var parts = floorId.split('/');
        // 格式: "q38/f14/h3/r2" 或 "q38/f14"
        var out = [];
        for (var pi = 0; pi < parts.length; pi++) {
            out.push(parts[pi]);
        }
        return out.join(' ');
    }

    // ═══ 映射 source → 可读标签 ═══
    function _sourceLabel(source, floorId) {
        if (source === 'q') {
            // 钩子 Q：AI 写工具 → 显示 trace（如 "q38 f14 h3 r2"）
            var trace = _parseFloorId(floorId);
            return trace || 'q';
        }
        if (source === 'auto-save') {
            return 'auto save';
        }
        if (source === 'manual-save' || source === 'x' || source === 'diff-save') {
            return 'manual save';
        }
        if (source === 'run-command') {
            return 'cmd';
        }
        return source || '';
    }

    // ═══ 填充下拉框 ═══
    function populateDropdowns() {
        var options = [];
        for (var i = 0; i < _versions.length; i++) {
            var v = _versions[i];
            var sourceLabel = _sourceLabel(v.source, v.floor_id); // ★ 溯源标签
            var added = (v.added_lines > 0) ? ('+' + v.added_lines) : '';
            var deleted = (v.deleted_lines > 0) ? ('-' + v.deleted_lines) : '';
            var diffStr = (added || deleted) ? (added + ' ' + deleted).trim() : '';
            options.push({
                value: v.blob_hash,
                label: formatTs(v.ts),
                ts: v.ts,
                source: v.source,
                floorId: v.floor_id,
                sourceLabel: sourceLabel,
                diffStr: diffStr,
                isFirst: (i === 0),
            });
        }
        var isFirst = options.length === 0;
        // ── 合并「当前文件」到已有版本（按秒级时间戳归并，避免重复行）──
        var lastMerged = false;
        if (_lastContent !== null) {
            var lastTs = _lastMtimeMs;
            var lastLabel = formatTs(lastTs);
            for (var li = 0; li < options.length; li++) {
                // 秒级比对（同秒视为同一时刻）
                if (lastTs && Math.abs(options[li].ts - lastTs) < 1000) {
                    // 把版本条目升级为 last 载体（value 改为 'last'，保留 blob_hash）
                    options[li]._blobHash = options[li].value;
                    options[li].value = 'last';
                    options[li].isLast = true;
                    options[li].label = lastLabel; // 统一显示标签
                    lastMerged = true;
                    break;
                }
            }
            if (!lastMerged) {
                options.push({
                    value: 'last',
                    label: lastLabel,
                    ts: lastTs || Date.now(),
                    source: 'current',
                    floorId: null,
                    sourceLabel: '',
                    diffStr: '',
                    isFirst: isFirst,
                    isLast: true,
                });
            }
        }

        // ── 查找 marked before/after 在 options 中的位置 ──
        var beforeIdx = -1, afterIdx = -1;
        for (var b = 0; b < options.length; b++) {
            if (_markedBefore && (options[b].value === _markedBefore || options[b]._blobHash === _markedBefore)) beforeIdx = b;
            if (_markedAfter && (options[b].value === _markedAfter || options[b]._blobHash === _markedAfter)) afterIdx = b;
        }

        // ── 智能修正：如果 before/after 指向同一版本（内容未变或 hash 相同），
        //     且该版本不是最早版本，则 before 退一格 ──
        if (beforeIdx >= 0 && beforeIdx === afterIdx) {
            if (beforeIdx > 0) {
                beforeIdx = beforeIdx - 1;
            } else if (options.length > 1) {
                // beforeIdx=0，唯一版本无法退格；after 进一格取下一个版本
                afterIdx = 1;
            }
        }

        // ── 如果 marked 未匹配到任何版本，使用智能默认 ──
        // after 默认取最新（最后一个）；before 默认取 after 前一个
        if (afterIdx < 0 && options.length > 0) {
            afterIdx = options.length - 1;
        }
        if (beforeIdx < 0 && afterIdx >= 0) {
            if (afterIdx > 0) {
                beforeIdx = afterIdx - 1;
            } else if (options.length >= 2) {
                beforeIdx = 0;
                afterIdx = 1;
            } else {
                beforeIdx = afterIdx; // 只有一个版本，左右同源
            }
        }

        // ★ before/after 语义由钩子 Q 保证，不按时间戳排序（还原操作时 before 可能晚于 after）

        // ── 构建 HTML：标签格式 "2026-06-13 11:36:41 +333 -66 q38 f14 h3 r2 [first] [before]" ──
        var mergedOptions = [];
        for (var j = 0; j < options.length; j++) {
            var o = options[j];
            var markers = [];
            if (o.isFirst) markers.push('first');
            if (j === beforeIdx) markers.push('before');
            if (j === afterIdx) markers.push('after');
            if (o.isLast) markers.push('last');
            // ── 拼接完整标签：时间 + 变更统计 + 溯源 ──
            var fullLabel = o.label;
            if (o.diffStr) fullLabel += ' ' + o.diffStr;
            if (o.sourceLabel) fullLabel += ' ' + o.sourceLabel;
            // ★ 每行分配永不回退的编号（per-file 自增，按 id ASC 排序）
            var seqNo = mergedOptions.length + 1;
            var labeledLabel = '#' + seqNo + ' ' + fullLabel;
            mergedOptions.push({ value: o.value, label: o.label, fullLabel: labeledLabel, markers: markers, _blobHash: o._blobHash, isLast: o.isLast, ts: o.ts, sourceLabel: o.sourceLabel });
        }
        options = mergedOptions; // 替换为合并后的列表
        _options = options; // 缓存供 updateOneMarker 使用

        // ── 应用选择（隐藏 input 存值）──
        var afterVal = options[Math.min(afterIdx, options.length - 1)].value;
        var beforeVal = options[Math.min(beforeIdx, options.length - 1)].value;
        $selRight.value = afterVal;
        $selLeft.value = beforeVal;

        // ── 构建自定义下拉 HTML（含 +N -M 染色）──
        _buildDropdownList($ddLeftList, options);
        _buildDropdownList($ddRightList, options);
        _refreshDropdownBtn($ddLeftBtn, $selLeft.value, options);
        _refreshDropdownBtn($ddRightBtn, $selRight.value, options);

        updateMarkers();
    }

    // ── 构建自定义下拉列表（富文本：+N 绿、-M 红、marker 标签）──
    // ★ 将来源标签（如 q113 f1 h53 r1 / auto save / manual save）用背景色块包裹
    // ★ trace 格式中的字母（q/f/h/r）降低不透明度，让数字更清晰
    function _wrapSourceTag(displayHtml, sourceLabel) {
        if (!sourceLabel) return displayHtml;
        var escapedSrc = _escHtml(sourceLabel);
        var idx = displayHtml.lastIndexOf(escapedSrc);
        if (idx >= 0) {
            // ★ 构建来源标签内部 HTML：trace 格式字母半透明
            var innerHtml = _buildSourceInnerHtml(sourceLabel);
            displayHtml = displayHtml.substring(0, idx) +
                '<span class="v-source-tag">' + innerHtml + '</span>' +
                displayHtml.substring(idx + escapedSrc.length);
        }
        return displayHtml;
    }

    // ★ 将 trace 格式 "q113 f1 h53 r1" 中的字母半透明，数字加粗
    // ★ f（楼层）的数字用主题色高亮；token 间全角空格防 flexbox 吞
    function _buildSourceInnerHtml(rawSource) {
        if (/^[a-z]\d+(\s+[a-z]\d+)*$/i.test(rawSource)) {
            var tokens = rawSource.split(/\s+/);
            var parts = [];
            for (var t = 0; t < tokens.length; t++) {
                var m = tokens[t].match(/^([a-z])(\d+)$/i);
                if (!m) { parts.push(_escHtml(tokens[t])); continue; }
                var letter = m[1], num = m[2];
                var letterSpan = '<span style="opacity:0.45;font-weight:400">' + letter + '</span>';
                var numTag = (letter.toLowerCase() === 'f')
                    ? '<b class="v-fnum">' + num + '</b>'
                    : '<b>' + num + '</b>';
                parts.push(letterSpan + numTag);
            }
            // ★ 全角空格 U+3000（宽一倍，不被 flexbox 删除）
            return parts.join('\u3000');
        }
        return _escHtml(rawSource);
    }

    function _buildDropdownList($list, options) {
        var html = '';
        for (var i = 0; i < options.length; i++) {
            var mo = options[i];
            // 解析 fullLabel，将 +N 和 -M 分别染色，MM-DD / #N 加粗
            var displayHtml = _escHtml(mo.fullLabel || mo.label);
            // ★ 编号 #41 加粗
            displayHtml = displayHtml.replace(/^(#\d+)\s/, '<b>$1</b>&nbsp;');
            // 给 +数字 加绿色 span
            displayHtml = displayHtml.replace(/\+(\d+)/g, '<span class="v-stat-green">+$1</span>');
            // ★ 减号染色：仅 diff 统计（空格后 -N），不染日期
            displayHtml = displayHtml.replace(/\s\-(\d+)/g, '&nbsp;<span class="v-stat-red">-$1</span>');
            // ★ 日期中 06-15 加粗
            displayHtml = displayHtml.replace(/(\d{4})-(\d{2})-(\d{2})/g, '$1-<b class="v-date-md">$2-$3</b>');
            // ★ 时分秒左右加空格（防 flexbox 吞）
            displayHtml = displayHtml.replace(/(\d{2}:\d{2}:\d{2})/g, '&nbsp;$1&nbsp;');
            // ★ 来源标签虚线框
            if (mo.sourceLabel) displayHtml = _wrapSourceTag(displayHtml, mo.sourceLabel);
            // marker 标签
            var markerHtml = '';
            if (mo.markers && mo.markers.length) {
                for (var mi = 0; mi < mo.markers.length; mi++) {
                    var mk = mo.markers[mi];
                    var mkClass = (mk === 'before') ? 'before' : (mk === 'after') ? 'after' : (mk === 'first') ? 'first' : (mk === 'last') ? 'last' : '';
                    markerHtml += '<span class="v-marker' + (mkClass ? ' ' + mkClass : '') + '">' + _escHtml(mk) + '</span>';
                }
            }
            html += '<div class="v-dropdown-item" data-value="' + _escAttr(mo.value) + '">' +
                displayHtml + markerHtml +
                '<button class="v-copy-btn" title="复制此行文本">📋</button></div>';
        }
        $list.innerHTML = html;
    }

    // ── 刷新下拉按钮显示 + 高亮选中项 + 滚动到可见 ──
    function _refreshDropdownBtn($btn, val, options) {
        for (var i = 0; i < options.length; i++) {
            if (options[i].value === val) {
                var mo = options[i];
                var displayHtml = _escHtml(mo.fullLabel || mo.label);
                displayHtml = displayHtml.replace(/^(#\d+)\s/, '<b>$1</b>&nbsp;');
                displayHtml = displayHtml.replace(/\+(\d+)/g, '<span class="v-stat-green">+$1</span>');
                displayHtml = displayHtml.replace(/\s\-(\d+)/g, '&nbsp;<span class="v-stat-red">-$1</span>');
                displayHtml = displayHtml.replace(/(\d{4})-(\d{2})-(\d{2})/g, '$1-<b class="v-date-md">$2-$3</b>');
                displayHtml = displayHtml.replace(/(\d{2}:\d{2}:\d{2})/g, '&nbsp;$1&nbsp;');
                if (mo.sourceLabel) displayHtml = _wrapSourceTag(displayHtml, mo.sourceLabel);
                $btn.innerHTML = displayHtml;
                return;
            }
        }
        $btn.textContent = val || '—';
    }

    function _highlightAndScroll($list, val) {
        var items = $list.querySelectorAll('.v-dropdown-item');
        for (var i = 0; i < items.length; i++) {
            if (items[i].dataset.value === val) {
                items[i].classList.add('selected');
                // 滚动到选中项居中
                items[i].scrollIntoView({ block: 'center' });
            } else {
                items[i].classList.remove('selected');
            }
        }
    }

    // ── 动态计算下拉 max-height：按窗口高度（约 24 行，每行 ~28px）──
    function _calcDropdownMaxHeight() {
        var winH = window.innerHeight;
        var barH = 36 + 44 + 32 + 22; // title-row + version-bar + actions-bar + statusbar
        var avail = winH - barH - 24; // 减去上下留白
        var rowH = 28;
        var maxRows = Math.floor(avail / rowH);
        maxRows = Math.max(6, Math.min(maxRows, 32)); // 最少 6 行，最多 32 行
        var maxH = maxRows * rowH;
        $ddLeftList.style.maxHeight = maxH + 'px';
        $ddRightList.style.maxHeight = maxH + 'px';
    }
    _calcDropdownMaxHeight();
    window.addEventListener('resize', _calcDropdownMaxHeight);

    // ── 自定义下拉交互 ──
    function _initDropdown($dd, $btn, $list, $hidden, side) {
        // 点击按钮：切换展开（不关另一个列表）
        $btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var wasOpen = $dd.classList.contains('open');
            if (wasOpen) {
                $dd.classList.remove('open');
            } else {
                $dd.classList.add('open');
                _calcDropdownMaxHeight();
                _highlightAndScroll($list, $hidden.value);
            }
        });
        // 点击列表项：选中并关闭（排除复制按钮）
        $list.addEventListener('click', function (e) {
            // ★ 点复制按钮：复制纯文本（手动冒泡查找到按钮元素）
            var copyBtn = null;
            var el = e.target;
            while (el && el !== $list) {
                if (el.classList && el.classList.contains('v-copy-btn')) { copyBtn = el; break; }
                el = el.parentElement;
            }
            if (copyBtn) {
                e.stopPropagation();
                e.preventDefault();
                var copyItem = copyBtn.closest('.v-dropdown-item');
                if (copyItem) {
                    var text = copyItem.textContent.replace(/📋/g, '').trim();
                    // 使用 textarea + execCommand 兜底（兼容 Electron / 非安全上下文）
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    ta.style.top = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand('copy'); } catch (_) { }
                    document.body.removeChild(ta);
                }
                return;
            }
            var item = e.target.closest('.v-dropdown-item');
            if (!item) return;
            var val = item.dataset.value;
            if (val === $hidden.value) { $dd.classList.remove('open'); return; }
            $hidden.value = val;
            _refreshDropdownBtn($btn, val, _options);
            _highlightAndScroll($list, val);
            $dd.classList.remove('open');
            updateMarkers();
            renderDiff();
        });
        // 点击外部关闭
        document.addEventListener('click', function () {
            $dd.classList.remove('open');
        });
    }
    _initDropdown($ddLeft, $ddLeftBtn, $ddLeftList, $selLeft, 'left');
    _initDropdown($ddRight, $ddRightBtn, $ddRightList, $selRight, 'right');

    function updateMarkers() {
        updateOneMarker($selLeft, $markerLeft);
        updateOneMarker($selRight, $markerRight);
        _isLastOnRight = ($selRight.value === 'last');
        updateButtons();
    }

    function updateOneMarker($sel, $marker) {
        var val = $sel.value;
        if (!val) { $marker.style.display = 'none'; return; }
        // 查找合并条目（value 可能是 'last' 但 _blobHash 匹配 marked）
        var opt = null;
        for (var oi = 0; oi < _options.length; oi++) {
            if (_options[oi].value === val) { opt = _options[oi]; break; }
        }
        var blob = opt ? opt._blobHash : null;
        var isBefore = (_markedBefore && (val === _markedBefore || blob === _markedBefore));
        var isAfter = (_markedAfter && (val === _markedAfter || blob === _markedAfter));
        var isFirst = (val !== 'last' && _versions.length > 0 && (_versions[0].blob_hash === val || (blob && _versions[0].blob_hash === blob)));
        var isLast = (val === 'last' || (opt && opt.isLast));
        if (isBefore) {
            $marker.textContent = 'before';
            $marker.className = 'v-marker before';
            $marker.style.display = '';
        } else if (isAfter) {
            $marker.textContent = 'after';
            $marker.className = 'v-marker after';
            $marker.style.display = '';
        } else if (isFirst) {
            $marker.textContent = 'first';
            $marker.className = 'v-marker first';
            $marker.style.display = '';
        } else if (isLast) {
            $marker.textContent = 'last';
            $marker.className = 'v-marker last';
            $marker.style.display = '';
        } else {
            $marker.style.display = 'none';
        }
    }

    function updateButtons() {
        if (_isLastOnRight) {
            $btnAcceptLeft.classList.add('visible');
            if ($btnSaveLast) $btnSaveLast.style.display = '';
        } else {
            $btnAcceptLeft.classList.remove('visible');
            if ($btnSaveLast) $btnSaveLast.style.display = 'none';
        }
    }

    // ═══ Monaco 加载 ═══
    function loadMonaco() {
        return new Promise(function (resolve) {
            if (_monacoLoaded && window.monaco) { resolve(); return; }
            var baseUrl = 'qqqide-asset://monaco/vs';
            var s = document.createElement('script');
            s.src = baseUrl + '/loader.js';
            s.onload = function () {
                require.config({ paths: { vs: baseUrl } });
                window.MonacoEnvironment = {
                    getWorker: function () {
                        return new Worker('qqqide-asset://monaco/vs/base/worker/workerMain.js');
                    }
                };
                require(['vs/editor/editor.main'], function () {
                    _monacoLoaded = true;
                    // 注册 solarized 主题，与 X 区 editor 配色一致
                    _registerDiffThemes(window.monaco);
                    resolve();
                }, function (err) {
                    console.error('[diff] monaco load failed:', err);
                    $emptyState.textContent = 'Monaco 加载失败';
                    resolve();
                });
            };
            s.onerror = function () {
                $emptyState.textContent = 'Monaco 加载失败';
                resolve();
            };
            document.head.appendChild(s);
        }).then(function () {
            return renderDiff();
        });
    }

    // ═══ 渲染 Diff ═══
    var _renderToken = 0; // 防并发竞态
    var _oldOriginalModel = null, _oldModifiedModel = null; // 显式释放旧 model
    async function renderDiff() {
        if (!_monacoLoaded || !window.monaco) return;
        var leftVal = $selLeft.value;
        var rightVal = $selRight.value;
        if (!leftVal || !rightVal) return;

        // 防并发：只允许最新一次渲染生效
        var token = ++_renderToken;

        var leftContent = '', rightContent = '';
        try {
            leftContent = (leftVal === 'last') ? (_lastContent || '')
                : (await bridge.timeline.content({ projectRoot: PROJECT_ROOT, blobHash: leftVal }) || '');
            rightContent = (rightVal === 'last') ? (_lastContent || '')
                : (await bridge.timeline.content({ projectRoot: PROJECT_ROOT, blobHash: rightVal }) || '');
        } catch (e) {
            console.error('[diff] content load failed:', e);
        }
        // 竞态检查：如果在这期间又触发了新渲染，放弃本次
        if (token !== _renderToken) return;

        var lang = langOf(FILE_PATH);
        var monaco = window.monaco;

        // 释放旧 model（Monaco dispose 不自动释放 model）
        if (_oldOriginalModel) { _oldOriginalModel.dispose(); _oldOriginalModel = null; }
        if (_oldModifiedModel) { _oldModifiedModel.dispose(); _oldModifiedModel = null; }
        if (_diffEditor) { _diffEditor.dispose(); _diffEditor = null; }

        $emptyState.style.display = 'none';
        $diffContainer.style.display = '';

        _diffEditor = monaco.editor.createDiffEditor($diffContainer, {
            renderSideBySide: true,
            readOnly: !_isLastOnRight,
            originalEditable: false,
            automaticLayout: true,
            minimap: { enabled: true, showSlider: 'mouseover' },
            scrollbar: { vertical: 'hidden', horizontal: 'hidden' },
            wordWrap: 'on',
            wordWrapColumn: 0,
            renderIndicators: false,
            renderOverviewRuler: true,
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            theme: THEME,
        });

        var originalModel = monaco.editor.createModel(leftContent, lang);
        var modifiedModel = monaco.editor.createModel(rightContent, lang);
        _oldOriginalModel = originalModel;
        _oldModifiedModel = modifiedModel;

        if (_isLastOnRight) {
            modifiedModel.onDidChangeContent(function () {
                _lastContent = modifiedModel.getValue();
                updateDiffStats();
            });
        }

        _diffEditor.setModel({ original: originalModel, modified: modifiedModel });
        // 极致精简：只保留代码染色，剔除一切智能功能
        _stripEditor(_diffEditor.getOriginalEditor());
        _stripEditor(_diffEditor.getModifiedEditor());
        var _firstDiffReady = false;
        _diffEditor.onDidUpdateDiff(function () {
            updateDiffStats();
            _applyHiddenAreas();
            if (!_firstDiffReady) {
                _firstDiffReady = true;
                _scrollToFirstChange();
            }
        });
        updateDiffStats();
        $statMode.textContent = _showFull ? '全文' : '差异';
        $btnFull.classList.toggle('active', _showFull);
        $btnHideUnchanged.classList.toggle('active', !_showFull);
    }

    function updateDiffStats() {
        if (!_diffEditor) return;
        var changes = _diffEditor.getLineChanges();
        if (!changes) return;
        var added = 0, deleted = 0;
        for (var i = 0; i < changes.length; i++) {
            var c = changes[i];
            if (c.originalEndLineNumber > 0 && c.modifiedEndLineNumber > 0) {
                var ol = c.originalEndLineNumber - c.originalStartLineNumber + 1;
                var ml = c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
                if (ml > ol) added += ml - ol;
                else if (ol > ml) deleted += ol - ml;
            } else if (c.modifiedEndLineNumber > 0) {
                added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
            } else if (c.originalEndLineNumber > 0) {
                deleted += c.originalEndLineNumber - c.originalStartLineNumber + 1;
            }
        }
        $statAdded.textContent = '+' + added;
        $statDeleted.textContent = '-' + deleted;
        $statChanges.textContent = changes.length + ' 处修改';
    }

    // ═══ 自动滚动到第一个差异块 ═══
    function _scrollToFirstChange() {
        if (!_diffEditor) return;
        var changes = _diffEditor.getLineChanges();
        if (!changes || !changes.length) return;
        var first = changes[0];
        // 优先用 original 行号（纯删除时 modified 为 0）
        var line = first.originalStartLineNumber > 0
            ? first.originalStartLineNumber
            : first.modifiedStartLineNumber;
        if (!line || line <= 0) return;
        try {
            // 滚动左侧（original）编辑器，并排模式下双侧同步
            _diffEditor.getOriginalEditor().revealLineInCenter(line);
        } catch (_) { }
    }

    // ═══ 极致精简编辑器（只保留代码染色） ═══
    function _stripEditor(editor) {
        if (!editor) return;
        try {
            editor.updateOptions({
                // ★ 只保留 tokenization（语法染色），其余全部关死
                // 滚动/视口
                scrollbar: { vertical: 'hidden', horizontal: 'hidden' },
                scrollBeyondLastLine: false,
                smoothScrolling: false,
                cursorBlinking: 'solid',
                cursorSmoothCaretAnimation: 'off',
                cursorSurroundingLines: 0,
                // 装饰/标注
                minimap: { enabled: false },           // 内编辑器不画 minimap（diff 级别已有一个）
                glyphMargin: false,
                lineDecorationsWidth: 0,
                renderLineHighlight: 'none',
                renderLineHighlightOnlyWhenFocus: true,
                overviewRulerLanes: 0,
                renderOverviewRuler: false,
                hideCursorInOverviewRuler: true,
                overviewRulerBorder: false,
                // 智能功能全杀
                occurrencesHighlight: false,
                selectionHighlight: false,
                matchBrackets: 'never',
                bracketPairColorization: { enabled: false },
                autoClosingBrackets: 'never',
                autoClosingQuotes: 'never',
                autoIndent: 'none',
                // LSP / 语法检查 / 红色波浪线
                renderValidationDecorations: 'off',
                // 建议/提示
                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                acceptSuggestionOnEnter: 'off',
                tabCompletion: 'off',
                wordBasedSuggestions: false,
                parameterHints: { enabled: false },
                inlayHints: { enabled: false },
                // 悬浮/灯泡/引用
                hover: { enabled: false },
                links: false,
                codeLens: false,
                colorDecorators: false,
                lightbulb: { enabled: false },
                // 缩进/参考线
                guides: { indentation: false, bracketPairs: false, bracketPairsHorizontal: false, highlightActiveIndentation: false },
                renderIndentGuides: false,
                // 折叠/空白/控制字符
                folding: false,
                renderWhitespace: 'none',
                renderControlCharacters: false,
                unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false },
                // 拖拽/剪贴板/搜索
                dragAndDrop: false,
                selectionClipboard: false,
                emptySelectionClipboard: false,
                contextmenu: false,
                // 其他
                rulers: [],
                roundedSelection: false,
                padding: { top: 0, bottom: 0 },
                stickyScroll: { enabled: false },
                find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never', seedSearchStringFromSelection: 'never' },
            });
        } catch (_) { }
    }

    // ═══ 手动折叠未变更行（Monaco 0.34.1 无 hideUnchangedRegions） ═══
    var _HIDE_CONTEXT = 3;  // 隐藏区域前后保留的上下文行数
    var _HIDE_MIN = 3;       // 少于该行数的未变更块不折叠
    function _applyHiddenAreas() {
        if (!_diffEditor) return;
        var originalEditor = _diffEditor.getOriginalEditor();
        var modifiedEditor = _diffEditor.getModifiedEditor();
        if (_showFull) {
            // 全文模式：清除所有隐藏区域
            try { originalEditor.setHiddenAreas([]); } catch (_) { }
            try { modifiedEditor.setHiddenAreas([]); } catch (_) { }
            return;
        }
        var changes = _diffEditor.getLineChanges();
        if (!changes || !changes.length) return;
        var monaco = window.monaco;
        if (!monaco) return;

        // 为每个编辑器计算未变更行范围
        var oModel = originalEditor.getModel();
        var mModel = modifiedEditor.getModel();
        var oTotal = oModel ? oModel.getLineCount() : 0;
        var mTotal = mModel ? mModel.getLineCount() : 0;

        // 收集两侧各自的变更行范围
        var oChanged = [];  // [{start, end}]
        var mChanged = [];
        for (var i = 0; i < changes.length; i++) {
            var c = changes[i];
            if (c.originalEndLineNumber > 0) {
                oChanged.push({ start: c.originalStartLineNumber, end: c.originalEndLineNumber });
            }
            if (c.modifiedEndLineNumber > 0) {
                mChanged.push({ start: c.modifiedStartLineNumber, end: c.modifiedEndLineNumber });
            }
        }

        // 从变更范围推导未变更范围（取反）
        function invertRanges(changed, total) {
            if (!total || total <= 0) return [];
            var result = [];
            var cur = 1;
            for (var j = 0; j < changed.length; j++) {
                if (changed[j].start > cur) {
                    result.push({ start: cur, end: changed[j].start - 1 });
                }
                cur = changed[j].end + 1;
            }
            if (cur <= total) {
                result.push({ start: cur, end: total });
            }
            return result;
        }

        // 应用上下文收缩：保留块首尾各 _HIDE_CONTEXT 行
        function shrinkRanges(ranges) {
            var out = [];
            for (var k = 0; k < ranges.length; k++) {
                var r = ranges[k];
                var len = r.end - r.start + 1;
                if (len < _HIDE_MIN) continue;          // 小于最小行数，不折叠
                if (len <= _HIDE_CONTEXT * 2) continue;  // 不够藏，全显示
                out.push({ start: r.start + _HIDE_CONTEXT, end: r.end - _HIDE_CONTEXT });
            }
            return out;
        }

        var oUnchanged = shrinkRanges(invertRanges(oChanged, oTotal));
        var mUnchanged = shrinkRanges(invertRanges(mChanged, mTotal));

        // 转为 Monaco Range 数组
        function toRanges(arr) {
            return arr.map(function (r) {
                return new monaco.Range(r.start, 1, r.end, 1);
            });
        }

        try { originalEditor.setHiddenAreas(toRanges(oUnchanged)); } catch (_) { }
        try { modifiedEditor.setHiddenAreas(toRanges(mUnchanged)); } catch (_) { }
    }

    // ═══ 按钮事件 ═══
    function applyDiffMode() {
        if (!_diffEditor) { renderDiff(); return; }
        _applyHiddenAreas();
        $btnFull.classList.toggle('active', _showFull);
        $btnHideUnchanged.classList.toggle('active', !_showFull);
        $statMode.textContent = _showFull ? '全文' : '差异';
        _savePref('showFull', _showFull);
        // 切换模式后跳到第一个差异行（等隐藏区域清空/应用后再跳）
        setTimeout(function () { _scrollToFirstChange(); }, 50);
    }
    $btnFull.addEventListener('click', function () {
        _showFull = !_showFull;
        applyDiffMode();
    });
    $btnHideUnchanged.addEventListener('click', function () {
        _showFull = false;
        applyDiffMode();
    });
    $btnAcceptLeft.addEventListener('click', function () {
        if (!_isLastOnRight || !_diffEditor) return;
        var changes = _diffEditor.getLineChanges();
        if (!changes || !changes.length) return;
        var monaco = window.monaco;
        var modifiedModel = _diffEditor.getModifiedEditor().getModel();
        var edits = [];
        for (var i = changes.length - 1; i >= 0; i--) {
            var c = changes[i];
            if (c.originalEndLineNumber === 0) continue;
            if (c.modifiedEndLineNumber === 0) {
                edits.push({ range: new monaco.Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber + 1, 1), text: '' });
            } else {
                var leftText = _diffEditor.getOriginalEditor().getModel().getValueInRange({
                    startLineNumber: c.originalStartLineNumber, startColumn: 1,
                    endLineNumber: c.originalEndLineNumber, endColumn: Number.MAX_SAFE_INTEGER,
                });
                edits.push({ range: new monaco.Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber, Number.MAX_SAFE_INTEGER), text: leftText });
            }
        }
        if (edits.length) {
            modifiedModel.pushEditOperations([], edits, function () { return null; });
            _lastContent = modifiedModel.getValue();
            updateDiffStats();
        }
    });
    if ($btnSaveLast) $btnSaveLast.addEventListener('click', async function () {
        if (!_isLastOnRight || !_diffEditor) return;
        var content = _diffEditor.getModifiedEditor().getModel().getValue();
        try {
            await bridge.fs.write(FILE_PATH, content);
            _lastContent = content;
            try { await bridge.timeline.record({ projectRoot: PROJECT_ROOT, filePath: FILE_PATH, content: content, source: 'diff-save' }); } catch (_) { }
            $statMode.textContent = '已保存';
            // 更新 mtime，下次 loadVersions 时用
            _lastMtimeMs = Date.now();
            setTimeout(function () { $statMode.textContent = _showFull ? '全文' : '差异'; }, 1500);
        } catch (e) {
            console.error('[diff] save failed:', e);
            $statMode.textContent = '保存失败';
            $statMode.style.color = 'var(--red)';
            setTimeout(function () { $statMode.textContent = _showFull ? '全文' : '差异'; $statMode.style.color = ''; }, 2000);
        }
    });

    // ═══ 工具 ═══
    function formatTs(ts) {
        if (!ts) return '—';
        var d = new Date(ts);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + ' ' +
            String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0') + ':' +
            String(d.getSeconds()).padStart(2, '0');
    }

    function langOf(fp) {
        var ext = (fp || '').split('.').pop().toLowerCase();
        var map = { js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java', cpp: 'cpp', c: 'c', h: 'cpp', html: 'html', htm: 'html', css: 'css', scss: 'scss', xml: 'xml', yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell', sql: 'sql', lua: 'lua', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', r: 'r' };
        return map[ext] || 'plaintext';
    }

    function _escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function _escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

    // ═══ 全局持久化偏好（跨窗口记忆） ═══
    function _savePref(key, value) {
        try {
            if (bridge && bridge.state) {
                bridge.state.setNow(_PREF_NS, key, value);
            }
        } catch (_) { }
    }

    // ═══ 注册 solarized 主题（与 X 区 editor 配色一致） ═══
    function _registerDiffThemes(monaco) {
        if (!monaco || !monaco.editor) return;
        try {
            monaco.editor.defineTheme('solarized-light', {
                base: 'vs', inherit: false,
                colors: {
                    'editor.background': '#FDF6E3',
                    'editor.foreground': '#5c7060',
                    'editor.lineHighlightBackground': '#EEE8D5',
                    'editorLineNumber.foreground': '#777777',
                    'editorCursor.foreground': '#58685e',
                    'editor.selectionBackground': '#E8A090',
                    'editor.inactiveSelectionBackground': '#E8C8B8',
                    'editorOverviewRuler.border': '#00000000',
                    'focusBorder': '#b58900',
                    'editorWidget.background': '#eee8d5',
                    'editorWidget.foreground': '#5c7060',
                    'editorWidget.border': '#d3c6aa',
                    'input.background': '#fdf6e3',
                    'input.foreground': '#5c7060',
                    'input.border': '#d3c6aa',
                    'inputOption.activeBorder': '#b58900',
                    'inputOption.activeBackground': '#eee8d5',
                    'editor.findMatchBackground': '#ffd30266',
                    'editor.findMatchHighlightBackground': '#ffd30233',
                    'editor.findRangeHighlightBackground': '#ffd30215',
                },
                rules: [
                    { token: '', foreground: '5c7060', background: 'FDF6E3' },
                    { token: 'comment', foreground: '95958a', fontStyle: 'italic' },
                    { token: 'string', foreground: '2a9a78' },
                    { token: 'string.regexp', foreground: 'DC322F' },
                    { token: 'number', foreground: 'c83070' },
                    { token: 'variable', foreground: '4078a0' },
                    { token: 'keyword', foreground: '859900' },
                    { token: 'storage', foreground: '58685e', fontStyle: 'bold' },
                    { token: 'type', foreground: 'CB4B16' },
                    { token: 'namespace', foreground: 'CB4B16' },
                    { token: 'function', foreground: '4078a0' },
                    { token: 'variable.predefined', foreground: 'B58900' },
                    { token: 'constant', foreground: 'CB4B16' },
                    { token: 'tag', foreground: '4078a0' },
                    { token: 'attribute.name', foreground: '95958a' },
                    { token: 'support.function', foreground: '4078a0' },
                    { token: 'support.type', foreground: '859900' },
                    { token: 'support', foreground: '839080' },
                    { token: 'invalid', foreground: 'DC322F' },
                ]
            });
            monaco.editor.defineTheme('solarized-dark', {
                base: 'vs-dark', inherit: false,
                colors: {
                    'editor.background': '#1e1e1e',
                    'editor.foreground': '#dcd8d0',
                    'editor.lineHighlightBackground': '#2a2a2a',
                    'editorLineNumber.foreground': '#97978a',
                    'editorCursor.foreground': '#c8c4b8',
                    'editor.selectionBackground': '#5a3a2a',
                    'editor.inactiveSelectionBackground': '#4a3020',
                    'editorOverviewRuler.border': '#00000000',
                    'focusBorder': '#d4a017',
                    'editorWidget.background': '#2a2a2a',
                    'editorWidget.foreground': '#dcd8d0',
                    'editorWidget.border': '#333333',
                    'input.background': '#1e1e1e',
                    'input.foreground': '#dcd8d0',
                    'input.border': '#555555',
                    'inputOption.activeBorder': '#d4a017',
                    'inputOption.activeBackground': '#3a3520',
                    'editor.findMatchBackground': '#d4a01766',
                    'editor.findMatchHighlightBackground': '#d4a01733',
                    'editor.findRangeHighlightBackground': '#d4a01715',
                },
                rules: [
                    { token: '', foreground: 'dcd8d0', background: '1e1e1e' },
                    { token: 'comment', foreground: '6a6660', fontStyle: 'italic' },
                    { token: 'string', foreground: '8fbc5a' },
                    { token: 'string.regexp', foreground: 'ff4444' },
                    { token: 'number', foreground: 'b85872' },
                    { token: 'variable', foreground: 'd4a017' },
                    { token: 'keyword', foreground: '8fbc5a' },
                    { token: 'storage', foreground: 'c8c4b8', fontStyle: 'bold' },
                    { token: 'type', foreground: 'e07020' },
                    { token: 'namespace', foreground: 'e07020' },
                    { token: 'function', foreground: 'd4a017' },
                    { token: 'variable.predefined', foreground: 'd4a017' },
                    { token: 'constant', foreground: 'e07020' },
                    { token: 'tag', foreground: 'e07020' },
                    { token: 'attribute.name', foreground: 'c8c4b8' },
                    { token: 'support.function', foreground: 'd4a017' },
                    { token: 'support.type', foreground: '8fbc5a' },
                    { token: 'support', foreground: 'a8a49c' },
                    { token: 'invalid', foreground: 'ff4444' },
                ]
            });
        } catch (e) {
            console.warn('[diff] defineTheme failed:', e && e.message);
        }
    }

    // ═══ 监听主题切换（来自主窗口 qqqide-theme.js 的广播） ═══
    if (bridge && bridge.sync && bridge.sync.onMessage) {
        bridge.sync.onMessage(function (channel, data) {
            if (channel !== 'theme-change') return;
            var newDark = !!(data && data.dark);
            THEME = newDark ? 'solarized-dark' : 'solarized-light';
            document.documentElement.setAttribute('data-theme', newDark ? 'dark' : 'light');
            if (_diffEditor) {
                try { _diffEditor.updateOptions({ theme: THEME }); } catch (_) { }
            }
        });
    }
})();
