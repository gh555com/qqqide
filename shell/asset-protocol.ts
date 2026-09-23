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
import { getDataDir } from './portable-paths';
import { resolvePythonPath } from './py-broker';

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
    let appAssetsRoot = fs.existsSync(resApp) ? resApp : portableRoot;
    // ★ mac .app 布局（2026-09-23）：portableRoot(=Contents/MacOS) 拼不出 resources/app——
    //   实挂 Contents/Resources/app（app.getAppPath()）→ monaco/shell-out 全落空（编辑器加载失败）。
    //   以 node_modules/monaco-editor 存在性为判据，dev/win 零影响。
    if (!fs.existsSync(path.join(appAssetsRoot, 'node_modules', 'monaco-editor'))) {
        try {
            const ap = require('electron').app.getAppPath();
            if (ap && fs.existsSync(path.join(ap, 'node_modules', 'monaco-editor'))) {
                appAssetsRoot = ap;
            }
        } catch { /* ignore */ }
    }
    const roots: Record<string, string> = {
        monaco: path.join(appAssetsRoot, 'node_modules', 'monaco-editor', 'min'),
        'monaco-maps': path.join(appAssetsRoot, 'node_modules', 'monaco-editor', 'min-maps'),
        'monaco-esm': path.join(appAssetsRoot, 'node_modules', 'monaco-editor', 'esm'),
        monaco_deps: path.join(getDataDir(), 'monaco-deps'),
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
    // ★ mac .app 布局（2026-09-23）：portableRoot(=Contents/MacOS) 拼不出 engines
    //   （实挂 Contents/Resources/app/engines，符号链接→qqqide-data/engines）→ resourcesPath 兜底。
    try {
        const rp = (process as any).resourcesPath;
        if (rp) candidates.push(path.join(rp, 'app', 'engines', 'kp_bridge.py'));
    } catch { /* ignore */ }
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            // ★ 解释器统一阶梯（唯一机器 resolvePythonPath）：内置 python → 注册表 QQQIDE_PYTHON_DIR → PATH。
            //   禁裸名 "python"：无系统 Python 的机器会命中 Microsoft Store 假存根（rc 9009 全静默）→ 盘符不出数字
            const py = process.env.QQQ_PYTHON
                || resolvePythonPath(portableRoot)
                || (process.platform === 'win32' ? 'python' : 'python3');
            return { script: p, python: py };
        }
    }
    return null;
}

function diskFreeNodeFallback(drives: string[]): Record<string, DiskFreeEntry> {
    const result: Record<string, DiskFreeEntry> = {};
    const isWin = process.platform === 'win32';
    for (const d of drives || []) {
        try {
            if (isWin) {
                // Windows: statfsSync not available, use a simple PowerShell fallback
                // (kp_bridge should be the primary path; this is last-resort)
                continue;
            }
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

// ---- kp bridge 失败落盘日志（Data/diskfree.log）----
// 静默失败无法现场取证的历史欠账：kp 链任一环失败必须留痕（含解释器绝对路径），
// 将来任何一台机器再出问题，看日志一次定位。日志失败绝不影响盘符读取主流程。
let _kpLogLast = '';
let _kpLogLastAt = 0;
let _kpOkLogged = false;
function kpLog(line: string, dedupeMs?: number): void {
    try {
        const now = Date.now();
        if (dedupeMs && line === _kpLogLast && (now - _kpLogLastAt) < dedupeMs) return;
        _kpLogLast = line; _kpLogLastAt = now;
        const f = path.join(getDataDir(), 'diskfree.log');
        try { if (fs.statSync(f).size > 256 * 1024) fs.truncateSync(f, 0); } catch { /* 不存在即无需轮换 */ }
        fs.appendFileSync(f, '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + line + '\n', 'utf-8');
    } catch { /* 日志失败静默 */ }
}

async function diskFreeViaKpBridge(portableRoot: string, drives: string[]): Promise<Record<string, DiskFreeEntry> | null> {
    const kp = resolveKpBridge(portableRoot);
    if (!kp) { kpLog('kp_bridge.py not found (portableRoot=' + portableRoot + ')', 10 * 60 * 1000); return null; }
    return await new Promise(resolve => {
        let proc: ChildProcess;
        try {
            proc = cpSpawn(kp.python, ['-u', kp.script], {
                cwd: portableRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (e: any) {
            kpLog('spawn threw: ' + (e && e.message || e) + ' | python=' + kp.python, 60000);
            return resolve(null);
        }
        let stdout = '';
        let stderr = '';
        proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr!.on('data', (d: Buffer) => { if (stderr.length < 4096) stderr += d.toString(); });
        proc.on('error', (e: any) => {
            kpLog('spawn error: ' + (e && (e.code || e.message) || e) + ' | python=' + kp.python, 60000);
            resolve(null);
        });
        proc.on('close', (code: number | null) => {
            try {
                const result = JSON.parse(stdout);
                if (result && result.ok && result.data) {
                    if (!_kpOkLogged) {
                        _kpOkLogged = true;
                        kpLog('ok via ' + kp.python + ' | keys=' + Object.keys(result.data).join(','), 0);
                    }
                    resolve(result.data);
                } else {
                    kpLog('bad payload (exit=' + code + '): ' + stdout.slice(0, 200) + (stderr ? ' | stderr=' + stderr.slice(0, 200) : '') + ' | python=' + kp.python, 10 * 60 * 1000);
                    resolve(null);
                }
            } catch {
                kpLog('unparsable stdout (exit=' + code + ', len=' + stdout.length + ')' + (stderr ? ' stderr=' + stderr.slice(0, 300) : (stdout ? ' stdout=' + stdout.slice(0, 300) : '')) + ' | python=' + kp.python, 10 * 60 * 1000);
                resolve(null);
            }
        });
        const input = JSON.stringify({ action: 'disk_free_batch', drives: drives || [] });
        try {
            proc.stdin!.write(input);
            proc.stdin!.end();
        } catch (e) {
            kpLog('stdin write failed: ' + e + ' | python=' + kp.python, 60000);
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
