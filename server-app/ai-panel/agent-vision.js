// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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

    // signal 取「本楼层真理源」`_stopCtrl`（_executeSend 每层重建），不取 `abortController`
    // （agent-gateway 逐请求重建）。2026-10-14 13:26 实测坑：上一楼层还在跑时用户直接发
    // 下一句 → 面板掐掉在飞请求（boot.log 13:26:19.919 ERR 19073ms）→ `abortController`
    // 还是上一个（已 aborted）的 → 预分析拿到 aborted 信号后静默返回 null → 该楼层贴图
    // 没有预分析且零网络调用。_stopCtrl 仍会在用户真按 Stop 时被掐 → 语义不变。
    var _floorSig = null;
    try {
        _floorSig = (self._stopCtrl && self._stopCtrl.signal)
            || (self.abortController && self.abortController.signal) || null;
    } catch (_) { }

    // ═══ Step 0: 「你的模型」通道（BYOK 多模态，2026-10-14）═══
    //   开启条件：自带密钥已启用 + 勾选「视觉走你的模型」（自带密钥面板 Z 按钮）
    //   语义：图片直接交给用户所配端点的多模态模型看，不经平台云端 /api/v3/ai/vision，不计 ge
    //   失败不阻断：如实记一行日志后回落云端（禁砖化）；用户 Stop 不回落
    if (typeof qqqByok !== 'undefined' && qqqByok && qqqByok.visionActive && qqqByok.visionActive()) {
        var _vprompt = (prompt && String(prompt).trim()) ? prompt : (
            'Analyze this image factually.' +
            (userContent && String(userContent).trim() ? '\nThe user asks: ' + String(userContent).trim().slice(0, 300) : ''));
        var _vr = await qqqByok.visionChat({
            base64: base64,
            prompt: _vprompt,
            floorId: self._floorId || '',
            signal: _floorSig || undefined
        });
        if (_vr && _vr.ok && _vr.text) {
            self._floorByokUsed = true;
            self._floorByokRoute = _vr.route || 'direct';
            self._log('  \u2713 vision \u8d70\u4f60\u7684\u6a21\u578b (' + _vr.model + ', ' + (_vr.route || 'direct') + ', 0 ge)');
            return _vr.text;
        }
        if (_vr && _vr.error === 'aborted') { self._log('  \u26a0 vision \u5df2\u88ab\u505c\u6b62'); return null; }
        self._log('  \u26a0 vision \u4f60\u7684\u6a21\u578b\u5931\u8d25 \u2192 \u56de\u843d\u4e91\u7aef: ' + ((_vr && _vr.error) || 'unknown'));
    } else {
        // voff：贴图预分析「根本没尝试」你的模型（未勾选 / 未启用 / cfg 尚未加载完）。
        // 与 v/vok/vf 配合才能定性：v 不增而 voff 增 = 门未开；v 增 vok 不增 = 试了但被拒。
        try { if (typeof qqqByok !== 'undefined' && qqqByok && qqqByok.vig) qqqByok.vig({ voff: 1 }); } catch (_) { }
    }

    // ═══ Step 1: 云端提交（未勾选 / 你的模型本次失败才到这里；经 AiGateway） ═══
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
    submitOpts.signal = _floorSig || undefined;   // 同上：用本楼层真理源，不用上一个请求残留的 abortController

    var result = await AiGateway.visionSubmit(base64, token, submitOpts);
    if (!result) {
        self._log('  ✗ vision submit failed');
        return null;
    }

    // 缓存命中
    if (result.description !== undefined) {
        self._visionCostWge += (result.ge_cost || 0);
        if (result.billing_request_id) self._visionBillingRequestId = result.billing_request_id;
        self._log('  ✓ vision done (cached, cost=' + (result.ge_cost || 0) + 'wge, receipt=' + (result.billing_request_id || 0) + ')');
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
        if (pollResult.billing_request_id) self._visionBillingRequestId = pollResult.billing_request_id;
        self._log('  ✓ vision done (SSE, cost=' + (pollResult.ge_cost || 0) + 'wge, receipt=' + (pollResult.billing_request_id || 0) + ')');
        return pollResult.description;
    }

    // 服务端终态错误：如实透传原因（如「视觉服务暂不可用」），不再折叠成 poll failed
    if (pollResult && pollResult.error) {
        self._log('  ✗ vision error: ' + pollResult.error);
        return null;
    }

    self._log('  ✗ vision poll failed');
    return null;
};
