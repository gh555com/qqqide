// ============================================================================
// ai-panel/ai-panel.js
// Iframe-based AI panel host. URL is configurable via:
//   window.QQQ_AI_URL   (set before this script runs)
//   ./ai-panel/index.html  (default, served from same server-app)
// Provides .build(mount), .setUrl(url), .reload().
// ============================================================================

(function () {
  'use strict';

  let mount = null;
  let frame = null;
  let bar = null;
  let urlInput = null;
  let currentUrl = '';

  function defaultUrl() {
    if (window.QQQ_AI_URL) { return window.QQQ_AI_URL; }
    // try ./ai-panel/index.html relative to current page
    return new URL('ai-panel/index.html', location.href).toString();
  }

  function setUrl(u) {
    currentUrl = u || '';
    if (frame) { frame.src = currentUrl; }
    if (urlInput) { urlInput.value = currentUrl; }
  }

  function reload() {
    if (frame && currentUrl) {
      frame.src = 'about:blank';
      setTimeout(() => { frame.src = currentUrl; }, 30);
    }
  }

  function build(host) {
    mount = host;
    mount.innerHTML = '';
    mount.style.cssText = 'height:100%; display:flex; flex-direction:column;';

    // Dev URL bar — hidden by default. Toggle with Ctrl+Alt+U or ?ai-dev=1.
    // Most users only need the Token input which lives INSIDE the iframe.
    const showDevBar = location.search.indexOf('ai-dev=1') !== -1
      || localStorage.getItem('qqq-ai-dev-bar') === '1';

    bar = document.createElement('div');
    bar.style.cssText =
      'flex:0 0 ' + (showDevBar ? '28px' : '0') + '; ' +
      'display:' + (showDevBar ? 'flex' : 'none') + '; align-items:center; gap:4px; padding:0 6px; ' +
      'border-bottom:1px solid var(--border-color); background:var(--background-color); font-size:11px;';
    const title = document.createElement('span');
    title.textContent = 'AI'; title.style.cssText = 'color:var(--text-primary); font-weight:600;';
    urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.style.cssText =
      'flex:1 1 auto; padding:2px 4px; background:var(--background-color); color:var(--text-primary);' +
      'border:1px solid var(--border-color); border-radius:2px; font-size:11px;';
    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { setUrl(urlInput.value); }
    });
    const btnGo = document.createElement('button');
    btnGo.textContent = 'Go'; btnGo.style.cssText = 'padding:2px 8px; cursor:pointer;';
    btnGo.addEventListener('click', () => setUrl(urlInput.value));
    const btnReload = document.createElement('button');
    btnReload.textContent = '↻'; btnReload.style.cssText = 'padding:2px 8px; cursor:pointer;';
    btnReload.addEventListener('click', reload);
    bar.appendChild(title); bar.appendChild(urlInput); bar.appendChild(btnGo); bar.appendChild(btnReload);

    // Ctrl+Alt+U to toggle the dev bar at runtime
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        const visible = bar.style.display !== 'none';
        bar.style.display = visible ? 'none' : 'flex';
        bar.style.flex = '0 0 ' + (visible ? '0' : '28px');
        localStorage.setItem('qqq-ai-dev-bar', visible ? '0' : '1');
      }
    });

    frame = document.createElement('iframe');
    frame.style.cssText = 'flex:1 1 auto; width:100%; border:0; background:#fff;';
    // sandbox: keep iframe contained but allow scripts/forms (typical AI chat)
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    frame.addEventListener('error', () => {
      console.warn('[ai-panel] iframe error for', currentUrl);
    });

    mount.appendChild(bar);
    mount.appendChild(frame);

    // ── Pie tooltip: rendered in parent body to break out of iframe/IDE clipping ──
    let _pieTT = null;
    function _ensurePieTT() {
      if (_pieTT) return _pieTT;
      _pieTT = document.createElement('div');
      _pieTT.id = 'qqq-pie-tooltip';
      _pieTT.style.cssText =
        'display:none; position:fixed; z-index:999999; pointer-events:none; ' +
        'padding:8px 16px; background:rgba(0,0,0,0.85); color:#fff; font-size:22px; ' +
        'font-family:ui-monospace,monospace; border-radius:8px; white-space:nowrap; ' +
        'flex-direction:row; align-items:center;';
      document.body.appendChild(_pieTT);
      return _pieTT;
    }
    window.addEventListener('message', function (e) {
      if (!e.data || e.data.type !== 'qqq-pie-tooltip') return;
      if (!frame || e.source !== frame.contentWindow) return;
      if (e.data.action === 'hide') {
        var tt = _pieTT;
        if (tt) tt.style.display = 'none';
        return;
      }
      if (e.data.action === 'show') {
        var tt2 = _ensurePieTT();
        tt2.innerHTML = e.data.html || '';
        tt2.style.display = 'flex';
        var fr = frame.getBoundingClientRect();
        var cx = fr.left + (e.data.clientX || 0);
        var cy = fr.top + (e.data.clientY || 0) + 60;
        tt2.style.left = cx + 'px';
        tt2.style.top = cy + 'px';
        tt2.style.transform = 'translate(-50%, -50%)';
      }
    });

    // ── 外嵌 AI 面板：灯泡开关 → IPC 通知主进程 ──
    window.addEventListener('message', function (e) {
      if (!e.data || e.data.type !== 'qqq-external-panel') return;
      if (!frame || e.source !== frame.contentWindow) return;
      if (window.qqqideBridge && window.qqqideBridge.aiPanel) {
        window.qqqideBridge.aiPanel.toggleExternal(e.data.index, e.data.action === 'open');
      }
    });

    setUrl(defaultUrl());
  }

  window.qqqidePanel = { build: build, setUrl: setUrl, reload: reload };
})();
