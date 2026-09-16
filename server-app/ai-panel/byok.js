// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// byok.js — 自带 API Key 机器（用户自带第三方 API Key 直连）
//
// 定位：让用户配置自己的 OpenAI 兼容端点，对话请求绕过平台网关直连其服务商。
//       平台红线不变：平台自有通道的模型名/厂商名/端点字符串保持零暴露——
//       本模块出现的一切厂商信息均来自【用户输入】（用户自己的选择），非平台上游。
//
// 唯一真理源：全局 state 命名空间 'qqq.byok'（设备本地；无云同步、无项目绑定）
// 消费点（唯一）：ai-gateway.js chatFetch 顶部 intercept() 分支
//
// 职责：
//   1. 配置读写（qgs.simple('qqq.byok')，键 'cfg'）——跨面板/窗口共享，变更即时刷新
//   2. 请求构造（平台 body → OpenAI 兼容 body：剥离平台内部字段 + max_tokens 帽对齐）
//   3. 直连 fetch（渲染层直连；目标端点支持浏览器跨域时天然可用）
//   4. 设置 UI（tier 组 "Z" 按钮 → 弹窗：启用/地址/Key/模型/思考参数/网络通道/测试连接）
//      ★ 思考参数与平台档位解耦（2026-09-16 用户定）：勾选后由用户自选档位（low/medium/high/max）
//        或填自定义 JSON（有效则优先整体合入请求体）——不再跟随 1/2/3 档映射
//   5. 平台代理通道（网络通道=平台代理）：单信封提交平台 byok-chat 端点 → US 出口转发；
//      零自定义请求头（零 CORS 依赖）；平台不落盘 Key、不记录对话内容；直连为默认推荐
//   6. 本地模型直通：本机模型（Ollama/LM Studio 等 OpenAI 兼容）开箱可用——无协议头自动补
//      http/https（本地地址→http）、仅 host 自动补 /v1、Key 可留空（跳过授权头）、本地地址强制直连
//   7. 密钥静态加密：壳层 bridge.secure（safeStorage/DPAPI）——仅存密文（apiKeyEnc 字段）；
//      旧明文存量加载自动迁移；桥缺失/加密失败自动回退明文（零破坏）
//   8. 身份头（2026-09-16）：对话请求 index 0 注入最小身份声明（qqq AI + 语言 + 工具指引）；
//      服务端甲壳绝不经本通道外发（防提取 + 用户自付 token）；_ 前缀内部标记字段外发前剥离
//
// 边界：本模块只管【对话】通道；贴图识别/生图/抠图/搜索等仍走平台内置通道。
// ============================================================================

;(function () {
    'use strict';

    var NS = 'qqq.byok';
    var KEY = 'cfg';

    // ── i18n 辅助（优先面板本帧 _i（index.html 全局助手）；回退父窗口；再回退中文字面量）──
    function _t(key, fb) {
        try { if (typeof _i === 'function') return _i(key, fb); } catch (_) { }
        try { if (parent && parent._i) return parent._i(key, fb); } catch (_) { }
        return fb;
    }

    // ── 配置内存缓存 ──
    var _cfg = null;         // null=未加载；对象=已加载
    var _loading = null;     // in-flight promise（并发去重）
    var _store = null;       // qgs.simple handle
    var _chgSub = null;      // onChange 订阅

    function _emptyCfg() {
        return { enabled: false, baseUrl: '', apiKey: '', apiKeyEnc: '', model: '', sendThinking: false, thinkLevel: 'high', thinkJson: '', route: 'direct', testedAt: 0, _locked: '' };
    }

    function _qgsSimple() {
        // 面板 iframe 内经父窗口取 qgs（唯一真理源：主窗口 state-sdk.js）
        try {
            if (parent && parent.qgs && typeof parent.qgs.simple === 'function') return parent.qgs.simple(NS);
        } catch (_) { }
        try {
            if (window.qgs && typeof window.qgs.simple === 'function') return window.qgs.simple(NS);
        } catch (_) { }
        return null;
    }

    // ── 安全存储桥（壳层 safeStorage/DPAPI；缺失/不可用 → 明文回退，零破坏）──
    var _secOk = null;      // null=未探测；true/false=会话级结果
    var _secProbe = null;   // in-flight 去重
    function _secureBridge() {
        try { if (parent && parent.qqqideBridge && parent.qqqideBridge.secure) return parent.qqqideBridge.secure; } catch (_) { }
        try { if (window.qqqideBridge && window.qqqideBridge.secure) return window.qqqideBridge.secure; } catch (_) { }
        return null;
    }
    function _secureUsable() {
        if (_secOk !== null) return Promise.resolve(_secOk);
        if (_secProbe) return _secProbe;
        var s = _secureBridge();
        if (!s || typeof s.available !== 'function') { _secOk = false; return Promise.resolve(false); }
        _secProbe = Promise.resolve(s.available()).then(function (r) {
            _secOk = !!(r && r.ok && r.available);
            return _secOk;
        }).catch(function () { _secOk = false; return false; });
        return _secProbe.then(function (v) { _secProbe = null; return v; });
    }

    function _normalize(raw) {
        var c = _emptyCfg();
        if (raw && typeof raw === 'object') {
            if (typeof raw.enabled === 'boolean') c.enabled = raw.enabled;
            if (typeof raw.baseUrl === 'string') c.baseUrl = raw.baseUrl.trim();
            if (typeof raw.apiKey === 'string') c.apiKey = raw.apiKey.trim();
            if (typeof raw.apiKeyEnc === 'string') c.apiKeyEnc = raw.apiKeyEnc.trim();
            if (typeof raw.model === 'string') c.model = raw.model.trim();
            if (typeof raw.sendThinking === 'boolean') c.sendThinking = raw.sendThinking;
            if (typeof raw.thinkLevel === 'string' && /^(low|medium|high|max)$/.test(raw.thinkLevel)) c.thinkLevel = raw.thinkLevel;
            if (typeof raw.thinkJson === 'string') c.thinkJson = raw.thinkJson.trim();
            if (raw.route === 'relay' || raw.route === 'direct') c.route = raw.route;
            if (typeof raw.testedAt === 'number') c.testedAt = raw.testedAt;
        }
        return c;
    }

    // 磁盘原始记录 → 内存配置（apiKey = 解密后明文；apiKeyEnc = 磁盘密文原样；_locked = 未能解锁原因）
    async function _hydrate(raw) {
        var c = _normalize(raw);
        if (c.apiKeyEnc) {
            var usable = await _secureUsable();
            if (usable) {
                var r = null;
                try { r = await _secureBridge().decrypt(c.apiKeyEnc); } catch (_) { }
                if (r && r.ok && typeof r.text === 'string' && r.text) {
                    c.apiKey = r.text;
                } else {
                    c.apiKey = '';
                    c._locked = 'decrypt';
                }
            } else {
                c.apiKey = '';
                c._locked = 'bridge';
            }
        }
        return c;
    }

    async function _load(force) {
        if (_cfg && !force) return _cfg;
        if (_loading) return _loading;
        _loading = (async function () {
            var st = _qgsSimple();
            _store = st;
            var raw = null;
            try { if (st) raw = await st.get(KEY); } catch (_) { }
            _cfg = await _hydrate(raw);
            if (!_chgSub && st && typeof st.onChange === 'function') {
                try {
                    _chgSub = st.onChange(function (k, v) {
                        if (k !== KEY) return;
                        // 其他窗口写入 → 解密重载（异步；带 _locked 状态刷新按钮）
                        _hydrate(v).then(function (c) { _cfg = c; _refreshButton(); }).catch(function () { });
                    });
                } catch (_) { }
            }
            _refreshButton();
            // ★ 迁移：旧明文存量 + 加密可用 → 就地加密重写（静默；任何失败保明文）
            if (st && _cfg.apiKey && !_cfg.apiKeyEnc) {
                try {
                    var usable = await _secureUsable();
                    if (usable) {
                        var stored = await _buildStored(_cfg);
                        if (stored && stored.apiKeyEnc) {
                            await st.setNow(KEY, stored);
                            _cfg.apiKeyEnc = stored.apiKeyEnc;
                        }
                    }
                } catch (_) { }
            }
            return _cfg;
        })();
        try { return await _loading; } finally { _loading = null; }
    }

    function get() { return _cfg ? _cfg : _emptyCfg(); }

    function _isConfigured(c) {
        c = c || get();
        // Key 可留空（本地模型：Ollama/LM Studio 等不校验授权）；地址/模型名必填
        return !!(c.model && c.baseUrl);
    }
    function isActive() { var c = get(); return !!(c.enabled && _isConfigured(c)); }

    // 内存配置 → 磁盘形态（有 Key：可加密则仅存密文，否则明文兜底；无 Key：保留既有密文防误清）
    async function _buildStored(next) {
        var stored = {
            enabled: !!next.enabled,
            baseUrl: String(next.baseUrl || '').trim(),
            apiKey: '',
            apiKeyEnc: '',
            model: String(next.model || '').trim(),
            sendThinking: !!next.sendThinking,
            thinkLevel: /^(low|medium|high|max)$/.test(String(next.thinkLevel || '')) ? next.thinkLevel : 'high',
            thinkJson: String(next.thinkJson || '').trim(),
            route: (next.route === 'relay') ? 'relay' : 'direct',
            testedAt: (typeof next.testedAt === 'number' && next.testedAt > 0) ? next.testedAt : 0
        };
        if (next.apiKey) {
            var usable = await _secureUsable();
            if (usable) {
                var r = null;
                try { r = await _secureBridge().encrypt(next.apiKey); } catch (_) { }
                if (r && r.ok && r.b64) { stored.apiKeyEnc = r.b64; return stored; }
            }
            stored.apiKey = next.apiKey;
            return stored;
        }
        if (next.apiKeyEnc) stored.apiKeyEnc = next.apiKeyEnc;
        return stored;
    }

    async function save(patch) {
        await _load();
        var next = Object.assign({}, _cfg, patch || {});
        next.baseUrl = String(next.baseUrl || '').trim();
        if (_isLocalBase(next.baseUrl)) next.route = 'direct';   // 本地模型：平台代理无意义（服务端到不了你的本机），一律直连
        next.apiKey = String(next.apiKey || '').trim();
        next.model = String(next.model || '').trim();
        var stored = await _buildStored(next);
        _cfg = _normalize(stored);
        if (next.apiKey) _cfg.apiKey = next.apiKey;   // 本会话内存保留明文（立即可用）
        _cfg.apiKeyEnc = stored.apiKeyEnc || '';
        _cfg._locked = (!_cfg.apiKey && stored.apiKeyEnc) ? (next._locked || 'bridge') : '';
        _refreshButton();
        var st = _store || _qgsSimple();
        _store = st;
        try { if (st) await st.setNow(KEY, stored); } catch (_) { }
        return _cfg;
    }

    // ── 本地/内网地址判定（本地模型直通：Ollama/LM Studio/llama.cpp 等同机/内网端点）──
    function _isLocalBase(baseUrl) {
        var u = String(baseUrl || '').trim();
        if (!u) return false;
        u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');          // 去协议
        var host = u.split(/[\/?#]/)[0].replace(/^[^@]*@/, '');  // host[:port]
        host = host.replace(/:\d+$/, '').toLowerCase();
        if (!host) return false;
        if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
        if (/^(0|127|10)\./.test(host)) return true;                      // 0.x/127.x/10.x
        if (/^192\.168\./.test(host)) return true;
        var m = host.match(/^172\.(\d{1,2})\./);
        if (m && parseInt(m[1], 10) >= 16 && parseInt(m[1], 10) <= 31) return true;
        if (/\.local$/.test(host)) return true;
        if (host.indexOf('.') === -1) return true;                        // 裸主机名（如 mybox:11434）
        return false;
    }

    // ── 端点归一：任何写法都收敛到 …/chat/completions ──
    // 无协议头：本地/内网 → http://，公网 → https://；仅 host（无路径）→ 自动补 /v1
    function _endpoint(baseUrl) {
        var raw = String(baseUrl || '').trim();
        if (!raw) return '';
        var u = raw;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = (_isLocalBase(u) ? 'http://' : 'https://') + u;
        u = u.replace(/\/+$/, '');
        if (/\/chat\/completions$/.test(u)) return u;
        if (/^[a-z][a-z0-9+.-]*:\/\/[^\/]+$/i.test(u)) u += '/v1';
        return u + '/chat/completions';
    }

    // ── max_tokens 帽：镜像服务端 handlers_ai_chat.go 防御纵深（estPrompt+max ≤ 1048565-10000）──
    var _AI_CTX_MAX = 1048565;
    var _SAFETY_MARGIN = 10000;
    function _capMaxTokens(out) {
        try {
            var bytes = new TextEncoder().encode(JSON.stringify(out)).length;
            var est = Math.floor(bytes / 3);
            var raw = parseInt(out.max_tokens, 10) || 0;
            if (raw > 0 && est + raw > _AI_CTX_MAX - _SAFETY_MARGIN) {
                out.max_tokens = Math.max(1024, _AI_CTX_MAX - est - _SAFETY_MARGIN);
            }
        } catch (_) { }
    }

    // ── 请求体构造：平台 body → 用户端点 body ──
    // ★ 平台内部字段（floor_id / house_hint / tier / model 映射值）绝不外发
    // ★ 思考参数：与平台档位解耦（详下方内注释）
    // ★ 身份头（2026-09-16）：BYOK 请求在 index 0 注入最小身份声明——用户模型以
    //   qqq AI 身份服务（与平台通道体验一致）；服务端甲壳绝不经本通道外发（甲壳为服务端
    //   防提取设计 + 用户自付 token，且其平台内部规则与本场景无关）
    var _ID_PREAMBLE = 'You are qqq AI, the built-in IDE assistant. Help the user with their project using the provided tools. Always reply in the user\'s language. If asked who you are, answer: "I am qqq AI."';

    // 消息净化：剥离平台内部标记字段（_ 前缀：_persistent/_biscuit/_floor/_dynamic 等），
    // 仅发标准线上字段（role/content/tool_calls/tool_call_id/name/reasoning_content…），
    // 防严格校验的服务商对未知字段报 400；不改动原数组（逐条浅拷贝后过滤）
    function _sanitizeMessages(arr) {
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var m = arr[i];
            if (!m || typeof m !== 'object') continue;
            var c = {};
            for (var k in m) {
                if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
                if (k.charAt(0) === '_') continue;
                c[k] = m[k];
            }
            out.push(c);
        }
        return out;
    }

    function _buildBody(body, opts, cfg) {
        var msgs = _sanitizeMessages((body && body.messages) || []);
        msgs.unshift({ role: 'system', content: _ID_PREAMBLE });
        var out = {
            model: cfg.model,
            messages: msgs,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: (body && body.max_tokens) || ((typeof ContentGateway !== 'undefined' && ContentGateway.MAX_RESPONSE_TOKENS) ? ContentGateway.MAX_RESPONSE_TOKENS : 393216)
        };
        if (body && body.tools && body.tools.length) {
            out.tools = body.tools;
            if (body.tool_choice) out.tool_choice = body.tool_choice;
        }
        // ★ 思考参数（2026-09-16 解耦：不再跟随平台档位 1/2/3，完全由用户配置）
        //   优先自定义 JSON（有效对象 → 逐键合入请求体，可表达任意服务商格式）；
        //   否则按所选档位发送 reasoning_effort（实测 DeepSeek / OpenAI 兼容端点均接受）。
        if (cfg.sendThinking) {
            var applied = false;
            var custom = String(cfg.thinkJson || '').trim();
            if (custom) {
                try {
                    var obj = JSON.parse(custom);
                    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                        for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]; }
                        applied = true;
                    }
                } catch (_) { }
            }
            if (!applied) {
                var lvl = /^(low|medium|high|max)$/.test(String(cfg.thinkLevel || '')) ? cfg.thinkLevel : 'high';
                out.reasoning_effort = lvl;
            }
        }
        _capMaxTokens(out);
        return out;
    }

    // ── 错误响应归一（各家错误格式 → {error:"人类可读"}，防 [object Object] 上屏）──
    async function _normalizeError(resp) {
        var txt = '';
        try { txt = await resp.text(); } catch (_) { }
        var msg = '';
        try {
            var j = JSON.parse(txt || '{}');
            var e = j && j.error;
            if (typeof e === 'string') msg = e;
            else if (e && typeof e === 'object') msg = e.message || e.msg || '';
            if (!msg && j && typeof j.message === 'string') msg = j.message;
        } catch (_) { msg = String(txt || '').slice(0, 300); }
        if (!msg) msg = 'HTTP ' + resp.status;
        try {
            return new Response(JSON.stringify({ error: msg }), {
                status: resp.status,
                statusText: resp.statusText,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (_) { return resp; }
    }

    // ════════════════════════════════════════════════════════════
    // 平台代理通道（网络通道='relay'）— 经平台 byok-chat 端点转发（US 出口）
    // 直连为默认与推荐；代理兜底「本机无法直连服务商」的场景。
    // 协议：单信封 JSON {target, headers, body, floor_id}（对话体原样透传；
    //       零自定义请求头 → 零 CORS 依赖）；平台不落盘 Key、不记录对话内容。
    // ════════════════════════════════════════════════════════════
    var _RELAY_URLS = [
        'https://direct-cn.gh555.com/api/v3/ai/byok-chat',
        'https://cnk.gh555.com/api/v3/ai/byok-chat'
    ]; // 与 ai-gateway.js _URLS 同源（主/备双线路）

    function _platformToken() {
        try {
            if (parent && parent.window && parent.window.qqqLogin && parent.window.qqqLogin.getAuthToken) {
                return parent.window.qqqLogin.getAuthToken() || '';
            }
        } catch (_) { }
        return '';
    }

    // 客户端版本头（服务端 EOL 门控用；与 ai-gateway.js._appVersion 同源逻辑）
    function _appVersion() {
        try {
            if (parent && parent.window) {
                var bi = parent.window.qqqBootInfo;
                if (bi && bi.version && bi.version !== '?') return String(bi.version).replace(/^v/i, '');
                var el = parent.document && parent.document.getElementById ? parent.document.getElementById('qqq-status-version') : null;
                if (el) {
                    var tx = (el.textContent || '').replace(/^v/i, '');
                    if (tx && tx !== '0.0.3') return tx;
                }
            }
        } catch (_) { }
        return '';
    }

    function _relayErr(msg, cause) {
        var e = new Error('[' + _t('ai.byok.tag', '自带密钥') + '] ' + msg + (cause ? ': ' + cause : ''));
        e._byok = true;
        return e;
    }

    // 单信封 POST（仅网络级故障切换主/备线路；用户 Stop 的中断不切换不重试）
    async function _relayPost(target, providerHeaders, bodyStr, signal, floorId) {
        var token = _platformToken();
        if (!token) throw _relayErr(_t('ai.byok.relayNeedLogin', '平台代理需先登录（或改用直连）'));
        var envelope = JSON.stringify({
            target: target,
            headers: providerHeaders || {},
            body: bodyStr,
            floor_id: floorId || ''
        });
        var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
        var av = _appVersion();
        if (av) headers['X-App-Version'] = av;
        var lastErr = null;
        for (var i = 0; i < _RELAY_URLS.length; i++) {
            try {
                return await fetch(_RELAY_URLS[i], {
                    method: 'POST', headers: headers, body: envelope,
                    signal: signal || null
                });
            } catch (err) {
                lastErr = err;
                if (signal && signal.aborted) throw err;
            }
        }
        throw _relayErr(_t('ai.byok.relayUnreachable', '平台代理连接失败'), lastErr && lastErr.message);
    }

    // 平台错误形态 → 友好文案（{ok:false,code,error} / {error_code} / provider 原文）
    function _relayMsgFromJson(j, status) {
        var code = (j && (j.code || j.error_code)) || '';
        var msg = '';
        if (j) {
            if (typeof j.error === 'string') msg = j.error;
            else if (j.error && typeof j.error === 'object' && typeof j.error.message === 'string') msg = j.error.message;
            else if (typeof j.message === 'string') msg = j.message;
        }
        if (code === 'BYOK_DAILY_CAP') {
            msg = _t('ai.byok.relayCap', '今日平台代理额度已用完，可改用直连或明天再试');
        } else if (code === 'BYOK_PROXY_UNAVAILABLE' || code === 'BYOK_DISABLED') {
            msg = _t('ai.byok.relayDown', '平台代理暂不可用，请稍后重试或改用直连');
        } else if (code === 'rate_limited') {
            msg = _t('ai.byok.relayRate', '请求过于频繁，请稍后再试');
        } else if (code === 'UNAUTHORIZED' || code === 'MISSING_TOKEN' || code === 'INVALID_TOKEN') {
            msg = _t('ai.byok.relayNeedLogin', '平台代理需先登录（或改用直连）');
        } else if (code === 'INSUFFICIENT_GE') {
            msg = _t('ai.byok.relayBalance', 'ge 余额不足，请赞助');
        } else if (code === 'BYOK_BAD_TARGET') {
            msg = _t('ai.byok.relayBadTarget', '该地址不在平台代理名单内（仅海外主流服务商），建议改用直连');
        }
        return msg;
    }

    async function _relayErrorNormalize(resp) {
        var txt = '';
        try { txt = await resp.text(); } catch (_) { }
        var j = null;
        try { j = JSON.parse(txt || '{}'); } catch (_) { }
        var msg = _relayMsgFromJson(j, resp.status);
        if (!msg && (resp.status === 404 || resp.status >= 500)) msg = _t('ai.byok.relayDown', '平台代理暂不可用，请稍后重试或改用直连');
        if (!msg) msg = 'HTTP ' + resp.status;
        try {
            return new Response(JSON.stringify({ error: msg }), {
                status: resp.status, statusText: resp.statusText,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (_) { return resp; }
    }

    // ════════════════════════════════════════════════════════════
    // 统一 fetch — ai-gateway.js chatFetch 唯一消费点
    // 返回 Promise<Response>；未启用/未配置 → null（调用方回落平台通道）
    // route='direct'（默认）→ 直连用户端点；route='relay' → 平台代理转发
    // ════════════════════════════════════════════════════════════
    async function intercept(body, opts) {
        await _load();
        var cfg = get();
        if (!cfg.enabled || !_isConfigured(cfg)) return null;
        var url = _endpoint(cfg.baseUrl);
        if (!url) return null;
        var outBody = _buildBody(body, opts, cfg);
        var resp;

        // ── 平台代理通道（网络通道=平台代理；直连为默认推荐；本地模型强制直连）──
        if (cfg.route === 'relay' && !_isLocalBase(cfg.baseUrl)) {
            try {
                resp = await _relayPost(url, { authorization: 'Bearer ' + cfg.apiKey }, JSON.stringify(outBody),
                    (opts && opts.signal) || null, (body && body.floor_id) || '');
            } catch (err) {
                if (err && err._byok) throw err;
                throw _relayErr(_t('ai.byok.relayUnreachable', '平台代理连接失败'), (err && err.message) || String(err));
            }
            if (!resp.ok) resp = await _relayErrorNormalize(resp);
            try { resp._byokRoute = 'relay'; } catch (_) { }   // ★ 通道标记：agent-gateway 据此标楼层 ' BYOK' + 详单行
            return resp;
        }

        // ── 直连通道（默认）──
        try {
            var dHdr = { 'Content-Type': 'application/json' };
            if (cfg.apiKey) dHdr['Authorization'] = 'Bearer ' + cfg.apiKey;  // 本地模型可无 Key（跳过授权头）
            resp = await fetch(url, {
                method: 'POST',
                headers: dHdr,
                body: JSON.stringify(outBody),
                signal: (opts && opts.signal) || null
            });
        } catch (err) {
            var msg = (err && err.message) || String(err);
            var e2 = new Error('[' + _t('ai.byok.tag', '自带密钥') + '] ' + _t('ai.byok.errReach', '无法连接你配置的 AI 端点') + ': ' + msg);
            e2._byok = true;
            throw e2;
        }
        if (!resp.ok) resp = await _normalizeError(resp);
        try { resp._byokRoute = 'direct'; } catch (_) { }   // ★ 通道标记：agent-gateway 据此标楼层 ' BYOK' + 详单行
        return resp;
    }

    // ════════════════════════════════════════════════════════════
    // 测试连接（弹窗按钮；使用表单当前值，不依赖已保存状态）
    // ════════════════════════════════════════════════════════════
    async function _testConnection(c, statusEl, btn) {
        function _st(text, color) {
            if (!statusEl) return;
            statusEl.textContent = text;
            statusEl.style.color = color || 'var(--base01)';
        }
        if (!c.baseUrl || !c.model) {
            _st(_t('ai.byok.testNeedFill', '请先填写地址与模型名（本地模型 Key 可留空）'), 'var(--red)');
            return;
        }
        var url = _endpoint(c.baseUrl);
        var body = {
            model: c.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 16,
            stream: false
        };
        var ctrl = new AbortController();
        var timer = setTimeout(function () { try { ctrl.abort(); } catch (_) { } }, 25000);
        if (btn) btn.disabled = true;
        _st('⏳ ' + _t('ai.byok.testing', '测试中…'), 'var(--base01)');
        var t0 = performance.now();
        try {
            var resp;
            if ((c.route || 'direct') === 'relay') {
                resp = await _relayPost(url, { authorization: 'Bearer ' + c.apiKey }, JSON.stringify(body), ctrl.signal, '');
            } else {
                var tHdr = { 'Content-Type': 'application/json' };
                if (c.apiKey) tHdr['Authorization'] = 'Bearer ' + c.apiKey;
                resp = await fetch(url, {
                    method: 'POST',
                    headers: tHdr,
                    body: JSON.stringify(body),
                    signal: ctrl.signal
                });
            }
            var ms = Math.round(performance.now() - t0);
            var txt = '';
            try { txt = await resp.text(); } catch (_) { }
            if (resp.ok) {
                var modelEcho = '';
                try { modelEcho = (JSON.parse(txt || '{}').model) || ''; } catch (_) { }
                _st('✅ ' + _t('ai.byok.testOk', '连接成功') + ' · ' + (modelEcho || c.model) + ' · ' + ms + 'ms', 'var(--green)');
                try { await save({ testedAt: Date.now() }); } catch (_) { }
            } else {
                var emsg = '';
                try {
                    var j = JSON.parse(txt || '{}');
                    if ((c.route || 'direct') === 'relay') {
                        emsg = _relayMsgFromJson(j, resp.status);
                    } else {
                        var e = j && j.error;
                        emsg = (typeof e === 'string') ? e : ((e && e.message) || j.message || '');
                    }
                } catch (_) { emsg = String(txt || '').slice(0, 200); }
                _st('❌ HTTP ' + resp.status + (emsg ? ': ' + emsg : ''), 'var(--red)');
            }
        } catch (err) {
            _st('❌ ' + ((err && err.message) || String(err)), 'var(--red)');
        } finally {
            clearTimeout(timer);
            if (btn) btn.disabled = false;
        }
    }

    // ════════════════════════════════════════════════════════════
    // UI：tier 组 "Z" 按钮 + 设置弹窗（样式全部走主题 CSS 变量）
    // ════════════════════════════════════════════════════════════
    var _styleInjected = false;
    function _injectStyle() {
        if (_styleInjected || document.getElementById('byok-style')) return;
        _styleInjected = true;
        var s = document.createElement('style');
        s.id = 'byok-style';
        s.textContent = [
            '#byok-btn.byok-on{background:var(--green);color:#fff;font-weight:800}',
            '#byok-overlay{display:none;position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.35)}',
            '#byok-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:520px;max-width:92vw;max-height:86vh;overflow:auto;',
            'background:var(--card-bg);color:var(--text-primary);border:1px solid var(--border-color);border-radius:6px;padding:16px 18px 14px;',
            'font-size:13px;font-family:inherit;box-shadow:0 6px 30px rgba(0,0,0,0.35);text-align:left}',
            '#byok-panel .bk-row{margin:10px 0 0}',
            '#byok-panel .bk-label{display:block;margin:0 0 4px;color:var(--base01);font-size:12px}',
            '#byok-panel input[type=text],#byok-panel input[type=password]{width:100%;box-sizing:border-box;background:var(--background-color);',
            'border:1px solid var(--border-color);border-radius:3px;color:var(--text-primary);padding:6px 8px;font-size:12.5px;font-family:Consolas,monospace}',
            '#byok-panel input:focus,#byok-panel select:focus{outline:1px solid var(--blue)}',
            '#byok-panel input[type=checkbox],#byok-panel input[type=radio]{accent-color:var(--blue)}',
            '#byok-panel select.bk-select{width:100%;box-sizing:border-box;background:var(--background-color);border:1px solid var(--border-color);border-radius:3px;color:var(--text-primary);padding:5px 8px;font-size:12.5px;font-family:Consolas,monospace}',
            '#byok-panel .bk-keywrap{display:flex;gap:6px;align-items:center}',
            '#byok-panel .bk-eye{flex:0 0 auto;width:30px;height:28px;border:1px solid var(--border-color);border-radius:3px;background:transparent;color:var(--text-primary);cursor:pointer}',
            '#byok-panel .bk-chk{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none}',
            '#byok-panel .bk-routes{display:flex;gap:16px;align-items:center;flex-wrap:wrap}',
            '#byok-panel .bk-radio{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;font-size:12.5px}',
            '#byok-panel .bk-route-note{margin-top:6px;color:var(--base01);font-size:11.5px;line-height:1.5}',
            '#byok-panel .bk-foot{margin-top:14px;padding-top:10px;border-top:1px solid var(--border-color);display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
            '#byok-panel button.bk-btn{height:26px;padding:0 12px;border:1px solid var(--border-color);border-radius:3px;background:transparent;color:var(--text-primary);font-size:12.5px;cursor:pointer}',
            '#byok-panel button.bk-btn:hover{background:var(--base3)}',
            '#byok-panel button.bk-btn:disabled{opacity:0.5;cursor:default}',
            '#byok-panel .bk-hint{margin-top:10px;color:var(--base01);font-size:11.5px;line-height:1.55}',
            '#byok-panel .bk-title{display:flex;align-items:center;justify-content:space-between;font-size:14px;font-weight:700;margin-bottom:4px}',
            '#byok-panel .bk-test-status{font-size:12px;word-break:break-all}'
        ].join('');
        document.head.appendChild(s);
    }

    function _refreshButton() {
        var btn = document.getElementById('byok-btn');
        if (!btn) return;
        var c = get();
        if (isActive()) {
            btn.classList.add('byok-on');
            btn.title = _t('ai.byok.tipOn', '自带 API Key：已启用') + ' · ' + c.model;
        } else {
            btn.classList.remove('byok-on');
            btn.title = _t('ai.byok.tipOff', '自带 API Key：未启用（点击设置）');
        }
    }

    var _overlay = null;
    var _escBound = false;   // ESC 监听单例（弹窗支持销毁重建——防 document 级 keydown 堆积）
    function _buildPopup() {
        if (_overlay) return;
        _injectStyle();
        _overlay = document.createElement('div');
        _overlay.id = 'byok-overlay';
        var p = document.createElement('div');
        p.id = 'byok-panel';
        p.innerHTML =
            '<div class="bk-title"><span>' + _t('ai.byok.title', '自带 API Key') + '</span>' +
            '<button class="bk-btn" id="byok-close">✕</button></div>' +
            '<div class="bk-hint" style="margin-top:2px">' + _t('ai.byok.subtitle', '配置你自己的 AI 服务端点，对话请求直连你的服务商') + '</div>' +
            '<div class="bk-row"><label class="bk-chk"><input type="checkbox" id="byok-enable"><span>' +
            _t('ai.byok.enable', '启用（对话走你的 Key，不计 ge 费用）') + '</span></label></div>' +
            '<div class="bk-row"><label class="bk-label">' + _t('ai.byok.baseUrl', '接口地址（OpenAI 兼容）') + '</label>' +
            '<input type="text" id="byok-baseurl" placeholder="https://…/v1" spellcheck="false"></div>' +
            '<div class="bk-row"><label class="bk-label">' + _t('ai.byok.apiKey', 'API Key') + '</label>' +
            '<div class="bk-keywrap"><input type="password" id="byok-key" placeholder="sk-…" spellcheck="false" autocomplete="off">' +
            '<button class="bk-eye" id="byok-eye" title="' + _t('ai.byok.showKey', '显示/隐藏') + '">👁</button></div></div>' +
            '<div class="bk-row"><label class="bk-label">' + _t('ai.byok.model', '模型名') + '</label>' +
            '<input type="text" id="byok-model" placeholder="' + _t('ai.byok.modelPh', '服务商文档中的模型名') + '" spellcheck="false"></div>' +
            '<div class="bk-row"><label class="bk-label">' + _t('ai.byok.route', '网络通道') + '</label>' +
            '<div class="bk-routes">' +
            '<label class="bk-radio"><input type="radio" name="byok-route" value="direct"><span>' + _t('ai.byok.routeDirect', '直连（推荐）') + '</span></label>' +
            '<label class="bk-radio"><input type="radio" name="byok-route" value="relay"><span>' + _t('ai.byok.routeRelay', '平台代理（美国线路）') + '</span></label>' +
            '</div><div class="bk-route-note" id="byok-route-note"></div></div>' +
            '<div class="bk-row"><label class="bk-chk"><input type="checkbox" id="byok-think"><span>' +
            _t('ai.byok.think', '上送思考参数（服务商不支持请关闭）') + '</span></label>' +
            '<div id="byok-think-cfg" style="display:none">' +
            '<label class="bk-label" style="margin-top:6px">' + _t('ai.byok.thinkLevel', '思考档（reasoning_effort）') + '</label>' +
            '<select id="byok-think-level" class="bk-select"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="max">max</option></select>' +
            '<label class="bk-label" style="margin-top:6px">' + _t('ai.byok.thinkJson', '自定义参数 JSON（可选，填写后优先于档位）') + '</label>' +
            '<input type="text" id="byok-think-json" placeholder="&quot;thinking&quot;:{&quot;type&quot;:&quot;enabled&quot;}" spellcheck="false">' +
            '</div></div>' +
            '<div class="bk-foot">' +
            '<button class="bk-btn" id="byok-test">' + _t('ai.byok.test', '测试连接') + '</button>' +
            '<span class="bk-test-status" id="byok-test-status"></span>' +
            '<span style="flex:1"></span>' +
            '<button class="bk-btn" id="byok-save">' + _t('ai.byok.save', '保存') + '</button>' +
            '</div>' +
            '<div class="bk-hint">' + _t('ai.byok.hint', '启用后：对话请求按所选网络通道发送——直连不经平台服务器；平台代理经平台转发（推广期免费）。贴图识别 / 生图 / 抠图 / 搜索仍走内置通道。密钥仅加密保存在本机（系统凭据保护）。') + '</div>';
        _overlay.appendChild(p);
        document.body.appendChild(_overlay);

        var $ = function (id) { return document.getElementById(id); };
        _overlay.addEventListener('click', function (e) { if (e.target === _overlay) _closePopup(); });
        if (!_escBound) {
            _escBound = true;
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && _overlay && _overlay.style.display !== 'none') _closePopup();
            });
        }
        $('byok-close').onclick = _closePopup;
        $('byok-eye').onclick = function () {
            var k = $('byok-key');
            k.type = (k.type === 'password') ? 'text' : 'password';
        };
        $('byok-enable').onchange = async function () {
            var on = $('byok-enable').checked;
            if (on && !_formConfigured()) {
                $('byok-enable').checked = false;
                var st = $('byok-test-status');
                st.textContent = _t('ai.byok.testNeedFill', '请先填写地址与模型名（本地模型 Key 可留空）');
                st.style.color = 'var(--red)';
                return;
            }
            await save({ enabled: on });
        };
        $('byok-save').onclick = async function () {
            await _saveForm();
            var st = $('byok-test-status');
            st.textContent = '✅ ' + _t('ai.byok.saved', '已保存');
            st.style.color = 'var(--green)';
        };
        $('byok-test').onclick = function () {
            _testConnection(_readForm(), $('byok-test-status'), $('byok-test'));
        };
        // 输入即存（change = 失焦/回车触发；防抖在输入路径之外，频率极低）
        ['byok-baseurl', 'byok-key', 'byok-model'].forEach(function (id) {
            $(id).addEventListener('change', function () { _saveForm().then(function () { _refreshRouteNote(); }); });
        });
        $('byok-think').addEventListener('change', function () { _syncThinkVis(); _saveForm(); });
        $('byok-think-level').addEventListener('change', function () { _saveForm(); });
        $('byok-think-json').addEventListener('change', function () { _saveForm(); });
        Array.prototype.forEach.call(_overlay.querySelectorAll('input[name="byok-route"]'), function (r) {
            r.addEventListener('change', function () {
                _saveForm().then(function () {
                    // 本地地址会被强制直连 → 单选态回同步（视觉与实况一致）
                    var cur = get().route || 'direct';
                    var rr = document.querySelector('input[name="byok-route"][value="' + cur + '"]');
                    if (rr) rr.checked = true;
                    _refreshRouteNote();
                });
            });
        });
    }

    // 思考参数配置区显隐（勾选复选框才显示档位/自定义输入）
    function _syncThinkVis() {
        var on = document.getElementById('byok-think');
        var box = document.getElementById('byok-think-cfg');
        if (!box) return;
        box.style.display = (on && on.checked) ? 'block' : 'none';
    }

    function _refreshRouteNote() {
        var el = document.getElementById('byok-route-note');
        if (!el) return;
        var $ = function (id) { return document.getElementById(id); };
        var curBase = ($('byok-baseurl') ? $('byok-baseurl').value : '') || get().baseUrl || '';
        if (_isLocalBase(curBase)) {
            el.textContent = _t('ai.byok.localNote', '本地端点：请求只在你本机内流转（无需 Key、无需代理）。');
            return;
        }
        var rEl = document.querySelector('input[name="byok-route"]:checked');
        var route = rEl ? rEl.value : (get().route || 'direct');
        el.textContent = (route === 'relay')
            ? _t('ai.byok.relayNote', '经我们服务器转发（Key 仅随请求过境、不落盘）。推广期免费；需登录。建议优先直连。')
            : _t('ai.byok.directNote', '直连：要求你的网络能访问该服务商（不经我们服务器）。本地模型（Ollama/LM Studio 等）填 http://127.0.0.1:端口/v1，Key 可留空。');
    }

    function _readForm() {
        var $ = function (id) { return document.getElementById(id); };
        var c = get();
        var rEl = document.querySelector('input[name="byok-route"]:checked');
        return {
            enabled: c.enabled,
            baseUrl: ($('byok-baseurl') ? $('byok-baseurl').value : c.baseUrl).trim(),
            apiKey: ($('byok-key') ? $('byok-key').value : c.apiKey).trim(),
            model: ($('byok-model') ? $('byok-model').value : c.model).trim(),
            sendThinking: $('byok-think') ? $('byok-think').checked : c.sendThinking,
            thinkLevel: $('byok-think-level') ? $('byok-think-level').value : (c.thinkLevel || 'high'),
            thinkJson: ($('byok-think-json') ? $('byok-think-json').value : (c.thinkJson || '')).trim(),
            route: rEl ? rEl.value : (c.route || 'direct'),
            testedAt: c.testedAt
        };
    }
    function _formConfigured() {
        var c = _readForm();
        return !!(c.baseUrl && c.model);   // Key 可留空（本地模型）
    }
    async function _saveForm() {
        var c = _readForm();
        await save({
            baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, sendThinking: c.sendThinking,
            thinkLevel: c.thinkLevel, thinkJson: c.thinkJson, route: c.route
        });
    }

    function _openPopup() {
        _buildPopup();
        var $ = function (id) { return document.getElementById(id); };
        var c = get();
        $('byok-enable').checked = !!c.enabled;
        $('byok-baseurl').value = c.baseUrl || '';
        $('byok-key').value = c.apiKey || '';
        $('byok-model').value = c.model || '';
        $('byok-think').checked = !!c.sendThinking;
        $('byok-think-level').value = /^(low|medium|high|max)$/.test(c.thinkLevel || '') ? c.thinkLevel : 'high';
        $('byok-think-json').value = c.thinkJson || '';
        _syncThinkVis();
        var rSel = document.querySelector('input[name="byok-route"][value="' + (c.route === 'relay' ? 'relay' : 'direct') + '"]');
        if (rSel) rSel.checked = true;
        _refreshRouteNote();
        var st = $('byok-test-status');
        if (c._locked === 'bridge') {
            st.textContent = '🔒 ' + _t('ai.byok.lockedBridge', '密钥已加密存储（当前实例不支持解密，重启 IDE 后自动解锁）');
        } else if (c._locked === 'decrypt') {
            st.textContent = '🔒 ' + _t('ai.byok.lockedDecrypt', '密钥无法在本机解密（可能来自其他设备），请重新输入');
        } else {
            st.textContent = c.enabled ? ('● ' + _t('ai.byok.tipOn', '自带 API Key：已启用')) : '';
        }
        st.style.color = 'var(--base01)';
        _overlay.style.display = 'block';  // ★ 修复（2026-09-16）：置 '' 会被样式表 #byok-overlay{display:none} 吃掉 → 弹窗永不显示（点击无反应根因）
    }
    function _closePopup() { if (_overlay) _overlay.style.display = 'none'; }

    // ★ 语言切换 → 弹窗销毁重建（文案在构建期烧入 HTML；缓存 DOM 复用会锁死旧语言）
    //   开着 → 保留用户正在编辑的表单值重建后恢复；关着 → 直接销毁，下次打开自是新语言
    function _relang() {
        _refreshButton();
        if (!_overlay) return;
        var wasOpen = _overlay.style.display === 'block';
        var form = null;
        if (wasOpen) { try { form = _readForm(); } catch (_) { } }
        try { _overlay.remove(); } catch (_) { }
        _overlay = null;
        if (!wasOpen || !form) return;
        _openPopup();   // 重建（新语言）+ 配置态/状态行
        var $ = function (id) { return document.getElementById(id); };
        $('byok-baseurl').value = form.baseUrl || '';
        $('byok-key').value = form.apiKey || '';
        $('byok-model').value = form.model || '';
        $('byok-think').checked = !!form.sendThinking;
        $('byok-think-level').value = /^(low|medium|high|max)$/.test(form.thinkLevel || '') ? form.thinkLevel : 'high';
        $('byok-think-json').value = form.thinkJson || '';
        _syncThinkVis();
        var rr = document.querySelector('input[name="byok-route"][value="' + (form.route === 'relay' ? 'relay' : 'direct') + '"]');
        if (rr) rr.checked = true;
        _refreshRouteNote();
    }

    function _injectButton() {
        if (document.getElementById('byok-btn')) return;
        _injectStyle();
        var group = document.querySelector('.tier-group');
        if (!group) { setTimeout(_injectButton, 1500); return; }
        var btn = document.createElement('button');
        btn.className = 'tier-btn';
        btn.id = 'byok-btn';
        btn.textContent = 'Z';  // ★ 2026-09-16 用户定：按钮名 K → Z
        btn.onclick = _openPopup;
        group.appendChild(btn);
        _refreshButton();
    }

    // ── 启动 ──
    function _boot() {
        _load().catch(function () { });
        _injectButton();
        // ★ 语言切换（父窗口广播 qqq-lang-change）→ 按钮 tooltip + 弹窗文案即时刷新
        window.addEventListener('message', function (e) {
            if (e.data && e.data.type === 'qqq-lang-change') { try { _relang(); } catch (_) { } }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _boot);
    } else {
        _boot();
    }

    // ── 暴露（AiGateway 分支消费 + 调试）──
    window.qqqByok = {
        intercept: intercept,
        isActive: isActive,
        isConfigured: _isConfigured,
        get: get,
        save: save,
        reload: function () { return _load(true); },
        open: _openPopup,
        close: _closePopup,
        endpoint: _endpoint,
        isLocalBase: _isLocalBase,   // 供测试/审计
        buildBody: _buildBody   // 供测试/审计
    };

})();
