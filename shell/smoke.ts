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

        // ── G) 搜索跳转机器（跳行 + 行闪 + 查找控件预填；大小写/正则透传；控件复用；双路兜底；4s 自消） ──
        const sjFile = path.join(ctx.userData, 'smoke-search-jump.txt');
        const sjContent = 'alpha needle one\nbeta two\nNEEDLE three needle four\n';
        let sj: any = null;
        try {
            await _execJs(wc, "(async()=>{ try { await window.qqqideBridge.fs.write(" + JSON.stringify(sjFile) + ", " + JSON.stringify(sjContent) + ", null); return true; } catch(e){ return String((e&&e.message)||e); } })()");
            const sjCode = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 200; i++) { if (window.qqqEditor && window.qqqEditor.applySearchJump && window.qqqEditor.openFindWidget) break; await sleep(100); }
    if (!window.qqqEditor || !window.qqqEditor.applySearchJump || !window.qqqEditor.openFindWidget) return { error: 'machine missing' };
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed; left:-4000px; top:0; width:640px; height:420px;';
    document.body.appendChild(host);
    const p = ${JSON.stringify(sjFile)};
    const ed = await window.qqqEditor.openInPane(host, p, ${JSON.stringify(sjContent)}, { line: 1, col: 7, search: 'needle', caseSensitive: false });
    if (!ed || !ed.getModel) return { error: 'editor open failed' };
    const q = (c) => host.querySelectorAll(c).length;
    const input = () => { const w = host.querySelector('.find-widget'); return w ? (w.querySelector('textarea.input') || w.querySelector('input')) : null; };
    const countText = () => { const m = host.querySelector('.find-widget .matchesCount'); return m ? (m.textContent || '') : ''; };
    const bgOf = (c) => { const el = host.querySelector(c); if (!el) return ''; try { return getComputedStyle(el).backgroundColor || ''; } catch (_) { return ''; } };
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(60); } return fn(); };
    const res = {};
    res.open = await waitFor(() => { const w = host.querySelector('.find-widget'); const i = input(); return !!w && w.classList.contains('visible') && !!i && i.value === 'needle'; }, 6000);
    res.input = input() ? input().value : '';
    res.wcount = q('.find-widget');
    res.cur = q('.currentFindMatch');
    res.hits = q('.findMatch');
    res.lineFlash = q('.qqq-jump-line');
    res.fbDeco = q('.qqq-find-cur') + q('.qqq-find-hit');
    res.count = countText();
    res.focused = input() && document.activeElement === input() ? 1 : 0;
    res.bg = bgOf('.findMatch');
    var _cls = {}; var _nodes = host.querySelectorAll('[class*="Match"]');
    for (var _i = 0; _i < _nodes.length && _i < 8; _i++) { _cls[_nodes[_i].className] = 1; }
    res.decoDump = Object.keys(_cls).join(' | ');
    res.selLine = ed.getSelection ? (ed.getSelection() || {}).startLineNumber : 0;
    res.selCol = ed.getSelection ? (ed.getSelection() || {}).startColumn : 0;
    window.qqqEditor.applySearchJump(ed, { line: 3, col: 1, search: 'needle', caseSensitive: true });
    await sleep(450);
    res.csInput = input() ? input().value : '';
    res.csCount = countText();
    res.csW = q('.find-widget');
    window.qqqEditor.applySearchJump(ed, { line: 1, col: 7, search: 'n..dle', isRegex: true, caseSensitive: false });
    await sleep(450);
    res.rxCount = countText();
    const hadC = ed.getContribution; const hadA = ed.getAction;
    ed.getContribution = function () { return null; };
    ed.getAction = function () { return null; };
    window.qqqEditor.applySearchJump(ed, { line: 1, col: 7, search: 'needle', caseSensitive: false });
    await waitFor(() => q('.qqq-find-cur') === 1 && q('.qqq-find-hit') >= 2, 3000);
    res.fbCur = q('.qqq-find-cur'); res.fbHits = q('.qqq-find-hit');
    res.fbBg = bgOf('.qqq-find-hit'); res.fbCurBg = bgOf('.qqq-find-cur');
    ed.getContribution = hadC; ed.getAction = hadA;
    await sleep(4300);
    res.cleared = q('.qqq-find-cur') === 0 && q('.qqq-find-hit') === 0 && q('.qqq-jump-line') === 0;
    res.widgetStill = q('.find-widget') > 0;
    try { window.qqqEditor.disposePaneEditor(p, host); } catch (_) {}
    try { host.remove(); } catch (_) {}
    return res;
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;
            sj = await _execJs(wc, sjCode);
        } catch (e: any) { sj = { error: String((e && e.message) || e) }; }
        // 期望：控件打开+预填 needle、行闪共存、无自绘兜底；全文件 3 处（当前/其余原生双色，背景色=主题橙实测）；大小写敏感改写 2 处且控件复用；正则透传 3 处；强制断链→兜底自绘接手（橙底实测）；~4s 后自绘自消、控件恒在
        const _orange = (s: any) => typeof s === 'string' && (s.indexOf('224, 160, 16') >= 0 || s.indexOf('212, 160, 23') >= 0);
        const sjOk = !!sj && !sj.error && sj.open === true && sj.input === 'needle' && sj.wcount === 1 &&
            sj.cur >= 1 && sj.selLine === 1 && sj.selCol === 7 && sj.focused === 1 &&
            sj.lineFlash === 1 && sj.fbDeco === 0 && sj.count.indexOf('of 3') >= 0 && _orange(sj.bg) &&
            sj.csInput === 'needle' && sj.csCount.indexOf('of 2') >= 0 && sj.csW === 1 && sj.rxCount.indexOf('of 3') >= 0 &&
            sj.fbCur === 1 && sj.fbHits >= 2 && _orange(sj.fbBg) && _orange(sj.fbCurBg) &&
            sj.cleared === true && sj.widgetStill === true;
        push('search-jump-find-widget', sjOk, sj && sj.error ? String(sj.error) : JSON.stringify(sj));

        // ── G2) 搜索结果点击全链（_nextPaneOpts + qqq-file-open → 打开/跳转/控件预填；已开文件复用同一机器） ──
        const sdFile = path.join(ctx.userData, 'smoke-search-dispatch.txt');
        const sdContent = 'one beta one\nbeta two gamma\nsix gamma seven\n';
        let sd: any = null;
        try {
            await _execJs(wc, "(async()=>{ try { await window.qqqideBridge.fs.write(" + JSON.stringify(sdFile) + ", " + JSON.stringify(sdContent) + ", null); return true; } catch(e){ return String((e&&e.message)||e); } })()");
            const sdCode = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 150; i++) { if (window.qqqTabs && window.qqqEditor && window.qqqEditor.openFindWidget && window.qqqEditor.getEditorForFile) break; await sleep(100); }
    if (!window.qqqTabs || !window.qqqEditor) return { error: 'core missing' };
    const p = ${JSON.stringify(sdFile)};
    const readUi = () => {
      const ed = window.qqqEditor.getEditorForFile(p);
      const dom = ed && ed.getDomNode ? ed.getDomNode() : null;
      const w = dom ? dom.querySelector('.find-widget') : null;
      const inp = dom ? (dom.querySelector('.find-widget textarea.input') || dom.querySelector('.find-widget input')) : null;
      return { ed: ed, vis: !!(w && w.classList.contains('visible')), val: inp ? inp.value : '', line: ed && ed.getPosition ? (ed.getPosition() || {}).lineNumber : 0, cur: dom ? dom.querySelectorAll('.currentFindMatch').length : 0 };
    };
    window._nextPaneOpts = { line: 2, col: 1, search: 'beta', isRegex: false, caseSensitive: false, wholeWord: false };
    document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: p } }));
    let st = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      st = readUi();
      if (st.ed && st.vis && st.val === 'beta') break;
      await sleep(120);
    }
    st = readUi();
    const res = { freshVis: st.vis, freshVal: st.val, freshLine: st.line };
    window._nextPaneOpts = { line: 3, col: 1, search: 'gamma', caseSensitive: false };
    document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: p } }));
    const t1 = Date.now();
    while (Date.now() - t1 < 7000) {
      st = readUi();
      if (st.val === 'gamma') break;
      await sleep(120);
    }
    st = readUi();
    res.reVal = st.val; res.reLine = st.line;
    window._nextPaneOpts = { line: 2, col: 1, search: 'gamma', caseSensitive: false };
    document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: p } }));
    const t2 = Date.now();
    while (Date.now() - t2 < 6000) {
      st = readUi();
      if (st.cur >= 1 && st.line === 2) break;
      await sleep(120);
    }
    st = readUi();
    res.sameVal = st.val; res.sameLine = st.line; res.sameCur = st.cur;
    const dom = st.ed && st.ed.getDomNode ? st.ed.getDomNode() : null;
    res.widgets = dom ? dom.querySelectorAll('.find-widget').length : 0;
    return res;
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;
            sd = await _execJs(wc, sdCode);
        } catch (e: any) { sd = { error: String((e && e.message) || e) }; }
        // 期望：全新打开=控件可见+预填 beta+定位行 2；已开文件再点=同控件改写 gamma、行 3；同词再点=强色当前匹配立位、行 2；控件数恒 1
        const sdOk = !!sd && !sd.error && sd.freshVis === true && sd.freshVal === 'beta' && sd.freshLine === 2 &&
            sd.reVal === 'gamma' && sd.reLine === 3 &&
            sd.sameVal === 'gamma' && sd.sameLine === 2 && sd.sameCur >= 1 && sd.widgets === 1;
        push('search-click-chain', sdOk, sd && sd.error ? String(sd.error) : JSON.stringify(sd));

        // ── H) 搜索多实例：每次 open('search') = 再开一个新标签（已存在不得无操作） ──
        let sm: any = null;
        try {
            sm = await _execJs(wc, `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80; i++) { if (window.qqqGaea && window.qqqGaea.open && window.qqqTabs && window.qqqTabs.getGaeaGroup) break; await sleep(100); }
    if (!window.qqqGaea || !window.qqqGaea.open) return { error: 'qqqGaea missing' };
    const registered = !!(window.qqqGaea.list && window.qqqGaea.list().some((d) => d.id === 'search'));
    const count = () => { const g = window.qqqTabs.getGaeaGroup(); return g ? g.tabs.filter((t) => t.gaeaId === 'search').length : -1; };
    const before = count();
    const r1 = !!window.qqqGaea.open('search');
    await sleep(350);
    const mid = count();
    const r2 = !!window.qqqGaea.open('search');
    await sleep(350);
    const g = window.qqqTabs.getGaeaGroup();
    const active = g && g.tabs.find((t) => t.id === g.activeTabId);
    return { registered, before, mid, after: count(), r1, r2, activeIsSearch: !!(active && active.gaeaId === 'search') };
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`);
        } catch (e: any) { sm = { error: String((e && e.message) || e) }; }
        const smOk = !!sm && !sm.error && sm.registered === true && sm.r1 === true && sm.r2 === true &&
            sm.before >= 0 && sm.mid === sm.before + 1 && sm.after === sm.before + 2 && sm.activeIsSearch === true;
        push('search-multi-tab', smOk, sm && sm.error ? String(sm.error) : JSON.stringify(sm));

        // ── I) 时间线窗口编辑器右上角悬浮按钮行（左右各一组；点击=Ctrl+F；控件开则本侧隐；重渲染/缩放随动） ──
        const _sleepMs = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
        let tc: any = { open: null, ready: null, a: null, b1: null, b2: null, c: null, info: null, resized: false, shotClosed: '', shotOpen: '', error: '' };
        let dwWin: BrowserWindow | null = null;
        try {
            const tcFile = path.join(ctx.userData, 'smoke-timeline-corner.txt');
            fs.writeFileSync(tcFile, 'timeline corner alpha\nbeta line two\ngamma line three\n', 'utf8');
            const tcPathF = tcFile.replace(/\\/g, '/');
            const projRootF = String(ctx.userData || '').replace(/\\/g, '/');
            tc.open = await _execJs(wc, "(async()=>{ try { return await window.qqqideBridge.timeline.openDiffWindow({ filePath: " + JSON.stringify(tcPathF) + ", projectRoot: " + JSON.stringify(projRootF) + " }); } catch(e){ return { error: String((e&&e.message)||e) }; } })()");
            for (let i = 0; i < 120; i++) {
                dwWin = BrowserWindow.getAllWindows().find((w) => { try { return !w.isDestroyed() && (w.webContents.getURL() || '').indexOf('timeline/diff-window.html') !== -1; } catch (_) { return false; } }) || null;
                if (dwWin) { break; }
                await _sleepMs(100);
            }
            if (!dwWin) { throw new Error('diff window not opened: ' + JSON.stringify(tc.open)); }
            const dw: BrowserWindow = dwWin;
            for (let i = 0; i < 150 && dw.webContents.isLoading(); i++) { await _sleepMs(100); }

            // I-0) 就绪（独立评估，避开单次探针 20s 上限）
            tc.ready = await _execJs(dw.webContents, "(async()=>{ const t0=Date.now(); while(Date.now()-t0<18000){ if(document.querySelectorAll('#diff-container .tl-float-btn').length===2) return { ready:true, ms:Date.now()-t0 }; await new Promise(r=>setTimeout(r,150)); } return { ready:false, monaco:!!window.monaco, dif:!(window._diffEditor) }; })()");

            // I-A) 几何（左/右各 8px 内缩）+ 左按钮点击流（控件开 + 本侧隐 + 对侧不动 + 焦点入控件 + 关闭回归）
            const tcA = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); } return fn(); };
    if (document.querySelectorAll('#diff-container .tl-float-btn').length !== 2) return { error: 'not ready' };
    await sleep(400);
    const d = window._diffEditor;
    if (!d) return { error: 'diff editor missing' };
    const le = d.getOriginalEditor(), re = d.getModifiedEditor();
    const lDom = le.getDomNode(), rDom = re.getDomNode();
    const stripOf = (s) => document.querySelector('#diff-container .tl-corner-btns[data-side="' + s + '"]');
    const edge = (strip, el) => { const a = strip.getBoundingClientRect(), b = el.getBoundingClientRect(); return { top: Math.round(a.top - b.top), right: Math.round(b.right - a.right), vis: getComputedStyle(strip).visibility }; };
    const res = {};
    res.strips = document.querySelectorAll('#diff-container .tl-corner-btns').length;
    res.lInit = edge(stripOf('left'), lDom);
    res.rInit = edge(stripOf('right'), rDom);
    res.icoDiag = (function () {
      const b = stripOf('left').querySelector('button'); const s = b ? b.querySelector('svg,span,img') : null;
      const cs = s ? getComputedStyle(s) : null;
      return { styleEl: !!document.getElementById('qqq-icons-style'), tag: s ? s.tagName : null, cls: s ? String(s.className.baseVal !== undefined ? s.className.baseVal : s.className).slice(0, 40) : null,
        w: s ? Math.round(s.getBoundingClientRect().width) : 0, h: s ? Math.round(s.getBoundingClientRect().height) : 0,
        mask: cs ? String(cs.webkitMaskImage || cs.maskImage || 'none').slice(0, 46) : '', bg: cs ? cs.backgroundColor : '', svgW: cs ? cs.width : '', btnHtml: b ? b.outerHTML.slice(0, 220) : '' };
    })();
    res.icoEnv = await (async function () {
      const o = { href: location.href, qqqIcons: typeof window.qqqIcons, _i: typeof window._i, headEls: document.head ? document.head.childNodes.length : -1 };
      o.scripts = Array.prototype.map.call(document.scripts, function (s) { return s.getAttribute('src'); }).filter(Boolean).slice(0, 14);
      try { o.perf = performance.getEntriesByType('resource').filter(function (e) { return e.name.indexOf('qqq-icons') >= 0 || e.name.indexOf('i18n') >= 0 || e.name.indexOf('qqqide-theme') >= 0 || e.name.indexOf('state-sdk') >= 0; }).map(function (e) { var p = e.name.split('/'); return { n: p[p.length - 1], dur: Math.round(e.duration), size: e.transferSize || 0 }; }); } catch (_) { o.perf = 'n/a'; }
      try { const r = await fetch('/qqqide/core/qqq-icons.js'); const t = await r.text(); o.fetchIcons = r.status + ' len=' + t.length; } catch (e) { o.fetchIcons = 'ERR ' + String(e && e.message || e); }
      try { o.iconsJson = window.qqqIcons ? window.qqqIcons.names.length : -1; } catch (_) { }
      return o;
    })();
    stripOf('left').querySelector('button').click();
    res.lOpen = await waitFor(() => { const w = lDom.querySelector('.find-widget'); return !!w && w.classList.contains('visible'); }, 6000);
    await sleep(280);
    res.wg = (function () {
      const w = lDom.querySelector('.find-widget'); if (!w) return null;
      const wr = w.getBoundingClientRect(), lr = lDom.getBoundingClientRect(), sr = stripOf('left').getBoundingClientRect();
      return { wTop: Math.round(wr.top - lr.top), wBottom: Math.round(wr.bottom - lr.top), wH: Math.round(wr.height), wRight: Math.round(lr.right - wr.right), wLeft: Math.round(wr.left - lr.left),
        sTop: Math.round(sr.top - lr.top), sBottom: Math.round(sr.bottom - lr.top), sRight: Math.round(lr.right - sr.right),
        ovl: (sr.left < wr.right && sr.right > wr.left && sr.top < wr.bottom && sr.bottom > wr.top),
        cls: String(w.className).slice(0, 70) };
    })();
    res.lVis = getComputedStyle(stripOf('left')).visibility === 'visible';
    res.rVis = getComputedStyle(stripOf('right')).visibility === 'visible';
    const rw = rDom.querySelector('.find-widget');
    res.rOpen = !!(rw && rw.classList.contains('visible'));
    res.focusIn = !!(document.activeElement && lDom.contains(document.activeElement));
    let how = 'btn';
    const cb = lDom.querySelector('.find-widget [class*="widget-close"]');
    if (cb) { cb.click(); } else {
      how = 'esc';
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      try { Object.defineProperty(ev, 'keyCode', { get: () => 27 }); } catch (_) { }
      (document.activeElement || lDom).dispatchEvent(ev);
    }
    let lClosed = await waitFor(() => { const w = lDom.querySelector('.find-widget'); return !(w && w.classList.contains('visible')); }, 4000);
    if (!lClosed) {
      how = 'api';
      try { le.getContribution('editor.contrib.findController').closeFindWidget(); } catch (_) { }
      lClosed = await waitFor(() => { const w = lDom.querySelector('.find-widget'); return !(w && w.classList.contains('visible')); }, 2500);
    }
    await sleep(320);
    res.closeHow = how;
    res.lClosed = lClosed;
    res.lBack = getComputedStyle(stripOf('left')).visibility === 'visible';
    return res;
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;
            tc.a = await _execJs(dw.webContents, tcA);

            // I-B1) 右按钮点击流（右开 + 右隐 + 左可见 + 关闭回归）
            const tcB1 = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); } return fn(); };
    const stripOf = (s) => document.querySelector('#diff-container .tl-corner-btns[data-side="' + s + '"]');
    const d = window._diffEditor;
    if (!d) return { error: 'diff editor missing' };
    const re = d.getModifiedEditor();
    const rDom = re.getDomNode();
    const res = {};
    stripOf('right').querySelector('button').click();
    res.rOpen = await waitFor(() => { const w = rDom.querySelector('.find-widget'); return !!w && w.classList.contains('visible'); }, 6000);
    await sleep(280);
    res.rVisOpen = getComputedStyle(stripOf('right')).visibility === 'visible';
    res.lVis = getComputedStyle(stripOf('left')).visibility === 'visible';
    const cb = rDom.querySelector('.find-widget [class*="widget-close"]');
    if (cb) { cb.click(); } else { try { re.getContribution('editor.contrib.findController').closeFindWidget(); } catch (_) { } }
    res.rClosed = await waitFor(() => { const w = rDom.querySelector('.find-widget'); return !(w && w.classList.contains('visible')); }, 4000);
    await sleep(320);
    res.rBack = getComputedStyle(stripOf('right')).visibility === 'visible';
    return res;
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;
            tc.b1 = await _execJs(dw.webContents, tcB1);

            // I-B2) 重渲染（版本切换同级路径）后：按钮幂等复用 + 绑定重建 + 再点仍开
            const tcB2 = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); } return fn(); };
    const stripOf = (s) => document.querySelector('#diff-container .tl-corner-btns[data-side="' + s + '"]');
    try { await window.renderDiff(); } catch (_) { }
    await sleep(700);
    const res = {};
    res.stripsAfter = document.querySelectorAll('#diff-container .tl-corner-btns').length;
    res.btnsAfter = document.querySelectorAll('#diff-container .tl-float-btn').length;
    const d = window._diffEditor;
    if (!d) return { error: 'diff editor missing after rerender' };
    const lDom2 = d.getOriginalEditor().getDomNode();
    stripOf('left').querySelector('button').click();
    res.reclickOpen = await waitFor(() => { const w = lDom2.querySelector('.find-widget'); return !!w && w.classList.contains('visible'); }, 6000);
    await sleep(280);
    res.reclickVis = getComputedStyle(stripOf('left')).visibility === 'visible';
    res.reclickFocus = !!(document.activeElement && lDom2.contains(document.activeElement));
    try { d.getOriginalEditor().getContribution('editor.contrib.findController').closeFindWidget(); } catch (_) { }
    const lClosed = await waitFor(() => { const w = lDom2.querySelector('.find-widget'); return !(w && w.classList.contains('visible')); }, 4000);
    await sleep(300);
    res.lClosed2 = lClosed;
    res.endVisL = getComputedStyle(stripOf('left')).visibility;
    res.endVisR = getComputedStyle(stripOf('right')).visibility;
    return res;
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;
            tc.b2 = await _execJs(dw.webContents, tcB2);

            // 窗口缩放（主进程驱动）→ 几何随动复查
            const b0 = dw.getBounds();
            dw.setSize(b0.width + 120, b0.height + 90);
            await _sleepMs(650);
            const b1 = dw.getBounds();
            tc.resized = (b1.width !== b0.width) || (b1.height !== b0.height);
            const tcC = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(250);
    const d = window._diffEditor;
    if (!d) return { error: 'diff editor missing' };
    const lDom = d.getOriginalEditor().getDomNode(), rDom = d.getModifiedEditor().getDomNode();
    const stripOf = (s) => document.querySelector('#diff-container .tl-corner-btns[data-side="' + s + '"]');
    const edge = (strip, el) => { const a = strip.getBoundingClientRect(), b = el.getBoundingClientRect(); return { top: Math.round(a.top - b.top), right: Math.round(b.right - a.right), vis: getComputedStyle(strip).visibility }; };
    return { l: edge(stripOf('left'), lDom), r: edge(stripOf('right'), rDom) };
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;
            tc.c = await _execJs(dw.webContents, tcC);

            // I-E) 真机截图留档（图标实绘 + 让位位置视觉证据；仅信息项）
            const shotDir = 'E:/s/wol/py/qqq-shell-v2/_qqq/tmp';
            try {
                const s1 = await dw.webContents.capturePage();
                fs.writeFileSync(path.join(shotDir, 'f7_shot_closed.png'), s1.toPNG());
                tc.shotClosed = 'ok ' + s1.getSize().width + 'x' + s1.getSize().height;
            } catch (e: any) { tc.shotClosed = 'ERR ' + String(e && e.message || e); }
            try {
                tc.openLeft = await _execJs(dw.webContents, "(async()=>{ const d=window._diffEditor; if(!d) return 'no-diff'; const btn=document.querySelector('#diff-container .tl-corner-btns[data-side=\"left\"] button'); if(!btn) return 'no-btn'; btn.click(); await new Promise(r=>setTimeout(r,900)); const w=d.getOriginalEditor().getDomNode().querySelector('.find-widget'); return !!(w && w.classList.contains('visible')); })()");
                const s2 = await dw.webContents.capturePage();
                fs.writeFileSync(path.join(shotDir, 'f7_shot_open.png'), s2.toPNG());
                tc.shotOpen = 'ok';
                await _execJs(dw.webContents, "(async()=>{ try { window._diffEditor.getOriginalEditor().getContribution('editor.contrib.findController').closeFindWidget(); } catch(_){} return true; })()");
            } catch (e: any) { tc.shotOpen = 'ERR ' + String(e && e.message || e); }

            // I-D) 键盘路径（信息项：真实 Ctrl+F 键击 → 控件开 + 本侧让位；不设通过门槛）
            const tcD = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); } return fn(); };
    const d = window._diffEditor;
    if (!d) return { error: 'diff editor missing' };
    const le = d.getOriginalEditor();
    const lDom = le.getDomNode();
    const strip = document.querySelector('#diff-container .tl-corner-btns[data-side="left"]');
    le.focus();
    await sleep(150);
    const ev = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true });
    try { Object.defineProperty(ev, 'keyCode', { get: () => 70 }); } catch (_) { }
    (document.activeElement || lDom).dispatchEvent(ev);
    const open = await waitFor(() => { const w = lDom.querySelector('.find-widget'); return !!w && w.classList.contains('visible'); }, 5000);
    await sleep(300);
    const hidden = getComputedStyle(strip).visibility === 'hidden';
    try { le.getContribution('editor.contrib.findController').closeFindWidget(); } catch (_) { }
    const closed = await waitFor(() => { const w = lDom.querySelector('.find-widget'); return !(w && w.classList.contains('visible')); }, 3000);
    await sleep(300);
    const back = getComputedStyle(strip).visibility === 'visible';
    return { keyOpen: open, keyHidden: hidden, keyClosed: closed, keyBack: back };
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;
            tc.info = await _execJs(dw.webContents, tcD);
        } catch (e: any) { tc.error = String((e && e.message) || e); }
        finally { try { if (dwWin && !dwWin.isDestroyed()) { dwWin.destroy(); } } catch (_) { } }
        const _e41 = (o: any) => !!o && o.top === 41 && o.right === 8 && o.vis === 'visible';
        const tcOk = !tc.error && !!tc.open && tc.open.ok === true && !!tc.ready && tc.ready.ready === true &&
            !!tc.a && !tc.a.error && tc.a.strips === 2 && _e41(tc.a.lInit) && _e41(tc.a.rInit) &&
            !!tc.a.icoDiag && tc.a.icoDiag.styleEl === true && String(tc.a.icoDiag.mask).indexOf('data:image/svg') >= 0 && tc.a.icoDiag.w >= 12 &&
            !!tc.a.icoEnv && tc.a.icoEnv.qqqIcons === 'object' && String(tc.a.icoEnv.fetchIcons).indexOf('200') === 0 &&
            tc.a.lOpen === true && tc.a.lVis === true && tc.a.rVis === true && tc.a.rOpen === false && tc.a.focusIn === true &&
            !!tc.a.wg && tc.a.wg.wBottom === 33 && tc.a.wg.sTop === 41 && tc.a.wg.ovl === false &&
            tc.a.lClosed === true && tc.a.lBack === true &&
            !!tc.b1 && !tc.b1.error && tc.b1.rOpen === true && tc.b1.rVisOpen === true && tc.b1.lVis === true &&
            tc.b1.rClosed === true && tc.b1.rBack === true &&
            !!tc.b2 && !tc.b2.error && tc.b2.stripsAfter === 2 && tc.b2.btnsAfter === 2 && tc.b2.reclickOpen === true &&
            tc.b2.reclickVis === true && tc.b2.reclickFocus === true && tc.b2.lClosed2 === true &&
            tc.b2.endVisL === 'visible' && tc.b2.endVisR === 'visible' &&
            !!tc.c && !tc.c.error && _e41(tc.c.l) && _e41(tc.c.r);
        push('timeline-corner-buttons', tcOk, tc.error ? String(tc.error) : JSON.stringify({ open: tc.open && tc.open.ok, resized: tc.resized, shots: { closed: tc.shotClosed, open: tc.shotOpen, openLeft: tc.openLeft }, ready: tc.ready, a: tc.a, b1: tc.b1, b2: tc.b2, c: tc.c, info: tc.info }));

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
