// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-rpc.js — RPC 转发器 + 文件浏览器到 Tab 挂钩 + KeyHook 启动（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window.qqqTabs, window.qqqEditor, window.qqqideKeyHook
//        window._shHandleMenuCmd (shell-menu.js)
// ============================================================================

// ── Roam SFX 统一音频机器入口 ──
// 语义映射表（老版 q3 yz 音效）: enter→a2.mp3 · delete→4.mp3 · purge→rou1.mp3
// pin→a1.mp3 · unpin→kj2.mp3 · terminal→zs861.mp3 · copy/error→轻音效
// 300ms 去重窗口（照搬老版 global.js，防多窗口操作音效叠炸）
var _roamSfxLast = {};
var _ROAM_SFX_MAP = {
  'enter': 'a2.mp3',
  'delete': '4.mp3',
  'purge': 'rou1.mp3',
  'pin': 'a1.mp3',
  'unpin': 'kj2.mp3',
  'terminal': 'zs861.mp3',
  'copy': 'a2.mp3',
  'error': 'a2.mp3'
};
function _playRoamSfx(name) {
  if (!name || !window.qqqideBridge || !window.qqqideBridge.audio) return;
  var now = Date.now();
  var key = 'sfx_' + name;
  var last = _roamSfxLast[key] || 0;
  if (now - last < 300) return; // 去重窗口
  _roamSfxLast[key] = now;
  var file = _ROAM_SFX_MAP[name] || 'a2.mp3';
  try {
    window.qqqideBridge.audio.play('yz:' + file).catch(function () { });
  } catch (_) { }
}

// ---- Editor integration: open file from file explorer ----
function hookFileExplorerToTabs() {
  var bridge = window.qqqideBridge;
  // Listen for file-open events from file explorer
  // The file explorer dispatches 'qqq-file-open' custom event
  document.addEventListener('qqq-file-open', function (e) {
    var filePath = e.detail && e.detail.path;
    if (!filePath) return;

    // Open in tab manager
    var tab = window.qqqTabs.openFile(filePath, {
      preview: e.detail.preview,
      onRender: function (pane, tabObj) {
        // Use Monaco editor to render file
        if (window.qqqEditor) {
          pane.style.cssText = 'position:relative; width:100%; height:100%;';
          // ★ 立现占位：显示文件名，避免空白闪烁
          var _fileName = filePath.split(/[\\/]/).pop() || filePath;
          var _placeholder = document.createElement('div');
          _placeholder.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--tx3);font:13px Tahoma,sans-serif;user-select:none;';
          _placeholder.textContent = _fileName;
          pane.appendChild(_placeholder);

          // Binary guard: async check (sync ext check + stat for extensionless files)
          var _checkBin = Promise.resolve(false);
          if (window.qqqEditor && window.qqqEditor.isBinaryFileAsync) {
            _checkBin = window.qqqEditor.isBinaryFileAsync(filePath);
          } else if (window.qqqEditor && window.qqqEditor.isBinaryFile) {
            _checkBin = Promise.resolve(window.qqqEditor.isBinaryFile(filePath));
          }

          _checkBin.then(function (isBin) {
            if (isBin) {
              pane.textContent = '';
              var _msg = document.createElement('div');
              _msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--tx3);font:13px Tahoma,sans-serif;user-select:none;';
              _msg.textContent = '\u274C ' + _fileName + ' \u2014 \u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u5728\u7F16\u8F91\u5668\u4E2D\u6253\u5F00';
              pane.appendChild(_msg);
              return;
            }
            // Read and display file
            bridge.fs.read(filePath).then(function (content) {
              // ★ rAF 让浏览器先渲一帧（占位符可见），再切 Monaco（避免 UI 冻住）
              requestAnimationFrame(function () {
                pane.textContent = '';
                var editorMount = document.createElement('div');
                editorMount.style.cssText = 'position:absolute; inset:0 0 4px 0;';
                pane.appendChild(editorMount);
                var _paneOpts = window._nextPaneOpts || {}; window._nextPaneOpts = null;
                window.qqqEditor.openInPane(editorMount, filePath, content, _paneOpts);
              });
            }).catch(function (err) {
              pane.textContent = 'Error: ' + (err && err.message);
            });
          });
        }
      }
    });
  });

  // Listen for qqq-file-open-in-pane (from tab-manager right-click -> open in right group)
  document.addEventListener('qqq-file-open-in-pane', function (e) {
    var filePath = e.detail && e.detail.path;
    var pane = e.detail && e.detail.pane;
    if (!filePath || !pane) return;
    if (window.qqqEditor) {
      pane.style.cssText = 'position:relative; width:100%; height:100%;';
      var editorMount = document.createElement('div');
      editorMount.style.cssText = 'position:absolute; inset:0 0 4px 0;';
      pane.appendChild(editorMount);
      var _search = window._nextSearch; window._nextSearch = null;
      var _realSearch = (_search === '__FIND__') ? '' : _search;

      // Binary guard: async check (sync ext check + stat for extensionless files)
      var _checkBin2 = Promise.resolve(false);
      if (window.qqqEditor && window.qqqEditor.isBinaryFileAsync) {
        _checkBin2 = window.qqqEditor.isBinaryFileAsync(filePath);
      } else if (window.qqqEditor && window.qqqEditor.isBinaryFile) {
        _checkBin2 = Promise.resolve(window.qqqEditor.isBinaryFile(filePath));
      }

      _checkBin2.then(function (isBin) {
        if (isBin) {
          if (window.qqqideQoast) window.qqqideQoast.show('\u274C \u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u5728\u7F16\u8F91\u5668\u4E2D\u6253\u5F00', { duration: 4000 });
          return;
        }
        bridge.fs.read(filePath).then(function (content) {
          var _paneOpts = window._nextPaneOpts || {}; window._nextPaneOpts = null;
          window.qqqEditor.openInPane(editorMount, filePath, content, _paneOpts).then(function (ed) {
            if (_search && ed) {
              setTimeout(function () {
                try {
                  var fc = ed.getContribution('editor.contrib.findController');
                  if (fc && fc.start) {
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
                    if (_realSearch) {
                      fc.getState().change({ searchString: _realSearch }, false);
                      setTimeout(function () {
                        fc.getState().change({ searchString: _realSearch }, false);
                      }, 120);
                    }
                  } else {
                    ed.getAction('actions.find').run();
                    if (_realSearch) {
                      var domNode = ed.getDomNode();
                      if (domNode) {
                        var _att = 0;
                        var _try = function () {
                          var fi = domNode.querySelector('.find-widget input[type="text"]') || domNode.querySelector('.find-widget .monaco-inputbox input');
                          if (fi) {
                            var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                            ns.call(fi, _realSearch);
                            fi.dispatchEvent(new Event('input', { bubbles: true }));
                          }
                          if (++_att < 8) setTimeout(_try, 60);
                        };
                        setTimeout(_try, 60);
                      }
                    }
                  }
                } catch (_) { }
              }, 250);
            }
          });
        }).catch(function (err) {
          pane.textContent = 'Error: ' + (err && err.message);
        });
      });
    }
  });

  // ---- Keyboard: Ctrl+\ split — now handled by unified key-hook (see bootKeyHook) ----
  // (hard-coded keydown removed; binding lives in core/key-bindings.json under id 'editor.splitRight')
}

// ---- Unified postMessage RPC forwarder for all qood iframes ----
function bootRpcForwarder() {
  var bridge = window.qqqideBridge;
  window.addEventListener('message', async function (e) {
    if (!e.data) return;

    // Handle qqq-file-open from iframes (q2-roam, etc.)
    if (e.data.type === 'qqq-file-open' && e.data.path) {
      document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: e.data.path } }));
      return;
    }

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

    // ★ Handle qqq-sfx from Roam iframe — 统一音频机器入口（300ms 去重）
    if (e.data.type === 'qqq-sfx' && e.data.name) {
      _playRoamSfx(String(e.data.name));
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
              _ks.textContent = '.skey{width:42px;height:42px;font-family:monospace;font-size:24px;font-weight:700;text-align:center;line-height:42px;border-radius:9px;border:1px solid #b0aca8;background:linear-gradient(180deg,#faf8f5 0%,#e0dcd5 100%);color:#4a4642;box-shadow:0 1px 0 #c5bfb6,0 2px 4px rgba(0,0,0,0.18);user-select:none}[data-theme="dark"] .skey{border-color:#5a5652;background:linear-gradient(180deg,#5a5650 0%,#3a3632 100%);color:#dcd8d0;box-shadow:0 1px 0 #6a6660,0 2px 4px rgba(0,0,0,0.35)}';
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

    // ★ Handle store.* RPC: persistence bridge (global.sq3 + only.sq3)
    if (e.data.type === 'qqq-rpc' && e.data.method && (e.data.method === 'store.get' || e.data.method === 'store.set' || e.data.method === 'store.getLocal' || e.data.method === 'store.setLocal')) {
      var method = e.data.method, params = e.data.params, id = e.data.id;
      try {
        var _roamDb = window.qgs.simple('roam');
        var result;
        if (method === 'store.get') {
          result = await _roamDb.get(params);
        } else if (method === 'store.set') {
          var _setArg = params; // { key, value }
          await _roamDb.set(_setArg.key, _setArg.value);
          result = true;
        } else if (method === 'store.getLocal') {
          var _root = window._workspaceRoot;
          if (!_root) throw new Error('_workspaceRoot not ready');
          var _onlyDb = window.qgs.project(_root + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
          result = await _onlyDb.get(params);
        } else if (method === 'store.setLocal') {
          var _root2 = window._workspaceRoot;
          if (!_root2) throw new Error('_workspaceRoot not ready');
          var _onlyDb2 = window.qgs.project(_root2 + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
          var _setArg2 = params; // { key, value }
          await _onlyDb2.set(_setArg2.key, _setArg2.value);
          result = true;
        }
        if (e.source) e.source.postMessage({ type: 'qqq-rpc-reply', id: id, result: result, error: null }, '*');
      } catch (err) {
        if (e.source) e.source.postMessage({ type: 'qqq-rpc-reply', id: id, result: null, error: { message: String(err) } }, '*');
      }
      return;
    }

    // Handle generic RPC: iframe calls bridge methods
    // params 默认整体当成单一参数（数组也是单一参数，修正 diskFree 当前 bug）
    // 显式 spread: { __spread: true, args: [...] } 才解包）
    if (e.data.type === 'qqq-rpc') {
      var method = e.data.method, params = e.data.params, id = e.data.id;
      try {
        var parts = method.split('.');
        var fn = bridge;
        for (var k = 0; k < parts.length; k++) fn = fn[parts[k]];
        var result;
        if (params && typeof params === 'object' && params.__spread === true && Array.isArray(params.args)) {
          result = await fn.apply(null, params.args);
        } else if (params === undefined) {
          result = await fn.call(null);
        } else {
          result = await fn.call(null, params);
        }
        if (e.source) e.source.postMessage({ type: 'qqq-rpc-reply', id: id, result: result, error: null }, '*');
      } catch (err) {
        if (e.source) e.source.postMessage({ type: 'qqq-rpc-reply', id: id, result: null, error: { message: String(err) } }, '*');
      }
    }
  });

  // ★ Roam 跨窗口同步: 主进程 roam-changed → 转发到所有 iframe
  if (bridge.roam && bridge.roam.onChanged) {
    bridge.roam.onChanged(function(msg) {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          iframes[i].contentWindow.postMessage({ type: 'qqqide-roam-changed', key: msg.key, value: msg.value }, '*');
        } catch (_) { /* iframe 跨域或已销毁 */ }
      }
    });
  }

  // ★ 自动感知外部变化 (q3 autoWatchChanges 移植, 默认开): 主进程 fs.watch → 转发到所有 iframe
  if (bridge.roam && bridge.roam.onFsChanged) {
    bridge.roam.onFsChanged(function() {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          iframes[i].contentWindow.postMessage({ type: 'qqqide-roam-fs-changed' }, '*');
        } catch (_) { /* iframe 跨域或已销毁 */ }
      }
    });
  }
}

// ---- KeyHookService bootstrap ----
// - Loads core/key-bindings.json
// - Initializes window.qqqideKeyHook with the binding list
// - Routes any unhandled binding (no explicit on() handler) into window._shHandleMenuCmd
async function bootKeyHook() {
  if (!window.qqqideKeyHook) {
    console.warn('[keyhook] window.qqqideKeyHook missing — script not loaded?');
    return;
  }
  var bindings = [];
  try {
    var res = await fetch('core/key-bindings.json', { cache: 'no-store' });
    bindings = await res.json();
    // ★ F100 根因修复：key-bindings.json 是 {version, bindings[]} 对象格式，
    //    key-hook init() 内部读 bindings.bindings —— 旧代码把对象清成空数组 → 零绑定注册
    //    → F2/Tab 永远无反应（F75/F99 修的 handler 从未被触发过）。保持对象格式直传。
    if (Array.isArray(bindings)) bindings = { bindings: bindings }; // 兼容纯数组旧格式
    if (!bindings || !Array.isArray(bindings.bindings)) bindings = { bindings: [] };
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
  document.addEventListener('qqq-key-cmd', function (e) {
    var id = e.detail && e.detail.id;
    if (!id) return;
    if (window._shHandleMenuCmd) window._shHandleMenuCmd(id);
  });
  // [silent] keyhook ready
}
