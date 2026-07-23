// ============================================================================
// gaea-process.ts — 通用 Gaea 进程管理器
// 一切 gaea process-type goods 统一走此模块
//
// Lifecycle 双轨制:
//   'attached'    — 生死 100% 随主窗口。主窗口关闭时强制 taskkill /F /T 清理整棵进程树。
//   'independent' — 独立程序。可由主窗口启动/停止，主窗口退出时也自动清理。
//
// allowMultiple 单例约定 (2026-07-19):
//   true (默认) — 允许多实例
//   false        — 禁止多开。跨 qqqide 窗口 + 脚本自保双重防多开。
//                   PID 文件: Data/alphal/goods/{goodsId}.pid
//                   启动前检查 PID 存活 → 存活则拒绝启动
//                   启动后写 PID 文件 → 退出时清理
//
// Watchdog 高可用 (2026-07-19):
//   对 allowMultiple=false 且自启动开启的 goods，定期检查进程存活。
//   进程死亡 → 自动重启。相当于简单高可用守护。
//
// ★ 跨窗口状态检测 (2026-07-20):
//   isGaeaProcessRunning 通过 PID 文件检测其他窗口启动的进程。
//   _statusListeners 广播到所有 BrowserWindow（非仅 mainWindow）。
// ============================================================================

import { ChildProcess, spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getComponentBin } from './component-checker';

export type GaeaLifecycle = 'attached' | 'independent';

interface ProcEntry {
    proc: ChildProcess | null;
    pid: number | null;
    scriptPath: string;
    lifecycle: GaeaLifecycle;
    allowMultiple: boolean;
}

const _registry = new Map<string, ProcEntry>();
const _watchdogs = new Map<string, NodeJS.Timeout>();
const _statusListeners: Array<(goodsId: string, running: boolean, pid: number | null) => void> = [];
let _userDataPath: string | null = null;
const _goodsMeta = new Map<string, { allowMultiple: boolean }>();
// ★ 单例冲突标记：进程因互斥锁冲突退出（exit code 100）→ 防止看门狗无限重启
const _singletonConflicts = new Set<string>();

export function onGaeaProcessStatusChange(cb: (goodsId: string, running: boolean, pid: number | null) => void): void {
    _statusListeners.push(cb);
}

function _notifyStatus(goodsId: string, running: boolean, pid: number | null): void {
    for (const cb of _statusListeners) {
        try { cb(goodsId, running, pid); } catch { /* ignore */ }
    }
}

// ═══════════════════════════════════════════════════════════════
// PID 文件协议 — 跨窗口单例检测
// ═══════════════════════════════════════════════════════════════

function _pidFileDir(userData: string): string {
    const dir = path.join(userData, 'alphal', 'goods');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function _pidFilePath(userData: string, goodsId: string): string {
    return path.join(_pidFileDir(userData), goodsId + '.pid');
}

function _isPidAlive(pid: number): boolean {
    try {
        if (process.platform === 'win32') {
            const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { windowsHide: true, timeout: 3000 });
            return result.toString().includes(`${pid}`);
        } else {
            process.kill(pid, 0);
            return true;
        }
    } catch {
        return false;
    }
}

function _checkExistingInstance(userData: string, goodsId: string): { running: boolean; pid?: number } {
    const pidFile = _pidFilePath(userData, goodsId);
    if (!fs.existsSync(pidFile)) return { running: false };

    try {
        const content = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = parseInt(content.split('\n')[0], 10);
        if (isNaN(pid)) return { running: false };

        if (_isPidAlive(pid)) {
            return { running: true, pid };
        } else {
            // Stale PID file — clean up
            try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
            return { running: false };
        }
    } catch {
        return { running: false };
    }
}

function _writePidFile(userData: string, goodsId: string, pid: number): void {
    try {
        fs.writeFileSync(_pidFilePath(userData, goodsId), `${pid}\n${Date.now()}`, 'utf-8');
    } catch { /* ignore */ }
}

function _removePidFile(userData: string, goodsId: string): void {
    try { fs.unlinkSync(_pidFilePath(userData, goodsId)); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// 脚本路径解析
// ═══════════════════════════════════════════════════════════════

function _resolveGoodsScript(portableRoot: string, scriptPath: string): string {
    // ① Data/webapp/ — packaged green pack, hot-updated via u pipeline
    const dataWebapp = path.join(portableRoot, 'Data', 'webapp');
    const p1 = path.join(dataWebapp, scriptPath);
    if (fs.existsSync(p1)) return p1;

    // ② resources/app/engines/ — old r payload location (backward compat)
    const oldRel = scriptPath.replace(/^goods\//, '');
    const p2 = path.join(portableRoot, 'resources', 'app', 'engines', oldRel);
    if (fs.existsSync(p2)) return p2;

    // ③ server-app/ — dev mode (project root)
    const p3 = path.join(portableRoot, 'server-app', scriptPath);
    if (fs.existsSync(p3)) return p3;

    // ④ Fallback: Data/webapp/ (may not exist yet but will after hot update)
    return p1;
}

// ═══════════════════════════════════════════════════════════════
// 进程启动 / 停止
// ═══════════════════════════════════════════════════════════════

export function startGaeaProcess(
    portableRoot: string,
    goodsId: string,
    scriptPath: string,
    runtime: string = 'python',
    lifecycle: GaeaLifecycle = 'attached',
    allowMultiple: boolean = true
): { ok: boolean; pid?: number; error?: string; alreadyRunning?: boolean } {
    const userData = path.join(portableRoot, 'Data');
    _userDataPath = userData;
    _goodsMeta.set(goodsId, { allowMultiple });

    // ★ 用户主动重试 → 清除冲突标记
    _singletonConflicts.delete(goodsId);

    // ★ 单例检测: allowMultiple=false → 检查 PID 文件
    if (!allowMultiple) {
        const existing = _checkExistingInstance(userData, goodsId);
        if (existing.running) {
            console.log('[' + goodsId + '] already running pid=' + existing.pid + ' — skip');
            // 记录到内存注册表（watchdog 需要）
            if (!_registry.has(goodsId)) {
                _registry.set(goodsId, {
                    proc: null, pid: existing.pid || null,
                    scriptPath, lifecycle, allowMultiple
                });
            }
            return { ok: true, pid: existing.pid, alreadyRunning: true };
        }
    }

    // If already running (in-memory), return existing
    const existingMem = _registry.get(goodsId);
    if (existingMem && existingMem.proc && !existingMem.proc.killed) {
        return { ok: true, pid: existingMem.pid || undefined };
    }

    // Resolve runtime binary
    let exe: string | null = null;
    if (runtime === 'python') {
        exe = getComponentBin(portableRoot, 'python');
        if (!exe) return { ok: false, error: 'Python 未安装。重启 IDE 后将自动下载。' };
    } else {
        const binFromComponent = getComponentBin(portableRoot, runtime);
        if (binFromComponent) {
            exe = binFromComponent;
        } else {
            return { ok: false, error: '运行时未找到: ' + runtime };
        }
    }

    // Resolve script path (scriptPath like "goods/kope-a/q3.py")
    const fullPath = _resolveGoodsScript(portableRoot, scriptPath);
    if (!fs.existsSync(fullPath)) {
        return { ok: false, error: '脚本未找到: ' + fullPath };
    }

    try {
        const cwd = fullPath.substring(0, fullPath.lastIndexOf('\\'));
        const isDetached = (lifecycle === 'independent');
        const pidFile = _pidFilePath(userData, goodsId);

        // ★ 传递 --pid-file 给脚本，脚本层面自保防多开
        const args = ['-u', fullPath];
        if (!allowMultiple) {
            args.push('--pid-file', pidFile);
        }

        // ★ Qt 防护: 显式指定插件路径 + 运行时 DLL 目录（防客户电脑缺 VC++ 运行时）
        const pyEngineDir = path.dirname(exe);
        const qtPluginDir = path.join(pyEngineDir, 'site-packages', 'PySide2', 'plugins');
        const envExt: any = {
            PYTHONUNBUFFERED: '1',
            PYTHONIOENCODING: 'utf-8',
            PYTHONPATH: cwd,
            QT_PLUGIN_PATH: qtPluginDir,
            QT_QPA_PLATFORM_PLUGIN_PATH: qtPluginDir,
        };
        // 把 python 引擎目录加入 PATH，确保 VC++ 运行时 DLL (msvcp140/vcruntime140) 可被 Qt 插件找到
        envExt.PATH = pyEngineDir + path.delimiter + (process.env.PATH || '');

        const proc = spawn(exe, args, {
            stdio: 'ignore',
            windowsHide: false,
            cwd: cwd,
            env: { ...process.env, ...envExt },
            detached: isDetached,
        });

        const entry: ProcEntry = { proc, pid: proc.pid || null, scriptPath: fullPath, lifecycle, allowMultiple };
        _registry.set(goodsId, entry);

        console.log('[' + goodsId + '] spawned pid=' + entry.pid + ' lifecycle=' + lifecycle +
            (allowMultiple ? '' : ' [singleton]'));

        // ★ 写 PID 文件（脚本也会写，双写保底）
        if (!allowMultiple && entry.pid) {
            _writePidFile(userData, goodsId, entry.pid);
        }

        // ★ 通知渲染层状态变更
        _notifyStatus(goodsId, true, entry.pid);

        proc.on('exit', (code, signal) => {
            console.log('[' + goodsId + '] exited code=' + code + ' signal=' + signal);
            if (!allowMultiple) {
                _removePidFile(userData, goodsId);
                // ★ exit code 100 = 互斥锁冲突（另一实例已运行，可能来自其他 IDE）
                if (code === 100) {
                    _singletonConflicts.add(goodsId);
                    console.log('[' + goodsId + '] singleton conflict — watchdog blocked');
                }
            }
            _registry.delete(goodsId);
            _notifyStatus(goodsId, false, null);
        });

        proc.on('error', (err) => {
            console.error('[' + goodsId + '] proc error:', err);
            if (!allowMultiple) _removePidFile(userData, goodsId);
            _registry.delete(goodsId);
            _notifyStatus(goodsId, false, null);
        });

        return { ok: true, pid: entry.pid || undefined };
    } catch (e: any) {
        return { ok: false, error: '启动失败: ' + (e.message || e) };
    }
}

export function stopGaeaProcess(goodsId: string): { ok: boolean; error?: string } {
    // ★ 用户主动停止 → 清除单例冲突标记
    _singletonConflicts.delete(goodsId);
    const entry = _registry.get(goodsId);

    // ★ 路径 A: 内存里有活跃 proc → 直接杀
    if (entry && entry.proc && !entry.proc.killed) {
        try {
            if (process.platform === 'win32' && entry.pid) {
                try {
                    execSync(`taskkill /F /T /PID ${entry.pid}`, { windowsHide: true });
                } catch { /* already exited — that's fine */ }
            } else {
                try {
                    process.kill(-entry.pid!, 'SIGTERM');
                } catch {
                    entry.proc.kill('SIGKILL');
                }
            }
            _registry.delete(goodsId);
            if (_userDataPath) _removePidFile(_userDataPath, goodsId);
            console.log('[' + goodsId + '] stopped (lifecycle=' + (entry.lifecycle || 'attached') + ')');
            _notifyStatus(goodsId, false, null);
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: '停止失败: ' + (e.message || e) };
        }
    }

    // ★ 路径 B: 内存里没有活跃 proc (IDE 重启后 proc:null, 或 entry 不存在)
    //           回退到 PID 文件杀 — 否则 isGaeaProcessRunning 显示运行中但关不掉
    _registry.delete(goodsId);
    if (_userDataPath) {
        const existing = _checkExistingInstance(_userDataPath, goodsId);
        if (existing.running && existing.pid) {
            try {
                if (process.platform === 'win32') {
                    execSync(`taskkill /F /T /PID ${existing.pid}`, { windowsHide: true });
                } else {
                    process.kill(existing.pid, 'SIGKILL');
                }
                _removePidFile(_userDataPath, goodsId);
                console.log('[' + goodsId + '] stopped via PID file pid=' + existing.pid);
                _notifyStatus(goodsId, false, null);
                return { ok: true };
            } catch (e: any) {
                // PID 文件可能已过期 — 清理
                _removePidFile(_userDataPath, goodsId);
                _notifyStatus(goodsId, false, null);
                return { ok: true };
            }
        } else {
            // 进程不在运行 — 清理过期 PID 文件
            _removePidFile(_userDataPath, goodsId);
            _notifyStatus(goodsId, false, null);
        }
    }
    return { ok: true };
}

export function isGaeaProcessRunning(goodsId: string): boolean {
    const entry = _registry.get(goodsId);
    if (entry && entry.proc && !entry.proc.killed) return true;
    // ★ 跨窗口：通过 PID 文件检测其他窗口启动的进程
    const meta = _goodsMeta.get(goodsId);
    if (meta && !meta.allowMultiple && _userDataPath) {
        const existing = _checkExistingInstance(_userDataPath, goodsId);
        if (existing.running) return true;
    }
    return false;
}

export function getGaeaProcessPid(goodsId: string): number | null {
    const entry = _registry.get(goodsId);
    return entry ? entry.pid : null;
}

export function cleanupAllGaeaProcesses(): void {
    console.log('[gaea-process] cleanupAll — ' + _registry.size + ' process(es)');
    stopAllGaeaWatchdogs();
    _registry.forEach((entry, goodsId) => {
        console.log('[gaea-process] cleaning ' + goodsId + ' (pid=' + entry.pid + ', lifecycle=' + entry.lifecycle + ')');
        stopGaeaProcess(goodsId);
    });
}

// ═══════════════════════════════════════════════════════════════
// Watchdog 高可用 — 对 allowMultiple=false 且自启动的 goods
// ═══════════════════════════════════════════════════════════════

/**
 * 启动看门狗：每 5s 检查进程是否存活，死亡则自动重启。
 * 仅对 allowMultiple=false 的 goods 有意义（单例 + 高可用）。
 */
export function startGaeaWatchdog(
    portableRoot: string,
    goodsId: string,
    scriptPath: string,
    runtime: string = 'python',
    lifecycle: GaeaLifecycle = 'attached'
): void {
    const userData = path.join(portableRoot, 'Data');

    // 防重复
    stopGaeaWatchdog(goodsId);

    const timer = setInterval(() => {
        // ★ 单例冲突：另一实例正在运行 → 不重启，等下次
        if (_singletonConflicts.has(goodsId)) {
            return;
        }
        const existing = _checkExistingInstance(userData, goodsId);
        if (!existing.running) {
            console.log('[watchdog:' + goodsId + '] process not running, restarting...');
            _removePidFile(userData, goodsId);
            _registry.delete(goodsId);
            const result = startGaeaProcess(portableRoot, goodsId, scriptPath, runtime, lifecycle, false);
            if (result.ok) {
                console.log('[watchdog:' + goodsId + '] restarted pid=' + result.pid);
            } else {
                console.log('[watchdog:' + goodsId + '] restart failed:', result.error);
            }
        }
    }, 5000);

    _watchdogs.set(goodsId, timer);
    console.log('[watchdog:' + goodsId + '] started');
}

export function stopGaeaWatchdog(goodsId: string): void {
    const timer = _watchdogs.get(goodsId);
    if (timer) {
        clearInterval(timer);
        _watchdogs.delete(goodsId);
        console.log('[watchdog:' + goodsId + '] stopped');
    }
}

export function stopAllGaeaWatchdogs(): void {
    _watchdogs.forEach((timer, goodsId) => {
        clearInterval(timer);
        console.log('[watchdog:' + goodsId + '] stopped (cleanup)');
    });
    _watchdogs.clear();
}
