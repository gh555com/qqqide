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

  // Regex to find anchor tokens in text
  // 📎 followed by hex chars, colon, then filename (non-whitespace, non-quote)
  var ANCHOR_REGEX = /\u{1F4CE}([a-fA-F0-9]{8,64}):(\S+)/gu;

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

    // Reset regex state
    ANCHOR_REGEX.lastIndex = 0;
    var match;
    while ((match = ANCHOR_REGEX.exec(text)) !== null) {
      var sha256 = match[1];
      var fileName = match[2];
      var pos = model.getPositionAt(match.index);
      var key = _posKey(pos.lineNumber, pos.column);
      newMap[key] = {
        type: _guessType(fileName),
        path: null,           // resolved later
        sha256: sha256.toLowerCase(),
        fileName: fileName,
        widgetId: null,       // populated by ContentWidget renderer
        line: pos.lineNumber,
        col: pos.column,
      };
    }

    _anchorMap = newMap;
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

  // ═══ 增量更新 ═══

  // Shift all entries after a given line by delta lines
  function _shiftAfter(line, deltaLines, deltaCol) {
    var newMap = {};
    var keys = Object.keys(_anchorMap);
    for (var i = 0; i < keys.length; i++) {
      var entry = _anchorMap[keys[i]];
      if (entry.line > line) {
        entry.line += deltaLines;
        if (deltaCol) entry.col += deltaCol;
        newMap[_posKey(entry.line, entry.col)] = entry;
      } else if (entry.line === line && deltaCol && entry.col >= deltaCol) {
        entry.col += deltaCol;
        newMap[_posKey(entry.line, entry.col)] = entry;
      } else {
        newMap[keys[i]] = entry;
      }
    }
    _anchorMap = newMap;
  }

  // Handle model content changes
  function _onModelChange(e) {
    if (!e || !e.changes) return;

    for (var i = 0; i < e.changes.length; i++) {
      var change = e.changes[i];
      var range = change.range;
      var oldLen = change.rangeLength;
      var newText = change.text || '';

      var oldLines = (range.endLineNumber - range.startLineNumber);
      var newTextLines = newText.split('\n').length - 1;
      var deltaLines = newTextLines - oldLines;

      if (deltaLines !== 0) {
        // Lines added or removed — shift all entries after
        _shiftAfter(range.startLineNumber, deltaLines, 0);
      }

      // After any change, re-scan the affected region
      // For simplicity: full rescan (can be optimized later for perf)
    }
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
        // Full rescan after changes (simplest, correct approach)
        _fullScan();
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

  window.qqqAnchorMap = {
    attach: attach,
    dispose: dispose,
    getAt: getAt,
    getNear: getNear,
    getAll: getAll,
    getBySha256: getBySha256,
    setWidgetId: setWidgetId,
    setPath: setPath,
    _fullScan: _fullScan,
  };

})();
