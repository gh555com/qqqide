// ============================================================================
// shell.js - QQQ Shell v2 - NEW layout bootstrap
// Layout: Menu(top) | A-zone + X-zone + AI-zone (middle) | Status(bottom)
// ============================================================================
(function () {
  'use strict';

  const bridge = window.qqqBridge;
  const ROOT = document.documentElement;
  const MIN = 123;
  const AI_W = 389;
  const SASH_W = 6;

  // ---- Layout state (persisted via StateStore, not localStorage) ----
  const STATE_NS = 'qqq.shell';
  const STATE_KEY = 'layout_v2';
  let layoutState = {
    aZoneW: 220,
    outputH: 200,
    outputVisible: false,
  };

  async function loadState() {
    // 1) try StateStore first
    try {
      if (bridge && bridge.state && bridge.state.get) {
        const v = await bridge.state.get(STATE_NS, STATE_KEY);
        if (v && typeof v === 'object') {
          if (typeof v.aZoneW === 'number') layoutState.aZoneW = v.aZoneW;
          if (typeof v.outputH === 'number') layoutState.outputH = v.outputH;
          if (typeof v.outputVisible === 'boolean') layoutState.outputVisible = v.outputVisible;
        }
      }
    } catch (_) { /* fall through to defaults */ }
    // 2) migration: if StateStore had no value, try old localStorage key
    const _stillDefault = layoutState.aZoneW === 220 && layoutState.outputH === 200 && !layoutState.outputVisible;
    if (_stillDefault) {
      try {
        const raw = localStorage.getItem('qqq-layout-v2');
        if (raw) {
          const old = JSON.parse(raw);
          if (typeof old.aZoneW === 'number') layoutState.aZoneW = old.aZoneW;
          if (typeof old.outputH === 'number') layoutState.outputH = old.outputH;
          if (typeof old.outputVisible === 'boolean') layoutState.outputVisible = old.outputVisible;
          // one-time migrate: push to StateStore, remove localStorage
          try { localStorage.removeItem('qqq-layout-v2'); } catch (_) { }
          try { if (bridge && bridge.state && bridge.state.set) bridge.state.set(STATE_NS, STATE_KEY, layoutState); } catch (_) { }
        }
      } catch (_) { }
    }
    layoutState.aZoneW = Math.max(MIN, layoutState.aZoneW || 220);
    layoutState.outputH = Math.max(MIN, layoutState.outputH || 200);
  }

  function persistState() {
    // Authoritative: StateStore (debounced, atomic, cloud=true via qqq.shell).
    try {
      if (bridge && bridge.state && bridge.state.set) {
        bridge.state.set(STATE_NS, STATE_KEY, {
          aZoneW: layoutState.aZoneW,
          outputH: layoutState.outputH,
          outputVisible: layoutState.outputVisible,
        }).catch(() => { });
      }
    } catch (_) { /* ignore */ }
  }

  // ---- CSS variable helpers ----
  function applyLayout() {
    const aEl = document.getElementById('qqq-a-zone');
    if (aEl && !aEl.classList.contains('qqq-collapsed')) {
      aEl.style.flexBasis = layoutState.aZoneW + 'px';
      aEl.style.width = layoutState.aZoneW + 'px';
    }
    const oEl = document.getElementById('qqq-x-output');
    if (oEl) {
      oEl.style.flexBasis = layoutState.outputH + 'px';
      oEl.style.height = layoutState.outputH + 'px';
    }
  }

  // ---- Window resize: proportional scaling, frozen min panels stay frozen ----
  let _prevWinW = 0;
  let _prevWinH = 0;

  function onWindowResize() {
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    if (_prevWinW === 0) { _prevWinW = winW; _prevWinH = winH; }

    const aEl = document.getElementById('qqq-a-zone');
    if (aEl && !aEl.classList.contains('qqq-collapsed')) {
      const oldA = layoutState.aZoneW;
      // available middle width = win - AI - sash
      const oldAvail = _prevWinW - AI_W - SASH_W;
      const newAvail = winW - AI_W - SASH_W;
      if (oldAvail > 0 && newAvail > 0) {
        if (oldA <= MIN) {
          // frozen at min, keep at min
          layoutState.aZoneW = MIN;
        } else {
          const ratio = oldA / oldAvail;
          layoutState.aZoneW = Math.max(MIN, Math.round(ratio * newAvail));
        }
      }
    }

    // output height proportional
    const xEl = document.getElementById('qqq-x-zone');
    if (xEl && layoutState.outputVisible) {
      const oldXH = _prevWinH - 60 - 24; // approx menu + status
      const newXH = winH - 60 - 24;
      if (oldXH > 0 && newXH > 0) {
        const oldO = layoutState.outputH;
        if (oldO <= MIN) {
          layoutState.outputH = MIN;
        } else {
          const ratio = oldO / oldXH;
          layoutState.outputH = Math.max(MIN, Math.round(ratio * newXH));
        }
      }
    }

    _prevWinW = winW;
    _prevWinH = winH;
    applyLayout();
  }

  // ---- Window controls ----
  function bootWindowControls() {
    const $min = document.getElementById('qqq-wc-min');
    const $max = document.getElementById('qqq-wc-max');
    const $close = document.getElementById('qqq-wc-close');
    if ($min) $min.addEventListener('click', () => bridge.window.minimize());
    if ($max) $max.addEventListener('click', async () => {
      const isMax = await bridge.window.isMaximized();
      if (isMax) bridge.window.unmaximize(); else bridge.window.maximize();
    });
    if ($close) $close.addEventListener('click', () => bridge.window.close());
  }

  // ---- Theme toggle (委托唯一真理配色机器) ----
  function bootThemeToggle() {
    const $btn = document.getElementById('qqq-theme-toggle');
    if (!$btn) return;
    const T = window.qqqTheme;
    function syncBtn(dark) {
      $btn.textContent = dark ? '\u263C' : '\u263D';
      $btn.title = dark ? window._i('shell.theme.switchToLight', '切换到亮色') : window._i('shell.theme.switchToDark', '切换到暗色');
    }
    syncBtn(T.isDark());
    T.onChange(function (dark) {
      $btn.title = dark ? window._i('shell.theme.switchToLight', '切换到亮色') : window._i('shell.theme.switchToDark', '切换到暗色');
    });
    $btn.addEventListener('click', () => T.apply(!T.isDark()));
  }

  // ---- AI Viewport (titlebar row 1) ----
  function bootAiViewport() {
    const host = document.getElementById('qqq-ai-viewport');
    if (!host || !window.qqqAiViewport) return;
    window.qqqAiViewport.build(host);
  }

  // ---- Language Switcher ----
  var _langPopup = null;
  var LANG_LABELS = {
    'zh': '中', 'zh-tw': '繁', 'en': 'EN', 'ja': '日', 'de': 'DE',
    'ko': '한', 'ru': 'RU', 'ar': 'ar', 'es': 'ES', 'fr': 'FR',
    'pt-BR': 'BR', 'hi': 'hi', 'vi': 'VI'
  };

  function closeLangPopup() {
    if (_langPopup) { try { _langPopup.remove(); } catch (_) { } _langPopup = null; }
  }

  function openLangPopup(anchor) {
    closeLangPopup();
    var rect = anchor.getBoundingClientRect();
    var pop = document.createElement('div');
    pop.className = 'qqq-lang-popup';
    pop.style.cssText = 'left:' + rect.left + 'px; top:' + (rect.bottom + 4) + 'px;';

    var cur = window.i18n ? window.i18n.getLang() : 'zh';
    var langs = window.i18n ? window.i18n.getSupportedLangs() : ['zh', 'en'];
    for (var i = 0; i < langs.length; i++) {
      var lc = langs[i];
      var row = document.createElement('div');
      row.className = 'qqq-lang-popup-item' + (lc === cur ? ' qqq-lang-active' : '');
      var name = window.i18n ? window.i18n.getLangName(lc) : lc;
      row.textContent = name;
      row.addEventListener('click', (function (lang) {
        return function (e) {
          e.stopPropagation();
          closeLangPopup();
          if (window.i18n) window.i18n.setLang(lang);
          updateLangBtn();
        };
      })(lc));
      pop.appendChild(row);
    }

    document.body.appendChild(pop);
    _langPopup = pop;

    document.addEventListener('mousedown', function onDoc(e) {
      if (!_langPopup) { document.removeEventListener('mousedown', onDoc); return; }
      if (_langPopup.contains(e.target)) return;
      if (e.target === anchor) return;
      closeLangPopup();
      document.removeEventListener('mousedown', onDoc);
    });
  }

  function updateLangBtn() {
    var btn = document.getElementById('qqq-lang-btn');
    if (!btn) return;
    var lang = window.i18n ? window.i18n.getLang() : 'zh';
    btn.textContent = LANG_LABELS[lang] || lang;
  }

  function bootLangSwitcher() {
    var btn = document.getElementById('qqq-lang-btn');
    if (!btn) return;

    // Wait for i18n to init, then update label
    var tryUpdate = function () {
      if (window.i18n && window.i18n.getLang()) {
        updateLangBtn();
      } else {
        setTimeout(tryUpdate, 100);
      }
    };
    tryUpdate();

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (_langPopup) { closeLangPopup(); return; }
      openLangPopup(btn);
    });

    // Listen for lang change events (set by i18n.setLang)
    window.addEventListener('qqq-lang-change', updateLangBtn);
  }

  // ---- Menubar labels (clickable, opens HTML dropdown of sub items) ----
  let _activeMenubarPopup = null;
  function closeMenubarPopup() {
    if (_activeMenubarPopup) { try { _activeMenubarPopup.remove(); } catch (_) { } _activeMenubarPopup = null; }
  }
  function openMenubarPopup(anchorEl, item) {
    closeMenubarPopup();
    if (!item.sub || item.sub.length === 0) return;
    const rect = anchorEl.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'qqq-menubar-popup';
    pop.style.cssText =
      'position:fixed; z-index:99999; ' +
      'left:' + rect.left + 'px; top:' + rect.bottom + 'px; ' +
      'min-width:180px; background:var(--card-bg); ' +
      'border:1px solid var(--border-color); border-radius:3px; ' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18); padding:4px 0;';
    for (const s of item.sub) {
      if (s.type === 'separator') {
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px; margin:4px 8px; background:var(--border-color);';
        pop.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex; align-items:center; padding:5px 14px; ' +
        'cursor:pointer; font-size:12px; color:var(--text-primary); ' +
        'white-space:nowrap; user-select:none;';
      const lab = document.createElement('span');
      lab.textContent = (s.i18n && window._i) ? window._i(s.i18n, s.label) : (s.label || '');
      lab.style.cssText = 'flex:1 1 auto;';
      row.appendChild(lab);
      if (s.accel) {
        const acc = document.createElement('span');
        acc.textContent = s.accel;
        acc.style.cssText = 'margin-left:24px; color:var(--base1); font-size:11px;';
        row.appendChild(acc);
      }
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--background-color)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenubarPopup();
        if (s.cmd) {
          handleMenuCmd(s.cmd);
        } else if (s.role === 'quit') {
          bridge.window.close();
        }
      });
      pop.appendChild(row);
    }
    document.body.appendChild(pop);
    _activeMenubarPopup = pop;
  }
  function handleMenuCmd(cmd) {
    if (cmd === 'tools.toggleDevTools') {
      if (bridge.window && bridge.window.toggleDevTools) { bridge.window.toggleDevTools(); }
      return;
    }
    if (cmd === 'help.about') {
      bridge.dialog.message({ type: 'info', title: window._i('shell.about.title', '关于 qqq'), message: window._i('shell.about.version', 'qqq-shell v2'), detail: window._i('shell.about.desc', '便携 / Win7+ / 服务器热更') });
      return;
    }
    if (cmd === 'file.new' || cmd === 'file.open') {
      window.dispatchEvent(new CustomEvent('qqq-menu-cmd', { detail: { cmd } }));
      return;
    }
    if (cmd === 'file.newWindow') {
      if (bridge.window && bridge.window.new) {
        bridge.window.new().then(function (r) {
          if (r && !r.ok) { console.warn('[shell] new window failed'); }
        });
      }
      return;
    }
    // ---- Zoom (also reachable via Ctrl+= / Ctrl+- / Ctrl+0 via key-hook) ----
    if (cmd === 'zoom.in') { bridge.zoom && bridge.zoom.adjust(0.05); return; }
    if (cmd === 'zoom.out') { bridge.zoom && bridge.zoom.adjust(-0.05); return; }
    if (cmd === 'zoom.reset') { bridge.zoom && bridge.zoom.set(0.85); return; }
    // ---- Editor split right (Ctrl+\) ----
    if (cmd === 'editor.splitRight') {
      if (!window.qqqTabs) return;
      const groups = window.qqqTabs.getGroups();
      let activeFilePath = null;
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (g.type !== 'file') continue;
        const t = g.tabs.find(x => x.id === g.activeTabId);
        if (t && t.filePath) { activeFilePath = t.filePath; break; }
      }
      if (activeFilePath) {
        console.log('[shell] split right:', activeFilePath);
        window.qqqTabs.openFileInRightGroup(activeFilePath);
      }
      return;
    }
    // ---- Roam window activation (Tab / Space+Q global) ----
    if (cmd === 'window.activateRoam') {
      // Focus the q2-roam iframe if present
      const it = document.querySelector('iframe[src*="q2-roam"]');
      if (it && it.contentWindow) {
        try { it.contentWindow.focus(); } catch (e) { }
      }
      return;
    }
    // ---- Roam in-iframe commands: forward back into the iframe ----
    if (cmd === 'roam.openInIde' || cmd === 'roam.openMedia' ||
      cmd === 'roam.requestSize' || cmd === 'roam.scrollTop' ||
      cmd === 'roam.scrollBottom') {
      const it = document.querySelector('iframe[src*="q2-roam"]');
      if (it && it.contentWindow) {
        try { it.contentWindow.postMessage({ type: 'qqq-roam-cmd', cmd }, '*'); } catch (e) { }
      }
      return;
    }
    console.log('[menu] unhandled cmd:', cmd);
  }
  function renderMenubarLabels(schema) {
    const $bar = document.getElementById('qqq-menubar');
    if (!$bar || !schema) return;
    $bar.innerHTML = '';
    for (const item of schema.items || []) {
      const span = document.createElement('span');
      span.className = 'qqq-menubar-label';
      span.textContent = (item.i18n && window._i) ? window._i(item.i18n, item.label) : (item.label || '');
      span.style.cssText =
        'padding:0 10px; cursor:pointer; color:var(--text-primary); ' +
        'user-select:none; height:100%; display:inline-flex; align-items:center;';
      span.addEventListener('mouseenter', () => { span.style.background = 'rgba(128,128,128,0.10)'; });
      span.addEventListener('mouseleave', () => { span.style.background = ''; });
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        // toggle: if popup already open for THIS label, close; else open
        if (_activeMenubarPopup && _activeMenubarPopup._anchor === span) {
          closeMenubarPopup();
        } else {
          openMenubarPopup(span, item);
          if (_activeMenubarPopup) _activeMenubarPopup._anchor = span;
        }
      });
      $bar.appendChild(span);
    }
    // global click to close
    document.addEventListener('mousedown', (e) => {
      if (!_activeMenubarPopup) return;
      if (_activeMenubarPopup.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.qqq-menubar-label')) return;
      closeMenubarPopup();
    });
  }

  async function bootMenu() {
    const schema = window.qqqDefaultMenuSchema;
    if (!schema) return;
    try { await bridge.menu.set(schema); } catch (e) { console.warn('[shell] menu.set failed', e); }
    renderMenubarLabels(schema);
    window.addEventListener('qqq-lang-change', function () { renderMenubarLabels(schema); });
    bridge.menu.onFired(cmd => {
      console.log('[menu fired native]', cmd);
      handleMenuCmd(cmd);
    });
  }

  // ---- Zoom +/- buttons (step 0.05) ----
  function applyZoomCompensation(f) {
    ROOT.style.setProperty('--ai-zone-w', (AI_W / f) + 'px');
    const $label = document.getElementById('qqq-zoom-label');
    if ($label) $label.textContent = f.toFixed(2);
  }
  function bootZoomButtons() {
    const $in = document.getElementById('qqq-zoom-in');
    const $out = document.getElementById('qqq-zoom-out');
    if (!bridge.zoom) return;
    if ($in) $in.addEventListener('click', async () => {
      const f = await bridge.zoom.adjust(0.05);
      applyZoomCompensation(f);
    });
    if ($out) $out.addEventListener('click', async () => {
      const f = await bridge.zoom.adjust(-0.05);
      applyZoomCompensation(f);
    });
    // Listen for zoom changes from keyboard shortcuts (main process)
    if (bridge.zoom.onChanged) {
      bridge.zoom.onChanged(function (f) {
        applyZoomCompensation(f);
      });
    }
    // Initial compensation on boot
    bridge.zoom.get().then(applyZoomCompensation);
  }

  // ---- Statusbar ----
  function bootStatusbar(boot) {
    const $ver = document.getElementById('qqq-status-version');
    const $eng = document.getElementById('qqq-status-engine');
    const $clk = document.getElementById('qqq-status-clock');
    if ($ver) $ver.textContent = 'v' + (boot.version || '?');
    if ($eng) $eng.textContent = 'engine: ' + (boot.engineAlive ? 'on' : 'off');
    if ($clk) {
      const tick = () => {
        const d = new Date();
        $clk.textContent =
          String(d.getHours()).padStart(2, '0') + ':' +
          String(d.getMinutes()).padStart(2, '0') + ':' +
          String(d.getSeconds()).padStart(2, '0');
      };
      tick();
      setInterval(tick, 1000);
    }
  }

  // ---- A Zone (gaea host) ----
  function bootAZone() {
    const host = document.getElementById('qqq-a-zone');
    if (!host) return;
    if (window.qqqGaea) {
      window.qqqGaea.build(host);
    } else {
      host.innerHTML = '<div style="padding:12px; color:var(--base1); font-size:12px;">' + window._i('shell.gaeaHostLoading', 'gaea host 加载中...') + '</div>';
    }
  }

  // ---- Tab Manager (X zone upper) ----
  function bootTabManager() {
    const xUpper = document.getElementById('qqq-x-upper');
    if (!xUpper || !window.qqqTabs) return;
    window.qqqTabs.init(xUpper);
    // Roam tab is now provided by rage goods (via gaea-host tabs protocol).
  }

  // ---- AI Zone ----
  function bootAiZone() {
    const host = document.getElementById('qqq-ai-zone');
    if (!host || !window.qqqAiPanel) return;
    window.qqqAiPanel.build(host);
  }

  // ---- Output panel ----
  function bootOutputPanel() {
    const outEl = document.getElementById('qqq-x-output');
    const sashEl = document.getElementById('qqq-sash-output');
    const closeBtn = document.getElementById('qqq-output-close');

    if (!layoutState.outputVisible && outEl) {
      outEl.classList.add('qqq-hidden');
      if (sashEl) sashEl.classList.add('qqq-hidden');
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        hideOutput();
      });
    }
  }

  function showOutput() {
    const outEl = document.getElementById('qqq-x-output');
    const sashEl = document.getElementById('qqq-sash-output');
    if (outEl) {
      outEl.classList.remove('qqq-hidden');
      outEl.style.flexBasis = layoutState.outputH + 'px';
      outEl.style.height = layoutState.outputH + 'px';
    }
    if (sashEl) sashEl.classList.remove('qqq-hidden');
    layoutState.outputVisible = true;
    persistState();
  }

  function hideOutput() {
    const outEl = document.getElementById('qqq-x-output');
    const sashEl = document.getElementById('qqq-sash-output');
    if (outEl) outEl.classList.add('qqq-hidden');
    if (sashEl) sashEl.classList.add('qqq-hidden');
    layoutState.outputVisible = false;
    persistState();
  }

  // ---- AI Overlay (full-window, breaks out of iframe) ----
  function bootAiOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'qqq-ai-overlay';
    overlay.style.cssText =
      'display:none; position:fixed; inset:0; z-index:99999; ' +
      'background:rgba(0,0,0,0.88); cursor:default;';

    // ── 主题化滚动条（注入 style） ──
    var _scrollStyle = document.createElement('style');
    _scrollStyle.textContent =
      '#qqq-ai-overlay-content ::-webkit-scrollbar{width:8px;height:8px}' +
      '#qqq-ai-overlay-content ::-webkit-scrollbar-track{background:rgba(255,255,255,0.05)}' +
      '#qqq-ai-overlay-content ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:4px}' +
      '#qqq-ai-overlay-content ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.35)}';
    document.head.appendChild(_scrollStyle);

    var contentEl = document.createElement('div');
    contentEl.id = 'qqq-ai-overlay-content';
    contentEl.style.cssText =
      'position:absolute; top:0; left:0; right:0; bottom:64px; display:flex; align-items:center; ' +
      'justify-content:center; padding:32px; overflow:hidden;';

    // Bottom toolbar
    var toolbar = document.createElement('div');
    toolbar.id = 'qqq-ai-overlay-toolbar';
    toolbar.style.cssText =
      'position:absolute; bottom:0; left:0; right:0; height:64px; display:flex; ' +
      'align-items:center; justify-content:center; gap:16px; ' +
      'background:rgba(0,0,0,0.5); border-top:1px solid rgba(255,255,255,0.1);';

    function tbBtn(text, title, styles) {
      var b = document.createElement('button');
      b.textContent = text;
      b.title = title || '';
      b.style.cssText = 'padding:8px 18px; border:1px solid rgba(255,255,255,0.25); border-radius:6px; ' +
        'background:rgba(255,255,255,0.1); color:#fff; cursor:pointer; font-size:14px; ' +
        'user-select:none; line-height:1; ' + (styles || '');
      return b;
    }

    var zoomScale = 1.0;
    // 拖拽偏移（图片用）
    var _dragX = 0, _dragY = 0;
    function applyZoom() {
      var inner = contentEl.querySelector('img') || contentEl.querySelector('div');
      if (!inner) return;
      var tx = inner._dragState ? inner._dragState.getImgX() : _dragX;
      var ty = inner._dragState ? inner._dragState.getImgY() : _dragY;
      inner.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + zoomScale + ')';
      inner.style.transition = 'transform 0.15s ease';
    }

    // Copy button
    var copyBtn = tbBtn('', window._i('shell.overlay.copy', '复制到剪贴板'));
    copyBtn.setAttribute('data-i18n', 'shell.overlay.copy');
    copyBtn.textContent = '\uD83D\uDCCB \u590D\u5236';
    function doCopy(text) {
      var ok = false;
      // Try modern clipboard API first
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          copyBtn.textContent = '\u2705 ' + window._i('shell.overlay.copied', '已复制');
          setTimeout(function () { copyBtn.textContent = '\uD83D\uDCCB ' + window._i('shell.overlay.copy', '复制'); }, 1500);
        }).catch(function () { fallbackCopy(text); });
      } else {
        fallbackCopy(text);
      }
      function fallbackCopy(t) {
        // execCommand fallback
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); ok = true; } catch (ex) { }
        document.body.removeChild(ta);
        copyBtn.textContent = ok ? '\u2705 ' + window._i('shell.overlay.copied', '已复制') : '\u274C ' + window._i('shell.overlay.copyFailed', '失败');
        setTimeout(function () { copyBtn.textContent = '\uD83D\uDCCB ' + window._i('shell.overlay.copy', '复制'); }, 1500);
      }
    }
    copyBtn.addEventListener('click', function () {
      var img = contentEl.querySelector('img');
      if (img) { doCopy(img.src); return; }
      var div = contentEl.querySelector('div');
      if (div) { doCopy(div.innerText || div.textContent); }
    });

    // Zoom out
    var zoomOutBtn = tbBtn('−', window._i('shell.overlay.zoomOut', '缩小'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
    zoomOutBtn.addEventListener('click', function () {
      zoomScale = Math.max(0.25, zoomScale * 0.8);
      applyZoom();
    });

    // Zoom in
    var zoomInBtn = tbBtn('+', window._i('shell.overlay.zoomIn', '放大'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
    zoomInBtn.addEventListener('click', function () {
      zoomScale = Math.min(5.0, zoomScale * 1.25);
      applyZoom();
    });

    // Close (extra large)
    var closeBtn = tbBtn('✕', window._i('shell.overlay.close', '关闭 (Esc)'), 'font-size:24px; font-weight:bold; padding:8px 22px; ' +
      'background:rgba(220,50,47,0.5); border-color:rgba(220,50,47,0.7);');
    closeBtn.addEventListener('click', close);

    toolbar.appendChild(copyBtn);
    toolbar.appendChild(zoomOutBtn);
    toolbar.appendChild(zoomInBtn);
    toolbar.appendChild(closeBtn);

    overlay.appendChild(contentEl);
    overlay.appendChild(toolbar);
    document.body.appendChild(overlay);

    function close() {
      overlay.style.display = 'none';
      contentEl.innerHTML = '';
      zoomScale = 1.0;
      _dragX = 0; _dragY = 0;
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.style.display !== 'none') {
        close();
      }
    });

    // Mouse wheel zoom
    overlay.addEventListener('wheel', function (e) {
      if (overlay.style.display === 'none') return;
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomScale = Math.min(5.0, zoomScale * 1.15);
      } else {
        zoomScale = Math.max(0.25, zoomScale * 0.87);
      }
      applyZoom();
    }, { passive: false });

    // Listen for messages from AI iframe
    window.addEventListener('message', function (e) {
      if (!e.data || e.data.type !== 'qqq-ai-overlay') return;
      if (e.data.action === 'close') { close(); return; }

      if (e.data.action === 'open-image') {
        contentEl.innerHTML = '';
        zoomScale = 1.0;
        // ── 智能尺寸：目标 2x，不超过视口 ──
        var img = new Image();
        img.onload = function() {
          var nw = img.naturalWidth, nh = img.naturalHeight;
          var maxW = window.innerWidth * 0.9, maxH = window.innerHeight - 120;
          var targetW = Math.min(nw * 2, maxW);
          var targetH = Math.min(nh * 2, maxH);
          // 等比缩放：取两个方向中限制更紧的
          var scale = Math.min(targetW / nw, targetH / nh, 2.0);
          var finalW = Math.round(nw * scale), finalH = Math.round(nh * scale);
          img.style.cssText =
            'width:' + finalW + 'px; height:' + finalH + 'px; ' +
            'object-fit:contain; border-radius:6px; box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
            'display:block; position:relative; cursor:grab;';
          contentEl.appendChild(img);
          // ── 拖拽平移 ──
          var dragging = false, startX = 0, startY = 0;
          _dragX = 0; _dragY = 0;
          img.addEventListener('mousedown', function(ev) {
            if (ev.button !== 0) return;
            dragging = true; startX = ev.clientX; startY = ev.clientY;
            img.style.cursor = 'grabbing';
            ev.preventDefault();
          });
          window.addEventListener('mousemove', function(ev) {
            if (!dragging) return;
            _dragX += ev.clientX - startX; _dragY += ev.clientY - startY;
            startX = ev.clientX; startY = ev.clientY;
            img.style.transform = 'translate(' + _dragX + 'px,' + _dragY + 'px) scale(' + zoomScale + ')';
          });
          window.addEventListener('mouseup', function() {
            if (dragging) { dragging = false; img.style.cursor = 'grab'; }
          });
        };
        img.src = e.data.src;
        overlay.style.display = 'block';
      }

      if (e.data.action === 'open-table') {
        contentEl.innerHTML = '';
        zoomScale = 1.0;
        var wrapper = document.createElement('div');
        wrapper.style.cssText =
          'max-width:95vw; max-height:calc(100vh - 120px); overflow:auto; ' +
          'background:var(--card-bg,#2a2a2a); color:var(--text-primary,#d4d0c8); ' +
          'border-radius:8px; padding:20px; ' +
          'box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
          'transform:scale(1); transition:transform 0.15s ease;';
        wrapper.innerHTML = e.data.html;
        var tables = wrapper.querySelectorAll('table');
        for (var ti = 0; ti < tables.length; ti++) {
          var t = tables[ti];
          t.style.cssText = 'border-collapse:collapse; width:auto; font-size:13px;';
        }
        var cells = wrapper.querySelectorAll('th,td');
        for (var ci = 0; ci < cells.length; ci++) {
          cells[ci].style.cssText = 'border:1px solid var(--border-color,#333); padding:6px 12px; text-align:left;';
        }
        var ths = wrapper.querySelectorAll('th');
        for (var hi = 0; hi < ths.length; hi++) {
          ths[hi].style.background = 'var(--card-bg,#1e1e1e)';
        }
        contentEl.appendChild(wrapper);
        overlay.style.display = 'block';
      }
    });

    // Theme sync
    if (window.qqqTheme && window.qqqTheme.onChange) {
      window.qqqTheme.onChange(function (dark) {
        var wrapper = contentEl.querySelector('div');
        if (wrapper) {
          wrapper.style.background = dark ? '#2a2a2a' : '#eee8d5';
          wrapper.style.color = dark ? '#d4d0c8' : '#7a7874';
        }
      });
    }
  }

  // ---- Sashes ----
  function bootSashes() {
    // A-zone | X-zone sash
    const aSash = document.querySelector('[data-sash="a-right"]');
    const aEl = document.getElementById('qqq-a-zone');
    const xEl = document.getElementById('qqq-x-zone');
    if (aSash && aEl && xEl) {
      window.qqqSash.bindV(aSash,
        [{
          getW: () => aEl.offsetWidth,
          setW: w => { layoutState.aZoneW = w; aEl.style.flexBasis = w + 'px'; aEl.style.width = w + 'px'; },
          min: MIN,
        }],
        [{
          getW: () => xEl.offsetWidth,
          setW: w => { /* X zone is flex:1, auto-adjusts */ },
          min: MIN,
        }]
      );
    }

    // Output sash (horizontal)
    const oSash = document.getElementById('qqq-sash-output');
    const xUpper = document.getElementById('qqq-x-upper');
    const oEl = document.getElementById('qqq-x-output');
    if (oSash && xUpper && oEl) {
      window.qqqSash.bindH(oSash,
        [{
          getH: () => xUpper.offsetHeight,
          setH: h => { /* upper auto-adjusts */ },
          min: MIN,
        }],
        [{
          getH: () => oEl.offsetHeight,
          setH: h => { layoutState.outputH = h; oEl.style.flexBasis = h + 'px'; oEl.style.height = h + 'px'; },
          min: MIN,
        }]
      );
    }
  }

  // ---- Resize grip ----
  function bootResizeGrip() {
    const grip = document.getElementById('qqq-resize-grip');
    if (!grip || !bridge || !bridge.window) return;

    // In Electron, resize grip is handled via -webkit-app-region or IPC
    // For custom frame, we handle via IPC startResize if available
    // Otherwise it's just a visual indicator (Electron handles nwse-resize via the window frame)
  }

  // ---- Editor integration: open file from file explorer ----
  function hookFileExplorerToTabs() {
    // Listen for file-open events from file explorer
    // The file explorer dispatches 'qqq-file-open' custom event
    document.addEventListener('qqq-file-open', (e) => {
      const filePath = e.detail && e.detail.path;
      if (!filePath) return;

      // Open in tab manager
      const tab = window.qqqTabs.openFile(filePath, {
        preview: e.detail.preview,
        onRender: (pane, tabObj) => {
          // Use Monaco editor to render file
          if (window.qqqEditor) {
            pane.style.cssText = 'position:relative; width:100%; height:100%;';
            const editorMount = document.createElement('div');
            editorMount.style.cssText = 'position:absolute; inset:0;';
            pane.appendChild(editorMount);
            // Read and display file
            bridge.fs.read(filePath).then(content => {
              window.qqqEditor.openInPane(editorMount, filePath, content);
            }).catch(err => {
              pane.textContent = 'Error: ' + (err && err.message);
            });
          }
        }
      });
    });

    // Listen for qqq-file-open-in-pane (from tab-manager right-click -> open in right group)
    document.addEventListener('qqq-file-open-in-pane', (e) => {
      const filePath = e.detail && e.detail.path;
      const pane = e.detail && e.detail.pane;
      if (!filePath || !pane) return;
      if (window.qqqEditor) {
        pane.style.cssText = 'position:relative; width:100%; height:100%;';
        const editorMount = document.createElement('div');
        editorMount.style.cssText = 'position:absolute; inset:0;';
        pane.appendChild(editorMount);
        bridge.fs.read(filePath).then(content => {
          window.qqqEditor.openInPane(editorMount, filePath, content);
        }).catch(err => {
          pane.textContent = 'Error: ' + (err && err.message);
        });
      }
    });

    // ---- Keyboard: Ctrl+\ split → now handled by unified key-hook (see bootKeyHook) ----
    // (hard-coded keydown removed; binding lives in core/key-bindings.json under id 'editor.splitRight')
  }

  // ---- Unified postMessage RPC forwarder for all qood iframes ----
  function bootRpcForwarder() {
    window.addEventListener('message', async (e) => {
      if (!e.data) return;

      // Handle qqq-file-open from iframes (q2-roam, etc.)
      if (e.data.type === 'qqq-file-open' && e.data.path) {
        document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: e.data.path } }));
        return;
      }

      // Handle qqq-file-open-right from iframes → opens file in right editor group
      if (e.data.type === 'qqq-file-open-right' && e.data.path && window.qqqTabs && window.qqqTabs.openFileInRightGroup) {
        window.qqqTabs.openFileInRightGroup(e.data.path);
        return;
      }

      // Handle qqq-command from iframes (q4-sidebar, etc.)
      if (e.data.type === 'qqq-command' && e.data.cmd) {
        document.dispatchEvent(new CustomEvent('qqq-command', { detail: { cmd: e.data.cmd, url: e.data.url } }));
        return;
      }

      // Handle generic RPC: iframe calls bridge methods
      // params 默认整体当成单一参数（数组也是单一参数，修掉 diskFree 当前 bug）
      // 显式 spread: 传 { __spread: true, args: [...] } 才解构
      if (e.data.type === 'qqq-rpc') {
        const { method, params, id } = e.data;
        try {
          const parts = method.split('.');
          let fn = bridge;
          for (const k of parts) fn = fn[k];
          let result;
          if (params && typeof params === 'object' && params.__spread === true && Array.isArray(params.args)) {
            result = await fn.apply(null, params.args);
          } else if (params === undefined) {
            result = await fn.call(null);
          } else {
            result = await fn.call(null, params);
          }
          if (e.source) e.source.postMessage({ type: 'qqq-rpc-reply', id, result, error: null }, '*');
        } catch (err) {
          if (e.source) e.source.postMessage({ type: 'qqq-rpc-reply', id, result: null, error: { message: String(err) } }, '*');
        }
      }
    });
  }

  // ---- Boot info ----
  function fillBootInfo(boot) {
    console.log('[qqq-shell] boot info:', {
      platform: boot.platform,
      arch: boot.arch,
      version: boot.version,
      engineAlive: boot.engineAlive,
      electron: !!window.qqqIsElectron,
    });
  }

  // ---- KeyHookService bootstrap ----
  // - Loads core/key-bindings.json
  // - Initializes window.qqqKeyHook with the binding list
  // - Routes any unhandled binding (no explicit on() handler) into handleMenuCmd
  async function bootKeyHook() {
    if (!window.qqqKeyHook) {
      console.warn('[keyhook] window.qqqKeyHook missing — script not loaded?');
      return;
    }
    let bindings = [];
    try {
      const res = await fetch('core/key-bindings.json', { cache: 'no-store' });
      bindings = await res.json();
      if (!Array.isArray(bindings)) bindings = [];
    } catch (e) {
      console.warn('[keyhook] failed to load key-bindings.json:', e && e.message);
    }
    try {
      window.qqqKeyHook.init(bindings);
    } catch (e) {
      console.warn('[keyhook] init failed:', e && e.message);
      return;
    }
    // Catch-all: every binding emits a DOM event when no explicit handler is wired.
    document.addEventListener('qqq-key-cmd', (e) => {
      const id = e.detail && e.detail.id;
      if (!id) return;
      handleMenuCmd(id);
    });
    console.log('[keyhook] ready, bindings=' + bindings.length);
  }

  // ---- Main ----
  async function main() {
    await loadState();
    applyLayout();

    _prevWinW = window.innerWidth;
    _prevWinH = window.innerHeight;
    window.addEventListener('resize', onWindowResize);

    bootWindowControls();
    bootThemeToggle();
    bootZoomButtons();
    bootAiViewport();
    bootLangSwitcher();

    // Unified RPC forwarder MUST be registered before any iframe loads
    bootRpcForwarder();

    // Tab manager MUST init before A Zone (gaea-host may create tabs)
    bootTabManager();

    // A Zone (gaea-host processes pending goods, may add tabs)
    bootAZone();

    // AI Zone
    bootAiZone();

    // AI Overlay (must be after AI zone to catch iframe messages)
    bootAiOverlay();
    // Output panel
    bootOutputPanel();

    // Sashes
    bootSashes();

    // Menu
    await bootMenu();

    // Boot info
    let boot;
    try { boot = await bridge.boot.getInfo(); }
    catch (e) { boot = { version: '?', engineAlive: false, platform: 'browser', arch: 'na' }; }
    // Expose boot info for iframes (q2-roam, etc.)
    window.qqqBootInfo = boot;
    bootStatusbar(boot);
    fillBootInfo(boot);

    // Resize grip
    bootResizeGrip();

    // Hook file explorer -> tabs
    hookFileExplorerToTabs();

    // KeyHook (loads bindings + globalShortcut + window/iframe dispatchers)
    await bootKeyHook();

    // Expose layout API for sash persistence
    window.qqqLayout = {
      persist: persistState,
      showOutput: showOutput,
      hideOutput: hideOutput,
      getState: () => layoutState,
    };

    console.log('[qqq-shell] ready (new layout)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
