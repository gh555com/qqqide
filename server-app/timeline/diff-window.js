// ============================================================================
// timeline/diff-window.js — Monaco Diff 独立 BrowserWindow 逻辑
//
// 职责：
//   ① 从 URL params 获取文件路径 + 项目根 + initial before/after blob hash
//   ② 通过 bridge.timeline.* 获取版本列表和内容
//   ③ Monaco Diff Editor 渲染（side-by-side, minimap, 无滚动条, 自动换行）
//   ④ 版本下拉框（带 first/last/before/after 标记）
//   ⑤ 全文/差异切换 + 左右箭头 + 保存（仅 right=last 时可用）
// ============================================================================
(function () {
    'use strict';

    var bridge = window.qqqideBridge;
    var params = new URLSearchParams(location.search);
    var FILE_PATH = params.get('path') || '';
    var PROJECT_ROOT = params.get('projectRoot') || '';
    var INIT_BEFORE = params.get('before') || '';
    var INIT_AFTER = params.get('after') || '';

    // 状态
    var _versions = [];          // [{ts, blob_hash, source, floor_id}]
    var _lastContent = null;     // 最新文件内容缓存
    var _lastMtimeMs = null;     // 最新文件时间戳
    var _showFull = false;       // true=全文, false=仅差异
    var _isLastOnRight = false;  // 右侧是否为 last
    var _diffEditor = null;
    var _monacoLoaded = false;

    // DOM
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
    document.getElementById('btn-min').addEventListener('click', function () {
        if (bridge && bridge.window) bridge.window.minimize();
    });
    document.getElementById('btn-max').addEventListener('click', function () {
        if (bridge && bridge.window) {
            bridge.window.isMaximized().then(function (maxed) {
                if (maxed) { bridge.window.unmaximize(); }
                else { bridge.window.maximize(); }
            });
        }
    });
    document.getElementById('btn-close').addEventListener('click', function () {
        if (bridge && bridge.window) bridge.window.close();
    });

    // ═══ 入口 ═══
    (async function init() {
        if (!FILE_PATH || !PROJECT_ROOT) {
            $emptyState.textContent = '缺少文件路径或项目根参数';
            return;
        }
        $filePath.textContent = FILE_PATH;
        $filePath.title = FILE_PATH;
        await loadVersions();
    })();

    // ═══ 加载版本列表 ═══
    async function loadVersions() {
        $emptyState.textContent = '加载版本列表…';
        try {
            _versions = await bridge.timeline.versions({ projectRoot: PROJECT_ROOT, filePath: FILE_PATH });
        } catch (e) {
            console.error('[diff] versions failed:', e);
            _versions = [];
        }

        // 获取当前文件（last）
        try {
            _lastContent = await bridge.timeline.readCurrent(FILE_PATH);
            var st = await bridge.timeline.stat(FILE_PATH);
            if (st) _lastMtimeMs = st.mtimeMs;
        } catch (_) {
            _lastContent = null;
            _lastMtimeMs = null;
        }

        if (_versions.length === 0 && !_lastContent) {
            $emptyState.textContent = '该文件没有历史版本，也没有当前内容';
            return;
        }

        populateDropdowns();
        await loadMonaco();
        $emptyState.style.display = 'none';
    }

    // ═══ 填充下拉框 ═══
    function populateDropdowns() {
        var options = [];

        // 构建选项列表：历史版本 + last
        for (var i = 0; i < _versions.length; i++) {
            var v = _versions[i];
            var isFirst = (i === 0);
            options.push({
                value: v.blob_hash,
                label: formatTs(v.ts),
                ts: v.ts,
                source: v.source,
                isFirst: isFirst,
            });
        }

        // last 选项
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

        // 生成 HTML
        var html = '';
        for (var j = 0; j < options.length; j++) {
            var o = options[j];
            var marker = '';
            if (o.isFirst) marker = ' [first]';
            if (o.isLast) marker = ' [last]';
            html += '<option value="' + _escAttr(o.value) + '">' + _escHtml(o.label) + marker + '</option>';
        }

        $selLeft.innerHTML = html;
        $selRight.innerHTML = html;

        // 设定初始选择
        if (INIT_AFTER && optionExists(INIT_AFTER)) {
            $selRight.value = INIT_AFTER;
        } else if (options.length > 0) {
            $selRight.value = options[options.length - 1].value; // last
        }

        if (INIT_BEFORE && optionExists(INIT_BEFORE)) {
            $selLeft.value = INIT_BEFORE;
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
        $selLeft.addEventListener('change', onVersionChange);
        $selRight.addEventListener('change', onVersionChange);
    }

    function optionExists(val) {
        return $selRight.querySelector('option[value="' + val.replace(/"/g, '\\"') + '"]') !== null;
    }

    function updateMarkers() {
        updateOneMarker($selLeft, $markerLeft);
        updateOneMarker($selRight, $markerRight);
        _isLastOnRight = ($selRight.value === 'last');
        updateAcceptButton();
    }

    function updateOneMarker($sel, $marker) {
        var val = $sel.value;
        if (!val) { $marker.style.display = 'none'; return; }
        var isFirst = (val !== 'last' && _versions.length > 0 && _versions[0].blob_hash === val);
        var isLast = (val === 'last');
        if (isFirst) {
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

    function updateAcceptButton() {
        if (_isLastOnRight) {
            $btnAcceptLeft.classList.add('visible');
            if ($btnSaveLast) $btnSaveLast.style.display = '';
        } else {
            $btnAcceptLeft.classList.remove('visible');
            if ($btnSaveLast) $btnSaveLast.style.display = 'none';
        }
    }

    // ═══ 版本切换 ═══
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
                    $emptyState.textContent = 'Monaco Editor 加载失败';
                    resolve();
                });
            };
            s.onerror = function () {
                console.error('[diff] monaco loader.js failed');
                $emptyState.textContent = 'Monaco Editor 加载失败';
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

        var leftContent, rightContent;
        try {
            if (leftVal === 'last') {
                leftContent = _lastContent || '';
            } else {
                leftContent = await bridge.timeline.content({ projectRoot: PROJECT_ROOT, blobHash: leftVal });
                if (leftContent === null) leftContent = '';
            }
            if (rightVal === 'last') {
                rightContent = _lastContent || '';
            } else {
                rightContent = await bridge.timeline.content({ projectRoot: PROJECT_ROOT, blobHash: rightVal });
                if (rightContent === null) rightContent = '';
            }
        } catch (e) {
            console.error('[diff] content load failed:', e);
            leftContent = ''; rightContent = '';
        }

        var lang = langOf(FILE_PATH);
        var monaco = window.monaco;

        // Dispose previous
        if (_diffEditor) {
            _diffEditor.dispose();
            _diffEditor = null;
        }

        // 隐藏 empty state
        $emptyState.style.display = 'none';
        $diffContainer.style.display = '';

        _diffEditor = monaco.editor.createDiffEditor($diffContainer, {
            renderSideBySide: true,
            readOnly: !_isLastOnRight,          // 右侧非 last → 整体只读
            originalEditable: false,             // 左侧永远只读
            automaticLayout: true,               // 自动响应容器大小
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

        // 右侧 last → 允许编辑
        if (_isLastOnRight) {
            modifiedModel.onDidChangeContent(function () {
                _lastContent = modifiedModel.getValue();
                updateDiffStats();
            });
        }

        _diffEditor.setModel({
            original: originalModel,
            modified: modifiedModel,
        });

        // 更新差异统计
        _diffEditor.onDidUpdateDiff(function () {
            updateDiffStats();
        });
        updateDiffStats();
        $statMode.textContent = '并排';

        // 按钮状态
        $btnFull.classList.toggle('active', _showFull);
        $btnHideUnchanged.classList.toggle('active', !_showFull);
    }

    // ═══ 差异统计 ═══
    function updateDiffStats() {
        if (!_diffEditor) return;
        var changes = _diffEditor.getLineChanges();
        if (!changes) return;
        var added = 0, deleted = 0;
        for (var i = 0; i < changes.length; i++) {
            var c = changes[i];
            if (c.originalEndLineNumber > 0 && c.modifiedEndLineNumber > 0) {
                var origLines = c.originalEndLineNumber - c.originalStartLineNumber + 1;
                var modLines = c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
                if (modLines > origLines) { added += modLines - origLines; }
                else if (origLines > modLines) { deleted += origLines - modLines; }
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

    $btnAcceptLeft.addEventListener('click', async function () {
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
                var delRange = new monaco.Range(
                    c.modifiedStartLineNumber, 1,
                    c.modifiedEndLineNumber + 1, 1
                );
                edits.push({ range: delRange, text: '' });
            } else {
                var leftText = _diffEditor.getOriginalEditor().getModel().getValueInRange({
                    startLineNumber: c.originalStartLineNumber,
                    startColumn: 1,
                    endLineNumber: c.originalEndLineNumber,
                    endColumn: Number.MAX_SAFE_INTEGER,
                });
                var replaceRange = new monaco.Range(
                    c.modifiedStartLineNumber, 1,
                    c.modifiedEndLineNumber, Number.MAX_SAFE_INTEGER
                );
                edits.push({ range: replaceRange, text: leftText });
            }
        }
        if (edits.length) {
            modifiedModel.pushEditOperations([], edits, function () { return null; });
            _lastContent = modifiedModel.getValue();
            updateDiffStats();
        }
    });

    // ★ 保存右侧（last）内容到磁盘
    $btnSaveLast.addEventListener('click', async function () {
        if (!_isLastOnRight || !_diffEditor) return;
        var modifiedModel = _diffEditor.getModifiedEditor().getModel();
        var content = modifiedModel.getValue();
        try {
            await bridge.fs.write(FILE_PATH, content);
            _lastContent = content;
            // 记录快照
            try {
                await bridge.timeline.record({ projectRoot: PROJECT_ROOT, filePath: FILE_PATH, content: content, source: 'diff-save' });
            } catch (_) { }
            // 更新状态栏
            var saved = document.getElementById('stat-mode');
            if (saved) { saved.textContent = '已保存'; setTimeout(function () { saved.textContent = '并排'; }, 1500); }
        } catch (e) {
            console.error('[diff] save failed:', e);
            var sm = document.getElementById('stat-mode');
            if (sm) { sm.textContent = '保存失败'; sm.style.color = 'var(--red)'; setTimeout(function () { sm.textContent = '并排'; sm.style.color = ''; }, 2000); }
        }
    });

    // ═══ 工具函数 ═══
    function formatTs(ts) {
        if (!ts) return '—';
        var d = new Date(ts);
        var Y = d.getFullYear();
        var M = String(d.getMonth() + 1).padStart(2, '0');
        var D = String(d.getDate()).padStart(2, '0');
        var h = String(d.getHours()).padStart(2, '0');
        var m = String(d.getMinutes()).padStart(2, '0');
        var s = String(d.getSeconds()).padStart(2, '0');
        return Y + '-' + M + '-' + D + ' ' + h + ':' + m + ':' + s;
    }

    function langOf(filePath) {
        var ext = (filePath || '').split('.').pop().toLowerCase();
        var map = {
            'js': 'javascript', 'mjs': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
            'json': 'json', 'md': 'markdown', 'py': 'python', 'rs': 'rust', 'go': 'go',
            'java': 'java', 'cpp': 'cpp', 'c': 'c', 'h': 'cpp', 'html': 'html', 'htm': 'html',
            'css': 'css', 'scss': 'scss', 'xml': 'xml', 'yml': 'yaml', 'yaml': 'yaml',
            'sh': 'shell', 'bash': 'shell', 'sql': 'sql', 'lua': 'lua', 'rb': 'ruby',
            'php': 'php', 'swift': 'swift', 'kt': 'kotlin', 'r': 'r',
        };
        return map[ext] || 'plaintext';
    }

    function _escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function _escAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

})();
