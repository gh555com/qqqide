// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// menu-builder.ts
// Receives a JSON menu schema from the renderer, builds a native Electron Menu.
// Click events fire back through IPC channel 'qqqide:menu:fired' with cmd id.
// ============================================================================

import { Menu, MenuItemConstructorOptions, BrowserWindow } from 'electron';

export interface MenuSchemaItem {
    label?: string;
    role?: string;        // electron role: 'minimize', 'close', 'cut', etc.
    type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
    accel?: string;       // accelerator like 'Ctrl+N'
    cmd?: string;         // command id, sent back via 'qqqide:menu:fired'
    enabled?: boolean;
    checked?: boolean;
    sub?: MenuSchemaItem[];
}

export interface MenuSchema {
    items: MenuSchemaItem[];
}

function toElectronTemplate(items: MenuSchemaItem[], win: BrowserWindow | null): MenuItemConstructorOptions[] {
    return items.map<MenuItemConstructorOptions>(it => {
        if (it.type === 'separator') { return { type: 'separator' }; }
        const out: MenuItemConstructorOptions = {
            label: it.label,
            type: it.type as any,
            enabled: it.enabled !== false,
        };
        if (it.role) { out.role = it.role as any; }
        if (it.accel) { out.accelerator = it.accel; }
        if (it.checked !== undefined) { out.checked = it.checked; }
        if (it.sub && it.sub.length > 0) {
            out.submenu = toElectronTemplate(it.sub, win);
        } else if (it.cmd) {
            const cmd = it.cmd;
            out.click = () => {
                if (win && !win.isDestroyed()) {
                    win.webContents.send('qqqide:menu:fired', cmd);
                }
            };
        }
        return out;
    });
}

export function applyMenuSchema(schema: MenuSchema | null, win: BrowserWindow | null): void {
    if (!schema || !schema.items || schema.items.length === 0) {
        Menu.setApplicationMenu(null);
        return;
    }
    const tpl = toElectronTemplate(schema.items, win);
    const menu = Menu.buildFromTemplate(tpl);
    Menu.setApplicationMenu(menu);
}
