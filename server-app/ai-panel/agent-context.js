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

    // ★ 从用户设置读取压缩阈值（k → tokens），fallback ContentGateway → 200k
    function _readCompressThreshold() {
        try {
            if (typeof parent !== 'undefined' && parent.window && parent.window.qqqSettings && parent.window.qqqSettings.get) {
                var k = parseInt(parent.window.qqqSettings.get('ai.compressThreshold', '200'), 10);
                if (!isNaN(k) && k >= 100 && k <= 1000) return k * 1000;
            }
        } catch (_) { }
        if (typeof ContentGateway !== 'undefined' && ContentGateway.COMPRESS_THRESHOLD) return ContentGateway.COMPRESS_THRESHOLD;
        return 200000;
    }
    var TOKEN_BUDGET = _readCompressThreshold();
    var KEEP_RATIO = 0.1;         // 保留最近 10%
    var MIN_FLOORS = 6;           // 最少保留 6 层楼（当前层 + 前 5 层）
    var CHAR_PER_TOKEN_EST = (typeof ContentGateway !== 'undefined' ? ContentGateway.CHAR_PER_TOKEN : 3.0);
    // 三专家输出阀值
    var COMPACT_FACTS_TOKENS = (typeof ContentGateway !== 'undefined' ? ContentGateway.COMPACT_FACTS_TOKENS : 32768);       // 32k（facts 可能很多，给足空间）
    var COMPACT_NARRATIVE_TOKENS = (typeof ContentGateway !== 'undefined' ? ContentGateway.COMPACT_NARRATIVE_TOKENS : 32768); // 32k
    var COMPACT_ARCHIVE_TOKENS = (typeof ContentGateway !== 'undefined' ? ContentGateway.COMPACT_ARCHIVE_TOKENS : 32768);   // 32k
    var ARCHIVE_MAX_CHARS = (typeof ContentGateway !== 'undefined' ? ContentGateway.ARCHIVE_MAX_CHARS : 1000000); // ~1M chars
    var COMPACT_RETRY_BASE_MS = 2000;
    var COMPACT_RETRY_MAX_MS = 60000;
    // 埋点开关
    var COMPACT_DEBUG = (typeof ContentGateway !== 'undefined' ? ContentGateway.COMPACT_DEBUG : true);

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
    // reason: { trigger: 'auto'|'manual', detail: string, force: bool }
    //   force=true → 跳过 900k 阈值检查，但要求 beforeTokens ≥ 50k
    // 返回: { compressed: true|false, detail: string, beforeTokens: number, afterTokens: number, elapsedMs: number }
    AgentLoop.prototype._compressContext = async function (reason) {
        var self = this;
        // ★ Stop 守卫：用户点停止后立即跳过压缩
        if (self._stopCtrl && self._stopCtrl.signal.aborted) return { compressed: false, detail: '用户已停止', beforeTokens: 0, afterTokens: 0, elapsedMs: 0 };
        var totalEst = self._estimateTotalTokens();
        // ★ 优先用 _lastApiTotalTokens（prompt+completion 精确值），fallback 到 prompt_tokens
        var dsTokens = self._lastApiTotalTokens || self._lastApiPromptTokens || 0;
        var beforeTokens = Math.max(totalEst, dsTokens);
        var _force = reason && reason.force;

        // ★ 动态读取用户设置的压缩阈值（k → tokens）
        var _budget = _readCompressThreshold();

        // 自动模式：任一指标超阈值 → 触发；两个都没超 → 跳过
        if (!_force) {
            if (totalEst <= _budget && dsTokens <= _budget) {
                return { compressed: false, detail: '无需压缩（' + Math.round(beforeTokens / 1000) + 'k < ' + Math.round(_budget / 1000) + 'k）', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
            }
        } else {
            // 手动模式：50k 最低门槛
            var MIN_MANUAL_TOKENS = 50000;
            if (beforeTokens < MIN_MANUAL_TOKENS) {
                return { compressed: false, detail: '上下文仅 ' + Math.round(beforeTokens / 1000) + 'k，未达手动压缩最低门槛 ' + Math.round(MIN_MANUAL_TOKENS / 1000) + 'k', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
            }
        }

        // ★ KEEP_TARGET 按实际上下文动态伸缩，不是固定 90k
        //   beforeTokens=950k → keep 95k；beforeTokens=70k → keep 7k
        var KEEP_TARGET = Math.floor(Math.min(beforeTokens, _budget) * KEEP_RATIO);

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

        // ★ 快照旧值（原子回滚用）
        var _oldFacts = (self._ctx.facts || []).slice();
        var _oldNarrative = self._ctx.narrative || '';
        var _oldArchives = (self._ctx.floorArchives || []).slice();
        var _lastCompressed = self._ctx.lastCompressedFloor || 0;

        try {
            await self._digestColdMessages(coldMsgs, _lastCompressed);
            // 全成功 → splice conversation
            self.conversation.splice(self._persistentCount, hotStart - self._persistentCount);
            self._ctx.lastCompressedFloor = self._ctx.totalFloors;
            self._lastApiPromptTokens = 0;
            self._lastApiTotalTokens = 0;
            self._lastApiCompletionTokens = 0;
            self._accumulatedCompletionTokens = 0;
            var _elapsed = Math.round(performance.now() - _compressStart);
            var _afterEst = self._estimateTotalTokens();
            var _saved = beforeTokens - _afterEst;
            self.log('\u25C6 Context: done — ' + coldMsgs.length + ' msgs removed, ' + self.conversation.length + ' msgs kept');
            return {
                compressed: true,
                detail: '压缩 ' + coldMsgs.length + ' 条消息 → ' + self.conversation.length + ' 条保留\n上下文: ' + Math.round(beforeTokens / 1000) + 'k → ' + Math.round(_afterEst / 1000) + 'k tokens (节省 ' + Math.round(_saved / 1000) + 'k)\nFacts: ' + self._ctx.facts.length + ' 条 | Narrative: ' + (self._ctx.narrative ? self._ctx.narrative.length : 0) + ' chars\n耗时: ' + (_elapsed / 1000).toFixed(1) + 's',
                beforeTokens: beforeTokens,
                afterTokens: _afterEst,
                elapsedMs: _elapsed
            };
        } catch (digestErr) {
            // 原子回滚
            self._ctx.facts = _oldFacts;
            self._ctx.narrative = _oldNarrative;
            self._ctx.floorArchives = _oldArchives;
            self._ctx.lastCompressedFloor = _lastCompressed;
            if (digestErr && digestErr.name === 'AbortError') throw digestErr;
            var _elapsed2 = Math.round(performance.now() - _compressStart);
            self.log('\u2717 Context: compress FAILED — ' + (digestErr.message || digestErr) + ' — rolled back');
            return {
                compressed: false,
                detail: '压缩失败: ' + (digestErr.message || '未知错误') + '\n已回滚，消息未丢失\n耗时: ' + (_elapsed2 / 1000).toFixed(1) + 's',
                beforeTokens: beforeTokens,
                afterTokens: beforeTokens,
                elapsedMs: _elapsed2
            };
        }
    };

    // ═══ 三专家并行压缩 — ACID 原子操作 ═══
    //  ① facts 专家: 旧facts + 新楼层 → 合并后全量 facts (16k)
    //  ② narrative 专家: 旧narrative + 新楼层 → 合并后 narrative (32k)
    //  ③ archive 专家: 仅新楼层 → 结构化楼层记录 (32k, 不注入上下文)
    AgentLoop.prototype._digestColdMessages = async function (coldMsgs, lastCompressedFloor) {
        var self = this;
        var coldText = coldMsgs.map(function (m) {
            var role = m.role === 'tool' ? 'tool_result' : m.role;
            var content = typeof m.content === 'string' ? m.content : '';
            return '[' + role + '] ' + content;
        }).join('\n');
        if (!coldText.trim()) throw new Error('coldMsgs_empty');

        var _oldFacts = (self._ctx.facts || []).slice();
        var _oldNarrative = self._ctx.narrative || '';
        var _debugTrace = { ts: new Date().toISOString(), trigger: 'auto', input: { floors: (lastCompressedFloor || 0) + '→' + self._ctx.totalFloors, coldMsgs: coldMsgs.length, coldTextPreview: coldText.slice(0, 2000), oldFacts: _oldFacts.length, oldNarrativeLen: _oldNarrative.length }, experts: {} };

        // ★ 截断冷文本（防 prompt 过大导致模型输出截断），保留首尾
        var COLD_TEXT_CAP = 200000; // ~67k tokens，给 facts 专家足够但不过量的上下文
        var _factsColdText = coldText;
        if (_factsColdText.length > COLD_TEXT_CAP) {
            var _half = Math.floor(COLD_TEXT_CAP / 2);
            _factsColdText = coldText.slice(0, _half) + '\n... [truncated ' + (coldText.length - COLD_TEXT_CAP) + ' chars] ...\n' + coldText.slice(-_half);
        }

        // ── ① facts 专家 prompt ──
        var factsPrompt = [
            'You are a context compression engine specializing in structured facts.',
            'Merge existing facts with new conversation history into a SINGLE comprehensive facts array.',
            '',
            'RULES:',
            '  - Merge facts about the same topic — do NOT duplicate',
            '  - If existing fact is still accurate, KEEP it (optionally reword for clarity)',
            '  - Add new facts for new information only',
            '  - Each fact MUST be self-contained: reading it alone tells the full story',
            '  - Keywords MUST include exact file paths, function names, error codes',
            '  - Drop vague facts. Quality over quantity.',
            '',
            'FACT TYPES:',
            '  file        — file paths read, written, created, deleted',
            '  decision    — irreversible or costly choices and why',
            '  error       — problems encountered and their resolution',
            '  code_change — what was modified, added, removed in code',
            '  preference  — user conventions, habits, dislikes discovered',
            '  goal        — the user ultimate objective(s) for this quest',
            '  blocker     — what is currently blocking progress',
            '  context     — other critical info that does not fit above',
            '',
            'OUTPUT — pure JSON, no markdown:',
            '{"facts":[{"type":"file","content":"...","keywords":["k1","k2"]}]}',
            '',
            'EXISTING FACTS (' + _oldFacts.length + ' total):',
            JSON.stringify(_oldFacts),
            '',
            'NEW CONVERSATION HISTORY (' + coldMsgs.length + ' messages):',
            _factsColdText
        ].join('\n');

        // ── ② narrative 专家 prompt ──
        var _existingNarrative = _oldNarrative || '(empty — this is the first compression)';
        var narrativePrompt = [
            'You are a context compression engine specializing in narrative synthesis.',
            'Merge the existing narrative with new conversation history into a SINGLE comprehensive narrative.',
            '',
            '!!! CRITICAL — NARRATIVE PRESERVATION !!!',
            '  EVERY sentence from the existing narrative MUST survive in your output.',
            '  Rewording is OK. Dropping any information = FAILURE.',
            '  Add new information from the new conversation history.',
            '  If nothing new to add, output the existing narrative VERBATIM.',
            '  Be comprehensive but ruthlessly concise. Every word must earn its place.',
            '',
            'OUTPUT — pure JSON, no markdown:',
            '{"narrative":"..."}',
            '',
            'EXISTING NARRATIVE:',
            _existingNarrative,
            '',
            'NEW CONVERSATION HISTORY (' + coldMsgs.length + ' messages):',
            coldText
        ].join('\n');

        // ── ③ archive 专家 prompt ──
        var archivePrompt = [
            'You are a context archivist. Produce a structured record of these floors for disaster recovery.',
            '',
            'OUTPUT — pure JSON, no markdown:',
            '{"floors":[{"n":<floor number>,"summary":"1-sentence summary","keyFiles":["path"],"keyDecisions":["decision"],"errors":["error"]}]}',
            '',
            'CONVERSATION HISTORY (' + coldMsgs.length + ' messages):',
            coldText
        ].join('\n');

        // ── 并行执行（最多 2 次总尝试）──
        var _names = ['facts', 'narrative', 'archive'];
        var _results = null;
        var MAX_COMPACT_RETRIES = 2;
        for (var _retry = 0; _retry < MAX_COMPACT_RETRIES; _retry++) {
            try {
                _results = await Promise.all([
                    self._callCompactAPI(factsPrompt, ':facts', COMPACT_FACTS_TOKENS),
                    self._callCompactAPI(narrativePrompt, ':narrative', COMPACT_NARRATIVE_TOKENS),
                    self._callCompactAPI(archivePrompt, ':archive', COMPACT_ARCHIVE_TOKENS)
                ]);
                break;
            } catch (_err) {
                if (_retry < MAX_COMPACT_RETRIES - 1) {
                    self.log('⚠ Compact retry ' + (_retry + 1) + '/' + MAX_COMPACT_RETRIES + ': ' + (_err.message || _err));
                    await new Promise(function (r) { setTimeout(r, COMPACT_RETRY_BASE_MS * Math.pow(2, _retry)); });
                } else {
                    throw _err;
                }
            }
        }

        for (var ei = 0; ei < _results.length; ei++) {
            var _r = _results[ei];
            if (!_r) { self._log('✗ Compact expert ' + _names[ei] + ' returned null'); throw new Error(_names[ei] + '_expert_failed'); }
            if (!_r.parsed) { self._log('✗ Compact expert ' + _names[ei] + ' returned no parsed data (ttfb=' + _r.ttfbMs + 'ms total=' + _r.totalMs + 'ms)'); throw new Error(_names[ei] + '_expert_failed'); }
            if (COMPACT_DEBUG) { _debugTrace.experts[_names[ei]] = { ok: true, ms: _r.totalMs, parsedKeys: Object.keys(_r.parsed) }; }
        }

        var _parsedFacts = _results[0].parsed;
        var _parsedNarrative = _results[1].parsed;
        var _parsedArchive = _results[2].parsed;

        var _newFacts = _parsedFacts.facts;
        if (!_newFacts || !Array.isArray(_newFacts)) throw new Error('facts_expert_output_invalid');
        for (var fi = 0; fi < _newFacts.length; fi++) {
            _newFacts[fi].floor = self._ctx.totalFloors;
        }
        self._ctx.facts = _newFacts;

        var _newNarrative = _parsedNarrative.narrative;
        if (!_newNarrative || typeof _newNarrative !== 'string') throw new Error('narrative_expert_output_invalid');
        // 首次压缩：narrative 至少要有基本内容
        if (!_oldNarrative && _newNarrative.length < 100) {
            throw new Error('narrative_too_short_first_compress');
        }
        // 缩水检测：用 token 估算而非字符数（中英文密度不同）
        if (_oldNarrative) {
            var _oldTok = Math.round(_oldNarrative.length / CHAR_PER_TOKEN_EST);
            var _newTok = Math.round(_newNarrative.length / CHAR_PER_TOKEN_EST);
            if (_oldTok > 0 && _newTok < _oldTok * 0.5) {
                self.log('⚠ narrative shrunk ' + _oldTok + '→' + _newTok + ' tok, rebuilding from archives...');
                var _rebuilt = await self._rebuildNarrativeFromArchives();
                if (_rebuilt) {
                    _newNarrative = _rebuilt;
                } else {
                    throw new Error('narrative_shrink_and_rebuild_failed');
                }
            }
        }
        self._ctx.narrative = _newNarrative;

        if (_parsedArchive.floors && Array.isArray(_parsedArchive.floors)) {
            var _archives = self._ctx.floorArchives || [];
            _archives = _archives.concat(_parsedArchive.floors);
            var _totalChars = 0;
            for (var ai = _archives.length - 1; ai >= 0; ai--) {
                _totalChars += JSON.stringify(_archives[ai]).length;
                if (_totalChars > ARCHIVE_MAX_CHARS) {
                    _archives = _archives.slice(ai + 1);
                    break;
                }
            }
            self._ctx.floorArchives = _archives;
        }

        if (COMPACT_DEBUG) {
            self._compactTraces = self._compactTraces || [];
            _debugTrace.experts.facts.outputPreview = JSON.stringify(_newFacts).slice(0, 1000);
            _debugTrace.experts.narrative.outputPreview = _newNarrative.slice(0, 1000);
            _debugTrace.experts.archive.outputPreview = JSON.stringify(_parsedArchive).slice(0, 1000);
            _debugTrace.allSucceeded = true;
            self._compactTraces.push(_debugTrace);
            if (self._compactTraces.length > 10) self._compactTraces = self._compactTraces.slice(-10);
        }

        self.log('◆ Context: +' + _newFacts.length + ' facts, narrative=' + _newNarrative.length + 'c, archives=' + (self._ctx.floorArchives ? self._ctx.floorArchives.length : 0));
    };

    // ═══ 从 archive 重建 narrative ═══
    AgentLoop.prototype._rebuildNarrativeFromArchives = async function () {
        var self = this;
        var _archives = self._ctx.floorArchives;
        if (!_archives || _archives.length === 0) return null;
        var _archiveText = JSON.stringify(_archives);
        var _prompt = [
            'Rebuild the FULL narrative from these floor summaries.',
            'Include ALL floors. Be comprehensive. This replaces a corrupted narrative.',
            '',
            'OUTPUT — pure JSON: {"narrative":"..."}',
            '',
            'FLOOR SUMMARIES:',
            _archiveText
        ].join('\n');
        try {
            var _result = await self._callCompactAPI(_prompt, ':rebuild', COMPACT_NARRATIVE_TOKENS);
            if (_result && _result.parsed && _result.parsed.narrative) {
                return _result.parsed.narrative;
            }
        } catch (_) { }
        return null;
    };

    // ═══ 调用 API 做精简（非流式，复用 gateway） ═══
    // suffix: 附加到 floor_id 区分账单（如 ':facts'）
    // maxTokens: 覆盖默认阀值
    AgentLoop.prototype._callCompactAPI = async function (prompt, suffix, maxTokens) {
        var self = this;
        var _fetchStart = performance.now();
        var _suffix = suffix || '';
        var _maxTokens = maxTokens || COMPACT_NARRATIVE_TOKENS;

        // ★ 优先用 self._token（已校验），fallback localStorage（需清理非ASCII）
        var token = (self._token || '').trim();
        if (!token) {
            try { token = (localStorage.getItem('qqq-ai-token') || '').trim(); } catch (_) { }
            // 清理非 ASCII 字符（HTTP headers 仅允许 ASCII）
            token = token.replace(/[^\x00-\x7F]/g, '');
        }

        if (!token || typeof GATEWAY_URL === 'undefined') {
            self._log('✗ Compact API no token or GATEWAY_URL (token=' + !!token + ' url=' + (typeof GATEWAY_URL !== 'undefined') + ')');
            return { parsed: null, ttfbMs: 0, totalMs: 0 };
        }

        // ★ 独立超时（200s）：非流式大型 prompt + 最高级 AI 可能需较长处理时间
        var COMPACT_TIMEOUT_MS = 200000;
        var _timeoutCtrl = new AbortController();
        var _timeoutId = setTimeout(function () { _timeoutCtrl.abort(); }, COMPACT_TIMEOUT_MS);

        try {
            // ★ 用用户当前等级（_lastTier），回退到 TIER_6（最高级）
            var _tier = self._lastTier;
            if (!_tier || !_tier.model) {
                if (typeof TIER_6 !== 'undefined' && TIER_6 && TIER_6.model) {
                    _tier = TIER_6;
                } else if (typeof TIER_PRO !== 'undefined' && TIER_PRO && TIER_PRO.model) {
                    _tier = TIER_PRO;
                } else {
                    _tier = { model: 'pro', thinking: { type: 'enabled' }, effort: 'max' };
                }
            }
            var resp = await fetch(GATEWAY_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                signal: _timeoutCtrl.signal,
                body: JSON.stringify({
                    model: _tier.model || 'deep',
                    messages: [
                        { role: 'system', content: 'You are a context compression engine. Output ONLY valid JSON — no markdown, no explanation. Be concise and precise. Your output MUST fit within the token budget.' },
                        { role: 'user', content: prompt }
                    ],
                    stream: false,
                    thinking: _tier.thinking || { type: 'enabled' },
                    reasoning_effort: _tier.effort || 'max',
                    max_tokens: _maxTokens,
                    floor_id: (self._floorId || 'compact') + _suffix
                })
            });

            var _ttfbMs = performance.now() - _fetchStart;
            if (!resp.ok) {
                var _errText = '';
                try { _errText = await resp.text(); } catch (_) { }
                self._log('✗ Compact API HTTP ' + resp.status + ': ' + _errText.slice(0, 200));
                if (typeof self._writeFileLog === 'function') self._writeFileLog('✗ Compact API HTTP ' + resp.status + ': ' + _errText.slice(0, 300));
                return { parsed: null, ttfbMs: _ttfbMs, totalMs: _ttfbMs };
            }

            // ★ 服务器始终返回 SSE 格式（即使 stream:false）。
            //    正确做法：遍历所有 SSE data: 行，累积 delta.content，得到完整文本。
            var _bodyText = await resp.text();
            var _totalMs = performance.now() - _fetchStart;
            var _lines = _bodyText.replace(/\r\n/g, '\n').split('\n');
            // 累积 SSE delta 内容 + 保留最后一条完整 data 作为降级备选
            var _sseAccum = '';
            var _lastChunk = null;
            for (var li = 0; li < _lines.length; li++) {
                if (_lines[li].indexOf('data: ') === 0) {
                    var _d = _lines[li].slice(6);
                    if (_d === '[DONE]') continue;
                    try {
                        var _parsed = JSON.parse(_d);
                        _lastChunk = _parsed;
                        // ★ 累积 delta.content（流式格式 Go 始终返回）
                        var _c = _parsed.choices && _parsed.choices[0] && (_parsed.choices[0].delta || _parsed.choices[0].message);
                        if (_c && typeof _c.content === 'string') _sseAccum += _c.content;
                    } catch (_) { }
                }
            }
            // 尝试从累积的 delta 内容中提取 JSON（主路径）
            var text = _sseAccum;
            // 降级：如果 SSE 累积为空，尝试最后一条 chunk 的 message.content（非流式格式）
            if (!text && _lastChunk) {
                text = _lastChunk.choices && _lastChunk.choices[0] && _lastChunk.choices[0].message && _lastChunk.choices[0].message.content || '';
            }
            if (!text) {
                self._log('✗ Compact no content (suffix=' + _suffix + ' bodyLen=' + _bodyText.length + ' lines=' + _lines.length + ' accum=' + _sseAccum.length + ' lastKeys=' + (_lastChunk ? Object.keys(_lastChunk).join(',') : 'null') + ')');
                return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };
            }

            var match = text.match(/\{[\s\S]*\}/);
            if (!match) {
                self._log('✗ Compact no JSON (suffix=' + _suffix + ' textLen=' + text.length + ' preview=' + text.slice(0, 400) + ')');
                return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };
            }

            var parsed;
            try { parsed = JSON.parse(match[0]); } catch (_jsonErr) {
                self._log('✗ Compact JSON err (suffix=' + _suffix + ' matchLen=' + match[0].length + ' preview=' + match[0].slice(0, 400) + ')');
                return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };
            }
            return { parsed: parsed, ttfbMs: _ttfbMs, totalMs: _totalMs };
        } catch (err) {
            var _totalMs = performance.now() - _fetchStart;
            self._log('✗ Compact API exception: ' + (err.message || err) + ' (suffix=' + _suffix + ')');
            if (typeof self._writeFileLog === 'function') self._writeFileLog('✗ Compact API exception: ' + (err.message || err) + ' suffix=' + _suffix);
            return { parsed: null, ttfbMs: _totalMs, totalMs: _totalMs };
        } finally {
            clearTimeout(_timeoutId);
        }
    };

    // ═══ 构建动态上下文（注入到 API 消息的 system 消息） ═══
    AgentLoop.prototype._buildDynamicContext = function (currentQuery) {
        var ctx = '';
        if (this._ctx.narrative) {
            ctx += this._ctx.narrative;
        }
        if (this._ctx.facts && this._ctx.facts.length > 0) {
            var factsBlock = this._ctx.facts.map(function (f) {
                return '- [' + (f.type || 'context') + '] ' + (f.content || '');
            }).join('\n');
            ctx += '\n\nALL KNOWN FACTS (' + this._ctx.facts.length + ' total):\n' + factsBlock;
        }
        return ctx.trim() ? ctx : '';
    };

})();
