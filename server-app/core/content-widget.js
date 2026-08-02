// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// content-widget.js — Monaco ContentWidget renderer for anchor tokens
//
// Uses qqqFrameRenderer to build proper media frames (image/video/text-film)
// and icon frames (file/directory). Replaces old inline widget building.
//
// Pipeline:
//   anchor-map change -> _syncWidgets -> buildFrame for each anchor -> ContentWidget
//   Space key -> find anchor near cursor -> probe media info -> qoast
//
// Exposes: window.qqqContentWidget
// Depends: qqqAnchorMap, qqqFrameRenderer, qqqThumbnailCache, Monaco
// ============================================================================

(function () {
  'use strict';

  var anchorMap = null;
  var frameRenderer = null;
  var _editor = null;
  var _monaco = null;
  var _widgets = {};
  var _disposables = [];
  var _attached = false;

  var _widgetSeq = 0;
  function _makeWidgetId() { return 'qqq-cw-' + (++_widgetSeq); }

  // ═══ Create a ContentWidget from an anchor entry ═══

  function _createWidgetForEntry(entry, key) {
    if (!frameRenderer || !_editor) return;

    var frameDom = frameRenderer.buildFrame(entry);
    if (!frameDom) return;

    var widgetId = _makeWidgetId();
    var widget = {
      getId: function () { return widgetId; },
      getDomNode: function () { return frameDom; },
      getPosition: function () {
        return {
          position: { lineNumber: entry.line, column: entry.col },
          preference: [_monaco.editor.ContentWidgetPositionPreference.BELOW],
        };
      },
    };

    _editor.addContentWidget(widget);
    _widgets[key] = { widgetId: widgetId, domNode: frameDom, widget: widget, entry: entry };

    if (anchorMap && anchorMap.setWidgetId) {
      anchorMap.setWidgetId(entry.line, entry.col, widgetId);
    }
  }

  function _removeWidget(key) {
    var w = _widgets[key];
    if (w && _editor) {
      try { _editor.removeContentWidget(w.widget); } catch (e) { /* ignore */ }
    }
    delete _widgets[key];
  }

  function _removeAllWidgets() {
    var keys = Object.keys(_widgets);
    for (var i = 0; i < keys.length; i++) {
      _removeWidget(keys[i]);
    }
    _widgets = {};
  }

  // ═══ Sync widgets with anchor-map ═══

  function _syncWidgets() {
    if (!_editor || !anchorMap) return;

    var entries = anchorMap.getAll();

    // ★ 如果 qqqViewZone 已挂载，跳过图片/视频（ViewZone 处理空气行相框），
    //   本模块只负责文件/目录/音频/文本的图标框。
    if (window.qqqViewZone && window.qqqViewZone._syncAll) {
      var filtered = [];
      for (var ei = 0; ei < entries.length; ei++) {
        var t = entries[ei].type;
        if (t !== 'image' && t !== 'video') filtered.push(entries[ei]);
      }
      entries = filtered;
    }
    var currentKeys = {};
    var hasChanges = false;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var key = entry.line + ':' + entry.col;
      currentKeys[key] = true;

      if (!_widgets[key]) {
        _createWidgetForEntry(entry, key);
        hasChanges = true;
      } else {
        var existing = _widgets[key];
        var posChanged = existing.entry && (existing.entry.line !== entry.line || existing.entry.col !== entry.col);
        var dataChanged = existing.entry && (existing.entry.path !== entry.path || existing.entry.sha256 !== entry.sha256 || existing.entry.fileName !== entry.fileName);
        if (posChanged || dataChanged) {
          existing.entry.line = entry.line;
          existing.entry.col = entry.col;
          existing.entry.path = entry.path;
          existing.entry.sha256 = entry.sha256;
          existing.entry.fileName = entry.fileName;
          _removeWidget(key);
          _createWidgetForEntry(entry, key);
          hasChanges = true;
        }
      }
    }

    // Remove stale widgets
    var oldKeys = Object.keys(_widgets);
    for (var j = 0; j < oldKeys.length; j++) {
      if (!currentKeys[oldKeys[j]]) {
        _removeWidget(oldKeys[j]);
        hasChanges = true;
      }
    }

    if (hasChanges && _editor) {
      _editor.layoutContentWidgets();
    }
  }

  // ═══ Space key — probe media info ═══

  function _onKeyDown(e) {
    if (e.keyCode !== 32) return;
    if (!_editor || !anchorMap) return;

    var pos = _editor.getPosition();
    if (!pos) return;

    var entry = anchorMap.getNear(pos.lineNumber, pos.column, 3);
    if (!entry) return;

    e.preventDefault();
    e.stopPropagation();

    var info = [];
    info.push((entry.fileName || '?'));

    if (entry.type === 'image') info.push('Type: Image');
    if (entry.type === 'video') info.push('Type: Video');
    if (entry.type === 'audio') info.push('Type: Audio');
    if (entry.path) info.push('Path: ' + entry.path);
    if (entry.sha256) info.push('SHA: ' + entry.sha256.slice(0, 12));

    // Show basic info immediately
    if (window.qqqideQoast) {
      window.qqqideQoast.show(info.join(' \u00B7 '), { duration: 3000 });
    }

    // Async probe for dimensions
    if (entry.path && frameRenderer && frameRenderer.probeMediaInfo) {
      frameRenderer.probeMediaInfo(entry.path).then(function (mediaInfo) {
        if (mediaInfo) {
          var extra = [];
          if (mediaInfo.width && mediaInfo.height) extra.push(mediaInfo.width + 'x' + mediaInfo.height);
          if (mediaInfo.duration) extra.push(_fmtDuration(mediaInfo.duration) + 's');
          if (mediaInfo.size) extra.push(_fmtSize(mediaInfo.size));
          if (mediaInfo.codec) extra.push('Codec: ' + mediaInfo.codec);
          if (extra.length > 0) {
            if (window.qqqideQoast) {
              window.qqqideQoast.show(info.join(' \u00B7 ') + '\n' + extra.join(' \u00B7 '), { duration: 5000 });
            }
          }
        }
      }).catch(function () {});
    }
  }

  function _fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function _fmtDuration(sec) {
    if (!sec && sec !== 0) return '';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }
    return m + ':' + String(s).padStart(2,'0');
  }

  // ═══ Attach / Detach ═══

  function attach(editor, monaco) {
    if (_attached) return;
    if (!editor || !monaco) return;

    _editor = editor;
    _monaco = monaco;
    anchorMap = window.qqqAnchorMap;
    frameRenderer = window.qqqFrameRenderer;

    // Keyboard listener for space key
    var domNode = editor.getDomNode && editor.getDomNode();
    if (domNode) {
      domNode.addEventListener('keydown', _onKeyDown, true);
    }

    // Initial sync
    _syncWidgets();

    // Push subscription to anchor-map changes (not poll)
    if (anchorMap && anchorMap.onChange) {
      anchorMap.onChange(function () {
        _syncWidgets();
      });
    }

    _attached = true;
  }

  function dispose() {
    _removeAllWidgets();
    for (var i = 0; i < _disposables.length; i++) {
      try { _disposables[i].dispose(); } catch (e) { /* ignore */ }
    }
    _disposables = [];
    _editor = null;
    _monaco = null;
    _attached = false;
  }

  function refresh() {
    _removeAllWidgets();
    _syncWidgets();
  }

  window.qqqContentWidget = {
    attach: attach,
    dispose: dispose,
    refresh: refresh,
    _syncWidgets: _syncWidgets,
  };

})();
