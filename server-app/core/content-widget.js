// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// content-widget.js — Monaco ContentWidget renderer for 📎 anchors
//
// Replaces old CodeLens approach (buttons above lines) with inline content.
// Uses Monaco ContentWidget API to render thumbnails/icons at anchor positions.
//
// 管线:
//   anchor-map 变化 → _syncWidgets → 为每个锚点创建/更新 ContentWidget
//   空间键 → 查找光标附近锚点 → 显示媒体信息
//
// 暴露: window.qqqContentWidget
//
// 依赖: qqqAnchorMap, qqqThumbnailCache, Monaco
// ============================================================================

(function () {
  'use strict';

  var anchorMap = null;
  var thumbCache = null;
  var _editor = null;
  var _monaco = null;
  var _widgets = {};       // key → { widgetId, domNode }
  var _disposables = [];
  var _attached = false;

  // ═══ 图片分类 ═══
  var IMG_EXTS = { '.png':1,'.jpg':1,'.jpeg':1,'.gif':1,'.bmp':1,'.webp':1,'.svg':1,'.ico':1,'.tiff':1,'.avif':1 };
  var VID_EXTS = { '.mp4':1,'.mkv':1,'.avi':1,'.mov':1,'.webm':1,'.flv':1,'.wmv':1,'.m4v':1,'.ts':1,'.mpg':1 };
  var AUD_EXTS = { '.mp3':1,'.wav':1,'.flac':1,'.ogg':1,'.m4a':1,'.aac':1,'.wma':1,'.opus':1 };

  function extOf(name) {
    if (!name) return '';
    var d = name.lastIndexOf('.');
    return d >= 0 ? name.slice(d).toLowerCase() : '';
  }

  function isImage(name) { return IMG_EXTS[extOf(name)] || false; }
  function isVideo(name) { return VID_EXTS[extOf(name)] || false; }
  function isAudio(name) { return AUD_EXTS[extOf(name)] || false; }

  // ═══ ContentWidget 工厂 ═══

  var _widgetSeq = 0;

  function _makeWidgetId() { return 'qqq-cw-' + (++_widgetSeq); }

  // 为图片锚点创建缩略图 widget
  function _createImageWidget(entry, key) {
    var domNode = document.createElement('div');
    domNode.className = 'qqq-cw qqq-cw-image';
    domNode.style.cssText = 'padding:4px 0;text-align:center;max-width:512px;';

    // Loading state
    var img = document.createElement('img');
    img.style.cssText = 'max-width:512px;max-height:288px;display:block;margin:0 auto;border:1px dashed #888;background:#fdf6e3;';
    img.src = ''; // placeholder, loaded async
    img.alt = entry.fileName || '';
    img.title = 'Click to open | Space for info';

    var label = document.createElement('div');
    label.style.cssText = 'font-size:11px;color:var(--text-secondary,#888);margin-top:2px;';
    label.textContent = (entry.fileName || '');

    domNode.appendChild(img);
    domNode.appendChild(label);

    // Async load thumbnail
    _loadThumbnail(entry, img);

    return domNode;
  }

  // 为视频锚点创建封面 widget
  function _createVideoWidget(entry, key) {
    var domNode = document.createElement('div');
    domNode.className = 'qqq-cw qqq-cw-video';
    domNode.style.cssText = 'padding:4px 0;text-align:center;max-width:512px;';

    var container = document.createElement('div');
    container.style.cssText = 'position:relative;display:inline-block;';

    var img = document.createElement('img');
    img.style.cssText = 'max-width:512px;max-height:288px;display:block;border:1px dashed #888;background:#1a1a1a;';
    img.alt = entry.fileName || '';
    img.title = 'Click to play | Space for info';

    // Play button overlay
    var playBtn = document.createElement('span');
    playBtn.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:36px;color:rgba(255,255,255,0.9);pointer-events:none;text-shadow:0 0 8px rgba(0,0,0,0.6);';
    playBtn.textContent = '\u25B6'; // ▶

    container.appendChild(img);
    container.appendChild(playBtn);

    var label = document.createElement('div');
    label.style.cssText = 'font-size:11px;color:var(--text-secondary,#888);margin-top:2px;';
    label.textContent = '\uD83C\uDFAC ' + (entry.fileName || '');

    domNode.appendChild(container);
    domNode.appendChild(label);

    _loadThumbnail(entry, img);

    return domNode;
  }

  // 为音频锚点创建 widget
  function _createAudioWidget(entry, key) {
    var domNode = document.createElement('div');
    domNode.className = 'qqq-cw qqq-cw-audio';
    domNode.style.cssText = 'padding:4px 0;display:flex;align-items:center;gap:6px;';

    var icon = document.createElement('span');
    icon.style.cssText = 'font-size:28px;';
    icon.textContent = '\uD83C\uDFB5'; // 🎵

    var info = document.createElement('div');
    info.style.cssText = 'font-size:12px;color:var(--text-secondary,#888);';
    info.textContent = (entry.fileName || 'Audio');

    domNode.appendChild(icon);
    domNode.appendChild(info);

    return domNode;
  }

  // 为普通文件锚点创建 widget
  function _createFileWidget(entry, key) {
    var domNode = document.createElement('div');
    domNode.className = 'qqq-cw qqq-cw-file';
    domNode.style.cssText = 'padding:4px 0;display:flex;align-items:center;gap:6px;';

    var icon = document.createElement('span');
    icon.style.cssText = 'font-size:28px;';
    icon.textContent = '\uD83D\uDCC4'; // 📄

    var info = document.createElement('div');
    info.style.cssText = 'font-size:12px;color:var(--text-secondary,#888);';
    info.textContent = (entry.fileName || 'File');

    domNode.appendChild(icon);
    domNode.appendChild(info);

    return domNode;
  }

  // ═══ 缩略图异步加载 ═══

  function _loadThumbnail(entry, imgEl) {
    // If path is resolved, try load directly or through thumbnail cache
    if (entry.path && isImage(entry.fileName)) {
      // Image: try file:// URL directly
      var fileUrl = 'file:///' + entry.path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
      imgEl.src = fileUrl;
      imgEl.onerror = function () {
        imgEl.style.display = 'none';
      };
    } else if (entry.path && (isVideo(entry.fileName) || isAudio(entry.fileName))) {
      // Video/Audio: try thumbnail cache
      if (thumbCache && thumbCache.getThumbnail) {
        thumbCache.getThumbnail(entry.path, 'small').then(function (thumbPath) {
          if (thumbPath) {
            var thumbUrl = 'file:///' + thumbPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
            imgEl.src = thumbUrl;
          }
        }).catch(function () {
          // No thumbnail available
        });
      }
    }
  }

  // ═══ 创建 widget ═══

  function _createWidgetForEntry(entry, key) {
    var domNode;
    if (entry.type === 'image') {
      domNode = _createImageWidget(entry, key);
    } else if (entry.type === 'video') {
      domNode = _createVideoWidget(entry, key);
    } else if (entry.type === 'audio') {
      domNode = _createAudioWidget(entry, key);
    } else {
      domNode = _createFileWidget(entry, key);
    }

    var widgetId = _makeWidgetId();
    var widget = {
      getId: function () { return widgetId; },
      getDomNode: function () { return domNode; },
      getPosition: function () {
        return {
          position: { lineNumber: entry.line, column: entry.col },
          preference: [_monaco.editor.ContentWidgetPositionPreference.BELOW],
        };
      },
    };

    _editor.addContentWidget(widget);
    _widgets[key] = { widgetId: widgetId, domNode: domNode, widget: widget, entry: entry };

    // Store widgetId back to anchor map
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

  // ═══ 同步 widgets 与 anchor-map ═══

  function _syncWidgets() {
    if (!_editor || !anchorMap) return;

    var entries = anchorMap.getAll();
    var currentKeys = {};
    var hasChanges = false;

    // Create/update widgets for new anchors
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var key = entry.line + ':' + entry.col;
      currentKeys[key] = true;

      if (!_widgets[key]) {
        _createWidgetForEntry(entry, key);
        hasChanges = true;
      } else {
        // Update position if line changed
        var existing = _widgets[key];
        if (existing.entry && existing.entry.line !== entry.line) {
          existing.entry.line = entry.line;
          existing.entry.col = entry.col;
          // Re-create widget at new position
          _removeWidget(key);
          _createWidgetForEntry(entry, key);
          hasChanges = true;
        }
      }
    }

    // Remove widgets for removed anchors
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

  // ═══ 空格键 handler ═══

  function _onKeyDown(e) {
    if (e.keyCode !== 32) return; // Space
    if (!_editor || !anchorMap) return;

    var pos = _editor.getPosition();
    if (!pos) return;

    var entry = anchorMap.getNear(pos.lineNumber, pos.column, 3);
    if (!entry) return;

    e.preventDefault();
    e.stopPropagation();

    // Show media info via qoast
    var info = [];
    info.push('📎 ' + (entry.fileName || '?'));
    if (entry.type === 'image') info.push('Type: Image');
    if (entry.type === 'video') info.push('Type: Video');
    if (entry.type === 'audio') info.push('Type: Audio');
    if (entry.path) info.push('Path: ' + entry.path);
    if (entry.sha256) info.push('SHA: ' + entry.sha256.slice(0, 12));

    // Try to get media dimensions from thumbnail cache
    if (entry.path && thumbCache && thumbCache.getInfo) {
      thumbCache.getInfo(entry.path).then(function (info2) {
        if (info2) {
          var extra = [];
          if (info2.width && info2.height) extra.push(info2.width + '×' + info2.height);
          if (info2.duration) extra.push(info2.duration + 's');
          if (info2.size) extra.push(_formatSize(info2.size));
          if (extra.length > 0) {
            if (window.qqqideQoast) {
              window.qqqideQoast.show(info.join('\n') + '\n' + extra.join(' · '), { duration: 5000 });
            }
          }
        }
      }).catch(function () {});
    }

    // Show basic info immediately
    if (window.qqqideQoast) {
      window.qqqideQoast.show(info.join(' · '), { duration: 3000 });
    }
  }

  function _formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  // ═══ 附加/分离 ═══

  function attach(editor, monaco) {
    if (_attached) return;
    if (!editor || !monaco) return;

    _editor = editor;
    _monaco = monaco;
    anchorMap = window.qqqAnchorMap;
    thumbCache = window.qqqThumbnailCache;

    // Keyboard listener for space key
    var domNode = editor.getDomNode && editor.getDomNode();
    if (domNode) {
      domNode.addEventListener('keydown', _onKeyDown, true);
    }

    // Initial sync
    _syncWidgets();

    // Poll for changes (anchor map is updated by content changes)
    var intervalId = setInterval(function () {
      _syncWidgets();
    }, 500);
    _disposables.push({ dispose: function () { clearInterval(intervalId); } });

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

  // Force refresh all widgets
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
