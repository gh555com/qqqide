// ============================================================================
// agent-sse.js — SSE 流解析 + 文本工具调用回生引擎
// 从 agent-loop.js 拆分，为 AgentLoop.prototype 添加 _parseSSE 方法
// 依赖：AgentLoop（由 agent-loop.js 定义），EnvelopeStripper（由 agent-envelope.js 定义）
// ============================================================================

// ---- SSE 解析 ----
AgentLoop.prototype._parseSSE = async function (body, onToken, onReasoning) {
    var self = this;
    var streamStart = performance.now();
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var reasoningContent = '';
    var toolCalls = [];
    var firstTokenSeen = false;
    var stripper = new EnvelopeStripper(onToken);
    var _usage = null;
    var _finishReason = '';
    var _sseError = null;  // ★ 服务端 SSE 错误事件（提升到外层避免被 JSON catch 吞掉）

    // ★ 流级别看门狗：180s 无数据 → 连接已死，主动 abort
    //   深度推理可能 120s+ 无 token，180s 防误杀
    //   output_watchdog 已移除 — AI 推理不限时，信任模型自行收敛
    var _streamWatchdog = null;
    var STREAM_WATCHDOG_MS = (typeof ContentGateway !== 'undefined' ? ContentGateway.STREAM_WATCHDOG_MS : 180000);  // ★ 唯一真理在 ContentGateway
    function _resetStreamWatchdog() {
        if (_streamWatchdog) clearTimeout(_streamWatchdog);
        _streamWatchdog = setTimeout(function () {
            self._abortSource = 'stream_watchdog';
            self._log('⏰ stream watchdog ' + (STREAM_WATCHDOG_MS / 1000) + 's — no data, aborting dead connection');
            if (self.abortController) self.abortController.abort();
        }, STREAM_WATCHDOG_MS);
    }
    _resetStreamWatchdog();

    while (true) {
        var readResult;
        try {
            readResult = await reader.read();
        } catch (readErr) {
            // AbortError = 主动中断（guide/用户停止），不是连接问题
            // 重新抛出原始 AbortError 让 _callGateway 的 catch 识别处理
            if (readErr && readErr.name === 'AbortError') {
                self._log('■ reader aborted (intentional)');
                clearTimeout(_streamWatchdog);
                throw readErr;  // 直接抛 AbortError，不被包装成普通 Error
            }
            // 其他异常 = 连接断开（HTTP/2 RST_STREAM 等）
            self._log('✗ reader.read() threw: ' + (readErr.message || readErr));
            _sseError = { code: 0, message: 'Stream interrupted: ' + (readErr.message || 'connection lost') };
            break;
        }
        if (readResult.done) break;
        _resetStreamWatchdog();  // ★ 每次收到数据重置看门狗
        buffer += decoder.decode(readResult.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            // SSE 注释行（心跳）— 忽略但证明连接活着
            if (line.charAt(0) === ':') continue;
            if (!line || line.slice(0, 6) !== 'data: ') continue;
            var data = line.slice(6);
            if (data === '[DONE]') continue; // don't break — billing/usage event may follow
            var chunk;
            try { chunk = JSON.parse(data); } catch (_) { continue; }

            if (chunk.type === 'billing') {
                self._floorCostWge += chunk.ge_cost || 0;
                if (chunk.free_window) self._floorFree = true;
                // ★ 记账埋点：保存完整 billing 数据供 house 关联 + 事后审计
                self._billingSeq++;
                self._lastBilling = {
                    seq: self._billingSeq,
                    geCost: chunk.ge_cost || 0,
                    model: chunk.model || '',
                    cacheHitRate: (typeof chunk.cache_hit_rate === 'number') ? chunk.cache_hit_rate : -1,
                    usage: chunk.usage ? {
                        prompt_tokens: chunk.usage.prompt_tokens || 0,
                        completion_tokens: chunk.usage.completion_tokens || 0,
                        cached_tokens: chunk.usage.cached_tokens || 0,
                        non_cached_tokens: chunk.usage.non_cached_tokens || 0
                    } : null,
                    freeWindow: chunk.free_window || false,
                    requestId: chunk.request_id || '',
                    ts: Date.now()
                };
                if (self._billingDebug && typeof self._log === 'function') {
                    var _hr = (typeof chunk.cache_hit_rate === 'number') ? (chunk.cache_hit_rate.toFixed(1) + '%') : '?';
                    self._log('💰 billing #' + self._billingSeq + ': ' + (chunk.ge_cost / 10000).toFixed(4) + ' ge | model=' + (chunk.model || '?') + ' | prompt=' + ((chunk.usage && chunk.usage.prompt_tokens) || '?') + ' cached=' + ((chunk.usage && chunk.usage.cached_tokens) || '?') + ' hit=' + _hr + (chunk.free_window ? ' [FREE]' : ''));
                }
                continue;
            }
            // ★ 服务端 SSE 错误事件（upstream 失败后通过 SSE 通知客户端）
            if (chunk.type === 'error') {
                _sseError = chunk;
                break;  // 跳出 for 循环
            }

            // 流尾 usage（include_usage:true）— 精确上下文 token 数
            if (chunk.usage && chunk.usage.prompt_tokens) {
                _usage = chunk.usage;
                continue;
            }

            var choice0 = chunk.choices && chunk.choices[0];
            // 捕获 finish_reason（最后一帧才有）
            if (choice0 && choice0.finish_reason) {
                _finishReason = choice0.finish_reason;
            }
            var delta = choice0 && choice0.delta;
            if (!delta) continue;

            if (delta.reasoning_content) {
                reasoningContent += delta.reasoning_content;
                onReasoning(delta.reasoning_content);
            }
            if (delta.content) {
                stripper.push(delta.content);
            }
            if (delta.tool_calls) {
                for (var ti = 0; ti < delta.tool_calls.length; ti++) {
                    var tc = delta.tool_calls[ti];
                    if (tc.index !== undefined) {
                        if (!toolCalls[tc.index]) {
                            toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                        }
                        if (tc.id) toolCalls[tc.index].id = tc.id;
                        if (tc.function && tc.function.name) toolCalls[tc.index].function.name += tc.function.name;
                        if (tc.function && tc.function.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                    }
                }
            }
        }
        if (_sseError) break;  // ★ 跳出 while 循环
    }

    clearTimeout(_streamWatchdog);

    // ★ 服务端 SSE 错误 → 向上抛出（不再被 JSON catch 吞掉）
    if (_sseError) {
        var _errMsg = _sseError.message || 'Server error (' + (_sseError.code || 500) + ')';
        var _errFull = '✗ SSE error: code=' + (_sseError.code || '?') + ' msg=' + _errMsg + ' floor=' + (self._ctx ? self._ctx.totalFloors : '?') + ' house=' + (self._houseIndex || '?');
        self._log(_errFull);
        if (typeof self._writeFileLog === 'function') self._writeFileLog(_errFull);
        if (_sseError.code === 400 || _sseError.code === 422 || _sseError.code === 502 || _sseError.code === 503) {
            self._lastGatewayError = _sseError.code;
        }
        // 如果已有部分内容，仍然返回（不丢数据）
        if (stripper.raw && stripper.raw.length > 20) {
            self._log('  (partial content preserved: ' + stripper.raw.length + ' chars)');
        } else {
            throw new Error(_errMsg);
        }
    }

    var finalized = stripper.finalize();

    // ★ 兜底提取：若 EnvelopeStripper 没提取到文本工具调用，直接从 stripper.raw 扫描
    //    模型在卡死时会输出多种文本工具调用格式：
    //      A) <function_calls><invoke name="X"><parameter name="K">V</parameter></invoke></function_calls>
    //      B) <search_text><pattern>...</pattern><path>...</path></search_text> （工具名直作标签）
    //      C) <Tool Call: list_files><Parameter name="k">v</Parameter></Tool Call>
    if (!finalized.textToolCalls || finalized.textToolCalls.length === 0) {
        var _rawFallback = stripper.raw || '';
        var _fbBlocks = [];

        // ── 格式 A: <invoke name="X"> ──
        var _fbInvokeRe = /<invoke\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
        var _fbm;
        while ((_fbm = _fbInvokeRe.exec(_rawFallback)) !== null) {
            var _fbName = _fbm[1];
            var _fbBody = _fbm[2];
            var _fbArgs = {};
            var _fbParamRe = /<parameter\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*?(?:>([\s\S]*?)<\/parameter>|\bvalue\s*=\s*["']([^"']*)["'][^>]*\/>)/gi;
            var _fbpm;
            while ((_fbpm = _fbParamRe.exec(_fbBody)) !== null) {
                var _fbpName = _fbpm[1];
                var _fbpVal = (_fbpm[2] !== undefined) ? _fbpm[2].trim() : (_fbpm[3] || '');
                try { _fbpVal = JSON.parse(_fbpVal); } catch (_) { }
                _fbArgs[_fbpName] = _fbpVal;
            }
            _fbBlocks.push({ name: _fbName, args: _fbArgs });
        }

        // ── 格式 B: <tool_name><k1>v1</k1><k2>v2</k2></tool_name> ──
        //    模型把 read_file/search_text/find_files 等直接当标签名
        var _fbToolNames = ['read_file', 'search_file', 'edit_file', 'search_text', 'search_content',
            'list_files', 'find_files', 'create_file', 'delete_file', 'fetch_webpage',
            'get_diagnostics', 'generate_image', 'analyze_image', 'run_command', 'write_file',
            'search_web'];
        for (var _tni = 0; _tni < _fbToolNames.length; _tni++) {
            var _tn = _fbToolNames[_tni];
            var _fbToolTagRe = new RegExp('<' + _tn + '>([\\s\\S]*?)<\\/' + _tn + '>', 'gi');
            var _ftm;
            while ((_ftm = _fbToolTagRe.exec(_rawFallback)) !== null) {
                var _ftBody = _ftm[1];
                var _ftArgs = {};
                // 提取子标签 <key>value</key> 对
                var _ftSubRe = /<(\w[\w-]*)>([\s\S]*?)<\/\1>/gi;
                var _ftsm;
                while ((_ftsm = _ftSubRe.exec(_ftBody)) !== null) {
                    var _ftKey = _ftsm[1];
                    // 跳过常见非参数标签
                    if (/^(?:max_results|filetypes|recursive|string|include_pattern)$/i.test(_ftKey)) {
                        // try to treat value as string
                        var _ftVal = _ftsm[2].trim();
                        try { _ftVal = JSON.parse(_ftVal); } catch (_) { }
                        _ftArgs[_ftKey] = _ftVal;
                    } else {
                        _ftArgs[_ftKey] = _ftsm[2].trim();
                    }
                }
                _fbBlocks.push({ name: _tn, args: _ftArgs });
            }
        }

        // ── 格式 C: <Tool Call: tool_name><Parameter name="k">v</Parameter></Tool Call> ──
        var _fbToolCallRe = /<Tool\s+Call:\s*(\w[\w.-]*)>([\s\S]*?)<\/Tool\s+Call>/gi;
        var _tcm;
        while ((_tcm = _fbToolCallRe.exec(_rawFallback)) !== null) {
            var _tcName = _tcm[1];
            var _tcBody = _tcm[2];
            var _tcArgs = {};
            var _tcParamRe = /<Parameter\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/Parameter>/gi;
            var _tpm;
            while ((_tpm = _tcParamRe.exec(_tcBody)) !== null) {
                var _tpVal = _tpm[2].trim();
                try { _tpVal = JSON.parse(_tpVal); } catch (_) { }
                _tcArgs[_tpm[1]] = _tpVal;
            }
            _fbBlocks.push({ name: _tcName, args: _tcArgs });
        }

        // ── 格式 D: <Tool_call name="X"><parameter name="k" string="true">v</parameter></Tool_call> ──
        //    模型在卡死时输出，q98 实测格式：Tool_call（下划线）+ name= 属性
        var _fbTcUnderscoreRe = /<[Tt]ool_call\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/[Tt]ool_call>/gi;
        var _tcm2;
        while ((_tcm2 = _fbTcUnderscoreRe.exec(_rawFallback)) !== null) {
            var _tcName2 = _tcm2[1];
            var _tcBody2 = _tcm2[2];
            var _tcArgs2 = {};
            var _tcParamRe2 = /<parameter\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
            var _tpm2;
            while ((_tpm2 = _tcParamRe2.exec(_tcBody2)) !== null) {
                var _tpVal2 = _tpm2[2].trim();
                // string="false" → 尝试 JSON 解析（数字/布尔），string="true" → 保留字符串
                try { _tpVal2 = JSON.parse(_tpVal2); } catch (_) { }
                _tcArgs2[_tpm2[1]] = _tpVal2;
            }
            if (Object.keys(_tcArgs2).length > 0) {
                _fbBlocks.push({ name: _tcName2, args: _tcArgs2 });
            }
        }

        if (_fbBlocks.length > 0) {
            finalized.textToolCalls = [];
            for (var _fbi = 0; _fbi < _fbBlocks.length; _fbi++) {
                var _fbb = _fbBlocks[_fbi];
                var _fbCallId = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                finalized.textToolCalls.push({
                    id: _fbCallId,
                    type: 'function',
                    function: { name: _fbb.name, arguments: JSON.stringify(_fbb.args) }
                });
            }
            self._log('🔄 fallback textToolCalls: parsed ' + _fbBlocks.length + ' tool(s) from raw content');
            // 从 cleanContent 剥离已解析的文本工具调用块（防止显示给用户）
            finalized.cleanContent = (finalized.cleanContent || '')
                .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
                .replace(/<Tool\s+Call:\s*\w[\w.-]*>[\s\S]*?<\/Tool\s+Call>/gi, '')
                .replace(/\x0a{3,}/g, '\x0a\x0a').trim();
        }
    }

    var _streamMs = performance.now() - streamStart;
    if (toolCalls.length > 0) {
        return { type: 'tool_calls', tool_calls: toolCalls.filter(Boolean), content: finalized.cleanContent || '', reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage };
    }
    // ★ 文本工具调用回生：模型在 content 中输出 Action: 格式而非原生 delta.tool_calls
    //    解析后回送给 agent-loop 正常执行，防止楼层空转（5秒中断无限循环）
    if (finalized.textToolCalls && finalized.textToolCalls.length > 0) {
        self._log('🔄 textToolCalls: parsed ' + finalized.textToolCalls.length + ' tool(s) from content → executing');
        return { type: 'tool_calls', tool_calls: finalized.textToolCalls, content: finalized.cleanContent || '', reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage };
    }
    if (finalized.cleanContent) {
        // 检测 max_tokens 截断
        var content = finalized.cleanContent;
        if (_finishReason === 'length' && content.length > 100) {
            var lastChar = content[content.length - 1];
            var abruptEnd = !/[。！？.!?\n)\]]/.test(lastChar);
            if (abruptEnd) {
                content += '\n\n⚠️ Response truncated due to token limit. Reply "continue" to get the full content.';
            }
        }
        return { type: 'message', content: content, reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage, _finishReason: _finishReason };
    }
    // 仅有 usage 无内容 → 上游可能拒绝了请求（上下文超限等）
    if (_usage && _usage.prompt_tokens) {
        var _msg = '⚠ SSE ended with usage only, no content — upstream likely rejected request (prompt_tokens=' + _usage.prompt_tokens + ' total_tokens=' + (_usage.total_tokens || '?') + ' completion_tokens=' + (_usage.completion_tokens || '?') + ')';
        self._log(_msg);
        if (typeof self._writeFileLog === 'function') self._writeFileLog(_msg);
    }
    // ★ 将 SSE 错误传回给 _callGateway，防止 onError 时 _lastGatewayMessage 落空
    if (_sseError) self._sseError = _sseError;
    return null;
};
