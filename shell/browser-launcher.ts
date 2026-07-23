// ============================================================================
// browser-launcher.ts — 浏览器启动器
//
// ★ 存在理由 (2026-07-23):
//   Electron 的 shell.openExternal(url) 在 Windows 上调 ShellExecuteW。
//   当 Edge 后台进程不存在时，ShellExecuteW 可能用临时/隔离 profile 启动 Edge，
//   导致用户打开的是白纸一张（无书签/扩展/cookie/登录态）。
//   用户自己从桌面点浏览器进去是好的，但从 IDE 触发打开就丢登录态。
//
//   根治方案：绕过 ShellExecuteW，从注册表读默认浏览器 exe 路径，
//   直接 spawn 启动，显式传 --profile-directory=Default 确保用用户真实 profile。
//
// 调用方: ipc-misc.ts (qqqide:shell:openExternal 主入口)
//         shutdown.ts (will-navigate / window-open 拦截)
// ============================================================================

import { shell as electronShell } from 'electron';
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ═══ 公开 API ═══

/**
 * 在用户默认浏览器中打开 URL。
 * Windows: 绕过 ShellExecuteW，直接启动浏览器 exe（根治 Edge 丢 profile 问题）
 * macOS/Linux: 使用 Electron shell.openExternal（无此问题）
 */
export function openUrl(url: string): void {
    if (process.platform === 'win32') {
        openUrlWindows(url);
    } else {
        electronShell.openExternal(url).catch(err =>
            console.warn('[browser-launcher] shell.openExternal failed', err)
        );
    }
}

// ═══ Windows 实现 ═══

function openUrlWindows(url: string): void {
    // Layer 1: 从注册表找默认浏览器 exe，直接启动（最优）
    const exe = findDefaultBrowserExe();
    if (exe) {
        const args = buildBrowserArgs(exe, url);
        if (launchDetached(exe, args)) return;
        // launch failed → fall through
    }

    // Layer 2: explorer.exe（Windows Shell 启动，继承用户 session）
    if (launchDetached('explorer.exe', [url])) return;

    // Layer 3: Electron 兜底（原逻辑，可能触发 Edge 临时 profile 问题）
    console.warn('[browser-launcher] all preferred methods failed, falling back to shell.openExternal');
    electronShell.openExternal(url).catch(err =>
        console.warn('[browser-launcher] shell.openExternal fallback failed', err)
    );
}

/**
 * 从 Windows 注册表查找用户默认浏览器 exe 路径。
 *
 * 注册表路径链:
 *   HKCU\...\UrlAssociations\http\UserChoice → ProgId（如 ChromeHTML / MSEdgeHTM）
 *   HKCR\{ProgId}\shell\open\command → 命令行模板（如 "C:\...\chrome.exe" --single-argument %1）
 */
function findDefaultBrowserExe(): string | null {
    try {
        // Step 1: 读用户默认 HTTP 关联的 ProgId
        const progId = regQuery(
            'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
            'ProgId'
        );
        if (!progId) {
            console.warn('[browser-launcher] no ProgId found for http association');
            return null;
        }

        // Step 2: 从 ProgId 的 shell open command 提取 exe 路径
        const cmdLine = regQueryDefault(
            `HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`
        );
        if (!cmdLine) {
            console.warn('[browser-launcher] no command found for ProgId:', progId);
            return null;
        }

        // Step 3: 解析命令行，提取 exe 路径
        const exe = parseExeFromCmdLine(cmdLine);
        if (!exe) {
            console.warn('[browser-launcher] cannot parse exe from command:', cmdLine);
            return null;
        }

        // 验证文件存在
        if (!fs.existsSync(exe)) {
            console.warn('[browser-launcher] exe not found:', exe);
            return null;
        }

        console.log('[browser-launcher] found default browser:', exe);
        return exe;
    } catch (e) {
        console.warn('[browser-launcher] findDefaultBrowserExe error:', e);
        return null;
    }
}

/**
 * 为不同浏览器构建启动参数。
 * Chromium 系浏览器（Edge/Chrome/Brave/Opera）显式传 --profile-directory=Default
 * 确保使用用户真实 profile，避免 Edge 启动到临时/guest profile。
 */
function buildBrowserArgs(exe: string, url: string): string[] {
    const baseName = path.basename(exe).toLowerCase();
    const isChromium = ['msedge.exe', 'chrome.exe', 'brave.exe', 'opera.exe', 'chromium.exe'].indexOf(baseName) !== -1;

    if (isChromium) {
        // --profile-directory=Default 强制使用默认用户 profile
        // 避免 Edge 以临时/guest profile 启动导致白纸一张
        return ['--profile-directory=Default', url];
    }

    // Firefox / 其他浏览器：直接传 URL
    return [url];
}

/**
 * spawn 一个 detach 进程。成功返回 true，失败返回 false。
 * detach + unref 确保 IDE 不等待浏览器退出。
 */
function launchDetached(command: string, args: string[]): boolean {
    try {
        const child = spawn(command, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();
        // 监听 error 事件但不阻塞（进程已 detach）
        child.on('error', (err) => {
            console.warn('[browser-launcher] spawn error:', command, err.message);
        });
        return true;
    } catch (e: any) {
        console.warn('[browser-launcher] launchDetached failed:', command, e.message);
        return false;
    }
}

// ═══ 注册表工具 ═══

/**
 * 读注册表指定 key 下指定 value 的 REG_SZ 数据。
 * 使用 reg query 命令（Windows 自带，零依赖）。
 * 返回 null 表示 key 或 value 不存在。
 */
function regQuery(key: string, value: string): string | null {
    try {
        const output = execSync(
            `reg query "${key}" /v "${value}"`,
            { encoding: 'utf8', timeout: 3000, windowsHide: true }
        );
        // 输出格式: "    ProgId    REG_SZ    ChromeHTML"
        const lines = output.split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*(?:\S+\s+)?REG_SZ\s+(.+)/);
            if (m) {
                return m[1].trim();
            }
        }
    } catch (e) {
        // key 或 value 不存在 → reg 返回非 0
    }
    return null;
}

/**
 * 读注册表指定 key 的默认值（(默认) / (Default)）。
 * 中文系统输出 "(默认)"，英文系统输出 "(Default)"，regex 统一处理。
 */
function regQueryDefault(key: string): string | null {
    try {
        const output = execSync(
            `reg query "${key}" /ve`,
            { encoding: 'utf8', timeout: 3000, windowsHide: true }
        );
        const lines = output.split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*(?:\S+\s+)?REG_(?:SZ|EXPAND_SZ)\s+(.+)/);
            if (m) {
                return m[1].trim();
            }
        }
    } catch (e) {
        // key 不存在
    }
    return null;
}

/**
 * 从浏览器注册的命令行模板中提取 exe 路径。
 * 模板示例:
 *   "C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1
 *   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1
 *   C:\Program Files\Mozilla Firefox\firefox.exe -osint -url "%1"
 */
function parseExeFromCmdLine(cmdLine: string): string | null {
    // 尝试匹配引号包裹的 exe 路径
    const quoted = cmdLine.match(/^\s*"([^"]+)"/);
    if (quoted) {
        const exe = quoted[1];
        if (fs.existsSync(exe)) return exe;
    }

    // 尝试匹配无引号的 exe 路径（取第一个空格前的 token）
    const parts = cmdLine.trim().split(/\s+/);
    if (parts.length > 0) {
        const exe = parts[0];
        if (fs.existsSync(exe)) return exe;
    }

    return null;
}
