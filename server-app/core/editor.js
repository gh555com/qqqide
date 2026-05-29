// ============================================================================
// editor.js - Monaco editor wrapper for qqq-shell v2
//
// Loads monaco-editor from qqq-asset://monaco/vs/loader.js (provided by shell)
// and exposes window.qqqEditor:
//   open(file)   - load a file into the active editor
//   save()       - save current editor content via window.qqq.fs.write
//   getValue()   - current text
//
// In browser dev (no shell), exposes a textarea fallback.
// ============================================================================

(function () {
  'use strict';

  const isElectron = !!window.qqqIsElectron;
  const bridge = window.qqqBridge;

  // ── qzlsp §10 Plan A: 配置 TypeScript Worker 编译选项 ──
  // Monaco 内置 TS Worker 默认 moduleResolution=Classic 且无 @types/node，
  // 会导致 Node.js 内置模块飘红(false positive) 和类型检查裸奔(false negative)。
  // 此处注入编译选项 + Node 模块声明，对齐项目 tsconfig.json。
  var _tsConfigured = false;
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
    // 注入 Node.js 内置模块声明，消除 "Cannot find module 'http'" 等误报
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
    if (!window.qqq || !window.qqq.lsp) return false;
    if (MONACO_NATIVE_LANGS.has(langId)) return false;
    return !!LSP_LANG_MAP[langId];
  }

  async function lspOpen(file, langId, text) {
    var bridgeLang = LSP_LANG_MAP[langId];
    if (!bridgeLang) return;
    try {
      var slash = file.replace(/\\/g, '/');
      var rootUri = 'file:///' + slash.substring(0, slash.lastIndexOf('/'));
      await window.qqq.lsp.startLanguage(bridgeLang, rootUri);
      await window.qqq.lsp.openDocument(file, text);
      lspVersion = 1;
      lspLang = bridgeLang;
    } catch (e) {
      console.warn('[editor] LSP open failed for', langId, ':', e && e.message);
    }
  }

  function wireLspDiagnostics() {
    if (!window.qqq || !window.qqq.lsp) return;
    window.qqq.lsp.onDiagnostics(function (msg) {
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
    if (!window.qqq || !window.qqq.lsp) return;
    var monaco = window.monaco;
    if (!monaco) return;
    for (var langId in LSP_LANG_MAP) {
      var bridgeLang = LSP_LANG_MAP[langId];
      monaco.languages.registerHoverProvider(langId, {
        provideHover: async function (model, position) {
          if (!currentFile || lspLang !== bridgeLang) return null;
          try {
            var result = await window.qqq.lsp.hover(
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
  function loadMonaco() {
    return new Promise((resolve, reject) => {
      if (window.monaco) { return resolve(window.monaco); }

      // Configure AMD loader paths
      const baseUrl = isElectron ? 'qqq-asset://monaco/vs' : null;
      if (!baseUrl) { return reject(new Error('monaco unavailable in browser dev')); }

      // Load loader.js
      const s = document.createElement('script');
      s.src = baseUrl + '/loader.js';
      s.onload = () => {
        try {
          // configure require
          // eslint-disable-next-line no-undef
          require.config({ paths: { vs: baseUrl } });
          // monaco workers: load via importScripts from blob worker
          // to bypass custom-protocol Worker() restrictions in Electron
          var _langWorker = {
            typescript: 'tsWorker', javascript: 'tsWorker',
            json: 'jsonWorker', html: 'htmlWorker', css: 'cssWorker',
          };
          window.MonacoEnvironment = {
            getWorker: function (workerId, label) {
              var workerUrl;
              if (label && _langWorker[label]) {
                workerUrl = baseUrl + '/language/' + label + '/' + _langWorker[label] + '.js';
              } else {
                // generic editor worker: vs/base/worker/workerMain.js (min build)
                workerUrl = baseUrl + '/base/worker/workerMain.js';
              }
              var boot = [
                'importScripts("' + baseUrl + '/loader.js");',
                'require.config({ paths: { vs: "' + baseUrl + '" } });',
                '(function(){ var d=self.define; self.define=undefined;',
                '  var m=self.module; self.module=undefined;',
                '  importScripts("' + workerUrl + '");',
                '  self.define=d; self.module=m; })();',
              ].join('\n');
              var blob = new Blob([boot], { type: 'application/javascript' });
              return new Worker(URL.createObjectURL(blob));
            },
          };
          // eslint-disable-next-line no-undef
          require(['vs/editor/editor.main'], () => {
            resolve(window.monaco);
          }, reject);
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('failed to load monaco loader.js'));
      document.head.appendChild(s);
    });
  }

  // ---------------- Editor build ----------------
  async function build(host) {
    mountEl = host;
    try {
      const monaco = await loadMonaco();
      // 注册唯一真理配色机器的 Monaco 主题
      if (window.qqqTheme) { window.qqqTheme.defineMonacoThemes(monaco); }

      // 配置 Monaco TypeScript Worker（全局单例，幂等）
      configureMonacoTypescript(monaco);

      const theme = (window.qqqTheme && window.qqqTheme.getMonacoTheme()) || 'vs';
      const ed = monaco.editor.create(host, {
        value: '',
        language: 'plaintext',
        theme: theme,
        automaticLayout: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, Consolas, Menlo, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        wordWrap: 'off',
        tabSize: 4,
      });
      _monacoRef = monaco;
      _editorRef = ed;
      // 主题切换时同步 Monaco
      if (window.qqqTheme) {
        window.qqqTheme.onChange(function (dark) {
          monaco.editor.setTheme(dark ? 'solarized-dark' : 'solarized-light');
        });
      }

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
            window.qqq.lsp.changeDocument(currentFile, changes, version);
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
      // q1 三件套 attach (no-op if module not yet loaded; will retry)
      attachQ1(ed);
      // Wire LSP diagnostics and hover
      wireLspDiagnostics();
      wireLspHover();
      editor = {
        isFallback: false,
        setValue(v, lang) {
          const model = ed.getModel();
          if (model && lang) { monaco.editor.setModelLanguage(model, lang); }
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
        try { window.qqq.lsp.closeDocument(currentFile); } catch (e) { /* ignore */ }
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

  async function save() {
    if (!editor || !currentFile) { return false; }
    const v = editor.getValue();
    try {
      await bridge.fs.write(currentFile, v);
      dirty = false; updateTitle();
      return true;
    } catch (e) {
      console.error('[editor] save failed:', e);
      return false;
    }
  }

  function updateTitle() {
    const name = currentFile ? currentFile.split(/[\\/]/).pop() : '(no file)';
    const txt = (dirty ? '* ' : '') + name;
    const $brand = document.querySelector('.qqq-toolbar-brand');
    if ($brand) { $brand.textContent = 'qqq · ' + txt; }
  }

  let _monacoRef = null;   // raw monaco namespace
  let _editorRef = null;   // raw monaco IStandaloneCodeEditor

  // ---- openInPane: create a Monaco editor inside a tab pane for a specific file ----
  async function openInPane(host, filePath, content) {
    try {
      const monaco = await loadMonaco();
      if (window.qqqTheme) { window.qqqTheme.defineMonacoThemes(monaco); }
      configureMonacoTypescript(monaco);
      const lang = langOf(filePath);
      const ed = monaco.editor.create(host, {
        value: content == null ? '' : String(content),
        language: lang,
        theme: (window.qqqTheme && window.qqqTheme.getMonacoTheme()) || 'vs',
        automaticLayout: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, Consolas, Menlo, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        wordWrap: 'off',
        tabSize: 4,
      });

      // Set as primary editor if first one
      if (!_monacoRef) _monacoRef = monaco;
      if (!_editorRef) _editorRef = ed;

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

      ed.onDidChangeModelContent(() => { _markDirty(); });

      // ---- Auto-save on editor blur ----
      ed.onDidBlurEditorWidget(async () => {
        if (_paneDirty && filePath) {
          try {
            await bridge.fs.write(filePath, ed.getValue());
            _markClean();
            console.log('[editor] auto-saved on blur:', filePath);
          } catch (err) {
            console.error('[editor] auto-save failed:', filePath, err && err.message);
          }
        }
      });

      // ---- Ctrl+S ----
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
        try {
          var val = ed.getValue(); console.log('[editor] saving: ' + filePath + ' (' + val.length + ' chars)'); await bridge.fs.write(filePath, val);
          _markClean();
          console.log('[editor] saved:', filePath);
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
  };
})();
