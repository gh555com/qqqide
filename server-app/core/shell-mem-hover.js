// shell-mem-hover.js — 启动包内存 24h 曲线 hover 面板（2026-08-29 v4：均值徽章 + 进程列表 + 弹性曲线）
// 数据源: 主进程 mem-meter 真理机器（qqqide:mem:history 首拉全量 + qqqide:mem:metrics 增量广播）
// 唯一值口径 = 专用工作集 Private WS（任务管理器「内存」列同口径，三值合一，F13 定案）
// 统计来源: 主进程每 5s 经 py-broker 调 NtQuerySystemInformation（Windows 内核原生 API，
//   ~7.5ms/次）→ 启动包进程树（主进程+全部后代递归）Σ 专用工作集——本面板所有数字
//   与任务管理器逐字节同源。进程列表 = 快照 rows 原样透传，零额外查询零额外 API。
// 曲线 = 60s 一点 × 1440 点（24h），主进程环形缓冲 + 持久化 mem-curve.log，跨重启连续。
// v5 弹性曲线: 数据窗口 span = now - 首点（真实跨度，仅防除零）→ 曲线恒铺满全宽从
//   左缘开始走，随运行 span 逐渐拉伸到 24h 后固定刻度（先填满再改刻度，用户定案）。
//   v5 修复: MIN_SPAN 5min 钳制曾致数据 3min 时曲线只画 3/5 宽起点落中间（q209 截图实锤）。
// v5 y 轴: 左缘刻度区（PAD_L）3 条网格线标注 max/mid/min 值；最新点旁 halo 标签打当前值。
// v5 面板: 固定高度 450px flex 布局（进程区 flex:1 恒高，不再随内容自动扩大）。
// v5 滚动条: 统一 IDE 风格 5px（a 等级弹窗/在线人数弹窗同款）。
// v4 均值: 右上徽章显示当前窗口（未满 24h 显示实际跨度）均值，满 24h 即「24h 均值」。
// v4 进程列表: 树序（主进程 + 后代），每项专用工作集 MB，名称取 NtQuery ImageName。
// 交互: 瞬间弹出（零延迟 100ms 过渡），pointer-events:none 纯展示防闪烁，
//       350ms 延迟隐藏；dense-3 隐藏状态栏元素时同步消失
(function () {
  'use strict';
  var $mem = document.getElementById('qqq-status-mem');
  var bridge = window.qqqideBridge;
  if (!$mem || !bridge || !bridge.mem) return;

  var CURVE_CAP = 1440;
  var W = 340, H = 118, PLOT_H = 108; // SVG 尺寸
  var PAD_L = 34, PAD_R = 6, PAD_T = 6, PAD_B = 6; // 左= y 轴刻度区，其余边距
  var plotW = W - PAD_L - PAD_R;   // 300 曲线区宽
  var plotH = PLOT_H - PAD_T - PAD_B; // 96 曲线区高
  var PANEL_H = 450; // 固定面板高（flex 布局，进程区撑满，恒不自动扩大）
  var pts = [];          // 有序曲线点 [{t,v}]（旧→新），上限 1440，超 24h 修剪
  var latest = { mb: 0, procs: 0, bootAt: 0, label: '' }; // v10: bootAt；v12: label = 启动包标识（qoast 文案）
  var rows = [];         // 最近快照进程树 [{pid,ppid,ws,n}]（树序）
  var lastPtT = -1;      // 最近已收曲线点 ts（单调去重，环形索引会回绕禁作 key）
  var $panel = null, $svg = null, $poly = null, $area = null, $dot = null, $dotPulse = null;
  var $val = null, $procs = null, $avg = null, $stats = null, $grid = null, $labels = null;
  var $curVal = null, $plist = null, $bootPath = null;
  var boots = []; // v7: 重启标记（主进程 mem-curve.log {boot:ts}）→ 曲线浅白虚线垂线
  var hideTimer = null, shown = false;
  var pinned = false; // v6: 点击状态区内存块固定面板（可交互滚动进程列表），再点取消
  var gridBuilt = false;
  var avgWasOver = false; // v12: 均值超 1GB 边沿触发（恢复后再次超限才再弹）
  var avgQoastAt = 0;    // v12: 上次弹 qoast 时刻（1h 冷却防刷屏）

  // ── 面板 DOM（一次性构建，惰性） ──
  function ensurePanel() {
    if ($panel) return;
    $panel = document.createElement('div');
    $panel.className = 'qqq-mem-hover';
    $panel.id = 'qqq-mem-hover';
    $panel.innerHTML =
      '<div class="qqq-mem-hover-head">' +
      '<span class="qqq-mem-hover-title">MEM<span class="qqq-mem-hover-dot"></span><span class="qqq-mem-hover-procs">--</span></span>' +
      '<button class="qqq-mem-hover-reset" title="清除曲线历史，从零重记（删 mem-curve.log）">reset</button>' +
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
      '<div class="qqq-mem-hover-plist-head">进程 · qqqide工作集</div>' +
      '<div class="qqq-mem-hover-plist"></div>';
    document.body.appendChild($panel);
    $svg = $panel.querySelector('svg');
    $poly = $panel.querySelector('.qqq-mem-line');
    $area = $panel.querySelector('.qqq-mem-area');
    $dot = $panel.querySelector('.qqq-mem-dot');
    $dotPulse = $panel.querySelector('.qqq-mem-dot-pulse');
    $val = $panel.querySelector('.qqq-mem-hover-val');
    $procs = $panel.querySelector('.qqq-mem-hover-procs');
    $avg = $panel.querySelector('.qqq-mem-hover-avg');
    $stats = $panel.querySelector('.qqq-mem-hover-stats');
    $grid = $panel.querySelector('.qqq-mem-grid');
    $labels = $panel.querySelector('.qqq-mem-labels');
    $curVal = $panel.querySelector('.qqq-mem-curval');
    $plist = $panel.querySelector('.qqq-mem-hover-plist');
    $bootPath = $panel.querySelector('.qqq-mem-bootline');
    buildFrame();
    wireReset();
  }

  // 网格（3 条水平线）+ y 轴刻度文本 + 时间刻度（一次性；刻度文案每次 renderCurve 动态刷新）
  function buildFrame() {
    if (gridBuilt) return;
    gridBuilt = true;
    var g = '', gy, i;
    for (i = 0; i < 3; i++) {
      gy = PAD_T + plotH * i / 2;
      g += '<line x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) + '"/>';
    }
    // v9: max/mid 各下移 2px（用户定案，min 不动）——刻度贴网格线下方更顺眼
    g += '<text class="qqq-mem-ylbl" x="2" y="' + (PAD_T + 5) + '">--</text>' +
      '<text class="qqq-mem-ylbl" x="2" y="' + (PAD_T + plotH / 2 + 5) + '">--</text>' +
      '<text class="qqq-mem-ylbl" x="2" y="' + (PAD_T + plotH + 3) + '">--</text>';
    $grid.innerHTML = g;
    $grid._ylbl = $grid.querySelectorAll('.qqq-mem-ylbl');
    $labels.innerHTML =
      '<text x="' + PAD_L + '" y="' + (H - 3) + '">-24h</text>' +
      '<text class="qqq-mem-lbl-mid" x="' + (PAD_L + plotW / 2) + '" y="' + (H - 3) + '" text-anchor="middle">-12h</text>' +
      '<text x="' + (W - PAD_R) + '" y="' + (H - 3) + '" text-anchor="end">now</text>';
  }

  // 定位：锚定状态栏元素上方右对齐（元素位置变化实时跟随）；空间不足自动下弹
  // v5: 面板固定高度 PANEL_H，不再读 offsetHeight（内容撑开高度变化的根因）
  function position() {
    var r = $mem.getBoundingClientRect();
    var w = 360;
    // v7: 高度取实测 offsetHeight（CSS padding 若 content-box 实际高 466 ≠ PANEL_H 450
    // → 旧计算底部超出 16px 盖住状态区，q209 截图实锤）——间隙同时提到 10px 双保险
    var h = $panel ? $panel.offsetHeight : PANEL_H;
    var x = r.right - w + 4;
    if (x < 4) x = 4;
    var y = r.top - h - 10;
    if (y < 4) y = 4; // v6: 恒上弹不遮状态区——空间不足贴顶，删下弹分支（下弹遮状态区/超屏截断）
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
    } else {
      position();
    }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function hide() {
    if (pinned) return; // v6: 固定中永不隐藏（滚动进程列表/细看曲线）
    if (!shown) return;
    $panel.classList.remove('qqq-mem-hover-show');
    shown = false;
  }

  function hideSoon() {
    if (pinned) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 350);
  }

  // ── 曲线数据维护 ──
  function trimPts() {
    var cut = Date.now() - 24 * 3600 * 1000;
    while (pts.length && pts[0].t < cut) pts.shift();
    while (pts.length > CURVE_CAP) pts.shift();
  }

  function spanTxt(spanMin) {
    if (spanMin >= 1440) return '24h';
    if (spanMin >= 60) {
      var h = Math.round(spanMin / 60), m = spanMin % 60;
      // v9: 紧凑无空格（1h10m）——旧 '1h 10m' 与 '10m' 内间距不一致（用户定案）
      return (h ? h + 'h' : '') + (m ? m + 'm' : '');
    }
    return spanMin + 'min';
  }

  // v10: 已启动时长（主进程 bootAt → now；≥24h 显示整小时）
  function uptimeTxt(min) {
    if (min < 60) return min + 'min';
    var h = Math.floor(min / 60), m = min % 60;
    if (h >= 24) return h + 'h';
    return h + 'h' + (m ? m + 'm' : '');
  }

  // ── 弹性窗口：span = 首点至今（真实跨度）→ 曲线从最左缘开始恒铺满全宽 ──
  function currentSpanMs() {
    if (pts.length < 2) return 60000;
    var span = Date.now() - pts[0].t;
    return span < 1000 ? 1000 : span; // 仅防除零，不钳制（v5: 钳制致曲线起点落中间）
  }

  // ── 曲线渲染（x 轴按真实时间线性右对齐；重启间隙 >3min 断档分段） ──
  function renderCurve() {
    var n = pts.length;
    if (!shown) return;
    if (n < 2) {
      $poly.setAttribute('points', '');
      $area.setAttribute('points', '');
      $dot.setAttribute('cx', W - PAD_R); $dot.setAttribute('cy', PLOT_H - PAD_B);
      $dotPulse.setAttribute('cx', W - PAD_R); $dotPulse.setAttribute('cy', PLOT_H - PAD_B);
      $curVal.textContent = '';
      if ($grid._ylbl) {
        for (var yi = 0; yi < 3; yi++) $grid._ylbl[yi].textContent = '--';
      }
      $stats.textContent = n === 1 ? '采样中 · 每 60s 一个点' : '采样中…';
      $avg.textContent = '--';
      if ($avg) $avg.classList.remove('hot'); // v12: 曲线清空时红态同步复位
      avgWasOver = false; // 边沿复位：重新累积后再超限可再弹
      return;
    }
    var now = Date.now();
    var i, p;
    // v10 抗尖峰坐标（城墙根治）：>4×中位数视为异常尖峰（打包/构建等瞬态重负载），
    // 不参与坐标与均值——曲线不再被单次尖峰压成一条地平线；尖峰仍真实绘制，钳在顶端
    var vals = [];
    for (i = 0; i < n; i++) vals.push(pts[i].v);
    vals.sort(function (a, b) { return a - b; });
    var med = vals[Math.floor(n / 2)];
    var capHi = med * 4, capLo = med / 4;
    // v11: 百分位坐标（565M 墙根治，q209 截图实锤）——重负载期的 ~565M 段
    //   （≈2.3× 中位数，够不着 4× 尖峰阈值）旧算法直接定坐标 max=565M →
    //   常态 240M 曲线被压成 ~15% 高度的地平线「墙」。现取中央 90% 数据
    //   （p5/p95）定坐标：常态波动铺满全图，墙/尖峰钳到顶端仍真实可见。
    var norm = [];
    for (i = 0; i < n; i++) {
      p = pts[i].v;
      if (p >= capLo && p <= capHi) norm.push(p);
    }
    if (!norm.length) norm = [med];
    norm.sort(function (a, b) { return a - b; });
    var min = norm[Math.max(0, Math.floor(norm.length * 0.05))];
    var max = norm[Math.min(norm.length - 1, Math.floor(norm.length * 0.95))];
    if (max === min) max = min + 1; // 全窗口同值兜底
    var head = (max - min) * 0.08; // 顶部 8% 余量：尖峰钳在顶端可见不贴边
    max += head; min -= head;
    var range = max - min;
    var spanMs = currentSpanMs();
    var step = plotW / (spanMs / 60000); // px per minute（弹性，恒铺满）
    var gapMs = 3 * 60000;
    function xAt(t) { return W - PAD_R - (now - t) / 60000 * step; }
    // v10: 超坐标范围的尖峰钳到顶端/底端（SVG 视口内不越界）
    function yAt(v) { if (v > max) v = max; if (v < min) v = min; return PLOT_H - PAD_B - (v - min) / range * plotH; }

    // y 轴刻度（左缘刻度区，随数据 min/max 动态）
    if ($grid._ylbl) {
      $grid._ylbl[0].textContent = Math.round(max) + 'M';
      $grid._ylbl[1].textContent = Math.round((max + min) / 2) + 'M';
      $grid._ylbl[2].textContent = Math.round(min) + 'M';
    }
    var line = [], areaPts = [];
    var segStart = 0;
    for (i = 1; i < n; i++) {
      if (pts[i].t - pts[i - 1].t > gapMs) {
        // 断档：闭合当前段（折线 + 面积子多边形），新段从 i 开始
        closeSeg(line, areaPts, segStart, i - 1, xAt, yAt);
        segStart = i;
      }
    }
    closeSeg(line, areaPts, segStart, n - 1, xAt, yAt);
    $poly.setAttribute('points', line.join(' '));
    $area.setAttribute('points', areaPts.join(' '));

    // 尾点脉冲
    var lx = xAt(pts[n - 1].t), ly = yAt(pts[n - 1].v);
    $dot.setAttribute('cx', lx.toFixed(1));
    $dot.setAttribute('cy', ly.toFixed(1));
    $dotPulse.setAttribute('cx', lx.toFixed(1));
    $dotPulse.setAttribute('cy', ly.toFixed(1));

    // 最新点值标签（halo 描边可压线可读；等于左上角当前值）
    var curTxt = Math.round(pts[n - 1].v) + 'M';
    var tx = lx - 6, anchor = 'end';
    if (tx < PAD_L + 26) { tx = lx + 6; anchor = 'start'; }
    $curVal.setAttribute('x', tx.toFixed(1));
    $curVal.setAttribute('y', (ly - 5).toFixed(1));
    $curVal.setAttribute('text-anchor', anchor);
    $curVal.textContent = curTxt;

    // 峰值/谷值（真实时刻）
    var peakI = 0, valleyI = 0;
    for (i = 1; i < n; i++) {
      if (pts[i].v > pts[peakI].v) peakI = i;
      if (pts[i].v < pts[valleyI].v) valleyI = i;
    }
    function hm(ms) {
      var d = new Date(ms);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    var spanMin = Math.round((now - pts[0].t) / 60000);
    // v9: 趋势行删除（曲线本身已表达变迁，用户定案）——stats 只剩峰值/谷值
    // v10: 峰值/谷值保持真实值（含尖峰）；左侧放「已启动」时长（原趋势行位置，用户定案）
    var peakTxt = '峰值 ' + Math.round(pts[peakI].v) + 'M ' + hm(pts[peakI].t);
    var valleyTxt = '谷值 ' + Math.round(pts[valleyI].v) + 'M ' + hm(pts[valleyI].t);
    var upTxt = latest.bootAt > 0 ? '已启动 ' + uptimeTxt(Math.max(0, Math.round((now - latest.bootAt) / 60000))) : '';
    $stats.innerHTML = (upTxt ? '<span>' + upTxt + '</span>' : '') + '<span>' + peakTxt + '</span><span>' + valleyTxt + '</span>';

    // 均值徽章（右上；窗口跟随实际跨度，满 24h 即「24h 均值」；数字粗体，v7）
    // v10: 均值同为抗尖峰口径（>4×中位数尖峰不参与，防 1041M 型失真）
    // v12: 均值统一走 computeAvg（阈值检查同源，零双实现）
    var avg = computeAvg(capLo, capHi);
    $avg.innerHTML = '<span>' + (spanMin >= 1440 ? '24h 均值 ' : spanTxt(spanMin) + ' 均值 ') + '</span><b>' + avg + 'M</b>';
    checkAvgThreshold(avg);

    // v7: 重启垂线——每次实例启动一根浅白虚线（path 多段一次画完，落在断档空白处）
    if ($bootPath) {
      var bd = '';
      for (i = 0; i < boots.length; i++) {
        if (boots[i] > pts[0].t && boots[i] <= now) {
          bd += 'M' + xAt(boots[i]).toFixed(1) + ' ' + PAD_T + ' V ' + (PLOT_H - PAD_B);
        }
      }
      $bootPath.setAttribute('d', bd);
    }

    // 动态刻度（弹性：span < 24h 时按实际跨度标注左/中，> 24h 固定 -24h/-12h）
    if ($labels._mid) {
      if (spanMin >= 1440) {
        $labels._left.textContent = '-24h';
        $labels._mid.textContent = '-12h';
      } else {
        $labels._left.textContent = '-' + spanTxt(spanMin);
        $labels._mid.textContent = '-' + spanTxt(Math.round(spanMin / 2));
      }
    }
  }

  function closeSeg(line, areaPts, a, b, xAt, yAt) {
    if (b < a) return;
    var i, x, y, p;
    areaPts.push(xAt(pts[a].t).toFixed(1) + ',' + (PLOT_H - PAD_B)); // 段起点基线
    for (i = a; i <= b; i++) {
      x = xAt(pts[i].t); y = yAt(pts[i].v);
      p = x.toFixed(1) + ',' + y.toFixed(1);
      line.push(p);
      areaPts.push(p);
    }
    areaPts.push(xAt(pts[b].t).toFixed(1) + ',' + (PLOT_H - PAD_B)); // 段终点基线
  }

  // ── 进程列表渲染（树序：root 首行加粗，后代按层级缩进） ──
  function renderRows() {
    if (!shown || !$plist) return;
    if (!rows.length) {
      $plist.innerHTML = '<div class="qqq-mem-hover-prow muted">采样中…</div>';
      return;
    }
    // 层级表（root 层级 0）
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
        '<span class="qqq-mem-hover-pmb">' + mb + ' MB</span></div>';
    }
    $plist.innerHTML = html;
  }


  // ── 均值（抗尖峰口径，v12 抽离供阈值检查共用） ──
  function computeAvg(capLo, capHi) {
    var n = pts.length, i, p, sum = 0, cnt = 0;
    if (!n) return 0;
    if (!capLo || !capHi) {
      var vals = [];
      for (i = 0; i < n; i++) vals.push(pts[i].v);
      vals.sort(function (a, b) { return a - b; });
      var med = vals[Math.floor(n / 2)];
      capLo = med / 4; capHi = med * 4;
    }
    for (i = 0; i < n; i++) {
      p = pts[i].v;
      if (p >= capLo && p <= capHi) { sum += p; cnt++; }
    }
    return cnt ? Math.round(sum / cnt) : Math.round(sum / n);
  }

  // v12: 均值 > 1GB → 豆腐块主题色转红 + 触发点弹 qoast（边沿触发 + 1h 冷却）
  function checkAvgThreshold(avg) {
    var over = avg > 1024; // 1GB
    if ($avg) $avg.classList.toggle('hot', over);
    if (over && !avgWasOver && Date.now() - avgQoastAt > 3600000) {
      avgQoastAt = Date.now();
      avgWasOver = true;
      var msg = '独立启动包：' + (latest.label || 'qqqide') + ' 当前滴总内存（含子模块）占用超 1g';
      if (window.qqqideQoast) {
        var q = window.qqqideQoast.show(msg, {
          duration: 0,
          type: 'warning',
          action: { label: '知道了', onClick: function () { try { q.dismiss(); } catch (_) {} } },
        });
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
    }
    if (typeof m.bootAt === 'number' && m.bootAt > 0) latest.bootAt = m.bootAt; // v10
    if (typeof m.procs === 'number') {
      latest.procs = m.procs;
      updateProcsText();
    }
    if (Array.isArray(m.rows) && m.rows.length) {
      rows = m.rows;
      renderRows();
    }
    if (m.pt && typeof m.pt.t === 'number' && typeof m.pt.v === 'number' && m.pt.t > lastPtT) {
      lastPtT = m.pt.t;
      pts.push({ t: m.pt.t, v: m.pt.v, n: m.pt.n });
      trimPts();
      renderCurve();
      updateProcsText();
      checkAvgThreshold(computeAvg()); // v12: 均值变化即查阈值（不依赖 hover）
    }
    if (typeof m.label === 'string' && m.label) latest.label = m.label; // v12
  }

  bridge.mem.onMetrics(onMetrics);
  if (bridge.mem.getMetrics) {
    bridge.mem.getMetrics().then(onMetrics).catch(function () { /* 静默 */ });
  }
  if (bridge.mem.history) {
    bridge.mem.history().then(function (h) {
      // v6 合并语义：与本地已收增量点按 t 去重合并（旧 inited 守卫在首条 5s 广播
      // 先到时丢弃快照 → 持久化历史永不加载 → 曲线只剩 1 点，已修）
      if (!h || !h.pts || !h.pts.length) return;
      if (Array.isArray(h.boots)) boots = h.boots; // v7 重启标记（含本次实例，曲线最右一条）
      if (h.bootAt > 0) latest.bootAt = h.bootAt; // v10 已启动
      var seen = {}, i;
      for (i = 0; i < pts.length; i++) seen[pts[i].t] = 1;
      for (i = 0; i < h.pts.length; i++) {
        if (!seen[h.pts[i].t]) pts.push(h.pts[i]);
      }
      pts.sort(function (a, b) { return a.t - b.t; });
      pts = pts.slice(-CURVE_CAP);
      trimPts();
      if (pts.length) lastPtT = pts[pts.length - 1].t;
      if (!latest.mb && h.mb) { latest.mb = h.mb; if ($val) $val.textContent = h.mb; }
      if (!latest.procs && h.procs) latest.procs = h.procs;
      if (h.label) latest.label = h.label; // v12
      if (!rows.length && Array.isArray(h.rows) && h.rows.length) { rows = h.rows; renderRows(); }
      updateProcsText();
      renderCurve();
      checkAvgThreshold(computeAvg()); // v12: 历史加载后同样查阈值
    }).catch(function () { /* 静默 */ });
  }

  // ── v11: reset 按钮——清除脏曲线历史（mem-curve.log + 内存缓冲 + 重启垂线），从零重记 ──
  // 面板 pointer-events:none，固定（pin）后才可点；点击后主进程清盘 + 广播全窗口同步清空
  function resetLocal() {
    pts = [];
    boots = [];
    lastPtT = -1;
    updateProcsText();
    renderCurve();
  }
  function wireReset() {
    var $reset = $panel.querySelector('.qqq-mem-hover-reset');
    if (!$reset || !bridge.mem.reset) return;
    $reset.addEventListener('click', function () {
      try { bridge.mem.reset().then(resetLocal).catch(function () { /* 静默 */ }); }
      catch (err) { /* 静默 */ }
    });
  }
  if (bridge.mem.onReset) bridge.mem.onReset(resetLocal);

  // ── 进程数显示：当前 N 进程（窗口内峰值 M 进程）——峰值 = max(曲线点 n, 当前瞬时) ──
  function peakProcs() {
    var mx = latest.procs;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].n && pts[i].n > mx) mx = pts[i].n;
    }
    return mx;
  }
  function updateProcsText() {
    if (!$procs) return;
    var cur = latest.procs;
    var pk = peakProcs();
    // v11: 格式定案「10（峰值11）进程」——放 MEM 标题旁；当前==峰值只显示「10 进程」
    $procs.textContent = (pk > cur) ? (cur + '（峰值' + pk + '）进程') : (cur + ' 进程');
  }

  // 标签元素缓存（renderCurve 动态改刻度文案）
  if ($labels) {
    $labels._left = $labels.querySelector('text');
    $labels._mid = $labels.querySelector('.qqq-mem-lbl-mid');
  }

  // ── 交互 ──
  $mem.addEventListener('mouseenter', show);
  $mem.addEventListener('mouseleave', hideSoon);
  // v6: 点击状态区内存块 = 固定/取消固定（固定时面板可交互：滚动进程列表）
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
  // v8: 点击卡片外任何区域 = 关闭卡片（取消固定 + 立即隐藏）；卡片内滚动/状态区内存块自身除外
  // v8 修复: 三面板/编辑器/goods/roam 均为独立 iframe document，主窗口 document click 收不到
  //   iframe 内部点击（q209 实锤「只能点状态区才关」）→ 逐 iframe 绑定点击（load 重绑覆盖
  //   导航新 document，MutationObserver 覆盖动态新建；同源 qqqide-webapp:// 全绑定，
  //   跨域 try-catch 静默跳过尽力而为）
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
    if (t === $mem || ($mem && $mem.contains(t))) return;
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
  // dense 退避隐藏 #qqq-status-mem → 面板同步消失
  var area = document.querySelector('.qqq-status-area');
  if (area) {
    new MutationObserver(function () {
      if (shown && $mem.offsetParent === null) {
        // dense 隐藏：面板同步消失（pinned 状态保留，$mem 恢复时重新弹出）
        $panel.classList.remove('qqq-mem-hover-show');
        shown = false;
      }
      else if (shown) position();
    }).observe(area, { attributes: true, attributeFilter: ['class'] });
  }
})();
