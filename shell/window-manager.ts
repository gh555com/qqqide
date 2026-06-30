// ============================================================================
// window-manager.ts — 窗口创建 / 缩放 / 边界持久化 / 全局快捷键
// ============================================================================

import { BrowserWindow, screen, globalShortcut } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { injectDevToolsConsoleButtons } from './devtools-inject';
import { SimpleWebSocket } from './cdp-sniffer';
// import { LspBridge } from './lsp-bridge'; // LSP OFF — 2026-06-23
import { DownloadService } from './download-service';
import { StateStore } from './state-sqlite';
import { extractFlags } from './boot';

// ── 控制台全量 buffer（所有窗口共用，供 DevTools 复制/另存为按钮） ──
export const _consoleBuffer: string[] = [];
export const _consoleMaxLines = 20000;

// ---- Editor font size (replaces zoom — window UI locked at 1.0) ----
export let editorFontSize = 13;

export function setEditorFontSize(size: number): void {
    editorFontSize = size;
}

export function saveEditorFontSize(stateStore: StateStore): void {
    try { stateStore.set('qqqide', 'editorFontSize', { size: editorFontSize }); } catch { /* ignore */ }
}

/** Broadcast editor font size change to ALL windows (main + diff) */
export function broadcastEditorFontSize(size: number): void {
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            try { win.webContents.send('qqqide:zoom:changed', size); } catch { /* ignore */ }
        }
    }
}

// ---- Window bounds ----
export async function restoreWindowBounds(win: BrowserWindow, stateStore: StateStore): Promise<void> {
    try {
        const v = await stateStore.get('qqqide', 'window_bounds');
        if (!v) { return; }
        if (v.maximized) {
            win.maximize();
            return;
        }
        if (typeof v.w === 'number' && typeof v.h === 'number' && v.w > 0 && v.h > 0) {
            const displays = screen.getAllDisplays();
            const anyOverlap = displays.some(d => {
                const dx = d.bounds.x, dy = d.bounds.y, dw = d.bounds.width, dh = d.bounds.height;
                return (v.x < dx + dw && v.x + v.w > dx && v.y < dy + dh && v.y + v.h > dy);
            });
            if (anyOverlap) {
                win.setBounds({ x: v.x || 0, y: v.y || 0, width: v.w, height: v.h });
            }
        }
    } catch (e) { /* ignore */ }
}

// ---- Global keyboard shortcuts ----
export function registerGlobalKey(accel: string, id: string, mainWindow: BrowserWindow | null): boolean {
    try {
        const ok = globalShortcut.register(accel, () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                try { mainWindow.webContents.send('qqqide:key:global', { id, accel }); }
                catch { /* ignore */ }
            }
        });
        if (!ok) { console.warn('[key.global] register failed:', accel, id); }
        return ok;
    } catch (e) {
        console.warn('[key.global] threw:', accel, id, e);
        return false;
    }
}

// ---- Window↔Project maps (for project lock) ----
export const _windowProjectMap = new Map<number, string>();
export const _projectWindowMap = new Map<string, number>();

// ---- createWindow ----
export function createWindow(
    portableRoot: string,
    portableCache: string,
    appVersion: string,
    // lspBridge: LspBridge,  // LSP OFF — 2026-06-23
    lspBridge: any,
    downloadService: DownloadService,
    stateStore: StateStore,
): BrowserWindow {
    const preloadPath = path.join(__dirname, 'preload.js');
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1100,
        minHeight: 800,
        show: false,
        frame: false,
        backgroundColor: '#fdf6e3',
        title: 'qqq IDE',
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: false,
            additionalArguments: [
                `--qqqide-root=${portableRoot}`,
                `--qqqide-version=${appVersion}`,
            ],
        },
    });

    // ★ Console buffer — 完整捕获 (含 iframe)、与 DevTools 另存为格式一致
    win.webContents.on('console-message', (
        _e: any, _level: number, message: string, _line: number, _sourceId: string
    ) => {
        const src = (_sourceId || '').replace(/\\/g, '/');
        // 过滤形如 "(index):47" 的 bare identifier（嵌套 iframe 无真实路径）
        const file = src.split('/').pop() || '';
        const prefix = file && !file.startsWith('(') && _line ? file + ':' + _line + ' ' : '';
        _consoleBuffer.push(prefix + message);
        if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
    });

    // ★ CDP 控制台全量捕获 — Log.entryAdded = DevTools 另存为 100% 同源数据
    _setupCdpConsoleCapture(win).catch(() => {});

    win.removeMenu();

    win.once('ready-to-show', async () => {
        await restoreWindowBounds(win, stateStore);
        // ★ 不在 ready-to-show 就 show() — 等 boot 完成加载面板到 100% 才由 boot.ts 调用 show()
    });

    win.on('closed', () => {
        if (_boundsSaveTimer) { clearTimeout(_boundsSaveTimer); _boundsSaveTimer = null; }
        // try { lspBridge.removeTarget(win.webContents); } catch { /* ignore */ } // LSP OFF — 2026-06-23
        const ownedProject = _windowProjectMap.get(win.id);
        if (ownedProject) {
            _windowProjectMap.delete(win.id);
            _projectWindowMap.delete(ownedProject);
        }
    });

    // Window blur → dismiss AI viewport dropdown
    win.on('blur', () => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.executeJavaScript(
                "if(window.qqqideViewport&&window.qqqideViewport.closeDropdown)window.qqqideViewport.closeDropdown()"
            ).catch((e) => { try { console.warn('[main] blur dismiss failed:', e && e.message); } catch (_) { } });
        }
    });

    // Persist window bounds on resize/move (debounced 500ms)
    let _boundsSaveTimer: NodeJS.Timeout | null = null;
    const saveBounds = () => {
        try {
            if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) { return; }
            const b = win.getBounds();
            stateStore.set('qqqide', 'window_bounds', {
                x: b.x, y: b.y, w: b.width, h: b.height, maximized: false
            }).catch(() => { });
        } catch { /* ignore */ }
    };
    const debouncedSaveBounds = () => {
        if (_boundsSaveTimer) { clearTimeout(_boundsSaveTimer); }
        _boundsSaveTimer = setTimeout(saveBounds, 500);
    };
    win.on('resize', debouncedSaveBounds);
    win.on('move', debouncedSaveBounds);
    win.on('maximize', () => {
        try { stateStore.set('qqqide', 'window_bounds', { maximized: true }).catch(() => { }); } catch { /* ignore */ }
    });
    win.on('unmaximize', () => { try { saveBounds(); } catch { /* ignore */ } });

    // Download progress
    downloadService.setProgressSender((entry) => {
        if (win && !win.isDestroyed()) {
            try { win.webContents.send('qqqide:download:progress', entry); } catch { /* ignore */ }
        }
    });

    // Lock window UI at 1.0 (no zoom — editor font size handles text scaling)
    win.webContents.on('did-finish-load', () => {
        win.webContents.setZoomFactor(1.0);
    });

    // Ctrl/Cmd + (+/-/0) editor font size shortcuts
    win.webContents.on('before-input-event', (ev, input) => {
        if (input.type !== 'keyDown') { return; }
        const ctrl = input.control || input.meta;
        if (!ctrl) { return; }
        const k = input.key;
        if (k === '=' || k === '+') {
            ev.preventDefault();
            editorFontSize = Math.min(128, editorFontSize + 1);
            saveEditorFontSize(stateStore);
            broadcastEditorFontSize(editorFontSize);
        } else if (k === '-' || k === '_') {
            ev.preventDefault();
            editorFontSize = Math.max(6, editorFontSize - 1);
            saveEditorFontSize(stateStore);
            broadcastEditorFontSize(editorFontSize);
        } else if (k === '0') {
            ev.preventDefault();
            editorFontSize = 13;
            saveEditorFontSize(stateStore);
            broadcastEditorFontSize(editorFontSize);
        }
    });

    // Dev mode extras
    if (extractFlags().isDev) {
        // ★ DevTools console 按钮注入：用 devtools-opened 事件（可靠，不依赖轮询）
        win.webContents.on('devtools-opened', () => {
            injectDevToolsConsoleButtons(win.webContents, () => _consoleBuffer.join('\n'), win);
        });
        win.webContents.openDevTools({ mode: 'detach' });
        win.webContents.on('before-input-event', (ev, input) => {
            if (input.type !== 'keyDown') { return; }
            if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
                ev.preventDefault();
                win.webContents.reloadIgnoringCache();
            }
            if (input.control && input.shift && input.key.toLowerCase() === 'i') {
                ev.preventDefault();
                if (win.webContents.isDevToolsOpened()) {
                    win.webContents.closeDevTools();
                } else {
                    win.webContents.openDevTools({ mode: 'detach' });
                }
            }
        });
    }

    return win;
}

// ── CDP 控制台全量捕获 — Log.entryAdded = DevTools 另存为 100% 同源数据 ──
// 原理: Chrome DevTools Protocol Log 域直连 Chromium 内核日志流。
// Log.entryAdded 包含全量 console 输出 + Chrome 原生消息 + 全量栈帧。
// 与 DevTools 右键另存为完全同源。
// 失败时静默降级到 console-message 事件。
async function _setupCdpConsoleCapture(win: BrowserWindow): Promise<void> {
    const PORT = 8315;
    let ws: SimpleWebSocket | null = null;

    try {
        // 发现 WebSocket URL
        const wsUrl: string = await new Promise<string>((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${PORT}/json/version`, (res) => {
                let data = '';
                res.on('data', (chunk: string) => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.webSocketDebuggerUrl) resolve(parsed.webSocketDebuggerUrl);
                        else reject(new Error('No webSocketDebuggerUrl in CDP response'));
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(3000, () => { req.destroy(); reject(new Error('CDP endpoint timeout')); });
        });

        ws = new SimpleWebSocket(wsUrl);

        ws.on('open', () => {
            ws!.send(JSON.stringify({ id: 1, method: 'Log.enable' }));
            // 保持连接活跃（15s heartbeat）
            setInterval(() => {
                if (ws) {
                    try { ws.send(JSON.stringify({ id: 0, method: 'Runtime.getIsolateId' })); } catch {}
                }
            }, 15000);
        });

        ws.on('message', (data: string) => {
            try {
                const msg = JSON.parse(data);
                if (msg.method !== 'Log.entryAdded' || !msg.params?.entry) return;
                const entry = msg.params.entry;
                const url = (entry.url || '').replace(/\\/g, '/');
                const file = url.split('/').pop() || url;
                const line = entry.lineNumber || 0;
                const text = entry.text || '';
                const stackTrace = entry.stackTrace;
                const callFrames: any[] = stackTrace?.callFrames || [];

                // 格式对齐 DevTools 原生另存为：
                //   file:line  message
                //       fn @ file:line  (缩进4格)
                const lines: string[] = [];

                if (callFrames.length > 0) {
                    const firstFrame = callFrames[0];
                    const fUrl = (firstFrame.url || '').replace(/\\/g, '/').split('/').pop() || firstFrame.url;
                    const fLine = firstFrame.lineNumber || 0;
                    const head = fUrl && fLine ? fUrl + ':' + fLine + ' ' : '';
                    lines.push(head + text);

                    // 剩余栈帧
                    for (let i = 1; i < callFrames.length; i++) {
                        const cf = callFrames[i];
                        const fn = cf.functionName || '<anonymous>';
                        const fu = (cf.url || '').replace(/\\/g, '/').split('/').pop() || cf.url;
                        const fl = cf.lineNumber || 0;
                        lines.push('    ' + fn + ' @ ' + fu + ':' + fl);
                    }
                } else if (file && line) {
                    lines.push(file + ':' + line + ' ' + text);
                } else {
                    lines.push(text);
                }

                for (const l of lines) {
                    _consoleBuffer.push(l);
                    if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
                }
            } catch { /* ignore parse errors */ }
        });

        ws.on('error', (e: Error) => {
            // CDP 不可用 → 静默降级到 console-message
            // console-message 事件在 createMainWindow 中已注册，自动接管
            try { if (ws) ws.close(); } catch {}
            ws = null;
        });

        // 窗口关闭 → 清理 CDP
        win.on('closed', () => {
            try { if (ws) ws.close(); } catch {}
            ws = null;
        });

    } catch {
        // CDP 不可用（端口冲突 / 浏览器未启动 / 网络错误）→ 静默降级
    }
}
