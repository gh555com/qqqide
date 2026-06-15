// ============================================================================
// panel-a4.js — A4 文件快照块（每层楼私有，A2 与 A1 之间）
//
// 职责：
//   ① 钩子 Q：拦截 executeTool，捕获 before/after → 实时记录到 timeline（含 trace + diff stats）
//   ② 实时渲染 A4 瀑布列表（文件名 + +N -M 行变更）
//   ③ 点击文件 → 读内存 blob_hash → openDiffWindow（不补记！钩子 Q 已记全）
//   ④ 楼层完结 → 打包内存 blob_hash 入 meta → floor payload
//
// 铁律：
//   - per-floor 状态归属 agent 对象（§36）：agent._a4Snapshots
//   - A4 DOM 归属 aiDiv（§29）：aiDiv._a4Block
//   - 快照内容上限 512KB/文件，超限只记录元数据不存内容
//   - 钩子 Q+X 双钩子体系，无其他快照入口
// ============================================================================

var A4_MAX_SNAPSHOT_BYTES = 512 * 1024; // 512KB per file content cap
var A4_BINARY_EXT = new RegExp('\\.(png|jpg|jpeg|gif|ico|webp|svgz|woff2?|ttf|eot|otf|wasm|zip|gz|br|tar|7z|rar|exe|dll|so|dylib|o|a|bin|dat|pak|pyc|class|map)(\\.|$)','i');

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

// ═══ 文件路径 → 归属项目根目录（终极架构：向上找 qqq/timeline/ 或 .git/） ═══
var _projectRootCache = {}; // {filePath: projectRoot}

async function _resolveProjectRoot(filePath) {
    if (!filePath) return (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
        ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
    // 缓存命中（同一文件或同目录已查过）
    if (_projectRootCache[filePath]) return _projectRootCache[filePath];
    var bridge = getBridge();
    if (!bridge || !bridge.fs) {
        var fallback = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
            ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
        return fallback;
    }
    var dir = filePath.replace(/\\/g, '/').replace(/\/[^\/]*$/, ''); // 父目录
    // 最多向上遍历 12 层
    for (var depth = 0; depth < 12 && dir && dir.length > 3; depth++) {
        // 检查 {dir}/qqq/timeline（已初始化滴项目）
        try {
            var st = await bridge.fs.stat(dir + '/qqq/timeline');
            if (st && st.isDir) {
                _projectRootCache[filePath] = dir;
                return dir;
            }
        } catch (_) { }
        // 检查 {dir}/.git（未初始化滴项目，后续会自动创建 qqq/timeline）
        try {
            var st2 = await bridge.fs.stat(dir + '/.git');
            if (st2 && st2.isDir) {
                _projectRootCache[filePath] = dir;
                return dir;
            }
        } catch (_) { }
        dir = dir.replace(/\/[^\/]*$/, '');
    }
    // 兜底：主项目
    var fallback2 = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
        ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
    _projectRootCache[filePath] = fallback2;
    return fallback2;
}

// ═══ 钩子 Q 文件索引：分项目维护（辅项目各自独立，互不污染）═══
// ★ run_command 捕获扫描时不再遍历全目录，只 stat 此索引中的文件
var _fileIndex = {}; // {projectRoot: {filePath: true}}
var _fileIndexDirty = {}; // {projectRoot: true}
var _fileIndexBusy = false;

function _a4UpdateFileIndex(filePath) {
    if (!filePath) return;
    var normalized = filePath.replace(/\\/g, '/');
    // 缓存命中 → 同步（常见：同一文件在同一楼层被多次编辑）
    var cached = _projectRootCache[filePath];
    if (cached) {
        if (!_fileIndex[cached]) _fileIndex[cached] = {};
        if (!_fileIndex[cached][normalized]) {
            _fileIndex[cached][normalized] = true;
            _fileIndexDirty[cached] = true;
        }
        return;
    }
    // 缓存未命中 → 异步解析（首次遇见的文件）
    _resolveProjectRoot(filePath).then(function (root) {
        if (!root) return;
        if (!_fileIndex[root]) _fileIndex[root] = {};
        if (!_fileIndex[root][normalized]) {
            _fileIndex[root][normalized] = true;
            _fileIndexDirty[root] = true;
        }
    }).catch(function () { });
}

async function _a4PersistFileIndex() {
    if (_fileIndexBusy) return;
    // 收集 dirty 项目
    var dirtyRoots = Object.keys(_fileIndexDirty).filter(function (r) { return _fileIndexDirty[r]; });
    if (dirtyRoots.length === 0) return;
    _fileIndexBusy = true;
    var bridge = getBridge();
    if (!bridge || !bridge.fs) { _fileIndexBusy = false; return; }
    for (var di = 0; di < dirtyRoots.length; di++) {
        var root = dirtyRoots[di];
        _fileIndexDirty[root] = false;
        var indexPath = root + '/qqq/timeline/file-index.json';
        var files = _fileIndex[root] ? Object.keys(_fileIndex[root]) : [];
        try { await bridge.fs.write(indexPath, JSON.stringify(files)); } catch (_) { }
    }
    _fileIndexBusy = false;
    // 如果在写入期间又有新文件加入，补写一次
    var stillDirty = Object.keys(_fileIndexDirty).some(function (r) { return _fileIndexDirty[r]; });
    if (stillDirty) _a4PersistFileIndex();
}

function _a4ClearFileIndex() {
    var bridge = getBridge();
    // 清除所有已打开项目的索引
    var roots = Object.keys(_fileIndex);
    for (var ri = 0; ri < roots.length; ri++) {
        var root = roots[ri];
        var indexPath = root + '/qqq/timeline/file-index.json';
        if (bridge && bridge.fs) bridge.fs.write(indexPath, '[]').catch(function () { });
    }
    _fileIndex = {};
    _fileIndexDirty = {};
}

// ★ 页面关闭前强制写盘
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', function () {
        _a4PersistFileIndex();
    });
}

// ═══ executeTool 拦截器：文件修改前后自动捕获快照 ═══
var _a4OriginalExecuteTool = (typeof executeTool === 'function') ? executeTool : null;

var _WRITE_TOOLS = ['edit_file', 'create_file', 'write_file', 'delete_file', 'run_command'];

// ── 编辑前基线：确保 before 进入 timeline ──
// ① 无版本 → 记录当前内容（建立基线）
// ② 有版本但 last ≠ 当前内容 → 记录（外部改过）
// ③ 有版本且 last == 当前内容 → 返回已有 blob_hash
async function _a4EnsureBeforeBaseline(filePath, currentContent) {
    var root = await _resolveProjectRoot(filePath);
    if (!root) return null;
    var bridge = getBridge();
    if (!bridge || !bridge.timeline) return null;

    try {
        // ★ 读取当前 trace
        var traceObj = (typeof window !== 'undefined' && window._qqqCurrentTrace) ? window._qqqCurrentTrace : null;
        var floorId = null;
        if (traceObj && traceObj.questId && traceObj.floorNum) {
            floorId = 'q' + traceObj.questId.replace(/^q/i, '') + '/f' + traceObj.floorNum +
                '/h' + (traceObj.houseIdx || 0) + '/r' + (traceObj.roomIdx || 0);
        }

        // 查 timeline 是否有该文件版本
        var versions = await bridge.timeline.versions({ projectRoot: root, filePath: filePath });
        if (!versions || versions.length === 0) {
            // ① 从未追踪 → 记录当前内容，建立基线
            var rec = await bridge.timeline.record({
                projectRoot: root, filePath: filePath, content: currentContent,
                source: 'q', floorId: floorId, addedLines: 0, deletedLines: 0
            });
            return (rec && rec.ok) ? rec.blob_hash : null;
        }

        // 取最后一条版本内容对比
        var lastBlob = versions[versions.length - 1].blob_hash;
        var lastContent = await bridge.timeline.content({ projectRoot: root, blobHash: lastBlob });

        if (typeof lastContent === 'string' && lastContent === currentContent) {
            // ② 内容一致 → 复用已有 blob_hash
            return lastBlob;
        }

        // ③ 内容不一致（外部改过）→ 记录当前内容为新版本
        var rec2 = await bridge.timeline.record({
            projectRoot: root, filePath: filePath, content: currentContent,
            source: 'q', floorId: floorId, addedLines: 0, deletedLines: 0
        });
        return (rec2 && rec2.ok) ? rec2.blob_hash : null;
    } catch (_) {
        return null;
    }
}

// ── 钩子 Q：统一快照管线（AI 写工具 + run_command）──
async function _a4WrappedExecuteTool(name, args) {
    // Non-write tools: pass through directly
    if (_WRITE_TOOLS.indexOf(name) === -1) {
        return _a4OriginalExecuteTool(name, args);
    }

    // ═══ run_command 特殊处理：执行 → 扫描变更 → 逐文件记录 ═══
    if (name === 'run_command') {
        var cmdStartTs = Date.now();
        var cmdResult = await _a4OriginalExecuteTool(name, args);
        if (cmdResult && typeof cmdResult === 'string' && cmdResult.indexOf('Error') !== 0) {
            var bridge2 = getBridge();
            // ★ run_command 扫描以 cwd 所在项目为准（若 cwd 指定）或主项目兜底
            var scanRoot = args.cwd ? await _resolveProjectRoot(args.cwd.replace(/\\/g, '/')) : null;
            if (!scanRoot) {
                scanRoot = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
                    ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
            }
            if (bridge2 && bridge2.timeline && scanRoot) {
                try {
                    var changed = await bridge2.timeline.captureChanged({ projectRoot: scanRoot, sinceMs: cmdStartTs, cwd: args.cwd || '' });
                    if (changed && changed.length) {
                        for (var ci = 0; ci < changed.length; ci++) {
                            await _a4RecordSnapshot(changed[ci].filePath, 'run_command', null, changed[ci].content);
                        }
                    }
                } catch (_) { }
            }
        }
        return cmdResult;
    }

    // ═══ 文件写工具：edit/write/create/delete_file ═══
    var filePath = args.path || '';
    var bridge = getBridge();
    var beforeContent = null;
    var beforeBlobHash = null; // ★ 编辑前基线 blob_hash

    // ---- 1. 捕获 BEFORE + 建立基线 ----
    if (name !== 'create_file' && bridge) {
        try {
            if (bridge.fs && bridge.fs.read) {
                var raw2 = await bridge.fs.read(filePath);
                if (typeof raw2 === 'string' && raw2.length <= A4_MAX_SNAPSHOT_BYTES) {
                    if (!_a4IsBinary(filePath, raw2)) {
                        beforeContent = raw2;
                        // ★ 确保 before 进入 timeline：查是否有版本，无/不一致则补录
                        beforeBlobHash = await _a4EnsureBeforeBaseline(filePath, beforeContent);
                    }
                }
            }
        } catch (_) { }
    }

    // ---- 2. 执行原工具 ----
    var result = await _a4OriginalExecuteTool(name, args);

    // 工具失败 → 不记录快照
    if (!result || (typeof result === 'string' && result.indexOf('Error') === 0)) {
        return result;
    }

    // ---- 3. 捕获 AFTER ----
    var afterContent = null;
    if (name === 'delete_file') {
        afterContent = null;
    } else if (name === 'create_file' || name === 'write_file') {
        if (args.content && args.content.length <= A4_MAX_SNAPSHOT_BYTES) {
            if (!_a4IsBinary(filePath, args.content)) afterContent = args.content;
        }
    } else {
        try {
            if (bridge && bridge.fs && bridge.fs.read) {
                var raw4 = await bridge.fs.read(filePath);
                if (typeof raw4 === 'string' && raw4.length <= A4_MAX_SNAPSHOT_BYTES) {
                    if (!_a4IsBinary(filePath, raw4)) afterContent = raw4;
                }
            }
        } catch (_) { }
    }

    // ---- 4. 记录快照（钩子 Q：记 both before+after 到 timeline）----
    await _a4RecordSnapshot(filePath, name, beforeContent, afterContent, beforeBlobHash);

    return result;
}

// Install wrapper
if (_a4OriginalExecuteTool) {
    executeTool = _a4WrappedExecuteTool;
}

// ═══ 快照记录：写入当前 agent 的 _a4Snapshots ═══
async function _a4RecordSnapshot(filePath, op, before, after, knownBeforeHash) {
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
        // ★ 编辑前基线（首次编辑时已建立，后续累积保持最早 before hash）
        if (knownBeforeHash && !existing.beforeBlobHash) {
            existing.beforeBlobHash = knownBeforeHash;
        }
    } else {
        ag._a4Snapshots[filePath] = {
            path: filePath,
            op: op,
            before: before,
            after: after,
            added: stats.added,
            deleted: stats.deleted,
            ts: Date.now(),
            count: 1,
            beforeBlobHash: knownBeforeHash || undefined // ★ 编辑前基线
        };
    }

    // ★ 钩子 Q：先持久化到 timeline（确保 blob_hash 已就位），再更新 UI
    await _a4PersistToTimeline(filePath, op, before, after, ag);

    // ★ 更新文件索引（供 run_command 扫描时使用）
    _a4UpdateFileIndex(filePath);

    // Persist file index periodically (debounced by dirty flag)
    _a4PersistFileIndex();

    // Live update A4 UI（此时 snapEntry.beforeBlobHash/afterBlobHash 已就位）
    _a4RenderLive(ag);
}

// ═══ A4 DOM 创建 + 渲染 ═══

function _initA4Block(aiDiv) {
    if (aiDiv._a4Block) return aiDiv._a4Block;
    var block = document.createElement('div');
    block.className = 'msg-a4';
    // Position: before A1 (stats) / clock
    // 铁律顺序: A4 → A1 → clock
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

// ---- 打开 diff 查看器（独立 BrowserWindow）----
// ★ 同时传 beforeBlobHash + afterBlobHash：左右各精确选中对应版本
async function _a4OpenDiff(snap) {
    var bridge = _getBridge();
    if (bridge && bridge.timeline) {
        var root = await _resolveProjectRoot(snap.path); // ★ 文件自寻主
        if (!root) return;
        var beforeHash = snap.beforeBlobHash || undefined;
        var afterHash = snap.afterBlobHash || undefined;
        bridge.timeline.openDiffWindow({
            filePath: snap.path,
            projectRoot: root,
            beforeBlobHash: beforeHash,
            afterBlobHash: afterHash
        }).catch(function () { });
    }
}

// ═══ 快照持久化：floor 完成时打包元数据入 floor payload ═══
// ★ 钩子 Q 已实时记录 before/after 到 timeline；此处只读内存 blob_hash 打包 meta
// 由 panel-floor.js 的 _finalizeFloor 调用（或 panel-send.js 的 saveFloor）
async function _a4PersistSnapshots(ag, questNumericId, floorNum) {
    if (!ag || !ag._a4Snapshots) return null;
    var snaps = ag._a4Snapshots;
    var paths = Object.keys(snaps);
    if (paths.length === 0) return null;

    var metadata = [];

    for (var i = 0; i < paths.length; i++) {
        var snap = snaps[paths[i]];
        var meta = {
            path: snap.path,
            op: snap.op,
            added: snap.added,
            deleted: snap.deleted,
            ts: snap.ts,
            count: snap.count,
            // ★ 钩子 Q 已记录，直接从内存读取 blob_hash
            before_blob_hash: snap.beforeBlobHash || undefined,
            blob_hash: snap.afterBlobHash || undefined
        };
        metadata.push(meta);
    }

    return metadata;
}

// ★ 钩子 Q 核心：记录 both before+after 到 timeline（含 trace + diff stats）
// ★ SHA256 去重由服务端处理（不再 UPDATE ts），直接调用即可
async function _a4PersistToTimeline(filePath, op, before, after, ag) {
    var root = await _resolveProjectRoot(filePath); // ★ 终极架构：文件自寻主
    if (!root) return;
    var bridge = getBridge();
    if (!bridge || !bridge.timeline) return;

    var diffStats = _a4DiffStats(before, after);

    // ★ 读取当前 trace（agent-loop.js 埋的全局标记）
    var traceObj = (typeof window !== 'undefined' && window._qqqCurrentTrace) ? window._qqqCurrentTrace : null;
    var floorId = null;
    if (traceObj && traceObj.questId && traceObj.floorNum) {
        // 格式: "q38/f14/h3/r2" — quest/floor/house/room
        floorId = 'q' + traceObj.questId.replace(/^q/i, '') + '/f' + traceObj.floorNum +
            '/h' + (traceObj.houseIdx || 0) + '/r' + (traceObj.roomIdx || 0);
    }

    var snapEntry = ag._a4Snapshots && ag._a4Snapshots[filePath];

    // ── 记录 after（含 diff stats）──
    if (after !== null && after !== undefined) {
        try {
            var aRec = await bridge.timeline.record({
                projectRoot: root, filePath: filePath, content: after,
                source: 'q', floorId: floorId,
                addedLines: diffStats.added, deletedLines: diffStats.deleted
            });
            if (aRec && aRec.ok && snapEntry) {
                snapEntry.afterBlobHash = aRec.blob_hash;
            }
        } catch (_) { }
    }

    // ★ before 已由 _a4EnsureBeforeBaseline 记录，此处不重复
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

// ---- 历史楼层 diff：唯一路径 bridge.timeline ----
async function _a4OpenHistoricalDiff(meta, questNumericId, floorNum) {
    var bridge = getBridge();
    var root = await _resolveProjectRoot(meta.path); // ★ 文件自寻主

    if (root && bridge && bridge.timeline) {
        try {
            await bridge.timeline.openDiffWindow({
                filePath: meta.path,
                projectRoot: root,
                beforeBlobHash: meta.before_blob_hash || undefined,
                afterBlobHash: meta.blob_hash || undefined
            });
        } catch (_) { }
    }
}

// ═══ 清理当前 floor 快照（floor 结束时调用） ═══
function _a4ClearCurrent(ag) {
    if (ag) ag._a4Snapshots = {};
    _a4ClearFileIndex(); // ★ 战斗结束，清掉文件索引
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

// ── 构建完整 floor payload（与 _saveAgentQuestData 同构）──
function _a4BuildCompleteFloorPayload(ag) {
    var fullConv = ag.conversation ? ag.conversation.slice() : [];
    var floorStartIdx = (typeof ag._floorStartIdx === "number") ? ag._floorStartIdx : fullConv.length;
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
                    ts: s.ts, count: s.count,
                    before_blob_hash: s.beforeBlobHash || undefined,
                    blob_hash: s.afterBlobHash || undefined
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
window._a4DiffStats = _a4DiffStats;
window._initA4Block = _initA4Block;
