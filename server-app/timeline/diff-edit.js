// ============================================================================
// timeline/diff-edit.js — 编辑模式 + 仅差异 + 块箭头 + 工具函数 + 主题
// ============================================================================
'use strict';

    // ═══ 仅差异按钮 + 编辑模式 ═══
    function _syncDiffOnlyBtn() {
        if (!$btnDiffOnly) return;
        if (_diffOnly) {
            $btnDiffOnly.classList.add('checked');
        } else {
            $btnDiffOnly.classList.remove('checked');
        }
    }
    function _toggleDiffOnly() {
        _diffOnly = !_diffOnly;
        _syncDiffOnlyBtn();
        _applyHiddenAreas();
        _saveDiffOnlyPref(_diffOnly);
        setTimeout(function () { _scrollToFirstChange(); }, 50);
    }
    if ($btnDiffOnly) $btnDiffOnly.addEventListener('click', _toggleDiffOnly);

    function _toggleEdit() { _editing ? _exitEditMode() : _enterEditMode(); }
    async function _enterEditMode() {
        if (!_diffEditor) return;
        _editing = true;
        var latestContent = _lastContent || '';
        try { if (bridge && bridge.timeline && bridge.timeline.readCurrent) { var cur = await bridge.timeline.readCurrent(FILE_PATH); if (typeof cur === 'string') latestContent = cur; } } catch (_) { }
        _editDirty = false; _editSnapshotSeq = 0;
        _editOriginalContent = latestContent;
        $btnEdit.textContent = _i('timeline.cancelEdit', '取消编辑'); $btnEdit.classList.add('editing');
        var ddR = document.getElementById('dd-right'); if (ddR) ddR.style.display = 'none';
        if ($editStatus) $editStatus.classList.add('visible');
        var $btnSnap2 = document.getElementById('btn-snap'); if ($btnSnap2) $btnSnap2.style.display = '';
        var mr = document.getElementById('marker-right'); if (mr) mr.style.display = 'none';
        _updateEditStatus(); _setEditSnapText('');
        document.getElementById('sel-right').value = 'last'; _isLastOnRight = true;
        await _renderDiffWithLatest(latestContent);
        if (_diffEditor) {
            try { var me = _diffEditor.getModifiedEditor(); me.updateOptions({ readOnly: false }); me.focus(); } catch (_) { }
        }
    }
    async function _exitEditMode() {
        _editing = false; _e$btnEdit.textContent = _i('timeline.editBtn', '编辑'); $btnEdit.classList.remove('editing');lassList.remove('editing');
        _clearBlockArrows();
        var ddR = document.getElementById('dd-right'); if (ddR) ddR.style.display = '';
        if ($editStatus) $editStatus.classList.remove('visible');
        var $btnSnap3 = document.getElementById('btn-snap'); if ($btnSnap3) $btnSnap3.style.display = 'none';
        _updateEditStatus(); _setEditSnapText('');
        var mr = document.getElementById('marker-right'); if (mr) mr.style.display = '';
        await _refreshVersions();
        if (_diffEditor) {
            try { _diffEditor.getModifiedEditor().updateOptions({ readOnly: true }); _diffEditor.getOriginalEditor().updateOptions({ readOnly: true }); } catch (_) { }
        }
        renderDiff();
    }

    async function _renderDiffWithLatest(latestContent) {
        if (!_monacoLoaded || !window.monaco) return;
        var token = ++_renderToken;
        var leftVal = document.getElementById('sel-left').value;
        var leftContent = '';
        try { leftContent = (leftVal === 'last') ? (_lastContent || '') : (await bridge.timeline.content({ projectRoot: PROJECT_ROOT, blobHash: leftVal }) || ''); } catch (_) { }
        if (token !== _renderToken) return;
        var lang = langOf(FILE_PATH); var monaco = window.monaco;
        if (_oldOriginalModel) { _oldOriginalModel.dispose(); _oldOriginalModel = null; }
        if (_oldModifiedModel) { _oldModifiedModel.dispose(); _oldModifiedModel = null; }
        if (_diffEditor) { _diffEditor.dispose(); _diffEditor = null; }
        $emptyState.style.display = 'none'; $diffContainer.style.display = '';
        _diffEditor = monaco.editor.createDiffEditor($diffContainer, { renderSideBySide: true, readOnly: false, originalEditable: false, automaticLayout: true, minimap: { enabled: true, showSlider: 'mouseover' }, scrollbar: { vertical: 'hidden', horizontal: 'hidden' }, wordWrap: 'on', wordWrapColumn: 0, renderIndicators: false, renderOverviewRuler: true, fontSize: _editorFontSize, lineNumbers: 'on', lineNumbersMinChars: 2, lineDecorationsWidth: 10, scrollBeyondLastLine: 20, theme: THEME });
        var originalModel = monaco.editor.createModel(leftContent, lang);
        var modifiedModel = monaco.editor.createModel(latestContent, lang);
        _oldOriginalModel = originalModel; _oldModifiedModel = modifiedModel;
        modifiedModel.onDidChangeContent(function () { _lastContent = modifiedModel.getValue(); updateDiffStats(); _markEditDirty(); });
        _diffEditor.setModel({ original: originalModel, modified: modifiedModel });
        _stripEditor(_diffEditor.getOriginalEditor()); _stripEditor(_diffEditor.getModifiedEditor());
        try { _diffEditor.getOriginalEditor().updateOptions({ readOnly: true }); } catch (_) { }
        try { _diffEditor.getModifiedEditor().updateOptions({ readOnly: false }); } catch (_) { }
        _setupEditAutoSave(_diffEditor.getModifiedEditor());
        _setupEditCtrlS(_diffEditor.getModifiedEditor(), monaco);
        var firstDiffReady = false;
        _diffEditor.onDidUpdateDiff(function () {
            updateDiffStats(); _applyHiddenAreas();
            if (!firstDiffReady) { firstDiffReady = true; _scrollToFirstChange(); }
            if (_editing) _updateBlockArrows();
        });
        updateDiffStats(); _syncDiffOnlyBtn();
    }

    async function _saveEditContent() {
        if (!_editing || !_diffEditor) return false;
        var content = _lastContent;
        if (!content && _diffEditor.getModifiedEditor()) content = _diffEditor.getModifiedEditor().getModel().getValue();
        if (!content) return false;
        // 内容与进入编辑时一致 → 跳过保存
        if (content === _editOriginalContent) {
            _editDirty = false; _updateEditStatus();
            return true;
        }
        try {
            await bridge.fs.write(FILE_PATH, content);
            _lastContent = content; _editDirty = false;
            _editOriginalContent = content;
            _updateEditStatus();
            return true;
        } catch (e) { console.error('[diff] edit save failed:', e); return false; }
    }
    async function _snapshotEditContent() {
        if (!_editing || !_diffEditor) return;
        var content = _lastContent;
        if (!content && _diffEditor.getModifiedEditor()) content = _diffEditor.getModifiedEditor().getModel().getValue();
        if (!content) return;
        // 内容与进入编辑时一致 → 不写盘、不打快照
        if (content === _editOriginalContent) {
            _setEditSnapText(_i('timeline.snapUnchanged', '内容未变，无需打快照'));
            return;
        }
        _setEditSnapText(_i('timeline.snapping', '打快照中…'));
        try {
            await bridge.fs.write(FILE_PATH, content);
            _lastContent = content; _editDirty = false;
            _editOriginalContent = content;
            _updateEditStatus();
            var snapOk = false;
            try {
                var rec = await bridge.timeline.record({ projectRoot: PROJECT_ROOT, filePath: FILE_PATH, content: content, source: 'diff-edit' });
                if (rec && rec.ok && rec.recorded) {
                    _editSnapshotSeq++;
                    var _snapOkTmpl = _i('timeline.snapOk', '已打快照 #{seq} {time} diff edit');
                    _setEditSnapText(_snapOkTmpl.replace('{seq}', _editSnapshotSeq).replace('{time}', _formatTimestamp(Date.now())));
                    snapOk = true;
                } else {
                    _setEditSnapText(_i('timeline.snapNoNew', '未生成新快照，可能内容未变或冷却中'));
                }
            } catch (_) {
                _setEditSnapText(_i('timeline.snapFailed', '打快照失败'));
            }
            if (snapOk) await _refreshEditLeftDropdown();
        } catch (e) {
            console.error('[diff] snapshot save failed:', e);
            _setEditSnapText(_i('timeline.saveFailed', '保存失败，请重试'));
        }
    }
    // ★ 编辑模式下只刷新左侧下拉（右侧已隐藏），让新快照立即可在下拉中看到
    async function _refreshEditLeftDropdown() {
        try {
            var newVer = await bridge.timeline.versions({ projectRoot: PROJECT_ROOT, filePath: FILE_PATH });
            _versions = newVer || [];
            _lastContent = await bridge.timeline.readCurrent(FILE_PATH);
            var st = await bridge.timeline.stat(FILE_PATH); if (st) _lastMtimeMs = st.mtimeMs;
            // 只重建左侧下拉，保持右侧不变（编辑模式下右侧隐藏）
            var curLeft = $selLeft.value;
            populateDropdowns();
            var found = false;
            for (var oi = 0; oi < _options.length; oi++) {
                if (_options[oi].value === curLeft || _options[oi]._blobHash === curLeft) {
                    $selLeft.value = _options[oi].value;
                    _refreshDropdownBtn($ddLeftBtn, $selLeft.value, _options);
                    found = true; break;
                }
            }
            if (!found && _options.length > 0) {
                $selLeft.value = _options[_options.length - 1].value;
                _refreshDropdownBtn($ddLeftBtn, $selLeft.value, _options);
            }
            updateOneMarker($selLeft, $markerLeft);
        } catch (_) { }
    }
    function _setupEditAutoSave(editor) {
        if (!editor) return;
        editor.onDidBlurEditorWidget(async function () { if (_editing && _editDirty) await _saveEditContent(); });
    }
    function _setupEditCtrlS(editor, monaco) {
        if (!editor || !monaco) return;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async function () { if (_editing) await _saveEditContent(); });
    }
    if ($btnEdit) $btnEdit.addEventListener('click', _toggleEdit);
    var $btnSnap = document.getElementById('btn-snap');
    if ($btnSnap) $btnSnap.addEventListener('click', _snapshotEditContent);

    async function _refreshVersions() {
        try {
            var newVer = await bridge.timeline.versions({ projectRoot: PROJECT_ROOT, filePath: FILE_PATH });
            _versions = newVer || [];
            _lastContent = await bridge.timeline.readCurrent(FILE_PATH);
            var st = await bridge.timeline.stat(FILE_PATH); if (st) _lastMtimeMs = st.mtimeMs;
            var curLeft = $selLeft.value; populateDropdowns();
            var found = false;
            for (var oi = 0; oi < _options.length; oi++) {
                if (_options[oi].value === curLeft || _options[oi]._blobHash === curLeft) {
                    $selLeft.value = _options[oi].value; _refreshDropdownBtn($ddLeftBtn, $selLeft.value, _options); found = true; break;
                }
            }
            if (!found && _options.length > 0) { $selLeft.value = _options[_options.length - 1].value; _refreshDropdownBtn($ddLeftBtn, $selLeft.value, _options); }
            updateMarkers(); _refreshDropdownBtn($ddRightBtn, $selRight.value, _options);
        } catch (_) { }
    }

    var _blockArrowEls = [];
    var _blockArrowChanges = [];
    function _clearBlockArrows() {
        for (var i = 0; i < _blockArrowEls.length; i++) {
            try { _blockArrowEls[i].dom.remove(); } catch (_) { }
        }
        _blockArrowEls = [];
        _blockArrowChanges = [];
    }
    function _updateBlockArrows() {
        _clearBlockArrows();
        if (!_editing || !_diffEditor) return;
        var changes = _diffEditor.getLineChanges();
        if (!changes || !changes.length) return;
        var origEditor = _diffEditor.getOriginalEditor();
        if (!origEditor) return;
        for (var ci = 0; ci < changes.length; ci++) {
            var c = changes[ci];
            var line = c.originalStartLineNumber > 0 ? c.originalStartLineNumber : c.originalEndLineNumber;
            if (!line || line <= 0) continue;
            (function (capLine, capChange) {
                var div = document.createElement('div');
                div.className = 'block-arrow';
                div.innerHTML = '→';
                div.title = '将左侧差异移到右侧';
                div.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); _copyBlockToRight(capChange); });
                div.addEventListener('click', function (ev) { ev.stopPropagation(); });
                // 插入到 diff-container
                if (!$diffContainer.contains(div)) $diffContainer.appendChild(div);
                // 用原始 editor 的行号算 Y，放在中间分割线位置
                var top = origEditor.getTopForLineNumber(capLine) - origEditor.getScrollTop();
                div.style.top = top + 'px';
                var li = origEditor.getLayoutInfo();
                div.style.left = (li.contentLeft + li.contentWidth - 28) + 'px';
                _blockArrowEls.push({ dom: div, line: capLine });
            })(line, c);
        }
    }
    // 滚动时同步箭头位置
    if (!window._arrowScrollBound) {
        window._arrowScrollBound = true;
        setInterval(function () {
            if (!_editing || !_diffEditor || !_blockArrowEls.length) return;
            var origEditor = _diffEditor.getOriginalEditor();
            if (!origEditor) return;
            var st = origEditor.getScrollTop();
            var li = origEditor.getLayoutInfo();
            var lx = li.contentLeft + li.contentWidth - 28;
            for (var ai = 0; ai < _blockArrowEls.length; ai++) {
                var a = _blockArrowEls[ai];
                if (a.dom && a.line > 0) {
                    var top = origEditor.getTopForLineNumber(a.line) - st;
                    a.dom.style.top = top + 'px';
                    a.dom.style.left = lx + 'px';
                }
            }
        }, 100);
    }
    function _copyBlockToRight(c) {
        if (!_diffEditor) return;
        var mc = window.monaco;
        if (!mc || c.originalEndLineNumber === 0) return;
        var mm = _diffEditor.getModifiedEditor().getModel();
        var edit;
        if (c.modifiedEndLineNumber === 0) {
            edit = { range: new mc.Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber + 1, 1), text: '' };
        } else {
            var lt = _diffEditor.getOriginalEditor().getModel().getValueInRange({ startLineNumber: c.originalStartLineNumber, startColumn: 1, endLineNumber: c.originalEndLineNumber, endColumn: Number.MAX_SAFE_INTEGER });
            edit = { range: new mc.Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber, Number.MAX_SAFE_INTEGER), text: lt };
        }
        if (edit) { mm.pushEditOperations([], [edit], function () { return null; }); _lastContent = mm.getValue(); _markEditDirty(); }
    }

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

    // ═══ 全局持久化偏好（跨窗口记忆，走 qgs 唯一真理入口） ═══
    function _saveDiffOnlyPref(value) {
        try {
            if (typeof qgs !== 'undefined' && PROJECT_ROOT) {
                qgs.project(PROJECT_ROOT + '/qqq/alphal/only.sq3', 'qqq.timeline').setNow('diffOnly', value);
            }
        } catch (_) { }
    }

    // ★ Monaco 主题兜底（qqqide-theme.js 未加载时启用，色盘与 qqqide-theme.js 完全一致）
    function _defineMonacoThemesFallback(monaco) {
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
                    'editor.findMatchBackground': '#ffd30166',
                    'editor.findMatchHighlightBackground': '#ffd30133',
                    'editor.findRangeHighlightBackground': '#ffd30115',
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
            console.warn('[diff] defineTheme fallback failed:', e && e.message);
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

    // ═══ 监听编辑器字体大小（来自缩放按钮 / Ctrl+= / Ctrl+-） ═══
    if (bridge && bridge.zoom) {
        bridge.zoom.get().then(function (s) {
            if (typeof s === 'number') {
                _editorFontSize = Math.round(s);
                if (_diffEditor) {
                    try { _diffEditor.updateOptions({ fontSize: _editorFontSize }); } catch (_) { }
                }
            }
        });
        if (bridge.zoom.onChanged) {
            bridge.zoom.onChanged(function (s) {
                if (typeof s === 'number') {
                    _editorFontSize = Math.round(s);
                    if (_diffEditor) {
                        try { _diffEditor.updateOptions({ fontSize: _editorFontSize }); } catch (_) { }
                    }
                }
            });
        }
    }

    // ═══ 入口 ═══
    if (!FILE_PATH || !PROJECT_ROOT) {
        $emptyState.textContent = _i('timeline.missingParams', '缺少参数');
    } else {
        _titleSetText(FILE_PATH);
        $titleInput.title = FILE_PATH;
        loadVersions(FILE_PATH);
    }
    // ★ Ctrl+Z 逐字回退
    if ($titleInput && typeof window._qqqUndoAttach === "function") {
        window._qqqUndoAttach($titleInput);
    }
