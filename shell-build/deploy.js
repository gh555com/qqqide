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

const HOST = get('host') || process.env.QQQ_DEPLOY_HOST || '';
const REMOTE = get('remote') || process.env.QQQ_DEPLOY_REMOTE || '/var/www/qqq-app';
const KEY = get('key') || process.env.QQQ_DEPLOY_KEY || '';
const DRY = has('dry-run');
const PORTABLE = has('include-portable');

if (!HOST) {
  console.error('usage: node shell-build/deploy.js --host=user@host [--remote=/path] [--key=keyfile] [--dry-run] [--include-portable]');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'server-app');
const PKG_DIR = path.join(ROOT, 'dist-pack');

if (!fs.existsSync(SRC)) {
  console.error('server-app/ not found:', SRC);
  process.exit(1);
}

var isWin = process.platform === 'win32';
function shellQuote(p) {
  // Windows cmd: use double quotes; Unix: single quotes
  if (isWin) return `"${String(p).replace(/"/g, '\\"')}"`;
  return `'${String(p).replace(/'/g, "'\\''")}'`;
}
function toBashPath(p) {
  // win path -> mingw style (E:\foo -> /e/foo) when running under git-bash
  return String(p).replace(/^([A-Za-z]):\\/, (_, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/');
}
// Local file paths: keep Windows native (tar on Win10+ uses bsdtar, needs E:\... not /e/...)
function localPath(p) { return isWin ? String(p) : toBashPath(p); }

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

// 1) tar server-app/ locally (Windows: use bsdtar with native paths)
const tarPath = path.join(ROOT, '_qqq-app.tar.gz');
console.log('[deploy] packing server-app/ ->', tarPath);
if (isWin) {
  run('tar', ['-czf', shellQuote(tarPath), '-C', shellQuote(SRC), '.']);
} else {
  run('tar', ['-czf', shellQuote(toBashPath(tarPath)), '-C', shellQuote(toBashPath(SRC)), '.']);
}

// 2) scp to host
console.log('[deploy] scp ->', HOST + ':' + REMOTE);
run('ssh', [...sshOpts(), HOST, `"mkdir -p ${REMOTE}"`]);
run('scp', [...sshOpts(), shellQuote(localPath(tarPath)), `${HOST}:${REMOTE}/_qqq-app.tar.gz`]);

// 3) extract server-app
console.log('[deploy] extract server-app on remote');
run('ssh', [...sshOpts(), HOST,
`"cd ${REMOTE} && tar -xzf _qqq-app.tar.gz && rm _qqq-app.tar.gz"`]);

// 3b) pack + upload shell-out/ (for bootstrap hot-update)
const shellOutSrc = path.join(ROOT, 'shell-out');
const shellOutTar = path.join(ROOT, '_shell-out.tar.gz');
if (fs.existsSync(shellOutSrc)) {
  console.log('[deploy] packing shell-out/ ->', shellOutTar);
  if (isWin) {
    run('tar', ['-czf', shellQuote(shellOutTar), '-C', shellQuote(shellOutSrc), '.']);
  } else {
    run('tar', ['-czf', shellQuote(toBashPath(shellOutTar)), '-C', shellQuote(toBashPath(shellOutSrc)), '.']);
  }
  console.log('[deploy] uploading shell-out to remote');
  run('scp', [...sshOpts(), shellQuote(localPath(shellOutTar)), `${HOST}:${REMOTE}/shell-out.tar.gz`]);
  try { fs.unlinkSync(shellOutTar); console.log('[deploy] cleanup', shellOutTar); } catch { }
} else {
  console.log('[deploy] shell-out/ not found, skipping');
}

// 4) Generate version.json from shell/version.ts APP_VERSION (唯一真理源)
const versionTs = path.join(ROOT, 'shell', 'version.ts');
let appVersion = '0.0.3'; // fallback
if (fs.existsSync(versionTs)) {
  const content = fs.readFileSync(versionTs, 'utf8');
  const m = content.match(/export const APP_VERSION = '([^']+)'/);
  if (m) appVersion = m[1];
}
const versionJson = JSON.stringify({
  shell: appVersion,
  webapp: appVersion,
  min_shell: '0.0.1',
  _comment: 'qqq IDE version manifest — semver-based update decisions',
}, null, 2);
const tmpVerPath = path.join(ROOT, '_version.json');
fs.writeFileSync(tmpVerPath, versionJson, 'utf8');
console.log('[deploy] version.json generated — shell=' + appVersion);
run('scp', [...sshOpts(), shellQuote(localPath(tmpVerPath)), `${HOST}:${REMOTE}/version.json`]);
try { fs.unlinkSync(tmpVerPath); } catch { }

// 4b) Package server-app.tar.xz for client offline download (hot-update)
if (fs.existsSync(SRC)) {
  const xzPath = path.join(ROOT, '_server-app.tar.xz');
  console.log('[deploy] packing server-app.tar.xz');
  if (isWin) {
    run('tar', ['-cJf', shellQuote(xzPath), '-C', shellQuote(SRC), '.']);
  } else {
    run('tar', ['-cJf', shellQuote(toBashPath(xzPath)), '-C', shellQuote(toBashPath(SRC)), '.']);
  }
  run('scp', [...sshOpts(), shellQuote(localPath(xzPath)), `${HOST}:${REMOTE}/server-app.tar.xz`]);
  try { fs.unlinkSync(xzPath); console.log('[deploy] cleanup', xzPath); } catch { }
}

// 5) optional portable zips
if (PORTABLE && fs.existsSync(PKG_DIR)) {
  const zips = fs.readdirSync(PKG_DIR).filter(n => /\.(zip|tar\.gz)$/.test(n));
  if (zips.length) {
    console.log('[deploy] uploading portable packages:', zips.length);
    run('ssh', [...sshOpts(), HOST, `"mkdir -p ${REMOTE}/portable"`]);
    for (const z of zips) {
      const src = path.join(PKG_DIR, z);
      run('scp', [...sshOpts(), shellQuote(localPath(src)), `${HOST}:${REMOTE}/portable/${z}`]);
    }
  }
}

// 6) cleanup local tar
try { fs.unlinkSync(tarPath); console.log('[deploy] cleanup', tarPath); } catch (_) { }

console.log('[deploy] done. server-app/ uploaded to', HOST + ':' + REMOTE);
console.log('[deploy] verify: curl http://<host>/qqq-app/health');
