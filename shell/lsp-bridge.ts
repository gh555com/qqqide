// ============================================================================
// lsp-bridge.ts
// LSP (Language Server Protocol) bridge — spawns language servers via qz-spawn
// persist mode and bridges JSON-RPC over stdin/stdout.
//
// Architecture:
//   Renderer (Monaco) ← IPC → lsp-bridge.ts ← stdin/stdout → LSP server
//
// ghrun `which` resolves binary paths; qz-spawn persist manages lifecycle.
// One LSP server instance per language (not per file).
// Diagnostics flow to renderer via webContents.send('qqq:lsp:diagnostics',...).
// ============================================================================

import { WebContents } from 'electron';
import { QzSpawn, PersistHandle } from './qz-spawn';
import { spawn as cpSpawn, spawnSync } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Language → LSP component mapping
// ---------------------------------------------------------------------------

interface LspConfig {
    component: string;      // ghrun component name: "lsp/gopls"
    args: string[];         // CLI args (e.g. ["--stdio"])
    languageId: string;     // LSP languageId sent in initialize
    fileExtensions: string[];
}

const LSP_REGISTRY: Record<string, LspConfig> = {
    python:   { component: 'lsp/pyright',       args: ['--stdio'], languageId: 'python',       fileExtensions: ['.py', '.pyw'] },
    go:       { component: 'lsp/gopls',         args: [],          languageId: 'go',            fileExtensions: ['.go'] },
    rust:     { component: 'lsp/rust-analyzer', args: [],          languageId: 'rust',          fileExtensions: ['.rs'] },
    c:        { component: 'lsp/clangd',        args: [],          languageId: 'c',             fileExtensions: ['.c', '.h'] },
    cpp:      { component: 'lsp/clangd',        args: [],          languageId: 'cpp',           fileExtensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'] },
};

/**
 * Detect language from file extension.
 * Returns null for languages handled by Monaco built-in workers (ts, js, json, html, css).
 */
function detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    // Monaco built-in workers handle these — no LSP needed
    const monacoBuiltins: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescriptreact',
        '.js': 'javascript', '.jsx': 'javascriptreact',
        '.json': 'json', '.html': 'html', '.htm': 'html',
        '.css': 'css', '.scss': 'scss', '.less': 'less',
    };
    if (ext in monacoBuiltins) return null;

    for (const [lang, cfg] of Object.entries(LSP_REGISTRY)) {
        if (cfg.fileExtensions.includes(ext)) return lang;
    }
    return null;
}

// ---------------------------------------------------------------------------
// LSP JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
    jsonrpc: '2.0';
    id?: number | string;
    method?: string;
    params?: any;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

let nextId = 1;

function buildRequest(method: string, params?: any): string {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: nextId++, method, params };
    const body = JSON.stringify(msg);
    return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function buildNotification(method: string, params?: any): string {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params };
    const body = JSON.stringify(msg);
    return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// LspTransport — unified transport interface (TCP or local process)
// ---------------------------------------------------------------------------

interface LspTransport {
    send(data: string): void;
    onData(cb: (data: string) => void): void;
    onStderr(cb: (data: string) => void): void;
    onExit(cb: (code: number | null) => void): void;
    shutdown(): Promise<void>;
}

// Well-known LSP TCP ports (mirrors ghrun lsp_daemon.rs port_for)
const LSP_PORT_MAP: Record<string, number> = {
    'go':     9801,  // gopls
    'python': 9802,  // pyright
    'c':      9803,  // clangd
    'cpp':    9803,  // clangd (same process)
    'rust':   9804,  // rust-analyzer
};

/** TCP-based LSP transport — connects to ghrun LSP daemon. */
class TcpLspTransport implements LspTransport {
    private socket: net.Socket;
    private buffer = '';
    private dataCbs: Array<(data: string) => void> = [];
    private exitCbs: Array<(code: number | null) => void> = [];
    private stderrCbs: Array<(data: string) => void> = [];

    constructor(port: number, host: string = '127.0.0.1') {
        this.socket = net.createConnection({ port, host });

        this.socket.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString('utf8');
            while (true) {
                const m = this.buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
                if (!m) break;
                const len = parseInt(m[1], 10);
                // Reject oversized frames (aligns with ghrun lsp_daemon.rs 50MB limit)
                if (isNaN(len) || len > 50 * 1024 * 1024) {
                    this.buffer = ''; // discard corrupted data
                    return;
                }
                const headerEnd = m[0].length;
                if (this.buffer.length < headerEnd + len) break;
                const body = this.buffer.slice(headerEnd, headerEnd + len);
                this.buffer = this.buffer.slice(headerEnd + len);
                for (const cb of this.dataCbs) {
                    try { cb(body); } catch (e) { /* ignore */ }
                }
            }
        });

        this.socket.on('error', (err: Error) => {
            for (const cb of this.stderrCbs) {
                try { cb('[tcp] ' + err.message); } catch (e) { /* ignore */ }
            }
        });

        this.socket.on('close', () => {
            for (const cb of this.exitCbs) {
                try { cb(null); } catch (e) { /* ignore */ }
            }
        });
    }

    send(data: string): void { this.socket.write(data); }
    onData(cb: (data: string) => void): void { this.dataCbs.push(cb); }
    onStderr(cb: (data: string) => void): void { this.stderrCbs.push(cb); }
    onExit(cb: (code: number | null) => void): void { this.exitCbs.push(cb); }
    async shutdown(): Promise<void> { this.socket.destroy(); }
}

// ---------------------------------------------------------------------------
// LspInstance — one running language server
// ---------------------------------------------------------------------------

interface PendingRequest {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

class LspInstance {
    handle: LspTransport;
    lang: string;
    cfg: LspConfig;
    pending = new Map<number | string, PendingRequest>();
    openDocs = new Set<string>();
    serverCapabilities: any = null;
    initResult: any = null;
    private initDone = false;
    onNotification?: (method: string, params: any) => void;

    constructor(handle: LspTransport, lang: string, cfg: LspConfig) {
        this.handle = handle;
        this.lang = lang;
        this.cfg = cfg;

        this.handle.onData((data: string) => {
            try {
                const msg: JsonRpcMessage = JSON.parse(data);
                this._onMessage(msg);
            } catch (e) {
                console.warn('[lsp] bad JSON from', lang, ':', String(data).slice(0, 200));
            }
        });

        this.handle.onStderr((data: string) => {
            console.warn('[lsp]', lang, 'stderr:', data.slice(0, 500));
        });

        this.handle.onExit((code) => {
            console.warn('[lsp]', lang, 'exited with code', code);
            // Reject all pending
            for (const [id, pr] of this.pending) {
                clearTimeout(pr.timer);
                pr.reject(new Error(`LSP server ${lang} exited (code ${code})`));
            }
            this.pending.clear();
        });
    }

    private _onMessage(msg: JsonRpcMessage) {
        // Response to a request
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            const pr = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(pr.timer);
            if (msg.error) {
                pr.reject(new Error(msg.error.message || 'LSP error'));
            } else {
                pr.resolve(msg.result);
            }
            return;
        }
        // Server→client notification (diagnostics, etc.)
        if (msg.method && this.onNotification) {
            this.onNotification(msg.method, msg.params);
        }
    }

    /** Send a request and wait for response (with 30s timeout). */
    async request(method: string, params?: any): Promise<any> {
        if (!this.initDone && method !== 'initialize' && method !== 'initialized') {
            throw new Error(`LSP ${this.lang}: not initialized yet`);
        }
        const id = nextId++;
        const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
        const body = JSON.stringify(msg);
        this.handle.send(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`LSP ${this.lang} request '${method}' timed out`));
            }, 30_000);
            this.pending.set(id, { resolve, reject, timer });
        });
    }

    /** Send a notification (no response expected). */
    notify(method: string, params?: any): void {
        const msg: JsonRpcMessage = { jsonrpc: '2.0', method, params };
        const body = JSON.stringify(msg);
        this.handle.send(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    }

    /** Initialize the LSP session. Must be called before any document operations. */
    async initialize(rootUri: string): Promise<void> {
        const result = await this.request('initialize', {
            processId: process.pid,
            rootUri,
            capabilities: {
                textDocument: {
                    synchronization: { didChange: 2 }, // incremental
                    completion: { completionItem: { snippetSupport: false } },
                    hover: { contentFormat: ['plaintext', 'markdown'] },
                    definition: {},
                    references: {},
                    documentSymbol: {},
                },
            },
            initializationOptions: undefined,
        });
        this.serverCapabilities = result.capabilities;
        this.initResult = result;
        this.notify('initialized', {});
        this.initDone = true;
        console.log('[lsp]', this.lang, 'initialized:', Object.keys(result.capabilities || {}).join(', '));
    }

    async openDocument(filePath: string, text: string): Promise<void> {
        if (this.openDocs.has(filePath)) return;
        this.openDocs.add(filePath);
        const uri = filePathToUri(filePath);
        this.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: this.cfg.languageId, version: 1, text },
        });
    }

    async changeDocument(filePath: string, changes: Array<{ range?: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string }>, version: number): Promise<void> {
        const uri = filePathToUri(filePath);
        this.notify('textDocument/didChange', {
            textDocument: { uri, version },
            contentChanges: changes,
        });
    }

    async closeDocument(filePath: string): Promise<void> {
        if (!this.openDocs.has(filePath)) return;
        this.openDocs.delete(filePath);
        this.notify('textDocument/didClose', {
            textDocument: { uri: filePathToUri(filePath) },
        });
    }

    /** Request hover info at a position (textDocument/hover). */
    async hover(filePath: string, line: number, character: number): Promise<any> {
        const uri = filePathToUri(filePath);
        return this.request('textDocument/hover', {
            textDocument: { uri },
            position: { line, character },
        });
    }

    async shutdown(): Promise<void> {
        try {
            await this.request('shutdown');
        } catch { /* ignore */ }
        this.notify('exit', {});
        await this.handle.shutdown();
    }
}

// ---------------------------------------------------------------------------
// LspBridge — singleton manager
// ---------------------------------------------------------------------------

export class LspBridge {
    private instances = new Map<string, LspInstance>();
    private qz: QzSpawn;
    private targets = new Set<WebContents>();
    private diagnosticsCache = new Map<string, any[]>(); // uri → diagnostics[]
    /** Resolved binary paths: lang → full path */
    private binPaths = new Map<string, string>();
    /** Open document count per language (for idle shutdown). */
    private docCounts = new Map<string, number>();
    /** Idle shutdown timers per language. */
    private idleTimers = new Map<string, NodeJS.Timeout>();
    /** Kill LSP after 5 minutes with zero open docs. */
    private static readonly IDLE_SHUTDOWN_MS = 300_000;

    /** Resolve TCP port for an LSP language (mirrors ghrun lsp_daemon.rs port_for). */
    private resolvePort(lang: string): number {
        return LSP_PORT_MAP[lang] || 0;
    }

    /** Try to connect to ghrun LSP daemon via TCP. Returns transport or null. */
    private tryConnectTcp(lang: string): TcpLspTransport | null {
        const port = this.resolvePort(lang);
        if (port <= 0) return null;
        try {
            const t = new TcpLspTransport(port);
            console.log('[lsp] TCP connected to', lang, 'on port', port);
            return t;
        } catch (e: any) {
            console.warn('[lsp] TCP connect to', lang, 'port', port, 'failed:', e.message);
            return null;
        }
    }

    constructor(appRoot: string) {
        this.appRoot = appRoot;
        this.qz = new QzSpawn(appRoot);
    }

    private appRoot: string;

    /** Add a renderer target for diagnostics push (one per BrowserWindow). */
    addTarget(wc: WebContents): void {
        this.targets.add(wc);
        // Push cached diagnostics to newly added target
        for (const [uri, diagnostics] of this.diagnosticsCache) {
            if (!wc.isDestroyed()) {
                wc.send('qqq:lsp:diagnostics', { uri, diagnostics });
            }
        }
    }

    /** Remove a renderer target (window closed). */
    removeTarget(wc: WebContents): void {
        this.targets.delete(wc);
    }

    /**
     * Resolve LSP binary path via ghrun `which` command.
     * Returns null if ghrun is not available or component not found.
     */
    private resolveGhrunWhich(component: string): string | null {
        const ghrunBin = this.findGhrun();
        if (!ghrunBin) return null;

        try {
            const result = spawnSync(ghrunBin, ['which', component], {
                windowsHide: true,
                timeout: 5000,
            });
            if (result.status === 0 && result.stdout) {
                const line = result.stdout.toString('utf8').split('\n')[0];
                const parsed = JSON.parse(line);
                if (parsed.event === 'which' && parsed.path) {
                    return parsed.path;
                }
            }
        } catch (e) {
            console.warn('[lsp] ghrun which failed:', e);
        }
        return null;
    }

    /** Auto-start ghrun lsp-daemon in background, then retry TCP connect. */
    private async tryAutoStartDaemon(): Promise<void> {
        const ghrunBin = this.findGhrun();
        if (!ghrunBin) return;
        try {
            const proc = cpSpawn(ghrunBin, ['lsp-daemon'], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            proc.unref();
            await new Promise(r => setTimeout(r, 500));
            console.log('[lsp] auto-started ghrun lsp-daemon');
        } catch (e: any) {
            console.warn('[lsp] failed to auto-start ghrun daemon:', e.message);
        }
    }

    private findGhrun(): string | null {
        const env = process.env.QDIR_GHRUN;
        if (env && fs.existsSync(env)) return env;
        const qdir = process.env.QDIR;
        if (qdir) {
            const ext = process.platform === 'win32' ? '.exe' : '';
            const p = path.join(qdir, 'ghrun' + ext);
            if (fs.existsSync(p)) return p;
        }
        // also probe engines/ghrun.exe under app root
        const ext = process.platform === 'win32' ? '.exe' : '';
        const p = path.join(this.appRoot, 'engines', 'ghrun' + ext);
        if (fs.existsSync(p)) return p;
        return null;
    }

    /** Start LSP for a language. TCP (ghrun daemon) first, fallback to direct spawn. */
    async startLanguage(lang: string, rootUri: string): Promise<boolean> {
        if (this.instances.has(lang)) return true;

        const cfg = LSP_REGISTRY[lang];
        if (!cfg) {
            console.warn('[lsp] no LSP config for language:', lang);
            return false;
        }

        // Helper: try TCP init with a given transport
        const tryTcpInit = async (transport: LspTransport): Promise<boolean> => {
            const instance = new LspInstance(transport, lang, cfg);
            this.instances.set(lang, instance);
            instance.onNotification = (method: string, params: any) => {
                if (method === 'textDocument/publishDiagnostics' && params && params.uri) {
                    const filePath = uriToFilePath(params.uri);
                    this.updateDiagnostics(filePath, params.diagnostics || []);
                }
            };
            try {
                await instance.initialize(rootUri);
                return true;
            } catch (e: any) {
                console.warn('[lsp] TCP init failed for', lang, ':', e.message);
                instance.shutdown().catch(() => {});
                this.instances.delete(lang);
                return false;
            }
        };

        // === Phase 1: try TCP via ghrun LSP daemon (already running) ===
        const tcpTransport = this.tryConnectTcp(lang);
        if (tcpTransport && await tryTcpInit(tcpTransport)) return true;

        // === Phase 1.5: daemon not running → auto-start ghrun lsp-daemon ===
        await this.tryAutoStartDaemon();
        const retryTransport = this.tryConnectTcp(lang);
        if (retryTransport && await tryTcpInit(retryTransport)) return true;

        // === Phase 2: direct spawn (fallback when ghrun daemon not running) ===
        let binPath: string | null | undefined = this.binPaths.get(lang);
        if (!binPath) {
            binPath = this.resolveGhrunWhich(cfg.component);
            if (!binPath) {
                const qdir = process.env.QDIR;
                if (qdir) {
                    const dirName = cfg.component.replace('/', '_');
                    const ext = process.platform === 'win32' ? '.exe' : '';
                    const guessedBin = cfg.component.split('/').pop()! + ext;
                    const probePaths = [
                        path.join(qdir, 'f', 'components', dirName, guessedBin),
                        path.join(qdir, 'f', 'components', dirName, cfg.component.split('/').pop()! + ext),
                    ];
                    for (const p of probePaths) {
                        if (fs.existsSync(p)) { binPath = p; break; }
                    }
                }
            }
            if (!binPath) {
                const which = this.qz.which(cfg.component.split('/').pop()!);
                if (which) binPath = which;
            }
            if (binPath) {
                this.binPaths.set(lang, binPath);
            }
        }

        if (!binPath) {
            console.warn('[lsp] cannot find binary for', lang, '(component:', cfg.component, ')');
            return false;
        }

        console.log('[lsp] direct spawn', lang, '→', binPath);
        const handle = this.qz.spawnPersist({
            cmd: binPath,
            args: cfg.args,
            idleTimeout: 300_000,
        });

        if (!handle) {
            console.error('[lsp] spawnPersist failed for', lang);
            return false;
        }

        const instance = new LspInstance(handle, lang, cfg);
        this.instances.set(lang, instance);

        instance.onNotification = (method: string, params: any) => {
            if (method === 'textDocument/publishDiagnostics' && params && params.uri) {
                const filePath = uriToFilePath(params.uri);
                this.updateDiagnostics(filePath, params.diagnostics || []);
            }
        };

        try {
            await instance.initialize(rootUri);
            return true;
        } catch (e: any) {
            console.error('[lsp] initialize failed for', lang, ':', e.message);
            instance.shutdown().catch(() => {});
            this.instances.delete(lang);
            return false;
        }
    }

    /** Stop LSP for a language. */
    async stopLanguage(lang: string): Promise<void> {
        const inst = this.instances.get(lang);
        if (!inst) return;
        await inst.shutdown();
        this.instances.delete(lang);
        // Clean up idle tracking
        const timer = this.idleTimers.get(lang);
        if (timer) { clearTimeout(timer); this.idleTimers.delete(lang); }
        this.docCounts.delete(lang);
    }

    /** Open a document in the appropriate LSP server. */
    async openDocument(filePath: string, text: string): Promise<string | null> {
        const lang = detectLanguage(filePath);
        if (!lang) return null; // Monaco handles this natively
        if (!this.instances.has(lang)) return lang; // not started yet, no-op
        const inst = this.instances.get(lang)!;
        await inst.openDocument(filePath, text);
        // Track doc count, cancel idle shutdown if pending
        const count = (this.docCounts.get(lang) || 0) + 1;
        this.docCounts.set(lang, count);
        const timer = this.idleTimers.get(lang);
        if (timer) { clearTimeout(timer); this.idleTimers.delete(lang); }
        return lang;
    }

    /** Notify LSP of document change. */
    async changeDocument(filePath: string, changes: Array<{ range?: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string }>, version: number): Promise<void> {
        const lang = detectLanguage(filePath);
        if (!lang || !this.instances.has(lang)) return;
        await this.instances.get(lang)!.changeDocument(filePath, changes, version);
    }

    /** Close a document. Triggers idle shutdown after 5 min with zero open docs. */
    async closeDocument(filePath: string): Promise<void> {
        const lang = detectLanguage(filePath);
        if (!lang || !this.instances.has(lang)) return;
        await this.instances.get(lang)!.closeDocument(filePath);
        // Decrement doc count; start idle timer when count hits 0
        const count = Math.max(0, (this.docCounts.get(lang) || 1) - 1);
        this.docCounts.set(lang, count);
        if (count <= 0 && this.instances.has(lang)) {
            this.docCounts.delete(lang);
            // Start 5-min idle timer
            const timer = setTimeout(() => {
                this.idleTimers.delete(lang);
                if ((this.docCounts.get(lang) || 0) <= 0 && this.instances.has(lang)) {
                    console.log('[lsp] idle timeout for', lang, '→ shutting down');
                    this.stopLanguage(lang).catch(() => {});
                }
            }, LspBridge.IDLE_SHUTDOWN_MS);
            this.idleTimers.set(lang, timer);
        }
    }

    /** Request hover info via LSP. Returns null if no language server is active. */
    async hover(filePath: string, line: number, character: number): Promise<any> {
        const lang = detectLanguage(filePath);
        if (!lang || !this.instances.has(lang)) return null;
        try {
            return await this.instances.get(lang)!.hover(filePath, line, character);
        } catch (e: any) {
            console.warn('[lsp] hover failed for', lang, ':', e.message);
            return null;
        }
    }

    /** Push diagnostics to all target renderers. */
    updateDiagnostics(filePath: string, diagnostics: any[]): void {
        const uri = filePathToUri(filePath);
        this.diagnosticsCache.set(uri, diagnostics);
        for (const wc of this.targets) {
            if (!wc.isDestroyed()) {
                wc.send('qqq:lsp:diagnostics', { uri, diagnostics });
            }
        }
    }

    /** Get cached diagnostics for a URI. */
    getDiagnostics(uri: string): any[] {
        return this.diagnosticsCache.get(uri) || [];
    }

    /** Get all active language names. */
    activeLanguages(): string[] {
        return Array.from(this.instances.keys());
    }

    /** Stop all LSP servers. */
    async shutdownAll(): Promise<void> {
        const langs = Array.from(this.instances.keys());
        await Promise.all(langs.map(l => this.stopLanguage(l)));
        this.instances.clear();
        this.diagnosticsCache.clear();
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function filePathToUri(filePath: string): string {
    // Convert Windows path to file:// URI
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.match(/^[a-zA-Z]:/)) {
        return 'file:///' + normalized;
    }
    return 'file://' + normalized;
}

function uriToFilePath(uri: string): string {
    // Convert file:// URI back to platform path
    let p = decodeURIComponent(uri.replace(/^file:\/\/\//, '').replace(/^file:\/\//, ''));
    if (process.platform === 'win32') {
        p = p.replace(/\//g, '\\');
    }
    return p;
}

/**
 * Resolve workspace root URI from a file path.
 * For ghrun-managed components, the root is the directory of the file.
 * In the future this can be smarter (e.g. find nearest go.mod, Cargo.toml, etc.).
 */
export function guessRootUri(filePath: string): string {
    return filePathToUri(path.dirname(filePath));
}
