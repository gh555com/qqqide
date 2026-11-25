// ci/tests/i18n.test.js — 多语言完整性守卫（唯一真理源 = server-app/locales/zh.json）
//
// 语义：开发者只写中文（zh.json）；另外 12 语言由 op/qky.py 差分翻译（内部走翻译管线，禁手改）。
//   本守卫把「键有没有被登记」「12 语言有没有跟上」「英语内嵌兜底表有没有同步」变成机器判定 ——
//   这三件事任一失守，用户看到的就是中文回退或英文兜底，而不是他选的语言。
//
// 四道闸：
//   A 代码引用的键必须全部在 zh.json（含 data-i18n* 属性；动态拼接的键在源头就不允许）
//   B 12 语言键集必须与 zh.json 完全一致（少 = 没翻译，多 = 陈旧孤儿）
//   C i18n.js 的 _EN_BUILTIN 必须等于 en.json（运行时英文兜底，漂移即静默降级）
//   D 一键任务卡的标题 / 提词键必须存在，且中文值 = 出厂文案（否则卡片标题变样、说的不再是那句人话）
//     ★ 提词另多一道：暗号卡（eflow-adopt）也要上表（非中文用户不能冒出中文气泡），
//       前提是判定不靠语言（怎么答永远只有一个字符「1」），且译文必须保留品牌词 `E-Flow`
//   E 接管话术（sayOn / sayOff）：中文基线 = 内核常量（逐字相等），13 语言都必须含「1」与 `E-Flow`
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'server-app');
const core = require(path.join(APP, 'eflow', 'eflow-core.js'));
const LOCALES = path.join(APP, 'locales');
const LANGS = ['zh-tw', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'ar', 'hi', 'vi', 'pt-BR'];

// 非键（正则误捕）：i18n.js 与 service-worker.js 内部的局部变量名 / 内联字典片段
const NOT_KEYS = new Set(['key', 'cancel', 'time.ago', 'goods.']);

function walk(dir, out) {
    out = out || [];
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (/\.(js|html)$/i.test(name)) out.push(p);
    }
    return out;
}

function flat(obj, prefix, out) {
    out = out || {};
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        const kk = prefix ? prefix + '.' + k : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, kk, out);
        else out[kk] = v;
    }
    return out;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const ZH = readJson(path.join(LOCALES, 'zh.json'));
const ZH_FLAT = flat(ZH, '');

test('i18n A：代码引用的每个键都已登记在 zh.json', () => {
    const helper = /(?:\b_q|\b_t|\b_i|\b_qq|i18n\.t|I18N\.t)\(\s*['"]([A-Za-z0-9_.\-]+)['"]/g;
    const attr = /data-i18n(?:-[a-z]+)?\s*=\s*['"]([A-Za-z0-9_.\-]+)['"]/g;
    const missing = [];
    for (const file of walk(APP)) {
        const src = fs.readFileSync(file, 'utf8');
        for (const re of [helper, attr]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(src))) {
                const key = m[1];
                if (NOT_KEYS.has(key)) continue;
                if (key.endsWith('.') || key.indexOf('..') >= 0) continue;   // 动态前缀，不是键
                if (ZH_FLAT[key] === undefined) missing.push(key + '  ← ' + rel(file));
            }
        }
    }
    assert.deepStrictEqual(missing, [], '以下键被代码引用但 zh.json 未登记：\n  ' + missing.join('\n  '));
});

test('i18n B：12 语言键集与 zh.json 完全一致（零缺失 / 零陈旧）', () => {
    const zhKeys = Object.keys(ZH_FLAT).sort();
    for (const lang of LANGS) {
        const f = readJson(path.join(LOCALES, lang + '.json'));
        const mine = Object.keys(flat(f, '')).sort();
        const miss = zhKeys.filter((k) => mine.indexOf(k) < 0);
        const extra = mine.filter((k) => ZH_FLAT[k] === undefined);
        assert.deepStrictEqual(miss, [], '[' + lang + '] 缺 ' + miss.length + ' 键（跑 `python op/qky.py --cli`）：\n  ' + miss.slice(0, 20).join('\n  '));
        assert.deepStrictEqual(extra, [], '[' + lang + '] 多 ' + extra.length + ' 个 zh.json 已不存在的陈旧键：\n  ' + extra.slice(0, 20).join('\n  '));
    }
});

test('i18n C：i18n.js 的 _EN_BUILTIN 与 en.json 同步', () => {
    const js = fs.readFileSync(path.join(APP, 'core', 'i18n.js'), 'utf8');
    const marker = 'var _EN_BUILTIN = ';
    const at = js.indexOf(marker);
    assert.ok(at > 0, 'i18n.js 必须有 _EN_BUILTIN 内嵌表');
    const eol = js.indexOf('\n', at);
    let line = js.slice(at + marker.length, eol > 0 ? eol : js.length).trim();
    if (line.endsWith(';')) line = line.slice(0, -1);
    const builtin = JSON.parse(line);
    const en = readJson(path.join(LOCALES, 'en.json'));
    assert.deepStrictEqual(builtin, en, '_EN_BUILTIN 与 en.json 漂移（跑 `python op/qky.py --cli` 自动同步）');
});

test('i18n D：一键任务卡标题键存在，且中文值 = 出厂标题', () => {
    const src = fs.readFileSync(path.join(APP, 'ai-panel', 'panel-tasks.js'), 'utf8');
    const block = /var CARD_TITLE_KEYS = \{([\s\S]*?)\n    \};/.exec(src);
    assert.ok(block, 'panel-tasks.js 必须保留 CARD_TITLE_KEYS');
    const pairs = Array.from(block[1].matchAll(/'([a-z0-9-]+)':\s*'([A-Za-z0-9_.\-]+)'/g)).map((m) => [m[1], m[2]]);
    assert.ok(pairs.length >= 6, '内置卡标题键至少 6 个（实际 ' + pairs.length + '）');
    // 出厂中文标题（= 兜底表的 title.zh，也是运维台默认表）
    const defaults = {};
    for (const m of src.matchAll(/id: '([a-z0-9-]+)'[\s\S]{0,400}?title: \{ zh: '([^']*)'/g)) defaults[m[1]] = m[2];
    for (const [id, key] of pairs) {
        assert.ok(ZH_FLAT[key] !== undefined, '标题键未登记：' + key);
        assert.strictEqual(ZH_FLAT[key], defaults[id], '标题键 ' + key + ' 的中文值必须等于出厂标题「' + defaults[id] + '」（否则换语言时卡片标题会变样）');
    }
    const pane = /title: \{ zh: '([^']*)'/.exec(src);
    assert.ok(pane, '兜底表必须有面板标题');
    assert.strictEqual(ZH_FLAT['ai.tasks.title'], pane[1], 'ai.tasks.title 必须等于兜底面板标题');
});

test('i18n D2：一键任务提词键存在、中文值 = 出厂提词；暗号卡也上表（译文必留 E-Flow）', () => {
    const src = fs.readFileSync(path.join(APP, 'ai-panel', 'panel-tasks.js'), 'utf8');
    const block = /var CARD_PROMPT_KEYS = \{([\s\S]*?)\n    \};/.exec(src);
    assert.ok(block, 'panel-tasks.js 必须保留 CARD_PROMPT_KEYS');
    const pairs = Array.from(block[1].matchAll(/'([a-z0-9-]+)':\s*'([A-Za-z0-9_.\-]+)'/g)).map((m) => [m[1], m[2]]);
    assert.ok(pairs.length >= 6, '内置卡提词键至少 6 个（实际 ' + pairs.length + '）');
    // ★ 暗号卡必须上表：否则非中文用户点卡就冒出一句中文气泡（谎报他说过什么）。
    //   能翻的前提是判定不靠语言：怎么答永远只有一个字符「1」（内核 judgeConfirm）。
    assert.ok(pairs.some(([id, key]) => id === 'eflow-adopt' && key === 'ai.tasks.promptEflowAdopt'),
        '暗号卡 eflow-adopt 必须上翻译表（键 ai.tasks.promptEflowAdopt）');
    for (const lang of ['zh', ...LANGS]) {
        const f = lang === 'zh' ? ZH : readJson(path.join(LOCALES, lang + '.json'));
        const v = flat(f, '')['ai.tasks.promptEflowAdopt'];
        assert.ok(typeof v === 'string' && v.indexOf('E-Flow') >= 0,
            '[' + lang + '] 暗号提词必须保留品牌词 E-Flow（AI 靠它定向）：' + JSON.stringify(v));
    }
    // 出厂中文提词（= 兜底表 prompt，也是运维台默认表）
    const defaults = {};
    for (const m of src.matchAll(/id: '([a-z0-9-]+)'[\s\S]{0,700}?prompt: '([^']*)'/g)) defaults[m[1]] = m[2];
    for (const [id, key] of pairs) {
        assert.ok(ZH_FLAT[key] !== undefined, '提词键未登记：' + key);
        assert.ok(defaults[id], '找不到卡 ' + id + ' 的出厂提词');
        assert.strictEqual(ZH_FLAT[key], defaults[id],
            '提词键 ' + key + ' 的中文值必须逐字等于出厂提词（否则换语言时发出去的不是那张卡的意思）');
    }
    // 反向：出厂表里每个可执行卡都必须有提词键（漏一个 = 那个卡对非中文用户退回中文）
    for (const id of Object.keys(defaults)) {
        assert.ok(pairs.some(([pid]) => pid === id), '卡 ' + id + ' 缺提词翻译键');
    }
});

test('i18n E：接管话术（sayOn/sayOff）= 内核常量逐字一致，13 语言都写清「怎么答」', () => {
    // 中文基线只能有一处：内核常量。zh.json 里那两条不许另有写法（漂移 = 用户看到的话术
    // 与实际判定对不上，最轻的后果是用户照着做也不生效）。
    assert.strictEqual(ZH_FLAT['ai.eflow.sayOn'], core.SAY_ON, 'zh.json 的 ai.eflow.sayOn 必须逐字等于内核 SAY_ON');
    assert.strictEqual(ZH_FLAT['ai.eflow.sayOff'], core.SAY_OFF, 'zh.json 的 ai.eflow.sayOff 必须逐字等于内核 SAY_OFF');
    assert.deepStrictEqual(core.SAY_KEYS, { on: 'ai.eflow.sayOn', off: 'ai.eflow.sayOff' },
        '内核 SAY_KEYS 必须就是这两个键（工具层靠它找译文）');
    // 工具层必须真的用上 sayKey：否则译文写好了也不会被用（静默退回中文）
    const tool = fs.readFileSync(path.join(APP, 'ai-panel', 'tools-exec-eflow.js'), 'utf8');
    assert.ok(/data\.sayKey/.test(tool) && /_eflowSay\(/.test(tool),
        'tools-exec-eflow.js 必须把 data.sayKey 交给 i18n 渲染（禁只剩中文基线）');
    // 每种语言都必须让读者知道「回 1」—— 否则那句确认语在那边等于没有落地方式
    for (const lang of ['zh', ...LANGS]) {
        const f = lang === 'zh' ? ZH : readJson(path.join(LOCALES, lang + '.json'));
        const m = flat(f, '');
        for (const k of ['ai.eflow.sayOn', 'ai.eflow.sayOff']) {
            const v = m[k];
            assert.ok(typeof v === 'string' && v.length > 20, '[' + lang + '] ' + k + ' 缺失或为空');
            assert.ok(v.indexOf('1') >= 0, '[' + lang + '] ' + k + ' 必须含阿拉伯数字 1（怎么答的唯一暗号）：' + v);
            assert.ok(v.indexOf('E-Flow') >= 0, '[' + lang + '] ' + k + ' 必须保留品牌词 E-Flow：' + v);
            if (lang !== 'zh') {
                assert.ok(v !== ZH_FLAT[k], '[' + lang + '] ' + k + ' 没翻译（与中文基线相同）；跑 `python op/qky.py --cli`');
            }
        }
    }
});
