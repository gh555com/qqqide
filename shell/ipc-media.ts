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

    // ★ 播放器「媒体信息」详情（[!] 钮悬停详情框；2026-10-03 q319）——ffprobe 全量 + stat → 展示区块
    ipcMain.handle('qqqide:media:info', async (_e, src: string) => {
        try {
            return await mediaService.info(src);
        } catch (e: any) {
            return { ok: false, error: e.message || 'info_exception' };
        }
    });

    ipcMain.handle('qqqide:media:ffmpegPath', async () => {
        return mediaService.ffmpegPath();
    });

    // ★ WYSIWYG 相框预览（老 q3 buildUnifiedWebPArgs 移植：extreme/accelerated/optmum）
    ipcMain.handle('qqqide:media:preview', async (_e, opts: any) => {
        try {
            return await mediaService.preview(opts);
        } catch (e: any) {
            return { ok: false, error: e.message || 'preview_exception' };
        }
    });

    // ★ 文本胶片（老 q3 generateTextPreview 移植：drawtext 514x290）
    ipcMain.handle('qqqide:media:textPreview', async (_e, opts: any) => {
        try {
            return await mediaService.textPreview(opts);
        } catch (e: any) {
            return { ok: false, error: e.message || 'textpreview_exception' };
        }
    });

    // ★ 状态栏 wq 卡片：缓存占用读数（媒体缓存 40MB / 转码缓存 2GB / 命中 / 熔断）
    //   只读统计，卡片打开时调用；零生成零淘汰副作用
    ipcMain.handle('qqqide:media:cacheStats', async () => {
        try {
            return await mediaService.cacheStats();
        } catch (e: any) {
            return { ok: false, error: e.message || 'cachestats_exception' };
        }
    });

    // ★ 悬浮层播放/预览转码兜底（2026-09-21）：原生解不了的格式（avi/psd/prores-mov…）
    //   → ffmpeg 转码可播产物；进度经 qqqide:media:playable:progress 回发（同一 webContents）
    ipcMain.handle('qqqide:media:playable', async (e, opts: any) => {
        try {
            return await mediaService.playable(opts, (pct: number) => {
                try {
                    if (!e.sender.isDestroyed()) {
                        e.sender.send('qqqide:media:playable:progress', { reqId: opts && opts.reqId, pct: pct });
                    }
                } catch { /* ignore */ }
            });
        } catch (e: any) {
            return { ok: false, error: e.message || 'playable_exception' };
        }
    });

    ipcMain.handle('qqqide:media:playableCancel', async (_e, reqId: string) => {
        try { return { ok: mediaService.cancelPlayable(reqId) }; } catch { return { ok: false }; }
    });

    // ★ 渐进转码（MSE 边转边播；2026-10-02「闪电」核心）：启动结果即回（moov 解析后 = codec/duration）；
    //   分片经事件同窗口流式下送（e.sender 定向——禁全窗口广播：大分片对无关窗口是纯负担）。
    ipcMain.handle('qqqide:media:playableStream', async (e, opts: any) => {
        try {
            const send = (evt: any): void => {
                try { if (!e.sender.isDestroyed()) { e.sender.send('qqqide:media:playableStreamEvent', evt); } } catch { /* ignore */ }
            };
            return await mediaService.playableStream(opts, send, (pct: number) => {
                try {
                    if (!e.sender.isDestroyed()) {
                        e.sender.send('qqqide:media:playable:progress', { reqId: opts && opts.reqId, pct });
                    }
                } catch { /* ignore */ }
            });
        } catch (err: any) {
            return { ok: false, error: (err && err.message) || 'playableStream_exception' };
        }
    });

    // ack 背压（高频轻量 → send 频道；主进程据在途字节量暂停/恢复 ffmpeg stdout）
    ipcMain.on('qqqide:media:playableStreamAck', (_e, reqId: string, bytes: number) => {
        try { mediaService.streamAck(String(reqId || ''), Number(bytes) || 0); } catch { /* ignore */ }
    });
}
