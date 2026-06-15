// ============================================================================
// tools.js — AI 工具定义 + 执行引擎
// 从 q3/ai/src/tools.js 移植，适配 Shell v2 Electron 环境
// 工具通过 parent.qqqideBridge 访问文件系统/命令行
// ============================================================================

// ---- 获取 bridge（iframe 内通过 parent 访问）----
function getBridge() {
    try { return parent.qqqideBridge; } catch (_) { return null; }
}

// ---- 跨面板写通知：写成功后登记到父窗口环形缓冲区 ----
function _notifyFileModified(filePath) {
    try {
        var p = window.parent || window;
        if (p.__qqq_fileModified && typeof _panelId !== 'undefined') {
            p.__qqq_fileModified(filePath, _panelId);
        }
    } catch (_) { }
}

// ============================================================
// ★ Output caps — single source of truth for AI-facing limits
//
// Two-tier architecture:
//   SAFETY NET  (ghrun/qz-spawn): 65536 — prevents memory blowup, never active
//   AI FACING  (here):           defined below — what the AI sees & interacts with
//
// ============================================================
// ★ AI-facing output caps — 唯一真理在 ContentGateway（content-gateway.js）
//   此处为兼容旧引用的别名；所有新代码应直接使用 ContentGateway.OUTPUT_CAP_*
//   fetch 相关常量仅在 web fetch 场景使用，独立于 ContentGateway
// ============================================================
var OUTPUT_CAP_DEFAULT = (typeof ContentGateway !== 'undefined' ? ContentGateway.OUTPUT_CAP_DEFAULT : 8000);
var OUTPUT_CAP_MAX = (typeof ContentGateway !== 'undefined' ? ContentGateway.OUTPUT_CAP_MAX : 65536);
var OUTPUT_CAP_FETCH = 8000;     // web fetch text extraction limit (fetch 专用)
var OUTPUT_CAP_FETCH_ERR = 500;  // web fetch error message limit (fetch 专用)
var FILE_LINE_WARN = 1500;       // warn AI when edited/created file exceeds this threshold

// ---- 文件行数警告：写操作成功后检查文件行数，超限追加提醒 ----
async function _checkFileSizeWarn(result, filePath) {
    if (!result || result.indexOf('Error') === 0) return result;
    try {
        var bridge = getBridge();
        if (!bridge) return result;
        var content;
        if (bridge.ai && bridge.ai.read_file) {
            content = await bridge.ai.read_file({ path: filePath, start_line: 1, end_line: 99999 });
        } else {
            content = await bridge.fs.read(filePath);
        }
        if (typeof content === 'string') {
            var lineCount = content.split('\n').length;
            if (lineCount > FILE_LINE_WARN) {
                result += '\n\n\u26a0\ufe0f FILE SIZE WARNING: This file now has ' + lineCount + ' lines (project limit: ' + FILE_LINE_WARN + '). Suggest splitting into smaller modules.';
            }
        }
    } catch (_) { }
    return result;
}

// ---- \n escape corruption detection: if match failed and find contains literal \n, suggest \x0a workaround ----
function _maybeHintBackslashN(result, edits) {
    if (!result || result.indexOf('match failed') === -1) return result;
    if (!edits || edits.length === 0) return result;
    for (var i = 0; i < edits.length; i++) {
        if (edits[i].find && edits[i].find.indexOf('\\n') !== -1) {
            return result + '\n\n\u{d83d}\u{dca1} HINT: Your find pattern contains literal \\n (backslash-n). edit_file may have corrupted it to an actual newline, causing the match to fail. Retry with \\x0a (hex escape for newline) instead — \\x0a passes through the tool uncorrupted.';
        }
    }
    return result;
}

// ============================================================
// 工具定义（OpenAI function calling format）
// ============================================================

var TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read file contents. Fast single-IPC, memory-safe. For large files (>500 lines), use start_line/end_line to paginate.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    start_line: { type: 'number', description: 'Start line number (1-based, default 1)' },
                    end_line: { type: 'number', description: 'End line number (inclusive, default start+500)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Edit a file with one or more search-and-replace operations. All edits applied atomically (all succeed or none). 3-tier whitespace-tolerant matching. No confirmation needed. Single IPC to main process.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    edits: {
                        type: 'array',
                        description: 'Array of edit operations, applied in order',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Exact text to find (unique substring in the file)' },
                                replace: { type: 'string', description: 'Text to replace with' },
                                replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false, first only)' }
                            },
                            required: ['find', 'replace']
                        }
                    }
                },
                required: ['path', 'edits']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_text',
            description: 'Search for text across workspace files using regex pattern. 10x faster and memory-safe vs shell commands. Supports | for OR (e.g. "foo|bar|baz"). Use this instead of run_command for any code search.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search pattern (regex supported)' },
                    path: { type: 'string', description: 'Directory to search in (optional)' },
                    max_results: { type: 'number', description: 'Max results to return (default 30)' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_content',
            description: 'Multi-keyword OR search. Takes an array of literal strings, auto-escapes them, and searches all at once. Case-insensitive by default; set case_sensitive=true for exact-case matching. 10x faster and memory-safe vs shell. Use this when you need to find any of several keywords (e.g. ["qqqideBridge", "QQQIDE_URL", "qqqShell"]).',
            parameters: {
                type: 'object',
                properties: {
                    keywords: { type: 'array', items: { type: 'string' }, description: 'Array of literal keywords to search for (OR-combined)' },
                    path: { type: 'string', description: 'Directory to search in (optional)' },
                    max_results: { type: 'number', description: 'Max results to return (default 30)' },
                    case_sensitive: { type: 'boolean', description: 'Enable case-sensitive matching (default false = case-insensitive)' }
                },
                required: ['keywords']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_files',
            description: 'List files in a directory. Flat or recursive. 200-item cap for recursive. Memory-safe, 10x faster than shell.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to directory' },
                    recursive: { type: 'boolean', description: 'List recursively (default false)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_vision_context',
            description: 'Get the current qqq Vision scope: which project folders AI can see, and their top-level structure',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_file',
            description: 'Create a new file with given content. Auto-creates parent directories. Fails if file already exists (use edit_file to modify). Single IPC.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path for the new file' },
                    content: { type: 'string', description: 'File content to write' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command. Returns stdout+stderr. Output truncated to ' + OUTPUT_CAP_DEFAULT + ' chars by default. When you need full output (e.g. large file listings, long logs), pass maxOutput to request up to ' + OUTPUT_CAP_MAX + '. Hard timeout 2h, stall guard 15min. Use cwd to set working directory. ⚠️ PREFER search_text/search_content/find_files for code search — they are 10x faster and memory-safe. Only use run_command when dedicated tools CANNOT do the job.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to execute' },
                    cwd: { type: 'string', description: 'Working directory (optional)' },
                    maxOutput: { type: 'number', description: 'Override output char limit (default ' + OUTPUT_CAP_DEFAULT + ', max ' + OUTPUT_CAP_MAX + '). Use only when certain you need the full output.' },
                    reason: { type: 'string', description: 'Optional: briefly explain why dedicated tools (search_text/search_content/find_files) cannot do this job. Used only for audit logging.' }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description: 'Delete a file. Fails if file does not exist (safe — won\'t silently succeed on typos). Single IPC.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file to delete' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Search for files by name pattern (glob like *.js, config/*.json). Memory-safe, 10x faster than shell. Returns matching file paths. Default 50 max results.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern to match filenames' },
                    path: { type: 'string', description: 'Directory to search in (optional)' },
                    max_results: { type: 'number', description: 'Max results (default 50)' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fetch_webpage',
            description: 'Fetch and extract text content from a URL. CORS-bypass via curl backend, 15s timeout. Strips HTML tags, returns plain text ≤8000 chars.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to fetch' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_diagnostics',
            description: 'Get LSP/compiler diagnostics (errors, warnings, hints) for a file or all open files. Returns the same red/yellow squiggles you see in the IDE. Max 100 markers returned.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to get diagnostics for (optional; omit for all open files)' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Overwrite an existing file with new content. Creates parent directories if needed. Unlike edit_file, this replaces the ENTIRE file content.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    content: { type: 'string', description: 'New file content' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'generate_image',
            description: 'Generate high-quality PNG images using Alibaba Tongyi Wanxiang (wanx2.1-t2i-plus). Use this for website hero images, product photos, illustrations, logos, etc. Supports multiple styles. Images are saved locally and returned as file paths. ~15-40s per image.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Image description in natural language (Chinese or English)' },
                    style: { type: 'string', description: 'Style tag: 写实(photorealistic)/插画(illustration)/3d(3D render)/二次元(anime)/水彩(watercolor)/国风(Chinese trad)/极简(minimalist)/电商(e-commerce product)/自然(nature photo)' },
                    size: { type: 'string', description: 'Image size: "1024*1024" (square, default), "720*1280" (portrait), "1280*720" (landscape)' },
                    n: { type: 'number', description: 'Number of images to generate (1-4, default 1)' },
                    out_dir: { type: 'string', description: 'Output directory for generated images (absolute path). Default: current project\'s server-app/generated/' }
                },
                required: ['prompt']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'analyze_image',
            description: 'Analyze an existing image using qwen-vl vision model. Can: describe image content, locate objects with bounding boxes (for clickable image maps), or answer questions about the image. Use when user wants interactive images or needs to understand generated image content.',
            parameters: {
                type: 'object',
                properties: {
                    image: { type: 'string', description: 'Absolute path to the image file to analyze' },
                    action: { type: 'string', description: 'Analysis action: "describe" (describe content), "locate" (find objects + return bounding boxes), "ask" (free-form question)' },
                    detail: { type: 'string', description: 'For action=describe: "brief" (1 sentence), "standard" (paragraph), "detailed" (full analysis)' },
                    targets: { type: 'string', description: 'For action=locate: comma-separated object names to find, e.g. "frog,lotus,leaf"' },
                    question: { type: 'string', description: 'For action=ask: the question to ask about the image' }
                },
                required: ['image', 'action']
            }
        }
    }
];

// ============================================================
// 工具分类（用于并行执行调度）
// ============================================================

var TOOL_CATEGORY = {
    read_file: 'READ', search_text: 'READ', search_content: 'READ', list_files: 'READ',
    find_files: 'READ', get_vision_context: 'READ', fetch_webpage: 'READ',
    get_diagnostics: 'READ',
    edit_file: 'WRITE', create_file: 'WRITE', delete_file: 'WRITE', write_file: 'WRITE',
    run_command: 'EFFECT',
    generate_image: 'EFFECT', analyze_image: 'EFFECT'
};

// ============================================================
// 工具执行分发
// ============================================================

async function executeTool(name, args) {
    switch (name) {
        case 'read_file': return executeReadFile(args);
        case 'edit_file': return executeEditFile(args);
        case 'search_text': return executeSearchText(args);
        case 'search_content': return executeSearchContent(args);
        case 'list_files': return executeListFiles(args);
        case 'get_vision_context': return executeGetVisionContext();
        case 'create_file': return executeCreateFile(args);
        case 'run_command': return executeRunCommand(args);
        case 'delete_file': return executeDeleteFile(args);
        case 'find_files': return executeFindFiles(args);
        case 'fetch_webpage': return executeFetchWebpage(args);
        case 'get_diagnostics': return executeGetDiagnostics(args);
        case 'write_file': return executeWriteFile(args);
        case 'generate_image': return executeGenerateImage(args);
        case 'analyze_image': return executeAnalyzeImage(args);
        default: return 'Unknown tool: ' + name;
    }
}

// ============================================================
// read_file
// ============================================================

async function executeReadFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    // ★ 路径合理性校验：防止 AI 将中文文本当作文件路径
    var _p = args.path || '';
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — does not appear to be a valid file path. Provide an absolute path (e.g. E:\\project\\file.js).';
    }

    // ★ 同楼层去重：同文件 + 同行范围 反复读 3 次+ → 死循环
    //    键 = 路径 + 行范围，不同行范围互不干扰。全文读用 L0-0。
    //    计数器由 agent-loop.js 在每层楼开始时清零 (window._qqqReadFilesThisFloor = {})
    var _normPath = _p.replace(/\\/g, '/').toLowerCase();
    var _sl = args.start_line || 0;
    var _el = args.end_line || 0;
    var _dedupKey = _normPath + '|' + _sl + '|' + _el;
    var _tracker = (typeof window !== 'undefined') ? window._qqqReadFilesThisFloor : null;
    if (_tracker) {
        // ★ ENOENT 缓存：文件不存在 → 同路径永生不复读（不管行范围）。防 AI 被截断路径坑 10 次
        var _enoCache = window._qqqEnoentCache;
        if (_enoCache && _enoCache[_normPath]) {
            return '[FILE NOT FOUND] ' + _normPath + ' — 该文件在本层楼已确认不存在，请勿重试。检查路径是否有截断或中文字符。';
        }
        _tracker[_dedupKey] = (_tracker[_dedupKey] || 0) + 1;
        if (_tracker[_dedupKey] >= 3) {
            var _rangeHint = (_sl || _el) ? (' L' + _sl + '-' + _el) : ' (全文)';
            return '[ALREADY READ] 文件 ' + args.path + _rangeHint + ' 在本层楼已读过 ' + (_tracker[_dedupKey] - 1) + ' 次，内容已在对话中。请基于已有信息继续分析，不要重复读取。';
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
                var end = args.end_line ? Math.min(total, args.end_line) : Math.min(total, start + 500);
                var slice = lines.slice(start, end).join('\n');
                _readResult = (total <= 500 && !args.start_line) ? content : ('File has ' + total + ' lines. Showing L' + (start + 1) + '-' + end + ':\n' + slice);
            }
        } catch (err) { _readErr = err; }
    }

    if (_readErr) {
        var _errMsg = 'Error reading file: ' + (_readErr.message || _readErr);
        // ★ 治根：ENOENT → 去父目录模糊匹配，防中文路径/引号截断
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
// edit_file — 精准文件编辑引擎（三级降级匹配 + 原子性）
// 移植自 q3/ai/src/tools.js
// ============================================================

function _normalizeWhitespace(text) {
    return text.replace(/[^\S\n]+/g, ' ').replace(/ +$/gm, '').replace(/^ +/gm, function (m) { return m.length > 0 ? ' ' : ''; });
}

function _findMatch(content, find) {
    // L1: 精确匹配
    var idx1 = content.indexOf(find);
    if (idx1 !== -1) return { start: idx1, end: idx1 + find.length, matchLevel: 1 };

    // L1b: CRLF 归一化重试
    if (content.indexOf('\r\n') !== -1) {
        var normContent = content.replace(/\r\n/g, '\n');
        var normFind = find.replace(/\r\n/g, '\n');
        if (normContent !== content || normFind !== find) {
            var idx1b = normContent.indexOf(normFind);
            if (idx1b !== -1) {
                var origPos = 0;
                for (var np = 0; np < idx1b; np++, origPos++) {
                    if (content[origPos] === '\r' && content[origPos + 1] === '\n') origPos++;
                }
                var origStart = origPos;
                for (np = idx1b; np < idx1b + normFind.length; np++, origPos++) {
                    if (content[origPos] === '\r' && content[origPos + 1] === '\n') origPos++;
                }
                return { start: origStart, end: origPos, matchLevel: 1 };
            }
        }
    }

    // L2: 空白归一化匹配
    var nf = _normalizeWhitespace(find);
    var nc = _normalizeWhitespace(content);
    var idx2 = nc.indexOf(nf);
    if (idx2 !== -1) {
        var normBefore = nc.slice(0, idx2);
        var normAfter = nc.slice(0, idx2 + nf.length);
        var startLine = (normBefore.match(/\n/g) || []).length;
        var endLine = (normAfter.match(/\n/g) || []).length;
        var lines = content.split('\n');
        var oStart = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
        var oEnd = lines.slice(0, endLine + 1).join('\n').length;
        return { start: oStart, end: oEnd, matchLevel: 2 };
    }

    // L3: 行级匹配
    var findLines = find.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
    if (findLines.length >= 2) {
        var contentLines = content.split('\n');
        for (var i = 0; i <= contentLines.length - findLines.length; i++) {
            var match = true;
            for (var j = 0; j < findLines.length; j++) {
                if (contentLines[i + j].trim() !== findLines[j]) { match = false; break; }
            }
            if (match) {
                var soff = contentLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
                var eoff = contentLines.slice(0, i + findLines.length).join('\n').length;
                return { start: soff, end: eoff, matchLevel: 3 };
            }
        }
    }
    return null;
}

async function executeEditFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';
    if (!args.edits || args.edits.length === 0) return 'Error: no edits provided.';

    var _p = args.path || '';
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — provide an absolute path.';
    }

    // ★ 优先走主进程 (1 IPC, 替代 read+write 2 IPC)
    if (bridge.ai && bridge.ai.edit_file) {
        try {
            var _r = await bridge.ai.edit_file({ path: args.path, edits: args.edits });
            if (_r && _r.indexOf('Error') !== 0) _notifyFileModified(args.path);
            _r = _maybeHintBackslashN(_r, args.edits);
            return await _checkFileSizeWarn(_r, args.path);
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer ----
    try {
        var content = await bridge.fs.read(args.path);
        content = content.replace(/\r\n/g, '\n');
        var results = [];
        var totalApplied = 0;

        // Phase 1: 先全部匹配
        var matchPlan = [];
        for (var i = 0; i < args.edits.length; i++) {
            var edit = args.edits[i];
            var m = _findMatch(content, edit.find);
            if (!m) {
                var firstLine = edit.find.split('\n')[0].trim();
                var lines = content.split('\n');
                var hint = '';
                for (var li = 0; li < lines.length; li++) {
                    if (lines[li].indexOf(firstLine) !== -1) {
                        hint = '\nNearest match at line ' + (li + 1) + ':\n' + lines.slice(Math.max(0, li - 1), li + 4).join('\n');
                        break;
                    }
                }
                var _err = 'Error: edit #' + (i + 1) + ' match failed — text not found in ' + (args.path.split(/[\\/]/).pop()) + '.' + hint;
                return _maybeHintBackslashN(_err, args.edits);
            }
            matchPlan.push({ edit: edit, match: m, index: i });
        }

        // Phase 2: 按顺序应用
        for (var pi = 0; pi < matchPlan.length; pi++) {
            var plan = matchPlan[pi];
            var ed = plan.edit;
            if (ed.replace_all) {
                var count = content.split(ed.find).length - 1;
                content = content.split(ed.find).join(ed.replace);
                results.push('#' + (pi + 1) + ': all (' + count + 'x, L' + plan.match.matchLevel + ')');
                totalApplied += count;
            } else {
                var m2 = _findMatch(content, ed.find);
                if (m2) {
                    content = content.slice(0, m2.start) + ed.replace + content.slice(m2.end);
                    results.push('L' + m2.matchLevel);
                    totalApplied++;
                } else {
                    results.push('skip(moved)');
                }
            }
        }

        // Phase 3: 写入
        try { await bridge.fs.mkdir(args.path.replace(/[/\\][^/\\]+$/, '')); } catch (_) { }
        await bridge.fs.write(args.path, content);
        _notifyFileModified(args.path);

        var matchInfo = results.some(function (r) { return r.indexOf('L2') !== -1 || r.indexOf('L3') !== -1; })
            ? ' (whitespace-tolerant match used)' : '';
        return await _checkFileSizeWarn('\u2713 ' + totalApplied + ' edit(s) applied to ' + (args.path.split(/[\\/]/).pop()) + matchInfo, args.path);
    } catch (err) {
        return 'Error editing file: ' + (err.message || err);
    }
}

// ============================================================
// write_file — 全量覆写
// ============================================================

async function executeWriteFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var _p = args.path || '';
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — provide an absolute path.';
    }

    // ★ 优先走主进程 (1 IPC)
    if (bridge.ai && bridge.ai.write_file) {
        try {
            var _wr = await bridge.ai.write_file({ path: args.path, content: args.content });
            if (_wr && _wr.indexOf('Error') !== 0) _notifyFileModified(args.path);
            return await _checkFileSizeWarn(_wr, args.path);
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer ----
    try {
        try { await bridge.fs.mkdir(args.path.replace(/[/\\][^/\\]+$/, '')); } catch (_) { }
        await bridge.fs.write(args.path, args.content);
        _notifyFileModified(args.path);
        return await _checkFileSizeWarn('File written: ' + args.path + ' (' + args.content.length + ' chars)', args.path);
    } catch (err) {
        return 'Error writing file: ' + (err.message || err);
    }
}

// ============================================================
// search_text — 递归正则搜索
// ============================================================

var SKIP_DIRS = ['node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs', 'cache', 'temp', 'crashDumps'];
var SKIP_EXTS = ['.exe', '.dll', '.so', '.dylib', '.bin', '.pyd', '.pyc', '.pyo', '.class', '.o', '.obj', '.lib', '.a', '.sys', '.drv', '.ocx', '.scr', '.cab', '.msi', '.msc', '.cpl', '.lnk', '.dat', '.pak', '.res', '.resources', '.rom', '.elf', '.ko', '.mod', '.dex', '.jar', '.war', '.ear', '.apk', '.ipa', '.iso', '.img', '.dmg', '.pkg', '.deb', '.rpm', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp', '.svgz', '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.zip', '.tar', '.gz', '.xz', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.icns', '.vsix', '.lock', '.wasm', '.map', '.tsbuildinfo', '.sq3', '.db', '.sqlite', '.sqlite3', '.sdb']; // 排除所有已知二进制/压缩/编译/数据库格式

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
    if (!args.keywords || args.keywords.length === 0) return 'Error: no keywords provided.';

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

    var _p = args.path || '';
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
// create_file
// ============================================================

async function executeCreateFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var _p = args.path || '';
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — provide an absolute path.';
    }

    // ★ 优先走主进程 (1 IPC)
    if (bridge.ai && bridge.ai.create_file) {
        try {
            var _cr = await bridge.ai.create_file({ path: args.path, content: args.content });
            if (_cr && _cr.indexOf('Error') !== 0) _notifyFileModified(args.path);
            return await _checkFileSizeWarn(_cr, args.path);
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer ----
    try {
        var exists = await bridge.fs.exists(args.path);
        if (exists) return 'Error: file already exists: ' + args.path + '. Use edit_file to modify existing files.';
        try { await bridge.fs.mkdir(args.path.replace(/[/\\][^/\\]+$/, '')); } catch (_) { }
        await bridge.fs.write(args.path, args.content);
        _notifyFileModified(args.path);
        return await _checkFileSizeWarn('File created: ' + args.path + ' (' + args.content.length + ' chars)', args.path);
    } catch (err) {
        return 'Error creating file: ' + (err.message || err);
    }
}

// ============================================================
// run_command
// ============================================================

async function executeRunCommand(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';
    try {
        // Parse command into cmd + args for proper spawn
        var cmd = args.command || '';
        var cmdArgs = [];
        var useShell = false;
        if (cmd.includes(' ')) {
            // Split respecting quotes
            var parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [cmd];
            cmd = parts[0];
            cmdArgs = parts.slice(1).map(function (s) {
                if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                    return s.slice(1, -1);
                }
                return s;
            });
        }
        // On Windows, built-in commands (dir/type/echo etc.) are wrapped
        // transparently by qz-spawn.ts; here we just detect platform for shell mode.
        var isWin = (typeof navigator !== 'undefined' && /Win/.test(navigator.platform || ''))
            || (typeof process !== 'undefined' && process.platform === 'win32');
        if (isWin) {
            useShell = true;
        }
        // Use qz spawn (ghrun → node fallback)
        // [silent] run_command
        // timeout=0 → 系统层自动 cap 为 SYSTEM_MAX_TIMEOUT (唯一真理源: qz-spawn.ts)
        // stallMs 唯一真理在此（tools.js），系统层默认 0（关闭）
        var cmdStart = Date.now();
        var result = await bridge.qz.spawn({
            cmd: cmd,
            args: cmdArgs,
            cwd: args.cwd || '',
            timeout: 0,           // 不设限，交给系统天花板 (2h)
            stallMs: 900000,      // 15min 无输出即杀
            shell: useShell
        });

        // ★ 钩子 Q（_a4WrappedExecuteTool）统一处理 run_command 的扫描+记录
        // 此处不再重复 captureChanged + _a4RecordSnapshot

        // [silent] run_command result
        // AI-facing output cap (single source: OUTPUT_CAP_DEFAULT / OUTPUT_CAP_MAX)
        var cap = Math.min(args.maxOutput || OUTPUT_CAP_DEFAULT, OUTPUT_CAP_MAX);
        if (result.exitCode === 0) {
            var out = (result.stdout || '') + (result.stderr || '');
            return out.length > cap ? out.slice(0, cap) + '\n... (truncated at ' + cap + ' chars)' : (out || '(no output)');
        } else {
            var errOut = (result.stdout || '') + (result.stderr || '');
            return 'Command failed (exit ' + result.exitCode + '):\n' + (errOut.length > cap ? errOut.slice(0, cap) + '\n... (truncated at ' + cap + ' chars)' : errOut);
        }
    } catch (err) {
        return 'Error running command: ' + (err.message || err);
    }
}

// ============================================================
// delete_file
// ============================================================

async function executeDeleteFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var _p = args.path || '';
    if (!/[\\/]/.test(_p) || !/^[A-Za-z]:[\\/]|^[\\/]/.test(_p.trim())) {
        return 'Error: invalid path "' + _p + '" — provide an absolute path.';
    }

    // ★ 优先走主进程 (1 IPC)
    if (bridge.ai && bridge.ai.delete_file) {
        try {
            return await bridge.ai.delete_file({ path: args.path });
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer ----
    try {
        var exists = await bridge.fs.exists(args.path);
        if (!exists) return 'Error: file not found: ' + args.path;
        await bridge.fs.remove(args.path);
        return 'Deleted: ' + args.path;
    } catch (err) {
        return 'Error deleting file: ' + (err.message || err);
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
    if (args.path) {
        searchDirs = [args.path];
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
        var path = args.path || '';
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

// ============================================================
// _waitForTaskStream — SSE stream 等待异步任务完成（generate/vision 共用）
// ============================================================
async function _waitForTaskStream(streamUrl, token) {
    var streamResp = await fetch(streamUrl, {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!streamResp.ok) {
        return { _httpError: streamResp.status };
    }

    var reader = streamResp.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    var result = null;

    while (true) {
        var rd = await reader.read();
        if (rd.done) break;
        buf += decoder.decode(rd.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop() || '';
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            if (line.charAt(0) === ':') continue;
            if (line.slice(0, 7) !== 'data: ') continue;
            try {
                var parsed = JSON.parse(line.slice(7));
                if (parsed.status === 'done' || parsed.status === 'error') {
                    result = parsed;
                }
            } catch (_) { }
        }
    }
    reader.releaseLock();
    return result;
}

// ============================================================
// generate_image — Go 代理通义万相 文生图（终极架构：全部 AI 过 Go）
// ============================================================

async function executeGenerateImage(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var prompt = args.prompt || '';
    if (!prompt.trim()) return 'Error: prompt is required';

    // 自动补全 out_dir
    if (!args.out_dir) {
        try {
            if (parent.qqqideViewport) {
                var vps = parent.qqqideViewport.getProjects();
                if (vps && vps.length > 0) {
                    var mainProj = null;
                    for (var i = 0; i < vps.length; i++) {
                        if (vps[i].star || vps[i].isMain) { mainProj = vps[i]; break; }
                    }
                    if (!mainProj && vps.length === 1) mainProj = vps[0];
                    if (mainProj) {
                        args.out_dir = mainProj.path.replace(/\\/g, '/').replace(/\/$/, '') + '/server-app/generated';
                    }
                }
            }
        } catch (_) { }
    }

    // ★ 终极架构：全部 AI ──▶ Go ──▶ 阿里
    var token = '';
    try {
        var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
        if (ag && ag._token) token = ag._token;
    } catch (_) { }
    if (!token) return 'Error: no auth token';

    var IMG_URL = (typeof IMAGE_GEN_URL !== 'undefined') ? IMAGE_GEN_URL : 'https://direct.gh555.com:8444/api/v3/ai/generate-image';
    var outDir = args.out_dir || '';

    try {
        // 1. POST → Go 创建异步绘图任务
        var postResp = await fetch(IMG_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                prompt: prompt,
                style: args.style || '',
                size: args.size || '1024*1024',
                n: args.n || 1
            })
        });
        if (!postResp.ok) {
            var errText = '';
            try { errText = await postResp.text(); } catch (_) { }
            return 'Image generation failed (HTTP ' + postResp.status + '): ' + errText.slice(0, 300);
        }
        var postData = await postResp.json();
        if (!postData.ok || !postData.task_id) {
            return 'Image generation failed: ' + (postData.error || 'unknown error');
        }

        // 2. SSE stream → 等 Go 轮询完阿里 wanx 返回结果
        var result = await _waitForTaskStream(IMG_URL + '/' + postData.task_id + '/stream', token);
        if (!result || result._httpError) {
            return 'Image generation stream failed (HTTP ' + (result ? result._httpError : '?') + ')';
        }

        if (!result || result.status === 'error') {
            return 'Image generation failed: ' + (result ? result.error : 'no response');
        }
        if (!result.urls || result.urls.length === 0) {
            return 'Image generation failed: no image URLs returned';
        }

        // ★ 累加显示用计费（Go 已权威记账，此处仅 UI 展示）
        if (result.ge_cost && typeof _addToolGeCost === 'function') {
            _addToolGeCost(result.ge_cost);
        }

        // 3. 并行下载图片到本地
        if (outDir) {
            try { await bridge.fs.mkdir(outDir); } catch (_) { }
        } else {
            outDir = '.';
        }

        var dlPromises = result.urls.map(function (url, u) {
            var fname = 'wanx_' + Date.now() + '_' + u + '.png';
            var fpath = outDir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + fname;
            return bridge.qz.spawn({
                cmd: 'curl',
                args: ['-sL', '--max-time', '60', '-o', fpath, url],
                timeout: 90000
            }).then(function (dl) {
                return { path: fpath, ok: dl.exitCode === 0 };
            }).catch(function () {
                return { path: fpath, ok: false };
            });
        });
        var dlResults = await Promise.all(dlPromises);
        var paths = dlResults.filter(function (r) { return r.ok; }).map(function (r) { return r.path; });

        if (paths.length === 0) {
            return 'Image generation failed: could not download images (URLs may have expired)';
        }

        return 'Generated ' + paths.length + ' image(s):\n' + paths.map(function (p, i) {
            return '  ' + (i + 1) + '. ' + p;
        }).join('\n');

    } catch (err) {
        return 'Error running image generation: ' + (err.message || err);
    }
}

// ============================================================
// analyze_image — Go 代理 qwen-vl 视觉理解（终极架构：全部 AI 过 Go）
// ============================================================

async function executeAnalyzeImage(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var image = args.image || '';
    if (!image.trim()) return 'Error: image path is required';

    var action = args.action || 'describe';

    // ★ 终极架构：全部 AI ──▶ Go ──▶ 阿里
    var token = '';
    try {
        var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
        if (ag && ag._token) token = ag._token;
    } catch (_) { }
    if (!token) return 'Error: no auth token';

    var VIS_URL = (typeof VISION_URL !== 'undefined') ? VISION_URL : 'https://direct.gh555.com:8444/api/v3/ai/vision';

    try {
        // 1. 读取图片 → base64
        var b64Result = await bridge.qz.spawn({
            cmd: 'bash',
            args: ['-c', 'base64 -w0 "' + image.replace(/\\/g, '/') + '" 2>/dev/null || base64 "' + image.replace(/\\/g, '/') + '" 2>/dev/null'],
            timeout: 15000
        });
        var b64 = (b64Result.stdout || '').replace(/\s/g, '');
        if (!b64) return 'Error: could not read or encode image: ' + image;

        // 2. 构建问题
        var question;
        if (action === 'describe') {
            var prompts = {
                'brief': '用一句话描述这张图片的内容。',
                'standard': '描述这张图片的主要内容、风格和构图。',
                'detailed': '详细描述这张图片：画面元素、色彩、光影、构图、风格、氛围。'
            };
            question = prompts[args.detail] || prompts['standard'];
        } else if (action === 'locate') {
            var targets = (args.targets || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
            if (targets.length === 0) return 'Error: --targets required for locate action';
            var targetsStr = targets.join('、');
            question = '在这张图片中找到以下物体：' + targetsStr + '。对每个物体，估算它的像素边界框 [x1, y1, x2, y2]。x1,y1 是左上角，x2,y2 是右下角。返回严格的 JSON 数组，格式：[{"label": "物体名", "box": [x1, y1, x2, y2]}]。只返回 JSON，不要任何解释文字。';
        } else if (action === 'ask') {
            if (!args.question) return 'Error: --question required for ask action';
            question = args.question;
        } else {
            return 'Error: unknown action: ' + action;
        }

        // 3. POST → Go 创建异步视觉任务
        var postBody = { image: b64, prompt: question, detail: 'high' };
        var summary = (action === 'ask' ? question : question.slice(0, 60));
        if (summary) postBody.summary = summary.slice(0, 200);
        var postResp = await fetch(VIS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(postBody)
        });
        if (!postResp.ok) {
            var errText = '';
            try { errText = await postResp.text(); } catch (_) { }
            return 'Image analysis failed (HTTP ' + postResp.status + '): ' + errText.slice(0, 300);
        }
        var postData = await postResp.json();
        if (!postData.ok || !postData.task_id) {
            return 'Image analysis failed: ' + (postData.error || 'unknown error');
        }

        // 4. SSE stream → 等 Go 返回视觉结果
        var result = await _waitForTaskStream(VIS_URL + '/' + postData.task_id + '/stream', token);
        if (!result || result._httpError) {
            return 'Image analysis stream failed (HTTP ' + (result ? result._httpError : '?') + ')';
        }

        if (!result || result.status === 'error') {
            return 'Image analysis failed: ' + (result ? result.error : 'no response');
        }

        var content = result.description || '';
        if (!content) return 'Image analysis returned empty result';

        // ★ 累加显示用计费（Go 已权威记账，此处仅 UI 展示）
        if (result.ge_cost && typeof _addToolGeCost === 'function') {
            _addToolGeCost(result.ge_cost);
        }

        // 5. 按 action 处理结果
        if (action === 'locate') {
            // 清洗 markdown 围栅
            var raw = content.trim();
            if (raw.indexOf('```') === 0) {
                var mdLines = raw.split('\n');
                if (mdLines[mdLines.length - 1].indexOf('```') === 0) {
                    raw = mdLines.slice(1, -1).join('\n');
                } else {
                    raw = mdLines.slice(1).join('\n');
                }
            }
            try {
                var boxes = JSON.parse(raw);
                return JSON.stringify(boxes, null, 2);
            } catch (_) {
                var match = raw.match(/\[[\s\S]*\]/);
                if (match) {
                    try {
                        boxes = JSON.parse(match[0]);
                        return JSON.stringify(boxes, null, 2);
                    } catch (_2) { }
                }
                return 'Image locate failed: could not parse bounding boxes from response: ' + raw.slice(0, 500);
            }
        }

        // describe / ask → 直接返回内容
        return content;

    } catch (err) {
        return 'Error running image analysis: ' + (err.message || err);
    }
}

// ============================================================
// 导出
// ============================================================

function getTools() {
    // ★ 硬兜底：确保 tools 永远不会是 undefined（脚本加载顺序/异步问题）
    if (typeof TOOL_DEFINITIONS === 'undefined' || !Array.isArray(TOOL_DEFINITIONS)) {
        if (typeof console !== 'undefined') console.warn('[tools] TOOL_DEFINITIONS not ready, returning empty');
        return [];
    }
    return TOOL_DEFINITIONS;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TOOL_DEFINITIONS, TOOL_CATEGORY, getTools, executeTool };
}

