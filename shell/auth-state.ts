// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// auth-state.ts — 主进程共享认证状态（避免 wq-ping 重复解密 auth.enc）
//
// 职责：
//   在 safeStorage 解密的 auth 数据与 wq-ping 之间提供共享内存通道。
//   main.ts 在 IPC save/load handler 中更新 phone，
//   wq-ping.ts 在 readDoerID() 中优先读取此缓存。
//
// 避免问题：
//   同一设备上 safeStorage(DPAPI) 可能因安装目录迁移、文件权限、
//   或 Electron 版本差异而静默失败。共享内存消除此路径。
// ============================================================================

let _authPhone = '';      // ↑ phone_e164，如 "8615802858204"
let _authToken = '';      // ↑ JWT token（保留以备将来使用）

export function setAuthPhone(phone: string): void {
    _authPhone = phone;
}

export function getAuthPhone(): string {
    return _authPhone;
}

export function setAuthToken(token: string): void {
    _authToken = token;
}

export function getAuthToken(): string {
    return _authToken;
}
