// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-secure.ts — 安全存储 IPC（Electron safeStorage / Windows DPAPI）
//   渲染层: bridge.secure.available() / encrypt(text) / decrypt(b64)
//   用途: BYOK 密钥等设备本地敏感值的静态加密（密文落 sq3，明文零落盘）
//   ★ 加密不可用（罕见）→ 返回 {ok:false}，消费方自动回退明文（零破坏）
//   ★ 2026-09-18 mac 应用内更新配套：mac 上 safeStorage 读写可能触发系统钥匙串授权
//     弹窗（重签名后 ACL 变更）。同步调用会冻结主进程事件循环 → 窗口永不出现
//     （表现为「更新后首启应用打不开」）。故 mac 上把加/解密推迟到主窗口可见之后
//     ——弹窗出现在窗口上方而非冻结 boot；非 mac 平台零行为变化（立即放行）。
// ============================================================================

import { ipcMain, safeStorage, BrowserWindow } from 'electron';

function _reason(e: unknown): string {
    return String((e as { message?: string })?.message || e || 'unknown');
}

let _winShownPromise: Promise<void> | null = null;

/** mac: 等待任一主窗口可见（最多 30s 兜底放行；非 mac 立即放行）。 */
function _waitMainWindowShown(): Promise<void> {
    if (process.platform !== 'darwin') { return Promise.resolve(); }
    if (_winShownPromise) { return _winShownPromise; }
    _winShownPromise = new Promise<void>((resolve) => {
        const t0 = Date.now();
        const check = (): boolean => {
            try {
                for (const w of BrowserWindow.getAllWindows()) {
                    if (!w.isDestroyed() && w.isVisible()) { return true; }
                }
            } catch (_) { }
            return Date.now() - t0 > 30000;
        };
        if (check()) { resolve(); return; }
        const iv = setInterval(() => { if (check()) { clearInterval(iv); resolve(); } }, 500);
    });
    return _winShownPromise;
}

export function registerSecureIpc(): void {
    ipcMain.handle('qqqide:secure:available', () => {
        try { return { ok: true, available: safeStorage.isEncryptionAvailable() }; }
        catch (e) { return { ok: false, reason: _reason(e) }; }
    });

    ipcMain.handle('qqqide:secure:encrypt', async (_e, text: unknown) => {
        try {
            await _waitMainWindowShown();
            if (!safeStorage.isEncryptionAvailable()) { return { ok: false, reason: 'unavailable' }; }
            const buf = safeStorage.encryptString(String(text ?? ''));
            return { ok: true, b64: buf.toString('base64') };
        } catch (e) { return { ok: false, reason: _reason(e) }; }
    });

    ipcMain.handle('qqqide:secure:decrypt', async (_e, b64: unknown) => {
        try {
            await _waitMainWindowShown();
            if (!safeStorage.isEncryptionAvailable()) { return { ok: false, reason: 'unavailable' }; }
            const buf = Buffer.from(String(b64 || ''), 'base64');
            return { ok: true, text: safeStorage.decryptString(buf) };
        } catch (e) { return { ok: false, reason: _reason(e) }; }
    });
}
