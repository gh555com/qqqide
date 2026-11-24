// ci/tests/run-task.test.js — 「卡片里那件事由 AI 来做」的同源守卫。
// 语义：任务卡只把一句话送进对话；真正动手 = AI 调 run_task（壳层唯一动作 install_everything）
//   或按 capabilities 配方用 run_command 自己干（清 C 盘 / 开机自启 / 文件秒搜 / 关自启项）。
//   三处必须永远一致：① tools-defs 的工具枚举 ② tools-exec-task 的平台表 ③ shell/task-ops 的 ACTIONS。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ★ 壳层只背这一条（版本号 + 校验值 + 原子换入 + 多桌面快捷方式，AI 猜不出来也不该猜）
const TASKS = ['install_everything'];
// 这些曾经写进壳层，现改为 capabilities 配方 + run_command —— 永远不许回潮进壳层
const NOT_IN_SHELL = ['clean_c', 'autostart_qd', 'eflow_upgrade'];

test('run_task: 工具定义在册（枚举 = 壳层唯一动作）', () => {
    const src = read('server-app/ai-panel/tools-defs.js');
    assert.ok(/name:\s*'run_task'/.test(src), 'tools-defs 必须定义 run_task');
    const m = src.match(/name: 'run_task',[\s\S]*?enum: \[([^\]]*)\]/);
    assert.ok(m, 'run_task 必须有 enum');
    const ids = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.deepStrictEqual(ids, TASKS, '工具枚举必须与壳层 ACTIONS 完全一致');
    for (const t of NOT_IN_SHELL) {
        assert.ok(src.indexOf("'" + t + "'") < 0, 'tools-defs 不得再出现已移出壳层的动作：' + t);
    }
    assert.ok(/run_task:\s*'EFFECT'/.test(src), 'run_task 必须归 EFFECT 类（不进 READ 缓存）');
    assert.ok(/instead of hand-rolling the same job with run_command/.test(src),
        '工具说明必须禁止用 run_command 手搓同一件事');
});

test('run_task: 分发到 executeRunTask，且脚本先于 tools-exec.js 加载', () => {
    const exec = read('server-app/ai-panel/tools-exec.js');
    assert.ok(/case 'run_task':\s*_result = executeRunTask\(args\);/.test(exec), 'tools-exec 必须分派 run_task');
    const html = read('server-app/ai-panel/index.html');
    const a = html.indexOf('tools-exec-task.js');
    const b = html.indexOf('src="tools-exec.js"');
    assert.ok(a > 0 && b > 0 && a < b, 'tools-exec-task.js 必须在 tools-exec.js 之前加载');
});

test('run_task: 平台表 = 壳层白名单，非 Windows 如实拒绝', () => {
    const src = read('server-app/ai-panel/tools-exec-task.js');
    const m = src.match(/var RUN_TASK_PLATFORM = \{([\s\S]*?)\};/);
    assert.ok(m, '必须保留 RUN_TASK_PLATFORM');
    const ids = Array.from(m[1].matchAll(/([a-z_]+)\s*:/g)).map((x) => x[1]);
    assert.deepStrictEqual(ids, TASKS, '平台表必须与壳层 ACTIONS 完全一致');
    assert.ok(/only runs on Windows/.test(src), '非 Windows 必须如实拒结');
    // 未知任务必须指回 capabilities 配方（否则模型会以为「没这个任务 = 干不了」）
    assert.ok(/system-tasks\.md/.test(src), '未知任务必须提示走 capabilities/system-tasks.md 配方');
});

test('run_task: 壳层 ACTIONS 只背 install_everything（清 C 盘等永不回潮进壳层）', () => {
    const ts = read('shell/task-ops.ts');
    const m = ts.match(/const ACTIONS:[\s\S]*?\n\};/);
    assert.ok(m, 'shell/task-ops.ts 必须保留 ACTIONS 表');
    const ids = Array.from(m[0].matchAll(/^\s{4}([a-z_]+):/gm)).map((x) => x[1]).sort();
    assert.deepStrictEqual(ids, TASKS.slice().sort(), 'ACTIONS 与 run_task 枚举必须完全一致');
    for (const t of NOT_IN_SHELL) {
        assert.ok(ts.indexOf(t) < 0, '壳层不得再出现已移出的动作实现：' + t);
    }
});

test('run_task: 系统维护类知识在 capabilities（脚本 + 配方同包，probe 必须落地）', () => {
    const script = 'server-app/capabilities/scripts/clean-c.ps1';
    assert.ok(exists(script), '清 C 盘扫描器必须随包：' + script);
    const ps = read(script);
    assert.ok(/-Apply/.test(ps), '扫描器必须有 -Apply 开关（默认只扫描）');
    assert.ok(/ReparsePoint/.test(ps), '扫描器必须跳过 junction/符号链接');
    assert.ok(/MinAgeMin/.test(ps), '扫描器必须有最小文件年龄门槛');
    // 每个能力 md 的 probe 都必须真实存在（否则整段静默消失 = 模型什么都不知道）
    for (const md of ['server-app/capabilities/tasks.md', 'server-app/capabilities/system-tasks.md']) {
        const raw = read(md);
        const pm = /^\s*<!--@cap([\s\S]*?)-->/.exec(raw);
        assert.ok(pm, md + ' 必须带 <!--@cap ... --> 头');
        const probe = (/probe\s*:\s*(.+)/i.exec(pm[1]) || [])[1];
        assert.ok(probe, md + ' 必须声明 probe');
        // probe 相对载荷根（= server-app）解析——与 system-prompt.js 的 capRoot 同口径
        const p = probe.trim().replace(/^\/+/, '');
        const rel = p.indexOf('server-app/') === 0 ? p : 'server-app/' + p;
        assert.ok(exists(rel), md + ' 的 probe 不存在：' + probe.trim());
    }
    const sys = read('server-app/capabilities/system-tasks.md');
    assert.ok(/\{\{probe\}\}/.test(sys), '配方必须用 {{probe}} 指向扫描器真路径（禁硬编码盘符）');
    assert.ok(/-Apply/.test(sys), '配方必须写清「先扫描、用户点头才 -Apply」');
    for (const os of ['Startup', 'LaunchAgents', 'autostart']) {
        assert.ok(sys.indexOf(os) >= 0, '开机自启配方缺 ' + os);
    }
    const tips = read('server-app/capabilities/tasks.md');
    assert.ok(/install_everything/.test(tips), 'tasks.md 必须指向 run_task 的 Everything 动作');
    assert.ok(/E-Flow/.test(tips), 'tasks.md 必须写明 E-Flow 升级通道未上线时如实说明');
});

test('run_task: 出厂兜底卡全部带提词（点一张卡 = 说一句话）', () => {
    const src = read('server-app/ai-panel/panel-tasks.js');
    const m = src.match(/var TASK_FALLBACK = \{[\s\S]*?\n    \};/);
    assert.ok(m, '必须保留 TASK_FALLBACK');
    const blocks = m[0].split('id:').slice(1);
    assert.ok(blocks.length >= 5, '兜底卡至少 5 张（实际 ' + blocks.length + '）');
    for (const b of blocks) {
        assert.ok(/prompt:\s*'/.test(b), '每张兜底卡都必须有 prompt：' + b.slice(0, 40));
        assert.ok(!/kind:\s*'action'|action:\s*'/.test(b), '卡片不得再带壳层动作：' + b.slice(0, 40));
    }
});

test('run_task: 搜索类卡片把机器准备好，而不是「随便找个文件」', () => {
    const src = read('server-app/ai-panel/panel-tasks.js');
    // 提词必须说清目标（检查/装好 + 建索引），禁「快速找个文件」这种没主语的空话
    assert.ok(src.indexOf('帮我用 Spotlight 在这台 Mac 上快速找个文件。') < 0, 'mac 提词不得再是空话');
    assert.ok(src.indexOf('帮我用 locate 在这台 Linux 上快速找个文件。') < 0, 'linux 提词不得再是空话');
    assert.ok(/Spotlight 索引正不正常/.test(src), 'mac 卡必须让 AI 检查/修复索引');
    assert.ok(/装好 locate（优先 plocate）/.test(src), 'linux 卡必须让 AI 装好 locate 并建索引');
    // 需要管理员权限时必须交回用户执行（禁擅自 sudo）
    assert.ok(/我自己执行/.test(src), 'linux 卡必须点明 sudo 命令交用户执行');
});
