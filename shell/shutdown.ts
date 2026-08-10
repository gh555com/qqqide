// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shutdown.ts — 安全加固 / 会话锁定 / 退出处理器
// ============================================================================

import { app, BrowserWindow, session, shell as electronShell } from 'electron';
import { openUrl } from './browser-launcher';
import * as path from 'path';
import * as fs from 'fs';
import { URL } from 'url';
import { BootConfig } from './boot';
import { StateStore } from './state-sqlite';
import { Qgf } from './qgf';
import { _timelineDbs, _tlFlushNow } from './timeline-store';
import { _windowProjectMap, getWindowWingState } from './window-manager';
import { releaseProject } from './project-lock';
import { wsStateSetKey } from './ipc-ws-state';
import { crashNetMarkCleanQuit } from './crash-net';

// ── 自动版本递增 ──────────────────────────────────────────────────────────
const AUTO_VERSION_TOGGLE_OFF = 'auto-version-off';

function autoIncrementVersion(portableRoot: string): void {
    try {
        // ── 开关: Data/auto-version-off 存在 → 跳过 ──
        const toggleOff = path.join(portableRoot, 'Data', AUTO_VERSION_TOGGLE_OFF);
        if (fs.existsSync(toggleOff)) {
            console.log('[auto-version] OFF (toggle file exists), skip');
            return;
        }

        // ── 读取当前版本: 优先 version.ts 源码，否则读 main.js ──
        const versionTs = path.join(portableRoot, 'shell', 'version.ts');
        const mainJs = path.join(portableRoot, 'shell-out', 'main.js');
        const pkgJson = path.join(portableRoot, 'package.json');

        let oldVer = '';
        const tsExists = fs.existsSync(versionTs);

        if (tsExists) {
            const ts = fs.readFileSync(versionTs, 'utf8');
            const m = ts.match(/export const APP_VERSION\s*=\s*'(\d+)\.(\d+)\.(\d+)'/);
            if (m) oldVer = `${m[1]}.${m[2]}.${m[3]}`;
        }

        if (!oldVer && fs.existsSync(mainJs)) {
            const js = fs.readFileSync(mainJs, 'utf8');
            const m = js.match(/var APP_VERSION\s*=\s*"(\d+)\.(\d+)\.(\d+)"/);
            if (m) oldVer = `${m[1]}.${m[2]}.${m[3]}`;
        }

        if (!oldVer) {
            console.log('[auto-version] cannot read current version, skip');
            return;
        }

        const parts = oldVer.split('.');
        const newPatch = parseInt(parts[2], 10) + 1;
        const newVer = `${parts[0]}.${parts[1]}.${newPatch}`;

        console.log('[auto-version] ' + oldVer + ' → ' + newVer);

        // ── 更新 shell/version.ts ──
        if (tsExists) {
            let ts = fs.readFileSync(versionTs, 'utf8');
            ts = ts.replace(
                /export const APP_VERSION\s*=\s*'\d+\.\d+\.\d+'/,
                `export const APP_VERSION = '${newVer}'`,
            );
            fs.writeFileSync(versionTs, ts, 'utf8');
            console.log('[auto-version] version.ts updated');
        }

        // ── 更新 shell-out/main.js ──
        if (fs.existsSync(mainJs)) {
            let js = fs.readFileSync(mainJs, 'utf8');
            js = js.replace(
                /var APP_VERSION\s*=\s*"\d+\.\d+\.\d+"/,
                `var APP_VERSION = "${newVer}"`,
            );
            fs.writeFileSync(mainJs, js, 'utf8');
            console.log('[auto-version] main.js updated');
        }

        // ── 更新 package.json ──
        if (fs.existsSync(pkgJson)) {
            let pkg = fs.readFileSync(pkgJson, 'utf8');
            pkg = pkg.replace(
                /"version"\s*:\s*"\d+\.\d+\.\d+"/,
                `"version": "${newVer}"`,
            );
            fs.writeFileSync(pkgJson, pkg, 'utf8');
            console.log('[auto-version] package.json updated');
        }

        // ★ 2026-08-10 重构: Data/shell-version / webapp-version 已废弃
        //   （版本唯一权威 = gh555.com/versions.json，由 pack.js 生成）

        console.log('[auto-version] done: ' + oldVer + ' → ' + newVer);
    } catch (err: any) {
        console.warn('[auto-version] error:', err.message || err);
    }
}

// ── 保存所有打开窗口（退出前调用，供下次启动多窗口还原）──
// ★ 2026-08-09 修复: X 关闭路径下窗口已全部销毁 → 本函数空转, open_windows 永不保存。
//   现语义: 仅菜单退出等窗口仍存活路径在此保存; X 关闭路径由 window-manager 的
//   _saveOpenWindowsNow（close 事件内捕获）负责。双写 global.sq3 + OS 级 ws.sq3。
export function saveAllOpenWindows(stateStore: StateStore, winProjectMap: Map<number, string>): void {
    try {
        const live = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
        if (live.length === 0) {
            // X 关闭路径: 已在各窗口 close 事件里保存过, 这里保持旧值即可
            return;
        }
        const seen = new Set<string>();
        const windows: any[] = [];
        for (const win of live) {
            try {
                const rawFolder = (winProjectMap.get(win.id) || '').replace(/\\/g, '/').replace(/\/$/, '');
                // ★ 验证: 路径存在且有 qqq/ 子目录(真正的项目), 过滤空值/已删除/非项目
                let mainFolder = '';
                if (rawFolder && fs.existsSync(rawFolder) && fs.existsSync(rawFolder + '/_qqq')) {
                    mainFolder = rawFolder;
                } else if (rawFolder) {
                    console.warn('[shutdown] skip invalid project:', rawFolder);
                }
                if (!mainFolder) continue;
                // ★ 去重：同主文件夹只保留第一个窗口
                if (seen.has(mainFolder)) continue;
                seen.add(mainFolder);
                const bounds = win.getBounds();
                const maximized = win.isMaximized();
                // ★ 每窗口翼状态一并保存（多窗口还原时各自恢复翼）
                const wings = getWindowWingState(win);
                windows.push({
                    mainFolder,
                    bounds: {
                        x: bounds.x, y: bounds.y,
                        w: bounds.width, h: bounds.height,
                        maximized: maximized
                    },
                    wings
                });
            } catch (e) {
                // 窗口可能在 isDestroyed() 和 getBounds() 之间被销毁
                try { console.warn('[shutdown] skip window (destroyed mid-save):', (e as Error).message); } catch (_) { }
            }
        }
        if (windows.length > 0) {
            stateStore.setNow('qqqide', 'open_windows', windows);
            // ★ OS 级兜底（删包/换包后回写）
            try { wsStateSetKey('openWindows', windows); } catch { /* ignore */ }
            console.log('[shutdown] saved ' + windows.length + ' open window(s) for next-startup restore');
        }
    } catch (e) {
        console.warn('[shutdown] saveAllOpenWindows failed:', e);
    }
}

// ---- Security hardening ----
export function hardenSession(): void {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));

    ses.webRequest.onHeadersReceived((details, cb) => {
        const headers = details.responseHeaders || {};
        delete headers['x-frame-options'];
        delete headers['X-Frame-Options'];
        if (details.url.includes('gh555.com')) {
            headers['access-control-allow-origin'] = ['*'];
            headers['access-control-allow-headers'] = ['Content-Type, Authorization'];
            headers['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, OPTIONS'];
            if (details.method === 'OPTIONS') {
                cb({ responseHeaders: headers, statusLine: 'HTTP/1.1 200 OK' });
                return;
            }
        }
        cb({ responseHeaders: headers });
    });
}

// ---- Exit handlers ----
export function registerExitHandlers(
    portableRoot: string,
    portableLogs: string,
    stateStore: StateStore,
    bootConfig: BootConfig,
    qgfInstances: Map<string, Qgf>,
): void {
    // Sync flush helper — SQLite
    function _flushStateSync(label: string): void {
        try {
            stateStore.flushSync();
        } catch (err) {
            try { console.warn('[state] ' + label + ' flush failed:', err); } catch (_) { }
        }
    }

    // Sync flush helper — qgf FS instances
    function _flushQgfSync(label: string): void {
        for (const [rootDir, qf] of qgfInstances) {
            try {
                qf.flushSync();
            } catch (err) {
                try { console.warn('[qgf] ' + label + ' flush failed for', rootDir, err); } catch (_) { }
            }
        }
    }

    let _flushedOnce = false;

    // before-quit: graceful cleanup
    app.on('before-quit', async (event) => {
        if (_flushedOnce) return;
        _flushedOnce = true;
        event.preventDefault();

        // ① stop python broker
        try {
            const { stopPyBroker } = require('./py-broker');
            stopPyBroker();
        } catch { /* ignore */ }

        // ①b cleanup gaea processes
        try {
            const { cleanupAllGaeaProcesses } = require('./gaea-process');
            cleanupAllGaeaProcesses();
        } catch { /* ignore */ }

        // ①c cleanup kmd terminal sessions（杀全部会话进程树，防孤儿）
        try {
            const { killAllKmdSessions } = require('./ipc-kmd');
            killAllKmdSessions();
        } catch { /* ignore */ }


        // ② flush state (SQLite + qgf FS)
        try { _flushStateSync('before-quit'); } catch { /* ignore */ }
        try { _flushQgfSync('before-quit'); } catch { /* ignore */ }

        // ③ async flush
        try {
            await stateStore.flush();
        } catch (err) {
            try { console.warn('[state] async flush before-quit failed:', err); } catch (_) { }
        }
        _flushStateSync('before-quit');

        _timelineDbs.forEach((db, dbPath) => {
            try {
                const projectRoot = path.dirname(path.dirname(path.dirname(dbPath)));
                _tlFlushNow(db, dbPath, projectRoot);
            } catch (_) { }
        });

        // ④ save open windows for next-startup multi-window restore
        try { saveAllOpenWindows(stateStore, _windowProjectMap); } catch { /* ignore */ }

        // ⑤ clean project lock files — 校验 instanceId+winId 释放（绝不误删他人实例的锁）
        for (const [winId] of _windowProjectMap) {
            try { releaseProject(winId); } catch (_) { }
        }

        // ⑥ auto-increment version for next boot cache-busting
        try { autoIncrementVersion(portableRoot); } catch { /* ignore */ }

        // ⑦ 最后一枪：兜底 sync flush（防 async flush→exit 之间写入的数据丢失）
        //    will-quit 不适用于此（app.exit 会跳过 will-quit），改用双写锁保险。
        try { _flushStateSync('exit'); } catch { /* ignore */ }
        try { _flushQgfSync('exit'); } catch { /* ignore */ }

        // ★ 天罗地网: 正常退出标记 — app.exit 跳过 will-quit, 必须在此处显式标记
        try { crashNetMarkCleanQuit(); } catch { /* ignore */ }

        app.exit(0);
        setTimeout(() => { process.exit(0); }, 500);
    });

    // SIGINT/SIGTERM
    process.on('SIGINT', () => { _flushStateSync('SIGINT'); _flushQgfSync('SIGINT'); try { app.quit(); } catch { process.exit(0); } });
    process.on('SIGTERM', () => { _flushStateSync('SIGTERM'); _flushQgfSync('SIGTERM'); try { app.quit(); } catch { process.exit(0); } });

    // Global uncaught exception handler
    let _ueInHandler = false;
    let _ueLastLogTs = 0;
    process.on('uncaughtException', (err) => {
        // EPIPE/ECONNRESET: stdout broken (no console window). Suppress silently.
        const _msg = (err && (err as any).message) || '';
        if (_msg.indexOf('EPIPE') >= 0 || _msg.indexOf('broken pipe') >= 0 || _msg.indexOf('ECONNRESET') >= 0) {
            return;
        }
        if (_ueInHandler) return;
        _ueInHandler = true;
        try {
            if (err && err.message === 'Object has been destroyed') {
                try { console.warn('[main] uncaughtException (Object destroyed) suppressed'); } catch (_) { }
                return;
            }
            try { console.error('[uncaughtException]', err); } catch (_) { }
            _flushStateSync('uncaughtException');
            _flushQgfSync('uncaughtException');
            if (_msg.indexOf('Object has been destroyed') < 0) {
                const now = Date.now();
                if (now - _ueLastLogTs > 5000) {
                    _ueLastLogTs = now;
                    try {
                        const f = path.join(portableLogs, 'crash-' + now + '.log');
                        fs.writeFileSync(f, String(err && (err as any).stack || err));
                    } catch (_) { }
                }
            }
        } finally {
            _ueInHandler = false;
        }
    });

    process.on('unhandledRejection', (reason) => {
        try { console.warn('[unhandledRejection]', reason); } catch (_) { }
    });

    // All windows closed → quit
    app.on('window-all-closed', () => {
        console.log('[window-all-closed] FIRED — all windows closed, quitting');
        if (process.platform !== 'darwin') { app.quit(); }
    });

    // Block new window attempts
    app.on('web-contents-created', (_e, contents) => {
        contents.setWindowOpenHandler(({ url }) => {
            openUrl(url);
            return { action: 'deny' };
        });
        contents.on('will-navigate', (e, url) => {
            try {
                const target = new URL(url);
                const allowed = new URL(bootConfig.url);
                if (target.origin !== allowed.origin && !url.startsWith('file://')) {
                    e.preventDefault();
                    openUrl(url);
                }
            } catch { e.preventDefault(); }
        });
    });
}
