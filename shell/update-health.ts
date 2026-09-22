// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// update-health.ts — 升级健康快照（设置面板「升级健康位」数据源；2026-09-22 q292）
//
//   IPC: qqqide:update:health → 只读本地文件，零网络零副作用：
//     Win（C 启动器托管）: versions.json(id/launcher) + Data/updater-status.json
//       + 包根 .apply-fails（失败计数）+ .swap-ready（暂存就绪→重启换装）
//       + r.next.meta（后台下载/准备中的目标版本）
//     mac（应用内更新 v2）: Data/updater-status.json + {parent}/.update/staged.json
//     dev（无绿色包结构）: dev=true（界面显示「开发实例」）
//
//   消费方: server-app/core/update-health.js（设置面板标题行胶囊 + 悬停明细 + 点击诊断查看器）
//   路径推导与 wq-ping.collectUpdHealth / auto-updater 同口径（宿主根 = 启动器包内 gh555.com）。
//
//   ★ 诊断通道（v2；点击胶囊消费）——9 个核心失败/更新日志的本机尾段只读：
//     qqqide:update:diag        索引（交换日志/更新状态/失败计数/暂存标记/准备元数据/
//                               状态库事件/渲染崩溃/崩溃网事件+对账），零内容
//     qqqide:update:diag:file   单文件尾段（每件 ≤16KB，IPC 单条上限内）
//     qqqide:update:diag:report 合成报告落盘 Data/diag/update-diag-*.txt（保留最近 10 份）
//   零网络零自动外发——是否发给管理员 100% 由用户决定。
// ============================================================================

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface UpdateHealthSnapshot {
    ok: boolean;
    dev: boolean;          // 非绿色包结构（dev 实例 / 非标准安装）
    mac: boolean;
    ver: string;           // 当前版本（versions.json id；mac 无则空）
    launcher: string;      // 启动器版本（win）
    status: string;        // 最近一次更新尝试: 'ok' | 'waiting' | 'failed' | ''
    statusTs: number;      // 状态落盘时间（ms epoch）
    statusLine: string;    // 最近事件文本（updater-status.line 截断 240）
    fails: number;         // .apply-fails（交换/应用失败计数，0~99）
    stagedReady: boolean;  // 新版本已暂存（重启后自动换装）
    staged: string;        // 暂存目标版本
    prep: string;          // 后台准备中的目标版本（r.next.meta.v；win）
}

function _exists(p: string): boolean {
    try { return fs.existsSync(p); } catch (_) { return false; }
}
function _readText(p: string): string {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; }
}
function _readJson(p: string): any {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

// ── 托管根推导（唯一入口：health 与 diag 共用；dev = 非绿色包结构）──
interface HostRoots { mac: boolean; liveDir: string; packRoot: string; dataDir: string; isPack: boolean; }

function deriveHostRoots(portableRoot: string): HostRoots {
    const mac = process.platform === 'darwin';
    let liveDir = String(portableRoot || '');
    if (mac) {
        const norm = liveDir.replace(/\\/g, '/');
        const idx = norm.indexOf('.app/Contents/MacOS');
        if (idx >= 0) {
            const bundle = norm.slice(0, idx + 4);
            liveDir = path.join(path.dirname(bundle), 'qqqide-data');
        }
    }
    const packRoot = path.dirname(liveDir);
    const dataDir = path.join(liveDir, 'Data');
    const isPack = mac
        ? _exists(path.join(packRoot, 'qqqide.app'))
        : _exists(path.join(packRoot, 'qqqide.exe'));
    return { mac, liveDir, packRoot, dataDir, isPack };
}

// mtime+size 缓存（设置面板打开期间 15s 轮询 → 未变化文件零重复解析）
const _jsonCache = new Map<string, { key: string; val: any }>();
function _readJsonCached(p: string): any {
    try {
        const st = fs.statSync(p);
        const key = st.mtimeMs + ':' + st.size;
        const hit = _jsonCache.get(p);
        if (hit && hit.key === key) { return hit.val; }
        const val = JSON.parse(fs.readFileSync(p, 'utf8'));
        _jsonCache.set(p, { key, val });
        return val;
    } catch (_) { return null; }
}

export function collectUpdateHealth(portableRoot: string): UpdateHealthSnapshot {
    const snap: UpdateHealthSnapshot = {
        ok: true,
        dev: false,
        mac: process.platform === 'darwin',
        ver: '', launcher: '', status: '', statusTs: 0, statusLine: '',
        fails: 0, stagedReady: false, staged: '', prep: '',
    };
    try {
        // 托管根推导（与 auto-updater / wq-ping 同口径；diag 同源共用 deriveHostRoots）
        const roots = deriveHostRoots(portableRoot);
        const packRoot = roots.packRoot;
        const dataDir = roots.dataDir;
        if (!roots.isPack) { snap.dev = true; return snap; }

        // 当前版本
        const v = _readJsonCached(path.join(roots.liveDir, 'versions.json'));
        if (v) {
            if (typeof v.id === 'string') { snap.ver = v.id.slice(0, 48); }
            if (typeof v.launcher === 'string') { snap.launcher = v.launcher.slice(0, 48); }
        }

        // 最近更新尝试状态（两端同源）
        const s = _readJsonCached(path.join(dataDir, 'updater-status.json'));
        if (s) {
            const r = s.result;
            snap.status = (r === 'ok' || r === 'waiting' || r === 'failed') ? r : '';
            snap.statusTs = Number(s.ts) || 0;
            snap.statusLine = (typeof s.line === 'string') ? s.line.slice(0, 240) : '';
        }

        if (snap.mac) {
            // mac 暂存: {parent}/.update/staged.json
            const st = _readJsonCached(path.join(packRoot, '.update', 'staged.json'));
            if (st && typeof st.version === 'string' && st.version) {
                snap.stagedReady = true;
                snap.staged = st.version.slice(0, 48);
            }
            return snap;
        }

        // Win: 失败计数（交换/应用失败；任何成功清零）
        const n = parseInt(_readText(path.join(packRoot, '.apply-fails')), 10);
        snap.fails = (n > 0 && n <= 99) ? n : 0;

        // Win: 暂存就绪（.swap-ready 内容 = 目标版本；缺失时读 next 清单兜底）
        const swap = path.join(packRoot, '.swap-ready');
        if (_exists(swap)) {
            snap.stagedReady = true;
            snap.staged = _readText(swap).slice(0, 48);
            if (!snap.staged) {
                const nv = _readJson(path.join(packRoot, 'gh555.com-next', 'versions.json'));
                snap.staged = (nv && typeof nv.id === 'string') ? nv.id.slice(0, 48) : '';
            }
        } else {
            // Win: 后台下载/准备中（r.next.meta {v}；仅未暂存时展示）
            const m = _readJsonCached(path.join(packRoot, 'r.next.meta'));
            if (m && typeof m.v === 'string') { snap.prep = m.v.slice(0, 48); }
        }

        return snap;
    } catch (_) {
        // 全字段默认值——绝不影响设置面板渲染
        return snap;
    }
}

// ════════════════════════════════════════════════════════════════════════
// 诊断通道（点击「升级健康位」胶囊消费）——核心失败/更新日志本机尾段只读
// ════════════════════════════════════════════════════════════════════════

export interface UpdateDiagEntry {
    id: string;
    name: string;
    path: string;
    exists: boolean;
    size: number;
    mtimeMs: number;
}

export interface UpdateDiagIndex {
    ok: boolean;
    dev: boolean;
    mac: boolean;
    dataDir: string;
    packRoot: string;
    files: UpdateDiagEntry[];
}

const DIAG_TAIL_BYTES = 16384;   // 单文件尾段上限（IPC 单条 64KB 上限内）

// 9 个核心失败/更新日志（顺序 = 排查优先级）
function _diagTargetList(r: HostRoots): { id: string; name: string; p: string }[] {
    const d = r.dataDir;
    return [
        { id: 'swap', name: 'launcher-swap.log', p: path.join(d, 'launcher-swap.log') },
        { id: 'status', name: 'updater-status.json', p: path.join(d, 'updater-status.json') },
        { id: 'fails', name: '.apply-fails', p: path.join(r.packRoot, '.apply-fails') },
        { id: 'swapready', name: '.swap-ready', p: path.join(r.packRoot, '.swap-ready') },
        { id: 'rnext', name: 'r.next.meta', p: path.join(r.packRoot, 'r.next.meta') },
        { id: 'state', name: 'state-events.log', p: path.join(d, 'alphal', 'state-events.log') },
        { id: 'render', name: 'render-crash.log', p: path.join(d, 'alphal', 'render-crash.log') },
        { id: 'crash', name: 'crash-net/events.log', p: path.join(d, 'alphal', 'crash-net', 'events.log') },
        { id: 'recovery', name: 'crash-net/recovery-report.json', p: path.join(d, 'alphal', 'crash-net', 'recovery-report.json') },
    ];
}

function _statDiag(id: string, name: string, p: string): UpdateDiagEntry {
    let exists = false, size = 0, mtimeMs = 0;
    try {
        const st = fs.statSync(p);
        exists = st.isFile();
        if (exists) { size = st.size; mtimeMs = st.mtimeMs; }
    } catch (_) { /* 不存在 → 零值 */ }
    return { id, name, path: p, exists, size, mtimeMs };
}

function _readTailText(p: string, maxBytes: number): string {
    try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size <= 0) { return ''; }
        const len = Math.min(st.size, maxBytes);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(p, 'r');
        try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
        let text = buf.toString('utf8');
        if (st.size > len) {
            const nl = text.indexOf('\n');
            if (nl >= 0 && nl < text.length - 1) { text = text.slice(nl + 1); }   // 丢弃截断残留的首行
        }
        return text;
    } catch (_) { return ''; }
}

export function collectDiagIndex(portableRoot: string): UpdateDiagIndex {
    const r = deriveHostRoots(portableRoot);
    const files = _diagTargetList(r).map((x) => _statDiag(x.id, x.name, x.p));
    return { ok: true, dev: !r.isPack, mac: r.mac, dataDir: r.dataDir, packRoot: r.packRoot, files };
}

export function collectDiagFile(portableRoot: string, id: string): any {
    const r = deriveHostRoots(portableRoot);
    const hit = _diagTargetList(r).find((x) => x.id === String(id || ''));
    if (!hit) { return { ok: false, error: 'unknown-id' }; }
    const entry = _statDiag(hit.id, hit.name, hit.p);
    const tail = entry.exists ? _readTailText(hit.p, DIAG_TAIL_BYTES) : '';
    return { ok: true, id: entry.id, name: entry.name, path: entry.path, exists: entry.exists, size: entry.size, mtimeMs: entry.mtimeMs, tail };
}

function _pad2(n: number): string { return (n < 10 ? '0' : '') + n; }

// 合成报告落盘（Data/diag/update-diag-*.txt；保留最近 10 份；原子 tmp+rename）
export function writeDiagReport(portableRoot: string): any {
    const r = deriveHostRoots(portableRoot);
    const dir = path.join(r.dataDir, 'diag');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { }
    const d = new Date();
    const stamp = d.getFullYear() + _pad2(d.getMonth() + 1) + _pad2(d.getDate()) + '-' + _pad2(d.getHours()) + _pad2(d.getMinutes()) + _pad2(d.getSeconds());
    const out = path.join(dir, 'update-diag-' + stamp + '.txt');

    const health = collectUpdateHealth(portableRoot);
    const lines: string[] = [];
    lines.push('qqqide diag report — 升级诊断报告');
    lines.push('生成时间: ' + d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate()) + ' ' + _pad2(d.getHours()) + ':' + _pad2(d.getMinutes()) + ':' + _pad2(d.getSeconds()));
    lines.push('平台: ' + process.platform + ' | 当前版本: ' + (health.ver || '-') + ' | 启动器: ' + (health.launcher || '-'));
    lines.push('更新状态: ' + (health.status || '-') + ' | 失败计数: ' + health.fails + ' | 暂存: ' + (health.stagedReady ? health.staged : '-') + ' | 准备中: ' + (health.prep || '-'));
    lines.push('托管根: ' + r.packRoot);
    lines.push('数据目录: ' + r.dataDir);
    lines.push('');

    for (const x of _diagTargetList(r)) {
        const entry = _statDiag(x.id, x.name, x.p);
        lines.push('===== ' + x.name + ' =====');
        lines.push('路径: ' + x.p);
        if (!entry.exists) { lines.push('(不存在)'); lines.push(''); continue; }
        lines.push('大小: ' + entry.size + 'B | 修改: ' + new Date(entry.mtimeMs).toISOString());
        lines.push('');
        lines.push(_readTailText(x.p, DIAG_TAIL_BYTES) || '(空)');
        lines.push('');
    }

    const text = lines.join('\n');
    try {
        const tmp = out + '.tmp';
        fs.writeFileSync(tmp, text, 'utf8');
        try { fs.renameSync(tmp, out); }
        catch (_) { fs.writeFileSync(out, text, 'utf8'); try { fs.unlinkSync(tmp); } catch (_) { } }
    } catch (e) {
        return { ok: false, error: (e && (e as Error).message) || 'write-failed' };
    }

    // 保留最近 10 份（防堆积）
    try {
        const all = fs.readdirSync(dir).filter((f) => f.indexOf('update-diag-') === 0 && f.slice(-4) === '.txt');
        if (all.length > 10) {
            all.sort();
            for (const f of all.slice(0, all.length - 10)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) { } }
        }
    } catch (_) { }

    return { ok: true, path: out };
}

export function registerUpdateHealthIpc(portableRoot: string): void {
    ipcMain.handle('qqqide:update:health', () => collectUpdateHealth(portableRoot));
    ipcMain.handle('qqqide:update:diag', () => collectDiagIndex(portableRoot));
    ipcMain.handle('qqqide:update:diag:file', (_e, id: string) => collectDiagFile(portableRoot, id));
    ipcMain.handle('qqqide:update:diag:report', () => writeDiagReport(portableRoot));
}
