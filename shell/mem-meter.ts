// mem-meter.ts — 启动包集合内存真理机器（2026-08-29 v4：进程树真值 + 零估算）
// ★ v4 定案（2026-08-29 用户要求「集合总内存，画圈明确 = IDE + 全部自维护工具」）：
//   画圈 = 启动包进程树（主进程 + 全部后代递归）：Electron 六件套 + py-broker +
//   miniaudio_bridge + ghrun + goods python 全家（kope-a/window-there/ruler/q3 等）。
//   数据源 = py-broker NtQuerySystemInformation 快照（Windows 内核原生 API，
//   ctypes 直调 ~7.5ms/次，实测 288 进程全系统）→ 树内 Σ 专用工作集
//   （SYSTEM_PROCESS_INFORMATION offset 8，任务管理器「内存」列同口径，
//   2026-08-29 实测 8/8 逐字节命中 WMI WorkingSetPrivate）。
//   ★ 相比 v3（WMI 30s 校准 + getAppMetrics 5s 增量 + 漂移钳制）：
//     ① 每 5s 全量真值，零估算零校准间隙零漂移（v3 间隙瞬时偏差 ≤25% 全消失）
//     ② 性能 -12 倍：WMI 400-700ms×2/min → NtQuery 7.5ms×12/min ≈ 0.03% 单核
//     ③ 口径升级：v3 只算 Electron 进程（dev 238MB）→ v4 含全部自维护工具
//        （dev 整树实测 285MB，与任务管理器展开 Electron 组完全对得上）
//   py-broker 未就绪/重启中 → 保留上次值，下 tick 重试（监督者自愈 2s-30s）。
//   24h 曲线持久化不变：{userData}/alphal/crash-net/mem-curve.log（NDJSON 60s 一点，
//   512KB → .1.log 轮转），跨重启曲线连续、时间轴真实、断档分段不伪造。

import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { requestMemSnapshot } from './py-broker';

const TICK_MS = 5000;           // 快照周期（py-broker NtQuery ~7.5ms，免费）
const CURVE_CAP = 1440;         // 24h @ 60s
const CURVE_STEP_MS = 60000;    // 曲线点间隔
const CURVE_WINDOW_MS = 24 * 3600 * 1000;
const CURVE_FILE_MAX = 512 * 1024;

let _userData = '';
let _label = ''; // v12: 启动包标识（包根目录名：绿色包 gh555.com / dev 项目根），qoast 文案用
let _timer: ReturnType<typeof setInterval> | null = null;
let _last = { ts: 0, mb: 0, procs: 0, rows: [] as { pid: number; ppid: number; ws: number; n?: string }[] }; // 最新广播快照（成功值 / 失败保留旧值）
let _snapBusy = false;          // 防 10s 超时窗口内重复发命令

// 24h 曲线环形缓冲（带时间戳：跨重启持久化后时间轴真实）
const _curveT = new Float64Array(CURVE_CAP);
const _curveV = new Float64Array(CURVE_CAP);
const _curveN = new Uint16Array(CURVE_CAP); // 每点进程数（60s 窗口内峰值，进程数峰值显示用）
let _curveHead = 0; // 下一写入位置
let _curveLen = 0;  // 已有点数
// 待广播曲线点（与 tick 异步完成不同步 → 标志位防丢，禁 head 比较法）
let _pendingPt: { t: number; v: number; n?: number } | null = null;
let _peakNodesThisMin = 0; // 本 60s 窗口内进程数峰值（5s tick 累积，记点后重置）
const _bootAt = Date.now() - process.uptime() * 1000; // v10: 本实例启动时刻（渲染层「已启动」显示，跨 Ctrl+R 持续）
// 重启标记（v7: 每次实例启动写 mem-curve.log 一行 {boot:ts}，渲染层在曲线上画浅白虚线垂线
// 代表「新会话开始」——跨重启曲线连续 + 每次重启一目了然）
const _bootMarks: number[] = [];

// ── 曲线持久化（crash-net 同族：Data/alphal/crash-net/mem-curve.log） ──

function _curvePath(bak: boolean): string {
  return path.join(_userData, 'alphal', 'crash-net', bak ? 'mem-curve.1.log' : 'mem-curve.log');
}

function _loadCurve(): void {
  try {
    const now = Date.now();
    const pts: { t: number; v: number }[] = [];
    for (const p of [_curvePath(true), _curvePath(false)]) {
      let s = '';
      try { s = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const ln of s.split('\n')) {
        if (!ln) continue;
        try {
          const o = JSON.parse(ln);
          if (typeof o.boot === 'number' && now - o.boot < CURVE_WINDOW_MS) {
            _bootMarks.push(o.boot);
          } else if (typeof o.ts === 'number' && typeof o.mb === 'number' && o.mb > 0 && now - o.ts < CURVE_WINDOW_MS) {
            pts.push({ t: o.ts, v: o.mb, n: typeof o.n === 'number' ? o.n : 0 });
          }
        } catch { /* 半行/损坏跳过 */ }
      }
    }
    if (!pts.length) return;
    pts.sort((a, b) => a.t - b.t);
    const tail = pts.slice(-CURVE_CAP);
    for (const p of tail) {
      _curveT[_curveHead] = p.t;
      _curveV[_curveHead] = p.v;
      _curveN[_curveHead] = p.n || 0;
      _curveHead = (_curveHead + 1) % CURVE_CAP;
      if (_curveLen < CURVE_CAP) _curveLen++;
    }
    // 启动压缩：文件超 1440 点 → 重写为窗口内快照（一天一次量级，零成本）
    if (pts.length > CURVE_CAP) {
      try {
        const out = tail.map((p) => JSON.stringify(p.n ? { ts: p.t, mb: p.v, n: p.n } : { ts: p.t, mb: p.v })).join('\n') + '\n';
        fs.writeFileSync(_curvePath(false), out, 'utf8');
        try { fs.unlinkSync(_curvePath(true)); } catch { /* ignore */ }
      } catch { /* ignore */ }
    }
    // 显示兜底：首个真值落地前展示上次持久化值（首装为 --）
    if (!_last.ts) {
      const last = tail[tail.length - 1];
      if (last) { _last.mb = last.v; _last.ts = now; }
    }
  } catch { /* 曲线加载失败不影响主功能 */ }
}

// 每次实例启动落盘重启标记（读回后渲染层画垂线；先 load 后写 → 本次标记同时进内存）
function _persistBootMark(t: number): void {
  try {
    const p = _curvePath(false);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ boot: t }) + '\n', 'utf8');
    _bootMarks.push(t);
    if (_bootMarks.length > 16) _bootMarks.splice(0, _bootMarks.length - 16);
  } catch { /* 忽略 */ }
}

function _persistCurvePoint(t: number, v: number, n: number): void {
  try {
    const p = _curvePath(false);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(n ? { ts: t, mb: v, n } : { ts: t, mb: v }) + '\n', 'utf8');
    try {
      const st = fs.statSync(p);
      if (st.size > CURVE_FILE_MAX) fs.renameSync(p, _curvePath(true));
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

// ── 曲线点记录（60s 去重 + 落盘 + 待广播） ──

function _recordCurvePoint(v: number, n: number): void {
  const now = Date.now();
  if (_curveLen > 0) {
    const lastT = _curveT[(_curveHead + CURVE_CAP - 1) % CURVE_CAP];
    if (now - lastT < CURVE_STEP_MS) return; // 60s 内只记一点（n 峰值随下一点，不重置）
  }
  _curveT[_curveHead] = now;
  _curveV[_curveHead] = v;
  _curveN[_curveHead] = n;
  _curveHead = (_curveHead + 1) % CURVE_CAP;
  if (_curveLen < CURVE_CAP) _curveLen++;
  _pendingPt = { t: now, v, n };
  _persistCurvePoint(now, v, n);
  _peakNodesThisMin = 0; // 记点完成 → 重置分钟峰值窗口
}

// ── 快照：py-broker NtQuery 进程树 Σ 专用工作集（每 5s 全量真值，零估算） ──

async function _snapshot(): Promise<void> {
  if (_snapBusy) return;
  _snapBusy = true;
  try {
    const r = await requestMemSnapshot(process.pid);
    if (r && r.ok && typeof r.totalMB === 'number' && r.totalMB > 0) {
      _last = { ts: Date.now(), mb: r.totalMB, procs: r.nodes || 0, rows: r.rows || [] };
      if (r.nodes) _peakNodesThisMin = Math.max(_peakNodesThisMin, r.nodes); // 分钟进程数峰值（记点粒度）
      _recordCurvePoint(r.totalMB, _peakNodesThisMin);
    }
    // 失败（py-broker 重启中/超时）→ 保留上次值，下 tick 重试（监督者自愈）
  } catch { /* py-broker 未 ready / 重启中 → 静默保旧值 */ }
  _snapBusy = false;
}

async function _tick(): Promise<void> {
  await _snapshot();
  const msg: { ts: number; mb: number; procs: number; bootAt: number; rows?: { pid: number; ppid: number; ws: number; n?: string }[]; pt?: { t: number; v: number; n?: number } } = {
    ts: _last.ts || Date.now(), mb: _last.mb, procs: _last.procs, bootAt: _bootAt, rows: _last.rows, label: _label,
  };
  if (_pendingPt) {
    msg.pt = _pendingPt; // 仅新曲线点产生时才带（60s 一次），渲染层按 ts 单调去重
    _pendingPt = null;
  }
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('qqqide:mem:metrics', msg); } catch { /* ignore */ }
  }
}

export function memMeterInit(userData: string): void {
  if (_timer) return;
  _userData = userData;
  try { _label = path.basename(path.resolve(userData, '..')); } catch { _label = 'qqqide'; }
  ipcMain.handle('qqqide:mem:get-metrics', () => ({ mb: _last.mb, procs: _last.procs, bootAt: _bootAt, rows: _last.rows, label: _label }));
  ipcMain.handle('qqqide:mem:history', () => {
    const pts: { t: number; v: number; n?: number }[] = [];
    if (_curveLen < CURVE_CAP) {
      for (let i = 0; i < _curveLen; i++) pts.push({ t: _curveT[i], v: _curveV[i], n: _curveN[i] || undefined });
    } else {
      for (let i = 0; i < CURVE_CAP; i++) {
        const j = (_curveHead + i) % CURVE_CAP;
        pts.push({ t: _curveT[j], v: _curveV[j], n: _curveN[j] || undefined });
      }
    }
    return { pts, len: _curveLen, mb: _last.mb, procs: _last.procs, bootAt: _bootAt, rows: _last.rows, boots: _bootMarks.slice(), label: _label };
  });
  // v11: reset——清除曲线脏历史（文件 + 环形缓冲 + 重启垂线），从零重记，广播全窗口同步清空
  ipcMain.handle('qqqide:mem:reset', () => {
    _curveLen = 0; _curveHead = 0; _pendingPt = null; _bootMarks.length = 0; _peakNodesThisMin = 0;
    try { fs.unlinkSync(_curvePath(false)); } catch { /* ignore */ }
    try { fs.unlinkSync(_curvePath(true)); } catch { /* ignore */ }
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send('qqqide:mem:reset'); } catch { /* ignore */ }
    }
    return true;
  });
  _loadCurve(); // 先读回历史（首个真值落地前显示上次持久化值）
  _persistBootMark(Date.now()); // v7: 本实例启动标记落盘 + 进内存（曲线重启垂线）
  _tick();      // 立即首推（py-broker 未 ready 则保留持久化值，ready 后下 tick 对准）
  _timer = setInterval(_tick, TICK_MS);
  if (typeof (_timer as any).unref === 'function') (_timer as any).unref();
}
