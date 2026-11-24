// ci/tests/eflow.test.js — E-Flow v2 内核与接线守卫
//
// 守的是四件事（都是「说好了但会悄悄失效」的）：
//   ① 闸门真的拦人（超预算 / 多注入点 / 生成区漂移 / 死路由 / 经验缺 triggers）
//   ② 升级真的省钱（单片注入 → 分层，注入字数按量下降，备份留底）
//   ③ 轮转真的动手（经验归档 + INDEX.tsv 重建 + STATE 搬旧楼）
//   ④ 产品只有一份实现（内核 ⇄ 工具 ⇄ 面板脚手架 ⇄ 能力清单，禁第二套模板）
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const core = require(path.join(ROOT, 'server-app/eflow/eflow-core.js'));
const TMP = path.join(ROOT, '_qqq/tmp/eflow-test');

const IO = {
    read: (p) => fs.promises.readFile(p, 'utf8'),
    write: async (p, t) => { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, t, 'utf8'); },
    list: async (p) => (await fs.promises.readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
    exists: async (p) => { try { await fs.promises.stat(p); return true; } catch (_) { return false; } },
    mkdir: async (p) => { if (p) await fs.promises.mkdir(p, { recursive: true }); },
    remove: async (p) => { await fs.promises.unlink(p); },
    rename: async (a, b) => { await fs.promises.rename(a, b); }
};

function fresh(name) {
    const d = path.join(TMP, name).replace(/\\/g, '/');
    fs.rmSync(d, { recursive: true, force: true });
    return d;
}
const L0 = (r) => r + '/_qqq/alphal/expert/index.md';
const RULE = (r) => r + '/_qqq/alphal/rule/project.txt';
const EXP = (r) => r + '/_qqq/alphal/exp/'.replace('/alphal/exp/', '/alphal/expert/exp/');
const W = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const R = (p) => fs.readFileSync(p, 'utf8');

test('eflow: init 建骨架 + 体检 PASS + project.txt 恒 1 行 rule', async () => {
    const r = fresh('init');
    const out = await core.run('init', IO, r, { name: 'demo' });
    assert.ok(out.ok, out.text);
    assert.equal(R(RULE(r)).trim().split('\n').filter((l) => l.trim()).length, 1, 'project.txt 只许 1 行');
    for (const f of ['topology', 'iron_law', 'env_var', 'facts']) {
        assert.ok(fs.existsSync(r + '/_qqq/alphal/expert/arch/' + f + '.md'), 'L1 骨架缺 ' + f);
    }
    const chk = await core.run('check', IO, r);
    assert.ok(chk.ok, '新建项目必须直接 PASS：' + chk.text);
    assert.ok(chk.data.inject <= core.BUDGET.l0_chars, '注入必须在预算内');
    const l0 = R(L0(r));
    assert.ok(l0.indexOf('EF2:BEGIN') > 0 && l0.indexOf('EF2:END') > 0, 'L0 必须有生成区');
});

test('eflow: 闸门 A — 用户自己的 rule 允许存在（白纸原则：只量成本，不拦人）', async () => {
    const r = fresh('two-rule');
    await core.run('init', IO, r, {});
    W(r + '/other.md', '# 用户自己的知识库\n');
    W(RULE(r), R(RULE(r)) + 'rule"' + r + '/other.md"\n');
    const chk = await core.run('check', IO, r);
    assert.equal(chk.ok, true, '自定义 rule 不该把项目判死：' + chk.text);
    assert.ok(/EF2 1 行 rule ｜ 自定义 1 行/.test(chk.text), chk.text);
    // 只有 EF2 自己的 L0 注册两次才算失控
    W(RULE(r), R(RULE(r)) + 'rule"' + L0(r) + '"\n');
    const chk2 = await core.run('check', IO, r);
    assert.equal(chk2.ok, false);
    assert.ok(/注册了 2 次/.test(chk2.text), chk2.text);
});

test('eflow: 白纸项目（无 project.txt、无骨架）= PASS + 只警告', async () => {
    const r = fresh('blank');
    fs.mkdirSync(r, { recursive: true });
    W(r + '/main.js', '// hi\n');
    const chk = await core.run('check', IO, r);
    assert.equal(chk.ok, true, '白纸项目不许被判 FAIL：' + chk.text);
    assert.ok(/白纸/.test(chk.text), chk.text);
    assert.ok(!fs.existsSync(r + '/_qqq/alphal/expert'), '体检禁给人仓落盘骨架');
    assert.ok(!fs.existsSync(RULE(r)), '体检禁改 project.txt');
});

test('eflow: init link=false 只铺骨架、不接背包；detach 只拆 EF2 那一行', async () => {
    const r = fresh('optin');
    W(RULE(r), '我自己的备注\nrule"' + r + '/mine.md"\n');
    W(r + '/mine.md', '# 我的知识库\n');
    await core.run('init', IO, r, { link: false });
    assert.ok(!/expert\/index\.md/.test(R(RULE(r))), 'link=false 禁改 project.txt');
    assert.ok(fs.existsSync(L0(r)), '骨架照铺');
    // 主动接上（init 默认 link=true，只追加自己那一行，其它原样）
    await core.run('init', IO, r, {});
    const txt = R(RULE(r));
    assert.ok(/我自己的备注/.test(txt) && /mine\.md/.test(txt), '用户自己的内容必须原样保留：' + txt);
    assert.equal((txt.match(/rule\s*"/g) || []).length, 2, txt);
    // 拔掉
    const det = await core.run('detach', IO, r, {});
    assert.ok(det.ok, det.text);
    const after = R(RULE(r));
    assert.ok(!/expert\/index\.md/.test(after), 'detach 必须拆掉 EF2 行：' + after);
    assert.ok(/我自己的备注/.test(after) && /mine\.md/.test(after), 'detach 禁动用户自己的东西：' + after);
    assert.ok(fs.existsSync(L0(r)), 'detach 不删文件');
    const purged = await core.run('detach', IO, r, { purge: true });
    assert.ok(purged.ok, purged.text);
    assert.ok(!fs.existsSync(r + '/_qqq/alphal/expert'), 'purge 后骨架目录应改名走人');
});

test('eflow: detach 认相对路径 / ./ 写法（用户手改过的 rule 行也能拔）', async () => {
    const r = fresh('detach-rel');
    await core.run('init', IO, r, {});
    W(RULE(r), 'rule"./_qqq/alphal/expert/index.md"\n' + 'rule"' + r + '/keep.md"\n');
    W(r + '/keep.md', '# 自己的\n');
    const det = await core.run('detach', IO, r, {});
    assert.ok(det.ok, det.text);
    const after = R(RULE(r));
    assert.ok(!/expert\/index\.md/.test(after), '相对路径写法也必须能拔：' + after);
    assert.ok(/keep\.md/.test(after), '别人的 rule 不许动：' + after);
});

test('eflow: 闸门 A+ — rule 指向不存在的文件 = BLOCK（最贵的静默失败）', async () => {
    const r = fresh('dead-rule');
    await core.run('init', IO, r, {});
    W(RULE(r), 'rule"' + r + '/_qqq/alphal/expert/index.md"\n');
    fs.unlinkSync(L0(r));
    const chk = await core.run('check', IO, r);
    assert.equal(chk.ok, false);
    assert.ok(/不存在|L0 缺失/.test(chk.text), chk.text);
});

test('eflow: 闸门 B — L0 超预算 = BLOCK（每轮都在付费）', async () => {
    const r = fresh('over-budget');
    await core.run('init', IO, r, {});
    W(L0(r), R(L0(r)) + '\n' + '填充'.repeat(1200) + '\n');
    const chk = await core.run('check', IO, r);
    assert.equal(chk.ok, false);
    assert.ok(/L0 超字数/.test(chk.text), chk.text);
});

test('eflow: 闸门 I — 生成区被手改 = BLOCK；index 一跑就恢复', async () => {
    const r = fresh('drift');
    await core.run('init', IO, r, {});
    W(L0(r), R(L0(r)).replace('## 二、路由表', '## 二、我手写的'));
    const bad = await core.run('check', IO, r);
    assert.equal(bad.ok, false);
    assert.ok(/生成区与文档头不同步/.test(bad.text), bad.text);
    const idx = await core.run('index', IO, r, {});
    assert.ok(idx.ok, idx.text);
    const good = await core.run('check', IO, r, {});
    assert.ok(good.ok, '重建后必须 PASS：' + good.text);
});

test('eflow: 闸门 C — 死路由 = BLOCK（路由指空气）', async () => {
    const r = fresh('dead-route');
    await core.run('init', IO, r, {});
    W(L0(r), R(L0(r)).replace('`arch/env_var.md`', '`arch/不存在.md`'));
    const chk = await core.run('check', IO, r);
    assert.equal(chk.ok, false);
    assert.ok(/死路由/.test(chk.text), chk.text);
});

test('eflow: 闸门 D — 经验缺 triggers = BLOCK；密钥 = WARN', async () => {
    const r = fresh('exp');
    await core.run('init', IO, r, {});
    W(EXP(r) + 'exp-20260101-0001.md',
        '---\nid: exp-20260101-0001\ndate: 2026-01-01\ndomain: build\nstate: draft\n---\n\n' +
        '## 现象\n炸了\n\n## 根因\n没测\n\n## 定式\n先测\n\n## 证据\npassword = "aB3dE5gH7jK9"\n');
    const chk = await core.run('check', IO, r);
    assert.equal(chk.ok, false);
    assert.ok(/缺必填键 triggers/.test(chk.text), chk.text);
    assert.ok(/疑似密钥/.test(chk.text), '密钥必须被扫出来：' + chk.text);
});

test('eflow: 经验条目合规 → PASS；rotate --apply 归档 + INDEX 重建', async () => {
    const r = fresh('rotate');
    await core.run('init', IO, r, {});
    W(EXP(r) + 'exp-20260101-0001.md',
        '---\nid: exp-20260101-0001\ndate: 2026-01-01\ndomain: build\nstate: draft\ncost: 0.5d\ntriggers: 构建失败, 白屏\n---\n\n' +
        '## 现象\n构建产物白屏\n\n## 根因\n常量被内联\n\n## 定式\n先看构建缓存\n\n## 证据\n命令 + 日期\n');
    const okChk = await core.run('check', IO, r, { today: '2026-03-01' });
    assert.ok(okChk.ok, okChk.text);
    const dry = await core.run('rotate', IO, r, { today: '2026-03-01' });
    assert.ok(/归档候选 1 条/.test(dry.text), dry.text);
    assert.ok(fs.existsSync(EXP(r) + 'exp-20260101-0001.md'), 'dry 不许动盘');
    const applied = await core.run('rotate', IO, r, { apply: true, days: 30, today: '2026-03-01' });
    assert.ok(/已移走 1 条/.test(applied.text), applied.text);
    assert.ok(!fs.existsSync(EXP(r) + 'exp-20260101-0001.md'), '归档后原文件应移走');
    const arch = r + '/_qqq/alphal/expert/archive/2026-03/exp-20260101-0001.md';
    assert.ok(fs.existsSync(arch), '归档正文必须在 archive/YYYY-MM/');
    const tsv = R(EXP(r) + 'INDEX.tsv');
    assert.equal(tsv.trim().split('\n').length, 1, 'INDEX.tsv 只剩表头（已归档的不进索引）');
});

test('eflow: upgrade — 已有自己 rule 默认拒写；force=true 才迁；旧文档一个字节不动', async () => {
    const r = fresh('legacy');
    const mono = r + '/do/总纲.txt';
    const body = '# 老总纲\n' + '铁律'.repeat(4000) + '\n';
    W(mono, body);
    const beforeRule = 'rule"' + mono + '"\n\n随手写的说明一行\n';
    W(RULE(r), beforeRule);
    // ★ 白纸原则的机器闸门：默认拒写（不是提示）
    const refuse = await core.run('upgrade', IO, r, { name: 'legacy' });
    assert.equal(refuse.ok, false, refuse.text);
    assert.ok(/默认一个字都不动/.test(refuse.text), refuse.text);
    assert.equal(R(RULE(r)), beforeRule, '拒写时 project.txt 必须逐字节不变');
    assert.ok(!fs.existsSync(L0(r)), '拒写时不许建骨架');
    // 只读盘点永远允许
    const stt = await core.run('status', IO, r, {});
    assert.ok(/每轮固定注入/.test(stt.text), stt.text);
    const plan = await core.run('upgrade', IO, r, { dry: true, force: true });
    assert.ok(/每轮注入/.test(plan.text), plan.text);
    assert.ok(!fs.existsSync(L0(r)), 'dry 不许建任何文件');
    const out = await core.run('upgrade', IO, r, { name: 'legacy', force: true });
    assert.ok(out.ok, out.text);
    assert.ok(/省/.test(out.text), '必须报出省了多少：' + out.text);
    assert.equal(R(mono), body, '旧文档不许改一个字节');
    const ptxt = R(RULE(r));
    assert.equal((ptxt.match(/rule\s*"/g) || []).length, 1, 'EF2 只占 1 行 rule；旧注入行已停：' + ptxt);
    assert.ok(/随手写的说明一行/.test(ptxt), '用户手写的备注不许被升级吃掉：' + ptxt);
    const chk = await core.run('check', IO, r);
    assert.ok(chk.data.inject <= core.BUDGET.l0_chars, '升级后注入必须进预算：' + chk.text);
    const backups = fs.readdirSync(r + '/_qqq/alphal/rule').filter((n) => n.indexOf('ef2bak') >= 0);
    assert.ok(backups.length >= 1, '改 project.txt 前必须留备份');
});

test('eflow: budget.json 放宽必须可见（WARN）且真生效', async () => {
    const r = fresh('budget');
    await core.run('init', IO, r, {});
    W(r + '/_qqq/alphal/expert/budget.json', JSON.stringify({ _reason: '测试放宽', l2_chars: 40000 }));
    W(r + '/_qqq/alphal/expert/arch/deep/大文档.md', '# 大\n# WHEN：查大文档\n' + '字'.repeat(25000));
    W(r + '/_qqq/alphal/expert/layout.json', JSON.stringify({ _reason: '测试布局', l2: ['_qqq/alphal/expert/arch/deep'] }));
    const chk = await core.run('check', IO, r);
    assert.ok(/budget.json 放宽/.test(chk.text), chk.text);
    assert.ok(/layout.json 改了布局/.test(chk.text), chk.text);
    assert.ok(!/L2 偏大/.test(chk.text), '放宽后不该再报偏大：' + chk.text);
    assert.ok(/查大文档/.test(R(L0(r))) === false, '生成区要 index 之后才更新');
    await core.run('index', IO, r, {});
    assert.ok(/查大文档/.test(R(L0(r))), 'index 后路由表必须含新文档');
});

test('eflow: 产品只有一份实现（工具/面板/能力清单/加载顺序全接线）', () => {
    const defs = R(path.join(ROOT, 'server-app/ai-panel/tools-defs.js'));
    assert.ok(/name: 'eflow'/.test(defs), 'eflow 工具必须在 tools-defs 里');
    assert.ok(/eflow: 'EFFECT'/.test(defs), 'eflow 必须有分类（并行调度要用）');
    const exec = R(path.join(ROOT, 'server-app/ai-panel/tools-exec.js'));
    assert.ok(/case 'eflow': _result = executeEflow\(args\)/.test(exec), 'eflow 必须被分发');
    const html = R(path.join(ROOT, 'server-app/ai-panel/index.html'));
    const iCore = html.indexOf('../eflow/eflow-core.js');
    const iExec = html.indexOf('tools-exec-eflow.js');
    assert.ok(iCore > 0 && iExec > iCore, '内核必须先于工具脚本加载');
    const panel = R(path.join(ROOT, 'server-app/ai-panel/panel-expert.js'));
    assert.ok(panel.indexOf('_skeletonIndex') < 0, '面板里禁再写第二套模板（内核是唯一源）');
    assert.ok(!/EflowCore\.run\('init'/.test(panel), '面板禁在启动时自动铺骨架（白纸原则）：只能由用户主动触发');
    assert.ok(/_checkStandardExists/.test(panel), '面板只许“看”，不许“建”');
    assert.ok(!fs.existsSync(path.join(ROOT, 'server-app/ai-panel/expert-template')), '旧模板目录必须删掉（双源 = 迟早矛盾）');
    const cap = R(path.join(ROOT, 'server-app/capabilities/eflow.md'));
    const probe = (/probe:\s*(.+)/.exec(cap) || [])[1].trim();
    assert.ok(fs.existsSync(path.join(ROOT, 'server-app', probe)), '能力清单的 probe 必须落地：' + probe);
    assert.ok(/eflow/.test(cap) && /check/.test(cap), '能力清单必须写清工具与体检');
});

test('eflow: 闸门 C 反向 — 孤儿文档（有文件、无 WHEN 头）必须点名', async () => {
    const r = fresh('orphan');
    await core.run('init', IO, r, {});
    const f = r + '/_qqq/alphal/expert/arch/deep/无路由.md';
    W(f, '# 谁也不会读我\n\n正文\n');
    W(r + '/_qqq/alphal/expert/layout.json', JSON.stringify({ _reason: '测试', l2: ['_qqq/alphal/expert/arch/deep'] }));
    const chk = await core.run('check', IO, r);
    assert.ok(/孤儿文档/.test(chk.text), chk.text);
    assert.ok(/无路由\.md/.test(chk.text), '必须点名是哪一份：' + chk.text);
    W(f, '# 谁也不会读我\n# WHEN：要改 X 时读我\n\n正文\n');
    const chk2 = await core.run('check', IO, r);
    assert.ok(!/孤儿文档永远读不到/.test(chk2.text), '补了 WHEN 就不许再报：' + chk2.text);
});

test('eflow: 铁律投影超上限 = WARN（不是悬崖）；L0 标题报真实条数', async () => {
    const r = fresh('must-max');
    await core.run('init', IO, r, {});
    const laws = [];
    for (let i = 1; i <= 22; i++) laws.push('# MUST：铁律编号 ' + i);
    W(r + '/_qqq/alphal/expert/arch/iron_law.md',
        '# 铁律\n# WHEN：查铁律\n# 验证日：2026-01-01\n\n' + laws.join('\n') + '\n');
    await core.run('index', IO, r, {});
    const chk = await core.run('check', IO, r);
    assert.ok(/铁律投影 22 条 > 上限 20/.test(chk.text), chk.text);
    assert.equal(chk.ok, true, '铁律多不该把项目判死（硬闸是 L0 字数）：' + chk.text);
    assert.ok(/当前 22 条 \/ 上限 20 条/.test(R(L0(r))), 'L0 标题必须报真实条数：' + R(L0(r)).slice(0, 900));
});

test('eflow: layout 指向不存在的层 = WARN（静默空层）', async () => {
    const r = fresh('lay-miss');
    await core.run('init', IO, r, {});
    W(r + '/_qqq/alphal/expert/layout.json', JSON.stringify({ _reason: '测试', l2: ['docs/不存在的目录'] }));
    const chk = await core.run('check', IO, r);
    assert.ok(/布局指向的路径不存在/.test(chk.text), chk.text);
});

test('eflow: 自家 L0 路径只差大小写 = 仍认作背包（禁误判成别人的）', async () => {
    const r = fresh('case-path');
    await core.run('init', IO, r, {});
    const upper = L0(r).toUpperCase();
    if (upper === L0(r)) return;
    W(RULE(r), 'rule"' + upper + '"\n');
    const chk = await core.run('check', IO, r);
    assert.ok(!/不是本项目的 EF2 L0/.test(chk.text), '大小写不一致不许判死：' + chk.text);
    assert.ok(/EF2 1 行 rule/.test(chk.text), chk.text);
});

test('eflow: global 接管 = 暗号 1（除 1 之外一律零写入，且不追问）', async () => {
    const r = fresh('global-proj');
    const dr = fresh('global-data');
    const GP = dr + '/alphal/eflow.json';
    const GD = dr + '/global.txt';
    // 用户原本的全局规则：以下所有操作一个字都不许动
    W(GD, '## 命名铁律\n- project → quest\n');
    const before = R(GD);

    let s = await core.run('global', IO, r, { dataRoot: dr, action: 'status' });
    assert.equal(s.data.on, false, s.text);
    assert.equal(s.data.doc, false, s.text);

    // ① 没有令牌直接开 → 拒绝且零写入
    let on = await core.run('global', IO, r, { dataRoot: dr, action: 'on', confirm: '1' });
    assert.equal(on.ok, false, on.text);
    assert.equal(fs.existsSync(GP), false, '被拒时不许留下开关文件');
    assert.equal(R(GD), before, '被拒时不许改 global.txt');

    // ② ask → 令牌 + 固定话术（此刻仍什么都不写）
    const ask = await core.run('global', IO, r, { dataRoot: dr, action: 'ask' });
    assert.equal(ask.ok, true, ask.text);
    const tok = ask.data.token;
    assert.ok(tok && tok.length > 4, 'ask 必须给令牌');
    assert.ok(/确定吗/.test(ask.data.say), '话术必须是那句确认语：' + ask.data.say);
    assert.ok(/回复 1 代表确定/.test(ask.data.say), '话术必须写清怎么答：' + ask.data.say);
    assert.equal(R(GD), before, 'ask 阶段什么都不许改');

    // ③ 除 1 之外的一切回复（含「确定」「好」「取消」）→ 一律不写、也不追问
    for (const a of ['', '嗯……', '你说呢？', '确定', '确定。', 'OK', '好的', '不用了', '取消', '11', '1 2']) {
        const rr = await core.run('global', IO, r, { dataRoot: dr, action: 'on', token: tok, confirm: a });
        assert.equal(rr.ok, false, '不是 1 不许放行：' + a + ' → ' + rr.text);
        assert.equal(fs.existsSync(GP) ? JSON.parse(R(GP)).global : false, false, '不是 1 不许开：' + a);
        assert.equal(R(GD), before, '不是 1 不许改 global.txt：' + a);
        assert.equal(rr.data.say, undefined, '不是 1 = 什么都不做（禁再追问一遍）：' + a);
    }

    // ④ 他改口回 1 → 令牌仍然认（拒绝不烧令牌），开（global.txt 契约段 + 开关文件，两处回读）
    const on2 = await core.run('global', IO, r, { dataRoot: dr, action: 'on', token: tok, confirm: '1' });
    assert.equal(on2.ok, true, on2.text);
    assert.equal(JSON.parse(R(GP)).global, true);
    const doc = R(GD);
    assert.ok(doc.indexOf(core.GDOC_B) >= 0 && doc.indexOf(core.GDOC_E) >= 0, 'global.txt 必须有接管规则块');
    assert.equal(doc.indexOf(before), 0, '用户原有内容必须逐字节保留在前');
    assert.ok(/已回读确认/.test(on2.text), on2.text);
    assert.equal(on2.data.kind, 'white', '白纸项目必须被认出来：' + on2.text);
    assert.equal(on2.data.nextAction, 'upgrade', '白纸项目才允许开完直接接进来');

    // ⑦ 幂等：再开一次不重复写
    const again = await core.run('global', IO, r, { dataRoot: dr, action: 'on' });
    assert.equal(again.ok, true, again.text);
    assert.equal(R(GD).split(core.GDOC_B).length - 1, 1, '规则块只许一份');

    // ⑧ 手删规则块 → status 报漂移 → repair 补回
    W(GD, before);
    const st2 = await core.run('global', IO, r, { dataRoot: dr, action: 'status' });
    assert.ok(/漂移/.test(st2.text), st2.text);
    const rep = await core.run('global', IO, r, { dataRoot: dr, action: 'repair' });
    assert.equal(rep.ok, true, rep.text);
    assert.ok(R(GD).indexOf(core.GDOC_B) >= 0);

    // ⑨ 关：ask(off) → 明确肯定 → 段摘除，用户内容一字不动
    const askOff = await core.run('global', IO, r, { dataRoot: dr, action: 'ask', act: 'off' });
    assert.ok(/取消/.test(askOff.data.say), askOff.data.say);
    const off = await core.run('global', IO, r, { dataRoot: dr, action: 'off', token: askOff.data.token, confirm: '1' });
    assert.equal(off.ok, true, off.text);
    assert.equal(JSON.parse(R(GP)).global, false);
    assert.equal(R(GD), before, '关掉后必须回到用户原文（逐字节）');

    const bad = await core.run('global', IO, r, { action: 'on' });
    assert.equal(bad.ok, false, '缺 dataRoot 必须如实失败：' + bad.text);
});

test('eflow: 设置面板直连（via=ui）不需要令牌，但仍两处回读', async () => {
    const r = fresh('global-ui');
    const dr = fresh('global-ui-data');
    const on = await core.run('global', IO, r, { dataRoot: dr, action: 'on', via: 'ui' });
    assert.equal(on.ok, true, on.text);
    assert.ok(R(dr + '/global.txt').indexOf(core.GDOC_B) >= 0);
    assert.equal(JSON.parse(R(dr + '/alphal/eflow.json')).global, true);
    const off = await core.run('global', IO, r, { dataRoot: dr, action: 'off', via: 'ui' });
    assert.equal(off.ok, true, off.text);
    assert.ok(R(dr + '/global.txt').indexOf(core.GDOC_B) < 0);
    assert.equal(JSON.parse(R(dr + '/alphal/eflow.json')).global, false);
});

test('eflow: judgeConfirm = 只认 1（任何语言都没有边界情况）', () => {
    for (const s of ['1', ' 1 ', '1\n', '１']) assert.equal(core.judgeConfirm(s).v, 'yes', JSON.stringify(s));
    for (const s of ['11', '21', '1x', '确定', '确定。', '确认', '好', '好的', '可以', 'OK', 'yes', '是',
        '取消', '不用', '嗯', '你说呢？', '确定吗？', '用户说确定', '1 2', 'x'.repeat(300)]) {
        assert.equal(core.judgeConfirm(s).v, 'other', s + ' → ' + JSON.stringify(core.judgeConfirm(s)));
    }
    assert.equal(core.judgeConfirm('').v, 'empty');
    assert.equal(core.judgeConfirm(null).v, 'empty');
    // 固定话术必须自带「怎么答」那一行（跨语言只认 1，不需要翻译）
    assert.ok(/回复 1 代表确定/.test(core.SAY_ON), core.SAY_ON);
    assert.ok(/回复 1 代表确定/.test(core.SAY_OFF), core.SAY_OFF);
});

test('eflow: 已有自己知识库的项目 —— 全局接管只报数字，一个字都不动', async () => {
    const r = fresh('custom-proj');
    const dr = fresh('custom-data');
    const own = r + '/do/总纲.txt';
    W(own, '铁律'.repeat(2000));
    const before = 'rule"' + own + '"\n';
    W(RULE(r), before);
    const on = await core.run('global', IO, r, { dataRoot: dr, action: 'on', via: 'ui' });
    assert.equal(on.ok, true, on.text);
    assert.equal(on.data.kind, 'custom', '自有知识库必须被认出来：' + on.text);
    assert.equal(on.data.nextAction, '', '自有知识库绝不许自动 upgrade：' + on.text);
    assert.ok(/一个字都不动/.test(on.text), on.text);
    assert.equal(R(RULE(r)), before, 'project.txt 必须逐字节不变');
    assert.ok(!fs.existsSync(L0(r)), '不许建骨架');
    // 机器闸门：upgrade 直接拒写（不靠 AI 自觉）
    const up = await core.run('upgrade', IO, r, {});
    assert.equal(up.ok, false, up.text);
    assert.ok(/默认一个字都不动/.test(up.text), up.text);
    assert.equal(R(RULE(r)), before, '拒写后 project.txt 仍逐字节不变');
});

test('eflow: 接线守卫（禁第二套实现 / 禁面板自己算 / 禁 AI 冒充 UI）', () => {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const tool = read('server-app/ai-panel/tools-exec-eflow.js');
    assert.ok(/via:\s*'ai'/.test(tool), 'AI 工具层必须硬编码 via=ai（否则 JSON 里冒一个 via=ui 就绕过令牌闸门）');

    const set = read('server-app/core/settings.js');
    const core = read('server-app/eflow/eflow-core.js');
    const ui = set.slice(set.indexOf('E-Flow 管理（文档地基'), set.indexOf('function _eflowBind()'));
    assert.ok(ui.length > 500, '设置面板的 E-Flow 区块必须存在');
    // 零算术：预算/字数一律由内核给，面板里搜不到预算常量
    for (const bad of ['l0_chars', '2500', '20000', 'must_max']) {
        assert.ok(ui.indexOf(bad) < 0, '设置面板不得自带预算常量（' + bad + '）——数字必须来自内核');
    }
    assert.ok(/EflowCore/.test(set), '设置面板必须调唯一内核');
    assert.ok(/via:\s*'ui'/.test(set), '设置面板直连必须标 via=ui（与 AI 的令牌闸门区分）');
    // 词表只有一份
    assert.ok(/function judgeConfirm/.test(core), 'judgeConfirm 必须在内核');
    assert.ok(set.indexOf('CONFIRM_YES') < 0, '禁在面板里写第二份确认词表');

    // 内核必须在 settings.js 之前加载（否则面板拿不到 EflowCore）
    const html = read('server-app/index.html');
    const iCore = html.indexOf('eflow/eflow-core.js');
    const iSet = html.indexOf('core/settings.js');
    assert.ok(iCore > 0 && iSet > iCore, 'index.html 必须先加载 eflow/eflow-core.js 再加载 core/settings.js');
});

test.after(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
