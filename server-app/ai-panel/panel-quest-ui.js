// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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
    // ★ 硬限制：没收到 house 1 不准切任务（防原 floor 中断出红字"未收到 AI 回复"）
    //   ★ agent pool 直取，不经 _activeAgent（_activeAgent 可能被异步换掉导致误判）
    //   ★ _houseIndex 是 agent-loop 原生计数器：floor 始=0，每间 house 完成 +=1，永不清零
    var _curAg = parent && parent.__qqq_agentPool && parent.__qqq_agentPool[questActiveId];
    if (_curAg && _curAg._stopState === 'sending') {
        var _noHouse1 = _curAg._deferRenderUntilHouse1 || (_curAg._houseIndex == null || _curAg._houseIndex <= 0);
        if (_noHouse1) {
            _switching = false;
            if (_overlay) _overlay.classList.remove('show');
            if ($messages) $messages.classList.remove('qqq-switching');
            try {
                if (parent && parent.qqqideQoast) parent.qqqideQoast.show(
                    '当前任务 AI 尚未回复，请稍后再切换',
                    { type: 'warning', duration: 4000 }
                );
            } catch (_) { }
            return;
        }
    }
    try {
        // ═══ 所有权检查（同步父注册表） ═══
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
            if (_activeAgent && _activeAgent._compressing) {
                // 压缩进行中 → 等待完成（最多 220s），防保存半成品
                var _waitStart = Date.now();
                while (_activeAgent._compressing && (Date.now() - _waitStart) < 220000) {
                    await new Promise(function (r) { setTimeout(r, 200); });
                }
            }
            // ★ 仅在建楼中的 agent 才有未保存数据需刷盘；idle agent 的数据已在 onDone 时写入
            // ★ 治根：0 houses 时不落盘（无有效数据。agent 后台继续运行，完结后自然保存）
            if (_activeAgent && _activeAgent._stopState === 'sending' && _activeAgent._houses && _activeAgent._houses.length > 0) {
                await _saveAgentQuestData(questActiveId, _activeAgent, _activeAgent._currentFloorNum, { skipDomFlush: true });
            }
            // ★ 释放旧 quest 所有权（流式 buffer 状态已通过 _a4BuildCompleteFloorPayload 落盘，跨面板迁移安全）
            if (!_isDraft(questActiveId)) {
                _parentReleaseQuest(questActiveId);
                _broadcast('owner-released', questActiveId);
            }
        }

        // ═══ Card Pool 切换（纯 CSS 显隐，零 DOM 销毁） ═══
        // ★ A1+C1: 共享 agent 状态决定 card 处理策略
        //   sending + 本面板 aiDiv 活 → 保留实时 DOM（不丢流式内容）
        //   sending + 无活 aiDiv（其他面板发起）→ 清空从磁盘重载
        //   非 sending（已完成/已停止）→ 清空从磁盘重载最新数据
        var _sharedAg = parent.__qqq_agentPool && parent.__qqq_agentPool[id];
        if (_sharedAg && _sharedAg._stopState === 'sending') {
            var _card = cardPool._cards[id];
            if (_card && _card._contentWrap) {
                var _hasLiveAi = _card.buildingFloor !== null && _card.floorDOM[_card.buildingFloor] && _card.floorDOM[_card.buildingFloor].aiEl;
                if (!_hasLiveAi) {
                    _card._contentWrap.innerHTML = '';
                    _card.floorDOM = {};
                    _card.totalFloors = 0;
                    _card.floors = [];
                    _card._floorMetaMap = {};
                }
            }
        } else {
            var _card2 = cardPool._cards[id];
            // ★ 治根：fatal 楼层保留卡片（含 error 态 DOM），仅清非 fatal 的僵尸 buildingFloor
            if (_card2 && _card2.buildingFloor !== null && !_sharedAg._floorFatal) {
                _card2._contentWrap.innerHTML = '';
                _card2.floorDOM = {};
                _card2.totalFloors = 0;
                _card2.floors = [];
                _card2._floorMetaMap = {};
            }
        }
        await cardPool.switchTo(id);

        questActiveId = id;
        // 原子写面板 resume JSON（bridge.fs.write → 主进程 tmp+rename，零踩踏）
        _persistPanelResume(id);

        // ★ 重排序：记录 quest 最后点击时间，使最近活跃 quest 浮顶
        questStore.touch(id);

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

        // ★ V14: 数据驱动重建红框（_renderAllErrorBoxes 从 _questErrorState 全量渲染）
        if (_activeAgent && _activeAgent._questErrorState && typeof _renderAllErrorBoxes === 'function') {
            _renderAllErrorBoxes(_activeAgent);
        }
        // ★ 兜底: fatal 楼层即使 error log 为空，只要有 floorDOM 就渲染红框
        if (_activeAgent && _activeAgent._floorFatal) {
            var _fn3 = _activeAgent._currentFloorNum;
            if (_fn3 > 0) {
                var _card3 = cardPool && cardPool.getActive();
                if (_card3 && _card3.floorDOM && _card3.floorDOM[_fn3] && _card3.floorDOM[_fn3].aiEl) {
                    if (typeof _renderQuestErrorBox === 'function') _renderQuestErrorBox(_activeAgent, _card3.floorDOM[_fn3].aiEl, _fn3);
                }
            }
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
        setStreaming(!!(_activeAgent && _activeAgent._streaming));  // ★ 切 quest 后按实际 agent 状态刷新按钮（不是无条件 false）
        // ★ 切换后同步电子钟状态
        if (typeof _updateQuestClock === 'function') _updateQuestClock();
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
    var qDir = root + '/_qqq/quests/' + qName;
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
// ★ 加固（2026-06-25）：I/O 错误不再静默吞 → 3x 重试，全失败则抛异常
//   避免静默返回 null → 上游误认为目录不存在 → 创建重复目录（§漏洞①）
async function _findQuestDirByPrefix(root, questId) {
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge || !bridge.fs) return null;    var questsDir = root + '/_qqq/quests/';;
    var lastErr = null;
    for (var attempt = 0; attempt < 3; attempt++) {
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
            return matches[0] || null;  // ★ null = 真无目录（list 成功但无匹配）
        } catch (e) {
            lastErr = e;
            if (attempt < 2) {
                console.warn('[quest-dir] _findQuestDirByPrefix I/O error (attempt ' + (attempt + 1) + '/3):', e && e.message);
                await new Promise(function (r) { setTimeout(r, 200); });
            }
        }
    }
    // ★ 3 次全失败 → 抛异常，未可静默返回 null（否则上游误以为目录不存在 → 创建重复目录）
    console.error('[quest-dir] _findQuestDirByPrefix FAILED after 3 attempts for ' + questId + ':', lastErr && lastErr.message);
    throw new Error('_findQuestDirByPrefix: I/O error after 3 retries — ' + (lastErr && lastErr.message));
}

// ── 解析 quest 目录名录名：只按 q{n}. 前缀匹配已有目录 ──
// B+ 方案：不再实时修复或创建新目录，只返回已有目录名
// 若找不到（首次建楼调用此函数），则由 build 路径自己决定
async function _resolveQuestDirName(root, questId, numericId, title) {
    try {
        var existing = await _findQuestDirByPrefix(root, questId);
        if (existing) return existing;
    } catch (e) {
        // ★ _findQuestDirByPrefix 现在不再静默吞错；I/O 错误会抛异常
        //   对于已存在的 quest（发后续楼层），抛异常比创建重复目录更安全
        //   对于新 quest（首次建楼），回退到 _makeName 是合理的
        console.warn('[quest-dir] _resolveQuestDirName: prefix scan failed for ' + questId + ', falling back to generated name:', e && e.message);
    }
    // ★ 找不到 → 返回 expected name（调用方 _ensureQuestDir 会按需创建）
    //   不再实时修复目录名，懒惰修正留给 lazyRenameScan
    return _makeName('q', numericId, title);
}

async function createNewQuest() {
    if (_switching) return;  // ★ quest 切换中
    // ★ 硬限制：同 switchQuest，没收到 house 1 不准新建任务（防原 floor 中断）
    if (!_isDraft(questActiveId)) {
        var _curAg2 = parent && parent.__qqq_agentPool && parent.__qqq_agentPool[questActiveId];
        if (_curAg2 && _curAg2._stopState === 'sending') {
            var _noHouse12 = _curAg2._deferRenderUntilHouse1 || (_curAg2._houseIndex == null || _curAg2._houseIndex <= 0);
            if (_noHouse12) {
                try {
                    if (parent && parent.qqqideQoast) parent.qqqideQoast.show(
                        '当前任务 AI 尚未回复，请稍后再新建',
                        { type: 'warning', duration: 4000 }
                    );
                } catch (_) { }
                return;
            }
        }
    }
    saveQuestUIState(questActiveId);
    // ★ 先保存再停流：stopStream() 会改变 _stopState，保存必须在此之前
    if (!_isDraft(questActiveId) && _activeAgent && _activeAgent._stopState === 'sending') await saveQuestData();
    if (streaming) stopStream();
    if (questActiveId && !_isDraft(questActiveId)) {
        _parentReleaseQuest(questActiveId);
        _broadcast('owner-released', questActiveId);
    }
    if (questActiveId) {
        cardPool.removeCard(questActiveId);
    }
    _unloadQuest();
    restoreQuestUIState(_draftId);  // ★ 恢复 ~New quest~ 草稿（_unloadQuest 清空 input 后立即还原）
}

function _unloadQuest() {
    var unloadId = questActiveId;
    if (unloadId && !_isDraft(unloadId)) { _parentReleaseQuest(unloadId); }
    if (unloadId && cardPool) {
        var oldCard = cardPool.getCard(unloadId);
        if (oldCard && oldCard.dom) {
            oldCard.dom.style.display = 'none';
        }
    }
    questActiveId = _draftId;
    _queueFallback = [];
    if (unloadId && parent.__qqq_agentPool && parent.__qqq_agentPool[unloadId]) {
        var _oldAg = parent.__qqq_agentPool[unloadId];
        _oldAg._queue = [];
        // ★ V6 fix: 清理红框 DOM 引用防内存泄漏
        _oldAg._questErrorDivByFloor = {};
    }
    if (_queueSaveTimer) { clearTimeout(_queueSaveTimer); _queueSaveTimer = null; }
    renderQueueStrip();
    $input.value = '';
    $input._resetUndo();
    pendingImages = [];
    selectedTier = (typeof _getDefaultTier === 'function') ? _getDefaultTier() : 3;
    updateTierButtons(selectedTier);
    renderImageStrip();
    _activeAgent = null;
    setStreaming(false);  // ★ 卸载 quest 后刷新按钮状态
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
    // ★ 豆沙包：删除 quest 时清理 draft flag
    if (parent && parent.__qqq_draftFlags && parent.__qqq_draftFlags[id]) {
        delete parent.__qqq_draftFlags[id];
        _broadcast('draft-changed', id);
    }
    _parentReleaseQuest(id);
    _broadcast('owner-released', id);
    if (parent.__qqq_agentPool && parent.__qqq_agentPool[id]) {
        try { parent.__qqq_agentPool[id].abort(); } catch (_) { }
        delete parent.__qqq_agentPool[id];
    }
    cardPool.removeCard(id);
    if (questActiveId === id) {
        // 删除的是当前活跃 quest → 切换到下一个
        quests = await questStore.list();
        questActiveId = quests[0].id;
        _persistPanelResume(questActiveId);
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
    // ★ 改名后重建 search_quest.txt（旧路径可能指向改名前的目录名）
    if (typeof _rebuildSearchQuest === 'function') {
        _rebuildSearchQuest(id).catch(function () { });
    }
    await renderTabs();
}

function updateCostDisplay() { }  // no-op — retained for backward compat with panel-quest.js

// ★ _estimateTokensFull 缓存变量
var _estCache = null;
var _ctxBreakdownData = null;
var _ctxBreakdownTimer = null;
var _ctxBreakdownVisible = false;

// ★ _estimateTokensFull — 穷举每一个会进入 API body 的字节，逐字符计量，chars÷2.7 得 token 估值。
// ★ API prompt_tokens 是服务端返回的精确 token 数（权威），本地 sum 用于审计 / 发现漏 Grid。
// ★ 分类原则：按 API 看到的消息数组顺序 + 顶层 body 字段完整覆盖，零漏项。
function _estimateTokensFull() {
    var _ag = _activeAgent;
    if (!_ag) { console.warn("[ctx-est] _activeAgent is null"); _ctxBreakdownData = null; return 0; }
    var conv = _ag.conversation || [];
    if (!conv.length) { console.warn("[ctx-est] conversation EMPTY"); }
    var ctx = _ag._ctx || null;

    // ── cache ──
    var _msg0HashNow = (conv.length > 0 && typeof conv[0].content === "string") ? conv[0].content.slice(0, 80) + "|" + conv[0].content.slice(-80) : "";
    var _apiPrompt = _ag._lastApiPromptTokens || 0;
    var _apiCompletion = _ag._accumulatedCompletionTokens || 0;
    var _apiVerNow = _apiPrompt + "|" + _apiCompletion;
    var _ctxHashNow = ctx ? ((ctx.biscuitLines ? ctx.biscuitLines.length : 0) + "|0") : "";
    // ★ 快速 biscuit 内容指纹（首尾各 40 字符），用于检测阀值压缩等原地修改
    var _biscuitHashNow = '';
    for (var _bi = 0; _bi < conv.length; _bi++) {
        if (conv[_bi]._biscuit && typeof conv[_bi].content === 'string') {
            var _bc = conv[_bi].content; _biscuitHashNow = _bc.slice(0, 40) + '|' + _bc.slice(-40); break;
        }
    }
    if (typeof _estCache !== 'undefined' && _estCache && _estCache.convLen === conv.length && _estCache.ctxHash === _ctxHashNow && _estCache.apiVer === _apiVerNow && _estCache.msg0Hash === _msg0HashNow && _estCache.biscuitHash === _biscuitHashNow && _estCache.val > 0) {
        return _estCache.val;
    }

    var CPT = 2.7;
    var CTX_MAX = (typeof ContentGateway !== "undefined" && ContentGateway.CTX_MAX_TOKENS) ? ContentGateway.CTX_MAX_TOKENS : 1048565;
    function _tk(chars) { return Math.round(chars / CPT); }

    // ═══ 第一部分：messages 数组 ═══

    // ── 1. 服务端甲壳 ──
    var guardChars = 14964;
    var guardTok = _tk(guardChars);

    // ── 2. msg[0] — 客户端 persistent 系统消息 ──
    var visionChars = typeof window.qqqideVisionContext === "string" ? window.qqqideVisionContext.length : 0;
    var globalRulesChars = typeof window.qqqideRulesContent === "string" ? window.qqqideRulesContent.length : 0;
    var projectRulesChars = typeof window.qqqideProjectRulesContent === "string" ? window.qqqideProjectRulesContent.length : 0;
    var panelRoot = (typeof questStore !== "undefined" && questStore.getProjectRoot) ? questStore.getProjectRoot() : "";
    var reminderChars = 0;
    if (panelRoot) {
        panelRoot = panelRoot.replace(/\\/g, "/").replace(/\/$/, "");
        var _rText = "\n\n═══ DEFAULT WORKING DIRECTORY ═══\nMain project: " + panelRoot + "\nWhen the user does not specify a project, all file operations default to this directory.\n═══════════════════";
        reminderChars = _rText.length;
    }
    var msg0FromConv = (conv.length > 0 && conv[0]._persistent && typeof conv[0].content === "string") ? conv[0].content.length : 0;
    var msg0TotalChars = msg0FromConv > 0 ? msg0FromConv : (visionChars + globalRulesChars + projectRulesChars + reminderChars);
    var msg0Tok = _tk(msg0TotalChars);

    // ── 3. V12 压缩上下文（biscuit + DE，已在 conversation 中）──
    var biscuitChars = 0, biscuitFloorCount = (ctx && ctx.biscuitLines) ? ctx.biscuitLines.length : 0;
    var deChars = 0;  // V13: DE 概念消除
    var biscuitText = '';  // ★ 用于子统计解析（绝对包装盒/Q/A/温柔盒）

    // ── 4. conversation 遍历（non-persistent 消息）──
    var userCount = 0, userChars = 0;
    var aiCount = 0, aiContentChars = 0;
    var aiToolCallsCount = 0, aiToolCallsChars = 0;
    var toolCount = 0, toolChars = 0;
    var sysCount = 0, sysChars = 0;
    var errCount = 0, errChars = 0;
    for (var i = 0; i < conv.length; i++) {
        var m = conv[i];
        if (!m || m._persistent) continue;
        var cn = typeof m.content === "string" ? m.content.length : 0;
        if (m._biscuit) { biscuitChars += cn; biscuitText = m.content || ''; }
        // ★ V13: _deBlock 已消除，DE 融入 biscuit
        else if (m.role === "user") { userCount++; userChars += cn; }
        else if (m.role === "assistant") {
            if (m.tool_calls) {
                aiToolCallsCount++;
                try { aiToolCallsChars += JSON.stringify(m.tool_calls).length; } catch (_) { }
            }
            if (m._error) { errCount++; errChars += cn; }
            else { if (cn > 0) { aiCount++; aiContentChars += cn; } }
        }
        else if (m.role === "tool") {
            toolCount++;
            toolChars += cn;
            if (typeof m.tool_call_id === "string") toolChars += m.tool_call_id.length;
            if (typeof m.name === "string") toolChars += m.name.length;
        }
        else if (m.role === "system") { sysCount++; sysChars += cn; }
    }

    // ── 5. JSON 结构开销 ──
    var msgCount = userCount + aiCount + aiToolCallsCount + toolCount + sysCount + errCount;
    var jsonOverheadChars = msgCount * 31;
    jsonOverheadChars += toolCount * 27;
    jsonOverheadChars += aiToolCallsCount * 16;
    jsonOverheadChars += 62;
    if (biscuitChars > 0) jsonOverheadChars += 31;
    if (deChars > 0) jsonOverheadChars += 31;
    var jsonOverheadTok = _tk(jsonOverheadChars);

    // ── 5b. 压缩饼干子统计（绝对包装盒/Q/A/温柔盒）──
    var absToolCounts = {}, absToolSizes = {};  // {toolname: count, chars}
    var qBiscuitCount = 0, qBiscuitChars = 0;
    var aBiscuitCount = 0, aBiscuitChars = 0;
    var gentleBiscuitCount = 0, gentleBiscuitChars = 0;
    var ABS_TOOL_NAMES = ['run_command', 'generate_image', 'remove_background', 'analyze_image', 'get_vision_context'];
    if (biscuitText) {
        // 按楼层分割
        var floorParts = biscuitText.split(/\n(?=== F\d+ )/);
        for (var fi = 0; fi < floorParts.length; fi++) {
            var fp = floorParts[fi];
            // Q 段: 'Q: ' 到下一个 '\n[A →' 或 '\n╔K' 或 '\nA: ' 或 floor 尾
            var qIdx = fp.indexOf('\nQ: ');
            if (qIdx >= 0) {
                qIdx++; var qStart = qIdx;
                var afterQ = fp.slice(qStart + 3);
                var qEndMatch = afterQ.search(/\n(?:\[A \u2192|\u2554K|A: |$)/);
                var qEnd = qEndMatch >= 0 ? qStart + 3 + qEndMatch : fp.length;
                qBiscuitCount++; qBiscuitChars += qEnd - qStart;
            }
            // A 段: 最后一个 '\nA: ' 到 floor 尾
            var aIdx = fp.lastIndexOf('\nA: ');
            if (aIdx >= 0) { aBiscuitCount++; aBiscuitChars += fp.length - aIdx; }
            // 工具行: [A → xxx]
            var toolRe = /\[A \u2192 (\w+(?:\+\w+)*)\]([^\n]*)/g;
            var tm;
            while ((tm = toolRe.exec(fp)) !== null) {
                var toolName = tm[1];
                var afterPos = tm.index + tm[0].length;
                var after80 = fp.slice(afterPos, afterPos + 80);
                var isAbs = after80.indexOf('\u2554K') >= 0;
                if (isAbs) {
                    var boxStart = fp.indexOf('\u2554K', afterPos);
                    if (boxStart >= 0) {
                        var boxEnd = fp.indexOf('\n\u255a', boxStart);
                        if (boxEnd >= 0) {
                            var bodyStart = boxStart + 2;
                            if (fp.charAt(bodyStart) === '\n') bodyStart++;
                            var bodyLen = boxEnd - bodyStart;
                            if (!absToolCounts[toolName]) { absToolCounts[toolName] = 0; absToolSizes[toolName] = 0; }
                            absToolCounts[toolName]++; absToolSizes[toolName] += bodyLen;
                        }
                    }
                } else {
                    gentleBiscuitCount++;
                    var lineEnd = fp.indexOf('\n', afterPos);
                    if (lineEnd === -1) lineEnd = fp.length;
                    gentleBiscuitChars += lineEnd - tm.index;
                }
            }
        }
    }
    var absToolTok = {}; var absToolTotalTok = 0;
    for (var tk in absToolCounts) { absToolTok[tk] = _tk(absToolSizes[tk]); absToolTotalTok += absToolTok[tk]; }
    var qBiscuitTok = _tk(qBiscuitChars);
    var aBiscuitTok = _tk(aBiscuitChars);
    var gentleBiscuitTok = _tk(gentleBiscuitChars);

    // ═══ 第二部分：body 顶层字段 ═══

    // ── 6. 工具定义 ──
    var toolsChars = 0;
    try {
        var _tools = (typeof getTools === "function") ? getTools() : null;
        if (_tools && _tools.length) toolsChars = JSON.stringify(_tools).length;
    } catch (_) { }
    var toolsTok = _tk(toolsChars);

    // ── 7. body 常量字段 ──
    var bodyConstChars = 150;
    var bodyConstTok = _tk(bodyConstChars);

    // ═══ 求和 ═══
    var biscuitTok = _tk(biscuitChars);
    var deTok = _tk(deChars);
    var userTok = _tk(userChars);
    var aiTextTok = _tk(aiContentChars);
    var aiToolCallsTok = _tk(aiToolCallsChars);
    var toolTok = _tk(toolChars);
    var sysTok = _tk(sysChars);
    var errTok = _tk(errChars);
    var localTotal = guardTok + msg0Tok + biscuitTok + deTok + userTok + aiTextTok + aiToolCallsTok + toolTok + sysTok + errTok + jsonOverheadTok + toolsTok + bodyConstTok;

    // ═══ 构建行 ═══
    var rows = [];
    function _r(label, tok, indent, color) {
        rows.push({ label: label, tok: tok, indent: indent || 0, color: color || "#839496" });
    }
    _r("Server guard", guardTok, 0, "#6c71c4");
    if (msg0TotalChars > 0) {
        _r("Client rules & docs", msg0Tok, 0, "#268bd2");
        if (visionChars > 0) _r("  Vision Context", _tk(visionChars), 1, "#859900");
        if (globalRulesChars > 0) _r("  Global Rules", _tk(globalRulesChars), 1, "#6c71c4");
        if (projectRulesChars > 0) _r("  Project Rules", _tk(projectRulesChars), 1, "#b58900");
        if (reminderChars > 0) _r("  Reminder", _tk(reminderChars), 1, "#cb4b16");
    }
    if (biscuitChars > 0) {
        _r("压缩饼干 × " + biscuitFloorCount + " floors", biscuitTok, 0, "#859900");
        // ★ 绝对包装盒子统计（仅统计有数据的工具）
        for (var ati = 0; ati < ABS_TOOL_NAMES.length; ati++) {
            var atn = ABS_TOOL_NAMES[ati];
            if (absToolCounts[atn] && absToolCounts[atn] > 0) {
                _r("  \u2554K " + atn + " × " + absToolCounts[atn], absToolTok[atn], 1, "#cb4b16");
            }
        }
        // ★ Q / A / 温柔盒子统计
        if (qBiscuitCount > 0) _r("  Q × " + qBiscuitCount, qBiscuitTok, 1, "#268bd2");
        if (aBiscuitCount > 0) _r("  A × " + aBiscuitCount, aBiscuitTok, 1, "#2aa198");
        if (gentleBiscuitCount > 0) _r("  Gentle × " + gentleBiscuitCount, gentleBiscuitTok, 1, "#b58900");
    }
    if (deChars > 0) _r("DE Grid × " + deEntryCount + " entries", deTok, 0, "#b58900");
    if (userCount > 0) _r("User × " + userCount, userTok, 0, "#268bd2");
    if (aiCount > 0) _r("AI text × " + aiCount, aiTextTok, 0, "#2aa198");
    if (aiToolCallsCount > 0) _r("AI tool_calls × " + aiToolCallsCount, aiToolCallsTok, 0, "#d2991d");
    if (toolCount > 0) _r("Tool Results × " + toolCount, toolTok, 0, "#dc322f");
    if (sysCount > 0) _r("System messages × " + sysCount, sysTok, 0, "#6c71c4");
    if (errCount > 0) _r("Error messages × " + errCount, errTok, 0, "#f85149");
    _r("JSON overhead (" + msgCount + " msgs + " + sysCount + " sys)", jsonOverheadTok, 0, "#586e75");
    if (toolsChars > 0) _r("Tools definition JSON", toolsTok, 0, "#b58900");
    _r("Body fields (stream, max_tokens, …)", bodyConstTok, 0, "#586e75");
    var displayTotal = _apiPrompt > 0 ? _apiPrompt : localTotal;
    _r("Local sum", localTotal, 0, "#c9d1d9");
    if (_apiPrompt > 0) _r("API prompt_tokens", _apiPrompt, 0, "#3fb950");
    var _free = Math.max(0, CTX_MAX - displayTotal);
    _r("Free", _free, 0, "#859900");

    _ctxBreakdownData = { rows: rows, displayTotal: displayTotal, apiPrompt: _apiPrompt, localTotal: localTotal, accCompletion: _apiCompletion };
    _estCache = { val: displayTotal, convLen: conv.length, ctxHash: _ctxHashNow, apiVer: _apiVerNow, msg0Hash: _msg0HashNow, biscuitHash: _biscuitHashNow };
    if (localTotal === 0) console.warn("[ctx-est] total=0 convLen=" + conv.length + " guard=" + guardChars + " msg0=" + msg0TotalChars + " biscuit=" + biscuitChars + " de=" + deChars + " user=" + userChars + " aiTxt=" + aiContentChars + " aiTC=" + aiToolCallsChars + " tool=" + toolChars + " sys=" + sysChars + " err=" + errChars + " jOver=" + jsonOverheadChars + " tools=" + toolsChars);
    return displayTotal;
}
var CTX_MAX_TOKENS = (typeof ContentGateway !== 'undefined' && ContentGateway.CTX_MAX_TOKENS) ? ContentGateway.CTX_MAX_TOKENS : 1048565;

function renderCtxBreakdown() {
    var bd = document.getElementById('ctx-breakdown');
    if (!bd) return;
    if (!_activeAgent || !_activeAgent.conversation) { bd.classList.remove('show'); return; }
    _estimateTokensFull();
    var data = _ctxBreakdownData;
    if (!data || !data.rows) { bd.classList.remove('show'); return; }
    var rowsEl = bd.querySelector('.ctx-bd-rows');
    var BX = 10000;
    var MAX_BLOCKS = 100;
    var html = '';
    // ★ 标记每组最后一个缩进行（用于树形连线）
    for (var i = 0; i < data.rows.length; i++) {
        var r = data.rows[i];
        r._isLastChild = false;
        if (r.indent > 0 && i + 1 < data.rows.length) {
            r._isLastChild = data.rows[i + 1].indent === 0;
        } else if (r.indent > 0 && i + 1 >= data.rows.length) {
            r._isLastChild = true;
        }
    }
    for (var i = 0; i < data.rows.length; i++) {
        var r = data.rows[i];
        if (r.tok <= 0) continue;
        var _isSum = r.label === 'Local sum' || r.label === 'API prompt_tokens';
        var _isFree = r.label === 'Free';
        var c = r.color || '#2aa198';
        var n = Math.min(MAX_BLOCKS, Math.max(0, Math.round(r.tok / BX)));
        var bar = '';
        if (n > 0) {
            bar = '<span class="ctx-bd-bar">';
            for (var b = 0; b < n; b++) bar += '<i style="background:' + c + '"></i>';
            bar += '</span>';
        }
        var valStr = r.tok >= 1000 ? Math.round(r.tok / 1000) + 'k' : String(r.tok);
        var padLeft = (r.indent || 0) * 14 + 'px';
        var labelHtml = _isSum ? '<b>' + r.label + '</b>' : (_isFree ? '<span style="color:#859900">' + r.label + '</span>' : r.label);
        // ★ 树形连线：缩进行加 ├ / └ 前缀
        if (r.indent > 0) {
            var treeChar = r._isLastChild ? '\u2514' : '\u251C';
            labelHtml = '<span class="ctx-bd-tree">' + treeChar + '</span>' + labelHtml;
        }
        html += '<div class="ctx-bd-row" style="padding-left:' + padLeft + '">' +
            bar +
            '<span class="ctx-bd-label" style="color:' + c + '">' + labelHtml + '</span>' +
            '<span class="ctx-bd-num" style="color:' + c + '">' + valStr + '</span></div>';
    }
    rowsEl.innerHTML = html;
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

// ── 上下文按钮 ──
function updateCtxBtn() {
    if (!_activeAgent || !_activeAgent.conversation) {
        $ctxBtn.textContent = '--';
        $ctxBtn.style.setProperty('--ctx-pct', '0%');
        return;
    }
    if (!_activeAgent.conversation.length) { console.warn('[ctx-btn] _activeAgent.conversation is EMPTY ARRAY, agent._floorId=' + (_activeAgent._floorId || '?')); }
    var _ag = _activeAgent;
    var used = _estimateTokensFull();
    if (used === 0 && _ag.conversation && _ag.conversation.length) { console.warn('[ctx-btn] used=0 convLen=' + _ag.conversation.length + ' _floorId=' + (_ag._floorId || '?') + ' _stopState=' + (_ag._stopState || '?')); }
    var displayUsed = (_ag._lastApiPromptTokens > 0) ? _ag._lastApiPromptTokens : used;
    var pct = Math.min(100, Math.round(displayUsed / CTX_MAX_TOKENS * 100));
    $ctxBtn.textContent = Math.round(displayUsed / 1000) + ' k';
    $ctxBtn.style.setProperty('--ctx-pct', pct + '%');
    // ★★ 强制刷新面板（house 级别同步）：检查面板 DOM 是否真正显示
    try {
        var bd = document.getElementById('ctx-breakdown');
        if (bd && bd.classList.contains('show')) renderCtxBreakdown();
    } catch (_) { }
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
// ★ 进入拆解面板自身时不关闭关闭
var _bdPanel = document.getElementById('ctx-breakdown');
if (_bdPanel) {
    _bdPanel.addEventListener('mouseenter', function () {
        clearTimeout(_ctxBreakdownTimer);
    });
    _bdPanel.addEventListener('mouseleave', function () {
        hideCtxBreakdown();
    });
}

// ★★ 管理按钮 — 打开上下文背包 X 区 gaea 标签（每 quest 独立标签）
var _ctxManageBtn = document.getElementById('ctx-manage');
if (_ctxManageBtn) {
    _ctxManageBtn.onclick = function () {
        document.getElementById('ctx-panel').style.display = 'none';
        try {
            var p = window.parent;
            if (!p) return;
            var qid = questActiveId || '';
            if (!qid) return;
            var panelId = (typeof _panelId !== 'undefined') ? _panelId : 1;
            var gaeaId = 'conv-' + qid;

            // 设置全局变量供 conv-ui.html 兜底读取
            p.__qqq_convQuestId = qid;
            p.__qqq_convPanelId = panelId;

            var qqTabs = p.qqqTabs;
            if (!qqTabs) return;

            var gaeaGrp = qqTabs.getGaeaGroup();

            // ① 已有同 quest 标签 → 激活 + 刷新
            if (gaeaGrp) {
                var existing = gaeaGrp.tabs.find(function (t) { return t.gaeaId === gaeaId; });
                if (existing) {
                    qqTabs.activateTab(gaeaGrp, existing.id);
                    // 向 iframe 发送刷新消息（pane 在主窗口 DOM 中）
                    var existingPane = p.document.querySelector('[data-tab-id="' + existing.id + '"]');
                    if (!existingPane && gaeaGrp && gaeaGrp.contentEl) existingPane = gaeaGrp.contentEl.querySelector('[data-tab-id="' + existing.id + '"]');
                    if (existingPane) {
                        var existingIframe = existingPane.querySelector('iframe');
                        if (existingIframe && existingIframe.contentWindow) {
                            existingIframe.contentWindow.postMessage({ type: 'qqq-conv-refresh', questId: qid, panelId: panelId }, '*');
                        }
                    }
                    return;
                }
            }

            // ② 新标签：创建 quest 专属背包标签
            var questLabel = qid;
            try {
                if (typeof questStore !== 'undefined' && questStore.getTitle) {
                    var t = questStore.getTitle(qid);
                    if (t && t !== 'New Chat') questLabel = qid + ' ' + t;
                }
            } catch (_) { }

            qqTabs.addGaeaTab(gaeaId, '📋 ' + questLabel, function (pane, tab) {
                pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
                var iframe = document.createElement('iframe');
                iframe.src = '/qqqide/goods/conv/conv-ui.html?quest=' + encodeURIComponent(qid) + '&panel=' + panelId;
                iframe.style.cssText = 'width:100%;height:100%;border:none;';
                iframe.setAttribute('frameborder', '0');
                pane.appendChild(iframe);
            }, { closable: true });

        } catch (e) { console.warn('[ctx-manage]', e); }
    };
}
// ═══ 快照 — 完整 conversation 打快照到 floor 文件夹 ═══
document.getElementById('ctx-snap').onclick = async function () {
    document.getElementById('ctx-panel').style.display = 'none';
    var _ag = _activeAgent;
    if (!_ag) return;
    if (!questActiveId || _isDraft(questActiveId)) return;

    try {
        var _root = questStore.getProjectRoot();
        if (!_root) return;
        var _questList = await questStore.list();
        var _qEntry = _questList.find(function (qx) { return qx.id === questActiveId; });
        if (!_qEntry) return;
        var _qTitle = (_qEntry.title && _qEntry.title !== 'New Chat') ? _qEntry.title : '';
        var _qNumericId = _qEntry.numericId || parseInt(questActiveId.replace('q', ''), 10) || 0;
        var _qDirName = await _resolveQuestDirName(_root, questActiveId, _qNumericId, _qTitle);

        // ── 找最新楼层目录 ──
        var _allFloors = await questStore.loadAllFloors(questActiveId);
        var _targetDir;
        if (_allFloors && _allFloors.length > 0) {
            var _latestN = _allFloors[_allFloors.length - 1].floorNum;
            var _fData = _allFloors[_allFloors.length - 1].data;
            var _fQuestion = (_fData && _fData.question) ? _fData.question : '';
            // ★ 剥离 [File:] 注入块，确保快照目录名与建楼时一致（防双目录 Bug）
            var _fqStripIdx = _fQuestion.search(/\n\n\[File: /);
            if (_fqStripIdx >= 0) _fQuestion = _fQuestion.slice(0, _fqStripIdx);
            var _fDirName = _makeName('f', _latestN, _fQuestion);
            _targetDir = _root + '/_qqq/quests/' + _qDirName + '/' + _fDirName + '/';
        } else {
            _targetDir = _root + '/_qqq/quests/' + _qDirName + '/';
        }

        // ── 构建快照内容 ──
        var _now = new Date();
        var _ts = _fmtTime(_now).replace(' ', '_').replace(/:/g, '_');

        var _snap = {
            questId: questActiveId,
            snapshotTime: _now.toISOString(),
            conversation: _ag.conversation || [],
            ctx: _ag._ctx || {},
            totalCostGe: _ag.totalCostGe || 0,
            floorCount: _allFloors ? _allFloors.length : 0
        };

        // ── 原子写入 ──
        var _bridge = window.parent && window.parent.qqqideBridge;
        if (!_bridge || !_bridge.fs) return;
        try { await _bridge.fs.mkdir(_targetDir); } catch (_) { }
        var _snapPath = _targetDir + 'snapshot_' + _ts + '.json';
        await _bridge.fs.write(_snapPath, JSON.stringify(_snap, null, 2));

        // ── Toast ──
        var _iFn = typeof _i === 'function' ? _i : function (k, f) { return f; };
        if (window.parent && window.parent.qqqideQoast) {
            window.parent.qqqideQoast.show('📸 ' + _iFn('ai.ctx.snapOk', '快照已保存') + ': snapshot_' + _ts + '.json', { type: 'success', duration: 4000 });
        }
    } catch (e) {
        console.error('[snap]', e);
        var _iFn2 = typeof _i === 'function' ? _i : function (k, f) { return f; };
        if (window.parent && window.parent.qqqideQoast) {
            window.parent.qqqideQoast.show('📸 ' + _iFn2('ai.ctx.snapFail', '快照保存失败') + ': ' + (e.message || 'unknown'), { type: 'error', duration: 4000 });
        }
    }
};
// ═══ 阀值压缩已迁至 goods/conv 上下文背包页面（3 按钮体系） ═══
// 旧 ctx-valve 按钮已移除。自动阀值压缩仍保留在 agent-loop.js 建楼管线中。
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

// ═══ goods/conv 压缩请求处理 — 3 按钮体系（absolut / edit only / only facts） ═══
// conv-ui.html 通过 postMessage 委托 AI 面板执行本地压缩操作并持久化 ctx.json
window.addEventListener('message', async function (e) {
    if (!e.data || e.data.type !== 'qqq-compress-req') return;
    var req = e.data;
    var ag = null;
    var _respond = function (payload) {
        try { if (e.source && e.source.postMessage) e.source.postMessage(payload, '*'); } catch (_) { }
    };
    // 查找 agent（优先 req.questId，兜底 questActiveId）
    var qid = req.questId || questActiveId;
    var pool = window.parent && window.parent.__qqq_agentPool;
    if (pool && qid) {
        ag = pool[qid];
        if (!ag) {
            for (var k in pool) {
                if (pool[k]._questId === qid || pool[k].questId === qid) { ag = pool[k]; break; }
            }
        }
    }
    if (!ag) {
        _respond({ type: 'qqq-compress-res', action: req.action, questId: qid, ok: false, error: 'Agent not found' });
        return;
    }
    if (ag._stopState === 'sending') {
        _respond({ type: 'qqq-compress-res', action: req.action, questId: qid, ok: false, error: 'Agent is sending' });
        return;
    }

    try {

        var conv = ag.conversation;
        var beforeChars = 0, afterChars = 0;
        var found = false;

        for (var i = 0; i < conv.length; i++) {
            var m = conv[i];
            if (m._biscuit && m.content) {
                beforeChars = m.content.length;
                var text = m.content;

                // Step 1: absolut — 剥离 ╔K...╚ 体部
                if (req.action === 'absolut' || req.action === 'editonly' || req.action === 'onlyfacts') {
                    text = text.replace(/\n╔K\n[\s\S]*?\n╚(?=\n|$)/g, '\n');
                }

                // Step 2: edit only — 在前者基础上仅保留写工具头行
                if (req.action === 'editonly' || req.action === 'onlyfacts') {
                    var lines = text.split('\n');
                    var filtered = [];
                    var WRITE_TOOLS_RE = /\[A → (edit_file|write_file|create_file|delete_file|revert_file)\]/;
                    for (var li = 0; li < lines.length; li++) {
                        var line = lines[li];
                        var keep = false;
                        if (/^(Q:|A:|=== F|\[S\]|\s*$)/.test(line)) keep = true;
                        if (WRITE_TOOLS_RE.test(line)) keep = true;
                        if (keep) filtered.push(line);
                    }
                    text = filtered.join('\n');
                }

                // Step 3: only facts
                if (req.action === 'onlyfacts') {
                    var _blocks = text.split(/\n(?==== F\d+ )/);
                    if (_blocks.length < 2) {
                        _respond({ type: 'qqq-compress-res', action: 'onlyfacts', questId: qid, ok: false, error: '楼层数不足（需≥2）' });
                        return;
                    }
                    var _totalChars = 0;
                    var _blockChars = [];
                    for (var _bi = 0; _bi < _blocks.length; _bi++) {
                        var _bc = _blocks[_bi].length;
                        _blockChars.push(_bc);
                        _totalChars += _bc;
                    }
                    var _half = Math.floor(_totalChars / 2);
                    var _acc = 0;
                    var _splitIdx = 1;
                    for (var _bi2 = 0; _bi2 < _blocks.length; _bi2++) {
                        _acc += _blockChars[_bi2];
                        if (_acc >= _half) { _splitIdx = _bi2; break; }
                    }
                    if (_splitIdx < 1) _splitIdx = 1;
                    var _hText = _blocks.slice(0, _splitIdx).join('\n');
                    var _rText = _blocks.slice(_splitIdx).join('\n');
                    if (_hText.length < 32000) {
                        _respond({ type: 'qqq-compress-res', action: 'onlyfacts', questId: qid, ok: false, error: 'h原料 < 32K，无需提取 facts', beforeChars: beforeChars, afterChars: beforeChars });
                        return;
                    }
                    var _bulletDir = '';
                    var _bulletPath = '';
                    try {
                        var _root2 = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
                        if (_root2) {
                            _bulletDir = _root2.replace(/\\/g, '/') + '/_qqq/bullet';
                            var _ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
                            _bulletPath = _bulletDir + '/bullet_' + _ts + '_' + (qid || 'q0') + '_fcts.txt';
                            var _bridge2 = window.parent && window.parent.qqqideBridge;
                            if (_bridge2 && _bridge2.fs) {
                                try { await _bridge2.fs.mkdir(_bulletDir); } catch (_) { }
                                await _bridge2.fs.write(_bulletPath, _hText);
                            }
                        }
                    } catch (_be) {
                        _respond({ type: 'qqq-compress-res', action: 'onlyfacts', questId: qid, ok: false, error: '子弹写入失败: ' + (_be.message || 'unknown') });
                        return;
                    }
                    m.content = _rText;
                    afterChars = _rText.length;
                    found = true;
                    if (ag._ctx && typeof _parseBiscuitFromContent === 'function') {
                        ag._ctx.biscuitLines = _parseBiscuitFromContent(_rText);
                        ag._ctx.lastCompressedFloor = ag._ctx.totalFloors || ag._ctx.biscuitLines.length || 0;
                        ag._ctx.narrative = 'biscuit:' + ag._ctx.biscuitLines.length;
                    }
                    if (typeof _writeCtxJson === 'function') {
                        _writeCtxJson(qid, ag._ctx).catch(function () { });
                    }
                    // ★ 立即刷新 ctx-btn（r 已替换背包变小）
                    ag._lastApiPromptTokens = 0;
                    ag._lastApiTotalTokens = 0;
                    ag._lastApiCompletionTokens = 0;
                    if (typeof updateCtxBtn === 'function') updateCtxBtn();
                    // ★ 持久化 token 元数据到 quest.sq3（防重启恢复旧值→ctx-btn 显示僵尸数字）
                    if (typeof questStore !== 'undefined' && questStore.save) {
                        questStore.save(qid, { lastApiPromptTokens: 0, lastApiTotalTokens: 0, lastApiCompletionTokens: 0 }).catch(function () { });
                    }
                    _respond({
                        type: 'qqq-compress-res', action: 'onlyfacts', questId: qid, ok: true,
                        beforeChars: beforeChars, afterChars: afterChars, status: 'floor-starting'
                    });
                    try {
                        var _savedInput = typeof $input !== 'undefined' ? $input.value : '';
                        var _bulletRef = '从以下对话历史提取关键事实列表（尽量提取30-40条，每条一行以"- "开头，仅提取不编造，直接回复不要调用任何工具）：\n\n📎"' + _bulletPath + '"';
                        if (typeof _buildSendIntent === 'function' && typeof _executeSend === 'function') {
                            var _intent = _buildSendIntent(qid, _bulletRef, { type: 'compress', compressFloor: true, tierIndex: 4, noTools: true });
                            await _executeSend(_intent);
                        }
                        if (typeof $input !== 'undefined') { $input.value = _savedInput; }
                        _respond({
                            type: 'qqq-compress-res', action: 'onlyfacts', questId: qid, ok: true,
                            beforeChars: beforeChars, afterChars: afterChars, status: 'done'
                        });
                    } catch (_ce) {
                        _respond({
                            type: 'qqq-compress-res', action: 'onlyfacts', questId: qid, ok: false,
                            error: 'Facts 提取失败: ' + (_ce.message || 'unknown'), beforeChars: beforeChars, afterChars: afterChars
                        });
                    }
                    return;
                }

                // absolut / editonly: 直接应用结果
                m.content = text;
                afterChars = text.length;
                found = true;

                // ★ V19: 持久化 ctx.json — 始终执行，不依赖 ag._ctx 预初始化
                //   旧代码有两条隐蔽失败路径：① ag._ctx 为 null → 跳过 ② _writeCtxJson 静默 return false
                if (!ag._ctx) ag._ctx = {};
                // 优先用 _parseBiscuitFromContent，不可用时手动构建
                if (typeof _parseBiscuitFromContent === 'function') {
                    ag._ctx.biscuitLines = _parseBiscuitFromContent(text);
                } else {
                    // 兜底：按 === F 分段手动构建 biscuitLines
                    var _manualParts = text.split(/\n(?==== F\d+ )/);
                    var _manualLines = [];
                    for (var _mpi = 0; _mpi < _manualParts.length; _mpi++) {
                        var _mpt = _manualParts[_mpi].trim();
                        if (!_mpt) continue;
                        var _mfm = _mpt.match(/^=== F(\d+)/);
                        if (_mfm) _manualLines.push({ n: parseInt(_mfm[1], 10), text: _mpt });
                    }
                    _manualLines.sort(function(a,b) { return a.n - b.n; });
                    ag._ctx.biscuitLines = _manualLines;
                }
                ag._ctx.lastCompressedFloor = ag._ctx.totalFloors || ag._ctx.biscuitLines.length || 0;
                ag._ctx.narrative = 'biscuit:' + (ag._ctx.biscuitLines.length || 0);
                ag._ctx.totalFloors = ag._ctx.totalFloors || ag._ctx.biscuitLines.length || 0;

                // ★ 持久化：await 确保落盘，不火后不理
                if (typeof _writeCtxJson === 'function') {
                    try { await _writeCtxJson(qid, ag._ctx); } catch (_) { }
                }
                // ★ 立即刷新 ctx-btn（背包已变小）
                ag._lastApiPromptTokens = 0;
                ag._lastApiTotalTokens = 0;
                ag._lastApiCompletionTokens = 0;
                if (typeof updateCtxBtn === 'function') updateCtxBtn();
                // ★ 持久化 token 元数据到 quest.sq3（防重启恢复旧值→ctx-btn 显示僵尸数字）
                if (typeof questStore !== 'undefined' && questStore.save) {
                    questStore.save(qid, { lastApiPromptTokens: 0, lastApiTotalTokens: 0, lastApiCompletionTokens: 0 }).catch(function () { });
                }
                break;
            }
        }

        if (req.action !== 'onlyfacts') {
            _respond({
                type: 'qqq-compress-res',
                action: req.action,
                questId: qid,
                ok: found,
                beforeChars: beforeChars,
                afterChars: afterChars,
                error: found ? null : 'No biscuit message found'
            });
        }

    } catch (_err) {
        _respond({ type: 'qqq-compress-res', action: req.action, questId: qid, ok: false, error: '内部错误: ' + (_err.message || 'unknown') });
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
        var token = (_activeAgent && _activeAgent._token) || ((typeof getLoginToken === 'function') ? getLoginToken() : '');
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
        _activeAgent._streamBuf = '';
        _activeAgent._streamCodeFenceOpen = false;
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
    // ★ 键入框有文字时暂停队列，保护用户正在编辑的内容不被覆盖
    if (inputText) {
        _queuePaused = true;
        renderQueueStrip();
        return;
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
                // ★ 快照原始文本，取消时还原
                var originalText = q.text;
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
                    q.text = originalText;
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
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show(_noAgentMsg, { type: 'warning', duration: 4000 }); } catch (_) { }
        return;
    }
    if (_queue.length >= QUEUE_MAX) {
        var _fullMsg = (typeof _i === 'function') ? _i('ai.queue.full', '队列限宽3，请等待上一条消息发出。') : '队列限宽3，请等待上一条消息发出。';
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show(_fullMsg, { type: 'warning', duration: 4000 }); } catch (_) { }
        return;
    }
    var text = getInputText().trim();
    if (!text) return;
    // ★ 背包：冻结当前全部键入状态
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
    // ★ 空闲时立即触发：若当前无发送/无流式/未暂停，直接排水
    if (!_sending && !streaming && !_queuePaused) {
        _triggerQueueSend();
    }
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

    // ★ 容器 — 包裹 track+thumb，hover 挂在容器上保证永不闪烁
    // 关键：sync() 频繁移 thumb，只有容器不动的 mouseenter/leave 才可靠
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:absolute; right:-1px; top:0; bottom:0; width:12px; z-index:50;';

    // 滑轨（水箱）— wrapper 子元素
    var track = document.createElement('div');
    var co0 = _qhColors();
    track.style.cssText = 'position:absolute; right:0; top:0; bottom:0; width:9px; ' +
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

    // 滑块（独立渲染，贴合水箱左侧，与水箱零交合）— wrapper 子元素
    var thumb = document.createElement('div');
    var co = _qhColors();
    thumb.style.cssText = 'position:absolute; right:9px; width:2px; min-height:24px; border-radius:0; z-index:2; ' +
        'display:none; background:' + co.c + '; cursor:pointer; ' +
        'transition: width 0.1s ease, right 0.1s ease, background 0.1s ease;';

    // hover 展开/收缩 — 挂在 wrapper 上，容器永不动，sync() 再频繁也不触发 mouseleave
    function _expandThumb() {
        thumb.style.width = '10px'; thumb.style.right = '0px';
        thumb.style.background = _qhColors().c;
    }
    function _shrinkThumb() {
        thumb.style.width = '2px'; thumb.style.right = '9px';
        thumb.style.background = _qhColors().c;
    }
    wrapper.addEventListener('mouseenter', _expandThumb);
    wrapper.addEventListener('mouseleave', _shrinkThumb);

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

    // 初始 + 内容变化 + 容器尺寸变化（编辑框增高/变窄→messages 缩/涨→重算）
    setTimeout(sync, 50);
    var obs = new MutationObserver(function () { setTimeout(sync, 30); });
    obs.observe(el, { childList: true, subtree: true });
    if (typeof ResizeObserver !== 'undefined') {
        var resizeObs = new ResizeObserver(function () { sync(); });
        resizeObs.observe(el);
    }

    // 主题切换 → 立即刷滑块色 + 滑轨底色 + 粒子色
    var themeObs = new MutationObserver(function () {
        var co2 = _qhColors();
        thumb.style.background = co2.c;
        for (var i = 0; i < _bubbles.length; i++) {
            _bubbles[i].style.background = co2.bubbleC;
        }
        // trackBg 复用 _updateBubbles 的统一判定（panel-focused + 非编辑态）
        _updateBubbles();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // ★ 是否在编辑框内（键入法/编辑时 12qw 键不响应滚动 → 水箱粒子隐藏）
    function _isEditingFocus() {
        var ae = document.activeElement;
        if (!ae) return false;
        return ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable;
    }
    function _trackBg(on) {
        if (!on) return 'transparent';
        var dk = document.documentElement.getAttribute('data-theme') === 'dark';
        return dk
            ? 'linear-gradient(to bottom, rgba(95,105,45,0.12), rgba(145,155,80,0.45))'
            : 'linear-gradient(to bottom, rgba(75,85,30,0.15), rgba(115,125,60,0.5))';
    }
    function _updateBubbles() {
        var on = document.body.classList.contains('panel-focused') && !_isEditingFocus();
        track.style.background = _trackBg(on);
        _setBubbles(on);
    }

    // 焦点切换 → 水箱显隐 + 粒子显隐
    var focusObs = new MutationObserver(_updateBubbles);
    focusObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // 编辑框焦点进出 → 水箱粒子联动（12qw 键不可用时不显示）
    document.addEventListener('focusin', _updateBubbles);
    document.addEventListener('focusout', _updateBubbles);

    // 初始焦点状态
    if (document.body.classList.contains('panel-focused') && !_isEditingFocus()) _setBubbles(true);

    wrapper.appendChild(track);
    wrapper.appendChild(thumb);
    host.appendChild(wrapper);
})();