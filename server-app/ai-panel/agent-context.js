// ============================================================================
// agent-context.js — 上下文压缩引擎
// 从 q3/ai/src/agent-context.js 移植，适配 Shell v2
//
// 核心机制：
//   1. _compressContext() — 阻塞式：token 超 900k → 保留 10% 最近楼层（≥6层），压 90%
//   2. _digestColdMessages() — 调 AI 压缩冷消息 → 32k 多重保证 + 无限重试
//   3. _buildDynamicContext() — 注入叙事 + 相关事实 + 摘要到 API 消息末尾
//
// 关键设计（铁律）：
//   - 压缩是打断任务：触发 → 停一切 → 等 q 拿到 → 删旧消息 → 再继续
//   - 保留边界对齐楼层（user 消息 = 楼层边界），绝不切断一条楼层
//   - 最少保留 6 层楼（当前层 + 前 5 层），即使超出 10%
//   - 压缩产出硬限 32k tokens，prompt + max_tokens + 校验三重保证
//   - 压缩失败 → 指数退避无限重试（2s/4s/8s/.../60s），永不静默丢弃
//
// 依赖：GATEWAY_URL（由 system-prompt.js 提供），AgentLoop（由 agent-loop.js 提供）
// ============================================================================

; (function () {

    var TOKEN_BUDGET = (typeof ContentGateway !== 'undefined' ? ContentGateway.COMPRESS_THRESHOLD : 900000);   // 压缩触发阈值（来自唯一真理源）
    var KEEP_RATIO = 0.1;         // 保留最近 10%
    var MIN_FLOORS = 6;           // 最少保留 6 层楼（当前层 + 前 5 层）
    var MAX_FACTS = 100;          // 最多保留事实条数
    var CHAR_PER_TOKEN_EST = (typeof ContentGateway !== 'undefined' ? ContentGateway.CHAR_PER_TOKEN : 3.0); // 统一估算比例
    // 压缩产出硬限 — 唯一真理在 ContentGateway.COMPACT_MAX_TOKENS（content-gateway.js）
    var COMPACT_MAX_TOKENS = (typeof ContentGateway !== 'undefined' ? ContentGateway.COMPACT_MAX_TOKENS : 32768);
    var COMPACT_RETRY_BASE_MS = 2000;    // 重试基础间隔 2s
    var COMPACT_RETRY_MAX_MS = 60000;    // 重试最大间隔 60s

    // ═══ 单条消息 token 估算 ═══
    AgentLoop.prototype._estimateMsgTokens = function (msg) {
        if (!msg) return 0;
        var tokens = 10; // role overhead
        var content = msg.content;
        if (typeof content === 'string') tokens += content.length / CHAR_PER_TOKEN_EST;
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            try { tokens += JSON.stringify(msg.tool_calls).length / CHAR_PER_TOKEN_EST; } catch (_) { }
        }
        return Math.round(tokens);
    };

    // ═══ 消息数组总 token 估算 ═══
    AgentLoop.prototype._estimateTotalTokens = function (msgs) {
        var msgsArr = msgs || this.conversation;
        var total = 0;
        for (var i = 0; i < msgsArr.length; i++) {
            total += this._estimateMsgTokens(msgsArr[i]);
        }
        return total;
    };

    // ═══ 阻塞式上下文压缩 — 铁律 ═══
    // 规则：
    //   1. 超 900k 才触发
    //   2. 从末尾倒推 90k tokens → 取整到楼层边界（user 消息）
    //   3. 最少保留 6 层楼，即使超出 10%
    //   4. 阻塞等待 AI 压缩（32k），成功后才删除
    //   5. 压缩失败 → 无限重试，指数退避
    // reason: { trigger: 'auto'|'manual', detail: string }
    // 返回: { compressed: true|false, detail: string, beforeTokens: number, afterTokens: number, elapsedMs: number }
    AgentLoop.prototype._compressContext = async function (reason) {
        var self = this;
        var totalEst = self._estimateTotalTokens();
        // ★ 优先用 _lastApiTotalTokens（prompt+completion 精确值），fallback 到 prompt_tokens
        var dsTokens = self._lastApiTotalTokens || self._lastApiPromptTokens || 0;
        var beforeTokens = Math.max(totalEst, dsTokens);

        // 两个指标都没超 900k → 跳过；任一超了 → 触发（本地估算可能低估，DS 值更准）
        if (totalEst <= TOKEN_BUDGET && dsTokens <= TOKEN_BUDGET) {
            return { compressed: false, detail: '无需压缩（' + beforeTokens + ' < ' + TOKEN_BUDGET + '）', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        var KEEP_TARGET = Math.floor(TOKEN_BUDGET * KEEP_RATIO);

        var runningTokens = 0;
        var hotStart = self.conversation.length;
        for (var i = self.conversation.length - 1; i >= 0; i--) {
            runningTokens += self._estimateMsgTokens(self.conversation[i]);
            if (runningTokens >= KEEP_TARGET) {
                hotStart = i;
                break;
            }
        }

        if (hotStart < self._persistentCount) hotStart = self._persistentCount;

        while (hotStart > self._persistentCount && self.conversation[hotStart].role !== 'user') {
            hotStart--;
        }

        var floorCount = 0;
        for (var f = hotStart; f < self.conversation.length; f++) {
            if (self.conversation[f].role === 'user' && !self.conversation[f]._persistent) floorCount++;
        }

        while (floorCount < MIN_FLOORS && hotStart > self._persistentCount) {
            hotStart--;
            if (self.conversation[hotStart].role === 'user' && !self.conversation[hotStart]._persistent) {
                floorCount++;
            }
        }

        while (hotStart > self._persistentCount && self.conversation[hotStart].role !== 'user') {
            hotStart--;
        }

        if (hotStart <= self._persistentCount) {
            self.log('\u25C6 Context: ' + floorCount + ' floors \u2192 all hot, nothing to compress');
            return { compressed: false, detail: '所有楼层都在热点区，无可压缩内容', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        var coldMsgs = self.conversation.slice(0, hotStart);
        var coldTokenEst = self._estimateTotalTokens(coldMsgs);
        var hotMsgs = self.conversation.slice(hotStart);
        var hotTokenEst = self._estimateTotalTokens(hotMsgs);

        if (coldTokenEst < 500) {
            return { compressed: false, detail: '冷消息不足 500 tokens，跳过压缩', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        var _compressStart = performance.now();
        self.log('\u25C6 Context: compress ' + coldMsgs.length + ' msgs (~' + Math.round(coldTokenEst) + 'tok) \u2192 keep ' + hotMsgs.length + ' msgs (~' + Math.round(hotTokenEst) + 'tok, ' + floorCount + ' floors)');

        try {
            await self._digestColdMessages(coldMsgs);
            self.conversation.splice(self._persistentCount, hotStart - self._persistentCount);
            self._lastApiPromptTokens = 0;
            self._lastApiTotalTokens = 0;
            var _elapsed = Math.round(performance.now() - _compressStart);
            var _afterEst = self._estimateTotalTokens();
            var _saved = beforeTokens - _afterEst;
            self.log('\u25C6 Context: done — ' + coldMsgs.length + ' msgs removed, ' + self.conversation.length + ' msgs kept');
            return {
                compressed: true,
                detail: '压缩 ' + coldMsgs.length + ' 条消息 → ' + self.conversation.length + ' 条保留\n上下文: ' + Math.round(beforeTokens/1000) + 'k → ' + Math.round(_afterEst/1000) + 'k tokens (节省 ' + Math.round(_saved/1000) + 'k)\nFacts: ' + self._ctx.facts.length + ' 条 | Narrative: ' + (self._ctx.narrative ? self._ctx.narrative.length : 0) + ' chars\n耗时: ' + (_elapsed/1000).toFixed(1) + 's',
                beforeTokens: beforeTokens,
                afterTokens: _afterEst,
                elapsedMs: _elapsed
            };
        } catch (digestErr) {
            // 用户主动停止 → 立即向上抛出，终止楼层
            if (digestErr && digestErr.name === 'AbortError') throw digestErr;
            var _elapsed2 = Math.round(performance.now() - _compressStart);
            self.log('\u2717 Context: compress FAILED after 3 retries — ' + digestErr.message + ' — skipping, messages preserved');
            return {
                compressed: false,
                detail: '已重试 3 次后失败: ' + (digestErr.message || '未知错误') + '\n消息未丢失，下轮再试\n耗时: ' + (_elapsed2/1000).toFixed(1) + 's',
                beforeTokens: beforeTokens,
                afterTokens: beforeTokens,
                elapsedMs: _elapsed2
            };
        }
    };

    // ═══ 阻塞式压缩 — 32k 多重保证 + 最多 3 次重试 ═══
    // 调用压缩 AI，必须是 async，最多重试 3 次，全失败则抛错让上层跳过压缩
    // 保证：prompt 明确告知 32k + API max_tokens=32768 + 产出后校验 + 超限重试
    AgentLoop.prototype._digestColdMessages = async function (coldMsgs) {
        var self = this;
        var coldText = coldMsgs.map(function (m) {
            var role = m.role === 'tool' ? 'tool_result' : m.role;
            var content = typeof m.content === 'string' ? m.content : '';
            return '[' + role + '] ' + content;
        }).join('\n');

        if (!coldText.trim()) return;

        // 基础 prompt（可被重试增强）
        var basePrompt = [
            'You are a context compression engine. Compress ALL conversation history below into structured knowledge.',
            '',
            '!!! HARD TOKEN LIMIT: YOUR ENTIRE OUTPUT MUST BE ≤ ' + COMPACT_MAX_TOKENS + ' TOKENS !!!',
            'Tokens are counted by the API server. Output > ' + COMPACT_MAX_TOKENS + ' tokens will be TRUNCATED —',
            'ALL truncated information is PERMANENTLY LOST. This is IRREVERSIBLE data loss.',
            '',
            'TO STAY WITHIN LIMIT:',
            '  - Estimate your output size BEFORE writing. If unsure, aim for well under half the limit.',
            '  - Merge related facts. One dense fact with proper keywords beats five scattered ones.',
            '  - Narrative: be comprehensive but RUTHLESSLY concise. Every word must earn its place.',
            '  - Drop LOW-VALUE facts before dropping HIGH-VALUE ones.',
            '  - If approaching the limit, CUT — do NOT rely on truncation to save you.',
            '  - Do NOT include \\n\\ns or decorative text. Pure JSON only.',
            '',
            'OUTPUT FORMAT — pure JSON, no markdown wrappers, no explanation:',
            '{"facts":[{"type":"file|decision|error|code_change|preference|context","content":"...","keywords":["k1"]}],"narrative":"..."}',
            '',
            'FACT TYPES:',
            '  - file:       file paths read/written/mentioned',
            '  - decision:   choices made and why',
            '  - error:      problems encountered and their resolution',
            '  - code_change: what was modified and how',
            '  - preference: user preferences or conventions discovered',
            '  - context:    important contextual info',
            '',
            'Current context narrative (merge into this): ' + (self._ctx.narrative || '(empty)'),
            '',
            'Messages to compress (' + coldMsgs.length + ' messages):',
            coldText
        ].join('\n');

        var MAX_RETRIES = 3;
        for (var retry = 0; retry < MAX_RETRIES; retry++) {
            try {
                // ★ 最后一次重试：切到直连兜底（Worker 故障时仍能压缩）
                var _savedUrl = null;
                if (retry === MAX_RETRIES - 1 && typeof GATEWAY_URL_FALLBACK !== 'undefined' && GATEWAY_URL !== GATEWAY_URL_FALLBACK) {
                    _savedUrl = GATEWAY_URL;
                    GATEWAY_URL = GATEWAY_URL_FALLBACK;
                    self.log('◆ Compact: last retry → fallback URL');
                }
                var result;
                try {
                    result = await self._callCompactAPI(basePrompt);
                } finally {
                    if (_savedUrl) GATEWAY_URL = _savedUrl;
                }
                if (!result || !result.parsed) throw new Error('parse_or_network_failed');
                // accumulate compression timing: networkWait(ttfb) -> red, AI processing(rest) -> green
                if (result.ttfbMs > 0 && self._floorTiming) {
                    self._floorTiming.networkMs += result.ttfbMs;
                    self._floorTiming.deepseekMs += result.totalMs - result.ttfbMs;
                }
                var parsed = result.parsed;

                // 校验产出大小：超 95% 阈值 → 产出可能被截断，重试
                var outputText = JSON.stringify(parsed);
                var outputTokens = Math.round(outputText.length / CHAR_PER_TOKEN_EST);
                if (outputTokens > COMPACT_MAX_TOKENS * 0.95) {
                    var waitMs2 = Math.min(COMPACT_RETRY_BASE_MS * Math.pow(2, retry + 1), COMPACT_RETRY_MAX_MS);
                    self.log('⚠ Compact output near limit (~' + outputTokens + ' tok > ' + Math.round(COMPACT_MAX_TOKENS * 0.95) + '), retry #' + (retry + 1) + ' in ' + (waitMs2 / 1000) + 's');
                    try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('⚠️ 压缩产出超限，第' + (retry + 1) + '次重试...', { type: 'warning', duration: Math.min(waitMs2, 5000) }); } catch (_) { }
                    await new Promise(function (r) { setTimeout(r, waitMs2); });
                    // 加强约束
                    basePrompt = 'YOUR PREVIOUS OUTPUT WAS TOO LARGE AND MAY HAVE BEEN TRUNCATED.\nYOU MUST PRODUCE AN OUTPUT THAT IS AT MOST HALF THE SIZE.\nBE MORE AGGRESSIVE IN MERGING AND DROPPING LOW-VALUE FACTS.\n\n' + basePrompt;
                    continue;
                }

                // 存储（含 Jaccard 关键词去重：≥0.7 覆盖旧事实）
                if (parsed.facts && Array.isArray(parsed.facts)) {
                    for (var fi = 0; fi < parsed.facts.length; fi++) {
                        parsed.facts[fi].floor = self._ctx.totalFloors;
                        var _nk = (parsed.facts[fi].keywords || []).map(function (k) { return k.toLowerCase(); });
                        var _merged = false;
                        for (var ej = 0; ej < self._ctx.facts.length; ej++) {
                            var _ek = (self._ctx.facts[ej].keywords || []).map(function (k) { return k.toLowerCase(); });
                            var _intersect = 0;
                            var _union = new Set();
                            for (var ik = 0; ik < _nk.length; ik++) { _union.add(_nk[ik]); }
                            for (var jk = 0; jk < _ek.length; jk++) { _union.add(_ek[jk]); if (_nk.indexOf(_ek[jk]) >= 0) _intersect++; }
                            if (_union.size > 0 && (_intersect / _union.size) >= 0.7) {
                                self._ctx.facts[ej] = parsed.facts[fi];
                                _merged = true;
                                break;
                            }
                        }
                        if (!_merged) {
                            self._ctx.facts.push(parsed.facts[fi]);
                        }
                    }
                    if (self._ctx.facts.length > MAX_FACTS)
                        self._ctx.facts = self._ctx.facts.slice(-MAX_FACTS);
                }
                if (parsed.narrative) {
                    self._ctx.narrative = parsed.narrative;
                }
                self.log('◆ Context: +' + (parsed.facts ? parsed.facts.length : 0) + ' facts, narrative=' + self._ctx.narrative.length + 'c, total facts=' + self._ctx.facts.length + ', q=' + outputTokens + 'tok');
                return;

            } catch (err) {
                // 用户主动停止 → 立即终止，不重试
                if (err && err.name === 'AbortError') throw err;
                var waitMs3 = Math.min(COMPACT_RETRY_BASE_MS * Math.pow(2, retry + 1), COMPACT_RETRY_MAX_MS);
                var attemptNum = retry + 1;
                self.log('✗ Compact failed #' + attemptNum + ': ' + (err.message || err) + ', retry in ' + (waitMs3 / 1000) + 's');
                try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('⚠️ 压缩失败 (' + attemptNum + '/3)，' + (waitMs3 / 1000) + 's 后重试...', { type: 'warning', duration: Math.min(waitMs3, 5000) }); } catch (_) { }
                if (retry < MAX_RETRIES - 1) {
                    await new Promise(function (r) { setTimeout(r, waitMs3); });
                }
                // 最后一次失败 → 抛出，让上层跳过压缩
            }
        }
        throw new Error('compress_failed_after_' + MAX_RETRIES + '_retries');
    };

    // ═══ 调用 API 做精简（非流式，复用 gateway） ═══
    AgentLoop.prototype._callCompactAPI = async function (prompt) {
        var self = this;
        var _fetchStart = performance.now();

        var token = '';
        try { token = localStorage.getItem('qqq-ai-token') || ''; } catch (_) { }

        if (!token || typeof GATEWAY_URL === 'undefined') {
            return { parsed: null, ttfbMs: 0, totalMs: 0 };
        }

        // ★ 独立超时（30s）：防 fetch 永久悬挂
        //    合并用户 abort + 超时 abort，任一触发即取消 fetch
        var COMPACT_TIMEOUT_MS = 30000;
        var _timeoutCtrl = new AbortController();
        var _timeoutId = setTimeout(function () { _timeoutCtrl.abort(); }, COMPACT_TIMEOUT_MS);
        var _userSignal = self.abortController ? self.abortController.signal : null;
        // 合并两个 signal：任一 abort 都传播到 timeoutCtrl
        var _onUserAbort = function () { _timeoutCtrl.abort(); };
        if (_userSignal) {
            if (_userSignal.aborted) { _timeoutCtrl.abort(); }
            else { _userSignal.addEventListener('abort', _onUserAbort, { once: true }); }
        }

        try {
            var resp = await fetch(GATEWAY_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                signal: _timeoutCtrl.signal,
                body: JSON.stringify({
                    model: 'flash',
                    messages: [
                        { role: 'system', content: 'You are a context compression engine. Extract structured facts and update narrative. Output ONLY valid JSON \u2014 no markdown, no explanation. Be concise and precise. Your output MUST fit within the token budget.' },
                        { role: 'user', content: prompt }
                    ],
                    stream: false,
                    thinking: { type: 'enabled' },
                    reasoning_effort: 'max',
                    max_tokens: COMPACT_MAX_TOKENS,
                    floor_id: self._floorId || ''
                })
            });

            var _ttfbMs = performance.now() - _fetchStart;
            if (!resp.ok) return { parsed: null, ttfbMs: _ttfbMs, totalMs: _ttfbMs };

            var data = await resp.json();
            var _totalMs = performance.now() - _fetchStart;
            if (!data) return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };

            var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (!text) return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };

            var match = text.match(/\{[\s\S]*\}/);
            if (!match) return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };

            return { parsed: JSON.parse(match[0]), ttfbMs: _ttfbMs, totalMs: _totalMs };
        } catch (err) {
            var _totalMs = performance.now() - _fetchStart;
            // AbortError: 区分用户停止 vs 超时
            if (err && err.name === 'AbortError') {
                // 用户主动停止 → 不重试，立即向上抛出让 while 循环终止
                if (_userSignal && _userSignal.aborted) {
                    clearTimeout(_timeoutId);
                    if (_userSignal) _userSignal.removeEventListener('abort', _onUserAbort);
                    throw err;  // 重新抛出，终止重试链
                }
                // 纯超时 → 返回失败，让上层重试
                return { parsed: null, ttfbMs: _totalMs, totalMs: _totalMs, aborted: true };
            }
            return { parsed: null, ttfbMs: _totalMs, totalMs: _totalMs };
        } finally {
            clearTimeout(_timeoutId);
            if (_userSignal) _userSignal.removeEventListener('abort', _onUserAbort);
        }
    };// ═══ 构建动态上下文（注入到 API 消息末尾） ═══
    AgentLoop.prototype._buildDynamicContext = function (currentQuery) {
        var ctx = '[DYNAMIC CONTEXT]\n';
        if (this._ctx.narrative) {
            ctx += 'CONVERSATION CONTEXT (compressed history):\n' + this._ctx.narrative;
        }
        if (currentQuery && this._ctx.facts.length > 0) {
            var relevant = this._retrieveRelevantFacts(currentQuery, 10);
            if (relevant.length > 0) {
                var factsBlock = relevant.map(function (f) {
                    return '- [' + f.type + '] ' + f.content;
                }).join('\n');
                ctx += '\n\nRELEVANT FACTS FROM EARLIER (' + relevant.length + '/' + this._ctx.facts.length + ' total):\n' + factsBlock;
            }
        }
        return ctx.trim() ? ctx : '';
    };

    // ═══ 关键词检索相关事实 ═══
    AgentLoop.prototype._retrieveRelevantFacts = function (query, maxFacts) {
        if (this._ctx.facts.length === 0) return [];
        maxFacts = maxFacts || 10;
        var queryTokens = query.toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff_./\\-]/g, ' ')
            .split(/\s+/)
            .filter(function (t) { return t.length > 1; });
        var scored = this._ctx.facts.map(function (fact) {
            var score = 0;
            var factText = (fact.content + ' ' + (fact.keywords || []).join(' ')).toLowerCase();
            for (var ti = 0; ti < queryTokens.length; ti++) {
                if (factText.indexOf(queryTokens[ti]) !== -1) score += 2;
            }
            score += (fact.floor || 0) / Math.max(1, this._ctx.totalFloors) * 0.5;
            return { fact: fact, score: score };
        }.bind(this));
        scored.sort(function (a, b) { return b.score - a.score; });
        return scored.filter(function (s) { return s.score > 0; }).slice(0, maxFacts).map(function (s) { return s.fact; });
    };

})();
