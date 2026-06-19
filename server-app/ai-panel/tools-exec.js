// ============================================================================
// tools-exec.js — 工具执行引擎（READ 类 + 调度中心）
// 从 tools.js 拆分而来。WRITE 类见 tools-exec-write.js，EFFECT 类见 tools-exec-effect.js
// ============================================================================

// ---- 目录/扩展名跳过列表（供 search_text / list_files / find_files 使用）----
var SKIP_DIRS = ['node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs', 'cache', 'temp', 'crashDumps'];
var SKIP_EXTS = ['.exe', '.dll', '.so', '.dylib', '.bin', '.pyd', '.pyc', '.pyo', '.class', '.o', '.obj', '.lib', '.a', '.sys', '.drv', '.ocx', '.scr', '.cab', '.msi', '.msc', '.cpl', '.lnk', '.dat', '.pak', '.res', '.resources', '.rom', '.elf', '.ko', '.mod', '.dex', '.jar', '.war', '.ear', '.apk', '.ipa', '.iso', '.img', '.dmg', '.pkg', '.deb', '.rpm', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp', '.svgz', '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.zip', '.tar', '.gz', '.xz', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.icns', '.vsix', '.lock', '.wasm', '.map', '.tsbuildinfo', '.sq3', '.db', '.sqlite', '.sqlite3', '.sdb'];

// ============================================================
// 工具执行分发
// ============================================================

async function executeTool(name, args) {
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
        case 'fetch_webpage': _result = executeFetchWebpage(args); break;
        case 'get_diagnostics': _result = executeGetDiagnostics(args); break;
        case 'write_file': _result = executeWriteFile(args); break;
        case 'generate_image': _result = executeGenerateImage(args); break;
        case 'analyze_image': _result = executeAnalyzeImage(args); break;
        case 'search_smart': _result = executeSearchSmart(args); break;
        case 'search_web': _result = executeSearchWeb(args); break;
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

    // ★ 参数名兼容：Qoder/DeepSeek 可能用 filePath 而非 path
    args.path = args.path || args.filePath || '';
    // ★ 路径合理性校验：防止 AI 将中文文本当作文件路径
    var _p = args.path;
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — does not appear to be a valid file path. Provide an absolute path (e.g. E:\\project\\file.js).';
    }

    // ★ 同楼层去重：按行范围智能去重——防模型微调 start_line/end_line 绕过
    //    全文读（无 start/end）→ 标记文件已全覆盖 → 后续任何范围都挡。
    //    分段读（有 start/end）→ 只挡已覆盖范围，新范围放行。20 次/文件硬封顶。
    //    写入感知：edit_file/create_file/delete_file/write_file 成功后自动重置该文件追踪。
    //    计数器由 agent-loop.js 在每层楼开始时清零 (window._qqqReadFilesThisFloor = {})
    var _normPath = _p.replace(/\\/g, '/').toLowerCase();
    var _tracker = (typeof window !== 'undefined') ? window._qqqReadFilesThisFloor : null;
    if (_tracker) {
        // ★ ENOENT 缓存：文件不存在 → 同路径永生不复读（不管行范围）。防 AI 被截断路径坑 10 次
        var _enoCache = window._qqqEnoentCache;
        if (_enoCache && _enoCache[_normPath]) {
            return '[FILE NOT FOUND] ' + _normPath + ' — 该文件在本层楼已确认不存在，请勿重试。检查路径是否有截断或中文字符。';
        }
        var _rec = _tracker[_normPath];
        if (!_rec) { _rec = { f: false, r: [], c: 0, b: 0 }; _tracker[_normPath] = _rec; }
        _rec.c++;

        // 硬封顶：同一文件在本层楼读 20 次以上 → 无条件拦
        if (_rec.c > 20) {
            return '[ALREADY READ] 文件 ' + args.path + ' 在本层楼已读过 ' + (_rec.c - 1) + ' 次，已达上限。请基于已有信息继续分析。';
        }

        var _sl = args.start_line || 0;
        var _el = args.end_line || 0;
        var _isFull = (!args.start_line && !args.end_line);  // 全文读

        // ★ 治根：阻 2 次 → 第 3 次放行 → 永久解冻（上下文丢失是一次性的，证明确实忘了就停止阻拦）
        if (_rec.f) {
            if (!_isFull) {
                // 全文读过后请求分段读 → 检查范围
                var _reqStart = _sl;
                var _reqEnd = _el || (_sl + 2999);
                var _alreadyCovered = false;
                for (var _ri = 0; _ri < _rec.r.length; _ri++) {
                    var _rr = _rec.r[_ri];
                    if (_rr[0] <= _reqStart && _rr[1] >= _reqEnd) {
                        _alreadyCovered = true;
                        break;
                    }
                }
                if (_alreadyCovered) {
                    if (!_rec.thawed) {
                        _rec.b++;
                        if (_rec.b >= 3) {
                            _rec.thawed = true;  // ★ 永久解冻：AI 已证明上下文丢失，后续不再阻拦
                        } else {
                            return '[ALREADY READ] 文件 ' + args.path + ' L' + _reqStart + '-' + _reqEnd + ' 已读过（第 ' + _rec.b + ' 次阻拦）。若上下文丢失请换更大行范围重读，或继续分析已有内容。';
                        }
                    }
                }
            } else {
                // 再次全文读 → 阻拦但有阶梯
                if (!_rec.thawed) {
                    _rec.b++;
                    if (_rec.b >= 3) {
                        _rec.thawed = true;  // ★ 永久解冻
                    } else {
                        return '[ALREADY READ] 文件 ' + args.path + ' 已全文读过（第 ' + _rec.b + ' 次阻拦）。若上下文丢失，请用 start_line/end_line 读你缺失的具体段落。';
                    }
                }
            }
        }

        if (_isFull) {
            // 全文读 → 标记全覆盖
            _rec.f = true;
            _rec.r = [[1, 999999]];
        } else {
            // 分段读 → 记录范围
            var _reqStart = _sl;
            var _reqEnd = _el || (_sl + 2999);
            // 合并范围
            _rec.r.push([_reqStart, _reqEnd]);
            _rec.r.sort(function (a, b) { return a[0] - b[0]; });
            var _merged = [];
            for (var _mi = 0; _mi < _rec.r.length; _mi++) {
                var _cur = _rec.r[_mi];
                if (_merged.length === 0 || _merged[_merged.length - 1][1] < _cur[0] - 1) {
                    _merged.push([_cur[0], _cur[1]]);
                } else {
                    _merged[_merged.length - 1][1] = Math.max(_merged[_merged.length - 1][1], _cur[1]);
                }
            }
            _rec.r = _merged;
            if (_merged.length === 1 && _merged[0][0] <= 1 && _merged[0][1] >= 999999) {
                _rec.f = true;
            }
        }
    }

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
                } catch (_) { /* 父目录不可列则跳过 */ }
            }
            // 无法匹配 → 缓存，永不复读
            if (!window._qqqEnoentCache) window._qqqEnoentCache = {};
            window._qqqEnoentCache[_normPath] = true;
        }
        return _errMsg;
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
    var reFlags = args.case_sensitive ? '' : 'i';
    try {
        regex = new RegExp(args.query, reFlags);
    } catch (_) {
        regex = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), reFlags);
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

    return matches.length > 0 ? matches.join('\n') : 'No matches found.';
}

// ============================================================
// search_content — multi-keyword OR search (literal strings, auto-escaped)
// ============================================================

async function executeSearchContent(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';
    // ★ 兼容：模型可能把 keywords 发成 JSON 字符串而非数组
    if (typeof args.keywords === 'string') {
        try { args.keywords = JSON.parse(args.keywords); } catch (_) { }
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

    var searchDirs = [];
    var _findPath = args.path || args.filePath || '';
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

// ============================================================
// get_diagnostics — LSP/compiler markers from Monaco
// ============================================================

async function executeGetDiagnostics(args) {
    try {
        var monaco = null;
        if (parent.qqqEditor && parent.qqqEditor.getMonaco) {
            monaco = parent.qqqEditor.getMonaco();
        }
        if (!monaco) return 'Error: Monaco not available';

        var allMarkers = monaco.editor.getModelMarkers({});
        var path = args.path || args.filePath || '';
        var normPath = path.replace(/\\/g, '/').toLowerCase();

        var filtered = allMarkers.filter(function (m) {
            if (!normPath) return true;
            var mp = (m.resource && m.resource.path) ? m.resource.path.replace(/\\/g, '/').toLowerCase() : '';
            return mp.indexOf(normPath) >= 0 || normPath.indexOf(mp) >= 0;
        });

        if (filtered.length === 0) return normPath ? 'No diagnostics for: ' + path : 'No diagnostics in any open file.';

        var severityMap = { 1: 'HINT', 2: 'INFO', 4: 'WARN', 8: 'ERROR' };
        var lines = [];
        for (var i = 0; i < filtered.length; i++) {
            var m = filtered[i];
            var sev = severityMap[m.severity] || '?';
            var file = (m.resource && m.resource.path) ? m.resource.path.replace(/.*[/\\]/, '') : '?';
            var pos = 'L' + m.startLineNumber + ':' + m.startColumn;
            lines.push('[' + sev + '] ' + file + ' ' + pos + ' — ' + m.message);
            if (lines.length >= 100) { lines.push('... (' + (filtered.length - 100) + ' more)'); break; }
        }
        return lines.join('\n');
    } catch (err) {
        return 'Error getting diagnostics: ' + (err.message || err);
    }
}

// ============================================================
// fetch_webpage
// ============================================================

async function executeFetchWebpage(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';
    try {
        // Route through main process (qz-spawn curl) to bypass CORS.
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
        return text.length > OUTPUT_CAP_FETCH ? text.slice(0, OUTPUT_CAP_FETCH) + '\n... (truncated)' : text;
    } catch (err) {
        return 'Fetch error: ' + (err.message || err);
    }
}
