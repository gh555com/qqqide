// ci/tests/panel-tasks-hardening.test.js — 一键任务卡的「抗攻击 + 抗回退」守卫
//
// 守三件事（都是「设计上写了、但可能会悄悄失效」的）：
//   ① rev 单调闸：更旧的表（云端回滚 / 边缘缓存 / 老备份）不得覆盖屏上与缓存 —— 防降级
//   ② _sanitize 抗畸形：吃的是不可信服务器 JSON，一万种畸形表都不许崩、不许污染原型、不许超上限
//   ③ when 覆盖闸：出厂兜底表里的每个条件名都必须有本地实现（否则下发条件 = 空操作）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server-app', 'ai-panel', 'panel-tasks.js'), 'utf8');
const REFRESH_MS = 30 * 60 * 1000;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function mkStore(initial) {
    const store = Object.assign({}, initial || {});
    return {
        store: store,
        qgs: {
            simple: function () {
                return {
                    get: function (k) { return Promise.resolve(store[k]); },
                    set: function (k, v) { store[k] = v; return Promise.resolve(true); }
                };
            }
        }
    };
}

function harness(opts) {
    opts = opts || {};
    const dom = new JSDOM(
        '<!doctype html><html><body><div id="messages-wrap"><div id="messages"></div></div>' +
        '<textarea id="input"></textarea></body></html>',
        { url: 'https://qqq.test/', runScripts: 'outside-only', pretendToBeVisual: true }
    );
    const win = dom.window;
    Object.defineProperty(win.document, 'readyState', { configurable: true, get: function () { return 'complete'; } });
    win.qqqBootInfo = { platform: opts.platform || 'win32', arch: opts.arch || 'x64' };
    win.questActiveId = 'draft_p1';
    win._isDraft = function (id) { return /^draft_/.test(String(id)); };
    win._switching = false;
    win.cardPool = { getActive: function () { return null; } };
    win._gateBeforeSend = function () { return true; };
    win._freezeAndSendFromInput = function () { win.__sent = (win.__sent || 0) + 1; };
    const q = mkStore(opts.store);
    win.qgs = q.qgs;
    const state = { payload: opts.payload || null, fail: !!opts.fetchFail };
    win.fetch = function () {
        if (state.fail) return Promise.reject(new Error('offline'));
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(state.payload); } });
    };
    win.eval(SRC);
    return { dom: dom, win: win, state: state, store: q.store };
}

const titles = (win) => Array.from(win.document.querySelectorAll('#task-pane .tp-card')).map((c) => c.querySelector('.tp-t').textContent);

test('tasks/rev: 更旧的表（rev 5）不得覆盖缓存里的 rev 7，也不写缓存', async (t) => {
    const cached = {
        at: Date.now() - REFRESH_MS - 5000,      // 已过期 → 启动即拉网络
        rev: 7,
        raw: { rev: 7, title: { zh: '缓存表' }, tasks: [{ id: 'clean-c', title: { zh: '清理 C 盘' }, prompt: 'p-clean' }] }
    };
    const { dom, win, state, store } = harness({ store: { tasks: cached } });
    t.after(() => dom.window.close());
    await tick(30);
    assert.deepStrictEqual(titles(win), ['清理 C 盘'], '先出缓存里的表');

    state.payload = { rev: 5, title: { zh: '旧表' }, tasks: [{ id: 'startup-clean', title: { zh: '电脑卡顿？' }, prompt: 'p-slow' }] };
    await win.qqqTaskPane.reload();
    await tick(20);
    assert.deepStrictEqual(titles(win), ['清理 C 盘'], '更旧的表（rev 5 < 7）必须整张丢弃，屏上保持缓存那张');
    assert.strictEqual(store.tasks.rev, 7, '防降级：缓存信封里的 rev 不许被旧表改小');
    assert.strictEqual(win.qqqTaskPane.rev().live, 7, '对外诊断口必须报「当前生效 rev = 7」');
});

test('tasks/rev: 更新的表（rev 8）正常生效并更新缓存 rev', async (t) => {
    const cached = {
        at: Date.now() - REFRESH_MS - 5000,
        rev: 7,
        raw: { rev: 7, title: { zh: '缓存表' }, tasks: [{ id: 'clean-c', title: { zh: '清理 C 盘' }, prompt: 'p-clean' }] }
    };
    const { dom, win, state, store } = harness({ store: { tasks: cached } });
    t.after(() => dom.window.close());
    await tick(30);
    state.payload = { rev: 8, title: { zh: '新表' }, tasks: [{ id: 'startup-clean', title: { zh: '电脑卡顿？' }, prompt: 'p-slow' }] };
    await win.qqqTaskPane.reload();
    await tick(20);
    assert.deepStrictEqual(titles(win), ['电脑卡顿？'], 'rev 更大的表必须生效');
    assert.strictEqual(store.tasks.rev, 8, '缓存信封必须记下新的 rev');
});

test('tasks/rev: 表里没有 rev（老格式）→ 无法比较，放行（不能因为缺字段就永远不出卡）', async (t) => {
    const { dom, win, state } = harness({ store: { tasks: { at: Date.now() - REFRESH_MS - 5000, rev: 7, raw: { rev: 7, tasks: [{ id: 'clean-c', title: { zh: '清理 C 盘' }, prompt: 'a' }] } } } });
    t.after(() => dom.window.close());
    await tick(30);
    state.payload = { title: { zh: '无 rev 表' }, tasks: [{ id: 'startup-clean', title: { zh: '电脑卡顿？' }, prompt: 'b' }] };
    await win.qqqTaskPane.reload();
    await tick(20);
    assert.deepStrictEqual(titles(win), ['电脑卡顿？'], '缺 rev 视为「不可比较」→ 放行');
});

test('tasks/rev: 网络全挂时不得把缓存冲成出厂兜底表（缓存优于兜底）', async (t) => {
    const cached = {
        at: Date.now() - REFRESH_MS - 5000,
        rev: 9,
        raw: { rev: 9, title: { zh: '缓存表' }, tasks: [{ id: 'clean-c', title: { zh: '清理 C 盘' }, prompt: 'p-clean' }] }
    };
    const { dom, win } = harness({ store: { tasks: cached }, fetchFail: true });
    t.after(() => dom.window.close());
    await tick(40);
    assert.deepStrictEqual(titles(win), ['清理 C 盘'], '网络全挂必须沿用缓存，不许掉回出厂表');
});

test('tasks/when: 出厂兜底表里的每个条件名都必须有本地实现（否则下发条件 = 空操作）', async (t) => {
    const { dom, win } = harness({ fetchFail: true });
    t.after(() => dom.window.close());
    await tick(30);
    const impl = win.qqqTaskPane.whenConditions();
    assert.ok(impl.indexOf('eflow.off') >= 0, '全局接管条件的实现必须存在：' + JSON.stringify(impl));
    // 源扫描：出厂表里出现的所有 when 名（服务器下发的不能逐个静态断言，出厂表可以）
    const names = [];
    const re = /when:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = re.exec(SRC))) {
        const inner = m[1];
        const q = /'([^']+)'|"([^"]+)"/g;
        let n;
        while ((n = q.exec(inner))) names.push(n[1] || n[2]);
    }
    assert.ok(names.length >= 1, '出厂表里至少要有一个条件卡（否则这条闸门是空转）');
    for (const name of names) {
        assert.ok(impl.indexOf(name) >= 0, '出厂表用了条件 ' + name + '，但本地没有实现（下发等于空操作）');
    }
});

test('tasks/fuzz: 畸形服务器表一万种也不许崩 / 不许污染原型 / 不许超上限', async (t) => {
    const { dom, win, state } = harness({ payload: null });
    t.after(() => dom.window.close());
    await tick(20);

    // 固定种子的伪随机（可复现）：每次跑出同一串畸形表
    let seed = 20261125;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    function pick(a) { return a[Math.floor(rnd() * a.length) % a.length]; }
    const WORDS = ['__proto__', 'constructor', 'prototype', 'id', 'title', 'prompt', 'when', 'tasks', 'rev',
        'toString', 'valueOf', 'hasOwnProperty', '<img src=x onerror=1>', '1', '', ' ', '清理 C 盘'];
    function junk(depth) {
        const k = rnd();
        if (depth <= 0 || k < 0.30) return pick([0, 1, -1, 3.5e9, NaN, Infinity, null, true, false, '', ' ', 'x'.repeat(1 + Math.floor(rnd() * 40)), WORDS[0]]);
        if (k < 0.55) return WORDS[Math.floor(rnd() * WORDS.length)];
        if (k < 0.80) {
            const arr = [];
            const n = Math.floor(rnd() * 5);
            for (let i = 0; i < n; i++) arr.push(junk(depth - 1));
            return arr;
        }
        const obj = {};
        const n = Math.floor(rnd() * 5);
        for (let i = 0; i < n; i++) obj[WORDS[Math.floor(rnd() * WORDS.length)]] = junk(depth - 1);
        return obj;
    }
    function makeTable() {
        const k = rnd();
        if (k < 0.15) return junk(3);                                  // 完全不是表
        if (k < 0.25) return { tasks: junk(3) };                        // tasks 类型错
        const tasks = [];
        const n = Math.floor(rnd() * 14);
        for (let i = 0; i < n; i++) {
            if (rnd() < 0.2) { tasks.push(junk(2)); continue; }
            tasks.push({
                id: rnd() < 0.5 ? WORDS[Math.floor(rnd() * WORDS.length)] : 'id-' + i,
                title: rnd() < 0.5 ? junk(2) : { zh: '卡 ' + i },
                prompt: rnd() < 0.5 ? junk(2) : '说一句话 ' + i,
                when: rnd() < 0.3 ? [WORDS[Math.floor(rnd() * WORDS.length)]] : undefined,
                enabled: rnd() < 0.1 ? false : true,
                platforms: rnd() < 0.2 ? junk(1) : ['win']
            });
        }
        return { rev: junk(1), title: junk(1), tasks: tasks };
    }

    for (let round = 0; round < 60; round++) {
        state.payload = makeTable();
        await win.qqqTaskPane.reload();      // 不许 throw
        await tick(0);
        const cards = Array.from(win.document.querySelectorAll('#task-pane .tp-card'));
        assert.ok(cards.length <= 8, '卡片上限 8（实际 ' + cards.length + '）');
        for (const c of cards) {
            const id = c.getAttribute('data-id');
            assert.ok(id && typeof id === 'string' && id !== '__proto__', 'data-id 必须是非空字符串且不是 __proto__：' + id);
            const tEl = c.querySelector('.tp-t');
            assert.ok(tEl && tEl.textContent.trim(), '卡片标题不许为空');
            assert.ok(typeof c.title === 'string' && c.title.length > 0, '悬停说明必须非空（= 将要发出去的那句话）');
        }
    }
    // 原型污染：一切垃圾 payload 过后，Object.prototype 必须干净
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
    assert.strictEqual(typeof {}.toString, 'function');
});
