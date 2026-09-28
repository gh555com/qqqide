// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-tools.js — 菜单行2 "qqq" 按钮（help 左边）· hover = "qqq 工作台"操作面板
//
// 结构（2026-09-22 工作台改版：由「文本下拉列表」升级为「卡片式操作面板」）:
//   ┌───────────────────────────────────────────────────────┐
//   │  [♾][■] Savor moments for yourself                    │  ← 老 q3 savorCard 100%
//   │  [✎ export doc]        [🗜 export Zip]                │
//   │  [ .doc ][ .docx ]                                    │
//   │  [↑][↓] ⚙（齿轮·点击开设置中心）                       │  ← [↑][↓] 云同步（老 qqq AQ 100%）+ 齿轮开「qqq 设置中心」
//   │  [⏮][⏯][⏭] Player · 轨名 n/N            [−][✕]        │  ← 播放槽（空闲=[↗][⧈]；活跃=控制台）
//   │  [▶ Video Url] [✎ Paste] [✦ Pure]                     │  ← 占位（待移植）
//   └───────────────────────────────────────────────────────┘
//   2026-09-22 二次改版: 移除 SOUND/EXPORT/DATA/SOON 分割行——纯卡片连续流。
//   2026-09-22 三次改版（用户定案）: 标题行 "qqq workbench" 删除 + 副行小字全删；
//   主文字随按钮垂直居中 + 卡片纵向空间回收（6px 紧凑内边距，"更扁 = 看上去更宽"）；
//   被删小字的说明职责全部转 hover tooltip：本地语言（i18n workbench.* 段）+ 详细。
//   2026-09-22 四次微调（用户定案）: Savor 卡内统计行删除（副行归零 → 主文字真垂直居中）；
//   统计恒归 hover（本地语言清晰版、悬停即时刷新；「不解释，直接放核心信息」）；面板总宽 -20%（438→350px）。
//   2026-09-28 改版（用户定案 · 设置本地化）: Cloud Sync 卡保留原尺寸——[↑][↓] 云同步按钮 100% 原样
//   （老 qqq AQ 语义）；原 "Cloud Sync" 文字位 → 小号齿轮（16px · 正常文字色 = 非金色）；点击（或整卡点击）
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
//               = 点击打开「qqq 设置中心」（core/qqq-center.js：云同步 + 设置全量本地化）
//   Player       空闲 = [↗ 独立窗][⧈ 窗内]；会话活跃（卡可见/被收纳）= 播放控制台（[⏮][⏯][⏭] + 轨名 + [收纳/展开][✕]）
//                ——收纳态（卡.stow）下本槽 = 播放器唯一遥控入口（qqq 按钮 ♪ 徽标）；状态存 player-state.json card.stow
//   Video Url / Paste / Pure → 占位 chips（点击提示待移植）
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
  var _ICO_PLAY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
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
      '.qqq-tools-btn.qqq-player-stowed::after { content: "♪"; position: absolute; top: -5px; right: -2px; font-size: 9px; line-height: 1; color: var(--primary-color, #b58900); pointer-events: none; }',
      '.qqq-player-row .qqq-tools-card-body { display: flex; align-items: center; min-width: 0; }',
      '.qqq-player-row .qqq-tools-card-title { flex: 1 1 auto; min-width: 0; }',
      '.qqq-pl-count { flex: 0 0 auto; margin-left: 6px; font-size: 11px; color: var(--text-secondary, #93a1a1); }',
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
      '.qqq-tools-gear-ico { display: inline-flex; align-items: center; justify-content: center; color: var(--text-primary, #586e75); flex-shrink: 0; transition: transform .15s ease; }',
      '.qqq-tools-gear-ico svg { display: block; }',
      '.qqq-tools-card:hover .qqq-tools-gear-ico { transform: scale(1.1); }',
      '.qqq-tools-card.qqq-tools-flex { display: flex; align-items: center; gap: 10px; }',
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
      '.qqq-tools-soon { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }',
      '.qqq-tools-soon .qqq-tools-chip { border-style: dashed; opacity: .5; padding: 6px 6px; }',
      '.qqq-tools-soon .qqq-tools-chip:hover { opacity: .85; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── 计时器 / 全局收尾 ──
  function _clearTimers() {
    if (_allTimer) { clearTimeout(_allTimer); _allTimer = null; }
  }
  function _scheduleAll() {
    _clearTimers();
    _allTimer = setTimeout(_closeAll, HOVER_CLOSE_DELAY);
  }
  function _containsAny(t) {
    if (!t) { return false; }
    if (_rootEl && _rootEl.contains(t)) { return true; }
    if (_btnEl && _btnEl.contains(t)) { return true; }
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

  function _pendingClick(label) {
    _closeAll();
    _qoast(_i('export.pending', '此功能待移植（先占位）') + ' — ' + label, { type: 'info', duration: 5000 });
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

  function _buildDocCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card';
    c.title = _i('workbench.exportDocTip', '把当前文档导出为 Word 文件：图片与视频转成图片内嵌，其他附件生成清单；默认保存到文档旁，仅当同名文件已存在时才弹保存对话框。');
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
    return c;
  }

  function _buildZipCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card';
    c.title = _i('workbench.exportZipTip', '把当前文档及其引用的全部文件、目录打包成 ZIP（保留目录结构、最高压缩）；默认保存到文档旁，仅当同名文件已存在时才弹保存对话框。');
    c.addEventListener('click', function (e) { e.stopPropagation(); _closeAll(); _callExport('zip'); });
    var h = document.createElement('div');
    h.className = 'qqq-tools-card-head';
    h.appendChild(_ico(_ICO_ZIP));
    var t = document.createElement('span');
    t.className = 'qqq-tools-card-title';
    t.textContent = 'export Zip';
    h.appendChild(t);
    c.appendChild(h);
    return c;
  }

  // ★ 云同步 + 设置齿轮卡（2026-09-28 用户定案）：[↑][↓] 云同步按钮 100% 原样；原 "Cloud Sync" 文字位 =
  //   小号齿轮（老项目 .icon-all-settings 原版 path；16px · 正常文字色 currentColor = 非金色）→ 打开设置中心。
  var _ICO_GEAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22l-1.92 3.32c-.12.2-.07.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/></svg>';

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

  // ★ 播放槽（2026-09-28 q319 v7）：空闲 = [↗] 独立悬浮播放器窗（A）/ [⧈] 窗内播放器卡（B）双入口（二选一，共用同一播放会话）；
  //   会话活跃（卡可见/被收纳）= 播放控制台 [⏮][⏯][⏭] + 轨名 n/N + [收纳/展开][✕]——收纳态下 = 播放器唯一遥控入口
  var _PL_SVG_WIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';
  var _PL_SVG_CARD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H5V8h14v10z"/></svg>';
  var _PL_SVG_PREV = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 6h2v12H6z"/><path d="M9.5 12l8.5 6V6z"/></svg>';
  var _PL_SVG_NEXT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M16 6h2v12h-2z"/><path d="M6 6l8.5 6L6 18z"/></svg>';
  var _PL_SVG_PLAY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var _PL_SVG_PAUSE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  var _PL_SVG_MIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19h12v2H6z"/></svg>';
  var _PL_SVG_REST = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21 11V3h-8v2h4.59L12 10.59l1.41 1.41L19 6.41V11h2zM3 13v8h8v-2H6.41L12 13.41l-1.41-1.41L5 17.59V13H3z"/></svg>';
  var _PL_SVG_CLOSE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  var _plRowEl = null, _plRowMode = '';
  var _plTitleEl = null, _plCountEl = null, _plPrevB = null, _plPlayB = null, _plNextB = null, _plToggleB = null;
  var _plEvtBound = false;

  function _plInfo() {
    try { return (window.qqqPlayerCard && window.qqqPlayerCard.getInfo) ? window.qqqPlayerCard.getInfo() : null; } catch (e) { return null; }
  }
  function _plCmd(a) {
    try { if (window.qqqPlayerCard && window.qqqPlayerCard.cmd) { window.qqqPlayerCard.cmd(a); } } catch (e) { }
  }
  function _onPlayerState() { if (_plRowEl) { _renderPlayerRow(); } }
  function _bindPlayerState() { if (_plEvtBound) { return; } _plEvtBound = true; window.addEventListener('qqq-player-state', _onPlayerState); }
  function _unbindPlayerState() { if (!_plEvtBound) { return; } _plEvtBound = false; window.removeEventListener('qqq-player-state', _onPlayerState); }

  function _plMiniBtn(svg, title, cls) {
    var b = _syncBtn(svg, title);
    if (cls) { b.classList.add(cls); }
    return b;
  }
  // ★ 动态图标按钮（2026-09-28 q319 v7）：预建全部图标槽，仅切 display——禁 innerHTML 换节点
  //   （探针实锤：鼠标跨入 Player 行触发 mouseenter 重渲染换节点时，紧随其后的整串点击事件被输入管线吞掉——ZERO 事件）
  function _plIconBtn(icons, title, cls) {
    var b = document.createElement('button');
    b.className = 'qqq-tools-mini-btn';
    if (cls) { b.classList.add(cls); }
    b.title = title || '';
    for (var i = 0; i < icons.length; i++) {
      var ic = document.createElement('span');
      ic.className = 'qqq-tools-ico-svg';
      if (i > 0) { ic.style.display = 'none'; }
      ic.innerHTML = icons[i];
      b.appendChild(ic);
    }
    return b;
  }
  function _plSetIcon(btn, idx) {
    if (!btn) { return; }
    var kids = btn.children;
    for (var i = 0; i < kids.length; i++) {
      try { kids[i].style.display = (i === idx) ? '' : 'none'; } catch (e) { }
    }
  }
  function _buildPlayerIdle(c) {
    var grp = document.createElement('div');
    grp.className = 'qqq-tools-btns';
    var bWin = _syncBtn(_PL_SVG_WIN, _i('workbench.playerWinTip', '独立悬浮播放器窗：置顶小窗——切到别的程序也看得见（↗）'));
    var bCard = _syncBtn(_PL_SVG_CARD, _i('workbench.playerCardTip', '窗内播放器：悬浮在 qqqide 窗口里的播放器卡——跟随本窗口（⧈）'));
    bWin.addEventListener('click', function (e) {
      e.stopPropagation();
      _closeAll();
      try {
        var b = window.qqqideBridge;
        if (b && b.player && b.player.open) { b.player.open(); }
        else { _qoast(_i('workbench.playerNeedRestart', '悬浮播放器需要重启实例后可用'), { type: 'info', duration: 4000 }); }
      } catch (err) { }
    });
    bCard.addEventListener('click', function (e) {
      e.stopPropagation();
      _closeAll();
      try {
        if (window.qqqPlayerCard) { window.qqqPlayerCard.open(); }
        else { _qoast(_i('workbench.playerNeedRestart', '悬浮播放器需要重启实例后可用'), { type: 'info', duration: 4000 }); }
      } catch (err) { }
    });
    grp.appendChild(bWin);
    grp.appendChild(bCard);
    var body = document.createElement('div');
    body.className = 'qqq-tools-card-body';
    var t = document.createElement('div');
    t.className = 'qqq-tools-card-title';
    t.textContent = 'Player';
    body.appendChild(t);
    c.appendChild(grp);
    c.appendChild(body);
  }
  function _buildPlayerConsole(c) {
    var grp = document.createElement('div');
    grp.className = 'qqq-tools-btns';
    _plPrevB = _plMiniBtn(_PL_SVG_PREV, _i('shell.overlay.mprev', '上一个'), 'qqq-pl-prev');
    _plPlayB = _plIconBtn([_PL_SVG_PAUSE, _PL_SVG_PLAY], _i('shell.overlay.mpause', '暂停'), 'qqq-pl-play');   // 0=暂停图标(在播) / 1=播放图标
    _plNextB = _plMiniBtn(_PL_SVG_NEXT, _i('shell.overlay.mnext', '下一个'), 'qqq-pl-next');
    _plPrevB.addEventListener('click', function (e) { e.stopPropagation(); _plCmd('prev'); });
    _plPlayB.addEventListener('click', function (e) { e.stopPropagation(); _plCmd('toggle'); });
    _plNextB.addEventListener('click', function (e) { e.stopPropagation(); _plCmd('next'); });
    grp.appendChild(_plPrevB);
    grp.appendChild(_plPlayB);
    grp.appendChild(_plNextB);
    var body = document.createElement('div');
    body.className = 'qqq-tools-card-body';
    _plTitleEl = document.createElement('div');
    _plTitleEl.className = 'qqq-tools-card-title';
    _plCountEl = document.createElement('span');
    _plCountEl.className = 'qqq-pl-count';
    body.appendChild(_plTitleEl);
    body.appendChild(_plCountEl);
    body.addEventListener('click', function (e) {   // 点文字 = 展开（与 Savor「点文字=主操作」同规）
      e.stopPropagation();
      var inf = _plInfo();
      if (inf && inf.stow && window.qqqPlayerCard) { try { window.qqqPlayerCard.stow(false); } catch (err) { } }
    });
    var grp2 = document.createElement('div');
    grp2.className = 'qqq-tools-btns';
    _plToggleB = _plIconBtn([_PL_SVG_MIN, _PL_SVG_REST], _i('shell.player.minimize', '收纳到 qqq 工作台'), 'qqq-pl-stow');   // 0=收纳 / 1=展开
    var bClose = _plMiniBtn(_PL_SVG_CLOSE, _i('common.close', '关闭'), 'qqq-pl-close');
    _plToggleB.addEventListener('click', function (e) {
      e.stopPropagation();
      var inf = _plInfo();
      if (window.qqqPlayerCard && window.qqqPlayerCard.stow) { try { window.qqqPlayerCard.stow(!(inf && inf.stow)); } catch (err) { } }
    });
    bClose.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.qqqPlayerCard) { try { window.qqqPlayerCard.close(); } catch (err) { } }
    });
    grp2.appendChild(_plToggleB);
    grp2.appendChild(bClose);
    c.appendChild(grp);
    c.appendChild(body);
    c.appendChild(grp2);
  }
  function _renderPlayerRow() {
    var c = _plRowEl;
    if (!c) { return; }
    var info = _plInfo();
    var mode = (info && info.open) ? 'console' : 'idle';
    if (_plRowMode !== mode) {
      _plRowMode = mode;
      try { c.innerHTML = ''; } catch (e) { }
      _plTitleEl = null; _plCountEl = null; _plPrevB = null; _plPlayB = null; _plNextB = null; _plToggleB = null;
      if (mode === 'console') { _buildPlayerConsole(c); } else { _buildPlayerIdle(c); }
    }
    if (mode !== 'console' || !info) { return; }
    var label = 'Player';
    if (info.name) { label += ' · ' + info.name; }
    if (_plTitleEl) { _plTitleEl.textContent = label; }
    if (_plCountEl) { _plCountEl.textContent = (info.total > 1) ? ((info.index + 1) + '/' + info.total) : ''; }   // 计数独立不随名字截断（flex 0 0 auto）
    if (_plPrevB) { _plPrevB.disabled = info.total < 2; }
    if (_plNextB) { _plNextB.disabled = info.total < 2; }
    if (_plPlayB) {
      _plSetIcon(_plPlayB, info.paused ? 1 : 0);   // 图标恒切 display（禁 innerHTML 换节点——换节点会吞紧随点击）
      _plPlayB.title = info.paused ? _i('shell.overlay.mplay', '播放') : _i('shell.overlay.mpause', '暂停');
      _plPlayB.disabled = !info.total;
    }
    if (_plToggleB) {
      _plSetIcon(_plToggleB, info.stow ? 1 : 0);
      _plToggleB.title = info.stow ? _i('shell.player.restore', '展开播放器') : _i('shell.player.minimize', '收纳到 qqq 工作台');
    }
  }
  function _buildPlayerCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card wide qqq-tools-flex qqq-player-row';
    c.title = _i('workbench.playerTip', '播放器：写代码时也能听歌/看视频（跨重启记忆播放列表）；Roam 中选中媒体右键「加入播放列表」，或从悬浮层弹出；最小化 = 收纳到本槽位遥控。');
    c.addEventListener('mouseenter', _renderPlayerRow);
    _plRowEl = c;
    _plRowMode = '';
    _renderPlayerRow();
    _bindPlayerState();
    return c;
  }

  function _buildSoonRow() {
    var row = document.createElement('div');
    row.className = 'qqq-tools-soon';
    var items = [
      { label: 'Video Url', ico: _ICO_PLAY, tip: _i('workbench.videoUrlTip', '待移植：输入视频网址，自动下载到文档目录并插入相框。') },
      { label: 'Paste', ico: _ICO_PASTE, tip: _i('workbench.pasteTip', '待移植：一键把剪贴板内容粘贴到文档（目前用 Ctrl+V 可完成同样操作）。') },
      { label: 'Pure', ico: _ICO_PURE, tip: _i('workbench.pureTip', '待移植：扫描文档引用，清理不再被引用的孤儿文件。') },
    ];
    for (var i = 0; i < items.length; i++) {
      (function (it) {
        var b = _chip(it.label, it.tip, it.ico);
        b.addEventListener('click', function (e) { e.stopPropagation(); _pendingClick(it.label); });
        row.appendChild(b);
      })(items[i]);
    }
    return row;
  }

  // ── 主面板 ──
  function _buildRoot() {
    var root = document.createElement('div');
    root.className = 'qqq-tools-menu';
    root.addEventListener('mouseenter', _clearTimers);
    root.addEventListener('mouseleave', _scheduleAll);

    var grid = document.createElement('div');
    grid.className = 'qqq-tools-grid';

    // 零分组标题行——纯卡片连续流（分组靠布局差异区分：宽卡 / 双半宽卡 / 占位虚线行）
    grid.appendChild(_buildSavorCard());
    grid.appendChild(_buildDocCard());
    grid.appendChild(_buildZipCard());
    grid.appendChild(_buildGearCard());
    grid.appendChild(_buildPlayerCard());
    grid.appendChild(_buildSoonRow());

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
    _bindGlobal();
  }

  function _removeRoot() {
    if (_rootEl) { try { _rootEl.remove(); } catch (e) { } _rootEl = null; }
    _unbindSavorState();
    _unbindPlayerState();
    _savorCardEl = null;
    _savorLabelEl = null;
    _plRowEl = null;
    _plRowMode = '';
    _plTitleEl = null; _plCountEl = null; _plPrevB = null; _plPlayB = null; _plNextB = null; _plToggleB = null;
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
    _setPlayerBadge(!!window.__qqqPlayerStowed);
  }

  // ★ 播放器收纳徽标（qqq 按钮 ♪）：player-card 在收纳/展开/关闭时调用；挂载时按全局真值补挂
  var _playerBadge = false;
  function _setPlayerBadge(on) {
    _playerBadge = !!on;
    if (_btnEl) { try { _btnEl.classList.toggle('qqq-player-stowed', _playerBadge); } catch (e) { } }
  }

  window.qqqToolsMenu = { mount: mount, close: _closeAll, setPlayerBadge: _setPlayerBadge };
})();
