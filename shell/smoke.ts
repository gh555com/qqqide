// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// smoke.ts — 端到端冒烟测试机（--smoke 启动参数）
//
// 定位：一条命令完成「起 → 探 → 退」（CI 阻断门 + 本地体检）：
//   真实 bootSequence 启动真实渲染层 → 等渲染层就绪信号（qqqide:renderer-ready，
//   与 boot.ts 揭幕门控同一 IPC 通道）→ 经 preload 桥真实 IPC 往返探活 →
//   写 smoke-report.json → 进程退出码 0/1（CI 直接消费）。
//
// 隔离契约（全部 = --smoke + 环境变量双条件，生产/常规开发零感知；详 portable-paths.ts）：
//   QQQIDE_SMOKE_DATA    → Data 目录（userData/cache/temp/logs）重定向
//   QQQIDE_SMOKE_OS_DIR  → OS 级状态根（squads.json/ws.sq3/ai.sq3/...）重定向
//   QQQIDE_SMOKE_OUT     → 报告落盘路径（缺省 {userData}/smoke-report.json）
//   main.ts 侧同时禁用：组件后台下载 / py-broker / gaea process 自启 / 音频预热 /
//   统计上报 / 协议注册（CI 设备不得污染生产遥测与注册表）。
//
// runner（进程编排 + 静态服务器）：ci/smoke/run-smoke.js
// ============================================================================

import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const READY_TIMEOUT_MS = 120000;   // 渲染层就绪信号上限（CI 慢机留足余量）
const PROBE_TIMEOUT_MS = 20000;    // 单探针上限（executeJavaScript 无原生超时）

export function isSmokeMode(): boolean {
    return process.argv.includes('--smoke');
}

export interface SmokeCtx {
    root: string;
    userData: string;
    appVersion: string;
    getWindow: () => BrowserWindow | null;
    getBootMode: () => string;
    /** 退出前收尾（app.exit 跳过 before-quit：主进程侧如音频引擎需显式停） */
    onBeforeExit?: () => void;
}

interface SmokeProbe { id: string; ok: boolean; detail?: string }

function _reportPath(userData: string): string {
    const env = (process.env.QQQIDE_SMOKE_OUT || '').trim();
    return env || path.join(userData, 'smoke-report.json');
}

function _writeReport(userData: string, report: any): void {
    const body = JSON.stringify(report, null, 2);
    const targets = [_reportPath(userData), path.join(userData, 'smoke-report.json')];
    for (const t of targets) {
        try {
            fs.mkdirSync(path.dirname(t), { recursive: true });
            fs.writeFileSync(t, body, 'utf8');
        } catch (_) { /* 报告写失败不阻断退出码 */ }
    }
}

/** 起不来时的快速失败（单例锁被占用等；exitCode=2，报告照写——绝不静默退出码 0）。 */
export function smokeFailFast(userData: string, reason: string, code = 2): void {
    _writeReport(userData, {
        ok: false,
        phase: 'fail-fast',
        reason,
        appVersion: app.getVersion(),
        ts: new Date().toISOString(),
        probes: [] as SmokeProbe[],
    });
    console.error('[smoke] fail-fast: ' + reason);
    app.exit(code);
}

function _execJs(wc: BrowserWindow['webContents'], code: string): Promise<any> {
    return Promise.race([
        wc.executeJavaScript(code, true),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('probe-timeout')), PROBE_TIMEOUT_MS)),
    ]);
}

export function runSmoke(ctx: SmokeCtx): void {
    const t0 = Date.now();
    const probes: SmokeProbe[] = [];
    const report: any = {
        ok: false,
        phase: 'boot',
        appVersion: ctx.appVersion,
        versions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
        },
        platform: {
            os: os.platform() + ' ' + os.release(),
            arch: process.arch,
            cpus: os.cpus().length,
            memMB: Math.round(os.totalmem() / 1048576),
        },
        root: ctx.root,
        userData: ctx.userData,
        osDir: process.env.QQQIDE_SMOKE_OS_DIR || null,
        ts: new Date().toISOString(),
        probes,
        timing: {} as Record<string, number>,
    };
    const push = (id: string, ok: boolean, detail?: string): boolean => {
        probes.push({ id, ok, detail });
        console.log('[smoke] probe ' + id + ': ' + (ok ? 'OK' : 'FAIL') + (detail ? ' — ' + detail : ''));
        return ok;
    };
    let finished = false;
    const finish = (code: number) => {
        if (finished) { return; }
        finished = true;
        report.ok = code === 0;
        report.phase = 'done';
        report.timing.totalMs = Date.now() - t0;
        _writeReport(ctx.userData, report);
        console.log('[smoke] ' + (code === 0 ? 'PASS' : 'FAIL') + ' — report: ' + _reportPath(ctx.userData));
        try { if (ctx.onBeforeExit) { ctx.onBeforeExit(); } } catch (_) { /* 收尾失败不影响判定 */ }
        // ★ 退出与本次调用栈解耦（2026-09-29 冒烟实测）: 窗口销毁期某些 'closed' 处理器
        //   会向同步栈外溢异常（已被全局兑底吞掉，但若沿 app.exit() 逃进本栈会污染退出码）
        //   → 下一 tick 再退出，异常落事件循环（与生产退出路径同语义）
        setTimeout(() => {
            try { app.exit(code); } catch (_) { /* 竞态异常交给全局兑底 */ }
        }, 30);
    };

    const win = ctx.getWindow();
    if (!win || win.isDestroyed()) {
        report.phase = 'window-missing';
        _writeReport(ctx.userData, report);
        console.error('[smoke] main window missing');
        app.exit(1);
        return;
    }
    const wc = win.webContents;

    // ── A) 渲染层就绪信号（与 boot.ts 揭幕门控同一 IPC 通道） ──
    console.log('[smoke] waiting renderer-ready (timeout ' + READY_TIMEOUT_MS + 'ms)…');
    const readyPromise = new Promise<boolean>(resolve => {
        let settled = false;
        let timer: NodeJS.Timeout | null = null;
        const settle = (ok: boolean) => {
            if (settled) { return; }
            settled = true;
            if (timer) { clearTimeout(timer); }
            try { ipcMain.removeListener('qqqide:renderer-ready', onReady); } catch (_) { }
            resolve(ok);
        };
        const onReady = (e: any) => {
            try { if (e && e.sender && e.sender.id === wc.id) { settle(true); } } catch (_) { }
        };
        ipcMain.on('qqqide:renderer-ready', onReady);
        timer = setTimeout(() => settle(false), READY_TIMEOUT_MS);
    });

    (async () => {
        const readyOk = await readyPromise;
        report.timing.rendererReadyMs = Date.now() - t0;
        push('renderer-ready', readyOk, readyOk ? ('ms=' + report.timing.rendererReadyMs) : ('timeout ' + READY_TIMEOUT_MS + 'ms'));

        // ── B) preload 桥存在（contextBridge 白名单） ──
        let bridgeType = '';
        try { bridgeType = String(await _execJs(wc, 'typeof window.qqqideBridge')); }
        catch (e: any) { bridgeType = 'ERR:' + ((e && e.message) || e); }
        push('bridge', bridgeType === 'object', bridgeType);

        // ── C) 真实 IPC 往返 + 数据目录隔离断言（userData 必须 = 冒烟数据目录） ──
        const expectUserData = process.env.QQQIDE_SMOKE_DATA ? path.join(process.env.QQQIDE_SMOKE_DATA, 'Data') : '';
        let info: any = null;
        try {
            info = await _execJs(wc, "(async()=>{ try { return await window.qqqideBridge.boot.getInfo(); } catch(e){ return { error: String((e&&e.message)||e) }; } })()");
        } catch (e: any) { info = { error: String((e && e.message) || e) }; }
        const _n = (p: any) => String(p || '').replace(/\\/g, '/').toLowerCase();
        const infoOk = !!info && !info.error && typeof info.userData === 'string'
            && !!expectUserData && _n(info.userData) === _n(expectUserData);
        push('ipc-boot-info', infoOk, info && info.error ? String(info.error)
            : ('version=' + (info && info.version) + ' bootMode=' + (info && info.bootMode) + ' userData=' + (info && info.userData)));

        // ── D) fs 写入 → 读回（文本编码机器全链：encodeFile → decodeFile） ──
        const probeFile = path.join(ctx.userData, 'smoke-fs-probe.txt');
        const payload = '冒烟 smoke OK 中文';
        let fsProbe: any = null;
        try {
            fsProbe = await _execJs(wc, "(async()=>{ try { const p = " + JSON.stringify(probeFile)
                + "; await window.qqqideBridge.fs.write(p, " + JSON.stringify(payload)
                + ", null); const rd = await window.qqqideBridge.fs.read(p); const enc = await window.qqqideBridge.fs.encoding(p); return { read: rd, enc: enc }; } catch(e){ return { error: String((e&&e.message)||e) }; } })()");
        } catch (e: any) { fsProbe = { error: String((e && e.message) || e) }; }
        const fsOk = !!fsProbe && !fsProbe.error && fsProbe.read === payload;
        push('fs-roundtrip', fsOk, fsProbe && fsProbe.error ? String(fsProbe.error)
            : ('read=' + JSON.stringify(fsProbe && fsProbe.read) + ' enc=' + (fsProbe && fsProbe.enc && fsProbe.enc.enc)));

        // ── E) UI 骨架 + 核心就绪标志 ──
        let ui: any = null;
        try {
            ui = await _execJs(wc, "(()=>{ try { return { a: !!document.getElementById('qqq-a-zone'), x: !!document.getElementById('qqq-x-zone'), ai: !!document.getElementById('qqq-ai-zone'), core: !!window.__qqqCoreReady, url: location.href }; } catch(e){ return { error: String((e&&e.message)||e) }; } })()");
        } catch (e: any) { ui = { error: String((e && e.message) || e) }; }
        const uiOk = !!ui && !ui.error && !!(ui.a && ui.x && ui.ai && ui.core);
        push('ui-zones', uiOk, ui && ui.error ? String(ui.error)
            : ('a=' + ui.a + ' x=' + ui.x + ' ai=' + ui.ai + ' coreReady=' + ui.core));

        // ── F) 启动模式 = live（真实载荷，而非离线兜底页） ──
        const mode = ctx.getBootMode();
        push('boot-mode', mode === 'live', 'mode=' + mode + ' url=' + (ui && ui.url ? ui.url : ''));

        const allOk = probes.every(p => p.ok);
        finish(allOk ? 0 : 1);
    })().catch((e: any) => {
        if (finished) { console.error('[smoke] post-finish error (ignored): ' + ((e && e.message) || e)); return; }
        report.phase = 'crash';
        report.error = String((e && e.stack) || e);
        _writeReport(ctx.userData, report);
        console.error('[smoke] crashed: ' + report.error);
        setTimeout(() => { try { app.exit(1); } catch (_) { /* 同上 */ } }, 30);
    });
}
