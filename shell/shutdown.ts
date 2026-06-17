// ============================================================================
// shutdown.ts — 安全加固 / 会话锁定 / 退出处理器
// ============================================================================

import { app, BrowserWindow, session, shell as electronShell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { URL } from 'url';
import { BootConfig } from './boot';
import { StateStore } from './state-sqlite';
import { _timelineDbs, _tlFlushNow } from './timeline-store';

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
): void {
    // Sync flush helper
    function _flushStateSync(label: string): void {
        try {
            stateStore.flushSync();
        } catch (err) {
            try { console.warn('[state] ' + label + ' flush failed:', err); } catch (_) { }
        }
    }

    let _flushedOnce = false;

    // before-quit: graceful cleanup
    app.on('before-quit', async (event) => {
        if (_flushedOnce) return;
        _flushedOnce = true;
        event.preventDefault();

        // ① stop engine
        try {
            const { EngineHost } = require('./engines');
            // engineHost is handled in main.ts
        } catch { /* ignore */ }

        // ② flush state
        try { _flushStateSync('before-quit'); } catch { /* ignore */ }

        // ③ async flush
        try {
            await stateStore.flush();
        } catch (err) {
            try { console.warn('[state] async flush before-quit failed:', err); } catch (_) { }
        }
        _flushStateSync('before-quit');

        // ★ 强制刷盘所有 timeline DB
        _timelineDbs.forEach((db, dbPath) => { try { _tlFlushNow(db, dbPath); } catch (_) { } });

        app.exit(0);
        setTimeout(() => { process.exit(0); }, 500);
    });

    // SIGINT/SIGTERM
    process.on('SIGINT', () => { _flushStateSync('SIGINT'); try { app.quit(); } catch { process.exit(0); } });
    process.on('SIGTERM', () => { _flushStateSync('SIGTERM'); try { app.quit(); } catch { process.exit(0); } });

    // Global uncaught exception handler
    let _ueInHandler = false;
    let _ueLastLogTs = 0;
    process.on('uncaughtException', (err) => {
        if (_ueInHandler) return;
        _ueInHandler = true;
        try {
            const _msg = (err && (err as any).message) || '';
            if (_msg.indexOf('EPIPE') >= 0 || _msg.indexOf('broken pipe') >= 0) {
                return;
            }
            if (err && err.message === 'Object has been destroyed') {
                try { console.warn('[main] uncaughtException (Object destroyed) suppressed'); } catch (_) { }
                return;
            }
            try { console.error('[uncaughtException]', err); } catch (_) { }
            _flushStateSync('uncaughtException');
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
        if (process.platform !== 'darwin') { app.quit(); }
    });

    // Block new window attempts
    app.on('web-contents-created', (_e, contents) => {
        contents.setWindowOpenHandler(({ url }) => {
            electronShell.openExternal(url);
            return { action: 'deny' };
        });
        contents.on('will-navigate', (e, url) => {
            try {
                const target = new URL(url);
                const allowed = new URL(bootConfig.url);
                if (target.origin !== allowed.origin && !url.startsWith('file://')) {
                    e.preventDefault();
                    electronShell.openExternal(url);
                }
            } catch { e.preventDefault(); }
        });
    });
}
