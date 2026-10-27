// ci/tests/help-menu.test.js — help 下拉菜单（core/help-menu.js）回归守卫。
// 重点：数据文件缺失/为空时也必须渲染内置默认树（历史事故：_tree 初始化成数组，
// 无数据文件时 _tree.items === undefined → 首开抛异常 → 菜单「啥也不显示」）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server-app', 'core', 'help-menu.js'), 'utf8');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// bridge 桩：boot.getInfo + fs.read 的返回由参数决定（null = 文件不存在，与真实 shell 一致）
function makeHarness(bridge) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://qqq.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const win = dom.window;
    win.qqqideBridge = bridge || null;
    win.eval(SRC);
    const bar = win.document.createElement('div');
    bar.className = 'qqq-goods-bar';
    win.document.body.appendChild(bar);
    win.qqqHelpMenu.mount(bar);
    return { dom, win, bar };
}

function bridgeWith(readImpl) {
    return {
        boot: { getInfo: () => Promise.resolve({ userData: 'E:\\Data' }) },
        fs: { read: readImpl },
        shell: { openExternal: () => { } },
    };
}

// jsdom 无 innerText → 取名称列文本（copy 行是 .qqq-help-contact-label，其余 .qqq-help-label）
function rowsOf(win, sel) {
    return Array.from(win.document.querySelectorAll(sel)).map((el) => {
        const lab = el.querySelector('.qqq-help-label, .qqq-help-contact-label');
        return (lab ? lab.textContent : el.textContent).trim();
    });
}

test('help-menu: 数据文件缺失（fs.read 返回 null）→ 仍渲染内置默认树（4 行）', async () => {
    const { win } = makeHarness(bridgeWith(() => Promise.resolve(null)));
    const btn = win.document.querySelector('.qqq-help-btn');
    assert.ok(btn, 'help 按钮必须挂上');
    await tick(30);
    btn.dispatchEvent(new win.MouseEvent('mouseenter'));
    await tick(30);
    const root = win.document.querySelector('.qqq-help-menu');
    assert.ok(root, '数据文件缺失时菜单必须照常出现（禁止空白）');
    assert.deepStrictEqual(rowsOf(win, '.qqq-help-row'), ['live', 'contact', 'video', 'community']);
    assert.strictEqual(win.qqqHelpMenu.diag().items, 4, '生效条目恒为默认 4 项');
});

test('help-menu: 无 bridge（boot 缺失）→ 默认树照常渲染', async () => {
    const { win } = makeHarness(null);
    const btn = win.document.querySelector('.qqq-help-btn');
    await tick(20);
    btn.dispatchEvent(new win.MouseEvent('mouseenter'));
    await tick(20);
    assert.ok(win.document.querySelector('.qqq-help-menu'));
    assert.strictEqual(win.document.querySelectorAll('.qqq-help-row').length, 4);
});

test('help-menu: 数据文件 items 为空 → 不接管（回默认树，防空菜单）', async () => {
    const { win } = makeHarness(bridgeWith(() => Promise.resolve('{"v":1,"items":[]}')));
    const btn = win.document.querySelector('.qqq-help-btn');
    await tick(30);
    btn.dispatchEvent(new win.MouseEvent('mouseenter'));
    await tick(30);
    const rows = rowsOf(win, '.qqq-help-row');
    assert.deepStrictEqual(rows, ['live', 'contact', 'video', 'community']);
    assert.strictEqual(win.qqqHelpMenu.diag().items, 4);
});

test('help-menu: 自定义数据树 → 根行/子菜单按数据渲染，hover 逐级展开', async () => {
    const data = JSON.stringify({
        v: 1, items: [
            { label: 'contact', children: [{ label: 'QQ', action: 'copy', value: '1' }, { label: '邮箱', action: 'copy', value: 'a@b' }] },
            { label: 'deep', children: [{ label: 'lv2', children: [{ label: 'leaf', action: 'url', value: 'https://x' }] }] },
        ],
    });
    const { win } = makeHarness(bridgeWith(() => Promise.resolve(data)));
    const btn = win.document.querySelector('.qqq-help-btn');
    await tick(30);
    btn.dispatchEvent(new win.MouseEvent('mouseenter'));
    await tick(30);
    assert.deepStrictEqual(rowsOf(win, '.qqq-help-row'), ['contact', 'deep']);
    assert.strictEqual(win.qqqHelpMenu.diag().treeItems, 2, '数据文件树必须已接管');
    const first = win.document.querySelectorAll('.qqq-help-row')[0];
    first.dispatchEvent(new win.MouseEvent('mouseenter'));
    await tick(20);
    assert.deepStrictEqual(rowsOf(win, '.qqq-help-sub-row'), ['QQ', '邮箱']);
    // 二级：hover deep → lv2 → leaf（三级依旧可展开）
    const deep = win.document.querySelectorAll('.qqq-help-row')[1];
    deep.dispatchEvent(new win.MouseEvent('mouseenter'));
    await tick(20);
    const lv2 = Array.from(win.document.querySelectorAll('.qqq-help-sub-row')).find((el) => el.textContent.indexOf('lv2') >= 0);
    assert.ok(lv2, '二级行必须出现');
    lv2.dispatchEvent(new win.MouseEvent('mouseenter'));
    await tick(20);
    const leaf = Array.from(win.document.querySelectorAll('.qqq-help-sub-row')).find((el) => el.textContent.indexOf('leaf') >= 0);
    assert.ok(leaf, '三级行必须出现');
    win.qqqHelpMenu.close();
    assert.strictEqual(win.document.querySelectorAll('.qqq-help-menu,.qqq-help-sub').length, 0, '关闭后零残留');
});

test('help-menu: 损坏 JSON → 回默认树且只提示一次（禁静默）', async () => {
    const toasts = [];
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://qqq.test/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    win.qqqideQoast = { show: (m) => toasts.push(m) };
    win.qqqideBridge = bridgeWith(() => Promise.resolve('{ broken'));
    win.eval(SRC);
    const bar = win.document.createElement('div');
    win.document.body.appendChild(bar);
    win.qqqHelpMenu.mount(bar);
    const btn = win.document.querySelector('.qqq-help-btn');
    await tick(30);
    btn.dispatchEvent(new win.MouseEvent('mouseenter'));
    await tick(30);
    assert.deepStrictEqual(rowsOf(win, '.qqq-help-row'), ['live', 'contact', 'video', 'community']);
    assert.strictEqual(toasts.length, 1, '损坏必须可见提示（且只一次）');
});
