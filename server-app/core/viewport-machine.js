// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// viewport-machine.js — 中心视口管线（唯一真理机）
//
// ★ 消灭大脑分裂:
//   历史上 qqqViewZone / qqqAnchorMap / qqqContentWidget 是三个全局单例
//       → 多面板时最后一个 attach 的 editor 胜出，其余全部丢图
//       → 多条代码路径各自 call attach/dispose，竞态 → "not a child" 崩溃
//   2026-09-14: 三个旧模块已整体删除（并行实现=大脑分裂温床），
//   本机是相框渲染与锚点表的唯一真相（paste-router 通过 registerPastedAnchor 对接）。
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

    // ── 相框缓存（帧 DOM 异步构建；key="line:col"）──
    this._frameCache = {};     // { "line:col" → { path, fileName, variant, frameDom } | null }
    this._building = {};       // 在建防重入
    this._hideDeco = null;     // 锚点原文隐藏（老 markerHideType 对齐）

    // ── 同步串行（异步建帧不并发）──
    this._syncRunning = false;
    this._syncQueued = false;

    // ── Anchor Map（per-editor，独立扫描）──
    this._anchorMap = {};

    // ── Paste handler ──
    this._pasteHandler = null;

    // ── Disposables ──
    this._disposables = [];
    this._syncTimer = null;
    this._fontTimer = null;          // 字号/行高变更 → 几何重排去抖
    this._forceLiftRebuild = false;  // 一次性强制：下一轮 zone 全量 remove+add（Monaco 增量布局陈旧清零）

    // ── 常量 ──
    //   帧高度不再硬编码：frameDom._zoneH 由 frame-renderer 按帧族/偏好/媒体尺寸算出
    //   锚点格式 v2：引号式（文件名含空白/锚点字符时）| 裸名式（向后兼容）
    //   语法: 📎{sha≤64}:{名} | 📎{sha≤64}:"{含空格 名}"
    this.ANCHOR_REGEX = /\u{1F4CE}([a-fA-F0-9]{0,64}):(?:"([^"\r\n]+)"|([^\s\u{1F4CE}\u{1F4C1}]+))/gu;
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

      // ★ 偏好变更（性能模式/相框尺寸/放大/文本胶片/水印）→ 全量重建相框
      //   偏好本体永不落盘（qqq-prefs 铁律），变更只发生在本会话
      var self = this;
      try {
        if (window.qqqPrefs && window.qqqPrefs.onChange) {
          window.qqqPrefs.onChange(function () { self._invalidateFrames(); });
        }
      } catch (e) { /* */ }
    },

    // 帧缓存失效 → 全量重建（偏好切换 / 水印状态切换）
    _invalidateFrames: function () {
      var self = this;
      this._registry.forEach(function (vp) {
        vp._frameCache = {};
        vp._building = {};
        self._scheduleSync(vp);
      });
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

      // 订阅配置变更（字号/行高/折行 → 帧几何整批重排）
      this._hookConfigChange(editor, vp);

      // 订阅布局变更（窗口/面板 resize → 折行数可能变化 → 锚点行真实高度变化 → 帧几何自愈）
      this._hookLayoutChange(editor, vp);

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
      vp._frameCache = {};
      vp._hideDeco = null;
      vp._hideSig = '';
      vp._anchorMap = {};
      vp._disposables = [];
      if (vp._syncTimer) clearTimeout(vp._syncTimer);
      if (vp._fontTimer) clearTimeout(vp._fontTimer);
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
            vp._frameCache = {};
            vp._anchorMap = {};
          }
          // 清理 listener
          for (var i = 0; i < vp._disposables.length; i++) {
            try { vp._disposables[i].dispose(); } catch (_) {}
          }
          vp._disposables = [];
          if (vp._syncTimer) clearTimeout(vp._syncTimer);
          if (vp._fontTimer) clearTimeout(vp._fontTimer);
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

    // 监听 editor 配置变更（字号/行高）→ 帧几何整批重排
    //   ★ 帧上提 marginTop=-rowH 与 zone 高度减 (rowH+4) 都是「行真实高度」的函数：只读一次的实现
    //   在字号变更后几何必漂（字号调大 → 折行/空隙；调小 → 重叠），且中途任何一次 sync 会在错误
    //   高度下固化错误几何（回改字号也修不回，须手动重排才复活）
    _hookConfigChange: function (editor, vp) {
      if (vp._cfgHooked) return;   // 幂等：created 可能多次进入（build/openInPane 路径），监听只挂一次
      if (typeof editor.onDidChangeConfiguration !== 'function') return;
      vp._cfgHooked = true;
      try {
        var d = editor.onDidChangeConfiguration(function (e) {
          var hit = false;
          try {
            var EO = (vp.monaco && vp.monaco.editor && vp.monaco.editor.EditorOption) ? vp.monaco.editor.EditorOption : null;
            if (EO && typeof e.hasChanged === 'function') {
              if (EO.fontSize != null && e.hasChanged(EO.fontSize)) hit = true;
              if (!hit && EO.lineHeight != null && e.hasChanged(EO.lineHeight)) hit = true;
              if (!hit && EO.wordWrap != null && e.hasChanged(EO.wordWrap)) hit = true;
            } else {
              hit = true;   // 读不到 option id → 保守触发（重排幂等，代价 = 一次几何比对）
            }
          } catch (_e) { hit = true; }
          if (hit) { _machine._scheduleFontRelayout(vp); }
        });
        vp._disposables.push(d);
      } catch (e0) { /* ignore */ }
    },

    // 监听 editor 布局变更（窗口/面板 resize、编辑器宽度变化 → 折行数可能变化）
    //   不整批重排：只 scheduleSync —— _buildAndApply 的 stale 检查按当前 rowH 逐条比对，
    //   真变化的条目才 remove+add；resize 高频但多数无变化 → 零成本跳过。
    _hookLayoutChange: function (editor, vp) {
      if (vp._layoutHooked) return;
      if (typeof editor.onDidLayoutChange !== 'function') return;
      vp._layoutHooked = true;
      try {
        var d = editor.onDidLayoutChange(function () {
          if (vp.state === 'closed') return;
          _machine._scheduleSync(vp);
        });
        vp._disposables.push(d);
      } catch (e) { /* ignore */ }
    },

    // 锚点行的「真实渲染高度」（含折行）：rowH = 行高 × 折行数
    //   为什么需要它：隐藏令牌（透明）仍占宽——超大字号/窄窗口下会折行（42 号字实测折 3 行 = 171px），
    //   只按编辑器行高(57)上提 → 帧只盖住首行，剩余折行区 = 空气墙（lens 与相框间 114px 空洞）。
    //   公式：getTopForPosition(行, 末列) − getTopForLineNumber(行) + 行高 = 整行高度
    //   （同一模型行内部无 zone，差值纯净；读写皆安全，不依赖 Monaco 内部结构）。
    _rowHeightAt: function (editor, line) {
      try {
        if (typeof editor.getTopForPosition !== 'function') return 0;
        var model = editor.getModel && editor.getModel();
        if (!model || line < 1 || line > model.getLineCount()) return 0;
        var lh = 0;
        try {
          var EO = (window.monaco && window.monaco.editor && window.monaco.editor.EditorOption) ? window.monaco.editor.EditorOption : null;
          var lv = (typeof editor.getOption === 'function') ? editor.getOption(EO ? EO.lineHeight : 61) : 0;
          lh = (typeof lv === 'number' && lv > 0) ? lv : 0;
        } catch (_e1) { lh = 0; }
        if (!lh) return 0;
        var tTop = editor.getTopForLineNumber(line);
        var tEnd = editor.getTopForPosition(line, model.getLineMaxColumn(line));
        var h = Math.round(tEnd - tTop) + lh;
        return (h >= lh) ? h : lh;
      } catch (e) { return 0; }
    },

    // 字号/行高变更 → 去抖重排（连点 +/- 只在停手后跑一次）
    //   _forceLiftRebuild = 一次性强制：stale 检查在行高相同时零动作，这里要求下一轮把全部
    //   zone remove+add（remove+add = Monaco 全量重算 zone 偏移，任何增量布局陈旧一并根治）
    _scheduleFontRelayout: function (vp) {
      vp._forceLiftRebuild = true;
      if (vp._fontTimer) clearTimeout(vp._fontTimer);
      var self = this;
      vp._fontTimer = setTimeout(function () {
        vp._fontTimer = null;
        // ★ 只避 closed：suspended 不禁（suspend/resume 可能不成对——历史状态泄漏，“可见却记挂 suspended”
        //   会把字号重排永久挂起；重排是纯几何+DOM 操作，隐藏面板执行无害）
        if (vp.state === 'closed') return;
        self._syncAll(vp);
      }, 160);
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

    // 旧式裸令牌空格截断补偿：token 后若紧跟空白 → 取本行剩余（至行尾/下一锚点）作为完整名候选
    //   历史令牌（📎:松尾早人 - ...mp3）在空格处截断成「松尾早人」→ 解析必然落空；
    //   本函数回收被截断的尾部，交由异步解析器 exists 校验后决定是否采信（不存在自动回落裸名）
    _lineTail: function (text, offset) {
      if (!text || offset >= text.length) return '';
      if (!/\s/.test(text.charAt(offset))) return '';   // 必须紧跟空白（截断特征）
      // ★ 必须带 u 标志：无 u 时 \u{XXXX} 在字符类里退化为字面字符（误排除 u/E/F/1/4/C 等）
      var m = text.slice(offset).match(/^[^\n\r\u{1F4CE}\u{1F4C1}]*/u);
      var tail = m ? m[0].replace(/\s+$/, '') : '';
      return tail.trim() ? tail : '';
    },

    // 锚点路径候选根（.qqqvault 优先；同目录裸路径兑底）
    _baseDirs: function (vp) {
      var baseDirs = [];
      var cf = vp.filePath;
      if (!cf) {
        try { cf = vp.editor && vp.editor._qqqFilePath; } catch (_) {}
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
      return baseDirs;
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

      // 已解析路径沿袭表（fileName → path）：重扫（聚焦/切标签）不丢已有路径，
      //   否则路径归零 → 帧缓存被清 → 全部重建（可见闪烁）+ 重复 IPC
      var prevPaths = {};
      var pk = Object.keys(vp._anchorMap);
      for (var pi = 0; pi < pk.length; pi++) {
        var pe = vp._anchorMap[pk[pi]];
        if (pe && pe.fileName && pe.path && !prevPaths[pe.fileName]) prevPaths[pe.fileName] = pe.path;
      }

      var regex = vp.ANCHOR_REGEX;
      regex.lastIndex = 0;
      var match;
      while ((match = regex.exec(text)) !== null) {
        var sha256 = match[1];
        var fileName = match[2] || match[3];   // 引号式 | 裸名式
        var pos = model.getPositionAt(match.index);
        var key = this._posKey(pos.lineNumber, pos.column);

        // path：优先沿袭已解析值；无沿袭 → null 交异步解析器（候选根逐个 exists 校验回填）。
        //   旧实现在此直接取「首候选根」假路径（不校验存在性）→ 文件不在该根时永远裂/空帧，
        //   且掩盖了需要走空格补偿的旧令牌。
        var entry = {
          type: this._guessType(fileName),
          path: prevPaths[fileName] || null,
          sha256: sha256.toLowerCase(),
          fileName: fileName,
          line: pos.lineNumber,
          col: pos.column,
          _rawLen: match[0].length,   // 原文隐藏长度 = 令牌真实字符数（含引号）
        };
        if (!match[2]) {
          var tail = this._lineTail(text, match.index + match[0].length);
          if (tail) entry._tail = tail;
        }
        newMap[key] = entry;
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
        var fileName = match[2] || match[3];
        var offset = match.index;
        var linesBefore = text.substring(0, offset).split('\n');
        var line = startLine + linesBefore.length - 1;
        var lastLen = linesBefore[linesBefore.length - 1].length;
        // 列号：单行片段 = startCol + 前缀长；跨行片段 = 行内前缀长 + 1（Monaco 列从 1 起，旧公式跨行少 1）
        var col = linesBefore.length === 1 ? (startCol + lastLen) : (lastLen + 1);
        var key = this._posKey(line, col);
        var entry = {
          type: this._guessType(fileName),
          path: null,
          sha256: sha256.toLowerCase(),
          fileName: fileName,
          line: line,
          col: col,
          _rawLen: match[0].length,
        };
        if (!match[2]) {
          var tail = this._lineTail(text, offset + match[0].length);
          if (tail) entry._tail = tail;
        }
        vp._anchorMap[key] = entry;
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
      if (vp._syncRunning) { vp._syncQueued = true; return; }

      var self = this;
      vp._syncRunning = true;
      this._buildAndApply(vp).catch(function () { /* */ }).then(function () {
        vp._syncRunning = false;
        if (vp._syncQueued) { vp._syncQueued = false; self._syncAll(vp); }
      });
    },

    // ═══ 锚点原文隐藏（老 q3 「Phase 1: sync scan, fast hide」语义）═══
    //   隐藏条件 = 路径已解析（exists 校验通过 = 文件真实存在可渲染）——不等帧 DOM：
    //   帧构建含探测/ffmpeg 数百 ms，等帧才隐会让令牌文本（含文件名）在打开文档时裸奔 = 穿帮；
    //   未解析（文件缺失/候选根全 miss）→ 保留文字可读（防「隐了但没渲染」的空洞）。
    _applyHideDecos: function (vp) {
      var editor = vp.editor;
      if (!editor || vp.state === 'closed') return;
      try {
        if (!vp.monaco || !vp.monaco.Range) return;
        if (!vp._hideDeco && typeof editor.createDecorationsCollection === 'function') {
          vp._hideDeco = editor.createDecorationsCollection([]);
        }
        if (!vp._hideDeco || typeof vp._hideDeco.set !== 'function') return;
        var keys = Object.keys(vp._anchorMap);
        var decos = [];
        var sig = [];
        // 签名带模型身份（预览复用/切文件 = 换 model → 签名必变，防旧签名撞车漏隐）
        var _m = null;
        try { _m = editor.getModel(); } catch (_em) { /* */ }
        var _mId = (_m && _m.id != null) ? _m.id : 0;
        for (var i = 0; i < keys.length; i++) {
          var ent = vp._anchorMap[keys[i]];
          if (!ent || !ent.path) continue;   // 未解析 → 不隐（文字保留可读）
          // 隐藏长度 = 令牌真实字符数（_rawLen，含引号；旧式空格令牌解析命中时已在解析器内扩至整段）
          // 旧条目无记录时按重建公式回落
          var tlen = (ent._rawLen > 0) ? ent._rawLen
            : (2 + (ent.sha256 ? String(ent.sha256).length : 0) + 1 + String(ent.fileName || '').length);
          sig.push(ent.line + ',' + ent.col + ',' + tlen);
          decos.push({
            range: new vp.monaco.Range(ent.line, ent.col, ent.line, ent.col + tlen),
            options: { inlineClassName: 'qqq-anchor-hidden' },
          });
        }
        var sigStr = _mId + '#' + sig.join(';');
        if (sigStr === vp._hideSig) return;   // 无变化零成本（每轮 sync 都会调用）
        vp._hideSig = sigStr;
        vp._hideDeco.set(decos);
      } catch (e) { /* */ }
    },

    // ★ 唯一落点：异步建帧（缓存命中零成本）→ 一次 changeViewZones 批量应用
    //   全族统一 ViewZone（媒体/文本/图标同一机制，帧高 = frameDom._zoneH 精确值）
    _buildAndApply: async function (vp) {
      var editor = vp.editor;
      if (!editor || vp.state === 'closed') return;
      if (typeof editor.changeViewZones !== 'function') return;
      var fr = this._frameRenderer || window.qqqFrameRenderer;
      if (!fr || !fr.buildFrame) return;

      // ★ 提前隐藏（老 q3 Phase 1 fast hide）：路径已解析的令牌立即隐，不等帧 DOM 构建完
      this._applyHideDecos(vp);

      var self = this;
      var variant = (typeof fr.variantKey === 'function') ? fr.variantKey() : '';
      var keys = Object.keys(vp._anchorMap);

      // ★ mtime 校验（老 deco 缓存 mtime 语义：源文件被外部修改 → 帧强制重建；≥3s 节流防 stat 风暴）
      var nowTs = Date.now();
      if (nowTs - (vp._mtimeCheckAt || 0) > 3000) {
        vp._mtimeCheckAt = nowTs;
        var chk = [];
        for (var mi = 0; mi < keys.length; mi++) {
          var me = vp._anchorMap[keys[mi]];
          var mc = me && me.path ? vp._frameCache[keys[mi]] : null;
          if (mc && mc.frameDom) { chk.push({ k: keys[mi], ent: me, c: mc }); }
        }
        var b2 = window.qqqideBridge;
        if (chk.length && b2 && b2.fs && b2.fs.stat) {
          try {
            await Promise.all(chk.map(function (it) {
              return b2.fs.stat(it.ent.path).then(function (st) {
                var mm = (st && (st.mtimeMs != null ? st.mtimeMs : st.mtime)) || 0;
                if (it.c.mtimeMs === undefined) { it.c.mtimeMs = mm; return; }   // 首次观测只记录不重建
                if (mm && it.c.mtimeMs !== mm) {
                  it.c.mtimeMs = mm;
                  delete vp._frameCache[it.k];                                  // 强制重建
                  if (typeof fr.invalidateMemo === 'function') {
                    try { fr.invalidateMemo(it.ent.path); } catch (e4) { /* */ }
                  }
                }
              }).catch(function () { /* */ });
            }));
          } catch (e3) { /* */ }
        }
      }

      // ① 建帧 / 复用（内容/文件名/偏好变体任一变化 → 重建）
      var jobs = [];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var e = vp._anchorMap[key];
        if (!e || !e.path) { delete vp._frameCache[key]; continue; }
        var cached = vp._frameCache[key];
        if (cached && cached.path === e.path && cached.fileName === e.fileName &&
            cached.variant === variant && cached.frameDom) {
          continue;
        }
        if (vp._building[key]) continue;
        vp._building[key] = true;
        (function (ent, k) {
          jobs.push(fr.buildFrame(ent).then(function (dom) {
            delete vp._building[k];
            vp._frameCache[k] = dom
              ? { path: ent.path, fileName: ent.fileName, variant: variant, frameDom: dom }
              : null;
          }).catch(function () { delete vp._building[k]; }));
        })(e, key);
      }
      if (jobs.length) { try { await Promise.all(jobs); } catch (e2) { /* */ } }
      if (vp.state === 'closed' || vp.editor !== editor) return;

      // ★ 暗号行上提几何（消灭「空气墙」：codelens 与相框零间隙）
      //   帧 DOM 即 zone 主体：marginTop=-rowH 让帧顶上提整行盖住暗号行（与老 q3 绝对定位 top:0 同视觉）。
      //   ★ rowH = 锚点行真实渲染高度（含折行；见 _rowHeightAt）——大字号/窄窗口下隐藏令牌会折行，
      //   只按编辑器行高上提 → 帧只盖首行，剩余折行区露成空气墙（42 号字实测 2 行 = 114px）。
      //   几何 = rowH 的函数 → 重建/字号变更（_hookConfigChange）/ resize（_hookLayoutChange）都必须重算。
      var _lh = 0;
      try {
        var _EOpt = (vp.monaco && vp.monaco.editor && vp.monaco.editor.EditorOption) ? vp.monaco.editor.EditorOption : null;
        var _lhVal = (typeof editor.getOption === 'function') ? editor.getOption(_EOpt ? _EOpt.lineHeight : 61) : 0;
        _lh = (typeof _lhVal === 'number' && _lhVal > 0) ? _lhVal : 0;
      } catch (_eLh) { _lh = 0; }
      function _pullGeom(frameDom, rowH) {
        var h = frameDom._zoneH;
        if (rowH > 0) {
          var hh = h - rowH - 4;
          // 常规：zone 高度同步减 (rowH+4)；帧比 rowH 还矮（图标帧 × 大字号）：保持整帧高度仅上提
          // （防图标被裁切；底部节奏 = 帧底→下一行恒为 rowH，与常规路径一致）
          return { h: (hh >= 24 ? hh : h), m: -rowH, pull: rowH };
        }
        return { h: h, m: 4, pull: rowH };   // 行高读不到：旧行为（_buildShell 默认 margin:4px 0）
      }

      // ② 行真实高度预计算（含折行；每锚点一行；changeViewZones 事务外读取）
      var rowHByKey = {};
      for (var rhI = 0; rhI < keys.length; rhI++) {
        var rhEnt = vp._anchorMap[keys[rhI]];
        if (rhEnt && rhEnt.path) rowHByKey[keys[rhI]] = this._rowHeightAt(editor, rhEnt.line) || _lh;
      }

      // ② 一次批量落 zone（新增/重建/移除）
      editor.changeViewZones(function (accessor) {
        var valid = {};
        for (var i2 = 0; i2 < keys.length; i2++) {
          var e2 = vp._anchorMap[keys[i2]];
          if (e2 && e2.path) valid[keys[i2]] = e2;
        }
        // 缓存里已失效的 key 清理
        var ck = Object.keys(vp._frameCache);
        for (var ci = 0; ci < ck.length; ci++) {
          if (!valid[ck[ci]]) { delete vp._frameCache[ck[ci]]; }
        }

        // 移除过期 zone（锚点位移 / 路径变化 / 帧高变化）
        var oldKeys = Object.keys(vp._zoneMeta);
        for (var j = 0; j < oldKeys.length; j++) {
          var k2 = oldKeys[j];
          var meta = vp._zoneMeta[k2];
          var ent2 = valid[k2];
          var c2 = vp._frameCache[k2];
          var rowH2 = (rowHByKey[k2] !== undefined) ? rowHByKey[k2] : _lh;
          var stale = vp._forceLiftRebuild || !ent2 || !c2 || !c2.frameDom ||
            meta.entry.line !== ent2.line || meta.entry.col !== ent2.col ||
            meta.entry.path !== ent2.path || meta.entry.fileName !== ent2.fileName ||
            meta.height !== _pullGeom(c2.frameDom, rowH2).h || meta.pull !== rowH2;
          if (stale) {
            try { accessor.removeZone(meta.zoneId); } catch (e3) { /* */ }
            delete vp._zoneMeta[k2];
          }
        }

        // 新增 zone
        for (var mi = 0; mi < keys.length; mi++) {
          var mk = keys[mi];
          var ent3 = valid[mk];
          if (!ent3 || vp._zoneMeta[mk]) continue;
          var c3 = vp._frameCache[mk];
          if (!c3 || !c3.frameDom) continue;

          var frameDom = c3.frameDom;
          frameDom.classList.add('qqq-vz-media');
          frameDom._requestResize = function () { self._scheduleSync(vp); };
          var rowH3 = (rowHByKey[mk] !== undefined) ? rowHByKey[mk] : _lh;
          var geom3 = _pullGeom(frameDom, rowH3);
          try { frameDom.style.marginTop = geom3.m + 'px'; } catch (_eM) { /* */ }
          var zoneId = accessor.addZone({
            afterLineNumber: ent3.line,
            heightInPx: geom3.h,
            domNode: frameDom,
          });
          vp._zoneMeta[mk] = {
            zoneId: zoneId,
            frameDom: frameDom,
            entry: { line: ent3.line, col: ent3.col, path: ent3.path, fileName: ent3.fileName },
            height: geom3.h,
            pull: rowH3,
          };
        }
      });

      vp._forceLiftRebuild = false;   // 强制重排标志一次性消费（本轮已把全部 zone remove+add）

      // ③ 锚点原文隐藏（老 q3 Phase 1 fast hide 语义，统一入口见 _applyHideDecos）
      this._applyHideDecos(vp);

      // ④ 空-path 锚点自愈：粘/拖/新键入的 token 能解析出真实路径就补上（相框立即出图）
      this._resolveNullPaths(vp);

      // ⑤ codelens 按钮刷新（qqq-codelens：锚点路径解析完成 = 按钮行就绪；唯一通知源）
      try {
        if (window.qqqCodelens && window.qqqCodelens.scheduleRefresh) window.qqqCodelens.scheduleRefresh();
      } catch (e5) { /* */ }
    },

    // ═══ 粘贴锚点精确注册（paste-router 调用；修「粘贴后破图直到重开文件」）═══
    //   列号宽容匹配：跨行前缀场景旧版扫描列号可能差 1 → 同 fileName 邻近条目也算命中
    registerPastedAnchor: function (editor, line, col, meta) {
      if (!editor || !meta) return false;
      var vp = this._registry.get(editor);
      if (!vp) return false;

      var key = this._posKey(line, col);
      var entry = vp._anchorMap[key];
      if ((!entry || (meta.fileName && entry.fileName !== meta.fileName)) && meta.fileName) {
        var best = null, bestScore = 1e9;
        var keys = Object.keys(vp._anchorMap);
        for (var i = 0; i < keys.length; i++) {
          var e2 = vp._anchorMap[keys[i]];
          if (!e2 || e2.fileName !== meta.fileName || e2.path) continue;
          if (Math.abs(e2.line - line) > 4 || Math.abs(e2.col - col) > 12) continue;
          var score = Math.abs(e2.line - line) * 1000 + Math.abs(e2.col - col);
          if (score < bestScore) { best = e2; bestScore = score; }
        }
        if (best) entry = best;
      }
      if (!entry) {
        if (!meta.fileName) return false;
        entry = {
          type: this._guessType(meta.fileName),
          path: null,
          sha256: '',
          fileName: meta.fileName,
          line: line,
          col: col,
        };
        vp._anchorMap[key] = entry;
      }
      if (meta.path) entry.path = meta.path;
      if (meta.sha256) entry.sha256 = String(meta.sha256).toLowerCase();
      if (meta.fileName) entry.fileName = meta.fileName;
      if (meta.rawLen) entry._rawLen = meta.rawLen;
      delete entry._tail;   // 注册的真名优先，补偿候选作废

      this._applyHideDecos(vp);   // ★ 粘贴即隐令牌原文（不等 sync 防抖；帧随后补上）
      this._scheduleSync(vp);
      return true;
    },

    // ═══ 空-path 锚点异步自愈（候选根逐个 exists 校验，命中即回填 + 重绘）═══
    _resolveNullPaths: function (vp) {
      var bridge = window.qqqideBridge;
      if (!bridge || !bridge.fs || !bridge.fs.exists) return;
      if (vp._resolvingPaths) return;

      var pending = [];
      var keys = Object.keys(vp._anchorMap);
      for (var i = 0; i < keys.length; i++) {
        var ent = vp._anchorMap[keys[i]];
        // _resolveTried: 一次性标记（解析不到的文件禁每轮重探；切标签/重开的全量扫描仍会重试）
        if (ent && ent.path === null && ent.fileName && !ent._resolveTried) pending.push(ent);
      }
      if (!pending.length) return;

      var dirs = this._baseDirs(vp);
      if (!dirs.length) return;

      var self = this;
      vp._resolvingPaths = true;
      var any = false;
      var jobs = pending.map(function (ent) {
        ent._resolveTried = true;
        var names = [];
        if (ent._tail) names.push(ent.fileName + ent._tail);   // 完整名优先（旧式空格截断补偿）
        names.push(ent.fileName);
        return self._firstExistingNames(dirs, names, bridge).then(function (hit) {
          if (hit && ent.path === null) {
            ent.path = hit;
            // ★ 完整名命中 → 回写真名与类型（截断名无扩展名 → 会误入文本探针；如 .avi 变图标框）
            //   隐藏跨度同步扩至整段令牌（_rawLen += 尾部），后续帧族判定基于真实扩展名
            if (ent._tail && names.length > 1 &&
                String(hit).replace(/\\/g, '/').slice(-names[0].length) === names[0]) {
              ent.fileName = names[0];
              ent.type = self._guessType(names[0]);
              ent._rawLen = (ent._rawLen > 0 ? ent._rawLen : 0) + ent._tail.length;
            }
            delete ent._tail;
            any = true;
          }
        }).catch(function () { /* */ });
      });
      Promise.all(jobs).then(function () {
        vp._resolvingPaths = false;
        if (any) {
          self._applyHideDecos(vp);   // ★ 解析命中立即隐藏（不等 100ms sync 防抖）
          self._scheduleSync(vp);
        }
      }).catch(function () { vp._resolvingPaths = false; });
    },

    // 候选名 × 候选根 全组合 exists 校验（名序优先：完整名先于裸名）
    _firstExistingNames: function (dirs, names, bridge) {
      var ni = 0, di = 0;
      function next() {
        if (ni >= names.length) return Promise.resolve(null);
        if (di >= dirs.length) { ni++; di = 0; return next(); }
        var cand = dirs[di] + '/' + names[ni];
        di++;
        return bridge.fs.exists(cand).then(function (ok) {
          return ok ? cand : next();
        }).catch(function () { return next(); });
      }
      return next();
    },

    // ═══ 清理 — 仅在 closing 阶段调用（editor 尚存活）═══

    _cleanupViewport: function (vp) {
      if (vp._syncTimer) clearTimeout(vp._syncTimer);
      if (vp._fontTimer) clearTimeout(vp._fontTimer);
      vp._fontTimer = null;

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

      // 锚点原文隐藏集合解散 + 帧缓存清理
      try { if (vp._hideDeco && typeof vp._hideDeco.clear === 'function') { vp._hideDeco.clear(); } } catch (_) { /* */ }
      vp._hideDeco = null;
      vp._hideSig = '';   // 集合已清 → 签名缓存必须同步失效（防同签名回访时漏隐）
      vp._frameCache = {};
      vp._building = {};

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
      // 兑底入口：paste-router 已在 document 级 capture 拦截并 stopPropagation（正常路径走不到这里）；
      // 若 router 缺席/方法缺失，绝不 preventDefault（防事件被静默吞掉）。
      try {
        if (window.qqqPasteRouter && typeof window.qqqPasteRouter.handlePaste === 'function') {
          window.qqqPasteRouter.handlePaste(e);
        }
      } catch (_) { /* 交给 Monaco 原生处理 */ }
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

    // ═══ 导出机专用（qqq-export 唯一消费，2026-09-18）═══
    //   全量重扫 + 强制重试空路径解析（清一次性标记）→ 等解析完成 → 返回按文档顺序的锚点快照。
    //   语义 = 老 q3 导出同步扫描 + resolvePathToAbsolute/existsSync 校验；只读，不改视口状态。
    prepareExportAnchors: function (editor) {
      var vp = this._registry.get(editor);
      if (!vp) return Promise.resolve([]);
      var self = this;
      self._fullScanAnchors(vp);
      var ks = Object.keys(vp._anchorMap);
      for (var i = 0; i < ks.length; i++) {
        var ent = vp._anchorMap[ks[i]];
        if (ent) delete ent._resolveTried;   // 导出 = 显式动作：历史解析失败不挡本轮重试
      }
      return new Promise(function (resolve) {
        self._resolveNullPaths(vp);
        var tries = 0;
        (function wait() {
          if (!vp._resolvingPaths || tries > 200) { resolve(self._orderedExportAnchors(vp)); return; }
          tries++;
          setTimeout(wait, 50);
        })();
      });
    },

    _orderedExportAnchors: function (vp) {
      var out = [];
      var ks = Object.keys(vp._anchorMap);
      for (var i = 0; i < ks.length; i++) {
        out.push(vp._anchorMap[ks[i]]);
      }
      out.sort(function (a, b) { return (a.line - b.line) || ((a.col || 0) - (b.col || 0)); });
      return out;
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

  window.qqqViewportMachine = _machine;

})();
