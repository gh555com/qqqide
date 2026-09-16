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
//   4. 设置 UI（tier 组 "K" 按钮 → 弹窗：启用/地址/Key/模型/思考参数/测试连接）
//   5. 密钥静态加密：壳层 bridge.secure（safeStorage/DPAPI）——仅存密文（apiKeyEnc 字段）；
//      旧明文存量加载自动迁移；桥缺失/加密失败自动回退明文（零破坏）
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
        return { enabled: false, baseUrl: '', apiKey: '', apiKeyEnc: '', model: '', sendThinking: false, testedAt: 0, _locked: '' };
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
        return !!(c.apiKey && c.model && c.baseUrl);
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

    // ── 端点归一：任何写法都收敛到 …/chat/completions ──
    function _endpoint(baseUrl) {
        var u = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!u) return '';
        if (/\/chat\/completions$/.test(u)) return u;
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
    // ★ 思考参数（sendThinking 开时）：tier 1-2 关 / 3-4 high / 5-6 max（与平台档位语义一致）
    function _buildBody(body, opts, cfg) {
        var out = {
            model: cfg.model,
            messages: (body && body.messages) || [],
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: (body && body.max_tokens) || ((typeof ContentGateway !== 'undefined' && ContentGateway.MAX_RESPONSE_TOKENS) ? ContentGateway.MAX_RESPONSE_TOKENS : 393216)
        };
        if (body && body.tools && body.tools.length) {
            out.tools = body.tools;
            if (body.tool_choice) out.tool_choice = body.tool_choice;
        }
        if (cfg.sendThinking) {
            var tier = parseInt((opts && opts.tier) || 6, 10);
            if (tier >= 5) { out.thinking = { type: 'enabled' }; out.reasoning_effort = 'max'; }
            else if (tier >= 3) { out.thinking = { type: 'enabled' }; out.reasoning_effort = 'high'; }
            else { out.thinking = { type: 'disabled' }; }
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
    // 直连 fetch — ai-gateway.js chatFetch 唯一消费点
    // 返回 Promise<Response>；未启用/未配置 → null（调用方回落平台通道）
    // ════════════════════════════════════════════════════════════
    async function intercept(body, opts) {
        await _load();
        var cfg = get();
        if (!cfg.enabled || !_isConfigured(cfg)) return null;
        var url = _endpoint(cfg.baseUrl);
        if (!url) return null;
        var outBody = _buildBody(body, opts, cfg);
        var resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + cfg.apiKey
                },
                body: JSON.stringify(outBody),
                signal: (opts && opts.signal) || null
            });
        } catch (err) {
            var msg = (err && err.message) || String(err);
            var e2 = new Error('[' + _t('ai.byok.tag', '自带密钥') + '] ' + _t('ai.byok.errReach', '无法连接你配置的 AI 端点') + ': ' + msg);
            e2._byok = true;
            throw e2;
        }
        if (!resp.ok) return await _normalizeError(resp);
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
        if (!c.baseUrl || !c.apiKey || !c.model) {
            _st(_t('ai.byok.testNeedFill', '请先填写地址 / Key / 模型名'), 'var(--red)');
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
            var resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.apiKey },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
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
                    var e = j && j.error;
                    emsg = (typeof e === 'string') ? e : ((e && e.message) || j.message || '');
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
    // UI：tier 组 "K" 按钮 + 设置弹窗（样式全部走主题 CSS 变量）
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
            '#byok-panel input:focus{outline:1px solid var(--blue)}',
            '#byok-panel .bk-keywrap{display:flex;gap:6px;align-items:center}',
            '#byok-panel .bk-eye{flex:0 0 auto;width:30px;height:28px;border:1px solid var(--border-color);border-radius:3px;background:transparent;color:var(--text-primary);cursor:pointer}',
            '#byok-panel .bk-chk{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none}',
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
            '<div class="bk-row"><label class="bk-chk"><input type="checkbox" id="byok-think"><span>' +
            _t('ai.byok.think', '上送思考参数（thinking / reasoning_effort；服务商不支持请关闭）') + '</span></label></div>' +
            '<div class="bk-foot">' +
            '<button class="bk-btn" id="byok-test">' + _t('ai.byok.test', '测试连接') + '</button>' +
            '<span class="bk-test-status" id="byok-test-status"></span>' +
            '<span style="flex:1"></span>' +
            '<button class="bk-btn" id="byok-save">' + _t('ai.byok.save', '保存') + '</button>' +
            '</div>' +
            '<div class="bk-hint">' + _t('ai.byok.hint', '启用后：对话请求直连上述地址（不经本站、不计 ge）；贴图识别 / 生图 / 抠图 / 搜索仍走内置通道。密钥仅加密保存在本机（系统凭据保护）。') + '</div>';
        _overlay.appendChild(p);
        document.body.appendChild(_overlay);

        var $ = function (id) { return document.getElementById(id); };
        _overlay.addEventListener('click', function (e) { if (e.target === _overlay) _closePopup(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && _overlay && _overlay.style.display !== 'none') _closePopup();
        });
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
                st.textContent = _t('ai.byok.testNeedFill', '请先填写地址 / Key / 模型名');
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
            $(id).addEventListener('change', function () { _saveForm(); });
        });
        $('byok-think').addEventListener('change', function () { _saveForm(); });
    }

    function _readForm() {
        var $ = function (id) { return document.getElementById(id); };
        var c = get();
        return {
            enabled: c.enabled,
            baseUrl: ($('byok-baseurl') ? $('byok-baseurl').value : c.baseUrl).trim(),
            apiKey: ($('byok-key') ? $('byok-key').value : c.apiKey).trim(),
            model: ($('byok-model') ? $('byok-model').value : c.model).trim(),
            sendThinking: $('byok-think') ? $('byok-think').checked : c.sendThinking,
            testedAt: c.testedAt
        };
    }
    function _formConfigured() {
        var c = _readForm();
        return !!(c.baseUrl && c.apiKey && c.model);
    }
    async function _saveForm() {
        var c = _readForm();
        await save({
            baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, sendThinking: c.sendThinking
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
        var st = $('byok-test-status');
        if (c._locked === 'bridge') {
            st.textContent = '🔒 ' + _t('ai.byok.lockedBridge', '密钥已加密存储（当前实例不支持解密，重启 IDE 后自动解锁）');
        } else if (c._locked === 'decrypt') {
            st.textContent = '🔒 ' + _t('ai.byok.lockedDecrypt', '密钥无法在本机解密（可能来自其他设备），请重新输入');
        } else {
            st.textContent = c.enabled ? ('● ' + _t('ai.byok.tipOn', '自带 API Key：已启用')) : '';
        }
        st.style.color = 'var(--base01)';
        _overlay.style.display = '';
    }
    function _closePopup() { if (_overlay) _overlay.style.display = 'none'; }

    function _injectButton() {
        if (document.getElementById('byok-btn')) return;
        _injectStyle();
        var group = document.querySelector('.tier-group');
        if (!group) { setTimeout(_injectButton, 1500); return; }
        var btn = document.createElement('button');
        btn.className = 'tier-btn';
        btn.id = 'byok-btn';
        btn.textContent = 'K';
        btn.onclick = _openPopup;
        group.appendChild(btn);
        _refreshButton();
    }

    // ── 启动 ──
    function _boot() {
        _load().catch(function () { });
        _injectButton();
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
        buildBody: _buildBody   // 供测试/审计
    };

})();
