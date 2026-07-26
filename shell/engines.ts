// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// engines.ts
// Spawns the existing Rust IO engine as a child process and exposes a JSON
// line-based RPC over stdio (action-based protocol matching q3 daemon).
//
// Engine binary naming convention (matches q3/assets/):
//   q_win_x64.exe   q_win_arm64.exe
//   q_linux_x64     q_linux_arm64
//   q_mac_x64       q_mac_arm64
//
// Protocol (line-delimited JSON over stdio):
//   request:  {"_id":<int>, "action":"<name>", ...params}\n
//   response: {"_id":<int>, ...result}\n         OR   {"_id":<int>, "error":"..."}
//   event:    {"event":"...", ...}               (no _id)
//   handshake: client sends action="ping" -> server returns {"status":"alive"}
// ============================================================================

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { EventEmitter } from 'events';

interface PendingCall {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
}

export class EngineHost extends EventEmitter {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingCall>();
    private enginePath = '';
    private alive = false;
    private starting: Promise<boolean> | null = null;

    constructor(private appRoot: string) {
        super();
    }

    /** Resolve the engine binary path for current platform/arch. */
    private resolveEngineBinary(): string | null {
        const platMap: Record<string, string> = { win32: 'win', linux: 'linux', darwin: 'mac' };
        const archMap: Record<string, string> = { x64: 'x64', arm64: 'arm64' };
        const plat = platMap[process.platform];
        const arch = archMap[process.arch];
        if (!plat || !arch) { return null; }
        const ext = process.platform === 'win32' ? '.exe' : '';
        // Search roots: appRoot first (extraResources style),
        // then resources/app/ (default electron-builder layout).
        const searchRoots = [
            this.appRoot,
            path.join(this.appRoot, 'resources', 'app'),
        ];
        const tries: string[] = [];
        for (const root of searchRoots) {
            tries.push(path.join(root, 'engines', `q_${plat}_${arch}${ext}`));
            // Win arm64 may run x64 via emulation
            if (plat === 'win' && arch === 'arm64') {
                tries.push(path.join(root, 'engines', `q_win_x64${ext}`));
            }
        }
        for (const candidate of tries) {
            if (fs.existsSync(candidate)) { return candidate; }
        }
        return null;
    }

    /**
     * Start the engine and wait for ping handshake. Returns true if alive.
     * Non-fatal if missing or fails - caller can still operate via fallback.
     */
    async start(): Promise<boolean> {
        if (this.starting) { return this.starting; }
        if (this.alive) { return true; }
        this.starting = this.doStart();
        const ok = await this.starting;
        this.starting = null;
        return ok;
    }

    private async doStart(): Promise<boolean> {
        const bin = this.resolveEngineBinary();
        if (!bin) {
            console.warn('[engines] no rust engine binary found, fs.* will fall back to node native');
            return false;
        }
        this.enginePath = bin;
        try {
            const proc = spawn(bin, ['--daemon'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                env: { ...process.env, QQQ_PARENT_PID: String(process.pid) },
            });
            this.proc = proc;

            // line-delimited reader (handles long lines and partial chunks)
            const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
            rl.on('line', line => this.onLine(line));

            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', d => {
                const text = String(d).trim();
                if (text) { console.error('[engine.stderr]', text); }
            });
            proc.on('exit', code => {
                this.alive = false;
                console.warn('[engines] engine exited code=' + code);
                for (const { reject, timer } of this.pending.values()) {
                    clearTimeout(timer);
                    reject(new Error('engine exited'));
                }
                this.pending.clear();
                this.emit('exit', code);
            });
            proc.on('error', err => {
                console.error('[engines] proc error:', err);
                this.alive = false;
                this.emit('error', err);
            });
            console.log('[engines] spawned:', bin, '(pid', proc.pid + ')');

            // Handshake: ping with retries (engine may take ~100-500ms to be ready)
            const ok = await this.handshake();
            this.alive = ok;
            if (ok) {
                console.log('[engines] handshake OK');
                this.emit('ready');
            } else {
                console.warn('[engines] handshake failed, killing engine');
                try { proc.kill(); } catch { /* ignore */ }
                this.proc = null;
            }
            return ok;
        } catch (e) {
            console.error('[engines] failed to start:', e);
            this.alive = false;
            return false;
        }
    }

    /** Send ping, retry up to 15 times every 200ms. */
    private async handshake(): Promise<boolean> {
        for (let i = 0; i < 15; i++) {
            try {
                const pong = await this.rawCall('ping', {}, 1000);
                if (pong && pong.status === 'alive') { return true; }
            } catch { /* retry */ }
            await new Promise(r => setTimeout(r, 200));
        }
        return false;
    }

    private onLine(line: string): void {
        if (!line || !line.trim()) { return; }
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            // try base64 decode (q3's PowerShell bridge wraps as base64)
            try {
                msg = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
            } catch {
                console.warn('[engines] bad json:', line.slice(0, 200));
                return;
            }
        }
        // Async event (no _id, or has 'event' field)
        if (msg._id === undefined || msg.event) {
            this.emit('event', msg);
            return;
        }
        const cb = this.pending.get(msg._id);
        if (!cb) { return; }
        this.pending.delete(msg._id);
        clearTimeout(cb.timer);
        if (msg.error) { cb.reject(new Error(String(msg.error))); }
        else { cb.resolve(msg); }
    }

    /** Internal raw call (does not check this.alive; used for handshake). */
    private rawCall(action: string, params: any, timeoutMs: number): Promise<any> {
        if (!this.proc || this.proc.killed) {
            return Promise.reject(new Error('engine_not_running'));
        }
        const id = ++this.nextId;
        const cmd = JSON.stringify({ _id: id, action, ...(params || {}) }) + '\n';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('engine_timeout: ' + action));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.proc!.stdin.write(cmd);
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    /**
     * Public RPC: invoke an action on the engine.
     * If engine is not alive, rejects (caller should fall back to native fs).
     */
    invoke(action: string, params: any = {}, timeoutMs = 10000): Promise<any> {
        if (!this.alive) {
            return Promise.reject(new Error('engine_not_available'));
        }
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
