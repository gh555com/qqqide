// ============================================================================
// system-prompt.js — 网关常量 + tier 定义 + 规则加载 + 时间上下文
// ============================================================================

// ★ GATEWAY_URL — 保留向后兼容，实际 fetch 已全部经 AiGateway 统一代理
//    AiGateway 内部持有 URL 唯一真理（ai-gateway.js）
const GATEWAY_URL_PRIMARY = 'https://direct-cn.gh555.com/api/v3/ai/chat';
const GATEWAY_URL_FALLBACK = 'https://gh555.com/api/v3/ai/chat';
var GATEWAY_URL = GATEWAY_URL_PRIMARY;
var _gwUsingFallback = false;
var _gwFallbackAt = 0;
var _GW_FALLBACK_RETRY_MS = 5 * 60 * 1000;

// 切线路 + qoast 提示
function _gwSwitch(toFallback) {
    if (_gwUsingFallback === toFallback) return;
    _gwUsingFallback = toFallback;
    GATEWAY_URL = toFallback ? GATEWAY_URL_FALLBACK : GATEWAY_URL_PRIMARY;
    _gwFallbackAt = toFallback ? Date.now() : 0;
    try {
        var q = window.parent && window.parent.qqqideQoast;
        if (q) q.show(
            toFallback ? 'AI 网关已自动切换到备用线路' : 'AI 网关已切回主线路',
            { type: toFallback ? 'warning' : 'success' }
        );
    } catch (_) { }
    try {
        window.parent && window.parent.postMessage({
            type: 'qqq-gw-status',
            panel: (typeof _panelId !== 'undefined') ? _panelId : -1,
            fallback: toFallback,
            url: GATEWAY_URL
        }, '*');
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

function _gwBroadcastDeadFallback() {
    try {
        window.parent && window.parent.postMessage({
            type: 'qqq-gw-status',
            panel: (typeof _panelId !== 'undefined') ? _panelId : -1,
            fallback: true,
            fallbackDead: true,
            url: GATEWAY_URL_FALLBACK
        }, '*');
    } catch (_) { }
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

    var y = d.getFullYear();
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var h = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');

    return '\n\n═══ CURRENT TIME ═══\n' +
        'Right now it is ' + y + '-' + mo + '-' + dd + ' (' + dayName + ') ' + h + ':' + mi + ':' + s + ' ' + tzStr + '.\n' +
        'Always use this as the authoritative current time. The user may refer to "today", "now", "currently", or specific dates — resolve them relative to this timestamp.\n' +
        '═══════════════';
};

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GATEWAY_URL, VISION_URL, IMAGE_GEN_URL, SEARCH_WEB_URL, TIER_PRO, TIER_1, TIER_2, TIER_3, TIER_4, TIER_5, TIER_6, TIER_LIST, getTimeContext };
}

// ============================================================================
// 规则注入 — 两套规则，首轮合并注入一次，后续不重复消耗 token
// ============================================================================

// global.txt — 全局规则，所有 IDE 窗口共享（{appRoot}/Data/global.txt）
window.qqqideRulesContent = '';

window.loadQqqideRules = async function () {
    try {
        var bridge = parent.qqqideBridge;
        if (bridge && bridge.app && bridge.app.root) {
            var root = await bridge.app.root();
            var rulesPath = root.replace(/\\/g, '/').replace(/\/$/, '') + '/Data/global.txt';
            var text = await bridge.fs.read(rulesPath);
            if (text && text.trim()) {
                window.qqqideRulesContent = '[GLOBAL RULES — Permanent rules set by the user. You only see this message once at the start of the conversation. Remember and follow these rules in every interaction. Do NOT re-state or re-explain them unless asked.]\n\n' + text.trim() + '\n\n[END GLOBAL RULES]';
            }
        }
    } catch (e) { /* silent */ }
};

// project.txt — 项目规则，仅当前项目生效（{projectRoot}/qqq/alphal/rule/project.txt）
window.qqqideProjectRulesContent = '';

window.loadQqqideProjectRules = async function (projectRoot) {
    try {
        if (!projectRoot) return;
        var bridge = parent.qqqideBridge;
        if (!bridge) return;
        var projPath = projectRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/qqq/alphal/rule/project.txt';

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

            var _raw = text.trim();
            var _cleanLines = _raw.split('\n').filter(function (l) { return !/^\s*#/.test(l); }).join('\n');
            var _seen = {};
            var _injected = [];
            var _re = /rule"((?:[A-Za-z]:[\\\/]|\/)[^"]+)"/g;
            var _m;

            function _collectFiles(dirPath, _depth) {
                if (_depth > 6) return Promise.resolve([]);
                return bridge.fs.list(dirPath).then(function (entries) {
                    if (!entries || !entries.length) return [];
                    var _promises = entries.map(function (e) {
                        if (!e || !e.name || e.name.startsWith('.') || e.name === 'node_modules') return Promise.resolve([]);
                        var _full = dirPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + e.name;
                        if (e.isDir) return _collectFiles(_full, _depth + 1);
                        return Promise.resolve([_full]);
                    });
                    return Promise.all(_promises).then(function (_arrs) {
                        var _flat = [];
                        for (var _i = 0; _i < _arrs.length; _i++) { _flat = _flat.concat(_arrs[_i]); }
                        return _flat.sort();
                    });
                }).catch(function () { return []; });
            }

            while ((_m = _re.exec(_cleanLines)) !== null) {
                var _fp = _m[1];
                if (!_fp || _seen[_fp]) continue;
                _seen[_fp] = true;
                try {
                    var _st = await bridge.fs.stat(_fp).catch(function () { return null; });
                    if (!_st) continue;
                    if (_st.isDir) {
                        var _files = await _collectFiles(_fp, 0);
                        var _chunks = [];
                        for (var _fi = 0; _fi < _files.length; _fi++) {
                            try {
                                var _fc = await bridge.fs.read(_files[_fi]);
                                if (_fc && _fc.length > 20) {
                                    _chunks.push('\n--- ' + _files[_fi] + ' ---\n' + _fc.replace(/\r\n/g, '\n'));
                                }
                            } catch (_) { }
                        }
                        if (_chunks.length > 0) {
                            _injected.push('\n═══ AUTO-LOADED DIR: ' + _fp + ' (' + _chunks.length + ' files) ═══' + _chunks.join(''));
                        }
                    } else {
                        var _fc = await bridge.fs.read(_fp);
                        if (_fc && _fc.length > 50) {
                            _injected.push('\n═══ AUTO-LOADED: ' + _fp + ' ═══\n' + _fc.replace(/\r\n/g, '\n'));
                        }
                    }
                } catch (_) { }
            }
            if (_injected.length > 0) {
                window.qqqideProjectRulesContent += '\n\n[PRE-LOADED FILES — The following files are referenced in project rules and have been automatically loaded into context. Their content is already here — do NOT call read_file on them.]\n\n' + _injected.join('\n\n---\n\n');
            }
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
