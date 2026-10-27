// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// system-prompt.js — 网关常量 + tier 定义 + 规则加载 + 时间上下文
// ============================================================================

// ★ GATEWAY_URL — 保留向后兼容，实际 fetch 已全部经 AiGateway 统一代理
//    AiGateway 内部持有 URL 唯一真理（ai-gateway.js）
const GATEWAY_URL_PRIMARY = 'https://direct-cn.gh555.com/api/v3/ai/chat';
const GATEWAY_URL_FALLBACK = 'https://direct.gh555.com/api/v3/ai/chat';
var GATEWAY_URL = GATEWAY_URL_PRIMARY;
var _gwUsingFallback = false;
var _gwFallbackAt = 0;
var _GW_FALLBACK_RETRY_MS = 5 * 60 * 1000;

// 切线路 + qoast 提示
function _gwSwitch(toFallback) {
    // ★ 自带 API Key 通道（byok.js）：单端点直连，无平台线路概念——静默跳过，防误报「线路切换」
    try { if (window.qqqByok && window.qqqByok.isActive && window.qqqByok.isActive()) return; } catch (_) { }
    if (_gwUsingFallback === toFallback) return;
    _gwUsingFallback = toFallback;
    GATEWAY_URL = toFallback ? GATEWAY_URL_FALLBACK : GATEWAY_URL_PRIMARY;
    _gwFallbackAt = toFallback ? Date.now() : 0;
    try {
        var q = window.parent && window.parent.qqqideQoast;
        if (q) q.show(
            toFallback ? _qq('ai.gwFallback', 'AI 网关已自动切换到备用线路') : _qq('ai.gwPrimary', 'AI 网关已切回主线路'),
            { type: toFallback ? 'warning' : 'success' }
        );
    } catch (_) { }
}

function _gwTryPrimary() {
    if (!_gwUsingFallback) return false;
    if (Date.now() - _gwFallbackAt < _GW_FALLBACK_RETRY_MS) return false;
    GATEWAY_URL = GATEWAY_URL_PRIMARY;
    return true;
}

function _gwPrimaryFailed() {
    if (_gwUsingFallback) {
        GATEWAY_URL = GATEWAY_URL_FALLBACK;
        _gwFallbackAt = Date.now();
    }
}

// ★ 工具计费累加（wge 累计）
function _addToolWgeCost(wgeCost) {
    if (!wgeCost || wgeCost <= 0) return;
    try {
        var ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
        if (ag && typeof ag._floorCostWge === 'number') {
            ag._floorCostWge += wgeCost;
        }
    } catch (_) { }
}

// ★ VISION_URL / IMAGE_GEN_URL / SEARCH_WEB_URL — 保留向后兼容
//    实际调用已经 AiGateway 统一代理
const VISION_URL = 'https://direct-cn.gh555.com/api/v3/ai/vision';
const IMAGE_GEN_URL = 'https://direct-cn.gh555.com/api/v3/ai/generate-image';
const SEARCH_WEB_URL = 'https://direct-cn.gh555.com/api/v3/search/web';

// ★ SYSTEM_PROMPT 已移至服务端 gaea/guard/system-prompt.txt
//   Go 侧 guard.GuardMessage() 在 handlers_ai_chat.go §6 自动 prepend 到 messages[0]
//   客户端不再携带甲壳文本，防 TLS MITM/逆向破甲
//   所有 typeof SYSTEM_PROMPT === 'undefined' 的消费方自动跳过（panel-alltxt.js / panel-floor.js）

// ═══ AI 回答 max_tokens — 唯一真理在 ContentGateway.MAX_RESPONSE_TOKENS（content-gateway.js） ═══
// 原生支持 384K 输出，我们不设人为限制。Flash/Pro 一视同仁。
var _MRT = ContentGateway.MAX_RESPONSE_TOKENS;

var TIER_PRO = { model: 'deep', thinking: { type: 'enabled' }, effort: 'max', label: '6-Deep+Max', maxTokens: _MRT };

// 六档手动智能等级
var TIER_1 = { model: 'fast', thinking: { type: 'disabled' }, effort: null, label: '1-Fast', maxTokens: _MRT };
var TIER_2 = { model: 'fast', thinking: { type: 'enabled' }, effort: 'high', label: '2-Fast+High', maxTokens: _MRT };
var TIER_3 = { model: 'fast', thinking: { type: 'enabled' }, effort: 'max', label: '3-Fast+Max', maxTokens: _MRT };
var TIER_4 = { model: 'deep', thinking: { type: 'disabled' }, effort: null, label: '4-Deep', maxTokens: _MRT };
var TIER_5 = { model: 'deep', thinking: { type: 'enabled' }, effort: 'high', label: '5-Deep+High', maxTokens: _MRT };
var TIER_6 = { model: 'deep', thinking: { type: 'enabled' }, effort: 'max', label: '6-Deep+Max', maxTokens: _MRT };

var TIER_LIST = { 1: TIER_1, 2: TIER_2, 3: TIER_3, 4: TIER_4, 5: TIER_5, 6: TIER_6 };

// ★ 三键档位映射（2026-09-16 定案）：服务端 tier_semantics 下 {1,2}/{3,4}/{5,6} 三组等价
//   （1-4→快档 / 5-6→深档；思考档 关/high/max）→ 面板只留三个代表键（线上值 1/3/5，显示 1/2/3）
//   旧存量 1..6 全兼容（无需迁移）：任意线上值都能换算显示数/代表值
function _tierUiOf(idx) { var n = parseInt(idx, 10); if (!(n >= 1)) return n; return Math.ceil(n / 2); }        // 线上档 → 三键显示数（1..3）
function _tierRepOf(idx) { var n = parseInt(idx, 10); if (!(n >= 1)) return n; return Math.ceil(n / 2) * 2 - 1; } // 任意档 → 组代表值（1/3/5；按钮高亮/点击用）

// ═══ 时间上下文：与状态栏时钟共享同一 SSE 时间锚点（单调时钟，变速齿轮免疫） ═══
window.getTimeContext = function () {
    var utcMs;
    if (window._serverTimeAnchor && window._serverTimeAnchor.perfNow && window._serverTimeAnchor.utcMs) {
        utcMs = window._serverTimeAnchor.utcMs + (performance.now() - window._serverTimeAnchor.perfNow);
    } else {
        utcMs = Date.now();
    }
    var d = new Date(utcMs);
    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var dayName = DAYS[d.getDay()];
    var tzOffset = -d.getTimezoneOffset();
    var tzHours = Math.floor(Math.abs(tzOffset) / 60);
    var tzSign = tzOffset >= 0 ? '+' : '-';
    var tzMin = Math.abs(tzOffset) % 60;
    var tzStr = 'UTC' + tzSign + tzHours + (tzMin ? ':' + String(tzMin).padStart(2, '0') : '');

    var _now = _fmtTime(d);
    var datePart = _now.slice(0, 10);
    var timePart = _now.slice(11);

    // ★ 短格式：仅时间戳。约束文本在服务端甲壳 system-prompt.txt 开头（一次注入，零重复）
    return '\n\n[CURRENT TIME: ' + datePart + ' (' + dayName + ') ' + timePart + ' ' + tzStr + ']';
};

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GATEWAY_URL, VISION_URL, IMAGE_GEN_URL, SEARCH_WEB_URL, TIER_PRO, TIER_1, TIER_2, TIER_3, TIER_4, TIER_5, TIER_6, TIER_LIST, getTimeContext };
}

// ============================================================================
// 规则注入 — 两套规则，首轮合并注入一次，后续不重复消耗 token
// ============================================================================

// ★ 通用：解析规则文本中的 rule"..." 引用，返回预加载块（global/project 共用，2026-08-15 统一）
window._injectRuleRefs = async function (rawText, bridge) {
    var _injected = [];
    var _seen = {};
    var _cleanLines = rawText.split('\n').filter(function (l) { return !/^\s*#/.test(l); }).join('\n');
    var _re = /rule"((?:[A-Za-z]:[\\\/]|\/)[^"]+)"/g;
    var _m;
    while ((_m = _re.exec(_cleanLines)) !== null) {
        var _fp = _m[1];
        if (!_fp || _seen[_fp]) continue;
        _seen[_fp] = true;
        try {
            var _st = await bridge.fs.stat(_fp).catch(function () { return null; });
            if (!_st || _st.isDir) continue;
            var _fc = await bridge.fs.read(_fp);
            if (_fc && _fc.length > 50) {
                _injected.push('\n═══ AUTO-LOADED: ' + _fp + ' ═══\n' + _fc.replace(/\r\n/g, '\n'));
            }
        } catch (_) { }
    }
    if (_injected.length === 0) return '';
    return '\n\n[PRE-LOADED FILES — The following files are referenced in rules and have been automatically loaded into context. Their content is already here — do NOT call read_file on them.]\n\n' + _injected.join('\n\n---\n\n');
};

// ============================================================================
// 内置能力清单（capability manifest）—— 唯一真理源：{载荷根}/capabilities/*.md
//   能力与它的路由提示同包同住：装包时带什么能力，就注入什么提示。
//   文件首部自述：<!--@cap  probe: <相对载荷根路径>  suppress: <用户规则里需屏蔽的旧文案行> -->
//   · probe 在本机不存在 → 本能力不注入（工具链被裁剪/未装 = 提示自动消失，绝不指向空气）
//   · 新增能力 = 丢一个 md 文件，代码零改动；用户数据（global.txt）里不写任何产品文案
//   · suppress 是兼容存量用：旧版曾把提示写进用户的 global.txt，注入时按声明屏蔽该行（不改盘）
// ============================================================================
window._loadQqqideCapabilities = async function (bridge) {
    var out = { text: '', suppress: [] };
    try {
        if (!bridge || !bridge.fs || !bridge.app || !bridge.app.root) return out;
        var roots = [];
        try {
            if (bridge.boot && bridge.boot.getInfo) {
                var _bi = await bridge.boot.getInfo();
                if (_bi && _bi.userData) roots.push(String(_bi.userData).replace(/\\/g, '/').replace(/\/$/, '') + '/webapp');
            }
        } catch (_) { }
        var _ar = String((await bridge.app.root()) || '').replace(/\\/g, '/').replace(/\/$/, '');
        if (_ar) {
            roots.push(_ar + '/resources/app/server-app');
            roots.push(_ar + '/server-app');
        }
        var capDir = '', capRoot = '';
        for (var i = 0; i < roots.length; i++) {
            var st = await bridge.fs.stat(roots[i] + '/capabilities').catch(function () { return null; });
            if (st && st.isDir) { capDir = roots[i] + '/capabilities'; capRoot = roots[i]; break; }
        }
        if (!capDir) return out;
        var list = await bridge.fs.list(capDir).catch(function () { return null; });
        if (!list || !list.length) return out;
        var names = [];
        for (var j = 0; j < list.length; j++) {
            var nm = (list[j] && list[j].name) ? list[j].name : '';
            if (nm && /\.md$/i.test(nm) && !list[j].isDir) names.push(nm);
        }
        names.sort();
        var blocks = [];
        for (var k = 0; k < names.length; k++) {
            var raw = await bridge.fs.read(capDir + '/' + names[k]).catch(function () { return null; });
            if (!raw) continue;
            var probe = '', sup = [];
            var body = raw;
            var m = /^\s*<!--@cap([\s\S]*?)-->/.exec(raw);
            if (m) {
                body = raw.slice(m[0].length);
                var head = m[1] || '';
                var pm = /probe\s*:\s*(.+)/i.exec(head);
                if (pm) probe = pm[1].trim();
                var supRe = /suppress\s*:\s*(.+)/gi, sm;
                while ((sm = supRe.exec(head)) !== null) { var _s = sm[1].trim(); if (_s) sup.push(_s); }
            }
            var resolved = '';
            if (probe) {
                var pc = capRoot + '/' + probe;
                var ps = await bridge.fs.stat(pc).catch(function () { return null; });
                if (!ps || ps.isDir) continue;   // 本机未装该能力 → 不注入
                resolved = pc;
            }
            var txt = body.replace(/\{\{probe\}\}/g, resolved)
                .replace(/\{\{dir\}\}/g, resolved ? resolved.replace(/\/[^\/]*$/, '') : capDir)
                .replace(/^\s+|\s+$/g, '');
            if (!txt) continue;
            blocks.push(txt);
            out.suppress = out.suppress.concat(sup);
        }
        if (blocks.length) out.text = blocks.join('\n\n');
    } catch (_) { /* 清单缺失/损坏 → 静默不注入 */ }
    return out;
};

// 存量兼容：用户规则里旧版种子写进去的能力提示行 → 注入时屏蔽（只去该行，不动用户其他规则，不改盘）
function _qqqStripSuppressed(text, list) {
    if (!text || !list || !list.length) return text;
    var lines = String(text).split('\n');
    var keep = [];
    for (var i = 0; i < lines.length; i++) {
        var hit = false;
        for (var j = 0; j < list.length; j++) {
            if (list[j] && lines[i].indexOf(list[j]) !== -1) { hit = true; break; }
        }
        if (!hit) keep.push(lines[i]);
    }
    return keep.join('\n');
}
window._qqqStripSuppressed = _qqqStripSuppressed;   // 同体出口：离线冒烟可验证（注入链仍只走内部调用）

// global.txt — 全局规则，所有 IDE 窗口共享（Data 根 = bootinfo.userData；win/dev = {appRoot}/Data，
//   mac = {宿主}/qqqide-data/Data——与 RULES 按钮写入端 login.js 同源同口径），与 project.txt 同权支持 rule"..."（2026-08-15）
window.qqqideRulesContent = '';

window.loadQqqideRules = async function () {
    try {
        var bridge = parent.qqqideBridge;
        if (bridge && bridge.app && bridge.app.root) {
            var root = await bridge.app.root();
            // ★ Data 根解析（mac：app.root() = bundle 内 Contents/MacOS——真值走 bootinfo.userData）
            var _dr = '';
            try {
                if (bridge.boot && bridge.boot.getInfo) {
                    var _bi = await bridge.boot.getInfo();
                    if (_bi && _bi.userData) _dr = String(_bi.userData).replace(/\\/g, '/').replace(/\/$/, '');
                }
            } catch (_) { }
            if (!_dr) _dr = root.replace(/\\/g, '/').replace(/\/$/, '') + '/Data';
            // ★ 内置能力（产品自带、跟随载荷）：与用户规则彻底解耦——用户删/改 global.txt 不影响它
            var _caps = await window._loadQqqideCapabilities(bridge);
            var _capBlock = _caps.text
                ? '[BUILT-IN CAPABILITIES — shipped with this installation, not user rules. Paths are resolved for this machine; ignore any capability you do not need.]\n\n' + _caps.text + '\n\n[END BUILT-IN CAPABILITIES]'
                : '';

            var rulesPath = _dr + '/global.txt';
            var text = await bridge.fs.read(rulesPath);
            if (text && _caps.suppress.length) text = _qqqStripSuppressed(text, _caps.suppress);
            var _out = '';
            if (text && text.trim()) {
                _out = '[GLOBAL RULES — Permanent rules set by the user. You only see this message once at the start of the conversation. Remember and follow these rules in every interaction. Do NOT re-state or re-explain them unless asked.]\n\n' + text.trim() + '\n\n[END GLOBAL RULES]';
            }
            if (_capBlock) _out = _out ? (_out + '\n\n' + _capBlock) : _capBlock;
            if (text && text.trim()) {
                var _pre = await window._injectRuleRefs(text, bridge);
                if (_pre) _out += _pre;
            }
            window.qqqideRulesContent = _out;
        }
    } catch (e) { /* silent */ }
};

// project.txt — 项目规则，仅当前项目生效（{projectRoot}/_qqq/alphal/rule/project.txt）
window.qqqideProjectRulesContent = '';

window.loadQqqideProjectRules = async function (projectRoot) {
    try {
        if (!projectRoot) return;
        var bridge = parent.qqqideBridge;
        if (!bridge) return;
       var projPath = projectRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/_qqq/alphal/rule/project.txt';

        var _cachedRoot = window._qqqideProjectRulesRoot || '';
        if (projectRoot !== _cachedRoot) {
            window._qqqideProjectRulesMtime = 0;
            window._qqqideProjectRulesRoot = projectRoot;
        }

        var stat = await bridge.fs.stat(projPath).catch(function () { return null; });
        if (!stat) { window._qqqideProjectRulesMtime = 0; return; }

        var _mtimeNow = stat.mtimeMs || 0;
        if (_mtimeNow && _mtimeNow === window._qqqideProjectRulesMtime && window.qqqideProjectRulesContent) {
            return;
        }
        window._qqqideProjectRulesMtime = _mtimeNow;

        var text = await bridge.fs.read(projPath);
        if (text && text.trim()) {
            window.qqqideProjectRulesContent = '[PROJECT RULES — Rules specific to this project. You only see this message once at the start of the conversation. Remember and follow these rules in every interaction about this project. Do NOT re-state or re-explain them unless asked.]\n\n' + text.trim() + '\n\n[END PROJECT RULES]';

            var _pre = await window._injectRuleRefs(text, bridge);
            if (_pre) window.qqqideProjectRulesContent += _pre;
        }
    } catch (e) { /* silent */ }
};

// vision-context — AI viewport snapshot, injected once at quest start
window.qqqideVisionContext = '';

window.buildQqqideVisionContext = function () {
    try {
        if (!parent.qqqideViewport) return;
        var vps = parent.qqqideViewport.getProjects();

        var panelRoot = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
        if (panelRoot) { panelRoot = panelRoot.replace(/\\/g, '/').replace(/\/$/, ''); }

        if ((!vps || vps.length === 0) && !panelRoot) return;

        var lines = [];
        lines.push('═══ PROJECT FOLDERS ═══');

        var foundPanel = false;
        if (vps && vps.length > 0) {
            for (var i = 0; i < vps.length; i++) {
                var f = vps[i];
                var fPath = (f.path || '').replace(/\\/g, '/').replace(/\/$/, '');
                var isMain = panelRoot && fPath === panelRoot;
                if (isMain) foundPanel = true;
                if (isMain) {
                    lines.push('⭐ ' + f.name + '  →  ' + f.path + '  ← MAIN PROJECT (default)');
                } else {
                    lines.push('   ' + f.name + '  →  ' + f.path + '  ← auxiliary');
                }
            }
        }
        if (!foundPanel && panelRoot) {
            var name = panelRoot.split('/').pop() || panelRoot;
            lines.splice(0, 0, '⭐ ' + name + '  →  ' + panelRoot + '  ← MAIN PROJECT (default)');
        }

        lines.push('');
        lines.push('Rules:');
        lines.push('• If the user does NOT specify a project, default to the ⭐ MAIN PROJECT.');
        lines.push('• You MAY operate on auxiliary projects if the user asks or the task requires cross-project work.');
        lines.push('• Conversation persistence (quest/history) lives in the MAIN PROJECT\'s qqq/ subdirectory.');
        lines.push('══════════════════');

        window.qqqideVisionContext = lines.join('\n');
    } catch (e) {
        console.warn('[vision] build error: ' + (e && e.message));
    }
};
