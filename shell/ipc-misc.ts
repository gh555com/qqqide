// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-misc.ts — 杂项 IPC: 窗口 / 对话框 / 资产根 / 磁盘 / 新窗口
// ============================================================================

import { app, ipcMain, BrowserWindow, clipboard, dialog, shell as electronShell } from 'electron';
import { openUrl } from './browser-launcher';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { URL } from 'url';
import { BootConfig, getWebappBaseUrl } from './boot';
import { addAssetRoot, _assetFileWorkspaceRoots, diskFreeBatch } from './asset-protocol';
import { _windowProjectMap, _projectWindowMap, createWindow, editorFontSize, saveEditorFontSize, setEditorFontSize, broadcastEditorFontSize, bypassCloseConfirm, updateWingMinSize } from './window-manager';
import { StateStore } from './state-sqlite';
// import { LspBridge } from './lsp-bridge'; // LSP OFF — 2026-06-23
import { DownloadService } from './download-service';
import { UpdateService } from './update-service';
import { injectDevToolsConsoleButtons } from './devtools-inject';
import { renameDevToolsViaBroker, isPyBrokerReady } from './py-broker';
import { _consoleBuffer } from './window-manager';
import { applyMenuSchema, MenuSchema } from './menu-builder';
import { HashService } from './hash-service';
import { CacheStore } from './cache-store';

// ═══ 跨窗口脏文件快照（主进程内存，所有窗口共享） ═══
const _dirtySnapshots = new Map<string, string>();  // normalizedPath → latest dirty content

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
    hashService: HashService,
    cacheStore: CacheStore,
): void {
    // ═══ hash:buffer — SHA256/xxh64 fingerprinting ═══
    ipcMain.handle('qqqide:hash:buffer', async (_e, b64: string, mode?: 'fast' | 'strong' | 'both') => {
        try {
            const buf = Buffer.from(b64, 'base64');
            return hashService.hashBuffer(buf, mode || 'fast');
        } catch (e: any) {
            console.warn('[hash:buffer] failed:', e && e.message);
            return null;
        }
    });

    // ═══ cache (KV + bucketed file cache rooted at portable.cache) ═══
    ipcMain.handle('qqqide:cache:get', async (_e, key: string) => {
        return await cacheStore.get(key);
    });
    ipcMain.handle('qqqide:cache:put', async (_e, key: string, value: any, opts?: any) => {
        return await cacheStore.put(key, value, opts);
    });
    ipcMain.handle('qqqide:cache:has', async (_e, key: string) => {
        return await cacheStore.has(key);
    });
    ipcMain.handle('qqqide:cache:delete', async (_e, key: string) => {
        return await cacheStore.del(key);
    });
    ipcMain.handle('qqqide:cache:path', async (_e, key: string) => {
        return await cacheStore.path(key);
    });
    ipcMain.handle('qqqide:cache:bucketPath', async (_e, sig: string, ext?: string) => {
        return cacheStore.bucketPath(sig, ext);
    });

    // ═══ klipzap 中心剪贴板机 ═══
    // probe — 零 spawn，纯 Electron 内置，sub-ms
    ipcMain.handle('qqqide:clipboard:probe', async () => {
        const fmts = clipboard.availableFormats();
        const fmtSet = new Set(fmts.map((f: string) => f.toLowerCase()));
        return {
            hasText: fmtSet.has('text/plain') || fmtSet.has('text/utf8') || fmtSet.has('text'),
            hasHtml: fmtSet.has('text/html'),
            hasImage: fmtSet.has('image/png') || fmtSet.has('image/bmp') || fmtSet.has('image/jpeg') || fmtSet.has('image/tiff') || fmtSet.has('image/webp'),
            hasFile: fmtSet.has('hdrop') || fmtSet.has('filenamew') || fmtSet.has('filename') || fmtSet.has('cf_hdrop'),
            _rawFormats: fmts.slice(0, 20),
        };
    });

    // readHtml
    ipcMain.handle('qqqide:clipboard:readHtml', async () => {
        try { return clipboard.readHTML(); } catch { return ''; }
    });

    // writeText / readText / readImage / hasImage
    ipcMain.handle('qqqide:clipboard:writeText', async (_e, s: string) => clipboard.writeText(String(s)));
    ipcMain.handle('qqqide:clipboard:readText', async () => clipboard.readText());
    ipcMain.handle('qqqide:clipboard:readImage', async () => { var img = clipboard.readImage(); return img.isEmpty() ? null : img.toDataURL(); });
    ipcMain.handle('qqqide:clipboard:hasImage', async () => !clipboard.readImage().isEmpty());

    // readFiles — CF_HDROP via PowerShell (仅 Windows，低频路径)
    ipcMain.handle('qqqide:clipboard:readFiles', async () => {
        if (process.platform !== 'win32') return [];
        try {
            const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($list -and $list.Count -gt 0) {
    foreach ($f in $list) { Write-Output $f }
}
`.trim();
            const result = await new Promise<string>((resolve, reject) => {
                cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
                    timeout: 5000,
                    windowsHide: true,
                }, (err, stdout) => {
                    if (err) { reject(err); return; }
                    resolve(stdout || '');
                });
            });
            const lines = result.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
            return lines;
        } catch (e) {
            console.warn('[klipzap] readFiles failed:', e);
            return [];
        }
    });

    // writeFiles — CF_HDROP via PowerShell (仅 Windows)
    ipcMain.handle('qqqide:clipboard:writeFiles', async (_e, paths: string[]) => {
        if (process.platform !== 'win32') return false;
        if (!paths || paths.length === 0) return false;
        try {
            const escapedPaths = paths.map(p => `$col.Add('${p.replace(/'/g, "''")}')`).join('\n');
            const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$col = New-Object System.Collections.Specialized.StringCollection
${escapedPaths}
[System.Windows.Forms.Clipboard]::SetFileDropList($col)
`.trim();
            await new Promise<void>((resolve, reject) => {
                cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
                    timeout: 5000,
                    windowsHide: true,
                }, (err) => {
                    if (err) { reject(err); return; }
                    resolve();
                });
            });
            return true;
        } catch (e) {
            console.warn('[klipzap] writeFiles failed:', e);
            return false;
        }
    });

    // ---- shell (open file / URL) ----
    ipcMain.handle('qqqide:shell:openPath', async (_e, p: string) => {
        try { return await electronShell.openPath(p); } catch (e) { console.warn('[shell:openPath]', e); return ''; }
    });
    ipcMain.handle('qqqide:shell:openExternal', async (_e, url: string) => {
        openUrl(url, _e.sender);
    });

    // ★ Roam 空白区右键 → 在当前目录打开管理员终端 (CMD / PowerShell)
    // 与 q3 openAdminTerminal 百分百一致
    // ★ Roam 盘符区 Recycle Bin 点击 → 打开系统回收站（与 q3 openRecycleBin 一致）
    ipcMain.handle('qqqide:shell:openRecycleBin', async () => {
        try {
            if (process.platform === 'win32') {
                cp.spawn('explorer.exe', ['shell:RecycleBinFolder'], { windowsHide: true });
            } else if (process.platform === 'darwin') {
                cp.spawn('open', [path.join(require('os').homedir(), '.Trash')], { detached: true }).unref();
            } else {
                const trashPath = path.join(require('os').homedir(), '.local/share/Trash');
                if (fs.existsSync(trashPath)) {
                    cp.spawn('xdg-open', [trashPath], { detached: true }).unref();
                }
            }
        } catch (e) { console.warn('[shell:openRecycleBin]', e); }
        return true;
    });

    ipcMain.handle('qqqide:shell:openTerminal', async (_e, p: string, termType: string) => {
        const absPath = path.resolve(p);
        const safePath = absPath.replace(/'/g, "''");
        if (process.platform === 'win32') {
            if (termType === 'cmd') {
                const psScript = `Start-Process cmd.exe -ArgumentList '/k','cd /d """${safePath}"""' -Verb RunAs`;
                cp.spawn('powershell.exe', ['-NoProfile', '-Command', psScript], { windowsHide: true, shell: false });
            } else {
                const psScript = `Start-Process powershell.exe -ArgumentList '-NoExit','-Command',"Set-Location -LiteralPath '${safePath}'" -Verb RunAs`;
                cp.spawn('powershell.exe', ['-NoProfile', '-Command', psScript], { windowsHide: true, shell: false });
            }
        } else if (process.platform === 'darwin') {
            const escapedPath = absPath.replace(/'/g, "'\\''");
            const script = `tell application "Terminal" to do script "cd '${escapedPath}' && sudo -s"`;
            cp.spawn('osascript', ['-e', script], { detached: true }).unref();
        } else {
            const escapedPath = absPath.replace(/'/g, "'\"'\"'");
            const cdCmd = `cd '${escapedPath}'`;
            const terminals = [
                { cmd: 'gnome-terminal', args: ['--working-directory=' + absPath] },
                { cmd: 'konsole', args: ['--workdir', absPath] },
                { cmd: 'xfce4-terminal', args: ['--working-directory=' + absPath] },
                { cmd: 'x-terminal-emulator', args: [] },
            ];
            var spawned = false;
            for (var _i = 0; _i < terminals.length; _i++) {
                var t = terminals[_i];
                try {
                    cp.spawn(t.cmd, t.args, { cwd: absPath, detached: true }).unref();
                    spawned = true;
                    break;
                } catch (_e2) { /* try next */ }
            }
            if (!spawned) {
                cp.spawn('xterm', ['-e', 'bash -c "' + cdCmd + '; exec bash"'], { cwd: absPath, detached: true }).unref();
            }
        }
        return true;
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

    // ---- hard refresh (Ctrl+Shift+R equivalent) ——
    ipcMain.handle('qqqide:shell:hardRefresh', (e) => {
        const wc = e.sender;
        if (wc && !wc.isDestroyed()) { wc.reloadIgnoringCache(); }
    });

    // ---- app quit (退出全部窗口) — 菜单退出，跳过关闭确认 ——
    ipcMain.handle('qqqide:app:quitAll', async () => {
        // ★ 给所有窗口打旁路标签，跳过 close 事件确认框
        BrowserWindow.getAllWindows().forEach(function (w) {
            if (!w.isDestroyed()) bypassCloseConfirm(w);
        });
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
    // ★ 关闭确认回调：renderer 弹窗确认后调用，绕过 close 事件
    // ★ win.destroy() 只销毁当前窗口，不影响其他项目窗口（每个 BrowserWindow 独立）
    ipcMain.handle('qqqide:window:close-confirmed', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (win && !win.isDestroyed()) {
            bypassCloseConfirm(win);
            win.destroy();
        }
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
            const lockPath = normalized + '/_qqq/alphal/.lock';
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
        // ★ 使用本地 webapp 加载新窗口（与首次启动 bootSequence 一致）
        const baseUrl = getWebappBaseUrl(portableRoot, bootConfig, isDevFlag);
        const cacheBust = '&_v=' + encodeURIComponent(appVersion);
        let url: string;
        if (folderPath && typeof folderPath === 'string') {
            url = baseUrl + '?restore=1&folder=' + encodeURIComponent(folderPath) + cacheBust;
        } else {
            url = baseUrl + '?fresh=1' + cacheBust;
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
        // ★ DevTools 可能已用 fallback "qqqide" 改名，项目确认后重新改名
        const projName = path.basename(normalized);
        console.log('[devtools] claimProject: winId=' + win.id + ' normalized=' + normalized + ' projName=' + projName);
        setTimeout(() => renameDevToolsViaBroker(win, projName), 1500);
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

    // ★ renderer 可直接调用改 DevTools 标题（项目绑定完成后立即触发）
    ipcMain.handle('qqqide:devtools:rename', (_e, projectRoot: string) => {
        const win = BrowserWindow.fromWebContents(_e.sender);
        if (!win) return false;
        const normalized = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
        const projName = path.basename(normalized);
        console.log('[devtools] direct-rename: winId=' + win.id + ' projName=' + projName + ' brokerReady=' + isPyBrokerReady());
        // 不延迟 — renderer 调用时项目已绑定，broker 已就绪
        renameDevToolsViaBroker(win, projName);
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

    // ---- wing state: renderer tells main process which wings are open → update min size ----
    ipcMain.handle('qqqide:wing:state', async (e, leftOpen: boolean, rightOpen: boolean) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        updateWingMinSize(win, leftOpen, rightOpen);
    });

    // ---- editor font size (was zoom — now controls text size, not window scale) ----
    // adjust is the hot path (every repeat tick) — no persist, just memory + broadcast
    ipcMain.handle('qqqide:zoom:get', () => editorFontSize);
    ipcMain.handle('qqqide:zoom:set', (_e, size: number) => {
        const s = Math.max(1, Math.min(128, Math.round(Number(size))));
        setEditorFontSize(s);
        saveEditorFontSize(stateStore);
        broadcastEditorFontSize(s);
        return s;
    });
    ipcMain.handle('qqqide:zoom:adjust', (_e, delta: number) => {
        const next = Math.max(1, Math.min(128, Math.round(editorFontSize + Number(delta))));
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
    ipcMain.handle('qqqide:update:upgrade-shell', async () => updateService.upgradeShell());

    // ═══ 编辑器脏快照 — 跨窗口共享（Layer 2: IDE 领域内视觉一致） ═══
    ipcMain.handle('qqqide:dirty:set', (_e, filePath: string, content: string) => {
        _dirtySnapshots.set(filePath.replace(/\\/g, '/'), content);
    });
    ipcMain.handle('qqqide:dirty:get', (_e, filePath: string) => {
        return _dirtySnapshots.get(filePath.replace(/\\/g, '/')) || null;
    });
    ipcMain.handle('qqqide:dirty:remove', (_e, filePath: string) => {
        _dirtySnapshots.delete(filePath.replace(/\\/g, '/'));
    });
    ipcMain.handle('qqqide:dirty:list', () => {
        return [..._dirtySnapshots.keys()];
    });
}

