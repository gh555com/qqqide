// ============================================================================
// deploy.js - upload server-app/ to CN + R2 + OSS (双线热更新)
//
//   node shell-build/deploy.js --host=user@host --remote=/opt/dgs/web/qqqide
//
// Optional flags:
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
const KEY = get('key') || process.env.QQQ_DEPLOY_KEY || '';
const DRY = has('dry-run');

if (!HOST) {
  console.error('usage: node shell-build/deploy.js --host=user@host [--remote=/path] [--key=keyfile] [--dry-run]');
  process.exit(1);
}

// MSYS2 converts /opt/... → E:/s/d/git/opt/... in shell:true spawn.
// Double-slash (UNC-like) prevents this for remote SSH commands.
var isWin = process.platform === 'win32';
var isBash = !!process.env.MSYSTEM;
const REMOTE_ = isBash ? '/' + REMOTE : REMOTE;

function shellQuote(p) {
  if (isWin) return `"${String(p).replace(/"/g, '\\"')}"`;
  return `'${String(p).replace(/'/g, "'\\''")}'`;
}
function toBashPath(p) {
  return String(p).replace(/^([A-Za-z]):\\/, (_, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/');
}
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

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'server-app');
if (!fs.existsSync(SRC)) {
  console.error('server-app/ not found:', SRC);
  process.exit(1);
}

// 2026-07-14: US 已停服，CN 单节点。deploy 直达 CN。
const CN_HOST = 'q@47.105.67.51';

function sshOpts() {
  const base = ['-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes'];
  if (KEY) { base.push('-i', KEY); }
  return base;
}

// ── 1) tar server-app/ ──────────────────────────────────────────────────

const tarPath = path.join(ROOT, '_qqqide.tar.gz');
console.log('[1/5] packing server-app/ ->', tarPath);
const _tp = isBash ? toBashPath(tarPath) : tarPath;
const _sp = isBash ? toBashPath(SRC) : SRC;
run('tar', ['-czf', shellQuote(_tp), '-C', shellQuote(_sp), '.']);

// ── 2) scp to CN ────────────────────────────────────────────────────────

console.log('[2/5] scp ->', CN_HOST + ':' + REMOTE);
run('ssh', [...sshOpts(), CN_HOST, `"mkdir -p ${REMOTE_}"`]);
run('scp', [...sshOpts(), shellQuote(localPath(tarPath)), `${CN_HOST}:${REMOTE}/_qqqide.tar.gz`]);

console.log('[2/5] saving server-app.tar.gz for client hot-update');
const extractAndKeep = `"cd ${REMOTE_} && cp _qqqide.tar.gz server-app.tar.gz && tar -xzf _qqqide.tar.gz && rm _qqqide.tar.gz"`;
run('ssh', [...sshOpts(), CN_HOST, extractAndKeep]);

// ── 3) pack + upload shell-out/ ─────────────────────────────────────────

const shellOutSrc = path.join(ROOT, 'shell-out');
const shellOutTar = path.join(ROOT, '_shell-out.tar.gz');
if (fs.existsSync(shellOutSrc)) {
  console.log('[3/5] packing shell-out/ ->', shellOutTar);
  const _otp = isBash ? toBashPath(shellOutTar) : shellOutTar;
  const _osp = isBash ? toBashPath(shellOutSrc) : shellOutSrc;
  run('tar', ['-czf', shellQuote(_otp), '-C', shellQuote(_osp), '.']);
  console.log('[3/5] uploading shell-out to remote');
  run('scp', [...sshOpts(), shellQuote(localPath(shellOutTar)), `${CN_HOST}:${REMOTE}/shell-out.tar.gz`]);
  // NOTE: keep shellOutTar alive for R2/OSS upload in step 5
} else {
  console.log('[3/5] shell-out/ not found, skipping');
}

// ── 4) Generate version.json + scp ──────────────────────────────────────

const versionTs = path.join(ROOT, 'shell', 'version.ts');
let appVersion = '0.0.3';
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
const verPath = path.join(ROOT, '_version.json');
fs.writeFileSync(verPath, versionJson, 'utf8');
console.log('[4/5] version.json — shell=' + appVersion);
run('scp', [...sshOpts(), shellQuote(localPath(verPath)), `${CN_HOST}:${REMOTE}/version.json`]);

// ── 5) Upload to R2 + OSS (双线热更新 CDN) ──────────────────────────────

const UPDATE_UPLOAD_PY = path.join(ROOT, '..', 'gaea', 'cf', 'up', 'q.py');
const PYTHON = 'E:\\s\\d\\python3810\\python.exe';

console.log('[5/5] uploading to R2 + OSS Shanghai (dual-line CDN)...');
const filesForCDN = [verPath, tarPath, shellOutTar];
const allExist = filesForCDN.every(f => fs.existsSync(f));

if (allExist) {
  if (DRY) {
    console.log('[DRY-RUN] skip R2/OSS upload');
  } else {
    // call Python upload script — non-fatal (CN nginx still serves as fallback)
    try {
      const r = cp.spawnSync(PYTHON, [UPDATE_UPLOAD_PY, '--cli-update', verPath, tarPath, shellOutTar], {
        stdio: 'inherit',
        timeout: 300000,
      });
      if (r.status !== 0) {
        console.log('[5/5] ⚠️ R2/OSS upload had errors (CN nginx still available)');
      }
    } catch (e) {
      console.log('[5/5] ⚠️ R2/OSS upload failed:', e.message, '(CN nginx still available)');
    }
  }
} else {
  const missing = filesForCDN.filter(f => !fs.existsSync(f)).map(f => path.basename(f));
  console.log('[5/5] ⚠️ skipping R2/OSS — missing:', missing.join(', '));
}

// ── cleanup ─────────────────────────────────────────────────────────────

try { fs.unlinkSync(tarPath); console.log('[cleanup]', tarPath); } catch (_) { }
try { fs.unlinkSync(shellOutTar); console.log('[cleanup]', shellOutTar); } catch (_) { }
try { fs.unlinkSync(verPath); console.log('[cleanup]', verPath); } catch (_) { }

// ── done ────────────────────────────────────────────────────────────────

console.log('[deploy] done. server-app/ uploaded to CN (' + CN_HOST + ':' + REMOTE + ')');
console.log('[deploy] verify: curl https://gh555.com/qqqide/health');
