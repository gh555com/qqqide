// ci/tests/task-ops.test.js — 一键任务动作端（shell/task-ops.ts）真机回归守卫。
// 重点：桌面目录必须读系统真值（客户把桌面重定向到 D 盘/OneDrive 是常态），
//   .lnk 真能落盘，安装目录阶梯与白名单拒结不出岔子。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ops = require(path.join(__dirname, '.build', 'task-ops.cjs'));
const IS_WIN = process.platform === 'win32';

function tmpDir(tag) {
    const d = path.join(os.tmpdir(), 'qd-test-' + tag + '-' + Date.now().toString(36));
    fs.mkdirSync(d, { recursive: true });
    return d;
}

test('task-ops: 桌面目录走系统真值（不拼 homedir/Desktop）', { skip: !IS_WIN }, () => {
    const d = ops.resolveDesktopDirSync();
    assert.ok(d && path.isAbsolute(d), '桌面目录必须是绝对路径：' + d);
    assert.ok(fs.existsSync(d), '系统真值目录必须真实存在：' + d);
    // 注册表 / Known Folder 真值口径：与 PowerShell 现查结果逐字一致
    const { execFileSync } = require('child_process');
    const ps = execFileSync('powershell', ['-NoProfile', '-Command',
        "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' }).trim();
    if (ps) assert.strictEqual(path.resolve(d).toLowerCase(), path.resolve(ps).toLowerCase());
});

test('task-ops: 桌面外接目录（模拟 D:\\Desktop 重定向）也能建出 .lnk', { skip: !IS_WIN }, (t) => {
    const dir = tmpDir('lnk');
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
    const exe = path.join(dir, "it's a target.exe");     // 含单引号路径 = PS 转义回归
    fs.writeFileSync(exe, 'x');
    const lnk = path.join(dir, 'Everything.lnk');
    const r = ops.createShortcuts([{ lnk: lnk, target: exe, workDir: dir, icon: exe + ',0', desc: '测试' }]);
    assert.strictEqual(r.ok, true, '建 .lnk 失败：' + (r.error || ''));
    assert.ok(fs.existsSync(lnk), '.lnk 必须真实落盘');
    assert.ok(fs.statSync(lnk).size > 0, '.lnk 不能是空文件');
});

test('task-ops: 桌面候选目录 = 真值桌面打头（禁止只剩 homedir 拼法）', { skip: !IS_WIN }, () => {
    const dirs = ops.desktopDirsForShortcut();
    assert.ok(dirs.length >= 1, '至少要有真值桌面');
    assert.strictEqual(path.resolve(dirs[0]).toLowerCase(), path.resolve(ops.resolveDesktopDirSync()).toLowerCase());
});

test('task-ops: 桌面候选目录必含 C 盘用户桌面（桌面搬到 D 盘也要有底）', { skip: !IS_WIN }, () => {
    const dirs = ops.desktopDirsForShortcut();
    const home = path.join(os.homedir(), 'Desktop');
    assert.ok(dirs.some(d => path.resolve(d).toLowerCase() === path.resolve(home).toLowerCase()),
        'C 盘用户目录桌面必须在清单里：' + JSON.stringify(dirs));
    const keys = dirs.map(d => path.resolve(d).toLowerCase());
    assert.strictEqual(new Set(keys).size, keys.length, '候选目录必须去重：' + JSON.stringify(dirs));
});

test('task-ops: 启动器目录 = 包根（打包态 root 是 <包根>/gh555.com，里面也有 joker.exe）', (t) => {
    const pkg = tmpDir('pkg');
    t.after(() => { try { fs.rmSync(pkg, { recursive: true, force: true }); } catch { /* 忽略 */ } });
    const data = path.join(pkg, 'gh555.com');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'qqqide.exe'), 'x');
    fs.writeFileSync(path.join(data, 'joker.exe'), 'x');
    assert.strictEqual(path.resolve(ops.__test.launcherDirFor(data)).toLowerCase(), path.resolve(pkg).toLowerCase(),
        '有 qqqide.exe 的包根才是启动器目录（返回 Data 目录 = program 层恒不命中）');
    assert.strictEqual(ops.__test.launcherDirFor(path.join(pkg, 'empty')), '', '什么都没有 → 空串');
});

test('task-ops: 批量建 .lnk（单次 PowerShell；多目标逐个回读真实落盘）', { skip: !IS_WIN }, (t) => {
    const root = tmpDir('lnks');
    t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ } });
    const exe = path.join(root, 'target.exe');
    fs.writeFileSync(exe, 'x');
    const a = path.join(root, 'desk-a');
    const b = path.join(root, "desk b's");      // 含空格与单引号 = PS 转义回归
    const r = ops.createShortcuts([
        { lnk: path.join(a, 'X.lnk'), target: exe, workDir: root, icon: exe + ',0', desc: 'A' },
        { lnk: path.join(b, 'X.lnk'), target: exe, workDir: root, icon: exe + ',0', desc: 'B' }
    ]);
    assert.strictEqual(r.ok, true, '批量建 .lnk 失败：' + (r.error || ''));
    assert.strictEqual(r.made.length, 2, '两条都应真实落盘：' + JSON.stringify(r.made));
    r.made.forEach(p => assert.ok(fs.existsSync(p) && fs.statSync(p).size > 0, '.lnk 不能是空文件：' + p));
});

function registerFake() {
    const handlers = {};
    // 注入式假 ipc（esbuild 已把真 electron stub 打进 bundle，改 require 缓存无效）
    ops.registerTaskOpsIpc(tmpDir('root'), tmpDir('ud'), {
        handle: (ch, fn) => { handlers[ch] = fn; }
    });
    return handlers;
}

test('task-ops: 未知任务 id 一律拒（服务器永不能下发可执行内容）', async () => {
    const handlers = registerFake();
    assert.ok(handlers['qqqide:task:run'], '必须注册 run 通道');
    const bad = await handlers['qqqide:task:run'](null, 'format_c_drive', {});
    assert.strictEqual(bad.ok, false);
    assert.match(bad.message, /未知任务/);
});

test('task-ops: probe 回真值（平台/桌面/安装目录）', async () => {
    const handlers = registerFake();
    const p = await handlers['qqqide:task:probe'](null);
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.platform, process.platform);
    assert.ok(p.desktop, 'probe 必须给出桌面真值');
    if (IS_WIN) assert.ok(Array.isArray(p.desktopDirs) && p.desktopDirs.length >= 1, 'probe 必须给出桌面快捷方式目录清单');
    if (IS_WIN) assert.ok(/everything$/.test(p.installDir.replace(/\\/g, '/')) || p.installDir === '');
    assert.strictEqual(p.autostart, undefined, '开机自启已移出壳层，probe 不得再报');
});

test('task-ops: 装 Everything 资源链（下载 → sha256 → 解压）', async (t) => {
    const dir = tmpDir('ev');
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
    const zip = path.join(dir, 'ev.zip');
    const dl = await ops.__test.download(ops.__test.everything.url, zip, 'test-everything');
    assert.strictEqual(dl.ok, true, '下载失败：' + (dl.error || ''));
    assert.strictEqual(dl.size, ops.__test.everything.size, '包大小与锁定值不符');
    assert.strictEqual(dl.sha, ops.__test.everything.sha256, 'sha256 与锁定值不符（包被換过？）');
    const out = path.join(dir, 'out');
    const ex = ops.__test.extractZip(zip, out);
    assert.strictEqual(ex.ok, true, '解压失败：' + (ex.error || ''));
    assert.ok(fs.existsSync(path.join(out, 'Everything.exe')), '解压产物缺 Everything.exe');
    assert.ok(fs.existsSync(path.join(out, 'Everything.ini')), '解压产物缺预设 ini（显示层预设随包）');
});

test('task-ops: 已移出壳层的动作一律拒（清 C 盘 / 开机自启 / E-Flow 归 AI + capabilities）', async () => {
    const handlers = registerFake();
    for (const id of ['clean_c', 'autostart_qd', 'eflow_upgrade']) {
        const r = await handlers['qqqide:task:run'](null, id, {});
        assert.strictEqual(r.ok, false, id + ' 不得再被执行');
        assert.match(r.message, /未知任务/);
    }
});

test('task-ops: 单飞登记不残留（未知动作不占登记表）', async () => {
    const handlers = registerFake();
    await handlers['qqqide:task:run'](null, 'clean_c', {});
    const again = await handlers['qqqide:task:run'](null, 'clean_c', {});
    assert.ok(!/正在执行中/.test(again.message), '未知动作不得残留单飞登记');
});
