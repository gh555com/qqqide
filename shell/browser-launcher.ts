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

    let l1Failed = false;

    // ═══ L1: cmd 短命 relay（v29 通道绝缘，2026-09-09 q209 f76 定案） ═══
    // ★ 旧 L1 = Electron shell.openExternal（ShellExecuteW）——Windows 上 ShellExecuteW 由
    //   调用进程直接 CreateProcess → 打开目标的 PPID = 主进程，永久收养进统计圈
    //   （F75 实测 roam 打开 solar-local.html → chrome×38 ≈2GB 入圈）。
    //   cmd /c start 毫秒级退出 → 目标 PPID = 已死 cmd → 血缘结构性不可达，永不进圈。
    //   ★ /normal 覆盖：windowsHide:true 的 SW_HIDE 会被 start 继承 → 目标窗口隐藏
    //   （2026-08-24 F148 实测定案）→ start /normal 显式要求目标正常窗口。
    //   POSIX（open/xdg-open）天然短命 + reparent 同语义——跨平台零分类零登记。
    diag('L1: cmd relay start (v29 channel isolation)');
    try {
        const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start', '""', '/normal', url], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();
        child.on('error', (e: any) => {
            l1Failed = true;
            diag(`L1 relay spawn error: ${e.message}`);
        });
        diag('L1: cmd relay spawned');
    } catch (e: any) {
        l1Failed = true;
        diag(`L1: exception — ${e.message}`);
    }

    // ═══ 3 秒后兜底 ═══
    setTimeout(() => {
        diag(`3s fallback — l1Failed=${l1Failed}`);
        // 轻量提醒：IPC → qoast（渲染层底部 qoast，用户可忽略）
        showFallbackViaIpc(url, sender);
        // 仅 L1 明确失败时弹原生对话框（"复制链接"按钮）
        if (l1Failed) {
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
