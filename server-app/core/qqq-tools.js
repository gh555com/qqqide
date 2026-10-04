// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-tools.js — 菜单行2 "qqq" 按钮（help 左边）· hover = "qqq 工作台"操作面板
//
// 结构（2026-09-22 工作台改版：由「文本下拉列表」升级为「卡片式操作面板」）:
//   ┌───────────────────────────────────────────────────────┐
//   │  [♾][■] Savor moments for yourself                    │  ← 老 q3 savorCard 100%
//   │  [✎ export doc]        [🗜 export Zip]                │
//   │  [ .doc ][ .docx ]                                    │
//   │  [↑][↓]           ⚙ 居中（点击开设置中心）             │  ← [↑][↓] 云同步（老 qqq AQ 100%）+ 齿轮开「qqq 设置中心」

//   │  [ Video Url ............ ][▶]                        │  ← 老 q3 videoCard 100%（回车/▶=开始下载；历史下拉）
//   │  [✎ Paste]         [✦ Pure]                           │  ← Paste=对目标文档等效 Ctrl+V；Pure=孤儿扫描出清单
//   │                ▓▓（正中合页）                         │  ← 专用行：即将被操作的编辑分组（实心=当前目标；无目标=整行不显示）
//   └───────────────────────────────────────────────────────┘
//   2026-09-22 二次改版: 移除 SOUND/EXPORT/DATA/SOON 分割行——纯卡片连续流。
//   2026-09-22 三次改版（用户定案）: 标题行 "qqq workbench" 删除 + 副行小字全删；
//   主文字随按钮垂直居中 + 卡片纵向空间回收（6px 紧凑内边距，"更扁 = 看上去更宽"）；
//   被删小字的说明职责全部转 hover tooltip：本地语言（i18n workbench.* 段）+ 详细。
//   2026-09-22 四次微调（用户定案）: Savor 卡内统计行删除（副行归零 → 主文字真垂直居中）；
//   统计恒归 hover（本地语言清晰版、悬停即时刷新；「不解释，直接放核心信息」）；面板总宽 -20%（438→350px）。
//   2026-09-28 改版（用户定案 · 设置本地化）: Cloud Sync 卡保留原尺寸——[↑][↓] 云同步按钮 100% 原样
//   （老 qqq AQ 语义）；原 "Cloud Sync" 文字位 → 齿轮（20px · 卡片内居中稍偏左 6px · 正常文字色 = 非金色）；点击（或整卡点击）
//   = 打开「qqq 设置中心」大卡片 = core/qqq-center.js；云同步机械与确认/进度相位在 qqq-center.js
//   （本文件经 window.qqqCenter.doSync 桥接按钮）。
//
// 设计决策（国际化）:
//   · 面板文案全英文（菜单固有标签白名单——与老 q3 侧边按钮组一致）+ Consolas 等宽字体
//     → 面板本体零翻译负担、任何语言环境宽度恒定（详 铁律 §4.4 免翻译白名单）；
//     说明性 tooltip 按用户定案走 i18n 本地语言（workbench.* 键）。
//   · 卡片式布局：每组工具 = 卡片；主操作整卡可点 / 精细操作走卡内按钮与 chips。
//
// 功能映射（100% 保留，与旧版逐一对齐）:
//   Savor        点卡片 = normal（随机曲 ×2~6）· [♾] = 无限循环 · [■] = 停止
//                电台在线 → 播电台（判定在壳层桥）+ label 暗金色 #8b6914；播放中 'Savoring...'/'Looping...'
//   export doc   [.doc]/[.docx] chips → window.qqqExport.doc(format)
//   export Zip   整卡点击 → window.qqqExport.zip()
//   云同步+齿轮  [↑][↓] = 上传/下载（桥 window.qqqCenter.doSync——机械在 qqq-center.js）；齿轮（原文字位）
//               = 点击打开「qqq 设置中心」（core/qqq-center.js：设置全量本地化）

//   Video Url → 直达下载（直链/平台视频/网页嗅探——paste-router.pasteUrlInto 与粘贴同一机器）；
//               历史自动收录（qgs.simple('qqq.videoUrl')，空输入框聚焦回看）
//   Paste Plain Text → 纯文本粘贴：只取剪贴板文字原样插入目标文档（不下载图片 / 不转换网页富文本 /
//               不处理文件与网址——富粘贴仍归编辑器右键 / Ctrl+V；paste-router.pasteTextInto）
//   Pure      → 扫描文档旁 _qqqvault 孤儿项 → 生成 _qqqvault.pure 审阅清单（core/qqq-pure.js；绝不自动删除）
//   合页指示器 → 专用行正中一枚（比旧卡内款稍大）；悬停操作类按钮/合页方块 → 目标编辑区亮淡紫虚线框
//
// 交互: hover 进入展开（250ms 延迟关闭）；Esc / 点别处 / resize 即关；零自定义 cursor（铁律 §4.3）。
// 挂载: gaea-host renderTabBar() 尾部、help 之前（顺序契约——详 铁律 §4.12）。
// 废弃记录: Roam 行已移除（新 IDE 已有 Roam goods）；Weave 行已删除（详 铁律 §4.10）。
// ============================================================================

; (function () {
  'use strict';

  var HOVER_CLOSE_DELAY = 250;
  // 面板内容宽；content-box → 总宽 = 内容宽 + 22px（内边距 20 + 边框 2）。
  // 2026-09-22 用户定案整面板 -20%：438 → ~350px（PANEL_W 328 + 22）。
  var PANEL_W = 328;

  var _btnEl = null;
  var _rootEl = null;
  var _allTimer = null;
  var _globalBound = false;
  // Savor 卡片引用
  var _savorCardEl = null;
  var _savorLabelEl = null;
  var _savorUnsub = null;

  // 视频 Url 行（输入框 / 历史下拉 / 错误提示）——输入中不自动收面板（_pointerInside 协同）
  var _vurlRowEl = null;
  var _vurlInputEl = null;
  var _vurlDropEl = null;
  var _vurlTipEl = null;
  var _vurlTipTimer = null;
  var _pointerInside = false;


  function _i(key, fb) { try { return window._i ? window._i(key, fb) : fb; } catch (e) { return fb; } }
  function _qoast(m, o) { try { if (window.qqqideQoast) { window.qqqideQoast.show(m, o || {}); } } catch (e) { } }
  function _T(key, fb, map) {
    var v = _i(key, fb);
    if (map) { for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) { v = v.split('{' + k + '}').join(String(map[k])); } } }
    return v;
  }

  // ── 图标（内联 SVG，currentColor 全主题自适应；♾/■ 两枚沿用老项目 base64 图标类） ──
  var _ICO_PEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor"/></svg>';
  var _ICO_ZIP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5"/><path d="M10.5 12.5h3" stroke-linecap="round"/></svg>';
  // ★ ▶ 内三角（2026-10-04 三轮终稿：二轮 16×20 过大约 35% → 收至 65%，墨迹 ≈10.4×12.9px）：tight viewBox
  //   贴合墨迹（旧 24 格画布含大量留白——18px 画布实际墨迹仅 ~9.8px）+ flex:0 0 auto 防缩（图标槽 14px
  //   flex 容器会压缩 SVG；按钮恒高 32px 恰容纳）。
  var _ICO_PLAY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 5.5 10.5 13" width="10.4" height="13" style="flex:0 0 auto"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
  var _ICO_PASTE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3.2A1.2 1.2 0 0 1 10.2 2h3.6A1.2 1.2 0 0 1 15 3.2v1.3"/></svg>';
  var _ICO_PURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12"><path d="M12 2l1.8 7.2L21 12l-7.2 1.8L12 21l-1.8-7.2L3 12l7.2-1.8z" fill="currentColor"/></svg>';

  // ── 样式（自包含注入；等宽字体 + 卡片式工作台；颜色一律主题变量） ──
  function _ensureStyle() {
    if (document.getElementById('qqq-tools-menu-style')) { return; }
    var s = document.createElement('style');
    s.id = 'qqq-tools-menu-style';
    s.textContent = [
      '.qqq-tools-btn:hover, .qqq-tools-btn.qqq-tools-open { background: var(--background-color) !important; opacity: .85; }',
      '.qqq-tools-btn { position: relative; }',

      '.qqq-tools-menu {',
      '  position: fixed; z-index: 999999;',
      '  width: ' + PANEL_W + 'px; max-width: calc(100vw - 16px);',
      '  background: var(--card-bg, #fdf6e3);',
      '  border: 1px solid var(--border-color, #d6d6d6);',
      '  border-radius: 8px;',
      '  box-shadow: 0 6px 22px rgba(0,0,0,0.16);',
      '  padding: 8px 10px; margin: 0;',
      '  opacity: 0; pointer-events: none;',
      '  transform: translateY(-4px);',
      '  transition: opacity .12s ease, transform .12s ease;',
      '  font-family: Consolas, "Cascadia Mono", Menlo, "DejaVu Sans Mono", monospace;',
      '  font-size: 12px;',
      '  max-height: calc(100vh - 12px); overflow-y: auto; overflow-x: hidden;',
      '}',
      '.qqq-tools-menu.open { opacity: 1; pointer-events: auto; transform: translateY(0); }',
      '.qqq-tools-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }',

      '.qqq-tools-card { border: 1px solid var(--border-color, #d6d6d6); border-radius: 6px; padding: 6px 10px; min-width: 0; color: var(--text-primary, #586e75); transition: border-color .12s ease, background .12s ease; }',
      '.qqq-tools-card:hover { border-color: var(--primary-color, #b58900); background: var(--hover-bg, rgba(0,0,0,0.04)); }',
      '.qqq-tools-card.wide { grid-column: 1 / -1; }',
      '.qqq-tools-card.qqq-tools-flex { display: flex; align-items: center; gap: 10px; position: relative; }',
      '.qqq-tools-gear-ico { position: absolute; left: calc(50% - 6px); top: 50%; transform: translate(-50%, -50%); display: inline-flex; align-items: center; justify-content: center; color: var(--text-primary, #586e75); flex-shrink: 0; transition: transform .15s ease; }',
      '.qqq-tools-gear-ico svg { display: block; }',
      '.qqq-tools-card:hover .qqq-tools-gear-ico { transform: translate(-50%, -50%) scale(1.1); }',
      '.qqq-tools-card-body { flex: 1 1 auto; min-width: 0; }',
      '.qqq-tools-card-head { display: flex; align-items: center; gap: 6px; }',
      '.qqq-tools-card-title { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.qqq-tools-ico-svg { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex: 0 0 auto; opacity: .85; }',
      '.qqq-tools-ico-svg svg { display: block; }',
      '.qqq-tools-btns { display: flex; gap: 4px; flex-shrink: 0; }',
      '.qqq-tools-mini-btn { padding: 2px 6px; font-size: 13px; border: 1px solid var(--border-color, #d6d6d6); border-radius: 3px; background: var(--base3, #eee8d5); color: var(--text-primary, #586e75); font-family: Tahoma, sans-serif; line-height: 1.2; display: inline-flex; align-items: center; }',
      '.qqq-tools-mini-btn:hover { background: var(--primary-color, #b58900); color: #1e1e1e; }',
      '.qqq-tools-mini-btn:disabled { opacity: .45; }',
      '.qqq-tools-ico { width: 14px; height: 14px; display: inline-block; vertical-align: middle; position: relative; top: -1px; }',
      '.qqq-tools-ico.icon-loop { background: url(\'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzU0NTQ1NCI+PHBhdGggZD0iTTEyIDRWMUw4IDVsNCA0VjZjMy4zMSAwIDYgMi42OSA2IDYgMCAxLjAxLS4yNSAxLjk3LS43IDIuOGwxLjQ2IDEuNDZBNy45MyA3LjkzIDAgMCAwIDIwIDEyYzAtNC40Mi0zLjU4LTgtOC04em0wIDE0Yy0zLjMxIDAtNi0yLjY5LTYtNiAwLTEuMDEuMjUtMS45Ny43LTIuOEw1LjI0IDcuNzRBNy45MyA3LjkzIDAgMCAwIDQgMTJjMCA0LjQyIDMuNTggOCA4IDh2M2w0LTQtNC00djN6Ii8+PC9zdmc+\') no-repeat center; }',
      '.qqq-tools-ico.icon-stop { background: url(\'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iIzU0NTQ1NCI+PHJlY3QgeD0iNCIgeT0iNCIgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMiIvPjwvc3ZnPg==\') no-repeat center; }',
      '[data-theme="dark"] .qqq-tools-ico.icon-loop, [data-theme="dark"] .qqq-tools-ico.icon-stop { filter: invert(0.75); }',
      '.qqq-tools-chips { display: flex; gap: 4px; margin-top: 6px; }',
      '.qqq-tools-chip { flex: 1 1 auto; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 3px 8px; font-size: 11px; font-family: inherit; border: 1px solid var(--border-color, #d6d6d6); border-radius: 4px; background: var(--base3, #eee8d5); color: var(--text-primary, #586e75); }',
      '.qqq-tools-chip:hover { background: var(--primary-color, #b58900); color: #1e1e1e; }',
      '.qqq-tools-chip svg { display: block; }',
      // ★ 导出合页指示器（两卡右侧）：竖双方块共缝（合页形）；实心 = 即将被导出的编辑分组；单分组 = 独占态（单块 +4px 向左宽出）
      // ★ 合页指示器（2026-10-03 定案）：专用行正中一枚（比旧卡内款稍大）；实心 = 即将被操作的编辑分组
      '.qqq-tools-hinge { display: inline-flex; align-items: center; flex: 0 0 auto; }',
      '.qqq-tools-hinge i { display: block; width: 8px; height: 16px; box-sizing: border-box; border: 1px solid currentColor; border-radius: 1px; }',
      '.qqq-tools-hinge i + i { margin-left: -1px; }',
      '.qqq-tools-hinge.single i { width: 13px; }',
      '.qqq-tools-hinge i.on { background: currentColor; }',
      '.qqq-tools-hinge i.off { opacity: .3; }',
      '.qqq-tools-hinge:hover i { border-color: var(--primary-color, #b58900); }',
      '.qqq-tools-hinge:hover i.on { background: var(--primary-color, #b58900); }',
      '.qqq-tools-hinge-row { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; padding: 4px 0 1px; }',
      // ★ 视频 Url 行（老 q3 videoCard 移植：输入框 + ▶ + 历史下拉）
      //   整行无外框（无卡边框/底色），纯左右结构——左 = 输入框（文字 var(--base03) 近黑/近白，与 --text-dim
      //   提示文字一眼可辨）/ 右 = ▶ 钮；两者恒高 32px（fix 高 + flex 居中，窄窗不换行、不塌陷）；
      //   2026-10-04 用户定案：两者微圆角 3px（原直角）+ ▶ 内三角终稿 = 二轮尺寸的 65%（墨迹 ≈10.4×12.9px，tight viewBox）。
      '.qqq-tools-video-card { grid-column: 1 / -1; position: relative; padding: 7px 0; }',
      '.qqq-tools-vurl-row { display: flex; align-items: center; gap: 4px; }',
      '.qqq-tools-vurl { flex: 1 1 auto; min-width: 0; box-sizing: border-box; height: 32px; font-family: inherit; font-size: 13px; padding: 0 10px; border: 1px solid var(--border-color, #d6d6d6); border-radius: 3px; background: var(--base3, #eee8d5); color: var(--base03, #002b36); outline: none; }',
      '.qqq-tools-vurl::placeholder { color: var(--text-dim, #a8a6a2); opacity: 1; }',
      '.qqq-tools-vurl:focus { border-color: var(--primary-color, #b58900); }',
      '.qqq-tools-vurl.invalid { border-color: var(--red, #dc322f); }',
      '.qqq-tools-vurl-go { flex: 0 0 auto; box-sizing: border-box; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0 12px; border: 1px solid var(--border-color, #d6d6d6); border-radius: 3px; background: var(--base3, #eee8d5); color: var(--text-primary, #586e75); }',
      '.qqq-tools-vurl-go:hover { background: var(--primary-color, #b58900); color: #1e1e1e; }',
      // ★ 历史下拉（2026-10-04 用户定案）：输入框正下方紧贴（+1px）、与输入行同宽——fixed 定位且节点挂 body
      //   （脱离菜单树：菜单是 overflow:auto 滚动容器且带 transform，fixed 子级会被改成菜单局部坐标系并遭下缘裁剪，
      //   20 条下拉必被切断；坐标由 JS 按输入行实测矩形落值，见 _vurlDropPlace）
      '.qqq-tools-vurl-drop { position: fixed; z-index: 1000000; background: var(--card-bg, #fdf6e3); border: 1px solid var(--border-color, #d6d6d6); border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,0.12); padding: 2px 0; display: none; overflow-y: auto; }',
      '.qqq-tools-vurl-tip { position: absolute; left: 0; right: 0; bottom: calc(100% + 3px); z-index: 40; background: var(--card-bg, #fdf6e3); border: 1px solid var(--border-color, #d6d6d6); border-radius: 4px; box-shadow: 0 -2px 10px rgba(0,0,0,0.12); padding: 2px 0; display: none; }',
      '.qqq-tools-vurl-item { padding: 4px 10px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.qqq-tools-vurl-item:hover { background: var(--gold-hover-bg, rgba(181,137,0,0.12)); }',
      '.qqq-tools-vurl-tip { padding: 5px 10px; font-size: 11px; color: var(--red, #dc322f); }',
      '.qqq-tools-bigbtn { justify-content: center; padding: 7px 8px; font-size: 12px; min-width: 0; }',
      '.qqq-tools-idle { opacity: .55; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── 计时器 / 全局收尾 ──
  function _clearTimers() {
    if (_allTimer) { clearTimeout(_allTimer); _allTimer = null; }
  }
  function _videoInputFocused() {
    try { return !!(_vurlInputEl && document.activeElement === _vurlInputEl); } catch (_) { return false; }
  }
  function _scheduleAll() {
    _clearTimers();
    _allTimer = setTimeout(function () {
      _allTimer = null;
      // ★ 视频 Url 输入中不自动收面板（防长 URL 打一半面板消失）；失焦/移出后再收
      if (_videoInputFocused()) { return; }
      _closeAll();
    }, HOVER_CLOSE_DELAY);
  }
  function _containsAny(t) {
    if (!t) { return false; }
    if (_rootEl && _rootEl.contains(t)) { return true; }
    if (_btnEl && _btnEl.contains(t)) { return true; }
    if (_vurlDropEl && _vurlDropEl.contains(t)) { return true; }   // 历史下拉挂在 body（不在 _rootEl 子树）
    return false;
  }
  function _onDocClick(e) { if (!_containsAny(e && e.target)) { _closeAll(); } }
  function _onEsc(e) { if (e && e.key === 'Escape') { _closeAll(); } }
  function _bindGlobal() {
    if (_globalBound) { return; }
    _globalBound = true;
    document.addEventListener('click', _onDocClick);
    document.addEventListener('keydown', _onEsc, true);
    window.addEventListener('resize', _closeAll);
  }
  function _unbindGlobal() {
    if (!_globalBound) { return; }
    _globalBound = false;
    document.removeEventListener('click', _onDocClick);
    document.removeEventListener('keydown', _onEsc, true);
    window.removeEventListener('resize', _closeAll);
  }

  // ── 基础构件 ──
  function _ico(svgHtml) {
    var w = document.createElement('span');
    w.className = 'qqq-tools-ico-svg';
    w.innerHTML = svgHtml;
    return w;
  }
  function _chip(label, title, iconHtml) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'qqq-tools-chip';
    if (title) { b.title = title; }
    if (iconHtml) { b.appendChild(_ico(iconHtml)); }
    var sp = document.createElement('span');
    sp.textContent = label;
    b.appendChild(sp);
    return b;
  }

  function _callExport(what, format) {
    var x = window.qqqExport;
    if (!x) {
      _qoast(_i('export.bridgeMissing', 'qqq: 导出服务不可用（需重启实例）'), { type: 'error', duration: 9000 });
      return;
    }
    try {
      if (what === 'doc') { x.doc(format || 'rtf'); } else { x.zip(); }
    } catch (e) {
      _qoast(_i('export.exportFailed', 'qqq: 导出失败: {0}').replace('{0}', String((e && e.message) || e)), { type: 'error', duration: 9000 });
    }
  }

  // ── Savor（消费 core/savor.js；按钮 100% 老项目形态）──
  function _miniBtn(iconCls, title) {
    var b = document.createElement('button');
    b.className = 'qqq-tools-mini-btn';
    b.title = title;
    var ic = document.createElement('span');
    ic.className = 'qqq-tools-ico ' + iconCls;
    b.appendChild(ic);
    return b;
  }
  function _savorPlay(mode) {
    var s = window.qqqSavor;
    if (!s) {
      _qoast('Savor: 模块未加载（需刷新）', { type: 'error', duration: 9000 });
      return;
    }
    try { s.play(mode); } catch (e) { _qoast('Savor: ' + String((e && e.message) || e), { type: 'error', duration: 9000 }); }
  }
  function _savorStop() {
    var s = window.qqqSavor;
    if (!s) { return; }
    try { s.stop(); } catch (e) { }
  }
  // ★ 本地语言时长（hover 清晰版统计用；i18n 键拼装——2026-09-22）
  function _fmtDurLoc(ms) {
    var sec = Math.floor((ms || 0) / 1000);
    var min = Math.floor(sec / 60);
    var hr = Math.floor(min / 60);
    if (hr > 0) { return _T('workbench.durHm', '{0} 小时 {1} 分', { 0: hr, 1: min % 60 }); }
    if (min > 0) { return _T('workbench.durMs', '{0} 分 {1} 秒', { 0: min, 1: sec % 60 }); }
    return _T('workbench.durSs', '{0} 秒', { 0: sec });
  }
  // ★ Savor hover = 清晰版统计（核心信息直放、本地语言、零解释——用户定案 2026-09-22）
  function _savorTipText(s) {
    var g = null;
    try { g = (s && s.getStats) ? s.getStats() : null; } catch (e) { g = null; }
    if (!g) { return ''; }
    var any = (Number(g.count) || 0) > 0 || (Number(g.radioCount) || 0) > 0
      || (Number(g.totalMs) || 0) > 0 || (Number(g.radioTotalMs) || 0) > 0;
    if (!any) { return ''; }
    return _T('workbench.savorTip',
      '本地音乐：{v0} 次，共 {v1}\n电台：{v2} 次，共 {v3}\n日均收听：{v4}',
      {
        v0: Number(g.count) || 0,
        v1: _fmtDurLoc(g.totalMs),
        v2: Number(g.radioCount) || 0,
        v3: _fmtDurLoc(g.radioTotalMs),
        v4: _fmtDurLoc(g.avgMs)
      });
  }
  function _refreshSavorRow() {
    var s = window.qqqSavor;
    if (!s || !_savorLabelEl) { return; }
    var stt = {};
    try { stt = s.getState ? s.getState() : {}; } catch (e) { }
    _savorLabelEl.textContent = stt.playing ? (stt.isLoop ? 'Looping...' : 'Savoring...') : 'Savor moments for yourself';
    try { _savorLabelEl.style.color = stt.radioLive ? '#8b6914' : ''; } catch (e) { }
    // 统计恒归 hover（卡内零副行——主文字真垂直居中；2026-09-22 用户定案）
    if (_savorCardEl) { _savorCardEl.title = _savorTipText(s); }
  }
  function _bindSavorState() {
    _unbindSavorState();
    var s = window.qqqSavor;
    if (s && s.onState) {
      try { _savorUnsub = s.onState(_refreshSavorRow); } catch (e) { _savorUnsub = null; }
    }
  }
  function _unbindSavorState() {
    if (_savorUnsub) { try { _savorUnsub(); } catch (e) { } _savorUnsub = null; }
  }

  // ── 通用 SVG 小按钮（云同步按钮 + 播放器行复用）──
  //   [↑][↓] 云同步 SVG 原样搬自老项目 q4.js（aqUploadSvg/aqDownloadSvg，云+箭头）；stroke 改 currentColor 适配主题
  var _SYNC_SVG_UP = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="16" height="16"><g transform="translate(0,-1)"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" fill="currentColor" opacity=".6"/><path d="M12 18V9M8 12l4-4 4 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>';
  var _SYNC_SVG_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" width="16" height="16"><g transform="translate(0,-1)"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" fill="currentColor" opacity=".6"/><path d="M12 9v9M8 15l4 4 4-4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>';

  function _syncBtn(svgHtml, title) {
    var b = document.createElement('button');
    b.className = 'qqq-tools-mini-btn';
    b.title = title;
    var ic = document.createElement('span');
    ic.style.cssText = 'display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;';
    ic.innerHTML = svgHtml;
    b.appendChild(ic);
    return b;
  }
  // ── 卡片构建 ──
  function _buildSavorCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card wide qqq-tools-flex';
    c.addEventListener('click', function (e) { e.stopPropagation(); _savorPlay('normal'); });
    c.addEventListener('mouseenter', function () { _refreshSavorRow(); });   // 悬停即时刷新统计 tooltip
    var grp = document.createElement('div');
    grp.className = 'qqq-tools-btns';
    var bLoop = _miniBtn('icon-loop', 'Infinite Loop');
    var bStop = _miniBtn('icon-stop', 'Stop');
    bLoop.addEventListener('click', function (e) { e.stopPropagation(); _savorPlay('loop'); });
    bStop.addEventListener('click', function (e) { e.stopPropagation(); _savorStop(); });
    grp.appendChild(bLoop);
    grp.appendChild(bStop);
    var body = document.createElement('div');
    body.className = 'qqq-tools-card-body';
    var t = document.createElement('div');
    t.className = 'qqq-tools-card-title';
    t.textContent = 'Savor moments for yourself';
    body.appendChild(t);
    c.appendChild(grp);
    c.appendChild(body);
    _savorCardEl = c;
    _savorLabelEl = t;
    _bindSavorState();
    _refreshSavorRow();
    return c;
  }

  // ── 操作目标指示机器（合页指示器 + 悬停淡紫目标框；2026-10-03 改版）──
  //   与一切操作本体同源 = window.qqqExport.resolveTarget()（唯一出口；禁第二套扫描）。
  //   · 合页 = 专用行正中一枚竖双方块（8×16，单分组 13px）：实心 = 即将被操作的编辑分组（X 区文件分组，左→右）
  //   · 点方块 = 聚焦该分组当前标签（切换目标，不导出、不关面板）；悬停方块 = 预览该分组淡紫框
  //   · 悬停【操作类】元素 = 目标编辑区亮淡紫 3px 虚线框（同 drop-overlay 绘制，仅换色）：
  //       导出卡×2 · 视频 Url 行 · Paste 钮 · 合页行（Pure 不显示——其作用于目录而非目标文档）
  //   · tooltip 后缀按 kind 分流：export → 「即将导出」；op/hinge → 「即将操作」；无目标 → 「无目标文档」（单源 _refreshExportCards）
  //   ★ 2026-10-04（q400 用户实锤：焦点在 kmd/inbox 时紫框没亮、导出却把陈旧目标导出走了）——
  //     无目标 = 全静默：合页行【不显示】、文档操作卡置灰（.qqq-tools-idle）、方块按分组可操作性置灰（.off）、
  //     点击一律如实拒绝（目标裁决双闸详 export-machine.js resolveTarget）；非文件活动标签的分组 = 不可点不可悬停预览。
  var _expCards = [];      // [{el, base, kind}] 操作类元素 + 基础 tooltip（导出×2 / 视频行 / Paste / 合页行）
  var _hingeEls = [];      // 合页图标（专用行正中一枚）
  var _hingeRows = [];     // 合页专用行（无目标时整行隐藏）
  var _dimEls = [];        // 文档操作类卡片（无目标时置灰）
  var _expOvEl = null;     // 淡紫目标框（懒建；指针穿透）
  var _expOvShown = false;

  function _expResolve() {
    try {
      var x = window.qqqExport;
      if (x && x.resolveTarget) { return x.resolveTarget() || null; }
    } catch (e) { /* */ }
    return null;
  }
  function _expFileGroups() {
    try {
      var t = window.qqqTabs;
      if (t && t.getGroups) {
        return (t.getGroups() || []).filter(function (g) { return g && g.type === 'file'; });
      }
    } catch (e) { /* */ }
    return [];
  }
  // 目标编辑器 → 所属文件分组下标（mountEl 归属优先；缺失按路径匹配、活动标签优先；无为 -1）
  function _expTargetGroupIdx(groups, target) {
    if (!target || !target.ed) { return -1; }
    var hold = null;
    try { hold = (target.mountEl && target.mountEl.closest) ? target.mountEl.closest('.qqq-tab-group') : null; } catch (e) { hold = null; }
    var i, k;
    for (i = 0; i < groups.length; i++) { if (hold && groups[i].el === hold) { return i; } }
    var fp = target.filePath ? String(target.filePath).replace(/\\/g, '/') : '';
    if (!fp) { return -1; }
    var anyHit = -1;
    for (i = 0; i < groups.length; i++) {
      var tabs = groups[i].tabs || [];
      for (k = 0; k < tabs.length; k++) {
        var tb = tabs[k];
        var tfp = (tb && tb.filePath) ? String(tb.filePath).replace(/\\/g, '/') : '';
        if (tfp !== fp) { continue; }
        if (tb.id === groups[i].activeTabId) { return i; }
        if (anyHit < 0) { anyHit = i; }
      }
    }
    return anyHit;
  }
  function _hingeRender(w, groups, fillIdx) {
    var n = (groups && groups.length) || 0;
    w._qqqGroups = (groups || []).slice();   // 点击/悬停按「看到的这一份」定位（渲染即绑定）
    while (w.children.length > n) { w.removeChild(w.lastChild); }
    while (w.children.length < n) { w.appendChild(document.createElement('i')); }
    for (var i = 0; i < w.children.length; i++) {
      var cls = (i === fillIdx) ? 'on' : '';
      if (!_expGroupOperable(groups[i])) { cls = cls ? cls + ' off' : 'off'; }
      w.children[i].className = cls;
    }
    w.className = 'qqq-tools-hinge' + (n === 1 ? ' single' : '');
    w.style.display = n > 0 ? '' : 'none';
  }
  function _buildHinge() {
    var w = document.createElement('span');
    w.className = 'qqq-tools-hinge';
    w.addEventListener('click', function (e) {
      e.stopPropagation();   // 不触发其它动作；面板保持打开
      var idx = -1;
      for (var i = 0; i < w.children.length; i++) { if (e.target === w.children[i]) { idx = i; break; } }
      if (idx >= 0) { _expPickGroup(w._qqqGroups && w._qqqGroups[idx]); }
    });
    // ★ 悬停方块 = 预览该分组的淡紫目标框（表达「点它将切到这里」；非可操作分组零框）
    w.addEventListener('mouseover', function (e) {
      var idx = -1;
      for (var i = 0; i < w.children.length; i++) { if (e.target === w.children[i]) { idx = i; break; } }
      if (idx >= 0) { _expOvShowGroup(w._qqqGroups && w._qqqGroups[idx]); }
    });
    _hingeEls.push(w);
    return w;
  }
  // 分组 → 其【活动标签】的编辑器挂载点（合页悬停预览 / 点方块聚焦共用）。
  // ★ 2026-10-04：禁跨标签回落——旧实现会回落到组内任意隐藏编辑器（活动标签是 kmd 的组也能找到
  //   「躲在后面」的文件编辑器）→ 聚焦隐藏编辑器 / 预览幻影目标；现在非文件活动标签 = 无挂载点。
  function _expGroupMount(g) {
    try {
      if (!g) { return null; }
      var tabs = g.tabs || [];
      var act = null;
      for (var k = 0; k < tabs.length; k++) { if (tabs[k] && tabs[k].id === g.activeTabId) { act = tabs[k]; break; } }
      if (!act || !act.filePath) { return null; }
      var pane = act.paneEl;
      var mount = (pane && pane.querySelector) ? pane.querySelector('[data-editor-mount]') : null;
      return mount || null;
    } catch (_) { /* */ }
    return null;
  }
  // 分组可操作性：活动标签为文件且编辑器存活（可点切换 / 可悬停预览 / 可亮紫框）
  function _expGroupOperable(g) {
    var mount = _expGroupMount(g);
    if (!mount) { return false; }
    var ed = mount._qqqEd;
    if (!ed) { return false; }
    try {
      var m = ed.getModel && ed.getModel();
      if (!m || (m.isDisposed && m.isDisposed())) { return false; }
    } catch (_) { return false; }
    return true;
  }
  function _expOvShowGroup(g) {
    if (!g || !_expGroupOperable(g)) { _expOvHide(); return; }
    var mount = _expGroupMount(g);
    if (!mount) { _expOvHide(); return; }
    _expOvShowRect(mount);
  }
  function _expPickGroup(g) {
    if (!g || !_expGroupOperable(g)) { return; }   // 非文件活动标签的分组 = 不可切换（禁聚焦隐藏编辑器）
    var mount = _expGroupMount(g);
    var ed = mount && mount._qqqEd;
    if (ed && ed.focus) { try { ed.focus(); } catch (e) { /* */ } }
    var re = function () { _refreshExportCards(); if (_expOvShown) { _expOvShow(); } };
    re();
    setTimeout(re, 60);   // 焦点事件落定后二次对齐（活跃编辑器机器更新）
  }
  function _refreshExportCards() {
    if (!_expCards.length) { return; }
    var groups = _expFileGroups();
    var target = _expResolve();
    var hasTarget = !!(target && target.ed);
    var fillIdx = _expTargetGroupIdx(groups, target);
    var name = '';
    if (target && target.filePath) { name = String(target.filePath).replace(/\\/g, '/').split('/').pop() || ''; }
    var nameLineExp = name ? ('\n\u25B8 ' + _T('workbench.exportWillExport', '即将导出：{0}', { 0: name })) : '';
    var nameLineOp = name ? ('\n\u25B8 ' + _T('workbench.opTargetTip', '即将操作：{0}', { 0: name })) : '';
    var idleLine = hasTarget ? '' : ('\n\u25B8 ' + _i('workbench.noTargetTab', '无目标文档（当前标签不是文件编辑器）'));
    for (var c = 0; c < _expCards.length; c++) {
      var _k = _expCards[c].kind;
      _expCards[c].el.title = _expCards[c].base + (_k === 'export' ? (nameLineExp || idleLine) : (nameLineOp || idleLine));
    }
    for (var h = 0; h < _hingeEls.length; h++) {
      _hingeRender(_hingeEls[h], groups, fillIdx);
      _hingeEls[h].title = _i('workbench.exportHingeTip', '实心 = 当前即将被操作的编辑分组（你最后在看的那个）；空心 = 另一个分组。点方块可切换目标；悬停操作类按钮或方块时，目标编辑区会亮起淡紫虚线框。') + (nameLineOp || idleLine);
    }
    // ★ 无目标 = 合页行整体不显示（2026-10-04 用户定案：没有可操作对象，指示不复存在）
    for (var r = 0; r < _hingeRows.length; r++) {
      try { _hingeRows[r].style.display = hasTarget ? '' : 'none'; } catch (_) { /* */ }
    }
    // ★ 无目标 = 文档操作类卡片置灰（点击恒如实拒绝；Savor/云同步/齿轮不属文档操作，保持可用）
    for (var d = 0; d < _dimEls.length; d++) {
      try { _dimEls[d].classList.toggle('qqq-tools-idle', !hasTarget); } catch (_) { /* */ }
    }
  }
  function _expOvEnsure() {
    if (_expOvEl && _expOvEl.parentNode) { return _expOvEl; }
    var d = document.createElement('div');
    d.id = 'qqq-export-target-overlay';
    d.style.cssText =
      'position:fixed;display:none;pointer-events:none;z-index:999998;' +
      'border:3px dashed #b57edc;border-radius:4px;' +
      'box-shadow:inset 0 0 0 2px rgba(181,126,220,0.12), 0 0 0 2px rgba(181,126,220,0.18);';
    document.body.appendChild(d);
    _expOvEl = d;
    return d;
  }
  function _expOvShow() {
    var t = _expResolve();
    _expOvShowRect(t && t.mountEl);
  }
  function _expOvShowRect(m) {
    if (!m || !m.getBoundingClientRect) { _expOvHide(); return; }
    var r = m.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { _expOvHide(); return; }
    var ov = _expOvEnsure();
    ov.style.left = r.left + 'px';
    ov.style.top = r.top + 'px';
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
    ov.style.display = 'block';
    _expOvShown = true;
  }
  function _expOvHide() {
    _expOvShown = false;
    if (_expOvEl) { try { _expOvEl.style.display = 'none'; } catch (e) { /* */ } }
  }
  function _expCardEnter() {
    _refreshExportCards();
    _expOvShow();
  }
  function _expCardLeave(e) {
    var rt = e && e.relatedTarget;
    if (rt) {
      for (var i = 0; i < _expCards.length; i++) {
        try { if (_expCards[i].el.contains(rt)) { return; } } catch (err) { /* */ }
      }
    }
    _expOvHide();
  }
  function _expWireCard(el, tipKey, tipFb, kind) {
    var base = _i(tipKey, tipFb);
    el.title = base;
    _expCards.push({ el: el, base: base, kind: kind || 'op' });
    el.addEventListener('mouseenter', _expCardEnter);
    el.addEventListener('mouseleave', _expCardLeave);
    return el;
  }
  // 诊断 / 单测入口（只读当前裁决态）
  function _expState() {
    var groups = _expFileGroups();
    var target = _expResolve();
    return {
      groups: groups.length,
      fillIdx: _expTargetGroupIdx(groups, target),
      filePath: (target && target.filePath) || '',
      hasMount: !!(target && target.mountEl),
      reason: (target && target.reason) || '',
    };
  }

  function _buildDocCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card';
    var h = document.createElement('div');
    h.className = 'qqq-tools-card-head';
    h.appendChild(_ico(_ICO_PEN));
    var t = document.createElement('span');
    t.className = 'qqq-tools-card-title';
    t.textContent = 'export doc';
    h.appendChild(t);
    var chips = document.createElement('div');
    chips.className = 'qqq-tools-chips';
    var bRtf = _chip('.doc', _i('export.docFormatRtf', '.doc 文档（兼容 Office 2003, RTF）'));
    var bDocx = _chip('.docx', _i('export.docFormatDocx', '.docx 文档 （支持 Google Docs/腾讯文档）'));
    bRtf.addEventListener('click', function (e) { e.stopPropagation(); _closeAll(); _callExport('doc', 'rtf'); });
    bDocx.addEventListener('click', function (e) { e.stopPropagation(); _closeAll(); _callExport('doc', 'docx'); });
    chips.appendChild(bRtf);
    chips.appendChild(bDocx);
    c.appendChild(h);
    c.appendChild(chips);
    _expWireCard(c, 'workbench.exportDocTip', '把当前文档导出为 Word 文件：图片与视频转成图片内嵌，其他附件生成清单；默认保存到文档旁，仅当同名文件已存在时才弹保存对话框。', 'export');
    _dimEls.push(c);
    return c;
  }

  function _buildZipCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card';
    c.addEventListener('click', function (e) { e.stopPropagation(); _closeAll(); _callExport('zip'); });
    var h = document.createElement('div');
    h.className = 'qqq-tools-card-head';
    h.appendChild(_ico(_ICO_ZIP));
    var t = document.createElement('span');
    t.className = 'qqq-tools-card-title';
    t.textContent = 'export Zip';
    h.appendChild(t);
    c.appendChild(h);
    _expWireCard(c, 'workbench.exportZipTip', '把当前文档及其引用的全部文件、目录打包成 ZIP（保留目录结构、最高压缩）；默认保存到文档旁，仅当同名文件已存在时才弹保存对话框。', 'export');
    _dimEls.push(c);
    return c;
  }

  // ★ 云同步 + 设置齿轮卡（2026-09-28 用户定案）：[↑][↓] 云同步按钮 100% 原样；原 "Cloud Sync" 文字位 =
  //   齿轮（老项目 .icon-all-settings 原版 path；20px · 卡片内居中稍偏左 · 正常文字色 currentColor = 非金色）→ 打开设置中心。
  var _ICO_GEAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22l-1.92 3.32c-.12.2-.07.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/></svg>';

  // 桥窗到设置中心（core/qqq-center.js）——未就绪（旧窗口/未刷新）时诚实提示
  function _centerOpen() {
    _closeAll();
    try {
      if (window.qqqCenter && window.qqqCenter.open) { window.qqqCenter.open(); return; }
    } catch (err) { /* */ }
    _qoast(_i('workbench.settingsNeedRestart', '设置中心未就绪（需刷新窗口）'), { type: 'info', duration: 5000 });
  }
  function _centerSync(mode) {
    try {
      if (window.qqqCenter && window.qqqCenter.doSync) { window.qqqCenter.doSync(mode); return; }
    } catch (err) { /* */ }
    _qoast(_i('workbench.settingsNeedRestart', '设置中心未就绪（需刷新窗口）'), { type: 'info', duration: 5000 });
  }

  function _buildGearCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card wide qqq-tools-flex';
    c.title = _i('workbench.cloudSyncTip', '云同步：↑ 上传 = 先与云端合并再上传（两边都不丢数据）；↓ 下载 = 把云端数据合并到本地。包含编辑器配置、各文件夹偏好、剪贴板历史。');
    c.addEventListener('click', function (e) { e.stopPropagation(); _centerOpen(); });
    var grp = document.createElement('div');
    grp.className = 'qqq-tools-btns';
    var bUp = _syncBtn(_SYNC_SVG_UP, _i('sync.uploadTitle', '上传到云端'));
    var bDown = _syncBtn(_SYNC_SVG_DOWN, _i('sync.downloadTitle', '下载云端数据'));
    bUp.addEventListener('click', function (e) { e.stopPropagation(); _centerSync('push'); });
    bDown.addEventListener('click', function (e) { e.stopPropagation(); _centerSync('pull'); });
    grp.appendChild(bUp);
    grp.appendChild(bDown);
    c.appendChild(grp);
    var ic = document.createElement('span');
    ic.className = 'qqq-tools-gear-ico';
    ic.title = _i('workbench.settingsTip', '打开 qqq 设置中心：云同步 + 全部偏好设置（性能/相框/观察者/导出…）');
    ic.innerHTML = _ICO_GEAR;
    c.appendChild(ic);
    return c;
  }


  // ════════════════════════════════════════════════════════════════════════
  // 视频 Url 行 / Paste / Pure / 合页行（2026-10-03 施工：待移植区三拆）
  // ════════════════════════════════════════════════════════════════════════

  // ── 视频 Url：历史收录（qgs.simple('qqq.videoUrl')，程序级 global.sq3；上限 20 条，新前旧后） ──
  //   ★ qgs 句柄全异步（get/set 恒返 Promise）——读取统一走「内存镜像 + 异步回填」：
  //   _vurlHist = 同步可读镜像（null = 未加载），_vurlHistLoad 拉权威值回填（在飞去重）；
  //   写侧先确保镜像就绪再合并写出（未加载即写会覆盖旧历史——「记忆丢失」曾根因）。
  var _VURL_HIST_MAX = 20;   // 历史上限（= 下拉最多展示条数；2026-10-04 用户定案 10→20）
  var _vurlHist = null;
  var _vurlHistP = null;
  function _videoHistoryHandle() {
    try { return (window.qgs && window.qgs.simple) ? window.qgs.simple('qqq.videoUrl', { cloud: false }) : null; } catch (_) { return null; }
  }
  function _vurlHistNorm(v) {
    var out = [];
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length && out.length < _VURL_HIST_MAX; i++) {
        if (typeof v[i] === 'string' && v[i] && out.indexOf(v[i]) === -1) { out.push(v[i]); }
      }
    }
    return out;
  }
  function _vurlHistLoad(cb) {
    if (_vurlHist !== null) { if (cb) { cb(); } return; }
    var h = _videoHistoryHandle();
    if (!h) { _vurlHist = []; if (cb) { cb(); } return; }
    if (!_vurlHistP) {
      try {
        _vurlHistP = Promise.resolve(h.get('history')).then(function (v) {
          _vurlHist = _vurlHistNorm(v);
        }, function () {
          _vurlHist = [];
        }).then(function () { _vurlHistP = null; });
      } catch (_) { _vurlHistP = null; _vurlHist = []; }
    }
    if (cb) { if (_vurlHistP) { _vurlHistP.then(cb); } else { cb(); } }
  }
  function _videoHistoryGet() { return _vurlHist || []; }
  function _videoHistoryPush(url) {
    var h = _videoHistoryHandle();
    if (!h) { return; }
    var commit = function () {
      var list = _videoHistoryGet().filter(function (x) { return x !== url; });
      list.unshift(url);
      if (list.length > _VURL_HIST_MAX) { list = list.slice(0, _VURL_HIST_MAX); }
      _vurlHist = list;
      try {
        var p = h.setNow ? h.setNow('history', list) : h.set('history', list);
        if (p && p.catch) { p.catch(function () { /* */ }); }
      } catch (_) { /* */ }
    };
    _vurlHistLoad(commit);
  }
  function _looksHttpUrl(u) {
    var s = String(u || '').trim();
    if (!s || s.length > 2048) { return false; }
    return /^https?:\/\/\S+$/i.test(s);
  }
  function _vurlDropHide() {
    if (!_vurlDropEl) { return; }
    try { _vurlDropEl.style.display = 'none'; } catch (e) { /* */ }
    try { if (_vurlDropEl.parentNode) { _vurlDropEl.parentNode.removeChild(_vurlDropEl); } } catch (e) { /* */ }
  }
  // 历史下拉（2026-10-04 用户定案：输入框正下方紧贴 +1px、与输入行同宽、最多 20 条；行悬停恒 --gold-hover-bg）
  //   ★ 定位 = fixed + 节点挂 body——菜单是 overflow:auto 滚动容器且带 transform（fixed 子级会变菜单
  //   局部坐标系并遭下缘裁剪，20 条下拉必被切断）；下探空间不足 → max-height 钳到视口底、内部滚动。
  //   ★ 镜像异步回填：先确保加载完成再渲染；渲染前复核「面板在 / 框空 / 框聚焦」——
  //   加载期间用户已输入或已离开则不弹（防迟到下拉残影）。
  function _vurlDropPlace() {
    if (!_vurlDropEl || !_vurlInputEl) { return; }
    try {
      var anchor = (_vurlRowEl && _vurlRowEl.isConnected) ? _vurlRowEl : _vurlInputEl;
      var rr = anchor.getBoundingClientRect();
      _vurlDropEl.style.left = Math.round(rr.left) + 'px';
      _vurlDropEl.style.width = Math.round(rr.width) + 'px';
      _vurlDropEl.style.top = Math.round(rr.bottom + 1) + 'px';
      _vurlDropEl.style.maxHeight = Math.max(44, Math.round(window.innerHeight - rr.bottom - 9)) + 'px';
    } catch (e) { /* */ }
  }
  function _vurlDropShow() {
    if (!_vurlDropEl || !_vurlInputEl) { return; }
    _vurlHistLoad(_vurlDropRender);
  }
  function _vurlDropRender() {
    if (!_vurlDropEl || !_vurlInputEl || !_rootEl) { return; }
    try {
      if (String(_vurlInputEl.value || '') !== '' || document.activeElement !== _vurlInputEl) { return; }
    } catch (_) { /* */ }
    var list = _videoHistoryGet();
    if (!list.length) { _vurlDropHide(); return; }
    _vurlDropEl.textContent = '';
    for (var i = 0; i < list.length; i++) {
      (function (val) {
        var it = document.createElement('div');
        it.className = 'qqq-tools-vurl-item';
        it.textContent = val;
        it.title = val;
        it.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 保输入框焦点（防 blur 先行）
        it.addEventListener('click', function (e) {
          e.stopPropagation();
          try {
            _vurlInputEl.value = val;
            _vurlInputEl.classList.remove('invalid');
            _vurlInputEl.focus();
            _vurlInputEl.setSelectionRange(val.length, val.length);
          } catch (_) { /* */ }
          _vurlDropHide();
        });
        _vurlDropEl.appendChild(it);
      })(list[i]);
    }
    try { if (_vurlDropEl.parentNode !== document.body) { document.body.appendChild(_vurlDropEl); } } catch (_) { /* */ }
    _vurlDropPlace();
    _vurlDropEl.style.display = 'block';
    // 菜单开合过渡（transform translateY 0.12s）落定后复测一次（防开面板瞬间聚焦量到过渡中坐标）
    setTimeout(function () { if (_vurlDropEl && _vurlDropEl.style.display === 'block') { _vurlDropPlace(); } }, 150);
  }
  function _videoInvalidFlash(msg) {
    if (!_vurlInputEl) { return; }
    try { _vurlInputEl.classList.add('invalid'); } catch (_) { /* */ }
    if (_vurlTipEl) {
      _vurlTipEl.textContent = msg || '';
      _vurlTipEl.style.display = 'block';
      if (_vurlTipTimer) { clearTimeout(_vurlTipTimer); }
      _vurlTipTimer = setTimeout(function () {
        _vurlTipTimer = null;
        try { _vurlTipEl.style.display = 'none'; } catch (_) { /* */ }
        try { _vurlInputEl.classList.remove('invalid'); } catch (_) { /* */ }
      }, 2400);
    }
    try { _vurlInputEl.focus(); } catch (_) { /* */ }
  }
  // 回车 = ▶ = 确认开始下载（目标闸 → 校验 → 收录历史 → 清框 → 同一条 URL 粘贴机器）
  // ★ 2026-10-04（q400 用户定案）：目标闸必须先于输入检查——旧实现空输入直接静默 return，
  //   造成「置灰（无目标）时点 ▶ / 回车零反馈」；现在与 Paste/Pure/导出完全一致：无目标恒如实 qoast。
  function _videoSubmit() {
    var inp = _vurlInputEl;
    if (!inp) { return; }
    var t = _expResolve();
    if (!t || !t.ed) {
      _qoast((t && t.reason === 'custom-tab') ? _i('workbench.noTargetTab', '无目标文档（当前标签不是文件编辑器）') : _i('workbench.noTargetDoc', '没有可操作的目标文档（先打开一个已保存的文件）'), { type: 'info', duration: 5000 });
      return;
    }
    var url = String(inp.value || '').trim();
    if (!url) {
      _qoast(_i('workbench.videoUrlEmpty', '请先输入视频/网页网址'), { type: 'info', duration: 5000 });
      try { inp.focus(); } catch (_) { /* */ }
      return;
    }
    if (!_looksHttpUrl(url)) {
      _videoInvalidFlash(_i('workbench.videoUrlInvalid', '网址无效（需以 http:// 或 https:// 开头的完整链接）'));
      return;
    }
    var pr = window.qqqPasteRouter;
    if (!pr || !pr.pasteUrlInto) {
      _qoast(_i('workbench.needRestart', '此功能未就绪（请刷新窗口；壳层更新后需重启实例）'), { type: 'info', duration: 6000 });
      return;
    }
    _videoHistoryPush(url);
    inp.value = '';
    try { inp.classList.remove('invalid'); } catch (_) { /* */ }
    _vurlDropHide();
    try { inp.blur(); } catch (_) { /* */ }
    var p = null;
    try { p = pr.pasteUrlInto(t.ed, url); } catch (e) { p = null; }
    if (p && p.then) {
      p.then(function (res) {
        if (res === 'no_dir') { _qoast(_i('workbench.noTargetDir', '目标文档未保存到磁盘（媒体需要落盘到文档旁的 _qqqvault）'), { type: 'info', duration: 6000 }); }
        else if (res === 'no_editor') { _qoast(_i('workbench.noTargetDoc', '没有可操作的目标文档（先打开一个已保存的文件）'), { type: 'info', duration: 5000 }); }
        else if (res === 'invalid') { _qoast(_i('workbench.videoUrlInvalid', '网址无效（需以 http:// 或 https:// 开头的完整链接）'), { type: 'info', duration: 5000 }); }
      }).catch(function () { /* 管线内部已如实报错（ioast/qoast） */ });
    }
  }
  function _buildVideoRow() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-video-card';
    var row = document.createElement('div');
    row.className = 'qqq-tools-vurl-row';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'qqq-tools-vurl';
    inp.placeholder = 'Video Url';
    inp.spellcheck = false;
    try { inp.setAttribute('autocomplete', 'off'); } catch (_) { /* */ }
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'qqq-tools-vurl-go';
    go.title = _i('workbench.videoUrlGo', '开始下载（= 回车）');
    go.appendChild(_ico(_ICO_PLAY));
    var drop = document.createElement('div');
    drop.className = 'qqq-tools-vurl-drop';
    var tip = document.createElement('div');
    tip.className = 'qqq-tools-vurl-tip';
    tip.style.display = 'none';
    row.appendChild(inp);
    row.appendChild(go);
    c.appendChild(row);
    c.appendChild(drop);   // 初始挂点；_vurlDropRender 展示时改挂 body（见 _vurlDropPlace 注释）
    c.appendChild(tip);
    _vurlRowEl = row;
    _vurlInputEl = inp;
    _vurlDropEl = drop;
    _vurlTipEl = tip;

    inp.addEventListener('focus', function () { if (!inp.value) { _vurlDropShow(); } });
    inp.addEventListener('input', function () {
      _vurlDropHide();
      try { inp.classList.remove('invalid'); } catch (_) { /* */ }
      if (tip) { tip.style.display = 'none'; }
      if (!inp.value) { _vurlDropShow(); }   // 清空即回看历史（老 q3 语义：空框重拉历史）
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); _videoSubmit(); }
      else if (e.key === 'Escape') { _vurlDropHide(); }
    });
    // 老行为：右键 = 读取剪贴板文本填入（Electron 生产态无默认右键菜单）
    inp.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      (async function () {
        try {
          var b = window.qqqideBridge;
          var t2 = (b && b.clipboard && b.clipboard.readText) ? await b.clipboard.readText() : '';
          if (t2) {
            inp.value = String(t2);
            try { inp.classList.remove('invalid'); } catch (_) { /* */ }
            inp.focus();
            try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) { /* */ }
            _vurlDropHide();
          }
        } catch (_) { /* */ }
      })();
    });
    inp.addEventListener('blur', function () {
      if (!_pointerInside) { _scheduleAll(); }   // 未在输入中且指针在外 → 恢复正常收面板节拍
      setTimeout(function () {
        try { if (document.activeElement !== inp) { _vurlDropHide(); } } catch (_) { /* */ }
      }, 160);
    });
    drop.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 点下拉不夺输入焦点
    go.addEventListener('click', function (e) { e.stopPropagation(); _videoSubmit(); });
    c.addEventListener('click', function (e) {
      // 点行内空白（非按钮/下拉/提示）→ 聚焦输入框（老 videoCard 语义）
      var tg = e.target;
      if (tg === inp) { return; }
      try {
        if (tg && tg.closest && tg.closest('.qqq-tools-vurl-go, .qqq-tools-vurl-drop, .qqq-tools-vurl-tip')) { return; }
      } catch (_) { /* */ }
      try { inp.focus(); } catch (_) { /* */ }
    });
    _expWireCard(c, 'workbench.videoUrlTip', '输入视频/网页网址 → 回车或点 ▶：直链直接下载；平台/分片视频自动走 yt-dlp；普通网页自动抓取嗅探视频。下载到目标文档旁的 _qqqvault 并插入相框；历史自动收录（空输入框聚焦回看）。', 'op');
    _dimEls.push(c);
    return c;
  }

  // ── Paste Plain Text：纯文本粘贴（只取剪贴板文字；富粘贴归编辑器右键 / Ctrl+V，不重复） ──
  function _doPasteText() {
    var t = _expResolve();
    if (!t || !t.ed) {
      _qoast((t && t.reason === 'custom-tab') ? _i('workbench.noTargetTab', '无目标文档（当前标签不是文件编辑器）') : _i('workbench.noTargetDoc', '没有可操作的目标文档（先打开一个已保存的文件）'), { type: 'info', duration: 5000 });
      return;
    }
    var pr = window.qqqPasteRouter;
    if (!pr || !pr.pasteTextInto) {
      _qoast(_i('workbench.needRestart', '此功能未就绪（请刷新窗口；壳层更新后需重启实例）'), { type: 'info', duration: 6000 });
      return;
    }
    _closeAll();
    var p = null;
    try { p = pr.pasteTextInto(t.ed); } catch (e) { p = null; }
    if (p && p.then) {
      p.then(function (res) {
        if (res === 'no_text') { _qoast(_i('workbench.pasteTextEmpty', '剪贴板里没有文本（纯文本粘贴只读取文字内容）'), { type: 'info', duration: 5000 }); }
        else if (res === 'need_bridge') { _qoast(_i('workbench.needRestart', '此功能未就绪（请刷新窗口；壳层更新后需重启实例）'), { type: 'info', duration: 6000 }); }
        else if (res === 'no_editor') { _qoast(_i('workbench.noTargetDoc', '没有可操作的目标文档（先打开一个已保存的文件）'), { type: 'info', duration: 5000 }); }
      }).catch(function () { /* 管线内部已如实报错 */ });
    }
  }
  function _buildPasteChip() {
    var b = _chip('Paste Plain Text', '', _ICO_PASTE);
    b.classList.add('qqq-tools-bigbtn');
    b.addEventListener('click', function (e) { e.stopPropagation(); _doPasteText(); });
    _expWireCard(b, 'workbench.pasteTextTip', '把剪贴板里的纯文本原样插入目标文档（粘贴为纯文本）：不转换网页富文本、不下载图片、不处理文件与网址；需要富粘贴时用编辑器右键 / Ctrl+V。', 'op');
    _dimEls.push(b);
    return b;
  }

  // ── Pure：孤儿扫描出审阅清单（core/qqq-pure.js；绝不自动删除） ──
  var _pureBusyUi = false;
  function _doPure() {
    var t = _expResolve();
    if (!t || !t.ed || !t.filePath) {
      _qoast((t && t.reason === 'custom-tab') ? _i('workbench.noTargetTab', '无目标文档（当前标签不是文件编辑器）') : _i('workbench.pureNoTarget', 'Pure 需要一个已保存的目标文档（先在编辑器里打开一个文件）'), { type: 'info', duration: 6000 });
      return;
    }
    var pu = window.qqqPure;
    if (!pu || !pu.run) {
      _qoast(_i('workbench.needRestart', '此功能未就绪（请刷新窗口；壳层更新后需重启实例）'), { type: 'info', duration: 6000 });
      return;
    }
    if (_pureBusyUi) { return; }
    _pureBusyUi = true;
    _closeAll();
    var slowTimer = setTimeout(function () {
      _qoast(_i('workbench.pureRunning', 'Pure：正在扫描 _qqqvault…'), { type: 'info', duration: 4000 });
    }, 1200);
    function _fin() { if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; } _pureBusyUi = false; }
    var p = null;
    try { p = pu.run(t.filePath); } catch (e) { p = null; }
    if (!(p && p.then)) { _fin(); return; }
    p.then(function (res) {
      _fin();
      if (!res || !res.ok) {
        var r = (res && res.reason) || '';
        if (r === 'no_vault') { _qoast(_i('workbench.pureNoVault', '该目录下没有 _qqqvault（还没有粘贴过文件）'), { type: 'info', duration: 6000 }); }
        else if (r === 'write_fail') { _qoast(_T('workbench.pureFail', 'Pure 扫描失败：{msg}', { msg: (res && res.error) || '?' }), { type: 'error', duration: 8000 }); }
        else if (r === 'no_dir') { _qoast(_i('workbench.pureNoTarget', 'Pure 需要一个已保存的目标文档（先在编辑器里打开一个文件）'), { type: 'info', duration: 6000 }); }
        else if (r === 'no_bridge') { _qoast(_i('workbench.needRestart', '此功能未就绪（请刷新窗口；壳层更新后需重启实例）'), { type: 'info', duration: 6000 }); }
        /* 'busy'：并发点击静默 */
        return;
      }
      if (res.count > 0) {
        _qoast(_T('workbench.pureDone', '发现 {n} 个孤儿项 · 清单已生成（_qqqvault.pure，不会自动删除）', { n: res.count }), { type: 'success', duration: 9000 });
      } else {
        _qoast(_T('workbench.pureNone', '没有孤儿项（扫描了 {files} 个文档 · {items} 个 _qqqvault 项）', { files: res.scanned, items: res.items }), { type: 'info', duration: 7000 });
      }
    }).catch(function (e2) {
      _fin();
      _qoast(_T('workbench.pureFail', 'Pure 扫描失败：{msg}', { msg: String((e2 && e2.message) || e2) }), { type: 'error', duration: 8000 });
    });
  }
  function _buildPureChip() {
    var b = _chip('Pure', _i('workbench.pureTip', '扫描目标文档旁的 _qqqvault：找出未被本目录任何文档引用的孤儿文件，生成 _qqqvault.pure 审阅清单（只生成清单，绝不自动删除）。'), _ICO_PURE);
    b.classList.add('qqq-tools-bigbtn');
    b.addEventListener('click', function (e) { e.stopPropagation(); _doPure(); });
    _dimEls.push(b);
    return b;
  }

  // ── 合页指示器专用行（正中一枚；无按钮——一切上方按钮的操作对象即它） ──
  function _buildHingeRow() {
    var row = document.createElement('div');
    row.className = 'qqq-tools-hinge-row';
    row.appendChild(_buildHinge());
    _expWireCard(row, 'workbench.exportHingeTip', '实心 = 当前即将被操作的编辑分组（你最后在看的那个）；空心 = 另一个分组。点方块可切换目标；悬停操作类按钮或方块时，目标编辑区会亮起淡紫虚线框。', 'hinge');
    _hingeRows.push(row);
    return row;
  }

  // ── 主面板 ──
  function _buildRoot() {
    var root = document.createElement('div');
    root.className = 'qqq-tools-menu';
    root.addEventListener('mouseenter', function () { _pointerInside = true; _clearTimers(); });
    root.addEventListener('mouseleave', function () { _pointerInside = false; _scheduleAll(); });
    // 面板内容滚动 → 历史下拉（挂 body/fixed）跟随输入行走（capture：scroll 不冒泡）
    root.addEventListener('scroll', function () { if (_vurlDropEl && _vurlDropEl.style.display === 'block') { _vurlDropPlace(); } }, true);

    var grid = document.createElement('div');
    grid.className = 'qqq-tools-grid';

    // 零分组标题行——纯卡片连续流（分组靠布局差异区分：宽卡 / 双半宽卡 / 专用行）
    grid.appendChild(_buildSavorCard());
    grid.appendChild(_buildDocCard());
    grid.appendChild(_buildZipCard());
    grid.appendChild(_buildGearCard());
    grid.appendChild(_buildVideoRow());     // 视频 Url：整行（输入框 + ▶）
    grid.appendChild(_buildPasteChip());    // Paste Plain Text ⎮ Pure 平分左右
    grid.appendChild(_buildPureChip());
    grid.appendChild(_buildHingeRow());     // 合页专用行（正中一枚，无按钮）

    _refreshExportCards();   // 合页指示器 + 「即将操作」tooltip（打开即对齐当前目标）

    root.appendChild(grid);
    return root;
  }

  function _showRoot() {
    if (_rootEl && _rootEl.parentNode) { return; }
    if (!_btnEl) { return; }
    _ensureStyle();
    _removeRoot();
    var root = _buildRoot();
    document.body.appendChild(root);
    _rootEl = root;
    var r = _btnEl.getBoundingClientRect();
    var w = root.offsetWidth || PANEL_W, h = root.offsetHeight || 320;
    var left = r.left;
    if (left + w > window.innerWidth - 8) { left = window.innerWidth - w - 8; }
    if (left < 8) { left = 8; }
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) { top = Math.max(4, r.top - h - 4); }
    root.style.left = left + 'px';
    root.style.top = top + 'px';
    requestAnimationFrame(function () { if (_rootEl) { _rootEl.classList.add('open'); } });
    if (_btnEl) { _btnEl.classList.add('qqq-tools-open'); }
    _pointerInside = true;   // 开面板时指针在按钮上；进面板 mouseenter 续，出面板 mouseleave 断
    _bindGlobal();
  }

  function _removeRoot() {
    if (_rootEl) { try { _rootEl.remove(); } catch (e) { } _rootEl = null; }
    _unbindSavorState();
    _savorCardEl = null;
    _savorLabelEl = null;
    _expCards = [];
    _hingeEls = [];
    _hingeRows = [];
    _dimEls = [];
    if (_vurlDropEl) { try { if (_vurlDropEl.parentNode) { _vurlDropEl.parentNode.removeChild(_vurlDropEl); } } catch (e) { /* */ } }
    _vurlRowEl = null;
    _vurlInputEl = null;
    _vurlDropEl = null;
    _vurlTipEl = null;
    if (_vurlTipTimer) { clearTimeout(_vurlTipTimer); _vurlTipTimer = null; }
    _pointerInside = false;
    _expOvHide();
  }

  function _closeAll() {
    _clearTimers();
    _removeRoot();
    if (_btnEl) { try { _btnEl.classList.remove('qqq-tools-open'); } catch (e) { } }
    _unbindGlobal();
  }

  // ── 挂载（gaea-host renderTabBar 调用；须在 help 挂载之前调用 → 按钮落在 help 左边）──
  function mount(tabBarEl) {
    if (!tabBarEl) { return; }
    _closeAll();
    if (_btnEl && _btnEl.parentNode === tabBarEl) { return; }
    _ensureStyle();
    var btn = document.createElement('button');
    btn.className = 'gaea-tab-btn qqq-tools-btn';
    btn.textContent = 'qqq';
    btn.style.cssText =
      'height:22px; padding:0 10px; margin:0 1px; border:1px solid var(--border-color); border-radius:3px;' +
      'background:transparent; color:var(--text-primary); font-size:12px;' +
      'transition: background 0.15s;';
    btn.addEventListener('mouseenter', function () { _clearTimers(); _showRoot(); });
    btn.addEventListener('mouseleave', _scheduleAll);
    tabBarEl.appendChild(btn);
    _btnEl = btn;
  }

  window.qqqToolsMenu = { mount: mount, close: _closeAll, expTarget: _expState };
})();
