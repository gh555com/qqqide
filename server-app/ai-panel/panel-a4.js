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
var A4_COMPRESS = true; // 启用 gzip 压缩（~70% 节省，零依赖）
var A4_COMPRESS_THRESHOLD = 256; // 小于此字节数不压缩（压缩小文件可能反而增大）
var A4_BINARY_EXT = new RegExp('\\.(png|jpg|jpeg|gif|ico|webp|svgz|woff2?|ttf|eot|otf|wasm|zip|gz|br|tar|7z|rar|exe|dll|so|dylib|o|a|bin|dat|pak|pyc|class|map)(\\.|$)','i');
var A4_GZIP_MAGIC = String.fromCharCode(0x1f, 0x8b); // gzip 魔数，用于检测已压缩数据

// ---- Uint8Array ↔ base64（分块安全，避免栈溢出） ----
function _a4Uint8ToBase64(bytes) {
    var CHUNK = 0x8000; // 32KB chunks
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
}

function _a4Base64ToUint8(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

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

// ═══ 压缩/解压（gzip，浏览器内置 CompressionStream，零依赖） ═══

async function _a4Gzip(text) {
    if (!text || text.length < A4_COMPRESS_THRESHOLD) return text;
    try {
        if (typeof CompressionStream === 'undefined') return text;
        var cs = new CompressionStream('gzip');
        var writer = cs.writable.getWriter();
        var reader = cs.readable.getReader();
        writer.write(new TextEncoder().encode(text));
        writer.close();
        var chunks = [];
        var total = 0;
        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            chunks.push(chunk.value);
            total += chunk.value.length;
        }
        var combined = new Uint8Array(total);
        var off = 0;
        for (var c = 0; c < chunks.length; c++) {
            combined.set(chunks[c], off);
            off += chunks[c].length;
        }
        // 转换为 base64（分块避免 fromCharCode.apply 栈溢出）
        var b64 = _a4Uint8ToBase64(combined);
        return A4_GZIP_MAGIC + b64;
    } catch (e) {
        return text; // 压缩失败，回退原文
    }
}

async function _a4Gunzip(data) {
    if (!data || data.indexOf(A4_GZIP_MAGIC) !== 0) return data;
    try {
        if (typeof DecompressionStream === 'undefined') return data;
        var b64part = data.slice(A4_GZIP_MAGIC.length);
        var bytes = _a4Base64ToUint8(b64part);
        var ds = new DecompressionStream('gzip');
        var writer = ds.writable.getWriter();
        var reader = ds.readable.getReader();
        writer.write(bytes);
        writer.close();
        var chunks = [];
        var total = 0;
        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            chunks.push(chunk.value);
            total += chunk.value.length;
        }
        var combined = new Uint8Array(total);
        var off = 0;
        for (var c2 = 0; c2 < chunks.length; c2++) {
            combined.set(chunks[c2], off);
            off += chunks[c2].length;
        }
        return new TextDecoder().decode(combined);
    } catch (e) {
        return data; // 解压失败，回退原文（可能未压缩）
    }
}

// ---- 二进制文件检测 ----
function _a4IsBinary(path, content) {
    if (A4_BINARY_EXT.test(path)) return true;
    if (!content) return false;
    // 检查前 8KB 中是否有 null 字节
    var checkLen = Math.min(content.length, 8192);
    for (var i = 0; i < checkLen; i++) {
        if (content.charCodeAt(i) === 0) return true;
    }
    return false;
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
                    if (!_a4IsBinary(filePath, raw)) beforeContent = raw;
                }
            } else if (bridge.fs && bridge.fs.read) {
                var raw2 = await bridge.fs.read(filePath);
                if (typeof raw2 === 'string' && raw2.length <= A4_MAX_SNAPSHOT_BYTES) {
                    if (!_a4IsBinary(filePath, raw2)) beforeContent = raw2;
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
            if (!_a4IsBinary(filePath, args.content)) afterContent = args.content;
        }
    } else {
        // edit_file: read file after edit
        try {
            if (bridge && bridge.ai && bridge.ai.read_file) {
                var raw3 = await bridge.ai.read_file({ path: filePath });
                if (typeof raw3 === 'string' && raw3.indexOf('Error') !== 0 && raw3.length <= A4_MAX_SNAPSHOT_BYTES) {
                    if (!_a4IsBinary(filePath, raw3)) afterContent = raw3;
                }
            } else if (bridge && bridge.fs && bridge.fs.read) {
                var raw4 = await bridge.fs.read(filePath);
                if (typeof raw4 === 'string' && raw4.length <= A4_MAX_SNAPSHOT_BYTES) {
                    if (!_a4IsBinary(filePath, raw4)) afterContent = raw4;
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

    // ★ 实时持久化到新 timeline 存储（SHA256去重 + SQLite）
    _a4PersistToTimeline(filePath, op, before, after, ag);
}

// ═══ A4 DOM 创建 + 渲染 ═══

function _initA4Block(aiDiv) {
    if (aiDiv._a4Block) return aiDiv._a4Block;
    var block = document.createElement('div');
    block.className = 'msg-a4';
    // Position: after A2 (treasure), before A1 (stats) / clock
    // 铁律顺序: A2 → A4 → A1 → clock
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
    // 确保 A2 在 A4 上方：如果 A2 存在且位于 A4 之后，把 A2 挪到 A4 之前
    var a2 = aiDiv._treasureBlock;
    if (a2 && a2.nextSibling === block) {
        // A2 刚好在 A4 后面（append 导致的逆序），交换
        aiDiv.insertBefore(a2, block);
    } else if (a2 && _isAfter(a2, block)) {
        aiDiv.insertBefore(a2, block);
    }
    aiDiv._a4Block = block;
    return block;
}

// 判断 elA 是否在 elB 之后（DOM 顺序）
function _isAfter(elA, elB) {
    var el = elB.nextSibling;
    while (el) {
        if (el === elA) return true;
        el = el.nextSibling;
    }
    return false;
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

// ---- 打开 diff 查看器（触发独立 BrowserWindow） ----
function _a4OpenDiff(snap) {
    // 新方式：通过 IPC 打开独立 BrowserWindow
    var bridge = _getBridge();
    if (bridge && bridge.timeline && typeof _workspaceRoot !== 'undefined' && _workspaceRoot) {
        var root = _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
        // 异步记录 before/after 并获取 blob hash，然后打开 diff 窗口
        (async function () {
            var beforeHash = null, afterHash = null;
            try {
                if (snap.before !== null && snap.before !== undefined) {
                    var bRec = await bridge.timeline.record({ projectRoot: root, filePath: snap.path, content: snap.before, source: 'ai-edit', floorId: null });
                    if (bRec && bRec.ok) beforeHash = bRec.blob_hash;
                }
                if (snap.after !== null && snap.after !== undefined) {
                    var aRec = await bridge.timeline.record({ projectRoot: root, filePath: snap.path, content: snap.after, source: 'ai-edit', floorId: null });
                    if (aRec && aRec.ok) afterHash = aRec.blob_hash;
                }
            } catch (_) { }
            try {
                await bridge.timeline.openDiffWindow({
                    filePath: snap.path,
                    projectRoot: root,
                    beforeBlobHash: beforeHash || undefined,
                    afterBlobHash: afterHash || undefined
                });
            } catch (_) { }
        })();
    }
    // 兼容：仍然发消息给父窗口（保留旧路径作为 fallback）
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

// ═══ 快照持久化：floor 完成时写入 timeline 存储 + 元数据入 floor payload ═══
// 新架构：内容走 timeline.record（SHA256去重+gzip+SQLite）
// 旧文件系统写入已废弃，仅保留元数据用于 floor payload
// 由 panel-floor.js 的 _finalizeFloor 调用（或 panel-send.js 的 saveFloor）
async function _a4PersistSnapshots(ag, questNumericId, floorNum) {
    if (!ag || !ag._a4Snapshots) return null;
    var snaps = ag._a4Snapshots;
    var paths = Object.keys(snaps);
    if (paths.length === 0) return null;

    var root = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
        ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
    var bridge = getBridge();
    var metadata = [];

    for (var i = 0; i < paths.length; i++) {
        var snap = snaps[paths[i]];
        var floorId = questNumericId ? ('q' + questNumericId + '/f' + floorNum) : null;
        var hashVal = _a4PathHash(snap.path); // 保留兼容旧文件系统快照
        var meta = {
            path: snap.path,
            op: snap.op,
            added: snap.added,
            deleted: snap.deleted,
            ts: snap.ts,
            count: snap.count,
            hash: hashVal
        };

        // ★ 新路径：通过 timeline.record 持久化到 SHA256去重存储
        if (root && bridge && bridge.timeline) {
            try {
                if (snap.after !== null && snap.after !== undefined) {
                    var rec = await bridge.timeline.record({
                        projectRoot: root,
                        filePath: snap.path,
                        content: snap.after,
                        source: 'ai-edit',
                        floorId: floorId
                    });
                    if (rec && rec.ok) meta.blob_hash = rec.blob_hash;
                }
                if (snap.before !== null && snap.before !== undefined && snap.before !== snap.after) {
                    await bridge.timeline.record({
                        projectRoot: root,
                        filePath: snap.path,
                        content: snap.before,
                        source: 'ai-edit',
                        floorId: floorId
                    });
                }
            } catch (_) { /* best effort */ }
        }

        metadata.push(meta);
    }

    return metadata;
}

// ★ 实时持久化单次快照到 timeline（在 _a4RecordSnapshot 中调用）
async function _a4PersistToTimeline(filePath, op, before, after, ag) {
    var root = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
        ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
    if (!root) return;
    var bridge = getBridge();
    if (!bridge || !bridge.timeline) return;
    try {
        if (after !== null && after !== undefined) {
            await bridge.timeline.record({ projectRoot: root, filePath: filePath, content: after, source: 'ai-edit' });
        }
    } catch (_) { }
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

// ---- 历史楼层 diff：尝试新 BrowserWindow 路径 + 旧文件系统 fallback ----
async function _a4OpenHistoricalDiff(meta, questNumericId, floorNum) {
    var bridge = getBridge();
    var root = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
        ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;

    // ★ 优先尝试新路径：通过 timeline.openDiffWindow 打开 BrowserWindow
    if (root && bridge && bridge.timeline && meta.blob_hash) {
        try {
            await bridge.timeline.openDiffWindow({
                filePath: meta.path,
                projectRoot: root,
                afterBlobHash: meta.blob_hash
            });
            return; // 新路径成功
        } catch (_) { }
    }

    // Fallback: 旧文件系统快照路径
    var dir = _a4SnapshotDir(questNumericId, floorNum);
    var before = null, after = null;

    if (dir && bridge && bridge.fs) {
        try { 
            var rawBefore = await bridge.fs.read(dir + meta.hash + '.before'); 
            before = A4_COMPRESS ? await _a4Gunzip(rawBefore) : rawBefore;
        } catch (_) { }
        try { 
            var rawAfter = await bridge.fs.read(dir + meta.hash + '.after'); 
            after = A4_COMPRESS ? await _a4Gunzip(rawAfter) : rawAfter;
        } catch (_) { }
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

// ═══════════════════════════════════════════════════════════════
// 增量持久化 — 统一入口（覆盖 a1/a2/a3/a4 全部豆腐块）
// ═══════════════════════════════════════════════════════════════

var _a4IncrementalDirty = false;
var _a4IncrementalTimer = null;
var _a4IncrementalBusy = false;
var A4_INCREMENTAL_FLUSH_MS = 2000;
var A4_INCREMENTAL_MAX_MS = 8000;
var _a4FirstDirtyTs = 0;

// ── 标记脏（其他模块调用此函数触发统一刷盘）──
function _a4MarkIncrementalDirty() {
    _a4IncrementalDirty = true;
    if (!_a4FirstDirtyTs) _a4FirstDirtyTs = Date.now();
    if (_a4IncrementalTimer) clearTimeout(_a4IncrementalTimer);
    var elapsed = Date.now() - _a4FirstDirtyTs;
    if (elapsed >= A4_INCREMENTAL_MAX_MS) {
        _a4FlushCompleteFloor();
    } else {
        _a4IncrementalTimer = setTimeout(_a4FlushCompleteFloor, A4_INCREMENTAL_FLUSH_MS);
    }
}

// ── A4 专属：每次快照后立即写内容文件到磁盘 ──
function _a4IncrementalPersist(ag, filePath, before, after) {
    var questId = (typeof questActiveId !== 'undefined') ? questActiveId : '';
    var floorNum = (ag._ctx && ag._ctx.totalFloors) ? ag._ctx.totalFloors : 0;
    if (!questId || !floorNum) return;

    var dir = _a4SnapshotDir(_a4GetNumericId(questId), floorNum);
    var bridge = getBridge();
    if (!dir || !bridge || !bridge.fs) return;

    var hash = _a4PathHash(filePath);

    if (before !== null && before !== undefined) {
        _a4Gzip(before).then(function(comp) {
            bridge.fs.write(dir + hash + '.before', comp).catch(function(){});
        }).catch(function(){});
    }
    if (after !== null && after !== undefined) {
        _a4Gzip(after).then(function(comp) {
            bridge.fs.write(dir + hash + '.after', comp).catch(function(){});
        }).catch(function(){});
    }

    // 同时标记统一刷盘
    _a4MarkIncrementalDirty();
}

function _a4GetNumericId(questId) {
    var qs = window.questStore;
    if (!qs || !qs._index) return 0;
    for (var i = 0; i < qs._index.length; i++) {
        if (qs._index[i].id === questId) return qs._index[i].numericId || 0;
    }
    return 0;
}

// ── 构建完整 floor payload（与 _saveAgentQuestData 同构）──
function _a4BuildCompleteFloorPayload(ag) {
    var fullConv = ag.conversation ? ag.conversation.slice() : [];
    var floorStartIdx = ag._floorStartIdx || 0;
    var floorConv = fullConv.slice(floorStartIdx);

    var payload = {
        question: (ag._lastUserInput && ag._lastUserInput.text) || '',
        conversation: floorConv,
        houses: (ag._houses || []).slice(),
        costWge: ag._floorCostWge,
        floorFree: ag._floorFree || false,
        lastUserInput: ag._lastUserInput,
        allTxtPath: ag._allTxtPath || '',
        fileStats: (typeof _computeFileStats === 'function') ? _computeFileStats(ag._houses, ag._a4Snapshots) : { fileCount: 0, added: 0, deleted: 0 },
        clockTiming: ag._lastFloorTimingRecord || null,
        treasures: ag._floorTreasures || [],
        createdAt: ag._floorCreatedAt || Date.now(),
        savedAt: Date.now(),
        // ★ 流式持久化：捕获正在打印中的部分 AI 回复文本
        _streamingText: (ag._activeAiDiv && ag._activeAiDiv._fullText) ? ag._activeAiDiv._fullText : '',
        _streaming: !!(ag._streaming)
    };

    // 附加 a4 快照明数据
    if (ag._a4Snapshots) {
        var snaps = ag._a4Snapshots;
        var paths = Object.keys(snaps);
        if (paths.length > 0) {
            var a4Meta = [];
            for (var i = 0; i < paths.length; i++) {
                var s = snaps[paths[i]];
                a4Meta.push({
                    path: s.path, op: s.op, added: s.added, deleted: s.deleted,
                    ts: s.ts, count: s.count, hash: _a4PathHash(s.path)
                });
            }
            payload.a4Snapshots = a4Meta;
        }
    }

    return payload;
}

// ── 统一刷盘：构建完整 payload → 直接覆写 SQLite ──
function _a4FlushCompleteFloor() {
    if (_a4IncrementalTimer) { clearTimeout(_a4IncrementalTimer); _a4IncrementalTimer = null; }
    if (!_a4IncrementalDirty || _a4IncrementalBusy) return;
    _a4IncrementalDirty = false;
    _a4FirstDirtyTs = 0;
    _a4IncrementalBusy = true;

    var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    if (!ag) { _a4IncrementalBusy = false; return; }
    var questId = (typeof questActiveId !== 'undefined') ? questActiveId : '';
    if (!questId) { _a4IncrementalBusy = false; return; }
    var floorNum = ag._ctx.totalFloors;
    if (!floorNum) { _a4IncrementalBusy = false; return; }

    var qs = window.questStore;
    if (!qs || !qs.saveFloor) { _a4IncrementalBusy = false; return; }

    var payload = _a4BuildCompleteFloorPayload(ag);

    qs.saveFloor(questId, floorNum, payload).catch(function(){}).then(function() {
        _a4IncrementalBusy = false;
    });
}

// ── beforeunload 强制刷盘 ──
function _a4OnBeforeUnload() {
    if (_a4IncrementalTimer) { clearTimeout(_a4IncrementalTimer); _a4IncrementalTimer = null; }
    if (!_a4IncrementalDirty) return;
    _a4IncrementalDirty = false;
    _a4FirstDirtyTs = 0;

    var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    if (!ag) return;
    var questId = (typeof questActiveId !== 'undefined') ? questActiveId : '';
    if (!questId) return;
    var qs = window.questStore;
    if (!qs || !qs.saveFloor) return;
    var floorNum = ag._ctx.totalFloors;
    if (!floorNum) return;

    var payload = _a4BuildCompleteFloorPayload(ag);
    qs.saveFloor(questId, floorNum, payload).catch(function(){});
}

if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', _a4OnBeforeUnload);
    // ★ 流式保护：流式输出期间每 5s 强制标记脏（防止长文本打印中断无保存）
    setInterval(function() {
        var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
        if (ag && ag._streaming) _a4MarkIncrementalDirty();
    }, 5000);
}

// ═══ 导出到 window（跨模块引用 §29） ═══
window._a4MarkIncrementalDirty = _a4MarkIncrementalDirty;
window._a4BuildCompleteFloorPayload = _a4BuildCompleteFloorPayload;
window._a4PersistSnapshots = _a4PersistSnapshots;
window._a4RestoreBlock = _a4RestoreBlock;
window._a4ClearCurrent = _a4ClearCurrent;
window._a4RenderLive = _a4RenderLive;
window._initA4Block = _initA4Block;
