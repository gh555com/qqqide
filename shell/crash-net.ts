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
import * as util from 'util';

const HB_INTERVAL_MS = 10000;      // 心跳周期: 死亡时间下界误差 ±10s
const FLUSH_BATCH = 200;           // events.log 批量落盘阈值(条)
const FLUSH_DEBOUNCE_MS = 1000;    // events.log 兜底落盘间隔
const EVENTS_MAX_BYTES = 8 * 1024 * 1024;

// ── 主进程 console 落盘 (Data/Logs/main.log) ──
const MAIN_LOG_MAX_BYTES = 1024 * 1024;   // main.log 上限 (超出轮转 main.log.old, 合计 2MB)
const MAIN_LOG_FLUSH_MS = 700;            // 缓冲落盘间隔
const MAIN_LOG_MAX_LINE = 4000;           // 单行截断 (防巨型对象打爆日志)
const MAIN_LOG_MAX_BUF = 2000;            // 缓冲行上限

// ── 内存看门狗 (2026-08-20 F51 性能审计落地) ──
const MEM_HISTORY_MS = 5 * 60 * 1000;         // mem.log 历史序列周期 (定位涨速)
const MEM_HISTORY_MAX_BYTES = 256 * 1024;     // mem.log 上限 (events.log 同款轮转)
const MEM_WARN_HEAP_MB = 1024;                // heapUsed 告警阈值（2026-10-02 下调 1536→1024：实测 52h 重窗活堆仅 ~245MB——1GB 已属异常涨势信号，尽早提示刷新释放）
const MEM_WARN_COOLDOWN_MS = 60 * 60 * 1000;  // 告警冷却 (1h 防轰炸)

let _dir = '';
let _hbTimer: NodeJS.Timeout | null = null;
let _memHistoryTimer: NodeJS.Timeout | null = null;
let _lastMemWarnTs = 0;
let _eventsBuf: string[] = [];
let _flushTimer: NodeJS.Timeout | null = null;
let _cleanQuitMarked = false;
const _activity = new Map<number, any>();   // winId → 渲染层最近活动 {q,f,h,state,detail}

// 主进程 console sink 状态
let _conLogDir = '';
let _conBuf: string[] = [];
let _conTimer: NodeJS.Timeout | null = null;
let _conInstalled = false;

// 退出意图来源 (先声明者为准 — 越靠近真因的入口越先声明)
let _quitSrc = '';

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

// ── 主进程 console 落盘 ──
// 背景: 绿色包由启动器 CreateProcessW(无管道) 拉起 → 主进程 console.* 输出全丢,
//   跨模块溯源只能靠散落各处的专用日志。此处挂全局 sink → {Data}/Logs/main.log。
// 纪律: ① 原 console 行为一字不改（原调用照常, 仅就地吞 EPIPE——无控制台时 stdout 断裂）
//       ② 写盘失败恒静默（记录本身永不阻塞/影响业务）③ 环形缓冲+定时刷盘（不逐行 IO）

function _conStamp(): string {
    try {
        const d = new Date();
        const p = (n: number, w?: number) => String(n).padStart(w || 2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
            p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
    } catch { return String(Date.now()); }
}

function _conFlush(): void {
    if (_conTimer) { clearTimeout(_conTimer); _conTimer = null; }
    if (_conBuf.length === 0 || !_conLogDir) return;
    const batch = _conBuf;
    _conBuf = [];
    try {
        fs.mkdirSync(_conLogDir, { recursive: true });
        const p = path.join(_conLogDir, 'main.log');
        fs.appendFileSync(p, batch.join('\n') + '\n', 'utf8');
        try {
            if (fs.statSync(p).size > MAIN_LOG_MAX_BYTES) {
                try { fs.unlinkSync(p + '.old'); } catch { /* ignore */ }
                fs.renameSync(p, p + '.old');
            }
        } catch { /* ignore */ }
    } catch { /* ignore */ }
}

function _conPush(level: string, args: any[]): void {
    try {
        if (_conBuf.length >= MAIN_LOG_MAX_BUF) { _conBuf.splice(0, _conBuf.length - MAIN_LOG_MAX_BUF + 1); }
        let msg = '';
        try {
            // 限深/限长：超大对象参数（帧树/整包快照）不得把主进程拖进字符串拼接
            msg = (util as any).formatWithOptions({ depth: 2, maxArrayLength: 50, maxStringLength: MAIN_LOG_MAX_LINE, breakLength: 120 }, ...args);
        } catch {
            try { msg = util.format.apply(util, args as any); } catch { msg = ''; }
        }
        if (msg.length > MAIN_LOG_MAX_LINE) { msg = msg.slice(0, MAIN_LOG_MAX_LINE) + '…[truncated]'; }
        _conBuf.push('[' + _conStamp() + '] ' + level + ' ' + msg);
        if (!_conTimer) { _conTimer = setTimeout(_conFlush, MAIN_LOG_FLUSH_MS); }
    } catch { /* ignore */ }
}

/** 挂主进程 console 落盘 sink（幂等；日志目录 = {Data}/Logs）。 */
export function installMainLogSink(logsDir: string): void {
    if (_conInstalled || !logsDir) return;
    _conInstalled = true;
    _conLogDir = logsDir;
    const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
    for (const lv of levels) {
        try {
            const orig = (console as any)[lv];
            if (typeof orig !== 'function') continue;
            (console as any)[lv] = function (...args: any[]) {
                try { orig.apply(console, args); } catch { /* 无控制台时 stdout 断裂 — 就地吞, 禁进崩溃台账 */ }
                _conPush(lv, args);
            };
        } catch { /* ignore */ }
    }
    try { process.stdout.on('error', () => { /* ignore */ }); } catch { /* ignore */ }
    try { process.stderr.on('error', () => { /* ignore */ }); } catch { /* ignore */ }
}

// 报告内嵌事件瘦身: 历史 boot 事件里嵌着上一份 report（再嵌 tailEvents…）→ 逐次指数膨胀。
// 只留标量定位字段，禁再嵌结构。
function _slimEvent(e: any): any {
    if (!e || typeof e !== 'object') return null;
    const out: any = { ts: e.ts, kind: e.kind };
    try {
        for (const k of Object.keys(e)) {
            if (k === 'ts' || k === 'kind') continue;
            const v = (e as any)[k];
            if (typeof v === 'string') { out[k] = v.length > 300 ? v.slice(0, 300) + '…' : v; }
            else if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; }
        }
    } catch { /* ignore */ }
    return out;
}

// ── 崩溃摘要（跨重启累计；wq-ping 搭便车上报——只传计数，永不传内容/堆栈）──

const _SUM_KINDS: Record<string, string | undefined> = {
    'uncaught-exception': 'ue',
    'unhandled-rejection': 'ur',
    'child-gone': 'cg',
    'mem-warning': 'mw',
    'render-gone': 'rg',
    'abnormal-exit': 'ab',
};

function _sumPath(): string { return path.join(_dir, 'summary.json'); }

function _sumLoad(): any {
    try {
        const d = JSON.parse(fs.readFileSync(_sumPath(), 'utf8'));
        if (d && typeof d === 'object') {
            const out: any = { ab: 0, rg: 0, ue: 0, ur: 0, cg: 0, mw: 0, last: '', ts: 0 };
            for (const k of ['ab', 'rg', 'ue', 'ur', 'cg', 'mw']) {
                const n = Number(d[k]);
                if (Number.isFinite(n) && n > 0) out[k] = Math.floor(Math.min(n, 1000000));
            }
            if (typeof d.last === 'string') out.last = d.last.slice(0, 40);
            const ts = Number(d.ts);
            if (Number.isFinite(ts) && ts > 0) out.ts = Math.floor(ts);
            return out;
        }
    } catch { /* first run */ }
    return { ab: 0, rg: 0, ue: 0, ur: 0, cg: 0, mw: 0, last: '', ts: 0 };
}

function _sumBump(kind: string): void {
    const key = _SUM_KINDS[kind];
    if (!key) return;
    const s = _sumLoad();
    s[key] = Math.min((s[key] || 0) + 1, 1000000);
    s.last = kind;
    s.ts = Date.now();
    _atomicWrite('summary.json', JSON.stringify(s));
}

/** 崩溃摘要快照（wq-ping 搭便车；n=总事件数；无数据返回 null）。只含计数与最后事件类型，永不传内容。 */
export function crashNetSummary(): Record<string, number> | null {
    try {
        const s = _sumLoad();
        const n = s.ab + s.rg + s.ue + s.ur + s.cg + s.mw;
        if (n <= 0) return null;
        return { n, ab: s.ab, rg: s.rg, ue: s.ue, ur: s.ur, cg: s.cg, mw: s.mw, t: Math.floor((s.ts || 0) / 1000) };
    } catch { return null; }
}

// ── 事件流 ──

function _appendEvent(kind: string, data: any = {}): void {
    let line: string;
    try { line = JSON.stringify({ ts: Date.now(), kind, ...data }); } catch { return; }
    _eventsBuf.push(line);
    if (_SUM_KINDS[kind]) { try { _sumBump(kind); } catch { /* ignore */ } }
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
    _maybeWarnMem();   // 内存告警检查挂心跳 (mem 已取, 零额外开销)
}

// ── 内存看门狗 ──

function _appendMemHistory(): void {
    try {
        if (!_ensureDir()) return;
        const m = process.memoryUsage();
        const line = JSON.stringify({
            ts: Date.now(),
            rssMB: Math.round(m.rss / 1048576),
            heapMB: Math.round(m.heapUsed / 1048576),
            heapTotalMB: Math.round(m.heapTotal / 1048576),
            externalMB: Math.round(m.external / 1048576),
        });
        const p = path.join(_dir, 'mem.log');
        fs.appendFileSync(p, line + '\n', 'utf8');
        try {
            const st = fs.statSync(p);
            if (st.size > MEM_HISTORY_MAX_BYTES) fs.renameSync(p, path.join(_dir, 'mem.1.log'));
        } catch { /* ignore */ }
    } catch { /* ignore */ }
}

function _maybeWarnMem(): void {
    try {
        const m = process.memoryUsage();
        const heapMB = Math.round(m.heapUsed / 1048576);
        if (heapMB < MEM_WARN_HEAP_MB) return;
        const now = Date.now();
        if (now - _lastMemWarnTs < MEM_WARN_COOLDOWN_MS) return;
        _lastMemWarnTs = now;
        const payload = { heapMB, rssMB: Math.round(m.rss / 1048576) };
        _appendEvent('mem-warning', payload);
        for (const w of BrowserWindow.getAllWindows()) {
            try { if (!w.isDestroyed()) w.webContents.send('qqqide:mem:warning', payload); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
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

/** 声明退出意图来源（quit-all-ipc / window-all-closed / signal-sigint / second-instance / forced-update / mac-update…）。
 *  先声明者为准：异常退出时 clean-quit 缺失，此标签串在最后一刻的 quit-begin 事件里，直接给出真因。 */
export function crashNetNoteQuitSource(src: string): void {
    try {
        if (!src || _quitSrc) return;
        _quitSrc = String(src).slice(0, 48);
    } catch { /* ignore */ }
}

export function crashNetMarkCleanQuit(from?: string): void {
    if (_cleanQuitMarked) return;
    _cleanQuitMarked = true;
    const src = _quitSrc || '';
    _appendEvent('quit-clean', { src, from: from || '' });
    _flushEvents();
    _atomicWrite('clean-quit.json', JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        src,
        from: from || '',
        uptimeSec: Math.round(process.uptime()),
    }));
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
            try {
                const cq = JSON.parse(fs.readFileSync(cleanPath, 'utf8'));
                report.cleanTs = cq.ts;
                report.cleanSrc = cq.src || '';
                report.cleanFrom = cq.from || '';
                if (cq.uptimeSec) report.cleanUptimeSec = cq.uptimeSec;
            } catch { /* ignore */ }
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
                    report.eventsCount = lines.length;
                    // 倒数 5 条 (供死因链条) — 必须瘦身: 历史 boot 事件内嵌上一份 report = 指数膨胀
                    report.tailEvents = lines.slice(-5).map(l => { try { return _slimEvent(JSON.parse(l)); } catch { return null; } }).filter(Boolean);
                    if (report.tailEvents.length > 0) { report.lastEvent = report.tailEvents[report.tailEvents.length - 1]; }
                }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return report;
}

// ── 初始化 (main.ts whenReady 最前调用) ──

export function crashNetInit(userData: string): void {
    // ★ 主进程 console 落盘最先挂（其后一切 console 输出均入 Data/Logs/main.log）
    try { installMainLogSink(path.join(userData, 'Logs')); } catch { /* ignore */ }
    _dir = path.join(userData, 'alphal', 'crash-net');
    if (!_ensureDir()) return;

    // 上次退出对账 → 控制台 + recovery-report.json
    const report = _checkLastExit();
    try {
        console.log('[crash-net] last exit:', JSON.stringify(report));
    } catch { /* ignore */ }
    _atomicWrite('recovery-report.json', JSON.stringify({ ts: Date.now(), pid: process.pid, report }, null, 1));

    // ★ 异常退出计数（跨重启累计摘要；供 wq-ping 稳定性遥测搭便车）
    if (report.lastExit === 'abnormal') { try { _sumBump('abnormal-exit'); } catch { /* ignore */ } }

    _appendEvent('boot', { pid: process.pid, report });

    // 主进程全局异常 (记录 + 快照, 不退出 — 错误可恢复则继续服务)
    process.on('uncaughtException', (err: any) => {
        const _m = String((err && err.message) || err || '');
        // stdout 断裂（无控制台时 console 写入）不是崩溃: 吞掉, 禁污染崩溃台账/快照/遥测计数
        if (_m.indexOf('EPIPE') >= 0 || _m.indexOf('broken pipe') >= 0 || _m.indexOf('ECONNRESET') >= 0) return;
        _appendEvent('uncaught-exception', { msg: _m });
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
    app.on('before-quit', () => {
        _appendEvent('quit-begin', { src: _quitSrc || '', wins: _windowsSnap().length });
        _conFlush();
    });
    app.on('will-quit', () => {
        _conFlush();
        crashNetMarkCleanQuit('will-quit');
    });

    // 心跳
    _hbTimer = setInterval(_heartbeat, HB_INTERVAL_MS);
    _heartbeat();

    // 内存看门狗: 5min 历史序列 (告警检查挂 10s 心跳)
    _memHistoryTimer = setInterval(_appendMemHistory, MEM_HISTORY_MS);
    _appendMemHistory();

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
