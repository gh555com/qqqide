// ============================================================================
// dev-launch.js - one-shot dev: build + dev-server + electron (--dev)
//
//   npm run dev
//
// Spawns:
//   1. esbuild watch (rebuild shell-out/ on save)
//   2. dev-server   (serve server-app/ on :8080)
//   3. electron .   (loads http://127.0.0.1:8080/qqq-app/)
//
// Press Ctrl+C to kill all.
// ============================================================================

const path = require('path');
const cp   = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '8090';

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
    setTimeout(() => process.exit(code), 800);
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// (1) esbuild watch -> rebuild shell-out/ on TS save (~30ms)
spawn('build:watch',
    process.platform === 'win32' ? 'node.exe' : 'node',
    [path.join('shell-build', 'esbuild.config.js'), '--watch']);

// (2) dev-server -> http://127.0.0.1:PORT/qqq-app/
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
    spawn('electron', electronBin, ['.', '--dev', `--url=http://127.0.0.1:${PORT}/qqq-app/`], { env: cleanEnv });
}, 600);

console.log('============================================================');
console.log('[dev-launch] dev environment starting');
console.log('[dev-launch]   dev-server  : http://127.0.0.1:' + PORT + '/qqq-app/');
console.log('[dev-launch]   build:watch : auto-rebuild shell-out/ on save');
console.log('[dev-launch]   electron    : --dev (DevTools on, no caching)');
console.log('[dev-launch] edit server-app/* -> reload window (Ctrl+R)');
console.log('[dev-launch] edit shell/*.ts   -> exit (Ctrl+C) & re-run "npm run dev"');
console.log('[dev-launch] press Ctrl+C to stop everything');
console.log('============================================================');
