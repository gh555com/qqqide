// ============================================================================
// deploy.js - upload server-app/ to remote http server (qqqide/)
// Mirrors the pattern used by gaea/cf/ky.py (scp + ssh extract).
//
//   node shell-build/deploy.js --host=user@host --remote=/opt/dgs/web/qqqide
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
const REMOTE = get('remote') || process.env.QQQ_DEPLOY_REMOTE || '/opt/dgs/web/qqqide';
// MSYS2 converts /opt/... → E:/s/d/git/opt/... in shell:true spawn.
// Double-slash (UNC-like) prevents this for remote SSH commands.
// For SCP destination paths, use raw REMOTE — SCP dest must be exact POSIX.
const REMOTE_ = isBash ? '/' + REMOTE : REMOTE;
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
var isBash = !!process.env.MSYSTEM;  // Git Bash sets MSYSTEM=MINGW64/UCRT64/...
function shellQuote(p) {
  // Windows cmd: use double quotes; Unix: single quotes
  if (isWin) return `"${String(p).replace(/"/g, '\\"')}"`;
  return `'${String(p).replace(/'/g, "'\\''")}'`;
}
function toBashPath(p) {
  // win path -> mingw style (E:\foo -> /e/foo) when running under git-bash
  return String(p).replace(/^([A-Za-z]):\\/, (_, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/');
}
// Use bash paths only when actually running under Git Bash; cmd.exe needs native paths
function localPath(p) { return isBash ? toBashPath(p) : String(p); }

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

function effectiveHost() {
  // 2026-07-08: 不论 WG 还是公网，CN→US 跨太平洋都巨慢（4 KB/s）
  // 改为两步：① SCP 到 CN（3 MB/s 秒传）② CN→US 后台异步
  // host flag 仍然指向 US，但 SCP 目标改为 CN
  if (HOST.includes('23.254.248.119')) {
    return 'q@47.105.67.51';  // SCP to CN first
  }
  return HOST;
}

function isUSDeploy() {
  return HOST.includes('23.254.248.119');
}

function sshOpts() {
  const base = ['-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes'];
  if (KEY) { base.push('-i', KEY); }
  return base;
}

// 1) tar server-app/ locally (Git Bash tar needs Unix-style paths)
const tarPath = path.join(ROOT, '_qqqide.tar.gz');
console.log('[deploy] packing server-app/ ->', tarPath);
const _tp = isBash ? toBashPath(tarPath) : tarPath;
const _sp = isBash ? toBashPath(SRC) : SRC;
run('tar', ['-czf', shellQuote(_tp), '-C', shellQuote(_sp), '.']);

// 2) scp to host
console.log('[deploy] scp ->', effectiveHost() + ':' + REMOTE);
run('ssh', [...sshOpts(), effectiveHost(), `"mkdir -p ${REMOTE_}"`]);
run('scp', [...sshOpts(), shellQuote(localPath(tarPath)), `${effectiveHost()}:${REMOTE}/_qqqide.tar.gz`]);

// 3) Keep a copy as server-app.tar.gz for client hot-update, then extract
// ★ US deploy: keep _qqqide.tar.gz for end-of-script background CN→US sync
console.log('[deploy] saving server-app.tar.gz for client hot-update');
const extractAndKeep = isUSDeploy()
  ? `"cd ${REMOTE_} && cp _qqqide.tar.gz server-app.tar.gz && tar -xzf _qqqide.tar.gz"`
  : `"cd ${REMOTE_} && cp _qqqide.tar.gz server-app.tar.gz && tar -xzf _qqqide.tar.gz && rm _qqqide.tar.gz"`;
run('ssh', [...sshOpts(), effectiveHost(), extractAndKeep]);

// 3b) pack + upload shell-out/ (for bootstrap hot-update)
const shellOutSrc = path.join(ROOT, 'shell-out');
const shellOutTar = path.join(ROOT, '_shell-out.tar.gz');
if (fs.existsSync(shellOutSrc)) {
  console.log('[deploy] packing shell-out/ ->', shellOutTar);
  const _otp = isBash ? toBashPath(shellOutTar) : shellOutTar;
  const _osp = isBash ? toBashPath(shellOutSrc) : shellOutSrc;
  run('tar', ['-czf', shellQuote(_otp), '-C', shellQuote(_osp), '.']);
  console.log('[deploy] uploading shell-out to remote');
  run('scp', [...sshOpts(), shellQuote(localPath(shellOutTar)), `${effectiveHost()}:${REMOTE}/shell-out.tar.gz`]);
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
run('scp', [...sshOpts(), shellQuote(localPath(tmpVerPath)), `${effectiveHost()}:${REMOTE}/version.json`]);
try { fs.unlinkSync(tmpVerPath); } catch { }

// 4b) Package server-app.tar.xz for client offline download (hot-update)
// Requires xz in PATH; silently skipped when unavailable (tar.gz is primary deploy artifact)
if (fs.existsSync(SRC)) {
  const xzPath = path.join(ROOT, '_server-app.tar.xz');
  const _xp = isBash ? toBashPath(xzPath) : xzPath;
  const _xs = isBash ? toBashPath(SRC) : SRC;
  let xzOk = false;
  try {
    cp.execSync('xz --version', { stdio: 'ignore' });
    xzOk = true;
  } catch (_) { }
  if (xzOk) {
    console.log('[deploy] packing server-app.tar.xz');
    run(`tar -cC ${shellQuote(_xs)} . | xz -z > ${shellQuote(_xp)}`, []);
    run('scp', [...sshOpts(), shellQuote(localPath(xzPath)), `${effectiveHost()}:${REMOTE}/server-app.tar.xz`]);
    try { fs.unlinkSync(xzPath); console.log('[deploy] cleanup', xzPath); } catch { }
  } else {
    console.log('[deploy] xz not found, skipping server-app.tar.xz');
  }
}

// 5) optional portable zips
if (PORTABLE && fs.existsSync(PKG_DIR)) {
  const zips = fs.readdirSync(PKG_DIR).filter(n => /\.(zip|tar\.gz)$/.test(n));
  if (zips.length) {
    console.log('[deploy] uploading portable packages:', zips.length);
    run('ssh', [...sshOpts(), effectiveHost(), `"mkdir -p ${REMOTE_}/portable"`]);
    for (const z of zips) {
      const src = path.join(PKG_DIR, z);
      run('scp', [...sshOpts(), shellQuote(localPath(src)), `${effectiveHost()}:${REMOTE}/portable/${z}`]);
    }
  }
}

// 6) cleanup local tar
try { fs.unlinkSync(tarPath); console.log('[deploy] cleanup', tarPath); } catch (_) { }

// 7) ★ US deploy: background CN→US sync via WireGuard (all files already on CN)
if (isUSDeploy()) {
  console.log('[deploy] CN→US background sync via WireGuard (may take 10-30 min)');
  const usHost = 'q@10.0.0.1';
  // Generate sync script locally → scp to CN → execute in bg (avoids shell quoting issues)
  const syncScript = [
    '#!/bin/bash',
    'echo "[sync] $(date) CN→US qqqide start"',
    `scp -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -r ${REMOTE}/ ${usHost}:$(dirname ${REMOTE})/`,
    `ssh -o StrictHostKeyChecking=no -o BatchMode=yes ${usHost} "cd ${REMOTE} && [ -f _qqqide.tar.gz ] && cp _qqqide.tar.gz server-app.tar.gz && tar -xzf _qqqide.tar.gz && rm _qqqide.tar.gz; echo ok"`,
    'echo "[sync] $(date) done"',
  ].join('\n');
  const syncPath = path.join(ROOT, '_deploy_sync.sh');
  fs.writeFileSync(syncPath, syncScript, 'utf8');
  run('scp', [...sshOpts(), shellQuote(localPath(syncPath)), `${effectiveHost()}:/tmp/_deploy_sync.sh`]);
  try { fs.unlinkSync(syncPath); } catch (_) { }
  run('ssh', [...sshOpts(), effectiveHost(), '"chmod +x /tmp/_deploy_sync.sh && nohup bash /tmp/_deploy_sync.sh > /tmp/_deploy_sync.log 2>&1 & echo sync_launched"']);
  console.log('[deploy] ✓ CN deploy complete. US sync in background, check: ssh q@47.105.67.51 tail /tmp/_deploy_sync.log');
}

console.log('[deploy] done. server-app/ uploaded to', effectiveHost() + ':' + REMOTE);
console.log('[deploy] verify: curl http://<host>/qqqide/health');
