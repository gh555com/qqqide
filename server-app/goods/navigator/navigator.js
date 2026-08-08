// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qoods/navigator/navigator.js
// Quick-jump file navigator. Press Ctrl+P to open, type to fuzzy-filter
// recent files, Enter to open in editor.
// Recent list persisted to OS 级 ai.sq3 (2026-08-07 F3): key=文件绝对路径
//   → 偏好属于文件本身，跨主文件夹/跨绿色包/跨窗口一致。
//   旧数据在 only.sq3 (项目级) → 首次启动自动迁移。
// ============================================================================

(function () {
  'use strict';
  if (!globalThis.qoods) { console.warn('[navigator] qoods shim missing'); return; }
  const Q = globalThis.qoods;

  const MAX_RECENT = 50;
  var _recentCache = []; // sync cache, lazy-loaded from only.sq3
  var _recentLoaded = false;

  function _navFolderFromUrl() {
    var m = window.location.search.match(/[?&]folder=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]).replace(/\\/g, '/').replace(/\/$/, ''); }
      catch (_) { }
    }
    return null;
  }

  function _onlyDb() {
    var root = window._workspaceRoot || _navFolderFromUrl();
    if (!root || !window.qgs || typeof window.qgs.project !== 'function') return null;
    return window.qgs.project(root + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
  }

  var RECENT_KEY = 'navigator.recent';

  // ★ OS 级持久化桥 (ai.sq3) — 主通道
  function _osBridge() {
    try {
      var b = window.qqqideBridge && window.qqqideBridge.aiState;
      if (b && typeof b.get === 'function') return b;
    } catch (_) { }
    return null;
  }

  // 异步初始化：OS 级 ai.sq3 为主，旧 only.sq3 数据自动迁移
  (async function _initRecent() {
    var os = _osBridge();
    if (os) {
      try {
        var v = await os.get(RECENT_KEY);
        if (Array.isArray(v)) { _recentCache = v; _recentLoaded = true; return; }
      } catch (_) { }
      // ★ 迁移：OS 无数据 → 读旧 only.sq3 → 写入 OS → 删旧 key
      var db = _onlyDb();
      if (db) {
        try {
          var old = await db.get(RECENT_KEY);
          if (Array.isArray(old) && old.length) {
            _recentCache = old;
            os.set(RECENT_KEY, old).catch(function () { });
            if (db.del) { try { await db.del(RECENT_KEY); } catch (_) { } }
          }
        } catch (_) { }
      }
      _recentLoaded = true;
      return;
    }
    // 降级：无 OS 桥（浏览器 dev）→ 旧 only.sq3
    var db = _onlyDb();
    if (!db) { _recentLoaded = true; return; }
    try {
      var v2 = await db.get(RECENT_KEY);
      if (Array.isArray(v2)) _recentCache = v2;
    } catch (_) { }
    _recentLoaded = true;
  })();

  function getRecent() { return _recentCache; }

  function _saveRecent(list) {
    _recentCache = list;
    var os = _osBridge();
    if (os) { os.set(RECENT_KEY, list).catch(function () { }); return; }
    var db = _onlyDb();
    if (db) db.set(RECENT_KEY, list).catch(function () { });
  }

  // ★ 跨窗口同步: 其他窗口写入 OS ai.sq3 → 广播 → 本窗口缓存跟随
  (function _syncRecent() {
    var b = _osBridge();
    if (b && b.onChanged) {
      b.onChanged(function (msg) {
        if (msg && msg.key === RECENT_KEY && Array.isArray(msg.value)) _recentCache = msg.value;
      });
    }
  })();

  function pushRecent(p) {
    if (!p) return;
    var list = _recentCache.filter(function (x) { return x !== p; });
    list.unshift(p);
    if (list.length > MAX_RECENT) list.length = MAX_RECENT;
    _saveRecent(list);
  }

  // Hook file-open events so navigator records files automatically.
  document.addEventListener('qqq-file-open', (e) => {
    if (e.detail && e.detail.path) pushRecent(e.detail.path);
  });

  // ---- modal UI ----
  let overlay = null;
  let input = null;
  let listEl = null;
  let activeIdx = 0;
  let items = [];

  function ensureOverlay() {
    if (overlay) { return; }
    overlay = document.createElement('div');
    overlay.id = 'qqq-navigator-overlay';
    overlay.style.cssText =
      'position:fixed; inset:0; background:rgba(7,54,66,0.35); display:none; z-index:9999;' +
      'align-items:flex-start; justify-content:center; padding-top:80px;';
    const box = document.createElement('div');
    box.style.cssText =
      'width:560px; max-width:80vw; background:var(--background-color); ' +
      'border:1px solid var(--border-color); border-radius:4px; ' +
      'box-shadow:0 8px 30px rgba(0,0,0,.25); overflow:hidden;';
    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = window._i('goods.navigator.inputPlaceholder', '键入路径片段，Enter 打开 / Esc 关闭');
    input.style.cssText =
      'width:100%; box-sizing:border-box; padding:10px 12px; ' +
      'border:0; border-bottom:1px solid var(--border-color); ' +
      'background:var(--background-color); color:var(--text-primary);' +
      'font-size:14px; outline:none;';
    listEl = document.createElement('div');
    listEl.style.cssText = 'max-height:420px; overflow:auto;';
    box.appendChild(input);
    box.appendChild(listEl);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) { hide(); } });
    input.addEventListener('keydown', onKey);
    input.addEventListener('input', refresh);
  }

  function fuzzyMatch(needle, hay) {
    if (!needle) { return true; }
    needle = needle.toLowerCase(); hay = hay.toLowerCase();
    let i = 0; for (let j = 0; j < hay.length && i < needle.length; j++) {
      if (hay[j] === needle[i]) { i++; }
    }
    return i === needle.length;
  }

  function refresh() {
    const q = (input.value || '').trim();
    const recent = getRecent();
    items = recent.filter(p => fuzzyMatch(q, p)).slice(0, 60);
    activeIdx = 0;
    listEl.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:14px; color:var(--base1); font-size:12px;';
      empty.textContent = recent.length === 0 ? window._i('goods.navigator.noRecent', '尚无最近文件，先在文件树中打开几个文件') : window._i('goods.navigator.noMatch', '无匹配项');
      listEl.appendChild(empty);
      return;
    }
    items.forEach((p, i) => {
      const row = document.createElement('div');
      row.style.cssText =
        'padding:6px 12px; font-family: ui-monospace, Consolas, monospace; ' +
        'font-size:12px; cursor:pointer; color:var(--text-primary);' +
        (i === activeIdx ? ' background:var(--card-bg);' : '');
      row.textContent = p;
      row.addEventListener('mouseenter', () => { activeIdx = i; refresh(); });
      row.addEventListener('click', () => { open(p); hide(); });
      listEl.appendChild(row);
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') { hide(); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      const p = items[activeIdx]; if (p) { open(p); hide(); }
      e.preventDefault(); return;
    }
    if (e.key === 'ArrowDown') { activeIdx = Math.min(items.length - 1, activeIdx + 1); refresh(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { activeIdx = Math.max(0, activeIdx - 1); refresh(); e.preventDefault(); return; }
  }

  function show() {
    ensureOverlay();
    overlay.style.display = 'flex';
    input.value = '';
    refresh();
    setTimeout(() => input.focus(), 0);
  }
  function hide() { if (overlay) { overlay.style.display = 'none'; } }

  function open(p) {
    if (window.qqqEditor && window.qqqEditor.open) { window.qqqEditor.open(p); }
  }

  // global hotkey: Ctrl+P (block default print dialog)
  document.addEventListener('keydown', (e) => {
    const isP = (e.key === 'p' || e.key === 'P');
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && isP) {
      e.preventDefault();
      show();
    }
  });

  Q.commands.register('navigator.show', show);
  Q.commands.register('navigator.hide', hide);

  // [silent] navigator ready
})();
