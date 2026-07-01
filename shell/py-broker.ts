// ============================================================================
// py-broker.ts — Python broker 生命周期管理
// 启动时 spawn py-broker.py 作为常驻子进程，stdin/stdout JSON 行协议通信。
// 用途：跨平台窗口标题改名（Win: ctypes / Mac: osascript / Linux: wmctrl）
// ============================================================================

import { ChildProcess, spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let _proc: ChildProcess | null = null;
let _pending: Map<number, { resolve: (r: any) => void; reject: (e: any) => void }> = new Map();
let _nextId = 1;
let _readyPromise: Promise<void> | null = null;
let _buffer = '';

function _resolvePyPath(portableRoot: string): string {
    // 同 ipc-state.ts getPythonExe 逻辑
    const bundled = path.join(portableRoot, 'engines', 'python', 'python.exe');
    if (fs.existsSync(bundled)) return bundled;
    const devPy = 'E:\\s\\d\\python3810\\python.exe';
    if (fs.existsSync(devPy)) return devPy;
    return process.platform === 'win32' ? 'python' : 'python3';
}

export function startPyBroker(portableRoot: string): void {
    if (_proc) return;

    const pyExe = _resolvePyPath(portableRoot);
    const scriptPath = path.join(__dirname, 'py-broker.py');

    if (!fs.existsSync(scriptPath)) {
        console.log('[py-broker] script not found:', scriptPath);
        return;
    }

    _proc = spawn(pyExe, ['-u', scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
    });

    _readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('py-broker startup timeout'));
        }, 10000);

        const onData = (chunk: Buffer) => {
            _buffer += chunk.toString('utf-8');
            const nl = _buffer.indexOf('\n');
            if (nl === -1) return;
            const line = _buffer.slice(0, nl);
            _buffer = _buffer.slice(nl + 1);
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'ready') {
                    clearTimeout(timeout);
                    _proc!.stdout!.removeListener('data', onData);
                    resolve();
                }
            } catch { /* wait for next line */ }
        };

        _proc!.stdout!.on('data', onData);
        _proc!.on('error', (e) => { clearTimeout(timeout); reject(e); });
        _proc!.on('exit', (code) => {
            clearTimeout(timeout);
            if (code !== 0) reject(new Error(`py-broker exited code=${code}`));
        });
    });

    _proc.stdout!.on('data', (chunk: Buffer) => {
        _buffer += chunk.toString('utf-8');
        let nl: number;
        while ((nl = _buffer.indexOf('\n')) !== -1) {
            const line = _buffer.slice(0, nl);
            _buffer = _buffer.slice(nl + 1);
            try {
                const msg = JSON.parse(line);
                if (msg.id && _pending.has(msg.id)) {
                    const p = _pending.get(msg.id)!;
                    _pending.delete(msg.id);
                    p.resolve(msg);
                }
            } catch { /* ignore */ }
        }
    });

    _proc.stderr!.on('data', (chunk: Buffer) => {
        // py-broker stderr 转发到主进程 console
        console.log('[py-broker]', chunk.toString('utf-8').trim());
    });

    _proc.on('exit', (code) => {
        console.log(`[py-broker] exited code=${code}`);
        _proc = null;
        _readyPromise = null;
        // 拒绝所有挂起的请求
        for (const [id, p] of _pending) {
            p.reject(new Error('py-broker exited'));
        }
        _pending.clear();
    });

    console.log('[py-broker] spawned pid=' + _proc.pid);
}

function _sendCommand(action: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!_proc || _proc.killed) {
            reject(new Error('py-broker not running'));
            return;
        }
        const id = _nextId++;
        _pending.set(id, { resolve, reject });

        const cmd = JSON.stringify({ action, id, ...params });
        try {
            _proc.stdin!.write(cmd + '\n');
        } catch (e) {
            _pending.delete(id);
            reject(e);
        }

        // 超时
        setTimeout(() => {
            if (_pending.has(id)) {
                _pending.delete(id);
                reject(new Error(`py-broker timeout: ${action}`));
            }
        }, 10000);
    });
}

/** 等待 broker 就绪 */
export function waitPyBroker(): Promise<void> {
    if (_readyPromise) return _readyPromise;
    return Promise.reject(new Error('py-broker not started'));
}

/** 改名 DevTools 窗口。mainWin 用于取 HWND 和 projectPath。 */
export async function renameDevToolsViaBroker(mainWin: BrowserWindow, projName: string): Promise<void> {
    try {
        await waitPyBroker();

        // 取主窗口 HWND（Windows 用 GW_OWNER 精确匹配）
        let mainHwnd = '0';
        try {
            const hbuf = mainWin.getNativeWindowHandle();
            if (hbuf && hbuf.length >= 4) {
                mainHwnd = hbuf.length === 8
                    ? hbuf.readBigUInt64LE(0).toString()
                    : hbuf.readUInt32LE(0).toString();
            }
        } catch { /* ignore */ }

        const title = `「🔧」${projName}`;
        const result = await _sendCommand('rename-devtools', {
            mainHwnd,
            title,
        });

        if (!result.ok) {
            console.log('[py-broker] rename failed:', result.error);
        }
    } catch (e: any) {
        console.log('[py-broker] rename error:', e.message || e);
    }
}

export function stopPyBroker(): void {
    if (!_proc) return;
    try {
        _proc.stdin!.write(JSON.stringify({ action: 'exit', id: 0 }) + '\n');
    } catch { /* ignore */ }
    setTimeout(() => {
        try { if (_proc) _proc.kill(); } catch { /* ignore */ }
        _proc = null;
    }, 2000);
}
