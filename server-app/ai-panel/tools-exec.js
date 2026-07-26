// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// tools-exec.js — 工具执行引擎（READ 类 + 调度中心）
// 从 tools.js 拆分而来。WRITE 类见 tools-exec-write.js，EFFECT 类见 tools-exec-effect.js
// ============================================================================

// ---- 目录/扩展名跳过列表（供 search_text / list_files / find_files 使用）----
var SKIP_DIRS = ['node_modules', '.git', '__pycache__', '.venv', 'vendor', 'backup', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs', 'cache', 'temp', 'crashDumps'];
var SKIP_EXTS = ['.exe', '.dll', '.so', '.dylib', '.bin', '.pyd', '.pyc', '.pyo', '.class', '.o', '.obj', '.lib', '.a', '.sys', '.drv', '.ocx', '.scr', '.cab', '.msi', '.msc', '.cpl', '.lnk', '.dat', '.pak', '.res', '.resources', '.rom', '.elf', '.ko', '.mod', '.dex', '.jar', '.war', '.ear', '.apk', '.ipa', '.iso', '.img', '.dmg', '.pkg', '.deb', '.rpm', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp', '.svgz', '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.zip', '.tar', '.gz', '.xz', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.icns', '.vsix', '.lock', '.wasm', '.map', '.tsbuildinfo', '.sq3', '.db', '.sqlite', '.sqlite3', '.sdb'];

// ══════════════════════════════════════════════════════════════
// 235 Cascade — 3-layer version quality assessment for timeline tools
//   L2 Heuristic: floor_id metadata → 🏁final/⚠️mid-edit (zero cost, always on)
//   L3 Syntax: vm.Script(node)/JSON.parse → ✅clean/⚠️{err} (on-demand, cached by blob_hash)
//   L5 Recommendation: best clean version + post-revert adjacent analysis
// ══════════════════════════════════════════════════════════════
var _synCache = {}; // blob_hash → {ok:bool, msg:string} — immutable blobs, cache forever
var _SYN_CHECK_MAX = 20; // max versions to syntax-check per call

// Layer 2: Heuristic tag from floor_id metadata (zero cost)
//   floor_id format: "q{id}/f{N}/h{N}/r{N}"
//   Last version per floor → 🏁 final. Earlier versions from same floor → ⚠️ mid-edit.
//   O(n) via pre-built floor→max_seq map (not O(n²)).
function _buildFloorMaxSeq(versions) {
    var map = {}; // floorN → max file_seq
    for (var i = 0; i < versions.length; i++) {
        var v = versions[i];
        if (!v.floor_id) continue;
        var m = v.floor_id.match(/\/f(\d+)\//);
        if (!m) continue;
        var fn = parseInt(m[1], 10);
        if (map[fn] === undefined || v.file_seq > map[fn]) map[fn] = v.file_seq;
    }
    return map;
}
function _heuristicTag(v, floorMaxSeq) {
    if (!v.floor_id) return '';
    var m = v.floor_id.match(/\/f(\d+)\//);
    if (!m) return '';
    var floorN = parseInt(m[1], 10);
    var maxSeq = floorMaxSeq[floorN];
    if (maxSeq !== undefined && v.file_seq < maxSeq) return '⚠️ mid-edit';
    return '🏁 final';
}

// Layer 3: Syntax check for JS/JSON content (cached by blob_hash)
//   Uses require('vm').Script if nodeIntegration available (zero-spawn, ~1ms)
//   Falls back to bridge.qz.spawn node --check (one batch per call)
function _syntaxCheckInline(content, ext) {
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
        try {
            if (typeof require !== 'undefined') {
                var vm = require('vm');
                new vm.Script(content);
                return { ok: true, msg: 'clean' };
            }
        } catch (e) {
            if (e.code === 'MODULE_NOT_FOUND' || (e.message && e.message.indexOf('require') >= 0)) {
                return null; // vm not available — caller should fall back to spawn
            }
            return { ok: false, msg: e.message.split('\n')[0] };
        }
        return null; // require not available
    }
    if (ext === 'json') {
        try { JSON.parse(content); return { ok: true, msg: 'clean' }; }
        catch (e) { return { ok: false, msg: e.message.split('\n')[0] }; }
    }
    return null; // unsupported extension
}

// Layer 3 async wrapper: read blob → check → cache
async function _checkOneVersion(bridge, root, v, ext) {
    if (!v.blob_hash) return null;
    // Cache hit
    if (_synCache[v.blob_hash]) return _synCache[v.blob_hash];
    // Not a checkable type
    if (ext !== 'js' && ext !== 'mjs' && ext !== 'cjs' && ext !== 'json') return null;
    try {
        var content = await bridge.timeline.content({ projectRoot: root, blobHash: v.blob_hash });
        if (content === null || content === undefined) return null;
        var r = _syntaxCheckInline(content, ext);
        if (r) { _synCache[v.blob_hash] = r; return r; }
        // Fallback: node --check via child_process stdin (zero temp files, no orphans)
        try {
            var cp = require('child_process');
            cp.execFileSync('node', ['--check'], { input: content, timeout: 3000 });
            r = { ok: true, msg: 'clean' };
        } catch (e) {
            if (e.code === 'MODULE_NOT_FOUND') return null;
            var errOut = (e.stderr || e.message || '') + '';
            var ok = (e.status === 0);
            r = { ok: ok, msg: errOut.split('\n').slice(0, 2).join(' ').slice(0, 80) };
        }
        _synCache[v.blob_hash] = r;
        return r;
    } catch (_) { return null; }
}

// ══════════════════════════════════════════════════════════════
// Land-to-floor: write fetch_webpage/search_web results to floor dir,
//   record to timeline, return sha256+trace stamp for biscuit reference.
//   Makes these tools "one-line gentle box" compatible.
// ══════════════════════════════════════════════════════════════
async function _landToFloorDir(content, prefix, ownerAgent) {
    if (!ownerAgent || !content) return '';
    var floorNum = ownerAgent._currentFloorNum;
    if (!floorNum) return '';
    var meta = ownerAgent._floorMeta && ownerAgent._floorMeta[floorNum];
    var fDir = meta ? meta._fDir : null;
    if (!fDir) {
        // Fallback: compute from project root
        var root = (typeof questStore !== 'undefined' && questStore.getProjectRoot)
            ? questStore.getProjectRoot().replace(/\\/g, '/').replace(/\/$/, '') : null;
        if (!root) return '';
        var qInfo = ownerAgent._questInfo || {};
        var qDir = qInfo.dirName || ('q' + (ownerAgent._questId || '').replace(/^q/i, ''));
        var fDirName = 'f' + floorNum;
        fDir = root + '/qqq/quests/' + qDir + '/' + fDirName + '/';
    }

    // Counter: stored on agent per-floor
    var ck = '_' + prefix + 'N_' + floorNum;
    if (!ownerAgent[ck]) ownerAgent[ck] = 1;
    var n = ownerAgent[ck]++;
    var filePath = fDir + prefix + '_' + n + '.txt';

    var bridge = getBridge();
    if (!bridge) return '';

    // Write to disk
    try {
        await bridge.fs.write(filePath, content);
    } catch (_) {
        return '';
    }

    // Record to timeline (get blob_hash)
    var blobHash = null;
    try {
        var root2 = await _resolveTimelineRoot(filePath);
        if (root2 && bridge.timeline && bridge.timeline.record) {
            var traceObj = (typeof window !== 'undefined' && window._qqqCurrentTrace) ? window._qqqCurrentTrace : null;
            var floorId = null;
            if (traceObj && traceObj.questId && traceObj.floorNum) {
                floorId = 'q' + String(traceObj.questId).replace(/^q/i, '') + '/f' + traceObj.floorNum +
                    '/h' + (traceObj.houseIdx || 0) + '/r' + (traceObj.roomIdx || 0);
            }
            var rec = await bridge.timeline.record({
                projectRoot: root2, filePath: filePath, content: content,
                source: 'q', floorId: floorId,
                addedLines: content.split('\n').length, deletedLines: 0
            });
            if (rec && rec.ok && rec.blob_hash) blobHash = rec.blob_hash;
        }
    } catch (_) { }

    // Build stamp
    var stamp = '';
    if (blobHash) {
        stamp += ' [sha256: ' + blobHash + ']';
    }
    var tr = (typeof window !== 'undefined' && window._qqqCurrentTrace) ? window._qqqCurrentTrace : null;
    if (tr && tr.questId && tr.floorNum) {
        stamp += ' @q' + String(tr.questId).replace(/^q/i, '') + 'f' + tr.floorNum + 'h' + (tr.houseIdx || 0) + 'r' + (tr.roomIdx || 0);
    }
    return stamp;
}

// Layer 5: Find best clean version (last ✅ before any ⚠️)
function _findBestClean(versions, tagMap) {
    var best = null;
    for (var i = versions.length - 1; i >= 0; i--) {
        var t = tagMap[versions[i].file_seq];
        if (t && t.indexOf('✅') >= 0) { best = versions[i]; break; }
    }
    if (!best) {
        // Fallback: last version with 🏁 final tag
        for (var i = versions.length - 1; i >= 0; i--) {
            var t = tagMap[versions[i].file_seq];
            if (t && t.indexOf('🏁') >= 0) { best = versions[i]; break; }
        }
    }
    return best;
}

// ============================================================
// 工具执行分发
// ============================================================

async function executeTool(name, args, ownerAgent) {
    // ★ Floor 级泛化 READ 缓存 — 消灭同 floor 内重搜索/重列目录死循环
    //   缓存 key = toolName + 规范化参数 JSON（剔除 null/undefined）
    //   每层楼由 agent-loop.js 复位: window._qqqToolCacheThisFloor = {}
    var _cache = (typeof window !== 'undefined') ? window._qqqToolCacheThisFloor : null;
    var _cat = TOOL_CATEGORY[name] || 'EFFECT';
    if (_cache && _cat === 'READ' && name !== 'read_file') {
        // 规范化 args：排序 key + 剔除 null/undefined
        var _canon = {};
        var _keys = Object.keys(args || {}).sort();
        for (var _ki = 0; _ki < _keys.length; _ki++) {
            var _k = _keys[_ki];
            if (args[_k] != null) _canon[_k] = args[_k];
        }
        var _cacheKey = name + '::' + JSON.stringify(_canon);
        var _cached = _cache[_cacheKey];
        if (_cached !== undefined) {
            return '[CACHED — same args this floor] ' + _cached;
        }
        // 闭包捕获，供下方缓存写入
        var __shouldCache = true;
        var __cacheKey = _cacheKey;
    }

    // ★ Path resolution: resolve project-relative paths to absolute
    //   Applies to ALL path-like arguments across all tools.
    //   /server-app/foo.js → E:/project/server-app/foo.js
    //   {project}/server-app/foo.js → E:/project/server-app/foo.js
    //   Full absolute paths pass through unchanged.
    if (args.path) args.path = _resolveProjectPath(args.path);
    if (args.filePath) args.filePath = _resolveProjectPath(args.filePath);
    if (args.image) args.image = _resolveProjectPath(args.image);
    if (args.images && Array.isArray(args.images)) args.images = args.images.map(_resolveProjectPath);
    if (args.out_dir) args.out_dir = _resolveProjectPath(args.out_dir);
    if (args.cwd) args.cwd = _resolveProjectPath(args.cwd);

    var _result;
    switch (name) {
        case 'read_file': _result = executeReadFile(args); break;
        case 'edit_file': _result = executeEditFile(args); break;
        case 'search_text': _result = executeSearchText(args); break;
        case 'search_content': _result = executeSearchContent(args); break;
        case 'list_files': _result = executeListFiles(args); break;
        case 'get_vision_context': _result = executeGetVisionContext(); break;
        case 'create_file': _result = executeCreateFile(args); break;
        case 'run_command': _result = executeRunCommand(args); break;
        case 'delete_file': _result = executeDeleteFile(args); break;
        case 'find_files': _result = executeFindFiles(args); break;
        case 'fetch_webpage': _result = executeFetchWebpage(args, ownerAgent); break;
        case 'get_diagnostics': _result = executeGetDiagnostics(args); break;
        case 'write_file': _result = executeWriteFile(args); break;
        case 'generate_image': _result = executeGenerateImage(args); break;
        case 'analyze_image': _result = executeAnalyzeImage(args); break;
        case 'search_smart': _result = executeSearchSmart(args); break;
        case 'remove_background': _result = executeRemoveBackground(args); break;
        case 'search_web': _result = executeSearchWeb(args, ownerAgent); break;
        case 'timeline_versions': _result = executeTimelineVersions(args); break;
        case 'revert_file': _result = executeRevertFile(args); break;
        case 'diff_versions': _result = executeDiffVersions(args); break;
        default: _result = 'Unknown tool: ' + name; break;
    }
    _result = await _result;

    // ★ 写入感知：WRITE 成功后重置该路径的读追踪 + 搜缓存
    //   编辑后内容已变，旧读记录作废，旧搜索结果作废
    if (_result && typeof _result === 'string' && !_result.startsWith('Error:') && !_result.startsWith('Unknown tool:') && _cat === 'WRITE') {
        var _wPath = (args.path || args.filePath || '').replace(/\\/g, '/').toLowerCase();
        if (_wPath) {
            // ① 重置 re-read tracker
            var _rt = (typeof window !== 'undefined') ? window._qqqReadFilesThisFloor : null;
            if (_rt && _rt[_wPath]) { delete _rt[_wPath]; }
            // ② 失效搜索缓存中含该路径的 key
            if (_cache) {
                for (var _ck in _cache) {
                    if (_ck.indexOf(_wPath) >= 0) { delete _cache[_ck]; }
                }
            }
        }
    }

    // 缓存写入：仅成功 READ（非 read_file），非错误
    if (_cache && __shouldCache && _result && typeof _result === 'string' && !_result.startsWith('Error:') && !_result.startsWith('Unknown tool:')) {
        _cache[__cacheKey] = _result;
    }
    return _result;
}

// ============================================================
// read_file
// ============================================================

async function executeReadFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    // ★ 参数名兼容
    args.path = args.path || args.filePath || '';
    args.end_line = args.end_line || args.limit || undefined;
    // ★ 路径合理性校验：防止 AI 将中文文本当作文件路径
    var _p = args.path;
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — does not appear to be a valid file path. Provide an absolute path (e.g. E:\\project\\file.js).';
    }

    // ★ 读追踪：仅用于 ENOENT 防重试 + 预加载软提示（不拦截读取，交给 AI 自主判断）
    var _normPath = _p.replace(/\\/g, '/').toLowerCase();
    var _enoCache = (typeof window !== 'undefined') ? window._qqqEnoentCache : null;
    if (_enoCache && _enoCache[_normPath]) {
        return '[FILE NOT FOUND] ' + _normPath + ' — 该文件在本层楼已确认不存在，请勿重试。检查路径是否有截断或中文字符。';
    }
    // ★ 预加载软提示：若此文件在 rule"..." 注册表中，读完后追加提示
    var _preloadedOrigin = (typeof window !== 'undefined' && window._qqqPreloadedPaths && window._qqqPreloadedPaths[_normPath]) || null;
    var _preloadHint = _preloadedOrigin ? ('\n\n💡 此文件内容已在对话首条系统消息中预加载（搜索 \'═══ AUTO-LOADED: ' + _preloadedOrigin + ' ═══\'）。本次是从磁盘重读。') : '';

    // ★ 优先走主进程 (1 IPC, 消除大文件序列化开销)
    var _readResult = null;
    var _readErr = null;
    if (bridge.ai && bridge.ai.read_file) {
        try {
            var result = await bridge.ai.read_file({ path: args.path, start_line: args.start_line, end_line: args.end_line });
            _readResult = _guardBinaryResult(result);
        } catch (e) { _readErr = e; }
    }

    if (_readResult === null) {
        // ---- fallback: renderer ----
        try {
            var content = await bridge.fs.read(args.path);
            var binCheck = _checkBinary(content);
            if (binCheck) { _readResult = binCheck; }
            else {
                content = content.replace(/\r\n/g, '\n');
                var lines = content.split('\n');
                var total = lines.length;
                var start = Math.max(0, (args.start_line || 1) - 1);
                var end = args.end_line ? Math.min(total, args.end_line) : Math.min(total, start + 3000);
                var slice = lines.slice(start, end).join('\n');
                _readResult = (total <= 3000 && !args.start_line) ? content : ('File has ' + total + ' lines. Showing L' + (start + 1) + '-' + end + ':\n' + slice);
            }
        } catch (err) { _readErr = err; }
    }

    if (_readErr) {
        var _errMsg = 'Error reading file: ' + (_readErr.message || _readErr);
        // ★ 治根：EISDIR → 自动列目录内容（模型读了文件夹而非文件）
        // ★ 治根：ENOENT → 去父目录模糊匹配，防中文路径/引号截断
        if ((_errMsg.indexOf('EISDIR') >= 0) && (typeof window !== 'undefined')) {
            try {
                var _dirEntries = await bridge.fs.list(args.path);
                if (_dirEntries && _dirEntries.length) {
                    var _dirList = _dirEntries.map(function (e) { return (e.isDir ? '[DIR]  ' : '[FILE] ') + e.name; }).join('\n');
                    return '[IS DIRECTORY] 你读的是一个文件夹，不是文件。其内容如下：\n\n' + _dirList + '\n\n请选择上面的文件名，用完整路径 read_file。';
                }
                return '[IS DIRECTORY] 这是一个空文件夹: ' + args.path;
            } catch (_) { /* 列目录失败，让原始错误透传 */ }
        }
        if ((_errMsg.indexOf('ENOENT') >= 0 || _errMsg.indexOf('no such file') >= 0) && (typeof window !== 'undefined')) {
            var _lastSep = Math.max(args.path.lastIndexOf('\\'), args.path.lastIndexOf('/'));
            var _parentDir = _lastSep > 0 ? args.path.slice(0, _lastSep) : '';
            var _baseName = _lastSep > 0 ? args.path.slice(_lastSep + 1) : args.path;
            if (_parentDir && bridge.fs.list) {
                try {
                    var _entries = await bridge.fs.list(_parentDir);
                    if (_entries && _entries.length) {
                        var _matches = _entries.filter(function (e) { return e.name && e.name.toLowerCase().startsWith(_baseName.toLowerCase()); });
                        if (_matches.length === 1 && _matches[0].name !== _baseName) {
                            // 找到唯一匹配 → 自动纠正路径
                            var _resolved = _parentDir.replace(/\\/g, '/') + '/' + _matches[0].name;
                            if (!window._qqqPathResolve) window._qqqPathResolve = {};
                            window._qqqPathResolve[_normPath] = _resolved;
                            // ★ 判断是目录还是文件
                            if (_matches[0].isDir) {
                                // 目录 → 列出内容，不递归读（会 EISDIR）
                                var _subEntries = await bridge.fs.list(_resolved);
                                if (_subEntries && _subEntries.length) {
                                    var _subList = _subEntries.map(function (e) { return (e.isDir ? '[DIR]  ' : '[FILE] ') + e.name; }).join('\n');
                                    return '[PATH CORRECTED] 路径被截断，已纠正为目录: ' + _resolved + '\n\n' + _subList + '\n\n请用完整路径重新 read_file。';
                                }
                                return '[PATH CORRECTED] 路径被截断，已纠正为目录: ' + _resolved + '\n(目录为空)';
                            }
                            // 文件 → 递归重试
                            args.path = _resolved;
                            return executeReadFile(args);
                        }
                        if (_matches.length > 1) {
                            return '[AMBIGUOUS PATH] 路径前缀匹配到 ' + _matches.length + ' 个条目: ' + _matches.slice(0, 5).map(function (e) { return e.name; }).join(', ') + '。请指定完整路径。';
                        }
                    }
                } catch (_) { /* 父目录未可列则跳过 */ }
            }
            // 无法匹配 → 缓存，永不复读
            if (!window._qqqEnoentCache) window._qqqEnoentCache = {};
            window._qqqEnoentCache[_normPath] = true;
        }
        return _errMsg;
    }
    // ★ 统一内容门：一切过 ContentGateway.gate()，零自截断
    // ★ 追加预加载软提示（不拦截，仅告知）
    if (_preloadHint && typeof _readResult === 'string' && _readResult.indexOf('[BINARY FILE]') !== 0) {
        _readResult += _preloadHint;
    }
    return _readResult;
}

// 二进制检测 — 委托 ContentGateway 唯一真理实现
function _checkBinary(content) {
    if (!content || content.length === 0) return '';
    var isBinary = (typeof ContentGateway !== 'undefined' && ContentGateway.detectBinary)
        ? ContentGateway.detectBinary(content)
        : false;
    if (isBinary) {
        return '[BINARY FILE] This file appears to be binary (' + content.length + ' bytes). Use run_command with appropriate tools to inspect binary files.';
    }
    return '';
}

function _guardBinaryResult(result) {
    if (typeof result !== 'string') return result;
    var check = _checkBinary(result);
    if (check) return check;
    return result;
}

// ============================================================
// search_text — 递归正则搜索
// ============================================================

async function executeSearchText(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    // ★ 参数别名
    args.query = args.query || args.pattern || '';
    args.path = args.path || args.directory || '';
    args.max_results = args.max_results || args.limit || 30;

    // ★ sha256: 在历史版本 blob 中搜索（Timeline 集成）
    if (args.sha256) {
        args.path = args.path || args.filePath || '';
        var _p2 = args.path;
        if (!_p2) return 'Error: path required when using sha256 for search_text';
        var root2 = await _resolveTimelineRoot(_p2);
        if (!root2) return 'Error: could not resolve project root for "' + _p2 + '"';
        if (!bridge.timeline || !bridge.timeline.content) return 'Error: timeline content not available';
        try {
            var blobContent = await bridge.timeline.content({ projectRoot: root2, blobHash: args.sha256 });
            if (blobContent === null || blobContent === undefined) return 'Error: blob not found for hash ' + args.sha256;
            var reFlags2 = args.case_sensitive ? '' : 'i';
            var regex2;
            try { regex2 = new RegExp(args.query, reFlags2); }
            catch (_) { regex2 = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), reFlags2); }
            var blobLines = blobContent.split('\n');
            var blobMatches = [];
            var maxR2 = args.max_results || 30;
            for (var bli = 0; bli < blobLines.length && blobMatches.length < maxR2; bli++) {
                if (regex2.test(blobLines[bli])) {
                    blobMatches.push('L' + (bli + 1) + ': ' + blobLines[bli].trim().slice(0, 200));
                }
            }
            var prefix2 = '[Historical blob sha=' + args.sha256.slice(0, 12) + '] ';
            return blobMatches.length > 0 ? prefix2 + '\n' + blobMatches.join('\n') : prefix2 + 'No matches found.';
        } catch (e) { return 'Error searching historical blob: ' + (e.message || e); }
    }

    var searchDirs = [];
    if (args.path) {
        searchDirs = [args.path];
    } else {
        // Use vision context folders
        try {
            if (parent.qqqideViewport) {
                var vps = parent.qqqideViewport.getProjects();
                searchDirs = vps.map(function (p) { return p.path; });
            }
        } catch (_) { }
        if (searchDirs.length === 0) {
            return 'Error: no search path specified and no vision context available.';
        }
    }

    var maxResults = args.max_results || 30;

    // * 优先走主进程 (1 IPC, 消除 renderer IPC 洪水)
    if (bridge.ai && bridge.ai.search_text) {
        try {
            return await bridge.ai.search_text({ query: args.query, paths: searchDirs, maxResults: maxResults });
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer walk (legacy) ----
    var regex;
    var _regexHint = '';
    var reFlags = args.case_sensitive ? '' : 'i';
    try {
        regex = new RegExp(args.query, reFlags);
    } catch (_) {
        regex = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), reFlags);
        _regexHint = '⚠️ Regex syntax error in "' + args.query + '", fell back to literal search.\n';
    }

    var MAX_FILE_SIZE = 2 * 1024 * 1024;
    var matches = [];

    async function walk(dir, depth) {
        if (depth > 8 || matches.length >= maxResults) return;
        var entries;
        try { entries = await bridge.fs.list(dir); } catch (_) { return; }
        if (!entries || entries.length === 0) return;
        for (var i = 0; i < entries.length && matches.length < maxResults; i++) {
            var ent = entries[i];
            if (ent.name.startsWith('.') && ent.isDir) continue;
            if (ent.isDir && SKIP_DIRS.indexOf(ent.name) !== -1) continue;
            var full = dir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + ent.name;
            if (ent.isDir) {
                await walk(full, depth + 1);
            } else {
                var extMatch = ent.name.match(/\.([a-z0-9]+)$/i);
                var ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';
                if (SKIP_EXTS.indexOf(ext) !== -1) continue;
                try {
                    var st = await bridge.fs.stat(full);
                    if (!st || st.size > MAX_FILE_SIZE) continue;
                    var content = await bridge.fs.read(full);
                    var lines = content.split('\n');
                    for (var li = 0; li < lines.length && matches.length < maxResults; li++) {
                        if (regex.test(lines[li])) {
                            matches.push(full + ':' + (li + 1) + ':' + lines[li].trim().slice(0, 200));
                        }
                    }
                } catch (_) { }
            }
        }
    }

    for (var d = 0; d < searchDirs.length && matches.length < maxResults; d++) {
        await walk(searchDirs[d], 0);
    }

    var _result = matches.length > 0 ? matches.join('\n') : 'No matches found.';
    return _regexHint ? _regexHint + _result : _result;
}

// ============================================================
// search_content — multi-keyword OR search (literal strings, auto-escaped)
// ============================================================

async function executeSearchContent(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    // ★ 参数别名
    args.path = args.path || args.directory || '';
    args.max_results = args.max_results || args.limit || 30;

    // ★ sha256: 在历史版本 blob 中搜索（Timeline 集成）
    if (args.sha256) {
        args.path = args.path || args.filePath || '';
        var _p3 = args.path;
        if (!_p3) return 'Error: path required when using sha256 for search_content';
        var root3 = await _resolveTimelineRoot(_p3);
        if (!root3) return 'Error: could not resolve project root for "' + _p3 + '"';
        if (!bridge.timeline || !bridge.timeline.content) return 'Error: timeline content not available';
        try {
            var blobC = await bridge.timeline.content({ projectRoot: root3, blobHash: args.sha256 });
            if (blobC === null || blobC === undefined) return 'Error: blob not found for hash ' + args.sha256;
            // Normalize keywords
            if (typeof args.keywords === 'string') {
                try { args.keywords = JSON.parse(args.keywords); } catch (_) {
                    if (args.keywords.includes('|')) args.keywords = args.keywords.split('|').map(function(s){return s.trim();}).filter(Boolean);
                }
            }
            if (!args.keywords || !Array.isArray(args.keywords) || args.keywords.length === 0) return 'Error: no keywords provided.';
            var escRe = function(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
            var pat3 = args.keywords.map(escRe).join('|');
            var flags3 = args.case_sensitive ? '' : 'i';
            var re3 = new RegExp(pat3, flags3);
            var bLines = blobC.split('\n');
            var bMatches = [];
            var maxR3 = args.max_results || 30;
            for (var bli = 0; bli < bLines.length && bMatches.length < maxR3; bli++) {
                if (re3.test(bLines[bli])) {
                    bMatches.push('L' + (bli + 1) + ': ' + bLines[bli].trim().slice(0, 200));
                }
            }
            var pre3 = '[Historical blob sha=' + args.sha256.slice(0, 12) + '] ';
            return bMatches.length > 0 ? pre3 + '\n' + bMatches.join('\n') : pre3 + 'No matches found.';
        } catch (e) { return 'Error searching historical blob: ' + (e.message || e); }
    }

    // ★ 兼容：模型可能把 keywords 发成 JSON 字符串而非数组
    if (typeof args.keywords === 'string') {
        try { args.keywords = JSON.parse(args.keywords); } catch (_) {
            // 兼容管道符分隔: "foo|bar|baz" → ["foo","bar","baz"]
            if (args.keywords.includes('|')) {
                args.keywords = args.keywords.split('|').map(function(s) { return s.trim(); }).filter(Boolean);
            }
        }
    }
    if (!args.keywords || !Array.isArray(args.keywords) || args.keywords.length === 0) return 'Error: no keywords provided.';

    // Escape each keyword for regex and join with |
    var escapeRegex = function (s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };
    var pattern = args.keywords.map(escapeRegex).join('|');
    var maxResults = args.max_results || 30;
    var caseSensitive = args.case_sensitive === true;

    // When case-sensitive, skip IPC (main.ts always adds /i flag) and use renderer fallback
    if (caseSensitive || !(bridge.ai && bridge.ai.search_text)) {
        return await executeSearchText({ query: pattern, path: args.path, max_results: maxResults, case_sensitive: caseSensitive });
    }

    // Fast path: IPC to main process (case-insensitive only)
    try {
        return await bridge.ai.search_text({
            query: pattern,
            path: args.path || undefined,
            maxResults: maxResults
        });
    } catch (err) {
        return 'search_content error: ' + (err && err.message || err);
    }
}

// ============================================================
// list_files
// ============================================================

async function executeListFiles(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    args.path = args.path || args.filePath || '';
    var _p = args.path;
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — provide an absolute path.';
    }

    try {
        if (args.recursive) {
            // * 优先走主进程 (1 IPC, 消除 renderer IPC 洪水)
            if (bridge.ai && bridge.ai.list_files) {
                try {
                    return await bridge.ai.list_files({ path: args.path, maxResults: 200 });
                } catch (_) { /* fallback */ }
            }

            // ---- fallback: renderer walk (legacy) ----
            var entries = [];
            async function walk(dir, prefix) {
                var items;
                try { items = await bridge.fs.list(dir); } catch (_) { return; }
                if (!items) return;
                for (var i = 0; i < items.length; i++) {
                    if (entries.length >= 200) return;
                    var item = items[i];
                    if (item.name.startsWith('.') || item.name === 'node_modules' || SKIP_DIRS.indexOf(item.name) !== -1) continue;
                    var rel = prefix ? prefix + '/' + item.name : item.name;
                    entries.push(rel + (item.isDir ? '/' : ''));
                    if (item.isDir) await walk(dir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + item.name, rel);
                }
            }
            await walk(args.path, '');
            return entries.join('\n');
        } else {
            var items = await bridge.fs.list(args.path);
            return items.map(function (i) { return i.name + (i.isDir ? '/' : ''); }).join('\n');
        }
    } catch (err) {
        return 'Error listing files: ' + (err.message || err);
    }
}

// ============================================================
// get_vision_context
// ============================================================

async function executeGetVisionContext() {
    try {
        if (!parent.qqqideViewport) return 'No vision context available.';
        var vps = parent.qqqideViewport.getProjects();

        var panelRoot = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
        if (panelRoot) { panelRoot = panelRoot.replace(/\\/g, '/').replace(/\/$/, ''); }

        if (vps.length === 0 && !panelRoot) return 'No project folders in vision context.';

        var lines = ['=== Project Folders ==='];
        var mainFound = false;
        for (var i = 0; i < vps.length; i++) {
            var f = vps[i];
            var fPath = (f.path || '').replace(/\\/g, '/').replace(/\/$/, '');
            var isMain = panelRoot ? fPath === panelRoot : (i === 0);
            if (isMain) mainFound = true;
            if (isMain) {
                lines.push('⭐ ' + f.name + ' (' + f.path + ') ← MAIN PROJECT (default)');
            } else {
                lines.push('   ' + f.name + ' (' + f.path + ') ← auxiliary');
            }
        }
        if (!mainFound && panelRoot) {
            var name = panelRoot.split('/').pop() || panelRoot;
            lines.unshift('⭐ ' + name + ' (' + panelRoot + ') ← MAIN PROJECT (default)');
        }
        lines.push('');
        lines.push('Default to main project; user may specify any project.');
        return lines.join('\n');
    } catch (err) {
        return 'Error: ' + (err.message || err);
    }
}

// ============================================================
// find_files — glob 搜索
// ============================================================

function globToRegex(pattern) {
    var regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '___DOUBLESTAR___')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/___DOUBLESTAR___/g, '.*')
        .replace(/\?/g, '[^/\\\\]');
    return new RegExp('^' + regexStr + '$', 'i');
}

async function executeFindFiles(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    // ★ 参数别名
    args.pattern = args.pattern || args.glob || '';
    args.max_results = args.max_results || args.limit || 50;

    var searchDirs = [];
    var _findPath = args.path || args.filePath || args.directory || '';
    if (_findPath) {
        searchDirs = [_findPath];
    } else {
        try {
            if (parent.qqqideViewport) {
                var vps = parent.qqqideViewport.getProjects();
                searchDirs = vps.map(function (p) { return p.path; });
            }
        } catch (_) { }
    }
    if (searchDirs.length === 0) return 'Error: no search path specified.';

    var maxResults = args.max_results || 50;

    // * 优先走主进程 (1 IPC, 消除 renderer IPC 洪水)
    if (bridge.ai && bridge.ai.find_files) {
        try {
            return await bridge.ai.find_files({ pattern: args.pattern, paths: searchDirs, maxResults: maxResults });
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer walk (legacy) ----
    var regex = globToRegex(args.pattern);
    var matches = [];

    async function walk(dir, depth, baseDir) {
        if (depth > 8 || matches.length >= maxResults) return;
        var entries;
        try { entries = await bridge.fs.list(dir); } catch (_) { return; }
        if (!entries) return;
        for (var i = 0; i < entries.length && matches.length < maxResults; i++) {
            var ent = entries[i];
            if (ent.name.startsWith('.')) continue;
            if (ent.isDir && (ent.name === 'node_modules' || ent.name === '.git' || SKIP_DIRS.indexOf(ent.name) !== -1)) continue;
            var full = dir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + ent.name;
            var rel = baseDir ? full.slice(baseDir.length + 1) : full;
            if (regex.test(ent.name) || regex.test(rel)) {
                matches.push(full + (ent.isDir ? '/' : ''));
            }
            if (ent.isDir) await walk(full, depth + 1, baseDir);
        }
    }

    for (var d = 0; d < searchDirs.length && matches.length < maxResults; d++) {
        await walk(searchDirs[d], 0, searchDirs[d].replace(/\\/g, '/').replace(/\/$/, ''));
    }

    return matches.length > 0 ? matches.join('\n') : 'No files found.';
}

// ══════════════════════════════════════════════════════════════
// get_diagnostics — 轻量语法检查（node --check / py_compile / JSON.parse）
// 复用 _autoSyntaxCheck（tools-exec-write.js），不依赖 Monaco LSP。
// ══════════════════════════════════════════════════════════════

async function executeGetDiagnostics(args) {
    var path = args.path || args.filePath || '';

    // ★ sha256: 检查历史版本 blob 的语法（Timeline 集成）
    if (args.sha256) {
        if (!path) return 'Error: path required when using sha256 for get_diagnostics';
        var bridge = getBridge();
        if (!bridge) return 'Error: bridge not available';
        var root = await _resolveTimelineRoot(path);
        if (!root) return 'Error: could not resolve project root for "' + path + '"';
        if (!bridge.timeline || !bridge.timeline.content) return 'Error: timeline content not available';
        try {
            var blobC = await bridge.timeline.content({ projectRoot: root, blobHash: args.sha256 });
            if (blobC === null || blobC === undefined) return 'Error: blob not found for hash ' + args.sha256;
            var ext = path.split('.').pop().toLowerCase();
            var syn = _syntaxCheckInline(blobC, ext);
            if (syn) {
                return '[Historical blob sha=' + args.sha256.slice(0, 12) + '] ' + (syn.ok ? '✅ SYNTAX OK' : '⚠️ SYNTAX ERROR: ' + syn.msg);
            }
            return '[Historical blob sha=' + args.sha256.slice(0, 12) + '] No syntax check available for .' + ext + ' files';
        } catch (e) { return 'Error checking historical blob: ' + (e.message || e); }
    }

    if (!path) return 'Error: path required for get_diagnostics';
    if (typeof _autoSyntaxCheck === 'function') {
        try {
            var result = await _autoSyntaxCheck(path);
            return result || 'No syntax check available for this file type: ' + path;
        } catch (e) {
            return 'Error running syntax check: ' + (e.message || e);
        }
    }
    return 'Error: syntax checker not available';
}

// ============================================================
// fetch_webpage
// ============================================================
// ★ 两条路：主路走 Go 代理（US 服务器端 HTTP，绕过 GFW），兜底走本地 curl

async function executeFetchWebpage(args, ownerAgent) {
    var bridge = getBridge();

    // ★ 参数别名
    args.url = args.url || args.link || '';

    // ═══ 主路：走 Go 代理（US 服务器直连，可访问 GitHub 等） ═══
    if (typeof AiGateway !== 'undefined' && AiGateway.fetchWebpage) {
        try {
            var token = '';
            try {
                var ag = ownerAgent || ((typeof _activeAgent !== 'undefined') ? _activeAgent : null);
                if (ag && ag._token) token = ag._token;
            } catch (_) {}
            if (token) {
                var data = await AiGateway.fetchWebpage(args.url, { token: token });
                if (data && data.ok && data.text) {
                    // ★ 计费
                    if (data.ge_cost && typeof _addToolWgeCost === 'function') {
                        _addToolWgeCost(data.ge_cost);
                    }
                    // ★ Land to floor dir → sha256 reference for biscuit
                    var _stamp = await _landToFloorDir(data.text, 'web_fetch', ownerAgent);
                    return data.text + _stamp;
                }
                // 服务器失败→兜底本地 curl
                if (typeof console !== 'undefined') console.log('[fetch] Go proxy failed: ' + (data ? data.error : 'no data') + ', fallback to local curl');
            }
        } catch (_) {
            if (typeof console !== 'undefined') console.log('[fetch] Go proxy error, fallback to local curl');
        }
    }

    // ═══ 兜底：本地 curl（原有逻辑） ═══
    if (!bridge) return 'Error: bridge not available';
    try {
        var result = await bridge.qz.spawn({
            cmd: 'curl',
            args: ['-sL', '--max-time', '15', '-H', 'User-Agent: qqq-ai/1.0', args.url],
            timeout: 20000,
            shell: true
        });
        if (result.exitCode !== 0) {
            return 'Fetch error: exit ' + result.exitCode + ' — ' + (result.stderr || result.stdout || '').slice(0, OUTPUT_CAP_FETCH_ERR);
        }
        var html = result.stdout || '';
        if (!html.trim()) return '(empty response)';
        var text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        // ★ Land to floor dir → sha256 reference for biscuit
        var _stamp2 = await _landToFloorDir(text, 'web_fetch', ownerAgent);
        return text + _stamp2;
    } catch (err) {
        return 'Fetch error: ' + (err.message || err);
    }
}

// ============================================================
// timeline_versions — 列出文件在 project timeline 中的所有版本
// ============================================================

async function executeTimelineVersions(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    args.path = args.path || args.filePath || '';
    var _p = args.path;
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — provide an absolute path.';
    }

    if (!bridge.timeline || !bridge.timeline.versions) {
        return 'Error: timeline system not available (bridge.timeline missing)';
    }

    var root = await _resolveTimelineRoot(_p);
    if (!root) {
        return 'Error: could not resolve project root for "' + _p + '". No qqq/timeline or .git found in parent directories.';
    }

    try {
        var versions = await bridge.timeline.versions({ projectRoot: root, filePath: _p });
        if (!versions || versions.length === 0) {
            return 'No timeline versions found for: ' + _p;
        }
        var floorNum = args.floor_num;
        if (floorNum != null && typeof floorNum === 'number') {
            var needle = '/f' + floorNum + '/';
            versions = versions.filter(function(v) {
                return v.floor_id && v.floor_id.indexOf(needle) >= 0;
            });
            if (versions.length === 0) {
                return 'No timeline versions found for floor ' + floorNum + ' in: ' + _p;
            }
        }

        // ═══ Layer 2: Heuristic tags (always on, zero cost) ═══
        var ext = _p.split('.').pop().toLowerCase();
        var floorMaxSeq = _buildFloorMaxSeq(versions);
        var l2Tags = {}; // file_seq → heuristic tag
        for (var i = 0; i < versions.length; i++) {
            var tag = _heuristicTag(versions[i], floorMaxSeq);
            if (tag) l2Tags[versions[i].file_seq] = tag;
        }

        // ═══ Layer 3: Syntax check (opt-in via check_syntax=true) ═══
        var checkSyntax = args.check_syntax === true;
        var l3Tags = {}; // file_seq → syntax tag
        if (checkSyntax && (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'json')) {
            // Only check last N versions + all 🏁 final versions
            var toCheck = [];
            var seen = {};
            // Always include 🏁 final versions
            for (var i = 0; i < versions.length; i++) {
                if (l2Tags[versions[i].file_seq] === '🏁 final') { toCheck.push(versions[i]); seen[versions[i].file_seq] = true; }
            }
            // Fill up to _SYN_CHECK_MAX with most recent
            for (var i = versions.length - 1; i >= 0 && toCheck.length < _SYN_CHECK_MAX; i--) {
                if (!seen[versions[i].file_seq]) { toCheck.push(versions[i]); seen[versions[i].file_seq] = true; }
            }
            // Check in parallel (each reads its own blob)
            var checkResults = await Promise.all(toCheck.map(function(v) {
                return _checkOneVersion(bridge, root, v, ext).then(function(r) {
                    return { seq: v.file_seq, result: r };
                });
            }));
            for (var ci = 0; ci < checkResults.length; ci++) {
                var cr = checkResults[ci];
                if (cr && cr.result && cr.result.msg) {
                    l3Tags[cr.seq] = cr.result.ok ? '✅ clean' : '⚠️ ' + cr.result.msg.slice(0, 60);
                }
            }
        }

        // ═══ Build output ═══
        var lines = ['Timeline versions for: ' + _p, 'Project root: ' + root, ''];
        if (floorNum != null) lines[0] += ' (floor ' + floorNum + ' only)';
        var header = '#\ttime\t+/-\tquality\tsrc\ttrace\tsha';
        lines.push(header);

        var allTags = {}; // file_seq → combined tag
        for (var i = 0; i < versions.length; i++) {
            var v = versions[i];
            var seq = v.file_seq;
            var parts = [];
            if (l2Tags[seq]) parts.push(l2Tags[seq]);
            if (l3Tags[seq]) parts.push(l3Tags[seq]);
            allTags[seq] = parts.join(' ');

            var ts = v.ts ? new Date(v.ts).toISOString().replace('T', ' ').slice(0, 19) : '?';
            var add = v.added_lines != null ? ('+' + v.added_lines) : '?';
            var del = v.deleted_lines != null ? ('-' + v.deleted_lines) : '?';
            var trace = v.floor_id || '';
            lines.push('#' + seq + '\t' + ts + '\t' + add + '/' + del + '\t' + (allTags[seq] || '') + '\t' + (v.source || '?') + '\t' + (trace ? 'trace=' + trace : '—') + '\tsha=' + (v.blob_hash || '').slice(0, 12));
        }
        lines.push('');

        // ═══ Layer 5: Recommendation footer ═══
        var bestClean = _findBestClean(versions, allTags);
        if (bestClean) {
            var suffix = checkSyntax ? ' (syntax-verified)' : ' (heuristic — use check_syntax=true for accuracy)';
            lines.push('Best clean version: #' + bestClean.file_seq + suffix);
        }
        var badCount = 0;
        for (var i = 0; i < versions.length; i++) {
            var t = allTags[versions[i].file_seq];
            if (t && t.indexOf('⚠️') >= 0) badCount++;
        }
        if (badCount > 0) {
            lines.push(badCount + ' version(s) with ⚠️ quality issues detected.');
        }
        lines.push('');
        lines.push('Use diff_versions(path, from_seq, to_seq) to compare any two versions, or revert_file(path, file_seq) to restore.');
        return lines.join('\n');
    } catch (err) {
        return 'Error querying timeline: ' + (err.message || err);
    }
}

// ============================================================
// revert_file — 一键回退文件到指定 timeline 版本
// ============================================================

async function executeRevertFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    args.path = args.path || args.filePath || '';
    var _p = args.path;
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — provide an absolute path.';
    }
    var fileSeq = args.file_seq;
    if (fileSeq == null || typeof fileSeq !== 'number') {
        return 'Error: file_seq (number) required. Use timeline_versions first to find the version.';
    }

    if (!bridge.timeline || !bridge.timeline.versions || !bridge.timeline.content) {
        return 'Error: timeline system not available';
    }

    // ★ 解析项目根目录
    var root = await _resolveTimelineRoot(_p);
    if (!root) {
        return 'Error: could not resolve project root for "' + _p + '"';
    }

    try {
        // ① 查找目标版本的 blob_hash
        var versions = await bridge.timeline.versions({ projectRoot: root, filePath: _p });
        var target = null;
        for (var i = 0; i < versions.length; i++) {
            if (versions[i].file_seq === fileSeq) { target = versions[i]; break; }
        }
        if (!target) {
            return 'Error: file_seq ' + fileSeq + ' not found for "' + _p + '". Available: ' +
                versions.map(function(v) { return v.file_seq; }).join(', ');
        }

        // ② 读取历史内容
        var content = await bridge.timeline.content({ projectRoot: root, blobHash: target.blob_hash });
        if (content === null || content === undefined) {
            return 'Error: blob not found for hash ' + target.blob_hash + ' (blob file may be missing)';
        }

        // ③ 写回文件 — 直接用 bridge.fs.write（跳过 IPC 语法门）。
        //    revert 允许恢复语法不完整的中间态 blob，AI 自己修复。
        try { await bridge.fs.mkdir(_p.replace(/[/\\][^/\\]+$/, '')); } catch (_) { }
        await bridge.fs.write(_p, content);

        // ④ 通知 + 警告级语法检查（不阻止，A4 钩子自动记录 timeline 快照）
        _notifyFileModified(_p);
        var result = 'Reverted ' + _p + ' to version #' + fileSeq +
            ' (blob ' + target.blob_hash.slice(0, 12) + ', ' +
            new Date(target.ts).toISOString().replace('T', ' ').slice(0, 19) + ')';

        // 文件大小警告（内联，不调 _checkFileSizeWarn 以避免其内置语法检查）
        try {
            var lineCount = content.split('\n').length;
            if (lineCount > FILE_LINE_WARN) {
                result += '\n\n⚠️ FILE SIZE WARNING: This file now has ' + lineCount + ' lines (project limit: ' + FILE_LINE_WARN + '). Suggest splitting into smaller modules.';
            }
        } catch (_) { }

        // ═══ Layer 5: Post-revert quality report ═══
        // Check syntax of restored content inline + report adjacent versions
        var ext = _p.split('.').pop().toLowerCase();
        var synResult = _syntaxCheckInline(content, ext);
        if (synResult) {
            _synCache[target.blob_hash] = synResult;
            result += '\nSyntax: ' + (synResult.ok ? '✅ clean' : '⚠️ ' + synResult.msg.slice(0, 60));
        }
        // Heuristic tags for adjacent versions
        var floorMaxSeq = _buildFloorMaxSeq(versions);
        var laterCount = 0;
        var laterIssues = [];
        for (var vi = 0; vi < versions.length; vi++) {
            if (versions[vi].file_seq > fileSeq) {
                laterCount++;
                var l2 = _heuristicTag(versions[vi], floorMaxSeq);
                if (l2 && l2.indexOf('⚠️') >= 0) laterIssues.push('#' + versions[vi].file_seq + ' ' + l2);
            }
        }
        if (laterCount > 0) {
            result += '\nLater versions: ' + laterCount + ' total';
            if (laterIssues.length > 0) result += ' — issues: ' + laterIssues.join(', ');
        }
        // Best clean version hint
        var allTags = {};
        for (var vi = 0; vi < versions.length; vi++) {
            var l2 = _heuristicTag(versions[vi], floorMaxSeq);
            if (l2) {
                var syn = _synCache[versions[vi].blob_hash];
                allTags[versions[vi].file_seq] = l2 + (syn ? (syn.ok ? ' ✅ clean' : ' ⚠️ ' + syn.msg.slice(0, 30)) : '');
            }
        }
        var best = _findBestClean(versions, allTags);
        if (best && best.file_seq !== fileSeq) {
            result += '\nHint: A cleaner version exists — #' + best.file_seq;
        }
        return result;
    } catch (err) {
        return 'Error reverting file: ' + (err.message || err);
    }
}

// ============================================================
// diff_versions — 计算两个 timeline 版本之间的 unified diff
// ============================================================

async function executeDiffVersions(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    args.path = args.path || args.filePath || '';
    var _p = args.path;
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — provide an absolute path.';
    }
    var fromSeq = args.from_seq;
    if (fromSeq == null || typeof fromSeq !== 'number') {
        return 'Error: from_seq (number) required. Use timeline_versions first.';
    }
    var toSeq = args.to_seq; // optional — defaults to current disk

    if (!bridge.timeline || !bridge.timeline.versions || !bridge.timeline.content) {
        return 'Error: timeline system not available';
    }

    var root = await _resolveTimelineRoot(_p);
    if (!root) {
        return 'Error: could not resolve project root for "' + _p + '"';
    }

    try {
        // ① 获取所有版本
        var versions = await bridge.timeline.versions({ projectRoot: root, filePath: _p });
        if (!versions || versions.length === 0) {
            return 'No timeline versions found for: ' + _p;
        }

        // ② 查找 from 版本
        var fromVer = null;
        for (var i = 0; i < versions.length; i++) {
            if (versions[i].file_seq === fromSeq) { fromVer = versions[i]; break; }
        }
        if (!fromVer) {
            return 'Error: file_seq ' + fromSeq + ' not found. Available: ' +
                versions.map(function(v) { return v.file_seq; }).join(', ');
        }

        // ③ 获取 from 内容
        var fromContent = await bridge.timeline.content({ projectRoot: root, blobHash: fromVer.blob_hash });
        if (fromContent === null || fromContent === undefined) {
            return 'Error: blob not found for from_seq ' + fromSeq + ' (hash ' + fromVer.blob_hash.slice(0, 12) + ')';
        }

        // ④ 获取 to 内容（可选：默认当前磁盘）
        var toContent, toLabel;
        if (toSeq != null) {
            var toVer = null;
            for (var j = 0; j < versions.length; j++) {
                if (versions[j].file_seq === toSeq) { toVer = versions[j]; break; }
            }
            if (!toVer) {
                return 'Error: file_seq ' + toSeq + ' not found. Available: ' +
                    versions.map(function(v) { return v.file_seq; }).join(', ');
            }
            toContent = await bridge.timeline.content({ projectRoot: root, blobHash: toVer.blob_hash });
            if (toContent === null || toContent === undefined) {
                return 'Error: blob not found for to_seq ' + toSeq;
            }
            toLabel = '#' + toSeq + ' ' + new Date(toVer.ts).toISOString().replace('T', ' ').slice(0, 19);
        } else {
            // 读当前磁盘
            try {
                if (bridge.ai && bridge.ai.read_file) {
                    toContent = await bridge.ai.read_file({ path: _p, start_line: 1, end_line: 99999 });
                } else {
                    toContent = await bridge.fs.read(_p);
                }
            } catch (_) {
                return 'Error: cannot read current disk content for ' + _p;
            }
            toLabel = 'current disk';
        }

        // ⑤ 计算 unified diff
        var fromLines = fromContent.split('\n');
        var toLines = toContent.split('\n');
        // 行尾归一化
        for (var fi = 0; fi < fromLines.length; fi++) {
            if (fromLines[fi].charCodeAt(fromLines[fi].length - 1) === 13) fromLines[fi] = fromLines[fi].slice(0, -1);
        }
        for (var ti = 0; ti < toLines.length; ti++) {
            if (toLines[ti].charCodeAt(toLines[ti].length - 1) === 13) toLines[ti] = toLines[ti].slice(0, -1);
        }

        // ═══ Layer 3: Syntax preamble ═══
        var ext = _p.split('.').pop().toLowerCase();
        var synPreamble = '';
        if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'json') {
            var fromSyn = _syntaxCheckInline(fromContent, ext);
            if (fromSyn) { _synCache[fromVer.blob_hash] = fromSyn; synPreamble += '## Syntax #' + fromSeq + ': ' + (fromSyn.ok ? '✅ clean' : '⚠️ ' + fromSyn.msg.slice(0, 60)) + '\n'; }
            if (toSeq != null && toVer && toContent !== null) {
                var toSyn = _syntaxCheckInline(toContent, ext);
                if (toSyn) { _synCache[toVer.blob_hash] = toSyn; synPreamble += '## Syntax #' + toSeq + ': ' + (toSyn.ok ? '✅ clean' : '⚠️ ' + toSyn.msg.slice(0, 60)) + '\n'; }
            }
        }

        var fromTs = new Date(fromVer.ts).toISOString().replace('T', ' ').slice(0, 19);
        var header = synPreamble + '--- ' + _p + '\t(version #' + fromSeq + ', ' + fromTs + ')\n' +
            '+++ ' + _p + '\t(' + toLabel + ')\n';
        var diff = _computeUnifiedDiff(fromLines, toLines, 3);

        // ★ ± line count summary for biscuit
        var addedLines = 0, deletedLines = 0;
        if (diff) {
            var dlines = diff.split('\n');
            for (var di = 0; di < dlines.length; di++) {
                var ch0 = dlines[di].charAt(0);
                if (ch0 === '+' && dlines[di].charAt(1) !== '+') addedLines++;
                else if (ch0 === '-' && dlines[di].charAt(1) !== '-') deletedLines++;
            }
        }
        var statLine = '+N=' + addedLines + ' -M=' + deletedLines;

        if (!diff || diff.trim() === '') return header + '(no differences)\n' + statLine;
        return header + diff + '\n' + statLine;
    } catch (err) {
        return 'Error computing diff: ' + (err.message || err);
    }
}

// ---- 简单 unified diff（基于行数组，context=3）----
function _computeUnifiedDiff(a, b, context) {
    context = context || 3;
    // 计算 LCS 表
    var m = a.length, n = b.length;
    // ★ 大文件保护：超过 5000 行走近似 diff
    if (m * n > 25000000) {
        return _computeApproxDiff(a, b);
    }
    var lcs = _computeLcsTable(a, b);
    // 回溯产生编辑序列
    var edits = _backtrackEdits(lcs, a, b, m, n);
    // 生成 unified diff hunks
    return _formatHunks(edits, context);
}

function _computeLcsTable(a, b) {
    var m = a.length, n = b.length;
    var dp = new Array(m + 1);
    for (var i = 0; i <= m; i++) { dp[i] = new Array(n + 1).fill(0); }
    for (var i = 1; i <= m; i++) {
        for (var j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    return dp;
}

function _backtrackEdits(dp, a, b, i, j) {
    var edits = []; // {type:'eq'|'del'|'add', line:string}
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            edits.unshift({ type: 'eq', line: a[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            edits.unshift({ type: 'add', line: b[j - 1] });
            j--;
        } else {
            edits.unshift({ type: 'del', line: a[i - 1] });
            i--;
        }
    }
    return edits;
}

function _formatHunks(edits, context) {
    // 找出所有差异块
    var diffIdxs = [];
    for (var i = 0; i < edits.length; i++) {
        if (edits[i].type !== 'eq') diffIdxs.push(i);
    }
    if (diffIdxs.length === 0) return '';

    // 扩展 context
    var hunkRanges = [];
    var start = Math.max(0, diffIdxs[0] - context);
    var end = Math.min(edits.length - 1, diffIdxs[0] + context);
    for (var d = 1; d < diffIdxs.length; d++) {
        if (diffIdxs[d] - context <= end + context + 1) {
            // merge overlapping
            end = Math.min(edits.length - 1, diffIdxs[d] + context);
        } else {
            hunkRanges.push([start, end]);
            start = Math.max(0, diffIdxs[d] - context);
            end = Math.min(edits.length - 1, diffIdxs[d] + context);
        }
    }
    hunkRanges.push([start, end]);

    var result = '';
    var aLine = 1, bLine = 1;
    var prevEnd = 0;
    for (var h = 0; h < hunkRanges.length; h++) {
        var hs = hunkRanges[h][0], he = hunkRanges[h][1];
        // count a/b line numbers up to hs
        for (var k = prevEnd; k < hs; k++) {
            if (edits[k].type !== 'add') aLine++;
            if (edits[k].type !== 'del') bLine++;
        }
        prevEnd = hs;

        // compute hunk header stats
        var haStart = aLine, hbStart = bLine;
        var haCount = 0, hbCount = 0;
        for (var k = hs; k <= he; k++) {
            if (edits[k].type !== 'add') haCount++;
            if (edits[k].type !== 'del') hbCount++;
        }
        result += '@@ -' + haStart + ',' + haCount + ' +' + hbStart + ',' + hbCount + ' @@\n';

        for (var k = hs; k <= he; k++) {
            if (edits[k].type === 'eq') {
                result += ' ' + edits[k].line + '\n';
                aLine++; bLine++;
            } else if (edits[k].type === 'del') {
                result += '-' + edits[k].line + '\n';
                aLine++;
            } else {
                result += '+' + edits[k].line + '\n';
                bLine++;
            }
        }
    }
    return result;
}

// ---- 大文件近似 diff（>5000 行，用唯一行匹配代替 DP）----
function _computeApproxDiff(a, b) {
    var bSet = {};
    for (var i = 0; i < b.length; i++) { bSet[b[i]] = (bSet[b[i]] || 0) + 1; }
    var aOnly = [], bOnly = [];
    var bUsed = {};
    for (var i = 0; i < a.length; i++) {
        if (bSet[a[i]] && bSet[a[i]] > (bUsed[a[i]] || 0)) {
            bUsed[a[i]] = (bUsed[a[i]] || 0) + 1;
        } else {
            aOnly.push(i);
        }
    }
    var aUsed = {};
    for (var j = 0; j < a.length; j++) {
        if (bSet[a[j]]) aUsed[a[j]] = (aUsed[a[j]] || 0) + 1;
    }
    for (var j = 0; j < b.length; j++) {
        if (!aUsed[b[j]] || aUsed[b[j]] <= 0) {
            bOnly.push(j);
        } else {
            aUsed[b[j]]--;
        }
    }

    // 简化输出：合并连续行
    var lines = '';
    var ai = 0, bi = 0, aOnlyIdx = 0, bOnlyIdx = 0;
    while (ai < a.length || bi < b.length) {
        // 跳过 a 中不在 b 中的连续行 → -
        var delStart = ai;
        while (aOnlyIdx < aOnly.length && aOnly[aOnlyIdx] === ai) { ai++; aOnlyIdx++; }
        if (ai > delStart) {
            lines += '@@ -' + (delStart + 1) + ',' + (ai - delStart) + ' +' + (bi + 1) + ',0 @@\n';
            for (var d = delStart; d < ai; d++) lines += '-' + a[d] + '\n';
        }
        // 跳过 b 中不在 a 中的连续行 → +
        var addStart = bi;
        while (bOnlyIdx < bOnly.length && bOnly[bOnlyIdx] === bi) { bi++; bOnlyIdx++; }
        if (bi > addStart) {
            lines += '@@ -' + (ai + 1) + ',0 +' + (addStart + 1) + ',' + (bi - addStart) + ' @@\n';
            for (var ad = addStart; ad < bi; ad++) lines += '+' + b[ad] + '\n';
        }
        // 公共行
        if (ai < a.length && bi < b.length && a[ai] === b[bi]) {
            ai++; bi++;
        } else if (ai < a.length && bi < b.length) {
            // 不对齐→各自前进一行（近似）
            lines += '@@ -' + (ai + 1) + ',1 +' + (bi + 1) + ',1 @@\n';
            lines += '-' + a[ai] + '\n';
            lines += '+' + b[bi] + '\n';
            ai++; bi++;
        } else if (ai < a.length) {
            lines += '@@ -' + (ai + 1) + ',' + (a.length - ai) + ' +' + (bi + 1) + ',0 @@\n';
            while (ai < a.length) { lines += '-' + a[ai] + '\n'; ai++; }
        } else if (bi < b.length) {
            lines += '@@ -' + (ai + 1) + ',0 +' + (bi + 1) + ',' + (b.length - bi) + ' @@\n';
            while (bi < b.length) { lines += '+' + b[bi] + '\n'; bi++; }
        }
    }
    return lines;
}

// ═══ 辅助：从文件路径向上解析项目根目录（找 qqq/timeline 或 .git） ═══
var __tlRootCache = {};
async function _resolveTimelineRoot(filePath) {
    if (!filePath) {
        return (typeof questStore !== 'undefined' && questStore.getProjectRoot)
            ? questStore.getProjectRoot().replace(/\\/g, '/').replace(/\/$/, '') : null;
    }
    var fp = filePath.replace(/\\/g, '/');
    if (__tlRootCache[fp]) return __tlRootCache[fp];

    var bridge = getBridge();
    var dir = fp.replace(/\/[^\/]*$/, '');
    for (var depth = 0; depth < 12 && dir && dir.length > 3; depth++) {
        try {
            var st = await bridge.fs.stat(dir + '/qqq/timeline');
            if (st && st.isDir) { __tlRootCache[fp] = dir; return dir; }
        } catch (_) { }
        try {
            var st2 = await bridge.fs.stat(dir + '/.git');
            if (st2 && st2.isDir) { __tlRootCache[fp] = dir; return dir; }
        } catch (_) { }
        dir = dir.replace(/\/[^\/]*$/, '');
    }
    var fallback = (typeof questStore !== 'undefined' && questStore.getProjectRoot)
        ? questStore.getProjectRoot().replace(/\\/g, '/').replace(/\/$/, '') : null;
    __tlRootCache[fp] = fallback;
    return fallback;
}
