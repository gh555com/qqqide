// ============================================================================
// gaea-process.ts — 通用 Gaea 进程管理器
// 一切 gaea process-type goods 统一走此模块
// ============================================================================

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getComponentBin } from './component-checker';

interface ProcEntry {
    proc: ChildProcess | null;
    pid: number | null;
    scriptPath: string;
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
    runtime: string = 'python'
): { ok: boolean; pid?: number; error?: string } {
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
        return { ok: false, error: '不支持运行时: ' + runtime };
    }

    // Resolve script path (scriptPath like "goods/kope-a/q3.py")
    // Priority: Data/webapp/ (packaged, hot-updated) → resources/app/engines/ (old r) → server-app/ (dev)
    const fullPath = _resolveGoodsScript(portableRoot, scriptPath);
    if (!fs.existsSync(fullPath)) {
        return { ok: false, error: '脚本未找到: ' + fullPath };
    }

    try {
        // Set cwd to script dir so relative imports work
        const cwd = fullPath.substring(0, fullPath.lastIndexOf('\\'));

        const proc = spawn(exe, ['-u', fullPath], {
            stdio: 'ignore',
            windowsHide: false,
            cwd: cwd,
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: cwd },
            detached: false,
        });

        const entry: ProcEntry = { proc, pid: proc.pid || null, scriptPath: fullPath };
        _registry.set(goodsId, entry);

        console.log('[' + goodsId + '] spawned pid=' + entry.pid);

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
        if (process.platform === 'win32' && entry.pid) {
            try {
                const { execSync } = require('child_process');
                execSync(`taskkill /F /T /PID ${entry.pid}`, { windowsHide: true });
            } catch { /* already exited */ }
        } else {
            entry.proc.kill('SIGTERM');
        }
        _registry.delete(goodsId);
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
    _registry.forEach((_entry, goodsId) => {
        stopGaeaProcess(goodsId);
    });
}
