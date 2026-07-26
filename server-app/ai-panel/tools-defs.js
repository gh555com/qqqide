// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// tools-defs.js — AI 工具定义（TOOL_DEFINITIONS + TOOL_CATEGORY + 辅助函数）
// 从 tools.js 拆分而来。工具执行逻辑见 tools-exec*.js
// ============================================================================

// ---- 获取 bridge（iframe 内通过 parent 访问）----
function getBridge() {
    try { return parent.qqqideBridge; } catch (_) { return null; }
}

// ══════════════════════════════════════════════════════════════
// Path resolution: project-relative → absolute
//   Accepts: /server-app/foo.js  |  {project}/server-app/foo.js  |  E:/full/path
//   Files outside project root MUST use full absolute paths.
// ══════════════════════════════════════════════════════════════
var __projectRootCache = null;
function _getProjectRoot() {
    if (__projectRootCache) return __projectRootCache;
    if (typeof questStore !== 'undefined' && questStore.getProjectRoot) {
        __projectRootCache = questStore.getProjectRoot().replace(/\\/g, '/').replace(/\/$/, '');
        return __projectRootCache;
    }
    return null;
}
function _resolveProjectPath(p) {
    if (!p || typeof p !== 'string') return p;
    // Already absolute (Windows drive letter or UNC)
    if (/^[A-Za-z]:[\\\/]/.test(p) || /^\\\\/.test(p)) return p;
    var root = _getProjectRoot();
    if (!root) return p; // can't resolve without project root
    // {project} or {p} prefix
    if (p.indexOf('{project}') === 0) return root + p.substring(9);
    if (p.indexOf('{p}') === 0) return root + p.substring(3);
    // Leading / means relative to project root
    if (p.charAt(0) === '/' || p.charAt(0) === '\\') return root + p;
    return p; // plain relative — pass through, let downstream handle
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
//   统一内容门: ContentGateway.CTX_CAP_CHARS (50K)
//   fetch 相关常量仅在 web fetch 场景使用，独立于 ContentGateway
// ============================================================
var OUTPUT_CAP_DEFAULT = (typeof ContentGateway !== 'undefined' ? ContentGateway.CTX_CAP_CHARS : 50000);
var OUTPUT_CAP_MAX = OUTPUT_CAP_DEFAULT;  // 不再区分 default/max，统一门
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
    // ★ 自动语法检查：每次写入后静默运行，结果拼接在返回字符串末尾
    if (typeof _autoSyntaxCheck === 'function') {
        try {
            var _syntaxResult = await _autoSyntaxCheck(filePath);
            if (_syntaxResult) result += _syntaxResult;
        } catch (_) { }
    }
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

var _RFCKB_D = typeof ContentGateway !== "undefined" ? Math.round(ContentGateway.CTX_CAP_CHARS / 1024) : 50;
var TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read file contents. Returns up to ~' + _RFCKB_D + 'KB per call. Use start_line/end_line for pagination. Returns pagination header [paginated X-Y of Z lines]. Pass sha256 to read a historical version from timeline (from edit_file return [sha256:...] or timeline_versions sha=...).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo.js)' },
                    start_line: { type: 'number', description: 'Start line number (1-based, default 1)' },
                    end_line: { type: 'number', description: 'End line number (inclusive, default start+3000)' },
                    sha256: { type: 'string', description: 'Optional SHA256 hash to read a historical version from timeline (from edit_file/write_file/create_file return values [sha256:...], or blob_hash from timeline_versions output)' }
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
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo.js)' },
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
            description: 'Regex search across workspace files. 10x faster than shell. Supports | for OR. Pass sha256 for historical blob search. For literal-only search, use search_content.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search pattern (regex supported)' },
                    path: { type: 'string', description: 'Directory to search in. Absolute or project-relative (optional)' },
                    max_results: { type: 'number', description: 'Max results to return (default 30)' },
                    sha256: { type: 'string', description: 'Optional: SHA256 blob_hash from timeline (edit_file return value or timeline_versions output) — searches inside that historical version instead of disk' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_content',
            description: 'Multi-keyword OR search. Case-insensitive by default. Keywords MUST be JSON array ["foo","bar"]. 10x faster than shell. Pass sha256 for historical blob search.',
            parameters: {
                type: 'object',
                properties: {
                    keywords: { type: 'array', items: { type: 'string' }, description: 'Array of literal keywords to search for (OR-combined)' },
                    path: { type: 'string', description: 'Directory to search in. Absolute or project-relative (optional)' },
                    max_results: { type: 'number', description: 'Max results to return (default 30)' },
                    case_sensitive: { type: 'boolean', description: 'Enable case-sensitive matching (default false = case-insensitive)' },
                    sha256: { type: 'string', description: 'Optional: SHA256 blob_hash from timeline — searches inside that historical version instead of disk' }
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
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo)' },
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
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo.js)' },
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
            description: 'Run a shell command. Returns stdout+stderr. Timeout 2h, stall 15min. Prefer search_text/search_content/find_files for code search. Use fetch_webpage for web content. SSH: base64 auto-escape, write commands naturally.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to execute. When ssh is set, write as if running directly on the remote host — do NOT add ssh/quoting wrappers yourself.' },
                    cwd: { type: 'string', description: 'Working directory (optional). When ssh is set, applied on remote host.' },
                    ssh: { type: 'string', description: 'Optional: SSH destination in user@host or user@host:port format. When set, the command runs on this remote host via SSH with automatic base64 escaping (zero quoting hell). Example: "q@47.105.67.51" or "q@23.254.248.119:2222"' },
                    sshJump: { type: 'string', description: 'Optional: SSH jump host (ProxyJump) when the target is behind a bastion. Example: "q@47.105.67.51". Only meaningful when ssh is also set.' },
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
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo.js)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'find_files',
            description: 'Find files by glob pattern (*.js, config/*.json). 10x faster than shell. Default 50 max.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern to match filenames' },
                    path: { type: 'string', description: 'Directory to search in. Absolute or project-relative (optional)' },
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
            description: 'Fetch URL text via US proxy (bypasses GFW). 15s timeout. Strips HTML.',
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
            description: 'Syntax check (JS/PY/JSON). Returns OK or ERROR. Pass sha256 for historical blob check.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path. Absolute or project-relative. Also used to infer file extension for historical checks' },
                    sha256: { type: 'string', description: 'Optional: SHA256 blob_hash from timeline — checks syntax of that historical version instead of disk' }
                },
                required: ['path']
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
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo.js)' },
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
            description: '🔴 ONLY tool for image gen/editing. Generate or edit images via cloud AI. 🚫 NEVER write Python/PIL/opencv scripts for image tasks — this tool IS the only way. Styles: photorealistic/illustration/3D/anime/watercolor/chinese-trad/minimalist/e-commerce/nature. 4K only for text-to-image; editing max 2K.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Image description (text-to-image) or editing instruction (image editing). Natural language, Chinese or English.' },
                    images: { type: 'array', items: { type: 'string' }, description: 'Reference image paths. Absolute or project-relative. For image editing: the image(s) to edit. Omit for pure text-to-image.' },
                    style: { type: 'string', description: 'Style tag (text-to-image only): photorealistic/illustration/3D/anime/watercolor/chinese-trad/minimalist/e-commerce/nature' },
                    size: { type: 'string', description: 'Image size: "1K"=1024*1024, "2K"=2048*2048 (default), "4K"=4096*4096, or custom "W*H". 4K only for text-to-image; image editing max 2K.' },
                    n: { type: 'number', description: 'Number of images to generate (1-4, default 1)' },
                    out_dir: { type: 'string', description: 'Output directory. Absolute or project-relative. Default: qqq/genera/' }
                },
                required: ['prompt']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'analyze_image',
            description: '🔴 ONLY tool for image analysis. Describe, locate objects (norm-1000 bbox), or answer questions. 🚫 NEVER write Python/PIL/opencv for image analysis — this is THE only way. MIME validated (PNG/JPEG/GIF/WebP). Person identity already in vision context — only call for extra details.',
            parameters: {
                type: 'object',
                properties: {
                    image: { type: 'string', description: 'Path to image. Absolute or project-relative' },
                    action: { type: 'string', description: 'Analysis action: "describe" (structured content analysis), "locate" (find objects + return norm-1000 bbox + confidence), "ask" (free-form question with optional coordinate annotations)' },
                    detail: { type: 'string', description: 'For action=describe: "brief" (1 sentence), "standard" (paragraph), "detailed" (full structured analysis with colors/lighting/style)' },
                    targets: { type: 'string', description: 'For action=locate: comma-separated object names to find, e.g. "frog,lotus,leaf". Returns norm-1000 boxes with confidence scores.' },
                    question: { type: 'string', description: 'For action=ask: the question to ask about the image' }
                },
                required: ['image', 'action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'remove_background',
            description: '🔴 ONLY tool for background removal. Remove background → RGBA transparent PNG. 🚫 NEVER write Python/PIL/opencv/oss2 for background removal — this is THE only way. Auto-routes standard/HD by image size.',
            parameters: {
                type: 'object',
                properties: {
                    image: { type: 'string', description: 'Path to image. Absolute or project-relative' },
                    quality: { type: 'string', enum: ['auto', 'standard', 'hd'], description: 'auto=auto-detect based on image size, standard=fast (≤2000px), hd=high quality (≤10000px). Default: auto' }
                },
                required: ['image']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Web search via US server. Returns 20 results (title+URL+snippet). Follow with fetch_webpage for full content.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query in natural language. Keep it concise and keyword-rich. Examples: "python asyncio gather vs wait", "react 19 new features 2025", "golang generics tutorial"' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'timeline_versions',
            description: 'List all tracked versions of a file from the project timeline (qqq/timeline). Returns file_seq, blob_hash, timestamp, +/-lines, source, trace (quest/floor/house/room), and quality tags for each version. Uses 235 cascade: L2 heuristic tags (🏁 final / ⚠️ mid-edit) always shown; L3 syntax check (✅ clean / ⚠️ error) on-demand via check_syntax=true; L5 best-clean-version recommendation in footer. Ordered oldest→newest. Filter by floor_num to scope to one floor.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo.js)' },
                    floor_num: { type: 'number', description: 'Optional: filter to only show versions from a specific floor number (e.g. 5 to see only floor 5 changes)' },
                    check_syntax: { type: 'boolean', description: 'Optional: run syntax check on final + recent versions (JS/JSON only). Results cached forever by blob_hash. Default false (heuristic-only, instant).' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'revert_file',
            description: 'Revert a file to a historical version from the project timeline. Single call: looks up the blob by file_seq, restores content atomically, and records the revert as a new version. Returns syntax status of restored version + count of later versions + best-clean-version hint (L5 recommendation cascade). Syntax issues never block — AI should fix afterwards. Use timeline_versions first to pick the right file_seq.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo.js)' },
                    file_seq: { type: 'number', description: 'Version number to revert to (from timeline_versions output)' }
                },
                required: ['path', 'file_seq']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'diff_versions',
            description: 'Compute a unified diff between two historical versions of a file (or one version vs current disk). Returns standard unified diff format with @@ headers + L3 syntax preamble showing quality of both sides. Use timeline_versions first to find file_seq numbers, then diff any pair. If to_seq is omitted, compares from_seq against current disk content.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path. Absolute or project-relative (/server-app/foo.js)' },
                    from_seq: { type: 'number', description: 'Older version number (from timeline_versions output)' },
                    to_seq: { type: 'number', description: 'Newer version number (optional, defaults to current disk content)' }
                },
                required: ['path', 'from_seq']
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
    get_diagnostics: 'READ', timeline_versions: 'READ',
    edit_file: 'WRITE', create_file: 'WRITE', delete_file: 'WRITE', write_file: 'WRITE',
    revert_file: 'WRITE',
    diff_versions: 'READ',
    run_command: 'EFFECT',
    generate_image: 'EFFECT', analyze_image: 'EFFECT', remove_background: 'EFFECT', search_web: 'EFFECT'
};

// ---- getTools 兜底 ----
function getTools() {
    if (typeof TOOL_DEFINITIONS === 'undefined' || !Array.isArray(TOOL_DEFINITIONS)) {
        if (typeof console !== 'undefined') console.warn('[tools] TOOL_DEFINITIONS not ready, returning empty');
        return [];
    }
    return TOOL_DEFINITIONS;
}
