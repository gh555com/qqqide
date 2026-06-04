// ============================================================================
// tools.js — AI 工具定义 + 执行引擎
// 从 q3/ai/src/tools.js 移植，适配 Shell v2 Electron 环境
// 工具通过 parent.qqqBridge 访问文件系统/命令行
// ============================================================================

// ---- 获取 bridge（iframe 内通过 parent 访问）----
function getBridge() {
    try { return parent.qqqBridge; } catch (_) { return null; }
}

// ============================================================
// ★ Output caps — single source of truth for AI-facing limits
//
// Two-tier architecture:
//   SAFETY NET  (ghrun/qz-spawn): 65536 — prevents memory blowup, never active
//   AI FACING  (here):           defined below — what DeepSeek sees & interacts with
//
// ============================================================
// ★ AI-facing output caps — 唯一真理在 ContentGateway（content-gateway.js）
//   此处为兼容旧引用的别名；所有新代码应直接使用 ContentGateway.OUTPUT_CAP_*
//   fetch 相关常量仅在 web fetch 场景使用，独立于 ContentGateway
// ============================================================
var OUTPUT_CAP_DEFAULT = (typeof ContentGateway !== 'undefined' ? ContentGateway.OUTPUT_CAP_DEFAULT : 8000);
var OUTPUT_CAP_MAX     = (typeof ContentGateway !== 'undefined' ? ContentGateway.OUTPUT_CAP_MAX : 65536);
var OUTPUT_CAP_FETCH = 8000;     // web fetch text extraction limit (fetch 专用)
var OUTPUT_CAP_FETCH_ERR = 500;  // web fetch error message limit (fetch 专用)

// ============================================================
// 工具定义（OpenAI function calling format）
// ============================================================

var TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read file contents. For large files (>500 lines), use start_line/end_line to paginate.',
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
            description: 'Edit a file with one or more search-and-replace operations. All edits are applied atomically (all succeed or none applied). Supports whitespace-tolerant matching as fallback. No confirmation needed.',
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
            name: 'list_files',
            description: 'List files in a directory',
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
            description: 'Create a new file with the given content. Auto-creates parent directories. Fails if the file already exists.',
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
            description: 'Run a shell command. Returns stdout+stderr. Output truncated to ' + OUTPUT_CAP_DEFAULT + ' chars by default. When you need full output (e.g. large file listings, long logs), pass maxOutput to request up to ' + OUTPUT_CAP_MAX + '. Default timeout 5min, max 10min. Stall guard: 5min no output = killed. Use cwd to set working directory. PREFER search_text/find_files for code search — they are 10x faster and memory-safe.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to execute' },
                    cwd: { type: 'string', description: 'Working directory (optional)' },
                    maxOutput: { type: 'number', description: 'Override output char limit (default ' + OUTPUT_CAP_DEFAULT + ', max ' + OUTPUT_CAP_MAX + '). Use only when certain you need the full output.' }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description: 'Delete a file. Fails if file does not exist.',
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
            description: 'Search for files by name pattern (glob like *.js, config/*.json). Returns matching file paths.',
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
            description: 'Fetch and extract text content from a URL.',
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
            description: 'Get LSP/compiler diagnostics (errors, warnings, hints) for a file or all open files. Returns the same markers you see in the IDE as red/yellow squiggles.',
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
    }
];

// ============================================================
// 工具分类（用于并行执行调度）
// ============================================================

var TOOL_CATEGORY = {
    read_file: 'READ', search_text: 'READ', list_files: 'READ',
    find_files: 'READ', get_vision_context: 'READ', fetch_webpage: 'READ',
    get_diagnostics: 'READ',
    edit_file: 'WRITE', create_file: 'WRITE', delete_file: 'WRITE', write_file: 'WRITE',
    run_command: 'EFFECT'
};

// ============================================================
// 工具执行分发
// ============================================================

async function executeTool(name, args) {
    switch (name) {
        case 'read_file': return executeReadFile(args);
        case 'edit_file': return executeEditFile(args);
        case 'search_text': return executeSearchText(args);
        case 'list_files': return executeListFiles(args);
        case 'get_vision_context': return executeGetVisionContext();
        case 'create_file': return executeCreateFile(args);
        case 'run_command': return executeRunCommand(args);
        case 'delete_file': return executeDeleteFile(args);
        case 'find_files': return executeFindFiles(args);
        case 'fetch_webpage': return executeFetchWebpage(args);
        case 'get_diagnostics': return executeGetDiagnostics(args);
        case 'write_file': return executeWriteFile(args);
        default: return 'Unknown tool: ' + name;
    }
}

// ============================================================
// read_file
// ============================================================

async function executeReadFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    // ★ 优先走主进程 (1 IPC, 消除大文件序列化开销)
    if (bridge.ai && bridge.ai.read_file) {
        try {
            var result = await bridge.ai.read_file({ path: args.path, start_line: args.start_line, end_line: args.end_line });
            // 主进程路径也做二进制检测（委托 ContentGateway 唯一真理）
            return _guardBinaryResult(result);
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer ----
    try {
        var content = await bridge.fs.read(args.path);
        // 二进制检测（委托 ContentGateway）
        var binCheck = _checkBinary(content);
        if (binCheck) return binCheck;
        // CRLF→LF normalize
        content = content.replace(/\r\n/g, '\n');
        var lines = content.split('\n');
        var total = lines.length;
        var start = Math.max(0, (args.start_line || 1) - 1);
        var end = args.end_line ? Math.min(total, args.end_line) : Math.min(total, start + 500);
        var slice = lines.slice(start, end).join('\n');
        if (total <= 500 && !args.start_line) return content;
        return 'File has ' + total + ' lines. Showing L' + (start + 1) + '-' + end + ':\n' + slice;
    } catch (err) {
        return 'Error reading file: ' + (err.message || err);
    }
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

    // ★ 优先走主进程 (1 IPC, 替代 read+write 2 IPC)
    if (bridge.ai && bridge.ai.edit_file) {
        try {
            return await bridge.ai.edit_file({ path: args.path, edits: args.edits });
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
                return 'Error: edit #' + (i + 1) + ' match failed — text not found in ' + (args.path.split(/[\\/]/).pop()) + '.' + hint;
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

        var matchInfo = results.some(function (r) { return r.indexOf('L2') !== -1 || r.indexOf('L3') !== -1; })
            ? ' (whitespace-tolerant match used)' : '';
        return '\u2713 ' + totalApplied + ' edit(s) applied to ' + (args.path.split(/[\\/]/).pop()) + matchInfo;
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

    // ★ 优先走主进程 (1 IPC)
    if (bridge.ai && bridge.ai.write_file) {
        try {
            return await bridge.ai.write_file({ path: args.path, content: args.content });
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer ----
    try {
        try { await bridge.fs.mkdir(args.path.replace(/[/\\][^/\\]+$/, '')); } catch (_) { }
        await bridge.fs.write(args.path, args.content);
        return 'File written: ' + args.path + ' (' + args.content.length + ' chars)';
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
            if (parent.qqqAiViewport) {
                var vps = parent.qqqAiViewport.getProjects();
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
    try {
        regex = new RegExp(args.query, 'i');
    } catch (_) {
        regex = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
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
// list_files
// ============================================================

async function executeListFiles(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';
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
        if (!parent.qqqAiViewport) return 'No vision context available.';
        var vps = parent.qqqAiViewport.getProjects();

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

    // ★ 优先走主进程 (1 IPC)
    if (bridge.ai && bridge.ai.create_file) {
        try {
            return await bridge.ai.create_file({ path: args.path, content: args.content });
        } catch (_) { /* fallback */ }
    }

    // ---- fallback: renderer ----
    try {
        var exists = await bridge.fs.exists(args.path);
        if (exists) return 'Error: file already exists: ' + args.path + '. Use edit_file to modify existing files.';
        try { await bridge.fs.mkdir(args.path.replace(/[/\\][^/\\]+$/, '')); } catch (_) { }
        await bridge.fs.write(args.path, args.content);
        return 'File created: ' + args.path + ' (' + args.content.length + ' chars)';
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
        console.log('[qz] run_command:', JSON.stringify({ cmd: cmd, args: cmdArgs, cwd: args.cwd || '', shell: useShell }));
        // A5: default timeout 5min, max 10min — AI can extend via maxOutput hint
        var effectiveTimeout = args.maxOutput && args.maxOutput > OUTPUT_CAP_DEFAULT ? 600000 : 300000;
        var result = await bridge.qz.spawn({
            cmd: cmd,
            args: cmdArgs,
            cwd: args.cwd || '',
            timeout: effectiveTimeout,
            stallMs: 300000,
            shell: useShell
        });
        console.log('[qz] run_command result:', JSON.stringify({ exitCode: result.exitCode, tier: result.tier, durationMs: result.durationMs, stdoutLen: (result.stdout || '').length, stderrLen: (result.stderr || '').length }));
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
            if (parent.qqqAiViewport) {
                var vps = parent.qqqAiViewport.getProjects();
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
// 导出
// ============================================================

function getTools() {
    return TOOL_DEFINITIONS;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TOOL_DEFINITIONS, TOOL_CATEGORY, getTools, executeTool };
}

