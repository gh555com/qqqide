// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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
const os = require('os');

// ★ 打包进程内剥离代理环境变量：Electron 二进制统一走国内 npmmirror 直连，
// 环境代理（如 127.0.0.1:10808）若未运行 → electron-builder 下载 proxyconnect 被拒（2026-08-09 F17 事故）。
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
                  'http_proxy', 'https_proxy', 'all_proxy',
                  'HTTP_PROXYQ', 'HTTPS_PROXYQ']) {
  delete process.env[k];
}

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_VERSION = '22.3.27';

// ★ Electron 二进制下载镜像：GitHub 直连在国内不稳定（EOF 中断），
// 统一走 npmmirror（@electron/get 拼接为 .../v22.3.27/electron-v22.3.27-<plat>-<arch>.zip，该路径存在）。
if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}

// Read APP_VERSION from shell/version.ts (single source of truth)
const versionTs = fs.readFileSync(path.join(ROOT, 'shell', 'version.ts'), 'utf8');
const vm = versionTs.match(/export const APP_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/);
const APP_VERSION = vm ? vm[1] : '0.0.0';

const args = process.argv.slice(2);
function getArg(name) {
  const a = args.find(s => s.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : null;
}

const target = getArg('target') || 'win-x64';
const doSfx = args.includes('--sfx');
const doFlat = args.includes('--flat');

const TARGET_MAP = {
  // unpackedDir = electron-builder's output sub-directory name
  // ebPlat = electron prebuilt name segment
  // tarExt: .zip works on win; mac .app bundles need tar.gz on win host to preserve symlinks
  'win-x64': { plat: '--win', arch: '--x64', tarExt: '.zip', unpackedDir: 'win-unpacked', ebPlat: 'win32-x64' },
  'win-arm64': { plat: '--win', arch: '--arm64', tarExt: '.zip', unpackedDir: 'win-arm64-unpacked', ebPlat: 'win32-arm64' },
  'linux-x64': { plat: '--linux', arch: '--x64', tarExt: '.tar.gz', unpackedDir: 'linux-unpacked', ebPlat: 'linux-x64' },
  'linux-arm64': { plat: '--linux', arch: '--arm64', tarExt: '.tar.gz', unpackedDir: 'linux-arm64-unpacked', ebPlat: 'linux-arm64' },
  'mac-x64': { plat: '--mac', arch: '--x64', tarExt: '.tar.gz', unpackedDir: 'mac', ebPlat: 'darwin-x64' },
  'mac-arm64': { plat: '--mac', arch: '--arm64', tarExt: '.tar.gz', unpackedDir: 'mac-arm64', ebPlat: 'darwin-arm64' },
};

// resolve target — supports win-x64-sfx shorthand
const isSfx = doSfx || target.endsWith('-sfx');
const baseTarget = isSfx ? target.replace(/-sfx$/, '') : target;
const baseCfg = TARGET_MAP[baseTarget];
if (!baseCfg) {
  console.error('unknown target:', target);
  console.error('valid:', Object.keys(TARGET_MAP).join(', ') + (isSfx ? '' : ', win-x64-sfx, win-arm64-sfx'));
  process.exit(1);
}
const cfg = baseCfg; // unified — cfg always refers to the base platform config
const isWin = baseTarget.startsWith('win-');

console.log('[pack] target =', target, isSfx ? '(SFX self-extracting exe)' : '');

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

// ★ electron-builder 工具缓存钉定（2026-08-10）：C 启动器便携层把 LOCALAPPDATA
// 重定向到绿色包 Data → app-builder 去绿色包缓存找 winCodeSign 缺失 → GitHub
// 直连超时 → 打包失败。钉定 ELECTRON_BUILDER_CACHE 到项目 Data（预置完整
// winCodeSign-2.6.0，rcedit 改图标/版本信息必需）→ 零下载确定性；mirror 兜底 npmmirror。
function ebEnv() {
  const cacheDir = path.join(ROOT, 'Data', 'LocalAppData', 'electron-builder', 'Cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) { }
  return {
    ...process.env,
    ELECTRON_BUILDER_CACHE: cacheDir,
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  };
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
  // ★ webapp: bundle server-app/ so first boot is instant + offline-capable
  {
    const src = path.join(ROOT, 'server-app');
    const dst = path.join(appDst, 'webapp');
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      console.log('[pack] bundled webapp/ (server-app) for offline first boot');
    } else {
      console.warn('[pack] server-app/ not found, skipping webapp bundle');
    }
  }
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
  //   linux/win:  unpacked/core/resources/app/ (after injectLauncher)
  //               unpacked/resources/app/     (before injectLauncher)
  //   mac:        unpacked/<ProductName>.app/Contents/Resources/app/
  if (target.startsWith('mac-')) {
    const candidates = fs.readdirSync(unpacked).filter(n => n.endsWith('.app'));
    if (candidates.length === 0) { return null; }
    return path.join(unpacked, candidates[0], 'Contents', 'Resources', 'app');
  }
  // check post-move path first
  const corePath = path.join(unpacked, 'gh555.com', 'resources', 'app');
  if (fs.existsSync(corePath)) { return corePath; }
  return path.join(unpacked, 'resources', 'app');
}

function isUnpackedComplete(unpacked) {
  // a complete unpacked tree has the electron binary at the root
  if (target.startsWith('win-')) {
    return fs.existsSync(path.join(unpacked, 'qqqide.exe')) ||
      fs.existsSync(path.join(unpacked, 'qqqide-core.exe')) ||
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
      if (hops > 8) { cleanup(); file.close(); fs.unlink(dest, () => { }); return reject(new Error('too many redirects')); }
      const req = https.get(u, { timeout: 30000 }, res => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.resume();
          return get(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          cleanup(); file.close(); fs.unlink(dest, () => { });
          return reject(new Error('http ' + res.statusCode + ' for ' + u));
        }
        res.pipe(file);
        file.on('finish', () => { cleanup(); file.close(resolve); });
      });
      req.on('timeout', () => { req.destroy(new Error('connect/read timeout')); });
      req.on('error', err => { cleanup(); file.close(); fs.unlink(dest, () => { }); reject(err); });
    };
    get(url);
  });
}

// ★ Electron 发行版缓存目录 — 与 @electron/get 同款（%LOCALAPPDATA%/electron/Cache），
// electron-builder 装配时直接命中，manualAssemble/repair 也读同一缓存，零重复下载。
function electronCacheDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'electron', 'Cache');
}

// ★ 本机 npm 安装的 Electron 发行版（node_modules/electron/dist）→ electron-builder
// 直接用 electronDist 装配 → 打包零下载零网络。仅当目标平台与本机发行版一致时可用。
function localElectronDist() {
  if (process.platform !== 'win32' || baseTarget !== 'win-x64') { return null; }
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (fs.existsSync(path.join(dist, 'electron.exe')) &&
      fs.existsSync(path.join(dist, 'version')) &&
      fs.existsSync(path.join(dist, 'resources', 'default_app.asar'))) {
    return dist;
  }
  return null;
}

// ★ 预热 @electron/get 缓存：缓存缺失时从国内镜像直连下载（进程内已剥离代理）。
async function warmElectronCache() {
  const fname = `electron-v${ELECTRON_VERSION}-${cfg.ebPlat}.zip`;
  const dest = path.join(electronCacheDir(), fname);
  fs.mkdirSync(electronCacheDir(), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
    console.log('[pack] electron cache hit:', dest);
    return dest;
  }
  // try multiple mirrors (npmmirror first — GitHub 直连 EOF 不稳定，仅兜底)
  const mirrors = [
    `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/${fname}`,
    `https://registry.npmmirror.com/-/binary/electron/${ELECTRON_VERSION}/${fname}`,
    `https://cdn.npmmirror.com/binaries/electron/${ELECTRON_VERSION}/${fname}`,
    `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${fname}`,
  ];
  let lastErr = null;
  for (const url of mirrors) {
    try {
      await downloadFile(url, dest);
      console.log('[pack] electron cache warmed:', dest);
      return dest;
    } catch (err) {
      console.warn('[pack] mirror failed:', url, '->', err.message);
      lastErr = err;
      try { fs.unlinkSync(dest); } catch (_) { }
    }
  }
  throw lastErr || new Error('all mirrors failed');
}

async function fetchElectronPrebuilt() {
  const local = await warmElectronCache();
  return local;
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

  // rename binary to qqqide-core
  if (target.startsWith('win-')) {
    const src = path.join(unpacked, 'electron.exe');
    const dst = path.join(unpacked, 'qqqide-core.exe');
    if (fs.existsSync(src)) { fs.renameSync(src, dst); console.log('[pack] renamed electron.exe -> qqqide-core.exe'); }
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

// 3.5) inject root-level config files into unpacked // 3.6) inject native launcher (win only) — moves all Electron runtime to core/, places C splash as qqqide.exe
function injectLauncher(unpacked) {
  if (!target.startsWith('win-')) { return; }

  // ★ 运行时状态文件禁入 r（2026-08-10）: engines/.versions.json + .downloads.json 是
  //   开发机组件安装状态（含 verified_at），打进 r 会与 versions.json 清单错配。
  //   新 r 组件版本由清单唯一决定，component-checker 首启全量重建（bundled 跳过下载）。
  const _engRuntime = path.join(appResourcesDir(unpacked) || '', 'engines');
  for (const _f of ['.versions.json', '.downloads.json']) {
    const _fp = path.join(_engRuntime, _f);
    if (fs.existsSync(_fp)) {
      fs.rmSync(_fp, { force: true });
      console.log('[pack] pruned runtime state: engines/' + _f);
    }
  }
  const launcherSrc = path.join(ROOT, 'launcher', 'qqqide.exe');
  if (!fs.existsSync(launcherSrc)) {
    console.warn('[pack] launcher binary not found, skipping:', launcherSrc);
    return;
  }
  const coreDir = path.join(unpacked, 'gh555.com');
  fs.mkdirSync(coreDir, { recursive: true });

  // ── 搬 Electron 运行时文件到 gh555.com/ ──
  const electronFiles = [
    // binary
    'electron.exe', 'qqqide.exe',
    // DLLs
    'd3dcompiler_47.dll', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll',
    // Chromium resources
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak',
    'snapshot_blob.bin', 'v8_context_snapshot.bin', 'icudtl.dat',
    // directories
    'locales', 'resources',
  ];
  for (const name of electronFiles) {
    const src = path.join(unpacked, name);
    const dst = path.join(coreDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.renameSync(src, dst);
    }
  }
  // rename whatever binary ended up in gh555.com/ to joker.exe
  const coreExe = path.join(coreDir, 'joker.exe');
  for (const candidate of ['electron.exe', 'qqqide.exe']) {
    const bin = path.join(coreDir, candidate);
    if (fs.existsSync(bin) && !fs.existsSync(coreExe)) {
      fs.renameSync(bin, coreExe);
      console.log('[pack] renamed ' + candidate + ' -> joker.exe');
      break;
    }
  }
  console.log('[pack] moved Electron runtime -> gh555.com/');

  // ★ 唯一版本权威 = versions.json（2026-08-10 重构）
  //   版本 = 精确组件矩阵：id(清单编号) + launcher + shell + webapp + rank 快照。
  //   任何组件版本变更（含降级）只能通过发新 r（新 versions.json）完成。
  const versions = buildVersionsJson();
  const manifestJson = JSON.stringify(versions);
  fs.writeFileSync(path.join(coreDir, 'versions.json'), manifestJson, 'utf8');
  console.log('[pack] wrote versions.json =', manifestJson);

  // ★ 过渡兼容（2026-08-10 至客户端全量 ≥ 本版本）: 旧启动器残缺判定要求 next/.version 存在，
  //   新 r 必须双写 .version（旧启动器可交换）→ 新启动器不再读它。全量铺开后删除此行。
  fs.writeFileSync(path.join(coreDir, '.version'), APP_VERSION, 'utf8');
  console.log('[pack] wrote .version (transition compat) =', APP_VERSION);

  // ── 复制 C 启动器为根 qqqide.exe ──
  const launcherDst = path.join(unpacked, 'qqqide.exe');
  fs.cpSync(launcherSrc, launcherDst, { force: true });
  console.log('[pack] injected launcher -> qqqide.exe (' + fs.statSync(launcherSrc).size + 'B)');

  // ★ Bootstrap Config — 隐藏在 gh555.com/Data/ 下，不污染根目录
  const cfgSrc = path.join(ROOT, 'launcher', 'launcher-config.json');
  if (fs.existsSync(cfgSrc)) {
    const dataDir = path.join(coreDir, 'Data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.cpSync(cfgSrc, path.join(dataDir, 'launcher-config.json'), { force: true });
    console.log('[pack] injected launcher-config.json -> gh555.com/Data/');
  }

  // ★ 本地单元状态预注入 r（gh555.com/Data/units.json）: 全新安装首启即有本地状态
  //   → 第一次更新即可走增量（不必先全量 r 建立状态）。Data 不参与任何单元，随交换保留。
  //   必须在此注入（打包 payload 之前）—— buildUnits 在 r 组装之后才执行，届时已太迟。
  try {
    const luPath = path.join(coreDir, 'Data', 'units.json');
    fs.mkdirSync(path.dirname(luPath), { recursive: true });
    const lu = { id: APP_VERSION, units: {
      launcher: versions.launcher,
      core: ELECTRON_VERSION,
      app: versions.shell,
      'shell-out': versions.shell,
      webapp: versions.webapp,
    } };
    fs.writeFileSync(luPath, JSON.stringify(lu));
    console.log('[pack] injected Data/units.json (fresh-install unit state)');
  } catch (e) {
    console.warn('[pack] Data/units.json inject failed:', e.message);
  }

  // ★ factory_version — 出厂版本唯一注入点（wq-ping 读 userData/alphal/factory_version）
  //   保险库 = gh555.com/Data（交换守卫自动备份恢复）；升级时新包 Data 被用户 Data 覆盖
  //   → 已装用户保留首装版本（符合"首次上报后永不改"），全新安装拿到本包版本。
  //   2026-08-10：以 versions.json 的 id 为准（与左下角/启动器同一权威）。
  try {
    const fvDir = path.join(coreDir, 'Data', 'alphal');
    fs.mkdirSync(fvDir, { recursive: true });
    fs.writeFileSync(path.join(fvDir, 'factory_version'), APP_VERSION, 'utf8');
    console.log('[pack] injected factory_version =', APP_VERSION, '-> gh555.com/Data/alphal/');
  } catch (e) {
    console.warn('[pack] factory_version inject failed:', e.message);
  }
}

// ★ 唯一版本权威数据（2026-08-10）: versions.json 与单元清单共用同一对象，保证逐字一致
function buildVersionsJson() {
  let launcherVersion = 'unknown';
  try {
    const lc = fs.readFileSync(path.join(ROOT, 'launcher', 'launcher.c'), 'utf8');
    const lm = lc.match(/#define LAUNCHER_VERSION\s+"(\S+)"/);
    if (lm) launcherVersion = lm[1];
  } catch { }
  const rankSnapshot = {};
  try {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'engines', 'manifest.json'), 'utf8'));
    if (man && man.components) {
      for (const [name, def] of Object.entries(man.components)) {
        if (def && typeof def.version === 'string') rankSnapshot[name] = def.version;
      }
    }
  } catch { }
  return {
    id: APP_VERSION,
    launcher: launcherVersion,
    shell: APP_VERSION,
    webapp: APP_VERSION,
    rank: rankSnapshot,
  };
}

function copyTreeExcluding(src, dst, excludes) {
  // excludes 支持多段路径（'resources/app'）→ 精确匹配相对路径，父目录递归、命中段整枝跳过
  const ex = (excludes || []).map(p => p.split('/').filter(Boolean).join('/'));
  function walk(s, d, rel) {
    fs.mkdirSync(d, { recursive: true });
    for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ex.includes(r)) continue;
      const sp = path.join(s, ent.name);
      const dp = path.join(d, ent.name);
      if (ent.isDirectory()) walk(sp, dp, r);
      else fs.copyFileSync(sp, dp);
    }
  }
  walk(src, dst, '');
}

// ★ 单元增量传输产物（2026-08-10 B 方案）
//   哲学: 增量 = 纯传输优化，正确性零责任；版本权威仍是 versions.json（F33）。
//   单元 = 架构层目录（launcher/core/app/shell-out/webapp 固定 5 个），单元数不随
//   项目复杂度增长——新文件自动落入 core（gh555.com 根补集）或 app（resources/app 补集）。
//   engines/* 不参与增量（component-checker 独立按 manifest 管理，防覆盖组件升级）。
//   每个单元 = 7zCon.sfx + 7z（与 r 同机制），路径相对 gh555.com 根，解压进 gh555.com-next。
//   产物: dist-pack/qqqide-up/units.json + dist-pack/qqqide-up/u/{id}/*.7z（版本不可变，CDN 可缓存）
function buildUnits(unpacked, rFile) {
  if (!target.startsWith('win-')) return;
  const sz7 = find7z();
  if (!sz7) {
    // ★ 2026-08-11 早退清陈旧清单: find7z 失败静默返回时，旧 units.json (id≠当前版)
    //   残留 dist-pack/qqqide-up → 后续 q.py 发布读到旧清单但 u/{旧id}/ 已被重建清掉
    //   → 上传 WinError 3 半程 FATAL (0.2.360 发布事故)。清掉后 q.py 自动跳过增量。
    try {
      const staleU = path.join(ROOT, 'dist-pack', 'qqqide-up', 'units.json');
      if (fs.existsSync(staleU)) {
        const m = JSON.parse(fs.readFileSync(staleU, 'utf8'));
        if (m.id !== APP_VERSION) fs.rmSync(staleU, { force: true });
      }
    } catch (_) { }
    return;
  }
  const sfx = path.join(path.dirname(sz7), '7zCon.sfx');
  if (!fs.existsSync(sfx)) throw new Error('7zCon.sfx not found');

  const distRoot = path.join(ROOT, 'dist-pack');
  const upRoot = path.join(distRoot, 'qqqide-up');
  const unitDir = path.join(upRoot, 'u', APP_VERSION);
  const stageRoot = path.join(upRoot, '_stage');
  if (fs.existsSync(upRoot)) fs.rmSync(upRoot, { recursive: true, force: true });
  fs.mkdirSync(unitDir, { recursive: true });

  const coreDir = path.join(unpacked, 'gh555.com');
  const appDir = path.join(coreDir, 'resources', 'app');
  const versions = buildVersionsJson();

  const units = [
    { name: 'launcher', rel: 'launcher-next.exe', version: versions.launcher,
      src: path.join(ROOT, 'launcher', 'qqqide.exe'), single: true, exclude: [] },
    { name: 'core', rel: '', version: ELECTRON_VERSION,
      src: coreDir, single: false, exclude: ['Data', 'versions.json', '.version', 'launcher-next.exe', 'resources/app'] },
    { name: 'app', rel: 'resources/app', version: versions.shell,
      src: appDir, single: false, exclude: ['shell-out', 'server-app', 'webapp', 'engines'] },
    { name: 'shell-out', rel: 'resources/app/shell-out', version: versions.shell,
      src: path.join(appDir, 'shell-out'), single: false, exclude: [] },
    { name: 'webapp', rel: 'resources/app/server-app', version: versions.webapp,
      src: path.join(appDir, 'server-app'), single: false, exclude: [] },
  ];

  const manifestUnits = [];
  for (const u of units) {
    if (!fs.existsSync(u.src)) {
      console.warn('[pack] unit source missing, skipping:', u.name, u.src);
      continue;
    }
    const stage = path.join(stageRoot, u.name);
    const dstRoot = u.rel ? path.join(stage, ...u.rel.split('/').filter(Boolean)) : stage;
    if (u.single) {
      fs.mkdirSync(path.dirname(dstRoot), { recursive: true });
      fs.copyFileSync(u.src, dstRoot);
    } else {
      copyTreeExcluding(u.src, dstRoot, u.exclude);
    }
    const arc = path.join(unitDir, u.name + '.7z');
    const r = cp.spawnSync(sz7, ['a', '-t7z', '-mx=9', '-md=64m', '-mmt=on', arc, '.'],
      { stdio: 'inherit', cwd: stage });
    if (r.status !== 0) throw new Error('unit 7z failed: ' + u.name);
    const sfxBlob = arc + '.sfx';
    cp.spawnSync('cmd', ['/c', 'copy', '/b', sfx, '+', arc, sfxBlob], { stdio: 'inherit' });
    fs.rmSync(arc);
    fs.renameSync(sfxBlob, arc);
    manifestUnits.push({
      name: u.name, rel: u.rel, version: u.version,
      bytes: fs.statSync(arc).size,
      file: `u/${APP_VERSION}/${u.name}.7z`,
    });
    console.log('[pack] unit:', u.name, '(' + (u.rel || '(root)') + ')',
      Math.round(fs.statSync(arc).size / 1024), 'KB');
  }
  fs.rmSync(stageRoot, { recursive: true, force: true });

  const manifest = { id: APP_VERSION, r_bytes: fs.statSync(rFile).size, versions, units: manifestUnits };
  fs.writeFileSync(path.join(upRoot, 'units.json'), JSON.stringify(manifest));

  console.log('[pack] units manifest:', manifest.id, manifestUnits.length, 'units, r_bytes =', manifest.r_bytes);
}

// 3.6b) inject VC runtime (app-local deployment) — assets/runtimes/win32-x64 → engines/vc_runtime/win32-x64
function injectVcRuntime(unpacked) {
  if (!target.startsWith('win-')) return;
  const src = path.join(ROOT, 'assets', 'runtimes', 'win32-x64');
  if (!fs.existsSync(src)) { console.warn('[pack] assets/runtimes/win32-x64 not found, skipping vc_runtime'); return; }
  const appDir = appResourcesDir(unpacked);
  if (!appDir || !fs.existsSync(appDir)) return;
  const dst = path.join(appDir, 'engines', 'vc_runtime', 'win32-x64');
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (!/\.dll$/i.test(f)) continue;
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
    n++;
  }
  console.log('[pack] injected vc_runtime (' + n + ' DLLs, app-local deployment)');
}

// 3.6c) build vc_runtime CDN zip (disaster recovery source for component download)
function buildVcRuntimeZip() {
  if (!target.startsWith('win-')) return;
  const src = path.join(ROOT, 'assets', 'runtimes', 'win32-x64');
  if (!fs.existsSync(src)) return;
  const sz7 = find7z();
  if (!sz7) return;
  const out = path.join(path.join(ROOT, 'dist-pack'), 'vc_runtime-win32-x64.zip');
  if (fs.existsSync(out)) fs.rmSync(out);
  const r = cp.spawnSync(sz7, ['a', '-tzip', '-mx=9', '-mmt=on', out, '.'], { stdio: 'inherit', cwd: src });
  if (r.status !== 0) throw new Error('vc_runtime zip failed');
  console.log('[pack] vc_runtime zip:', path.basename(out), '(' + Math.round(fs.statSync(out).size / 1024 / 1024 * 10) / 10 + 'MB)');
}

// 3.7) prune unnecessary Electron baggage — slim the unpacked tree
function pruneElectron(unpacked) {
  if (!target.startsWith('win-')) { return; }

  // ── 法律文件（可删除或替换） ──
  const legalFiles = [
    'LICENSES.chromium.html',   // 6.5MB — Chromium 第三方许可，对最终用户无用
    'LICENSE.electron.txt',     // 1KB — Electron 许可，应被自有许可替代
  ];
  for (const f of legalFiles) {
    const p = path.join(unpacked, f);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      console.log('[pack] pruned', f);
    }
  }

  // 替换为项目自有许可
  const projLicense = path.join(ROOT, 'LICENSE');
  if (fs.existsSync(projLicense) && fs.statSync(projLicense).size > 100) {
    fs.cpSync(projLicense, path.join(unpacked, 'LICENSE'), { force: true });
    console.log('[pack] injected LICENSE');
  }

  // ── 只保留中英文语言包（55→2，省~25MB） ──
  // ★ injectLauncher 已把 locales/ 搬进 gh555.com/，修剪必须跟进去
  const locDir = path.join(unpacked, 'gh555.com', 'locales');
  if (fs.existsSync(locDir)) {
    const keep = new Set(['en-US.pak', 'zh-CN.pak']);
    for (const f of fs.readdirSync(locDir)) {
      if (!keep.has(f)) {
        fs.rmSync(path.join(locDir, f));
      }
    }
    console.log('[pack] pruned locales -> en-US + zh-CN only');
  }

  // ── 不必要 DLL ──
  // vk_swiftshader* : 软件 Vulkan 回退，有 D3D/ANGLE 兜底，安全删除省 5MB
  // vulkan-1.dll    : Vulkan Loader，非必要
  const delDlls = [
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
  ];
  for (const f of delDlls) {
    const p = path.join(unpacked, f);
    if (fs.existsSync(p)) {
      const sz = fs.statSync(p).size;
      fs.rmSync(p);
      console.log('[pack] pruned', f, '(' + Math.round(sz / 1024) + 'KB)');
    }
  }
}

// 3.8) prune node_modules in the app — remove dev-only / unused subdirectories
function pruneNodeModules(unpacked) {
  if (!target.startsWith('win-')) { return; }
  const appDir = appResourcesDir(unpacked);
  if (!appDir || !fs.existsSync(appDir)) { return; }
  const nmDir = path.join(appDir, 'node_modules');

  // monaco-editor/dev/ — development build, never used at runtime
  const monacoDev = path.join(nmDir, 'monaco-editor', 'dev');
  if (fs.existsSync(monacoDev)) {
    fs.rmSync(monacoDev, { recursive: true, force: true });
    console.log('[pack] pruned monaco-editor/dev/');
  }
  // monaco-editor/esm/ — ESM source (~18MB), never used at runtime
  const monacoEsm = path.join(nmDir, 'monaco-editor', 'esm');
  if (fs.existsSync(monacoEsm)) {
    fs.rmSync(monacoEsm, { recursive: true, force: true });
    console.log('[pack] pruned monaco-editor/esm/ (18MB)');
  }
  // monaco-editor/min-maps/ — source maps (~12MB), never used at runtime
  const monacoMaps = path.join(nmDir, 'monaco-editor', 'min-maps');
  if (fs.existsSync(monacoMaps)) {
    fs.rmSync(monacoMaps, { recursive: true, force: true });
    console.log('[pack] pruned monaco-editor/min-maps/ (12MB)');
  }

  // sql.js — keep only sql-wasm.js + worker.sql-wasm.js + sql-wasm.wasm (~2MB);
  // drop debug builds + asm fallback + zipped archives (~17MB)
  const sqlDist = path.join(nmDir, 'sql.js', 'dist');
  if (fs.existsSync(sqlDist)) {
    const keepSql = new Set(['sql-wasm.js', 'sql-wasm.wasm', 'worker.sql-wasm.js', 'package.json']);
    let sqlBytes = 0;
    for (const f of fs.readdirSync(sqlDist)) {
      if (!keepSql.has(f)) {
        const fp = path.join(sqlDist, f);
        if (fs.statSync(fp).isFile()) { sqlBytes += fs.statSync(fp).size; }
        fs.rmSync(fp, { recursive: true, force: true });
      }
    }
    console.log('[pack] pruned sql.js (kept 3 files, saved ' + Math.round(sqlBytes / 1024 / 1024) + 'MB)');
  }

  // rcedit — dev-only Windows resource editor, never used at runtime (~2.2MB)
  const rceditDir = path.join(nmDir, 'rcedit');
  if (fs.existsSync(rceditDir)) {
    fs.rmSync(rceditDir, { recursive: true, force: true });
    console.log('[pack] pruned rcedit/ (dev-only, 2.2MB)');
  }
}

// 3.9) prune engine binaries — keep only target-platform + bundled components
function pruneEngines(unpacked) {
  const appDir = appResourcesDir(unpacked);
  if (!appDir || !fs.existsSync(appDir)) { return; }
  const engDir = path.join(appDir, 'engines');
  if (!fs.existsSync(engDir)) { return; }

  // Helper: recursive dir size (for logging)
  function dirSize(d) {
    let sz = 0;
    try {
      for (const f of fs.readdirSync(d)) {
        const fp = path.join(d, f);
        try { sz += fs.statSync(fp).isDirectory() ? dirSize(fp) : fs.statSync(fp).size; } catch {}
      }
    } catch {}
    return sz;
  }

  // Platform key mapping: target → manifest platform key
  const targetPk = target.startsWith('win-') ? 'win32-x64' :
    target.startsWith('linux-') ? 'linux-x64' :
    target.startsWith('mac-') && target.endsWith('arm64') ? 'darwin-arm64' :
    target.startsWith('mac-') ? 'darwin-x64' : null;

  // ── ① Read manifest to know bundled/non-bundled components ──
  const manifestPath = path.join(engDir, 'manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}

  // ── ①b Integrity gate: bundled min_size_mb assertion (git=250MB portable, win targets).
  //    防半成品组件被打进绿色包 → 客户端首启 bundled 检查骗不过 → 闪 SFX 解压窗口 + 重下重装循环 (F19 事故实锤)。
  //    linux/mac 目标 git 为 MinGit 形态 (~12-15MB)，min_size_mb 仅对 win 生效。
  if (manifest && manifest.components && target.startsWith('win-')) {
    for (const [name, def] of Object.entries(manifest.components)) {
      if (!def.bundled || !def.min_size_mb) continue;
      const compDir = path.join(engDir, def.install_to || name);
      if (!fs.existsSync(compDir)) {
        throw new Error('[pack] FATAL: bundled component ' + name + ' missing at ' + compDir + ' — refusing to pack broken green zip');
      }
      const sz = dirSize(compDir);
      const minMB = def.min_size_mb;
      if (sz < minMB * 1024 * 1024) {
        throw new Error('[pack] FATAL: bundled component ' + name + ' incomplete: ' + Math.round(sz / 1048576) + 'MB < min_size_mb=' + minMB + 'MB — restore full component before packing (F19: semi-broken git in zip → client boot loops with SFX window)');
      }
      console.log('[pack] integrity OK: ' + name + ' ' + Math.round(sz / 1048576) + 'MB >= ' + minMB + 'MB');
    }
  }

  // ── ② Remove non-bundled component directories (e.g. ffprobe — rank1 bg_download) ──
  if (manifest && manifest.components) {
    for (const [name, def] of Object.entries(manifest.components)) {
      if (def.bundled) continue;
      const compDir = path.join(engDir, def.install_to || name);
      if (fs.existsSync(compDir)) {
        const sz = dirSize(compDir);
        fs.rmSync(compDir, { recursive: true, force: true });
        console.log('[pack] pruned non-bundled component: ' + name + ' (' + Math.round(sz / 1024 / 1024) + 'MB)');
      }
      // Also check platform-subdir layout
      if (def._platform_subdir && def.install_to) {
        const platCompDir = path.join(engDir, def.install_to);
        if (fs.existsSync(platCompDir)) {
          const sz = dirSize(platCompDir);
          fs.rmSync(platCompDir, { recursive: true, force: true });
          console.log('[pack] pruned non-bundled component: ' + name + ' (' + Math.round(sz / 1024 / 1024) + 'MB)');
        }
      }
    }
  }

  // ── ③ For bundled _platform_subdir components, keep only target platform ──
  if (targetPk && manifest && manifest.components) {
    for (const [name, def] of Object.entries(manifest.components)) {
      if (!def.bundled || !def._platform_subdir) continue;
      const compDir = path.join(engDir, def.install_to || name);
      if (!fs.existsSync(compDir)) continue;
      for (const sub of fs.readdirSync(compDir)) {
        const subDir = path.join(compDir, sub);
        try { if (!fs.statSync(subDir).isDirectory()) continue; } catch { continue; }
        if (sub !== targetPk) {
          const sz = dirSize(subDir);
          fs.rmSync(subDir, { recursive: true, force: true });
          console.log('[pack] pruned cross-platform ' + name + '/' + sub + ' (' + Math.round(sz / 1024 / 1024) + 'MB)');
        }
      }
    }
  }

  // ── ④ Defense: remove ffprobe from ffmpeg dirs (shouldn't exist after split, but belt-and-suspenders) ──
  const ffmpegDir = path.join(engDir, 'ffmpeg');
  if (fs.existsSync(ffmpegDir)) {
    const ffprobeNames = process.platform === 'win32' ? ['ffprobe.exe'] : ['ffprobe'];
    for (const fn of ffprobeNames) {
      function walkRm(d) {
        try {
          for (const f of fs.readdirSync(d)) {
            const fp = path.join(d, f);
            if (f === fn) { fs.rmSync(fp); console.log('[pack] pruned stray ffprobe from ffmpeg: ' + fp); continue; }
            try { if (fs.statSync(fp).isDirectory()) walkRm(fp); } catch {}
          }
        } catch {}
      }
      walkRm(ffmpegDir);
    }
  }

  // ── ⑤ Legacy: non-target-platform root engine binaries ──
  const nonTgtRoot = [];
  if (target.startsWith('win-')) { nonTgtRoot.push('ghrun'); }
  else if (target.startsWith('linux-')) { nonTgtRoot.push('watchdog.exe'); }
  else if (target.startsWith('mac-')) { nonTgtRoot.push('watchdog.exe', 'ghrun.exe'); }

  // Cross-platform ripgrep
  const rgDir = path.join(engDir, 'ripgrep');
  const tgtPk2 = targetPk; // reuse
  let stripped = 0;
  if (fs.existsSync(rgDir)) {
    const keepRg = tgtPk2 === 'win32-x64' ? 'rg.exe' : 'rg';
    for (const f of fs.readdirSync(rgDir)) {
      const fp = path.join(rgDir, f);
      try { if (fs.statSync(fp).isDirectory()) continue; } catch { continue; }
      if (f !== keepRg && !f.startsWith('.')) {
        stripped += fs.statSync(fp).size;
        fs.rmSync(fp);
      }
    }
  }
  for (const f of nonTgtRoot) {
    const fp = path.join(engDir, f);
    if (fs.existsSync(fp)) { stripped += fs.statSync(fp).size; fs.rmSync(fp); }
  }
  if (stripped > 0) {
    console.log('[pack] pruned non-target engines (' + Math.round(stripped / 1024 / 1024) + 'MB)');
  }
}

// 3.10) prune server-app — remove generated AI images from bundle
function pruneServerApp(unpacked) {
  const appDir = appResourcesDir(unpacked);
  if (!appDir || !fs.existsSync(appDir)) { return; }
  const genDir = path.join(appDir, 'server-app', 'generated');
  if (fs.existsSync(genDir)) {
    let genBytes = 0;
    for (const f of fs.readdirSync(genDir)) {
      const fp = path.join(genDir, f);
      if (fs.statSync(fp).isFile()) {
        genBytes += fs.statSync(fp).size;
        fs.rmSync(fp);
      }
    }
    if (genBytes > 0) {
      console.log('[pack] pruned server-app/generated/ (' + Math.round(genBytes / 1024 / 1024) + 'MB)');
    }
  }
}

// 3.11) prune shell-out — remove .js.map source maps from bundle
function pruneShellOut(unpacked) {
  const appDir = appResourcesDir(unpacked);
  if (!appDir || !fs.existsSync(appDir)) { return; }
  const soDir = path.join(appDir, 'shell-out');
  if (!fs.existsSync(soDir)) { return; }
  let mapBytes = 0;
  for (const f of fs.readdirSync(soDir)) {
    if (f.endsWith('.js.map')) {
      const fp = path.join(soDir, f);
      mapBytes += fs.statSync(fp).size;
      fs.rmSync(fp);
    }
  }
  if (mapBytes > 0) {
    console.log('[pack] pruned shell-out .js.map files (' + Math.round(mapBytes / 1024 / 1024) + 'MB)');
  }
}

// 3.11b) prune python slim — PySide2 QML/unused Qt modules + q3-era leftover packages (zero imports in active code)
function prunePythonSlim(unpacked) {
  const appDir = appResourcesDir(unpacked);
  if (!appDir || !fs.existsSync(appDir)) { return; }
  const spDir = path.join(appDir, 'engines', 'python', 'site-packages');
  if (!fs.existsSync(spDir)) { return; }
  const p2Dir = path.join(spDir, 'PySide2');
  let saved = 0;
  // Slim Qt modules safe to remove — verified 2026-08-09: this PySide2 build's
  // QtCore load chain REQUIRES Qt5Qml/Qt5Quick/Qt5Quick3D core + Network/OpenGL/PrintSupport
  // (pyside2.abi3.dll delay-loads them); the 8 below are proven unneeded (binary-search verified).
  // ★ Qt5Xml.dll kept (2026-08-09): QtXml.pyd ships in the package — deleting the DLL would
  //   make `import PySide2.QtXml` fail with DLL load failed. Keep pair for zero import breakage.
  const p2Slim = ['Qt5Quick3DUtils.dll', 'Qt5QuickControls2.dll', 'Qt5QuickParticles.dll',
                  'Qt5QuickShapes.dll', 'Qt5QuickTemplates2.dll', 'Qt5QuickTest.dll',
                  'Qt5QuickWidgets.dll', 'opengl32sw.dll'];
  if (fs.existsSync(p2Dir)) {
    for (const f of fs.readdirSync(p2Dir)) {
      const fp = path.join(p2Dir, f);
      try { if (fs.statSync(fp).isDirectory()) continue; } catch { continue; }
      const hit = p2Slim.some(function (pre) {
        return f === pre || (pre.endsWith('.dll') ? f === pre : f.startsWith(pre));
      });
      if (hit) { saved += fs.statSync(fp).size; fs.rmSync(fp); }
    }
  }
  // q3-era leftover packages (paramiko/capstone/cryptography/nacl/minidump/bcrypt/msgpack)
  const pkgPre = ['paramiko', 'capstone', 'cryptography', 'pynacl', 'minidump', 'bcrypt', 'msgpack'];
  for (const f of fs.readdirSync(spDir)) {
    const fp = path.join(spDir, f);
    let isDir = false;
    try { isDir = fs.statSync(fp).isDirectory(); } catch { continue; }
    if (pkgPre.some(function (pre) { return f === pre || f.startsWith(pre + '-'); })) {
      saved += dirSizeFn(fp, isDir);
      fs.rmSync(fp, { recursive: true, force: true });
    } else if (isDir && f === '__pycache__') {
      saved += dirSizeFn(fp, true);
      fs.rmSync(fp, { recursive: true, force: true });
    }
  }
  if (saved > 0) {
    console.log('[pack] pruned python slim (QML/unused Qt + leftover pkgs + pycache) (' + Math.round(saved / 1024 / 1024) + 'MB)');
  }
}

function dirSizeFn(p, isDir) {
  if (!isDir) { try { return fs.statSync(p).size; } catch { return 0; } }
  let sz = 0;
  try { for (const f of fs.readdirSync(p)) { sz += dirSizeFn(path.join(p, f), fs.statSync(path.join(p, f)).isDirectory()); } } catch {}
  return sz;
}

// 3.12) clean runtime-generated directories from unpacked tree (should not be in zip)
function cleanRuntimeDirs(unpacked) {
  // ★ 根级泄漏根治（2026-08-09）: dev 模式把便携 userData 写到 node_modules/electron/dist/Data
  //   + debug.log → electron-builder 原样复制进 unpacked 根 → 曾随包泄漏（device_id/wq-ping.log 等）。
  //   整个删除；gh555.com/Data（launcher-config.json）是合法位置，不在根级，不受影响。
  const rootData = path.join(unpacked, 'Data');
  if (fs.existsSync(rootData)) {
    fs.rmSync(rootData, { recursive: true, force: true });
    console.log('[pack] cleaned root runtime dir: Data/ (dev-mode leakage)');
  }
  const dbgLog = path.join(unpacked, 'debug.log');
  if (fs.existsSync(dbgLog)) {
    fs.rmSync(dbgLog);
    console.log('[pack] cleaned root debug.log (dev-mode leakage)');
  }
  // Old flat structure (for cleanup of existing trees)
  const oldFlat = ['cache', 'crashDumps', 'temp', 'logs'];
  // New nested: all under Data/
  const nested = path.join(unpacked, 'Data');
  const toClean = new Set(['Cache', 'CrashDumps', 'Temp', 'Logs']);

  for (const d of oldFlat) {
    const p = path.join(unpacked, d);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log('[pack] cleaned old runtime dir:', d);
    }
  }
  // Also clean old userData/ if present (renamed to Data/)
  const oldUserData = path.join(unpacked, 'userData');
  if (fs.existsSync(oldUserData)) {
    fs.rmSync(oldUserData, { recursive: true, force: true });
    console.log('[pack] cleaned old userData/');
  }
  // qqq/ is project data — should be empty in distribution (now under Data/)
  const qqqDir = path.join(unpacked, 'qqq');
  if (fs.existsSync(qqqDir)) {
    fs.rmSync(qqqDir, { recursive: true, force: true });
    console.log('[pack] cleaned runtime dir: qqq/');
  }
  // Clean nested runtime dirs inside Data/ (leave Data/ itself)
  if (fs.existsSync(nested)) {
    for (const d of fs.readdirSync(nested)) {
      if (toClean.has(d)) {
        fs.rmSync(path.join(nested, d), { recursive: true, force: true });
        console.log('[pack] cleaned nested runtime dir: Data/' + d);
      }
    }
  }
}

// 4) two-layer compression: inner LZMA2 payload + outer deflate zip
//    C launcher extracts payload.7z on first run, subsequent runs skip.
function find7z() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const r = cp.spawnSync('where', ['7z'], { stdio: 'pipe', shell: true });
  if (r.status === 0) {
    const line = r.stdout.toString().trim().split('\n')[0];
    if (line && fs.existsSync(line)) return line.trim();
  }
  return null;
}

function compileLauncher() {
  if (!target.startsWith('win-')) return;
  const gccCandidates = [
    path.join(ROOT, '..', '..', '..', 'd', 'gw', 'mingw64', 'bin', 'gcc.exe'),
  ];
  let gcc = null;
  for (const c of gccCandidates) { if (fs.existsSync(c)) { gcc = c; break; } }
  if (!gcc) { console.warn('[pack] gcc not found, using existing launcher binary'); return; }
  const src = path.join(ROOT, 'launcher', 'launcher.c');
  const exe = path.join(ROOT, 'launcher', 'qqqide.exe');
  if (!fs.existsSync(src)) { console.warn('[pack] launcher.c not found'); return; }
  console.log('[pack] compiling launcher...');
  const r = cp.spawnSync(gcc, ['-mwindows', '-O2', '-s', '-o', exe, src, '-lcomctl32', '-lwinhttp'],
    { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('gcc compile failed');
  console.log('[pack] launcher compiled:', exe, '(' + fs.statSync(exe).size + 'B)');

  // ★ 注入图标 — 用 rcedit 将 shell/icon.ico 写入 PE 资源
  const rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  const icon = path.join(ROOT, 'shell', 'icon.ico');
  if (fs.existsSync(rcedit) && fs.existsSync(icon)) {
    console.log('[pack] setting launcher icon...');
    const r2 = cp.spawnSync(rcedit, [exe, '--set-icon', icon], { stdio: 'inherit' });
    if (r2.status !== 0) throw new Error('rcedit set-icon failed');
    console.log('[pack] launcher icon set');
  } else {
    console.warn('[pack] rcedit or icon.ico not found, skipping icon');
  }


}

function packDir(unpacked, flatOnly) {
  const distRoot = path.join(ROOT, 'dist-pack');
  const outName = `qqqide-${baseTarget}${cfg.tarExt}`;
  const out = path.join(distRoot, outName);
  if (fs.existsSync(out)) { fs.rmSync(out); }

  const sz7 = find7z();
  if (flatOnly || !sz7 || !isWin) {
    // single-layer (flat or fallback)
    console.log('[pack] compressing (single-layer deflate mx=9)', path.basename(unpacked), '->', out);
    if (sz7 && cfg.tarExt === '.zip') {
      const r7 = cp.spawnSync(sz7, ['a', '-tzip', '-mx=9', '-mmt=on', '-mfb=258', '-mpass=15', out, '.'], { stdio: 'inherit', cwd: unpacked });
      if (r7.status !== 0) throw new Error('7z failed: ' + r7.status);
    } else {
      const scriptPath = path.join(ROOT, 'shell-build', '_zip_worker.py');
      const script = `import zipfile, os
srcdir = r'${unpacked.replace(/\\/g, '\\\\')}'
out = r'${out.replace(/\\/g, '\\\\')}'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as z:
    for root, dirs, files in os.walk(srcdir):
        for f in files:
            fp = os.path.join(root, f)
            arc = os.path.relpath(fp, srcdir)
            z.write(fp, arc)
print('[pack] python zip done:', out)
`;
      fs.writeFileSync(scriptPath, script, 'utf8');
      try { run('python', [scriptPath]); }
      finally { try { fs.rmSync(scriptPath); } catch (_) { } }
    }
    return;
  }

  // ── Two-layer: inner LZMA2 + outer deflate zip ──
  console.log('[pack] building two-layer package...');

  const sz7Dir = path.dirname(sz7);
  const sfxCon = path.join(sz7Dir, '7zCon.sfx');
  if (!fs.existsSync(sfxCon)) throw new Error('7zCon.sfx not found');

  // Inner: payload.7z
  const p7z = path.join(distRoot, '_p.7z');
  if (fs.existsSync(p7z)) fs.rmSync(p7z);
  console.log('[pack]   payload LZMA2...');
  {
    const r = cp.spawnSync(sz7, ['a', '-t7z', '-mx=9', '-md=128m', '-mmt=off', '-ms=on', p7z, '.'],
      { stdio: 'inherit', cwd: unpacked });
    if (r.status !== 0) throw new Error('7z failed');
  }

  // Combine 7zCon.sfx + payload.7z → r (self-extracting blob)
  const rFile = path.join(distRoot, 'r');
  console.log('[pack]   assembling r (7zCon.sfx + payload)...');
  cp.spawnSync('cmd', ['/c', 'copy', '/b', sfxCon, '+', p7z, rFile], { stdio: 'inherit' });
  fs.rmSync(p7z);

  // ★ Keep r + latest.txt for launcher update system (rFile already at dist-root)
  const latestTxt = path.join(distRoot, 'latest.txt');
  fs.writeFileSync(latestTxt, APP_VERSION, 'utf8');
  console.log('[pack] kept r + latest.txt for launcher update');

  // ★ 单元增量产物（B 方案传输层）
  buildUnits(unpacked, rFile);

  // Stage: qqqide.exe + r
  const stageDir = path.join(distRoot, '_stage');
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const launcherSrc = path.join(ROOT, 'launcher', 'qqqide.exe');
  if (fs.existsSync(launcherSrc)) fs.cpSync(launcherSrc, path.join(stageDir, 'qqqide.exe'));
  fs.copyFileSync(rFile, path.join(stageDir, 'r'));

  // outer zip: deflate mx=9
  console.log('[pack]   outer zip (deflate mx=9)...');
  {
    const r = cp.spawnSync(sz7, ['a', '-tzip', '-mx=9', '-mmt=on', '-mfb=258', '-mpass=15', out, '.'],
      { stdio: 'inherit', cwd: stageDir });
    if (r.status !== 0) throw new Error('7z outer zip failed: ' + r.status);
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  const finalMb = Math.round(fs.statSync(out).size / 1024 / 1024);
  console.log('[pack] two-layer done:', finalMb, 'MB ->', out);
}

// 4b) SFX self-extracting exe — single-file distribution
// 4b) SFX — 2-file zip (qqqide.exe + r) renamed to .exe
//     r = 7zCon.sfx + payload.7z, C launcher runs "r -y" for silent extract
function packSfx(unpacked) {
  const distRoot = path.join(ROOT, 'dist-pack');
  const outName = `qqqide-${baseTarget}.exe`;
  const out = path.join(distRoot, outName);
  if (fs.existsSync(out)) fs.rmSync(out);

  const sz7 = find7z();
  if (!sz7) throw new Error('7z required');
  const sz7Dir = path.dirname(sz7);
  const sfxCon = path.join(sz7Dir, '7zCon.sfx');
  if (!fs.existsSync(sfxCon)) throw new Error('7zCon.sfx not found');

  // build payload.7z
  const p7z = path.join(distRoot, '_p.7z');
  if (fs.existsSync(p7z)) fs.rmSync(p7z);
  console.log('[pack]   payload LZMA2...');
  {
    const r = cp.spawnSync(sz7, ['a', '-t7z', '-mx=9', '-md=128m', '-mmt=off', '-ms=on', p7z, '.'],
      { stdio: 'inherit', cwd: unpacked });
    if (r.status !== 0) throw new Error('7z failed');
  }

  // combine 7zCon.sfx + payload.7z → r
  const rFile = path.join(distRoot, 'r');
  console.log('[pack]   assembling r (7zCon.sfx + payload)...');
  cp.spawnSync('cmd', ['/c', 'copy', '/b', sfxCon, '+', p7z, rFile], { stdio: 'inherit' });
  fs.rmSync(p7z);

  // ★ Keep r + latest.txt for launcher update system (rFile already at dist-root)
  const latestTxt = path.join(distRoot, 'latest.txt');
  fs.writeFileSync(latestTxt, APP_VERSION, 'utf8');
  console.log('[pack] kept r + latest.txt for launcher update');

  // ★ 单元增量产物（B 方案传输层）
  buildUnits(unpacked, rFile);

  // stage: qqqide.exe + r → zip → rename to .exe
  const stage = path.join(distRoot, '_sfx');
  if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const launcherSrc = path.join(ROOT, 'launcher', 'qqqide.exe');
  if (fs.existsSync(launcherSrc)) fs.cpSync(launcherSrc, path.join(stage, 'qqqide.exe'));
  fs.copyFileSync(rFile, path.join(stage, 'r'));

  console.log('[pack]   deflate zip → .exe');
  const rz = cp.spawnSync(sz7, ['a', '-tzip', '-mx=9', '-mmt=on', '-mfb=258', '-mpass=15', out, '.'],
    { stdio: 'inherit', cwd: stage });
  if (rz.status !== 0) throw new Error('7z zip failed');
  fs.rmSync(stage, { recursive: true, force: true });
  console.log('[pack] SFX done:', Math.round(fs.statSync(out).size / 1024 / 1024), 'MB ->', out);
}

(async () => {
  // mac builds on non-mac hosts must use manual assembly (electron-builder refuses)
  const isCrossMac = baseTarget.startsWith('mac-') && process.platform !== 'darwin';
  // SFX only for win locals
  if (isSfx && !isWin) { console.error('SFX only supported for win targets'); process.exit(1); }
  let unpacked;
  if (isCrossMac) {
    unpacked = await manualAssemble();
  } else {
    // electron-builder needs baseTarget (not -sfx variant)
    const ebPlat = TARGET_MAP[baseTarget].plat;
    const ebArch = TARGET_MAP[baseTarget].arch;
    const ebArgs = ['electron-builder', ebPlat, ebArch, '--dir', '--config.compression=store'];
    const localDist = localElectronDist();
    if (localDist) {
      // ★ 零下载主路径：直接用本地 node_modules/electron/dist 装配
      ebArgs.push('--config.electronDist=' + localDist);
      ebArgs.push('--config.electronVersion=' + ELECTRON_VERSION);
      console.log('[pack] using local electron dist (zero download):', localDist);
    } else {
      // 交叉/平台不匹配：先预热 @electron/get 缓存 → electron-builder 命中缓存零网络
      await warmElectronCache();
    }
    run('npx', ebArgs, { env: ebEnv() });
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
  compileLauncher();
  injectLauncher(unpacked);
  injectVcRuntime(unpacked);
  pruneElectron(unpacked);
  pruneNodeModules(unpacked);
  pruneEngines(unpacked);
  pruneServerApp(unpacked);
  pruneShellOut(unpacked);
  prunePythonSlim(unpacked);
  cleanRuntimeDirs(unpacked);
  if (isSfx) {
    packSfx(unpacked);
  } else {
    packDir(unpacked, doFlat);
  }
  buildVcRuntimeZip();
  // ★ 删掉解压目录，避免和源代码混淆
  fs.rmSync(unpacked, { recursive: true, force: true });
  console.log('[pack] cleaned staging:', unpacked);
  console.log('[pack] done. output -> dist-pack/');
})().catch(err => {
  console.error('[pack] failed:', err);
  process.exit(1);
});
