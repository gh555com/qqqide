// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-export.ts — 导出机 IPC（preload bridge.export.* → ExportService）
//   qqqide:export:doc     导出文档（RTF/.doc 或 DOCX）
//   qqqide:export:zip     导出 ZIP
//   qqqide:export:cancel  取消（杀活跃 ffmpeg + 中断 + 删半成品）
//   进度为广播 qqqide:export:progress（渲染层按 jobId 过滤）
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import { ExportService } from './export-service';

export function registerExportIpc(svc: ExportService): void {
    ipcMain.handle('qqqide:export:doc', async (e, payload: any) => {
        try {
            const win = BrowserWindow.fromWebContents(e.sender);
            return await svc.doc(payload || {}, win);
        } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });

    ipcMain.handle('qqqide:export:zip', async (e, payload: any) => {
        try {
            const win = BrowserWindow.fromWebContents(e.sender);
            return await svc.zip(payload || {}, win);
        } catch (err: any) {
            return { ok: false, error: String((err && err.message) || err) };
        }
    });

    ipcMain.handle('qqqide:export:cancel', async (_e, jobId: string) => {
        try {
            return svc.cancel(String(jobId || ''));
        } catch {
            return { ok: false };
        }
    });
}
