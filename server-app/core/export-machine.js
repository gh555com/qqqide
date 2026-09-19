// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// export-machine.js — 导出机器（老 q3 export doc / export Zip 客户端侧移植）
//
//   window.qqqExport.doc('rtf' | 'docx')   导出当前文档（.doc RTF / .docx）
//   window.qqqExport.zip()                 导出当前文档 + 全部引用文件/目录 → zip
//
// 链路：活动编辑器 → viewport-machine.prepareExportAnchors（唯一锚点真相）→
//   按文档顺序切元素（text/media/path）→ bridge.export.* → 壳层 export-service
//   （ffmpeg 转 PNG / SHA256 / RTF·DOCX·ZIP 生成 / 保存对话框）→ 完成 qoast + Roam 定位
//
// 语义 100% 对齐老项目：
//   · media（image/video）→ 转 PNG 内嵌；includeCipher=false 时不带暗号字符串
//   · 其余文件 → 正文保留暗号 + 附件索引（SHA256 全表）；目录 → 仅保留暗号
//   · 缺文件锚点 → 保留原文（老「broken link text 保留」语义）
//   · 默认落盘 = 文档同目录同名；同名已存在 → 保存对话框（老唯一弹框条件）
//   · 偏好消费：docExportImageResolution（original/frame）、docExportIncludeCipher
//   · 进度 ioast（可取消）+ 成功 qoast（📂 Roam 定位按钮）
// ============================================================================

(function () {
  'use strict';
  if (window.qqqExport) { return; }

  var FALLBACK_ROAM = '\uD83D\uDCC2 Roam \u5B9A\u4F4D';

  function _b() { try { return window.qqqideBridge || null; } catch (_) { return null; } }
  function _io() { try { return window.qqqideIoast || null; } catch (_) { return null; } }
  function _qoast(m, o) { try { if (window.qqqideQoast) { window.qqqideQoast.show(m, o || {}); } } catch (_) { } }

  // i18n 助手：翻译（含 {0}/{1} 参数）+ 中文回退
  function _T(k, fb, params) {
    var v = null;
    try {
      if (window.i18n && window.i18n.t) {
        var r = window.i18n.t(k, params);
        if (r && r !== k) { v = r; }
      }
    } catch (_) { }
    if (v === null) {
      v = fb || '';
      if (params) {
        for (var x in params) { if (Object.prototype.hasOwnProperty.call(params, x)) { v = v.split('{' + x + '}').join(String(params[x])); } }
      } else {
        // 无参数（或参数缺失）时清理残留占位符（防 "({0})" 裸奔）
        v = v.replace(/\{[0-9]+\}/g, '').replace(/\{\w+\}/g, '');
      }
    }
    return v;
  }

  function _fmtBytes(size) {
    if (size == null || isNaN(size)) { return '?'; }
    var units = ['B', 'KB', 'MB', 'GB'];
    var idx = 0, val = Number(size);
    while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++; }
    return val.toFixed(idx > 0 ? 1 : 0) + ' ' + units[idx];
  }

  // ── 「打开位置」唯一出口 = Roam 定位（shell-overlay；不可用回退资源管理器）──
  function _revealLocal(p) {
    if (!p) { return; }
    try { if (typeof window.__qqq_roamRevealPath === 'function') { window.__qqq_roamRevealPath(p); return; } } catch (_) { }
    try { var b = _b(); if (b && b.shell && b.shell.showItemInFolder) { b.shell.showItemInFolder(p); } } catch (_) { }
  }

  // ── 活动编辑器（焦点优先 → 主编辑器 → 任一带文件编辑器）──
  function _activeEditor() {
    var monaco = window.monaco;
    var eds = [];
    try { if (monaco && monaco.editor && monaco.editor.getEditors) { eds = monaco.editor.getEditors() || []; } } catch (_) { eds = []; }
    for (var i = 0; i < eds.length; i++) {
      try { if (eds[i].hasTextFocus && eds[i].hasTextFocus()) { return eds[i]; } } catch (_) { }
    }
    try {
      if (window.qqqEditor && window.qqqEditor.currentFile && window.qqqEditor.getEditorForFile) {
        var cf = window.qqqEditor.currentFile();
        if (cf) { var e0 = window.qqqEditor.getEditorForFile(cf); if (e0) { return e0; } }
      }
    } catch (_) { }
    for (var j = 0; j < eds.length; j++) {
      try { if (eds[j]._qqqFilePath && eds[j].getModel && eds[j].getModel() && !eds[j].getModel().isDisposed()) { return eds[j]; } } catch (_) { }
    }
    return null;
  }

  function _fileOfEditor(ed) {
    try { if (ed && ed._qqqFilePath) { return String(ed._qqqFilePath); } } catch (_) { }
    try {
      var m = ed && ed.getModel && ed.getModel();
      if (m && m.uri && m.uri.scheme === 'file') {
        var fp = m.uri.fsPath;
        if (fp) { return String(fp); }
        var p = m.uri.path || '';
        if (/^\/[A-Za-z]:/.test(p)) { p = p.slice(1); }
        try { p = decodeURIComponent(p); } catch (_) { }
        if (p) { return p; }
      }
    } catch (_) { }
    return '';
  }

  // ── 锚点 → 有序元素列表（唯一真相 = viewport-machine 锚点表；本函数只切文本不扫描）──
  function _buildElements(model, text, anchors) {
    var entries = (anchors || []).slice();
    entries.sort(function (a, b) { return (a.line - b.line) || ((a.col || 0) - (b.col || 0)); });

    var out = [];
    var lastEnd = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.fileName) { continue; }
      var offset;
      try { offset = model.getOffsetAt({ lineNumber: e.line, column: e.col }); } catch (_) { continue; }
      if (offset < lastEnd) { continue; }   // 防重叠（理论不发生）
      if (offset > lastEnd) { out.push({ t: 'text', s: text.slice(lastEnd, offset) }); }
      var rawLen = (typeof e._rawLen === 'number' && e._rawLen > 0) ? e._rawLen : 0;
      var marker = rawLen ? text.slice(offset, offset + rawLen) : '';
      if (!marker) {
        // 理论不发生（_rawLen 恒由扫描写入）；近似重建仅作兜底
        marker = '\uD83D\uDCCE' + (e.sha256 || '') + ':' + e.fileName;
      }
      lastEnd = offset + marker.length;
      if (!e.path) { out.push({ t: 'text', s: marker }); continue; }   // 缺文件 → 保留原文
      if (e.type === 'image' || e.type === 'video') {
        out.push({ t: 'media', p: e.path, mark: marker });
      } else {
        out.push({ t: 'path', p: e.path, mark: marker });
      }
    }
    if (lastEnd < text.length) { out.push({ t: 'text', s: text.slice(lastEnd) }); }
    return out;
  }

  // ── 壳层文案包（zh.json 唯一真理源 → 传入壳层生成器）──
  function _textsWire() {
    return {
      attachmentIndex: _T('export.attachmentIndex', '\uD83D\uDCC1 \u9644\u4EF6\u7D22\u5F15'),
      colIndex: _T('export.colIndex', '\u5E8F\u53F7'),
      colFileName: _T('export.colFileName', '\u6587\u4EF6\u540D'),
      colType: _T('export.colType', '\u7C7B\u578B'),
      colSize: _T('export.colSize', '\u5927\u5C0F'),
      colSha256Short: _T('export.colSha256Short', 'SHA256\uFF08\u524D16\u4F4D\uFF09'),
      fullSha256: _T('export.fullSha256', '\u5B8C\u6574 SHA256 \u54C8\u5E0C\u503C\uFF1A'),
      mediaConversionFailedTmpl: _T('export.mediaConversionFailed', '\u5A92\u4F53\u8F6C\u6362\u5931\u8D25: {0}'),
      filterLabelRtf: _T('export.filterRtf', 'Word \u6587\u6863\uFF08\u517C\u5BB9 Office 2003, RTF\uFF09'),
      filterLabelDocx: _T('export.filterDocx', 'Word \u6587\u6863'),
      filterLabelZip: _T('export.filterZip', 'ZIP \u538B\u7F29\u5305'),
    };
  }

  // ── 进度 → ioast ──
  function _onProgress(msg, jobId, io, title) {
    if (!io) { return; }
    var sub = '';
    var prog = 0;
    if (msg.phase === 'media') {
      sub = _T('export.convertingMedia', '\u8F6C\u6362\u5A92\u4F53 {0}/{1}: {2}', { 0: msg.cur, 1: msg.total, 2: msg.name || '' });
      prog = msg.total > 0 ? 0.8 * (msg.cur / msg.total) : 0.4;
    } else if (msg.phase === 'hash') {
      sub = _T('export.computingHash', '\u8BA1\u7B97\u9644\u4EF6\u54C8\u5E0C {0}/{1}: {2}', { 0: msg.cur, 1: msg.total, 2: msg.name || '' });
      prog = msg.total > 0 ? 0.8 + 0.1 * (msg.cur / msg.total) : 0.85;
    } else if (msg.phase === 'generate') {
      sub = _T('export.generatingDoc', '\u751F\u6210 {0} \u6587\u6863...', { 0: msg.name || '' });
      prog = 0.92;
    } else if (msg.phase === 'prepare') {
      sub = _T('export.preparingFiles', '\u51C6\u5907\u6587\u4EF6\u5217\u8868...');
      prog = 0.05;
    } else if (msg.phase === 'zip') {
      var pct = msg.total > 0 ? Math.min(99, Math.round((msg.bytes / msg.total) * 100)) : 0;
      sub = _T('export.compressingBytes', '\u538B\u7F29\u4E2D... {0} / {1}\uFF08{2}%\uFF09', {
        0: _fmtBytes(msg.bytes || 0), 1: _fmtBytes(msg.total || 0), 2: pct,
      });
      prog = msg.total > 0 ? Math.min(0.98, (msg.bytes / msg.total) * 0.98) : 0.5;
    } else if (msg.phase === 'done') {
      sub = _T('export.done', '\u5B8C\u6210');
      prog = 1;
    }
    if (sub) { io.task(jobId, { title: title, subtitle: sub, progress: prog }); }
  }

  // ── 主流程 ──
  function _run(kind, format) {
    var b = _b();
    if (!b || !b.export || !b.export.doc) {
      _qoast(_T('export.bridgeMissing', 'qqq: \u5BFC\u51FA\u670D\u52A1\u4E0D\u53EF\u7528\uFF08\u9700\u91CD\u542F\u5B9E\u4F8B\uFF09'), { type: 'error', duration: 9000 });
      return;
    }
    var ed = _activeEditor();
    if (!ed) {
      _qoast(_T('export.noOpenDocument', 'qqq: \u8BF7\u9009\u62E9\u6253\u5F00\u6EF4\u6587\u6863'), { type: 'warning', duration: 6000 });
      return;
    }
    var model = null;
    try { model = ed.getModel(); } catch (_) { model = null; }
    if (!model || model.isDisposed()) {
      _qoast(_T('export.noOpenDocument', 'qqq: \u8BF7\u9009\u62E9\u6253\u5F00\u6EF4\u6587\u6863'), { type: 'warning', duration: 6000 });
      return;
    }
    var filePath = _fileOfEditor(ed);
    if (!filePath) {
      _qoast(_T('export.saveDocFirst', 'qqq: \u8BF7\u5148\u4FDD\u5B58\u6587\u6863\u540E\u518D\u5BFC\u51FA ZIP'), { type: 'warning', duration: 6000 });
      return;
    }
    var text = model.getValue();
    if (!text || text.length === 0) {
      _qoast(_T('export.emptyDocument', 'qqq: \u6587\u6863\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u5BFC\u51FA'), { type: 'warning', duration: 6000 });
      return;
    }

    var vm = window.qqqViewportMachine;
    var anchorsP = (vm && typeof vm.prepareExportAnchors === 'function')
      ? vm.prepareExportAnchors(ed)
      : Promise.resolve([]);

    anchorsP.then(function (anchors) {
      var elements = _buildElements(model, text, anchors);
      if (!elements.length) {
        _qoast(_T('export.emptyDocument', 'qqq: \u6587\u6863\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u5BFC\u51FA'), { type: 'warning', duration: 6000 });
        return;
      }
      _send(kind, format, filePath, elements);
    }).catch(function (e) {
      _qoast(_T('export.exportFailed', 'qqq: \u5BFC\u51FA\u5931\u8D25: {0}', { 0: String((e && e.message) || e).slice(0, 80) }), { type: 'error', duration: 10000 });
    });
  }

  function _send(kind, format, filePath, elements) {
    var b = _b();
    var io = _io();
    var jobId = 'exp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    var isDoc = kind === 'doc';
    var fmtLabel = format === 'rtf' ? 'RTF' : 'DOCX';
    var title = isDoc
      ? '\uD83D\uDCE4 ' + _T('export.exportingDoc', 'qqq: \u6B63\u5728\u5BFC\u51FA {0} \u6587\u6863...', { 0: fmtLabel })
      : '\uD83D\uDCE4 ' + _T('export.exportingZip', 'qqq: \u6B63\u5728\u5BFC\u51FA ZIP...');

    if (io) {
      io.task(jobId, {
        title: title,
        subtitle: _T('export.preparingFiles', '\u51C6\u5907\u6587\u4EF6\u5217\u8868...'),
        progress: 0,
        cancelable: true,
        onCancel: function () { try { b.export.cancel(jobId); } catch (_) { } },
      });
    }

    var off = null;
    try {
      off = b.export.onProgress(function (msg) {
        if (!msg || msg.jobId !== jobId) { return; }
        _onProgress(msg, jobId, io, title);
      });
    } catch (_) { off = null; }

    var prefs = window.qqqPrefs;
    var payload = {
      jobId: jobId,
      docPath: filePath,
      elements: elements,
      texts: _textsWire(),
    };
    if (isDoc) {
      payload.format = format;
      payload.includeCipher = prefs ? (prefs.get('docExportIncludeCipher') !== false) : true;
      payload.useFrameResolution = prefs ? (prefs.get('docExportImageResolution') === 'frame') : false;
    }

    var call = isDoc ? b.export.doc(payload) : b.export.zip(payload);
    call.then(function (r) {
      try { if (off) { off(); } } catch (_) { }
      _finish(r, jobId, io, isDoc, fmtLabel);
    }).catch(function (e) {
      try { if (off) { off(); } } catch (_) { }
      var msg = String((e && e.message) || e).slice(0, 120);
      if (io) { io.fail(jobId, { summary: _T('export.exportFailed', 'qqq: \u5BFC\u51FA\u5931\u8D25: {0}', { 0: msg }) }); }
      _qoast(_T('export.exportFailed', 'qqq: \u5BFC\u51FA\u5931\u8D25: {0}', { 0: msg }), { type: 'error', duration: 12000 });
    });
  }

  function _finish(r, jobId, io, isDoc, fmtLabel) {
    if (r && r.ok) {
      // ★ VIG 履历埋点（老 q3 exportDoc_stats / exportZip_stats 语义：成功导出 n+1）
      try {
        var _vb = window.qqqideBridge && window.qqqideBridge.vig;
        if (_vb && _vb.bump) { _vb.bump(isDoc ? 'export_doc' : 'export_zip', { n: 1 }); }
      } catch (_) { }
      var sizeStr = _fmtBytes(r.size || 0);
      var msg = _T('export.docExported', 'qqq: \u6587\u6863\u5DF2\u5BFC\u51FA ({0}): {1}', { 0: sizeStr, 1: r.path });
      if (!r.hasAnchors) {
        msg += _T('export.noQqqVibe', '\uFF0C\u4F46\uFF0C\u5236\u54C1\u4E2D\u4E0D\u5305\u542B qqq \u6EF4\u97F5\u5473\u3002');
      } else if (!isDoc && (r.refs || 0) > 0) {
        msg += _T('export.includesRefs', '\uFF08\u5305\u542B {0} \u4E2A\u5F15\u7528\u9879\uFF09', { 0: r.refs });
      }
      if (io) { io.done(jobId, { summary: _T('shell.dl.saved', '\u5DF2\u4FDD\u5B58\uFF1A') + r.path }); }
      _qoast(msg, {
        type: 'success', duration: 14000,
        action: {
          label: _T('shell.dl.roamLocate', FALLBACK_ROAM),
          onClick: function () { _revealLocal(r.path); },
        },
      });
      return;
    }
    if (r && r.canceled) {
      if (io) { io.remove(jobId); }
      _qoast(_T('export.exportCancelled', 'qqq: \u5BFC\u51FA\u5DF2\u53D6\u6D88'), { type: 'warning', duration: 5000 });
      return;
    }
    var err = (r && r.error) ? String(r.error).slice(0, 120) : 'unknown';
    if (io) { io.fail(jobId, { summary: _T('export.exportFailed', 'qqq: \u5BFC\u51FA\u5931\u8D25: {0}', { 0: err }) }); }
    _qoast(isDoc
      ? _T('export.exportFailed', 'qqq: \u5BFC\u51FA\u5931\u8D25: {0}', { 0: err })
      : _T('export.zipExportFailed', 'qqq: ZIP \u5BFC\u51FA\u5931\u8D25: {0}', { 0: err }),
      { type: 'error', duration: 12000 });
  }

  window.qqqExport = {
    doc: function (format) { _run('doc', format === 'docx' ? 'docx' : 'rtf'); },
    zip: function () { _run('zip'); },
  };
})();
