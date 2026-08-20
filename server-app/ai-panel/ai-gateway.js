// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ai-gateway.js — 统一 AI 模型调用包装器
//
// 铁律（参见 do/拓扑/铁律 §14b）：
//   1. 一切 AI 模型调用必须经 AiGateway 走出，禁止直接 fetch 第三方端点
//   2. 所有模型名/厂商名/API 端点字符串收敛于本文件 + Go 后端，客户端零暴露
//   3. tier 1-6 数字传参，模型映射由本文件 + Go 双端保障
//
// 使用方式：
//   AiGateway.chat(body, opts)        → 高层：发消息 + 等 stream 解析结果
//   AiGateway.chatFetch(body, opts)   → 低层：只管 HTTP fetch，返回 Response
//   AiGateway.visionSubmit(base64, token, opts) → 提交视觉任务
//   AiGateway.visionPoll(taskId, token)          → SSE 轮询视觉结果
//   AiGateway.imageGenSubmit(prompt, opts)       → 提交绘图任务
//   AiGateway.pollTaskStream(url, token, timeoutMs) → 通用 SSE 轮询
//   AiGateway.embed(texts, token)     → 向量化
//   AiGateway.searchWeb(query, token) → 搜索
//
// 无外部依赖（不依赖 system-prompt.js 的 GATEWAY_URL 等常量）
// ============================================================================

; (function () {
    'use strict';

    // ════════════════════════════════════════════════════
    // 内部常量 — 所有 URL 的唯一真理源
    // 不暴露到 window，不对外读取
    // ════════════════════════════════════════════════════

    var _URLS = {
        chatPrimary: 'https://direct-cn.gh555.com/api/v3/ai/chat',
        chatFallback: 'https://cnk.gh555.com/api/v3/ai/chat',
        visionPrimary: 'https://direct-cn.gh555.com/api/v3/ai/vision',
        visionFallback: 'https://cnk.gh555.com/api/v3/ai/vision',
        imageGenPrimary: 'https://direct-cn.gh555.com/api/v3/ai/generate-image',
        imageGenFallback: 'https://cnk.gh555.com/api/v3/ai/generate-image',
        embedPrimary: 'https://direct-cn.gh555.com/api/v3/ai/embedding',
        embedFallback: 'https://cnk.gh555.com/api/v3/ai/embedding',
        searchPrimary: 'https://direct-cn.gh555.com/api/v3/search/web',
        searchFallback: 'https://cnk.gh555.com/api/v3/search/web',
        fetchPrimary: 'https://direct-cn.gh555.com/api/v3/fetch/webpage',
        fetchFallback: 'https://cnk.gh555.com/api/v3/fetch/webpage',
        segmentPrimary: 'https://direct-cn.gh555.com/api/v3/ai/segment',
        segmentFallback: 'https://cnk.gh555.com/api/v3/ai/segment',
    };

    var _DEFAULT_TIMEOUT = 30000;
    var _CHAT_TIMEOUT = 1000000;

    // ★ 备用线标记：通过 X-Key-Slot header 告知 Go 选备用 key，客户端零密钥暴露
    //    主线: X-Key-Slot 不发送或为 0（Go 取默认 key）

    // ════════════════════════════════════════════════════
    // 内部工具函数
    // ════════════════════════════════════════════════════

    // ★ tier 数字 → 客户端 opaque 模型名（Go 端做最终映射）
    function _tierToModel(tier) {
        return (tier >= 4) ? 'deep' : 'fast';
    }

    // 取登录 JWT（内存，经 parent.window.qqqLogin）
    function _getToken() {
        try {
            if (parent && parent.window && parent.window.qqqLogin && parent.window.qqqLogin.getAuthToken) {
                return parent.window.qqqLogin.getAuthToken();
            }
        } catch (_) { }
        return '';
    }

    // fetch 带超时超时
    function _fetchWithTimeout(url, opts, timeoutMs) {
        timeoutMs = timeoutMs || _DEFAULT_TIMEOUT;
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
        opts.signal = (function (orig) {
            // 合并外部 signal（如果有）
            if (orig) {
                var parent = orig;
                var child = controller;
                parent.addEventListener('abort', function () {
                    try { child.abort(); } catch (_) { }
                }, { once: true });
            }
            return controller.signal;
        })(opts.signal);
        return fetch(url, opts).then(function (resp) {
            clearTimeout(timer);
            return resp;
        }).catch(function (err) {
            clearTimeout(timer);
            throw err;
        });
    }

    // 双线路故障切换 fetch
    async function _fetchWithFailover(primaryUrl, fallbackUrl, opts, timeoutMs) {
        try {
            return await _fetchWithTimeout(primaryUrl, opts, timeoutMs);
        } catch (e) {
            try {
                return await _fetchWithTimeout(fallbackUrl, opts, timeoutMs);
            } catch (e2) {
                throw e2;
            }
        }
    }

    // 双线路 JSON POST（提交类：vision/imageGen），先主后备用
    // primaryConnTimeout: 主线连接探测超时（默认 8s，主线未可达时快速切备用）
    // fallbackTimeout: 备用线全程超时（默认 120s，包含大 body 上传）
    async function _postJsonWithFailover(primaryUrl, fallbackUrl, body, token, primaryConnTimeout, fallbackTimeout) {
        primaryConnTimeout = primaryConnTimeout || 8000;
        fallbackTimeout = fallbackTimeout || 120000;
        // Primary
        try {
            var resp = await _fetchWithTimeout(primaryUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify(body),
            }, primaryConnTimeout);
            if (resp && resp.ok) return resp;
        } catch (_) { }
        // Fallback（X-Key-Slot 告知 Go 选备用 key，更长的超时容忍大 body）
        try {
            return await _fetchWithTimeout(fallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'X-Key-Slot': '1' },
                body: JSON.stringify(body),
            }, fallbackTimeout);
        } catch (_) {
            return null;
        }
    }

    // 通用 SSE 流轮询（用于 vision/imageGen 异步任务）
    // url: string（单 URL） 或 {primary, fallback}（双线路）
    async function _pollStream(url, token, timeoutMs) {
        timeoutMs = timeoutMs || 120000;
        var deadline = Date.now() + timeoutMs;
        // 主线探测超时短（8s，未可达快速切），备用线连接超时宽（30s，CF Worker→Go SSE 协商）
        var primaryConnTimeout = 35000;
        var fallbackConnTimeout = 30000;

        // 双线路：先主后备
        var resp;
        if (typeof url === 'object' && url.primary) {
            // Primary
            try {
                resp = await _fetchWithTimeout(url.primary, {
                    headers: { 'Authorization': 'Bearer ' + token },
                }, primaryConnTimeout);
            } catch (_) { }
            // Fallback
            if (!resp || !resp.ok) {
                try {
                    resp = await _fetchWithTimeout(url.fallback, {
                        headers: { 'Authorization': 'Bearer ' + token },
                    }, fallbackConnTimeout);
                } catch (_) { return null; }
            }
        } else {
            try {
                resp = await _fetchWithTimeout(url, {
                    headers: { 'Authorization': 'Bearer ' + token },
                }, fallbackConnTimeout);
            } catch (_) { return null; }
        }
        if (!resp || !resp.ok) return null;

        var reader;
        try { reader = resp.body.getReader(); } catch (_) { return null; }
        var decoder = new TextDecoder();
        var buf = '';

        try {
            while (Date.now() < deadline) {
                var chunk = await reader.read();
                if (chunk.done) break;
                buf += decoder.decode(chunk.value, { stream: true });

                var lines = buf.split('\n');
                buf = lines.pop();
                for (var li = 0; li < lines.length; li++) {
                    if (lines[li].startsWith('data: ')) {
                        try {
                            var evt = JSON.parse(lines[li].slice(6));
                            if (evt.status === 'done' || evt.status === 'error') {
                                reader.cancel();
                                return evt;
                            }
                        } catch (_) { }
                    }
                }
            }
        } catch (_) { }
        try { reader.cancel(); } catch (_) { }
        return null;
    }


    // ════════════════════════════════════════════════════
    // 公有 API
    // ═══════════════════════════════════════════════════════════════════

    var AiGateway = {

        // ──────────────────────────────────────────────
        // 【低层】Chat fetch：只管 HTTP，模型映射 + failover + auth
        // 由 agent-gateway.js _callGateway 调用（它负责重试/切换/stream 消费）
        //
        // body: 已组装好的完整请求体（含 messages/tools/stream/thinking 等）
        //       注意: body.model 会被本函数覆盖（映射为 fast/deep）
        // opts: { token, signal, tier, isFallback? }
        // 返回: Promise<Response> 或 reject
        // ──────────────────────────────────────────────
        chatFetch: async function (body, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) throw new Error('No token');

            // ★ 压缩路径：锁死 tier 4（与 agent-context.js COMPACT_TIER 一致），长超时
            if (opts.compact) {
                var _isFallback = opts.isFallback || false;
                var _primaryUrl = _URLS.chatPrimary;
                var _fallbackUrl = _URLS.chatFallback;
                var _url = _isFallback ? _fallbackUrl : _primaryUrl;
                // ★ 统一 tier→model 映射（锁死 tier 4）
                var _compactTier = body.tier || opts.tier || 4;
                body.tier = _compactTier;
                if (!body.model) body.model = _tierToModel(_compactTier);
                var _hdrs = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
                if (opts.keySlot === 1) _hdrs['X-Key-Slot'] = '1';
                else if (_isFallback) _hdrs['X-Key-Slot'] = '1';
                return _fetchWithTimeout(_url, { method: 'POST', headers: _hdrs, body: JSON.stringify(body) }, 600000);
            }

            // ★ 模型映射：客户端只传 fast/deep
            var tierNum = opts.tier || 6;
            body.model = _tierToModel(tierNum);
            body.tier = tierNum;  // ★ 透传 tier 给 Go 计费用（客户端零费率知识）

            // ★ 线路选择
            var isFallback = opts.isFallback || false;
            var primaryUrl = _URLS.chatPrimary;
            var fallbackUrl = _URLS.chatFallback;
            var url = isFallback ? fallbackUrl : primaryUrl;

            var headers = {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token,
            };
            // ★ keySlot 决定 key（quest 级固定，不随 URL 线路变化）
            if (opts.keySlot === 1) {
                headers['X-Key-Slot'] = '1';  // Go 端据此选备用 key
            }

            return _fetchWithTimeout(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                signal: opts.signal || null,
            }, _CHAT_TIMEOUT);
        },

        // ──────────────────────────────────────────────
        // 【高层】Chat：构建请求体 + 发消息 + 消费 SSE stream
        // 适用于简单场景（非 agent loop 内部调用）
        // 返回解析后的响应对象
        // ──────────────────────────────────────────────
        chat: async function (messages, opts) {
            opts = opts || {};
            var tier = opts.tier || 6;

            var body = {
                messages: messages,
                stream: true,
                stream_options: { include_usage: true },
                max_tokens: opts.maxTokens || 393216,
            };
            if (opts.floorId) body.floor_id = opts.floorId;
            if (opts.houseHint) body.house_hint = opts.houseHint;

            // tools
            if (typeof getTools === 'function') {
                var tools = getTools();
                if (tools && tools.length) {
                    body.tools = tools;
                    if (opts.noTools) body.tool_choice = 'none';
                }
            }

            // thinking/reasoning_effort
            if (tier >= 4) {
                body.thinking = { type: 'enabled' };
                var efforts = ['', 'high', 'max'];
                body.reasoning_effort = efforts[tier - 3] || 'max';
            } else if (tier >= 2) {
                body.thinking = { type: 'enabled' };
                var efforts2 = ['', 'high', 'max'];
                body.reasoning_effort = efforts2[tier - 1] || 'max';
            } else {
                body.thinking = { type: 'disabled' };
            }

            try {
                var resp = await AiGateway.chatFetch(body, opts);
                if (!resp.ok) {
                    var errText = '';
                    try { errText = await resp.text(); } catch (_) { }
                    opts.onError && opts.onError('HTTP ' + resp.status + ': ' + errText.slice(0, 200));
                    return null;
                }
                // 返回 response body（ReadableStream）供调用方消费
                return resp;
            } catch (err) {
                opts.onError && opts.onError('Network error: ' + (err.message || err));
                return null;
            }
        },

        // ──────────────────────────────────────────────
        // 视觉任务提交（异步：POST → 得 task_id）
        // ──────────────────────────────────────────────
        visionSubmit: async function (base64, token, opts) {
            opts = opts || {};
            token = token || _getToken();
            if (!token) return null;

            var reqBody = { image: base64 };
            if (opts.prompt) reqBody.prompt = opts.prompt;
            if (opts.floorId) reqBody.floor_id = opts.floorId;
            if (opts.summary) reqBody.summary = opts.summary;

            var resp = await _postJsonWithFailover(_URLS.visionPrimary, _URLS.visionFallback, reqBody, token);
            if (!resp || !resp.ok) return null;
            var data = await resp.json();

            // 缓存命中 → 直接返回描述
            if (data.status === 'done') {
                return { description: data.description, ge_cost: data.ge_cost || 0, billing_request_id: data.billing_request_id || 0 };
            }
            if (data.task_id) {
                return { task_id: data.task_id };
            }
            return null;
        },

        // ──────────────────────────────────────────────
        // 视觉结果轮询（SSE）：等 AI 分析完返回描述
        // ────────────────────────────────────────────────────
        visionPoll: async function (taskId, token) {
            token = token || _getToken();
            if (!token || !taskId) return null;

            var urls = {
                primary: _URLS.visionPrimary + '/' + taskId + '/stream',
                fallback: _URLS.visionFallback + '/' + taskId + '/stream'
            };
            var evt = await _pollStream(urls, token, 120000);
            if (evt && evt.status === 'done') {
                return { description: evt.description, ge_cost: evt.ge_cost || 0, billing_request_id: evt.billing_request_id || 0 };
            }
            return null;
        },

        // ──────────────────────────────────────────────
        // 绘图任务提交
        // ──────────────────────────────────────────────
        imageGenSubmit: async function (prompt, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) return null;

            var reqBody = {
                prompt: prompt,
                style: opts.style || '',
                size: opts.size || '1024*1024',
                n: opts.n || 1,
            };
            // ★ 图生图：参考图片数组
            if (opts.images && Array.isArray(opts.images) && opts.images.length > 0) {
                reqBody.images = opts.images;
            }
            var resp = await _postJsonWithFailover(_URLS.imageGenPrimary, _URLS.imageGenFallback, reqBody, token);
            if (!resp) return null;
            if (!resp.ok) {
                // ★ 透传服务端错误消息（INVALID_SIZE/BILLING_DOWN 等 4xx/5xx，不再盲报 could not create task）
                try {
                    var errData = await resp.json();
                    if (errData && errData.error) return { error: errData.error };
                } catch (_) { }
                return null;
            }
            var data = await resp.json();
            if (!data.ok || !data.task_id) return null;
            return { task_id: data.task_id };
        },

        // ──────────────────────────────────────────────
        // 绘图结果轮询（SSE）
        // ───────────────────────────────────────────────────
        imageGenPoll: async function (taskId, token) {
            token = token || _getToken();
            if (!token || !taskId) return null;

            var urls = {
                primary: _URLS.imageGenPrimary + '/' + taskId + '/stream',
                fallback: _URLS.imageGenFallback + '/' + taskId + '/stream'
            };
            var evt = await _pollStream(urls, token, 180000);
            if (evt && evt.status === 'done') {
                return { urls: evt.urls, ge_cost: evt.ge_cost || 0, billing_request_id: evt.billing_request_id || 0 };
            }
            if (evt && evt.status === 'error') {
                return { error: evt.error };
            }
            return null;
        },

        // ──────────────────────────────────────────────
        // Embedding：文本 → 向量
        // ──────────────────────────────────────────────
        embed: async function (texts, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) throw new Error('No token');

            var body = {
                model: 'embedding-v1',
                input: texts.length === 1 ? texts[0] : texts,
                dimensions: 1024,
            };
            if (opts.floorId) body.floor_id = opts.floorId;

            var resp = await _fetchWithFailover(_URLS.embedPrimary, _URLS.embedFallback, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify(body),
            }, 15000);

            if (!resp || !resp.ok) throw new Error('Embedding API unreachable');
            var data = await resp.json();

            // 归一化
            var vectors = [];
            for (var di = 0; di < (data.data || []).length; di++) {
                var v = data.data[di].embedding;
                var sumSq = 0;
                for (var si = 0; si < v.length; si++) sumSq += v[si] * v[si];
                var norm = Math.sqrt(sumSq);
                if (norm > 0) {
                    var nv = [];
                    for (var ni = 0; ni < v.length; ni++) nv.push(v[ni] / norm);
                    vectors.push(nv);
                } else {
                    vectors.push(v);
                }
            }

            return {
                vectors: vectors,
                tokenCount: data.usage ? data.usage.total_tokens || 0 : 0,
                model: 'embedding-v1',
            };
        },

        // ──────────────────────────────────────────────
        // web search
        // ──────────────────────────────────────────────
        searchWeb: async function (query, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) return { ok: false, error: 'No token', results: [] };

            try {
                var resp = await _fetchWithFailover(_URLS.searchPrimary, _URLS.searchFallback, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ query: query, maxResults: opts.maxResults || 20 }),
                }, 30000);

                if (!resp || !resp.ok) {
                    return { ok: false, error: 'HTTP ' + (resp ? resp.status : '?'), results: [] };
                }
                var data = await resp.json();
                return { ok: true, results: data.results || [], ge_cost: data.ge_cost || 0, billing_request_id: data.billing_request_id || 0 };
            } catch (err) {
                return { ok: false, error: err.message || 'Network error', results: [] };
            }
        },

        // ──────────────────────────────────────────────
        // Web Fetch — US 服务器端代理抓取网页（绕过 GFW）
        // ──────────────────────────────────────────────
        fetchWebpage: async function (url, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) return { ok: false, error: 'No token', text: '' };

            try {
                var resp = await _fetchWithFailover(_URLS.fetchPrimary, _URLS.fetchFallback, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ url: url, floor_id: opts.floorId || '' }),
                }, 20000);

                if (!resp || !resp.ok) {
                    return { ok: false, error: 'HTTP ' + (resp ? resp.status : '?'), text: '' };
                }
                var data = await resp.json();
                return { ok: true, text: data.text || '', ge_cost: data.ge_cost || 0 };
            } catch (err) {
                return { ok: false, error: err.message || 'Network error', text: '' };
            }
        },

        // ──────────────────────────────────────────────
        // 抠图提交（同步返回 image_url，经双线路 failover）
        // ──────────────────────────────────────────────
        segmentSubmit: async function (opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) return { ok: false, error: 'No token' };

            var reqBody = { image: opts.image, quality: opts.quality || 'auto' };
            if (opts.floorId) reqBody.floor_id = opts.floorId;

            try {
                var resp = await _postJsonWithFailover(_URLS.segmentPrimary, _URLS.segmentFallback, reqBody, token);
                if (!resp || !resp.ok) {
                    var errText = '';
                    try { errText = await resp.text(); } catch (_) { }
                    return { ok: false, error: 'HTTP ' + (resp ? resp.status : '?') + ': ' + errText.slice(0, 200) };
                }
                var data = await resp.json();
                if (!data.ok || !data.image_url) {
                    return { ok: false, error: data.error || data.code || 'no image_url' };
                }
                return { ok: true, image_url: data.image_url, width: data.width, height: data.height, model: data.model, ge_cost: data.ge_cost || 0, billing_request_id: data.billing_request_id || 0 };
            } catch (err) {
                return { ok: false, error: err.message || 'Network error' };
            }
        },

        // ──────────────────────────────────────────────
        // 通用 SSE 流轮询
        // ──────────────────────────────────────────────
        pollTaskStream: async function (url, token, timeoutMs) {
            return _pollStream(url, token, timeoutMs);
        },

    };

    // ═══ 暴露到全局 ═══
    window.AiGateway = AiGateway;

    // ═══ 兼容旧引用 ═══
    window._qqqAiGateway = AiGateway;

})();
