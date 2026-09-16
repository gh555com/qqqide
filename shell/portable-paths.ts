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
import * as os from 'os';

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

/**
 * ★ mac .app 外置托管根（2026-09-16）：往 .app bundle 内写数据会破坏代码签名封条
 *   （TCC csreq 失配 → 已授权限全部失效），且更新换装时数据随旧 app 全灭。
 *   mac bundle 模式 → {.app 同级}/qqqide-data（≈ Windows 的 gh555.com：内含 Data/ + engines/）；
 *   win 绿色包 → root 本身（gh555.com）；dev → 项目根。三者内部结构均为 {host}/Data。
 *   engines/ 经 bundle 内相对符号链接桥接（写穿透到外置，签名不破）。
 */
export function getHostDir(): string {
    const root = getAppRoot();
    const norm = root.replace(/\\/g, '/');
    const idx = norm.indexOf('.app/Contents/MacOS');
    if (idx >= 0) {
        const bundle = norm.slice(0, idx + 4);          // .../qqqide.app
        return path.join(path.dirname(bundle), 'qqqide-data');
    }
    return root;
}

/** ★ Data 目录唯一真理源。一切 {X}/Data 拼接必须走此函数（禁散落硬编码路径推导）。 */
export function getDataDir(): string {
    return path.join(getHostDir(), 'Data');
}

/** ★ OS 级共享目录根 —— 跨绿色包/跨实例一致（squads.json / ai|ws|roam|search.sq3 / goods 状态）。
 *   win: %LOCALAPPDATA% ｜ mac: ~/Library/Application Support ｜ linux: XDG_DATA_HOME 或 ~/.local/share。
 *   一切 OS 级路径拼接必须走此函数（禁散落硬编码 'AppData/Local'）。 */
export function getOsBaseDir(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support');
    }
    if (process.platform === 'linux') {
        return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    }
    return path.join(os.homedir(), 'AppData', 'Local');
}

/** mac 一次性迁移：旧 ~/AppData/Local/* → ~/Library/Application Support/*（该目录全部为本产品系产物）。
 *  条目级 rename；目标已存在时只补迁缺失子项（不覆盖）；最后仅清理空壳目录。 */
function migrateMacOsDirs(): void {
    if (process.platform !== 'darwin') { return; }
    const legacyRoot = path.join(os.homedir(), 'AppData', 'Local');
    try { if (!fs.existsSync(legacyRoot)) { return; } } catch { return; }
    const targetRoot = getOsBaseDir();
    let migrated = 0;
    try {
        for (const name of fs.readdirSync(legacyRoot)) {
            const src = path.join(legacyRoot, name);
            const dst = path.join(targetRoot, name);
            try {
                if (!fs.existsSync(dst)) {
                    fs.mkdirSync(targetRoot, { recursive: true });
                    fs.renameSync(src, dst);
                    migrated++;
                } else if (fs.statSync(src).isDirectory() && fs.statSync(dst).isDirectory()) {
                    for (const child of fs.readdirSync(src)) {
                        const cs = path.join(src, child);
                        const cd = path.join(dst, child);
                        if (!fs.existsSync(cd)) { fs.renameSync(cs, cd); migrated++; }
                    }
                }
            } catch { /* 单条失败不阻塞 */ }
        }
        try { fs.rmdirSync(legacyRoot); } catch { /* 非空/占用则保留 */ }
        try { fs.rmdirSync(path.dirname(legacyRoot)); } catch { /* ~/AppData 空壳 */ }
    } catch { /* ignore */ }
    if (migrated > 0) { console.log('[portable-paths] mac: migrated ' + migrated + ' OS-dir entries -> ' + targetRoot); }
}

/** mac 一次性迁移：bundle 内旧 Data → 外置托管根（原地覆盖升级场景兜底）。 */
function migrateMacLegacyData(): void {
    if (process.platform !== 'darwin') { return; }
    const host = getHostDir();
    if (host === getAppRoot()) { return; }              // dev / 非 bundle 运行
    const oldData = path.join(getAppRoot(), 'Data');    // 旧：.app/Contents/MacOS/Data
    const newData = path.join(host, 'Data');
    try {
        if (fs.existsSync(oldData) && !fs.existsSync(path.join(newData, 'alphal'))) {
            fs.mkdirSync(path.dirname(newData), { recursive: true });
            fs.renameSync(oldData, newData);
            console.log('[portable-paths] mac: migrated legacy Data →', newData);
        }
    } catch (e: any) {
        console.warn('[portable-paths] mac legacy Data migrate failed:', (e && e.message) || e);
    }
}

/** Apply portable redirects. Call this BEFORE app.whenReady(). */
export function applyPortablePaths(): { root: string; userData: string; cache: string; logs: string } {
    const root = getAppRoot();
    migrateMacLegacyData();
    migrateMacOsDirs();
    const userData = getDataDir();
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
    // ★ 2026-08-14: LOCALAPPDATA 劫持已移除（客户事故）——GPU 驱动/shell 读此 env
    //   把着色器缓存写进 Data\LocalAppData、Data\LocalLow → explorer 握句柄 →
    //   退出后安装目录删不掉。真实 %LOCALAPPDATA% 由 OS 状态层显式使用
    //   （os.homedir()/AppData/Local 推导，squads/ai.sq3/ws.sq3 等，不依赖此 env）。

    // ensure directories exist
    for (const d of [userData, cache, temp, logs, crashDumps]) {
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
    // ★ 历史残留整树清除（2026-08-14）: LOCALAPPDATA 劫持时代的缓存垃圾
    //   （Intel ShaderCache / shell 图标缓存），被 explorer 占用则下次启动再试。
    setImmediate(() => {
        for (const junk of [path.join(userData, 'LocalAppData'), path.join(userData, 'LocalLow')]) {
            try { fs.rmSync(junk, { recursive: true, force: true }); } catch { /* 占用，下次再清 */ }
        }
    });

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
