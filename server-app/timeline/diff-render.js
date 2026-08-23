// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// timeline/diff-render.js — Monaco 加载 + Diff 渲染 + 编辑器精简
// ============================================================================
'use strict';

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
                    // ★ 优先走 qqqideTheme 统一入口，未加载时内联兜底（同色盘，二选一，不重复注册）
                    if (typeof qqqideTheme !== 'undefined') {
                        qqqideTheme.defineMonacoThemes(window.monaco);
                    } else {
                        _defineMonacoThemesFallback(window.monaco);
                    }
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
        if (!leftVal || !rightVal) {
            console.log('[diff] renderDiff skipped: left=' + leftVal + ' right=' + rightVal);
            return;
        }
        console.log('[diff] renderDiff left=' + leftVal.substring(0, 16) + '... right=' + rightVal.substring(0, 16) + '... leftVal==rightVal=' + (leftVal === rightVal));

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
        // 诊断日志
        if (leftContent.length === 0 && rightContent.length > 0) {
            console.warn('[diff] LEFT CONTENT EMPTY! leftVal=' + leftVal.substring(0, 16));
        } else if (rightContent.length === 0 && leftContent.length > 0) {
            console.warn('[diff] RIGHT CONTENT EMPTY! rightVal=' + rightVal.substring(0, 16));
        }
        console.log('[diff] renderDiff token=' + token + ' leftLen=' + leftContent.length + ' rightLen=' + rightContent.length + ' same=' + (leftContent === rightContent));
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

        var _editorReadOnly = _editing ? false : true;
        _diffEditor = monaco.editor.createDiffEditor($diffContainer, {
            useShadowDOM: false,
            renderSideBySide: true,
            readOnly: _editorReadOnly,
            originalEditable: false,
            automaticLayout: true,
            minimap: { enabled: true, showSlider: 'mouseover' },
            scrollbar: { vertical: 'hidden', horizontal: 'hidden' },
            wordWrap: 'on',
            wordWrapColumn: 0,
            renderIndicators: false,
            renderOverviewRuler: true,
            fontSize: _editorFontSize,
            lineNumbers: 'on',
            lineNumbersMinChars: 2,
            lineDecorationsWidth: 10,
            scrollBeyondLastLine: 20,
            theme: THEME,
        });

        var originalModel = monaco.editor.createModel(leftContent, lang);
        var modifiedModel = monaco.editor.createModel(rightContent, lang);
        _oldOriginalModel = originalModel;
        _oldModifiedModel = modifiedModel;

        if (_isLastOnRight || _editing) {
            modifiedModel.onDidChangeContent(function () {
                _lastContent = modifiedModel.getValue();
                updateDiffStats();
                if (_editing) _markEditDirty();
            });
        }

        _diffEditor.setModel({ original: originalModel, modified: modifiedModel });
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
        if (_editing) {
            try { _diffEditor.getOriginalEditor().updateOptions({ readOnly: true }); } catch (_) { }
        }
        updateDiffStats();
        _syncDiffOnlyBtn();
    }

    function _markEditDirty() { _editDirty = true; _checkEditReverted(); _updateEditStatus(); }
    function _checkEditReverted() {
        if (!_editing || !_diffEditor) return;
        try {
            var cur = _diffEditor.getModifiedEditor().getModel().getValue();
            if (cur === _editOriginalContent) { _editDirty = false; }
        } catch (_) { }
    }
    function _updateEditStatus() {
        if (!$esStatus) return;
        $esStatus.textContent = _editDirty ? _i('timeline.unsaved', '未保存') : _i('timeline.saved', '已保存');
        if (_editDirty) { $esStatus.classList.add('dirty'); }
        else { $esStatus.classList.remove('dirty'); }
    }
    function _setEditSnapText(snapLabel) {
        if (!$esSnap) return;
        $esSnap.textContent = snapLabel || '';
    }
    function updateDiffStats() {
        // 仅内部使用，不再显示状态栏
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
                scrollBeyondLastLine: 20,
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
                emptySelectionClipboard: true,
                contextmenu: false,
                // 其他
                rulers: [],
                roundedSelection: false,
                lineNumbersMinChars: 2,
                lineDecorationsWidth: 10,
                padding: { top: 0, bottom: 0 },
                stickyScroll: { enabled: false },
                find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never', seedSearchStringFromSelection: 'selection' },
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
        if (!_diffOnly) {
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

