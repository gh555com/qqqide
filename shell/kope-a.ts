// ============================================================================
// kope-a.ts — kope-a 进程管理器
// 职责: 用内嵌 Python 启动/停止 E:\s\wol\py\kope\q3.py（剪贴板监控工具）
// 唯一 Python 真理源: engines/manifest.json → getComponentBin('python')
// ============================================================================

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import { getComponentBin } from './component-checker';

let _proc: ChildProcess | null = null;
let _pid: number | null = null;

export function startKopeA(portableRoot: string, scriptPath: string): { ok: boolean; pid?: number; error?: string } {
    if (_proc && !_proc.killed) {
        return { ok: true, pid: _pid || undefined };
    }

    const pyExe = getComponentBin(portableRoot, 'python');
    if (!pyExe) {
        return { ok: false, error: 'Python 未安装。Python 是 rank0 组件，重启 IDE 后将自动下载。' };
    }

    if (!fs.existsSync(scriptPath)) {
        return { ok: false, error: '脚本未找到: ' + scriptPath };
    }

    try {
        _proc = spawn(pyExe, ['-u', scriptPath], {
            stdio: 'ignore',
            windowsHide: false,
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
            detached: false,
        });

        _pid = _proc.pid || null;
        console.log('[kope-a] spawned pid=' + _pid);

        _proc.on('exit', (code, signal) => {
            console.log('[kope-a] exited code=' + code + ' signal=' + signal);
            _proc = null;
            _pid = null;
        });

        _proc.on('error', (err) => {
            console.error('[kope-a] proc error:', err);
            _proc = null;
            _pid = null;
        });

        return { ok: true, pid: _pid || undefined };
    } catch (e: any) {
        return { ok: false, error: '启动失败: ' + (e.message || e) };
    }
}

export function stopKopeA(): { ok: boolean; error?: string } {
    if (!_proc || _proc.killed) {
        _proc = null;
        _pid = null;
        return { ok: true };
    }
    try {
        if (process.platform === 'win32' && _pid) {
            try {
                const { execSync } = require('child_process');
                execSync(`taskkill /F /T /PID ${_pid}`, { windowsHide: true });
            } catch { /* may fail if already exited */ }
        } else {
            _proc.kill('SIGTERM');
        }
        _proc = null;
        _pid = null;
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: '停止失败: ' + (e.message || e) };
    }
}

export function isKopeARunning(): boolean {
    return !!(_proc && !_proc.killed);
}

export function getKopeAPid(): number | null {
    return _pid;
}

export function cleanupKopeA(): void {
    stopKopeA();
}
