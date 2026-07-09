'use strict';

// ═══ AI 面板内 Ctrl+F 搜索 ═══
(function () {
    var $searchBar = document.getElementById('search-bar');
    var $searchInput = document.getElementById('search-input');
    var $searchNav = document.getElementById('search-nav');
    var $searchClear = document.getElementById('search-clear');
    var $searchCase = document.getElementById('search-case');
    var _marks = [];       // Range[] (hlApi) 或 DOM Element[] (fallback)
    var _activeIdx = 0;
    var _searchText = '';
    var _caseSensitive = false;
    var _hlApi = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

    function _clearMarks() {
        if (_hlApi) {
            CSS.highlights.delete('search-hl');
            CSS.highlights.delete('search-hl-active');
        } else {
            for (var i = 0; i < _marks.length; i++) {
                var m = _marks[i];
                if (m && m.parentNode) {
                    m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
                }
            }
        }
        _marks = [];
        _activeIdx = 0;
        if (cardPool && questActiveId) cardPool.hideMarks(questActiveId);
    }

    function _autoResizeTextarea() {
        $searchInput.style.height = 'auto';
        var nh = Math.max(30, Math.min($searchInput.scrollHeight, 180));
        $searchInput.style.height = nh + 'px';
    }

    function _doSearch(text) {
        _clearMarks();
        if (!text || text.length < 1) { _updateNav(); return; }
        // Normalize CRLF → LF (Windows clipboard paste has \r\n, DOM text has \n)
        text = text.replace(/\r/g, '');
        _searchText = text;
        var card = cardPool ? cardPool.getActive() : null;
        var root = card && card._contentWrap ? card._contentWrap : $messages;

        // ── 多行搜索：用连续文本找匹配，块级元素间插 \n 再映射回各文本节点 ──
        var BLOCK_TAGS = { P:1, DIV:1, LI:1, PRE:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, BLOCKQUOTE:1, SECTION:1, ARTICLE:1, UL:1, OL:1, TABLE:1, TR:1, HR:1, BR:1 };
        function _blockAncestor(el) {
            while (el) { if (BLOCK_TAGS[el.tagName]) return el; el = el.parentElement; }
            return null;
        }
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        var textNodes = [];
        var fullText = '';
        var prevBlock = null;
        while (walker.nextNode()) {
            var node = walker.currentNode;
            if (!node.textContent) continue;
            if (node.parentElement && node.parentElement.closest('#search-bar')) continue;
            if (node.parentElement && node.parentElement.closest('.msg-ai-clock')) continue;
            if (!_hlApi) {
                if (node.parentElement && node.parentElement.closest('.search-mark')) continue;
                if (node.parentElement && node.parentElement.closest('.sel-match')) continue;
            }
            var curBlock = _blockAncestor(node.parentElement);
            // 不同块级元素之间插入 \n 使跨行搜索命中块边界
            if (prevBlock && curBlock !== prevBlock && fullText.length > 0 && fullText[fullText.length - 1] !== '\n') {
                fullText += '\n';
            }
            textNodes.push({ node: node, start: fullText.length });
            fullText += node.textContent;
            prevBlock = curBlock;
        }

        var tNeedle = _caseSensitive ? text : text.toLowerCase();
        var haystack = _caseSensitive ? fullText : fullText.toLowerCase();
        var matchPositions = [];
        var searchFrom = 0;
        while (searchFrom < haystack.length) {
            var idx = haystack.indexOf(tNeedle, searchFrom);
            if (idx < 0) break;
            matchPositions.push({ start: idx, end: idx + text.length });
            searchFrom = idx + text.length;
            if (searchFrom <= idx) searchFrom = idx + 1;
        }

        var ranges = [];
        for (var mi = 0; mi < matchPositions.length; mi++) {
            var mp = matchPositions[mi];
            var startNode = null, startOff = 0;
            var endNode = null, endOff = 0;
            for (var ni = 0; ni < textNodes.length; ni++) {
                var tn = textNodes[ni];
                var tnEnd = tn.start + tn.node.textContent.length;
                if (!startNode && mp.start >= tn.start && mp.start <= tnEnd) {
                    startNode = tn.node; startOff = mp.start - tn.start;
                }
                if (!endNode && mp.end >= tn.start && mp.end <= tnEnd) {
                    endNode = tn.node; endOff = mp.end - tn.start;
                }
                if (startNode && endNode) break;
            }
            if (startNode && endNode) {
                if (_hlApi) {
                    var r = new Range();
                    r.setStart(startNode, startOff);
                    r.setEnd(endNode, endOff);
                    ranges.push(r); _marks.push(r);
                } else {
                    // fallback：只处理单节点跨行（多节点跨行跳过）
                    if (startNode === endNode && startOff + text.length <= startNode.textContent.length) {
                        var parent = startNode.parentNode;
                        if (!parent) continue;
                        var before = startNode.textContent.slice(0, startOff);
                        var match = startNode.textContent.slice(startOff, startOff + text.length);
                        var after = startNode.textContent.slice(startOff + text.length);
                        var frag = document.createDocumentFragment();
                        if (before) frag.appendChild(document.createTextNode(before));
                        var mark = document.createElement('mark');
                        mark.className = 'search-mark'; mark.textContent = match;
                        frag.appendChild(mark);
                        if (after) frag.appendChild(document.createTextNode(after));
                        parent.replaceChild(frag, startNode);
                        _marks.push(mark);
                    }
                }
            }
        }

        if (_hlApi && ranges.length > 0) {
            var hl = new Highlight();
            for (var ri = 0; ri < ranges.length; ri++) hl.add(ranges[ri]);
            CSS.highlights.set('search-hl', hl);
        }
        _activeIdx = 0;
        _updateNav();
        _scrollToActive();
        _refreshSearchMarks();
    }

    function _updateNav() {
        if (_marks.length === 0) { $searchNav.textContent = _searchText ? '无匹配' : ''; }
        else { $searchNav.textContent = (_activeIdx + 1) + '/' + _marks.length; }
    }

    function _scrollToActive() {
        if (_marks.length === 0) return;
        if (_hlApi) {
            var activeR = _marks[_activeIdx];
            if (activeR) {
                CSS.highlights.set('search-hl-active', new Highlight(activeR));
                if (activeR.startContainer && activeR.startContainer.nodeType === 3) {
                    activeR.startContainer.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        } else {
            for (var i = 0; i < _marks.length; i++) _marks[i].classList.remove('search-mark-active');
            var active = _marks[_activeIdx];
            if (active) { active.classList.add('search-mark-active'); active.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        }
        _refreshSearchMarks();
    }

    function _refreshSearchMarks() {
        if (!cardPool || !questActiveId || _marks.length === 0) return;
        var positions = [];
        var msgRect = $messages.getBoundingClientRect();
        for (var mi = 0; mi < _marks.length; mi++) {
            var item = _marks[mi];
            var offsetTop = 0, elRef = null, rangeRef = null;
            if (_hlApi) {
                rangeRef = item;
                var rects = item.getClientRects();
                if (rects.length > 0) offsetTop = rects[0].top - msgRect.top + $messages.scrollTop;
            } else {
                elRef = item;
                if (!item.isConnected) continue;
                var el2 = item;
                while (el2 && el2 !== $messages) { offsetTop += el2.offsetTop || 0; el2 = el2.offsetParent; }
            }
            positions.push({ offsetTop: offsetTop, active: mi === _activeIdx, label: 'Match ' + (mi + 1), el: elRef, _range: rangeRef });
        }
        cardPool.showMarks(questActiveId, positions);
    }

    function _updateClearBtn() {
        if ($searchInput.value) { $searchClear.classList.add('visible'); }
        else { $searchClear.classList.remove('visible'); }
    }

    function _openSearch(prefillText) {
        _clearMarks();
        _searchText = ''; _activeIdx = 0;
        $searchBar.classList.add('show');
        $searchInput.value = prefillText || '';
        $searchNav.textContent = '';
        _updateClearBtn();
        _autoResizeTextarea();
        $searchInput.focus();
        if (prefillText) { _searchTimer = setTimeout(function () { _doSearch(prefillText); }, 50); }
    }

    function _closeSearch() {
        _clearMarks();
        $searchBar.classList.remove('show');
        $searchClear.classList.remove('visible');
        $input.focus();
    }

    var _searchTimer = null;
    $searchInput.addEventListener('input', function () {
        _autoResizeTextarea();
        _updateClearBtn();
        if (_searchTimer) clearTimeout(_searchTimer);
        var _val = this.value;
        _searchTimer = setTimeout(function () { _doSearch(_val); }, 200);
    });

    if ($searchClear) {
        $searchClear.addEventListener('click', function () {
            $searchInput.value = '';
            _updateClearBtn();
            _clearMarks();
            _autoResizeTextarea();
            $searchInput.focus();
        });
    }

    if ($searchCase) {
        $searchCase.addEventListener('click', function () {
            _caseSensitive = !_caseSensitive;
            $searchCase.classList.toggle('on', _caseSensitive);
            if ($searchInput.value) _doSearch($searchInput.value);
        });
    }

    $searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (_marks.length === 0) return;
            _activeIdx = e.shiftKey ? (_activeIdx - 1 + _marks.length) % _marks.length : (_activeIdx + 1) % _marks.length;
            _updateNav(); _scrollToActive();
        }
        if (e.key === 'Escape') { e.preventDefault(); _closeSearch(); }
    });

    document.getElementById('search-prev').onclick = function () {
        if (_marks.length === 0) return;
        _activeIdx = (_activeIdx - 1 + _marks.length) % _marks.length;
        _updateNav(); _scrollToActive();
    };

    document.getElementById('search-next').onclick = function () {
        if (_marks.length === 0) return;
        _activeIdx = (_activeIdx + 1) % _marks.length;
        _updateNav(); _scrollToActive();
    };

    document.getElementById('search-close').onclick = _closeSearch;

    // ★ 右键菜单 → 三级搜索
    var _ctxMenu = null;
    var _ctxMenuOnClick = null;
    var _ctxMenuOnKey = null;
    function _closeCtxMenu() {
        if (_ctxMenuOnClick) { document.removeEventListener('mousedown', _ctxMenuOnClick, true); _ctxMenuOnClick = null; }
        if (_ctxMenuOnKey) { document.removeEventListener('keydown', _ctxMenuOnKey, true); _ctxMenuOnKey = null; }
        if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
    }
    function _getSelText() { var s = window.getSelection(); return (s && s.toString() || '').trim(); }

    async function _resolveQuestDir() {
        var root = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
        if (!root || !questActiveId) return null;
        var qd = root + '/qqq/quests/';
        try {
            var bf = (typeof bridge !== 'undefined' && bridge.fs) ? bridge.fs : (window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.fs);
            if (!bf) return null;
            var entries = await bf.list(qd);
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].isDir && entries[i].name.indexOf(questActiveId + '.') === 0) {
                    return qd + entries[i].name + '/';
                }
            }
        } catch (_) { }
        return null;
    }

    function _doSmallSearch(selText) {
        _openSearch(selText);
    }

    async function _doMidSearch(selText) {
        var questDir = await _resolveQuestDir();
        if (!questDir) return;
        var searchPath = questDir + 'search_quest.txt';
        // 始终设 _nextSearch 触发 find widget
        //   无选中文字时用 sentinel '__FIND__' 让 _triggerEditorFind 打开空搜索框
        if (window.parent) window.parent._nextSearch = selText || '__FIND__';
        if (window.parent && window.parent.qqqTabs && window.parent.qqqTabs.openFileInRightGroup) {
            window.parent.qqqTabs.openFileInRightGroup(searchPath);
        }
        setTimeout(function () {
            if (window.parent) window.parent._nextSearch = selText || '__FIND__';
        }, 150);
    }

    async function _doBigSearch(selText) {
        var root = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
        if (!root) return;
        var scopePath = root.replace(/\\/g, '/') + '/qqq/';
        if (window.parent && window.parent.qqqideOpenSearch) {
            window.parent.qqqideOpenSearch(scopePath, true);
        }
        // Send query to search iframe after it loads
        if (selText) {
            var _sendQuery = function () {
                try {
                    var panes = window.parent.document.querySelectorAll('.qqq-tab-pane');
                    for (var i = 0; i < panes.length; i++) {
                        var iframe = panes[i]._searchIframe || panes[i].querySelector('iframe[src*="search-ui.html"]');
                        if (iframe && iframe.contentWindow) {
                            iframe.contentWindow.postMessage({ type: 'qqqide-search-set-scope', path: scopePath, query: selText }, '*');
                        }
                    }
                } catch (_) { }
            };
            setTimeout(_sendQuery, 500);
            setTimeout(_sendQuery, 1200);
        }
    }

    $messages.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        _closeCtxMenu();
        var selText = _getSelText();

        var menu = document.createElement('div');
        menu.id = 'search-ctx-menu';
        menu.className = 'search-ctx-menu';
        // Position: shift down 6px to not cover cursor, and clamp to viewport
        var mx = e.clientX, my = e.clientY + 6;
        var menuW = 280, menuH = 130; // estimated
        if (mx + menuW > window.innerWidth) mx = window.innerWidth - menuW - 8;
        if (my + menuH > window.innerHeight) my = e.clientY - menuH - 6;
        menu.style.left = Math.max(4, mx) + 'px';
        menu.style.top = Math.max(4, my) + 'px';

        var rows = [
            { label: '\uD83D\uDD0D \u5C0F\u641C\u7D22 \u2014 \u9762\u677F\u5185\u67E5\u627E', action: function () { _doSmallSearch(selText); } },
            { label: '\uD83D\uDCC4 \u4E2D\u641C\u7D22 \u2014 \u5F53\u524D\u4EFB\u52A1\u5168\u6587\u68C0\u7D22', action: function () { _doMidSearch(selText); } },
            { label: '\uD83C\uDF10 \u5927\u641C\u7D22 \u2014 \u8DE8\u4EFB\u52A1\u5168\u5C40\u68C0\u7D22', action: function () { _doBigSearch(selText); } }
        ];
        for (var ri = 0; ri < rows.length; ri++) {
            var row = document.createElement('div');
            row.className = 'ctx-row';
            row.textContent = rows[ri].label;
            row.onclick = function (actFn) { return function () { _closeCtxMenu(); actFn(); }; }(rows[ri].action);
            menu.appendChild(row);
        }
        document.body.appendChild(menu);
        _ctxMenu = menu;

        // Auto-close on outside click / Escape（捕获 menu 引用防闭包覆盖）
        var _capturedMenu = menu;
        _ctxMenuOnClick = function (ev) {
            if (_capturedMenu && !_capturedMenu.contains(ev.target)) { _closeCtxMenu(); }
        };
        _ctxMenuOnKey = function (ev) {
            if (ev.key === 'Escape') { _closeCtxMenu(); }
        };
        setTimeout(function () {
            document.addEventListener('mousedown', _ctxMenuOnClick, true);
            document.addEventListener('keydown', _ctxMenuOnKey, true);
        }, 0);
    });

    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); e.stopPropagation(); _openSearch(); }
        if (e.key === 'Escape' && $searchBar.classList.contains('show')) { e.preventDefault(); _closeSearch(); }
    });
})();

// ═══ VS Code 风格选中同词高亮 ═════
(function () {
    'use strict';
    var _selMarks = [];   // Range[] (hlApi) 或 DOM Element[] (fallback)
    var _selText = '';
    var _selTimer = null;
    var _hlApi = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

    function _clearSelMarks() {
        if (_hlApi) {
            CSS.highlights.delete('sel-hl');
        } else {
            for (var i = 0; i < _selMarks.length; i++) {
                var m = _selMarks[i];
                if (m && m.parentNode) {
                    m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
                }
            }
        }
        _selMarks = [];
        _selText = '';
        if (cardPool && questActiveId) cardPool.hideMarks(questActiveId);
    }

    function _highlightSelection(text) {
        _clearSelMarks();
        if (!text || text.length < 2) return;
        _selText = text;
        var card = cardPool ? cardPool.getActive() : null;
        if (!card || !card._contentWrap) return;
        var tLower = text.toLowerCase();
        var hitNodes = [];
        var walker = document.createTreeWalker(card._contentWrap, NodeFilter.SHOW_TEXT, null, false);
        while (walker.nextNode()) {
            var node = walker.currentNode;
            if (!node.textContent || !node.textContent.trim()) continue;
            if (node.parentElement && node.parentElement.closest('.msg-ai-clock')) continue;
            if (node.parentElement && node.parentElement.closest('.msg-a1')) continue;
            if (node.parentElement && node.parentElement.closest('#search-bar')) continue;
            if (!_hlApi) {
                if (node.parentElement && node.parentElement.closest('.sel-match')) continue;
                if (node.parentElement && node.parentElement.closest('.search-mark')) continue;
            }
            var lower = node.textContent.toLowerCase();
            var indices = [];
            var searchFrom = 0;
            while (searchFrom < lower.length) {
                var idx = lower.indexOf(tLower, searchFrom);
                if (idx < 0) break;
                indices.push(idx);
                searchFrom = idx + tLower.length;
            }
            if (indices.length > 0) hitNodes.push({ node: node, indices: indices });
        }
        if (_hlApi) {
            var ranges = [];
            for (var hi = 0; hi < hitNodes.length; hi++) {
                var hit = hitNodes[hi];
                for (var ii = 0; ii < hit.indices.length; ii++) {
                    var r = new Range();
                    r.setStart(hit.node, hit.indices[ii]);
                    r.setEnd(hit.node, hit.indices[ii] + text.length);
                    ranges.push(r); _selMarks.push(r);
                }
            }
            if (ranges.length > 0) {
                var hl2 = new Highlight();
                for (var ri2 = 0; ri2 < ranges.length; ri2++) hl2.add(ranges[ri2]);
                CSS.highlights.set('sel-hl', hl2);
            }
        } else {
            for (var hi2 = hitNodes.length - 1; hi2 >= 0; hi2--) {
                var hit2 = hitNodes[hi2];
                var parent = hit2.node.parentNode;
                if (!parent) continue;
                var indicesDesc = hit2.indices.slice().sort(function (a, b) { return b - a; });
                var workNode = hit2.node;
                for (var ii2 = 0; ii2 < indicesDesc.length; ii2++) {
                    var matchIdx = indicesDesc[ii2];
                    var before = workNode.textContent.slice(0, matchIdx);
                    var match = workNode.textContent.slice(matchIdx, matchIdx + text.length);
                    var after = workNode.textContent.slice(matchIdx + text.length);
                    var frag = document.createDocumentFragment();
                    if (before) frag.appendChild(document.createTextNode(before));
                    var mark = document.createElement('mark');
                    mark.className = 'sel-match'; mark.textContent = match;
                    frag.appendChild(mark);
                    if (after) frag.appendChild(document.createTextNode(after));
                    parent.replaceChild(frag, workNode);
                    _selMarks.push(mark);
                    workNode = frag.lastChild;
                    if (!after) break;
                }
            }
        }
        var positions = [];
        var msgRect = $messages.getBoundingClientRect();
        for (var mi = 0; mi < _selMarks.length; mi++) {
            var item = _selMarks[mi];
            var offsetTop = 0, elRef = null, rangeRef = null;
            if (_hlApi) {
                rangeRef = item;
                var rects = item.getClientRects();
                if (rects.length > 0) offsetTop = rects[0].top - msgRect.top + $messages.scrollTop;
            } else {
                elRef = item;
                if (!item.isConnected) continue;
                var el2 = item;
                while (el2 && el2 !== $messages) { offsetTop += el2.offsetTop || 0; el2 = el2.offsetParent; }
            }
            positions.push({ offsetTop: offsetTop, active: false, label: text, el: elRef, _range: rangeRef });
        }
        if (positions.length > 0) cardPool.showMarks(questActiveId, positions);
    }

    document.addEventListener('mouseup', function (e) {
        if (!_hlApi && e.target.closest('.sel-match')) { _clearSelMarks(); return; }
        if (!_hlApi && e.target.closest('.search-mark')) return;
        setTimeout(function () {
            var sel = window.getSelection();
            var text = (sel && sel.toString() || '').trim();
            if (text && text.length >= 2 && text !== _selText) {
                _highlightSelection(text);
                if (!_hlApi) try { sel.removeAllRanges(); } catch (_) { }
            }
        }, 100);
    });

    document.addEventListener('mousedown', function (e) {
        if (_selMarks.length === 0) return;
        if (!_hlApi && e.target.closest('.sel-match')) return;
        setTimeout(function () {
            var sel = window.getSelection();
            var newText = (sel && sel.toString() || '').trim();
            if (!newText) { _clearSelMarks(); }
            else if (newText !== _selText) { _clearSelMarks(); }
        }, 150);
    });

    document.addEventListener('copy', function (e) {
        if (_selMarks.length === 0) return;
        var sel = window.getSelection();
        var selText = (sel && sel.toString() || '').trim();
        if (selText) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', _selText);
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && _selMarks.length > 0 && !document.getElementById('search-bar').classList.contains('show')) {
            _clearSelMarks();
        }
    });

    window._clearSelMarks = _clearSelMarks;
})();
