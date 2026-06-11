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

  // ── qzlsp §10 Plan A: 配置 TypeScript Worker 编译选项 ──
  // Monaco 内置 TS Worker 默认 moduleResolution=Classic 且无 @types/node�?  // 会导�?Node.js 内置模块飘红(false positive) 和类型检查裸�?false negative)�?  // 此处注入编译选项 + Node 模块声明，对齐项�?tsconfig.json�?  var _tsConfigured = false;
  function configureMonacoTypescript(monaco) {
    if (_tsConfigured) return;
    _tsConfigured = true;
    var _tsDefaults = monaco.languages.typescript.typescriptDefaults;
    _tsDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      noImplicitAny: false,
      lib: ['ES2020', 'DOM'],
    });
    // 注入 Node.js 内置模块声明，消�?"Cannot find module 'http'" 等误�?
    _tsDefaults.addExtraLib(
      'declare module "http" { const m: any; export = m; }\n' +
      'declare module "https" { const m: any; export = m; }\n' +
      'declare module "fs" { const m: any; export = m; }\n' +
      'declare module "path" { const m: any; export = m; }\n' +
      'declare module "crypto" { const m: any; export = m; }\n' +
      'declare module "url" { const m: any; export = m; }\n' +
      'declare module "stream" { const m: any; export = m; }\n' +
      'declare module "events" { const m: any; export = m; }\n' +
      'declare module "child_process" { const m: any; export = m; }\n' +
      'declare module "net" { const m: any; export = m; }\n' +
      'declare module "electron" { const m: any; export = m; }\n',
      'ts:node-builtins.d.ts'
    );
  }

  // ---- q1 三件�?+ viewzone attach: hook all four modules onto one editor.
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

  let editor = null;             // monaco editor instance
  let currentFile = null;        // current open file path
  let dirty = false;             // unsaved changes flag
  let mountEl = null;            // <div> we mount into
  let lspVersion = 0;            // LSP document version counter
  let lspLang = null;            // current LSP language (null = Monaco native)
  let lspDebounce = null;        // 150ms debounce timer for LSP changeDocument
  var LSP_DEBOUNCE_MS = 150;

  var MONACO_NATIVE_LANGS = new Set([
    'typescript', 'typescriptreact', 'javascript', 'javascriptreact',
    'json', 'html', 'css', 'scss', 'less'
  ]);

  var LSP_LANG_MAP = {
    'python': 'python', 'go': 'go', 'rust': 'rust',
    'c': 'c', 'cpp': 'cpp',
    'java': 'java', 'ruby': 'ruby', 'php': 'php',
    'swift': 'swift', 'kotlin': 'kotlin', 'dart': 'dart', 'lua': 'lua',
    'r': 'r', 'sql': 'sql',
  };

  function needsLsp(langId) {
    if (!window.qqqideBridge || !window.qqqideBridge.lsp) return false;
    if (MONACO_NATIVE_LANGS.has(langId)) return false;
    return !!LSP_LANG_MAP[langId];
  }

  async function lspOpen(file, langId, text) {
    var bridgeLang = LSP_LANG_MAP[langId];
    if (!bridgeLang) return;
    try {
      var slash = file.replace(/\\/g, '/');
      var rootUri = 'file:///' + slash.substring(0, slash.lastIndexOf('/'));
      await window.qqqideBridge.lsp.startLanguage(bridgeLang, rootUri);
      await window.qqqideBridge.lsp.openDocument(file, text);
      lspVersion = 1;
      lspLang = bridgeLang;
    } catch (e) {
      console.warn('[editor] LSP open failed for', langId, ':', e && e.message);
    }
  }

  function wireLspDiagnostics() {
    if (!window.qqqideBridge || !window.qqqideBridge.lsp) return;
    window.qqqideBridge.lsp.onDiagnostics(function (msg) {
      if (!msg || !msg.uri) return;
      var filePath = msg.uri.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
      if (currentFile !== filePath) return;
      var monaco = window.monaco;
      if (!monaco || !monaco.editor || !editor || editor.isFallback) return;
      var model = monaco.editor.getModel(
        monaco.Uri.parse(msg.uri)
      );
      if (!model) {
        if (editor && editor.getModel) model = editor.getModel();
        if (!model) return;
      }
      var markers = (msg.diagnostics || []).map(function (d) {
        var severity = monaco.MarkerSeverity.Error;
        if (d.severity === 2) severity = monaco.MarkerSeverity.Warning;
        else if (d.severity === 3) severity = monaco.MarkerSeverity.Info;
        else if (d.severity === 4) severity = monaco.MarkerSeverity.Hint;
        return {
          severity: severity,
          message: d.message || '',
          startLineNumber: (d.range && d.range.start ? d.range.start.line : 0) + 1,
          startColumn: (d.range && d.range.start ? d.range.start.character : 0) + 1,
          endLineNumber: (d.range && d.range.end ? d.range.end.line : 0) + 1,
          endColumn: (d.range && d.range.end ? d.range.end.character : 0) + 1,
          source: 'qzlsp',
        };
      });
      monaco.editor.setModelMarkers(model, 'lsp', markers);
    });
  }

  function wireLspHover() {
    if (!window.qqqideBridge || !window.qqqideBridge.lsp) return;
    var monaco = window.monaco;
    if (!monaco) return;
    for (var langId in LSP_LANG_MAP) {
      var bridgeLang = LSP_LANG_MAP[langId];
      monaco.languages.registerHoverProvider(langId, {
        provideHover: async function (model, position) {
          if (!currentFile || lspLang !== bridgeLang) return null;
          try {
            var result = await window.qqqideBridge.lsp.hover(
              currentFile, position.lineNumber - 1, position.column - 1
            );
            if (!result || !result.contents) return null;
            var contents = Array.isArray(result.contents) ? result.contents : [result.contents];
            return {
              range: result.range ? {
                startLineNumber: result.range.start.line + 1,
                startColumn: result.range.start.character + 1,
                endLineNumber: result.range.end.line + 1,
                endColumn: result.range.end.character + 1,
              } : undefined,
              contents: contents.map(function (c) {
                if (typeof c === 'string') return { value: c };
                if (c.language) return { value: '```' + c.language + '\n' + c.value + '\n```' };
                if (c.value) return c;
                return { value: String(c) };
              }),
            };
          } catch (e) {
            return null;
          }
        }
      });
    }
  }


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
          // TS/JS: Monaco's built-in TS worker will fail (known Electron bug),
          // but failing fast is better than a dummy worker that hangs.
          // Our custom ts-service.js handles TS/JS IntelliSense independently.
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

            // Keep Monaco's built-in TS diagnostics enabled.
            // The plain-path URI fix (in openInPane) should let the TS worker
            // find source files properly in Electron.
            // If this works, we don't need the custom ts-service fallback.

            // ── Bootstrap custom TS/JS IntelliSense (fallback, optional) ──
            // Disabled for now �?using Monaco's built-in TS with plain-path URIs.
            // bootCustomTsService(monaco);

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
  // Called ONCE from the Monaco load callback �?guaranteed to run regardless
  // of whether build() or openInPane() is used.
  var _tsBootDone = false;

  function bootCustomTsService(monaco) {
    if (_tsBootDone) return;
    _tsBootDone = true;

    var tsService = window.qqqTsService;
    if (!tsService) {
      console.warn('[editor] qqqTsService not available, TS features disabled');
      return;
    }

    // ── Hover Provider ──
    var hoverProvider = {
      provideHover: function (model, position) {
        if (!tsService.isReady()) return null;
        return tsService.getHover(model, position);
      },
    };
    monaco.languages.registerHoverProvider('typescript', hoverProvider);
    monaco.languages.registerHoverProvider('javascript', hoverProvider);
    monaco.languages.registerHoverProvider('typescriptreact', hoverProvider);
    monaco.languages.registerHoverProvider('javascriptreact', hoverProvider);

    // ── Completion Provider ──
    var tsTriggerChars = ['.', '"', "'", '`', '/', '@', '<', '#', ' '];
    var completionProvider = {
      triggerCharacters: tsTriggerChars,
      provideCompletionItems: function (model, position) {
        if (!tsService.isReady()) return { suggestions: [] };
        var items = tsService.getCompletions(model, position);
        return { suggestions: items };
      },
    };
    monaco.languages.registerCompletionItemProvider('typescript', completionProvider);
    monaco.languages.registerCompletionItemProvider('javascript', completionProvider);
    monaco.languages.registerCompletionItemProvider('typescriptreact', completionProvider);
    monaco.languages.registerCompletionItemProvider('javascriptreact', completionProvider);

    // ── Diagnostics ──
    var _diagTimers = {};

    function updateDiagnostics(model) {
      if (!model || !tsService || !tsService.isReady()) return;
      var lang = model.getLanguageId();
      if (lang !== 'typescript' && lang !== 'javascript' &&
        lang !== 'typescriptreact' && lang !== 'javascriptreact') return;
      try {
        var diags = tsService.getDiagnostics(model);
        monaco.editor.setModelMarkers(model, 'ts-service', diags);
      } catch (e) {
        console.warn('[editor] ts diagnostics update failed:', e && e.message);
      }
    }

    function scheduleDiagnostics(model) {
      var uri = model.uri.toString();
      if (_diagTimers[uri]) clearTimeout(_diagTimers[uri]);
      _diagTimers[uri] = setTimeout(function () {
        delete _diagTimers[uri];
        updateDiagnostics(model);
      }, 300);
    }

    monaco.editor.onDidCreateModel(function (model) {
      scheduleDiagnostics(model);
      model.onDidChangeContent(function () { scheduleDiagnostics(model); });
      model.onWillDispose(function () {
        var u = model.uri.toString();
        if (_diagTimers[u]) { clearTimeout(_diagTimers[u]); delete _diagTimers[u]; }
      });
    });

    var existingModels = monaco.editor.getModels();
    for (var i = 0; i < existingModels.length; i++) {
      (function (model) {
        scheduleDiagnostics(model);
        model.onDidChangeContent(function () { scheduleDiagnostics(model); });
        model.onWillDispose(function () {
          var u = model.uri.toString();
          if (_diagTimers[u]) { clearTimeout(_diagTimers[u]); delete _diagTimers[u]; }
        });
      })(existingModels[i]);
    }

    // ── Start loading TypeScript (async) ──
    tsService.init(function () {
      if (tsService.isReady()) {
        // [silent] editor ts-service ready
        var allModels = monaco.editor.getModels();
        for (var j = 0; j < allModels.length; j++) {
          var m = allModels[j];
          var lang = m.getLanguageId();
          if (lang === 'typescript' || lang === 'javascript' ||
            lang === 'typescriptreact' || lang === 'javascriptreact') {
            scheduleDiagnostics(m);
          }
        }
      }
    });

    // [silent] editor TS/JS providers registered
  }

  // ── 撤销模式：按设置决定是否挂载逐字回退 ──
  var _undoModeUnsub = null;
  var _allMonacoEditors = []; // 跟踪所有编辑器实例

  function _applyUndoMode(ed, monaco) {
    if (!ed || !monaco) return;
    // 登记编辑�?
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

  // ---------------- Editor build ----------------
  async function build(host) {
    mountEl = host;
    try {
      const monaco = await loadMonaco();
      // 注册唯一真理配色机器�?Monaco 主题
      if (window.qqqideTheme) { window.qqqideTheme.defineMonacoThemes(monaco); }

      // 配置 Monaco TypeScript 编译选项（会同步�?ts-service�?
      configureMonacoTypescript(monaco);

      const theme = (window.qqqideTheme && window.qqqideTheme.getMonacoTheme()) || 'vs';
      const ed = monaco.editor.create(host, {
        value: '',
        language: 'plaintext',
        theme: theme,
        automaticLayout: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, Consolas, Menlo, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: 5,
        renderWhitespace: 'selection',
        overviewRulerLanes: 3,
        wordWrap: 'on',
        wrappingStrategy: 'advanced',
        tabSize: 4,
        breadcrumbs: { enabled: true },
      });
      _monacoRef = monaco;
      _editorRef = ed;
      // 唯一真理逐字回退机器：按设置决定是否挂载
      _applyUndoMode(ed, monaco);
      // ── 面包屑导航条（空编辑器：仅工具按钮）──
      if (window.qqqEditorBreadcrumb && window.qqqEditorBreadcrumb.create) {
        window.qqqEditorBreadcrumb.create(host, '', ed, monaco);
      }
      // 主题切换时同�?Monaco（全局注册一次）
      hookThemeSync(monaco);

      // Ctrl+S
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
      ed.onDidChangeModelContent(function (e) {
        dirty = true; updateTitle();
        // dispatch for tab-manager if currentFile is set
        if (currentFile) {
          document.dispatchEvent(new CustomEvent('qqq-tab-dirty', { detail: { path: currentFile, dirty: true } }));
        }
        if (!lspLang || !currentFile) return;
        lspVersion++;
        var version = lspVersion;
        var changes = [];
        for (var i = 0; i < e.changes.length; i++) {
          var ch = e.changes[i];
          var item = { text: ch.text };
          if (ch.range) {
            item.range = {
              start: { line: ch.range.startLineNumber - 1, character: ch.range.startColumn - 1 },
              end: { line: ch.range.endLineNumber - 1, character: ch.range.endColumn - 1 }
            };
          }
          changes.push(item);
        }
        if (lspDebounce) clearTimeout(lspDebounce);
        lspDebounce = setTimeout(function () {
          lspDebounce = null;
          try {
            window.qqqideBridge.lsp.changeDocument(currentFile, changes, version);
          } catch (ex) {
            console.warn('[editor] LSP changeDocument failed:', ex && ex.message);
          }
        }, LSP_DEBOUNCE_MS);
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
      // q1 三件�?attach (no-op if module not yet loaded; will retry)
      attachQ1(ed);
      // Wire LSP diagnostics and hover
      wireLspDiagnostics();
      wireLspHover();
      // 编辑器销毁时清理 char-undo 和跟踪列�?
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
      const text = await bridge.fs.read(file);
      // Close previous LSP document
      if (lspLang && currentFile) {
        try { window.qqqideBridge.lsp.closeDocument(currentFile); } catch (e) { /* ignore */ }
      }
      currentFile = file;
      editor.setValue(text, langOf(file));
      dirty = false;
      // Open LSP for new file if needed
      var lid = langOf(file);
      if (needsLsp(lid)) {
        lspOpen(file, lid, text);
      } else {
        lspLang = null;
      }
      updateTitle();
    } catch (e) {
      console.error('[editor] open failed:', e);
      editor.setValue('// failed to open: ' + (e && e.message), 'plaintext');
    }
  }

  // ---- Timeline 快照：编辑器保存触发（60s 闸门 + 内容去重） ----
  var _lastSaveSnapshotTs = {}; // filePath → 上次快照时间戳
  var _lastSaveSnapshotHash = {}; // filePath → 上次快照内容的简化 hash（避免 SHA256 大文件开销）

  async function save() {
    if (!editor || !currentFile) { return false; }
    const v = editor.getValue();
    try {
      await bridge.fs.write(currentFile, v);
      dirty = false; updateTitle();

      // ★ 触发 timeline 快照（60s 闸门 + 内容变更检测）
      _maybeRecordTimeline(currentFile, v);

      return true;
    } catch (e) {
      console.error('[editor] save failed:', e);
      return false;
    }
  }

  async function _maybeRecordTimeline(filePath, content) {
    if (!bridge || !bridge.timeline) return;
    var now = Date.now();
    var lastTs = _lastSaveSnapshotTs[filePath] || 0;
    // 60秒闸门
    if (now - lastTs < 60000) return;
    // 内容变更检测：用前256字符的简单 hash 做快速去重
    var quickHash = content.length + ':' + content.slice(0, 256);
    if (_lastSaveSnapshotHash[filePath] === quickHash) return;
    _lastSaveSnapshotTs[filePath] = now;
    _lastSaveSnapshotHash[filePath] = quickHash;
    // 获取 projectRoot
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
        source: 'editor-save'
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
  let _paneFiles = {};      // editor dom node �?filePath (reverse lookup for dispose cleanup)
  let _paneEditors = {};    // filePath �?editor instance (for live refresh)

  // ---- openInPane: create a Monaco editor inside a tab pane for a specific file ----
  async function openInPane(host, filePath, content, opts) {
    try {
      const monaco = await loadMonaco();
      if (window.qqqideTheme) { window.qqqideTheme.defineMonacoThemes(monaco); }
      hookThemeSync(monaco);
      configureMonacoTypescript(monaco);
      const lang = langOf(filePath);

      // Use plain file path as URI so Monaco's TS worker can resolve it.
      // inmemory:// URIs cause "Could not find source file" in Electron.
      // file:// scheme also fails because TS path normalization strips it.
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
        fontSize: 13,
        fontFamily: 'ui-monospace, Consolas, Menlo, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: 5,
        renderWhitespace: 'selection',
        overviewRulerLanes: 3,
        wordWrap: 'on',
        wrappingStrategy: 'advanced',
        tabSize: 4,
        breadcrumbs: { enabled: true },
      });

      // Set as primary editor if first one
      if (!_monacoRef) _monacoRef = monaco;
      if (!_editorRef) _editorRef = ed;
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

      // ---- Auto-save on editor blur ----
      ed.onDidBlurEditorWidget(async function () {
        if (_paneDirty && filePath && !(opts && opts.readOnly)) {
          try {
            await bridge.fs.write(filePath, ed.getValue());
            _markClean();
            // [silent] auto-saved on blur
          } catch (err) {
            console.error('[editor] auto-save failed:', filePath, err && err.message);
          }
        }
      });

      // ---- Ctrl+S ----
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        try {
          var val = ed.getValue(); /* silent save */ await bridge.fs.write(filePath, val);
          _markClean();
          // [silent] saved
        } catch (e) {
          console.error('[editor] save failed:', e);
        }
      });

      // When this editor gains focus, update refs
      ed.onDidFocusEditorWidget(() => {
        _editorRef = ed;
        currentFile = filePath;
      });

      // q1 三件�?attach for this pane editor
      attachQ1(ed, () => filePath);

      // track pane editor for live refresh (chat.txt etc.)
      _paneEditors[filePath] = ed;
      _paneFiles[host] = filePath;
      ed.onDidDispose(function () {
        delete _paneEditors[filePath];
        delete _paneFiles[host];
        if (window.qqqCharUndo) window.qqqCharUndo.detach(ed);
        // 从跟踪列表移�?
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
  };
})();
