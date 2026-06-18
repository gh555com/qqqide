'use strict';

async function _handleSyncMessage(msg) {
    if (!msg || msg.windowId === _windowId) return;
    // focus-request：焦点跳转
    if (msg.type === 'focus-request') {
        if (msg.targetWindow === _windowId || msg.targetPanel === _panelId) {
            // [silent] focus-request received
            _postToHost({ type: 'qqq-focus-window' });
            _setPanelFocus(true);
        }
        return;
    }
    // quest 列表变更
    if (msg.type === 'quest-created' || msg.type === 'quest-deleted' || msg.type === 'quest-renamed') {
        questStore.invalidateIndex();
        await updateQuestTofu();
        return;
    }
    if (_isDraft(questActiveId)) return;
    // [silent] sync recv
    try {
        switch (msg.type) {
            case 'quest-saved':
            case 'floor-saved':
                if (msg.questId === questActiveId && typeof msg.floorNum === 'number' && agent && agent._ctx) {
                    agent._ctx.totalFloors = Math.max(agent._ctx.totalFloors, msg.floorNum);
                }
                if (msg.questId === questActiveId) {
                    updateCostDisplay();
                    updateCtxBtn();
                }
                break;
            case 'owner-claimed':
                // 另一面板抢走了我们正在看的 quest → 自动卸载，跳回空白
                if (msg.questId === questActiveId && msg.windowId !== _windowId) {
                    // [silent] quest claimed by other panel, unloading
                    _unloadQuest();
                }
                break;
            case 'owner-released':
                // 另一面板释放了 quest — 不做任何事（我们不自动加载）
                break;
        }
    } catch (e) {
        console.warn('[quests] _handleSyncMessage error:', e && e.message);
    }
}

// ═══ Agent Pool: one AgentLoop per quest, simultaneous multi-quest work ═══
var agentPool = {};       // { questId: AgentLoop }
window.agentPool = agentPool;  // 暴露给 card-pool.js 驱逐时使用
var _activeAgent = null;  // current visible quest's agent
var _capturedAgent = null;   // captured ref for async callbacks (autoSave, onDone)
var _capturedQuestId = '';   // captured quest id for async callbacks

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
    if (!agentPool[questId]) {
        var ag = new AgentLoop({ log: function (msg) { /* agent-loop: only critical */ if (msg.indexOf('\u2717') >= 0 || msg.indexOf('\u26d4') >= 0 || msg.indexOf('\u26a0') >= 0 && msg.indexOf('\u26a0 guide ack:') < 0) console.warn('[ai-agent:' + questId + ']', msg); } });
        ag._activeAiDiv = null;
        ag._floorTimerId = null;
        ag._floorStartPerf = 0;
        ag._floorCurrentTiming = null;
        ag._streaming = false;
        ag._sending = false;
        ag._queue = [];
        agentPool[questId] = ag;
    }
    return agentPool[questId];
}

// ---- Quest Management ----
var questStore = new QuestStore();
window.questStore = questStore;  // 暴露到全局，供 card-pool.js 等外部模块访问
questStore.requireProjectForWrites(true);  // 底层守卫：无主项目禁止一切写入

// ═══ 工作空间 — 绑定主文件夹 ═══
// 铁律：一个窗口一个主文件夹，终身不变。要换主文件夹只能开新窗口。
//       因此不存在 workspace 切换，只有首次绑定（应用重启时）。
//       iframe 永不销毁（翼板开关 = width 显隐），所以每面板仅绑定一次。

// 初始化工作空间
async function _initWorkspace(root) {
    // [silent] workspace init
    _workspaceRoot = root;

    // ★ 只有中面板（panelId=1）申请项目锁；左右翼共享
    onlyStore.init(root);
    // ★ 从 onlyStore 恢复或持久化 _windowId（唯一真理源，跨 iframe 重建不变）
    //   用 setNow 立即写盘（非惰性），确保首次启动即持久化，防退出时丢失导致下次新 ID
    var _onlyWindowKey = 'ai.panel.' + _panelId + '.windowId';
    try {
        var _persistedWid = await onlyStore.getAsync(_onlyWindowKey);
        if (_persistedWid && typeof _persistedWid === 'string') {
            _windowId = _persistedWid;
            // [silent] restored _windowId
        } else {
            onlyStore.setNow(_onlyWindowKey, _windowId);
            // [silent] persisted _windowId
        }
    } catch (e) { console.warn('[workspace] _windowId restore error:', e); }
    if (_panelId === 1) {
        var lockResult = await onlyStore.claimLock();
        if (!lockResult.ok) {
            console.warn('[workspace] BLOCKED: project locked (age=' + (lockResult.age / 1000).toFixed(1) + 's)');
            addMessageEl('error', '\u26a0\ufe0f 该项目已被另一个 QQQ 窗口打开，无法重复绑定。');
            if (window.parent) {
                try { window.parent.postMessage({ type: 'qqq-ai-viewport-remove-project', path: root }, '*'); } catch (_) { }
            }
            onlyStore.init(null);
            _workspaceRoot = null;
            return;
        }
        // 向主进程注册窗口↔项目映射（仅中面板）
        if (window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.window) {
            try { window.parent.qqqideBridge.window.claimProject(root).catch(function () { }); } catch (_) { }
        }
    }

    questStore.setProjectRoot(root);

    // ═══ Card Pool：首次绑定时创建（唯一一次） ═══
    if (typeof CardPool !== 'undefined') {
        cardPool = new CardPool($messages);
        window.cardPool = cardPool;
    } else {
        console.error('[card-pool] CardPool undefined — card-pool.js failed to load!');
    }

    // 迁移旧目录
    try {
        var bridge = _getBridge();
        if (bridge) {
            var oldAlphal = root + '/qqq/quests/alphal';
            var newAlphal = root + '/qqq/alphal';
            var oldStat = await bridge.fs.stat(oldAlphal);
            var newStat = await bridge.fs.stat(newAlphal);
            if (oldStat && !newStat) {
                // [silent] migrating alphal
                await bridge.fs.mkdir(newAlphal);
                await _copyAlphalDir(oldAlphal, newAlphal);
                try { await bridge.fs.remove(oldAlphal); } catch (_) { }
            }
        }
    } catch (e) { console.warn('[workspace] migration error', e); }

    // ★ 三面板独立快照：从 ai.uiStates.{panelId} 恢复（异步读，首次绕过缓存）
    var savedStates = await onlyStore.getAsync('ai.uiStates.' + _panelId);
    if (savedStates && typeof savedStates === 'object') {
        questUIStates = savedStates;
        // [silent] restored questUIStates
    }

    // 初始化 quest 列表
    _questsInited = true;
    // ★ 仅中面板做磁盘扫描 + 索引建仓（fs.list 只跑一次，左右翼复用缓存）
    if (_panelId === 1) {
        await questStore.list();
    }
    await initQuests();
    if (typeof loadQqqideProjectRules === 'function') {
        loadQqqideProjectRules(questStore.getProjectRoot());
    }
    if (typeof buildQqqideVisionContext === 'function') {
        buildQqqideVisionContext();
    }

    // ★ IPC sync：workspace-scoped channel
    try {
        var sb = _getSyncBridge();
        if (sb) {
            if (_syncUnsub) { _syncUnsub(); _syncUnsub = null; }
            var ch = _syncChannel();
            _syncUnsub = sb.onMessage(function (channel, data) {
                if (channel === ch) { _handleSyncMessage(data); }
            });
            // [silent] IPC sync subscribed
            questStore.onChange(function (payload) {
                _broadcast(payload.type, payload.questId, { floorNum: payload.floorNum, title: payload.title });
            });
        }
    } catch (e) { console.warn('[workspace] IPC sync unavailable:', e); }

    // [silent] workspace bound
}

// 入口：绑定主文件夹（仅首次，终身一次）
async function bindMainProject() {
    // 已绑定 → 跳过（同窗口不可切换主文件夹）
    if (_workspaceRoot) return;

    var root = null;
    if (window.parent && window.parent.qqqideViewport) {
        var main = window.parent.qqqideViewport.getMainProject();
        if (!main || !main.path) {
            // [silent] bindMainProject: no main project yet
            return;
        }
        root = main.path.replace(/\\/g, '/').replace(/\/$/, '');
    } else {
        return;
    }

    await _initWorkspace(root);
}

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
        onlyStore.flush();
    }
});

// 监听视口变化：主文件夹改变时重新绑定
window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'qqq-ai-viewport-changed') {
        bindMainProject();
    }
    // 主题变更 → 同步到 only.sq3（per-project 主题记忆）
    if (e.data && e.data.type === 'qqqide-theme-change' && typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
        onlyStore.set('theme', e.data.dark ? 'dark' : 'light');
    }
});

var _draftId = '_draft_p' + _panelId;
var questActiveId = _draftId;
var _questsInited = false;
function _isDraft(id) { return typeof id === 'string' && id.indexOf('_draft_') === 0; }

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
    if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
        onlyStore.set('ai.uiStates.' + _panelId, questUIStates);
    }
}

function restoreQuestUIState(id) {
    var state = questUIStates[id];
    if (state) {
        $input.value = state.inputValue || '';
        $input._resetUndo();
        pendingImages = state.pendingImages || [];
        selectedTier = state.selectedTier;
        updateTierButtons(selectedTier);
        renderImageStrip();
        updateQueueBtn();
        if (typeof state.inputCaret === 'number') {
            $input.setSelectionRange(state.inputCaret, state.inputCaret);
        }
    } else {
        $input.value = '';
        $input._resetUndo();
        pendingImages = [];
        selectedTier = 6;
        updateTierButtons(6);
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
    var quests = await questStore.list();
    // [silent] list returned
    if (quests.length === 0) {
        questActiveId = _draftId;
    } else {
        // ★ 三级恢复：per-panel 快照 → project global → first quest
        //   panelId 永恒不变（0=左,1=中,2=右），不像 windowId 跨会话更换
        var _perWindowKey = 'ai.panel.' + _panelId + '.activeQuestId';
        var _fromOnly = await onlyStore.getAsync(_perWindowKey);
        if (_fromOnly && quests.find(function (s) { return s.id === _fromOnly; })) {
            questActiveId = _fromOnly;
            // [silent] restored from per-window snapshot
            // 仅中面板更新全局 active（侧面板不污染全局状态）
            if (_panelId === 1) await questStore.setActiveId(questActiveId);
        } else if (_panelId === 1) {
            // 中面板无快照 → 回退到全局 active quest
            questActiveId = await questStore.getActiveId();
            // [silent] stored activeId from quest.sq3
            if (!questActiveId || !quests.find(function (s) { return s.id === questActiveId; })) {
                if (quests.length > 0) {
                    questActiveId = quests[0].id;
                    // [silent] activeId invalid, fallback to first
                    await questStore.setActiveId(questActiveId);
                }
            }
        } else {
            // 侧面板无快照 → 空白起点
            questActiveId = _draftId;
        }
    }

    if (questActiveId && !_isDraft(questActiveId)) {
        // ★ 同步去重：在加载数据前检查父注册表，避免白加载后再卸载
        var _initSyncOwner = _parentGetQuestOwner(questActiveId);
        if (_initSyncOwner !== undefined && _initSyncOwner !== _panelId) {
            // 已被其他面板持有 → 自动打开那个翼板 + 跳回草稿
            if (_initSyncOwner === 0 || _initSyncOwner === 2) {
                try { parent.postMessage({ type: 'qqq-open-wing', panel: _initSyncOwner }, '*'); } catch (_) { }
            }
            questActiveId = _draftId;
        }
    }

    if (questActiveId && !_isDraft(questActiveId)) {
        // [silent] loading data for quest
        _activeAgent = _getOrCreateAgent(questActiveId);
        await cardPool.switchTo(questActiveId);
        // ★ 恢复 agent 全量状态（conversation + metadata）
        await _restoreAgentFromStore(questActiveId, _activeAgent);
        restoreQuestUIState(questActiveId);
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

// ═══ 从 houses 数组 + A4 快照计算文件变更统计（持久化到 floorPayload.fileStats） ═══
// 优先使用 A4 快照数据（真实 before/after LCS diff），
// 无快照时回退到工具参数估算（不精确，仅兜底）
function _computeFileStats(houses, a4Snapshots) {
    // ★ 优先：A4 快照有真实 diff 数据
    if (a4Snapshots && typeof a4Snapshots === 'object') {
        var snapPaths = Object.keys(a4Snapshots);
        if (snapPaths.length > 0) {
            var snapAdded = 0, snapDeleted = 0;
            for (var si = 0; si < snapPaths.length; si++) {
                var s = a4Snapshots[snapPaths[si]];
                snapAdded += s.added || 0;
                snapDeleted += s.deleted || 0;
            }
            return { fileCount: snapPaths.length, added: snapAdded, deleted: snapDeleted };
        }
    }

    // ★ 兜底：从工具参数估算（不精确，edit_file 按 find/replace 行数计）
    houses = houses || [];
    var fileSet = {};
    var added = 0;
    var deleted = 0;
    for (var hi = 0; hi < houses.length; hi++) {
        var tools = houses[hi].tools || [];
        for (var ti = 0; ti < tools.length; ti++) {
            var t = tools[ti];
            var path = '';
            if (typeof t.args === 'string') {
                try { var p = JSON.parse(t.args); path = p.path || p.filePath || ''; } catch (_) { }
            } else if (t.args && typeof t.args === 'object') {
                path = t.args.path || t.args.filePath || '';
            }
            if (t.name === 'write_file' || t.name === 'create_file') {
                if (path) fileSet[path] = true;
                var content = '';
                if (typeof t.args === 'string') {
                    try { var pp = JSON.parse(t.args); content = pp.content || ''; } catch (_) { }
                } else if (t.args && t.args.content) {
                    content = t.args.content;
                }
                if (content) added += (content.match(/\n/g) || []).length + 1;
            } else if (t.name === 'edit_file') {
                if (path) fileSet[path] = true;
                var edits = [];
                if (typeof t.args === 'string') {
                    try { var ep = JSON.parse(t.args); edits = ep.edits || []; } catch (_) { }
                } else if (t.args && t.args.edits) {
                    edits = t.args.edits;
                }
                for (var ei = 0; ei < edits.length; ei++) {
                    var findLines = (edits[ei].find || '').split('\n').length;
                    var replaceLines = (edits[ei].replace || '').split('\n').length;
                    added += replaceLines;
                    deleted += findLines;
                }
            } else if (t.name === 'delete_file') {
                if (path) fileSet[path] = true;
            }
        }
    }
    return { fileCount: Object.keys(fileSet).length, added: added, deleted: deleted };
}

// 导出 _computeFileStats 供 panel-a4.js 增量持久化使用
window._computeFileStats = _computeFileStats;

async function _saveAgentQuestData(questId, ag, floorStartIdx) {
    if (!questId || !ag) return;
    var floorNum = ag._ctx.totalFloors;
    // [silent] saveQuestData

    // ═══ 1) 先写 floor 数据（原子操作：写 floor + 更新 quest.floors[]） ═══
    if (typeof floorStartIdx === 'number' && floorNum > 0) {
        var fullConv = ag.conversation ? ag.conversation.slice() : [];
        var floorConv = fullConv.slice(floorStartIdx);
        var floorPayload = {
            question: (ag._lastUserInput && ag._lastUserInput.text) || '',
            conversation: floorConv,
            houses: (ag._houses || []).slice(),
            costWge: ag._floorCostWge,
            floorFree: ag._floorFree || false,
            lastUserInput: ag._lastUserInput,
            allTxtPath: ag._allTxtPath || '',
            fileStats: _computeFileStats(ag._houses, ag._a4Snapshots),
            clockTiming: ag._lastFloorTimingRecord || null,
            aiStartTime: ag._aiStartTime || '',
            tierLabel: ag._aiTierLabel || '',
            images: ag._lastUserInput && ag._lastUserInput.images ? ag._lastUserInput.images.map(function (img) {
                // ★ sq3 只存引用（fileName + dataUrl 缩略图），base64 存磁盘文件
                return { id: img.id, fileName: img.fileName || '', dataUrl: img.dataUrl || '' };
            }) : [],
            _fDir: ag._allTxtPath ? ag._allTxtPath.replace(/[\\/]all\.txt$/g, '').replace(/[\\/]$/, '') + '/' : '',
            createdAt: Date.now(),
            _serverFloorId: ag._floorId || ''
        };

        // ★ 保存前防线：修复孤儿 tool_calls + 断言（防腐蚀数据写入 SQLite）
        if (typeof ag._repairOrphanedToolCalls === 'function') {
            var _lenBefore = ag.conversation ? ag.conversation.length : 0;
            ag._repairOrphanedToolCalls();
            var _lenAfter = ag.conversation ? ag.conversation.length : 0;
            if (_lenBefore !== _lenAfter) {
                console.warn('[CRITICAL] saving corrupted conversation: repaired ' + (_lenBefore - _lenAfter) + ' orphaned msgs (quest=' + questId + ', floor=' + floorNum + ')');
                fullConv = ag.conversation.slice();
                floorConv = fullConv.slice(floorStartIdx);
                // ★ 根治：修复后按 _floor 标签重建所有楼层分段，重写受影响的过去楼层到 sq3
                //   不这样做的话，下次重启又从 sq3 读出旧数据，同样的孤儿永远修不好
                try {
                    var _floorsMap = {};
                    for (var mi = 0; mi < fullConv.length; mi++) {
                        var _f = fullConv[mi]._floor;
                        if (_f !== undefined && _f >= 1) {
                            if (!_floorsMap[_f]) _floorsMap[_f] = [];
                            _floorsMap[_f].push(fullConv[mi]);
                        }
                    }
                    var _allFloors = await questStore.loadAllFloors(questId);
                    var _rewritten = 0;
                    for (var fi = 0; fi < _allFloors.length; fi++) {
                        var _fNum = _allFloors[fi].floorNum;
                        if (_fNum === floorNum) continue;  // 当前楼层后面会正常保存
                        var _newConv = _floorsMap[_fNum];
                        if (_newConv && _newConv.length > 0) {
                            var _oldData = _allFloors[fi].data || {};
                            if (!_oldData.conversation || _oldData.conversation.length !== _newConv.length) {
                                _oldData.conversation = _newConv;
                                await questStore.saveFloor(questId, _fNum, _oldData);
                                _rewritten++;
                            }
                        }
                    }
                    if (_rewritten > 0) {
                        console.warn('[CRITICAL] repaired past floors: ' + _rewritten + ' floors rewritten to sq3');
                    }
                } catch (_floorRewriteErr) {
                    console.warn('[CRITICAL] floor rewrite failed (will retry next save):', _floorRewriteErr);
                }
            }
        }

        // ═══ A4 快照持久化 ═══
        if (typeof _a4PersistSnapshots === 'function') {
            try {
                var _qIdx = questStore._index || [];
                var _qItem = null;
                for (var qi = 0; qi < _qIdx.length; qi++) {
                    if (_qIdx[qi].id === questId) { _qItem = _qIdx[qi]; break; }
                }
                var _numId = _qItem ? (_qItem.numericId || 0) : 0;
                var a4Meta = await _a4PersistSnapshots(ag, _numId, floorNum);
                if (a4Meta && a4Meta.length) {
                    floorPayload.a4Snapshots = a4Meta;
                }
            } catch (_a4Err) { console.warn('[a4] persist failed:', _a4Err); }
        }

        await questStore.saveFloor(questId, floorNum, floorPayload);
    }

    // ═══ 2) 再写 quest 级元数据（save 内部保留 saveFloor 已写的 floors[]） ═══
    var metaPayload = {
        ctx: ag._ctx,
        totalCostGe: ag.totalCostGe,
        lastApiPromptTokens: ag._lastApiPromptTokens || 0,
        lastApiTotalTokens: ag._lastApiTotalTokens || 0,
        lastTier: ag._lastTier || null,
        uncleanShutdown: ag._uncleanShutdown || false,
        floorTimings: ag._floorTimings || [],
        serverDrift: ag._serverDrift || 0,
        queue: ag._queue || [],
        rulesVersion: ag._rulesVersion || '',
        persistentCount: ag._persistentCount || 0
    };
    await questStore.touch(questId);
    await questStore.save(questId, metaPayload);

    // generate floor txt ONLY for active quest (not background agents)
    if (ag === _activeAgent && questId === questActiveId) {
        await generateFloorTxt().catch(function () { });
        // 追加到 quest 级 search_quest.txt（全文检索用：时间线 + Q + A）
        _appendToSearchQuest(questId, floorNum).catch(function () { });
    }
}

async function saveQuestData(floorStartIdx) {
    return _saveAgentQuestData(questActiveId, _activeAgent, floorStartIdx);
}
