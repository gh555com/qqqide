// ============================================================================
// agent-context.js — 上下文压缩引擎（三专家并行，tier 4 纯文本，原子操作）
//
// 核心机制：
//   1. _compressContext() — 阻塞式压缩：token 超阈值 → splice 旧消息 → 保留 ≥6 层
//   2. _digestColdMessages() — 三专家 Promise.all 并行：
//      ① Narrative（叙事，逐层详细记录）
//      ② Facts（事实，从原始冷文本直接提取）
//      ③ Archive（归档，逐层一句话摘要，仅用于灾难恢复）
//   3. _buildDynamicContext() — 注入叙事 + 事实到 API 消息末尾
//
// 关键设计（铁律）：
//   - tier 4 锁定，零分支零切换
//   - 全部纯文本输出（零 JSON），客户端自行解析
//   - 三专家取同一份截断冷文本（非蒸馏），任一失败 → 整体原子回滚
//   - 回滚：_ctx.facts/narrative/floorArchives 恢复旧值，conversation 不动
//   - 缩水保护：叙事 < 旧值 50% → 从 Archive 重建
//   - 压缩失败 → 指数退避无限重试（2s→4s→8s→...→60s）
//
// 依赖：ContentGateway 常量，AiGateway.chatFetch
// ============================================================================

; (function () {

    // ════════════════════════════════════════════════
    // 常量 — 改配置只改此处
    // ════════════════════════════════════════════════
    var COMPACT_TIER     = 4;       // 锁死 tier 4
    var TOOL_CAP         = 6000;    // 工具结果最大 chars（首尾各半）
    var MSG_CAP          = 10000;   // 普通消息最大 chars
    var KEEP_RATIO       = 0.1;     // 保留最近 10%
    var MIN_FLOORS       = 6;       // 最少保留层数
    var MIN_MANUAL_TOKENS = 50000;  // 手动压缩最低门槛
    var COMPACT_RETRY_BASE_MS = 2000;
    var COMPACT_RETRY_MAX_MS   = 60000;
    var MAX_COMPACT_RETRIES    = 2;

    var CHAR_PER_TOKEN_EST = (typeof ContentGateway !== 'undefined' ? ContentGateway.CHAR_PER_TOKEN : 2.5);
    var COMPACT_MAX_TOKENS = (typeof ContentGateway !== 'undefined' && ContentGateway.COMPACT_MAX_TOKENS) ? ContentGateway.COMPACT_MAX_TOKENS : 65536;
    var ARCHIVE_MAX_CHARS  = (typeof ContentGateway !== 'undefined' ? ContentGateway.ARCHIVE_MAX_CHARS : 1000000);
    var COMPACT_DEBUG      = (typeof ContentGateway !== 'undefined' ? ContentGateway.COMPACT_DEBUG : true);

    // ════════════════════════════════════════════════
    // 工具函数
    // ════════════════════════════════════════════════

    function _readCompressThreshold() {
        try {
            if (typeof parent !== 'undefined' && parent.window && parent.window.qqqSettings && parent.window.qqqSettings.get) {
                var k = parseInt(parent.window.qqqSettings.get('ai.compressThreshold'), 10);
                if (!isNaN(k) && k >= 100 && k <= 1000) return k * 1000;
            }
        } catch (_) { }
        try {
            if (typeof parent !== 'undefined' && parent.window && parent.window.qqqideDefaults) {
                return parent.window.qqqideDefaults['ai.compressThreshold'] * 1000;
            }
        } catch (_) { }
        if (typeof ContentGateway !== 'undefined' && ContentGateway.COMPRESS_THRESHOLD) return ContentGateway.COMPRESS_THRESHOLD;
        return 600000;
    }

    AgentLoop.prototype._estimateMsgTokens = function (msg) {
        if (!msg) return 0;
        var tokens = 10;
        var content = msg.content;
        if (typeof content === 'string') tokens += content.length / CHAR_PER_TOKEN_EST;
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            try { tokens += JSON.stringify(msg.tool_calls).length / CHAR_PER_TOKEN_EST; } catch (_) { }
        }
        return Math.round(tokens);
    };

    AgentLoop.prototype._estimateTotalTokens = function (msgs) {
        var msgsArr = msgs || this.conversation;
        var total = 0;
        for (var i = 0; i < msgsArr.length; i++) { total += this._estimateMsgTokens(msgsArr[i]); }
        return total;
    };

    AgentLoop.prototype._shiftConversationIndices = function (removedCount, hotStart) {
        var self = this;
        if (self._floorStartIdx >= hotStart) self._floorStartIdx -= removedCount;
        if (self._floorMeta) {
            for (var fk in self._floorMeta) {
                if (self._floorMeta.hasOwnProperty(fk)) {
                    var fm = self._floorMeta[fk];
                    if (fm.floorStartIdx >= hotStart) fm.floorStartIdx -= removedCount;
                }
            }
        }
    };

    // ════════════════════════════════════════════════
    // 构建冷文本（按楼层分组 + 截断）
    // ════════════════════════════════════════════════
    function _buildColdText(coldMsgs) {
        var _floorGroups = {};
        for (var i = 0; i < coldMsgs.length; i++) {
            var _fm = coldMsgs[i];
            var _fn = _fm._floor || 0;
            if (!_floorGroups[_fn]) _floorGroups[_fn] = [];
            _floorGroups[_fn].push(_fm);
        }
        var _floorKeys = Object.keys(_floorGroups).sort(function(a,b){return parseInt(a,10)-parseInt(b,10);});
        var _floorParts = [];
        for (var fki = 0; fki < _floorKeys.length; fki++) {
            var _fmsgs = _floorGroups[_floorKeys[fki]];
            var _parts = [];
            for (var fmi = 0; fmi < _fmsgs.length; fmi++) {
                var m = _fmsgs[fmi];
                var role = m.role === 'tool' ? 'tool_result' : m.role;
                var content = typeof m.content === 'string' ? m.content : '';
                if (role === 'tool_result' && content.length > TOOL_CAP) {
                    content = content.slice(0, TOOL_CAP / 2) + '\n...[truncated ' + (content.length - TOOL_CAP) + ' chars]...\n' + content.slice(-TOOL_CAP / 2);
                } else if (content.length > MSG_CAP) {
                    content = content.slice(0, MSG_CAP / 2) + '\n...[truncated]...\n' + content.slice(-MSG_CAP / 2);
                }
                _parts.push('[' + role + '] ' + content);
            }
            _floorParts.push('=== 第' + _floorKeys[fki] + '层 ===\n' + _parts.join('\n'));
        }
        return { text: _floorParts.join('\n\n'), floorKeys: _floorKeys, count: _floorKeys.length };
    }

    // ════════════════════════════════════════════════
    // 兜底重试包装器
    // ════════════════════════════════════════════════
    async function _retryCompact(self, label, fn) {
        for (var _r = 0; _r < MAX_COMPACT_RETRIES; _r++) {
            try { return await fn(); } catch (_e) {
                if (_r < MAX_COMPACT_RETRIES - 1) {
                    self.log('⚠ ' + label + ' retry ' + (_r + 1));
                    await new Promise(function(r2) { setTimeout(r2, COMPACT_RETRY_BASE_MS * Math.pow(2, _r)); });
                } else { throw _e; }
            }
        }
    }

    // ════════════════════════════════════════════════
    // _callCompactAPI — 统一 API 调用（纯文本模式）
    // ════════════════════════════════════════════════
    AgentLoop.prototype._callCompactAPI = async function (prompt, suffix, maxTokens, opts) {
        var self = this;
        opts = opts || {};
        var _fetchStart = performance.now();
        var _suffix = suffix || '';
        var _maxTokens = maxTokens || COMPACT_MAX_TOKENS;
        var _sysPrompt = opts.systemPrompt || '按格式输出，不写引言不写结尾。';

        try {
            var resp = await AiGateway.chatFetch({
                tier: COMPACT_TIER,
                messages: [
                    { role: 'system', content: _sysPrompt },
                    { role: 'user', content: prompt }
                ],
                stream: true,
                max_tokens: _maxTokens,
                floor_id: (self._floorId || 'compact') + _suffix
            }, { compact: true, tier: COMPACT_TIER, keySlot: self._questKeySlot });

            var _ttfbMs = performance.now() - _fetchStart;
            if (!resp.ok) {
                var _errText = '';
                try { _errText = await resp.text(); } catch (_) { }
                self._log('✗ Compact HTTP ' + resp.status + ': ' + _errText.slice(0, 200));
                return { text: null, ttfbMs: _ttfbMs, totalMs: _ttfbMs };
            }

            var _bodyText = await resp.text();
            var _totalMs = performance.now() - _fetchStart;
            var _lines = _bodyText.replace(/\r\n/g, '\n').split('\n');
            var _sseAccum = '';
            var _lastChunk = null;
            for (var li = 0; li < _lines.length; li++) {
                if (_lines[li].indexOf('data: ') !== 0) continue;
                var _d = _lines[li].slice(6);
                if (_d === '[DONE]') continue;
                try {
                    var _parsed = JSON.parse(_d);
                    if (_parsed.type === 'error') {
                        self._log('✗ Compact SSE error (' + _suffix + '): ' + (_parsed.message || '').slice(0, 200));
                        return { text: null, ttfbMs: _ttfbMs, totalMs: _totalMs };
                    }
                    if (_parsed.type === 'billing') {
                        self._processBillingEvent(_parsed);
                        try { parent.postMessage({ type: 'qqq-lv-tick', geCost: (_parsed.ge_cost || 0), freeWindow: !!_parsed.free_window }, '*'); } catch (_) { }
                        continue;
                    }
                    _lastChunk = _parsed;
                    var _c = _parsed.choices && _parsed.choices[0] && (_parsed.choices[0].delta || _parsed.choices[0].message);
                    if (_c && typeof _c.content === 'string') _sseAccum += _c.content;
                } catch (_) { }
            }

            var text = _sseAccum;
            if (!text && _lastChunk) {
                text = _lastChunk.choices && _lastChunk.choices[0] && _lastChunk.choices[0].message && _lastChunk.choices[0].message.content || '';
            }
            if (!text) {
                self._log('✗ Compact no content (' + _suffix + ')');
                return { text: null, ttfbMs: _ttfbMs, totalMs: _totalMs };
            }
            return { text: text, ttfbMs: _ttfbMs, totalMs: _totalMs };
        } catch (err) {
            var _totalMs = performance.now() - _fetchStart;
            if (err && err.name === 'AbortError') {
                self._log('✗ Compact aborted (' + _suffix + ')');
            } else {
                self._log('✗ Compact exception (' + _suffix + '): ' + (err.message || err));
            }
            return { text: null, ttfbMs: _totalMs, totalMs: _totalMs };
        }
    };

    // ════════════════════════════════════════════════
    // _compressContext — 阻塞式上下文压缩
    // ════════════════════════════════════════════════
    AgentLoop.prototype._compressContext = async function (reason) {
        var self = this;
        if (self._stopCtrl && self._stopCtrl.signal.aborted) return { compressed: false, detail: '用户已停止', beforeTokens: 0, afterTokens: 0, elapsedMs: 0 };

        var totalEst = self._estimateTotalTokens();
        var dsTokens = self._lastApiPromptTokens || 0;
        var beforeTokens = Math.max(totalEst, dsTokens);
        var _force = reason && reason.force;
        var _budget = _readCompressThreshold();

        if (!_force) {
            if (totalEst <= _budget && dsTokens <= _budget) {
                return { compressed: false, detail: '无需压缩（' + Math.round(beforeTokens / 1000) + 'k < ' + Math.round(_budget / 1000) + 'k）', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
            }
        } else {
            if (beforeTokens < MIN_MANUAL_TOKENS) {
                return { compressed: false, detail: '上下文仅 ' + Math.round(beforeTokens / 1000) + 'k，未达最低门槛 ' + Math.round(MIN_MANUAL_TOKENS / 1000) + 'k', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
            }
        }

        var KEEP_TARGET = Math.floor(Math.min(beforeTokens, _budget) * KEEP_RATIO);
        var runningTokens = 0;
        var hotStart = self.conversation.length;
        for (var i = self.conversation.length - 1; i >= 0; i--) {
            runningTokens += self._estimateMsgTokens(self.conversation[i]);
            if (runningTokens >= KEEP_TARGET) { hotStart = i; break; }
        }
        if (hotStart < self._persistentCount) hotStart = self._persistentCount;
        while (hotStart > self._persistentCount && self.conversation[hotStart].role !== 'user') hotStart--;
        var floorCount = 0;
        for (var f = hotStart; f < self.conversation.length; f++) {
            if (self.conversation[f].role === 'user' && !self.conversation[f]._persistent) floorCount++;
        }
        while (floorCount < MIN_FLOORS && hotStart > self._persistentCount) {
            hotStart--;
            if (self.conversation[hotStart].role === 'user' && !self.conversation[hotStart]._persistent) floorCount++;
        }
        while (hotStart > self._persistentCount && self.conversation[hotStart].role !== 'user') hotStart--;
        if (hotStart <= self._persistentCount) {
            self.log('\u25C6 Context: ' + floorCount + ' floors \u2192 all hot, nothing to compress');
            return { compressed: false, detail: '所有楼层都在热点区', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        var coldMsgs = self.conversation.slice(0, hotStart);
        var coldTokenEst = self._estimateTotalTokens(coldMsgs);
        if (coldTokenEst < 500) {
            return { compressed: false, detail: '冷消息不足 500 tokens', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        var _compressStart = performance.now();
        self.log('\u25C6 Context: compress ' + coldMsgs.length + ' msgs (~' + Math.round(coldTokenEst) + 'tok) \u2192 keep ' + (self.conversation.length - hotStart) + ' msgs (' + floorCount + ' floors)');

        // 快照旧值（原子回滚）
        var _oldFacts = (self._ctx.facts || []).slice();
        var _oldNarrative = self._ctx.narrative || '';
        var _oldArchives = (self._ctx.floorArchives || []).slice();
        var _lastCompressed = self._ctx.lastCompressedFloor || 0;

        try {
            await self._digestColdMessages(coldMsgs, _lastCompressed);
            var _removedCount = hotStart - self._persistentCount;
            self.conversation.splice(self._persistentCount, _removedCount);
            self._shiftConversationIndices(_removedCount, hotStart);
            self._ctx.lastCompressedFloor = self._ctx.totalFloors;
            self._lastApiPromptTokens = 0;
            self._lastApiTotalTokens = 0;
            self._lastApiCompletionTokens = 0;
            var _newCompTokens = 0;
            for (var _ci = self._persistentCount; _ci < self.conversation.length; _ci++) {
                if (self.conversation[_ci].role === 'assistant') _newCompTokens += self._estimateMsgTokens(self.conversation[_ci]);
            }
            self._accumulatedCompletionTokens = _newCompTokens;
            var _elapsed = Math.round(performance.now() - _compressStart);
            var _afterEst = self._estimateTotalTokens();
            var _saved = beforeTokens - _afterEst;
            self.log('\u25C6 Context: done — ' + self.conversation.length + ' msgs kept');
            return {
                compressed: true,
                detail: '压缩 ' + coldMsgs.length + ' 条消息 → ' + self.conversation.length + ' 条保留\n上下文: ' + Math.round(beforeTokens / 1000) + 'k → ' + Math.round(_afterEst / 1000) + 'k (节省 ' + Math.round(_saved / 1000) + 'k)\nFacts: ' + self._ctx.facts.length + ' 条 | Narrative: ' + (self._ctx.narrative ? self._ctx.narrative.length : 0) + ' chars\n耗时: ' + (_elapsed / 1000).toFixed(1) + 's',
                beforeTokens: beforeTokens, afterTokens: _afterEst, elapsedMs: _elapsed
            };
        } catch (digestErr) {
            self._ctx.facts = _oldFacts;
            self._ctx.narrative = _oldNarrative;
            self._ctx.floorArchives = _oldArchives;
            self._ctx.lastCompressedFloor = _lastCompressed;
            if (digestErr && digestErr.name === 'AbortError') throw digestErr;
            self.log('\u2717 Context: compress FAILED — ' + (digestErr.message || digestErr) + ' — rolled back');
            return {
                compressed: false,
                detail: '压缩失败: ' + (digestErr.message || '未知错误') + '\n已回滚，消息未丢失\n耗时: ' + (Math.round(performance.now() - _compressStart) / 1000).toFixed(1) + 's',
                beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: Math.round(performance.now() - _compressStart)
            };
        }
    };

    // ════════════════════════════════════════════════
    // _digestColdMessages — 三专家并行压缩
    // ════════════════════════════════════════════════
    AgentLoop.prototype._digestColdMessages = async function (coldMsgs, lastCompressedFloor) {
        var self = this;
        var _cold = _buildColdText(coldMsgs);
        var coldText = _cold.text;
        var _floorKeys = _cold.floorKeys;
        if (!coldText.trim()) throw new Error('coldMsgs_empty');

        var _oldNarrative = self._ctx.narrative || '';
        var _oldArchives = (self._ctx.floorArchives || []).slice();
        self._log('  ║ coldText: ' + coldText.length + ' chars, ' + _floorKeys.length + ' floors → 3 experts (tier ' + COMPACT_TIER + ')');

        // ════════════ 专家1: Narrative — 叙事 ════════════
        var _narrPrompt = [
            '下面有' + _floorKeys.length + '层对话。请为每一层写详细的历史记录。',
            '严格按照以下格式输出（不要任何引言或结尾，直接从第1层开始）：',
            '',
            '--- 第1层 ---',
            '本层的详细历史记录（2000-4000字）',
            '--- 第2层 ---',
            '本层的详细历史记录（2000-4000字）',
            '（以此类推，共' + _floorKeys.length + '层）',
            '',
            '硬性要求：',
            '- 总字数不少于' + (_floorKeys.length * 2000) + '字',
            '- 每一层详细描述：用户提了什么需求、AI阅读/编辑/创建了哪些文件、做了什么决定、遇到什么错误',
            '- 必须是叙述性文字，不要列点',
            '',
            '已有历史记录：',
            _oldNarrative || '（无 — 首次压缩）',
            '',
            '对话：',
            coldText
        ].join('\n');

        // ════════════ 专家2: Facts — 事实 ════════════
        var _factsPrompt = [
            '分析以下对话，提取所有关键事实。每条事实独立一行。',
            '严格按照此格式（每条一行，用 | 分隔字段）：',
            '',
            '类型:文件 | 内容:shell/wq-ping.ts是新建的统计上报模块 | 关键词:wq-ping.ts,统计上报,Electron',
            '类型:决策 | 内容:在线人数改为fetch轮询而非EventSource | 关键词:fetch,EventSource,在线人数',
            '类型:错误 | 内容:boot.ts第239行双花括号语法错误导致构建失败 | 关键词:boot.ts,语法错误,esbuild',
            '',
            '类型只能是: 文件/决策/错误/代码改动/偏好/目标/阻碍/上下文',
            '至少25条。宁可多提取，不可遗漏。每条事实必须独立、原子化。',
            '不要引言，不要结尾。直接列出事实。',
            '',
            '对话：',
            coldText
        ].join('\n');

        // ════════════ 专家3: Archive — 归档 ════════════
        var _archivePrompt = [
            '为以下' + _floorKeys.length + '层对话各写一句话摘要。',
            '严格按此格式（每层一行）：',
            '第1层: [一句话摘要]',
            '第2层: [一句话摘要]',
            '（以此类推）',
            '不要引言，不要结尾。',
            '',
            '对话：',
            coldText
        ].join('\n');

        // ════════════ Promise.all 并行 ════════════
        var _narrResult = null, _factsResult = null, _archiveResult = null;
        try {
            var _results = await Promise.all([
                _retryCompact(self, 'Narrative', function() {
                    return self._callCompactAPI(_narrPrompt, ':narr', COMPACT_MAX_TOKENS,
                        { systemPrompt: '你是一个细致的历史记录者。写详细叙述，绝不简略。用完你的全部输出预算。' });
                }),
                _retryCompact(self, 'Facts', function() {
                    return self._callCompactAPI(_factsPrompt, ':facts', 32768,
                        { systemPrompt: '你是一个事实提取器。从对话中提取关键事实，每条一行，绝不简略。' });
                }),
                _retryCompact(self, 'Archive', function() {
                    return self._callCompactAPI(_archivePrompt, ':archive', 32768,
                        { systemPrompt: '你是一个摘要器。为每层对话写一句话摘要。' });
                })
            ]);
            _narrResult = _results[0];
            _factsResult = _results[1];
            _archiveResult = _results[2];
        } catch (_parallelErr) {
            self._log('✗ Three-expert parallel FAILED — ' + (_parallelErr.message || _parallelErr));
            throw new Error('three_expert_failed: ' + (_parallelErr.message || 'unknown'));
        }

        // ════════════ 校验产出 ════════════
        if (!_narrResult || !_narrResult.text) throw new Error('narrative_empty');
        if (!_factsResult || !_factsResult.text) throw new Error('facts_empty');
        if (!_archiveResult || !_archiveResult.text) throw new Error('archive_empty');

        var _newNarrative = _narrResult.text.trim();
        var _factsText = _factsResult.text.trim();
        var _archiveText = _archiveResult.text.trim();
        self._log('  ◆ Narrative: ' + _newNarrative.length + 'c | Facts: ' + _factsText.length + 'c | Archive: ' + _archiveText.length + 'c');

        // ── 叙事：缩水检测 → 从 Archive 重建 ──
        if (_newNarrative.length < 8000) {
            self.log('⚠ narrative short: ' + _newNarrative.length + ' chars');
        }
        if (_oldNarrative && _newNarrative.length < _oldNarrative.length * 0.5) {
            self.log('⚠ narrative shrunk ' + _oldNarrative.length + '→' + _newNarrative.length + ' chars, rebuilding...');
            var _rebuilt = await self._rebuildNarrativeFromArchives();
            if (_rebuilt) { _newNarrative = _rebuilt; self.log('  ◆ Rebuilt: ' + _newNarrative.length + ' chars'); }
        }
        self._ctx.narrative = _newNarrative;

        // ── 事实解析：类型:XX | 内容:YY | 关键词:ZZ ──
        var _parsedFacts = [];
        var _lines = _factsText.split('\n');
        for (var li = 0; li < _lines.length; li++) {
            var _line = _lines[li].trim();
            if (!_line) continue;
            var _fm = _line.match(/^类型[:：](.+?)\s*\|\s*内容[:：](.+?)(?:\s*\|\s*关键词[:：](.+))?$/);
            if (_fm) {
                var _type = _fm[1].trim();
                var _content = _fm[2].trim();
                var _kws = _fm[3] ? _fm[3].split(/[,，]/).map(function(k){return k.trim();}).filter(Boolean) : [];
                if (_content) _parsedFacts.push({ type: _type, content: _content, keywords: _kws, floor: self._ctx.totalFloors });
            }
        }
        // 兜底：解析太少 → 每行当一条
        if (_parsedFacts.length < 5) {
            self.log('⚠ facts parsed only ' + _parsedFacts.length + ' — using raw lines');
            for (var lj = 0; lj < _lines.length; lj++) {
                var _rl = _lines[lj].trim();
                if (_rl && _rl.length > 10 && _rl.indexOf('类型') === -1 && _rl.indexOf('格式') === -1) {
                    _parsedFacts.push({ type: 'context', content: _rl, keywords: [], floor: self._ctx.totalFloors });
                }
            }
        }
        // 合并同话题
        var _mergedFacts = [], _mergedIdx = [];
        for (var fi = 0; fi < _parsedFacts.length; fi++) {
            if (_mergedIdx.indexOf(fi) >= 0) continue;
            var _f = _parsedFacts[fi];
            var _merged = { type: _f.type, content: _f.content, keywords: (_f.keywords || []).slice(), floor: _f.floor };
            for (var fj = fi + 1; fj < _parsedFacts.length; fj++) {
                if (_mergedIdx.indexOf(fj) >= 0) continue;
                var _g = _parsedFacts[fj];
                if (_g.type === _f.type) {
                    var _fKw = _f.keywords || [], _gKw = _g.keywords || [];
                    var _kwOverlap = 0;
                    if (_fKw.length > 0 && _gKw.length > 0) {
                        for (var _ki = 0; _ki < _fKw.length; _ki++) { if (_gKw.indexOf(_fKw[_ki]) >= 0) _kwOverlap++; }
                        if (_kwOverlap / Math.min(_fKw.length, _gKw.length) > 0.5) {
                            _merged.content = _merged.content + ' | ' + _g.content;
                            for (var _kj = 0; _kj < _gKw.length; _kj++) {
                                if (_merged.keywords.indexOf(_gKw[_kj]) < 0) _merged.keywords.push(_gKw[_kj]);
                            }
                            _mergedIdx.push(fj);
                        }
                    }
                }
            }
            _mergedFacts.push(_merged);
        }
        if (_mergedFacts.length < _parsedFacts.length) {
            self._log('  ║ facts merged: ' + _parsedFacts.length + ' → ' + _mergedFacts.length);
        }
        self._ctx.facts = _mergedFacts;

        // ── Archive 解析：第N层: 摘要 ──
        var _newArchives = [];
        var _archLines = _archiveText.split('\n');
        for (var ali = 0; ali < _archLines.length; ali++) {
            var _al = _archLines[ali].trim();
            var _am = _al.match(/^第\s*(\d+)\s*层\s*[:：]\s*(.*)/);
            if (_am) _newArchives.push({ n: parseInt(_am[1], 10), summary: _am[2].trim() });
        }
        if (_newArchives.length === 0) {
            _newArchives = [{ n: self._ctx.totalFloors, summary: _archiveText.slice(0, 500) }];
        }
        var _allArchives = (_oldArchives || []).concat(_newArchives);
        var _totalArchChars = 0;
        for (var ai2 = _allArchives.length - 1; ai2 >= 0; ai2--) {
            _totalArchChars += JSON.stringify(_allArchives[ai2]).length;
            if (_totalArchChars > ARCHIVE_MAX_CHARS) { _allArchives = _allArchives.slice(ai2 + 1); break; }
        }
        self._ctx.floorArchives = _allArchives;

        // 调试埋点
        if (COMPACT_DEBUG) {
            self._compactTraces = self._compactTraces || [];
            self._compactTraces.push({
                ts: new Date().toISOString(),
                input: { floors: (lastCompressedFloor || 0) + '→' + self._ctx.totalFloors, msgs: coldMsgs.length },
                experts: {
                    narrative: { ok: true, ms: _narrResult.totalMs, len: _newNarrative.length },
                    facts: { ok: true, ms: _factsResult.totalMs, len: _factsText.length, count: _mergedFacts.length },
                    archive: { ok: true, ms: _archiveResult.totalMs, len: _archiveText.length, count: _newArchives.length }
                }
            });
            if (self._compactTraces.length > 10) self._compactTraces = self._compactTraces.slice(-10);
        }

        self.log('◆ Context (3 experts): +' + _mergedFacts.length + ' facts, narrative=' + _newNarrative.length + 'c, archives=' + _newArchives.length);
    };

    // ════════════════════════════════════════════════
    // _rebuildNarrativeFromArchives — 从归档重建叙事
    // ════════════════════════════════════════════════
    AgentLoop.prototype._rebuildNarrativeFromArchives = async function () {
        var self = this;
        var _archives = self._ctx.floorArchives;
        if (!_archives || _archives.length === 0) return null;
        var _archiveLines = _archives.map(function(a) {
            return '第' + a.n + '层: ' + (a.summary || '');
        }).join('\n');
        var _prompt = [
            '根据以下楼层摘要重建完整的历史记录。',
            '为每一层写 2000-4000 字的详细叙述。总输出 ≥ ' + (_archives.length * 2000) + ' 字。',
            '格式 — 每层楼：',
            '--- 第 N 层 ---',
            '[详细叙述]',
            '',
            '楼层摘要：',
            _archiveLines
        ].join('\n');
        try {
            var _result = await self._callCompactAPI(_prompt, ':rebuild', COMPACT_MAX_TOKENS,
                { systemPrompt: '你是一个历史记录重建者。写详细叙述，绝不简略。' });
            if (_result && _result.text) return _result.text.trim();
        } catch (_) { }
        return null;
    };

    // ════════════════════════════════════════════════
    // _buildDynamicContext — 注入叙事 + 事实到上下文
    // ════════════════════════════════════════════════
    AgentLoop.prototype._buildDynamicContext = function () {
        var ctx = '';
        if (this._ctx.narrative) ctx += this._ctx.narrative;
        if (this._ctx.facts && this._ctx.facts.length > 0) {
            var factsBlock = this._ctx.facts.map(function(f) {
                return '- [' + (f.type || 'context') + '] ' + (f.content || '');
            }).join('\n');
            ctx += '\n\nALL KNOWN FACTS (' + this._ctx.facts.length + ' total):\n' + factsBlock;
        }
        return ctx.trim() ? ctx : '';
    };

})();
