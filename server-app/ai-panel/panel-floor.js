'use strict';

// ═══ 楼层 txt 归档：单 all.txt，完整时间线（分隔线区分 USER/HOUSE/ROOM/ANSWER） ═══
async function generateFloorTxt() {
    var root = questStore.getProjectRoot();
    if (!root) return;
    var houses = agent._houses;
    if (!houses || houses.length === 0) return;
    var floorNum = agent._ctx.totalFloors;
    var questId = questActiveId;
    if (!questId) return;

    // 优先使用已存储的精确路径（与流式写入一致）
    var allTxtPath = agent._allTxtPath || '';
    var dir = '';
    if (allTxtPath) {
        dir = allTxtPath.replace(/\/all\.txt$/, '/');
    } else {
        var quests = await questStore.list();
        var questEntry = quests.find(function (q) { return q.id === questId; }) || null;
        var rawQTitle = (questEntry && questEntry.title && questEntry.title !== 'New Chat') ? questEntry.title : '';
        var qNumericId = (questEntry && questEntry.numericId) ? questEntry.numericId : parseInt(questId.replace('q', ''), 10) || 0;
        var qDirName = await _resolveQuestDirName(root, questId, qNumericId, rawQTitle);
        var _uiFallback = agent._lastUserInput;
        var _uiTextFallback = (_uiFallback && _uiFallback.text) ? _uiFallback.text.replace(/\n/g, ' ').trim() : '';
        var fDirName = _makeName('f', floorNum, _uiTextFallback || '');
        dir = root + '/qqq/quests/' + qDirName + '/' + fDirName + '/';
    }
    try {
        if (!(window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.fs)) return;
        var bridge = window.parent.qqqideBridge;
        await bridge.fs.mkdir(dir);
        var now = new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        var ts = function (d) {
            if (!d) d = now;
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        };
        var timing = agent._floorTiming;
        var lines = [];

        // ═══ 计算 body size ═══
        var ui = agent._lastUserInput;
        var fmtK = function (bytes) { return (bytes / 1024).toFixed(3) + 'k'; };
        var userText = (ui && ui.text) ? ui.text.trim() : '';
        var visionText = (ui && ui.vision) ? ui.vision.trim() : '';
        var askBytes = userText ? new TextEncoder().encode(userText).length : 0;
        var sourceBytes = visionText ? new TextEncoder().encode(visionText).length : 0;
        var promptBytes = 0;
        var ruleBytes = 0;
        var memoryBytes = 0;
        var conv = agent.conversation;
        for (var ci = 0; ci < conv.length; ci++) {
            var cm = conv[ci];
            if (!cm || typeof cm.content !== 'string') continue;
            var cb = new TextEncoder().encode(cm.content).length;
            if (cm._persistent) {
                if (typeof SYSTEM_PROMPT !== 'undefined' && cm.content.indexOf(SYSTEM_PROMPT) === 0) {
                    promptBytes += cb;
                } else {
                    ruleBytes += cb;
                }
            } else if (cm.role === 'user' && cm._floor === floorNum) {
                memoryBytes += Math.max(0, cb - askBytes - sourceBytes);
            } else {
                memoryBytes += cb;
            }
        }
        var totalBytes = askBytes + sourceBytes + promptBytes + ruleBytes + memoryBytes;

        // ═══ floor 头 ═══
        var floorTs = timing && timing.floorStartServerMs ? new Date(timing.floorStartServerMs) : now;
        lines.push('floor.' + floorNum + '   ' + ts(floorTs));
        lines.push('');
        lines.push('(body ' + fmtK(totalBytes) + ': ask ' + fmtK(askBytes) + ' + rule ' + fmtK(ruleBytes) + ' + Source code ' + fmtK(sourceBytes) + ' + prompt ' + fmtK(promptBytes) + ' + memory ' + fmtK(memoryBytes) + ')');
        lines.push('');
        if (userText) { lines.push(userText); lines.push(''); }
        if (visionText) { lines.push(visionText); lines.push(''); }

        // ═══ HOUSE + ROOM 块 ═══
        for (var hi = 0; hi < houses.length; hi++) {
            var h = houses[hi];
            var houseTs = h.ts ? new Date(h.ts) : now;
            lines.push('\u2550\u2550\u2550\u2550 HOUSE ' + h.index + ' \u2550\u2550\u2550\u2550 ' + ts(houseTs) + ' [' + h.ms + 'ms] \u2550\u2550\u2550\u2550');


            if (h.reasoning) {
                lines.push('<thinking>');
                lines.push(h.reasoning);
                lines.push('</thinking>');
                lines.push('');
            }

            if (h.tools && h.tools.length > 0) {
                for (var ti = 0; ti < h.tools.length; ti++) {
                    var t = h.tools[ti];
                    var argsStr = (typeof t.args === 'string') ? t.args : JSON.stringify(t.args || {});
                    lines.push('  \u2500\u2500 ROOM ' + h.index + '.' + (ti + 1) + '  ' + t.name + '(' + argsStr + ') \u2500\u2500');
                    if (h.toolResults && h.toolResults[ti]) {
                        lines.push(h.toolResults[ti]);
                        lines.push('');
                    }
                }
            }

            if (h.type === 'final' && h.answer) {
                lines.push('  <answer>');
                lines.push(h.answer);
                lines.push('  </answer>');
            }

            lines.push('');
        }

        // ═══ floor stats + az 区（每层楼私有） ═══
        if (timing) {
            lines.push('\u2550\u2550\u2550\u2550 floor ' + floorNum + ' stats \u2550\u2550\u2550\u2550');
            lines.push('network: ' + (timing.networkMs ? timing.networkMs.toFixed(0) : '0') + 'ms  AI: ' + (timing.aiMs ? timing.aiMs.toFixed(0) : '0') + 'ms  tool: ' + (timing.toolMs ? timing.toolMs.toFixed(0) : '0') + 'ms  cost: ' + (agent._floorCostWge / 10000).toFixed(4) + ' ge');
            // az 区文本化
            var _floorDataForAz = { houses: houses, allTxtPath: agent._allTxtPath || '', costWge: agent._floorCostWge, floorFree: agent._floorFree || false, a4Snapshots: agent._a4Snapshots || {} };
            var _questMetaForAz = { floorTimings: agent._floorTimings || [] };
            var _azLines2 = _buildAzText(floorNum, _floorDataForAz, _questMetaForAz);
            for (var _azi2 = 0; _azi2 < _azLines2.length; _azi2++) {
                lines.push(_azLines2[_azi2]);
            }
        }

        // 写入前检查总大小（唯一真理守卫 4MB）
        if (!_guardAllTxtSize(lines)) return;
        var _txtContent = lines.join('\n');
        await bridge.fs.write(dir + 'all.txt', _txtContent);
        // [silent] floor txt written
    } catch (e) {
        console.warn('[quests] generateFloorTxt failed:', e);
    }
}

// ═══ 构建 az 区文本（每层楼私有：A1 统计 + 时钟 + 文件变更） ═══
function _buildAzText(floorNum, floorData, questMeta) {
    var lines = [];
    var houses = floorData.houses || [];
    var hCount = houses.length;
    var rCount = 0;
    for (var hi = 0; hi < houses.length; hi++) {
        if (houses[hi].tools) rCount += houses[hi].tools.length;
    }

    var a4Snapshots = floorData.a4Snapshots || {};
    var timings = (questMeta && questMeta.floorTimings) || [];

    // A4: 文件快照明细
    if (a4Snapshots && typeof a4Snapshots === 'object') {
        var a4Paths = Array.isArray(a4Snapshots) ? a4Snapshots : Object.keys(a4Snapshots);
        if (a4Paths.length > 0) {
            for (var a4i = 0; a4i < a4Paths.length; a4i++) {
                var s = Array.isArray(a4Snapshots) ? a4Paths[a4i] : a4Snapshots[a4Paths[a4i]];
                if (!s || !s.path) continue;
                var fname = s.path.replace(/\\/g, '/').split('/').pop() || s.path;
                var opLabel = s.op === 'create_file' ? '[new]' : s.op === 'delete_file' ? '[del]' : '[mod]';
                var statStr = (s.added > 0 ? '+' + s.added : '') + (s.deleted > 0 ? ' -' + s.deleted : '');
                if (!statStr) statStr = '~0';
                lines.push('az> ' + opLabel + ' ' + fname + '  ' + statStr);
            }
        }
    }

    // A1: 楼层统计（行1: Floor/House/Room, 行2: FILE/ROW）
    var allTxtSize = '';
    if (floorData.allTxtPath && floorData.allTxtPath.length > 0) {
        allTxtSize = ' [all.txt: ' + floorData.allTxtPath.split('/').pop() + ']';
    }
    lines.push('az> Floor ' + floorNum + '  House ' + hCount + '  Room ' + rCount + allTxtSize);
    var fs = _computeFileStats(houses, a4Snapshots);
    if (fs.fileCount > 0 || fs.added > 0 || fs.deleted > 0) {
        lines.push('az> FILE ' + fs.fileCount + '   ROW +' + fs.added + ' -' + fs.deleted);
    }

    // A3: 时钟
    for (var tii = 0; tii < timings.length; tii++) {
        if (timings[tii].floorIndex === floorNum) {
            var t = timings[tii];

            var durS = Math.round((t.durationMs || 0) / 1000);
            var min = Math.floor(durS / 60);
            var sec = durS % 60;
            var netS = Math.round((t.networkMs || 0) / 1000);
            var aiS = Math.round((t.aiMs || 0) / 1000);
            var toolS = Math.round((t.toolMs || 0) / 1000);
            lines.push('az> \u23f1 ' + min + 'm' + (sec < 10 ? '0' : '') + sec + 's  Net:' + netS + 's  AI:' + aiS + 's  Tool:' + toolS + 's');
            break;
        }
    }

    // 成本
    if (floorData.costWge) {
        var ge = (floorData.costWge / 10000).toFixed(4);
        lines.push('az> \ud83d\udcb0 ' + ge + ' ge');
    }

    return lines;
}

async function _appendToSearchQuest(questId, floorNum) {
    if (!questId || !floorNum) return;
    var root = questStore.getProjectRoot();
    if (!root) return;
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge) return;

    try {
        // 读 floor 数据（唯一真理 SQLite）
        var floorData = await questStore.loadFloor(questId, floorNum);
        if (!floorData) return;
        var questMeta = await questStore.load(questId);

        // 解析 quest 目录路径：优先从 floor 数据推导，回退到磁盘搜索
        var questDir = '';
        if (floorData.allTxtPath) {
            // 从 all.txt 路径反推：.../quests/q{n}.xxx/f{n}.xxx/all.txt → .../quests/q{n}.xxx/
            var parts = floorData.allTxtPath.replace(/\\/g, '/').split('/');
            var questIdx = parts.indexOf('quests');
            if (questIdx >= 0 && questIdx + 1 < parts.length) {
                questDir = parts.slice(0, questIdx + 2).join('/') + '/';
            }
        }
        if (!questDir) {
            // 回退：磁盘搜索以 questId 为前缀的目录
            var questsDir = root + '/qqq/quests/';
            try {
                var entries = await bridge.fs.list(questsDir);
                for (var ei = 0; ei < entries.length; ei++) {
                    if (entries[ei].name.startsWith(questId + '.') && entries[ei].isDir) {
                        questDir = questsDir + entries[ei].name + '/';
                        break;
                    }
                }
            } catch (_) { }
        }
        if (!questDir) return;  // 无法解析目录，静默跳过
        var searchPath = questDir + 'search_quest.txt';

        // 提取时间戳
        var now = new Date();
        var pad2 = function (n) { return String(n).padStart(2, '0'); };
        var ts = function (d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); };
        var floorTs = now;
        if (questMeta && questMeta.floorTimings) {
            for (var ti = 0; ti < questMeta.floorTimings.length; ti++) {
                var ft = questMeta.floorTimings[ti];
                if (ft.floorIndex === floorNum && ft.finishedAt) {
                    floorTs = new Date(new Date(ft.finishedAt).getTime() - (ft.durationMs || 0));
                    break;
                }
            }
        }

        // 标记行，用于去重检测
        var marker = '\u2550\u2550\u2550\u2550\u2550 Floor ' + floorNum + ' \u2550\u2550\u2550\u2550\u2550';

        // 读已有内容（若存在），检查是否已写过本层楼
        var existing = '';
        var fileExists = await bridge.fs.exists(searchPath);
        if (fileExists) {
            try { existing = await bridge.fs.read(searchPath); } catch (_) { }
        }
        if (existing.indexOf(marker) >= 0) return;  // 已存在，跳过

        // 提取 AI 最终回答（最后一个 final 类型 house 的 answer）
        var houses = floorData.houses || [];
        var answer = '';
        for (var hi = houses.length - 1; hi >= 0; hi--) {
            if (houses[hi].type === 'final' && houses[hi].answer) {
                answer = houses[hi].answer;
                break;
            }
        }

        // 构建条目
        var lines = [];
        if (existing) lines.push('');  // 与上一楼层间隔一行
        lines.push(marker + '   ' + ts(floorTs));
        lines.push('\u25a0 Q: ' + (floorData.question || ''));
        lines.push('\u25a0 A: ' + (answer || '(no answer)'));

        // ═══ az 区文本化（每层楼私有 A1 + 时钟数据） ═══
        var _azLines = _buildAzText(floorNum, floorData, questMeta);
        for (var _azi = 0; _azi < _azLines.length; _azi++) {
            lines.push(_azLines[_azi]);
        }
        lines.push('');

        // 确保目录存在
        try { await bridge.fs.mkdir(questDir); } catch (_) { }

        // 追加写入
        var newContent = existing + lines.join('\n');
        await bridge.fs.write(searchPath, newContent);
        // [silent] search_quest appended
    } catch (e) {
        console.warn('[search_quest] failed:', e && e.message);
    }
}

var _switching = false;  // 互斥锁：防止快速双击 tab 导致并发切任务
// ═══ 从 questStore 恢复 agent 全量状态（conversation + metadata） ═══
async function _restoreAgentFromStore(questId, ag) {
    if (!questId || !ag) return;
    try {
        var data = await questStore.load(questId);
        var allFloors = await questStore.loadAllFloors(questId);

        // 重建 conversation：聚合所有楼层
        ag.conversation = [];
        for (var fi = 0; fi < allFloors.length; fi++) {
            var fConv = allFloors[fi].data.conversation;
            if (fConv && fConv.length) {
                for (var mi = 0; mi < fConv.length; mi++) {
                    ag.conversation.push(fConv[mi]);
                }
            }
        }

        // ★ 修复断裂的 tool_calls（循环至干净，200 轮/次，最多 10 次）
        if (ag._repairOrphanedToolCalls) {
            for (var _rp = 0; _rp < 10; _rp++) {
                var _lenPre = ag.conversation.length;
                ag._repairOrphanedToolCalls();
                if (ag.conversation.length === _lenPre) break;  // 无修复产出 → 已干净
            }
        }

        // 恢复 metadata
        if (data) {
            ag.totalCostGe = data.totalCostGe || 0;
            ag._lastApiPromptTokens = data.lastApiPromptTokens || 0;
            ag._lastApiTotalTokens = data.lastApiTotalTokens || 0;
            ag._lastTier = data.lastTier || null;
            ag._uncleanShutdown = data.uncleanShutdown || false;
            ag._ctx.lastCompressedFloor = (data.ctx && data.ctx.lastCompressedFloor) || 0;
            ag._ctx.floorArchives = (data.ctx && data.ctx.floorArchives) || [];
            ag._floorTimings = data.floorTimings || [];
            ag._serverDrift = data.serverDrift || 0;
            _queue = data.queue || [];
            ag._rulesVersion = data.rulesVersion || '';
            ag._persistentCount = data.persistentCount || 0;
        } else {
            ag.totalCostGe = 0;
            ag._lastApiPromptTokens = 0;
            ag._lastApiTotalTokens = 0;
            ag._lastTier = null;
            ag._uncleanShutdown = false;
            ag._ctx.lastCompressedFloor = 0;
            ag._ctx.floorArchives = [];
            ag._floorTimings = [];
            ag._serverDrift = 0;
            _queue = [];
        }
        // ★ 崩溃恢复：上次关闭时正在压缩 → 修复可能的半成品状态
        if (ag._uncleanShutdown) {
            ag._uncleanShutdown = false;
            console.warn('[restore] unclean shutdown detected — repairing');
            if (typeof ag._repairOrphanedToolCalls === 'function') {
                try { ag._repairOrphanedToolCalls(); } catch (_) { }
            }
        }
        // [silent] restored agent state
    } catch (e) {
        console.warn('[quests] _restoreAgentFromStore error:', e && e.message);
    }
}
