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
import { _windowProjectMap, snapshotOpenWindows } from './window-manager';
import { releaseAllProjectLocks } from './project-lock';
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
        void winProjectMap; // 快照实现已收敛到 window-manager (2026-08-16)
        const live = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
        if (live.length === 0) {
            // X 关闭路径: 已在各窗口 close 事件里保存过, 这里保持旧值即可
            return;
        }
        // ★ 打开序快照 (与 close 路径同源实现, 半销毁窗口零污染, 2026-08-16)
        const windows = snapshotOpenWindows();
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
        //   ★ 2026-08-13 幽灵锁事故：map 遍历会漏掉 _windowProjectMap 未注册的残留条目
        //   → 改遍历 _held 全量释放（closed 漏跑场景退出时兜底清干净）
        try { releaseAllProjectLocks(); } catch (_) { }

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
}

// ---- Window-open hardening（2026-08-21 从 registerExitHandlers 提前，任何窗口创建前必须注册）----
// ★ 事故根因：原注册在 registerExitHandlers（主窗口创建之后才调用）→ 主窗口 webContents 没有
//   setWindowOpenHandler → 点击 target=_blank 链接 → Electron 默认创建裸 BrowserWindow → 新窗口
//   will-navigate 拦截 + openUrl（用户看到「外部浏览器 + 空窗口」双开）。
//   调用时机：main.ts 在 createWindow 之前调用 hardenWebContents(bootConfig)。
export function hardenWebContents(bootConfig: BootConfig): void {
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
