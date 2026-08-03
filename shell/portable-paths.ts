// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// portable-paths.ts
// MUST be imported BEFORE any other electron module that touches paths.
// Redirects ALL chromium/electron writable paths to the app directory,
// so we never write a single byte to C:\Users\... / AppData / Registry.
//
// 2026-07-20 v2: 覆盖 TEMP/TMP/LOCALAPPDATA 环境变量 → GPU/V8 缓存自然落入便携目录。
//   不再禁用 GPU shader cache / CodeCache（改为重定向），零能力下降。
//   启动时自动清理 Data/Temp 中超过 24h 的临时文件。
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';

/** Returns the directory containing the running executable. */
export function getAppRoot(): string {
    // Detect dev mode without relying on electron.app (which may not be ready
    // at bundle top-level execution time in some environments).
    // Dev: process.execPath = .../node_modules/electron/dist/electron.exe
    // Packaged: process.execPath = .../qqq-shell.exe (no node_modules in path)
    const execLower = process.execPath.replace(/\\/g, '/').toLowerCase();
    if (execLower.includes('node_modules') || execLower.includes('electron/dist')) {
        return path.resolve(__dirname, '..');
    }
    return path.dirname(process.execPath);
}

/** Apply portable redirects. Call this BEFORE app.whenReady(). */
export function applyPortablePaths(): { root: string; userData: string; cache: string; logs: string } {
    const root = getAppRoot();
    const userData = path.join(root, 'Data');
    // ★ 所有运行时目录收进 userData/，根目录保持干净
    const cache = path.join(userData, 'Cache');
    const temp = path.join(userData, 'Temp');
    const logs = path.join(userData, 'Logs');
    const crashDumps = path.join(userData, 'CrashDumps');

    // ★★★ 第一步：覆盖 TEMP/TMP 环境变量（必须在任何文件操作之前）
    // 这是最关键的一步。Chromium 子进程(GPU/Network/Renderer)和 Node.js
    // 内部大量使用 GetTempPath() / os.tmpdir()，这些不走 app.setPath。
    // 重设环境变量后，当前进程 + 所有子进程的临时文件全进便携目录。
    process.env.TMP = temp;
    process.env.TEMP = temp;
    if (process.platform === 'win32') {
        // Windows 有些组件读 LOCALAPPDATA，也劫持掉
        process.env.LOCALAPPDATA = path.join(userData, 'LocalAppData');
    }

    // ensure directories exist
    for (const d of [userData, cache, temp, logs, crashDumps,
        path.join(userData, 'LocalAppData')]) {
        try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
    }

    // Lazily access electron.app — at this point electron main process is running
    // so require('electron') WILL return the API object.
    let app: any;
    try {
        app = require('electron').app;
    } catch {
        console.warn('[portable-paths] electron.app not available, skipping path redirects');
        return { root, userData, cache, logs };
    }
    if (!app) {
        console.warn('[portable-paths] electron.app is undefined, skipping path redirects');
        return { root, userData, cache, logs };
    }

    app.setPath('userData', userData);
    app.setPath('sessionData', userData);
    app.setPath('cache', cache);
    app.setPath('temp', temp);
    app.setPath('logs', logs);
    app.setPath('crashDumps', crashDumps);
    try { app.setAppLogsPath(logs); } catch { /* older electron */ }

    // chromium-level redirects (some still leak to default unless cli switches set)
    app.commandLine.appendSwitch('user-data-dir', userData);
    app.commandLine.appendSwitch('disk-cache-dir', cache);

    // ★ GPU shader cache 和 V8 Code Cache 不再禁用，改为重定向。
    //   环境变量 TEMP/TMP/LOCALAPPDATA 已在上面重设，GPU/Utility/Renderer
    //   子进程继承后自然写入 Data/ 目录。user-data-dir 覆盖 GPUCache/ 和 Code Cache/。
    //   仅禁用无用的 Chromium 特征（省资源、零能力影响）。
    app.commandLine.appendSwitch('disable-features',
        'DefaultBrowser,MediaRouter,OptimizationHints,' +
        'PreloadMediaEngagementData,SafeBrowsing,TranslateUI,' +
        'InterestFeedContentSuggestions,PrivacySandboxSettings4,' +
        'SpellcheckService,PrintPreview,AutofillServerCommunication,PasswordManager,' +
        'IdleDetection,WebOTP,WebPayments');

    // explicitly disable features that may write registry / appdata
    app.commandLine.appendSwitch('no-default-browser-check');
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('disable-component-update');
    app.commandLine.appendSwitch('disable-domain-reliability');
    app.commandLine.appendSwitch('disable-sync');
    app.commandLine.appendSwitch('metrics-recording-only');
    app.commandLine.appendSwitch('disable-default-apps');
    app.commandLine.appendSwitch('disable-speech-api');

    // ★ 禁用崩溃报告磁盘写入
    try {
        const crashReporter = require('electron').crashReporter;
        if (crashReporter) {
            crashReporter.start({ uploadToServer: false });
        }
    } catch { /* ignore */ }

    // ★ 后台清理超过 24h 的临时文件（不阻塞启动）
    setImmediate(() => cleanupStaleTemp(temp, 24 * 60 * 60 * 1000));
    setImmediate(() => cleanupStaleTemp(path.join(userData, 'LocalAppData'), 24 * 60 * 60 * 1000));

    return { root, userData, cache, logs };
}

/** 清理目录中超过 maxAgeMs 的文件和空子目录。失败静默（文件可能被占用）。 */
function cleanupStaleTemp(dir: string, maxAgeMs: number): void {
    const now = Date.now();
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            try {
                const stat = fs.statSync(full);
                if (now - stat.mtimeMs <= maxAgeMs) continue;
                if (entry.isDirectory()) {
                    fs.rmSync(full, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(full);
                }
            } catch { /* 文件被占用或权限不够，跳过 */ }
        }
    } catch { /* 目录不存在或不可读，跳过 */ }
}
