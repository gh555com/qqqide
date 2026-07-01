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
let _pending: Map<number, { resolve: (r: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }> = new Map();
let _nextId = 1;
let _ready = false;
let _readyError: string | null = null;
let _buf = '';

function _resolvePyPath(portableRoot: string): string {
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

    console.log('[py-broker] starting: py=' + pyExe + ' script=' + scriptPath);

    if (!fs.existsSync(scriptPath)) {
        console.log('[py-broker] FATAL: script not found:', scriptPath);
        _readyError = 'script not found: ' + scriptPath;
        return;
    }

    try {
        const logFile = path.join(portableRoot, 'new_log', '_py_broker.log');
        _proc = spawn(pyExe, ['-u', scriptPath, '--log-file', logFile], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
            windowsHide: true,
        });
    } catch (e: any) {
        console.log('[py-broker] FATAL: spawn failed:', e.message || e);
        _readyError = 'spawn failed: ' + (e.message || e);
        return;
    }

    console.log('[py-broker] spawned pid=' + _proc.pid);

    _proc.stdout!.on('data', (chunk: Buffer) => {
        _buf += chunk.toString('utf-8');
        let nl: number;
        while ((nl = _buf.indexOf('\n')) !== -1) {
            const line = _buf.slice(0, nl);
            _buf = _buf.slice(nl + 1);
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'ready') {
                    _ready = true;
                    _readyError = null;
                    console.log('[py-broker] ready, platform=' + msg.platform);
                } else if (msg.id && _pending.has(msg.id)) {
                    const p = _pending.get(msg.id)!;
                    clearTimeout(p.timer);
                    _pending.delete(msg.id);
                    p.resolve(msg);
                }
            } catch { /* ignore */ }
        }
    });

    _proc.stderr!.on('data', (chunk: Buffer) => {
        console.log('[py-broker:stderr]', chunk.toString('utf-8').trim());
    });

    _proc.on('error', (e: Error) => {
        console.log('[py-broker] process error:', e.message || e);
        _readyError = 'process error: ' + (e.message || e);
    });

    _proc.on('exit', (code, signal) => {
        console.log('[py-broker] exited code=' + code + ' signal=' + signal);
        _ready = false;
        _readyError = 'exited code=' + code;
        _proc = null;
        for (const [id, p] of _pending) {
            clearTimeout(p.timer);
            p.reject(new Error('py-broker exited'));
        }
        _pending.clear();
    });
}

function _sendCommand(action: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!_ready) {
            reject(new Error('py-broker not ready: ' + (_readyError || 'unknown')));
            return;
        }
        if (!_proc || _proc.killed) {
            reject(new Error('py-broker not running'));
            return;
        }
        const id = _nextId++;
        const timer = setTimeout(() => {
            _pending.delete(id);
            reject(new Error('py-broker timeout: ' + action));
        }, 10000);

        _pending.set(id, { resolve, reject, timer });

        const cmd = JSON.stringify({ action, id, ...params });
        _proc.stdin!.write(cmd + '\n', (err: any) => {
            if (err) {
                clearTimeout(timer);
                _pending.delete(id);
                reject(err);
            }
        });
    });
}

/** 改名 DevTools 窗口 */
export async function renameDevToolsViaBroker(mainWin: BrowserWindow, projName: string): Promise<void> {
    try {
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

        if (result.ok) {
            console.log('[py-broker] renameDevTools OK: renamed=' + (result.renamed || 1) + ' title=' + title);
        } else {
            console.log('[py-broker] renameDevTools FAILED:', result.error);
        }
    } catch (e: any) {
        console.log('[py-broker] renameDevTools ERROR:', e.message || e);
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

/** 简单检查：broker 是否可用 */
export function isPyBrokerReady(): boolean { return _ready; }
