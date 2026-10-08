// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';
// ═══ panel-fav.js ═══
// 楼层收藏 · 面板侧（az 区星标 + 收藏跳转）
//   主窗口 core/floor-favs.js = 数据唯一真理源（only.sq3 ai.floorFavs）+ 命名框 + 收藏夹面板 + 归宿面板裁决；
//   本文件只做三件事：
//   ① 星标按钮（_initClockBlock 注入，居中于饼图与 ge 之间）——点击 → 通知主窗口开命名框
//   ② 收藏跳转执行——切 quest（复用 switchQuest 全链）→ 卡上限外的孤儿楼层按需重建
//      （磁盘 all.json + _buildFloorDOM + 节点快照精准插回 + 免驱逐标记）→ 滚动居中 + 金色闪 3 下
//   ③ 执行两关：面板启动门（冷开翼板全量恢复完成前不抢跑）+ 跳楼锁（切换收尾延迟滚底让路——
//      否则召回后的楼层跳转与金色高光会被随后的强制滚底整个吞掉）
//   协议（postMessage）：qqq-fav-state（主→面板，全量状态）/ qqq-fav-open（面板→主，点星）
//                     qqq-fav-jump（主→面板，带 jid 可重复投递）/ qqq-fav-jump-ack（面板→主，回执停重试）
//                     qqq-fav-jump-miss（面板→主，任务/楼层不存在或归属易主）/ qqq-fav-query（面板→主，主动拉状态）

var _favState = {};    // 'questId|floorNum' → { id, name }
var _favJumpBusy = false;
var _favPending = null;    // ★ 忙时最新一跳（最新覆盖：连点两个收藏，目光落在最后一跳）
var _favLastJid = '', _favLastJidTs = 0;   // ★ 投递去重（主窗口重试的同一 jid 只执行一次）

function _favFq(key, fb, params) {
    try { if (typeof window._qq === 'function') return window._qq(key, fb, params); } catch (_) { }
    return fb || key;
}
function _favKey(questId, floorNum) { return String(questId) + '|' + String(floorNum); }
function _favSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ── 面板启动门（冷开翼板：initQuests 全量恢复完成前不抢跑，防与启动恢复互踩）──
//   返回 true = 真实等待过（冷开）→ 调用方再等一拍布局落定（启动恢复的延迟滚位链收尾）
function _favWaitBooted() {
    return new Promise(function (resolve) {
        var n = 0;
        (function _poll() {
            var ok = false;
            try { ok = !!_panelBootDone; } catch (_) { }
            if (ok) { resolve(n > 0); return; }
            if (++n > 150) { resolve(false); return; }   // ≤30s 兜底（面板异常也不永久悬挂）
            setTimeout(_poll, 200);
        })();
    });
}
// ── 跳楼锁置位（card-pool.scrollActiveToBottom 让路标记；panel-fav 唯一置位点）──
function _favLockArm(questId) {
    try {
        var c = (typeof cardPool !== 'undefined' && cardPool && cardPool.getCard) ? cardPool.getCard(questId) : null;
        if (c) c._favJumpLockUntil = Date.now() + 2500;
    } catch (_) { }
}
function _favOwnerOf(questId) {
    try { if (typeof _parentGetQuestOwner === 'function') return _parentGetQuestOwner(questId); } catch (_) { }
    return undefined;
}

// ── 星标目标解析（★ 活的）──
// 铁律级时序事实：_initClockBlock 恒在 aiEl 挂进 .card 之前执行
//   （实时建楼 startBuildingFloor / 历史恢复 _buildFloorDOM —— 两路径皆先建钟后挂载），
//   彼时 closest('.card') 为 null → 构建瞬间写不进 data-qid/data-fn（曾致全量星标永远 ☆、
//   重载也不亮色的断链）。故一切状态读取必须『挂载后活解析』+ 未解析重试链，
//   禁止只依赖构建瞬间写入的祖先属性。
function _favResolve(btn) {
    var qid = (btn.getAttribute && btn.getAttribute('data-qid')) || '';
    var fn = parseInt((btn.getAttribute && btn.getAttribute('data-fn')) || '', 10) || 0;
    if (qid && fn) return { qid: qid, fn: fn };
    var block = btn.closest ? btn.closest('.msg-ai-clock') : null;
    var aiDiv = block ? block.parentNode : null;
    var card = (aiDiv && aiDiv.closest) ? aiDiv.closest('.card') : null;
    if (!qid) qid = card ? (card.getAttribute('data-quest') || '') : '';
    if (!fn) fn = (aiDiv && parseInt(aiDiv._floor, 10)) || 0;
    if (qid && fn) {
        try { btn.setAttribute('data-qid', qid); btn.setAttribute('data-fn', String(fn)); } catch (_) { }
    }
    return { qid: qid, fn: fn };
}
// ── 星标外观 ──
function _favApplyStar(btn) {
    if (!btn) return false;
    var t = _favResolve(btn);
    var on = !!(t.qid && t.fn && _favState[_favKey(t.qid, t.fn)]);
    if (on) btn.classList.add('on'); else btn.classList.remove('on');
    btn.textContent = on ? '\u2605' : '\u2606';
    btn.title = on ? _favFq('fav.starTipOn', '已收藏（点击编辑）') : _favFq('fav.starTip', '收藏此楼层');
    return !!(t.qid && t.fn);
}
function _favRefreshAll() {
    var unresolved = 0;
    try {
        var btns = document.querySelectorAll('.msg-ai-clock .clock-fav');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            // 自愈：脚本晚载/星标未接线（hook 缺失窗口）→ 补接线
            if (!b._favWired) {
                var blk = b.closest ? b.closest('.msg-ai-clock') : null;
                var ai = blk ? blk.parentNode : null;
                if (ai && typeof window._favHookStar === 'function') { try { window._favHookStar(ai); } catch (_) { } }
            }
            if (!_favApplyStar(b)) unresolved++;
        }
    } catch (_) { }
    return unresolved;
}
// ── 挂载后重刷链（与 DOM 挂载赛跑；自终止）──
var _favRetryTimer = null, _favRetryLeft = 0;
function _favScheduleRefresh(retries) {
    if (typeof retries === 'number' && retries > _favRetryLeft) _favRetryLeft = retries;
    if (_favRetryTimer) return;
    _favRetryTimer = setTimeout(function () {
        _favRetryTimer = null;
        var unresolved = _favRefreshAll();
        if (unresolved > 0 && _favRetryLeft > 0) { _favRetryLeft--; _favScheduleRefresh(); }
        else _favRetryLeft = 0;
    }, 60);
}

// ── 星标注入钩（panel-clock.js _initClockBlock 调用；建楼/历史恢复两路径同此一处汇入）──
window._favHookStar = function (aiDiv) {
    try {
        var btn = aiDiv && aiDiv._clockFav;
        if (!btn) return;
        var card = aiDiv.closest ? aiDiv.closest('.card') : null;
        var qid = card ? card.getAttribute('data-quest') : '';
        var fn = aiDiv._floor || 0;
        if (qid) btn.setAttribute('data-qid', qid);
        if (fn) btn.setAttribute('data-fn', String(fn));
        if (!btn._favWired) {
            btn._favWired = true;
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                // 点击后释放焦点（防 Enter/空格 重触发按钮而非发消息）
                try { btn.blur(); } catch (_) { }
                _favOnStarClick(aiDiv);
            });
        }
        var resolved = _favApplyStar(btn);
        // ★ 构建瞬未挂载（两路径皆如此）→ 挂载后延迟重刷（自终止重试链）
        _favScheduleRefresh(resolved ? 0 : 10);
    } catch (_) { }
};

// ── 点星 → 请主窗口开命名框 ──
function _favQuestionText(aiDiv) {
    try {
        var el = aiDiv.previousElementSibling;
        while (el && !el.classList.contains('msg-user')) el = el.previousElementSibling;
        if (!el) return '';
        var buf = '';
        for (var n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) buf += n.nodeValue || '';
            if (buf.length > 400) break;
        }
        return buf.replace(/\s+/g, ' ').trim().slice(0, 300);
    } catch (_) { return ''; }
}
function _favQuestTitle(questId) {
    try {
        var idx = parent.__qqq_questIndex;
        if (Array.isArray(idx)) {
            for (var i = 0; i < idx.length; i++) {
                if (idx[i] && idx[i].id === questId) return idx[i].title || '';
            }
        }
    } catch (_) { }
    return '';
}
function _favSendOpen(questId, floorNum, aiDiv, title) {
    _postToHost({
        type: 'qqq-fav-open',
        questId: questId,
        floorNum: floorNum,
        question: _favQuestionText(aiDiv),
        questTitle: title || ''
    });
}
function _favOnStarClick(aiDiv) {
    var card = aiDiv.closest ? aiDiv.closest('.card') : null;
    var questId = card ? card.getAttribute('data-quest') : '';
    var floorNum = aiDiv._floor || 0;
    if (!questId || !floorNum) return;
    var title = _favQuestTitle(questId);
    if (title) { _favSendOpen(questId, floorNum, aiDiv, title); return; }
    // 索引尚未就绪（罕见）：短轮询补一次标题，拿不到也照发（问题文本本身已足以为自动命名）
    var t0 = Date.now();
    (function _try() {
        var t = _favQuestTitle(questId);
        if (t || (Date.now() - t0) > 1200) { _favSendOpen(questId, floorNum, aiDiv, t || ''); return; }
        setTimeout(_try, 150);
    })();
}

// ── 状态同步（主窗口 → 面板）──
function _favOnState(items) {
    var next = {};
    if (items && items.length) {
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it || !it.questId || !it.floorNum) continue;
            next[_favKey(it.questId, it.floorNum)] = { id: it.id, name: it.name };
        }
    }
    _favState = next;
    var unresolved = _favRefreshAll();
    if (unresolved > 0) _favScheduleRefresh(10);
}

// ── 收藏跳转（主窗口 → 面板；点了必达）──
function _favPlaceBlock(card, nodes, floorNum) {
    var wrap = card._contentWrap;
    if (!wrap || !nodes || !nodes.length) return;
    // 锚点 = 现存楼层中编号最小且大于本层的块首节点；不存在 → 本块已在末尾，无需移动
    var anchor = null, anchorFn = Infinity;
    var fns = Object.keys(card.floorDOM || {});
    for (var i = 0; i < fns.length; i++) {
        var fn = parseInt(fns[i], 10);
        if (!(fn > floorNum) || fn >= anchorFn) continue;
        var first = null;
        var snap = card._floorNodes && card._floorNodes[fn];
        if (snap && snap.length && snap[0].parentNode === wrap) first = snap[0];
        if (!first) {
            var dm = card.floorDOM[fn];
            var cand = (dm && dm.userEl) ? dm.userEl : (dm && dm.aiEl);
            if (cand && cand.parentNode === wrap) first = cand;
        }
        if (first) { anchor = first; anchorFn = fn; }
    }
    if (!anchor) return;
    for (var n = 0; n < nodes.length; n++) {
        try { if (nodes[n]) wrap.insertBefore(nodes[n], anchor); } catch (_) { }
    }
}

async function _favRebuildFloor(card, questId, floorNum) {
    try {
        if (card.floorDOM[floorNum] && card.floorDOM[floorNum].aiEl) return true;
        var data = null;
        try { data = await questStore.loadFloor(questId, floorNum); } catch (_) { }
        if (!data) return false;
        var timings = [];
        try {
            var meta = await questStore.load(questId);
            if (meta && meta.floorTimings) timings = meta.floorTimings;
        } catch (_) { }
        card._floorMetaMap = card._floorMetaMap || {};
        if (!card._floorMetaMap[floorNum]) {
            card._floorMetaMap[floorNum] = {
                questId: questId,
                allTxtPath: data.allTxtPath || '',
                houses: data.houses || [],
                costWge: data.costWge || 0
            };
        }
        // ★ 免驱逐标记：此后任何 _trimCapped 都不得再裁掉这个孤儿层（收藏 = 用户主动定位目标）
        card._keepFloors = card._keepFloors || {};
        card._keepFloors[floorNum] = true;
        var refs = cardPool._buildFloorDOM(card, { floorNum: floorNum, data: data }, false, timings);
        if (refs && refs.nodes && refs.nodes.length) _favPlaceBlock(card, refs.nodes, floorNum);
        return !!(card.floorDOM[floorNum] && card.floorDOM[floorNum].aiEl);
    } catch (_e) {
        return false;
    }
}

function _favScrollAndFlash(card, dom) {
    // 浏览历史：停止自动跟滚（不被流式渲染拉回底部）
    try { card._userScrolledUp = true; card._userScrollBarrier = Date.now(); } catch (_) { }
    try {
        var el = dom.userEl || dom.aiEl;
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) { }
    var targets = [];
    if (dom.userEl) targets.push(dom.userEl);
    if (dom.aiEl && dom.aiEl !== dom.userEl) targets.push(dom.aiEl);
    for (var i = 0; i < targets.length; i++) {
        (function (t) {
            try {
                t.classList.remove('fav-flash');
                void t.offsetWidth;   // 强制重排以重启动画
                t.classList.add('fav-flash');
                setTimeout(function () { try { t.classList.remove('fav-flash'); } catch (_) { } }, 2200);
            } catch (_) { }
        })(targets[i]);
    }
}

async function _favJump(questId, floorNum) {
    if (!questId || !floorNum || floorNum <= 0) return;
    if (_favJumpBusy) { _favPending = { questId: questId, floorNum: floorNum }; return; }
    _favJumpBusy = true;
    try {
        // ★ 面板启动门（冷开翼板：全量恢复完成前不抢跑；真等过 → 再让一拍给启动滚位链）
        if (await _favWaitBooted()) await _favSleep(200);
        if (typeof questActiveId === 'undefined' || typeof cardPool === 'undefined' || !cardPool) {
            _postToHost({ type: 'qqq-fav-jump-miss', questId: questId, floorNum: floorNum, reason: 'card' });
            return;
        }
        // ① 任务存在性（磁盘索引为准；不存在 → 主窗口提示）
        var entry = null;
        try {
            var list = await questStore.list();
            for (var i = 0; i < list.length; i++) { if (list[i].id === questId) { entry = list[i]; break; } }
        } catch (_) { }
        if (!entry) { _postToHost({ type: 'qqq-fav-jump-miss', questId: questId, floorNum: floorNum, reason: 'quest' }); return; }
        _favLockArm(questId);   // ★ 已在场的情形也上锁（新楼完结等挂起的延迟滚底同样必须让路）
        // ② 切 quest（复用全链：所有权/恢复/布局；建楼未出首 house 等情形由 switchQuest 自身拒绝并提示）
        if (questActiveId !== questId) {
            await switchQuest(questId);
            _favLockArm(questId);   // ★ 第一时间上锁（微任务内，早于切换收尾的 setTimeout 滚底宏任务）
            if (questActiveId !== questId) { await _favSleep(600); await switchQuest(questId); }
            if (questActiveId !== questId) {
                var _own = _favOwnerOf(questId);
                var _ownedBy = (_own === 0 || _own === 1 || _own === 2) ? _own : undefined;
                // 「未收到 house 1」拒绝：switchQuest 已自带提示 → 不重复报
                var _ag = (parent && parent.__qqq_agentPool && parent.__qqq_agentPool[questActiveId]) || null;
                var _explained = !!(_ag && _ag._stopState === 'sending'
                    && (_ag._deferRenderUntilHouse1 || _ag._houseIndex == null || _ag._houseIndex <= 0));
                if (!_explained) {
                    _postToHost({
                        type: 'qqq-fav-jump-miss', questId: questId, floorNum: floorNum,
                        reason: _ownedBy === undefined ? 'busy' : 'owner', owner: _ownedBy
                    });
                }
                return;
            }
        }
        // ③ 卡就绪（首次进入为异步加载；轻轮询 ≤4s）
        var card = cardPool.getCard(questId);
        for (var w = 0; w < 40 && (!card || card.totalFloors <= 0); w++) {
            await _favSleep(100);
            card = cardPool.getCard(questId);
        }
        if (!card || card.totalFloors <= 0) { _postToHost({ type: 'qqq-fav-jump-miss', questId: questId, floorNum: floorNum, reason: 'card' }); return; }
        _favLockArm(questId);
        // ④ 楼层 DOM：在 → 直达；被卡上限裁掉（孤儿层）→ 磁盘按需重建
        var dom = card.floorDOM[floorNum];
        if (!dom || !dom.aiEl) {
            var ok = await _favRebuildFloor(card, questId, floorNum);
            if (!ok) { _postToHost({ type: 'qqq-fav-jump-miss', questId: questId, floorNum: floorNum, reason: 'floor' }); return; }
            dom = card.floorDOM[floorNum];
        }
        if (!dom || !dom.aiEl) return;
        // ⑤ 滚动居中 + 金色闪 3 下（锁罩住落点：一切自动滚底不得翻盘）
        _favLockArm(questId);
        _favScrollAndFlash(card, dom);
    } catch (_e) {
        // 静默：绝不打断面板
    } finally {
        _favJumpBusy = false;
        if (_favPending) { var p = _favPending; _favPending = null; _favJump(p.questId, p.floorNum); }
    }
}

window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.type) return;
    if (d.type === 'qqq-fav-state') { _favOnState(d.items); return; }
    if (d.type === 'qqq-fav-jump') {
        var jid = String(d.jid || '');
        if (jid) _postToHost({ type: 'qqq-fav-jump-ack', jid: jid });   // ★ 回执：主窗口投递泵收到即停
        var now = Date.now();
        if (jid && jid === _favLastJid && (now - _favLastJidTs) < 20000) return;   // 重试重复投递：已执行/执行中
        if (jid) { _favLastJid = jid; _favLastJidTs = now; }
        _favJump(String(d.questId || ''), parseInt(d.floorNum, 10) || 0);
        return;
    }
    if (d.type === 'qqq-lang-change') { if (_favRefreshAll() > 0) _favScheduleRefresh(4); return; }
});

// 启动主动拉一次状态（主窗口先加载广播在前时，面板后挂载也能收敛）
try { _postToHost({ type: 'qqq-fav-query' }); } catch (_) { }
