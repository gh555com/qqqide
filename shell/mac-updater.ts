// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// mac-updater.ts — macOS 应用内更新机制 v1（2026-09-19）
//
// 背景: Windows 更新 = C 启动器托管（r 后台下载 → 下次开机原子交换）；mac 无启动器、
//   .app 被运行中进程占用无法自替换 → 建立等效通道:
//   ① 检查: 拉取签名清单 mac.json（Ed25519 验签，与 C 启动器同一信任根）→ 严格更高才更新
//   ② 下载: tar.gz 断点续传 + sha256 校验（.update/new.tar.gz）
//   ③ 暂存: 解压 → 结构门 → 本地证书预签名（codesign）→ staged.json
//   ④ 换装: 用户点「重启更新」或直接退出应用（v1 退出即换）→ 助手脚本等应用退出 → 原子 rename
//      （qqqide.app ↔ qqqide-app-prev + engines ↔ engines-prev）→ open 重启
//   ⑤ 守卫: 启动健康检查失败自动回滚；qqqide-data/Data 永不触碰；上一版恒留存
//      v1 退出即换: MODE=quiet 不拉起 GUI —— 换装后跑 --update-probe 无头探针自检
//      （不通过自动回滚）；用户下次打开应用就是新版，全程零打断。
//
// 布局契约（与 pack.js externalizeMacBundle / 首次启动.command 共享）:
//   {parent}/qqqide.app               程序本体（换装对象）
//   {parent}/qqqide-data/             Data（用户数据，永不触碰）+ engines（换装对象）
//   {parent}/.update/                 工作区（tar / staging / apply-update.sh / 日志）
//   {parent}/qqqide-app-prev          上一版回滚点（换装时轮换）
//
// 安全链: TLS → Ed25519 验签清单 → tar sha256 → 结构门 → 本地证书签名
//   （签名随内容不随路径 → 暂存期预签名，换装后仍有效；同一证书 = TCC 授权跨更新稳定）。
//   任一失败方向安全: 拒绝更新保留旧版。
//
// 测试通道（dev aid，普通用户无感知）: {Data}/update-channel.json
//   { "manifest_url": "http://…/mac.json", "mirror_url": "", "force": false }
//   ——存在时替代线上清单地址（跳过验签）；force=true 时跳过版本比较强制走全链（VM 实测用）。
//
// ★ v2 增量下载（2026-09-19）: mac.json 携带单元清单（meta / shell-out / webapp / engines /
//   base）。变化单元 = 内容寻址 tar（sha 不变 → 跳过下载）；装配 = 拷贝 live 树 + 变化单元
//   目录级替换（删除语义天然正确）→ 本地签名 → 暂存。base 变化 / 状态缺失 / 任一步失败
//   → 自动回退全量 tar（增量 = 纯传输优化，正确性零责任）。本地状态 {Data}/units.json，
//   换装成功后由助手从 units.pending.json 提升；清单版本 == 本地版本时按清单自愈重建。
//   契约与 gaea/cf/up/mac_units.py 严格对齐（改一处必须改两处）。
// ============================================================================

import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { APP_VERSION } from './version';
import { getAppRoot, getDataDir, getHostDir } from './portable-paths';
import { notifyUpdateFailed } from './wq-ping'; // 升级健康遥测: 失败即时补发 ping（同 Windows 通道）

// ★ Ed25519 公钥（与 launcher/launcher.c SIGN_PUBKEY / auto-updater.ts 同一信任根）
const PUBKEY_HEX = '82a61e3ae4d30b47015ef652b6878415b213c25b272db7dd0507bfc4ddc3946d';

const MANIFEST_URL = 'https://gh555.com/dl/qqqide-up/mac.json';
const MANIFEST_MIRROR = 'https://gh555-shanghai.oss-cn-shanghai.aliyuncs.com/qqqide-up/mac.json';

const START_DELAY_MS = 20 * 1000;          // 启动 20s 后开始（不与 IDE 启动抢资源）
const RECHECK_MS = 6 * 60 * 60 * 1000;     // 已最新 → 6h 后再查（长驻应用能追上发版）
const RETRY_MS = 30 * 60 * 1000;           // 失败 → 30 分钟重试（会话内自愈）
const IDLE_TIMEOUT = 90 * 1000;            // 下载 90s 无数据 → 中断（半截保留续传）
const LOG_CAP = 256 * 1024;

const CERT_NAME = 'qqqide Local Sign';
const KC_PASS = 'qqqide';

// ── v2 增量单元契约（与 gaea/cf/up/mac_units.py 严格同步）──
const UNIT_NAMES = ['meta', 'shell-out', 'webapp', 'engines'];
const UNIT_DIRS: { [n: string]: string } = {
  'shell-out': 'qqqide.app/Contents/Resources/app/shell-out',
  'webapp': 'qqqide.app/Contents/Resources/app/webapp',
  'engines': 'qqqide-data/engines',
};

export interface MacUpdateState {
  phase: 'idle' | 'checking' | 'downloading' | 'staging' | 'ready' | 'applying' | 'updated' | 'rolledback' | 'error' | 'unsupported';
  version?: string;
  got?: number;
  total?: number;
  pct?: number;
  step?: string;
  message?: string;
}

interface UnitEntry { sha256: string; size?: number; url?: string; mirror?: string; }

interface ArchEntry {
  url: string; mirror?: string; sha256: string; size: number;
  units?: { [name: string]: UnitEntry };   // v2 增量单元清单（旧清单无此字段 → 全量）
}

interface LocalUnits { fmt: number; id: string; arch: string; base: string; units: { [n: string]: string }; }

interface MacManifest {
  id: string;
  ts?: number;
  archs: { [arch: string]: ArchEntry };
}

interface MacCtx {
  bundleDir: string;   // {parent}/qqqide.app
  parentDir: string;   // 托管根（.app 同级）
  hostDir: string;     // qqqide-data
  dataDir: string;     // qqqide-data/Data
  updateDir: string;   // {parent}/.update
}

let _started = false;
let _ctx: MacCtx | null = null;
let _state: MacUpdateState = { phase: 'idle' };
let _busy = false;
let _applying = false;
let _timer: NodeJS.Timeout | null = null;
let _lastProgressAt = 0;
let _lastLine = '';

// ── 入口（main.ts 调用）────────────────────────────────────────────────────
export function startMacUpdater(): void {
  if (_started) return;
  _started = true;
  if (process.platform !== 'darwin') return;              // 仅 mac（Windows 由 C 启动器托管，零触碰）
  const ctx = resolveMacPaths();
  if (!ctx) return;                                        // dev 模式（非 .app bundle）→ 静默
  _ctx = ctx;
  try {
    fs.mkdirSync(ctx.updateDir, { recursive: true });
    fs.accessSync(ctx.parentDir, fs.constants.W_OK);       // 只读挂载 / App Translocation → 更新不可用
  } catch (e: any) {
    log(ctx, 'update: parent not writable, skip (' + ((e && e.message) || e) + ')');
    return;
  }
  handleApplyResult(ctx);                                  // 上次换装结果（updated / rolledback 一次性提示）
  promotePendingUnits(ctx);                                // v2: 换装成功但助手未提升时的兜底
  const ready = restoreStaged(ctx);                        // 上次会话已暂存 → 直接就绪
  if (!ready && _state.phase !== 'updated' && _state.phase !== 'rolledback') {
    schedule(START_DELAY_MS);
  }
  log(ctx, 'update: mac updater armed (v%s, bundle=%s)', APP_VERSION, ctx.bundleDir);
}

// ── IPC（main.ts registerAllIpc 调用）──────────────────────────────────────
export function registerMacUpdateIpc(): void {
  ipcMain.handle('qqqide:update:mac-state', () => publicState());

  // 手动检查（工具栏按钮）: 快速路径只拉清单比较，绝不让 IPC 等下载
  ipcMain.handle('qqqide:update:mac-check', async () => {
    if (!_ctx) return { ok: false, unsupported: true };
    if (_state.phase === 'ready') return { ok: true, ready: true, version: _state.version };
    if (_state.phase === 'applying') return { ok: true, busy: true, state: publicState() };
    if (_busy) return { ok: true, busy: true, state: publicState() };
    const mf = await fetchManifest(_ctx);
    if (!mf) return { ok: false, error: 'fetch' };
    // v2: 手动检查路径同样自愈单元状态（清单版本==本地版本 → 幂等重建 units.json）
    healUnitsState(_ctx, mf, process.arch === 'arm64' ? 'arm64' : 'x64');
    if (!testForce() && cmpVersion(mf.id, APP_VERSION) <= 0) {
      return { ok: true, upToDate: true, version: APP_VERSION, server: mf.id };
    }
    void runOnce();                                        // 全链异步推进（状态事件会持续广播）
    return { ok: true, found: true, version: mf.id };
  });

  // 应用更新 = 生成助手脚本 → detach 启动 → 应用退出（助手换装后自动重启）
  ipcMain.handle('qqqide:update:mac-apply', () => applyNow());
}

export function macApplyNow(): { ok: boolean; error?: string } { return applyNow('restart'); }

// ── 退出即换（v1）── main.ts 在 before-quit 调用 ─────────────────────────────
// 应用自然退出时若有「就绪」暂存 → 静默换装（MODE=quiet：换装后 --update-probe
// 无头探针自检；不拉起 GUI、不打断用户；探针失败自动回滚）。
// 手工「重启更新」路径 _applying=true → 本函数自动跳过（防双重换装）。
export function maybeAutoApplyOnQuit(): void {
  try {
    if (process.platform !== 'darwin') return;
    if (!_ctx || _applying) return;
    if (process.env.QQQIDE_NO_QUIT_APPLY === '1') return;   // 运维/测试逃生门
    if (_state.phase !== 'ready') return;
    const ctx = _ctx;
    const staged = readStaged(ctx);
    if (!staged || !fs.existsSync(path.join(ctx.updateDir, 'staging', 'qqqide.app'))) return;
    const r = applyNow('quiet');
    if (!r.ok) log(ctx, 'update: quit-time apply skipped (%s)', r.error || '?');
  } catch (_) { }
}

// ── 路径 / 门 ──────────────────────────────────────────────────────────────
function resolveMacPaths(): MacCtx | null {
  const root = getAppRoot();                               // .../qqqide.app/Contents/MacOS
  const norm = root.replace(/\\/g, '/');
  const idx = norm.indexOf('.app/Contents/MacOS');
  if (idx < 0) return null;
  const bundleDir = norm.slice(0, idx + 4);
  const parentDir = path.dirname(bundleDir);
  return {
    bundleDir,
    parentDir,
    hostDir: getHostDir(),                                 // {parent}/qqqide-data
    dataDir: getDataDir(),                                 // {parent}/qqqide-data/Data
    updateDir: path.join(parentDir, '.update'),
  };
}

// ── 状态 / 广播 ────────────────────────────────────────────────────────────
function publicState(): MacUpdateState { return { ..._state }; }

function setState(s: MacUpdateState): void {
  _state = s;
  broadcast();
}

function broadcast(): void {
  try {
    const msg = publicState();
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
          w.webContents.send('qqqide:update:mac-state', msg);
        }
      } catch (_) { }
    }
  } catch (_) { }
}

function schedule(ms: number): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _timer = setTimeout(() => { void runOnce(); }, ms);
}

// ── 主流程: 检查 → 下载 → 暂存 → 签名 → 就绪 ───────────────────────────────
async function runOnce(): Promise<void> {
  if (_busy || !_ctx || _applying) return;
  _busy = true;
  const ctx = _ctx;
  try {
    if (_state.phase !== 'ready') { setState({ phase: 'checking' }); }

    const mf = await fetchManifest(ctx);
    if (!mf) { failSoft(ctx, 'manifest fetch failed'); return; }

    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const entry = mf.archs[arch];
    if (!entry || !entry.url || !entry.sha256) { failSoft(ctx, 'no arch entry (' + arch + ')'); return; }

    healUnitsState(ctx, mf, arch);                           // v2: 清单版本 == 本地版本 → 状态自愈重建

    if (!testForce() && cmpVersion(mf.id, APP_VERSION) <= 0) {
      log(ctx, 'update: up-to-date (local=%s server=%s)', APP_VERSION, mf.id);
      setState({ phase: 'idle', version: mf.id });
      recordStatus(ctx, 'ok');
      schedule(RECHECK_MS);
      return;
    }

    // 已有同版本就绪暂存 → 不重复下载
    const staged = readStaged(ctx);
    if (staged && staged.version === mf.id && fs.existsSync(path.join(ctx.updateDir, 'staging', 'qqqide.app'))) {
      log(ctx, 'update: already staged v%s (skip download)', mf.id);
      setState({ phase: 'ready', version: mf.id });
      recordStatus(ctx, 'waiting');
      return;
    }

    // v2: 增量计划（状态匹配 + base 一致 → 只下变化单元；任一异常回退全量）
    const stLocal = readLocalUnits(ctx);
    const plan = planIncremental(mf, arch, entry, stLocal);
    if (plan) {
      log(ctx, 'update: incremental begin %s -> v%s (changed: %s, %d bytes)', APP_VERSION, mf.id, plan.changed.join('+'), plan.total);
      const rc = await runIncremental(ctx, mf, arch, entry, plan);
      if (rc === 'ok') return;
      log(ctx, 'update: incremental FAILED -> fallback to full download');
    }

    // 磁盘空间快检（tar + 解压 ≈ 2.2 倍）
    if (!await hasDiskSpace(ctx, entry.size * 3 + 512 * 1024 * 1024)) {
      failSoft(ctx, 'insufficient disk space');
      return;
    }

    // ① 下载
    const tarPath = path.join(ctx.updateDir, 'new.tar.gz');
    const preGot = safeSize(tarPath);
    setState({ phase: 'downloading', version: mf.id, got: preGot, total: entry.size, pct: entry.size ? Math.floor(preGot / entry.size * 100) : 0 });
    log(ctx, 'update: download begin %s -> v%s (%s, %d bytes)', APP_VERSION, mf.id, arch, entry.size);
    if (!await downloadTar(ctx, mf, entry, arch, tarPath)) {
      failSoft(ctx, 'download failed (partial kept for resume)');
      return;
    }
    log(ctx, 'update: download OK (%d bytes, sha256 verified)', safeSize(tarPath));

    // ② 解压
    setState({ phase: 'staging', version: mf.id, step: 'extract' });
    if (!await extractStaging(ctx, tarPath)) { failSoft(ctx, 'extract failed'); return; }

    // ③ 结构门（半成品绝不进入签名/换装）
    const stagingApp = path.join(ctx.updateDir, 'staging', 'qqqide.app');
    if (!fs.existsSync(path.join(stagingApp, 'Contents', 'MacOS')) ||
        !fs.existsSync(path.join(stagingApp, 'Contents', 'Resources', 'app', 'shell-out', 'main.js'))) {
      try { fs.rmSync(path.join(ctx.updateDir, 'staging'), { recursive: true, force: true }); } catch (_) { }
      failSoft(ctx, 'structure gate failed');
      return;
    }

    // ④ 预签名（本地证书；换装 = rename，签名随内容不随路径）
    setState({ phase: 'staging', version: mf.id, step: 'sign' });
    if (!await ensureSigningIdentity(ctx)) {
      try { fs.rmSync(path.join(ctx.updateDir, 'staging'), { recursive: true, force: true }); } catch (_) { }
      failSoft(ctx, 'signing identity unavailable');
      return;
    }
    if (!await signApp(ctx, stagingApp)) {
      try { fs.rmSync(path.join(ctx.updateDir, 'staging'), { recursive: true, force: true }); } catch (_) { }
      failSoft(ctx, 'codesign failed');
      return;
    }

    // ⑤ 就绪（等用户点「重启更新」）
    writeUnitsPending(ctx, mf, arch);                        // v2: 全量路径同样记录单元状态
    writeStaged(ctx, mf.id, arch, entry.sha256);
    setState({ phase: 'ready', version: mf.id });
    recordStatus(ctx, 'waiting');
    log(ctx, 'update: staged v%s (ready, waiting user restart)', mf.id);
  } catch (e: any) {
    failSoft(ctx, 'unexpected: ' + ((e && e.message) || String(e)));
  } finally {
    _busy = false;
  }
}

function failSoft(ctx: MacCtx, why: string): void {
  log(ctx, 'update: %s (retry in %dmin)', why, Math.round(RETRY_MS / 60000));
  setState({ phase: 'error', message: why });
  recordStatus(ctx, 'failed');
  schedule(RETRY_MS);
}

// ── 应用更新（助手脚本 + 退出；MODE=restart 手动 / quiet 退出即换）─────────────────────────────────────────────
function applyNow(mode: 'restart' | 'quiet' = 'restart'): { ok: boolean; error?: string } {
  if (!_ctx) return { ok: false, error: 'unsupported' };
  if (_applying) return { ok: false, error: 'already-applying' };
  const ctx = _ctx;
  const staged = readStaged(ctx);
  if (_state.phase !== 'ready' || !staged ||
      !fs.existsSync(path.join(ctx.updateDir, 'staging', 'qqqide.app'))) {
    return { ok: false, error: 'not-ready' };
  }
  try {
    // 助手脚本（每次重写 = 恒为最新逻辑）
    const helperPath = path.join(ctx.updateDir, 'apply-update.sh');
    fs.writeFileSync(helperPath, helperScript(), 'utf8');
    fs.chmodSync(helperPath, 0o755);
    fs.writeFileSync(path.join(ctx.updateDir, 'staged.version'), staged.version, 'utf8');
    try { fs.unlinkSync(path.join(ctx.updateDir, 'apply-result')); } catch (_) { }

    const logFd = fs.openSync(path.join(ctx.updateDir, 'update.log'), 'a');
    const child = spawn('/bin/bash', [helperPath, String(process.pid), mode], {
      cwd: ctx.updateDir, detached: true, stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    try { fs.closeSync(logFd); } catch (_) { }

    _applying = true;
    setState({ phase: 'applying', version: staged.version });
    log(ctx, 'update: apply requested (mode=%s, helper detached; target v%s)', mode, staged.version);
    recordStatus(ctx, 'waiting');
    if (mode !== 'quiet') {
      setTimeout(() => { try { app.quit(); } catch (_) { } }, 900);
    }
    return { ok: true };
  } catch (e: any) {
    log(ctx, 'update: apply spawn FAIL: ' + ((e && e.message) || String(e)));
    return { ok: false, error: 'spawn-failed' };
  }
}

// ── 启动恢复（上次会话的暂存 / 换装结果）───────────────────────────────────
function handleApplyResult(ctx: MacCtx): void {
  const p = path.join(ctx.updateDir, 'apply-result');
  let txt = '';
  try { txt = fs.readFileSync(p, 'utf8').trim(); } catch (_) { return; }
  try { fs.unlinkSync(p); } catch (_) { }
  if (txt.indexOf('done') === 0) {
    const v = txt.split(/\s+/)[1] || APP_VERSION;
    _state = { phase: 'updated', version: v };
    log(ctx, 'update: previous apply SUCCESS (v%s)', v);
    recordStatus(ctx, 'ok');
  } else if (txt.indexOf('rollback') === 0) {
    _state = { phase: 'rolledback' };
    log(ctx, 'update: previous apply ROLLED BACK (kept old version)');
    recordStatus(ctx, 'failed');
  }
}

function restoreStaged(ctx: MacCtx): boolean {
  const staged = readStaged(ctx);
  if (!staged) {
    // 无 staged.json 的残余 staging = 中途崩溃产物 → 清（tar 保留可续传）
    try {
      const st = path.join(ctx.updateDir, 'staging');
      if (fs.existsSync(st)) { fs.rmSync(st, { recursive: true, force: true }); }
    } catch (_) { }
    return false;
  }
  if (cmpVersion(staged.version, APP_VERSION) <= 0 ||
      !fs.existsSync(path.join(ctx.updateDir, 'staging', 'qqqide.app'))) {
    log(ctx, 'update: stale staged v%s (local=%s) -> cleanup', staged.version, APP_VERSION);
    cleanupUpdateDir(ctx, true);
    return false;
  }
  _state = { phase: 'ready', version: staged.version };
  log(ctx, 'update: staged v%s restored (ready)', staged.version);
  return true;
}

function cleanupUpdateDir(ctx: MacCtx, includeTar: boolean): void {
  try { fs.rmSync(path.join(ctx.updateDir, 'staging'), { recursive: true, force: true }); } catch (_) { }
  try { fs.unlinkSync(path.join(ctx.updateDir, 'staged.json')); } catch (_) { }
  try { fs.unlinkSync(path.join(ctx.updateDir, 'staged.version')); } catch (_) { }
  if (includeTar) {
    try { fs.unlinkSync(path.join(ctx.updateDir, 'new.tar.gz')); } catch (_) { }
    try { fs.unlinkSync(path.join(ctx.updateDir, 'new.meta')); } catch (_) { }
    try { fs.rmSync(path.join(ctx.updateDir, 'units'), { recursive: true, force: true }); } catch (_) { }
  }
}

interface StagedInfo { version: string; arch: string; sha256: string; ts: number; }

function readStaged(ctx: MacCtx): StagedInfo | null {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(ctx.updateDir, 'staged.json'), 'utf8'));
    if (o && typeof o.version === 'string' && o.version) return o;
  } catch (_) { }
  return null;
}

function writeStaged(ctx: MacCtx, version: string, arch: string, sha256: string): void {
  try {
    fs.writeFileSync(path.join(ctx.updateDir, 'staged.json'),
      JSON.stringify({ version, arch, sha256, ts: Date.now() }), 'utf8');
    fs.writeFileSync(path.join(ctx.updateDir, 'staged.version'), version, 'utf8');
  } catch (_) { }
}

// ── 清单（签名 + 测试通道）────────────────────────────────────────────────
function testChannel(): any {
  if (!_ctx) return null;
  try { return JSON.parse(fs.readFileSync(path.join(_ctx.dataDir, 'update-channel.json'), 'utf8')); } catch (_) { return null; }
}
function testForce(): boolean {
  const c = testChannel();
  return !!(c && c.force);
}

async function fetchManifest(ctx: MacCtx): Promise<MacManifest | null> {
  const ch = testChannel();
  const urls: string[] = ch && ch.manifest_url
    ? [String(ch.manifest_url)]
    : [MANIFEST_URL];
  if (ch && ch.mirror_url) urls.push(String(ch.mirror_url));
  else if (!ch) urls.push(MANIFEST_MIRROR);

  for (const u of urls) {
    const raw = await fetchBuffer(u, 256 * 1024);
    if (!raw || raw.length === 0) continue;
    const txt = raw.toString('utf8');
    // Ed25519 验签（测试通道允许跳过 —— dev aid）
    if (!ch) {
      const sig = await fetchBuffer(u + '.sig', 4096);
      if (!sig || sig.length !== 64 || !verifyEd25519(Buffer.from(txt, 'utf8'), sig)) {
        log(ctx, 'update: manifest signature INVALID (security, keep old version)');
        continue;
      }
    } else {
      log(ctx, 'update: test channel active (manifest=%s, force=%s)', u, String(testForce()));
    }
    let mf: MacManifest | null = null;
    try { mf = JSON.parse(txt); } catch (_) { continue; }
    if (!mf || typeof mf.id !== 'string' || !mf.id || !mf.archs) continue;
    return mf;
  }
  return null;
}

// ── 下载（断点续传 + 镜像兑底 + sha256）────────────────────────────────────
async function downloadTar(ctx: MacCtx, mf: MacManifest, entry: ArchEntry, arch: string, tarPath: string): Promise<boolean> {
  // 版本仲裁: 目标版本变了 → 丢弃旧半截（禁跨版本字节复用）
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ctx.updateDir, 'new.meta'), 'utf8'));
    if (meta && (meta.version !== mf.id || meta.arch !== arch)) {
      try { fs.unlinkSync(tarPath); } catch (_) { }
    }
  } catch (_) { }
  try {
    fs.writeFileSync(path.join(ctx.updateDir, 'new.meta'),
      JSON.stringify({ version: mf.id, arch, t: Date.now() }), 'utf8');
  } catch (_) { }

  // 已完成判定（同会话重试 / 上次会话残留）
  if (safeSize(tarPath) === entry.size && await sha256Match(tarPath, entry.sha256)) return true;
  if (safeSize(tarPath) > entry.size) { try { fs.unlinkSync(tarPath); } catch (_) { } }

  const urls: string[] = [entry.url];
  if (entry.mirror) urls.push(entry.mirror);

  for (let round = 0; round < 2; round++) {
    for (const u of urls) {
      try {
        const r = await downloadOnce(ctx, u, tarPath, entry.size);
        void r;
        const now = safeSize(tarPath);
        if (now === entry.size) {
          if (await sha256Match(tarPath, entry.sha256)) return true;
          log(ctx, 'update: sha256 MISMATCH (security) -> discard & refetch');
          try { fs.unlinkSync(tarPath); } catch (_) { }
        } else if (now > 0) {
          log(ctx, 'update: download incomplete %d/%d (resume next attempt)', now, entry.size);
        }
      } catch (e: any) {
        log(ctx, 'update: download err (%s): %s', hostOf(u), (e && e.message) || String(e));
      }
    }
  }
  return safeSize(tarPath) === entry.size && await sha256Match(tarPath, entry.sha256);
}

// 单次下载（Range 续传 + 90s 无数据看门狗）；返回最终状态
async function downloadOnce(ctx: MacCtx, url: string, dest: string, expectSize: number, onProgress?: (got: number) => void): Promise<{ status: number; got: number }> {
  const existing = safeSize(dest);
  const { res } = await doGet(url, existing > 0 ? existing : null, 5);
  const st = res.statusCode || 0;
  if (st === 416) { res.resume(); return { status: 416, got: existing }; }
  if (st !== 200 && st !== 206) { res.resume(); throw new Error('http ' + st); }
  const out = fs.createWriteStream(dest, { flags: st === 206 ? 'a' : 'w' });
  let got = st === 206 ? existing : 0;
  await new Promise<void>((resolve, reject) => {
    let last = Date.now();
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearInterval(iv); fn(); } };
    const iv = setInterval(() => {
      if (Date.now() - last > IDLE_TIMEOUT) {
        finish(() => { try { res.destroy(); } catch (_) { } try { out.destroy(); } catch (_) { } reject(new Error('stalled (idle ' + (IDLE_TIMEOUT / 1000) + 's)')); });
      }
    }, 5000);
    res.on('data', (c: Buffer) => {
      last = Date.now();
      got += c.length;
      const now = Date.now();
      if (now - _lastProgressAt > 1000 || got >= expectSize) {
        _lastProgressAt = now;
        if (onProgress) { try { onProgress(got); } catch (_) { } }
        else { setState({ phase: 'downloading', version: _state.version, got, total: expectSize, pct: expectSize ? Math.floor(got / expectSize * 100) : 0 }); }
      }
    });
    res.pipe(out);
    out.on('error', (e: Error) => finish(() => reject(e)));
    out.on('finish', () => finish(() => resolve()));
    res.on('error', (e: Error) => finish(() => reject(e)));
  });
  return { status: st, got };
}

// ── v2 增量单元（状态 / 计划 / 下载 / 装配）──────────────────────────────
//   契约: {Data}/units.json = {fmt,id,arch,base,units:{meta,shell-out,webapp,engines}}
//   与 gaea/cf/up/mac_units.py 对齐；base/单元 sha 均来自签名清单，客户端不做树哈希。

function unitsStatePath(ctx: MacCtx): string { return path.join(ctx.dataDir, 'units.json'); }

function readLocalUnits(ctx: MacCtx): LocalUnits | null {
  try {
    const o = JSON.parse(fs.readFileSync(unitsStatePath(ctx), 'utf8'));
    if (o && o.fmt === 1 && typeof o.id === 'string' && typeof o.arch === 'string' &&
        typeof o.base === 'string' && o.units && typeof o.units === 'object') {
      return o;
    }
  } catch (_) { }
  return null;
}

function writeJsonAtomic(p: string, obj: any): void {
  const t = p + '.tmp' + process.pid;
  fs.writeFileSync(t, JSON.stringify(obj), 'utf8');
  fs.renameSync(t, p);
}

function unitsFromManifest(mf: MacManifest, arch: string): LocalUnits | null {
  try {
    const us = mf.archs[arch] && mf.archs[arch].units;
    if (!us || !us['base'] || !us['base'].sha256) return null;
    const out: LocalUnits = { fmt: 1, id: mf.id, arch, base: us['base'].sha256, units: {} };
    for (const n of UNIT_NAMES) {
      if (!us[n] || !us[n].sha256) return null;
      out.units[n] = us[n].sha256;
    }
    return out;
  } catch (_) { return null; }
}

// 状态自愈: 清单版本 == 本地运行版本（清单即自身描述）→ 重建本地状态（幂等，免一次全量）
function healUnitsState(ctx: MacCtx, mf: MacManifest, arch: string): void {
  try {
    if (mf.id !== APP_VERSION) return;
    const want = unitsFromManifest(mf, arch);
    if (!want) return;
    const cur = readLocalUnits(ctx);
    if (cur && cur.id === want.id && cur.arch === arch && cur.base === want.base &&
        UNIT_NAMES.every(n => cur.units[n] === want.units[n])) return;
    writeJsonAtomic(unitsStatePath(ctx), want);
    log(ctx, 'update: units state healed from manifest (v%s, %s)', mf.id, arch);
  } catch (_) { }
}

// 换装成功后助手提升 pending；此处为启动兜底（pending.id == 本地版本 → 提升）
function promotePendingUnits(ctx: MacCtx): void {
  try {
    const p = path.join(ctx.dataDir, 'units.pending.json');
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (o && o.id === APP_VERSION) {
      try { fs.renameSync(p, unitsStatePath(ctx)); }
      catch (_) { try { fs.copyFileSync(p, unitsStatePath(ctx)); fs.unlinkSync(p); } catch (_) { } }
      log(ctx, 'update: units state promoted (v%s)', o.id);
    }
  } catch (_) { }
}

function writeUnitsPending(ctx: MacCtx, mf: MacManifest, arch: string): void {
  try {
    const want = unitsFromManifest(mf, arch);
    if (!want) return;
    writeJsonAtomic(path.join(ctx.dataDir, 'units.pending.json'), want);
  } catch (_) { }
}

interface IncrementalPlan { changed: string[]; total: number; }

function planIncremental(mf: MacManifest, arch: string, entry: ArchEntry, st: LocalUnits | null): IncrementalPlan | null {
  try {
    if (!st || st.fmt !== 1) return null;
    if (st.id !== APP_VERSION || st.arch !== arch) return null;   // 状态必须描述正在运行的这棵树
    const us = entry.units;
    if (!us || !us['base'] || !us['base'].sha256) return null;
    if (st.base !== us['base'].sha256) return null;               // base 变化 → 全量（正确性优先）
    const changed: string[] = [];
    let total = 0;
    for (const n of UNIT_NAMES) {
      const u = us[n];
      if (!u || !u.sha256 || !u.url || !(u.size && u.size > 0)) return null;
      if (!st.units[n]) return null;
      if (st.units[n] !== u.sha256) { changed.push(n); total += u.size; }
    }
    if (!changed.length) return null;                              // 版本更高却零变化 → 全量保底
    return { changed, total };
  } catch (_) { return null; }
}

async function downloadUnitFile(ctx: MacCtx, name: string, u: UnitEntry, dest: string,
                               onProg: (got: number) => void): Promise<boolean> {
  if (!u.size || !u.sha256) return false;
  if (safeSize(dest) === u.size && await sha256Match(dest, u.sha256)) return true;
  if (safeSize(dest) > u.size) { try { fs.unlinkSync(dest); } catch (_) { } }
  const urls: string[] = [u.url!];
  if (u.mirror) urls.push(u.mirror);
  for (let round = 0; round < 2; round++) {
    for (const url of urls) {
      try {
        await downloadOnce(ctx, url, dest, u.size, onProg);
        const now = safeSize(dest);
        if (now === u.size && await sha256Match(dest, u.sha256)) return true;
        if (now === u.size) {
          log(ctx, 'update: unit %s sha256 MISMATCH -> discard & refetch', name);
          try { fs.unlinkSync(dest); } catch (_) { }
        }
      } catch (e: any) {
        log(ctx, 'update: unit %s err (%s): %s', name, hostOf(url), (e && e.message) || String(e));
      }
    }
  }
  return safeSize(dest) === u.size && await sha256Match(dest, u.sha256);
}

// 增量全链: 下载变化单元 → 拷贝 live 树 + 目录级替换装配 → 结构抽检 → 预签名 → 暂存
// 返回 'ok' = 已暂存就绪 / 'fallback' = 任一环节失败（调用方回退全量）
async function runIncremental(ctx: MacCtx, mf: MacManifest, arch: string, entry: ArchEntry,
                              plan: IncrementalPlan): Promise<'ok' | 'fallback'> {
  const staging = path.join(ctx.updateDir, 'staging');
  const unitsDir = path.join(ctx.updateDir, 'units');
  const cleanupStaging = () => { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { } };

  // 0) 磁盘（本地树拷贝 + 单元 + 签名余量）
  if (!await hasDiskSpace(ctx, entry.size * 3 + 512 * 1024 * 1024)) return 'fallback';

  // 1) 下载变化单元（半截保留续传；目标版本变化 → 丢弃）
  try {
    const um = path.join(unitsDir, 'meta.json');
    let keep = false;
    try {
      const o = JSON.parse(fs.readFileSync(um, 'utf8'));
      keep = !!(o && o.version === mf.id && o.arch === arch);
    } catch (_) { }
    if (!keep) { try { fs.rmSync(unitsDir, { recursive: true, force: true }); } catch (_) { } }
    fs.mkdirSync(unitsDir, { recursive: true });
    fs.writeFileSync(um, JSON.stringify({ version: mf.id, arch, t: Date.now() }), 'utf8');
  } catch (_) { return 'fallback'; }

  setState({ phase: 'downloading', version: mf.id, got: 0, total: plan.total, pct: 0 });
  let doneBytes = 0;
  for (const n of plan.changed) {
    const u = entry.units![n];
    const dest = path.join(unitsDir, n + '.tar.gz');
    const ok = await downloadUnitFile(ctx, n, u, dest, (got) => {
      const total = plan.total || 1;
      const all = doneBytes + got;
      setState({ phase: 'downloading', version: mf.id, got: all, total: plan.total, pct: Math.floor(all / total * 100) });
    });
    if (!ok) { log(ctx, 'update: unit %s download failed', n); return 'fallback'; }
    doneBytes += u.size || 0;
    log(ctx, 'update: unit %s OK (%d bytes)', n, u.size || 0);
  }

  // 2) 装配: live 树拷贝 + 变化单元目录级替换（删除语义 = 整目录替换，天然正确）
  setState({ phase: 'staging', version: mf.id, step: 'assemble' });
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { }
  fs.mkdirSync(staging, { recursive: true });
  let r = await spawnCapture('/bin/cp', ['-a', ctx.bundleDir, path.join(staging, 'qqqide.app')],
    { cwd: ctx.updateDir, timeoutMs: 15 * 60 * 1000 });
  if (r.code !== 0) { log(ctx, 'update: copy live app FAIL ec=%d %s', r.code, tail(r.out, 300)); cleanupStaging(); return 'fallback'; }

  const changed = new Set(plan.changed);
  for (const n of ['shell-out', 'webapp', 'engines']) {
    if (!changed.has(n)) continue;
    const target = path.join(staging, UNIT_DIRS[n]);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { }
    r = await spawnCapture('/usr/bin/tar', ['-xzf', path.join(unitsDir, n + '.tar.gz'), '-C', staging],
      { cwd: ctx.updateDir, timeoutMs: 10 * 60 * 1000 });
    if (r.code !== 0) { log(ctx, 'update: unit extract FAIL (%s) ec=%d %s', n, r.code, tail(r.out, 300)); cleanupStaging(); return 'fallback'; }
  }
  if (changed.has('meta')) {
    r = await spawnCapture('/usr/bin/tar', ['-xzf', path.join(unitsDir, 'meta.tar.gz'), '-C', staging],
      { cwd: ctx.updateDir, timeoutMs: 5 * 60 * 1000 });
    if (r.code !== 0) { log(ctx, 'update: meta extract FAIL ec=%d %s', r.code, tail(r.out, 300)); cleanupStaging(); return 'fallback'; }
  }

  // 3) 结构抽检（半成品绝不进签名/换装）
  const checks: Array<[string, string]> = [
    [path.join(staging, 'qqqide.app', 'Contents', 'MacOS'), 'MacOS'],
    [path.join(staging, 'qqqide.app', 'Contents', 'Info.plist'), 'Info.plist'],
    [path.join(staging, 'qqqide.app', 'Contents', 'Resources', 'app', 'shell-out', 'main.js'), 'shell-out/main.js'],
  ];
  if (changed.has('webapp')) checks.push([path.join(staging, 'qqqide.app', 'Contents', 'Resources', 'app', 'webapp', 'index.html'), 'webapp/index.html']);
  if (changed.has('engines')) checks.push([path.join(staging, 'qqqide-data', 'engines', 'manifest.json'), 'engines/manifest.json']);
  for (const [p, label] of checks) {
    if (!fs.existsSync(p)) { log(ctx, 'update: incremental structure gate FAIL (%s)', label); cleanupStaging(); return 'fallback'; }
  }

  // 4) 预签名（与全量路径同链）
  setState({ phase: 'staging', version: mf.id, step: 'sign' });
  if (!await ensureSigningIdentity(ctx)) { cleanupStaging(); failSoft(ctx, 'signing identity unavailable'); return 'ok'; }
  if (!await signApp(ctx, path.join(staging, 'qqqide.app'))) { cleanupStaging(); failSoft(ctx, 'codesign failed'); return 'ok'; }

  // 5) 暂存 + 增量状态（换装成功后提升为正式状态）
  writeUnitsPending(ctx, mf, arch);
  writeStaged(ctx, mf.id, arch, entry.sha256);
  setState({ phase: 'ready', version: mf.id });
  recordStatus(ctx, 'waiting');
  log(ctx, 'update: staged v%s (incremental %s, ready, waiting user restart)', mf.id, plan.changed.join('+'));
  return 'ok';
}

// ── 解压 / 签名 ────────────────────────────────────────────────────────────
async function extractStaging(ctx: MacCtx, tarPath: string): Promise<boolean> {
  const staging = path.join(ctx.updateDir, 'staging');
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { }
  fs.mkdirSync(staging, { recursive: true });
  const r = await spawnCapture('/usr/bin/tar', ['-xzf', tarPath, '-C', staging], { cwd: ctx.updateDir, timeoutMs: 10 * 60 * 1000 });
  if (r.code !== 0) {
    log(ctx, 'update: tar extract FAIL ec=%d %s', r.code, tail(r.out, 300));
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { }
    return false;
  }
  return true;
}

function keychainPath(): string {
  return path.join(os.homedir(), 'Library', 'Keychains', 'qqqide-sign.keychain-db');
}

async function ensureSigningIdentity(ctx: MacCtx): Promise<boolean> {
  const kc = keychainPath();
  if (!fs.existsSync(kc)) {
    // 与「首次启动.command」同流程自动创建（openssl 自签 → pkcs12 → import）
    log(ctx, 'update: signing cert missing, creating (first-launch flow)');
    const tmp = path.join(ctx.updateDir, 'cert');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
    fs.mkdirSync(tmp, { recursive: true });
    const cnf = path.join(tmp, 'o.cnf');
    fs.writeFileSync(cnf, [
      '[req]', 'distinguished_name = dn', 'x509_extensions = req_ext', 'prompt = no',
      '[dn]', 'CN = ' + CERT_NAME, 'O = qqqide',
      '[req_ext]', 'extendedKeyUsage = codeSigning', 'keyUsage = digitalSignature',
      'basicConstraints = critical, CA:false', '',
    ].join('\n'));
    const k = path.join(tmp, 'k.pem');
    const c = path.join(tmp, 'c.pem');
    const p12 = path.join(tmp, 's.p12');
    let r = await spawnCapture('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', k, '-out', c, '-days', '3650', '-nodes', '-config', cnf], { cwd: tmp, timeoutMs: 60000 });
    if (r.code === 0) r = await spawnCapture('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', k, '-in', c, '-out', p12, '-passout', 'pass:' + KC_PASS], { cwd: tmp, timeoutMs: 60000 });
    if (r.code === 0) r = await spawnCapture('/usr/bin/security', ['create-keychain', '-p', KC_PASS, kc], { cwd: tmp, timeoutMs: 60000 });
    if (r.code === 0) r = await spawnCapture('/usr/bin/security', ['unlock-keychain', '-p', KC_PASS, kc], { cwd: tmp, timeoutMs: 60000 });
    if (r.code === 0) r = await spawnCapture('/usr/bin/security', ['import', p12, '-k', kc, '-P', KC_PASS, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'], { cwd: tmp, timeoutMs: 60000 });
    if (r.code === 0) r = await spawnCapture('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', KC_PASS, kc], { cwd: tmp, timeoutMs: 60000 });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
    if (r.code !== 0) {
      log(ctx, 'update: cert create FAIL ec=%d %s', r.code, tail(r.out, 300));
      return false;
    }
    log(ctx, 'update: signing cert created');
  }
  // 搜索列表保障（无头/异常会话下 codesign 要求钥匙串在搜索列表 —— SSH 实测）
  try {
    const r = await spawnCapture('/usr/bin/security', ['list-keychains', '-d', 'user'], { cwd: ctx.updateDir, timeoutMs: 15000 });
    const list = (r.out || '').split('\n').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    if (list.length && list.indexOf(kc) === -1) {
      await spawnCapture('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...list, kc], { cwd: ctx.updateDir, timeoutMs: 15000 });
    }
  } catch (_) { }
  // 解锁 + partition（F17 实测连招: 无头会话 codesign 必需）
  await spawnCapture('/usr/bin/security', ['unlock-keychain', '-p', KC_PASS, kc], { cwd: ctx.updateDir, timeoutMs: 30000 });
  await spawnCapture('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', KC_PASS, kc], { cwd: ctx.updateDir, timeoutMs: 30000 });
  return true;
}

async function signApp(ctx: MacCtx, appPath: string): Promise<boolean> {
  // 去隔离/xattr 必须在签名之前（签名后绝不再动属性）
  await spawnCapture('/usr/bin/xattr', ['-cr', appPath], { cwd: ctx.updateDir, timeoutMs: 120000 });
  const r = await spawnCapture('/usr/bin/codesign',
    ['--force', '--deep', '--sign', CERT_NAME, '--keychain', keychainPath(), appPath],
    { cwd: ctx.updateDir, timeoutMs: 10 * 60 * 1000 });
  if (r.code !== 0) {
    log(ctx, 'update: codesign FAIL ec=%d %s', r.code, tail(r.out, 300));
    return false;
  }
  const v = await spawnCapture('/usr/bin/codesign', ['--verify', appPath], { cwd: ctx.updateDir, timeoutMs: 120000 });
  if (v.code !== 0) {
    log(ctx, 'update: codesign --verify FAIL ec=%d %s', v.code, tail(v.out, 300));
    return false;
  }
  return true;
}

// ── HTTP（重定向 + Range + 静默看门狗）─────────────────────────────────────
function doGet(urlStr: string, rangeFrom: number | null, redirectsLeft: number): Promise<{ res: http.IncomingMessage; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { reject(new Error('bad protocol')); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const headers: any = { 'User-Agent': 'qqqide-mac/' + APP_VERSION };
    if (rangeFrom !== null && rangeFrom > 0) headers['Range'] = 'bytes=' + rangeFrom + '-';
    let req: http.ClientRequest;
    try {
      req = mod.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers,
        timeout: 30000,
      }, (res) => {
        const st = res.statusCode || 0;
        if (st >= 300 && st < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          let next: string;
          try { next = new URL(res.headers.location, u).toString(); } catch (_) { next = String(res.headers.location); }
          doGet(next, rangeFrom, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        resolve({ res, req });
      });
    } catch (e) { reject(e); return; }
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

async function fetchBuffer(url: string, cap: number): Promise<Buffer | null> {
  try {
    const { res } = await doGet(url, null, 5);
    if ((res.statusCode || 0) !== 200) { res.resume(); return null; }
    const chunks: Buffer[] = [];
    let n = 0;
    return await new Promise<Buffer | null>((resolve) => {
      res.on('data', (c: Buffer) => {
        n += c.length;
        if (n > cap) { res.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
  } catch (_) { return null; }
}

function hostOf(u: string): string {
  try { return new URL(u).host; } catch (_) { return u.slice(0, 40); }
}

// ── 工具 ───────────────────────────────────────────────────────────────────
function verifyEd25519(data: Buffer, sig: Buffer): boolean {
  try {
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(PUBKEY_HEX, 'hex'),
    ]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, data, key, sig);
  } catch (_) { return false; }
}

function sha256Match(p: string, expectHex: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(p);
      s.on('data', (d) => h.update(d));
      s.on('end', () => resolve(h.digest('hex').toLowerCase() === String(expectHex).toLowerCase()));
      s.on('error', () => resolve(false));
    } catch (_) { resolve(false); }
  });
}

function spawnCapture(exe: string, args: string[], opts: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let done = false;
    const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : '/';
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ code: 1, out: 'spawn error: ' + ((e && e.message) || e) });
      return;
    }
    let out = '';
    const acc = (d: any) => { out += String(d); if (out.length > 6000) out = out.slice(out.length - 6000); };
    if (child.stdout) child.stdout.on('data', acc);
    if (child.stderr) child.stderr.on('data', acc);
    const t = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL'); } catch (_) { } resolve({ code: 124, out }); }
    }, opts.timeoutMs || 60000);
    child.on('error', (e: any) => { if (!done) { done = true; clearTimeout(t); resolve({ code: 1, out: out + ' err:' + ((e && e.message) || e) }); } });
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code: code === null ? 1 : code, out }); } });
  });
}

async function hasDiskSpace(ctx: MacCtx, needBytes: number): Promise<boolean> {
  try {
    const r = await spawnCapture('/bin/df', ['-k', ctx.parentDir], { cwd: ctx.updateDir, timeoutMs: 15000 });
    const line = (r.out || '').trim().split('\n').pop() || '';
    const parts = line.split(/\s+/);
    const availKb = parseInt(parts[3], 10);
    if (!availKb || isNaN(availKb)) return true;
    if (availKb * 1024 < needBytes) {
      log(ctx, 'update: disk space low (avail %dMB < need %dMB)', Math.round(availKb / 1024), Math.round(needBytes / 1024 / 1024));
      return false;
    }
    return true;
  } catch (_) { return true; }
}

// Ed25519 同款语义版本比较（数字段）
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

function safeSize(p: string): number {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

function tail(s: string, n: number): string {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(s.length - n) : s;
}

// ── 换装助手脚本（每次 apply 重写；bash 字符串禁用单引号 —— JS 单引号语义）────
function helperScript(): string {
  return [
    '#!/bin/bash',
    '# qqqide macOS 更新助手 v2（「重启更新」或退出即换触发；MODE=restart|quiet）',
    '# 等待主程序退出 -> 原子换装(.app + engines) -> 换装前结构门 -> 启动健康检查失败自动回滚',
    'set -u',
    'UPD="$(cd "$(dirname "$0")" && pwd)"',
    'DIR="$(cd "$UPD/.." && pwd)"',
    'LOG="$UPD/update.log"',
    'SWAPLOG="$DIR/qqqide-data/Data/launcher-swap.log"',
    'OLD_PID="${1:-}"',
    'MODE="${2:-restart}"',
    '',
    'APP="$DIR/qqqide.app"',
    'NEWAPP="$UPD/staging/qqqide.app"',
    'ENG="$DIR/qqqide-data/engines"',
    'NEWENG="$UPD/staging/qqqide-data/engines"',
    'STAGED_VER="$(cat "$UPD/staged.version" 2>/dev/null || echo ?)"',
    '',
    'log() {',
    '  echo "$(date +%Y-%m-%dT%H:%M:%S) [apply] $1" >> "$LOG"',
    '  echo "$(date +%Y-%m-%dT%H:%M:%S) [mac-apply] $1" >> "$SWAPLOG" 2>/dev/null || true',
    '}',
    '',
    '# ★ tree_alive 用 pgrep（自动排除自身；ps|grep 会自匹配 grep 自己的 argv → 恒真假活）',
    'tree_alive() { pgrep -f "$APP/" >/dev/null 2>&1; }',
    '',
    'log "helper start (pid=$OLD_PID dir=$DIR staged=$STAGED_VER)"',
    '',
    '# 1. 等待主程序退出',
    'if [ -n "$OLD_PID" ]; then',
    '  for i in $(seq 1 240); do',
    '    kill -0 "$OLD_PID" 2>/dev/null || break',
    '    sleep 0.5',
    '  done',
    'fi',
    '# 2. 等待 .app 树全部进程退出（goods/py-broker/helpers；rename 在 macOS 上对存活进程也安全）',
    'for i in $(seq 1 60); do',
    '  tree_alive || break',
    '  sleep 0.5',
    'done',
    'if tree_alive; then log "WARN: some processes still alive, proceeding"; fi',
    '',
    '# 3. 结构门: 换装源必须完整（防半成品砖掉安装）',
    'if [ ! -d "$NEWAPP/Contents/MacOS" ] || [ ! -d "$NEWAPP/Contents/Resources/app" ]; then',
    '  log "FATAL: staged app incomplete, abort (old version kept)"',
    '  exit 2',
    'fi',
    '',
    '# 4. 换装 .app（先轮换回滚点）',
    'rm -rf "$DIR/qqqide-app-prev" 2>/dev/null',
    'if ! mv "$APP" "$DIR/qqqide-app-prev" 2>>"$LOG"; then',
    '  log "FATAL: cannot move current app (not writable?)"',
    '  exit 2',
    'fi',
    'if ! mv "$NEWAPP" "$APP" 2>>"$LOG"; then',
    '  log "FATAL: cannot move new app; rolling back"',
    '  mv "$DIR/qqqide-app-prev" "$APP" 2>/dev/null',
    '  exit 2',
    'fi',
    'log "app swapped"',
    '',
    '# 5. 换装 engines（存在才换；失败保留旧树不阻塞）',
    'if [ -d "$NEWENG" ]; then',
    '  rm -rf "$DIR/qqqide-data/engines-prev" 2>/dev/null',
    '  if mv "$ENG" "$DIR/qqqide-data/engines-prev" 2>>"$LOG" && mv "$NEWENG" "$ENG" 2>>"$LOG"; then',
    '    log "engines swapped"',
    '  else',
    '    log "WARN: engines swap failed (old tree kept)"',
    '    [ -d "$ENG" ] || mv "$DIR/qqqide-data/engines-prev" "$ENG" 2>/dev/null',
    '  fi',
    'fi',
    '',
    '# 6. 刷新包内辅助文件（新包的启动脚本/说明/版本文件）',
    'for f in "首次启动.command" "README-使用说明.txt" "version"; do',
    '  if [ -f "$UPD/staging/$f" ]; then cp -f "$UPD/staging/$f" "$DIR/$f" 2>/dev/null; fi',
    'done',
    '',
    '# 7. 签名自检（仅告警: 签名已在暂存期完成）',
    'codesign --verify "$APP" 2>>"$LOG" || log "WARN: signature verify failed"',
    '',
    '# 8. 启动 / 健康验证（restart: 拉起 GUI 等其稳定；quiet: 无头探针自检，不打断用户）',
    'OK=0',
    'if [ "$MODE" = "quiet" ]; then',
    '  PROBE="$UPD/probe-result"',
    '  rm -f "$PROBE" 2>/dev/null',
    '  "$APP/Contents/MacOS/qqqide" --update-probe "$PROBE" >/dev/null 2>&1 &',
    '  PP=$!',
    '  for i in $(seq 1 30); do',
    '    kill -0 "$PP" 2>/dev/null || break',
    '    sleep 1',
    '  done',
    '  kill -0 "$PP" 2>/dev/null && kill -9 "$PP" 2>/dev/null',
    '  log "probe: $(cat "$PROBE" 2>/dev/null || echo no-result)"',
    '  if grep -q "^ok" "$PROBE" 2>/dev/null; then OK=1; fi',
    'else',
    '  open "$APP" 2>>"$LOG" || log "WARN: open failed"',
    '',
    '# 9. 健康检查（restart 模式：每 2s 一轮 × 20 = 40s；pgrep 自匹配安全 + 3s 稳定性复检防“秒退假活”；失败自动回滚）',
    'for i in $(seq 1 20); do',
    '  sleep 2',
    '  if pgrep -f "$APP/Contents/MacOS/qqqide" >/dev/null 2>&1; then',
    '    sleep 3',
    '    if pgrep -f "$APP/Contents/MacOS/qqqide" >/dev/null 2>&1; then OK=1; fi',
    '    break',
    '  fi',
    'done',
    'fi',
    'if [ "$OK" = "1" ]; then',
    '  log "update OK -> v$STAGED_VER"',
    '  if [ -f "$DIR/qqqide-data/Data/units.pending.json" ]; then',
    '    mv -f "$DIR/qqqide-data/Data/units.pending.json" "$DIR/qqqide-data/Data/units.json" 2>/dev/null && log "units state promoted"',
    '  fi',
    '  echo "done $STAGED_VER" > "$UPD/apply-result"',
    '  rm -rf "$UPD/staging" "$UPD/units" "$UPD/new.tar.gz" "$UPD/new.meta" "$UPD/staged.json" "$UPD/staged.version" 2>/dev/null',
    'else',
    '  log "health check failed ($MODE); ROLLING BACK"',
    '  rm -rf "$DIR/qqqide.app.failed" 2>/dev/null',
    '  mv "$APP" "$DIR/qqqide.app.failed" 2>/dev/null',
    '  mv "$DIR/qqqide-app-prev" "$APP" 2>/dev/null',
    '  if [ -d "$DIR/qqqide-data/engines-prev" ]; then',
    '    rm -rf "$DIR/qqqide-data/engines.failed" 2>/dev/null',
    '    mv "$ENG" "$DIR/qqqide-data/engines.failed" 2>/dev/null',
    '    mv "$DIR/qqqide-data/engines-prev" "$ENG" 2>/dev/null',
    '  fi',
    '  if [ "$MODE" != "quiet" ]; then open "$APP" 2>>"$LOG"; fi',
    '  rm -f "$DIR/qqqide-data/Data/units.pending.json" 2>/dev/null',
    '  echo "rollback" > "$UPD/apply-result"',
    '  log "ROLLED BACK to previous version"',
    'fi',
    '',
  ].join('\n');
}

// ── 遥测 / 日志（与 Windows 同文件同格式: Data/updater-status.json + Data/launcher-swap.log）──
function recordStatus(ctx: MacCtx, rc: 'ok' | 'waiting' | 'failed'): void {
  try {
    const st = { ts: Date.now(), result: rc, line: _lastLine };
    fs.writeFileSync(path.join(ctx.dataDir, 'updater-status.json'), JSON.stringify(st), 'utf8');
  } catch (_) { }
  if (rc === 'failed') notifyUpdateFailed();
}

function log(ctx: MacCtx, fmt: string, ...args: any[]): void {
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
    _lastLine = msg.length > 200 ? msg.slice(0, 200) : msg;
  } catch (_) { }
}

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return '[' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ']';
}
