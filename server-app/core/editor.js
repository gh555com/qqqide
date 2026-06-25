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

  // ---- q1 三件套 + viewzone attach: hook all four modules onto one editor.
  // Each module's attach() is idempotent and safe to call multiple times
  // (codelens provider de-duped, paste/decoration/viewzone per-editor).
  function attachQ1(ed, currentFileFn) {
    if (!ed) return;
    const _done = {}; // avoid re-attach
    const tryAttach = (mod, name) => {
      if (_done[name]) return true;
      if (!mod || typeof mod.attach !== 'function') return false;
      try {
        mod.attach(ed, currentFileFn ? { currentFile: currentFileFn, getCurrentFile: currentFileFn } : undefined);
        _done[name] = true;
        return true;
      } catch (e) {
        console.warn('[editor] q1.' + name + ' attach failed:', e && e.message);
        return false;
      }
    };
    let attempts = 0;
    const tick = () => {
      const okCL = tryAttach(window.qqqCodeLens, 'codelens');
      const okDC = tryAttach(window.qqqDecoration, 'decoration');
      const okPA = tryAttach(window.qqqPaste, 'paste');
      const okVZ = tryAttach(window.qqqViewZone, 'viewzone');
      if (okCL && okDC && okPA && okVZ) return;
      if (++attempts > 30) {
        console.warn('[editor] q1 attach: gave up after ' + attempts + ' tries; cl=' + okCL + ' dc=' + okDC + ' pa=' + okPA + ' vz=' + okVZ);
        return;
      }
      setTimeout(tick, 200);
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

  function isBinaryFile(filePath) {
    if (!filePath) return false;
    var lower = String(filePath).toLowerCase();
    var dot = lower.lastIndexOf(String.fromCharCode(46));
    if (dot < 0) return false;
    return BINARY_EXTS.has(lower.slice(dot));
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

  // ---------------- Editor build ----------------
  async function build(host) {
    mountEl = host;
    try {
      const monaco = await loadMonaco();
      // 注册唯一真理配色机器的 Monaco 主题
      if (window.qqqideTheme) { window.qqqideTheme.defineMonacoThemes(monaco); }

      // configureMonacoTypescript(monaco); // LSP OFF

      const theme = (window.qqqideTheme && window.qqqideTheme.getMonacoTheme()) || 'vs';
      const ed = monaco.editor.create(host, {
        value: '',
        language: 'plaintext',
        theme: theme,
        automaticLayout: true,
        fontSize: _editorFontSize,
        fontFamily: 'ui-monospace, Consolas, Menlo, monospace',
        // ═══ LSP OFF: strip all smart features ═══
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'none',
        overviewRulerLanes: 3,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        wordWrap: 'on',
        wrappingStrategy: 'advanced',
        tabSize: 4,
        breadcrumbs: { enabled: false },
        smoothScrolling: false,
        cursorBlinking: 'solid',
        cursorSmoothCaretAnimation: 'off',
        cursorSurroundingLines: 0,
        glyphMargin: false,
        lineDecorationsWidth: 0,
        renderLineHighlight: 'none',
        renderLineHighlightOnlyWhenFocus: true,
        occurrencesHighlight: true,
        selectionHighlight: true,
        matchBrackets: 'never',
        bracketPairColorization: { enabled: false },
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
        folding: false,
        guides: { indentation: false, bracketPairs: false, bracketPairsHorizontal: false, highlightActiveIndentation: false },
        renderIndentGuides: false,
        renderControlCharacters: false,
        unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false },
        dragAndDrop: false,
        selectionClipboard: false,
        emptySelectionClipboard: false,
        contextmenu: false,
        rulers: [],
        roundedSelection: false,
        lineNumbersMinChars: 2,
        lineDecorationsWidth: 10,
        padding: { top: 0, bottom: 20 },
        stickyScroll: { enabled: false },
        find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never', seedSearchStringFromSelection: 'never' },
      });
      _monacoRef = monaco;
      _editorRef = ed;
      // 底部留空隙，防状态栏遮挡末行
      if (host && host.style) { host.style.paddingBottom = '24px'; }
      // 唯一真理逐字回退机器：按设置决定是否挂载
      _applyUndoMode(ed, monaco);
      // ── 面包屑导航条（空编辑器：仅工具按钮）──
      if (window.qqqEditorBreadcrumb && window.qqqEditorBreadcrumb.create) {
        window.qqqEditorBreadcrumb.create(host, '', ed, monaco);
      }
      // 主题切换时同步 Monaco（全局注册一次）
      hookThemeSync(monaco);

      // Ctrl+S
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
      ed.onDidChangeModelContent(function (e) {
        dirty = true; updateTitle();
        // dispatch for tab-manager if currentFile is set
        if (currentFile) {
          document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: currentFile, dirty: true } }));
        }
        // LSP OFF — no LSP change notifications
        if (!lspLang || !currentFile) return;
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
      // q1 三件套 attach (no-op if module not yet loaded; will retry)
      attachQ1(ed);
      // Wire LSP diagnostics and hover — LSP OFF
      // wireLspDiagnostics(); // LSP OFF
      // wireLspHover(); // LSP OFF
      // 编辑器销毁时清理 char-undo 和跟踪列表
      ed.onDidDispose(function () {
        if (window.qqqCharUndo) window.qqqCharUndo.detach(ed);
        var idx = _allMonacoEditors.indexOf(ed);
        if (idx >= 0) _allMonacoEditors.splice(idx, 1);
      });
      editor = {
        isFallback: false,
        setValue(v, lang) {
          const model = ed.getModel();
          if (model && lang) { monaco.editor.setModelLanguage(model, lang); }
          if (window.qqqCharUndo) window.qqqCharUndo.suppressOnce(ed);
          ed.setValue(v == null ? '' : String(v));
          dirty = false; updateTitle();
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
      if (isBinaryFile(file)) {
        if (window.qqqideQoast) window.qqqideQoast.show(String.fromCharCode(10060, 32, 20108, 36827, 21046, 25991, 20214, 65292, 26080, 27861, 22312, 32534, 36753, 22120, 20013, 25171, 24320), { duration: 4000 });
        return;
      }
      const text = await bridge.fs.read(file);
      currentFile = file;
      editor.setValue(text, langOf(file));
      dirty = false;
      lspLang = null; // LSP OFF
      updateTitle();
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
      await bridge.fs.write(currentFile, v);
      dirty = false; updateTitle();

      // ★ 触发 timeline 快照（冷却+去重在主进程真理机）
      _maybeRecordTimeline(currentFile, v);

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

  // ---- openInPane: create a Monaco editor inside a tab pane for a specific file ----
  async function openInPane(host, filePath, content, opts) {
    try {
      const monaco = await loadMonaco();
      if (window.qqqideTheme) { window.qqqideTheme.defineMonacoThemes(monaco); }
      hookThemeSync(monaco);
      // configureMonacoTypescript(monaco); // LSP OFF
      const lang = langOf(filePath);
      if (isBinaryFile(filePath)) {
        if (window.qqqideQoast) window.qqqideQoast.show(String.fromCharCode(10060, 32, 20108, 36827, 21046, 25991, 20214, 65292, 26080, 27861, 22312, 32534, 36753, 22120, 20013, 25171, 24320), { duration: 4000 });
        return null;
      }

      // Use plain file path as URI so Monaco's TS worker can resolve it.
      var plainPath = filePath.replace(/\\/g, '/');
      var fileUri = monaco.Uri.parse(plainPath);
      var model = monaco.editor.getModel(fileUri);
      if (!model) {
        model = monaco.editor.createModel(content == null ? '' : String(content), lang, fileUri);
      } else {
        // Reuse existing model: update language + content
        monaco.editor.setModelLanguage(model, lang);
        model.setValue(content == null ? '' : String(content));
      }

      const ed = monaco.editor.create(host, {
        model: model,
        theme: (window.qqqideTheme && window.qqqideTheme.getMonacoTheme()) || 'vs',
        automaticLayout: true,
        readOnly: (opts && opts.readOnly) || false,
        fontSize: _editorFontSize,
        fontFamily: 'ui-monospace, Consolas, Menlo, monospace',
        // ═══ LSP OFF: strip all smart features ═══
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'none',
        overviewRulerLanes: 3,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        wordWrap: 'on',
        wrappingStrategy: 'advanced',
        tabSize: 4,
        breadcrumbs: { enabled: false },
        smoothScrolling: false,
        cursorBlinking: 'solid',
        cursorSmoothCaretAnimation: 'off',
        cursorSurroundingLines: 0,
        glyphMargin: false,
        lineDecorationsWidth: 0,
        renderLineHighlight: 'none',
        renderLineHighlightOnlyWhenFocus: true,
        occurrencesHighlight: true,
        selectionHighlight: true,
        matchBrackets: 'never',
        bracketPairColorization: { enabled: false },
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
        folding: false,
        guides: { indentation: false, bracketPairs: false, bracketPairsHorizontal: false, highlightActiveIndentation: false },
        renderIndentGuides: false,
        renderControlCharacters: false,
        unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false },
        dragAndDrop: false,
        selectionClipboard: false,
        emptySelectionClipboard: false,
        contextmenu: false,
        rulers: [],
        roundedSelection: false,
        lineNumbersMinChars: 2,
        lineDecorationsWidth: 10,
        padding: { top: 0, bottom: 20 },
        stickyScroll: { enabled: false },
        find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never', seedSearchStringFromSelection: 'never' },
      });

      // Set as primary editor if first one
      if (!_monacoRef) _monacoRef = monaco;
      if (!_editorRef) _editorRef = ed;
      // 底部留空隙，防状态栏遮挡末行
      if (host && host.style) { host.style.paddingBottom = '24px'; }
      // 唯一真理逐字回退机器：按设置决定是否挂载
      _applyUndoMode(ed, monaco);

      // ── 面包屑导航条 ──
      if (window.qqqEditorBreadcrumb && window.qqqEditorBreadcrumb.create) {
        window.qqqEditorBreadcrumb.create(host, filePath, ed, monaco);
      }

      // ---- Dirty state tracking per pane ----
      let _paneDirty = false;

      function _markDirty() {
        if (!_paneDirty) { _paneDirty = true; _dispatchDirty(true); }
      }
      function _markClean() {
        if (_paneDirty) { _paneDirty = false; _dispatchDirty(false); }
      }
      function _dispatchDirty(d) {
        document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: filePath, dirty: d } }));
      }

      ed.onDidChangeModelContent(function () { if (!ed._isRefreshing) _markDirty(); });

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
        if (_paneDirty && filePath && !(opts && opts.readOnly)) {
          try {
            var content = ed.getValue();
            await bridge.fs.write(filePath, content);
            _markClean();
            _xHookRecord(filePath, content, 'editx');
          } catch (err) {
            console.error('[editor] auto-save failed:', filePath, err && err.message);
          }
        }
      });

      // ---- Ctrl+S ----
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        try {
          var val = ed.getValue();
          await bridge.fs.write(filePath, val);
          _markClean();
          _xHookRecord(filePath, val, 'editx');
        } catch (e) {
          console.error('[editor] save failed:', e);
        }
      });

      // When this editor gains focus, update refs
      ed.onDidFocusEditorWidget(() => {
        _editorRef = ed;
        currentFile = filePath;
      });

      // q1 三件套 attach for this pane editor
      attachQ1(ed, () => filePath);

      // track pane editor for live refresh (chat.txt etc.)
      _paneEditors[filePath] = ed;
      _paneFiles[host] = filePath;
      ed.onDidDispose(function () {
        delete _paneEditors[filePath];
        delete _paneFiles[host];
        if (window.qqqCharUndo) window.qqqCharUndo.detach(ed);
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
      if (window.qqqCharUndo) window.qqqCharUndo.suppressOnce(ed);
      ed.setValue(content == null ? '' : String(content));
      ed._isRefreshing = false;
      return true;
    } catch (e) {
      console.warn('[editor] refreshLiveContent failed:', e && e.message);
      ed._isRefreshing = false;
      return false;
    }
  }

  window.qqqEditor = {
    build,
    open,
    save,
    openInPane,
    getValue() { return editor ? editor.getValue() : ''; },
    isDirty() { return dirty; },
    currentFile() { return currentFile; },
    insertAtCursor(text) { if (editor && editor.insertAtCursor) { editor.insertAtCursor(text); } },
    getMonaco() { return _monacoRef; },
    getEditorInstance() { return _editorRef; },
    refreshLiveContent,
    isBinaryFile,
  };
})();
