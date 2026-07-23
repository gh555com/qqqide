// ============================================================================
// agent-context.js — 上下文压缩引擎（本地机械筛，零网络调用）
// VER: COMPACT-V14-20260717 ← V14: 配对修复 + 智能截断命令，多工具行 per-file 配对
//
// 架构:
//   背包顺序: Z → biscuit(1条msg,原地追加) → 当前楼层消息
//   楼层完结 → _rebuildBackpack() → 机械筛 → biscuit行追加到已有msg.content → 仅删原始楼层
//
// 铁律：
//   - 零网络调用。一切在客户端完成。
//   - 建楼中不触发压缩。仅楼层完结时重组背包。
//   - biscuit 消息对象不变 → 前缀缓存跨楼层命中。仅 content 尾部增长。
//   - 失败原子回滚（conversation + _ctx 全部字段恢复）。
//   - 绝对包装盒（5工具）╔K...╚ 融入饼干，阀值压缩时整盒移除。
//   - 每层格式: === FN YYYY-MM-DD HH:MM:SS UTC+8 === → Q → 包装盒 → A
// ============================================================================

; (function () {
    'use strict';

    var COMPACT_VERSION = 'COMPACT-V13-20260716';

    // ═══ 常量 ═══
    var CHAR_PER_TOKEN_EST = (typeof ContentGateway !== 'undefined' ? ContentGateway.CHAR_PER_TOKEN : 2.5);

    // ═══ 绝对包装盒容量常量（融入饼干，阀值压缩时整盒移除）═══
    var ABS_BODY_CAP = 4096;    // 绝对包装盒体部上限（4K chars），超则首尾各2K
    var ABS_HEAD_CAP = 80;      // 绝对包装盒头行上限

    // ═══ 绝对工具集合（5 个，╔K...╚ 包裹，阀值压缩时整盒移除）═══
    var ABSOLUTE_TOOLS = {
        run_command: true,
        generate_image: true,
        remove_background: true,
        analyze_image: true,
        get_vision_context: true
    };

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
                if (em) return em[1] + 'chg';
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
                return lines.length + ' hits';
            }
            return '?';
        },
        search_content: function(args, result) {
            if (typeof result === 'string') {
                var lines = result.split('\n').filter(function(l) { return l.trim(); });
                return lines.length + ' hits';
            }
            return '?';
        },
        list_files: function(args, result) {
            if (typeof result === 'string') {
                var lines = result.split('\n').filter(function(l) { return l.trim(); });
                return lines.length + ' items';
            }
            return '?';
        },
        find_files: function(args, result) {
            if (typeof result === 'string') {
                var lines = result.split('\n').filter(function(l) { return l.trim(); });
                return lines.length + ' items';
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
                return wlines.length + ' results';
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
        diff_versions: function(args, result) {
            if (typeof result === 'string') {
                var am = result.match(/\+N=(\d+) -M=(\d+)/);
                if (am) return '+' + am[1] + '/-' + am[2];
                return result.length + 'c';
            }
            return '?';
        },
        timeline_versions: function(args, result) {
            if (typeof result === 'string') {
                var vm = result.match(/(\d+) version/);
                if (vm) return vm[1] + ' versions';
                return result.length + 'c';
            }
            return '?';
        },
        revert_file: function(args, result) {
            if (typeof result === 'string') {
                if (result.indexOf('Reverted') >= 0) return '✓';
                if (result.indexOf('Error') >= 0) return '✗';
                return '✓';
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
    // 键入: 消息数组（已剥离 Z）
    // 输出: 纯文本压缩饼干（多楼层格式）
    // ════════════════════════════════════════════════
    function _buildCompressedBiscuit(msgs) {
        if (!msgs || msgs.length === 0) return '';

        var lines = [];
        var currentFloor = -1;
        var pendingToolCalls = null;

        function _flushPending() {
            if (!pendingToolCalls || pendingToolCalls.length === 0) { pendingToolCalls = null; return; }
            var tcNames = [];
            var parts = [];
            for (var ti = 0; ti < pendingToolCalls.length; ti++) {
                var pt = pendingToolCalls[ti];
                tcNames.push(pt.name);
                parts.push(pt.display + pt.summary);
            }
            lines.push('[A → ' + tcNames.join('+') + '] ' + parts.join(', '));
            for (var ti = 0; ti < pendingToolCalls.length; ti++) {
                if (pendingToolCalls[ti].absBody) {
                    lines.push('╔K');
                    lines.push(pendingToolCalls[ti].absBody.trimEnd());
                    lines.push('╚');
                }
            }
            pendingToolCalls = null;
        }
        function _saveToolCallLine(tcs) {
            pendingToolCalls = [];
            for (var ti = 0; ti < tcs.length; ti++) {
                var name = (tcs[ti].function && tcs[ti].function.name) || '?';
                var display = _extractToolDisplay(tcs[ti]) || name;
                pendingToolCalls.push({ tc: tcs[ti], name: name, display: display, summary: '', absBody: '' });
            }
        }

        // ★ _extractToolDisplay — extract the most informative arg for biscuit head line
        //   Gentle tools: per-tool caps. Absolute box tools: unified ABS_HEAD_CAP=80 (single truth).
        //   Covers all 20 tools. Falls back to path/image for unknown tools.
        function _extractToolDisplay(tc) {
            try {
                var ABS_HEAD_CAP = 80; // ★ Single source of truth — absolute box header truncation
                var args = tc.function && tc.function.arguments;
                if (!args) return null;
                var obj = typeof args === 'string' ? JSON.parse(args) : args;
                var name = (tc.function && tc.function.name) || '';
                // Project-relative path shortening
                function _shortPath(p) {
                    if (!p || typeof p !== 'string') return p;
                    var root = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot().replace(/\\/g, '/').replace(/\/$/, '') : null;
                    if (root && p.indexOf(root) === 0) return p.slice(root.length);
                    return p;
                }
                function _trunc(s, max) {
                    if (!s) return '';
                    if (s.length <= max) return s;
                    return s.slice(0, max - 1) + '…';
                }
                function _truncCmd(s, max) {
                    if (!s || s.length <= max) return s;
                    var tail = Math.min(Math.floor(max * 0.4), 30);
                    if (tail < 5) return s.slice(0, max - 1) + '…';
                    var head = max - tail - 1;
                    return s.slice(0, head) + '…' + s.slice(-tail);
                }
                // ★ sha256 archaeology tag — append @sha=xxx when reading a historical blob
                function _shaTag(o) {
                    if (o && o.sha256 && typeof o.sha256 === 'string' && o.sha256.length >= 12) {
                        return ' @sha=' + o.sha256.slice(0, 12);
                    }
                    return '';
                }
                switch (name) {
                    // ── Gentle box (15 tools) ──
                    case 'read_file':       return (_shortPath(obj.path) || null) + _shaTag(obj);
                    case 'edit_file':       return _shortPath(obj.path) || null;
                    case 'write_file':      return _shortPath(obj.path) || null;
                    case 'create_file':     return _shortPath(obj.path) || null;
                    case 'delete_file':     return _shortPath(obj.path) || null;
                    case 'get_diagnostics': return (_shortPath(obj.path) || null) + _shaTag(obj);
                    case 'list_files':      return _shortPath(obj.path) || null;
                    case 'timeline_versions': return _shortPath(obj.path) || null;
                    case 'diff_versions':   return _shortPath(obj.path) || null;
                    case 'revert_file':     return _shortPath(obj.path) || null;
                    case 'search_text':     return '"' + _trunc(obj.query || '', 110) + '"' + _shaTag(obj);
                    case 'search_content':  return '[' + (obj.keywords || []).join(',') + ']' + _shaTag(obj);
                    case 'find_files':      return _trunc(obj.pattern || '', 80);
                    case 'fetch_webpage':   return _trunc(obj.url || '', 100);
                    case 'search_web':      return '"' + _trunc(obj.query || '', 110) + '"';
                    // ── Absolute box (5 tools, ABS_HEAD_CAP unified) ──
                    case 'run_command':     return _truncCmd(obj.command || '', ABS_HEAD_CAP);
                    case 'generate_image':  return _trunc(obj.prompt || '', ABS_HEAD_CAP) || (obj.images && obj.images[0] ? _shortPath(obj.images[0]) : null);
                    case 'remove_background': return _shortPath(obj.image || '') || null;
                    case 'analyze_image':   return _shortPath(obj.image || '') + (obj.action ? ' ' + obj.action : '');
                    case 'get_vision_context': return null;
                    default:                return (_shortPath(obj.path) || _shortPath(obj.image) || obj.url || obj.query || obj.pattern || null) + _shaTag(obj);
                }
            } catch (_) { return null; }
        }

        function _summarizeToolResult(tc, resultContent) {
            var name = tc.function && tc.function.name;
            if (!name) return '';
            var summarizer = TOOL_SUMMARIES[name];
            var summary = '';
            if (summarizer) {
                var args = tc.function && tc.function.arguments;
                var argsObj = null;
                try { argsObj = typeof args === 'string' ? JSON.parse(args) : args; } catch (_) {}
                summary = ' ' + summarizer(argsObj || {}, resultContent || '');
            }
            // ★ Extract sha256 from result for write tools + fetch/search_web (land-to-floor)
            if (resultContent && typeof resultContent === 'string') {
                var sm = resultContent.match(/\[sha256: ([a-f0-9]{12})/);
                if (sm) summary += ' \u279c sha=' + sm[1];
            }
            return summary;
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
                // ★ V13: datetime in floor header
                var _now = new Date();
                var _dt = _now.getFullYear() + '-' +
                    String(_now.getMonth() + 1).padStart(2, '0') + '-' +
                    String(_now.getDate()).padStart(2, '0') + ' ' +
                    String(_now.getHours()).padStart(2, '0') + ':' +
                    String(_now.getMinutes()).padStart(2, '0') + ':' +
                    String(_now.getSeconds()).padStart(2, '0') + ' UTC+8';
                lines.push('');
                lines.push('=== F' + floor + '  ' + _dt + ' ===');
            }

            if (role === 'tool' && m.tool_call_id && pendingToolCalls) {
                var matchedTc = null;
                for (var tk = 0; tk < pendingToolCalls.length; tk++) {
                    if (pendingToolCalls[tk].tc.id === m.tool_call_id) {
                        matchedTc = pendingToolCalls[tk].tc;
                        break;
                    }
                }
                if (matchedTc) {
                    var tcName = matchedTc.function && matchedTc.function.name;
                    var summary = _summarizeToolResult(matchedTc, content);
                    for (var pi = 0; pi < pendingToolCalls.length; pi++) {
                        if (pendingToolCalls[pi].tc.id === m.tool_call_id) {
                            pendingToolCalls[pi].summary = summary;
                            if (tcName && ABSOLUTE_TOOLS[tcName] && content && content.trim()) {
                                var body = content;
                                if (body.length > ABS_BODY_CAP) {
                                    var h = Math.floor(ABS_BODY_CAP / 2);
                                    body = body.slice(0, h) + '\n…[trunc ' + (content.length - ABS_BODY_CAP) + ' chars]…\n' + body.slice(-h);
                                }
                                pendingToolCalls[pi].absBody = body;
                            }
                            break;
                        }
                    }
                } else {
                    lines.push('  [T] ✓');
                }
                continue;
            }

            if (role === 'user') {
                _flushPending();
                // ★ V15: _compressFloor → §facts 精简 Q 行
                if (m._compressFloor) {
                    var _cqText = content.replace(/\n+/g, ' ').trim();
                    lines.push('Q: §facts ' + _cqText.slice(0, 120));
                    continue;
                }
                // Q 文本 = 编辑框原文一字不差（剥离系统注入的 [File:] 块和 [CURRENT TIME:] 块）
                var _fileIdx = content.search(/\n\n\[File: /);
                var qText = _fileIdx >= 0 ? content.slice(0, _fileIdx) : content;
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
                _saveToolCallLine(m.tool_calls);
                continue;
            }

            if (role === 'assistant') {
                _flushPending();
                if (content && content.trim()) {
                    var at = content.replace(/\s+/g, ' ').trim();
                    // ★ V15: _compressFloor → 精简 A（facts 在 fx 区，不进饼干）
                    if (m._compressFloor) {
                        lines.push('A: ' + at.slice(0, 200));
                    } else if (m._error) {
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
    // _parseBiscuitFromContent — 从 biscuit 消息 content 解析楼层行
    //   V13: 支持新格式 === FN YYYY-MM-DD HH:MM:SS UTC+8 ===
    // ════════════════════════════════════════════════
    function _parseBiscuitFromContent(content) {
        var lines = [];
        if (!content) return lines;
        // ★ V13: 支持新格式 === FN YYYY-MM-DD HH:MM:SS UTC+8 === 和旧格式 === FN ===
        var parts = content.split(/\n(?==== F\d+ )/);
        for (var i = 0; i < parts.length; i++) {
            var ptext = parts[i].trim();
            if (!ptext) continue;
            var fm = ptext.match(/^=== F(\d+)/);
            var fn = fm ? parseInt(fm[1], 10) : 0;
            if (fn > 0) lines.push({ n: fn, text: ptext });
        }
        lines.sort(function(a, b) { return a.n - b.n; });
        return lines;
    }

    // ════════════════════════════════════════════════
    // _findDynamicMsg — 在 conversation 中查找指定 tag 的动态消息
    // ════════════════════════════════════════════════
    // ★ V15 fix: _persistent 消息（Z）不是 _dynamic，但不应该阻断搜索。
    //   旧逻辑 break → Z 挡路 → _findDynamicMsg 返回 null → 创建重复 biscuit。
    function _findDynamicMsg(conv, startIdx, tag) {
        for (var i = startIdx; i < conv.length; i++) {
            if (conv[i][tag]) return { msg: conv[i], idx: i };
            if (!conv[i]._dynamic && !conv[i]._persistent) break;
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
        // ★ V14 fix: 老楼层在前、当前楼层在后 → biscuitText 天生升序
        floorMsgs = [];
        // ★ V15: 收集 _compressFloor 楼层的 facts 用于 fx 注入
        var _newFacts = [];
        // 更早的楼层：先收集（升序）
        var _olderFloorNums = Object.keys(_floorGroups).map(Number).filter(function(fn) { return fn < floorNum; }).sort(function(a,b){return a-b;});
        for (var _ofi = 0; _ofi < _olderFloorNums.length; _ofi++) {
            var _ofn = _olderFloorNums[_ofi];
            var _ofMsgs = _floorGroups[_ofn];
            // ★ V15: 跳过 _compressFloor 楼层（不进饼干，facts 走 fx 区）
            if (_ofMsgs.length > 0 && _ofMsgs[0]._compressFloor) {
                for (var _ocmi = 0; _ocmi < _ofMsgs.length; _ocmi++) {
                    if (_ofMsgs[_ocmi].role === 'assistant' && _ofMsgs[_ocmi].content) {
                        _newFacts.push(_ofMsgs[_ocmi].content.trim());
                    }
                }
                continue;
            }
            var _hasActiveErrors = false;
            for (var _omi = 0; _omi < _ofMsgs.length; _omi++) {
                if (_ofMsgs[_omi]._error && !_ofMsgs[_omi]._recovered) {
                    _hasActiveErrors = true;
                    break;
                }
            }
            if (!_hasActiveErrors) {
                for (var _omi2 = 0; _omi2 < _ofMsgs.length; _omi2++) {
                    floorMsgs.push(_ofMsgs[_omi2]);
                }
            }
        }
        // 当前楼层消息（必定压缩）— 放在最后
        var _curMsgs = _floorGroups[floorNum] || [];
        // ★ V15: 当前楼层若是 _compressFloor，提取 facts 后跳过
        if (_curMsgs.length > 0 && _curMsgs[0]._compressFloor) {
            for (var _ccmi = 0; _ccmi < _curMsgs.length; _ccmi++) {
                if (_curMsgs[_ccmi].role === 'assistant' && _curMsgs[_ccmi].content) {
                    _newFacts.push(_curMsgs[_ccmi].content.trim());
                }
            }
        } else {
            for (var _cmi = 0; _cmi < _curMsgs.length; _cmi++) {
                floorMsgs.push(_curMsgs[_cmi]);
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

        // ── 3. 恢复：若 biscuitLines 空，从 conversation 解析已有 biscuit ──
        if (!self._ctx.biscuitLines || self._ctx.biscuitLines.length === 0) {
            self._ctx.biscuitLines = [];
            var v11Cleanup = [];  // V11→V12 升级：需移除的旧消息索引
            for (var ri = persistentCount; ri < self.conversation.length; ri++) {
                var rm = self.conversation[ri];
                if (rm._biscuit && rm.content) {
                    // ★ V16 fix: 合并所有 biscuit（旧 _findDynamicMsg bug 可能产生多个孤儿 biscuit，
                    //   每个都可能含有其他 biscuit 里没有的楼层。不 break——全部合并后再去重）
                    var _bLines = _parseBiscuitFromContent(rm.content);
                    for (var _bli = 0; _bli < _bLines.length; _bli++) {
                        self._ctx.biscuitLines.push(_bLines[_bli]);
                    }
                }
                if (rm._biscuitPrefix && rm.content) {
                    var parts = rm.content.split(/\n(?==== F\d+ )/);
                    for (var rj = 0; rj < parts.length; rj++) {
                        var ptext = parts[rj].trim();
                        if (!ptext) continue;
                        var fm = ptext.match(/^=== F(\d+)/);
                        var fn2 = fm ? parseInt(fm[1], 10) : 0;
                        self._ctx.biscuitLines.push({ n: fn2, text: ptext });
                    }
                    v11Cleanup.push(ri);
                    continue;
                }
                if (rm._biscuitLatest && rm.content) {
                    var fm2 = rm.content.match(/^=== F(\d+)/);
                    var fn3 = fm2 ? parseInt(fm2[1], 10) : 0;
                    self._ctx.biscuitLines.push({ n: fn3, text: rm.content.trim() });
                    v11Cleanup.push(ri);
                    continue;
                }
                // ★ V13: 清除旧 DE 消息（DE 概念已消除）
                if (rm._deBlock) {
                    v11Cleanup.push(ri);
                }
            }
            for (var ci = v11Cleanup.length - 1; ci >= 0; ci--) {
                self.conversation.splice(v11Cleanup[ci], 1);
            }
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
        var oldConvLen = self.conversation.length;

        try {
            // ── 5. 机械筛：当前楼层 → 饼干行 ──
            var biscuitText = _buildCompressedBiscuit(floorMsgs);
            if (!biscuitText || biscuitText.length < 20) {
                var _now2 = new Date();
                var _dt2 = _now2.getFullYear() + '-' + String(_now2.getMonth()+1).padStart(2,'0') + '-' + String(_now2.getDate()).padStart(2,'0') + ' ' + String(_now2.getHours()).padStart(2,'0') + ':' + String(_now2.getMinutes()).padStart(2,'0') + ':' + String(_now2.getSeconds()).padStart(2,'0') + ' UTC+8';
                biscuitText = '=== F' + floorNum + '  ' + _dt2 + ' ===\nQ: (压缩失败，内容过短)';
            }

            // ── 6. 更新内存状态（V13: 无 DE，仅 biscuitLines）──
            if (!self._ctx.biscuitLines) self._ctx.biscuitLines = [];
            var _newLines = _parseBiscuitFromContent(biscuitText);
            var _existMap = {};
            for (var _bi = 0; _bi < self._ctx.biscuitLines.length; _bi++) {
                _existMap[self._ctx.biscuitLines[_bi].n] = _bi;
            }
            for (var _nbi = 0; _nbi < _newLines.length; _nbi++) {
                var _nl = _newLines[_nbi];
                if (_existMap.hasOwnProperty(_nl.n)) {
                    self._ctx.biscuitLines[_existMap[_nl.n]] = _nl;
                } else {
                    self._ctx.biscuitLines.push(_nl);
                }
            }
            self._ctx.biscuitLines.sort(function(a, b) { return a.n - b.n; });

            // ── 7. ★ 删已压缩的楼层消息（精确匹配，保留未压缩的 fatal 楼层） ──
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
                // ★ V14 fix: 判断新楼层是否全在已有之后 → 纯追加 vs 合并重排
                var _newFirstFloor = 0;
                var _nfm = biscuitText.match(/^=== F(\d+)/m);
                if (_nfm) _newFirstFloor = parseInt(_nfm[1], 10);
                var _existLastFloor = 0;
                var _existLines = _parseBiscuitFromContent(biscuitFound.msg.content);
                for (var _eli = 0; _eli < _existLines.length; _eli++) {
                    if (_existLines[_eli].n > _existLastFloor) _existLastFloor = _existLines[_eli].n;
                }
                if (_newFirstFloor > _existLastFloor) {
                    // 常见路径：纯追加，零缓存破坏 → 前缀缓存 ~90% 命中
                    biscuitFound.msg.content = biscuitFound.msg.content + '\n\n' + biscuitText;
                } else {
                    // 罕见路径：旧楼层恢复需插入中间 → 合并重排（缓存从插入点断，但罕见）
                    var _allSorted = _parseBiscuitFromContent(biscuitFound.msg.content + '\n\n' + biscuitText);
                    biscuitFound.msg.content = _allSorted.map(function(l) { return l.text; }).join('\n\n');
                }
            } else {
                // ★ V15 fix: 先清除所有已有 biscuit（防 _findDynamicMsg 漏网导致的重复）
                for (var _cci = self.conversation.length - 1; _cci >= persistentCount; _cci--) {
                    if (self.conversation[_cci]._biscuit) self.conversation.splice(_cci, 1);
                }
                // ★ 首次创建 biscuit：优先用 ctx.biscuitLines（重启后 ctx 已从 ctx.json 恢复全量），
                //    仅当 ctx 为空时才用 biscuitText（当前楼层的单层饼干）
                var _biscuitSrc = (self._ctx.biscuitLines && self._ctx.biscuitLines.length > 0)
                    ? self._ctx.biscuitLines.map(function(l) { return l.text; }).join('\n\n')
                    : biscuitText;
                var _sortedLines = _parseBiscuitFromContent(_biscuitSrc);
                var _sortedText = _sortedLines.map(function(l) { return l.text; }).join('\n\n');
                self.conversation.splice(persistentCount, 0,
                    { role: 'system', content: _sortedText, _dynamic: true, _biscuit: true });
            }

            // ★ V13: 清除旧 DE 消息（DE 概念已消除）──
            for (var _dci = self.conversation.length - 1; _dci >= 0; _dci--) {
                if (self.conversation[_dci]._deBlock) {
                    self.conversation.splice(_dci, 1);
                }
            }

            // ★ V16 fix: 去重 biscuit/facts 消息 — 先合并孤儿内容再删除
            //   旧 _findDynamicMsg bug 可能产生多个孤儿 biscuit，每个含不同楼层。
            //   删孤儿之前必须把其独有的楼层合并到第一条 biscuit，否则永久丢数据。
            var _firstBiscuitIdx = -1;
            for (var _dci2 = persistentCount; _dci2 < self.conversation.length; _dci2++) {
                if (self.conversation[_dci2]._biscuit) { _firstBiscuitIdx = _dci2; break; }
            }
            var _seenFacts = false;
            for (var _dci2 = self.conversation.length - 1; _dci2 >= persistentCount; _dci2--) {
                if (self.conversation[_dci2]._biscuit && _dci2 !== _firstBiscuitIdx) {
                    // ★ 合并孤儿 biscuit 中独有的楼层到第一条 biscuit
                    var _orphanLines = _parseBiscuitFromContent(self.conversation[_dci2].content);
                    var _mainLines = _parseBiscuitFromContent(self.conversation[_firstBiscuitIdx].content);
                    var _mainMap = {};
                    for (var _mli = 0; _mli < _mainLines.length; _mli++) { _mainMap[_mainLines[_mli].n] = true; }
                    var _merged = false;
                    for (var _oli = 0; _oli < _orphanLines.length; _oli++) {
                        if (!_mainMap[_orphanLines[_oli].n]) {
                            _mainLines.push(_orphanLines[_oli]);
                            _merged = true;
                        }
                    }
                    if (_merged) {
                        _mainLines.sort(function(a,b) { return a.n - b.n; });
                        self.conversation[_firstBiscuitIdx].content = _mainLines.map(function(l) { return l.text; }).join('\n\n');
                        self.log('◆ Backpack: rescued ' + _orphanLines.length + ' floors from orphan biscuit');
                    }
                    self.conversation.splice(_dci2, 1);
                }
                if (self.conversation[_dci2]._facts) {
                    if (_seenFacts) { self.conversation.splice(_dci2, 1); }
                    else { _seenFacts = true; }
                }
            }

            // ★ V15: fx 注入 — 将 _compressFloor 提取的 facts 注入 biscuit 之后
            if (_newFacts.length > 0) {
                var _fxText = '';
                var _fxNow = new Date();
                var _fxDt = _fxNow.getFullYear() + '-' + String(_fxNow.getMonth()+1).padStart(2,'0') + '-' + String(_fxNow.getDate()).padStart(2,'0') + ' ' + String(_fxNow.getHours()).padStart(2,'0') + ':' + String(_fxNow.getMinutes()).padStart(2,'0') + ':' + String(_fxNow.getSeconds()).padStart(2,'0') + ' UTC+8';
                _fxText = '═══ FACTS ' + _fxDt + ' ═══\n' + _newFacts.join('\n');
                // 找已有 fx 消息 → 原地追加；没有 → 在 biscuit 之后创建
                var _fxFound = _findDynamicMsg(self.conversation, persistentCount, '_facts');
                if (_fxFound) {
                    _fxFound.msg.content = _fxFound.msg.content + '\n\n' + _fxText;
                } else {
                    // 在 biscuit 消息之后插入
                    var _biscuitIdx2 = -1;
                    for (var _bxi = persistentCount; _bxi < self.conversation.length; _bxi++) {
                        if (self.conversation[_bxi]._biscuit) { _biscuitIdx2 = _bxi; break; }
                    }
                    self.conversation.splice(_biscuitIdx2 >= 0 ? _biscuitIdx2 + 1 : persistentCount, 0,
                        { role: 'system', content: _fxText, _dynamic: true, _facts: true });
                }
                // 同步 ctx.facts
                if (!self._ctx.facts) self._ctx.facts = [];
                self._ctx.facts.push({ source: 'f3', extracted_at: Math.floor(Date.now()/1000), text: _newFacts.join('\n') });
                // ★ 清理 compress floor 原始消息（facts 已提取到 fx，原消息不再需要）
                for (var _cfi = self.conversation.length - 1; _cfi >= floorStart; _cfi--) {
                    if (self.conversation[_cfi]._compressFloor) {
                        self.conversation.splice(_cfi, 1);
                    }
                }
            }

            // ── 10. 重置计费计数器 ──
            self._lastApiPromptTokens = 0;
            self._lastApiTotalTokens = 0;
            self._lastApiCompletionTokens = 0;
            // ★ 立即刷新 ctx-btn（否则显示压缩前僵尸值，如 80k→实际已压缩到 ~52k 本地估算）
            if (typeof updateCtxBtn === 'function') updateCtxBtn();

            // ── 12. 更新 _ctx ──
            self._ctx.lastCompressedFloor = floorNum;
            self._ctx.narrative = 'biscuit:' + self._ctx.biscuitLines.length;
            // ★ V15: 不重置 facts（fx 注入已更新 ctx.facts），仅在没有新 facts 时保持不变

            // ── 快照（压缩后） ──
            var afterTokens = self._estimateTotalTokens();
            var saved = beforeTokens - afterTokens;
            _snapshotLog(self, 'after_rebuild', {
                floor: floorNum,
                biscuitFloors: self._ctx.biscuitLines.length,
                afterTokens: Math.round(afterTokens),
                savedTokens: Math.round(saved)
            });

            self.log('◆ Backpack: done — biscuit ' + self._ctx.biscuitLines.length + ' floors, saved ~' + Math.round(saved) + ' tokens');
        } catch (err) {
            // ★ 回滚
            self._ctx.biscuitLines = oldBiscuitLines;

            _snapshotLog(self, 'after_rebuild_failed', {
                floor: floorNum,
                error: err.message || 'unknown'
            });

            self.log('✗ Backpack: rebuild FAILED — ' + (err.message || err));
        }
    };

    // ════════════════════════════════════════════════
    // _compressContext — 保留（V11 不再使用，代码保留供将来 facts grid 用）
    // ════════════════════════════════════════════════
    AgentLoop.prototype._compressContext = async function (reason) {
        // V11: 压缩已改为 per-floor 自动重组（_rebuildBackpack）。
        // 本函数保留但不再由系统自动调用。
     // 将来用于：用户手动触发 → AI 驱动的 facts grid。
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
    // _buildDynamicContext — V13: 动态上下文已在 conversation 中
    // biscuit 消息本身就是动态上下文，无需额外注入
    // ════════════════════════════════════════════════
    AgentLoop.prototype._buildDynamicContext = function () {
        // V13: biscuit 消息已在 conversation 中（_dynamic: true），
        // _callGateway 不需要再额外注入。返回空。
        return '';
    };

    // ════════════════════════════════════════════════
    // _stripAbsoluteBoxes — 阀值压缩：剥离所有 ╔K...╚ 绝对包装盒体部
    //   保留头行（[A → run_command] "cmd" 2318c）和温柔包装盒，仅移除体部。
    //   正则 ╔K[\s\S]*?\n╚\n 锚定行首 ╚，非贪婪，绝不跨越到下一盒子。
    //   可用于手动触发或自动（饼干超阈值）。
    // ════════════════════════════════════════════════
    AgentLoop.prototype._stripAbsoluteBoxes = function (biscuitContent) {
        if (!biscuitContent || typeof biscuitContent !== 'string') return biscuitContent;
        // ★ V14 fix: (?=\n|$) 前瞻不吞 \n，防相邻 ╚\n╔K 共享 \n 被吃掉导致漏网 (6/63=9.5%)
        return biscuitContent.replace(/\n╔K\n[\s\S]*?\n╚(?=\n|$)/g, '\n');
    };

    // ════════════════════════════════════════════════
    // _tryAutoValveCompress — 自动/手动阀值压缩入口
    //   threshold=0 → 强制剥离（手动触发），否则仅当 _lastApiPromptTokens > threshold 时剥离
    //   找 biscuit 消息 → 剥离 ╔K...╚ 体部 → 更新 ctx.biscuitLines
    // ════════════════════════════════════════════════
    AgentLoop.prototype._tryAutoValveCompress = function (threshold) {
        var self = this;
        for (var i = 0; i < self.conversation.length; i++) {
            var m = self.conversation[i];
            if (m._biscuit && m.content) {
                var before = m.content.length;
                m.content = self._stripAbsoluteBoxes(m.content);
                var after = m.content.length;
                if (after < before) {
                    self._ctx.biscuitLines = _parseBiscuitFromContent(m.content);
                    // ★ V14 fix: 同步更新 lastCompressedFloor + narrative，防止 ctx.json 持久化脏数据
                    self._ctx.lastCompressedFloor = self._ctx.totalFloors || self._ctx.biscuitLines.length || 0;
                    self._ctx.narrative = 'biscuit:' + self._ctx.biscuitLines.length;
                    self.log('◆ Valve: stripped ' + (before - after) + ' chars from ╔K...╚ boxes, biscuit ' + self._ctx.biscuitLines.length + ' floors');
                    return true;
                }
                break;
            }
        }
        return false;
    };

    // ★ 阀值压缩入口：传入 biscuit 文本，返回剥离后的文本
    //   暴露为全局函数供 UI 按钮调用
    if (typeof window !== 'undefined') {
        window._stripAbsoluteBoxes = function (text) {
            return AgentLoop.prototype._stripAbsoluteBoxes(text);
        };
    }

    // ★ V13: DE 概念消除，不再需要 _serializeDeBlock 导出。biscuit 包含一切。

})();