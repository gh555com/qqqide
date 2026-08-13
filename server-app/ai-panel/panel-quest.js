// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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
        await questStore.invalidateIndex();  // ★ await：等 in-flight load 完成后再 null，防 updateQuestTofu 读到旧缓存
        await updateQuestTofu();
        if (typeof closeQuestDrop === 'function') closeQuestDrop();  // ★ 关闭旧下拉，确保下次 hover 全新渲染含新 quest
        return;
    }
    // ★ 彗星电子钟：跨面板建楼状态同步 — 必须在 _isDraft 检查之前
    //   否则 draft 面板的广播全被拦截，永远收不到其他面板的建楼通知
    if (msg.type === 'building-changed') {
        (window.__qqq_localBuildingQuests = window.__qqq_localBuildingQuests || {})[msg.questId] = !!msg.building;
        if (typeof updateQuestTofu === 'function') updateQuestTofu();
        if (typeof _updateQuestClock === 'function') _updateQuestClock();
        // ★ 关闭已打开的下拉 → 下次 hover 全新渲染（含新的建楼状态）
        if (typeof closeQuestDrop === 'function') closeQuestDrop();
        // ★ 建楼结束后检查是否还有活跃建楼 quest，没有则停止彗星电子钟定时器
        if (!msg.building && typeof _maybeStopCometClockTimer === 'function') _maybeStopCometClockTimer();
        return;
    }
    // ★ 豆沙包：草稿状态同步 — 来自其他面板的 draft-changed 广播
    if (msg.type === 'draft-changed') {
        // 关闭已打开的下拉 → 下次 hover 全新渲染（含新豆沙包状态）
        if (typeof closeQuestDrop === 'function') closeQuestDrop();
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
            case 'floor-completed':
                // ★ 另一面板楼层建完 → 若本面板有此 quest card 且非建楼发起方，从磁盘重载最终数据
                {
                    var _fcCard = cardPool._cards[msg.questId];
                    if (_fcCard && _fcCard.buildingFloor === null && questStore) {
                        // ★ 保存滚动位置（清卡会触发 DOM 坍缩，scrollTop 丢失）
                        var _fcScrollTop = 0;
                        try {
                            var _fcContainer = _fcCard.dom && _fcCard.dom.parentNode;
                            if (_fcContainer) _fcScrollTop = _fcContainer.scrollTop;
                        } catch (_) { }
                        _fcCard._contentWrap.innerHTML = '';
                        _fcCard.floorDOM = {};
                        _fcCard.totalFloors = 0;
                        _fcCard.floors = [];
                        _fcCard._floorMetaMap = {};
                        await cardPool._loadCardData(_fcCard);
                        // ★ 恢复滚动位置（跨面板重建卡片后用户不应被打断）
                        try {
                            var _fcContainer2 = _fcCard.dom && _fcCard.dom.parentNode;
                            if (_fcContainer2) {
                                _fcContainer2.scrollTop = _fcScrollTop;
                                // 递进兜底：渲染帧落地后再设一次
                                requestAnimationFrame(function () {
                                    if (_fcContainer2) _fcContainer2.scrollTop = _fcScrollTop;
                                });
                            }
                        } catch (_) { }
                        // ★ 若为当前活跃 quest，重连 _activeAiDiv
                        if (msg.questId === questActiveId && _activeAgent) {
                            var _lastNums = Object.keys(_fcCard.floorDOM || {}).map(Number).sort(function (a, b) { return b - a; });
                            if (_lastNums.length > 0 && _fcCard.floorDOM[_lastNums[0]].aiEl) {
                                _activeAgent._activeAiDiv = _fcCard.floorDOM[_lastNums[0]].aiEl;
                            }
                        }
                    }
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
        ag._questId = questId;  // ★ per-agent questId for trace/cross-panel isolation
        pool[questId] = ag;
    }
    return pool[questId];
}

// ---- Quest Management ----
var questStore = new QuestStore();
window.questStore = questStore;  // 暴露到全局，供 card-pool.js 等外部模块访问
questStore.requireProjectForWrites(true);  // 底层守卫：无主项目禁止一切写入

// ═══ 工作空间 — 绑定主文件夹 ═══
// 铁律：一个窗口一个主文件夹，终身不变。要换主文件夹只能开新窗口。
//       因此不存在 workspace 切换，只有首次绑定（应用重启时）。
//       iframe 永不销毁（翼板开关 = width 显隐），所以每面板仅绑定一次。

// ★ 清理上次异常退出残留的 all.json.tmp.* 文件（原子写 tmp+rename 的中断垃圾）
async function _cleanStaleAllJsonTmp(root) {
    try {
        var bridge = _getBridge();
        if (!bridge || !bridge.fs) return;
        var questsDir = root + '/_qqq/quests';
        var stat = await bridge.fs.stat(questsDir);
        if (!stat) return;
        var deleted = 0;
        // 两级扫描：q{n} → f{n}（all.json.tmp.* 只在叶子目录）
        var qEntries = await bridge.fs.list(questsDir);
        if (!qEntries || !qEntries.length) return;
        // ★ 2026-08-10: bridge.fs.list 返回 {name,isDir,...} 对象数组 — 旧实现对对象调 indexOf
        //   → TypeError → catch → 清扫从未运行（q172/f34 9 个 all.json.tmp 残留的源头之一）
        for (var qi = 0; qi < qEntries.length; qi++) {
            var qName = (qEntries[qi] && qEntries[qi].name != null) ? qEntries[qi].name : qEntries[qi];
            if (typeof qName !== 'string' || qName.indexOf('q') !== 0) continue;
            var qDir = questsDir + '/' + qName;
            var fEntries = await bridge.fs.list(qDir);
            if (!fEntries || !fEntries.length) continue;
            for (var fi = 0; fi < fEntries.length; fi++) {
                var fName = (fEntries[fi] && fEntries[fi].name != null) ? fEntries[fi].name : fEntries[fi];
                if (typeof fName !== 'string' || fName.indexOf('f') !== 0) continue;
                var fDir = qDir + '/' + fName;
                var allEntries = await bridge.fs.list(fDir);
                if (!allEntries || !allEntries.length) continue;
                for (var ai = 0; ai < allEntries.length; ai++) {
                    var aName = (allEntries[ai] && allEntries[ai].name != null) ? allEntries[ai].name : allEntries[ai];
                    if (typeof aName === 'string' && aName.indexOf('all.json.tmp.') === 0) {
                        try { await bridge.fs.remove(fDir + '/' + aName); deleted++; } catch (_) { }
                    }
                }
            }
        }
        if (deleted > 0) {
            console.log('[workspace] cleaned ' + deleted + ' stale all.json.tmp.* files');
        }
    } catch (_) { /* best-effort */ }
}

// 初始化工作空间
async function _initWorkspace(root) {
    // [silent] workspace init
    _workspaceRoot = root;
    // ★ 传播到父窗口（主窗口），供 editor.js 等非 iframe 代码读取主文件夹路径
    try { parent._workspaceRoot = root; } catch (_) { }
    if (parent && parent.qqqideBridge && parent.qqqideBridge.sync) {
        try { parent.qqqideBridge.sync.setProjectPath(root); } catch (_) { }
    }
    // ★ 注册为资产根，允许 qqqide-asset://file/ 协议访问（粘贴缩略图等）
    if (parent && parent.qqqideBridge && parent.qqqideBridge.assetRoots) {
        try { parent.qqqideBridge.assetRoots.add(root).catch(function () { }); } catch (_) { }
    }

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
            // ★ 项目锁硬拒绝（2026-08-10 冠军架构 F20 落地）：主进程原子 wx 仲裁失败
            //   = 项目已被另一 IDE 实例/窗口占用。CP 悲观锁语义：拿不到就拒，绝不共存。
            //   旧实现 3s×20 等待接管 + 15s×200 后台重试已整体删除——静默共存正是
            //   dev+绿色包双开同一项目 → 双写 quest.sq3/only.sq3/all.json 数据损坏的温床。
            parent.__qqq_lockState = 'blocked';
            var _holderInfo = '';
            if (lockResult.holder && lockResult.holder.pid) {
                _holderInfo = '（占用方 pid=' + lockResult.holder.pid + '，instance ' + String(lockResult.holder.instanceId || '').slice(0, 8) + '…）';
            }
            console.warn('[workspace] BLOCKED: project locked' + _holderInfo);
            // ★ 2026-08-13 定案：主文件夹被占用 → 清空整个 AI 视口（干净新窗口），
            //   杜绝残血窗口（旧 remove-project 对主文件夹 idx===0 无效 → 视口残留整套成员）。
            if (window.parent) {
                try { window.parent.postMessage({ type: 'qqq-ai-viewport-clear-all', path: root }, '*'); } catch (_) { }
            }
            onlyStore.init(null);
            _workspaceRoot = null;
            try { parent._workspaceRoot = null; } catch (_) { }
            return;
        }
        parent.__qqq_lockState = 'ok';
        // ★ 锁丢失兜底（2026-08-10）：主进程 watcher 发现锁被外部删除/替换 → 重新仲裁
        //   成功 → 主进程心跳自动恢复；失败 → 硬拒绝（与初始绑定同语义，绝不静默共存）
        try {
            var _pqBridge = window.parent && window.parent.qqqideBridge;
            if (_pqBridge && _pqBridge.projectLock && _pqBridge.projectLock.onLockLost) {
                _pqBridge.projectLock.onLockLost(function (msg) {
                    if (_panelId !== 1) return;
                    if (!_workspaceRoot) return;
                    if (msg && msg.folder && msg.folder !== _workspaceRoot) return;
                    console.warn('[workspace] lock-lost event, re-arbitrating: ' + _workspaceRoot);
                    onlyStore.claimLock().then(function (res) {
                        if (res && res.ok) {
                            console.warn('[workspace] lock re-acquired after lock-lost');
                        } else {
                            console.warn('[workspace] lock-lost: re-claim rejected');
                            parent.__qqq_lockState = 'blocked';
                            try { addMessageEl('error', '⛔ 项目锁已丢失且无法重新获取（另一窗口已占用），本窗口停止绑定。'); } catch (_) { }
                            onlyStore.init(null);
                            _workspaceRoot = null;
                            try { parent._workspaceRoot = null; } catch (_) { }
                            // ★ 2026-08-13：锁丢失且无法重获 = 主文件夹已被占用 → 清空视口（幂等）
                            if (window.parent) {
                                try { window.parent.postMessage({ type: 'qqq-ai-viewport-clear-all', path: root }, '*'); } catch (_) { }
                            }
                        }
                    }).catch(function () { });
                });
            }
        } catch (_) { }
        // 向主进程注册窗口↔项目映射（仅中面板）
        if (window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.window) {
            try { window.parent.qqqideBridge.window.claimProject(root).catch(function () { }); } catch (_) { }
        }
        // ★ 项目绑定后立即改 DevTools 标题（特别是 fresh 窗口后来加主文件夹的场景）
        if (window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.devtools) {
            try { window.parent.qqqideBridge.devtools.rename(root).catch(function () { }); } catch (_) { }
        }
    } else {
        // ★ 侧面板：必须等中面板锁决定，禁止绕过——中面板被锁定时侧面板也停止（防多窗口并发写入）
        for (var _wl = 0; _wl < 300; _wl++) {
            if (parent.__qqq_lockState === 'ok') break;
            if (parent.__qqq_lockState === 'blocked') {
                // ★ 中面板硬拒绝（2026-08-10）→ 侧面板同步停止等待（旧 15s×200 后台恢复已删除）
                console.warn('[workspace] side panel: main panel blocked, abort binding');
                break;
            }
            await new Promise(function (r) { setTimeout(r, 200); });
        }
        // ★ 2026-08-10 修复：中面板 blocked 或 60s 超时未决 → 侧面板必须中止绑定并清理
        //   （旧代码 break 后继续 setProjectRoot → 僚机绕过项目锁绑定项目 → 跨窗口双写
        //    q182 三层楼事故实锤：中面板 blocked 而翼板照常聊天写楼层）
        if (parent.__qqq_lockState !== 'ok') {
            _lockBlocked = true;
            console.warn('[workspace] side panel: lock not acquired (' + (parent.__qqq_lockState || 'timeout') + '), abort binding');
            // ★ 2026-08-13：侧面板 abort 也通知清空（幂等；覆盖中面板 iframe 加载失败等极端时序）
            if (window.parent) {
                try { window.parent.postMessage({ type: 'qqq-ai-viewport-clear-all', path: root }, '*'); } catch (_) { }
            }
            onlyStore.init(null);
            _workspaceRoot = null;
            try { parent._workspaceRoot = null; } catch (_) { }
            return;
        }
    }

    questStore.setProjectRoot(root);

    // ★ 清理上次异常退出残留的 all.json.tmp.* 文件（原子写 tmp+rename 的中断垃圾）
    _cleanStaleAllJsonTmp(root).catch(function () { });

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
            var oldAlphal = root + '/_qqq/quests/alphal';
            var newAlphal = root + '/_qqq/alphal';
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
    // ★ 豆沙包：启动时从 onlyStore 扫描三面板草稿，初始化 parent.__qqq_draftFlags
    //   仅中面板执行（避免三面板重复扫描）；侧面板等中面板初始化完成后读共享对象
    if (_panelId === 1 && parent) {
        parent.__qqq_draftFlags = parent.__qqq_draftFlags || {};
        var _panels = [0, 1, 2];
        for (var _pi = 0; _pi < _panels.length; _pi++) {
            var _pid = _panels[_pi];
            var _states = (_pid === _panelId) ? questUIStates : await onlyStore.getAsync('ai.uiStates.' + _pid);
            if (_states && typeof _states === 'object') {
                var _keys = Object.keys(_states);
                for (var _ki = 0; _ki < _keys.length; _ki++) {
                    var _qid = _keys[_ki];
                    if (_isDraft(_qid)) continue;
                    var _st = _states[_qid];
                    if (_st && _st.inputValue && _st.inputValue.trim().length > 0) {
                        if (!parent.__qqq_draftFlags[_qid]) parent.__qqq_draftFlags[_qid] = {};
                        parent.__qqq_draftFlags[_qid]['p' + _pid] = true;
                    }
                }
            }
        }
        // [silent] draftFlags initialized
    }

    // ★ IPC sync & onChange 必须在 initQuests 之前注册，
    //   否则 _syncIndexFromFs 发现的 quest 无法广播到其他面板
    try {
        var sb = _getSyncBridge();
        if (sb) {
            if (_syncUnsub) { _syncUnsub(); _syncUnsub = null; }
            var ch = _syncChannel();
            _syncUnsub = sb.onMessage(function (channel, data) {
                if (channel === ch) { _handleSyncMessage(data); }
            });
            // [silent] IPC sync subscribed
        }
    } catch (e) { console.warn('[workspace] IPC sync unavailable:', e); }
    questStore.onChange(function (payload) {
        _broadcast(payload.type, payload.questId, { floorNum: payload.floorNum, title: payload.title });
    });

    // 初始化 quest 列表
    _questsInited = true;
    // ★ 仅中面板做磁盘扫描 + 索引建仓（fs.list 只跑一次，左右翼复用缓存）
    if (_panelId === 1) {
        await questStore.list();
    }
    await initQuests();

    // ═══ E-Flow auto-detect: check if standard expert framework exists ═══
    try {
        if (typeof ExpertFlow !== 'undefined') {
            await ExpertFlow.autoDetect(root);
        }
    } catch (_) { /* silent */ }

    if (typeof loadQqqideProjectRules === 'function') {
        loadQqqideProjectRules(questStore.getProjectRoot());
    }
    if (typeof buildQqqideVisionContext === 'function') {
        buildQqqideVisionContext();
    }

    // [silent] workspace bound
}

// ★ bindMainProject 并发锁：防 boot IIFE 与 postMessage 回调同时进入
var _bindLock = null;
// ★ 锁硬拒绝标记（2026-08-10）：中面板被项目锁拒绝 → 侧面板中止绑定后不再每 3s 重试
var _lockBlocked = false;

// 入口：绑定主文件夹（仅首次，终身一次）
async function bindMainProject() {
    // 锁拒绝后不再重试（直到手动添加新项目）
    if (_lockBlocked) return;
    // 已绑定 → 跳过（同窗口未可切换主文件夹）
    if (_workspaceRoot) return;
    // 并发锁：另一调用正在进行中 → 等它完成
    if (_bindLock) return _bindLock;

    _bindLock = (async () => {
        // 二次检查：可能在等锁期间另一调用已完成绑定
        if (_workspaceRoot) { _bindLock = null; return; }

        var root = null;
        if (!window.parent || !window.parent.qqqideViewport) { _bindLock = null; return; }

        // ★ 轮询等待主项目就绪（最多 16 次 × 500ms = 8s）
        //   解决翼板 iframe 加载时序早于父窗口异步项目加载的竞态问题
        //   ★ 2026-08-08（q44/q147 跨项目串号）: 追加稳定性判定 —
        //     视口主项目在启动期可能跳变（OS 级上次主文件夹 vs 本窗口 folder=/formation 恢复），
        //     连续 2 次采样一致才绑定 → 面板不会绑到启动期的临时主项目
        var _lastMain = null;
        var _stable = 0;
        for (var _bpRetry = 0; _bpRetry < 16; _bpRetry++) {
            var main = window.parent.qqqideViewport.getMainProject();
            if (main && main.path) {
                var _p = main.path.replace(/\\/g, '/').replace(/\/$/, '');
                if (_p === _lastMain) {
                    _stable++;
                    if (_stable >= 2) { root = _p; break; }
                } else {
                    _lastMain = _p;
                    _stable = 1;
                }
            } else {
                _lastMain = null;
                _stable = 0;
            }
            if (_bpRetry < 15) await new Promise(function (r) { setTimeout(r, 500); });
        }
        if (!root && _lastMain) root = _lastMain;  // 兜底：视口始终未稳定 → 用最后一次采样

        if (!root) {
            // [silent] bindMainProject: no main project after retries, wait for viewport-changed message
            _bindLock = null;
            return;
        }

        await _initWorkspace(root);
        _bindLock = null;
    })();

    return _bindLock;
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

function restoreQuestUIState(id) {
    var state = questUIStates[id];
    if (state) {
        $input.value = state.inputValue || '';
        $input._resetUndo();
        pendingImages = state.pendingImages || [];
        // ★ 旧数据可能为 null（A 已改为信息弹窗），回退默认
        selectedTier = (state.selectedTier != null) ? state.selectedTier : ((typeof _getDefaultTier === 'function') ? _getDefaultTier() : 3);
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
        selectedTier = (typeof _getDefaultTier === 'function') ? _getDefaultTier() : 3;
        updateTierButtons(selectedTier);
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

// ★ 铁律：任何保存必须传入显式 floorNum，禁止从 ag._ctx.totalFloors 推导
//   floorNum 来自创建楼层时由 questStore.nextFloorNum() 分配的值，永久不变。
//   ag._floorMeta[floorNum] 保存该楼层的未可变元数据（allTxtPath/floorStartIdx）。
//   所有调用方必须传 floorNum，auto-save 传 ag._currentFloorNum，onDone 传完成的楼层号。

// ═══ ctx.json 持久化 — D 路径兜底 ═══
// ★ B 方案: per-quest ctx.json 替代 quest.sq3 存 ctx。原子 tmp+rename 写，单 quest 隔离。
//   ctx.json 损坏/丢失 → D 路径(_rebuildBackpack 扫描 conversation)自愈。
function _writeCtxJson(questId, ctx) {
    return (async function () {
        try {
            var qDir = await questStore.resolveQuestDir(questId);
            if (!qDir) return false;
            var bridge = _getBridge();
            if (!bridge || !bridge.fs) return false;
            var payload = {
                lastCompressedFloor: ctx.lastCompressedFloor || 0,
                floorArchives: ctx.floorArchives || [],
                totalFloors: ctx.totalFloors || 0,
                narrative: ctx.narrative || '',
                facts: ctx.facts || [],
                treasures: ctx.treasures || [],
                biscuitLines: ctx.biscuitLines || []
            };
            var dest = qDir + 'ctx.json';
            var tmp = dest + '.tmp.' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            await bridge.fs.write(tmp, JSON.stringify(payload));
            await bridge.fs.rename(tmp, dest);
            return true;
        } catch (_) {
            return false;
        }
    })();
}

async function _readCtxJson(questId) {
    try {
        var qDir = await questStore.resolveQuestDir(questId);
        if (!qDir) return null;
        var bridge = _getBridge();
        if (!bridge || !bridge.fs) return null;
        var raw = await bridge.fs.read(qDir + 'ctx.json');
        if (!raw || typeof raw !== 'string') return null;
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

async function _saveAgentQuestData(questId, ag, floorNum, opts) {
    if (!questId || !ag) return;
    if (!floorNum) floorNum = ag._currentFloorNum;
    // ★ 完结密封守卫（2026-08-08 F10 根因）：已完结楼层禁止再次写盘
    //   （压缩后 conversation 已截短，重复保存 slice 出空 → conv=0 覆盖完整保存）
    if (floorNum > 0 && ag._floorSealed && ag._floorSealed[floorNum]) return;

    // ═══ 1) 如果楼层号有效且有元数据 → 保存楼层 payload ═══
    if (floorNum && floorNum > 0) {
        // ★ 查询该楼层未可变元数据
        var meta = ag._floorMeta && ag._floorMeta[floorNum];
        if (!meta) {
            // 兼容层：旧楼层（本修复前创建）没有 _floorMeta
            meta = {
                floorStartIdx: ag._floorStartIdx,
                allTxtPath: ag._allTxtPath || '',
            };
        }

        // ★ 防御：floor > 1 时 _floorStartIdx 不能为 0（否则 all.json 保存整段 conversation → 重启后重复拼接）
        if (floorNum > 1 && meta.floorStartIdx <= 0) {
            console.warn('[save] _floorStartIdx=0 for floor ' + floorNum + ' — auto-healing from conversation _floor tags');
            // 从 conversation 中扫描本楼层第一条消息作为 startIdx
            for (var _hi = 0; _hi < ag.conversation.length; _hi++) {
                if (ag.conversation[_hi]._floor === floorNum) {
                    meta.floorStartIdx = _hi;
                    console.warn('[save] _floorStartIdx healed to ' + _hi + ' for floor ' + floorNum);
                    break;
                }
            }
            // 未找到（本楼层无 conversation 消息）→ 沿用 0 保底（空 floor 不损坏数据）
        }

        // ★ 统一 payload 构建（使用该楼层自己的 startIdx，非 ag._floorStartIdx 可能已变化）
        var floorPayload = (typeof window._a4BuildCompleteFloorPayload === 'function')
            ? window._a4BuildCompleteFloorPayload(ag, floorNum, opts)
            : {
                question: (ag._lastUserInput && ag._lastUserInput.text) || '',
                conversation: ag.conversation ? ag.conversation.slice(meta.floorStartIdx || 0) : [],
                houses: (ag._houses || []).slice(),
                costWge: ag._floorCostWge,
                lastUserInput: ag._lastUserInput,
                allTxtPath: meta.allTxtPath || '',
                _floorStartIdx: meta.floorStartIdx || 0,
                _fDir: meta.allTxtPath ? meta.allTxtPath.replace(/[\\/]all\.txt$/g, '').replace(/[\\/]$/, '') + '/' : '',
                createdAt: Date.now()
            };

        floorPayload._serverFloorId = ag._floorId || '';

        // ★ passby 快照：冻结本楼层完工时的累计值（用于重启后显示历史 passby）
        var _passbyHouses = (ag._passbyBaseHouses || 0) + (ag._houses ? ag._houses.length : 0);
        var _passbyWge = (ag._passbyBaseWge || 0) + (ag._floorCostWge || 0);
        floorPayload.passbyHouses = _passbyHouses;
        floorPayload.passbyWge = _passbyWge;
        floorPayload.passbyTokens = (ag._passbyBaseTokens || 0) + (typeof _computeFloorTokens === 'function' ? _computeFloorTokens(ag) : 0);
        floorPayload.passbyTime = Date.now() + (ag._serverDrift || 0);
        floorPayload.passbyCity = ag._serverCity || '';

        // ═══ A4 快照持久化 ═══
        if (typeof _a4PersistSnapshots === 'function') {
            try {
                var _qList = await questStore.list();
                var _qItem = null;
                for (var qi = 0; qi < _qList.length; qi++) {
                    if (_qList[qi].id === questId) { _qItem = _qList[qi]; break; }
                }
                var _numId = _qItem ? (_qItem.numericId || 0) : 0;
                var a4Meta = await _a4PersistSnapshots(ag, _numId, floorNum);
                if (a4Meta && a4Meta.length) {
                    floorPayload.a4Snapshots = a4Meta;
                }
            } catch (_a4Err) { console.warn('[a4] persist failed:', _a4Err); }
        }

        await questStore.saveFloor(questId, floorNum, floorPayload);

        await generateFloorTxt(ag, questId).catch(function () { });
        _appendToSearchQuest(questId, floorNum).catch(function (e) { console.error('[search_quest] inner fail for q=' + questId + ' f=' + floorNum + ':', e && e.message); });
    }

    // ═══ 2) 无论是否有楼层号，都写 quest 级元数据 ═══
    var metaPayload = {
        // ★ ctx 已迁至 ctx.json（_writeCtxJson），不再写 quest.sq3
        totalCostGe: ag.totalCostGe,
        lastApiPromptTokens: ag._lastApiPromptTokens || 0,
        lastApiTotalTokens: ag._lastApiTotalTokens || 0,
        lastApiCompletionTokens: ag._lastApiCompletionTokens || 0,
        accumulatedCompletionTokens: ag._accumulatedCompletionTokens || 0,
        lastTier: ag._lastTier || null,
        uncleanShutdown: ag._uncleanShutdown || false,
        floorTimings: ag._floorTimings || [],
        serverDrift: ag._serverDrift || 0,
        queue: ag._queue || [],
        rulesVersion: ag._rulesVersion || '',
        persistentCount: ag._persistentCount || 0,
        currentFloorNum: ag._currentFloorNum || 0
        // ★ passbyBase 不持久化：重启时从 all.json 重算（panel-floor.js L609-634），持久化冗余
    };
    await questStore.touch(questId);
    await questStore.save(questId, metaPayload);

    // ★ passby 基线推进已移至 _executeSend / 手动压缩 的新楼层开始处（panel-pipeline.js / panel-quest-ui.js）
}

// ★ saveQuestData 不再接受 floorStartIdx 参数，改为从 _activeAgent 读取 _currentFloorNum
async function saveQuestData() {
    var fn = _activeAgent ? _activeAgent._currentFloorNum : null;
    return _saveAgentQuestData(questActiveId, _activeAgent, fn);
}
