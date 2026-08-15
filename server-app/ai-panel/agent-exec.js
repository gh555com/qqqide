// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// agent-exec.js — 并行工具执行引擎 + 分层调度
// 从 agent-loop.js 拆分，为 AgentLoop.prototype 添加工具执行相关方法
// 依赖：AgentLoop（由 agent-loop.js 定义），executeTool（由 tools.js 定义），TOOL_CATEGORY（由 tools.js 定义）
// ============================================================================

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
    // ★ 工具执行活跃标志（2026-08-12，q181 f21 事故）：工具执行期间无 onToken/onCost 信号，
    //   长工具（上传 116MB / 长命令）会被 20 分钟零进展看门狗误判为停滞拉断。
    //   执行期间保持 true → 停滞看门狗续命；挂死工具由 ghrun 15min 失速看门狗兜底杀（< 20min）
    self._toolExecActive = true;
    try {
        for (var li = 0; li < layers.length; li++) {
            // ★ Stop 守卫：用户点停止后立即中断工具执行
            if (self._stopCtrl.signal.aborted) {
                self._log('■ tool execution aborted: user killed (layer ' + (li + 1) + '/' + layers.length + ')');
                break;
            }
            var layer = layers[li];
            var promises = layer.items.map(async function (item) {
                var toolStart = Date.now();
                var result;
                // ★ 埋 trace 标记，供钩子 Q 读取（quest/floor/house/room 溯源）
                if (typeof window !== 'undefined') {
                    window._qqqCurrentTrace = {
                        questId: self._questId || '',
                        floorNum: self._currentFloorNum || 0,
                        houseIdx: self._houseIndex || 0,
                        roomIdx: item._toolIndex || 0
                    };
                }
                try {
                    var _isSearch = item.name === 'search_text' || item.name === 'search_content' || item.name === 'search_file'
                        || item.name === 'find_files' || item.name === 'list_files'
                        || item.name === 'search_symbol' || item.name === 'grep_code'
                        || item.name === 'search_smart';
                    result = await executeTool(item.name, item.args, self);
                } catch (err) {
                    result = 'Tool error: ' + (err.message || err);
                }
                if (typeof window !== 'undefined') { window._qqqCurrentTrace = null; }
                var toolMs = Date.now() - toolStart;
                var resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                // ★ 搜索结果智能分组：信号前置 + 噪音折叠（不删任何信息）
                if (_isSearch && resultStr.length > 1200) {
                    var _lines = resultStr.split('\n');
                    var _signal = [];    // 源文件路径
                    var _noise = {};     // 噪音按类别计数
                    var _srcExts = /\.(js|mjs|ts|tsx|py|html|htm|css|scss|go|rs|java|cpp|c|h|json|txt|md|yml|yaml|sh|bash|bat|xml|sql|lua|rb|php|swift|kt|r|toml|cfg|ini|conf)$/i;
                    var _noiseDirs = /(node_modules|\.git|blobs|__pycache__|\.next|dist|build|cache)[\\/]/;
                    var _noiseExts = /\.(gz|zip|tar|exe|dll|so|dylib|wasm|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|pdf|log|lock|map|min\.(js|css))$/i;
                    for (var _li = 0; _li < _lines.length; _li++) {
                        var _line = _lines[_li].trim();
                        if (!_line) continue;
                        var _isPathLine = /^[A-Za-z]:[\\/]/.test(_line) || /^\//.test(_line);
                        if (_isPathLine) {
                            if (_noiseDirs.test(_line)) {
                                var _cat = _line.match(_noiseDirs)[0].replace(/[\\/]/g, '');
                                _noise[_cat] = (_noise[_cat] || 0) + 1;
                            } else if (_srcExts.test(_line)) {
                                _signal.push(_line);
                            } else if (_noiseExts.test(_line)) {
                                _noise['binary'] = (_noise['binary'] || 0) + 1;
                            } else {
                                _signal.push(_line);  // 未知类型视为信号
                            }
                        } else {
                            _signal.push(_line);  // 非路径行（如上下文匹配行）保留
                        }
                    }
                    var _MAX_SIGNAL = 30;
                    if (_signal.length > 0 || Object.keys(_noise).length > 0) {
                        var _parts = [];
                        if (_signal.length > 0) {
                            var _show = _signal.slice(0, _MAX_SIGNAL);
                            _parts.push(_show.join('\n'));
                            if (_signal.length > _MAX_SIGNAL) {
                                _parts.push('... (' + (_signal.length - _MAX_SIGNAL) + ' more source files)');
                            }
                        }
                        if (Object.keys(_noise).length > 0) {
                            var _noiseSummary = [];
                            for (var _nk in _noise) {
                                if (_noise.hasOwnProperty(_nk)) _noiseSummary.push(_nk + ': ' + _noise[_nk] + ' entries');
                            }
                            _parts.push('[NOISE] ' + _noiseSummary.join(', ') + ' — ignored (use read_file for source files above)');
                        }
                        resultStr = _parts.join('\n');
                    }
                }
                self._log('← ' + item.name + ' (' + toolMs + 'ms): ' + resultStr.slice(0, 120));
                if (onToolResult) {
                    var truncated = resultStr.length > 2000;
                    onToolResult(item.name, truncated ? resultStr.slice(0, 2000) + '\n... (truncated)' : resultStr, truncated);
                }
                // ★ 统一内容门：上下文+落盘同一函数
                //   read_file 显式指定行号范围 → bypassCap，信任 AI 意图
                //   ★ 2026-08-14 q145 f5 事故：read_file(start=1,end=105) 读单行 minified JSON（1.33M 字符含 base64）
                //     信任意图裸注入 → 上下文 1.18M tokens → 上游静默拒绝（usage-only 空流）→ 楼层 fatal。
                //     bypass 加 200K 字符硬顶：超限回落标准 50K 门，保意图设计同时杜绝单条结果撑爆上下文。
                var _bypass = item.name === 'read_file' && item.args && item.args.start_line && item.args.end_line && resultStr.length <= 200000;
                var gated = (typeof ContentGateway !== 'undefined' && ContentGateway.gate)
                    ? ContentGateway.gate(resultStr, { bypassCap: _bypass })
                    : resultStr;
                return { call: item.call, content: gated, rawContent: resultStr };
            });
            var results = await Promise.all(promises);
            var lastHouse = self._houses[self._houses.length - 1];
            if (lastHouse && lastHouse.type === 'tools') {
                lastHouse.toolResults = results.map(function (r) { return r.content; });
                lastHouse._lines = null;  // 使 UI 端 _buildHouseLines 缓存失效
            }
            for (var ri = 0; ri < results.length; ri++) {
                allResults.push(results[ri]);
            }
        }
        // ★ 工具执行完毕后，刷新 effect house（remove_background/generate_image/analyze_image/search_web 等）
        var effectStore = self._effectCostStore;
        if (effectStore && effectStore.length) {
            for (var ei = 0; ei < effectStore.length; ei++) {
                var ec = effectStore[ei];
                self._houseIndex++;
                self._houses.push({
                    index: self._houseIndex,
                    type: 'effect',
                    effectType: ec.effectType,
                    tools: [],
                    toolResults: [],
                    ts: ec.ts,
                    ms: 0,
                    reasoning: '',
                    answer: '',
                    wgeCost: ec.wgeCost || 0,
                    model: '',
                    cacheHitRate: -1,
                    usage: null,
                    billingSeq: 0,
                    billingRequestId: String(ec.billingRequestId || self._floorId || ''),
                    tier: self._lastTier ? self._lastTier.label : ''
                });
            }
            self._effectCostStore = null;
        }
    } finally {
        self._toolExecActive = false;
    }
    return { allResults: allResults, assistantMsg: assistantMsg };
};
// ---- 孤儿 tool 修复：发送前双向扫描（2026-08-11 恢复实现） ----
// 铁律 6.3 承诺的预检防线：实现曾在历史重构中被删除，仅剩 agent-gateway.js 死调用
// （typeof 检查恒 false → 预检从未生效）。
// 事故链（2026-08-11 客户实锤 + q181 f14/f17 本地样本）：
//   fatal 楼层最后一条 = tool 结果 → 恢复发送 slice(floorStartIdx) 开头即孤儿 tool
//   （配对 assistant 在 slice 外）→ 落盘 → 重启 restore 拼接 → 发送 400
//   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
// 语义：tool 消息必须跟随含其 tool_call_id 的 assistant(tool_calls)；无配对者直接删除
//   （结果已无法被上游消费，保留必 400）。assistant(tool_calls) 无结果 = API 合法，不动。
AgentLoop.prototype._repairOrphanedToolCalls = function () {
    var conv = this.conversation;
    if (!conv || conv.length === 0) {
        this._lastRepairLen = 0;
        this._lastRepairHadWork = false;
        return 0;
    }
    var pending = {};
    var seen = {};
    var removed = 0;
    for (var i = 0; i < conv.length; i++) {
        var m = conv[i];
        if (!m || typeof m !== 'object') { conv.splice(i, 1); i--; removed++; continue; }
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            pending = {};
            for (var j = 0; j < m.tool_calls.length; j++) {
                var tc = m.tool_calls[j];
                if (tc && tc.id) pending[tc.id] = true;
            }
        } else if (m.role === 'tool') {
            var tid = m.tool_call_id;
            if (!tid || !pending[tid] || seen[tid]) {
                conv.splice(i, 1);
                i--;
                removed++;
            } else {
                seen[tid] = true;
            }
        } else {
            // ★ 2026-08-12 补强：tool 结果必须紧跟 assistant(tool_calls)，中间出现任何
            //   其他消息（user / system / assistant 无 tool_calls）即视为错位 → 清空 pending。
            //   否则孤儿 tool 错位到 user 消息之后时，残留旧 tool_call_id 会误保留它 → 发送 400
            //   "tool must be a response to a preceding message with tool_calls"。
            pending = {};
        }
    }
    this._lastRepairLen = conv.length;
    this._lastRepairHadWork = removed > 0;
    if (removed > 0) {
        this._log('🧹 orphan tool repair: removed ' + removed + ' tool message(s) without matching assistant.tool_calls');
        if (typeof this._writeFileLog === 'function') {
            this._writeFileLog('🧹 orphan tool repair: removed ' + removed + ' tool message(s) without matching assistant.tool_calls');
        }
    }
    return removed;
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
