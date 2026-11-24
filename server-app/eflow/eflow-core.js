// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ════════════════════════════════════════════════════════════════════════════
// eflow-core.js — E-Flow v2 内核（唯一实现 · 零依赖 · 注入式 IO）
//
// 为什么只有一个内核：文档地基的「算术」必须与调用方无关——
//   · AI 面板工具（eflow op=...）      → 渲染层，走 bridge.fs
//   · 新项目首启脚手架（panel-expert）  → 渲染层，走 bridge.fs
//   · 命令行体检（npm run check:eflow） → Node，走 fs/promises
// 三处若各写一套，闸门迟早互相矛盾（那等于没有闸门）。
//
// 设计口径（四条，每条杀一种失败）：
//   ① 单点注入 + 硬预算 —— 每轮固定开销有上限（L0 ≤2500 字 / ≤80 行），超了闸门拦。
//   ② L0 生成区 —— 路由表与铁律由各文档的 WHEN/MUST 头编译而来，禁手写，禁漂移。
//   ③ 经验条目 L3 —— 一次具体的坑进 exp/，带 triggers，命中才 grep，不占背包。
//   ④ 闸门十道 A–J —— 机器判，不靠记性；放宽必须写进 budget.json / layout.json 并打印出来。
//
// 分层：
//   L0 背包  _qqq/alphal/expert/index.md          每轮注入（唯一注入点）
//   L1 骨架  _qqq/alphal/expert/arch/*.md         ≤6000 字/份（topology/iron_law/env_var/facts）
//   L2 细则  layout.json 指向（默认 arch/deep）    按需整读
//   L3 经验  _qqq/alphal/expert/exp/exp-*.md       ≤2000 字/条，软 30 条
//   L4 归档  _qqq/alphal/expert/archive/           不计预算，永不自动注入
// ════════════════════════════════════════════════════════════════════════════

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.EflowCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var VER = '2.0';
    var MARK_B = '<!-- EF2:BEGIN';
    var MARK_E = '<!-- EF2:END';

    // 预算：改这里 = 改全产品的闸门（禁在别处写魔数）
    var BUDGET = {
        l0_chars: 2500, l0_lines: 80,
        l1_chars: 6000,
        l2_chars: 20000,          // 可由 budget.json 放宽（放宽会被打印）
        exp_chars: 2000, exp_chars_block: 4000,
        exp_soft: 30, exp_strong: 60, exp_ceiling: 150,
        exp_review_days: 180, exp_review_days_platform: 90,
        doc_review_days: 365,
        state_floors: 3,
        must_max: 20,
        rule_lines: 1,          // EF2 自己的 L0 只许注册 1 次（用户自己的 rule 不受此限）
        rule_custom_chars: 20000, // 用户自定义注入面软边界（超了只 WARN，不拦人）
        dup_line: 40
    };

    // 允许放宽的键（注入点 rule_lines 永不放宽）
    var OVERRIDE_KEYS = ['l0_chars', 'l0_lines', 'l1_chars', 'l2_chars',
        'exp_chars', 'exp_chars_block', 'exp_soft', 'exp_strong', 'exp_ceiling',
        'exp_review_days', 'exp_review_days_platform', 'doc_review_days',
        'state_floors', 'must_max', 'rule_custom_chars', 'dup_line'];

    var EXP_STATES = ['draft', 'verified', 'promoted', 'stale', 'superseded', 'merged', 'archived'];
    var EXP_REQUIRED = ['id', 'date', 'domain', 'state', 'triggers'];

    // 只报高置信度密钥特征（宁可漏报，不制造噪音）
    var SECRET_PATTERNS = [
        [/'-----BEGIN [A-Z ]*PRIVATE KEY-----'/, '私钥块'],
        [/\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/, '令牌字面量'],
        [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_\-.\/+=]{12,})/i, '疑似口令/密钥赋值']
    ];
    var SECRET_SKIP = ['{{', '<', '***', 'xxx', 'XXX', 'YOUR_', 'your_', '示例', 'example', '占位', '→'];

    var DEF = {
        rule: '_qqq/alphal/rule/project.txt',
        l0: '_qqq/alphal/expert/index.md',
        l1: ['_qqq/alphal/expert/arch'],
        l2: [],
        l3: '_qqq/alphal/expert/exp',
        l4: '_qqq/alphal/expert/archive',
        state: '_qqq/alphal/expert/STATE.md',
        budget: '_qqq/alphal/expert/budget.json',
        layout: '_qqq/alphal/expert/layout.json',
        suffixes: ['.md', '.txt']
    };
    // 每次 run() 前复位：一个进程里可能连着体检多个项目，布局/预算不许串味
    var DEF_BASE = JSON.parse(JSON.stringify(DEF));
    var BUDGET_BASE = JSON.parse(JSON.stringify(BUDGET));
    function resetState() {
        Object.keys(BUDGET).forEach(function (k) { BUDGET[k] = BUDGET_BASE[k]; });
        Object.keys(DEF).forEach(function (k) { delete DEF[k]; });
        Object.keys(DEF_BASE).forEach(function (k) { DEF[k] = JSON.parse(JSON.stringify(DEF_BASE[k])); });
    }

    // ── 小工具 ────────────────────────────────────────────────────────────
    function joinp() {
        var a = [];
        for (var i = 0; i < arguments.length; i++) {
            var s = String(arguments[i] == null ? '' : arguments[i]);
            if (!s) continue;
            a.push(s.replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, ''));
        }
        // 首段可能是盘符（E:/x），保留其形态
        return a.join('/');
    }
    function norm(p) { return String(p || '').replace(/[\\]+/g, '/'); }
    function nchars(s) { return String(s || '').replace(/\s/g, '').length; }
    function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    function today(opts) { return (opts && opts.today) || new Date().toISOString().slice(0, 10); }
    function stamp(d) { return String(d).replace(/[: ]/g, '').replace(/-/g, ''); }
    function lines(s) { return String(s || '').replace(/\r\n/g, '\n').split('\n'); }
    function base(p) { var a = norm(p).split('/'); return a[a.length - 1]; }
    function dirOf(p) { var a = norm(p).split('/'); a.pop(); return a.join('/'); }
    // 路径同一性归口：折叠 ./ 与重复斜杠；Windows / macOS 大小写不敏感，POSIX 保留
    function canon(p) {
        var s = norm(p).replace(/\/\.\//g, '/').replace(/\/{2,}/g, '/');
        return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
    }
    // 「是不是同一份文件」——先比 canon；只差大小写也算同一（Windows / macOS 文件系统大小写不敏感，
    // 用户手写与机器写出的盘符/目录名大小写经常不一致，按字节比会把自家 L0 判成“别人的”）。
    // POSIX 上若真是两份不同文件，其中一侧的 exists 检查会把它抓成缺失/死链，不会误放行。
    function samePath(a, b) {
        if (!a || !b) return false;
        if (canon(a) === canon(b)) return true;
        return String(a).toLowerCase() === String(b).toLowerCase();
    }
    function days(a, b) {
        var t1 = Date.parse(a + 'T00:00:00Z'), t2 = Date.parse(b + 'T00:00:00Z');
        if (isNaN(t1) || isNaN(t2)) return null;
        return Math.round((t2 - t1) / 86400000);
    }
    function uniq(a) { var o = {}, out = []; a.forEach(function (x) { if (!o[x]) { o[x] = 1; out.push(x); } }); return out; }

    // ── IO 包装：任何一步取不到都不许抛（闸门必须永远给出结论）───────────
    async function safeRead(io, p) {
        try { var t = await io.read(p); return typeof t === 'string' ? t : ''; } catch (_) { return null; }
    }
    async function safeList(io, p) {
        try { var a = await io.list(p); return Array.isArray(a) ? a : []; } catch (_) { return null; }
    }
    // 量一份注入源的体积（文件 = 字数；目录 = 一级 .md/.txt 合计，上限 200 份）
    async function targetChars(io, p) {
        try {
            if (await io.exists(p)) {
                var t = await safeRead(io, p);
                if (t != null) return nchars(t);
            }
        } catch (_) { }
        var names = await safeList(io, p);
        if (names == null) return null;
        var sum = 0, n = 0;
        for (var i = 0; i < names.length && n < 200; i++) {
            var nm = typeof names[i] === 'string' ? names[i] : (names[i] && (names[i].name || names[i].rel)) || '';
            if (!nm || !/\.(md|txt)$/i.test(nm)) continue;
            var one = await safeRead(io, joinp(p, nm));
            if (one != null) { sum += nchars(one); n++; }
        }
        return n ? sum : null;
    }
    async function docList(io, root, rel, suffixes) {
        // rel 可以是目录（取其下文件）或单个文件
        var p = joinp(root, rel);
        var out = [];
        var ext = suffixes || DEF.suffixes;
        var lst = await safeList(io, p);
        if (lst) {
            lst.forEach(function (e) {
                if (e.isDir) return;
                var n = e.name || '';
                var ok = ext.some(function (x) { return n.toLowerCase().slice(-x.length) === x; });
                if (ok) out.push({ rel: rel + '/' + n, name: n, size: e.size || 0 });
            });
        } else {
            // 当作单文件
            var t = await safeRead(io, p);
            if (t != null && t !== '') out.push({ rel: norm(rel), name: base(rel), size: t.length });
        }
        return out;
    }

    // ── 布局与预算（放宽必须可见）────────────────────────────────────────
    async function loadLayout(io, root) {
        var applied = [], reason = '';
        var raw = await safeRead(io, joinp(root, DEF.layout));
        if (raw) {
            try {
                var d = JSON.parse(raw);
                reason = String(d._reason || '').slice(0, 80);
                if (Array.isArray(d.l1) && d.l1.length) { DEF.l1 = d.l1.map(norm); applied.push('l1=' + DEF.l1.join(',')); }
                if (Array.isArray(d.l2)) { DEF.l2 = d.l2.map(norm); if (DEF.l2.length) applied.push('l2=' + DEF.l2.join(',')); }
                if (d.l3) { DEF.l3 = norm(d.l3); applied.push('l3=' + DEF.l3); }
                if (d.state) { DEF.state = norm(d.state); applied.push('state=' + DEF.state); }
                if (Array.isArray(d.suffixes) && d.suffixes.length) { DEF.suffixes = d.suffixes; applied.push('suffixes=' + d.suffixes.join('')); }
            } catch (e) {
                applied.push('layout.json 解析失败：' + (e && e.message));
            }
        }
        return { applied: applied, reason: reason };
    }

    async function loadBudget(io, root) {
        var applied = [], reason = '';
        var raw = await safeRead(io, joinp(root, DEF.budget));
        if (!raw) return { applied: applied, reason: reason };
        try {
            var d = JSON.parse(raw);
            reason = String(d._reason || '').slice(0, 80);
            Object.keys(d).forEach(function (k) {
                if (k.charAt(0) === '_' || OVERRIDE_KEYS.indexOf(k) < 0) return;
                var v = parseInt(d[k], 10);
                if (!isFinite(v)) return;
                if (v > BUDGET[k]) { BUDGET[k] = v; applied.push(k + '→' + v); }
            });
        } catch (e) {
            applied.push('budget.json 解析失败：' + (e && e.message));
        }
        return { applied: applied, reason: reason };
    }

    // ── 文档头解析：WHEN / MUST / 验证日 ──────────────────────────────────
    var HEAD_RE = /^\s*(?:#+|\/\/|<!--)\s*(WHEN|MUST|验证日|验证)\s*[:：]\s*(.+?)\s*(?:-->)?\s*$/;

    function parseHead(text) {
        var out = { when: [], must: [], verify: '' };
        var ls = lines(text).slice(0, 40);
        for (var i = 0; i < ls.length; i++) {
            var m = HEAD_RE.exec(ls[i]);
            if (!m) continue;
            var k = m[1], v = String(m[2]).trim();
            if (k === 'WHEN') out.when.push(v);
            else if (k === 'MUST') out.must.push(v);
            else if (!out.verify && /^\d{4}-\d{2}-\d{2}$/.test(v)) out.verify = v;
        }
        return out;
    }

    function parseFront(text) {
        var o = {};
        var ls = lines(text);
        if (String(ls[0] || '').trim() !== '---') return o;
        for (var i = 1; i < ls.length; i++) {
            if (String(ls[i]).trim() === '---') break;
            var m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(ls[i]);
            if (m) o[m[1]] = String(m[2]).trim();
        }
        return o;
    }

    // ── 生成区编译（L0 的唯一天然来源）───────────────────────────────────
    async function gather(io, root) {
        var g = { l1: [], l2: [], routes: [], musts: [], docs: [] };
        var i, f, files;
        for (i = 0; i < DEF.l1.length; i++) {
                files = await docList(io, root, DEF.l1[i]);
            // 铁律骨架永远排第一（它是投影的主源，排后面会被当附录读）
            files.sort(function (a, b) {
                var pa = a.name === 'iron_law.md' ? 0 : 1, pb = b.name === 'iron_law.md' ? 0 : 1;
                return pa - pb || a.name.localeCompare(b.name, 'zh');
            });         files.forEach(function (x) { x.layer = 'L1'; });
            g.l1 = g.l1.concat(files);
        }
        for (i = 0; i < DEF.l2.length; i++) {
                files = await docList(io, root, DEF.l2[i]);
            files.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });         files.forEach(function (x) { x.layer = 'L2'; });
            g.l2 = g.l2.concat(files);
        }
        g.docs = g.l1.concat(g.l2);
        for (i = 0; i < g.docs.length; i++) {
            f = g.docs[i];
            f.text = (await safeRead(io, joinp(root, f.rel))) || '';
            f.size = nchars(f.text);
            var h = parseHead(f.text);
            f.when = h.when; f.must = h.must; f.verify = h.verify;
            f.when.forEach(function (w) { g.routes.push({ when: w, rel: f.rel, layer: f.layer }); });
        }
        g.musts = uniq(g.docs.reduce(function (a, x) { return a.concat(x.must); }, []));
        return g;
    }

    function buildBlock(g) {
        var out = [];
        var expPrefix = norm(DEF.l0).replace(/\/?index\.md$/, '/');
        function short(rel) {
            var r = norm(rel);
            return r.indexOf(expPrefix) === 0 ? r.slice(expPrefix.length) : r;
        }
        out.push(MARK_B + ' 生成区：`eflow index` 重建，禁手改 -->');
        out.push('## 二、路由表（命中才读，禁通读）');
        out.push('');
        out.push('| 要改什么 | 先读 |');
        out.push('|---|---|');
        if (!g.routes.length) out.push('| （没有任何文档登记 WHEN 头） | — |');
        g.routes.forEach(function (r) { out.push('| ' + String(r.when).replace(/\|/g, '/') + ' | `' + short(r.rel) + '` |'); });
        out.push('');
        out.push('## 三、铁律投影（各文档 `#MUST` · 当前 ' + g.musts.length + ' 条 / 上限 ' + BUDGET.must_max + ' 条）');
        out.push('');
        if (!g.musts.length) out.push('1. （没有任何文档登记 MUST 头）');
        g.musts.forEach(function (m, i) { out.push((i + 1) + '. ' + m); });
        out.push(MARK_E + ' -->');
        return out.join('\n');
    }

    function sliceBlock(l0) {
        var s = String(l0 || '');
        var a = s.indexOf(MARK_B), b = s.indexOf(MARK_E);
        if (a < 0 || b < 0 || b < a) return null;
        var end = s.indexOf('-->', b);
        return s.slice(a, end < 0 ? s.length : end + 3);
    }

    // ── op: index ─────────────────────────────────────────────────────────
    async function opIndex(io, root, opts) {
        opts = opts || {};
        await loadLayout(io, root);   // 布局决定去哪儿找文档：index 与 check 必须同源，否则路由表漂
        await loadBudget(io, root);
        var g = await gather(io, root);
        var block = buildBlock(g);
        var l0p = joinp(root, DEF.l0);
        var l0 = await safeRead(io, l0p);
        if (l0 == null) return { ok: false, text: '✗ L0 不存在：' + DEF.l0 + '（先跑 init 或 upgrade）' };
        var old = sliceBlock(l0);
        var next;
        var PH = /（生成区由 eflow index 填这里[^）]*）/;
        if (old == null && PH.test(l0)) next = l0.replace(PH, block);
        else if (old == null) next = l0.replace(/\s*$/, '') + '\n\n' + block + '\n';
        else next = l0.slice(0, l0.indexOf(old)) + block + l0.slice(l0.indexOf(old) + old.length);
        var changed = next !== l0;
        if (opts.dry) {
            return { ok: true, text: (changed ? '（dry）将重写生成区' : '（dry）生成区已同步') + '：' + g.routes.length + ' 条路由 / ' + g.musts.length + ' 条铁律' };
        }
        if (changed) {
            if (!io.write) return { ok: false, text: '✗ IO 不支持写' };
            await io.write(l0p, next);
        }
        var note = old == null ? '（原先没有生成区，已补进 L0——若落点不合适，手工挪一次再跑 index）'
            : (changed ? '（按文档头重写：生成区里若有手改，已被覆盖）' : '');
        return {
            ok: true,
            text: (changed ? '✓ 生成区已重建' : '✓ 生成区本来就同步') + '：' + g.routes.length + ' 条路由 / ' + g.musts.length + ' 条铁律' + note,
            data: { routes: g.routes.length, musts: g.musts.length }
        };
    }

    // ── op: status ────────────────────────────────────────────────────────
    async function opStatus(io, root, opts) {
        opts = opts || {};
        var lay = await loadLayout(io, root);
        var bud = await loadBudget(io, root);
        var ruleTxt = (await safeRead(io, joinp(root, DEF.rule))) || '';
        var l0 = (await safeRead(io, joinp(root, DEF.l0))) || '';
        var g = await gather(io, root);
        var ruleLines = 0, extraChars = 0;
        lines(ruleTxt).forEach(function (l) {
            var s = l.trim();
            if (!s) return;
            if (/rule\s*"/.test(s)) ruleLines++;
            else extraChars += nchars(s);
        });
        // 自定义 rule 也是每轮付的钱：不信这一条，汇报就会差一个数量级
        var ownChars = 0;
        var rls = lines(ruleTxt);
        for (var si = 0; si < rls.length; si++) {
            var sm = /rule\s*"([^"]+)"/.exec(rls[si]);
            if (!sm) continue;
            var st2 = sm[1].trim();
            var sf = /^[A-Za-z]:[\\/]/.test(st2) ? norm(st2) : joinp(root, st2);
            if (samePath(sf, joinp(root, DEF.l0))) continue;
            var sc = await targetChars(io, sf);
            if (sc) ownChars += sc;
        }
        var inject = nchars(l0) + extraChars + ownChars;
        var out = [];
        out.push('E-Flow v' + VER + ' · ' + norm(root));
        out.push('  注入点     ' + ruleLines + ' 行 rule ＋ 其它 ' + extraChars + ' 字');
        out.push('  L0         ' + fmt(nchars(l0)) + ' 字 / ' + lines(l0).length + ' 行（上限 ' + fmt(BUDGET.l0_chars) + ' / ' + BUDGET.l0_lines + '）');
        out.push('  L1 骨架    ' + g.l1.length + ' 份：' + (g.l1.map(function (x) { return x.name + ' ' + fmt(x.size) + '字'; }).join('、') || '—'));
        out.push('  L2 细则    ' + g.l2.length + ' 份' + (g.l2.length ? '（最大 ' + g.l2.slice().sort(function (a, b) { return b.size - a.size; })[0].name + '）' : ''));
        var exp = await docList(io, root, DEF.l3);
        out.push('  L3 经验    ' + exp.length + ' 条（软边界 ' + BUDGET.exp_soft + '）');
        var st = (await safeRead(io, joinp(root, DEF.state))) || '';
        var floors = (st.match(/^## \[/gm) || []).length;
        out.push('  STATE      ' + floors + ' 楼（保留 ' + BUDGET.state_floors + '）');
        out.push('  —');
        if (ruleLines === 0 && !(await io.exists(joinp(root, DEF.l0)))) {
            out.push('  状态       白纸（未接 E-Flow）：不注入、不建文件；要接就跑 upgrade');
        }
        out.push('  每轮固定注入 ' + fmt(inject) + ' 字（L0 ' + fmt(nchars(l0)) + ' + 自定义 rule ' + fmt(ownChars) +
            ' + 其它 ' + fmt(extraChars) + '）' +
            (nchars(l0) > BUDGET.l0_chars ? '｜L0 超预算 ' + fmt(nchars(l0) - BUDGET.l0_chars) + ' 字' : '｜L0 在预算内'));
        if (lay.applied.length) out.push('  布局放宽   ' + lay.applied.join('、') + (lay.reason ? '（' + lay.reason + '）' : ''));
        if (bud.applied.length) out.push('  预算放宽   ' + bud.applied.join('、') + (bud.reason ? '（' + bud.reason + '）' : ''));
        return { ok: true, text: out.join('\n'), data: { inject: inject, l0: nchars(l0), ruleLines: ruleLines } };
    }

    // ── op: check（十道闸）────────────────────────────────────────────────
    async function opCheck(io, root, opts) {
        opts = opts || {};
        var now = today(opts);
        var issues = [], info = [];
        var lay = await loadLayout(io, root);
        var bud = await loadBudget(io, root);
        var ruleTxt = (await safeRead(io, joinp(root, DEF.rule))) || '';

        // A 注入面 —— ★ 只校验 EF2 自己那一行。用户自己的 rule"..." 一律允许（白纸原则：
        //     用不用 EF2 由用户决定；用户的知识库怎么管，闸门不替他做决定，只把成本量出来）。
        var ruleStr = [], otherStr = [];
        lines(ruleTxt).forEach(function (l) {
            var s = l.trim();
            if (!s) return;
            if (/rule\s*"/.test(s)) ruleStr.push(s); else otherStr.push(s);
        });
        var l0abs = joinp(root, DEF.l0);
        var ef2Count = 0, ownRules = [], customChars = 0, customMissing = 0;
        for (var ri = 0; ri < ruleStr.length; ri++) {
            var mm = /rule\s*"([^"]+)"/.exec(ruleStr[ri]);
            if (!mm) continue;
            var tgt = mm[1].trim();
            if (tgt.indexOf('{') >= 0) { issues.push(['BLOCK', 'rule 路径还是占位符：' + tgt]); continue; }
            var full = /^[A-Za-z]:[\\/]/.test(tgt) ? norm(tgt) : joinp(root, tgt);
            if (samePath(full, l0abs)) { ef2Count++; continue; }
            // 形如别的项目的 EF2 L0 → 一定是路径搬过 / 手写错，必须拦（否则背包注入空气）
            if (/\/alphal\/expert\/index\.md$/i.test(norm(full))) {
                issues.push(['BLOCK', 'rule 指向的不是本项目的 EF2 L0：' + tgt + '（这类路径只可能是搬目录后的残留）→ 改成 ' + DEF.l0]);
                continue;
            }
            ownRules.push(tgt);
            var sz = await targetChars(io, full);
            if (sz == null) customMissing++; else customChars += sz;
        }
        info.push('A  注入面    EF2 ' + ef2Count + ' 行 rule ｜ 自定义 ' + ownRules.length + ' 行（≈' + fmt(customChars) + ' 字）｜ 其它文本 ' + otherStr.length + ' 行');
        if (ef2Count > BUDGET.rule_lines) issues.push(['BLOCK', 'EF2 的 L0 被注册了 ' + ef2Count + ' 次（只允许 ' + BUDGET.rule_lines + ' 次：同一份背包注入两遍 = 白付一份钱）']);
        if (!String(ruleTxt || '').trim()) {
            issues.push(['WARN', '无 ' + DEF.rule + '：本项目是白纸（不接背包、不注入任何东西）—— 要用 E-Flow 就跑 eflow upgrade，不想用就别管']);
        } else if (!ef2Count) {
            var esL0 = await io.exists(l0abs);
            issues.push(['WARN', (esL0
                ? 'EF2 骨架在，但 project.txt 没登记 L0：背包没接上（当前不注入）→ 要接就跑 eflow upgrade'
                : '本项目走自定义知识库：EF2 未接管（允许）') +
                (ownRules.length ? '；当前 ' + ownRules.length + ' 行自定义 rule ≈ ' + fmt(customChars) + ' 字/轮' : '')]);
        }
        if (customMissing) issues.push(['WARN', customMissing + ' 行自定义 rule 指向的路径不存在（这几条注入的是空气）']);
        if (customChars > BUDGET.rule_custom_chars) {
            issues.push(['WARN', '自定义注入面 ≈ ' + fmt(customChars) + ' 字/轮 > ' + fmt(BUDGET.rule_custom_chars) + '：EF2 只量成本，不替你改；要降就在 budget.json 里写 _reason 放宽，或自己拆分']);
        }
        if (otherStr.length) {
            issues.push(['WARN', 'project.txt 还有 ' + otherStr.length + ' 行非 rule 文本（整份会被原文注入，共 ' +
                fmt(otherStr.reduce(function (a, s) { return a + nchars(s); }, 0)) + ' 字）：' + otherStr[0].slice(0, 40)]);
        }

        // ★ 白纸短路：没接 EF2、也没骨架 → 根本不在管范围。给结论就完，不拿别的闸门去误伤
        var l0p = joinp(root, DEF.l0);
        if (!ef2Count && !(await io.exists(l0p))) {
            var b0 = issues.filter(function (x) { return x[0] === 'BLOCK'; });
            var w0 = issues.filter(function (x) { return x[0] === 'WARN'; });
            var o0 = ['== E-Flow v' + VER + ' 体检 · ' + norm(root) + ' =='];
            o0.push('  A  注入面    EF2 0 行 rule ｜ 自定义 ' + ownRules.length + ' 行（≈' + fmt(customChars) + ' 字）｜ 未接管');
            o0.push('  —  本项目是白纸：不建文件、不改 project.txt、不注入 L0（每轮 EF2 成本 0 字）');
            if (ownRules.length) o0.push('     自定义注入面 ≈ ' + fmt(customChars) + ' 字/轮（这部分就是你自己的知识库，EF2 不插手）');
            o0.push('     要用 E-Flow → eflow upgrade（先跑 dry 看计划）');
            o0.push('-- 问题 --');
            if (!issues.length) o0.push('  （无）');
            b0.forEach(function (x) { o0.push('  [BLOCK] ' + x[1]); });
            w0.forEach(function (x) { o0.push('  [WARN ] ' + x[1]); });
            o0.push('== 结论：' + (b0.length ? 'FAIL' : 'PASS') + ' ｜ BLOCK ' + b0.length + ' · WARN ' + w0.length + ' ｜ 每轮注入 ' + fmt(customChars) + ' 字（EF2 0）==');
            return { ok: b0.length === 0, text: o0.join('\n'), data: { blocks: b0.length, warns: w0.length, inject: customChars, blank: true } };
        }

        // B 体积
        var l0 = await safeRead(io, l0p);
        if (l0 == null) issues.push(['BLOCK', 'L0 缺失：' + DEF.l0]);
        else {
            var c0 = nchars(l0), n0 = lines(l0).length;
            info.push('B  L0 ' + String(c0).padStart(6) + ' 字 / ' + String(n0).padStart(2) + ' 行 (≤' + BUDGET.l0_chars + '/' + BUDGET.l0_lines + ')');
            if (c0 > BUDGET.l0_chars) issues.push(['BLOCK', 'L0 超字数 ' + fmt(c0) + ' > ' + fmt(BUDGET.l0_chars) + '（每轮都在付费）']);
            if (n0 > BUDGET.l0_lines) issues.push(['BLOCK', 'L0 超行数 ' + n0 + ' > ' + BUDGET.l0_lines]);
        }
        var g = await gather(io, root);
        g.l1.forEach(function (f) {
            info.push('B  L1 ' + f.name + ' ' + fmt(f.size) + ' 字 (≤' + BUDGET.l1_chars + ')');
            if (f.size > BUDGET.l1_chars) issues.push(['BLOCK', 'L1 超字数 ' + f.rel + '：' + fmt(f.size) + ' > ' + fmt(BUDGET.l1_chars)]);
        });
        var big = g.l2.slice().sort(function (a, b) { return b.size - a.size; })[0];
        info.push('B  L2 ' + g.l2.length + ' 份' + (big ? '（最大 ' + big.name + ' ' + fmt(big.size) + ' 字 ≈ ' + fmt(Math.round(big.size / 2.5)) + ' tokens，按需整读）' : ''));
        g.l2.forEach(function (f) {
            if (f.size > BUDGET.l2_chars) {
                issues.push(['WARN', 'L2 偏大 ' + f.rel + '：' + fmt(f.size) + ' > ' + fmt(BUDGET.l2_chars) +
                    '（读一次 ≈ ' + fmt(Math.round(f.size / 2.5)) + ' tokens；按域拆分或写 budget.json 说明）']);
            }
        });

        // 布局缺档：layout.json 指向的层不存在 = 那一层恒为空（没报错、也没内容是典型静默失败）
        var missLay = [];
        for (var mi = 0; mi < DEF.l1.length; mi++) if (!(await io.exists(joinp(root, DEF.l1[mi])))) missLay.push('l1=' + DEF.l1[mi]);
        for (var ni = 0; ni < DEF.l2.length; ni++) if (!(await io.exists(joinp(root, DEF.l2[ni])))) missLay.push('l2=' + DEF.l2[ni]);
        info.push('B  铁律投影 ' + g.musts.length + ' 条 (≤' + BUDGET.must_max + ')');
        if (missLay.length) issues.push(['WARN', '布局指向的路径不存在（这一层恒为空，等于没接上）：' + missLay.join('、')]);
        if (g.musts.length > BUDGET.must_max) {
            issues.push(['WARN', '铁律投影 ' + g.musts.length + ' 条 > 上限 ' + BUDGET.must_max +
                '：铁律一多就不再是铁律（合并同义条，或降级进 L1 文档正文）']);
        }

        // C 死链 + 死路由
        var linkTargets = [];
        if (l0) linkTargets.push({ rel: DEF.l0, text: l0 });
        g.l1.forEach(function (f) { linkTargets.push({ rel: f.rel, text: f.text }); });
        var dead = 0;
        for (var li = 0; li < linkTargets.length; li++) {
            var relBase = dirOf(linkTargets[li].rel), txt = String(linkTargets[li].text || '').replace(/```[\s\S]*?```/g, '');
            var re = /\[[^\]]*\]\(([^)\s]+)\)/g, m2;
            while ((m2 = re.exec(txt))) {
                var t = m2[1].split('#')[0].split('?')[0].trim();
                if (!t || /^(https?:|mailto:|tel:|#)/.test(t) || t.indexOf('{{') >= 0) continue;
                var fp = /^[A-Za-z]:[\\/]/.test(t) ? norm(t) : (t.charAt(0) === '/' ? joinp(root, t) : joinp(root, relBase, t));
                if (!(await io.exists(fp))) { dead++; issues.push(['BLOCK', '死链：' + base(linkTargets[li].rel) + ' → ' + t]); }
            }
            // 反引号路径：只查 L0 的生成区（那里每行就是一条真路由，写错必炸）；
            // 正文里的文件名是行文缩写，不当路由查（v1.3 只查 md 链接，此处不扩大到行文）。
            var btSrc = (linkTargets[li].rel === DEF.l0) ? (sliceBlock(txt) || '') : '';
            var re2 = /`([A-Za-z0-9_\-.\/\\\u4e00-\u9fa5]+\.(?:md|txt|json|js|ts|py|go|c|rs))`/g, m3;
            while ((m3 = re2.exec(btSrc))) {
                var tp = norm(m3[1]);
                if (tp.indexOf('*') >= 0) continue;
                var fp2 = /^[A-Za-z]:[\\/]/.test(tp) ? tp : joinp(root, tp);
                var okk = (await io.exists(fp2)) || (await io.exists(joinp(root, relBase, tp))) || (await io.exists(joinp(root, DEF.l0.replace(/index\.md$/, '') + tp)));
                if (!okk) { dead++; issues.push(['BLOCK', '死路由：' + base(linkTargets[li].rel) + ' → ' + tp]); }
            }
        }
        // C 反向：孤儿文档 —— 有文件、没有 WHEN 头 = 路由表里不会出现它，永远读不到
        var orphan = g.docs.filter(function (f) { return !f.when.length; });
        info.push('C  死链/死路由 ' + dead + ' 处 ｜ 孤儿文档 ' + orphan.length + ' 份（无 `# WHEN` 头 = 无路由）');
        if (orphan.length) {
            issues.push(['WARN', '孤儿文档永远读不到（给它加一行 `# WHEN：要改 X 时读我`）：' +
                orphan.slice(0, 6).map(function (f) { return f.name; }).join('、') +
                (orphan.length > 6 ? ' 等 ' + orphan.length + ' 份' : '')]);
        }

        // D 经验条目 schema / 体积
        var expDir = joinp(root, DEF.l3);
        var expList = await docList(io, root, DEF.l3);
        var alive = [], ids = [], due = [];
        for (var ei = 0; ei < expList.length; ei++) {
            var f = expList[ei];
            if (f.name === 'INDEX.tsv') continue;
            var et = (await safeRead(io, joinp(root, f.rel))) || '';
            var fm = parseFront(et);
            var stt = fm.state || 'draft';
            ids.push(fm.id || f.name.replace(/\.md$/, ''));
            EXP_REQUIRED.forEach(function (k) {
                if (!fm[k]) issues.push(['BLOCK', '经验缺必填键 ' + k + '：（' + f.name + '）—— 缺 triggers 的条目等于不存在']);
            });
            if (EXP_STATES.indexOf(stt) < 0) issues.push(['WARN', '经验 state 非法（' + stt + '）：' + f.name]);
            if (stt === 'archived' || stt === 'merged') continue;
            alive.push(f.name);
            var ec = nchars(et);
            if (ec > BUDGET.exp_chars_block) issues.push(['BLOCK', '经验过长不可读 ' + f.name + '：' + fmt(ec) + ' > ' + fmt(BUDGET.exp_chars_block)]);
            else if (ec > BUDGET.exp_chars) issues.push(['WARN', '经验偏长 ' + f.name + '：' + fmt(ec) + ' > ' + fmt(BUDGET.exp_chars) + '（拆两条或只留关键证据）']);
            var lim = fm.domain === 'platform' ? BUDGET.exp_review_days_platform : BUDGET.exp_review_days;
            if (fm.review_days && parseInt(fm.review_days, 10) > 0) lim = parseInt(fm.review_days, 10);
            var baseD = (fm.review_after || fm.updated || fm.date || '').slice(0, 10);
            var age = baseD ? days(baseD, now) : null;
            if (age != null && (stt === 'verified' || stt === 'promoted') && age > lim) due.push(f.name + '(' + age + '天)');
        }
        info.push('B  L3 活跃经验 ' + alive.length + ' 条（软 ' + BUDGET.exp_soft + ' / 强 ' + BUDGET.exp_strong + ' / 阀 ' + BUDGET.exp_ceiling + '）');
        if (alive.length > BUDGET.exp_soft) issues.push(['WARN', '经验 ' + alive.length + ' 条 > 软边界 ' + BUDGET.exp_soft + '：先跑 eflow rotate --check 做一次合并/晋升']);
        if (alive.length > BUDGET.exp_strong) issues.push(['WARN', '经验 ' + alive.length + ' 条 > 强提醒 ' + BUDGET.exp_strong + '：本轮先轮转再干活']);
        if (alive.length > BUDGET.exp_ceiling) issues.push(['BLOCK', '经验 ' + alive.length + ' 条 > 安全阀 ' + BUDGET.exp_ceiling + '：检索成本已失控，立即轮转']);
        if (due.length) issues.push(['WARN', '待复核经验 ' + due.length + ' 条（超复核期）：' + due.slice(0, 4).join('、')]);

        // E 索引同步
        var tsv = await safeRead(io, joinp(expDir, 'INDEX.tsv'));
        if (tsv) {
            var rows = lines(tsv).slice(1).filter(function (r) { return r.trim(); }).map(function (r) { return r.split('\t')[0].trim(); });
            var miss = ids.filter(function (x) { return rows.indexOf(x) < 0; });
            var extra = rows.filter(function (x) { return ids.indexOf(x) < 0; });
            info.push('E  INDEX.tsv  ' + rows.length + ' 行 / 文件 ' + ids.length + ' 条');
            if (miss.length || extra.length) issues.push(['WARN', 'INDEX.tsv 与文件不同步（缺 ' + miss.length + ' / 多 ' + extra.length + '）：跑 eflow rotate --index']);
        } else if (ids.length) {
            issues.push(['WARN', 'exp 目录缺 INDEX.tsv：跑 eflow rotate --index']);
        }

        // F 腐烂：文档验证日 + STATE 楼层
        var noVerify = [], oldVerify = [];
        g.docs.forEach(function (f) {
            if (!f.verify) { noVerify.push(f.name); return; }
            var a = days(f.verify, now);
            if (a != null && a > BUDGET.doc_review_days) oldVerify.push(f.name + '(' + f.verify + ')');
        });
        info.push('F  文档验证日 缺失 ' + noVerify.length + ' ｜ 超期 ' + oldVerify.length);
        if (noVerify.length) issues.push(['WARN', '文档缺验证日（前 15 行内写 `# 验证日：YYYY-MM-DD`）：' + noVerify.slice(0, 6).join('、')]);
        if (oldVerify.length) issues.push(['WARN', '文档验证日超 ' + BUDGET.doc_review_days + ' 天：' + oldVerify.slice(0, 6).join('、')]);
        var stTxt = (await safeRead(io, joinp(root, DEF.state)));
        if (stTxt == null) issues.push(['WARN', '无 STATE.md：这一轮发生了什么无处落地']);
        else {
            var fl = (stTxt.match(/^## \[/gm) || []).length;
            var heads = (stTxt.match(/^## /gm) || []).length;
            info.push('F  STATE      ' + fl + ' 楼（保留 ' + BUDGET.state_floors + '）');
            if (fl > BUDGET.state_floors) issues.push(['WARN', 'STATE 有 ' + fl + ' 楼 > ' + BUDGET.state_floors + '：跑 eflow rotate --apply']);
            if (heads && !fl) issues.push(['WARN', 'STATE 楼标题不是 `## [YYYY-MM-DD] q<quest>f<floor> · 标题` 格式：楼层数恒为 0，轮转永远搬不走']);
        }

        // G 密钥
        var secretHits = 0, scan = [];
        g.docs.forEach(function (f) { scan.push({ rel: f.rel, text: f.text }); });
        if (l0) scan.push({ rel: DEF.l0, text: l0 });
        for (var xi = 0; xi < expList.length; xi++) {
            if (expList[xi].name === 'INDEX.tsv') continue;
            var et2 = (await safeRead(io, joinp(root, expList[xi].rel))) || '';
            scan.push({ rel: expList[xi].rel, text: et2 });
        }
        for (var si = 0; si < scan.length; si++) {
            var ls2 = lines(scan[si].text);
            for (var yi = 0; yi < ls2.length; yi++) {
                var s2 = ls2[yi].trim();
                if (!s2) continue;
                var skip = SECRET_SKIP.some(function (k) { return s2.indexOf(k) >= 0; });
                if (skip) continue;
                for (var pi = 0; pi < SECRET_PATTERNS.length; pi++) {
                    if (SECRET_PATTERNS[pi][0].test(s2)) {
                        secretHits++;
                        if (secretHits <= 6) issues.push(['WARN', '疑似密钥（' + SECRET_PATTERNS[pi][1] + '）' + base(scan[si].rel) + ':' + (yi + 1) + ' → ' + s2.slice(0, 40)]);
                        break;
                    }
                }
            }
        }
        info.push('G  密钥扫描  命中 ' + secretHits + ' 处（应 0；命中就搬进 _qqq/secrets/ 只留指针）');

        // H 放宽可见
        info.push('H  放宽      ' + (lay.applied.length + bud.applied.length) + ' 项' +
            (lay.applied.length ? '｜布局：' + lay.applied.join('、') : '') +
            (bud.applied.length ? '｜预算：' + bud.applied.join('、') : ''));
        if (lay.applied.length) issues.push(['WARN', 'layout.json 改了布局（' + lay.applied.join('、') + '）' + (lay.reason ? '：' + lay.reason : '—— 补 _reason')]);
        if (bud.applied.length) issues.push(['WARN', 'budget.json 放宽了 ' + bud.applied.length + ' 项预算（' + bud.applied.join('、') + '）' + (bud.reason ? '：' + bud.reason : '—— 补 _reason') + ' —— 轮转时逐项复查']);

        // I 生成区同步
        if (l0) {
            var got = sliceBlock(l0);
            if (got == null) issues.push(['WARN', 'L0 没有生成区标记（' + MARK_B + ' … ' + MARK_E + '）：路由表只能手写，必然漂移 → 跑 eflow index']);
            else {
                var want = buildBlock(g);
                if (norm(got).replace(/\s+$/, '') !== norm(want).replace(/\s+$/, '')) {
                    issues.push(['BLOCK', 'L0 生成区与文档头不同步（有人手改或新文档没登记）→ 跑 eflow index']);
                }
            }
        }

        // 重复长行（一事实一处；生成区是投影，不参与）
        var dupSeen = {}, dups = 0;
        var dupDocs = g.docs.map(function (f) { return { rel: f.rel, text: f.text }; });
        if (l0) dupDocs.push({ rel: DEF.l0, text: String(l0).replace(/\s*$/, '').split(MARK_B)[0] });
        dupDocs.forEach(function (d) {
            lines(d.text).forEach(function (l) {
                var s = l.trim();
                if (s.length < BUDGET.dup_line) return;
                if (s.charAt(0) === '|' || s.charAt(0) === '>' || s.slice(0, 3) === '```') return;
                var key = s.replace(/[\s`*（）()：:、，。]/g, '');
                // 分隔线 / 纯符号行不算“事实”（否则每份文档的 ═══ 横幅互相撞）
                if (key.length < BUDGET.dup_line) return;
                if (!/[A-Za-z\u4e00-\u9fa5]{20}/.test(key)) return;
                dupSeen[key] = dupSeen[key] || [];
                if (dupSeen[key].indexOf(d.rel) < 0) dupSeen[key].push(d.rel);
            });
        });
        Object.keys(dupSeen).forEach(function (k) {
            if (dupSeen[k].length > 1) {
                dups++;
                if (dups <= 5) issues.push(['WARN', '重复长行出现在：' + dupSeen[k].join('、') + '（' + k.slice(0, 20) + '…）']);
            }
        });
        info.push('J  重复长行  ' + dups + ' 处');

        // J 成本 —— ★ 自定义 rule 也是每轮在付费，必须算进同一个数。
        //   （只报 L0 就会把“每轮 3 万字”说成“每轮 2 千字”，那是谎报，不是乐观）
        var extraC = otherStr.reduce(function (a, s) { return a + nchars(s); }, 0);
        var inject = nchars(l0 || '') + extraC + customChars;
        info.push('J  每轮固定注入 ' + fmt(inject) + ' 字（L0 ' + fmt(nchars(l0 || '')) + ' + 自定义 rule ' +
            fmt(customChars) + ' + project.txt 其它 ' + fmt(extraC) + '）');

        var blocks = issues.filter(function (x) { return x[0] === 'BLOCK'; });
        var warns = issues.filter(function (x) { return x[0] === 'WARN'; });
        var out = ['== E-Flow v' + VER + ' 体检 · ' + norm(root) + ' =='];
        info.forEach(function (s) { out.push('  ' + s); });
        out.push('-- 问题 --');
        if (!issues.length) out.push('  （无）');
        blocks.forEach(function (x) { out.push('  [BLOCK] ' + x[1]); });
        warns.forEach(function (x) { out.push('  [WARN ] ' + x[1]); });
        out.push('== 结论：' + (blocks.length ? 'FAIL' : 'PASS') + ' ｜ BLOCK ' + blocks.length + ' · WARN ' + warns.length +
            ' ｜ 每轮注入 ' + fmt(inject) + ' 字 ==');
        return { ok: blocks.length === 0, text: out.join('\n'), data: { blocks: blocks.length, warns: warns.length, inject: inject } };
    }

    // ── 模板（唯一源：新项目骨架就是这一份）───────────────────────────────
    function tplL0(name) {
        return [
            '# ' + name + ' · 背包（每轮注入 · 预算 ' + BUDGET.l0_chars + ' 字）',
            '',
            '**定位**：（一句话：这是什么项目，产出什么）',
            '**地基**：E-Flow v2 —— 机制与分层见 `arch/topology.md`；体检 = `eflow check`',
            '',
            '## 一、三条主动作',
            '',
            '| 我要干的事 | 入口 |',
            '|---|---|',
            '| （待填：本项目最常干的一件事） | （待填：命令 / 文件） |',
            '| 改任何子系统 | 先按下面路由表读对应文档，禁猜 |',
            '| 收尾 | 三件套：变更记一笔 ｜ 该回写的文档回写 ｜ `eflow check` PASS |',
            '',
            '（生成区由 eflow index 填这里：它把各文档头的 `# WHEN` 编成路由表、`# MUST` 编成铁律投影）',
            '',
            '## 四、写入门槛（一条信息该进哪层）',
            '',
            '| 这条信息 | 进哪 |',
            '|---|---|',
            '| 每轮都要知道的路由 / 铁律 | 本页（L0） |',
            '| 架构、边界、密钥位置 | `arch/*.md`（L1，≤' + BUDGET.l1_chars + ' 字/份） |',
            '| 子系统细则 | L2（layout.json 指向，按需整读） |',
            '| 一次具体的坑（现象→根因→定式→证据） | `exp/exp-*.md`（L3，≤' + BUDGET.exp_chars + ' 字） |',
            '| 这一轮发生了什么 | `STATE.md`（留最近 ' + BUDGET.state_floors + ' 楼） |',
            '| 聊天里说说的过程 | 哪都不写 |',
            '',
            '## 五、待办',
            '',
            '（待填）',
            ''
        ].join('\n');
    }

    var ARCH_KINDS = {
        topology: {
            when: '目录分层 / 单点文件 / 数据与配置放哪',
            body: [
                '## 目录分层',
                '',
                '| 路径 | 是什么 | 谁是唯一写者 |',
                '|---|---|---|',
                '| （待填） | | |',
                '',
                '## 单点文件（同一件事只有一个写入口）',
                '',
                '- （待填：哪件事必须走哪个函数 / 哪个脚本）'
            ]
        },
        iron_law: {
            when: '拿不准某条硬规则 / 要新加铁律',
            body: [
                '## 跨域铁律（违反 = 返工）',
                '',
                '<!-- 每条一行动宾；加一条就在这加，跑 eflow index 后自动出现在 L0 的铁律投影里 -->',
                '- （待填）'
            ]
        },
        env_var: {
            when: '要密钥 / 环境变量 / 服务器 / 部署',
            body: [
                '## 密钥在哪（只写指针，禁写值）',
                '',
                '- （待填：密钥真值存放路径）',
                '',
                '## 环境与部署',
                '',
                '- （待填：构建 / 运行 / 部署命令；什么动作必须由人执行）'
            ]
        },
        facts: {
            when: '要项目身份 / 不可变事实 / 决策出处',
            body: [
                '## 不可变事实',
                '',
                '- （待填：仓库 / 团队 / 兼容基线 / 对外承诺）'
            ]
        }
    };

    function tplArch(kind, name, dateStr) {
        var k = ARCH_KINDS[kind];
        return [
            '# ' + name + ' · ' + kind,
            '# WHEN：' + k.when,
            '# 验证日：' + dateStr,
            '',
            '> 只写「不知它会改错地方」的东西。细节进 L2，一次具体的坑进 exp/。',
            ''
        ].concat(k.body).join('\n') + '\n';
    }

    function tplState(name, dateStr) {
        return [
            '# 状态板 · ' + name,
            '',
            '> 只留最近 ' + BUDGET.state_floors + ' 楼（更多跑 `eflow rotate --apply`）。标题格式：`## [YYYY-MM-DD] q<quest>f<floor> · 标题`',
            '',
            '## [' + dateStr + '] q0f1 · 地基落地',
            '- E-Flow v2 初始化完成；体检见 `eflow check` 输出。',
            ''
        ].join('\n');
    }

    // ── op: init（幂等，绝不覆盖已有文件）────────────────────────────────
    async function opInit(io, root, opts) {
        opts = opts || {};
        var d = today(opts);
        var name = opts.name || base(norm(root)) || 'project';
        var made = [], kept = [];
        async function ensure(rel, text) {
            var p = joinp(root, rel);
            if (await io.exists(p)) { kept.push(rel); return false; }
            await io.mkdir(dirOf(p));
            await io.write(p, text);
            made.push(rel);
            return true;
        }
        await io.mkdir(joinp(root, DEF.l0.replace(/\/index\.md$/, '')));
        await ensure(DEF.l0, tplL0(name));
        for (var i = 0; i < DEF.l1.length; i++) {
            if (DEF.l1[i].indexOf('_qqq/alphal/expert') !== 0) continue;   // 只给自有骨架铺模板
            var kinds = Object.keys(ARCH_KINDS);
            for (var j = 0; j < kinds.length; j++) {
                await ensure(joinp(DEF.l1[i], kinds[j] + '.md'), tplArch(kinds[j], name, d));
            }
        }
        await io.mkdir(joinp(root, DEF.l3));
        await ensure(joinp(DEF.l3, 'INDEX.tsv'), 'id\tdate\tdomain\tstate\tcost\ttriggers\tsummary\n');
        await ensure(DEF.state, tplState(name, d));
        // project.txt：EF2 只加自己那一行；★ link=false = 只铺骨架、不接背包（白纸/试用）
        var ruleP = joinp(root, DEF.rule);
        var l0abs = joinp(root, DEF.l0);
        var cur = await safeRead(io, ruleP);
        if (opts.link === false) {
            made.push('（未接背包：link=false，project.txt 未动）');
        } else if (cur == null) {
            await io.mkdir(dirOf(ruleP));
            await io.write(ruleP, 'rule"' + l0abs + '"\n');
            made.push(DEF.rule);
        } else if (norm(cur).indexOf(norm(l0abs)) >= 0) {
            kept.push(DEF.rule);
        } else {
            await io.write(ruleP, cur.replace(/\s*$/, '') + '\nrule"' + l0abs + '"\n');
            made.push(DEF.rule + '（追加 rule 行，其它内容原样保留）');
        }
        // 生成区
        var idx = await opIndex(io, root, {});
        var out = ['E-Flow v' + VER + ' · init @ ' + norm(root)];
        out.push('  新建 ' + (made.length ? made.join('、') : '（无，已存在）'));
        out.push('  保留 ' + (kept.length ? kept.join('、') : '（无）'));
        out.push('  ' + idx.text);
        out.push('  下一步：填 L0 三条主动作 + arch 骨架，再跑 eflow check');
        return { ok: true, text: out.join('\n') };
    }

    // ── op: rotate ────────────────────────────────────────────────────────
    async function opRotate(io, root, opts) {
        opts = opts || {};
        var apply = !!opts.apply;
        var daysAge = parseInt(opts.days, 10) > 0 ? parseInt(opts.days, 10) : 30;
        var d = today(opts);
        var expList = await docList(io, root, DEF.l3);
        var rows = ['id\tdate\tdomain\tstate\tcost\ttriggers\tsummary'];
        var archive = [], alive = 0;
        for (var i = 0; i < expList.length; i++) {
            var f = expList[i];
            if (f.name === 'INDEX.tsv') continue;
            var t = (await safeRead(io, joinp(root, f.rel))) || '';
            var fm = parseFront(t);
            var st = fm.state || 'draft';
            var title = (/^## 现象\s*\n+(.+)$/m.exec(t) || [null, ''])[1];
            var age = fm.date ? days(fm.date, d) : 9999;
            var kill = (st === 'superseded' || st === 'merged') ||
                ((st === 'draft' || st === 'stale') && age > daysAge);
            if (kill) { archive.push({ rel: f.rel, name: f.name, st: st, id: fm.id || f.name }); continue; }
            alive++;
            rows.push([fm.id || f.name.replace(/\.md$/, ''), fm.date || '', fm.domain || '-', st,
                fm.cost || '-', (fm.triggers || '').replace(/\t/g, ' '), String(title || '').replace(/\t/g, ' ').slice(0, 48)].join('\t'));
        }
        // INDEX.tsv 重建
        var tsvP = joinp(root, DEF.l3, 'INDEX.tsv');
        if (apply && io.write) { await io.mkdir(DEF.l3); await io.write(tsvP, rows.join('\n') + '\n'); }

        // 归档条目（正文移进 archive/YYYY-MM，digest 留一行）
        var moved = [];
        if (apply) {
            for (var ai = 0; ai < archive.length; ai++) {
                var a = archive[ai];
                var destDir = joinp(root, DEF.l4, d.slice(0, 7));
                await io.mkdir(destDir);
                var dest = joinp(destDir, a.name);
                var body = (await safeRead(io, joinp(root, a.rel))) || '';
                await io.write(dest, body);
                var gone = false;
                if (io.remove) { try { await io.remove(joinp(root, a.rel)); gone = true; } catch (_) { gone = false; } }
                else gone = !(await io.exists(joinp(root, a.rel)));
                moved.push(a.name + (gone ? '' : '（原文件未删：此 IO 不支持删除，手工清）'));
                var dg = joinp(root, DEF.l4, 'digest.md');
                var prev = (await safeRead(io, dg)) || '# 归档摘要（一行一条，取证按 id 找）\n\n';
                await io.write(dg, prev.replace(/\s*$/, '') + '\n- `' + a.id + '` ' + a.st + ' · ' + a.name + '\n');
            }
        }

        // STATE 超 3 楼 → 搬最旧的
        var stp = joinp(root, DEF.state);
        var stTxt = (await safeRead(io, stp)) || '';
        var idxs = [];
        var re = /^## \[/gm, m;
        while ((m = re.exec(stTxt))) idxs.push(m.index);
        var stateMoved = 0;
        if (idxs.length > BUDGET.state_floors) {
            var cut = idxs[BUDGET.state_floors];
            var head = stTxt.slice(0, idxs[0]), tail = stTxt.slice(cut);
            var movedPart = stTxt.slice(idxs[0], cut);
            stateMoved = idxs.length - BUDGET.state_floors;
            if (apply && io.write) {
                await io.write(stp, head + tail);
                var arcP = joinp(root, DEF.l4, 'state-' + d.slice(0, 7) + '.md');
                var prev2 = (await safeRead(io, arcP)) || '';
                await io.write(arcP, prev2 + movedPart);
            }
        }

        var out = ['E-Flow v' + VER + ' · rotate' + (apply ? ' --apply' : ' --check') + ' @ ' + norm(root)];
        out.push('  经验 ' + alive + ' 条活跃 ｜ 归档候选 ' + archive.length + ' 条' + (apply && moved.length ? '（已移走 ' + moved.length + ' 条）' : ''));
        if (archive.length) out.push('  候选：' + archive.slice(0, 6).map(function (x) { return x.name + '(' + x.st + ')'; }).join('、'));
        out.push('  INDEX.tsv ' + (apply ? '已重建 ' + (rows.length - 1) + ' 行' : '未改动（加 --apply 落地）'));
        out.push('  STATE 超楼 ' + stateMoved + ' 楼' + (apply && stateMoved ? '（已搬进 archive）' : ''));
        if (!apply) out.push('  （dry：只报告，不动手）');
        return { ok: true, text: out.join('\n') };
    }

    // ── op: upgrade（从「单片注入」迁到 EF2；只做机械部分）─────────────────
    async function opUpgrade(io, root, opts) {
        opts = opts || {};
        var dry = !!opts.dry;
        var d = today(opts);
        var name = opts.name || base(norm(root)) || 'project';
        var ruleP = joinp(root, DEF.rule);
        var l0p = joinp(root, DEF.l0);
        var ruleTxt = (await safeRead(io, ruleP));
        var l0Txt = (await safeRead(io, l0p));

        // 已经 v2 且预算内 → 只报体检
        if (l0Txt != null && sliceBlock(l0Txt) != null) {
            var chk0 = await opCheck(io, root, opts);
            return { ok: chk0.ok, text: '✓ 已是 E-Flow v' + VER + '（L0 有生成区）\n' + chk0.text };
        }

        // 收集旧状态
        var rules = [], others = [];
        lines(ruleTxt || '').forEach(function (l) {
            var s = l.trim();
            if (!s) return;
            if (/rule\s*"/.test(s)) rules.push(s); else others.push(s);
        });
        // ★ 白纸原则的机器闸门：项目已经在用自己写的 rule"…" 当注入源时，upgrade 会重写
        //   project.txt —— 默认直接拒写（不是提示，是拒绝）。真要迁 = 用户亲口要求后带 force=true。
        if (!opts.force && rules.length) {
            return {
                ok: false,
                text: 'E-Flow v' + VER + ' · 本项目已经有自己的知识库（' + rules.length + ' 行 rule）——upgrade 要重写 ' + DEF.rule +
                    '，所以默认一个字都不动。\n' +
                    '  · 只读盘点：op=status / op=check（不改任何文件）。\n' +
                    '  · 把上面这些数字报给用户；他明确说要迁，再带 force=true 重跑。'
            };
        }
        var legacy = [];
        for (var i = 0; i < rules.length; i++) {
            var mm = /rule\s*"([^"]+)"/.exec(rules[i]);
            if (!mm) continue;
            var tgt = mm[1].trim();
            var full = /^[A-Za-z]:[\\/]/.test(tgt) ? norm(tgt) : joinp(root, tgt);
            var body = await safeRead(io, full);
            if (body == null) continue;
            if (norm(full).toLowerCase() === l0p.toLowerCase()) continue;   // 已是 L0
            legacy.push({ path: tgt, rel: norm(tgt).replace(/[\\]/g, '/'), chars: nchars(body), verify: (parseHead(body) || {}).verify || '' });
        }
        var before = (l0Txt ? nchars(l0Txt) : 0) + others.reduce(function (a, s) { return a + nchars(s); }, 0) +
            legacy.reduce(function (a, x) { return a + x.chars; }, 0);

        var plan = [];
        plan.push('E-Flow v' + VER + ' · upgrade 计划 @ ' + norm(root));
        plan.push('  现状：' + rules.length + ' 行 rule ＋ ' + others.length + ' 行其它文本 ＋ 每轮注入 ' + fmt(before) + ' 字');
        legacy.forEach(function (x) {
            plan.push('  · 旧注入文档 `' + x.rel + '`（' + fmt(x.chars) + ' 字）→ 降为按需查阅（文件一个字节都不动）');
        });
        plan.push('  · 重写 ' + DEF.rule + '：只留 1 行 rule"' + l0p + '"');
        plan.push('  · 建 L0（' + DEF.l0 + '）+ L1 骨架 + exp/ + STATE.md');
        plan.push('  · 生成路由表与铁律投影（来源 = 各文档的 WHEN/MUST 头）');
        plan.push('  · 体检 eflow check');
        if (dry) { plan.push('  （dry：只列计划，不动盘）'); return { ok: true, text: plan.join('\n') }; }

        // 备份（不可逆动作前的硬要求）
        var bk = '.' + 'ef2bak-' + stamp(new Date().toISOString().slice(0, 16).replace('T', '-'));
        if (ruleTxt != null && io.write) await io.write(ruleP + bk, ruleTxt);
        if (l0Txt != null && io.write) await io.write(l0p + bk, l0Txt);
        plan.push('  · 备份：' + DEF.rule + bk + (l0Txt != null ? '、' + DEF.l0 + bk : ''));

        // 先建骨架（保留已有文件），再写 project.txt
        var ini = await opInit(io, root, { name: name, today: d });
        // 旧文档登记进 L0 待办（不猜 WHEN，交给 AI 判断）
        if (legacy.length) {
            var cur = (await safeRead(io, l0p)) || '';
            var todo = legacy.map(function (x) {
                return '- 旧注入文档 `' + x.rel + '`（' + fmt(x.chars) + ' 字）已停止每轮注入：把其中的铁律搬进 `arch/iron_law.md`，' +
                    '按域拆到 L2，然后给每份文档头加 `# WHEN：…` / `# MUST：…`，最后跑 eflow index。拆完再删它。';
            }).join('\n');
            cur = cur.replace('## 五、待办\n\n（待填）', '## 五、待办\n\n' + todo);
            await io.write(l0p, cur);
        }
        // project.txt：EF2 只改自己那一行。★ 用户自己的 rule"..." / 手写备注默认原样保留
        //   （opt 层：keepRules=true 时连“被降为按需”的旧注入文档也不停药，只追加 EF2 行）
        var keepRules = !!opts.keepRules;
        var demoted = [], rebuilt = [];
        for (var qi = 0; qi < rules.length; qi++) {
            var qm = /rule\s*"([^"]+)"/.exec(rules[qi]);
            if (!qm) continue;
            var qt = qm[1].trim();
            var qf = /^[A-Za-z]:[\\/]/.test(qt) ? norm(qt) : joinp(root, qt);
            if (samePath(qf, l0p)) continue;                                            // 原 EF2 行 → 由下面统一追加
            if (/\/alphal\/expert\/index\.md$/i.test(norm(qf))) continue;              // 别的项目的 EF2 残留 → 丢
            var isLegacy = legacy.some(function (x) { return norm(x.path).toLowerCase() === norm(qt).toLowerCase(); });
            if (isLegacy && !keepRules) { demoted.push(qt); continue; }
            rebuilt.push('rule"' + qt + '"');
        }
        // 保持用户原有行序（rule 与非 rule 文本不拆散），EF2 行追加在末尾
        var restLines = lines(ruleTxt || '').map(function (l) { return l.trim(); }).filter(function (l) {
            if (!l) return false;
            if (!/rule\s*"/.test(l)) return true;                       // 手写备注保留
            var m = /rule\s*"([^"]+)"/.exec(l);
            if (!m) return true;
            var t = m[1].trim();
            var f = /^[A-Za-z]:[\\/]/.test(t) ? norm(t) : joinp(root, t);
            if (samePath(f, l0p)) return false;
            if (/\/alphal\/expert\/index\.md$/i.test(norm(f))) return false;
            if (demoted.indexOf(t) >= 0) return false;
            return true;
        });
        restLines.push('rule"' + l0p + '"');
        if (io.write) await io.write(ruleP, restLines.join('\n') + '\n');
        if (demoted.length) plan.push('  · 停注入（文件未动）：' + demoted.join('、'));
        if (rebuilt.length) plan.push('  · 保留 user rule：' + rebuilt.length + ' 行');
        var idx = await opIndex(io, root, {});
        var chk = await opCheck(io, root, opts);

        var after = chk.data && typeof chk.data.inject === 'number' ? chk.data.inject : null;
        var out = plan.concat([
            '  ' + idx.text,
            '  —',
            '  每轮固定注入：' + fmt(before) + ' 字 → ' + (after == null ? '（待测）' : fmt(after) + ' 字') +
            (after == null || !before ? '' : '（省 ' + fmt(before - after) + ' 字 ≈ ' + fmt(Math.round((before - after) / 2.5)) + ' tokens/轮）'),
            '  下一步（判断类，机器不做）：把旧文档的铁律与域细则归位，然后 eflow check 必须 PASS。',
            '',
            chk.text
        ]);
        return { ok: chk.ok, text: out.join('\n') };
    }

    // ── op: detach（拔掉背包，回到白纸；文件不删）───────────────────────
    //   只动 project.txt 里“指向本项目 L0”的那一行：用户自己的 rule / 手写备注一律不动。
    //   purge=true → 把 _qqq/alphal/expert 整目录改名归档（改名，不删）。
    async function opDetach(io, root, opts) {
        opts = opts || {};
        var purged = false, removed = 0;
        var ruleP = joinp(root, DEF.rule);
        var l0p = joinp(root, DEF.l0);
        var cur = await safeRead(io, ruleP);
        var keep = [];
        if (cur != null) {
            var ls = lines(cur);
            for (var i = 0; i < ls.length; i++) {
                var raw = ls[i];
                var s = raw.trim();
                var mm = s ? /rule\s*"([^"]+)"/.exec(s) : null;
                if (mm) {
                    var t = mm[1].trim();
                    var f = /^[A-Za-z]:[\\/]/.test(t) ? norm(t) : joinp(root, t);
                    if (samePath(f, l0p)) { removed++; continue; }
                }
                keep.push(raw);   // 逐行原样保留（含空行），只拆 EF2 那一行
            }
            while (keep.length && !keep[keep.length - 1].trim()) keep.pop();
            if (removed) {
                var bk = '.' + 'ef2bak-' + stamp(new Date().toISOString().slice(0, 16).replace('T', '-'));
                await io.write(ruleP + bk, cur);
                await io.write(ruleP, keep.length ? keep.join('\n') + '\n' : '');
            }
        }
        var dir = joinp(root, DEF.l0.replace(/\/index\.md$/, ''));
        if (opts.purge) {
            var dest = dir + '.detached-' + stamp(new Date().toISOString().slice(0, 16).replace('T', '-'));
            try { if (await io.exists(dir)) { await io.rename(dir, dest); purged = true; } } catch (_) { purged = false; }
        }
        var out = ['E-Flow v' + VER + ' · detach @ ' + norm(root)];
        out.push('  project.txt：移除 EF2 背包行 ' + removed + ' 行' + (removed ? '（已备份 .ef2bak-*）' : '（本来就没接上）'));
        out.push('  用户自己的 rule / 手写备注：一个字节未动');
        out.push('  骨架目录：' + (opts.purge ? (purged ? '已改名归档 → ' + base(dir + '.detached-*') + '（未删）' : '未动（改名失败，请手动处理）') : '保留在 ' + DEF.l0.replace(/\/index\.md$/, '') + '（不注入、不花钱；想彻底清就加 purge=true）'));
        out.push('  → 本项目回到白纸：不接背包、不注入任何东西。想再启用：eflow upgrade');
        return { ok: true, text: out.join('\n') };
    }

    // ── op: global（全局接管开关 + 人点头闸门 + global.txt 契约段）────────
    //   机器真值 = {dataRoot}/alphal/eflow.json  {"global":true,"since":…,"ver":…,"pending":{…}}
    //   人可见契约 = {dataRoot}/global.txt 里一段带 GDOC 标记的规则块（可读、可删、幂等覆盖）
    //   ★ 全局接管只对「白纸项目」生效（没有自己的 rule、也没接 EF2）：
    //     已经有自己知识库的项目一个字都不动，由 AI 把数字报给用户，人拍板。
    //   action = status | ask | on | off | repair
    // ── 全局接管：人点头闸门（AI 无权自己开）─────────────────────────────
    //   为什么是机器判定而不是「让 AI 自己看用户是不是同意了」：
    //     AI 判错一次 = 往用户仓库和全局规则里写东西。词表判定宁可保守（含糊一律不动），
    //     最多多问一句；而 AI 自我判断错一次就没人兜底。
    //   两道闸：① 先 action=ask 拿一次性令牌（30 分钟、一次一用）
    //           ② 用户原话必须被判为「明确肯定」——含糊 / 反问 / 换话题 / 沉默 一律什么都不写。
    var PENDING_TTL_MS = 30 * 60 * 1000;
    // ★ 唯一放行令牌 = 用户回复「1」（暗号）。
    //   为什么不用词表：任何语言的「确定 / 是 / OK」都自带边界情况（反问、转折、转述、方言、
    //   语气词、全角、换行……），要穷举就得一直打补丁，而且每加一种语言就多一套判断；
    //   「1」在全世界只有一个含义 —— 判定 = 一次全串匹配，没有第二种解释，也不需要翻译。
    //   （全角 １ 也认：中文输入法常驻时它和 1 是同一个动作。）
    var CONFIRM_TOKEN = /^[1１]$/;

    // 用户回复判定：'yes'（就是 1）| 'other'（不是 1 → 什么都不做）| 'empty'（空）
    function judgeConfirm(text) {
        var s = String(text == null ? '' : text).trim();
        if (!s) return { v: 'empty', why: '空回答' };
        if (CONFIRM_TOKEN.test(s)) return { v: 'yes', why: '用户回了 1' };
        return { v: 'other', why: '不是 1（暗号之外一律不做）' };
    }

    // ── 全局接管的「人可见契约」：global.txt 里的一段带标记规则块 ────────────
    //   双轨的理由：开关 JSON 是机器记忆（用户看不见也改不动）；global.txt 是每轮都能读到的契约。
    //   两侧不一致时 status 如实报漂移（不自动改用户的文件；用户手动删了块 = 合法意图）。
    // ★ 固定话术（AI 只搬运，禁自编）：正文 + 一行「怎么答」。怎么答永远只有一种：回 1。
    var SAY_TAIL = '回复 1 代表确定，除 1 之外的一切回复我什么也不做。';
    var SAY_ON = '从现在开始，将由 qd 的 E-Flow 接管一切项目的「知识库管理」和「AI 与 AI 之间的相互协作」，会将规则追加写入到全局规则文件 global.txt，确定吗？（将来可在齿轮按钮「高级设置」卡片里管理和取消）\n' + SAY_TAIL;
    var SAY_OFF = '确定要取消 E-Flow 的全局接管吗？取消后会从 global.txt 里删掉那段接管规则，以后新项目不再自动接管（已经接入的项目保持现状，随时可以再打开）。\n' + SAY_TAIL;
    var GDOC_B = '# >>> qqqide eflow begin';
    var GDOC_E = '# <<< qqqide eflow end';

    function globalDocFile(dataRoot) { return joinp(norm(dataRoot), 'global.txt'); }

    function globalDocBlock() {
        return [
            GDOC_B + '（qd 文档地基 · 整块删除 = 不再接管）',
            '## E-Flow 文档地基（qd 接管）',
            '- 每个项目的知识库由 qd 维护：_qqq/alphal/expert/（L0 背包 index.md + arch/ 细则 + exp/ 经验）。',
            '- 白纸项目（没有自己的规则）自动铺骨架并接入；已有自己规则库的项目一个字都不动，只报每轮注入字数。',
            '- 动任何项目前先读它的 _qqq/alphal/expert/index.md（L0 背包），按路由表按需读 arch/，禁通读。',
            '- 收尾跑 eflow op=check：BLOCK 必须清零，WARN 要如实说；文档只收「违反即返工」的规则。',
            '- 反悔：设置 → 高级 → E-Flow 管理 → 取消接管（会删掉本块）。',
            GDOC_E
        ].join('\n') + '\n';
    }

    function cutDocBlock(text) {
        var cur = String(text || '');
        var i = cur.indexOf(GDOC_B);
        if (i < 0) return { has: false, head: cur, tail: '' };
        var e = cur.indexOf(GDOC_E);
        if (e < i) return { has: true, broken: true, head: cur, tail: '' };
        var eol = cur.indexOf('\n', e);
        return {
            has: true, broken: false,
            head: cur.slice(0, i),
            tail: eol >= 0 ? cur.slice(eol + 1) : ''
        };
    }

    // 幂等：开 = 有则原样替换、无则追加到末尾；关 = 只摘掉自己那一块，用户其它内容逐字节保留
    async function syncGlobalDoc(io, dataRoot, on) {
        var p = globalDocFile(dataRoot);
        var cur = (await safeRead(io, p)) || '';
        var c = cutDocBlock(cur);
        var next;
        if (on) {
            if (c.has && !c.broken) next = String(c.head || '') + globalDocBlock() + String(c.tail || '');
            else if (c.has && c.broken) next = cur.replace(/\s*$/, '') + '\n\n' + globalDocBlock();
            else {
                var body = cur.replace(/\s*$/, '');
                next = body ? body + '\n\n' + globalDocBlock() : globalDocBlock();
            }
        } else {
            if (!c.has) return { changed: false, wrote: false, has: false };
            if (c.broken) return { changed: false, wrote: false, has: true, broken: true };
            var head2 = String(c.head || '').replace(/\s*$/, '');
            var tail2 = String(c.tail || '').replace(/^\s*/, '');
            next = head2 && tail2 ? head2 + '\n\n' + tail2 : (head2 || tail2);
            if (next && !/\n$/.test(next)) next += '\n';
        }
        var bk = '';
        try {
            if (cur) {
                bk = p + '.ef2bak-' + stamp(new Date().toISOString().slice(0, 16).replace('T', '-'));
                await io.write(bk, cur);
            }
        } catch (_) { bk = ''; }
        await io.write(p, next);
        var back = (await safeRead(io, p)) || '';
        var okHas = back.indexOf(GDOC_B) >= 0 && back.indexOf(GDOC_E) >= 0;
        return { changed: true, wrote: true, has: okHas, backup: bk, want: !!on };
    }

    // 当前项目属于哪一类（决定「全局接管开完以后要不要动它」）——
    //   ef2    已是 E-Flow v2（L0 有生成区）→ 一个字都不动，只跑 check 报数字
    //   l0     已有一份自己的 index.md（不是 EF2 生成的）→ 一个字都不动
    //   custom project.txt 里是自己写的 rule → 一个字都不动
    //   white  白纸（没自己的 rule、也没 L0）→ 可以接
    async function projectKind(io, root) {
        var l0 = await safeRead(io, joinp(root, DEF.l0));
        if (l0 != null) return (sliceBlock(l0) != null) ? 'ef2' : 'l0';
        var ruleTxt = (await safeRead(io, joinp(root, DEF.rule))) || '';
        return /rule\s*"/.test(ruleTxt) ? 'custom' : 'white';
    }

    function globalFile(dataRoot) {
        return joinp(norm(dataRoot), 'alphal/eflow.json');
    }

    async function opGlobal(io, root, opts) {
        opts = opts || {};
        var action = String(opts.action || 'status').toLowerCase();
        var dr = opts.dataRoot ? norm(opts.dataRoot) : '';
        if (!dr) return { ok: false, text: '✗ 缺 dataRoot（全局开关需要一个用户级目录：win/dev = {appRoot}/Data，mac = bootinfo.userData）', data: { on: false, known: false } };
        var gp = globalFile(dr);
        var dp = globalDocFile(dr);
        var cur = null;
        try { cur = JSON.parse((await safeRead(io, gp)) || 'null'); } catch (_) { cur = null; }
        var on = !!(cur && cur.global);

        var docTxt = (await safeRead(io, dp)) || '';
        var docHas = docTxt.indexOf(GDOC_B) >= 0;

        if (action === 'status' || action === '') {
            var out = [];
            out.push('E-Flow v' + VER + ' · 全局接管：' + (on ? '开' : '关'));
            out.push('  开关文件   ' + gp + (cur ? '' : '（还没建 = 关）'));
            out.push('  规则块     ' + (docHas ? '在 ' + dp : '不在 ' + dp + '（全局规则文件里没有接管规则）'));
            if (on !== docHas) {
                out.push('  ⚠ 漂移     ' + (on
                    ? '开关是开的，但 global.txt 里没有规则块 → action=repair 补回'
                    : '开关是关的，但 global.txt 里还留着规则块 → action=off 清掉'));
            }
            if (cur && cur.pending && cur.pending.nonce) {
                var age = Date.now() - Date.parse(cur.pending.at || 0);
                out.push('  待确认     ' + (age < PENDING_TTL_MS
                    ? '有（' + Math.round(age / 1000) + ' 秒前发出的问话，还剩约 ' + Math.max(1, Math.round((PENDING_TTL_MS - age) / 60000)) + ' 分钟）'
                    : '已过期（' + Math.round(age / 60000) + ' 分钟前）——要重新问'));
            }
            if (on) {
                out.push('  生效方式   打开任何白纸项目 → 自动铺 L0 骨架并接一行 rule（幂等；已有自己规则的项目不动）');
            } else {
                out.push('  生效方式   什么都不做：项目只有在你明确要求时才接入');
            }
            return { ok: true, text: out.join('\n'), data: { on: on, known: !!cur, doc: docHas } };
        }

        // ① 发问：拿一次性令牌 + 固定话术（AI 只负责原样复述，禁自己编）
        if (action === 'ask') {
            var act = (String(opts.act || 'on').toLowerCase() === 'off') ? 'off' : 'on';
            if (act === 'on' && on) {
                return { ok: true, text: 'E-Flow v' + VER + ' · 全局接管本来就是开着的（已回读开关文件）——不用再确认，也不用重复写 global.txt。', data: { on: true, already: true } };
            }
            if (act === 'off' && !on) {
                return { ok: true, text: 'E-Flow v' + VER + ' · 全局接管本来就是关着的——不用再确认。', data: { on: false, already: true } };
            }
            var nonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            var body0 = {};
            Object.keys(cur || {}).forEach(function (k) { body0[k] = cur[k]; });
            body0.global = on;
            body0.pending = { nonce: nonce, act: act, at: new Date().toISOString() };
            body0.ver = VER;
            try {
                if (io.mkdir) { try { await io.mkdir(dr + '/alphal'); } catch (_) { } }
                await io.write(gp, JSON.stringify(body0, null, 2) + '\n');
            } catch (e) {
                return { ok: false, text: '✗ 写确认令牌失败：' + ((e && e.message) || e), data: { on: on, known: !!cur } };
            }
            var say = (act === 'on') ? SAY_ON : SAY_OFF;
            return {
                ok: true,
                text: 'E-Flow v' + VER + ' · 已发出确认请求（此刻什么都没改）\n' +
                    '  · 把下面 say 一字不改地说给用户，说完就停（禁自己补解释、禁自己往下做、禁再追问一遍）\n' +
                    '  · 他回 1 → 调 eflow op=global action=' + act + ' token=' + nonce + ' confirm="1"\n' +
                    '  · 他回别的一切（含「确定」「好」「取消」）→ 什么都不调、也不要再问（令牌 30 分钟内有效，他改口回 1 仍然认）',
                data: { on: on, token: nonce, act: act, say: say, needAnswer: true }
            };
        }

        // ② 对账：开关开着但规则块丢了（用户手删 / 迁移）→ 补回
        if (action === 'repair') {
            if (!on) return { ok: false, text: 'E-Flow v' + VER + ' · 全局接管现在是关着的，没有需要补的规则块。要开就先 action=ask。', data: { on: false } };
            var rp = await syncGlobalDoc(io, dr, true);
            return {
                ok: !!rp.has,
                text: 'E-Flow v' + VER + ' · global.txt 规则块已' + (rp.has ? '补回（回读确认）' : '写失败（回读没找到）') + '：' + dp,
                data: { on: on, doc: !!rp.has }
            };
        }

        if (action !== 'on' && action !== 'off') {
            return { ok: false, text: '✗ 未知动作：' + action + '（status / ask / on / off / repair）', data: { on: on, known: !!cur } };
        }

        var nextOn = (action === 'on');
        // 幂等：状态已经是目标 → 不重复写；只对账规则块
        if (nextOn === on) {
            if (nextOn && !docHas) {
                var fx = await syncGlobalDoc(io, dr, true);
                return {
                    ok: !!fx.has,
                    text: 'E-Flow v' + VER + ' · 全局接管本来就是开着的；global.txt 里缺规则块，已' + (fx.has ? '补回（回读确认）' : '补写失败') + '。',
                    data: { on: true, doc: !!fx.has, repaired: true }
                };
            }
            return { ok: true, text: 'E-Flow v' + VER + ' · 全局接管本来就是' + (nextOn ? '开' : '关') + '的，没有重复写入。', data: { on: on, doc: docHas, already: true } };
        }

        // ③ 人点头闸门（设置面板里人直接点的走 via=ui：有 UI 二次确认，不走 AI 令牌）
        var viaUi = (String(opts.via || 'ai') === 'ui');
        if (!viaUi) {
            var jd = judgeConfirm(opts.confirm);
            var pend = (cur && cur.pending) || null;
            var tokOk = !!(pend && pend.nonce && opts.token && String(pend.nonce) === String(opts.token));
            var fresh = !!(tokOk && pend.at && (Date.now() - Date.parse(pend.at)) < PENDING_TTL_MS);
            if (jd.v !== 'yes') {
                return {
                    ok: false,
                    text: 'E-Flow v' + VER + ' · 不是 1（' + jd.why + '）——global.txt 与开关文件一个字节都没改。\n' +
                        '  · 什么都不用做、也不用再说一遍：他回 1 就继续，不回就算了（禁追问、禁把话术换个说法再问）。',
                    data: { on: on, needConfirm: true }
                };
            }
            if (!fresh) {
                return {
                    ok: false,
                    text: 'E-Flow v' + VER + ' · 他回了 1，但这次确认已过期或对不上号（令牌 30 分钟、一次一用）——什么都不改。\n' +
                        '  · 重新 action=ask 拿一句新话术，再问一遍。',
                    data: { on: on, needAsk: true, say: SAY_ON }
                };
            }
        }

        var prevJson = (await safeRead(io, gp)) || '';
        var body = {
            global: nextOn,
            since: nextOn ? ((cur && cur.since) || new Date().toISOString()) : ((cur && cur.since) || ''),
            offAt: nextOn ? '' : new Date().toISOString(),
            ver: VER,
            pending: null
        };
        try {
            if (io.mkdir) { try { await io.mkdir(dr + '/alphal'); } catch (_) { } }
            var docR = await syncGlobalDoc(io, dr, nextOn);
            if (nextOn && !docR.has) throw new Error('global.txt 写完回读没找到规则块');
            await io.write(gp, JSON.stringify(body, null, 2) + '\n');
        } catch (e) {
            // 两处必须同生同灭：任一失败 → 尽力回滚，然后如实报错（禁假成功）
            var rb = '回滚失败，请手动检查 global.txt 与 alphal/eflow.json';
            try {
                await io.write(dp, docTxt);
                await io.write(gp, prevJson);
                rb = '已回滚到动手之前的状态';
            } catch (_) { /* 保持 rb 原文 */ }
            return { ok: false, text: '✗ 写盘失败：' + ((e && e.message) || e) + '（' + rb + '）', data: { on: on } };
        }
        // 回读验真（写成功不等于生效；两处都要读回来）
        var back = null;
        try { back = JSON.parse((await safeRead(io, gp)) || 'null'); } catch (_) { back = null; }
        var backDoc = (await safeRead(io, dp)) || '';
        var okJson = !!(back && back.global === nextOn);
        var okDoc = nextOn
            ? (backDoc.indexOf(GDOC_B) >= 0 && backDoc.indexOf(GDOC_E) >= 0)
            : (backDoc.indexOf(GDOC_B) < 0);
        var okNow = okJson && okDoc;
        var o = [];
        o.push('E-Flow v' + VER + ' · 全局接管：' + (nextOn ? '已开启' : '已关闭') +
            (okNow ? '（开关文件与 global.txt 均已回读确认）'
                : '（⚠ 回读不一致：' + (!okJson ? '开关文件' : '') + (!okJson && !okDoc ? ' + ' : '') + (!okDoc ? 'global.txt' : '') + '）'));
        var kind = (nextOn && root) ? await projectKind(io, root) : '';
        if (nextOn) {
            o.push('  · 规则块已写入 ' + dp + '（带标记，随时可整块删除）');
            o.push('  · 以后任何白纸项目（没有自己的规则、也没接过）→ 自动铺骨架 + 接一行 rule，用户什么都不用做');
            o.push('  · 已经有自己知识库的项目：一个字都不动，只把每轮注入字数报出来');
            if (kind === 'white') o.push('  · 当前项目：白纸 → 立刻 eflow op=upgrade keep-rules=true 把它接进来，再 op=check 把数字报给用户');
            else if (kind === 'ef2') o.push('  · 当前项目：已经是 E-Flow v2 → 刚才一个字都没改；跑一次 op=check 把数字报给用户就行');
            else if (kind === 'l0') o.push('  · 当前项目：已经有一份自己的 ' + DEF.l0 + '（不是 EF2 生成的）→ 一个字都不动；要不要换成 EF2 由用户亲口说，禁自己 upgrade');
            else if (kind === 'custom') o.push('  · 当前项目：有自己的知识库（project.txt 里是自己写的 rule）→ 一个字都不动，只把 op=status 的字数报给用户');
            else o.push('  · 当前项目：（没有打开的项目）');
            o.push('  · 关掉：eflow op=global action=ask act=off（先问用户，回 1 才动）');
        } else {
            o.push('  · global.txt 里的规则块已摘除（用户其它内容逐字节保留）');
            o.push('  · 已接入的项目保持现状（它们各自 project.txt 里的那一行不动）；要拆某个项目：eflow op=detach');
            o.push('  · 想再开：eflow op=global action=ask');
        }
        return { ok: okNow, text: o.join('\n'), data: { on: nextOn, known: true, doc: okDoc, kind: kind, nextAction: (nextOn && kind === 'white') ? 'upgrade' : '' } };
    }

    // ── 统一入口（工具与 CLI 都走这里）───────────────────────────────────
    async function run(op, io, root, opts) {
        opts = opts || {};
        resetState();
        try {
            if (!root) return { ok: false, text: '✗ 缺项目根路径' };
            var r;
            switch (op) {
                case 'status': r = await opStatus(io, root, opts); break;
                case 'check': r = await opCheck(io, root, opts); break;
                case 'index': r = await opIndex(io, root, opts); break;
                case 'init': r = await opInit(io, root, opts); break;
                case 'rotate': r = await opRotate(io, root, opts); break;
                case 'upgrade': r = await opUpgrade(io, root, opts); break;
                case 'detach': r = await opDetach(io, root, opts); break;
                case 'global': r = await opGlobal(io, root, opts); break;
                default: return { ok: false, text: '✗ 未知操作：' + op + '（status/check/index/init/rotate/upgrade/detach/global）' };
            }
            return r;
        } catch (e) {
            return { ok: false, text: '✗ eflow ' + op + ' 失败：' + ((e && e.message) || e) };
        }
    }

    return {
        VER: VER, BUDGET: BUDGET, MARK_B: MARK_B, MARK_E: MARK_E,
        DEF: DEF, run: run,
        // 供测试直接调
        opStatus: opStatus, opCheck: opCheck, opIndex: opIndex, opInit: opInit,
        opRotate: opRotate, opUpgrade: opUpgrade, opDetach: opDetach, opGlobal: opGlobal, globalFile: globalFile,
        judgeConfirm: judgeConfirm, projectKind: projectKind, globalDocFile: globalDocFile, globalDocBlock: globalDocBlock,
        syncGlobalDoc: syncGlobalDoc, SAY_ON: SAY_ON, SAY_OFF: SAY_OFF, SAY_TAIL: SAY_TAIL,
        PENDING_TTL_MS: PENDING_TTL_MS, GDOC_B: GDOC_B, GDOC_E: GDOC_E,
        parseHead: parseHead, parseFront: parseFront, buildBlock: buildBlock, sliceBlock: sliceBlock,
        nchars: nchars, tplL0: tplL0, tplArch: tplArch, tplState: tplState
    };
});
