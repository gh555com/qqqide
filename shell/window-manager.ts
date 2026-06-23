// ============================================================================
// window-manager.ts — 窗口创建 / 缩放 / 边界持久化 / 全局快捷键
// ============================================================================

import { BrowserWindow, screen, globalShortcut } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { injectDevToolsConsoleButtons } from './devtools-inject';
import { LspBridge } from './lsp-bridge';
import { DownloadService } from './download-service';
import { StateStore } from './state-sqlite';
import { BootConfig } from './boot';

// ── 控制台全量 buffer（所有窗口共用，供 DevTools 复制/另存为按钮） ──
export const _consoleBuffer: string[] = [];
export const _consoleMaxLines = 20000;

// ---- Persisted zoom factor ----
export let zoomFactor = 0.85;
let _zoomFile = '';

export function initZoom(portableRoot: string, stateStore: StateStore): void {
    _zoomFile = path.join(portableRoot, 'zoom.json');
    // legacy file load
    try {
        if (fs.existsSync(_zoomFile)) {
            const z = JSON.parse(fs.readFileSync(_zoomFile, 'utf8'));
            if (typeof z.factor === 'number' && z.factor >= 0.5 && z.factor <= 2.0) {
                zoomFactor = z.factor;
            }
        }
    } catch (e) { /* ignore */ }
}

export async function hydrateZoomFromState(stateStore: StateStore): Promise<void> {
    try {
        const v = await stateStore.get('qqqide', 'zoom');
        if (v && typeof v.factor === 'number' && v.factor >= 0.5 && v.factor <= 2.0) {
            zoomFactor = v.factor;
        } else {
            // first run after migration: write boot-loaded legacy value into state
            await stateStore.setNow('qqqide', 'zoom', { factor: zoomFactor });
            try {
                if (_zoomFile && fs.existsSync(_zoomFile)) { fs.renameSync(_zoomFile, _zoomFile + '.migrated'); }
            } catch { /* ignore */ }
        }
    } catch (e) {
        console.warn('[state] _hydrateZoomFromState failed:', e);
    }
}

export function saveZoom(stateStore: StateStore): void {
    try { stateStore.set('qqqide', 'zoom', { factor: zoomFactor }); } catch { /* ignore */ }
}

export function setZoomFactor(f: number): void {
    zoomFactor = f;
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
    isDevFlag: boolean,
    lspBridge: LspBridge,
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

    // Console message buffer
    win.webContents.on('console-message', (_e: any, _level: number, message: string) => {
        _consoleBuffer.push(message);
        if (_consoleBuffer.length > _consoleMaxLines) _consoleBuffer.shift();
    });

    win.removeMenu();

    win.once('ready-to-show', async () => {
        await restoreWindowBounds(win, stateStore);
        // ★ 不在 ready-to-show 就 show() — 等 boot 完成加载面板到 100% 才由 boot.ts 调用 show()
    });

    win.on('closed', () => {
        if (_boundsSaveTimer) { clearTimeout(_boundsSaveTimer); _boundsSaveTimer = null; }
        try { lspBridge.removeTarget(win.webContents); } catch { /* ignore */ }
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

    // Apply zoom factor on load
    win.webContents.on('did-finish-load', () => {
        win.webContents.setZoomFactor(zoomFactor);
        lspBridge.addTarget(win.webContents);
    });

    // Ctrl/Cmd + (+/-/0) zoom shortcuts
    win.webContents.on('before-input-event', (ev, input) => {
        if (input.type !== 'keyDown') { return; }
        const ctrl = input.control || input.meta;
        if (!ctrl) { return; }
        const k = input.key;
        if (k === '=' || k === '+') {
            ev.preventDefault();
            zoomFactor = Math.min(2.0, +(zoomFactor + 0.05).toFixed(2));
            win.webContents.setZoomFactor(zoomFactor);
            saveZoom(stateStore);
            try { win.webContents.send('qqqide:zoom:changed', zoomFactor); } catch { /* ignore */ }
        } else if (k === '-' || k === '_') {
            ev.preventDefault();
            zoomFactor = Math.max(0.5, +(zoomFactor - 0.05).toFixed(2));
            win.webContents.setZoomFactor(zoomFactor);
            saveZoom(stateStore);
            try { win.webContents.send('qqqide:zoom:changed', zoomFactor); } catch { /* ignore */ }
        } else if (k === '0') {
            ev.preventDefault();
            zoomFactor = 1.0;
            win.webContents.setZoomFactor(zoomFactor);
            saveZoom(stateStore);
            try { win.webContents.send('qqqide:zoom:changed', zoomFactor); } catch { /* ignore */ }
        }
    });

    // Dev mode extras
    if (isDevFlag) {
        win.webContents.openDevTools({ mode: 'detach' });
        injectDevToolsConsoleButtons(win.webContents, () => _consoleBuffer.join('\n'), win);
        // ★ 不再 clearCache() — 保留缓存避免每次启动都重新下载全部资源
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
                    injectDevToolsConsoleButtons(win.webContents, () => _consoleBuffer.join('\n'), win);
                }
            }
        });
        console.log('[main] DEV MODE: DevTools detached, cache cleared, F5/Ctrl+R reload, Ctrl+Shift+I devtools');
    }

    return win;
}
