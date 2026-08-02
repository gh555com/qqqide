// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// anchor-map.js — 📎 锚点位置映射表（替代旧字符串转译）
//
// 核心差异 vs 旧 codelens:
//   旧: 每次渲染扫描全文本 → 正则找 /\path\/ → 翻译 → decoration
//   新: 打开文件一次性扫描 → 映射表 → 增量更新 → ContentWidget 渲染
//
// 锚点 token 格式: 📎{sha256前12}:{文件名}
//   例: 📎a1b2c3d4e5f6:photo.jpg
//   - 📎 = 锚点前缀（emoji，与自然文本碰撞概率→0）
//   - a1b2c3d4e5f6 = SHA256 前 12 位（去重/校验）
//   - :photo.jpg = 人类可读文件名
//
// 暴露: window.qqqAnchorMap
// ============================================================================

(function () {
  'use strict';

  // ═══ 内部状态 ═══
  // Map: "line:col" → AnchorEntry
  var _anchorMap = {};
  // editor instance reference
  var _editor = null;
  var _monaco = null;
  var _disposables = [];
  var _listeners = [];

  // Regex to find anchor tokens in text
  // 📎 followed by hex chars, colon, then filename (non-whitespace, non-📎, non-📁)
  // ★ Allow empty sha256 prefix (0-64 hex chars) so that 📎:filename works for files without hash
  // ★ 2026-08-02 fix: \S+ → [^\s📎📁]+ — 旧 regex 的 \S 会吞掉后一个锚点的 📎 emoji，
  //   导致相邻锚点被合并成一个巨锚点（fileName 含完整后一个锚点的 token）。
  var ANCHOR_REGEX = /\u{1F4CE}([a-fA-F0-9]{0,64}):([^\s\u{1F4CE}\u{1F4C1}]+)/gu;

  function _posKey(line, col) {
    return line + ':' + col;
  }

  // ═══ 扫描 ═══

  // Full scan: parse all 📎 tokens from editor content, rebuild map
  function _fullScan() {
    if (!_editor) return;
    var model = _editor.getModel();
    if (!model) return;

    var text = model.getValue();
    var newMap = {};

    // Build candidate base dirs for path resolution.
    // ★ Order matters: _qqqvault/ paths first (paste files live there), then bare dirs.
    //   L0: current editor file's _qqqvault/ (most precise)
    //   L1: workspace root's _qqqvault/
    //   L2: current file's bare dir (for 📎"full/path" tokens)
    //   L3: workspace root bare
    var baseDirs = [];

    // L0+L2: current file from editor model URI or global currentFile
    var cf = null;
    try {
      var edModel = _editor && _editor.getModel && _editor.getModel();
      if (edModel && edModel.uri && edModel.uri.scheme === 'file') {
        cf = edModel.uri.fsPath || edModel.uri.path;
      }
    } catch (e) { /* */ }
    if (!cf) {
      try {
        if (window.qqqEditor && typeof window.qqqEditor.currentFile === 'function') {
          cf = window.qqqEditor.currentFile();
        }
      } catch (e) { /* */ }
    }
    if (cf) {
      var sep = cf.indexOf('\\') >= 0 ? '\\' : '/';
      var cfDir = cf.slice(0, cf.lastIndexOf(sep));
      if (cfDir) {
        baseDirs.push(cfDir + sep + '_qqqvault');   // L0: most precise
        baseDirs.push(cfDir);                        // L2: bare dir
      }
    }

    // L1+L3: workspace root
    if (window._workspaceRoot) {
      var ws = window._workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
      baseDirs.push(ws + '/_qqqvault');             // L1
      baseDirs.push(ws);                             // L3
    }

    // Reset regex state
    ANCHOR_REGEX.lastIndex = 0;
    var match;
    while ((match = ANCHOR_REGEX.exec(text)) !== null) {
      var sha256 = match[1];
      var fileName = match[2];
      var pos = model.getPositionAt(match.index);
      var key = _posKey(pos.lineNumber, pos.column);

      // Resolve path: prefer _qqqvault/ dirs. Try all candidates, take first _qqqvault.
      // Don't break early — _resolveMissingPaths needs all baseDirs for fallback verification.
      var resolvedPath = null;
      for (var bi = 0; bi < baseDirs.length; bi++) {
        var candidate = baseDirs[bi] + '/' + fileName;
        var isVault = baseDirs[bi].indexOf('/_qqqvault') >= 0 || baseDirs[bi].indexOf('\\_qqqvault') >= 0;
        if (isVault && !resolvedPath) {
          resolvedPath = candidate;  // first _qqqvault wins (cfDir before ws)
        } else if (!resolvedPath) {
          resolvedPath = candidate;  // bare dir as last resort
        }
        // Continue loop — don't break, so _resolveMissingPaths has all candidates
      }

      newMap[key] = {
        type: _guessType(fileName),
        path: resolvedPath,
        sha256: sha256.toLowerCase(),
        fileName: fileName,
        widgetId: null,       // populated by ContentWidget renderer
        line: pos.lineNumber,
        col: pos.column,
      };
    }

    _anchorMap = newMap;

    // Async: verify paths exist, fallback to other candidates
    _resolveMissingPaths(baseDirs);
  }

  // Async check which resolved paths actually exist, fix those that don't
  function _resolveMissingPaths(baseDirs) {
    var bridge = window.qqqideBridge;
    if (!bridge || !bridge.fs || !bridge.fs.exists) return;

    var keys = Object.keys(_anchorMap);
    var checkPromises = [];
    for (var i = 0; i < keys.length; i++) {
      var entry = _anchorMap[keys[i]];
      if (!entry || !entry.path) continue;
      checkPromises.push(_verifyEntryPath(entry, baseDirs, bridge));
    }
    Promise.all(checkPromises).then(function () {
      _notifyListeners();
    }).catch(function () {});
  }

  function _verifyEntryPath(entry, baseDirs, bridge) {
    return bridge.fs.exists(entry.path).then(function (exists) {
      if (exists) return;
      // Path doesn't exist — try all other candidates, preferring _qqqvault paths
      for (var bi = 0; bi < baseDirs.length; bi++) {
        var candidate = baseDirs[bi] + '/' + entry.fileName;
        if (candidate === entry.path) continue;
        return bridge.fs.exists(candidate).then(function (ex2) {
          if (ex2) entry.path = candidate;
        });
      }
    }).catch(function () {});
  }

  function _guessType(fileName) {
    var ext = '';
    var dot = fileName.lastIndexOf('.');
    if (dot >= 0) ext = fileName.slice(dot).toLowerCase();

    if (/\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff|avif)$/i.test(fileName)) return 'image';
    if (/\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|mpg)$/i.test(fileName)) return 'video';
    if (/\.(mp3|wav|flac|ogg|m4a|aac|wma|opus)$/i.test(fileName)) return 'audio';
    return 'file';
  }

  // ═══ 增量更新 — 真·事件驱动，正则只跑一次 ═══

  // Check if an entry position falls within a Monaco range
  function _isInRange(entry, range) {
    if (entry.line < range.startLineNumber) return false;
    if (entry.line === range.startLineNumber && entry.col < range.startColumn) return false;
    if (entry.line > range.endLineNumber) return false;
    if (entry.line === range.endLineNumber && entry.col >= range.endColumn) return false;
    return true;
  }

  // Remove all entries whose position falls within the given range
  function _removeInRange(range) {
    var newMap = {};
    var keys = Object.keys(_anchorMap);
    var removed = 0;
    for (var i = 0; i < keys.length; i++) {
      var entry = _anchorMap[keys[i]];
      if (!_isInRange(entry, range)) {
        newMap[keys[i]] = entry;
      } else {
        removed++;
      }
    }
    if (removed > 0) _anchorMap = newMap;
  }

  // Shift all entries after a range by delta lines/columns
  function _shiftAfterRange(range, deltaLines, deltaCol, newLastLineLen) {
    if (deltaLines === 0 && deltaCol === 0) return;
    var newMap = {};
    var keys = Object.keys(_anchorMap);
    for (var i = 0; i < keys.length; i++) {
      var entry = _anchorMap[keys[i]];
      if (entry.line > range.endLineNumber) {
        // Entries on lines strictly after the range — shift lines
        entry.line += deltaLines;
      } else if (entry.line === range.endLineNumber && entry.col >= range.endColumn) {
        // Entries on the end line after the range
        if (deltaLines === 0) {
          // Single-line change — pure column shift
          entry.col += deltaCol;
        } else {
          // Multi-line change — move to new last line
          entry.line = range.startLineNumber + deltaLines + (range.endLineNumber - range.startLineNumber);
          entry.col = entry.col - range.endColumn + (newLastLineLen || 0);
        }
      }
      newMap[_posKey(entry.line, entry.col)] = entry;
    }
    _anchorMap = newMap;
  }

  // Scan a text fragment for 📎 tokens, anchored at a given start position
  function _scanText(text, startLine, startCol) {
    if (!text || text.indexOf('📎') < 0) return;
    var model = _editor && _editor.getModel();
    if (!model) return;

    ANCHOR_REGEX.lastIndex = 0;
    var match;
    while ((match = ANCHOR_REGEX.exec(text)) !== null) {
      var sha256 = match[1];
      var fileName = match[2];
      // Calculate position within the text fragment
      var offset = match.index;
      var linesBefore = text.substring(0, offset).split('\n');
      var line = startLine + linesBefore.length - 1;
      var col = (linesBefore.length === 1 ? startCol : 0) + linesBefore[linesBefore.length - 1].length;
      var key = _posKey(line, col);
      _anchorMap[key] = {
        type: _guessType(fileName),
        path: null,
        sha256: sha256.toLowerCase(),
        fileName: fileName,
        widgetId: null,
        line: line,
        col: col,
      };
    }
  }

  // Handle model content changes — true incremental update, zero full scan
  function _onModelChange(e) {
    if (!e || !e.changes) return;

    var hasChange = false;
    for (var i = 0; i < e.changes.length; i++) {
      var change = e.changes[i];
      var range = change.range;
      var newText = change.text || '';

      // 1. Remove entries that were in the deleted/replaced range
      _removeInRange(range);

      // 2. Calculate line/column deltas
      var newLines = newText.split('\n');
      var newLineCount = newLines.length;
      var oldLineSpan = range.endLineNumber - range.startLineNumber + 1;
      var deltaLines = newLineCount - oldLineSpan;
      var deltaCol = 0;
      var newLastLineLen = 0;
      if (oldLineSpan === 1 && newLineCount === 1) {
        // Single-line change — column delta
        deltaCol = newText.length - change.rangeLength;
      } else if (newLineCount > 1) {
        newLastLineLen = newLines[newLines.length - 1].length;
      }

      // 3. Shift entries after the range
      if (deltaLines !== 0 || deltaCol !== 0) {
        _shiftAfterRange(range, deltaLines, deltaCol, newLastLineLen);
      }

      // 4. Scan only the new text for anchor tokens
      if (newText.length > 0) {
        _scanText(newText, range.startLineNumber, range.startColumn);
      }

      hasChange = true;
    }

    // 5. Push notification to listeners (ContentWidget)
    if (hasChange) _notifyListeners();
  }

  // ═══ 公共 API ═══

  // Attach to a Monaco editor instance
  function attach(editor, monaco) {
    if (!editor || !monaco) return;

    _editor = editor;
    _monaco = monaco;

    // Initial full scan
    _fullScan();

    // Listen for model changes
    var model = editor.getModel();
    if (model) {
      var d1 = model.onDidChangeContent(function (e) {
        _onModelChange(e);
      });
      _disposables.push(d1);
    } else {
      // Model not ready yet — wait
      var d2 = editor.onDidChangeModel(function () {
        _fullScan();
      });
      _disposables.push(d2);
    }
  }

  function dispose() {
    for (var i = 0; i < _disposables.length; i++) {
      try { _disposables[i].dispose(); } catch (e) { /* ignore */ }
    }
    _disposables = [];
    _anchorMap = {};
    _editor = null;
    _monaco = null;
  }

  // Get anchor entry at a position
  function getAt(line, col) {
    var key = _posKey(line, col);
    return _anchorMap[key] || null;
  }

  // Find anchor entry near a position (within tolerance)
  function getNear(line, col, tolerance) {
    tolerance = tolerance || 5;
    for (var dc = -tolerance; dc <= tolerance; dc++) {
      var entry = getAt(line, col + dc);
      if (entry) return entry;
    }
    return null;
  }

  // Get all anchors
  function getAll() {
    var result = [];
    var keys = Object.keys(_anchorMap);
    for (var i = 0; i < keys.length; i++) {
      result.push(_anchorMap[keys[i]]);
    }
    return result;
  }

  // Get anchor by SHA256 prefix
  function getBySha256(sha256Prefix) {
    var prefix = sha256Prefix.toLowerCase();
    var keys = Object.keys(_anchorMap);
    for (var i = 0; i < keys.length; i++) {
      var entry = _anchorMap[keys[i]];
      if (entry.sha256 && entry.sha256.indexOf(prefix) === 0) return entry;
    }
    return null;
  }

  // Register a widget ID for an anchor entry
  function setWidgetId(line, col, widgetId) {
    var key = _posKey(line, col);
    if (_anchorMap[key]) {
      _anchorMap[key].widgetId = widgetId;
    }
  }

  // Update resolved path for an anchor entry
  function setPath(line, col, resolvedPath) {
    var key = _posKey(line, col);
    if (_anchorMap[key]) {
      _anchorMap[key].path = resolvedPath;
    }
  }

  // ═══ 监听器 — ContentWidget 订阅替代轮询 ═══
  function onChange(cb) {
    if (typeof cb === 'function') _listeners.push(cb);
  }

  function _notifyListeners() {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](); } catch (e) { /* ignore */ }
    }
  }

  window.qqqAnchorMap = {
    attach: attach,
    dispose: dispose,
    rescan: _fullScan,
    getAt: getAt,
    getNear: getNear,
    getAll: getAll,
    getBySha256: getBySha256,
    setWidgetId: setWidgetId,
    setPath: setPath,
    onChange: onChange,
    _fullScan: _fullScan,
    _notifyListeners: _notifyListeners,
  };

})();
