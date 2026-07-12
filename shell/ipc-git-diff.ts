// ============================================================================
// ipc-git-diff.ts — Git Diff 窗口 IPC（独立 BrowserWindow, read-only Monaco side-by-side）
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getComponentBin } from './component-checker';
import { BootConfig } from './boot';
import { APP_VERSION } from './version';

// Dedicated map for git diff windows (key: filePath|commitHash)
const _gitDiffWindows: Map<string, BrowserWindow> = new Map();

export function registerGitDiffIpc(portableRoot: string, bootConfig: BootConfig): void {

    // ═══ Git: open diff window ═══
    ipcMain.handle('qqqide:git:open-diff', async (e, args: { filePath: string; projectRoot: string; commitHash?: string; mode?: string; staged?: boolean }) => {
        const { filePath, projectRoot, commitHash, mode, staged } = args;
        const winKey = filePath.replace(/\\/g, '/') + '|' + (commitHash || 'working');
        const normalizedPath = filePath.replace(/\\/g, '/');

        // Reuse existing window for same file+commit
        const existingWin = _gitDiffWindows.get(winKey);
        if (existingWin && !existingWin.isDestroyed()) {
            try {
                existingWin.webContents.send('qqqide:git-diff:update', { filePath: normalizedPath, commitHash, mode, staged });
                if (existingWin.isMinimized()) existingWin.restore();
                existingWin.focus();
            } catch (_) { }
            return { ok: true, windowId: existingWin.id, reused: true };
        }

        // Use the sender's window as positioning reference
        const mainWin = BrowserWindow.fromWebContents(e.sender);
        let mainRect = { x: 0, y: 0, width: 1200, height: 700 };
        if (mainWin && !mainWin.isDestroyed()) {
            try {
                const wb = mainWin.getBounds();
                mainRect = { x: wb.x, y: wb.y, width: wb.width, height: wb.height };
            } catch (_) { }
        }

        // Calculate position: right-aligned, 2/3 width, fills between menu row 1 and status bar
        let menuBarH = 0, statusBarH = 0;
        try {
            if (mainWin && !mainWin.isDestroyed()) {
                menuBarH = await mainWin.webContents.executeJavaScript(
                    '(document.getElementById("qqq-menu-row")?.offsetHeight || 28)'
                );
                statusBarH = await mainWin.webContents.executeJavaScript(
                    '(document.getElementById("qqq-status-bar")?.offsetHeight || 24)'
                );
            }
        } catch (_) { }

        const diffW = Math.floor(mainRect.width * 2 / 3);
        const diffH = mainRect.height - menuBarH - statusBarH;
        const diffX = mainRect.x + (mainRect.width - diffW);
        const diffY = mainRect.y + menuBarH;

        const diffWin = new BrowserWindow({
            x: diffX,
            y: diffY,
            width: Math.max(800, diffW),
            height: Math.max(600, diffH),
            minWidth: 800,
            minHeight: 600,
            frame: false,
            title: 'Git Diff — ' + (filePath.split(/[\\/]/).pop() || filePath),
            backgroundColor: '#1e1e1e',
            parent: mainWin || undefined,
            modal: false,
            resizable: true,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
                webSecurity: false,
                additionalArguments: [
                    `--qqqide-root=${portableRoot}`,
                    `--qqqide-version=${APP_VERSION}`,
                ],
            },
        });
        diffWin.removeMenu();
        diffWin.on('closed', () => {
            _gitDiffWindows.delete(winKey);
        });
        _gitDiffWindows.set(winKey, diffWin);

        // URL base — always use bootConfig.url for dev or production
        const diffBaseUrl = bootConfig.url.replace(/\/*$/, '/');

        // Theme detection
        let _isDark = true;
        try {
            if (mainWin && !mainWin.isDestroyed()) {
                _isDark = await mainWin.webContents.executeJavaScript(
                    'document.documentElement.getAttribute("data-theme") === "dark"'
                );
            }
        } catch (_) { }

        // Pass the git binary path so the diff window can run git commands
        const _gitBin = getComponentBin(portableRoot, 'git') || 'git';

        const diffUrl = diffBaseUrl + 'goods/git/git-diff-window.html' +
            '?filePath=' + encodeURIComponent(filePath) +
            '&projectRoot=' + encodeURIComponent(projectRoot) +
            '&gitBin=' + encodeURIComponent(_gitBin) +
            '&theme=' + (_isDark ? 'dark' : 'light') +
            '&mode=' + (mode || 'working') +
            (commitHash ? '&commitHash=' + encodeURIComponent(commitHash) : '') +
            (staged ? '&staged=1' : '');

        console.log('[git-diff-window] loading:', diffUrl);

        diffWin.loadURL(diffUrl).catch(err => {
            console.warn('[git-diff-window] loadURL failed:', err && err.message);
            _gitDiffWindows.delete(winKey);
            try { diffWin.close(); } catch (_) { }
        });

        return { ok: true, windowId: diffWin.id };
    });
}
