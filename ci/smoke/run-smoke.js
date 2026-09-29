#!/usr/bin/env node
// ci/smoke/run-smoke.js — 端到端冒烟 runner（起 → 探 → 退）
//
// 用法:
//   node ci/smoke/run-smoke.js [--timeout=240000] [--keep] [--report=<path>]
//
// 流程: 建临时数据根（Data + OS 级状态全隔离）→ 起静默静态服务器（server-app → /qqqide/）
//   → spawn Electron（--smoke + --url=本地 + 隔离环境变量）→ 等子进程退出 →
//   读 smoke-report.json（渲染层就绪 / preload 桥 / IPC 往返 / fs 编码往返 / UI 骨架 逐项）
//   → 退出码（CI 直接消费）。
//
// 退出码: 0=全过 / 1=探针或 boot 失败 / 2=起不来（单例锁等 fail-fast）/ 3=前置缺失 / 124=runner 超时
//
// 隔离契约（args/env 双条件触发，详 shell/portable-paths.ts 与 shell/smoke.ts）:
//   QQQIDE_SMOKE_DATA / QQQIDE_SMOKE_OS_DIR / QQQIDE_SMOKE_OUT
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStaticServer } = require('./static-server');

const ROOT = path.resolve(__dirname, '..', '..');

function argValue(name, dflt) {
    const a = process.argv.find(s => s.startsWith('--' + name + '='));
    return a ? a.slice(name.length + 3) : dflt;
}

const TIMEOUT_MS = parseInt(argValue('timeout', '240000'), 10);
const KEEP = process.argv.includes('--keep');
const REPORT_COPY = argValue('report', '');

function log(msg) { console.log('[smoke] ' + msg); }

function rmrf(dir) {
    for (let i = 0; i < 4; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
        catch (_) { /* 句柄未释放 → 稍后重试 */ }
        try { spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'ping', '-n', '2', '127.0.0.1'] : ['-c', 'sleep 1'], { windowsHide: true }); } catch (_) { }
    }
    return false;
}

function printReport(report) {
    if (!report) { log('report: (missing)'); return; }
    log('report: ok=' + report.ok + ' phase=' + report.phase + (report.reason ? ' reason=' + report.reason : ''));
    if (report.error) { log('report.error: ' + report.error); }
    if (report.versions) { log('versions: electron=' + report.versions.electron + ' chrome=' + report.versions.chrome + ' node=' + report.versions.node); }
    if (report.timing) { log('timing: ' + JSON.stringify(report.timing)); }
    const probes = Array.isArray(report.probes) ? report.probes : [];
    for (const p of probes) {
        log('  probe ' + (p.ok ? 'PASS' : 'FAIL') + ' ' + p.id + (p.detail ? ' — ' + p.detail : ''));
    }
}

async function main() {
    // ── 前置检查 ──
    let electronPath = '';
    try { electronPath = require('electron'); } catch (_) { electronPath = ''; }
    if (!electronPath || typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
        console.error('[smoke] electron binary not found — run `npm ci` first');
        process.exit(3);
    }
    if (!fs.existsSync(path.join(ROOT, 'shell-out', 'bootstrap.js'))) {
        console.error('[smoke] shell-out/bootstrap.js missing — run `npm run build` first');
        process.exit(3);
    }

    // ── 临时数据根（Data + OS 级状态全隔离；退出即清） ──
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqq-smoke-'));
    const osDir = path.join(tempRoot, 'os');
    const reportPath = path.join(tempRoot, 'smoke-report.json');
    fs.mkdirSync(osDir, { recursive: true });
    log('temp root: ' + tempRoot);

    // ── 静态服务器（真实载荷 server-app） ──
    const server = await createStaticServer(path.join(ROOT, 'server-app'));
    const port = server.address().port;
    const url = 'http://127.0.0.1:' + port + '/qqqide/';
    log('static server: ' + url);

    // ── spawn Electron（隔离环境） ──
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.QQQIDE_DEV;
    delete env.QQQIDE_URL;
    env.QQQIDE_SMOKE_DATA = tempRoot;
    env.QQQIDE_SMOKE_OS_DIR = osDir;
    env.QQQIDE_SMOKE_OUT = reportPath;

    const args = ['.', '--smoke', '--url=' + url, '--disable-gpu'];
    log('spawn: ' + electronPath + ' ' + args.join(' '));
    const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString('utf8'); if (out.length > 500000) { out = out.slice(-250000); } });
    child.stderr.on('data', d => { err += d.toString('utf8'); if (err.length > 500000) { err = err.slice(-250000); } });

    let timedOut = false;
    const code = await new Promise(resolve => {
        let done = false;
        const to = setTimeout(() => {
            if (done) { return; }
            timedOut = true;
            log('TIMEOUT after ' + TIMEOUT_MS + 'ms — killing pid ' + child.pid);
            try {
                if (process.platform === 'win32') { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
                else { child.kill('SIGKILL'); }
            } catch (_) { /* ignore */ }
            setTimeout(() => { if (!done) { done = true; resolve(124); } }, 8000);
        }, TIMEOUT_MS);
        child.on('exit', (c, sig) => {
            if (done) { return; }
            done = true;
            clearTimeout(to);
            resolve(c === null ? (sig ? 137 : -1) : c);
        });
        child.on('error', e => {
            if (done) { return; }
            done = true;
            clearTimeout(to);
            log('spawn error: ' + e.message);
            resolve(1);
        });
    });

    // ── 收尾 ──
    try { server.close(); } catch (_) { }

    let report = null;
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (_) { /* missing */ }

    if (REPORT_COPY) {
        try {
            if (report) { fs.writeFileSync(path.resolve(REPORT_COPY), JSON.stringify(report, null, 2), 'utf8'); log('report copied → ' + path.resolve(REPORT_COPY)); }
        } catch (e) { log('report copy failed: ' + e.message); }
    }

    printReport(report);
    log('electron exit code: ' + code + (timedOut ? ' (timed out)' : ''));

    const pass = (code === 0) && !!report && report.ok === true;
    let finalCode = 0;
    if (!pass) {
        if (timedOut) { finalCode = 124; }
        else if (report) { finalCode = 1; }
        else if (code === 2 || code === 3) { finalCode = code; }
        else { finalCode = 1; }
        // 失败时打印子进程日志尾部（诊断）
        const tail = (s, n) => s.split(/\r?\n/).filter(Boolean).slice(-n).join('\n');
        if (err.trim()) { console.error('--- electron stderr (tail) ---\n' + tail(err, 60)); }
        if (out.trim()) { console.error('--- electron stdout (tail) ---\n' + tail(out, 80)); }
    }

    if (KEEP) { log('--keep: temp root kept → ' + tempRoot); }
    else if (!rmrf(tempRoot)) { log('cleanup warning: could not fully remove ' + tempRoot); }

    log(pass ? 'PASS' : 'FAIL');
    process.exit(finalCode);
}

main().catch(e => {
    console.error('[smoke] runner crashed: ' + ((e && e.stack) || e));
    process.exit(3);
});
