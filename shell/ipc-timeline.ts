// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-timeline.ts — Timeline 版本时间线 + Diff 窗口 IPC
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { _timelineDbs, _diffWindows, _tlDir, _tlBlobPath, _tlOpenDb, _tlRecord, _tlFlushNow, _sha256, _gzipSync, _gunzipSync, _tlWriteBlob } from './timeline-store';
import { BootConfig } from './boot';
import { APP_VERSION } from './version';
import { getDataDir } from './portable-paths';
import { addUiZoomListener } from './ui-zoom';

// diff 窗口 → 参考主窗口（界面缩放变更时重对齐用；WeakMap 随窗口回收）
const _diffRefs = new WeakMap<BrowserWindow, BrowserWindow>();

export function registerTimelineIpc(portableRoot: string, bootConfig: BootConfig): void {
    // ★ 编辑类快照防抖真理机（唯一入口，改一处全局生效）
    const COOLING_MS = 100000;       // 同文件两次快照最小间隔
    const COOLING_SOURCES = new Set(['editx']);
    const _lastRecordTs: Map<string, number> = new Map();
    const _lastRecordHash: Map<string, string> = new Map();

    // ═══ Timeline: record version ═══
    ipcMain.handle('qqqide:timeline:record', async (_e, args: { projectRoot: string; filePath: string; content: string; source: string; floorId?: string; addedLines?: number; deletedLines?: number }) => {
        try {
            const { projectRoot, filePath, content, source, floorId, addedLines, deletedLines } = args;
            if (!projectRoot || !filePath || content === undefined || content === null) return { ok: false, error: 'missing args' };
            const normalizedPath = filePath.replace(/\\/g, '/');
            const sha = _sha256(content);

            // ★ 编辑类快照：100s 冷却 + SHA256 内容去重（真理机，仅此一处）
            if (COOLING_SOURCES.has(source)) {
                const coolKey = normalizedPath + '|' + source;
                const prevHash = _lastRecordHash.get(coolKey);
                if (prevHash === sha) return { ok: true, blob_hash: sha, recorded: false, reason: 'same-content' };
                const prevTs = _lastRecordTs.get(coolKey) || 0;
                const now = Date.now();
                if (now - prevTs < COOLING_MS) return { ok: true, blob_hash: sha, recorded: false, reason: 'cooling' };
                _lastRecordTs.set(coolKey, now);
                _lastRecordHash.set(coolKey, sha);
            }

            const db = await _tlOpenDb(projectRoot);
            const dbPath = path.join(_tlDir(projectRoot), 'timeline.db');
            const blobPath = _tlBlobPath(projectRoot, sha);
            if (!fs.existsSync(blobPath)) {
                const gzBuf = _gzipSync(content);
                _tlWriteBlob(projectRoot, sha, gzBuf);
            }
            const ts = Date.now();
            _tlRecord(db, dbPath, projectRoot, {
                file_path: normalizedPath, ts, blob_hash: sha, source,
                floor_id: floorId || null, added_lines: addedLines || null, deleted_lines: deletedLines || null
            });
            return { ok: true, blob_hash: sha, ts, recorded: true };
        } catch (err: any) {
            console.error('[timeline:record]', err);
            return { ok: false, error: err.message };
        }
    });

    // ═══ Timeline: list versions ═══
    ipcMain.handle('qqqide:timeline:versions', async (_e, args: { projectRoot: string; filePath: string }) => {
        try {
            const { projectRoot, filePath } = args;
            if (!projectRoot || !filePath) return [];
            const normalizedPath = filePath.replace(/\\/g, '/');
            const db = await _tlOpenDb(projectRoot);
            const stmt = db.prepare('SELECT id, ts, blob_hash, source, floor_id, added_lines, deleted_lines, file_seq FROM versions WHERE file_path = ? ORDER BY id ASC');
            stmt.bind([normalizedPath]);
            const versionRows: any[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                versionRows.push({
                    id: row.id, ts: row.ts, blob_hash: row.blob_hash, source: row.source, floor_id: row.floor_id,
                    added_lines: row.added_lines, deleted_lines: row.deleted_lines,
                    file_seq: row.file_seq
                });
            }
            stmt.free();
            return versionRows;
        } catch (err: any) {
            console.error('[timeline:versions]', err);
            return [];
        }
    });

    // ═══ Timeline: get content by blob hash ═══
    ipcMain.handle('qqqide:timeline:content', async (_e, args: { projectRoot: string; blobHash: string }) => {
        try {
            const { projectRoot, blobHash } = args;
            if (!projectRoot || !blobHash) return null;
            const blobPath = _tlBlobPath(projectRoot, blobHash);
            if (!fs.existsSync(blobPath)) return null;
            const gzBuf = fs.readFileSync(blobPath);
            return _gunzipSync(gzBuf);
        } catch (err: any) {
            console.error('[timeline:content]', err);
            return null;
        }
    });

    // ═══ Timeline: file stat ═══
    ipcMain.handle('qqqide:timeline:stat', async (_e, filePath: string) => {
        try {
            const st = fs.statSync(filePath);
            return { mtimeMs: st.mtimeMs, size: st.size };
        } catch (_) {
            return null;
        }
    });

    // ═══ Timeline: read current file content ═══
    ipcMain.handle('qqqide:timeline:readCurrent', async (_e, filePath: string) => {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch (_) {
            return null;
        }
    });

    // ═══ Timeline: list tracked files ═══
    ipcMain.handle('qqqide:timeline:listTrackedFiles', async (_e, args: { projectRoot: string }) => {
        try {
            const { projectRoot } = args;
            if (!projectRoot) return [];
            const db = await _tlOpenDb(projectRoot);
            // ★ 记忆库根系数据源（diff 窗口 ▼ 全库列表，2026-09-11）：文件 + 快照数 + 最近活动 + 磁盘存在性
            const stmt = db.prepare('SELECT file_path, COUNT(*) as version_count, MAX(ts) as latest_ts FROM versions GROUP BY file_path');
            const files: any[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                let exists = false;
                try { exists = fs.existsSync(row.file_path); } catch (_) { }
                files.push({
                    file_path: row.file_path,
                    latest_ts: row.latest_ts,
                    version_count: row.version_count || 0,
                    exists,
                });
            }
            stmt.free();
            return files;
        } catch (err: any) {
            console.error('[timeline:listTrackedFiles]', err);
            return [];
        }
    });

    // ═══ Timeline: captureChanged (after run_command) ═══
    ipcMain.handle('qqqide:timeline:captureChanged', async (_e, args: { projectRoot: string; sinceMs: number; cwd?: string }) => {
        const { projectRoot, sinceMs } = args;
        const scanRoot = (args.cwd && args.cwd.startsWith(projectRoot)) ? args.cwd : projectRoot;
        if (!projectRoot || !sinceMs) return [];
        const MAX_SIZE = 512 * 1024;

        function isBinary(content: string) { return content.indexOf('\0') !== -1; }
        function tryRead(fp: string) {
            try {
                const st = fs.statSync(fp);
                if (st.mtimeMs <= sinceMs || st.size > MAX_SIZE) return null;
                const content = fs.readFileSync(fp, 'utf8');
                if (isBinary(content)) return null;
                return { filePath: fp.replace(/\\/g, '/'), content, size: st.size, mtimeMs: st.mtimeMs };
            } catch (_) { return null; }
        }

        const changed: any[] = [];
        let gitOk = false;

        // A: git diff
        try {
            const { execSync } = require('child_process');
            const gitFiles = new Set<string>();
            for (const gitArgs of [['diff', '--name-only', '--diff-filter=ACMR'], ['diff', '--cached', '--name-only', '--diff-filter=ACMR']]) {
                try {
                    const out = execSync('git', gitArgs, { cwd: scanRoot, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
                    for (const line of out.split('\n')) {
                        const t = line.trim();
                        if (t) gitFiles.add(path.resolve(scanRoot, t));
                    }
                } catch (_) { }
            }
            if (gitFiles.size > 0) {
                gitOk = true;
                for (const fp of gitFiles) { const f = tryRead(fp); if (f) changed.push(f); }
            }
        } catch (_) { }

        // B: file index fallback
        if (!gitOk) {
            const indexPath = path.join(_tlDir(projectRoot), 'file-index.json');
            let indexed: string[] = [];
            try { if (fs.existsSync(indexPath)) indexed = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (_) { }
            const indexedSet = new Set(indexed);
            for (const fp of indexed) { const f = tryRead(fp); if (f) changed.push(f); }

            const MAX_FILES = 500; let scanned = 0;
            function walkNew(dir: string): void {
                if (scanned >= MAX_FILES) return;
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
                for (const ent of entries) {
                    if (scanned >= MAX_FILES) return;
                    const fp = path.join(dir, ent.name);
                    if (ent.isDirectory()) {
                        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.tmp') continue;
                        walkNew(fp);
                    } else if ((ent.isFile() || ent.isSymbolicLink()) && !indexedSet.has(fp)) {
                        if (ent.name.endsWith('~') || ent.name.indexOf('.tmp.') !== -1) continue;
                        if (ent.name === '.DS_Store' || ent.name === 'Thumbs.db' || ent.name === 'desktop.ini') continue;
                        scanned++;
                        const f = tryRead(fp); if (f) changed.push(f);
                    }
                }
            }
            walkNew(scanRoot);
        }

        const results: any[] = [];
        for (const f of changed) {
            try {
                const sha = _sha256(f.content);
                const blobPath = _tlBlobPath(projectRoot, sha);
                if (!fs.existsSync(blobPath)) { const gzBuf = _gzipSync(f.content); _tlWriteBlob(projectRoot, sha, gzBuf); }
                const db = await _tlOpenDb(projectRoot);
                const dbPath2 = path.join(_tlDir(projectRoot), 'timeline.db');
                const ts = Date.now();
                _tlRecord(db, dbPath2, projectRoot, {
                    file_path: f.filePath, ts, blob_hash: sha, source: 'run-command'
                });
                results.push({ filePath: f.filePath, blob_hash: sha });
            } catch (_) { }
        }
        return results;
    });

    // ═══ diff 窗口几何机器（2026-10-01）═══
    // 实证（Electron 22 本机实测）：DOM rect 是 CSS px，界面缩放后 CSS px × webContents.getZoomFactor()
    //   = 窗口内 DIP（getBounds 恒为 DIP）——跨窗口几何换算必须乘缩放系数，否则缩放非 100% 时
    //   时间线窗口「对不齐中间窗口区域 / 比例失真」（zoom=1.25 时 720 CSS px 宽 = 900 DIP）。
    // 参考窗口 = 发送方窗口优先（三面板 iframe 同窗 → 即点击所在主窗口）；兜底全窗口扫 __qqqMainWindow 标记。
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

    // 测量参考窗口 #qqq-main 的目标矩形（含缩放换算）；measured=false = DOM 未测到（退回窗口 bounds）
    async function _measureMainArea(win: BrowserWindow): Promise<{ rect: Electron.Rectangle; zf: number; measured: boolean } | null> {
        try {
            const zf = _zoomOf(win);
            const jsRect: any = await _withTimeout(win.webContents.executeJavaScript(
                `(function(){var m=document.getElementById('qqq-main');if(!m)return null;var r=m.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`
            ), 4000);
            const wb = win.getBounds();
            if (jsRect && typeof jsRect.w === 'number' && jsRect.w > 0) {
                return {
                    rect: {
                        x: Math.round(wb.x + (jsRect.x || 0) * zf),
                        y: Math.round(wb.y + (jsRect.y || 0) * zf),
                        width: Math.round(jsRect.w * zf),
                        height: Math.round(jsRect.h * zf),
                    },
                    zf,
                    measured: true,
                };
            }
            return { rect: { x: wb.x, y: wb.y, width: wb.width, height: wb.height }, zf, measured: false };
        } catch (_) { return null; }
    }

    async function _pickRefAndRect(preferred: BrowserWindow | null): Promise<{ ref: BrowserWindow | null; rect: Electron.Rectangle; zf: number }> {
        const candidates: BrowserWindow[] = [];
        if (preferred && !preferred.isDestroyed()) { candidates.push(preferred); }
        for (const w of BrowserWindow.getAllWindows()) {
            if (w && !w.isDestroyed() && (w as any).__qqqMainWindow && candidates.indexOf(w) === -1) { candidates.push(w); }
        }
        for (const w of candidates) {
            const m = await _measureMainArea(w);
            if (m && m.measured) { return { ref: w, rect: m.rect, zf: m.zf }; }
        }
        const w0 = candidates[0] || null;
        if (w0) {
            const m2 = await _measureMainArea(w0);
            if (m2) { return { ref: w0, rect: m2.rect, zf: m2.zf }; }
        }
        return { ref: null, rect: { x: 0, y: 0, width: 1200, height: 700 }, zf: 1 };
    }

    function _setWinBoundsGeo(win: BrowserWindow, b: Electron.Rectangle): void {
        try {
            (win as any).__qqqGeoApplying = true;
            win.setBounds(b);
        } catch (_) { /* ignore */ } finally {
            setTimeout(() => { try { (win as any).__qqqGeoApplying = false; } catch (_) { } }, 150);
        }
    }

    async function _refitDiffWindow(win: BrowserWindow, ref: BrowserWindow): Promise<void> {
        if (win.isDestroyed() || ref.isDestroyed() || (win as any).__qqqUserMoved) { return; }
        const m = await _measureMainArea(ref);
        if (!m || !m.measured || win.isDestroyed() || (win as any).__qqqUserMoved) { return; }
        const minW = Math.round(1100 * m.zf), minH = Math.round(800 * m.zf);
        _setWinBoundsGeo(win, {
            x: m.rect.x,
            y: m.rect.y,
            width: Math.max(minW, m.rect.width),
            height: Math.max(minH, m.rect.height),
        });
    }

    async function _loadDiffUrlWithRetry(win: BrowserWindow, url: string, okSubstr: string): Promise<boolean> {
        for (let i = 0; i < 4; i++) {
            try {
                await win.webContents.loadURL(url);
                return true;
            } catch (err: any) {
                // 页面已就位的「中断」不算失败（渲染层自愈 reload 可在初始加载期打断 loadURL promise）
                try {
                    if (!win.isDestroyed() && !win.webContents.isLoadingMainFrame() &&
                        (win.webContents.getURL() || '').indexOf(okSubstr) !== -1) { return true; }
                } catch (_) { }
                if (i >= 3) {
                    console.warn('[diff-window] loadURL failed after retries:', err && err.message);
                    return false;
                }
                await new Promise((r) => setTimeout(r, 400 + i * 700));
            }
        }
        return false;
    }

    // 界面缩放变更 → 已开时间线窗口重对齐（用户手动调过几何的不打扰）
    addUiZoomListener(() => {
        const seen = new Set<BrowserWindow>();
        for (const w of _diffWindows.values()) {
            if (!w || w.isDestroyed() || seen.has(w)) { continue; }
            seen.add(w);
            if ((w as any).__qqqUserMoved) { continue; }
            const ref = _diffRefs.get(w);
            if (ref && !ref.isDestroyed()) { void _refitDiffWindow(w, ref); }
        }
    });

    // ═══ open diff window ═══
    ipcMain.handle('qqqide:open-diff-window', async (e, args: { filePath: string; beforeBlobHash?: string; afterBlobHash?: string; projectRoot: string }) => {
        const { filePath, beforeBlobHash, afterBlobHash, projectRoot } = args;
        const normalizedPath = filePath.replace(/\\/g, '/');

        const existingWin = _diffWindows.get(normalizedPath);
        if (existingWin && !existingWin.isDestroyed()) {
            try {
                // 复用推送必须带 projectRoot——渲染层「坏窗自愈」依此裁决是否整页重载（空根旧窗不得永久遮蔽文件）
                existingWin.webContents.send('qqqide:diff:update', { filePath: normalizedPath, projectRoot, beforeBlobHash, afterBlobHash });
                // 复用同时重对齐（用户未手动调过几何时）——主窗口移动/界面缩放已变，再次点击也必须落回正位
                const _ref0 = _diffRefs.get(existingWin);
                if (_ref0 && !_ref0.isDestroyed() && !(existingWin as any).__qqqUserMoved) { void _refitDiffWindow(existingWin, _ref0); }
                if (!existingWin.isVisible()) existingWin.show();
                if (existingWin.isMinimized()) existingWin.restore();
                existingWin.focus();
            } catch (_) { }
            return { ok: true, windowId: existingWin.id, reused: true };
        }

        // ★ 参考窗口 = 发送方窗口（三面板 iframe 同窗 → 即点击所在主窗口；多窗口下不再误取别窗）
        //   几何换算 ×界面缩放（CSS px × zoomFactor = DIP）——界面缩放非 100% 时对不齐的根因修复
        const _parentWin = BrowserWindow.fromWebContents(e.sender);
        const _picked = await _pickRefAndRect(_parentWin);
        const refWin = _picked.ref;
        const mainRect = _picked.rect;
        const zf = _picked.zf;
        const minW = Math.round(1100 * zf), minH = Math.round(800 * zf);
        const diffWin = new BrowserWindow({
            x: mainRect.x,
            y: mainRect.y,
            width: Math.max(minW, mainRect.width),
            height: Math.max(minH, mainRect.height),
            minWidth: minW,
            minHeight: minH,
            show: false, // 亮相即成品：加载成功才 show（失败重试/销毁，绝不残留黑窗）
            frame: false,
            title: 'Timeline Diff — ' + (filePath.split(/[\\/]/).pop() || filePath),
            backgroundColor: '#1e1e1e',
            parent: _parentWin || undefined,
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
            _diffWindows.delete(normalizedPath);
            for (const [k, v] of _diffWindows) {
                if (v === diffWin) _diffWindows.delete(k);
            }
        });
        _diffWindows.set(normalizedPath, diffWin);
        if (refWin && !refWin.isDestroyed()) { _diffRefs.set(diffWin, refWin); }
        // 用户手动拖动/缩放 → 接管几何：此后复用点击与缩放变更都不再自动重对齐
        const _markUserMoved = () => {
            if (!(diffWin as any).__qqqGeoApplying) { (diffWin as any).__qqqUserMoved = true; }
        };
        diffWin.on('move', _markUserMoved);
        diffWin.on('resize', _markUserMoved);

        diffWin.webContents.on('ipc-message', (_ev, ch, ...args) => {
            if (ch === 'qqqide:diff:set-path') {
                const newPath = (args && args[0]) ? String(args[0]).replace(/\\/g, '/') : '';
                if (newPath && newPath !== normalizedPath) {
                    _diffWindows.delete(normalizedPath);
                    _diffWindows.set(newPath, diffWin);
                }
            }
        });

        // ★ 绿色包/离线模式: 优先用本地 webapp 协议加载 diff-window.html
        var diffBaseUrl = bootConfig.url.replace(/\/*$/, '/');
        try {
            var webappIndex = path.join(getDataDir(), 'webapp', 'index.html');
            if (fs.existsSync(webappIndex)) {
                diffBaseUrl = 'qqqide-webapp://app/qqqide/';
            }
        } catch (_) { }
        let _isDark = true;
        try {
            if (refWin && !refWin.isDestroyed()) {
                const _darkVal: any = await _withTimeout(refWin.webContents.executeJavaScript(
                    'document.documentElement.getAttribute("data-theme") === "dark"'
                ), 3000);
                if (typeof _darkVal === 'boolean') { _isDark = _darkVal; }
            }
        } catch (_) { }
        const diffUrl = diffBaseUrl + 'timeline/diff-window.html' +
            '?path=' + encodeURIComponent(filePath) +
            '&projectRoot=' + encodeURIComponent(projectRoot) +
            '&theme=' + (_isDark ? 'dark' : 'light') +
            (beforeBlobHash ? '&before=' + encodeURIComponent(beforeBlobHash) : '') +
            (afterBlobHash ? '&after=' + encodeURIComponent(afterBlobHash) : '');
        // 四连试加载（开发服务重启/瞬时拒绝自愈）——成功才亮相；彻底失败销毁不留黑窗（「点击 A4 出不来」治理）
        const _loadedOk = await _loadDiffUrlWithRetry(diffWin, diffUrl, 'diff-window.html');
        if (!_loadedOk) {
            _diffWindows.delete(normalizedPath);
            try { if (!diffWin.isDestroyed()) { diffWin.destroy(); } } catch (_) { }
            return { ok: false, error: 'load failed' };
        }
        try { if (!diffWin.isDestroyed()) { diffWin.show(); diffWin.focus(); } } catch (_) { }
        return { ok: true, windowId: diffWin.id };
    });

    // ★ 宿主窗口定位：diff 窗口创建时带 parent（A4 所在窗口）→ getParentWindow 100% 可靠
    //   （旧 getAllWindows()[0] 在多窗口场景可能取到非主窗口 → executeJavaScript 静默失败 → “点击没用”）
    function _hostWindow(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
        // ① parent 链（diff 窗口创建时 parent=A4 所在窗口）→ 100% 精确
        const sender = BrowserWindow.fromWebContents(e.sender);
        if (sender && !sender.isDestroyed()) {
            const parent = sender.getParentWindow();
            if (parent && !parent.isDestroyed()) return parent;
        }
        // ② 兜底：找第一个 /qqqide/ 主页（排除 diff-window 自身与 DevTools）
        const wins = BrowserWindow.getAllWindows();
        const main = wins.find((w) => {
            if (w.isDestroyed()) return false;
            const url = w.webContents.getURL() || '';
            return url.indexOf('/qqqide/') !== -1 && url.indexOf('diff-window') === -1;
        });
        return main || wins.find((w) => !w.isDestroyed()) || null;
    }

    // ═══ op 按钮：在 X 区 editor 打开文件（= roam Q 键 open in qqqide）═══
    ipcMain.on('qqqide:timeline:open-in-editor', (_e, filePath: string) => {
        if (!filePath) return;
        const mw = _hostWindow(_e);
        if (!mw) return;
        mw.webContents.executeJavaScript(
            `(function(){ if(window.qqqTabs&&window.qqqTabs.openFile) window.qqqTabs.openFile(${JSON.stringify(filePath)}); })()`
        ).catch((err: any) => console.warn('[timeline:open-in-editor]', err && err.message));
    });

    // ═══ op 按钮：喂给 AI（路由到焦点面板）═══
    ipcMain.on('qqqide:timeline:feed-to-ai', (_e, filePath: string) => {
        if (!filePath) return;
        const mw = _hostWindow(_e);
        if (!mw) return;
        mw.webContents.executeJavaScript(
            `(function(){ if(window.__qqq_aiFeedFile) window.__qqq_aiFeedFile(${JSON.stringify(filePath)},false,null); })()`
        ).catch((err: any) => console.warn('[timeline:feed-to-ai]', err && err.message));
    });

    // ═══ op 按钮：在 Roam 中召回并打开（复用 AI 面板本地链接同一机器 = 主窗口 shell-overlay _roamRevealText）═══
    ipcMain.on('qqqide:timeline:reveal-in-roam', (_e, filePath: string) => {
        if (!filePath) return;
        const mw = _hostWindow(_e);
        if (!mw) return;
        mw.webContents.executeJavaScript(
            `(function(){ if(window.__qqq_roamRevealPath) window.__qqq_roamRevealPath(${JSON.stringify(filePath)}); })()`
        ).catch((err: any) => console.warn('[timeline:reveal-in-roam]', err && err.message));
    });

    // ═══ op 下拉：读取焦点面板方向（0左/1中/2右），diff 窗口据此显示 ←喂给 AI/喂给 AI/喂给 AI→ ═══
    ipcMain.handle('qqqide:timeline:get-ai-target', async (e) => {
        const mw = _hostWindow(e);
        if (!mw) return 1;
        try {
            const v = await mw.webContents.executeJavaScript(
                `(function(){ return (typeof window.__qqq_aiTarget === 'number') ? window.__qqq_aiTarget : 1; })()`
            );
            return (v === 0 || v === 2) ? v : 1;
        } catch (_) { return 1; }
    });
}
