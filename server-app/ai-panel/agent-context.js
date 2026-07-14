// ============================================================================
// agent-context.js — 上下文压缩引擎（本地机械筛，零网络调用）
// VER: COMPACT-V12-20260714 ← V12: in-place append, zero splice for biscuit/DE, prefix cache hits
//
// 架构（论文: 论文/qqqide 滴上下文压缩.md §2-§5）:
//   背包顺序: Z → biscuit(1条msg,原地追加) → DE(1条msg,原地更新) → 当前楼层消息
//   楼层完结 → _rebuildBackpack() → 机械筛 → biscuit行追加到已有msg.content → DE重建 → 仅删原始楼层
//
// 铁律：
//   - 零网络调用。一切在客户端完成。
//   - 建楼中不触发压缩。仅楼层完结时重组背包。
//   - biscuit/DE 消息对象不变 → 前缀缓存跨楼层命中。仅 content 尾部增长。
//   - 失败原子回滚（conversation + _ctx 全部字段恢复）。
//   - DE 单条 ≤6K chars, 总计 ≤20K chars, FIFO 轮转。
// ============================================================================

; (function () {
    'use strict';

    var COMPACT_VERSION = 'COMPACT-V12-20260714b';

    // ═══ 常量 ═══
    var CHAR_PER_TOKEN_EST = (typeof ContentGateway !== 'undefined' ? ContentGateway.CHAR_PER_TOKEN : 2.5);

    // ═══ DE 容量常量 ═══
    var DE_MAX_CHARS       = 20000;  // DE 总计上限
    var DE_ENTRY_MAX_CHARS = 6000;   // 单条目上限

    // ═══ 工具返回摘要规则（方案三 §4）═══
    var TOOL_SUMMARIES = {
        read_file: function(args, result) {
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
        // ★ 不可恢复数据：摘要 + 完整输出保留
        fetch_webpage: function(args, result) {
            return typeof result === 'string' ? result.length + 'c' : '?';
        },
        search_web: function(args, result) {
            if (typeof result === 'string') {
                var wlines = result.split('\n').filter(function(l) { return l.trim(); });
                return wlines.length + '条结果';
            }
            return '?';
        },
        analyze_image: function(args, result) {
            return typeof result === 'string' ? result.length + 'c' : '?';
        },
        get_vision_context: function(args, result) {
            return typeof result === 'string' ? result.length + 'c' : '?';
        },
        generate_image: function(args, result) {
            return typeof result === 'string' ? result.length + 'c' : '?';
        },
        remove_background: function(args, result) {
            return typeof result === 'string' ? result.length + 'c' : '?';
        },
    };

    // ★ 不可恢复工具：结果不能从磁盘 re-read → 完整输出保留 + 进 DE
    var IRRECOVERABLE_TOOLS = {
        run_command: true,
        fetch_webpage: true,
        search_web: true,
        analyze_image: true,
        get_vision_context: true,
        generate_image: true,
        remove_background: true
    };

    // ★ C 集合工具：AI 产出代码，从 tool_call arguments 提取
    var CODE_PRODUCING_TOOLS = {
        edit_file: true,
        write_file: true,
        create_file: true
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
            if (typeof parent !== 'undefined' && parent.window && parent.window.qqqideBridge && parent.window.qqqideBridge.fs) {
                parent.window.qqqideBridge.fs.appendFile(_logPath + '/compress-v11.jsonl', _entry).catch(function(){});
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
        if (msg._persistent) return true;
        if (msg._system) return true;
        if (msg.role === 'assistant' && typeof msg.content === 'string') {
            if (msg.content.indexOf('ℹ️ 压缩') === 0) return true;
            if (msg.content.indexOf('📦 Compress') >= 0) return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════
    // _findBreakpoint — 保留（将来可能复用）
    // ════════════════════════════════════════════════
    function _findBreakpoint(conv, totalTokens) {
        if (conv.length === 0) return 0;
        var minTokens = Math.max(500, Math.floor(totalTokens * 0.1));
        var floorStarts = [];
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
        if (floorStarts.length < 4) return 0;
        floorStarts.sort(function(a,b) { return a.idx - b.idx; });
        var anchorIdx = floorStarts[floorStarts.length - 4].idx;
        while (anchorIdx > 0) {
            var am = conv[anchorIdx];
            if (!_isZ(am) && am.role === 'user') break;
            anchorIdx--;
        }
        var w6Tokens = 0;
        for (var j = anchorIdx; j < conv.length; j++) {
            if (!_isZ(conv[j])) w6Tokens += AgentLoop.prototype._estimateMsgTokens(conv[j]);
        }
        while (w6Tokens < minTokens && anchorIdx > 0) {
            anchorIdx--;
            if (!_isZ(conv[anchorIdx])) w6Tokens += AgentLoop.prototype._estimateMsgTokens(conv[anchorIdx]);
        }
        while (anchorIdx > 0) {
            var bm = conv[anchorIdx];
            if (!_isZ(bm) && bm.role === 'user') break;
            anchorIdx--;
        }
        return Math.max(0, anchorIdx);
    }

    // ════════════════════════════════════════════════
    // _buildCompressedBiscuit — 机械筛（方案三）
    // 输入: 消息数组（已剥离 Z）
    // 输出: 纯文本压缩饼干（多楼层格式）
    // ════════════════════════════════════════════════
    function _buildCompressedBiscuit(msgs) {
        if (!msgs || msgs.length === 0) return '';

        var lines = [];
        var currentFloor = -1;
        var pendingToolCalls = null;

        function _flushPending() {
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

            if (floor > 0 && floor !== currentFloor) {
                _flushPending();
                currentFloor = floor;
                lines.push('');
                lines.push('=== F' + floor + ' ===');
            }

            if (role === 'tool' && m.tool_call_id && pendingToolCalls) {
                var matchedTc = null;
                for (var tk = 0; tk < pendingToolCalls.length; tk++) {
                    if (pendingToolCalls[tk].id === m.tool_call_id) {
                        matchedTc = pendingToolCalls[tk];
                        break;
                    }
                }
                if (matchedTc) {
                    var summary = _summarizeToolResult(matchedTc, content);
                    if (lines.length > 0) {
                        lines[lines.length - 1] += summary;
                    }
                    var _tcName2 = matchedTc.function && matchedTc.function.name;
                    if (_tcName2 && IRRECOVERABLE_TOOLS[_tcName2] && content) {
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

            if (role === 'user') {
                _flushPending();
                var qText = content.replace(/\[File: [^\]]+\]\s*\n\x60\x60\x60[\s\S]*?\x60\x60\x60/g, '');
                qText = qText.replace(/\n+/g, ' ').trim();
                var ctIdx = qText.indexOf('[CURRENT TIME:');
                if (ctIdx < 0) ctIdx = qText.indexOf('═══ CURRENT TIME');
                if (ctIdx > 0) qText = qText.slice(0, ctIdx).trim();
                lines.push('Q: ' + qText);
                continue;
            }

            if (role === 'assistant' && m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                if (content && content.trim()) {
                    _flushPending();
                    var aText = content.replace(/\s+/g, ' ').trim();
                    lines.push('A: ' + aText);
                }
                _flushPending();
                _outputToolCallLine(m.tool_calls);
                pendingToolCalls = m.tool_calls;
                continue;
            }

            if (role === 'assistant') {
                _flushPending();
                if (content && content.trim()) {
                    var at = content.replace(/\s+/g, ' ').trim();
                    // ★ V8 fix: 所有 fatal 楼层（含已恢复）标记 [ERR]，带时间戳
                    if (m._error) {
                        var errPrefix = '[ERR]';
                        if (m._errorTime) errPrefix += ' [' + m._errorTime + ']';
                        lines.push(errPrefix + ' ' + at);
                    } else {
                        lines.push('A: ' + at);
                    }
                }
                continue;
            }

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
    // _extractDeEntries — 从楼层消息中提取 K/C 条目
    // 返回: [{type:'k'|'c', tool:'...', ts:1234567890, floor:N, path:'...', content:'...'}]
    // ════════════════════════════════════════════════
    function _extractDeEntries(msgs, floorNum, ts) {
        ts = ts || Math.floor(Date.now() / 1000);
        var entries = [];

        // 先收集 tool_calls（带 id），后续匹配 tool 结果
        var pendingCalls = {};  // call_id → {name, args}

        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            if (_isZ(m)) continue;

            // assistant 带 tool_calls：记录以便匹配
            if (m.role === 'assistant' && m.tool_calls && Array.isArray(m.tool_calls)) {
                for (var ti = 0; ti < m.tool_calls.length; ti++) {
                    var tc = m.tool_calls[ti];
                    var tcName = tc.function && tc.function.name;
                    var tcArgs = null;
                    try {
                        tcArgs = typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : (tc.function.arguments || {});
                    } catch (_) { tcArgs = {}; }
                    pendingCalls[tc.id] = { name: tcName, args: tcArgs };
                    
                    // C 条目：代码产出工具 → 提取代码
                    if (tcName && CODE_PRODUCING_TOOLS[tcName] && tcArgs) {
                        var codeContent = '';
                        var codePath = tcArgs.path || '';
                        if (tcName === 'write_file' || tcName === 'create_file') {
                            codeContent = tcArgs.content || '';
                        } else if (tcName === 'edit_file') {
                            // edits 是数组，取第一个 edit 的 find/replace
                            var edits = tcArgs.edits;
                            if (Array.isArray(edits) && edits.length > 0) {
                                var parts = [];
                                for (var ei = 0; ei < edits.length; ei++) {
                                    var ed = edits[ei];
                                    if (ed.replace) parts.push(ed.replace);
                                }
                                codeContent = parts.join('\n');
                            }
                        }
                        if (codeContent && codeContent.length > 40) {
                            entries.push({
                                type: 'c',
                                tool: tcName,
                                ts: ts,
                                floor: floorNum,
                                path: codePath,
                                content: codeContent
                            });
                        }
                    }
                }
            }

            // tool 结果：K 条目
            if (m.role === 'tool' && m.tool_call_id && m.content) {
                var pc = pendingCalls[m.tool_call_id];
                if (pc && IRRECOVERABLE_TOOLS[pc.name]) {
                    entries.push({
                        type: 'k',
                        tool: pc.name,
                        ts: ts,
                        floor: floorNum,
                        path: pc.args.path || pc.args.command || '',
                        content: m.content
                    });
                }
            }
        }

        return entries;
    }

    // ════════════════════════════════════════════════
    // _capEntry — 单条目截断到 DE_ENTRY_MAX_CHARS
    // ════════════════════════════════════════════════
    function _capEntry(content) {
        if (!content || content.length <= DE_ENTRY_MAX_CHARS) return content;
        var half = Math.floor(DE_ENTRY_MAX_CHARS / 2);
        return content.slice(0, half) + '\n…[截断 ' + (content.length - DE_ENTRY_MAX_CHARS) + ' chars]…\n' + content.slice(-half);
    }

    // ════════════════════════════════════════════════
    // _serializeDeEntry — 序列化单条 DE 条目
    // ════════════════════════════════════════════════
    function _serializeDeEntry(entry) {
        var label = entry.type === 'k' ? '[' + entry.tool + ']' : '[code:' + entry.tool + ']';
        var pathStr = entry.path ? ' ' + entry.path : '';
        var content = _capEntry(entry.content);
        var indentLines = content.split('\n').map(function(l) { return '  │ ' + l; }).join('\n');
        return '[ts:' + entry.ts + ' F' + entry.floor + '] ' + label + pathStr + '\n' + indentLines;
    }

    // ════════════════════════════════════════════════
    // _serializeDeBlock — 序列化全部 DE 条目为字符串
    // ════════════════════════════════════════════════
    function _serializeDeBlock(entries) {
        if (!entries || entries.length === 0) return '';
        var lines = ['═══ DE (K+C, ' + DE_MAX_CHARS + ' cap) ═══', ''];
        for (var i = 0; i < entries.length; i++) {
            lines.push(_serializeDeEntry(entries[i]));
            lines.push('');
        }
        return lines.join('\n').trim();
    }

    // ════════════════════════════════════════════════
    // _trimDeEntries — 维护 DE 容量（FIFO，总计 ≤ DE_MAX_CHARS）
    // ════════════════════════════════════════════════
    function _trimDeEntries(entries) {
        // 先逐条截断到 DE_ENTRY_MAX_CHARS
        for (var i = 0; i < entries.length; i++) {
            entries[i].content = _capEntry(entries[i].content);
        }
        // 计算总字符数，FIFO 驱逐
        var totalChars = 0;
        for (var j = entries.length - 1; j >= 0; j--) {
            var entryStr = _serializeDeEntry(entries[j]);
            totalChars += entryStr.length + 2;  // +2 for the blank line between entries
        }
        // 从头部驱逐
        while (totalChars > DE_MAX_CHARS && entries.length > 0) {
            var removedStr = _serializeDeEntry(entries[0]);
           // ════════════════════════════════════════════════
    // _parseBiscuitFromContent — 从 biscuit 消息 content 解析楼层行
    // ════════════════════════════════════════════════
    function _parseBiscuitFromContent(content) {
        var lines = [];
        if (!content) return lines;
        var parts = content.split(/\n(?==== F\d+ ===)/);
        for (var i = 0; i < parts.length; i++) {
            var ptext = parts[i].trim();
            if (!ptext) continue;
            var fm = ptext.match(/^=== F(\d+) ===/);
            var fn = fm ? parseInt(fm[1], 10) : 0;
            if (fn > 0) lines.push({ n: fn, text: ptext });
        }
        lines.sort(function(a, b) { return a.n - b.n; });
        return lines;
    }

    // ════════════════════════════════════════════════
    // _findDynamicMsg — 在 conversation 中查找指定 tag 的动态消息
    // ════════════════════════════════════════════════
    function _findDynamicMsg(conv, startIdx, tag) {
        for (var i = startIdx; i < conv.length; i++) {
            if (conv[i][tag]) return { msg: conv[i], idx: i };
            if (!conv[i]._dynamic) break;
        }
        return null;
    }

    // ════════════════════════════════════════════════
    // _rebuildBackpack — 楼层完结时重组背包（V12 核心：原地追加，零 splice）
    // 调用时机: onDone 中，floor 封顶后
    // ════════════════════════════════════════════════
    AgentLoop.prototype._rebuildBackpack = async function () {
        var self = this;
        var persistentCount = self._persistentCount || 0;

        // ── 1. 找到当前楼层在 conversation 中的起始位置 ──
        var floorStart = persistentCount;
        for (var i = persistentCount; i < self.conversation.length; i++) {
            if (!self.conversation[i]._persistent && !self.conversation[i]._dynamic) {
                floorStart = i;
                break;
            }
            if (i === self.conversation.length - 1) floorStart = self.conversation.length;
        }

        if (floorStart >= self.conversation.length) return;

        // ★ V2 fix: 仅压缩当前楼层的消息，不压缩更早的楼层（含未恢复的 fatal 楼层）
        var floorMsgs = [];
        var floorNum = self._ctx.totalFloors;
        // 收集所有待压缩的楼层消息（分组处理）
        var _allRawMsgs = self.conversation.slice(floorStart);
        var _floorGroups = {};  // floorNum → msgs[]
        for (var _fi = 0; _fi < _allRawMsgs.length; _fi++) {
            var _fm2 = _allRawMsgs[_fi];
            var _ffn = _fm2._floor || 0;
            if (_ffn > 0) {
                if (!_floorGroups[_ffn]) _floorGroups[_ffn] = [];
                _floorGroups[_ffn].push(_fm2);
            }
        }
        // 当前楼层消息（必定压缩）
        floorMsgs = _floorGroups[floorNum] || [];
        // 更早的楼层：仅压缩已全部恢复或无错误的楼层
        var _olderFloorNums = Object.keys(_floorGroups).map(Number).filter(function(fn) { return fn < floorNum; }).sort(function(a,b){return a-b;});
        for (var _ofi = 0; _ofi < _olderFloorNums.length; _ofi++) {
            var _ofn = _olderFloorNums[_ofi];
            var _ofMsgs = _floorGroups[_ofn];
            var _hasActiveErrors = false;
            for (var _omi = 0; _omi < _ofMsgs.length; _omi++) {
                if (_ofMsgs[_omi]._error && !_ofMsgs[_omi]._recovered) {
                    _hasActiveErrors = true;
                    break;
                }
            }
            if (!_hasActiveErrors) {
                // 合并到待压缩消息中
                for (var _omi2 = 0; _omi2 < _ofMsgs.length; _omi2++) {
                    floorMsgs.push(_ofMsgs[_omi2]);
                }
            }
        }
        var nowTs = Math.floor(Date.now() / 1000);

        self.log('◆ Backpack: rebuilding — floor ' + floorNum + ', ' + floorMsgs.length + ' msgs');

        // ── 2. 快照（压缩前） ──
        var beforeTokens = self._estimateTotalTokens();
        _snapshotLog(self, 'before_rebuild', {
            floor: floorNum,
            totalMsgs: self.conversation.length,
            totalTokens: beforeTokens,
            floorMsgs: floorMsgs.length
        });

        // ── 3. 恢复：若 biscuitLines 空，从 conversation 解析已有 biscuit/de ──
        if (!self._ctx.biscuitLines || self._ctx.biscuitLines.length === 0) {
            self._ctx.biscuitLines = [];
            self._ctx.deEntries = self._ctx.deEntries || [];
            var v11Cleanup = [];  // V11→V12 升级：需移除的旧消息索引
            for (var ri = persistentCount; ri < self.conversation.length; ri++) {
                var rm = self.conversation[ri];
                // V12: 单条 _biscuit 消息
                if (rm._biscuit && rm.content) {
                    self._ctx.biscuitLines = _parseBiscuitFromContent(rm.content);
                    break;  // 找到 V12 格式即停
                }
                // V11 兼容：_biscuitPrefix + _biscuitLatest（需清理）
                if (rm._biscuitPrefix && rm.content) {
                    var parts = rm.content.split(/\n(?==== F\d+ ===)/);
                    for (var rj = 0; rj < parts.length; rj++) {
                        var ptext = parts[rj].trim();
                        if (!ptext) continue;
                        var fm = ptext.match(/^=== F(\d+) ===/);
                        var fn2 = fm ? parseInt(fm[1], 10) : 0;
                        self._ctx.biscuitLines.push({ n: fn2, text: ptext });
                    }
                    v11Cleanup.push(ri);
                    continue;
                }
                if (rm._biscuitLatest && rm.content) {
                    var fm2 = rm.content.match(/^=== F(\d+) ===/);
                    var fn3 = fm2 ? parseInt(fm2[1], 10) : 0;
                    self._ctx.biscuitLines.push({ n: fn3, text: rm.content.trim() });
                    v11Cleanup.push(ri);
                    continue;
                }
                if (rm._deBlock && rm.content) {
                    self._ctx._rawDeText = rm.content;
                    // V11 DE 消息也需标记清理（后续会用 V12 格式重建）
                    if (v11Cleanup.length > 0) v11Cleanup.push(ri);
                }
            }
            // ★ V11→V12 升级：移除旧格式消息（从后往前删，索引不乱）
            for (var ci = v11Cleanup.length - 1; ci >= 0; ci--) {
                self.conversation.splice(v11Cleanup[ci], 1);
            }
            // 去重 + 排序
            var seen = {};
            self._ctx.biscuitLines = self._ctx.biscuitLines.filter(function(l) {
                if (seen[l.n]) return false;
                seen[l.n] = true;
                return true;
            });
            self._ctx.biscuitLines.sort(function(a, b) { return a.n - b.n; });
            if (self._ctx.biscuitLines.length > 0) {
                self.log('◆ Backpack: recovered ' + self._ctx.biscuitLines.length + ' biscuit floors from conversation');
            }
        }

        // ── 4. 保存旧状态（用于回滚） ──
        var oldBiscuitLines = (self._ctx.biscuitLines || []).slice();
        var oldDeEntries = (self._ctx.deEntries || []).slice();
        var oldConvLen = self.conversation.length;

        try {
            // ── 5. 机械筛：当前楼层 → 饼干行 ──
            var biscuitText = _buildCompressedBiscuit(floorMsgs);
            if (!biscuitText || biscuitText.length < 20) {
                biscuitText = '=== F' + floorNum + ' ===\nQ: (压缩失败，内容过短)';
            }

            // ── 6. 提取 DE 条目 ──
            var newDeEntries = _extractDeEntries(floorMsgs, floorNum, nowTs);

            // ── 7. 更新内存状态 ──
            if (!self._ctx.biscuitLines) self._ctx.biscuitLines = [];
            self._ctx.biscuitLines.push({ n: floorNum, text: biscuitText });

            if (!self._ctx.deEntries) self._ctx.deEntries = [];
            for (var ei = 0; ei < newDeEntries.length; ei++) {
                self._ctx.deEntries.push(newDeEntries[ei]);
            }
            _trimDeEntries(self._ctx.deEntries);

            // ── 8. ★ 删已压缩的楼层消息（精确匹配，保留未压缩的 fatal 楼层） ──
            //    V2 fix: floorMsgs 可能不连续（跳过了有活跃错误的楼层），逐条删除
            for (var _ci = self.conversation.length - 1; _ci >= floorStart; _ci--) {
                for (var _fi2 = 0; _fi2 < floorMsgs.length; _fi2++) {
                    if (self.conversation[_ci] === floorMsgs[_fi2]) {
                        self.conversation.splice(_ci, 1);
                        break;
                    }
                }
            }

            // ── 9. ★ 找已有 biscuit 消息 → 原地追加 content ──
            var biscuitFound = _findDynamicMsg(self.conversation, persistentCount, '_biscuit');
            if (biscuitFound) {
                // ★ 原地追加：消息对象不变 → 前缀缓存命中
                biscuitFound.msg.content = biscuitFound.msg.content + '\n\n' + biscuitText;
            } else {
                // 首次：创建 biscuit 消息
                self.conversation.splice(persistentCount, 0,
                    { role: 'system', content: biscuitText, _dynamic: true, _biscuit: true });
            }

            // ── 10. ★ 找已有 DE 消息 → 原地更新 content ──
            var deText = _serializeDeBlock(self._ctx.deEntries);
            // 恢复路径：deEntries 空但 conversation 中有 DE（V11 升级场景）
            if (!deText && self._ctx._rawDeText) {
                deText = self._ctx._rawDeText;
                self._ctx._rawDeText = null;
            }

            var deFound = _findDynamicMsg(self.conversation, persistentCount, '_deBlock');
            if (deFound) {
                if (deText) {
                    // ★ 原地更新：DE 条目仅尾部追加时 → 前缀缓存命中
                    //    FIFO 驱逐时前缀会变 → 仅 DE 缓存 miss（罕见）
                    deFound.msg.content = deText;
                } else {
                    // DE 空 → 移除消息
                    self.conversation.splice(deFound.idx, 1);
                }
            } else if (deText) {
                // 首次：插入 DE 消息（在 biscuit 之后）
                var biscuitIdx = persistentCount;
                var bf2 = _findDynamicMsg(self.conversation, persistentCount, '_biscuit');
                if (bf2) biscuitIdx = bf2.idx;
                self.conversation.splice(biscuitIdx + 1, 0,
                    { role: 'system', content: deText, _dynamic: true, _deBlock: true });
            }

            // ── 11. 重置计费计数器 ──
            self._lastApiPromptTokens = 0;
            self._lastApiTotalTokens = 0;
            self._lastApiCompletionTokens = 0;

            // ── 12. 更新 _ctx ──
            self._ctx.lastCompressedFloor = floorNum;
            self._ctx.narrative = 'biscuit:' + self._ctx.biscuitLines.length + ' de:' + self._ctx.deEntries.length;
            self._ctx.facts = [];

            // ── 快照（压缩后） ──
            var afterTokens = self._estimateTotalTokens();
            var saved = beforeTokens - afterTokens;
            _snapshotLog(self, 'after_rebuild', {
                floor: floorNum,
                biscuitFloors: self._ctx.biscuitLines.length,
                deEntries: self._ctx.deEntries.length,
                deChars: deText ? deText.length : 0,
                afterTokens: Math.round(afterTokens),
                savedTokens: Math.round(saved)
            });

            self.log('◆ Backpack: done — biscuit ' + self._ctx.biscuitLines.length + ' floors, DE ' + self._ctx.deEntries.length + ' entries, saved ~' + Math.round(saved) + ' tokens');
        } catch (err) {
            // ★ 回滚
            self._ctx.biscuitLines = oldBiscuitLines;
            self._ctx.deEntries = oldDeEntries;

            _snapshotLog(self, 'after_rebuild_failed', {
                floor: floorNum,
                error: err.message || 'unknown'
            });

            self.log('✗ Backpack: rebuild FAILED — ' + (err.message || err));
        }
    };        self.log('✗ Backpack: rebuild FAILED — ' + (err.message || err));
        }
    };

    // ════════════════════════════════════════════════
    // _compressContext — 保留（V11 不再使用，代码保留供将来 facts 格子用）
    // ════════════════════════════════════════════════
    AgentLoop.prototype._compressContext = async function (reason) {
        // V11: 压缩已改为 per-floor 自动重组（_rebuildBackpack）。
        // 本函数保留但不再由系统自动调用。
        // 将来用于：用户手动触发 → AI 驱动的 facts 格子。
        var self = this;
        self.log('◆ _compressContext: deprecated in V11, use _rebuildBackpack instead');
        return {
            compressed: false,
            detail: 'V11: 压缩已自动化（每层楼完结自动重组背包）',
            beforeTokens: self._estimateTotalTokens(),
            afterTokens: self._estimateTotalTokens(),
            elapsedMs: 0
        };
    };

    // ════════════════════════════════════════════════
    // _buildDynamicContext — V11: 动态上下文已在 conversation 中
    // biscuit/de 消息本身就是动态上下文，无需额外注入
    // ════════════════════════════════════════════════
    AgentLoop.prototype._buildDynamicContext = function () {
        // V11: biscuit/de 消息已在 conversation 中（_dynamic: true），
        // _callGateway 不需要再额外注入。返回空。
        return '';
    };

})();
