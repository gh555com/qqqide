// mem-meter.ts — 启动包集合内存+CPU 真理机器（2026-08-30 v7：MEM/CPU 双流拆分 + 独立 reset）
// ★ v4 定案（2026-08-29 用户要求「集合总内存，画圈明确 = IDE + 全部自维护工具」）：
//   画圈 = 启动包进程树（主进程 + 全部后代递归）：Electron 六件套 + py-broker +
//   miniaudio_bridge + ghrun + goods python 全家（kope-a/window-there/ruler/q3 等）。
//   数据源 = py-broker NtQuerySystemInformation 快照（Windows 内核原生 API，
//   ctypes 直调 ~7.5ms/次，实测 288 进程全系统）→ 树内 Σ 专用工作集
//   （SYSTEM_PROCESS_INFORMATION offset 8，任务管理器「内存」列同口径，
//   2026-08-29 实测 8/8 逐字节命中 WMI WorkingSetPrivate）。
// ★ v6 CPU 口径定案（2026-08-29 用户要求「更直观更好量化，不用单核百分比」）：
//   单核百分比在 64 核机上 1% = 0.64 核，四舍五入全显示 0% → 无价值。
//   改为三个量化维度（任务管理器/资源监视器认知模型）：
//     ① 瞬时核数（当前占几个核）= ΣΔ(ut+kt)/1e7 / Δwall（不除 ncpu！绝对量，
//        64 核机空闲 0.1 核也清晰可读）；行级钳 1.0（单进程单核上限），树级不钳
//     ② 累计 CPU 时间（本次会话树内全部进程消耗的 CPU 秒总和，任务管理器进程
//        CPU 列 hover 同款）= 每 tick 树内差分累积（_cpuTotalSec，退出进程的最后
//        diff 已计入，仅存活 <1 tick 的进程漏计可忽略）
//     ③ 平均核数 = 累计 CPU 秒 / 已运行秒（等效持续占用的核数，直观量化）
//   曲线点 cu = 该 60s 窗口瞬时核数均值；旧 v5 c 百分比字段停止读取（同天数据直接弃）。
// ★ v7 双流拆分（2026-08-30 用户定案「reset 应该内存区和 CPU 区各一个」）：
//   曲线持久化拆双文件——mem-curve.log {ts,mb,n}（内存流）+ cpu-curve.log {ts,cu}
//   （CPU 流），同 tick 同 ts 各写各文件；reset(scope) 带 'mem'/'cpu'/'all' 各自清
//   各自文件+环形缓冲，互不影响（cpu reset 后 mem 曲线完整保留，反之亦然）；
//   旧一体行 {ts,mb,n,cu} 读回时 cu 一次性迁移进 cpu 流（写 cpu 文件，零成本兼容）；
//   boot 垂线两文件各写一行，读回去重。
//   py-broker 未就绪/重启中 → 保留上次值，下 tick 重试（监督者自愈 2s-30s）。
//   24h 曲线持久化：{userData}/alphal/crash-net/{mem-curve,cpu-curve}.log
//   （NDJSON 60s 一点，512KB → .1.log 轮转），跨重启曲线连续、时间轴真实、断档分段不伪造。

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
let _label = ''; // v13: 启动包标识 = 含 qqqide.exe 的包根目录完整路径（绿色包 E:\s\w\qqqide-win-x64 / dev 项目根），qoast 文案用
let _timer: ReturnType<typeof setInterval> | null = null;
let _last = { ts: 0, mb: 0, procs: 0, rows: [] as { pid: number; ppid: number; ws: number; n?: string; cpu?: number | null; cs?: number }[] }; // 最新广播快照（成功值 / 失败保留旧值）
let _snapBusy = false;          // 防 10s 超时窗口内重复发命令

// ── v6 CPU 状态（核数口径） ──
let _ncpu = 0;                                                       // 逻辑核心数（快照返回，os.cpu_count）
let _cpuPrev: { ts: number; byPid: Map<number, { ut: number; kt: number; sec: number }> } | null = null; // 差分基线 + 每进程累计 CPU 秒
let _cpuTotalSec = 0;                                                // 树级累计 CPU 秒（会话内，每 tick diff 累积）
let _cpuAccSum = 0; let _cpuAccCnt = 0;                              // 本 60s 窗口瞬时核数累积（记点后重置）

// ── v7 双流环形缓冲（mem 流 + cpu 流各自独立，reset 互不影响） ──
const _memT = new Float64Array(CURVE_CAP);
const _memV = new Float64Array(CURVE_CAP);
const _memN = new Uint16Array(CURVE_CAP); // 每点进程数（60s 窗口内峰值，进程数峰值显示用）
let _memHead = 0; // 下一写入位置
let _memLen = 0;  // 已有点数
const _cpuT = new Float64Array(CURVE_CAP);
const _cpuCU = new Float32Array(CURVE_CAP); // v6: 每点瞬时核数均值（该分钟有效采样平均）
let _cpuHead = 0;
let _cpuLen = 0;
// 待广播曲线点（与 tick 异步完成不同步 → 标志位防丢，禁 head 比较法；同 tick mem/cpu 合一广播）
let _pendingPt: { t: number; v: number; n?: number; cu?: number } | null = null;
let _peakNodesThisMin = 0; // 本 60s 窗口内进程数峰值（5s tick 累积，记点后重置）
const _bootAt = Date.now() - process.uptime() * 1000; // v10: 本实例启动时刻（渲染层「已启动」显示，跨 Ctrl+R 持续）
// 重启标记（v7: 每次实例启动两文件各写一行 {boot:ts}，渲染层在曲线上画浅白虚线垂线
// 代表「新会话开始」——跨重启曲线连续 + 每次重启一目了然）
const _bootMarks: number[] = [];

// ── 曲线持久化（crash-net 同族：Data/alphal/crash-net/） ──

function _curvePath(kind: 'mem' | 'cpu', bak: boolean): string {
  return path.join(_userData, 'alphal', 'crash-net', (kind === 'mem' ? 'mem-curve' : 'cpu-curve') + (bak ? '.1.log' : '.log'));
}

// 行级追加写（512KB → .1.log 轮转）
function _writeLine(kind: 'mem' | 'cpu', o: object): void {
  try {
    const p = _curvePath(kind, false);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(o) + '\n', 'utf8');
    try {
      const st = fs.statSync(p);
      if (st.size > CURVE_FILE_MAX) fs.renameSync(p, _curvePath(kind, true));
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function _loadCurve(): void {
  try {
    const now = Date.now();
    // ── mem 流（含旧一体行 {ts,mb,n,cu} 的 cu 一次性迁移进 cpu 流） ──
    const memPts: { t: number; v: number; n?: number; cu?: number }[] = [];
    for (const p of [_curvePath('mem', true), _curvePath('mem', false)]) {
      let s = '';
      try { s = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const ln of s.split('\n')) {
        if (!ln) continue;
        try {
          const o = JSON.parse(ln);
          if (typeof o.boot === 'number' && now - o.boot < CURVE_WINDOW_MS) {
            _bootMarks.push(o.boot);
          } else if (typeof o.ts === 'number' && typeof o.mb === 'number' && o.mb > 0 && now - o.ts < CURVE_WINDOW_MS) {
            memPts.push({ t: o.ts, v: o.mb, n: typeof o.n === 'number' ? o.n : 0, cu: typeof o.cu === 'number' ? o.cu : undefined });
          }
        } catch { /* 半行/损坏跳过 */ }
      }
    }
    if (memPts.length) {
      memPts.sort((a, b) => a.t - b.t);
      const tail = memPts.slice(-CURVE_CAP);
      for (const p of tail) {
        _memT[_memHead] = p.t;
        _memV[_memHead] = p.v;
        _memN[_memHead] = p.n || 0;
        _memHead = (_memHead + 1) % CURVE_CAP;
        if (_memLen < CURVE_CAP) _memLen++;
        // 旧一体行 cu → cpu 流（迁移落盘，此后 mem 文件不再含 cu）
        if (typeof p.cu === 'number') {
          _cpuT[_cpuHead] = p.t;
          _cpuCU[_cpuHead] = p.cu;
          _cpuHead = (_cpuHead + 1) % CURVE_CAP;
          if (_cpuLen < CURVE_CAP) _cpuLen++;
          _writeLine('cpu', { ts: p.t, cu: p.cu });
        }
      }
      // 启动压缩：超 1440 点 → 重写窗口内快照（一天一次量级，零成本）
      if (memPts.length > CURVE_CAP) {
        try {
          const out = tail.map((p) => {
            const o: any = { ts: p.t, mb: p.v };
            if (p.n) o.n = p.n;
            return JSON.stringify(o);
          }).join('\n') + '\n';
          fs.writeFileSync(_curvePath('mem', false), out, 'utf8');
          try { fs.unlinkSync(_curvePath('mem', true)); } catch { /* ignore */ }
        } catch { /* ignore */ }
      }
      // 显示兜底：首个真值落地前展示上次持久化值（首装为 --）
      if (!_last.ts) {
        const last = tail[tail.length - 1];
        if (last) { _last.mb = last.v; _last.ts = now; }
      }
    }
    // ── cpu 流（独立文件） ──
    const cpuPts: { t: number; cu: number }[] = [];
    for (const p of [_curvePath('cpu', true), _curvePath('cpu', false)]) {
      let s = '';
      try { s = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const ln of s.split('\n')) {
        if (!ln) continue;
        try {
          const o = JSON.parse(ln);
          if (typeof o.boot === 'number' && now - o.boot < CURVE_WINDOW_MS) {
            _bootMarks.push(o.boot);
          } else if (typeof o.ts === 'number' && typeof o.cu === 'number' && now - o.ts < CURVE_WINDOW_MS) {
            cpuPts.push({ t: o.ts, cu: o.cu });
          }
        } catch { /* 半行/损坏跳过 */ }
      }
    }
    if (cpuPts.length) {
      cpuPts.sort((a, b) => a.t - b.t);
      const tail = cpuPts.slice(-CURVE_CAP);
      for (const p of tail) {
        _cpuT[_cpuHead] = p.t;
        _cpuCU[_cpuHead] = p.cu;
        _cpuHead = (_cpuHead + 1) % CURVE_CAP;
        if (_cpuLen < CURVE_CAP) _cpuLen++;
      }
      if (cpuPts.length > CURVE_CAP) {
        try {
          const out = tail.map((p) => JSON.stringify({ ts: p.t, cu: p.cu })).join('\n') + '\n';
          fs.writeFileSync(_curvePath('cpu', false), out, 'utf8');
          try { fs.unlinkSync(_curvePath('cpu', true)); } catch { /* ignore */ }
        } catch { /* ignore */ }
      }
    }
    // boot 垂线去重排序（两文件各写一行同 ts → 去重）
    _bootMarks.sort((a, b) => a - b);
    for (let i = _bootMarks.length - 1; i > 0; i--) {
      if (_bootMarks[i] === _bootMarks[i - 1]) _bootMarks.splice(i, 1);
    }
  } catch { /* 曲线加载失败不影响主功能 */ }
}

// 每次实例启动两文件各写一行重启标记（读回后渲染层画垂线；先 load 后写 → 本次标记同时进内存）
function _persistBootMark(t: number): void {
  _writeLine('mem', { boot: t });
  _writeLine('cpu', { boot: t });
  _bootMarks.push(t);
  if (_bootMarks.length > 16) _bootMarks.splice(0, _bootMarks.length - 16);
}

// ── 曲线点记录（60s 去重 + 双文件落盘 + 待广播；mem/cpu 同 tick 同 ts） ──

function _recordCurvePoint(v: number, n: number, cu?: number): void {
  const now = Date.now();
  if (_memLen > 0) {
    const lastT = _memT[(_memHead + CURVE_CAP - 1) % CURVE_CAP];
    if (now - lastT < CURVE_STEP_MS) return; // 60s 内只记一点（n 峰值随下一点，不重置）
  }
  _memT[_memHead] = now;
  _memV[_memHead] = v;
  _memN[_memHead] = n;
  _memHead = (_memHead + 1) % CURVE_CAP;
  if (_memLen < CURVE_CAP) _memLen++;
  _writeLine('mem', { ts: now, mb: v, ...(n ? { n } : {}) });
  let cuOut: number | undefined;
  if (typeof cu === 'number') {
    _cpuT[_cpuHead] = now;
    _cpuCU[_cpuHead] = cu;
    _cpuHead = (_cpuHead + 1) % CURVE_CAP;
    if (_cpuLen < CURVE_CAP) _cpuLen++;
    _writeLine('cpu', { ts: now, cu });
    cuOut = cu;
  }
  _pendingPt = { t: now, v, n, cu: cuOut };
  _peakNodesThisMin = 0; // 记点完成 → 重置分钟峰值窗口
  _cpuAccSum = 0; _cpuAccCnt = 0; // 记点完成 → 重置分钟核数累积
}

// ── v6 行级 CPU 差分（核数口径；新进程/pid 复用无基线 → null，下一采样纳入） ──
// 返回 { cores: 瞬时核数|null, sec: 本进程累计 CPU 秒 }；同时累积树级 _cpuTotalSec

function _rowCpu(pid: number, ut: number, kt: number, wallMs: number): { cores: number | null; sec: number } {
  if (!_cpuPrev || wallMs <= 0) return { cores: null, sec: 0 };
  const prev = _cpuPrev.byPid.get(pid);
  if (!prev) return { cores: null, sec: 0 };
  const dt = (ut - prev.ut) + (kt - prev.kt);
  if (dt < 0) { prev.ut = ut; prev.kt = kt; return { cores: null, sec: prev.sec }; } // tick 回绕（进程重启/pid 复用）→ 基线重建，下一采样纳入
  const sec = dt / 1e7; // ticks(100ns) → 秒
  prev.ut = ut; prev.kt = kt; prev.sec += sec;
  _cpuTotalSec += sec;
  let cores = sec / (wallMs / 1000); // 核数 = CPU 秒 / 墙钟秒（不除 ncpu！绝对量）
  if (cores > 1) cores = 1; // 单进程单核理论上限（防 pid 复用瞬时污染）
  return { cores, sec: prev.sec };
}

// ── 快照：py-broker NtQuery 进程树 Σ 专用工作集 + CPU 差分（每 5s 全量真值，零估算） ──

async function _snapshot(): Promise<void> {
  if (_snapBusy) return;
  _snapBusy = true;
  try {
    const r = await requestMemSnapshot(process.pid);
    if (r && r.ok && typeof r.totalMB === 'number' && r.totalMB > 0) {
      const now = Date.now();
      const wall = _cpuPrev ? now - _cpuPrev.ts : 0;
      if (typeof r.ncpu === 'number' && r.ncpu > 0) _ncpu = r.ncpu;
      // 行级差分（用旧基线）+ 树级求和（同分母，Σ行级核数 = 树级占用核数）
      const rows: { pid: number; ppid: number; ws: number; n?: string; cpu?: number | null; cs?: number }[] = [];
      let coresSum = 0, coresCnt = 0;
      for (const row of (r.rows || []) as { pid: number; ppid: number; ws: number; n?: string; ut: number; kt: number }[]) {
        const c = _rowCpu(row.pid, row.ut || 0, row.kt || 0, wall);
        if (c.cores !== null) { coresSum += c.cores; coresCnt++; }
        rows.push({ pid: row.pid, ppid: row.ppid, ws: row.ws, n: row.n, cpu: c.cores, cs: c.sec });
      }
      const cores = coresCnt > 0 ? Math.min(coresSum, _ncpu || coresSum) : null; // 树级瞬时核数（顶封 ncpu 防尖峰）
      if (cores !== null) { _cpuAccSum += cores; _cpuAccCnt++; }
      _last = { ts: now, mb: r.totalMB, procs: r.nodes || 0, rows };
      if (r.nodes) _peakNodesThisMin = Math.max(_peakNodesThisMin, r.nodes); // 分钟进程数峰值（记点粒度）
      _recordCurvePoint(r.totalMB, _peakNodesThisMin, _cpuAccCnt ? _cpuAccSum / _cpuAccCnt : undefined);
      // 基线重建（必须先差分后重建；sec 累计跨基线保留）
      const byPid = new Map<number, { ut: number; kt: number; sec: number }>();
      for (const row of (r.rows || []) as { pid: number; ut: number; kt: number }[]) {
        const old = _cpuPrev ? _cpuPrev.byPid.get(row.pid) : undefined;
        byPid.set(row.pid, { ut: row.ut || 0, kt: row.kt || 0, sec: old ? old.sec : 0 });
      }
      _cpuPrev = { ts: now, byPid };
    }
    // 失败（py-broker 重启中/超时）→ 保留上次值，下 tick 重试（监督者自愈）
  } catch { /* py-broker 未 ready / 重启中 → 静默保旧值 */ }
  _snapBusy = false;
}

// 当前树级瞬时核数（广播/查询共用；rows 最新快照行级差分求和）
function _lastCores(): number | null {
  if (!_last.rows.length) return null;
  let s = 0, c2 = 0;
  for (const r of _last.rows) { if (typeof r.cpu === 'number') { s += r.cpu; c2++; } }
  return c2 > 0 ? Math.min(s, _ncpu || s) : null;
}

// 平均核数 = 累计 CPU 秒 / 已运行秒（等效持续占用核数，量化直观）
function _avgCores(): number {
  const runSec = (Date.now() - _bootAt) / 1000;
  return runSec > 0 ? _cpuTotalSec / runSec : 0;
}

// v6 CPU 广播载荷（三渲染端共用）
function _cpuMsg(): { cores: number | null; totalSec: number; avgCores: number } {
  return { cores: _lastCores(), totalSec: Math.round(_cpuTotalSec), avgCores: Math.round(_avgCores() * 10) / 10 };
}

async function _tick(): Promise<void> {
  await _snapshot();
  const msg: { ts: number; mb: number; procs: number; bootAt: number; cpu?: { cores: number | null; totalSec: number; avgCores: number }; ncpu?: number; rows?: { pid: number; ppid: number; ws: number; n?: string; cpu?: number | null; cs?: number }[]; pt?: { t: number; v: number; n?: number; cu?: number }; label?: string } = {
    ts: _last.ts || Date.now(), mb: _last.mb, procs: _last.procs, bootAt: _bootAt, rows: _last.rows, label: _label,
  };
  // v6: CPU 广播——核数口径（瞬时核数 / 累计秒 / 平均核数），ncpu 供渲染层 y 轴顶封
  msg.cpu = _cpuMsg();
  msg.ncpu = _ncpu;
  if (_pendingPt) {
    msg.pt = _pendingPt; // 仅新曲线点产生时才带（60s 一次），渲染层按 ts 单调去重
    _pendingPt = null;
  }
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('qqqide:mem:metrics', msg); } catch { /* ignore */ }
  }
}

// v13: 启动包根 = 含 qqqide.exe 的目录（从 appPath 逐级上探：绿色包
// ...\gh555.com\resources\app → E:\s\w\qqqide-win-x64；dev 项目根无 qqqide.exe → 回落 appPath）
function _resolveLabel(): string {
  try {
    let p = app.getAppPath();
    for (let i = 0; i < 10; i++) {
      try { if (fs.existsSync(path.join(p, 'qqqide.exe'))) return p; } catch { break; }
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
  } catch { /* ignore */ }
  return app.getAppPath();
}

export function memMeterInit(userData: string): void {
  if (_timer) return;
  _userData = userData;
  try { _label = _resolveLabel(); } catch { _label = 'qqqide'; }
  ipcMain.handle('qqqide:mem:get-metrics', () => ({ mb: _last.mb, procs: _last.procs, bootAt: _bootAt, rows: _last.rows, label: _label, cpu: _cpuMsg(), ncpu: _ncpu }));
  ipcMain.handle('qqqide:mem:history', () => {
    // v7: 双流返回（memPts 内存曲线 / cpuPts CPU 曲线，渲染层按 ts 独立合并去重）
    const memPts: { t: number; v: number; n?: number }[] = [];
    if (_memLen < CURVE_CAP) {
      for (let i = 0; i < _memLen; i++) memPts.push({ t: _memT[i], v: _memV[i], n: _memN[i] || undefined });
    } else {
      for (let i = 0; i < CURVE_CAP; i++) {
        const j = (_memHead + i) % CURVE_CAP;
        memPts.push({ t: _memT[j], v: _memV[j], n: _memN[j] || undefined });
      }
    }
    const cpuPts: { t: number; cu: number }[] = [];
    if (_cpuLen < CURVE_CAP) {
      for (let i = 0; i < _cpuLen; i++) cpuPts.push({ t: _cpuT[i], cu: _cpuCU[i] });
    } else {
      for (let i = 0; i < CURVE_CAP; i++) {
        const j = (_cpuHead + i) % CURVE_CAP;
        cpuPts.push({ t: _cpuT[j], cu: _cpuCU[j] });
      }
    }
    return { memPts, cpuPts, len: _memLen, mb: _last.mb, procs: _last.procs, bootAt: _bootAt, rows: _last.rows, boots: _bootMarks.slice(), label: _label, cpu: _cpuMsg(), ncpu: _ncpu };
  });
  // v7: reset——scope 定案（'mem'/'cpu'/'all'），各自清各自文件+环形缓冲，互不影响；
  // mem reset 连带清垂线（垂线属 mem 流生命周期）；cpu reset 连带清 CPU 基线/累计
  // （下次采样重建）；广播带 scope 供渲染层对应清本地缓冲。
  ipcMain.handle('qqqide:mem:reset', (_e, scope?: string) => {
    const sc = scope === 'cpu' ? 'cpu' : (scope === 'all' ? 'all' : 'mem');
    if (sc === 'mem' || sc === 'all') {
      _memLen = 0; _memHead = 0;
      try { fs.unlinkSync(_curvePath('mem', false)); } catch { /* ignore */ }
      try { fs.unlinkSync(_curvePath('mem', true)); } catch { /* ignore */ }
    }
    if (sc === 'cpu' || sc === 'all') {
      _cpuLen = 0; _cpuHead = 0;
      try { fs.unlinkSync(_curvePath('cpu', false)); } catch { /* ignore */ }
      try { fs.unlinkSync(_curvePath('cpu', true)); } catch { /* ignore */ }
    }
    _pendingPt = null; // 半成品曲线点丢弃（mem/cpu 任清都丢——60s 后自然重记）
    if (sc !== 'cpu') _bootMarks.length = 0; // mem/all 清垂线（垂线挂 mem 流）
    if (sc === 'all') { _peakNodesThisMin = 0; }
    if (sc === 'cpu' || sc === 'all') {
      _cpuPrev = null; _cpuTotalSec = 0; _cpuAccSum = 0; _cpuAccCnt = 0; // CPU 从零累积
    }
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send('qqqide:mem:reset', { scope: sc }); } catch { /* ignore */ }
    }
    return true;
  });
  _loadCurve(); // 先读回历史（首个真值落地前显示上次持久化值）
  _persistBootMark(Date.now()); // v7: 本实例启动标记双文件落盘 + 进内存（曲线重启垂线）
  _tick();      // 立即首推（py-broker 未 ready 则保留持久化值，ready 后下 tick 对准）
  _timer = setInterval(_tick, TICK_MS);
  if (typeof (_timer as any).unref === 'function') (_timer as any).unref();
}
