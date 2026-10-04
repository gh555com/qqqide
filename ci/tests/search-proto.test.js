// ci/tests/search-proto.test.js — 搜索协议纯函数机回归（合成字节流 + 实机 rg 加固）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require(path.join(__dirname, '.build', 'search-proto.cjs'));

const ROOT = path.resolve(__dirname, '..', '..');
const SP = 'E:\\proj';

// ── 合成流：三条命中 + CRLF + 多字节 + stats 尾（\0 分帧） ──
function synth() {
    const parts = [];
    parts.push(Buffer.from('E:\\proj\\a.txt\u00001:1:needle first\n'));
    parts.push(Buffer.from('E:\\proj\\b.txt\u00002:8:sec needle line\n', 'utf8'));
    parts.push(Buffer.from('E:\\proj\\cn.txt\u00001:14:中文内容 needle 尾巴\n', 'utf8'));
    parts.push(Buffer.from('E:\\proj\\c_crlf.txt\u00001:7:hello needle\r\n'));
    parts.push(Buffer.from('\n4 matches\n4 matched lines\n4 files contained matches\n9 files searched\n500 bytes printed\n123456 bytes searched\n0.002 seconds spent searching\n0.09 seconds\n'));
    return Buffer.concat(parts);
}

function parseInChunks(buf, cs) {
    const p = new P.NullParser(SP);
    let rows = [];
    for (let i = 0; i < buf.length; i += cs) rows = rows.concat(p.push(buf.subarray(i, i + cs)));
    const fin = p.finish();
    return { rows: rows.concat(fin.rows), stats: fin.stats };
}

test('NullParser: 单块与任意切块位置（含多字节跨块）结果恒等', () => {
    const buf = synth();
    const ref = parseInChunks(buf, buf.length);
    assert.strictEqual(ref.rows.length, 4);
    assert.strictEqual(ref.rows[2].t, '中文内容 needle 尾巴');
    assert.strictEqual(ref.rows[2].c, 6);                    // 字节列 14 → 字符列 6
    assert.strictEqual(ref.rows[3].t, 'hello needle');       // CRLF 尾 \r 剥除
    assert.deepStrictEqual(ref.stats, {
        matches: 4, matchedLines: 4, filesMatched: 4, filesSearched: 9,
        bytesPrinted: 500, bytesSearched: 123456,
        secondsSpentSearching: 0.002, secondsWall: 0.09,
    });
    for (let cs = 1; cs <= 17; cs++) {
        assert.deepStrictEqual(parseInChunks(buf, cs).rows, ref.rows, 'chunk size ' + cs);
    }
});

test('NullParser: 半截流（被杀）保留完整记录、不崩、stats 缺失可判', () => {
    const buf = synth();
    for (const frac of [0.2, 0.45, 0.7, 0.95]) {
        const cut = buf.subarray(0, Math.floor(buf.length * frac));
        const r = parseInChunks(cut, 7);
        assert.ok(r.rows.length >= 0 && r.rows.length <= 4);
        for (const row of r.rows) assert.ok(row.f && typeof row.l === 'number');
    }
});

test('NullParser: 空流 → 零行零统计', () => {
    const r = parseInChunks(Buffer.alloc(0), 5);
    assert.strictEqual(r.rows.length, 0);
    assert.strictEqual(r.stats, null);
});

test('CountsParser: <path>\\0<count>\\n 且任意切块恒等', () => {
    const buf = Buffer.from('E:\\proj\\a.txt\u00002\nE:\\proj\\sub\\b.txt\u00001\nE:\\proj\\cn.txt\u00007\n');
    for (const cs of [1, 3, 5, buf.length]) {
        const p = new P.CountsParser(SP);
        let rows = [];
        for (let i = 0; i < buf.length; i += cs) rows = rows.concat(p.push(buf.subarray(i, i + cs)));
        rows = rows.concat(p.finish());
        assert.deepStrictEqual(rows.map((r) => [r.f, r.n]), [['a.txt', 2], ['sub/b.txt', 1], ['cn.txt', 7]], 'cs=' + cs);
    }
});

test('parseNullList: 尾 NUL 完整判定（残段丢弃）', () => {
    assert.deepStrictEqual(P.parseNullList('a\u0000b\u0000'), ['a', 'b']);
    assert.deepStrictEqual(P.parseNullList('a\u0000b'), ['a']);       // 残段丢
    assert.deepStrictEqual(P.parseNullList(''), []);
});

test('buildReplaceRegex: 转义/通配/整词/多行 CRLF/$ 字面', () => {
    const hit = (re, s) => { re.lastIndex = 0; return re.test(s); };
    const g1 = P.buildReplaceRegex('a.b', false, true, false);
    assert.ok(!hit(g1.re, 'axb') && hit(g1.re, 'a.b'));               // 固定串转义
    const g2 = P.buildReplaceRegex('f.o', true, true, false);
    assert.ok(hit(g2.re, 'fxo'));                                     // 正则通配
    const g3 = P.buildReplaceRegex('foo', false, true, true);
    assert.ok(!hit(g3.re, 'foobar') && hit(g3.re, 'a foo b'));        // 整词
    const g4 = P.buildReplaceRegex('a\\nb', false, true, false);
    assert.ok(hit(g4.re, 'a\nb') && hit(g4.re, 'a\r\nb'));            // \n 字面 + CRLF 容忍
    const g5 = P.buildReplaceRegex('(', true, true, false);
    assert.strictEqual(g5.re, null);                                  // 无效正则 → error
    let cnt = 0;
    const out = 'needle'.replace(P.buildReplaceRegex('needle', false, true, false).re, () => { cnt++; return '$&ok'; });
    assert.strictEqual(cnt, 1);
    assert.strictEqual(out, '$&ok');                                  // 函数替换器：$ 字面
});

test('makeNameMatcher: 大小写/整词/正则/换行拒绝', () => {
    assert.ok(P.makeNameMatcher('ALL', false, false, false)('all.json'));
    assert.ok(!P.makeNameMatcher('ALL', false, true, false)('all.json'));
    assert.ok(P.makeNameMatcher('all', false, false, true)('all.json'));
    assert.ok(!P.makeNameMatcher('all', false, false, true)('allx.json'));
    assert.ok(P.makeNameMatcher('^all\\.json$', true, false, false)('all.json'));
    assert.strictEqual(P.makeNameMatcher('a\\nb', false, false, false), null);
    assert.strictEqual(P.makeNameMatcher('(', true, false, false), null);
});

test('byteColToChar: ASCII 快路径 / 多字节换算 / 越界保留原值', () => {
    assert.strictEqual(P.byteColToChar('hello needle', 7), 7);
    assert.strictEqual(P.byteColToChar('中文内容 needle 尾巴', 14), 6);
    assert.strictEqual(P.byteColToChar('needle', 1), 1);
    assert.strictEqual(P.byteColToChar('ab', 99), 99);
});

test('normalizeQuery: \\n 转义 → 实际换行 + 固定串强制转义', () => {
    const a = P.normalizeQuery('x\\ny', false, false);
    assert.ok(a.hasNewline && a.forceRegex && a.actual.indexOf('\n') !== -1);
    const b = P.normalizeQuery('plain', false, false);
    assert.ok(!b.hasNewline && !b.forceRegex && b.actual === 'plain');
});

test('isRegexParseError: 仅真正则错误命中', () => {
    assert.ok(P.isRegexParseError('regex parse error:\n...'));
    assert.ok(!P.isRegexParseError('No such file or directory'));
});

test('humanBytes 基本映射', () => {
    assert.strictEqual(P.humanBytes(512), '512 B');
    assert.strictEqual(P.humanBytes(2048), '2.0 KB');
    assert.strictEqual(P.humanBytes(5 * 1024 * 1024), '5.0 MB');
});

// ── search-ui 静态卫生：查询记录变量防回归（曾出现「声明+只读、从未赋值」的 _lastQ 幽灵 → 点击结果丢关键词） ──
test('search-ui.html: 查询记录变量卫生（_lastQ 幽灵防回归）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'server-app', 'goods', 'search', 'search-ui.html'), 'utf8');
    assert.ok(!/_lastQ(?!uery)/.test(html), '发现幽灵变量 _lastQ（应为 _lastQuery）');
    assert.ok(html.indexOf('search:_lastQuery') !== -1, 'opn 必须以 _lastQuery 传关键词');
    assert.ok(/_lastQuery\s*=\s*q\s*;/.test(html), 'dos() 必须写 _lastQuery=q（执行口径唯一真理源）');
});

// ── 实机 rg 加固（有二进制才跑；公开 CI 无 rg 自动跳过）──
const RG = path.join(ROOT, 'engines', 'ripgrep', process.platform === 'win32' ? 'rg.exe' : 'rg');
test('live ripgrep: --null --column --stats 帧解析（实机）', { skip: !fs.existsSync(RG) }, () => {
    const D = path.join(__dirname, '.build', 'rgproto');
    fs.rmSync(D, { recursive: true, force: true });
    fs.mkdirSync(D, { recursive: true });
    fs.writeFileSync(path.join(D, 'a.txt'), 'needle first\nsecond needle line\n');
    fs.writeFileSync(path.join(D, 'cn.txt'), '中文内容 needle 尾巴\n');
    const r = spawnSync(RG, ['--null', '--column', '--no-heading', '--with-filename', '--line-number',
        '--color', 'never', '--max-columns=800', '--stats', '--fixed-strings', '--regexp', 'needle', D],
        { encoding: 'buffer', windowsHide: true });
    assert.strictEqual(r.status, 0);
    const p = new P.NullParser(D);
    const rows = p.push(r.stdout).concat(p.finish().rows);
    assert.strictEqual(rows.length, 3);
    const cn = rows.find((x) => x.f === 'cn.txt');
    assert.ok(cn && cn.c === 6 && cn.t === '中文内容 needle 尾巴');
    fs.rmSync(D, { recursive: true, force: true });
});
