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
                    $emptyState.textContent = _i('timeline.monacoFailed', 'Monaco 加载失败');
                    resolve();
                });
            };
            s.onerror = function () {
                $emptyState.textContent = _i('timeline.monacoFailed', 'Monaco 加载失败');
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
        _tlCornerAttach(_diffEditor);   // 右上角悬浮按钮行（左右两组；diff 重建后重新挂接）
        var _firstDiffReady = false;
        _diffEditor.onDidUpdateDiff(function () {
            updateDiffStats();
            _applyHiddenAreas();
            _tlCornerLayout();   // 首算完成后复查就位（字体/行高就绪后的最终几何）
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

    // ════════════════════════════════════════════════════════════════════════
    // 编辑器右上角悬浮按钮行（唯一机器）
    //   布局：左右两编辑器各一组，悬浮于各自编辑器右上角（与主编辑器右下角按钮行同款外观，
    //         仅位置改右上）；坐标 = 编辑器 DOM rect 与容器 rect 之差，随布局/窗口缩放实时随动。
    //   让位：按钮行上缘 = 编辑器顶 + 41px —— 查找控件常态占 0..33（实测），41 = 33 + 8 间距，
    //         控件展开时按钮恒在控件下缘之外（一按不被遮）。
    //   按钮：目前仅一个 —— 搜索（点击 = 该编辑器原生 Ctrl+F：同一动作，含选区播种/聚焦查找框）。
    //   显隐：恒可见；仅本侧查找控件矩形真实压到按钮行时才让位（替换展开 / 控件被拖到按钮上），
    //         关闭即回归；以查找状态事件为主、键盘/点击路径补刀——任意路径开合后显隐恒正确。
    //   生命周期：diff 每次重建（版本切换/进出编辑态）后重新挂接；节点幂等复用，零重复。
    // ════════════════════════════════════════════════════════════════════════
    var _TL_CORNER_TOP = 41;                              // 按钮行上缘（相对编辑器顶，px；见上「让位」）
    var _tlCornerEls = null;                              // { layer, left, right }
    var _tlCornerBoundEd = { left: null, right: null };   // 已绑定查找状态事件的编辑器实例

    // 节点构建（幂等：已存在且仍在容器内 → 直接复用）
    function _tlCornerEnsure() {
        if (_tlCornerEls && _tlCornerEls.layer && $diffContainer.contains(_tlCornerEls.layer)) return _tlCornerEls;
        var layer = document.createElement('div');
        layer.className = 'tl-corner-layer';
        function make(side) {
            var strip = document.createElement('div');
            strip.className = 'tl-corner-btns';
            strip.setAttribute('data-side', side);
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tl-float-btn';
            btn.title = _i('timeline.findBtn', '查找 (Ctrl+F)');
            var ico = document.createElement('span');
            ico.className = 'qqi qqi-search';
            btn.appendChild(ico);
            // 按下不夺焦、不冒泡（点击才触发；与主编辑器悬浮按钮同规）
            btn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
            btn.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                _tlCornerOpenFind(side);
            });
            strip.appendChild(btn);
            layer.appendChild(strip);
            return strip;
        }
        var left = make('left'), right = make('right');
        $diffContainer.appendChild(layer);
        _tlCornerEls = { layer: layer, left: left, right: right };
        return _tlCornerEls;
    }

    // 当前 diff 的左右编辑器（点击时实时解析——diff 重建后无需重绑）
    function _tlCornerEd(side) {
        if (!_diffEditor) return null;
        try { return side === 'left' ? _diffEditor.getOriginalEditor() : _diffEditor.getModifiedEditor(); } catch (_) { return null; }
    }

    // 本侧查找控件是否展开（贡献状态为权威；未实例化时回落 DOM 类名）
    function _tlFindRevealed(ed) {
        if (!ed) return false;
        try {
            var fc = ed.getContribution('editor.contrib.findController');
            var st = fc && fc.getState ? fc.getState() : null;
            if (st && typeof st.isRevealed === 'boolean') return st.isRevealed;
        } catch (_) { }
        try {
            var dom = ed.getDomNode();
            var w = dom && dom.querySelector ? dom.querySelector('.find-widget') : null;
            return !!(w && w.classList.contains('visible'));
        } catch (_) { return false; }
    }

    // 查找状态事件绑定（每编辑器实例一次；isRevealed 变化 → 即时显隐同步）
    function _tlCornerBindFind(ed, side) {
        if (!ed || _tlCornerBoundEd[side] === ed) return;
        var st = null;
        try {
            var fc = ed.getContribution('editor.contrib.findController');
            st = fc && fc.getState ? fc.getState() : null;
        } catch (_) { st = null; }
        if (!st || !st.onFindReplaceStateChange) return;   // 贡献未就绪：留待下次布局/交互再绑
        _tlCornerBoundEd[side] = ed;
        try {
            st.onFindReplaceStateChange(function (e) {
                if (e && e.isRevealed) { try { _tlCornerVis(); } catch (_) { } }
            });
        } catch (_) { }
    }

    // 就位：贴到目标编辑器右上角（8px 内缩；同值零写，防拖拽期样式抖动）
    function _tlCornerPlace(strip, ed, crect) {
        var dom = null, r = null;
        try { dom = ed && ed.getDomNode(); } catch (_) { dom = null; }
        try { r = dom ? dom.getBoundingClientRect() : null; } catch (_) { r = null; }
        if (!r || !r.width || !r.height) { strip.style.display = 'none'; return; }
        strip.style.display = '';
        var top = Math.round(r.top - crect.top + _TL_CORNER_TOP);
        var right = Math.round(crect.right - r.right + 8);
        if (strip.__tlTop !== top) { strip.__tlTop = top; strip.style.top = top + 'px'; }
        if (strip.__tlRight !== right) { strip.__tlRight = right; strip.style.right = right + 'px'; }
    }

    function _tlCornerVisSide(side) {
        if (!_tlCornerEls) return;
        var strip = side === 'left' ? _tlCornerEls.left : _tlCornerEls.right;
        var ed = _tlCornerEd(side);
        if (ed) _tlCornerBindFind(ed, side);
        var next = (ed && _tlFindRevealed(ed) && _tlWidgetCovers(strip, ed)) ? 'hidden' : '';
        if (strip.__tlVis !== next) { strip.__tlVis = next; strip.style.visibility = next; }
    }

    // 查找控件是否真实压住按钮行（矩形相交判定——控件常态在按钮行上方，零相交恒可见；
    // 仅「替换展开 / 控件被拖到按钮行上」等真实相交场景让位）
    function _tlWidgetCovers(strip, ed) {
        var dom = null, w = null, sr = null, wr = null;
        try { dom = ed.getDomNode(); } catch (_) { dom = null; }
        try { w = (dom && dom.querySelector) ? dom.querySelector('.find-widget') : null; } catch (_) { w = null; }
        if (!w) return false;
        try { sr = strip.getBoundingClientRect(); wr = w.getBoundingClientRect(); } catch (_) { return false; }
        if (!sr || !wr || !wr.width || !wr.height) return false;
        return (sr.left < wr.right && sr.right > wr.left && sr.top < wr.bottom && sr.bottom > wr.top);
    }

    function _tlCornerVis() {
        if (!_tlCornerEls) return;
        _tlCornerVisSide('left');
        _tlCornerVisSide('right');
    }

    // 布局总入口（无 diff 编辑器 / 容器零尺寸 → 整层隐藏）
    function _tlCornerLayout() {
        var els = _tlCornerEnsure();
        if (!_diffEditor) { els.layer.style.display = 'none'; return; }
        var crect = null;
        try { crect = $diffContainer.getBoundingClientRect(); } catch (_) { crect = null; }
        if (!crect || !crect.width || !crect.height) { els.layer.style.display = 'none'; return; }
        els.layer.style.display = '';
        _tlCornerPlace(els.left, _tlCornerEd('left'), crect);
        _tlCornerPlace(els.right, _tlCornerEd('right'), crect);
        _tlCornerVis();
    }

    // 点击 = 该编辑器原生 Ctrl+F（同一动作；动作缺失时逐项复刻其参数直连查找贡献）
    function _tlCornerOpenFind(side) {
        var ed = _tlCornerEd(side);
        if (!ed) return;
        try { ed.focus(); } catch (_) { }
        var ran = false;
        try { var act = ed.getAction('actions.find'); if (act && act.run) { act.run(); ran = true; } } catch (_) { ran = false; }
        if (!ran) {
            try {
                var fc = ed.getContribution('editor.contrib.findController');
                if (fc && fc.start) {
                    var seedSel = 'single', seedNE = false, gcb = false, loop = true;
                    try {
                        var f = (window.monaco && window.monaco.editor) ? ed.getOption(window.monaco.editor.EditorOption.find) : null;
                        if (f) {
                            if (f.seedSearchStringFromSelection === 'never') seedSel = 'none';
                            seedNE = (f.seedSearchStringFromSelection === 'selection');
                            gcb = !!f.globalFindClipboard;
                            if (typeof f.loop === 'boolean') loop = f.loop;
                        }
                    } catch (_) { }
                    fc.start({
                        forceRevealReplace: false,
                        seedSearchStringFromSelection: seedSel,
                        seedSearchStringFromNonEmptySelection: seedNE,
                        seedSearchStringFromGlobalClipboard: gcb,
                        shouldFocus: 1,
                        shouldAnimate: true,
                        updateSearchScope: false,
                        loop: loop
                    });
                }
            } catch (_) { }
        }
        _tlCornerPoke(60);
        _tlCornerPoke(320);
    }

    // 补刀同步（延迟复核——动作异步落地/事件缺失时的自愈）
    function _tlCornerPoke(delay) {
        setTimeout(function () { try { _tlCornerVis(); } catch (_) { } }, delay || 120);
    }

    // diff 重建后重新挂接：布局事件 + 首次就位（幂等）
    function _tlCornerAttach(diff) {
        if (!diff) return;
        _tlCornerEnsure();
        try {
            var eds = [diff.getOriginalEditor(), diff.getModifiedEditor()];
            for (var i = 0; i < eds.length; i++) {
                var ed = eds[i];
                if (ed && ed.onDidLayoutChange) ed.onDidLayoutChange(function () { try { _tlCornerLayout(); } catch (_) { } });
            }
        } catch (_) { }
        _tlCornerLayout();
        setTimeout(function () { try { _tlCornerLayout(); } catch (_) { } }, 120);
    }

    // 兜底同步触发（查找控件还可经键盘/点击路径开合——事件绑定之外的补刀）
    window.addEventListener('resize', function () { try { _tlCornerLayout(); } catch (_) { } });
    document.addEventListener('keydown', function (e) {
        if (!e) return;
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) { _tlCornerPoke(90); _tlCornerPoke(360); }
        else if (e.key === 'Escape') { _tlCornerPoke(90); }
    }, true);
    document.addEventListener('click', function () { _tlCornerPoke(140); }, true);
    document.addEventListener('mouseup', function () { _tlCornerPoke(120); }, true);   // 控件可拖拽：拖完即复算显隐


