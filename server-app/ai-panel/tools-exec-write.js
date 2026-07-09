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

    var cmd, args, cwd, timeout, _isTs;
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs') { cmd = 'node'; args = ['--check', filePath]; }
    else if (ext === 'py') { cmd = 'python'; args = ['-m', 'py_compile', filePath]; }
    else if (ext === 'ts' || ext === 'tsx') {
        // TypeScript: npx tsc --noEmit. Let tsc walk up to find tsconfig.json.
        var _dir = filePath.replace(/\\/g, '/');
        var _lastSep = _dir.lastIndexOf('/');
        if (_lastSep > 0) _dir = _dir.substring(0, _lastSep);
        cmd = 'npx'; args = ['tsc', '--noEmit', '--pretty', 'false']; cwd = _dir;
        _isTs = true;
    }
    else { return Promise.resolve(''); }

    timeout = _isTs ? 12000 : 5000;
    return bridge.qz.spawn({ cmd: cmd, args: args, timeout: timeout, cwd: cwd || '' }).then(function (r) {
        if (r.code === 0) return '\n[SYNTAX OK] ' + ext;
        var output = (r.stderr || '') + '\n' + (r.stdout || '');
        if (_isTs) {
            // Filter: only errors referencing this file (not other files in project)
            var lines = output.split('\n');
            var relevant = [];
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].indexOf(filePath) !== -1) relevant.push(lines[i]);
            }
            if (relevant.length === 0) return '\n[SYNTAX OK] ts';
            return '\n[SYNTAX ERROR] ts: ' + relevant.slice(0, 3).join('\n');
        }
        var errMsg = (r.stderr || r.stdout || '').split('\n').slice(0, 3).join(' ');
        return '\n[SYNTAX ERROR] ' + ext + ': ' + errMsg;
    }).catch(function (e) {
        if (_isTs) return ''; // tsc not available → silent degrade
        return '\n[SYNTAX CHECK FAILED] ' + ext + ' — ' + (e.message || e);
    });
}

// ============================================================
// edit_file — 精准文件编辑引擎（三级降级匹配 + 原子性）
// 移植自 q3/ai/src/tools.js
// ============================================================

function _normalizeWhitespace(text) {
    return text.replace(/[\t ]+/g, ' ').replace(/[\r\n]+/g, '\n').replace(/^ +| +$/gm, '');
}

// ★ 空白匹配 span 精确测量：从原文 start 位置逐字节推进，归一化后与 normFind 比较。
// 不依赖 find.length，不依赖行号 → 适用于一切场景，零边界漏洞。
function _measureNormSpan(orig, start, findText, normFn) {
    var normFind = normFn(findText);
    for (var end = start + 1; end <= orig.length; end++) {
        if (normFn(orig.slice(start, end)) === normFind) return end - start;
    }
    return findText.length; // 兜底
}

function _findMatch(content, find) {
    // L1: 精确匹配
    var idx1 = content.indexOf(find);
    if (idx1 !== -1) return { start: idx1, end: idx1 + find.length, matchLevel: 1 };

    // L1b: CRLF 归一化 (\r\n→\n, \r→\n)
    var normCRLF = function (s) { return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); };
    var nfCRLF = normCRLF(find);
    var ncCRLF = normCRLF(content);
    var idxCRLF = ncCRLF.indexOf(nfCRLF);
    if (idxCRLF !== -1) {
        // 映射归一化下标 → 原文起始
        var oi = 0, ni = 0;
        while (ni < idxCRLF && oi < content.length) {
            if (content[oi] === '\r' && content[oi + 1] === '\n') { oi += 2; ni++; }
            else if (content[oi] === '\r') { oi++; ni++; }
            else { oi++; ni++; }
        }
        var spanCRLF = _measureNormSpan(content, oi, find, normCRLF);
        return { start: oi, end: oi + spanCRLF, matchLevel: 1 };
    }

    // L1c: real \n → escaped \n (AI sent literal \n via JSON)
    if (find.indexOf('\n') !== -1) {
        var escaped = find.replace(/\n/g, '\\n');
        var idx1c = content.indexOf(escaped);
        if (idx1c !== -1) return { start: idx1c, end: idx1c + escaped.length, matchLevel: 1 };
    }

    // L2: 空白归一化（[\t ]+→' ', [\r\n]+→\n）
    var nf = _normalizeWhitespace(find);
    var nc = _normalizeWhitespace(content);
    var idx2 = nc.indexOf(nf);
    if (idx2 !== -1) {
        // 映射归一化下标 → 原文起始
        var oi2 = 0, ni2 = 0;
        while (ni2 < idx2 && oi2 < content.length) {
            var c = content[oi2];
            if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
                var ncChar = nc[ni2];
                if (ncChar === ' ' || ncChar === '\n') { oi2++; ni2++; }
                else oi2++;
            } else { oi2++; ni2++; }
        }
        var spanWS = _measureNormSpan(content, oi2, find, _normalizeWhitespace);
        return { start: oi2, end: oi2 + spanWS, matchLevel: 2 };
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
    // L4: raw byte match (Buffer.indexOf, zero processing, last resort)
    try {
        var findBuf = new TextEncoder().encode(find);
        var contentBuf = new TextEncoder().encode(content);
        var idx4 = -1;
        for (var bi = 0; bi <= contentBuf.length - findBuf.length; bi++) {
            var ok = true;
            for (var bj = 0; bj < findBuf.length; bj++) { if (contentBuf[bi + bj] !== findBuf[bj]) { ok = false; break; } }
            if (ok) { idx4 = bi; break; }
        }
        if (idx4 !== -1) {
            var s = '';
            for (var ci = 0; ci < idx4; ci++) s += String.fromCharCode(contentBuf[ci]);
            var e = s;
            for (var cj = 0; cj < findBuf.length; cj++) e += String.fromCharCode(contentBuf[idx4 + cj]);
            return { start: s.length, end: e.length, matchLevel: 4 };
        }
    } catch (_) {}
    return null;
}

async function executeEditFile(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';
    if (!args.edits || args.edits.length === 0) return 'Error: no edits provided.';

    // ★ 参数名兼容：模型可能用 filePath 而非 path
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
                // ★ Auto-fix: real \n → literal \n (AI sent literal \n via JSON, became real newline; file has literal backslash-n)
                if (edit.find.indexOf('\n') !== -1) {
                    var esc = edit.find.replace(/\n/g, '\\n');
                    var m2 = _findMatch(content, esc);
                    if (m2) { edit.find = esc; m = m2; }
                }
                if (!m) {
                    var _err = 'Error: edit #' + (i + 1) + ' match failed — text not found in ' + (args.path.split(/[\\/]/).pop()) + '.' + hint;
                    return _maybeHintBackslashN(_err, args.edits);
                }
            }
            matchPlan.push({ edit: edit, match: m, index: i });
        }

        // Phase 2: 按顺序应用
        for (var pi = 0; pi < matchPlan.length; pi++) {
            var plan = matchPlan[pi];
            var ed = plan.edit;
            if (ed.replace_all) {
                var count = content.split(ed.find).length - 1;
                if (count === 0 && ed.find.indexOf('\n') !== -1) { var esc2 = ed.find.replace(/\n/g, '\\n'); var count2 = content.split(esc2).length - 1; if (count2 > 0) { ed.find = esc2; count = count2; } }
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
