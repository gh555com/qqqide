// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-squads.ts — 窗口编队 IPC（编队按钮 get/set + 状态广播）
//   渲染层: bridge.squad.get() / bridge.squad.set(slot) / bridge.squad.onChanged()
//   真理源: squad-manager.ts → %LOCALAPPDATA%/qqqide/squads.json
// ============================================================================

import { BrowserWindow, ipcMain } from 'electron';
import { broadcastSquadState, getSquadState, setSquad, startSquadWatcher } from './squad-manager';
import { _windowProjectMap } from './window-manager';

export function registerSquadIpc(): void {
    // ★ 跨实例中心大脑：fs.watch 监听 squads.json（gaea-process 状态文件同款模式），
    //   dev+绿色包同跑时任何一方写盘 → 所有实例秒同步 + 败者自动重认领（幂等，只启一次）
    startSquadWatcher();
    ipcMain.handle('qqqide:squad:get', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) { return { ok: false, reason: 'no_window' }; }
        const state = getSquadState(win.id);
        // ★ 中列兜底: 条目 title/folder 为空（窗口刚创建/渲染层未刷新 setTitle）→ 读实时窗口标题
        for (const k of state.order) {
            const s = state.slots[k];
            if (!s) { continue; }
            if (!s.title || !s.folder) {
                try {
                    const w = BrowserWindow.fromId(s.winId);
                    if (w && !w.isDestroyed()) {
                        if (!s.title) { s.title = w.getTitle(); }
                        if (!s.folder) { s.folder = _windowProjectMap.get(s.winId) || ''; }
                    }
                } catch { /* ignore */ }
            }
        }
        return { ok: true, state };
    });

    ipcMain.handle('qqqide:squad:set', (e, target: string) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) { return { ok: false, reason: 'no_window' }; }
        const folder = _windowProjectMap.get(win.id) || '';
        const r = setSquad(win, String(target || ''), folder);
        if (r.ok) { broadcastSquadState(); }
        return r;
    });
}
