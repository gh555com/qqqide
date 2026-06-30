// ============================================================================
// ipc-state-handlers.ts — 状态持久化 IPC 全家桶
// 补回重构时从 main.ts 掉落的 state / state.project / state.cloud / qgf 处理器
// ============================================================================

import { ipcMain } from 'electron';
import { StateStore, NsSchema } from './state-sqlite';
import { StateCloud } from './state-cloud';
import { Qgf, atomicWrite, atomicRead } from './qgf';

/**
 * 注册所有状态相关的 IPC handler。
 * 必须在 stateStore / stateCloud / qgfInstances / projectStateStores / mainWindow 可用后调用。
 */
export function registerStateHandlersIpc(
    stateStore: StateStore,
    stateCloud: StateCloud,
    projectStateStores: Map<string, StateStore>,
    qgfInstances: Map<string, Qgf>,
    getMainWindow: () => any,
): void {

    // ═══════════════════════════════════════════════════════════════
    // 全局 state (state.sq3)
    // ═══════════════════════════════════════════════════════════════

    ipcMain.handle('qqqide:state:register', async (_e, ns: string, schema: NsSchema) => {
        const safeSchema: NsSchema = {
            v: schema.v, form: schema.form,
            quotaBytes: schema.quotaBytes, cloud: !!schema.cloud,
            debounceMs: schema.debounceMs, compactThresholdBytes: schema.compactThresholdBytes,
        };
        stateStore.register(ns, safeSchema);
        return true;
    });
    ipcMain.handle('qqqide:state:get', async (_e, ns: string, key: string) => stateStore.get(ns, key));
    ipcMain.handle('qqqide:state:set', async (_e, ns: string, key: string, v: any) => { await stateStore.set(ns, key, v); return true; });
    ipcMain.handle('qqqide:state:setNow', async (_e, ns: string, key: string, v: any) => { await stateStore.setNow(ns, key, v); return true; });
    ipcMain.handle('qqqide:state:append', async (_e, ns: string, key: string, ev: any) => { await stateStore.append(ns, key, ev); return true; });
    ipcMain.handle('qqqide:state:del', async (_e, ns: string, key: string) => stateStore.del(ns, key));
    ipcMain.handle('qqqide:state:list', async (_e, ns: string) => stateStore.list(ns));
    ipcMain.handle('qqqide:state:flush', async () => { await stateStore.flush(); return true; });
    ipcMain.handle('qqqide:state:flushOne', async (_e, ns: string, key: string) => { await stateStore.flushOne(ns, key); return true; });
    ipcMain.handle('qqqide:state:stats', () => stateStore.stats());
    ipcMain.handle('qqqide:state:sql', async (_e, query: string, params?: any[]) => stateStore.sql(query, params));

    // ═══════════════════════════════════════════════════════════════
    // cloud sync
    // ═══════════════════════════════════════════════════════════════

    ipcMain.handle('qqqide:state:cloud:pull', async () => stateCloud.pull());
    ipcMain.handle('qqqide:state:cloud:push', async () => stateCloud.push());
    ipcMain.handle('qqqide:state:cloud:sync', async () => stateCloud.sync());
    ipcMain.handle('qqqide:state:cloud:setAuth', async (_e, auth: { phone: string; token: string; device_name?: string } | null) => {
        StateCloud.setAuth(auth);
        return true;
    });

    // ═══════════════════════════════════════════════════════════════
    // project-level state (quest.sq3 per dbPath)
    // ═══════════════════════════════════════════════════════════════

    function _getProjectStateStore(dbPath: string): StateStore {
        let inst = projectStateStores.get(dbPath);
        if (!inst) {
            inst = new StateStore('', dbPath); // userDataDir unused when dbPath provided
            const mainWindow = getMainWindow();
            inst.on('changed', (msg: any) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try { mainWindow.webContents.send('qqqide:state:project:changed', { ...msg, dbPath }); } catch { /* ignore */ }
                }
            });
            projectStateStores.set(dbPath, inst);
        }
        return inst;
    }

    ipcMain.handle('qqqide:state:project:register', async (_e, dbPath: string, ns: string, schema: any) => {
        const safeSchema: NsSchema = {
            v: schema.v, form: schema.form,
            quotaBytes: schema.quotaBytes, cloud: false,
            debounceMs: schema.debounceMs, compactThresholdBytes: schema.compactThresholdBytes,
        };
        _getProjectStateStore(dbPath).register(ns, safeSchema);
        return true;
    });
    ipcMain.handle('qqqide:state:project:get', async (_e, dbPath: string, ns: string, key: string) => _getProjectStateStore(dbPath).get(ns, key));
    ipcMain.handle('qqqide:state:project:set', async (_e, dbPath: string, ns: string, key: string, v: any) => { await _getProjectStateStore(dbPath).set(ns, key, v); return true; });
    ipcMain.handle('qqqide:state:project:setNow', async (_e, dbPath: string, ns: string, key: string, v: any) => { await _getProjectStateStore(dbPath).setNow(ns, key, v); return true; });
    ipcMain.handle('qqqide:state:project:append', async (_e, dbPath: string, ns: string, key: string, ev: any) => { await _getProjectStateStore(dbPath).append(ns, key, ev); return true; });
    ipcMain.handle('qqqide:state:project:del', async (_e, dbPath: string, ns: string, key: string) => _getProjectStateStore(dbPath).del(ns, key));
    ipcMain.handle('qqqide:state:project:list', async (_e, dbPath: string, ns: string) => _getProjectStateStore(dbPath).list(ns));
    ipcMain.handle('qqqide:state:project:flush', async (_e, dbPath: string) => { await _getProjectStateStore(dbPath).flush(); return true; });
    ipcMain.handle('qqqide:state:project:flushOne', async (_e, dbPath: string, ns: string, key: string) => { await _getProjectStateStore(dbPath).flushOne(ns, key); return true; });
    ipcMain.handle('qqqide:state:project:stats', async (_e, dbPath: string) => _getProjectStateStore(dbPath).stats());
    ipcMain.handle('qqqide:state:project:atomicIncr', async (_e, dbPath: string, ns: string, key: string) => _getProjectStateStore(dbPath).atomicIncr(ns, key));

    // ═══════════════════════════════════════════════════════════════
    // qgf (FS project-level KV + 任意路径原子读写)
    // ═══════════════════════════════════════════════════════════════

    function _getQgf(rootDir: string): Qgf {
        let inst = qgfInstances.get(rootDir);
        if (!inst) {
            inst = new Qgf(rootDir);
            const mainWindow = getMainWindow();
            inst.on('changed', (msg: any) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try { mainWindow.webContents.send('qqqide:qgf:changed', { ...msg, rootDir }); } catch { /* ignore */ }
                }
            });
            qgfInstances.set(rootDir, inst);
        }
        return inst;
    }

    ipcMain.handle('qqqide:qgf:register', async (_e, rootDir: string, ns: string, schema: any) => {
        const safeSchema = { v: schema.v, form: schema.form, cloud: false };
        _getQgf(rootDir).register(ns, safeSchema);
        return true;
    });
    ipcMain.handle('qqqide:qgf:get', async (_e, rootDir: string, ns: string, key: string) => _getQgf(rootDir).get(ns, key));
    ipcMain.handle('qqqide:qgf:set', async (_e, rootDir: string, ns: string, key: string, v: any) => { const qf = _getQgf(rootDir); await qf.set(ns, key, v); return true; });
    ipcMain.handle('qqqide:qgf:setNow', async (_e, rootDir: string, ns: string, key: string, v: any) => { const qf = _getQgf(rootDir); await qf.setNow(ns, key, v); return true; });
    ipcMain.handle('qqqide:qgf:append', async (_e, rootDir: string, ns: string, key: string, ev: any) => { const qf = _getQgf(rootDir); await qf.append(ns, key, ev); return true; });
    ipcMain.handle('qqqide:qgf:del', async (_e, rootDir: string, ns: string, key: string) => _getQgf(rootDir).del(ns, key));
    ipcMain.handle('qqqide:qgf:list', async (_e, rootDir: string, ns: string) => _getQgf(rootDir).list(ns));
    ipcMain.handle('qqqide:qgf:flush', async (_e, rootDir: string) => { const qf = _getQgf(rootDir); await qf.flush(); return true; });
    ipcMain.handle('qqqide:qgf:stats', async (_e, rootDir: string) => _getQgf(rootDir).stats());
    ipcMain.handle('qqqide:qgf:flushOne', async (_e, rootDir: string, ns: string, key: string) => { await _getQgf(rootDir).flushOne(ns, key); return true; });

    // ★ 任意路径原子读写（突破固定目录限制）
    ipcMain.handle('qqqide:qgf:atomicWrite', async (_e, absPath: string, data: string) => {
        await atomicWrite(absPath, data);
        return true;
    });
    ipcMain.handle('qqqide:qgf:atomicRead', async (_e, absPath: string) => {
        return await atomicRead(absPath);
    });
}
