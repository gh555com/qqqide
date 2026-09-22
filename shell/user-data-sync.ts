// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// user-data-sync.ts — 用户数据云同步（老 qqq「上传/下载」按钮 100% 语义移植）
//
// 语义（q3/global.js uploadUserData / pullUserData，2026-08-xx 老版）:
//   三个 blob: roam_config / roam_folder_prefs / clipboard_history
//   上传 = Pull-Merge-Push：先拉云端 → 本地 ∪ 云端合并 → 推回 → 写回本地
//           （数学上零丢失：本地 3 条 + 云端 88 条 → 并集 91 条）
//   下载 = Pull-Merge-Local：拉云端 → 合并进本地（同样并集，不丢本地）
//   合并: pinnedDirs/qqiq 并集(cap 6/100) · folder prefs 按 key 并集(ts 新者胜, cap 500 LRU)
//         · 剪贴板按 content_hash 并集（新项目结构化增强——老项目二进制 keep-larger
//           的精确版，kope.sq3 有 UNIQUE content_hash，INSERT OR IGNORE 天然去重）
//
// 数据源（qqqide 本地映射）:
//   roam_config       ← roam.sq3: pinnedDirs / qqiq / prefs / sidebarWidth / lastVisitedDir
//   roam_folder_prefs ← roam.sq3: fineScm {path:{szMode,sortBy,filesOnTop,ts}}（与老结构同构）
//   clipboard_history ← kope.sq3 全行 → {v,ts,data_b64gz}（gzip+base64，与服务端配额检查同格式）
//
// 端点: POST https://gh555.com/api/gaea/qqqide/user-data{,/pull}（服务端早已预留的独立端点）
// 认证: getAuthPhone()/getAuthToken()（auth-state 共享内存；登录后 main.ts 写入；无 token → no-auth）
// 确认: 双通道——渲染层内置弹框已完成确认时传 labels.skipConfirm → 壳层跳过；
//       否则回退 dialog.showMessageBox 原生模态（老 showWarningMessage{modal:true} 语义，旧渲染层兼容）
// 防重入: _busy 锁（老 _cloudLok 语义）；错误返回稳定码，渲染层映射 12 语言文案
// 边界: 剪贴板单条 >4MB 或整包超配额 → 如实放弃该 blob（其余照常）；明文上云（与老项目一致）
// ============================================================================

import * as os from 'os';
import * as zlib from 'zlib';
import * as https from 'https';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { getAuthPhone, getAuthToken } from './auth-state';
import { roamGetAllForSync, roamSetManyForSync } from './ipc-roam';
import { kopeExportRows, kopeImportRows } from './ipc-kope';

const API_HOST = 'gh555.com';
const PUSH_PATH = '/api/gaea/qqqide/user-data';
const PULL_PATH = '/api/gaea/qqqide/user-data/pull';
const REQ_TIMEOUT_MS = 30000;

// ── 配额（与服务端 handlers_ide_sync.go 常量对齐）──
const QUOTA_ROAM_CONFIG = 50 * 1024;         // 50 KB
const QUOTA_FOLDER_PREFS = 500 * 1024;       // 500 KB
const QUOTA_CLIP_GZ = 5 * 1024 * 1024;       // 服务端按 base64 解码后（= gz 字节）检查
const CLIP_TARGET_GZ = Math.floor(QUOTA_CLIP_GZ * 0.96);  // 本地留 4% 余量
const CLIP_MAX_ROWS_BYTES = 64 * 1024 * 1024; // 导出总内存硬顶（异常数据防爆）

// ── 合并常量（老项目语义）──
const PINNED_MAX = 6;
const QIQ_MAX = 100;
const FINE_SCM_MAX = 500;

// ── 状态 ──
let _busy = false;

export type SyncReason =
    | 'no-auth' | 'busy' | 'cancelled' | 'network' | 'no-data'
    | 'not-purchased' | 'rate-limit' | 'quota' | 'not-registered'
    | 'auth-expired' | 'server' | 'unknown';

export interface SyncResult {
    ok: boolean;
    reason?: SyncReason;
    added?: number;          // 合并新增条数（上传 = 云端→本地方向新增；下载 = 全部新增）
    restored?: string[];     // 本次触及的 blob 名
    at?: number;             // 完成时刻（epoch 秒）
}

// ── 路径归一化（与 q2-roam _normPath / 老项目 cacheKeyForPath 同款）──
function normPath(p: unknown): string {
    return String(p || '').toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
}

function mapServerError(code: unknown): SyncReason {
    switch (code) {
        case 'not_purchased': return 'not-purchased';
        case 'rate_limit': return 'rate-limit';
        case 'quota_exceeded': return 'quota';
        case 'phone_not_registered': return 'not-registered';
        case 'auth_failed': return 'auth-expired';
        default: return 'server';
    }
}

// ── HTTP POST（wq-ping 同款：Node https，零依赖）──
function httpsPostJson(pathname: string, body: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
        const req = https.request({
            hostname: API_HOST,
            port: 443,
            path: pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length,
            },
            timeout: REQ_TIMEOUT_MS,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let json: any = null;
                try { json = raw ? JSON.parse(raw) : {}; } catch { json = { _raw: raw }; }
                resolve({ status: res.statusCode || 0, json });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

// ── 确认对话框（fallback 原生模态；文案由渲染层传入，此处仅兜底英文）──
//   skipConfirm=true → 渲染层内置弹框（first-run 同款）已确认，跳过原生模态（2026-09-22 用户定案）
interface ConfirmLabels { title?: string; message?: string; ok?: string; cancel?: string; skipConfirm?: boolean; }

async function confirmDialog(labels: ConfirmLabels | undefined, fallback: ConfirmLabels): Promise<boolean> {
    const l: ConfirmLabels = { ...fallback, ...(labels || {}) };
    const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: l.title || '',
        message: l.message || '',
        buttons: [l.ok || 'OK', l.cancel || 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
    };
    try {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
        const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
        return r.response === 0;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 本地数据构建
// ─────────────────────────────────────────────────────────────────────────────
async function buildLocalRoam(): Promise<{ roamConfig: any; folderPrefs: any }> {
    let all: Record<string, any> = {};
    try { all = await roamGetAllForSync(); } catch { all = {}; }
    const roamConfig = {
        pinnedDirs: Array.isArray(all['roam.pinnedDirs']) ? all['roam.pinnedDirs'] : [],
        qqiq: Array.isArray(all['roam.qqiq']) ? all['roam.qqiq'] : [],
        prefs: (all['roam.prefs'] && typeof all['roam.prefs'] === 'object') ? all['roam.prefs'] : null,
        sidebarWidth: (typeof all['roam.sidebarWidth'] === 'number') ? all['roam.sidebarWidth'] : null,
        lastVisitedDir: (typeof all['roam.lastVisitedDir'] === 'string') ? all['roam.lastVisitedDir'] : '',
    };
    const fp = all['roam.fineScm'];
    const folderPrefs = (fp && typeof fp === 'object' && !Array.isArray(fp)) ? fp : {};
    return { roamConfig, folderPrefs };
}

// ── 合并: roam_config（老 _mergeRoamConfig 逐字语义）──
function mergeRoamConfig(local: any, cloud: any): { merged: any; added: number } {
    if (!cloud) return { merged: local, added: 0 };
    if (!local) {
        const added = (Array.isArray(cloud.pinnedDirs) ? cloud.pinnedDirs.length : 0)
            + (Array.isArray(cloud.qqiq) ? cloud.qqiq.length : 0);
        return { merged: cloud, added };
    }
    const merged = { ...local };
    let added = 0;

    const localPinned = Array.isArray(local.pinnedDirs) ? local.pinnedDirs : [];
    const cloudPinned = Array.isArray(cloud.pinnedDirs) ? cloud.pinnedDirs : [];
    const seenPin = new Set(localPinned.map((d: any) => normPath(d)));
    const mergedPinned = [...localPinned];
    for (const dir of cloudPinned) {
        const k = normPath(dir);
        if (!seenPin.has(k)) { mergedPinned.push(dir); seenPin.add(k); added++; }
    }
    merged.pinnedDirs = mergedPinned.slice(0, PINNED_MAX);

    const localQqiq = Array.isArray(local.qqiq) ? local.qqiq : [];
    const cloudQqiq = Array.isArray(cloud.qqiq) ? cloud.qqiq : [];
    const seenQ = new Set(localQqiq.map((it: any) => (it && it.path) ? normPath(it.path) : ''));
    const mergedQqiq = [...localQqiq];
    for (const item of cloudQqiq) {
        if (!item || !item.path) continue;
        const k = normPath(item.path);
        if (!seenQ.has(k)) { mergedQqiq.push(item); seenQ.add(k); added++; }
    }
    merged.qqiq = mergedQqiq.slice(0, QIQ_MAX);

    // Scalars（prefs / sidebarWidth / lastVisitedDir）: local wins —— merged = { ...local } 天然保留
    return { merged, added };
}

// ── 合并: folder prefs（老 _mergeFolderPrefs 逐字语义）──
function mergeFolderPrefs(local: any, cloud: any): { merged: any; added: number } {
    if (!cloud) return { merged: local, added: 0 };
    if (!local) return { merged: cloud, added: Object.keys(cloud).length };
    const merged: any = { ...cloud };
    let added = 0;
    for (const key of Object.keys(cloud)) { if (!(key in local)) added++; }
    for (const [key, val] of Object.entries(local)) {
        const cv: any = (cloud as any)[key];
        if (!cv || (((val as any) || {}).ts || 0) >= ((cv || {}).ts || 0)) { merged[key] = val; }
    }
    const keys = Object.keys(merged);
    if (keys.length > FINE_SCM_MAX) {
        keys.sort((a, b) => ((merged[a] || {}).ts || 0) - ((merged[b] || {}).ts || 0));
        for (const k of keys.slice(0, keys.length - FINE_SCM_MAX)) delete merged[k];
    }
    return { merged, added };
}

// ── 配额守卫: roam_config 超限 → 裁 qqiq 尾部（异常数据防呆；正常 6+100 条 ≈ 10KB）──
function fitRoamConfig(rc: any): any {
    if (JSON.stringify(rc).length <= QUOTA_ROAM_CONFIG) return rc;
    const out = { ...rc, qqiq: Array.isArray(rc.qqiq) ? rc.qqiq.slice(0, 50) : [] };
    if (JSON.stringify(out).length <= QUOTA_ROAM_CONFIG) return out;
    out.qqiq = [];
    if (JSON.stringify(out).length <= QUOTA_ROAM_CONFIG) return out;
    return { pinnedDirs: Array.isArray(rc.pinnedDirs) ? rc.pinnedDirs.slice(0, PINNED_MAX) : [], qqiq: [], prefs: null, sidebarWidth: rc.sidebarWidth, lastVisitedDir: '' };
}

// ── 配额守卫: folder prefs 超限 → 按 ts LRU 砍最旧的 10% 批次直到进入配额 ──
function shrinkFolderPrefs(fp: any, quota: number): any {
    const out: any = { ...fp };
    let size = JSON.stringify(out).length;
    if (size <= quota) return out;
    const sorted = Object.keys(out).sort((a, b) => ((out[a] || {}).ts || 0) - ((out[b] || {}).ts || 0));
    let i = 0;
    let guard = 0;
    while (size > quota && i < sorted.length && guard < 64) {
        const batch = Math.max(1, Math.ceil((sorted.length - i) * 0.1));
        for (let j = 0; j < batch && i < sorted.length; j++, i++) delete out[sorted[i]];
        size = JSON.stringify(out).length;
        guard++;
    }
    return out;
}

// ── 剪贴板 blob（{v,ts,data_b64gz}；与老项目/服务端同格式）──
function gzB64(rows: any[]): { b64: string; gzLen: number } {
    const json = JSON.stringify(rows);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    return { b64: gz.toString('base64'), gzLen: gz.length };
}

function buildClipboardBlob(rows: any[]): { data_b64gz: string; kept: number } | null {
    if (!Array.isArray(rows) || !rows.length) return null;
    // 总量防爆（异常数据）
    let totalBytes = 0;
    for (const r of rows) { totalBytes += String((r && r.content) || '').length; if (totalBytes > CLIP_MAX_ROWS_BYTES) break; }
    const sorted = rows.slice().sort((a, b) =>
        String((b && b.updated_at) || '').localeCompare(String((a && a.updated_at) || '')));
    let kept = sorted;
    let last = gzB64(kept);
    let guard = 0;
    while (last.gzLen > CLIP_TARGET_GZ && kept.length > 1 && guard < 16) {
        kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.75)));
        last = gzB64(kept);
        guard++;
    }
    if (last.gzLen > QUOTA_CLIP_GZ) return null;  // 连最小集都超配额 → 如实放弃剪贴板 blob
    return { data_b64gz: last.b64, kept: kept.length };
}

function parseClipboardBlob(raw: any): any[] {
    try {
        const obj = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        const b64 = obj && obj.data_b64gz;
        if (typeof b64 !== 'string' || !b64) return [];
        const gz = Buffer.from(b64, 'base64');
        if (!gz.length || gz.length > 16 * 1024 * 1024) return [];  // 防御性上限
        const json = zlib.gunzipSync(gz).toString('utf8');
        const rows = JSON.parse(json);
        return Array.isArray(rows) ? rows : [];
    } catch { return []; }
}

function deviceName(): string {
    try { return String(os.hostname() || 'qqqide').slice(0, 120); } catch { return 'qqqide'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 上传（Pull-Merge-Push）
// ─────────────────────────────────────────────────────────────────────────────
export async function pushUserData(labels?: ConfirmLabels): Promise<SyncResult> {
    if (_busy) return { ok: false, reason: 'busy' };
    const token = getAuthToken();
    const phone = getAuthPhone();
    if (!token || !phone) return { ok: false, reason: 'no-auth' };

    _busy = true;   // ★ 先占锁再弹确认框（防多窗口/键盘触发并发；模态期间第二调用直接 busy）
    try {
        const go = (labels && labels.skipConfirm)
            ? true
            : await confirmDialog(labels, {
                title: 'Upload data to cloud',
                message: 'Local roaming prefs and clipboard history will be uploaded to the cloud (merged with existing cloud data first — nothing is lost), continue?',
                ok: 'Upload',
                cancel: 'Cancel',
            });
        if (!go) return { ok: false, reason: 'cancelled' };
        const nowSec = Math.floor(Date.now() / 1000);
        const dn = deviceName();

        // ── Step 1: 拉云端（失败则继续 local-only 上传——老语义）──
        let cloudBlobs: Record<string, any> = {};
        try {
            const pr = await httpsPostJson(PULL_PATH, { token, device_name: dn });
            if (pr.json && pr.json.ok && pr.json.blobs) cloudBlobs = pr.json.blobs;
        } catch { /* local-only 上传 */ }

        // ── Step 2: 本地状态 ──
        const { roamConfig: localRC, folderPrefs: localFP } = await buildLocalRoam();

        // ── Step 2b: 剪贴板云端行先并集导入本地（本地获得云端条目 → 后续导出=并集全量）──
        let clipImportAdded = 0;
        const cloudClipRows = cloudBlobs.clipboard_history ? parseClipboardBlob(cloudBlobs.clipboard_history) : [];
        if (cloudClipRows.length) {
            try { clipImportAdded = await kopeImportRows(cloudClipRows); } catch { /* ignore */ }
        }

        // ── Step 3: 合并 ──
        const rcMerge = mergeRoamConfig(localRC, cloudBlobs.roam_config && cloudBlobs.roam_config.data);
        const fpMerge = mergeFolderPrefs(localFP, cloudBlobs.roam_folder_prefs && cloudBlobs.roam_folder_prefs.data);
        const rcData = fitRoamConfig(rcMerge.merged);
        const fpData = shrinkFolderPrefs(fpMerge.merged, Math.floor(QUOTA_FOLDER_PREFS * 0.96));

        // 剪贴板：本地全量（已含云端并集）→ blob
        let clipBlob: { data_b64gz: string; kept: number } | null = null;
        try { clipBlob = buildClipboardBlob(await kopeExportRows()); } catch { /* ignore */ }

        // ── Step 4: 推合并结果 ──
        const blobs: Record<string, any> = {};
        blobs.roam_config = { v: 1, ts: nowSec, data: rcData };
        if (Object.keys(fpData).length) blobs.roam_folder_prefs = { v: 1, ts: nowSec, data: fpData };
        if (clipBlob) blobs.clipboard_history = { v: 1, ts: nowSec, data_b64gz: clipBlob.data_b64gz };

        let pr2;
        try { pr2 = await httpsPostJson(PUSH_PATH, { token, device_name: dn, blobs }); }
        catch { return { ok: false, reason: 'network' }; }
        if (!pr2.json || !pr2.json.ok) {
            return { ok: false, reason: mapServerError(pr2.json && pr2.json.error) };
        }

        // ── Step 5: 合并结果写回本地（本地同样受益于云端条目）──
        try {
            const back: Record<string, any> = {
                'roam.pinnedDirs': rcData.pinnedDirs,
                'roam.qqiq': rcData.qqiq,
                'roam.fineScm': fpData,
            };
            await roamSetManyForSync(back);
        } catch { /* ignore */ }

        return { ok: true, added: rcMerge.added + fpMerge.added + clipImportAdded, at: nowSec };
    } catch {
        return { ok: false, reason: 'network' };
    } finally {
        _busy = false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 下载（Pull-Merge-Local）
// ─────────────────────────────────────────────────────────────────────────────
export async function pullUserData(labels?: ConfirmLabels): Promise<SyncResult> {
    if (_busy) return { ok: false, reason: 'busy' };
    const token = getAuthToken();
    const phone = getAuthPhone();
    if (!token || !phone) return { ok: false, reason: 'no-auth' };

    _busy = true;   // ★ 先占锁再弹确认框（防多窗口/键盘触发并发；模态期间第二调用直接 busy）
    try {
        const go = (labels && labels.skipConfirm)
            ? true
            : await confirmDialog(labels, {
                title: 'Merge data from cloud',
                message: 'Cloud data will be merged with local roaming prefs and clipboard history (union — nothing is lost), continue?',
                ok: 'Download',
                cancel: 'Cancel',
            });
        if (!go) return { ok: false, reason: 'cancelled' };
        let pr;
        try { pr = await httpsPostJson(PULL_PATH, { token, device_name: deviceName() }); }
        catch { return { ok: false, reason: 'network' }; }
        if (!pr.json || !pr.json.ok) {
            return { ok: false, reason: mapServerError(pr.json && pr.json.error) };
        }
        const blobs: Record<string, any> = pr.json.blobs || {};
        if (!Object.keys(blobs).length) return { ok: false, reason: 'no-data' };

        let added = 0;
        const restored: string[] = [];
        const { roamConfig: localRC, folderPrefs: localFP } = await buildLocalRoam();

        // roam_config: 并集合并 → 回写 pinnedDirs/qqiq（scalars local wins 不回写）
        if (blobs.roam_config && blobs.roam_config.data) {
            const m = mergeRoamConfig(localRC, blobs.roam_config.data);
            try {
                await roamSetManyForSync({
                    'roam.pinnedDirs': m.merged.pinnedDirs,
                    'roam.qqiq': m.merged.qqiq,
                });
            } catch { /* ignore */ }
            added += m.added;
            restored.push('roam_config');
        }

        // folder prefs: union by key → 回写 fineScm
        if (blobs.roam_folder_prefs && blobs.roam_folder_prefs.data) {
            const m = mergeFolderPrefs(localFP, blobs.roam_folder_prefs.data);
            try { await roamSetManyForSync({ 'roam.fineScm': m.merged }); } catch { /* ignore */ }
            added += m.added;
            restored.push('roam_folder_prefs');
        }

        // clipboard: hash 并集导入
        if (blobs.clipboard_history) {
            const rows = parseClipboardBlob(blobs.clipboard_history);
            if (rows.length) {
                try { added += await kopeImportRows(rows); } catch { /* ignore */ }
                restored.push('clipboard_history');
            }
        }

        if (!restored.length) return { ok: false, reason: 'no-data' };
        return { ok: true, added, restored, at: Math.floor(Date.now() / 1000) };
    } catch {
        return { ok: false, reason: 'network' };
    } finally {
        _busy = false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC 注册（main.ts 调用）
// ─────────────────────────────────────────────────────────────────────────────
export function registerUserDataIpc(): void {
    ipcMain.handle('qqqide:userdata:push', async (_e, labels?: ConfirmLabels) => pushUserData(labels));
    ipcMain.handle('qqqide:userdata:pull', async (_e, labels?: ConfirmLabels) => pullUserData(labels));
}
