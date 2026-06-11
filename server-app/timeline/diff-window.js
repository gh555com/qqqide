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

    var _versions = [];
    var _lastContent = null;
    var _lastMtimeMs = null;
    var _markedBefore = INIT_BEFORE;
    var _markedAfter = INIT_AFTER;
    var _showFull = false;
    var _isLastOnRight = false;
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
    async function loadVersions(filePath) {
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
        populateDropdowns();
        await loadMonaco();
        $emptyState.style.display = 'none';
        $diffContainer.style.display = '';
    }

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
        if (_lastContent !== null) {
            options.push({
                value: 'last',
                label: formatTs(_lastMtimeMs),
                ts: _lastMtimeMs || Date.now(),
                source: 'current',
                isFirst: isFirst,
                isLast: true,
            });
        }

        var beforeIdx = -1, afterIdx = -1;
        for (var b = 0; b < options.length; b++) {
            if (_markedBefore && options[b].value === _markedBefore) beforeIdx = b;
            if (_markedAfter && options[b].value === _markedAfter) afterIdx = b;
        }
        if (beforeIdx >= 0 && afterIdx >= 0 && beforeIdx > afterIdx) {
            var tmpSwap = _markedBefore;
            _markedBefore = _markedAfter;
            _markedAfter = tmpSwap;
            var tmpI = beforeIdx; beforeIdx = afterIdx; afterIdx = tmpI;
        }

        var html = '';
        for (var j = 0; j < options.length; j++) {
            var o = options[j];
            var marker = '';
            if (j === beforeIdx) marker = ' [before]';
            else if (j === afterIdx) marker = ' [after]';
            else if (o.isFirst) marker = ' [first]';
            if (o.isLast) marker += ' [last]';
            html += '<option value="' + _escAttr(o.value) + '">' + _escHtml(o.label) + marker + '</option>';
        }

        $selLeft.innerHTML = html;
        $selRight.innerHTML = html;

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
        var isBefore = (_markedBefore && val === _markedBefore);
        var isAfter = (_markedAfter && val === _markedAfter);
        var isFirst = (val !== 'last' && _versions.length > 0 && _versions[0].blob_hash === val);
        var isLast = (val === 'last');
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
    async function renderDiff() {
        if (!_monacoLoaded || !window.monaco) return;
        var leftVal = $selLeft.value;
        var rightVal = $selRight.value;
        if (!leftVal || !rightVal) return;

        var leftContent = '', rightContent = '';
        try {
            leftContent = (leftVal === 'last') ? (_lastContent || '')
                : (await bridge.timeline.content({ projectRoot: PROJECT_ROOT, blobHash: leftVal }) || '');
            rightContent = (rightVal === 'last') ? (_lastContent || '')
                : (await bridge.timeline.content({ projectRoot: PROJECT_ROOT, blobHash: rightVal }) || '');
        } catch (e) {
            console.error('[diff] content load failed:', e);
        }

        var lang = langOf(FILE_PATH);
        var monaco = window.monaco;

        if (_diffEditor) { _diffEditor.dispose(); _diffEditor = null; }

        $emptyState.style.display = 'none';
        $diffContainer.style.display = '';

        _diffEditor = monaco.editor.createDiffEditor($diffContainer, {
            renderSideBySide: true,
            readOnly: !_isLastOnRight,
            originalEditable: false,
            automaticLayout: true,
            minimap: { enabled: true, showSlider: 'mouseover' },
            scrollbar: { vertical: 'hidden', horizontal: 'auto' },
            wordWrap: 'on',
            wordWrapColumn: 0,
            renderIndicators: true,
            renderOverviewRuler: true,
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            theme: 'vs-dark',
            hideUnchangedRegions: {
                enabled: !_showFull,
                revealLineCount: 3,
                minimumLineCount: 3,
            },
        });

        var originalModel = monaco.editor.createModel(leftContent, lang);
        var modifiedModel = monaco.editor.createModel(rightContent, lang);

        if (_isLastOnRight) {
            modifiedModel.onDidChangeContent(function () {
                _lastContent = modifiedModel.getValue();
                updateDiffStats();
            });
        }

        _diffEditor.setModel({ original: originalModel, modified: modifiedModel });
        _diffEditor.onDidUpdateDiff(function () { updateDiffStats(); });
        updateDiffStats();
        $statMode.textContent = '并排';
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

    // ═══ 按钮事件 ═══
    $btnFull.addEventListener('click', function () {
        _showFull = !_showFull;
        renderDiff();
    });
    $btnHideUnchanged.addEventListener('click', function () {
        _showFull = false;
        renderDiff();
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
            setTimeout(function () { $statMode.textContent = '并排'; }, 1500);
        } catch (e) {
            console.error('[diff] save failed:', e);
            $statMode.textContent = '保存失败';
            $statMode.style.color = 'var(--red)';
            setTimeout(function () { $statMode.textContent = '并排'; $statMode.style.color = ''; }, 2000);
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
})();
