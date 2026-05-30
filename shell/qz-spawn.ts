// ============================================================================
// qz-spawn.ts
// Unified spawn entry (qz subsystem) - three-tier fallback.
//
// Tier 1: ghrun.exe (Rust unified runtime, when QDIR_GHRUN env is set)
// Tier 2: engines/runner.py (Python stdlib-only fallback)
// Tier 3: Node child_process.spawn (last resort)
//
// All tiers MUST honor the spawn-protocol contract:
//   in : {cmd, args, cwd, env, timeout, captureOutput, killOnDisconnect}
//   out: {exitCode, stdout, stderr, killReason}
//
// Anti-hang protection (per "我们到底要做什吗" §2.5):
//   - Windows  : detached + windowsHide, kill entire tree on timeout (taskkill /T)
//   - POSIX    : detached so kill(-pid) reaches the whole process group
//   - Triple watchdog: deadline (hard timeout) + stall (no-output) + heartbeat
// ============================================================================

import { spawn as cpSpawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
    killReason: '' | 'deadline' | 'stall' | 'disconnect' | 'spawn-error';
    tier: 'ghrun' | 'runner' | 'node';
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

function resolveGhrunBin(appRoot?: string): string | null {
    const env = process.env.QDIR_GHRUN;
    if (env && fs.existsSync(env)) { return env; }
    // also probe portable convention: $QDIR/ghrun.exe
    const qdir = process.env.QDIR;
    if (qdir) {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const p = path.join(qdir, 'ghrun' + ext);
        if (fs.existsSync(p)) { return p; }
    }
    // also probe engines/ghrun.exe under app root
    if (appRoot) {
        const ext = process.platform === 'win32' ? '.exe' : '';
        const p = path.join(appRoot, 'engines', 'ghrun' + ext);
        if (fs.existsSync(p)) { return p; }
    }
    return null;
}

function findWindowsPython(): string | null {
    // Windows: try 'py' launcher first (Windows 10+), then common paths
    const tries = ['py', 'py.exe', 'python', 'python.exe', 'python3', 'python3.exe'];
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const cmd of tries) {
        for (const dir of pathDirs) {
            const full = path.join(dir, cmd);
            try { if (fs.statSync(full).isFile()) return cmd; } catch { /* skip */ }
        }
    }
    return 'python'; // fallback, let spawn fail with clear error
}

function resolveRunner(appRoot: string): { script: string; python: string } | null {
    const candidates = [
        path.join(appRoot, 'engines', 'runner.py'),
        path.join(appRoot, 'resources', 'app', 'engines', 'runner.py'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            const py = process.env.QQQ_PYTHON
                || (process.platform === 'win32' ? findWindowsPython() : 'python3');
            return { script: p, python: py || 'python' };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Tier 3: Node child_process spawn (always available)
// ---------------------------------------------------------------------------

function nodeTier(brief: SpawnBrief, appRoot: string): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
        const start = Date.now();
        const args = brief.args || [];
        const timeoutMs = brief.timeout && brief.timeout > 0 ? brief.timeout : 60_000;
        const stallMs = brief.stallMs && brief.stallMs > 0 ? brief.stallMs : 0;
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
// Tier 2: runner.py (Python stdlib-only stdio JSON RPC, one-shot per call)
//
// Wire format:
//   stdin : <single line JSON> {brief...}\n
//   stdout: <single line JSON> {result...}\n
// runner.py applies the same anti-hang protection internally.
// ---------------------------------------------------------------------------

function runnerTier(brief: SpawnBrief, appRoot: string, resolved: { script: string; python: string }): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
        const start = Date.now();
        const timeoutMs = brief.timeout && brief.timeout > 0 ? brief.timeout : 60_000;
        // Outer guard = 5s + inner deadline (so the wrapper itself never hangs).
        const guardMs = timeoutMs + 5_000;

        let proc: ChildProcess;
        try {
            proc = cpSpawn(resolved.python, ['-u', resolved.script], {
                cwd: appRoot,
                windowsHide: true,
                env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
                detached: process.platform !== 'win32',
            });
        } catch (err: any) {
            return resolve({
                exitCode: -1, stdout: '', stderr: String(err && err.message || err),
                killReason: 'spawn-error', tier: 'runner', durationMs: Date.now() - start,
            });
        }

        let outBuf = '';
        let errBuf = '';
        let killed = false;
        let resolved2 = false;

        const safeResolve = (r: SpawnResult) => {
            if (resolved2) { return; }
            resolved2 = true;
            clearTimeout(guardTimer);
            try { proc.kill(); } catch { /* ignore */ }
            resolve(r);
        };

        proc.stdout!.setEncoding('utf8');
        proc.stderr!.setEncoding('utf8');
        proc.stdout!.on('data', (d: string) => {
            outBuf += d;
            // try to find first newline → that's our result line
            const nl = outBuf.indexOf('\n');
            if (nl >= 0) {
                const line = outBuf.slice(0, nl);
                try {
                    const r = JSON.parse(line);
                    safeResolve({
                        exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1,
                        stdout: String(r.stdout || ''),
                        stderr: String(r.stderr || ''),
                        killReason: (r.killReason || '') as SpawnResult['killReason'],
                        tier: 'runner',
                        pid: proc.pid,
                        durationMs: Date.now() - start,
                    });
                } catch (e) {
                    // bad JSON; treat as failure
                    safeResolve({
                        exitCode: -1, stdout: '', stderr: 'runner_bad_json: ' + line.slice(0, 200),
                        killReason: 'spawn-error', tier: 'runner', durationMs: Date.now() - start,
                    });
                }
            }
        });
        proc.stderr!.on('data', (d: string) => { errBuf += d; });
        proc.on('exit', (code) => {
            if (resolved2) { return; }
            // exited without a result line
            safeResolve({
                exitCode: code ?? -1, stdout: '', stderr: errBuf || 'runner_no_result',
                killReason: killed ? 'deadline' : '', tier: 'runner',
                pid: proc.pid, durationMs: Date.now() - start,
            });
        });
        proc.on('error', (err: Error) => {
            safeResolve({
                exitCode: -1, stdout: '', stderr: String(err.message || err),
                killReason: 'spawn-error', tier: 'runner',
                pid: proc.pid, durationMs: Date.now() - start,
            });
        });

        const guardTimer = setTimeout(() => {
            killed = true;
            safeResolve({
                exitCode: -1, stdout: '', stderr: 'runner_guard_timeout',
                killReason: 'deadline', tier: 'runner',
                pid: proc.pid, durationMs: Date.now() - start,
            });
        }, guardMs);

        // Send brief
        try {
            const payload = JSON.stringify({
                cmd: brief.cmd,
                args: brief.args || [],
                cwd: brief.cwd || appRoot,
                env: brief.env || null,
                timeout: timeoutMs,
                stallMs: brief.stallMs || 0,
                captureOutput: brief.captureOutput !== false,
                inheritEnv: brief.inheritEnv !== false,
                shell: brief.shell === true,
            }) + '\n';
            proc.stdin!.write(payload);
            proc.stdin!.end();
        } catch (err: any) {
            safeResolve({
                exitCode: -1, stdout: '', stderr: String(err.message || err),
                killReason: 'spawn-error', tier: 'runner',
                pid: proc.pid, durationMs: Date.now() - start,
            });
        }
    });
}

// ---------------------------------------------------------------------------
// Tier 1: ghrun.exe (Rust runtime; not yet built — interface is reserved)
//
// Wire format (per arc/spawn-protocol §2.5): ghrun spawn <brief.json>
// For now we shell out one-shot with --json (forward-compatible).
// ---------------------------------------------------------------------------

function ghrunTier(brief: SpawnBrief, appRoot: string, ghrunBin: string): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve) => {
        const start = Date.now();
        const timeoutMs = brief.timeout && brief.timeout > 0 ? brief.timeout : 60_000;
        const guardMs = timeoutMs + 5_000;

        const payload = JSON.stringify({
            cmd: brief.cmd,
            args: brief.args || [],
            cwd: brief.cwd || appRoot,
            env: brief.env || null,
            timeout: timeoutMs,
            stallMs: brief.stallMs || 0,
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
        const finish = (r: SpawnResult) => {
            if (done) { return; }
            done = true;
            clearTimeout(guard);
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

    constructor(private appRoot: string) {}

    /** Probe ghrun availability (synchronous file check). */
    ghrunAlive(): boolean {
        return !!resolveGhrunBin(this.appRoot);
    }

    /** Probe runner.py availability. */
    runnerAlive(): boolean {
        return !!resolveRunner(this.appRoot);
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

    /** Unified spawn entry. Tries ghrun → runner.py → node child_process. */
    async spawn(brief: SpawnBrief): Promise<SpawnResult> {
        if (!brief || !brief.cmd) {
            return {
                exitCode: -1, stdout: '', stderr: 'qz.spawn: missing brief.cmd',
                killReason: 'spawn-error', tier: 'node', durationMs: 0,
            };
        }

        // Tier 1: ghrun (Rust, tree-kill watchdog)
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
                    return r;
                }
                console.warn('[qz] ghrun spawn-error, falling back to runner:', r.stderr.slice(0, 200));
            } catch (e: any) {
                console.warn('[qz] ghrun threw, falling back to runner:', e && e.message);
            }
        }

        // Tier 2: runner.py
        const runner = resolveRunner(this.appRoot);
        if (runner) {
            try {
                const r = await runnerTier(brief, this.appRoot, runner);
                if (r.killReason !== 'spawn-error') { return r; }
                console.warn('[qz] runner spawn-error, falling back to node:', r.stderr.slice(0, 200));
            } catch (e: any) {
                console.warn('[qz] runner threw, falling back to node:', e && e.message);
            }
        }

        // Tier 3: node (always available)
        return nodeTier(brief, this.appRoot);
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
