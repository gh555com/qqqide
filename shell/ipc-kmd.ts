// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-kmd.ts — goods kmd 终端（v1 行模式）
//
// 分裂架构（2026-08-10 定案）：
//   · 输出 = 日志式渲染器：主进程管道流式推送（无 PTY、无 VT 网格）
//   · 输入 = iframe 内原生 input 控件 → 点击任意位置移动光标 = 零成本招牌能力
//
// 行模式边界（设计内行为，非 bug）：
//   · 本地 TUI（vim/top/htop）不可用 —— 无 PTY，程序检测到非 tty
//   · 交互式行编辑（readline/PSReadLine）不生效 —— 由 UI 输入行接管
//   · Win7 全兼容 —— 零额外依赖（无 ConPTY 依赖）
//   · 远端 TUI 可部分绕过：ssh -t 强制远端 pty + 输入行 raw 透传（v2）
//
// 编码：cmd/powershell 管道输出 = OEM 码页（中文系统 GBK）→ TextDecoder('gbk')
//       gitbash 输出 UTF-8 → TextDecoder('utf-8')
// ============================================================================

import { ipcMain, WebContents } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as iconv from 'iconv-lite';

const MAX_SESSIONS = 16; // 会话上限，防进程泄漏

export interface KmdSpawnOpts {
    id: string;
    shellType: 'cmd' | 'powershell' | 'gitbash';
    cwd?: string;
}

interface KmdSession {
    id: string;
    shellType: string;
    cwd: string;
    proc: ChildProcess;
    alive: boolean;
    owner: WebContents;
    decoder: TextDecoder;
    gbk: boolean; // stdin 编码：cmd/powershell = GBK（OEM 码页），gitbash = UTF-8
}

const sessions = new Map<string, KmdSession>();

function _push(wc: WebContents, channel: string, payload: any): void {
    if (!wc || wc.isDestroyed()) return;
    try { wc.send(channel, payload); } catch { /* ignore */ }
}

// ── Shell 解析（自给自足：git 组件内 bash 优先，系统 Git 兑底） ──
function _resolveShell(shellType: string, appRoot: string): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (shellType === 'gitbash') {
        // ① 自带组件：git = Git for Windows Portable（2026-08-11 B 方案）→ bin/bash.exe
        //    登录 shell（--login）加载 /etc/profile 构建 MSYS PATH；MSYSTEM=MINGW64 选中 64 位运行时；
        //    CHERE_INVOKING=1 保持 spawn cwd（登录 shell 默认回 HOME）
        try {
            const gitDir = path.join(appRoot, 'engines', 'git');
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
                return { cmd: bash, args: ['--login', '-i'], env };
            }
        } catch { /* ignore */ }
        // ② 系统 Git for Windows（PATH 或注册表探测）
        const sysCandidates: string[] = [
            'C:\\Program Files\\Git\\bin\\bash.exe',
            'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
            'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        ];
        for (const c of sysCandidates) {
            if (fs.existsSync(c)) {
                return { cmd: c, args: ['--norc', '-i'], env };
            }
        }
        return null; // 无可用 bash → spawn_failed（UI 给出明确提示）
    }
    if (shellType === 'powershell') {
        // PS 2.0 兼容（Win7 出厂）：-NoExit 保持 stdin 交互；-NoLogo 去 banner（banner 走 UTF-16 管道会乱码）
        // 管道输出统一 OEM 码页(GBK)，UI 层 GBK 解码
        return { cmd: 'powershell.exe', args: ['-NoProfile', '-NoLogo', '-NoExit'], env };
    }
    // cmd — ComSpec 为系统真理
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/q'], env };
}

// bash probe：MinGit 精简版可能缺 MSYS2 运行时（0xC0000135 DLL not found）→ 启动前验证
function _probeBash(bashPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        let p: ChildProcess;
        try {
            p = spawn(bashPath, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch { resolve(false); return; }
        let out = '';
        p.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        p.on('error', () => resolve(false));
        const t = setTimeout(() => {
            try { p.kill(); } catch { /* ignore */ }
            resolve(false);
        }, 2000);
        p.on('exit', (code) => {
            clearTimeout(t);
            resolve(code === 0 && out.length > 0);
        });
    });
}

function _killTree(s: KmdSession): void {
    if (!s.proc || s.proc.pid == null) return;
    s.alive = false;
    if (process.platform === 'win32') {
        // CREATE_NEW_PROCESS_GROUP 语义下 taskkill /T 杀全树（含后代）
        try {
            spawn('taskkill', ['/F', '/T', '/PID', String(s.proc.pid)], { windowsHide: true, stdio: 'ignore' });
        } catch { /* ignore */ }
    } else {
        try { process.kill(-s.proc.pid, 'SIGKILL'); } catch { /* ignore */ }
        try { s.proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
}

function _spawnOne(opts: KmdSpawnOpts, appRoot: string, owner: WebContents): KmdSession | null {
    const res = _resolveShell(opts.shellType, appRoot);
    if (!res) return null;

    // 编码：cmd/powershell 管道输出 = OEM 码页(GBK)；gitbash = UTF-8
    const gbk = opts.shellType !== 'gitbash';
    let decoder: TextDecoder;
    try { decoder = new TextDecoder(gbk ? 'gbk' : 'utf-8'); } catch { decoder = new TextDecoder('utf-8'); }

    let proc: ChildProcess;
    try {
        proc = spawn(res.cmd, res.args, {
            cwd: opts.cwd || undefined,
            env: res.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch { return null; }

    const s: KmdSession = {
        id: opts.id,
        shellType: opts.shellType,
        cwd: opts.cwd || '',
        proc,
        alive: true,
        owner,
        decoder,
        gbk,
    };

    proc.stdout.on('data', (d: Buffer) => {
        if (!s.alive) return;
        let text: string;
        try { text = s.decoder.decode(d, { stream: true }); } catch { text = d.toString('utf8'); }
        _push(s.owner, 'qqqide:kmd:output', { id: s.id, stream: 'out', data: text });
    });
    // 会话 stdin 编码：cmd/powershell 走 GBK（中文系统 OEM 码页），gitbash 走 UTF-8
    if (s.gbk) {
        const rawWrite = s.proc.stdin.write.bind(s.proc.stdin);
        s.proc.stdin.write = ((chunk: any, ...rest: any[]) => {
            if (typeof chunk === 'string') {
                try { chunk = iconv.encode(chunk, 'gbk'); } catch { /* ignore */ }
            }
            return rawWrite(chunk, ...(rest as any));
        }) as any;
    }
    proc.stderr.on('data', (d: Buffer) => {
        if (!s.alive) return;
        let text: string;
        try { text = s.decoder.decode(d, { stream: true }); } catch { text = d.toString('utf8'); }
        _push(s.owner, 'qqqide:kmd:output', { id: s.id, stream: 'err', data: text });
    });
    proc.on('error', (err) => {
        s.alive = false;
        // 身份校验（2026-08-11 重启竞态根治）：kill+restart 后旧进程的 exit/error 事件
        // 到达时 map 里已是新会话 → 必须忽略，否则删掉新会话 + 推假"已退出"
        if (sessions.get(s.id) !== s) return;
        _push(s.owner, 'qqqide:kmd:exit', { id: s.id, code: -1, error: String(err && err.message || err) });
        sessions.delete(s.id);
    });
    proc.on('exit', (code) => {
        s.alive = false;
        // 身份校验（2026-08-11 重启竞态根治）：同上——旧会话被 taskkill 杀后 exit(code=1)
        // 异步到达，若此时 map 中已是新会话 → 忽略（截图"进程已退出(code=1)+会话未就绪"根因）
        if (sessions.get(s.id) !== s) return;
        _push(s.owner, 'qqqide:kmd:exit', { id: s.id, code });
        sessions.delete(s.id);
    });

    return s;
}

export function registerKmdIpc(appRoot: string): void {
    ipcMain.handle('qqqide:kmd:spawn', async (e, opts: any) => {
        const o = opts || {};
        const id = String(o.id || '');
        const shellType = String(o.shellType || 'cmd');
        if (!id || sessions.has(id)) return { ok: false, error: 'bad_id' };
        if (sessions.size >= MAX_SESSIONS) return { ok: false, error: 'session_limit' };
        const cwd = String(o.cwd || process.env.USERPROFILE || '');
        // gitbash 先 probe：自带组件损坏（如解压中断）时给出明确报错而非黑屏
        if (shellType === 'gitbash') {
            const probeRes = _resolveShell('gitbash', appRoot);
            if (!probeRes) return { ok: false, error: 'no_bash_found: 未找到可用的 Git Bash（git 组件缺失，重启 IDE 自动修复）' };
            const ok = await _probeBash(probeRes.cmd);
            if (!ok) return { ok: false, error: 'bash_broken: 检测到 bash 但无法运行（git 组件异常，重启 IDE 自动修复）' };
        }
        const s = _spawnOne({ id, shellType, cwd }, appRoot, e.sender);
        if (!s) return { ok: false, error: 'spawn_failed' };
        sessions.set(id, s);
        return { ok: true, pid: s.proc.pid };
    });

    ipcMain.handle('qqqide:kmd:write', async (_e, id: string, text: string) => {
        const s = sessions.get(String(id || ''));
        if (!s || !s.alive || !s.proc.stdin) return { ok: false, error: 'dead' };
        try {
            s.proc.stdin.write(String(text ?? ''));
            return { ok: true };
        } catch (err) {
            return { ok: false, error: String((err as Error).message || err) };
        }
    });

    // kill [opts.restart=true] → 杀进程树后主进程同 cwd 同 shell 原地重启（会话 id 不变）
    ipcMain.handle('qqqide:kmd:kill', async (_e, id: string, opts: any) => {
        const sid = String(id || '');
        const s = sessions.get(sid);
        if (!s) return { ok: false, error: 'not_found' };
        const owner = s.owner;
        const shellType = s.shellType;
        const cwd = s.cwd;
        _killTree(s);
        sessions.delete(sid);
        if (opts && opts.restart) {
            const ns = _spawnOne({ id: sid, shellType, cwd }, appRoot, owner);
            if (ns) {
                sessions.set(sid, ns);
                _push(owner, 'qqqide:kmd:restarted', { id: sid });
            } else {
                // 重启失败（如 gitbash 无可用 bash）→ 如实上报，UI 显示原因而非静默
                _push(owner, 'qqqide:kmd:exit', { id: sid, code: -1, error: 'restart_failed: ' + shellType + ' 不可用' });
            }
        }
        return { ok: true };
    });

    ipcMain.handle('qqqide:kmd:list', async () => {
        const out: any[] = [];
        sessions.forEach((s) => {
            out.push({ id: s.id, shellType: s.shellType, cwd: s.cwd, alive: s.alive, pid: s.proc.pid });
        });
        return out;
    });
}

// 应用退出兜底：杀全部会话进程树（防孤儿进程）
export function killAllKmdSessions(): void {
    for (const s of sessions.values()) {
        _killTree(s);
    }
    sessions.clear();
}
