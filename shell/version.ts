// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// version.ts — 版本号唯一真理源
//
// ★ 版本 = 清单编号（2026-08-10 重构定案，四层精确矩阵）：
//   gh555.com/versions.json 是唯一版本权威：
//     { "id": "0.2.339", "launcher": "20260810.3", "shell": "0.2.339",
//       "webapp": "0.2.339", "rank": { python: "3.8.10", ... } }
//   - id = 唯一版本号（左下角显示 / latest.txt / C 启动器比较）
//   - 任何组件版本变更（含降级）只能通过换 r（新 versions.json）完成
//   - 壳层/载荷热更通道已整体删除（2026-08-10），版本漂移在机制上不可能
//
// 铁律：
//   1. 整个项目只有这一个文件定义包版本号 APP_VERSION
//   2. 版本比较只发生在 C 启动器（launcher.c compareVersion，清单编号）
//   3. 壳层侧不做任何"是否更新"决策——更新 100% 由 C 启动器托管
// ============================================================================

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── 单一定义（唯一真理源）──────────────────────────────────────────────────
export const APP_VERSION = '0.2.358';

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

// ── 清单编号读取（唯一版本权威）────────────────────────────────────────────

/**
 * 读取当前版本清单编号（versions.json 的 id 字段）。
 * packaged 模式 portableRoot = {包根}/gh555.com → 读 {包根}/gh555.com/versions.json。
 * dev 模式无 versions.json → 回退 APP_VERSION。
 * C 启动器与壳层读同一文件同一字段，版本永远不会分裂。
 */
export function readManifestId(portableRoot: string): string {
    try {
        const p = join(portableRoot, 'versions.json');
        if (existsSync(p)) {
            const v = JSON.parse(readFileSync(p, 'utf8'));
            if (v && typeof v.id === 'string' && v.id) return v.id;
        }
    } catch { }
    return APP_VERSION;
}

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
