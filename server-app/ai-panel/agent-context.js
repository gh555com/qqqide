// ============================================================================
// agent-context.js — 上下文压缩引擎（三专家并行，tier 4 纯文本，原子操作）
// VER: COMPACT-V5-20260710  ← V5: preserve tool_calls + tool_call_id in cold messages
//
// 核心机制：
//   1. _compressContext() — 阻塞式压缩，带快照
//   2. _digestColdMessages() — 三专家 Promise.all 并行
//      ① Narrative  ② Facts  ③ Archive
//   3. _buildDynamicContext() — 注入叙事 + 事实到上下文
//
// 铁律：
//   - COMPACT_TIER = 4 锁死
//   - Promise.all 并行，任一失败→整体回滚（_ctx 全部字段恢复）
//   - 回滚包括 conversation splice
//   - 压缩前自动打快照到 qqq/logs/
//   - 全部纯文本，零 JSON
// ============================================================================

; (function () {
    'use strict';

    var COMPACT_VERSION = 'COMPACT-V6-20260710';  // ★ V6: reduce cold msgs, more aggressive caps, prefix message

    // ═══ 常量 ═══
    var COMPACT_TIER      = 4;
    var TOOL_CAP          = 2000;   // ↓ V6: 6k→2k, tool results truncated harder
    var MSG_CAP           = 8000;   // ↓ V6: 10k→8k
    var KEEP_RATIO        = 0.1;
    var MIN_FLOORS        = 4;      // ↓ V6: 6→4
    var MIN_MANUAL_TOKENS = 50000;
    var COMPACT_RETRY_BASE_MS = 2000;
    var MAX_COMPACT_RETRIES    = 2;

    // 质量门槛
    var NARR_MIN_CHARS     = 5000;
    var NARR_SHRINK_RATIO  = 0.5;
    var FACTS_MIN_COUNT    = 10;
    var ARCH_MIN_FLOORS    = 0.7;

    var CHAR_PER_TOKEN_EST = (typeof ContentGateway !== 'undefined' ? ContentGateway.CHAR_PER_TOKEN : 2.5);
    var COMPACT_MAX_TOKENS = (typeof ContentGateway !== 'undefined' && ContentGateway.COMPACT_MAX_TOKENS) ? ContentGateway.COMPACT_MAX_TOKENS : 65536;
    var ARCHIVE_MAX_CHARS  = (typeof ContentGateway !== 'undefined' ? ContentGateway.ARCHIVE_MAX_CHARS : 1000000);
    var COMPACT_DEBUG      = true;  // 测试期强制开

    // ═══ 快照工具 ═══
    function _snapshotContext(self, label) {
        if (!COMPACT_DEBUG) return;
        var _snap = {
            ts: new Date().toISOString(),
            version: COMPACT_VERSION,
            label: label,
            quest: self._questId || '?',
            floor: self._floorId || '?',
            totalFloors: self._ctx ? self._ctx.totalFloors : 0,
            conversationLen: (self.conversation || []).length,
            estimatedTokens: self._estimateTotalTokens ? self._estimateTotalTokens() : 0,
            apiPromptTokens: self._lastApiPromptTokens || 0,
            ctx: {
                narrativeLen: (self._ctx && self._ctx.narrative ? self._ctx.narrative.length : 0),
                factsCount: (self._ctx && self._ctx.facts ? self._ctx.facts.length : 0),
                archivesCount: (self._ctx && self._ctx.floorArchives ? self._ctx.floorArchives.length : 0),
                lastCompressedFloor: self._ctx ? self._ctx.lastCompressedFloor : 0
            },
            persistentCount: self._persistentCount || 0
        };
        try {
            var _logPath = ((typeof parent !== 'undefined' && parent.__qqq_workspaceRoot) || '') + '/qqq/logs';
            // Write via bridge if available, else try direct fs (for Node.js test env)
            var _jsonLine = JSON.stringify(_snap) + '\n';
            if (typeof parent !== 'undefined' && parent.window && parent.window.qqqideBridge && parent.window.qqqideBridge.fs) {
                parent.window.qqqideBridge.fs.appendFile(_logPath + '/compress-snap.jsonl', _jsonLine).catch(function(){});
            }
        } catch (_) { }
    }

    // ═══ 工具函数 ═══
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

    // ── 构建冷消息数组（V6: 激进截断 + 前缀 + 去元讨论）──
    var MAX_COLD_MSGS = 200;  // ↓ V6: 500→200, ~80K tokens max
    var TC_ARG_CAP = 500;     // ↓ V6: 2000→500, tool args truncated hard
    function _buildColdMessages(coldMsgs) {
        var _msgs = [];
        var _floorKeys = [];
        // ★ V6: 前缀 system 消息，防止模型复述压缩讨论
        _msgs.push({
            role: 'system',
            content: 'The following messages are archived IDE conversations. They document real file operations, code changes, and decisions. Extract facts and write narrative based SOLELY on the actual work done (files edited, bugs fixed, features added). DO NOT quote, repeat, or discuss the archive itself. DO NOT mention compression, prompts, or meta-analysis of these messages.'
        });
        for (var i = 0; i < coldMsgs.length && _msgs.length < MAX_COLD_MSGS; i++) {
            var m = coldMsgs[i];
            var role = m.role || 'user';
            var content = typeof m.content === 'string' ? m.content : (m.content || '');

            var _msg = { role: role };

            // ★ tool 消息：保留 tool_call_id
            if (role === 'tool' && m.tool_call_id) {
                _msg.tool_call_id = m.tool_call_id;
                if (typeof m.name === 'string') _msg.name = m.name;
                if (content.length > TOOL_CAP) {
                    content = content.slice(0, TOOL_CAP / 2) + '\n...[trunc ' + (content.length - TOOL_CAP) + 'c]...\n' + content.slice(-TOOL_CAP / 2);
                }
                _msg.content = content;
            }
            // ★ assistant 消息：保留 tool_calls（激进截断 arguments，只留函数名）
            else if (role === 'assistant' && m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                _msg.content = content || null;
                _msg.tool_calls = m.tool_calls.map(function(tc) {
                    var _tc = { id: tc.id, type: tc.type || 'function' };
                    if (tc.function) {
                        _tc.function = { name: tc.function.name };
                        var args = tc.function.arguments || '';
                        var argsStr = typeof args === 'string' ? args : JSON.stringify(args);
                        // ★ V6: 只保留参数的首 500 chars（文件名+关键路径，丢弃大部参数）
                        _tc.function.arguments = argsStr.length > TC_ARG_CAP
                            ? argsStr.slice(0, TC_ARG_CAP)
                            : argsStr;
                    }
                    return _tc;
                });
            }
            // ★ 普通消息
            else {
                if (typeof content === 'string' && content.length > MSG_CAP) {
                    content = content.slice(0, MSG_CAP / 2) + '\n...[trunc]...\n' + content.slice(-MSG_CAP / 2);
                }
                _msg.content = content || '';
            }

            _msgs.push(_msg);
            var _fn = m._floor || 0;
            if (_floorKeys.indexOf(_fn) < 0) _floorKeys.push(_fn);
        }
        _floorKeys.sort(function(a,b){return a-b;});
        return { messages: _msgs, floorKeys: _floorKeys, count: _floorKeys.length };
    }

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
    // _callCompactAPI — messages 是完整数组 [{role,content},...]，最后一条是指令
    // ════════════════════════════════════════════════
    AgentLoop.prototype._callCompactAPI = async function (messages, suffix, maxTokens, opts) {
        var self = this;
        opts = opts || {};
        var _fetchStart = performance.now();
        var _suffix = suffix || '';
        var _maxTokens = maxTokens || COMPACT_MAX_TOKENS;
        var _sysPrompt = opts.systemPrompt || '';

        // 构建完整 messages 数组（如果有 systemPrompt，prepend）
        var _fullMsgs = [];
        if (_sysPrompt) _fullMsgs.push({ role: 'system', content: _sysPrompt });
        for (var _mi = 0; _mi < messages.length; _mi++) {
            _fullMsgs.push(messages[_mi]);
        }

        try {
            var resp = await AiGateway.chatFetch({
                tier: COMPACT_TIER,
                messages: _fullMsgs,
                stream: true,
                thinking: { type: 'disabled' },
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
    // _compressContext — 阻塞式上下文压缩（带快照）
    // ════════════════════════════════════════════════
    AgentLoop.prototype._compressContext = async function (reason) {
        var self = this;

        if (self._stopCtrl && self._stopCtrl.signal.aborted) {
            return { compressed: false, detail: '用户已停止', beforeTokens: 0, afterTokens: 0, elapsedMs: 0 };
        }

        var totalEst = self._estimateTotalTokens();
        var dsTokens = self._lastApiPromptTokens || 0;
        var beforeTokens = Math.max(totalEst, dsTokens);
        var _force = reason && reason.force;
        var _budget = _readCompressThreshold();

        if (!_force) {
            if (totalEst <= _budget && dsTokens <= _budget) {
                return { compressed: false, detail: '无需压缩', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
            }
        } else {
            if (beforeTokens < MIN_MANUAL_TOKENS) {
                return { compressed: false, detail: '上下文仅 ' + Math.round(beforeTokens / 1000) + 'k，未达门槛', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
            }
        }

        // ── 快照：压缩前 ──
        _snapshotContext(self, 'before');

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
            self.log('\u25C6 Context: all hot, nothing to compress');
            return { compressed: false, detail: '所有楼层都在热点区', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        var coldMsgs = self.conversation.slice(0, hotStart);
        var coldTokenEst = self._estimateTotalTokens(coldMsgs);
        if (coldTokenEst < 500) {
            return { compressed: false, detail: '冷消息不足 500 tokens', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        var _compressStart = performance.now();
        self.log('\u25C6 Context: compress ' + coldMsgs.length + ' msgs (~' + Math.round(coldTokenEst) + 'tok), keep ' + floorCount + ' floors');

        // ★ 深拷贝 _ctx 用于完整回滚
        var _oldCtx = {};
        var _ctxKeys = ['facts', 'narrative', 'floorArchives', 'lastCompressedFloor', 'totalFloors'];
        for (var _ki = 0; _ki < _ctxKeys.length; _ki++) {
            var _k = _ctxKeys[_ki];
            _oldCtx[_k] = self._ctx[_k];
        }
        // facts 和 floorArchives 是数组，深拷贝
        _oldCtx.facts = (_oldCtx.facts || []).slice();
        _oldCtx.floorArchives = (_oldCtx.floorArchives || []).slice();
        // conversation 不在此处 splice（失败时不动，成功时才 splice）

        try {
            await self._digestColdMessages(coldMsgs, _oldCtx.lastCompressedFloor || 0);
            // 全成功 → splice conversation
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

            // ── 快照：压缩后 ──
            _snapshotContext(self, 'after');

            self.log('\u25C6 Context: done — ' + self.conversation.length + ' msgs kept, saved ' + Math.round(_saved / 1000) + 'k');
            return {
                compressed: true,
                detail: '压缩 ' + coldMsgs.length + ' 条消息 → ' + self.conversation.length + ' 条保留\n上下文: ' + Math.round(beforeTokens / 1000) + 'k → ' + Math.round(_afterEst / 1000) + 'k (节省 ' + Math.round(_saved / 1000) + 'k)\nFacts: ' + self._ctx.facts.length + ' 条 | Narrative: ' + (self._ctx.narrative ? self._ctx.narrative.length : 0) + ' chars\n耗时: ' + (_elapsed / 1000).toFixed(1) + 's',
                beforeTokens: beforeTokens, afterTokens: _afterEst, elapsedMs: _elapsed
            };
        } catch (digestErr) {
            // ★ 完整恢复 _ctx
            for (var _kj2 = 0; _kj2 < _ctxKeys.length; _kj2++) {
                var _k2 = _ctxKeys[_kj2];
                self._ctx[_k2] = _oldCtx[_k2];
            }
            // 恢复数组引用（防 slice 引用丢失）
            self._ctx.facts = _oldCtx.facts;
            self._ctx.floorArchives = _oldCtx.floorArchives;
            // conversation 没有 splice，无需恢复

            if (digestErr && digestErr.name === 'AbortError') throw digestErr;

            // ── 快照：失败后（应该等于 before）──
            _snapshotContext(self, 'after_fail_rolled_back');

            var _elapsed2 = Math.round(performance.now() - _compressStart);
            self.log('\u2717 Context: compress FAILED — ' + (digestErr.message || digestErr) + ' — rolled back');
            return {
                compressed: false,
                detail: '压缩失败: ' + (digestErr.message || '未知错误') + '\n已回滚，消息未丢失\n耗时: ' + (_elapsed2 / 1000).toFixed(1) + 's',
                beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: _elapsed2
            };
        }
    };

    // ════════════════════════════════════════════════
    // _digestColdMessages — 三专家并行
    // ★ V4: 冷消息作为真实 messages 数组发送（缓存友好），指令放在最后一条 user
    // ════════════════════════════════════════════════
    AgentLoop.prototype._digestColdMessages = async function (coldMsgs, lastCompressedFloor) {
        var self = this;
        var _cold = _buildColdMessages(coldMsgs);
        var _coldMsgs = _cold.messages;
        var _floorKeys = _cold.floorKeys;
        if (_coldMsgs.length === 0) throw new Error('coldMsgs_empty');

        var _oldNarrative = self._ctx.narrative || '';
        var _oldArchives = (self._ctx.floorArchives || []).slice();
        var _nfc = _floorKeys.length;
        self._log('  ║ coldMsgs: ' + _coldMsgs.length + ' msgs, ' + _nfc + ' floors → 3 experts (tier ' + COMPACT_TIER + ', v=' + COMPACT_VERSION + ')');

        // ════════════ 三条最后指令（三位专家的任务描述）════════════
        var _narrInstruction = [
            '以上就是全部' + _nfc + '层对话。',
            '请为每一层写详细的历史记录。严格按以下格式输出：',
            '',
            '--- 第1层 ---',
            '[本层的详细历史记录，2000-4000字]',
            '--- 第2层 ---',
            '[本层的详细历史记录，2000-4000字]',
            '（以此类推，共' + _nfc + '层）',
            '',
            '硬性要求：',
            '- 总字数不少于' + (_nfc * 2000) + '字',
            '- 每一层详细描述：用户提了什么需求、AI操作了哪些文件、做了什么决定、遇到什么错误',
            '- 必须是叙述性文字，不要列点',
            '- 不要任何引言或结尾，直接从"--- 第1层 ---"开始',
            '',
            '已有历史记录：' + (_oldNarrative || '（无 — 首次压缩）')
        ].join('\n');

        var _factsInstruction = [
            '以上就是全部' + _nfc + '层对话。',
            '请从中提取所有关键事实。每条事实独立一行。',
            '',
            '严格按此格式（每行一条）：',
            '类型:文件 | 内容:shell/wq-ping.ts是新建的统计上报模块 | 关键词:wq-ping.ts,统计上报,Electron',
            '类型:决策 | 内容:在线人数改为fetch轮询而非EventSource | 关键词:fetch,EventSource,在线人数',
            '类型:错误 | 内容:boot.ts第239行双花括号语法错误导致构建失败 | 关键词:boot.ts,语法错误,esbuild',
            '',
            '类型只能是：文件/决策/错误/代码改动/偏好/目标/阻碍/上下文',
            '至少25条。不要引言、不要结尾。每行直接以"类型:"开头。'
        ].join('\n');

        var _archiveInstruction = [
            '以上就是全部' + _nfc + '层对话。',
            '请为每一层写一句话摘要。严格按此格式：',
            '',
            '第1层: [一句话摘要]',
            '第2层: [一句话摘要]',
            '（以此类推，共' + _nfc + '行）',
            '',
            '不要引言，不要结尾。每行直接以"第N层:"开头。'
        ].join('\n');

        // ════════════ Promise.all 并行（三专家共用冷消息前缀）════════════
        var _narrResult = null, _factsResult = null, _archiveResult = null;
        var _expertStart = performance.now();
        try {
            var _results = await Promise.all([
                _retryCompact(self, 'Narrative', function() {
                    var _msgs = _coldMsgs.slice();
                    _msgs.push({ role: 'user', content: _narrInstruction });
                    return self._callCompactAPI(_msgs, ':narr', COMPACT_MAX_TOKENS,
                        { systemPrompt: '你是历史记录者。按格式输出，不要引言。' });
                }),
                _retryCompact(self, 'Facts', function() {
                    var _msgs = _coldMsgs.slice();
                    _msgs.push({ role: 'user', content: _factsInstruction });
                    return self._callCompactAPI(_msgs, ':facts', 32768,
                        { systemPrompt: '你是事实提取器。按格式输出，不要引言。' });
                }),
                _retryCompact(self, 'Archive', function() {
                    var _msgs = _coldMsgs.slice();
                    _msgs.push({ role: 'user', content: _archiveInstruction });
                    return self._callCompactAPI(_msgs, ':archive', 32768,
                        { systemPrompt: '你是摘要器。按格式输出，不要引言。' });
                })
            ]);
            _narrResult = _results[0];
            _factsResult = _results[1];
            _archiveResult = _results[2];
        } catch (_parallelErr) {
            self._log('✗ Three-expert parallel FAILED — ' + (_parallelErr.message || _parallelErr));
            throw new Error('three_expert_failed');
        }
        var _expertMs = performance.now() - _expertStart;

        // ════════════ 校验产出 ════════════
        if (!_narrResult || !_narrResult.text) throw new Error('narrative_empty');
        if (!_factsResult || !_factsResult.text) throw new Error('facts_empty');
        if (!_archiveResult || !_archiveResult.text) throw new Error('archive_empty');

        var _newNarrative = _narrResult.text.trim();
        var _factsText = _factsResult.text.trim();
        var _archiveText = _archiveResult.text.trim();
        self._log('  ◆ Narrative: ' + _newNarrative.length + 'c | Facts raw: ' + _factsText.length + 'c | Archive: ' + _archiveText.length + 'c');

        // ── 叙事处理 ──
        if (_oldNarrative && _newNarrative.length < _oldNarrative.length * NARR_SHRINK_RATIO) {
            self.log('⚠ narrative shrunk, rebuilding from archives...');
            var _rebuilt = await self._rebuildNarrativeFromArchives();
            if (_rebuilt) _newNarrative = _rebuilt;
        }
        self._ctx.narrative = _newNarrative;

        // ── 事实解析（多策略，容忍不同模型输出格式）──
        var _parsedFacts = [];
        var _lines = _factsText.split('\n');
        for (var li = 0; li < _lines.length; li++) {
            var _line = _lines[li].trim();
            if (!_line) continue;
            // 策略1: 类型:文件 | 内容:... | 关键词:...
            var _fm = _line.match(/^类型[:：](.+?)\s*\|\s*内容[:：](.+?)(?:\s*\|\s*关键词[:：](.+))?$/);
            if (_fm) {
                _parsedFacts.push({ type: _fm[1].trim(), content: _fm[2].trim(),
                    keywords: _fm[3] ? _fm[3].split(/[,，]/).map(function(k){return k.trim();}).filter(Boolean) : [],
                    floor: self._ctx.totalFloors });
                continue;
            }
            // 策略2: [类型] 内容 ||| 关键词
            var _fm2 = _line.match(/^\[([^\]]+)\]\s*(.+?)(?:\s*\|\|\|\s*(.+))?$/);
            if (_fm2 && _fm2[2].length > 5) {
                _parsedFacts.push({ type: _fm2[1].trim(), content: _fm2[2].trim(),
                    keywords: _fm2[3] ? _fm2[3].split(/[,，]/).map(function(k){return k.trim();}).filter(Boolean) : [],
                    floor: self._ctx.totalFloors });
                continue;
            }
            // 策略3: - **类型**: 内容
            var _fm3 = _line.match(/^[-*]\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)/);
            if (_fm3 && _fm3[2].length > 10) {
                _parsedFacts.push({ type: _fm3[1].trim(), content: _fm3[2].trim(), keywords: [], floor: self._ctx.totalFloors });
                continue;
            }
            // 策略4: 数字. 内容（兜底，把有意义的长行当 fact）
            if (_line.length > 20 && _line.indexOf('类型') === -1 && _line.indexOf('格式') === -1
                && _line.indexOf('对话') === -1 && _line.indexOf('---') !== 0 && _line.indexOf('===') !== 0) {
                _parsedFacts.push({ type: 'context', content: _line.slice(0, 300), keywords: [], floor: self._ctx.totalFloors });
            }
        }
        // 保存 raw text 供排查
        self._lastRawFactsText = _factsText;
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
                        for (var _ki3 = 0; _ki3 < _fKw.length; _ki3++) { if (_gKw.indexOf(_fKw[_ki3]) >= 0) _kwOverlap++; }
                        if (_kwOverlap / Math.min(_fKw.length, _gKw.length) > 0.5) {
                            _merged.content = _merged.content + ' | ' + _g.content;
                            for (var _kj3 = 0; _kj3 < _gKw.length; _kj3++) {
                                if (_merged.keywords.indexOf(_gKw[_kj3]) < 0) _merged.keywords.push(_gKw[_kj3]);
                            }
                            _mergedIdx.push(fj);
                        }
                    }
                }
            }
            _mergedFacts.push(_merged);
        }
        self._ctx.facts = _mergedFacts;

        // ── Archive 解析 ──
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
        var _allArchives = _oldArchives.concat(_newArchives);
        var _totalArchChars = 0;
        for (var ai2 = _allArchives.length - 1; ai2 >= 0; ai2--) {
            _totalArchChars += JSON.stringify(_allArchives[ai2]).length;
            if (_totalArchChars > ARCHIVE_MAX_CHARS) { _allArchives = _allArchives.slice(ai2 + 1); break; }
        }
        self._ctx.floorArchives = _allArchives;

        // ════════════ 质量断言 ════════════
        var _factsAvgKw = _mergedFacts.length > 0 ? (_mergedFacts.reduce(function(s,f){return s+(f.keywords||[]).length;},0) / _mergedFacts.length) : 0;
        var _passed = _newNarrative.length >= NARR_MIN_CHARS
                   && _mergedFacts.length >= FACTS_MIN_COUNT
                   && _newArchives.length >= _floorKeys.length * ARCH_MIN_FLOORS;

        if (!_passed) {
            var _fails = [];
            if (_newNarrative.length < NARR_MIN_CHARS) _fails.push('narrative_short(' + _newNarrative.length + '<' + NARR_MIN_CHARS + ')');
            if (_mergedFacts.length < FACTS_MIN_COUNT) _fails.push('facts_few(' + _mergedFacts.length + '<' + FACTS_MIN_COUNT + ', raw=' + _factsText.length + 'c)');
            if (_newArchives.length < _floorKeys.length * ARCH_MIN_FLOORS) _fails.push('archive_low(' + _newArchives.length + '/' + _floorKeys.length + ')');
            self.log('✗ Quality FAIL: ' + _fails.join(', '));
            // ★ 保存失败的原始文本用于排查
            try {
                var _logPath2 = ((typeof parent !== 'undefined' && parent.__qqq_workspaceRoot) || '') + '/qqq/logs';
                var _failEntry = JSON.stringify({
                    ts: new Date().toISOString(), version: COMPACT_VERSION,
                    quest: self._questId, floor: self._floorId,
                    fails: _fails.join(', '),
                    narr_preview: _newNarrative.slice(0, 300),
                    facts_full: _factsText.slice(0, 3000),
                    arch_full: _archiveText.slice(0, 1000)
                }) + '\n';
                if (typeof parent !== 'undefined' && parent.window && parent.window.qqqideBridge && parent.window.qqqideBridge.fs) {
                    parent.window.qqqideBridge.fs.appendFile(_logPath2 + '/compress-fail-debug.jsonl', _failEntry).catch(function(){});
                }
            } catch (_) { }
            throw new Error('quality_failed: ' + _fails.join(', '));
        }

        // 调试埋点
        if (COMPACT_DEBUG) {
            self._compactTraces = self._compactTraces || [];
            self._compactTraces.push({
                ts: new Date().toISOString(), version: COMPACT_VERSION,
                input: { floors: (lastCompressedFloor || 0) + '→' + self._ctx.totalFloors, msgs: coldMsgs.length },
                output: { narrChars: _newNarrative.length, factsCount: _mergedFacts.length, factsAvgKw: _factsAvgKw, archCount: _newArchives.length },
                expertMs: Math.round(_expertMs)
            });
            if (self._compactTraces.length > 10) self._compactTraces = self._compactTraces.slice(-10);
        }

        self.log('◆ Context (3 experts): +' + _mergedFacts.length + ' facts, narrative=' + _newNarrative.length + 'c, archives=' + _newArchives.length);
    };

    // ════════════════════════════════════════════════
    // _rebuildNarrativeFromArchives
    // ════════════════════════════════════════════════
    AgentLoop.prototype._rebuildNarrativeFromArchives = async function () {
        var self = this;
        var _archives = self._ctx.floorArchives;
        if (!_archives || _archives.length === 0) return null;
        var _archiveLines = _archives.map(function(a) {
            return '第' + a.n + '层: ' + (a.summary || '');
        }).join('\n');
        var _msgs = [
            { role: 'user', content: [
                '根据以下楼层摘要重建完整的历史记录。',
                '为每一层写 2000-4000 字的详细叙述。',
                '格式：--- 第 N 层 --- [详细叙述]',
                '',
                '楼层摘要：',
                _archiveLines
            ].join('\n') }
        ];
        try {
            var _result = await self._callCompactAPI(_msgs, ':rebuild', COMPACT_MAX_TOKENS,
                { systemPrompt: '你是历史记录重建者。写详细叙述，不要引言。' });
            if (_result && _result.text) return _result.text.trim();
        } catch (_) { }
        return null;
    };

    // ════════════════════════════════════════════════
    // _buildDynamicContext
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
