// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-icons.js — 手绘 SVG 图标唯一真理源（2026-10-02 q359 定案）
//
// 目的：跨系统字形 100% 一致。旧实现用 emoji 字符（📁📄🗎🗀…）——Win7 文字体
//   （Segoe UI Symbol 2009 版）无这些 2010+ 字形 → 全变乱码方框；mac 又是彩色风格。
//   现全部改为手绘 SVG（16×16 手绘路径），任何系统任何主题渲染恒一致。
//
// 技术：mask 方案 —— .qqi = inline-block 方块 + background:currentColor +
//   mask:data:svg。颜色恒随文字色（主题自适应）；DOM 零额外节点（每图标 1 span，
//   与旧 emoji 同构）；实测性能与 emoji 同级（5000 行压测构建/布局/渲染持平等）。
// ★ 2026-10-03（q359）实线化重绘：文件夹/文件/相机/复制/信封 全部改为「实线·直角·加粗」几何；
//   纯直角图标启用 shape-rendering="crispEdges"（像素级锐度 = Win10 参照字形同级；曲线图标禁用）；
//   新增 git（分支）/ shield（盾牌）。文件夹加大 ~1px、文件收小 + 直角边角（用户实测定案）。
// ★ 2026-10-03（q359·再精修，用户定案）：文件夹还原前一版实心剪影（加宽版偏大被否）；
//   文件改 1px 细线极简风（直角折角纸 + 2 条内容线——旧 6 线版过重"脏"被否）；
//   信封上下加高 + 由实心块改细线描边；crispEdges 白名单仅剩 copy/shield/git（曲线/斜线/细线禁入）。
// ★ 2026-10-03（q359·zoom 根治）：Roam 文档 zoom 0.85 整体废除（非整数光栅化=模糊+合成税，压测 p90 帧差 +47%）——
//   全套尺寸 ×0.85 落地 + 新增 folder-r/file-r（13 网格 @1:1，仅 q2-roam 引用）；其它消费方仍用 16 网格形状。
// ★ 2026-10-03 晚（q359）：file-r 还原放大（墨迹 6×8 → 8×10，用户定案）；Roam 图标整体下移 1px + 笔触减淡一档（CSS 侧，q2-roam.html）。
// ★ 2026-10-03 终修（q359 用户定案）：颜色还原全量（撤 .85 减淡）；folder-r 圆角→纯直角剪影；file-r 右上「口」字折角→单斜线对角切口。
// ★ 2026-10-03 晚 f49（q359 用户定案）：file-r 折角「单斜点」→「三阶直角阶梯」（h3+l4 对角 45°，crisp 吸附实测 3 个台阶点 c7/c8/c9 + 右缘自 r5 起）。
// ★ 2026-10-04 f51（q359 用户定案）：copy 重绘——旧版形似挂锁被否，改双页经典版（后页左上 L 形可见 + 前页右下直角框）；
//   clock 放大一档（外环 r6.3→7，面包屑时间线按钮）；新增 mail-r——12 网格像素台阶信封（inbox 标签 12px @1:1 纯色实线零模糊，旧 16 网格细线版 100% 半透明像素被否）。
//
// Monaco codeLens 槽位：codeLens 标题只认文本，但 Monaco 支持 `$(name)` 语法 →
//   <span class="codicon codicon-qqq-xxx">。本机为每个图标同时注入
//   .codicon-qqq-* 样式 → codelens 里写 '$(qqq-folder)' 即渲染同名手绘 SVG。
//
// 铁律：一切文件/类型图标只准用本模块（禁第二套图标实现、禁 emoji 图标回潮）；
//   新增图标 = 只在本文件 SHAPES 加一条。
// 引用：main index.html / q2-roam.html / timeline diff-window.html / goods 各 UI。
// ============================================================================
(function () {
  'use strict';
  if (window.qqqIcons) return;

  // ── 形状库（16×16 viewBox 手绘；filled=实心剪影 / stroked=线画）──
  var SHAPES = {
    // 文件夹（实心剪影 + 左标签——对齐 Win10 Segoe 渲染观感；2026-10-03 用户定案还原此版）
    'folder': '<path d="M1.5 4a1.1 1.1 0 0 1 1.1-1.1h3.9a1.1 1.1 0 0 1 1.1 1.1v1.4H1.5z"/>' +
      '<path d="M1.5 5.6h12a1.1 1.1 0 0 1 1.1 1.1v4.8a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5z"/>',
    // ★ Roam 专用·13 网格（2026-10-03「zoom 0.85→1」根治：q2-roam 去文档缩放，图标改 13px 盒 @1:1 光栅化——
    //   视觉 = 旧 16 网格 ×0.85 等效；直边整数坐标 → 纯色零灰边。终修：圆角弧全撤 → 纯直角实心剪影）
    'folder-r': '<path d="M1 2h5v2H1z"/>' +
      '<path d="M1 4h10v6H1z"/>',
    // Roam 专用·文件（同上 13 网格；2026-10-03 晚用户定案：还原「缩 1px」前尺寸——框 7×9 墨迹 8×10；
    //   框线中心落 x.5 → 1px 实线零灰边。★ f49 定案：右上折角「单斜点」→「三阶直角阶梯」——
    //   h3 + l4 4 对角 45°，crisp 吸附实测三台阶点 c7/c8/c9 + 右缘自 r5 起（禁改回单点/口字））
    'file-r': '<path d="M3.5 1.5h3l4 4v5h-7z" fill="none" stroke="#000" stroke-width="1"/>' +
      '<path d="M4.5 6.5h5M4.5 8.5h5" fill="none" stroke="#000" stroke-width="1"/>',
    // 打开的文件夹（前往/定位）
    'folder-open': '<path d="M2.1 6.6V4.3c0-.83.67-1.5 1.5-1.5h3.3c.4 0 .78.16 1.06.44l1.14 1.1h4.4c.83 0 1.5.67 1.5 1.5v.76z"/>' +
      '<path d="M1.5 13.7l1.9-5.5c.15-.44.57-.74 1.04-.74h10.15c.64 0 1.09.61.9 1.22l-1.75 5.5a1.08 1.08 0 0 1-1.04.75H2.45c-.67 0-1.14-.63-.95-1.23z"/>',
    // 通用文件（1px 细线极简风·直角：折角纸 + 2 条内容线——2026-10-03 再定案，旧 6 线版过重被否）
    'file': '<path d="M4 2.2h5.1l3.7 3.7v7.7H4z" fill="none" stroke="#000" stroke-width="1.2"/>' +
      '<path d="M9.1 2.2v3.7h3.7" fill="none" stroke="#000" stroke-width="1.2"/>' +
      '<path d="M5.4 8.7h6M5.4 11.1h6" fill="none" stroke="#000" stroke-width="1.1"/>',
    // 图片
    'image': '<rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1.3" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<circle cx="5.5" cy="6.3" r="1.25"/>' +
      '<path d="M3.2 12.6l3.2-3.5 2.1 2.1 3.2-3.4 2.3 2.7v1.2a.9.9 0 0 1-.9.9z"/>',
    // 音频（八分双符杆）
    'audio': '<path d="M5.7 12V4.5l6.7-1.6v7.8" fill="none" stroke="#000" stroke-width="1.25" stroke-linejoin="round"/>' +
      '<ellipse cx="4" cy="12" rx="1.7" ry="1.45"/>' +
      '<ellipse cx="10.7" cy="10.7" rx="1.7" ry="1.45"/>',
    // 视频（画框 + 播放三角）
    'video': '<rect x="2" y="3.2" width="12" height="9.6" rx="1.4" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<path d="M6.6 5.9v4.2l3.9-2.1z"/>',
    // 压缩包（盒 + 箱扣）
    'zip': '<rect x="2.3" y="2.5" width="11.4" height="3.3" rx=".9" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<path d="M3.4 5.8h9.2v6.5a1.4 1.4 0 0 1-1.4 1.4H4.8a1.4 1.4 0 0 1-1.4-1.4z" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<path d="M6.9 5.8h2.2v2.3H6.9z"/>',
    // PDF（纸 + 底部实心签条）
    'pdf': '<path d="M3.3 1.4h5.5l4 4v8.2a1.1 1.1 0 0 1-1.1 1.1H3.3a1.1 1.1 0 0 1-1.1-1.1V2.5a1.1 1.1 0 0 1 1.1-1.1z" fill="none" stroke="#000" stroke-width="1.25" stroke-linejoin="round"/>' +
      '<path d="M8.8 1.4v3a1.1 1.1 0 0 0 1.1 1.1h3" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<rect x="4.4" y="9.9" width="7.2" height="2.7" rx=".6"/>',
    // 文档（纸 + 满宽内容线）
    'doc': '<path d="M3.3 1.4h5.5l4 4v8.2a1.1 1.1 0 0 1-1.1 1.1H3.3a1.1 1.1 0 0 1-1.1-1.1V2.5a1.1 1.1 0 0 1 1.1-1.1z" fill="none" stroke="#000" stroke-width="1.25" stroke-linejoin="round"/>' +
      '<path d="M8.8 1.4v3a1.1 1.1 0 0 0 1.1 1.1h3" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<path d="M4.6 8h6.8M4.6 10h6.8M4.6 12h5.2" fill="none" stroke="#000" stroke-width="1.1"/>',
    // 表格（网格）
    'xls': '<rect x="2" y="2.6" width="12" height="10.8" rx="1.2" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<path d="M2 6.3h12M2 9.9h12M6.1 6.3v7.1M10 6.3v7.1" fill="none" stroke="#000" stroke-width="1.05"/>',
    // 演示（屏 + 柱状 + 底座）
    'ppt': '<rect x="1.9" y="2.7" width="12.2" height="8.3" rx="1.2" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<path d="M5.7 8.9V6.7M8 8.9V5.3M10.3 8.9V7.6" fill="none" stroke="#000" stroke-width="1.15" stroke-linecap="round"/>' +
      '<path d="M8 11v2.3M5.3 13.5h5.4" fill="none" stroke="#000" stroke-width="1.25" stroke-linecap="round"/>',
    // 程序（齿轮）
    'exe': '<path fill-rule="evenodd" d="M6.3 1.6h3.4l.3 2.05 1.75-.85 1.7 1.7-.85 1.75 2.05.3v3.4l-2.05.3.85 1.75-1.7 1.7-1.75-.85-.3 2.05H6.3l-.3-2.05-1.75.85-1.7-1.7.85-1.75-2.05-.3v-3.4l2.05-.3-.85-1.75 1.7-1.7 1.75.85zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/>',
    // 回收站
    'trash': '<path d="M3 4.5h10" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>' +
      '<path d="M4.5 4.5l.6 8a1.3 1.3 0 0 0 1.3 1.2h3.2a1.3 1.3 0 0 0 1.3-1.2l.6-8" fill="none" stroke="#000" stroke-width="1.3"/>' +
      '<path d="M6.3 4.5V2.9a.9.9 0 0 1 .9-.9h1.6a.9.9 0 0 1 .9.9v1.6" fill="none" stroke="#000" stroke-width="1.3"/>',
    // 房子（记忆库全部）
    'home': '<path d="M2.5 7.5L8 2.9l5.5 4.6" fill="none" stroke="#000" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<path d="M4.1 6.9v5.8a1 1 0 0 0 1 1h5.8a1 1 0 0 0 1-1V6.9" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<path d="M6.7 13.7v-3.3h2.6v3.3" fill="none" stroke="#000" stroke-width="1.05"/>',
    // 放大镜（搜索）
    'search': '<circle cx="6.9" cy="6.9" r="4.2" fill="none" stroke="#000" stroke-width="1.4"/>' +
      '<path d="M10 10l3.6 3.6" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>',
    // 复制（双页经典版——后页左上 L 形可见 + 前页右下直角框；2026-10-04 f51 用户定案：旧版形似挂锁被否）
    'copy': '<path fill-rule="evenodd" d="M4.6 4.6h9.8v9.8H4.6z M6 6v7h7V6z"/>' +
      '<path d="M1.6 1.6h9.4v1.4H3v7.6H1.6z"/>',
    // 邮件（细线加高版·直角：框 + 折信口——2026-10-03 再定案：上下加高、实心块改细线）
    'mail': '<rect x="2.2" y="2.9" width="11.6" height="10.3" fill="none" stroke="#000" stroke-width="1.2"/>' +
      '<path d="M2.7 3.4L8 8.2l5.3-4.8" fill="none" stroke="#000" stroke-width="1.2"/>',
    // 邮件（12 网格·像素台阶版——inbox 标签图标专用：12px 盒 @1:1 纯色实线零模糊；2026-10-04 f51 用户定案，
    //   旧 16 网格细线版 12px 下 = 100% 半透明像素（像素实测）；本版 = 1px 框 + 8 枚 1px 台阶点构成的对称 V 形信口）
    'mail-r': '<path fill-rule="evenodd" d="M1 2h10v8H1z M2 3v6h8V3z"/>' +
      '<path d="M2 3h1v1h-1z M3 4h1v1h-1z M4 5h1v1h-1z M5 6h1v1h-1z M6 6h1v1h-1z M7 5h1v1h-1z M8 4h1v1h-1z M9 3h1v1h-1z"/>',
    // git 分支（方块节点 + 干线/支线·全矩形——goods 标签图标）
    'git': '<rect x="3.1" y="2.7" width="2.8" height="2.8"/><rect x="3.1" y="10.5" width="2.8" height="2.8"/>' +
      '<rect x="10.1" y="6.6" width="2.8" height="2.8"/><rect x="3.8" y="4.9" width="1.4" height="6.2"/>' +
      '<rect x="4.5" y="7.3" width="6.3" height="1.4"/>',
    // 盾牌（dsecret goods 标签图标·实心直角多边形）
    'shield': '<path d="M8 1.6l5.2 2.1v4.2L8 14.4 2.8 7.9V3.7z"/>',
    // 时钟（面包屑时间线按钮——实心环 + 双指针；2026-10-04 f51 用户定案放大一档：外环 r6.3→7、指针同比加长）
    'clock': '<path fill-rule="evenodd" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1z m0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/>' +
      '<rect x="7.25" y="3.9" width="1.5" height="5.2"/><rect x="8" y="7.85" width="3.7" height="1.5"/>',
    // 邮件（开口信封）
    'mail-open': '<path d="M1.9 6.6L8 2.3l6.1 4.3v5.9a1.3 1.3 0 0 1-1.3 1.3H3.2a1.3 1.3 0 0 1-1.3-1.3z" fill="none" stroke="#000" stroke-width="1.25" stroke-linejoin="round"/>' +
      '<path d="M1.9 6.6L8 11.2l6.1-4.6" fill="none" stroke="#000" stroke-width="1.25"/>',
    // 发送（收件盘 + 上行箭头）
    'send': '<path d="M2.4 9.6v2.7a1.4 1.4 0 0 0 1.4 1.4h8.4a1.4 1.4 0 0 0 1.4-1.4V9.6" fill="none" stroke="#000" stroke-width="1.25" stroke-linecap="round"/>' +
      '<path d="M8 10V2.4M4.9 5.5L8 2.4l3.1 3.1" fill="none" stroke="#000" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>',
    // 雪花（活动块：清爽从2026）
    'snow': '<path d="M8 1.7v12.6M2.55 4.85l10.9 6.3M2.55 11.15l10.9-6.3" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>',
    // 礼物（活动块：原料与基本权利）
    'gift': '<rect x="2" y="5.6" width="12" height="2.7" rx=".7" fill="none" stroke="#000" stroke-width="1.2"/>' +
      '<path d="M3.3 8.3h9.4v4.8a1.2 1.2 0 0 1-1.2 1.2H4.5a1.2 1.2 0 0 1-1.2-1.2z" fill="none" stroke="#000" stroke-width="1.2"/>' +
      '<path d="M8 5v9.3" fill="none" stroke="#000" stroke-width="1.2"/>' +
      '<path d="M8 4.2c-1-.1-2.4-.7-2.4-1.7 0-.9.9-1.3 2.4 0 1.5-1.3 2.4-.9 2.4 0 0 1-1.4 1.6-2.4 1.7z" fill="none" stroke="#000" stroke-width="1.1"/>',
    // 钻石（活动块：vibe coding）
    'gem': '<path d="M5.2 2.1h5.6l3.3 4.1L8 13.9 1.9 6.2z" fill="none" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<path d="M1.9 6.2h12.2M8 6.2L5.5 2.1M8 6.2l2.5-4.1" fill="none" stroke="#000" stroke-width="1"/>',
    // 眼睛（Markdown 预览入口）
    'eye': '<path d="M1.7 8S4.2 3.9 8 3.9 14.3 8 14.3 8 11.8 12.1 8 12.1 1.7 8 1.7 8z" fill="none" stroke="#000" stroke-width="1.25"/>' +
      '<circle cx="8" cy="8" r="1.9"/>',
    // 相机（AI 面板快照）——实线加粗版（曲线镜头保留抗锯齿；实测小尺寸清晰度最优）
    'camera': '<path fill-rule="evenodd" d="M2.6 5h2.2l1.1-1.9h4.2L11.2 5h2.2v8H2.6z M4 6.4v5.2h8V6.4z"/>' +
      '<path fill-rule="evenodd" d="M8 6.6a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4z m0 1.4a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>',
    // 地图（小地图开关）
    'map': '<path d="M1.8 4.5l3.9-1.7 4.6 1.7 3.9-1.7v8.8l-3.9 1.7-4.6-1.7-3.9 1.7z" fill="none" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<path d="M5.7 2.8v8.8M10.3 4.5v8.8" fill="none" stroke="#000" stroke-width="1"/>',
    // 对话气泡（inbox 空态）
    'chat': '<path d="M2 4.3a1.4 1.4 0 0 1 1.4-1.4h9.2A1.4 1.4 0 0 1 14 4.3v5.3a1.4 1.4 0 0 1-1.4 1.4H7.5l-3.3 2.7v-2.7H3.4A1.4 1.4 0 0 1 2 9.6z" fill="none" stroke="#000" stroke-width="1.25" stroke-linejoin="round"/>',
    // 多人（群聊）
    'users': '<circle cx="5.7" cy="5.6" r="2.1" fill="none" stroke="#000" stroke-width="1.2"/>' +
      '<path d="M2 13.2c0-2.2 1.6-3.7 3.7-3.7s3.7 1.5 3.7 3.7" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>' +
      '<path d="M10.3 4a2.1 2.1 0 0 1 0 4M11.2 9.9c1.6.4 2.6 1.7 2.6 3.3" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>'
  };

  var NAMES = Object.keys(SHAPES);

  // crispEdges 白名单：纯直线图标才可关抗锯齿（曲线图标禁入）；像素吸附让边缘完全实色
  //   folder-r / file-r（全直线）入列；file-r 含 45° 对角切口——crisp 吸附为三阶直角阶梯（f49 定案），符合「真实线」定案
  var CRISP = { copy: 1, shield: 1, git: 1, 'folder-r': 1, 'file-r': 1, 'mail-r': 1 };
  // 非 16 网格形状的 viewBox 覆盖（Roam 专用 13 网格，详 SHAPES 头注）
  var VB = { 'folder-r': 13, 'file-r': 13, 'mail-r': 12 };

  function _uri(name) {
    var vb = VB[name] || 16;
    return 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + vb + ' ' + vb + '"' +
      (CRISP[name] ? ' shape-rendering="crispEdges"' : '') + '>' + SHAPES[name] + '</svg>'
    );
  }

  // ── CSS（唯一注入点）：.qqi 基类 + 每图标 mask + Monaco codicon 桥 ──
  var css = '.qqi{display:inline-block;width:1em;height:1em;flex:none;vertical-align:-.125em;' +
    'background-color:currentColor;background-repeat:no-repeat;background-position:center;background-size:contain;' +
    '-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;-webkit-mask-size:contain;' +
    'mask-repeat:no-repeat;mask-position:center;mask-size:contain}';
  NAMES.forEach(function (n) {
    var u = _uri(n);
    css += '.qqi-' + n + '{-webkit-mask-image:url("' + u + '");mask-image:url("' + u + '")}';
  });
  // Monaco codeLens 桥：'$(qqq-folder)' → <span class="codicon codicon-qqq-folder"> → 同款手绘 SVG
  css += '.codicon[class*="codicon-qqq-"]{-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;-webkit-mask-size:contain;' +
    'mask-repeat:no-repeat;mask-position:center;mask-size:contain;background-color:currentColor;width:12px;height:12px;' +
    'vertical-align:-1px;display:inline-block}';
  NAMES.forEach(function (n) {
    var u = _uri(n);
    css += '.codicon-qqq-' + n + '{-webkit-mask-image:url("' + u + '");mask-image:url("' + u + '")}';
  });

  function _inject() {
    if (document.getElementById('qqq-icons-style')) return;
    var st = document.createElement('style');
    st.id = 'qqq-icons-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  if (document.head) _inject();
  else document.addEventListener('DOMContentLoaded', _inject);

  function cls(name) { return 'qqi qqi-' + name; }
  // HTML 串消费者（innerHTML 场景）
  function html(name, style) {
    return '<span class="' + cls(name) + '"' + (style ? ' style="' + style + '"' : '') + '></span>';
  }
  // DOM 消费者（createElement 场景）
  function el(name, style) {
    var s = document.createElement('span');
    s.className = cls(name);
    if (style) s.style.cssText = style;
    return s;
  }

  window.qqqIcons = {
    names: NAMES.slice(),
    has: function (n) { return !!SHAPES[n]; },
    cls: cls,
    html: html,
    el: el
  };
})();
