// ============================================================================
// agent-context.js — 上下文压缩引擎
// 从 q3/ai/src/agent-context.js 移植，适配 Shell v2
//
// 核心机制：
//   1. _compressContext() — 阻塞式：token 超阈值 → 保留 10% 最近楼层（≥6层），压 90%
//   2. _digestColdMessages() — 单专家 tier 6 统一压缩（facts+narrative+archive 合一，64K max_tokens）
//   3. _buildDynamicContext() — 注入叙事 + 相关事实到 API 消息末尾
//
// 关键设计（铁律）：
//   - 压缩是打断任务：触发 → 停一切 → 等 AI 产出 → 删旧消息 → 再继续
//   - 保留边界对齐楼层（user 消息 = 楼层边界），绝不切断一条楼层
//   - 最少保留 6 层楼（当前层 + 前 5 层），即使超出 10%
//   - 单专家 = 1 次 API 调用 → 一致性天然保证，不必 cross-check
//   - 冷文本全量送入（不采样），模型 1M 窗口完全装得下
//   - facts 后处理自动合并同话题事实（keyword 重叠 >50%）
//   - 压缩失败 → 指数退避无限重试（2s/4s/8s/.../60s），永不静默丢弃0s），永不静默丢弃
//
// 依赖：GATEWAY_URL（由 system-prompt.js 提供），AgentLoop（由 agent-loop.js 提供）
// ============================================================================

; (function () {

    // ★ 压缩阈值：settings.js → QQQ_DEFAULTS → ContentGateway → 兜底 600k
    //   改默认值只改 core/defaults.js
    function _readCompressThreshold() {
        try {
            if (typeof parent !== 'undefined' && parent.window && parent.window.qqqSettings && parent.window.qqqSettings.get) {
                var k = parseInt(parent.window.qqqSettings.get('ai.compressThreshold'), 10);
                if (!isNaN(k) && k >= 100 && k <= 1000) return k * 1000;
            }
        } catch (_) { }
        try {
            if (typeof parent !== 'undefined' && parent.window && parent.window.QQQ_DEFAULTS) {
                return parent.window.QQQ_DEFAULTS['ai.compressThreshold'] * 1000;
            }
        } catch (_) { }
        if (typeof ContentGateway !== 'undefined' && ContentGateway.COMPRESS_THRESHOLD) return ContentGateway.COMPRESS_THRESHOLD;
        return 600000;
    }
    var TOKEN_BUDGET = _readCompressThreshold();
    var KEEP_RATIO = 0.1;         // 保留最近 10%
    var MIN_FLOORS = 6;           // 最少保留 6 层楼（当前层 + 前 5 层）
    var CHAR_PER_TOKEN_EST = (typeof ContentGateway !== 'undefined' ? ContentGateway.CHAR_PER_TOKEN : 2.5);
    // 单专家统一压缩（tier 6, 64K max_tokens）
    var COMPACT_MAX_TOKENS = (typeof ContentGateway !== 'undefined' && ContentGateway.COMPACT_MAX_TOKENS) ? ContentGateway.COMPACT_MAX_TOKENS : 65536;  // 64K
    var ARCHIVE_MAX_CHARS = (typeof ContentGateway !== 'undefined' ? ContentGateway.ARCHIVE_MAX_CHARS : 1000000); // ~1M charshars
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

    // ═══ conversation splice 后所有索引统一平移 ═══
    // 入口：conversation 已 splice(_persistentCount, removedCount)
    // 巡检所有持有 floorStartIdx 的地方，>= hotStart 的统一减 removedCount
    AgentLoop.prototype._shiftConversationIndices = function (removedCount, hotStart) {
        var self = this;
        if (self._floorStartIdx >= hotStart) { self._floorStartIdx -= removedCount; }
        if (self._floorMeta) {
            for (var fk in self._floorMeta) {
                if (self._floorMeta.hasOwnProperty(fk)) {
                    var fm = self._floorMeta[fk];
                    if (fm.floorStartIdx >= hotStart) { fm.floorStartIdx -= removedCount; }
                }
            }
        }
    };

    // ═══ 阻塞式上下文压缩 — 铁律 ═══
    // 规则：
    //   1. 超阈值才触发（阈值由用户设置，100-900k）
    //   2. 从末尾倒推 KEEP_TARGET tokens → 取整到楼层边界（user 消息）
    //   3. 最少保留 6 层楼，即使超出 10%
    //   4. 阻塞等待 AI 压缩（64K），成功后才删除
    //   5. 压缩失败 → 无限重试，指数退避
    // reason: { trigger: 'auto'|'manual', detail: string, force: bool }
    //   force=true → 跳过阈值检查，但要求 beforeTokens ≥ 50k
    // 返回: { compressed: true|false, detail: string, beforeTokens: number, afterTokens: number, elapsedMs: number } number }
    AgentLoop.prototype._compressContext = async function (reason) {
        var self = this;
        // ★ Stop 守卫：用户点停止后立即跳过压缩
        if (self._stopCtrl && self._stopCtrl.signal.aborted) return { compressed: false, detail: '用户已停止', beforeTokens: 0, afterTokens: 0, elapsedMs: 0 };
        var totalEst = self._estimateTotalTokens();
        // ★ 用 prompt_tokens（纯输入），不混入 completion（输出侧数字与背包无关）
        var dsTokens = self._lastApiPromptTokens || 0;
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
            // 全成功 → splice conversation + 统一平移所有索引
            var _removedCount = hotStart - self._persistentCount;
            self.conversation.splice(self._persistentCount, _removedCount);
            self._shiftConversationIndices(_removedCount, hotStart);
            self._ctx.lastCompressedFloor = self._ctx.totalFloors;
            self._lastApiPromptTokens = 0;
            self._lastApiTotalTokens = 0;
            self._lastApiCompletionTokens = 0;
            // ★ 从保留的 assistant 消息重算（不再清零，防 UI 误导）
            var _newCompTokens = 0;
            for (var _ci = self._persistentCount; _ci < self.conversation.length; _ci++) {
                if (self.conversation[_ci].role === 'assistant') {
                    _newCompTokens += self._estimateMsgTokens(self.conversation[_ci]);
                }
            }
            self._accumulatedCompletionTokens = _newCompTokens;
            var _elapsed = Math.round(performance.now() - _compressStart);
            var _afterEst = self._estimateTotalTokens();
            var _saved = beforeTokens - _afterEst;
            var _archiveNote = (_lastCompressed === 0) ? '\n📦 首次压缩，无增量归档（Archive 专家信息已在 Facts + Narrative 中）' : '\n📦 归档: ' + (self._ctx.floorArchives ? self._ctx.floorArchives.length : 0) + ' 条';
            self.log('\u25C6 Context: done — ' + coldMsgs.length + ' msgs removed, ' + self.conversation.length + ' msgs kept');
            return {
                compressed: true,
                detail: '压缩 ' + coldMsgs.length + ' 条消息 → ' + self.conversation.length + ' 条保留\n上下文: ' + Math.round(beforeTokens / 1000) + 'k → ' + Math.round(_afterEst / 1000) + 'k tokens (节省 ' + Math.round(_saved / 1000) + 'k)\nFacts: ' + self._ctx.facts.length + ' 条 | Narrative: ' + (self._ctx.narrative ? self._ctx.narrative.length : 0) + ' chars' + _archiveNote + '\n耗时: ' + (_elapsed / 1000).toFixed(1) + 's',
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

    // ═══ 单专家统一压缩 — ACID 原子操作 ═══
    //  合并 facts + narrative + archive 为一次 tier 6 API 调用（64K max_tokens）
    //  旧三专家并行架构已废弃：3 次调用产出 <3K tokens → 严重浪费，合并后一次到位
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

        // ★ 冷文本全量送入（不采样，模型有 1M token 窗口，coldText 最大 ~900K tokens ≈ 2.4M chars，完全装得下）
        self._log('  ║ coldText: ' + coldText.length + ' chars sent in full (no sampling)');

        // ── 单专家统一 prompt — Narrative-First 架构 ──
        //   1. 先写 Narrative（8K-48K chars，主记录）
        //   2. 再从 Narrative 提取 Facts（索引）
        //   3. 最后生成 Floors（每层一句摘要）
        var _existingNarrative = _oldNarrative || '(empty — this is the first compression)';
        var _unifiedPrompt = [
            'You are a context compression engine. Produce a COMPREHENSIVE compressed context in a SINGLE JSON output.',
            '',
            'Your output is the ONLY record of these conversations. If you miss something, it is lost forever.',
            'Your budget is 64K tokens. USE IT FULLY. Incomplete preservation = failure.',
            '',
            '═══════════════════════════════════════════',
            'OUTPUT ORDER — follow this exactly:',
            '  STEP 1: Write "narrative" FIRST — the master chronicle. 8000-48000 chars.',
            '  STEP 2: Extract "facts" FROM the narrative you just wrote — they are an index, not a replacement.',
            '  STEP 3: Write "floors" — one sentence per floor.',
            '',
            'OUTPUT FORMAT — pure JSON, no markdown, no explanation:',
            '{',
            '  "narrative": "...",',
            '  "facts": [{ "type":"...", "content":"...", "keywords":["k1","k2"] }],',
            '  "floors": [{ "n":<number>, "summary":"1-sentence", "keyFiles":["path"], "keyDecisions":["decision"], "errors":["error"] }]',
            '}',
            '',
            '═══════════════════════════════════════════',
            '★ NARRATIVE — PRIMARY RECORD (write FIRST, before facts):',
            '  ★ HARD MINIMUM: 8000 chars. HARD MAXIMUM: 48000 chars.',
            '  ★ Below 8000 chars = FAILURE — the record is too thin to be useful.',
            '  ★ Above 48000 chars = wasteful — you are repeating yourself.',
            '  ★ This is the master chronicle. Facts are DERIVED from it, not the other way around.',
            '  ★ Write the narrative FIRST. Only after it is complete, extract facts from it.',
            '  ★ PRESERVE EVERY sentence from existing narrative (rewording OK, dropping = FAILURE).',
            '  ★ ALLOCATION guideline for ' + coldMsgs.length + ' messages across ' + (self._ctx.totalFloors - (lastCompressedFloor || 0)) + ' new floors:',
            '    - Each floor → at least 3-5 sentences of narrative.',
            '    - Recent floors → 1-2 paragraphs each (most detailed, AI will reference these first).',
            '    - Early floors → 2-4 sentences each (context + key decisions).',
            '    - Middle floors → brief transitions (1-2 sentences) linking early decisions to recent outcomes.',
            '  ★ Track THREADS end-to-end: if a topic spans multiple floors, trace it as one continuous story.',
            '  ★ Cite exact file paths, function names, error codes. No vague hand-waving.',
            '  ★ If you have existing narrative in the EXISTING CONTEXT section below, preserve ALL of it.',
            '',
            '★ FACTS — INDEX (extract FROM the narrative you just wrote):',
            '  ★ DO NOT write facts first. Facts are extracted FROM the completed narrative.',
            '  ★ Each fact = one self-contained atomic unit from the narrative.',
            '  ★ Keywords MUST include exact file paths, function names, error codes.',
            '  ★ MERGE: same file/topic/concept → ONE fact. Overlap >50% → merge.',
            '  ★ Target 15-30 facts. Quality > quantity.',
            '  ★ FACT TYPES: file / decision / error / code_change / preference / goal / blocker / context.',
            '',
            '★ FLOORS — optional, may be empty for first compression:',
            '  ★ One record per floor: { n, summary, keyFiles, keyDecisions, errors }.',
            '',
            '═══════════════════════════════════════════',
            'EXISTING CONTEXT (must be preserved):',
            '',
            'NARRATIVE:',
            _existingNarrative,
            '',
            'FACTS (' + _oldFacts.length + ' total):',
            JSON.stringify(_oldFacts),
            '',
            '═══════════════════════════════════════════',
            'NEW CONVERSATION HISTORY (' + coldMsgs.length + ' messages, full text):',
            coldText
        ].join('\n');

        // ── 单次调用（最多 2 次重试）──
        var _result = null;
        var MAX_COMPACT_RETRIES = 2;
        for (var _retry = 0; _retry < MAX_COMPACT_RETRIES; _retry++) {
            try {
                _result = await self._callCompactAPI(_unifiedPrompt, ':unified', COMPACT_MAX_TOKENS);
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

        if (!_result) { self._log('✗ Compact unified returned null'); throw new Error('compact_unified_failed'); }
        if (!_result.parsed) { self._log('✗ Compact unified returned no parsed data (ttfb=' + _result.ttfbMs + 'ms total=' + _result.totalMs + 'ms)'); throw new Error('compact_unified_failed'); }

        var _parsed = _result.parsed;

        // ── 处理 facts ──
        var _newFacts = _parsed.facts;
        if (!_newFacts || !Array.isArray(_newFacts)) throw new Error('facts_output_invalid');
        for (var fi = 0; fi < _newFacts.length; fi++) {
            _newFacts[fi].floor = self._ctx.totalFloors;
        }
        // ★ 后处理: 合并同话题事实（相同 type + 关键词重叠 >50% → 合并为一条）
        var _mergedFacts = [];
        var _mergedIdx = [];
        for (var fi2 = 0; fi2 < _newFacts.length; fi2++) {
            if (_mergedIdx.indexOf(fi2) >= 0) continue;
            var _f = _newFacts[fi2];
            var _merged = { type: _f.type, content: _f.content, keywords: (_f.keywords || []).slice() };
            for (var fj = fi2 + 1; fj < _newFacts.length; fj++) {
                if (_mergedIdx.indexOf(fj) >= 0) continue;
                var _g = _newFacts[fj];
                if (_g.type === _f.type) {
                    var _kwOverlap = 0;
                    if ((_f.keywords || []).length > 0 && (_g.keywords || []).length > 0) {
                        for (var _ki = 0; _ki < _f.keywords.length; _ki++) {
                            if (_g.keywords.indexOf(_f.keywords[_ki]) >= 0) _kwOverlap++;
                        }
                        if (_kwOverlap / Math.min(_f.keywords.length, _g.keywords.length) > 0.5) {
                            _merged.content = _merged.content + ' | ' + _g.content;
                            for (var _kj = 0; _kj < _g.keywords.length; _kj++) {
                                if (_merged.keywords.indexOf(_g.keywords[_kj]) < 0) _merged.keywords.push(_g.keywords[_kj]);
                            }
                            _mergedIdx.push(fj);
                        }
                    }
                }
            }
            _mergedFacts.push(_merged);
        }
        if (_mergedFacts.length < _newFacts.length) {
            self._log('  ║ facts merged: ' + _newFacts.length + ' → ' + _mergedFacts.length + ' (' + (_newFacts.length - _mergedFacts.length) + ' duplicates removed)');
        }
        self._ctx.facts = _mergedFacts;

        // ── 处理 narrative ──
        var _newNarrative = _parsed.narrative;
        if (!_newNarrative || typeof _newNarrative !== 'string') throw new Error('narrative_output_invalid');
        // 首次压缩过短告警（不重试，prompt 已约束 8K-48K）
        if (!_oldNarrative && _newNarrative.length < 8000) {
            self.log('⚠ narrative below target: ' + _newNarrative.length + ' chars (target 8K-48K)');
        }
        // 缩水检测（后续压缩）
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

        // ── 处理 archives ──
        if (_parsed.floors && Array.isArray(_parsed.floors)) {
            var _archives = self._ctx.floorArchives || [];
            _archives = _archives.concat(_parsed.floors);
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

        // ★ 一致性天然保证（同一模型同一上下文），无需 cross-check 专家

        if (COMPACT_DEBUG) {
            self._compactTraces = self._compactTraces || [];
            _debugTrace.experts.unified = { ok: true, ms: _result.totalMs, factsLen: _mergedFacts.length, narrativeLen: _newNarrative.length, archiveLen: (_parsed.floors ? _parsed.floors.length : 0) };
            _debugTrace.allSucceeded = true;
            self._compactTraces.push(_debugTrace);
            if (self._compactTraces.length > 10) self._compactTraces = self._compactTraces.slice(-10);
        }

        self.log('◆ Context: +' + _mergedFacts.length + ' facts, narrative=' + _newNarrative.length + 'c, archives=' + (self._ctx.floorArchives ? self._ctx.floorArchives.length : 0));
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
            var _result = await self._callCompactAPI(_prompt, ':rebuild', COMPACT_MAX_TOKENS);
            if (_result && _result.parsed && _result.parsed.narrative) {
                return _result.parsed.narrative;
            }
        } catch (_) { }
        return null;
    };

    // ═══ 稳健 JSON 提取器（三策略降级） ═══
    // 策略1: 去 markdown 围栏后直接 parse
    // 策略2: 正则提取第一个 {…} 块（非贪婪优先，贪婪兜底）
    // 策略3: 递归括号匹配从第一个 { 到对应 }
    function _extractJsonRobust(text, suffix, self) {
        // 策略1：去掉 markdown 代码围栏后直接 JSON.parse
        var _cleaned = text.replace(/^```(?:json)?[\s\n]*/i, '').replace(/[\s\n]*```[\s\n]*$/i, '').trim();
        try {
            var _parsed = JSON.parse(_cleaned);
            if (_parsed && typeof _parsed === 'object') return _parsed;
        } catch (_) { }

        // 策略2：正则提取第一个 { ... } 块
        var _match = _cleaned.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
        if (!_match) _match = _cleaned.match(/\{[\s\S]*\}/);
        if (_match) {
            try {
                var _parsed2 = JSON.parse(_match[0]);
                if (_parsed2 && typeof _parsed2 === 'object') return _parsed2;
            } catch (_) { }
        }

        // 策略3：递归括号匹配
        var _start = _cleaned.indexOf('{');
        if (_start >= 0) {
            var _depth = 0;
            for (var i = _start; i < _cleaned.length; i++) {
                var _ch = _cleaned[i];
                if (_ch === '{') _depth++;
                else if (_ch === '}') {
                    _depth--; if (_depth === 0) {
                        try {
                            var _parsed3 = JSON.parse(_cleaned.slice(_start, i + 1));
                            if (_parsed3 && typeof _parsed3 === 'object') return _parsed3;
                        } catch (_) { }
                        break;
                    }
                }
            }
        }

        self._log('✗ Compact JSON extract failed — all 3 strategies exhausted (suffix=' + suffix + ' textLen=' + text.length + ' preview=' + text.slice(0, 400) + ')');
        return null;
    }

    // ═══ 调用 API 做精简（经 AiGateway 统一出口 §14b） ═══
    // ★ 固定 tier 6 + reasoning_effort max + thinking enabled，压缩质量优先
    AgentLoop.prototype._callCompactAPI = async function (prompt, suffix, maxTokens) {
        var self = this;
        var _fetchStart = performance.now();
        var _suffix = suffix || '';
        var _maxTokens = maxTokens || COMPACT_MAX_TOKENS;

        try {
            var resp = await AiGateway.chatFetch({
                model: 'deep',
                tier: 6,
                thinking: { type: 'enabled' },
                reasoning_effort: 'max',
                messages: [
                    { role: 'system', content: 'You are a context compression engine. Output ONLY valid JSON — no markdown, no explanation. You are the last line of defense for preserving conversation history — be thorough, not brief. Your output MUST fully utilize the available token budget. Incomplete preservation is worse than verbosity.' },
                    { role: 'user', content: prompt }
                ],
                stream: true,
                max_tokens: _maxTokens,
                floor_id: (self._floorId || 'compact') + _suffix
            }, { compact: true, keySlot: self._questKeySlot });

            var _ttfbMs = performance.now() - _fetchStart;

            if (!resp.ok) {
                var _errText = '';
                try { _errText = await resp.text(); } catch (_) { }
                self._log('✗ Compact API HTTP ' + resp.status + ': ' + _errText.slice(0, 200));
                if (typeof self._writeFileLog === 'function') self._writeFileLog('✗ Compact API HTTP ' + resp.status + ': ' + _errText.slice(0, 300));
                return { parsed: null, ttfbMs: _ttfbMs, totalMs: _ttfbMs };
            }

            // ★ Go 始终返回 SSE（即使 stream:false），逐行解析累积 delta.content
            //   同时提取 billing（扣费）和 usage（token 统计），确保压缩楼层有完整账单
            var _bodyText = await resp.text();
            var _totalMs = performance.now() - _fetchStart;
            var _lines = _bodyText.replace(/\r\n/g, '\n').split('\n');
            var _sseAccum = '';
            var _lastChunk = null;
            var _compactUsage = null;
            for (var li = 0; li < _lines.length; li++) {
                if (_lines[li].indexOf('data: ') === 0) {
                    var _d = _lines[li].slice(6);
                    if (_d === '[DONE]') continue;
                    try {
                        var _parsed = JSON.parse(_d);
                        if (_parsed.type === 'error') {
                            self._log('✗ Compact SSE error (suffix=' + _suffix + '): ' + (_parsed.message || JSON.stringify(_parsed).slice(0, 200)));
                            return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };
                        }
                        // ★ billing 事件：统一走 _processBillingEvent（与 _parseSSE 同逻辑）
                        if (_parsed.type === 'billing') {
                            self._processBillingEvent(_parsed);
                            // ★ 通知父窗口：LV/GE/免费预算 全路径事件驱动
                            try { parent.postMessage({ type: 'qqq-lv-tick', geCost: (_parsed.ge_cost || 0), freeWindow: !!_parsed.free_window }, '*'); } catch (_) { }
                            continue;
                        }
                        // ★ usage 事件：流尾精确 token 统计
                        if (_parsed.usage && _parsed.usage.prompt_tokens) {
                            _compactUsage = _parsed.usage;
                            continue;
                        }
                        _lastChunk = _parsed;
                        var _c = _parsed.choices && _parsed.choices[0] && (_parsed.choices[0].delta || _parsed.choices[0].message);
                        if (_c && typeof _c.content === 'string') _sseAccum += _c.content;
                    } catch (_) { }
                }
            }

            var text = _sseAccum;
            if (!text && _lastChunk) {
                text = _lastChunk.choices && _lastChunk.choices[0] && _lastChunk.choices[0].message && _lastChunk.choices[0].message.content || '';
            }
            if (!text) {
                self._log('✗ Compact no content (suffix=' + _suffix + ' bodyLen=' + _bodyText.length + ' lines=' + _lines.length + ')');
                return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };
            }

            var parsed = _extractJsonRobust(text, _suffix, self);
            if (!parsed) {
                return { parsed: null, ttfbMs: _ttfbMs, totalMs: _totalMs };
            }
            return { parsed: parsed, ttfbMs: _ttfbMs, totalMs: _totalMs };
        } catch (err) {
            var _totalMs = performance.now() - _fetchStart;
            if (err && err.name === 'AbortError') {
                self._log('✗ Compact API aborted (timeout/stop) suffix=' + _suffix);
            } else {
                self._log('✗ Compact API exception: ' + (err.message || err) + ' (suffix=' + _suffix + ')');
                if (typeof self._writeFileLog === 'function') self._writeFileLog('✗ Compact API exception: ' + (err.message || err) + ' suffix=' + _suffix);
            }
            return { parsed: null, ttfbMs: _totalMs, totalMs: _totalMs };
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
