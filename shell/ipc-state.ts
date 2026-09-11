// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-state.ts — IPC 共享状态 (qwr 机器 _sn / _qe / _pythonExe)
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';

// File snapshots for qwr machine (mtime+size per file path, used for CAS validation)
export const _sn: Record<string, { mtimeMs: number; size: number }> = {};

// Per-file serial queue (_qw Map<path, Promise链>)
const _qw = new Map<string, Promise<any>>();

/**
 * _qe — qwr 机器 per-file 排队写（同文件排队，不同文件并行）
 * ★ 2026-09-10 根治：全局命令屏障（_co/_ac 双向门）已整体拆除。
 * 旧机制在命令运行期间冻结全 IDE 一切写操作——一条卡死命令（远程 go test
 * 15 分钟无输出）令所有面板的写同步冻死；写本身是原子 tmp+rename，命令
 * 永远看不到半截文件，全局互斥零正确性收益。命令与写互不等待。
 */
export function _qe(filePath: string, fn: () => Promise<string>): Promise<string> {
    const prev = _qw.get(filePath) || Promise.resolve();
    const p = prev.then(() => fn());
    _qw.set(filePath, p);
    // 清理：promise settled 后移除（但保留链以保证顺序）
    p.finally(() => {
        if (_qw.get(filePath) === p) {
            _qw.delete(filePath);
        }
    });
    return p;
}



// Python executable — 唯一真理源: engines/manifest.json via component-checker
let __pythonExe = '';

export function getPythonExe(portableRoot: string): string {
    if (__pythonExe) return __pythonExe;
    try {
        const { getComponentBin } = require('./component-checker');
        const bin = getComponentBin(portableRoot, 'python');
        if (bin) { __pythonExe = bin; return __pythonExe; }
    } catch {}
    __pythonExe = '';
    return __pythonExe;
}

// AI tool skip lists
export const AI_SKIP_DIRS = ['node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs', 'cache', 'temp', 'crashDumps'];
export const AI_SKIP_EXTS = ['.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.xz', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.vsix', '.lock', '.wasm'];
export const AI_MAX_FILE_SIZE = 10 * 1024 * 1024;

export function aiGlobToRegex(pattern: string): RegExp {
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + esc + '$', 'i');
}

export function aiTimeout(ms: number, partial: string): Promise<string> {
    return new Promise(resolve => { setTimeout(() => resolve((partial || '') + '\n[TIMEOUT]'), ms); });
}

// Whitespace normalization for edit_file L2/L3 matching
export function aiNormalizeWhitespace(s: string): string {
    return s.replace(/[ \t]+/g, ' ').replace(/[\r\n]+/g, '\n').trim();
}

export function aiNormalizeCRLF(s: string): string {
    return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
