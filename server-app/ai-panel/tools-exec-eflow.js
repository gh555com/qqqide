// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ════════════════════════════════════════════════════════════════════════════
// tools-exec-eflow.js — eflow 工具（E-Flow v2 文档地基）
//
// 逻辑一个字都不在这里：全部在 server-app/eflow/eflow-core.js（与命令行体检共用同一份）。
// 这里只做两件事：① 把 bridge.fs 包成 core 要的 IO ② 把结果转成人能读的文本。
//
// 为什么要有这个工具：文档地基的「算术」（每轮注入字数、路由表同步、经验复核期）
// 必须机器判。让 AI 自己数、自己对齐 = 每个项目一套口径 = 等于没闸门。
// ════════════════════════════════════════════════════════════════════════════

var EFLOW_OPS = ['status', 'check', 'index', 'init', 'upgrade', 'detach', 'rotate', 'global'];

function _eflowRoot() {
    try {
        if (typeof questStore !== 'undefined' && questStore.getProjectRoot) {
            var r = questStore.getProjectRoot();
            if (r) return String(r).replace(/\\/g, '/').replace(/\/+$/, '');
        }
    } catch (_) { }
    return '';
}

// 用户级目录（全局开关的家）：mac 的 app.root() 在 bundle 内 → 真值走 bootinfo.userData
async function _eflowDataRoot(bridge) {
    try {
        if (bridge && bridge.boot && bridge.boot.getInfo) {
            var bi = await bridge.boot.getInfo();
            if (bi && bi.userData) return String(bi.userData).replace(/\\/g, '/').replace(/\/+$/, '');
        }
    } catch (_) { }
    try {
        var r = await bridge.app.root();
        if (r) return String(r).replace(/\\/g, '/').replace(/\/+$/, '') + '/Data';
    } catch (_) { }
    return '';
}

// ★ 用户原话的唯一来源 = 会话真相（禁模型自述）：
//   取最近一条「真实用户消息」（排除 rules 注入 / GUIDE / 恢复楼系统代发），剥掉系统追加的时间块。
//   模型自己写 confirm="1" 不算——那等于让被告自己当法官。
function _eflowUserTruth(ag) {
    var out = { ok: false, text: '', seq: -1, floor: 0, qid: '' };
    try {
        if (!ag) return out;
        out.qid = String(ag._questId || '');
        var conv = ag.conversation || [];
        var last = null, n = 0;
        for (var i = 0; i < conv.length; i++) {
            var m = conv[i];
            if (!m || m.role !== 'user') continue;
            if (m._persistent || m._injected || m._system) continue;
            n++;
            last = m;
        }
        out.seq = n;
        if (last) {
            out.text = String(last.content == null ? '' : last.content)
                .replace(/\s*\[CURRENT TIME:[^\]]*\]\s*$/i, '')
                .trim();
            out.floor = Number(last._floor) || 0;
        }
        out.ok = !!last;
    } catch (_) { }
    return out;
}

async function executeEflow(args, ownerAgent) {
    var core = (typeof EflowCore !== 'undefined' && EflowCore && EflowCore.run) ? EflowCore : null;
    if (!core) return 'Error: eflow core not loaded in this window (server-app/eflow/eflow-core.js missing). Say so honestly; do not hand-roll the checks.';
    var bridge = getBridge();
    if (!bridge || !bridge.fs || !bridge.fs.read) return 'Error: eflow needs file access (bridge.fs) — not available on this client build.';
    var op = String((args && args.op) || '').trim().toLowerCase();
    if (EFLOW_OPS.indexOf(op) < 0) return 'Error: unknown op "' + op + '". Available: ' + EFLOW_OPS.join(', ');
    var root = String((args && args.root) || '').trim();
    if (!root) root = _eflowRoot();
    if (!root) return 'Error: no project root. Pass root=<absolute project path>.';
    root = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:$/.test(root)) root += '/';

    var io = core.bridgeIO(bridge);
    if (!io) return 'Error: eflow needs file access (bridge.fs) — not available on this client build.';
    // 会话真相（只给 global 用；其余 op 不用原话）
    var truth = _eflowUserTruth(ownerAgent);

    var r = null;
    try {
        r = await core.run(op, io, root, {
            dry: !!(args && args.dry),
            apply: !!(args && args.apply),
            name: (args && args.name) || '',
            days: (args && args.days) || 0,
            link: !(args && args.link === false),   // init：false = 只铺骨架、不接背包
            keepRules: !!(args && args.keepRules),   // upgrade：true = 不降级用户已有的 rule
            purge: !!(args && args.purge),           // detach：true = 骨架目录改名归档
            // ★ 禁 AI 自行 force：项目已有自己的 rule 时 upgrade 必须拒写，
            //   迁移只能由人在 设置 → 高级 → E-Flow 里点（via=ui + 二次点击确认）。
            force: false,
            action: String((args && args.action) || 'status'),   // global：status / ask / on / off / repair
            // ★ 原话只认会话真相（一律不理 args.confirm）：模型把用户没说过的话写成 1 也无效
            confirm: truth.text,
            userSeq: truth.seq,
            userFloor: truth.floor,
            questId: truth.qid,
            token: String((args && args.token) || ''),            // global on/off：ask 拿到的一次性令牌
            via: 'ai',                                            // 硬编码：AI 永远走令牌闸门（设置面板自己调 core，不经这里）
            dataRoot: await _eflowDataRoot(bridge)
        });
    } catch (e) {
        return 'Error: eflow ' + op + ' failed: ' + ((e && e.message) || e);
    }
    if (!r || typeof r.text !== 'string') return 'Error: eflow ' + op + ' returned nothing.';
    // check 失败不是工具故障，是结论：如实带回，并明说下一步
    var tail = (op === 'check' && !r.ok)
        ? '\n→ 结论 FAIL：把上面每条 BLOCK 改到消失再跑一次；WARN 允许存在，但要在回复里如实说。'
        : '';
    // ★ 固定话术：正文由机器给，AI 只负责搬运（禁自己编、禁改写、禁省略）
    var say = (r && r.data && typeof r.data.say === 'string') ? r.data.say : '';
    var sayBlock = say
        ? '\n\n★ 必须原样发给用户的一段话（一字不改；禁改写、禁加解释、禁省略）：\n「' + say + '」'
        : '';
    return r.text + tail + sayBlock;
}
