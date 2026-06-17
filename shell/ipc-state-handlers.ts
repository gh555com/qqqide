// ============================================================================
// ipc-state-handlers.ts — 状态持久化 IPC 全家桶
// 补回重构时从 main.ts 掉落的 state / state.project / state.cloud / qg 处理器
// ============================================================================

import { ipcMain } from 'electron';
import { StateStore, NsSchema } from './state-sqlite';
import { StateCloud } from './state-cloud';
import { Qg } from './qg';

/**
 * 注册所有状态相关的 IPC handler。
 * 必须在 stateStore / stateCloud / _qgInstances / _projectStateStores / mainWindow 可用后调用。
 */
export function registerStateHandlersIpc(
    stateStore: StateStore,
    stateCloud: StateCloud,
    projectStateStores: Map<string, StateStore>,
    qgInstances: Map<string, Qg>,
    getMainWindow: () => any,
): void {

    // ═══════════════════════════════════════════════════════════════
    // 全局 state (state.db)
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
    // qg (FS project-level state, per-project .qqq/qg/ instances)
    // ═══════════════════════════════════════════════════════════════

    function _getQg(rootDir: string): Qg {
        let inst = qgInstances.get(rootDir);
        if (!inst) {
            inst = new Qg(rootDir);
            const mainWindow = getMainWindow();
            inst.on('changed', (msg: any) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try { mainWindow.webContents.send('qqqide:qg:changed', { ...msg, rootDir }); } catch { /* ignore */ }
                }
            });
            qgInstances.set(rootDir, inst);
        }
        return inst;
    }

    ipcMain.handle('qqqide:qg:register', async (_e, rootDir: string, ns: string, schema: any) => {
        const safeSchema = { v: schema.v, form: schema.form, cloud: false };
        _getQg(rootDir).register(ns, safeSchema);
        return true;
    });
    ipcMain.handle('qqqide:qg:get', async (_e, rootDir: string, ns: string, key: string) => _getQg(rootDir).get(ns, key));
    ipcMain.handle('qqqide:qg:set', async (_e, rootDir: string, ns: string, key: string, v: any) => { const qg = _getQg(rootDir); await qg.set(ns, key, v); return true; });
    ipcMain.handle('qqqide:qg:setNow', async (_e, rootDir: string, ns: string, key: string, v: any) => { const qg = _getQg(rootDir); await qg.setNow(ns, key, v); return true; });
    ipcMain.handle('qqqide:qg:append', async (_e, rootDir: string, ns: string, key: string, ev: any) => { const qg = _getQg(rootDir); await qg.append(ns, key, ev); return true; });
    ipcMain.handle('qqqide:qg:del', async (_e, rootDir: string, ns: string, key: string) => _getQg(rootDir).del(ns, key));
    ipcMain.handle('qqqide:qg:list', async (_e, rootDir: string, ns: string) => _getQg(rootDir).list(ns));
    ipcMain.handle('qqqide:qg:flush', async (_e, rootDir: string) => { const qg = _getQg(rootDir); await qg.flush(); return true; });
    ipcMain.handle('qqqide:qg:stats', async (_e, rootDir: string) => _getQg(rootDir).stats());
    ipcMain.handle('qqqide:qg:flushOne', async (_e, rootDir: string, ns: string, key: string) => { await _getQg(rootDir).flushOne(ns, key); return true; });
}
