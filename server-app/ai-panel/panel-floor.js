// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// ═══ 楼层 txt 归档：单 all.txt，完整时间线（分隔线区分 USER/HOUSE/ROOM/ANSWER） ═══
async function generateFloorTxt(ag, questId) {
    if (!ag || !questId) return;
    // ★ 跨面板写保护：只有建楼中的 agent 或刚完成的 agent 有权写 all.txt
    //   非建楼面板 restore 出来的 agent（stopState='idle' + floorCompletedCleanly=false）禁止覆写
    if (ag._stopState !== 'sending' && !ag._floorCompletedCleanly) return;
    var root = questStore.getProjectRoot();
    if (!root) return;
    var houses = ag._houses;
    if (!houses || houses.length === 0) return;
    // ★ 优先使用 _currentFloorNum（未可变），降级到 _ctx.totalFloors
    var floorNum = ag._currentFloorNum;

    // ★ 优先使用 _floorMeta 中的未可变路径，降级到 ag._allTxtPath
    var meta = (floorNum && ag._floorMeta && ag._floorMeta[floorNum]) ? ag._floorMeta[floorNum] : null;
    var allTxtPath = meta ? meta.allTxtPath : (ag._allTxtPath || '');
    var dir = '';
    // ★ 路径校验：quest 改名后 allTxtPath 指向旧目录 → 目录不存在 → 走磁盘扫描
    if (allTxtPath) {
        dir = allTxtPath.replace(/\/all\.txt$/, '/');
        var dirExists = false;
        try { dirExists = !!(window.parent && window.parent.qqqideBridge && await window.parent.qqqideBridge.fs.exists(dir)); } catch (_) { }
        if (!dirExists) allTxtPath = '';  // 失效 → 降级到磁盘扫描
    }
    if (!allTxtPath) {
        var quests = await questStore.list();
        var questEntry = quests.find(function (q) { return q.id === questId; }) || null;
        var rawQTitle = (questEntry && questEntry.title && questEntry.title !== 'New Chat') ? questEntry.title : '';
        var qNumericId = (questEntry && questEntry.numericId) ? questEntry.numericId : parseInt(questId.replace('q', ''), 10) || 0;
        var qDirName = await _resolveQuestDirName(root, questId, qNumericId, rawQTitle);
        var _uiFallback = ag._lastUserInput;
        var _uiTextFallback = (_uiFallback && _uiFallback.text) ? _uiFallback.text.replace(/\n/g, ' ').trim() : '';
        var fDirName = _makeName('f', floorNum, _uiTextFallback || '');
        dir = root + '/_qqq/quests/' + qDirName + '/' + fDirName + '/';
    }
    try {
        if (!(window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.fs)) return;
        var bridge = window.parent.qqqideBridge;
        // ★ 目录可能已存在（_ensureQuestDir 提前创建），mkdir EEXIST 不应阻断写入
        try { await bridge.fs.mkdir(dir); } catch (_) { }
        var timing = ag._floorTiming;
        var lines = [];

        // ═══ 计算 body size ═══
        var ui = ag._lastUserInput;
        var fmtK = function (bytes) { return (bytes / 1024).toFixed(3) + 'k'; };
        var userText = (ui && ui.text) ? ui.text.trim() : '';
        var visionText = (ui && ui.vision) ? ui.vision.trim() : '';
        var askBytes = userText ? new TextEncoder().encode(userText).length : 0;
        var sourceBytes = visionText ? new TextEncoder().encode(visionText).length : 0;
        var promptBytes = 0;
        var ruleBytes = 0;
        var memoryBytes = 0;
        var conv = ag.conversation;
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
        var floorTs = timing && timing.floorStartServerMs ? new Date(timing.floorStartServerMs) : new Date();
        lines.push('floor.' + floorNum + '   ' + _fmtTime(floorTs));
        lines.push('');
        lines.push('(body ' + fmtK(totalBytes) + ': ask ' + fmtK(askBytes) + ' + rule ' + fmtK(ruleBytes) + ' + Source code ' + fmtK(sourceBytes) + ' + prompt ' + fmtK(promptBytes) + ' + memory ' + fmtK(memoryBytes) + ')');
        lines.push('');
        if (userText) { lines.push(userText); lines.push(''); }
        if (visionText) { lines.push(visionText); lines.push(''); }

        // ═══ HOUSE + ROOM 块 ═══
        for (var hi = 0; hi < houses.length; hi++) {
            var h = houses[hi];
            var houseTs = h.ts ? new Date(h.ts) : now;
            lines.push('\u2550\u2550\u2550\u2550 HOUSE ' + h.index + ' \u2550\u2550\u2550\u2550 ' + _fmtTime(houseTs) + ' [' + h.ms + 'ms] \u2550\u2550\u2550\u2550');


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
            lines.push('network: ' + (timing.networkMs ? timing.networkMs.toFixed(0) : '0') + 'ms  AI: ' + (timing.aiMs ? timing.aiMs.toFixed(0) : '0') + 'ms  tool: ' + (timing.otherMs ? timing.otherMs.toFixed(0) : '0') + 'ms  cost: ' + (ag._floorCostWge / 10000).toFixed(4) + ' ge');
            // az 区文本化
            var _floorDataForAz = { houses: houses, allTxtPath: ag._allTxtPath || '', costWge: ag._floorCostWge, floorFree: ag._floorCostWge === 0, a4Snapshots: ag._a4Snapshots || {} };
            var _questMetaForAz = { floorTimings: ag._floorTimings || [] };
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
            var toolS = Math.round((t.otherMs || 0) / 1000);
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
    if (!root) { console.error('[search_quest] no project root'); return; }
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge) { console.error('[search_quest] no bridge'); return; }

    try {
        // 读 floor 数据（唯一真理 SQLite）
        var floorData = await questStore.loadFloor(questId, floorNum);
        if (!floorData) { console.error('[search_quest] loadFloor returned null for q=' + questId + ' f=' + floorNum); return; }
        var questMeta = await questStore.load(questId);

        // ★ 解析 quest 目录路径（V8 修复：磁盘扫描为主，allTxtPath 为备）
        //   旧逻辑 allTxtPath 优先 → quest 改名后路径过期 → 写到旧目录/重造旧目录
        var questsDir = root.replace(/\\/g, '/').replace(/\/$/, '') + '/_qqq/quests/';
        var questDir = '';
        var questDirSource = '';

        // ① 主路径：磁盘扫描 questId 前缀（改名后仍准确）
        try {
            var entries = await bridge.fs.list(questsDir);
            for (var ei = 0; ei < entries.length; ei++) {
                if (entries[ei].name.startsWith(questId + '.') && entries[ei].isDir) {
                    questDir = questsDir + entries[ei].name + '/';
                    questDirSource = 'disk-scan';
                    break;
                }
            }
        } catch (_) { }

        // ② 备路径：从 allTxtPath 反推（仅当磁盘扫描失败，且路径校验通过）
        if (!questDir && floorData.allTxtPath) {
            var parts = floorData.allTxtPath.replace(/\\/g, '/').split('/');
            var questIdx = parts.indexOf('quests');
            if (questIdx >= 0 && questIdx + 1 < parts.length) {
                var derivedDir = parts.slice(0, questIdx + 2).join('/') + '/';
                // ★ 校验：目录名必须以 questId 开头
                var dirName = parts[questIdx + 1];
                if (dirName.indexOf(questId) === 0) {
                    questDir = derivedDir;
                    questDirSource = 'allTxtPath';
                }
            }
        }

        if (!questDir) {
            console.warn('[search_quest] quest dir not found for q=' + questId + ' f=' + floorNum);
            return;
        }
        var searchPath = questDir + 'search_quest.txt';

        // 提取时间戳
        var now = new Date();
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

        // 读已有内容（若存在）
        var existing = '';
        var fileExists = await bridge.fs.exists(searchPath);
        if (fileExists) {
            try { existing = await bridge.fs.read(searchPath); } catch (_) { }
        }

        // ★ 提取 AI 最终回答（从 conversation 取最后一个 assistant 消息，非 houses[].answer 冗余副本）
        var conv = floorData.conversation || [];
        var answer = '';
        for (var ci = conv.length - 1; ci >= 0; ci--) {
            if (conv[ci].role === 'assistant' && !conv[ci].tool_calls && typeof conv[ci].content === 'string' && conv[ci].content && !conv[ci]._error) {
                answer = conv[ci].content;
                break;
            }
        }

        // 构建条目
        var lines = [];
        lines.push(marker + '   ' + _fmtTime(floorTs));
        // ★ V14 fix: [File:] 剥离改用 \n\n[File: 截断，防文件内容含 ``` 导致泄露
        var _qContent = floorData.question || '';
        var _fileIdx = _qContent.search(/\n\n\[File: /);
        var cleanQuestion = (_fileIdx >= 0 ? _qContent.slice(0, _fileIdx) : _qContent).replace(/\x0A{3,}/g, '\x0A\x0A').trim();
        lines.push('\u25a0 Q: ' + cleanQuestion);
        lines.push('\u25a0 A: ' + (answer || '(no answer)'));

        // ═══ az 区文本化（每层楼私有 A1 + 时钟数据） ═══
        var _azLines = _buildAzText(floorNum, floorData, questMeta);
        for (var _azi = 0; _azi < _azLines.length; _azi++) {
            lines.push(_azLines[_azi]);
        }

        var newBlock = lines.join('\n');

        // ★ V12 完整性守卫：文件内 floor 标记数若远超 quest 实际楼层数 → 串楼污染 → 全量重建
        var _markerMatches = existing.match(/\u2550\u2550\u2550\u2550\u2550 Floor \d+ \u2550\u2550\u2550\u2550\u2550/g);
        var _markerCount = _markerMatches ? _markerMatches.length : 0;
        var _actualFloorCount = (questMeta && questMeta.floors && questMeta.floors.length) || 999;
        if (_markerCount > _actualFloorCount + 2) {
            // 串楼污染（如 q56 的 search_quest.txt 含 q47 的 19 个楼层）
            console.warn('[search_quest] contamination detected for q=' + questId + ': markers=' + _markerCount + ' vs actualFloors=' + _actualFloorCount + ' → rebuilding');
            await _rebuildSearchQuest(questId);
            return;
        }

        // ★ 盖写式：若旧 marker 存在则替换整个 block，否则追加
        var markerIdx = existing.indexOf(marker);
        if (markerIdx >= 0) {
            // 找到本 block 结束位置（下一个 "═════" 或 EOF）
            var nextMarkerIdx = existing.indexOf('\n\u2550\u2550\u2550\u2550\u2550', markerIdx + marker.length);
            if (nextMarkerIdx < 0) nextMarkerIdx = existing.length;
            // 替换旧 block，保持楼层次序
            existing = existing.slice(0, markerIdx) + newBlock + existing.slice(nextMarkerIdx);
        } else {
            // 全新楼层：追加
            if (existing) existing += '\n';
            existing += newBlock;
        }

        // 确保目录存在
        try { await bridge.fs.mkdir(questDir); } catch (_) { }

        await bridge.fs.write(searchPath, existing);
        // [silent] search_quest appended
    } catch (e) {
        console.warn('[search_quest] failed:', e && e.message);
    }
}

// ── 全量重建 search_quest.txt（quest 改名后调用，修正旧路径污染） ──
async function _rebuildSearchQuest(questId) {
    if (!questId) return;
    var root = questStore.getProjectRoot();
    if (!root) return;
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge) return;

    try {
        var questMeta = await questStore.load(questId);
        if (!questMeta) return;
        var allFloors = await questStore.loadAllFloors(questId);
        if (!allFloors || allFloors.length === 0) return;

        // 用磁盘扫描找 quest 目录（最可靠）
        var questsDir = root.replace(/\\/g, '/').replace(/\/$/, '') + '/_qqq/quests/';
        var questDir = '';
        try {
            var entries = await bridge.fs.list(questsDir);
            for (var ei = 0; ei < entries.length; ei++) {
                if (entries[ei].name.startsWith(questId + '.') && entries[ei].isDir) {
                    questDir = questsDir + entries[ei].name + '/';
                    break;
                }
            }
        } catch (_) { }
        if (!questDir) return;
        var searchPath = questDir + 'search_quest.txt';

        // 收集所有楼层数据
        var lines = [];
        for (var fi = 0; fi < allFloors.length; fi++) {
            var fData = allFloors[fi].data;
            var fn = allFloors[fi].floorNum || (fi + 1);
            // ★ 提取 AI 最终回答（从 conversation，非 houses[].answer 冗余副本）
            var conv = fData.conversation || [];
            var answer = '';
            for (var ci = conv.length - 1; ci >= 0; ci--) {
                if (conv[ci].role === 'assistant' && !conv[ci].tool_calls && typeof conv[ci].content === 'string' && conv[ci].content && !conv[ci]._error) {
                    answer = conv[ci].content;
                    break;
                }
            }
            var now = new Date();
            var floorTs = now;
            if (questMeta.floorTimings) {
                for (var ti = 0; ti < questMeta.floorTimings.length; ti++) {
                    var ft = questMeta.floorTimings[ti];
                    if (ft.floorIndex === fn && ft.finishedAt) {
                        floorTs = new Date(new Date(ft.finishedAt).getTime() - (ft.durationMs || 0));
                        break;
                    }
                }
            }
            var marker = '\u2550\u2550\u2550\u2550\u2550 Floor ' + fn + ' \u2550\u2550\u2550\u2550\u2550';
            if (fi > 0) lines.push('');
            lines.push(marker + '   ' + _fmtTime(floorTs));
            // ★ V14 fix: [File:] 剥离改用 \n\n[File: 截断
            var _qContent2 = fData.question || '';
            var _fileIdx2 = _qContent2.search(/\n\n\[File: /);
            var cleanQ = (_fileIdx2 >= 0 ? _qContent2.slice(0, _fileIdx2) : _qContent2).replace(/\x0A{3,}/g, '\x0A\x0A').trim();
            lines.push('\u25a0 Q: ' + cleanQ);
            lines.push('\u25a0 A: ' + (answer || '(no answer)'));
            var _azLines = _buildAzText(fn, fData, questMeta);
            for (var _azi = 0; _azi < _azLines.length; _azi++) {
                lines.push(_azLines[_azi]);
            }
            lines.push('');
        }

        var newContent = lines.join('\n');
        await bridge.fs.write(searchPath, newContent);
        console.log('[search_quest] rebuilt for q=' + questId + ' (' + allFloors.length + ' floors, ' + newContent.length + ' chars)');
    } catch (e) {
        console.warn('[search_quest] rebuild failed:', e && e.message);
    }
}

var _switching = false;  // 互斥锁：防止快速双击 tab 导致并发切任务
// ═══ 从 questStore 恢复 agent 全量状态（conversation + metadata） ═══
async function _restoreAgentFromStore(questId, ag) {
    if (!questId || !ag) return;
    // ★ 跨面板隔离：agent 正在建楼/恢复中 → 不覆写内存状态
    //    agent 持有最新 conversation / _houses / cost / timing，比磁盘数据更权威。
    //    switchQuest 切回时只 rebind _activeAiDiv，不重建 agent 内部状态。
    if (ag._stopState === 'sending' || ag._recoveryInProgress) return;
    // ★ 恢复路径 per-floor 标志清零（2026-08-08 F10）：V21 ④ 只清发送路径，
    //   恢复路径残留 _compressFloor → 后续楼层被误标 compress → 完结截断 conversation
    //   （q169 f10/f12/f14 conv=0 事故链之一）。_floorSealed 恢复为空（新会话可写）。
    ag._compressFloor = false;
    ag._isRecovery = false;
    ag._floorCompletedCleanly = false;
    ag._floorSealed = {};
    try {
        var data = await questStore.load(questId);
        var allFloors = await questStore.loadAllFloors(questId);

        // 重建 conversation：聚合所有楼层
        ag.conversation = [];
        ag._questErrorLogByFloor = {};
        ag._questErrorDivByFloor = {};
        ag._questErrorState = {};

        // ★ ctx.json 优先 → 失败走 D 路径纯重建兜底
        var _ctxJson = (typeof _readCtxJson === 'function') ? (await _readCtxJson(questId)) : null;
        var _ctxData = _ctxJson || {};

        // ★ 压缩恢复：先读 lastCompressedFloor（需在 conversation 之前）
        var _restoredLastCompressedFloor = _ctxData.lastCompressedFloor || 0;
        var _restoredNarrative = _ctxData.narrative || '';
        // ★ BugFix #1: ctx.biscuitLines 必须在 V12 注入之前恢复
        if (_ctxData.biscuitLines) ag._ctx.biscuitLines = _ctxData.biscuitLines;
        // V13: DE 概念消除，不再恢复 deEntries
        // V10/V11: ctx.narrative 存完整饼干文本
        // V12:     ctx.narrative 是摘要(biscuit:X)，饼干在 conversation 的 _biscuit 消息
        var _isV10Biscuit = _restoredLastCompressedFloor > 0 && _restoredNarrative.indexOf('═══ COMPRESSED FLOORS') === 0;
        var _isV12Biscuit = _restoredLastCompressedFloor > 0 && _restoredNarrative.indexOf('biscuit:') === 0;
        var _hasBiscuit = _isV10Biscuit || _isV12Biscuit;

        for (var fi = 0; fi < allFloors.length; fi++) {
            var fData = allFloors[fi].data;
            var fConv = fData.conversation;
            if (fConv && fConv.length) {
                for (var mi = 0; mi < fConv.length; mi++) {
                    var _msg = fConv[mi];
                    // ★ 饼干恢复：跳过已压缩楼层的原始消息（饼干已存 ctx.narrative）
                    if (_hasBiscuit && _msg._floor > 0 && _msg._floor <= _restoredLastCompressedFloor) {
                        continue;
                    }
                    // ★ 跳过 floor conversation 中残留的 _compressed 消息（每层快照含全量 conversation，
                    //    压缩后所有后续楼层快照都含饼干副本 → 恢复时去重，只靠 ctx.narrative 注入一次）
                    if (_msg._compressed) continue;
                    // ★ BugFix #3 v2: 保留首条 _persistent 消息（去重），其余跳过。
                    //    留一份 Z 防快照/重建时丢失。后续 send 时 _refreshRules 原地更新。
                    if (_msg._persistent) {
                        if (!ag._persistentCount) { ag.conversation.push(_msg); ag._persistentCount = 1; }
                        continue;
                    }
                    ag.conversation.push(_msg);
                }
            }
        }

        // ★ V17 fix: 根据 conversation 实际状态设 _persistentCount，不盲目清零。
        //   V16 的硬清零 → _persistentCount=0 但 Z 在 [0] → 再次 restore 时
        //   !_persistentCount 为 true → 可能推入第二个 Z → goods 背包重复"Client rules"
        ag._persistentCount = (ag.conversation.length > 0 && ag.conversation[0]._persistent) ? 1 : 0;
        ag._rulesVersion = '';  // ★ 同样清零，强制下次 send 重新注入 rules

        // ★ 2026-08-11: 拼接净化——历史楼层残留孤儿 tool（配对 assistant 在各自 slice 外）
        //   → 恢复基线带孤儿 → 发送 400（q1 f17 客户事故 + q181 f14/f17 样本实锤）
        //   复用发送前预检同一函数（agent-exec.js），_floor 等标记不动，仅删无配对 tool
        if (typeof ag._repairOrphanedToolCalls === 'function') {
            try { ag._repairOrphanedToolCalls(); } catch (_) { }
        }

        // ★ 注入压缩饼干：V10 从 ctx.narrative 注入；V13 从 ctx.biscuitLines 重建消息
        if (_isV10Biscuit) {
            // ★ 2026-08-11: 补 _biscuit 标记——旧格式 narrative 即压缩饼干内容，与 V12 重建消息同标记
            //   （否则 aq 图解落 sysCount、goods 显示 System #N (动态)，两 UI 大脑分裂）
            // ★ 2026-08-11 v2: unshift → splice(persistentCount)——unshift 把饼干插到 Z 之前，
            //   fx 重建再 splice(persistentCount) → 终态 [biscuit, fx, Z] 违反定序 Z → fx → biscuit；
            //   与 V12 路径同构（铁律 10.1）
            ag.conversation.splice(ag._persistentCount || 0, 0, { role: 'system', content: _restoredNarrative, _compressed: true, _dynamic: true, _biscuit: true });
        }
        // ★ V18 fix: biscuit 消息始终从 ctx.biscuitLines 重建（ctx.json 为权威真理源）。
        //   旧逻辑仅在无 conversation biscuit 时注入 → 压缩按钮修改 ctx.biscuitLines 后
        //   重启时 all.json 里的旧 biscuit（未压缩）先被恢复 → _hasBiscuitMsg=true
        //   → ctx.biscuitLines（已压缩）被忽略 → 压缩丢失。
        //   现在：ctx.biscuitLines 存在时，先删光 conversation 中所有 biscuit，再用 ctx 重建。
        if (_isV12Biscuit) {
            if (ag._ctx.biscuitLines && ag._ctx.biscuitLines.length > 0) {
                // 删除所有旧 biscuit 消息（可能来自 all.json 的过期快照）
                for (var _scmi = ag.conversation.length - 1; _scmi >= 0; _scmi--) {
                    if (ag.conversation[_scmi]._biscuit) ag.conversation.splice(_scmi, 1);
                }
                var _rebuildBiscuit = ag._ctx.biscuitLines.map(function (l) { return l.text; }).join('\n\n');
                ag.conversation.splice(ag._persistentCount || 0, 0,
                    { role: 'system', content: _rebuildBiscuit, _dynamic: true, _biscuit: true });
            }
            // ★ V16 fix: 去重 biscuit/facts — 先合并孤儿内容再删除
            var _firstBIdx = -1;
            for (var _ddi = (ag._persistentCount || 0); _ddi < ag.conversation.length; _ddi++) {
                if (ag.conversation[_ddi]._biscuit) { _firstBIdx = _ddi; break; }
            }
            var _seenF2 = false;
            for (var _ddi = ag.conversation.length - 1; _ddi >= (ag._persistentCount || 0); _ddi--) {
                if (ag.conversation[_ddi]._biscuit && _ddi !== _firstBIdx) {
                    var _orphanLines = _parseBiscuitFromContent(ag.conversation[_ddi].content);
                    var _mainLines = _parseBiscuitFromContent(ag.conversation[_firstBIdx].content);
                    var _mainMap = {};
                    for (var _mli = 0; _mli < _mainLines.length; _mli++) { _mainMap[_mainLines[_mli].n] = true; }
                    var _merged = false;
                    for (var _oli = 0; _oli < _orphanLines.length; _oli++) {
                        if (!_mainMap[_orphanLines[_oli].n]) {
                            _mainLines.push(_orphanLines[_oli]);
                            _merged = true;
                        }
                    }
                    if (_merged) {
                        _mainLines.sort(function(a,b) { return a.n - b.n; });
                        ag.conversation[_firstBIdx].content = _mainLines.map(function(l) { return l.text; }).join('\n\n');
                    }
                    ag.conversation.splice(_ddi, 1);
                }
                if (ag.conversation[_ddi]._facts) {
                    if (_seenF2) { ag.conversation.splice(_ddi, 1); }
                    else { _seenF2 = true; }
                }
            }
            // ★ V17 fix: 去重 _persistent 消息 — 永远只保留第一条
            var _firstPIdx = -1;
            for (var _dpi2 = 0; _dpi2 < ag.conversation.length; _dpi2++) {
                if (ag.conversation[_dpi2]._persistent) { _firstPIdx = _dpi2; break; }
            }
            for (var _dpi2 = ag.conversation.length - 1; _dpi2 >= 0; _dpi2--) {
                if (ag.conversation[_dpi2]._persistent && _dpi2 !== _firstPIdx) {
                    ag.conversation.splice(_dpi2, 1);
                }
            }
        }

        // ★ 2026-08-10: 重启后从 ctx.facts 重建 fx 消息（Z 后、biscuit 前，与 _rebuildBackpack 定序一致）
        //   修复：fx 为 _dynamic 消息，all.json 快照不含 → 重启后事实上下文从对话消失（仅剩 UI 格）
        if (_ctxData.facts && _ctxData.facts.length) {
            for (var _rfi = ag.conversation.length - 1; _rfi >= 0; _rfi--) {
                if (ag.conversation[_rfi]._facts) ag.conversation.splice(_rfi, 1);
            }
            ag.conversation.splice(ag._persistentCount || 0, 0,
                { role: 'system', content: _ctxData.facts.join('\n\n'), _dynamic: true, _facts: true });
        }
        // ★ 扫描所有 _error 消息重建分楼层错误日志（跳过已恢复的）
        for (var _eli = 0; _eli < ag.conversation.length; _eli++) {
            var _em = ag.conversation[_eli];
            if (_em._error && _em.role === 'assistant' && _em.content && !_em._recovered) {
                var _efn = _em._floor || 0;
                if (!ag._questErrorLogByFloor[_efn]) ag._questErrorLogByFloor[_efn] = [];
                ag._questErrorLogByFloor[_efn].push({ time: _em._errorTime || '', reason: _em.content });  // ★ V9 fix: 恢复持久化的时间戳
            }
        }
        // ★ V2 fix: 扫描 biscuit 消息中的 [ERR] 标记（压缩时保留的错误信息）
        for (var _bli = 0; _bli < ag.conversation.length; _bli++) {
            var _bmsg = ag.conversation[_bli];
            if (_bmsg._biscuit && _bmsg.content) {
                var _blines = _bmsg.content.split('\n');
                var _curBiscuitFloor = 0;
                for (var _blj = 0; _blj < _blines.length; _blj++) {
                    var _bl = _blines[_blj];
                    var _fm = _bl.match(/^=== F(\d+) ===/);
                    if (_fm) { _curBiscuitFloor = parseInt(_fm[1], 10); continue; }
                    // ★ V8 fix: 解析 biscuit [ERR] 行，提取时间戳和原因
                    if (_bl.indexOf('[ERR]') === 0 && _curBiscuitFloor > 0) {
                        if (!ag._questErrorLogByFloor[_curBiscuitFloor]) ag._questErrorLogByFloor[_curBiscuitFloor] = [];
                        var _errRest = _bl.slice(5).trim();  // 去掉 '[ERR]'
                        var _errTime = '';
                        var _tmMatch = _errRest.match(/^\[(\d{2}:\d{2})\]\s*/);
                        if (_tmMatch) {
                            _errTime = _tmMatch[1];
                            _errRest = _errRest.slice(_tmMatch[0].length);
                        }
                        ag._questErrorLogByFloor[_curBiscuitFloor].push({
                            time: _errTime,
                            reason: _errRest
                        });
                    }
                }
            }
        }

        // ★ 恢复 _billingSeq：扫描所有楼层 houses，取最大 billingSeq（重启后累加不中断）
        ag._billingSeq = 0;
        for (var _bsfi = 0; _bsfi < allFloors.length; _bsfi++) {
            var _bsfHouses = allFloors[_bsfi].data && allFloors[_bsfi].data.houses;
            if (_bsfHouses && _bsfHouses.length) {
                for (var _bshi = 0; _bshi < _bsfHouses.length; _bshi++) {
                    var _bs = _bsfHouses[_bshi].billingSeq;
                    if (_bs > ag._billingSeq) ag._billingSeq = _bs;
                }
            }
        }
        for (var _bsfi = 0; _bsfi < allFloors.length; _bsfi++) {
            var _bsfHouses = allFloors[_bsfi].data && allFloors[_bsfi].data.houses;
            if (_bsfHouses && _bsfHouses.length) {
                for (var _bshi = 0; _bshi < _bsfHouses.length; _bshi++) {
                    var _bs = _bsfHouses[_bshi].billingSeq;
                    if (_bs > ag._billingSeq) ag._billingSeq = _bs;
                }
            }
        }


        // ★ 恢复 _passbyBase：唯一真理源 = all.json 实际数据（从不信任 quest 元数据或上楼层快照）
        //   旧 passbyBase 持久化字段已废弃——quest 元数据 passbyBaseWge 公式是恒等变换（no-op），
        //   上楼层 passbyWge 也可能因历史 bug 而错误。必须从每一层的 costWge 重算。
        //   步骤：① 扫描找最大楼层号 → ② 兜底修复 _currentFloorNum → ③ 重算基线
        var _maxFloorFromData = 0;
        for (var _rfi = 0; _rfi < allFloors.length; _rfi++) {
            var _rffn = allFloors[_rfi].floorNum;
            if (_rffn > _maxFloorFromData) _maxFloorFromData = _rffn;
        }
        // ★ 兜底：若 quest 元数据无 currentFloorNum（从未保存），从 all.json 回退
        if (!ag._currentFloorNum && _maxFloorFromData > 0) {
            ag._currentFloorNum = _maxFloorFromData;
        }
        // ★ 现在 _currentFloorNum 已就绪，从已完成楼层重算基线
        var _recalcHouses = 0, _recalcWge = 0;
        for (var _rfi2 = 0; _rfi2 < allFloors.length; _rfi2++) {
            var _rfData = allFloors[_rfi2].data;
            if (_rfData && allFloors[_rfi2].floorNum < ag._currentFloorNum) {
                _recalcHouses += (_rfData.houses ? _rfData.houses.length : 0);
                _recalcWge += (_rfData.costWge || 0);
            }
        }
        ag._passbyBaseHouses = _recalcHouses;
        ag._passbyBaseWge = _recalcWge;
        ag._passbyBaseTokens = 0; // tokens 无可靠磁盘源，每次重算时归零
        ag._passbyBaseFloorNum = _recalcHouses > 0 ? (ag._currentFloorNum - 1) : 0;
        // ★ 重建 _floorMeta（未可变楼层元数据）
        // ★ 压缩恢复：用 conversation 实际索引覆盖磁盘旧值（旧 floorStartIdx 在跳过压缩层后偏移）
        var _actualFloorStarts = {};
        for (var _sci = 0; _sci < ag.conversation.length; _sci++) {
            var _scf = ag.conversation[_sci]._floor || 0;
            if (_scf > 0 && !(_scf in _actualFloorStarts)) _actualFloorStarts[_scf] = _sci;
        }
        ag._floorMeta = {};
        for (var _fmfi = 0; _fmfi < allFloors.length; _fmfi++) {
            var _fmfData = allFloors[_fmfi].data;
            if (_fmfData) {
                var _fmfn = allFloors[_fmfi].floorNum;
                ag._floorMeta[_fmfn] = {
                    floorStartIdx: (_fmfn in _actualFloorStarts) ? _actualFloorStarts[_fmfn] : (_fmfData._floorStartIdx || 0),
                    allTxtPath: _fmfData.allTxtPath || '',
                    _fDir: _fmfData._fDir || '',
                    createdAt: _fmfData.createdAt || Date.now()
                };
            }
        }

        // ★ a4Snapshots 不恢复：每楼层的 a4 块由 card-pool._buildFloorDOM 通过
        //   _a4RestoreBlock 从 all.json 独立渲染，恢复到 ag 会导致串台——下一楼层
        //   在 sendMessage 清除 ag._a4Snapshots 之前的 auto-save 竞态窗口内会将
        //   上楼层 a4 数据误写入本楼层 all.json。

        // 恢复 metadata
        if (data) {
            ag.totalCostGe = data.totalCostGe || 0;
            ag._lastApiPromptTokens = data.lastApiPromptTokens || 0;
            ag._lastApiTotalTokens = data.lastApiTotalTokens || 0;
            ag._lastApiCompletionTokens = data.lastApiCompletionTokens || 0;
            ag._accumulatedCompletionTokens = data.accumulatedCompletionTokens || 0;
            ag._lastTier = data.lastTier || null;
            ag._uncleanShutdown = data.uncleanShutdown || false;
            ag._ctx.lastCompressedFloor = _ctxData.lastCompressedFloor || 0;
            ag._ctx.floorArchives = _ctxData.floorArchives || [];
            ag._ctx.totalFloors = _ctxData.totalFloors || 0;
            if (_ctxData.narrative) ag._ctx.narrative = _ctxData.narrative;
            if (_ctxData.facts) ag._ctx.facts = _ctxData.facts;
            if (_ctxData.treasures) ag._ctx.treasures = _ctxData.treasures;
            // ★ biscuitLines 已提前恢复（BugFix #1：必须在 V12 注入之前）
            ag._floorTimings = data.floorTimings || [];
            ag._serverDrift = data.serverDrift || 0;
            ag._queue = data.queue || [];
            ag._rulesVersion = data.rulesVersion || '';
            // ★ BugFix #3 v2: _persistentCount 已在恢复循环中处理，不强制清零
            // ★ 恢复楼层计数器（旧 quest 无此字段时回退到已保存楼层数）
            ag._currentFloorNum = data.currentFloorNum || 0;
        }
        // ★ 恢复 _houses / _floorCostWge / _lastFloorTimingRecord（防重启后 az 区丢失）
        if (ag._currentFloorNum > 0 && allFloors && allFloors.length) {
            for (var _rhfi = allFloors.length - 1; _rhfi >= 0; _rhfi--) {
                if (allFloors[_rhfi].floorNum === ag._currentFloorNum) {
                    var _rhData = allFloors[_rhfi].data;
                    if (_rhData) {
                        if (_rhData.houses && _rhData.houses.length) {
                            ag._houses = _rhData.houses.slice();
                            ag._houseIndex = ag._houses.length;
                        }
                        if (_rhData.costWge) ag._floorCostWge = _rhData.costWge;
                        if (_rhData.clockTiming) ag._lastFloorTimingRecord = _rhData.clockTiming;
                        // ★ 恢复 _lastUserInput（防 switchQuest 重写 all.json 时 question_clean 变空）
                        if (_rhData.lastUserInput) ag._lastUserInput = _rhData.lastUserInput;
                        // ★ 恢复 aq1 指示器字段（跨面板迁移不丢 AI 启动时间）
                        if (_rhData.aiStartTime) ag._aiStartTime = _rhData.aiStartTime;
                        if (_rhData.tierLabel) ag._aiTierLabel = _rhData.tierLabel;
                        if (_rhData.aiBackpackEst) ag._aiBackpackEst = _rhData.aiBackpackEst;
                        // ★ 恢复 _lastAutoSaveLen 防止空 houses 安全网误杀新楼层首存
                        ag._lastAutoSaveLen = (ag.conversation ? ag.conversation.length : 0);
                    }
                    break;
                }
            }
        }
        // ★ B3: 检测「无 house 1」僵尸楼层（agent.send() 未产出 house 1）
        //   统一处理：无 house 1 → 合成 error log → 红字框 + 继续任务（同楼层 0-house 重试）
        if (ag._currentFloorNum > 0 && (!ag._houses || ag._houses.length === 0)) {
            var _hasUserMsg3 = false;
            var _lastUserContent3 = '';
            for (var _mcj = ag.conversation.length - 1; _mcj >= 0; _mcj--) {
                var _mc3 = ag.conversation[_mcj];
                if (_mc3._floor === ag._currentFloorNum) {
                    if (_mc3.role === 'user') {
                        _hasUserMsg3 = true;
                        _lastUserContent3 = _mc3.content || '';
                        break;
                    }
                }
                if (_mc3._floor < ag._currentFloorNum) break;
            }
            if (_hasUserMsg3) {
                // ★ 恢复 _lastUserMsg（0-house 恢复需要原消息）
                if (_lastUserContent3) ag._lastUserMsg = _lastUserContent3;
                // ★ 若无已有 error log → 合成一条（让红框有内容可渲染）
                if (!ag._questErrorLogByFloor[ag._currentFloorNum] || ag._questErrorLogByFloor[ag._currentFloorNum].length === 0) {
                    if (!ag._questErrorLogByFloor[ag._currentFloorNum]) ag._questErrorLogByFloor[ag._currentFloorNum] = [];
                    ag._questErrorLogByFloor[ag._currentFloorNum].push({
                        time: '',
                        reason: '未收到 AI 回复'
                    });
                }
                // ★ 设置 fatal 态（使 panel-quest-ui 重建循环能渲染红框）
                ag._floorFatal = true;
                ag.setStopState('fatal');
                ag._exitReason = ag._exitReason || '未收到 AI 回复';
            }
        }
        // ★ fatal 态持久化恢复：最后一层楼 floorFatal → 死胡同模式
        if (allFloors && allFloors.length > 0) {
            var _lastFloor = allFloors[allFloors.length - 1];
            var _lfData = _lastFloor.data;
            if (_lfData && _lfData.floorFatal) {
                ag.setStopState('fatal');
                ag._floorFatal = true;
                ag._exitReason = _lfData.exitReason || '';
                // ★ 确保 currentFloorNum 指向 fatal 楼层（metadata 可能为 0）
                if (!ag._currentFloorNum || ag._currentFloorNum < _lastFloor.floorNum) {
                    ag._currentFloorNum = _lastFloor.floorNum;
                }
                // ★ 2026-08-11: exitReason 空（abort 等路径未写）且楼层无 error log → 合成一条。
                //   否则 _questErrorLogByFloor 空 → _renderAllErrorBoxes 空 log continue → 红框
                //   +「继续任务」链接不渲染 → 用户无恢复入口，Enter 又被 fatal 闸门静默吞
                //   （q184 实锤：f3 fatal exitReason='' 零 _error 消息 → 重启后发任何消息无反应）。
                //   与 B3 段（无 house 1 合成）同款兜底，先于此处的 V14 同步段执行
                if (!ag._questErrorLogByFloor[_lastFloor.floorNum] || ag._questErrorLogByFloor[_lastFloor.floorNum].length === 0) {
                    if (!ag._questErrorLogByFloor[_lastFloor.floorNum]) ag._questErrorLogByFloor[_lastFloor.floorNum] = [];
                    ag._questErrorLogByFloor[_lastFloor.floorNum].push({
                        time: '',
                        reason: _lfData.exitReason || '任务中断（楼层异常结束）'
                    });
                }
            }
        }
        // ★ 闭环恢复: 遍历所有楼层，对 floorFatal 的楼层从 exitReason 合成 error log
        //   补上「运行时 onError 未写 _error 消息到 conversation」导致的磁盘断层
        if (allFloors && allFloors.length > 0) {
            for (var _erfi = 0; _erfi < allFloors.length; _erfi++) {
                var _erFloorNum = allFloors[_erfi].floorNum;
                var _erData = allFloors[_erfi].data;
                if (_erData && _erData.floorFatal && _erData.exitReason) {
                    if (!ag._questErrorLogByFloor[_erFloorNum]) ag._questErrorLogByFloor[_erFloorNum] = [];
                    if (ag._questErrorLogByFloor[_erFloorNum].length === 0) {
                        ag._questErrorLogByFloor[_erFloorNum].push({
                            time: '',
                            reason: _erData.exitReason
                        });
                    }
                }
            }
        }
        // ★ 崩溃恢复：上次关闭时正在压缩 → 修复可能的半成品状态
        if (ag._uncleanShutdown) {
            ag._uncleanShutdown = false;
            console.warn("[restore] unclean shutdown detected — state cleaned");
        }
        // ★ 刷新服务器城市（Cloudflare 透传，用于 passby 地理位置展示）
        _refreshServerCity(ag);

        // ★ V14: 同步旧 _questErrorLogByFloor → 新 _questErrorState（数据驱动渲染）
        if (ag._questErrorLogByFloor) {
            for (var _sfn in ag._questErrorLogByFloor) {
                var _slog = ag._questErrorLogByFloor[_sfn];
                if (_slog && _slog.length > 0) {
                    if (!ag._questErrorState[_sfn]) ag._questErrorState[_sfn] = { log: [], capped: false, bubbleText: null };
                    if (ag._questErrorState[_sfn].log.length === 0) {
                        ag._questErrorState[_sfn].log = _slog.slice();
                    }
                }
            }
        }

        // [silent] restored agent state
    } catch (e) {
        console.warn('[quests] _restoreAgentFromStore error:', e && e.message);
    }
}

// ★ 刷新服务器城市（Cloudflare X-Original-City 透传）
// 直连 gh555.com（不走 direct，防超时）；5s 超时 + 静默失败
async function _refreshServerCity(ag) {
    try {
        var _ctrl = new AbortController();
        var _tid = setTimeout(function () { _ctrl.abort(); }, 5000);
        var resp = await fetch('https://gh555.com/api/geo', { signal: _ctrl.signal });
        clearTimeout(_tid);
        if (resp && resp.ok) {
            var data = await resp.json();
            if (data && data.city) {
                ag._serverCity = data.city;
            }
        }
    } catch (_) { /* 静默 */ }
}

// ★ 计算当前楼层 tokens（prompt + completion）
function _computeFloorTokens(ag) {
    if (!ag || !ag._houses || !ag._houses.length) return 0;
    var _sum = 0;
    for (var i = 0; i < ag._houses.length; i++) {
        var _u = ag._houses[i].usage;
        if (_u) _sum += (_u.prompt_tokens || 0) + (_u.completion_tokens || 0);
    }
    return _sum;
}
