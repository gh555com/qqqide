// ============================================================================
// gaea-process.ts — 通用 Gaea 进程管理器
// 一切 gaea process-type goods 统一走此模块
//
// Lifecycle 双轨制:
//   'attached'    — 生死 100% 随主窗口。主窗口关闭时强制 taskkill /F /T 清理整棵进程树。
//   'independent' — 独立程序。可由主窗口启动/停止，主窗口退出时也自动清理。
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
}

const _registry = new Map<string, ProcEntry>();

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

export function startGaeaProcess(
    portableRoot: string,
    goodsId: string,
    scriptPath: string,
    runtime: string = 'python',
    lifecycle: GaeaLifecycle = 'attached'
): { ok: boolean; pid?: number; error?: string } {
    // If already running, return existing
    const existing = _registry.get(goodsId);
    if (existing && existing.proc && !existing.proc.killed) {
        return { ok: true, pid: existing.pid || undefined };
    }

    // Resolve runtime binary
    let exe: string | null = null;
    if (runtime === 'python') {
        exe = getComponentBin(portableRoot, 'python');
        if (!exe) return { ok: false, error: 'Python 未安装。重启 IDE 后将自动下载。' };
    } else {
        // Binary runtime — resolve from component system or PATH
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

        // attached: not detached — process tree tied to main window
        // independent: detached — can outlive main window (but still cleaned on exit)
        const isDetached = (lifecycle === 'independent');

        const proc = spawn(exe, ['-u', fullPath], {
            stdio: 'ignore',
            windowsHide: false,
            cwd: cwd,
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: cwd },
            detached: isDetached,
        });

        const entry: ProcEntry = { proc, pid: proc.pid || null, scriptPath: fullPath, lifecycle };
        _registry.set(goodsId, entry);

        console.log('[' + goodsId + '] spawned pid=' + entry.pid + ' lifecycle=' + lifecycle);

        proc.on('exit', (code, signal) => {
            console.log('[' + goodsId + '] exited code=' + code + ' signal=' + signal);
            _registry.delete(goodsId);
        });

        proc.on('error', (err) => {
            console.error('[' + goodsId + '] proc error:', err);
            _registry.delete(goodsId);
        });

        return { ok: true, pid: entry.pid || undefined };
    } catch (e: any) {
        return { ok: false, error: '启动失败: ' + (e.message || e) };
    }
}

export function stopGaeaProcess(goodsId: string): { ok: boolean; error?: string } {
    const entry = _registry.get(goodsId);
    if (!entry || !entry.proc || entry.proc.killed) {
        _registry.delete(goodsId);
        return { ok: true };
    }
    try {
        // ★ Kill entire process tree (/T) — ensures no orphaned child processes
        //    (e.g. miniaudio audio engine, subprocesses spawned by the goods script)
        if (process.platform === 'win32' && entry.pid) {
            try {
                execSync(`taskkill /F /T /PID ${entry.pid}`, { windowsHide: true });
            } catch { /* already exited — that's fine */ }
        } else {
            // Unix: kill process group
            try {
                process.kill(-entry.pid!, 'SIGTERM');
            } catch {
                entry.proc.kill('SIGKILL');
            }
        }
        _registry.delete(goodsId);
        console.log('[' + goodsId + '] stopped (lifecycle=' + (entry.lifecycle || 'attached') + ')');
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: '停止失败: ' + (e.message || e) };
    }
}

export function isGaeaProcessRunning(goodsId: string): boolean {
    const entry = _registry.get(goodsId);
    return !!(entry && entry.proc && !entry.proc.killed);
}

export function getGaeaProcessPid(goodsId: string): number | null {
    const entry = _registry.get(goodsId);
    return entry ? entry.pid : null;
}

export function cleanupAllGaeaProcesses(): void {
    console.log('[gaea-process] cleanupAll — ' + _registry.size + ' process(es)');
    _registry.forEach((entry, goodsId) => {
        console.log('[gaea-process] cleaning ' + goodsId + ' (pid=' + entry.pid + ', lifecycle=' + entry.lifecycle + ')');
        stopGaeaProcess(goodsId);
    });
}
