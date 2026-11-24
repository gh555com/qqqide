// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ════════════════════════════════════════════════════════════════════════════
// tools-exec-task.js — run_task 工具（客户端内置维护任务）
//
// 唯一后端 = 壳层 shell/task-ops.ts 的 ACTIONS 白名单（ipc qqqide:task:run）。
// 面板侧（ai-panel/panel-tasks.js）只负责把用户的一句话送进对话；真正动手在这里——
// 也就是「卡片里那件事由 AI 来做」，而不是卡片自己闷头跑。
//
// ★ 壳层只保留一条：install_everything（下载 / SHA-256 校验 / 原子换入 / 三处桌面快捷方式
//   ——版本号与校验值 AI 猜不出来也不该猜）。其余维护类任务（清 C 盘 / 开机自启 /
//   文件秒搜 / 关自启项）一律不进壳层：知识在 capabilities/system-tasks.md，
//   扫描器在 capabilities/scripts/clean-c.ps1，AI 用 run_command 执行。
//   壳层代码 = 每次发版都要背的账，加一条前先问「AI 用命令做不好吗」。
// ════════════════════════════════════════════════════════════════════════════

var RUN_TASK_PLATFORM = {
    install_everything: 'win32'
};

function _platNow() {
    try { if (window.qqqBootInfo && window.qqqBootInfo.platform) return String(window.qqqBootInfo.platform); } catch (_) { }
    try { if (parent.qqqBootInfo && parent.qqqBootInfo.platform) return String(parent.qqqBootInfo.platform); } catch (_) { }
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/Mac/i.test(ua)) return 'darwin';
    if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'linux';
    return 'win32';
}

async function executeRunTask(args) {
    var bridge = getBridge();
    if (!bridge || !bridge.tasks || !bridge.tasks.run) {
        return 'Error: run_task is not available on this client build (bridge.tasks missing).';
    }
    var task = String((args && args.task) || '').trim();
    if (!Object.prototype.hasOwnProperty.call(RUN_TASK_PLATFORM, task)) {
        return 'Error: unknown task "' + task + '". Available: ' + Object.keys(RUN_TASK_PLATFORM).join(', ') +
            '. System maintenance jobs (clean C drive, autostart, Spotlight/locate, startup items) are NOT shell tasks — ' +
            'do them yourself with run_command following capabilities/system-tasks.md.';
    }
    var plat = _platNow();
    var need = RUN_TASK_PLATFORM[task];
    if (need !== 'any' && need !== plat) {
        return 'Error: "' + task + '" only runs on Windows (current platform: ' + plat +
            '). Tell the user honestly and offer the native alternative for this OS.';
    }
    var res = null;
    try { res = await bridge.tasks.run(task, {}); }
    catch (e) { return 'Error: ' + task + ' failed to start: ' + ((e && e.message) || e); }
    if (!res || typeof res !== 'object') return 'Error: ' + task + ' returned no result.';
    if (!res.ok) return 'FAILED (' + task + '): ' + (res.message || 'unknown error');
    return 'OK — ' + (res.message || 'done');
}
