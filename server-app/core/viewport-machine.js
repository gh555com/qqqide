// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// viewport-machine.js — 中心视口管线（唯一真理机）
//
// ★ 消灭大脑分裂:
//   旧: qqqViewZone / qqqAnchorMap / qqqPasteRouter 是全局单例
//       → 多面板时最后一个 attach 的 editor 胜出，其余全部丢图
//       → 6 条代码路径各自 call attach/dispose，竞态 → "not a child" 崩溃
//
//   新: 每个 editor 独立 EditorViewport 实例（Map keyed by editor）
//       → 所有生命周期事件走 ONE 入口: ViewportMachine.transition()
//       → 穷举一切触发条件，确定性状态机，绝不大脑分裂
//
// 穷举触发条件 (9 种):
//   ① 'created'   — editor 创建完成 (openInPane / build)
//   ② 'focused'   — tab 激活 → editor 获得焦点
//   ③ 'blurred'   — tab 切走 → editor 失焦
//   ④ 'hidden'    — pane display:none（tab 切走、新 tab 在另一组打开）
//   ⑤ 'visible'   — pane display 恢复
//   ⑥ 'closing'   — tab 即将关闭（必须先清理 ViewZone，再 dispose editor）
//   ⑦ 'disposed'  — editor 已被 Monaco dispose
//   ⑧ 'resized'   — 窗口/面板 resize → layout
//   ⑨ 'startup'   — 窗口首次启动 → 主编辑器就绪
//
// 暴露: window.qqqViewportMachine
// ============================================================================

(function () {
  'use strict';

  // ═══ Per-Editor Viewport 实例 ═══
  // 每个 Monaco editor 拥有自己独立的 viewport，不再是全局单例

  function EditorViewport(editor, monaco, filePath) {
    this.editor = editor;
    this.monaco = monaco;
    this.filePath = filePath;
    this.state = 'idle';   // idle | active | suspended | closed

    // ── ViewZone 元数据 ──
    this._zoneMeta = {};       // { "line:col" → { zoneId, frameDom, entry } }

    // ── ContentWidget 元数据（图标框: 文件/目录/音频/文本）──
    this._iconWidgets = {};    // { "line:col" → { widget, domNode, entry } }
    this._widgetSeq = 0;

    // ── Anchor Map（per-editor，独立扫描）──
    this._anchorMap = {};

    // ── Paste handler ──
    this._pasteHandler = null;

    // ── Disposables ──
    this._disposables = [];
    this._syncTimer = null;

    // ── 常量 ──
    this.MEDIA_LARGE_HEIGHT = 330;
    this.ANCHOR_REGEX = /\u{1F4CE}([a-fA-F0-9]{0,64}):([^\s\u{1F4CE}\u{1F4C1}]+)/gu;
  }

  // ═══ 主入口: ViewportMachine ═══

  var _machine = {
    // Map<editorInstance, EditorViewport>
    _registry: new Map(),
    _frameRenderer: null,
    _initialized: false,

    // ── 初始化（一次）──
    init: function () {
      if (this._initialized) return;
      this._frameRenderer = window.qqqFrameRenderer;
      this._initialized = true;
    },

    // ── 唯一真理过渡函数 ──
    // event: 'created'|'focused'|'blurred'|'hidden'|'visible'|'closing'|'disposed'|'resized'|'startup'
    // editor: Monaco editor 实例
    // filePath: 文件路径 (可选，closing/disposed 时可为 null)
    transition: function (event, editor, filePath) {
      if (!editor) return;
      this.init();

      switch (event) {
        case 'created':
          this._onCreated(editor, filePath);
          break;
        case 'focused':
          this._onFocused(editor);
          break;
        case 'blurred':
          this._onBlurred(editor);
          break;
        case 'hidden':
          this._onHidden(editor);
          break;
        case 'visible':
          this._onVisible(editor);
          break;
        case 'closing':
          this._onClosing(editor);
          break;
        case 'disposed':
          this._onDisposed(editor);
          break;
        case 'resized':
          this._onResized(editor);
          break;
        case 'startup':
          this._onStartup(editor, filePath);
          break;
        default:
          break;
      }
    },

    // ═══ 事件处理器 ═══

    // ① created: editor 创建完成，初始构建
    _onCreated: function (editor, filePath) {
      var vp = this._registry.get(editor);
      if (!vp) {
        vp = new EditorViewport(editor, window.monaco, filePath);
        this._registry.set(editor, vp);
      }
      vp.state = 'active';
      vp.filePath = filePath || vp.filePath;

      // 监听 editor dispose（最后一道防线）
      this._hookDispose(editor, vp);

      // 初始扫描 + 构建
      this._fullScanAnchors(vp);
      this._syncAll(vp);

      // 订阅 model 变更（增量更新 anchor map）
      this._hookModelChange(editor, vp);

      // 挂载 paste handler
      this._attachPasteHandler(editor, vp);
    },

    // ② focused: tab 激活，editor 获得焦点
    _onFocused: function (editor) {
      var vp = this._registry.get(editor);
      if (!vp) return;

      if (vp.state === 'suspended') {
        // 从挂起恢复：重扫 anchor map（文件可能被外部修改），重建 widgets
        vp.state = 'active';
        this._fullScanAnchors(vp);
        this._syncAll(vp);
        // 恢复 layout
        try { editor.updateOptions({ automaticLayout: true }); } catch (_) {}
        try { editor.layout(); } catch (_) {}
      } else if (vp.state === 'active') {
        // 已 active，仅刷新（文件可能已被其他面板修改）
        this._checkDirtyAndRefresh(vp);
      }
    },

    // ③ blurred: editor 失焦
    _onBlurred: function (editor) {
      var vp = this._registry.get(editor);
      if (!vp) return;
      // 失焦不销毁，widgets 保持。仅暂停自动 layout。
    },

    // ④ hidden: pane display:none
    _onHidden: function (editor) {
      var vp = this._registry.get(editor);
      if (!vp) return;
      vp.state = 'suspended';
      try { editor.updateOptions({ automaticLayout: false }); } catch (_) {}
      // ★ 不销毁 widgets！display:none 时 Monaco 内部保留 DOM 结构，
      //   销毁后重建比保留更昂贵且引入 flicker。
    },

    // ⑤ visible: pane display 恢复
    _onVisible: function (editor) {
      var vp = this._registry.get(editor);
      if (!vp) return;
      if (vp.state === 'suspended') {
        vp.state = 'active';
        try { editor.updateOptions({ automaticLayout: true }); } catch (_) {}
        try { editor.layout(); } catch (_) {}
        // 重扫+重建（文件可能被外部修改）
        this._fullScanAnchors(vp);
        this._syncAll(vp);
      }
    },

    // ⑥ closing: tab 即将关闭 — 必须在此阶段清理 ViewZone/ContentWidget
    //   （editor 尚存活 → changeViewZones/removeContentWidget 可正常执行）
    //   若等 disposed 再清 → Monaco 内部 dispose 先跑了 → "not a child" 崩溃
    _onClosing: function (editor) {
      var vp = this._registry.get(editor);
      if (!vp) return;
      vp.state = 'closed';
      this._cleanupViewport(vp);
    },

    // ⑦ disposed: editor 已被 dispose（最后防线，仅做簿记清理）
    _onDisposed: function (editor) {
      var vp = this._registry.get(editor);
      if (!vp) return;
      vp.state = 'closed';
      // 此时 editor 已 dispose，不能再调 changeViewZones 等
      // 仅清理 JS 引用
      vp._zoneMeta = {};
      vp._iconWidgets = {};
      vp._anchorMap = {};
      vp._disposables = [];
      if (vp._syncTimer) clearTimeout(vp._syncTimer);
      this._registry.delete(editor);
    },

    // ⑧ resized: 窗口/面板 resize
    _onResized: function (editor) {
      try { editor.layout(); } catch (_) {}
    },

    // ⑨ startup: 窗口首次启动，主编辑器就绪
    _onStartup: function (editor, filePath) {
      // 同 created，但额外做一次延迟刷新（等 DOM 稳定）
      this._onCreated(editor, filePath);
      var self = this;
      setTimeout(function () {
        var vp = self._registry.get(editor);
        if (vp && vp.state === 'active') {
          try { editor.layout(); } catch (_) {}
          self._syncAll(vp);
        }
      }, 500);
    },

    // ═══ 内部方法 ═══

    // 监听 editor dispose（最后防线：仅做簿记）
    _hookDispose: function (editor, vp) {
      try {
        var dd = editor.onDidDispose(function () {
          // 如果 state 不是 closed，说明 closing 没被调用（异常路径）
          // 此时 editor 已 dispose，不能再调 changeViewZones
          if (vp.state !== 'closed') {
            vp.state = 'closed';
            vp._zoneMeta = {};
            vp._iconWidgets = {};
            vp._anchorMap = {};
          }
          // 清理 listener
          for (var i = 0; i < vp._disposables.length; i++) {
            try { vp._disposables[i].dispose(); } catch (_) {}
          }
          vp._disposables = [];
          if (vp._syncTimer) clearTimeout(vp._syncTimer);
          _machine._registry.delete(editor);
        });
        vp._disposables.push(dd);
      } catch (e) { /* ignore */ }
    },

    // 监听 model 变更 → 增量更新 anchor map
    _hookModelChange: function (editor, vp) {
      var model = editor.getModel();
      if (!model) return;
      try {
        var d1 = model.onDidChangeContent(function (e) {
          _machine._onModelChange(vp, e);
        });
        vp._disposables.push(d1);
      } catch (e) { /* ignore */ }
    },

    // 挂载 paste handler
    _attachPasteHandler: function (editor, vp) {
      var domNode = editor.getDomNode && editor.getDomNode();
      if (!domNode) return;

      var handler = function (e) {
        _machine._handlePaste(editor, vp, e);
      };
      domNode.addEventListener('paste', handler, true);
      vp._pasteHandler = { node: domNode, fn: handler };

      // 空格键
      var keyHandler = function (e) {
        _machine._handleSpaceKey(editor, vp, e);
      };
      domNode.addEventListener('keydown', keyHandler, true);
      vp._spaceKeyHandler = { node: domNode, fn: keyHandler };
    },

    // ═══ Anchor Map 扫描 ═══

    _posKey: function (line, col) {
      return line + ':' + col;
    },

    _guessType: function (fileName) {
      if (/\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff|avif)$/i.test(fileName)) return 'image';
      if (/\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|mpg)$/i.test(fileName)) return 'video';
      if (/\.(mp3|wav|flac|ogg|m4a|aac|wma|opus)$/i.test(fileName)) return 'audio';
      return 'file';
    },

    _fullScanAnchors: function (vp) {
      var editor = vp.editor;
      if (!editor) return;
      var model = editor.getModel();
      if (!model) return;

      var text = model.getValue();
      var newMap = {};

      // Build base dirs (same as old anchor-map.js)
      var baseDirs = [];
      var cf = vp.filePath;
      if (!cf) {
        try { cf = editor._qqqFilePath; } catch (_) {}
      }
      if (cf) {
        var sep = cf.indexOf('\\') >= 0 ? '\\' : '/';
        var cfDir = cf.slice(0, cf.lastIndexOf(sep));
        if (cfDir) {
          baseDirs.push(cfDir + sep + '_qqqvault');
          baseDirs.push(cfDir);
        }
      }
      if (window._workspaceRoot) {
        var ws = window._workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
        baseDirs.push(ws + '/_qqqvault');
        baseDirs.push(ws);
      }

      var regex = vp.ANCHOR_REGEX;
      regex.lastIndex = 0;
      var match;
      while ((match = regex.exec(text)) !== null) {
        var sha256 = match[1];
        var fileName = match[2];
        var pos = model.getPositionAt(match.index);
        var key = this._posKey(pos.lineNumber, pos.column);

        var resolvedPath = null;
        for (var bi = 0; bi < baseDirs.length; bi++) {
          var candidate = baseDirs[bi] + '/' + fileName;
          if (!resolvedPath) resolvedPath = candidate;
        }

        newMap[key] = {
          type: this._guessType(fileName),
          path: resolvedPath,
          sha256: sha256.toLowerCase(),
          fileName: fileName,
          line: pos.lineNumber,
          col: pos.column,
        };
      }

      vp._anchorMap = newMap;
    },

    // 增量更新 anchor map（model 变更时）
    _onModelChange: function (vp, e) {
      if (!e || !e.changes) return;
      var hasChange = false;
      for (var i = 0; i < e.changes.length; i++) {
        var change = e.changes[i];
        var range = change.range;
        var newText = change.text || '';

        // 1. 移除被删除/替换范围内的条目
        var newMap = {};
        var keys = Object.keys(vp._anchorMap);
        for (var k = 0; k < keys.length; k++) {
          var entry = vp._anchorMap[keys[k]];
          if (!this._isInRange(entry, range)) {
            newMap[keys[k]] = entry;
          }
        }
        vp._anchorMap = newMap;

        // 2. 计算偏移
        var newLines = newText.split('\n');
        var newLineCount = newLines.length;
        var oldLineSpan = range.endLineNumber - range.startLineNumber + 1;
        var deltaLines = newLineCount - oldLineSpan;

        // 3. 偏移后续条目
        if (deltaLines !== 0) {
          var shiftedMap = {};
          keys = Object.keys(vp._anchorMap);
          for (var s = 0; s < keys.length; s++) {
            var ent = vp._anchorMap[keys[s]];
            if (ent.line > range.endLineNumber) {
              ent.line += deltaLines;
            }
            shiftedMap[this._posKey(ent.line, ent.col)] = ent;
          }
          vp._anchorMap = shiftedMap;
        }

        // 4. 扫描新文本中的锚点
        if (newText.indexOf('📎') >= 0) {
          this._scanTextIntoMap(vp, newText, range.startLineNumber, range.startColumn);
        }

        hasChange = true;
      }

      if (hasChange) {
        this._scheduleSync(vp);
      }
    },

    _isInRange: function (entry, range) {
      if (entry.line < range.startLineNumber) return false;
      if (entry.line === range.startLineNumber && entry.col < range.startColumn) return false;
      if (entry.line > range.endLineNumber) return false;
      if (entry.line === range.endLineNumber && entry.col >= range.endColumn) return false;
      return true;
    },

    _scanTextIntoMap: function (vp, text, startLine, startCol) {
      var model = vp.editor && vp.editor.getModel();
      if (!model) return;

      var regex = vp.ANCHOR_REGEX;
      regex.lastIndex = 0;
      var match;
      while ((match = regex.exec(text)) !== null) {
        var sha256 = match[1];
        var fileName = match[2];
        var offset = match.index;
        var linesBefore = text.substring(0, offset).split('\n');
        var line = startLine + linesBefore.length - 1;
        var col = (linesBefore.length === 1 ? startCol : 0) + linesBefore[linesBefore.length - 1].length;
        var key = this._posKey(line, col);
        vp._anchorMap[key] = {
          type: this._guessType(fileName),
          path: null,
          sha256: sha256.toLowerCase(),
          fileName: fileName,
          line: line,
          col: col,
        };
      }
    },

    // ═══ ViewZone + ContentWidget 同步 ═══

    _scheduleSync: function (vp) {
      if (vp._syncTimer) clearTimeout(vp._syncTimer);
      var self = this;
      vp._syncTimer = setTimeout(function () {
        self._syncAll(vp);
      }, 100);
    },

    _syncAll: function (vp) {
      var editor = vp.editor;
      if (!editor || vp.state === 'closed') return;
      if (typeof editor.changeViewZones !== 'function') return;

      var allEntries = Object.values(vp._anchorMap);
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

      this._syncMediaZones(vp, mediaEntries);
      this._syncIconWidgets(vp, iconEntries);
    },

    _syncMediaZones: function (vp, entries) {
      var editor = vp.editor;
      if (typeof editor.changeViewZones !== 'function') return;

      var self = this;
      editor.changeViewZones(function (accessor) {
        var currentKeys = {};
        for (var i = 0; i < entries.length; i++) {
          currentKeys[self._posKey(entries[i].line, entries[i].col)] = true;
        }

        // 移除不属于当前 entries 的 zone
        var oldKeys = Object.keys(vp._zoneMeta);
        for (var j = 0; j < oldKeys.length; j++) {
          if (!currentKeys[oldKeys[j]]) {
            accessor.removeZone(vp._zoneMeta[oldKeys[j]].zoneId);
            delete vp._zoneMeta[oldKeys[j]];
          }
        }

        // 创建/更新 zone
        for (var k = 0; k < entries.length; k++) {
          var entry = entries[k];
          var key = self._posKey(entry.line, entry.col);
          var existing = vp._zoneMeta[key];

          if (existing &&
              existing.entry.line === entry.line &&
              existing.entry.col === entry.col &&
              existing.entry.path === entry.path &&
              existing.entry.fileName === entry.fileName) {
            continue;
          }

          if (existing) {
            accessor.removeZone(existing.zoneId);
            delete vp._zoneMeta[key];
          }

          var frameRenderer = self._frameRenderer;
          if (!frameRenderer || !frameRenderer.buildFrame) continue;
          var frameDom = frameRenderer.buildFrame(entry);
          if (!frameDom) continue;

          frameDom.classList.add('qqq-vz-media');

          var zoneId = accessor.addZone({
            afterLineNumber: entry.line,
            heightInPx: vp.MEDIA_LARGE_HEIGHT,
            domNode: frameDom,
          });

          vp._zoneMeta[key] = {
            zoneId: zoneId,
            frameDom: frameDom,
            entry: { line: entry.line, col: entry.col, path: entry.path, fileName: entry.fileName },
          };
        }
      });

      // 异步加载缩略图
      var metaKeys = Object.keys(vp._zoneMeta);
      var frameRenderer = self._frameRenderer;
      for (var m = 0; m < metaKeys.length; m++) {
        var meta = vp._zoneMeta[metaKeys[m]];
        if (meta.frameDom && meta.entry.path && frameRenderer && frameRenderer.loadThumbnail) {
          frameRenderer.loadThumbnail(meta.frameDom, { path: meta.entry.path, fileName: meta.entry.fileName });
        }
      }
    },

    _syncIconWidgets: function (vp, entries) {
      var editor = vp.editor;
      var monaco = vp.monaco;
      if (!editor || !monaco) return;
      if (typeof editor.layoutContentWidgets !== 'function') return;

      var currentKeys = {};
      var hasChanges = false;

      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var key = this._posKey(entry.line, entry.col);
        currentKeys[key] = true;

        if (!vp._iconWidgets[key]) {
          this._createIconWidget(vp, entry, key);
          hasChanges = true;
        } else {
          var existing = vp._iconWidgets[key];
          if (existing.entry.line !== entry.line || existing.entry.col !== entry.col ||
              existing.entry.path !== entry.path || existing.entry.fileName !== entry.fileName) {
            this._removeIconWidget(vp, key);
            this._createIconWidget(vp, entry, key);
            hasChanges = true;
          }
        }
      }

      var oldKeys = Object.keys(vp._iconWidgets);
      for (var j = 0; j < oldKeys.length; j++) {
        if (!currentKeys[oldKeys[j]]) {
          this._removeIconWidget(vp, oldKeys[j]);
          hasChanges = true;
        }
      }

      if (hasChanges) {
        editor.layoutContentWidgets();
      }
    },

    _createIconWidget: function (vp, entry, key) {
      var frameRenderer = this._frameRenderer;
      if (!frameRenderer || !frameRenderer.buildFrame) return;

      var frameDom = frameRenderer.buildFrame(entry);
      if (!frameDom) return;

      var widgetId = 'qqq-vp-cw-' + (++vp._widgetSeq);
      var widget = {
        getId: function () { return widgetId; },
        getDomNode: function () { return frameDom; },
        getPosition: function () {
          return {
            position: { lineNumber: entry.line, column: entry.col },
            preference: [vp.monaco.editor.ContentWidgetPositionPreference.BELOW],
          };
        },
      };

      vp.editor.addContentWidget(widget);
      vp._iconWidgets[key] = { widget: widget, domNode: frameDom, entry: entry };
    },

    _removeIconWidget: function (vp, key) {
      var w = vp._iconWidgets[key];
      if (w && vp.editor) {
        try { vp.editor.removeContentWidget(w.widget); } catch (e) { /* ignore */ }
      }
      delete vp._iconWidgets[key];
    },

    // ═══ 清理 — 仅在 closing 阶段调用（editor 尚存活）═══

    _cleanupViewport: function (vp) {
      if (vp._syncTimer) clearTimeout(vp._syncTimer);

      var editor = vp.editor;

      // 移除所有 ViewZone（editor 尚存活 → changeViewZones 可用）
      if (editor && typeof editor.changeViewZones === 'function') {
        try {
          var model = editor.getModel && editor.getModel();
          if (model && !model.isDisposed()) {
            editor.changeViewZones(function (accessor) {
              var keys = Object.keys(vp._zoneMeta);
              for (var i = 0; i < keys.length; i++) {
                accessor.removeZone(vp._zoneMeta[keys[i]].zoneId);
              }
            });
          }
        } catch (e) { /* ignore */ }
      }
      vp._zoneMeta = {};

      // 移除所有 ContentWidget
      var iconKeys = Object.keys(vp._iconWidgets);
      for (var j = 0; j < iconKeys.length; j++) {
        this._removeIconWidget(vp, iconKeys[j]);
      }
      vp._iconWidgets = {};

      // 移除 DOM 事件监听
      if (vp._pasteHandler) {
        try { vp._pasteHandler.node.removeEventListener('paste', vp._pasteHandler.fn, true); } catch (_) {}
        vp._pasteHandler = null;
      }
      if (vp._spaceKeyHandler) {
        try { vp._spaceKeyHandler.node.removeEventListener('keydown', vp._spaceKeyHandler.fn, true); } catch (_) {}
        vp._spaceKeyHandler = null;
      }

      // 清理 Monaco disposables（model change listener 等）
      for (var k = 0; k < vp._disposables.length; k++) {
        try { vp._disposables[k].dispose(); } catch (e) { /* ignore */ }
      }
      vp._disposables = [];

      vp._anchorMap = {};
    },

    // ═══ 外部修改检测 + 刷新 ═══

    _checkDirtyAndRefresh: function (vp) {
      // 简化版：仅重新 layout + sync
      var editor = vp.editor;
      try { editor.layout(); } catch (_) {}
      this._fullScanAnchors(vp);
      this._syncAll(vp);
    },

    // ═══ Paste 处理器 ═══

    _handlePaste: function (editor, vp, e) {
      // 核心粘贴路由 — 委托给已有的 klipzap + paste-router 管线
      // 但编辑器的锚点映射使用 vp._anchorMap 而非全局单例
      if (window.qqqideKlipzap && window.qqqideKlipzap.probe) {
        try {
          var probe = window.qqqideKlipzap.probe(e);
          if (probe.isPureText) return; // Monaco 原生处理
          e.preventDefault();
          // 交给 paste-router，但注入我们的 editor
          if (window.qqqPasteRouter && window.qqqPasteRouter.handlePaste) {
            window.qqqPasteRouter.handlePaste(e, editor);
          }
        } catch (ex) {
          // 异常回退：让 Monaco 原生处理
        }
      }
    },

    // ═══ 空格键 → 探测媒体信息 ═══

    _handleSpaceKey: function (editor, vp, e) {
      if (e.keyCode !== 32) return;
      var pos = editor.getPosition();
      if (!pos) return;

      var entry = null;
      var keys = Object.keys(vp._anchorMap);
      for (var i = 0; i < keys.length; i++) {
        var e2 = vp._anchorMap[keys[i]];
        if (e2.line === pos.lineNumber && Math.abs(e2.col - pos.column) <= 3) {
          entry = e2;
          break;
        }
      }
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
    },

    // ═══ 查询 API ═══

    // 获取 editor 对应的 anchor map（只读引用）
    getAnchors: function (editor) {
      var vp = this._registry.get(editor);
      return vp ? vp._anchorMap : {};
    },

    // 获取光标附近的锚点
    getAnchorNear: function (editor, line, col, tolerance) {
      var vp = this._registry.get(editor);
      if (!vp) return null;
      tolerance = tolerance || 3;
      for (var dc = -tolerance; dc <= tolerance; dc++) {
        var key = this._posKey(line, col + dc);
        if (vp._anchorMap[key]) return vp._anchorMap[key];
      }
      return null;
    },

    // 强制刷新指定 editor
    refresh: function (editor) {
      var vp = this._registry.get(editor);
      if (!vp || vp.state === 'closed') return;
      this._fullScanAnchors(vp);
      this._syncAll(vp);
    },
  };

  // ═══ 向后兼容桥: 旧代码仍可调用 qqqViewZone/qqqAnchorMap/qqqPasteRouter ═══
  // 它们现在通过 ViewportMachine 代理，不再是独立单例

  // 当前"活跃" editor（向后兼容：取最后一个 created 的 editor）
  var _activeCompatEditor = null;

  window.qqqViewportMachine = _machine;

  // 向后兼容 shim: window.qqqAnchorMap
  window.qqqAnchorMap = {
    attach: function (editor, monaco) {
      _activeCompatEditor = editor;
      _machine.transition('created', editor, (editor._qqqFilePath || ''));
    },
    dispose: function () {
      if (_activeCompatEditor) {
        _machine.transition('closing', _activeCompatEditor);
      }
    },
    getAt: function (line, col) {
      return _machine.getAnchorNear(_activeCompatEditor, line, col, 0);
    },
    getNear: function (line, col, tolerance) {
      return _machine.getAnchorNear(_activeCompatEditor, line, col, tolerance);
    },
    getAll: function () {
      return Object.values(_machine.getAnchors(_activeCompatEditor));
    },
    setWidgetId: function () { /* no-op in new architecture */ },
    onChange: function (fn) {
      // 简化：不做变更推送（ViewportMachine 内部自同步）
    },
  };

  // 向后兼容 shim: window.qqqViewZone
  window.qqqViewZone = {
    attach: function (editor, monaco) {
      _activeCompatEditor = editor;
      _machine.transition('created', editor, (editor._qqqFilePath || ''));
    },
    dispose: function () {
      if (_activeCompatEditor) {
        _machine.transition('closing', _activeCompatEditor);
      }
    },
    refresh: function () {
      if (_activeCompatEditor) {
        _machine.refresh(_activeCompatEditor);
      }
    },
    _syncAll: function () {
      if (_activeCompatEditor) {
        _machine.refresh(_activeCompatEditor);
      }
    },
  };

  // 向后兼容 shim: window.qqqContentWidget (已合并到 qqqViewZone)
  window.qqqContentWidget = {
    attach: function () { /* no-op — ViewportMachine handles everything */ },
    dispose: function () {},
    refresh: function () {
      if (_activeCompatEditor) _machine.refresh(_activeCompatEditor);
    },
    _syncWidgets: function () {},
  };

})();
