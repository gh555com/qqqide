// ============================================================================
// portable-paths.ts
// MUST be imported BEFORE any other electron module that touches paths.
// Redirects ALL chromium/electron writable paths to the app directory,
// so we never write a single byte to C:\Users\... / AppData / Registry.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';

/** Returns the directory containing the running executable. */
export function getAppRoot(): string {
    // Detect dev mode without relying on electron.app (which may not be ready
    // at bundle top-level execution time in some environments).
    // Dev: process.execPath = .../node_modules/electron/dist/electron.exe
    // Packaged: process.execPath = .../qqq-shell.exe (no node_modules in path)
    const execLower = process.execPath.replace(/\\/g, '/').toLowerCase();
    if (execLower.includes('node_modules') || execLower.includes('electron/dist')) {
        return path.resolve(__dirname, '..');
    }
    return path.dirname(process.execPath);
}

/** Apply portable redirects. Call this BEFORE app.whenReady(). */
export function applyPortablePaths(): { root: string; userData: string; cache: string; logs: string } {
    const root = getAppRoot();
    const userData = path.join(root, 'Data');
    // ★ 所有运行时目录收进 userData/，根目录保持干净
    const cache = path.join(userData, 'Cache');
    const temp = path.join(userData, 'Temp');
    const logs = path.join(userData, 'Logs');
    const crashDumps = path.join(userData, 'CrashDumps');

    // ensure directories exist
    for (const d of [userData, cache, temp, logs, crashDumps]) {
        try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
    }

    // Lazily access electron.app — at this point electron main process is running
    // so require('electron') WILL return the API object.
    let app: any;
    try {
        app = require('electron').app;
    } catch {
        console.warn('[portable-paths] electron.app not available, skipping path redirects');
        return { root, userData, cache, logs };
    }
    if (!app) {
        console.warn('[portable-paths] electron.app is undefined, skipping path redirects');
        return { root, userData, cache, logs };
    }

    app.setPath('userData', userData);
    app.setPath('sessionData', userData);
    app.setPath('cache', cache);
    app.setPath('temp', temp);
    app.setPath('logs', logs);
    app.setPath('crashDumps', crashDumps);
    try { app.setAppLogsPath(logs); } catch { /* older electron */ }

    // chromium-level redirects (some still leak to default unless cli switches set)
    app.commandLine.appendSwitch('user-data-dir', userData);
    app.commandLine.appendSwitch('disk-cache-dir', cache);

    // explicitly disable features that may write registry / appdata
    app.commandLine.appendSwitch('no-default-browser-check');
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('disable-component-update');
    app.commandLine.appendSwitch('disable-domain-reliability');
    app.commandLine.appendSwitch('disable-sync');
    app.commandLine.appendSwitch('metrics-recording-only');
    app.commandLine.appendSwitch('disable-default-apps');

    return { root, userData, cache, logs };
}
