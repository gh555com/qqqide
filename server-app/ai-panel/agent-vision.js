// ============================================================================
// agent-vision.js — 视觉预分析（图像 → 文本 → 推理）
// 从 agent-loop.js 拆分，为 AgentLoop.prototype 添加 _analyzeImages + _callVision 方法
// 依赖：AgentLoop（由 agent-loop.js 定义），GATEWAY_URL（由 system-prompt.js 定义）
// ============================================================================

// ═══ 视觉预分析：图像 → 文本 ═══
// 并行分析所有图片，MD5 缓存
// 返回 [{id, description, cached}] — 失败图片静默跳过
AgentLoop.prototype._analyzeImages = async function (images, token, userContent) {
    var self = this;
    var results = [];

    // 构造视觉 prompt：把用户问题原文带上，让阿里做针对性识别
    var visionPrompt = '';
    if (userContent && typeof userContent === 'string' && userContent.trim()) {
        visionPrompt = 'The user is asking the following question about this image. ' +
            'Focus your analysis specifically on what the user is asking about. ' +
            'Ignore unrelated text/details — only describe what matters for answering the question.\n\n' +
            'USER QUESTION:\n' + userContent.trim() + '\n\n' +
            'Now describe this image with respect to the question above:';
    }

    var analyzeOne = async function (img) {
        var hash = self._simpleHash(img.base64 + '|' + (visionPrompt || ''));
        var cached = self._visionCache.get(hash);
        if (cached) {
            self._log('  ✓ vision #' + img.id + ' cached (' + hash.slice(0, 8) + ')');
            return { id: img.id, description: cached.description, cached: true };
        }
        try {
            var desc = await self._callVision(img.base64, token, visionPrompt, userContent);
            if (desc) {
                self._visionCache.set(hash, { description: desc, ts: Date.now() });
            }
            return { id: img.id, description: desc, cached: false };
        } catch (err) {
            self._log('  ✗ vision #' + img.id + ' failed: ' + (err.message || err));
            return { id: img.id, description: null, cached: false };
        }
    };

    // ★ 并行分析：所有图片独立调 Go vision 端点，无依赖关系
    var allResults = await Promise.all(images.map(function (img) { return analyzeOne(img); }));
    for (var i = 0; i < allResults.length; i++) {
        var r = allResults[i];
        if (r.description) {
            results.push({ id: r.id, description: r.description, cached: r.cached });
        } else {
            self._log('  ⚠ vision #' + r.id + ' skipped (no description)');
        }
    }
    return results;
};

// ---- 调用 /api/v3/ai/vision（异步：提交 → SSE 推送，绕开 CF 100s 代理超时）----
AgentLoop.prototype._callVision = async function (base64, token, prompt, userContent) {
    var self = this;
    var MAX_SUBMIT_RETRIES = 2;

    // ═══ Step 1: 提交任务（带重试） ═══
    var taskId = null;
    for (var retry = 0; retry <= MAX_SUBMIT_RETRIES; retry++) {
        try {
            var reqBody = { image: base64 };
            if (prompt && typeof prompt === 'string' && prompt.trim()) {
                reqBody.prompt = prompt.trim();
            }
            // billing 摘要：传用户原始问题（不含视觉提示词前缀），Go 存为流水摘要
            if (userContent && typeof userContent === 'string' && userContent.trim()) {
                reqBody.summary = userContent.trim().slice(0, 200);
            }
            if (self._floorId) {
                reqBody.floor_id = self._floorId;
            }
            var resp = await fetch(VISION_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify(reqBody),
                signal: self.abortController ? self.abortController.signal : undefined
            });

            if (resp.ok) {
                var data = await resp.json();
                // Redis 缓存命中 → 直接返回，跳过 SSE
                if (data.status === 'done') {
                    if (data.ge_cost) { self._visionCostWge += data.ge_cost; }
                    self._log('  ✓ vision done (cached)');
                    return data.description || '[Vision returned empty description]';
                }
                if (data.task_id) {
                    taskId = data.task_id;
                    self._log('  vision task: ' + taskId.slice(0, 12) + '...');
                    break;
                }
                self._log('  vision: no task_id in response');
                return null;
            }

            // 可重试的状态码
            if ((resp.status === 429 || resp.status === 502 || resp.status === 503) && retry < MAX_SUBMIT_RETRIES) {
                var waitMs = resp.status === 429 ? 3000 : 2000 * Math.pow(2, retry);
                self._log('  vision submit retry #' + (retry + 1) + ' in ' + waitMs + 'ms (HTTP ' + resp.status + ')');
                await new Promise(function (r) { setTimeout(r, waitMs); });
                continue;
            }

            if (resp.status === 413) { self._log('  vision skipped: image too large'); return null; }
            // 429 重试耗尽 → qoast 弹窗
            if (resp.status === 429) { try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('视觉分析请求过于频繁，已跳过部分图片', { type: 'warning' }); } catch (_) { } }
            self._log('  vision submit HTTP ' + resp.status + ': ' + (await resp.text().catch(function () { return ''; })).slice(0, 100));
            return null;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            if (retry < MAX_SUBMIT_RETRIES) {
                var waitMs2 = 2000 * Math.pow(2, retry);
                self._log('  vision submit retry #' + (retry + 1) + ' in ' + waitMs2 + 'ms (' + (err.message || err) + ')');
                await new Promise(function (r) { setTimeout(r, waitMs2); });
                continue;
            }
            self._log('  vision submit failed: ' + (err.message || err));
            return null;
        }
    }

    if (!taskId) return null;

    // Step 2: SSE push (retry once on 404)
    var streamUrl = VISION_URL + '/' + taskId + '/stream';
    var MAX_STREAM_RETRIES = 1;
    for (var streamRetry = 0; streamRetry <= MAX_STREAM_RETRIES; streamRetry++) {
        try {
            var streamResp = await fetch(streamUrl, {
                headers: { 'Authorization': 'Bearer ' + token },
                signal: self.abortController ? self.abortController.signal : undefined
            });
            if (!streamResp.ok) {
                if (streamResp.status === 404) {
                    if (streamRetry < MAX_STREAM_RETRIES) {
                        self._log('  vision stream 404, retry in 1s...');
                        await new Promise(function (r) { setTimeout(r, 1000); });
                        continue;
                    }
                    self._log('  vision task expired'); return null;
                }
                self._log('  vision stream HTTP ' + streamResp.status);
                return null;
            }

            var reader = streamResp.body.getReader();
            var decoder = new TextDecoder();
            var textBuf = '';
            var sseStart = Date.now();
            var MAX_SSE_WAIT = 120000;

            while (Date.now() - sseStart < MAX_SSE_WAIT) {
                var chunk = await reader.read();
                if (chunk.done) break;
                textBuf += decoder.decode(chunk.value, { stream: true });

                // 解析 SSE lines
                var lines = textBuf.split('\n');
                textBuf = lines.pop();
                var eventData = '';
                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li];
                    if (line.startsWith('data: ')) {
                        eventData = line.slice(6);
                    } else if (line === '' && eventData) {
                        try {
                            var evt = JSON.parse(eventData);
                            if (evt.status === 'done') {
                                if (evt.ge_cost) { self._visionCostWge += evt.ge_cost; }
                                var elapsedSse = ((Date.now() - sseStart) / 1000).toFixed(1);
                                self._log('  ✓ vision done (SSE) in ' + elapsedSse + 's');
                                reader.cancel();
                                return evt.description || '[Vision returned empty description]';
                            }
                            if (evt.status === 'error') {
                                self._log('  ✗ vision error: ' + (evt.error || 'unknown'));
                                reader.cancel();
                                return null;
                            }
                        } catch (_) { }
                        eventData = '';
                    }
                }
            }
            reader.cancel();
            self._log('  ✗ vision SSE timeout');
            return null;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            if (streamRetry < MAX_STREAM_RETRIES) {
                self._log('  vision SSE error, retry in 1s: ' + (err.message || err));
                await new Promise(function (r) { setTimeout(r, 1000); });
                continue;
            }
            self._log('  ✗ vision SSE error: ' + (err.message || err));
            return null;
        }
    } // stream retry loop
};
