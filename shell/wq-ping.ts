// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// wq-ping.ts — 统计上报机（轻量，主进程独立运行）
//
// 职责：
//   1. 生成/持久化 device_id (UUID v4) + factory_version 到 Data/alphal/
//   2. 累计使用时长：跨重启持久化到 Data/alphal/cumulative_seconds
//      → 每次 ping 上报绝对值 → 服务端 max(old, new) 接受
//   3. 定期 POST /api/wq/ping（首次 30~120s 随机抖动，后续按服务端建议）
//   4. 失败指数退避重试
//
// 铁律：
//   - 不阻塞启动，不阻塞渲染进程
//   - 网络错误静默处理（不影响 IDE 功能）
//   - 使用 Node.js https 模块（Electron 主进程可用，零依赖）
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as https from 'https';
import { safeStorage } from 'electron';
import { APP_VERSION } from './version';
import { getDataDir, getAppRoot } from './portable-paths';
import { getAuthPhone } from './auth-state';
import { getComponentBin } from './component-checker';
import { vigSnapshot, vigSet, winthereExternal } from './vig';
import { kopeStatsSync, kopeWarmup } from './ipc-kope';

// ── 常量 ────────────────────────────────────────────────────────────────────
const PING_API_HOST = 'direct-cn.gh555.com';
const PING_API_PATH = '/api/wq/ping';
const GOOD_SLG = 'qqqide';
const DISTRIBUTION = 'gh555.com';    // 发行渠道（当前唯一，将来可扩展）
const PING_JITTER_MIN_MS = 5_000;    // 首次 ping 最小延迟
const PING_JITTER_MAX_MS = 15_000;   // 首次 ping 最大延迟
const PING_FALLBACK_SEC = 43_200;    // 兜底间隔 12 小时
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;      // 最大 1 小时

// ── 状态 ────────────────────────────────────────────────────────────────────
let _deviceId = '';
let _factoryVersion = '';
let _cumulativeSeconds = 0;          // 上次持久化的累计秒数
let _sessionStartedAt = Date.now();  // 本次进程启动时间
let _stopped = false;
let _retryDelayMs = RETRY_MIN_MS;
let _lastFailNotifyAt = 0;      // ★ 升级失败即时补发节流（30min）
let _updHealthCache: Record<string, unknown> | null | undefined; // undefined=未探测
// ★ 偿还（playing）状态（Savor 移植 2026-09-19）：播放中 → ping 携带 playing=true
let _isCurrentlyPlaying = false;
let _lastPlayingPingTime = 0;   // playing ping 5min 防抖（与服务器限速同口径）
let _timer: ReturnType<typeof setTimeout> | null = null;
let _userDataPath = '';              // ★ portable.userData，启动时注入

// ── 磁盘日志（调试用，零依赖，原子 append）──────────────────────────────────
let _logPath = '';
function pingLog(msg: string): void {
    if (!_logPath) {
        const base = _userDataPath || getDataDir();
        _logPath = path.join(base, 'alphal', 'wq-ping.log');
        try { fs.mkdirSync(path.dirname(_logPath), { recursive: true }); } catch (_) { }
    }
    const line = new Date().toISOString() + ' ' + msg + '\n';
    try { fs.appendFileSync(_logPath, line); } catch (_) { }
}

// ── 持久化路径 ──────────────────────────────────────────────────────────────
function alphalDir(): string {
    // ★ 优先用注入的 userData 路径（与 main.ts 一致），
    //    兜底用 execPath 旁 Data/alphal（绿色包兼容）
    const base = _userDataPath || getDataDir();
    const dataDir = path.join(base, 'alphal');
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { }
    return dataDir;
}

function deviceIdPath(): string {
    return path.join(alphalDir(), 'device_id');
}

function factoryVersionPath(): string {
    return path.join(alphalDir(), 'factory_version');
}

function cumulativeSecondsPath(): string {
    return path.join(alphalDir(), 'cumulative_seconds');
}

// ── Device ID ───────────────────────────────────────────────────────────────
function loadOrCreateDeviceId(): string {
    const fp = deviceIdPath();
    try {
        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf8').trim();
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
                return raw.toLowerCase();
            }
        }
    } catch (_) { }

    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    const uuid = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;

    try { fs.writeFileSync(fp, uuid, 'utf8'); } catch (_) { }
    return uuid;
}

// ── 工厂版本 ───────────────────────────────────────────────────────────────
function loadOrCreateFactoryVersion(): string {
    const fp = factoryVersionPath();
    try {
        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf8').trim();
            if (raw.length > 0 && raw.length <= 50) return raw;
        }
    } catch (_) { }

    const fv = APP_VERSION;
    try { fs.writeFileSync(fp, fv, 'utf8'); } catch (_) { }
    return fv;
}

// ── 累计秒数（跨重启持久化）────────────────────────────────────────────────
function loadCumulativeSeconds(): number {
    const fp = cumulativeSecondsPath();
    try {
        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf8').trim();
            const n = parseInt(raw, 10);
            if (n >= 0 && n < 315360000) return n; // 0 ~ 10年
        }
    } catch (_) { }
    return 0;
}

function persistCumulativeSeconds(total: number): void {
    try {
        fs.writeFileSync(cumulativeSecondsPath(), String(Math.floor(total)), 'utf8');
    } catch (_) { }
}

// 当前累计 = 上次持久化值 + 本次进程存活时间
function currentTotalSeconds(): number {
    return _cumulativeSeconds + Math.floor((Date.now() - _sessionStartedAt) / 1000);
}

// ── Doer ID（从 auth.enc 读手机号）───────────────────────────────────────────
function authFilePath(): string {
    return path.join(alphalDir(), 'auth.enc');
}

function readDoerID(): string {
    // ★ 第一优先：共享内存（由 main.ts IPC handler 更新，免 safeStorage）
    const cached = getAuthPhone();
    if (cached && /^\d{7,20}$/.test(cached)) return cached;

    // ★ 第二优先：safeStorage 直接解密（兜底）
    try {
        if (safeStorage.isEncryptionAvailable()) {
            const fp = authFilePath();
            if (fs.existsSync(fp)) {
                const encrypted = fs.readFileSync(fp);
                const auth = JSON.parse(safeStorage.decryptString(encrypted));
                if (auth && auth.phone && /^\d{7,20}$/.test(auth.phone)) return auth.phone;
            }
        }
    } catch (_) { }

    // ★ 第三优先：纯文本 phone.txt 终极兜底（防 DPAPI 跨目录/跨用户失效）
    try {
        const phoneFile = path.join(alphalDir(), 'phone.txt');
        if (fs.existsSync(phoneFile)) {
            const phone = fs.readFileSync(phoneFile, 'utf8').trim();
            if (phone && /^\d{7,20}$/.test(phone)) return phone;
        }
    } catch (_) { }

    return '';
}

// ── 升级健康遥测（2026-09-04，piggyback 零新端点）─────────────────────────
// 读 {packRoot}/gh555.com/versions.json + Data/updater-status.json + 包根 .apply-fails
// 全部 try/catch 容错：任一缺失/损坏 → 字段省略，绝不影响主 ping。
// dev 模式无绿色包结构 → 返回 null（零字段零噪音）。
function collectUpdHealth(): Record<string, unknown> | null {
  try {
    // ★ 2026-09-15 路径修复: base = {pack}/gh555.com/Data → liveDir = {pack}/gh555.com → packRoot = {pack}
    //   旧代码 path.join(dirname(base), 'gh555.com') 二次拼接出 gh555.com/gh555.com
    //   → versions.json/qqqide.exe 探测恒失败 → 遥测字段永不携带（生产 qqqide_upd_health 全表 0 行）。
    const base = _userDataPath || getDataDir();
    const liveDir = path.dirname(base);
    const packRoot = path.dirname(liveDir);
    // ★ 2026-09-18 mac 分支: 无 qqqide.exe/versions.json —— {托管根}/qqqide.app + qqqide-data 布局
    //   （mac 更新状态同样可观测: updater-status.json + .update/staged.json）
    if (process.platform === 'darwin' && !fs.existsSync(path.join(packRoot, 'qqqide.exe'))) {
      if (!fs.existsSync(path.join(packRoot, 'qqqide.app'))) return null;
      const hm: Record<string, unknown> = { upd_live_ver: APP_VERSION, upd_launcher: '', upd_fails: 0 };
      try {
        const s = JSON.parse(fs.readFileSync(path.join(base, 'updater-status.json'), 'utf8'));
        const r = s && s.result;
        hm.upd_status = (r === 'ok' || r === 'waiting' || r === 'failed') ? r : '';
        hm.upd_code = (typeof s.line === 'string' && s.line) ? s.line.slice(0, 200) : '';
        hm.upd_at = Math.floor((Number(s.ts) || 0) / 1000);
      } catch (_) { }
      try {
        const st = JSON.parse(fs.readFileSync(path.join(packRoot, '.update', 'staged.json'), 'utf8'));
        hm.upd_stage = (st && typeof st.version === 'string') ? st.version.slice(0, 48) : '';
      } catch (_) { hm.upd_stage = ''; }
      return hm;
    }
    if (!fs.existsSync(path.join(liveDir, 'versions.json')) ||
        !fs.existsSync(path.join(packRoot, 'qqqide.exe'))) return null;
    const h: Record<string, unknown> = {};
    try {
      const v = JSON.parse(fs.readFileSync(path.join(liveDir, 'versions.json'), 'utf8'));
      h.upd_live_ver = (typeof v.id === 'string' && v.id) ? v.id.slice(0, 48) : '';
      h.upd_launcher = (typeof v.launcher === 'string') ? v.launcher.slice(0, 48) : '';
    } catch (_) { }
    try {
      const n = parseInt(fs.readFileSync(path.join(packRoot, '.apply-fails'), 'utf8').trim(), 10);
      h.upd_fails = (n > 0 && n <= 99) ? n : 0;
    } catch (_) { h.upd_fails = 0; }
    try {
      const s = JSON.parse(fs.readFileSync(path.join(base, 'updater-status.json'), 'utf8'));
      const r = s && s.result;
      h.upd_status = (r === 'ok' || r === 'waiting' || r === 'failed') ? r : '';
      h.upd_stage = '';
      h.upd_code = (typeof s.line === 'string' && s.line) ? s.line.slice(0, 200) : '';
      h.upd_at = Math.floor((Number(s.ts) || 0) / 1000);
    } catch (_) { }
    return h;
  } catch (_) { return null; }
}

// ── 引擎/组件在线快照（eng_r/eng_p/eng_ff/eng_yt，老项目语义）──────────────
// 就绪判定 = 二进制在位（与 qz-spawn / component-checker 同源路径，零硬编码）
function collectEng(): Record<string, number> {
    const out: Record<string, number> = { eng_r: 0, eng_p: 0, eng_ff: 0, eng_yt: 0 };
    try {
        const root = getAppRoot();
        // eng_r: ghrun（Rust 引擎）——与 qz-spawn resolveGhrunBin 同款三级探测
        const ext = process.platform === 'win32' ? '.exe' : '';
        const cands: string[] = [];
        const envBin = process.env.QQQIDE_QDIR_GHRUN;
        if (envBin) cands.push(envBin);
        const qdir = process.env.QQQIDE_QDIR;
        if (qdir) cands.push(path.join(qdir, 'ghrun' + ext));
        cands.push(path.join(root, 'engines', 'ghrun' + ext));
        cands.push(path.join(root, 'resources', 'app', 'engines', 'ghrun' + ext));
        // ★ mac .app 布局兜底（2026-09-19）: root=Contents/MacOS，engines 实挂 Resources/app/engines
        try {
            const ap = require('electron').app.getAppPath();
            cands.push(path.join(ap, 'engines', 'ghrun' + ext));
        } catch { /* ignore */ }
        for (const c of cands) { try { if (fs.existsSync(c)) { out.eng_r = 1; break; } } catch { /* skip */ } }
        // eng_p / eng_ff / eng_yt: 组件真理源 manifest（component-checker 唯一入口）
        try { out.eng_p = getComponentBin(root, 'python') ? 1 : 0; } catch { /* ignore */ }
        try { out.eng_ff = getComponentBin(root, 'ffmpeg') ? 1 : 0; } catch { /* ignore */ }
        try { out.eng_yt = getComponentBin(root, 'yt-dlp') ? 1 : 0; } catch { /* ignore */ }
    } catch { /* ignore */ }
    return out;
}

// ── 收集设备信息 ────────────────────────────────────────────────────────────
function collectPingBody(): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const totalSec = currentTotalSeconds();

    const body: Record<string, unknown> = {
        good_slg:         GOOD_SLG,
        device_id:         _deviceId,
        doer_id:           readDoerID(),
        total_seconds:     totalSec,
        event_time:        nowSec,
        client_ver:        APP_VERSION,
        factory_version:   _factoryVersion,
        distribution:      DISTRIBUTION,
        pkg_name:          'qqqide',
        pkg_display_name:  'qqqide',
        pkg_publisher:     'gh555.com',
        os_platform:       os.platform(),
        os_arch:           os.arch(),
        os_ver:            os.release().slice(0, 30),
        cpu_cores:         os.cpus().length,
        mem_mb:            Math.round(os.totalmem() / (1024 * 1024)),
    };

    // ★ 偿还标记：播放中（Savor 本地曲/电台）→ 服务端记录 last_playing_at / active_playing
    if (_isCurrentlyPlaying) { body.playing = true; }

    // ★ 引擎/组件在线快照（0/1）
    try { Object.assign(body, collectEng()); } catch { /* ignore */ }

    // ★ 履历快照（vig）——搭便车上报（老 qqq WqReporter._collectVig 100% 语义）
    //   card.count = 当前剪贴板卡片总数（kope 库已初始化时动态读回）
    try {
        const ks = kopeStatsSync();
        if (ks && ks.total > 0) { vigSet('card', { count: ks.total }); }
        const vig: Record<string, any> = vigSnapshot() || {};
        const wt = winthereExternal();   // window-there 外部计数（3W 保存 / 3X 还原 / 布局数）
        if (wt) { vig.winthere = wt; }
        if (Object.keys(vig).length > 0) { body.vig = vig; }
        pingLog('ping vig=' + (Object.keys(vig).join('+') || 'none') + ' cardN=' + (ks ? ks.total : 'na') + (wt ? ' wt=' + wt.save + '/' + wt.restore : ''));
    } catch { /* ignore */ }

    const uh = collectUpdHealth();
    if (uh) Object.assign(body, uh);

    return JSON.stringify(body);
}

// ── 发送 ping ───────────────────────────────────────────────────────────────
function sendPing(): Promise<{ ok: boolean; minNextPingAt?: number }> {
    return new Promise((resolve) => {
        pingLog('sendPing START host=' + PING_API_HOST);
        const bodyStr = collectPingBody();

        const req = https.request({
            hostname: PING_API_HOST,
            port: 443,
            path: PING_API_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
            },
            timeout: 10_000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({
                        ok: json.ok === true,
                        minNextPingAt: json.min_next_ping_at,
                    });
                } catch {
                    resolve({ ok: false });
                }
            });
        });

        req.on('error', (e: Error) => {
            pingLog('sendPing ERROR: ' + e.message);
            resolve({ ok: false, error: e.message } as any);
        });
        req.on('timeout', () => {
            pingLog('sendPing TIMEOUT');
            req.destroy(); resolve({ ok: false, error: 'timeout' } as any);
        });

        req.write(bodyStr);
        req.end();
    });
}

// ── 调度 ────────────────────────────────────────────────────────────────────
function scheduleNext(delaySec: number) {
    if (_stopped) return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(pingCycle, delaySec * 1000);
}

async function pingCycle() {
    if (_stopped) return;

    try {
        pingLog('sending doer=' + (readDoerID() || 'none') + ' dev=' + _deviceId.slice(0,8));
        const res = await sendPing();
        pingLog('result ok=' + res.ok + ' err=' + ((res as any).error || ''));
        if (res.ok) {
            _retryDelayMs = RETRY_MIN_MS;

            // ★ 成功后立即持久化当前累计值（原子推进）
            persistCumulativeSeconds(currentTotalSeconds());

            if (res.minNextPingAt && res.minNextPingAt > 0) {
                const nowSec = Math.floor(Date.now() / 1000);
                const delaySec = Math.max(60, res.minNextPingAt - nowSec);
                scheduleNext(delaySec);
            } else {
                scheduleNext(PING_FALLBACK_SEC);
            }
        } else {
            // ★ 网络错误/超时/JSON解析失败 → 指数退避重试，不用 12h 兜底
            _timer = setTimeout(pingCycle, _retryDelayMs);
            _retryDelayMs = Math.min(_retryDelayMs * 2, RETRY_MAX_MS);
        }
    } catch (_) {
        // 理论上 sendPing 不抛异常（全部 resolve），保留此路径以防未来变更
        if (!_stopped) {
            _timer = setTimeout(pingCycle, _retryDelayMs);
            _retryDelayMs = Math.min(_retryDelayMs * 2, RETRY_MAX_MS);
        }
    }
}

// ── 公开 API ────────────────────────────────────────────────────────────────

/** 启动统计上报机。调用一次，幂等。
 *  @param userDataPath  portable.userData（与 main.ts AUTH_FILE 同根） */
export function startWqPing(userDataPath?: string): void {
    pingLog('startWqPing CALLED userDataPath=' + (userDataPath || 'none') + ' _deviceId=' + (_deviceId || 'none'));
    if (_deviceId) { pingLog('already started, skip'); return; }
    if (userDataPath) _userDataPath = userDataPath;

    _deviceId = loadOrCreateDeviceId();
    _factoryVersion = loadOrCreateFactoryVersion();
    _cumulativeSeconds = loadCumulativeSeconds();
    _sessionStartedAt = Date.now();
    _stopped = false;

    pingLog('STARTED dev=' + _deviceId.slice(0,8) + ' ph=' + (readDoerID() || 'none'));
    const jitter = PING_JITTER_MIN_MS + Math.random() * (PING_JITTER_MAX_MS - PING_JITTER_MIN_MS);
    _timer = setTimeout(pingCycle, jitter);

    // ★ VIG 预热：立即初始化 kope 库（card.count 首 ping 即可带上——曾延迟 3s 致首 ping 抢跑）
    try { kopeWarmup(); } catch { /* ignore */ }
}

/** 升级失败即时补发（auto-updater 调用）: 30min 节流后立即 ping 一次。 */
export function notifyUpdateFailed(): void {
  pingLog('notifyUpdateFailed stop=' + _stopped);
  if (_stopped || !_deviceId) return;
  const nowMs = Date.now();
  if (nowMs - _lastFailNotifyAt < 30 * 60 * 1000) return; // 节流: 30min 一次
  _lastFailNotifyAt = nowMs;
  _retryDelayMs = RETRY_MIN_MS;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(pingCycle, 2_000); // 2s 后发，等状态文件落盘
}

/** ★ 设置当前是否在播放（Savor）：使后续常规 ping 携带 playing=true。 */
export function setCurrentlyPlaying(on: boolean): void {
    _isCurrentlyPlaying = !!on;
    pingLog('setCurrentlyPlaying=' + _isCurrentlyPlaying);
}

/** ★ 偿还 ping：播放/循环触发时立即补发一次（带 playing=true），5min 防抖。 */
export function triggerPlayingPing(): void {
    if (_stopped || !_deviceId) { return; }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - _lastPlayingPingTime < 300) {
        pingLog('playing ping debounced (5min)');
        return;
    }
    _lastPlayingPingTime = nowSec;
    pingLog('playing ping triggered');
    sendPing().then(res => {
        pingLog('playing ping result ok=' + res.ok + ' err=' + ((res as any).error || ''));
    }).catch(() => { /* ignore */ });
}

/** 登录成功后调用：重置退避 + 立即发 ping（带上 doer_id）。 */
export function notifyAuthReady(): void {
    pingLog('notifyAuth dev=' + (_deviceId ? _deviceId.slice(0,8) : 'none') + ' stop=' + _stopped);
    if (_stopped || !_deviceId) return;
    _retryDelayMs = RETRY_MIN_MS;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(pingCycle, 2_000); // 2s 后发，给 setAuthPhone 留时间
}

/** 停止统计上报机。退出前持久化累计秒数。 */
export function stopWqPing(): void {
    _stopped = true;
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
    }
    // ★ 退出前写入当前累计（防 crash 丢时间）
    if (_deviceId) {
        persistCumulativeSeconds(currentTotalSeconds());
    }
}
