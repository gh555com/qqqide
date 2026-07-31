// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// login-preload.ts — 登录窗口 preload（2026-07-31 T3）
//
// 极简 preload：仅暴露 window.__qqqLoginBridge 给登录页面。
// 登录页面在登录成功后调用 complete() 将 token 传回主进程。
//
// ★ 此 preload 仅用于登录 BrowserWindow（partition: 'persist:qqq-login'）。
//   与主窗口的 preload.ts 完全独立，互不影响。
// ============================================================================

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__qqqLoginBridge', {
    /** 登录完成 → 传 token 到主进程。主进程关闭此窗口 + 广播所有窗口。 */
    complete: (data: { token: string; phone: string; country_iso2?: string; purchased?: boolean }) => {
        ipcRenderer.send('qqqide:auth:login-complete', data);
    },

    /** 取消登录 → 关闭窗口。 */
    cancel: () => {
        ipcRenderer.send('qqqide:auth:login-cancel');
    },
});
