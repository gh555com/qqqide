// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// crash-net.ts — 天罗地网：进程级崩溃记录网（2026-08-08 F14）
// ============================================================================
// 核心公理: 主进程被强杀(taskkill /F / 崩溃)时, JS 来不及执行任何代码。
//   → 一切关键记录必须"周期独立落盘" + "事件即时落盘", 与进程生命周期解耦。
// 产物目录: {userData}/alphal/crash-net/
//   heartbeat.json        每 10s 原子写: pid/内存/全部窗口活动快照(quest/floor/house/state)
//   events.log            NDJSON 事件流: boot/send/house/save/floor-done/render-gone/quit...
//   snapshot-{ts}.json    崩溃瞬间全量快照 (render-process-gone / uncaughtException)
//   clean-quit.json       正常退出标记 (before-quit 刷盘完成时写, app.exit 前)
//   recovery-report.json  下次启动对账: 上次退出 clean/abnormal/first-run + 死前最后事件
// 原则: 单写者(主进程) + append/原子写 + 静默失败(记录本身永不阻塞业务)。

import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const HB_INTERVAL_MS = 10000;      // 心跳周期: 死亡时间下界误差 ±10s
const FLUSH_BATCH = 200;           // events.log 批量落盘阈值(条)
const FLUSH_DEBOUNCE_MS = 1000;    // events.log 兜底落盘间隔
const EVENTS_MAX_BYTES = 8 * 1024 * 1024;

let _dir = '';
let _hbTimer: NodeJS.Timeout | null = null;
let _eventsBuf: string[] = [];
let _flushTimer: NodeJS.Timeout | null = null;
let _cleanQuitMarked = false;
const _activity = new Map<number, any>();   // winId → 渲染层最近活动 {q,f,h,state,detail}

// ── 内部工具 ──

function _ensureDir(): boolean {
    try { fs.mkdirSync(_dir, { recursive: true }); return true; } catch { return false; }
}

function _atomicWrite(name: string, content: string): void {
    try {
        if (!_ensureDir()) return;
        const p = path.join(_dir, name);
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, p);
    } catch {
        try { fs.writeFileSync(path.join(_dir, name), content, 'utf8'); } catch { /* ignore */ }
    }
}

function _procMem(): { rssMB: number; heapMB: number } {
    try {
        const m = process.memoryUsage();
        return { rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576) };
    } catch { return { rssMB: 0, heapMB: 0 }; }
}

function _windowsSnap(): any[] {
    try {
        return BrowserWindow.getAllWindows()
            .filter(w => !w.isDestroyed())
            .map(w => {
                let title = '';
                try { title = w.getTitle(); } catch { /* ignore */ }
                return { winId: w.id, title, activity: _activity.get(w.id) || null };
            });
    } catch { return []; }
}

// ── 事件流 ──

function _appendEvent(kind: string, data: any): void {
    let line: string;
    try { line = JSON.stringify({ ts: Date.now(), kind, ...data }); } catch { return; }
    _eventsBuf.push(line);
    if (_eventsBuf.length >= FLUSH_BATCH) {
        _flushEvents();
    } else if (!_flushTimer) {
        _flushTimer = setTimeout(_flushEvents, FLUSH_DEBOUNCE_MS);
    }
}

function _flushEvents(): void {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (_eventsBuf.length === 0) return;
    const batch = _eventsBuf;
    _eventsBuf = [];
    try {
        if (!_ensureDir()) return;
        const p = path.join(_dir, 'events.log');
        fs.appendFileSync(p, batch.join('\n') + '\n', 'utf8');
        try {
            const st = fs.statSync(p);
            if (st.size > EVENTS_MAX_BYTES) {
                fs.renameSync(p, path.join(_dir, 'events.1.log'));
            }
        } catch { /* ignore */ }
    } catch { /* ignore */ }
}

// ── 心跳 (强杀后唯一痕迹) ──

function _heartbeat(): void {
    _atomicWrite('heartbeat.json', JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        ..._procMem(),
        uptimeSec: Math.round(process.uptime()),
        windows: _windowsSnap(),
    }));
}

// ── 崩溃瞬间快照 ──

export function crashNetSnapshot(reason: string): void {
    _atomicWrite('snapshot-' + Date.now() + '-' + reason + '.json', JSON.stringify({
        ts: Date.now(),
        reason,
        pid: process.pid,
        ..._procMem(),
        uptimeSec: Math.round(process.uptime()),
        windows: _windowsSnap(),
    }, null, 1));
}

// ── 主进程模块事件入口 (window-manager 等调用) ──

export function crashNetLog(evt: any): void {
    if (!evt || typeof evt !== 'object') return;
    _appendEvent(evt.kind || 'event', evt);
}

// ── 正常退出标记 (shutdown.ts 在 app.exit(0) 前调用) ──

export function crashNetMarkCleanQuit(): void {
    if (_cleanQuitMarked) return;
    _cleanQuitMarked = true;
    _appendEvent('quit-clean');
    _flushEvents();
    _atomicWrite('clean-quit.json', JSON.stringify({ ts: Date.now(), pid: process.pid }));
}

// ── 渲染层事件 (IPC: qqqide:crashnet:event) ──

function _handleRendererEvent(winId: number, evt: any): void {
    if (!evt || typeof evt !== 'object') return;
    // 维护该窗口活动快照 → 心跳带出
    const a: any = { ...(_activity.get(winId) || {}) };
    if (evt.q !== undefined) a.q = evt.q;
    if (evt.f !== undefined) a.f = evt.f;
    if (evt.h !== undefined) a.h = evt.h;
    if (evt.state !== undefined) a.state = evt.state;
    if (evt.detail !== undefined) a.detail = evt.detail;
    _activity.set(winId, a);
    _appendEvent('render', { winId, ...evt });
}

// ── 上次退出对账 (重启时调用, 判定死因) ──

function _checkLastExit(): any {
    const report: any = { lastExit: 'first-run' };
    try {
        const hbPath = path.join(_dir, 'heartbeat.json');
        const hbExists = fs.existsSync(hbPath);
        const cleanPath = path.join(_dir, 'clean-quit.json');
        const cleanExists = fs.existsSync(cleanPath);
        const eventsPath = path.join(_dir, 'events.log');

        if (cleanExists) {
            report.lastExit = 'clean';
            try { report.cleanTs = JSON.parse(fs.readFileSync(cleanPath, 'utf8')).ts; } catch { /* ignore */ }
        } else if (hbExists) {
            report.lastExit = 'abnormal';
            try {
                const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
                report.lastHbTs = hb.ts;
                report.lastHbAgeSec = Math.round((Date.now() - hb.ts) / 1000);
                report.lastHbPid = hb.pid;
                report.lastHbMemMB = hb.rssMB;
                report.lastHbWindows = hb.windows || [];
            } catch { /* ignore */ }
        }
        if (fs.existsSync(eventsPath)) {
            try {
                const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
                if (lines.length > 0) {
                    const last = JSON.parse(lines[lines.length - 1]);
                    report.lastEvent = last;
                    report.eventsCount = lines.length;
                    // 倒数 5 条 (供死因链条)
                    report.tailEvents = lines.slice(-5).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return report;
}

// ── 初始化 (main.ts whenReady 最前调用) ──

export function crashNetInit(userData: string): void {
    _dir = path.join(userData, 'alphal', 'crash-net');
    if (!_ensureDir()) return;

    // 上次退出对账 → 控制台 + recovery-report.json
    const report = _checkLastExit();
    try {
        console.log('[crash-net] last exit:', JSON.stringify(report));
    } catch { /* ignore */ }
    _atomicWrite('recovery-report.json', JSON.stringify({ ts: Date.now(), pid: process.pid, report }, null, 1));

    _appendEvent('boot', { pid: process.pid, report });

    // 主进程全局异常 (记录 + 快照, 不退出 — 错误可恢复则继续服务)
    process.on('uncaughtException', (err: any) => {
        _appendEvent('uncaught-exception', { msg: (err && err.message) || String(err) });
        crashNetSnapshot('uncaught-exception');
    });
    process.on('unhandledRejection', (reason: any) => {
        let msg = '';
        try { msg = String((reason && (reason.message || reason)) || reason).slice(0, 500); } catch { /* ignore */ }
        _appendEvent('unhandled-rejection', { msg });
    });

    // GPU/utility 子进程崩溃 (渲染进程崩溃走 window-manager render-process-gone)
    app.on('child-process-gone', (_e, details: any) => {
        _appendEvent('child-gone', {
            type: details && details.type,
            reason: details && details.reason,
            exitCode: details && details.exitCode,
        });
    });

    // 退出轨迹: will-quit 兜底标记 (正常路径 shutdown.ts 会先调 crashNetMarkCleanQuit)
    app.on('before-quit', () => { _appendEvent('quit-begin'); });
    app.on('will-quit', () => {
        crashNetMarkCleanQuit();
    });

    // 心跳
    _hbTimer = setInterval(_heartbeat, HB_INTERVAL_MS);
    _heartbeat();

    // 渲染层事件
    ipcMain.on('qqqide:crashnet:event', (e, evt) => {
        let winId = 0;
        try {
            const win = BrowserWindow.fromWebContents(e.sender);
            winId = win ? win.id : 0;
        } catch { /* ignore */ }
        _handleRendererEvent(winId, evt);
    });
}
