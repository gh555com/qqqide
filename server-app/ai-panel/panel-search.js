'use strict';

// ═══ AI 面板内 Ctrl+F 搜索 ═══
(function () {
    var $searchBar = document.getElementById('search-bar');
    var $searchInput = document.getElementById('search-input');
    var $searchNav = document.getElementById('search-nav');
    var _marks = [];       // Range[] (hlApi) 或 DOM Element[] (fallback)
    var _activeIdx = 0;
    var _searchText = '';
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

    function _doSearch(text) {
        _clearMarks();
        if (!text || text.length < 1) { _updateNav(); return; }
        _searchText = text;
        var card = cardPool ? cardPool.getActive() : null;
        var root = card && card._contentWrap ? card._contentWrap : $messages;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        var tLower = text.toLowerCase();
        var hitNodes = [];
        while (walker.nextNode()) {
            var node = walker.currentNode;
            if (!node.textContent || !node.textContent.trim()) continue;
            if (node.parentElement && node.parentElement.closest('#search-bar')) continue;
            if (node.parentElement && node.parentElement.closest('.msg-ai-clock')) continue;
            if (!_hlApi) {
                if (node.parentElement && node.parentElement.closest('.search-mark')) continue;
                if (node.parentElement && node.parentElement.closest('.sel-match')) continue;
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
        var ranges = [];
        if (_hlApi) {
            for (var hi = 0; hi < hitNodes.length; hi++) {
                var hit = hitNodes[hi];
                for (var ii = 0; ii < hit.indices.length; ii++) {
                    var r = new Range();
                    r.setStart(hit.node, hit.indices[ii]);
                    r.setEnd(hit.node, hit.indices[ii] + text.length);
                    ranges.push(r); _marks.push(r);
                }
            }
            if (ranges.length > 0) {
                var hl = new Highlight();
                for (var ri = 0; ri < ranges.length; ri++) hl.add(ranges[ri]);
                CSS.highlights.set('search-hl', hl);
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
                    mark.className = 'search-mark'; mark.textContent = match;
                    frag.appendChild(mark);
                    if (after) frag.appendChild(document.createTextNode(after));
                    parent.replaceChild(frag, workNode);
                    _marks.push(mark);
                    workNode = frag.lastChild;
                    if (!after) break;
                }
            }
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

    function _openSearch() {
        _clearMarks();
        _searchText = ''; _activeIdx = 0;
        $searchBar.classList.add('show');
        $searchInput.value = ''; $searchNav.textContent = '';
        $searchInput.focus();
    }

    function _closeSearch() {
        _clearMarks();
        $searchBar.classList.remove('show');
        $input.focus();
    }

    var _searchTimer = null;
    $searchInput.addEventListener('input', function () {
        if (_searchTimer) clearTimeout(_searchTimer);
        var _val = this.value;
        _searchTimer = setTimeout(function () { _doSearch(_val); }, 200);
    });

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

    document.getElementById('search-toggle').onclick = function () {
        if ($searchBar.classList.contains('show')) _closeSearch(); else _openSearch();
    };

    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); e.stopPropagation(); _openSearch(); }
        if (e.key === 'Escape' && $searchBar.classList.contains('show')) { e.preventDefault(); _closeSearch(); }
    });
})();

// ═══ VS Code 风格选中同词高亮 ═══
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
