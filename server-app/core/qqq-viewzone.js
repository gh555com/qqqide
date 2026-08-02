// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-viewzone.js — ViewZone-based WYSIWYG media frame rendering
//
// ★ 解决 "空气行" 问题：
//   ContentWidget BELOW 虽然不消费行号，但 Monaco 的 layout 会把它跟模型行
//   混合计算滚动高度，用户体验上"相框占了 20 行就是 20 行"。
//
//   ViewZone 不同：changeViewZones 在指定行后创建一块纯视觉空白区（空气行），
//   不可编辑、不占行号。Line N 有锚点 → ViewZone 占 330px → 下一行仍是 N+1。
//
// 架构:
//   - 图片/视频 → ViewZone（afterLineNumber, heightInPx, domNode=相框DOM）
//   - 文件/目录/音频/文本 → ContentWidget（BELOW, 图标框，~1行高）
//   - 空格键 → 光标附近锚点 → 探测媒体信息 → qoast
//
// 暴露: window.qqqViewZone
// 依赖: qqqAnchorMap, qqqFrameRenderer, qqqThumbnailCache, Monaco
// ============================================================================

(function () {
  'use strict';

  var anchorMap = null;
  var frameRenderer = null;
  var _editor = null;
  var _monaco = null;
  var _attached = false;
  var _disposables = [];

  // ── ViewZone 元数据 ──
  // _zoneMeta: { "line:col" → { zoneId, frameDom, entry, height } }
  var _zoneMeta = {};

  // ── ContentWidget（图标框）元数据 ──
  // _iconWidgets: { "line:col" → { widget, domNode, entry } }
  var _iconWidgets = {};
  var _widgetSeq = 0;

  // ── 高度常量 ──
  var MEDIA_LARGE_HEIGHT = 330;  // 288 (box) + 24 (meta) + 18 (padding/margins)
  var ICON_HEIGHT = 44;          // 文件/目录图标框

  // ── 防抖 ──
  var _syncTimer = null;

  function _zoneKey(entry) {
    return entry.line + ':' + entry.col;
  }

  function _makeWidgetId() {
    return 'qqq-vz-cw-' + (++_widgetSeq);
  }

  // ═══ ViewZone — 媒体相框 ═══

  function _syncMediaZones(entries) {
    if (!_editor || typeof _editor.changeViewZones !== 'function') return;

    _editor.changeViewZones(function (accessor) {
      // 标记哪些 key 在当前 entries 中
      var currentKeys = {};
      for (var i = 0; i < entries.length; i++) {
        currentKeys[_zoneKey(entries[i])] = true;
      }

      // 移除已不存在的 ViewZone
      var oldKeys = Object.keys(_zoneMeta);
      for (var j = 0; j < oldKeys.length; j++) {
        var key = oldKeys[j];
        if (!currentKeys[key]) {
          accessor.removeZone(_zoneMeta[key].zoneId);
          delete _zoneMeta[key];
        }
      }

      // 创建 / 更新 ViewZone
      for (var k = 0; k < entries.length; k++) {
        var entry = entries[k];
        var key = _zoneKey(entry);
        var existing = _zoneMeta[key];

        // 检查是否有实质性变化（跳过重建，减少 flicker）
        if (existing) {
          if (existing.entry.line === entry.line &&
              existing.entry.col === entry.col &&
              existing.entry.path === entry.path &&
              existing.entry.fileName === entry.fileName) {
            continue;
          }
          // 位置或数据变了 → 移除旧 zone
          accessor.removeZone(existing.zoneId);
          delete _zoneMeta[key];
        }

        // 构建相框 DOM
        if (!frameRenderer || !frameRenderer.buildFrame) continue;
        var frameDom = frameRenderer.buildFrame(entry);
        if (!frameDom) continue;

        // 加 CSS 类，方便主题适配
        frameDom.classList.add('qqq-vz-media');

        var zoneId = accessor.addZone({
          afterLineNumber: entry.line,
          heightInPx: MEDIA_LARGE_HEIGHT,
          domNode: frameDom,
        });

        _zoneMeta[key] = {
          zoneId: zoneId,
          frameDom: frameDom,
          entry: { line: entry.line, col: entry.col, path: entry.path, fileName: entry.fileName },
        };
      }
    });

    // ViewZone 创建完毕后，触发异步缩略图加载
    var metaKeys = Object.keys(_zoneMeta);
    for (var m = 0; m < metaKeys.length; m++) {
      var meta = _zoneMeta[metaKeys[m]];
      if (meta.frameDom && meta.entry.path && frameRenderer && frameRenderer.loadThumbnail) {
        frameRenderer.loadThumbnail(meta.frameDom, { path: meta.entry.path, fileName: meta.entry.fileName });
      }
    }
  }

  // ═══ ContentWidget — 图标框（文件/目录/音频/文本）═══

  function _syncIconWidgets(entries) {
    if (!_editor || !_monaco || typeof _editor.layoutContentWidgets !== 'function') return;

    var currentKeys = {};
    var hasChanges = false;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var key = _zoneKey(entry);
      currentKeys[key] = true;

      if (!_iconWidgets[key]) {
        _createIconWidget(entry, key);
        hasChanges = true;
      } else {
        var existing = _iconWidgets[key];
        var posChanged = existing.entry && (existing.entry.line !== entry.line || existing.entry.col !== entry.col);
        var dataChanged = existing.entry && (existing.entry.path !== entry.path || existing.entry.fileName !== entry.fileName);
        if (posChanged || dataChanged) {
          existing.entry.line = entry.line;
          existing.entry.col = entry.col;
          existing.entry.path = entry.path;
          existing.entry.fileName = entry.fileName;
          _removeIconWidget(key);
          _createIconWidget(entry, key);
          hasChanges = true;
        }
      }
    }

    // 移除过时图标框
    var oldKeys = Object.keys(_iconWidgets);
    for (var j = 0; j < oldKeys.length; j++) {
      if (!currentKeys[oldKeys[j]]) {
        _removeIconWidget(oldKeys[j]);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      _editor.layoutContentWidgets();
    }
  }

  function _createIconWidget(entry, key) {
    if (!frameRenderer || !frameRenderer.buildFrame) return;

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
    _iconWidgets[key] = { widget: widget, domNode: frameDom, entry: entry };
  }

  function _removeIconWidget(key) {
    var w = _iconWidgets[key];
    if (w && _editor) {
      try { _editor.removeContentWidget(w.widget); } catch (e) { /* ignore */ }
    }
    delete _iconWidgets[key];
  }

  function _removeAllIconWidgets() {
    var keys = Object.keys(_iconWidgets);
    for (var i = 0; i < keys.length; i++) {
      _removeIconWidget(keys[i]);
    }
    _iconWidgets = {};
  }

  // ═══ 主同步 — ViewZone + ContentWidget 双轨 ═══

  function _syncAll() {
    if (!_editor || !anchorMap) return;
    // ★ 防御：editor 可能已被 dispose，确认必备方法存在
    if (typeof _editor.changeViewZones !== 'function' && typeof _editor.layoutContentWidgets !== 'function') return;

    var allEntries = anchorMap.getAll();
    var mediaEntries = [];
    var iconEntries = [];

    for (var i = 0; i < allEntries.length; i++) {
      var e = allEntries[i];
      if (e.type === 'image' || e.type === 'video') {
        mediaEntries.push(e);
      } else {
        iconEntries.push(e);
      }
    }

    _syncMediaZones(mediaEntries);
    _syncIconWidgets(iconEntries);
  }

  // ═══ 防抖调度 ═══

  function _scheduleSync() {
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(_syncAll, 100);
  }

  // ═══ 空格键 — 探测媒体信息 ═══

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
    info.push(entry.fileName || '?');

    if (entry.type === 'image') info.push('Type: Image');
    if (entry.type === 'video') info.push('Type: Video');
    if (entry.type === 'audio') info.push('Type: Audio');
    if (entry.path) info.push('Path: ' + entry.path);
    if (entry.sha256) info.push('SHA: ' + entry.sha256.slice(0, 12));

    if (window.qqqideQoast) {
      window.qqqideQoast.show(info.join(' \u00B7 '), { duration: 3000 });
    }

    // 异步探测尺寸
    if (entry.path && frameRenderer && frameRenderer.probeMediaInfo) {
      frameRenderer.probeMediaInfo(entry.path).then(function (mediaInfo) {
        if (mediaInfo) {
          var extra = [];
          if (mediaInfo.width && mediaInfo.height) extra.push(mediaInfo.width + 'x' + mediaInfo.height);
          if (mediaInfo.duration) extra.push(_fmtDuration(mediaInfo.duration) + 's');
          if (mediaInfo.size) extra.push(_fmtSize(mediaInfo.size));
          if (mediaInfo.codec) extra.push('Codec: ' + mediaInfo.codec);
          if (extra.length > 0 && window.qqqideQoast) {
            window.qqqideQoast.show(info.join(' \u00B7 ') + '\n' + extra.join(' \u00B7 '), { duration: 5000 });
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
      return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return m + ':' + String(s).padStart(2, '0');
  }

  // ═══ Attach / Detach ═══

  function attach(editor, monaco) {
    if (!editor || !monaco) return;

    // ★ 2026-08-02 fix: 若已 attach 到旧 editor（tab 关闭但 dispose 未被调），
    //   先清理旧状态再绑定新 editor。旧 _attached 守卫导致重开文件后 ViewZone 永不渲染。
    if (_attached) {
      _doCleanup();
    }

    _editor = editor;
    _monaco = monaco;
    anchorMap = window.qqqAnchorMap;
    frameRenderer = window.qqqFrameRenderer;

    // ★ 自动 detach：editor 被 dispose 时清理
    try {
      var dd = editor.onDidDispose(function () {
        _doCleanup();
        _attached = false;
        _editor = null;
        _monaco = null;
      });
      _disposables.push(dd);
    } catch (e) { /* ignore */ }

    // 空格键监听
    var domNode = editor.getDomNode && editor.getDomNode();
    if (domNode) {
      domNode.addEventListener('keydown', _onKeyDown, true);
    }

    // 初始同步
    _syncAll();

    // 订阅 anchor-map 变更
    if (anchorMap && anchorMap.onChange) {
      anchorMap.onChange(function () {
        _scheduleSync();
      });
    }

    _attached = true;
  }

  // ★ 内部清理（不设 _attached = false，由调用方决定）
  function _doCleanup() {
    if (_syncTimer) clearTimeout(_syncTimer);

    // 移除所有 ViewZone — 仅在 editor 未被 dispose 时调用
    if (_editor && typeof _editor.changeViewZones === 'function') {
      try {
        var model = _editor.getModel && _editor.getModel();
        if (model && !model.isDisposed()) {
          _editor.changeViewZones(function (accessor) {
            var keys = Object.keys(_zoneMeta);
            for (var i = 0; i < keys.length; i++) {
              accessor.removeZone(_zoneMeta[keys[i]].zoneId);
            }
          });
        }
      } catch (e) { /* ignore */ }
    }
    _zoneMeta = {};

    // 移除所有 ContentWidget
    _removeAllIconWidgets();

    // 清理事件
    var domNode = _editor && _editor.getDomNode && _editor.getDomNode();
    if (domNode) {
      domNode.removeEventListener('keydown', _onKeyDown, true);
    }

    for (var j = 0; j < _disposables.length; j++) {
      try { _disposables[j].dispose(); } catch (e) { /* ignore */ }
    }
    _disposables = [];
  }

  function dispose() {
    _doCleanup();
    _editor = null;
    _monaco = null;
    _attached = false;
  }

  function refresh() {
    _removeAllIconWidgets();
    // ViewZones 通过 _syncAll 重建
    _syncAll();
  }

  window.qqqViewZone = {
    attach: attach,
    dispose: dispose,
    refresh: refresh,
    _syncAll: _syncAll,
  };

})();
