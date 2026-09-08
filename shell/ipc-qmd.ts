// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-qmd.ts — goods qmd 终端（ConPTY 全交互模式，Win10 1809+ 专属）
//
// 与 kmd（行模式）渲染哲学对立：qmd = 真终端。
//   输出 = xterm.js VT 网格（程序自己画屏）· 键入 = raw 字节透传
//   本地 TUI（vim/top/htop）/ REPL（python/node）/ 交互 CLI（ssh -t）全可用
//
// 链路：UI(xterm.js) ←IPC→ 主进程会话 ←行协议→ qmd-conpty.exe ←ConPTY→
//       conhost --headless ←→ shell（cmd/powershell/gitbash）
//
// 行协议（shell/qmd-conpty.c，全部 UTF-8 文本行）:
//   父 → 子 (bridge stdin):  W <base64>       写字节到 ConPTY 键入
//                            R <cols> <rows>  resize
//   子 → 父 (bridge stdout): R <pid>          ready（spawn 成功）
//                            D <base64>       ConPTY 输出字节（VT 流）
//                            E <code>         shell 退出
//                            X <msg>          spawn 失败
//
// ★ 排雷史（2026-09-07/08，node-pty conpty.cc 逆向定案）:
//   系统 CreatePseudoConsole 本机 attribute 无效 → 必须 conpty.dll（微软官方
//   107KB，node-pty 同款）ConptyCreatePseudoConsole；匿名管道键入不通 →
//   命名管道 + OVERLAPPED Connect 先行 + client CreateFile 配对；不设
//   STARTF_USESTDHANDLES 时 cmd 继承父 stdout 明文直写绕开 ConPTY → std 置空。
// ★ 输出编码: ConPTY 输出字节随 console 码页（中文系统 GBK）→ shell 启动即
//   chcp 65001（cmd /k 前缀 / PS -NoExit -Command）固定 UTF-8，xterm 直接吃。
// ★ 平台边界: ConPTY = Win10 1809+ OS API；Win7/8 永远 kmd 行模式（双轨共存）。
// ============================================================================

import { ipcMain, WebContents } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const MAX_SESSIONS = 16; // 会话上限，防进程泄漏（与 kmd 同）

export interface QmdSpawnOpts {
    id: string;
    shellType: 'cmd' | 'powershell' | 'gitbash';
    cwd?: string;
    cols?: number;
    rows?: number;
}

interface QmdSession {
    id: string;
    shellType: string;
    cwd: string;
    cols: number;
    rows: number;
    proc: ChildProcess;
    alive: boolean;
    ready: boolean;
    owner: WebContents;
    lineBuf: string; // bridge stdout 行缓冲（D 行可能跨 chunk）
}

const sessions = new Map<string, QmdSession>();

function _push(wc: WebContents, channel: string, payload: any): void {
    if (!wc || wc.isDestroyed()) return;
    try { wc.send(channel, payload); } catch { /* ignore */ }
}

// ── 引擎/资源根双路径（ipc-kmd._enginesRoot 同款）──
export function _qmdResourcesRoot(appRoot: string): string {
    const resApp = path.join(appRoot, 'resources', 'app');
    return fs.existsSync(path.join(resApp, 'server-app')) ? path.join(resApp, 'server-app') : path.join(appRoot, 'server-app');
}

export function _qmdBridgePath(appRoot: string): string | null {
    // dev: {appRoot}/server-app/goods/qmd/vendor；打包: {appRoot}/resources/app/server-app/goods/qmd/vendor
    const dir = path.join(_qmdResourcesRoot(appRoot), 'goods', 'qmd', 'vendor');
    const exe = path.join(dir, 'qmd-conpty.exe');
    return fs.existsSync(exe) ? exe : null;
}

// ── shell → QMD_CMDLINE 组装（编码/环境全在此收敛）──
export function _qmdCmdline(shellType: string, appRoot: string): { cmdline: string; env: NodeJS.ProcessEnv } | null {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (shellType === 'gitbash') {
        // git 组件内 bash（ipc-kmd._resolveShell 同款解析）；ConPTY 下 bash 原生 UTF-8
        try {
            const resApp = path.join(appRoot, 'resources', 'app');
            const gitDir = fs.existsSync(path.join(resApp, 'engines', 'git'))
                ? path.join(resApp, 'engines', 'git')
                : path.join(appRoot, 'engines', 'git');
            const bash = path.join(gitDir, 'bin', 'bash.exe');
            if (fs.existsSync(bash)) {
                env.MSYSTEM = 'MINGW64';
                env.CHERE_INVOKING = '1';
                if (!env.HOME) env.HOME = os.homedir();
                env.PATH = [
                    path.join(gitDir, 'usr', 'bin'),
                    path.join(gitDir, 'mingw64', 'bin'),
                    path.join(gitDir, 'bin'),
                    env.PATH || '',
                ].join(path.delimiter);
                return { cmdline: '"' + bash + '" --login -i', env };
            }
        } catch { /* ignore */ }
        // 系统 Git for Windows 兜底
        const sysCandidates: string[] = [
            'C:\\Program Files\\Git\\bin\\bash.exe',
            'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
            'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        ];
        for (const c of sysCandidates) {
            if (fs.existsSync(c)) return { cmdline: '"' + c + '" --norc -i', env };
        }
        return null;
    }
    if (shellType === 'powershell') {
        // ★ ConPTY 输出编码随 console 码页（中文系统 GBK）→ 启动即切 UTF-8，
        //   xterm.js 只吃 UTF-8。-NoExit 保持交互（真终端语义，无 -NoLogo：
        //   banner 走 VT 流不乱码，保留真实终端体验）
        return { cmdline: 'powershell.exe -NoProfile -NoExit -Command "chcp 65001 > $null"', env };
    }
    // cmd — /d 禁 AutoRun；/k chcp 65001 固定 UTF-8 输出（>nul 吞提示行）
    return { cmdline: 'cmd.exe /d /k chcp 65001 >nul', env };
}

function _killTree(s: QmdSession): void {
    if (!s.proc || s.proc.pid == null) return;
    s.alive = false;
    try {
        // bridge 是 shell 的父进程 → /T 杀全树（cmd/python 后代全灭；conhost 由
        // bridge ExitProcess 收尾 ConptyClosePseudoConsole 清理）
        spawn('taskkill', ['/F', '/T', '/PID', String(s.proc.pid)], { windowsHide: true, stdio: 'ignore' });
    } catch { /* ignore */ }
}

// bridge stdout 行协议解析（D 行可能跨 chunk → lineBuf 续接）
function _onBridgeData(s: QmdSession, chunk: Buffer): void {
    s.lineBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = s.lineBuf.indexOf('\n')) >= 0) {
        const line = s.lineBuf.slice(0, idx).replace(/\r$/, '');
        s.lineBuf = s.lineBuf.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('R ')) {
            s.ready = true;
            _push(s.owner, 'qqqide:qmd:ready', { id: s.id, pid: line.slice(2) });
        } else if (line.startsWith('D ')) {
            let buf: Buffer;
            try { buf = Buffer.from(line.slice(2), 'base64'); } catch { continue; }
            if (buf.length === 0) continue;
            _push(s.owner, 'qqqide:qmd:output', { id: s.id, data: buf.toString('utf8') });
        } else if (line.startsWith('E ')) {
            s.alive = false;
            if (sessions.get(s.id) !== s) return;
            _push(s.owner, 'qqqide:qmd:exit', { id: s.id, code: parseInt(line.slice(2), 10) || 0 });
            sessions.delete(s.id);
        } else if (line.startsWith('X ')) {
            s.alive = false;
            if (sessions.get(s.id) !== s) return;
            _push(s.owner, 'qqqide:qmd:exit', { id: s.id, code: -1, error: line.slice(2) });
            sessions.delete(s.id);
        }
    }
}

function _spawnOne(opts: QmdSpawnOpts, appRoot: string, owner: WebContents): QmdSession | null {
    const bridge = _qmdBridgePath(appRoot);
    if (!bridge) return null;
    const res = _qmdCmdline(opts.shellType, appRoot);
    if (!res) return null;

    const env: NodeJS.ProcessEnv = {
        ...res.env,
        QMD_CMDLINE: res.cmdline,
        QMD_CWD: opts.cwd || process.env.USERPROFILE || 'C:\\',
        QMD_COLS: String(opts.cols || 120),
        QMD_ROWS: String(opts.rows || 30),
    };

    let proc: ChildProcess;
    try {
        proc = spawn(bridge, [], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch { return null; }

    const s: QmdSession = {
        id: opts.id,
        shellType: opts.shellType,
        cwd: opts.cwd || '',
        cols: opts.cols || 120,
        rows: opts.rows || 30,
        proc,
        alive: true,
        ready: false,
        owner,
        lineBuf: '',
    };

    proc.stdout.on('data', (d: Buffer) => { if (s.alive) _onBridgeData(s, d); });
    proc.stderr.on('data', (d: Buffer) => {
        if (!s.alive) return;
        _push(s.owner, 'qqqide:qmd:output', { id: s.id, data: d.toString('utf8') });
    });
    proc.on('error', (err) => {
        s.alive = false;
        if (sessions.get(s.id) !== s) return; // 身份校验（重启竞态，kmd 同款）
        _push(s.owner, 'qqqide:qmd:exit', { id: s.id, code: -1, error: String((err as Error).message || err) });
        sessions.delete(s.id);
    });
    proc.on('exit', (code) => {
        s.alive = false;
        if (sessions.get(s.id) !== s) return; // 身份校验（taskkill 晚到 exit 不误删新会话）
        _push(s.owner, 'qqqide:qmd:exit', { id: s.id, code: code == null ? -1 : code });
        sessions.delete(s.id);
    });

    return s;
}

export function registerQmdIpc(appRoot: string): void {
    ipcMain.handle('qqqide:qmd:spawn', async (e, opts: any) => {
        const o = opts || {};
        const id = String(o.id || '');
        const shellType = String(o.shellType || 'cmd');
        if (!id || sessions.has(id)) return { ok: false, error: 'bad_id' };
        if (sessions.size >= MAX_SESSIONS) return { ok: false, error: 'session_limit' };
        if (shellType === 'gitbash') {
            if (!_qmdCmdline('gitbash', appRoot)) {
                return { ok: false, error: 'no_bash_found: 未找到可用的 Git Bash（git 组件缺失，重启 IDE 自动修复）' };
            }
        }
        const cwd = String(o.cwd || process.env.USERPROFILE || '');
        const s = _spawnOne({ id, shellType, cwd, cols: o.cols || 120, rows: o.rows || 30 }, appRoot, e.sender);
        if (!s) return { ok: false, error: 'spawn_failed' };
        sessions.set(id, s);
        return { ok: true, pid: s.proc.pid };
    });

    // 写键入: text → base64 → W 行（UTF-8 字节透传）
    ipcMain.handle('qqqide:qmd:write', async (_e, id: string, text: string) => {
        const s = sessions.get(String(id || ''));
        if (!s || !s.alive || !s.proc.stdin) return { ok: false, error: 'dead' };
        try {
            const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
            s.proc.stdin.write('W ' + b64 + '\n');
            return { ok: true };
        } catch (err) {
            return { ok: false, error: String((err as Error).message || err) };
        }
    });

    // resize: R <cols> <rows> → bridge ConptyResizePseudoConsole
    ipcMain.handle('qqqide:qmd:resize', async (_e, id: string, cols: number, rows: number) => {
        const s = sessions.get(String(id || ''));
        if (!s || !s.alive || !s.proc.stdin) return { ok: false, error: 'dead' };
        try {
            s.cols = Math.max(20, Math.min(500, cols || 120));
            s.rows = Math.max(5, Math.min(200, rows || 30));
            s.proc.stdin.write('R ' + s.cols + ' ' + s.rows + '\n');
            return { ok: true };
        } catch (err) {
            return { ok: false, error: String((err as Error).message || err) };
        }
    });

    // kill [opts.restart=true] → 杀 bridge 进程树后原地重启（会话 id 不变）
    ipcMain.handle('qqqide:qmd:kill', async (_e, id: string, opts: any) => {
        const sid = String(id || '');
        const s = sessions.get(sid);
        if (!s) return { ok: false, error: 'not_found' };
        const owner = s.owner;
        const shellType = s.shellType;
        const cwd = s.cwd;
        const cols = s.cols;
        const rows = s.rows;
        _killTree(s);
        sessions.delete(sid);
        if (opts && opts.restart) {
            const ns = _spawnOne({ id: sid, shellType, cwd, cols, rows }, appRoot, owner);
            if (ns) {
                sessions.set(sid, ns);
                _push(owner, 'qqqide:qmd:restarted', { id: sid });
            } else {
                _push(owner, 'qqqide:qmd:exit', { id: sid, code: -1, error: 'restart_failed: ' + shellType + ' 不可用' });
            }
        }
        return { ok: true };
    });

    ipcMain.handle('qqqide:qmd:list', async () => {
        const out: any[] = [];
        sessions.forEach((s) => {
            out.push({ id: s.id, shellType: s.shellType, cwd: s.cwd, cols: s.cols, rows: s.rows, ready: s.ready, alive: s.alive, pid: s.proc.pid });
        });
        return out;
    });
}

// 应用退出兜底：杀全部 qmd 会话（防孤儿）
export function killAllQmdSessions(): void {
    for (const s of sessions.values()) {
        _killTree(s);
    }
    sessions.clear();
}
