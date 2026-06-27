// ============================================================================
// tools-exec-effect.js — EFFECT 类工具 + 语义搜索 + 媒体工具执行器
// 从 tools.js 拆分而来。依赖 tools-defs.js 中的 helper 函数。
// ============================================================================

// ═══ search_smart — 语义搜索 (BM25 + Embedding 混合 + 正则 + 符号) ═══
async function executeSearchSmart(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var query = args.query || '';
    if (!query) return 'Error: query is required';

    var topK = args.top_k || 10;
    var searchPath = args.path || null;

    // ★ 走主进程 IPC (请求结构化结果用于 embedding 重排)
    if (bridge.ai && bridge.ai.search_smart) {
        try {
            var _r = await bridge.ai.search_smart({
                query: query,
                topK: topK,
                path: searchPath,
                regex: args.regex || null,
                returnStructured: true  // ★ 请求结构化 BM25 结果
            });

            // ── Embedding 混合重排 ──
            var _textResult = typeof _r === 'string' ? _r : (_r.text || '');
            if (_r && _r.bm25 && _r.bm25.length > 0) {
                try {
                    var _hybridText = await _tryEmbeddingRerank(query, _r);
                    if (_hybridText) {
                        // ★ 重排成功：用混合结果替换 BM25 部分
                        _textResult = _hybridText;
                    }
                } catch (_embErr) {
                    // ★ embedding 失败静默降级：保留原始 BM25 结果
                }
            }

            // content-gateway.js 自动截断
            return _textResult;
        } catch (_) { /* fallback to search_text */ }
    }

    // Fallback: 降级为 search_text
    try {
        var _fb = await bridge.ai.search_text({
            query: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            path: searchPath
        });
        return '[FALLBACK — search_smart IPC unavailable, using search_text]\n' + _fb;
    } catch (_) {
        return 'Error: search_smart IPC not available and fallback failed.';
    }
}

// ═══ Embedding 混合重排：query embedding × BM25 snippets → hybrid score ═══
var _EMBEDDING_LOG = false; // ★ 开关：设 true 开启全链路日志（DevTools console 实时设）
function _embLog(msg) { if (_EMBEDDING_LOG) console.log('[_emb]', msg); }

async function _tryEmbeddingRerank(query, structuredResult) {
    var _t0 = _EMBEDDING_LOG ? performance.now() : 0;

    var _emb = (typeof window !== 'undefined') ? window._qqqEmbedding : null;
    if (!_emb || !_emb.embedBatch || !_emb.rerankWithEmbedding) {
        _embLog('SKIP: _qqqEmbedding not loaded');
        return null;
    }

    // 获取 auth token + floor_id
    var token = '';
    var floorId = '';
    try {
        var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
        if (ag && ag._token) token = ag._token;
        if (ag && ag._floorId) floorId = ag._floorId;
    } catch (_) { }
    if (!token) { _embLog('SKIP: no auth token'); return null; }
    _embLog('auth: token=' + (token ? 'yes' : 'no') + ' floor=' + (floorId || '(new quest)'));

    var bm25Results = structuredResult.bm25 || [];
    _embLog('BM25 raw: ' + bm25Results.length + ' results');

    // ★ 分离 BM25 和符号结果
    var bm25Only = [];
    var symbolOnly = [];
    for (var i = 0; i < bm25Results.length; i++) {
        if (bm25Results[i].matchType === 'symbol') {
            symbolOnly.push(bm25Results[i]);
        } else {
            bm25Only.push(bm25Results[i]);
        }
    }
    _embLog('split: BM25=' + bm25Only.length + ' symbols=' + symbolOnly.length);

    var topN = Math.min(bm25Only.length, 10);
    if (topN === 0) { _embLog('SKIP: no BM25 results for rerank'); return null; }

    // 构建 snippet 列表（截断至 200 字符）
    var snippets = [];
    for (var i = 0; i < topN; i++) {
        var s = bm25Only[i].snippet || '';
        if (s.length > 200) s = s.slice(0, 200);
        snippets.push(s);
    }
    _embLog('batch: ' + snippets.length + ' snippets, total chars=' + snippets.reduce(function (a, b) { return a + b.length; }, 0));

    // ★ 调用 embedding API：[query, ...snippets] → 计费自动发生
    _embLog('API call → embedding...');
    var _apiT0 = _EMBEDDING_LOG ? performance.now() : 0;
    var embResult = await _emb.embedBatch([query].concat(snippets), token, floorId);
    if (_EMBEDDING_LOG) _embLog('API done: ' + (performance.now() - _apiT0).toFixed(0) + 'ms');

    if (!embResult || !embResult.vectors || embResult.vectors.length < 2) {
        _embLog('SKIP: invalid response, vectors=' + (embResult && embResult.vectors ? embResult.vectors.length : 0));
        return null;
    }
    _embLog('vectors: ' + embResult.vectors.length + ' (' + (embResult.vectors[0] && embResult.vectors[0].length || 0) + 'd), tokens=' + embResult.tokenCount);

    var queryVec = embResult.vectors[0];
    var docVecs = embResult.vectors.slice(1);

    // ★ 混合重排
    _embLog('rerank: ' + docVecs.length + ' docs vs query (alpha=0.3)');
    var reranked = _emb.rerankWithEmbedding(queryVec, bm25Only.slice(0, topN), docVecs);
    if (reranked.length > 0) {
        _embLog('top hybrid score: ' + reranked[0]._hybridScore.toFixed(3) + ' | bm25=' + reranked[0]._bm25Score.toFixed(3) + ' emb=' + reranked[0]._embScore.toFixed(3));
    }

    // 构建混合结果输出
    var out = [];
    out.push('══════ SEARCH SMART: "' + query + '" ══════');
    out.push('');
    out.push('── Hybrid (BM25 + Embedding) ──');

    for (var ri = 0; ri < reranked.length; ri++) {
        var r = reranked[ri];
        var lineInfo = r.filePath + (r.line ? ':' + r.line : '');
        var snippet = (r.snippet || '').length > 200 ? r.snippet.slice(0, 200) + '...' : (r.snippet || '');
        out.push('[' + (r.matchType || 'CONTENT').toUpperCase() + '] ' + lineInfo + ' (hybrid:' + r._hybridScore.toFixed(2) + ' bm25:' + r._bm25Score.toFixed(2) + ' emb:' + r._embScore.toFixed(2) + ')');
        out.push('  ' + snippet);
    }
    out.push('');

    // ★ 附加符号匹配结果（不被 embedding 重排影响）
    if (symbolOnly.length > 0) {
        _embLog('symbols: ' + symbolOnly.length + ' appended');
        out.push('── Symbol Matches ──');
        for (var si = 0; si < symbolOnly.length; si++) {
            var sr = symbolOnly[si];
            out.push('[SYMBOL] ' + sr.filePath + ' (score:' + sr.score.toFixed(1) + ')');
            out.push('  ' + sr.snippet);
        }
        out.push('');

        // ★ P3: 符号图 — 每个匹配符号的引用关系
        if (structuredResult.symbolGraph && structuredResult.symbolGraph.length > 0) {
            _embLog('symbolGraph: ' + structuredResult.symbolGraph.length + ' entries');
            out.push('── Symbol Graph ──');
            for (var gi = 0; gi < structuredResult.symbolGraph.length; gi++) {
                var g = structuredResult.symbolGraph[gi];
                var parts = [];
                if (g.definingFiles.length > 0) parts.push('defines: [' + g.definingFiles.join(', ') + ']');
                if (g.exportingFiles.length > 0) parts.push('exports: [' + g.exportingFiles.join(', ') + ']');
                if (g.importingFiles.length > 0) parts.push('imported by: [' + g.importingFiles.slice(0, 5).join(', ') + (g.importingFiles.length > 5 ? ', +' + (g.importingFiles.length - 5) + ' more' : '') + ']');
                if (parts.length > 0) {
                    out.push('  ' + g.symbol + ' [' + g.kind + '] → ' + parts.join(' | '));
                }
            }
            out.push('');
        }
    }

    // 附加 Stats
    out.push('── Stats ──');
    if (structuredResult.fileCount) {
        out.push('Index: ' + structuredResult.fileCount + ' files, ' + structuredResult.chunkCount + ' chunks');
    }
    out.push('BM25: ' + bm25Results.length + ' results');
    out.push('Semantic rerank: ' + embResult.tokenCount + ' tokens');

    if (_EMBEDDING_LOG) _embLog('DONE: ' + out.length + ' lines, total ' + (performance.now() - _t0).toFixed(0) + 'ms');
    return out.join('\n');
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
// _waitForTaskStream — SSE stream 等待异步任务完成（generate/vision 共用）
// ============================================================
// ★ 已废弃：由 AiGateway.pollTaskStream 替代
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
// generate_image — AI 图像生成（全走 Go 代理）
// ============================================================

// ★ 简单 prompt 哈希（8 字符，用于文件名去重 + 追溯）
function _hashPrompt8(p) {
    var h = 0;
    for (var i = 0; i < p.length; i++) {
        h = ((h << 5) - h) + p.charCodeAt(i);
        h |= 0;
    }
    return ('0000000' + Math.abs(h).toString(36)).slice(-8);
}

async function executeGenerateImage(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var prompt = args.prompt || '';
    if (!prompt.trim()) return 'Error: prompt is required';

    // 自动补全 out_dir（直接读 _workspaceRoot，不依赖跨 iframe）
    if (!args.out_dir) {
        try {
            if (typeof _workspaceRoot !== 'undefined' && _workspaceRoot) {
                args.out_dir = _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/qqq/genera';
            }
        } catch (_) { }
    }

	// ★ 经 AiGateway 统一代理
	var token = (function () {
		try {
			var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
			if (ag && ag._token) return ag._token;
		} catch (_) {}
		return '';
	})();
    if (!token) return 'Error: no auth token';

    var outDir = args.out_dir || '';

    try {
        // 1. 经 AiGateway 创建绘图任务
        if (typeof AiGateway === 'undefined' || !AiGateway.imageGenSubmit) {
            return 'Error: AiGateway not available';
        }
        var submitResult = await AiGateway.imageGenSubmit(prompt, {
            style: args.style,
            size: args.size,
            n: args.n,
            token: token
        });
        if (!submitResult || !submitResult.task_id) {
            return 'Image generation failed: could not create task';
        }

        // 2. 经 AiGateway 轮询 SSE 结果
        var result = await AiGateway.imageGenPoll(submitResult.task_id, token);
        if (!result) {
            return 'Image generation failed: no result from stream';
        }
        if (result.error) {
            return 'Image generation failed: ' + result.error;
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

        // ★ 文件名格式：gen_img_{年月日}_{时分秒}_{promptHash8}_{序号}.png
        var _now = new Date();
        var _dateStr = _now.getFullYear() +
            ('0' + (_now.getMonth() + 1)).slice(-2) +
            ('0' + _now.getDate()).slice(-2);
        var _timeStr = ('0' + _now.getHours()).slice(-2) +
            ('0' + _now.getMinutes()).slice(-2) +
            ('0' + _now.getSeconds()).slice(-2);
        var _phash8 = _hashPrompt8(prompt);

        var dlPromises = result.urls.map(function (url, u) {
            var fname = 'gen_img_' + _dateStr + '_' + _timeStr + '_' + _phash8 + '_' + u + '.png';
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

        // ★ stat 每个下载成功的文件，写入全局缓存供 hover 显示文件大小
        if (!window.__qqqImgSizes) window.__qqqImgSizes = {};
        for (var _si = 0; _si < paths.length; _si++) {
            try {
                var _st = await bridge.fs.stat(paths[_si]);
                if (_st && _st.size > 0) {
                    var _normPath = paths[_si].replace(/\\/g, '/');
                    window.__qqqImgSizes[_normPath] = _st.size;
                }
            } catch (__) { }
        }

        // ★ 写元数据索引（_index.json，NDJSON 格式，每批一行）
        try {
            var _indexEntry = JSON.stringify({
                ts: _now.toISOString(),
                prompt: prompt.slice(0, 200),
                style: args.style || '',
                size: args.size || '2K',
                n: paths.length,
                phash: _phash8,
                paths: paths,
                ge_cost: result.ge_cost || 0
            });
            var _indexPath = outDir.replace(/\\/g, '/').replace(/\/$/, '') + '/_index.json';
            // NDJSON 追加：读→追加→写（原子写，防并发竞态）
            var _existing = '';
            try { _existing = await bridge.fs.read(_indexPath); } catch (__) { }
            _existing = (typeof _existing === 'string') ? _existing.trimEnd() : '';
            var _newContent = (_existing ? _existing + '\n' : '') + _indexEntry + '\n';
            await bridge.fs.write(_indexPath, _newContent).catch(function () { });
        } catch (__) { /* 索引非致命 */ }

        return paths.map(function (p) { return '![](file:///' + p.replace(/\\/g, '/') + ')'; }).join('\n');

    } catch (err) {
        return 'Error running image generation: ' + (err.message || err);
    }
}

// ============================================================
// analyze_image — AI 视觉分析（全走 Go 代理）
// ============================================================

async function executeAnalyzeImage(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var image = args.image || '';
    if (!image.trim()) return 'Error: image path is required';

    var action = args.action || 'describe';

    // ★ 经 AiGateway 统一代理
    var token = (function () {
        try {
            var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
            if (ag && ag._token) return ag._token;
        } catch (_) {}
        return '';
    })();
    if (!token) return 'Error: no auth token';

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

        // 3. 经 AiGateway 提交视觉任务
        if (typeof AiGateway === 'undefined' || !AiGateway.visionSubmit) {
            return 'Error: AiGateway not available';
        }
        var submitResult = await AiGateway.visionSubmit(b64, token, {
            prompt: question,
            summary: (action === 'ask' ? question : question.slice(0, 60)),
        });
        if (!submitResult) {
            return 'Image analysis failed: could not create task';
        }

        // 缓存命中
        var content = submitResult.description || '';
        if (submitResult.description !== undefined && !submitResult.task_id) {
            if (submitResult.ge_cost && typeof _addToolGeCost === 'function') {
                _addToolGeCost(submitResult.ge_cost);
            }
            if (!content) return 'Image analysis returned empty result';
        } else if (submitResult.task_id) {
            // 4. 经 AiGateway 轮询 SSE 结果
            var pollResult = await AiGateway.visionPoll(submitResult.task_id, token);
            if (!pollResult || !pollResult.description) {
                return 'Image analysis failed: no result from stream';
            }
            content = pollResult.description;

            // ★ 累加显示用计费
            if (pollResult.ge_cost && typeof _addToolGeCost === 'function') {
                _addToolGeCost(pollResult.ge_cost);
            }
        } else {
            return 'Image analysis failed: unexpected response';
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
// search_web — 经 AiGateway 统一代理
// ============================================================

async function executeSearchWeb(args) {
    var query = args.query || '';
    if (!query.trim()) return 'Error: query is required';

    // ★ 经 AiGateway 统一代理
    var token = (function () {
        try {
            var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
            if (ag && ag._token) return ag._token;
        } catch (_) {}
        return '';
    })();
    if (!token) return 'Error: no auth token';

    try {
        if (typeof AiGateway === 'undefined' || !AiGateway.searchWeb) {
            return 'Error: AiGateway not available';
        }
        var data = await AiGateway.searchWeb(query, { token: token, maxResults: args.maxResults || 20 });
        if (!data || data.length === 0) {
            return 'Search returned no results.';
        }
        if (!data.ok) {
            return 'Search failed: ' + (data.error || 'unknown error');
        }

        // ★ 累加显示用计费（Go 已权威记账，此处仅 UI 展示）
        if (data.ge_cost && typeof _addToolGeCost === 'function') {
            _addToolGeCost(data.ge_cost);
        }

        var results = data.results || [];
        if (results.length === 0) {
            return 'No results found for: ' + query;
        }

        var lines = ['═══ Web Search: "' + query + '" ═══', ''];
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            lines.push((i + 1) + '. ' + r.title);
            lines.push('   ' + r.url);
            if (r.snippet) lines.push('   ' + r.snippet);
            lines.push('');
        }
        lines.push('── ' + results.length + ' results ──');
        return lines.join('\n');

    } catch (err) {
        return 'Error searching web: ' + (err.message || err);
    }
}

// ============================================================
// 导出（Node.js 兼容）
// ============================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TOOL_DEFINITIONS: (typeof TOOL_DEFINITIONS !== 'undefined' ? TOOL_DEFINITIONS : []),
        TOOL_CATEGORY: (typeof TOOL_CATEGORY !== 'undefined' ? TOOL_CATEGORY : {}),
        getTools: (typeof getTools === 'function' ? getTools : function () { return []; }),
        executeTool: (typeof executeTool === 'function' ? executeTool : null)
    };
}
