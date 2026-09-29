// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// editor.js - Monaco editor wrapper for qqq-shell v2
//
// Loads monaco-editor from qqqide-asset://monaco/vs/loader.js (provided by shell).
// 唯一编辑器创建路径 = openInPane(host, filePath, content, opts)（X 区 tab 分组 per-pane 实例）；
// window.qqqEditor 的 pane 查找 / 生命周期 / 脏状态 / 编码簿记 API 见文件尾导出块。
// （主编辑器时代遗留 build/open/save/textarea 回落已整体退役——勿再引入第二编辑器路径。）
// ============================================================================

(function () {
  'use strict';

  const isElectron = !!window.qqqIsElectron;
  const bridge = window.qqqideBridge;

  // ═══ LSP OFF: all external LSP and TS compiler integrations removed ═══
  // Monaco built-in TS/JS/CSS/HTML/JSON workers are disabled in loadMonaco() below.
  // External LSP servers (pyright/gopls/rust-analyzer/clangd) — bridge code removed.

  // ---- q1 v3: 中心视口管线（viewport-machine）----
  // ★ 替代旧 attachQ1v2 重试模式。所有编辑器生命周期事件走 ViewportMachine.transition(),
  //   消除"大脑分裂"（多个代码路径各自调用 attach/dispose → 多面板丢图+not a child 崩溃）。
  //   加载等待: 若 ViewportMachine 尚未注入，最多重试 15 次 (4.5s)。
  function attachQ1v3(ed, monaco, filePath) {
    if (!ed || !monaco) return;
    var attempts = 0;
    var maxAttempts = 15;
    var tick = function () {
      attempts++;
      var ok = false;
      if (window.qqqViewportMachine && window.qqqViewportMachine.transition) {
        try {
          window.qqqViewportMachine.transition('created', ed, filePath);
          ok = true;
        } catch (e) { /* ignore */ }
      }
      // Paste-router: document-level listener, only needs one attach (has _attached guard)
      if (window.qqqPasteRouter && window.qqqPasteRouter.attach) {
        try { window.qqqPasteRouter.attach(ed, monaco); } catch (e) { /* ignore */ }
      }
      if (ok) return;
      if (attempts >= maxAttempts) return;
      setTimeout(tick, 300);
    };
    tick();
  }

  // Map file extension -> monaco language id
  const LANG_BY_EXT = {
    '.js': 'javascript', '.mjs': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
    '.json': 'json', '.md': 'markdown', '.markdown': 'markdown',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.cpp': 'cpp', '.c': 'c', '.h': 'cpp',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.xml': 'xml', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'plaintext', '.ini': 'ini',
    '.sh': 'shell', '.bash': 'shell', '.bat': 'bat', '.ps1': 'powershell',
    '.sql': 'sql', '.lua': 'lua', '.r': 'r', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.dart': 'dart', '.vue': 'html',
  };
  function langOf(file) {
    if (!file) return 'plaintext';
    const lower = String(file).toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return 'plaintext';
    return LANG_BY_EXT[lower.slice(dot)] || 'plaintext';
  }


  // 二进制文件扩展名（打开会卡死，直接拦截）
  var BINARY_EXTS = new Set([
    '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm',
    '.wav', '.ogg', '.flac', '.aac', '.wma', '.m4a',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.psd',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
    '.ttf', '.otf', '.woff', '.woff2',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.iso', '.dmg', '.pdb', '.class', '.pyc', '.wasm',
  ]);

  // 无扩展名文件 > 此阈值则视为二进制（防 98MB r.next 等启动器文件卡死编辑器）
  var NOEXT_BINARY_SIZE = 10 * 1024 * 1024; // 10MB

  function isBinaryFile(filePath) {
    if (!filePath) return false;
    var lower = String(filePath).toLowerCase();
    var dot = lower.lastIndexOf(String.fromCharCode(46));
    if (dot < 0) return false;
    return BINARY_EXTS.has(lower.slice(dot));
  }

  // ★ 异步版：无扩展名文件通过 stat 大小判断是否为二进制
  async function isBinaryFileAsync(filePath) {
    if (!filePath) return false;
    // 先用扩展名快速判断
    var lower = String(filePath).toLowerCase();
    var dot = lower.lastIndexOf(String.fromCharCode(46));
    if (dot >= 0) return BINARY_EXTS.has(lower.slice(dot));
    // 无扩展名 → stat 看大小
    try {
      if (bridge && bridge.fs && bridge.fs.stat) {
        var st = await bridge.fs.stat(filePath);
        if (st && typeof st.size === 'number' && st.size > NOEXT_BINARY_SIZE) {
          return true;
        }
      }
    } catch (_) { /* stat 失败放行 */ }
    return false;
  }

  // ★ 大文件阈值：超过此大小先 plaintext 打开，延迟上色（#1 + #2）
  var PLAINTEXT_SIZE_THRESHOLD = 200 * 1024; // 200KB
  function _shouldDeferColoring(contentStr, lang) {
    if (lang === 'plaintext') return false;
    return contentStr && contentStr.length > PLAINTEXT_SIZE_THRESHOLD;
  }

  // ── 行号右侧空气墙点击 → 光标跳到第一列 (方案1: Monaco onMouseDown + MouseTargetType) ──
  function _installGutterClickFix(ed, monaco) {
    if (!ed || !monaco) return;
    ed.onMouseDown(function (e) {
      if (!e.target || !e.target.position) return;
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
        e.event.preventDefault();
        ed.setPosition({ lineNumber: e.target.position.lineNumber, column: 1 });
        ed.focus();
      }
    });
  }




  // ---------------- Monaco loader ----------------
  var _monacoLoadPromise = null;
  function loadMonaco() {
    if (_monacoLoadPromise) return _monacoLoadPromise;
    _monacoLoadPromise = new Promise((resolve, reject) => {
      if (window.monaco) { _monacoLoadPromise = null; return resolve(window.monaco); }

      // Configure AMD loader paths
      const baseUrl = isElectron ? 'qqqide-asset://monaco/vs' : null;
      if (!baseUrl) { _monacoLoadPromise = null; return reject(new Error('monaco unavailable in browser dev')); }

      // Load loader.js
      const s = document.createElement('script');
      s.src = baseUrl + '/loader.js';
      s.onload = () => {
        try {
          // eslint-disable-next-line no-undef
          require.config({ paths: { vs: baseUrl } });

          // All workers: use workerMain.js.
          window.MonacoEnvironment = {
            getWorker: function (workerId, label) {
              // LSP OFF（铁律 §5.1）：诊断/补全/悬浮全禁 → TS/JS 语言服务 worker 零职责。
              // stub 返回 → 杜绝 tsMode 对 file:///e%3A 百分号编码 URI 解析失败噪音（F4 根治）
              if (label === 'typescript' || label === 'javascript') {
                return { postMessage: function () {}, terminate: function () {}, addEventListener: function () {} };
              }
              var workerUrl = 'qqqide-asset://monaco/vs/base/worker/workerMain.js';
              // [silent] monaco-worker
              return new Worker(workerUrl);
            },
          };

          // eslint-disable-next-line no-undef
          require(['vs/editor/editor.main'], () => {
            var monaco = window.monaco;



            // ═══ LSP OFF: disable all Monaco built-in worker diagnostics ═══
            // TS/JS: no semantic/syntax validation, no completions, no hover
            if (monaco.languages.typescript) {
              monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
              monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
            }
            // CSS/HTML/JSON: disable validation
            if (monaco.languages.css) monaco.languages.css.cssDefaults.setOptions({ validate: false });
            if (monaco.languages.html) monaco.languages.html.htmlDefaults.setOptions({ validate: false });
            if (monaco.languages.json) monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false });
            // [silent] monaco ready
            resolve(monaco);
          }, reject);
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('failed to load monaco loader.js'));
      document.head.appendChild(s);
    });
    return _monacoLoadPromise;
  }

  // ---- Global theme sync (register once, affects all Monaco editors) ----
  let _themeSyncDone = false;
  function hookThemeSync(monaco) {
    if (_themeSyncDone) return;
    if (!window.qqqideTheme) return;
    _themeSyncDone = true;
    window.qqqideTheme.onChange(function (dark) {
      monaco.editor.setTheme(dark ? 'solarized-dark' : 'solarized-light');
    });
  }



  // ── 撤销模式：按设置决定是否挂载逐字回退 ──
  var _undoModeUnsub = null;
  var _allMonacoEditors = []; // 跟踪所有编辑器实例

  function _applyUndoMode(ed, monaco) {
    if (!ed || !monaco) return;
    // 登记编辑器
    if (_allMonacoEditors.indexOf(ed) < 0) {
      _allMonacoEditors.push(ed);
    }
    var mode = window.qqqSettings ? window.qqqSettings.get('editor.undoMode', 'char') : 'char';
    if (mode === 'char') {
      if (window.qqqCharUndo) {
        window.qqqCharUndo.attachMonaco(ed, monaco);
      }
    } else {
      // 'word': 卸载逐字回退，Monaco 原生接管
      if (window.qqqCharUndo) {
        window.qqqCharUndo.detach(ed);
      }
    }
  }

  function _updateAllUndoModes() {
    if (!_monacoRef) return;
    for (var i = 0; i < _allMonacoEditors.length; i++) {
      _applyUndoMode(_allMonacoEditors[i], _monacoRef);
    }
  }

  // 监听设置变更
  if (window.qqqSettings && window.qqqSettings.onChange) {
    _undoModeUnsub = window.qqqSettings.onChange('editor.undoMode', function () {
      _updateAllUndoModes();
    });
  }

  // ── Editor font size (from zoom buttons) ──
  var _editorFontSize = 13;
  function _applyFontSizeToAll() {
    for (var i = 0; i < _allMonacoEditors.length; i++) {
      try { _allMonacoEditors[i].updateOptions({ fontSize: _editorFontSize }); } catch (_) { }
    }
  }
  // Listen via bridge zoom API (now controls font size, not window zoom)
  if (bridge && bridge.zoom) {
    bridge.zoom.get().then(function (s) {
      if (typeof s === 'number') { _editorFontSize = s; _applyFontSizeToAll(); }
    });
    if (bridge.zoom.onChanged) {
      bridge.zoom.onChanged(function (s) {
        if (typeof s === 'number') { _editorFontSize = Math.round(s); _applyFontSizeToAll(); }
      });
    }
  }

  // ── 共享编辑器选项（build/openInPane 唯一真理源）──
  function _makeEditorBaseOptions() {
    return {
      // ★ 禁用 shadow DOM（2026-08-23 终局）：Monaco 0.34.1 默认 useShadowDOM=true →
      //   右键菜单 .context-view 渲染在 shadow root 内，document 层 CSS/clamp 全部失效
      //   （颜色/箭头走主题与 addAction 内部链路所以正常）。显式 false 后菜单回 document，
      //   shell-main.css .context-view 规则 + 右键菜单边缘躲避 clamp 全部生效。
      useShadowDOM: false,
      automaticLayout: true,
      fontSize: _editorFontSize,
      fontFamily: 'ui-monospace, Consolas, Menlo, monospace',
      // ═══ LSP OFF: strip all smart features ═══
      minimap: { enabled: false },
      scrollBeyondLastLine: 20,
      unusualLineTerminators: 'off',
      renderWhitespace: 'none',
      overviewRulerLanes: 3,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      wordWrap: 'on',
      wrappingStrategy: 'simple',
      stopRenderingLineAfter: 2000,
      tabSize: 4,
      breadcrumbs: { enabled: false },
      smoothScrolling: false,
      cursorBlinking: 'solid',
      cursorSmoothCaretAnimation: 'off',
      cursorSurroundingLines: 0,
      glyphMargin: false,
      folding: true,
      foldingStrategy: 'indentation',
      foldingHighlight: true,
      renderLineHighlight: 'none',
      renderLineHighlightOnlyWhenFocus: true,
      occurrencesHighlight: false,
      selectionHighlight: true,
      matchBrackets: 'never',
      autoClosingBrackets: 'never',
      autoClosingQuotes: 'never',
      autoIndent: 'none',
      renderValidationDecorations: 'off',
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      acceptSuggestionOnEnter: 'off',
      tabCompletion: 'off',
      wordBasedSuggestions: false,
      parameterHints: { enabled: false },
      inlayHints: { enabled: false },
      hover: { enabled: false },
      links: false,
      codeLens: false,
      colorDecorators: false,
      lightbulb: { enabled: false },
      guides: { indentation: false, bracketPairs: true, bracketPairsHorizontal: false, highlightActiveIndentation: false },
      renderIndentGuides: false,
      renderControlCharacters: false,
      unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false },
      dragAndDrop: false,
      selectionClipboard: false,
      emptySelectionClipboard: true,
      contextmenu: true,
      roundedSelection: false,
      lineNumbersMinChars: 2,
      lineDecorationsWidth: 16,
      padding: { top: 0, bottom: 0 },
      stickyScroll: { enabled: false },
      find: { addExtraSpaceOnTop: true, autoFindInSelection: 'never', seedSearchStringFromSelection: 'selection' },
      // ★ 大文件优化：跳过超长行 tokenization + 渲染裁剪
      maxTokenizationLineLength: 1000,
      stopRenderingLineAfter: 2000,
    };
  }

  // ═══ Monaco 右键菜单边缘躲避 ═══
  // ★ 时序根因（2026-08-23 修正）：Monaco ContextView 惰性创建、常驻复用——
  //    appendChild 只在构造时发生一次，之后每次菜单打开都是 clearNode→render→doLayout。
  //    旧实现监听 body appendChild 只在构造时触发一次，且 Monaco doLayout 同步覆盖修正值 → 完全无效。
  //    现改为：①观察 .context-view 内容变化（MutationObserver 回调 = microtask，
  //    天然执行在 doLayout（同步）之后 → 修正值永不被覆盖）②rAF 兜底异步打开路径。
  var _lastEditorContextMenuEvent = null;
  var _menuContentObserver = null;
  var _menuBodyObserver = null;

  function _ensureContextMenuGuard() {
    if (_menuContentObserver) return;
    if (!_menuBodyObserver) {
      // ① body 观察：等 .context-view 首次出现（Monaco 惰性创建），挂观察器
      _menuBodyObserver = new MutationObserver(function () {
        _attachMenuContentObserver();
      });
      try { _menuBodyObserver.observe(document.body, { childList: true }); } catch (_) { }
    }
    // ② 立即尝试：view 已存在（容器非 body 时 bodyObserver 兜不住）→ 直接挂
    _attachMenuContentObserver();
  }

  function _attachMenuContentObserver() {
    if (_menuContentObserver) return;
    var menuEl = document.querySelector('.context-view');
    if (!menuEl) return;
    // ② 观察 style 写入 + 内容变化：Monaco 每次 doLayout 写 left/top（含后续帧
    //    再定位）都触发 → 修正值永不被覆盖。旧 childList 只在 render 时触发一次，
    //    doLayout 再定位直接覆盖修正值——F3 方案失效根因。
    _menuContentObserver = new MutationObserver(function () {
      _clampContextMenuIfVisible();
    });
    _menuContentObserver.observe(menuEl, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
    _clampContextMenuIfVisible();
  }

  function _clampContextMenuIfVisible() {
    if (!_lastEditorContextMenuEvent) return;
    var menuEl = document.querySelector('.context-view');
    if (!menuEl || menuEl.offsetWidth <= 0) return; // display:none（菜单已关）跳过
    _applyContextMenuClamp(menuEl, _lastEditorContextMenuEvent);
  }

  function _findContextMenuEditor(ev) {
    try {
      var el = ev.target && ev.target.closest ? ev.target.closest('.monaco-editor') : null;
      if (el) return el;
    } catch (_) { }
    // 兑底：target 不在 .monaco-editor 子树（closest 失败场景）→ 遍历已注册编辑器
    for (var i = 0; i < _allMonacoEditors.length; i++) {
      try {
        var domNode = _allMonacoEditors[i].getDomNode();
        if (domNode && domNode.contains && domNode.contains(ev.target)) return domNode;
      } catch (_) { }
    }
    return null;
  }

  function _scheduleContextMenuClamp() {
    _ensureContextMenuGuard(); // ★ 每次右键重试挂 observer（view 惰性创建/容器非 body 时 bodyObserver 兜不住）
    var tries = 0;
    (function tick() {
      var menuEl = document.querySelector('.context-view');
      if (menuEl && menuEl.offsetWidth > 0) {
        _applyContextMenuClamp(menuEl, _lastEditorContextMenuEvent);
        // ★ 多帧持续修正：Monaco 若在后续帧再定位（异步 doLayout），下一帧纠正回来
        if (++tries < 8) requestAnimationFrame(tick);
        return;
      }
      if (++tries < 8) requestAnimationFrame(tick); // 最多 ~8 帧等异步打开
    })();
  }

  function _applyContextMenuClamp(menuEl, ev) {
    // 子菜单 holder 不修正（跟随父菜单定位，独立翻转会破坏父子关联）
    if (menuEl.classList && menuEl.classList.contains('menubar-menu-items-holder')) return;
    // 边界 = 触发菜单的编辑器 DOM（光标靠近右缘 → 右上角锚定向左展开）
    var editorEl = _findContextMenuEditor(ev);
    var leftEdge = 4, topEdge = 4, rightEdge = window.innerWidth - 4, bottomEdge = window.innerHeight - 4;
    if (editorEl) {
      var er = editorEl.getBoundingClientRect();
      if (er.width > 50 && er.height > 50) { // 编辑器尺寸有效才收紧边界（未布局/隐藏编辑器不误判）
        leftEdge = er.left + 4;
        topEdge = er.top + 4;
        rightEdge = er.right - 4;
        bottomEdge = er.bottom - 4;
      }
    }
    var rect = menuEl.getBoundingClientRect();
    var mw = rect.width || 220;
    var mh = rect.height || 120;
    if (rect.width <= 0 || rect.height <= 0) return; // 未渲染/已关闭
    var l = ev.clientX, t = ev.clientY;
    // 水平：光标靠右放不下且左侧放得下 → 右上角锚定（菜单右缘贴光标向左展开）
    if (l + mw > rightEdge && l - mw > leftEdge) {
      l = l - mw;
    } else {
      // 左上角锚定，钳制不出左右缘（窄编辑器放不下时右缘对齐）
      l = Math.max(leftEdge, Math.min(l, rightEdge - mw));
    }
    // 垂直：太靠下 → 上移保证完整可见
    if (t + mh > bottomEdge) {
      t = Math.max(topEdge, bottomEdge - mh);
    }
    // ★ 相对修正（2026-08-23 终局）：Monaco 定位是「相对偏移」语义（style 值 = 目标 -
    //   当前页面位置，doLayout 自纠正会把修正值吃回），直接写目标坐标必被覆盖。改为读
    //   当前实际位置算 delta 叠加——fixed/absolute/container 偏移全免疫；delta=0 即到位
    //   不再写 style（防 observer 自激循环）。
    var dx = l - rect.left;
    var dy = t - rect.top;
    if (dx === 0 && dy === 0) return;
    var curL = parseFloat(menuEl.style.left) || 0;
    var curT = parseFloat(menuEl.style.top) || 0;
    menuEl.style.left = Math.max(0, curL + dx) + 'px';
    menuEl.style.top = Math.max(0, curT + dy) + 'px';
  }

  // 全局安装一次 contextmenu 捕获（Monaco 菜单渲染在 body，需在捕获阶段拿坐标）
  document.addEventListener('contextmenu', function (e) {
    _lastEditorContextMenuEvent = e;
    // ★ 菜单构建前刷新喂给 AI 标签（方向箭头跟随焦点面板）
    _refreshFeedToAiLabels();
    // ★ 右键菜单边缘躲避：style 属性观察（每次 Monaco 定位后 microtask 修正，永不被覆盖）+ rAF 兜底
    _ensureContextMenuGuard();
    _clampContextMenuIfVisible();
    _scheduleContextMenuClamp();
  }, true);
  _ensureContextMenuGuard();

  // ── 小地图偏好持久化 + 右键菜单 ──
  var _minimapStore = null;
  var _minimapStoreRoot = null;

  async function _getMinimapRoot() {
    var root = null;
    // 优先取 window._workspaceRoot（AI iframe 有同步赋值）
    if (typeof window._workspaceRoot === 'string' && window._workspaceRoot) {
      root = window._workspaceRoot;
    } else if (bridge && bridge.sync && bridge.sync.getProjectPath) {
      try { root = await bridge.sync.getProjectPath(); } catch (_) { }
    }
    return root ? root.replace(/\\/g, '/').replace(/\/$/, '') : null;
  }

  async function _getMinimapStore() {
    var root = await _getMinimapRoot();
    if (!root) return null;
    if (_minimapStoreRoot !== root) {
      _minimapStore = null;
      _minimapStoreRoot = root;
    }
    if (_minimapStore) return _minimapStore;
    if (!window.qgs || !window.qgs.project) return null;
    _minimapStore = window.qgs.project(root + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
    return _minimapStore;
  }

  function _minimapKey(filePath) {
    return 'editor.minimap.' + filePath.replace(/\\/g, '/');
  }

  async function _isInWorkspace(filePath) {
    if (!filePath) return false;
    var root = await _getMinimapRoot();
    if (!root) return false;
    var fp = filePath.replace(/\\/g, '/');
    return fp.indexOf(root + '/') === 0 || fp === root;
  }

  async function _loadMinimapPref(filePath) {
    if (!filePath || !(await _isInWorkspace(filePath))) return false;
    var store = await _getMinimapStore();
    if (!store) return false;
    try { var v = await store.get(_minimapKey(filePath)); return v === true; }
    catch (_) { return false; }
  }

  async function _saveMinimapPref(filePath, enabled) {
    if (!filePath || !(await _isInWorkspace(filePath))) return;
    var store = await _getMinimapStore();
    if (!store) return;
    store.set(_minimapKey(filePath), enabled).catch(function () { });
  }

  // WeakMap: editor → { disposable, filePath }
  var _minimapActions = typeof WeakMap !== 'undefined' ? new WeakMap() : new Map();

  function _addMinimapAction(ed, monaco, filePath) {
    if (!ed || !monaco) return;
    var prev = _minimapActions.get(ed);
    if (prev && prev.disposable) { try { prev.disposable.dispose(); } catch (_) { } }

    var isOn = false;
    try { isOn = ed.getOption(monaco.editor.EditorOption.minimap).enabled; } catch (_) { }
    var label = (isOn ? '\u2713 ' : '') + '\u5C0F\u5730\u56FE';

    var disposable = ed.addAction({
      id: 'qqq-toggle-minimap',
      label: label,
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: function () {
        var newState = false;
        try { newState = !ed.getOption(monaco.editor.EditorOption.minimap).enabled; } catch (_) { }
        ed.updateOptions({ minimap: { enabled: newState } });
        var fp = filePath;
        if (fp) _saveMinimapPref(fp, newState);
        _addMinimapAction(ed, monaco, fp);
      }
    });
    _minimapActions.set(ed, { disposable: disposable, filePath: filePath });
  }

  async function _applyMinimapPref(ed, monaco, filePath) {
    if (!ed || !filePath) return;
    var pref = await _loadMinimapPref(filePath);
    if (pref) {
      ed.updateOptions({ minimap: { enabled: true } });
    }
    _addMinimapAction(ed, monaco, filePath);
  }

  // ── 喂给 AI：编辑器右键 → 注入 📎"path" L15-L18 到焦点面板键入框 ──
  var _feedToAiActions = typeof WeakMap !== 'undefined' ? new WeakMap() : new Map();

  // ★ 标签按焦点面板方向带左右箭头（Roam 右键菜单传统：←喂给 AI / 喂给 AI / 喂给 AI→）
  function _feedToAiLabel() {
    var t = typeof window.__qqq_aiTarget === 'number' ? window.__qqq_aiTarget : 1;
    return t === 0 ? '\u2190\uD83D\uDCCE \u5582\u7ED9 AI' : t === 2 ? '\uD83D\uDCCE \u5582\u7ED9 AI\u2192' : '\uD83D\uDCCE \u5582\u7ED9 AI';
  }

  // ★ 右键弹出前刷新喂给 AI 标签（Monaco action label 创建后不可改，dispose 重建）
  function _refreshFeedToAiLabels() {
    if (typeof window.__qqq_aiTarget !== 'number') return;
    // WeakMap 无 forEach → 遍历 _allMonacoEditors（dispose 时已 splice）
    for (var i = 0; i < _allMonacoEditors.length; i++) {
      var ed = _allMonacoEditors[i];
      var v = _feedToAiActions.get(ed);
      if (v && v.monaco) { try { _addFeedToAiAction(ed, v.monaco, v.filePath); } catch (_) { } }
    }
  }

  function _addFeedToAiAction(ed, monaco, filePath) {
    if (!ed || !monaco) return;
    var prev = _feedToAiActions.get(ed);
    if (prev && prev.disposable) { try { prev.disposable.dispose(); } catch (_) { } }

    var label = _feedToAiLabel();

    var disposable = ed.addAction({
      id: 'qqq-feed-to-ai',
      label: label,
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.6,
      run: function () {
        var fp = filePath;
        if (!fp) return;
        var lineRange = null;
        try {
          var sel = ed.getSelection();
          if (sel && !sel.isEmpty()) {
            if (sel.startLineNumber === sel.endLineNumber) {
              lineRange = 'L' + sel.startLineNumber;
            } else {
              lineRange = 'L' + sel.startLineNumber + '-L' + sel.endLineNumber;
            }
          }
        } catch (_) { }
        if (window.__qqq_aiFeedFile) {
          window.__qqq_aiFeedFile(fp, false, lineRange);
        }
      }
    });
    _feedToAiActions.set(ed, { disposable: disposable, filePath: filePath, monaco: monaco });
  }









  let _monacoRef = null;   // raw monaco namespace
  let _editorRef = null;   // 首个创建的 pane 编辑器（getEditorInstance 兜底实例）
  let _activePaneEd = null; // ★ 活跃编辑器 = 最后聚焦/最近激活的 pane 实例（查找框定位等消费）
  let _paneEditors = {};    // filePath → editor instance (for live refresh)
  // ★ 2026-09-26：同一路径的编辑器存活集合（split view 下 1 路径可有多台）——「还有没有人在世」
  //   的唯一真相源。旧实现只比对单槽 _paneEditors[filePath]（= 最后挂载那台）：关掉先挂载的即误判
  //   「无人在世」→ 清掉共享 dirty/mtime（星号在、auto-save 哑）；关掉后挂载的那台单槽被删 →
  //   getEditorForFile 恒 null（md 预览退磁盘模式/跳转失效）而另一台明明还活着。
  let _paneEdSets = {};     // filePath → Set<editor>
  // ★ 2026-09-26 路径归一：全系统混用 \\ 与 / 两种写法（Roam 历史 / 加号下拉 / AI 链接 / timeline 回跳），
  //   编辑器簿记键与 dirty 事件载荷统一正斜杠形式（与 timeline / dirty 主进程存储 / 加号下拉口径一致），
  //   否则同一文件两种写法 = 两份簿记（dirty 星号/预览斜体/删除标记各算各的）。
  function _normFP(p) { return String(p == null ? '' : p).replace(/\\/g, '/'); }
   let _jumpLineStyleInjected = false;
  var _openedMtime = {};    // filePath → {mtimeMs, size} — track when we last loaded/saved
  var _paneDirtyMap = {};   // filePath → boolean — per-pane dirty state
  // ★ 全局刷新锁：任何程序化 applyEdits（外部修改重载/跨窗口脏快照/live refresh）期间置位，
  //   屏蔽所有编辑器（含共享 model 的另一编辑器）的 dirty 误报——
  //   只屏蔽发起者 ed._isRefreshing 会漏掉同 model 的另一 listener（split view 打开即脏的根因）
  var _globalRefreshLock = false;
  var _modelRefs = {};      // model.id → 引用计数（split view 共享 model，归零才 dispose）

  // ═══ 外部修改机器 v2 状态：冲突 / 在飞保存 / 检测在飞 / 轮询 / 提示节流 ═══
  var _conflictState = {};   // fp → {diskSig, at} — 磁盘外部修改未裁（编辑器脏）
  var _conflictArchBuf = {}; // fp|side → 已归档内容/哈希（双端快照去重）
  var _savingPaths = {};     // fp → Promise — 在飞保存（检测/关闭守卫互斥用）
  var _extBusy = {};         // fp → bool — 检测在飞（防重入）
  var _extToastAt = {};      // fp → ts — 提示节流（8s）
  var _extDebounce = {};     // fp → timer — 突发写合并（120ms）
  var _extPollTimer = null;  // 外部修改轮询（5s，可见时）

  // ── 括号匹配 — 自实现，零 LSP 依赖 ──
  var _bracketStyleInjected = false;
  var _BR_PAIRS = { '(': ')', '[': ']', '{': '}' };
  var _BR_REV   = { ')': '(', ']': '[', '}': '{' };
  var _BR_OPEN  = new Set(['(', '[', '{']);
  var _BR_CLOSE = new Set([')', ']', '}']);
  var _BR_MAX_SCAN = 50000; // 单方向最大扫描字符数，防大文件卡死

  function _installBracketMatcher(ed, monaco) {
    if (!_bracketStyleInjected) {
      _bracketStyleInjected = true;
      var s = document.createElement('style');
      s.textContent = '.qqq-bracket-match{background:rgba(181,137,0,0.25)!important;outline:1px solid rgba(181,137,0,0.6)}[data-theme="dark"] .qqq-bracket-match{background:rgba(181,137,0,0.35)!important;outline:1px solid rgba(181,137,0,0.7)}';
      document.head.appendChild(s);
    }

    var _bDecos = [];
    var _bTimer = 0;

    function _clearDecos() {
      if (_bDecos.length > 0) {
        try { _bDecos = ed.deltaDecorations(_bDecos, []); } catch (_) {}
      }
    }

    // per-line token cache: 避免同一行反复调 getLineTokens
    var _bTok = {};

    function _inStrOrCmt(model, line, col) {
      var toks = _bTok[line];
      if (toks === undefined) {
        try {
          var raw = model.getLineTokens(line);
          toks = raw && raw.getTokens ? raw.getTokens() : (raw && raw.tokens ? raw.tokens : []);
        } catch (_) { toks = []; }
        _bTok[line] = toks;
      }
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        var off = t.offset, len = t.text ? t.text.length : 0;
        if (col >= off + 1 && col < off + 1 + len) {
          return t.type.indexOf('string') === 0 || t.type.indexOf('comment') === 0;
        }
      }
      return false;
    }

    function _findMatch(model, lines, startLine, startCol, isOpen) {
      var totalLines = lines.length;
      _bTok = {}; // 每轮新匹配清 token 缓存

      if (isOpen) {
        var openCh = model.getValueInRange({ startLineNumber: startLine, startColumn: startCol, endLineNumber: startLine, endColumn: startCol + 1 });
        var closeCh = _BR_PAIRS[openCh];
        if (!closeCh) return null;
        var stack = 1, line = startLine, col = startCol + 1, scanned = 0;
        while (line <= totalLines && scanned < _BR_MAX_SCAN) {
          var ln = lines[line - 1];
          while (col <= ln.length && scanned < _BR_MAX_SCAN) {
            var ch = ln[col - 1];
            if (ch === openCh && !_inStrOrCmt(model, line, col)) { stack++; }
            else if (ch === closeCh && !_inStrOrCmt(model, line, col)) { stack--; if (stack === 0) return { line: line, col: col }; }
            col++; scanned++;
          }
          line++; col = 1;
        }
      } else {
        var closeCh2 = model.getValueInRange({ startLineNumber: startLine, startColumn: startCol, endLineNumber: startLine, endColumn: startCol + 1 });
        var openCh2 = _BR_REV[closeCh2];
        if (!openCh2) return null;
        var stack = 1, line = startLine, col = startCol - 1, scanned = 0;
        while (line >= 1 && scanned < _BR_MAX_SCAN) {
          var ln = lines[line - 1];
          while (col >= 1 && scanned < _BR_MAX_SCAN) {
            var ch = ln[col - 1];
            if (ch === closeCh2 && !_inStrOrCmt(model, line, col)) { stack++; }
            else if (ch === openCh2 && !_inStrOrCmt(model, line, col)) { stack--; if (stack === 0) return { line: line, col: col }; }
            col--; scanned++;
          }
          line--;
          if (line >= 1) col = lines[line - 1].length;
        }
      }
      return null;
    }

    function _highlight(a, b) {
      _clearDecos();
      try {
        _bDecos = ed.deltaDecorations([], [
          { range: new monaco.Range(a.line, a.col, a.line, a.col + 1), options: { className: 'qqq-bracket-match' } },
          { range: new monaco.Range(b.line, b.col, b.line, b.col + 1), options: { className: 'qqq-bracket-match' } }
        ]);
      } catch (_) {}
    }

    ed.onDidChangeCursorPosition(function (e) {
      clearTimeout(_bTimer);
      _bTimer = setTimeout(function () {
        _clearDecos();
        try {
          var model = ed.getModel(); if (!model) return;
          var pos = e.position;
          // 优先取光标处字符，其次取光标左侧字符
          var chAt = model.getValueInRange({ startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column + 1 });
          var line = pos.lineNumber, col = pos.column;
          if (!_BR_OPEN.has(chAt) && !_BR_CLOSE.has(chAt) && pos.column > 1) {
            chAt = model.getValueInRange({ startLineNumber: pos.lineNumber, startColumn: pos.column - 1, endLineNumber: pos.lineNumber, endColumn: pos.column });
            col = pos.column - 1;
          }
          if (!_BR_OPEN.has(chAt) && !_BR_CLOSE.has(chAt)) return;

          var lines = model.getValue().split('\n');
          var match = _findMatch(model, lines, line, col, _BR_OPEN.has(chAt));
          if (match) _highlight({ line: line, col: col }, match);
        } catch (_) {}
      }, 120);
    });

    ed.onDidBlurEditorWidget(function () { _clearDecos(); });
    ed.onDidDispose(function () { _clearDecos(); });
  }

  // ★ 搜索跳转行高亮给目标行加背景色，4s 自动消失
  function _highlightJumpLine(ed, monaco, lineNumber) {
    if (!_jumpLineStyleInjected) {
      _jumpLineStyleInjected = true;
      var style = document.createElement('style');
      style.textContent = '.qqq-jump-line{background:rgba(181,137,0,0.18)!important}[data-theme="dark"] .qqq-jump-line{background:rgba(181,137,0,0.25)!important}';
      document.head.appendChild(style);
    }
    try {
      var deco = ed.deltaDecorations([], [{
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: { isWholeLine: true, className: 'qqq-jump-line' }
      }]);
      setTimeout(function () { try { ed.deltaDecorations(deco, []); } catch (_) {} }, 4000);
    } catch (_) {}
  }

  // ---- openInPane: create a Monaco editor inside a tab pane for a specific file ----
  async function openInPane(host, filePath, content, opts) {
    filePath = _normFP(filePath);   // ★ 2026-09-26 路径归一：簿记键/事件载荷/timeline 全走正斜杠（唯一口径）
    try {
      const monaco = await loadMonaco();
      if (window.qqqideTheme) { window.qqqideTheme.defineMonacoThemes(monaco); }
      hookThemeSync(monaco);
      // ★ codelens 按钮机器（幂等；真实文件编辑器走本路径——缺它则按钮永不出现）
      if (window.qqqCodelens && window.qqqCodelens.install) {
        try { window.qqqCodelens.install(monaco); } catch (_) { }
      }
      var lang = langOf(filePath);
      var isBin = await isBinaryFileAsync(filePath);
      if (isBin) {
        if (window.qqqideQoast) window.qqqideQoast.show(String.fromCharCode(10060, 32, 20108, 36827, 21046, 25991, 20214, 65292, 26080, 27861, 22312, 32534, 36753, 22120, 20013, 25171, 24320), { duration: 4000 });
        return null;
      }

      // Use plain file path as URI so Monaco's TS worker can resolve it.
      var plainPath = filePath.replace(/\\/g, '/');
      // ★ 用 Uri.file() 或稳健 fallback，设 file:// scheme 防盘符被当 URI scheme 吞掉
      var fileUri;
      if (typeof monaco.Uri.file === 'function') {
        fileUri = monaco.Uri.file(plainPath);
      } else {
        // fallback: 手动构造 file:/// URI（盘符冒号需编码为 %3A）
        var encodedPath = plainPath.replace(/^([A-Za-z]):/, '/$1%3A');
        fileUri = monaco.Uri.parse('file://' + encodedPath);
      }
      var contentStr = content == null ? '' : String(content);

      // ★ #1 大文件：先用 plaintext 创建 model（跳过 tokenizer，秒开）
      var _deferColoring = _shouldDeferColoring(contentStr, lang);
      var initialLang = _deferColoring ? 'plaintext' : lang;

      var model = monaco.editor.getModel(fileUri);
      if (!model) {
        model = monaco.editor.createModel(contentStr, initialLang, fileUri);
      } else {
        // ★ 复用已有 model：只同步语言，绝不重写内容——
        //   同一文件 split view 共享 model，覆盖内容会销毁另一编辑器未保存的编辑 + 误触发 dirty
        if (model.getLanguageId() !== initialLang) { monaco.editor.setModelLanguage(model, initialLang); }
      }
      // ★ model 引用计数：同一 model 被多编辑器共享（split view），
      //   最后一个编辑器 dispose 时才真正 dispose model（防提前销毁共享 model）
      try { _modelRefs[model.id] = (_modelRefs[model.id] || 0) + 1; } catch (_) {}

      const ed = monaco.editor.create(host, Object.assign({
        model: model,
        theme: (window.qqqideTheme && window.qqqideTheme.getMonacoTheme()) || 'vs',
        readOnly: (opts && opts.readOnly) || false,
        rulers: [],
      }, _makeEditorBaseOptions()));

      // ★ 初始化阶段屏蔽 onDidChangeModelContent — 防 model 复用
      //   applyEdits 或后续 setup 触发 _markDirty → 打开即带星号。
      ed._isRefreshing = true;

      // 首个创建的编辑器 = 兜底实例（getEditorInstance 回落）
      if (!_monacoRef) _monacoRef = monaco;
      if (!_editorRef) _editorRef = ed;
      // ★ 聚焦即活跃（getEditorInstance 消费——查找框定位不再开在错误编辑器）
      try { ed.onDidFocusEditorWidget(function () { _activePaneEd = ed; }); } catch (_) {}
      // ★ 标记文件路径（viewport-machine / export / codelens 等按 ed._qqqFilePath 消费 — URI 在 Windows 上可能丢盘符）
      try { ed._qqqFilePath = filePath; } catch (_) {}
      try { host._qqqFilePath = filePath; } catch (_) {}
      // ★ pane 绑定编辑器实例：tab 关闭/预览复用按 pane 精确找到本格编辑器（split view 同路径多编辑器）
      try { host._qqqEd = ed; } catch (_) {}
      try { host.setAttribute('data-editor-mount', '1'); } catch (_) {}
      // 唯一真理逐字回退机器：按设置决定是否挂载
      _applyUndoMode(ed, monaco);
      // 防滚动条贴底：Monaco 内部 scrollable 底部留 1px
      try { var _se = host.querySelector('.monaco-scrollable-element'); if (_se) _se.style.marginBottom = '1px'; } catch (_) {}

      // 行号右侧空气墙点击 → 光标跳到第一列
      _installGutterClickFix(ed, monaco);

 
      _applyMinimapPref(ed, monaco, filePath);
      _addFeedToAiAction(ed, monaco, filePath);
      // ★ Markdown 预览 action（pane 编辑器；同 md-preview.js）
      try { window.__qqqMdAttachAction && window.__qqqMdAttachAction(ed, monaco, filePath); } catch (_) {}
      // 括号匹配（自实现）
      _installBracketMatcher(ed, monaco);
      // 抹除 Change All Occurrences
      try { var a = ed.getAction('editor.action.changeAll'); if (a) a._dispose ? a._dispose() : a.dispose ? a.dispose() : null; } catch (_) {}

      // ★ #2 延迟上色：大文件先 plaintext 秒开，等编辑器稳定后再切语言触发 tokenization
      if (_deferColoring) {
        var _monaco = monaco, _model = model, _lang = lang;
        setTimeout(function () {
          try { _monaco.editor.setModelLanguage(_model, _lang); }
          catch (_) {}
        }, 1300);
      }

      // ★ 搜索跳转：从搜索列表点击跳转到指定行/列（延迟执行，让 Monaco 先完成布局）
      if (opts && opts.line) {
        setTimeout(function () {
          try {
            var _jumpPos = { lineNumber: opts.line, column: opts.col || 1 };
            ed.setPosition(_jumpPos);
            ed.revealPositionInCenter(_jumpPos);
            _highlightJumpLine(ed, monaco, opts.line);
          } catch (_) {}
        }, 300);
      }

      // ★ 窗口快照还原：检查是否有待恢复的光标位置
      if (window.qqqPendingEditorPositions && window.qqqPendingEditorPositions[filePath]) {
        var _pendPos = window.qqqPendingEditorPositions[filePath];
        try { ed.setPosition(_pendPos); ed.revealPositionInCenter(_pendPos); } catch (_) {}
        delete window.qqqPendingEditorPositions[filePath];
      }

      // ★ 搜索高亮：自动打开查找控件并填入搜索词
      if (opts && opts.search && opts.search.trim()) {
        var _srchTerm = opts.search;
        setTimeout(function () {
          try {
            var _fc = ed.getContribution('editor.contrib.findController');
            if (_fc && _fc.start) {
              _fc.start({
                forceRevealReplace: false,
                seedSearchStringFromSelection: 'none',
                seedSearchStringFromNonEmptySelection: false,
                seedSearchStringFromGlobalClipboard: false,
                shouldFocus: 2,
                shouldAnimate: true,
                updateSearchScope: false,
                loop: true
              });
              _fc.getState().change({ searchString: _srchTerm }, false);
              setTimeout(function () {
                _fc.getState().change({ searchString: _srchTerm }, false);
              }, 120);
            } else {
              // fallback: 用 action + DOM 写入
              ed.getAction('actions.find').run();
              var _dn = ed.getDomNode();
              if (_dn) {
                var _at = 0;
                var _try = function () {
                  var _fi = _dn.querySelector('.find-widget input[type="text"]') || _dn.querySelector('.find-widget .monaco-inputbox input');
                  if (_fi) {
                    var _ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    _ns.call(_fi, _srchTerm);
                    _fi.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                  if (++_at < 8) setTimeout(_try, 60);
                };
                setTimeout(_try, 60);
              }
            }
          } catch (_) {}
        }, 300);
      }

      // ── 面包屑导航条 ──
      if (window.qqqEditorBreadcrumb && window.qqqEditorBreadcrumb.create) {
        window.qqqEditorBreadcrumb.create(host, filePath, ed, monaco);
      }

      // ---- Dirty state tracking per pane ----
      // ★ dirty 以路径为真理（共享 model 下多编辑器同一份内容），弃 per-editor 闭包——
      //   旧闭包在「ed1 保存 → ed2 继续编辑」时不触发事件 → 星号永久丢失
      //   仅在无状态时初始化为 false（已 dirty 的共享路径不被再次打开清零）
      if (_paneDirtyMap[filePath] === undefined) { _paneDirtyMap[filePath] = false; }

      function _markDirty() {
        if (!_paneDirtyMap[filePath]) { _paneDirtyMap[filePath] = true; _dispatchDirty(true); }
      }
      function _markClean() {
        if (_paneDirtyMap[filePath]) { _paneDirtyMap[filePath] = false; _dispatchDirty(false); }
      }
      function _dispatchDirty(d) {
        // ★ pane 标识：tab-manager 据此精确定位触发编辑的 tab（pin 只作用于它），
        //   dirty 仍跨组广播（2026-08-16: 防另一组同文件浏览 tab 被强制正体）
        document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: filePath, dirty: d } }));
      }

      // ★ 初始化完成，解除 _isRefreshing 屏蔽（此后编辑正常触发 dirty）
      ed.onDidChangeModelContent(function () {
        if (!ed._isRefreshing && !_globalRefreshLock) {
          _markDirty();
          _pushDirtyDebounced(filePath, ed.getValue());
        }
      });

      // ── 钩子 X 快照（冷却+去重已移至主进程 ipc-timeline.ts 真理机）──
      async function _xHookRecord(fp, content, source) {
        var root = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
          ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
        if (!root || !bridge || !bridge.timeline) return;

        // ★ 计算 +N -M：对比上一版本内容
        var addedLines = null, deletedLines = null;
        try {
            var versions = await bridge.timeline.versions({ projectRoot: root, filePath: fp });
            if (versions && versions.length > 0) {
                var lastVer = versions[versions.length - 1];
                var prevContent = await bridge.timeline.content({ projectRoot: root, blobHash: lastVer.blob_hash });
                if (typeof prevContent === 'string') {
                    var diffFn = (typeof window._a4DiffStats === 'function') ? window._a4DiffStats : null;
                    if (diffFn) {
                        var stats = diffFn(prevContent, content);
                        addedLines = stats.added;
                        deletedLines = stats.deleted;
                    }
                }
            }
        } catch (_) { }

        bridge.timeline.record({
            projectRoot: root, filePath: fp, content: content,
            source: source, addedLines: addedLines, deletedLines: deletedLines
        }).catch(function () { });
      }

      // ---- Auto-save on editor blur（外部修改机器 v2：统一走保存守卫，绝不盲写） ----
      ed.onDidBlurEditorWidget(async function () {
        if (_paneDirtyMap[filePath] && filePath && !(opts && opts.readOnly)) {
          var _saveP = _saveWithGuard(filePath, ed, { trigger: 'blur' });
          _savingPaths[filePath] = _saveP;
          try {
            var _sr = await _saveP;
            if (_sr && _sr.ok) {
              _markClean();
              _xHookRecord(filePath, _sr.content, 'editx');
              _removeDirty(filePath);
              // ★ 2026-08-17: 保存成功 → 清除已删除标记
              if (window.qqqTabs && window.qqqTabs.setTabDeleted) { window.qqqTabs.setTabDeleted(filePath, false); }
            } else if (_sr && _sr.error) {
              console.error('[editor] auto-save failed:', filePath, _sr.error && _sr.error.message);
              // ★ 保存失败必须可见：否则脏 tab 星号永久残留，用户误以为文件已保存（正体+星号之谜）
              _showSaveFailToast(filePath, _sr.error, true);
            }
          } catch (err) {
            console.error('[editor] auto-save failed:', filePath, err && err.message);
            _showSaveFailToast(filePath, err, true);
          } finally {
            if (_savingPaths[filePath] === _saveP) delete _savingPaths[filePath];
          }
        }
      });

      // ---- Ctrl+S（外部修改机器 v2：统一走保存守卫） ----
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        var _saveP2 = _saveWithGuard(filePath, ed, { trigger: 'ctrl-s' });
        _savingPaths[filePath] = _saveP2;
        try {
          var _sr2 = await _saveP2;
          if (_sr2 && _sr2.ok) {
            _markClean();
            _xHookRecord(filePath, _sr2.content, 'editx');
            _removeDirty(filePath);
            // ★ 2026-08-17: 保存成功 → 清除已删除标记
            if (window.qqqTabs && window.qqqTabs.setTabDeleted) { window.qqqTabs.setTabDeleted(filePath, false); }
          } else if (_sr2 && _sr2.error) {
            _showSaveFailToast(filePath, _sr2.error, false);
          }
        } catch (e) {
          console.error('[editor] save failed:', e);
          _showSaveFailToast(filePath, e, false);
        } finally {
          if (_savingPaths[filePath] === _saveP2) delete _savingPaths[filePath];
        }
      });

      // 中心视口管线（锚点/相框唯一渲染真相 = viewport-machine）
      attachQ1v3(ed, monaco, filePath);
      // ★ 初始化完成，解除 _isRefreshing 屏蔽（在 attachQ1v3 之后，防止 viewport 管线触发 model 变更事件导致误报 dirty）
      ed._isRefreshing = false;
      _activePaneEd = ed;   // 新建即视为活跃（后续聚焦/激活继续更新）
      _paneEditors[filePath] = ed;
      try { (_paneEdSets[filePath] = _paneEdSets[filePath] || new Set()).add(ed); } catch (_) { }
      // ★ Markdown 预览联动（2026-09-21）：编辑器挂载完成 → 通知预览机器迟绑定升级（disk → model）。
      //   自动预览常在 Monaco 挂载前打开（disk 模式先出首帧）；缺此收敛，预览停在磁盘模式、脏缓冲编辑不实时。
      try { if (window.qqqMdPreview && window.qqqMdPreview.onEditorMounted) window.qqqMdPreview.onEditorMounted(filePath); } catch (_) {}
      // ★ 记录 mtime，用于聚焦时检测外部修改
      try { var _stPane = await bridge.fs.stat(filePath); if (_stPane) _openedMtime[filePath] = { mtimeMs: _stPane.mtimeMs, size: _stPane.size }; } catch (_) {}
      ed.onDidDispose(function () {
        // ★ split view：同路径另一编辑器仍存活 → 保留共享 dirty/mtime 状态（防保存后星号残留）
        //   ★ 2026-09-26 修正：存活判定改问「幸存集合」（旧单槽比对在关掉后挂载那台时会误判无人在世）
        var _set = _paneEdSets[filePath];
        if (_set) { _set.delete(ed); if (_set.size === 0) delete _paneEdSets[filePath]; }
        var _stillOpen = !!(_set && _set.size > 0);
        // ★ 条件删除 + 重指向：槽位属于自己 → 交给幸存编辑器（getEditorForFile/refreshLiveContent 消费）
        if (_paneEditors[filePath] === ed) {
          if (_set && _set.size > 0) { try { _paneEditors[filePath] = _set.values().next().value; } catch (_) { delete _paneEditors[filePath]; } }
          else delete _paneEditors[filePath];
        }
        if (_activePaneEd === ed) _activePaneEd = null;
        if (!_stillOpen) delete _openedMtime[filePath];
        if (!_stillOpen) delete _paneDirtyMap[filePath];
        // ★ 外部修改机器 v2：最后一个同路径编辑器关闭 → 清「脏快照 store + 冲突态」
        //   （陈旧快照残留会被重开/他窗拉取再现旧内容——「关掉再开还原」病灶）
        if (!_stillOpen) {
          try { _removeDirty(filePath); } catch (_) { }
          try { if (_conflictState[filePath]) delete _conflictState[filePath]; } catch (_) { }
        }
        // ★ model 引用计数归零 → 真正 dispose（防提前销毁 split view 共享 model）
        try {
          if (model && !model.isDisposed()) {
            var _refs = (_modelRefs[model.id] || 1) - 1;
            if (_refs <= 0) { delete _modelRefs[model.id]; model.dispose(); }
            else { _modelRefs[model.id] = _refs; }
          }
        } catch (_) {}
        if (window.qqqCharUndo) window.qqqCharUndo.detach(ed);
        // ★ 中心管线 disposed（仅做簿记清理）
        if (window.qqqViewportMachine && window.qqqViewportMachine.transition) {
          try { window.qqqViewportMachine.transition('disposed', ed); } catch (_) {}
        }
        var ma = _minimapActions.get(ed);
        if (ma) { try { ma.disposable.dispose(); } catch (_) { } _minimapActions.delete(ed); }
        var fa = _feedToAiActions.get(ed);
        if (fa) { try { fa.disposable.dispose(); } catch (_) { } _feedToAiActions.delete(ed); }
        // 从跟踪列表移除
        var idx = _allMonacoEditors.indexOf(ed);
        if (idx >= 0) _allMonacoEditors.splice(idx, 1);
      });
      return ed;
    } catch (e) {
      console.warn('[editor] openInPane fallback:', e && e.message);
      host.innerHTML = '';
      const ta = document.createElement('textarea');
      ta.style.cssText = 'width:100%; height:100%; box-sizing:border-box; border:0; outline:0; padding:12px; font-family:ui-monospace,Consolas,Menlo,monospace; font-size:13px; resize:none; background:var(--background-color); color:var(--text-primary);';
      ta.value = content == null ? '' : String(content);
      host.appendChild(ta);
      // fallback: dirty tracking + blur auto-save
      let _fbDirty = false;
      ta.addEventListener('input', () => {
        if (!_fbDirty) { _fbDirty = true; document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: filePath, dirty: true } })); }
      });
      ta.addEventListener('blur', async () => {
        if (_fbDirty && filePath) {
          try {
            await bridge.fs.write(filePath, ta.value);
            _fbDirty = false;
            document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: filePath, dirty: false } }));
            // ★ 2026-08-17: 保存成功 → 清除已删除标记
            if (window.qqqTabs && window.qqqTabs.setTabDeleted) { window.qqqTabs.setTabDeleted(filePath, false); }
          } catch (err) { /* ignore */ }
        }
      });
      return null;
    }
  }


  // ★ 2026-09-27：保存失败统一提示（唯一入口）——IPC 包装前缀剥离 + 编码拒绝（[ENC_REJECT]）挂动作按钮
  //   （另存为 UTF-8 / 编码菜单）——编码机器给出的出路不再要求用户自己去菜单里找。
  function _showSaveFailToast(filePath, err, retryHint) {
    if (!window.qqqideQoast) return;
    var fn = String(filePath).split(/[\\/]/).pop() || filePath;
    var clean = String((err && err.message) || err || '');
    var encReject = false;
    try {
      if (window.qqqTabs && window.qqqTabs.encErrInfo) {
        var inf = window.qqqTabs.encErrInfo(err);
        clean = inf.msg; encReject = inf.encReject;
      }
    } catch (_) { }
    var _t = function (k, fb) { try { return window._i ? window._i(k, fb) : fb; } catch (_) { return fb; } };
    var text = fn + ' \u4FDD\u5B58\u5931\u8D25\uFF1A' + clean;
    if (retryHint && !encReject) text += ' \uFF08\u5185\u5BB9\u4FDD\u7559\u5728\u7F16\u8F91\u5668\uFF0C\u53EF\u7528 Ctrl+S \u91CD\u8BD5\uFF09';
    var opts = { duration: encReject ? 16000 : 6000, type: 'warn' };
    if (encReject) {
      // 编码拒绝专属：动作直通（按钮 = 官方出路两步之内）
      opts.actions = [
        { label: _t('editor.tabs.saveAsUtf8', '另存为 UTF-8'), onClick: function () { try { window.qqqTabs.applySaveAsEnc(filePath, 'utf8'); } catch (_) { } } },
        { label: _t('editor.tabs.encMenu', '编码菜单'), onClick: function () { try { window.qqqTabs.openEncPopupForPath(null, filePath); } catch (_) { } } }
      ];
    }
    window.qqqideQoast.show(text, opts);
  }

  // ---- refreshLiveContent: update an already-open pane editor with new content (for live chat.txt) ----
  function refreshLiveContent(filePath, content) {
    var ed = _paneEditors[_normFP(filePath)];   // ★ 路径归一：roam 等 iframe 送来的路径可能是反斜杠写法
    if (!ed) return false;
    // ★ 2026-09-27 修补：内容零变化 → 全跳（无变更可言；顺带杜绝该路径的抑制标记泄漏面）
    var _rlSameV = null;
    try { _rlSameV = ed.getValue(); } catch (_) { }
    if (_rlSameV !== null && String(content == null ? '' : content) === _rlSameV) return true;
    try {
      ed._isRefreshing = true;
      _globalRefreshLock = true; window.__qqqGlobalRefreshLock = true;
      if (window.qqqCharUndo) window.qqqCharUndo.suppressOnce(ed);
      // ★ 实时刷新跳过撤销记录（避免每次刷新堆 500KB 到撤销栈）
      var _rfModel = ed.getModel();
      try {
        if (_rfModel && !_rfModel.isDisposed()) {
          _rfModel.applyEdits([{ range: _rfModel.getFullModelRange(), text: content == null ? '' : String(content), forceMoveMarkers: true }]);
        }
      } finally { ed._isRefreshing = false; _globalRefreshLock = false; window.__qqqGlobalRefreshLock = false; }
      return true;
    } catch (e) {
      console.warn('[editor] refreshLiveContent failed:', e && e.message);
      ed._isRefreshing = false;
      return false;
    }
  }

  // ── 脏文件快照：debounced push 到主进程（Layer 2: IDE 领域内视觉一致） ──
  var _dirtyPushTimers = {};
  function _pushDirtyDebounced(filePath, content) {
    if (!filePath || !isElectron || !bridge || !bridge.dirty) return;
    var key = filePath.replace(/\\/g, '/');
    if (_dirtyPushTimers[key]) clearTimeout(_dirtyPushTimers[key]);
    _dirtyPushTimers[key] = setTimeout(function () {
      bridge.dirty.set(key, content);
      delete _dirtyPushTimers[key];
    }, 500);
  }

  function _removeDirty(filePath) {
    if (!filePath || !isElectron || !bridge || !bridge.dirty) return;
    bridge.dirty.remove(filePath.replace(/\\/g, '/'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 外部修改机器 v2（唯一真理源）——「磁盘唯一权威 + 人的缓冲永不丢」
  //   净 → 自动刷新（保滚动 + 变更行高亮 + 可见短提示）
  //   脏 → 冲突条（对比 / 用磁盘版本 / 保留我的）——绝不覆盖、绝不静默
  //   保存 → 守卫先检磁盘签名：外部改动未裁 → 拒写转冲突（force 仅限「用户已查看过该外部版本」）
  //   关闭 → 脏/冲突/在飞保存 → 提示（保存[覆盖] / 不保存 / 取消）
  //   触点 → 轮询 5s + 窗口聚焦 + tab 激活 + AI 写推送（notifyExternalWrite）
  // ═══════════════════════════════════════════════════════════════════════════
  function _extT(k, fb) {
    try { return (typeof window._i === 'function') ? window._i(k, fb) : fb; } catch (_) { return fb; }
  }
  function _extName(fp) { try { return String(fp).split(/[\\/]/).pop(); } catch (_) { return String(fp); } }
  function _extRoot() {
    return (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
      ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
  }
  function _extToast(fp, text, opts) {
    if (!window.qqqideQoast || !text) return;
    var now = Date.now();
    if (_extToastAt[fp] && now - _extToastAt[fp] < 8000) return;
    _extToastAt[fp] = now;
    try { window.qqqideQoast.show(text, opts || { duration: 3000 }); } catch (_) { }
  }
  function _extStat(fp) {
    if (!bridge || !bridge.fs || !bridge.fs.stat) return Promise.resolve(null);
    return bridge.fs.stat(fp).catch(function () { return null; });
  }
  function _extSameSig(a, b) { return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size; }
  function _extKick(fp) {
    fp = _normFP(fp);
    if (!fp) return;
    if (_extDebounce[fp]) clearTimeout(_extDebounce[fp]);
    _extDebounce[fp] = setTimeout(function () {
      delete _extDebounce[fp];
      var ed = _paneEditors[fp];
      if (ed) { try { _checkDirtyAndRefreshPane(fp, ed); } catch (_) { } }
    }, 120);
  }
  function _extSetDirty(fp, d) {
    var cur = !!_paneDirtyMap[fp];
    if (cur !== !!d) {
      _paneDirtyMap[fp] = !!d;
      try { document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: fp, dirty: !!d } })); } catch (_) { }
    }
    if (!d) { try { _removeDirty(fp); } catch (_) { } }
  }

  // ── 冲突条（挂 pane 顶部悬浮；每路径一条；多视图同源） ──
  function _extPanels(fp) {
    var out = [];
    try {
      var set = _paneEdSets[fp];
      if (set) set.forEach(function (edx) {
        try {
          var n = edx.getDomNode && edx.getDomNode();
          n = (n && n.closest) ? n.closest('.qqq-tab-pane') : null;
          if (n && out.indexOf(n) === -1) out.push(n);
        } catch (_) { }
      });
    } catch (_) { }
    return out;
  }
  function _hideConflictBar(fp) {
    var panels = _extPanels(fp);
    for (var i = 0; i < panels.length; i++) {
      var b = panels[i].querySelector(':scope > .qqq-ext-conflict');
      if (b && b.parentNode) { try { b.parentNode.removeChild(b); } catch (_) { } }
    }
  }
  function _showConflictBar(fp) {
    var panels = _extPanels(fp);
    for (var i = 0; i < panels.length; i++) {
      var pane = panels[i];
      var old = pane.querySelector(':scope > .qqq-ext-conflict');
      if (old && old.parentNode) { try { old.parentNode.removeChild(old); } catch (_) { } }
      var bar = document.createElement('div');
      bar.className = 'qqq-ext-conflict';
      var msg = document.createElement('span');
      msg.className = 'qqq-ext-msg';
      msg.textContent = '⚠ ' + _extT('editor.ext.conflictTitle', '磁盘已被外部修改') + ' — ' + _extT('editor.ext.conflictHint', '你的修改仍保留在编辑器里');
      bar.appendChild(msg);
      function _mkBtn(k, fb, fn) {
        var b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = _extT(k, fb);
        b2.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
        bar.appendChild(b2);
      }
      _mkBtn('editor.ext.btnCompare', '对比', function () { _openConflictDiff(fp); });
      _mkBtn('editor.ext.btnUseDisk', '用磁盘版本', function () { _resolveConflictUseDisk(fp); });
      _mkBtn('editor.ext.btnKeepMine', '保留我的', function () { _resolveConflictKeepMine(fp); });
      pane.appendChild(bar);
    }
  }

  // ── 冲突双端快照归档（timeline 留档，随时找回；同内容去重） ──
  async function _archiveConflictSides(fp, ed) {
    var out = { diskHash: null, bufHash: null };
    var root = _extRoot();
    if (!root || !bridge || !bridge.timeline || !bridge.timeline.record) return out;
    try {
      if (bridge.fs && bridge.fs.read) {
        var disk = await bridge.fs.read(fp);
        if (disk != null) {
          if (_conflictArchBuf[fp + '|disk.c'] !== disk) {
            var r1 = await bridge.timeline.record({ projectRoot: root, filePath: fp, content: disk, source: 'conflict-disk' });
            _conflictArchBuf[fp + '|disk.c'] = disk;
            _conflictArchBuf[fp + '|disk.h'] = (r1 && r1.blob_hash) || null;
          }
          out.diskHash = _conflictArchBuf[fp + '|disk.h'] || null;
        }
      }
    } catch (_) { }
    try {
      var cur = (ed && ed.getValue) ? ed.getValue() : null;
      if (typeof cur === 'string') {
        if (_conflictArchBuf[fp + '|buf.c'] !== cur) {
          var r2 = await bridge.timeline.record({ projectRoot: root, filePath: fp, content: cur, source: 'conflict-buffer' });
          _conflictArchBuf[fp + '|buf.c'] = cur;
          _conflictArchBuf[fp + '|buf.h'] = (r2 && r2.blob_hash) || null;
        }
        out.bufHash = _conflictArchBuf[fp + '|buf.h'] || null;
      }
    } catch (_) { }
    return out;
  }

  function _enterConflict(fp, ed, st) {
    var first = !_conflictState[fp];
    _conflictState[fp] = { diskSig: st ? { mtimeMs: st.mtimeMs, size: st.size } : null, at: Date.now() };
    _showConflictBar(fp);
    _archiveConflictSides(fp, ed).catch(function () { });
    if (first) {
      _extToast(fp, '⚠ ' + _extName(fp) + ' — ' + _extT('editor.ext.conflictToast', '磁盘已被外部修改，已暂停自动保存；请选择保留哪一版'), { duration: 6000 });
    }
  }
  function _exitConflict(fp) {
    if (_conflictState[fp]) delete _conflictState[fp];
    _hideConflictBar(fp);
  }
  async function _resolveConflictUseDisk(fp) {
    var ed = _paneEditors[fp];
    if (!ed) { _exitConflict(fp); return; }
    var st = await _extStat(fp);
    if (!st || !st.isFile) { _exitConflict(fp); _extSetDirty(fp, false); return; }
    try { await _archiveConflictSides(fp, ed); } catch (_) { }
    var ok = await _reloadFromDisk(fp, ed, st);
    if (ok) {
      _exitConflict(fp);
      _extSetDirty(fp, false);
      _extToast(fp, _extT('editor.ext.usedDiskToast', '已载入磁盘版本；你之前的修改已存入时间线'), { duration: 4000 });
    }
  }
  async function _resolveConflictKeepMine(fp) {
    var ed = _paneEditors[fp];
    if (!ed) { _exitConflict(fp); return; }
    var r = await _saveWithGuard(fp, ed, { trigger: 'conflict-overwrite' });
    if (r && r.ok) {
      _exitConflict(fp);
      _extSetDirty(fp, false);
      _extToast(fp, _extT('editor.ext.keepMineToast', '已用你的版本覆盖磁盘'), { duration: 3500 });
    }
  }
  async function _openConflictDiff(fp) {
    var root = _extRoot();
    if (!root || !bridge || !bridge.timeline || !bridge.timeline.openDiffWindow) return;
    var ed = _paneEditors[fp];
    var sides = { diskHash: null, bufHash: null };
    try { sides = await _archiveConflictSides(fp, ed); } catch (_) { }
    try {
      bridge.timeline.openDiffWindow({
        filePath: fp, projectRoot: root,
        beforeBlobHash: sides.diskHash || undefined,
        afterBlobHash: sides.bufHash || undefined
      }).catch(function () { });
    } catch (_) { }
  }

  // ── 变更行段（首/末差异行；巨大文件跳过）＋ 高亮（2.6s 自熄） ──
  function _extDiffBand(a, b) {
    if (a === b) return null;
    var al = a.split('\n'), bl = b.split('\n');
    if (al.length > 120000 || bl.length > 120000) return null;
    var n = Math.min(al.length, bl.length);
    var top = 0;
    while (top < n && al[top] === bl[top]) top++;
    var bot = 0;
    while (bot < n - top && al[al.length - 1 - bot] === bl[bl.length - 1 - bot]) bot++;
    var startLine = top + 1;
    var endLine = Math.max(startLine, bl.length - bot);
    return { startLine: startLine, endLine: endLine };
  }
  function _extFlashBand(editors, band, model) {
    var mn = _monacoRef;
    if (!mn || !mn.Range) return;
    var maxLine = 1;
    try { maxLine = model.getLineCount(); } catch (_) { }
    var startL = Math.max(1, Math.min(band.startLine, maxLine));
    var endL = Math.max(startL, Math.min(band.endLine, maxLine));
    var decos = [];
    for (var i = 0; i < editors.length; i++) {
      try {
        var ids = editors[i].deltaDecorations([], [{
          range: new mn.Range(startL, 1, endL, 1),
          options: { isWholeLine: true, className: 'qqq-ext-changed-line' }
        }]);
        decos.push({ ed: editors[i], ids: ids });
      } catch (_) { }
    }
    if (!decos.length) return;
    setTimeout(function () {
      for (var j = 0; j < decos.length; j++) {
        try { decos[j].ed.deltaDecorations(decos[j].ids, []); } catch (_) { }
      }
    }, 2600);
  }

  // ── 干净重载（保滚动/光标 + 变更高亮；读后复检防半截写） ──
  async function _reloadFromDisk(fp, ed, st) {
    if (!bridge || !bridge.fs || !bridge.fs.read) return false;
    var disk = null;
    try { disk = await bridge.fs.read(fp); } catch (_) { return false; }
    if (disk == null) return false;
    try {
      var st2 = await _extStat(fp);
      if (st2 && st && !_extSameSig(st, st2)) {
        var disk2 = await bridge.fs.read(fp);
        if (disk2 != null) { disk = disk2; st = st2; }
      }
    } catch (_) { }
    var editors = [];
    try { var set = _paneEdSets[fp]; if (set) set.forEach(function (x) { editors.push(x); }); } catch (_) { }
    if (!editors.length && ed) editors.push(ed);
    var m = null;
    try { m = ed.getModel ? ed.getModel() : null; } catch (_) { }
    if (!m || m.isDisposed()) return false;
    var oldV = '';
    try { oldV = m.getValue(); } catch (_) { }
    if (disk === oldV) { _openedMtime[fp] = { mtimeMs: st.mtimeMs, size: st.size }; return true; }
    var band = _extDiffBand(oldV, disk);
    var scrolls = editors.map(function (x) { try { return x.getScrollTop(); } catch (_) { return 0; } });
    var pos = null;
    try { pos = ed.getPosition(); } catch (_) { }
    ed._isRefreshing = true;
    _globalRefreshLock = true; window.__qqqGlobalRefreshLock = true;
    if (window.qqqCharUndo) { try { window.qqqCharUndo.suppressOnce(ed); } catch (_) { } }
    try {
      m.applyEdits([{ range: m.getFullModelRange(), text: String(disk), forceMoveMarkers: true }]);
    } finally {
      ed._isRefreshing = false; _globalRefreshLock = false; window.__qqqGlobalRefreshLock = false;
    }
    _openedMtime[fp] = { mtimeMs: st.mtimeMs, size: st.size };
    for (var i = 0; i < editors.length; i++) {
      try { editors[i].setScrollTop(scrolls[i]); } catch (_) { }
    }
    if (pos) {
      try { ed.setPosition({ lineNumber: Math.min(pos.lineNumber, m.getLineCount()), column: 1 }); } catch (_) { }
    }
    if (band) _extFlashBand(editors, band, m);
    if (window.qqqTabs && window.qqqTabs.refreshEncForPath) { try { window.qqqTabs.refreshEncForPath(fp); } catch (_) { } }
    try {
      var dn = ed.getDomNode && ed.getDomNode();
      var paneNode = (dn && dn.closest) ? dn.closest('.qqq-tab-pane') : null;
      var visible = !!(paneNode && paneNode.classList.contains('qqq-tab-pane-active') && document.visibilityState === 'visible');
      if (visible) _extToast(fp, '↻ ' + _extName(fp) + ' ' + _extT('editor.ext.refreshedTip', '已被外部修改，已刷新显示'), { duration: 3000 });
    } catch (_) { }
    return true;
  }

  // ── 保存守卫（一切保存路径唯一入口）：外部改动未裁 → 拒写转冲突 ──
  //   force（conflict-overwrite）仅在「磁盘仍是用户已查看过的那个外部版本」时放行；
  //   磁盘又变了 → 重新进冲突（绝无静默覆盖窗口）。
  async function _saveWithGuard(fp, ed, opts) {
    opts = opts || {};
    var force = opts.trigger === 'conflict-overwrite';
    var val = '';
    try { val = ed.getValue(); } catch (_) { return { ok: false, error: 'no-value' }; }
    var prev = _openedMtime[fp];
    var st = await _extStat(fp);
    var exists = !!(st && st.isFile);
    var diskChanged = !!(exists && prev && !_extSameSig(prev, st));
    if (diskChanged) {
      var diskV = null;
      try { diskV = await bridge.fs.read(fp); } catch (_) { }
      if (diskV != null && diskV === val) {
        _openedMtime[fp] = { mtimeMs: st.mtimeMs, size: st.size };
        if (_conflictState[fp]) _exitConflict(fp);
        return { ok: true, noop: true, content: val };
      }
      var cSig = _conflictState[fp] && _conflictState[fp].diskSig;
      var forceValid = force && cSig && _extSameSig(cSig, st);
      if (!forceValid) {
        if (!_paneDirtyMap[fp] && !_conflictState[fp]) {
          // 干净缓冲（无用户修改）→ 净重载语义（不做覆盖）
          await _reloadFromDisk(fp, ed, st);
          return { ok: false, refreshed: true };
        }
        _enterConflict(fp, ed, st);
        _extToast(fp, '⚠ ' + _extName(fp) + ' ' + _extT('editor.ext.saveBlocked', '已暂停保存：磁盘被外部修改，请先处理冲突条'), { duration: 6000 });
        return { ok: false, blocked: true };
      }
    }
    try {
      try { await _captureExternalBefore(fp); } catch (_) { }
      await bridge.fs.write(fp, val);
    } catch (err) {
      return { ok: false, error: err };
    }
    // ★ git badge 活动踢：保存落盘 → 通知 AI 视口刷新未提交数（内部 2.5s 防抖 + 距上轮 15s 最小间隔）
    try { if (window.qqqGitPoll && window.qqqGitPoll.kick) window.qqqGitPoll.kick('editor-save'); } catch (_) { }
    try { var st3 = await _extStat(fp); if (st3 && st3.isFile) _openedMtime[fp] = { mtimeMs: st3.mtimeMs, size: st3.size }; } catch (_) { }
    if (_conflictState[fp]) _exitConflict(fp);
    return { ok: true, content: val };
  }

  // ── 关闭守卫（tab 关闭唯一闸门）：脏/冲突/在飞保存 → 提示 ──
  var _closePromptOv = null;
  var _closePromptCtx = null;
  var _closePromptFill = null;
  function _promptClose(fp, retryCb) {
    if (_closePromptOv) {
      _closePromptCtx = { fp: fp, retry: retryCb };
      if (_closePromptFill) { try { _closePromptFill(); } catch (_) { } }
      return;
    }
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:1000002;display:flex;align-items:center;justify-content:center;';
    var panel = document.createElement('div');
    panel.style.cssText = 'width:470px;max-width:92vw;box-sizing:border-box;background:var(--background-color);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,0.5);padding:24px 26px 18px;font-size:14px;line-height:1.7;';
    var h = document.createElement('div');
    h.style.cssText = 'font-size:15px;font-weight:600;text-align:center;word-break:break-all;';
    var b = document.createElement('div');
    b.style.cssText = 'font-size:12.5px;margin:10px 0 0;text-align:center;color:var(--text-secondary);white-space:pre-line;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:26px;flex-wrap:wrap;';
    var btnSave = document.createElement('button');
    var btnDiscard = document.createElement('button');
    var btnCancel = document.createElement('button');
    var _btnStyle = 'padding:7px 16px;border:1px solid var(--border-strong);border-radius:6px;background:transparent;color:var(--text-primary);font-size:13px;';
    [btnSave, btnDiscard, btnCancel].forEach(function (b2) { b2.type = 'button'; b2.style.cssText = _btnStyle; row.appendChild(b2); });
    panel.appendChild(h); panel.appendChild(b); panel.appendChild(row);
    ov.appendChild(panel); document.body.appendChild(ov);
    _closePromptOv = ov;
    _closePromptFill = function () {
      var conflict2 = !!(_closePromptCtx && _conflictState[_closePromptCtx.fp]);
      var nm = _closePromptCtx ? _extName(_closePromptCtx.fp) : '';
      h.textContent = _extT('editor.ext.closeTitle', '有未保存的修改') + (nm ? ' — ' + nm : '');
      b.textContent = conflict2 ? _extT('editor.ext.closeConflictNote', '磁盘已被外部修改：保存将覆盖外部版本（双方快照已留档）')
        : _extT('editor.ext.closeHint', '关闭前保存修改吗？');
      btnSave.textContent = _extT('editor.ext.closeSave', '保存并关闭');
      btnDiscard.textContent = _extT('editor.ext.closeDiscard', '不保存');
      btnCancel.textContent = _extT('editor.ext.closeCancel', '取消');
    };
    function _close(result) {
      document.removeEventListener('keydown', _onKey, true);
      window.removeEventListener('qqq-lang-change', _closePromptFill);
      if (ov.parentNode) { try { ov.parentNode.removeChild(ov); } catch (_) { } }
      _closePromptOv = null; _closePromptFill = null;
      var ctx = _closePromptCtx; _closePromptCtx = null;
      if (result === 'cancel' || !ctx) return;
      if (result === 'discard') {
        try { _exitConflict(ctx.fp); } catch (_) { }
        try { _extSetDirty(ctx.fp, false); } catch (_) { }
        try { ctx.retry && ctx.retry(); } catch (_) { }
        return;
      }
      (async function () {
        var ed2 = _paneEditors[ctx.fp];
        if (!ed2) { try { ctx.retry && ctx.retry(); } catch (_) { } return; }
        var trig = _conflictState[ctx.fp] ? 'conflict-overwrite' : 'blur';
        var r = await _saveWithGuard(ctx.fp, ed2, { trigger: trig });
        if (r && r.ok) {
          _exitConflict(ctx.fp); _extSetDirty(ctx.fp, false);
          try { ctx.retry && ctx.retry(); } catch (_) { }
        } else {
          // 竞争窗口内磁盘又变 / 写失败 → 再问一次（绝无静默）
          _promptClose(ctx.fp, ctx.retry);
        }
      })();
    }
    var _onKey = function (e) { if (e && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); _close('cancel'); } };
    document.addEventListener('keydown', _onKey, true);
    window.addEventListener('qqq-lang-change', _closePromptFill);
    btnSave.addEventListener('click', function (e) { e.stopPropagation(); _close('save'); });
    btnDiscard.addEventListener('click', function (e) { e.stopPropagation(); _close('discard'); });
    btnCancel.addEventListener('click', function (e) { e.stopPropagation(); _close('cancel'); });
    _closePromptCtx = { fp: fp, retry: retryCb };
    _closePromptFill();
  }
  function _extBeforeTabClose(filePath, retry) {
    filePath = _normFP(filePath);
    if (!filePath) return 'ok';
    var saving = _savingPaths[filePath];
    var busy = _extBusy[filePath];
    var dirty = !!_paneDirtyMap[filePath];
    var conflict = !!_conflictState[filePath];
    if (!saving && !busy && !dirty && !conflict) return 'ok';
    if (!_paneEditors[filePath]) {
      // 无存活编辑器（簿记残留）→ 无可保存内容，静默清账放行
      try { if (dirty) _extSetDirty(filePath, false); } catch (_) { }
      try { if (conflict) _exitConflict(filePath); } catch (_) { }
      return 'ok';
    }
    var proceed = function () { try { retry && retry(); } catch (_) { } };
    var settle = function () {
      if (_paneDirtyMap[filePath] || _conflictState[filePath]) _promptClose(filePath, proceed);
      else proceed();
    };
    if (saving || busy) {
      if (saving) {
        saving.then(function () { setTimeout(settle, 30); }, function () { setTimeout(settle, 30); });
      } else {
        var t0 = Date.now();
        (function _w() {
          if (!_extBusy[filePath] || Date.now() - t0 > 3000) { settle(); return; }
          setTimeout(_w, 100);
        })();
      }
      return 'hold';
    }
    _promptClose(filePath, proceed);
    return 'hold';
  }

  // ── 外部修改机器 v2 · 检测唯一入口 ──
  //   盘面 = 唯一权威；净 → 自动刷新（保滚动+变更行高亮）；脏 → 冲突条；绝不静默覆盖
  //   触发：轮询 5s + 窗口聚焦 + tab 激活 + AI 写推送（shell-rpc → notifyExternalWrite）
  async function _checkDirtyAndRefreshPane(filePath, ed) {
    filePath = _normFP(filePath);   // ★ 路径归一：_openedMtime / dirty 快照键必须与挂载口径一致
    if (!filePath || !isElectron || !bridge || !ed) return;
    if (_extBusy[filePath] || _savingPaths[filePath]) return;   // 在飞去重 / 自身保存中不检测
    var m0 = null;
    try { m0 = ed.getModel ? ed.getModel() : null; } catch (_) { }
    if (!m0 || m0.isDisposed()) return;
    _extBusy[filePath] = true;
    try {
      // 1) 盘面状态优先（旧序把脏快照拉取放最前 → 快照命中即 return，外部改动永不被看见）
      if (!bridge.fs || !bridge.fs.stat) return;
      var st = await _extStat(filePath);
      if (!st || !st.isFile) {
        // 文件已被删除 → tab 灰色+删除线（保留语义）；冲突态随之作废
        if (window.qqqTabs && window.qqqTabs.setTabDeleted) window.qqqTabs.setTabDeleted(filePath, true);
        delete _openedMtime[filePath];
        if (_conflictState[filePath]) _exitConflict(filePath);
        return;
      }
      if (window.qqqTabs && window.qqqTabs.setTabDeleted) window.qqqTabs.setTabDeleted(filePath, false);
      var prev = _openedMtime[filePath];
      if (!prev) { _openedMtime[filePath] = { mtimeMs: st.mtimeMs, size: st.size }; }
      var diskChanged = !!(prev && !_extSameSig(prev, st));
      if (diskChanged) {
        // 2) 外部修改：冲突未决 → 保持冲突条（磁盘可能又变了，不重复打扰）
        if (_conflictState[filePath]) { _showConflictBar(filePath); return; }
        if (_paneDirtyMap[filePath]) { _enterConflict(filePath, ed, st); return; }
        // 3) 干净 → 自动刷新（唯一真理 = 磁盘）
        await _reloadFromDisk(filePath, ed, st);
        return;
      }
      // 4) 无外改 → 跨窗口脏快照（仅未聚焦时拉取，避免光标下换文；拉取必须显式标脏）
      if (bridge.dirty) {
        var dirtyContent = await bridge.dirty.get(filePath);
        if (dirtyContent) {
          var cur = '';
          try { cur = ed.getValue(); } catch (_) { }
          if (cur !== dirtyContent) {
            try { if (ed.hasTextFocus()) return; } catch (_) { }
            var m = m0;
            if (!m || m.isDisposed()) return;
            ed._isRefreshing = true;
            _globalRefreshLock = true; window.__qqqGlobalRefreshLock = true;
            if (window.qqqCharUndo) { try { window.qqqCharUndo.suppressOnce(ed); } catch (_) { } }
            try {
              m.applyEdits([{ range: m.getFullModelRange(), text: String(dirtyContent), forceMoveMarkers: true }]);
            } finally { ed._isRefreshing = false; _globalRefreshLock = false; window.__qqqGlobalRefreshLock = false; }
            // ★ 未落盘内容必须显式标脏（旧注释指望「自然触发」，但全局锁把变更事件屏蔽 → 恒不触发 = 状态分裂）
            _extSetDirty(filePath, true);
          }
        }
      }
    } catch (_) {
    } finally {
      delete _extBusy[filePath];
    }
  }

  // 窗口聚焦：遍历所有打开的 editor，刷新脏快照 + 检测外部修改
  function _onWindowFocusRefreshAll() {
    if (!isElectron || !bridge) return;
    // 遍历 pane editors
    var fpKeys = Object.keys(_paneEditors);
    for (var i = 0; i < fpKeys.length; i++) {
      var fp = fpKeys[i];
      var ed = _paneEditors[fp];
      if (ed) _checkDirtyAndRefreshPane(fp, ed);
    }
  }

  if (isElectron) {
    window.addEventListener('focus', _onWindowFocusRefreshAll);
  }

  // ── 外部修改检测：写盘前对比磁盘与 timeline 上一版本 — 不同则捕获 before 快照 ──
  async function _captureExternalBefore(filePath) {
    if (!bridge || !bridge.fs || !bridge.timeline) return;
    var root = (typeof _workspaceRoot !== 'undefined' && _workspaceRoot)
      ? _workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '') : null;
    if (!root) return;
    try {
      var diskContent = await bridge.fs.read(filePath);
      if (diskContent == null) return;
      var versions = await bridge.timeline.versions({ projectRoot: root, filePath: filePath });
      if (!versions || versions.length === 0) return;
      var lastVer = versions[versions.length - 1];
      var prevContent = await bridge.timeline.content({ projectRoot: root, blobHash: lastVer.blob_hash });
      if (typeof prevContent === 'string' && diskContent !== prevContent) {
        // 外部修改！捕获磁盘版本到 timeline（source≠editx，不走 100s 冷却）
        await bridge.timeline.record({
          projectRoot: root, filePath: filePath, content: diskContent,
          source: 'editx-before'
        });
      }
    } catch (_) {}
  }

  // ★ pane 精确取编辑器：paneEl 内挂载实例优先（split view 同路径多编辑器）。
  //   ★ 2026-09-26 修正：给了 paneEl 就只认「本格挂着的那台」——本格没有（尚未挂载/已销毁/读失败）
  //   → 返回 null。旧实现回落单槽 _paneEditors[filePath]（= 最后挂载那台，很可能在另一个分组）：
  //   关 A 组标签却把 B 组编辑器 dispose / 挂起（错杀），或把 B 组编辑器当本格 suspend/resume（视口错乱）。
  function _edForPane(filePath, paneEl) {
    if (paneEl && paneEl.querySelector) {
      try {
        var _mount = paneEl.querySelector('[data-editor-mount]');
        if (_mount && _mount._qqqEd) return _mount._qqqEd;
      } catch (_) { }
      return null;   // 本格无编辑器 → 无本格可操作对象（绝不跨 pane 顶替）
    }
    return _paneEditors[_normFP(filePath)] || null;   // 未给 pane → 单槽兜底
  }

  // ── 外部修改机器武装：轮询（可见时 5s）+ 启动信号门控 ──
  function _extCheckAll() {
    if (!isElectron || !bridge) return;
    var keys = Object.keys(_paneEditors);
    for (var i = 0; i < keys.length; i++) {
      var fp = keys[i];
      var ed = _paneEditors[fp];
      if (ed) { try { _checkDirtyAndRefreshPane(fp, ed); } catch (_) { } }
    }
  }
  function _extPollBoot() {
    if (_extPollTimer || !isElectron || !bridge) return;
    _extPollTimer = setInterval(function () {
      if (document.visibilityState === 'hidden') return;
      _extCheckAll();
    }, 5000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') _extCheckAll();
    });
  }
  if (isElectron && bridge) {
    if (window.__qqqUiShown) _extPollBoot();
    else {
      window.addEventListener('qqq-ui-ready', _extPollBoot, { once: true });
      setTimeout(_extPollBoot, 30000);   // 兜底（信号丢失/空白窗）
    }
  }

  window.qqqEditor = {
    openInPane,
    // ★ 路径级脏查询（tab-manager 预览复用/状态同步用，唯一真理 = _paneDirtyMap）
    isPathDirty: function (filePath) { return !!_paneDirtyMap[_normFP(filePath)]; },
    // ★ 2026-09-05 另存转换后簿记（编码菜单 B 区）：清脏 + 刷新 mtime 快照
    noteSaved: async function (filePath) {
      filePath = _normFP(filePath);   // ★ 路径归一
      if (!filePath) return;
      try {
        var _sn2 = await bridge.fs.stat(filePath);
        if (_sn2) _openedMtime[filePath] = { mtimeMs: _sn2.mtimeMs, size: _sn2.size };
      } catch (_) { }
      if (_paneDirtyMap[filePath]) {
        _paneDirtyMap[filePath] = false;
        document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: filePath, dirty: false } }));
      }
    },
    getMonaco() { return _monacoRef; },
    // ★ 活跃编辑器（最后聚焦/最近激活的 pane 实例；兜底首个创建的）——查找框定位等消费
    getEditorInstance() { return _activePaneEd || _editorRef; },
    // ★ 按文件路径取编辑器实例（搜索跳转/位置还原用）：pane 编辑器优先
    getEditorForFile(filePath) {
      filePath = _normFP(filePath);   // ★ 路径归一（外部调用方路径写法不定）
      return _paneEditors[filePath] || null;
    },
    // ★ 外部修改机器 v2 出口（AI 写推送即时校验 / tab 关闭守卫 / 诊断）
    notifyExternalWrite: function (filePath) { _extKick(filePath); },
    beforeTabClose: function (filePath, retry) { return _extBeforeTabClose(filePath, retry); },
    extState: function () {
      var dirty = [];
      var ks = Object.keys(_paneDirtyMap);
      for (var i = 0; i < ks.length; i++) { if (_paneDirtyMap[ks[i]]) dirty.push(ks[i]); }
      return { conflict: Object.keys(_conflictState), dirty: dirty, tracked: Object.keys(_openedMtime) };
    },
    refreshLiveContent,
    isBinaryFile,
    isBinaryFileAsync,
    saveMinimapPref: _saveMinimapPref,
    // ★ Tab 切换优化：暂停/恢复 Monaco automaticLayout（避免隐藏编辑器做无意义 layout）
    suspendPaneLayout: function(filePath, paneEl) {
      filePath = _normFP(filePath);   // ★ 路径归一（视口机/事件载荷同口径）
      var ed = _edForPane(filePath, paneEl);
      if (ed) {
        try { ed.updateOptions({ automaticLayout: false }); } catch (_) {}
        if (window.qqqViewportMachine && window.qqqViewportMachine.transition) {
          try { window.qqqViewportMachine.transition('hidden', ed, filePath); } catch (_) {}
        }
      }
    },
    resumePaneLayout: function(filePath, paneEl) {
      filePath = _normFP(filePath);   // ★ 路径归一
      var ed = _edForPane(filePath, paneEl);
      if (ed) {
        _activePaneEd = ed;   // 激活即活跃（tab 切换 → 查找框定位跟随）
        try {
          ed.layout();
          ed.updateOptions({ automaticLayout: true });
        } catch (_) {}
        // ★ Tab 激活时：从主进程拉取脏快照，确保多窗口编辑一致
        _checkDirtyAndRefreshPane(filePath, ed);
        // ★ Tab 切换后通过中心管线恢复视口（不再手动调三个单例 attach）
        if (window.qqqViewportMachine && window.qqqViewportMachine.transition) {
          try { window.qqqViewportMachine.transition('focused', ed, filePath); } catch (_) {}
        }
      }
    },
    // ★ 安全销毁面板编辑器（同步；调用方必须先让 pane DOM 保持完整，dispose 后再移除 pane）
    //   filePath 定位 + paneEl 精确匹配：split view 同路径多编辑器时只销毁本格（pane 内挂载的实例）
    disposePaneEditor: function(filePath, paneEl) {
      var ed = _edForPane(filePath, paneEl);
      if (!ed) return;
      // ★ 中心管线 closing：在 editor dispose 前清理 ViewZone/ContentWidget（editor 尚存活）
      if (window.qqqViewportMachine && window.qqqViewportMachine.transition) {
        try { window.qqqViewportMachine.transition('closing', ed, filePath); } catch (_) {}
      }
      try { ed.updateOptions({ automaticLayout: false }); } catch (_) {}
      try { ed.dispose(); } catch (_) {}
      // ★ model 不在此 dispose——由 onDidDispose 引用计数归零时销毁（防 split view 共享 model 被提前销毁）
    },
    // ★ 窗口快照：获取所有打开 editor 的光标位置
    getAllEditorPositions() {
      var positions = {};
      // 面板编辑器（split groups）
      var fpKeys = Object.keys(_paneEditors);
      for (var i = 0; i < fpKeys.length; i++) {
        var fp = fpKeys[i];
        var ed = _paneEditors[fp];
        try {
          if (ed && ed.getModel && !ed.getModel().isDisposed()) {
            var p = ed.getPosition();
            if (p) positions[fp] = { lineNumber: p.lineNumber, column: p.column };
          }
        } catch (_) {}
      }
      return positions;
    },
  };
})();
