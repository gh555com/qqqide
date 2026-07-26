// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// asset-protocol.ts — qqqide-asset:// 协议 / 资产根管理 / 磁盘空闲
// ============================================================================

import { protocol } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { URL } from 'url';
import { ChildProcess, spawn as cpSpawn } from 'child_process';
import { StateStore } from './state-sqlite';

// ---- Asset file allow-list ----
const _assetFileBuiltinRoots: string[] = [];
export const _assetFileWorkspaceRoots = new Set<string>();
let _assetRootsStorePath = '';

function initBuiltinRoots(portableCache: string): void {
    _assetFileBuiltinRoots.length = 0;
    _assetFileBuiltinRoots.push(path.normalize(portableCache), path.normalize(os.homedir()));
}

export function loadAssetRoots(portableUserData: string): void {
    _assetRootsStorePath = path.join(portableUserData, 'asset-roots.json');
    try {
        if (!fs.existsSync(_assetRootsStorePath)) { return; }
        const raw = fs.readFileSync(_assetRootsStorePath, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            for (const r of arr) {
                if (typeof r === 'string' && r) {
                    _assetFileWorkspaceRoots.add(path.normalize(r));
                }
            }
            console.log('[asset-roots] loaded', _assetFileWorkspaceRoots.size, 'workspace root(s)');
        }
    } catch (e) {
        console.warn('[asset-roots] load failed:', e);
    }
}

export async function hydrateAssetRootsFromState(stateStore: StateStore): Promise<void> {
    try {
        const v = await stateStore.get('qqqide', 'asset_roots');
        if (Array.isArray(v) && v.length > 0) {
            for (const r of v) {
                if (typeof r === 'string' && r) {
                    _assetFileWorkspaceRoots.add(path.normalize(r));
                }
            }
            console.log('[asset-roots] hydrated', _assetFileWorkspaceRoots.size, 'from state');
        } else {
            const arr = Array.from(_assetFileWorkspaceRoots);
            await stateStore.setNow('qqqide', 'asset_roots', arr);
            try {
                if (_assetRootsStorePath && fs.existsSync(_assetRootsStorePath)) {
                    fs.renameSync(_assetRootsStorePath, _assetRootsStorePath + '.migrated');
                }
            } catch { /* ignore */ }
        }
    } catch (e) {
        console.warn('[state] _hydrateAssetRootsFromState failed:', e);
    }
}

function persistAssetRoots(stateStore: StateStore): void {
    try {
        const arr = Array.from(_assetFileWorkspaceRoots);
        stateStore.set('qqqide', 'asset_roots', arr);
    } catch (e) {
        console.warn('[asset-roots] persist failed:', e);
    }
}

export function addAssetRoot(absDir: string, stateStore: StateStore): boolean {
    if (!absDir || typeof absDir !== 'string') { return false; }
    if (!path.isAbsolute(absDir)) { return false; }
    let norm: string;
    try {
        norm = path.normalize(absDir);
    } catch { return false; }
    try {
        const st = fs.statSync(norm);
        if (!st.isDirectory()) { return false; }
    } catch { return false; }
    if (_assetFileWorkspaceRoots.has(norm)) { return false; }
    _assetFileWorkspaceRoots.add(norm);
    persistAssetRoots(stateStore);
    console.log('[asset-roots] added', norm);
    return true;
}

export function isPathAllowed(abs: string): boolean {
    const norm = path.normalize(abs);
    for (const root of _assetFileBuiltinRoots) {
        if (norm === root || norm.startsWith(root + path.sep)) { return true; }
    }
    for (const root of _assetFileWorkspaceRoots) {
        if (norm === root || norm.startsWith(root + path.sep)) { return true; }
    }
    return false;
}

// ---- Asset protocol registration ----
export function registerAssetProtocol(portableRoot: string): void {
    // ★ packaged 模式下 monaco/ts/shell 在 resources/app/ 下，不在 portableRoot (gh555.com/) 下
    const resApp = path.join(portableRoot, 'resources', 'app');
    const appAssetsRoot = fs.existsSync(resApp) ? resApp : portableRoot;
    const roots: Record<string, string> = {
        monaco: path.join(appAssetsRoot, 'node_modules', 'monaco-editor', 'min'),
        'monaco-maps': path.join(appAssetsRoot, 'node_modules', 'monaco-editor', 'min-maps'),
        'monaco-esm': path.join(appAssetsRoot, 'node_modules', 'monaco-editor', 'esm'),
        monaco_deps: path.join(portableRoot, 'Data', 'monaco-deps'),
        ts: path.join(appAssetsRoot, 'node_modules', 'typescript', 'lib'),
        shell: path.join(appAssetsRoot, 'shell-out'),
    };
    protocol.registerFileProtocol('qqqide-asset', (request, callback) => {
        try {
            const url = new URL(request.url);
            const resource = url.hostname;
            const subPath = decodeURIComponent(url.pathname);

            if (resource === 'file') {
                let abs = subPath.startsWith('/') ? subPath.slice(1) : subPath;
                abs = path.normalize(abs);
                if (!path.isAbsolute(abs) || !isPathAllowed(abs)) {
                    console.warn('[qqqide-asset/file] denied:', abs);
                    return callback({ error: -10 });
                }
                if (!fs.existsSync(abs)) { return callback({ error: -6 }); }
                return callback({ path: abs });
            }

            const root = roots[resource];
            if (!root) { return callback({ error: -6 }); }
            const resolved = path.normalize(path.join(root, subPath));
            if (!resolved.startsWith(root)) { return callback({ error: -10 }); }

            if (resource === 'monaco' && !fs.existsSync(resolved) && roots['monaco_deps']) {
                const fallback = path.normalize(path.join(roots['monaco_deps'], subPath));
                if (fallback.startsWith(roots['monaco_deps']) && fs.existsSync(fallback)) {
                    return callback({ path: fallback });
                }
            }
            // ★ Monaco source map 补丁：min/vs/loader.js 内嵌 sourceMappingURL=../../min-maps/...
            // → 浏览器解析为 qqqide-asset://monaco/min-maps/... → subPath=/min-maps/...
            //   但 monaco-maps root 已是 min-maps/ 目录，不能重复前缀
            if (resource === 'monaco' && !fs.existsSync(resolved) && roots['monaco-maps'] && subPath.startsWith('/min-maps/')) {
                const realSubPath = subPath.slice('/min-maps'.length); // ← 剥掉多余的 /min-maps 前缀
                const mapsFallback = path.normalize(path.join(roots['monaco-maps'], realSubPath));
                if (mapsFallback.startsWith(roots['monaco-maps']) && fs.existsSync(mapsFallback)) {
                    return callback({ path: mapsFallback });
                }
            }
            callback({ path: resolved });
        } catch (e) {
            console.warn('[qqqide-asset] bad url:', request.url, e);
            callback({ error: -2 });
        }
    });
}

// ---- Disk free batch ----
export interface DiskFreeEntry { free?: number; total?: number; used?: number; path?: string; }

let _diskFreeCache: { t: number; key: string; data: Record<string, DiskFreeEntry> } | null = null;
const _DISK_FREE_TTL_MS = 30 * 1000;

function resolveKpBridge(portableRoot: string): { script: string; python: string } | null {
    const candidates = [
        path.join(portableRoot, 'engines', 'kp_bridge.py'),
        path.join(portableRoot, 'resources', 'app', 'engines', 'kp_bridge.py'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            const py = process.env.QQQ_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
            return { script: p, python: py };
        }
    }
    return null;
}

function diskFreeNodeFallback(drives: string[]): Record<string, DiskFreeEntry> {
    const result: Record<string, DiskFreeEntry> = {};
    for (const d of drives || []) {
        try {
            const stats = (fs as any).statfsSync(d);
            const bsize = stats.bsize as number;
            const letter = (d.charAt(0) || 'X').toUpperCase();
            result[letter] = {
                free: (stats.bfree as number) * bsize,
                total: (stats.blocks as number) * bsize,
            };
        } catch { /* skip */ }
    }
    try {
        const desktop = path.join(os.homedir(), 'Desktop');
        let used = 0;
        const entries = fs.readdirSync(desktop);
        for (const e of entries) {
            try { used += fs.statSync(path.join(desktop, e)).size; } catch { /* skip */ }
        }
        result['DESKTOP'] = { used, path: desktop };
    } catch { result['DESKTOP'] = { used: 0 }; }
    result['RECYCLE'] = { used: 0 };
    return result;
}

async function diskFreeViaKpBridge(portableRoot: string, drives: string[]): Promise<Record<string, DiskFreeEntry> | null> {
    const kp = resolveKpBridge(portableRoot);
    if (!kp) { return null; }
    return await new Promise(resolve => {
        let proc: ChildProcess;
        try {
            proc = cpSpawn(kp.python, ['-u', kp.script], {
                cwd: portableRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch { return resolve(null); }
        let stdout = '';
        proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.on('error', () => resolve(null));
        proc.on('close', () => {
            try {
                const result = JSON.parse(stdout);
                resolve(result || null);
            } catch { resolve(null); }
        });
        const input = JSON.stringify(drives || []);
        try {
            proc.stdin!.write(input);
            proc.stdin!.end();
        } catch (e) {
            console.warn('[diskFree] kp_bridge stdin failed:', e);
            resolve(null);
        }
    });
}

export async function diskFreeBatch(portableRoot: string, drives: string[]): Promise<Record<string, DiskFreeEntry>> {
    const key = JSON.stringify(drives || []);
    const now = Date.now();
    if (_diskFreeCache && _diskFreeCache.key === key && (now - _diskFreeCache.t) < _DISK_FREE_TTL_MS) {
        return _diskFreeCache.data;
    }
    let data = await diskFreeViaKpBridge(portableRoot, drives);
    if (!data) { data = diskFreeNodeFallback(drives); }
    _diskFreeCache = { t: now, key, data };
    return data;
}

// Initialize builtin roots when module loads (called from main.ts)
export function initAssetProtocol(portableRoot: string, portableCache: string, portableUserData: string): void {
    initBuiltinRoots(portableCache);
    loadAssetRoots(portableUserData);
    registerAssetProtocol(portableRoot);
}
