// ============================================================================
// cdp-sniffer.ts — CDP-based video URL sniffer for qqq-shell-v2
//
// Ported from q3/src/cdp-sniffer.js. Launches Chrome/Edge in debug mode,
// connects via CDP WebSocket, and sniffs Network requests to capture
// real .m3u8 / .mpd / .mp4 URLs for sites like Bilibili, Douyin, Twitch.
//
// Uses a lightweight built-in WebSocket (no ws dependency).
// Browser spawned via Node child_process; cleanup via taskkill on Windows.
// ============================================================================

import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import { URL } from 'url';

// ---- Simple WebSocket for CDP (no external ws dependency) ----

interface WsListeners {
    open: Array<() => void>;
    message: Array<(data: string) => void>;
    error: Array<(e: Error) => void>;
}

class SimpleWebSocket {
    url: string;
    listeners: WsListeners = { open: [], message: [], error: [] };
    socket: any = null;

    constructor(url: string) {
        this.url = url;
        this.connect();
    }

    on(event: keyof WsListeners, cb: any): void {
        if (this.listeners[event]) this.listeners[event].push(cb);
    }

    send(data: string): void {
        if (!this.socket) return;
        const payload = Buffer.from(data);
        const length = payload.length;
        let headerLen = 2;
        if (length <= 125) { /* headerLen = 2 */ }
        else if (length <= 65535) { headerLen = 4; }
        else { headerLen = 10; }

        const frame = Buffer.alloc(headerLen + 4 + length);
        frame[0] = 0x81; // FIN + Text
        if (length <= 125) { frame[1] = 0x80 | length; }
        else if (length <= 65535) { frame[1] = 0x80 | 126; frame.writeUInt16BE(length, 2); }
        else { frame[1] = 0x80 | 127; frame.writeBigUInt64BE(BigInt(length), 2); }

        const mask = new Uint8Array(4);
        crypto.randomFillSync(mask);
        for (let i = 0; i < 4; i++) frame[headerLen + i] = mask[i];
        for (let i = 0; i < length; i++) {
            frame[headerLen + 4 + i] = payload[i] ^ mask[i % 4];
        }
        this.socket.write(frame);
    }

    close(): void {
        if (this.socket) this.socket.destroy();
        this.socket = null;
    }

    private connect(): void {
        const u = new URL(this.url);
        const options: http.RequestOptions = {
            host: u.hostname,
            port: u.port ? parseInt(u.port, 10) : 80,
            path: u.pathname + u.search,
            headers: {
                'Connection': 'Upgrade',
                'Upgrade': 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
            },
        };

        const req = http.request(options);
        req.on('upgrade', (res, socket, _head) => {
            this.socket = socket;
            this.listeners.open.forEach(cb => cb());

            let buffer: any = Buffer.alloc(0);
            socket.on('data', (chunk: any) => {
                buffer = Buffer.concat([buffer, chunk] as any);
                while (true) {
                    if (buffer.length < 2) break;
                    const firstByte = buffer[0];
                    const opCode = firstByte & 0x0f;
                    const secondByte = buffer[1];
                    const isMasked = (secondByte & 0x80) !== 0;
                    let payloadLen = secondByte & 0x7f;
                    let offset = 2;
                    if (payloadLen === 126) {
                        if (buffer.length < offset + 2) break;
                        payloadLen = buffer.readUInt16BE(offset);
                        offset += 2;
                    } else if (payloadLen === 127) {
                        if (buffer.length < offset + 8) break;
                        payloadLen = Number(buffer.readBigUInt64BE(offset));
                        offset += 8;
                    }
                    let maskKey: Buffer | null = null;
                    if (isMasked) {
                        if (buffer.length < offset + 4) break;
                        maskKey = buffer.slice(offset, offset + 4);
                        offset += 4;
                    }
                    if (buffer.length < offset + payloadLen) break;
                    const payload = buffer.slice(offset, offset + payloadLen);
                    if (isMasked && maskKey) {
                        for (let i = 0; i < payloadLen; i++) payload[i] ^= maskKey[i % 4];
                    }
                    if (opCode === 0x1) {
                        const str = payload.toString('utf8');
                        this.listeners.message.forEach(cb => cb(str));
                    }
                    buffer = buffer.slice(offset + payloadLen);
                }
            });
        });
        req.on('error', (e: Error) => this.listeners.error.forEach(cb => cb(e)));
        req.end();
    }
}

// ---- Types ----

export interface CaptureResult {
    url: string;
    userDataDir: string;
    headers: Record<string, string>;
    cookieSource: string;
    timestamp: number;
    filesize: number | null;
    resolution: string;
    priority: number;
    waitingForCookie?: boolean;
}

export interface SniffOptions {
    userDataDir?: string;
    timeout?: number;
}

type LogFn = (msg: string) => void;

// ---- Helpers ----

function findBrowserPath(): string | null {
    const platform = process.platform;
    const commonPaths: string[] = [];
    if (platform === 'win32') {
        const home = os.homedir();
        commonPaths.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            path.join(home, 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
            path.join(home, 'AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'),
        );
    } else if (platform === 'darwin') {
        commonPaths.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        );
    } else {
        commonPaths.push(
            '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
        );
    }
    for (const p of commonPaths) { if (fs.existsSync(p)) return p; }
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    if (process.env.EDGE_PATH && fs.existsSync(process.env.EDGE_PATH)) return process.env.EDGE_PATH;
    return null;
}

function validateBrowserPath(exePath: string): boolean {
    if (!exePath || typeof exePath !== 'string') return false;
    try {
        const r = spawn(exePath, ['--version'], { windowsHide: true, timeout: 5000 });
        return true; // spawn succeeded (process started)
    } catch { return false; }
}

async function getDebugUrl(port: number): Promise<string> {
    const resp = await new Promise<{ statusCode: number; data: string }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode || 0, data }));
        }).on('error', reject);
    });
    if (resp.statusCode !== 200) throw new Error(`CDP debug endpoint returned ${resp.statusCode}`);
    const parsed = JSON.parse(resp.data);
    if (!parsed.webSocketDebuggerUrl) throw new Error('No webSocketDebuggerUrl in CDP response');
    return parsed.webSocketDebuggerUrl;
}

// ---- CdpSniffer ----

export class CdpSniffer {
    private browserProcess: ChildProcess | null = null;
    private ws: SimpleWebSocket | null = null;
    private tmpDir: string = '';
    private nextId = 1000;
    private capturedVideos: CaptureResult[] = [];
    private sessions = new Set<string>();
    private keepAliveTimers: NodeJS.Timeout[] = [];
    private static customBrowserPath: string | null = null;

    private log: LogFn = () => {};

    constructor(private appRoot: string) {}

    /** Set custom browser path globally. */
    static setCustomBrowserPath(p: string): void {
        CdpSniffer.customBrowserPath = p;
    }
    static getCustomBrowserPath(): string | null {
        return CdpSniffer.customBrowserPath;
    }
    static validateBrowserPath = validateBrowserPath;

    /** Start sniffing on a target URL. Returns when CDP is connected. */
    async start(targetUrl: string, onLog?: LogFn, options: SniffOptions = {}): Promise<void> {
        this.log = onLog || (() => {});

        const browserPath = CdpSniffer.customBrowserPath || findBrowserPath();
        if (!browserPath) throw new Error('未找到 Chrome 或 Edge 浏览器');

        const port = 9222 + Math.floor(Math.random() * 100);

        // User data dir: use provided or create in portable cache
        let userDataDir = options.userDataDir;
        if (!userDataDir) {
            userDataDir = path.join(this.appRoot, 'cache', 'chrome-user-data');
            try { fs.mkdirSync(userDataDir, { recursive: true }); } catch {}
        }
        this.tmpDir = userDataDir;

        // Launch browser
        const args = [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            '--no-first-run', '--no-default-browser-check',
            '--disable-infobars', '--disable-blink-features=AutomationControlled',
            '--new-window', '--disable-gpu', '--no-sandbox',
            targetUrl,
        ];

        this.log(`[CDP] 启动浏览器: ${browserPath} ${args.join(' ')}`);
        this.browserProcess = spawn(browserPath, args, { windowsHide: true });
        this.capturedVideos = [];
        this.sessions = new Set();

        const wsUrl = await getDebugUrl(port);
        this.log(`[CDP] 连接 WebSocket: ${wsUrl}`);
        this.ws = new SimpleWebSocket(wsUrl);

        return new Promise<void>((resolve, reject) => {
            if (!this.ws) return reject(new Error('WebSocket not created'));

            this.ws.on('open', () => {
                this.sendCommand('Target.setDiscoverTargets', { discover: true });
                this.sendCommand('Target.setAutoAttach', {
                    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
                });
                resolve();
            });

            this.ws.on('message', (data: string) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.error) {
                        this.log(`[CDP Error] ${JSON.stringify(msg)}`);
                        return;
                    }
                    if (msg.id && msg.id >= 100) {
                        const r = msg.result;
                        if (r && Object.keys(r).length === 0) { /* skip keepalive */ }
                        else {
                            const raw = JSON.stringify(msg);
                            if (raw.length > 200) {
                                this.log(`[CDP] Command Response ${msg.id}: ${raw.slice(0, 200)}...`);
                            }
                        }
                    }

                    // Discover new targets
                    if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
                        const target = msg.params.targetInfo;
                        if (target.type === 'page' && !target.attached) {
                            this.log(`[CDP] 发现 Target: ${target.type} - ${target.url}`);
                            this.sendCommand('Target.attachToTarget', {
                                targetId: target.targetId, flatten: true,
                            });
                        }
                    }

                    // Handle attached session
                    if (msg.method === 'Target.attachedToTarget') {
                        const sessionId = msg.params.sessionId;
                        const targetInfo = msg.params.targetInfo;
                        this.log(`[CDP] 已挂载会话: ${sessionId} (${targetInfo.type})`);
                        this.sessions.add(sessionId);

                        const enableNetwork = () => {
                            this.sendCommand('Network.enable', {}, sessionId);
                        };
                        enableNetwork();
                        const timer = setInterval(enableNetwork, 2000);
                        this.keepAliveTimers.push(timer);
                        this.sendCommand('Runtime.enable', {}, sessionId);
                    }

                    // Sniff requests
                    if (msg.method === 'Network.requestWillBeSent') {
                        const req = msg.params.request;
                        const url = req.url;
                        if (!url.match(/\.(js|css|png|jpg|gif|svg|woff|ttf|ico)(\?|$)/)) {
                            this.log(`[Request] ${req.method} : ${url}`);
                        }
                        if (url.includes('.m3u8') || url.includes('.mpd') ||
                            (url.match(/\.(mp4|webm|flv)(\?|$)/) && !url.includes('.png') && !url.includes('.jpg'))) {
                            this._addCapture(url, req.headers, 'request-url', targetUrl);
                            this.log(`[!!! CAPTURED] ${url}`);
                        }
                    }

                    // Sniff responses
                    if (msg.method === 'Network.responseReceived') {
                        const resp = msg.params.response;
                        const url = resp.url;
                        const mime = resp.mimeType || '';
                        const isMedia = mime.includes('video') || mime.includes('audio') ||
                            mime.includes('mpeg') || mime.includes('stream') ||
                            url.includes('.m3u8') || url.includes('.mpd');
                        if (isMedia) {
                            this.log(`[Response] ${mime} : ${url}`);
                            const lenStr = resp.headers['Content-Length'] || resp.headers['content-length'];
                            const len = lenStr ? parseInt(lenStr, 10) : null;
                            if (url.includes('.m3u8') || url.includes('.mpd')) {
                                this._addCapture(url, null, 'response-mime', targetUrl, len, 100);
                                this.log(`[!!! CAPTURED PRIORITY] ${url}`);
                            } else if (url.match(/\.(mp4|webm|flv|mov|mkv)(\?|$)/) || mime.includes('mp4') || mime.includes('webm')) {
                                this._addCapture(url, null, 'response-mime', targetUrl, len, 80);
                                this.log(`[!!! CAPTURED VIDEO] ${url}`);
                            } else {
                                this._addCapture(url, null, 'response-mime', targetUrl, len, 10);
                                this.log(`[!!! CAPTURED FRAGMENT] ${url}`);
                            }
                        }
                    }
                } catch { /* ignore parse errors */ }
            });

            this.ws.on('error', (e: Error) => {
                this.log(`[CDP] WS error: ${e.message}`);
                reject(e);
            });
        });
    }

    /** Get all captured videos so far. */
    getCapturedVideos(): CaptureResult[] {
        return this.capturedVideos || [];
    }

    /** Get the latest capture, optionally trying JS injection as fallback. */
    async getLatestCapture(injectJs = false): Promise<CaptureResult | null> {
        if (this.capturedVideos && this.capturedVideos.length > 0) {
            const latest = this.capturedVideos[0];
            if (latest.waitingForCookie) {
                await new Promise(r => setTimeout(r, 500));
            }
            return latest;
        }

        if (injectJs && this.ws && this.sessions.size > 0) {
            return this._injectJsFallback();
        }
        return null;
    }

    /** Stop and cleanup browser + WebSocket. */
    stop(): void { this.cleanup(); }

    /** Convenience: sniff for a duration, calling onFound when a video is found. */
    async sniff(
        targetUrl: string,
        onFound: (result: CaptureResult) => boolean,
        timeoutMs = 121000,
        options?: SniffOptions,
    ): Promise<CaptureResult | null> {
        await this.start(targetUrl, undefined, options);
        return new Promise<CaptureResult | null>((resolve) => {
            const timer = setInterval(async () => {
                const latest = await this.getLatestCapture(true);
                if (latest) {
                    const found = onFound(latest);
                    if (found) {
                        clearInterval(timer);
                        this.stop();
                        resolve(latest);
                    }
                }
            }, 500);
            setTimeout(() => {
                clearInterval(timer);
                this.stop();
                resolve(null);
            }, timeoutMs);
        });
    }

    // ---- private ----

    private sendCommand(method: string, params: Record<string, any> = {}, sessionId?: string): void {
        if (!this.ws) return;
        const id = this.nextId++;
        const msg: any = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        this.ws.send(JSON.stringify(msg));
    }

    private _addCapture(
        url: string, headers: any, source: string,
        targetUrl: string, contentLength: number | null = null, priority = 50,
    ): void {
        if (this.capturedVideos.length > 0 && this.capturedVideos[0].priority > priority && this.capturedVideos[0].url !== url) return;
        if (this.capturedVideos.some(v => v.url === url)) return;

        const result: CaptureResult = {
            url,
            userDataDir: this.tmpDir,
            headers: headers ? {
                'Cookie': headers['Cookie'] || headers['cookie'],
                'Referer': headers['Referer'] || headers['referer'] || targetUrl,
                'User-Agent': headers['User-Agent'] || headers['user-agent'],
                'Origin': headers['Origin'] || headers['origin'],
            } : { 'Referer': targetUrl },
            cookieSource: 'cdp-sniffed',
            timestamp: Date.now(),
            filesize: contentLength,
            resolution: url.includes('1080') ? '1080p' : (url.includes('720') ? '720p' : 'unknown'),
            priority,
        };

        // Active cookie fetch if missing
        if (!result.headers.Cookie && this.ws && this.sessions.size > 0) {
            result.waitingForCookie = true;
            const sessionIds = Array.from(this.sessions);
            sessionIds.forEach(sessionId => {
                const id = this.nextId++;
                const listener = (data: string) => {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.id === id && msg.result && msg.result.cookies) {
                            const cookies = msg.result.cookies;
                            if (cookies.length > 0) {
                                const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
                                if (!result.headers.Cookie || cookieStr.length > result.headers.Cookie.length) {
                                    result.headers.Cookie = cookieStr;
                                    this.log(`[CDP] 主动获取 Cookie 成功: ${cookieStr.substring(0, 50)}...`);
                                    result.waitingForCookie = false;
                                }
                            }
                            const idx = this.ws!.listeners.message.indexOf(listener);
                            if (idx > -1) this.ws!.listeners.message.splice(idx, 1);
                        }
                    } catch {}
                };
                this.ws!.on('message', listener);
                this.ws!.send(JSON.stringify({
                    id, method: 'Network.getCookies',
                    params: { urls: [url, targetUrl] },
                    sessionId,
                }));
            });
            setTimeout(() => { result.waitingForCookie = false; }, 2000);
        }

        // Clean referer
        if (result.headers.Referer) {
            let ref = result.headers.Referer.trim();
            if (ref.includes(',')) ref = ref.split(',')[0].trim();
            result.headers.Referer = ref;
        }
        if (!result.headers.Origin && result.headers.Referer) {
            try { result.headers.Origin = new URL(result.headers.Referer).origin; } catch {}
        }

        this.log(`[CDP] !!! 捕获成功 (${source}): ${url} Size:${contentLength}`);
        if (priority >= 90) {
            this.capturedVideos.unshift(result);
        } else {
            this.capturedVideos.push(result);
        }
    }

    private async _injectJsFallback(): Promise<CaptureResult | null> {
        if (!this.ws) return null;
        this.log(`[CDP] JS 注入兜底... Sessions: ${this.sessions.size}`);

        const script = `(function(){try{var r=performance.getEntriesByType('resource');for(var i=r.length-1;i>=0;i--){var n=r[i].name;if(n.startsWith('blob:')||n.includes('.m3u8')||n.includes('.mpd')||n.match(/\.(mp4|webm|flv)(\?|$)/)){if(!n.includes('.png')&&!n.includes('.ico'))return n}}var v=document.querySelector('video');if(v){if(v.src&&(v.src.startsWith('http')||v.src.startsWith('blob:')))return JSON.stringify({url:v.src,cookie:document.cookie,referer:document.referrer});if(v.currentSrc&&(v.currentSrc.startsWith('http')||v.currentSrc.startsWith('blob:')))return JSON.stringify({url:v.currentSrc,cookie:document.cookie,referer:document.referrer});var s=v.querySelector('source');if(s&&s.src)return JSON.stringify({url:s.src,cookie:document.cookie,referer:document.referrer})}var ifs=document.querySelectorAll('iframe');for(var j=0;j<ifs.length;j++){if(ifs[j].src&&(ifs[j].src.includes('m3u8')||ifs[j].src.includes('mp4')))return JSON.stringify({url:ifs[j].src,cookie:document.cookie,referer:document.referrer})}if(window.hls&&window.hls.url)return JSON.stringify({url:window.hls.url,cookie:document.cookie,referer:document.referrer});var keys=Object.keys(window);for(var k=0;k<keys.length;k++){if(keys[k].includes('Info')||keys[k].includes('Data')||keys[k].includes('Player')||keys[k].includes('Config')){var v2=window[keys[k]];if(v2&&typeof v2==='object'){var m=JSON.stringify(v2).match(/https?:\\/\\/[^"']+\\.(mp4|m3u8|mpd)[^"']*/);if(m)return JSON.stringify({url:m[0].replace(/\\\\\\//g,'/'),cookie:document.cookie,referer:document.referrer})}}}return null}catch(e){return null}})()`;

        const sessions = Array.from(this.sessions);
        const promises = sessions.map(sessionId => {
            return new Promise<CaptureResult | null>(resolve => {
                const id = Date.now() + Math.floor(Math.random() * 10000);
                const listener = (data: string) => {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.id === id && msg.result && msg.result.result) {
                            const val = msg.result.result.value;
                            if (val && typeof val === 'string') {
                                try {
                                    const obj = JSON.parse(val);
                                    if (obj.url) {
                                        let referer = obj.referer ? obj.referer.trim() : 'https://www.google.com/';
                                        if (referer.includes(',')) referer = referer.split(',')[0].trim();
                                        let origin = '';
                                        try { origin = new URL(referer).origin; } catch {}
                                        resolve({
                                            url: obj.url,
                                            userDataDir: this.tmpDir,
                                            headers: {
                                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                                'Referer': referer, 'Origin': origin,
                                                'Cookie': obj.cookie || '',
                                            },
                                            cookieSource: 'cdp-injected',
                                            timestamp: Date.now(),
                                            filesize: null, resolution: 'unknown', priority: 90,
                                        });
                                        return;
                                    }
                                } catch {}
                                if (val.startsWith('http')) {
                                    resolve({
                                        url: val,
                                        userDataDir: this.tmpDir,
                                        headers: { 'Referer': 'https://www.google.com/' },
                                        cookieSource: 'cdp-injected',
                                        timestamp: Date.now(),
                                        filesize: null, resolution: 'unknown', priority: 90,
                                    });
                                    return;
                                }
                            }
                            resolve(null);
                        }
                    } catch { resolve(null); }
                };
                this.ws!.on('message', listener);
                this.sendCommand('Runtime.evaluate', { expression: script, returnByValue: true }, sessionId);
                setTimeout(() => resolve(null), 1000);
            });
        });

        try {
            const results = await Promise.all(promises);
            const found = results.find(r => r && r.url);
            if (found) {
                this.log(`[CDP] JS 注入成功提取: ${found.url}`);
                this.capturedVideos.unshift(found);
                return found;
            }
        } catch (e: any) {
            this.log(`[CDP] JS 注入失败: ${e.message}`);
        }
        return null;
    }

    private cleanup(): void {
        if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
        if (this.keepAliveTimers) {
            this.keepAliveTimers.forEach(t => clearInterval(t));
            this.keepAliveTimers = [];
        }
        if (this.browserProcess) {
            const pid = this.browserProcess.pid;
            if (process.platform === 'win32' && pid) {
                try {
                    execSync(`taskkill /pid ${pid} /T /F`, {
                        stdio: 'ignore',
                        env: { ...process.env, QQQ_NO_TRACK: '1' },
                    });
                } catch {}
            }
            try { this.browserProcess.kill(); } catch {}
            this.browserProcess = null;
        }
    }
}
