// ci/tests/html-paste.test.js — 网页粘贴转换机纯函数回归守卫。
// html-paste.js 是浏览器 IIFE：尾部 module.exports 守卫让纯函数可在 Node 直测
// （依赖 DOMParser 的 process/extractVideoUrls 不在覆盖范围——只测无 DOM 纯函数）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const hp = require(path.join(__dirname, '..', '..', 'server-app', 'core', 'html-paste.js'));

test('looksLikeMarkdown: 标题/代码块单项即真；两项符号命中为真；纯文本为假', () => {
    assert.strictEqual(hp.looksLikeMarkdown('# Title\nbody'), true);
    assert.strictEqual(hp.looksLikeMarkdown('```js\ncode\n```'), true);
    assert.strictEqual(hp.looksLikeMarkdown('- a\n- b'), false);                    // 仅 1 项
    assert.strictEqual(hp.looksLikeMarkdown('- a\n- b\n\n**bold** extra'), true);   // ≥2 项
    assert.strictEqual(hp.looksLikeMarkdown('普通文本没有符号'), false);
    assert.strictEqual(hp.looksLikeMarkdown(''), false);
});

test('_checkHtmlIntegrity: 完好 HTML = 1；断标签拉低；无标签 = 0.5', () => {
    assert.strictEqual(hp._checkHtmlIntegrity('<p>hello</p>'), 1);
    assert.strictEqual(hp._checkHtmlIntegrity('plain text'), 0.5);
    // '<div>' + '<?/span>' + '</div>'：3 个标签命中中 1 个断闭合 → 1 - (1/3)*5 < 0 → 0
    assert.strictEqual(hp._checkHtmlIntegrity('<div><?/span>x</div>'), 0);
});

test('_detectEncodingConfidence: 干净文本 = 1；替换符洪流 → 显著下降', () => {
    assert.strictEqual(hp._detectEncodingConfidence('正常的中文文本 hello'), 1);
    const bad = hp._detectEncodingConfidence('\uFFFD'.repeat(50) + 'x'.repeat(50));
    assert.ok(bad < 0.5, '高替换符必须低置信，got ' + bad);
});

test('repairMojibake: UTF-8 被当 latin1/cp1252 解码的文本还原；合法文本原样', () => {
    // '你好' UTF-8 字节按 latin1 逐字节读 → 乱码串 → 必须还原
    const moji = Buffer.from('你好', 'utf8').toString('latin1');
    assert.strictEqual(hp.repairMojibake(moji), '你好');
    // Windows-1252 误读（0x80-0x9F 段变成 €œ 等）→ 反映射回字节再还原
    assert.strictEqual(hp.repairMojibake('â€œhiâ€\u009D'), '“hi”');
    // emoji（F0 9F 98 80 → ðŸ˜€）
    assert.strictEqual(hp.repairMojibake('ðŸ˜€'), '😀');

    // 合法文本原样（严格 UTF-8 解码必须失败或错位 → 不得误修）
    assert.strictEqual(hp.repairMojibake('Zürich café'), 'Zürich café');
    assert.strictEqual(hp.repairMojibake('Привет мир'), 'Привет мир');
    assert.strictEqual(hp.repairMojibake('hello world'), 'hello world');
    assert.strictEqual(hp.repairMojibake('ROMÂNIA'), 'ROMÂNIA');
    assert.strictEqual(hp.repairMojibake(''), '');
});

test('scanScriptText: play_url/videoUrl JSON 与裸视频扩展名 URL 抽取；噪声不误收', () => {
    assert.deepStrictEqual(
        hp.scanScriptText('var x = {"play_url":"https://cdn.example.com/v/a.mp4","t":1};', ''),
        ['https://cdn.example.com/v/a.mp4'],
    );
    // 转义斜杠（SPA 页脚本常见 \/ 与 \u002F）
    assert.deepStrictEqual(
        hp.scanScriptText('x={"videoUrl":"https:\\/\\/x.com\\/hls.m3u8"}', ''),
        ['https://x.com/hls.m3u8'],
    );
    assert.deepStrictEqual(
        hp.scanScriptText('x={"playUrl":"https:\\u002F\\u002Fy.com\\u002Fv.webm"}', ''),
        ['https://y.com/v.webm'],
    );
    // 裸 URL（无键名）按扩展名抽取；图片/噪声不收
    assert.deepStrictEqual(
        hp.scanScriptText('a("https://a.com/t.jpg"); b("https://a.com/v.webm");', ''),
        ['https://a.com/v.webm'],
    );
    assert.deepStrictEqual(hp.scanScriptText('load("https://ads.example.com/pixel.gif")', ''), []);
    assert.deepStrictEqual(hp.scanScriptText('', ''), []);
});

test('isPlatformVideoUrl 导出（URL 粘贴分类依赖）', () => {
    assert.strictEqual(hp.isPlatformVideoUrl('https://www.youtube.com/watch?v=abc'), true);
    assert.strictEqual(hp.isPlatformVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD'), true);
    assert.strictEqual(hp.isPlatformVideoUrl('https://cdn.example.com/hls/s.m3u8'), true);
    assert.strictEqual(hp.isPlatformVideoUrl('https://cdn.example.com/plain.mp4'), false);
});
