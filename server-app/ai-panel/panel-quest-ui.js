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
                await _saveAgentQuestData(questActiveId, _activeAgent, _activeAgent._floorStartIdx);
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
                var _floorNums = Object.keys(card.floorDOM || {}).map(Number).sort(function(a,b){return b-a;});
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
                        break;
                    }
                }
            }
        }

        // ★ 切换到 quest 时修复磁盘目录名（惰性修正）
        var _qEntry = (await questStore.list()).find(function (s) { return s.id === id; });
        if (_qEntry && typeof _tryRepairQuestDirName === 'function') {
            _tryRepairQuestDirName(questStore.getProjectRoot(), id, _qEntry.numericId, _qEntry.title)
                .catch(function (e) { console.warn('[quest-dir] switch repair failed:', id, e); });
        }
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

// ── 解析 quest 目录名：只按 q{n}. 前缀匹配已有目录，不依赖完整标题 ──
// 多目录时挑第一个，找不到才从标题构造（仅限新 quest 首次创建）
// 若已有目录名与 DB 标题不一致，立即尝试修复（await），防 TOCTOU 分裂
async function _resolveQuestDirName(root, questId, numericId, title) {
    var existing = await _findQuestDirByPrefix(root, questId);
    if (existing) {
        var expectedName = _makeName('q', numericId, title);
        if (existing !== expectedName) {
            // 立即修复，传已知名省一次 list
            await _tryRepairQuestDirName(root, questId, numericId, title, existing);
            var afterRepair = await _findQuestDirByPrefix(root, questId);
            if (afterRepair) return afterRepair;
        }
        return existing;
    }
    return _makeName('q', numericId, title);
}

// ── 修复：磁盘目录名与 DB 不一致时 rename，失败打日志不阻塞 ──
// _knownName: 调用方已知的当前目录名（省一次 list），可选；不传则自行查找
async function _tryRepairQuestDirName(root, questId, numericId, dbTitle, _knownName) {
    if (!dbTitle) return;
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge || !bridge.fs) { console.warn('[quest-dir] bridge.fs unavailable, skip repair for', questId); return; }
    var questsDir = root + '/qqq/quests/';
    var currentName = _knownName || await _findQuestDirByPrefix(root, questId);
    if (!currentName) { console.warn('[quest-dir] dir not found by prefix:', questId); return; }
    var expectedName = _makeName('q', numericId, dbTitle);
    if (currentName === expectedName) return;
    // 期望名不存在 → 尝试重命名（stat 返回 null 不抛异常，必须检查返回值）
    var statResult = await bridge.fs.stat(questsDir + expectedName);
    if (!statResult) {
        try {
            await bridge.fs.rename(questsDir + currentName, questsDir + expectedName);
            console.log('[quest-dir] renamed:', currentName, '→', expectedName);
        } catch (e) {
            console.warn('[quest-dir] rename failed:', currentName, '→', expectedName, '|', (e && e.message) || e);
        }
    } else {
        console.warn('[quest-dir] expected name already exists, skip rename:', expectedName);
    }
}

// ── 启动时批量修复：单次 list 构建前缀映射，O(n) 对齐所有 quest 目录名 ──
var __repairDone = false;  // ★ 仅中面板执行 + 单会话一次（防 3 面板同时 rename 互斥 EPERM）
async function _repairAllQuestDirNames(quests) {
    if (typeof _panelId !== 'undefined' && _panelId !== 1) return;  // ★ 侧面板跳过
    if (__repairDone) return;
    __repairDone = true;
    var root = questStore.getProjectRoot();
    if (!root) return;
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge || !bridge.fs) return;
    var questsDir = root + '/qqq/quests/';
    // 一次 list，构建 questId → dirName 映射 + 碰撞检测
    var dirMap = {};
    var collisions = {}; // { prefix: [name1, name2, ...] }
    try {
        var entries = await bridge.fs.list(questsDir);
        for (var ei = 0; ei < entries.length; ei++) {
            var name = entries[ei].name;
            if (!entries[ei].isDir) continue;
            var dotIdx = name.indexOf('.');
            if (dotIdx > 0) {
                var prefix = name.substring(0, dotIdx); // e.g. "q80"
                if (!dirMap[prefix]) {
                    dirMap[prefix] = name;
                } else {
                    if (!collisions[prefix]) collisions[prefix] = [dirMap[prefix]];
                    collisions[prefix].push(name);
                }
            }
        }
        // 碰撞告警：同编号存在多个不同名目录，数据可能分裂
        var _colKeys = Object.keys(collisions);
        for (var _ci = 0; _ci < _colKeys.length; _ci++) {
            var _cp = _colKeys[_ci];
            console.warn('[quest-dir] COLLISION: prefix ' + _cp + ' has ' + collisions[_cp].length + ' dirs:', collisions[_cp].join(', '));
            console.warn('[quest-dir]   → using first: ' + dirMap[_cp] + ' | stale orphans: ' + collisions[_cp].slice(1).join(', '));
        }
    } catch (_) { return; }
    // 逐个 quest 检查并修复
    for (var i = 0; i < quests.length; i++) {
        var q = quests[i];
        if (!q.id || !q.title) continue;
        var expectedName = _makeName('q', q.numericId, q.title);
        var currentName = dirMap[q.id];
        if (!currentName || currentName === expectedName) continue;
        // 期望名不存在 → rename
        var statResult = await bridge.fs.stat(questsDir + expectedName);
        if (!statResult) {
            try {
                await bridge.fs.rename(questsDir + currentName, questsDir + expectedName);
                // ★ 更新 dirMap，防止后续同 ID quest 用旧名重试（ENOENT）
                dirMap[q.id] = expectedName;
                console.log('[quest-dir] batch renamed:', currentName, '→', expectedName);
            } catch (e) {
                console.warn('[quest-dir] batch rename failed:', currentName, '→', expectedName, '|', (e && e.message) || e);
            }
        }
    }
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

// ── 重命名 quest：DB 改名 + 尽力磁盘改名 + 惰性修复兜底 ──
async function renameQuest(id, newTitle) {
    if (!id || !newTitle) return;
    var quests = await questStore.list();
    var entry = quests.find(function (q) { return q.id === id; });
    if (!entry) return;
    var oldTitle = entry.title;
    if (oldTitle === newTitle) return;
    // 1. DB 改名（100% 可靠）
    await questStore.rename(id, newTitle, entry.numericId);
    // 2. 尽力磁盘改名
    var root = questStore.getProjectRoot();
    if (root) {
        await _tryRepairQuestDirName(root, id, entry.numericId, newTitle);
    }
    // 3. 刷新 UI
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
    var _ag = _activeAgent;
    var conv = _ag.conversation;
    var ctx = _ag._ctx;
    var ctxHash = ctx ? (ctx.totalFloors + '|' + (ctx.facts ? ctx.facts.length : 0)) : '';
    if (_estCache.convLen === conv.length && _estCache.ctxHash === ctxHash && _estCache.val > 0) {
        return _estCache.val;
    }
    var total = 0;
    var CHAR_PER_TOKEN = ContentGateway.CHAR_PER_TOKEN;
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
    var _ag = _activeAgent;
    // ★ 优先用 _lastApiTotalTokens（prompt+completion 精确值，每间 house 更新）
    //   fallback: _lastApiPromptTokens → 本地 chars/3 估算
    var totalTokens = _ag._lastApiTotalTokens || _ag._lastApiPromptTokens || 0;
    var est = estimateTokens();
    var used = totalTokens > 0 ? Math.max(est, totalTokens) : est;
    var pct = Math.min(100, Math.round(used / CTX_MAX_TOKENS * 100));
    $ctxBtn.textContent = Math.round(used / 1000) + ' k';
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
    var _ts = _now.getFullYear() + '-' + String(_now.getMonth()+1).padStart(2,'0') + '-' + String(_now.getDate()).padStart(2,'0') + ' ' + String(_now.getHours()).padStart(2,'0') + ':' + String(_now.getMinutes()).padStart(2,'0') + ':' + String(_now.getSeconds()).padStart(2,'0');
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
            await _saveAgentQuestData(questActiveId, _ag, _ag._floorStartIdx).catch(function () { });
        }
        // ★ 刷新 card-pool 显示压缩楼层
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
            await _saveAgentQuestData(questActiveId, _ag, _ag._floorStartIdx).catch(function () { });
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
$guideBtn.onclick = function () {
    if (_switching) return;  // ★ quest 切换中
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
            // 仅清空流式缓冲（_buf），保留已渲染的 DOM 和段落数组，不删用户可见内容
            _aiDiv._buf = '';
            _aiDiv._codeFenceOpen = false;
            _aiDiv._dirty = false;
            // 正在流式的未完成段落转为静态 DOM 保留，不再跟踪
            _aiDiv._lastParaEl = null;
            _aiDiv._guideMode = true;
            // 引导注入块：第一行 ⚡ 引导信息，第二行正文左对齐
            var guideBlock = document.createElement('div');
            guideBlock.className = 'msg-flow-guide-inject';
            guideBlock.innerHTML = '<div class="msg-flow-guide-hdr"><span class="msg-flow-icon">⚡</span> 引导信息</div><div class="msg-flow-guide-body">' + escHtml(text) + '</div>';
            _aiDiv._contentWrap.appendChild(guideBlock);
            var marker = document.createElement('div');
            marker.className = 'msg-flow-guide';
            marker.style.cssText = 'opacity:0.6;';
            marker.innerHTML = '<span class="msg-flow-icon">\u23f3</span> \u786e\u8ba4\u4e2d...';
            _aiDiv._contentWrap.appendChild(marker);
            _aiDiv._guideMarker = marker;
        }
        _activeAgent.injectGuide(text);
    } else {
        // AI \u6ca1\u5728\u5de5\u4f5c \u2192 \u964d\u7ea7\u4e3a\u666e\u901a inject
        _activeAgent.inject('[GUIDE] ' + text);
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
    if (_switching) return;  // ★ quest 切换中
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

// ═══ qh 滚动条 — AI 面板聊天区（按标准文档接入）═══
(function () {
  var host = document.getElementById('messages-wrap');
  var el = document.getElementById('messages');
  if (!host || !el) return;

  function _qhColors() {
    var dk = document.documentElement.getAttribute('data-theme') === 'dark';
    return { c: dk ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.55)',
             cH: dk ? 'rgba(255,255,255,0.70)' : 'rgba(0,0,0,0.80)' };
  }

  // 滑轨
  var track = document.createElement('div');
  track.style.cssText = 'position:absolute; right:-1px; top:0; bottom:0; width:11px; z-index:50;';

  // 滑块
  var thumb = document.createElement('div');
  var co = _qhColors();
  thumb.style.cssText = 'position:absolute; right:9px; width:2px; min-height:24px; border-radius:0; ' +
    'background:' + co.c + '; cursor:pointer; ' +
    'transition: width 0.1s ease, right 0.1s ease, background 0.1s ease;';

  // hover 变粗贴边
  track.addEventListener('mouseenter', function () {
    thumb.style.width = '11px'; thumb.style.right = '-1px';
    thumb.style.background = _qhColors().cH;
  });
  track.addEventListener('mouseleave', function () {
    thumb.style.width = '2px'; thumb.style.right = '9px';
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

  // 主题切换 → 立即刷滑块色
  var themeObs = new MutationObserver(function () {
    var co2 = _qhColors();
    thumb.style.background = co2.c;
  });
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  track.appendChild(thumb);
  host.appendChild(track);
})();


