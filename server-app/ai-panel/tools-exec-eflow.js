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

function _eflowIO(bridge) {
    return {
        read: function (p) { return bridge.fs.read(p); },
        write: function (p, t) { return bridge.fs.write(p, t); },
        list: function (p) { return bridge.fs.list(p); },
        exists: function (p) { return bridge.fs.exists(p); },
        mkdir: function (p) { return bridge.fs.mkdir(p); },
        remove: function (p) { return bridge.fs.remove(p); },
        rename: function (p, q) { return bridge.fs.rename(p, q); }
    };
}

async function executeEflow(args) {
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

    var r = null;
    try {
        r = await core.run(op, _eflowIO(bridge), root, {
            dry: !!(args && args.dry),
            apply: !!(args && args.apply),
            name: (args && args.name) || '',
            days: (args && args.days) || 0,
            link: !(args && args.link === false),   // init：false = 只铺骨架、不接背包
            keepRules: !!(args && args.keepRules),   // upgrade：true = 不降级用户已有的 rule
            purge: !!(args && args.purge),           // detach：true = 骨架目录改名归档
            action: String((args && args.action) || 'status'),   // global：status / on / off
            dataRoot: (op === 'global') ? await _eflowDataRoot(bridge) : ''
        });
    } catch (e) {
        return 'Error: eflow ' + op + ' failed: ' + ((e && e.message) || e);
    }
    if (!r || typeof r.text !== 'string') return 'Error: eflow ' + op + ' returned nothing.';
    // check 失败不是工具故障，是结论：如实带回，并明说下一步
    var tail = (op === 'check' && !r.ok)
        ? '\n→ 结论 FAIL：把上面每条 BLOCK 改到消失再跑一次；WARN 允许存在，但要在回复里如实说。'
        : '';
    return r.text + tail;
}
