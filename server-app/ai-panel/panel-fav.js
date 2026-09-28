// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';
// ═══ panel-fav.js ═══
// 楼层收藏 · 面板侧（az 区星标 + 收藏跳转）
//   主窗口 core/floor-favs.js = 数据唯一真理源（only.sq3 ai.floorFavs）+ 命名框 + 收藏夹面板；
//   本文件只做两件事：
//   ① 星标按钮（_initClockBlock 注入，居中于饼图与 ge 之间）——点击 → 通知主窗口开命名框
//   ② 收藏跳转执行——切 quest（复用 switchQuest 全链）→ 卡上限外的孤儿楼层按需重建
//      （磁盘 all.json + _buildFloorDOM + 节点快照精准插回 + 免驱逐标记）→ 滚动居中 + 金色闪 3 下
//   协议（postMessage）：qqq-fav-state（主→面板，全量状态）/ qqq-fav-open（面板→主，点星）
//                     qqq-fav-jump（主→面板）/ qqq-fav-jump-miss（面板→主，任务或楼层不存在）/ qqq-fav-query（面板→主，主动拉状态）

var _favState = {};    // 'questId|floorNum' → { id, name }
var _favJumpBusy = false;

function _favFq(key, fb, params) {
    try { if (typeof window._qq === 'function') return window._qq(key, fb, params); } catch (_) { }
    return fb || key;
}
function _favKey(questId, floorNum) { return String(questId) + '|' + String(floorNum); }
function _favSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ── 星标外观 ──
function _favApplyStar(btn) {
    if (!btn) return;
    var qid = btn.getAttribute('data-qid') || '';
    var fn = btn.getAttribute('data-fn') || '';
    var on = !!(qid && fn && _favState[_favKey(qid, fn)]);
    if (on) btn.classList.add('on'); else btn.classList.remove('on');
    btn.textContent = on ? '\u2605' : '\u2606';
    btn.title = on ? _favFq('fav.starTipOn', '已收藏（点击编辑）') : _favFq('fav.starTip', '收藏此楼层');
}
function _favRefreshAll() {
    try {
        var btns = document.querySelectorAll('.msg-ai-clock .clock-fav');
        for (var i = 0; i < btns.length; i++) _favApplyStar(btns[i]);
    } catch (_) { }
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
        _favApplyStar(btn);
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
    _favRefreshAll();
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
    if (_favJumpBusy) return;
    _favJumpBusy = true;
    try {
        if (typeof questActiveId === 'undefined' || typeof cardPool === 'undefined' || !cardPool) return;
        // ① 任务存在性（磁盘索引为准；不存在 → 主窗口提示）
        var entry = null;
        try {
            var list = await questStore.list();
            for (var i = 0; i < list.length; i++) { if (list[i].id === questId) { entry = list[i]; break; } }
        } catch (_) { }
        if (!entry) { _postToHost({ type: 'qqq-fav-jump-miss', questId: questId, reason: 'quest' }); return; }
        // ② 切 quest（复用全链：所有权/恢复/布局；建楼未出首 house 等情形由 switchQuest 自身拒绝并提示）
        if (questActiveId !== questId) {
            await switchQuest(questId);
            if (questActiveId !== questId) { await _favSleep(600); await switchQuest(questId); }
            if (questActiveId !== questId) return;
        }
        // ③ 卡就绪（首次进入为异步加载；轻轮询 ≤4s）
        var card = cardPool.getCard(questId);
        for (var w = 0; w < 40 && (!card || card.totalFloors <= 0); w++) {
            await _favSleep(100);
            card = cardPool.getCard(questId);
        }
        if (!card || card.totalFloors <= 0) { _postToHost({ type: 'qqq-fav-jump-miss', questId: questId, reason: 'card' }); return; }
        // ④ 楼层 DOM：在 → 直达；被卡上限裁掉（孤儿层）→ 磁盘按需重建
        var dom = card.floorDOM[floorNum];
        if (!dom || !dom.aiEl) {
            var ok = await _favRebuildFloor(card, questId, floorNum);
            if (!ok) { _postToHost({ type: 'qqq-fav-jump-miss', questId: questId, reason: 'floor' }); return; }
            dom = card.floorDOM[floorNum];
        }
        if (!dom || !dom.aiEl) return;
        // ⑤ 滚动居中 + 金色闪 3 下
        _favScrollAndFlash(card, dom);
    } catch (_e) {
        // 静默：绝不打断面板
    } finally {
        _favJumpBusy = false;
    }
}

window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.type) return;
    if (d.type === 'qqq-fav-state') { _favOnState(d.items); return; }
    if (d.type === 'qqq-fav-jump') { _favJump(String(d.questId || ''), parseInt(d.floorNum, 10) || 0); return; }
    if (d.type === 'qqq-lang-change') { _favRefreshAll(); return; }
});

// 启动主动拉一次状态（主窗口先加载广播在前时，面板后挂载也能收敛）
try { _postToHost({ type: 'qqq-fav-query' }); } catch (_) { }
