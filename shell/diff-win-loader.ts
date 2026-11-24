// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// diff-win-loader.ts — diff 类独立窗口「底座 URL 解析 + 亮相/加载」唯一机器
//   消费方：ipc-timeline.ts（时间线 diff 窗）· ipc-git-diff.ts（git diff 窗）
//
// 铁律（改前必读）：
//   ① 底座 URL 从「发送方窗口当前 URL」推导（机器真相）——它能加载，diff 窗就一定能加载。
//      禁 existsSync 猜测：猜错（进程内协议未注册）＝ ERR_UNKNOWN_URL_SCHEME，
//      表现为「点击 A4 出不来 / 像哑巴」，且只在部分机器上出现。
//   ② 亮相时机 = dom-ready（页面内联样式已生效、窗口骨架已成形），禁等 did-finish-load。
//      慢机（杀软扫描 / 机械盘 / 大项目）整页 load 可超 15s；旧实现在超时后 stop()+重试，
//      每次都把正在跑的加载掐断 → 永远打不开。
//   ③ 超时绝不打断加载（交给页面自己跑完）；只有「真失败」（main frame did-fail-load /
//      渲染进程崩溃 / loadURL reject）才换下一个底座，且同一底座最多重试 2 次。
//      永久错（未知协议/文件不存在/无权限/域名解析失败）不重试——空等 400ms 纯浪费。
//   ④ 全链留痕 Data/Logs/diff-open.log（256KB 截断）——客户现场唯一可回收的证据。
//      日志必须异步串行写：主进程上的同步 fs 会卡整个 UI/IPC 事件循环。
//   ⑤ 开销上限硬定：同时存活的 diff 窗 ≤ DIFF_WIN_LRU_MAX=6（超出关最久未用）；
//      预热种子常驻最多 1 枚（闲置 SEED_IDLE_MAX_MS 自毁、父窗关闭/退出即毁）。
//      加载链本身零长驻（每次加载自建自拆监听）。
// ============================================================================

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getDataDir } from './portable-paths';
import { registerWebappProtocol, WEBAPP_PROTOCOL } from './boot';

const DIFF_WIN_LRU_MAX = 6;        // 同时存活的 diff 窗上限（超出即关掉最久未用的那个）
const SEED_IDLE_MAX_MS = 30 * 60000; // 预热种子闲置超时（到点销毁，释放内存）

const ATTEMPT_TIMEOUT_MS = 12000;   // 单底座单次观察窗（dom-ready 的正常量级 = 100ms 级）
const FORCE_SHOW_MS = 8000;         // 连 dom-ready 都不来 → 强制亮相（禁哑巴）
const RETRY_MAX = 2;                // 同一底座真失败重试次数
const LOG_MAX_BYTES = 256 * 1024;   // 日志单文件上限（超出即清空重写）

// 永久错（重试无意义）：-300 非法 URL / -302 未知协议 / -6 文件不存在 / -10 无权限 / -105 域名解析失败
const PERMANENT_FAIL = new Set<number>([-300, -302, -6, -10, -105]);

// ── 现场日志：异步串行（禁同步 fs 卡主进程事件循环）──
let _logDirResolved = false;
let _logDir = '';
let _logQueue: string[] = [];
let _logFlushing = false;
let _logBytes = -1;                 // -1 = 未知（首次写时读一次真实大小）

/** 追加一行现场日志（Data/Logs/diff-open.log，256KB 截断轮转）。 */
export function diffOpenLog(tag: string, line: string): void {
    const row = new Date().toISOString() + ' [' + tag + '] ' + line;
    try { console.log('[diff-open] ' + row); } catch (_) { /* ignore */ }
    _logQueue.push(row + '\n');
    if (_logQueue.length > 500) { _logQueue.splice(0, _logQueue.length - 500); }   // 无底堆积防线
    void _flushLog();
}

async function _flushLog(): Promise<void> {
    if (_logFlushing) { return; }
    _logFlushing = true;
    try {
        if (!_logDirResolved) {
            _logDirResolved = true;
            try {
                _logDir = path.join(getDataDir(), 'Logs');
                await fs.promises.mkdir(_logDir, { recursive: true });
            } catch (_) { _logDir = ''; }
        }
        if (!_logDir) { _logQueue.length = 0; return; }
        const file = path.join(_logDir, 'diff-open.log');
        while (_logQueue.length) {
            const chunk = _logQueue.join('');
            _logQueue.length = 0;
            try {
                if (_logBytes < 0) {
                    try { _logBytes = (await fs.promises.stat(file)).size; } catch (_) { _logBytes = 0; }
                }
                if (_logBytes > LOG_MAX_BYTES) {
                    await fs.promises.writeFile(file, '');
                    _logBytes = 0;
                }
                await fs.promises.appendFile(file, chunk);
                _logBytes += chunk.length;
            } catch (_) { /* 日志失败绝不干扰打开链 */ }
        }
    } catch (_) { /* ignore */ } finally { _logFlushing = false; }
}

/** 从 URL 反推 webapp 底座（含 /qqqide/ 的那一层）；推不出返回 ''。 */
export function diffBaseFromUrl(cur: string): string { return _baseFromUrl(cur); }

function _baseFromUrl(cur: string): string {
    if (!cur) return '';
    const idx = cur.indexOf('/qqqide/');
    if (idx === -1) return '';
    let u: URL;
    try { u = new URL(cur); } catch (_) { return ''; }
    const proto = u.protocol;
    if (proto !== 'http:' && proto !== 'https:' && proto !== WEBAPP_PROTOCOL + ':') return '';
    const pIdx = u.pathname.indexOf('/qqqide/');
    if (pIdx === -1) return '';
    return proto + '//' + u.host + u.pathname.slice(0, pIdx) + '/qqqide/';
}

/**
 * 底座 URL 解析（唯一入口）。
 * 顺序：① 发送方窗口当前 URL（真相）② 本地运行副本（显式注册协议）③ 远端。
 */
export function resolveDiffBaseUrl(refWin: BrowserWindow | null, bootConfig: { url?: string }): string {
    try {
        if (refWin && !refWin.isDestroyed()) {
            const b = _baseFromUrl(refWin.webContents.getURL() || '');
            if (b) return b;
        }
    } catch (_) { /* ignore */ }
    try {
        const localDir = path.join(getDataDir(), 'webapp');
        if (fs.existsSync(path.join(localDir, 'index.html'))) {
            registerWebappProtocol(localDir);   // ★ 只拼 URL 不注册 = 必死（ERR_UNKNOWN_URL_SCHEME）
            return WEBAPP_PROTOCOL + '://app/qqqide/';
        }
    } catch (_) { /* ignore */ }
    const remote = String((bootConfig && bootConfig.url) || '').replace(/\/*$/, '/');
    return remote;
}

/** 底座候选列表（主 + 备用）：主打不开时逐个降级，不让单点环境猜错毁掉整条打开链。 */
export function resolveDiffBases(refWin: BrowserWindow | null, bootConfig: { url?: string }): string[] {
    const out: string[] = [];
    const push = (b: string) => { if (b && out.indexOf(b) === -1) out.push(b); };
    push(resolveDiffBaseUrl(refWin, bootConfig));
    const remote = String((bootConfig && bootConfig.url) || '').replace(/\/*$/, '/');
    push(remote);
    try {
        const localDir = path.join(getDataDir(), 'webapp');
        if (fs.existsSync(path.join(localDir, 'index.html'))) {
            registerWebappProtocol(localDir);
            push(WEBAPP_PROTOCOL + '://app/qqqide/');
        }
    } catch (_) { /* ignore */ }
    return out;
}

// ══════════════════════════════════════════════════════════════════════════
// LRU：diff 窗同时存活上限（禁无限堆积渲染进程）
//   记账时机 = 新建完成 / 点击复用；超出上限 → destroy 最久未用的那个
//   （destroy 会触发 closed，各 IPC 模块的 closed 钩子自行清 map）
// ══════════════════════════════════════════════════════════════════════════
const _lruWins: BrowserWindow[] = [];

export function diffWinTouch(win: BrowserWindow): void {
    if (!win || win.isDestroyed()) return;
    const i = _lruWins.indexOf(win);
    if (i !== -1) _lruWins.splice(i, 1);
    _lruWins.push(win);
    while (_lruWins.length > DIFF_WIN_LRU_MAX) {
        const victim = _lruWins.shift();
        if (!victim || victim.isDestroyed()) continue;
        diffOpenLog('lru', 'evict win=' + victim.id + ' (max=' + DIFF_WIN_LRU_MAX + ')');
        try { victim.destroy(); } catch (_) { /* ignore */ }
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 回收式预热种子（唯一入口）
//   关窗 ≠ 销毁：把窗隐藏并导航回「无参数预热页」——渲染进程 + V8 隔离 + 已编译
//   脚本缓存全部留着（实测：再开 50~110ms，冷开 540ms），内存回落到 ~74MB
//   （真实使用态 139MB / 全新壳 32MB）。只留一枚；闲置 30min 或父窗关闭即销毁。
// ══════════════════════════════════════════════════════════════════════════
let _seedWin: BrowserWindow | null = null;
let _seedTimer: any = null;
let _appQuitting = false;
try { app.on('before-quit', () => { _appQuitting = true; killDiffSeed('quit'); }); } catch (_) { /* ignore */ }

function killDiffSeed(why: string): void {
    if (_seedTimer) { try { clearTimeout(_seedTimer); } catch (_) { /* ignore */ } _seedTimer = null; }
    const w = _seedWin;
    _seedWin = null;
    if (w && !w.isDestroyed()) {
        diffOpenLog('seed', 'destroy (' + why + ') win=' + w.id);
        try { w.destroy(); } catch (_) { /* ignore */ }
    }
}

/** 取走预热种子（取走即失效；返回 null = 没有可用种子，调用方走冷开）。 */
export function takeDiffSeed(): BrowserWindow | null {
    const w = _seedWin;
    _seedWin = null;
    if (_seedTimer) { try { clearTimeout(_seedTimer); } catch (_) { /* ignore */ } _seedTimer = null; }
    if (!w) return null;
    if (w.isDestroyed()) { diffOpenLog('seed', 'stale（已销毁）'); return null; }
    diffOpenLog('seed', 'take win=' + w.id);
    return w;
}

/**
 * 把即将关闭的 diff 窗回收成预热种子（在 'close' 事件里调；返回 true = 已回收，调用方必须 preventDefault）。
 * onRecycled：调用方清自己的 map / 摘自己挂的监听（本函数随后会调 win.__qqqDetach）。
 */
export function recycleDiffWindowToSeed(win: BrowserWindow, tag: string, onRecycled: () => void): boolean {
    if (_appQuitting || !win || win.isDestroyed()) return false;
    if (_seedWin && !_seedWin.isDestroyed()) return false;      // 只留一枚种子
    const par = win.getParentWindow();
    if (par && (par as any).__qqqCloseBypass) return false;      // 父窗正在退出 → 正常关闭
    let prewarmUrl = '';
    try {
        const cur = win.webContents.getURL() || '';
        const marker = '/timeline/diff-window.html';
        const idx = cur.indexOf(marker);
        if (idx !== -1) { prewarmUrl = cur.slice(0, idx + marker.length) + '?theme=dark'; }
    } catch (_) { /* ignore */ }
    if (!prewarmUrl) return false;
    try {
        _seedWin = win;
        // 种子不占 LRU 活跃名额（它不是用户正在用的窗）
        const _li = _lruWins.indexOf(win);
        if (_li !== -1) _lruWins.splice(_li, 1);
        try { const d = (win as any).__qqqDetach; if (typeof d === 'function') d(); } catch (_) { /* ignore */ }
        onRecycled();
        win.hide();
        win.setParentWindow(null);
        win.webContents.loadURL(prewarmUrl).catch(() => { /* 预热页失败不影响下次冷开 */ });
        diffOpenLog(tag, 'recycle→seed win=' + win.id + ' url=' + prewarmUrl);
        // 监听只装一次：种子可被反复「回收 → 唤醒 → 再用」，每轮重装会累积监听（MaxListeners 噪声）
        if (!(win as any).__qqqSeedClosedWired) {
            (win as any).__qqqSeedClosedWired = true;
            win.once('closed', () => { if (_seedWin === win) _seedWin = null; });
        }
        // 父窗关闭 → 立即销毁种子；换父前先摘旧监听（跨父窗不堆积）
        const _prevPar: any = (win as any).__qqqSeedPar;
        if (_prevPar && _prevPar.win && !_prevPar.win.isDestroyed()) {
            try { _prevPar.win.removeListener('closed', _prevPar.h); } catch (_) { /* ignore */ }
        }
        (win as any).__qqqSeedPar = null;
        if (par && !par.isDestroyed()) {
            const _h = () => { if (_seedWin === win) killDiffSeed('parent-closed'); };
            par.once('closed', _h);
            (win as any).__qqqSeedPar = { win: par, h: _h };
        }
        _seedTimer = setTimeout(() => { if (_seedWin === win) killDiffSeed('idle'); }, SEED_IDLE_MAX_MS);
        if (_seedTimer && _seedTimer.unref) _seedTimer.unref();
        return true;
    } catch (e: any) {
        _seedWin = null;
        diffOpenLog(tag, 'recycle failed ' + ((e && e.message) || e));
        return false;
    }
}

// 页面真就位判定：dom-ready 已到（!= Chromium 错误页）+ URL 停在目标页
// （单看 getURL 不行——加载失败时它也会回失败目标 URL，会把错误页当成功）
function _pageLanded(win: BrowserWindow, okSubstr: string, domSeen: boolean): boolean {
    if (!domSeen) return false;
    try {
        if (win.isDestroyed()) return false;
        const cur = win.webContents.getURL() || '';
        return okSubstr ? cur.indexOf(okSubstr) !== -1 : !!cur;
    } catch (_) { return false; }
}

/** 单次加载观察：'ready' = dom-ready 已到（可亮相）/ 'fail:CODE' / 'gone' / 'timeout'。 */
function _attemptLoad(win: BrowserWindow, url: string, tag: string): Promise<string> {
    return new Promise<string>((resolve) => {
        const wc = win.webContents;
        let settled = false;
        let timer: any = null;
        const finish = (v: string) => {
            if (settled) return;
            settled = true;
            if (timer) { try { clearTimeout(timer); } catch (_) { /* ignore */ } }
            try { wc.removeListener('dom-ready', onReady); } catch (_) { /* ignore */ }
            try { wc.removeListener('did-fail-load', onFail); } catch (_) { /* ignore */ }
            try { wc.removeListener('render-process-gone', onGone); } catch (_) { /* ignore */ }
            resolve(v);
        };
        const onReady = () => finish('ready');
        const onFail = (_e: any, code: number, desc: string, _url: string, isMainFrame: boolean) => {
            if (!isMainFrame) return;
            // -3 = ERR_ABORTED：被后续导航/页面自刷新顶掉（非真失败）——继续等 dom-ready，禁误判重试
            if (code === -3) { diffOpenLog(tag, 'did-fail-load -3 (aborted，忽略)'); return; }
            diffOpenLog(tag, 'did-fail-load code=' + code + ' desc=' + desc);
            finish('fail:' + code);
        };
        const onGone = (_e: any, details: any) => {
            diffOpenLog(tag, 'render-process-gone ' + JSON.stringify(details || {}));
            finish('gone');
        };
        timer = setTimeout(() => finish('timeout'), ATTEMPT_TIMEOUT_MS);
        wc.on('dom-ready', onReady);
        wc.on('did-fail-load', onFail);
        wc.on('render-process-gone', onGone);
        try {
            const p: any = wc.loadURL(url);
            if (p && typeof p.catch === 'function') {
                p.catch((err: any) => {
                    diffOpenLog(tag, 'loadURL reject ' + ((err && err.message) || err));
                    finish('fail:reject');
                });
            }
        } catch (e: any) {
            diffOpenLog(tag, 'loadURL threw ' + ((e && e.message) || e));
            finish('fail:throw');
        }
    });
}

/**
 * 加载 + 亮相（唯一入口）。
 * 返回 ok:true 表示窗口已可见并停在目标页面；ok:false 由调用方销毁窗口并如实提示。
 */
export async function loadDiffPage(
    win: BrowserWindow,
    bases: string[],
    urlFor: (base: string) => string,
    okSubstr: string,
    tag: string,
): Promise<{ ok: boolean; error?: string; base?: string }> {
    let shown = false;
    const showNow = (why: string) => {
        if (shown) return;
        shown = true;
        diffOpenLog(tag, 'show (' + why + ')');
        try {
            if (!win.isDestroyed()) {
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
            }
        } catch (_) { /* ignore */ }
    };
    const forceShow = setTimeout(() => showNow('force-' + FORCE_SHOW_MS + 'ms'), FORCE_SHOW_MS);
    // dom-ready 实战信号（跨尝试保留）：只有真解析过的页面才算「已就位」
    let domSeen = false;
    const onGlobalReady = () => { domSeen = true; };
    try { win.webContents.on('dom-ready', onGlobalReady); } catch (_) { /* ignore */ }

    let lastErr = 'load-failed';
    try {
        const list = (bases || []).filter(Boolean);
        for (let bi = 0; bi < list.length; bi++) {
            const base = list[bi];
            const url = urlFor(base);
            for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
                diffOpenLog(tag, 'load base=' + base + ' attempt=' + attempt + ' url=' + url);
                const r = await _attemptLoad(win, url, tag);
                if (r === 'ready') { showNow('dom-ready ' + base); return { ok: true, base }; }
                if (r === 'gone') { return { ok: false, error: 'renderer-gone' }; }
                lastErr = r;
                if (r === 'timeout') {
                    // 慢加载：绝不掐断重试——页面已就位就按成功算（窗口随后自己画完）
                    if (_pageLanded(win, okSubstr, domSeen)) { showNow('landed-slow ' + base); return { ok: true, base }; }
                    break;   // 换下一个底座
                }

                // 永久错（未知协议/文件不存在/无权限/解析失败）：换底座，禁空等重试
                if (r.indexOf('fail:') === 0 && PERMANENT_FAIL.has(Number(r.slice(5)))) {
                    diffOpenLog(tag, 'permanent code=' + r.slice(5) + ' → 直接换底座');
                    break;
                }
                // 真失败（可能是瞬时）：同底座重试一次，仍失败则换底座
                if (attempt < RETRY_MAX) { await new Promise((r2) => setTimeout(r2, 400)); continue; }
                break;
            }
            if (_pageLanded(win, okSubstr, domSeen)) { showNow('landed-alt ' + base); return { ok: true, base }; }
        }
        // 停在「慢加载」且已无底座可换：窗口已可见 → 绝不销毁（禁掐断正在跑的加载）
        if (lastErr === 'timeout' && shown) {
            diffOpenLog(tag, 'keep-slow（仍在加载，保留窗口不掐断）');
            return { ok: true, error: 'slow' };
        }
        // 全底座失败：窗口若已可见且停在目标页 → 保留（用户看得到就没必要销毁）
        if (shown && _pageLanded(win, okSubstr, domSeen)) {
            diffOpenLog(tag, 'soft-ok visible+url-matched lastErr=' + lastErr);
            return { ok: true, error: lastErr };
        }
        diffOpenLog(tag, 'FAIL lastErr=' + lastErr);
        return { ok: false, error: lastErr };
    } finally {
        try { clearTimeout(forceShow); } catch (_) { /* ignore */ }
        try { win.webContents.removeListener('dom-ready', onGlobalReady); } catch (_) { /* ignore */ }
    }
}
