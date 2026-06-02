// ============================================================================
// ts-service.js — Custom TypeScript Language Service for Monaco Editor
//
// Bypasses Monaco's broken AMD/ESM TS worker (which can't find inmemory://
// source files in Electron) by using the TypeScript compiler directly.
//
// Architecture:
//   ts.createLanguageService() + custom LanguageServiceHost
//   Host reads from Monaco editor models (getValue, getModel, etc.)
//   Providers registered via monaco.languages.registerXxxProvider
//
// Dependencies: window.ts (typescript 5.x, loaded from qqq-asset://ts/typescript.js)
// ============================================================================
(function () {
  'use strict';

  // ── TypeScript loader ──
  var _tsLoadPromise = null;
  var _tsReady = false;

  function loadTypeScript() {
    if (_tsLoadPromise) return _tsLoadPromise;
    if (window.ts) { _tsReady = true; return Promise.resolve(window.ts); }

    _tsLoadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'qqq-asset://ts/typescript.js';
      script.onload = function () {
        if (window.ts) {
          _tsReady = true;
          console.log('[ts-service] TypeScript ' + window.ts.version + ' loaded');
          resolve(window.ts);
        } else {
          reject(new Error('ts not on window after script load'));
        }
      };
      script.onerror = function () {
        reject(new Error('failed to load typescript.js'));
      };
      document.head.appendChild(script);
    });
    return _tsLoadPromise;
  }

  // ── LanguageService state ──
  var _service = null;         // ts.LanguageService
  var _host = null;            // ts.LanguageServiceHost
  var _docVersions = {};       // fileName → version number
  var _compilerOpts = null;    // ts.CompilerOptions

  // Default compiler options (aligned with Monaco defaults in editor.js)
  function getCompilerOpts(ts) {
    if (_compilerOpts) return _compilerOpts;
    _compilerOpts = {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      noImplicitAny: false,
      allowJs: true,
      checkJs: false,
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
    };
    return _compilerOpts;
  }

  // ── File system abstraction (reads from Monaco models) ──
  // Map Monaco URI (inmemory://model/1) or file path to model content.
  function getMonacoModel(fileName) {
    var monaco = window.monaco;
    if (!monaco || !monaco.editor) return null;
    // Try direct URI parse
    try {
      var uri = monaco.Uri.parse(fileName);
      var model = monaco.editor.getModel(uri);
      if (model) return model;
    } catch (e) { /* ignore */ }
    // Try file path as inmemory URI
    var models = monaco.editor.getModels();
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var mUri = m.uri.toString();
      if (mUri === fileName) return m;
      // Match by file path (strip file:// prefix)
      var mPath = mUri.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
      if (mPath === fileName) return m;
      // Match inmemory:// model by path alias
      if (mUri.indexOf(fileName) !== -1) return m;
    }
    return null;
  }

  // Resolve the default TypeScript lib files (lib.es2020.d.ts etc.)
  // We serve them from the same ts resource root.
  function getDefaultLibPath(ts, libName) {
    var base = 'qqq-asset://ts/';
    // libName like 'lib.es2020.d.ts' — already includes 'lib.' prefix
    return base + libName;
  }

  // Cache for fetched lib files
  var _libCache = {};

  function fetchLibFile(url, cb) {
    if (_libCache[url]) return cb(_libCache[url]);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        _libCache[url] = xhr.responseText;
        cb(xhr.responseText);
      } else {
        cb(null);
      }
    };
    xhr.onerror = function () { cb(null); };
    xhr.send();
  }

  // ── Build LanguageServiceHost ──
  function createHost(ts) {
    // Track which files exist (all open Monaco models + lib files)
    var _knownFiles = {};  // fileName → true

    var host = {
      // ── Required ──
      getScriptFileNames: function () {
        var monaco = window.monaco;
        var names = [];
        if (monaco && monaco.editor) {
          var models = monaco.editor.getModels();
          for (var i = 0; i < models.length; i++) {
            var m = models[i];
            var lang = m.getLanguageId();
            // Only include TS/JS files
            if (lang === 'typescript' || lang === 'javascript' ||
                lang === 'typescriptreact' || lang === 'javascriptreact') {
              names.push(m.uri.toString());
              _knownFiles[m.uri.toString()] = true;
            }
          }
        }
        return names;
      },

      getScriptVersion: function (fileName) {
        var v = _docVersions[fileName];
        if (v === undefined) {
          v = 1;
          _docVersions[fileName] = v;
        }
        return String(v);
      },

      getScriptSnapshot: function (fileName) {
        var model = getMonacoModel(fileName);
        if (model) {
          var text = model.getValue();
          return ts.ScriptSnapshot.fromString(text);
        }
        // Check if it's a cached lib file
        var cached = _libCache[fileName];
        if (!cached) {
          // Also try common path variations
          var baseName = fileName.replace(/^.*[\\/]/, '');
          cached = _libCache[baseName] || _libCache['/' + baseName];
        }
        if (cached) {
          return ts.ScriptSnapshot.fromString(cached);
        }
        return undefined;
      },

      getCurrentDirectory: function () {
        return '/';
      },

      getCompilationSettings: function () {
        return getCompilerOpts(ts);
      },

      getDefaultLibFileName: function (opts) {
        // Return the default lib based on target
        var target = opts.target || ts.ScriptTarget.ES2020;
        if (target >= ts.ScriptTarget.ES2020) return 'lib.es2020.full.d.ts';
        if (target >= ts.ScriptTarget.ES2015) return 'lib.es6.d.ts';
        return 'lib.es5.d.ts';
      },

      // ── Module resolution (optional but enables cross-file IntelliSense) ──
      fileExists: function (fileName) {
        if (_knownFiles[fileName]) return true;
        var model = getMonacoModel(fileName);
        if (model) { _knownFiles[fileName] = true; return true; }
        // Check lib cache
        var baseName = fileName.replace(/^.*[\\/]/, '');
        if (_libCache[fileName] || _libCache[baseName] || _libCache['/' + baseName]) {
          _knownFiles[fileName] = true;
          return true;
        }
        return false;
      },

      readFile: function (fileName) {
        var model = getMonacoModel(fileName);
        if (model) return model.getValue();
        // Check lib cache
        var baseName = fileName.replace(/^.*[\\/]/, '');
        return _libCache[fileName] || _libCache[baseName] || _libCache['/' + baseName];
      },

      readDirectory: function () {
        // We don't support directory listing in browser context
        return [];
      },

      // ── Optional: log to console ──
      // log: function (s) { console.log('[ts-host]', s); },
      // trace: function (s) { console.log('[ts-host:trace]', s); },
    };

    return host;
  }

  // ── Lib files: preload default libs so they're available synchronously ──
  function preloadDefaultLibs(ts, callback) {
    var opts = getCompilerOpts(ts);
    var defaultLib = 'lib.es2020.full.d.ts';
    if (opts.lib && opts.lib.length > 0) {
      // Preload the specified libs
      var pending = opts.lib.length;
      var libContents = {};
      opts.lib.forEach(function (libName) {
        var url = 'qqq-asset://ts/' + libName;
        fetchLibFile(url, function (content) {
          if (content) {
            libContents[url] = content;
            // Also register with the host
            _libCache['/' + libName] = content;
            _libCache[libName] = content;
          }
          pending--;
          if (pending <= 0) callback(libContents);
        });
      });
    } else {
      // Load default lib
      var url = 'qqq-asset://ts/' + defaultLib;
      fetchLibFile(url, function (content) {
        if (content) {
          _libCache['/' + defaultLib] = content;
          _libCache[defaultLib] = content;
        }
        callback(_libCache);
      });
    }
  }

  // ── Initialize the language service ──
  function initService(callback) {
    if (_service) return callback(_service);

    loadTypeScript().then(function (ts) {
      // Preload default lib files
      preloadDefaultLibs(ts, function () {
        _host = createHost(ts);
        _service = ts.createLanguageService(_host);
        console.log('[ts-service] LanguageService created');
        callback(_service);
      });
    }).catch(function (err) {
      console.warn('[ts-service] init failed:', err && err.message);
      callback(null);
    });
  }

  // ── Public API ──

  /**
   * Get diagnostics for a model.
   * @param {monaco.editor.ITextModel} model
   * @returns {Array} array of { start, end, message, severity }
   */
  function getDiagnostics(model) {
    if (!_service || !model) return [];
    var ts = window.ts;
    if (!ts) return [];
    var fileName = model.uri.toString();

    // Update version
    var v = (_docVersions[fileName] || 0) + 1;
    _docVersions[fileName] = v;

    // Mark this file as known
    var host = _host;
    if (host && host.fileExists) {
      // trigger fileExists to register the file
    }

    var diagnostics = [];
    try {
      var syntactic = _service.getSyntacticDiagnostics(fileName);
      var semantic = _service.getSemanticDiagnostics(fileName);
      var all = syntactic.concat(semantic);
      for (var i = 0; i < all.length; i++) {
        var d = all[i];
        if (!d.start || !d.file) continue;
        var startPos = model.getPositionAt(d.start);
        var endPos = model.getPositionAt(d.start + (d.length || 1));
        diagnostics.push({
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
          message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
          severity: d.category === ts.DiagnosticCategory.Error ? 8 /* Error */ :
                    d.category === ts.DiagnosticCategory.Warning ? 4 /* Warning */ :
                    d.category === ts.DiagnosticCategory.Suggestion ? 2 /* Hint */ :
                    d.category === ts.DiagnosticCategory.Message ? 1 /* Info */ : 8,
        });
      }
    } catch (e) {
      console.warn('[ts-service] getDiagnostics error:', e && e.message);
    }
    return diagnostics;
  }

  /**
   * Get hover information at a position.
   * @param {monaco.editor.ITextModel} model
   * @param {monaco.Position} position
   * @returns {Object|null} { contents, range }
   */
  function getHover(model, position) {
    if (!_service || !model) return null;
    var ts = window.ts;
    if (!ts) return null;
    var fileName = model.uri.toString();
    var offset = model.getOffsetAt(position);
    try {
      var info = _service.getQuickInfoAtPosition(fileName, offset);
      if (!info) return null;
      var display = ts.displayPartsToString(info.displayParts);
      var doc = ts.displayPartsToString(info.documentation || []);
      var contents = [{ value: display }];
      if (doc) contents.push({ value: doc });
      // Compute range from textSpan
      var startPos = model.getPositionAt(info.textSpan.start);
      var endPos = model.getPositionAt(info.textSpan.start + info.textSpan.length);
      return {
        contents: contents,
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
      };
    } catch (e) {
      console.warn('[ts-service] getHover error:', e && e.message);
      return null;
    }
  }

  /**
   * Get completion items at a position.
   * @param {monaco.editor.ITextModel} model
   * @param {monaco.Position} position
   * @returns {Array} array of completion items
   */
  function getCompletions(model, position) {
    if (!_service || !model) return [];
    var ts = window.ts;
    if (!ts) return [];
    var fileName = model.uri.toString();
    var offset = model.getOffsetAt(position);
    try {
      var info = _service.getCompletionsAtPosition(fileName, offset, {
        includeCompletionsForModuleExports: true,
        includeInsertTextCompletions: true,
      });
      if (!info || !info.entries) return [];
      var items = [];
      for (var i = 0; i < info.entries.length; i++) {
        var entry = info.entries[i];
        var kind = mapCompletionKind(ts, entry.kind);
        var item = {
          label: entry.name,
          kind: kind,
          sortText: entry.sortText || entry.name,
          insertText: entry.insertText || entry.name,
          detail: ts.displayPartsToString(entry.displayParts || []),
          documentation: ts.displayPartsToString(entry.documentation || []),
        };
        if (entry.replacementSpan) {
          var startPos = model.getPositionAt(entry.replacementSpan.start);
          var endPos = model.getPositionAt(entry.replacementSpan.start + entry.replacementSpan.length);
          item.range = {
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column,
          };
        }
        items.push(item);
      }
      return items;
    } catch (e) {
      console.warn('[ts-service] getCompletions error:', e && e.message);
      return [];
    }
  }

  function mapCompletionKind(ts, tsKind) {
    var monaco = window.monaco;
    if (!monaco) return 0;
    var K = monaco.languages.CompletionItemKind;
    switch (tsKind) {
      case ts.ScriptElementKind.primitiveType:
      case ts.ScriptElementKind.keyword: return K.Keyword;
      case ts.ScriptElementKind.constElement: return K.Constant;
      case ts.ScriptElementKind.letElement:
      case ts.ScriptElementKind.variableElement:
      case ts.ScriptElementKind.localVariableElement: return K.Variable;
      case ts.ScriptElementKind.memberVariableElement:
      case ts.ScriptElementKind.memberGetAccessorElement:
      case ts.ScriptElementKind.memberSetAccessorElement: return K.Field;
      case ts.ScriptElementKind.functionElement:
      case ts.ScriptElementKind.memberFunctionElement:
      case ts.ScriptElementKind.constructSignatureElement:
      case ts.ScriptElementKind.callSignatureElement:
      case ts.ScriptElementKind.indexSignatureElement: return K.Function;
      case ts.ScriptElementKind.enumElement: return K.Enum;
      case ts.ScriptElementKind.moduleElement:
      case ts.ScriptElementKind.externalModuleName: return K.Module;
      case ts.ScriptElementKind.classElement:
      case ts.ScriptElementKind.typeElement: return K.Class;
      case ts.ScriptElementKind.interfaceElement: return K.Interface;
      case ts.ScriptElementKind.warningElement: return K.Text;
      case ts.ScriptElementKind.scriptElement: return K.File;
      case ts.ScriptElementKind.parameterElement: return K.Variable;
      case ts.ScriptElementKind.alias: return K.Reference;
      case ts.ScriptElementKind.methodElement:
      case ts.ScriptElementKind.memberMethodElement: return K.Method;
      default: return K.Text;
    }
  }

  /**
   * Get the current LanguageService (or null if not initialized).
   */
  function getService() { return _service; }

  /**
   * Check if the service is ready.
   */
  function isReady() { return !!_service; }

  /**
   * Notify that a document has changed (version bump).
   */
  function touchDocument(fileName) {
    var v = (_docVersions[fileName] || 0) + 1;
    _docVersions[fileName] = v;
  }

  /**
   * Remove a document from tracking.
   */
  function closeDocument(fileName) {
    delete _docVersions[fileName];
  }

  // ── Export ──
  window.qqqTsService = {
    init: initService,
    loadTypeScript: loadTypeScript,
    getDiagnostics: getDiagnostics,
    getHover: getHover,
    getCompletions: getCompletions,
    getService: getService,
    isReady: isReady,
    touchDocument: touchDocument,
    closeDocument: closeDocument,
  };

  console.log('[ts-service] module loaded');
})();
