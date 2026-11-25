// ci/tests/panel-tasks.test.js — 空白面板「一键任务」卡（ai-panel/panel-tasks.js）回归守卫。
// 语义：点 q2 加号 → ~New quest~ 空白区必须出现默认任务卡；任务表来自服务器，离线用出厂兜底；
//   ★ 点一张卡 = 替用户说一句话：走与「打字 + Enter」完全同一条发送管线（气泡 + 建第一楼 + AI 开工）。
//   卡片本身不得含任何可执行动作（旧 action 卡一律丢弃）。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server-app', 'ai-panel', 'panel-tasks.js'), 'utf8');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

const ONLINE = {
    rev: 3,
    title: { zh: '线上任务表' },
    subtitle: { zh: '来自服务器' },
    tasks: [
        { id: 'install-everything', kind: 'prompt', icon: 'search', platforms: ['win'], title: { zh: '装 Everything' }, desc: { zh: 'd1' }, prompt: '帮我装个 Everything' },
        { id: 'clean-c', kind: 'prompt', icon: 'trash', platforms: ['win'], title: { zh: '清理 C 盘' }, prompt: '帮我清清 C 盘' },
        { id: 'startup-clean', kind: 'prompt', icon: 'snow', title: { zh: '电脑卡顿' }, prompt: '我的电脑有点卡' },
        { id: 'no-prompt', kind: 'prompt', title: { zh: '没有提词的卡' } },
        { id: 'legacy-action', kind: 'action', action: 'clean_c', title: { zh: '旧版动作卡' } }
    ]
};

function harness(opts) {
    opts = opts || {};
    const dom = new JSDOM(
        '<!doctype html><html><body><div id="messages-wrap"><div id="messages"></div></div>' +
        '<textarea id="input"></textarea></body></html>',
        { url: 'https://qqq.test/', runScripts: 'outside-only', pretendToBeVisual: true }
    );
    const win = dom.window;
    // ★ jsdom 构造完 readyState 仍是 'loading'，模块会把 boot 挂在 DOMContentLoaded 上（真实触发时刻随机器浮动，
    //   实测首测可达 200ms）→ 固定 tick(40) 会随机扑空。钉成 'complete'：模块走同步 boot 分支，测试窗口恒定。
    Object.defineProperty(win.document, 'readyState', { configurable: true, get: function () { return 'complete'; } });
    win.qqqBootInfo = { platform: opts.platform || 'win32', arch: opts.arch || 'x64' };
    // ★ 卡片不再直接调壳层：桥只要存在即可（真跑在对话里，走 run_task 工具）
    win.qqqideBridge = { tasks: { run: function () { win.__ran = true; return Promise.resolve({ ok: true }); }, onProgress: function () { return function () { }; } } };
    win.qqqideQoast = { show: function (m) { (win.__toasts = win.__toasts || []).push(m); } };
    win.questActiveId = opts.questId === undefined ? 'draft_p1' : opts.questId;
    win._isDraft = opts.isDraft || function (id) { return /^draft_/.test(String(id)); };
    win._switching = false;
    win.cardPool = { getActive: function () { return opts.activeCard || null; } };
    win.__sent = 0;
    win._gateBeforeSend = function () { return opts.gate !== false; };
    win._freezeAndSendFromInput = function () { win.__sent++; };
    win.fetch = function (url) {
        if (opts.fetchFail) return Promise.reject(new Error('offline'));
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(opts.payload || ONLINE); } });
    };
    if (opts.questStore) win.questStore = opts.questStore;      // 条件卡判定输入（必须在 boot 前就位）
    if (opts.ExpertFlow) win.ExpertFlow = opts.ExpertFlow;
    // 语言包替身（真实现是 ai-panel/index.html 的 window._qq → parent.i18n.t；未命中的键回退 fb）
    if (opts.tr) win._qq = function (k, fb) { return Object.prototype.hasOwnProperty.call(opts.tr, k) ? opts.tr[k] : fb; };
    win.eval(SRC);
    return { dom: dom, win: win };
}

function cards(win) {
    return Array.from(win.document.querySelectorAll('#task-pane .tp-card'));
}
function titles(win) {
    return cards(win).map(function (c) { return c.querySelector('.tp-t').textContent; });
}
function pane(win) { return win.document.getElementById('task-pane'); }

test('tasks: 线上任务表渲染（无提词 / 旧版 action 卡整条丢弃）', async (t) => {
    const { dom, win } = harness({});
    t.after(() => dom.window.close());   // ★ 必关（模块带 30min 刷新定时器，漏关 = node --test 永久挂起）
    await tick(40);
    assert.ok(pane(win), '空白面板必须出现任务面板');
    assert.deepStrictEqual(titles(win), ['装 Everything', '清理 C 盘', '电脑卡顿'],
        '没有 prompt 的卡（含旧版 action 卡）必须丢弃——点了没话说的卡不显示');
    assert.strictEqual(win.document.querySelector('#task-pane .tp-title').textContent, '线上任务表');
    assert.strictEqual(win.document.querySelectorAll('#task-pane .tp-sub').length, 0,
        '副标题已删除（服务端还发 subtitle 也不采纳）');
    dom.window.close();
});

test('tasks: 平台过滤（mac 只剩跨平台卡）', async (t) => {
    const { dom, win } = harness({ platform: 'darwin', arch: 'arm64' });
    t.after(() => dom.window.close());
    await tick(40);
    assert.deepStrictEqual(titles(win), ['电脑卡顿']);
    dom.window.close();
});

test('tasks: 卡片只显标题；悬停说明 = 将要发出去的那句话', async (t) => {
    const { dom, win } = harness({});
    t.after(() => dom.window.close());
    await tick(40);
    assert.strictEqual(win.document.querySelectorAll('#task-pane .tp-d').length, 0, '卡片里不得再有描述行');
    assert.strictEqual(cards(win)[0].title, '帮我装个 Everything',
        '悬停说明必须恒等于将要发出去的那句话（服务端 desc=d1 一律不采纳）');
    dom.window.close();
});

test('tasks: 平台自带搜索（mac → Spotlight 搜索 / linux → locate 文件搜索）', async (t) => {
    for (const [plat, want, id] of [['darwin', 'Spotlight 搜索', 'spotlight-search'], ['linux', 'locate 文件搜索', 'locate-search']]) {
        const { dom, win } = harness({ fetchFail: true, platform: plat });
        await tick(40);
        assert.ok(titles(win).indexOf(want) >= 0, plat + ' 必须出「' + want + '」卡（实际 ' + JSON.stringify(titles(win)) + '）');
        assert.strictEqual(cards(win).filter(c => c.querySelector('.tp-t').textContent === want)[0].getAttribute('data-id'), id);
        dom.window.close();
    }
});

test('tasks: 线路全挂 → 出厂兜底 5 张卡（清理 / 自启 / 文档地基 / Everything / 卡顿）', async (t) => {
    const { dom, win } = harness({ fetchFail: true });
    t.after(() => dom.window.close());
    await tick(40);
    const ids = cards(win).map(function (c) { return c.getAttribute('data-id'); });
    assert.deepStrictEqual(ids, ['clean-c', 'autostart-qd', 'eflow-adopt', 'install-everything', 'startup-clean']);
    assert.deepStrictEqual(titles(win), ['清理 C 盘', 'qd 开机自启', 'E-Flow', '装 Everything', '电脑卡顿？'],
        '兜底标题必须与下发台 DEFAULT_TASKS 逐字一致');
    // ★ 暗号卡：发出去的就是那一句话（多一个字都会让 AI 判成「项目级接入」）
    assert.strictEqual(cards(win)[2].title, '一切项目接入 E-Flow',
        'E-Flow 卡的提词（= 悬停说明）必须就是暗号本身');
    dom.window.close();
});

test('tasks: 暗号卡也跟界面语言（非中文用户不许冒出中文气泡）', async (t) => {
    const { dom, win } = harness({
        fetchFail: true,
        tr: { 'ai.tasks.promptEflowAdopt': 'Alle Projekte an E-Flow anbinden' }
    });
    t.after(() => dom.window.close());
    await tick(40);
    const card = cards(win).filter(function (c) { return c.getAttribute('data-id') === 'eflow-adopt'; })[0];
    assert.ok(card, '暗号卡必须存在');
    assert.strictEqual(card.title, 'Alle Projekte an E-Flow anbinden',
        '提词（= 将发出去的用户气泡）必须吃译文；品牌词 E-Flow 必须保留');
    card.dispatchEvent(win.Event ? new win.Event('click', { bubbles: true }) : (function () { var e = win.document.createEvent('MouseEvents'); e.initEvent('click', true, true); return e; })());
    assert.strictEqual(win.document.getElementById('input').value, 'Alle Projekte an E-Flow anbinden',
        '点卡 = 把译文那句话填进编辑框（用户气泡原文）');
    assert.strictEqual(win.__sent, 1, '仍然走正常发送管线');
});

// ── 条件卡（when）：服务器只给条件名，判定在客户端本地 ─────────────────────────
function harnessWhen(state) {
    // ★ 必须在 eval 前就位：模块 boot 是同步的，boot 时读不到 ExpertFlow 会当场 fail-open 并把判定缓存进 _whenState
    return harness({
        fetchFail: true,
        questStore: { getProjectRoot: function () { return 'C:/proj'; } },
        ExpertFlow: { globalOn: function () { return Promise.resolve(!!state.globalOn); } }
    });
}

for (const [name, state, want] of [
    ['真能省钱（未接入 + 每轮 30000 字）', { globalOn: false }, true],
    ['已接入（无事可做）', { globalOn: true }, false],
]) {
    test('tasks: 条件卡 eflow.off —— ' + name + ' → ' + (want ? '出现' : '不出现'), async (t) => {
        const { dom, win } = harnessWhen(state);
        t.after(() => dom.window.close());
        await tick(80);
        const has = titles(win).indexOf('E-Flow') >= 0;
        assert.strictEqual(has, want, '实际卡片：' + JSON.stringify(titles(win)));
        dom.window.close();
    });
}

test('tasks: 无条件卡不受诊断影响（诊断失败也照旧出卡）', async (t) => {
    const { dom, win } = harness({ fetchFail: true });   // 无 fs / 无 EflowCore / 无 questStore → fail-open
    t.after(() => dom.window.close());
    await tick(60);
    assert.ok(titles(win).indexOf('清理 C 盘') >= 0);
    dom.window.close();
});

test('tasks: 有卡有内容（非空白）时不显示面板', async (t) => {
    const card = { dom: { style: { display: 'block' } }, _contentWrap: { childNodes: [1] } };
    const { dom, win } = harness({ activeCard: card });
    t.after(() => dom.window.close());
    await tick(40);
    assert.strictEqual(pane(win).style.display, 'none', '已有楼层的任务不得盖任务面板');
    dom.window.close();
});

test('tasks: 点卡 = 替用户说一句话（填编辑框 + 走唯一发送闸门 → 建第一楼）', async (t) => {
    const { dom, win } = harness({});
    t.after(() => dom.window.close());
    await tick(40);
    const card = cards(win).filter(function (c) { return c.getAttribute('data-id') === 'startup-clean'; })[0];
    card.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(win.document.getElementById('input').value, '我的电脑有点卡');
    assert.strictEqual(win.__sent, 1, '点卡必须直接走正常发送（= 用户打字 + Enter）');
    dom.window.close();
});

test('tasks: 每一张卡点击都只走对话（绝不直接调壳层动作）', async (t) => {
    const { dom, win } = harness({ fetchFail: true });
    t.after(() => dom.window.close());
    await tick(40);
    const ids = cards(win).map(function (c) { return c.getAttribute('data-id'); });
    assert.strictEqual(ids.length, 5);
    for (const c of cards(win)) {
        win.__sent = 0;
        win.document.getElementById('input').value = '';
        c.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        assert.ok(win.document.getElementById('input').value, '卡必须把一句话放进编辑框：' + c.getAttribute('data-id'));
        assert.strictEqual(win.__sent, 1, '卡必须走正常发送：' + c.getAttribute('data-id'));
    }
    assert.ok(!win.__ran, '卡片不得再自行执行壳层动作（干什么由对话里的 AI 决定）');
    dom.window.close();
});

test('tasks: 闸门拒绝（未登录等）→ 不发，提词留在编辑框', async (t) => {
    const { dom, win } = harness({ gate: false });
    t.after(() => dom.window.close());
    await tick(40);
    const card = cards(win).filter(function (c) { return c.getAttribute('data-id') === 'startup-clean'; })[0];
    card.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(win.__sent, 0);
    assert.strictEqual(win.document.getElementById('input').value, '我的电脑有点卡');
    dom.window.close();
});

test('tasks: 编辑框有内容时不覆盖（提示先发送或清空）', async (t) => {
    const { dom, win } = harness({});
    t.after(() => dom.window.close());
    await tick(40);
    const inp = win.document.getElementById('input');
    inp.value = '我正在打的东西';
    cards(win)[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(inp.value, '我正在打的东西', '用户草稿绝不能被卡片吃掉');
    assert.strictEqual(win.__sent, 0);
    dom.window.close();
});

test('tasks: 同名 id 去重 + 超量封顶（服务端脏数据不炸面板）', async (t) => {
    const many = [];
    for (let i = 0; i < 20; i++) many.push({ id: 'dup', kind: 'prompt', title: { zh: 'x' }, prompt: 'hello' });
    const { dom, win } = harness({ payload: { tasks: many } });
    t.after(() => dom.window.close());
    await tick(40);
    const n = win.document.querySelectorAll('#task-pane .tp-card').length;
    assert.ok(n <= 8, '卡片数量必须封顶（实际 ' + n + '）');
    assert.strictEqual(n, 1, '同 id 只保留一张');
    dom.window.close();
});

test('tasks: 出厂提词跟界面语言走（气泡 = 用户说的那句话的译文）', async (t) => {
    const de = { 'ai.tasks.promptCleanC': 'Bereinige Laufwerk C und liste zuerst alles auf, was weg kann.' };
    const { dom, win } = harness({ fetchFail: true, tr: de });
    t.after(() => dom.window.close());
    await tick(40);
    const card = cards(win).filter(function (c) { return c.getAttribute('data-id') === 'clean-c'; })[0];
    assert.strictEqual(card.title, de['ai.tasks.promptCleanC'], '悬停说明必须也是译文（说明 = 将要发出去的那句）');
    card.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(win.document.getElementById('input').value, de['ai.tasks.promptCleanC'],
        '非中文用户看到的中文气泡 = 谎报他说过什么；出厂提词必须走译文');
    dom.window.close();
});

test('tasks: 服务器改过的提词原样发出（译文永不盖下发）', async (t) => {
    const { dom, win } = harness({ tr: { 'ai.tasks.promptCleanC': 'SHOULD-NOT-WIN' } });   // 线上表 = ONLINE（提词不是出厂原句）
    t.after(() => dom.window.close());
    await tick(40);
    const card = cards(win).filter(function (c) { return c.getAttribute('data-id') === 'clean-c'; })[0];
    card.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(win.document.getElementById('input').value, '帮我清清 C 盘',
        '运营改过的提词必须逐字发出（改服务器即下发 > 译文）');
    dom.window.close();
});

test('tasks: 接管暗号卡恒中文（不分语言）', async (t) => {
    const { dom, win } = harness({ fetchFail: true, tr: { 'ai.tasks.promptCleanC': 'X', 'ai.tasks.promptEverything': 'Y' } });
    t.after(() => dom.window.close());
    await tick(40);
    const card = cards(win).filter(function (c) { return c.getAttribute('data-id') === 'eflow-adopt'; })[0];
    assert.strictEqual(card.title, '一切项目接入 E-Flow');
    card.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(win.document.getElementById('input').value, '一切项目接入 E-Flow',
        '暗号卡禁止翻译：整套接管契约就靠这一句 + 回复「1」');
    dom.window.close();
});
