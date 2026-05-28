// ============================================================================
// qoods/navigator/navigator.js
// Quick-jump file navigator. Press Ctrl+P to open, type to fuzzy-filter
// recent files, Enter to open in editor.
// Recent list is kept in localStorage (no fs writes from this qood).
// ============================================================================

(function () {
  'use strict';
  if (!globalThis.qoods) { console.warn('[navigator] qoods shim missing'); return; }
  const Q = globalThis.qoods;

  const KEY_RECENT = 'qqq.navigator.recent';
  const MAX_RECENT = 50;

  function getRecent() {
    try { return JSON.parse(localStorage.getItem(KEY_RECENT) || '[]'); }
    catch { return []; }
  }
  function pushRecent(p) {
    if (!p) { return; }
    const list = getRecent().filter(x => x !== p);
    list.unshift(p);
    if (list.length > MAX_RECENT) { list.length = MAX_RECENT; }
    try { localStorage.setItem(KEY_RECENT, JSON.stringify(list)); } catch {}
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
    input.placeholder = '输入路径片段，Enter 打开 / Esc 关闭';
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
      empty.textContent = recent.length === 0 ? '尚无最近文件，先在文件树中打开几个文件' : '无匹配项';
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
    if (e.key === 'ArrowUp')   { activeIdx = Math.max(0, activeIdx - 1); refresh(); e.preventDefault(); return; }
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

  console.log('[navigator] ready (Ctrl+P)');
})();
