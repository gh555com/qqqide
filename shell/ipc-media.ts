// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-media.ts — Media IPC handlers (thumb / transcode / probe / ffmpegPath)
// Registered in main.ts. Bridges preload.ts bridge.media.* → MediaService.
// ============================================================================

import { ipcMain } from 'electron';
import { MediaService } from './media-service';

export function registerMediaIpc(mediaService: MediaService): void {
    ipcMain.handle('qqqide:media:thumb', async (_e, opts: any) => {
        try {
            return await mediaService.thumb(opts);
        } catch (e: any) {
            return { ok: false, error: e.message || 'thumb_exception' };
        }
    });

    ipcMain.handle('qqqide:media:transcode', async (_e, opts: any) => {
        try {
            return await mediaService.transcode(opts);
        } catch (e: any) {
            return { ok: false, error: e.message || 'transcode_exception' };
        }
    });

    ipcMain.handle('qqqide:media:probe', async (_e, src: string) => {
        try {
            return await mediaService.probe(src);
        } catch (e: any) {
            return { ok: false, error: e.message || 'probe_exception' };
        }
    });

    ipcMain.handle('qqqide:media:ffmpegPath', async () => {
        return mediaService.ffmpegPath();
    });
}
