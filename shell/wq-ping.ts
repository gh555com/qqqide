// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// wq-ping.ts — 统计上报机（轻量，主进程独立运行）
//
// 职责：
//   1. 生成/持久化 device_id (UUID v4) + factory_version 到 Data/alphal/
//   2. 累计使用时长：跨重启持久化到 Data/alphal/cumulative_seconds
//      → 每次 ping 上报绝对值 → 服务端 max(old, new) 接受
//   3. 定期 POST /api/wq/ping（首次 5~15s 随机抖动，后续按服务端建议）
//   4. 失败退避阶梯（60 → 130 → 300 → 600s，向上抖动，封顶随在线窗口自适应）
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
import { app, powerMonitor, safeStorage } from 'electron';
import { APP_VERSION } from './version';
import { getDataDir, getAppRoot } from './portable-paths';
import { getAuthPhone } from './auth-state';
import { mainWindowShownResolved } from './ipc-secure';   // ★ 钥匙串调用窗口门（linux/mac）
import { getComponentBin } from './component-checker';
import { vigSnapshot, vigSet, winthereExternal } from './vig';
import { playerHostVigExternal, mergePlayerVig } from './player-vig';
import { crashNetSummary } from './crash-net';
import * as remoteCmd from './remote-cmd'; // ★ 2026-09-28 设备级指令通道（执行/回执/诊断）
import * as syspyReport from './syspy-report'; // ★ 2026-10-02 系统解释器失败遥测（pending 搭车 upd_diag）
import { kopeStatsSync, kopeWarmup } from './ipc-kope';
import { getMainLang } from './main-i18n';
import type { StateStore } from './state-sqlite';

// ── 常量 ────────────────────────────────────────────────────────────────────
// ★ 上报节奏三铁律（往这里加东西前先读）：
//   ① 失败退避上限必须远小于服务端在线窗口（窗口 = 4×上报间隔 = 60min）——
//      旧值 1h 恰等于窗口，一次断网被放大成「离线两小时」；
//   ② 响应缺字段的兜底必须是「再报一次」量级，不许 12h（= 12 倍窗口的静默黑洞）；
//   ③ 服务端建议延迟必须有硬上限，且永不越过在线窗口的一半（防时钟/配置漂移自杀）。
const PING_API_HOSTS = ['direct-cn.gh555.com', 'gh555.com']; // 首选 + 备用（同路由；单线路 DNS/网络故障自动切换）
const PING_API_PATH = '/api/wq/ping';
const GOOD_SLG = 'qqqide';
const DISTRIBUTION = 'gh555.com';    // 发行渠道（当前唯一，将来可扩展）
const PING_JITTER_MIN_MS = 5_000;    // 首次 ping 最小延迟
const PING_JITTER_MAX_MS = 15_000;   // 首次 ping 最大延迟
const PING_FALLBACK_SEC = 600;       // 响应缺 min_next_ping_at → 10 分钟后重报（旧 12h）
const PING_DELAY_MIN_SEC = 60;       // 服务端建议延迟下限
const PING_DELAY_MAX_SEC = 1_800;    // 服务端建议延迟硬上限（时钟漂移防线；窗口已知时按 max(本值, 窗口/2) 放行大间隔配置）
const RETRY_MIN_MS = 60_000;         // 首档退避（也是「节奏健康」的复位值）
// ★ 失败退避阶梯（末档 = 封顶）：短抖动快速归位，长断网低噪音。
//   前两档管「Wi-Fi 漫游/换网/VPN 抖动」这类秒级~分钟级断线（≤3.5min 内的行为与旧版逐秒一致）；
//   后两档管「断电/断网数小时」这类长故障——同样 24h 断网从 ~590 次重试降到 ~130 次。
const RETRY_LADDER_MS = [RETRY_MIN_MS, 130_000, 300_000, 600_000];
const RETRY_JITTER_RATIO = 0.25;     // ★ 退避只向上抖动 0~25%：防同一时刻掉线的客户端锁步成惊群
                                     //   （服务端 5xx/半死时，无抖动的重试会整点齐射；只加不减）
const PRESENCE_WINDOW_FALLBACK_S = 3_600; // 服务端未下发 online_window_s 前假设的在线窗口
const SUCCESS_JITTER_RATIO = 0.04;   // 成功路径正抖动 0~4%（900s 档 ≈ ≤36s）：批次同期启动的客户端永久错开
const STALE_KICK_MS = 5 * 60_000;    // 唤醒/聚焦补报的最小间隔（防抖动刷屏）
const WATCHDOG_MS = 60_000;          // 定时器自愈巡检周期
const WATCHDOG_SLACK_MS = 120_000;   // 计划点超期容忍（GC/休眠/事件循环卡顿）

// ── 状态 ────────────────────────────────────────────────────────────────────
let _deviceId = '';
let _factoryVersion = '';
let _cumulativeSeconds = 0;          // 上次持久化的累计秒数
let _sessionStartedAt = Date.now();  // 本次进程启动时间
let _stopped = false;
let _retryStep = 0;                   // 0 = 健康节奏；n = 连续失败 n 次（决定退避阶梯档位）
let _onlineWindowS = 0;               // 服务端下发在线窗口（0 = 未知；退避封顶据此自适应）
let _lastFailNotifyAt = 0;      // ★ 升级失败即时补发节流（30min）
let _lastSyspyNotifyAt = 0;     // ★ 系统解释器失败即时补发节流（10min）
let _updHealthCache: Record<string, unknown> | null | undefined; // undefined=未探测
// ★ 偿还（playing）状态（Savor 移植 2026-09-19）：播放中 → ping 携带 playing=true
let _isCurrentlyPlaying = false;
let _lastPlayingPingTime = 0;   // playing ping 5min 防抖（与服务器限速同口径）
let _lastSentAckIds: string[] = [];  // ★ 本次 ping 已发出的指令回执 id（服务端确认后清）
let _diagIncluded = false;           // ★ 本次 ping 是否携带扩展诊断
let _diagBase = '';                  // ★ 本次携带诊断的 Data 根（syspy pending 清理用）
let _diagSpy = false;                // ★ 本次诊断由系统解释器失败触发（服务端确认后清 pending）
let _timer: ReturnType<typeof setTimeout> | null = null;
let _watchdog: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;               // 单飞：任一路径在飞时不重复发
let _nextDueAt = 0;                  // 下一次计划上报时刻（0 = 无计划）
let _lastOkAt = 0;                   // 上次成功上报时刻（唤醒/聚焦补报判据）
let _userDataPath = '';              // ★ portable.userData，启动时注入
let _stateStore: StateStore | null = null; // ★ 全局状态库（main.ts 注入；读 UI 主题镜像）

// ── 磁盘日志（调试用，零依赖，原子 append）──────────────────────────────────
let _logPath = '';
function pingLog(msg: string): void {
    if (!_logPath) {
        const base = _userDataPath || getDataDir();
        _logPath = path.join(base, 'alphal', 'wq-ping.log');
        try { fs.mkdirSync(path.dirname(_logPath), { recursive: true }); } catch (_) { }
    }
    const line = new Date().toISOString() + ' ' + msg + '\n';
    try {
        // ★ 轮转（2026-09-24）: 单文件 ≤512KB，超限滚为 .old（单代）
        try {
            if (fs.statSync(_logPath).size > 512 * 1024) {
                try { fs.unlinkSync(_logPath + '.old'); } catch (_) { }
                try { fs.renameSync(_logPath, _logPath + '.old'); } catch (_) { }
            }
        } catch (_) { /* 文件不存在 */ }
        fs.appendFileSync(_logPath, line);
    } catch (_) { }
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

    // ★ 第二优先：safeStorage 直接解密（兜底；★ 2026-10-05: 窗口未亮相前禁碰钥匙串——
    //   linux keyring / mac 钥匙串的同步调用可能冻结主进程，此时跳过走 phone.txt 兜底）
    try {
        if (mainWindowShownResolved() && safeStorage.isEncryptionAvailable()) {
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
// ★ 2026-09-28 v2 卡点四件套: .launcher-ver（根启动器实版）/ .swap-ready（暂存悬挂目标
//   +时长）/ .pending-reboot（重启交换挂起）/ Data/launcher-swap.log 尾行——
//   0.3.206 类「交换卡死静默」事故必须远程可见。
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
    // ★ v2 卡点四件套（任一缺失/损坏→字段省略，绝不影响主 ping）
    try {
      const lv = fs.readFileSync(path.join(packRoot, '.launcher-ver'), 'utf8').trim();
      if (lv) h.upd_launcher_actual = lv.slice(0, 48);
    } catch (_) { }
    try {
      const sr = path.join(packRoot, '.swap-ready');
      const stt = fs.statSync(sr);
      const sv = fs.readFileSync(sr, 'utf8').trim();
      if (sv) h.upd_staged = sv.slice(0, 48);
      const age = Math.floor((Date.now() - stt.mtimeMs) / 1000);
      if (age >= 0 && age < 30 * 86400) h.upd_staged_age_s = age;
    } catch (_) { }
    try {
      h.upd_pend = fs.existsSync(path.join(packRoot, '.pending-reboot')) ? 1 : 0;
    } catch (_) { }
    try {
      const lg = fs.readFileSync(path.join(liveDir, 'Data', 'launcher-swap.log'), 'utf8');
      const arr = lg.trim().split(/\r?\n/);
      const last = arr.length ? arr[arr.length - 1] : '';
      if (last) h.upd_tail = last.slice(-200);
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

// ── UI 主题（global 库 qqq.theme/mode 镜像，qqqide-theme.js 每次 apply 刷新）──
//   读取可能早于渲染层注册 ns（首启头几秒）→ 失败返回 ''，字段省略零伤害
async function readUiTheme(): Promise<string> {
    try {
        if (!_stateStore) return '';
        const v = await Promise.race([
            _stateStore.get('qqq.theme', 'mode'),
            new Promise((res) => setTimeout(() => res(null), 1500)),
        ]);
        if (v === 'dark' || v === true) return 'dark';
        if (v === 'light' || v === false) return 'light';
    } catch { /* ignore */ }
    return '';
}

// ── 机型静态环境（进程内恒定，只取一次）─────────────────────────────────────
//   ★ os.cpus() 在 64 核机上实测 0.95ms/次、Intl 时区 0.17ms/次——都是每轮都算的死重，
//     缓存后单轮 body 构建便宜 ~1.1ms（掉线重试频繁时也不会累积成主线程抖动）。
let _staticEnv: { platform: string; arch: string; osVer: string; cores: number; memMB: number; tzName: string } | null = null;
function staticEnv() {
    if (_staticEnv) return _staticEnv;
    const cores = os.cpus().length;
    const memMB = Math.round(os.totalmem() / (1024 * 1024));
    let tzName = '';
    try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
    _staticEnv = {
        platform: os.platform(),
        arch: os.arch(),
        osVer: os.release().slice(0, 30),
        cores: cores,
        memMB: memMB,
        tzName: tzName.slice(0, 50),
    };
    return _staticEnv;
}

// ── 收集设备信息 ────────────────────────────────────────────────────────────
async function collectPingBody(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const totalSec = currentTotalSeconds();
    const _env = staticEnv();

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
        os_platform:       _env.platform,
        os_arch:           _env.arch,
        os_ver:            _env.osVer,
        cpu_cores:         _env.cores,
        mem_mb:            _env.memMB,
    };

    // ★ 设备环境上报（2026-09-22 补报）：界面语言 / 时区 / 主题
    //   （服务端 v16.1.8+ 早已接收落列；qd 行为追踪表「界面语言/时区/主题」三列由此补活）
    try { body.locale = getMainLang(); } catch { /* ignore */ }
    try {
        body.tz_offset = -new Date().getTimezoneOffset();   // 分钟、东八区=480（JS 符号相反取负）
        if (_env.tzName) body.tz_name = _env.tzName;        // IANA 名（服务端上限 50；静态缓存）
    } catch { /* ignore */ }
    const uiTheme = await readUiTheme();
    if (uiTheme) body.ui_theme = uiTheme;

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
        // ★ 播放器履历（2026-10-29）：IDE 侧（vig.json player）+ 宿主侧（player-vig.host.json）求和合并
        //   两域分文件存（唯一写者），此处才是唯一汇合点 → body.vig.player → device_vig.player_*
        const pvHost = playerHostVigExternal();
        const pvMerged = mergePlayerVig(vig.player, pvHost);
        if (pvMerged) { vig.player = pvMerged; }
        const cs = crashNetSummary();    // 稳定性遥测（崩溃摘要：只传计数，永不传内容/堆栈）
        if (cs) { vig.crash = cs; }
        if (Object.keys(vig).length > 0) { body.vig = vig; }
        pingLog('ping vig=' + (Object.keys(vig).join('+') || 'none') + ' cardN=' + (ks ? ks.total : 'na') + (wt ? ' wt=' + wt.save + '/' + wt.restore : '') + (pvMerged ? ' pv=' + (pvMerged.n || 0) + '/' + (pvMerged.sec || 0) + 's' : ''));
    } catch { /* ignore */ }

    const uh = collectUpdHealth();
    if (uh) Object.assign(body, uh);

    // ★ 设备级指令通道（2026-09-28）: 回执队列（≤10/次）+ 扩展诊断（diag 指令触发）
    //   服务端确认（响应 cmd_acks_ok=true）后才清理本地队列——中途失败重发不丢。
    _lastSentAckIds = [];
    _diagIncluded = false;
    try {
        const acks = remoteCmd.collectAckPayload();
        if (acks && acks.length > 0) {
            body.cmd_acks = acks;
            _lastSentAckIds = acks.map(a => a.id);
        }
    } catch { /* ignore */ }
    try {
        // ★ 系统解释器失败遥测（2026-10-02）: 失败 pending 或运维 diag 指令 → 携带扩展诊断
        const _dgBase = _userDataPath || getDataDir();
        const spyWanted = syspyReport.syspyPendingWanted(_dgBase);
        if (remoteCmd.isDiagWanted() || spyWanted) {
            _diagBase = _dgBase;
            _diagSpy = spyWanted;
            const dg = buildDiag();
            if (dg) { body.upd_diag = dg; _diagIncluded = true; }
        }
    } catch { /* ignore */ }

    return JSON.stringify(body);
}

// ── 扩展诊断（diag 指令触发，≤480 字符；一切字段尽力而为，缺失省略）─────────
function buildDiag(): string {
    try {
        const base = _userDataPath || getDataDir();
        const liveDir = path.dirname(base);
        const packRoot = path.dirname(liveDir);
        const parts: string[] = [];
        try {
            const spy = syspyReport.buildSpyTokens(base);
            if (spy) parts.push(spy);        // ★ 置首位（480 截断永不吞系统解释器现场）
        } catch { /* ignore */ }
        const rf = (p: string): string => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
        const sz = (p: string): number => { try { return fs.statSync(p).size; } catch { return -1; } };
        const sha8 = (p: string): string => {
            try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 8); } catch { return ''; }
        };
        parts.push('fails=' + (rf(path.join(packRoot, '.apply-fails')) || '0'));
        const staged = rf(path.join(packRoot, '.swap-ready'));
        if (staged) {
            parts.push('staged=' + staged.slice(0, 24));
            try { parts.push('sage=' + Math.floor((Date.now() - fs.statSync(path.join(packRoot, '.swap-ready')).mtimeMs) / 1000) + 's'); } catch { /* ignore */ }
        }
        parts.push('pend=' + (fs.existsSync(path.join(packRoot, '.pending-reboot')) ? '1' : '0'));
        parts.push('la=' + (rf(path.join(packRoot, '.launcher-ver')) || '?'));
        const rootExe = path.join(packRoot, 'qqqide.exe');
        if (fs.existsSync(rootExe)) parts.push('root=' + sha8(rootExe));
        const nextExe = path.join(packRoot, 'gh555.com-next', 'launcher-next.exe');
        if (fs.existsSync(nextExe)) parts.push('lnx=' + sha8(nextExe));
        const rp = sz(path.join(packRoot, 'r.next'));
        if (rp >= 0) parts.push('rnext=' + Math.round(rp / 1048576) + 'M');
        const rv = rf(path.join(packRoot, '.version-next'));
        if (rv) parts.push('rv=' + rv);
        try {
            const u = JSON.parse(fs.readFileSync(path.join(base, 'units.json'), 'utf8'));
            parts.push('units=' + ((u && typeof u.id === 'string' && u.id) ? u.id : 'none'));
        } catch { parts.push('units=absent'); }
        return parts.join(' ').slice(0, 480);
    } catch { return ''; }
}

// ── 发送 ping ───────────────────────────────────────────────────────────────
type PingResult = {
    ok: boolean;
    minNextPingAt?: number;
    onlineWindowS?: number;
    serverTotalSeconds?: number;
    forceReset?: boolean;
    tagged?: string;          // 服务端策略标签（low_spec = 在线照常计，累计/陪伴冻结）
    skipped?: string;
    commands?: unknown;
    cmdsOk?: boolean;
    error?: string;
    retryable?: boolean;   // 网络层失败（可换线路再试）
};

function sendPingTo(host: string, bodyStr: string): Promise<PingResult> {
    return new Promise((resolve) => {
        const req = https.request({
            hostname: host,
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
                const code = res.statusCode || 0;
                try {
                    const json = JSON.parse(data);
                    resolve({
                        ok: json.ok === true,
                        minNextPingAt: json.min_next_ping_at,
                        onlineWindowS: json.online_window_s,
                        serverTotalSeconds: json.server_total_seconds,
                        forceReset: json.force_reset === true,
                        tagged: typeof json.tagged === 'string' ? json.tagged : '',
                        skipped: typeof json.skipped === 'string' ? json.skipped : '',
                        commands: Array.isArray(json.commands) ? json.commands : undefined,
                        cmdsOk: json.cmd_acks_ok === true,
                        retryable: code >= 500,
                    });
                } catch {
                    // 非 JSON（网关错误页/代理拦截）：5xx 或空体 → 允许换线路
                    resolve({ ok: false, retryable: code === 0 || code >= 500, error: 'bad_json(' + code + ')' });
                }
            });
        });

        req.on('error', (e: Error) => {
            pingLog('sendPing ERROR host=' + host + ': ' + e.message);
            resolve({ ok: false, error: e.message, retryable: true }); // DNS/连接/超时 = 网络层失败
        });
        req.on('timeout', () => {
            pingLog('sendPing TIMEOUT host=' + host);
            req.destroy(); resolve({ ok: false, error: 'timeout', retryable: true } as any);
        });

        req.write(bodyStr);
        req.end();
    });
}

async function sendPing(): Promise<PingResult> {
    const bodyStr = await collectPingBody();
    let last: PingResult = { ok: false, error: 'no_host' };
    for (let i = 0; i < PING_API_HOSTS.length; i++) {
        const host = PING_API_HOSTS[i];
        pingLog('sendPing START host=' + host);
        const r = await sendPingTo(host, bodyStr);
        if (r.ok || !r.retryable) return r;      // 成功 / 业务性失败（4xx）= 不换线路
        last = r;
        if (i + 1 < PING_API_HOSTS.length) pingLog('sendPing switch → ' + PING_API_HOSTS[i + 1]);
    }
    return last;
}

// ── 调度 ────────────────────────────────────────────────────────────────────
/**
 * 当前档退避基准（未抖动）。
 * ★ 双重闸门：① 阶梯末档 600s 为绝对封顶；② 绝不越过「在线窗口 / 4」——窗口是服务端唯一
 *   真理（4×上报间隔），这里只做除法消费。窗口配置一改，退避自动跟随，两端永不分叉，
 *   也永不会出现「退避比窗口还长 = 自己把在线等成离线」的自伤。
 */
function _retryBaseMs(): number {
    const top = RETRY_LADDER_MS[RETRY_LADDER_MS.length - 1];
    let base = RETRY_LADDER_MS[Math.min(_retryStep, RETRY_LADDER_MS.length - 1)];
    const win = _onlineWindowS >= 600 ? _onlineWindowS : PRESENCE_WINDOW_FALLBACK_S;
    const ceil = Math.floor((win * 1000) / 4 / (1 + RETRY_JITTER_RATIO));  // 留出抖动余量，抖动后仍 ≤ 窗口/4
    if (base > ceil) base = ceil;
    if (base < RETRY_MIN_MS) base = RETRY_MIN_MS;
    return Math.min(base, top);
}

/** 失败退避间隔（带向上抖动）：同一时刻掉线的客户端不锁步，服务端压力被摊平。 */
function _retryInterval(): number {
    return Math.round(_retryBaseMs() * (1 + Math.random() * RETRY_JITTER_RATIO));
}

/** 连续失败记账：下一轮进下一档（到顶后钉在末档）。 */
function _advanceRetry(): void {
    if (_retryStep < RETRY_LADDER_MS.length) _retryStep++;
}

/** 唯一排程入口：一切路径（常规/快速/补报/重试）都从这里落定时器 + 记账。 */
function _arm(delayMs: number): void {
    if (_stopped) return;
    if (_timer) clearTimeout(_timer);
    const ms = Math.max(1_000, Math.round(delayMs));
    _nextDueAt = Date.now() + ms;
    _timer = setTimeout(pingCycle, ms);
}

function scheduleNext(delaySec: number) {
    _arm(Math.max(PING_DELAY_MIN_SEC, delaySec) * 1000);
}

// ★ 指令执行后加速回执（90s 后补一次 ping；与常规调度共用定时器）
function scheduleQuickPing(delaySec: number): void {
    if (_stopped) return;
    _retryStep = 0;
    _arm(Math.max(30, delaySec) * 1000);
}

/**
 * 补报（系统唤醒/解锁/窗口聚焦/巡检）：只在「确实欠报」时补，且不打断临近的计划点。
 * ★ 旧实现零恢复通道——断网 85 分钟后网络早恢复了，退避却仍睡到第 64 分钟才醒。
 * ★ 健康节奏下零额外请求：非强制补报只用于「退避中」的恢复（聚焦/唤醒不打乱 15min 节拍）；
 *   定时器丢失等异常由巡检强制补报（force）。
 */
function kickStale(reason: string, minGapMs: number, force: boolean = false): void {
    if (_stopped || !_deviceId || _inFlight) return;
    const now = Date.now();
    const sinceOk = _lastOkAt > 0 ? now - _lastOkAt : Number.MAX_SAFE_INTEGER;
    if (sinceOk < minGapMs) return;
    // 已有一个更早的计划点（≤30s 后）→ 让原计划走，不重复上报
    if (_nextDueAt > now && _nextDueAt - now < 30_000) return;
    if (!force && _retryStep === 0) return;   // 节奏健康 → 不补报
    pingLog('kick(' + reason + (force ? '/force' : '') + ') sinceOk=' + (sinceOk === Number.MAX_SAFE_INTEGER ? 'never' : Math.round(sinceOk / 1000) + 's')
        + ' retry=' + Math.round(_retryBaseMs() / 1000) + 's#' + _retryStep);
    _retryStep = 0;
    _arm(1_500);
}

/** 定时器自愈巡检：定时器丢了（休眠/系统改时钟/事件循环卡死）也能把上报接回来。 */
function _startWatchdog(): void {
    if (_watchdog) return;
    _watchdog = setInterval(function () {
        if (_stopped || _inFlight) return;
        if (!_nextDueAt) {
            // 无计划点 = 定时器丢了（只在曾成功过之后才判异常，避开启动前 15s 抖动窗）
            if (_lastOkAt > 0 && Date.now() - _lastOkAt > STALE_KICK_MS) kickStale('watchdog-idle', 0, true);
            return;
        }
        if (Date.now() > _nextDueAt + WATCHDOG_SLACK_MS) kickStale('watchdog-overdue', 0, true);
    }, WATCHDOG_MS);
    try { (_watchdog as any).unref && (_watchdog as any).unref(); } catch (_) { }
}

/**
 * 服务端裁决对齐：force_reset = 我们报的累计比服务端记的少（多设备/重装/换目录）
 * → 采纳服务端总额。多设备从此收敛到同一把尺，不再「低值设备永远零增量」。
 */
function applyServerTotal(res: PingResult): void {
    const st = Number(res.serverTotalSeconds);
    if (!res.forceReset || !isFinite(st) || st <= 0 || st > 315_360_000) return; // 0~10 年，越界不信
    if (st <= currentTotalSeconds()) return;
    _cumulativeSeconds = st;
    _sessionStartedAt = Date.now();
    persistCumulativeSeconds(st);
    pingLog('forceReset adopt server total=' + st);
}

// ★ ping 结果处理（设备级指令通道）: 回执清理 + 指令执行 + 加速回执
function afterPingResult(res: { ok: boolean; commands?: unknown; cmdsOk?: boolean }): void {
    if (!res.ok) return;
    try {
        if (res.cmdsOk) {
            if (_lastSentAckIds.length > 0) remoteCmd.markAcksSent(_lastSentAckIds);
            if (_diagIncluded) {
                remoteCmd.clearDiagWantSent();
                if (_diagSpy && _diagBase) { try { syspyReport.clearSyspyPending(_diagBase); } catch { /* ignore */ } }
            }
        }
    } catch { /* ignore */ }
    _lastSentAckIds = [];
    _diagIncluded = false;
    _diagSpy = false;
    try {
        if (Array.isArray(res.commands) && res.commands.length > 0) {
            void remoteCmd.handleIncomingCommands(res.commands).then((processed: boolean) => {
                if (processed) scheduleQuickPing(90);
            }).catch(() => { /* ignore */ });
        }
    } catch { /* ignore */ }
}

async function pingCycle() {
    if (_stopped || _inFlight) return;
    _inFlight = true;
    _nextDueAt = 0;
    try {
        pingLog('sending doer=' + (readDoerID() || 'none') + ' dev=' + _deviceId.slice(0,8));
        const res = await sendPing();
        pingLog('result ok=' + res.ok + ' err=' + (res.error || '')
            + (res.tagged ? ' tagged=' + res.tagged : '')
            + (res.skipped ? ' skipped=' + res.skipped : ''));
        if (res.ok) {
            _retryStep = 0;
            _lastOkAt = Date.now();

            // ★ 在线窗口 = 服务端权益（退避封顶据此自适应；旧实现硬编码在 6 处，配置一改就分叉）
            const winS = Number(res.onlineWindowS);
            if (isFinite(winS) && winS >= 600 && winS <= 86_400) _onlineWindowS = winS;

            // ★ 服务端裁决 = 唯一真理（force_reset 时把本地累计对齐服务端）
            applyServerTotal(res);

            // ★ 成功后立即持久化当前累计值（原子推进）
            persistCumulativeSeconds(currentTotalSeconds());

            if (res.minNextPingAt && res.minNextPingAt > 0) {
                const nowSec = Math.floor(Date.now() / 1000);
                let delaySec = res.minNextPingAt - nowSec;
                // ★ 上报节奏永不越过在线窗口的一半（窗口由服务端下发，两端永不分叉）：
                //   上限 = max(硬上限, 窗口/2)——正常配置（900s）零改动，服务端故意配大间隔也放行，
                 //   但时钟漂移/异常建议最多只能把我们推到窗口边缘之前。
                const win = Number(res.onlineWindowS);
                const cap = (isFinite(win) && win >= PING_DELAY_MIN_SEC * 2)
                    ? Math.max(PING_DELAY_MAX_SEC, Math.floor(win / 2))
                    : PING_DELAY_MAX_SEC;
                if (delaySec < PING_DELAY_MIN_SEC) delaySec = PING_DELAY_MIN_SEC;
                if (delaySec > cap) delaySec = cap;
                // ★ 成功路径正抖动（0~4%）：只加不减——绝不早于服务端 min_next_ping_at，也绝不吃掉窗口余量。
                //   旧实现零抖动，同期部署的一批客户端会永远整点齐射（窗口内 4 次全撞在同一秒）。
                _arm(Math.min(Math.round(delaySec * 1000 * (1 + Math.random() * SUCCESS_JITTER_RATIO)), cap * 1000));
            } else {
                scheduleNext(PING_FALLBACK_SEC);
            }

            // ★ 设备级指令通道: 回执清理 + 指令执行（执行完自动加速回执）
            afterPingResult(res);
        } else {
            // ★ 网络错误/超时/JSON解析失败 → 阶梯退避（+0~25% 抖动，封顶受在线窗口 /4 约束）
            _arm(_retryInterval());
            _advanceRetry();
        }
    } catch (_) {
        // 理论上 sendPing 不抛异常（全部 resolve），保留此路径以防未来变更
        if (!_stopped) {
            _arm(_retryInterval());
            _advanceRetry();
        }
    } finally {
        _inFlight = false;
    }
}

// ── 公开 API ────────────────────────────────────────────────────────────────

/** ★ 注入全局状态库引用（main.ts 启动时调用；读 qqq.theme/mode 主题镜像用）。 */
export function setWqPingStateStore(s: StateStore | null): void { _stateStore = s; }

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

    // ★ 设备级指令通道初始化（执行机状态目录 = 同 _userDataPath 根）
    try { remoteCmd.remoteCmdConfigure(_userDataPath || getDataDir()); } catch { /* ignore */ }

    pingLog('STARTED dev=' + _deviceId.slice(0,8) + ' ph=' + (readDoerID() || 'none'));

    // ★ 恢复通道（旧实现零恢复：系统唤醒/网络回来/窗口回前台都不会把退避清零）
    try { powerMonitor.on('resume', function () { kickStale('power-resume', STALE_KICK_MS); }); } catch (_) { }
    try { powerMonitor.on('unlock-screen', function () { kickStale('unlock-screen', STALE_KICK_MS); }); } catch (_) { }
    try { app.on('browser-window-focus', function () { kickStale('window-focus', STALE_KICK_MS); }); } catch (_) { }
    _startWatchdog();

    const jitter = PING_JITTER_MIN_MS + Math.random() * (PING_JITTER_MAX_MS - PING_JITTER_MIN_MS);
    _arm(jitter);

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
  _retryStep = 0;
  _arm(2_000); // 2s 后发，等状态文件落盘
}

/** 系统解释器失败即时补发（ipc-syspy 失败时调用）: 10min 节流后立即 ping 一次（诊断搭车上报）。 */
export function notifySyspyFailed(): void {
    if (_stopped || !_deviceId) return;
    const nowMs = Date.now();
    if (nowMs - _lastSyspyNotifyAt < 10 * 60 * 1000) return;
    _lastSyspyNotifyAt = nowMs;
    pingLog('notifySyspyFailed -> quick ping');
    _retryStep = 0;
    _arm(3_000);
}

/** ★ 设置当前是否在播放（Savor）：使后续常规 ping 携带 playing=true。 */
export function setCurrentlyPlaying(on: boolean): void {
    _isCurrentlyPlaying = !!on;
    pingLog('setCurrentlyPlaying=' + _isCurrentlyPlaying);
}

/** ★ 偿还 ping：播放/循环触发时立即补发一次（带 playing=true），5min 防抖。 */
export function triggerPlayingPing(): void {
    if (_stopped || !_deviceId || _inFlight) { return; }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - _lastPlayingPingTime < 300) {
        pingLog('playing ping debounced (5min)');
        return;
    }
    _lastPlayingPingTime = nowSec;
    pingLog('playing ping triggered');
    sendPing().then(res => {
        pingLog('playing ping result ok=' + res.ok + ' err=' + (res.error || ''));
        if (res.ok) _lastOkAt = Date.now();   // 这次也算成功——巡检不重复补报
        afterPingResult(res);
    }).catch(() => { /* ignore */ });
}

/** 登录成功后调用：重置退避 + 立即发 ping（带上 doer_id）。 */
export function notifyAuthReady(): void {
    pingLog('notifyAuth dev=' + (_deviceId ? _deviceId.slice(0,8) : 'none') + ' stop=' + _stopped);
    if (_stopped || !_deviceId) return;
    _retryStep = 0;
    _arm(2_000); // 2s 后发，给 setAuthPhone 留时间
}

/** 停止统计上报机。退出前持久化累计秒数。 */
export function stopWqPing(): void {
    _stopped = true;
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
    }
    _nextDueAt = 0;
    _inFlight = false;
    if (_watchdog) {
        clearInterval(_watchdog);
        _watchdog = null;
    }
    // ★ 退出前写入当前累计（防 crash 丢时间）
    if (_deviceId) {
        persistCumulativeSeconds(currentTotalSeconds());
    }
}
