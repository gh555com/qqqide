// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// editor.js - Monaco editor wrapper for qqq-shell v2
//
// Loads monaco-editor from qqqide-asset://monaco/vs/loader.js (provided by shell)
// and exposes window.qqqEditor:
//   open(file)   - load a file into the active editor
//   save()       - save current editor content via window.qqqideBridge.fs.write
//   getValue()   - current text
//
// In browser dev (no shell), exposes a textarea fallback.
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

  let editor = null;             // monaco editor instance
  let currentFile = null;        // current open file path
  let dirty = false;             // unsaved changes flag
  let mountEl = null;            // <div> we mount into
  // LSP-related variables and functions removed (all external LSP disabled)


  // ---------------- Fallback (no monaco available) ----------------
  function buildFallback(host) {
    host.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.style.cssText = 'width:100%; height:100%; box-sizing:border-box; border:0; outline:0; padding:12px; font-family:ui-monospace,Consolas,Menlo,monospace; font-size:13px; resize:none; background:var(--background-color); color:var(--text-primary);';
    host.appendChild(ta);
    ta.addEventListener('input', () => { dirty = true; updateTitle(); });
    return {
      isFallback: true,
      setValue(v, _lang) { ta.value = v == null ? '' : String(v); dirty = false; updateTitle(); },
      getValue() { return ta.value; },
      focus() { ta.focus(); },
      insertAtCursor(text) {
        const start = ta.selectionStart || 0;
        const end = ta.selectionEnd || 0;
        ta.value = ta.value.slice(0, start) + String(text) + ta.value.slice(end);
        const np = start + String(text).length;
        ta.selectionStart = ta.selectionEnd = np;
        ta.focus();
        dirty = true; updateTitle();
      },
      dispose() { /* nothing */ },
    };
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

            // ── Bootstrap custom TS/JS IntelliSense (fallback, optional) ──
            // Disabled for now — using Monaco's built-in TS with plain-path URIs.
            // bootCustomTsService(monaco); // LSP OFF

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

  // ── Custom TS/JS providers (replaces Monaco's broken built-in TS worker) ──
  var _tsBootDone = false;

  function bootCustomTsService(monaco) {
    // LSP OFF — not called
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
  var _lastEditorContextMenuEvent = null;
  var _editorContextMenuObserver = null;

  function _ensureContextMenuGuard() {
    if (_editorContextMenuObserver) return;
    _editorContextMenuObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var addedNodes = mutations[i].addedNodes;
        for (var j = 0; j < addedNodes.length; j++) {
          var node = addedNodes[j];
          if (node.nodeType === 1 && node.classList && node.classList.contains('context-view')) {
            _clampContextMenu(node);
          }
        }
      }
    });
    _editorContextMenuObserver.observe(document.body, { childList: true, subtree: true });
  }

  function _clampContextMenu(menuEl) {
    if (!_lastEditorContextMenuEvent) return;
    var ev = _lastEditorContextMenuEvent;
    // 让 Monaco 先完成定位，下一帧再修正
    requestAnimationFrame(function () {
      var rect = menuEl.getBoundingClientRect();
      var mw = rect.width || 200;
      var mh = rect.height || 100;
      var l = ev.clientX, t = ev.clientY;
      // 太靠右 → 移到光标左边
      if (l + mw > window.innerWidth - 4) {
        l = Math.max(4, ev.clientX - mw);
      }
      // 太靠下 → 上移
      if (t + mh > window.innerHeight - 4) {
        t = Math.max(4, window.innerHeight - mh - 4);
      }
      menuEl.style.left = Math.max(4, l) + 'px';
      menuEl.style.top = Math.max(4, t) + 'px';
    });
  }

  // 全局安装一次 contextmenu 捕获（Monaco 菜单渲染在 body，需在捕获阶段拿坐标）
  document.addEventListener('contextmenu', function (e) {
    _lastEditorContextMenuEvent = e;
    // ★ 菜单构建前刷新喂给 AI 标签（方向箭头跟随焦点面板）
    _refreshFeedToAiLabels();
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
        if (!fp && typeof currentFile !== 'undefined') fp = currentFile;
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
        if (!fp && typeof currentFile !== 'undefined') fp = currentFile;
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

  // ---------------- Editor build ----------------
  async function build(host) {
    mountEl = host;
    try {
      const monaco = await loadMonaco();
      // 注册唯一真理配色机器的 Monaco 主题
      if (window.qqqideTheme) { window.qqqideTheme.defineMonacoThemes(monaco); }

      // configureMonacoTypescript(monaco); // LSP OFF

      const theme = (window.qqqideTheme && window.qqqideTheme.getMonacoTheme()) || 'vs';
      const ed = monaco.editor.create(host, Object.assign({
        value: '',
        language: 'plaintext',
        theme: theme,
      }, _makeEditorBaseOptions()));
      _monacoRef = monaco;
      _editorRef = ed;
      ed._isRefreshing = true;
      // 唯一真理逐字回退机器：按设置决定是否挂载
      _applyUndoMode(ed, monaco);
      // 行号右侧空气墙点击 → 光标跳到第一列
      _installGutterClickFix(ed, monaco);
      _addMinimapAction(ed, monaco, null);
      _addFeedToAiAction(ed, monaco, null);
      // 括号匹配（自实现）
      _installBracketMatcher(ed, monaco);
      // 抹除 Change All Occurrences
      try { var a = ed.getAction('editor.action.changeAll'); if (a) a._dispose ? a._dispose() : a.dispose ? a.dispose() : null; } catch (_) {}
      // ── 面包屑导航条（空编辑器：仅工具按钮）──
      if (window.qqqEditorBreadcrumb && window.qqqEditorBreadcrumb.create) {
        window.qqqEditorBreadcrumb.create(host, '', ed, monaco);
      }
      // 主题切换时同步 Monaco（全局注册一次）
      hookThemeSync(monaco);

      // Ctrl+S
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
      ed.onDidChangeModelContent(function (e) {
        if (ed._isRefreshing || _globalRefreshLock) return;
        dirty = true; updateTitle();
        if (currentFile) {
          document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: currentFile, dirty: true } }));
          _pushDirtyDebounced(currentFile, ed.getValue());
        }
      });
      // Auto-save on blur
      ed.onDidBlurEditorWidget(() => {
        if (dirty && currentFile) {
          save().then(ok => {
            if (ok && currentFile) {
              document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: currentFile, dirty: false } }));
            }
          });
        }
      });
      // q1 v3: 中心视口管线
      attachQ1v3(ed, monaco, null);
      ed._isRefreshing = false;
      // Wire LSP diagnostics and hover — LSP OFF
      // wireLspDiagnostics(); // LSP OFF
      // wireLspHover(); // LSP OFF
      // 编辑器销毁时清理（中心管线 disposed + char-undo + actions）
      ed.onDidDispose(function () {
        if (window.qqqCharUndo) window.qqqCharUndo.detach(ed);
        // ★ 中心管线 disposed（仅做簿记清理，不再调 changeViewZones）
        if (window.qqqViewportMachine && window.qqqViewportMachine.transition) {
          try { window.qqqViewportMachine.transition('disposed', ed); } catch (_) {}
        }
        var ma = _minimapActions.get(ed);
        if (ma) { try { ma.disposable.dispose(); } catch (_) { } _minimapActions.delete(ed); }
        var fa = _feedToAiActions.get(ed);
        if (fa) { try { fa.disposable.dispose(); } catch (_) { } _feedToAiActions.delete(ed); }
        var idx = _allMonacoEditors.indexOf(ed);
        if (idx >= 0) _allMonacoEditors.splice(idx, 1);
      });
      editor = {
        isFallback: false,
        setValue(v, lang) {
          const model = ed.getModel();
          var vStr = v == null ? '' : String(v);
          // ★ #1 大文件：先 plaintext 设置内容，延迟上色
          var _defer = _shouldDeferColoring(vStr, lang);
          if (model && lang && !_defer) { monaco.editor.setModelLanguage(model, lang); }
          if (window.qqqCharUndo) window.qqqCharUndo.suppressOnce(ed);
          // ★ 打开文件跳过撤销记录（避免 Ctrl+Z 回到空文件 + 撤销栈存冗余副本）
          if (model && !model.isDisposed()) {
            model.applyEdits([{ range: model.getFullModelRange(), text: vStr, forceMoveMarkers: true }]);
          } else {
            ed.setValue(vStr);
          }
          dirty = false; updateTitle();
          if (_defer && model && lang) {
            var _m = model, _l = lang, _mon = monaco;
            setTimeout(function () {
              try { _mon.editor.setModelLanguage(_m, _l); } catch (_) {}
            }, 1300);
          }
        },
        getValue() { return ed.getValue(); },
        focus() { ed.focus(); },
        insertAtCursor(text) {
          const sel = ed.getSelection();
          ed.executeEdits('paste-insert', [{ range: sel, text: String(text), forceMoveMarkers: true }]);
          ed.focus();
        },
        dispose() { ed.dispose(); },
      };
      return editor;
    } catch (e) {
      console.warn('[editor] monaco unavailable, using textarea fallback:', e && e.message);
      editor = buildFallback(host);
      return editor;
    }
  }

  // ---------------- Public API ----------------
  async function open(file) {
    if (!editor) { console.warn('[editor] not built yet'); return; }
    if (dirty && currentFile && !confirm('Unsaved changes will be lost. Continue?')) { return; }
    try {
      var isBin = await isBinaryFileAsync(file);
      if (isBin) {
        if (window.qqqideQoast) window.qqqideQoast.show(String.fromCharCode(10060, 32, 20108, 36827, 21046, 25991, 20214, 65292, 26080, 27861, 22312, 32534, 36753, 22120, 20013, 25171, 24320), { duration: 4000 });
        return;
      }
      const text = await bridge.fs.read(file);
      if (_editorRef) _editorRef._isRefreshing = true;
      currentFile = file;
      editor.setValue(text, langOf(file));
      // ★ 中心管线：更新主编辑器 filePath，触发锚点重扫
      if (window.qqqViewportMachine && window.qqqViewportMachine.transition && _editorRef) {
        try { window.qqqViewportMachine.transition('created', _editorRef, file); } catch (_) {}
      }
      if (_editorRef) _editorRef._isRefreshing = false;
      dirty = false;
      // ★ 同步清除 tab 脏标记（setValue 可能已触发 dirty:true 事件，强制复位）
      document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: file, dirty: false } }));
      lspLang = null; // LSP OFF
      updateTitle();
      _applyMinimapPref(_editorRef, _monacoRef, file);
      // ★ 记录 mtime，用于聚焦时检测外部修改
      try { var _stOpen = await bridge.fs.stat(file); if (_stOpen) _openedMtime[file] = { mtimeMs: _stOpen.mtimeMs, size: _stOpen.size }; } catch (_) {}
    } catch (e) {
      console.error('[editor] open failed:', e);
      editor.setValue('// failed to open: ' + (e && e.message), 'plaintext');
    }
  }

  // ---- Timeline 快照：编辑器保存触发（冷却+去重已移至主进程 ipc-timeline.ts 真理机） ----

  async function save() {
    if (!editor || !currentFile) { return false; }
    const v = editor.getValue();
    try {
      await _captureExternalBefore(currentFile);
      await bridge.fs.write(currentFile, v);
      dirty = false; updateTitle();
      _maybeRecordTimeline(currentFile, v);
      _removeDirty(currentFile);
      // ★ 同步清除 tab 脏标记（与 _markClean 对齐）
      document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: currentFile, dirty: false } }));
      // ★ 2026-08-17: 保存成功（写盘）→ 文件肯定存在，清除已删除状态
      if (window.qqqTabs && window.qqqTabs.setTabDeleted) {
        window.qqqTabs.setTabDeleted(currentFile, false);
      }
      // ★ 更新 mtime
      try { var _stSave = await bridge.fs.stat(currentFile); if (_stSave) _openedMtime[currentFile] = { mtimeMs: _stSave.mtimeMs, size: _stSave.size }; } catch (_) {}
      return true;
    } catch (e) {
      console.error('[editor] save failed:', e);
      return false;
    }
  }

  async function _maybeRecordTimeline(filePath, content) {
    if (!bridge || !bridge.timeline) return;
    var projectRoot = '';
    try {
      if (bridge.sync && bridge.sync.getProjectPath) {
        projectRoot = await bridge.sync.getProjectPath();
      }
    } catch (_) { }
    if (!projectRoot) return;
    try {
      await bridge.timeline.record({
        projectRoot: projectRoot,
        filePath: filePath,
        content: content,
        source: 'editx'
      });
    } catch (_) { }
  }

  function updateTitle() {
    const name = currentFile ? currentFile.split(/[\\/]/).pop() : '(no file)';
    const txt = (dirty ? '* ' : '') + name;
    const $brand = document.querySelector('.qqq-toolbar-brand');
    if ($brand) { $brand.textContent = 'qqq · ' + txt; }
  }

  let _monacoRef = null;   // raw monaco namespace
  let _editorRef = null;   // raw monaco IStandaloneCodeEditor
  let _paneFiles = {};      // editor dom node → filePath (reverse lookup for dispose cleanup)
  let _paneEditors = {};    // filePath → editor instance (for live refresh)
   let _jumpLineStyleInjected = false;
  var _openedMtime = {};    // filePath → {mtimeMs, size} — track when we last loaded/saved
  var _paneDirtyMap = {};   // filePath → boolean — per-pane dirty state
  // ★ 全局刷新锁：任何程序化 applyEdits（外部修改重载/跨窗口脏快照/live refresh）期间置位，
  //   屏蔽所有编辑器（含共享 model 的另一编辑器）的 dirty 误报——
  //   只屏蔽发起者 ed._isRefreshing 会漏掉同 model 的另一 listener（split view 打开即脏的根因）
  var _globalRefreshLock = false;
  var _modelRefs = {};      // model.id → 引用计数（split view 共享 model，归零才 dispose）

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
    try {
      const monaco = await loadMonaco();
      if (window.qqqideTheme) { window.qqqideTheme.defineMonacoThemes(monaco); }
      hookThemeSync(monaco);
      // configureMonacoTypescript(monaco); // LSP OFF
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

      // Set as primary editor if first one
      if (!_monacoRef) _monacoRef = monaco;
      if (!_editorRef) _editorRef = ed;
      // ★ 标记文件路径（供 anchor-map 等子系统使用 — URI 在 Windows 上可能丢盘符）
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

      // ---- Auto-save on editor blur ----
      ed.onDidBlurEditorWidget(async function () {
        if (_paneDirtyMap[filePath] && filePath && !(opts && opts.readOnly)) {
          try {
            var content = ed.getValue();
            await _captureExternalBefore(filePath);
            await bridge.fs.write(filePath, content);
            _markClean();
            _xHookRecord(filePath, content, 'editx');
            _removeDirty(filePath);
            // ★ 2026-08-17: 保存成功 → 清除已删除标记
            if (window.qqqTabs && window.qqqTabs.setTabDeleted) { window.qqqTabs.setTabDeleted(filePath, false); }
            // ★ 更新 mtime
            try { var _stBlur = await bridge.fs.stat(filePath); if (_stBlur) _openedMtime[filePath] = { mtimeMs: _stBlur.mtimeMs, size: _stBlur.size }; } catch (_) {}
          } catch (err) {
            console.error('[editor] auto-save failed:', filePath, err && err.message);
            // ★ 保存失败必须可见：否则脏 tab 星号永久残留，用户误以为文件已保存（正体+星号之谜）
            if (window.qqqideQoast) {
              var _fnBlur = String(filePath).split(/[\\/]/).pop() || filePath;
              window.qqqideQoast.show(_fnBlur + ' \u4FDD\u5B58\u5931\u8D25\uFF1A' + ((err && err.message) || err) + ' \uFF08\u5185\u5BB9\u4FDD\u7559\u5728\u7F16\u8F91\u5668\uFF0C\u53EF\u7528 Ctrl+S \u91CD\u8BD5\uFF09', { duration: 6000, type: 'warn' });
            }
          }
        }
      });

      // ---- Ctrl+S ----
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        try {
          var val = ed.getValue();
          await _captureExternalBefore(filePath);
          await bridge.fs.write(filePath, val);
          _markClean();
          _xHookRecord(filePath, val, 'editx');
          _removeDirty(filePath);
          // ★ 2026-08-17: 保存成功 → 清除已删除标记
          if (window.qqqTabs && window.qqqTabs.setTabDeleted) { window.qqqTabs.setTabDeleted(filePath, false); }
          // ★ 更新 mtime
          try { var _stCtrlS = await bridge.fs.stat(filePath); if (_stCtrlS) _openedMtime[filePath] = { mtimeMs: _stCtrlS.mtimeMs, size: _stCtrlS.size }; } catch (_) {}
        } catch (e) {
          console.error('[editor] save failed:', e);
          if (window.qqqideQoast) {
            var _fnCs = String(filePath).split(/[\\/]/).pop() || filePath;
            window.qqqideQoast.show(_fnCs + ' \u4FDD\u5B58\u5931\u8D25\uFF1A' + ((e && e.message) || e), { duration: 6000, type: 'warn' });
          }
        }
      });

      // q1 v2: anchor-map + p      // q1 v3: 中心视口管线
      attachQ1v3(ed, monaco, filePath);
      // ★ 初始化完成，解除 _isRefreshing 屏蔽（在 attachQ1v3 之后，防止 viewport 管线触发 model 变更事件导致误报 dirty）
      ed._isRefreshing = false;
      _paneEditors[filePath] = ed;
      // ★ 记录 mtime，用于聚焦时检测外部修改
      try { var _stPane = await bridge.fs.stat(filePath); if (_stPane) _openedMtime[filePath] = { mtimeMs: _stPane.mtimeMs, size: _stPane.size }; } catch (_) {}
      ed.onDidDispose(function () {
        // ★ split view：同路径另一编辑器仍存活 → 保留共享 dirty/mtime 状态（防保存后星号残留）
        var _stillOpen = !!(_paneEditors[filePath] && _paneEditors[filePath] !== ed);
        // ★ 条件删除：只删自己的槽位——旧实现无条件 delete，ed1 dispose 会把
        //   同路径存活 ed2 的引用一起删掉（后续 getEditorForFile/resumePaneLayout 全部失效）
        if (_paneEditors[filePath] === ed) delete _paneEditors[filePath];
        delete _paneFiles[host];
        if (!_stillOpen) delete _openedMtime[filePath];
        if (!_stillOpen) delete _paneDirtyMap[filePath];
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


  // ---- refreshLiveContent: update an already-open pane editor with new content (for live chat.txt) ----
  function refreshLiveContent(filePath, content) {
    var ed = _paneEditors[filePath];
    if (!ed) return false;
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

  // 焦点/tab切换：拉脏快照（Layer 2）+ 检测外部修改（stat mtime）
  async function _checkDirtyAndRefreshPane(filePath, ed) {
    if (!filePath || !isElectron || !bridge || !ed) return;
    // 用户正在此编辑器里编辑 → 不覆盖
    try { if (ed.hasTextFocus()) return; } catch (_) {}
    try {
      // Layer 2: 跨窗口脏快照 → 刷新
      if (bridge.dirty) {
        var dirtyContent = await bridge.dirty.get(filePath);
        if (dirtyContent) {
          var m = ed.getModel();
          if (!m || m.isDisposed()) return;
          var cur = ed.getValue();
          if (cur === dirtyContent) return;
          ed._isRefreshing = true;
          _globalRefreshLock = true; window.__qqqGlobalRefreshLock = true;
          if (window.qqqCharUndo) window.qqqCharUndo.suppressOnce(ed);
          try {
            m.applyEdits([{ range: m.getFullModelRange(), text: String(dirtyContent), forceMoveMarkers: true }]);
          } finally { ed._isRefreshing = false; _globalRefreshLock = false; window.__qqqGlobalRefreshLock = false; }
          // ★ 不 dispatch dirty:false — 跨窗口脏快照的内容未落盘，
          //    dispatch false 会让标签星号消失但文件实际未保存（大脑分裂）。
          //    让 _markDirty 自然触发（下次用户操作或 onDidChangeModelContent）。
          return;
        }
      }
      // 无脏快照 → stat 检测外部修改 / 文件已删除
      if (!bridge.fs || !bridge.fs.stat) return;
      var st = await bridge.fs.stat(filePath);
      if (!st || !st.isFile) {
        // ★ 2026-08-17: 文件已被删除 → tab 显示灰色+删除线
        if (window.qqqTabs && window.qqqTabs.setTabDeleted) {
          window.qqqTabs.setTabDeleted(filePath, true);
        }
        delete _openedMtime[filePath];
        return;
      }
      // 文件存在 → 清除已删除标记
      if (window.qqqTabs && window.qqqTabs.setTabDeleted) {
        window.qqqTabs.setTabDeleted(filePath, false);
      }
      var prev = _openedMtime[filePath];
      if (!prev || (prev.mtimeMs === st.mtimeMs && prev.size === st.size)) return;
      // 外部修改了！
      var isDirty = (filePath === currentFile) ? dirty : !!_paneDirtyMap[filePath];
      if (!isDirty) {
        // 编辑器干净 → 静默重载磁盘最新版
        var diskContent = await bridge.fs.read(filePath);
        if (diskContent == null) return;
        var m2 = ed.getModel();
        if (!m2 || m2.isDisposed()) return;
        ed._isRefreshing = true;
        _globalRefreshLock = true;
        if (window.qqqCharUndo) window.qqqCharUndo.suppressOnce(ed);
        try {
          m2.applyEdits([{ range: m2.getFullModelRange(), text: String(diskContent), forceMoveMarkers: true }]);
        } finally { ed._isRefreshing = false; _globalRefreshLock = false; window.__qqqGlobalRefreshLock = false; }
        _openedMtime[filePath] = { mtimeMs: st.mtimeMs, size: st.size };
      } else {
        // 编辑器脏 → 捕获外部版本到 timeline + 通知用户
        _captureExternalBefore(filePath);
        var fname = filePath.split(/[\\/]/).pop();
        if (window.qqqideQoast) {
          window.qqqideQoast.show(
            fname + ' \u5728\u5916\u90e8\u88ab\u4fee\u6539\u4e86\uff0c\u4f60\u7684\u7f16\u8f91\u4fdd\u7559\uff0c\u53ef\u5728diff\u7a97\u53e3\u5ba1\u67e5',
            { duration: 6000 }
          );
        }
      }
    } catch (_) {}
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
    // 主编辑器
    if (currentFile && _editorRef) {
      _checkDirtyAndRefreshPane(currentFile, _editorRef);
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

  // ★ pane 精确取编辑器：paneEl 内挂载实例优先（split view 同路径多编辑器），路径兜底
  function _edForPane(filePath, paneEl) {
    var ed = null;
    if (paneEl && paneEl.querySelector) {
      try {
        var _mount = paneEl.querySelector('[data-editor-mount]');
        if (_mount && _mount._qqqEd) ed = _mount._qqqEd;
      } catch (_) {}
    }
    if (!ed) ed = _paneEditors[filePath];
    return ed || null;
  }

  window.qqqEditor = {
    build,
    open,
    save,
    openInPane,
    getValue() { return editor ? editor.getValue() : ''; },
    isDirty() { return dirty; },
    // ★ 路径级脏查询（tab-manager 预览复用/状态同步用，唯一真理 = _paneDirtyMap）
    isPathDirty: function (filePath) { return !!_paneDirtyMap[filePath]; },
    currentFile() { return currentFile; },
    insertAtCursor(text) { if (editor && editor.insertAtCursor) { editor.insertAtCursor(text); } },
    getMonaco() { return _monacoRef; },
    getEditorInstance() { return _editorRef; },
    // ★ 按文件路径取编辑器实例（搜索跳转/位置还原用）：面板编辑器优先，主编辑器兜底
    getEditorForFile(filePath) {
      var ed = _paneEditors[filePath];
      if (!ed && _editorRef && currentFile === filePath) ed = _editorRef;
      return ed || null;
    },
    refreshLiveContent,
    isBinaryFile,
    isBinaryFileAsync,
    saveMinimapPref: _saveMinimapPref,
    // ★ Tab 切换优化：暂停/恢复 Monaco automaticLayout（避免隐藏编辑器做无意义 layout）
    suspendPaneLayout: function(filePath, paneEl) {
      var ed = _edForPane(filePath, paneEl);
      if (ed) {
        try { ed.updateOptions({ automaticLayout: false }); } catch (_) {}
        if (window.qqqViewportMachine && window.qqqViewportMachine.transition) {
          try { window.qqqViewportMachine.transition('hidden', ed, filePath); } catch (_) {}
        }
      }
    },
    resumePaneLayout: function(filePath, paneEl) {
      var ed = _edForPane(filePath, paneEl);
      if (ed) {
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
      // 主编辑器
      if (_editorRef && currentFile) {
        try {
          var m = _editorRef.getModel();
          if (m && !m.isDisposed()) {
            var p = _editorRef.getPosition();
            if (p) positions[currentFile] = { lineNumber: p.lineNumber, column: p.column };
          }
        } catch (_) {}
      }
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
    // ★ 窗口快照：还原指定文件的光标位置
    setEditorPosition(filePath, pos) {
      var ed = _paneEditors[filePath];
      if (!ed && _editorRef && currentFile === filePath) ed = _editorRef;
      if (!ed) return false;
      try {
        ed.setPosition(pos);
        ed.revealPositionInCenter(pos);
        return true;
      } catch (_) { return false; }
    },
  };
})();
