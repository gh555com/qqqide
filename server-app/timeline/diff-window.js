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

    var $filePath = document.getElementById('file-path');
    var $selLeft = document.getElementById('sel-left');
    var $selRight = document.getElementById('sel-right');
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
    var $btnClose = document.getElementById('btn-close');
    if ($btnClose) $btnClose.addEventListener('click', function () {
        if (bridge && bridge.window) bridge.window.close();
    });

    // ═══ 监听主进程推送 diff 更新（同文件再次点击 A4 时复用窗口） ═══
    if (bridge && bridge.timeline && bridge.timeline.onDiffUpdate) {
        bridge.timeline.onDiffUpdate(function (data) {
            _markedBefore = data.beforeBlobHash || '';
            _markedAfter = data.afterBlobHash || '';
            loadVersions(FILE_PATH);
        });
    }

    // ═══ 入口 ═══
    if (!FILE_PATH || !PROJECT_ROOT) {
        $emptyState.textContent = '缺少参数';
    } else {
        $filePath.textContent = FILE_PATH;
        $filePath.title = FILE_PATH;
        loadVersions(FILE_PATH);
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
            await loadMonaco();
            $emptyState.style.display = 'none';
            $diffContainer.style.display = '';
        } finally {
            _loading = false;
        }
    }

    var _options = []; // 下拉选项缓存，供 updateOneMarker 查合并条目

    // ═══ 填充下拉框 ═══
    function populateDropdowns() {
        var options = [];
        for (var i = 0; i < _versions.length; i++) {
            var v = _versions[i];
            options.push({
                value: v.blob_hash,
                label: formatTs(v.ts),
                ts: v.ts,
                source: v.source,
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
                    isFirst: isFirst,
                    isLast: true,
                });
            }
        }

        var beforeIdx = -1, afterIdx = -1;
        for (var b = 0; b < options.length; b++) {
            if (_markedBefore && (options[b].value === _markedBefore || options[b]._blobHash === _markedBefore)) beforeIdx = b;
            if (_markedAfter && (options[b].value === _markedAfter || options[b]._blobHash === _markedAfter)) afterIdx = b;
        }
        // ── 确保 before 在 after 之前（按时间线顺序）──
        // 只交换索引（显示位置），不交换标记语义
        if (beforeIdx >= 0 && beforeIdx === afterIdx && beforeIdx > 0) {
            beforeIdx = beforeIdx - 1;
        }
        if (beforeIdx >= 0 && afterIdx >= 0 && beforeIdx > afterIdx) {
            // 时间线顺序倒置：before 条目时间晚于 after 条目
            // 只交换显示位置，保持 _markedBefore/_markedAfter 语义不变
            var tmpI = beforeIdx; beforeIdx = afterIdx; afterIdx = tmpI;
        }

        // ── 构建 HTML，同标签条目合并标记 ──
        var mergedOptions = [];
        for (var j = 0; j < options.length; j++) {
            var o = options[j];
            var markers = [];
            if (o.isFirst) markers.push('first');
            if (j === beforeIdx) markers.push('before');
            if (j === afterIdx) markers.push('after');
            if (o.isLast) markers.push('last');
            // 如果与前一条目标签相同，合并标记到前一条
            if (mergedOptions.length > 0 && mergedOptions[mergedOptions.length - 1].label === o.label) {
                var prev = mergedOptions[mergedOptions.length - 1];
                for (var mi = 0; mi < markers.length; mi++) {
                    if (prev.markers.indexOf(markers[mi]) === -1) prev.markers.push(markers[mi]);
                }
                if (o.value === 'last') { prev.value = 'last'; prev._blobHash = o._blobHash || prev._blobHash; prev.isLast = true; }
                if (o._blobHash) prev._blobHash = o._blobHash;
                // 更新 beforeIdx/afterIdx 指向合并后的位置
                if (j === beforeIdx) beforeIdx = mergedOptions.length - 1;
                if (j === afterIdx) afterIdx = mergedOptions.length - 1;
                continue;
            }
            mergedOptions.push({ value: o.value, label: o.label, markers: markers, _blobHash: o._blobHash, isLast: o.isLast, ts: o.ts });
        }
        var html = '';
        for (var mj = 0; mj < mergedOptions.length; mj++) {
            var mo = mergedOptions[mj];
            var marker = mo.markers.length ? ' [' + mo.markers.join('] [') + ']' : '';
            html += '<option value="' + _escAttr(mo.value) + '">' + _escHtml(mo.label) + marker + '</option>';
        }
        options = mergedOptions; // 替换为合并后的列表

        $selLeft.innerHTML = html;
        $selRight.innerHTML = html;
        _options = options; // 缓存供 updateOneMarker 使用

        if (afterIdx >= 0) {
            $selRight.value = options[afterIdx].value;
        } else if (options.length > 0) {
            $selRight.value = options[options.length - 1].value;
        }
        if (beforeIdx >= 0) {
            $selLeft.value = options[beforeIdx].value;
        } else {
            var rightVal = $selRight.value;
            var rightIdx = -1;
            for (var k = 0; k < options.length; k++) {
                if (options[k].value === rightVal) { rightIdx = k; break; }
            }
            if (rightIdx > 0) {
                $selLeft.value = options[rightIdx - 1].value;
            } else if (options.length >= 2) {
                $selLeft.value = options[0].value;
            }
        }

        updateMarkers();
        $selLeft.onchange = null;
        $selRight.onchange = null;
        $selLeft.addEventListener('change', onVersionChange);
        $selRight.addEventListener('change', onVersionChange);
    }

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

    async function onVersionChange() {
        updateMarkers();
        await renderDiff();
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
                // 语法染色保留（tokenization），其余全关
                occurrencesHighlight: false,
                selectionHighlight: false,
                renderLineHighlight: 'none',
                matchBrackets: 'never',
                glyphMargin: false,
                folding: false,
                lineDecorationsWidth: 0,
                renderWhitespace: 'none',
                cursorBlinking: 'solid',
                cursorSmoothCaretAnimation: 'off',
                smoothScrolling: false,
                links: false,
                contextmenu: false,
                quickSuggestions: false,
                parameterHints: { enabled: false },
                hover: { enabled: false },
                codeLens: false,
                colorDecorators: false,
                lightbulb: { enabled: false },
                tabCompletion: 'off',
                wordBasedSuggestions: false,
                suggestOnTriggerCharacters: false,
                acceptSuggestionOnEnter: 'off',
                selectionClipboard: false,
                scrollBeyondLastLine: false,
                unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false },
                renderControlCharacters: false,
                renderIndentGuides: false,
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
        var map = { js:'javascript', mjs:'javascript', ts:'typescript', tsx:'typescript', json:'json', md:'markdown', py:'python', rs:'rust', go:'go', java:'java', cpp:'cpp', c:'c', h:'cpp', html:'html', htm:'html', css:'css', scss:'scss', xml:'xml', yml:'yaml', yaml:'yaml', sh:'shell', bash:'shell', sql:'sql', lua:'lua', rb:'ruby', php:'php', swift:'swift', kt:'kotlin', r:'r' };
        return map[ext] || 'plaintext';
    }

    function _escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function _escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

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
