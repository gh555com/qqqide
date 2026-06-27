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
