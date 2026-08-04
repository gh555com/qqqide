// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// auth-brain.ts — 主进程认证中心大脑（2026-07-31 F34 简化版）
//
// 单例，主进程持有唯一真理。所有窗口通过 IPC 订阅变更。
// safeStorage 读写 + 余额/LV 周期性拉取 + 登录管理。
//
// ★ F34 简化: 砍掉 BrowserWindow 内嵌登录（~150行死代码），
//   砍掉 registerAuthProtocol（仅 BrowserWindow 有用）。
//   登录唯一通道：外部浏览器（走 browser-launcher 健壮 fallback 链）
//   + OS 协议回调 + 主进程轮询兜底。
// ============================================================================

import { net, safeStorage, BrowserWindow, ipcMain, shell } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { openUrl } from './browser-launcher';
import { setAuthPhone, setAuthToken } from './auth-state';
import { notifyAuthReady } from './wq-ping';

// ═══ 类型 ═══

export interface AuthSnapshot {
    loggedIn: boolean;
    phone: string;
    phoneTail: string;
    countryIso2: string;
    purchased: boolean;
    balanceGe: number | null;
    lvData: LvData | null;
}

export interface LvData {
    level: number;
    level_floor: number;
    progress_pct: number;
    season_short: string;
    total_consumed_ge: string;
    total_free_ge: string;
    total_consumed_all_ge: string;
    last_season_level: number;
    country_iso2?: string;
}

export type AuthListener = (snap: AuthSnapshot) => void;

// ═══ 单例 ═══

let _instance: AuthBrain | null = null;

export function getAuthBrain(): AuthBrain {
    if (!_instance) throw new Error('AuthBrain not initialized — call initAuthBrain first');
    return _instance;
}

export function initAuthBrain(userDataPath: string, portableRoot: string, appVersion: string, isDev: boolean): AuthBrain {
    if (_instance) return _instance;
    _instance = new AuthBrain(userDataPath, portableRoot, appVersion, isDev);
    return _instance;
}

// ═══ 常量 ═══

const AUTH_FILE = 'auth.enc';
// ★ F40: 统一走 gh555.com 主域（与登录页同域）——客户能打开登录页就能拉余额/LV。
//   direct-cn 灰云域名在部分客户网络（运营商污染/DNS 问题）不通，导致余额/LV 永远拉不到。
const API_BASE = 'https://gh555.com/api';
const LOGIN_URL = 'https://gh555.com/login';
const BALANCE_INTERVAL = 60_000;
const LV_INTERVAL = 60_000;
const SESSION_POLL_MS = 3_000;

// ═══ 实现 ═══

class AuthBrain {
    private authData: { token: string; phone: string; country_iso2: string; purchased: boolean; device_name: string; ts: number } | null = null;
    private balanceGe: number | null = null;
    private lvData: LvData | null = null;
    private listeners: Set<AuthListener> = new Set();
    private balanceTimer: ReturnType<typeof setInterval> | null = null;
    private lvTimer: ReturnType<typeof setInterval> | null = null;
    private authFile: string;
    private _sessionId: string | null = null;
    private _sessionPollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private userDataPath: string,
        private portableRoot: string,
        private appVersion: string,
        private isDev: boolean,
    ) {
        this.authFile = path.join(userDataPath, 'alphal', AUTH_FILE);
    }

    // ═══ 公开只读属性 ═══

    get isLoggedIn() { return !!(this.authData?.token); }
    get phone() { return this.authData?.phone || ''; }
    get token() { return this.authData?.token || ''; }
    get countryIso2() { return this.authData?.country_iso2 || ''; }
    get purchased() { return !!(this.authData?.purchased); }
    get balance() { return this.balanceGe; }
    get lv() { return this.lvData; }

    // ═══ 订阅 ═══

    subscribe(fn: AuthListener): () => void {
        this.listeners.add(fn);
        try { fn(this._snapshot()); } catch { /* ignore */ }
        return () => { this.listeners.delete(fn); };
    }

    // ═══ 认证操作 ═══

    async setAuth(token: string, phone: string, countryIso2?: string, purchased?: boolean): Promise<void> {
        this.authData = {
            token, phone,
            country_iso2: countryIso2 || '',
            purchased: !!purchased,
            device_name: 'qqqide_Win_x64',
            ts: Date.now(),
        };
        await this._persist();
        this._startPolling();
        this._stopSessionPoll();
        this._broadcast('login');
        setAuthPhone(phone);
        setAuthToken(token);
        notifyAuthReady();
    }

    async clearAuth(): Promise<void> {
        this.authData = null;
        this.balanceGe = null;
        this.lvData = null;
        this._stopPolling();
        this._stopSessionPoll();
        setAuthPhone('');
        setAuthToken('');
        try { if (fs.existsSync(this.authFile)) fs.unlinkSync(this.authFile); } catch { /* ignore */ }
        this._broadcast('logout');
    }

    async restore(): Promise<boolean> {
        if (!safeStorage.isEncryptionAvailable()) return false;
        try {
            if (!fs.existsSync(this.authFile)) return false;
            const encrypted = fs.readFileSync(this.authFile);
            const raw = safeStorage.decryptString(encrypted);
            const data = JSON.parse(raw);
            if (data?.token && data?.phone) {
                this.authData = {
                    token: data.token, phone: data.phone,
                    country_iso2: data.country_iso2 || '',
                    purchased: !!data.purchased,
                    device_name: data.device_name || '',
                    ts: Date.now(),
                };
                this._startPolling();
                this._broadcast('restore');
                return true;
            }
        } catch { /* ignore */ }
        return false;
    }

    // ═══ 余额 / LV ═══

    updateBalance(ge: number): void {
        this.balanceGe = ge;
        this._broadcast('balance');
    }

    async onBillingEvent(costWge: number): Promise<void> {
        if (this.lvData && costWge > 0) {
            const WL = 10 * 10000;
            const wge = (this.lvData.level_floor * WL) + (this.lvData.progress_pct / 100 * WL) + costWge;
            this.lvData.level_floor = Math.floor(wge / WL);
            this.lvData.progress_pct = (wge % WL) / WL * 100;
        }
        this._broadcast('billing');
        await this._fetchLv();
    }

    // ═══ 登录 — 外部浏览器 + OS 协议回调 + 轮询兜底 ═══
    // ★ 走 browser-launcher 健壮 fallback 链（ShellExecuteW → explorer → …），
    //   根治 Win11 Edge Startup Boost 旧 bug。非裸 shell.openExternal。

    async openLoginExternal(): Promise<string> {
        const sessionId = this._genSessionId();
        this._sessionId = sessionId;
        const loginUrl = `${LOGIN_URL}?from=ide&session=${sessionId}&device_name=qqqide_Win_x64&goods=qqqide`;

        console.log('[auth-brain] openLoginExternal: session=' + sessionId.slice(0, 8) + '...');

        // ★ 启动轮询（3s 间隔，OS 协议回调到即停止）
        this._startSessionPoll();

        // ★ 走 browser-launcher 完整 fallback 链
        openUrl(loginUrl);

        return loginUrl;
    }

    private _genSessionId(): string {
        return crypto.randomBytes(16).toString('hex');
    }

    // ═══ 会话轮询（OS 协议回调失败时的兜底） ═══
    // ★ F39 修复: _stopSessionPoll() 会清空 _sessionId → _startSessionPoll 直接 return →
    //   轮询从未启动（F25 引入，n ginx 日志 auth/poll 请求数为 0）。
    //   此处只清旧 timer，保留 _sessionId。

    private _startSessionPoll(): void {
        if (this._sessionPollTimer) {
            clearInterval(this._sessionPollTimer);
            this._sessionPollTimer = null;
        }
        if (!this._sessionId) return;
        const sid = this._sessionId;
        this._sessionPollTimer = setInterval(async () => {
            if (!this._sessionId || this._sessionId !== sid || this.isLoggedIn) {
                this._stopSessionPoll();
                return;
            }
            try {
                // ★ F39: 与登录页同域（https://gh555.com/api）——客户能打开登录页就能 poll，
                //   不再依赖 direct-cn 灰云域名（客户网络环境可能直连不通）。
                const resp = await net.fetch(`https://gh555.com/api/gaea/qqq/auth/poll?session=${sid}`);
                if (!resp.ok) {
                    console.warn('[auth-brain] poll HTTP ' + resp.status + ' for session=' + sid.slice(0, 8));
                    return;
                }
                const data = await resp.json();
                if (data?.ok && data.token) {
                    console.log('[auth-brain] poll got token, phone=' + (data.phone || '').slice(-4));
                    await this.setAuth(data.token, data.phone, data.country_iso2, data.purchased);
                    this._stopSessionPoll();
                }
            } catch (e: any) {
                console.warn('[auth-brain] poll fetch error for session=' + sid.slice(0, 8) + ': ' + (e?.message || e));
            }
        }, SESSION_POLL_MS);
    }

    private _stopSessionPoll(): void {
        if (this._sessionPollTimer) {
            clearInterval(this._sessionPollTimer);
            this._sessionPollTimer = null;
        }
        this._sessionId = null;
    }

    // ═══ 内部 ═══

    _snapshot(): AuthSnapshot & { token?: string } {
        return {
            loggedIn: this.isLoggedIn,
            phone: this.phone,
            phoneTail: this.phone ? this.phone.slice(-4) : '',
            countryIso2: this.countryIso2,
            purchased: this.purchased,
            balanceGe: this.balanceGe,
            lvData: this.lvData,
            token: this.token || undefined,
        };
    }

    private async _persist(): Promise<void> {
        if (!this.authData || !safeStorage.isEncryptionAvailable()) return;
        try {
            const dir = path.dirname(this.authFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const payload = {
                token: this.authData.token,
                phone: this.authData.phone,
                country_iso2: this.authData.countryIso2,
                purchased: this.authData.purchased,
                device_name: this.authData.device_name,
            };
            const encrypted = safeStorage.encryptString(JSON.stringify(payload));
            fs.writeFileSync(this.authFile, new Uint8Array(encrypted));
        } catch { /* ignore */ }
    }

    private _broadcast(reason: string): void {
        const snap = this._snapshot();
        for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
            try { win.webContents.send('qqqide:auth:changed', snap); } catch { /* ignore */ }
        }
        for (const fn of this.listeners) {
            try { fn(snap); } catch { /* ignore */ }
        }
    }

    private _startPolling(): void {
        this._stopPolling();
        this._fetchBalance();
        this._fetchLv();
        this.balanceTimer = setInterval(() => this._fetchBalance(), BALANCE_INTERVAL);
        this.lvTimer = setInterval(() => this._fetchLv(), LV_INTERVAL);
    }

    private _stopPolling(): void {
        if (this.balanceTimer) { clearInterval(this.balanceTimer); this.balanceTimer = null; }
        if (this.lvTimer) { clearInterval(this.lvTimer); this.lvTimer = null; }
    }

    private async _fetchBalance(): Promise<void> {
        if (!this.authData?.token) return;
        try {
            const resp = await net.fetch(API_BASE + '/wallet/balance', {
                headers: { 'Authorization': 'Bearer ' + this.authData.token }
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data?.ok && typeof data.balance !== 'undefined') {
                    this.balanceGe = data.balance;
                    this._broadcast('balance-fetch');
                }
            } else if (resp.status === 401 || resp.status === 403) {
                this._stopPolling();
            }
        } catch { /* ignore */ }
    }

    private async _fetchLv(): Promise<void> {
        if (!this.authData?.token) return;
        try {
            const resp = await net.fetch(API_BASE + '/qqq/lv', {
                headers: { 'Authorization': 'Bearer ' + this.authData.token }
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data?.ok) {
                    this.lvData = {
                        level: data.level,
                        level_floor: data.level_floor ?? 0,
                        progress_pct: data.progress_pct ?? 0,
                        season_short: data.season_short || '',
                        total_consumed_ge: data.total_consumed_ge || '0',
                        total_free_ge: data.total_free_ge || '0',
                        total_consumed_all_ge: data.total_consumed_all_ge || data.total_consumed_ge || '0',
                        last_season_level: data.last_season_level ?? 0,
                        country_iso2: data.country_iso2,
                    };
                    if (data.country_iso2 && this.authData && !this.authData.countryIso2) {
                        this.authData.countryIso2 = data.country_iso2;
                        await this._persist();
                    }
                    this._broadcast('lv-fetch');
                }
            } else if (resp.status === 401 || resp.status === 403) {
                console.warn('[auth-brain] lv fetch returned ' + resp.status + ', auto-logout');
                await this.clearAuth();
            }
        } catch { /* ignore */ }
    }

}

// ═══ IPC 注册 ═══

export function registerAuthBrainIpc(brain: AuthBrain): void {
    ipcMain.handle('qqqide:auth:open-login-external', async () => {
        return await brain.openLoginExternal();
    });

    ipcMain.handle('qqqide:auth:logout', async () => {
        await brain.clearAuth();
    });

    ipcMain.handle('qqqide:auth:get-state', async () => {
        return brain._snapshot();
    });

    ipcMain.on('qqqide:auth:billing', (_e, costWge: number) => {
        brain.onBillingEvent(costWge);
    });

    ipcMain.handle('qqqide:auth:save', async (_e, auth: any) => {
        if (auth?.token && auth?.phone) {
            await brain.setAuth(auth.token, auth.phone, auth.country_iso2, auth.purchased);
            return true;
        }
        return false;
    });

    ipcMain.handle('qqqide:auth:load', async () => {
        if (brain.isLoggedIn) {
            return { token: brain.token, phone: brain.phone, country_iso2: brain.countryIso2, purchased: brain.purchased };
        }
        return null;
    });

    ipcMain.handle('qqqide:auth:clear', async () => {
        await brain.clearAuth();
        return true;
    });

    ipcMain.handle('qqqide:auth:set-phone', async (_e, phone: string) => {
        return true;
    });
}
