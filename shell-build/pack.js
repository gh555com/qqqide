// ============================================================================
// pack.js - cross-platform portable build orchestrator
//
// Strategy:
//   * Always run electron-builder with --dir to produce the unpacked layout.
//   * On Windows host, building for non-windows targets, electron-builder may
//     fail to inject the prebuilt electron binary (known cross-build glitch).
//     Detect that case and fall back to: download official prebuilt zip
//     (electron-vX.Y.Z-<plat>-<arch>.zip) and merge with our app/.
//   * Final compress with system zip / tar.
//
//   node shell-build/pack.js --target=win-x64
//   node shell-build/pack.js --target=linux-x64
// ============================================================================

const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_VERSION = '22.3.27';

const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find(s => s.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : null;
}

const target = getArg('target') || 'win-x64';

const TARGET_MAP = {
  // unpackedDir = electron-builder's output sub-directory name
  // ebPlat = electron prebuilt name segment
  // tarExt: .zip works on win; mac .app bundles need tar.gz on win host to preserve symlinks
  'win-x64':    { plat: '--win',   arch: '--x64',   tarExt: '.zip',    unpackedDir: 'win-unpacked',     ebPlat: 'win32-x64' },
  'win-arm64':  { plat: '--win',   arch: '--arm64', tarExt: '.zip',    unpackedDir: 'win-arm64-unpacked', ebPlat: 'win32-arm64' },
  'linux-x64':  { plat: '--linux', arch: '--x64',   tarExt: '.tar.gz', unpackedDir: 'linux-unpacked',   ebPlat: 'linux-x64' },
  'linux-arm64':{ plat: '--linux', arch: '--arm64', tarExt: '.tar.gz', unpackedDir: 'linux-arm64-unpacked', ebPlat: 'linux-arm64' },
  'mac-x64':    { plat: '--mac',   arch: '--x64',   tarExt: '.tar.gz', unpackedDir: 'mac',              ebPlat: 'darwin-x64' },
  'mac-arm64':  { plat: '--mac',   arch: '--arm64', tarExt: '.tar.gz', unpackedDir: 'mac-arm64',        ebPlat: 'darwin-arm64' },
};

const cfg = TARGET_MAP[target];
if (!cfg) {
  console.error('unknown target:', target);
  console.error('valid:', Object.keys(TARGET_MAP).join(', '));
  process.exit(1);
}

console.log('[pack] target =', target);

function run(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' '));
  const r = cp.spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: true, ...opts });
  if (r.status !== 0) { throw new Error(`command failed: ${cmd}`); }
}
function tryRun(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' '));
  const r = cp.spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: true, ...opts });
  return r.status === 0;
}

// 1) verify engine binary
function ensureEngineBinary() {
  const [plat, arch] = target.split('-');
  const ext = plat === 'win' ? '.exe' : '';
  const bin = path.join(ROOT, 'engines', `q_${plat}_${arch}${ext}`);
  if (!fs.existsSync(bin)) {
    console.warn('[pack] WARNING: engine binary missing:', bin);
  } else {
    console.log('[pack] engine ok:', bin);
  }
}

// 2) electron-builder dir build
function builderDir() {
  run('npx', ['electron-builder', cfg.plat, cfg.arch, '--dir', '--config.compression=store']);
}

// Manual pure-prebuilt path: skip electron-builder entirely and assemble from
// the prebuilt electron zip + a fresh copy of our app sources. Used when
// electron-builder refuses to cross-build (e.g. mac on win host).
async function manualAssemble() {
  const distRoot = path.join(ROOT, 'dist-pack');
  const unpacked = path.join(distRoot, cfg.unpackedDir);
  fs.mkdirSync(distRoot, { recursive: true });
  if (fs.existsSync(unpacked)) { fs.rmSync(unpacked, { recursive: true, force: true }); }
  const zip = await fetchElectronPrebuilt();
  unzipTo(zip, unpacked);

  // strip default_app.asar and rename binary
  const defaultAsar = path.join(unpacked, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultAsar)) { fs.rmSync(defaultAsar); }
  if (target.startsWith('mac-')) {
    const apps = fs.readdirSync(unpacked).filter(n => n.endsWith('.app'));
    for (const a of apps) {
      const macAsar = path.join(unpacked, a, 'Contents', 'Resources', 'default_app.asar');
      if (fs.existsSync(macAsar)) { fs.rmSync(macAsar); }
      if (a !== 'qqqide.app') {
        fs.renameSync(path.join(unpacked, a), path.join(unpacked, 'qqqide.app'));
      }
    }
  } else if (target.startsWith('win-')) {
    const src = path.join(unpacked, 'electron.exe');
    const dst = path.join(unpacked, 'qqqide.exe');
    if (fs.existsSync(src)) { fs.renameSync(src, dst); }
  } else if (target.startsWith('linux-')) {
    const src = path.join(unpacked, 'electron');
    const dst = path.join(unpacked, 'qqqide');
    if (fs.existsSync(src)) { fs.renameSync(src, dst); }
  }

  // copy our app payload (minimal: shell-out + engines + boot-fallback + monaco + package.json)
  const appDst = appResourcesDir(unpacked);
  fs.mkdirSync(appDst, { recursive: true });
  function cpFile(rel) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) { return; }
    const dst = path.join(appDst, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  cpFile('shell-out');
  cpFile('shell/boot-fallback.html');
  cpFile('engines');
  cpFile('node_modules/monaco-editor/min');
  cpFile('package.json');
  console.log('[pack] manual assemble complete:', unpacked);
  return unpacked;
}

// 3) detect missing electron binary; fall back to manual prebuilt fetch
function findUnpackedDir() {
  const distRoot = path.join(ROOT, 'dist-pack');
  if (!fs.existsSync(distRoot)) { return null; }
  // exact name first
  const direct = path.join(distRoot, cfg.unpackedDir);
  if (fs.existsSync(direct)) { return direct; }
  // fuzzy
  const subs = fs.readdirSync(distRoot).filter(n =>
    fs.statSync(path.join(distRoot, n)).isDirectory()
  );
  // look for an *unpacked* dir that matches plat hints
  const hint = target.startsWith('win-') ? 'win' :
               target.startsWith('linux-') ? 'linux' :
               'mac';
  const match = subs.find(n => n.includes('unpacked') && n.includes(hint))
              || subs.find(n => n.includes('unpacked'));
  return match ? path.join(distRoot, match) : null;
}

function appResourcesDir(unpacked) {
  // electron-builder layout:
  //   linux/win:  unpacked/resources/app/
  //   mac:        unpacked/<ProductName>.app/Contents/Resources/app/
  if (target.startsWith('mac-')) {
    const candidates = fs.readdirSync(unpacked).filter(n => n.endsWith('.app'));
    if (candidates.length === 0) { return null; }
    return path.join(unpacked, candidates[0], 'Contents', 'Resources', 'app');
  }
  return path.join(unpacked, 'resources', 'app');
}

function isUnpackedComplete(unpacked) {
  // a complete unpacked tree has the electron binary at the root
  if (target.startsWith('win-')) {
    return fs.existsSync(path.join(unpacked, 'qqqide.exe')) ||
           fs.existsSync(path.join(unpacked, 'electron.exe'));
  }
  if (target.startsWith('linux-')) {
    return fs.existsSync(path.join(unpacked, 'qqqide')) ||
           fs.existsSync(path.join(unpacked, 'electron'));
  }
  if (target.startsWith('mac-')) {
    const apps = fs.readdirSync(unpacked).filter(n => n.endsWith('.app'));
    return apps.length > 0;
  }
  return false;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log('[pack] download', url);
    const file = fs.createWriteStream(dest);
    let timer = null;
    const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const get = (u, hops = 0) => {
      if (hops > 8) { cleanup(); file.close(); fs.unlink(dest, () => {}); return reject(new Error('too many redirects')); }
      const req = https.get(u, { timeout: 30000 }, res => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.resume();
          return get(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          cleanup(); file.close(); fs.unlink(dest, () => {});
          return reject(new Error('http ' + res.statusCode + ' for ' + u));
        }
        res.pipe(file);
        file.on('finish', () => { cleanup(); file.close(resolve); });
      });
      req.on('timeout', () => { req.destroy(new Error('connect/read timeout')); });
      req.on('error', err => { cleanup(); file.close(); fs.unlink(dest, () => {}); reject(err); });
    };
    get(url);
  });
}

async function fetchElectronPrebuilt() {
  const cacheDir = path.join(ROOT, 'shell-build', '_cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const fname = `electron-v${ELECTRON_VERSION}-${cfg.ebPlat}.zip`;
  const local = path.join(cacheDir, fname);
  if (fs.existsSync(local) && fs.statSync(local).size > 1024 * 1024) {
    console.log('[pack] using cached', local);
    return local;
  }
  // try multiple mirrors (github first, then china mirrors)
  const mirrors = [
    `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${fname}`,
    `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/${fname}`,
    `https://registry.npmmirror.com/-/binary/electron/${ELECTRON_VERSION}/${fname}`,
    `https://cdn.npmmirror.com/binaries/electron/${ELECTRON_VERSION}/${fname}`,
  ];
  let lastErr = null;
  for (const url of mirrors) {
    try {
      await downloadFile(url, local);
      return local;
    } catch (err) {
      console.warn('[pack] mirror failed:', url, '->', err.message);
      lastErr = err;
      try { fs.unlinkSync(local); } catch (_) {}
    }
  }
  throw lastErr || new Error('all mirrors failed');
}

function unzipTo(zipPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // try powershell on win, unzip elsewhere
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${dest}' -Force`]);
  } else {
    run('unzip', ['-q', '-o', zipPath, '-d', dest]);
  }
}

async function repairUnpacked(unpacked) {
  console.log('[pack] unpacked tree missing electron binary, repairing manually');
  const zip = await fetchElectronPrebuilt();

  // capture our app/ before electron unzip overwrites resources/
  const appSrc = appResourcesDir(unpacked);
  const appBackup = path.join(ROOT, 'dist-pack', '_app_backup_' + target);
  if (fs.existsSync(appBackup)) { fs.rmSync(appBackup, { recursive: true, force: true }); }
  if (appSrc && fs.existsSync(appSrc)) {
    fs.cpSync(appSrc, appBackup, { recursive: true });
    console.log('[pack] backed up app resources ->', appBackup);
  }

  // wipe existing partial unpacked, replace with prebuilt extraction
  fs.rmSync(unpacked, { recursive: true, force: true });
  unzipTo(zip, unpacked);

  // strip default_app.asar to force loading our app/ instead
  const defaultAsar = path.join(unpacked, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultAsar)) {
    fs.rmSync(defaultAsar);
    console.log('[pack] removed default_app.asar');
  }
  // mac path
  if (target.startsWith('mac-')) {
    const apps = fs.readdirSync(unpacked).filter(n => n.endsWith('.app'));
    for (const a of apps) {
      const macAsar = path.join(unpacked, a, 'Contents', 'Resources', 'default_app.asar');
      if (fs.existsSync(macAsar)) { fs.rmSync(macAsar); console.log('[pack] removed', macAsar); }
    }
  }

  // rename binary to qqqide
  if (target.startsWith('win-')) {
    const src = path.join(unpacked, 'electron.exe');
    const dst = path.join(unpacked, 'qqqide.exe');
    if (fs.existsSync(src)) { fs.renameSync(src, dst); console.log('[pack] renamed electron.exe -> qqqide.exe'); }
  } else if (target.startsWith('linux-')) {
    const src = path.join(unpacked, 'electron');
    const dst = path.join(unpacked, 'qqqide');
    if (fs.existsSync(src)) { fs.renameSync(src, dst); console.log('[pack] renamed electron -> qqqide'); }
  } else if (target.startsWith('mac-')) {
    // electron prebuilt mac comes as Electron.app; rename to qqqide.app
    const apps = fs.readdirSync(unpacked).filter(n => n.endsWith('.app'));
    for (const a of apps) {
      if (a === 'qqqide.app') { continue; }
      const src = path.join(unpacked, a);
      const dst = path.join(unpacked, 'qqqide.app');
      fs.renameSync(src, dst);
      console.log('[pack] renamed', a, '-> qqqide.app');
    }
  }

  // restore app resources
  if (fs.existsSync(appBackup)) {
    const dstApp = appResourcesDir(unpacked);
    fs.mkdirSync(path.dirname(dstApp), { recursive: true });
    if (fs.existsSync(dstApp)) { fs.rmSync(dstApp, { recursive: true, force: true }); }
    fs.cpSync(appBackup, dstApp, { recursive: true });
    fs.rmSync(appBackup, { recursive: true, force: true });
    console.log('[pack] restored app resources ->', dstApp);
  }
}

// 4) compress
function packDir(unpacked) {
  const distRoot = path.join(ROOT, 'dist-pack');
  const outName = `qqqide-${target}${cfg.tarExt}`;
  const out = path.join(distRoot, outName);
  if (fs.existsSync(out)) { fs.rmSync(out); }
  console.log('[pack] zipping', path.basename(unpacked), '->', out);
  if (cfg.tarExt === '.zip') {
    if (process.platform === 'win32') {
      run('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${unpacked}\\*' -DestinationPath '${out}' -Force`]);
    } else {
      run('zip', ['-r', '-9', out, '.'], { cwd: unpacked });
    }
  } else {
    // tar from inside the unpacked dir to avoid windows path C:\ issues
    run('tar', ['-czf', `../${outName}`, '.'], { cwd: unpacked });
  }
}

(async () => {
  ensureEngineBinary();
  // mac builds on non-mac hosts must use manual assembly (electron-builder refuses)
  const isCrossMac = target.startsWith('mac-') && process.platform !== 'darwin';
  let unpacked;
  if (isCrossMac) {
    unpacked = await manualAssemble();
  } else {
    builderDir();
    unpacked = findUnpackedDir();
    if (!unpacked) {
      console.error('[pack] electron-builder produced no unpacked dir, aborting');
      process.exit(1);
    }
    if (!isUnpackedComplete(unpacked)) {
      await repairUnpacked(unpacked);
    } else {
      console.log('[pack] unpacked tree complete:', unpacked);
    }
  }
  packDir(unpacked);
  console.log('[pack] done. output -> dist-pack/');
  console.log('[pack] win-unpacked/ kept as ready-to-run s environment (same as zip)');
})().catch(err => {
  console.error('[pack] failed:', err);
  process.exit(1);
});
