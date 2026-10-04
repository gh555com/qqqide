// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
// panel-quest-persist.js — 楼层/上下文持久化（_computeFileStats + ctx.json + _saveAgentQuestData/saveQuestData）
// （2026-10-03 从 panel-quest.js 原样搬移，行为零改动）
'use strict';

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
                compressLevel: ctx.compressLevel || '', // per-quest 独立压缩策略覆盖（2026-08-23）
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

        // ★ 健全性检测（2026-09-07 q242 f148 实锤辅助）：AI 长回复存盘近零换行 = 上游文本在
        //   存储层已坏（markdown 表格/标题结构永久丢失，渲染端守卫只能保显示不放大）。
        //   每楼层只记一次 → agent-*.log，复现即实锤上游；渲染端标题/列表/引用守卫已兜底。
        try {
            var _convChk = floorPayload.conversation || [];
            for (var _ci = _convChk.length - 1; _ci >= 0; _ci--) {
                var _mChk = _convChk[_ci];
                if (_mChk && _mChk.role === 'assistant' && typeof _mChk.content === 'string' && _mChk.content.length >= 800) {
                    var _nlChk = (_mChk.content.match(/\n/g) || []).length;
                    if (_nlChk < 4 && ag._noNlLoggedFloor !== floorNum) {
                        ag._noNlLoggedFloor = floorNum;
                        if (typeof ag._writeFileLog === 'function') {
                            ag._writeFileLog('⚠ NO-NL AI CONTENT floor=' + floorNum + ' len=' + _mChk.content.length + ' nl=' + _nlChk + ' (上游丢换行嫌疑：标题/表格将退化为字面文本)');
                        }
                    }
                    break;
                }
            }
        } catch (_nlChkErr) { }

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
