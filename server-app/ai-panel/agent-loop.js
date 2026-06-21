// ============================================================================
// agent-loop.js — 核心 Agentic 循环
// 从 q3/ai/src/agent.js 移植，适配 Shell v2
//
// 流程：
//   1. 构建请求体（含工具定义 + 完整 SYSTEM_PROMPT）
//   2. SSE 流式解析：区分 content / tool_calls / billing
//   3. 若响应含 tool_calls → 并行执行工具 → 结果推入对话 → 回到步骤 1
//   4. 若响应含 content → 展示给用户，结束
//   5. 最多 200 次迭代，超限强制要求最终回答
//
// 回调：
//   onToken(content)       — 流式文本增量
//   onReasoning(reasoning) — 思考过程增量
//   onToolCall(call)       — 工具调用开始
//   onToolResult(name, result, truncated) — 工具结果
//   onDone(content)        — 最终完成
//   onError(message)       — 错误
// ============================================================================

// ---- 依赖：由 index.html 中的 <script> 标签加载顺序保证 ----
// system-prompt.js  → GATEWAY_URL, SYSTEM_PROMPT, TIER_PRO
// tools.js          → TOOL_DEFINITIONS, TOOL_CATEGORY, executeTool, getTools
// agent-envelope.js → _utf8Trunc, EnvelopeStripper
//
// ★ 已拆分模块（2026-06 重构）：
//   agent-envelope.js — 信封剥离 + UTF-8 截断
//   agent-gateway.js  — 网关调用（双线路 + 重试 + 故障切换）
//   agent-sse.js      — SSE 流解析 + 文本工具调用回生
//   agent-vision.js   — 视觉预分析（图像→文本→推理）
//   agent-exec.js     — 并行工具执行引擎 + 分层调度
//   agent-context.js  — 上下文压缩引擎（三专家架构）

var AgentLoop = (function () {
    'use strict';

    // ---- AgentLoop 构造函数 ----
    function AgentLoop(opts) {
        this.conversation = [];        // [{role, content, tool_calls?, tool_call_id?}]
        this.abortController = null;
        this._log = opts.log || function () { };
        this.log = this._log;          // alias for context engine
        // ★ 文件日志：写入 new_log/ 目录（持久化诊断，不依赖 Console）
        this._fileLogBuffer = [];
        this._fileLogTimer = null;
        var _self = this;
        // ★ 全局日志开关：window.__qqq_file_log = false 可关闭所有文件日志
        if (typeof window !== 'undefined' && window.__qqq_file_log === undefined) {
            window.__qqq_file_log = true;  // 默认开启
        }
        this._writeFileLog = function (msg) {
            if (typeof window !== 'undefined' && window.__qqq_file_log === false) return;
            _self._fileLogBuffer.push(new Date().toISOString() + ' ' + msg);
            if (_self._fileLogBuffer.length > 20) {
                _self._flushFileLog();
            } else if (!_self._fileLogTimer) {
                _self._fileLogTimer = setTimeout(function () { _self._flushFileLog(); }, 10000);
            }
        };
        this._flushFileLog = function () {
            if (_self._fileLogTimer) { clearTimeout(_self._fileLogTimer); _self._fileLogTimer = null; }
            if (_self._fileLogBuffer.length === 0) return;
            var lines = _self._fileLogBuffer.join('\n') + '\n';
            _self._fileLogBuffer = [];
            try {
                var today = new Date().toISOString().slice(0, 10);
                var root = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
                if (!root) return;
                var logDir = root.replace(/\\/g, '/') + '/new_log';  // new_log/ 在项目根目录内
                var logPath = logDir + '/agent-' + today + '.log';
                var bridge = window.parent && window.parent.qqqideBridge;
                if (bridge && bridge.fs) {
                    // ★ 真追加：优先用 append，不支持则降级为 read+write
                    if (typeof bridge.fs.append === 'function') {
                        bridge.fs.append(logPath, lines).catch(function () { });
                    } else {
                        bridge.fs.read(logPath).then(function (old) {
                            bridge.fs.write(logPath, (typeof old === 'string' ? old : '') + lines);
                        }).catch(function () {
                            bridge.fs.write(logPath, lines);
                        });
                    }
                }
            } catch (_) { /* 静默降级：文件日志失败不影响主流程 */ }
        };
        // 上下文引擎
        this._compressing = false;
        this._compressAttemptedThisFloor = false;
        this._ctx = { narrative: '', facts: [], totalFloors: 0, lastCompressedFloor: 0, floorArchives: [] };
        this._compactTraces = [];  // 埋点日志（最近 10 条）

        // 计费
        this._floorCostWge = 0;
        this.totalCostGe = 0;
        this._lastCostDisplay = '0';
        this._lastApiPromptTokens = 0;  // 初始化清零，避免残留旧 quest 数值
        this._lastApiTotalTokens = 0;    // API 返回的 total_tokens（prompt+completion 精确值）
        this._lastTier = null;           // 最近一次使用的 AI 等级（压缩复用它）
        // 视觉缓存: MD5(base64) → {description, ge_cost}
        this._visionCache = new Map();
        this._visionCostWge = 0;
        // 计费 flush
        this._floorId = '';
        this._currentFloorSummary = '';
        // 楼层内 house 追踪
        this._houses = [];
        this._houseIndex = 0;
        // 持久化 rules 注入（永不压缩，版本追踪）
        this._persistentCount = 0;
        this._rulesVersion = '';
        // 引导注入（不中断楼层，立即让 AI 回复确认）
        this._guidePending = false;
        this._guideMessage = '';
        this._abortedByGuide = false;
        this._deferredFinalMsg = null;  // 引导中断时暂存的最终回复
        // ★ 楼层看门狗：防断头中断
        this._floorKilled = false;
        this._floorCompletedCleanly = false;
        this._floorOnErrorCalled = false;
        this._sendTerminated = false;  // ★ onError 后强制终止 send() while 循环
        // ★ 终极 Stop 闭环：单一真理源 + 级联信号
        this._stopCtrl = null;          // AbortController（仅用户 Stop 时 abort，永不重建）
        this._stopState = 'idle';       // 'idle' | 'sending' | 'stopping'
        // ★ 错误诊断探针（用于构建"继续"消息中的中断原因）
        this._exitReason = '';           // 'ok'|'http_502'|'http_503'|'http_429'|'http_402'|'fetch_error'|'watchdog_stream'|'deadline'|'max_iter'|'unknown'
        this._lastHttpStatus = 0;        // 最后一次 HTTP 状态码
        this._lastFetchError = '';       // 最后一次 fetch 错误消息
        this._lastSseError = '';         // 最后一次 SSE 服务端错误
        this._lastGatewayMessage = '';   // ★ 延迟报错消息（_callGateway 设，agent loop 读）
        this._abortSource = '';          // 'stream_watchdog'|'fetch_deadline'|'user_kill'|'guide'|''
        // ★ 记账埋点：完整 billing 追踪（per-house 粒度）
        this._lastBilling = null;        // { geCost, model, usage: {prompt_tokens,completion_tokens,cached_tokens,non_cached_tokens}, freeWindow, requestId }
        this._billingSeq = 0;            // 全局 billing 事件序号（跨 floor 递增）
        this._billingDebug = false;      // 详细记账日志开关（默认关，减少噪音）
        // ★ 上下文快照：诊断模型缓存命中/未命中根因
        this._lastSentSnapshot = null;   // { msgCount, prefixHash, firstMsgKeys, lastMsgKeys }
        this._lastCacheDiag = null;      // { prevHash, currHash, firstDiffIdx, diffReason, prevMsgKeys, currMsgKeys }
    }

    // ---- 中止 ----
    // ★ 终极 Stop 闭环：单一真理源 _stopCtrl，仅用户 Stop 时 abort
    //   级联信号：每轮 retry 的 _retryCtrl 通过 addEventListener 监听 _stopCtrl
    //   效果：不管 agent-loop 在哪个重试循环深度，Stop 一掐即停
    AgentLoop.prototype.stop = function () {
        if (this._stopState !== 'sending') return;  // 幂等：非 SENDING 不响应
        this._stopState = 'stopping';
        if (this._stopCtrl) {
            this._stopCtrl.abort();  // ★ 一掐：级联所有 _retryCtrl → 所有 fetch 立即抛 AbortError
        }
    };
    // 保留旧 abort() 兼容其他调用方（guide/inject 等内部中断）
    // userKill: true = 用户点停止按钮 → 走新 stop() 逻辑
    AgentLoop.prototype.abort = function (userKill) {
        if (userKill) {
            this.stop();  // ★ 委托新闭环
            return;
        }
        // 非用户中断（guide/inject）→ 只 abort 当前 fetch
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    };

    // ═══ 构建中断诊断消息（用于"继续"按钮） ═══
    // 只包含 AI 无法从上下文推断的实际错误原因，不含楼层号/耗时/工具次数等冗余信息
    AgentLoop.prototype._buildDiagnosis = function () {
        var parts = [];
        // 主因
        switch (this._exitReason) {
            case 'http_502': parts.push('服务器返回502(Bad Gateway)'); break;
            case 'http_503': parts.push('服务器返回503(Service Unavailable)'); break;
            case 'http_429': parts.push('请求过于频繁(429限流)'); break;
            case 'http_400': parts.push('AI接口返回400(请求格式错误，可能是孤儿tool消息)'); break;
            case 'http_422': parts.push('AI接口返回422(参数错误)'); break;
            case 'http_402': parts.push('ge余额不足(402)'); break;
            case 'fetch_error':
                var _fe = this._lastFetchError || '连接中断';
                // 精简常见错误
                if (_fe === 'Failed to fetch') _fe = '网络连接失败(Failed to fetch)';
                else if (_fe.indexOf('network error') >= 0) _fe = '网络错误(network error)';
                else if (_fe.indexOf('Timeout') >= 0) _fe = '请求超时';
                parts.push('Network request failed: ' + _fe);
                break;
            case 'watchdog_stream': parts.push('SSE流90秒无数据(连接假死)'); break;
            case 'deadline': parts.push('请求90秒无响应(超时)'); break;
            case 'max_iter': parts.push('达到最大迭代次数(200)'); break;
            default:
                if (this._lastHttpStatus) parts.push('HTTP ' + this._lastHttpStatus + '错误');
                break;
        }
        // 补充：服务端SSE错误消息
        if (this._lastSseError && this._exitReason !== 'http_502' && this._exitReason !== 'http_503') {
            parts.push('服务端: ' + this._lastSseError);
        }
        // 补充：连续失败次数
        if (this._consecutiveFetchErrors > 1) {
            parts.push('连续' + this._consecutiveFetchErrors + '次网络失败');
        }
        // 补充：请求体过大
        var _ctxTokens = this._lastApiTotalTokens || this._lastApiPromptTokens || 0;
        if (_ctxTokens > 900000) {
            parts.push('Context too large (' + Math.round(_ctxTokens / 1000) + 'k tokens, near limit)');
        }
        return parts.join('; ') || '未知原因';
    };


    // ---- 清空对话 ----
    AgentLoop.prototype.clearConversation = function () {
        this.conversation = [];
        this._compressing = false;
        this._visionCache.clear();
        this._houses = [];
        this._a4Snapshots = {};
        this._houseIndex = 0;
        this._persistentCount = 0;
        this._rulesVersion = "";
    };

    // ---- 结构化信封注入：校验 → A3渲染 + 上下文注入（去重，每条只写一次）-------
    // ═══ 持久化 rules 刷新（版本追踪：只有源文件变化才重建） ═══
    AgentLoop.prototype._refreshRules = async function () {
        var self = this;
        // 每次从磁盘重读 rules 文件，确保外部更新能热替换到哨兵
        if (typeof loadQqqideRules === "function") { await loadQqqideRules(); }
        if (typeof loadQqqideProjectRules === "function" && typeof questStore !== "undefined" && questStore.getProjectRoot) {
            await loadQqqideProjectRules(questStore.getProjectRoot());
        }
        if (typeof buildQqqideVisionContext === "function") { buildQqqideVisionContext(); }
        var parts = [];
        // Vision context FIRST — concrete project path anchors AI before any abstract rules or historical paths appear
        if (typeof qqqideVisionContext !== "undefined" && qqqideVisionContext) {
            parts.push(qqqideVisionContext);
        }
        // ═══ CURRENT TIME — 与状态栏时钟共享 SSE 锚点，同步捕获，精确到秒 ═══
        if (typeof getTimeContext === "function") {
            try {
                var timeCtx = getTimeContext();
                if (timeCtx) parts.push(timeCtx);
            } catch (_) { /* silent: time context unavailable */ }
        }
        // SYSTEM_PROMPT 只发送一次，打入哨兵永久存在（重启窗口后从 SQLite 恢复）
        if (typeof SYSTEM_PROMPT !== "undefined" && SYSTEM_PROMPT) {
            parts.push(SYSTEM_PROMPT);
        }
        if (typeof qqqideRulesContent !== "undefined" && qqqideRulesContent) {
            parts.push(qqqideRulesContent);
        }
        if (typeof qqqideProjectRulesContent !== "undefined" && qqqideProjectRulesContent) {
            parts.push(qqqideProjectRulesContent);
        }
        // ═══ TRAILING REMINDERR — reinforce main project after all rules ═══
        var panelRoot = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
        if (panelRoot) {
            panelRoot = panelRoot.replace(/\\/g, '/').replace(/\/$/, '');
            var reminder = '\n\n═══ DEFAULT WORKING DIRECTORY ═══\n' +
                'Main project: ' + panelRoot + '\n' +
                'When the user does not specify a project, all file operations default to this directory.\n' +
                '═══════════════════';
            parts.push(reminder);
        }
        if (parts.length === 0) return "";
        var prefix = parts.join('\n\n---\n\n');
        var hash = self._simpleHash(prefix);
        if (hash === self._rulesVersion && self._persistentCount > 0) return "";
        self._rulesVersion = hash;
        return prefix;
    };

    // ---- 主入口 ----
    AgentLoop.prototype.send = async function (userContent, opts) {
        var self = this;
        opts = opts || {};
        var onToken = opts.onToken || function () { };
        var onReasoning = opts.onReasoning || function () { };
        var onToolCall = opts.onToolCall || function () { };
        var onToolResult = opts.onToolResult || function () { };
        var onDone = opts.onDone || function () { };
        var onError = opts.onError || function () { };
        var onCost = opts.onCost || function () { };
        var onGuideAckDone = opts.onGuideAckDone || function () { };
        var token = opts.token || '';
        var images = opts.images; // [{id, base64}]

        if (!token) { onError('No token'); return null; }

        self._compressing = false;  // ★ 安全重置：防上次异常未清理
        // ★ 存储 token 供 tools.js 调用 Go 端点时使用
        self._token = token;

        // 重置本轮计费 + 生成 floor_id（同一轮内所有 gateway 调用共享）
        self._floorCostWge = 0;
        self._floorFree = false;
        self._floorId = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ((typeof _panelId !== 'undefined') ? ['_L', '_C', '_R'][_panelId] || '' : '');
        self._currentFloorSummary = (userContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        self._floorTiming = { networkMs: 0, aiMs: 0, floorStartPerf: performance.now(), floorStartServerMs: Date.now() + (self._serverDrift || 0) };
        self._floorStartServerMs = self._floorTiming.floorStartServerMs;  // 兼容旧引用

        // ═══ 视觉预分析：图像 → 文本 → 推理 ═══
        // 将用户问题一并发送，让阿里针对实际问题做定向识别
        var visionText = '';
        var _visionStart = performance.now();
        if (images && images.length > 0) {
            self._log('🔍 vision: analyzing ' + images.length + ' image(s)...');
            var visionResults = await self._analyzeImages(images, token, userContent);
            if (visionResults.length > 0) {
                var parts = [];
                for (var vi = 0; vi < visionResults.length; vi++) {
                    parts.push('[图#' + visionResults[vi].id + ' 视觉分析]:\n' + visionResults[vi].description);
                }
                visionText = '\n\n━━━ VISION ANALYSIS RESULTS (already completed, DO NOT call analyze_image again) ━━━\n' + parts.join('\n\n') + '\n━━━ END VISION RESULTS ━━━';
            }
            // 视觉计费计入本轮
            if (self._visionCostWge > 0) {
                self._floorCostWge += self._visionCostWge;
                self._log('💰 vision cost: ' + (self._visionCostWge / 10000).toFixed(4) + ' ge');
                self._visionCostWge = 0;
            }
        }
        if (_visionStart) self._floorTiming.aiMs += performance.now() - _visionStart;

        // 推入用户消息（纯文本）
        var finalContent = (userContent || '') + visionText;

        // 归档：保存用户键入供 generateFloorTxt 写入
        self._lastUserInput = { text: userContent || '', vision: visionText || '', images: images || [] };;

        // ═══ 持久化 rules 注入（版本追踪，永不压缩） ═══
        var rulesPrefix = await self._refreshRules();
        if (rulesPrefix) {
            if (self._persistentCount > 0 && self.conversation.length > 0) {
                self.conversation[0] = { role: "user", content: rulesPrefix, _persistent: true };
            } else if (self._persistentCount === 0) {
                self.conversation.unshift({ role: "user", content: rulesPrefix, _persistent: true });
                self._persistentCount = 1;
            }
            self._log("[rules] persistent injected (" + rulesPrefix.length + " chars, v=" + self._rulesVersion.slice(0, 8) + ")");
        }

        self._ctx.totalFloors++;
        var userMsg = { role: 'user', content: finalContent, _floor: self._ctx.totalFloors };
        self.conversation.push(userMsg);
        // 压缩已移至 while 循环内（每间 house 前检查），此处不再触发
        self._log('→ user: ' + (userContent || '').slice(0, 80) + (images ? ' +' + images.length + ' images' : '') + (visionText ? ' [vision done]' : ''));

        // 智能等级：手动选择优先，未选则默认 Pro+Max
        var tier = opts.tier || TIER_PRO;
        self._lastTier = tier;  // ★ 记录当前等级，压缩时复用
        self._log('◆ ' + tier.label);
        var maxIterations = 200;
        var conversationSnapshot = self.conversation.length;
        self._houses = [];
        self._a4Snapshots = {};
        self._houseIndex = 0;
        self._compressAttemptedThisFloor = false;
        self._floorKilled = false;  // ★ 看门狗：用户点停止才置 true
        self._floorCompletedCleanly = false;  // ★ 看门狗：只有 onDone 路径才置 true
        self._floorOnErrorCalled = false;  // ★ 看门狗：onError 回调已处理，不重复恢复
        self._sendTerminated = false;  // ★ 终止旗：onError 后强制退出 while
        // ★ 终极 Stop 闭环：每层楼创建真理源
        self._stopCtrl = new AbortController();
        self._stopState = 'sending';
        if (typeof window !== 'undefined') { window._qqqReadFilesThisFloor = {}; window._qqqEnoentCache = {}; window._qqqPathResolve = {}; window._qqqToolCacheThisFloor = {}; }  // ★ WRITE感知复位 + ENOENT + 路径纠错 + 泛化 READ 缓存：每层楼复位

        try {
            while (maxIterations-- > 0 && !self._sendTerminated && self._stopState === 'sending') {
                // ═══ 引导确认回合：不中断楼层，立即让 AI 回复确认 ═══
                if (self._guidePending && self._guideMessage) {
                    self._guidePending = false;
                    self._abortedByGuide = false;
                    var _guideText = self._guideMessage;
                    self._guideMessage = '';
                    maxIterations++; // 确认回合不消耗迭代配额
                    var _ackStart = Date.now();

                    self._log('⚡ guide ack round: ' + _guideText.slice(0, 60));

                    // 引导确认回合：注入 → AI 简短确认收到 → pop prompt
                    // The user sent a guide message — supplemental info or a direction change — without breaking the floor.
                    // Acknowledge NOW: (1) confirm received, (2) recap what the user asked for so they can verify.
                    // Brief, no tools, no XML tags.
                    var _ackPrompt = '[GUIDE] ' + _guideText + '\nThe above is a guide message from the user (supplemental info or direction change). Acknowledge immediately in one sentence: (1) confirm received, (2) briefly restate what the user wants so they know you understood correctly. No tools, no XML tags.';

                    self.conversation.push({ role: 'user', content: _ackPrompt, _guideAck: true, _floor: self._ctx.totalFloors });

                    var _ackResp = await self._callGateway(self.conversation, {
                        token: token,
                        onToken: onToken,
                        onReasoning: onReasoning,
                        onError: onError,
                        tier: tier,
                        noTools: true
                    });

                    // 确认回合被再次引导中断 → pop ack prompt，让新引导接管
                    if (_ackResp && _ackResp._abortedForGuide) {
                        self.conversation.pop();
                        self._log('⚠ guide ack: aborted by newer guide');
                        continue;
                    }

                    if (_ackResp && _ackResp.content) {
                        // 移除引导 prompt，保留 AI 回复，避免硬指令污染后续对话
                        self.conversation.pop(); // pop _ackPrompt
                        // ★ 防御：剥离 XML 标签（<thinking> <qqq_tool_call> 等）
                        var _ackRaw = _ackResp.content;
                        var _cleanAck = _ackRaw
                            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
                            .replace(/<\/?think(ing)?>/gi, '')
                            .replace(/<qqq_tool_call>[\s\S]*?<\/qqq_tool_call>/gi, '')
                            .replace(/<\/?think>|<\/?thinking>|<qqq_tool_call>|<\/qqq_tool_call>/gi, '')
                            .replace(/\n{3,}/g, '\n\n')
                            .trim();
                        if (!_cleanAck || _cleanAck.length < 3) _cleanAck = 'Guide received';
                        self.conversation.push({ role: 'assistant', content: _cleanAck, _guideAck: true, _guideText: _guideText, _floor: self._ctx.totalFloors });
                        // 归档
                        self._houses.push({ index: 'G' + (self._houseIndex || 0), type: 'guide_ack', tools: [], ms: Date.now() - _ackStart, reasoning: _ackResp.reasoning_content || '', answer: _ackResp.content, ts: new Date().toISOString() });
                        // ★ 更新绿条标记：两行格式，✅ 已收到引导 / 确认内容
                        var _aiDiv2 = self._activeAiDiv;
                        var _esc = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
                        var _ackDisplay = _cleanAck.slice(0, 200);
                        if (_aiDiv2 && _aiDiv2._guideMarker) {
                            _aiDiv2._guideMarker.style.cssText = '';
                            _aiDiv2._guideMarker.className = 'msg-flow-guide-ack';
                            _aiDiv2._guideMarker.innerHTML = '<div class="msg-flow-guide-ack-hdr"><span class="msg-flow-icon">✅</span> Guide received</div><div class="msg-flow-guide-ack-body">' + _esc(_ackDisplay) + '</div>';
                            _aiDiv2._guideMarker = null;
                        } else if (_aiDiv2 && _aiDiv2._contentWrap) {
                            // ★ 兜底：marker 丢失时创建新的确认块（防绿条空洞）
                            var _ackEl = document.createElement('div');
                            _ackEl.className = 'msg-flow-guide-ack';
                            _ackEl.innerHTML = '<div class="msg-flow-guide-ack-hdr"><span class="msg-flow-icon">✅</span> Guide received</div><div class="msg-flow-guide-ack-body">' + _esc(_ackDisplay) + '</div>';
                            _aiDiv2._contentWrap.appendChild(_ackEl);
                        }
                        if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
                        self._log('✅ guide ack: ' + _ackResp.content.slice(0, 120));
                    } else if (_ackResp && _ackResp.type === 'tool_calls') {
                        // 引导回合 AI 返回工具调用（noTools=true 下不应发生）
                        self.conversation.pop();
                        self._log('⚠ guide ack: AI returned tool_calls despite noTools, cleared');
                        // ★ 显示失败状态（替代空条）
                        var _aiDiv3 = self._activeAiDiv;
                        if (_aiDiv3 && _aiDiv3._guideMarker) {
                            _aiDiv3._guideMarker.style.cssText = '';
                            _aiDiv3._guideMarker.className = 'msg-flow-guide';
                            _aiDiv3._guideMarker.innerHTML = '<span class="msg-flow-icon">⚠️</span> 引导确认异常，已跳过';
                            _aiDiv3._guideMarker = null;
                        }
                    } else {
                        // 网络错误或其他异常 → 移除 prompt，标记失败，不阻塞
                        self.conversation.pop();
                        self._log('⚠ guide ack: no valid response, skipped');
                        var _aiDiv4 = self._activeAiDiv;
                        if (_aiDiv4 && _aiDiv4._guideMarker) {
                            _aiDiv4._guideMarker.style.cssText = '';
                            _aiDiv4._guideMarker.className = 'msg-flow-guide';
                            _aiDiv4._guideMarker.innerHTML = '<span class="msg-flow-icon">⚠️</span> 引导确认超时，已跳过';
                            _aiDiv4._guideMarker = null;
                        }
                    }
                    // 确认回合结束 → 恢复被延迟的最终回复（若有）
                    onGuideAckDone();
                    if (self._deferredFinalMsg) {
                        var _restoredContent = self._deferredFinalMsg.content;
                        self.conversation.push(self._deferredFinalMsg);
                        self._deferredFinalMsg = null;
                        self._log('↩ deferred final msg restored after guide ack');
                        // 计费
                        var _costGe = self._floorCostWge / 10000;
                        self.totalCostGe += _costGe;
                        self._lastCostDisplay = _costGe < 0.001 ? '<0.001' : _costGe.toFixed(4);
                        onCost(self._lastCostDisplay, self.totalCostGe, self._floorFree);
                        self._floorCompletedCleanly = true;
                        onDone(_restoredContent, self._floorTiming);
                        return _restoredContent;
                    }
                    continue;
                }

                // ═══ 压缩守护：每间 house 前检查，超阈值则阻塞压缩 ═══
                if (!self._compressing && !self._compressAttemptedThisFloor) {
                    var _apiTokens = self._lastApiTotalTokens || self._lastApiPromptTokens || 0;
                    var _threshold = (typeof ContentGateway !== 'undefined') ? ContentGateway.COMPRESS_THRESHOLD : 900000;
                    if (_apiTokens === 0 || _apiTokens <= _threshold) { /* skip */ }
                    else {
                        self._compressAttemptedThisFloor = true;
                        self._compressing = true;
                        window._updateSendBtnForCompress(true);
                        try {
                            var _reason = 'Auto-compress (' + Math.round(_apiTokens / 1000) + 'k / ' + Math.round(_threshold / 1000) + 'k, >90% threshold)';
                            self._renderCompressStart(_reason);
                            var _result = await self._compressContext({ trigger: 'auto', detail: _reason });
                            self._renderCompressResult(_result);
                        } finally {
                            self._compressing = false;
                            window._updateSendBtnForCompress(false);
                        }
                    }
                }

                self._houseIndex++;
                // ★ 跨面板写冲突预警：检查上一轮 AI 调用以来是否有其他面板修改了文件
                if (self._lastCallTs && typeof _panelId !== 'undefined') {
                    try {
                        var _p = window.parent || window;
                        if (_p.__qqq_getStaleFiles) {
                            var _stale = _p.__qqq_getStaleFiles(_panelId, self._lastCallTs);
                            if (_stale.length > 0) {
                                var _warn = '[System: ⚠️ The following files were modified by another panel since your last read. Re-read before editing: ' + _stale.join(', ') + ']';
                                self.conversation.push({ role: 'user', content: _warn, _system: true, _floor: self._ctx.totalFloors });
                                self._log('  ║ injected stale-files warning: ' + _stale.length + ' file(s)');
                            }
                        }
                    } catch (_) { }
                }
                self._lastCallTs = Date.now();
                var _hStart = Date.now();
                var response = await self._callGateway(self.conversation, {
                    token: token,
                    onToken: onToken,
                    onReasoning: onReasoning,
                    onError: onError,
                    tier: tier
                });

                if (!response) {
                    // 400/422/502/503 自动修复：弹掉最后一组 assistant+tool，重试
                    if ((self._lastGatewayError === 400 || self._lastGatewayError === 422 || self._lastGatewayError === 502 || self._lastGatewayError === 503) && !opts._repairAttempted) {
                        self._lastGatewayError = 0;
                        // ★ 找到最后一个 assistant(tool_calls)，截断其后所有消息
                        var conv2 = self.conversation;
                        for (var _rr = conv2.length - 1; _rr >= 0; _rr--) {
                            if (conv2[_rr] && conv2[_rr].role === 'assistant' && conv2[_rr].tool_calls) {
                                conv2.length = _rr;
                                self._log('→ auto-repair: popped last assistant+tool group (idx=' + _rr + '), retrying...');
                                break;
                            }
                        }
                        opts._repairAttempted = true;
                        maxIterations++;
                        self._floorOnErrorCalled = false;
                        self._lastGatewayMessage = '';
                        continue;
                    }
                    // ★ auto-repair 不适用或已尝试 → 统一在此处报错（延迟报错，避免 UI 假死）
                    var _errMsg = self._lastGatewayMessage || '⚠️ Unexpected response. Conversation saved.';
                    self._lastGatewayMessage = '';
                    if (!self._floorOnErrorCalled && self._stopState === 'sending') {
                        onError(_errMsg);
                    }
                    self._sendTerminated = true;  // ★ 强制终止 while 循环
                    // 不回滚 conversation — 保留已执行的 tool call 结果，用户可重试
                    return null;
                }
                // 引导中断 → 继续循环（上面 _guidePending 检测会触发确认回合）
                if (response._abortedForGuide) {
                    continue;
                }
                // accumulate timing from gateway call
                if (response._ttfbMs !== undefined) {
                    self._floorTiming.networkMs += response._ttfbMs;
                    self._floorTiming.aiMs += response._streamMs;
                }
                // API 精确上下文 token 计数
                //   _lastApiPromptTokens: 发送时 conversation 的 token 数（用于动态帽）
                //   _lastApiTotalTokens: prompt + completion 的 token 数（用于按钮显示/压缩阈值）
                if (response._usage && response._usage.prompt_tokens) {
                    self._lastApiPromptTokens = response._usage.prompt_tokens;
                    self._lastApiTotalTokens = response._usage.total_tokens || (response._usage.prompt_tokens + (response._usage.completion_tokens || 0));
                    // ★ 每间 house 立即更新上下文按钮（服务器真理，不再等 quest 切换）
                    if (typeof updateCtxBtn === 'function') updateCtxBtn();
                    // ★ 诊断日志：记录服务器返回的精确 token 数
                    if (typeof self._writeFileLog === 'function') {
                        self._writeFileLog('  📊 api total_tokens=' + self._lastApiTotalTokens + ' prompt=' + self._lastApiPromptTokens + ' completion=' + (response._usage.completion_tokens || 0) + ' (floor ' + self._ctx.totalFloors + ', house ' + self._houseIndex + ')');
                    }
                }

                if (response.type === 'message') {
                    // ★ 引导在最终回复流式期间到达 → 暂存回复，先处理引导确认，再重新获取最终回复
                    if (self._guidePending && self._guideMessage) {
                        self._log('⚠ final response arrived but guide pending — deferring');
                        // 暂存当前回复的 conversation 消息（已流式输出给用户，不丢）
                        var _deferredMsg = { role: 'assistant', content: response.content, _floor: self._ctx.totalFloors };;
                        // ★ 暂存到 agent，等引导确认回合结束后 push 回 conversation
                        self._deferredFinalMsg = _deferredMsg;
                        // 不调用 onDone（等引导确认后再处理最终回复）
                        maxIterations++;  // 不消耗迭代配额
                        continue;  // 回到循环顶部 → 触发引导确认回合
                    }
                    var _bill = self._lastBilling; self._lastBilling = null;
                    var _cd = self._lastCacheDiag; self._lastCacheDiag = null;
                    self._houses.push({ index: self._houseIndex, type: 'final', tools: [], ts: new Date().toISOString(), ms: Date.now() - _hStart, reasoning: response.reasoning_content || '', answer: response.content || '', geCost: _bill ? _bill.geCost : 0, model: _bill ? _bill.model : '', cacheHitRate: _bill ? _bill.cacheHitRate : -1, usage: _bill ? _bill.usage : null, billingSeq: _bill ? _bill.seq : 0, billingRequestId: _bill ? _bill.requestId : '', cacheDiag: _cd || undefined });
                    if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
                    var assistantMsg = { role: 'assistant', content: response.content, _floor: self._ctx.totalFloors };
                    // 替换之前因切换 quest 而保存的截断消息，避免重复
                    var _lastConv = self.conversation[self.conversation.length - 1];
                    if (_lastConv && _lastConv._truncated && _lastConv._floor === self._ctx.totalFloors) {
                        self.conversation[self.conversation.length - 1] = assistantMsg;
                    } else {
                        self.conversation.push(assistantMsg);
                    }
                    // 计费（Go 服务器 SSE 流中已完成）
                    var costGe = self._floorCostWge / 10000;
                    self.totalCostGe += costGe;
                    self._lastCostDisplay = costGe < 0.001 ? '<0.001' : costGe.toFixed(4);
                    onCost(self._lastCostDisplay, self.totalCostGe, self._floorFree);
                    // ★ 记账埋点：调试模式下打印全楼层账单明细
                    if (self._billingDebug) { _logBillingSummary(self); }
                    self._floorCompletedCleanly = true;  // ★ 看门狗：AI 正常回复
                    onDone(response.content, self._floorTiming);
                    return response.content;
                }

                if (response.type === 'tool_calls') {

                    var _tools = response.tool_calls.map(function (tc) {
                        var _name = tc.function.name;
                        if (typeof tc.function.arguments !== 'string') return { name: _name, args: tc.function.arguments };
                        // ★ 安全解析：DeepSeek 偶发生成畸形 JSON，容错处理
                        try { return { name: _name, args: JSON.parse(tc.function.arguments) }; } catch (_e1) {
                            // L1: 去末尾逗号（},] 前的逗号是 JSON 语法错误，去掉不改语义）
                            try {
                                var _sanitized = tc.function.arguments.replace(/,\s*([}\]])/g, '$1');
                                return { name: _name, args: JSON.parse(_sanitized) };
                            } catch (_e2) {
                                // L2: 全部失败 → 空 object 降级，工具缺参会报错让 AI 重试
                                self._log('⚠ JSON parse failed for ' + _name + ' args (len=' + tc.function.arguments.length + '): ' + _e1.message.slice(0, 80) + ' → fallback {}');
                                return { name: _name, args: {} };
                            }
                        }
                    });
                    var _bill2 = self._lastBilling; self._lastBilling = null;
                    var _cd2 = self._lastCacheDiag; self._lastCacheDiag = null;
                    self._houses.push({ index: self._houseIndex, type: 'tools', tools: _tools, toolResults: [], ts: new Date().toISOString(), ms: Date.now() - _hStart, reasoning: response.reasoning_content || '', geCost: _bill2 ? _bill2.geCost : 0, model: _bill2 ? _bill2.model : '', cacheHitRate: _bill2 ? _bill2.cacheHitRate : -1, usage: _bill2 ? _bill2.usage : null, billingSeq: _bill2 ? _bill2.seq : 0, billingRequestId: _bill2 ? _bill2.requestId : '', cacheDiag: _cd2 || undefined });
                    if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
                    // ★ per-house ge display: 每间 house 即时更新右下角费用（纯 DOM，零服务器压力）
                    var _aiDiv5 = self._activeAiDiv;
                    if (_aiDiv5 && _aiDiv5._clockCost) {
                        var _rawGe5 = self._floorCostWge / 10000;
                        var _displayGe5 = typeof _formatGeDisplay === 'function' ? _formatGeDisplay(_rawGe5) : _rawGe5.toFixed(2);
                        _aiDiv5._clockCost._rawGe = typeof _formatGeRaw === 'function' ? _formatGeRaw(_rawGe5) : _rawGe5.toFixed(4);
                        _aiDiv5._clockCost.textContent = _displayGe5 + ' ge' + (self._floorFree ? ' Free' : '');
                        _aiDiv5._clockCost.style.display = 'inline';
                        if (self._floorFree) {
                            _aiDiv5._clockCost.style.color = '#859900';
                        } else {
                            _aiDiv5._clockCost.style.color = '';
                        }
                    }
                    var assistantToolMsg = {
                        role: 'assistant', content: '',
                        tool_calls: response.tool_calls,
                        _floor: self._ctx.totalFloors
                    };

                    // 通知 UI 有工具调用（不等工具执行完，实时反馈）
                    for (var tc = 0; tc < response.tool_calls.length; tc++) {
                        onToolCall(response.tool_calls[tc]);
                    }

                    // 并行执行工具 → 收集全部结果
                    var _toolStart = performance.now();
                    var _execResult = await self._executeToolCallsParallel(response.tool_calls, assistantToolMsg, onToolResult);

                    // ★ 原子推入 conversation：assistant tool_calls + 全部 tool 结果，无缝隙
                    //    防止 auto-save 在中间捕获断裂状态导致校验失败
                    if (_execResult && _execResult.assistantMsg) {
                        self.conversation.push(_execResult.assistantMsg);
                    }
                    var _pushedToolCount = 0;
                    if (_execResult && _execResult.allResults) {
                        for (var ri2 = 0; ri2 < _execResult.allResults.length; ri2++) {
                            var r2 = _execResult.allResults[ri2];
                            self.conversation.push({
                                role: 'tool',
                                tool_call_id: r2.call.id,
                                content: r2.content,
                                _floor: self._ctx.totalFloors
                            });
                            _pushedToolCount++;
                        }
                    }
                    // ★ 断言：推入的 tool 结果数应等于 assistant.tool_calls 数
                    var _expectedCount = response.tool_calls ? response.tool_calls.length : 0;
                    // ★ 诊断埋点：记录 push 详情
                    if (typeof self._dumpConversation === "function") {
                        var _tcSummary = (response.tool_calls || []).map(function (tc) { return { id: tc.id, name: tc.function.name }; });
                        var _resSummary = (_execResult && _execResult.allResults) ? _execResult.allResults.map(function (r) { return { id: r.call.id, name: r.call.function ? r.call.function.name : "?", contentLen: r.content ? r.content.length : 0 }; }) : [];
                        self._dumpConversation("toolpush", { toolCalls: _tcSummary, results: _resSummary, pushedCount: _pushedToolCount, expectedCount: _expectedCount });
                    }
                    if (_pushedToolCount !== _expectedCount) {
                        var _orphanMsg = '⚠ ORPHAN DETECTED at source: assistant has ' + _expectedCount + ' tool_calls but only ' + _pushedToolCount + ' tool results pushed (floor ' + self._ctx.totalFloors + ', house ' + self._houseIndex + ')';
                        self._log(_orphanMsg);
                        if (typeof self._writeFileLog === 'function') self._writeFileLog(_orphanMsg);
                        // 立即自愈：弹掉刚推入的不完整组
                        var conv3 = self.conversation;
                        for (var _pp = conv3.length - 1; _pp >= 0; _pp--) {
                            if (conv3[_pp] && conv3[_pp].role === 'assistant' && conv3[_pp].tool_calls) {
                                conv3.length = _pp;
                                break;
                            }
                        }
                    }
                }
                continue;  // 工具执行完毕，回到 while 循环顶部进入下一间 house
                // 不中断，给用户一个可读的结束
                var _utype = (response && response.type);
                var _uusage = (response && response._usage);
                var _umsg = '⚠ unexpected response type: ' + _utype + ' _usage=' + (_uusage ? JSON.stringify({ prompt: _uusage.prompt_tokens, total: _uusage.total_tokens, completion: _uusage.completion_tokens }) : 'null');
                self._log(_umsg);
                if (typeof self._writeFileLog === 'function') self._writeFileLog(_umsg);
                var _fallbackMsg = '⚠ AI returned an unexpected response type. Conversation preserved. You can continue or retry.';
                self.conversation.push({ role: 'assistant', content: _fallbackMsg, _floor: self._ctx.totalFloors });
                self._floorCompletedCleanly = true;  // ★ 看门狗：虽非理想但已给出可读结束
                onDone(_fallbackMsg, self._floorTiming);
                return _fallbackMsg;
            }

            // 迭代耗尽 → 强制最终回答
            if (maxIterations <= 0) {
                self._houseIndex++;
                var _hFinalStart = Date.now();
                self._log('⚠ max iterations (200) reached, forcing final answer');
                self.conversation.push({ role: 'user', content: '[System: You have used all available tool calls. Now give your final answer based on what you have gathered so far. Be concise.]', _floor: self._ctx.totalFloors });
                var finalResp = await self._callGateway(self.conversation, {
                    token: token, onToken: onToken, onReasoning: onReasoning,
                    onError: onError, tier: tier, noTools: true
                });
                if (finalResp && finalResp.content) {
                    // ★ 引导在强制回复流式期间到达 → 暂存，先确认引导
                    if (self._guidePending && self._guideMessage) {
                        self._log('⚠ forced final response arrived but guide pending — deferring');
                        self.conversation.push({ role: 'user', content: '[System: The previous forced final answer was deferred. Now give your final answer after acknowledging the guide.]', _floor: self._ctx.totalFloors });
                        // 不在循环内，不能用 continue → 直接 return，引导会在下次 send 时触发确认回合
                        self._floorCompletedCleanly = true;
                        onDone('(deferred for guide)', self._floorTiming);
                        return '(deferred for guide)';
                    }
                    var _bill3 = self._lastBilling; self._lastBilling = null;
                    var _cd3 = self._lastCacheDiag; self._lastCacheDiag = null;
                    self._houses.push({ index: self._houseIndex, type: 'final', tools: [], summary: '(forced)', ts: new Date().toISOString(), ms: Date.now() - _hFinalStart, reasoning: finalResp.reasoning_content || '', answer: finalResp.content || '', geCost: _bill3 ? _bill3.geCost : 0, model: _bill3 ? _bill3.model : '', cacheHitRate: _bill3 ? _bill3.cacheHitRate : -1, usage: _bill3 ? _bill3.usage : null, billingSeq: _bill3 ? _bill3.seq : 0, billingRequestId: _bill3 ? _bill3.requestId : '', cacheDiag: _cd3 || undefined });
                    if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
                    if (finalResp._ttfbMs !== undefined) {
                        self._floorTiming.networkMs += finalResp._ttfbMs;
                        self._floorTiming.aiMs += finalResp._streamMs;
                    }
                    self.conversation.push({ role: 'assistant', content: finalResp.content, _floor: self._ctx.totalFloors });
                    var finalCostGe = self._floorCostWge / 10000;
                    self.totalCostGe += finalCostGe;
                    self._lastCostDisplay = finalCostGe < 0.001 ? '<0.001' : finalCostGe.toFixed(4);
                    onCost(self._lastCostDisplay, self.totalCostGe, self._floorFree);
                    self._floorCompletedCleanly = true;  // ★ 看门狗：强制回答成功
                    onDone(finalResp.content, self._floorTiming);
                    return finalResp.content;
                }
                // 强制回答也失败 → 优雅降级，不丢上下文
                var _exhaustedMsg = '⚠ 已达到最大工具调用次数 (200)，但 AI 未能生成最终回答。对话上下文已保留，你可以继续提问。';
                self.conversation.push({ role: 'assistant', content: _exhaustedMsg, _floor: self._ctx.totalFloors });
                self._floorCompletedCleanly = true;  // ★ 看门狗：已给出降级消息
                onDone(_exhaustedMsg, self._floorTiming);
                return _exhaustedMsg;
            }

            // 不应到达这里，但兜底
            self._lastGatewayMessage = '⚠️ 楼层异常中断，对话已保存。';
            if (!self._floorOnErrorCalled && self._stopState === 'sending') {
                onError(self._lastGatewayMessage);
            }
            self._sendTerminated = true;
            return null;
        } catch (err) {
            self._log('✗ agent error: ' + (err.message || err));
            onError(err.message || String(err));
            return null;
        } finally {
            // ★ P2: 状态机闭环 — 无论正常/错误/停止，清理后复位到 idle
            self._stopState = 'idle';
        }
    };

    // ═══ 视觉预分析：图像 → 文本 ═══
    // 并行分析所有图片，MD5 缓存
    // 返回 [{id, description, cached}] — 失败图片静默跳过
    AgentLoop.prototype._simpleHash = function (str) {
        var h1 = 0, h2 = 0;
        for (var i = 0; i < str.length; i++) {
            h1 = ((h1 << 5) - h1) + str.charCodeAt(i);
            h1 |= 0;
            if (i % 2 === 0) {
                h2 = ((h2 << 5) - h2) + str.charCodeAt(i);
                h2 |= 0;
            }
        }
        return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
    };

    // ---- 网关调用 ----
    AgentLoop.prototype.getFloorTiming = function () {
        return this._floorTiming;
    };
    AgentLoop.prototype.getServerDrift = function () {
        return this._serverDrift;
    };

    // ---- 并行工具执行 ----
    // 返回 { allResults, assistantMsg }，由调用方原子推入 conversation
    // 避免 auto-save 在 tool_calls 与 tool 结果之间捕获断裂状态（校验：tool_calls 后必须紧跟 tool 消息）
    AgentLoop.prototype.inject = function (message) {
        this.conversation.push({ role: 'user', content: message, _injected: true, _floor: this._ctx.totalFloors });
        this._log('→ injected: ' + message.slice(0, 60));
        return true;
    };

    // ═══ 压缩卡片渲染（复用引导消息 UI 模式） ═══
    // 插入压缩启动卡片（紫色）到当前 AI div
    AgentLoop.prototype._renderCompressStart = function (reason) {
        var _aiDiv = this._activeAiDiv;
        var _escHtml = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
        var _now = new Date();
        var _ts = _now.getFullYear() + '-' + String(_now.getMonth() + 1).padStart(2, '0') + '-' + String(_now.getDate()).padStart(2, '0') + ' ' + String(_now.getHours()).padStart(2, '0') + ':' + String(_now.getMinutes()).padStart(2, '0') + ':' + String(_now.getSeconds()).padStart(2, '0');
        // ★ auto 压缩卡片（仅在活跃楼层渲染，不推 conversation——手动压缩已用专用楼层）
        if (_aiDiv && _aiDiv._contentWrap) {
            var _startCard = document.createElement('div');
            _startCard.className = 'msg-flow-compress-start';
            _startCard.innerHTML = '<div class="msg-flow-compress-hdr"><span class="msg-flow-icon">📦</span> Compress started</div><div class="msg-flow-compress-body">' + _escHtml(_ts) + ' · ' + _escHtml(reason) + '</div>';
            _aiDiv._contentWrap.appendChild(_startCard);
            var _marker = document.createElement('div');
            _marker.className = 'msg-flow-guide';
            _marker.style.cssText = 'opacity:0.6;';
            _marker.innerHTML = '<span class="msg-flow-icon">⏳</span> Compressing...';
            _aiDiv._contentWrap.appendChild(_marker);
            _aiDiv._compressMarker = _marker;
        }
    };

    // 压缩完成后替换等待标记为成功/失败卡片
    AgentLoop.prototype._renderCompressResult = function (result) {
        var _aiDiv = this._activeAiDiv;
        var _escHtml = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
        // ★ auto 压缩结果卡片（仅在活跃楼层渲染）
        if (_aiDiv && _aiDiv._compressMarker) {
            var _marker = _aiDiv._compressMarker;
            _aiDiv._compressMarker = null;
            if (result.compressed) {
                _marker.className = 'msg-flow-compress-success';
                _marker.style.cssText = '';
                _marker.innerHTML = '<div class="msg-flow-compress-success-hdr"><span class="msg-flow-icon">✅</span> Compress completed</div><div class="msg-flow-compress-success-body">' + _escHtml(result.detail) + '</div>';
            } else if (result.detail && (result.detail.indexOf('无需压缩') === 0 || result.detail.indexOf('所有楼层') === 0 || result.detail.indexOf('冷消息不足') === 0)) {
                _marker.className = 'msg-flow-guide';
                _marker.style.cssText = '';
                _marker.innerHTML = '<span class="msg-flow-icon">ℹ️</span> ' + _escHtml(result.detail);
            } else {
                _marker.className = 'msg-flow-compress-fail';
                _marker.style.cssText = '';
                _marker.innerHTML = '<div class="msg-flow-compress-fail-hdr"><span class="msg-flow-icon">✗</span> Compress failed</div><div class="msg-flow-compress-fail-body">' + _escHtml(result.detail || 'Unknown error') + '</div>';
            }
        }
    };

    // ═══ 压缩期间锁定发送按钮 ═══
    window._updateSendBtnForCompress = function (flag) {
        try {
            var _btn = document.getElementById('send-btn');
            if (_btn) {
                _btn.textContent = flag ? '⏳' : (typeof streaming !== 'undefined' && streaming ? 'Stop' : 'Send');
                _btn.className = flag ? 'compressing' : (typeof streaming !== 'undefined' && streaming ? 'stop' : '');
                _btn.disabled = !!flag;
            }
        } catch (_) { }
    };

    // ---- 引导注入（新）：立即中断当前 house，让 AI 回复确认 ----
    // 如果 send() 正在执行 → abort 当前流 + 设置 _guidePending，确认回合在 while 循环中自动触发
    // 如果 send() 未执行 → 降级为普通 inject（等下次 Send）
    AgentLoop.prototype.injectGuide = function (message) {
        this._log('⚡ injectGuide: ' + message.slice(0, 60));
        this._guideMessage = message;
        this._guidePending = true;
        // 立即 abort 当前流（如果有），触发 _abortedByGuide 分支
        if (this.abortController) {
            this.abort();
        }
        return true;
    };

    // ★ 兜底：若 agent-context.js 未加载，提供空壳防全站崩溃
    // ★ 兜底：若拆分出的文件未加载，提供空壳防全站崩溃
    if (!AgentLoop.prototype._analyzeImages) {
        AgentLoop.prototype._analyzeImages = async function () { return []; };
    }
    if (!AgentLoop.prototype._callVision) {
        AgentLoop.prototype._callVision = async function () { return null; };
    }
    if (!AgentLoop.prototype._callGateway) {
        AgentLoop.prototype._callGateway = async function () { return null; };
    }
    if (!AgentLoop.prototype._parseSSE) {
        AgentLoop.prototype._parseSSE = async function () { return null; };
    }
    if (!AgentLoop.prototype._executeToolCallsParallel) {
        AgentLoop.prototype._executeToolCallsParallel = async function (tc, am) { return { allResults: [], assistantMsg: am }; };
    }
    if (!AgentLoop.prototype._buildExecutionLayers) {
        AgentLoop.prototype._buildExecutionLayers = function (calls) { return [{ items: calls, fileMap: {} }]; };
    }
    if (!AgentLoop.prototype._canPlaceInLayer) {
        AgentLoop.prototype._canPlaceInLayer = function () { return true; };
    }
    if (!AgentLoop.prototype._mergeAccess) {
        AgentLoop.prototype._mergeAccess = function (e, i) { return i || e; };
    }
    if (!AgentLoop.prototype._buildDynamicContext) {
        AgentLoop.prototype._buildDynamicContext = function () { return ''; };
    }
    if (!AgentLoop.prototype._updateSendBtnForCompress) {
        AgentLoop.prototype._updateSendBtnForCompress = function () { };
    }

    // ★ 上下文快照：对比两次 API 调用发送的消息数组，定位缓存断裂点
    // 返回 { prevSnapshot, currSnapshot, firstDiffIdx, diffReason, prevMsgKeys, currMsgKeys }
    function _snapshotMessages(messages, prevSnapshot) {
        var _makeKeys = function (m) {
            var keys = [];
            if (!m) return '(null)';
            keys.push(m.role || '?');
            if (m._injected) keys.push('inj');
            if (m._dynamic) keys.push('dyn');
            if (m._guideAck) keys.push('ack');
            if (m._truncated) keys.push('trunc');
            if (m._floor !== undefined) keys.push('f' + m._floor);
            var content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            keys.push('len=' + content.length);
            if (m.tool_calls) keys.push('tc=' + m.tool_calls.length);
            if (m.tool_call_id) keys.push('tid');
            return keys.join('|');
        };

        var _makeSnapshot = function (msgs) {
            var count = msgs.length;
            var firstKeys = [];
            var lastKeys = [];
            var prefixParts = [];
            var n = Math.min(10, count);
            for (var i = 0; i < n; i++) {
                var k = _makeKeys(msgs[i]);
                firstKeys.push(k);
                prefixParts.push(k);
            }
            for (var j = Math.max(0, count - 3); j < count; j++) {
                lastKeys.push(_makeKeys(msgs[j]));
            }
            var prefixHash = prefixParts.join('\n');
            return {
                msgCount: count,
                prefixHash: prefixHash,
                firstMsgKeys: firstKeys,
                lastMsgKeys: lastKeys
            };
        };

        var curr = _makeSnapshot(messages);

        if (!prevSnapshot) {
            return { prevSnapshot: null, currSnapshot: curr, firstDiffIdx: null, diffReason: 'first_call', prevMsgKeys: null, currMsgKeys: curr.firstMsgKeys };
        }

        // 快速路径：prefix hash 相同 → 缓存命中
        if (curr.prefixHash === prevSnapshot.prefixHash && curr.msgCount === prevSnapshot.msgCount) {
            return { prevSnapshot: prevSnapshot, currSnapshot: curr, firstDiffIdx: -1, diffReason: 'prefix_match', prevMsgKeys: prevSnapshot.firstMsgKeys, currMsgKeys: curr.firstMsgKeys };
        }

        // 慢速路径：逐条对比前 50 条消息，找到第一个差异点
        var maxCmp = Math.min(50, Math.max(curr.msgCount, prevSnapshot.msgCount));
        var firstDiff = -1;
        var reason = '';
        for (var i2 = 0; i2 < maxCmp; i2++) {
            var prevKey = i2 < prevSnapshot.msgCount ? _makeKeys(messages[i2]) : '(missing)';
            // Note: messages is the current array; for prev we use prevSnapshot's stored keys
            var prevStoredKey = (prevSnapshot.firstMsgKeys && i2 < prevSnapshot.firstMsgKeys.length) ? prevSnapshot.firstMsgKeys[i2] : ((i2 < prevSnapshot.msgCount) ? '(msg-' + i2 + ')' : '(eos)');
            var currKey = i2 < curr.msgCount ? _makeKeys(messages[i2]) : '(eos)';
            if (prevStoredKey !== currKey) {
                firstDiff = i2;
                if (i2 >= curr.msgCount) {
                    reason = 'msg_removed@' + i2 + ' prev=[' + prevStoredKey + '] curr=(eos)';
                } else if (i2 >= prevSnapshot.msgCount) {
                    reason = 'msg_added@' + i2 + ' prev=(eos) curr=[' + currKey + ']';
                } else if (curr.msgCount !== prevSnapshot.msgCount) {
                    reason = 'msg_diff@' + i2 + ' count_changed prev=' + prevSnapshot.msgCount + ' curr=' + curr.msgCount;
                } else {
                    reason = 'msg_diff@' + i2 + ' prev=[' + prevStoredKey + '] curr=[' + currKey + ']';
                }
                break;
            }
        }
        if (firstDiff < 0) {
            reason = 'diff_beyond_' + maxCmp + ' (msgCount prev=' + prevSnapshot.msgCount + ' curr=' + curr.msgCount + ')';
        }

        return {
            prevSnapshot: prevSnapshot,
            currSnapshot: curr,
            firstDiffIdx: firstDiff,
            diffReason: reason,
            prevMsgKeys: prevSnapshot.firstMsgKeys,
            currMsgKeys: curr.firstMsgKeys
        };
    }

    // ★ 记账埋点：调试账单汇总（floor 完结时调用）
    function _logBillingSummary(ag) {
        if (!ag || !ag._houses) return;
        var houses = ag._houses;
        var floorCost = ag._floorCostWge || 0;
        var lines = [];
        lines.push('══════ BILLING DEBUG — floor ' + (ag._ctx && ag._ctx.totalFloors) + ' ══════');
        lines.push('  floor_id: ' + (ag._floorId || '?'));
        lines.push('  total costWge: ' + floorCost + ' (' + (floorCost / 10000).toFixed(4) + ' ge)');
        lines.push('  free window: ' + (ag._floorFree ? 'YES' : 'NO'));
        lines.push('  houses: ' + houses.length);
        for (var i = 0; i < houses.length; i++) {
            var h = houses[i];
            var ge = (h.geCost || 0) / 10000;
            var usageStr = '';
            if (h.usage) {
                usageStr = ' prompt=' + (h.usage.prompt_tokens || 0) +
                    ' compl=' + (h.usage.completion_tokens || 0) +
                    ' cached=' + (h.usage.cached_tokens || 0) +
                    ' noncached=' + (h.usage.non_cached_tokens || 0);
            }
            lines.push('  H' + i + ': type=' + (h.type || '?') +
                ' geCost=' + ge.toFixed(4) +
                ' model=' + (h.model || '?') +
                ' cacheHit=' + (h.cacheHitRate >= 0 ? h.cacheHitRate.toFixed(1) + '%' : '?') +
                ' billingSeq=' + (h.billingSeq || 0) +
                ' requestId=' + (h.billingRequestId || '') +
                usageStr);
            // ★ 缓存诊断
            if (h.cacheDiag) {
                var cd = h.cacheDiag;
                if (cd.diffReason === 'prefix_match') {
                    lines.push('       cache: ✅ HIT (prefix match, ' + cd.currSnapshot.msgCount + ' msgs)');
                } else if (cd.diffReason === 'first_call') {
                    lines.push('       cache: 🆕 first call (' + cd.currSnapshot.msgCount + ' msgs)');
                } else {
                    lines.push('       cache: ❌ MISS @ idx=' + cd.firstDiffIdx + ' — ' + cd.diffReason);
                }
            }
        }
        if (typeof console !== 'undefined' && console.log) {
            console.log(lines.join('\n'));
        }
    }

    // ═══ 每 agent 独立流式渲染（拒绝全局 _activeAgent） ═══
    AgentLoop.prototype._doStreamRender = function () {
        var aiDiv = this._activeAiDiv;
        if (!aiDiv || !aiDiv._contentWrap) return;  // ★ Card 已驱逐或 DOM 不完整
        if (this._sendTerminated || this._stopState !== 'sending') {
            aiDiv._renderScheduled = false;
            aiDiv._dirty = false;
            return;
        }
        if (!aiDiv._dirty) { aiDiv._renderScheduled = false; return; }
        aiDiv._renderScheduled = false;
        if (aiDiv._guideMode) {
            aiDiv._renderedCount = (aiDiv._paras || []).length;
            for (var _gpi = 0; _gpi < (aiDiv._paras || []).length; _gpi++) aiDiv._paras[_gpi] = null;
            aiDiv._dirty = false;
            return;
        }
        var rendered = aiDiv._renderedCount || 0;
        var paras = aiDiv._paras || [];
        var _rm = typeof renderMarkdown === 'function' ? renderMarkdown : function (s) { return s; };
        while (rendered < paras.length) {
            var para = paras[rendered];
            if (para && para.trim()) {
                var pEl = document.createElement('div');
                pEl.className = 'stream-para';
                pEl.innerHTML = _rm(para);
                aiDiv._contentWrap.appendChild(pEl);
            }
            paras[rendered] = null;
            rendered++;
        }
        aiDiv._renderedCount = rendered;
        if (!aiDiv._lastParaEl) {
            aiDiv._lastParaEl = document.createElement('div');
            aiDiv._lastParaEl.className = 'stream-para';
            aiDiv._contentWrap.appendChild(aiDiv._lastParaEl);
        }
        if (aiDiv._codeFenceOpen && aiDiv._buf) {
            var _codeContent = aiDiv._buf;
            var _firstNL = _codeContent.indexOf('\n');
            if (_firstNL > 0 && /^```/.test(_codeContent)) _codeContent = _codeContent.slice(_firstNL + 1);
            var _esc = typeof escHtml === 'function' ? escHtml : function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
            aiDiv._lastParaEl.innerHTML = '<pre><code>' + _esc(_codeContent) + '</code></pre>';
        } else {
            aiDiv._lastParaEl.innerHTML = _rm(aiDiv._buf || '');
        }
        aiDiv._dirty = false;
    };

    return AgentLoop;
})();

// ═══ 诊断日志：conversation 快照（黑箱暴破） ═══
AgentLoop.prototype._dumpConversation = function (tag, extra) {
    if (typeof window !== "undefined" && window.__qqq_file_log === false) return;
    var self = this;
    var today = new Date().toISOString().slice(0, 10);
    var root = (typeof questStore !== "undefined" && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
    if (!root) return;
    var logDir = root.replace(/\\/g, "/") + "/new_log";
    var fname = tag + "-f" + self._ctx.totalFloors + "-h" + self._houseIndex + ".json";
    var logPath = logDir + "/" + fname;

    var summary = self.conversation.map(function (m) {
        if (!m) return null;
        var s = { role: m.role };
        if (m.content) s.contentLen = (typeof m.content === "string" ? m.content.length : 0);
        if (m.tool_calls) s.tool_calls = m.tool_calls.map(function (tc) { return { id: tc.id, name: tc.function.name }; });
        if (m.tool_call_id) s.tool_call_id = m.tool_call_id;
        if (m._system) s._system = true;
        if (m._persistent) s._persistent = true;
        if (m._floor) s._floor = m._floor;
        if (m._truncated) s._truncated = true;
        if (m._guideAck) s._guideAck = true;
        return s;
    });

    var payload = {
        ts: new Date().toISOString(),
        floor: self._ctx.totalFloors,
        house: self._houseIndex,
        msgCount: self.conversation.length,
        messages: summary
    };
    if (extra) Object.assign(payload, extra);

    try {
        var bridge = window.parent && window.parent.qqqideBridge;
        if (bridge && bridge.fs && bridge.fs.write) {
            bridge.fs.write(logPath, JSON.stringify(payload, null, 2)).catch(function () { });
        }
    } catch (_) { }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AgentLoop };
}
