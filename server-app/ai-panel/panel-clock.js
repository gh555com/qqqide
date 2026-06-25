'use strict';
// \u2550\u2550\u2550 panel-clock.js \u2550\u2550\u2550
// Floor timer, pie chart, autoSave, quest dropdown, tofu, boot

// ★ 全局变量已移除：_floorTimerId / _floorStartPerf / _floorCurrentTiming / _activeAiDiv
//   全部移入 agent 对象（agent._floorTimerId / agent._floorStartPerf 等）
//   保留：_lastPieTiming（canvas 去重缓存，无关 agent）、_autoSaveTimer（面板级）
var _lastPieTiming = null;
var _autoSaveTimer = null;

// ── 保存单个 agent 的当前楼层到 all.json（auto-save + beforeunload 共用）──
//   force: true → 跳过去重检查（beforeunload 用）
function _saveAgentFloor(ag, questId, force) {
    if (!ag || !ag._currentFloorNum || ag._currentFloorNum <= 0) return;
    if (typeof questStore === 'undefined' || !questStore || !questStore.saveFloor) return;
    var floorNum = ag._currentFloorNum;

    // ★ 安全网：_houses 为空且非新楼层时跳过，防重启后覆盖已有数据
    //   _lastAutoSaveLen === 0 仅在新楼层初始化时设置（panel-send.js），是唯一准入空 houses 的路径
    if ((!ag._houses || ag._houses.length === 0) && ag._lastAutoSaveLen !== 0) return;
    if (!force) {
        // ★ 去重：仅在 conversation 增长时才写盘（避免无变化的 O(n) slice + payload 构建）
        var convLen = ag.conversation ? ag.conversation.length : 0;
        if (ag._lastAutoSaveLen && convLen <= ag._lastAutoSaveLen) return;
        ag._lastAutoSaveLen = convLen;
    }
    var payload;
    if (typeof window._a4BuildCompleteFloorPayload === 'function') {
        payload = window._a4BuildCompleteFloorPayload(ag, floorNum);
    } else {
        payload = {
            question: (ag._lastUserInput && ag._lastUserInput.text) || '',
            conversation: ag.conversation ? ag.conversation.slice() : [],
            houses: (ag._houses || []).slice(),
            costWge: ag._floorCostWge,
            lastUserInput: ag._lastUserInput,
            createdAt: Date.now()
        };
    }
    questStore.saveFloor(questId, floorNum, payload).catch(function (e) {
        console.warn('[auto-save] saveFloor failed for q=' + questId + ' f=' + floorNum + ': ' + (e && e.message || e));
        if (typeof _writeFileLog === 'function') _writeFileLog('⚠ auto-save fail q=' + questId + ' f=' + floorNum + ': ' + (e && e.message || e));
    });
}

var _AUTOSAVE_INTERVAL = 5000;
var _autoSaveRunning = false;
// ★ 面板级持久定时器：启动一次，永不停止，遍历 agentPool 覆盖全部 agent
function _ensureAutoSave() {
    if (_autoSaveRunning) return;
    _autoSaveRunning = true;
    _autoSaveTimer = setInterval(function () {
        var pool = (typeof agentPool !== 'undefined') ? agentPool : null;
        if (!pool) return;
        var ids = Object.keys(pool);
        for (var i = 0; i < ids.length; i++) {
            _saveAgentFloor(pool[ids[i]], ids[i]);
        }
    }, _AUTOSAVE_INTERVAL);
}

// ── beforeunload：保存所有在建楼层（防崩溃丢数据）──
function _saveAllBeforeUnload() {
    var pool = (typeof agentPool !== 'undefined') ? agentPool : null;
    if (!pool) return;
    var ids = Object.keys(pool);
    for (var i = 0; i < ids.length; i++) {
        _saveAgentFloor(pool[ids[i]], ids[i], true);
    }
}
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', _saveAllBeforeUnload);
    // ★ auto-save 面板级持久 timer：模块加载即启动，永不停止
    _ensureAutoSave();
}

function _showPieTooltip(html, cx, cy) {
    _postToHost({ type: 'qqq-pie-tooltip', action: 'show', html: html, clientX: cx, clientY: cy });
}
function _hidePieTooltip() {
    _postToHost({ type: 'qqq-pie-tooltip', action: 'hide' });
}

function drawPie(canvas, timing) {
    if (_lastPieTiming && timing &&
        _lastPieTiming.networkMs === timing.networkMs &&
        _lastPieTiming.aiMs === timing.aiMs &&
        _lastPieTiming.toolMs === timing.toolMs) return;
    _lastPieTiming = timing ? { networkMs: timing.networkMs, aiMs: timing.aiMs, toolMs: timing.toolMs } : null;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var n = timing.networkMs || 0;
    var d = timing.aiMs || 0;
    var t = timing.toolMs || 0;
    var total = timing.totalMs || (n + d + t);
    if (total <= 0) { ctx.fillStyle = '#555'; ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 3, 0, Math.PI * 2); ctx.fill(); canvas._segments = null; return; }
    t = Math.max(0, total - n - d);
    var parts = [
        { val: d, color: '#859900', label: 'AI', key: 'ai' },
        { val: n, color: '#cb4b16', label: 'Network', key: 'network' },
        { val: t, color: '#e6b800', label: 'Tool', key: 'tool' }
    ];
    var start = -Math.PI / 2;
    var segments = [];
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].val <= 0) continue;
        var slice = (parts[i].val / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(w / 2, h / 2);
        ctx.arc(w / 2, h / 2, w / 2 - 3, start, start + slice);
        ctx.fillStyle = parts[i].color;
        ctx.fill();
        segments.push({ startAngle: start, endAngle: start + slice, label: parts[i].label, key: parts[i].key, ms: parts[i].val, color: parts[i].color });
        start += slice;
    }
    canvas._segments = segments;
    canvas._total = total;
}

// ── ge 显示格式化：2位小数，四舍五入，最小0.01 ──
function _formatGeDisplay(rawValue) {
    if (rawValue <= 0) return '0.00';
    var rounded = Math.round(rawValue * 100) / 100;
    if (rounded < 0.01) return '0.01';
    return rounded.toFixed(2);
}
function _formatGeRaw(rawValue) {
    // 保留最多6位小数，去尾零
    return rawValue.toFixed(6).replace(/\.?0+$/, '') || '0';
}

function _initClockBlock(aiDiv) {
    if (aiDiv._clockBlock) return;
    var block = document.createElement('div');
    block.className = 'msg-ai-clock';
    block.innerHTML = '<span class="clock"><span class="clock-min">0m</span><span class="clock-sec">:0s</span></span><canvas width="112" height="112"></canvas><span class="clock-cost" style="display:none;font-family:ui-monospace,monospace;font-weight:700;font-size:18px;color:var(--text-primary);margin-left:auto">0.00 ge</span>';
    aiDiv.appendChild(block);
    aiDiv._clockBlock = block;
    aiDiv._clockMin = block.querySelector('.clock-min');
    aiDiv._clockSec = block.querySelector('.clock-sec');
    aiDiv._clockCanvas = block.querySelector('canvas');
    aiDiv._clockCost = block.querySelector('.clock-cost');
    var clockCost = aiDiv._clockCost;
    clockCost.addEventListener('mouseenter', function (e) {
        var raw = clockCost._rawGe;
        if (raw === undefined || raw === null) return;
        _showPieTooltip('<span style="color:#fff">' + raw + ' ge</span>', e.clientX, e.clientY);
    });
    clockCost.addEventListener('mouseleave', function () { _hidePieTooltip(); });
    var canvas = aiDiv._clockCanvas;
    canvas.addEventListener('mousemove', function (e) {
        if (!canvas._segments || !canvas._total) { _hidePieTooltip(); return; }
        var parts = [
            { key: 'ai', color: '#859900', label: 'AI' },
            { key: 'network', color: '#cb4b16', label: 'Net' },
            { key: 'tool', color: '#e6b800', label: 'Tool' }
        ];
        var segs = canvas._segments;
        var map = {};
        for (var si = 0; si < segs.length; si++) { map[segs[si].key] = segs[si]; }
        var html = '';
        for (var pi = 0; pi < parts.length; pi++) {
            var p = parts[pi];
            var s = map[p.key];
            var ms = s ? s.ms : 0;
            html += '<span style="display:inline-flex;align-items:center;gap:8px;margin-right:16px">'
                + '<svg width="20" height="20" style="flex-shrink:0"><circle cx="10" cy="10" r="9" fill="' + p.color + '"/></svg>'
                + '<span style="color:#fff">' + Math.round(ms / 1000) + 's</span></span>';
        }
        _showPieTooltip(html, e.clientX, e.clientY);
    });
    canvas.addEventListener('mouseleave', function () { _hidePieTooltip(); });
}

function startFloorTimer(aiDiv, ag, resume) {
    ag._activeAiDiv = aiDiv;
    if (!resume || !ag._floorStartPerf) {
        ag._floorStartPerf = performance.now();
    }
    ag._floorCurrentTiming = null;
    _initClockBlock(aiDiv);
    var clockMin = aiDiv._clockMin;
    var clockSec = aiDiv._clockSec;
    var canvas = aiDiv._clockCanvas;
    var elapsed = performance.now() - ag._floorStartPerf;
    var totalS = Math.floor(elapsed / 1000);
    var min = Math.floor(totalS / 60);
    var sec = totalS % 60;
    clockMin.textContent = min + 'm';
    clockSec.textContent = ':' + (sec < 10 ? '0' : '') + sec + 's';
    aiDiv._clockBlock.className = 'msg-ai-clock clock-ai';
    canvas.style.visibility = 'hidden';
    if (aiDiv._clockCost) {
        aiDiv._clockCost.textContent = '0.00 ge';
        aiDiv._clockCost.style.display = 'inline';
        aiDiv._clockCost._rawGe = null;
    }
    var _pieShown = false;
    var _lastN = 0, _lastD = 0, _lastT = 0;
    var _ag = ag;
    // ★ 防御：先清除可能残存的旧 timer（防止重复 start 产生僵尸）
    if (ag._floorTimerId) { clearInterval(ag._floorTimerId); ag._floorTimerId = null; }
    ag._floorTimerId = setInterval(function () {
        // ★ 守卫1：楼层已干净完结 → 自停（防僵尸 timer）
        if (_ag._floorCompletedCleanly) {
            clearInterval(_ag._floorTimerId);
            _ag._floorTimerId = null;
            return;
        }
        // ★ 守卫2：DOM 有效性 — 若 aiDiv 已脱离 DOM（Card 被驱逐/重建），停止 timer
        var _curDiv = _ag._activeAiDiv;
        if (!_curDiv || !_curDiv._clockBlock || !_curDiv._clockBlock.isConnected) {
            clearInterval(_ag._floorTimerId);
            _ag._floorTimerId = null;
            return;
        }
        var elapsed = performance.now() - _ag._floorStartPerf;
        var totalS = Math.floor(elapsed / 1000);
        var min = Math.floor(totalS / 60);
        var sec = totalS % 60;
        clockMin.textContent = min + 'm';
        clockSec.textContent = ':' + (sec < 10 ? '0' : '') + sec + 's';
        var at = _ag._floorTiming;
        var n = (at && at.networkMs) || 0;
        var d = (at && at.aiMs) || 0;
        var t = (at && at.toolMs) || 0;
        if (!_pieShown && (n > 0 || d > 0 || t > 0)) { _pieShown = true; canvas.style.visibility = 'visible'; }
        if (!_pieShown) return;
        var state = 'ai';
        if (t > _lastT) state = 'tool';
        else if (d > _lastD) state = 'ai';
        else if (n > _lastN) state = 'network';
        _lastN = n; _lastD = d; _lastT = t;
        aiDiv._clockBlock.className = 'msg-ai-clock clock-' + state;
        drawPie(canvas, { networkMs: n, aiMs: d, toolMs: t, totalMs: elapsed });
    }, 1000);
}

function stopFloorTimer(timing, ag) {
    if (ag._floorTimerId) { clearInterval(ag._floorTimerId); ag._floorTimerId = null; }
    ag._floorCurrentTiming = timing;
    var elapsed = performance.now() - ag._floorStartPerf;
    var totalS = Math.floor(elapsed / 1000);
    var min = Math.floor(totalS / 60);
    var sec = totalS % 60;
    var aiDiv = ag._activeAiDiv;
    if (aiDiv && aiDiv._clockBlock) {
        aiDiv._clockBlock.className = 'msg-ai-clock';
    }
    if (aiDiv && aiDiv._clockMin && aiDiv._clockCanvas) {
        aiDiv._clockMin.textContent = min + 'm';
        aiDiv._clockSec.textContent = ':' + (sec < 10 ? '0' : '') + sec + 's';
        var tm = timing || { networkMs: 0, aiMs: 0, toolMs: 0 };
        tm.totalMs = elapsed;
        if (elapsed > 0) { aiDiv._clockCanvas.style.visibility = 'visible'; drawPie(aiDiv._clockCanvas, tm); }
    }
    // ★ 不再清空 _activeAiDiv：它是 agent 与 Card DOM 的永久绑定，切 quest 时 switchQuest 负责重绑
    var durationMs = Math.round(elapsed);
    var record = {
        floorIndex: ag._ctx.totalFloors,
        durationMs: durationMs,
        networkMs: (timing && timing.networkMs) || 0,
        aiMs: (timing && timing.aiMs) || 0,
        toolMs: (timing && timing.toolMs) || 0,
        finishedAt: new Date().toISOString()
    };
    ag._floorTimings = ag._floorTimings || [];
    ag._floorTimings.push(record);
    ag._lastFloorTimingRecord = record;
}

// ── Quest 豆腐块 + hover 下拉 ──
var _questDrop = null;
var _q2Shimmer = null;
var _questDropTimer = null;
var _questSearchText = '';
var _questDropLimit = 20;
var _questSearchFocused = false;  // ★ 搜索框焦点追踪
function closeQuestDrop() {
    if (_questDrop) { _questDrop.remove(); _questDrop = null; }
    if (_q2Shimmer) { _q2Shimmer.remove(); _q2Shimmer = null; }
    _questSearchText = '';
    _questDropLimit = 20;
    _questSearchFocused = false;
    var bar = document.getElementById('quest-bar');
    if (bar) bar.classList.remove('quest-expanded');
}
function _matchQuest(query, title) {
    if (!query) return true;
    var tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    var lower = title.toLowerCase();
    for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        var pos = 0;
        var matched = true;
        for (var ci = 0; ci < t.length; ci++) {
            pos = lower.indexOf(t[ci], pos);
            if (pos === -1) { matched = false; break; }
            pos++;
        }
        if (!matched) return false;
    }
    return true;
}
async function renderQuestDrop() {
    if (!_questDrop) return;
    var allQuests = await questStore.list();
    if (!_questDrop) return;
    var query = _questSearchText;
    var filtered = query
        ? allQuests.filter(function (q) {
            var displayName = 'q' + (q.numericId || '?') + '.' + (q.title || '');
            return _matchQuest(query, displayName);
        })
        : allQuests;
    var displayCount = Math.min(filtered.length, _questDropLimit);
    var oldBody = _questDrop.querySelector('.quest-drop-body');
    if (oldBody) oldBody.remove();
    var body = document.createElement('div');
    body.className = 'quest-drop-body';
    for (var i = 0; i < displayCount; i++) {
        (function (s) {
            // ★ 彗星标记：读父窗口中心机器，所有正在建楼的 quest 都显示环绕
            var runningIds = (typeof _getRunningQuestIds === 'function') ? _getRunningQuestIds() : [];
            var isRunning = runningIds.indexOf(s.id) >= 0;
            var item = document.createElement('div');
            item.className = 'quest-drop-item' + (s.id === questActiveId ? ' active' : '') + (isRunning ? ' running' : '');
            var line = document.createElement('span');
            line.className = 'quest-drop-line';
            var prefix = document.createElement('span');
            prefix.className = 'quest-drop-prefix';
            prefix.textContent = 'q' + (s.numericId || '?') + '.  ';
            var title = document.createElement('span');
            title.className = 'quest-drop-title';
            title.textContent = s.title || '';
            line.appendChild(prefix);
            line.appendChild(title);
            item.appendChild(line);
            item.onclick = function (e) { e.stopPropagation(); closeQuestDrop(); switchQuest(s.id); };
            body.appendChild(item);
        })(filtered[i]);
    }
    if (displayCount < filtered.length) {
        var more = document.createElement('div');
        more.className = 'quest-drop-item';
        more.style.cssText = 'color:var(--base01);font-style:italic;text-align:center;pointer-events:none';
        more.textContent = '\u2026 \u8fd8\u6709 ' + (filtered.length - displayCount) + ' \u6761 \u2026';
        body.appendChild(more);
    }
    if (filtered.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'quest-drop-item';
        empty.style.cssText = 'color:var(--base01);font-style:italic';
        empty.textContent = query ? '(\u65e0\u5339\u914d)' : '(\u7a7a)';
        body.appendChild(empty);
    }
    _questDrop.appendChild(body);
    _questDrop._hasScrollbar = _questDrop.scrollHeight > _questDrop.clientHeight + 2;
    // ★ 更新悬浮层流光高度（豆腐块+下拉可视区，滚动加载更多时变高）
    if (_q2Shimmer) {
        var tofu2 = document.getElementById('quest-tofu');
        if (tofu2 && _questDrop) _q2Shimmer.style.height = (tofu2.offsetHeight + _questDrop.clientHeight) + 'px';
    }
}
async function openQuestDrop() {
    closeQuestDrop();
    _questDropLimit = 20;
    var tofu = document.getElementById('quest-tofu');
    if (!tofu) return;
    var bar = document.getElementById('quest-bar');
    var drop = document.createElement('div');
    drop.className = 'quest-drop show';
    var head = document.createElement('div');
    head.className = 'quest-drop-head';
    var addBtn = document.createElement('div');
    addBtn.className = 'quest-drop-add';
    addBtn.textContent = '+';
    addBtn.title = '\u65b0\u5efa Quest';
    addBtn.onclick = function (e) { e.stopPropagation(); closeQuestDrop(); createNewQuest(); };
    head.appendChild(addBtn);
    var search = document.createElement('input');
    search.className = 'quest-drop-search';
    search.placeholder = '\u7b5b\u9009...';
    search.value = _questSearchText;
    search.oninput = function () {
        _questSearchText = search.value;
        renderQuestDrop();
    };
    // ★ 搜索框获得焦点 → 阻止鼠标移出自动关闭
    search.addEventListener('focus', function () {
        _questSearchFocused = true;
    });
    search.addEventListener('blur', function () {
        _questSearchFocused = false;
        // 延迟关闭：允许 click 先落到下拉列表项上
        setTimeout(function () {
            if (!_questSearchFocused && _questDrop) {
                closeQuestDrop();
            }
        }, 150);
    });
    head.appendChild(search);
    drop.appendChild(head);
    bar.appendChild(drop);
    _questDrop = drop;
    // ★ 展开统一虚线框
    bar.classList.add('quest-expanded');
    drop.addEventListener('mouseenter', function () { clearTimeout(_questDropTimer); });
    drop.addEventListener('mouseleave', function () {
        // 搜索框有焦点 → 不自动关闭
        if (_questSearchFocused) return;
        _questDropTimer = setTimeout(closeQuestDrop, 120);
    });
    drop.addEventListener('click', function (e) { e.stopPropagation(); });
    drop.addEventListener('wheel', function (e) {
        if (_questDropLimit >= 60) return;
        if (drop._hasScrollbar) {
            if (drop.scrollTop + drop.clientHeight >= drop.scrollHeight - 4) {
                if (_questDropLimit < 40) _questDropLimit = 40;
                else _questDropLimit = 60;
                renderQuestDrop();
            }
        } else {
            if (_questDropLimit < 40) _questDropLimit = 40;
            else _questDropLimit = 60;
            renderQuestDrop();
        }
    });
    await renderQuestDrop();
    // ★ 悬浮层流光：覆盖整个虚线框区域（豆腐块+下拉可视区）
    if (_q2Shimmer) { _q2Shimmer.remove(); _q2Shimmer = null; }
    var sOverlay = document.createElement('div');
    sOverlay.className = 'q2-shimmer-overlay';
    sOverlay.style.top = '0';
    sOverlay.style.height = (tofu.offsetHeight + drop.clientHeight) + 'px';
    bar.appendChild(sOverlay);
    _q2Shimmer = sOverlay;
}
var _tofuEntry = null;  // 当前活跃 quest 的 index 条目，供编辑用

async function updateQuestTofu() {
    var prefixEl = document.getElementById('quest-tofu-prefix');
    var textEl = document.getElementById('quest-tofu-text');
    var pen = document.getElementById('quest-tofu-pen');
    var quests = await questStore.list();
    var entry = quests.find(function (q) { return q.id === questActiveId; });
    _tofuEntry = entry || null;
    if (entry) {
        var num = entry.numericId || '?';
        if (prefixEl) prefixEl.textContent = 'q' + num + '.  ';
        textEl.textContent = entry.title || '';
        textEl.parentElement.classList.remove('quest-tofu-new');
        if (pen) pen.style.display = '';
        // ★ 彗星环绕：读父窗口中心机器，所有正在建楼的 quest 均显示
        var runningIds = (typeof _getRunningQuestIds === 'function') ? _getRunningQuestIds() : [];
        if (runningIds.indexOf(questActiveId) >= 0) {
            textEl.parentElement.classList.add('quest-running');
        } else {
            textEl.parentElement.classList.remove('quest-running');
        }
    } else {
        if (prefixEl) prefixEl.textContent = '';
        textEl.textContent = '~ New quest ~';
        textEl.parentElement.classList.add('quest-tofu-new');
        textEl.parentElement.classList.remove('quest-running');
        if (pen) pen.style.display = 'none';
    }
    var title = 'qqq IDE';
    var root = questStore.getProjectRoot();
    if (root) {
        var parts = root.replace(/\\/g, '/').split('/');
        var folderName = parts[parts.length - 1] || parts[parts.length - 2] || root;
        title = folderName;
    }
    try { document.title = title; } catch (_) { }
    try {
        var b = _getBridge();
        if (b && b.window && b.window.setTitle) b.window.setTitle(title);
    } catch (_) { }
}

// ── 豆腐块内联编辑 ──
function _tofuStartEdit() {
    if (!_tofuEntry) return;
    var textEl = document.getElementById('quest-tofu-text');
    var editEl = document.getElementById('quest-tofu-edit');
    var pen = document.getElementById('quest-tofu-pen');
    if (!textEl || !editEl) return;
    textEl.style.display = 'none';
    editEl.style.display = 'block';
    editEl.value = _tofuEntry.title || '';
    editEl.focus();
    editEl.select();
    if (pen) pen.style.display = 'none';
}
function _tofuCommitEdit() {
    var textEl = document.getElementById('quest-tofu-text');
    var editEl = document.getElementById('quest-tofu-edit');
    var pen = document.getElementById('quest-tofu-pen');
    if (!textEl || !editEl) return;
    if (editEl.style.display === 'none') return;  // 未在编辑态
    var newTitle = editEl.value.trim();
    editEl.style.display = 'none';
    textEl.style.display = '';
    if (pen && _tofuEntry) pen.style.display = '';
    if (newTitle && _tofuEntry && newTitle !== _tofuEntry.title) {
        _tofuEntry.title = newTitle;
        textEl.textContent = newTitle;
        renameQuest(_tofuEntry.id, newTitle);
    } else {
        // 恢复原标题显示
        if (_tofuEntry) {
            textEl.textContent = _tofuEntry.title || '';
        }
    }
}
function _tofuCancelEdit() {
    var textEl = document.getElementById('quest-tofu-text');
    var editEl = document.getElementById('quest-tofu-edit');
    var pen = document.getElementById('quest-tofu-pen');
    if (!textEl || !editEl) return;
    editEl.style.display = 'none';
    textEl.style.display = '';
    if (pen && _tofuEntry) pen.style.display = '';
}
// hover \u5c55\u5f00/\u6536\u8d77 + \u7F16\u8F91\u7B14\u7ED1\u5B9A
(function () {
    var tofu = document.getElementById('quest-tofu');
    var pen = document.getElementById('quest-tofu-pen');
    var editEl = document.getElementById('quest-tofu-edit');
    if (tofu) {
        tofu.addEventListener('mouseenter', function () {
            clearTimeout(_questDropTimer);
            if (!_questDrop) openQuestDrop();
        });
        tofu.addEventListener('mouseleave', function () {
            _questDropTimer = setTimeout(closeQuestDrop, 120);
        });
    }
    if (pen) {
        pen.addEventListener('mousedown', function (e) {
            e.stopPropagation();
            e.preventDefault();
            _tofuStartEdit();
        });
        pen.addEventListener('click', function (e) {
            e.stopPropagation();
        });
    }
    if (editEl) {
        editEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); _tofuCommitEdit(); }
            if (e.key === 'Escape') { e.preventDefault(); _tofuCancelEdit(); }
        });
        editEl.addEventListener('blur', function () { _tofuCommitEdit(); });
    }
})();

document.addEventListener('click', function () {
    // 搜索框有焦点 → 不关闭（由 blur 延迟处理）
    if (_questSearchFocused) return;
    closeQuestDrop();
});

async function renderTabs() { await updateQuestTofu(); }

// ═══ Boot sequence ═══
(async function () {
    loadQqqideRules();
    await bindMainProject();
    // ★ q1 行 ↻ 按钮 — 从磁盘重新扫描 quest 列表
    var _qrsBtn = document.getElementById('quest-rescan');
    if (_qrsBtn) _qrsBtn.onclick = function () { questStore.rescan().then(function () { renderQuestDrop(); }); };
})();
