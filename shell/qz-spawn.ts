// ============================================================================
// qz-spawn.ts
// Unified spawn entry (qz subsystem).
//
// Tier 1: ghrun.exe  — Rust, full anti-hang, primary
// Tier 2: Node        — child_process.spawn, always-available fallback
//
// Protocol contract:
//   in : {cmd, args, cwd, env, timeout, stallMs, captureOutput}
//   out: {exitCode, stdout, stderr, killReason, tier, pid, durationMs}
//
// ghrun anti-hang (surpasses runner.py):
//   - deadline + stall watchdogs (100ms granularity)
//   - Windows: CREATE_NEW_PROCESS_GROUP + CREATE_NO_WINDOW + taskkill /F /T
//   - POSIX:   process_group(0) → killpg via kill -9 -<pid> + fallback
//   - Output safety-net at IPC level (64KB) — AI-facing limit is in tools.js
// ============================================================================

import { spawn as cpSpawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Output safety-net cap: prevents huge stdout/stderr from inflating IPC payloads.
// This is NOT the AI-facing limit — that lives in tools.js (OUTPUT_DEFAULT / OUTPUT_MAX).
// Set generously (64KB) so it never interferes with the AI-facing cap.
const MAX_OUTPUT = 65536;
function _capOutput(r: SpawnResult): SpawnResult {
    if (r.stdout.length > MAX_OUTPUT) { r.stdout = r.stdout.slice(0, MAX_OUTPUT) + '\n...(truncated)'; }
    if (r.stderr.length > MAX_OUTPUT) { r.stderr = r.stderr.slice(0, MAX_OUTPUT); }
    return r;
}

// ── System-level hard limits (defense-in-depth against runaway commands) ──
const SYSTEM_MAX_TIMEOUT = 600_000;  // 10 min — no command runs longer than this
const MEM_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;  // 2GB — kill if child exceeds this

/** Memory guard: polls process tree every 5s, kills if total WorkingSetSize > limit. */
function _startMemGuard(pid: number, killFn: () => void, limit: number): NodeJS.Timeout | null {
    if (process.platform !== 'win32') return null; // TODO: cgroups on Linux
    if (!pid || limit <= 0) return null;
    const interval = setInterval(() => {
        try {
            const { execSync } = require('child_process');
            // Sum WorkingSetSize of pid + all descendants via WMI
            const out = execSync(
                `powershell -NoProfile -Command "$sum=0; Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid} OR ParentProcessId=${pid}' -ErrorAction SilentlyContinue | ForEach-Object { $sum+=$_.WorkingSetSize }; $sum"`,
                { windowsHide: true, timeout: 5000, encoding: 'utf8' }
            ).trim();
            const bytes = parseInt(out, 10);
            if (!isNaN(bytes) && bytes > limit) {
                console.warn(`[qz] mem-guard: pid ${pid} tree at ${(bytes/1024/1024).toFixed(0)}MB > ${(limit/1024/1024).toFixed(0)}MB, killing tree`);
                killFn();
            }
        } catch { /* guard itself must never throw */ }
    }, 5000);
    return interval;
}

// Windows built-in commands (not real executables; need cmd /c wrapper)
const IS_WIN = process.platform === 'win32';
const WIN_BUILTINS = new Set([
    'dir', 'type', 'echo', 'copy', 'del', 'erase', 'set', 'cd', 'chdir',
    'md', 'mkdir', 'rmdir', 'rd', 'ren', 'rename', 'move', 'cls',
    'date', 'time', 'ver', 'vol', 'path', 'prompt', 'title', 'color',
    'assoc', 'ftype', 'pushd', 'popd', 'mklink', 'fc', 'comp',
    'find', 'findstr', 'more', 'sort', 'start',
]);

/** Normalize brief before dispatch: wrap Windows builtins with cmd /c */
function _normalizeBrief(brief: { cmd: string; args?: string[]; shell?: boolean }): void {
    if (!IS_WIN) { return; }
    if (!brief.cmd) { return; }
    if (WIN_BUILTINS.has(brief.cmd.toLowerCase())) {
        brief.args = ['/c', brief.cmd, ...(brief.args || [])];
        brief.cmd = 'cmd';
        brief.shell = false;
    }
}

export interface SpawnBrief {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;          // hard deadline ms (default 60_000)
    stallMs?: number;          // kill when no stdout/stderr for this long
    captureOutput?: boolean;   // capture stdout/stderr (default true)
    killOnDisconnect?: boolean;// kill child when parent exits (default true)
    shell?: boolean;           // use shell=true (default false; only true when cmd contains spaces and args missing)
    inheritEnv?: boolean;      // merge process.env (default true)
}

export interface SpawnResult {
    exitCode: number;          // -1 means killed / spawn error
    stdout: string;
    stderr: string;
    killReason: '' | 'deadline' | 'stall' | 'disconnect' | 'mem-guard' | 'spawn-error';
    tier: 'ghrun' | 'node';
    pid?: number;
    durationMs: number;
}
// ── Persist mode (long-lived process, e.g. LSP servers) ──

export interface PersistBrief {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    /** Idle timeout ─ kill if no message received for this many ms (0 = no timeout) */
    idleTimeout?: number;
    inheritEnv?: boolean;
}

export interface PersistHandle {
    pid: number;
    alive: () => boolean;

    /** Write a line to process stdin (appends \n). */
    send: (line: string) => void;

    /** Register handler for stdout lines (one JSON-RPC message per call). */
    onData: (handler: (data: string) => void) => void;

    /** Register handler for stderr output. */
    onStderr: (handler: (data: string) => void) => void;

    /** Register handler for process exit. */
    onExit: (handler: (code: number | null) => void) => void;

    /** Graceful shutdown: close stdin, wait for exit, then force-kill. */
    shutdown: () => Promise<void>;

    /** Force-kill immediately. */
    kill: () => void;
}



// ---------------------------------------------------------------------------
// Tier resolution helpers
// ---------------------------------------------------------------------------

let _ghrunBinCache: string | null | undefined = undefined; // undefined=未探测

function resolveGhrunBin(appRoot?: string): string | null {
    if (_ghrunBinCache !== undefined) { return _ghrunBinCache; }
    const env = process.env.QDIR_GHRUN;
    if (env && fs.existsSync(env)) { _ghrunBinCache = env; return env; }
    // also probe portable convention: $QDIR/ghrun.exe
    const qdir = process.env.QDIR;
    if (qdir) {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const p = path.join(qdir, 'ghrun' + ext);
        if (fs.existsSync(p)) { _ghrunBinCache = p; return p; }
    }
    // also probe engines/ghrun.exe under app root
    if (appRoot) {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const p = path.join(appRoot, 'engines', 'ghrun' + ext);
        if (fs.existsSync(p)) { _ghrunBinCache = p; return p; }
    }
    _ghrunBinCache = null;
    return null;
}

// ---------------------------------------------------------------------------
// Tier 2: Node child_process spawn (always available)
// ---------------------------------------------------------------------------

function nodeTier(brief: SpawnBrief, appRoot: string): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
        const start = Date.now();
        const args = brief.args || [];
        // A1: cap all timeouts at SYSTEM_MAX_TIMEOUT (10 min hard ceiling)
        const rawTimeout = brief.timeout != null ? brief.timeout : 60_000;
        const timeoutMs = rawTimeout > 0 ? Math.min(rawTimeout, SYSTEM_MAX_TIMEOUT) : SYSTEM_MAX_TIMEOUT;
        const stallMs = brief.stallMs != null ? brief.stallMs : 0;
        const capture = brief.captureOutput !== false;
        const inheritEnv = brief.inheritEnv !== false;
        const useShell = brief.shell === true;

        const env: NodeJS.ProcessEnv = inheritEnv ? { ...process.env, ...(brief.env || {}) } : { ...(brief.env || {}) };

        let proc: ChildProcess;
        try {
            proc = cpSpawn(brief.cmd, args, {
                cwd: brief.cwd || appRoot,
                windowsHide: true,
                shell: useShell,
                env,
                detached: process.platform !== 'win32', // POSIX: own process group
            });
        } catch (err: any) {
            return resolve({
                exitCode: -1,
                stdout: '',
                stderr: String(err && err.message || err),
                killReason: 'spawn-error',
                tier: 'node',
                durationMs: Date.now() - start,
            });
        }

        let stdout = '';
        let stderr = '';
        let killed = false;
        let killReason: SpawnResult['killReason'] = '';
        let lastIOAt = Date.now();

        const killTree = () => {
            if (!proc.pid) { return; }
            try {
                if (process.platform === 'win32') {
                    // Tree kill: taskkill /F /T /PID <pid>
                    cpSpawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true });
                } else {
                    try { process.kill(-proc.pid, 'SIGKILL'); }
                    catch { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
                }
            } catch { /* ignore */ }
        };

        if (capture && proc.stdout) {
            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (d: string) => { stdout += d; lastIOAt = Date.now(); });
        }
        if (capture && proc.stderr) {
            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', (d: string) => { stderr += d; lastIOAt = Date.now(); });
        }

        // A4: memory guard — poll child WorkingSet64 every 5s, kill if > 2GB
        const memGuardInterval = proc.pid ? _startMemGuard(proc.pid, () => {
            killed = true;
            killReason = 'mem-guard';
            killTree();
        }, MEM_LIMIT_BYTES) : null;

        // A1/A3: deadline timer — always active (timeoutMs guaranteed ≤ SYSTEM_MAX_TIMEOUT)
        const deadlineTimer = setTimeout(() => {
            killed = true;
            killReason = 'deadline';
            killTree();
        }, timeoutMs);

        let stallTimer: NodeJS.Timeout | null = null;
        if (stallMs > 0) {
            const tick = () => {
                if (killed) { return; }
                if (Date.now() - lastIOAt > stallMs) {
                    killed = true;
                    killReason = 'stall';
                    killTree();
                    return;
                }
                stallTimer = setTimeout(tick, Math.max(1000, Math.floor(stallMs / 4)));
            };
            stallTimer = setTimeout(tick, Math.max(1000, Math.floor(stallMs / 4)));
        }

        const cleanup = () => {
            clearTimeout(deadlineTimer);
            if (stallTimer) { clearTimeout(stallTimer); }
            if (memGuardInterval) { clearInterval(memGuardInterval); }
        };

        proc.on('exit', (code) => {
            cleanup();
            const extra = killed ? `\n[killed: ${killReason} after ${Date.now() - start}ms]` : '';
            resolve({
                exitCode: killed ? -1 : (code ?? -1),
                stdout,
                stderr: stderr + extra,
                killReason,
                tier: 'node',
                pid: proc.pid,
                durationMs: Date.now() - start,
            });
        });
        proc.on('error', (err: Error) => {
            cleanup();
            resolve({
                exitCode: -1,
                stdout,
                stderr: stderr + '\n' + (err.message || String(err)),
                killReason: 'spawn-error',
                tier: 'node',
                pid: proc.pid,
                durationMs: Date.now() - start,
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Tier 1: ghrun.exe — Rust, surpasses runner.py (deadline + stall + killpg + output cap + error diff)
//
// Wire format: ghrun spawn --json, stdin one-line JSON, stdout one-line JSON.
// ---------------------------------------------------------------------------

function ghrunTier(brief: SpawnBrief, appRoot: string, ghrunBin: string): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
        const start = Date.now();
        // A1: cap all timeouts at SYSTEM_MAX_TIMEOUT (10 min hard ceiling)
        const rawTimeout = brief.timeout != null ? brief.timeout : 60_000;
        const timeoutMs = rawTimeout > 0 ? Math.min(rawTimeout, SYSTEM_MAX_TIMEOUT) : SYSTEM_MAX_TIMEOUT;
        // A2: guardMs always timeout+10s, never 24h (was: 86400000 when timeout=0)
        const guardMs = timeoutMs + 10_000;

        const payload = JSON.stringify({
            cmd: brief.cmd,
            args: brief.args || [],
            cwd: brief.cwd || appRoot,
            env: brief.env || null,
            timeout: timeoutMs,
            stallMs: brief.stallMs || 0,
            memLimitMb: Math.floor(MEM_LIMIT_BYTES / (1024 * 1024)),  // B2: native Job Object hint (honored when ghrun supports it)
            captureOutput: brief.captureOutput !== false,
        });

        let proc: ChildProcess;
        try {
            proc = cpSpawn(ghrunBin, ['spawn', '--json'], {
                cwd: appRoot,
                windowsHide: true,
                env: { ...process.env },
            });
        } catch (err: any) {
            return resolve({
                exitCode: -1, stdout: '', stderr: String(err && err.message || err),
                killReason: 'spawn-error', tier: 'ghrun', durationMs: Date.now() - start,
            });
        }

        let outBuf = '';
        let errBuf = '';
        let done = false;
        // A4: memory guard for ghrun tier — monitor ghrun's process tree
        // Uses PowerShell to sum WorkingSet64 of ghrun + all descendants
        const memGuardInterval = proc.pid ? _startMemGuard(proc.pid, () => {
            if (!done) {
                finish({
                    exitCode: -1, stdout: outBuf, stderr: 'ghrun_mem_guard_killed',
                    killReason: 'mem-guard', tier: 'ghrun',
                    pid: proc.pid, durationMs: Date.now() - start,
                });
            }
        }, MEM_LIMIT_BYTES) : null;
        const finish = (r: SpawnResult) => {
            if (done) { return; }
            done = true;
            clearTimeout(guard);
            if (memGuardInterval) { clearInterval(memGuardInterval); }
            try { proc.kill(); } catch { /* ignore */ }
            resolve(r);
        };

        proc.stdout!.setEncoding('utf8');
        proc.stderr!.setEncoding('utf8');
        proc.stdout!.on('data', (d: string) => { outBuf += d; });
        proc.stderr!.on('data', (d: string) => { errBuf += d; });
        proc.on('exit', (code) => {
            if (done) { return; }
            const nl = outBuf.indexOf('\n');
            const line = nl >= 0 ? outBuf.slice(0, nl) : outBuf;
            try {
                const r = JSON.parse(line);
                finish({
                    exitCode: typeof r.exitCode === 'number' ? r.exitCode : (code ?? -1),
                    stdout: String(r.stdout || ''),
                    stderr: String(r.stderr || ''),
                    killReason: (r.killReason || '') as SpawnResult['killReason'],
                    tier: 'ghrun', pid: proc.pid, durationMs: Date.now() - start,
                });
            } catch {
                finish({
                    exitCode: code ?? -1, stdout: outBuf, stderr: errBuf || 'ghrun_bad_json',
                    killReason: 'spawn-error', tier: 'ghrun',
                    pid: proc.pid, durationMs: Date.now() - start,
                });
            }
        });
        proc.on('error', (err: Error) => finish({
            exitCode: -1, stdout: '', stderr: String(err.message || err),
            killReason: 'spawn-error', tier: 'ghrun',
            pid: proc.pid, durationMs: Date.now() - start,
        }));

        const guard = setTimeout(() => finish({
            exitCode: -1, stdout: '', stderr: 'ghrun_guard_timeout',
            killReason: 'deadline', tier: 'ghrun',
            pid: proc.pid, durationMs: Date.now() - start,
        }), guardMs);

        try { proc.stdin!.write(payload + '\n'); proc.stdin!.end(); }
        catch (err: any) {
            finish({
                exitCode: -1, stdout: '', stderr: String(err.message || err),
                killReason: 'spawn-error', tier: 'ghrun',
                pid: proc.pid, durationMs: Date.now() - start,
            });
        }
    });
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export class QzSpawn {

    constructor(private appRoot: string) { }

    /** Probe ghrun availability (synchronous file check). */
    ghrunAlive(): boolean {
        return !!resolveGhrunBin(this.appRoot);
    }

    /**
     * Locate a command in $PATH (synchronous, posix `command -v` equivalent).
     * Returns absolute path or null if not found.
     */
    which(cmd: string): string | null {
        if (!cmd) { return null; }
        if (path.isAbsolute(cmd)) {
            return fs.existsSync(cmd) ? cmd : null;
        }
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const exts = process.platform === 'win32'
            ? (process.env.PATHEXT || '.EXE;.BAT;.CMD;.COM').split(';').filter(Boolean)
            : [''];
        for (const dir of dirs) {
            for (const ext of exts) {
                const p = path.join(dir, cmd + ext);
                try { if (fs.statSync(p).isFile()) { return p; } } catch { /* skip */ }
            }
        }
        return null;
    }

    /** Unified spawn entry. Two-tier: ghrun → node child_process. */
    async spawn(brief: SpawnBrief): Promise<SpawnResult> {
        if (!brief || !brief.cmd) {
            return {
                exitCode: -1, stdout: '', stderr: 'qz.spawn: missing brief.cmd',
                killReason: 'spawn-error', tier: 'node', durationMs: 0,
            };
        }
        _normalizeBrief(brief);

        // A1: enforce system max timeout — no command runs longer than 10 minutes
        if (brief.timeout == null || brief.timeout <= 0 || brief.timeout > SYSTEM_MAX_TIMEOUT) {
            brief.timeout = SYSTEM_MAX_TIMEOUT;
        }

        // Tier 1: ghrun (Rust, full anti-hang: deadline + stall + tree-kill + process group isolation)
        const ghrun = resolveGhrunBin(this.appRoot);
        if (ghrun) {
            try {
                const r = await ghrunTier(brief, this.appRoot, ghrun);
                if (r.killReason !== 'spawn-error') {
                    if (r.killReason) {
                        console.warn('[qz] ghrun killed:', brief.cmd, 'reason:', r.killReason, r.durationMs + 'ms');
                    } else {
                        console.log('[qz] ghrun OK:', brief.cmd, r.durationMs + 'ms');
                    }
                    return _capOutput(r);
                }
                console.warn('[qz] ghrun spawn-error, falling back to node:', r.stderr.slice(0, 200));
            } catch (e: any) {
                console.warn('[qz] ghrun threw, falling back to node:', e && e.message);
            }
        }

        // Tier 2: node (always available)
        return _capOutput(await nodeTier(brief, this.appRoot));
    }
    /** Spawn a long-lived process with persistent stdin/stdout.
     *  Used by LSP bridge — process stays alive, messages flow bidirectionally. */
    spawnPersist(brief: PersistBrief): PersistHandle | null {
        if (!brief || !brief.cmd) {
            console.error('[qz] spawnPersist: missing brief.cmd');
            return null;
        }

        const args = brief.args || [];
        const cwd = brief.cwd || this.appRoot;
        const inheritEnv = brief.inheritEnv !== false;
        const env: NodeJS.ProcessEnv = inheritEnv
            ? { ...process.env, ...(brief.env || {}) }
            : { ...(brief.env || {}) };
        const idleTimeout = brief.idleTimeout || 0;

        let proc: ChildProcess;
        try {
            proc = cpSpawn(brief.cmd, args, {
                cwd,
                windowsHide: true,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (err: any) {
            console.error('[qz] spawnPersist error:', err?.message || err);
            return null;
        }

        if (!proc.stdin || !proc.stdout) {
            console.error('[qz] spawnPersist: no stdio pipes');
            try { proc.kill(); } catch { /* ignore */ }
            return null;
        }

        const dataHandlers: Array<(data: string) => void> = [];
        const stderrHandlers: Array<(data: string) => void> = [];
        const exitHandlers: Array<(code: number | null) => void> = [];
        let alive = true;
        let lastDataAt = Date.now();
        let idleTimer: NodeJS.Timeout | null = null;

        // --- Idle timeout watchdog ---
        if (idleTimeout > 0) {
            const tick = () => {
                if (!alive) return;
                if (Date.now() - lastDataAt > idleTimeout) {
                    console.warn('[qz] spawnPersist idle timeout, killing:', brief.cmd);
                    try { proc.kill(); } catch { /* ignore */ }
                    return;
                }
                idleTimer = setTimeout(tick, Math.max(5000, Math.floor(idleTimeout / 4)));
            };
            idleTimer = setTimeout(tick, Math.max(5000, Math.floor(idleTimeout / 4)));
        }

        // --- stdout: accumulate and emit line-by-line (LSP Content-Length header aware) ---
        let stdoutBuf = '';
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk: string) => {
            lastDataAt = Date.now();
            stdoutBuf += chunk;
            // Try to extract complete LSP messages (Content-Length: N\r\n\r\n{...})
            // If not LSP, emit raw lines on newline boundaries
            while (stdoutBuf.length > 0) {
                const lspMatch = stdoutBuf.match(/^Content-Length: (\d+)\r\n\r\n/);
                if (lspMatch) {
                    const headerLen = lspMatch[0].length;
                    const bodyLen = parseInt(lspMatch[1], 10);
                    // Reject oversized frames (aligns with lsp_daemon.rs 50MB)
                    if (isNaN(bodyLen) || bodyLen > 50 * 1024 * 1024) {
                        stdoutBuf = ''; // discard corrupted data
                        break;
                    }
                    if (stdoutBuf.length >= headerLen + bodyLen) {
                        const body = stdoutBuf.slice(headerLen, headerLen + bodyLen);
                        stdoutBuf = stdoutBuf.slice(headerLen + bodyLen);
                        for (const h of dataHandlers) { h(body); }
                        continue;
                    } else {
                        break; // incomplete message, wait for more data
                    }
                }
                // Fallback: emit on newline boundaries
                const nl = stdoutBuf.indexOf('\n');
                if (nl >= 0) {
                    const line = stdoutBuf.slice(0, nl);
                    stdoutBuf = stdoutBuf.slice(nl + 1);
                    if (line.trim()) {
                        for (const h of dataHandlers) { h(line); }
                    }
                    continue;
                }
                break; // no complete line found
            }
        });

        // --- stderr ---
        if (proc.stderr) {
            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', (chunk: string) => {
                lastDataAt = Date.now();
                for (const h of stderrHandlers) { h(chunk); }
            });
        }

        // --- exit ---
        proc.on('exit', (code) => {
            alive = false;
            if (idleTimer) { clearTimeout(idleTimer); }
            for (const h of exitHandlers) { h(code); }
        });

        proc.on('error', (err: Error) => {
            console.error('[qz] spawnPersist process error:', err?.message || err);
            alive = false;
            if (idleTimer) { clearTimeout(idleTimer); }
            for (const h of exitHandlers) { h(-1); }
        });

        const handle: PersistHandle = {
            pid: proc.pid || 0,
            alive: () => alive,
            send: (line: string) => {
                if (!alive || !proc.stdin) return;
                try {
                    proc.stdin.write(line + '\n');
                } catch (e) {
                    console.error('[qz] spawnPersist write error:', e);
                }
            },
            onData: (handler) => { dataHandlers.push(handler); },
            onStderr: (handler) => { stderrHandlers.push(handler); },
            onExit: (handler) => { exitHandlers.push(handler); },
            shutdown: async () => {
                if (!alive) return;
                try { proc.stdin?.end(); } catch { /* ignore */ }
                // Wait up to 5s for graceful exit
                await new Promise<void>((resolve) => {
                    const t = setTimeout(() => { try { proc.kill(); } catch { /* */ } resolve(); }, 5000);
                    proc.on('exit', () => { clearTimeout(t); resolve(); });
                });
            },
            kill: () => {
                if (!alive) return;
                alive = false;
                if (idleTimer) { clearTimeout(idleTimer); }
                try { proc.kill(); } catch { /* ignore */ }
            },
        };

        return handle;
    }

}
