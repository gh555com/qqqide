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
import { getAuthPhone } from './auth-state';

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
let _timer: ReturnType<typeof setTimeout> | null = null;
let _userDataPath = '';              // ★ portable.userData，启动时注入

// ── 持久化路径 ──────────────────────────────────────────────────────────────
function alphalDir(): string {
    // ★ 优先用注入的 userData 路径（与 main.ts 一致），
    //    兜底用 execPath 旁 Data/alphal（绿色包兼容）
    const base = _userDataPath || path.join(path.dirname(process.execPath), 'Data');
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

    return JSON.stringify(body);
}

// ── 发送 ping ───────────────────────────────────────────────────────────────
function sendPing(): Promise<{ ok: boolean; minNextPingAt?: number }> {
    return new Promise((resolve) => {
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

        req.on('error', () => resolve({ ok: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });

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
        const res = await sendPing();
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
            scheduleNext(PING_FALLBACK_SEC);
        }
    } catch (_) {
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
    if (_deviceId) return;
    if (userDataPath) _userDataPath = userDataPath;

    _deviceId = loadOrCreateDeviceId();
    _factoryVersion = loadOrCreateFactoryVersion();
    _cumulativeSeconds = loadCumulativeSeconds();
    _sessionStartedAt = Date.now();
    _stopped = false;

    const jitter = PING_JITTER_MIN_MS + Math.random() * (PING_JITTER_MAX_MS - PING_JITTER_MIN_MS);
    _timer = setTimeout(pingCycle, jitter);
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
