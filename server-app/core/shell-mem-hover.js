// shell-mem-hover.js — 启动包 内存+CPU 24h 曲线 合并 hover 面板（2026-08-30 v7 合并版）
// 用户定案（2026-08-30）：MEM 与 CPU 数据同源同一进程树（同一 NtQuery 快照），两张卡片
//   合二为一——上区两层（内存图+打印 / CPU 图+打印），下方共用同一进程列表（每行
//   内存 MB + 会话累计 CPU 时间）；状态区 a 区域 = 内存图标+内存文字+CPU文字（CPU 图标
//   移除），hover/点击弹同一张卡，点卡外任意区域关闭；卡片宽度不变（360px），高度增高
//   （580px 固定）。配色：内存 green/cyan 系不变，CPU 换橙色系（var(--orange)）。
// ★ 时间轴 = 累计运行时长（2026-08-30 用户实锤「把关机时间算进去了」）：断档（>3min 空洞）
//   不推进 x 轴——程序没运行的时间在图上不占任何宽度，曲线恒铺满；刻度语义 = 运行时长
//   （-24h = 24h 运行时长前）。60s 一点 × 1440 点 cap = 24h 运行时长（点数即运行时长，
//   墙钟修剪已删除）。
// 数据源: 主进程 mem-meter 真理机器（qqqide:mem:history 首拉全量 + qqqide:mem:metrics
//   增量广播），py-broker NtQuerySystemInformation（内核原生 ~7.5ms/次）启动包进程树
//   Σ 专用工作集（任务管理器「内存」列同口径）+ 行级 ut/kt 差分（CPU 核数/累计时间）。
// 交互: 状态区 a 区域——hover 即弹，点击固定（可滚动进程列表），再点取消；点卡片外任意
//   区域（含全部 iframe 内部）关闭。瞬间弹出，350ms 延迟隐藏。
(function () {
  'use strict';
  var $mem = document.getElementById('qqq-status-mem');
  var $memVal = document.querySelector('.qqq-mem-block .qqq-mem-val');
  var $cpuVal = document.querySelector('.qqq-mem-block .qqq-cpu-val');
  var bridge = window.qqqideBridge;
  if (!$mem || !$memVal || !$cpuVal || !bridge || !bridge.mem) return;

  var CURVE_CAP = 1440; // 60s 一点 = 24h 运行时长刚好满 cap
  var GAP_MS = 3 * 60000; // 断档阈值（>3min 空洞 = 程序未运行，不推进运行时长 x 轴）
  var W = 340, H = 134, PLOT_H = 124; // SVG 尺寸（两段共用；v8: y 轴空间 +16px/图，卡片高度同步 +32）
  var PAD_L = 40, PAD_R = 6, PAD_T = 6, PAD_B = 6; // 左= y 轴刻度区（'12.5核' 5 字符，MEM 同步统一 40）
  var plotW = W - PAD_L - PAD_R;   // 294 曲线区宽
  var plotH = PLOT_H - PAD_T - PAD_B; // 96 曲线区高
  var PANEL_H = 732; // 固定面板高（v11: 进程打印区回落 180px——912→732，用户定案「太宽了」；CSS 已同步 732）
  var memPts = [];       // 内存曲线点 [{t,v,n}]（旧→新，60s 一点）
  var cpuPts = [];       // CPU 曲线点 [{t,cu}]（与 mem 同 ts；独立 reset 后从零累积）
  var memRunT = [];      // memPts 的累计运行时长坐标（断档不推进）
  var cpuRunT = [];      // cpuPts 的累计运行时长坐标
  var latest = { mb: 0, procs: 0, bootAt: 0, label: '', cores: null, totalSec: 0, ncpu: 0 };
  var rows = [];         // 最近快照进程树 [{pid,ppid,ws,n,cs}]（树序）
  var lastMemT = -1;     // 最近已收 mem 曲线点 ts（单调去重）
  var lastCpuT = -1;     // 最近已收 cpu 曲线点 ts（独立 reset 后独立单调）
  var coresSmooth = [];  // 3 点移动平均滑动窗（瞬时核数是速率量 5s 抖，平滑后显示）
  var $panel = null;
  // MEM 段
  var $svg = null, $poly = null, $area = null, $dot = null, $dotPulse = null;
  var $val = null, $unit = null, $procs = null, $phUp = null, $avg = null, $stats = null, $grid = null, $labels = null;
  var $curVal = null, $bootPath = null, $title = null;
  // CPU 段
  var $cSvg = null, $cPoly = null, $cArea = null, $cDot = null, $cDotPulse = null;
  var $cVal = null, $cUnit = null, $cAvg = null, $cStats = null, $cGrid = null, $cLabels = null;
  var $cCurVal = null, $cBootPath = null;
  var $plist = null;
  var boots = []; // 重启标记（主进程 mem-curve.log {boot:ts}）→ 曲线浅白虚线垂线
  var hideTimer = null, shown = false;
  var pinned = false; // 点击状态区 a 区域固定面板（可交互滚动进程列表），再点取消
  var gridBuilt = false;
  var avgWasOver = false; // 均值超 1GB 边沿触发（恢复后再次超限才再弹）
  var avgQoastAt = 0;    // 上次弹 qoast 时刻（1h 冷却防刷屏）

  // ── 格式化（量化优先） ──
  function fmtCpuTime(sec) {
    if (!sec || sec <= 0) return '--';
    sec = Math.round(sec);
    if (sec < 60) return sec + 's';
    if (sec < 3600) {
      var m = Math.floor(sec / 60), s = sec % 60;
      return m + 'm' + (s ? s + 's' : '');
    }
    var h = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60);
    return h + 'h' + (mm ? mm + 'm' : '');
  }
  // 核数：<10 一位小数（0.4核），≥10 整数（12核）
  function fmtCores(c) {
    if (c === null || typeof c !== 'number' || c < 0) return '--';
    return (c < 10 ? c.toFixed(1) : Math.round(c)) + '核';
  }
  // 行级累计时间
  function fmtRowTime(sec) {
    if (!sec || sec <= 0) return '0s';
    return fmtCpuTime(sec);
  }
  function fmtVal(v) {
    return Math.round(v) + 'M';
  }

  // ── 面板 DOM（一次性构建，惰性） ──
  function ensurePanel() {
    if ($panel) return;
    $panel = document.createElement('div');
    $panel.className = 'qqq-mem-hover';
    $panel.id = 'qqq-mem-hover';
    $panel.innerHTML =
      // ── MEM 段（上） ──
      '<div class="qqq-mem-hover-head">' +
      '<span class="qqq-mem-hover-title"><span class="qqq-mem-hover-tname">MEM</span><span class="qqq-mem-hover-dot"></span></span>' +
      '<button class="qqq-mem-hover-reset" data-scope="mem" title="清除内存曲线历史，从零重记（删 mem-curve.log，不影响 CPU 曲线）">reset</button>' +
      '</div>' +
      '<div class="qqq-mem-hover-num">' +
      '<span class="qqq-mem-hover-num-main"><span class="qqq-mem-hover-val">--</span><span class="qqq-mem-hover-unit">MB</span></span>' +
      '<span class="qqq-mem-hover-avg">--</span>' +
      '</div>' +
      '<div class="qqq-mem-hover-chart">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
      '<defs>' +
      '<linearGradient id="qqq-mem-area-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop class="qqq-mem-stop-a" offset="0%"/><stop class="qqq-mem-stop-b" offset="100%"/>' +
      '</linearGradient>' +
      '<linearGradient id="qqq-mem-line-grad" x1="0" y1="0" x2="1" y2="0">' +
      '<stop class="qqq-mem-stop-c" offset="0%"/><stop class="qqq-mem-stop-d" offset="100%"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<g class="qqq-mem-grid"></g>' +
      '<polygon class="qqq-mem-area" fill="url(#qqq-mem-area-grad)"/>' +
      '<path class="qqq-mem-bootline"/>' +
      '<polyline class="qqq-mem-line" fill="none" stroke="url(#qqq-mem-line-grad)"/>' +
      '<circle class="qqq-mem-dot-pulse" r="3.5"/>' +
      '<circle class="qqq-mem-dot" r="2.5"/>' +
      '<text class="qqq-mem-curval"></text>' +
      '<g class="qqq-mem-labels"></g>' +
      '</svg>' +
      '</div>' +
      '<div class="qqq-mem-hover-stats">--</div>' +
      // ── CPU 段（下，橙色系；独立 reset——v7 定案各区各清） ──
      '<div class="qqq-cpu-hover-head">' +
      '<span class="qqq-mem-hover-title"><span class="qqq-mem-hover-tname">CPU</span><span class="qqq-cpu-hover-dot"></span></span>' +
      '<button class="qqq-mem-hover-reset" data-scope="cpu" title="清除 CPU 曲线历史，从零重记（删 cpu-curve.log）">reset</button>' +
      '</div>' +
      '<div class="qqq-cpu-hover-num">' +
      '<span class="qqq-cpu-hover-num-main"><span class="qqq-cpu-hover-val">--</span><span class="qqq-cpu-hover-unit">CPU时间</span></span>' +
      '<span class="qqq-cpu-hover-avg">--</span>' +
      '</div>' +
      '<div class="qqq-cpu-hover-chart">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
      '<defs>' +
      '<linearGradient id="qqq-cpu-area-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop class="qqq-cpu-stop-a" offset="0%"/><stop class="qqq-cpu-stop-b" offset="100%"/>' +
      '</linearGradient>' +
      '<linearGradient id="qqq-cpu-line-grad" x1="0" y1="0" x2="1" y2="0">' +
      '<stop class="qqq-cpu-stop-c" offset="0%"/><stop class="qqq-cpu-stop-d" offset="100%"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<g class="qqq-cpu-grid"></g>' +
      '<polygon class="qqq-cpu-area" fill="url(#qqq-cpu-area-grad)"/>' +
      '<path class="qqq-mem-bootline"/>' +
      '<polyline class="qqq-cpu-line" fill="none" stroke="url(#qqq-cpu-line-grad)"/>' +
      '<circle class="qqq-cpu-dot-pulse" r="3.5"/>' +
      '<circle class="qqq-cpu-dot" r="2.5"/>' +
      '<text class="qqq-cpu-curval"></text>' +
      '<g class="qqq-cpu-labels"></g>' +
      '</svg>' +
      '</div>' +
      '<div class="qqq-cpu-hover-stats">--</div>' +
      // ── 共用进程列表 ──
      '<div class="qqq-mem-hover-plist-head">' +
      '<div class="qqq-mem-hover-ph-row"><span class="qqq-mem-hover-ph-title">qqqide 专用工作集（包含一切子进程）</span></div>' +
      '<div class="qqq-mem-hover-ph-row"><span class="qqq-mem-hover-ph-procs">--</span><span class="qqq-mem-hover-ph-up">--</span></div>' +
      '</div>' +
      '<div class="qqq-mem-hover-plist"></div>';
    document.body.appendChild($panel);
    // MEM 段
    $svg = $panel.querySelector('.qqq-mem-hover-chart svg');
    $poly = $panel.querySelector('.qqq-mem-line');
    $area = $panel.querySelector('.qqq-mem-area');
    $dot = $panel.querySelector('.qqq-mem-dot');
    $dotPulse = $panel.querySelector('.qqq-mem-dot-pulse');
    $val = $panel.querySelector('.qqq-mem-hover-val');
    $unit = $panel.querySelector('.qqq-mem-hover-unit');
    $procs = $panel.querySelector('.qqq-mem-hover-ph-procs');
    $phUp = $panel.querySelector('.qqq-mem-hover-ph-up');
    $avg = $panel.querySelector('.qqq-mem-hover-avg');
    $stats = $panel.querySelector('.qqq-mem-hover-stats');
    $grid = $panel.querySelector('.qqq-mem-grid');
    $labels = $panel.querySelector('.qqq-mem-labels');
    $curVal = $panel.querySelector('.qqq-mem-curval');
    $bootPath = $panel.querySelector('.qqq-mem-hover-chart .qqq-mem-bootline');
    $title = $panel.querySelector('.qqq-mem-hover-tname');
    // CPU 段
    $cSvg = $panel.querySelector('.qqq-cpu-hover-chart svg');
    $cPoly = $panel.querySelector('.qqq-cpu-line');
    $cArea = $panel.querySelector('.qqq-cpu-area');
    $cDot = $panel.querySelector('.qqq-cpu-dot');
    $cDotPulse = $panel.querySelector('.qqq-cpu-dot-pulse');
    $cVal = $panel.querySelector('.qqq-cpu-hover-val');
    $cUnit = $panel.querySelector('.qqq-cpu-hover-unit');
    $cAvg = $panel.querySelector('.qqq-cpu-hover-avg');
    $cStats = $panel.querySelector('.qqq-cpu-hover-stats');
    $cGrid = $panel.querySelector('.qqq-cpu-grid');
    $cLabels = $panel.querySelector('.qqq-cpu-labels');
    $cCurVal = $panel.querySelector('.qqq-cpu-curval');
    $cBootPath = $panel.querySelector('.qqq-cpu-hover-chart .qqq-mem-bootline');
    $plist = $panel.querySelector('.qqq-mem-hover-plist');
    buildFrame();
    wireReset();
    wireStatsTip($stats);
    wireStatsTip($cStats);
  }

  // 网格（3 条水平线）+ y 轴刻度文本 + 时间刻度（一次性；刻度文案每次渲染动态刷新）
  function buildFrame() {
    if (gridBuilt) return;
    gridBuilt = true;
    var g = '', cg = '', gy, i;
    for (i = 0; i < 3; i++) {
      gy = PAD_T + plotH * i / 2;
      g += '<line x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) + '"/>';
    }
    // MEM: max/mid 各下移 2px（用户定案，min 不动）——刻度贴网格线下方更顺眼
    g += '<text class="qqq-mem-ylbl" x="2" y="' + (PAD_T + 5) + '">--</text>' +
      '<text class="qqq-mem-ylbl" x="2" y="' + (PAD_T + plotH / 2 + 5) + '">--</text>' +
      '<text class="qqq-mem-ylbl" x="2" y="' + (PAD_T + plotH + 3) + '">--</text>';
    $grid.innerHTML = g;
    $grid._ylbl = $grid.querySelectorAll('.qqq-mem-ylbl');
    $labels.innerHTML =
      '<text x="' + PAD_L + '" y="' + (H - 3) + '">-24h</text>' +
      '<text class="qqq-mem-lbl-mid" x="' + (PAD_L + plotW / 2) + '" y="' + (H - 3) + '" text-anchor="middle">-12h</text>' +
      '<text x="' + (W - PAD_R) + '" y="' + (H - 3) + '" text-anchor="end">now</text>';
    // CPU 段同款框架
    cg += '<line x1="' + PAD_L + '" y1="' + (PAD_T + plotH / 2).toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + (PAD_T + plotH / 2).toFixed(1) + '"/>';
    cg += '<text class="qqq-cpu-ylbl" x="2" y="' + (PAD_T + 5) + '">--</text>' +
      '<text class="qqq-cpu-ylbl" x="2" y="' + (PAD_T + plotH / 2 + 5) + '">--</text>' +
      '<text class="qqq-cpu-ylbl" x="2" y="' + (PAD_T + plotH + 3) + '">--</text>';
    $cGrid.innerHTML = cg;
    $cGrid._ylbl = $cGrid.querySelectorAll('.qqq-cpu-ylbl');
    $cLabels.innerHTML =
      '<text x="' + PAD_L + '" y="' + (H - 3) + '">-24h</text>' +
      '<text class="qqq-cpu-lbl-mid" x="' + (PAD_L + plotW / 2) + '" y="' + (H - 3) + '" text-anchor="middle">-12h</text>' +
      '<text x="' + (W - PAD_R) + '" y="' + (H - 3) + '" text-anchor="end">now</text>';
  }

  // 定位：锚定状态区 a 区域上方右对齐（元素位置变化实时跟随）
  function position() {
    var r = $mem.getBoundingClientRect();
    var w = 360;
    var h = $panel ? $panel.offsetHeight : PANEL_H; // 实测高（content-box padding 含入双保险）
    var x = r.right - w + 4;
    if (x < 4) x = 4;
    var y = r.top - h - 10;
    if (y < 4) y = 4; // 恒上弹不遮状态区——空间不足贴顶
    $panel.style.left = x + 'px';
    $panel.style.top = y + 'px';
  }

  function show() {
    if (!shown) {
      ensurePanel();
      if ($mem.offsetParent === null) return; // dense 隐藏中不弹
      position();
      $panel.classList.add('qqq-mem-hover-show');
      shown = true;
      renderCurve();
      renderRows(); // v19: 面板打开立即渲染进程列表——旧版 show() 缺 renderRows()，列表只在 5s 广播/history 完成时画 → 每次打开空白等 ~10s（用户实锤）；rows 早已在主进程（getMetrics 兜底拉过），此刻即画
    } else {
      position();
    }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function hide() {
    if (pinned) return; // 固定中永不隐藏（滚动进程列表/细看曲线）
    if (!shown) return;
    $panel.classList.remove('qqq-mem-hover-show');
    shown = false;
  }

  function hideSoon() {
    if (pinned) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 350);
  }

  // ── 曲线数据维护（点数即运行时长：60s 一点 × 1440 = 24h 运行时长，墙钟修剪已删除） ──
  function trimMemPts() {
    while (memPts.length > CURVE_CAP) memPts.shift();
  }
  function trimCpuPts() {
    while (cpuPts.length > CURVE_CAP) cpuPts.shift();
  }

  function spanTxt(spanMin) {
    if (spanMin >= 1440) return '24h';
    if (spanMin >= 60) {
      var h = Math.round(spanMin / 60), m = spanMin % 60;
      return (h ? h + 'h' : '') + (m ? m + 'm' : '');
    }
    return spanMin + 'min';
  }

  // 已启动时长（主进程 bootAt → now；≥24h 显示整小时）——会话墙钟语义
  function uptimeTxt(min) {
    if (min < 60) return min + 'min';
    var h = Math.floor(min / 60), m = min % 60;
    if (h >= 24) return h + 'h';
    return h + 'h' + (m ? m + 'm' : '');
  }

  // ── ★ 运行时长坐标：断档（>3min 空洞）不推进 x 轴——程序没运行的时间不占图宽 ──
  function buildRunT(use, out) {
    out.length = use.length;
    if (!use.length) return;
    out[0] = 0;
    for (var i = 1; i < use.length; i++) {
      var g = use[i].t - use[i - 1].t;
      out[i] = out[i - 1] + (g > GAP_MS ? 0 : g);
    }
  }

  // 弹性窗口：span = 累计运行时长（首点→末点），曲线恒铺满全宽（mem/cpu 各自独立）
  function spanOf(useArr, runTArr) {
    if (useArr.length < 2) return 60000;
    var span = runTArr[runTArr.length - 1];
    return span < 1000 ? 1000 : span;
  }

  // ── 内存 y 坐标域：抗尖峰（>4×中位数不参与）+ 百分位 p5/p95 + 8% 顶余量 ──
  function memYDomain(use) {
    var i, p, vals = [];
    for (i = 0; i < use.length; i++) vals.push(use[i].v);
    vals.sort(function (a, b) { return a - b; });
    var med = vals[Math.floor(vals.length / 2)];
    var capHi = med * 4, capLo = med / 4;
    var norm = [];
    for (i = 0; i < use.length; i++) {
      p = use[i].v;
      if (p >= capLo && p <= capHi) norm.push(p);
    }
    if (!norm.length) norm = [med];
    norm.sort(function (a, b) { return a - b; });
    var min = norm[Math.max(0, Math.floor(norm.length * 0.05))];
    var max = norm[Math.min(norm.length - 1, Math.floor(norm.length * 0.95))];
    if (max === min) max = min + 1;
    var head = (max - min) * 0.08;
    max += head; min -= head;
    return { min: min, max: max };
  }

  // ── CPU y 坐标域：min=0 固定 + p95 动态上界（顶封 ncpu）+ 8% 顶余量 ──
  // 核数是绝对量：0 是真实下限，不做内存那套 4× 抗尖峰
  // v22 新常态跟随（2026-08-31 f57 用户实锤「上面还是 0.5 上边界」）：p95 天然忽略最高
  // 5% 的点——7h 空闲后突然持续 1.2 核要攒够 5% 才抬高坐标，期间曲线贴顶成平线。
  // 最近 5 点均值 × 1.5 参与上界：持续 ≥5 分钟的升高立即反映（1.25×1.5≈1.9 → 坐标 ~2.0），
  // 单点瞬时尖峰被均值摊平不拉高（p95 想防的就是这个）。
  function cpuYDomain(use) {
    var i, vals = [], max = 0.5;
    if (use.length >= 5) {
      for (i = 0; i < use.length; i++) vals.push(use[i].cu);
      vals.sort(function (a, b) { return a - b; });
      max = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
      var n = use.length;
      var tail = Math.min(5, n);
      var s = 0;
      for (i = n - tail; i < n; i++) s += use[i].cu;
      var tailAvg = s / tail;
      if (tailAvg * 1.5 > max) max = tailAvg * 1.5;
    } else {
      for (i = 0; i < use.length; i++) { if (use[i].cu > max) max = use[i].cu; }
    }
    max = Math.min(max * 1.08, latest.ncpu || 64); // 8% 顶余量 + 顶封 ncpu
    if (max < 0.5) max = 0.5;
    return { min: 0, max: max };
  }

  // ── 通用曲线绘制（x 轴 = 运行时长坐标；断档分段但断档不占宽；span 参数 = 本图弹性窗口） ──
  function drawChart(use, runTArr, dom, o, spanMs) {
    // o: {poly,area,dot,dotPulse,curVal,ylbl,grid,valOf,fmt}
    var min = dom.min, max = dom.max, range = max - min;
    var step = plotW / (spanMs / 60000); // px per 运行分钟（弹性，恒铺满）
    var totalRun = runTArr[runTArr.length - 1];
    function xAt(rt) { return W - PAD_R - (totalRun - rt) / 60000 * step; }
    function yAt(v) { if (v > max) v = max; if (v < min) v = min; return PLOT_H - PAD_B - (v - min) / range * plotH; }
    // y 轴刻度
    if (o.ylbl) {
      o.ylbl[0].textContent = o.fmt(max);
      o.ylbl[1].textContent = o.fmt((max + min) / 2);
      o.ylbl[2].textContent = o.fmt(min);
    }
    var line = [], areaPts = [];
    var segStart = 0;
    function closeSeg(a, b) {
      if (b < a) return;
      var i, x, y, p;
      areaPts.push(xAt(runTArr[a]).toFixed(1) + ',' + (PLOT_H - PAD_B));
      for (i = a; i <= b; i++) {
        x = xAt(runTArr[i]); y = yAt(o.valOf(use[i]));
        p = x.toFixed(1) + ',' + y.toFixed(1);
        line.push(p);
        areaPts.push(p);
      }
      areaPts.push(xAt(runTArr[b]).toFixed(1) + ',' + (PLOT_H - PAD_B));
    }
    for (var i = 1; i < use.length; i++) {
      if (use[i].t - use[i - 1].t > GAP_MS) { closeSeg(segStart, i - 1); segStart = i; }
    }
    closeSeg(segStart, use.length - 1);
    o.poly.setAttribute('points', line.join(' '));
    o.area.setAttribute('points', areaPts.join(' '));
    // 尾点脉冲
    var lx = xAt(runTArr[use.length - 1]), ly = yAt(o.valOf(use[use.length - 1]));
    o.dot.setAttribute('cx', lx.toFixed(1));
    o.dot.setAttribute('cy', ly.toFixed(1));
    o.dotPulse.setAttribute('cx', lx.toFixed(1));
    o.dotPulse.setAttribute('cy', ly.toFixed(1));
    // 最新点值标签
    var curTxt = o.fmt(o.valOf(use[use.length - 1]));
    var tx = lx - 6, anchor = 'end';
    if (tx < PAD_L + 32) { tx = lx + 6; anchor = 'start'; }
    o.curVal.setAttribute('x', tx.toFixed(1));
    o.curVal.setAttribute('y', (ly - 5).toFixed(1));
    o.curVal.setAttribute('text-anchor', anchor);
    o.curVal.textContent = curTxt;
  }

  function clearChart(o) {
    o.poly.setAttribute('points', '');
    o.area.setAttribute('points', '');
    o.dot.setAttribute('cx', W - PAD_R); o.dot.setAttribute('cy', PLOT_H - PAD_B);
    o.dotPulse.setAttribute('cx', W - PAD_R); o.dotPulse.setAttribute('cy', PLOT_H - PAD_B);
    o.curVal.textContent = '';
    if (o.ylbl) {
      for (var yi = 0; yi < 3; yi++) o.ylbl[yi].textContent = '--';
    }
  }

  // 重启垂线（boot 在断档内 → 落在断档起点，即两段衔接处；连续区间线性插值；per-stream）
  function bootRunT(bt, useArr, runTArr) {
    if (!useArr.length) return 0;
    var i = 0;
    while (i < useArr.length && useArr[i].t < bt) i++;
    if (i === 0) return 0;
    if (i >= useArr.length) return runTArr[runTArr.length - 1];
    var g = useArr[i].t - useArr[i - 1].t;
    if (g > GAP_MS) return runTArr[i - 1];
    var f = Math.min(1, Math.max(0, (bt - useArr[i - 1].t) / g));
    return runTArr[i - 1] + (runTArr[i] - runTArr[i - 1]) * f;
  }

  // 两图各自换算（mem/cpu 独立 span——cpu reset 后窗口与 mem 不同步）
  function drawBoots() {
    var now = Date.now(), i, mb = '', cb = '';
    if (memPts.length) {
      var span = spanOf(memPts, memRunT);
      var step = plotW / (span / 60000);
      var totalRun = memRunT[memRunT.length - 1];
      for (i = 0; i < boots.length; i++) {
        if (boots[i] <= memPts[0].t || boots[i] > now) continue;
        var x = W - PAD_R - (totalRun - bootRunT(boots[i], memPts, memRunT)) / 60000 * step;
        mb += 'M' + x.toFixed(1) + ' ' + PAD_T + ' V ' + (PLOT_H - PAD_B);
      }
    }
    if (cpuPts.length) {
      var cspan = spanOf(cpuPts, cpuRunT);
      var cstep = plotW / (cspan / 60000);
      var ctotalRun = cpuRunT[cpuRunT.length - 1];
      for (i = 0; i < boots.length; i++) {
        if (boots[i] <= cpuPts[0].t || boots[i] > now) continue;
        var cx = W - PAD_R - (ctotalRun - bootRunT(boots[i], cpuPts, cpuRunT)) / 60000 * cstep;
        cb += 'M' + cx.toFixed(1) + ' ' + PAD_T + ' V ' + (PLOT_H - PAD_B);
      }
    }
    if ($bootPath) $bootPath.setAttribute('d', mb);
    if ($cBootPath) $cBootPath.setAttribute('d', cb);
  }

  // ── 峰值/谷值辅助 ──
  // 峰值/谷值时间戳带日期：[MM-DD HH:MM]（简介行空间增大后定案）
  function hmd(ms) {
    var d = new Date(ms);
    return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // ── CPU 段独立渲染（v18: mem reset 后 CPU 图/统计/均值完全不受影响——旧 n<2 分支连带清 CPU 显示，用户实锤「内存一重置 CPU 也被重置」）──
  function renderCpuCurve() {
    if (cpuPts.length >= 2) {
      buildRunT(cpuPts, cpuRunT);
      var cdom = cpuYDomain(cpuPts);
      drawChart(cpuPts, cpuRunT, cdom, {
        poly: $cPoly, area: $cArea, dot: $cDot, dotPulse: $cDotPulse, curVal: $cCurVal, ylbl: $cGrid._ylbl,
        valOf: function (p) { return p.cu; }, fmt: fmtCores
      }, spanOf(cpuPts, cpuRunT));
      var cpi = 0, cvi = 0, i;
      for (i = 1; i < cpuPts.length; i++) {
        if (cpuPts[i].cu > cpuPts[cpi].cu) cpi = i;
        if (cpuPts[i].cu < cpuPts[cvi].cu) cvi = i;
      }
      $cStats.innerHTML = '<span>峰值 ' + fmtCores(cpuPts[cpi].cu) + '<i class="qqq-mem-hover-tip">[' + hmd(cpuPts[cpi].t) + ']</i></span>' +
        '<span>谷值 ' + fmtCores(cpuPts[cvi].cu) + '<i class="qqq-mem-hover-tip">[' + hmd(cpuPts[cvi].t) + ']</i></span>';
      var s = 0;
      for (i = 0; i < cpuPts.length; i++) s += cpuPts[i].cu;
      var cSpanMin = Math.round(cpuRunT[cpuRunT.length - 1] / 60000); // CPU 窗口 = CPU 流运行时长（独立 reset 后各自窗口）
      $cAvg.innerHTML = '<span>' + (cSpanMin >= 1440 ? '24h 均占 ' : spanTxt(cSpanMin) + ' 均占 ') + '</span><b>' + fmtCores(s / cpuPts.length) + '</b>';
    } else {
      clearChart({ poly: $cPoly, area: $cArea, dot: $cDot, dotPulse: $cDotPulse, curVal: $cCurVal, ylbl: $cGrid._ylbl });
      $cStats.textContent = '采样中…';
      $cAvg.textContent = '--';
    }
  }

  // ── 全量渲染（双图 + 统计 + 徽章 + 刻度） ──
  function renderCurve() {
    var n = memPts.length;
    if (!shown) return;
    buildRunT(memPts, memRunT);
    if (n < 2) {
      // v18: 只清 MEM 段——旧实现连 CPU 图/统计/均值一起清（mem reset 后 CPU 显示被连带重置，用户实锤「内存一重置 CPU 也被重置」）
      clearChart({ poly: $poly, area: $area, dot: $dot, dotPulse: $dotPulse, curVal: $curVal, ylbl: $grid._ylbl });
      if ($bootPath) $bootPath.setAttribute('d', '');
      $stats.textContent = n === 0 ? '采样中 · 每 60s 一个点' : '采样中…';
      $avg.textContent = '--';
      if ($avg) $avg.classList.remove('hot'); // 曲线清空时红态同步复位
      avgWasOver = false; // 边沿复位：重新累积后再超限可再弹
      drawBoots();      // 垂线按流各自换算（mem 空则只画 cpu 垂线）
      renderCpuCurve(); // CPU 段独立渲染，mem reset 毫发无损
      return;
    }
    // MEM 图（独立弹性窗口）
    var memSpan = spanOf(memPts, memRunT);
    var dom = memYDomain(memPts);
    drawChart(memPts, memRunT, dom, {
      poly: $poly, area: $area, dot: $dot, dotPulse: $dotPulse, curVal: $curVal, ylbl: $grid._ylbl,
      valOf: function (p) { return p.v; }, fmt: fmtVal
    }, memSpan);
    // CPU 段独立渲染（图 + 统计 + 均值徽章一体——v18 抽出 renderCpuCurve，与 MEM 段完全解耦）
    renderCpuCurve();
    // 重启垂线（两图各自换算）
    drawBoots();
    // 峰值/谷值 + 已启动 + 均值徽章 + 刻度
    var now = Date.now(), i;
    var spanMin = Math.round(memRunT[memRunT.length - 1] / 60000); // ★ 窗口 = 运行时长（mem 主曲线）
    // MEM stats
    var peakI = 0, valleyI = 0;
    for (i = 1; i < n; i++) {
      if (memPts[i].v > memPts[peakI].v) peakI = i;
      if (memPts[i].v < memPts[valleyI].v) valleyI = i;
    }
    renderUpText();
    $stats.innerHTML =
      '<span>峰值 ' + fmtVal(memPts[peakI].v) + '<i class="qqq-mem-hover-tip">[' + hmd(memPts[peakI].t) + ']</i></span>' +
      '<span>谷值 ' + fmtVal(memPts[valleyI].v) + '<i class="qqq-mem-hover-tip">[' + hmd(memPts[valleyI].t) + ']</i></span>';
    // CPU stats/均值 → renderCpuCurve() 内（v18 抽出，防 mem reset 连带清空）
    // MEM 均值徽章（抗尖峰口径；窗口 = 运行时长）
    var avg = computeAvg();
    $avg.innerHTML = '<span>' + (spanMin >= 1440 ? '24h 均值 ' : spanTxt(spanMin) + ' 均值 ') + '</span><b>' + avg + 'M</b>';
    checkAvgThreshold(avg);
    // CPU 均值徽章 → renderCpuCurve() 内（v18 抽出）
    // 动态刻度（弹性：span < 24h 时按实际跨度标注左/中，> 24h 固定 -24h/-12h）——运行时长语义
    if ($labels._mid) {
      var lt, mt;
      if (spanMin >= 1440) { lt = '-24h'; mt = '-12h'; }
      else { lt = '-' + spanTxt(spanMin); mt = '-' + spanTxt(Math.round(spanMin / 2)); }
      $labels._left.textContent = lt;
      $labels._mid.textContent = mt;
      if ($cLabels._mid) {
        $cLabels._left.textContent = lt;
        $cLabels._mid.textContent = mt;
      }
    }
  }

  // ── 进程列表渲染（树序：root 首行加粗，后代缩进；三列：名称/内存 MB/累计 CPU 时间） ──
  function renderRows() {
    if (!shown || !$plist) return;
    if (!rows.length) {
      $plist.innerHTML = '<div class="qqq-mem-hover-prow muted">采样中…</div>';
      return;
    }
    var lvl = {};
    var byPid = {};
    var i, r;
    for (i = 0; i < rows.length; i++) { byPid[rows[i].pid] = rows[i]; }
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      var d = 0, p = r.ppid;
      while (p && byPid[p] && d < 6) { d++; p = byPid[p].ppid; }
      lvl[r.pid] = d;
    }
    var html = '';
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      var name = (r.n && r.n.length ? r.n : 'pid ' + r.pid);
      var mb = Math.max(1, Math.round(r.ws / 1024));
      html += '<div class="qqq-mem-hover-prow' + (i === 0 ? ' root' : '') + '">' +
        '<span class="qqq-mem-hover-pname" style="padding-left:' + (lvl[r.pid] * 12) + 'px">' + name + '</span>' +
        '<span class="qqq-mem-hover-pmb">' + mb + ' MB</span>' +
        '<span class="qqq-mem-hover-pcpu">' + fmtRowTime(r.cs) + '</span></div>';
    }
    $plist.innerHTML = html;
  }

  // ── 均值（mem 抗尖峰口径：>4×中位数尖峰不参与，防 1041M 型失真） ──
  function computeAvg() {
    var n = memPts.length, i, p, sum = 0, cnt = 0;
    if (!n) return 0;
    var vals = [];
    for (i = 0; i < n; i++) vals.push(memPts[i].v);
    vals.sort(function (a, b) { return a - b; });
    var med = vals[Math.floor(n / 2)];
    var capLo = med / 4, capHi = med * 4;
    for (i = 0; i < n; i++) {
      p = memPts[i].v;
      if (p >= capLo && p <= capHi) { sum += p; cnt++; }
    }
    return cnt ? Math.round(sum / cnt) : Math.round(sum / n);
  }

  // 当前值 3 点平滑 > 1.5GB → 暴涨告警 qoast（边沿触发 + 1h 冷却）
  // 2026-08-31 补档：原设计只盯均值（556M<1G 不触发），当前值 1300MB 暴涨无提醒（用户实锤）
  var curSmooth = [];
  var curOver = false;
  var curQoastAt = 0;
  function checkCurThreshold() {
    if (!latest.mb) return;
    curSmooth.push(latest.mb);
    if (curSmooth.length > 3) curSmooth.shift();
    var s = 0;
    for (var i = 0; i < curSmooth.length; i++) s += curSmooth[i];
    var avg = s / curSmooth.length;
    var over = avg > 1536; // 1.5GB（dev 常态 1.3G 不误报，异常暴涨才触发——本次峰值 1570MB 恰好命中）
    if (over && !curOver && Date.now() - curQoastAt > 3600000) {
      curQoastAt = Date.now();
      curOver = true;
      var msg = '独立启动包：' + (latest.label || 'qqqide') + ' 当前总内存（含一切子进程）达 ' + Math.round(avg) + ' MB';
      if (window.qqqideQoast) {
        // v22: 常规自动消失（默认 9s）——用户定案「不要常驻，自动消失滴常规滴那种」
        window.qqqideQoast.show(msg, { type: 'warning' });
      } else {
        console.warn('[mem-hover]', msg);
      }
    }
    if (!over) curOver = false;
  }

  // 均值 > 1GB → MEM 徽章主题色转红 + 触发点弹 qoast（边沿触发 + 1h 冷却）
  function checkAvgThreshold(avg) {
    var over = avg > 1024; // 1GB
    if ($avg) $avg.classList.toggle('hot', over);
    if (over && !avgWasOver && Date.now() - avgQoastAt > 3600000) {
      avgQoastAt = Date.now();
      avgWasOver = true;
      var msg = '独立启动包：' + (latest.label || 'qqqide') + ' 当前总内存（含一切子进程）均值占用超 1g';
      if (window.qqqideQoast) {
        // v22: 常规自动消失（默认 9s）——与暴涨档同款，用户定案不要常驻
        window.qqqideQoast.show(msg, { type: 'warning' });
      } else {
        console.warn('[mem-hover]', msg);
      }
    }
    if (!over) avgWasOver = false;
  }

  // ── 数据接入 ──
  function onMetrics(m) {
    if (!m) return;
    if (typeof m.mb === 'number' && m.mb > 0) {
      latest.mb = m.mb;
      if ($val) $val.textContent = m.mb;
      $memVal.textContent = m.mb + ' MB';
      checkCurThreshold(); // 每次 5s 广播检查当前值暴涨（均值阈值是曲线点粒度 60s）
    }
    if (typeof m.bootAt === 'number' && m.bootAt > 0) latest.bootAt = m.bootAt;
    if (typeof m.procs === 'number') {
      latest.procs = m.procs;
      updateProcsText();
    }
    if (typeof m.ncpu === 'number' && m.ncpu > 0) latest.ncpu = m.ncpu;
    if (m.cpu && typeof m.cpu.cores === 'number') {
      latest.cores = m.cpu.cores;
      coresSmooth.push(m.cpu.cores);
      if (coresSmooth.length > 3) coresSmooth.shift();
      $cpuVal.textContent = 'CPU ' + fmtCores(smoothCores());
    }
    if (m.cpu && typeof m.cpu.totalSec === 'number') {
      latest.totalSec = m.cpu.totalSec;
      if ($cVal) $cVal.textContent = fmtCpuTime(m.cpu.totalSec);
    }
    if (Array.isArray(m.rows) && m.rows.length) {
      rows = m.rows;
      renderRows();
    }
    if (m.pt && typeof m.pt.t === 'number' && typeof m.pt.v === 'number' && m.pt.t > lastMemT) {
      lastMemT = m.pt.t;
      memPts.push({ t: m.pt.t, v: m.pt.v, n: m.pt.n });
      trimMemPts();
      if (typeof m.pt.cu === 'number' && m.pt.t > lastCpuT) { // cpu 流独立去重（独立 reset 后 ts 可能回跳）
        lastCpuT = m.pt.t;
        cpuPts.push({ t: m.pt.t, cu: m.pt.cu });
        trimCpuPts();
      }
      renderCurve();
      updateProcsText();
      checkAvgThreshold(computeAvg()); // 均值变化即查阈值（不依赖 hover）
    }
    if (typeof m.label === 'string' && m.label) latest.label = m.label;
    renderUpText(); // 5s 广播同步刷新 q 行已启动
  }

  bridge.mem.onMetrics(onMetrics);
  if (bridge.mem.getMetrics) {
    bridge.mem.getMetrics().then(onMetrics).catch(function () { /* 静默 */ });
  }
  if (bridge.mem.history) {
    bridge.mem.history().then(function (h) {
      if (!h || !h.memPts || !h.memPts.length) return; // v10: F42 主进程改返 memPts/cpuPts 双流后旧守卫 h.pts 恒真 → 历史永不合并 → 重启后曲线空等 2 个 live 点（~1-2min）才出现，用户实锤「启动后一分钟没曲线」
      if (Array.isArray(h.boots)) boots = h.boots;
      if (h.bootAt > 0) latest.bootAt = h.bootAt;
      // mem 流（h.memPts）
      var seen = {}, i;
      for (i = 0; i < memPts.length; i++) seen[memPts[i].t] = 1;
      for (i = 0; i < (h.memPts || []).length; i++) {
        if (!seen[h.memPts[i].t]) {
          memPts.push({ t: h.memPts[i].t, v: h.memPts[i].v, n: h.memPts[i].n });
        }
      }
      memPts.sort(function (a, b) { return a.t - b.t; });
      memPts = memPts.slice(-CURVE_CAP);
      trimMemPts();
      if (memPts.length) lastMemT = memPts[memPts.length - 1].t;
      // cpu 流（h.cpuPts，独立去重）
      var cseen = {}, j;
      for (j = 0; j < cpuPts.length; j++) cseen[cpuPts[j].t] = 1;
      for (j = 0; j < (h.cpuPts || []).length; j++) {
        if (!cseen[h.cpuPts[j].t]) {
          cpuPts.push({ t: h.cpuPts[j].t, cu: h.cpuPts[j].cu });
        }
      }
      cpuPts.sort(function (a, b) { return a.t - b.t; });
      cpuPts = cpuPts.slice(-CURVE_CAP);
      trimCpuPts();
      if (cpuPts.length) lastCpuT = cpuPts[cpuPts.length - 1].t;
      if (!latest.mb && h.mb) { latest.mb = h.mb; if ($val) $val.textContent = h.mb; }
      if (!latest.procs && h.procs) latest.procs = h.procs;
      if (typeof h.ncpu === 'number' && h.ncpu > 0) latest.ncpu = h.ncpu;
      if (h.cpu && typeof h.cpu.cores === 'number' && !coresSmooth.length) {
        latest.cores = h.cpu.cores;
        coresSmooth.push(h.cpu.cores);
        $cpuVal.textContent = 'CPU ' + fmtCores(smoothCores());
      }
      if (h.cpu && typeof h.cpu.totalSec === 'number' && !latest.totalSec) {
        latest.totalSec = h.cpu.totalSec;
        if ($cVal) $cVal.textContent = fmtCpuTime(h.cpu.totalSec);
      }
      if (h.label) latest.label = h.label;
      if (!rows.length && Array.isArray(h.rows) && h.rows.length) { rows = h.rows; renderRows(); }
      updateProcsText();
      renderCurve();
      checkAvgThreshold(computeAvg()); // 历史加载后同样查阈值
    }).catch(function () { /* 静默 */ });
  }

  // ── reset 按钮 ×2（v7 定案：MEM 区 / CPU 区各一个，各自清各自曲线互不影响）──
  // scope: 'mem' 清内存曲线+垂线 / 'cpu' 清 CPU 曲线+平滑窗 / 'all' 全清（旧调用兼容）
  function resetLocal(scope) {
    if (scope === 'cpu') {
      cpuPts = [];
      lastCpuT = -1;
      coresSmooth = []; // 瞬时核数平滑窗同步清（cpu 显示从零重来）
    } else if (scope === 'mem') {
      memPts = [];
      boots = []; // 垂线挂 mem 流生命周期
      lastMemT = -1;
    } else { // 'all' / 旧版无参
      memPts = [];
      cpuPts = [];
      boots = [];
      lastMemT = -1;
      lastCpuT = -1;
      coresSmooth = [];
    }
    updateProcsText();
    renderCurve();
  }
   // 峰值/谷值 hover 时间戳（自定义瞬间弹出；事件委托挂容器——innerHTML 每 60s 重建子元素，委托天然存活）
  // v16 修复：tip 是 pointer-events:none + opacity:0 纯展示元素，鼠标事件永远命中不了它 →
  // 旧判定 e.target.classList.contains('qqq-mem-hover-tip') 恒假 → tip 永不显示（用户实锤）。
  // 改为命中「包含 tip 的 span」——hover 峰值/谷值文字整块即显示。
  function wireStatsTip(row) {
    if (!row || row.__qqqStatsTip) return;
    row.__qqqStatsTip = true;
    row.addEventListener('mouseover', function (e) {
      var t = e.target;
      var sp = (t && t.closest) ? t.closest('span') : null;
      if (sp && sp.querySelector('.qqq-mem-hover-tip')) sp.classList.add('qqq-tip-show');
    });
    // v18: tip 跟随光标（默认恒在光标下方 12px；近面板底缘自动翻到上方防出界；水平钳制面板内）
    row.addEventListener('mousemove', function (e) {
      var t = e.target;
      var sp = (t && t.closest) ? t.closest('span') : null;
      if (!sp) return;
      var tip = sp.querySelector('.qqq-mem-hover-tip');
      if (!tip) return;
      var rc = row.getBoundingClientRect();
      var pr = $panel.getBoundingClientRect();
      var tipH = tip.offsetHeight, tipW = tip.offsetWidth;
      var top = (e.clientY - rc.top) + 12;
      if (e.clientY + 12 + tipH > pr.bottom - 4) top = (e.clientY - tipH - 8) - rc.top;
      if (top < (pr.top - rc.top) + 4) top = (pr.top - rc.top) + 4;
      var x = e.clientX - rc.left;
      if (x < tipW / 2 + 4) x = tipW / 2 + 4;
      if (x > rc.width - tipW / 2 - 4) x = rc.width - tipW / 2 - 4;
      tip.style.left = x + 'px';
      tip.style.top = top + 'px';
    });
    row.addEventListener('mouseout', function (e) {
      var t = e.target;
      var sp = (t && t.closest) ? t.closest('span') : null;
      if (sp && sp.querySelector('.qqq-mem-hover-tip') && (!e.relatedTarget || !sp.contains(e.relatedTarget))) {
        sp.classList.remove('qqq-tip-show');
      }
    });
  }
  function wireReset() {
    var $resets = $panel.querySelectorAll('.qqq-mem-hover-reset');
    if (!$resets.length || !bridge.mem.reset) return;
    for (var i = 0; i < $resets.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var sc = btn.getAttribute('data-scope') || 'all';
          try {
            bridge.mem.reset(sc).then(function () { resetLocal(sc); }).catch(function () { /* 静默 */ });
          } catch (err) { /* 静默 */ }
        });
      })($resets[i]);
    }
  }
  if (bridge.mem.onReset) bridge.mem.onReset(function (scope) { resetLocal(scope || 'all'); });

  // ── 进程数显示：当前 N 进程（窗口内峰值 M 进程）——峰值 = max(曲线点 n, 当前瞬时) ──
  function peakProcs() {
    var mx = latest.procs;
    for (var i = 0; i < memPts.length; i++) {
      if (memPts[i].n && memPts[i].n > mx) mx = memPts[i].n;
    }
    return mx;
  }
  function updateProcsText() {
    if (!$procs) return;
    var cur = latest.procs;
    var pk = peakProcs();
    $procs.textContent = (pk > cur) ? (cur + '（峰值' + pk + '）进程') : (cur + ' 进程');
  }

  // 已启动时长（q 行右侧；5s 广播同步刷新）
  // v19 格式定案：■已启动 10min——方块与「已启动」零空格，已启动与时长之间一个空格（用户定案）
  function renderUpText() {
    if (!$phUp) return;
    $phUp.textContent = latest.bootAt > 0 ?
      '\u3000\u25A0已启动 ' + uptimeTxt(Math.max(0, Math.round((Date.now() - latest.bootAt) / 60000))) : '';
  }

  // 3 点移动平均（瞬时核数平滑；无基线返回 null）
  function smoothCores() {
    if (!coresSmooth.length) return null;
    var s = 0;
    for (var i = 0; i < coresSmooth.length; i++) s += coresSmooth[i];
    return s / coresSmooth.length;
  }

  // 标签元素缓存（renderCurve 动态改刻度文案）
  if ($labels) {
    $labels._left = $labels.querySelector('text');
    $labels._mid = $labels.querySelector('.qqq-mem-lbl-mid');
  }
  if ($cLabels) {
    $cLabels._left = $cLabels.querySelector('text');
    $cLabels._mid = $cLabels.querySelector('.qqq-cpu-lbl-mid');
  }

  // ── 交互（状态区 a 区域：hover 即弹 / 点击固定 / 点卡外任意区域关闭） ──
  $mem.addEventListener('mouseenter', show);
  $mem.addEventListener('mouseleave', hideSoon);
  $mem.addEventListener('click', function () {
    if (!pinned) {
      pinned = true;
      ensurePanel();
      $panel.classList.add('qqq-mem-hover-pinned');
      show();
    } else {
      pinned = false;
      $panel.classList.remove('qqq-mem-hover-pinned');
      hide();
    }
  });
  // 点击卡片外任何区域 = 关闭卡片（取消固定 + 立即隐藏）；卡片内滚动/a 区域自身除外
  // 三面板/编辑器/goods/roam 均为独立 iframe document，主窗口 document click 收不到 iframe
  // 内部点击 → 逐 iframe 绑定点击（load 重绑覆盖导航新 document，MutationObserver 覆盖
  // 动态新建；同源 qqqide-webapp:// 全绑定，跨域 try-catch 静默跳过）
  function closeByOutsideClick() {
    if (!shown) return;
    pinned = false;
    if ($panel) $panel.classList.remove('qqq-mem-hover-pinned');
    hide();
  }
  document.addEventListener('click', function (e) {
    if (!shown) return;
    var t = e.target;
    if ($panel && $panel.contains(t)) return;
    if ($mem && (t === $mem || $mem.contains(t))) return;
    closeByOutsideClick();
  });
  function bindFrameClick(f) {
    var doc;
    try { doc = f.contentDocument; } catch (err) { return; } // 跨域 iframe 尽力而为
    if (!doc || doc.__qqqMemBound) return;
    doc.__qqqMemBound = true; // 标记挂 document：iframe 导航后是新 doc → load 重绑自然生效
    doc.addEventListener('click', closeByOutsideClick, true);
  }
  function hookFrames() {
    var fs = document.querySelectorAll('iframe');
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i];
      if (!f.__qqqMemLoadHooked) {
        f.__qqqMemLoadHooked = true;
        f.addEventListener('load', function () { bindFrameClick(this); });
      }
      bindFrameClick(f);
    }
  }
  hookFrames();
  if (document.body) {
    new MutationObserver(hookFrames).observe(document.body, { childList: true, subtree: true });
  }
  // 窗口 resize / 滚动时跟随定位
  window.addEventListener('resize', function () { if (shown) position(); });
  // dense 退避隐藏状态区 a 区域 → 面板同步消失（pinned 状态保留，恢复时重新弹出）
  var area = document.querySelector('.qqq-status-area');
  if (area) {
    new MutationObserver(function () {
      if (shown && $mem.offsetParent === null) {
        $panel.classList.remove('qqq-mem-hover-show');
        shown = false;
      }
      else if (shown) position();
    }).observe(area, { attributes: true, attributeFilter: ['class'] });
  }
})();
