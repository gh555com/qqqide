// ============================================================================
// wq-ping.ts — 统计上报机（轻量，主进程独立运行）
//
// 职责：
//   1. 生成/持久化 device_id (UUID v4) 到 Data/alphal/device_id
//   2. 累计使用时长（基于进程存活 wall-clock）
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
import { APP_VERSION } from './version';

// ── 常量 ────────────────────────────────────────────────────────────────────
const PING_API_HOST = 'cnk.gh555.com';
const PING_API_PATH = '/api/wq/ping';
const GOOD_SLG = 'qqqide';
const PING_JITTER_MIN_MS = 30_000;   // 首次 ping 最小延迟
const PING_JITTER_MAX_MS = 120_000;  // 首次 ping 最大延迟
const PING_FALLBACK_SEC = 43_200;    // 兜底间隔 12 小时
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;      // 最大 1 小时

// ── 状态 ────────────────────────────────────────────────────────────────────
let _deviceId = '';
let _startedAt = Date.now();
let _stopped = false;
let _retryDelayMs = RETRY_MIN_MS;
let _timer: ReturnType<typeof setTimeout> | null = null;

// ── 持久化路径 ──────────────────────────────────────────────────────────────
function alphalDir(): string {
    // 绿色包：Data/alphal/ 在应用根目录下
    // process.execPath 在 Electron 中指向 electron.exe / qqqide.exe
    const root = path.dirname(process.execPath);
    const dataDir = path.join(root, 'Data', 'alphal');
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { }
    return dataDir;
}

function deviceIdPath(): string {
    return path.join(alphalDir(), 'device_id');
}

// ── Device ID ───────────────────────────────────────────────────────────────
function loadOrCreateDeviceId(): string {
    const fp = deviceIdPath();
    try {
        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf8').trim();
            // UUID v4 格式校验: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
                return raw.toLowerCase();
            }
        }
    } catch (_) { }

    // 生成新 UUID v4
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = bytes.toString('hex');
    const uuid = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;

    try {
        fs.writeFileSync(fp, uuid, 'utf8');
    } catch (_) { }
    return uuid;
}

// ── 收集设备信息 ────────────────────────────────────────────────────────────
function collectPingBody(): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const totalSeconds = Math.floor((Date.now() - _startedAt) / 1000);

    const body: Record<string, unknown> = {
        good_slg:       GOOD_SLG,
        device_id:       _deviceId,
        total_seconds:   totalSeconds,
        event_time:      nowSec,
        ide_family:      'qqqide',
        client_ver:      APP_VERSION,
        pkg_name:        'qqq-ide',
        pkg_display_name: 'qqqide',
        pkg_publisher:   'gh555.com',
        os_platform:     os.platform(),       // win32 | darwin | linux
        os_arch:         os.arch(),           // x64 | arm64
        os_ver:          os.release().slice(0, 30),
        cpu_cores:       os.cpus().length,
        mem_mb:          Math.round(os.totalmem() / (1024 * 1024)),
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
            _retryDelayMs = RETRY_MIN_MS; // 成功后重置退避

            if (res.minNextPingAt && res.minNextPingAt > 0) {
                const nowSec = Math.floor(Date.now() / 1000);
                const delaySec = Math.max(60, res.minNextPingAt - nowSec);
                scheduleNext(delaySec);
            } else {
                scheduleNext(PING_FALLBACK_SEC);
            }
        } else {
            // 服务端拒绝 → 兜底 12 小时
            scheduleNext(PING_FALLBACK_SEC);
        }
    } catch (_) {
        // 网络错误 → 指数退避
        if (!_stopped) {
            _timer = setTimeout(pingCycle, _retryDelayMs);
            _retryDelayMs = Math.min(_retryDelayMs * 2, RETRY_MAX_MS);
        }
    }
}

// ── 公开 API ────────────────────────────────────────────────────────────────

/** 启动统计上报机。调用一次，幂等。 */
export function startWqPing(): void {
    if (_deviceId) return; // 已启动

    _deviceId = loadOrCreateDeviceId();
    _startedAt = Date.now();
    _stopped = false;

    // 首次 ping 随机抖动（避免所有客户端同时 ping）
    const jitter = PING_JITTER_MIN_MS + Math.random() * (PING_JITTER_MAX_MS - PING_JITTER_MIN_MS);
    _timer = setTimeout(pingCycle, jitter);
}

/** 停止统计上报机。 */
export function stopWqPing(): void {
    _stopped = true;
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
    }
}
