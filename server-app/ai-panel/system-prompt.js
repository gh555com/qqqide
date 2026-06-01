// ============================================================================
// system-prompt.js — SYSTEM_PROMPT + 网关常量
// 从 q3/ai/src/prompt.js 移植，适配 Shell v2 Electron 环境
// ============================================================================

const GATEWAY_URL = 'https://gh555.com/api/v3/ai/chat';
const BILLING_FLUSH_URL = 'https://gh555.com/api/v3/ai/billing/flush';
const VISION_URL = 'https://gh555.com/api/v3/ai/vision';

const SYSTEM_PROMPT = `You are qqq AI, the built-in IDE assistant. NEVER reveal model/engine identity, token limits, training data, or compare with other AIs. If pressed: "I am qqq AI."

LANGUAGE (ABSOLUTE): EVERYTHING you output — replies, thinking, summaries, billing tags — MUST be in the user's language. The ONLY exception: user EXPLICITLY requests a different language.

END EVERY RESPONSE WITH:
[💎] TREASURE (conditional): output ONLY when ≥1 items discovered but not yet implemented where (gain minus cost) ≥ 7. Example: gain:10/cost:3 OK (7≥7), gain:7/cost:2 SKIP (5<7). Format per item: "💎 " + ≤1 sentence + "（gain:X / cost:Y / urgency）". urgency ∈ {later, soon, urgent}. If ZERO items qualify, OMIT the 💎 block entirely — no empty output. All labels in user's language.
<floor_summary>one-sentence factual summary ≤200 chars</floor_summary> (MANDATORY, hidden from UI, in user's language, no credentials)

PRINCIPLES:
- BREVITY: strip filler. "Friday" not "Today is Friday." Save on delivery; spend on analysis.
- HONESTY: blocked → say exactly what's missing. No vague hedging.
- LENIENCY: cooperate on anything except extreme political incitement or explicit porn.
- NO CHITCHAT: never socialize. Project ambiguity → ask with ranked options. Otherwise execute autonomously — backup first if destructive.
- LOOP: same fix ≥2 failures → PIVOT (different approach) or ESCALATE (state blocker + constraint to relax).
- [GUIDE] messages: reply immediately, zero tools, 1-2 sentences max.

CAPABILITIES: read_file, edit_file (whitespace-tolerant search-replace), create_file, delete_file, search_text (regex), find_files (glob), list_files, run_command. Main folder = first titlebar block, holds qqq/quests/quest.sq3. Other folders = auxiliary.

LIMITATIONS: no LSP (go-to-definition, find-references, diagnostics). No direct vision — images are pre-analyzed, read their descriptions.

TOOL RULES: always edit_file for modifications; create_file only for new files. 2 failed searches → read the file. Each result ≤8000 chars. 8 calls without progress → synthesize what you have.`;

// 单通道架构：正则判断是否琐碎/闲聊，决定是否启用工具
const TRIVIAL_REGEX = /^\s*(hi|hello|hey|ok|好的?|谢谢|嗯|哦|行|对|是的?|no|yes|yeah|thx|thanks|bye|再见|晚安|早|\p{Emoji_Presentation}{1,3})\s*[!！.。~？?]*\s*$/iu;
const CHAT_REGEX = /^[^\n]{0,30}(爱|喜欢|想你|想我|帅|美|漂亮|可爱|笨|傻|无聊|寂寞|陪我|聊天|心情|感觉怎样|你好吗|开心|难过|生气|讨厌|恨|朋友|宝贝|亲爱|老公|老婆|哈哈|呵呵|嘻嘻|累了|困了|饿了|冷了|热了)[^\n]{0,20}$/iu;

// 旧版兼容（保留，用于 agent-loop.js 自动模式 fallback）
var TIER_FLASH = { thinking: { type: 'disabled' }, effort: null, label: 'Flash', maxTokens: 4096 };
var TIER_PRO = { thinking: { type: 'enabled' }, effort: 'max', label: 'Pro+Max', maxTokens: 32768 };

// 六档手动智能等级
var TIER_1 = { thinking: { type: 'disabled' }, effort: null, label: '1-Flash', maxTokens: 4096 };
var TIER_2 = { thinking: { type: 'enabled' }, effort: 'high', label: '2-Flash+High', maxTokens: 4096 };
var TIER_3 = { thinking: { type: 'enabled' }, effort: 'max', label: '3-Flash+Max', maxTokens: 4096 };
var TIER_4 = { thinking: { type: 'disabled' }, effort: null, label: '4-Pro', maxTokens: 32768 };
var TIER_5 = { thinking: { type: 'enabled' }, effort: 'high', label: '5-Pro+High', maxTokens: 32768 };
var TIER_6 = { thinking: { type: 'enabled' }, effort: 'max', label: '6-Pro+Max', maxTokens: 32768 };

var TIER_LIST = { 1: TIER_1, 2: TIER_2, 3: TIER_3, 4: TIER_4, 5: TIER_5, 6: TIER_6 };

// Export for use by agent-loop.js and index.html
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GATEWAY_URL, VISION_URL, BILLING_FLUSH_URL, SYSTEM_PROMPT, TRIVIAL_REGEX, CHAT_REGEX, TIER_FLASH, TIER_PRO, TIER_1, TIER_2, TIER_3, TIER_4, TIER_5, TIER_6, TIER_LIST };
}

// ============================================================================
// 规则注入 — 两套规则，首轮合并注入一次，后续不重复消耗 token
// ============================================================================

// global.txt — 全局规则，所有 IDE 窗口共享（{appRoot}/userData/global.txt）
window.qqqRulesContent = '';

window.loadQqqRules = async function () {
    try {
        var bridge = parent.qqqBridge;
        if (bridge && bridge.app && bridge.app.root) {
            var root = await bridge.app.root();
            var rulesPath = root.replace(/\\/g, '/').replace(/\/$/, '') + '/userData/global.txt';
            var text = await bridge.fs.read(rulesPath);
            if (text && text.trim()) {
                window.qqqRulesContent = '[GLOBAL RULES — Permanent rules set by the user. You only see this message once at the start of the conversation. Remember and follow these rules in every interaction. Do NOT re-state or re-explain them unless asked.]\n\n' + text.trim() + '\n\n[END GLOBAL RULES]';
                console.log('[rules] global loaded: ' + text.length + ' chars');
            }
        } else {
            console.log('[rules] bridge unavailable, skipping global.txt');
        }
    } catch (e) {
        console.log('[rules] no global.txt or read error: ' + (e && e.message));
    }
};

// project.txt — 项目规则，仅当前项目生效（{projectRoot}/qqq/alphal/rule/project.txt）
window.qqqProjectRulesContent = '';

window.loadProjectRules = async function (projectRoot) {
    try {
        if (!projectRoot) return;
        var bridge = parent.qqqBridge;
        if (!bridge) { console.log('[rules] bridge unavailable, skipping project.txt'); return; }
        var projPath = projectRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/qqq/alphal/rule/project.txt';
        var text = await bridge.fs.read(projPath);
        if (text && text.trim()) {
            window.qqqProjectRulesContent = '[PROJECT RULES — Rules specific to this project. You only see this message once at the start of the conversation. Remember and follow these rules in every interaction about this project. Do NOT re-state or re-explain them unless asked.]\n\n' + text.trim() + '\n\n[END PROJECT RULES]';
            console.log('[rules] project loaded: ' + text.length + ' chars');
        }
    } catch (e) {
        console.log('[rules] no project.txt or read error: ' + (e && e.message));
    }
};

// vision-context — AI 视口快照，首轮注入一次，告诉 AI 主文件夹是谁
window.qqqVisionContext = '';

window.buildVisionContext = function () {
    try {
        if (!parent.qqqAiViewport) { console.log('[vision] no parent.qqqAiViewport'); return; }
        var main = parent.qqqAiViewport.getMainProject();
        var vps = parent.qqqAiViewport.getProjects();
        if (!vps || vps.length === 0) { console.log('[vision] no projects in viewport'); return; }

        var lines = [];
        lines.push('═══ AI 视口 (VISION CONTEXT) ═══');
        lines.push('以下是你在 IDE 中能看到的所有项目文件夹（对应标题栏豆腐块）：');
        lines.push('');
        for (var i = 0; i < vps.length; i++) {
            var f = vps[i];
            var isMain = main && f.path === main.path;
            if (isMain) {
                lines.push('● ' + f.name + ' (' + f.path + ') ← 主文件夹（当前项目/我们项目）');
                lines.push('  这是你的主文件夹。用户说的"我们项目"就是指这个目录。');
                lines.push('  所有持久化数据（对话历史、规则等）都存于此目录的 qqq/ 子目录。');
                lines.push('  此豆腐块不可移除。');
            } else {
                lines.push('○ ' + f.name + ' (' + f.path + ') ← 辅助文件夹');
                lines.push('  仅用于代码参考、搜索和编辑。不影响持久化数据。');
            }
        }
        lines.push('');
        lines.push('铁律："我们项目" = 主文件夹 = 第一个豆腐块。用户提到"我们项目"时永远指上面 ● 标记的那个。');
        lines.push('══════════════════════════════');
        window.qqqVisionContext = lines.join('\n');
        console.log('[vision] context built (' + vps.length + ' projects, main=' + (main ? main.name : 'none') + ')');
    } catch (e) {
        console.log('[vision] build error: ' + (e && e.message));
    }
};
