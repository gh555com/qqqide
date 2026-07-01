// ============================================================================
// ipc-misc.ts — 杂项 IPC: 窗口 / 对话框 / 资产根 / 磁盘 / 新窗口
// ============================================================================

import { app, ipcMain, BrowserWindow, clipboard, dialog, shell as electronShell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { URL } from 'url';
import { BootConfig } from './boot';
import { addAssetRoot, _assetFileWorkspaceRoots, diskFreeBatch } from './asset-protocol';
import { _windowProjectMap, _projectWindowMap, createWindow, editorFontSize, saveEditorFontSize, setEditorFontSize, broadcastEditorFontSize } from './window-manager';
import { StateStore } from './state-sqlite';
// import { LspBridge } from './lsp-bridge'; // LSP OFF — 2026-06-23
import { DownloadService } from './download-service';
import { UpdateService } from './update-service';
import { injectDevToolsConsoleButtons } from './devtools-inject';
import { _consoleBuffer } from './window-manager';
import { applyMenuSchema, MenuSchema } from './menu-builder';

export function registerMiscIpc(
    portableRoot: string,
    portableCache: string,
    appVersion: string,
    isDevFlag: boolean,
    // lspBridge: LspBridge,  // LSP OFF — 2026-06-23
    lspBridge: any,
    downloadService: DownloadService,
    stateStore: StateStore,
    updateService: UpdateService,
    getMainWindow: () => any,
    bootConfig: BootConfig,
): void {
    // ---- clipboard ----
    ipcMain.handle('qqqide:clipboard:writeText', async (_e, s: string) => clipboard.writeText(String(s)));
    ipcMain.handle('qqqide:clipboard:readText', async () => clipboard.readText());
    ipcMain.handle('qqqide:clipboard:readImage', async () => { var img = clipboard.readImage(); return img.isEmpty() ? null : img.toDataURL(); });
    ipcMain.handle('qqqide:clipboard:hasImage', async () => !clipboard.readImage().isEmpty());

    // ---- shell (open file / URL) ----
    ipcMain.handle('qqqide:shell:openPath', async (_e, p: string) => {
        try { return await electronShell.openPath(p); } catch (e) { console.warn('[shell:openPath]', e); return ''; }
    });
    ipcMain.handle('qqqide:shell:openExternal', async (_e, url: string) => {
        try { await electronShell.openExternal(url); } catch (e) { console.warn('[shell:openExternal]', e); }
    });

    // ---- drives / diskFree ----
    ipcMain.handle('qqqide:fs:drives', async () => {
        const drives: string[] = [];
        if (process.platform === 'win32') {
            for (let i = 65; i <= 90; i++) {
                const d = String.fromCharCode(i) + ':\\';
                try { if (fs.existsSync(d)) drives.push(d); } catch { /* skip */ }
            }
            if (drives.length === 0) drives.push('C:\\');
        } else {
            drives.push('/');
        }
        return drives;
    });

    ipcMain.handle('qqqide:fs:diskFree', async (_e, drives: string[]) => {
        return await diskFreeBatch(portableRoot, drives);
    });

    // ---- dialogs ----
    ipcMain.handle('qqqide:dialog:open', async (_e, opts) => {
        const mainWindow = BrowserWindow.getAllWindows()[0] || null;
        if (!mainWindow) { return null; }
        const result = await dialog.showOpenDialog(mainWindow, opts || {});
        try {
            const wantsDir = !!(opts && Array.isArray(opts.properties) && opts.properties.indexOf('openDirectory') !== -1);
            if (result && Array.isArray(result.filePaths)) {
                for (const p of result.filePaths) {
                    if (!p) { continue; }
                    if (wantsDir) {
                        addAssetRoot(p, stateStore);
                    } else {
                        const dir = path.dirname(p);
                        if (dir) { addAssetRoot(dir, stateStore); }
                    }
                }
            }
        } catch (e) {
            console.warn('[qqqide:dialog:open] asset-root auto-extend failed:', e);
        }
        return result;
    });

    ipcMain.handle('qqqide:dialog:save', async (_e, opts) => {
        const mainWindow = BrowserWindow.getAllWindows()[0] || null;
        if (!mainWindow) { return null; }
        return dialog.showSaveDialog(mainWindow, opts || {});
    });

    ipcMain.handle('qqqide:dialog:message', async (_e, opts) => {
        const mainWindow = BrowserWindow.getAllWindows()[0] || null;
        if (!mainWindow) { return null; }
        return dialog.showMessageBox(mainWindow, opts || {});
    });

    // ---- asset-roots ----
    ipcMain.handle('qqqide:assetRoots:add', async (_e, absDir: string) => addAssetRoot(absDir, stateStore));
    ipcMain.handle('qqqide:assetRoots:list', async () => Array.from(_assetFileWorkspaceRoots));
    ipcMain.handle('qqqide:assetRoots:remove', async (_e, absDir: string) => {
        if (!absDir) { return false; }
        const ok = _assetFileWorkspaceRoots.delete(path.normalize(absDir));
        if (ok) {
            const arr = Array.from(_assetFileWorkspaceRoots);
            try { stateStore.set('qqqide', 'asset_roots', arr); } catch { /* ignore */ }
        }
        return ok;
    });

    // ---- app quit (退出全部窗口) ----
    ipcMain.handle('qqqide:app:quitAll', async () => {
        // before-quit handler in shutdown.ts handles saveAllOpenWindows + lock cleanup
        app.quit();
    });

    // ---- window management ----
    ipcMain.handle('qqqide:window:minimize', (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); });
    ipcMain.handle('qqqide:window:maximize', (e) => { BrowserWindow.fromWebContents(e.sender)?.maximize(); });
    ipcMain.handle('qqqide:window:unmaximize', (e) => { BrowserWindow.fromWebContents(e.sender)?.unmaximize(); });
    ipcMain.handle('qqqide:window:close', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win && !win.isDestroyed()) { win.close(); }
    });
    ipcMain.handle('qqqide:window:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);
    ipcMain.handle('qqqide:window:setTitle', (e, s: string) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) return;
        win.setTitle(String(s));
    });
    ipcMain.handle('qqqide:window:toggleDevTools', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed()) { return; }
        const wc = win.webContents;
        if (wc.isDevToolsOpened()) {
            wc.closeDevTools();
        } else {
            wc.openDevTools({ mode: 'detach' });
            // 按钮注入由 window-manager.ts devtools-opened 事件统一处理
        }
    });

    // ---- 新窗口 ----
    ipcMain.handle('qqqide:window:new', async (_e, folderPath?: string) => {
        if (folderPath && typeof folderPath === 'string') {
            const normalized = folderPath.replace(/\\/g, '/').replace(/\/$/, '');
            const existingWinId = _projectWindowMap.get(normalized);
            if (existingWinId != null) {
                const existingWin = BrowserWindow.fromId(existingWinId);
                if (existingWin && !existingWin.isDestroyed()) {
                    if (existingWin.isMinimized()) existingWin.restore();
                    existingWin.focus();
                    return { ok: false, locked: true, existingWindowId: existingWinId };
                }
                _projectWindowMap.delete(normalized);
                _windowProjectMap.delete(existingWinId);
            }
            const lockPath = normalized + '/qqq/alphal/.lock';
            try {
                const lockRaw = fs.readFileSync(lockPath, 'utf-8');
                const lockData = JSON.parse(lockRaw);
                const age = Date.now() - (lockData.atime || 0);
                if (age < 60000) {
                    return { ok: false, locked: true, existingWindowId: null };
                }
                try { fs.unlinkSync(lockPath); } catch (_) { }
            } catch (_) { }
        }
        const newWin = createWindow(portableRoot, portableCache, appVersion, lspBridge, downloadService, stateStore);
        // 绑定主文件夹
        if (folderPath && typeof folderPath === 'string') {
            const normalized = folderPath.replace(/\\/g, '/').replace(/\/$/, '');
            _windowProjectMap.set(newWin.id, normalized);
            _projectWindowMap.set(normalized, newWin.id);
        }
        // Build URL: 有 folderPath → restore 模式；无 folderPath → fresh 模式
        let url: string;
        if (folderPath && typeof folderPath === 'string') {
            url = bootConfig.url + '?restore=1&folder=' + encodeURIComponent(folderPath);
        } else {
            url = bootConfig.url + '?fresh=1';
        }
        newWin.loadURL(url).then(() => {
            newWin.show();
        }).catch((err: any) => {
            console.error('[window:new] loadURL FAILED:', err);
        });
        return { ok: true, windowId: newWin.id };
    });

    // ---- sync broadcast relay (handle, not on) ----
    ipcMain.handle('qqqide:sync:broadcast', (e, channel: string, data: any) => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
            try { win.webContents.send('qqqide:sync:message', channel, data); } catch { /* ignore */ }
        }
    });

    // sync state
    let _currentProjectPath: string | null = null;
    ipcMain.handle('qqqide:sync:get-project-path', () => _currentProjectPath);
    ipcMain.handle('qqqide:sync:set-project-path', (e, p: string) => {
        const senderWin = BrowserWindow.fromWebContents(e.sender);
        const mainWindow = getMainWindow();
        if (senderWin !== mainWindow) return;
        _currentProjectPath = p;
    });
    ipcMain.handle('qqqide:sync:get-theme', () => {
        try {
            const mainWindow = getMainWindow();
            if (mainWindow && !mainWindow.isDestroyed()) {
                return mainWindow.webContents.executeJavaScript(
                    'document.documentElement.getAttribute("data-theme") === "dark"'
                );
            }
        } catch (_) { }
        return false;
    });

    // ---- window claim/release ----
    ipcMain.handle('qqqide:window:claimProject', (_e, projectRoot: string) => {
        const win = BrowserWindow.fromWebContents(_e.sender);
        if (!win) return false;
        const normalized = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
        const oldProject = _windowProjectMap.get(win.id);
        if (oldProject && oldProject !== normalized) {
            _projectWindowMap.delete(oldProject);
        }
        _windowProjectMap.set(win.id, normalized);
        _projectWindowMap.set(normalized, win.id);
        return true;
    });

    ipcMain.handle('qqqide:window:releaseProject', (_e, projectRoot: string) => {
        const win = BrowserWindow.fromWebContents(_e.sender);
        if (!win) return false;
        const normalized = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
        const currentProject = _windowProjectMap.get(win.id);
        if (currentProject === normalized) {
            _windowProjectMap.delete(win.id);
            _projectWindowMap.delete(normalized);
        }
        return true;
    });

    ipcMain.handle('qqqide:window:adjust-bounds', async (e, deltaLeft: number, deltaRight: number) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed()) return;
        const b = win.getBounds();
        const newX = b.x - deltaLeft;
        const newW = b.width + deltaLeft + deltaRight;
        win.setBounds({ x: newX, y: b.y, width: newW, height: b.height });
    });

    // ---- editor font size (was zoom — now controls text size, not window scale) ----
    // adjust is the hot path (every repeat tick) — no persist, just memory + broadcast
    ipcMain.handle('qqqide:zoom:get', () => editorFontSize);
    ipcMain.handle('qqqide:zoom:set', (_e, size: number) => {
        const s = Math.max(6, Math.min(128, Math.round(Number(size))));
        setEditorFontSize(s);
        saveEditorFontSize(stateStore);
        broadcastEditorFontSize(s);
        return s;
    });
    ipcMain.handle('qqqide:zoom:adjust', (_e, delta: number) => {
        const next = Math.max(6, Math.min(128, Math.round(editorFontSize + Number(delta))));
        setEditorFontSize(next);
        // ★ no saveEditorFontSize here — every adjust tick must be FAST (memory + broadcast only)
        broadcastEditorFontSize(next);
        return next;
    });

    // ---- menu ----
    ipcMain.handle('qqqide:menu:set', (_e, schema: MenuSchema | null) => {
        applyMenuSchema(schema, getMainWindow());
        return true;
    });

    // ---- update ----
    ipcMain.handle('qqqide:update:check', async () => updateService.check());
    ipcMain.handle('qqqide:update:apply', async () => updateService.apply());
    ipcMain.handle('qqqide:update:state', async () => updateService.getState());
    ipcMain.handle('qqqide:update:abort', async () => {
        updateService.abort();
        return true;
    });
}

