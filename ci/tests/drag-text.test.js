// ci/tests/drag-text.test.js — iframe 外拖文本提取机（core/drag-text.js）纯函数回归守卫。
// drag-text.js 是浏览器 IIFE（挂 window.qqqDragText）+ 尾部 module.exports 守卫：
//   Node 直测纯函数（classify / parseUriList / extractText / installInternalGuard）。
//   htmlToText 依赖 DOMParser（Node 无此全局）→ 只测「无 DOMParser 时安全回退空串」。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const dt = require(path.join(__dirname, '..', '..', 'server-app', 'core', 'drag-text.js'));

function fakeDT(types, registry) {
    return {
        types: types || [],
        getData: function (k) {
            if (registry && Object.prototype.hasOwnProperty.call(registry, k)) {
                if (registry[k] === '__THROW__') throw new Error('blocked');
                return registry[k];
            }
            return '';
        },
    };
}

test('classify: Files 恒优先（含内部拖拽）；text 三型外部接管；内部拖拽/未知载荷让路', () => {
    assert.strictEqual(dt.classify(fakeDT(['Files']), false), 'files');
    assert.strictEqual(dt.classify(fakeDT(['Files']), true), 'files');           // 内部+Files（理论不可达）仍归 files
    assert.strictEqual(dt.classify(fakeDT(['text/plain']), false), 'text');
    assert.strictEqual(dt.classify(fakeDT(['text/uri-list']), false), 'text');
    assert.strictEqual(dt.classify(fakeDT(['text/html']), false), 'text');
    assert.strictEqual(dt.classify(fakeDT(['text/plain']), true), null);         // 内部拖拽 → 让路原生
    assert.strictEqual(dt.classify(fakeDT(['text/html', 'text/plain']), true), null);
    assert.strictEqual(dt.classify(fakeDT([]), false), null);
    assert.strictEqual(dt.classify(fakeDT(['application/x-custom']), false), null);
    assert.strictEqual(dt.classify(null, false), null);
});

test('parseUriList: # 注释行与空行跳过；CRLF 容忍；多行以 \\n 连接', () => {
    assert.strictEqual(dt.parseUriList('https://a.example.com/x'), 'https://a.example.com/x');
    assert.strictEqual(dt.parseUriList('# comment\r\nhttps://a.example.com/x\r\n'), 'https://a.example.com/x');
    assert.strictEqual(dt.parseUriList('https://a\r\n\r\n# c\r\nhttps://b'), 'https://a\nhttps://b');
    assert.strictEqual(dt.parseUriList('# only comment'), '');
    assert.strictEqual(dt.parseUriList(''), '');
    assert.strictEqual(dt.parseUriList(null), '');
});

test('extractText: 优先级 plain → uri-list → html；取数异常安全回退空串', () => {
    // plain 最优先
    assert.strictEqual(
        dt.extractText(fakeDT(['text/plain', 'text/uri-list'], { 'text/plain': 'Hello', 'text/uri-list': 'https://x' })),
        'Hello');
    // plain 空 → uri-list（注释行跳过）
    assert.strictEqual(
        dt.extractText(fakeDT(['text/uri-list'], { 'text/plain': '', 'text/uri-list': '# c\r\nhttps://x.example.com/a' })),
        'https://x.example.com/a');
    // 全空 → ''（html 分支依赖 DOMParser，Node 下安全回退空串）
    assert.strictEqual(dt.extractText(fakeDT(['text/html'], { 'text/plain': '', 'text/uri-list': '', 'text/html': '<p>x</p>' })), '');
    // getData 抛异常（受保护载荷）→ 全程安全
    assert.strictEqual(dt.extractText(fakeDT(['text/plain'], { 'text/plain': '__THROW__' })), '');
    assert.strictEqual(dt.extractText(null), '');
});

test('installInternalGuard: dragstart 置位 / dragend·窗口失焦清位（TTL 兜底不可速测）', () => {
    const handlers = {};
    const winHandlers = {};
    const doc = {
        addEventListener: function (t, f) { handlers[t] = f; },
        defaultView: { addEventListener: function (t, f) { winHandlers[t] = f; } },
    };
    const isInternal = dt.installInternalGuard(doc);
    assert.strictEqual(isInternal(), false);
    handlers['dragstart']({});
    assert.strictEqual(isInternal(), true);
    winHandlers['blur']({});          // 窗口失焦 → 清（防丢 dragend 的陈旧标记——外源拖拽前必先聚焦源窗口）
    assert.strictEqual(isInternal(), false);
    handlers['dragstart']({});
    assert.strictEqual(isInternal(), true);
    handlers['dragend']({});
    assert.strictEqual(isInternal(), false);
});

test('htmlToText: 无 DOMParser（Node）→ 安全回退空串，不抛错', () => {
    assert.strictEqual(dt.htmlToText('<p>hello</p>'), '');
    assert.strictEqual(dt.htmlToText(''), '');
    assert.strictEqual(dt.htmlToText(null), '');
});
