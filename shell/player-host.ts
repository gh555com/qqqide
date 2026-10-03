// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// player-host.ts — 播放器宿主域（--qqqide-play）传输层与生命周期
//
// ★ 单宿主域（2026-10-02 q319 定案）：一切播放器窗只存在于宿主进程（joker.exe --qqqide-play）——
//   IDE 进程不再自建播放器窗；Q 键/右键加入/恢复均经「请求队列」（文件系统即 IPC，squads.json
//   同款模式）转发给宿主；双击媒体文件 = 文件关联直启宿主（或转发给在跑宿主）。
//   进程域隔离：宿主 userData = Data/player-host（独立 SingletonLock，与 IDE 互不夺锁——
//   见 portable-paths.applyPortablePaths(sessionDir)）。IDE 退出/崩溃与播放无关；
//   宿主最后一个播放器窗关闭 → 温水滞留（IDE 存活期恒温——ide-alive 心跳续期；IDE 退出/崩溃后按温水期真退）。
//   宿主自恢复：启动时把「上次未关闭」的会话原样拉起（暂停态；host.json 失活 = 崩溃/重启后）。
//   编队独立：宿主自拉起 py-broker（互斥量让位设计——与 IDE 同跑时自动降级 rename-only，
//   IDE 不在时成为热键监听者）→ 无 IDE 也能量招募回。
//   不检查更新（更新是 IDE/启动器职责——宿主不跑 auto-updater/强制更新弹窗）。
//
// 契约文件（Data/player-host/）:
//   host.json      宿主存活心跳 {pid, ts, ver}（4s 刷；IDE 侧 15s 失活 + pid 存活双条件判定）
//   requests/      请求队列目录（IDE 写 req-*；宿主 rename 认领 processing-* 处理后删；
//                  reply 请求回写 res-<id>.json 供 IDE 轮询）
//   ide-alive.json IDE 存活心跳 {pid, ts}（IDE 主进程 60s 刷；宿主滞留到期读——存活即续期＝常温）
//   reveals/       「Roam 定位」跨进程通道（宿主写 req-*；IDE 认领 processing-* 投递后写 ack-*——详下方机器头注释）
// ============================================================================
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './portable-paths';
import { pickRevealWindowId, revealReqStale } from './player-reveal';

let _mode: boolean | null = null;
/** 本进程是否为播放器宿主域（--qqqide-play；含 --qqqide-play= 前缀式）。 */
export function isPlayerHostMode(): boolean {
    if (_mode === null) {
        _mode = process.argv.some((a) => a === '--qqqide-play' || a.indexOf('--qqqide-play=') === 0);
    }
    return _mode;
}

export function playerHostDataDir(): string { return path.join(getDataDir(), 'player-host'); }
export function playerHostReqDir(): string { return path.join(playerHostDataDir(), 'requests'); }
function _stateFile(): string { return path.join(playerHostDataDir(), 'host.json'); }

// ── 存活心跳（宿主写 / IDE 读） ──
export function readPlayerHostState(): { pid: number; ts: number } | null {
    try {
        const o = JSON.parse(fs.readFileSync(_stateFile(), 'utf8'));
        if (o && typeof o.pid === 'number' && typeof o.ts === 'number') { return o; }
    } catch { /* 无文件/损坏 */ }
    return null;
}
export function playerHostAlive(): boolean {
    const st = readPlayerHostState();
    if (!st) { return false; }
    if (Date.now() - st.ts > 15000) { return false; }   // 心跳过期（崩溃/被杀）
    try { process.kill(st.pid, 0); } catch { return false; }   // pid 存活校验（防陈旧文件 + pid 复用）
    return true;
}
function _writeHostState(): void {
    try {
        const f = _stateFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = f + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now(), ver: 1 }), 'utf8');
        fs.renameSync(tmp, f);
    } catch { /* 下次再写 */ }
}
export function clearPlayerHostState(): void {
    try { fs.unlinkSync(_stateFile()); } catch { /* ignore */ }
}

// ── IDE 存活心跳（IDE 写 / 宿主读；2026-10-02 v19 常温） ──
//   语义：IDE 存活 ⇒ 宿主零窗不真退（温水到期续期＝全程恒温秒开，免「每 IDE 会话一次冷启」）；
//   IDE 退出/崩溃 ⇒ 心跳断供（ts 陈旧或 pid 亡）⇒ 宿主按温水期正常退。IDE 主进程启动即起 60s 续写。
function _ideAliveFile(): string { return path.join(playerHostDataDir(), 'ide-alive.json'); }
export function writeIdeKeepalive(): void {
    try {
        const f = _ideAliveFile();
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = f + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');
        fs.renameSync(tmp, f);
    } catch { /* 下次再写 */ }
}
let _ideKeepaliveTimer: any = null;
/** IDE 域启动调用（宿主域 no-op）：先写一次 + 60s 续写——宿主温水期据此续期。 */
export function startIdeKeepalive(): void {
    if (isPlayerHostMode()) { return; }
    if (_ideKeepaliveTimer) { return; }
    writeIdeKeepalive();
    _ideKeepaliveTimer = setInterval(writeIdeKeepalive, 60000);
    if (typeof (_ideKeepaliveTimer as any).unref === 'function') { (_ideKeepaliveTimer as any).unref(); }
}
/** 宿主域读：IDE 心跳新鲜？（ts ≤180s + pid 存活双条件——IDE 崩溃即断供；EPERM 视为存活防误杀） */
export function ideKeepaliveFresh(): boolean {
    try {
        const o = JSON.parse(fs.readFileSync(_ideAliveFile(), 'utf8'));
        if (!o || typeof o.ts !== 'number') { return false; }
        if (Date.now() - o.ts > 180000) { return false; }
        if (typeof o.pid === 'number' && o.pid > 0) {
            try { process.kill(o.pid, 0); } catch (e: any) { if (!e || e.code !== 'EPERM') { return false; } }
        }
        return true;
    } catch { return false; }
}

// ── IDE 侧：拉起宿主（detached 子进程；失活检查 + 2.5s 静默窗防连发） ──
let _lastSpawnAt = 0;
export function ensurePlayerHostAlive(): boolean {
    if (playerHostAlive()) { return true; }
    const now = Date.now();
    if (now - _lastSpawnAt < 2500) { return false; }
    _lastSpawnAt = now;
    // ★ 宿主日志（2026-10-02 v17 补）：宿主 stdout/stderr → Data/Logs/player-host.log（256KB 轮转截断）——
    //   宿主是长期组件，stdio:'ignore' 会让崩溃/异常/拉起过程全瞎（唯一现场 = 本文件）。
    let logFd: number | undefined;
    try {
        const logFile = path.join(getDataDir(), 'Logs', 'player-host.log');
        try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* ignore */ }
        try { const st = fs.statSync(logFile); if (st.size > 262144) { fs.writeFileSync(logFile, ''); } } catch { /* 无文件 */ }
        logFd = fs.openSync(logFile, 'a');
    } catch { logFd = undefined; }
    try {
        const isDev = process.argv.includes('--dev') || process.env.QQQIDE_DEV === '1';
        const args: string[] = app.isPackaged ? ['--qqqide-play'] : [app.getAppPath(), '--qqqide-play'];
        if (isDev) { args.push('--dev'); }
        const child = spawn(process.execPath, args, {
            detached: true,           // 脱离 IDE 进程组——IDE 退出与播放无关
            stdio: (logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore') as any,
            windowsHide: false,
            cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
        });
        child.unref();
        return true;
    } catch (e: any) {
        console.warn('[player-host] spawn failed:', (e && e.message) || e);
        return false;
    } finally {
        if (logFd !== undefined) { try { fs.closeSync(logFd); } catch { /* ignore */ } }   // fd 已 dup 给子进程，父侧即关防泄漏
    }
}

// ── 宿主被激活（mac dock / 无文档 open）且无 IDE 实例 → 拉起 IDE（2026-10-03） ──
//   mac 单实例语义：宿主在跑时 open app 只会 activate——没有本机制则「双击媒体→播放器」状态
//   下用户点图标回不去 IDE。对齐 Windows「图标=IDE」。判活 = ps 扫描（精确：同 bundle、
//   非 --qqqide-play、排除自身）；activate 属低频事件，异步 ps 零热路径开销。
//   启动护窗 2.5s：宿主冷启自带的 launch-activate 不参与（此刻交接 IDE 尚在，ps 本会命中，双保险）。
const _hostT0 = Date.now();
let _lastIdeSpawnAt = 0;
export function ensureIdeInstance(): void {
    if (!isPlayerHostMode() || process.platform !== 'darwin') { return; }
    const now = Date.now();
    if (now - _hostT0 < 2500) { return; }              // 启动护窗（launch-activate 不算用户意图）
    if (now - _lastIdeSpawnAt < 3000) { return; }      // 防连发
    _lastIdeSpawnAt = now;
    try {
        execFile('/bin/ps', ['-axww', '-o', 'pid=,command='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
            try {
                const self = process.pid;
                const exe = String(process.execPath || '').replace(/\\/g, '/');
                for (const ln of String(stdout || '').split('\n')) {
                    const m = ln.match(/^\s*(\d+)\s+(.*)$/);
                    if (!m) { continue; }
                    if (parseInt(m[1], 10) === self) { continue; }
                    const cmd = m[2];
                    if (cmd.indexOf(exe) !== 0) { continue; }              // 非本 bundle 可执行体
                    if (cmd.indexOf('--qqqide-play') >= 0) { continue; }   // 其他宿主
                    console.log('[player-host] activate: IDE already running, skip');
                    return;
                }
                const isDev = process.argv.includes('--dev') || process.env.QQQIDE_DEV === '1';
                const args: string[] = app.isPackaged ? [] : [app.getAppPath()];
                if (isDev) { args.push('--dev'); }
                const child = spawn(process.execPath, args, {
                    detached: true, stdio: 'ignore',
                    cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
                });
                child.unref();
                console.log('[player-host] activate (no IDE) -> IDE instance spawned');
            } catch { /* ignore */ }
        });
    } catch { /* ignore */ }
}

// ── 路径 → 播放器条目（runQ 同口径：file:/// 正斜杠） ──
export function filesToItems(files: string[]): any[] {
    const out: any[] = [];
    for (const f of files) {
        if (!f || typeof f !== 'string') { continue; }
        const fp = f.replace(/\\/g, '/');
        out.push({ src: 'file:///' + fp, localPath: fp, name: path.basename(f) });
    }
    return out;
}

/** 宿主心跳单写（启动早期先写——防 IDE 在恢复期误判失活重复拉启） */
export function touchPlayerHostState(): void { _writeHostState(); }

/** 从 argv 解析 --qqqide-play 之后的文件参数（空格式 + = 式；去重保序）。
 *  ★ 解析铁律（2026-10-02 探针实锤）：禁「收集到下一个开关为止」——Chromium 的 second-instance
 *  转发会对命令行重序列化（程序化 appendSwitch 全部插入开关段，非开关参数漂到最后），
 *  文件与开关相隔十多个开关项（files=0 事故）。正确算法 = 标记后的非开关项：
 *  开关（'-' 开头）一律跳过；目录（dev 的 app path 等）剔除；其余视为文件（不存在也保留——
 *  如实开窗报错而非静默丢失）。 */
export function parsePlayFiles(argv: string[]): string[] {
    const out: string[] = [];
    let seenMarker = false;
    for (let i = 1; i < argv.length; i++) {
        const a = String(argv[i] || '');
        if (a === '--qqqide-play') { seenMarker = true; continue; }
        if (a.indexOf('--qqqide-play=') === 0) {
            seenMarker = true;
            const p = a.slice('--qqqide-play='.length);
            if (p) { out.push(p); }
            continue;
        }
        if (!seenMarker) { continue; }             // 标记之前一律不算（argv[0]/启动器参数防误收）
        if (a.indexOf('-') === 0) { continue; }    // 开关一律跳过（重序列化会把开关插到文件前）
        try { if (fs.existsSync(a) && fs.statSync(a).isDirectory()) { continue; } } catch { /* 保留 */ }
        if (a) { out.push(a); }
    }
    const seen = new Set<string>();
    return out.filter((p) => { const k = p.toLowerCase(); if (seen.has(k)) { return false; } seen.add(k); return true; });
}

// ── 第二实例摄入（宿主域）：early-bird 先入内存，运行时就绪后直派 ──
let _dispatch: ((req: any) => any) | null = null;
let _pendingExternal: string[][] = [];
export function ingestExternalFiles(files: string[]): void {
    if (!files || !files.length) { return; }
    if (_dispatch) {
        try {
            const r = _dispatch({ kind: 'open', payload: { list: filesToItems(files), index: 0, play: true, external: true } });
            console.log('[player-host] external files dispatched: ' + files.length + ' result=' + JSON.stringify(r && r.ok));
        } catch (e: any) {
            console.log('[player-host] external dispatch error: ' + ((e && e.message) || e));
        }
        return;
    }
    _pendingExternal.push(files);
}

// ── IDE 侧：请求队列写入口 ──
export function queuePlayerRequest(kind: string, payload: any, waitMs?: number): Promise<any> {
    try {
        const dir = playerHostReqDir();
        fs.mkdirSync(dir, { recursive: true });
        const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const tmp = path.join(dir, 'tmp-' + id);
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, id, kind, payload: payload || {}, reply: !!(waitMs && waitMs > 0), ts: Date.now() }), 'utf8');
        fs.renameSync(tmp, path.join(dir, 'req-' + id + '.json'));   // 原子落位（宿主绝不读到半截）
        if (!playerHostAlive()) { ensurePlayerHostAlive(); }          // 先写请求后拉宿主——宿主启动即扫
        if (waitMs && waitMs > 0) { return _waitReply(id, waitMs); }
        return Promise.resolve({ ok: true, queued: true });
    } catch (e: any) {
        console.warn('[player-host] queue failed:', (e && e.message) || e);
        return Promise.resolve({ ok: false, reason: 'queue_failed' });
    }
}
function _waitReply(id: string, waitMs: number): Promise<any> {
    const t0 = Date.now();
    const file = path.join(playerHostReqDir(), 'res-' + id + '.json');
    return new Promise((resolve) => {
        const iv = setInterval(() => {
            try {
                const o = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (o && o.v === 1) {
                    clearInterval(iv);
                    try { fs.unlinkSync(file); } catch { /* ignore */ }
                    resolve(o.result);
                    return;
                }
            } catch { /* 未就绪，继续等 */ }
            if (Date.now() - t0 > waitMs) {
                clearInterval(iv);
                resolve({ ok: false, reason: 'timeout' });
            }
        }, 120);
    });
}

// ═══ 截图「📂 Roam 定位」跨进程通道（2026-10-03 q319 定案）═══
//   语义：播放器窗里的「Roam 定位」必须落到同安装的 IDE 主窗（Roam 是 IDE 里的文件浏览器；播放器宿主
//   进程恒无 IDE 窗——旧「进程内找主窗」结构性必败，只剩系统定位兜底）。
//   方向：宿主 → IDE（与 requests/ 相反；文件系统即 IPC）。宿主侧 = requestIdeReveal（写请求 + 等 ack）；
//   IDE 侧 = startIdeRevealWatch（认领 → 选窗 → 置前 → 投递 __qqq_roamRevealPath → 写 ack）。
//   选窗序（唯一权威 = player-reveal.pickRevealWindowId）：聚焦窗 → 最后聚焦窗（「你正在操作滴」）→ 发起窗 → 任一存活主窗。
//   失败收口（宿主侧统一裁决）：无 IDE / 无窗 / 投递失败 / 超时 → 系统文件管理器兜底（调用方执行）。
//   陈腐防线：请求 ts 超 60s 拒执（防 IDE 迟到启动执行出「惊喜定位」）；processing/ack 超 1h 由 tick 清扫。
export function playerHostRevealDir(): string { return path.join(playerHostDataDir(), 'reveals'); }

/** 宿主侧：向同安装 IDE 请求「Roam 定位」。ok:true = 某 IDE 主窗已承接投递（已置前 + 投递成功）。 */
export async function requestIdeReveal(target: string, src: { pid: number; winId: number } | null): Promise<{ ok: boolean; reason?: string }> {
    const p = String(target || '');
    if (!p) { return { ok: false, reason: 'empty' }; }
    if (!ideKeepaliveFresh()) { return { ok: false, reason: 'no_ide' }; }   // 快速路径：IDE 不在 → 立即兜底
    const dir = playerHostRevealDir();
    let id = '';
    try {
        fs.mkdirSync(dir, { recursive: true });
        id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const tmp = path.join(dir, 'tmp-' + id);
        const srcOut = (src && typeof src.pid === 'number' && typeof src.winId === 'number')
            ? { pid: src.pid | 0, winId: src.winId | 0 } : null;
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, id, ts: Date.now(), path: p, src: srcOut }), 'utf8');
        fs.renameSync(tmp, path.join(dir, 'req-' + id + '.json'));   // tmp+rename 原子落位（IDE 绝不读到半截）
    } catch { return { ok: false, reason: 'write_failed' }; }
    const ack = await _waitRevealAck(id, 2000);
    if (ack) { return ack.ok ? { ok: true } : { ok: false, reason: String(ack.reason || 'denied') }; }
    // 超时：未被认领 → 删请求（防 IDE 迟到执行造成双定位）；已认领（rename 竞争赢了）→ 宽限 800ms 再等一次
    const reqFile = path.join(dir, 'req-' + id + '.json');
    let claimed = false;
    try { if (fs.existsSync(reqFile)) { fs.unlinkSync(reqFile); } else { claimed = true; } } catch { claimed = true; }
    if (claimed) {
        const ack2 = await _waitRevealAck(id, 800);
        if (ack2) { return ack2.ok ? { ok: true } : { ok: false, reason: String(ack2.reason || 'denied') }; }
    }
    return { ok: false, reason: 'timeout' };
}

function _waitRevealAck(id: string, waitMs: number): Promise<any | null> {
    const file = path.join(playerHostRevealDir(), 'ack-' + id + '.json');
    const read = (): any | null => {
        try {
            const o = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (o && o.v === 1) { try { fs.unlinkSync(file); } catch { /* ignore */ } return o; }
        } catch { /* 未就绪，继续等 */ }
        return null;
    };
    return new Promise((resolve) => {
        const first = read();
        if (first) { resolve(first); return; }
        const t0 = Date.now();
        const iv = setInterval(() => {
            const o = read();
            if (o) { clearInterval(iv); resolve(o); return; }
            if (Date.now() - t0 > waitMs) { clearInterval(iv); resolve(null); }
        }, 100);
    });
}

// ── IDE 侧：reveals 队列监听（选窗/置前/投递/ack） ──
let _ideRevealStarted = false;
let _lastFocusedMainId: number | null = null;
const _revealInflight = new Set<string>();

function _mainWindowsAlive(): BrowserWindow[] {
    try {
        return BrowserWindow.getAllWindows().filter((w) => {
            try { return !w.isDestroyed() && !!((w as any).__qqqMainWindow) && !((w as any).__qqqPlayerWin); } catch { return false; }
        });
    } catch { return []; }
}

function _focusMainWindow(win: BrowserWindow): void {
    // ★ 强制召回（2026-10-03 用户定案「直接强制召回你正在操作滴 IDE」）：还原 → 显形 → 抬顶 → 夺焦
    try { if (win.isMinimized()) { win.restore(); } } catch { /* ignore */ }
    try { win.show(); } catch { /* ignore */ }
    try { if (typeof (win as any).moveTop === 'function') { (win as any).moveTop(); } } catch { /* ignore */ }
    try { win.focus(); } catch { /* ignore */ }
}

/** 投递 = 在目标主窗主世界调用全局 Roam 定位入口（与 timeline op 菜单同机同语义）；缺入口 → false。 */
function _deliverRoamReveal(win: BrowserWindow, p: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const code = '(function(){ try { if (typeof window.__qqq_roamRevealPath === "function") { window.__qqq_roamRevealPath('
                + JSON.stringify(p) + '); return true; } return false; } catch (e) { return false; } })()';
            win.webContents.executeJavaScript(code).then((r: any) => { resolve(r === true); }).catch(() => { resolve(false); });
        } catch { resolve(false); }
    });
}

function _writeRevealAck(id: string, result: { ok: boolean; reason?: string; win?: number }): void {
    try {
        const f = path.join(playerHostRevealDir(), 'ack-' + String(id) + '.json');
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, id: String(id), ok: !!result.ok, reason: String(result.reason || ''), win: Number(result.win) | 0, ts: Date.now() }), 'utf8');
        fs.renameSync(tmp, f);
    } catch { /* ignore */ }
}

async function _processRevealRequest(req: any): Promise<void> {
    const wins = _mainWindowsAlive();
    if (!wins.length) { _writeRevealAck(String(req.id), { ok: false, reason: 'no_window' }); return; }
    const byId = new Map<number, BrowserWindow>();
    for (const w of wins) { byId.set(w.id, w); }
    const focused = BrowserWindow.getFocusedWindow();
    const focusedId = (focused && !focused.isDestroyed() && byId.has(focused.id)) ? focused.id : null;
    const aliveIds = wins.map((w) => w.id);
    const pickId = pickRevealWindowId((req.src && typeof req.src === 'object') ? req.src : null, {
        selfPid: process.pid,
        focusedId,
        lastFocusedId: (_lastFocusedMainId != null && byId.has(_lastFocusedMainId)) ? _lastFocusedMainId : null,
        aliveIds,
    });
    const order = (pickId != null) ? [pickId].concat(aliveIds.filter((i) => i !== pickId)) : aliveIds;
    for (const id of order) {
        const w = byId.get(id);
        if (!w) { continue; }
        _focusMainWindow(w);
        const ok = await _deliverRoamReveal(w, String(req.path || ''));
        if (ok) { _writeRevealAck(String(req.id), { ok: true, win: id }); return; }
    }
    _writeRevealAck(String(req.id), { ok: false, reason: 'deliver_failed' });
}

function _sweepReveals(): void {
    const dir = playerHostRevealDir();
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    const now = Date.now();
    for (const n of names.sort()) {
        if (n.indexOf('.json') < 0) { continue; }
        if (n.indexOf('processing-') === 0 || n.indexOf('ack-') === 0 || n.indexOf('tmp-') === 0) {
            // 陈腐中间态清扫（投递中断 / 宿主超时放弃的 ack；>1h）
            try { const st = fs.statSync(path.join(dir, n)); if (now - st.mtimeMs > 3600000) { fs.unlinkSync(path.join(dir, n)); } } catch { /* ignore */ }
            continue;
        }
        if (n.indexOf('req-') !== 0 || _revealInflight.has(n)) { continue; }
        const full = path.join(dir, n);
        let raw = '';
        try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
        let req: any = null;
        try { req = JSON.parse(raw); } catch { req = null; }
        if (!req || !req.id || !req.path || revealReqStale(Number(req.ts), now)) {
            try { fs.unlinkSync(full); } catch { /* ignore */ }   // 陈腐/坏请求直接销毁（绝不迟到投递）
            continue;
        }
        const claimed = path.join(dir, 'processing-' + n.slice(4));
        try { fs.renameSync(full, claimed); } catch { continue; }   // 认领竞争失败 → 跳过
        const key = path.basename(claimed);
        _revealInflight.add(key);
        Promise.resolve()
            .then(() => _processRevealRequest(req))
            .catch(() => { _writeRevealAck(String(req.id), { ok: false, reason: 'error' }); })
            .finally(() => {
                _revealInflight.delete(key);
                try { fs.unlinkSync(claimed); } catch { /* ignore */ }
            });
    }
}

/** IDE 域启动调用（宿主域 no-op；幂等）——承接宿主侧「Roam 定位」请求（写 ack 供宿主裁决）。 */
export function startIdeRevealWatch(): void {
    if (isPlayerHostMode()) { return; }
    if (_ideRevealStarted) { return; }
    _ideRevealStarted = true;
    const dir = playerHostRevealDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    // 焦点历史（选窗序③）：仅本进程主窗入史
    try {
        app.on('browser-window-focus', (_e: any, w: any) => {
            try { if (w && !w.isDestroyed() && (w as any).__qqqMainWindow) { _lastFocusedMainId = w.id; } } catch { /* ignore */ }
        });
    } catch { /* ignore */ }
    let watcher: fs.FSWatcher | null = null;
    let trail: any = null;
    const startWatch = (): void => {
        try {
            watcher = fs.watch(dir, () => {
                _sweepReveals();                                             // 事件即扫（零等待）
                if (trail) { clearTimeout(trail); }
                trail = setTimeout(() => { trail = null; _sweepReveals(); }, 40);
            });
            watcher.on('error', () => { try { watcher?.close(); } catch { /* ignore */ } watcher = null; });
        } catch { watcher = null; }
    };
    startWatch();
    const rebind = setInterval(() => { if (!watcher) { startWatch(); } }, 30000);
    if (typeof (rebind as any).unref === 'function') { (rebind as any).unref(); }
    const tick = setInterval(_sweepReveals, 4000);   // 兜底扫（watch 静默死亡/漏事件有界收敛）
    if (typeof (tick as any).unref === 'function') { (tick as any).unref(); }
    _sweepReveals();
}

// ── 宿主侧：运行时（心跳 + 队列 watch/清扫 + 二实例派发） ──
export function startPlayerHostLoop(dispatch: (req: any) => any): void {
    _dispatch = dispatch;
    const dir = playerHostReqDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    _writeHostState();
    // 周期心跳 + 队列兜底清扫（watch 静默死亡也有界收敛）
    const tick = setInterval(() => { _writeHostState(); _sweepRequests(dispatch); }, 4000);
    if (typeof (tick as any).unref === 'function') { (tick as any).unref(); }
    // 目录监听（★ 快车道 2026-10-02：事件即扫 + 40ms 尾随补扫——请求写盘为 tmp+rename 原子，无半截风险；
    //   固定 60ms 等待已删（Q→开窗链实测 ~50ms 白付）；尾随扫兜住同批余量/事件合并）
    //   + error 自愈重绑（30s 间隔重试）
    let watcher: fs.FSWatcher | null = null;
    let trail: any = null;
    const startWatch = (): void => {
        try {
            watcher = fs.watch(dir, () => {
                _sweepRequests(dispatch);                                    // 立即扫（首请求零等待）
                if (trail) { clearTimeout(trail); }
                trail = setTimeout(() => { trail = null; _sweepRequests(dispatch); }, 40);
            });
            watcher.on('error', () => { try { watcher?.close(); } catch { /* ignore */ } watcher = null; });
        } catch { watcher = null; }
    };
    startWatch();
    const rew = setInterval(() => { if (!watcher) { startWatch(); } }, 30000);
    if (typeof (rew as any).unref === 'function') { (rew as any).unref(); }
    // 启动即扫（IDE「先写请求后拉宿主」常规路径）+ 二实例早到批次
    _sweepRequests(dispatch);
    const pending = _pendingExternal;
    _pendingExternal = [];
    for (const batch of pending) {
        try { dispatch({ kind: 'open', payload: { list: filesToItems(batch), index: 0, play: true, external: true } }); } catch { /* ignore */ }
    }
    // 陈旧响应清理（>1h——IDE 侧超时放弃的孤儿 res）
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(dir)) {
            if (f.indexOf('res-') !== 0) { continue; }
            try {
                const st = fs.statSync(path.join(dir, f));
                if (now - st.mtimeMs > 3600000) { fs.unlinkSync(path.join(dir, f)); }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

const _inflight = new Set<string>();   // 处理中认领集（异步 dispatch 未完时二次 sweep 禁重复认领）
function _sweepRequests(dispatch: (req: any) => any): void {
    let names: string[] = [];
    try { names = fs.readdirSync(playerHostReqDir()); } catch { return; }
    for (const n of names.sort()) {
        const isReq = n.indexOf('req-') === 0;
        const isProc = n.indexOf('processing-') === 0;
        if ((!isReq && !isProc) || n.indexOf('.json') < 0) { continue; }
        if (_inflight.has(n)) { continue; }
        const full = path.join(playerHostReqDir(), n);
        let raw = '';
        try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
        let claimed = full;
        if (isReq) {
            claimed = path.join(playerHostReqDir(), 'processing-' + n.slice(4));
            try { fs.renameSync(full, claimed); } catch { continue; }   // 认领竞争失败/已被处理 → 跳过
        }
        _inflight.add(path.basename(claimed));
        let req: any = null;
        try { req = JSON.parse(raw); } catch { req = null; }
        const finish = (): void => {
            _inflight.delete(path.basename(claimed));
            try { fs.unlinkSync(claimed); } catch { /* ignore */ }
        };
        if (!req || typeof req !== 'object' || !req.kind) { finish(); continue; }
        try {
            const result = dispatch(req);
            if (result && typeof result.then === 'function') {
                (result as Promise<any>).then((r) => { _writeReply(req, r); finish(); })
                    .catch(() => { _writeReply(req, { ok: false, reason: 'error' }); finish(); });
            } else {
                _writeReply(req, result);
                finish();
            }
        } catch {
            _writeReply(req, { ok: false, reason: 'error' });
            finish();
        }
    }
}
function _writeReply(req: any, result: any): void {
    if (!req || !req.reply || !req.id) { return; }
    try {
        const f = path.join(playerHostReqDir(), 'res-' + String(req.id) + '.json');
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, id: req.id, result: result === undefined ? { ok: true } : result }), 'utf8');
        fs.renameSync(tmp, f);
    } catch { /* ignore */ }
}

// ── 宿主环境自愈：直启（双击/关联）没有 C 启动器的 PATH 注入 → 本进程自补 ──
export function injectHostRuntimePath(root: string): void {
    try {
        const cands = [
            path.join(root, 'resources', 'app', 'engines', 'vc_runtime', 'win32-x64'),
            path.join(root, 'engines', 'vc_runtime', 'win32-x64'),
        ];
        let vc = '';
        for (const c of cands) { if (fs.existsSync(c)) { vc = c; break; } }
        if (!vc) { return; }
        const cur = process.env.PATH || '';
        const parts = cur.split(';');
        for (const p of parts) { if (p && p.toLowerCase() === vc.toLowerCase()) { return; } }
        process.env.PATH = vc + ';' + cur;
    } catch { /* ignore */ }
}

// ── 宿主最小 shell 桥（播放器引擎消费面：截图定位/外链/打开路径） ──
export function registerHostShellIpc(): void {
    ipcMain.handle('qqqide:shell:showItemInFolder', (_e, p: string) => {
        try { shell.showItemInFolder(String(p || '')); } catch { /* ignore */ }
        return true;
    });
    ipcMain.handle('qqqide:shell:openExternal', async (_e, url: string) => {
        try { await shell.openExternal(String(url || '')); return { ok: true }; }
        catch (e: any) { return { ok: false, error: (e && e.message) || 'open-failed' }; }
    });
    ipcMain.handle('qqqide:shell:openPath', async (_e, p: string) => {
        try { return { ok: true, result: await shell.openPath(String(p || '')) }; }
        catch (e: any) { return { ok: false, error: (e && e.message) || 'open-failed' }; }
    });
    // ── resize grip（2026-10-02 移植自主窗 ipc-misc 同机）：渲染层每帧报告目标宽高 → clamp(min/max) + setBounds（左上角固定）──
    //   fire-and-forget（60fps 热路径零 promise 开销）；min/max 主进程钳制（min 动态读 win.getMinimumSize——常量唯一源 = ipc-player.ts _PLAYER_MIN_W/H，2026-10-03 二轮起 540×320）；通道名与 preload 同契
    ipcMain.on('qqqide:window:resize-grip', (e, w: number, h: number) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win || win.isDestroyed()) { return; }
        const b = win.getBounds();
        const [minW, minH] = win.getMinimumSize();
        const [maxW, maxH] = win.getMaximumSize();
        let nw = Math.round(Number(w) || 0);
        let nh = Math.round(Number(h) || 0);
        if (minW) { nw = Math.max(nw, minW); }
        if (minH) { nh = Math.max(nh, minH); }
        if (maxW) { nw = Math.min(nw, maxW); }
        if (maxH) { nh = Math.min(nh, maxH); }
        // ★ 最大化态直改尺寸（拉伸钮 x1~x4 / grip 同路，2026-10-02）：先还原再 setBounds（最大化下 setBounds 语义不可靠）；
        //   还原后按正常态几何重取基准（▢ 图标经 qqqide:player:maxstate 事件自动回推）
        try { if (win.isMaximized()) { win.unmaximize(); } } catch { /* ignore */ }
        const b2 = win.isDestroyed() ? b : win.getBounds();
        if (nw === b2.width && nh === b2.height) { return; }
        win.setBounds({ x: b2.x, y: b2.y, width: nw, height: nh });
    });
}
