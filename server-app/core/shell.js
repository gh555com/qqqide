// ============================================================================
// shell.js - QQQ Shell v2 - NEW layout bootstrap
// Layout: Menu(top) | A-zone + X-zone + AI-zone (middle) | Status(bottom)
// ============================================================================
(function () {
  'use strict';

  const bridge = window.qqqideBridge;
  const ROOT = document.documentElement;
  const MIN = 123;
  const AI_W = 389;
  const SASH_W = 6;

  // ---- Layout state (persisted via StateStore, not localStorage) ----
  const STATE_NS = 'qqqide';
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
    // Authoritative: StateStore (debounced, atomic, cloud=true via qqqide).
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
    const T = window.qqqideTheme;
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
    if (!host || !window.qqqideViewport) return;
    window.qqqideViewport.build(host);
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
        'font-size:12px; color:var(--text-primary); ' +
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
    if (cmd === 'file.exit') {
      // 退出整个应用（关闭所有窗口），退出前保存所有打开的项目路径
      if (bridge.app && bridge.app.quitAll) {
        bridge.app.quitAll();
      } else {
        // 兜底：关闭当前窗口
        bridge.window.close();
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
        // [silent] split right
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
    // [silent] menu unhandled cmd
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
        'padding:0 10px; color:var(--text-primary); ' +
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
      // [silent] menu fired native
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
    const $freeInd = document.getElementById('qqq-status-free');
    const $freeBadge = document.getElementById('qqq-status-free-badge');
    const $freeCd = document.getElementById('qqq-status-free-cd');
    if ($ver) $ver.textContent = 'v' + (boot.version || '?');
    if ($eng) $eng.textContent = 'engine: ' + (boot.engineAlive ? 'on' : 'off');

    // ═══ 单调时钟锚点（变速齿轮免疫，三保险） ═══
    // 优先级：SSE(gh555.com) > Cloudflare trace > timeapi.io
    var _timeAnchor = null; // { perfNow, utcMs, source: 'sse'|'cf'|'timeapi' }
    var _lastSseAnchor = null; // 最新 SSE 锚点（最高优先级）

    // 从 SSE 获取时间（AI 面板通过 parent._sseTimeAnchor 推送）
    function pollSseAnchor() {
      if (window._sseTimeAnchor && window._sseTimeAnchor !== _lastSseAnchor) {
        _lastSseAnchor = window._sseTimeAnchor;
        _timeAnchor = {
          perfNow: window._sseTimeAnchor.perfNow,
          utcMs: window._sseTimeAnchor.utcMs,
          source: 'sse'
        };
      }
    }

    // 从公共时间服务器获取 UTC 时间（不请求我们服务器）
    function calibrateFromPublicTime() {
      // 首先检查是否有新的 SSE 锚点（最高优先级）
      pollSseAnchor();

      // 如果已有 SSE 锚点且不超过 10 分钟，跳过公共校准
      if (_timeAnchor && _timeAnchor.source === 'sse') {
        var age = performance.now() - _timeAnchor.perfNow;
        if (age < 600000) return; // SSE 锚点 < 10 分钟，够新鲜
      }

      // 主：Cloudflare trace（全球 CDN，含中国）→ 解析 ts=Unix秒
      fetch('https://www.cloudflare.com/cdn-cgi/trace', { cache: 'no-cache' })
        .then(function (r) { return r.text(); })
        .then(function (text) {
          var m = text.match(/^ts=([\d.]+)/m);
          if (m) {
            _timeAnchor = {
              perfNow: performance.now(),
              utcMs: parseFloat(m[1]) * 1000,
              source: 'cf'
            };
            return;
          }
          throw new Error('no ts');
        })
        .catch(function () {
          // 备：timeapi.io（JSON，CORS 友好）
          return fetch('https://timeapi.io/api/Time/current/zone?timeZone=UTC', { cache: 'no-cache' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data && data.dateTime) {
                var dt = data.dateTime;
                if (!/[Zz+\-]\d{2}:\d{2}$/.test(dt) && !/[Zz]$/.test(dt)) dt += 'Z';
                _timeAnchor = {
                  perfNow: performance.now(),
                  utcMs: new Date(dt).getTime(),
                  source: 'timeapi'
                };
              }
            });
        })
        .catch(function () { /* 两次都失败，沿用旧锚点 */ });
    }

    // 从单调锚点推算当前 UTC 毫秒
    function getCalibratedUtcMs() {
      if (_timeAnchor && _timeAnchor.perfNow && _timeAnchor.utcMs) {
        return _timeAnchor.utcMs + (performance.now() - _timeAnchor.perfNow);
      }
      return Date.now(); // 降级：未校准前用本地时间
    }

    // 判断是否在免费时段
    function isFreeWindow(utcMs) {
      var d = new Date(utcMs);
      var day = d.getUTCDay();
      if (day === 0) return true; // 周日全天
      var h = d.getUTCHours();
      return h < 2 || (h >= 12 && h < 14);
    }

    // 下次免费开始/结束时间（UTC ms）
    function nextFreeBoundary(utcMs) {
      var d = new Date(utcMs);
      var day = d.getUTCDay();
      var h = d.getUTCHours();
      if (isFreeWindow(utcMs)) {
        if (day === 0) { d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); }
        if (h < 2) { d.setUTCHours(2, 0, 0, 0); return d.getTime(); }
        d.setUTCHours(14, 0, 0, 0); return d.getTime();
      }
      if (h < 12) { d.setUTCHours(12, 0, 0, 0); return d.getTime(); }
      d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); return d.getTime();
    }

    function fmtHMS(ms) {
      if (ms <= 0) return '00:00:00';
      var s = Math.ceil(ms / 1000);
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      s = s % 60;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    function updateFreeIndicator() {
      if (!$freeInd || !$freeBadge) return;
      var utcMs = getCalibratedUtcMs();
      var free = isFreeWindow(utcMs);
      var boundary = nextFreeBoundary(utcMs);
      var remaining = boundary - utcMs;
      var t = window._i || function (k, d) { return d; };

      if (free) {
        $freeInd.style.display = 'inline-flex';
        if (remaining < 300000) {
          $freeBadge.textContent = t('shell.free.ending', '🎈免费将结束') + ' ' + fmtHMS(remaining);
          $freeBadge.className = 'qqq-free-badge qqq-free-ending';
        } else {
          $freeBadge.textContent = t('shell.free.active', '💎 免费中') + ' ' + fmtHMS(remaining);
          $freeBadge.className = 'qqq-free-badge qqq-free-on';
        }
      } else if (remaining > 0 && remaining < 43200000) {
        $freeInd.style.display = 'inline-flex';
        $freeBadge.textContent = t('shell.free.soonPrefix', '🤍距离下次免费') + ' ' + fmtHMS(remaining);
        $freeBadge.className = 'qqq-free-badge qqq-free-soon';
      } else {
        $freeInd.style.display = 'none';
      }
    }

    if ($clk) {
      // 首次校准
      calibrateFromPublicTime();
      // 每 1 分钟重新校准（请求 worldtimeapi.org，与 gh555.com 无关）
      setInterval(calibrateFromPublicTime, 60000);

      var tick = function () {
        pollSseAnchor(); // 每秒检查是否有新的 SSE 时间（最高优先级）
        var utcMs = getCalibratedUtcMs();
        var d = new Date(utcMs);
        $clk.textContent =
          String(d.getHours()).padStart(2, '0') + ':' +
          String(d.getMinutes()).padStart(2, '0') + ':' +
          String(d.getSeconds()).padStart(2, '0');
        updateFreeIndicator();
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
      host.innerHTML = '<div style="padding:12px; color:var(--base1); font-size:12px;">' + window._i('shell.gaeaHostLoading', 'gaea host 加载中....') + '</div>';
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
    // ★ 中面板始终加载（左右翼在 bootBulbs 中预初始化）
    var centerHost = document.getElementById('qqq-ai-zone');
    if (centerHost && window.qqqidePanel) {
      window.qqqidePanel.build(centerHost, 1);
    }
  }

  // ---- 红色灯泡：左右翼开关 + 窗口伸缩（中间块不动） ----
  var _bulbState = { left: false, right: false };
  var _wingLocked = false; // 不应期锁：toggle 进行中拒绝一切重复点击

  function bootBulbs() {
    var d1 = document.getElementById('qqq-bulb-1');
    var d2 = document.getElementById('qqq-bulb-2');
    if (!d1 || !d2) return;

    try {
      var saved = localStorage.getItem('qqq-ai-bulbs');
      if (saved) { var p = JSON.parse(saved); _bulbState.left = !!p.left; _bulbState.right = !!p.right; }
    } catch (_) { }

    var _main = document.getElementById('qqq-main');
    var _wl = document.getElementById('qqq-wing-left');
    var _wr = document.getElementById('qqq-wing-right');

    // ★ 预初始化：启动时即创建全部三个面板的 iframe（中面板在 bootAiZone 已建）
    //    翼板 iframe 在 width:0 容器内静默加载，首开时零等待
    function _preinitWings() {
      if (_wl && !_wl.querySelector('iframe') && window.qqqidePanel) {
        window.qqqidePanel.build(_wl, 0);
      }
      if (_wr && !_wr.querySelector('iframe') && window.qqqidePanel) {
        window.qqqidePanel.build(_wr, 2);
      }
    }

    function _applyWings() {
      var leftOn = _bulbState.left;
      var rightOn = _bulbState.right;

      if (_main) {
        _main.style.left = leftOn ? AI_W + 'px' : '0';
        _main.style.right = rightOn ? AI_W + 'px' : '0';
      } else {
        console.warn('[wings] _main NOT FOUND!');
      }

      if (_wl) {
        _wl.style.width = leftOn ? AI_W + 'px' : '0';
      } else {
        console.warn('[wings] LEFT WING ELEMENT MISSING!');
      }

      if (_wr) {
        _wr.style.width = rightOn ? AI_W + 'px' : '0';
      } else {
        console.warn('[wings] RIGHT WING ELEMENT MISSING!');
      }
    }

    // ★ 魔术遮罩（方案 B）：toggle 期间覆盖全窗口，阻塞一切交互 + 视觉遮盖
    var _wingMask = null;
    function _showMask() {
      if (_wingMask) return;
      _wingMask = document.createElement('div');
      _wingMask.className = 'qqq-wing-mask';
      var txt = document.createElement('div');
      txt.className = 'qqq-wing-mask-text';
      // 优先走 i18n，无则用硬编码回退
      txt.textContent = (window._i && window._i('wings.redrawing', '重绘中')) || '重绘中';
      _wingMask.appendChild(txt);
      // 捕获取消一切事件（click/keydown/滚轮等）
      _wingMask.addEventListener('keydown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
      _wingMask.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false, capture: true });
      _wingMask.addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);
      document.body.appendChild(_wingMask);
    }
    function _hideMask() {
      if (!_wingMask) return;
      _wingMask.remove();
      _wingMask = null;
    }

    // ★ 原子帧 toggle：不应期锁 → 魔术遮罩 → await 窗口缩放 → rAF 批处理 CSS → 收遮罩 → 解锁
    async function _toggle(index) {
      if (_wingLocked) return; // 不应期内拒绝一切操作
      _wingLocked = true;
      // 安全网：1.5s 后强制解锁 + 收遮罩（极端情况兜底）
      var safetyTimer = setTimeout(function () { _wingLocked = false; _hideMask(); }, 1500);

      // ① 立刻弹出魔术遮罩，等一帧确保已上屏，再动任何 UI
      _showMask();
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });

      if (index === 0) _bulbState.left = !_bulbState.left;
      else _bulbState.right = !_bulbState.right;

      // 关闭 AI 视口下拉（防止 fixed 定位漂移到 0,0）
      if (window.qqqideViewport && window.qqqideViewport.closeDropdown) {
        window.qqqideViewport.closeDropdown();
      }

      // 灯泡红点（遮罩已覆盖，用户不可见）
      var dot = index === 0 ? d1 : d2;
      dot.classList.toggle('on', index === 0 ? _bulbState.left : _bulbState.right);

      // ② 窗口先就位（主进程同步 setBounds）
      var deltaLeft = 0, deltaRight = 0;
      if (index === 0) deltaLeft = _bulbState.left ? AI_W : -AI_W;
      else deltaRight = _bulbState.right ? AI_W : -AI_W;
      try {
        if (bridge && bridge.window && bridge.window.adjustBounds) {
          await bridge.window.adjustBounds(deltaLeft, deltaRight);
        }
      } catch (e) { console.warn('[wings] adjustBounds error:', e); }

      // ③ 窗口已就位，下一帧统一批处理 CSS，再等一帧收遮罩
      requestAnimationFrame(function () {
        _applyWings();
        try { localStorage.setItem('qqq-ai-bulbs', JSON.stringify(_bulbState)); } catch (_) { }
        requestAnimationFrame(function () {
          clearTimeout(safetyTimer);
          _hideMask();
          _wingLocked = false;
        });
      });
    }

    d1.addEventListener('click', function () { _toggle(0); });
    d2.addEventListener('click', function () { _toggle(1); });

    // 初始恢复：仅设 CSS（不调窗口尺寸，防重启累加）
    if (_bulbState.left) d1.classList.add('on');
    if (_bulbState.right) d2.classList.add('on');
    _applyWings();
    // 预初始化左右翼 iframe（width:0 容器内静默加载）
    _preinitWings();
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
    // 全局唯一 overlay ID（用于跨窗口协调：同时最多一个悬浮预览）
    var _overlayId = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    // IPC sync 替代 BroadcastChannel：跨窗口 overlay 协调
    var _ovUnsub = null;
    try {
      if (window.qqqideBridge && window.qqqideBridge.sync) {
        _ovUnsub = window.qqqideBridge.sync.onMessage(function (channel, data) {
          if (channel === 'overlay-open' && data && data.id !== _overlayId) {
            // 其他窗口打开了 overlay → 关闭自己的
            close();
          }
        });
      }
    } catch (_) { }

    var overlay = document.createElement('div');
    overlay.id = 'qqqide-overlay';
    overlay.style.cssText =
      'display:none; position:absolute; inset:0; z-index:99999; ' +
      'background:rgba(0,0,0,0.88);';

    // ── 主题化滚动条（注�?style�?──
    var _scrollStyle = document.createElement('style');
    _scrollStyle.textContent =
      '#qqqide-overlay-content ::-webkit-scrollbar{width:8px;height:8px}' +
      '#qqqide-overlay-content ::-webkit-scrollbar-track{background:rgba(255,255,255,0.05)}' +
      '#qqqide-overlay-content ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:4px}' +
      '#qqqide-overlay-content ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.35)}' +
      '#qqqide-overlay-content>div::-webkit-scrollbar{display:none}';
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
        'background:rgba(255,255,255,0.1); color:#fff; font-size:14px; ' +
        'user-select:none; line-height:1; ' + (styles || '');
      return b;
    }

    var zoomScale = 1.0;
    // 拖拽偏移（图片和表格共用 translate）
    var _dragX = 0, _dragY = 0;
    function applyZoom() {
      var img = contentEl.querySelector('img');
      if (img) {
        img.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
        img.style.transition = 'transform 0.15s ease';
        return;
      }
      // 表格：wrapper 在 clipBox 内，统一采用 scale+translate（禁止 reflow，保持原始比例与换行）
      var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper');
      if (!wrapper) {
        // 回退：可能是旧版本无 class 的 div
        var div = contentEl.querySelector('div > div');
        if (div && !div.querySelector('img')) wrapper = div;
      }
      if (!wrapper) {
        var div = contentEl.querySelector('div');
        if (div && !div.querySelector('img') && !div.classList.contains('qqq-overlay-table-wrapper')) wrapper = div;
      }
      if (wrapper) {
        wrapper.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
        wrapper.style.transition = 'transform 0.15s ease';
      }
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
      // Copy selected text first, fallback to all text
      var sel = window.getSelection();
      if (sel && sel.toString().trim()) {
        doCopy(sel.toString());
        return;
      }
      var img = contentEl.querySelector('img');
      if (img) { doCopy(img.src); return; }
      var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper') || contentEl.querySelector('div');
      if (wrapper) { doCopy(wrapper.innerText || wrapper.textContent); }
    });

    // Zoom out（跳过冷却护盾，准许快速连按）
    var zoomOutBtn = tbBtn('−', window._i('shell.overlay.zoomOut', '缩小'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
    zoomOutBtn.setAttribute('data-no-cd', '');
    zoomOutBtn.addEventListener('click', function () {
      zoomScale = Math.max(0.25, zoomScale * 0.8);
      applyZoom();
    });

    // Zoom in（跳过冷却护盾，准许快速连按）
    var zoomInBtn = tbBtn('+', window._i('shell.overlay.zoomIn', '放大'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
    zoomInBtn.setAttribute('data-no-cd', '');
    zoomInBtn.addEventListener('click', function () {
      zoomScale = Math.min(5.0, zoomScale * 1.25);
      applyZoom();
    });

    // Close (extra large) — custom tooltip: high-contrast instant cursor-following
    var closeBtn = tbBtn('\u2715', '', 'font-size:24px; font-weight:bold; padding:8px 22px; ' +
      'background:rgba(220,50,47,0.5); border-color:rgba(220,50,47,0.7);');
    closeBtn.addEventListener('click', close);

    // ★ 自定义高对比度瞬间弹出 tooltip，跟随光标
    var _closeTt = document.createElement('div');
    _closeTt.textContent = '= Right Click';
    _closeTt.style.cssText = 'display:none;position:fixed;z-index:100001;pointer-events:none;' +
      'background:#000;color:#fff;padding:6px 12px;font-size:13px;font-weight:bold;' +
      'border:2px solid #dc322f;border-radius:4px;white-space:nowrap;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.8);';
    document.body.appendChild(_closeTt);
    closeBtn.addEventListener('mouseenter', function(e) {
      _closeTt.style.display = '';
      _closeTt.style.left = (e.clientX + 16) + 'px';
      _closeTt.style.top = (e.clientY - 36) + 'px';
    });
    closeBtn.addEventListener('mousemove', function(e) {
      _closeTt.style.left = (e.clientX + 16) + 'px';
      _closeTt.style.top = (e.clientY - 36) + 'px';
    });
    closeBtn.addEventListener('mouseleave', function() {
      _closeTt.style.display = 'none';
    });

    // 右键关闭
    overlay.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      close();
    });

    toolbar.appendChild(copyBtn);
    toolbar.appendChild(zoomOutBtn);
    toolbar.appendChild(zoomInBtn);
    toolbar.appendChild(closeBtn);

    overlay.appendChild(contentEl);
    overlay.appendChild(toolbar);
    // ★ 挂到 #qqq-main，遮罩仅覆盖中间区域，左右翼不受影响
    var _main = document.getElementById('qqq-main');
    (_main || document.body).appendChild(overlay);

    function close() {
      try { _stopRepeat(); } catch (_) { }
      _closeTt.style.display = 'none';
      overlay.style.display = 'none';
      dpad.style.display = 'none';
      contentEl.innerHTML = '';
      contentEl.style.overflow = '';
      zoomScale = 1.0;
      _dragX = 0; _dragY = 0;
    }
    var _baseClose = close;  // 保存原始 close，用于恢复

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.style.display !== 'none') {
        close();
      }
    });

    // Mouse wheel zoom（统一图片和表格，滚轮=缩放）
    overlay.addEventListener('wheel', function (e) {
      if (overlay.style.display === 'none') return;
      e.preventDefault(); e.stopPropagation();
      if (e.deltaY < 0) { zoomScale = Math.min(5.0, zoomScale * 1.15); }
      else { zoomScale = Math.max(0.25, zoomScale * 0.87); }
      applyZoom();
    }, { passive: false, capture: true });

    // ── 十字方向键（Game Boy 风格，独立控件，移动画布）──
    var dpad = document.createElement('div');
    dpad.style.cssText =
      'display:none; position:absolute; right:14px; bottom:78px; z-index:100000; ' +
      'width:96px; height:96px; user-select:none;';
    var BS = 32; // button size
    function _crossBtn(sym, top, left) {
      var b = document.createElement('button');
      b.textContent = sym; b.setAttribute('data-no-cd', '');
      b.style.cssText = 'position:absolute; width:' + BS + 'px; height:' + BS + 'px; padding:0; font-size:16px; line-height:1; ' +
        'border:1px solid rgba(255,255,255,0.35); border-radius:4px; background:rgba(0,0,0,0.55); ' +
        'color:#ccc; display:flex; align-items:center; justify-content:center;';
      b.style.top = top + 'px'; b.style.left = left + 'px';
      return b;
    }
    var btnUp = _crossBtn('▲', 0, BS);
    var btnLeft = _crossBtn('◀', BS, 0);
    var btnCenter = _crossBtn('\u2302', BS, BS);
    var btnRight = _crossBtn('▶', BS, BS * 2);
    var btnDown = _crossBtn('▼', BS * 2, BS);
    btnCenter.title = window._i('shell.overlay.resetPosition', '重置位置');
    btnCenter.style.background = 'rgba(255,255,255,0.12)';
    btnCenter.style.borderColor = 'rgba(255,255,255,0.25)';
    var _initZoom = 1.0;
    function _nudge(dx, dy) {
      var step = 80;
      var s = zoomScale || 1;
      // 图片和表格统一用 _dragX/_dragY + translate，scrollLeft 在 transform scale 下无效
      _dragX -= dx * step / s;
      _dragY -= dy * step / s;
      applyZoom();
    }
    function _resetView() {
      _dragX = 0; _dragY = 0;
      var w = contentEl.querySelector('.qqq-overlay-table-wrapper') || contentEl.querySelector('img');
      if (w) { zoomScale = _initZoom; }
      else { zoomScale = 1.0; }
      applyZoom();
    }
    // ── 按住连点：mousedown 启动定时器，mouseup/mouseleave 停止 ──
    var _repeatTimer = 0, _repeatDelay = 150, _repeatInterval = 50;
    function _startRepeat(dx, dy) {
      _nudge(dx, dy);
      _repeatTimer = setTimeout(function () {
        _repeatTimer = setInterval(function () { _nudge(dx, dy); }, _repeatInterval);
      }, _repeatDelay);
    }
    function _stopRepeat() {
      if (_repeatTimer) { clearTimeout(_repeatTimer); clearInterval(_repeatTimer); _repeatTimer = 0; }
    }
    function _bindDpadBtn(btn, dx, dy) {
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); _startRepeat(dx, dy); });
      btn.addEventListener('mouseup', function (e) { e.preventDefault(); _stopRepeat(); });
      btn.addEventListener('mouseleave', function (e) { _stopRepeat(); });
    }
    _bindDpadBtn(btnUp, 0, -1);
    _bindDpadBtn(btnDown, 0, 1);
    _bindDpadBtn(btnLeft, -1, 0);
    _bindDpadBtn(btnRight, 1, 0);
    btnCenter.addEventListener('mousedown', function (e) { e.preventDefault(); _resetView(); });
    dpad.appendChild(btnUp); dpad.appendChild(btnLeft); dpad.appendChild(btnCenter);
    dpad.appendChild(btnRight); dpad.appendChild(btnDown);
    overlay.appendChild(dpad);

    // Listen for messages from AI iframe
    window.addEventListener('message', function (e) {
      if (!e.data || e.data.type !== 'qqqide-overlay') return;
      if (e.data.action === 'close') { close(); return; }

      // 跨窗口协调：广播自己的 overlay ID，其他窗口收到后自动关闭
      try {
        if (window.qqqideBridge && window.qqqideBridge.sync) {
          window.qqqideBridge.sync.broadcast('overlay-open', { id: _overlayId });
        }
      } catch (_) { }

      if (e.data.action === 'open-image') {
        // 强制清理上一轮残留状态（含 close 函数恢复）
        close = _baseClose;
        _stopRepeat();
        overlay.style.display = 'none';
        contentEl.innerHTML = '';
        contentEl.style.overflow = '';
        zoomScale = 1.0;
        _dragX = 0; _dragY = 0;
        // ★ 先让 overlay 可见以取得正确容器尺寸，再加载图片（避免缓存图 onload 同步触发时容器尺寸为 0）
        overlay.style.display = 'block';
        contentEl.style.overflow = 'hidden';
        // ── 边界适配：尝试 2x 放大，但绝不超出内容区可用空间 ──
        var img = new Image();
        img.onload = function () {
          var nw = img.naturalWidth, nh = img.naturalHeight;
          // 内容区可用空间：overlay 填充 #qqq-main，扣除工具栏 64px + 内边距 32px×2
          var availW = Math.max(200, (overlay.clientWidth || window.innerWidth) - 64);
          var availH = Math.max(150, (overlay.clientHeight || window.innerHeight) - 64 - 64);
          // 理想：2x 放大；上限：不超过可用空间
          var targetW = Math.min(nw * 2, availW);
          var targetH = Math.min(nh * 2, availH);
          // 统一缩放比：取宽高两个方向中更紧的那个，且不超 2.0（2x 封顶）
          var scale = Math.min(targetW / nw, targetH / nh, 2.0);
          // 若原图已大于可用空间，scale < 1.0 → 缩小适配
          var finalW = Math.round(nw * scale), finalH = Math.round(nh * scale);
          img.style.cssText =
            'width:' + finalW + 'px; height:' + finalH + 'px; ' +
            'object-fit:contain; box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
            'display:block; user-select:none; will-change:transform;';
          contentEl.appendChild(img);
          contentEl.style.overflow = 'visible';
          // ── 拖拽平移 ──
          var dragging = false, sx = 0, sy = 0, _raf = 0, _pending = false;
          function onMD(ev) {
            if (ev.button !== 0) return;
            dragging = true; sx = ev.clientX; sy = ev.clientY;
            img.style.transition = 'none';
            ev.preventDefault();
          }
          function onMM(ev) {
            if (!dragging) return;
            var s = zoomScale || 1;
            _dragX += (ev.clientX - sx) / s; _dragY += (ev.clientY - sy) / s;
            sx = ev.clientX; sy = ev.clientY;
            if (!_pending) {
              _pending = true;
              _raf = requestAnimationFrame(function () {
                _pending = false;
                img.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
              });
            }
          }
          function onMU() {
            dragging = false;
            if (_raf) { cancelAnimationFrame(_raf); _raf = 0; _pending = false; }
            img.style.transition = '';
          }
          img.addEventListener('mousedown', onMD);
          window.addEventListener('mousemove', onMM);
          window.addEventListener('mouseup', onMU);
          // ── 关闭时清理 ──
          var _origClose = close;
          close = function () {
            window.removeEventListener('mousemove', onMM);
            window.removeEventListener('mouseup', onMU);
            contentEl.style.overflow = '';
            close = _origClose;
            _origClose();
          };
        };
        img.src = e.data.src;
        dpad.style.display = 'block';
      }

      if (e.data.action === 'open-table') {
        try {
          // 强制清理上一轮残留状态（含 close 函数恢复）
          close = _baseClose;
          _stopRepeat();
          overlay.style.display = 'none';
          contentEl.innerHTML = '';
          contentEl.style.overflow = 'hidden';
          zoomScale = 1.0;
          _dragX = 0; _dragY = 0;

          // 内容区可用空间：overlay 尺寸未必可用（display=none），回退到 window 尺寸
          var _availW = Math.max(200, (overlay.clientWidth || window.innerWidth) - 64);
          var _availH = Math.max(150, (overlay.clientHeight || window.innerHeight) - 64 - 64);

          var clipBox = document.createElement('div');
          clipBox.style.cssText =
            'width:' + _availW + 'px; height:' + _availH + 'px; overflow:hidden; ' +
            'display:flex; align-items:center; justify-content:center;';

          var wrapper = document.createElement('div');
          wrapper.className = 'qqq-overlay-table-wrapper';
          wrapper.style.cssText =
            'background:var(--card-bg,#2a2a2a); color:var(--text-primary,#dcd8d0); ' +
            'border-radius:8px; padding:20px; user-select:text; ' +
            'box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
            'transform-origin:center center; ' +
            'transition:transform 0.15s ease; display:inline-block;';
          wrapper.innerHTML = e.data.html;

          var tables = wrapper.querySelectorAll('table');
          for (var ti = 0; ti < tables.length; ti++) {
            var t = tables[ti];
            t.style.borderCollapse = 'collapse';
            t.style.fontSize = '13px';
            t.style.tableLayout = 'auto';
            t.style.width = 'auto';
          }
          var cells = wrapper.querySelectorAll('th,td');
          for (var ci = 0; ci < cells.length; ci++) {
            var c = cells[ci];
            c.style.border = '1px solid var(--border-color,#333)';
            if (!c.style.padding) c.style.padding = '4px 8px';
            if (!c.style.textAlign || c.style.textAlign === '') c.style.textAlign = 'left';
            c.style.whiteSpace = 'nowrap';
          }
          var ths = wrapper.querySelectorAll('th');
          for (var hi = 0; hi < ths.length; hi++) {
            ths[hi].style.background = 'var(--card-bg,#1e1e1e)';
          }

          // ★ 表�?�块展开：原样保留 AI 面板渲染结果，不覆盖样式
          // pre/code 保持原 CSS class（如 .lang-xxx），不强制改写换行/断字

          clipBox.appendChild(wrapper);
          contentEl.appendChild(clipBox);

          overlay.style.visibility = 'hidden';
          overlay.style.display = 'block';

          var tables2 = wrapper.querySelectorAll('table');
          for (var t2i = 0; t2i < tables2.length; t2i++) {
            var tb = tables2[t2i];
            var firstRow = tb.querySelector('tr');
            if (firstRow) {
              var colWidths = [];
              var rowCells = firstRow.children;
              for (var rci = 0; rci < rowCells.length; rci++) {
                colWidths.push(rowCells[rci].offsetWidth);
              }
              tb.style.tableLayout = 'fixed';
              tb.style.width = 'auto';
              var colgroup = document.createElement('colgroup');
              for (var cwi = 0; cwi < colWidths.length; cwi++) {
                var col = document.createElement('col');
                col.style.width = colWidths[cwi] + 'px';
                colgroup.appendChild(col);
              }
              if (tb.firstChild) {
                tb.insertBefore(colgroup, tb.firstChild);
              } else {
                tb.appendChild(colgroup);
              }
            }
          }

          var natW = wrapper.scrollWidth, natH = wrapper.scrollHeight;
          // fitZoom: 表格缩放后刚好不超出 clipBox 边界（可能 <1 需缩小，也可能 >1 表格本就小于视口）
          var fitZoom = Math.min(_availW / Math.max(1, natW), _availH / Math.max(1, natH));
          // _initZoom: 重置按钮用 — 取 fitZoom 和 1.0 中较小者（至多原样，不放大）
          _initZoom = Math.min(1, fitZoom);
          // 初始缩放：放大两级（1.25²=1.5625），但绝不超出边界 fitZoom
          zoomScale = Math.min(5.0, _initZoom * 1.5625, fitZoom);
          applyZoom();

          overlay.style.visibility = '';

          clipBox.addEventListener('wheel', function (we) {
            we.preventDefault(); we.stopPropagation();
            if (we.deltaY < 0) { zoomScale = Math.min(5.0, zoomScale * 1.15); }
            else { zoomScale = Math.max(0.25, zoomScale * 0.87); }
            applyZoom();
          }, { passive: false });

          dpad.style.display = 'block';
        } catch (_) {
          // 出错时强制复位，避免 overlay 残留 invisible 阻挡 UI
          overlay.style.display = 'none';
          overlay.style.visibility = '';
          contentEl.innerHTML = '';
          dpad.style.display = 'none';
        }
      }
    });

    // Theme sync
    if (window.qqqideTheme && window.qqqideTheme.onChange) {
      window.qqqideTheme.onChange(function (dark) {
        var wrapper = contentEl.querySelector('div > div') || contentEl.querySelector('div');
        if (wrapper) {
          wrapper.style.background = dark ? '#2a2a2a' : '#eee8d5';
          wrapper.style.color = dark ? '#dcd8d0' : '#656360';
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
      window.qqqideSash.bindV(aSash,
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
      window.qqqideSash.bindH(oSash,
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
            // Binary guard: prevent freeze on mp3/mp4/exe etc.
            if (window.qqqEditor && window.qqqEditor.isBinaryFile && window.qqqEditor.isBinaryFile(filePath)) {
              if (window.qqqideQoast) window.qqqideQoast.show('\u274C \u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u5728\u7F16\u8F91\u5668\u4E2D\u6253\u5F00', { duration: 4000 });
              return;
            }
            // Read and display file
            bridge.fs.read(filePath).then(content => {
              var _paneOpts = window._nextPaneOpts || {}; window._nextPaneOpts = null;
              window.qqqEditor.openInPane(editorMount, filePath, content, _paneOpts);
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
        var _search = window._nextSearch; window._nextSearch = null;
        // Binary guard: prevent freeze on mp3/mp4/exe etc.
        if (window.qqqEditor && window.qqqEditor.isBinaryFile && window.qqqEditor.isBinaryFile(filePath)) {
          if (window.qqqideQoast) window.qqqideQoast.show('\u274C \u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u5728\u7F16\u8F91\u5668\u4E2D\u6253\u5F00', { duration: 4000 });
          return;
        }
        bridge.fs.read(filePath).then(content => {
          var _paneOpts = window._nextPaneOpts || {}; window._nextPaneOpts = null;
          window.qqqEditor.openInPane(editorMount, filePath, content, _paneOpts).then(function (ed) {
            if (_search && ed) {
              setTimeout(function () {
                try {
                  var fc = ed.getContribution('editor.contrib.findController');
                  if (fc && fc.start) {
                    // 用 start() 打开搜索框，seedSearchStringFromSelection:'none' 防止从光标抓词
                    fc.start({
                      forceRevealReplace: false,
                      seedSearchStringFromSelection: 'none',
                      seedSearchStringFromNonEmptySelection: false,
                      seedSearchStringFromGlobalClipboard: false,
                      shouldFocus: 2,
                      shouldAnimate: true,
                      updateSearchScope: false,
                      loop: true
                    });
                    // 设置搜索词
                    fc.getState().change({ searchString: _search }, false);
                    // 延迟二次确认
                    setTimeout(function () {
                      fc.getState().change({ searchString: _search }, false);
                    }, 120);
                  } else {
                    // fallback：直接用 action + DOM 写入
                    ed.getAction('actions.find').run();
                    var domNode = ed.getDomNode();
                    if (domNode) {
                      var _att = 0;
                      var _try = function () {
                        var fi = domNode.querySelector('.find-widget input[type="text"]') || domNode.querySelector('.find-widget .monaco-inputbox input');
                        if (fi) {
                          var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                          ns.call(fi, _search);
                          fi.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        if (++_att < 8) setTimeout(_try, 60);
                      };
                      setTimeout(_try, 60);
                    }
                  }
                } catch (_) { }
              }, 250);
            }
          });
        }).catch(err => {
          pane.textContent = 'Error: ' + (err && err.message);
        });
      }
    });

    // ---- Keyboard: Ctrl+\ split �?now handled by unified key-hook (see bootKeyHook) ----
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

      // Handle qqq-file-open-right from iframes — opens file in right editor group
      if (e.data.type === 'qqq-file-open-right' && e.data.path && window.qqqTabs && window.qqqTabs.openFileInRightGroup) {
        if (e.data.readOnly) { window._nextPaneOpts = { readOnly: true }; }
        if (e.data.search) { window._nextSearch = e.data.search; }
        window.qqqTabs.openFileInRightGroup(e.data.path);
        return;
      }

      // Handle qqq-editor-refresh from iframes — live-update already-open editor content (chat.txt, etc.)
      if (e.data.type === 'qqq-editor-refresh' && e.data.path && window.qqqEditor && window.qqqEditor.refreshLiveContent) {
        window.qqqEditor.refreshLiveContent(e.data.path, e.data.content);
        return;
      }

      // Handle qqq-command from iframes (q4-sidebar, etc.)
      if (e.data.type === 'qqq-command' && e.data.cmd) {
        document.dispatchEvent(new CustomEvent('qqq-command', { detail: { cmd: e.data.cmd, url: e.data.url } }));
        return;
      }

      // ★ Handle qqq-floor-indicator from AI panels — 将豆腐块渲染到父窗口（跨面板定位）
      if (e.data.type === 'qqq-floor-indicator') {
        if (e.data.action === 'hide') {
          var _fi = document.getElementById('qqq-floor-indicator-host');
          if (_fi) { _fi.classList.remove('visible'); _fi.style.opacity = ''; }
          var _kh = document.getElementById('qqq-scroll-keys-host');
          if (_kh) _kh.style.opacity = '0';
          return;
        }
        if (e.data.action === 'show' && e.data.html) {
          var _fi2 = document.getElementById('qqq-floor-indicator-host');
          if (!_fi2) {
            // 注入豆腐块样式（一次性）
            var _fis = document.getElementById('qqq-floor-indicator-style');
            if (!_fis) {
              _fis = document.createElement('style');
              _fis.id = 'qqq-floor-indicator-style';
              _fis.textContent = ''
                + '#qqq-floor-indicator-host{transition:opacity 0.2s ease;opacity:0}'
                + '#qqq-floor-indicator-host.visible{transition:opacity 0s;opacity:1}'
                + '.floor-ind-tofu{background:#f2e8c0;border:1px solid rgba(0,0,0,0.15);border-radius:7px 0 0 7px;padding:9px 21px;font-family:Tahoma,sans-serif;font-weight:normal;font-size:19px;color:#111;white-space:nowrap;box-shadow:0 0 12px rgba(0,0,0,0.18),0 3px 18px rgba(0,0,0,0.22);line-height:1.5;user-select:none}'
                + '[data-theme="dark"] .floor-ind-tofu{background:#3a3630;border-color:rgba(255,255,255,0.12);color:#eee}'
                + '[data-theme="dark"] .floor-ind-tofu{box-shadow:0 0 12px rgba(255,255,255,0.16),0 3px 18px rgba(255,255,255,0.18)}'
                + '.floor-ind-needle{position:relative;width:45px;height:6px;flex-shrink:0;margin-left:-1px;filter:drop-shadow(0 0 6px rgba(0,0,0,0.3))}'
                + '.floor-ind-needle::before{content:"" !important;position:absolute;left:0;top:0;width:100%;height:100%;background:#7a7874;clip-path:polygon(0 0,100% 50%,0 100%);opacity:0.35}'
                + '[data-theme="dark"] .floor-ind-needle{filter:drop-shadow(0 0 6px rgba(255,255,255,0.25))}'
                + '[data-theme="dark"] .floor-ind-needle::before{background:#c8c4b8}'
                + '#qqq-floor-indicator-host.fl-ind-left{flex-direction:row-reverse}'
                + '#qqq-floor-indicator-host.fl-ind-left .floor-ind-tofu{border-radius:0 7px 7px 0}'
                + '#qqq-floor-indicator-host.fl-ind-left .floor-ind-needle{margin-left:0;margin-right:-1px}'
                + '#qqq-floor-indicator-host.fl-ind-left .floor-ind-needle::before{clip-path:polygon(100% 0,0 50%,100% 100%)}'
              ;
              document.head.appendChild(_fis);
            }
            _fi2 = document.createElement('div');
            _fi2.id = 'qqq-floor-indicator-host';
            _fi2.innerHTML = '<span class="floor-ind-tofu"></span><span class="floor-ind-needle"></span>';
            _fi2.style.cssText = 'position:fixed;top:50%;z-index:99999;pointer-events:none;display:flex;align-items:center;transform:translateY(-50%)';
            document.body.appendChild(_fi2);
          }
          // ★ 根据发送面板的 iframe 位置来定位豆腐块（贴在面板的 sash 侧边缘）
          var _pid2 = typeof e.data.panel === 'number' ? e.data.panel : 1;
          var _iframeRect = null;
          try {
            if (e.source && e.source.frameElement) {
              _iframeRect = e.source.frameElement.getBoundingClientRect();
            }
          } catch (_) { }
          if (_iframeRect) {
            // ★ 探针尖端固定定位（不受豆腐块宽度变化影响）
            _fi2.style.top = (_iframeRect.top + _iframeRect.height / 2) + 'px';
            if (_pid2 === 0) {
              _fi2.style.left = (_iframeRect.right - 43) + 'px';
              _fi2.style.right = 'auto';
              _fi2.classList.add('fl-ind-left');
            } else {
              _fi2.style.left = 'auto';
              _fi2.style.right = (window.innerWidth - _iframeRect.left - 43) + 'px';
              _fi2.classList.remove('fl-ind-left');
            }
            // ★ 同步创建/更新 1/2/q/w 按键标记（与豆腐块同 X 位置）
            var _keysHost = document.getElementById('qqq-scroll-keys-host');
            if (!_keysHost) {
              _keysHost = document.createElement('div');
              _keysHost.id = 'qqq-scroll-keys-host';
              _keysHost.style.cssText = 'position:fixed;z-index:99998;pointer-events:none;opacity:0;transition:opacity 0.2s ease';
              _keysHost.innerHTML = '<div class="skey" style="position:absolute;top:12%;left:0;right:0;margin:0 auto">1</div><div class="skey" style="position:absolute;top:38%;left:0;right:0;margin:0 auto">q</div><div class="skey" style="position:absolute;top:58%;left:0;right:0;margin:0 auto">w</div><div class="skey" style="position:absolute;bottom:12%;left:0;right:0;margin:0 auto">2</div>';
              document.body.appendChild(_keysHost);
              // 注入按键样式（一次性）
              var _ks = document.getElementById('qqq-scroll-keys-style');
              if (!_ks) {
                _ks = document.createElement('style');
                _ks.id = 'qqq-scroll-keys-style';
                _ks.textContent = '@font-face{font-family:Unifont;src:url(http://127.0.0.1:8090/qqq-app/fonts/unifont-17.0.04.otf) format("opentype")}.skey{width:42px;height:42px;font-family:Unifont,monospace;font-size:24px;font-weight:700;text-align:center;line-height:42px;border-radius:9px;border:1px solid #b0aca8;background:linear-gradient(180deg,#faf8f5 0%,#e0dcd5 100%);color:#4a4642;box-shadow:0 1px 0 #c5bfb6,0 2px 4px rgba(0,0,0,0.18);user-select:none}[data-theme="dark"] .skey{border-color:#5a5652;background:linear-gradient(180deg,#5a5650 0%,#3a3632 100%);color:#dcd8d0;box-shadow:0 1px 0 #6a6660,0 2px 4px rgba(0,0,0,0.35)}';
                document.head.appendChild(_ks);
              }
            }
            _keysHost.style.top = _iframeRect.top + 'px';
            _keysHost.style.height = _iframeRect.height + 'px';
            _keysHost.style.opacity = '1';
            if (_pid2 === 0) {
              _keysHost.style.left = 'auto';
              _keysHost.style.right = (window.innerWidth - _iframeRect.right + 2) + 'px';
            } else {
              _keysHost.style.left = (_iframeRect.left - 42) + 'px';
              _keysHost.style.right = 'auto';
            }
          } else {
            // 降级：固定定位在视口边缘
            if (_pid2 === 0) {
              _fi2.style.left = '4px'; _fi2.style.right = 'auto';
              _fi2.classList.add('fl-ind-left');
            } else {
              _fi2.style.left = 'auto'; _fi2.style.right = '4px';
              _fi2.classList.remove('fl-ind-left');
            }
          }
          _fi2.querySelector('.floor-ind-tofu').innerHTML = e.data.html;
          // ★ 渐入：inline opacity=1 立即显示；渐出：CSS transition 0.1s 接管
          _fi2.classList.add('visible');
          _fi2.style.opacity = '1';
          return;
        }
      }

      // Handle generic RPC: iframe calls bridge methods
      // params 默认整体当成单一参数（数组也是单一参数，修�?diskFree 当前 bug�?      // 显式 spread: �?{ __spread: true, args: [...] } 才解包）
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
    // [silent] boot info: {
    //   platform: boot.platform, ... });
  }

  // ---- KeyHookService bootstrap ----
  // - Loads core/key-bindings.json
  // - Initializes window.qqqideKeyHook with the binding list
  // - Routes any unhandled binding (no explicit on() handler) into handleMenuCmd
  async function bootKeyHook() {
    if (!window.qqqideKeyHook) {
      console.warn('[keyhook] window.qqqideKeyHook missing — script not loaded?');
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
      window.qqqideKeyHook.init(bindings);
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
    // [silent] keyhook ready
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

    // 灯泡开关（左右 AI 面板 + 窗口弹性伸缩）
    bootBulbs();

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

    // [silent] qqqide ready
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
