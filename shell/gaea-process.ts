// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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
import * as os from 'os';
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
const _osHeartbeats = new Map<string, NodeJS.Timeout>();
const _statusListeners: Array<(goodsId: string, running: boolean, pid: number | null) => void> = [];
let _userDataPath: string | null = null;

/** 设置用户数据目录（启动时由 main.ts 调用，确保跨窗口 PID 文件检测始终可用） */
export function setGaeaUserDataPath(dir: string): void {
    _userDataPath = dir;
}
const _goodsMeta = new Map<string, { allowMultiple: boolean }>();

/** ★ 向 goods 元信息注册表中预填条目（启动时调用），确保跨窗口状态检测不受调用时序影响 */
export function registerGoodsMeta(goodsId: string, allowMultiple: boolean): void {
    _goodsMeta.set(goodsId, { allowMultiple });
}
// ★ 单例冲突标记：进程因互斥锁冲突退出（exit code 100）→ 防止看门狗无限重启
const _singletonConflicts = new Set<string>();
// ★ 启动中锁：防并发 startGaeaProcess 竞态（两个调用同时通过 PID 文件检查）
const _startingLocks = new Set<string>();

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
// OS 级状态文件 — 跨绿色包/跨窗口同步（2026-07-28）
// 路径: C:\Users\{用户}\AppData\Local\{goodsId}\.gaea-state.json
// 与 kope.sq3 / .singleton.lock 同目录，同一套 expanduser 约定
// ═══════════════════════════════════════════════════════════════

function _getOsStateDir(goodsId: string): string {
    const dir = path.join(os.homedir(), 'AppData', 'Local', goodsId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function _getOsStatePath(goodsId: string): string {
    return path.join(_getOsStateDir(goodsId), '.gaea-state.json');
}

interface OsGaeaState {
    pid: number;
    autoStart: boolean;
    ts: number;
}

function _readOsState(goodsId: string): OsGaeaState | null {
    try {
        const p = _getOsStatePath(goodsId);
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        if (typeof data.pid === 'number' && typeof data.ts === 'number') {
            return { pid: data.pid, autoStart: !!data.autoStart, ts: data.ts };
        }
        return null;
    } catch { return null; }
}

function _writeOsState(goodsId: string, state: OsGaeaState): void {
    try {
        const dir = _getOsStateDir(goodsId);
        const dest = path.join(dir, '.gaea-state.json');
        const tmp = dest + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
        fs.renameSync(tmp, dest);
    } catch { /* ignore */ }
}

function _clearOsState(goodsId: string): void {
    try {
        const p = _getOsStatePath(goodsId);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignore */ }
}

/** 同步 autoStart 到 OS 级状态文件（跨绿色包可见） */
export function syncOsGaeaAutoStart(goodsId: string, autoStart: boolean): void {
    const state = _readOsState(goodsId);
    if (state) {
        _writeOsState(goodsId, { ...state, autoStart });
    }
}

/** 从 OS 级状态文件读取 autoStart（跨绿色包可见） */
export function getOsGaeaAutoStart(goodsId: string): boolean | null {
    const state = _readOsState(goodsId);
    if (!state) return null;
    return state.autoStart;
}

/** 检查 OS 级状态文件中记录的 PID 是否存活（跨绿色包检测） */
function _checkOsState(goodsId: string): { running: boolean; pid?: number } {
    const state = _readOsState(goodsId);
    if (!state) return { running: false };
    // 过期清理：超过 30s 未更新 → 视为僵尸
    if (Date.now() - state.ts > 30000) {
        _clearOsState(goodsId);
        return { running: false };
    }
    if (_isPidAlive(state.pid)) {
        return { running: true, pid: state.pid };
    } else {
        _clearOsState(goodsId);
        return { running: false };
    }
}

/** 启动 OS 级心跳：每 10s 刷新 ts，保活 */
function _startOsHeartbeat(goodsId: string, pid: number, autoStart: boolean): NodeJS.Timeout {
    _writeOsState(goodsId, { pid, autoStart, ts: Date.now() });
    const timer = setInterval(() => {
        const current = _readOsState(goodsId);
        if (!current || current.pid !== pid) {
            clearInterval(timer);
            return;
        }
        _writeOsState(goodsId, { pid, autoStart: current.autoStart, ts: Date.now() });
    }, 10000);
    return timer;
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

    // ★ 内存锁防并发竞态：同一 goodsId 同时只能有一个 start 调用
    if (_startingLocks.has(goodsId)) {
        console.log('[' + goodsId + '] start already in progress — skip');
        return { ok: false, error: '启动进行中，请稍后重试' };
    }
    _startingLocks.add(goodsId);

    try {
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
            // ★ OS 级状态文件 + 心跳（跨绿色包同步）
            const autoStart = _readOsState(goodsId)?.autoStart ?? true;
            _osHeartbeats.set(goodsId, _startOsHeartbeat(goodsId, entry.pid, autoStart));
        }

        // ★ 通知渲染层状态变更
        _notifyStatus(goodsId, true, entry.pid);

        proc.on('exit', (code, signal) => {
            console.log('[' + goodsId + '] exited code=' + code + ' signal=' + signal);
            if (!allowMultiple) {
                // ★ exit code 100 = 互斥锁冲突（另一实例已运行，可能来自其他 IDE）
                //   pid 文件属于真实进程，不能删除
                if (code === 100) {
                    _singletonConflicts.add(goodsId);
                    console.log('[' + goodsId + '] singleton conflict — watchdog blocked');
                } else {
                    // 正常退出 → 删除 PID 文件 + OS 级状态
                    _removePidFile(userData, goodsId);
                    _clearOsState(goodsId);
                }
            }
            // 停止 OS 级心跳
            const hb = _osHeartbeats.get(goodsId);
            if (hb) { clearInterval(hb); _osHeartbeats.delete(goodsId); }
            _registry.delete(goodsId);
            _notifyStatus(goodsId, false, null);
        });

        proc.on('error', (err) => {
            console.error('[' + goodsId + '] proc error:', err);
            if (!allowMultiple) {
                _removePidFile(userData, goodsId);
                _clearOsState(goodsId);
            }
            const hb = _osHeartbeats.get(goodsId);
            if (hb) { clearInterval(hb); _osHeartbeats.delete(goodsId); }
            _registry.delete(goodsId);
            _notifyStatus(goodsId, false, null);
        });

        return { ok: true, pid: entry.pid || undefined };
    } catch (e: any) {
        return { ok: false, error: '启动失败: ' + (e.message || e) };
    }
    } finally {
        _startingLocks.delete(goodsId);
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
                } catch { /* already exited */ }
            } else {
                try {
                    process.kill(-entry.pid!, 'SIGTERM');
                } catch {
                    entry.proc.kill('SIGKILL');
                }
            }
            _registry.delete(goodsId);
            console.log('[' + goodsId + '] path A killed pid=' + entry.pid);
        } catch (e: any) {
            console.warn('[' + goodsId + '] path A failed:', e.message);
        }
    }

    // ★ 路径 B: PID 文件杀 (即使路径 A 已执行也跑，防同一个 goodsId 有多个进程)
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
                console.log('[' + goodsId + '] path B killed pid=' + existing.pid);
            } catch { /* ignore */ }
        }
        _removePidFile(_userDataPath, goodsId);
    }

    // ★ 清理 OS 级状态文件
    _clearOsState(goodsId);
    const hb = _osHeartbeats.get(goodsId);
    if (hb) { clearInterval(hb); _osHeartbeats.delete(goodsId); }

    // ★ 路径 C: 暴力扫描 — 无论前两路是否成功，都扫一遍全杀
    if (process.platform === 'win32') {
        try {
            const wmicOut = execSync(
                'wmic process where "name like \'%python%\'" get ProcessId,CommandLine /format:csv',
                { windowsHide: true, timeout: 5000 }
            ).toString();
            let killed = 0;
            for (const line of wmicOut.split('\n')) {
                if (line.includes(goodsId + '/q3.py') || line.includes(goodsId + '\\q3.py')) {
                    const pidMatch = line.match(/,(\d+)/);
                    if (pidMatch) {
                        try {
                            execSync(`taskkill /F /PID ${pidMatch[1]}`, { windowsHide: true });
                            killed++;
                            console.log('[' + goodsId + '] path C killed pid=' + pidMatch[1]);
                        } catch { /* ignore */ }
                    }
                }
            }
            if (killed > 0 || entry) {
                console.log('[' + goodsId + '] brute-force: ' + killed + ' process(es) killed');
            }
        } catch { /* wmic not available */ }
    }

    _notifyStatus(goodsId, false, null);
    return { ok: true };
}

export function isGaeaProcessRunning(goodsId: string): boolean {
    const entry = _registry.get(goodsId);
    if (entry && entry.proc && !entry.proc.killed) return true;
    // ★ 跨窗口（同绿色包）：通过 PID 文件检测其他窗口启动的进程
    const meta = _goodsMeta.get(goodsId);
    if (meta && !meta.allowMultiple && _userDataPath) {
        const existing = _checkExistingInstance(_userDataPath, goodsId);
        if (existing.running) return true;
    }
    // ★ 跨绿色包：通过 OS 级状态文件检测其他绿色包启动的进程
    if (meta && !meta.allowMultiple) {
        const osCheck = _checkOsState(goodsId);
        if (osCheck.running) return true;
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
    // 停所有 OS 级心跳
    _osHeartbeats.forEach((timer, goodsId) => { clearInterval(timer); _clearOsState(goodsId); });
    _osHeartbeats.clear();
    _registry.forEach((entry, goodsId) => {
        console.log('[gaea-process] cleaning ' + goodsId + ' (pid=' + entry.pid + ', lifecycle=' + entry.lifecycle + ')');
        stopGaeaProcess(goodsId);
    });
    // ★ 兜底：遍历所有已知 process-type goods，无论是否在 _registry 中，确保 path B/C 能杀到
    const ALL_PROCESS_GOODS = ['kope-a', 'window-there'];
    for (const gid of ALL_PROCESS_GOODS) {
        if (!_registry.has(gid)) {
            console.log('[gaea-process] cleanupAll brute-force: ' + gid);
            try { stopGaeaProcess(gid); } catch { /* ignore */ }
        }
    }
    // ★ 最终兜底：直接杀所有 kope-a/window-there 的 python 进程（防 detached 残留）
    if (process.platform === 'win32') {
        try {
            const wmicOut = require('child_process').execSync(
                'wmic process where "name like \'%python%\'" get ProcessId,CommandLine /format:csv',
                { windowsHide: true, timeout: 5000 }
            ).toString();
            for (const line of wmicOut.split('\n')) {
                const lower = line.toLowerCase();
                if (lower.includes('kope-a') || lower.includes('window-there')) {
                    const pidMatch = line.match(/,(\d+)/);
                    if (pidMatch) {
                        try {
                            require('child_process').execSync(`taskkill /F /PID ${pidMatch[1]}`, { windowsHide: true });
                            console.log('[gaea-process] cleanupAll final-kill pid=' + pidMatch[1] + ' (' + line.trim() + ')');
                        } catch { /* ignore */ }
                    }
                }
            }
        } catch { /* wmic not available */ }
    }
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
        // ★ 先检查 OS 级状态（跨绿色包），再检查本地 PID 文件
        const osCheck = _checkOsState(goodsId);
        const existing = _checkExistingInstance(userData, goodsId);
        if (!existing.running && !osCheck.running) {
            console.log('[watchdog:' + goodsId + '] process not running, restarting...');
            _removePidFile(userData, goodsId);
            _clearOsState(goodsId);
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
