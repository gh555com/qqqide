// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// py-broker.ts — Python broker 生命周期管理
// 启动时 spawn py-broker.py 作为常驻子进程，stdin/stdout JSON 行协议通信。
// 用途：跨平台窗口标题改名（Win: ctypes / Mac: osascript / Linux: wmctrl）
// Python 路径唯一真理源: engines/manifest.json → getComponentBin('python')
//
// ★ node-broker 优先：如果 koffi 可用（Windows），先走 node-broker 零子进程路径。
//   失败回退 Python broker。
// ============================================================================

import { ChildProcess, spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getComponentBin, getComponentDir } from './component-checker';
import { isNodeBrokerAvailable, renameDevToolsViaNodeBroker } from './node-broker';

let _proc: ChildProcess | null = null;
let _pending: Map<number, { resolve: (r: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }> = new Map();
let _eventHandler: ((ev: any) => void) | null = null;

/** 注册 py-broker 主动事件回调（如编队热键召唤 summon） */
export function setPyBrokerEventHandler(fn: ((ev: any) => void) | null): void {
    _eventHandler = fn;
}
let _nextId = 1;
let _ready = false;
let _readyError: string | null = null;
let _buf = '';

export function startPyBroker(portableRoot: string): void {
    if (_proc) return;

    const pyExe = getComponentBin(portableRoot, 'python');
    if (!pyExe) {
        console.log('[py-broker] Python not installed. DevTools rename disabled. ' +
            'Python will auto-install as rank0 component on next boot.');
        return;
    }

    const scriptPath = path.join(__dirname, 'py-broker.py');

    console.log('[py-broker] starting: py=' + pyExe);

    if (!fs.existsSync(scriptPath)) {
        console.log('[py-broker] FATAL: script not found:', scriptPath);
        _readyError = 'script not found: ' + scriptPath;
        return;
    }

    try {
        const logFile = path.join(portableRoot, 'Data', 'Logs', '_py_broker.log');
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
                } else if (msg.type === 'event') {
                    try { if (_eventHandler) { _eventHandler(msg); } } catch { /* ignore */ }
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

/** 改名 DevTools 窗口 — node-broker 优先（koffi），失败回退 Python broker */
export async function renameDevToolsViaBroker(mainWin: BrowserWindow, projName: string): Promise<void> {
    // ── 路径 A: node-broker（koffi → Win32 API，零子进程）──
    if (isNodeBrokerAvailable()) {
        const ok = renameDevToolsViaNodeBroker(mainWin, projName);
        if (ok) return;
        console.log('[py-broker] node-broker failed, falling back to Python broker');
    }

    // ── 路径 B: Python broker（跨平台）──
    try {
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
        const result = await _sendCommand('rename-devtools', { mainHwnd, title });
        if (result.ok) {
            console.log('[py-broker] renameDevTools (py) OK: renamed=' + (result.renamed || 1) + ' title=' + title);
        } else {
            console.log('[py-broker] renameDevTools (py) FAILED:', result.error);
        }
    } catch (e: any) {
        console.log('[py-broker] renameDevTools (py) ERROR:', e.message || e);
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

// ═══════════════════════════════════════════════════════════════
// resolvePythonPath — 三级优先级找 Python 解释器
//   1. 绿色包自带 (gh555.com/engines/python/python.exe) — 最优先，环境隔离
//   2. Q 记录 (HKCU\Environment\QQQIDE_PYTHON_DIR) — C 启动器维护
//   3. 系统 PATH (python / python3) — 最后兜底
// ═══════════════════════════════════════════════════════════════

export function resolvePythonPath(portableRoot: string): string | null {
    // Level 1: 绿色包自带 Python
    const own = getComponentBin(portableRoot, 'python');
    if (own && fs.existsSync(own)) return own;

    // Level 2: Q 记录（注册表，仅 Windows）
    if (process.platform === 'win32') {
        try {
            const { execSync } = require('child_process');
            const stdout = execSync(
                'reg query HKCU\\Environment /v QQQIDE_PYTHON_DIR',
                { encoding: 'utf8', windowsHide: true, timeout: 5000 }
            );
            const m = stdout.match(/REG_SZ\s+(.+)/);
            if (m) {
                const qDir = m[1].trim();
                const qPy = path.join(qDir, 'python.exe');
                if (fs.existsSync(qPy)) return qPy;
            }
        } catch { /* no Q record */ }
    }

    // Level 3: 系统 PATH
    const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
    for (const cmd of candidates) {
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const exts = process.platform === 'win32'
            ? (process.env.PATHEXT || '.EXE;.BAT;.CMD;.COM').split(';').filter(Boolean)
            : [''];
        for (const dir of dirs) {
            for (const ext of exts) {
                const p = path.join(dir, cmd + ext);
                try { if (fs.statSync(p).isFile()) return p; } catch { /* skip */ }
            }
        }
    }

    return null;
}

/** 获取绿色包 Python 安装目录（用于 PATH 注入） */
export function getPythonDir(portableRoot: string): string | null {
    return getComponentDir(portableRoot, 'python');
}

export function isPyBrokerReady(): boolean {
    // node-broker 可用 → 总是就绪（不依赖 Python broker 启动）
    if (isNodeBrokerAvailable()) return true;
    return _ready;
}
