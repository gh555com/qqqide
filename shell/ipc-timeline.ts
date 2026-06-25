// ============================================================================
// ipc-timeline.ts — Timeline 版本时间线 + Diff 窗口 IPC
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { _timelineDbs, _diffWindows, _tlDir, _tlBlobPath, _tlOpenDb, _tlRecord, _tlFlushNow, _sha256, _gzipSync, _gunzipSync, _tlWriteBlob } from './timeline-store';
import { BootConfig } from './boot';
import { APP_VERSION } from './version';

export function registerTimelineIpc(portableRoot: string, bootConfig: BootConfig): void {
    // ★ 编辑类快照防抖真理机（唯一入口，改一处全局生效）
    const COOLING_MS = 100000;       // 同文件两次快照最小间隔
    const COOLING_SOURCES = new Set(['editx', 'diff-edit']);
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
            const stmt = db.prepare('SELECT id, ts, blob_hash, source, floor_id, added_lines, deleted_lines FROM versions WHERE file_path = ? ORDER BY id ASC');
            stmt.bind([normalizedPath]);
            const versionRows: any[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                versionRows.push({
                    id: row.id, ts: row.ts, blob_hash: row.blob_hash, source: row.source, floor_id: row.floor_id,
                    added_lines: row.added_lines, deleted_lines: row.deleted_lines
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
            const stmt = db.prepare('SELECT DISTINCT file_path, MAX(ts) as latest_ts FROM versions GROUP BY file_path ORDER BY file_path ASC');
            const files: any[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                let exists = false;
                try { exists = fs.existsSync(row.file_path); } catch (_) { }
                files.push({
                    file_path: row.file_path,
                    latest_ts: row.latest_ts,
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

    // ═══ open diff window ═══
    ipcMain.handle('qqqide:open-diff-window', async (e, args: { filePath: string; beforeBlobHash?: string; afterBlobHash?: string; projectRoot: string }) => {
        const { filePath, beforeBlobHash, afterBlobHash, projectRoot } = args;
        const normalizedPath = filePath.replace(/\\/g, '/');

        const existingWin = _diffWindows.get(normalizedPath);
        if (existingWin && !existingWin.isDestroyed()) {
            try {
                existingWin.webContents.send('qqqide:diff:update', { filePath: normalizedPath, beforeBlobHash, afterBlobHash });
                if (existingWin.isMinimized()) existingWin.restore();
                existingWin.focus();
            } catch (_) { }
            return { ok: true, windowId: existingWin.id, reused: true };
        }

        const _parentWin = BrowserWindow.fromWebContents(e.sender);
        const mainWindow = BrowserWindow.getAllWindows()[0] || null;
        let mainRect = { x: 0, y: 0, width: 1200, height: 700 };
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                const jsRect = await mainWindow.webContents.executeJavaScript(
                    `(function(){var m=document.getElementById('qqq-main');if(!m)return null;var r=m.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`
                );
                if (jsRect && jsRect.w > 0) {
                    const wb = mainWindow.getBounds();
                    mainRect = { x: wb.x + (jsRect.x || 0), y: wb.y + (jsRect.y || 0), width: jsRect.w, height: jsRect.h };
                } else {
                    const wb = mainWindow.getBounds();
                    mainRect = { x: wb.x, y: wb.y, width: wb.width, height: wb.height };
                }
            } catch (_) {
                const wb = mainWindow.getBounds();
                mainRect = { x: wb.x, y: wb.y, width: wb.width, height: wb.height };
            }
        }
        const diffWin = new BrowserWindow({
            x: mainRect.x,
            y: mainRect.y,
            width: Math.max(1100, mainRect.width),
            height: Math.max(800, mainRect.height),
            minWidth: 1100,
            minHeight: 800,
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

        diffWin.webContents.on('ipc-message', (_ev, ch, ...args) => {
            if (ch === 'qqqide:diff:set-path') {
                const newPath = (args && args[0]) ? String(args[0]).replace(/\\/g, '/') : '';
                if (newPath && newPath !== normalizedPath) {
                    _diffWindows.delete(normalizedPath);
                    _diffWindows.set(newPath, diffWin);
                }
            }
        });

        const baseUrl = bootConfig.url.replace(/\/*$/, '/');
        let _isDark = true;
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                _isDark = await mainWindow.webContents.executeJavaScript(
                    'document.documentElement.getAttribute("data-theme") === "dark"'
                );
            }
        } catch (_) { }
        const diffUrl = baseUrl + 'timeline/diff-window.html' +
            '?path=' + encodeURIComponent(filePath) +
            '&projectRoot=' + encodeURIComponent(projectRoot) +
            '&theme=' + (_isDark ? 'dark' : 'light') +
            (beforeBlobHash ? '&before=' + encodeURIComponent(beforeBlobHash) : '') +
            (afterBlobHash ? '&after=' + encodeURIComponent(afterBlobHash) : '');
        diffWin.loadURL(diffUrl).catch(err => {
            console.warn('[diff-window] loadURL failed:', err && err.message);
            _diffWindows.delete(normalizedPath);
        });
        return { ok: true, windowId: diffWin.id };
    });
}
