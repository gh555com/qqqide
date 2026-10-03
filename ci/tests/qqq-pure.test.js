// ci/tests/qqq-pure.test.js — 工作台 Pure 机器（core/qqq-pure.js）纯函数回归守卫。
// qqq-pure.js 是浏览器 IIFE（挂 window.qqqPure）+ 尾部 module.exports 守卫 → Node 直测纯函数。
// 契约（详铁律 §4.12 工作台段）：匹配恒取「宁多勿杀」方向——命中⇒引用⇒不进清单⇒不引导删除。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const pure = require(path.join(__dirname, '..', '..', 'server-app', 'core', 'qqq-pure.js'));

test('_refHit: ASCII 边界保护（防 mylogo.png 误判为 logo.png 的引用）', () => {
    assert.strictEqual(pure._refHit('see logo.png here', 'logo.png'), true);
    assert.strictEqual(pure._refHit('xlogo.png', 'logo.png'), false);
    assert.strictEqual(pure._refHit('logo.png5', 'logo.png'), false);
    assert.strictEqual(pure._refHit('_logo.png', 'logo.png'), false);
    assert.strictEqual(pure._refHit('logo.png_', 'logo.png'), false);
});

test('_refHit: 分隔符宽松（CJK/句号/连字符/路径分隔）——宁多勿杀方向', () => {
    assert.strictEqual(pure._refHit('见logo.png。', 'logo.png'), true);
    assert.strictEqual(pure._refHit('logo.png.', 'logo.png'), true);
    assert.strictEqual(pure._refHit('_qqqvault/logo.png', 'logo.png'), true);
    assert.strictEqual(pure._refHit('foo-logo.png', 'logo.png'), true);   // '-' 视作分隔（多留零风险）
    assert.strictEqual(pure._refHit('', 'logo.png'), false);
    assert.strictEqual(pure._refHit('logo.png', ''), false);
});

test('_findOrphans: 名字令牌 + 📎 锚点（引号式含空格）+ 目录首段引用同规', () => {
    const items = [
        { name: 'used.png', isDir: false, size: 10 },
        { name: '松尾早人 - x.mp3', isDir: false, size: 20 },
        { name: 'old.png', isDir: false, size: 30 },
        { name: 'loose_dir', isDir: true, size: 0 },
    ];
    const contents = [
        'see used.png and _qqqvault/loose_dir/x.png here',
        '\u{1F4CE}abcdef123456:"松尾早人 - x.mp3"',
    ];
    const or = pure._findOrphans(items, contents);
    assert.deepStrictEqual(or.map((x) => x.name), ['old.png']);
});

test('_findOrphans: URL 编码变体也算引用（%20 空格）', () => {
    const items = [{ name: 'my file.png', isDir: false, size: 1 }];
    assert.deepStrictEqual(pure._findOrphans(items, ['link: _qqqvault/my%20file.png done']), []);
    assert.deepStrictEqual(pure._findOrphans(items, ['nothing here']).map((x) => x.name), ['my file.png']);
});

test('_findOrphans: 空内容 / 空列表 / 大小写不敏感', () => {
    assert.deepStrictEqual(pure._findOrphans([], ['x']), []);
    assert.deepStrictEqual(pure._findOrphans([{ name: 'A.PNG', isDir: false, size: 1 }], ['see a.png']), []);
    const or = pure._findOrphans([{ name: 'x.png', isDir: false, size: 1 }], []);
    assert.strictEqual(or.length, 1);
});

test('_fmtBytes/_binExt: 展示与二进制跳过表', () => {
    assert.strictEqual(pure._fmtBytes(0), '0 B');
    assert.strictEqual(pure._fmtBytes(2048), '2.0 KB');
    assert.strictEqual(pure._fmtBytes(1024 * 1024), '1.0 MB');
    assert.strictEqual(pure._binExt('a.png'), true);
    assert.strictEqual(pure._binExt('a.mp4'), true);
    assert.strictEqual(pure._binExt('a.md'), false);
    assert.strictEqual(pure._binExt('README'), false);
});
