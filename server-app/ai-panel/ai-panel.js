// ============================================================================
// ai-panel/ai-panel.js
// Multi-iframe AI panel host. Builds independent iframes for left/center/right.
// Each iframe loads ai-panel/index.html?panel=N (0=left, 1=center, 2=right).
// Provides .build(host, panelId) → one iframe per call.
// ============================================================================

(function () {
  'use strict';

  var _panels = [];        // [{ id, frame, bar, urlInput, currentUrl }]
  var _devBarVisible = location.search.indexOf('ai-dev=1') !== -1
    || localStorage.getItem('qqq-ai-dev-bar') === '1';

  function defaultUrl(panelId) {
    if (window.QQQ_AI_URL) { return window.QQQ_AI_URL + '?panel=' + panelId; }
    return new URL('ai-panel/index.html?panel=' + panelId, location.href).toString();
  }

  function _createDevBar(panel) {
    var bar = document.createElement('div');
    bar.style.cssText =
      'flex:0 0 ' + (_devBarVisible ? '28px' : '0') + '; ' +
      'display:' + (_devBarVisible ? 'flex' : 'none') + '; align-items:center; gap:4px; padding:0 6px; ' +
      'border-bottom:1px solid var(--border-color); background:var(--background-color); font-size:11px;';
    var title = document.createElement('span');
    title.textContent = ['左AI','中AI','右AI'][panel.id] || 'AI';
    title.style.cssText = 'color:var(--text-primary); font-weight:600;';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.style.cssText =
      'flex:1 1 auto; padding:2px 4px; background:var(--background-color); color:var(--text-primary);' +
      'border:1px solid var(--border-color); border-radius:2px; font-size:11px;';
    inp.value = panel.currentUrl || '';
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { _setPanelUrl(panel, inp.value); }
    });
    var btnGo = document.createElement('button');
    btnGo.textContent = 'Go'; btnGo.style.cssText = 'padding:2px 8px;';
    btnGo.addEventListener('click', function() { _setPanelUrl(panel, inp.value); });
    var btnReload = document.createElement('button');
    btnReload.textContent = '↻'; btnReload.style.cssText = 'padding:2px 8px;';
    btnReload.addEventListener('click', function() { _reloadPanel(panel); });
    bar.appendChild(title); bar.appendChild(inp); bar.appendChild(btnGo); bar.appendChild(btnReload);
    panel.bar = bar;
    panel.urlInput = inp;
    return bar;
  }

  function _setPanelUrl(panel, u) {
    panel.currentUrl = u || '';
    if (panel.frame) { panel.frame.src = panel.currentUrl; }
    if (panel.urlInput) { panel.urlInput.value = panel.currentUrl; }
  }

  function _reloadPanel(panel) {
    if (panel.frame && panel.currentUrl) {
      panel.frame.src = 'about:blank';
      setTimeout(function() { panel.frame.src = panel.currentUrl; }, 30);
    }
  }

  function build(host, panelId) {
    if (typeof panelId !== 'number') panelId = 1; // default center

    var panel = { id: panelId, frame: null, bar: null, urlInput: null, currentUrl: '' };
    _panels.push(panel);

    host.innerHTML = '';
    // ★ 保留已有的 left/right/width（wing 面板的定位和宽度），不覆盖
    var _saveLeft = host.style.left;
    var _saveRight = host.style.right;
    var _saveWidth = host.style.width;
    host.style.cssText = 'height:100%; display:flex; flex-direction:column;';
    if (_saveLeft) host.style.left = _saveLeft;
    if (_saveRight) host.style.right = _saveRight;
    if (_saveWidth) host.style.width = _saveWidth;

    panel.currentUrl = defaultUrl(panelId);
    var bar = _createDevBar(panel);
    var frame = document.createElement('iframe');
    frame.style.cssText = 'flex:1 1 auto; width:100%; border:0; background:var(--background-color);';
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    frame.addEventListener('error', function() {
      console.warn('[ai-panel:' + panelId + '] iframe error');
    });
    panel.frame = frame;

    host.appendChild(bar);
    host.appendChild(frame);
    frame.src = panel.currentUrl;
  }

  // ── Dev bar toggle (Ctrl+Alt+U) ──
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.altKey && (e.key === 'u' || e.key === 'U')) {
      e.preventDefault();
      _devBarVisible = !_devBarVisible;
      localStorage.setItem('qqq-ai-dev-bar', _devBarVisible ? '1' : '0');
      for (var i = 0; i < _panels.length; i++) {
        var b = _panels[i].bar;
        if (b) {
          b.style.display = _devBarVisible ? 'flex' : 'none';
          b.style.flex = '0 0 ' + (_devBarVisible ? '28px' : '0');
        }
      }
    }
  });

  // ── Pie tooltip (shared across panels) ──
  var _pieTT = null;
  function _ensurePieTT() {
    if (_pieTT) return _pieTT;
    _pieTT = document.createElement('div');
    _pieTT.id = 'qqq-pie-tooltip';
    _pieTT.style.cssText =
      'display:none; position:fixed; z-index:999999; pointer-events:none; ' +
      'padding:8px 16px; background:rgba(0,0,0,0.85); color:#fff; font-size:22px; ' +
      'font-family:ui-monospace,monospace; border-radius:8px; white-space:nowrap;';
    document.body.appendChild(_pieTT);
    return _pieTT;
  }
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'qqq-pie-tooltip') return;
    if (e.data.action === 'hide') { if (_pieTT) _pieTT.style.display = 'none'; return; }
    if (e.data.action === 'show') {
      var tt = _ensurePieTT();
      tt.innerHTML = e.data.html || '';
      tt.style.display = 'flex';
      var srcFrame = null;
      for (var i = 0; i < _panels.length; i++) {
        if (_panels[i].frame && e.source === _panels[i].frame.contentWindow) {
          srcFrame = _panels[i].frame; break;
        }
      }
      if (srcFrame) {
        var fr = srcFrame.getBoundingClientRect();
        tt.style.left = (fr.left + (e.data.clientX || 0)) + 'px';
        tt.style.top = (fr.top + (e.data.clientY || 0) + 60) + 'px';
        tt.style.transform = 'translate(-50%, -50%)';
      }
    }
  });

  window.qqqidePanel = { build: build };
})();
