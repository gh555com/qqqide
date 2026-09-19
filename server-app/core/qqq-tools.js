// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-tools.js — 菜单行2 "qqq" 按钮（help 左边）· hover 下拉 = 老项目侧边按钮组移植
//
// 结构（hover qqq → 下拉单）:
//   Savor moments for yourself      占位（待移植）
//   Paste                           占位（待移植）
//   Video Url  [input ▶]            占位（填空框加按钮形态）
//   ────────
//   export doc  ▸                   ✅ 已移植（子菜单: .doc RTF / .docx）
//   Pure                            占位（待移植）
//   export Zip                      ✅ 已移植
//
// 语义: Roam 行已按定案移除（新 IDE 已有 Roam goods）；8204（老设置卡/阿q 体系）不迁。
//       Weave 行已按定案删除（老语义=插物理空行，新架构 ViewZone 自带高度零需求；
//       刷新/数字重算职责已全自动化——详 铁律 §4.10，不保留无独立能力的手动按钮）。
// 交互: 纯 hover（进入即展开，250ms 延迟关闭；行 hover 高亮）；Esc / 点别处 / resize 即关；
//       零自定义 cursor（光标铁律）。挂载点: gaea-host renderTabBar() 尾部、help 之前。
// 动作: export doc / export Zip → window.qqqExport（core/export-machine.js）。
// 文案: 菜单行标签恒英文（老项目原样，白名单免译）；提示走 zh.json export.* 段。
// ============================================================================

; (function () {
  'use strict';

  var HOVER_CLOSE_DELAY = 250;

  var _btnEl = null;
  var _rootEl = null;
  var _rootRowEls = [];
  var _subEl = null;
  var _subKey = null;
  var _allTimer = null;
  var _subTimer = null;
  var _globalBound = false;

  function _i(key, fb) { try { return window._i ? window._i(key, fb) : fb; } catch (e) { return fb; } }
  function _qoast(m, o) { try { if (window.qqqideQoast) { window.qqqideQoast.show(m, o || {}); } } catch (e) { } }

  // ── 样式（自包含注入；家族外观对齐 help-menu / 品牌下拉） ──
  function _ensureStyle() {
    if (document.getElementById('qqq-tools-menu-style')) { return; }
    var s = document.createElement('style');
    s.id = 'qqq-tools-menu-style';
    s.textContent = [
      '.qqq-tools-btn:hover, .qqq-tools-btn.qqq-tools-open { background: var(--background-color) !important; opacity: .85; }',
      '.qqq-tools-menu, .qqq-tools-sub {',
      '  position: fixed; z-index: 999999;',
      '  background: var(--card-bg, #fdf6e3);',
      '  border: 1px solid var(--border-color, #d6d6d6);',
      '  border-radius: 6px;',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.12);',
      '  padding: 4px 0; margin: 0;',
      '  opacity: 0; pointer-events: none;',
      '  transition: opacity .12s ease, transform .12s ease;',
      '  font-family: Tahoma, sans-serif; font-size: 13px;',
      '  max-height: calc(100vh - 12px); overflow-y: auto; overflow-x: hidden;',
      '}',
      '.qqq-tools-menu { min-width: 234px; transform: translateY(-4px); }',
      '.qqq-tools-sub { min-width: 236px; max-width: 340px; z-index: 1000000; transform: translateX(-4px); }',
      '.qqq-tools-menu.open, .qqq-tools-sub.open { opacity: 1; pointer-events: auto; }',
      '.qqq-tools-menu.open { transform: translateY(0); }',
      '.qqq-tools-sub.open { transform: translateX(0); }',
      '.qqq-tools-row { display: flex; align-items: center; justify-content: space-between; padding: 7px 12px; color: var(--text-primary, #586e75); white-space: nowrap; }',
      '.qqq-tools-row:hover, .qqq-tools-row.active { background: var(--hover-bg, rgba(0,0,0,0.06)); }',
      '.qqq-tools-row.pending { opacity: .55; }',
      '.qqq-tools-row.pending:hover { opacity: .75; }',
      '.qqq-tools-arrow { opacity: .55; margin-left: 16px; font-size: 12px; }',
      '.qqq-tools-sep { height: 1px; margin: 4px 8px; background: var(--border-color, #d6d6d6); }',
      '.qqq-tools-sub-row { padding: 7px 12px; color: var(--text-primary, #586e75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.qqq-tools-sub-row:hover { background: var(--hover-bg, rgba(0,0,0,0.06)); }',
      '.qqq-tools-sub-row .qqq-tools-sub-desc { display: block; font-size: 11px; opacity: .6; margin-top: 2px; white-space: normal; }',
      '.qqq-tools-video { display: flex; align-items: center; gap: 6px; padding: 6px 12px; }',
      '.qqq-tools-video input { flex: 1; min-width: 0; height: 24px; padding: 0 8px; font-size: 12px; font-family: Tahoma, sans-serif; border: 1px solid var(--border-color, #d6d6d6); border-radius: 3px; background: var(--background-color, #eee8d5); color: var(--text-primary, #586e75); outline: none; }',
      '.qqq-tools-video button { height: 22px; padding: 0 8px; font-size: 12px; border: 1px solid var(--border-color, #d6d6d6); border-radius: 3px; background: transparent; color: var(--text-primary, #586e75); }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── 计时器 / 全局收尾 ──
  function _clearTimers() {
    if (_allTimer) { clearTimeout(_allTimer); _allTimer = null; }
    if (_subTimer) { clearTimeout(_subTimer); _subTimer = null; }
  }
  function _scheduleAll() {
    _clearTimers();
    _allTimer = setTimeout(_closeAll, HOVER_CLOSE_DELAY);
  }
  function _scheduleSub() {
    if (_subTimer) { clearTimeout(_subTimer); }
    _subTimer = setTimeout(_removeSub, HOVER_CLOSE_DELAY);
  }
  function _containsAny(t) {
    if (!t) { return false; }
    if (_rootEl && _rootEl.contains(t)) { return true; }
    if (_subEl && _subEl.contains(t)) { return true; }
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

  // ── 行表（唯一维护点）──
  function _rows() {
    return [
      { key: 'savor', label: 'Savor moments for yourself', pending: true },
      { key: 'paste', label: 'Paste', pending: true },
      { key: 'video', label: 'Video Url', video: true, pending: true },
      { key: 'sep1', sep: true },
      { key: 'doc', label: 'export doc', sub: true },
      { key: 'pure', label: 'Pure', pending: true },
      { key: 'zip', label: 'export Zip', action: function () { _closeAll(); _callExport('zip'); } },
    ];
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

  // ── 主菜单 ──
  function _buildRoot() {
    var root = document.createElement('div');
    root.className = 'qqq-tools-menu';
    root.addEventListener('mouseenter', _clearTimers);
    root.addEventListener('mouseleave', _scheduleAll);
    _rootRowEls = [];

    var rows = _rows();
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      if (d.sep) {
        var sep = document.createElement('div');
        sep.className = 'qqq-tools-sep';
        root.appendChild(sep);
        continue;
      }
      if (d.video) {
        // Video Url 填空框加按钮（占位形态 —— 老项目 input + ▶）
        var vr = document.createElement('div');
        vr.className = 'qqq-tools-video';
        vr.title = _i('export.pendingTip', '此功能待移植（先占位）');
        var vin = document.createElement('input');
        vin.type = 'text';
        vin.placeholder = ' Video Url';
        vin.disabled = true;
        var vbtn = document.createElement('button');
        vbtn.textContent = '\u25B6';
        vbtn.disabled = true;
        vr.appendChild(vin);
        vr.appendChild(vbtn);
        root.appendChild(vr);
        continue;
      }

      var row = document.createElement('div');
      row.className = 'qqq-tools-row' + (d.pending ? ' pending' : '');
      if (d.pending) { row.title = _i('export.pendingTip', '此功能待移植（先占位）'); }
      var lab = document.createElement('span');
      lab.textContent = d.label;
      row.appendChild(lab);
      if (d.sub) {
        var arr = document.createElement('span');
        arr.className = 'qqq-tools-arrow';
        arr.textContent = '\u203A';
        row.appendChild(arr);
        row.addEventListener('mouseenter', function (dd, rowEl) { return function () { _clearTimers(); _showSub(dd, rowEl); }; }(d, row));
        row.addEventListener('mouseleave', _scheduleSub);
        _rootRowEls.push({ key: d.key, el: row });
      } else if (d.action) {
        row.addEventListener('click', function (dd) { return function (e) { e.stopPropagation(); dd.action(); }; }(d));
      } else {
        row.addEventListener('click', function (dd) { return function (e) { e.stopPropagation(); _pendingClick(dd.label); }; }(d));
      }
      root.appendChild(row);
    }
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
    var w = root.offsetWidth || 234, h = root.offsetHeight || 200;
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
    _rootRowEls = [];
  }

  function _markActiveRow(rowEl) {
    for (var i = 0; i < _rootRowEls.length; i++) {
      var it = _rootRowEls[i];
      if (it.el === rowEl) { try { it.el.classList.add('active'); } catch (e) { } }
      else { try { it.el.classList.remove('active'); } catch (e) { } }
    }
  }

  // ── export doc 子菜单（老 quick-pick 两项：.doc RTF / .docx）──
  function _subRows() {
    return [
      { label: _i('export.docFormatRtf', '.doc 文档（兼容 Office 2003, RTF）'), desc: _i('export.docFormatRtfDesc', 'RTF 编码 ◉ 兼容性更好'), format: 'rtf' },
      { label: _i('export.docFormatDocx', '.docx 文档 （支持 Google Docs/腾讯文档）'), desc: _i('export.docFormatDocxDesc', 'Office Open XML 编码 ◉ 功能更强、压缩率更高（文件体积能小一半）'), format: 'docx' },
    ];
  }

  function _positionSub(rowEl) {
    if (!_subEl || !_rootEl || !rowEl) { return; }
    var rowRect = rowEl.getBoundingClientRect();
    var rootRect = _rootEl.getBoundingClientRect();
    var w = _subEl.offsetWidth || 236, h = _subEl.offsetHeight || 100;
    var left = rootRect.right + 2;
    if (left + w > window.innerWidth - 8) { left = rootRect.left - w - 2; }
    if (left < 8) { left = 8; }
    var top = rowRect.top;
    if (top + h > window.innerHeight - 8) { top = window.innerHeight - h - 8; }
    if (top < 4) { top = 4; }
    _subEl.style.left = left + 'px';
    _subEl.style.top = top + 'px';
    if (!_subEl.classList.contains('open')) {
      requestAnimationFrame(function () { if (_subEl) { _subEl.classList.add('open'); } });
    }
  }

  function _showSub(d, rowEl) {
    if (_subEl && _subKey === d.key && _subEl.parentNode) { _markActiveRow(rowEl); _positionSub(rowEl); return; }
    _removeSub();
    _markActiveRow(rowEl);
    var sub = document.createElement('div');
    sub.className = 'qqq-tools-sub';
    var rows = _subRows();
    for (var i = 0; i < rows.length; i++) {
      (function (r) {
        var el = document.createElement('div');
        el.className = 'qqq-tools-sub-row';
        var t1 = document.createElement('span');
        t1.textContent = r.label;
        el.appendChild(t1);
        var t2 = document.createElement('span');
        t2.className = 'qqq-tools-sub-desc';
        t2.textContent = r.desc;
        el.appendChild(t2);
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          _closeAll();
          _callExport('doc', r.format);
        });
        sub.appendChild(el);
      })(rows[i]);
    }
    sub.addEventListener('mouseenter', _clearTimers);
    sub.addEventListener('mouseleave', _scheduleAll);
    document.body.appendChild(sub);
    _subEl = sub;
    _subKey = d.key;
    _positionSub(rowEl);
  }

  function _removeSub() {
    if (_subEl) { try { _subEl.remove(); } catch (e) { } _subEl = null; }
    _subKey = null;
    for (var i = 0; i < _rootRowEls.length; i++) {
      try { _rootRowEls[i].el.classList.remove('active'); } catch (e) { }
    }
  }

  function _closeAll() {
    _clearTimers();
    _removeSub();
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
