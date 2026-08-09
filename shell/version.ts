// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// version.ts — 唯一真理源：版本号、语义化比较、更新决策
//
// 铁律：
//   1. 整个项目只有这一个文件定义版本号
//   2. 所有版本比较走 compareSemver()，绝不用字符串 ==
//   3. 本地 > 服务器 → 啥也不做（防降级）
//   4. 本地 == 服务器 → 跳过
//   5. 本地 < 服务器 → 热更新
//   6. 支持 min_shell：低于最低壳版本 → 需整包升级
// ============================================================================

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── 单一定义（唯一真理源）──────────────────────────────────────────────────
export const APP_VERSION = '0.2.331';

/** ★ 强制更新最低版本。客户端版本低于此值 → 启动时弹窗要求重新下载绿色包。 */
export const MIN_VERSION = '0.2.30';

export interface Semver {
    major: number;
    minor: number;
    patch: number;
    pre?: string;  // e.g. 'alpha', 'beta.1', 'rc.2'
}

// ── 语义化解析 ────────────────────────────────────────────────────────────

/** 从版本号字符串（格式同 major.minor.patch）创建可比较的对象。 */
export function parseSemver(v: string): Semver | null {
    if (!v || typeof v !== 'string') return null;
    // 允许 'v' 前缀
    const clean = v.replace(/^v/, '').trim();
    // 拆分为数字段和预发布段
    const dashIdx = clean.indexOf('-');
    const numPart = dashIdx >= 0 ? clean.slice(0, dashIdx) : clean;
    const prePart = dashIdx >= 0 ? clean.slice(dashIdx + 1) : undefined;

    const parts = numPart.split('.');
    if (parts.length < 2) return null;
    const major = parseInt(parts[0], 10);
    const minor = parseInt(parts[1], 10);
    const patch = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
    if (isNaN(major) || isNaN(minor) || isNaN(patch)) return null;

    return { major, minor, patch, pre: prePart || undefined };
}

// ── 比较 ──────────────────────────────────────────────────────────────────

/**
 * 语义化版本比较。
 * 返回:
 *   < 0  → a < b
 *   = 0  → a == b
 *   > 0  → a > b
 *   null → 解析失败
 */
export function compareSemver(a: string, b: string): number | null {
    const sa = parseSemver(a);
    const sb = parseSemver(b);
    if (!sa || !sb) return null;

    if (sa.major !== sb.major) return sa.major - sb.major;
    if (sa.minor !== sb.minor) return sa.minor - sb.minor;
    if (sa.patch !== sb.patch) return sa.patch - sb.patch;

    // 预发布比较：无预发布 > 有预发布（正式版 > 预发布版）
    if (!sa.pre && !sb.pre) return 0;
    if (!sa.pre && sb.pre) return 1;   // a 是正式版，b 是预发布
    if (sa.pre && !sb.pre) return -1;  // a 是预发布，b 是正式版
    // 两者都有预发布：字典序比较（简化，实践中够用）
    if (sa.pre! < sb.pre!) return -1;
    if (sa.pre! > sb.pre!) return 1;
    return 0;
}

// ── 更新决策（工业级）─────────────────────────────────────────────────────

export type UpdateDecision =
    | 'skip-up-to-date'      // 本地 == 服务器
    | 'skip-local-newer'     // 本地 > 服务器（开发版/内部测试版）
    | 'hot-update'            // 本地 < 服务器 → 允许热更新
    | 'force-full-upgrade'    // 本地 < min_shell → 必须整包升级
    | 'error'                 // 版本解析失败

export interface VersionInfo {
    /** 服务器上最新 shell 版本 */
    shell?: string;
    /** 服务器上最新 webapp 版本 */
    webapp?: string;
    /** 最低兼容 shell 版本（低于此版本需整包升级，未可热更新） */
    min_shell?: string;
}

/**
 * 根据本地版本和服务器版本信息，决定是否更新。
 *
 * @param localVersion  本地版本号
 * @param serverVersion 服务器上目标版本号
 * @param minVersion    最低兼容版本（如 min_shell），可选
 */
export function decideUpdate(
    localVersion: string,
    serverVersion: string,
    minVersion?: string,
): UpdateDecision {
    // 1) 最低版本检查（用于强制整包升级）
    if (minVersion) {
        const cmpMin = compareSemver(localVersion, minVersion);
        if (cmpMin === null) return 'error';
        if (cmpMin < 0) return 'force-full-upgrade';
    }

    // 2) 语义比较
    const cmp = compareSemver(localVersion, serverVersion);
    if (cmp === null) return 'error';
    if (cmp > 0) return 'skip-local-newer';
    if (cmp === 0) return 'skip-up-to-date';
    return 'hot-update';
}

// ── 本地版本持久化 ────────────────────────────────────────────────────────

const VERSION_DIR = 'Data';
const SHELL_VERSION_FILE = 'shell-version';
const WEBAPP_VERSION_FILE = 'webapp-version';

export function readLocalShellVersion(portableRoot: string): string {
    try {
        const p = join(portableRoot, VERSION_DIR, SHELL_VERSION_FILE);
        if (existsSync(p)) return readFileSync(p, 'utf8').trim();
    } catch { }
    return '';
}

export function writeLocalShellVersion(portableRoot: string, version: string): void {
    try {
        const p = join(portableRoot, VERSION_DIR, SHELL_VERSION_FILE);
        writeFileSyncRecursive(p, version);
    } catch { }
}

export function readLocalWebappVersion(portableRoot: string): string {
    try {
        const p = join(portableRoot, VERSION_DIR, WEBAPP_VERSION_FILE);
        if (existsSync(p)) return readFileSync(p, 'utf8').trim();
    } catch { }
    return '';
}

export function writeLocalWebappVersion(portableRoot: string, version: string): void {
    try {
        const p = join(portableRoot, VERSION_DIR, WEBAPP_VERSION_FILE);
        writeFileSyncRecursive(p, version);
    } catch { }
}

// ── 辅助 ──────────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

function writeFileSyncRecursive(filePath: string, data: string): void {
    try { mkdirSync(dirname(filePath), { recursive: true }); } catch { }
    writeFileSync(filePath, data, 'utf8');
}

// ── 服务器 version.json → 本地结构 ─────────────────────────────────────────

const https = require('https');
const http = require('http');

async function _httpGet(url: string, redirects: number = 3): Promise<{ status: number; data: string }> {
    const lib = url.startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
        const opts: any = { timeout: 8000 };
        if (url.startsWith('https')) { opts.rejectUnauthorized = false; }
        const req = lib.get(url, opts, (res: any) => {
            // Follow redirects (Node.js http.get doesn't auto-follow)
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && redirects > 0) {
                const loc = res.headers.location;
                res.resume(); // Drain response body
                if (loc) {
                    _httpGet(loc, redirects - 1).then(resolve, reject);
                } else {
                    resolve({ status: res.statusCode, data: '' });
                }
                return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => data += c);
            res.on('end', () => resolve({ status: res.statusCode || 0, data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

export async function fetchServerVersionInfo(baseUrl: string): Promise<VersionInfo | null> {
    try {
        const versionUrl = (baseUrl.endsWith('/') ? baseUrl : baseUrl + '/') + 'version.json';
        const vResp = await _httpGet(versionUrl);
        if (vResp.status !== 200) return null;
        const v = JSON.parse(vResp.data);

        // 兼容旧格式 { shell_version, webapp_version, version }
        return {
            shell: v.shell || v.shell_version || v.version || '',
            webapp: v.webapp || v.webapp_version || v.version || '',
            min_shell: v.min_shell || '',
        };
    } catch {
        return null;
    }
}

/** fetchServerVersionInfo with fallback: try primary URL first, then fallback. */
// ── 强制更新检查 ─────────────────────────────────────────────────────────

export interface ForcedUpdateResult {
    required: boolean;
    currentVersion: string;
    minVersion: string;
}

/** 检查当前版本是否低于强制更新阈值。返回 { required, currentVersion, minVersion }。 */
export function checkForcedUpdate(): ForcedUpdateResult {
    const cmp = compareSemver(APP_VERSION, MIN_VERSION);
    return {
        required: cmp !== null && cmp < 0,
        currentVersion: APP_VERSION,
        minVersion: MIN_VERSION,
    };
}

// ── 服务器版本拉取 ───────────────────────────────────────────────────────

export async function fetchServerVersionInfoWithFallback(
    primaryUrl: string,
    fallbackUrl: string
): Promise<VersionInfo | null> {
    const primary = await fetchServerVersionInfo(primaryUrl);
    if (primary) return primary;
    if (fallbackUrl) {
        return await fetchServerVersionInfo(fallbackUrl);
    }
    return null;
}
