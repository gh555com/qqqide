// ============================================================================
// agent-gateway.js — 网关调用（双线路 + 重试 + 故障切换）
// 从 agent-loop.js 拆分，为 AgentLoop.prototype 添加 _callGateway 方法
// 依赖：AgentLoop（由 agent-loop.js 定义），GATEWAY_URL（由 system-prompt.js 定义）
// ============================================================================

// ---- 网关调用 ----
AgentLoop.prototype._callGateway = async function (messages, opts) {

    var self = this;
    self._lastGatewayError = 0;  // ★ 重置，防上一 floor 错误码污染 _exitReason
    self._lastGatewayMessage = '';  // ★ 重置延迟报错消息
    var onToken = opts.onToken;
    var onReasoning = opts.onReasoning;
    var onError = opts.onError;
    var tier = opts.tier || TIER_PRO;
    var noTools = opts.noTools || false;

    // ★ 主动预检：发请求前先修一遍孤儿 tool_calls，防 400
    //    优化：若 conversation 未变化且上次修复无发现，跳过（省 O(n) 扫描）
    var _convLen = (self.conversation && self.conversation.length) || 0;
    if (typeof self._repairOrphanedToolCalls === 'function' && (_convLen !== self._lastRepairLen || self._lastRepairHadWork)) {
        self._repairOrphanedToolCalls();
    }

    // ★ 兜底：在备用线路超过 5 分钟，本次请求尝试主线路
    var _gwTryingPrimary = (typeof _gwTryPrimary === 'function') ? _gwTryPrimary() : false;

    // ★ 号池：从 opts.token 获取初始 key，支持 429 自动切换
    var _currentToken = opts.token || '';

    self.abortController = new AbortController();

    // ★ 自适应超时：唯一真理在 ContentGateway（content-gateway.js）
    var _deadlinePrimary = (typeof ContentGateway !== 'undefined' ? ContentGateway.FETCH_DEADLINE_PRIMARY_MS : 98000);
    var _deadlineFallback = (typeof ContentGateway !== 'undefined' ? ContentGateway.FETCH_DEADLINE_FALLBACK_MS : 180000);
    var _deadlineMs = (GATEWAY_URL === GATEWAY_URL_FALLBACK) ? _deadlineFallback : _deadlinePrimary;
    var _fetchDeadline = setTimeout(function () {
        if (self.abortController) {
            self._abortSource = 'fetch_deadline';
            self._log('⏰ fetch deadline ' + (_deadlineMs / 1000) + 's reached — aborting to prevent hang');
            self.abortController.abort();
        }
    }, _deadlineMs);
    // 包装：每次进入 retry 重置 deadline
    function _resetFetchDeadline() {
        clearTimeout(_fetchDeadline);
        _deadlineMs = (GATEWAY_URL === GATEWAY_URL_FALLBACK) ? _deadlineFallback : _deadlinePrimary;
        _fetchDeadline = setTimeout(function () {
            if (self.abortController) {
                self._abortSource = 'fetch_deadline';
                self._log('⏰ fetch deadline ' + (_deadlineMs / 1000) + 's reached — aborting to prevent hang');
                self.abortController.abort();
            }
        }, _deadlineMs);
    }

    // 注入动态上下文（叙事摘要 + 相关事实）
    // ★ 始终创建副本：时间上下文的 push 不能污染 self.conversation
    var apiMessages = messages.slice();
    // 提取最后一轮用户查询用于相关事实检索
    var lastUserQuery = '';
    for (var qi = messages.length - 1; qi >= 0; qi--) {
        var _qmsg = messages[qi];
        if (!_qmsg) continue;
        if (_qmsg.role === 'user') {
            lastUserQuery = typeof _qmsg.content === 'string' ? _qmsg.content : '';
            break;
        }
    }
    var dynamicCtx = (typeof self._buildDynamicContext === 'function') ? self._buildDynamicContext() : '';
    if (dynamicCtx) {
        // ★ 压缩历史作为独立 system 消息插在 persistent 消息之后、真实对话之前
        var insertIdx = self._persistentCount || 0;
        apiMessages.splice(insertIdx, 0, { role: 'system', content: dynamicCtx, _dynamic: true });
    }

    // ★ 净化：strip reasoning_content（AI 思维链），不发给 API（非标准字段，白浪费带宽）
    for (var _si = 0; _si < apiMessages.length; _si++) {
        var _sm = apiMessages[_si];
        if (_sm && _sm.reasoning_content !== undefined) {
            delete _sm.reasoning_content;
        }
    }

    // ★ 时间上下文已嵌在用户消息末尾（agent-loop.js send()），不在网关重复注入

    // 语言检测已移至 a1 审计按钮（后翻译方案），此处不再强制注入语言指令
    // ★ house_hint：每间 house 推理前 30 字，供服务器账单按 house 区分
    var houseHint = '';
    var _lh = self._houses[self._houses.length - 1];
    if (_lh && _lh.reasoning) {
        var _chars = Array.from(_lh.reasoning);
        houseHint = _chars.slice(0, 30).join('');
    } else if (_lh && _lh.type === 'guide_ack') {
        houseHint = '引导确认';
    }
    // ★ 压缩守护（代替旧动态帽）：while 循环中每间 house 前检查，超 900k 则阻塞压缩
    //   此处不再缩 max_tokens — 由压缩保证 prompt 不超限
    var _reqMaxTokens = tier.maxTokens || ContentGateway.MAX_RESPONSE_TOKENS;
    var _effectiveMaxTokens = _reqMaxTokens;
    var body = {
        messages: apiMessages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: _effectiveMaxTokens,
        floor_id: self._floorId,
        house_hint: houseHint
    };

    // ★ 始终发送工具定义：即使 noTools 为 true，也要传 tools 防止模型退化为文本格式
    if (typeof getTools === 'function') {
        var _tools = getTools();
        if (_tools && _tools.length) {
            body.tools = _tools;
            if (noTools) {
                body.tool_choice = 'none';
            }
        }
    }
    if (tier.thinking) body.thinking = tier.thinking;
    if (tier.effort) body.reasoning_effort = tier.effort;

    // ★ 自适应节流：距上次 API 调用不足 MIN_API_INTERVAL_MS 则等待
    var MIN_API_INTERVAL_MS = 600;
    var _now2 = performance.now();
    if (self._lastApiCallTs) {
        var _elapsedSinceLastCall = _now2 - self._lastApiCallTs;
        if (_elapsedSinceLastCall < MIN_API_INTERVAL_MS) {
            var _waitMs = MIN_API_INTERVAL_MS - _elapsedSinceLastCall;
            await new Promise(function (r) { setTimeout(r, _waitMs); });
            if (self._stopCtrl.signal.aborted) { clearTimeout(_fetchDeadline); return null; }
        }
    }
    self._lastApiCallTs = performance.now();

    // ★ 上下文快照：对比本次与上次发送的消息，诊断缓存命中/未命中根因
    var _cacheDiag = null;
    if (self._billingDebug && apiMessages && apiMessages.length > 0) {
        _cacheDiag = _snapshotMessages(apiMessages, self._lastSentSnapshot);
        self._lastSentSnapshot = _cacheDiag.currSnapshot;
        self._lastCacheDiag = _cacheDiag;
    }

    var MAX_RETRIES = 3;  // ★ 同 URL 最多重试 3 次（第4次失败才考虑切线路）
    var MAX_KEY_ROTATIONS = 3;  // 最多切换 3 次 key
    var MAX_LINE_SWITCHES = 2;  // ★ 单次 _callGateway 最多切换 2 次线路（防 ping-pong）
    var _keyRotations = 0;
    var _lineSwitches = 0;
    var _ttfbAccum = 0;
    for (var retry = 0; retry <= MAX_RETRIES; retry++) {
        // ★ Stop 守卫：_stopCtrl 已 abort → 立即退出（替代散落 _floorKilled）
        if (self._stopCtrl.signal.aborted) { clearTimeout(_fetchDeadline); return null; }
        _resetFetchDeadline();  // ★ 每次 retry 重置 deadline
        // ★ 每轮 retry 创建 _retryCtrl，级联到 _stopCtrl
        //   用户 Stop → _stopCtrl.abort() → 级联 → _retryCtrl.abort() → fetch 立即断
        self.abortController = new AbortController();
        self._stopCtrl.signal.addEventListener('abort', function () {
            try { self.abortController.abort(); } catch (_) { }
        }, { once: true });
        self._abortSource = '';  // ★ 重置探针
        try {
            var _fetchStart = performance.now();
            // ★ 经 AiGateway 统一执行 fetch（模型映射 + 线路选择 + auth）
            var resp;
            if (typeof AiGateway !== 'undefined' && AiGateway.chatFetch) {
                resp = await AiGateway.chatFetch(body, {
                    token: _currentToken,
                    signal: self.abortController.signal,
                    tier: parseInt(tier.label) || 6,
                    isFallback: GATEWAY_URL === GATEWAY_URL_FALLBACK
                });
            } else {
                // 兜底：AiGateway 未加载（不应发生）
                resp = await fetch(GATEWAY_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + _currentToken,
                        'X-Floor-Id': self._floorId || ''
                    },
                    body: JSON.stringify(body),
                    signal: self.abortController.signal
                });
            } var _ttfbMs = performance.now() - _fetchStart;
            _ttfbAccum += _ttfbMs;
            if (!resp.ok) {
                var text = await resp.text();
                // ★ 429 时优先切换 key，再退避重试
                if (resp.status === 429 && _keyRotations < MAX_KEY_ROTATIONS) {
                    if (_rotateKey()) {
                        _keyRotations++;
                        retry = -1;  // 重置重试计数（新 key 新机会）
                        var _rotateWait = 1000;
                        self._log('  gateway 429 → key rotated, retry in ' + _rotateWait + 'ms');
                        await new Promise(function (r) { setTimeout(r, _rotateWait); });
                        if (self._stopCtrl.signal.aborted) { clearTimeout(_fetchDeadline); return null; }
                        continue;
                    }
                }
                if ((resp.status === 429 || resp.status === 502 || resp.status === 503) && retry < MAX_RETRIES) {
                    // ★ 502/503: retry 前半段重试同 URL（可能瞬态），后半段切线路
                    if (resp.status === 502 || resp.status === 503) {
                        if (retry < Math.floor(MAX_RETRIES / 2)) {
                            var waitMsGw = 2000 * Math.pow(2, retry);
                            self._log('  gateway ' + resp.status + ' retry #' + (retry + 1) + ' in ' + waitMsGw + 'ms (transient?)');
                            await new Promise(function (r) { setTimeout(r, waitMsGw); });
                            if (self._stopCtrl.signal.aborted) { clearTimeout(_fetchDeadline); return null; }
                            continue;
                        }
                        // 后半段重试 → 跳过 retry，落入下方线路切换
                    } else {
                        var waitMsGw = 3000 * Math.pow(2, retry);
                        self._log('  gateway ' + resp.status + ' retry #' + (retry + 1) + ' in ' + waitMsGw + 'ms');
                        await new Promise(function (r) { setTimeout(r, waitMsGw); });
                        if (self._stopCtrl.signal.aborted) { clearTimeout(_fetchDeadline); return null; }
                        continue;
                    }
                }
                self._log('✗ gateway ' + resp.status + ': ' + text.slice(0, 200));

                // ★ 备线 402（欠费）：静默切回主线，不曝服务端内部状态给用户
                if (resp.status === 402 && GATEWAY_URL === GATEWAY_URL_FALLBACK && typeof _gwSwitch === 'function') {
                    self._log('  fallback depleted — switching back to primary');
                    _gwSwitch(false);  // → 主线
                    if (_lineSwitches < MAX_LINE_SWITCHES) {
                        _lineSwitches++;
                        retry = -1;
                        continue;
                    }
                    // 已达切换上限 → 同 502/503 无线路可用，不曝余额不足给用户
                    self._exitReason = 'http_' + resp.status;
                    self._lastGatewayMessage = '服务器暂时未可达，所有线路均已耗尽';
                    if (typeof _gwBroadcastDeadFallback === 'function') {
                        _gwBroadcastDeadFallback();
                    }
                    return null;
                }

                var friendly = resp.status === 401 ? '认证失败，请检查 Token'
                    : resp.status === 402 ? 'ge 余额不足，请充值'
                        : resp.status === 429 ? '请求过于频繁，请稍后再试'
                            : resp.status === 502 ? '服务器暂时未可达 (502)'
                                : resp.status === 503 ? '服务器暂时未可达 (503)'
                                    : 'Server error (' + resp.status + ')';
                try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show(friendly, { type: resp.status === 429 ? 'warning' : 'error' }); } catch (_) { }
                // ★ 502/503: 切线路（带防 ping-pong）
                if (resp.status === 502 || resp.status === 503) {
                    self._lastGatewayError = resp.status;
                    clearTimeout(_fetchDeadline);
                    var _didSwitch502 = false;
                    if (_gwTryingPrimary) {
                        if (typeof _gwPrimaryFailed === 'function') _gwPrimaryFailed();
                        _gwTryingPrimary = false;
                        _didSwitch502 = true;
                    } else if (typeof _gwSwitch === 'function') {
                        if (GATEWAY_URL === GATEWAY_URL_PRIMARY) {
                            _gwSwitch(true);  // → 备用
                            _didSwitch502 = true;
                        } else if (GATEWAY_URL === GATEWAY_URL_FALLBACK && _lineSwitches < MAX_LINE_SWITCHES) {
                            _gwSwitch(false);  // ★ 备用也挂了 → 切回主线路
                            _didSwitch502 = true;
                        }
                    }
                    if (_didSwitch502 && _lineSwitches < MAX_LINE_SWITCHES) {
                        _lineSwitches++;
                        retry = -1;
                        self._log('  ↳ line switch #' + _lineSwitches + ' (HTTP ' + resp.status + ') → ' + GATEWAY_URL);
                        continue;
                    }
                    // 无可切换线路 或 已达切换上限 → 交给上层 auto-repair 处理
                    self._exitReason = 'http_' + resp.status;
                    self._lastGatewayMessage = friendly + '，所有线路均未可达';
                    // ★ 通知兄弟面板：当前线路已死
                    if (typeof _gwBroadcastDeadFallback === 'function' && GATEWAY_URL === GATEWAY_URL_FALLBACK) {
                        _gwBroadcastDeadFallback();
                    }
                    // ★ 不在此处 onError / _sendTerminated — 让 agent loop 的 auto-repair 先尝试修复
                    return null;
                }
                // ★ 其他 HTTP 错误（401/402/429等）— 终端错误，统一延迟报错
                self._lastHttpStatus = resp.status;
                self._lastGatewayError = resp.status;  // ★ 标记错误码，防 agent-loop 无意义重试
                self._exitReason = 'http_' + resp.status;
                clearTimeout(_fetchDeadline);
                self._sendTerminated = true;  // ★ 标记终止
                self._lastGatewayMessage = friendly + ' Conversation saved.';
                // ★ 不在此处调 onError — 静默返回 null，交给 agent-loop 统一调（防双重报错）
                return null;
            }

            var _serverDateHdr = resp.headers.get('Date');
            if (_serverDateHdr) {
                self._serverDrift = new Date(_serverDateHdr).getTime() - Date.now();
                // 单调时钟锚点：performance.now() 不受系统时间/变速齿轮影响
                var anchor = {
                    perfNow: performance.now(),
                    utcMs: new Date(_serverDateHdr).getTime()
                };
                window._serverTimeAnchor = anchor;
                // 推送父窗口（shell 状态栏），作为最高优先级时间源
                try {
                    if (window.parent && window.parent !== window) {
                        window.parent._sseTimeAnchor = anchor;
                    }
                } catch (_) { }
            }
            self._log('✓ gateway ' + resp.status + ' streaming...');
            clearTimeout(_fetchDeadline);  // ★ SSE 流开始，取消 fetch deadline
            var _result = await self._parseSSE(resp.body, onToken, onReasoning);
            if (_result) {
                _result._ttfbMs = _ttfbAccum;
                _result._streamMs = _result._streamMs || 0;
            } else if (self._sseError) {
                // ★ SSE 流中断（非 AbortError）= 连接断开
                //    把错误详情写入 _lastGatewayMessage，避免 UI 显示泛泛的 "Unexpected response"
                self._lastGatewayMessage = 'SSE connection lost: ' + (self._sseError.message || 'unknown');
                self._log('✗ ' + self._lastGatewayMessage);
                self._sseError = null;
            }
            self._consecutiveFetchErrors = 0;  // ★ 整个 fetch+SSE 周期成功后才清零
            // ★ Token 校准：对比本地估算和 API 精确值，自动修正 CHAR_PER_TOKEN
            if (_result && _result._usage && _result._usage.prompt_tokens > 0 && typeof ContentGateway !== 'undefined') {
                var _estChars = 0;
                for (var _ei = 0; _ei < apiMessages.length; _ei++) {
                    var _em = apiMessages[_ei];
                    if (!_em) continue;
                    try {
                        if (typeof _em.content === 'string') _estChars += _em.content.length;
                        if (_em.tool_calls) _estChars += JSON.stringify(_em.tool_calls).length;
                    } catch (_) { }
                }
                if (_estChars > 0) {
                    var _estTokens = _estChars / ContentGateway.CHAR_PER_TOKEN;
                    var _actTokens = _result._usage.prompt_tokens;
                    var _ratio = _estTokens / _actTokens;
                    if (Math.abs(_ratio - 1) > 0.20) {
                        var _newCPT = ContentGateway.CHAR_PER_TOKEN / _ratio;
                        ContentGateway.CHAR_PER_TOKEN = Math.round(_newCPT * 100) / 100;
                    }
                }
            }
            // ★ 兜底：尝试主线路成功 → 正式切回
            if (_gwTryingPrimary && typeof _gwSwitch === 'function') {
                _gwSwitch(false);  // 切回主线路 + qoast 提示
            }
            clearTimeout(_fetchDeadline);
            return _result;
        } catch (err) {
            if (err.name === 'AbortError') {
                clearTimeout(_fetchDeadline);
                self._log('■ aborted');
                if (self._guidePending) {
                    self._abortedByGuide = true;
                    return { _abortedForGuide: true };
                }
                // ★ Stop 闭环：用户 Stop 引起的 abort → 不做任何恢复，直接返回
                if (self._stopState === 'stopping') {
                    self._exitReason = 'user_kill';
                    self._log('■ user stopped — no recovery');
                    return null;
                }
                // ★ 非引导中断 = 看门狗/超时/网络问题
                // 设置探针：区分 abort 来源
                if (self._abortSource === 'stream_watchdog') self._exitReason = 'watchdog_stream';
                else if (self._abortSource === 'fetch_deadline') self._exitReason = 'deadline';
                else self._exitReason = 'unknown';

                // ★ 超时桩日志：记录本次 abort 的完整上下文
                var _abortCtx = {
                    source: self._exitReason,
                    panel: (typeof _panelId !== 'undefined' ? _panelId : '?'),
                    floor: self._ctx.totalFloors,
                    house: self._houseIndex,
                    url: GATEWAY_URL,
                    retry: retry,
                    abortRetries: (self._abortRetries || 0),
                    lineSwitches: _lineSwitches,
                    elapsed: Math.round(performance.now() - (_fetchStart || 0))
                };
                var _abortSummary = '⏰ ABORT [' + _abortCtx.source + '] panel=' + _abortCtx.panel + ' floor=' + _abortCtx.floor + ' house=' + _abortCtx.house + ' url=' + _abortCtx.url.replace('https://', '').split('/')[0] + ' retry=' + _abortCtx.retry + '/' + MAX_RETRIES + ' abortRetries=' + _abortCtx.abortRetries + ' lineSwitches=' + _abortCtx.lineSwitches + '/' + MAX_LINE_SWITCHES + ' elapsed=' + _abortCtx.elapsed + 'ms';
                self._log(_abortSummary);
                if (typeof self._writeFileLog === 'function') self._writeFileLog(_abortSummary);

                // ★ 超时恢复：先同 URL 退避重试（最多 3 次），再切线路
                // ★ Stop 守卫：用户点停止后立即退出，不做任何恢复
                if (self._stopCtrl.signal.aborted) {
                    self._log('■ abort recovery skipped: user killed');
                    clearTimeout(_fetchDeadline);
                    return null;
                }
                self._abortRetries = (self._abortRetries || 0) + 1;
                if (self._abortRetries <= 3) {
                    var _abortWait = 2000 * Math.pow(2, self._abortRetries - 1);  // 2s, 4s, 8s
                    var _retryMsg = '  ⏳ abort retry #' + self._abortRetries + '/3 in ' + (_abortWait / 1000) + 's (same URL: ' + GATEWAY_URL.replace('https://', '').split('/')[0] + ')';
                    self._log(_retryMsg);
                    if (typeof self._writeFileLog === 'function') self._writeFileLog(_retryMsg);
                    // ★ 退避等待归入网络时间（红）
                    self._floorTiming.networkMs += _abortWait;
                    await new Promise(function (r) { setTimeout(r, _abortWait); });
                    if (self._stopCtrl.signal.aborted) { clearTimeout(_fetchDeadline); return null; }
                    continue;  // 回到 retry 循环顶部，同 URL 重试
                }
                self._abortRetries = 0;
                // 同 URL 重试 3 次仍超时 → 切线路
                if (typeof _gwSwitch === 'function' && _lineSwitches < MAX_LINE_SWITCHES) {
                    var _oldUrl = GATEWAY_URL.replace('https://', '').split('/')[0];
                    if (GATEWAY_URL === GATEWAY_URL_PRIMARY) {
                        _gwSwitch(true);
                        _lineSwitches++;
                    } else if (GATEWAY_URL === GATEWAY_URL_FALLBACK) {
                        _gwSwitch(false);
                        _lineSwitches++;
                    }
                    retry = -1;
                    self._consecutiveFetchErrors = 0;
                    var _newUrl = GATEWAY_URL.replace('https://', '').split('/')[0];
                    var _switchMsg = '  ↳ abort recovery: line switch #' + _lineSwitches + '/' + MAX_LINE_SWITCHES + ' ' + _oldUrl + ' → ' + _newUrl;
                    self._log(_switchMsg);
                    if (typeof self._writeFileLog === 'function') self._writeFileLog(_switchMsg);
                    if (self._stopCtrl.signal.aborted) { clearTimeout(_fetchDeadline); return null; }
                    continue;
                }
                // ★ 所有恢复手段耗尽 → 记录最终失败
                var _finalMsg = '✗ TIMEOUT EXHAUSTED: all ' + MAX_LINE_SWITCHES + ' line switches + 3 abort retries per URL exhausted. Final URL=' + GATEWAY_URL.replace('https://', '').split('/')[0] + ' panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ' floor=' + self._ctx.totalFloors;
                self._log(_finalMsg);
                if (typeof self._writeFileLog === 'function') self._writeFileLog(_finalMsg);
                var _errDetail = 'Connection timed out. Retried 3x + switched 2x lines. All recovery exhausted.';
                if (self._abortSource) _errDetail += ' Trigger: ' + self._abortSource + '.';
                _errDetail += ' Conversation saved.';
                self._lastGatewayMessage = _errDetail;
                return null;
            }
            var msg = err.message || '';

            // ★ AI 上游错误（400/422）：请求体/上下文有问题，重试/切线路均无效 → 直接返回 null
            if (self._lastGatewayError === 400 || self._lastGatewayError === 422) {
                self._log('  AI upstream ' + self._lastGatewayError + ' — unrecoverable, skipping retries');
                clearTimeout(_fetchDeadline);
                self._exitReason = 'http_' + self._lastGatewayError;
                self._lastGatewayMessage = 'AI upstream returned ' + self._lastGatewayError + ' (bad request or context limit). Auto-repair attempted.';
                return null;
            }

            // ★ 402（服务端 key 欠费）：不重试同线路，直接切线路（另一把 key 可能有钱）
            if (self._lastGatewayError === 402) {
                self._log('  AI upstream 402 — key depleted, trying line switch');
                clearTimeout(_fetchDeadline);
                self._lastGatewayMessage = 'AI 服务暂时未可用，请稍后再试';
                // 跳过 HTTP/2 重试，直接落入下方线路切换逻辑
            } else {
                // HTTP/2 协议检测：JS 层 fetch() 对 ERR_HTTP2_* 只报 "Failed to fetch"
                // net::ERR_HTTP2_PROTOCOL_ERROR 仅 DevTools 可见，JS Error.message 拿不到
                var _isHttp2Like = msg.indexOf("ERR_HTTP2") >= 0
                    || msg.indexOf("ERR_CONNECTION_CLOSED") >= 0
                    || msg === 'Failed to fetch'
                    || msg.indexOf('network error') >= 0;

                if (retry < MAX_RETRIES) {
                    // ★ HTTP/2 连接级错误：优先切线路（连接池问题不会因重试恢复）
                    if (_isHttp2Like && retry >= Math.floor(MAX_RETRIES / 2)) {
                        var _h2Msg = '  HTTP/2-like error (retry ' + retry + '/' + MAX_RETRIES + '), skipping remaining → line switch | msg=' + msg + ' | panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?');
                        self._log(_h2Msg);
                        if (typeof self._writeFileLog === 'function') self._writeFileLog(_h2Msg);
                        // 不 continue，直接落入下方线路切换逻辑
                    } else {
                        var waitMsF = _isHttp2Like ? 2000 : 1000;  // HTTP/2 多等 1s 让 Chromium 回收连接
                        self._log('  fetch error retry #' + (retry + 1) + ' in ' + waitMsF + 'ms: ' + msg);
                        await new Promise(function (r) { setTimeout(r, waitMsF); });
                        if (self._stopCtrl.signal.aborted) { clearTimeout(_fetchDeadline); return null; }
                        continue;
                    }
                }
            } // end else (non-402)

            // 重试耗尽 — 先尝试切换线路，最后手段才 reload
            clearTimeout(_fetchDeadline);
            self._consecutiveFetchErrors = (self._consecutiveFetchErrors || 0) + 1;
            self._lastFetchError = msg;
            if (self._lastGatewayError) {
                self._exitReason = 'http_' + self._lastGatewayError;
            } else {
                self._exitReason = 'fetch_error';
            }
            var _exhaustedMsg = '✗ fetch exhausted: ' + msg + ' (consecutive=' + self._consecutiveFetchErrors + ', panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ')';
            self._log(_exhaustedMsg);
            if (typeof self._writeFileLog === 'function') self._writeFileLog(_exhaustedMsg);

            // ★ 线路切换决策（带防 ping-pong 计数器）
            var _canSwitchUrl = false;
            if (_gwTryingPrimary) {
                // 尝试主线路失败 → 无声退回备用
                if (typeof _gwPrimaryFailed === 'function') _gwPrimaryFailed();
                _gwTryingPrimary = false;  // 已退回备用
                _canSwitchUrl = true;
            } else if (typeof _gwSwitch === 'function') {
                if (GATEWAY_URL === GATEWAY_URL_PRIMARY) {
                    // 主线路连接坏 → 切备用 + qoast 提示
                    _gwSwitch(true);
                    _canSwitchUrl = true;
                } else if (GATEWAY_URL === GATEWAY_URL_FALLBACK) {
                    // ★ 备用线路也失败 → 尝试切回主线路（不自锁）
                    _gwSwitch(false);
                    _canSwitchUrl = true;
                }
            }
            // ★ 网络耗尽：绝不 reload（毁 DOM 毁计时器毁一次渲染铁律）
            // 恢复策略：线路切换 > 静默返回 null（agent loop 自然结束楼层，对话完整保留）
            if (_canSwitchUrl && _lineSwitches < MAX_LINE_SWITCHES) {
                _lineSwitches++;
                retry = -1;
                self._consecutiveFetchErrors = 0;
                var _switchMsg = '  ↳ line switch #' + _lineSwitches + ' → ' + GATEWAY_URL + ' (panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ', floor=' + self._ctx.totalFloors + ')';
                self._log(_switchMsg);
                if (typeof self._writeFileLog === 'function') self._writeFileLog(_switchMsg);
                continue;
            }
            // 无可切换线路 或 已达切换上限 → 交给上层处理
            if (!self._lastGatewayMessage) {
                var _errDet = 'Network request failed. Retried ' + MAX_RETRIES + 'x + switched ' + MAX_LINE_SWITCHES + 'x lines. All recovery exhausted.';
                if (msg) _errDet += ' Error: ' + msg + '.';
                _errDet += ' Conversation preserved.';
                self._lastGatewayMessage = _errDet;
            }
            // ★ 通知兄弟面板：当前线路已死
            if (typeof _gwBroadcastDeadFallback === 'function' && GATEWAY_URL === GATEWAY_URL_FALLBACK) {
                _gwBroadcastDeadFallback();
            }
            // ★ 不在此处 onError / _sendTerminated — 让 agent loop 统一处理
            return null;
        }
    } // retry loop
};
