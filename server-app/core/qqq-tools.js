// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-tools.js — 菜单行2 "qqq" 按钮（help 左边）· hover = "qqq 工作台"操作面板
//
// 结构（2026-09-22 工作台改版：由「文本下拉列表」升级为「卡片式操作面板」）:
//   ┌───────────────────────────────────────────────────────┐
//   │  [♾][■] Savor moments for yourself                    │  ← 老 q3 savorCard 100%
//   │         1 local, 2s; 3 radio, 15m 6s; avg 3m 47s/d    │     （统计行 = 唯一保留的副行）
//   │  [✎ export doc]        [🗜 export Zip]                │
//   │  [ .doc ][ .docx ]                                    │
//   │  [↑][↓] Cloud Sync                                    │  ← 老 qqq AQ 云同步 100%
//   │  [▶ Video Url] [✎ Paste] [✦ Pure]                     │  ← 占位（待移植）
//   └───────────────────────────────────────────────────────┘
//   2026-09-22 二次改版: 移除 SOUND/EXPORT/DATA/SOON 分割行——纯卡片连续流。
//   2026-09-22 三次改版（用户定案）: 标题行 "qqq workbench" 删除 + 副行小字全删
//   （Savor 统计行 = 例外·核心信息直显）；主文字随按钮垂直居中 + 卡片纵向空间回收
//   （6px 紧凑内边距，"更扁 = 看上去更宽"）；被删小字的说明职责全部转 hover tooltip：
//   本地语言（i18n workbench.* 段）+ 详细（到底是干什么的）；Savor 的 hover = 清晰版统计
//   （本地语言、无多余解释——用户定案「不解释，直接放核心信息」）。
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
//   Cloud Sync   [↑]=push / [↓]=pull → bridge.userData（Pull-Merge-Push 零丢失 + 内置确认弹框——
//                first-run 同款风格；2026-09-22 用户定案：原生系统模态（系统主题）→ 内置弹框（IDE 主题）保 UI 风格统一）
//   Video Url / Paste / Pure → 占位 chips（点击提示待移植）
//
// 交互: hover 进入展开（250ms 延迟关闭）；Esc / 点别处 / resize 即关；零自定义 cursor（铁律 §4.3）。
// 挂载: gaea-host renderTabBar() 尾部、help 之前（顺序契约——详 铁律 §4.12）。
// 废弃记录: Roam 行已移除（新 IDE 已有 Roam goods）；Weave 行已删除（详 铁律 §4.10）。
// ============================================================================

; (function () {
  'use strict';

  var HOVER_CLOSE_DELAY = 250;
  var PANEL_W = 416;

  var _btnEl = null;
  var _rootEl = null;
  var _allTimer = null;
  var _globalBound = false;
  // Savor 卡片引用
  var _savorCardEl = null;
  var _savorLabelEl = null;
  var _savorStatsEl = null;
  var _savorUnsub = null;
  // Cloud Sync 卡片引用
  var _syncUpEl = null;
  var _syncDownEl = null;
  var _syncBusy = false;

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
      '.qqq-tools-card.qqq-tools-flex { display: flex; align-items: center; gap: 10px; }',
      '.qqq-tools-card-body { flex: 1 1 auto; min-width: 0; }',
      '.qqq-tools-card-head { display: flex; align-items: center; gap: 6px; }',
      '.qqq-tools-card-title { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.qqq-tools-card-sub { margin-top: 3px; font-size: 10px; opacity: .5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
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
    if (_savorStatsEl) {
      var txt = '';
      try { txt = s.formatStats ? s.formatStats() : ''; } catch (e) { txt = ''; }
      _savorStatsEl.textContent = txt;
      try { _savorStatsEl.style.display = txt ? '' : 'none'; } catch (e) { }
      var tip = _savorTipText(s);
      _savorStatsEl.title = tip;
      if (_savorCardEl) { _savorCardEl.title = tip; }
    }
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

  // ── Cloud Sync（老 qqq AQ 模式：上传/下载按钮 100% 移植）──
  //   SVG 原样搬自老项目 q4.js（aqUploadSvg/aqDownloadSvg，云+箭头）；stroke 改 currentColor 适配主题
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
  function _setSyncButtons(on) {
    [_syncUpEl, _syncDownEl].forEach(function (b) { if (b) { try { b.disabled = !!on; } catch (e) { } } });
  }
  function _syncLabels(mode) {
    // ★ skipConfirm: 渲染层已用内置确认弹框（_syncConfirm）完成法律确认——壳层收到后跳过原生模态（新壳层）；
    //   旧壳层忽略此字段（一次性双确认，重启后消失）。文案保留 = 旧壳层原生框也显示本地化文本。
    if (mode === 'push') {
      return {
        title: _i('sync.uploadConfirmTitle', '上传数据到云端'),
        message: _i('sync.uploadConfirmMsg', '我确认：\n1、我是正版用户；\n2、我的剪切板、文件记录偏好中不包括任何个人敏感信息（如密码），且不包括任何违法反动信息。'),
        ok: _i('sync.uploadConfirmBtn', '我确认并上传'),
        cancel: _i('sync.uploadCancel', '取消'),
        skipConfirm: true,
      };
    }
    return {
      title: _i('sync.pullConfirmTitle', '从云端合并数据'),
      message: _i('sync.pullConfirmMsg', '下载云端数据，将与本地漫游偏好和剪贴板历史合并（取并集，不丢失），是否继续？'),
      ok: _i('sync.pullConfirmBtn', '确认下载'),
      cancel: _i('sync.uploadCancel', '取消'),
      skipConfirm: true,
    };
  }
  function _syncReasonText(reason) {
    switch (reason) {
      case 'no-auth': return _i('sync.noAuth', '当前未登录，请先登录');
      case 'not-purchased': return _i('sync.errNotPurchased', '该用户非正版用户');
      case 'rate-limit': return _i('sync.errRateLimit', '请求太频繁，请稍后再试');
      case 'quota': return _i('sync.errQuota', '数据超出配额限制');
      case 'not-registered': return _i('sync.errNotRegistered', '该手机号未注册');
      case 'auth-expired': return _i('sync.errAuthExpired', '登录已过期，请重新登录');
      case 'no-data': return _i('sync.noData', '云端暂无数据');
      case 'network': return _i('sync.errNetwork', '网络错误，请检查网络连接');
      default: return _i('sync.errServer', '服务端错误，请稍后再试');
    }
  }
  // ── 云同步确认弹框（内置 HTML，first-run 同款风格——主题变量自适应，UI 风格统一） ──
  //   2026-09-22 用户定案：原生系统模态 → 内置弹框。语义保持：确认=true / 取消|Esc=false /
  //   遮罩点击不关闭（法律确认防误触）；语言切换实时刷新；防重入（已有弹窗 → false）。
  var _syncConfirmOv = null;
  function _closeSyncConfirm() {
    if (_syncConfirmOv) { try { if (_syncConfirmOv.parentNode) { _syncConfirmOv.parentNode.removeChild(_syncConfirmOv); } } catch (e) { } }
    _syncConfirmOv = null;
  }
  function _syncConfirm(mode) {
    return new Promise(function (resolve) {
      if (_syncConfirmOv) { resolve(false); return; }
      var isPush = (mode === 'push');
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);' +
        'z-index:1000001;display:flex;align-items:center;justify-content:center;';
      var panel = document.createElement('div');
      panel.style.cssText = 'width:500px;max-width:92vw;box-sizing:border-box;' +
        'background:var(--background-color);color:var(--text-primary);' +
        'border:1px solid var(--border-strong);border-radius:10px;' +
        'box-shadow:0 12px 48px rgba(0,0,0,0.5);padding:26px 28px 20px;' +
        'font-size:14px;line-height:1.7;';

      var h = document.createElement('div');
      h.style.cssText = 'font-size:15px;font-weight:600;margin:0 0 12px;';
      var msg = document.createElement('div');
      msg.style.cssText = 'margin:0;white-space:pre-line;';

      var btnOk = document.createElement('button');
      btnOk.type = 'button';
      btnOk.style.cssText = 'padding:7px 20px;border:1px solid var(--border-strong);border-radius:6px;' +
        'background:transparent;color:var(--text-secondary);font-size:13px;';
      var btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.style.cssText = btnOk.style.cssText;

      function _fill() {   // i18n 填充（语言切换时重刷——开着弹窗切语言不锁旧文案）
        h.textContent = _i(isPush ? 'sync.uploadConfirmTitle' : 'sync.pullConfirmTitle', isPush ? '上传数据到云端' : '从云端合并数据');
        msg.textContent = _i(isPush ? 'sync.uploadConfirmMsg' : 'sync.pullConfirmMsg', isPush
          ? '我确认：\n1、我是正版用户；\n2、我的剪切板、文件记录偏好中不包括任何个人敏感信息（如密码），且不包括任何违法反动信息。'
          : '下载云端数据，将与本地漫游偏好和剪贴板历史合并（取并集，不丢失），是否继续？');
        btnOk.textContent = _i(isPush ? 'sync.uploadConfirmBtn' : 'sync.pullConfirmBtn', isPush ? '我确认并上传' : '确认下载');
        btnCancel.textContent = _i('sync.uploadCancel', '取消');
      }
      _fill();

      function _close(result) {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('qqq-lang-change', _fill);
        _closeSyncConfirm();
        resolve(result);
      }
      var onKey = function (e) { if (e && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); _close(false); } };
      btnOk.addEventListener('click', function (e) { e.stopPropagation(); _close(true); });
      btnCancel.addEventListener('click', function (e) { e.stopPropagation(); _close(false); });
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('qqq-lang-change', _fill);
      // 遮罩点击不关闭（与原生模态一致——法律确认防误触）；仅按钮 / Esc 决议

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:22px;';
      row.appendChild(btnOk);      // 布局与 first-run 一致：主操作在左
      row.appendChild(btnCancel);
      panel.appendChild(h);
      panel.appendChild(msg);
      panel.appendChild(row);
      ov.appendChild(panel);
      document.body.appendChild(ov);
      _syncConfirmOv = ov;
    });
  }

  function _doSync(mode) {
    if (_syncBusy) { _qoast(_i('sync.lok', '正在同步中，请稍候…'), { duration: 4000 }); return; }
    var ud = null;
    try { ud = window.qqqideBridge && window.qqqideBridge.userData; } catch (e) { }
    if (!ud || !ud.push) {
      _qoast(_i('sync.bridgeMissing', '云同步不可用（需重启实例）'), { type: 'error', duration: 9000 });
      return;
    }
    _closeAll();   // 先收工作台面板（弹窗模态期间不留底）
    // 内置确认弹框先行（first-run 同款 UI 风格）；取消 = 静默返回（与原生 cancelled 语义一致）
    _syncConfirm(mode).then(function (go) {
      if (!go) { return; }
      _runSync(mode, ud);
    });
  }
  function _runSync(mode, ud) {
    var isPush = (mode === 'push');
    _syncBusy = true;
    _setSyncButtons(true);
    var io = null; try { io = window.qqqideIoast || null; } catch (e) { }
    var taskId = 'sync-' + mode + '-' + Date.now();
    var busyTitle = isPush ? _i('sync.uploading', '正在上传数据到云端...') : _i('sync.pulling', '正在从云端拉取数据...');
    if (io) { try { io.task(taskId, { title: '☁ ' + (isPush ? '↑' : '↓'), subtitle: busyTitle, progress: 0 }); } catch (e) { } }
    var p;
    try { p = isPush ? ud.push(_syncLabels('push')) : ud.pull(_syncLabels('pull')); }
    catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (r) {
      _syncBusy = false;
      _setSyncButtons(false);
      if (r && r.ok) {
        var timeStr = new Date().toLocaleString();
        var msg = isPush
          ? _T('sync.uploadSuccess', '已上传到云端 ({0})', { 0: timeStr })
          : _T('sync.pullSuccess', '已从云端合并数据，新增 {1} 条 ({0})', { 0: timeStr, 1: (r.added || 0) });
        if (io) { try { io.done(taskId, { summary: msg }); } catch (e) { } }
        _qoast(msg, { type: 'success', duration: 8000 });
        return;
      }
      var reason = (r && r.reason) || 'unknown';
      if (reason === 'cancelled') { if (io) { try { io.remove(taskId); } catch (e) { } } return; }
      if (reason === 'busy') {
        if (io) { try { io.remove(taskId); } catch (e) { } }
        _qoast(_i('sync.lok', '正在同步中，请稍候…'), { duration: 4000 });
        return;
      }
      var emsg = isPush
        ? _T('sync.uploadFailed', '上传失败：{0}', { 0: _syncReasonText(reason) })
        : _T('sync.pullFailed', '恢复失败：{0}', { 0: _syncReasonText(reason) });
      if (io) { try { io.fail(taskId, { summary: emsg }); } catch (e) { } }
      _qoast(emsg, { type: 'error', duration: 9000 });
    }).catch(function (e) {
      _syncBusy = false;
      _setSyncButtons(false);
      var em = String((e && e.message) || e || 'unknown');
      if (io) { try { io.fail(taskId, { summary: em }); } catch (e2) { } }
      _qoast(em, { type: 'error', duration: 9000 });
    });
  }

  // ── 卡片构建 ──
  function _buildSavorCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card wide qqq-tools-flex';
    c.addEventListener('click', function (e) { e.stopPropagation(); _savorPlay('normal'); });
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
    var s = document.createElement('div');
    s.className = 'qqq-tools-card-sub';
    body.appendChild(t);
    body.appendChild(s);
    c.appendChild(grp);
    c.appendChild(body);
    _savorCardEl = c;
    _savorLabelEl = t;
    _savorStatsEl = s;
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

  function _buildCloudCard() {
    var c = document.createElement('div');
    c.className = 'qqq-tools-card wide qqq-tools-flex';
    c.title = _i('workbench.cloudSyncTip', '云同步：↑ 上传 = 先与云端合并再上传（两边都不丢数据）；↓ 下载 = 把云端数据合并到本地。包含编辑器配置、各文件夹偏好、剪贴板历史。');
    var grp = document.createElement('div');
    grp.className = 'qqq-tools-btns';
    _syncUpEl = _syncBtn(_SYNC_SVG_UP, _i('sync.uploadTitle', '上传到云端'));
    _syncDownEl = _syncBtn(_SYNC_SVG_DOWN, _i('sync.downloadTitle', '下载云端数据'));
    _syncUpEl.addEventListener('click', function (e) { e.stopPropagation(); _doSync('push'); });
    _syncDownEl.addEventListener('click', function (e) { e.stopPropagation(); _doSync('pull'); });
    grp.appendChild(_syncUpEl);
    grp.appendChild(_syncDownEl);
    var body = document.createElement('div');
    body.className = 'qqq-tools-card-body';
    var t = document.createElement('div');
    t.className = 'qqq-tools-card-title';
    t.textContent = 'Cloud Sync';
    body.appendChild(t);
    c.appendChild(grp);
    c.appendChild(body);
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
    grid.appendChild(_buildCloudCard());
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
    _savorCardEl = null;
    _savorLabelEl = null;
    _savorStatsEl = null;
    _syncUpEl = null;
    _syncDownEl = null;
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

  window.qqqToolsMenu = { mount: mount, close: _closeAll };
})();
