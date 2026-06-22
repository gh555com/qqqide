// ============================================================================
// ai-gateway.js — 统一 AI 模型调用包装器
//
// 铁律：一切 AI 模型调用必须经过此包装器，禁止直接 fetch 第三方 AI 端点。
// 所有模型名、厂商名、API 端点信息收敛于此文件 + Go 后端，客户端零暴露。
//
// 调用关系：
//   agent-gateway.js (chat) / tools-exec-effect.js (tools) / agent-vision.js / embedding-service.js
//     → ai-gateway.js
//       → fetch(自家 Go 端点) → Go → 第三方模型
//
// 架构铁律（见 do/拓扑/铁律 §X）：
//   1. 所有 AI 调用走此包装器，不绕过
//   2. 不暴露任何模型名、厂商名、API 端点给客户端 JS
//   3. 统一错误处理、重试、故障切换
// ============================================================================

;(function () {
    'use strict';

    // ═══ 内部常量（不暴露到 window，不给任何外部读取） ═══
    var _GATEWAY = {
        chat:        'https://direct.gh555.com:8444/api/v3/ai/chat',
        chatFallback:'https://gh555.com/api/v3/ai/chat',
        vision:      'https://direct.gh555.com:8444/api/v3/ai/vision',
        imageGen:    'https://direct.gh555.com:8444/api/v3/ai/generate-image',
        embed:       'https://direct.gh555.com:8444/api/v3/ai/embedding',
        embedFallback:'https://gh555.com/api/v3/ai/embedding',
        search:      'https://direct.gh555.com:8444/api/v3/search/web',
        searchFallback:'https://gh555.com/api/v3/search/web',
    };

    // ★ tier 数字 → Go 内部模型名映射（Go 端同步映射，双重保障）
    // 客户端只传数字 1-6，Go 端做最终映射
    function _tierToModel(tier) {
        var map = { 1: 'fast', 2: 'fast', 3: 'fast', 4: 'deep', 5: 'deep', 6: 'deep' };
        return map[tier] || 'deep';
    }

    // ═══ 通用 fetch 带超时 + 重试 ═══
    function _fetchWithTimeout(url, opts, timeoutMs) {
        timeoutMs = timeoutMs || 30000;
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
        opts.signal = controller.signal;
        return fetch(url, opts).then(function (resp) {
            clearTimeout(timer);
            return resp;
        }).catch(function (err) {
            clearTimeout(timer);
            throw err;
        });
    }

    // ═══ 双线路故障切换 ═══
    async function _fetchWithFallback(primaryUrl, fallbackUrl, opts, timeoutMs) {
        try {
            return await _fetchWithTimeout(primaryUrl, opts, timeoutMs);
        } catch (e) {
            // 主线路失败 → 尝试备用
            return await _fetchWithTimeout(fallbackUrl, opts, timeoutMs);
        }
    }

    // ═══ 从挂载点取 auth token ═══
    function _getToken() {
        if (typeof getToken === 'function') return getToken();
        return '';
    }


    // ════════════════════════════════════════════════
    // 公有 API — 暴露给外部调用
    // ════════════════════════════════════════════════

    var AiGateway = {

        // ── Chat ──────────────────────────────────
        // 调用 AI 聊天。返回值由 onDone/onError 回调处理。
        // opts: { tier, onToken, onReasoning, onDone, onError, noTools, token, images, maxTokens }
        chat: async function (messages, opts) {
            opts = opts || {};
            var tier = opts.tier || 6;
            var token = opts.token || _getToken();
            if (!token) { opts.onError && opts.onError('No token'); return null; }

            var body = {
                model: _tierToModel(tier),
                messages: messages,
                stream: true,
                stream_options: { include_usage: true },
                max_tokens: opts.maxTokens || 393216,
            };
            if (opts.floorId) body.floor_id = opts.floorId;
            if (opts.houseHint) body.house_hint = opts.houseHint;
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
                body.reasoning_effort = ['high', 'max'][tier - 4] || 'max';
            } else if (tier >= 2) {
                body.thinking = { type: 'enabled' };
                body.reasoning_effort = ['high', 'max'][tier - 2] || 'max';
            } else {
                body.thinking = { type: 'disabled' };
            }

            try {
                var resp = await _fetchWithFallback(
                    _GATEWAY.chat, _GATEWAY.chatFallback,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify(body),
                    },
                    600000
                );
                if (!resp.ok) {
                    var errText = '';
                    try { errText = await resp.text(); } catch (_) {}
                    opts.onError && opts.onError('HTTP ' + resp.status + ': ' + errText.slice(0, 200));
                    return null;
                }
                // 返回 response 流让调用方消费 SSE
                return resp;
            } catch (err) {
                opts.onError && opts.onError('Network error: ' + (err.message || err));
                return null;
            }
        },

        // ── Vision ────────────────────────────────
        // 分析图片，返回描述文本。支持多图片并行。
        vision: async function (images, prompt, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) return [];

            var results = [];
            for (var i = 0; i < images.length; i++) {
                var img = images[i];
                try {
                    var reqBody = { image: img.base64 };
                    if (prompt) reqBody.prompt = prompt;
                    if (opts.floorId) reqBody.floor_id = opts.floorId;

                    var resp = await _fetchWithTimeout(_GATEWAY.vision, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify(reqBody),
                    }, 120000);

                    if (resp.ok) {
                        var data = await resp.json();
                        if (data.status === 'done') {
                            results.push({ id: img.id, description: data.description || '' });
                        } else if (data.task_id) {
                            // SSE 轮询
                            var desc = await _pollVisionTask(data.task_id, token);
                            if (desc) results.push({ id: img.id, description: desc });
                        }
                    }
                } catch (_) {}
            }
            return results;
        },

        // ── Generate Image ────────────────────────
        generateImage: async function (prompt, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) return { ok: false, error: 'No token' };

            try {
                var resp = await _fetchWithTimeout(_GATEWAY.imageGen, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({
                        prompt: prompt,
                        style: opts.style || '',
                        size: opts.size || '1024*1024',
                        n: opts.n || 1,
                    }),
                }, 120000);

                if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };

                var data = await resp.json();
                if (!data.ok || !data.task_id) return { ok: false, error: data.error || 'Unknown error' };

                // 轮询 SSE 结果
                var result = await _pollImageTask(data.task_id, token);
                return result || { ok: false, error: 'No result from stream' };
            } catch (err) {
                return { ok: false, error: err.message || String(err) };
            }
        },

        // ── Analyze Image ─────────────────────────
        analyzeImage: async function (imagePath, action, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) return { ok: false, error: 'No token' };

            try {
                // 先读本地图片 → base64
                var bridge = window.parent && window.parent.qqqideBridge;
                if (!bridge) return { ok: false, error: 'Bridge unavailable' };
                var base64 = await bridge.fs.readBase64(imagePath);
                if (!base64) return { ok: false, error: 'Failed to read image' };

                var reqBody = {
                    image: base64,
                    action: action || 'describe',
                };
                if (opts.detail) reqBody.detail = opts.detail;
                if (opts.targets) reqBody.targets = opts.targets;
                if (opts.question) reqBody.question = opts.question;

                var resp = await _fetchWithTimeout(_GATEWAY.vision, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify(reqBody),
                }, 120000);

                if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };

                var data = await resp.json();
                if (data.status === 'done') {
                    return { ok: true, description: data.description };
                } else if (data.task_id) {
                    var desc = await _pollVisionTask(data.task_id, token);
                    return desc ? { ok: true, description: desc } : { ok: false, error: 'Vision timeout' };
                }
                return { ok: false, error: 'Unexpected response' };
            } catch (err) {
                return { ok: false, error: err.message || String(err) };
            }
        },

        // ── Embedding ─────────────────────────────
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

            var resp = await _fetchWithFallback(_GATEWAY.embed, _GATEWAY.embedFallback, {
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

        // ── Web Search ────────────────────────────
        searchWeb: async function (query, opts) {
            opts = opts || {};
            var token = opts.token || _getToken();
            if (!token) return [];

            try {
                var resp = await _fetchWithFallback(_GATEWAY.search, _GATEWAY.searchFallback, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ query: query, maxResults: opts.maxResults || 20 }),
                }, 30000);

                if (!resp || !resp.ok) return [];
                var data = await resp.json();
                return data.results || [];
            } catch (_) {
                return [];
            }
        },
    };

    // ═══ SSE 轮询辅助（vision task） ═══
    async function _pollVisionTask(taskId, token) {
        var url = _GATEWAY.vision + '/' + taskId + '/stream';
        try {
            var resp = await _fetchWithTimeout(url, {
                headers: { 'Authorization': 'Bearer ' + token },
            }, 120000);
            if (!resp.ok) return null;

            var reader = resp.body.getReader();
            var decoder = new TextDecoder();
            var buf = '';
            var deadline = Date.now() + 120000;

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
                            if (evt.status === 'done') {
                                reader.cancel();
                                return evt.description || '';
                            }
                        } catch (_) {}
                    }
                }
            }
            reader.cancel();
            return null;
        } catch (_) {
            return null;
        }
    }

    // ═══ SSE 轮询辅助（image gen task） ═══
    async function _pollImageTask(taskId, token) {
        var url = _GATEWAY.imageGen + '/' + taskId + '/stream';
        try {
            var resp = await _fetchWithTimeout(url, {
                headers: { 'Authorization': 'Bearer ' + token },
            }, 180000);
            if (!resp.ok) return null;

            var reader = resp.body.getReader();
            var decoder = new TextDecoder();
            var buf = '';
            var deadline = Date.now() + 180000;

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
                            if (evt.status === 'done') {
                                reader.cancel();
                                return { ok: true, urls: evt.urls, ge_cost: evt.ge_cost };
                            }
                            if (evt.status === 'error') {
                                reader.cancel();
                                return { ok: false, error: evt.error };
                            }
                        } catch (_) {}
                    }
                }
            }
            reader.cancel();
            return null;
        } catch (_) {
            return null;
        }
    }

    // ═══ 暴露到全局 ═══
    window.AiGateway = AiGateway;

    // ═══ 兼容旧引用（逐步迁移） ═══
    window._qqqAiGateway = AiGateway;

})();
