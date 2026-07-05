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

    // 构造视觉 prompt：把用户问题原文带上，做针对性识别
    var visionPrompt = '';
    if (userContent && typeof userContent === 'string' && userContent.trim()) {
        // ★ 借鉴 openhanako formatStructuredVisionNote：结构化视觉分析 prompt
        visionPrompt = 'You are a vision analysis assistant. Describe this image factually.\n' +
            'CRITICAL: Do NOT suggest tools, software, or procedures. Only describe what you see.\n' +
            'Respond in this structured format (one field per line, "field: value"):\n' +
            '  image_overview: <1-sentence summary of what this image is>\n' +
            '  visible_text: <text in the image, or "none">\n' +
            '  objects_and_layout: <key objects and their spatial arrangement>\n' +
            '  person_identity: <who is the person? full name if recognizable (celebrity/politician/athlete/historical figure). if no known person or unsure, say "none">\n' +
            '  subject_isolation: <is the main subject clearly separated from the background? yes/no/partial>\n' +
            '  background_description: <describe the background: solid color / gradient / complex scene / transparent-checkered>\n' +
            '  uncertainty: <any doubts or "none">\n\n' +
            'Now analyze:';
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

// ---- 调用 /api/v3/ai/vision（经 AiGateway 统一代理）----
AgentLoop.prototype._callVision = async function (base64, token, prompt, userContent) {
    var self = this;

    // ═══ Step 1: 提交任务（经 AiGateway） ═══
    if (typeof AiGateway === 'undefined' || !AiGateway.visionSubmit) {
        self._log('  ✗ vision: AiGateway not available');
        return null;
    }

    var submitOpts = {};
    if (prompt && typeof prompt === 'string' && prompt.trim()) {
        submitOpts.prompt = prompt.trim();
    }
    if (userContent && typeof userContent === 'string' && userContent.trim()) {
        submitOpts.summary = userContent.trim().slice(0, 200);
    }
    if (self._floorId) {
        submitOpts.floorId = self._floorId;
    }
    submitOpts.signal = self.abortController ? self.abortController.signal : undefined;

    var result = await AiGateway.visionSubmit(base64, token, submitOpts);
    if (!result) {
        self._log('  ✗ vision submit failed');
        return null;
    }

    // 缓存命中
    if (result.description !== undefined) {
        self._visionCostWge += (result.ge_cost || 0);
        self._log('  ✓ vision done (cached, cost=' + (result.ge_cost || 0) + 'wge)');
        return result.description || '[Vision returned empty description]';
    }

    if (!result.task_id) {
        self._log('  ✗ vision: no task_id');
        return null;
    }

    self._log('  vision task: ' + result.task_id.slice(0, 12) + '...');

    // ═══ Step 2: SSE 轮询（经 AiGateway） ═══
    var pollResult = await AiGateway.visionPoll(result.task_id, token);
    if (pollResult && pollResult.description) {
        self._visionCostWge += (pollResult.ge_cost || 0);
        self._log('  ✓ vision done (SSE, cost=' + (pollResult.ge_cost || 0) + 'wge)');
        return pollResult.description;
    }

    self._log('  ✗ vision poll failed');
    return null;
};
