// ci/tests/floor-identity.test.js — 楼层编号身份回归守卫（2026-11-24 q478 f44 实锤「新楼层盖进旧楼层」）。
// 事故链（真机）：纯图片消息标题为空 → 目录名 = 裸 f44（无点）→ 旧扫描正则 /^f(\d+)\./ 对裸目录隐形 →
//   磁盘最大号算成 43 → 计数器回落 → 44 号二次分配 → 按名比对又漏判 → startBuildingFloor 复用 44 楼 AI 区，
//   且「完结密封」把新楼层 all.json 一并挡死。
// 本测试在真实文件系统上跑 quest-store（vm 里加载，桥用 node fs），守四条结构不变量：
//   ① 编号基线 = max(floor_counter, floor_hwm, 磁盘最大号)+1 —— 裸 f44 目录同样占号
//   ② floor_hwm 只增不减 —— 顶层目录被删也不回落（回落 = 同号二次分配）
//   ③ 目录名唯一入口 makeName —— 空标题 = 裸名，与编号解析唯一入口配套
//   ④ 写盘前目录复核 —— 目录已不在时如实拒写，绝不让 recursive mkdir 复活幽灵目录
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server-app', 'ai-panel', 'quest-store.js'), 'utf8');

// ── 沙箱：window.parent 桥用 node fs 落地；sq3 用内存 Map ──
function makeBridge() {
    const kv = new Map();
    return {
        kv,
        async get(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; },
        async setNow(k, v) { kv.set(k, JSON.stringify(v)); },
        async del(k) { kv.delete(k); },
        async atomicIncr(k) {
            const cur = kv.has(k) ? JSON.parse(kv.get(k)) : 0;
            const next = (typeof cur === 'number' ? cur : 0) + 1;
            kv.set(k, JSON.stringify(next));
            return next;
        }
    };
}
function makeFsApi() {
    return {
        async list(p) {
            try {
                const names = await fs.promises.readdir(p, { withFileTypes: true });
                const out = [];
                for (const d of names) {
                    const st = await fs.promises.stat(path.join(p, d.name)).catch(() => null);
                    out.push({ name: d.name, isDir: d.isDirectory(), mtimeMs: st ? st.mtimeMs : 0, size: st ? st.size : 0 });
                }
                return out;
            } catch (_) { return []; }   // 与壳层 fs:list 同语义（出错返空）
        },
        async stat(p) {
            try {
                const st = await fs.promises.stat(p);
                return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory(), isFile: st.isFile() };
            } catch (_) { return null; }
        },
        async read(p) { try { return await fs.promises.readFile(p, 'utf8'); } catch (_) { return null; } },
        async write(p, c) { await fs.promises.mkdir(path.dirname(p), { recursive: true }); await fs.promises.writeFile(p, c, 'utf8'); return true; },
        async mkdir(p) { await fs.promises.mkdir(p, { recursive: true }); return true; },
        async mkdirExclusive(p) {
            try { await fs.promises.mkdir(p); return { ok: true }; }
            catch (e) { return { ok: false, code: (e && e.code) || 'EFAIL' }; }
        },
        async rename(a, b) { await fs.promises.rename(a, b); return true; },
        async remove(p) { await fs.promises.rm(p, { recursive: true, force: true }); return true; }
    };
}
function loadStore(root) {
    const bridge = makeBridge();
    const fsApi = makeFsApi();
    const parentObj = { qqqideBridge: { fs: fsApi }, qgs: { project: () => bridge } };
    const sandbox = {
        window: { parent: parentObj },
        parent: parentObj,
        location: { search: '' },
        console: { log() { }, warn() { }, error() { } },
        TextEncoder, TextDecoder, JSON, Math, Date, Promise, setTimeout, clearTimeout,
        __root: root
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'quest-store.js' });
    const store = new sandbox.QuestStore();
    store.setProjectRoot(root);
    return { store, bridge, fsApi, sandbox };
}
function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'qd-floorid-'));
}
async function mkdirp(p) { await fs.promises.mkdir(p, { recursive: true }); }

test('目录名唯一入口 makeName：空标题 = 裸名，换行被消毒（与编号解析入口配套）', async () => {
    const root = tmpRoot();
    const { store } = loadStore(root);
    assert.strictEqual(store.makeName('f', 44, ''), 'f44');
    assert.strictEqual(store.makeName('f', 44, null), 'f44');
    assert.strictEqual(store.makeName('q', 49, '  '), 'q49');
    assert.strictEqual(store.makeName('f', 7, 'a\nb'), 'f7.ab');       // 控制字符直接删（非换空格）
    assert.strictEqual(store.makeName('f', 7, 'a/b:c'), 'f7.a_b_c');   // 非法字符 → _
    fs.rmSync(root, { recursive: true, force: true });
});

test('裸 f44 目录占号：计数器 43 + 磁盘裸 f44 → 下一个号恒 45（绝不二次分配 44）', async () => {
    const root = tmpRoot();
    const { store, bridge } = loadStore(root);
    const qdir = path.join(root, '_qqq', 'quests', 'q2.测试');
    await mkdirp(path.join(qdir, 'f44'));                       // 裸目录（无点、无标题）
    await fs.promises.writeFile(path.join(qdir, 'f44', 'all.json'), '{}', 'utf8');
    await bridge.setNow('floor_counter.q2', 43);
    assert.strictEqual(await store.nextFloorNum('q2'), 45, '裸目录必须算进磁盘最大号');
    fs.rmSync(root, { recursive: true, force: true });
});

test('floor_hwm 只增不减：顶层目录被删后编号不回落（禁复用已分配号）', async () => {
    const root = tmpRoot();
    const { store, bridge } = loadStore(root);
    const qdir = path.join(root, '_qqq', 'quests', 'q3.测试');
    await mkdirp(path.join(qdir, 'f1.一'));
    await mkdirp(path.join(qdir, 'f2.二'));
    await bridge.setNow('floor_counter.q3', 2);
    await bridge.setNow('floor_hwm.q3', 2);
    await fs.promises.rm(path.join(qdir, 'f2.二'), { recursive: true, force: true });   // 用户删掉顶层
    assert.strictEqual(await store.nextFloorNum('q3'), 3, '顶层目录消失也绝不回落（回落 = 同号二次分配）');
    fs.rmSync(root, { recursive: true, force: true });
});

test('materializeFloor：独占建目录，序号连发不撞、目录名与标题一致', async () => {
    const root = tmpRoot();
    const { store } = loadStore(root);
    await store.create('测试任务');
    const a = await store.materializeFloor('q1', '第一层问题');
    const b = await store.materializeFloor('q1', '');
    assert.strictEqual(a.floorNum, 1);
    assert.strictEqual(b.floorNum, 2);
    assert.ok(fs.existsSync(a.fDir) && fs.existsSync(b.fDir), '两层目录必须都在磁盘上');
    assert.strictEqual(path.basename(a.fDir.replace(/\/$/, '')), 'f1.第一层问题');
    assert.strictEqual(path.basename(b.fDir.replace(/\/$/, '')), 'f2');     // 空标题 = 裸名
    fs.rmSync(root, { recursive: true, force: true });
});

test('materializeFloor：磁盘已被外部占号 → 跳号（EEXIST 绝不复用别人的目录）', async () => {
    const root = tmpRoot();
    const { store, bridge } = loadStore(root);
    await store.create('测试任务');
    const qdir = path.join(root, '_qqq', 'quests', 'q1.测试任务');
    await mkdirp(path.join(qdir, 'f1.外部'));                  // 外部已建（清单看不到的路径）
    await bridge.setNow('floor_counter.q1', 0);
    const r = await store.materializeFloor('q1', '外部');
    assert.ok(r.floorNum >= 2, '已存在目录的号绝不复用（得到 f' + r.floorNum + '）');
    assert.strictEqual(fs.readdirSync(path.join(qdir, 'f1.外部')).length, 0, '外部目录不得被写入');
    fs.rmSync(root, { recursive: true, force: true });
});

test('写盘复核：楼层目录已被删 → 如实拒写，绝不 mkdir 复活幽灵目录', async () => {
    const root = tmpRoot();
    const { store } = loadStore(root);
    await store.create('测试任务');
    const r = await store.materializeFloor('q1', '第一层');
    await store.saveFloor('q1', r.floorNum, { question: '第一层', _fDir: r.fDir, conversation: [] });
    assert.ok(fs.existsSync(path.join(r.fDir, 'all.json')), '正常路径必须落盘');
    await fs.promises.rm(r.fDir, { recursive: true, force: true });      // 用户/Roam 删掉整层
    await store.saveFloor('q1', r.floorNum, { question: '第一层', _fDir: r.fDir, conversation: [] });
    assert.strictEqual(fs.existsSync(r.fDir), false, '已删楼层绝不被写盘复活（幽灵目录）');
    fs.rmSync(root, { recursive: true, force: true });
});

