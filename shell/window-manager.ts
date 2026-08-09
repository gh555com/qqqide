// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// window-manager.ts — 窗口创建 / 缩放 / 边界持久化 / 全局快捷键
// ============================================================================

import { BrowserWindow, screen, globalShortcut } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { injectDevToolsConsoleButtons } from './devtools-inject';
import { renameDevToolsViaBroker } from './py-broker';
import { claimSquad, releaseSquad } from './squad-manager';
import { SimpleWebSocket } from './cdp-sniffer';
import { crashNetLog, crashNetSnapshot } from './crash-net';
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

// ---- Wing panel constants (must match shell-wings.js _shAiW) ----
export const WING_WIDTH = 389;
export const CENTER_MIN_W = 1100;
export const CENTER_MIN_H = 800;

/** Update window minimum size based on which wings are open */
export function updateWingMinSize(win: BrowserWindow, leftOpen: boolean, rightOpen: boolean): void {
    if (!win || win.isDestroyed()) return;
    const wingW = (leftOpen ? WING_WIDTH : 0) + (rightOpen ? WING_WIDTH : 0);
    win.setMinimumSize(CENTER_MIN_W + wingW, CENTER_MIN_H);
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

// ★ 关闭确认旁路：菜单退出时设置，跳过 Alt+F4 确认框
export function bypassCloseConfirm(win: BrowserWindow): void {
    (win as any).__qqqCloseBypass = true;
}

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
        minWidth: CENTER_MIN_W,
        minHeight: CENTER_MIN_H,
        show: false,
        frame: false,
        backgroundColor: '#fdf6e3',
        title: 'qqqide',
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: false,
            spellcheck: false,
            additionalArguments: [
                `--qqqide-root=${portableRoot}`,
                `--qqqide-version=${appVersion}`,
            ],
        },
    });

    // ★ 窗口编队认领: 创建即按序认领最近空闲槽位 (1 2 q w a s z x), 无空闲=null (>8窗口)
    claimSquad(win);

    // ★ console-message 始终运行 — 捕获全量消息 (CDP 不再阻塞, 仅作补充)
    const _cmHandler = (
        _e: any, _level: number, message: string, _line: number, _sourceId: string
    ) => {
        // _level 0=verbose → 过滤（DevTools save 不显示 verbose）
        if (_level === 0) return;
        const src = (_sourceId || '').replace(/\\/g, '/');
        const file = src.split('/').pop() || '';
        const prefix = file && !file.startsWith('(') && _line ? file + ':' + _line + ' ' : '';
        _consoleBuffer.push(prefix + message);
        if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
    };
    win.webContents.on('console-message', _cmHandler);

    // ★ CDP 作为补充 (网络错误调用栈等) — 静默失败不影响 console-message 主线
    _setupCdpConsoleCapture(win).catch(() => {});

    win.removeMenu();

    win.once('ready-to-show', async () => {
        await restoreWindowBounds(win, stateStore);
        // ★ 不在 ready-to-show 就 show() — 等 boot 完成加载面板到 100% 才由 boot.ts 调用 show()
    });

    // ★ 关闭确认：Alt+F4 / 右上角 X → 通知 renderer 弹自定义确认框；菜单退出 → 跳过
    win.on('close', (e) => {
        if ((win as any).__qqqCloseBypass) {
            return; // 菜单退出已设旁路，直接放行
        }
        e.preventDefault();
        // ★ 武装键盘：确认框弹出期间 Enter=确认 / Escape=取消
        (win as any).__qqqConfirmArmed = true;
        // 通知 renderer 弹出确认框（renderer 样式同设置面板）
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            try { win.webContents.send('qqqide:confirm-close'); } catch (_) { }
        }
    });

    // ★ 确认框键盘输入（Enter=确认退出 / Escape=取消）— before-input-event 在浏览器进程捕获，
    //   焦点在左中右面板 iframe 内（document keydown 收不到）也能 100% 响应
    win.webContents.on('before-input-event', (event: any, input: any) => {
        if (!(win as any).__qqqConfirmArmed) { return; }
        if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') { return; }
        if (input.isComposing) { return; } // IME 组词回车不触发
        if (input.key === 'Enter') {
            event.preventDefault();
            (win as any).__qqqConfirmArmed = false;
            bypassCloseConfirm(win);
            // ★ 立即隐藏确认框（force 越过 1s 防抖）：确认退出永不防抖，窗口马上开始关闭
            try { win.webContents.send('qqqide:confirm-close-dismiss', true); } catch { /* ignore */ }
            try { win.close(); } catch { /* ignore */ }
        } else if (input.key === 'Escape') {
            event.preventDefault();
            try { win.webContents.send('qqqide:confirm-close-dismiss'); } catch { /* ignore */ }
        }
    });

    // ★ 渲染进程崩溃监控 + 自动恢复 (2026-08-08 F13):
    //   崩溃(含 V8 OOM) → 记录 reason + exitCode 到 Data/alphal/render-crash.log → 防抖 3s 自动 reload
    //   窗口不消失; 下次崩溃即可凭 reason 实锤根因 ('oom' = V8 堆耗尽)
    const _crashLogPath = path.join(portableRoot, 'Data', 'alphal', 'render-crash.log');
    win.webContents.on('render-process-gone', (_e, details) => {
        const reason = (details && details.reason) || 'unknown';
        try {
            fs.mkdirSync(path.dirname(_crashLogPath), { recursive: true });
            fs.appendFileSync(_crashLogPath,
                new Date().toISOString() + ' reason=' + reason +
                ' exitCode=' + ((details && details.exitCode) || 0) +
                ' win=' + win.id + '\n');
        } catch (_) { /* ignore */ }
        try { console.error('[window-manager] render-process-gone reason=' + reason + ' win=' + win.id); } catch (_) { }
        // ★ 天罗地网: 崩溃事件 + 全量快照 (主进程此刻仍存活, 必须立即落盘)
        try { crashNetLog({ kind: 'render-gone', winId: win.id, reason, exitCode: (details && details.exitCode) || 0 }); } catch (_) { }
        try { crashNetSnapshot('render-gone'); } catch (_) { }
        if (reason === 'clean-exit') { return; } // 正常关闭路径, 不恢复
        // 自动恢复: 崩溃/被杀/OOM → reload 保留窗口 (防抖 3s, 防崩溃循环风暴)
        const now = Date.now();
        const lastAt = (win as any).__qqqCrashReloadAt || 0;
        if (now - lastAt > 3000) {
            (win as any).__qqqCrashReloadAt = now;
            setTimeout(() => {
                try { if (!win.isDestroyed() && !win.webContents.isDestroyed()) { win.webContents.reload(); } } catch (_) { }
            }, 300);
        }
    });

    // 渲染进程卡死(JS 长任务/GC 停顿) — 只记录, 不杀(杀会丢未落盘数据)
    win.webContents.on('unresponsive', () => {
        try { console.error('[window-manager] renderer unresponsive win=' + win.id); } catch (_) { }
    });

    win.on('closed', () => {
        (win as any).__qqqConfirmArmed = false;
        try { if (_boundsSaveTimer) { clearTimeout(_boundsSaveTimer); _boundsSaveTimer = null; } } catch (_) { }
        // ★ 窗口关闭 → 编队槽位回到空闲
        try { releaseSquad(win.id); } catch (_) { }
        try {
            const ownedProject = _windowProjectMap.get(win.id);
            if (ownedProject) {
                _windowProjectMap.delete(win.id);
                _projectWindowMap.delete(ownedProject);
                // ★ 同步删除项目锁文件 → 关闭后立即重开同文件夹不被 60s 锁拦截
                try { fs.unlinkSync(ownedProject + '/_qqq/alphal/.lock'); } catch (_) { }
            }
        } catch (_) { }
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
            editorFontSize = Math.max(1, editorFontSize - 1);
            saveEditorFontSize(stateStore);
            broadcastEditorFontSize(editorFontSize);
        } else if (k === '0') {
            ev.preventDefault();
            editorFontSize = 13;
            saveEditorFontSize(stateStore);
            broadcastEditorFontSize(editorFontSize);
        }
    });

    // ★ 控制台按钮注入 — 无论 dev/prod，DevTools 打开就注入
    win.webContents.on('devtools-opened', () => {
        const dwc = (win.webContents as any).devToolsWebContents as WebContents;
        if (dwc && !dwc.isDestroyed()) {
            injectDevToolsConsoleButtons(dwc, win.webContents, () => _consoleBuffer.join('\n'), win);
        }
    });

    // Dev mode extras
    if (extractFlags().isDev) {
        win.webContents.on('devtools-opened', () => {
            // ★ DevTools 窗口标题 → Python broker（跨平台: Win ctypes / Mac osascript / Linux wmctrl）
            const _doRename = (attempt: number) => {
                const p = _windowProjectMap.get(win.id);
                const n = p ? path.basename(p) : 'qqqide';
                console.log('[devtools] rename attempt=' + attempt + ' winId=' + win.id + ' projPath=' + (p || '(none)') + ' name=' + n);
                renameDevToolsViaBroker(win, n);
            };
            for (let _ri = 1; _ri <= 8; _ri++) {
                setTimeout(() => _doRename(_ri), 1500 * _ri);
            }
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
            // ★ 吃 F12：Chromium 默认 F12=DevTools，IDE 自己不用 F12，阻止窗口被劫持
            if (input.key === 'F12') {
                ev.preventDefault();
            }
        });
    }

    return win;
}

// ── CDP 控制台全量捕获 — Log.entryAdded = DevTools 另存为 100% 同源数据 ──
// ★ v8: 延迟启动 + 重试 + 完整覆盖
async function _setupCdpConsoleCapture(win: BrowserWindow): Promise<void> {
    const PORT = 8315;
    const allSockets: SimpleWebSocket[] = [];
    let _started = false;

    // Safe logger: console.log → EPIPE when stdout is broken (no console window)
    const _safeLog = (...args: any[]) => { try { console.log(...args); } catch {} };

    // DevTools Console 默认不显示的 source（intervention=性能建议, rendering=渲染, violation=违规, deprecation=弃用）
    const _NOISE_SOURCES = new Set(['intervention', 'rendering', 'violation', 'deprecation', 'recommendation']);

    const _handleEntry = (entry: any) => {
        // 跳过 DevTools Console 默认不显示的条目
        if (!entry || !entry.text) return;
        if (entry.level === 'verbose') return;
        if (entry.source && _NOISE_SOURCES.has(entry.source)) return;
        // Log 域 network 条目: 用 entry.url 补全文本
        // Console 域不覆盖网络错误 → Log 域是唯一来源
        if (entry.source === 'network') {
            const nUrl = (entry.url || '').replace(/\\/g, '/');
            const nFile = nUrl.split('/').pop() || nUrl;
            const nText = (entry.text || '');
            const nCallFrames: any[] = entry.stackTrace?.callFrames || [];
            const nLines: string[] = [];
            if (nCallFrames.length > 0) {
                const f0 = nCallFrames[0];
                const fUrl = ((f0.url || '').replace(/\\/g, '/').split('/').pop()) || f0.url;
                const fLine = f0.lineNumber || 0;
                nLines.push((fUrl && fLine ? fUrl + ':' + fLine + ' ' : '') + nUrl + ' ' + nText);
                for (let i = 1; i < nCallFrames.length; i++) {
                    const cf = nCallFrames[i];
                    const fn = cf.functionName || '<anonymous>';
                    const fu = ((cf.url || '').replace(/\\/g, '/').split('/').pop()) || cf.url;
                    nLines.push('    ' + fn + ' @ ' + fu + ':' + (cf.lineNumber || 0));
                }
            } else {
                nLines.push(nUrl + ' ' + nText);
            }
            for (const l of nLines) {
                _consoleBuffer.push(l);
                if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
            }
            return;
        }

        const url = (entry.url || '').replace(/\\/g, '/');
        const file = url.split('/').pop() || url;
        const line = entry.lineNumber || 0;
        const text = entry.text || '';
        const callFrames: any[] = entry.stackTrace?.callFrames || [];

        const lines: string[] = [];
        if (callFrames.length > 0) {
            const f0 = callFrames[0];
            const fUrl = ((f0.url || '').replace(/\\/g, '/').split('/').pop()) || f0.url;
            const fLine = f0.lineNumber || 0;
            lines.push((fUrl && fLine ? fUrl + ':' + fLine + ' ' : '') + text);
            for (let i = 1; i < callFrames.length; i++) {
                const cf = callFrames[i];
                const fn = cf.functionName || '<anonymous>';
                const fu = ((cf.url || '').replace(/\\/g, '/').split('/').pop()) || cf.url;
                lines.push('    ' + fn + ' @ ' + fu + ':' + (cf.lineNumber || 0));
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
    };

    // 去重 set: Console message 的 url+line+text 前80字符 作为 dedup key
    const _consoleDedup = new Set<string>();

    const _handleConsoleMsg = (msg: any) => {
        if (!msg || !msg.text) return;
        if (msg.level === 'verbose') return;
        if (msg.source && _NOISE_SOURCES.has(msg.source)) return;
        // Console 域 network 消息无 URL — 由 Log 域 _handleEntry 处理
        if (msg.source === 'network') return;
        const url = (msg.url || '').replace(/\\/g, '/');
        const file = url.split('/').pop() || url;
        const line = msg.line || 0;
        const text = msg.text || '';
        const callFrames: any[] = msg.stackTrace?.callFrames || [];

        // Dedup: same file+line+text prefix within 1s
        const dedupKey = file + ':' + line + ':' + text.slice(0, 80);
        if (_consoleDedup.has(dedupKey)) return;
        _consoleDedup.add(dedupKey);
        setTimeout(() => _consoleDedup.delete(dedupKey), 1000);

        const lines: string[] = [];
        if (callFrames.length > 0) {
            const f0 = callFrames[0];
            const fUrl = ((f0.url || '').replace(/\\/g, '/').split('/').pop()) || f0.url;
            const fLine = f0.lineNumber || 0;
            lines.push((fUrl && fLine ? fUrl + ':' + fLine + ' ' : '') + text);
            for (let i = 1; i < callFrames.length; i++) {
                const cf = callFrames[i];
                const fn = cf.functionName || '<anonymous>';
                const fu = ((cf.url || '').replace(/\\/g, '/').split('/').pop()) || cf.url;
                lines.push('    ' + fn + ' @ ' + fu + ':' + (cf.lineNumber || 0));
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
    };

    const _connectTarget = (wsUrl: string, label: string) => {
        try {
            const ws = new SimpleWebSocket(wsUrl);
            allSockets.push(ws);
            ws.on('open', () => {
                // ★ Console 域 → 完全格式化消息 (含网络错误的 GET URL net::ERR_*)
                ws.send(JSON.stringify({ id: 1, method: 'Console.enable', params: {} }));
                // ★ Log 域 → 原始日志引擎消息 (含栈帧, 兜底)
                ws.send(JSON.stringify({ id: 2, method: 'Log.enable', params: {} }));
                _safeLog('[main] CDP Console+Log enabled for ' + label);
            });
            ws.on('message', (data: string) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.method === 'Console.messageAdded' && msg.params?.message) {
                        _handleConsoleMsg(msg.params.message);
                    } else if (msg.method === 'Log.entryAdded' && msg.params?.entry) {
                        _handleEntry(msg.params.entry);
                    }
                } catch {}
            });
            ws.on('error', (err: Error) => {
                            _safeLog('[main] CDP WS error (' + label + '):', err.message);               try { ws.close(); } catch {}
            });
        } catch (e: any) {
                        _safeLog('[main] CDP connect failed (' + label + '):', e.message);    }
    };

    const _doCapture = async () => {
        if (_started) return;
        try {
            const targetsJson: string = await new Promise<string>((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
                    let data = '';
                    res.on('data', (chunk: string) => data += chunk);
                    res.on('end', () => resolve(data));
                });
                req.on('error', reject);
                req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
            });
            const targets: any[] = JSON.parse(targetsJson);
            let pageCount = 0;
            for (const t of targets) {
                if (t.type === 'page' && t.webSocketDebuggerUrl) {
                    _connectTarget(t.webSocketDebuggerUrl, 'page:' + (t.url || '').slice(0, 60));
                    pageCount++;
                }
            }
            // 浏览器级 CDP
            try {
                const versionJson: string = await new Promise<string>((resolve, reject) => {
                    const req = http.get(`http://127.0.0.1:${PORT}/json/version`, (res) => {
                        let data = '';
                        res.on('data', (chunk: string) => data += chunk);
                        res.on('end', () => resolve(data));
                    });
                    req.on('error', reject);
                    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
                });
                const vi = JSON.parse(versionJson);
                if (vi.webSocketDebuggerUrl) {
                    _connectTarget(vi.webSocketDebuggerUrl, 'browser');
                }
            } catch {}
            _safeLog('[main] CDP capture started: ' + pageCount + ' page(s) + browser');
            _started = true;
            // 不在此处 onActive — 等首条 CDP 数据到达才激活 (防中间空窗导致丢消息)

            // 轮询新 target
            const _poll = setInterval(async () => {
                try {
                    const resp: string = await new Promise<string>((resolve, reject) => {
                        const req = http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
                            let data = '';
                            res.on('data', (chunk: string) => data += chunk);
                            res.on('end', () => resolve(data));
                        });
                        req.on('error', reject);
                        req.setTimeout(2000, () => { req.destroy(); });
                    });
                    const list: any[] = JSON.parse(resp);
                    const known = new Set(allSockets.map(s => s.url));
                    for (const t of list) {
                        if (t.type === 'page' && t.webSocketDebuggerUrl && !known.has(t.webSocketDebuggerUrl)) {
                            _connectTarget(t.webSocketDebuggerUrl, 'new:' + (t.url || '').slice(0, 60));
                        }
                    }
                } catch {}
            }, 8000);

            win.on('closed', () => {
                clearInterval(_poll);
                for (const s of allSockets) { try { s.close(); } catch {} }
                allSockets.length = 0;
            });
        } catch (err: any) {
            _safeLog('[main] CDP capture init failed (retry in 2s):', err.message);
            setTimeout(_doCapture, 2000);
        }
    };

    // 延迟启动: CDP 端口在 DevTools open 之后才完全就绪
    setTimeout(_doCapture, 2000);
    setTimeout(() => { if (!_started) _doCapture(); }, 5000);
}
