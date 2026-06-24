// ============================================================================
// tools-exec-write.js — 文件写入工具执行器（edit / write / create / delete）
// 从 tools.js 拆分而来。依赖 tools-defs.js 中的 helper 函数。
// ============================================================================

// ══════════════════════════════════════════════════════════════
// 自动语法检查 — 每次写入后静默运行（副作用附加到结果字符串）
// ══════════════════════════════════════════════════════════════

function _autoSyntaxCheck(filePath) {
    var ext = (filePath || '').split('.').pop().toLowerCase();
    var bridge = getBridge();
    if (!bridge || !bridge.qz || !bridge.qz.spawn) return Promise.resolve('');

    // ── JSON: 直接 parse，不 spawn 进程 ──
    if (ext === 'json') {
        return bridge.fs.read(filePath).then(function (content) {
            try { JSON.parse(content); return '\n[SYNTAX OK] ' + ext; } catch (e) {
                return '\n[SYNTAX ERROR] JSON parse: ' + (e.message || e);
            }
        }).catch(function () { return ''; });
    }

    var cmd, args;
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs') { cmd = 'node'; args = ['--check', filePath]; }
    else if (ext === 'py') { cmd = 'python'; args = ['-m', 'py_compile', filePath]; }
    else { return Promise.resolve(''); }

    return bridge.qz.spawn({ cmd: cmd, args: args, timeout: 5000 }).then(function (r) {
        if (r.code === 0) return '\n[SYNTAX OK] ' + ext;
        var errMsg = (r.stderr || r.stdout || '').split('\n').slice(0, 3).join(' ');
        return '\n[SYNTAX ERROR] ' + ext + ': ' + errMsg;
    }).catch(function (e) {
        return '\n[SYNTAX CHECK FAILED] ' + ext + ' — ' + (e.message || e);
    });
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

    // ★ 参数名兼容：Qoder/DeepSeek 可能用 filePath 而非 path
    args.path = args.path || args.filePath || '';
    var _p = args.path;
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

    args.path = args.path || args.filePath || '';
    var _p = args.path;
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
// create_file
// ============================================================

async function executeCreateFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    args.path = args.path || args.filePath || '';
    var _p = args.path;
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
// delete_file
// ============================================================

async function executeDeleteFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    args.path = args.path || args.filePath || '';
    var _p = args.path;
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
