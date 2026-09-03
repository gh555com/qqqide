// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// browser-launcher.ts — 浏览器启动器（2026-07-28 核弹 v4）
//
// ★ v3 致命缺陷：全层并行 fire-and-forget → 7 个 spawn 全部"成功"
//   → 用户点一次登录弹出 7-8 个浏览器标签页。治好了"弹不出"却制造了"弹太多"。
//
// ★ v4 修复：
//   L1: Electron shell.openExternal (ShellExecuteW) — 最可靠的 Windows API，
//       不用 spawn 浏览器、不用 --profile-directory flag。根治 Win11 Edge Startup
//       Boost 旧 bug，同时天然只开一个标签页。
//   L2: explorer.exe — 仅当 L1 明确 reject 时触发（ShellExecuteW 另一条路径）。
//   3s 后: qoast IPC 推送到渲染层（轻量提醒，用户可忽略）。
//   仅 L1 reject 时: 原生对话框弹窗（用户"复制链接"手动粘贴）。
//
//   结果: 最多 1 个浏览器标签（L1 成功）或 1 个标签（L2 补救成功）或 0 个 + 兜底对话框。
//
// 调用方: ipc-misc.ts (qqqide:shell:openExternal 主入口)
// ============================================================================

import { shell as electronShell, dialog, clipboard, app } from 'electron';
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ═══ 诊断日志 ═══

let _logPath: string | null = null;

function getLogPath(): string {
    if (_logPath) return _logPath;
    try {
        const dataDir = app.getPath('userData');
        const dir = path.join(dataDir, 'alphal');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        _logPath = path.join(dir, 'browser-launch.log');
    } catch {
        _logPath = path.join(os.tmpdir(), 'qqqide-browser-launch.log');
    }
    try { fs.writeFileSync(_logPath, '', 'utf8'); } catch {}
    return _logPath;
}

function diag(msg: string): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const line = `[${ts}] ${msg}`;
    console.log('[browser-launcher]', msg);
    try { fs.appendFileSync(getLogPath(), line + '\n', 'utf8'); } catch {}
}

// ═══ 公开 API ═══

export function openUrl(url: string, sender?: Electron.WebContents): void {
    if (process.platform === 'win32') {
        openUrlWindows(url, sender);
    } else {
        diag(`macOS/Linux: shell.openExternal url=${url}`);
        electronShell.openExternal(url).catch(err =>
            diag(`shell.openExternal failed: ${err}`)
        );
    }
}

// ═══ Windows 实现 — 单发 + 延迟兜底 ═══

function openUrlWindows(url: string, sender?: Electron.WebContents): void {
    diag(`=== openUrlWindows === url=${url}`);
    diag(`platform=${process.platform} arch=${process.arch} node=${process.version}`);

    // 诊断：默认浏览器信息
    const exe = findDefaultBrowserExe();
    diag(`default browser exe: ${exe || 'NOT FOUND'}`);
    if (exe) {
        const bn = path.basename(exe).toLowerCase();
        const isEdge = bn === 'msedge.exe';
        const isChromium = ['msedge.exe', 'chrome.exe', 'brave.exe', 'opera.exe', 'chromium.exe'].indexOf(bn) !== -1;
        diag(`isEdge=${isEdge} isChromium=${isChromium}`);
    }

    let l1Rejected = false;

    // ═══ L1: Electron shell.openExternal (ShellExecuteW) ═══
    // ★ 这是 Windows 上最可靠的 URL 打开方式。ShellExecuteW 不经过 spawn 浏览器、
    //   不使用 --profile-directory flag，直接用 Windows Shell 的默认浏览器关联。
    //   Win11 Edge Startup Boost 的旧 bug（spawn msedge --profile-directory=Default
    //   → URL 静默丢弃）在此路径下不存在。
    diag('L1: shell.openExternal');
    electronShell.openExternal(url)
        .then(() => {
            diag('L1: resolved (ShellExecuteW returned success)');
        })
        .catch((err: any) => {
            l1Rejected = true;
            diag(`L1: REJECTED — ${err?.message || err}`);
            // ═══ L2: explorer.exe（仅 L1 明确失败时触发） ═══
            diag('L2: explorer.exe (fallback after L1 rejection)');
            try {
                const child = spawn('explorer.exe', [url], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true
                });
                child.unref();
                child.on('error', (e) => diag(`L2 spawn error: ${e.message}`));
                diag('L2: spawn OK');
            } catch (e: any) {
                diag(`L2: exception — ${e.message}`);
            }
        });

    // ═══ 3 秒后兜底 ═══
    setTimeout(() => {
        diag(`3s fallback — l1Rejected=${l1Rejected}`);
        // 轻量提醒：IPC → qoast（渲染层底部 qoast，用户可忽略）
        showFallbackViaIpc(url, sender);
        // 仅 L1 明确失败时弹原生对话框（"复制链接"按钮）
        if (l1Rejected) {
            showNativeFallbackDialog(url);
        }
    }, 3000);
}

// ═══ IPC → qoast（渲染层轻量提醒） ═══

function showFallbackViaIpc(url: string, sender?: Electron.WebContents): void {
    if (!sender || sender.isDestroyed()) {
        diag('IPC fallback skipped: no sender or destroyed');
        return;
    }
    try {
        sender.send('qqqide:browser-fallback', { url });
        diag('IPC qqide:browser-fallback sent to renderer');
    } catch (e: any) {
        diag(`IPC fallback failed: ${e.message}`);
    }
}

// ═══ 原生对话框（仅 L1 reject 时） ═══

function showNativeFallbackDialog(url: string): void {
    diag('Showing native fallback dialog');
    dialog.showMessageBox({
        type: 'warning',
        title: '无法自动打开浏览器 — qd (qqqide)',
        message: '自动打开浏览器失败。请复制以下链接到浏览器地址栏：',
        detail: url,
        buttons: ['复制链接', '关闭'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    }).then(result => {
        if (result.response === 0) {
            clipboard.writeText(url);
            diag('User clicked "复制链接"');
        } else {
            diag('User clicked "关闭"');
        }
    }).catch(err => {
        diag(`Native dialog failed: ${err}`);
    });
}

// ═══ 浏览器检测 ═══

function findDefaultBrowserExe(): string | null {
    try {
        const progId = regQuery(
            'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
            'ProgId'
        );
        if (!progId) {
            diag('findDefaultBrowserExe: no ProgId for http');
            return null;
        }
        diag(`findDefaultBrowserExe: ProgId=${progId}`);

        const cmdLine = regQueryDefault(
            `HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`
        );
        if (!cmdLine) {
            diag(`findDefaultBrowserExe: no command for ProgId=${progId}`);
            return null;
        }
        diag(`findDefaultBrowserExe: cmdLine=${cmdLine}`);

        const exe = parseExeFromCmdLine(cmdLine);
        if (!exe) {
            diag(`findDefaultBrowserExe: cannot parse exe from: ${cmdLine}`);
            return null;
        }

        if (!fs.existsSync(exe)) {
            diag(`findDefaultBrowserExe: exe not found: ${exe}`);
            return null;
        }

        diag(`findDefaultBrowserExe: found ${exe}`);
        return exe;
    } catch (e: any) {
        diag(`findDefaultBrowserExe error: ${e.message}`);
        return null;
    }
}

// ═══ 注册表工具 ═══

function regQuery(key: string, value: string): string | null {
    try {
        const output = execSync(
            `reg query "${key}" /v "${value}"`,
            { encoding: 'utf8', timeout: 3000, windowsHide: true }
        );
        const lines = output.split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*(?:\S+\s+)?REG_SZ\s+(.+)/);
            if (m) return m[1].trim();
        }
    } catch {}
    return null;
}

function regQueryDefault(key: string): string | null {
    try {
        const output = execSync(
            `reg query "${key}" /ve`,
            { encoding: 'utf8', timeout: 3000, windowsHide: true }
        );
        const lines = output.split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*(?:\S+\s+)?REG_(?:SZ|EXPAND_SZ)\s+(.+)/);
            if (m) return m[1].trim();
        }
    } catch {}
    return null;
}

function parseExeFromCmdLine(cmdLine: string): string | null {
    const quoted = cmdLine.match(/^\s*"([^"]+)"/);
    if (quoted) {
        const exe = quoted[1];
        if (fs.existsSync(exe)) return exe;
    }
    const parts = cmdLine.trim().split(/\s+/);
    if (parts.length > 0) {
        const exe = parts[0];
        if (fs.existsSync(exe)) return exe;
    }
    return null;
}
