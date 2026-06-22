// ============================================================================
// tools-defs.js — AI 工具定义（TOOL_DEFINITIONS + TOOL_CATEGORY + 辅助函数）
// 从 tools.js 拆分而来。工具执行逻辑见 tools-exec*.js
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

var _RFCKB_D = typeof ContentGateway !== "undefined" ? ContentGateway.READ_FILE_CAP_KB : 195;
var TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read file contents. Returns up to ~' + _RFCKB_D + 'KB per call. If truncated (marked [TRUNCATED L1-N]), next call MUST use start_line: N+1 to continue. You may read any file at any time — the system trusts your judgment.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    start_line: { type: 'number', description: 'Start line number (1-based, default 1)' },
                    end_line: { type: 'number', description: 'End line number (inclusive, default start+3000)' }
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
            description: 'Create a new file with given content. Auto-creates parent directories. Fails if file already exists (use edit_file to modify). Single IPC. TEMP FILES MUST GO TO {project_root}/tmp/.',
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
            description: 'Run a shell command. Returns stdout+stderr. Output truncated to ' + OUTPUT_CAP_DEFAULT + ' chars by default, up to ' + OUTPUT_CAP_MAX + ' with maxOutput. Hard timeout 2h, stall guard 15min. Use cwd to set working directory. ⚠️ PREFER search_text/search_content/find_files for code search — they are 10x faster and memory-safe. Only use run_command when dedicated tools CANNOT do the job.',
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
            description: 'Overwrite an existing file with new content. Creates parent directories if needed. Unlike edit_file, this replaces the ENTIRE file content. TEMP FILES MUST GO TO {project_root}/tmp/.',
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
            description: 'Generate high-quality PNG images. Supports multiple styles. Images are saved locally and returned as file paths. ~15-40s per image.',
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
            description: 'Analyze an existing image. Can: describe content, locate objects with bounding boxes (for clickable image maps), or answer questions about the image. Use when user wants interactive images or needs to understand generated image content.',
                    image: { type: 'string', description: 'Absolute path to the image file to analyze' },
                    action: { type: 'string', description: 'Analysis action: "describe" (describe content), "locate" (find objects + return bounding boxes), "ask" (free-form question)' },
                    detail: { type: 'string', description: 'For action=describe: "brief" (1 sentence), "standard" (paragraph), "detailed" (full analysis)' },
                    targets: { type: 'string', description: 'For action=locate: comma-separated object names to find, e.g. "frog,lotus,leaf"' },
                    question: { type: 'string', description: 'For action=ask: the question to ask about the image' }
                },
                required: ['image', 'action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Search the web. Returns up to 20 results with title, URL, and snippet. ALWAYS follow up with fetch_webpage on the most relevant result URLs to extract full data — search_web alone only gives links, not the actual content you need. After search_web: use fetch_webpage for text (docs, articles) or run_command+curl for structured data (APIs, rankings, prices). 5 ge per search.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query in natural language. Keep it concise and keyword-rich. Examples: "python asyncio gather vs wait", "react 19 new features 2025", "golang generics tutorial"' }
                },
                required: ['query']
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
    generate_image: 'EFFECT', analyze_image: 'EFFECT', search_web: 'EFFECT'
};

// ---- getTools 兜底 ----
function getTools() {
    if (typeof TOOL_DEFINITIONS === 'undefined' || !Array.isArray(TOOL_DEFINITIONS)) {
        if (typeof console !== 'undefined') console.warn('[tools] TOOL_DEFINITIONS not ready, returning empty');
        return [];
    }
    return TOOL_DEFINITIONS;
}
