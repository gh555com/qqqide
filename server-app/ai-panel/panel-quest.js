// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
'use strict';

// ★ 就绪门控信号（2026-09-24）: 「主窗口 core 完成 + 中面板恢复完成」= 壳层撤启动面板的
//   唯一信号（用户可交互的瞬间 = IDE 亮相的瞬间，消灭「进去就点聊天框被长任务卡」）。
//   链路: 此处 postMessage → 主窗口 shell.js 校验转发 → preload qqqide:renderer-ready。
//   仅中面板（panel 1）；20s 兜底（正常 3~10s；异常路径也保证信号必达，壳层 25s 超时垫底）。
var _uiReadySignaled = false;
function _signalUiReady() {
    if (_uiReadySignaled) return;
    var pid = null;
    try { pid = _panelId; } catch (_) { pid = null; }
    if (pid !== 1) return;
    _uiReadySignaled = true;
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'qqq-ai-ready', panel: 1 }, '*'); } catch (_) { }
}
setTimeout(_signalUiReady, 20000);

// ═══ Agent Pool: ★ parent.__qqq_agentPool（父窗口共享，单一真相源） ═══
var _activeAgent = null;  // current visible quest's agent

// ═══ Card Pool: 终极 Card Queue 架构 ═══
var cardPool = null;  // 在 bindMainProject 中初始化（需要 #messages DOM 就绪）
window.cardPool = null;  // 会在 bindMainProject 中同步更新

// Backward-compatible 'agent' getter/setter — all existing agent.xxx redirects to _activeAgent
Object.defineProperty(window, 'agent', {
    get: function () { return _activeAgent; },
    set: function (v) { _activeAgent = v; },
    enumerable: true, configurable: true
});

function _getOrCreateAgent(questId) {
    var pool = parent.__qqq_agentPool;
    if (!pool[questId]) {
        var ag = new AgentLoop({ log: function (msg) { /* agent-loop: only critical */ if (msg.indexOf('\u2717') >= 0 || msg.indexOf('\u26d4') >= 0 || msg.indexOf('\u26a0') >= 0 && msg.indexOf('\u26a0 guide ack:') < 0) console.warn('[ai-agent:' + questId + ']', msg); } });
        ag._activeAiDiv = null;
        ag._floorTimerId = null;
        ag._floorStartPerf = 0;
        ag._floorCurrentTiming = null;
        ag._streaming = false;
        ag._queue = [];
        ag._queuePaused = false;
        ag._queuePausedManual = false; // ★ 人工暂停标志（2026-08-20），见 panel-state.js
        ag._questId = questId;  // ★ per-agent questId for trace/cross-panel isolation
        pool[questId] = ag;
    }
    return pool[questId];
}

// ---- Quest Management ----
var questStore = new QuestStore();
window.questStore = questStore;  // 暴露到全局，供 card-pool.js 等外部模块访问
questStore.requireProjectForWrites(true);  // 底层守卫：无主项目禁止一切写入

// ★ 2026-09-19: 合并式 quest 元数据补齐（唯一入口）——questStore.save 是「整行替换」语义：
//   只传部分字段会把 totalCostGe/currentFloorNum 等其余字段整体铲掉（折叠/压缩清零只传 3 个
//   token 字段即踩此坑）。凡「只改几个字段」的写盘必须走本函数：读现值 → 合并 patch → 写回。
//   永不 reject（静默失败优于误伤）；_rootDir 未绑定等窗口期天然 no-op。
async function _questMetaPatch(qid, patch) {
    try {
        if (!qid || !patch || typeof questStore === 'undefined' || !questStore.load || !questStore.save) return;
        var _m = (await questStore.load(qid)) || {};
        for (var _k in patch) { if (Object.prototype.hasOwnProperty.call(patch, _k)) _m[_k] = patch[_k]; }
        await questStore.save(qid, _m);
    } catch (_) { }
}

// ★ 绑定兜底（2026-08-08）：boot 8s 轮询拿不到主项目（viewport OS 恢复慢 / 面板早于视口就绪 /
//   postMessage 在 listener 注册前发出丢失）→ 转 3s 慢轮询（最长 10 分钟），
//   主项目一旦就绪立即绑定 → 根治「空白窗口手动添加主文件夹后三面板仍全空」
(function () {
    var _bfN = 0;
    var _bfT = setInterval(function () {
        if (_workspaceRoot) { clearInterval(_bfT); return; }
        if (_lockBlocked) { clearInterval(_bfT); return; }
        if (++_bfN > 200) { clearInterval(_bfT); return; }
        bindMainProject();
    }, 3000);
})();

// 窗口关闭时刷盘 + 释放所有权（翼板关闭=iframe隐藏，不触发 beforeunload）
//   应用真正退出 → 释放所有 quest 所有权，防重启后僵尸状态阻塞
window.addEventListener('beforeunload', function () {
    if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
        saveQuestUIState(questActiveId);
        // ★ 释放所有权（仅父注册表；quest.sq3 不再存储 _owner）
        if (questActiveId && !_isDraft(questActiveId)) {
            _parentReleaseQuest(questActiveId);
            _broadcast('owner-released', questActiveId);
        }
        // ★ 强制刷盘：setNow 虽已标记脏 + 启动异步 flush，但 beforeunload
        //   可以再加一把同步 flush（_onBeforeUnload 内的同步 fire-and-forget IPC）
        try { onlyStore.flush(); } catch (_) { }
    }
});

// 监听视口变化：主文件夹改变时重新绑定
window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'qqq-ai-viewport-changed') {
        // ★ 2026-08-13：主文件夹被占用清空视口 / 用户移除后 → 已绑定面板必须解除绑定
        //   （reload 后未绑定，等待用户添加新项目）——否则面板仍绑旧项目而视口已空 → 不一致
        var _newMain = null;
        if (e.data.projects && e.data.projects.length > 0 && e.data.projects[0].path) {
            _newMain = e.data.projects[0].path.replace(/\\/g, '/').replace(/\/$/, '');
        }
        if (_workspaceRoot && !_newMain) {
            try { saveQuestUIState(questActiveId); } catch (_) { }
            try { if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) { onlyStore.flush(); } } catch (_) { }
            console.warn('[workspace] main folder cleared from viewport — reloading panel to unbind');
            try { window.location.reload(); } catch (_) { }
            return;
        }
        // ★ 2026-08-13：视口变化 = 用户操作（手动添加/更换）→ 复位锁拒绝标记，允许重新绑定。
        //   旧实现 _lockBlocked 永不复位 → 残血窗口手动添加新项目后面板永不绑定。
        //   若新项目仍被占用 → _initWorkspace 再次 blocked → 再清空，闭环收敛。
        if (_lockBlocked) _lockBlocked = false;
        if (_workspaceRoot && _newMain && _newMain !== _workspaceRoot) {
            try { saveQuestUIState(questActiveId); } catch (_) { }
            try { if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) { onlyStore.flush(); } } catch (_) { }
            console.warn('[workspace] main folder changed: ' + _workspaceRoot + ' -> ' + _newMain + ' — reloading panel to rebind');
            try { window.location.reload(); } catch (_) { }
            return;
        }
        bindMainProject();
    }
    // 主题变更由父窗口 qqqide-theme.js 统一持久化到 only.sq3
});

var _draftId = '_draft_p' + _panelId;
var questActiveId = _draftId;
var _questsInited = false;
function _isDraft(id) { return typeof id === 'string' && id.indexOf('_draft_') === 0; }

// ★ 豆沙包：更新父窗口 draftFlags 中央注册表（跨三面板唯一真理源）
function _updateDraftFlag(id) {
    if (!id || _isDraft(id)) return;
    if (!parent) return;
    var flags = parent.__qqq_draftFlags;
    if (!flags) { parent.__qqq_draftFlags = {}; flags = parent.__qqq_draftFlags; }
    var state = questUIStates[id];
    var hasText = state && state.inputValue && state.inputValue.trim().length > 0;
    if (!flags[id]) flags[id] = {};
    var oldVal = flags[id]['p' + _panelId];
    flags[id]['p' + _panelId] = hasText;
    // 全为 false → 清理
    var any = flags[id].p0 || flags[id].p1 || flags[id].p2;
    if (!any) delete flags[id];
    // 仅变化时广播
    if (oldVal !== hasText) {
        _broadcast('draft-changed', id);
    }
}

// ★ 检查某 quest 是否有草稿（任一 panel 有未发送文本）
function _hasDraftFlag(id) {
    if (!id || !parent || !parent.__qqq_draftFlags) return false;
    var f = parent.__qqq_draftFlags[id];
    return !!(f && (f.p0 || f.p1 || f.p2));
}

// ═══ per-quest UI memory state（零开销快照，quest 切换时同步读写） ═══
var questUIStates = {};

function saveQuestUIState(id) {
    if (!id) return;
    var imgs = new Array(pendingImages.length);
    for (var i = 0; i < pendingImages.length; i++) {
        var pi = pendingImages[i];
        imgs[i] = { id: pi.id, base64: pi.base64, dataUrl: pi.dataUrl };
    }
    questUIStates[id] = {
        inputValue: $input.value,
        inputCaret: $input.selectionStart,
        pendingImages: imgs,
        selectedTier: selectedTier,
        scrollTop: $messages.scrollTop
    };
    // ★ 三面板独立快照：左/中/右各自保存到 ai.uiStates.{panelId}
    //   使用 setNow 立即刷盘（未可用 set，否则 beforeunload 可能来不及 flush）
    if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
        onlyStore.setNow('ai.uiStates.' + _panelId, questUIStates);
    }
    // ★ activeQuestId 走 bridge.fs.write 原子 JSON（零踩踏），不依赖 onlyStore
    if (id && !_isDraft(id)) {
        _persistPanelResume(id);
    }
    // ★ 豆沙包：更新父窗口 draftFlags 中央注册表
    _updateDraftFlag(id);
}

async function restoreQuestUIState(id) {
    var state = questUIStates[id];
    // ★ per-quest 等级偏好（2026-08-27）：ai.questTier.{questId} 三面板共享唯一 key
    //   优先级：per-quest 偏好 → 面板快照旧值（兼容迁移）→ 全局默认
    //   → 切面板/切后台/刷新/重启均保持用户明确选择的等级
    var tier = null;
    try {
        if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
            var _qTier = await onlyStore.getAsync('ai.questTier.' + id);
            if (typeof _qTier === 'number') tier = _qTier;
        }
    } catch (_) { }
    if (tier == null) {
        tier = (state && state.selectedTier != null) ? state.selectedTier : ((typeof _getDefaultTier === 'function') ? _getDefaultTier() : 3);
    }
    if (state) {
        $input.value = state.inputValue || '';
        $input._resetUndo();
        pendingImages = state.pendingImages || [];
        // ★ 旧数据可能为 null（A 已改为信息弹窗），回退默认
        selectedTier = tier;
        updateTierButtons(tier);
        renderImageStrip();
        updateQueueBtn();
        if (typeof state.inputCaret === 'number') {
            $input.setSelectionRange(state.inputCaret, state.inputCaret);
        }
    } else {
        $input.value = '';
        $input._resetUndo();
        pendingImages = [];
        selectedTier = tier;
        updateTierButtons(tier);
        renderImageStrip();
        updateQueueBtn();
    }
}

async function initQuests() {
    if (!_hasMainProject()) {
        // [silent] initQuests SKIP: no main project
        return;
    }
    // [silent] initQuests START
    // ★ 中心大脑：三面板读同一 parent.__qqq_questIndex，主面板扫盘后侧面板立即可见
    var quests = await questStore.list();

    // ★ B+ 方案：懒惰重命名扫描 — 仅中面板执行一次（启动时）
    //   同步等待扫描完成，消除 lazyRenameScan 与后续 loadAllFloors 的竞态窗口
    if (_panelId === 1) {
        try {
            var scanResult = await questStore.lazyRenameScan();
            if (scanResult && scanResult.fixed > 0) {
                console.log('[lazyRenameScan] fixed ' + scanResult.fixed + ' quest dir(s), failed=' + scanResult.failed + ', skipped=' + scanResult.skipped + ', collisions=' + scanResult.collisions);
                // 修了目录 → 重新加载索引让侧面板感知
                await questStore.invalidateIndex();
            }
        } catch (e) {
            console.warn('[lazyRenameScan] error:', e && e.message);
        }
    }
    // 侧面板：等待中面板扫描完成（最多 8s）
    if (_panelId !== 1) {
        for (var _rsw = 0; _rsw < 40; _rsw++) {
            try {
                if (parent && (parent.__qqq_renameScanDone || (!parent.__qqq_renameScanInProgress && parent.__qqq_renameScanResult !== null))) break;
            } catch (_) { }
            await new Promise(function (r) { setTimeout(r, 200); });
        }
    }
    // [silent] list returned
    if (quests.length === 0) {
        questActiveId = _draftId;
    } else {
        // ★ 面板 resume → (仅中面板) global active → first quest
        //   翼板跳过 global active，避免启动时三面板抢同一 quest
        var _fromResume = await _readPanelResume();
        if (_fromResume && quests.find(function (s) { return s.id === _fromResume; })) {
            questActiveId = _fromResume;
        } else if (_panelId === 1) {
            // 仅中面板：降级到 global active → first quest
            questActiveId = await questStore.getActiveId();
            if (!questActiveId || !quests.find(function (s) { return s.id === questActiveId; })) {
                questActiveId = quests.length > 0 ? quests[0].id : _draftId;
            }
        } else {
            // 翼板：无 resume → 直接草稿，不抢中面板的 quest
            questActiveId = _draftId;
        }
    }

    if (questActiveId && !_isDraft(questActiveId)) {
        // ★ 原子申领：check+claim 合为一步，消灭「check时无人→claim时已被抢」竞态
        var _initSyncOwner = _parentGetQuestOwner(questActiveId);
        if (_initSyncOwner === _panelId) {
            // 本面板已持有（Ctrl+R 重载场景）→ 直接继续
        } else if (_initSyncOwner !== undefined) {
            // 已被其他面板持有 → 自动打开那个翼板 + 跳回草稿
            if (_initSyncOwner === 0 || _initSyncOwner === 2) {
                try { parent.postMessage({ type: 'qqq-open-wing', panel: _initSyncOwner }, '*'); } catch (_) { }
            }
            questActiveId = _draftId;
        } else if (!_parentTryClaimQuest(questActiveId)) {
            // 与另一面板同时竞争 → 败方跳回草稿
            var _raceOwner = _parentGetQuestOwner(questActiveId);
            if (_raceOwner === 0 || _raceOwner === 2) {
                try { parent.postMessage({ type: 'qqq-open-wing', panel: _raceOwner }, '*'); } catch (_) { }
            }
            questActiveId = _draftId;
        }
        // else: tryClaim 成功 → 本面板已原子持有，继续加载
    }

    if (questActiveId && !_isDraft(questActiveId)) {
        // [silent] loading data for quest
        _activeAgent = _getOrCreateAgent(questActiveId);
        // ★ 清除 Ctrl+R 重载后 parent.__qqq_agentPool 中残留的旧 sending 态
        //   否则 _restoreAgentFromStore 的守卫 (stopState==='sending') 会跳过恢复
        if (_activeAgent._stopState !== 'idle') {
            _activeAgent.setStopState('idle');
            _activeAgent._streaming = false;
            _activeAgent._floorCompletedCleanly = false;
        }
        await cardPool.switchTo(questActiveId);
        // ★ 恢复 agent 全量状态（conversation + metadata）
        await _restoreAgentFromStore(questActiveId, _activeAgent);

        // ★ 绑定 _activeAiDiv — 与 switchQuest 一致（init 缺此 → 红框无锚点插入）
        var _initCard = cardPool.getCard(questActiveId);
        if (_initCard) {
            var _initFloorNums = Object.keys(_initCard.floorDOM || {}).map(Number).sort(function (a, b) { return b - a; });
            for (var _ifi = 0; _ifi < _initFloorNums.length; _ifi++) {
                var _ifDom = _initCard.floorDOM[_initFloorNums[_ifi]];
                if (_ifDom && _ifDom.aiEl) {
                    _activeAgent._activeAiDiv = _ifDom.aiEl;
                    if (_activeAgent._floorTimerId) {
                        clearInterval(_activeAgent._floorTimerId);
                        _activeAgent._floorTimerId = null;
                    }
                    break;
                }
            }
        }

        // ★ V14: 数据驱动重建红框（_renderAllErrorBoxes 从 _questErrorState 全量渲染）
        if (_activeAgent && _activeAgent._questErrorState && typeof _renderAllErrorBoxes === 'function') {
            _renderAllErrorBoxes(_activeAgent);
        }
        // ★ V14: 重建粉色「继续」气泡（持久化到 _questErrorState 中，card 重建后 restore）
        if (_activeAgent && _activeAgent._questErrorState) {
            var _bubbleFloors = Object.keys(_activeAgent._questErrorState).map(Number).sort(function (a, b) { return a - b; });
            for (var _bfi = 0; _bfi < _bubbleFloors.length; _bfi++) {
                var _bfn = _bubbleFloors[_bfi];
                var _bst = _activeAgent._questErrorState[_bfn];
                if (!_bst || !_bst.bubbleText) continue;
                var _bCard = cardPool && cardPool.getActive();
                if (!_bCard || !_bCard.floorDOM || !_bCard.floorDOM[_bfn] || !_bCard.floorDOM[_bfn].aiEl) continue;
                var _bubbleEl = addMessageEl('user', _bst.bubbleText);
                if (_bubbleEl) {
                    _bubbleEl._floor = _bfn;
                    var _bAiEl = _bCard.floorDOM[_bfn].aiEl;
                    if (_bAiEl && _bAiEl.parentNode) _bAiEl.parentNode.insertBefore(_bubbleEl, _bAiEl);
                }
            }
        }

        // ★ 刷新按钮状态（init 缺此 → restart 后 fatal 态按钮未被锁死且无视觉反馈）
        if (typeof setStreaming === 'function') setStreaming(!!(_activeAgent && _activeAgent._streaming));

        await restoreQuestUIState(questActiveId);
        // ★ 延迟恢复滚动位置（等 DOM 布局完成后）
        // 自动恢复标记：连接中断自愈 reload 后强制滚到底
        var _forceBottom = false;
        try { if (sessionStorage.getItem('__qqq_scroll_bottom') === '1') { _forceBottom = true; sessionStorage.removeItem('__qqq_scroll_bottom'); } } catch (_) { }
        var _savedState = questUIStates[questActiveId];
        if (_forceBottom) {
            _scrollToBottomDeferred(true);
        } else if (_savedState && typeof _savedState.scrollTop === 'number') {
            _restoreScrollDeferred(_savedState.scrollTop);
        } else {
            _scrollToBottomDeferred(true);
        }
        renderQueueStrip();
        // ★ 声明所有权（仅父注册表；quest.sq3 不再参与）
        _parentClaimQuest(questActiveId);
        _broadcast('owner-claimed', questActiveId);
        updateCostDisplay();
        updateCtxBtn();
    } else {
        // draft 或无活跃 quest：清零上下文显示，不发起 DB 查询
        _activeAgent = null;
        _queueFallback = [];
        renderQueueStrip();
        updateCostDisplay();
        updateCtxBtn();
    }
    await renderTabs();
    // [silent] initQuests DONE
}

// ★ B+ 方案：窗口关闭/刷新前触发懒惰重命名扫描 — 仅中面板执行一次
//   由于 rename 操作可能在 beforeunload 时被浏览器限制（可能不完成），
//   我们异步触发（不 await），下次启动时会再次扫描修正
window.addEventListener('beforeunload', function () {
    if (window._lazyRenameShutdownTriggered) return;
    window._lazyRenameShutdownTriggered = true;
    // ★ 2026-08-10: 关闭时也执行扫描（会话中改名 → 关闭即落盘，不必等下次启动）。
    //   旧逻辑：启动扫描已置 __qqq_renameScanDone → 关闭扫描从未运行 → 改名要等下次启动才生效。
    //   先复位标记再触发；lazyRenameScan 内部 _renameScanInProgress / 目录锁防重入，
    //   改失败（窗口即将销毁/文件占用）→ 跳过，下次启动再扫（懒改语义）。
    try { if (parent) parent.__qqq_renameScanDone = false; } catch (_) { }
    if (_panelId === 1 && typeof questStore !== 'undefined' && questStore.hasProjectRoot && questStore.hasProjectRoot()) {
        questStore.lazyRenameScan().then(function (scanResult) {
            if (scanResult && scanResult.fixed > 0) {
                try { parent.__qqq_renameScanDone = true; } catch (_) { }
            }
        }).catch(function () { });
    }
});

// ═══ 面板 resume 持久化 — atomic JSON，三面板独立文件，零踩踏 ═══
var _RESUME_MAP = { 0: 'l', 1: 'c', 2: 'r' };
function _panelResumeKey() {
    return 'panel_re' + (_RESUME_MAP[_panelId] || 'c') + '.json';
}
async function _persistPanelResume(questId) {
    var root = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
    if (!root) return;
    var bridge = _getBridge();
    if (!bridge || !bridge.fs) return;
    var path = root + '/_qqq/alphal/' + _panelResumeKey();
    try {
        await bridge.fs.write(path, JSON.stringify({ activeQuestId: questId, updatedAt: Date.now() }));
    } catch (_) { }
}
async function _readPanelResume() {
    var root = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
    if (!root) return null;
    var bridge = _getBridge();
    if (!bridge || !bridge.fs) return null;
    var path = root + '/_qqq/alphal/' + _panelResumeKey();
    try {
        var raw = await bridge.fs.read(path);
        if (!raw || typeof raw !== 'string') return null;
        var data = JSON.parse(raw);
        return data.activeQuestId || null;
    } catch (_) { return null; }
}
