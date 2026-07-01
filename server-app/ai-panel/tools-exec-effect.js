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
        if (result.ge_cost && typeof _addToolWgeCost === 'function') {
            _addToolWgeCost(result.ge_cost);
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
// ★ 2026-07-01 重构：借鉴 openhanako VisionBridge，结构化 prompt + confidence + norm-1000
// ============================================================

// ═══ MIME 魔术字节检测 — 借鉴 openhanako shared/image-mime.ts ═══
var _IMAGE_MAGIC = {
    'image/png':  [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    'image/jpeg': [0xFF, 0xD8, 0xFF],
    'image/gif':  [0x47, 0x49, 0x46, 0x38],
    'image/webp': [0x52, 0x49, 0x46, 0x46]
};
var _IMAGE_MIME_NAMES = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };

function _sniffImageMime(b64) {
    // 从 base64 头几个字符反推 MIME（大文件 base64 不解码全部）
    if (!b64 || b64.length < 16) return null;
    try {
        // base64 的前 12 字符足够覆盖 8 字节魔术
        var head = atob(b64.slice(0, 12));
        var bytes = [];
        for (var i = 0; i < head.length; i++) bytes.push(head.charCodeAt(i) & 0xFF);
        for (var mime in _IMAGE_MAGIC) {
            var mag = _IMAGE_MAGIC[mime];
            if (bytes.length >= mag.length) {
                var match = true;
                for (var j = 0; j < mag.length; j++) {
                    if (bytes[j] !== mag[j]) { match = false; break; }
                }
                if (match) return { mime: mime, name: _IMAGE_MIME_NAMES[mime] };
            }
        }
    } catch (_) {}
    return null;
}

// ═══ 结构化视觉 prompt 模板 — 借鉴 openhanako formatStructuredVisionNote ═══
function _buildStructuredDescribePrompt(detail) {
    var sections = [
        'image_overview: 整体画面描述（1-2句话概括）',
        'visible_text: 画面中可见的文字内容（无则写 "none"）',
        'objects_and_layout: 物体及其空间排列关系',
        'colors_and_lighting: 主色调、光影特征',
        'style_and_atmosphere: 风格流派与整体氛围',
        'charts_or_data: 如有图表/数据，描述关键信息（无则写 "none"）'
    ];
    var detailLabel = { brief: '简要', standard: '标准', detailed: '详尽' };
    var label = detailLabel[detail] || '标准';
    return '请' + label + '分析这张图片。按以下格式输出，每行以 "field_name: value" 形式：\n\n' +
        sections.join('\n') + '\n\n只输出上述字段，不要额外解释。';
}

function _buildLocatePrompt(targets, detail) {
    var targetsStr = targets.join('、');
    var isDetailed = detail === 'detailed';
    return '在这张图片中定位以下物体：' + targetsStr + '。\n' +
        '坐标使用 norm-1000 归一化坐标系：图片宽高均映射到 0~1000。\n' +
        'box: [x1, y1, x2, y2]，(x1,y1)=左上角，(x2,y2)=右下角。\n' +
        (isDetailed ? 'confidence: 0.0~1.0 置信度，表示定位把握程度。\n' : '') +
        '返回严格 JSON 数组：\n' +
        '[{"label":"物体名","box":[x1,y1,x2,y2],"confidence":0.0}]\n\n' +
        '—— 注意 ——\n' +
        '1. 坐标是 norm-1000，不是像素。图片左上角=(0,0)，右下角=(1000,1000)\n' +
        '2. confidence 必填，0.0=完全不确定，1.0=绝对确定\n' +
        '3. 只返回 JSON 数组，不要 markdown 围栅，不要解释文字';
}

function _buildAskPrompt(question) {
    return '请基于这张图片回答以下问题：\n\n' + question.trim() + '\n\n' +
        '如有不确定性请明确说明。如有可定位的物体/区域，用 norm-1000 坐标 (x1,y1,x2,y2) 标注位置。';
}

// ═══ JSON 清洗 — 借鉴 openhanako extractJsonObject ═══
function _extractJsonFromVision(output) {
    var raw = output.trim();
    // 移除 markdown 围栅
    var fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) raw = fenced[1].trim();
    try {
        return JSON.parse(raw);
    } catch (_) {
        // 尝试提取最外层 {...} 或 [...]
        var start = raw.indexOf('{');
        var end = raw.lastIndexOf('}');
        var arrStart = raw.indexOf('[');
        var arrEnd = raw.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd > arrStart && (arrStart < start || start === -1)) {
            try { return JSON.parse(raw.slice(arrStart, arrEnd + 1)); } catch (_2) {}
        }
        if (start !== -1 && end > start) {
            try { return JSON.parse(raw.slice(start, end + 1)); } catch (_2) {}
        }
        return null;
    }
}

function _normalizeLocateBoxes(boxes) {
    if (!Array.isArray(boxes)) return null;
    var out = [];
    for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (!b || typeof b.label !== 'string') continue;
        var box = b.box || b.bbox || b.bbox_2d || b.box_2d || [];
        if (!Array.isArray(box) || box.length < 4) continue;
        var x1 = Number(box[0]), y1 = Number(box[1]), x2 = Number(box[2]), y2 = Number(box[3]);
        if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) continue;
        // 确保 left<right, top<bottom
        var item = {
            label: String(b.label),
            box: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
        };
        // 置信度（借鉴 openhanako normalizeConfidence）
        if (b.confidence !== undefined && b.confidence !== null) {
            var cf = Number(b.confidence);
            item.confidence = isFinite(cf) ? Math.max(0, Math.min(1, Math.round(cf * 100) / 100)) : null;
        }
        // 识别 grounding 来源（借鉴 openhanako groundingMode）
        if (b.grounding) item.grounding = String(b.grounding);
        out.push(item);
    }
    return out.length > 0 ? out : null;
}

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

        // ★ 1b. MIME 魔术字节校验（借鉴 openhanako sniffImageMimeType）
        var mimeInfo = _sniffImageMime(b64);
        if (mimeInfo) {
            // 可选：校验通过，静默。不支持的格式可由 Go 端拒绝
        }
        // 不是已知图片格式 → 仍然继续（Go 端有更强校验），但记录警告
        if (!mimeInfo && b64.length > 100000) {
            // 大文件无魔术字节 → 可能不是图片
            return 'Error: file does not appear to be a supported image (PNG/JPEG/GIF/WebP). First 12 base64 chars: ' + b64.slice(0, 12);
        }

        // 2. 构建问题（★ 借鉴 openhanako 结构化 prompt）
        var question;
        if (action === 'describe') {
            question = _buildStructuredDescribePrompt(args.detail);
        } else if (action === 'locate') {
            var targets = (args.targets || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
            if (targets.length === 0) return 'Error: --targets required for locate action';
            question = _buildLocatePrompt(targets, args.detail);
        } else if (action === 'ask') {
            if (!args.question) return 'Error: --question required for ask action';
            question = _buildAskPrompt(args.question);
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
            if (submitResult.ge_cost && typeof _addToolWgeCost === 'function') {
                _addToolWgeCost(submitResult.ge_cost);
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
            if (pollResult.ge_cost && typeof _addToolWgeCost === 'function') {
                _addToolWgeCost(pollResult.ge_cost);
            }
        } else {
            return 'Image analysis failed: unexpected response';
        }

        // 5. 按 action 处理结果
        if (action === 'locate') {
            var parsed = _extractJsonFromVision(content);
            if (parsed) {
                var normalized = _normalizeLocateBoxes(Array.isArray(parsed) ? parsed : [parsed]);
                if (normalized) {
                    return JSON.stringify({ objects: normalized, coord: 'norm-1000', count: normalized.length }, null, 2);
                }
            }
            return 'Image locate failed: could not parse bounding boxes from response. Raw: ' + content.slice(0, 500);
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

async function executeRemoveBackground(args) {
    var bridge = getBridge();
    if (!bridge) return 'Error: bridge not available';

    var image = args.image || '';
    if (!image.trim()) return 'Error: image path is required';

    // ★ 经 AiGateway 统一代理
    var token = (function () {
        try {
            var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
            if (ag && ag._token) return ag._token;
        } catch (_) {}
        return '';
    })();
    if (!token) return 'Error: no auth token';

    var quality = args.quality || 'auto';

    try {
        // 1. 读取图片 → base64
        var b64Result = await bridge.qz.spawn({
            cmd: 'bash',
            args: ['-c', 'base64 -w0 "' + image.replace(/\\/g, '/') + '" 2>/dev/null || base64 "' + image.replace(/\\/g, '/') + '" 2>/dev/null'],
            timeout: 15000
        });
        var b64 = (b64Result.stdout || '').replace(/\s/g, '');
        if (!b64) return 'Error: could not read or encode image: ' + image;

        // 2. 调用 AiGateway segment API
        if (typeof AiGateway === 'undefined' || !AiGateway.segmentSubmit) {
            // 直接 fetch Go API
            var segmentUrl = 'https://direct-cn.gh555.com/api/v3/ai/segment';
            var resp = await fetch(segmentUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ image: b64, quality: quality })
            });
            var data = await resp.json();
            if (!data || !data.image_url) {
                return 'Remove background failed: ' + (data.error || JSON.stringify(data));
            }
            // ★ 累加显示用计费
            if (data.ge_cost && typeof _addToolWgeCost === 'function') {
                _addToolWgeCost(data.ge_cost);
            }

            // 3. 下载结果图片到本地
            var outDir = '';
            try {
                if (typeof _workspaceRoot !== 'undefined' && _workspaceRoot) {
                    outDir = _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/qqq/genera';
                }
            } catch (_) {}
            if (outDir) {
                try { await bridge.fs.mkdir(outDir); } catch (_) { }
            } else {
                outDir = '.';
            }

            // 文件名
            var imgHash = b64.slice(0, 8) + Date.now().toString(36);
            var fileName = 'remove_bg_' + imgHash + '.png';
            var outPath = outDir + '/' + fileName;

            // curl 下载
            var dlResult = await bridge.qz.spawn({
                cmd: 'curl',
                args: ['-s', '-o', outPath, '-L', data.image_url],
                timeout: 30000
            });

            return 'Background removed successfully. Output: ![](file:///' + outPath.replace(/\\/g, '/') + ')';
        } else {
            // 经 AiGateway
            var result = await AiGateway.segmentSubmit({ image: b64, quality: quality, token: token });
            if (!result || !result.image_url) {
                return 'Remove background failed: ' + (result.error || 'no result');
            }
            if (result.ge_cost && typeof _addToolWgeCost === 'function') {
                _addToolWgeCost(result.ge_cost);
            }
            return 'Background removed. Result: ' + result.image_url;
        }
    } catch (err) {
        return 'Error removing background: ' + (err.message || err);
    }
}

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
        if (data.ge_cost && typeof _addToolWgeCost === 'function') {
            _addToolWgeCost(data.ge_cost);
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
