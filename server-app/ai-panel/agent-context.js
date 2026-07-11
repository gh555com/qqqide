// ============================================================================
// agent-context.js — 上下文压缩引擎（本地机械筛，零网络调用）
// VER: COMPACT-V9-20260711  ← V9: preserve run_command output (only non-recoverable tool result)
//
// 架构（论文: 论文/qqqide 滴上下文压缩.md §3）:
//   1. 找断点 — W6 至少6层楼 + >= 10% token 重量
//   2. 原料X = 断点前所有消息
//   3. _buildCompressedBiscuit(X) → 纯文本压缩饼干（本地机械筛）
//   4. splice conversation: 移除X → 注入压缩饼干 → W6保留
//
// 铁律：
//   - 零网络调用。一切在客户端完成。
//   - 失败原子回滚（conversation + _ctx 全部字段恢复）。
//   - W6 永不压缩（至少保留最近6层原始消息）。
//   - Z（注入物）在压缩时不发送也不压缩。
// ============================================================================

; (function () {
    'use strict';

    var COMPACT_VERSION = 'COMPACT-V7-20260710';

    // ═══ 常量 ═══
    var KEEP_RATIO        = 0.1;    // W6 至少占 10% 总 token
    var MIN_FLOORS        = 4;      // W6 至少保留 4 层完整楼层
    var MIN_MANUAL_TOKENS = 50000;
    var CHAR_PER_TOKEN_EST = (typeof ContentGateway !== 'undefined' ? ContentGateway.CHAR_PER_TOKEN : 2.5);

    // ═══ 工具返回摘要规则（方案三 §4）═══
    var TOOL_SUMMARIES = {
        read_file: function(args, result) {
            // result 开头可能是 "[paginated X-Y of Z lines]"
            if (typeof result === 'string') {
                var pm = result.match(/\[paginated (\d+)-(\d+) of (\d+) lines\]/);
                if (pm) return 'L:' + pm[1] + '-' + pm[2] + '/' + pm[3];
                return result.length + 'c';
            }
            return '?';
        },
        edit_file: function(args, result) {
            if (typeof result === 'string') {
                var em = result.match(/✓ (\d+) edit/);
                if (em) return em[1] + '处';
                if (result.indexOf('✓') >= 0) return '✓';
                if (result.indexOf('Error') >= 0 || result.indexOf('✗') >= 0) return '✗';
            }
            return '?';
        },
        write_file: function() { return '✓'; },
        create_file: function() { return '✓'; },
        delete_file: function() { return '✓'; },
        run_command: function(args, result) {
            if (typeof result === 'string') {
                if (result.indexOf('Command failed') >= 0) {
                    var xm = result.match(/exit (\d+)/);
                    return '✗ exit ' + (xm ? xm[1] : '?');
                }
                return result.length + 'c';
            }
            return '?';
        },
        get_diagnostics: function(args, result) {
            if (typeof result === 'string') {
                if (result.indexOf('[SYNTAX OK]') >= 0) return '✓ OK';
                if (result.indexOf('[SYNTAX ERROR]') >= 0) return '✗';
            }
            return '?';
        },
        search_text: function(args, result) {
            if (typeof result === 'string') {
                var lines = result.split('\n').filter(function(l) { return l.trim(); });
                return lines.length + '处匹配';
            }
            return '?';
        },
        search_content: function(args, result) {
            if (typeof result === 'string') {
                var lines = result.split('\n').filter(function(l) { return l.trim(); });
                return lines.length + '处匹配';
            }
            return '?';
        },
        list_files: function(args, result) {
            if (typeof result === 'string') {
                var lines = result.split('\n').filter(function(l) { return l.trim(); });
                return lines.length + '项';
            }
            return '?';
        },
        find_files: function(args, result) {
            if (typeof result === 'string') {
                var lines = result.split('\n').filter(function(l) { return l.trim(); });
                return lines.length + '项';
            }
            return '?';
        },
    };

    // ═══ 快照工具 ═══
    function _snapshotLog(self, label, data) {
        try {
            var _logPath = ((typeof parent !== 'undefined' && parent.__qqq_workspaceRoot) || '') + '/qqq/logs';
            var _entry = JSON.stringify({
                ts: new Date().toISOString(),
                version: COMPACT_VERSION,
                label: label,
                quest: self._questId || '?',
                floor: self._floorId || '?',
                data: data || {}
            }) + '\n';
            // bridge.fs.writeFile with append mode
            if (typeof parent !== 'undefined' && parent.window && parent.window.qqqideBridge && parent.window.qqqideBridge.fs) {
                parent.window.qqqideBridge.fs.appendFile(_logPath + '/compress-v7.jsonl', _entry).catch(function(){});
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

    // ════════════════════════════════════════════════
    // _isZ — 判断一条消息是否属于 Z（注入物），压缩时需剥离
    // ════════════════════════════════════════════════
    function _isZ(msg) {
        // msg[0] persistent rules
        if (msg._persistent) return true;
        // _system 恢复消息
        if (msg._system) return true;
        // 压缩成功/失败元信息
        if (msg.role === 'assistant' && typeof msg.content === 'string') {
            if (msg.content.indexOf('ℹ️ 压缩') === 0) return true;
            if (msg.content.indexOf('📦 Compress') >= 0) return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════
    // _findBreakpoint — 找到"断点"：消息索引，断点后 = W6
    // 规则：最后6层完整楼层起锚，token >= 总重 10%，否则上浮
    // ════════════════════════════════════════════════
    function _findBreakpoint(conv, totalTokens) {
        if (conv.length === 0) return 0;

        var minTokens = Math.max(500, Math.floor(totalTokens * KEEP_RATIO));

        // 1. 从后往前找最近 MIN_FLOORS 个完整楼层的起始位置
        var floorStarts = [];  // [{idx, floorNum}]
        var seenFloors = {};
        for (var i = conv.length - 1; i >= 0; i--) {
            var m = conv[i];
            if (_isZ(m)) continue;
            var fn = m._floor || 0;
            if (fn > 0 && !seenFloors[fn]) {
                seenFloors[fn] = true;
                floorStarts.push({ idx: i, floorNum: fn });
            }
        }
        // 至少 MIN_FLOORS 层
        if (floorStarts.length < MIN_FLOORS) return 0;
        // 取最近 MIN_FLOORS 层中最远那个的索引作为起点
        floorStarts.sort(function(a,b) { return a.idx - b.idx; });
        var anchorIdx = floorStarts[floorStarts.length - MIN_FLOORS].idx;

        // 2. 从 anchor 往前找楼层边界（对齐到 user 消息）
        while (anchorIdx > 0) {
            var am = conv[anchorIdx];
            if (!_isZ(am) && am.role === 'user') break;
            anchorIdx--;
        }

        // 3. 称重 W6（anchor 到末尾），不足则上浮
        var w6Tokens = 0;
        for (var j = anchorIdx; j < conv.length; j++) {
            if (!_isZ(conv[j])) w6Tokens += AgentLoop.prototype._estimateMsgTokens(conv[j]);
        }

        // 4. 不满足则向上扩展
        while (w6Tokens < minTokens && anchorIdx > 0) {
            anchorIdx--;
            if (!_isZ(conv[anchorIdx])) {
                w6Tokens += AgentLoop.prototype._estimateMsgTokens(conv[anchorIdx]);
            }
        }

        // 5. 对齐到楼层边界（user 消息开头）
        while (anchorIdx > 0) {
            var bm = conv[anchorIdx];
            if (!_isZ(bm) && bm.role === 'user') break;
            anchorIdx--;
        }

        return Math.max(0, anchorIdx);
    }

    // ════════════════════════════════════════════════
    // _buildCompressedBiscuit — 机械筛（方案三）
    // 输入: 消息数组 X (已剥离 Z)
    // 输出: 纯文本压缩饼干
    // ════════════════════════════════════════════════
    function _buildCompressedBiscuit(msgs) {
        if (!msgs || msgs.length === 0) return '';

        var lines = [];
        var currentFloor = -1;
        var pendingToolCalls = null;  // 上一行的 tool_calls，等 tool 结果来合并

        function _flushPending() {
            if (!pendingToolCalls) return;
            // ★ 不在这里输出行，只是清空引用。
            // 行已经在 _outputToolCallLine() 里输出了。
            pendingToolCalls = null;
        }
        function _outputToolCallLine(tcs) {
            var tcNames = [];
            var fileNames = [];
            for (var ti = 0; ti < tcs.length; ti++) {
                var name = (tcs[ti].function && tcs[ti].function.name) || '?';
                tcNames.push(name);
                var fn = _extractArgPath(tcs[ti]);
                if (fn) fileNames.push(fn);
            }
            var display = fileNames.length > 0 ? fileNames.join(', ') : tcNames.join(', ');
            lines.push('[A → ' + tcNames.join('+') + '] ' + display);
        }

        function _extractArgPath(tc) {
            try {
                var args = tc.function && tc.function.arguments;
                if (!args) return null;
                var obj = typeof args === 'string' ? JSON.parse(args) : args;
                return obj.path || obj.image || null;
            } catch (_) { return null; }
        }

        function _summarizeToolResult(tc, resultContent) {
            var name = tc.function && tc.function.name;
            if (!name) return '';
            var summarizer = TOOL_SUMMARIES[name];
            if (summarizer) {
                var args = tc.function && tc.function.arguments;
                var argsObj = null;
                try { argsObj = typeof args === 'string' ? JSON.parse(args) : args; } catch (_) {}
                return ' ' + summarizer(argsObj || {}, resultContent || '');
            }
            return '';
        }

        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            if (_isZ(m)) continue;

            var floor = m._floor || 0;
            var role = m.role || 'unknown';
            var content = typeof m.content === 'string' ? m.content : '';

            // 楼层切换
            if (floor > 0 && floor !== currentFloor) {
                _flushPending();
                currentFloor = floor;
                lines.push('');
                lines.push('=== F' + floor + ' ===');
            }

            // 工具消息：附到上一行的 tool_calls 后面
            if (role === 'tool' && m.tool_call_id && pendingToolCalls) {
                // 找到匹配的 tool_call 来取摘要
                var matchedTc = null;
                for (var tk = 0; tk < pendingToolCalls.length; tk++) {
                    if (pendingToolCalls[tk].id === m.tool_call_id) {
                        matchedTc = pendingToolCalls[tk];
                        break;
                    }
                }
                if (matchedTc) {
                    var summary = _summarizeToolResult(matchedTc, content);
                    // 把摘要追加到上一行
                    if (lines.length > 0) {
                        lines[lines.length - 1] += summary;
                    }
                    // ★ run_command: 保留完整输出（唯一不能从磁盘恢复的）
                    if (matchedTc.function && matchedTc.function.name === 'run_command' && content) {
                        var cmdOut = content;
                        if (cmdOut.length > 8000) {
                            cmdOut = cmdOut.slice(0, 4000) + '\n…[截断 ' + (content.length - 8000) + ' chars]…\n' + cmdOut.slice(-4000);
                        }
                        var indentLines = cmdOut.split('\n').map(function(l) { return '  │ ' + l; }).join('\n');
                        lines.push(indentLines);
                    }
                } else {
                    lines.push('  [T] ✓');
                }
                continue;
            }

            // user 消息
            if (role === 'user') {
                _flushPending();
                // ★ 剥离 [File: ...] 注入块（光标左键点击注入的文件附件，含代码正文）
                var qText = content.replace(/\[File: [^\]]+\]\s*\n\x60\x60\x60[\s\S]*?\x60\x60\x60/g, '');
                qText = qText.replace(/\n+/g, ' ').trim();
                // 剥离 CURRENT TIME 块
                var ctIdx = qText.indexOf('[CURRENT TIME:');
                if (ctIdx < 0) ctIdx = qText.indexOf('═══ CURRENT TIME');
                if (ctIdx > 0) qText = qText.slice(0, ctIdx).trim();
                lines.push('Q: ' + qText);
                continue;
            }

            // assistant 含 tool_calls
            if (role === 'assistant' && m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                // ★ V8 修复：先输出文本（如果有）
                if (content && content.trim()) {
                    _flushPending();
                    var aText = content.replace(/\s+/g, ' ').trim();
                    lines.push('A: ' + aText);
                }
                // ★ V8 修复：必须先输出工具调用行，再设 pending
                // 旧代码：直接 pendingToolCalls = m.tool_calls（不输出行）
                //   → tool 结果追加到上一行（可能是 Q: 行） → 垃圾
                _flushPending();  // 清空上一批 pending
                _outputToolCallLine(m.tool_calls);  // 立即输出 [A → xxx] 行
                pendingToolCalls = m.tool_calls;     // 设新 pending，等 tool 结果附摘要
                continue;
            }

            // assistant 纯文本
            if (role === 'assistant') {
                _flushPending();
                if (content && content.trim()) {
                    var at = content.replace(/\s+/g, ' ').trim();
                    lines.push('A: ' + at);
                }
                continue;
            }

            // system / 其他
            if (role === 'system' && content && content.trim()) {
                _flushPending();
                var st = content.replace(/\s+/g, ' ').trim();
                lines.push('[S] ' + st);
            }
        }

        _flushPending();
        return lines.join('\n').trim();
    }

    // ════════════════════════════════════════════════
    // _compressContext — 阻塞式本地压缩（零网络，零费用）
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

        var _compressStart = performance.now();

        // ── 找到断点 ──
        var breakpoint = _findBreakpoint(self.conversation, beforeTokens);
        if (breakpoint === 0 || breakpoint >= self.conversation.length - 1) {
            self.log('◆ Context: all hot, nothing to compress (breakpoint=' + breakpoint + ')');
            return { compressed: false, detail: '所有楼层都在热点区', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        // ── 提取 X（断点前的消息，剥离Z）──
        var xMsgs = [];
        for (var xi = 0; xi < breakpoint; xi++) {
            if (!_isZ(self.conversation[xi])) {
                xMsgs.push(self.conversation[xi]);
            }
        }

        if (xMsgs.length === 0) {
            return { compressed: false, detail: '无可压缩消息', beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: 0 };
        }

        var coldTokenEst = self._estimateTotalTokens(xMsgs);
        // 保留的 W6 token数
        var w6Msgs = [];
        for (var wi = breakpoint; wi < self.conversation.length; wi++) {
            if (!_isZ(self.conversation[wi])) w6Msgs.push(self.conversation[wi]);
        }
        var w6Tokens = self._estimateTotalTokens(w6Msgs);

        self.log('◆ Context: compress ' + xMsgs.length + ' msgs (~' + Math.round(coldTokenEst) + 'tok) → biscuit, keep ' + w6Msgs.length + ' msgs (~' + Math.round(w6Tokens) + 'tok) W6');

        // ── 快照 ──
        _snapshotLog(self, 'before', {
            totalMsgs: self.conversation.length,
            totalTokens: beforeTokens,
            breakpoint: breakpoint,
            xMsgs: xMsgs.length,
            xTokens: Math.round(coldTokenEst),
            w6Msgs: w6Msgs.length,
            w6Tokens: Math.round(w6Tokens)
        });

        // ── 深拷贝 _ctx 用于回滚 ──
        var _oldCtx = {};
        var _ctxKeys = ['facts', 'narrative', 'floorArchives', 'lastCompressedFloor', 'totalFloors'];
        for (var _ki = 0; _ki < _ctxKeys.length; _ki++) {
            var _k = _ctxKeys[_ki];
            _oldCtx[_k] = self._ctx[_k];
        }
        _oldCtx.facts = (_oldCtx.facts || []).slice();
        _oldCtx.floorArchives = (_oldCtx.floorArchives || []).slice();

        try {
            // ── 机械筛：X → 压缩饼干 ──
            var biscuit = _buildCompressedBiscuit(xMsgs);
            if (!biscuit || biscuit.length < 100) {
                throw new Error('biscuit_too_short(' + (biscuit ? biscuit.length : 0) + 'c)');
            }

            // ── 构建压缩饼干消息 ──
            var floorNums = [];
            for (var xj = 0; xj < xMsgs.length; xj++) {
                var fn = xMsgs[xj]._floor || 0;
                if (fn > 0 && floorNums.indexOf(fn) < 0) floorNums.push(fn);
            }
            floorNums.sort(function(a,b) { return a - b; });
            var header = '═══ COMPRESSED FLOORS F' + floorNums[0] + '-F' + floorNums[floorNums.length-1] + ' (' + xMsgs.length + ' msgs → ' + biscuit.length + ' chars) ═══\n\n';
            var biscuitMsg = header + biscuit;

            // ── splice conversation ──
            // 找到 persistentCount 之后的第一个位置
            var spliceStart = self._persistentCount || 0;
            var removedCount = breakpoint - spliceStart;
            self.conversation.splice(spliceStart, removedCount,
                { role: 'system', content: biscuitMsg, _compressed: true, _dynamic: true }
            );

            // ── 平移索引 ──
            // removedCount 条被移除了，但插入了 1 条，净移 = removedCount - 1
            self._shiftConversationIndices(removedCount - 1, breakpoint);

            // ── 更新 _ctx ──
            self._ctx.lastCompressedFloor = self._ctx.totalFloors;
            // 从压缩饼干中提取简单的事实（供 _buildDynamicContext 使用）
            self._ctx.facts = floorNums.map(function(fn) {
                return { type: 'floor', content: 'F' + fn + ' compressed', keywords: [], floor: fn };
            });
            // narrative 改为压缩饼干本身
            self._ctx.narrative = biscuitMsg;
            // floorArchives 简化为楼层列表
            var newArchives = floorNums.map(function(fn) {
                return { n: fn, summary: 'F' + fn + ' (compressed)' };
            });
            self._ctx.floorArchives = (_oldCtx.floorArchives || []).concat(newArchives);
            // 裁剪 archives 到容量
            var _allArchives = self._ctx.floorArchives;
            var _totalArchChars = 0;
            var ARCHIVE_MAX_CHARS = (typeof ContentGateway !== 'undefined' ? ContentGateway.ARCHIVE_MAX_CHARS : 1000000);
            for (var ai2 = _allArchives.length - 1; ai2 >= 0; ai2--) {
                _totalArchChars += JSON.stringify(_allArchives[ai2]).length;
                if (_totalArchChars > ARCHIVE_MAX_CHARS) {
                    self._ctx.floorArchives = _allArchives.slice(ai2 + 1);
                    break;
                }
            }

            // ── 重置计费计数器 ──
            self._lastApiPromptTokens = 0;
            self._lastApiTotalTokens = 0;
            self._lastApiCompletionTokens = 0;

            var _elapsed = Math.round(performance.now() - _compressStart);
            var _afterEst = self._estimateTotalTokens();
            var _saved = beforeTokens - _afterEst;

            _snapshotLog(self, 'after', {
                biscuitChars: biscuit.length,
                afterTokens: Math.round(_afterEst),
                savedTokens: Math.round(_saved),
                elapsedMs: _elapsed,
                floorsCompressed: floorNums.join(',')
            });

            self.log('◆ Context: done — ' + _saved + ' tokens saved (' + _elapsed + 'ms, zero cost)');
            return {
                compressed: true,
                detail: '压缩 ' + xMsgs.length + ' 条消息 → ' + biscuit.length + ' chars 压缩饼干\n上下文: ' + Math.round(beforeTokens / 1000) + 'k → ' + Math.round(_afterEst / 1000) + 'k (节省 ' + Math.round(_saved / 1000) + 'k)\n耗时: ' + _elapsed + 'ms · 零费用',
                beforeTokens: beforeTokens,
                afterTokens: _afterEst,
                elapsedMs: _elapsed
            };

        } catch (digestErr) {
            // ★ 完整恢复 _ctx
            for (var _kj2 = 0; _kj2 < _ctxKeys.length; _kj2++) {
                var _k2 = _ctxKeys[_kj2];
                self._ctx[_k2] = _oldCtx[_k2];
            }
            self._ctx.facts = _oldCtx.facts;
            self._ctx.floorArchives = _oldCtx.floorArchives;

            _snapshotLog(self, 'after_fail_rolled_back', {
                error: digestErr.message || 'unknown'
            });

            var _elapsed2 = Math.round(performance.now() - _compressStart);
            self.log('✗ Context: compress FAILED — ' + (digestErr.message || digestErr) + ' — rolled back');
            return {
                compressed: false,
                detail: '压缩失败: ' + (digestErr.message || '未知错误') + '\n已回滚，消息未丢失\n耗时: ' + (_elapsed2 / 1000).toFixed(1) + 's',
                beforeTokens: beforeTokens, afterTokens: beforeTokens, elapsedMs: _elapsed2
            };
        }
    };

    // ════════════════════════════════════════════════
    // _buildDynamicContext — 注入压缩饼干到上下文
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
