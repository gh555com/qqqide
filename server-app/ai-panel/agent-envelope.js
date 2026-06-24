// ============================================================================
// agent-envelope.js — 信封剥离 + UTF-8 安全截断
// 从 agent-loop.js 拆分，供 AgentLoop 核心循环使用
// ============================================================================

// ★ UTF-8 安全截断：取字符串前 maxBytes 字节，不回退到乱码中间
//   先截取 maxBytes*2 字符再编码，避免对几千字 reasoning 全量编码
function _utf8Trunc(str, maxBytes) {
    if (!str) return '';
    var head = str.length > maxBytes * 2 ? str.slice(0, maxBytes * 2) : str;
    var bytes = new TextEncoder().encode(head);
    if (bytes.length <= maxBytes) return head;
    for (var i = maxBytes; i > maxBytes - 4; i--) {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, i)); }
        catch (_) { }
    }
    return new TextDecoder().decode(bytes.slice(0, maxBytes)); // 兜底（含替换符）
}

// ═══ EnvelopeStripper: 流式剥离 ___qqq_env___ 信封 + <floor_summary> 回退 ═══
// "硬约束桥" — 代码强行剥离并校验结构化信封，不靠 prompt 自觉
function EnvelopeStripper(onToken) {
    this.onToken = onToken;
    this.raw = '';
    this.emitted = 0;
    // 主线：信封格式
    this._ENV_OPEN = '___qqq_env___';
    this._ENV_CLOSE = '___end___';
    // 回退：旧 <floor_summary> 标签（过渡期兼容）
    this._FALL_OPEN = '<floor_summary';
    this._FALL_CLOSE = '</floor_summary>';
}
EnvelopeStripper.prototype._firstBlockStart = function () {
    var envIdx = this.raw.indexOf(this._ENV_OPEN);
    var fallIdx = this.raw.indexOf(this._FALL_OPEN);
    if (envIdx === -1) return fallIdx;
    if (fallIdx === -1) return envIdx;
    return Math.min(envIdx, fallIdx);
};
EnvelopeStripper.prototype.push = function (chunk) {
    if (!chunk) return;
    this.raw += chunk;
    var blockStart = this._firstBlockStart();
    var safeUpTo;
    if (blockStart >= 0) {
        safeUpTo = blockStart;
    } else {
        // 留最后 N 字符防截断（取最长标记长度）
        var margin = Math.max(this._ENV_OPEN.length, this._FALL_OPEN.length);
        safeUpTo = Math.max(this.emitted, this.raw.length - margin);
    }
    if (safeUpTo > this.emitted) {
        var piece = this.raw.slice(this.emitted, safeUpTo);
        if (this.onToken) this.onToken(piece);
        this.emitted = safeUpTo;
    }
};
EnvelopeStripper.prototype.finalize = function () {
    // 发射残留安全内容
    var blockStart = this._firstBlockStart();
    if (blockStart < 0 && this.emitted < this.raw.length) {
        var piece = this.raw.slice(this.emitted);
        if (this.onToken) this.onToken(piece);
        this.emitted = this.raw.length;
    }

    // 尝试解析信封 JSON
    var envelope = null;
    var envMatch = this.raw.match(/___qqq_env___\s*\n?(\{[\s\S]*?\})\s*\n?___end___/);
    if (envMatch) {
        try {
            envelope = JSON.parse(envMatch[1]);
        } catch (_) { /* malformed JSON, fall through */ }
    }

    // 回退：解析旧 <floor_summary>
    var summary = '', lang = '';
    var fallMatch = this.raw.match(/<floor_summary([^>]*)>([\s\S]*?)(?:<\/floor_summary>|$)/);
    if (fallMatch) {
        summary = (fallMatch[2] || '').trim();
        var langMatch = fallMatch[1].match(/lang=["']([^"']+)["']/);
        if (langMatch) lang = langMatch[1];
    }

    // 信封优先：envelope.floor_summary 覆盖旧格式
    if (envelope && envelope.floor_summary) {
        summary = envelope.floor_summary;
        lang = '';  // 信封无 lang 属性
    }

    // 清理：移除信封块 + 旧 floor_summary 标签
    var cleanContent = this.raw
        // ★ 不依赖 $ 结尾：信封和 floor_summary 可能不在末尾
        .replace(/\s*___qqq_env___[\s\S]*?___end___\s*/g, '')
        .replace(/\s*<floor_summary[^>]*>[\s\S]*?(?:<\/floor_summary>|$)\s*/g, '')
        // ★ [DYNAMIC CONTEXT] 块：从该标记一直删到下一个段落分隔或文本末尾
        .replace(/\[DYNAMIC CONTEXT\][\s\S]*?(?=\n\n|$)/g, '')
        .trim();

    cleanContent = cleanContent.replace(/\x0a{3,}/g, '\x0a\x0a').replace(/^\x0a+/, '');

    // ═══ 文本工具调用回生引擎（统一入口） ═══
    // 当模型在 content 中输出工具调用（XML/Action: 格式）而非原生 delta.tool_calls，
    // 解析为可执行结构，防止楼层空转。
    var _textToolCalls = [];
    // ★ DEBUG: 日志 cleanContent 前 500 字符，诊断文本工具调用是否进入解析器
    if (cleanContent && cleanContent.length > 0) {
        var _previewLen = Math.min(500, cleanContent.length);
        console.log('[EnvelopeStripper] cleanContent (' + cleanContent.length + ' chars): ' + JSON.stringify(cleanContent.slice(0, _previewLen)));
    }

    // ── 1) XML 格式：<invoke name="..."><parameter name="...">...</parameter></invoke> ──
    //    兼容 <function_call> <qqq_tool_calls> 等变体
    var _xmlBlocks = [];
    // 提取所有含 name 属性的 invoke/function_call 块（含内嵌 parameter）
    var _invokeRe = /<(?:invoke|function_call)\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:invoke|function_call)>/gi;
    // ★ DEBUG: 诊断 _invokeRe 为什么不匹配
    console.log('[EnvelopeStripper] _invokeRe.test cleanContent: ' + _invokeRe.test(cleanContent) + ', cleanContent len=' + cleanContent.length);
    _invokeRe.lastIndex = 0;
    var _xm;
    while ((_xm = _invokeRe.exec(cleanContent)) !== null) {
        var _xName = _xm[1];
        var _xBody = _xm[2];
        var _xArgs = {};
        // 提取 <parameter name="k">v</parameter> 或 <parameter name="k" value="v"/>
        var _paramRe = /<parameter\s[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*?(?:>([\s\S]*?)<\/parameter>|\bvalue\s*=\s*["']([^"']*)["'][^>]*\/>)/gi;
        var _pm;
        while ((_pm = _paramRe.exec(_xBody)) !== null) {
            var _pName = _pm[1];
            var _pVal = (_pm[2] !== undefined) ? _pm[2].trim() : (_pm[3] || '');
            // 尝试解析 JSON 值（数组/对象），失败则保留字符串
            try { _pVal = JSON.parse(_pVal); } catch (_) { }
            _xArgs[_pName] = _pVal;
        }
        _xmlBlocks.push({ full: _xm[0], name: _xName, args: _xArgs });
    }
    // 提取自闭合 <invoke name="..." ... /> （无 body，参数全在属性上）
    var _selfCloseRe = /<(?:invoke|function_call)\s[^>]*?\bname\s*=\s*["']([^"']+)["']([^>]*?)\/>/gi;
    var _scm;
    while ((_scm = _selfCloseRe.exec(cleanContent)) !== null) {
        var _scName = _scm[1];
        var _scAttrs = _scm[2];
        var _scArgs = {};
        // 从属性中提取 key="value" 对（排除 name 本身）
        var _attrRe = /\b(?!name\b)(\w[\w-]*)\s*=\s*["']([^"']*)["']/gi;
        var _am;
        while ((_am = _attrRe.exec(_scAttrs)) !== null) {
            var _aVal = _am[2];
            try { _aVal = JSON.parse(_aVal); } catch (_) { }
            _scArgs[_am[1]] = _aVal;
        }
        _xmlBlocks.push({ full: _scm[0], name: _scName, args: _scArgs });
    }
    // ★ 新增：<tool_name attr="value" ... /> 格式（模型用工具名直接当标签名）
    var _toolTagNames = ['read_file', 'search_file', 'edit_file', 'search_text', 'search_content', 'list_files', 'find_files', 'write_file', 'create_file', 'delete_file', 'fetch_webpage', 'get_diagnostics', 'generate_image', 'analyze_image', 'run_command', 'search_web'];
    var _toolTagRe = new RegExp('<(' + _toolTagNames.join('|') + ')\\s([^>]*?)\\/>', 'gi');
    var _ttm;
    while ((_ttm = _toolTagRe.exec(cleanContent)) !== null) {
        var _ttName = _ttm[1];
        var _ttAttrs = _ttm[2];
        var _ttArgs = {};
        var _attrRe2 = /\b(\w[\w-]*)\s*=\s*["']([^"']*)["']/gi;
        var _am2;
        while ((_am2 = _attrRe2.exec(_ttAttrs)) !== null) {
            var _aKey = _am2[1];
            if (_aKey === 'as') continue;  // 模型幻觉属性，忽略
            var _aVal2 = _am2[2];
            try { _aVal2 = JSON.parse(_aVal2); } catch (_) { }
            _ttArgs[_aKey] = _aVal2;
        }
        _xmlBlocks.push({ full: _ttm[0], name: _ttName, args: _ttArgs });
    }
    // 解析后的 XML 块转为 textToolCalls + 从 content 剥离
    for (var _xbi = 0; _xbi < _xmlBlocks.length; _xbi++) {
        var _xb = _xmlBlocks[_xbi];
        var _callId = 'xml_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        _textToolCalls.push({
            id: _callId,
            type: 'function',
            function: {
                name: _xb.name,
                arguments: JSON.stringify(_xb.args)
            }
        });
        // 剥离已解析的 XML 块（精确替换）
        cleanContent = cleanContent.replace(_xb.full, '');
    }
    // ★ DEBUG: 日志解析结果
    console.log('[EnvelopeStripper] _xmlBlocks found: ' + _xmlBlocks.length + ', _textToolCalls: ' + _textToolCalls.length);
    if (_textToolCalls.length > 0) {
        console.log('[EnvelopeStripper] textToolCalls names: ' + _textToolCalls.map(function (tc) { return tc.function.name; }).join(', '));
    }
    // 残留 XML 标签清除（<qqq_tool_calls> <tool_call> <function_calls> 等无参数包裹标签）
    cleanContent = cleanContent.replace(/<\/?qqq_tool_calls>/gi, '');
    cleanContent = cleanContent.replace(/<\/?_?tool_calls?[^>]*>/gi, '');
    cleanContent = cleanContent.replace(/<\/?_?tool_call[^>]*>/gi, '');
    cleanContent = cleanContent.replace(/<\/?function_calls?[^>]*>/gi, '');
    cleanContent = cleanContent.replace(/<parameter[\s>][^>]*>[\s\S]*?<\/parameter>/gi, '');
    cleanContent = cleanContent.replace(/<parameter[\s>][^>]*\/>/gi, '');

    // ── 2) ReAct 格式：Action: tool_name\nAction Input: {...} ──
    if (/^Action:\s*\w+/m.test(cleanContent)) {
        var _actionPat = /^Action:\s*(\w[\w.-]*).*(?:\nAction Input:\s*(\{[\s\S]*?\}))?/gm;
        var _m;
        while ((_m = _actionPat.exec(cleanContent)) !== null) {
            var _name = _m[1];
            var _argsStr = _m[2] || '{}';
            var _argsParsed;
            try { _argsParsed = JSON.parse(_argsStr); } catch (_) { _argsParsed = {}; }
            var _callId2 = 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            _textToolCalls.push({
                id: _callId2,
                type: 'function',
                function: {
                    name: _name,
                    arguments: JSON.stringify(_argsParsed)
                }
            });
        }
        cleanContent = cleanContent.replace(/^Action:\s*\w[\w.-]*.*(?:\nAction Input:\s*\{[\s\S]*?\})?/gm, '');
        cleanContent = cleanContent.replace(/^Action Input:\s*\{[\s\S]*?\}/gm, '');
    }

    // 统一收尾：去除清理产生的连续空行
    cleanContent = cleanContent.replace(/\x0a{3,}/g, '\x0a\x0a').replace(/^\x0a+/, '').trim();

    return { cleanContent: cleanContent, envelope: envelope, summary: summary, lang: lang, textToolCalls: _textToolCalls };
};
