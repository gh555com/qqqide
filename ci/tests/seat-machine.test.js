// ci/tests/seat-machine.test.js — 首启落座机器（core/workspace-seat.js）回归守卫。
// 机器是浏览器 IIFE（挂 window.qqqideSeat），这里用 vm + 内存盘/共享账本模拟「同机多窗口多实例」。
// 不变量：一机一基地（az 常量名，构造上无第二候选）· 冲突≠新建 · 账本钉死路径 · 落座机器永不删目录。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server-app', 'core', 'workspace-seat.js'), 'utf8');
const BIG = 500 * 1024 * 1024 * 1024;

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const parentOf = (p) => { const s = norm(p); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i) : ''; };

// ── 一台「机器」：磁盘 + 账本 + 项目锁，可开多个窗口（各自视图/锁归属）──
function makeMachine(opts) {
    const o = Object.assign({ drives: ['C:\\', 'D:\\'], home: 'C:/Users/u', small: false, platform: 'win32' }, opts);
    const dirs = new Set(['C:', 'D:', 'E:', 'C:/Users/u']);
    const files = new Set();
    const locks = new Map();          // folder → winId
    const ledger = { seat: o.ledger || null };

    function childrenOf(p) {
        const base = norm(p) + '/';
        const out = [];
        for (const d of dirs) if (d.startsWith(base) && !d.slice(base.length).includes('/')) out.push({ name: d.slice(base.length), isDir: true });
        for (const f of files) if (f.startsWith(base) && !f.slice(base.length).includes('/')) out.push({ name: f.slice(base.length), isDir: false });
        return out;
    }
    const free = () => (o.small ? { D: { free: 100 * 1024 * 1024 }, E: { free: 200 * 1024 * 1024 }, C: { free: 100 * 1024 * 1024 } }
        : { D: { free: BIG }, E: { free: BIG }, C: { free: BIG } });

    const machine = { dirs, files, locks, ledger };
    machine.addDir = (p) => { let cur = norm(p); const chain = []; while (cur && !dirs.has(cur)) { chain.push(cur); cur = parentOf(cur); } chain.forEach((d) => dirs.add(d)); };
    machine.addFile = (p) => files.add(norm(p));
    machine.has = (p) => dirs.has(norm(p));

    machine.window = function (winId) {
        const view = { main: null };
        const bridge = {
            fs: {
                drives: () => Promise.resolve(o.drives),
                diskFree: () => Promise.resolve(free()),
                mkdirExclusive: (p) => {
                    p = norm(p);
                    if (!dirs.has(parentOf(p))) return Promise.resolve({ ok: false, code: 'ENOENT' });
                    if (dirs.has(p) || files.has(p)) return Promise.resolve({ ok: false, code: 'EEXIST' });
                    dirs.add(p);
                    return Promise.resolve({ ok: true });
                },
                mkdir: (p) => { p = norm(p); const chain = []; let cur = p; while (cur && !dirs.has(cur)) { chain.push(cur); cur = parentOf(cur); } chain.reverse().forEach((d) => dirs.add(d)); return Promise.resolve(true); },
                list: (p) => (dirs.has(norm(p)) ? Promise.resolve(childrenOf(p)) : Promise.reject(new Error('ENOENT'))),
                stat: (p) => Promise.resolve(dirs.has(norm(p)) ? { isDir: true, isFile: false } : (files.has(norm(p)) ? { isDir: false, isFile: true } : null)),
                exists: (p) => Promise.resolve(dirs.has(norm(p)) || files.has(norm(p))),
            },
            wsState: {
                get: (k) => Promise.resolve(ledger[k] ? JSON.parse(JSON.stringify(ledger[k])) : null),
                set: (k, v) => { ledger[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(true); },
            },
            projectLock: {
                query: (p) => { const cur = locks.get(norm(p)); return Promise.resolve({ locked: !!cur, self: cur === winId }); },
                claim: (p) => {
                    p = norm(p);
                    const cur = locks.get(p);
                    if (!cur || cur === winId) { locks.set(p, winId); return Promise.resolve({ ok: true }); }
                    return Promise.resolve({ ok: false, reason: 'same-instance-other-window' });
                },
                release: (p) => { if (locks.get(norm(p)) === winId) locks.delete(norm(p)); return Promise.resolve({ ok: true }); },
            },
            roam: { get: () => Promise.resolve([]), set: () => Promise.resolve(true) },
            boot: { getInfo: () => Promise.resolve({ platform: o.platform, homedir: o.home, appRoot: 'C:/app' }) },
        };
        const progRoot = norm(o.appRoot || 'C:/app');
        const viewport = {
            getMainProject: () => (view.main ? { path: view.main } : null),
            addProject: (p) => { view.main = norm(p); },
            // 与真实唯一谓词同语义：盘根 / 程序域互斥
            classifyProjectPath: (p) => {
                const s = norm(p);
                if (/^[A-Za-z]:$/.test(s) || s === '/') return Promise.resolve({ ok: false, code: 'root' });
                const a = s.toLowerCase();
                const b = progRoot.toLowerCase();
                if (a === b || a.indexOf(b + '/') === 0 || b.indexOf(a + '/') === 0) return Promise.resolve({ ok: false, code: 'program' });
                return Promise.resolve({ ok: true });
            },
        };
        const win = {
            qqqideBridge: bridge,
            qqqideViewport: viewport,
            qqqBootInfo: { platform: o.platform, homedir: o.home, appRoot: 'C:/app' },
            _i: (_k, fallback) => fallback,
        };
        win.window = win;
        const sandbox = { window: win, console, setTimeout, clearTimeout, Promise, Date, JSON, RegExp, String, Number, Array, Object };
        vm.createContext(sandbox);
        vm.runInContext(SRC, sandbox);
        return { seat: win.qqqideSeat, close: () => { if (view.main) locks.delete(norm(view.main)); } };
    };
    return machine;
}

test('首启：唯一一次铸造 az/proj1，账本落 seated，且不存在第二个基地', async () => {
    const m = makeMachine();
    const a = m.window(1);
    const r = await a.seat.run();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.proj, 'D:/az/proj1');
    assert.strictEqual(m.ledger.seat.state, 'seated');
    assert.strictEqual(m.ledger.seat.base, 'D:/az');
    assert.ok(!m.has('D:/az2'));
    assert.ok(!m.has('C:/Users/u/az'));
    // 幂等：再跑一次零变化
    const r2 = await a.seat.run();
    assert.strictEqual(r2.code, 'already');
});

test('多窗口：基地内取最小空闲叶子（占着 proj1 → proj2），空号回收复用', async () => {
    const m = makeMachine();
    const a = m.window(1);
    await a.seat.run();
    const b = m.window(2);
    const rb = await b.seat.run();
    assert.strictEqual(rb.proj, 'D:/az/proj2');
    assert.ok(!m.has('D:/az2'), '第二窗口绝不允许产生第二个基地');
    const c = m.window(3);
    assert.strictEqual((await c.seat.run()).proj, 'D:/az/proj3');
    a.close();                                    // 窗1 关掉 → proj1 空出
    const d = m.window(4);
    assert.strictEqual((await d.seat.run()).proj, 'D:/az/proj1', '空号必须复用，编号不膨胀');
});

test('账本丢失：先认已存在的基地（不新铸），probe 命中原路径', async () => {
    const m = makeMachine();
    const a = m.window(1);
    await a.seat.run();
    a.close();
    m.ledger.seat = null;
    const b = m.window(2);
    const r = await b.seat.run();
    assert.strictEqual(r.code, 'probe');
    assert.strictEqual(r.base, 'D:/az');
    assert.strictEqual(r.proj, 'D:/az/proj1');
    assert.ok(!m.has('C:/Users/u/az'), '账本丢了也不许在家目录再铸一个');
});

test('账本基地不可达（盘拔了）→ ask，绝不换盘新铸', async () => {
    const m = makeMachine({ ledger: { v: 1, state: 'seated', base: 'E:/az', leaf: 'E:/az/proj1', root: 'E:' } });
    m.dirs.delete('E:');
    const a = m.window(1);
    const r = await a.seat.run();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ask');
    assert.ok(!m.has('D:/az'));
});

test('账本在、基地被删但盘在 → 同路径重建（不是第二个基地）', async () => {
    const m = makeMachine({ ledger: { v: 1, state: 'seated', base: 'D:/az', leaf: 'D:/az/proj1', root: 'D:' } });
    const r = await m.window(1).seat.run();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.base, 'D:/az');
    assert.strictEqual(r.proj, 'D:/az/proj1');
});

test('铸造中途崩溃（state=minting 残留 / 空基地）→ 收敛到同一路径', async () => {
    const m1 = makeMachine({ ledger: { v: 1, state: 'minting', base: 'D:/az', leaf: '', root: 'D:' } });
    m1.addDir('D:/az');
    assert.strictEqual((await m1.window(1).seat.run()).proj, 'D:/az/proj1');

    const m2 = makeMachine({ ledger: { v: 1, state: 'seated', base: 'D:/az', leaf: 'D:/az/proj1', root: 'D:' } });
    m2.addDir('D:/az');
    assert.strictEqual((await m2.window(1).seat.run()).proj, 'D:/az/proj1');
});

test('他人的 az（含非 proj 内容）绝不碰；我们遗留的 projN 照常认领', async () => {
    const foreign = makeMachine();
    foreign.addDir('D:/az');
    foreign.addFile('D:/az/mywork.txt');
    const r1 = await foreign.window(1).seat.run();
    assert.strictEqual(r1.ok, true);
    assert.notStrictEqual(r1.base, 'D:/az', '别人的 az 一个字节都不许写');

    const ours = makeMachine();
    ours.addDir('D:/az/proj1');
    ours.addFile('D:/az/proj1/a.txt');
    const r2 = await ours.window(1).seat.run();
    assert.strictEqual(r2.code, 'probe');
    assert.strictEqual(r2.proj, 'D:/az/proj1');
});

test('并发首启（两实例同时）：一个基地 / 两个不同叶子', async () => {
    const m = makeMachine();
    const a = m.window(1);
    const b = m.window(2);
    const [ra, rb] = await Promise.all([a.seat.run(), b.seat.run()]);
    assert.strictEqual(ra.base, 'D:/az');
    assert.strictEqual(rb.base, 'D:/az');
    assert.notStrictEqual(ra.proj, rb.proj);
    assert.ok(!m.has('D:/az2'));
});

test('落点：单盘/小盘 → 用户主目录；mac 只走家目录；同名是文件则跳过该号', async () => {
    assert.strictEqual((await makeMachine({ drives: ['C:\\'] }).window(1).seat.run()).base, 'C:/Users/u/az');
    assert.strictEqual((await makeMachine({ small: true }).window(1).seat.run()).base, 'C:/Users/u/az');

    const mac = makeMachine({ drives: ['/'], platform: 'darwin', home: '/Users/u' });
    mac.addDir('/Users/u');
    assert.strictEqual((await mac.window(1).seat.run()).base, '/Users/u/az');

    const m = makeMachine();
    m.addDir('D:/az');
    m.addFile('D:/az/proj1');            // 同名文件占号
    assert.strictEqual((await m.window(1).seat.run()).proj, 'D:/az/proj2');
});

test('叶子全被活锁占满 → blocked，且绝不再造第 N+1 个目录（永不删目录）', async () => {
    const m = makeMachine();
    m.addDir('D:/az');
    for (let i = 1; i <= 8; i++) m.locks.set('D:/az/proj' + i, 99);
    const r = await m.window(1).seat.run();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'blocked');
    assert.ok(!m.has('D:/az/proj9'));
});

test('程序域互斥：包解在盘根（基地会落进程序域）→ 换到可用的根', async () => {
    const m = makeMachine({ appRoot: 'D:' });      // 程序就在 D 盘根
    const r = await m.window(1).seat.run();
    assert.strictEqual(r.ok, true);
    assert.notStrictEqual(r.base, 'D:/az', '基地不得落在程序域内');
    assert.strictEqual(r.base, 'C:/Users/u/az');
});

test('baseHint：账本基地（即使基地目录被删，只要盘在）', async () => {
    const m = makeMachine({ ledger: { v: 1, state: 'seated', base: 'D:/az', leaf: 'D:/az/proj1', root: 'D:' } });
    assert.strictEqual(await m.window(1).seat.baseHint(), 'D:/az');
});
