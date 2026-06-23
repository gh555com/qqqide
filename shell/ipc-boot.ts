// ============================================================================
// ipc-boot.ts — 启动信息 IPC handlers
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import { BootConfig, BootMode, healthCheck, loadStaticFallback, loadRemoteWithCacheGuard, isBootCompleted } from './boot';

export function registerBootIpc(
    portableRoot: string,
    portableUserData: string,
    portableCache: string,
    portableLogs: string,
    appVersion: string,
    bootConfig: BootConfig,
    getEngineAlive: () => boolean,
    getLastBootMode: () => BootMode,
    getMainWindow: () => BrowserWindow | null,
): void {
    ipcMain.handle('qqqide:app:root', () => portableRoot);

    ipcMain.handle('qqqide:boot:info', () => ({
        url: bootConfig.url,
        version: appVersion,
        platform: process.platform,
        arch: process.arch,
        appRoot: portableRoot,
        userData: portableUserData,
        cacheDir: portableCache,
        logsDir: portableLogs,
        cwd: process.cwd(),
        homedir: require('os').homedir(),
        engineAlive: getEngineAlive(),
        bootMode: getLastBootMode(),
    }));

    ipcMain.handle('qqqide:boot:retry', async () => {
        // ★ 如果已经成功启动，绝不降级到 fallback
        if (isBootCompleted()) {
            console.log('[boot.retry] boot already completed — ignoring retry from stale fallback');
            return true;
        }
        const mw = getMainWindow();
        if (!mw) { return false; }
        const healthy = await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs, false);
        if (healthy) {
            console.log('[boot.retry] server OK -> reload');
            await mw.loadURL(bootConfig.url);
            return true;
        }
        const { ok } = await loadRemoteWithCacheGuard(mw, bootConfig);
        if (!ok) { await loadStaticFallback(mw, bootConfig, portableRoot, 'retry-failed'); return false; }
        return true;
    });

    ipcMain.handle('qqqide:boot:probe', async () => {
        return healthCheck(bootConfig.url, Math.min(bootConfig.healthTimeoutMs, 2000), false);
    });
}
