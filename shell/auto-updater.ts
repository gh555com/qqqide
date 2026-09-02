// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// auto-updater.ts — 壳层后台更新器（2026-08-31 架构定案）
//
// ★ 架构（用户要求定案）: 下载/验签/解压 100% 在 IDE 正常运行期间后台执行——
//   C 启动器不再持有任何下载线程（启动零等待 / 退出零等待 / 第二实例零等待）。
//   启动器只做: 秒弹窗 → 启动 joker → 下次开机原子交换（交换前对 r.next 二次验签）。
//
// ★ 与 launcher.c 共享的契约文件（改任一侧必须同步另一侧）:
//   包根: r.next / r.next.sig / .version-next / r.next.meta / .swap-ready
//   暂存: gh555.com-next（交换由启动器下次开机执行）
//   日志: gh555.com/Data/launcher-swap.log（同文件同格式，256KB 上限）
//   失败计数: 包根 .apply-fails（≥3 → 启动窗红行 + gh555.com/update-failed.txt）
//
// ★ 断点续传 + 版本变化（2026-08-31）: r.next.meta 记录下载目标版本——
//   下次会话发现服务器版本已变 → 丢弃旧半截重下（绝不复用跨版本字节混合文件）。
//   单元增量天然免疫: 单元路径含版本目录 u/{id}/*.7z，版本变了路径就变。
//   完整性三道闸: Ed25519 验签（r / units.json / sidecar）→ sha512 单元哈希 →
//   7z SFX 自解压 CRC。任一失败 → 拒更新保留旧版（方向安全）。
// ============================================================================

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

// ★ Ed25519 公钥（与 launcher/launcher.c SIGN_PUBKEY 逐字节一致）
//   pack.js 构建时强制校验两侧一致（防双源漂移，改任一侧构建失败）。
export const AUTO_UPDATE_PUBKEY_HEX = '82a61e3ae4d30b47015ef652b6878415b213c25b272db7dd0507bfc4ddc3946d';

const START_DELAY_MS = 20 * 1000;      // 启动 20s 后再开始（不与 IDE 启动抢资源）
const RETRY_MS = 30 * 60 * 1000;       // 失败后 30 分钟重试（会话内自愈，会话结束下次接力）
const IDLE_TIMEOUT = 90 * 1000;        // 90s 无数据 → 中断（F32 传输挂起实锤）
const EXTRACT_TIMEOUT = 15 * 60 * 1000;// 解压 15 分钟超时强杀
const LOG_CAP = 256 * 1024;

interface Cfg {
  update_host: string;
  latest_path: string;
  r_path: string;
  units_path: string;
  units_enabled: boolean;
  use_https: boolean;
  timeout_sec: number;
}

interface UpdaterCtx {
  packRoot: string;   // 含 qqqide.exe 的包根
  liveDir: string;    // gh555.com
  dataDir: string;    // gh555.com/Data
}

let _started = false;

// ── 入口（main.ts 调用）───────────────────────────────────────────────
export function startAutoUpdater(liveDir: string): void {
  if (_started) return;
  _started = true;
  const packRoot = path.dirname(liveDir);
  // ★ 仅打包模式（绿色包）运行: dev 实例无 qqqide.exe / 无启动器，跳过
  if (!fs.existsSync(path.join(packRoot, 'qqqide.exe'))) return;
  if (!fs.existsSync(path.join(liveDir, 'versions.json'))) return;
  const ctx: UpdaterCtx = {
    packRoot,
    liveDir,
    dataDir: path.join(liveDir, 'Data'),
  };
  log(ctx, 'update: shell updater armed (background, zero startup cost)');
  setTimeout(() => { void run(ctx); }, START_DELAY_MS);
}

async function run(ctx: UpdaterCtx): Promise<void> {
  try {
    const rc = await tryUpdateOnce(ctx);
    if (rc === 'done' || rc === 'waiting-swap') return;
    setTimeout(() => { void run(ctx); }, RETRY_MS);
  } catch (e: any) {
    log(ctx, 'update: shell updater error: ' + ((e && e.message) || String(e)));
    setTimeout(() => { void run(ctx); }, RETRY_MS);
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────
async function tryUpdateOnce(ctx: UpdaterCtx): Promise<'done' | 'waiting-swap' | 'failed'> {
  const cfg = readConfig(ctx);
  if (!cfg) return 'failed';

  // 1. 服务器最新版本
  const serverVer = await fetchText(cfg, cfg.latest_path);
  if (!serverVer) { log(ctx, 'update: fetch latest.txt FAIL (retry later)'); return 'failed'; }
  log(ctx, 'update: thread start (shell)');

  // 2. 本地版本
  const localVer = readLocalVersion(ctx.liveDir);

  // 3. 版本守卫: 仅服务器严格更高才更新（防反向降级）
  if (localVer && cmpVersion(serverVer, localVer) <= 0) {
    discardStalePartial(ctx, serverVer);
    log(ctx, 'update: up-to-date (local=%s server=%s), skip', localVer, serverVer);
    return 'done';
  }

  // ★ 启动器下限守卫（2026-08-31 过渡）: 目标包的 launcher 版本不得低于当前运行启动器——
  //   防 CDN 旧包（0.3.145 含 20260829.1）把新启动器三明治换回带竞态 bug 的旧版回归。
  //   未来所有包 launcher ≥ 此值后天然惰性。
  const LAUNCHER_FLOOR = '20260831.2';
  {
    const uj = await fetchText(cfg, cfg.units_path);
    if (uj) {
      try {
        const um = JSON.parse(uj);
        if (um && um.versions && um.versions.launcher &&
            cmpVersion(String(um.versions.launcher), LAUNCHER_FLOOR) < 0) {
          log(ctx, 'update: target launcher %s < floor %s, skip (publish newer package)',
            String(um.versions.launcher), LAUNCHER_FLOOR);
          return 'done';
        }
      } catch (_) { }
    }
  }

  // 4. 幂等守卫: .swap-ready 已就绪 + next 已是目标版本 → 等下次开机交换
  const swapReady = path.join(ctx.packRoot, '.swap-ready');
  if (fs.existsSync(swapReady)) {
    const nextVer = readManifestId(path.join(ctx.packRoot, 'gh555.com-next', 'versions.json'));
    if (nextVer === serverVer) {
      log(ctx, 'update: swap-ready already staged (%s), skip download', serverVer);
      return 'waiting-swap';
    }
    // next 残缺/版本不符 → 清标记，启动器下次开机清理 next，本会话重新装配
    try { fs.unlinkSync(swapReady); } catch (_) { }
    log(ctx, 'update: stale swap-ready cleared (next=%s server=%s)', nextVer || '?', serverVer);
  }

  // 5. 全量 r.next 版本仲裁: 服务器版本变了 → 丢弃旧半截（断点续传不复用跨版本字节）
  discardStalePartial(ctx, serverVer);

  // 6. 单元增量优先（传输优化，任一异常回退全量）
  if (cfg.units_enabled && cfg.units_path) {
    try {
      const ok = await tryIncremental(ctx, cfg, serverVer);
      if (ok) { applyFailClear(ctx); return 'done'; }
    } catch (e: any) {
      log(ctx, 'update: incremental error: ' + ((e && e.message) || String(e)));
    }
  }

  // 7. 全量 r
  const ok = await tryFullR(ctx, cfg, serverVer);
  if (ok) { applyFailClear(ctx); return 'done'; }
  return 'failed';
}

// ── 单元增量 ───────────────────────────────────────────────────────────
async function tryIncremental(ctx: UpdaterCtx, cfg: Cfg, serverVer: string): Promise<boolean> {
  log(ctx, 'incremental: begin %s -> %s', readLocalVersion(ctx.liveDir) || '?', serverVer);

  const unitsJson = await fetchText(cfg, cfg.units_path);
  if (!unitsJson) { log(ctx, 'incremental abort: units.json fetch FAIL (fallback full r)'); return false; }

  // ★ Ed25519 验签（与全量同一信任门）
  const unitsSig = await fetchRaw(cfg, cfg.units_path + '.sig');
  if (!unitsSig || unitsSig.length !== 64 || !verifyEd25519(Buffer.from(unitsJson, 'utf8'), unitsSig)) {
    log(ctx, 'incremental abort: units.json signature INVALID (security, fallback full r)');
    return false;
  }

  let m: any;
  try { m = JSON.parse(unitsJson); } catch (_) {
    log(ctx, 'incremental abort: units manifest parse FAIL (fallback full r)'); return false;
  }
  if (!m || m.id !== serverVer || !m.versions || !Array.isArray(m.units) || m.units.length === 0) {
    log(ctx, 'incremental abort: manifest invalid (fallback full r)'); return false;
  }

  // ★ 单元哈希 sidecar（独立签名，overlay 权威）
  const sidecarRaw = await fetchText(cfg, '/dl/qqqide-up/units.hash.json');
  if (sidecarRaw) {
    const sidecarSig = await fetchRaw(cfg, '/dl/qqqide-up/units.hash.json.sig');
    if (sidecarSig && sidecarSig.length === 64 && verifyEd25519(Buffer.from(sidecarRaw, 'utf8'), sidecarSig)) {
      try {
        const sh = JSON.parse(sidecarRaw);
        if (sh && Array.isArray(sh.units)) {
          for (const u of sh.units) {
            const t = m.units.find((x: any) => x.name === u.name);
            if (t && u.hash) t.hash = u.hash;
          }
        }
      } catch (_) {
        log(ctx, 'incremental abort: units.hash.json parse FAIL (security, fallback full r)'); return false;
      }
    } else {
      log(ctx, 'incremental abort: units.hash.json signature INVALID (security, fallback full r)'); return false;
    }
  } else {
    if (!m.units.some((u: any) => u.hash)) {
      log(ctx, 'incremental abort: no unit hashes (security, fallback full r)'); return false;
    }
    log(ctx, 'incremental: units.hash.json absent, using in-manifest hashes (transitional)');
  }

  // 本地单元状态（旧包无状态 → 全量兜底）
  let ls: any = null;
  try { ls = JSON.parse(fs.readFileSync(path.join(ctx.liveDir, 'Data', 'units.json'), 'utf8')); } catch (_) { }
  if (!ls || !ls.units) { log(ctx, 'incremental abort: no local unit state (legacy pack, fallback full r)'); return false; }
  if (ls.id === m.id) { log(ctx, 'incremental: local state already at %s (fallback full r)', m.id); return false; }

  // 需要下载的单元（本地缺失或版本不一致）
  const needed: any[] = [];
  let neededBytes = 0;
  for (const u of m.units) {
    if (!ls.units[u.name] || ls.units[u.name] !== u.version) { needed.push(u); neededBytes += u.bytes || 0; }
  }
  if (needed.length === 0) { log(ctx, 'incremental abort: no unit changes (fallback full r)'); return false; }
  if (m.r_bytes > 0 && neededBytes >= m.r_bytes) {
    log(ctx, 'incremental abort: delta %d >= full %d (fallback full r)', neededBytes, m.r_bytes); return false;
  }

  // ── 装配 gh555.com-next ──
  const uDir = path.join(ctx.dataDir, 'update');
  const nextDir = path.join(ctx.packRoot, 'gh555.com-next');
  fs.rmSync(path.join(uDir, 'out'), { recursive: true, force: true });
  fs.mkdirSync(uDir, { recursive: true });
  fs.rmSync(nextDir, { recursive: true, force: true });

  // ① 克隆 live（Data / versions.json / .version / launcher-next.exe 不克隆，由本函数重写）
  try {
    fs.cpSync(ctx.liveDir, nextDir, {
      recursive: true,
      filter: (src: string) => {
        const rel = path.relative(ctx.liveDir, src);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        return top !== 'Data' && top !== 'versions.json' && top !== '.version' && top !== 'launcher-next.exe';
      },
    });
  } catch (e: any) {
    log(ctx, 'incremental FAIL: clone live err: ' + ((e && e.message) || String(e)));
    fs.rmSync(nextDir, { recursive: true, force: true });
    return false;
  }

  // ② 下载 + sha512 校验 + 解压每个单元（单元 = SFX 档案，直接执行 -y）
  for (const u of needed) {
    const dest = path.join(uDir, u.name + '.7z');
    const outDir = path.join(uDir, 'out');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });   // ★ spawn cwd 必须存在（缺失 = spawn error 实锤）
    try {
      await downloadResume(cfg, '/dl/qqqide-up/' + u.file, dest);
    } catch (e: any) {
      log(ctx, 'incremental FAIL: download unit %s (keep partial for resume, fallback full r)', u.name);
      fs.rmSync(nextDir, { recursive: true, force: true });
      return false;
    }
    log(ctx, 'incremental: unit %s downloaded (%d bytes)', u.name, safeSize(dest));
    if (u.hash) {
      const h = sha512File(dest);
      if (!h || h !== u.hash) {
        log(ctx, 'incremental FAIL: unit %s hash mismatch (security, fallback full r)', u.name);
        try { fs.unlinkSync(dest); } catch (_) { }
        fs.rmSync(nextDir, { recursive: true, force: true });
        return false;
      }
    }
    const ec = await spawnWait(dest, ['-y'], outDir);
    if (ec !== 0) {
      log(ctx, 'incremental FAIL: 7z exit=%d for unit %s (CRC, fallback full r)', ec, u.name);
      fs.rmSync(nextDir, { recursive: true, force: true });
      return false;
    }
    // ③ 合并进 next（档案内路径 = 相对 gh555.com 根）
    try { fs.cpSync(outDir, nextDir, { recursive: true, force: true }); }
    catch (e: any) {
      log(ctx, 'incremental FAIL: merge unit %s err: ' + ((e && e.message) || String(e)));
      fs.rmSync(nextDir, { recursive: true, force: true });
      return false;
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    try { fs.unlinkSync(dest); } catch (_) { }
  }

  // ④ 元数据落盘（版本权威逐字 = 全量 r 的 versions.json）
  fs.writeFileSync(path.join(nextDir, 'versions.json'), JSON.stringify(m.versions), 'utf8');
  fs.writeFileSync(path.join(nextDir, '.version'), m.id, 'utf8');
  fs.mkdirSync(path.join(nextDir, 'Data'), { recursive: true });
  const lsJson: any = { id: m.id, units: {} };
  for (const u of m.units) lsJson.units[u.name] = u.version;
  fs.writeFileSync(path.join(nextDir, 'Data', 'units.json'), JSON.stringify(lsJson), 'utf8');

  // ⑤ gate（与全量 r 同一门）
  if (!fs.existsSync(path.join(nextDir, 'joker.exe')) ||
      !fs.existsSync(path.join(nextDir, 'resources', 'app')) ||
      !fs.existsSync(path.join(nextDir, 'versions.json'))) {
    log(ctx, 'incremental FAIL: gate check failed');
    fs.rmSync(nextDir, { recursive: true, force: true });
    return false;
  }

  fs.writeFileSync(path.join(ctx.packRoot, '.swap-ready'), m.id, 'utf8');
  fs.rmSync(uDir, { recursive: true, force: true });
  log(ctx, 'incremental OK: %s -> %s (%d units, %d bytes)',
    readLocalVersion(ctx.liveDir) || '?', m.id, needed.length, neededBytes);
  return true;
}

// ── 全量 r ──────────────────────────────────────────────────────────────
async function tryFullR(ctx: UpdaterCtx, cfg: Cfg, serverVer: string): Promise<boolean> {
  const rNext = path.join(ctx.packRoot, 'r.next');
  const rSig = path.join(ctx.packRoot, 'r.next.sig');
  const vNext = path.join(ctx.packRoot, '.version-next');
  const metaPath = path.join(ctx.packRoot, 'r.next.meta');
  const nextDir = path.join(ctx.packRoot, 'gh555.com-next');
  const tmpDir = path.join(ctx.packRoot, '_swap_tmp');

  // 幂等/去重: r.next + .version-next 已是目标版本 → 直接进解压（解压失败重试）
  const haveFull = fs.existsSync(rNext) && fs.existsSync(vNext) && readText(vNext) === serverVer;

  if (!haveFull) {
    // ★ 下载开始即写 meta（记录目标版本——断点续传 + 版本变化仲裁）
    try { fs.writeFileSync(metaPath, JSON.stringify({ v: serverVer, t: Date.now() }), 'utf8'); } catch (_) { }
    try {
      await downloadResume(cfg, cfg.r_path, rNext);
    } catch (e: any) {
      log(ctx, 'update: download r FAIL (keep partial for resume, fallback next session)');
      return false;
    }
    // 签名文件: 小文件每次全新下载（Range 续传 64B 无意义）
    try { fs.unlinkSync(rSig); } catch (_) { }
    try {
      await downloadResume(cfg, cfg.r_path + '.sig', rSig);
    } catch (e: any) {
      log(ctx, 'update: r.sig download FAIL (security keep old version)');
      try { fs.unlinkSync(rSig); } catch (_) { }
      return false;
    }
    // ★ Ed25519 验签（防 CDN 投毒，失败 → 删全部下次重下，方向安全）
    const sig = readBuffer(rSig);
    let data: Buffer;
    try { data = fs.readFileSync(rNext); } catch (_) { return false; }
    if (!sig || sig.length !== 64 || !verifyEd25519(data, sig)) {
      log(ctx, 'update: r.next signature INVALID (security, keep old version)');
      for (const f of [rNext, rSig, vNext]) { try { fs.unlinkSync(f); } catch (_) { } }
      applyFailMark(ctx);
      return false;
    }
    log(ctx, 'update: r.next downloaded OK (%s), signature OK', serverVer);
    fs.writeFileSync(vNext, serverVer, 'utf8');
    try {
      fs.writeFileSync(metaPath, JSON.stringify({ v: serverVer, size: safeSize(rNext), t: Date.now() }), 'utf8');
    } catch (_) { }
  }

  // ── 解压 r.next → gh555.com-next（幂等: next 已是目标版本 → 补写 .swap-ready）──
  const nextVer = readManifestId(path.join(nextDir, 'versions.json'));
  if (fs.existsSync(nextDir) && nextVer === serverVer) {
    fs.writeFileSync(path.join(ctx.packRoot, '.swap-ready'), serverVer, 'utf8');
    log(ctx, 'extract skip: next already %s (idempotent, no re-extract)', serverVer);
    return true;
  }

  fs.rmSync(nextDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  // ★ 硬链接进 tmp 再解压: SFX 解压到自身所在目录或 cwd 均落 tmp（双语义保险）
  const tmpR = path.join(tmpDir, 'r.next');
  try { fs.linkSync(rNext, tmpR); } catch (_) { try { fs.copyFileSync(rNext, tmpR); } catch (_) { return false; } }
  const ec = await spawnWait(tmpR, ['-y'], tmpDir);
  try { fs.unlinkSync(tmpR); } catch (_) { }
  if (ec !== 0) {
    log(ctx, 'extract FAIL: 7z exit=%d (corrupt r.next)', ec);
    applyFailMark(ctx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return false;
  }
  const extracted = path.join(tmpDir, 'gh555.com');
  if (!fs.existsSync(extracted)) {
    log(ctx, 'extract FAIL: payload has no gh555.com (bad r.next)');
    applyFailMark(ctx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return false;
  }
  try {
    fs.renameSync(extracted, nextDir);
  } catch (e: any) {
    log(ctx, 'extract FAIL: move to gh555.com-next err: ' + ((e && e.message) || String(e)));
    applyFailMark(ctx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return false;
  }
  // ★ 载荷根含新启动器 → next/launcher-next.exe（swap 时三明治替换根 qqqide.exe）
  const newLauncherSrc = path.join(tmpDir, 'qqqide.exe');
  if (fs.existsSync(newLauncherSrc)) {
    try { fs.copyFileSync(newLauncherSrc, path.join(nextDir, 'launcher-next.exe')); } catch (_) { }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // gate（与增量同一门）
  if (!fs.existsSync(path.join(nextDir, 'joker.exe')) ||
      !fs.existsSync(path.join(nextDir, 'versions.json')) ||
      !fs.existsSync(path.join(nextDir, 'resources', 'app'))) {
    log(ctx, 'extract FAIL: gate check failed');
    applyFailMark(ctx);
    fs.rmSync(nextDir, { recursive: true, force: true });
    return false;
  }

  fs.writeFileSync(path.join(ctx.packRoot, '.swap-ready'), serverVer, 'utf8');
  // ★ r.next 全家保留到下次开机交换（启动器交换前二次验签，交换成功后清理）
  log(ctx, 'extract OK: %s staged (swap-ready written, r.next kept for swap verify)', serverVer);
  return true;
}

// ── 断点续传下载（单请求，重定向递归内惰性建流——零多余 body 传输）────────────
async function downloadResume(cfg: Cfg, urlPath: string, destPath: string): Promise<void> {
  let existing = 0;
  try { existing = fs.statSync(destPath).size; } catch (_) { existing = 0; }
  const rangeFrom = existing > 0 ? existing : null;
  const dl = await requestOnce(cfg, urlPath, rangeFrom, (status: number) => {
    // 206 → 追加（续传）；200 → 从头；416 → 本地已 ≥ 服务器大小（由校验层裁决）
    if (status === 416) return null;
    return fs.createWriteStream(destPath, { flags: status === 206 ? 'a' : 'w' });
  }, null);
  if (dl.status === 416) return;
  if (dl.status !== 200 && dl.status !== 206) throw new Error('http ' + dl.status);
  const cl = dl.headers['content-length'] ? parseInt(String(dl.headers['content-length']), 10) : 0;
  const expectTotal = dl.status === 206 ? existing + cl : cl;
  const got = existing + dl.bytes;
  if (dl.status === 206 && dl.bytes === 0) throw new Error('range resume got 0 bytes');
  if (expectTotal > 0 && got < expectTotal * 0.99) throw new Error('incomplete download (' + got + '/' + expectTotal + ')');
}

// ★ 单次 HTTP GET（重定向最多 5 跳；90s 无数据中断 = 传输挂起看门狗；
//   makeOut 在最终（非重定向）响应到达时惰性创建写流——重定向跳转零 body 浪费）
function requestOnce(
  cfg: Cfg, urlPath: string, rangeFrom: number | null,
  makeOut: ((status: number, headers: any) => NodeJS.WritableStream | null) | null,
  collect: Buffer[] | null,
): Promise<{ status: number; bytes: number; headers: any }> {
  return new Promise((resolve, reject) => {
    const mod = cfg.use_https ? https : http;
    const headers: any = { 'User-Agent': 'qqqide-shell/1.0' };
    if (rangeFrom !== null) headers['Range'] = 'bytes=' + rangeFrom + '-';
    const req = mod.request({
      hostname: cfg.update_host,
      port: cfg.use_https ? 443 : 80,
      path: urlPath,
      method: 'GET',
      headers,
      timeout: (cfg.timeout_sec || 30) * 1000,
    }, (res: any) => {
      const status = res.statusCode || 0;
      // 重定向（CF worker → R2/OSS）: 递归跟随，Range 保持，body 为空零浪费
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        try {
          const u = new URL(res.headers.location);
          const prevHost = cfg.update_host;
          const prevHttps = cfg.use_https;
          cfg.update_host = u.hostname;
          cfg.use_https = u.protocol === 'https:';
          requestOnce(cfg, u.pathname + u.search, rangeFrom, makeOut, collect).then(resolve, reject)
            .finally(() => { cfg.update_host = prevHost; cfg.use_https = prevHttps; });
        } catch (e) { reject(e); }
        return;
      }
      let out: NodeJS.WritableStream | null = null;
      try { if (makeOut) out = makeOut(status, res.headers); } catch (e) { reject(e); res.resume(); return; }
      let bytes = 0;
      let lastActivity = Date.now();
      const iv = setInterval(() => {
        if (Date.now() - lastActivity > IDLE_TIMEOUT) {
          clearInterval(iv);
          req.destroy(new Error('download STALLED (idle ' + (IDLE_TIMEOUT / 1000) + 's)'));
        }
      }, 5000);
      if (out) {
        res.pipe(out);
        out.on('error', (e: Error) => { clearInterval(iv); reject(e); });
        // ★ 必须等文件流 finish（磁盘落盘完成）再 resolve——旧实现等 res 'end'（仅源流读完），
        //   立刻 readFileSync 会读到半截文件（launcher 差 702B / r 差几 KB 实锤）
        out.on('finish', () => { clearInterval(iv); resolve({ status, bytes, headers: res.headers }); });
        res.on('data', (c: Buffer) => { lastActivity = Date.now(); bytes += c.length; });
        res.on('error', (e: Error) => { clearInterval(iv); reject(e); });
      } else {
        res.on('data', (c: Buffer) => { lastActivity = Date.now(); bytes += c.length; if (collect) collect.push(c); });
        res.on('end', () => { clearInterval(iv); resolve({ status, bytes, headers: res.headers }); });
        res.on('error', (e: Error) => { clearInterval(iv); reject(e); });
      }
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchText(cfg: Cfg, urlPath: string): Promise<string | null> {
  const buf: Buffer[] = [];
  try {
    const res = await requestOnce(cfg, urlPath, null, null, buf);
    if (res.status !== 200) return null;
    const s = Buffer.concat(buf).toString('utf8').trim();
    return s || null;
  } catch (_) { return null; }
}

async function fetchRaw(cfg: Cfg, urlPath: string): Promise<Buffer | null> {
  const buf: Buffer[] = [];
  try {
    const res = await requestOnce(cfg, urlPath, null, null, buf);
    if (res.status !== 200) return null;
    return Buffer.concat(buf);
  } catch (_) { return null; }
}

// ── 工具 ────────────────────────────────────────────────────────────────
// Ed25519 验签（Node crypto，公钥 = 内嵌 32 字节 + SPKI 前缀）
function verifyEd25519(data: Buffer, sig: Buffer): boolean {
  try {
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(AUTO_UPDATE_PUBKEY_HEX, 'hex'),
    ]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, data, key, sig);
  } catch (_) { return false; }
}

function sha512File(p: string): string | null {
  try {
    return crypto.createHash('sha512').update(fs.readFileSync(p)).digest('hex');
  } catch (_) { return null; }
}

// SFX 自解压（-y 静默覆盖），cwd = 目标目录；超时强杀
function spawnWait(exe: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => {
      if (!done) { try { child.kill('SIGKILL'); } catch (_) { } }
    }, EXTRACT_TIMEOUT);
    child.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(1); } });
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); resolve(code === null ? 1 : code); } });
  });
}

// C 启动器同款语义版本比较（数字段，防反向降级）
function cmpVersion(a: string, b: string): number {
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    let na = 0, nb = 0;
    while (i < a.length && a[i] !== '.') { if (a[i] >= '0' && a[i] <= '9') na = na * 10 + (a.charCodeAt(i) - 48); i++; }
    while (j < b.length && b[j] !== '.') { if (b[j] >= '0' && b[j] <= '9') nb = nb * 10 + (b.charCodeAt(j) - 48); j++; }
    if (na !== nb) return na > nb ? 1 : -1;
    if (i < a.length) i++;
    if (j < b.length) j++;
  }
  return 0;
}

function readConfig(ctx: UpdaterCtx): Cfg {
  const def: Cfg = {
    update_host: 'gh555.com',
    latest_path: '/dl/qqqide-up/latest.txt',
    r_path: '/dl/qqqide-up/r',
    units_path: '/dl/qqqide-up/units.json',
    units_enabled: true,
    use_https: true,
    timeout_sec: 30,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'launcher-config.json'), 'utf8'));
    if (raw.update_host) def.update_host = raw.update_host;
    if (raw.latest_path) def.latest_path = raw.latest_path;
    if (raw.r_path) def.r_path = raw.r_path;
    // ★ 2026-09-02 双清单分路: units_path 仅供老启动器（恒指桥接 units.bridge.json）;
    //   壳层恒读 units_full_path（全量 5 单元清单）——绝不可回退读 units_path（等号陷阱: 桥接 id 落后主清单一版,
    //   旧壳层若读它会在主清单推进后永远差一版/卡等号）。
    if (raw.units_full_path) def.units_path = raw.units_full_path;
    if (typeof raw.units_enabled === 'boolean') def.units_enabled = raw.units_enabled;
    if (typeof raw.use_https === 'boolean') def.use_https = raw.use_https;
    if (raw.timeout_sec) def.timeout_sec = raw.timeout_sec;
  } catch (_) { }
  return def;
}

function readManifestId(vPath: string): string {
  try {
    const v = JSON.parse(fs.readFileSync(vPath, 'utf8'));
    return (v && typeof v.id === 'string' && v.id) ? v.id : '';
  } catch (_) { return ''; }
}

function readLocalVersion(liveDir: string): string {
  return readManifestId(path.join(liveDir, 'versions.json'));
}

function readText(p: string): string {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; }
}

function readBuffer(p: string): Buffer | null {
  try { return fs.readFileSync(p); } catch (_) { return null; }
}

function safeSize(p: string): number {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

// ★ 全量 r 版本仲裁: meta 记录的下载目标 ≠ 服务器当前版本 → 旧半截作废重下
//   （断点续传只在同版本内生效；跨版本字节混合由验签兜底，此处显式杜绝）
function discardStalePartial(ctx: UpdaterCtx, serverVer: string): void {
  const rNext = path.join(ctx.packRoot, 'r.next');
  if (!fs.existsSync(rNext)) return;
  const metaPath = path.join(ctx.packRoot, 'r.next.meta');
  let mv: string | null = null;
  try {
    const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    mv = (m && typeof m.v === 'string') ? m.v : null;
  } catch (_) { }
  const vNext = path.join(ctx.packRoot, '.version-next');
  const vnv = readText(vNext);
  const stale = (mv !== null && mv !== serverVer) ||
                (mv === null && vnv !== '' && vnv !== serverVer) ||
                (mv === null && vnv === '');
  if (stale) {
    if (mv !== null && mv !== serverVer) {
      log(ctx, 'update: r.next meta version %s != server %s, discard partial (fresh download)', mv, serverVer);
    } else {
      log(ctx, 'update: orphan partial r.next discarded (fresh download)');
    }
    for (const f of [rNext, path.join(ctx.packRoot, 'r.next.sig'), vNext, metaPath]) {
      try { fs.unlinkSync(f); } catch (_) { }
    }
  }
}

// ★ 升级失败计数（与 C 启动器同一契约）: ≥3 → 启动窗红行 + update-failed.txt
function applyFailMark(ctx: UpdaterCtx): void {
  try {
    const f = path.join(ctx.packRoot, '.apply-fails');
    let n = 0;
    try { n = parseInt(fs.readFileSync(f, 'utf8').trim(), 10) || 0; } catch (_) { }
    n++;
    fs.writeFileSync(f, String(n), 'utf8');
    if (n >= 3) fs.writeFileSync(path.join(ctx.liveDir, 'update-failed.txt'), String(n), 'utf8');
  } catch (_) { }
}

function applyFailClear(ctx: UpdaterCtx): void {
  try { fs.unlinkSync(path.join(ctx.packRoot, '.apply-fails')); } catch (_) { }
  try { fs.unlinkSync(path.join(ctx.liveDir, 'update-failed.txt')); } catch (_) { }
}

// ★ 交换日志（与 C 启动器同文件同格式）: gh555.com/Data/launcher-swap.log，256KB 上限
function log(ctx: UpdaterCtx, fmt: string, ...args: any[]): void {
  try {
    let msg = fmt;
    for (const a of args) msg = msg.replace(/%[sd]/, String(a === undefined ? '?' : a));
    const line = ts() + ' ' + msg + '\n';
    const p = path.join(ctx.dataDir, 'launcher-swap.log');
    try {
      const st = fs.statSync(p);
      if (st.size > LOG_CAP) {
        const f = fs.readFileSync(p);
        fs.writeFileSync(p, f.slice(f.length - 200 * 1024));
      }
    } catch (_) { }
    fs.appendFileSync(p, line);
  } catch (_) { }
}

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return '[' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ']';
}
