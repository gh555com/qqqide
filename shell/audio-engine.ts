// ============================================================================
// audio-engine.ts
// Spawns engines/miniaudio_bridge.py as a child process and exposes JSON-line
// stdio RPC matching the same protocol as engines.ts (action-based).
// Lazy-started: only spawns when first qqq:audio:* IPC arrives.
// ============================================================================

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';

interface PendingCall {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
}

export class AudioEngine {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingCall>();
    private alive = false;
    private starting: Promise<boolean> | null = null;

    constructor(private appRoot: string) {}

    private resolveScript(): string | null {
        const candidates = [
            path.join(this.appRoot, 'engines', 'miniaudio_bridge.py'),
            path.join(this.appRoot, 'resources', 'app', 'engines', 'miniaudio_bridge.py'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) { return p; }
        }
        return null;
    }

    private resolvePython(): string {
        // Use whatever python is on PATH. Allow override via env.
        if (process.env.QQQ_PYTHON) { return process.env.QQQ_PYTHON; }
        return process.platform === 'win32' ? 'python' : 'python3';
    }

    /** Start lazily on first call. */
    async ensure(): Promise<boolean> {
        if (this.alive) { return true; }
        if (this.starting) { return this.starting; }
        this.starting = this.start();
        const ok = await this.starting;
        this.starting = null;
        return ok;
    }

    private async start(): Promise<boolean> {
        const script = this.resolveScript();
        if (!script) {
            console.warn('[audio] miniaudio_bridge.py not found, audio disabled');
            return false;
        }
        const py = this.resolvePython();
        try {
            const proc = spawn(py, ['-u', script], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                cwd: path.dirname(script),
                env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
            });
            this.proc = proc;
            const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
            rl.on('line', line => this.onLine(line));
            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', d => {
                const s = String(d).trim();
                if (s) { console.error('[audio.stderr]', s); }
            });
            proc.on('exit', code => {
                this.alive = false;
                console.warn('[audio] python exited code=' + code);
                for (const { reject, timer } of this.pending.values()) {
                    clearTimeout(timer);
                    reject(new Error('audio_engine_exited'));
                }
                this.pending.clear();
            });
            proc.on('error', err => { console.error('[audio] proc error:', err); this.alive = false; });
            console.log('[audio] spawned:', py, script, '(pid', proc.pid + ')');

            // handshake (5 retries)
            for (let i = 0; i < 5; i++) {
                try {
                    const pong = await this.rawCall('ping', {}, 1500);
                    if (pong && pong.status === 'alive') {
                        this.alive = true;
                        console.log('[audio] handshake OK');
                        return true;
                    }
                } catch { /* retry */ }
                await new Promise(r => setTimeout(r, 300));
            }
            console.warn('[audio] handshake failed, killing');
            try { proc.kill(); } catch { /* ignore */ }
            this.proc = null;
            return false;
        } catch (e) {
            console.error('[audio] failed to start:', e);
            return false;
        }
    }

    private onLine(line: string): void {
        if (!line || !line.trim()) { return; }
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg._id === undefined) { return; }
        const cb = this.pending.get(msg._id);
        if (!cb) { return; }
        this.pending.delete(msg._id);
        clearTimeout(cb.timer);
        if (msg.error) { cb.reject(new Error(String(msg.error))); }
        else { cb.resolve(msg); }
    }

    private rawCall(action: string, params: any, timeoutMs: number): Promise<any> {
        if (!this.proc || this.proc.killed) {
            return Promise.reject(new Error('audio_engine_not_running'));
        }
        const id = ++this.nextId;
        const cmd = JSON.stringify({ _id: id, action, ...(params || {}) }) + '\n';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('audio_timeout: ' + action));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try { this.proc!.stdin.write(cmd); }
            catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    async invoke(action: string, params: any = {}, timeoutMs = 10000): Promise<any> {
        const ok = await this.ensure();
        if (!ok) { throw new Error('audio_engine_unavailable'); }
        return this.rawCall(action, params, timeoutMs);
    }

    isAlive(): boolean { return this.alive; }

    stop(): void {
        if (this.proc) {
            try { this.proc.kill(); } catch { /* ignore */ }
            this.proc = null;
            this.alive = false;
        }
    }
}
