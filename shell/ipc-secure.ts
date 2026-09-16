// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-secure.ts — 安全存储 IPC（Electron safeStorage / Windows DPAPI）
//   渲染层: bridge.secure.available() / encrypt(text) / decrypt(b64)
//   用途: BYOK 密钥等设备本地敏感值的静态加密（密文落 sq3，明文零落盘）
//   ★ 加密不可用（罕见）→ 返回 {ok:false}，消费方自动回退明文（零破坏）
// ============================================================================

import { ipcMain, safeStorage } from 'electron';

function _reason(e: unknown): string {
    return String((e as { message?: string })?.message || e || 'unknown');
}

export function registerSecureIpc(): void {
    ipcMain.handle('qqqide:secure:available', () => {
        try { return { ok: true, available: safeStorage.isEncryptionAvailable() }; }
        catch (e) { return { ok: false, reason: _reason(e) }; }
    });

    ipcMain.handle('qqqide:secure:encrypt', (_e, text: unknown) => {
        try {
            if (!safeStorage.isEncryptionAvailable()) { return { ok: false, reason: 'unavailable' }; }
            const buf = safeStorage.encryptString(String(text ?? ''));
            return { ok: true, b64: buf.toString('base64') };
        } catch (e) { return { ok: false, reason: _reason(e) }; }
    });

    ipcMain.handle('qqqide:secure:decrypt', (_e, b64: unknown) => {
        try {
            if (!safeStorage.isEncryptionAvailable()) { return { ok: false, reason: 'unavailable' }; }
            const buf = Buffer.from(String(b64 || ''), 'base64');
            return { ok: true, text: safeStorage.decryptString(buf) };
        } catch (e) { return { ok: false, reason: _reason(e) }; }
    });
}
