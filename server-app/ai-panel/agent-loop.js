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
// system-prompt.js  → GATEWAY_URL, SYSTEM_PROMPT, TRIVIAL_REGEX, CHAT_REGEX, TIER_FLASH, TIER_PRO
// tools.js          → TOOL_DEFINITIONS, TOOL_CATEGORY, executeTool, getTools

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

        // 清理残留的空 [💎] 行（过渡期兼容）
        cleanContent = cleanContent.replace(/^\[💎\]\s*(?:暂无待办|暂无|无|None|N\/A|暂无发现|暂无财宝|暂无建议)\s*[。.]?\s*$/gm, '');
        cleanContent = cleanContent.replace(/\x0a{3,}/g, '\x0a\x0a').replace(/^\x0a+/, '');

        // ★ 剥离可能泄漏的原生 XML tool-call 块（模型偶发在 content 中输出 invoke 语法）
        // 🔴 安全闸：仅当内容疑似以 XML 开头（<invoke 或 <tool_call）时才做深度清洗，
        //    否则只做轻量标签移除，防止正则误伤正常文本（如解释性文字中含 <invoke> 示例）
        var _xmlLike = /^\s*<(?:invoke|tool_call|function_call|parameter|qqq_tool_calls)/i.test(cleanContent);
        if (_xmlLike) {
            // 深度清洗：整块移除 <invoke>...</invoke>（含内部 <parameter> 块）
            cleanContent = cleanContent.replace(/<invoke[\s>][\s\S]*?<\/invoke>/gi, '');
            cleanContent = cleanContent.replace(/<invoke[\s>][^>]*\/>/gi, '');
            // ★ 补刀：裸 <parameter>...</parameter>（无外层 invoke 包裹时）
            cleanContent = cleanContent.replace(/<parameter[\s>][^>]*>[\s\S]*?<\/parameter>/gi, '');
            cleanContent = cleanContent.replace(/<parameter[\s>][^>]*\/?>/gi, '');
            cleanContent = cleanContent.replace(/<\/?qqq_tool_calls>/gi, '');
            cleanContent = cleanContent.replace(/<\/?_?tool_calls?>/gi, '');
            cleanContent = cleanContent.replace(/<\/?_?tool_call>/gi, '');
            cleanContent = cleanContent.replace(/<\/?function_call>/gi, '');
        } else {
            // 轻量：移除孤立的 XML 标签行 + 多行块（仅含 XML 无正常文本）
            // 孤行匹配 <invoke...> 或 </invoke> 等独立标签行
            cleanContent = cleanContent.replace(/^<\/?invoke[^>]*>\s*$/gim, '');
            cleanContent = cleanContent.replace(/^<\/?tool_calls?[^>]*>\s*$/gim, '');
            cleanContent = cleanContent.replace(/^<\/?function_call[^>]*>\s*$/gim, '');
            // ★ 补刀：多行 <invoke>...</invoke> 和 <parameter>...</parameter> 整块移除
            // 无 |$ 兜底 → 缺闭合标签时零匹配，零误伤
            cleanContent = cleanContent.replace(/<invoke[\s>][\s\S]*?<\/invoke>/gi, '');
            cleanContent = cleanContent.replace(/<parameter[\s>][^>]*>[\s\S]*?<\/parameter>/gi, '');
        }
        // 去除因上述清理产生的连续空行
        cleanContent = cleanContent.replace(/\x0a{3,}/g, '\x0a\x0a').replace(/^\x0a+/, '').trim();

        return { cleanContent: cleanContent, envelope: envelope, summary: summary, lang: lang };
    };

    // ---- AgentLoop 构造函数 ----
    function AgentLoop(opts) {
        this.conversation = [];        // [{role, content, tool_calls?, tool_call_id?}]
        this.abortController = null;
        this._log = opts.log || function () { };
        this.log = this._log;          // alias for context engine
        // 上下文引擎
        this._compressing = false;
        this._ctx = { narrative: '', facts: [], treasures: [], totalFloors: 0 };
        // 计费
        this._floorCostWge = 0;
        this.totalCostGe = 0;
        this._lastCostDisplay = '0';
        this._lastApiPromptTokens = 0;  // 初始化清零，避免残留旧 quest 数值
        // 视觉缓存: MD5(base64) → {description, ge_cost}
        this._visionCache = new Map();
        this._visionCostWge = 0;
        // 计费 flush
        this._floorId = '';
        this._currentFloorSummary = '';
        this._floorTreasures = [];
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

    // ═══ 修复断裂的 tool_calls（启动自愈） ═══
    // 要求 assistant tool_calls 后必须紧跟 tool 消息。
    // 扫描 conversation，砍掉孤立的 assistant tool_calls（后面缺 tool 配对），
    // 以及孤立的 tool 消息（前面缺 assistant tool_calls）。
    AgentLoop.prototype._repairOrphanedToolCalls = function () {
        var self = this;
        var conv = self.conversation;
        if (!conv || conv.length === 0) return;
        var removedTotal = 0;
        // 多轮扫描直到干净（修复一处可能暴露上一处问题）
        for (var pass = 0; pass < 5; pass++) {
            var cutAt = -1;
            // 从前往后扫：找 assistant tool_calls，验后面的 tool 数量
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
                        // 残缺：移除 assistant + 后面跟的 tool 消息（若有）
                        var removeCount = toolSeqEnd - i;
                        conv.splice(i, removeCount);
                        removedTotal += removeCount;
                        cutAt = i;  // 从修复位置继续扫描
                        break;
                    }
                    // 完整 → 跳过整个 tool 序列
                    i = toolSeqEnd - 1;
                }
            }
            if (cutAt < 0) break;  // 本轮无修复，干净
        }
        if (removedTotal > 0) {
            self._log('🔧 repaired: removed ' + removedTotal + ' orphaned msgs (broken tool_calls/tool pairs)');
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
            return s.startsWith('No matches found') || s.startsWith('Error') || s === '' || s.startsWith('Tool error');
        });
        if (allNoProgress) {
            self._stallCount++;
        } else {
            self._stallCount = 0;
            self._stallWarned = false;
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
        this._ctx = { narrative: "", facts: [], treasures: [], totalFloors: 0 };
        this._visionCache.clear();
        this._houses = [];
        this._a4Snapshots = {};
        this._houseIndex = 0;
        this._persistentCount = 0;
        this._rulesVersion = "";
    };

    // ---- 结构化信封注入：校验 → A3渲染 + 上下文注入（去重，每条只写一次）-------
    AgentLoop.prototype._injectEnvelope = function (envelope) {
        if (!envelope || typeof envelope !== 'object') return;
        if (!Array.isArray(envelope.treasures)) return;
        this._injectedTreasureKeys = this._injectedTreasureKeys || {};
        var validated = [];
        for (var i = 0; i < envelope.treasures.length; i++) {
            var t = envelope.treasures[i];
            if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
            var gain = Number(t.gain) || 0;
            var cost = Number(t.cost) || 0;
            var urgency = (t.urgency === 'urgent' || t.urgency === 'soon' || t.urgency === 'later') ? t.urgency : 'later';
            var text = t.text.trim().slice(0, 300);
            if ((gain - cost) >= 7) {
                validated.push({ text: text, gain: gain, cost: cost, urgency: urgency });
                // 去重后注入上下文（每条 treasure 全局只写一次）
                var key = text.slice(0, 80);
                if (!this._injectedTreasureKeys[key]) {
                    this._injectedTreasureKeys[key] = true;
                    this._ctx.treasures.push({ floor: this._ctx.totalFloors, content: text, urgency: urgency });
                    if (this._ctx.treasures.length > 30) this._ctx.treasures = this._ctx.treasures.slice(-30);
                }
            }
        }
        this._floorTreasures = validated;
        if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
        var aiDiv = this._activeAiDiv;
        if (aiDiv && aiDiv._treasureBlock && typeof _renderTreasures === 'function') {
            _renderTreasures(aiDiv._treasureBlock, validated);
        }
    };

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

        if (!token) { onError('No token'); return null; }

        // ★ 存储 token 供 tools.js 调用 Go 端点时使用
        self._token = token;

        // 重置本轮计费 + 生成 floor_id（同一轮内所有 gateway 调用共享）
        self._floorCostWge = 0;
        self._floorFree = false;
        self._floorId = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        self._currentFloorSummary = (userContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        self._floorTreasures = [];
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
        self._compressing = true;
        try {
            await self._compressContext();  // 上下文压缩（阻塞，必须拿到 q 才继续）
        } finally {
            self._compressing = false;
        }
        self._log('→ user: ' + (userContent || '').slice(0, 80) + (images ? ' +' + images.length + ' images' : '') + (visionText ? ' [vision done]' : ''));

        // 智能等级：优先手动选择，否则自动判断
        var trimmed = userContent.trim();
        var hasImages = images && images.length > 0;
        var tier, forceNoTools;
        if (opts.tier) {
            tier = opts.tier;
            forceNoTools = false;
            self._log('◆ ' + tier.label + ' (manual)');
        } else {
            var isTrivial = !hasImages && typeof TRIVIAL_REGEX !== 'undefined' ? TRIVIAL_REGEX.test(trimmed) : false;
            var isChat = !hasImages && !isTrivial && typeof CHAT_REGEX !== 'undefined' ? CHAT_REGEX.test(trimmed) : false;
            tier = (hasImages || !isTrivial && !isChat) ? TIER_PRO : TIER_FLASH;
            forceNoTools = !hasImages && (isTrivial || isChat);
            self._log('◆ ' + tier.label + ' (auto: trivial=' + isTrivial + ', chat=' + isChat + ', noTools=' + forceNoTools + ')');
        }

        var maxIterations = forceNoTools ? 1 : 200;
        var conversationSnapshot = self.conversation.length;
        self._houses = [];
        self._a4Snapshots = {};
        self._houseIndex = 0;
        self._floorKilled = false;  // ★ 看门狗：用户点停止才置 true
        self._floorCompletedCleanly = false;  // ★ 看门狗：只有 onDone 路径才置 true
        self._floorOnErrorCalled = false;  // ★ 看门狗：onError 回调已处理，不重复恢复
        self._resetStallCounter();

        try {
            while (maxIterations-- > 0) {
                // ═══ 引导确认回合：不中断楼层，立即让 AI 回复确认 ═══
                if (self._guidePending && self._guideMessage) {
                    self._guidePending = false;
                    self._abortedByGuide = false;
                    var _guideText = self._guideMessage;
                    self._guideMessage = '';
                    maxIterations++; // 确认回合不消耗迭代配额
                    var _ackStart = Date.now();

                    self._log('⚡ guide ack round: ' + _guideText.slice(0, 60));

                    // 构建确认指令 — 追加到 conversation 末尾（精简版，节省 tokens）
                    var _ackPrompt = '[GUIDE_ACK] 紧急补充：' + _guideText + '\n' +
                        '只回复 "✅ 已收到引导：[一句话概述]"，不用工具，不输出其他。';

                    self.conversation.push({ role: 'user', content: _ackPrompt, _guideAck: true, _floor: self._ctx.totalFloors });

                    var _ackResp = await self._callGateway(self.conversation, {
                        token: token,
                        onToken: onToken,
                        onReasoning: onReasoning,
                        onError: onError,
                        tier: TIER_FLASH,
                        noTools: true
                    });

                    // 确认回合被再次引导中断 → pop ack prompt，让新引导接管
                    if (_ackResp && _ackResp._abortedForGuide) {
                        self.conversation.pop();
                        self._log('⚠ guide ack: aborted by newer guide');
                        continue;
                    }

                    if (_ackResp && _ackResp.content) {
                        // 移除确认指令（user 消息），只保留 AI 确认回复，避免硬指令污染后续对话
                        self.conversation.pop(); // pop _ackPrompt
                        // ★ 防御：模型偶发在 content 中输出原生 XML tool-call 语法
                        // 引导确认预期极短（仅 "✅ 已收到引导：..."），若检测到 XML 污染直接降级为默认语
                        var _ackRaw = _ackResp.content;
                        var _xmlPattern = /<(?:invoke|tool_call|function_call|parameter|qqq_tool_calls)[\s>]/i;
                        var _cleanAck;
                        if (_xmlPattern.test(_ackRaw)) {
                            // 含 XML 污染 → 尝试提取第一行纯文本，失败则降级
                            var _firstLine = _ackRaw.replace(/<[^>]+>/g, '').split('\n')[0].trim();
                            _cleanAck = (_firstLine && _firstLine.length >= 3) ? _firstLine : '✅ 已收到引导';
                        } else {
                            // 干净 → 直接取第一段非空内容（去多余换行）
                            _cleanAck = _ackRaw.replace(/\n{3,}/g, '\n\n').trim();
                        }
                        self.conversation.push({ role: 'assistant', content: _cleanAck, _guideAck: true, _guideText: _guideText, _floor: self._ctx.totalFloors });
                        // 归档：确认回合写入 houses（all.txt 可见）
                        self._houses.push({ index: 'G' + (self._houseIndex || 0), type: 'guide_ack', tools: [], summary: '', ms: Date.now() - _ackStart, reasoning: _ackResp.reasoning_content || '', answer: _ackResp.content, ts: new Date().toISOString() });
                        // ★ 更新绿条标记：⏳ 确认中... → ✅ 已收到引导
                        var _aiDiv2 = self._activeAiDiv;
                        if (_aiDiv2 && _aiDiv2._guideMarker) {
                            _aiDiv2._guideMarker.style.cssText = '';
                            var _ackDisplay = _cleanAck.replace(/^✅\s*/, '').trim() || '已收到引导';
                            var _esc = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
                            _aiDiv2._guideMarker.innerHTML = '<span class="msg-flow-icon">✅</span> ' + _esc(_ackDisplay);
                            _aiDiv2._guideMarker = null;
                        }
                        if (typeof window._a4MarkIncrementalDirty === 'function') window._a4MarkIncrementalDirty();
                        self._log('✅ guide ack: ' + _ackResp.content.slice(0, 80));
                    } else if (_ackResp && _ackResp.type === 'tool_calls') {
                        // AI 不听话，仍返回工具调用 → 移除 ack prompt，不污染对话
                        self.conversation.pop();
                        self._log('⚠ guide ack: AI returned tool_calls despite noTools, ignored');
                    } else {
                        // 网络错误或其他异常 → 移除 ack prompt
                        self.conversation.pop();
                        self._log('⚠ guide ack: no valid response, skipped');
                    }
                    // 确认回合结束 → 继续正常 while 循环
                    onGuideAckDone();
                    continue;
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
                    // 502/503 自动修复：轻量砍掉断裂的 tool_calls，继续当前循环重试
                    if ((self._lastGatewayError === 502 || self._lastGatewayError === 503) && !opts._repairAttempted) {
                        self._lastGatewayError = 0;
                        self._repairOrphanedToolCalls();
                        self._resetStallCounter();
                        opts._repairAttempted = true;  // 防止无限循环
                        maxIterations++;  // 不消耗迭代配额
                        self._log('→ repair: orphaned tool_calls stripped, retrying...');
                        continue;
                    }
                    // 错误已由 _callGateway 的 onError 处理
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
                // API 精确上下文 token 计数（usage.prompt_tokens）
                if (response._usage && response._usage.prompt_tokens) {
                    self._lastApiPromptTokens = response._usage.prompt_tokens;
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
                    self._houses.push({ index: self._houseIndex, type: 'final', tools: [], summary: '', ts: new Date().toISOString(), ms: Date.now() - _hStart, reasoning: response.reasoning_content || '', answer: response.content || '' });
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
                    self._floorCompletedCleanly = true;  // ★ 看门狗：AI 正常回复
                    onDone(response.content, self._floorTiming);
                    return response.content;
                }

                if (response.type === 'tool_calls') {
                    var _tools = response.tool_calls.map(function (tc) { return { name: tc.function.name, args: tc.function.arguments }; });
                    self._houses.push({ index: self._houseIndex, type: 'tools', tools: _tools, toolResults: [], summary: '', ts: new Date().toISOString(), ms: Date.now() - _hStart, reasoning: response.reasoning_content || '' });
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
                        }
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
                    self._houses.push({ index: self._houseIndex, type: 'final', tools: [], summary: '(forced)', ts: new Date().toISOString(), ms: Date.now() - _hFinalStart, reasoning: finalResp.reasoning_content || '', answer: finalResp.content || '' });
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
        var onToken = opts.onToken;
        var onReasoning = opts.onReasoning;
        var onError = opts.onError;
        var tier = opts.tier || TIER_PRO;
        var noTools = opts.noTools || false;

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

        // ★ HTTP/2 死连接防卡死：90s 无响应自动 abort（Cloudflare Free 100s 限制）
        var _fetchDeadline = setTimeout(function () {
            if (self.abortController) {
                self._log('⏰ fetch deadline 90s reached — aborting to prevent hang');
                self.abortController.abort();
            }
        }, 90000);
        // 包装：每次进入 retry 重置 deadline
        function _resetFetchDeadline() {
            clearTimeout(_fetchDeadline);
            _fetchDeadline = setTimeout(function () {
                if (self.abortController) {
                    self._log('⏰ fetch deadline 90s reached — aborting to prevent hang');
                    self.abortController.abort();
                }
            }, 90000);
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
        var dynamicCtx = self._buildDynamicContext(lastUserQuery);
        if (dynamicCtx) {
            apiMessages = messages.slice();
            var lastIdx = apiMessages.length - 1;
            if (lastIdx >= 0 && apiMessages[lastIdx] && apiMessages[lastIdx].role === 'user') {
                var origContent = apiMessages[lastIdx].content;
                apiMessages[lastIdx] = { role: 'user', content: origContent + '\n\n' + dynamicCtx };
            }
        }

        // 语言检测已移至 a1 审计按钮（后翻译方案），此处不再强制注入语言指令
        // ★ 计费摘要提示（geflow 展开时区分每间 house，Go 优先使用此字段）
        var summaryHint = '';
        if (self._houseIndex <= 1) {
            summaryHint = '用户提问';
        } else {
            var _lh = self._houses[self._houses.length - 1];
            if (_lh && _lh.type === 'tools' && _lh.tools && _lh.tools.length > 0) {
                summaryHint = '工具: ' + _lh.tools.map(function (t) { return t.name; }).join(', ');
            } else if (_lh && _lh.type === 'guide_ack') {
                summaryHint = '引导确认';
            }
        }
        var body = {
            model: tier.model || 'pro',
            messages: apiMessages,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: tier.maxTokens || ContentGateway.MAX_RESPONSE_TOKENS,
            floor_id: self._floorId,
            summary_hint: summaryHint
        };

        if (!noTools && typeof getTools === 'function') {
            body.tools = getTools();
        }
        if (tier.thinking) body.thinking = tier.thinking;
        if (tier.effort) body.reasoning_effort = tier.effort;

        // ★ 自适应节流：距上次 API 调用不足 MIN_API_INTERVAL_MS 则等待
        var MIN_API_INTERVAL_MS = 600;
        var _now = performance.now();
        if (self._lastApiCallTs) {
            var _elapsedSinceLastCall = _now - self._lastApiCallTs;
            if (_elapsedSinceLastCall < MIN_API_INTERVAL_MS) {
                var _waitMs = MIN_API_INTERVAL_MS - _elapsedSinceLastCall;
                await new Promise(function (r) { setTimeout(r, _waitMs); });
            }
        }
        self._lastApiCallTs = performance.now();

        var MAX_RETRIES = 1;  // ★ 提速：有兜底线路，同 URL 最多重试 1 次
        var MAX_KEY_ROTATIONS = 3;  // 最多切换 3 次 key
        var _keyRotations = 0;
        var _ttfbAccum = 0;
        for (var retry = 0; retry <= MAX_RETRIES; retry++) {
            _resetFetchDeadline();  // ★ 每次 retry 重置 90s deadline
            // ★ 防御：abortController 可能被外部 injectGuide() 置 null
            if (!self.abortController) {
                self.abortController = new AbortController();
            }
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
                        // ★ 502/503: 不重试同一 URL，立刻走兜底切换（下面处理）
                        if (resp.status === 502 || resp.status === 503) {
                            // 跳过 retry，直接落入下方的兜底切换逻辑
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
                    // ★ 502/503: 切备用线路，不 reload
                    if (resp.status === 502 || resp.status === 503) {
                        self._lastGatewayError = resp.status;
                        clearTimeout(_fetchDeadline);
                        if (_gwTryingPrimary || (typeof _gwSwitch === 'function' && GATEWAY_URL === GATEWAY_URL_PRIMARY)) {
                            // 主线路挂了 → 切备用 + qoast 提示
                            if (_gwTryingPrimary) {
                                if (typeof _gwPrimaryFailed === 'function') _gwPrimaryFailed();
                                _gwTryingPrimary = false;  // 已退回备用，本次不再尝试切回
                            } else {
                                _gwSwitch(true);
                            }
                            // 重试一次（新线路）
                            retry = -1;
                            self._log('  ↳ switched to fallback, retrying...');
                            continue;
                        } else {
                            // 已在备用线路 → 无计可施
                            onError(friendly + '，所有线路均不可达');
                        }
                        return null;
                    }
                    clearTimeout(_fetchDeadline);
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
                    return null;
                }
                var msg = err.message || '';
                // HTTP/2 协议检测：JS 层 fetch() 对 ERR_HTTP2_* 只报 "Failed to fetch"
                // net::ERR_HTTP2_PROTOCOL_ERROR 仅 DevTools 可见，JS Error.message 拿不到
                // HTTP/2 检测：覆盖 fetch 阶段和 SSE 流阶段的网络错误
                // ERR_HTTP2_PING_FAILED 在 fetch 层体现为 "Failed to fetch"
                // 在 SSE 流层体现为 "network error"（reader.read() 抛出）
                var _isHttp2Like = msg.indexOf("ERR_HTTP2") >= 0
                    || msg.indexOf("ERR_CONNECTION_CLOSED") >= 0
                    || msg === 'Failed to fetch'
                    || msg.indexOf('network error') >= 0;

                if (retry < MAX_RETRIES) {
                    // HTTP/2 死连接重试：等待更长时间让 Chromium 回收坏连接
                    var waitMsF = 1000;  // ★ 提速：1s 快速重试 + 兜底切换
                    self._log('  fetch error retry #' + (retry + 1) + ' in ' + waitMsF + 'ms: ' + msg);
                    await new Promise(function (r) { setTimeout(r, waitMsF); });
                    continue;
                }

                // 重试耗尽 — 先尝试切换线路，最后手段才 reload
                clearTimeout(_fetchDeadline);
                self._consecutiveFetchErrors = (self._consecutiveFetchErrors || 0) + 1;
                self._log('✗ fetch exhausted: ' + msg + ' (consecutive=' + self._consecutiveFetchErrors + ')');

                var _canSwitchUrl = false;
                if (_gwTryingPrimary) {
                    // 尝试主线路失败 → 无声退回备用
                    if (typeof _gwPrimaryFailed === 'function') _gwPrimaryFailed();
                    _gwTryingPrimary = false;  // 已退回备用
                    _canSwitchUrl = true;
                } else if (typeof _gwSwitch === 'function' && GATEWAY_URL === GATEWAY_URL_PRIMARY) {
                    // 主线路 HTTP/2 连接坏 → 切备用 + qoast
                    _gwSwitch(true);
                    _canSwitchUrl = true;
                }
                // ★ 备用线路也 HTTP/2 错误 或 连续多次错误 → 只能 reload
                if (_isHttp2Like || self._consecutiveFetchErrors >= 3) {
                    onError('连接中断，正在自动恢复…');
                    try { sessionStorage.setItem('__qqq_scroll_bottom', '1'); } catch (_) { }
                    setTimeout(function () { window.location.reload(); }, 600);
                } else if (_canSwitchUrl) {
                    // 切换了线路 → 重置 retry，走正常重试
                    retry = -1;
                    self._consecutiveFetchErrors = 0;
                    continue;
                } else {
                    onError('⚠️ 网络请求失败。对话已保存，正在自动恢复…');
                    try { sessionStorage.setItem('__qqq_scroll_bottom', '1'); } catch (_) { }
                    setTimeout(function () { window.location.reload(); }, 1500);
                }
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

        // ★ 流级别看门狗：60s 无数据 → 连接已死，主动 abort
        var _streamWatchdog = null;
        function _resetStreamWatchdog() {
            if (_streamWatchdog) clearTimeout(_streamWatchdog);
            _streamWatchdog = setTimeout(function () {
                self._log('⏰ stream watchdog 60s — no data, aborting dead connection');
                if (self.abortController) self.abortController.abort();
            }, 60000);
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
            self._log('✗ SSE error event: ' + _errMsg);
            if (_sseError.code === 502 || _sseError.code === 503) {
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

        // 结构化信封数据注入上下文引擎
        if (finalized.envelope) {
            self._injectEnvelope(finalized.envelope);
        }

        var _streamMs = performance.now() - streamStart;
        if (toolCalls.length > 0) {
            return { type: 'tool_calls', tool_calls: toolCalls.filter(Boolean), reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage };
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
            return { type: 'message', content: content, reasoning_content: reasoningContent || undefined, _streamMs: _streamMs, _usage: _usage, _finishReason: _finishReason, _envelope: finalized.envelope };
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
            prepared.push({ call: call, name: call.function.name, args: toolArgs });
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
                try {
                    result = await executeTool(item.name, item.args);
                } catch (err) {
                    result = 'Tool error: ' + (err.message || err);
                }
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

    return AgentLoop;
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AgentLoop };
}
