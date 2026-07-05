// ============================================================================
// ipc-state.ts — IPC 共享状态 (qwr 机器 _sn / _qe / _pythonExe)
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';

// File snapshots for qwr machine (mtime+size per file path, used for CAS validation)
export const _sn: Record<string, { mtimeMs: number; size: number }> = {};

// Per-file serial queue (_qw Map<path, Promise链>)
const _qw = new Map<string, Promise<any>>();

// 全局命令屏障
let _co = Promise.resolve();
let _ac = Promise.resolve();

/**
 * _qe — qwr 机器 per-file 排队写
 * 同文件排队，不同文件并行；命令等写完成才执行，写出等命令完成才写
 */
export function _qe(filePath: string, fn: () => Promise<string>): Promise<string> {
    const prev = _qw.get(filePath) || Promise.resolve();
    const p = prev.then(async () => {
        // 等命令完成
        await _ac;
        return fn();
    });
    _qw.set(filePath, p);
    // 清理：promise settled 后移除（但保留链以保证顺序）
    p.finally(() => {
        if (_qw.get(filePath) === p) {
            _qw.delete(filePath);
        }
    });
    return p;
}

// 命令屏障：登记一个命令执行，返回解除函数
export function _qgc(): () => void {
    let resolve: () => void;
    const p = new Promise<void>(r => { resolve = r; });
    const prev = _co;
    _co = prev.then(() => p);
    // 等待所有写完成
    const waitWrites = Promise.all(Array.from(_qw.values()));
    _ac = waitWrites.then(() => { });
    return () => {
        // 等上一个命令完成
        prev.then(() => resolve());
    };
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
