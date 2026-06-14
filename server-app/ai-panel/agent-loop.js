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

// ★ UTF-8 安全截断：取字符串前 maxBytes 字节，不回退到乱码中间
//   先截取 maxBytes*2 字符再编码，避免对几千字 reasoning 全量编码
function _utf8Trunc(str, maxBytes) {
    if (!str) return '';
    var head = str.length > maxBytes * 2 ? str.slice(0, maxBytes * 2) : str;
    var bytes = new TextEncoder().encode(head);
    if (bytes.length <= maxBytes) return head;
    for (var i = maxBytes; i > maxBytes - 4; i--) {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, i)); }
        catch (_) { }
    }
    return new TextDecoder().decode(bytes.slice(0, maxBytes)); // 兜底（含替换符）
}

// ★ 计费摘要生成：换行→空格 → UTF-8 截断 → 超长加 ...
function _makeSummaryHint(text, maxBytes) {
    if (!text) return '';
    // 把换行和连续空白压缩成单个空格，确保截断不会因换行提前结束
    var flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    var truncated = _utf8Trunc(flat, maxBytes || 100);
    // 如果原文比截断后长（按 UTF-8 字节），末尾加 ...
    var origBytes = new TextEncoder().encode(flat).length;
    var truncBytes = new TextEncoder().encode(truncated).length;
    if (origBytes > truncBytes) truncated += '...';
    return truncated;
}

var AgentLoop = (function () {
    'use strict';

    // ═══ EnvelopeStripper: 流式剥离 ___qqq_env___ 信封 + <floor_summary> 回退 ═══
    // "硬约束桥" — 代码强行剥离并校验结构化信封，不靠 prompt 自觉
    function EnvelopeStripper(onToken) {
        this.onToken = onToken;
        this.raw = '';
        this.emitted = 0;
        // 主线：信封格式
        this._ENV_OPEN = '___qqq_env___';
        this._ENV_CLOSE = '___end___';
        // 回退：旧 <floor_summary> 标签（过渡期兼容）
        this._FALL_OPEN = '<floor_summary';
        this._FALL_CLOSE = '</floor_summary>';
    }
    EnvelopeStripper.prototype._firstBlockStart = function () {
        var envIdx = this.raw.indexOf(this._ENV_OPEN);
        var fallIdx = this.raw.indexOf(this._FALL_OPEN);
        if (envIdx === -1) return fallIdx;
        if (fallIdx === -1) return envIdx;
        return Math.min(envIdx, fallIdx);
    };
    EnvelopeStripper.prototype.push = function (chunk) {
        if (!chunk) return;
        this.raw += chunk;
        var blockStart = this._firstBlockStart();
        var safeUpTo;
        if (blockStart >= 0) {
            safeUpTo = blockStart;
        } else {
            // 留最后 N 字符防截断（取最长标记长度）
            var margin = Math.max(this._ENV_OPEN.length, this._FALL_OPEN.length);
            safeUpTo = Math.max(this.emitted, this.raw.length - margin);
        }
        if (safeUpTo > this.emitted) {
            var piece = this.raw.slice(this.emitted, safeUpTo);
            if (this.onToken) this.onToken(piece);
            this.emitted = safeUpTo;
        }
    };
    EnvelopeStripper.prototype.finalize = function () {
        // 发射残留安全内容
        var blockStart = this._firstBlockStart();
        if (blockStart < 0 && this.emitted < this.raw.length) {
            var piece = this.raw.slice(this.emitted);
            if (this.onToken) this.onToken(piece);
            this.emitted = this.raw.length;
        }

        // 尝试解析信封 JSON
        var envelope = null;
        var envMatch = this.raw.match(/___qqq_env___\s*\n?(\{[\s\S]*?\})\s*\n?___end___/);
        if (envMatch) {
            try {
                envelope = JSON.parse(envMatch[1]);
            } catch (_) { /* malformed JSON, fall through */ }
        }

        // 回退：解析旧 <floor_summary>
        var summary = '', lang = '';
        var fallMatch = this.raw.match(/<floor_summary([^>]*)>([\s\S]*?)(?:<\/floor_summary>|$)/);
        if (fallMatch) {
            summary = (fallMatch[2] || '').trim();
            var langMatch = fallMatch[1].match(/lang=["']([^"']+)["']/);
            if (langMatch) lang = langMatch[1];
        }

        // 信封优先：envelope.floor_summary 覆盖旧格式
        if (envelope && envelope.floor_summary) {
            summary = envelope.floor_summary;
            lang = '';  // 信封无 lang 属性
        }

        // 清理：移除信封块 + 旧 floor_summary 标签
        var cleanContent = this.raw
            // ★ 不依赖 $ 结尾：信封和 floor_summary 可能不在末尾
            .replace(/\s*___qqq_env___[\s\S]*?___end___\s*/g, '')
            .replace(/\s*<floor_summary[^>]*>[\s\S]*?(?:<\/floor_summary>|$)\s*/g, '')
            // ★ [DYNAMIC CONTEXT] 块：从该标记一直删到下一个段落分隔或文本末尾
            .replace(/\[DYNAMIC CONTEXT\][\s\S]*?(?=\n\n|$)/g, '')
            .trim();

        cleanContent = cleanContent.replace(/\x0a{3,}/g, '\x0a\x0a').replace(/^\x0a+/, '');

        // ═══ 文本工具调用回生引擎（统一入口） ═══
        // 当模型在 content 中输出工具调用（XML/Action: 格式）而非原生 delta.tool_calls，
        // 解析为可执行结构，防止楼层空转。
        var _textToolCalls = [];

        // ── 1) XML 格式：<invoke name="..."><parameter name="...">...</parameter></invoke> ──
        //    兼容 <function_call> <qqq_tool_calls> 等变体
        var _xmlBlocks = [];
        // 提取所有含 name 属性的 invoke/function_call 块（含内嵌 parameter）
        var _invokeRe = /<(?:invoke|function_call)\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:invoke|function_call)>/gi;
        var _xm;
        while ((_xm = _invokeRe.exec(cleanContent)) !== null) {
            var _xName = _xm[1];
            var _xBody = _xm[2];
            var _xArgs = {};
            // 提取 <parameter name="k">v</parameter> 或 <parameter name="k" value="v"/>
            var _paramRe = /<parameter\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*?(?:>([\s\S]*?)<\/parameter>|\bvalue\s*=\s*["']([^"']*)["'][^>]*\/>)/gi;
            var _pm;
            while ((_pm = _paramRe.exec(_xBody)) !== null) {
                var _pName = _pm[1];
                var _pVal = (_pm[2] !== undefined) ? _pm[2].trim() : (_pm[3] || '');
                // 尝试解析 JSON 值（数组/对象），失败则保留字符串
                try { _pVal = JSON.parse(_pVal); } catch (_) { }
                _xArgs[_pName] = _pVal;
            }
            _xmlBlocks.push({ full: _xm[0], name: _xName, args: _xArgs });
        }
        // 提取自闭合 <invoke name="..." ... /> （无 body，参数全在属性上）
        var _selfCloseRe = /<(?:invoke|function_call)\s[^>]*?\bname\s*=\s*["']([^"']+)["']([^>]*?)\/>/gi;
        var _scm;
        while ((_scm = _selfCloseRe.exec(cleanContent)) !== null) {
            var _scName = _scm[1];
            var _scAttrs = _scm[2];
            var _scArgs = {};
            // 从属性中提取 key="value" 对（排除 name 本身）
            var _attrRe = /\b(?!name\b)(\w[\w-]*)\s*=\s*["']([^"']*)["']/gi;
            var _am;
            while ((_am = _attrRe.exec(_scAttrs)) !== null) {
                var _aVal = _am[2];
                try { _aVal = JSON.parse(_aVal); } catch (_) { }
                _scArgs[_am[1]] = _aVal;
            }
            _xmlBlocks.push({ full: _scm[0], name: _scName, args: _scArgs });
        }
        // 解析后的 XML 块转为 textToolCalls + 从 content 剥离
        for (var _xbi = 0; _xbi < _xmlBlocks.length; _xbi++) {
            var _xb = _xmlBlocks[_xbi];
            var _callId = 'xml_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            _textToolCalls.push({
                id: _callId,
                type: 'function',
                function: {
                    name: _xb.name,
                    arguments: JSON.stringify(_xb.args)
                }
            });
            // 剥离已解析的 XML 块（精确替换）
            cleanContent = cleanContent.replace(_xb.full, '');
        }
        // 残留 XML 标签清除（<qqq_tool_calls> <tool_call> 等无参数包裹标签）
        cleanContent = cleanContent.replace(/<\/?qqq_tool_calls>/gi, '');
        cleanContent = cleanContent.replace(/<\/?_?tool_calls?[^>]*>/gi, '');
        cleanContent = cleanContent.replace(/<\/?_?tool_call[^>]*>/gi, '');
        cleanContent = cleanContent.replace(/<\/?function_call[^>]*>/gi, '');
        cleanContent = cleanContent.replace(/<parameter[\s>][^>]*>[\s\S]*?<\/parameter>/gi, '');
        cleanContent = cleanContent.replace(/<parameter[\s>][^>]*\/>/gi, '');

        // ── 2) DeepSeek ReAct 格式：Action: tool_name\nAction Input: {...} ──
        if (/^Action:\s*\w+/m.test(cleanContent)) {
            var _actionPat = /^Action:\s*(\w[\w.-]*).*(?:\nAction Input:\s*(\{[\s\S]*?\}))?/gm;
            var _m;
            while ((_m = _actionPat.exec(cleanContent)) !== null) {
                var _name = _m[1];
                var _argsStr = _m[2] || '{}';
                var _argsParsed;
                try { _argsParsed = JSON.parse(_argsStr); } catch (_) { _argsParsed = {}; }
                var _callId2 = 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                _textToolCalls.push({
                    id: _callId2,
                    type: 'function',
                    function: {
                        name: _name,
                        arguments: JSON.stringify(_argsParsed)
                    }
                });
            }
            cleanContent = cleanContent.replace(/^Action:\s*\w[\w.-]*.*(?:\nAction Input:\s*\{[\s\S]*?\})?/gm, '');
            cleanContent = cleanContent.replace(/^Action Input:\s*\{[\s\S]*?\}/gm, '');
        }

        // 统一收尾：去除清理产生的连续空行
        cleanContent = cleanContent.replace(/\x0a{3,}/g, '\x0a\x0a').replace(/^\x0a+/, '').trim();

        return { cleanContent: cleanContent, envelope: envelope, summary: summary, lang: lang, textToolCalls: _textToolCalls };
    };

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
        this._writeFileLog = function (msg) {
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
        this._ctx = { narrative: '', facts: [], totalFloors: 0 };

        // 计费
        this._floorCostWge = 0;
        this.totalCostGe = 0;
        this._lastCostDisplay = '0';
        this._lastApiPromptTokens = 0;  // 初始化清零，避免残留旧 quest 数值
        this._lastApiTotalTokens = 0;    // API 返回的 total_tokens（prompt+completion 精确值）
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
        // ★ 楼层看门狗：防断头中断
        this._floorKilled = false;
        this._floorCompletedCleanly = false;
        this._floorOnErrorCalled = false;
        this._sendTerminated = false;  // ★ onError 后强制终止 send() while 循环
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
        // ★ 上下文快照：诊断 DeepSeek 缓存命中/未命中根因
        this._lastSentSnapshot = null;   // { msgCount, prefixHash, firstMsgKeys, lastMsgKeys }
        this._lastCacheDiag = null;      // { prevHash, currHash, firstDiffIdx, diffReason, prevMsgKeys, currMsgKeys }
    }

    // ---- 中止 ----
    // userKill: true = 用户点停止按钮；false/不传 = 内部中断（guide/inject 等）
    AgentLoop.prototype.abort = function (userKill) {
        if (userKill) {
            this._floorKilled = true;  // ★ 看门狗：用户主动杀，不触发自动恢复
        }
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
                parts.push('网络请求失败: ' + _fe);
                break;
            case 'watchdog_stream': parts.push('SSE流90秒无数据(连接假死)'); break;
            case 'watchdog_output': parts.push('AI超过10分钟无产出(可能陷入循环)'); break;
            case 'deadline': parts.push('请求90秒无响应(超时)'); break;
            case 'stall': parts.push('连续多次工具调用无进展'); break;
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
            parts.push('上下文过大(' + Math.round(_ctxTokens / 1000) + ' k tokens, 接近上限)');
        }
        return parts.join('; ') || '未知原因';
    };

    // ═══ 修复断裂的 tool_calls（启动自愈，双向扫描） ═══
    // DeepSeek API 硬要求：tool 消息前必须有 assistant tool_calls，tool_calls 后必须有足够 tool
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

    // ═══ 无进展计数器（硬约束：防止 AI 反复无意义搜索） ═══
    AgentLoop.prototype._resetStallCounter = function () {
        this._stallCount = 0;
        this._stallWarned = false;
    };
    AgentLoop.prototype._checkStall = function (toolResults) {
        var self = this;
        if (!toolResults || toolResults.length === 0) return false;
        // 判断是否全部无进展：search_text 返回 No matches / find_files 空 / list_files 空 / 错误
        var allNoProgress = toolResults.every(function (r) {
            var s = typeof r === 'string' ? r : '';
            return s.startsWith('No matches found') || s.startsWith('Error') || s === '' || s.startsWith('Tool error') || s.startsWith('[ALREADY READ]');
        });
        if (allNoProgress) {
            self._stallCount++;
        } else {
            self._stallCount = 0;
            self._stallWarned = false;
        }
        // ★ 工具循环检测：连续 3 个 house 调同一批工具（同 name + 同 args）且零文本产出 → 死循环
        //    覆盖 read_file / search_text / find_files / list_files / fetch_webpage 等一切工具
        if (!allNoProgress && self._houses.length >= 3) {
            var _last3 = self._houses.slice(-3);
            var _allTools = _last3.every(function (h) { return h.type === 'tools'; });
            if (_allTools) {
                var _toolFingerprints = _last3.map(function (h) {
                    var _fp = [];
                    for (var _ti = 0; _ti < h.tools.length; _ti++) {
                        var _t = h.tools[_ti];
                        // 指纹 = 工具名 + 关键参数（path 归一化 \→/ 小写 + 行范围，防 AI 换格式/分块逃逸）
                        var _argsKey = '';
                        if (_t.args) {
                            _argsKey = (_t.args.path || _t.args.regex || _t.args.keyword || _t.args.command || _t.args.url || _t.args.pattern || _t.args.query || '');
                            if (_t.args.path) {
                                _argsKey = _argsKey.replace(/\\/g, '/').toLowerCase();
                                // 行范围也纳入指纹：读不同行 ≠ 重复
                                if (_t.args.start_line != null) _argsKey += '|s' + _t.args.start_line;
                                if (_t.args.end_line != null) _argsKey += '|e' + _t.args.end_line;
                            }
                        }
                        _fp.push(_t.name + '\x00' + _argsKey);
                    }
                    return _fp.sort().join('\x01');
                });
                if (_toolFingerprints[0] && _toolFingerprints[0] === _toolFingerprints[1] && _toolFingerprints[0] === _toolFingerprints[2]) {
                    self._log('🔁 tool-loop detected: same tool+args 3 times without output, forcing final answer');
                    self._stallCount = 8;  // 直接跳到 force 级
                    return 'force';
                }
            }
        }
        // 5 次无进展 → 警告注入
        if (self._stallCount >= 5 && !self._stallWarned) {
            self._stallWarned = true;
            return 'warn';
        }
        // 8 次无进展 → 强制终止
        if (self._stallCount >= 8) {
            return 'force';
        }
        return false;
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

        // ★ 存储 token 供 tools.js 调用 Go 端点时使用
        self._token = token;

        // 重置本轮计费 + 生成 floor_id（同一轮内所有 gateway 调用共享）
        self._floorCostWge = 0;
        self._floorFree = false;
        self._floorId = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ((typeof _panelId !== 'undefined') ? ['_L', '_C', '_R'][_panelId] || '' : '');
        self._currentFloorSummary = (userContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        self._floorTiming = { networkMs: 0, deepseekMs: 0, floorStartPerf: performance.now(), floorStartServerMs: Date.now() + (self._serverDrift || 0) };
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
        if (_visionStart) self._floorTiming.deepseekMs += performance.now() - _visionStart;

        // 推入用户消息（纯文本）
        var finalContent = (userContent || '') + visionText;

        // 归档：保存用户键入供 generateFloorTxt 写入
        self._lastUserInput = { text: userContent || '', vision: visionText || '' };

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
        self._log('◆ ' + tier.label);
        var maxIterations = 200;
        var conversationSnapshot = self.conversation.length;
        self._houses = [];
        self._a4Snapshots = {};
        self._houseIndex = 0;
        self._floorKilled = false;  // ★ 看门狗：用户点停止才置 true
        self._floorCompletedCleanly = false;  // ★ 看门狗：只有 onDone 路径才置 true
        self._floorOnErrorCalled = false;  // ★ 看门狗：onError 回调已处理，不重复恢复
        self._sendTerminated = false;  // ★ 终止旗：onError 后强制退出 while
        self._resetStallCounter();
        if (typeof window !== 'undefined') window._qqqReadFilesThisFloor = {};  // ★ 读文件去重计数器：每层楼复位

        try {
            while (maxIterations-- > 0 && !self._sendTerminated) {
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
                            .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
                            .replace(/\n{3,}/g, '\n\n')
                            .trim();
                        if (!_cleanAck || _cleanAck.length < 3) _cleanAck = '已收到引导';
                        self.conversation.push({ role: 'assistant', content: _cleanAck, _guideAck: true, _guideText: _guideText, _floor: self._ctx.totalFloors });
                        // 归档
                        self._houses.push({ index: 'G' + (self._houseIndex || 0), type: 'guide_ack', tools: [], summary: '', ms: Date.now() - _ackStart, reasoning: _ackResp.reasoning_content || '', answer: _ackResp.content, ts: new Date().toISOString() });
                        // ★ 更新绿条标记：两行格式，✅ 已收到引导 / 确认内容
                        var _aiDiv2 = self._activeAiDiv;
                        if (_aiDiv2 && _aiDiv2._guideMarker) {
                            _aiDiv2._guideMarker.style.cssText = '';
                            var _ackDisplay = _cleanAck.slice(0, 200);
                            var _esc = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
                            _aiDiv2._guideMarker.className = 'msg-flow-guide-ack';
                            _aiDiv2._guideMarker.innerHTML = '<div class="msg-flow-guide-ack-hdr"><span class="msg-flow-icon">✅</span> 已收到引导</div><div class="msg-flow-guide-ack-body">' + _esc(_ackDisplay) + '</div>';
                            _aiDiv2._guideMarker = null;
                        }
                        if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
                        self._log('✅ guide ack: ' + _ackResp.content.slice(0, 120));
                    } else if (_ackResp && _ackResp.type === 'tool_calls') {
                        // 引导回合 AI 返回工具调用（noTools=true 下不应发生）
                        self.conversation.pop();
                        self._log('⚠ guide ack: AI returned tool_calls despite noTools, cleared');
                        // ★ 清除绿条标记
                        var _aiDiv3 = self._activeAiDiv;
                        if (_aiDiv3 && _aiDiv3._guideMarker) {
                            _aiDiv3._guideMarker.style.cssText = '';
                            _aiDiv3._guideMarker.innerHTML = '';
                            _aiDiv3._guideMarker = null;
                        }
                    } else {
                        // 网络错误或其他异常 → 移除 prompt，清除标记，不阻塞
                        self.conversation.pop();
                        self._log('⚠ guide ack: no valid response, skipped');
                        var _aiDiv4 = self._activeAiDiv;
                        if (_aiDiv4 && _aiDiv4._guideMarker) {
                            _aiDiv4._guideMarker.style.cssText = '';
                            _aiDiv4._guideMarker.innerHTML = '';
                            _aiDiv4._guideMarker = null;
                        }
                    }
                    // 确认回合结束 → 继续正常 while 循环
                    onGuideAckDone();
                    continue;
                }

                // ═══ 压缩守护：每间 house 前检查，超阈值则阻塞压缩 ═══
                if (!self._compressing) {
                    var _checkTokens = self._lastApiTotalTokens || self._lastApiPromptTokens || 0;
                    var _threshold = (typeof ContentGateway !== 'undefined') ? ContentGateway.COMPRESS_THRESHOLD : 900000;
                    if (_checkTokens > _threshold) {
                        self._compressing = true;
                        try {
                            var _reason = '自动压缩（' + Math.round(_checkTokens/1000) + 'k / ' + Math.round(_threshold/1000) + 'k，超 90% 阈值）';
                            self._renderCompressStart(_reason);
                            var _result = await self._compressContext({ trigger: 'auto', detail: _reason });
                            self._renderCompressResult(_result);
                        } finally {
                            self._compressing = false;
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
                    noTools: forceNoTools
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
                    var _errMsg = self._lastGatewayMessage || '⚠️ 响应异常，对话已保存。';
                    self._lastGatewayMessage = '';
                    if (!self._floorOnErrorCalled && !self._floorKilled) {
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
                    self._floorTiming.deepseekMs += response._streamMs;
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
                        // 不 push 到 conversation（引导确认回合会 pop 掉多余消息）
                        // 不调用 onDone（等引导确认后再重新获取最终回复）
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
                    var _tools = response.tool_calls.map(function (tc) { return { name: tc.function.name, args: tc.function.arguments }; });
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
                                _rawContent: r2.rawContent,
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

                    // ═══ 无进展检测 ═══
                    var lastHouse = self._houses[self._houses.length - 1];
                    var lastResults = lastHouse && lastHouse.toolResults ? lastHouse.toolResults : [];
                    var stall = self._checkStall(lastResults);
                    if (stall === 'warn') {
                        self._log('⚠ stall detected: ' + self._stallCount + ' consecutive no-progress calls, injecting warning');
                        self.conversation.push({ role: 'user', content: '[System: You have made ' + self._stallCount + ' consecutive tool calls with no useful results. Pivot your approach or give your best answer with what you have. Do NOT repeat the same search.]', _stallWarning: true, _floor: self._ctx.totalFloors });
                    } else if (stall === 'force') {
                        self._log('⛔ stall force: ' + self._stallCount + ' consecutive no-progress calls, forcing final answer');
                        self.conversation.push({ role: 'user', content: '[System: You have made ' + self._stallCount + ' consecutive tool calls with no useful results. Stop using tools now and give your final answer based on what you have gathered so far. Be concise.]', _stallForce: true, _floor: self._ctx.totalFloors });
                        // 强制 noTools 下一轮
                        forceNoTools = true;
                    }
                    continue;
                }

                // 未知响应类型 → 不中断，给用户一个可读的结束
                self._log('⚠ unexpected response type: ' + (response && response.type));
                var _fallbackMsg = '⚠ AI 返回了意外的响应类型，但对话上下文已保留。你可以继续提问或重试。';
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
                        self._floorTiming.deepseekMs += finalResp._streamMs;
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
            if (!self._floorOnErrorCalled && !self._floorKilled) {
                onError(self._lastGatewayMessage);
            }
            self._sendTerminated = true;
            return null;
        } catch (err) {
            self._log('✗ agent error: ' + (err.message || err));
            onError(err.message || String(err));
            return null;
        }
    };

    // ═══ 视觉预分析：图像 → 文本 ═══
    // 并行分析所有图片，MD5 缓存
    // 返回 [{id, description, cached}] — 失败图片静默跳过
    AgentLoop.prototype._analyzeImages = async function (images, token, userContent) {
        var self = this;
        var results = [];

        // 构造视觉 prompt：把用户问题原文带上，让阿里做针对性识别
        var visionPrompt = '';
        if (userContent && typeof userContent === 'string' && userContent.trim()) {
            visionPrompt = 'The user is asking the following question about this image. ' +
                'Focus your analysis specifically on what the user is asking about. ' +
                'Ignore unrelated text/details — only describe what matters for answering the question.\n\n' +
                'USER QUESTION:\n' + userContent.trim() + '\n\n' +
                'Now describe this image with respect to the question above:';
        }

        var analyzeOne = async function (img) {
            var hash = self._simpleHash(img.base64 + '|' + (visionPrompt || ''));
            var cached = self._visionCache.get(hash);
            if (cached) {
                self._log('  ✓ vision #' + img.id + ' cached (' + hash.slice(0, 8) + ')');
                return { id: img.id, description: cached.description, cached: true };
            }
            try {
                var desc = await self._callVision(img.base64, token, visionPrompt, userContent);
                if (desc) {
                    self._visionCache.set(hash, { description: desc, ts: Date.now() });
                }
                return { id: img.id, description: desc, cached: false };
            } catch (err) {
                self._log('  ✗ vision #' + img.id + ' failed: ' + (err.message || err));
                return { id: img.id, description: null, cached: false };
            }
        };

        // ★ 并行分析：所有图片独立调 Go vision 端点，无依赖关系
        var allResults = await Promise.all(images.map(function (img) { return analyzeOne(img); }));
        for (var i = 0; i < allResults.length; i++) {
            var r = allResults[i];
            if (r.description) {
                results.push({ id: r.id, description: r.description, cached: r.cached });
            } else {
                self._log('  ⚠ vision #' + r.id + ' skipped (no description)');
            }
        }
        return results;
    };

    // ---- 调用 /api/v3/ai/vision（异步：提交 → SSE 推送，绕开 CF 100s 代理超时）----
    AgentLoop.prototype._callVision = async function (base64, token, prompt, userContent) {
        var self = this;
        var MAX_SUBMIT_RETRIES = 2;

        // ═══ Step 1: 提交任务（带重试） ═══
        var taskId = null;
        for (var retry = 0; retry <= MAX_SUBMIT_RETRIES; retry++) {
            try {
                var reqBody = { image: base64 };
                if (prompt && typeof prompt === 'string' && prompt.trim()) {
                    reqBody.prompt = prompt.trim();
                }
                // billing 摘要：传用户原始问题（不含视觉提示词前缀），Go 存为流水摘要
                if (userContent && typeof userContent === 'string' && userContent.trim()) {
                    reqBody.summary = userContent.trim().slice(0, 200);
                }
                if (self._floorId) {
                    reqBody.floor_id = self._floorId;
                }
                var resp = await fetch(VISION_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify(reqBody),
                    signal: self.abortController ? self.abortController.signal : undefined
                });

                if (resp.ok) {
                    var data = await resp.json();
                    // Redis 缓存命中 → 直接返回，跳过 SSE
                    if (data.status === 'done') {
                        if (data.ge_cost) { self._visionCostWge += data.ge_cost; }
                        self._log('  ✓ vision done (cached)');
                        return data.description || '[Vision returned empty description]';
                    }
                    if (data.task_id) {
                        taskId = data.task_id;
                        self._log('  vision task: ' + taskId.slice(0, 12) + '...');
                        break;
                    }
                    self._log('  vision: no task_id in response');
                    return null;
                }

                // 可重试的状态码
                if ((resp.status === 429 || resp.status === 502 || resp.status === 503) && retry < MAX_SUBMIT_RETRIES) {
                    var waitMs = resp.status === 429 ? 3000 : 2000 * Math.pow(2, retry);
                    self._log('  vision submit retry #' + (retry + 1) + ' in ' + waitMs + 'ms (HTTP ' + resp.status + ')');
                    await new Promise(function (r) { setTimeout(r, waitMs); });
                    continue;
                }

                if (resp.status === 413) { self._log('  vision skipped: image too large'); return null; }
                // 429 重试耗尽 → qoast 弹窗
                if (resp.status === 429) { try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('视觉分析请求过于频繁，已跳过部分图片', { type: 'warning' }); } catch (_) { } }
                self._log('  vision submit HTTP ' + resp.status + ': ' + (await resp.text().catch(function () { return ''; })).slice(0, 100));
                return null;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                if (retry < MAX_SUBMIT_RETRIES) {
                    var waitMs2 = 2000 * Math.pow(2, retry);
                    self._log('  vision submit retry #' + (retry + 1) + ' in ' + waitMs2 + 'ms (' + (err.message || err) + ')');
                    await new Promise(function (r) { setTimeout(r, waitMs2); });
                    continue;
                }
                self._log('  vision submit failed: ' + (err.message || err));
                return null;
            }
        }

        if (!taskId) return null;

        // Step 2: SSE push (retry once on 404)
        var streamUrl = VISION_URL + '/' + taskId + '/stream';
        var MAX_STREAM_RETRIES = 1;
        for (var streamRetry = 0; streamRetry <= MAX_STREAM_RETRIES; streamRetry++) {
            try {
                var streamResp = await fetch(streamUrl, {
                    headers: { 'Authorization': 'Bearer ' + token },
                    signal: self.abortController ? self.abortController.signal : undefined
                });
                if (!streamResp.ok) {
                    if (streamResp.status === 404) {
                        if (streamRetry < MAX_STREAM_RETRIES) {
                            self._log('  vision stream 404, retry in 1s...');
                            await new Promise(function (r) { setTimeout(r, 1000); });
                            continue;
                        }
                        self._log('  vision task expired'); return null;
                    }
                    self._log('  vision stream HTTP ' + streamResp.status);
                    return null;
                }

                var reader = streamResp.body.getReader();
                var decoder = new TextDecoder();
                var textBuf = '';
                var sseStart = Date.now();
                var MAX_SSE_WAIT = 120000;

                while (Date.now() - sseStart < MAX_SSE_WAIT) {
                    var chunk = await reader.read();
                    if (chunk.done) break;
                    textBuf += decoder.decode(chunk.value, { stream: true });

                    // 解析 SSE lines
                    var lines = textBuf.split('\n');
                    textBuf = lines.pop();
                    var eventData = '';
                    for (var li = 0; li < lines.length; li++) {
                        var line = lines[li];
                        if (line.startsWith('data: ')) {
                            eventData = line.slice(6);
                        } else if (line === '' && eventData) {
                            try {
                                var evt = JSON.parse(eventData);
                                if (evt.status === 'done') {
                                    if (evt.ge_cost) { self._visionCostWge += evt.ge_cost; }
                                    var elapsedSse = ((Date.now() - sseStart) / 1000).toFixed(1);
                                    self._log('  ✓ vision done (SSE) in ' + elapsedSse + 's');
                                    reader.cancel();
                                    return evt.description || '[Vision returned empty description]';
                                }
                                if (evt.status === 'error') {
                                    self._log('  ✗ vision error: ' + (evt.error || 'unknown'));
                                    reader.cancel();
                                    return null;
                                }
                            } catch (_) { }
                            eventData = '';
                        }
                    }
                }
                reader.cancel();
                self._log('  ✗ vision SSE timeout');
                return null;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                if (streamRetry < MAX_STREAM_RETRIES) {
                    self._log('  vision SSE error, retry in 1s: ' + (err.message || err));
                    await new Promise(function (r) { setTimeout(r, 1000); });
                    continue;
                }
                self._log('  ✗ vision SSE error: ' + (err.message || err));
                return null;
            }
        } // stream retry loop
    };

    // ---- 简易 hash（视觉缓存 key，64bit 防碰撞）----
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
        var _keyRotated = false;
        var _triedTokens = {};  // 本轮已尝试过的 token（避免死循环）
        if (_currentToken) _triedTokens[_currentToken] = true;

        function _rotateKey() {
            // 标记当前 key 被限流
            if (typeof markToken429 === 'function' && _currentToken) {
                markToken429(_currentToken);
            }
            // 获取下一个可用 key
            if (typeof getTokenInfo === 'function') {
                var info = getTokenInfo();
                if (info.key && info.key !== _currentToken && !_triedTokens[info.key]) {
                    _currentToken = info.key;
                    _triedTokens[_currentToken] = true;
                    _keyRotated = true;
                    if (info.cooldown) {
                        self._log('  ⚡ key rotated (cooldown ' + info.cooldown + 's remaining)');
                    } else {
                        self._log('  ⚡ key rotated to next in pool');
                    }
                    return true;
                }
            }
            return false;
        }

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
        var apiMessages = messages;
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
        var dynamicCtx = (typeof self._buildDynamicContext === 'function') ? self._buildDynamicContext(lastUserQuery) : '';
        if (dynamicCtx) {
            apiMessages = messages.slice();
            // ★ 压缩历史作为独立 system 消息插在 persistent 消息之后、真实对话之前
            var insertIdx = self._persistentCount || 0;
            apiMessages.splice(insertIdx, 0, { role: 'system', content: dynamicCtx, _dynamic: true });
        }

        // 语言检测已移至 a1 审计按钮（后翻译方案），此处不再强制注入语言指令
        // ★ 计费摘要（本轮详情）：house 1 = 用户提问，后续 = 前一间 reasoning
        //   换行转空格 + UTF-8 截断 + 末尾 ...，永不截到 room 级工具调用
        var summaryHint = '';
        if (self._houseIndex === 1) {
            summaryHint = _makeSummaryHint(lastUserQuery);
        } else {
            var _lh = self._houses[self._houses.length - 1];
            if (_lh && _lh.reasoning) {
                summaryHint = _makeSummaryHint(_lh.reasoning);
            } else if (_lh && _lh.type === 'guide_ack') {
                summaryHint = '引导确认';
            }
        }
        // ★ 压缩守护（代替旧动态帽）：while 循环中每间 house 前检查，超 900k 则阻塞压缩
        //   此处不再缩 max_tokens — 由压缩保证 prompt 不超限
        var _reqMaxTokens = tier.maxTokens || ContentGateway.MAX_RESPONSE_TOKENS;
        var _effectiveMaxTokens = _reqMaxTokens;
        var body = {
            model: tier.model || 'pro',
            messages: apiMessages,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: _effectiveMaxTokens,
            floor_id: self._floorId,
            summary_hint: summaryHint
        };

        // ★ 始终发送工具定义：即使 noTools 为 true，也要传 tools 防止 DeepSeek 退化为文本格式
        if (typeof getTools === 'function') {
            var _tools = getTools();
            if (_tools && _tools.length) {
                body.tools = _tools;
                if (noTools) {
                    body.tool_choice = 'none';  // DeepSeek 支持 tool_choice，禁用工具调用但保留格式
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
            _resetFetchDeadline();  // ★ 每次 retry 重置 deadline
            // ★ 强制重建 AbortController：防止已 abort 的 signal 导致后续 fetch 瞬死
            if (self.abortController) {
                try { self.abortController.abort(); } catch (_) { }
            }
            self.abortController = new AbortController();
            self._abortSource = '';  // ★ 重置探针
            try {
                var _fetchStart = performance.now();
                var resp = await fetch(GATEWAY_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + _currentToken,
                        'X-Floor-Id': self._floorId || ''
                    },
                    body: JSON.stringify(body),
                    signal: self.abortController.signal
                });

                var _ttfbMs = performance.now() - _fetchStart;
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
                                continue;
                            }
                            // 后半段重试 → 跳过 retry，落入下方线路切换
                        } else {
                            var waitMsGw = 3000 * Math.pow(2, retry);
                            self._log('  gateway ' + resp.status + ' retry #' + (retry + 1) + ' in ' + waitMsGw + 'ms');
                            await new Promise(function (r) { setTimeout(r, waitMsGw); });
                            continue;
                        }
                    }
                    self._log('✗ gateway ' + resp.status + ': ' + text.slice(0, 200));
                    var friendly = resp.status === 401 ? '认证失败，请检查 Token'
                        : resp.status === 402 ? 'ge 余额不足，请充值'
                            : resp.status === 429 ? '请求过于频繁，请稍后再试'
                                : resp.status === 502 ? '服务器暂时不可达 (502)'
                                    : resp.status === 503 ? '服务器暂时不可达 (503)'
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
                        self._lastGatewayMessage = friendly + '，所有线路均不可达';
                        // ★ 通知兄弟面板：当前线路已死
                        if (typeof _gwBroadcastDeadFallback === 'function' && GATEWAY_URL === GATEWAY_URL_FALLBACK) {
                            _gwBroadcastDeadFallback();
                        }
                        // ★ 不在此处 onError / _sendTerminated — 让 agent loop 的 auto-repair 先尝试修复
                        return null;
                    }
                    // ★ 其他 HTTP 错误（401/402/429等）— 终端错误，直接报错
                    self._lastHttpStatus = resp.status;
                    self._exitReason = 'http_' + resp.status;
                    clearTimeout(_fetchDeadline);
                    self._sendTerminated = true;  // ★ 标记终止
                    self._lastGatewayMessage = friendly;
                    onError(friendly);
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
                    // ★ 非引导中断 = 看门狗/超时/网络问题
                    // 设置探针：区分 abort 来源
                    if (self._abortSource === 'stream_watchdog') self._exitReason = 'watchdog_stream';
                    else if (self._abortSource === 'output_watchdog') self._exitReason = 'watchdog_output';
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
                    self._abortRetries = (self._abortRetries || 0) + 1;
                    if (self._abortRetries <= 3) {
                        var _abortWait = 2000 * Math.pow(2, self._abortRetries - 1);  // 2s, 4s, 8s
                        var _retryMsg = '  ⏳ abort retry #' + self._abortRetries + '/3 in ' + (_abortWait / 1000) + 's (same URL: ' + GATEWAY_URL.replace('https://', '').split('/')[0] + ')';
                        self._log(_retryMsg);
                        if (typeof self._writeFileLog === 'function') self._writeFileLog(_retryMsg);
                        await new Promise(function (r) { setTimeout(r, _abortWait); });
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
                        continue;
                    }
                    // ★ 所有恢复手段耗尽 → 记录最终失败
                    var _finalMsg = '✗ TIMEOUT EXHAUSTED: all ' + MAX_LINE_SWITCHES + ' line switches + 3 abort retries per URL exhausted. Final URL=' + GATEWAY_URL.replace('https://', '').split('/')[0] + ' panel=' + (typeof _panelId !== 'undefined' ? _panelId : '?') + ' floor=' + self._ctx.totalFloors;
                    self._log(_finalMsg);
                    if (typeof self._writeFileLog === 'function') self._writeFileLog(_finalMsg);
                    self._lastGatewayMessage = '⚠️ 连接超时，对话已保存。';
                    return null;
                }
                var msg = err.message || '';

                // ★ AI 上游错误（400/422）：请求体有问题，重试/切线路均无效 → 直接返回 null 让 auto-repair 修复
                if (self._lastGatewayError === 400 || self._lastGatewayError === 422) {
                    self._log('  AI upstream ' + self._lastGatewayError + ' — skipping retries, letting auto-repair handle');
                    clearTimeout(_fetchDeadline);
                    self._exitReason = 'http_' + self._lastGatewayError;
                    self._lastGatewayMessage = '⚠️ AI 上游返回 ' + self._lastGatewayError + '，正在自动修复...';
                    return null;
                }

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
                        continue;
                    }
                }

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
                self._lastGatewayMessage = '⚠️ 网络请求失败。对话已完整保留，请稍后重新发送。';
                // ★ 通知兄弟面板：当前线路已死
                if (typeof _gwBroadcastDeadFallback === 'function' && GATEWAY_URL === GATEWAY_URL_FALLBACK) {
                    _gwBroadcastDeadFallback();
                }
                // ★ 不在此处 onError / _sendTerminated — 让 agent loop 统一处理
                return null;
            }
        } // retry loop
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

        // ★ 流级别看门狗：120s 无数据 → 连接已死，主动 abort
        //   DeepSeek 深度推理可能 90s+ 无 token，120s 防误杀
        // ★ 产出看门狗：10min 无实质产出（无 delta/tool_call）→ AI 陷入思考循环，主动 abort
        var _streamWatchdog = null;
        var _outputWatchdog = null;
        // 产出看门狗 → 唯一真理在 ContentGateway.AI_OUTPUT_WATCHDOG_MS（content-gateway.js）
        var OUTPUT_WATCHDOG_MS = (typeof ContentGateway !== 'undefined' && ContentGateway.AI_OUTPUT_WATCHDOG_MS) ? ContentGateway.AI_OUTPUT_WATCHDOG_MS : 900000;
        var STREAM_WATCHDOG_MS = (typeof ContentGateway !== 'undefined' ? ContentGateway.STREAM_WATCHDOG_MS : 180000);  // ★ 唯一真理在 ContentGateway
        function _resetStreamWatchdog() {
            if (_streamWatchdog) clearTimeout(_streamWatchdog);
            _streamWatchdog = setTimeout(function () {
                self._abortSource = 'stream_watchdog';
                self._log('⏰ stream watchdog ' + (STREAM_WATCHDOG_MS / 1000) + 's — no data, aborting dead connection');
                if (self.abortController) self.abortController.abort();
            }, STREAM_WATCHDOG_MS);
        }
        function _resetOutputWatchdog() {
            if (_outputWatchdog) clearTimeout(_outputWatchdog);
            _outputWatchdog = setTimeout(function () {
                self._abortSource = 'output_watchdog';
                self._log('⏰ output watchdog ' + (OUTPUT_WATCHDOG_MS / 60000) + 'min — no output, aborting thinking loop');
                if (self.abortController) self.abortController.abort();
            }, OUTPUT_WATCHDOG_MS);
        }
        _resetStreamWatchdog();
        _resetOutputWatchdog();

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
                    clearTimeout(_outputWatchdog);
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
                    _resetOutputWatchdog();  // ★ 有实质文本产出 → 重置产出看门狗
                }
                if (delta.tool_calls) {
                    _resetOutputWatchdog();  // ★ 有工具调用 → 重置产出看门狗
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
            self._log('✗ SSE error event: ' + _errMsg);
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


        var _streamMs = performance.now() - streamStart;
        if (toolCalls.length > 0) {
            return { type: 'tool_calls', tool_calls: toolCalls.filter(Boolean), reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage };
        }
        // ★ 文本工具调用回生：模型在 content 中输出 Action: 格式而非原生 delta.tool_calls
        //    解析后回送给 agent-loop 正常执行，防止楼层空转（5秒中断无限循环）
        if (finalized.textToolCalls && finalized.textToolCalls.length > 0) {
            self._log('🔄 textToolCalls: parsed ' + finalized.textToolCalls.length + ' tool(s) from content → executing');
            return { type: 'tool_calls', tool_calls: finalized.textToolCalls, reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage };
        }
        if (finalized.cleanContent) {
            // 检测 max_tokens 截断
            var content = finalized.cleanContent;
            if (_finishReason === 'length' && content.length > 100) {
                var lastChar = content[content.length - 1];
                var abruptEnd = !/[。！？.!?\n)\]]/.test(lastChar);
                if (abruptEnd) {
                    content += '\n\n⚠️ 回复因 token 上限被截断。可回复"继续"获取完整内容。';
                }
            }
            return { type: 'message', content: content, reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage, _finishReason: _finishReason };
        }
        return _usage ? { _usage: _usage } : null;
    };

    // ---- timing getters (for UI clock + pie) ----
    AgentLoop.prototype.getFloorTiming = function () {
        return this._floorTiming;
    };
    AgentLoop.prototype.getServerDrift = function () {
        return this._serverDrift;
    };

    // ---- 并行工具执行 ----
    // 返回 { allResults, assistantMsg }，由调用方原子推入 conversation
    // 避免 auto-save 在 tool_calls 与 tool 结果之间捕获断裂状态（校验：tool_calls 后必须紧跟 tool 消息）
    AgentLoop.prototype._executeToolCallsParallel = async function (toolCalls, assistantMsg, onToolResult) {
        var self = this;
        var prepared = [];

        for (var i = 0; i < toolCalls.length; i++) {
            var call = toolCalls[i];
            var toolArgs;
            try { toolArgs = JSON.parse(call.function.arguments); } catch (_) { toolArgs = {}; }
            prepared.push({ call: call, name: call.function.name, args: toolArgs, _toolIndex: i + 1 });
        }

        if (prepared.length === 0) return { allResults: [], assistantMsg: assistantMsg };

        // 分层执行：同文件 READ 可并行，WRITE/EFFECT 串行
        var layers = self._buildExecutionLayers(prepared);
        self._log('  ║ parallel engine: ' + prepared.length + ' tools → ' + layers.length + ' layer(s)');

        var allResults = [];
        for (var li = 0; li < layers.length; li++) {
            var layer = layers[li];
            var promises = layer.items.map(async function (item) {
                var toolStart = Date.now();
                var result;
                // ★ 埋 trace 标记，供钩子 Q 读取（quest/floor/house/room 溯源）
                if (typeof window !== 'undefined') {
                    window._qqqCurrentTrace = {
                        questId: (typeof questActiveId !== 'undefined') ? questActiveId : '',
                        floorNum: self._ctx ? self._ctx.totalFloors : 0,
                        houseIdx: self._houseIndex || 0,
                        roomIdx: item._toolIndex || 0
                    };
                }
                try {
                    result = await executeTool(item.name, item.args);
                } catch (err) {
                    result = 'Tool error: ' + (err.message || err);
                }
                if (typeof window !== 'undefined') { window._qqqCurrentTrace = null; }
                var toolMs = Date.now() - toolStart;
                var resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                self._log('← ' + item.name + ' (' + toolMs + 'ms): ' + resultStr.slice(0, 120));
                if (onToolResult) {
                    var truncated = resultStr.length > 2000;
                    onToolResult(item.name, truncated ? resultStr.slice(0, 2000) + '\n... (truncated)' : resultStr, truncated);
                }
                var _aiCap = (typeof ContentGateway !== 'undefined' ? ContentGateway.OUTPUT_CAP_DEFAULT : 8000);
                var trimmed = resultStr.length > _aiCap
                    ? resultStr.slice(0, _aiCap) + '\n... (' + resultStr.length + ' chars, truncated)'
                    : resultStr;
                return { call: item.call, content: trimmed, rawContent: resultStr };
            });
            var results = await Promise.all(promises);
            // 所有工具结果经内容安全网关处理后才进入存储/UI（单一真理入口）
            var lastHouse = self._houses[self._houses.length - 1];
            if (lastHouse && lastHouse.type === 'tools') {
                lastHouse.toolResults = results.map(function (r) {
                    var gated = (typeof ContentGateway !== 'undefined' && ContentGateway.process)
                        ? ContentGateway.process(r.rawContent)
                        : { safe: r.rawContent || '' };
                    return gated.safe;
                });
                lastHouse._lines = null;  // 使 UI 端 _buildHouseLines 缓存失效
            }
            for (var ri = 0; ri < results.length; ri++) {
                allResults.push(results[ri]);
            }
        }
        return { allResults: allResults, assistantMsg: assistantMsg };
    };

    // ---- 执行分层：将工具调用按文件冲突分组 ----
    AgentLoop.prototype._buildExecutionLayers = function (calls) {
        var layers = [];
        for (var i = 0; i < calls.length; i++) {
            var call = calls[i];
            var cat = (typeof TOOL_CATEGORY !== 'undefined' ? TOOL_CATEGORY[call.name] : null) || 'EFFECT';
            var targetPath = call.args.path || call.args.file_path || '';
            if (call.name === 'run_command') targetPath = '__cmd__' + (call.args.command || '').slice(0, 50);
            var placed = false;
            for (var li = layers.length - 1; li >= 0; li--) {
                if (this._canPlaceInLayer(layers[li], call.name, cat, targetPath)) {
                    layers[li].items.push(call);
                    layers[li].fileMap[targetPath] = this._mergeAccess(layers[li].fileMap[targetPath], cat);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                var fm = {};
                fm[targetPath] = cat;
                layers.push({ items: [call], fileMap: fm });
            }
        }
        return layers;
    };

    AgentLoop.prototype._canPlaceInLayer = function (layer, toolName, cat, targetPath) {
        var existing = layer.fileMap[targetPath];
        if (!existing) {
            if (cat === 'EFFECT') {
                var effectCount = 0;
                for (var i = 0; i < layer.items.length; i++) {
                    var itemCat = (typeof TOOL_CATEGORY !== 'undefined' ? TOOL_CATEGORY[layer.items[i].name] : null) || 'EFFECT';
                    if (itemCat === 'EFFECT') effectCount++;
                }
                if (toolName === 'run_command' && effectCount >= 2) return false;
            }
            return true;
        }
        if (existing === 'READ' && cat === 'READ') return true;
        return false;
    };

    AgentLoop.prototype._mergeAccess = function (existing, incoming) {
        if (!existing) return incoming;
        if (existing === 'WRITE' || incoming === 'WRITE') return 'WRITE';
        if (existing === 'EFFECT' || incoming === 'EFFECT') return 'EFFECT';
        return 'READ';
    };


    // ---- 引导注入（旧）：将引导消息插入对话（不触发 API 调用） ----
    AgentLoop.prototype.inject = function (message) {
        this.conversation.push({ role: 'user', content: message, _injected: true, _floor: this._ctx.totalFloors });
        this._log('→ injected: ' + message.slice(0, 60));
        return true;
    };

    // ═══ 压缩卡片渲染（复用引导消息 UI 模式） ═══
    // 插入压缩启动卡片（紫色）到当前 AI div
    AgentLoop.prototype._renderCompressStart = function (reason) {
        var _aiDiv = this._activeAiDiv;
        if (!_aiDiv || !_aiDiv._contentWrap) return;
        var _escHtml = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
        var _now = new Date();
        var _ts = _now.getFullYear() + '-' + String(_now.getMonth()+1).padStart(2,'0') + '-' + String(_now.getDate()).padStart(2,'0') + ' ' + String(_now.getHours()).padStart(2,'0') + ':' + String(_now.getMinutes()).padStart(2,'0') + ':' + String(_now.getSeconds()).padStart(2,'0');
        // 启动卡片
        var _startCard = document.createElement('div');
        _startCard.className = 'msg-flow-compress-start';
        _startCard.innerHTML = '<div class="msg-flow-compress-hdr"><span class="msg-flow-icon">📦</span> 启动上下文压缩</div><div class="msg-flow-compress-body">' + _escHtml(_ts) + ' · ' + _escHtml(reason) + '</div>';
        _aiDiv._contentWrap.appendChild(_startCard);
        // 等待中标记
        var _marker = document.createElement('div');
        _marker.className = 'msg-flow-guide';
        _marker.style.cssText = 'opacity:0.6;';
        _marker.innerHTML = '<span class="msg-flow-icon">⏳</span> 压缩中...';
        _aiDiv._contentWrap.appendChild(_marker);
        _aiDiv._compressMarker = _marker;
    };

    // 压缩完成后替换等待标记为成功/失败卡片
    AgentLoop.prototype._renderCompressResult = function (result) {
        var _aiDiv = this._activeAiDiv;
        if (!_aiDiv || !_aiDiv._compressMarker) return;
        var _escHtml = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
        var _marker = _aiDiv._compressMarker;
        _aiDiv._compressMarker = null;
        if (result.compressed) {
            // 成功压缩
            _marker.className = 'msg-flow-compress-success';
            _marker.style.cssText = '';
            _marker.innerHTML = '<div class="msg-flow-compress-success-hdr"><span class="msg-flow-icon">✅</span> 成功压缩</div><div class="msg-flow-compress-success-body">' + _escHtml(result.detail) + '</div>';
        } else if (result.detail && (result.detail.indexOf('无需压缩') === 0 || result.detail.indexOf('所有楼层') === 0 || result.detail.indexOf('冷消息不足') === 0)) {
            // 正常跳过（阈值未达或无可压缩内容）→ 中性样式
            _marker.className = 'msg-flow-guide';
            _marker.style.cssText = '';
            _marker.innerHTML = '<span class="msg-flow-icon">ℹ️</span> ' + _escHtml(result.detail);
        } else {
            // 真正失败
            _marker.className = 'msg-flow-compress-fail';
            _marker.style.cssText = '';
            _marker.innerHTML = '<div class="msg-flow-compress-fail-hdr"><span class="msg-flow-icon">✗</span> 压缩失败</div><div class="msg-flow-compress-fail-body">' + _escHtml(result.detail || '未知错误') + '</div>';
        }
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
    if (!AgentLoop.prototype._buildDynamicContext) {
        AgentLoop.prototype._buildDynamicContext = function () { return ''; };
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

    return AgentLoop;
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AgentLoop };
}
