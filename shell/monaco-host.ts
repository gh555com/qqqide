// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// monaco-host.ts
// Stub for the in-shell monaco editor instance pool (Day 3 deliverable).
// On Day 1 we expose just the contract; renderer can call but gets a stub.
// ============================================================================

import { ipcMain } from 'electron';

interface MonacoHandle {
    id: number;
    file: string | null;
}

export class MonacoHost {
    private nextId = 1;
    private instances = new Map<number, MonacoHandle>();

    register(): void {
        ipcMain.handle('qqqide:monaco:create', (_e, _opts) => {
            const h: MonacoHandle = { id: this.nextId++, file: null };
            this.instances.set(h.id, h);
            return h.id;
        });
        ipcMain.handle('qqqide:monaco:open', (_e, id: number, file: string) => {
            const h = this.instances.get(id);
            if (!h) { return false; }
            h.file = file;
            // Day 3: actually open file in monaco
            return true;
        });
        ipcMain.handle('qqqide:monaco:save', (_e, id: number) => {
            const h = this.instances.get(id);
            return !!h;
        });
        ipcMain.handle('qqqide:monaco:dispose', (_e, id: number) => {
            return this.instances.delete(id);
        });
    }
}
