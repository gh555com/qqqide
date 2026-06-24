// ============================================================================
// shell-menu.js — 菜单栏（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window.qqqDefaultMenuSchema, window._i
// 导出: window._shHandleMenuCmd (供 shell-rpc.js 的 bootKeyHook 使用)
// ============================================================================

var _shellActiveMenubarPopup = null;

function _shellCloseMenubarPopup() {
  if (_shellActiveMenubarPopup) { try { _shellActiveMenubarPopup.remove(); } catch (_) { } _shellActiveMenubarPopup = null; }
}

function _shellOpenMenubarPopup(anchorEl, item) {
  _shellCloseMenubarPopup();
  if (!item.sub || item.sub.length === 0) return;
  var rect = anchorEl.getBoundingClientRect();
  var pop = document.createElement('div');
  pop.className = 'qqq-menubar-popup';
  pop.style.cssText =
    'position:fixed; z-index:99999; ' +
    'left:' + rect.left + 'px; top:' + rect.bottom + 'px; ' +
    'min-width:180px; background:var(--card-bg); ' +
    'border:1px solid var(--border-color); border-radius:3px; ' +
    'box-shadow:0 4px 16px rgba(0,0,0,.18); padding:4px 0;';
  for (var i = 0; i < item.sub.length; i++) {
    var s = item.sub[i];
    if (s.type === 'separator') {
      var sep = document.createElement('div');
      sep.style.cssText = 'height:1px; margin:4px 8px; background:var(--border-color);';
      pop.appendChild(sep);
      continue;
    }
    var row = document.createElement('div');
    row.style.cssText =
      'display:flex; align-items:center; padding:5px 14px; ' +
      'font-size:12px; color:var(--text-primary); ' +
      'white-space:nowrap; user-select:none;';
    var lab = document.createElement('span');
    lab.textContent = (s.i18n && window._i) ? window._i(s.i18n, s.label) : (s.label || '');
    lab.style.cssText = 'flex:1 1 auto;';
    row.appendChild(lab);
    if (s.accel) {
      var acc = document.createElement('span');
      acc.textContent = s.accel;
      acc.style.cssText = 'margin-left:24px; color:var(--base1); font-size:11px;';
      row.appendChild(acc);
    }
    row.addEventListener('mouseenter', function () { row.style.background = 'var(--background-color)'; });
    row.addEventListener('mouseleave', function () { row.style.background = ''; });
    row.addEventListener('click', (function (cmd) {
      return function (e) {
        e.stopPropagation();
        _shellCloseMenubarPopup();
        if (cmd) window._shHandleMenuCmd(cmd);
      };
    })(s.cmd));
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  _shellActiveMenubarPopup = pop;
}

// handleMenuCmd — 菜单命令中枢，同时挂到 window 供 shell-rpc.js 的 keyHook 使用
window._shHandleMenuCmd = function handleMenuCmd(cmd) {
  var bridge = window.qqqideBridge;
  if (cmd === 'tools.toggleDevTools') {
    if (bridge.window && bridge.window.toggleDevTools) { bridge.window.toggleDevTools(); }
    return;
  }
  if (cmd === 'help.about') {
    bridge.dialog.message({ type: 'info', title: window._i('shell.about.title', '关于 qqq'), message: window._i('shell.about.version', 'qqq-shell v2'), detail: window._i('shell.about.desc', '便携 / Win7+ / 服务器热更') });
    return;
  }
  if (cmd === 'file.new' || cmd === 'file.open') {
    window.dispatchEvent(new CustomEvent('qqq-menu-cmd', { detail: { cmd: cmd } }));
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
  // ---- Editor font size (was zoom; also reachable via Ctrl+= / Ctrl+- / Ctrl+0) ----
  if (cmd === 'zoom.in') { bridge.zoom && bridge.zoom.adjust(1); return; }
  if (cmd === 'zoom.out') { bridge.zoom && bridge.zoom.adjust(-1); return; }
  if (cmd === 'zoom.reset') { bridge.zoom && bridge.zoom.set(13); return; }
  // ---- Editor split right (Ctrl+\) ----
  if (cmd === 'editor.splitRight') {
    if (!window.qqqTabs) return;
    var groups = window.qqqTabs.getGroups();
    var activeFilePath = null;
    for (var i = groups.length - 1; i >= 0; i--) {
      var g = groups[i];
      if (g.type !== 'file') continue;
      var t = g.tabs.find(function (x) { return x.id === g.activeTabId; });
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
    var it = document.querySelector('iframe[src*="q2-roam"]');
    if (it && it.contentWindow) {
      try { it.contentWindow.focus(); } catch (e) { }
    }
    return;
  }
  // ---- Roam in-iframe commands: forward back into the iframe ----
  if (cmd === 'roam.openInIde' || cmd === 'roam.openMedia' ||
    cmd === 'roam.requestSize' || cmd === 'roam.scrollTop' ||
    cmd === 'roam.scrollBottom') {
    var it2 = document.querySelector('iframe[src*="q2-roam"]');
    if (it2 && it2.contentWindow) {
      try { it2.contentWindow.postMessage({ type: 'qqq-roam-cmd', cmd: cmd }, '*'); } catch (e) { }
    }
    return;
  }
  // [silent] menu unhandled cmd
};

function _shellRenderMenubarLabels(schema) {
  var $bar = document.getElementById('qqq-menubar');
  if (!$bar || !schema) return;
  $bar.innerHTML = '';
  for (var i = 0; i < (schema.items || []).length; i++) {
    var item = schema.items[i];
    var span = document.createElement('span');
    span.className = 'qqq-menubar-label';
    span.textContent = (item.i18n && window._i) ? window._i(item.i18n, item.label) : (item.label || '');
    span.style.cssText =
      'padding:0 10px; color:var(--text-primary); ' +
      'user-select:none; height:100%; display:inline-flex; align-items:center;';
    span.addEventListener('mouseenter', function () { span.style.background = 'rgba(128,128,128,0.10)'; });
    span.addEventListener('mouseleave', function () { span.style.background = ''; });
    span.addEventListener('click', (function (anchorSpan, menuItem) {
      return function (e) {
        e.stopPropagation();
        // toggle: if popup already open for THIS label, close; else open
        if (_shellActiveMenubarPopup && _shellActiveMenubarPopup._anchor === anchorSpan) {
          _shellCloseMenubarPopup();
        } else {
          _shellOpenMenubarPopup(anchorSpan, menuItem);
          if (_shellActiveMenubarPopup) _shellActiveMenubarPopup._anchor = anchorSpan;
        }
      };
    })(span, item));
    $bar.appendChild(span);
  }
  // global click to close
  document.addEventListener('mousedown', function (e) {
    if (!_shellActiveMenubarPopup) return;
    if (_shellActiveMenubarPopup.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.qqq-menubar-label')) return;
    _shellCloseMenubarPopup();
  });
}

async function bootMenu() {
  var bridge = window.qqqideBridge;
  var schema = window.qqqDefaultMenuSchema;
  if (!schema) return;
  try { await bridge.menu.set(schema); } catch (e) { console.warn('[shell] menu.set failed', e); }
  _shellRenderMenubarLabels(schema);
  window.addEventListener('qqq-lang-change', function () { _shellRenderMenubarLabels(schema); });
  bridge.menu.onFired(function (cmd) {
    // [silent] menu fired native
    window._shHandleMenuCmd(cmd);
  });
}
