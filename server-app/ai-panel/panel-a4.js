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
var A4_BINARY_EXT = new RegExp('\\.(png|jpg|jpeg|gif|ico|webp|svgz|woff2?|ttf|eot|otf|wasm|zip|gz|br|tar|7z|rar|exe|dll|so|dylib|o|a|bin|dat|pak|pyc|class|map)(\\.|$)', 'i');

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
    // ★ 行尾归一化：strip trailing \r 防止 CRLF vs LF 污染 LCS
    for (var _bi = 0; _bi < bLines.length; _bi++) { if (bLines[_bi].charCodeAt(bLines[_bi].length - 1) === 13) bLines[_bi] = bLines[_bi].slice(0, -1); }
    for (var _ai = 0; _ai < aLines.length; _ai++) { if (aLines[_ai].charCodeAt(aLines[_ai].length - 1) === 13) aLines[_ai] = aLines[_ai].slice(0, -1); }
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

// ---- 噪声文件检测（run_command 扫描结果过滤）----
var _A4_NOISE_PATTERNS = [
    /\.log$/i,                        // 任意 .log 文件
    /[\\\/]node_modules[\\\/]/i,   // npm 依赖
    /[\\\/]__pycache__[\\\/]/i,    // Python 缓存
    /[\\\/]\.(git|svn|hg)[\\\/]/i,
    /\.pyc$/i,
    /\.tmp\./i,
    /Thumbs\.db$/i,
    /\.DS_Store$/i,
    /desktop\.ini$/i,
];
function _a4IsNoiseFile(filePath) {
    for (var _ni = 0; _ni < _A4_NOISE_PATTERNS.length; _ni++) {
        if (_A4_NOISE_PATTERNS[_ni].test(filePath)) return true;
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
    // ★ 在 await 前捕获 trace（防止并行工具竞态覆盖）
    var traceObj = (typeof window !== 'undefined' && window._qqqCurrentTrace) ? window._qqqCurrentTrace : null;
    var root = await _resolveProjectRoot(filePath);
    if (!root) return null;
    var bridge = getBridge();
    if (!bridge || !bridge.timeline) return null;

    try {
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

        // ★ 行尾归一化比较：CRLF vs LF 应视为相同内容，防重复版本
        if (typeof lastContent === 'string' && typeof currentContent === 'string') {
            var normLast = lastContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            var normCurr = currentContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            if (normLast === normCurr) {
                // ② 内容一致（忽略行尾差异）→ 复用已有 blob_hash
                return lastBlob;
            }
        }

        // ③ 内容不一致（外部改过）→ 记录当前内容为新版本
        var rec2 = await bridge.timeline.record({
            projectRoot: root, filePath: filePath, content: currentContent,
            source: 'q', floorId: floorId, addedLines: 0, deletedLines: 0
        });
        return (rec2 && rec2.ok) ? rec2.blob_hash : null;
    } catch (err) {
        console.error('[a4] _a4EnsureBeforeBaseline error:', (err && err.message) || err, filePath);
        return null;
    }
}

// ── 钩子 Q：统一快照管线（AI 写工具 + run_command）──
async function _a4WrappedExecuteTool(name, args, ownerAgent) {
    // ★ 优先用调用方显式传入的 agent（防 _activeAgent 全局指针漂移致跨 quest 污染）
    var _capturedAg = ownerAgent || ((typeof _activeAgent !== 'undefined') ? _activeAgent : null);

    // Non-write tools: pass through directly
    if (_WRITE_TOOLS.indexOf(name) === -1) {
        return _a4OriginalExecuteTool(name, args);
    }

    // ═══ run_command 特殊处理：执行 → 扫描变更 → 逐文件记录 ═══
    // ★ 默认关闭（timeline.trackRunCommand=false），用户可在设置→高级中开启
    if (name === 'run_command') {
        var _trackCmd = (typeof qqqSettings !== 'undefined' && qqqSettings.get) ? qqqSettings.get('timeline.trackRunCommand', false) : false;
        if (!_trackCmd) {
            return _a4OriginalExecuteTool(name, args);
        }
        var cmdStartTs = Date.now();
        var cmdResult = await _a4OriginalExecuteTool(name, args);
        if (cmdResult && typeof cmdResult === 'string' && cmdResult.indexOf('Error') !== 0) {
            var bridge3 = getBridge();
            var scanRoot = args.cwd ? await _resolveProjectRoot(args.cwd.replace(/\\/g, '/')) : null;
            if (!scanRoot) {
                scanRoot = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
                    ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
            }
            if (bridge3 && bridge3.timeline && scanRoot) {
                try {
                    var changed = await bridge3.timeline.captureChanged({ projectRoot: scanRoot, sinceMs: cmdStartTs, cwd: args.cwd || '' });
                    if (changed && changed.length) {
                        for (var ci = 0; ci < changed.length; ci++) {
                            if (_a4IsNoiseFile(changed[ci].filePath)) continue;
                            await _a4RecordSnapshot(changed[ci].filePath, 'run_command', null, changed[ci].content, null, _capturedAg);
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
    if (bridge) {
        if (name === 'create_file') {
            // ★ 新建文件：以空文本为基线（before），记完后工具写内容为 after
            beforeContent = '';
            beforeBlobHash = await _a4EnsureBeforeBaseline(filePath, beforeContent);
        } else {
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
    await _a4RecordSnapshot(filePath, name, beforeContent, afterContent, beforeBlobHash, _capturedAg);

    // ★ 将 afterBlobHash 追加到返回值，供 AI 后续通过 read_file sha256 读取历史版本
    var snapEntry = _capturedAg._a4Snapshots && _capturedAg._a4Snapshots[filePath];
    if (snapEntry && snapEntry.afterBlobHash) {
        result = result + ' [sha256: ' + snapEntry.afterBlobHash + ']';
    }

    return result;
}

// Install wrapper
if (_a4OriginalExecuteTool) {
    executeTool = _a4WrappedExecuteTool;
}

// ═══ 快照记录：写入 agent 的 _a4Snapshots ═══
//   可选 ag 参数：传入则用该 agent（后台 agent 工具调用时使用），否则用 _activeAgent
async function _a4RecordSnapshot(filePath, op, before, after, knownBeforeHash, ag) {
    if (!ag) ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
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

// ---- 中间截断超长文件名 ----
function _truncMiddle(text, maxLen) {
    if (text.length <= maxLen) return text;
    var keep = Math.floor((maxLen - 3) / 2);
    return text.slice(0, keep) + '...' + text.slice(text.length - keep);
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

        // Filename (middle truncation for long names)
        var fname = snap.path.replace(/\\/g, '/').split('/').pop() || snap.path;
        var nameSpan = document.createElement('span');
        nameSpan.className = 'msg-a4-fname';
        nameSpan.textContent = _truncMiddle(fname, 36);
        nameSpan.title = snap.path;

        // Count badge（第几次修改）
        var countSpan = document.createElement('span');
        countSpan.className = 'msg-a4-count';
        countSpan.textContent = (snap.count || 1);

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
        row.appendChild(countSpan);
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

// ═══ 判断是否为图片文件 ═══
function _isImageFile(filePath) {
    var ext = (filePath || '').split('.').pop().toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].indexOf(ext) >= 0;
}

// ═══ 图片文件 → 打开悬浮预览层 ═══
async function _openImagePreview(filePath) {
    var bridge = _getBridge();
    if (!bridge || !bridge.fs) return false;
    try {
        var st = await bridge.fs.stat(filePath);
        if (!st) return false;
    } catch (_) {
        return false; // 文件不存在
    }
    var fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
    _postToHost({ type: 'qqqide-overlay', action: 'open-image', src: fileUrl });
    return true;
}

// ---- 打开 diff 查看器（独立 BrowserWindow）----
// ★ 同时传 beforeBlobHash + afterBlobHash：左右各精确选中对应版本
async function _a4OpenDiff(snap) {
    // 图片文件特殊处理
    if (_isImageFile(snap.path)) {
        if (snap.op === 'delete_file') return; // 已删除→无原文件→不响应
        var opened = await _openImagePreview(snap.path);
        if (opened) return; // 已打开预览→不再开 diff
    }
    var bridge = _getBridge();
    if (bridge && bridge.timeline) {
        var root = await _resolveProjectRoot(snap.path); // ★ 文件自寻主
        if (!root) return;
        var beforeHash = snap.beforeBlobHash || undefined;
        var afterHash = snap.afterBlobHash || undefined;
        console.log('[a4] openDiff path=' + snap.path + ' before=' + (beforeHash || '').substring(0, 16) + ' after=' + (afterHash || '').substring(0, 16) + ' same=' + (beforeHash === afterHash));
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
    // ★ 在 await 前捕获 trace（防止并行工具竞态覆盖）
    var traceObj = (typeof window !== 'undefined' && window._qqqCurrentTrace) ? window._qqqCurrentTrace : null;
    var root = await _resolveProjectRoot(filePath); // ★ 终极架构：文件自寻主
    if (!root) return;
    var bridge = getBridge();
    if (!bridge || !bridge.timeline) return;

    var diffStats = _a4DiffStats(before, after);

    var floorId = null;
    if (traceObj && traceObj.questId && traceObj.floorNum) {
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
        } catch (_e) {
            console.error('[a4] _a4PersistToTimeline error:', (_e && _e.message) || _e, filePath);
        }
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
        nameSpan.textContent = _truncMiddle(fname, 36);
        nameSpan.title = meta.path;

        // Count badge（第几次修改）
        var countSpan = document.createElement('span');
        countSpan.className = 'msg-a4-count';
        countSpan.textContent = (meta.count || 1);

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
        row.appendChild(countSpan);
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
    // 图片文件特殊处理
    if (_isImageFile(meta.path)) {
        if (meta.op === 'delete_file') return; // 已删除→无原文件→不响应
        var opened = await _openImagePreview(meta.path);
        if (opened) return; // 已打开预览→不再开 diff
    }
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
// ── 构建完整 floor payload（与 _saveAgentQuestData 同构）──
//   可选 floorNum: 若传入则使用 ag._floorMeta[floorNum] 中的未可变元数据
function _a4BuildCompleteFloorPayload(ag, floorNum, opts) {
    opts = opts || {};
    // ★ 查询该楼层的未可变元数据（如传入了 floorNum 且有 _floorMeta）
    var meta = (floorNum && ag._floorMeta && ag._floorMeta[floorNum]) ? ag._floorMeta[floorNum] : null;
    var floorStartIdx = meta ? meta.floorStartIdx : (typeof ag._floorStartIdx === "number" ? ag._floorStartIdx : 0);
    var allTxtPath = meta ? meta.allTxtPath : (ag._allTxtPath || '');
    var fDir = meta && meta._fDir ? meta._fDir : (allTxtPath ? allTxtPath.replace(/[\\/]all\.txt$/g, '').replace(/[\\/]$/, '') + '/' : '');

    var fullConv = ag.conversation ? ag.conversation.slice() : [];
    var floorConv = fullConv.slice(floorStartIdx);

    // ★ 持久化净化：_lines/reasoning/tools/toolResults 是运行时数据不入库
    //   reasoning 已由 Compressed Summary 覆盖，不再需要保留
    var cleanHouses = (ag._houses || []).map(function (h) {
        var c = Object.assign({}, h);
        delete c._lines;
        delete c.reasoning;
        delete c.answer;            // ★ 去除冗余：与 conversation 中 assistant.content 完全重复
        // ★ 保存工具调用次数（room 计数用），再删除 tools 数组
        c.toolCount = (c.tools && c.tools.length) || 0;
        delete c.tools;
        delete c.toolResults;
        return c;
    });
    var cleanConv = floorConv.map(function (m) {
        if (m && m.reasoning_content !== undefined) {
            var c = Object.assign({}, m);
            delete c.reasoning_content;
            return c;
        }
        return m;
    });

    // ★ fatal 落盘兜底：conversation 为空时记入错误消息（防重启丢上下文）
    if (cleanConv.length === 0 && ag._floorFatal) {
        var _fatalErr3 = '⚠️ 楼层异常中断（' + (ag._exitReason || '未知原因') + '），对话已保存。';
        cleanConv = [{ role: 'assistant', content: _fatalErr3, _error: true, _floor: floorNum || ag._currentFloorNum || 0 }];
    }

    // ★ 预计算渲染数据 — 一次渲染永久不变
    //   优先取 live DOM HTML（用户实际看到的 _contentWrap.innerHTML），保证所见即所得
    //   仅当 DOM 已销毁（旧楼/异常）才回退到 _buildConversationFlowHtml 从 conversation 重建
    // ★ 跨面板迁移：flush 所有未渲染段落到 DOM，确保 ai_html 完整捕获
    //   ⚠ 不用 ag._doStreamRender()：它内部有 _stopState !== 'sending' 守卫，
    //      在 onDone 后 _stopState 已非 sending 时会直接 return，吞掉未渲染段落。
    //      改为手动 flush，无论 stopState 为何都把 _paras 和 _buf 渲染入 DOM。
    var _aiDiv = ag._activeAiDiv;
    // ★ switchQuest 中途保存：跳过 DOM 冲刷（agent 后台继续流式，不应干扰其渲染状态）
    if (!opts.skipDomFlush && _aiDiv && _aiDiv._contentWrap) {
        // ★ B 重构：流式数据从 agent 读取
        // --- flush _paras（按 \n\n 分割的已完成段落） ---
        var _rendered = ag._streamRenderedCount || 0;
        var _pending = ag._streamParas || [];
        var _rm = typeof renderMarkdown === 'function' ? renderMarkdown : function (s) { return s; };
        while (_rendered < _pending.length) {
            var _pp = _pending[_rendered];
            if (_pp && _pp.trim()) {
                var _pDiv = document.createElement('div');
                _pDiv.innerHTML = _rm(_pp);
                _aiDiv._contentWrap.appendChild(_pDiv);
            }
            _pending[_rendered] = null;
            _rendered++;
        }
        ag._streamRenderedCount = _rendered;
        // --- flush _buf（未完成的尾部，如代码块末尾） ---
        if (ag._streamCodeFenceOpen && ag._streamBuf) {
            var _fc = ag._streamBuf;
            var _fnl = _fc.indexOf('\n');
            if (_fnl > 0 && /^```/.test(_fc)) _fc = _fc.slice(_fnl + 1);
            if (_fc.trim()) {
                var _fDiv = document.createElement('div');
                _fDiv.innerHTML = '<pre><code>' + (typeof escHtml === 'function' ? escHtml(_fc) : _fc) + '</code></pre>';
                _aiDiv._contentWrap.appendChild(_fDiv);
            }
            // ★ 推进 _splitCursor 防重复追加
            if (ag._streamBuf) ag._streamSplitCursor = ag._streamBuf.length;
        } else {
            var _trailStart = ag._streamSplitCursor || 0;
            var _trailing = ag._streamBuf ? ag._streamBuf.slice(_trailStart) : '';
            if (_trailing && _trailing.trim()) {
                var _tDiv = document.createElement('div');
                _tDiv.innerHTML = _rm(_trailing);
                _aiDiv._contentWrap.appendChild(_tDiv);
            }
            // ★ 推进 _splitCursor 防重复追加
            if (ag._streamBuf) ag._streamSplitCursor = ag._streamBuf.length;
        }
        // --- 移除 _lastParaEl（流式临时打字块） ---
        if (_aiDiv._lastParaEl) {
            _aiDiv._lastParaEl.remove();
            _aiDiv._lastParaEl = null;
        }
        // --- 去掉所有 stream-para 类 ---
        var _spAll = _aiDiv._contentWrap.querySelectorAll('.stream-para');
        for (var _spi = 0; _spi < _spAll.length; _spi++) {
            _spAll[_spi].classList.remove('stream-para');
        }
        _aiDiv._dirty = false;
    }
    var ai_html = '';
    // ★ 中断恢复：优先用紧急快照（onError 在清理前抓取），防 DOM 已变
    if (ag._emergencyAiHtml) {
        ai_html = ag._emergencyAiHtml;
        ag._emergencyAiHtml = null;  // 一次性消费
    }
    if (!ai_html && ag._activeAiDiv && ag._activeAiDiv._contentWrap) {
        try { ai_html = ag._activeAiDiv._contentWrap.innerHTML; } catch (_) { }
    }
    // ★ B 重构：流式状态从 agent 读取（共享，非 aiDiv 持有）
    var _streamingBuf = ag._streamBuf || '';
    var _streamingSplitCursor = ag._streamSplitCursor || 0;
    var _streamingCodeFenceOpen = !!ag._streamCodeFenceOpen;
    if (!ai_html && typeof _buildConversationFlowHtml === 'function') {
        try {
            var _fDataForRender = {
                question: (ag._lastUserInput && ag._lastUserInput.text) || '',
                conversation: cleanConv,
                houses: cleanHouses,
                costWge: ag._floorCostWge,
                clockTiming: ag._lastFloorTimingRecord || null,
                _streamingText: (ag._streaming && ag._streamFullText) ? ag._streamFullText : '',
                _streaming: !!(ag._streaming),
                floorFatal: !!ag._floorFatal,
                exitReason: ag._exitReason || ''
            };
            ai_html = _buildConversationFlowHtml(cleanConv, _fDataForRender);
        } catch (_) { }
    }
    // ★ 剥离 [CURRENT TIME: ...] 块
    var questionClean = (ag._lastUserInput && ag._lastUserInput.text) || '';
    var _ctIdx2 = questionClean.indexOf('\n\n[CURRENT TIME:');
    if (_ctIdx2 > 0) questionClean = questionClean.slice(0, _ctIdx2);
    // ★ house / room 计数
    var house_count = (ag._houses && ag._houses.length) || 0;
    var room_count = 0;
    if (ag._houses) {
        for (var _hci = 0; _hci < ag._houses.length; _hci++) {
            var _h = ag._houses[_hci];
            // ★ 优先 toolCount（跨面板恢复结构），降级 tools.length（实时流式）
            if (typeof _h.toolCount === 'number') room_count += _h.toolCount;
            else if (_h.tools && _h.tools.length) room_count += _h.tools.length;
        }
    }

    var payload = {
        question: questionClean,
        ai_html: ai_html,
        house_count: house_count,
        room_count: room_count,
        floorFatal: !!ag._floorFatal,
        exitReason: ag._exitReason || '',
        conversation: cleanConv,
        houses: cleanHouses,
        costWge: ag._floorCostWge,
        floorFree: ag._floorCostWge === 0,
        lastUserInput: ag._lastUserInput,
        allTxtPath: allTxtPath,
        fileStats: (typeof _computeFileStats === 'function') ? _computeFileStats(ag._houses, ag._a4Snapshots) : { fileCount: 0, added: 0, deleted: 0 },
        clockTiming: ag._lastFloorTimingRecord || (ag._floorStartPerf ? { durationMs: Math.round(performance.now() - ag._floorStartPerf), networkMs: (ag._floorTiming && ag._floorTiming.networkMs) || 0, aiMs: (ag._floorTiming && ag._floorTiming.aiMs) || 0, otherMs: (ag._floorTiming && ag._floorTiming.otherMs) != null ? ag._floorTiming.otherMs : Math.max(0, (performance.now() - ag._floorStartPerf) - (((ag._floorTiming && ag._floorTiming.networkMs) || 0) + ((ag._floorTiming && ag._floorTiming.aiMs) || 0))), floorIndex: ag._currentFloorNum || 0 } : null),
        aiStartTime: ag._aiStartTime || '',
        tierLabel: ag._aiTierLabel || '',
        images: ag._lastUserInput && ag._lastUserInput.images ? ag._lastUserInput.images.map(function (img) {
            return { id: img.id, fileName: img.fileName || '', dataUrl: img.dataUrl || '' };
        }) : [],
        _floorStartIdx: floorStartIdx,
        _fDir: fDir,
        createdAt: ag._floorCreatedAt || Date.now(),
        savedAt: Date.now(),
        // ★ 流式持久化：捕获正在打印中的部分 AI 回复文本（仅在流式中断时保留）
        _streamingText: (ag._streaming && ag._streamFullText) ? ag._streamFullText : '',
        _streaming: !!(ag._streaming),
        // ★ 跨面板迁移：流式缓冲区状态（让接手面板无缝续接）
        _streamingBuf: _streamingBuf,
        _streamingSplitCursor: _streamingSplitCursor,
        _streamingCodeFenceOpen: _streamingCodeFenceOpen
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

// ═══ 导出到 window（跨模块引用 §29） ═══
window._a4BuildCompleteFloorPayload = _a4BuildCompleteFloorPayload;
window._a4PersistSnapshots = _a4PersistSnapshots;
window._a4RestoreBlock = _a4RestoreBlock;
window._a4ClearCurrent = _a4ClearCurrent;
window._a4RenderLive = _a4RenderLive;
window._a4DiffStats = _a4DiffStats;
window._initA4Block = _initA4Block;
