// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-git-diff.ts — git diff 窗口 IPC（独立 BrowserWindow, read-only Monaco side-by-side）
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getComponentBin } from './component-checker';
import { BootConfig } from './boot';
import { APP_VERSION } from './version';
import { addUiZoomListener } from './ui-zoom';

// Dedicated map for git diff windows (key: filePath|commitHash)
const _gitDiffWindows: Map<string, BrowserWindow> = new Map();
// git diff 窗口 → 参考主窗口（界面缩放变更时重对齐用；WeakMap 随窗口回收）
const _gitDiffRefs = new WeakMap<BrowserWindow, BrowserWindow>();

export function registerGitDiffIpc(portableRoot: string, bootConfig: BootConfig): void {

    // ═══ diff 窗口几何机器（2026-10-01）═══
    // 实证（Electron 22 本机实测）：DOM rect 是 CSS px，CSS px × webContents.getZoomFactor() = DIP
    //   （zoom=1.25 时 720 CSS px 宽 = 900 DIP）——界面缩放非 100% 时必须换算，否则位置/比例失真。
    // 语义：右对齐 + 2/3 宽；纵向 = 菜单行2 底（.qqq-menu-row-2.bottom）→ 状态区顶（.qqq-status-area.top），
    //   左右 1/3 与菜单行1 保持可见。
    function _zoomOf(win: BrowserWindow): number {
        try {
            const f = win.webContents.getZoomFactor();
            return (typeof f === 'number' && isFinite(f) && f > 0) ? f : 1;
        } catch (_) { return 1; }
    }

    function _withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
        return new Promise((resolve) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
            p.then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
                .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
        });
    }

    async function _gitDiffTargetRect(ref: BrowserWindow): Promise<{ x: number; y: number; width: number; height: number; zf: number } | null> {
        try {
            const zf = _zoomOf(ref);
            const wb = ref.getBounds();
            const g: any = await _withTimeout(ref.webContents.executeJavaScript(
                `(function(){var m2=document.querySelector('.qqq-menu-row-2');var st=document.querySelector('.qqq-status-area');var t=(m2&&m2.getBoundingClientRect().bottom)||0;var b=(st&&st.getBoundingClientRect().top)||0;if(!(b>t)){b=(document.documentElement.clientHeight||0);}return {top:t,bottom:b};})()`
            ), 4000);
            const topCss = (g && g.top > 0) ? g.top : 60; // 兜底：两行菜单 ≈ 60 CSS px
            const botCss = (g && g.bottom > ((g && g.top) || 0)) ? g.bottom : (wb.height / zf - 24);
            const topDip = Math.round(topCss * zf);
            const botDip = Math.round(botCss * zf);
            const diffW = Math.floor(wb.width * 2 / 3);
            const diffH = Math.max(200, botDip - topDip);
            return { x: wb.x + (wb.width - diffW), y: wb.y + topDip, width: diffW, height: diffH, zf };
        } catch (_) { return null; }
    }

    function _setWinBoundsGeo(win: BrowserWindow, b: Electron.Rectangle): void {
        try {
            (win as any).__qqqGeoApplying = true;
            (win as any).__qqqLastGeo = { x: b.x, y: b.y, width: b.width, height: b.height };
            win.setBounds(b);
        } catch (_) { /* ignore */ } finally {
            setTimeout(() => { try { (win as any).__qqqGeoApplying = false; } catch (_) { } }, 150);
        }
    }

    async function _refitGitDiffWindow(win: BrowserWindow, ref: BrowserWindow): Promise<void> {
        if (win.isDestroyed() || ref.isDestroyed() || (win as any).__qqqUserMoved) { return; }
        const t = await _gitDiffTargetRect(ref);
        if (!t || win.isDestroyed() || (win as any).__qqqUserMoved) { return; }
        const minW = Math.round(800 * t.zf), minH = Math.round(600 * t.zf);
        _setWinBoundsGeo(win, { x: t.x, y: t.y, width: Math.max(minW, t.width), height: Math.max(minH, t.height) });
    }

    async function _loadDiffUrlWithRetry(win: BrowserWindow, url: string, okSubstr: string): Promise<boolean> {
        for (let i = 0; i < 4; i++) {
            // 单次加载 15s 兜底（半死服务=连接挂起不归 → retry 永不触发 → 「点击出不来」；超时强断重试）
            const r: any = await _withTimeout(win.webContents.loadURL(url), 15000);
            if (r !== null) { return true; }
            try { win.webContents.stop(); } catch (_) { }
            // 页面已就位的「中断」不算失败（渲染层自愈 reload 可在初始加载期打断 loadURL promise）
            try {
                if (!win.isDestroyed() && !win.webContents.isLoadingMainFrame() &&
                    (win.webContents.getURL() || '').indexOf(okSubstr) !== -1) { return true; }
            } catch (_) { }
            if (i >= 3) {
                console.warn('[diff-window] loadURL failed after retries: timeout/reject');
                return false;
            }
            await new Promise((r2) => setTimeout(r2, 400 + i * 700));
        }
        return false;
    }

    // 界面缩放变更 → 已开 git diff 窗口重对齐（用户手动调过几何的不打扰）
    addUiZoomListener(() => {
        const seen = new Set<BrowserWindow>();
        for (const w of _gitDiffWindows.values()) {
            if (!w || w.isDestroyed() || seen.has(w)) { continue; }
            seen.add(w);
            const ref = _gitDiffRefs.get(w);
            if ((w as any).__qqqUserMoved) { continue; }
            if (ref && !ref.isDestroyed()) { void _refitGitDiffWindow(w, ref); }
        }
    });

    // ═══ git: open diff window ═══
    ipcMain.handle('qqqide:git:open-diff', async (e, args: { filePath: string; projectRoot: string; commitHash?: string; mode?: string; staged?: boolean }) => {
        const { filePath, projectRoot, commitHash, mode, staged } = args;
        const winKey = filePath.replace(/\\/g, '/') + '|' + (commitHash || 'working');
        const normalizedPath = filePath.replace(/\\/g, '/');

        // Reuse existing window for same file+commit
        const existingWin = _gitDiffWindows.get(winKey);
        if (existingWin && !existingWin.isDestroyed()) {
            try {
                existingWin.webContents.send('qqqide:git-diff:update', { filePath: normalizedPath, commitHash, mode, staged });
                // 复用同时重对齐（用户未手动调过几何时）——主窗口移动/界面缩放已变，再次点击也必须落回正位
                const _ref0 = _gitDiffRefs.get(existingWin);
                if (_ref0 && !_ref0.isDestroyed() && !(existingWin as any).__qqqUserMoved) { void _refitGitDiffWindow(existingWin, _ref0); }
                if (!existingWin.isVisible()) existingWin.show();
                if (existingWin.isMinimized()) existingWin.restore();
                existingWin.focus();
            } catch (_) { }
            return { ok: true, windowId: existingWin.id, reused: true };
        }

        // 参考窗口 = 发送方窗口（多窗口下即点击所在主窗口）；几何 ×界面缩放（CSS px × zoomFactor = DIP）
        const mainWin = BrowserWindow.fromWebContents(e.sender) ||
            BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed() && (w as any).__qqqMainWindow) || null;
        const _target = mainWin ? await _gitDiffTargetRect(mainWin) : null;
        const zf = _target ? _target.zf : 1;
        const diffX = _target ? _target.x : 0;
        const diffY = _target ? _target.y : 0;
        const diffW = _target ? _target.width : 800;
        const diffH = _target ? _target.height : 600;
        const minW = Math.round(800 * zf), minH = Math.round(600 * zf);
        const _initW = Math.max(minW, diffW), _initH = Math.max(minH, diffH);

        const diffWin = new BrowserWindow({
            x: diffX,
            y: diffY,
            width: _initW,
            height: _initH,
            minWidth: minW,
            minHeight: minH,
            show: false, // 亮相即成品：加载成功才 show（失败重试/销毁，绝不残留黑窗）
            frame: false,
            title: 'git diff — ' + (filePath.split(/[\\/]/).pop() || filePath),
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
        if (mainWin && !mainWin.isDestroyed()) { _gitDiffRefs.set(diffWin, mainWin); }
        // 已知几何记录：系统在 show()/首帧会补发一次「与创建值相同」的 move/resize 噪声——同值绝不算用户动过
        (diffWin as any).__qqqLastGeo = { x: diffX, y: diffY, width: _initW, height: _initH };
        // 用户手动拖动/缩放 → 接管几何：此后复用点击与缩放变更都不再自动重对齐
        const _markUserMoved = () => {
            if ((diffWin as any).__qqqGeoApplying) { return; }
            try {
                const b = diffWin.getBounds();
                const g = (diffWin as any).__qqqLastGeo;
                if (g && Math.abs(b.x - g.x) <= 2 && Math.abs(b.y - g.y) <= 2 && Math.abs(b.width - g.width) <= 2 && Math.abs(b.height - g.height) <= 2) { return; }
            } catch (_) { }
            (diffWin as any).__qqqUserMoved = true;
        };
        diffWin.on('move', _markUserMoved);
        diffWin.on('resize', _markUserMoved);

        // URL base — always use bootConfig.url for dev or production
        const diffBaseUrl = bootConfig.url.replace(/\/*$/, '/');

        // Theme detection
        let _isDark = true;
        try {
            if (mainWin && !mainWin.isDestroyed()) {
                const _darkVal: any = await _withTimeout(mainWin.webContents.executeJavaScript(
                    'document.documentElement.getAttribute("data-theme") === "dark"'
                ), 3000);
                if (typeof _darkVal === 'boolean') { _isDark = _darkVal; }
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

        // 四连试加载（开发服务重启/瞬时拒绝自愈）——成功才亮相；彻底失败销毁不留黑窗
        const _loadedOk = await _loadDiffUrlWithRetry(diffWin, diffUrl, 'git-diff-window.html');
        if (!_loadedOk) {
            _gitDiffWindows.delete(winKey);
            try { if (!diffWin.isDestroyed()) { diffWin.destroy(); } } catch (_) { }
            return { ok: false, error: 'load failed' };
        }
        try { if (!diffWin.isDestroyed()) { diffWin.show(); diffWin.focus(); } } catch (_) { }
        return { ok: true, windowId: diffWin.id };
    });
}
