// ============================================================================
// timeline/diff-versions.js — 版本加载 + 下拉列表 + 标记
// ============================================================================
'use strict';

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
            // 加载项目级持久化偏好：仅差异模式（走 qgs 唯一真理入口，自动注册+缓存）
            try {
                if (typeof qgs !== 'undefined' && PROJECT_ROOT) {
                    var pref = await qgs.project(PROJECT_ROOT + '/qqq/alphal/only.sq3', 'qqq.timeline').get('diffOnly');
                    if (typeof pref === 'boolean') _diffOnly = pref;
                }
            } catch (_) { }
            populateDropdowns();
            // ★ 如果 Monaco 已加载，显式渲染 diff（确保 populateDropdowns 设值后立即渲染）
            if (_monacoLoaded && window.monaco) renderDiff();
            // ★ Monaco 加载超时保护（15s），防止永久白屏
            var monacoOk = await Promise.race([
                loadMonaco().then(function () { return true; }),
                new Promise(function (r) { setTimeout(function () { r(false); }, 15000); })
            ]);
            if (!monacoOk) {
                $emptyState.textContent = _i('timeline.monacoTimeout', 'Monaco 加载超时，请检查网络或重启窗口');
                return;
            }
            $emptyState.style.display = 'none';
            $diffContainer.style.display = '';
            // ★ 安全兜底：再次确保 diff 渲染（幂等，_renderToken 防并发）
            renderDiff();
        } finally {
            _loading = false;
        }
    }

    var _options = []; // 下拉选项缓存，供 updateOneMarker 查合并条目

    // ═══ 解析 floor_id → 可读溯源串 "q38 f14 h3 r2" ═══
    function _parseFloorId(floorId) {
        if (!floorId) return '';
        var parts = floorId.split('/');
        var out = [];
        for (var pi = 0; pi < parts.length; pi++) {
            out.push(parts[pi]);
        }
        return out.join(' ');
    }
    // ★ 精简溯源：r1 在所有快照中都是 1，去掉省空间
    function _compactTrace(trace) {
        if (!trace) return '';
        return trace.replace(/ r1\b/g, '');
    }

    // ═══ 映射 source → 可读标签 ═══
    function _sourceLabel(source, floorId) {
        if (source === 'q') {
            var trace = _parseFloorId(floorId);
            // ★ trace 为空时不降级为 'q'（竞态或记录失败导致）
            return _compactTrace(trace) || '';
        }
        if (source === 'editx') return 'editx';
        if (source === 'diff-edit') return 'diff edit';
        if (source === 'run-command') return 'cmd';
        return 'other';
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
                file_seq: v.file_seq,
            });
        }
        var isFirst = options.length === 0;
        // ── 合并「当前文件」到已有版本（按秒级时间戳归并，避免重复行）──
        var lastMerged = false;
        if (_lastContent !== null) {
            var lastTs = _lastMtimeMs;
            var lastLabel = formatTs(lastTs);
            // ★ 必须从后往前遍历（最新版本优先），否则同秒内 before 版本会错误地吃掉 'last' 标记
            for (var li = options.length - 1; li >= 0; li--) {
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
            // ★ 每行编号优先用 DB file_seq（AI 可直接用编号查快照），降级为 UI 序号
            var seqNo = (o.file_seq != null) ? o.file_seq : (mergedOptions.length + 1);
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
            displayHtml = displayHtml.replace(/\s\-(\d+)/g, '<span class="v-stat-red">-$1</span>');
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
                displayHtml = displayHtml.replace(/\s\-(\d+)/g, '<span class="v-stat-red">-$1</span>');
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
        var barH = 40 + 44; // title-row + version-bar
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

    // ── 自定义下拉交互（hover 自动展开，点击锁定）──
    function _initDropdown($dd, $btn, $list, $hidden, side) {
        $dd._clickOpened = false;  // 标记：是否由用户点击打开（锁定态，不因 mouseleave 关闭）

        // hover 自动展开
        $dd.addEventListener('mouseenter', function () {
            if (!$dd.classList.contains('open')) {
                $dd.classList.add('open');
                _calcDropdownMaxHeight();
                _highlightAndScroll($list, $hidden.value);
            }
        });
        // 移出自动收回（仅非点击锁定态）
        $dd.addEventListener('mouseleave', function () {
            if (!$dd._clickOpened) {
                $dd.classList.remove('open');
            }
        });
        // 点击按钮：切换展开，并锁定（不关另一个列表）
        $btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var wasOpen = $dd.classList.contains('open');
            if (wasOpen) {
                $dd.classList.remove('open');
                $dd._clickOpened = false;
            } else {
                $dd.classList.add('open');
                $dd._clickOpened = true;  // ★ 点击锁定
                _calcDropdownMaxHeight();
                _highlightAndScroll($list, $hidden.value);
            }
        });
        // 点击列表项：选中并关闭，解除锁定
        $list.addEventListener('click', function (e) {
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
            if (val === $hidden.value) { $dd.classList.remove('open'); $dd._clickOpened = false; return; }
            $hidden.value = val;
            _refreshDropdownBtn($btn, val, _options);
            _highlightAndScroll($list, val);
            $dd.classList.remove('open');
            $dd._clickOpened = false;  // ★ 选择后解除锁定
            updateMarkers();
            renderDiff();
        });
        // 点击外部关闭并解除锁定
        document.addEventListener('click', function (e) {
            if (!$dd.contains(e.target)) {
                $dd.classList.remove('open');
                $dd._clickOpened = false;
            }
        });
    }
    _initDropdown($ddLeft, $ddLeftBtn, $ddLeftList, $selLeft, 'left');
    _initDropdown($ddRight, $ddRightBtn, $ddRightList, $selRight, 'right');

    function updateMarkers() {
        updateOneMarker($selLeft, $markerLeft);
        updateOneMarker($selRight, $markerRight);
        _isLastOnRight = ($selRight.value === 'last');
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



