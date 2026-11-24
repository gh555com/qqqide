// ci/tests/eflow-panel.test.js — 「文档地基」面板（ai-panel/panel-eflow-ui.js）回归守卫。
// 语义：面板是 E-Flow 的唯一手动操作面，但一个字都不许自己算——
//   全部动作必须落到内核 EflowCore.run（禁第二份算术 / 第二套闸门 / 第二处预算常量）。
//   会改 project.txt 的动作（接入/升级、卸载）必须「再点一次」确认，不许一击即改。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server-app', 'ai-panel', 'panel-eflow-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'server-app', 'ai-panel', 'index.html'), 'utf8');
const TICK = () => new Promise((r) => setTimeout(r, 30));

function harness(opts) {
    opts = opts || {};
    const dom = new JSDOM(
        '<!doctype html><html><body><button id="eflow-btn"><span class="qqi qqi-compass"></span></button></body></html>',
        { url: 'https://qqq.test/', runScripts: 'outside-only', pretendToBeVisual: true }
    );
    const win = dom.window;
    const calls = [];
    win.questStore = { getProjectRoot: function () { return opts.root === undefined ? 'C:/proj' : opts.root; } };
    win.qqqideBridge = {
        fs: {
            read: function () { return Promise.resolve(''); },
            write: function () { return Promise.resolve(true); },
            list: function () { return Promise.resolve([]); },
            exists: function () { return Promise.resolve(false); },
            stat: function () { return Promise.resolve(null); },
            mkdir: function () { return Promise.resolve(true); },
            remove: function () { return Promise.resolve(true); },
            rename: function () { return Promise.resolve(true); }
        }
    };
    win.EflowCore = {
        run: function (op) {
            calls.push(op);
            return Promise.resolve({ ok: true, text: 'OUT:' + op, data: { inject: 30494, ruleLines: 1 } });
        }
    };
    win._qoast = function (m) { (win.__toasts = win.__toasts || []).push(m); };
    win.eval(SRC);
    return { dom: dom, win: win, calls: calls };
}
const btn = (win, id) => win.document.querySelector('.ef-btn-' + id);
const box = (win) => win.document.querySelector('.ef-box');

test('eflow 面板: 入口按钮存在（AI 面板底排唯一按钮，全平台）', () => {
    assert.ok(/id="eflow-btn"/.test(HTML), 'AI 面板必须有 #eflow-btn 入口按钮');
    assert.ok(/<script src="panel-eflow-ui\.js"><\/script>/.test(HTML), 'index.html 必须以脚本标签加载 panel-eflow-ui.js');
    assert.ok(HTML.indexOf('<script src="../eflow/eflow-core.js">') < HTML.indexOf('<script src="panel-eflow-ui.js">'),
        'panel-eflow-ui.js 必须在 eflow-core.js 之后加载（内核先就位）');
});

test('eflow 面板: 打开即读状态，且只走内核 status（不自算字数）', async (t) => {
    const { dom, win, calls } = harness({});
    t.after(() => dom.window.close());
    win.document.getElementById('eflow-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await TICK();
    assert.ok(box(win), '必须画出面板');
    assert.deepStrictEqual(calls, ['status'], '打开只允许调内核 status');
    assert.strictEqual(win.document.querySelector('.ef-st-num').textContent, '30494',
        '数字必须原样来自内核 data.inject');
    dom.window.close();
});

test('eflow 面板: 体检 / 整理归档 → 直接落内核（无需确认）', async (t) => {
    const { dom, win, calls } = harness({});
    t.after(() => dom.window.close());
    win.document.getElementById('eflow-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await TICK();
    calls.length = 0;
    btn(win, 'check').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await TICK();
    assert.deepStrictEqual(calls, ['check', 'status'], '体检后必须重读状态（数字要跟着变）');
    assert.ok(/OUT:check/.test(win.document.querySelector('.ef-out').textContent), '内核输出必须原样上屏');
    calls.length = 0;
    btn(win, 'rotate').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await TICK();
    assert.ok(calls.indexOf('rotate') >= 0, '整理归档要真的调内核 rotate');
    dom.window.close();
});

test('eflow 面板: 会改 project.txt 的动作必须「再点一次」（接入/升级 · 卸载）', async (t) => {
    const { dom, win, calls } = harness({});
    t.after(() => dom.window.close());
    win.document.getElementById('eflow-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await TICK();
    for (const id of ['upgrade', 'detach']) {
        calls.length = 0;
        btn(win, id).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await TICK();
        assert.deepStrictEqual(calls, [], id + ' 第一击不许动盘（只 armed）');
        assert.ok(btn(win, id).classList.contains('ef-btn-armed'), id + ' 必须进入确认态');
        btn(win, id).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        await TICK();
        assert.ok(calls.indexOf(id) >= 0, id + ' 第二击才执行');
    }
    dom.window.close();
});

test('eflow 面板: 没有打开的项目 → 不画面板，如实提示', async (t) => {
    const { dom, win, calls } = harness({ root: '' });
    t.after(() => dom.window.close());
    win.document.getElementById('eflow-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await TICK();
    assert.strictEqual(box(win), null, '无项目时不得开空面板');
    assert.deepStrictEqual(calls, []);
    assert.ok((win.__toasts || []).length >= 1, '必须给可见提示');
    dom.window.close();
});

test('eflow 面板: 内核缺失 / 文件通道缺失 → 如实说，不假装成功', async (t) => {
    const { dom, win } = harness({});
    delete win.EflowCore;
    t.after(() => dom.window.close());
    win.document.getElementById('eflow-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await TICK();
    const st = win.document.querySelector('.ef-st-lab').textContent;
    assert.ok(/不可用/.test(st), '缺内核必须明说（实际：' + st + '）');
    dom.window.close();
});

test('eflow 面板: 禁止第二份算术（不许出现预算常量 / 自己数文件）', () => {
    for (const bad of ['2500', 'BUDGET', '.length} 字', 'inject >', 'inject >=']) {
        assert.strictEqual(SRC.indexOf(bad), -1, '面板里不得出现「' + bad + '」——算术只在内核');
    }
    assert.ok(/EflowCore\.run/.test(SRC), '唯一执行路径 = EflowCore.run');
    const ops = (SRC.match(/\['upgrade', 'check', 'rotate', 'detach'\]/) || [])[0];
    assert.ok(ops, '动作白名单必须与内核 op 对齐（upgrade/check/rotate/detach）');
});
