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
// agent-envelope.js → _utf8Trunc, _makeSummaryHint, EnvelopeStripper
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
        this._exitReason = '';           // 'ok'|'http_502'|'http_503'|'http_429'|'http_402'|'fetch_error'|'watchdog_stream'|'watchdog_output'|'deadline'|'stall'|'max_iter'|'unknown'
        this._lastHttpStatus = 0;        // 最后一次 HTTP 状态码
        this._lastFetchError = '';       // 最后一次 fetch 错误消息
        this._lastSseError = '';         // 最后一次 SSE 服务端错误
        this._lastGatewayMessage = '';   // ★ 延迟报错消息（_callGateway 设，agent loop 读）
        this._abortSource = '';          // 'stream_watchdog'|'output_watchdog'|'fetch_deadline'|'user_kill'|'guide'|''
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
            case 'watchdog_output': parts.push('AI超过10分钟无产出(可能陷入循环)'); break;
            case 'deadline': parts.push('请求90秒无响应(超时)'); break;
            case 'stall': parts.push('Multiple consecutive tool calls with no progress'); break;
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

    // ═══ 修复断裂的 tool_calls（启动自愈，双向扫描） ═══
    // API 硬要求：tool 消息前必须有 assistant tool_calls，tool_calls 后必须有足够 tool
    // 扫描 conversation，砍掉所有孤立的配对（任一方向残缺都移除整组）
    AgentLoop.prototype._repairOrphanedToolCalls = function () {
        var self = this;
        var conv = self.conversation;
        if (!conv || conv.length === 0) return;
        var removedTotal = 0;
        var _lastDirection = '';
        // 多轮扫描直到干净（修复一处可能暴露上一处问题）
        for (var pass = 0; pass < 200; pass++) {  // ★ 跑至干净为止（长对话可能累积大量孤儿）
            var cutAt = -1;
            // 方向 A：assistant tool_calls 缺 tool 消息 → 移除 assistant + 残缺 tool
            for (var i = 0; i < conv.length; i++) {
                var msg = conv[i];
                if (msg && msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    var expected = msg.tool_calls.length;
                    var actual = 0;
                    var toolSeqEnd = i + 1;
                    for (var j = i + 1; j < conv.length; j++) {
                        if (conv[j] && conv[j].role === 'tool') { actual++; toolSeqEnd = j + 1; }
                        else break;
                    }
                    if (actual < expected) {
                        var _detailMsg = '  repair-A: idx=' + i + ' expected=' + expected + ' actual=' + actual + ' removeCount=' + (toolSeqEnd - i) + ' (floor ' + self._ctx.totalFloors + ')';
                        self._log(_detailMsg);
                        if (typeof self._writeFileLog === 'function') self._writeFileLog(_detailMsg);
                        var removeCount = toolSeqEnd - i;
                        conv.splice(i, removeCount);
                        removedTotal += removeCount;
                        cutAt = i;
                        _lastDirection = 'A';
                        break;
                    }
                    i = toolSeqEnd - 1;
                }
            }
            if (cutAt >= 0) continue;  // 本轮有修复，重新扫描
            // 方向 B：tool 消息缺前置 assistant tool_calls → 移除孤立的 tool
            for (var k = 0; k < conv.length; k++) {
                var m2 = conv[k];
                if (m2 && m2.role === 'tool') {
                    var prev = k > 0 ? conv[k - 1] : null;
                    // 前一条不是 assistant with tool_calls → 孤立的 tool
                    if (!prev || prev.role !== 'assistant' || !prev.tool_calls || !Array.isArray(prev.tool_calls)) {
                        var end = k + 1;
                        // 连续 tool 消息全砍（它们都缺前置 tool_calls）
                        while (end < conv.length && conv[end] && conv[end].role === 'tool') end++;
                        conv.splice(k, end - k);
                        removedTotal += end - k;
                        cutAt = k;
                        _lastDirection = 'B';
                        break;
                    }
                }
            }
            if (cutAt < 0) break;  // 两个方向都无修复，干净
        }
        self._lastRepairLen = conv.length;
        self._lastRepairHadWork = (removedTotal > 0);
        if (removedTotal > 0) {
            var _repairMsg = '🔧 repaired: removed ' + removedTotal + ' orphaned msgs (direction ' + (_lastDirection || '?') + ', floor ' + self._ctx.totalFloors + ', house ' + self._houseIndex + ')';
            self._log(_repairMsg);
            if (typeof self._writeFileLog === 'function') self._writeFileLog(_repairMsg);
        }
    };

    // ═══ 阶梯式停滞检测（三层：工具循环 → 搜索停滞 → 真正空转） ═══
    //   原则：永远不剥离工具。模型有手才能干活，砍手只能得到无法解析的文本工具调用。
    AgentLoop.prototype._resetStallCounter = function () {
        this._stallCount = 0;
        this._stallWarned = false;
        this._searchFruitlessCount = 0;  // 搜索有结果但从不读/写
        this._stallForceSent = false;     // force 消息只发一次
        this._searchStallSent = false;    // T2 L1 搜索停滞警告只发一次
        this._searchStallEscalated = false; // T2 L2 升级警告只发一次
        this._t1ConsecutiveCount = 0;     // ★ T1 同指纹连续触发次数（≥8 终止楼层）
        this._lastT1Fingerprint = '';     // ★ 上一次 T1 触发时的指纹
        this._t1LastResult = '';          // ★ 上一次 T1 触发时的结果摘要（增量检测）
    };
    AgentLoop.prototype._checkStall = function (toolResults, toolNames, toolArgsList) {
        var self = this;
        // ★ 入口日志：绕过 log 过滤器，直接用 console.warn 确认 _checkStall 被调到
        console.warn('[stall-check] house=' + self._houseIndex + ' tools=' + (toolNames || []).join(',') + ' results=' + (toolResults || []).length + ' sc=' + self._stallCount + ' sfc=' + self._searchFruitlessCount);
        if (!toolResults || toolResults.length === 0) return false;
        if (!toolNames) toolNames = [];
        if (!toolArgsList) toolArgsList = [];

        // ── 辅助：判断单条结果是否无进展 ──
        var _isDead = function (r) {
            if (typeof r !== 'string') return false;  // 非字符串=有结果
            if (r === '') return true;
            if (/^\[ALREADY READ\]/i.test(r)) return true;  // ★ 去重拦截=无进展（内容已在对话中，重复读取无意义）
            if (/^\[SEARCH DISABLED\]/i.test(r)) return true;  // ★ 搜索工具被禁=无进展
            if (/^(No (matches|files|results) found)/i.test(r)) return true;
            if (/^(Error|Tool error)/i.test(r)) return true;
            if (/^\s*\[\s*\]\s*$/.test(r)) return true;  // JSON 空数组
            return false;
        };
        // ── 辅助：判断工具是否为纯搜索（查找，不读不写） ──
        var _isSearchTool = function (name) {
            return name === 'search_text' || name === 'search_content' || name === 'search_file'
                || name === 'find_files' || name === 'list_files'
                || name === 'search_symbol' || name === 'grep_code'
                || name === 'search_smart' || name === 'search_codebase';
        };
        // ── 辅助：判断工具是否为读/写（实质性操作） ──
        var _isReadWriteTool = function (name) {
            return name === 'read_file' || name === 'edit_file' || name === 'search_replace'
                || name === 'create_file' || name === 'write_file' || name === 'delete_file'
                || name === 'run_command' || name === 'run_in_terminal';
        };

        // ═══ 预判：本轮结果是否全部无进展（含 [ALREADY READ]） ═══
        //   T1/T3 分流依据：全部 dead → 跳过 T1 工具循环检测，交给 T3 递增 stallCount
        //   因为 [ALREADY READ] 说明模型已被去重拦截而非主动重复调用
        var _allDead = toolResults.every(function (r) { return _isDead(r); });

        // ═══ T1: 工具循环检测（3 次同工具+同参数 → 死循环） ═══
        //   ★ 守卫：仅当 NOT 全部 dead 时才检查 —— [ALREADY READ] 循环交给 T3
        if (!_allDead && self._houses.length >= 3) {
            var _last3 = self._houses.slice(-3);
            var _allTools = _last3.every(function (h) { return h.type === 'tools'; });
            if (_allTools) {
                var _toolFingerprints = _last3.map(function (h) {
                    var _fp = [];
                    for (var _ti = 0; _ti < h.tools.length; _ti++) {
                        var _t = h.tools[_ti];
                        var _argsKey = '';
                        if (_t.args) {
                            _argsKey = (_t.args.path || _t.args.regex || _t.args.keyword || _t.args.command || _t.args.url || _t.args.pattern || _t.args.query || '');
                            if (_t.args.path) {
                                _argsKey = _argsKey.replace(/\\/g, '/').toLowerCase();
                                if (_t.args.start_line != null) _argsKey += '|s' + _t.args.start_line;
                                if (_t.args.end_line != null) _argsKey += '|e' + _t.args.end_line;
                            }
                        }
                        _fp.push(_t.name + '\x00' + _argsKey);
                    }
                    return _fp.sort().join('\x01');
                });
                if (_toolFingerprints[0] && _toolFingerprints[0] === _toolFingerprints[1] && _toolFingerprints[0] === _toolFingerprints[2]) {
                    self._log('⚠ T1 tool-loop: same tool+args 3 times');
                    self._lastT1Fingerprint = _toolFingerprints[0];  // ★ 记录指纹供 handler 做连续计数
                    return 'tool_loop';
                }
            }
        }

        // ═══ T2: 搜索停滞检测 → 纯信息助手，永不禁止工具永不终止 ═══
        //   三级升级：5→10→15，每级注入更强引导信息（含已找到的文件路径）
        var _allSearch = toolNames.length > 0 && toolNames.every(function (n) { return _isSearchTool(n); });
        var _anySearchHasResults = toolResults.some(function (r) { return !_isDead(r); });
        var _anyReadWrite = toolNames.some(function (n) { return _isReadWriteTool(n); });

        if (_allSearch && _anySearchHasResults) {
            self._searchFruitlessCount++;
        } else if (_anyReadWrite) {
            self._searchFruitlessCount = 0;
            self._searchStallSent = false;
            self._searchStallEscalated = false;
        }
        // L1: 连续 5 次纯搜索（有结果但不读）→ 温和提醒 + 路径注入
        if (self._searchFruitlessCount >= 5 && !self._searchStallSent) {
            self._searchStallSent = true;
            self._log('⚠ T2 search-stagnation L1: ' + self._searchFruitlessCount + ' searches found files but never read');
            return 'search_stall';
        }
        // L2: 连续 10 次 → 更强引导信息
        if (self._searchFruitlessCount >= 10 && !self._searchStallEscalated) {
            self._searchStallEscalated = true;
            self._log('⚠ T2 search-stagnation L2: ' + self._searchFruitlessCount + ' searches no reads. Stronger guidance.');
            return 'search_stall_escalate';
        }
        // L3: 连续 15 次 → 终极引导（永不终止，仅最强信息注入）
        if (self._searchFruitlessCount >= 15) {
            self._log('⚠ T2 search-stagnation L3: ' + self._searchFruitlessCount + ' searches no reads. Max guidance.');
            return 'search_stall_escalate';  // ★ 复用 L2 的升级消息路径
        }

        // ═══ T3: 真正空转（全部结果无进展） ═══
        if (_allDead) {
            self._stallCount++;
        } else {
            self._stallCount = 0;
        }
        // 5 次真无进展 → 警告
        if (self._stallCount >= 5 && !self._stallWarned) {
            self._stallWarned = true;
            return 'warn';
        }
        // 8 次真无进展 → 强制（注入消息，不剥离工具）
        if (self._stallCount >= 8 && !self._stallForceSent) {
            self._stallForceSent = true;
            return 'force';
        }
        return false;
    };

    // ★ 从最近 N 个 house 的搜索结果中提取唯一文件路径
    //   用于 T2 停滞消息注入：告诉模型它到底找到了哪些文件
    AgentLoop.prototype._collectFoundFilePaths = function (maxHouses) {
        var self = this;
        var paths = [];
        var seen = {};
        var _recent = self._houses.slice(-(maxHouses || 8));
        for (var hi = 0; hi < _recent.length; hi++) {
            var h = _recent[hi];
            if (!h || !h.toolResults) continue;
            for (var ri = 0; ri < h.toolResults.length; ri++) {
                var r = h.toolResults[ri];
                if (typeof r !== 'string') continue;
                // 提取看起来像文件路径的行（含盘符或斜杠）
                var _lines = r.split('\n');
                for (var li = 0; li < _lines.length; li++) {
                    var line = _lines[li].trim();
                    if (!line) continue;
                    // 匹配绝对路径：Windows E:\... 或 Unix /...
                    var _isPath = /^[A-Za-z]:[\\/]/.test(line) || /^\//.test(line);
                    if (!_isPath) continue;
                    // 排除二进制 blob 文件
                    if (/\.gz$/i.test(line)) continue;
                    var norm = line.replace(/\\/g, '/').toLowerCase();
                    if (!seen[norm]) {
                        seen[norm] = true;
                        paths.push(line);
                    }
                }
            }
        }
        return paths.slice(0, 12); // 最多 12 个路径
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
        // ═══ TRAILING REMINDER — reinforce main project after all rules ═══
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
        var forceNoTools = false;

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
        self._resetStallCounter();
        if (typeof window !== 'undefined') { window._qqqReadFilesThisFloor = {}; window._qqqEnoentCache = {}; window._qqqPathResolve = {}; window._qqqToolCacheThisFloor = {}; }  // ★ 去重 + ENOENT + 路径纠错 + 泛化 READ 缓存：每层楼复位

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
                        self._houses.push({ index: 'G' + (self._houseIndex || 0), type: 'guide_ack', tools: [], summary: '', ms: Date.now() - _ackStart, reasoning: _ackResp.reasoning_content || '', answer: _ackResp.content, ts: new Date().toISOString() });
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
                    tier: tier,
                    noTools: forceNoTools,
                    forceNoTools: forceNoTools
                });

                if (!response) {
                    // 400/422/502/503 自动修复：轻量砍掉断裂的 tool_calls，继续当前循环重试
                    if ((self._lastGatewayError === 400 || self._lastGatewayError === 422 || self._lastGatewayError === 502 || self._lastGatewayError === 503) && !opts._repairAttempted) {
                        self._lastGatewayError = 0;
                        self._repairOrphanedToolCalls();
                        self._resetStallCounter();
                        opts._repairAttempted = true;  // 防止无限循环
                        maxIterations++;  // 不消耗迭代配额
                        self._floorOnErrorCalled = false;  // ★ 重置：auto-repair 成功则之前的 onError 作废
                        self._lastGatewayMessage = '';
                        self._log('→ repair: orphaned tool_calls stripped, retrying...');
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
                }

                if (response.type === 'message') {
                    // ★ 引导在最终回复流式期间到达 → 暂存回复，先处理引导确认，再重新获取最终回复
                    if (self._guidePending && self._guideMessage) {
                        self._log('⚠ final response arrived but guide pending — deferring');
                        // 暂存当前回复的 conversation 消息（已流式输出给用户，不丢）
                        var _deferredMsg = { role: 'assistant', content: response.content, _floor: self._ctx.totalFloors };
                        if (response.reasoning_content) _deferredMsg.reasoning_content = response.reasoning_content;
                        // ★ 暂存到 agent，等引导确认回合结束后 push 回 conversation
                        self._deferredFinalMsg = _deferredMsg;
                        // 不调用 onDone（等引导确认后再处理最终回复）
                        maxIterations++;  // 不消耗迭代配额
                        continue;  // 回到循环顶部 → 触发引导确认回合
                    }
                    var _bill = self._lastBilling; self._lastBilling = null;
                    var _cd = self._lastCacheDiag; self._lastCacheDiag = null;
                    self._houses.push({ index: self._houseIndex, type: 'final', tools: [], summary: '', ts: new Date().toISOString(), ms: Date.now() - _hStart, reasoning: response.reasoning_content || '', answer: response.content || '', geCost: _bill ? _bill.geCost : 0, model: _bill ? _bill.model : '', cacheHitRate: _bill ? _bill.cacheHitRate : -1, usage: _bill ? _bill.usage : null, billingSeq: _bill ? _bill.seq : 0, billingRequestId: _bill ? _bill.requestId : '', cacheDiag: _cd || undefined });
                    if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
                    var assistantMsg = { role: 'assistant', content: response.content, _floor: self._ctx.totalFloors };
                    if (response.reasoning_content) assistantMsg.reasoning_content = response.reasoning_content;
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
                    // ★ forceNoTools 兜底：tools 已从请求中删除，若 AI 仍吐出 tool_calls → 丢弃
                    //    例外：文本工具调用回生（ID 不以 "call_" 开头）→ 最后执行一次
                    if (forceNoTools) {
                        var _hasTextTools = response.tool_calls && response.tool_calls.some(function (tc) { return tc.id && tc.id.indexOf('call_') !== 0; });
                        if (_hasTextTools) {
                            self._log('⚠ forceNoTools: allowing text-extracted tool calls as last chance (' + response.tool_calls.length + ' tool(s))');
                        } else {
                            self._log('⚠ forceNoTools: AI returned tool_calls despite no tools in request, dropping');
                            self.conversation.push({ role: 'user', content: '[System: Give your final text answer now based on what you have. Do not call any tools.]', _floor: self._ctx.totalFloors });
                            continue;
                        }
                    }
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
                    self._houses.push({ index: self._houseIndex, type: 'tools', tools: _tools, toolResults: [], summary: '', ts: new Date().toISOString(), ms: Date.now() - _hStart, reasoning: response.reasoning_content || '', geCost: _bill2 ? _bill2.geCost : 0, model: _bill2 ? _bill2.model : '', cacheHitRate: _bill2 ? _bill2.cacheHitRate : -1, usage: _bill2 ? _bill2.usage : null, billingSeq: _bill2 ? _bill2.seq : 0, billingRequestId: _bill2 ? _bill2.requestId : '', cacheDiag: _cd2 || undefined });
                    if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
                    var assistantToolMsg = {
                        role: 'assistant', content: '',
                        tool_calls: response.tool_calls,
                        _floor: self._ctx.totalFloors
                    };
                    if (response.reasoning_content) assistantToolMsg.reasoning_content = response.reasoning_content;

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
                    if (_pushedToolCount !== _expectedCount) {
                        var _orphanMsg = '⚠ ORPHAN DETECTED at source: assistant has ' + _expectedCount + ' tool_calls but only ' + _pushedToolCount + ' tool results pushed (floor ' + self._ctx.totalFloors + ', house ' + self._houseIndex + ')';
                        self._log(_orphanMsg);
                        if (typeof self._writeFileLog === 'function') self._writeFileLog(_orphanMsg);
                        // 立即自愈：砍掉刚推入的不完整组
                        self._repairOrphanedToolCalls();
                    }

                    // ═══ 阶梯停滞检测 ═══
                    var lastHouse = self._houses[self._houses.length - 1];
                    var lastResults = lastHouse && lastHouse.toolResults ? lastHouse.toolResults : [];
                    var _toolNames = (response.tool_calls || []).map(function (tc) { return tc.function.name; });
                    var _toolArgsList = (response.tool_calls || []).map(function (tc) { return tc.function.arguments; });
                    // ★ T1 连续计数：保存调用 _checkStall 前的指纹，供比较
                    var _prevT1Fp = self._lastT1Fingerprint || '';
                    var stall = self._checkStall(lastResults, _toolNames, _toolArgsList);

                    // ★ 非 T1 楼层 → 清零指纹，断连锁（中间有进展就不累积）
                    if (stall !== 'tool_loop') {
                        self._lastT1Fingerprint = '';
                    }

                    if (stall === 'tool_loop') {
                        // T1: 死循环 → 根据连续触发次数升级
                        var _fp = self._lastT1Fingerprint || '';
                        if (_fp && _fp === _prevT1Fp) {
                            // ★ 指纹与上次相同 → 检查结果是否变化
                            //   同参数不同结果 = 进展（中间有编辑）→ 不计入连续
                            var _currSummary = lastResults.map(function (r) {
                                var s = String(r || '').slice(0, 300).replace(/\s+/g, ' ');
                                return s;
                            }).join('|');
                            var _prevSummary = self._t1LastResult || '';
                            self._t1LastResult = _currSummary;
                            if (_prevSummary && _currSummary !== _prevSummary) {
                                var _minLen = Math.min(_prevSummary.length, _currSummary.length);
                                var _same = 0;
                                for (var _rj = 0; _rj < _minLen; _rj++) {
                                    if (_prevSummary.charCodeAt(_rj) === _currSummary.charCodeAt(_rj)) _same++;
                                }
                                var _sim = _minLen > 0 ? _same / _minLen : 1;
                                if (_sim < 0.7) {
                                    // 结果差异 > 30% → 有实质性进展，不计入循环
                                    self._log('⚠ T1 result-delta: sim=' + (_sim * 100).toFixed(0) + '%, treating as progress, resetting count');
                                    self._t1ConsecutiveCount = 0;
                                } else {
                                    self._t1ConsecutiveCount++;
                                }
                            } else {
                                self._t1ConsecutiveCount++;
                            }
                        } else {
                            // ★ 指纹变了 → 新一轮死循环，重置计数
                            self._t1ConsecutiveCount = 1;
                        }
                        // 第 8 次 T1 连续触发（24 个 house 同工具同参数且结果相似）→ 终止楼层
                        if (self._t1ConsecutiveCount >= 8) {
                            self._log('⛔ T1 tool-loop TERMINATION: ' + self._t1ConsecutiveCount + ' consecutive T1 triggers, terminating floor');
                            if (typeof self._writeFileLog === 'function') self._writeFileLog('⛔ T1 TERMINATION: ' + self._t1ConsecutiveCount + ' consecutive same-tool loops (panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ', floor=' + self._ctx.totalFloors + ')');
                            self.conversation.push({ role: 'user', content: '[System: ⛔ TERMINATED — You called the same tools ' + (self._t1ConsecutiveCount * 3) + ' times. You have all needed information. Discussion saved so far.]', _stallTerminated: true, _floor: self._ctx.totalFloors });
                            self._sendTerminated = true;
                            // ★ 不 return —— 让 while 自然退出，后处理会输出终止消息
                        } else if (self._t1ConsecutiveCount > 0) {
                            // ★ 结果增量已归零时（count=0）→ 不注入 loop-break，AI 有进展
                            // T1 第 1-7 次：注入循环打断消息
                            self._log('⚠ T1 tool-loop (#'
                                + self._t1ConsecutiveCount + '): injecting loop-break message');
                            if (typeof self._writeFileLog === 'function') self._writeFileLog('⚠ T1 tool-loop #' + self._t1ConsecutiveCount + ': same tool+args 3x (panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ', floor=' + self._ctx.totalFloors + ')');
                            self.conversation.push({ role: 'user', content: '[System: ⛔ You are calling the same tool with the same arguments repeatedly. This is an infinite loop. IMMEDIATELY stop calling this tool. Either try a DIFFERENT approach or give your final answer NOW.]', _stallToolLoop: true, _floor: self._ctx.totalFloors });
                        }
                    } else if (stall === 'search_stall') {
                        // T2 L1: 搜索停滞 → 温和提醒 + 路径注入
                        self._log('⚠ T2 L1: injecting read reminder with paths');
                        if (typeof self._writeFileLog === 'function') self._writeFileLog('⚠ T2 search-stagnation L1: ' + self._searchFruitlessCount + ' searches found files but never read (panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ', floor=' + self._ctx.totalFloors + ')');
                        var _foundPathsL1 = self._collectFoundFilePaths(8);
                        var _pathListL1 = _foundPathsL1.length > 0
                            ? '\n\n建议先读取这些文件：\n' + _foundPathsL1.map(function (p) { return '  • ' + p; }).join('\n')
                            : '';
                        self.conversation.push({ role: 'user', content: '[System: 你已搜索 ' + self._searchFruitlessCount + ' 次，找到了一些文件，但还没读任何文件。搜索不是目的，理解代码才是。' + _pathListL1 + '\n\n用 read_file 打开最相关的 1-2 个文件，然后你可以继续搜索。]', _stallSearch: true, _floor: self._ctx.totalFloors });
                    } else if (stall === 'search_stall_escalate') {
                        // T2 L2/L3: 更强引导（永不禁止工具，永不终止）
                        self._log('⚠ T2 L2+: injecting escalated guidance with paths');
                        if (typeof self._writeFileLog === 'function') self._writeFileLog('⚠ T2 search-stagnation L2+: ' + self._searchFruitlessCount + ' searches no reads (panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ', floor=' + self._ctx.totalFloors + ')');
                        var _foundPathsL2 = self._collectFoundFilePaths(12);
                        var _pathListL2 = _foundPathsL2.length > 0
                            ? '\n\n这是你已发现的所有文件：\n' + _foundPathsL2.map(function (p) { return '  • ' + p; }).join('\n')
                            : '';
                        self.conversation.push({ role: 'user', content: '[System: 你已经搜索 ' + self._searchFruitlessCount + ' 次，找到了很多文件，但一个也没读。现在请立即用 read_file 打开最相关的文件来理解代码。' + _pathListL2 + '\n\n搜索工具仍然可用——只是建议你先读完关键文件再搜。]', _stallSearchEscalate: true, _floor: self._ctx.totalFloors });
                    } else if (stall === 'warn') {
                        // T3: 真正空转 5 次 → 警告
                        self._log('⚠ T3 stall warn: ' + self._stallCount + ' consecutive no-progress calls');
                        if (typeof self._writeFileLog === 'function') self._writeFileLog('⚠ T3 stall warn: ' + self._stallCount + ' consecutive no-progress (panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ', floor=' + self._ctx.totalFloors + ')');
                        self.conversation.push({ role: 'user', content: '[System: You have made ' + self._stallCount + ' consecutive tool calls with no useful results. Pivot your approach or give your best answer with what you have. Do NOT repeat the same search.]', _stallWarning: true, _floor: self._ctx.totalFloors });
                    } else if (stall === 'force') {
                        // T3: 真正空转 8 次 → 最后通牒（不剥离工具）
                        self._log('⛔ T3 stall force: ' + self._stallCount + ' consecutive no-progress calls');
                        if (typeof self._writeFileLog === 'function') self._writeFileLog('⛔ T3 stall force: ' + self._stallCount + ' consecutive no-progress (panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ', floor=' + self._ctx.totalFloors + ')');
                        self.conversation.push({ role: 'user', content: '[System: ⛔ FINAL — All your recent tool calls returned nothing useful. You have tools available but use them WISELY. Pick ONLY the single most critical action you still need. After that, deliver your final answer. Do NOT search — only READ or ACT.]', _stallForce: true, _floor: self._ctx.totalFloors });
                    }
                    continue;
                }

                // 未知响应类型 → 不中断，给用户一个可读的结束
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
            // ★ T1 终止：同工具死循环被强制终止（_sendTerminated 已在 handler 中设置）
            if (self._t1ConsecutiveCount >= 5) {
                var _t1TermMsg = '⛔ 楼层因工具死循环被终止（同工具同参数重复 ' + (self._t1ConsecutiveCount * 3) + ' 次），对话已保存。你可以继续提问或重新开始。';
                self.conversation.push({ role: 'assistant', content: _t1TermMsg, _floor: self._ctx.totalFloors });
                self._floorCompletedCleanly = true;
                onDone(_t1TermMsg, self._floorTiming);
                return _t1TermMsg;
            }
            // ★ T2 L3 终止：搜索死循环被强制终止（_sendTerminated 已在 handler 中设置）
            if (self._searchFruitlessCount >= 15) {
                var _t2TermMsg = '⛔ 楼层因搜索死循环被终止（' + self._searchFruitlessCount + ' 次搜索但从未读取文件），对话已保存。你可以继续提问或重新开始。';
                self.conversation.push({ role: 'assistant', content: _t2TermMsg, _floor: self._ctx.totalFloors });
                self._floorCompletedCleanly = true;
                onDone(_t2TermMsg, self._floorTiming);
                return _t2TermMsg;
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
            if (m._stallWarning) keys.push('stallW');
            if (m._stallForce) keys.push('stallF');
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AgentLoop };
}
