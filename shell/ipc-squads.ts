// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-squads.ts — 窗口编队 IPC（编队按钮 get/set + 状态广播）
//   渲染层: bridge.squad.get() / bridge.squad.set(slot) / bridge.squad.onChanged()
//   真理源: squad-manager.ts → %LOCALAPPDATA%/qqqide/squads.json
// ============================================================================

import { BrowserWindow, ipcMain } from 'electron';
import { broadcastSquadState, getSquadState, setSquad } from './squad-manager';
import { _windowProjectMap } from './window-manager';

export function registerSquadIpc(): void {
    ipcMain.handle('qqqide:squad:get', (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) { return { ok: false, reason: 'no_window' }; }
        return { ok: true, state: getSquadState(win.id) };
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
