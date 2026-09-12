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
    var _fileExists = true;   // 当前文件在磁盘上是否存在（已删除 → 记忆模式：禁编辑 + op 恢复）
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
    var $goneBadge = document.getElementById('file-gone-badge');
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
        if (_vaultFiles) _invalidateVault(); // 历史晚到 → 记忆库合并集失效重拉（保鲜）
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

    // ⭐ Everything 式匹配（2026-09-11）：全路径子序列 + 名称优先评分 + 命中下标（供高亮）
    function _fuzzyScore(query, path) {
        var ql = query.toLowerCase();
        var idx = [];
        var qi = 0;
        for (var pi = 0; pi < path.length && qi < ql.length; pi++) {
            if (path[pi].toLowerCase() === ql[qi]) { idx.push(pi); qi++; }
        }
        if (qi !== ql.length) return null;
        var nameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
        var nameLower = path.slice(nameStart).toLowerCase();
        var dirLower = path.slice(0, nameStart).toLowerCase();
        var score;
        if (nameLower.indexOf(ql) >= 0) score = 5000;         // 文件名整段命中（最强）
        else if (idx[0] >= nameStart) score = 3500;           // 子序列全落在文件名内
        else if (dirLower.indexOf(ql) >= 0) score = 2500;     // 目录段整段命中
        else score = 1200;                                    // 跨段子序列
        score -= Math.min(idx[0] || 0, 200);                  // 命中越靠前越优先
        return { idx: idx, score: score };
    }

    // 命中高亮：段内落在 hits 下标上的字符包亮色（hits = 全路径字符下标）
    function _hlSeg(text, segStart, hits) {
        if (!hits || !hits.length) return _escHtml(text);
        var out = '';
        var pos = 0;
        for (var i = 0; i < hits.length; i++) {
            var loc = hits[i] - segStart;
            if (loc < 0) continue;
            if (loc >= text.length) break;
            if (loc > pos) out += _escHtml(text.slice(pos, loc));
            out += '<span class="fi-hit">' + _escHtml(text.charAt(loc)) + '</span>';
            pos = loc + 1;
        }
        if (pos < text.length) out += _escHtml(text.slice(pos));
        return out;
    }

    // ═══ ⭐ 记忆库根系（2026-09-11，全库文件列表 = 找回已删除文件的唯一入口）═══════
    // 数据 = timeline 全库 tracked files ∪ 本窗口历史；空查询按最近活动排序；
    // 输入 = 全库子序列模糊匹配（记得文件名片段即可命中）；已删除文件 🗑️ 照常显示
    //（磁盘上没有的，记忆里有——点开进入纯历史模式，可翻全部快照并经 op 恢复）。
    // 渲染 = 懒渲染（首批 _VAULT_BATCH 行 + 底部闸门，滚到底/点闸门补批），与版本下拉同机制。
    var _vaultFiles = null;      // 合并排序后的全量行 [{path, exists, vcount, ts}]（ts 降序）
    var _vaultLoading = false;
    var _vaultLoadedAt = 0;
    var _vaultRows = [];         // 当前查询过滤后的行集
    var _vaultRendered = 0;      // 已渲染行数
    var _vaultHitsMap = {};      // 路径 → 命中字符下标（高亮；空查询 = {}）
    var _VAULT_BATCH = 300;
    var _VAULT_TTL = 60000;

    // 相对时间（行尾短格式；超 30 天回落日期）
    function _relTime(ts) {
        if (!ts) return '';
        var diff = Date.now() - ts;
        if (diff < 0) diff = 0;
        var m = Math.floor(diff / 60000);
        if (m < 1) return _i('timeline.relJustNow', '刚刚');
        if (m < 60) return _i('timeline.relMin', '{n} 分钟前').replace('{n}', m);
        var h = Math.floor(m / 60);
        if (h < 24) return _i('timeline.relHour', '{n} 小时前').replace('{n}', h);
        var d = Math.floor(h / 24);
        if (d < 30) return _i('timeline.relDay', '{n} 天前').replace('{n}', d);
        var dt = new Date(ts);
        var p = function (n) { return String(n).padStart(2, '0'); };
        return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
    }

    // 拉取 + 合并记忆库（60s TTL；完成后下拉可见则自动重建）
    function _ensureVault() {
        if (_vaultLoading) return;
        if (_vaultFiles && (Date.now() - _vaultLoadedAt) < _VAULT_TTL) return;
        _vaultLoading = true;
        try {
            bridge.timeline.listTrackedFiles({ projectRoot: PROJECT_ROOT }).then(function (arr) {
                var map = {};
                var rows = [];
                if (Array.isArray(arr)) {
                    for (var i = 0; i < arr.length; i++) {
                        var f = arr[i];
                        if (!f || !f.file_path) continue;
                        var row = { path: f.file_path, exists: !!f.exists, vcount: f.version_count || 0, ts: f.latest_ts || 0 };
                        map[f.file_path] = row;
                        rows.push(row);
                    }
                }
                // 合并本窗口历史（timeline 从未记录过的路径照常可开；同路径活动时间取新）
                for (var h = 0; h < _fileHistory.length; h++) {
                    var hp = _fileHistory[h] && _fileHistory[h].path;
                    if (!hp) continue;
                    var hk = hp.replace(/\\/g, '/');
                    var hts = _fileHistory[h].ts || 0;
                    if (map[hk]) { if (hts > map[hk].ts) map[hk].ts = hts; }
                    else { var r2 = { path: hp, exists: null, vcount: 0, ts: hts }; map[hk] = r2; rows.push(r2); }
                }
                rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
                _vaultFiles = rows;
                _vaultLoadedAt = Date.now();
                _vaultLoading = false;
                if (_fuzzyVisible) _buildFuzzyList(_titleGetText());
                if (_vpPanelOpen) { _vpRoot = _vpBuildTree(_vaultFiles); _vpInitDir(); _vpRender(true); }
            }).catch(function () { _vaultLoading = false; });
        } catch (_) { _vaultLoading = false; }
    }
    // 失效缓存（恢复文件后 exists 翻转，下次打开重拉）
    function _invalidateVault() { _vaultFiles = null; _vaultLoadedAt = 0; }

    // 单行 HTML：图标（📄/🗑️）+ 文件名 + 目录 + 快照数/相对时间（hits = 命中高亮下标）
    function _vaultRowHtml(row, hits) {
        var p = row.path || '';
        var name = p.split(/[\\/]/).pop() || p;
        var dir = p.slice(0, p.length - name.length);
        var gone = (row.exists === false);
        var meta = '';
        if (row.vcount > 0) meta = row.vcount + ' 快照';
        var rel = _relTime(row.ts);
        if (rel) meta += (meta ? ' · ' : '') + rel;
        return '<div class="fuzzy-item' + (gone ? ' fi-gone' : '') + '" data-path="' + _escAttr(p) + '">' +
            '<span class="fi-icon">' + (gone ? '🗑️' : '📄') + '</span>' +
            '<span class="fi-name">' + _hlSeg(name, p.length - name.length, hits) + '</span>' +
            '<span class="fi-dir">' + _hlSeg(dir, 0, hits) + '</span>' +
            '<span class="fi-meta">' + _escHtml(meta) + '</span></div>';
    }

    // 构建下拉（懒渲染首批 + 闸门 + 底部提示行）
    function _buildFuzzyList(query) {
        if (_vpPanelOpen) _vpClose();   // 搜索列表与全窗记忆库互斥
        _fuzzyIdx = -1;
        $fuzzyList.innerHTML = '';
        if (_vaultFiles === null) {
            _vaultRows = [];
            _vaultRendered = 0;
            _fuzzyVisible = true;
            $fuzzyDropdown.style.display = '';
            var ld = document.createElement('div');
            ld.className = 'fuzzy-hint';
            ld.textContent = _i('timeline.vaultLoading', '记忆库加载中…');
            $fuzzyList.appendChild(ld);
            _ensureVault();
            return;
        }
        var q = (query || '').trim();
        var all = _vaultFiles;
        var out = [];
        _vaultHitsMap = {};
        if (!q) { out = all.slice(); }
        else {
            // Everything 式：全路径子序列匹配 + 名称优先评分排序 + 命中字符高亮
            var scored = [];
            for (var i = 0; i < all.length; i++) {
                var m = _fuzzyScore(q, all[i].path);
                if (m) scored.push({ row: all[i], idx: m.idx, score: m.score });
            }
            scored.sort(function (a, b) { return (b.score - a.score) || ((b.row.ts || 0) - (a.row.ts || 0)); });
            for (var s = 0; s < scored.length; s++) {
                out.push(scored[s].row);
                _vaultHitsMap[scored[s].row.path] = scored[s].idx;
            }
        }
        _vaultRows = out;
        _vaultRendered = 0;
        if (!out.length) {
            var em = document.createElement('div');
            em.className = 'fuzzy-hint';
            em.textContent = all.length ? _i('timeline.vaultNoMatch', '无匹配 · 试试更短的关键词') : _i('timeline.vaultEmpty', '记忆库暂无记录');
            $fuzzyList.appendChild(em);
            _fuzzyVisible = true;
            $fuzzyDropdown.style.display = '';
            return;
        }
        _vaultRendered = Math.min(out.length, _VAULT_BATCH);
        var html = '';
        for (var j = 0; j < _vaultRendered; j++) html += _vaultRowHtml(out[j], _vaultHitsMap[out[j].path]);
        $fuzzyList.innerHTML = html;
        _syncVaultGate();
        var hint = document.createElement('div');
        hint.className = 'fuzzy-hint';
        hint.textContent = q
            ? _i('timeline.vaultMatch', '匹配 {m} / 共 {n} 个文件').replace('{m}', out.length).replace('{n}', _vaultFiles.length)
            : _i('timeline.vaultHint', '记忆库共 {n} 个文件 · 🗑️=已删除（点开可找回）').replace('{n}', _vaultFiles.length);
        $fuzzyList.appendChild(hint);
        _fuzzyVisible = true;
        $fuzzyDropdown.style.display = '';
    }

    // 闸门行同步（未渲染完存在；到底自动消失）
    function _syncVaultGate() {
        var remaining = _vaultRows.length - _vaultRendered;
        var gate = $fuzzyList.querySelector('.fuzzy-gate');
        if (remaining > 0) {
            var txt = _i('timeline.vaultMore', '⬇ 加载更多（还剩 {n} 条）').replace('{n}', remaining);
            if (gate) { gate.textContent = txt; }
            else {
                gate = document.createElement('div');
                gate.className = 'fuzzy-gate';
                gate.textContent = txt;
                var hint = $fuzzyList.querySelector('.fuzzy-hint');
                if (hint && hint.parentNode) hint.parentNode.insertBefore(gate, hint);
                else $fuzzyList.appendChild(gate);
            }
        } else if (gate && gate.parentNode) { gate.parentNode.removeChild(gate); }
    }

    // 懒渲染补批（闸门点击 / 滚到底自动）
    function _vaultRenderMore() {
        var total = _vaultRows.length;
        if (_vaultRendered >= total) return;
        var to = Math.min(total, _vaultRendered + _VAULT_BATCH);
        var html = '';
        for (var i = _vaultRendered; i < to; i++) html += _vaultRowHtml(_vaultRows[i], _vaultHitsMap[_vaultRows[i].path]);
        var gate = $fuzzyList.querySelector('.fuzzy-gate');
        if (gate) gate.insertAdjacentHTML('beforebegin', html);
        else $fuzzyList.insertAdjacentHTML('beforeend', html);
        _vaultRendered = to;
        _syncVaultGate();
    }

    // 事件委托：行选择 / 闸门补批 / 滚到底补批（不随重建丢失）
    if ($fuzzyList) {
        $fuzzyList.addEventListener('mousedown', function (e) {
            var gate = e.target.closest ? e.target.closest('.fuzzy-gate') : null;
            if (gate) { e.preventDefault(); _vaultRenderMore(); return; }
            var item = e.target.closest ? e.target.closest('.fuzzy-item') : null;
            if (item && item.dataset && item.dataset.path) {
                e.preventDefault(); // 防止 blur 先于 click 关闭下拉
                _selectHistory(item.dataset.path);
            }
        });
        $fuzzyList.addEventListener('scroll', function () {
            if ($fuzzyList.scrollTop + $fuzzyList.clientHeight >= $fuzzyList.scrollHeight - 40) _vaultRenderMore();
        });
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

    // ═══ ⭐ 记忆库全窗浏览器 v2（2026-09-11，▼ = 进入）═══════════
    // 交互模型 = 钻取：一次只面对一层（文件夹在前、文件在后），面包屑永远告诉你在哪——
    // 弃用并列展开的树（每层都要脑内维护展开态+缩进；且整表重建会触发外部点击检测误判
    // → 点文件夹关面板的恶性 bug + Monaco 区吞事件反致真点外面不关，实锤）。
    // 空间 = 全窗接管（检索姿态下左右对比区整体让给检索）；关闭 = ✕ 返回对比 / Esc /
    // 选中文件自动返回——面板内点击任何区域都不会误关。
    var $vaultPanel = document.getElementById('vault-panel');
    var $vaultSearch = document.getElementById('vault-search');
    var $vaultGoneChip = document.getElementById('vault-gone-chip');
    var $vaultOnlyGone = document.getElementById('vault-only-gone');
    var $vaultBack = document.getElementById('vault-back');
    var $vaultUp = document.getElementById('vault-up');
    var $vaultCrumb = document.getElementById('vault-crumb');
    var $vaultCount = document.getElementById('vault-count');
    var $vaultBody = document.getElementById('vault-body');
    var $vaultFoot = document.getElementById('vault-foot');
    var _vpPanelOpen = false;
    var _vpRoot = null;         // 全库目录树（数据就绪时构建）
    var _vpDir = '';            // 当前目录（''=根/盘符层；'E:'；'E:/s/wol'…，原始大小写）
    var _vpQuery = '';
    var _vpOnlyGone = false;
    var _vpList = [];           // 当前视图行 [{kind:'dir'|'file',...}]
    var _vpRendered = 0;
    var _vpSel = -1;
    var _VP_PAGE = 300;

    function _vpKey(p) { return String(p || '').replace(/\\/g, '/'); }

    // 全库文件 → 目录树（聚合 fcount 文件数 / scount 快照数 / gcount 已删除数 / gscount 已删快照）
    function _vpBuildTree(files) {
        var root = { name: '', path: '', dirs: {}, files: [], fcount: 0, scount: 0, gcount: 0, gscount: 0 };
        for (var i = 0; i < files.length; i++) {
            var row = files[i];
            var p = _vpKey(row.path);
            var parts = p.split('/');
            var name = parts.pop() || p;
            var gone = (row.exists === false);
            var vc = row.vcount || 0;
            var node = root;
            node.fcount++; node.scount += vc;
            if (gone) { node.gcount++; node.gscount += vc; }
            var acc = '';
            for (var d = 0; d < parts.length; d++) {
                var seg = parts[d];
                if (!seg) continue;
                acc = acc ? acc + '/' + seg : seg;
                var key = seg.toLowerCase();
                var child = node.dirs[key];
                if (!child) {
                    child = { name: seg, path: acc, dirs: {}, files: [], fcount: 0, scount: 0, gcount: 0, gscount: 0 };
                    node.dirs[key] = child;
                }
                node = child;
                node.fcount++; node.scount += vc;
                if (gone) { node.gcount++; node.gscount += vc; }
            }
            node.files.push({ name: name, path: row.path, exists: row.exists, vcount: vc, ts: row.ts || 0 });
        }
        return root;
    }

    // 按目录路径取节点（大小写不敏感逐段下降；找不到返回 null）
    function _vpNode(dir) {
        if (!_vpRoot) return null;
        if (!dir) return _vpRoot;
        var segs = _vpKey(dir).split('/');
        var node = _vpRoot;
        for (var i = 0; i < segs.length; i++) {
            if (!segs[i]) continue;
            node = node.dirs[segs[i].toLowerCase()];
            if (!node) return null;
        }
        return node;
    }

    function _vpParent(dir) {
        if (!dir) return '';
        var i = dir.lastIndexOf('/');
        return i < 0 ? '' : dir.slice(0, i);
    }

    // 初始目录 = 当前文件所在文件夹（不在记忆库中则回落根）
    function _vpInitDir() {
        var d = FILE_PATH ? _vpKey(FILE_PATH) : '';
        if (d) { var i = d.lastIndexOf('/'); d = i < 0 ? '' : d.slice(0, i); }
        if (d && !_vpNode(d)) d = '';
        _vpDir = d;
    }

    // 行 HTML：目录行（▸📁 名称 + 聚合计数）/ 文件行（📄🗑️ 名称 + 目录? + 快照·相对时间）
    function _vpRowHtml(item) {
        if (item.kind === 'dir') {
            var meta = _vpOnlyGone
                ? item.gcount + ' 已删除 · ' + item.gscount + ' 快照'
                : item.fcount + ' 文件' + (item.scount > 0 ? ' · ' + item.scount + ' 快照' : '');
            return '<div class="vault-row v-row-dir" data-dir="' + _escAttr(item.path) + '">' +
                '<span class="v-caret">▸</span><span class="v-ico">📁</span>' +
                '<span class="v-name">' + _escHtml(item.name) + '</span>' +
                '<span class="v-meta">' + _escHtml(meta) + '</span></div>';
        }
        var p = item.path || '';
        var name = item.name || (p.split(/[\\/]/).pop() || p);
        var dir = p.slice(0, p.length - name.length);
        var gone = (item.exists === false);
        var meta2 = item.vcount > 0 ? item.vcount + ' 快照' : '';
        var rel = _relTime(item.ts);
        if (rel) meta2 += (meta2 ? ' · ' : '') + rel;
        var cls = 'vault-row v-row-file' + (item.showDir ? ' v-row-search' : '') + (gone ? ' v-row-gone' : '');
        if (FILE_PATH && _vpKey(p).toLowerCase() === _vpKey(FILE_PATH).toLowerCase()) cls += ' v-row-cur';
        return '<div class="' + cls + '" data-path="' + _escAttr(p) + '">' +
            '<span class="v-ico">' + (gone ? '🗑️' : '📄') + '</span>' +
            '<span class="v-name">' + (item.hits ? _hlSeg(name, p.length - name.length, item.hits) : _escHtml(name)) + '</span>' +
            (item.showDir ? '<span class="v-dir">' + _hlSeg(dir, 0, item.hits) + '</span>' : '') +
            '<span class="v-meta">' + _escHtml(meta2) + '</span></div>';
    }

    // 浏览视图：当前目录的文件夹（名称序）+ 文件（最近活动序）
    function _vpBrowseList() {
        var node = _vpNode(_vpDir) || _vpRoot;
        var out = [];
        if (!node) return out;
        var keys = Object.keys(node.dirs).sort(function (a, b) {
            var an = node.dirs[a].name.toLowerCase(), bn = node.dirs[b].name.toLowerCase();
            return an < bn ? -1 : (an > bn ? 1 : 0);
        });
        for (var i = 0; i < keys.length; i++) {
            var cur = node.dirs[keys[i]];
            if (_vpOnlyGone && cur.gcount <= 0) continue;
            out.push({ kind: 'dir', name: cur.name, path: cur.path, fcount: cur.fcount, scount: cur.scount, gcount: cur.gcount, gscount: cur.gscount });
        }
        var fs = node.files.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
        for (var f = 0; f < fs.length; f++) {
            var fr = fs[f];
            if (_vpOnlyGone && fr.exists !== false) continue;
            out.push({ kind: 'file', name: fr.name, path: fr.path, exists: fr.exists, vcount: fr.vcount, ts: fr.ts, showDir: false, hits: null });
        }
        return out;
    }

    // 搜索视图：全库 Everything 式（子序列 + 名称优先评分，命中高亮，扁平带目录）
    function _vpSearchList() {
        var q = _vpQuery.trim();
        var all = _vaultFiles || [];
        var scored = [];
        for (var i = 0; i < all.length; i++) {
            if (_vpOnlyGone && all[i].exists !== false) continue;
            var m = _fuzzyScore(q, all[i].path);
            if (m) scored.push({ row: all[i], idx: m.idx, score: m.score });
        }
        scored.sort(function (a, b) { return (b.score - a.score) || ((b.row.ts || 0) - (a.row.ts || 0)); });
        var out = [];
        for (var s = 0; s < scored.length; s++) {
            var r = scored[s].row;
            var p = _vpKey(r.path);
            out.push({ kind: 'file', name: p.split('/').pop() || p, path: r.path, exists: r.exists, vcount: r.vcount || 0, ts: r.ts || 0, showDir: true, hits: scored[s].idx });
        }
        return out;
    }

    // 渲染（浏览/搜索共用；懒渲染首批 + 底部闸门）
    function _vpRender(reset) {
        if (!$vaultPanel) return;
        _vpList = _vpQuery.trim() ? _vpSearchList() : _vpBrowseList();
        _vpRendered = Math.min(_vpList.length, _VP_PAGE);
        _vpSel = -1;
        var html = '';
        for (var i = 0; i < _vpRendered; i++) html += _vpRowHtml(_vpList[i]);
        if (!_vpList.length) {
            html = '<div class="vault-empty">' + (_vpQuery.trim()
                ? _i('timeline.vaultNoMatch', '无匹配 · 试试更短的关键词')
                : ((_vaultFiles && _vaultFiles.length) ? _i('timeline.vaultEmptyDir', '此文件夹没有记忆记录') : _i('timeline.vaultEmpty', '记忆库暂无记录'))) + '</div>';
        } else if (_vpRendered < _vpList.length) {
            html += _vpGateHtml(_vpList.length - _vpRendered);
        }
        $vaultBody.innerHTML = html;
        $vaultBody.scrollTop = 0;
        _vpSyncHead();
    }

    function _vpGateHtml(remain) {
        return '<div class="vault-gate">' + _i('timeline.vaultMore', '⬇ 加载更多（还剩 {n} 条）').replace('{n}', remain) + '</div>';
    }

    // 补批（闸门点击 / 滚到底自动）
    function _vpMore() {
        var total = _vpList.length;
        if (_vpRendered >= total) return;
        var to = Math.min(total, _vpRendered + _VP_PAGE);
        var html = '';
        for (var i = _vpRendered; i < to; i++) html += _vpRowHtml(_vpList[i]);
        var gate = $vaultBody.querySelector('.vault-gate');
        if (gate) gate.insertAdjacentHTML('beforebegin', html);
        else $vaultBody.insertAdjacentHTML('beforeend', html);
        _vpRendered = to;
        var remain = total - _vpRendered;
        if (remain > 0) { if (gate) gate.textContent = _i('timeline.vaultMore', '⬇ 加载更多（还剩 {n} 条）').replace('{n}', remain); }
        else if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
    }

    // 头部同步：面包屑 + 上一级可用态 + 计数 + 底部提示
    function _vpSyncHead() {
        var segs = _vpDir ? _vpDir.split('/') : [];
        var html = '<span class="vault-seg' + (segs.length ? '' : ' cur') + '" data-jump="">' + _escHtml(_i('timeline.vaultRoot', '🏠 全部')) + '</span>';
        var acc = '';
        for (var i = 0; i < segs.length; i++) {
            acc = acc ? acc + '/' + segs[i] : segs[i];
            html += '<span class="vault-sep">›</span><span class="vault-seg' + (i === segs.length - 1 ? ' cur' : '') + '" data-jump="' + _escAttr(acc) + '">' + _escHtml(segs[i]) + '</span>';
        }
        $vaultCrumb.innerHTML = html;
        if ($vaultUp) $vaultUp.disabled = !_vpDir;
        if (_vpQuery.trim()) {
            $vaultCount.textContent = _i('timeline.vaultMatch', '匹配 {m} / 共 {n} 个文件').replace('{m}', _vpList.length).replace('{n}', (_vaultFiles || []).length);
        } else {
            var node = _vpNode(_vpDir) || _vpRoot;
            var dN = 0, fN = 0;
            if (node) {
                if (_vpOnlyGone) {
                    var ks = Object.keys(node.dirs);
                    for (var k = 0; k < ks.length; k++) { if (node.dirs[ks[k]].gcount > 0) dN++; }
                    for (var ff = 0; ff < node.files.length; ff++) { if (node.files[ff].exists === false) fN++; }
                } else {
                    dN = Object.keys(node.dirs).length;
                    fN = node.files.length;
                }
            }
            $vaultCount.textContent = _i('timeline.vaultCountBrowse', '{d} 个文件夹 · {f} 个文件').replace('{d}', dN).replace('{f}', fN);
        }
        if ($vaultFoot) {
            $vaultFoot.textContent = _i('timeline.vaultHint', '记忆库共 {n} 个文件 · 🗑️=已删除（点开可找回）').replace('{n}', (_vaultFiles || []).length);
        }
    }

    function _vpShow() {
        if (!$vaultPanel || _vpPanelOpen) return;
        _vpPanelOpen = true;
        _closeFuzzy();
        _hideOpDropdown();
        document.body.classList.add('vault-open');
        if ($btnHistory) $btnHistory.classList.add('on');
        if ($vaultSearch) $vaultSearch.placeholder = _i('timeline.vaultSearchPh', '搜索记忆库：文件名或路径片段…');
        $vaultSearch.value = ''; _vpQuery = '';
        _vpOnlyGone = false; if ($vaultOnlyGone) $vaultOnlyGone.checked = false;
        if ($vaultGoneChip) $vaultGoneChip.classList.remove('on');
        $vaultPanel.style.display = 'flex';
        if (_vaultFiles === null) {
            _vpRoot = null;
            $vaultBody.innerHTML = '<div class="vault-empty">' + _i('timeline.vaultLoading', '记忆库加载中…') + '</div>';
            if ($vaultFoot) $vaultFoot.textContent = '';
            if ($vaultCrumb) $vaultCrumb.innerHTML = '';
            _ensureVault();
        } else {
            _vpRoot = _vpBuildTree(_vaultFiles);
            _vpInitDir();
            _vpRender(true);
        }
        if ($vaultSearch) $vaultSearch.focus();
    }

    function _vpClose() {
        if (!_vpPanelOpen) return;
        _vpPanelOpen = false;
        $vaultPanel.style.display = 'none';
        document.body.classList.remove('vault-open');
        if ($btnHistory) $btnHistory.classList.remove('on');
    }

    function _vpGoDir(dir) {
        _vpDir = dir || '';
        _vpQuery = '';
        if ($vaultSearch) $vaultSearch.value = '';
        _vpRender(true);
        $vaultBody.scrollTop = 0;
    }

    // 选中文件：退出浏览器 → 载入 diff（已删除文件进入纯历史模式）
    function _vpPick(p) {
        if (!p) return;
        _vpClose();
        _selectHistory(p);
    }

    function _vpMoveSel(d) {
        var rows = $vaultBody.querySelectorAll('.vault-row');
        if (!rows.length) return;
        if (_vpSel + d >= rows.length - 1 && _vpRendered < _vpList.length) { _vpMore(); rows = $vaultBody.querySelectorAll('.vault-row'); }
        var idx = _vpSel + d;
        if (idx < 0) idx = 0;
        if (idx > rows.length - 1) idx = rows.length - 1;
        _vpSel = idx;
        for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', i === idx);
        if (rows[idx]) rows[idx].scrollIntoView({ block: 'nearest' });
    }

    function _vpActivateSel() {
        var rows = $vaultBody.querySelectorAll('.vault-row');
        var el = _vpSel >= 0 ? rows[_vpSel] : null;
        if (!el) return;
        if (el.classList.contains('v-row-dir')) _vpGoDir(el.getAttribute('data-dir'));
        else { var fp = el.getAttribute('data-path'); if (fp) _vpPick(fp); }
    }

    if ($vaultPanel) {
        // 行点击（委托）：目录 = 钻入（绝不关闭面板）；文件 = 载入并退出
        $vaultBody.addEventListener('click', function (e) {
            var gate = e.target.closest ? e.target.closest('.vault-gate') : null;
            if (gate) { _vpMore(); return; }
            var row = e.target.closest ? e.target.closest('.vault-row') : null;
            if (!row) return;
            if (row.classList.contains('v-row-dir')) { _vpGoDir(row.getAttribute('data-dir')); return; }
            var fp = row.getAttribute('data-path');
            if (fp) _vpPick(fp);
        });
        // 滚到底自动补批
        $vaultBody.addEventListener('scroll', function () {
            if ($vaultBody.scrollTop + $vaultBody.clientHeight >= $vaultBody.scrollHeight - 60) _vpMore();
        });
        // 搜索框：键入过滤 / 上下选择 / Enter 打开 / Esc 清空或退出
        $vaultSearch.addEventListener('input', function () {
            _vpQuery = $vaultSearch.value;
            _vpRender(true);
        });
        $vaultSearch.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); _vpMoveSel(e.key === 'ArrowDown' ? 1 : -1); return; }
            if (e.key === 'Enter') { e.preventDefault(); _vpActivateSel(); return; }
            if (e.key === 'Escape') {
                e.preventDefault();
                if ($vaultSearch.value) { $vaultSearch.value = ''; _vpQuery = ''; _vpRender(true); }
                else _vpClose();
                return;
            }
        });
        // 「只看已删除」筛选
        $vaultOnlyGone.addEventListener('change', function () {
            _vpOnlyGone = !!$vaultOnlyGone.checked;
            if ($vaultGoneChip) $vaultGoneChip.classList.toggle('on', _vpOnlyGone);
            _vpRender(true);
        });
        if ($vaultBack) $vaultBack.addEventListener('click', function () { _vpClose(); });
        if ($vaultUp) $vaultUp.addEventListener('click', function () { if (_vpDir) _vpGoDir(_vpParent(_vpDir)); });
        $vaultCrumb.addEventListener('click', function (e) {
            var s = e.target.closest ? e.target.closest('.vault-seg') : null;
            if (s) _vpGoDir(s.getAttribute('data-jump') || '');
        });
        // 面板内任意打印字符 → 直达搜索框（点过文件夹后焦点不在输入框也能直接搜）
        $vaultPanel.addEventListener('keydown', function (e) {
            if (!_vpPanelOpen) return;
            if (e.target === $vaultSearch || e.target === $vaultOnlyGone) return;
            if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                $vaultSearch.focus();
                $vaultSearch.value += e.key;
                _vpQuery = $vaultSearch.value;
                _vpRender(true);
                e.preventDefault();
            }
        });
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

    // ▼：全窗记忆库浏览器（钻取式）；键入框 = Everything 式全库搜索（扁平列表）
    if ($btnHistory) {
        $btnHistory.addEventListener('mousedown', function (e) {
            e.preventDefault(); // 防抢焦点（防键入框 focus 连锁唤起搜索列表）
        });
        $btnHistory.addEventListener('click', function (e) {
            e.stopPropagation();
            if (_vpPanelOpen) _vpClose();
            else _vpShow();
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
                    var hitItems = $fuzzyList.querySelectorAll('.fuzzy-item');
                    var hitEl = hitItems[_fuzzyIdx];
                    if (hitEl && hitEl.dataset && hitEl.dataset.path) {
                        _selectHistory(hitEl.dataset.path);
                        return;
                    }
                }
                _closeFuzzy();
                _openFileByPath(_titleGetText().trim());
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!_fuzzyVisible) { _buildFuzzyList(_titleGetText()); }
                var items = $fuzzyList.querySelectorAll('.fuzzy-item');
                if (items.length) {
                    // 触底且仍有未渲染行 → 先补批再前进（懒渲染 + 键盘无缝）
                    if (_fuzzyIdx + 1 >= items.length - 1 && _vaultRendered < _vaultRows.length) {
                        _vaultRenderMore();
                        items = $fuzzyList.querySelectorAll('.fuzzy-item');
                    }
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
                _vpClose();
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
        _syncOpMenu();
        // ★ 动态标签：读取焦点面板方向（roam 右键菜单传统 ←喂给 AI/喂给 AI/喂给 AI→）
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

    // ═══ ⭐ 恢复/写回（op 第四行，记忆库找回闭环 2026-09-11）══════════════
    // 统一语义 = 把「右侧选中的快照」写回当前路径：
    //   文件已删除 → 「恢复文件」（父目录自动重建 + 写入 + 留痕，无需确认）
    //   文件存在   → 「写回此版本」（确认覆盖 + 覆盖前先给当前磁盘内容记保护快照，零丢失）
    var $opRestoreItem = document.getElementById('op-restore-item');
    var $opRestoreLabel = document.getElementById('op-restore-label');

    function _syncOpLastClass() {
        if (!$opDropdown) return;
        var items = $opDropdown.querySelectorAll('.op-item');
        var last = null;
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove('is-last');
            if (items[i].style.display !== 'none') last = items[i];
        }
        if (last) last.classList.add('is-last');
    }

    function _syncOpMenu() {
        if (!$opRestoreItem) return;
        var val = $selRight ? $selRight.value : '';
        if (val && val !== 'last') {
            var txt = _fileExists ? _i('timeline.opWriteback', '写回此版本') : _i('timeline.opRestore', '恢复文件');
            if ($opRestoreLabel) $opRestoreLabel.textContent = txt; else $opRestoreItem.textContent = txt;
            $opRestoreItem.title = _fileExists
                ? _i('timeline.opWritebackTip', '把右侧选中的历史版本写回文件（覆盖前自动记录保护快照）')
                : _i('timeline.opRestoreTip', '用右侧选中的快照重建这个已删除的文件');
            $opRestoreItem.style.display = '';
        } else {
            $opRestoreItem.style.display = 'none';
        }
        _syncOpLastClass();
    }

    // 文件存在态同步（🗑️ 徽标 + 编辑按钮降级 + op 菜单）——loadVersions/刷新后调用
    function _syncFileStateUI() {
        if ($goneBadge) $goneBadge.style.display = _fileExists ? 'none' : '';
        if ($btnEdit) $btnEdit.style.opacity = _fileExists ? '' : '0.45';
        _syncOpMenu();
    }

    async function _doRestore() {
        var val = $selRight ? $selRight.value : '';
        if (!val || val === 'last' || !FILE_PATH) return;
        // TOCTOU 二次裁决：探测后被重建 / 被目录占用，都以此处为准
        var st = null;
        try { st = await bridge.fs.stat(FILE_PATH); } catch (_) { st = null; }
        if (st && st.isDir) {
            alert(_i('timeline.restoreDir', '该路径已被一个文件夹占用，无法写入'));
            return;
        }
        var content = null;
        try { content = await bridge.timeline.content({ projectRoot: PROJECT_ROOT, blobHash: val }); } catch (_) { content = null; }
        if (typeof content !== 'string') {
            alert(_i('timeline.restoreReadFail', '快照内容读取失败'));
            return;
        }
        if (st) {
            // 覆盖路径：确认 + 保护快照（先记当前磁盘内容，再写）
            var okGo = window.confirm(
                _i('timeline.restoreConfirm', '写回此版本将覆盖当前文件（当前内容会先记录一条保护快照）：') + '\n\n' + FILE_PATH
            );
            if (!okGo) return;
            try {
                var cur = await bridge.fs.read(FILE_PATH);
                if (typeof cur === 'string') {
                    await bridge.timeline.record({ projectRoot: PROJECT_ROOT, filePath: FILE_PATH, content: cur, source: 'restore-guard' });
                }
            } catch (_) { /* 保护快照失败不阻塞写回（磁盘内容仍在） */ }
        }
        try {
            await bridge.fs.write(FILE_PATH, content);
        } catch (e) {
            alert(_i('timeline.restoreWriteFail', '写入失败：{err}').replace('{err}', (e && e.message) || e));
            return;
        }
        // 留痕：恢复动作本身记录一条版本（source='restore'），审计可溯
        try { await bridge.timeline.record({ projectRoot: PROJECT_ROOT, filePath: FILE_PATH, content: content, source: 'restore' }); } catch (_) { }
        _invalidateVault();
        await loadVersions(FILE_PATH);
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
            } else if (action === 'roam') {
                // 在 Roam 中召回并打开（复用 AI 面板本地链接同一 Roam 定位引擎——
                // 解析/不存在爬升兜底/召回 roam tab/iframe 定位选中，全链同源）
                try { if (bridge && bridge.timeline && bridge.timeline.revealInRoam) bridge.timeline.revealInRoam(fp); } catch (_) { }
            } else if (action === 'restore') {
                // 恢复/写回：把右侧选中的快照写回当前路径（已删除 → 恢复文件；存在 → 写回此版本）
                _doRestore();
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
            $btnEditTip.textContent = _editing
                ? _i('timeline.editTooltipExit', '退出编辑时不会自动保存')
                : (!_fileExists ? _i('timeline.editDisabledTip', '文件已删除——用 op →「恢复文件」找回后再编辑')
                    : _i('timeline.editTooltip', '编辑当前磁盘最新文件（而非任何一个历史快照）'));
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

