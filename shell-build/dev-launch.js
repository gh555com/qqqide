// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// dev-launch.js - one-shot dev: build + dev-server + electron (--dev)
//
//   npm run dev
//
// Spawns:
//   1. esbuild watch (rebuild shell-out/ on save)
//   2. dev-server   (serve server-app/ on :8080)
//   3. electron .   (loads http://127.0.0.1:8080/qqqide/)
//
// Press Ctrl+C to kill all.
// ============================================================================

const path = require('path');
const cp   = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '8090';

// ★ 启动前清端口：杀掉占用 PORT 的进程（残留 node/electron 实例）
function killPortHolder(port) {
    try {
        if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            const out = execSync('netstat -ano | findstr :' + port, { encoding: 'utf8', timeout: 3000 });
            const lines = out.split(/\r?\n/).filter(function(l) { return l.includes('LISTENING'); });
            const pids = [];
            const seen = {};
            for (var i = 0; i < lines.length; i++) {
                var parts = lines[i].trim().split(/\s+/);
                var pid = parts[parts.length - 1];
                if (pid && /^\d+$/.test(pid) && !seen[pid]) { seen[pid] = true; pids.push(pid); }
            }
            for (var j = 0; j < pids.length; j++) {
                try {
                    console.log('[dev-launch] killing port ' + port + ' holder pid=' + pids[j]);
                    execSync('taskkill /PID ' + pids[j] + ' /F /T', { timeout: 3000 });
                } catch (_) {}
            }
        } else {
            const { execSync } = require('child_process');
            try { execSync('lsof -ti:' + port + ' | xargs -r kill -9', { timeout: 3000 }); } catch (_) {}
        }
    } catch (_) {}
}
killPortHolder(PORT);

const children = [];
let shuttingDown = false;

function spawn(label, cmd, args, opts = {}) {
    const child = cp.spawn(cmd, args, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
        env: opts.env || process.env,
    });
    children.push({ label, child });
    child.on('exit', (code, sig) => {
        console.log(`[dev-launch] ${label} exited code=${code} sig=${sig}`);
        if (!shuttingDown) { shutdown(code || 0); }
    });
    return child;
}

function shutdown(code) {
    if (shuttingDown) { return; }
    shuttingDown = true;
    console.log('\n[dev-launch] shutting down...');
    for (const { label, child } of children) {
        try {
            console.log(`[dev-launch] kill ${label} (pid ${child.pid})`);
            if (process.platform === 'win32') {
                cp.exec(`taskkill /pid ${child.pid} /T /F`);
            } else {
                child.kill('SIGTERM');
            }
        } catch (_) {}
    }
    // ★ 额外清扫残留引擎进程（q_win_x64.exe / ghrun.exe）
    if (process.platform === 'win32') {
        try { cp.execSync('taskkill /F /IM q_win_x64.exe /T 2>nul', { timeout: 3000 }); } catch (_) {}
        try { cp.execSync('taskkill /F /IM q_win_arm64.exe /T 2>nul', { timeout: 3000 }); } catch (_) {}
        try { cp.execSync('taskkill /F /IM ghrun.exe /T 2>nul', { timeout: 3000 }); } catch (_) {}
    }
    setTimeout(() => process.exit(code), 800);
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// (1) esbuild watch — 已禁用（虚存泄漏）。改 shell/*.ts 后手动 npm run build
// spawn('build:watch',
//     process.platform === 'win32' ? 'node.exe' : 'node',
//     [path.join('shell-build', 'esbuild.config.js'), '--watch']);

// (2) dev-server -> http://127.0.0.1:PORT/qqqide/
spawn('dev-server',
    process.platform === 'win32' ? 'node.exe' : 'node',
    [path.join('shell-build', 'dev-server.js'), `--port=${PORT}`]);

// give the dev server ~600ms to bind before electron probes /health
setTimeout(() => {
    const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    // MUST strip ELECTRON_RUN_AS_NODE / VSCODE vars inherited from IDE,
    // otherwise electron.exe runs in pure Node mode and require('electron') is broken.
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    delete cleanEnv.ELECTRON_NO_ASAR;
    Object.keys(cleanEnv).forEach(k => { if (k.startsWith('VSCODE_')) delete cleanEnv[k]; });
    spawn('electron', electronBin, ['.', '--dev', `--url=http://127.0.0.1:${PORT}/qqqide/`], { env: cleanEnv });
}, 600);

console.log('============================================================');
console.log('[dev-launch] dev environment starting');
console.log('[dev-launch]   dev-server  : http://127.0.0.1:' + PORT + '/qqqide/');
console.log('[dev-lau   build:watch : [disabled] manual npm run build for shell changessave');
console.log('[dev-launch]   electron    : --dev (DevTools on, no caching)');
console.log('[dev-launch] edit server-app/* -> reload window (Ctrl+R)');
console.log('[dev-launch] edit shell/*.ts   -> exit (Ctrl+C) & re-run "npm run dev"');
console.log('[dev-launch] press Ctrl+C to stop everything');
console.log('============================================================');
