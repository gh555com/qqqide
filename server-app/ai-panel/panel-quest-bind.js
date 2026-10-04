// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
// panel-quest-bind.js — 工作空间绑定 + 项目锁 + 楼层上限（2026-10-03 从 panel-quest.js 原样搬移，行为零改动）
'use strict';

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

// ═══ 显示楼层上限（设置 ai.floorCap：16/32/64，32/64=激活功能）动态跟随（2026-09-05；64 档 2026-09-06）═══
// 订阅父窗口 qqqSettings 变更（qqqSettings 可能晚于面板加载 → 重试兜底）；
// 每面板仅绑定一次工作空间 → 每个 CardPool 恰好订阅一次，无重复订阅问题。
function _watchFloorCapSetting() {
    var tries = 0;
    function trySub() {
        var pw = null;
        try { pw = parent && parent.window; } catch (_e) { pw = null; }
        if (pw && pw.qqqSettings && pw.qqqSettings.onChange) {
            try {
                pw.qqqSettings.onChange('ai.floorCap', function () {
                    if (typeof _reapplyFloorCap === 'function') _reapplyFloorCap();
                });
                return;
            } catch (_e) { }
        }
        if (++tries < 80) setTimeout(trySub, 500);
    }
    trySub();
}

function _readFloorCapSetting() {
    try {
        var pw = parent && parent.window;
        if (pw && pw.qqqSettings && pw.qqqSettings.get) {
            var _s = String(pw.qqqSettings.get('ai.floorCap', '16'));
            if (_s === '32') return 32;
            if (_s === '64') return 64;
        }
    } catch (_e) { }
    return 16;
}

// ★ 上限变更即时重排（16/32/64 任意双向通吃，2026-09-06 起支持 64）：
//   加量（如 32→64）→ 曾因旧上限被裁掉旧楼层的 quest 从磁盘全量重载重建（保留滚动位置）；
//   减量（如 64→32）→ 仅裁 DOM；
//   建楼中 quest 绝不重建（流式渲染锚点依赖 DOM，agent 不断流，下次自然重载生效）。
function _reapplyFloorCap() {
    if (!cardPool || !questStore) return;
    var cap = _readFloorCapSetting();
    var ids = Object.keys(cardPool._cards || {});
    for (var i = 0; i < ids.length; i++) {
        var qid = ids[i];
        var card = cardPool._cards[qid];
        if (!card || !card.dom || !card._contentWrap) continue;
        // 建楼中 quest：不断流不重建，仅按新上限裁剪（旧楼层随后续建楼自然按新上限保留）
        if (card.buildingFloor !== null) {
            try { cardPool._trimCapped(card); } catch (_e) { }
            continue;
        }
        var domCount = 0;
        for (var fn in card.floorDOM) { if (card.floorDOM.hasOwnProperty(fn)) domCount++; }
        if (cap < domCount) {
            // 减量：直接裁剪最老楼层 DOM
            try { cardPool._trimCapped(card); } catch (_e) { }
            continue;
        }
        // 加量：DOM 数 < 数据层数 = 曾被裁过 → 从磁盘重载全量重建
        if (cap > domCount && card.totalFloors > domCount) {
            var _cont = card.dom && card.dom.parentNode;
            var _st = _cont ? _cont.scrollTop : 0;
            (function (c, cont, scrollTop, questId) {
                c._contentWrap.innerHTML = '';
                c.floorDOM = {};
                c.totalFloors = 0;
                c.floors = [];
                c._floorMetaMap = {};
                c._keepFloors = {};
                c._floorNodes = {};
                cardPool._loadCardData(c).then(function () {
                    try {
                        if (cont) {
                            cont.scrollTop = scrollTop;
                            requestAnimationFrame(function () { if (cont) cont.scrollTop = scrollTop; });
                        }
                        // 活跃 quest：重连 _activeAiDiv（与 floor-completed 跨面板重载同款）
                        if (typeof questActiveId !== 'undefined' && questId === questActiveId && _activeAgent) {
                            var _nums = Object.keys(c.floorDOM || {}).map(Number).sort(function (a, b) { return b - a; });
                            if (_nums.length > 0 && c.floorDOM[_nums[0]] && c.floorDOM[_nums[0]].aiEl) {
                                _activeAgent._activeAiDiv = c.floorDOM[_nums[0]].aiEl;
                            }
                        }
                    } catch (_e2) { }
                }).catch(function () { });
            })(card, _cont, _st, qid);
        }
    }
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
                _holderInfo = _qq('ai.lock.holderInfo', '（占用方 pid={0}，instance {1}…）', { 0: lockResult.holder.pid, 1: String(lockResult.holder.instanceId || '').slice(0, 8) });
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
        // ★ 显示楼层上限（设置 ai.floorCap：16/32/64）变更 → 本面板即时重排楼层 DOM（2026-09-05；64 档 2026-09-06）
        _watchFloorCapSetting();
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
    // ★ 断电恢复（2026-08-26）：高频草稿文本（ai.draftText.{panelId}，键入时 800ms 节流实时写）
    //   比 ai.uiStates 完整快照更新 → 非空文本覆盖 inputValue（断电最多丢最后 ~3s 键入）
    try {
        var _dtAll = await onlyStore.getAsync('ai.draftText.' + _panelId);
        if (_dtAll && typeof _dtAll === 'object') {
            var _dtKeys = Object.keys(_dtAll);
            for (var _dti = 0; _dti < _dtKeys.length; _dti++) {
                var _dtq = _dtKeys[_dti];
                var _dtv = _dtAll[_dtq];
                if (typeof _dtv !== 'string' || _dtv.length === 0) continue;
                if (!questUIStates[_dtq]) questUIStates[_dtq] = {};
                questUIStates[_dtq].inputValue = _dtv;
            }
        }
    } catch (_) { }
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
    _signalUiReady();   // ★ 就绪门控（2026-09-24）: 中面板全量恢复完成 → 通知壳层揭幕
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
            _signalUiReady();   // ★ 无主项目：草稿态界面已可用 → 发就绪信号（2026-09-24）
            return;
        }

        await _initWorkspace(root);
        _bindLock = null;
    })();

    return _bindLock;
}
