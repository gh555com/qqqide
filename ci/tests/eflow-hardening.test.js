// ci/tests/eflow-hardening.test.js — E-Flow 内核的「抗攻击 + 留痕」守卫
//
// 守两件事（都是「设计上写了、但可能会悄悄失效」的）：
//   ① judgeConfirm 是一次全串匹配：任意语言、任意畸形输入下，只有「1」放行，其余一律不动、不崩
//   ② 决策留痕：会改盘 / 明确拒绝的动作各留一行（跨项目一本账），只读动作不记；
//      留痕失败不阻断动作，但必须在返回文本里如实说
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const core = require(path.join(ROOT, 'server-app/eflow/eflow-core.js'));
const TMP = path.join(ROOT, '_qqq/tmp/eflow-hardening');

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
const R = (p) => fs.readFileSync(p, 'utf8');
const AUDIT = (dr) => dr + '/alphal/eflow-audit.jsonl';
const auditLines = (dr) => {
    if (!fs.existsSync(AUDIT(dr))) return [];
    return R(AUDIT(dr)).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
};

test('eflow/judgeConfirm: 只有「1」放行；任何语言任何畸形输入一律 other/empty（不崩、可复现）', () => {
    // ① 固定对抗样本：全部必须 other（暗号之外一律不做）
    for (const s of ['确定', '好的', 'OK', 'ok', 'yes', 'YES', '是', 'y', 'true', '同意', '开吧',
        '11', '1 1', '001', '+1', '1.', '1,', '1;', '(1)', '"1"', '`1`', '1️⃣', '١', '一', '壹',
        '确定吗？', '好，但是先别', '\u200b1', '1\u200b']) {
        const r = core.judgeConfirm(s);
        assert.strictEqual(r.v, 'other', JSON.stringify(s) + ' 必须 not-yes（实际 ' + r.v + '）');
    }
    // ② 空白 → empty；③ 阿拉伯数字与全角 1 → yes（同一动作，两种输入法）
    assert.strictEqual(core.judgeConfirm('').v, 'empty');
    assert.strictEqual(core.judgeConfirm('   \n\t ').v, 'empty');
    assert.strictEqual(core.judgeConfirm(null).v, 'empty');
    assert.strictEqual(core.judgeConfirm(undefined).v, 'empty');
    assert.strictEqual(core.judgeConfirm('1').v, 'yes');
    assert.strictEqual(core.judgeConfirm(' 1 ').v, 'yes');
    assert.strictEqual(core.judgeConfirm('１').v, 'yes');
    assert.strictEqual(core.judgeConfirm('\n1\n').v, 'yes');

    // ④ 随机 fuzz：2 万条（固定种子，可复现）——一切结果必在 {yes,other,empty}，且 yes ⇔ trim ∈ {1,１}
    let seed = 20261125;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    const ALPHA = ['1', '１', '١', ' ', '\n', '\t', '\u200b', '0', '2', '.', ',', '-', '+', 'a', 'Z', '确', '定', '吗', '?', '？',
        '😀', 'é', 'Ω', '中', '文', '。', '"', "'", '(', ')', '/', '\\', '<', '>', '&'];
    for (let i = 0; i < 20000; i++) {
        let s = '';
        const n = Math.floor(rnd() * 8);
        for (let k = 0; k < n; k++) s += ALPHA[Math.floor(rnd() * ALPHA.length)];
        const r1 = core.judgeConfirm(s);
        const r2 = core.judgeConfirm(s);
        assert.ok(r1.v === 'yes' || r1.v === 'other' || r1.v === 'empty', '判定值越界：' + r1.v);
        assert.deepStrictEqual(r1, r2, '同输入必须同结果（判定不许有随机性）');
        const tr = String(s).trim();
        if (r1.v === 'yes') assert.ok(tr === '1' || tr === '１', 'yes 只许来自 1/１：' + JSON.stringify(s));
        if (tr === '1' || tr === '１') assert.strictEqual(r1.v, 'yes', '用户真回 1 必须放行：' + JSON.stringify(s));
        if (!tr) assert.strictEqual(r1.v, 'empty', '空白必须是 empty：' + JSON.stringify(s));
    }
    // ⑤ 超大输入也不崩（一次全串匹配，不许回溯爆炸）
    const big = '1'.repeat(200000);
    const t0 = Date.now();
    assert.strictEqual(core.judgeConfirm(big).v, 'other');
    assert.ok(Date.now() - t0 < 500, '超大输入必须仍是常数级（不许正则回溯爆炸）');
});

test('eflow/audit: 改盘动作留一行、拒绝也留一行、只读动作不记', async () => {
    const r = fresh('audit');
    const dr = fresh('audit-data');
    fs.mkdirSync(dr + '/alphal', { recursive: true });

    const init = await core.run('init', IO, r, { name: 'demo', dataRoot: dr, via: 'ui' });
    assert.ok(init.ok, init.text);
    let ls = auditLines(dr);
    assert.strictEqual(ls.length, 1, 'init 必须留一行（实际 ' + ls.length + '）');
    assert.deepStrictEqual([ls[0].op, ls[0].ok, ls[0].via], ['init', 1, 'ui'], '留痕字段：op/ok/via');
    assert.ok(ls[0].ts && typeof ls[0].ts === 'string', '留痕必须有时间戳');

    // 只读动作（check/status）不记——否则账本自己就是噪音
    await core.run('check', IO, r, { dataRoot: dr });
    await core.run('status', IO, r, { dataRoot: dr });
    assert.strictEqual(auditLines(dr).length, 1, 'check/status 不许写账本');

    // 明确拒绝也要留（三个月后唯一能回答「它当时为什么没动」的东西）
    const custom = fresh('audit-custom');
    fs.mkdirSync(custom + '/_qqq/alphal/rule', { recursive: true });
    fs.writeFileSync(custom + '/own.md', '# 我自己的知识库\n');
    fs.writeFileSync(custom + '/_qqq/alphal/rule/project.txt', 'rule"' + custom + '/own.md"\n');
    const up = await core.run('upgrade', IO, custom, { dataRoot: dr });
    assert.strictEqual(up.ok, false, '有自己知识库的项目必须拒写');
    ls = auditLines(dr);
    assert.strictEqual(ls.length, 2, '拒绝也要留一行');
    assert.strictEqual(ls[1].op, 'upgrade');
    assert.strictEqual(ls[1].ok, 0);
    assert.ok(/知识库/.test(ls[1].why), '留痕必须带可读原因：' + ls[1].why);

    // 账本轮转：>128KB → 只留最后 400 行（不许无限长）
    const junk = [];
    for (let i = 0; i < 5000; i++) junk.push('{"ts":"2026-01-01T00:00:00.000Z","op":"init","ok":1,"via":"cli","why":"x"}');
    fs.writeFileSync(AUDIT(dr), junk.join('\n') + '\n');
    const init2 = await core.run('init', IO, r, { dataRoot: dr });
    assert.ok(init2.ok, init2.text);
    const after = R(AUDIT(dr)).split('\n').filter((l) => l.trim());
    assert.ok(after.length <= 402, '账本必须轮转（实际 ' + after.length + ' 行）');
    assert.strictEqual(JSON.parse(after[after.length - 1]).op, 'init', '轮转后最后一行必须是刚发生的那次');
});

test('eflow/audit: 留痕失败不许静默，也不许拦住动作本身', async () => {
    const r = fresh('audit-fail');
    const dr = fresh('audit-fail-data');
    fs.mkdirSync(dr + '/alphal', { recursive: true });
    await core.run('init', IO, r, { name: 'demo', dataRoot: dr });

    const IO_READONLY_AUDIT = Object.assign({}, IO, {
        write: async (p, t) => {
            if (String(p).indexOf('eflow-audit.jsonl') >= 0) throw new Error('磁盘只读');
            return IO.write(p, t);
        }
    });
    const det = await core.run('detach', IO_READONLY_AUDIT, r, { dataRoot: dr });
    assert.ok(det.ok, '留痕失败绝不能拦住动作本身：' + det.text);
    assert.ok(/审计留痕失败/.test(det.text), '留痕失败必须如实上屏：' + det.text);
    assert.strictEqual(det.data && det.data.audit, 'fail:磁盘只读', '失败原因要能被上层读到');
});

test('eflow/audit: 别人的自定义仓库里绝不落文件（没有 dataRoot 且项目不是 EF2 → 不写）', async () => {
    const custom = fresh('audit-outsider');
    fs.mkdirSync(custom + '/_qqq/alphal/rule', { recursive: true });
    fs.writeFileSync(custom + '/own.md', '# 自有知识库\n');
    fs.writeFileSync(custom + '/_qqq/alphal/rule/project.txt', 'rule"' + custom + '/own.md"\n');
    const up = await core.run('upgrade', IO, custom, {});
    assert.strictEqual(up.ok, false);
    assert.strictEqual(fs.existsSync(custom + '/_qqq/alphal/eflow-audit.jsonl'), false,
        '没有 dataRoot 时，非 EF2 项目里一个字节都不许落');
});
