// ============================================================================
// panel-a4.js — A4 文件快照块（每层楼私有，A2 与 A1 之间）
//
// 职责：
//   ① 拦截 executeTool，文件修改前捕获 before 快照，修改后捕获 after 快照
//   ② 实时渲染 A4 瀑布列表（文件名 + +N -M 行变更）
//   ③ 点击文件 → postMessage 到父窗口 → 在 X 区打开 diff 查看器
//   ④ 快照内容持久化到 qqq/snapshots/，元数据持久化到 floor payload
//
// 铁律：
//   - per-floor 状态归属 agent 对象（§36）：agent._a4Snapshots
//   - A4 DOM 归属 aiDiv（§29）：aiDiv._a4Block
//   - 快照内容上限 512KB/文件，超限只记录元数据不存内容
// ============================================================================

var A4_MAX_SNAPSHOT_BYTES = 512 * 1024; // 512KB per file content cap

// ---- 简易 path hash（取路径的简单 hash 作为文件名） ----
function _a4PathHash(p) {
    var h = 0;
    for (var i = 0; i < p.length; i++) {
        h = ((h << 5) - h + p.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// ---- 计算 +added -deleted（行级 diff 统计） ----
function _a4DiffStats(before, after) {
    if (before === null && after === null) return { added: 0, deleted: 0 };
    if (before === null) {
        // create_file
        var lines = (after || '').split('\n').length;
        return { added: lines, deleted: 0 };
    }
    if (after === null) {
        // delete_file
        var lines2 = (before || '').split('\n').length;
        return { added: 0, deleted: lines2 };
    }
    // edit/write: line-by-line count
    var bLines = before.split('\n');
    var aLines = after.split('\n');
    // Simple approximation: count changed lines via LCS length
    var lcsLen = _a4LcsLength(bLines, aLines);
    return { added: aLines.length - lcsLen, deleted: bLines.length - lcsLen };
}

// ---- O(min(m,n)) space LCS length for diff stats ----
function _a4LcsLength(a, b) {
    if (a.length > b.length) { var t = a; a = b; b = t; }
    var m = a.length, n = b.length;
    // Cap: avoid O(mn) blowup for huge files
    if (m * n > 4000000) {
        // Approximation for large files: count matching lines
        var bSet = {};
        for (var i = 0; i < b.length; i++) {
            var k = b[i];
            bSet[k] = (bSet[k] || 0) + 1;
        }
        var matched = 0;
        for (var j = 0; j < a.length; j++) {
            if (bSet[a[j]] && bSet[a[j]] > 0) { matched++; bSet[a[j]]--; }
        }
        return matched;
    }
    var prev = new Array(m + 1).fill(0);
    var curr = new Array(m + 1).fill(0);
    for (var bi = 1; bi <= n; bi++) {
        for (var ai = 1; ai <= m; ai++) {
            if (a[ai - 1] === b[bi - 1]) {
                curr[ai] = prev[ai - 1] + 1;
            } else {
                curr[ai] = Math.max(curr[ai - 1], prev[ai]);
            }
        }
        var tmp = prev; prev = curr; curr = tmp;
        curr.fill(0);
    }
    return prev[m];
}

// ---- 获取快照存储目录 ----
function _a4SnapshotDir(questNumericId, floorNum) {
    if (!_workspaceRoot) return null;
    var root = _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
    return root + '/qqq/snapshots/q' + questNumericId + '/f' + floorNum + '/';
}

// ═══ executeTool 拦截器：文件修改前后自动捕获快照 ═══
var _a4OriginalExecuteTool = (typeof executeTool === 'function') ? executeTool : null;

var _WRITE_TOOLS = ['edit_file', 'create_file', 'write_file', 'delete_file'];

async function _a4WrappedExecuteTool(name, args) {
    // Non-write tools: pass through directly
    if (_WRITE_TOOLS.indexOf(name) === -1) {
        return _a4OriginalExecuteTool(name, args);
    }

    var filePath = args.path || '';
    var bridge = getBridge();
    var beforeContent = null;

    // ---- Capture BEFORE ----
    if (name !== 'create_file' && bridge) {
        try {
            if (bridge.ai && bridge.ai.read_file) {
                var raw = await bridge.ai.read_file({ path: filePath });
                if (typeof raw === 'string' && raw.indexOf('Error') !== 0 && raw.length <= A4_MAX_SNAPSHOT_BYTES) {
                    beforeContent = raw;
                }
            } else if (bridge.fs && bridge.fs.read) {
                var raw2 = await bridge.fs.read(filePath);
                if (typeof raw2 === 'string' && raw2.length <= A4_MAX_SNAPSHOT_BYTES) {
                    beforeContent = raw2;
                }
            }
        } catch (_) { /* file might not exist for write_file creating new */ }
    }

    // ---- Execute original tool ----
    var result = await _a4OriginalExecuteTool(name, args);

    // ---- Check if tool succeeded ----
    if (!result || (typeof result === 'string' && result.indexOf('Error') === 0)) {
        return result;
    }

    // ---- Capture AFTER ----
    var afterContent = null;
    if (name === 'delete_file') {
        afterContent = null; // file is gone
    } else if (name === 'create_file' || name === 'write_file') {
        // args.content IS the final content
        if (args.content && args.content.length <= A4_MAX_SNAPSHOT_BYTES) {
            afterContent = args.content;
        }
    } else {
        // edit_file: read file after edit
        try {
            if (bridge && bridge.ai && bridge.ai.read_file) {
                var raw3 = await bridge.ai.read_file({ path: filePath });
                if (typeof raw3 === 'string' && raw3.indexOf('Error') !== 0 && raw3.length <= A4_MAX_SNAPSHOT_BYTES) {
                    afterContent = raw3;
                }
            } else if (bridge && bridge.fs && bridge.fs.read) {
                var raw4 = await bridge.fs.read(filePath);
                if (typeof raw4 === 'string' && raw4.length <= A4_MAX_SNAPSHOT_BYTES) {
                    afterContent = raw4;
                }
            }
        } catch (_) { }
    }

    // ---- Record snapshot ----
    _a4RecordSnapshot(filePath, name, beforeContent, afterContent);

    return result;
}

// Install wrapper
if (_a4OriginalExecuteTool) {
    executeTool = _a4WrappedExecuteTool;
}

// ═══ 快照记录：写入当前 agent 的 _a4Snapshots ═══
function _a4RecordSnapshot(filePath, op, before, after) {
    // Get current active agent
    var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    if (!ag) return;

    if (!ag._a4Snapshots) ag._a4Snapshots = {};

    var stats = _a4DiffStats(before, after);
    var existing = ag._a4Snapshots[filePath];

    if (existing) {
        // Accumulate: keep earliest before, latest after
        existing.after = after;
        existing.afterOp = op;
        existing.added += stats.added;
        existing.deleted += stats.deleted;
        existing.ts = Date.now();
        existing.count = (existing.count || 1) + 1;
        // Recompute accurate stats from original before vs latest after
        var accStats = _a4DiffStats(existing.before, after);
        existing.added = accStats.added;
        existing.deleted = accStats.deleted;
    } else {
        ag._a4Snapshots[filePath] = {
            path: filePath,
            op: op,
            before: before,
            after: after,
            added: stats.added,
            deleted: stats.deleted,
            ts: Date.now(),
            count: 1
        };
    }

    // Live update A4 UI
    _a4RenderLive(ag);
}

// ═══ A4 DOM 创建 + 渲染 ═══

function _initA4Block(aiDiv) {
    if (aiDiv._a4Block) return aiDiv._a4Block;
    var block = document.createElement('div');
    block.className = 'msg-a4';
    // Position: after A2 (treasure), before A1 (stats)
    var a1 = aiDiv._a1Block;
    if (a1) {
        aiDiv.insertBefore(block, a1);
    } else {
        var clock = aiDiv._clockBlock;
        if (clock) {
            aiDiv.insertBefore(block, clock);
        } else {
            aiDiv.appendChild(block);
        }
    }
    aiDiv._a4Block = block;
    return block;
}

// ---- 渲染实时文件列表 ----
function _a4RenderLive(ag) {
    if (!ag || !ag._activeAiDiv) return;
    var aiDiv = ag._activeAiDiv;
    var snaps = ag._a4Snapshots;
    if (!snaps || Object.keys(snaps).length === 0) return;

    var block = _initA4Block(aiDiv);
    block.innerHTML = '';

    var paths = Object.keys(snaps).sort(function (a, b) {
        return (snaps[a].ts || 0) - (snaps[b].ts || 0);
    });

    for (var i = 0; i < paths.length; i++) {
        var snap = snaps[paths[i]];
        var row = document.createElement('div');
        row.className = 'msg-a4-row';
        row.dataset.path = snap.path;

        // Filename
        var fname = snap.path.replace(/\\/g, '/').split('/').pop() || snap.path;
        var nameSpan = document.createElement('span');
        nameSpan.className = 'msg-a4-fname';
        nameSpan.textContent = fname;
        nameSpan.title = snap.path;

        // Stats
        var statsSpan = document.createElement('span');
        statsSpan.className = 'msg-a4-stats';
        var statParts = [];
        if (snap.added > 0) statParts.push('+' + snap.added);
        if (snap.deleted > 0) statParts.push('-' + snap.deleted);
        if (statParts.length === 0) statParts.push('~0');
        statsSpan.textContent = statParts.join(' ');

        // Color coding
        if (snap.op === 'create_file') {
            nameSpan.style.color = 'var(--green)';
        } else if (snap.op === 'delete_file') {
            nameSpan.style.color = 'var(--red)';
            nameSpan.style.textDecoration = 'line-through';
        }
        if (snap.added > 0 && snap.deleted === 0) statsSpan.style.color = 'var(--green)';
        else if (snap.deleted > 0 && snap.added === 0) statsSpan.style.color = 'var(--red)';
        else if (snap.added > 0 && snap.deleted > 0) statsSpan.style.color = 'var(--yellow)';

        row.appendChild(nameSpan);
        row.appendChild(statsSpan);

        // Click → open diff in X zone
        (function (s) {
            row.addEventListener('click', function (e) {
                e.stopPropagation();
                _a4OpenDiff(s);
            });
        })(snap);

        block.appendChild(row);
    }

    // Show block
    block.classList.add('has-files');
}

// ---- 打开 diff 查看器（发送到父窗口 → git goods timeline tab） ----
function _a4OpenDiff(snap) {
    _postToHost({
        type: 'qqq-a4-open-diff',
        path: snap.path,
        before: snap.before,
        after: snap.after,
        op: snap.op,
        added: snap.added,
        deleted: snap.deleted
    });
}

// ═══ 快照持久化：floor 完成时写入文件系统 + 元数据入 floor payload ═══

// 由 panel-floor.js 的 _finalizeFloor 调用（或 panel-send.js 的 saveFloor）
async function _a4PersistSnapshots(ag, questNumericId, floorNum) {
    if (!ag || !ag._a4Snapshots) return null;
    var snaps = ag._a4Snapshots;
    var paths = Object.keys(snaps);
    if (paths.length === 0) return null;

    var dir = _a4SnapshotDir(questNumericId, floorNum);
    var bridge = getBridge();
    var metadata = [];

    for (var i = 0; i < paths.length; i++) {
        var snap = snaps[paths[i]];
        var hash = _a4PathHash(snap.path);
        var meta = {
            path: snap.path,
            op: snap.op,
            added: snap.added,
            deleted: snap.deleted,
            ts: snap.ts,
            count: snap.count,
            hash: hash
        };
        metadata.push(meta);

        // Write content files (async, best-effort)
        if (dir && bridge && bridge.fs) {
            try {
                if (snap.before !== null && snap.before !== undefined) {
                    await bridge.fs.write(dir + hash + '.before', snap.before);
                }
                if (snap.after !== null && snap.after !== undefined) {
                    await bridge.fs.write(dir + hash + '.after', snap.after);
                }
                // Write path mapping
                await bridge.fs.write(dir + hash + '.meta', JSON.stringify(meta));
            } catch (_) { /* best effort */ }
        }
    }

    return metadata;
}

// ═══ 历史楼层 A4 恢复（从 floor payload 的 a4Snapshots 渲染） ═══
function _a4RestoreBlock(aiDiv, a4Meta, questNumericId, floorNum) {
    if (!a4Meta || !a4Meta.length) return;
    var block = _initA4Block(aiDiv);
    block.innerHTML = '';

    for (var i = 0; i < a4Meta.length; i++) {
        var meta = a4Meta[i];
        var row = document.createElement('div');
        row.className = 'msg-a4-row';
        row.dataset.path = meta.path;

        var fname = meta.path.replace(/\\/g, '/').split('/').pop() || meta.path;
        var nameSpan = document.createElement('span');
        nameSpan.className = 'msg-a4-fname';
        nameSpan.textContent = fname;
        nameSpan.title = meta.path;

        var statsSpan = document.createElement('span');
        statsSpan.className = 'msg-a4-stats';
        var statParts = [];
        if (meta.added > 0) statParts.push('+' + meta.added);
        if (meta.deleted > 0) statParts.push('-' + meta.deleted);
        if (statParts.length === 0) statParts.push('~0');
        statsSpan.textContent = statParts.join(' ');

        if (meta.op === 'create_file') {
            nameSpan.style.color = 'var(--green)';
        } else if (meta.op === 'delete_file') {
            nameSpan.style.color = 'var(--red)';
            nameSpan.style.textDecoration = 'line-through';
        }
        if (meta.added > 0 && meta.deleted === 0) statsSpan.style.color = 'var(--green)';
        else if (meta.deleted > 0 && meta.added === 0) statsSpan.style.color = 'var(--red)';
        else if (meta.added > 0 && meta.deleted > 0) statsSpan.style.color = 'var(--yellow)';

        row.appendChild(nameSpan);
        row.appendChild(statsSpan);

        // Click → load from disk + open diff
        (function (m, qId, fNum) {
            row.addEventListener('click', function (e) {
                e.stopPropagation();
                _a4OpenHistoricalDiff(m, qId, fNum);
            });
        })(meta, questNumericId, floorNum);

        block.appendChild(row);
    }
    block.classList.add('has-files');
}

// ---- 历史楼层 diff：从快照文件加载 before/after 并发送到父窗口 ----
async function _a4OpenHistoricalDiff(meta, questNumericId, floorNum) {
    var dir = _a4SnapshotDir(questNumericId, floorNum);
    var bridge = getBridge();
    var before = null, after = null;

    if (dir && bridge && bridge.fs) {
        try { before = await bridge.fs.read(dir + meta.hash + '.before'); } catch (_) { }
        try { after = await bridge.fs.read(dir + meta.hash + '.after'); } catch (_) { }
    }

    _postToHost({
        type: 'qqq-a4-open-diff',
        path: meta.path,
        before: before,
        after: after,
        op: meta.op,
        added: meta.added,
        deleted: meta.deleted
    });
}

// ═══ 清理当前 floor 快照（floor 结束时调用） ═══
function _a4ClearCurrent(ag) {
    if (ag) ag._a4Snapshots = {};
}

// ═══ 导出到 window（跨模块引用 §29） ═══
window._a4PersistSnapshots = _a4PersistSnapshots;
window._a4RestoreBlock = _a4RestoreBlock;
window._a4ClearCurrent = _a4ClearCurrent;
window._a4RenderLive = _a4RenderLive;
window._initA4Block = _initA4Block;
