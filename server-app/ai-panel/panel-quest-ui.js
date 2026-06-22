'use strict';
// \u2550\u2550\u2550 panel-quest-ui.js \u2550\u2550\u2550
// Quest UI: switchQuest, CRUD, cost/balance, ctx button, guide button, queue system

async function switchQuest(id) {
    if (id === questActiveId) return;
    if (_switching) return;
    _switching = true;
    // ★ 全屏蒙板 + dim：阻绝一切鼠标操作，键盘由 _switching 守卫拦截
    var _overlay = document.getElementById('qqq-switch-overlay');
    if (_overlay) _overlay.classList.add('show');
    if ($messages) $messages.classList.add('qqq-switching');
    try {
        // \u2550\u2550\u2550 \u6240\u6709\u6743\u68c0\u67e5\uff08\u5206\u4e24\u5c42\uff1a\u2460 \u540c\u6b65\u7236\u6ce8\u518c\u8868 \u2461 \u5f02\u6b65 store + broadcast \u515c\u5e95\uff09 \u2550\u2550\u2550
        var _syncOwnerPanel = _parentGetQuestOwner(id);
        if (_syncOwnerPanel !== undefined && _syncOwnerPanel !== _panelId) {
            _setPanelFocus(false);
            if (_syncOwnerPanel === 0 || _syncOwnerPanel === 2) {
                try { parent.postMessage({ type: 'qqq-open-wing', panel: _syncOwnerPanel }, '*'); } catch (_) { }
            }
            try {
                if (parent && parent.qqqideQoast) parent.qqqideQoast.show(
                    '\ud83d\udccc \u8be5 Quest \u5df2\u5728' + (_syncOwnerPanel === 0 ? '\u5de6' : _syncOwnerPanel === 2 ? '\u53f3' : '\u4e2d') + '\u9762\u677f\u6253\u5f00\uff0c\u5df2\u81ea\u52a8\u8df3\u8f6c',
                    { type: 'info', duration: 3000 }
                );
            } catch (_) { }
            _switching = false;
            return;
        }
        // ★ 保存旧 quest UI 状态 + 释放所有权
        if (questActiveId) {
            saveQuestUIState(questActiveId);
            _stopAutoSave();
            if (_activeAgent && _activeAgent._compressing) {
                // 压缩进行中 → 等待完成（最多 220s），防保存半成品
                var _waitStart = Date.now();
                while (_activeAgent._compressing && (Date.now() - _waitStart) < 220000) {
                    await new Promise(function (r) { setTimeout(r, 200); });
                }
            }
            if (_activeAgent) {
                await _saveAgentQuestData(questActiveId, _activeAgent, _activeAgent._currentFloorNum);
            }
            if (!_isDraft(questActiveId)) {
                _parentReleaseQuest(questActiveId);
                _broadcast('owner-released', questActiveId);
            }
        }

        // \u2550\u2550\u2550 Card Pool \u5207\u6362\uff08\u7eaf CSS \u663e\u9690\uff0c\u96f6 DOM \u9500\u6bc1\uff09 \u2550\u2550\u2550
        await cardPool.switchTo(id);

        questActiveId = id;
        if (_panelId === 1) {
            await questStore.setActiveId(id);
        }
        if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
            // ★ setNow 立即写盘：确保 activeQuestId 在崩溃/退出时不丢，
            //    否则重启时 initQuests 找不到记录 → 回退到 ~New quest~ 草稿
            onlyStore.setNow('ai.panel.' + _panelId + '.activeQuestId', id);
            if (_panelId === 1) onlyStore.setNow('ai.activeQuestId', id);
        }

        // ★ 声明所有权（仅父注册表；quest.sq3 不再参与）
        _parentClaimQuest(id);
        _broadcast('owner-claimed', id);

        // \u2550\u2550\u2550 \u4ea4\u6362 active agent \u2550\u2550\u2550
        _activeAgent = _getOrCreateAgent(id);

        // \u2550\u2550\u2550 \u6062\u590d agent \u72b6\u6001\uff08conversation + metadata\uff09 \u2550\u2550\u2550
        await _restoreAgentFromStore(id, _activeAgent);

        // ★ 无条件恢复 _activeAiDiv 绑定（不区分 building/stopped）
        var card = cardPool.getCard(id);
        if (card) {
            if (card.buildingFloor !== null) {
                var bDOM = card.floorDOM[card.buildingFloor];
                if (bDOM && bDOM.aiEl) {
                    _activeAgent._activeAiDiv = bDOM.aiEl;
                }
            } else {
                // 已停止的 quest：找到最后一个有 aiEl 的楼层
                var _floorNums = Object.keys(card.floorDOM || {}).map(Number).sort(function (a, b) { return b - a; });
                for (var _fi = 0; _fi < _floorNums.length; _fi++) {
                    var _fDom = card.floorDOM[_floorNums[_fi]];
                    if (_fDom && _fDom.aiEl) {
                        _activeAgent._activeAiDiv = _fDom.aiEl;
                        // ★ 恢复时钟为停止态（匹配该楼层专属 timing 记录，非盲目取最后一条）
                        if (_fDom.aiEl._clockBlock && _activeAgent._floorTimings && _activeAgent._floorTimings.length > 0) {
                            var _thisFloorNum = _floorNums[_fi];
                            var _matchTiming = null;
                            for (var _ti = 0; _ti < _activeAgent._floorTimings.length; _ti++) {
                                if (_activeAgent._floorTimings[_ti].floorIndex === _thisFloorNum) {
                                    _matchTiming = _activeAgent._floorTimings[_ti];
                                    break;
                                }
                            }
                            if (!_matchTiming) _matchTiming = _activeAgent._floorTimings[_activeAgent._floorTimings.length - 1];
                            var _cBlock = _fDom.aiEl._clockBlock;
                            _cBlock.className = 'msg-ai-clock';
                            var _durS = Math.floor((_matchTiming.durationMs || 0) / 1000);
                            var _cMin = _fDom.aiEl._clockMin;
                            var _cSec = _fDom.aiEl._clockSec;
                            if (_cMin) _cMin.textContent = Math.floor(_durS / 60) + 'm';
                            if (_cSec) _cSec.textContent = ':' + (_durS % 60 < 10 ? '0' : '') + (_durS % 60) + 's';
                            if (_fDom.aiEl._clockCanvas) {
                                _fDom.aiEl._clockCanvas.style.visibility = 'visible';
                                drawPie(_fDom.aiEl._clockCanvas, {
                                    networkMs: _matchTiming.networkMs || 0,
                                    aiMs: _matchTiming.aiMs || 0,
                                    toolMs: _matchTiming.toolMs || 0,
                                    totalMs: _matchTiming.durationMs || 0
                                });
                            }
                        }
                        // ★ 防御：切回已停止 quest 时，确保时钟 timer 已清除（防僵尸 timer 继续走字）
                        if (_activeAgent._floorTimerId) {
                            clearInterval(_activeAgent._floorTimerId);
                            _activeAgent._floorTimerId = null;
                        }
                        break;
                    }
                }
            }
        }

        // ★ 切换到 quest 时不再尝试实时修复磁盘目录名
        //   B+ 方案：懒惰重命名扫描只在启动/关闭时由中面板执行
        restoreQuestUIState(id);
        renderQueueStrip();
        updateCostDisplay();
        updateCtxBtn();
        await renderTabs();
        _scrollToBottomDeferred(true);
    } finally {
        _switching = false;
        var _overlay = document.getElementById('qqq-switch-overlay');
        if (_overlay) _overlay.classList.remove('show');
        if ($messages) $messages.classList.remove('qqq-switching');
        setStreaming(false);  // ★ 切 quest 后刷新按钮状态
    }
}

// \u2500\u2500 \u751f\u6210 quest/floor \u6587\u4ef6\u5939\u540d\uff1aq{n}.{\u5b89\u5168\u5316\u6587\u672c} \u6216 f{n}.{\u5b89\u5168\u5316\u6587\u672c} \u2500\u2500
function _makeName(prefix, num, text) {
    var MAX_BYTES = 100;
    if (!text) return prefix + num;

    var bytes = new TextEncoder().encode(text);
    var end = Math.min(MAX_BYTES, bytes.length);
    while (end > 0 && (bytes[end] & 0xC0) === 0x80) { end--; }
    var truncated = bytes.slice(0, end);
    var decoded = new TextDecoder().decode(truncated);

    var sanitized = decoded
        .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();

    sanitized = sanitized.replace(/^\.+/, '').replace(/\.+$/, '');

    var upper = sanitized.toUpperCase();
    var RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
    if (RESERVED.test(upper) || RESERVED.test(upper.replace(/\..*/, ''))) {
        sanitized = '_' + sanitized;
    }

    if (!sanitized) return prefix + num;
    return prefix + num + '.' + sanitized;
}

// \u2500\u2500 \u521b\u5efa quest \u6587\u4ef6\u5939\uff08\u542b\u5d4c\u5957 floor \u76ee\u5f55\uff09\u2500\u2500
// \u2605 \u9632 TOCTOU \u5206\u88c2\uff1a\u4e0d\u4fe1\u4efb\u4f20\u5165\u7684 qName\uff0c\u6309\u524d\u7f00\u91cd\u67e5\u78c1\u76d8\u5b9e\u9645\u76ee\u5f55\u540d
async function _ensureQuestDir(root, qName, fName) {
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge || !bridge.fs) return;
    // \u4ece qName \u63d0\u53d6 questId\uff08\u5982 "q48.xxx" \u2192 "q48"\uff09\uff0c\u6309\u524d\u7f00\u91cd\u67e5\u5b9e\u9645\u76ee\u5f55
    var questId = qName.split('.')[0];
    if (questId) {
        var actualName = await _findQuestDirByPrefix(root, questId);
        if (actualName) qName = actualName;
    }
    var qDir = root + '/qqq/quests/' + qName;
    var fDir = qDir + '/' + fName + '/';
    var parts = fDir.replace(/\\/g, '/').split('/').filter(function (p) { return p; });
    var accum = '';
    for (var pi = 0; pi < parts.length; pi++) {
        accum += (accum ? '/' : '') + parts[pi];
        try { await bridge.fs.mkdir(accum); } catch (_) { }
    }
    return { qDir: qDir, fDir: fDir };
}

// ── 按 q{n}. 前缀搜索已有 quest 目录（只匹配编号，不依赖标题）──
// ── 遇碰撞（同前缀多目录）打 warn，始终返回第一个 ──
async function _findQuestDirByPrefix(root, questId) {
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge || !bridge.fs) return null;
    var questsDir = root + '/qqq/quests/';
    try {
        var entries = await bridge.fs.list(questsDir);
        var matches = [];
        for (var ei = 0; ei < entries.length; ei++) {
            if (entries[ei].name.startsWith(questId + '.') && entries[ei].isDir) {
                matches.push(entries[ei].name);
            }
        }
        if (matches.length > 1) {
            console.warn('[quest-dir] COLLISION: prefix ' + questId + ' has ' + matches.length + ' dirs:', matches.join(', '));
            console.warn('[quest-dir]   → using ' + matches[0]);
        }
        return matches[0] || null;
    } catch (_) { }
    return null;
}

// ── 解析 quest 目录名：只按 q{n}. 前缀匹配已有目录 ──
// B+ 方案：不再实时修复或创建新目录，只返回已有目录名
// 若找不到（首次建楼调用此函数），则由 build 路径自己决定
async function _resolveQuestDirName(root, questId, numericId, title) {
    var existing = await _findQuestDirByPrefix(root, questId);
    if (existing) return existing;
    // ★ 找不到 → 返回 expected name（调用方 _ensureQuestDir 会按需创建）
    //   不再实时修复目录名，懒惰修正留给 lazyRenameScan
    return _makeName('q', numericId, title);
}

async function createNewQuest() {
    if (_switching) return;  // ★ quest 切换中
    if (streaming) stopStream();
    saveQuestUIState(questActiveId);
    if (!_isDraft(questActiveId)) await saveQuestData();
    if (questActiveId && !_isDraft(questActiveId)) {
        _parentReleaseQuest(questActiveId);
        _broadcast('owner-released', questActiveId);
    }
    if (questActiveId) {
        cardPool.removeCard(questActiveId);
    }
    _unloadQuest();
}

function _unloadQuest() {
    var unloadId = questActiveId;
    if (unloadId && !_isDraft(unloadId)) { _parentReleaseQuest(unloadId); }
    _stopAutoSave();
    if (unloadId && cardPool) {
        var oldCard = cardPool.getCard(unloadId);
        if (oldCard && oldCard.dom) {
            oldCard.dom.style.display = 'none';
        }
    }
    questActiveId = _draftId;
    _queueFallback = [];
    if (unloadId && agentPool[unloadId]) {
        agentPool[unloadId]._queue = [];
    }
    if (_queueSaveTimer) { clearTimeout(_queueSaveTimer); _queueSaveTimer = null; }
    renderQueueStrip();
    $input.value = '';
    $input._resetUndo();
    pendingImages = [];
    selectedTier = (typeof _getDefaultTier === 'function') ? _getDefaultTier() : 6;
    updateTierButtons(selectedTier);
    renderImageStrip();
    _activeAgent = null;
    setStreaming(false);  // ★ 卸载 quest 后刷新按钮状态后刷新按钮状态
    updateCostDisplay();
    updateCtxBtn();
    var children = $messages.children;
    for (var ci = children.length - 1; ci >= 0; ci--) {
        var child = children[ci];
        if (child.id === 'search-bar') continue;
        if (child.className && child.className.indexOf('card') === 0) continue;
        child.remove();
    }
    renderTabs();
}

async function deleteQuest(id) {
    var quests = await questStore.list();
    if (quests.length <= 1) { await createNewQuest(); return; }
    await questStore.deleteQuest(id);
    delete questUIStates[id];
    _parentReleaseQuest(id);
    _broadcast('owner-released', id);
    if (agentPool[id]) {
        try { agentPool[id].abort(); } catch (_) { }
        delete agentPool[id];
    }
    cardPool.removeCard(id);
    if (questActiveId === id) {
        // 删除的是当前活跃 quest → 切换到下一个
        quests = await questStore.list();
        questActiveId = quests[0].id;
        if (_panelId === 1) await questStore.setActiveId(questActiveId);
        _activeAgent = _getOrCreateAgent(questActiveId);
        await cardPool.switchTo(questActiveId);
        await _restoreAgentFromStore(questActiveId, _activeAgent);
        restoreQuestUIState(questActiveId);
        _parentClaimQuest(questActiveId);
        _broadcast('owner-claimed', questActiveId);
    }
    // 删除非活跃 quest → 保持当前视图不变，仅刷新下拉
    await renderTabs();
}

// ── 重命名 quest：只改 DB，不改磁盘目录名 ──
//   B+ 方案：磁盘目录名由 lazyRenameScan 在启动/关闭时懒惰修正
async function renameQuest(id, newTitle) {
    if (!id || !newTitle) return;
    var quests = await questStore.list();
    var entry = quests.find(function (q) { return q.id === id; });
    if (!entry) return;
    var oldTitle = entry.title;
    if (oldTitle === newTitle) return;
    await questStore.rename(id, newTitle, entry.numericId);
    await renderTabs();
}

// \u2500\u2500 Cost / Balance display \u2500\u2500
function _updateCostDisplay() {
    $costLabel.textContent = _windowTotalCostGe < 0.0001 ? '0' : _windowTotalCostGe.toFixed(4);
}

function _updateBalanceDisplay(balanceGe) {
    if (balanceGe !== undefined && balanceGe !== null) {
        $balLabel.textContent = balanceGe;
    }
}

function _checkTokenReset() {
    var tok = getToken();
    if (tok !== _lastTokenForCost) {
        _lastTokenForCost = tok;
        _windowTotalCostGe = 0;
        _balanceCache = null;
        _updateCostDisplay();
        _updateBalanceDisplay('--');
        _fetchBalanceIfNeeded();
    }
}

function _fetchBalanceIfNeeded(force) {
    var now = Date.now();
    if (!force && _balanceCache && (now - _balanceCache.ts) < 300000) {
        _updateBalanceDisplay(_balanceCache.balance_ge);
        return;
    }
    var token = getToken();
    if (!token) return;
    fetch('https://direct.gh555.com:8444/api/wallet/balance', {
        headers: { 'Authorization': 'Bearer ' + token }
    }).then(function (r) { return r.json(); })
        .then(function (data) {
            if (data && data.ok) {
                _balanceCache = { balance_ge: data.balance_ge, ts: Date.now() };
                _updateBalanceDisplay(data.balance_ge);
            }
        }).catch(function () { });
}

function updateCostDisplay() {
    _updateCostDisplay();
}

// \u2500\u2500 \u4e0a\u4e0b\u6587\u8840\u91cf \u2500\u2500
var CTX_MAX_TOKENS = ContentGateway.CTX_MAX_TOKENS;
var _estCache = { val: 0, convLen: -1, ctxHash: '' };
function estimateTokens() {
    if (!_activeAgent) return 0;
    var conv = _activeAgent.conversation;
    var ctx = _activeAgent._ctx;
    var ctxHash = ctx ? (ctx.totalFloors + '|' + (ctx.facts ? ctx.facts.length : 0)) : '';
    if (_estCache.convLen === conv.length && _estCache.ctxHash === ctxHash && _estCache.val > 0) {
        return _estCache.val;
    }
    // ★ 委托给统一计算函数（同时产出 _ctxBreakdownData）
    return _estimateTokensFull();
}

// ★ 统一计算：总 token + 拆解，一次遍历，单一缓存（按钮+面板共用）
function _estimateTokensFull() {
    var CP = ContentGateway.CHAR_PER_TOKEN;
    var _ag = _activeAgent;
    var conv = _ag ? _ag.conversation : [];
    var ctx = _ag ? _ag._ctx : null;
    var sysTok = 0, toolsTok = 0, rulesTok = 0, msgsTok = 0, compTok = 0;
    var _dbg = { sys: typeof SYSTEM_PROMPT !== 'undefined' ? SYSTEM_PROMPT.length : 'UNDEFINED', tools: typeof TOOL_DEFINITIONS !== 'undefined' ? JSON.stringify(TOOL_DEFINITIONS).length : 'UNDEFINED', convLen: conv.length, contentCount: 0, contentChars: 0, nonStringContent: 0, tcalls: 0 };
    if (typeof SYSTEM_PROMPT !== 'undefined' && SYSTEM_PROMPT) sysTok = Math.round(SYSTEM_PROMPT.length / CP);
    if (typeof TOOL_DEFINITIONS !== 'undefined') {
        try { toolsTok = Math.round(JSON.stringify(TOOL_DEFINITIONS).length / CP); } catch (_) { }
    }
    for (var i = 0; i < conv.length; i++) {
        var m = conv[i];
        if (m._persistent) {
            if (typeof m.content === 'string') { rulesTok += Math.round(m.content.length / CP); _dbg.contentChars += m.content.length; _dbg.contentCount++; } else { _dbg.nonStringContent++; }
            continue;
        }
        if (typeof m.content === 'string') { msgsTok += Math.round(m.content.length / CP); _dbg.contentChars += m.content.length; _dbg.contentCount++; } else { _dbg.nonStringContent++; }
        if (m.tool_calls && Array.isArray(m.tool_calls)) {
            try { msgsTok += Math.round(JSON.stringify(m.tool_calls).length / CP); _dbg.tcalls += m.tool_calls.length; } catch (_) { }
        }
        msgsTok += 10;
    }
    if (ctx) {
        if (ctx.narrative) compTok += Math.round(('[DYNAMIC CONTEXT]\nCONVERSATION CONTEXT (compressed history):\n' + ctx.narrative).length / CP);
        if (ctx.facts && ctx.facts.length > 0) {
            for (var fi = 0; fi < ctx.facts.length; fi++) {
                compTok += Math.round(((ctx.facts[fi].content || '') + ' [' + (ctx.facts[fi].type || '') + ']').length / CP);
            }
        }
    }
    var total = sysTok + toolsTok + rulesTok + msgsTok + compTok;
    console.error('[CTX_BD] sys=' + sysTok + ' tools=' + toolsTok + ' rules=' + rulesTok + ' msgs=' + msgsTok + ' comp=' + compTok + ' conv=' + conv.length + ' msgs, SYSTEM_PROMPT.len=' + _dbg.sys + ' TOOL_DEFS.len=' + _dbg.tools + ' contentCount=' + _dbg.contentCount + ' contentChars=' + _dbg.contentChars + ' nonStringContent=' + _dbg.nonStringContent + ' tool_calls=' + _dbg.tcalls + ' CP=' + CP);
    _ctxBreakdownData = [
        { key: 'sys', label: 'System Prompt', tok: sysTok, color: '#268bd2' },
        { key: 'tools', label: 'Tool Definitions', tok: toolsTok, color: '#6c71c4' },
        { key: 'rules', label: 'Project Rules', tok: rulesTok, color: '#2aa198' },
        { key: 'msgs', label: 'Messages', tok: msgsTok, color: '#b58900' },
        { key: 'comp', label: 'Compressed', tok: compTok, color: '#cb4b16' },
        { key: 'free', label: 'Free', tok: Math.max(0, CTX_MAX_TOKENS - total), color: '#859900' }
    ];
    _estCache = { val: total, convLen: conv.length, ctxHash: ctx ? (ctx.totalFloors + '|' + (ctx.facts ? ctx.facts.length : 0)) : '' };
    return total;
}ength : 0)) : '' };
    return total;
}

// ═══ 上下文占用拆解面板（hover ctx-btn 弹出） ═══
var _ctxBreakdownVisible = false;
var _ctxBreakdownTimer = null;
var _ctxBreakdownData = null;

function _ctxBdUnit() {
    if (CTX_MAX_TOKENS <= 100000) return 1000;
    if (CTX_MAX_TOKENS <= 250000) return 2500;
    if (CTX_MAX_TOKENS <= 500000) return 5000;
    if (CTX_MAX_TOKENS <= 1000000) return 10000;
    return 20000;
}

// ★ 读取共享缓存（由 _estimateTokensFull 一次性算出）
function computeCtxBreakdown() {
    if (!_ctxBreakdownData) _estimateTokensFull();
    return _ctxBreakdownData || [];
}

function renderCtxBreakdown() {
    var bd = document.getElementById('ctx-breakdown');
    if (!bd) return;
    if (!_activeAgent || !_activeAgent.conversation) { bd.classList.remove('show'); return; }
    // ★ 强制刷新：绕过缓存，确保面板显示最新数据
    _estimateTokensFull();
    var data = _ctxBreakdownData || computeCtxBreakdown();
    var unit = _ctxBdUnit();
    var rowsEl = bd.querySelector('.ctx-bd-rows');
    var usedEl = bd.querySelector('.ctx-bd-used-num');
    var freeEl = bd.querySelector('.ctx-bd-free-num');
    var totalUsed = 0;
    var html = '';
    for (var i = 0; i < data.length; i++) {
        var d = data[i];
        if (d.key === 'free') continue;
        totalUsed += d.tok;
        var n = Math.max(0, Math.round(d.tok / unit));
        var boxes = '';
        for (var b = 0; b < n && b < 120; b++) boxes += '<span class="ctx-bd-box" style="background:' + d.color + '"></span>';
        var pct = CTX_MAX_TOKENS > 0 ? (d.tok / CTX_MAX_TOKENS * 100) : 0;
        html += '<div class="ctx-bd-row"><span class="ctx-bd-color" style="background:' + d.color + '"></span>' +
            '<span class="ctx-bd-label">' + d.label + '</span>' +
            '<span class="ctx-bd-boxes">' + boxes + '</span>' +
            '<span class="ctx-bd-num">' + (d.tok >= 1000 ? (d.tok / 1000).toFixed(1) + 'k' : d.tok) + '</span>' +
            '<span class="ctx-bd-pct">' + pct.toFixed(1) + '%</span></div>';
    }
    rowsEl.innerHTML = html;
    var freeData = data[data.length - 1];
    usedEl.textContent = totalUsed >= 1000 ? (totalUsed / 1000).toFixed(1) + 'k' : totalUsed;
    freeEl.textContent = freeData.tok >= 1000 ? (freeData.tok / 1000).toFixed(1) + 'k' : freeData.tok;
    var btnRect = $ctxBtn.getBoundingClientRect();
    bd.style.bottom = (window.innerHeight - btnRect.top + 10) + 'px';
    bd.style.right = (window.innerWidth - btnRect.right) + 'px';
}

function showCtxBreakdown() {
    if (!_activeAgent || !_activeAgent.conversation) return;
    clearTimeout(_ctxBreakdownTimer);
    _ctxBreakdownTimer = setTimeout(function () {
        renderCtxBreakdown();
        var bd = document.getElementById('ctx-breakdown');
        if (bd) { bd.classList.add('show'); _ctxBreakdownVisible = true; }
    }, 200);
}

function hideCtxBreakdown() {
    clearTimeout(_ctxBreakdownTimer);
    _ctxBreakdownVisible = false;
    var bd = document.getElementById('ctx-breakdown');
    if (bd) bd.classList.remove('show');
}

// \u2500\u2500 \u4e0a\u4e0b\u6587\u6309\u94ae \u2500\u2500
function updateCtxBtn() {
    if (!_activeAgent || !_activeAgent.conversation) {
        $ctxBtn.textContent = '--';
        $ctxBtn.style.setProperty('--ctx-pct', '0%');
        return;
    }
    var _ag = _activeAgent;
    // ★ 优先用 _lastApiTotalTokens（prompt+completion 精确值，每间 house 更新）
    //   fallback: _lastApiPromptTokens → 本地 chars/3 估算
    var totalTokens = _ag._lastApiTotalTokens || _ag._lastApiPromptTokens || 0;
    var est = estimateTokens();
    var used = totalTokens > 0 ? Math.max(est, totalTokens) : est;
    var pct = Math.min(100, Math.round(used / CTX_MAX_TOKENS * 100));
    $ctxBtn.textContent = Math.round(used / 1000) + ' k';
    $ctxBtn.style.setProperty('--ctx-pct', pct + '%');
    if (_ctxBreakdownVisible) renderCtxBreakdown();
}
$ctxBtn.onclick = function () {
    hideCtxBreakdown();
    document.getElementById('ctx-panel').style.display = 'flex';
};
// ★ hover 显示上下文占用拆解面板
$ctxBtn.addEventListener('mouseenter', function () {
    showCtxBreakdown();
});
$ctxBtn.addEventListener('mouseleave', function () {
    hideCtxBreakdown();
});
// ★ 进入拆解面板自身时不关闭
var _bdPanel = document.getElementById('ctx-breakdown');
if (_bdPanel) {
    _bdPanel.addEventListener('mouseenter', function () {
        clearTimeout(_ctxBreakdownTimer);
    });
    _bdPanel.addEventListener('mouseleave', function () {
        hideCtxBreakdown();
    });
}
document.getElementById('ctx-cancel').onclick = function () {
    document.getElementById('ctx-panel').style.display = 'none';
};
document.getElementById('ctx-compress').onclick = async function () {
    document.getElementById('ctx-panel').style.display = 'none';
    var _ag = _activeAgent;
    if (!_ag) {
        var _noAgentMsg = (typeof _i === 'function') ? _i('ai.error.noActiveAgent', '请先发送一条消息创建对话') : 'Send a message first to create a conversation';
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('⚠️ ' + _noAgentMsg, { type: 'warning', duration: 3000 }); } catch (_) { }
        return;
    }
    // ★ 手动压缩仅限空闲时（AI 不在建楼）。额外检查 isConnected 防残留 DOM
    if (_ag._activeAiDiv && _ag._activeAiDiv._contentWrap && _ag._activeAiDiv.isConnected) {
        var _buildingMsg = (typeof _i === 'function') ? _i('ai.error.buildingFloor', 'AI 正在建楼中，请等待当前楼层完成后再压缩') : 'AI is building a floor, wait for it to finish before compressing';
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('⚠️ ' + _buildingMsg, { type: 'warning', duration: 4000 }); } catch (_) { }
        return;
    }
    if (_ag._compressing) return;
    _ag._compressing = true;
    window._updateSendBtnForCompress(true);
    var _questName = (typeof questActiveId !== 'undefined') ? questActiveId : '?';

    // ★ 专用压缩楼层：上文 = 上一楼层末尾，压缩楼层 = user(原因) + assistant(结果)，下文 = 用户下一轮
    _ag._ctx.totalFloors++;
    var _compressFloorNum = _ag._ctx.totalFloors;
    _ag._floorStartIdx = _ag.conversation.length;  // 本楼层起点
    _ag._floorTiming = { networkMs: 0, aiMs: 0, floorStartPerf: performance.now(), floorStartServerMs: Date.now() + (_ag._serverDrift || 0) };
    _ag._floorId = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ((typeof _panelId !== 'undefined') ? ['_L', '_C', '_R'][_panelId] || '' : '');
    var _now = new Date();
    var _ts = _now.getFullYear() + '-' + String(_now.getMonth() + 1).padStart(2, '0') + '-' + String(_now.getDate()).padStart(2, '0') + ' ' + String(_now.getHours()).padStart(2, '0') + ':' + String(_now.getMinutes()).padStart(2, '0') + ':' + String(_now.getSeconds()).padStart(2, '0');
    var _userMsg = _ts + ' · Compress requested (manual trigger)';
    _ag.conversation.push({ role: 'user', content: _userMsg, _floor: _compressFloorNum });
    _ag._lastUserInput = { text: _userMsg, vision: '' };

    var _compressQoast = null;
    var _compressingText = '🧠 Compressing ' + _questName + '...';
    try { if (window.parent && window.parent.qqqideQoast) _compressQoast = window.parent.qqqideQoast.show(_compressingText, { type: 'info', duration: 0 }); } catch (_) { }
    try {
        var _result = await _ag._compressContext({ trigger: 'manual', detail: _userMsg, force: true });
        if (_compressQoast) { try { _compressQoast.dismiss(); } catch (_) { } _compressQoast = null; }
        // ★ 压缩耗时入 timing（网络=三个API的总网络时间，思考=总时间-网络）
        _ag._floorTiming.networkMs = _result.elapsedMs || 0;
        _ag._floorTiming.aiMs = 0;
        // ★ 结果作为 assistant 消息推入同楼层
        var _assistantMsg = _result.compressed
            ? ('✅ Compress completed\n' + _result.detail)
            : ('ℹ️ ' + (_result.detail || 'No compression needed'));
        _ag.conversation.push({ role: 'assistant', content: _assistantMsg, _floor: _compressFloorNum });
        // ★ 持久化：保存这个压缩楼层
        if (typeof _saveAgentQuestData === 'function') {
            await _saveAgentQuestData(questActiveId, _ag, _compressFloorNum).catch(function () { });
        }
        // ★ 刷新 card-pool 显示压缩楼层楼层
        try { if (typeof cardPool !== 'undefined' && cardPool.refreshCard) { await cardPool.refreshCard(questActiveId); } } catch (_) { }
        if (_result.compressed) {
            try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('✅ Compress done: ' + _result.detail.replace(/\n/g, ' | '), { type: 'info', duration: 5000 }); } catch (_) { }
        } else {
            try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('ℹ️ ' + (_result.detail || 'No compression needed'), { type: 'info', duration: 4000 }); } catch (_) { }
        }
        updateCtxBtn();
    } catch (e) {
        _ag.conversation.push({ role: 'assistant', content: '✗ Compress failed: ' + (e.message || 'unknown'), _floor: _compressFloorNum });
        if (typeof _saveAgentQuestData === 'function') {
            await _saveAgentQuestData(questActiveId, _ag, _compressFloorNum).catch(function () { });
        }
        try { if (typeof cardPool !== 'undefined' && cardPool.refreshCard) { await cardPool.refreshCard(questActiveId); } } catch (_) { }
        if (_compressQoast) { try { _compressQoast.dismiss(); } catch (_) { } _compressQoast = null; }
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('✗ Compress exception: ' + (e.message || 'unknown'), { type: 'error', duration: 8000 }); } catch (_) { }
    } finally {
        if (_compressQoast) { try { _compressQoast.dismiss(); } catch (_) { } }
        _ag._compressing = false;
        window._updateSendBtnForCompress(false);
    }
};
document.querySelector('#ctx-panel .ctx-panel-overlay').onclick = function () {
    document.getElementById('ctx-panel').style.display = 'none';
};
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        var ctxPanel = document.getElementById('ctx-panel');
        if (ctxPanel && ctxPanel.style.display === 'flex') {
            ctxPanel.style.display = 'none';
            e.stopPropagation();
        }
    }
});

// \u2500\u2500 \u5f15\u5bfc\u6309\u94ae\uff1a\u6700\u5feb\u901f\u5ea6\u5c06\u7d27\u6025\u4fe1\u606f\u786c\u585e\u7ed9\u6b63\u5728\u5de5\u4f5c\u7684 AI\uff0c\u4e0d\u4e2d\u65ad\u697c\u5c42 \u2500\u2500
$guideBtn.onclick = async function () {
    // ═══ 铁律：仅建楼中可用（_sending||streaming），闲置时按钮灰色禁用由 updateGuideBtn 控制 ═══
    if (_switching) return;
    if (!(_sending || streaming)) return;

    var text = getInputText().trim();
    if (!text && pendingImages.length === 0) return;

    // ★ 冻结图片副本，立即清空 UI
    var capturedImages = pendingImages.length > 0 ? pendingImages.map(function (img) {
        return { id: img.id, base64: img.base64, dataUrl: img.dataUrl };
    }) : [];
    pendingImages = [];
    renderImageStrip();

    $input.value = '';
    $input._resetUndo();
    $input.focus();

    // ═══ 异步视觉分析 ═══
    var visionText = '';
    if (capturedImages.length > 0) {
        var token = (_activeAgent && _activeAgent._token) || getToken();
        if (token) {
            try {
                var visionResults = await _activeAgent._analyzeImages(capturedImages, token, text);
                if (visionResults && visionResults.length > 0) {
                    var vparts = [];
                    for (var vi = 0; vi < visionResults.length; vi++) {
                        if (visionResults[vi].description) {
                            vparts.push('[\u56fe#' + visionResults[vi].id + ' \u89c6\u89c9\u5206\u6790]:\n' + visionResults[vi].description);
                        }
                    }
                    if (vparts.length > 0) {
                        visionText = '\n\n\u2501\u2501\u2501 GUIDE IMAGE ANALYSIS \u2501\u2501\u2501\n' + vparts.join('\n\n') + '\n\u2501\u2501\u2501 END GUIDE IMAGE ANALYSIS \u2501\u2501\u2501';
                    }
                }
            } catch (_ve) {
                console.warn('[guide-vision]', _ve);
            }
        }
    }

    var hasImages = capturedImages.length > 0;
    var guideText = text + (visionText || '');

    // ══ 注入引导到当前活跃楼层 ══
    var _aiDiv = _activeAgent._activeAiDiv;
    if (_aiDiv && _aiDiv._contentWrap) {
        _aiDiv._buf = '';
        _aiDiv._codeFenceOpen = false;
        _aiDiv._dirty = false;
        _aiDiv._lastParaEl = null;
        _aiDiv._guideMode = true;

        var guideBlock = document.createElement('div');
        guideBlock.className = 'msg-flow-guide-inject';
        var guideHtml = '<div class="msg-flow-guide-hdr"><span class="msg-flow-icon">\u26a1</span> \u5f15\u5bfc\u4fe1\u606f</div><div class="msg-flow-guide-body">' + escHtml(text) + '</div>';
        if (hasImages) {
            guideHtml += '<div style="margin-top:4px;font-size:10px;color:var(--text-secondary);">\ud83d\udcf7 ' + capturedImages.length + ' \u5f20\u56fe\u7247\uff08\u5df2\u5206\u6790\uff09</div>';
        }
        guideBlock.innerHTML = guideHtml;
        _aiDiv._contentWrap.appendChild(guideBlock);

        var marker = document.createElement('div');
        marker.className = 'msg-flow-guide';
        marker.style.cssText = 'opacity:0.6;';
        marker.innerHTML = '<span class="msg-flow-icon">\u23f3</span> \u786e\u8ba4\u4e2d...';
        _aiDiv._contentWrap.appendChild(marker);
        _aiDiv._guideMarker = marker;
    }
    _activeAgent.injectGuide(guideText);

    saveQuestData().catch(function () { });
    updateQueueBtn();
};

// \u2500\u2500 \u6392\u961f\u7cfb\u7edf \u2500\u2500
// ★ _queueFallback / _queuePaused 等已在 panel-state.js 中前向声明
//   Object.defineProperty(window, '_queue', ...) 在 panel-state.js 已定义，此处仅做运行时可覆盖（configurable:true）

function _debounceSaveQueue() {
    if (_queueSaveTimer) clearTimeout(_queueSaveTimer);
    _queueSaveTimer = setTimeout(function () {
        _queueSaveTimer = null;
        saveQuestData().catch(function () { });
    }, 500);
}

function _triggerQueueSend() {
    if (_queueBusy) return;
    var _q = _queue;
    if (!_q || _q.length === 0) { renderQueueStrip(); return; }
    var inputText = ($input.value || '').trim();
    // ★ 永不自停：即使输入框有文字也不暂停，交给用户手动控制
    if (inputText) {
        _queuePaused = false;
    }
    var next = _q.shift();
    renderQueueStrip();
    _debounceSaveQueue();
    // ★ 还原背包：图片 + 等级 + 文本
    pendingImages = (next.images && next.images.length > 0)
        ? next.images.map(function (img) { return { id: img.id, base64: img.base64, dataUrl: img.dataUrl }; })
        : [];
    renderImageStrip();
    if (typeof next.selectedTier === 'number') {
        selectedTier = next.selectedTier;
        updateTierButtons(selectedTier);
    }
    $input.value = next.text || '';
    _queueBusy = true;
    setTimeout(function () { sendMessage(); }, 300);
}

function renderQueueStrip() {
    $queueStrip.innerHTML = '';
    if (_queue.length === 0) { $queueStrip.style.display = 'none'; return; }
    $queueStrip.style.display = 'block';

    // ── 头部：队列计数 + 暂停/清空 ──
    var header = document.createElement('div');
    header.className = 'queue-header';
    var _i = window._i || function (k, f) { return f; };
    var countEl = document.createElement('span');
    countEl.className = 'queue-header-count';
    countEl.textContent = '📬 ' + _i('ai.queue.header', '队列') + ' (' + _queue.length + '/' + QUEUE_MAX + ')';
    header.appendChild(countEl);

    var spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1';
    header.appendChild(spacer);

    var pauseBtn = document.createElement('button');
    pauseBtn.className = 'queue-header-btn';
    pauseBtn.textContent = _queuePaused ? ('▶ ' + _i('ai.queue.resume', '继续')) : ('⏸ ' + _i('ai.queue.pause', '暂停'));
    pauseBtn.title = _queuePaused ? '恢复自动发送' : '暂停自动发送';
    pauseBtn.onclick = function (e) {
        e.stopPropagation();
        _queuePaused = !_queuePaused;
        renderQueueStrip();
        if (!_queuePaused && _queue.length > 0 && !streaming && !_sending) {
            _triggerQueueSend();
        }
    };
    header.appendChild(pauseBtn);

    var clearBtn = document.createElement('button');
    clearBtn.className = 'queue-header-btn';
    clearBtn.textContent = _i('ai.queue.clear', '清空');
    clearBtn.title = '清空所有排队消息';
    clearBtn.onclick = function (e) {
        e.stopPropagation();
        _queue.length = 0;
        renderQueueStrip();
        _debounceSaveQueue();
    };
    header.appendChild(clearBtn);
    $queueStrip.appendChild(header);

    // ── 背包卡片 ──
    for (var i = 0; i < _queue.length; i++) {
        (function (q, idx) {
            var images = q.images || q.pendingImages || [];
            var preview = q.text.slice(0, 80) + (q.text.length > 80 ? '...' : '');
            var tierLabel = (typeof q.selectedTier === 'number') ? ('A' + q.selectedTier) : '';

            var card = document.createElement('div');
            card.className = 'bk-card';

            // ── 行1：等级徽章 + 文本预览 + 图片计数 ──
            var row1 = document.createElement('div');
            row1.className = 'bk-row1';
            if (tierLabel) {
                var tierBadge = document.createElement('span');
                tierBadge.className = 'bk-tier';
                tierBadge.textContent = tierLabel;
                row1.appendChild(tierBadge);
            }
            var textSpan = document.createElement('span');
            textSpan.className = 'bk-text';
            textSpan.textContent = preview;
            row1.appendChild(textSpan);
            if (images.length > 0) {
                var imgCount = document.createElement('span');
                imgCount.className = 'bk-img-count';
                imgCount.textContent = '📷' + images.length;
                row1.appendChild(imgCount);
            }
            card.appendChild(row1);

            // ── 行2：图片缩略图（背包专有图片集）──
            if (images.length > 0) {
                var row2 = document.createElement('div');
                row2.className = 'bk-row2';
                for (var imi = 0; imi < images.length; imi++) {
                    var thumb = document.createElement('img');
                    thumb.className = 'bk-thumb';
                    thumb.src = images[imi].dataUrl || '';
                    thumb.title = '图片 #' + (images[imi].id || (imi + 1));
                    row2.appendChild(thumb);
                }
                card.appendChild(row2);
            }

            // ── 点击展开编辑 ──
            card.title = (typeof _i === 'function') ? _i('ai.queue.editTitle', '点击编辑或删除') : '点击编辑或删除';
            card.onclick = function () {
                if (card.classList.contains('bk-expanded')) return;
                card.classList.add('bk-expanded');
                var _i2 = window._i || function (k, f) { return f; };
                // 保留 row1/row2，追加编辑区
                var editArea = document.createElement('div');
                editArea.className = 'bk-edit';
                var ta = document.createElement('textarea');
                ta.className = 'bk-ta';
                ta.value = q.text;
                ta.spellcheck = false;
                ta.setAttribute('spellcheck', 'false');
                ta.setAttribute('autocomplete', 'off');
                ta.setAttribute('autocorrect', 'off');
                ta.setAttribute('autocapitalize', 'off');
                // ★ 逐字 ctrl+z 回退
                if (window.qqqCharUndo && typeof window.qqqCharUndo.attach === 'function') {
                    window.qqqCharUndo.attach(ta);
                }
                // ★ 自动扩展（与主编辑框同原理）
                var _taLineH = 0;
                var _taMaxH = 222;
                function _taAutoResize() {
                    if (!_taLineH) _taLineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
                    if (!ta.value) { ta.style.height = ''; ta.style.overflowY = 'hidden'; return; }
                    ta.style.height = 'auto';
                    var sh = ta.scrollHeight;
                    var newH = sh + _taLineH;
                    if (newH >= _taMaxH) { ta.style.height = _taMaxH + 'px'; ta.style.overflowY = 'auto'; }
                    else { ta.style.height = newH + 'px'; ta.style.overflowY = 'hidden'; }
                }
                ta.addEventListener('input', function () {
                    _taAutoResize();
                    // ★ 实时回写：确保切换 quest 时编辑不丢
                    q.text = ta.value;
                });
                // ★ 失焦也回写一次（兜底）
                ta.addEventListener('blur', function () {
                    q.text = ta.value;
                    _debounceSaveQueue();
                });
                setTimeout(_taAutoResize, 0);
                editArea.appendChild(ta);
                var actions = document.createElement('div');
                actions.className = 'bk-actions';

                var modBtn = document.createElement('button');
                modBtn.textContent = _i2('ai.queue.save', '保存');
                modBtn.onclick = function (e) {
                    e.stopPropagation();
                    q.text = ta.value;
                    renderQueueStrip();
                    _debounceSaveQueue();
                };
                var cancelBtn = document.createElement('button');
                cancelBtn.textContent = _i2('ai.queue.cancel', '取消');
                cancelBtn.onclick = function (e) {
                    e.stopPropagation();
                    renderQueueStrip();
                };
                var delBtn = document.createElement('button');
                delBtn.textContent = _i2('ai.queue.delete', '删除');
                delBtn.onclick = function (e) {
                    e.stopPropagation();
                    _queue.splice(idx, 1);
                    renderQueueStrip();
                    _debounceSaveQueue();
                };
                actions.appendChild(modBtn);
                actions.appendChild(cancelBtn);
                actions.appendChild(delBtn);
                editArea.appendChild(actions);
                card.appendChild(editArea);
            };
            $queueStrip.appendChild(card);
        })(_queue[i], i);
    }
}

$queueBtn.onclick = function () {
    if (_switching) return;
    if (!_activeAgent) {
        var _noAgentMsg = (typeof _i === 'function') ? _i('ai.error.noActiveAgent', '请先发送一条消息创建对话') : '请先发送一条消息创建对话';
        addMessageEl('error', _noAgentMsg);
        return;
    }
    if (_queue.length >= QUEUE_MAX) {
        var _fullMsg = (typeof _i === 'function') ? _i('ai.queue.full', '队列限宽3，请等待上一条消息发出。') : '队列限宽3，请等待上一条消息发出。';
        addMessageEl('error', _fullMsg);
        return;
    }
    var text = getInputText().trim();
    if (!text) return;
    // ★ 背包：冻结当前全部输入状态
    var backpack = {
        id: 'bk_' + Date.now(),
        text: text,
        images: pendingImages.length > 0 ? pendingImages.map(function (img) { return { id: img.id, base64: img.base64, dataUrl: img.dataUrl }; }) : [],
        selectedTier: selectedTier,
        ts: Date.now()
    };
    _queue.push(backpack);
    renderQueueStrip();
    $input.value = '';
    $input._resetUndo();
    pendingImages = [];
    renderImageStrip();
    $input.focus();
    _debounceSaveQueue();
};

// ═══ qh 滚动条 — AI 面板聊天区（按标准文档接入）═══
(function () {
    var host = document.getElementById('messages-wrap');
    var el = document.getElementById('messages');
    if (!host || !el) return;

    // ★ 冒泡粒子动画（焦点水箱）
    var _bubbleStyle = document.createElement('style');
    _bubbleStyle.textContent =
        '@keyframes qh-bubble-rise { 0%{transform:translateY(0);opacity:0.8} 80%{opacity:0.3} 100%{transform:translateY(-100vh);opacity:0} }' +
        '.qh-bubble-dot { position:absolute; border-radius:50%; pointer-events:none; ' +
        'animation:qh-bubble-rise linear infinite; }';
    document.head.appendChild(_bubbleStyle);

    function _qhColors() {
        var dk = document.documentElement.getAttribute('data-theme') === 'dark';
        var focused = document.body.classList.contains('panel-focused');
        return {
            // 滑块色：始终 q3 标准色
            c: dk ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)',
            // 水箱：A 配色（灰黄橄榄）— 上浅下深；非焦点=透明
            trackBg: focused
                ? (dk
                    ? 'linear-gradient(to bottom, rgba(95,105,45,0.12), rgba(145,155,80,0.45))'
                    : 'linear-gradient(to bottom, rgba(75,85,30,0.15), rgba(115,125,60,0.5))')
                : 'transparent',
            // 粒子：白主题=干草黄，黑主题=暖灰绿
            bubbleC: dk ? 'rgba(180,190,80,0.8)' : '#ffffff'
        };
    }

    // 滑轨（水箱）
    var track = document.createElement('div');
    var co0 = _qhColors();
    track.style.cssText = 'position:absolute; right:-1px; top:0; bottom:0; width:9px; z-index:50; ' +
        'background:' + co0.trackBg + '; overflow:hidden;';

    // ★ 冒泡粒子：18 个小圆点，随机大小/位置/速度，从下往上冒
    // A 配色（灰黄橄榄）上浅下深：trackBg = 白 rgba(75,85,30,0.15)→(115,125,60,0.5) / 黑 rgba(95,105,45,0.12)→(145,155,80,0.45)  bubbleC = 白 rgba(160,170,70,0.7) / 黑 rgba(180,190,80,0.8)
    var _bubbles = [];
    for (var bi = 0; bi < 18; bi++) {
        var dot = document.createElement('div');
        dot.className = 'qh-bubble-dot';
        var size = 1.5 + Math.random() * 3.5;  // 1.5~5px
        var left = 0.5 + Math.random() * 6.5;  // 0.5~7px（9px 宽轨道内）
        var dur = 2 + Math.random() * 4.5;     // 2~6.5s 一个周期
        var delay = Math.random() * 6;          // 0~6s 初相位
        var op = 0.45 + Math.random() * 0.55;  // 0.45~1.0 随机不透明
        dot.style.cssText =
            'width:' + size + 'px; height:' + size + 'px; ' +
            'left:' + left + 'px; bottom:0; ' +
            'background:' + _qhColors().bubbleC + '; opacity:' + op.toFixed(2) + '; ' +
            'animation-duration:' + dur + 's; ' +
            'animation-delay:' + delay + 's; ' +
            'display:none;';
        track.appendChild(dot);
        _bubbles.push(dot);
    }
    function _setBubbles(on) {
        for (var i = 0; i < _bubbles.length; i++) {
            _bubbles[i].style.display = on ? '' : 'none';
            if (on) {
                // 随机微调再次触发动画（改变 animation-delay 立即生效）
                _bubbles[i].style.animationDelay = (Math.random() * 5) + 's';
            }
        }
    }
    // 初始状态
    if (document.body.classList.contains('panel-focused')) _setBubbles(true);

    // 滑块（独立渲染，贴合水箱左侧，与水箱零交合）
    var thumb = document.createElement('div');
    var co = _qhColors();
    thumb.style.cssText = 'position:absolute; right:8px; width:2px; min-height:24px; border-radius:0; z-index:52; ' +
        'display:none; background:' + co.c + '; cursor:pointer; ' +
        'transition: width 0.1s ease, right 0.1s ease, background 0.1s ease;';

    // hover 展开：填满水箱 + 左侧多出1px
    track.addEventListener('mouseenter', function () {
        thumb.style.width = '10px'; thumb.style.right = '-1px';
        thumb.style.background = _qhColors().c;
    });
    track.addEventListener('mouseleave', function () {
        thumb.style.width = '2px'; thumb.style.right = '8px';
        thumb.style.background = _qhColors().c;
    });

    // 同步
    function sync() {
        var sh = el.scrollHeight, ch = el.clientHeight;
        if (sh <= ch) { thumb.style.display = 'none'; return; }
        thumb.style.display = '';
        var thumbH = Math.max(24, (ch / sh) * ch);
        var maxTop = ch - thumbH;
        thumb.style.height = thumbH + 'px';
        thumb.style.top = ((el.scrollTop / (sh - ch)) * maxTop) + 'px';
    }
    el.addEventListener('scroll', sync);

    // 滑轨点击跳转
    track.addEventListener('mousedown', function (e) {
        if (e.target === thumb || e.button !== 0) return;
        var sh = el.scrollHeight, ch = el.clientHeight;
        if (sh <= ch) return;
        var ratio = (e.clientY - track.getBoundingClientRect().top) / ch;
        el.scrollTop = Math.max(0, Math.min(sh - ch, Math.round(ratio * (sh - ch))));
        e.preventDefault();
    });

    // 拖拽
    var dragging = false, dragY = 0, dragS = 0;
    thumb.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        dragging = true; dragY = e.clientY; dragS = el.scrollTop;
        e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var sh = el.scrollHeight, ch = el.clientHeight;
        if (sh <= ch) return;
        var thumbH = Math.max(24, (ch / sh) * ch);
        var ratio = (e.clientY - dragY) / (ch - thumbH);
        el.scrollTop = Math.max(0, Math.min(sh - ch, dragS + ratio * (sh - ch)));
    });
    document.addEventListener('mouseup', function () { dragging = false; });

    // 初始 + 内容变化
    setTimeout(sync, 50);
    var obs = new MutationObserver(function () { setTimeout(sync, 30); });
    obs.observe(el, { childList: true, subtree: true });

    // 主题切换 → 立即刷滑块色 + 滑轨底色 + 粒子色
    var themeObs = new MutationObserver(function () {
        var co2 = _qhColors();
        track.style.background = co2.trackBg;
        thumb.style.background = co2.c;
        for (var i = 0; i < _bubbles.length; i++) {
            _bubbles[i].style.background = co2.bubbleC;
        }
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // 焦点切换 → 水箱显隐 + 粒子显隐
    var focusObs = new MutationObserver(function () {
        var on = document.body.classList.contains('panel-focused');
        track.style.background = _qhColors().trackBg;
        _setBubbles(on);
    });
    focusObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // 初始焦点状态
    if (document.body.classList.contains('panel-focused')) _setBubbles(true);

    host.appendChild(track);
    host.appendChild(thumb);
})();