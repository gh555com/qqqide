// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-vig.ts — 履历（Vig）埋点 IPC（渲染层 → 壳层采集机）
//
//   qqqide:vig:bump  (mod, add)  — 增量累加（k/q/w/x/fc/hit/miss/times 等）
//   qqqide:vig:set   (mod, val)  — 覆盖合并（savor 统计镜像 / card.count）
//
// 埋点方（渲染层）: savor.js / paste-router.js / export-machine.js /
//   goods/file-explorer（q2-roam*.js）/ goods/kope-a（panel.html）
// 消费方: wq-ping.ts（每次 ping 取 vigSnapshot() 搭便车上报）
// ============================================================================

import { ipcMain } from 'electron';
import { vigBump, vigSet, vigSnapshot, vigFlush, vigFloor } from './vig';

export function registerVigIpc(): void {
    ipcMain.handle('qqqide:vig:bump', (_e, mod: string, add: Record<string, number>) => {
        try {
            vigBump(String(mod || ''), (add && typeof add === 'object') ? add : {});
            return { ok: true };
        } catch { return { ok: false }; }
    });

    ipcMain.handle('qqqide:vig:set', (_e, mod: string, patch: Record<string, number>) => {
        try {
            vigSet(String(mod || ''), (patch && typeof patch === 'object') ? patch : {});
            return { ok: true };
        } catch { return { ok: false }; }
    });

    // 楼层履历（2026-09-22）：发送成功分配楼层 → 总楼层 + 等级直方 + 白嫖（免费时段）
    ipcMain.handle('qqqide:vig:floor', (_e, payload: any) => {
        try {
            vigFloor(
                String((payload && payload.root) || ''),
                Number((payload && payload.tier) || 0),
                !!(payload && payload.free),
            );
            return { ok: true };
        } catch { return { ok: false }; }
    });

    ipcMain.handle('qqqide:vig:snapshot', () => {
        try { return { ok: true, vig: vigSnapshot() }; } catch { return { ok: false, vig: null }; }
    });

    ipcMain.handle('qqqide:vig:flush', () => {
        try { vigFlush(); return { ok: true }; } catch { return { ok: false }; }
    });
}
