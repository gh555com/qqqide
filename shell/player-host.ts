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
// ============================================================================
import { app, ipcMain, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './portable-paths';

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

// ── 宿主侧：运行时（心跳 + 队列 watch/清扫 + 二实例派发） ──
export function startPlayerHostLoop(dispatch: (req: any) => any): void {
    _dispatch = dispatch;
    const dir = playerHostReqDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    _writeHostState();
    // 周期心跳 + 队列兜底清扫（watch 静默死亡也有界收敛）
    const tick = setInterval(() => { _writeHostState(); _sweepRequests(dispatch); }, 4000);
    if (typeof (tick as any).unref === 'function') { (tick as any).unref(); }
    // 目录监听（60ms 防抖——秒开：写入→开窗时延；请求写盘为 tmp+rename 原子，无半截风险）+ error 自愈重绑（30s 间隔重试）
    let watcher: fs.FSWatcher | null = null;
    let debounce: any = null;
    const startWatch = (): void => {
        try {
            watcher = fs.watch(dir, () => {
                if (debounce) { clearTimeout(debounce); }
                debounce = setTimeout(() => { debounce = null; _sweepRequests(dispatch); }, 60);
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
}
