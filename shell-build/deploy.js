// ============================================================================
// deploy.js - upload server-app/ to remote http server (qqq-app/)
// Mirrors the pattern used by gaea/cf/ky.py (scp + ssh extract).
//
//   node shell-build/deploy.js --host=user@host --remote=/var/www/qqq-app
//
// Optional flags:
//   --include-portable  also push dist-pack/*.zip to remote
//   --dry-run           print actions only
// ============================================================================

const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const args = process.argv.slice(2);
const get = name => {
  const a = args.find(s => s.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : null;
};
const has = name => args.includes('--' + name);

const HOST   = get('host')   || process.env.QQQ_DEPLOY_HOST   || '';
const REMOTE = get('remote') || process.env.QQQ_DEPLOY_REMOTE || '/var/www/qqq-app';
const KEY    = get('key')    || process.env.QQQ_DEPLOY_KEY    || '';
const DRY    = has('dry-run');
const PORTABLE = has('include-portable');

if (!HOST) {
  console.error('usage: node shell-build/deploy.js --host=user@host [--remote=/path] [--key=keyfile] [--dry-run] [--include-portable]');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'server-app');
const PKG_DIR = path.join(ROOT, 'dist-pack');

if (!fs.existsSync(SRC)) {
  console.error('server-app/ not found:', SRC);
  process.exit(1);
}

function shellQuote(p) { return `'${String(p).replace(/'/g, "'\\''")}'`; }
function toBashPath(p) {
  // win path -> mingw style (E:\foo -> /e/foo) when running under git-bash
  return String(p).replace(/^([A-Za-z]):\\/, (_, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/');
}

function run(cmd, cmdArgs) {
  console.log('>', cmd, cmdArgs.join(' '));
  if (DRY) { return; }
  const r = cp.spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' },
  });
  if (r.status !== 0) { throw new Error(`failed: ${cmd}`); }
}

function sshOpts() {
  const base = ['-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes'];
  if (KEY) { base.push('-i', KEY); }
  return base;
}

// 1) tar server-app/ locally
const tarPath = path.join(ROOT, '_qqq-app.tar.gz');
console.log('[deploy] packing server-app/ ->', tarPath);
run('tar', ['-czf', shellQuote(toBashPath(tarPath)), '-C', shellQuote(toBashPath(SRC)), '.']);

// 2) scp to host
console.log('[deploy] scp ->', HOST + ':' + REMOTE);
run('ssh', [...sshOpts(), HOST, `'mkdir -p ${REMOTE}'`]);
run('scp', [...sshOpts(), shellQuote(toBashPath(tarPath)), `${HOST}:${REMOTE}/_qqq-app.tar.gz`]);

// 3) extract
console.log('[deploy] extract on remote');
run('ssh', [...sshOpts(), HOST,
  `'cd ${REMOTE} && tar -xzf _qqq-app.tar.gz && rm _qqq-app.tar.gz'`]);

// 4) optional portable zips
if (PORTABLE && fs.existsSync(PKG_DIR)) {
  const zips = fs.readdirSync(PKG_DIR).filter(n => /\.(zip|tar\.gz)$/.test(n));
  if (zips.length) {
    console.log('[deploy] uploading portable packages:', zips.length);
    run('ssh', [...sshOpts(), HOST, `'mkdir -p ${REMOTE}/portable'`]);
    for (const z of zips) {
      const src = path.join(PKG_DIR, z);
      run('scp', [...sshOpts(), shellQuote(toBashPath(src)), `${HOST}:${REMOTE}/portable/${z}`]);
    }
  }
}

// 5) cleanup local tar
try { fs.unlinkSync(tarPath); console.log('[deploy] cleanup', tarPath); } catch (_) {}

console.log('[deploy] done. server-app/ uploaded to', HOST + ':' + REMOTE);
console.log('[deploy] verify: curl http://<host>/qqq-app/health');
