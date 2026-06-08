'use strict';
// \u2550\u2550\u2550 panel-quest-ui.js \u2550\u2550\u2550
// Quest UI: switchQuest, CRUD, cost/balance, ctx button, guide button, queue system

async function switchQuest(id) {
    if (id === questActiveId) return;
    if (_switching) return;
    _switching = true;
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
        var owner = await questStore.getOwner(id);
        if (!owner) {
            owner = await _broadcastOwnerCheck(id);
        }
        if (owner && owner.windowId !== _windowId) {
            _setPanelFocus(false);
            _broadcast('focus-request', id, { targetWindow: owner.windowId });
            var ownerPanelId = parseInt(owner.windowId.split('_p')[1]);
            if (ownerPanelId === 0 || ownerPanelId === 2) {
                try { parent.postMessage({ type: 'qqq-open-wing', panel: ownerPanelId }, '*'); } catch (_) { }
            }
            try {
                if (parent && parent.qqqideQoast) parent.qqqideQoast.show(
                    '\ud83d\udccc \u8be5 Quest \u5df2\u5728' + (ownerPanelId === 0 ? '\u5de6' : '\u53f3') + '\u9762\u677f\u6253\u5f00\uff0c\u5df2\u81ea\u52a8\u8df3\u8f6c',
                    { type: 'info', duration: 3000 }
                );
            } catch (_) { }
            _switching = false;
            return;
        }
        if (!owner) {
            var claimResult = await questStore.claimOwner(id, _windowId);
            if (claimResult.claimed) {
                _parentClaimQuest(id);
                _broadcast('owner-claimed', id);
            } else if (claimResult.currentOwner && claimResult.currentOwner !== _windowId) {
                _setPanelFocus(false);
                _broadcast('focus-request', id, { targetWindow: claimResult.currentOwner });
                _switching = false;
                return;
            }
        }

        // \u2550\u2550\u2550 \u4fdd\u5b58\u65e7 quest UI \u72b6\u6001 + \u91ca\u653e\u6240\u6709\u6743 \u2550\u2550\u2550
        if (questActiveId) {
            saveQuestUIState(questActiveId);
            _stopAutoSave();
            if (_activeAgent) {
                await _saveAgentQuestData(questActiveId, _activeAgent, _activeAgent._floorStartIdx);
            }
            if (!_isDraft(questActiveId)) {
                _parentReleaseQuest(questActiveId);
                try { await questStore.releaseOwner(questActiveId, _windowId); } catch (_) { }
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
            onlyStore.set('ai.window.' + _windowId + '.activeQuestId', id);
            if (_panelId === 1) onlyStore.set('ai.activeQuestId', id);
        }

        // \u2550\u2550\u2550 \u4ea4\u6362 active agent \u2550\u2550\u2550
        _activeAgent = _getOrCreateAgent(id);

        // \u2550\u2550\u2550 \u6062\u590d agent \u72b6\u6001\uff08conversation + metadata\uff09 \u2550\u2550\u2550
        await _restoreAgentFromStore(id, _activeAgent);

        var card = cardPool.getCard(id);
        if (card && card.buildingFloor !== null) {
            var bDOM = card.floorDOM[card.buildingFloor];
            if (bDOM && bDOM.aiEl) {
                _activeAgent._activeAiDiv = bDOM.aiEl;
            }
        }
        _allTxtPath = _activeAgent._currentAllTxtPath || _activeAgent._allTxtPath || '';

        restoreQuestUIState(id);
        renderQueueStrip();
        updateCostDisplay();
        updateCtxBtn();
        await renderTabs();
        _scrollToBottomDeferred(true);
    } finally { _switching = false; }
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
async function _ensureQuestDir(root, qName, fName) {
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge || !bridge.fs) return;
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

async function createNewQuest() {
    if (streaming) stopStream();
    saveQuestUIState(questActiveId);
    if (!_isDraft(questActiveId)) await saveQuestData();
    if (questActiveId && !_isDraft(questActiveId)) {
        _parentReleaseQuest(questActiveId);
        try { await questStore.releaseOwner(questActiveId, _windowId); } catch (_) { }
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
    selectedTier = 6;
    updateTierButtons(6);
    renderImageStrip();
    _activeAgent = null;
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
    try { await questStore.releaseOwner(id, _windowId); } catch (_) { }
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
        await questStore.claimOwner(questActiveId, _windowId);
        _parentClaimQuest(questActiveId);
        _broadcast('owner-claimed', questActiveId);
    }
    // 删除非活跃 quest → 保持当前视图不变，仅刷新下拉
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
    fetch('https://gh555.com/api/wallet/balance', {
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
var CTX_MAX_TOKENS = 1000000;
var _estCache = { val: 0, convLen: -1, ctxHash: '' };
function estimateTokens() {
    if (!_activeAgent) return 0;
    var conv = agent.conversation;
    var ctx = agent._ctx;
    var ctxHash = ctx ? (ctx.totalFloors + '|' + (ctx.facts ? ctx.facts.length : 0) + '|' + (ctx.floorSummaries ? ctx.floorSummaries.length : 0)) : '';
    if (_estCache.convLen === conv.length && _estCache.ctxHash === ctxHash && _estCache.val > 0) {
        return _estCache.val;
    }
    var total = 0;
    var CHAR_PER_TOKEN = 3.0;
    for (var i = 0; i < conv.length; i++) {
        var c = conv[i].content;
        if (typeof c === 'string') total += c.length / CHAR_PER_TOKEN;
        if (conv[i].tool_calls && Array.isArray(conv[i].tool_calls)) {
            try { total += JSON.stringify(conv[i].tool_calls).length / CHAR_PER_TOKEN; } catch (_) { }
        }
        total += 10;
    }
    if (typeof SYSTEM_PROMPT !== 'undefined') total += SYSTEM_PROMPT.length / CHAR_PER_TOKEN;
    if (typeof TOOL_DEFINITIONS !== 'undefined') {
        try { total += JSON.stringify(TOOL_DEFINITIONS).length / CHAR_PER_TOKEN; } catch (_) { }
    }
    if (ctx) {
        var dynText = '';
        if (ctx.narrative) {
            dynText += '[DYNAMIC CONTEXT]\nCONVERSATION CONTEXT (compressed history):\n' + ctx.narrative;
        }
        if (ctx.facts && ctx.facts.length > 0) {
            var facts = ctx.facts.slice(-10);
            dynText += '\n\nRELEVANT FACTS FROM EARLIER (' + facts.length + '/' + ctx.facts.length + ' total):\n';
            for (var fi = 0; fi < facts.length; fi++) {
                dynText += '- [' + (facts[fi].type || '') + '] ' + (facts[fi].content || '') + '\n';
            }
        }
        if (ctx.floorSummaries && ctx.floorSummaries.length > 0) {
            var summaries = ctx.floorSummaries.slice(-15);
            dynText += '\n\nFLOOR CHECKPOINTS:\n';
            for (var si = 0; si < summaries.length; si++) {
                dynText += '\ud83d\udccc ' + (summaries[si].summary || '') + '\n';
            }
        }
        if (ctx.treasures && ctx.treasures.length > 0) {
            var treasures = ctx.treasures.slice(-10);
            dynText += '\n\nKEY DISCOVERIES:\n';
            for (var ti = 0; ti < treasures.length; ti++) {
                dynText += '\ud83d\udc8e ' + (treasures[ti].content || '') + '\n';
            }
        }
        total += dynText.length / CHAR_PER_TOKEN;
    }
    var result = Math.round(total);
    _estCache = { val: result, convLen: conv.length, ctxHash: ctxHash };
    return result;
}

// \u2500\u2500 \u4e0a\u4e0b\u6587\u6309\u94ae \u2500\u2500
function updateCtxBtn() {
    if (!_activeAgent || !_activeAgent.conversation) {
        $ctxBtn.textContent = '--';
        $ctxBtn.style.setProperty('--ctx-pct', '0%');
        return;
    }
    var used = agent._lastApiPromptTokens || estimateTokens();
    var pct = Math.min(100, Math.round(used / CTX_MAX_TOKENS * 100));
    $ctxBtn.textContent = Math.round(used / 1000) + 'k';
    $ctxBtn.style.setProperty('--ctx-pct', pct + '%');
}
$ctxBtn.onclick = function () {
    document.getElementById('ctx-panel').style.display = 'flex';
};
document.getElementById('ctx-cancel').onclick = function () {
    document.getElementById('ctx-panel').style.display = 'none';
};
document.getElementById('ctx-compress').onclick = async function () {
    document.getElementById('ctx-panel').style.display = 'none';
    var msg = addMessageEl('status', '\u6b63\u5728\u538b\u7f29\u4e0a\u4e0b\u6587...');
    try {
        await agent._compressContext();
        msg.textContent = '\u4e0a\u4e0b\u6587\u538b\u7f29\u5b8c\u6210';
        updateCtxBtn();
    } catch (e) {
        msg.textContent = '\u538b\u7f29\u5931\u8d25: ' + (e.message || e);
        msg.className = 'msg msg-error';
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
$guideBtn.onclick = function () {
    if (!_activeAgent) {
        addMessageEl('error', '\u8bf7\u5148\u53d1\u9001\u4e00\u6761\u6d88\u606f\u521b\u5efa\u5bf9\u8bdd');
        return;
    }
    if (_activeAgent._compressing) return;
    var text = getInputText().trim();
    if (!text) return;
    $input.value = '';
    $input._resetUndo();
    $input.focus();

    if (_sending || streaming) {
        // AI \u6b63\u5728\u5de5\u4f5c\u4e2d \u2192 \u7acb\u5373\u6ce8\u5165 + abort \u5f53\u524d house
        var _aiDiv = _activeAgent._activeAiDiv;
        if (_aiDiv && _aiDiv._contentWrap) {
            if (_aiDiv._buf && _aiDiv._buf.trim()) {
                var _cleanBuf = _aiDiv._buf
                    .replace(/<invoke\s[\s\S]*?<\/invoke>/g, '')
                    .replace(/<parameter\s[^>]*\/>/g, '')
                    .replace(/<\/?_tool_calls>/g, '')
                    .replace(/<\/?qqq_tool_calls>/g, '');
                if (_cleanBuf.trim()) {
                    var _stashPara = document.createElement('div');
                    _stashPara.className = 'stream-para';
                    _stashPara.innerHTML = renderMarkdown(_cleanBuf);
                    _aiDiv._contentWrap.appendChild(_stashPara);
                }
            }
            var _existingParas = _aiDiv._contentWrap.querySelectorAll('.stream-para');
            for (var _ep = 0; _ep < _existingParas.length; _ep++) {
                var _epEl = _existingParas[_ep];
                if (_epEl.innerHTML) {
                    _epEl.innerHTML = _epEl.innerHTML
                        .replace(/&lt;invoke\s[\s\S]*?&lt;\/invoke&gt;/g, '')
                        .replace(/&lt;parameter\s[^&]*\/&gt;/g, '')
                        .replace(/&lt;\/?_tool_calls&gt;/g, '')
                        .replace(/&lt;\/?qqq_tool_calls&gt;/g, '');
                }
                _epEl.classList.remove('stream-para');
                _epEl.classList.add('stream-para-keep');
            }
            _aiDiv._buf = '';
            _aiDiv._fullText = '';
            _aiDiv._paras = [];
            _aiDiv._dirty = false;
            _aiDiv._renderedCount = 0;
            if (_aiDiv._lastParaEl) { _aiDiv._lastParaEl.remove(); _aiDiv._lastParaEl = null; }
            _aiDiv._guideMode = true;
            var guideBlock = document.createElement('div');
            guideBlock.className = 'msg-guide-ack';
            guideBlock.style.cssText = 'margin:8px 0;padding:8px 12px;background:rgba(255,107,0,0.08);border-left:3px solid #ff6b00;border-radius:4px;';
            guideBlock.innerHTML = '<div style="font-size:11px;font-weight:700;color:#ff6b00;margin-bottom:4px;">\u26a1 \u5f15\u5bfc\u4fe1\u606f</div><div style="font-size:13px;">' + escHtml(text) + '</div>';
            _aiDiv._contentWrap.appendChild(guideBlock);
            var marker = document.createElement('div');
            marker.className = 'msg-status guide-marker';
            marker.style.cssText = 'color:var(--blue);font-weight:600;padding:8px 0;';
            marker.textContent = '\u26a1 \u8bf7\u7b49\u5f85 AI \u786e\u8ba4\u5f15\u5bfc...';
            _aiDiv._contentWrap.appendChild(marker);
        }
        agent.injectGuide(text);
    } else {
        // AI \u6ca1\u5728\u5de5\u4f5c \u2192 \u964d\u7ea7\u4e3a\u666e\u901a inject
        agent.inject('[GUIDE] ' + text);
        var statusEl2 = document.createElement('div');
        statusEl2.className = 'msg msg-status guide-status';
        statusEl2.textContent = '\ud83d\udccc \u5f15\u5bfc\u5df2\u6ce8\u5165 \u00b7 AI \u4e0b\u6b21\u56de\u590d\u53ef\u89c1';
        $messages.appendChild(statusEl2);
        scrollToBottom(true);
    }
    saveQuestData().catch(function () { });
    updateQueueBtn();
};

// \u2500\u2500 \u6392\u961f\u7cfb\u7edf \u2500\u2500
var _queueFallback = [];
var _queuePaused = false;
var _queueBusy = false;
var _queueSaveTimer = null;
var QUEUE_MAX = 50;
Object.defineProperty(window, '_queue', {
    get: function () { return _activeAgent ? _activeAgent._queue : _queueFallback; },
    set: function (v) { if (_activeAgent) _activeAgent._queue = v; else _queueFallback = v; },
    enumerable: true, configurable: true
});

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
    if (inputText) {
        _queuePaused = true;
        renderQueueStrip();
        return;
    }
    var _totalBefore = _q.length;
    var next = _q.shift();
    var _remaining = _q.length;
    renderQueueStrip();
    _debounceSaveQueue();
    pendingImages = (next.pendingImages && next.pendingImages.length > 0)
        ? next.pendingImages.map(function (img) { return { id: img.id, base64: img.base64, dataUrl: img.dataUrl }; })
        : [];
    renderImageStrip();
    $input.value = next.text || next.html || '';
    var _qStatus = document.createElement('div');
    _qStatus.className = 'msg msg-status';
    _qStatus.id = 'queue-sending-status';
    _qStatus.style.color = 'var(--blue)';
    _qStatus.textContent = '\ud83d\udcee \u6392\u961f\u53d1\u9001\u4e2d (' + (_remaining + 1) + '/' + _totalBefore + ')';
    $messages.appendChild(_qStatus);
    scrollToBottom(true);
    _queueBusy = true;
    setTimeout(function () { sendMessage(); }, 300);
}

function renderQueueStrip() {
    $queueStrip.innerHTML = '';
    if (_queue.length === 0) { $queueStrip.style.display = 'none'; return; }
    $queueStrip.style.display = 'block';

    var header = document.createElement('div');
    header.className = 'queue-header';
    var countEl = document.createElement('span');
    countEl.className = 'queue-header-count';
    countEl.textContent = '\ud83d\udcee \u961f\u5217 (' + _queue.length + ')';
    header.appendChild(countEl);

    var spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1';
    header.appendChild(spacer);

    var pauseBtn = document.createElement('button');
    pauseBtn.className = 'queue-header-btn';
    pauseBtn.textContent = _queuePaused ? '\u25b6 \u7ee7\u7eed' : '\u23f8 \u6682\u505c';
    pauseBtn.title = _queuePaused ? '\u6062\u590d\u81ea\u52a8\u53d1\u9001' : '\u6682\u505c\u81ea\u52a8\u53d1\u9001';
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
    clearBtn.textContent = '\ud83d\uddd1 \u6e05\u7a7a';
    clearBtn.title = '\u6e05\u7a7a\u6240\u6709\u6392\u961f\u6d88\u606f';
    clearBtn.onclick = function (e) {
        e.stopPropagation();
        _queue.length = 0;
        renderQueueStrip();
        _debounceSaveQueue();
    };
    header.appendChild(clearBtn);
    $queueStrip.appendChild(header);

    for (var i = 0; i < _queue.length; i++) {
        (function (q, idx) {
            var card = document.createElement('div');
            card.className = 'queue-card';
            var preview = q.text.slice(0, 80) + (q.text.length > 80 ? '...' : '');
            var badgesHtml = '';
            var imgCount = (q.pendingImages && q.pendingImages.length) || 0;
            var fileCount = 0;
            if (q.html) {
                var tmpDiv = document.createElement('div');
                tmpDiv.innerHTML = q.html;
                fileCount = tmpDiv.querySelectorAll('.file-chip').length;
                tmpDiv = null;
            }
            if (imgCount > 0) badgesHtml += '<span class="qcard-badge">\ud83d\udcf7' + imgCount + '</span>';
            if (fileCount > 0) badgesHtml += '<span class="qcard-badge">\ud83d\udcce' + fileCount + '</span>';
            card.innerHTML = '<span>' + (idx + 1) + '. ' + escHtml(preview) + '</span>' + (badgesHtml ? '<span class="qcard-badges">' + badgesHtml + '</span>' : '');
            card.title = '\u70b9\u51fb\u7f16\u8f91\u6216\u5220\u9664';
            card.onclick = function () {
                if (card.classList.contains('queue-card-expanded')) return;
                card.classList.add('queue-card-expanded');
                var attachmentInfo = '';
                var _imgCount = (q.pendingImages && q.pendingImages.length) || 0;
                var _fileCount = 0;
                if (q.html) {
                    var tmpDiv2 = document.createElement('div');
                    tmpDiv2.innerHTML = q.html;
                    _fileCount = tmpDiv2.querySelectorAll('.file-chip').length;
                    tmpDiv2 = null;
                }
                if (_imgCount > 0 || _fileCount > 0) {
                    attachmentInfo = '<div style="font-size:10px;color:var(--base01);margin-bottom:4px">\ud83d\udcce \u9644\u4ef6\uff1a' +
                        (_imgCount > 0 ? ' \ud83d\udcf7\u00d7' + _imgCount : '') +
                        (_fileCount > 0 ? ' \ud83d\udcc4\u00d7' + _fileCount : '') + '</div>';
                }
                card.innerHTML = attachmentInfo;
                var ta = document.createElement('textarea');
                ta.value = q.text;
                card.appendChild(ta);
                var actions = document.createElement('div');
                actions.className = 'qcard-actions';

                var modBtn = document.createElement('button');
                modBtn.textContent = '\u4fdd\u5b58';
                modBtn.onclick = function (e) {
                    e.stopPropagation();
                    q.text = ta.value;
                    q.html = ta.value;
                    renderQueueStrip();
                    _debounceSaveQueue();
                };

                var delBtn = document.createElement('button');
                delBtn.textContent = '\u5220\u9664';
                delBtn.onclick = function (e) {
                    e.stopPropagation();
                    _queue.splice(idx, 1);
                    renderQueueStrip();
                    _debounceSaveQueue();
                };

                var cancelBtn = document.createElement('button');
                cancelBtn.textContent = '\u53d6\u6d88';
                cancelBtn.onclick = function (e) {
                    e.stopPropagation();
                    renderQueueStrip();
                };

                actions.appendChild(modBtn);
                actions.appendChild(delBtn);
                actions.appendChild(cancelBtn);
                card.appendChild(actions);
            };
            $queueStrip.appendChild(card);
        })(_queue[i], i);
    }

    var footer = document.createElement('div');
    footer.className = 'queue-footer';
    if (_queuePaused) {
        footer.textContent = '\u23f8 \u5df2\u6682\u505c \u00b7 \u961f\u5217\u4e2d ' + _queue.length + ' \u6761\u6d88\u606f\u7b49\u5f85\u624b\u52a8\u53d1\u9001';
    } else if (_sending || streaming) {
        footer.textContent = '\u23f3 AI \u56de\u590d\u5b8c\u6210\u540e\u81ea\u52a8\u53d1\u9001\u4e0b\u4e00\u6761';
    } else {
        footer.textContent = '\ud83d\udce4 \u4e0b\u4e00\u6761\uff1a' + _queue[0].text.slice(0, 60) + (_queue[0].text.length > 60 ? '...' : '');
    }
    $queueStrip.appendChild(footer);
}

$queueBtn.onclick = function () {
    if (!_activeAgent) {
        addMessageEl('error', '\u8bf7\u5148\u53d1\u9001\u4e00\u6761\u6d88\u606f\u521b\u5efa\u5bf9\u8bdd');
        return;
    }
    if (_queue.length >= QUEUE_MAX) {
        addMessageEl('error', '\u961f\u5217\u5df2\u6ee1\uff08\u6700\u591a ' + QUEUE_MAX + ' \u6761\uff09');
        return;
    }
    var text = getInputText().trim();
    if (!text) return;
    var imgSnapshot = pendingImages.length > 0 ? pendingImages.map(function (img) { return { id: img.id, base64: img.base64, dataUrl: img.dataUrl }; }) : null;
    _queue.push({ id: 'q_' + Date.now(), text: text, ts: Date.now(), pendingImages: imgSnapshot });
    renderQueueStrip();
    $input.value = '';
    $input._resetUndo();
    $input.focus();
    _debounceSaveQueue();
};
