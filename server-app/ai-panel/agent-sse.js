// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// agent-sse.js — SSE 流解析 + 文本工具调用回生引擎 + 计费事件处理
// 从 agent-loop.js 拆分，为 AgentLoop.prototype 添加 _parseSSE / _processBillingEvent 方法
// 依赖：AgentLoop（由 agent-loop.js 定义），EnvelopeStripper（由 agent-envelope.js 定义）
// ============================================================================

// ═══ 计费事件处理 — 唯一真理源（_parseSSE 和 _callCompactAPI 共用） ═══
// ★ 同一 house 内多次 billing 事件 → 累加 wgeCost，保留最新元数据
//   正常路径：每 house 仅一次 billing → _lastBilling 为 null → 新建对象
//   压缩路径：_callCompactAPI 可能多次调用 → _lastBilling 已存在 → 累加
AgentLoop.prototype._processBillingEvent = function (parsed) {
    var self = this;
    var cost = parsed.ge_cost || 0;
    self._floorCostWge += cost;
    // (free label logic moved to _floorCostWge===0 check)
    self._floorHadBilling = true;
    self._billingSeq++;
    if (self._lastBilling) {
        // ★ 累加模式（压缩路径多次 API 调用）
        self._lastBilling.wgeCost += cost;
        self._lastBilling.seq = self._billingSeq;
        self._lastBilling.requestId = parsed.request_id || self._lastBilling.requestId;
        self._lastBilling.model = parsed.model || self._lastBilling.model;
        self._lastBilling.cacheHitRate = (typeof parsed.cache_hit_rate === 'number') ? parsed.cache_hit_rate : self._lastBilling.cacheHitRate;
        if (parsed.usage) {
            self._lastBilling.usage = {
                prompt_tokens: parsed.usage.prompt_tokens || 0,
                completion_tokens: parsed.usage.completion_tokens || 0,
                cached_tokens: parsed.usage.cached_tokens || 0,
                non_cached_tokens: parsed.usage.non_cached_tokens || 0
            };
        }
    } else {
        // ★ 新建模式（正常路径首次 billing）
        self._lastBilling = {
            seq: self._billingSeq,
            wgeCost: cost,
            model: parsed.model || '',
            cacheHitRate: (typeof parsed.cache_hit_rate === 'number') ? parsed.cache_hit_rate : -1,
            usage: parsed.usage ? {
                prompt_tokens: parsed.usage.prompt_tokens || 0,
                completion_tokens: parsed.usage.completion_tokens || 0,
                cached_tokens: parsed.usage.cached_tokens || 0,
                non_cached_tokens: parsed.usage.non_cached_tokens || 0
            } : null,
            freeWindow: parsed.free_window || false,
            requestId: parsed.request_id || '',
            ts: Date.now()
        };
    }
    if (self._billingDebug && typeof self._log === 'function') {
        var _hr = (typeof parsed.cache_hit_rate === 'number') ? (parsed.cache_hit_rate.toFixed(1) + '%') : '?';
        self._log('💰 billing #' + self._billingSeq + ': ' + (cost / 10000).toFixed(4) + ' ge | model=' + (parsed.model || '?') + ' | prompt=' + ((parsed.usage && parsed.usage.prompt_tokens) || '?') + ' cached=' + ((parsed.usage && parsed.usage.cached_tokens) || '?') + ' hit=' + _hr + (parsed.free_window ? ' [FREE]' : ''));
    }
};

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

    // ★ 流级别看门狗：180s 无任何数据（含心跳）→ 连接已死，主动 abort
    //   深度推理可能 120s+ 无 token，180s 防误杀
    //   output_watchdog 已移除 — AI 推理不限时，信任模型自行收敛
    var _streamWatchdog = null;
    var STREAM_WATCHDOG_MS = (typeof ContentGateway !== 'undefined' ? ContentGateway.STREAM_WATCHDOG_MS : 180000);  // ★ 唯一真理在 ContentGateway
    function _resetStreamWatchdog() {
        if (_streamWatchdog) clearTimeout(_streamWatchdog);
        var _ctrl = self.abortController;  // ★ 捕获当前 AbortController，防 retry 替换后旧 timer 误杀新请求
        _streamWatchdog = setTimeout(function () {
            self._abortSource = 'stream_watchdog';
            self._log('⏰ stream watchdog ' + (STREAM_WATCHDOG_MS / 1000) + 's — no data, aborting dead connection');
            if (_ctrl) _ctrl.abort();
        }, STREAM_WATCHDOG_MS);
    }
    // ★ 内容级看门狗（2026-08-11 q184 15min 空白事故）：首 token 后流式输出间隔 >45s
    //   （含心跳——服务器心跳会重置流级看门狗但无内容）→ 上游挂起，主动 abort 走恢复链
    //   （agent-gateway: 同 URL 退避重试 3 次 → 切线路）。模型流式输出间隔正常 <10s，45s 防误杀。
    //   推理期（首 token 前）不启动——由流级 180s 覆盖深度推理长思考。
    var _contentWatchdog = null;
    var _contentSeen = false;
    var CONTENT_WATCHDOG_MS = 45000;
    function _resetContentWatchdog() {
        _contentSeen = true;
        if (_contentWatchdog) clearTimeout(_contentWatchdog);
        var _ctrlC = self.abortController;
        _contentWatchdog = setTimeout(function () {
            self._abortSource = 'content_watchdog';
            self._log('⏰ content watchdog ' + (CONTENT_WATCHDOG_MS / 1000) + 's — no content delta (heartbeat only), aborting stalled stream');
            if (typeof self._writeFileLog === 'function') self._writeFileLog('⏰ content watchdog ' + (CONTENT_WATCHDOG_MS / 1000) + 's — stalled stream aborted');
            if (_ctrlC) _ctrlC.abort();
        }, CONTENT_WATCHDOG_MS);
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
        _resetStreamWatchdog();  // ★ 每次收到数据重置看门狗（含心跳：TCP活着信号）
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
                self._processBillingEvent(chunk);
                // ★ 通知父窗口：LV/GE/免费预算 全路径事件驱动
                try { parent.postMessage({ type: 'qqq-lv-tick', geCost: (chunk.ge_cost || 0), freeWindow: !!chunk.free_window }, '*'); } catch (_) { }
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
                _resetContentWatchdog();  // ★ 内容级：思维链也算产出
            }
            if (delta.content) {
                stripper.push(delta.content);
                _resetContentWatchdog();  // ★ 内容级：文本产出重置
            }
            if (delta.tool_calls) {
                _resetContentWatchdog();  // ★ 内容级：工具调用流也算产出
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

    // ★ 捕获 SSE 错误标记（在 _sseError 可能被清空前保存，供后续返回标记用）
    var _hadSseError = !!_sseError;
    var _sseErrorCode = _sseError ? (_sseError.code || 0) : 0;
    var _sseErrorMessage = _sseError ? (_sseError.message || '') : '';

    clearTimeout(_streamWatchdog);
    if (_contentWatchdog) { clearTimeout(_contentWatchdog); _contentWatchdog = null; }

    // ★ 服务端 SSE 错误 → 向上抛出（不再被 JSON catch 吞掉）
    if (_sseError) {
        var _errMsg = _sseError.message || 'Server error (' + (_sseError.code || 500) + ')';
        var _errFull = '✗ SSE error: code=' + (_sseError.code || '?') + ' msg=' + _errMsg + ' floor=' + (self._ctx ? self._ctx.totalFloors : '?') + ' house=' + (self._houseIndex || '?');
        self._log(_errFull);
        if (typeof self._writeFileLog === 'function') self._writeFileLog(_errFull);
        if (ContentGateway.HttpError.shouldCaptureAsGatewayError(_sseError.code)) {
            self._lastGatewayError = _sseError.code;
        }
        // 如果已有部分内容，仍然返回（不丢数据），但标记为被截断
        if (stripper.raw && stripper.raw.length > 20) {
            self._log('  (partial content preserved: ' + stripper.raw.length + ' chars — will trigger onError after push)');
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

        // ── 格式 E: [A → tool_name] args…（客户端显示格式被模型模仿输出）──
        //    长上下文（biscuit 满屏 [A → …] 显示行）下 fast 模型偶发以纯文本模仿工具调用格式
        //    （q178 f23/f27 事故实锤：服务端只收到 1 个请求，模型回复 = 文本工具行 + 幻觉结果）。
        //    该格式参数非结构化 → 仅对可安全重建参数的只读工具自动执行；
        //    其余（edit/run_command/生成类）记录未执行，注入 follow-up 提示模型用原生 tool_calls 重做。
        var _dispRe = /^\[A\s*(?:→|->|➜|»)\s*([a-z][\w.-]*)\]\s*([^\n]*)$/gim;
        var _dispM;
        while ((_dispM = _dispRe.exec(_rawFallback)) !== null) {
            var _dispName = _dispM[1];
            var _dispRest = (_dispM[2] || '').trim();
            var _dispArgs = null;
            var _dispUnrecoverable = true;
            if (_dispName === 'read_file') {
                // [path] [L:start-end/total] [Nc]
                var _rfRange = _dispRest.match(/L:?(\d+)\s*-\s*(\d+)(?:\/\d+)?/i);
                var _rfPath = _dispRest.replace(/L:?\d+\s*-\s*\d+(\/\d+)?/i, '').replace(/\s+\d+c\s*$/i, '').trim().replace(/^["']|["']$/g, '');
                if (_rfPath) {
                    _dispArgs = { path: _rfPath };
                    if (_rfRange) {
                        _dispArgs.start_line = parseInt(_rfRange[1], 10);
                        _dispArgs.end_line = parseInt(_rfRange[2], 10);
                    }
                    _dispUnrecoverable = false;
                }
            } else if (_dispName === 'search_text' || _dispName === 'search_content' || _dispName === 'search_smart') {
                var _sq = _dispRest.replace(/\s+\d+\s*hits\s*$/i, '').trim().replace(/^["']|["']$/g, '');
                if (_sq) { _dispArgs = { query: _sq }; _dispUnrecoverable = false; }
            } else if (_dispName === 'list_files') {
                var _lp = _dispRest.replace(/\s+\d+\s*items?\s*$/i, '').trim().replace(/^["']|["']$/g, '');
                if (_lp) { _dispArgs = { path: _lp }; _dispUnrecoverable = false; }
            } else if (_dispName === 'find_files') {
                var _fp = _dispRest.replace(/\s+\d+\s*items?\s*$/i, '').trim().replace(/^["']|["']$/g, '');
                if (_fp) { _dispArgs = { pattern: _fp }; _dispUnrecoverable = false; }
            } else if (_dispName === 'get_diagnostics') {
                var _dp = _dispRest.trim().replace(/^["']|["']$/g, '');
                if (_dp) { _dispArgs = { path: _dp }; _dispUnrecoverable = false; }
            } else if (_dispName === 'fetch_webpage') {
                var _up = _dispRest.trim().replace(/^["']|["']$/g, '');
                if (/^https?:\/\//i.test(_up)) { _dispArgs = { url: _up }; _dispUnrecoverable = false; }
            } else if (_dispName === 'search_web') {
                var _wq = _dispRest.trim().replace(/^["']|["']$/g, '');
                if (_wq) { _dispArgs = { query: _wq }; _dispUnrecoverable = false; }
            }
            _fbBlocks.push({ name: _dispName, args: _dispArgs, _unrecoverable: _dispUnrecoverable });
        }
        // 格式 E 显示行从内容剥离（防原文展示；真实执行走 tool_calls 渲染）
        if (_dispM) {
            finalized.cleanContent = (finalized.cleanContent || '')
                .replace(/^\[A\s*(?:→|->|➜|»)\s*[a-z][\w.-]*\][^\n]*\n?/gim, '')
                .replace(/\x0a{3,}/g, '\x0a\x0a').trim();
        }

        if (_fbBlocks.length > 0) {
            finalized.textToolCalls = [];
            var _skipNames = [];
            var _skipReasons = [];
            for (var _fbi = 0; _fbi < _fbBlocks.length; _fbi++) {
                var _fbb = _fbBlocks[_fbi];
                if (_fbb._unrecoverable || !_fbb.args) {
                    _skipNames.push(_fbb.name || '?');
                    continue;
                }
                var _fbCallId = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                finalized.textToolCalls.push({
                    id: _fbCallId,
                    type: 'function',
                    function: { name: _fbb.name, arguments: JSON.stringify(_fbb.args) }
                });
            }
            // 从 cleanContent 剥离已解析的文本工具调用块（防止显示给用户）
            finalized.cleanContent = (finalized.cleanContent || '')
                .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
                .replace(/<Tool\s+Call:\s*\w[\w.-]*>[\s\S]*?<\/Tool\s+Call>/gi, '')
                .replace(/<invoke\s[^>]*?\bname\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<\/invoke>/gi, '')
                .replace(/<tool_call[\s>][^>]*>[\s\S]*?<\/tool_call>/gi, '')
                .replace(/\x0a{3,}/g, '\x0a\x0a').trim();
            // ★ 格式 E 未执行的工具 → 注入说明，模型下一 house 会看到并重做（原生 tool_calls 或直接回答）
            if (_skipNames.length > 0) {
                var _skipNote = '[System: 检测到上一条回复把工具调用写成了文本（[A → …] 显示格式）而非原生 tool_calls。以下工具因参数无法安全重建而未执行: ' + _skipNames.join(', ') + '。请用原生 tool_calls 重新执行这些工具，或直接给出最终答案。]';
                finalized.cleanContent = ((finalized.cleanContent || '') + '\n\n' + _skipNote).trim();
                _skipReasons.push(_skipNames.length + ' unrecoverable');
            }
            if (finalized.textToolCalls.length > 0) {
                self._log('🔄 fallback textToolCalls: parsed ' + finalized.textToolCalls.length + ' tool(s) from raw content' + (_skipReasons.length ? (' (' + _skipReasons.join(', ') + ')') : ''));
            } else {
                // 0 个可恢复工具 → 不空转（空 tool_calls 数组部分上游拒收；每次重试都计费）→
                // 直接 message 完结，内容已含提示，用户可见原因可手动重发
                self._log('⚠ fallback textToolCalls: 0 recoverable (' + _skipReasons.join(', ') + ') — finalizing as message with note');
            }
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
        // ★ SSE 服务端错误截断标记：传给 agent-loop 用于判断是否触发 fatal
        if (_hadSseError) {
            content += '\n\n⚠️ [Server error ' + (_sseErrorCode || '?') + ': ' + (_sseErrorMessage || 'unknown') + ']';
        }
        return { type: 'message', content: content, reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage, _finishReason: _finishReason, _truncatedByError: _hadSseError, _sseErrorCode: _sseErrorCode };
    }
    // 仅有 usage 无内容 → 上游可能拒绝了请求（上下文超限等）
    if (_usage && _usage.prompt_tokens) {
        var _msg = '⚠ SSE ended with usage only, no content — upstream likely rejected request (prompt_tokens=' + _usage.prompt_tokens + ' total_tokens=' + (_usage.total_tokens || '?') + ' completion_tokens=' + (_usage.completion_tokens || '?') + ')';
        self._log(_msg);
        if (typeof self._writeFileLog === 'function') self._writeFileLog(_msg);
        // ★ 设 _lastGatewayError=400，触发 agent-loop auto-repair：弹掉最后一组 assistant+tool 减轻上下文后重试
        self._lastGatewayError = 400;
        // ★ 用 API 返回的真实 token 数更新计数器，供压缩守护准确判断（不用客户端估算值）
        self._lastApiPromptTokens = _usage.prompt_tokens;
        self._lastApiTotalTokens = _usage.total_tokens || (_usage.prompt_tokens + (_usage.completion_tokens || 0));
        // ★ 立即刷新上下文按钮显示（服务器真理，不等下一次成功调用）
        if (typeof updateCtxBtn === 'function') updateCtxBtn();
    }
    // ★ 将 SSE 错误传回给 _callGateway，防止 onError 时 _lastGatewayMessage 落空
    if (_sseError) self._sseError = _sseError;
    return null;
};
