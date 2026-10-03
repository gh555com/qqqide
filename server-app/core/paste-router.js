// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// paste-router.js — 编辑器粘贴路由（v3 重写：真·同步探针优先）
//
// 管线:
//   用户 Ctrl+V
//   → klipzap.probe(e) — 同步，sub-ms，零 IPC
//   → 路由:
//       · 纯文本（无 HTML） → return（Monaco 原生粘贴，零额外延迟）
//       · 图片   → preventDefault → 写盘 → 📎{sha256}:{name} 锚点 → ContentWidget
//       · 文件   → preventDefault → 📎:filename 锚点（DOM API 无完整路径）
//       · HTML   → preventDefault → html-paste 转换（老 q3 SmartPaste 移植）
//                  → 媒体下载（壳层 paste-fetch：安全档位 11 开关 + yt-dlp）
//                  → 结构化文本 + 📎 锚点单次插入
//   → 拖放（drop-overlay.js 转发，同一条机器）:
//       · 系统文件（Files） → copyFile 进 _qqqvault/ + 📎 锚点
//       · 网页内容（无 Files 的 text/html / text/uri-list） → 同 HTML 富文本管线（_handleWebDrop）
//
// ★ 核心原则:
//   1. probe 真·同步（读 e.clipboardData.types + items，零 async）
//   2. preventDefault 在确定需要我们自己处理后才调用（纯文本路径绝不拦截）
//   3. 纯文本路径零开销（probe 返回 isPureText → 直接 return）
//
// ★ 粘贴落盘: 不聚合（老 q3 穷举结论）
//   优先落当前文件所在目录的 _qqqvault/。
//   无当前文件 → 落 workspace root 的 _qqqvault/。
//
// 暴露: window.qqqPasteRouter
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;
  var klipzap = window.qqqideKlipzap;
  var wqStats = window.qqqWqStats;

  var _editor = null;
  var _monaco = null;
  var _attached = false;
  var _pasteHandler = null;  // bound handler for cleanup

  // ═══ Token 生成 ═══
  // ★ 引号式令牌：文件名含空白（空格）或锚点字符（📎/📁）时必须用 ASCII " 包裹——
  //   旧式裸令牌在第一个空格处被锚点正则截断（📎:松尾早人 - xxx.mp3 → 只剩「松尾早人」）
  //   → 路径解析必然落空 → 帧不显示/错帧。NTFS 禁止文件名含 " → 包裹零歧义。
  //   与 AI 面板 chip 引号约定（铁律 §8.5）对齐；viewport-machine 正则双式兼容。
  function _makeAnchorToken(sha256, fileName) {
    var prefix = (sha256 || '').slice(0, 12);
    var name = String(fileName || 'file');
    // ★ 必须带 u 标志（2026-09-27 修）：缺 u 时 \u{...} 退化为字面字符类，'1F4CE{}u' 等
    //   普通字符也命中 → 无空格文件名被误加引号（曾被咬：20260926-1527-00.1807203.mp4）。
    if (/[\s\u{1F4CE}\u{1F4C1}]/u.test(name)) name = '"' + name + '"';
    return '\u{1F4CE}' + prefix + ':' + name;
  }

  // ═══ VIG 履历埋点（老 q3 savePasteStats 语义：一次粘贴动作 n+1，字节累加） ═══
  function _vigPaste(bytes) {
    try {
      if (bridge && bridge.vig && bridge.vig.bump) {
        bridge.vig.bump('paste', { n: 1, b: Math.max(0, Math.floor(Number(bytes) || 0)) });
      }
    } catch (_) { }
  }
  async function _sumSizes(list) {
    var total = 0;
    if (!list || !list.length) { return 0; }
    try {
      var rs = await Promise.all(list.map(function (p) {
        return bridge.fs.stat(p).then(function (s) { return (s && s.size) || 0; }).catch(function () { return 0; });
      }));
      for (var i = 0; i < rs.length; i++) { total += rs[i]; }
    } catch (_) { }
    return total;
  }

  // ═══ 时间戳 + 随机名 ═══
  function pad2(n) { return String(n).padStart(2, '0'); }
  function nowStamp() {
    var n = new Date();
    return n.getFullYear() + pad2(n.getMonth() + 1) + pad2(n.getDate())
      + '_' + pad2(n.getHours()) + pad2(n.getMinutes()) + pad2(n.getSeconds());
  }
  function genName(ext) {
    var rand = Math.random().toString(36).slice(2, 7);
    return 'paste_' + nowStamp() + '_' + rand + ext;
  }

  // ═══ 事件→编辑器反查 ═══
  // ★ 分屏时 paste-router 只 attach 到一个 editor，但 paste 可能发生在另一个 editor。
  //   通过 e.target 反查实际 editor，确保文件落入正确目录。
  function _findEditorFromEvent(e) {
    // ★ 合成事件（Paste 按钮 / 视频 Url 行——2026-10-03）：显式目标编辑器优先（落盘/插入路径解析零歧义）
    if (e && e.__qqqPasteEd) {
      try { if (_modelOf(e.__qqqPasteEd)) return e.__qqqPasteEd; } catch (_) { }
    }
    if (!e || !e.target || !_monaco) return _editor;
    var t = e.target;
    try {
      if (_monaco.editor && _monaco.editor.getEditors) {
        var editors = _monaco.editor.getEditors();
        for (var i = 0; i < editors.length; i++) {
          var dn = editors[i].getDomNode && editors[i].getDomNode();
          if (dn && dn.contains(t)) return editors[i];
        }
      }
    } catch (_) {}
    // ★ 非编辑器输入区（主窗口自有 input/textarea/contenteditable——命名框等）→ 返回 null 交原生粘贴；
    //   旧实现无条件回落 _editor → 在这些输入区贴图会被误写进「最近编辑器」的 _qqqvault 并插入锚点。
    try {
      if (t && t.nodeType === 1) {
        var tag = String(t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return null;
        var p = t;
        while (p && p.nodeType === 1) {
          if (p.isContentEditable) return null;
          p = p.parentElement;
        }
      }
    } catch (_) {}
    return _editor;
  }

  // ═══ 获取粘贴目标目录 ═══
  //
  // ★ 不聚合（老 q3 穷举结论）。落盘规则:
  //   从粘贴事件反查实际编辑器 → 取其文件所在目录 → _qqqvault/
  //   若反查失败（非编辑器区域粘贴）→ 返回 null，图片不落盘。
  //   _qqq/ = IDE 家目录，_qqqvault/ = 粘贴资产专用，平层·完全解耦。
  //
  function _getPasteDir(e) {
    // ★ 2026-10-03 粘贴瞬间固化（首调缓存 e.__qqqPasteDir）：下载/复制是长异步，期间切标签/关 tab 会让
    //   e.target 脱树 → 反查漂移/落空。缓存后一切延迟调用恒走首调结果（同一粘贴的资产恒落同一 _qqqvault）。
    if (e && e.__qqqPasteDir !== undefined) return e.__qqqPasteDir;
    var targetEditor = _findEditorFromEvent(e);
    if (!targetEditor) {
      try { if (e) e.__qqqPasteDir = null; } catch (_) {}
      return null;
    }

    var curFile = null;
    try {
      var model = targetEditor.getModel();
      if (model && model.uri) {
        // fsPath 优先（Monaco file URI → native path）
        // 不硬检查 scheme（qqqide-asset / file 等均支持）
        curFile = model.uri.fsPath || model.uri.path;
      }
    } catch (ex) { /* */ }

    if (!curFile) {
      console.warn('[paste-router] _getPasteDir: model URI has no fsPath/path');
      try { if (e) e.__qqqPasteDir = null; } catch (_) {}
      return null;
    }

    // ★ 2026-08-02 fix: Monaco Uri.parse('E:/path') treats 'E' as scheme, not drive letter.
    //   fsPath returns \path\without\drive → missing E: causes ERR_FILE_NOT_FOUND on thumbnail load.
    //   Detect: path starts with \ or / and no : in first 3 chars → prepend workspace drive letter.
    if (curFile && curFile.indexOf(':') < 0 && window._workspaceRoot) {
      var wsDrive = window._workspaceRoot.slice(0, Math.max(0, window._workspaceRoot.indexOf(':') + 1));
      if (wsDrive && wsDrive.indexOf(':') >= 0) {
        curFile = wsDrive + curFile.replace(/^\/+/, '');
      }
    }

    var hasBS = curFile.indexOf('\\') >= 0;
    var sep = hasBS ? '\\' : '/';
    var dir = curFile.slice(0, curFile.lastIndexOf(sep));
    if (!dir) {
      try { if (e) e.__qqqPasteDir = null; } catch (_) {}
      return null;
    }
    var out = dir + sep + '_qqqvault';
    try { if (e) e.__qqqPasteDir = out; } catch (_) {}
    return out;
  }

  var mimeToExt = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/ogg': '.ogv',
  };

  // ═══ 文件名 → 扩展名（drop 锚点兜底用）═══
  function _extFromName(name) {
    if (!name) return '';
    var dot = String(name).lastIndexOf('.');
    return dot >= 0 ? String(name).slice(dot).toLowerCase() : '';
  }

  // ═══ Blob → ArrayBuffer → Base64 ═══
  function blobToArrayBuffer(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsArrayBuffer(blob);
    });
  }

  function arrayBufferToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  // ═══ 指纹去重（老 q3 h.js _tryLocalDeduplicate 移植：仅同目录、按内容指纹复用）═══
  //   粘贴图片写盘前先扫目标 _qqqvault/：同尺寸候选 → sha256 逐字节比对；
  //   命中 → 不写盘，锚点直接指向既有文件（同内容 = 同 token，vault 永不堆重复文件）。
  //   主路 = 主进程 bridge.hash.file（mtime 缓存）；壳层未更新（桥缺失）时渲染层读字节兑底。
  var _DEDUP_B64_CAP = 24 * 1024 * 1024;
  var _dedupShaCache = {};
  async function _fileSha256(filePath, size, mtimeMs) {
    if (!(size > 0) || size > _DEDUP_B64_CAP) return null;
    var key = filePath + '|' + size + '|' + (mtimeMs || 0);
    if (_dedupShaCache[key] !== undefined) return _dedupShaCache[key];
    var out = null;
    try {
      if (bridge && bridge.fs && bridge.fs.readBase64 && window.crypto && window.crypto.subtle) {
        var b64 = await bridge.fs.readBase64(filePath);
        if (b64) {
          var bin = atob(b64);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xFF;
          var hb = await window.crypto.subtle.digest('SHA-256', bytes);
          var arr = new Uint8Array(hb);
          var hex = '';
          for (var j = 0; j < arr.length; j++) hex += arr[j].toString(16).padStart(2, '0');
          out = hex;
        }
      }
    } catch (_) { out = null; }
    _dedupShaCache[key] = out;
    return out;
  }

  async function _findDuplicateInDir(dir, size, sha256) {
    if (!sha256 || !size) return null;
    if (!bridge || !bridge.fs || !bridge.fs.list) return null;
    var sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    try {
      var entries = await bridge.fs.list(dir);
      if (!Array.isArray(entries)) return null;
      for (var i = 0; i < entries.length && i < 2000; i++) {
        var ent = entries[i];
        if (!ent || ent.isDir || !ent.name) continue;
        if (ent.size !== size) continue;
        var nm = String(ent.name);
        if (/\.(part|ytdl|tmp|crdownload)$/i.test(nm)) continue;
        var p = dir + sep + nm;
        var candSha = null;
        if (bridge.hash && bridge.hash.file) {
          try {
            var h = await bridge.hash.file(p, 'strong');
            candSha = (h && h.sha256) ? String(h.sha256).toLowerCase() : null;
          } catch (_) { candSha = null; }
        }
        if (!candSha) candSha = await _fileSha256(p, ent.size, ent.mtimeMs);
        if (candSha && candSha === sha256) {
          return { path: p, name: nm, size: ent.size };
        }
      }
    } catch (e) { /* list 失败 → 不去重，正常写盘 */ }
    return null;
  }

  // ═══ 写盘 + hash ═══
  // _saveBytes: 字节直落（sha256 + 同目录指纹去重 + 写盘）——粘贴图片 blob 与网页粘贴(data:/本地字节)共用
  async function _saveBytes(ab, ext, e) {
    var dir = _getPasteDir(e);
    if (!dir) {
      console.error('[paste-router] _saveBytes: _getPasteDir returned null');
      return { error: (window._i ? window._i('pasteRouter.noDir', '无法确定粘贴目录（编辑器未关联文件？）') : '无法确定粘贴目录（编辑器未关联文件？）') };
    }
    console.log('[paste-router] _saveBytes: dir=' + dir);

    var base64 = arrayBufferToBase64(ab);

    // SHA-256 via Web Crypto (renderer-native, zero IPC, sub-ms)
    var sha256 = '';
    try {
      if (window.crypto && window.crypto.subtle) {
        var hashBuffer = await window.crypto.subtle.digest('SHA-256', ab);
        var hashArray = Array.from(new Uint8Array(hashBuffer));
        sha256 = hashArray.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      }
    } catch (e) {
      console.warn('[paste-router] SHA-256 failed:', e && e.message);
    }

    // ★ 指纹去重：同目录同内容 → 复用既有文件（禁重复落盘）
    var dup = await _findDuplicateInDir(dir, ab.byteLength, sha256);
    if (dup) {
      console.log('[paste-router] dedup hit: ' + dup.path);
      if (bridge && bridge.assetRoots && bridge.assetRoots.add) {
        bridge.assetRoots.add(dir).catch(function () { /* */ });
      }
      return { path: dup.path, sha256: sha256, fileName: dup.name, reused: true };
    }

    // Ensure target directory exists
    try {
      if (bridge && bridge.fs && bridge.fs.mkdir) {
        await bridge.fs.mkdir(dir);
      }
    } catch (e) {
      // mkdir may fail if dir already exists — that's ok
    }

    // Write
    var fileName = genName(ext);
    var sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    var fullPath = dir + sep + fileName;
    try {
      if (!bridge || !bridge.fs || !bridge.fs.writeBase64) {
        console.error('[paste-router] bridge.fs.writeBase64 不可用');
        return { error: '文件系统桥未就绪，请刷新重试' };
      }
      console.log('[paste-router] writing: ' + fullPath);
      await bridge.fs.writeBase64(fullPath, base64);
      console.log('[paste-router] write OK: ' + fullPath);
      // ★ 资产根注册留到下方统一处理
    } catch (ex) {
      console.error('[paste-router] writeBase64 失败:', ex && (ex.message || ex), 'fullPath=' + fullPath);
      return { error: (window._i ? window._i('pasteRouter.writeFail', '写盘失败: {msg}', { msg: (ex && (ex.message || ex)) }) : ('写盘失败: ' + (ex && (ex.message || ex)))) };
    }

    // Register paste dir as asset root for thumbnail serving
    if (bridge && bridge.assetRoots && bridge.assetRoots.add) {
      bridge.assetRoots.add(dir).catch(function () {});
    }

    return { path: fullPath, sha256: sha256, fileName: fileName };
  }

  // _saveImage = blob → bytes → _saveBytes（粘贴图片主路）
  async function _saveImage(blob, ext, e) {
    var ab = await blobToArrayBuffer(blob);
    return await _saveBytes(ab, ext, e);
  }

  // ═══ 插入位置冻结机器（粘贴锚）+ 统一插入 ═══
  // ★ 2026-10-03（边界审计）：粘贴 → 下载/复制 → 插入 是长异步（18 个资源可达分钟级）。旧实现在
  //   「插入时刻」读当前光标——期间切标签/打字/点选都会让内容落到错误位置。现在按下的瞬间用 Monaco
  //   零尺寸装饰（tracked range）冻结插入点：文档任意编辑（含折行/撤销）自动跟随；标签切走（编辑器
  //   挂起/隐藏，per-tab 编辑器独立存在）照常有效；编辑器/模型销毁（tab 关闭）→ 优雅降级 + 诚实反馈。
  function _modelOf(ed) {
    try { return (ed && ed.getModel) ? ed.getModel() : null; } catch (_) { return null; }
  }
  // 同模型的活编辑器（编辑器已销毁但模型存活 = split 另一格仍开 → 注册/继续走它）
  function _liveEdForModel(model) {
    try {
      var eds = _monaco.editor.getEditors ? _monaco.editor.getEditors() : [];
      for (var i = 0; i < eds.length; i++) {
        try { if (eds[i].getModel && eds[i].getModel() === model) return eds[i]; } catch (_) {}
      }
    } catch (_) {}
    return null;
  }
  function _anchorStick() {
    try { return _monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges; } catch (_) { return 1; }
  }
  // pos（可选，拖放用）: 冻结到指定落点 {lineNumber,column}；缺省 = 当前选区/光标。
  function _anchorNew(ed, pos) {
    try {
      var model = _modelOf(ed);
      if (!model || model.isDisposed()) return null;
      var range;
      if (pos && pos.lineNumber >= 1) {
        var ln = Math.min(Math.floor(pos.lineNumber), model.getLineCount());
        var col = Math.min(Math.max(1, Math.floor(pos.column || 1)), model.getLineMaxColumn(ln));
        range = new _monaco.Range(ln, col, ln, col);
      } else {
        var sel = ed.getSelection();
        if (!sel) return null;
        range = new _monaco.Range(sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn);
      }
      var arr = model.deltaDecorations([], [{
        range: range,
        options: { stickiness: _anchorStick(), description: 'qqq-paste-anchor' },
      }]);
      if (!arr || !arr.length) return null;
      return { model: model, id: arr[0], ok: true };
    } catch (e) { return null; }
  }

  // 拖放落点（Monaco 官方命中测试）→ {lineNumber, column}；不可得 → null（回落选区/光标）。
  function _dropPointOf(ed, e) {
    try {
      if (!ed || !ed.getTargetAtClientPoint || !e) return null;
      var t = ed.getTargetAtClientPoint(e.clientX, e.clientY);
      if (t && t.position && t.position.lineNumber >= 1) return t.position;
    } catch (_) { }
    return null;
  }
  function _anchorRange(anchor) {
    if (!anchor || !anchor.ok) return null;
    try {
      if (!anchor.model || anchor.model.isDisposed()) return null;
      return anchor.model.getDecorationRange(anchor.id) || null;
    } catch (e) { return null; }
  }
  function _anchorAdvance(anchor, len) {
    if (!anchor || !anchor.ok || !(len > 0)) return;
    try {
      var r = anchor.model.getDecorationRange(anchor.id);
      if (!r) { anchor.ok = false; return; }
      var np = anchor.model.getPositionAt(anchor.model.getOffsetAt(r.getStartPosition()) + len);
      var rid = anchor.model.deltaDecorations([anchor.id], [{
        range: new _monaco.Range(np.lineNumber, np.column, np.lineNumber, np.column),
        options: { stickiness: _anchorStick(), description: 'qqq-paste-anchor' },
      }]);
      if (rid && rid.length) anchor.id = rid[0];
    } catch (e) { anchor.ok = false; }
  }
  function _anchorDrop(anchor) {
    if (!anchor || !anchor.ok) return;
    try { anchor.model.deltaDecorations([anchor.id], []); } catch (_) {}
    anchor.ok = false;
  }

  // 统一应用插入：优先编辑器级 executeEdits（Monaco 光标/撤销整合）；
  // 编辑器已销毁但模型存活（split 另一格仍开）→ 模型级 applyEdits（内容不丢）。
  function _applyInsert(targetEd, model, range, text) {
    var viaEditor = false;
    try {
      if (targetEd && _modelOf(targetEd) === model) {
        targetEd.executeEdits('qqq-paste-router', [{ range: range, text: text, forceMoveMarkers: true }]);
        viaEditor = true;
      }
    } catch (_) { viaEditor = false; }
    if (!viaEditor) model.applyEdits([{ range: range, text: text }]);
    try { if (window.qqqCharUndo && window.qqqCharUndo.mark) window.qqqCharUndo.mark(targetEd); } catch (_) {}
    _tryFocus(targetEd);
  }

  // focus 卫生：仅在编辑器当前就持有文本焦点时 focus（no-op 续焦）；用户已去别处（切窗/点别格/
  // 编辑器隐藏）绝不抢焦点——防长异步结束后把用户输入吸回旧文件。
  function _tryFocus(ed) {
    try {
      if (!ed || !ed.focus || !ed.getDomNode) return;
      if (ed.hasTextFocus && !ed.hasTextFocus()) return;
      var dn = ed.getDomNode();
      if (dn && dn.isConnected && dn.offsetParent !== null) ed.focus();
    } catch (_) {}
  }

  // 解析插入基座（锚优先；锚失 → 活编辑器当前选区；编辑器/模型尽失 → dead）
  function _resolveInsertBase(targetEd, anchor) {
    if (anchor && anchor.ok) {
      var r = _anchorRange(anchor);
      if (r) return { ok: true, model: anchor.model, range: r, l: r.startLineNumber, c: r.startColumn, via: 'anchor' };
      anchor.ok = false;
    }
    try {
      var model = _modelOf(targetEd);
      if (!model || model.isDisposed()) return { ok: false, dead: true };
      var sel = targetEd.getSelection();
      if (!sel) return { ok: false, dead: true };
      return { ok: true, model: model, range: sel, l: sel.startLineNumber, c: sel.startColumn, via: 'selection' };
    } catch (_) { return { ok: false, dead: true }; }
  }

  // ═══ 插入锚点到编辑器 ═══
  // ★ 2026-08-02 fix: 若光标前一个字符不是空白/换行/文件头 → 先插 \n 再插 token。
  //   防止 📎prev:file📎new:file 相邻锚点拼接（regex 会吞掉后一个 📎 → 合并成一个巨锚点）。
  //   ed 参数: 目标编辑器（分屏安全），不传则用 _editor；anchor = 位置冻结锚（可空，兼容降级）。
  //   返回: 'ok' | 'dead'（目标已消失）| 'skip'（其他失败）。
  function _insertTokenAtCursor(token, metadata, ed, anchor) {
    var targetEd = ed || _editor;
    if (!targetEd) return 'skip';
    var b = _resolveInsertBase(targetEd, anchor);
    if (!b.ok) return 'dead';
    try {
      var insLine = b.l;
      var insCol = b.c;
      // 零宽位且前一字符非空白/换行/行首 → 前缀 \n（防相邻锚点拼接；行列随之后移一行）
      var prefix = '';
      if (b.range.isEmpty() && insCol > 1) {
        var charBefore = b.model.getValueInRange({
          startLineNumber: insLine, startColumn: insCol - 1,
          endLineNumber: insLine, endColumn: insCol
        });
        if (charBefore && !/^[\s\n\r]$/.test(charBefore)) {
          prefix = '\n';
          insLine = insLine + 1;
          insCol = 1;
        }
      }
      var text = prefix + token + '\n';
      _applyInsert(targetEd, b.model, b.range, text);
      if (anchor) _anchorAdvance(anchor, text.length);
      // ★ 2026-09-14 根治：视口机器（viewport-machine，唯一渲染真相）持 per-editor 锚点表，
      //   粘贴必须把真实 path 显式注册进去——否则相框渲染时 path=null → 图无 src（破图），
      //   直到切标签/重开文件触发全量重扫才恢复。注册后相框立即拿到 file:// 源。
      var machine = window.qqqViewportMachine;
      if (machine && machine.registerPastedAnchor) {
        var regEd = targetEd;
        try { if (_modelOf(targetEd) !== b.model) regEd = _liveEdForModel(b.model) || targetEd; } catch (_) {}
        try {
          var meta = metadata || {};
          meta.rawLen = token.length;   // 原文隐藏长度（令牌真实字符数，含引号）
          machine.registerPastedAnchor(regEd, insLine, insCol, meta);
        } catch (_) { /* */ }
      }
      return 'ok';
    } catch (e) {
      console.warn('[paste-router] insert token failed:', e);
      return 'skip';
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 网页/富文本粘贴（老 q3 SmartPaste 移植；消费 html-paste.js 转换结果）
  // ════════════════════════════════════════════════════════════════════════

  // ── 用户偏好（qqq-prefs；缺失 → 出厂语义） ──
  function _prefGet(key, fb) {
    try { return (window.qqqPrefs && window.qqqPrefs.get) ? window.qqqPrefs.get(key) : fb; } catch (_) { return fb; }
  }
  function _securityLevel() {
    var v = String(_prefGet('downloadSecurityLevel', '1: 平衡'));
    if (v.charAt(0) === '0') return 0;
    if (v.charAt(0) === '2') return 2;
    return 1;
  }
  function _autoDownloadOn() { return _prefGet('autoDownload', true) !== false; }
  function _forceTextFlow() { return _prefGet('forceTextFlowScheme', false) === true; }

  function _i18n(key, fb, params) {
    try { if (window._i) return window._i(key, fb, params); } catch (_) { }
    return fb;
  }

  // ── 下载错误码 → 本地化文案（静态键表；禁动态键拼接） ──
  var _DL_ERR_KEYS = {
    'protocol_not_allowed': ['pasteDl.errProtocol', '不支持的链接协议（仅 http/https）'],
    'url_credentials_not_allowed': ['pasteDl.errCreds', '链接内含账号密码，不允许'],
    'ssrf_blocked_local_hostname': ['pasteDl.errSsrf', '链接指向内网/本机，已拦截'],
    'ssrf_blocked_ip_literal': ['pasteDl.errSsrf', '链接指向内网/本机，已拦截'],
    'ssrf_blocked_resolved_private_ip': ['pasteDl.errSsrf', '链接指向内网/本机，已拦截'],
    'dns_failed': ['pasteDl.errDns', '域名解析失败'],
    'dest_locked': ['pasteDl.errLocked', '同名文件正在下载（稍后重试）'],
    'declared_too_large': ['pasteDl.errTooLarge', '文件超过大小限制'],
    'file_too_large': ['pasteDl.errTooLarge', '文件超过大小限制'],
    'too_many_redirects': ['pasteDl.errRedirects', '跳转次数过多'],
    'redirect_protocol_blocked': ['pasteDl.errRedirects', '跳转次数过多'],
    'yt-dlp_not_installed': ['pasteDl.errYtdlpMissing', '平台/分片视频需要 yt-dlp（组件未安装）'],
    'ytdlp_failed': ['pasteDl.errYtdlpFail', '视频站下载失败'],
    'ytdlp_output_missing': ['pasteDl.errYtdlpFail', '视频站下载失败'],
    'probe_output_too_large': ['pasteDl.errProbe', '视频列表信息过大，已保护性终止'],
    'blob_url_unavailable': ['pasteDl.errBlob', 'blob: 链接无法直接下载'],
    'invalid_media': ['pasteDl.errInvalidMedia', '文件无效（非视频或已损坏）'],
    'not_an_image': ['pasteDl.errNotImage', '该链接不是图片（可能被防盗链拦截）'],
    'empty_file': ['pasteDl.errEmpty', '下载内容为空'],
    'download_timeout': ['pasteDl.errTimeout', '下载超时'],
    'download_stalled': ['pasteDl.errTimeout', '下载超时'],
    'invalid_header_name': ['pasteDl.errHeader', '请求头非法'],
    'symlink_not_allowed': ['pasteDl.errWrite', '写入被拒绝'],
    'path_is_directory': ['pasteDl.errWrite', '写入被拒绝'],
    'path_not_regular_file': ['pasteDl.errWrite', '写入被拒绝'],
    'path_traversal_blocked': ['pasteDl.errWrite', '写入被拒绝'],
    'write_failed': ['pasteDl.errWrite', '写入被拒绝'],
    'no_dest_dir': ['pasteRouter.noDir', '无法确定粘贴目录（编辑器未关联文件？）'],
    'cancelled': ['pasteDl.errCancelled', '已取消'],
  };
  function _dlErrText(code) {
    var c = String(code || '');
    var hit = _DL_ERR_KEYS[c];
    if (hit) return _i18n(hit[0], hit[1]);
    var m = /^http_(\d+)$/.exec(c);
    if (m) return _i18n('pasteDl.errHttp', '服务器拒绝下载（HTTP {code}）', { code: m[1] });
    if (c === 'bridge_unavailable' || c === 'ytdlp_spawn_failed') return _i18n('pasteDl.errUnavailable', '功能暂不可用（需重启实例）');
    return c || _i18n('pasteRouter.unknownErr', '未知错误');
  }

  // ── URL 粘贴嗅探（老 q3 dow.probeAndSelect 语义移植） ──
  var _URL_IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg|tiff?)(\?|#|$)/i;
  var _URL_VID_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv|flv|ogv|ogg|wmv|mpg|mpeg|m2ts|mts|3gp|vob|asf|f4v|ogm|m3u8|mpd)(\?|#|$)/i;

  // 剪贴板恰为单条 http(s) URL（去首尾空白；含内部空白/超长 → ''）
  function _singleUrlOf(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s || s.length > 2048) return '';
    if (!/^https?:\/\/\S+$/i.test(s)) return '';
    return s;
  }

  // URL 分类: 'image' | 'video' | 'page' | ''（非 http(s)）
  function _classifyUrl(u) {
    var pu;
    try { pu = new URL(u); } catch (_) { return ''; }
    if (pu.protocol !== 'http:' && pu.protocol !== 'https:') return '';
    var p = pu.pathname || '';
    if (_URL_VID_EXT_RE.test(p)) return 'video';
    if (window.qqqHtmlPaste && window.qqqHtmlPaste.isPlatformVideoUrl && window.qqqHtmlPaste.isPlatformVideoUrl(u)) return 'video';
    if (_URL_IMG_EXT_RE.test(p)) return 'image';
    return 'page';
  }

  // yt-dlp 一键获取（错误提示「安装 yt-dlp」按钮入口；按需组件安装）
  var _ytdlpInstalling = false;
  async function _installYtdlp() {
    if (_ytdlpInstalling) return;
    if (!(bridge && bridge.components && bridge.components.install)) {
      if (window.qqqideQoast) window.qqqideQoast.show(_i18n('pasteDl.errUnavailable', '功能暂不可用（需重启实例）'), { duration: 5000 });
      return;
    }
    _ytdlpInstalling = true;
    var ioast = window.qqqideIoast;
    if (ioast) {
      try {
        ioast.task('paste-ytdlp', {
          title: _i18n('pasteDl.installingYtdlp', '正在安装 yt-dlp 组件…'),
          subtitle: '',
        });
      } catch (_) { }
    }
    function _fin(ok, detail) {
      try {
        if (ioast) { if (ok) ioast.done('paste-ytdlp', { summary: detail }); else ioast.fail('paste-ytdlp', { summary: detail }); }
      } catch (_) { }
      if (window.qqqideQoast) {
        if (ok) window.qqqideQoast.show(_i18n('pasteDl.ytdlpReadyPaste', 'yt-dlp 已安装 · 重新粘贴即可下载平台视频'), { duration: 6000, type: 'success' });
        else window.qqqideQoast.show(_i18n('pasteDl.ytdlpInstallFail', 'yt-dlp 安装失败：{msg}', { msg: detail }), { duration: 8000 });
      }
    }
    try {
      var r = await bridge.components.install('yt-dlp');
      if (r && r.ok) _fin(true, _i18n('pasteDl.ytdlpReady', '已就绪'));
      else _fin(false, (r && r.error) ? String(r.error) : 'install_failed');
    } catch (e2) {
      _fin(false, String((e2 && e2.message) || e2));
    } finally {
      _ytdlpInstalling = false;
    }
  }

  // ── qqqide-asset://file/<abs> → 本地路径（自家资产协议；复制 AI 面板图片等场景） ──
  function _assetUriToLocalPath(u) {
    try {
      var au = new URL(String(u || ''));
      if (au.hostname !== 'file') return '';
      var raw = decodeURIComponent(au.pathname || '');
      return raw.charAt(0) === '/' ? raw.slice(1) : raw;
    } catch (_) { return ''; }
  }

  // ── file:// URI → 本地路径 ──
  function _fileUriToLocalPath(u) {
    try {
      var s = String(u || '');
      if (!/^file:\/\//i.test(s)) return '';
      s = s.replace(/^file:\/\//i, '');
      s = s.replace(/^\/([A-Za-z]:)/, '$1');
      try { s = decodeURIComponent(s); } catch (_) { /* */ }
      return s;
    } catch (_) { return ''; }
  }

  // ── 纯文本插入（回退路径；与第 7 步旧行为一致；anchor 冻结插入位，返回 'ok'|'dead'|'skip'） ──
  function _insertPlainAtCursor(targetEd, text, anchor) {
    if (!targetEd || !text) return 'skip';
    var b = _resolveInsertBase(targetEd, anchor);
    if (!b.ok) return 'dead';
    try {
      _applyInsert(targetEd, b.model, b.range, text);
      if (anchor) _anchorAdvance(anchor, text.length);
      return 'ok';
    } catch (_) { return 'skip'; }
  }

  // ── 本地媒体（data:/file:）物化：零网络，渲染层直接落盘 ──
  async function _materializeLocalMedia(blocks, e) {
    var pdir = _getPasteDir(e);
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.type !== 'media' || b.status !== 'pending') continue;
      var src = String(b.src || '');
      try {
        if (/^data:/i.test(src)) {
          var m = /^data:([a-z0-9\+\-\.]+);base64,(.*)$/i.exec(src);
          var mime = m ? String(m[1]).toLowerCase() : '';
          if (!m || (!(mime.indexOf('image/') === 0) && !(mime.indexOf('video/') === 0))) {
            b.status = 'failed'; b.error = 'protocol_not_allowed'; continue;
          }
          if (!pdir) { b.status = 'failed'; b.error = 'no_dest_dir'; continue; }
          var bin = atob(m[2] || '');
          var bytes = new Uint8Array(bin.length);
          for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j) & 0xFF;
          if (!bytes.length) { b.status = 'failed'; b.error = 'empty_file'; continue; }
          var ext0 = mimeToExt[mime] || (mime.indexOf('video/') === 0 ? '.mp4' : '.png');
          var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          var res = await _saveBytes(ab, ext0, e);
          if (res && res.path) {
            b.path = res.path; b.sha256 = res.sha256; b.fileName = res.fileName; b.status = 'ok'; b.bytes = bytes.length;
          } else {
            b.status = 'failed'; b.error = (res && res.error) || 'write_failed';
          }
        } else if (/^file:\/\//i.test(src) || /^qqqide-asset:\/\/file\//i.test(src)) {
          if (!pdir) { b.status = 'failed'; b.error = 'no_dest_dir'; continue; }
          var localPath = /^file:\/\//i.test(src) ? _fileUriToLocalPath(src) : _assetUriToLocalPath(src);
          if (!localPath) { b.status = 'failed'; b.error = 'invalid_url'; continue; }
          var st = null;
          try { st = await bridge.fs.stat(localPath); } catch (_) { st = null; }
          if (!st || st.isDir) { b.status = 'failed'; b.error = 'invalid_url'; continue; }
          var name = localPath.replace(/\\/g, '/').split('/').pop() || 'file';
          var sepL = pdir.indexOf('\\') >= 0 ? '\\' : '/';
          try { await bridge.fs.mkdir(pdir); } catch (_) { }
          var landed = await bridge.fs.copyFile(localPath, pdir + sepL + name);
          var landedPath = (typeof landed === 'string' && landed) ? landed : (pdir + sepL + name);
          var landedName = landedPath.replace(/\\/g, '/').split('/').pop() || name;
          b.path = landedPath; b.fileName = landedName; b.sha256 = ''; b.status = 'ok';
          try { if (bridge.assetRoots && bridge.assetRoots.add) bridge.assetRoots.add(pdir).catch(function () { }); } catch (_) { }
        } else if (/^blob:/i.test(src)) {
          b.status = 'failed'; b.error = 'blob_url_unavailable';
        } else if (/^(cid|about|javascript|mailto|tel):/i.test(src)) {
          b.status = 'failed'; b.error = 'protocol_not_allowed';
        }
        // http(s) → 留待远程阶段
      } catch (ex) {
        b.status = 'failed'; b.error = String((ex && (ex.message || ex)) || 'unknown');
      }
    }
  }

  // ── 远程媒体（http/https）→ 壳层 paste-fetch（安全档位 11 开关 + yt-dlp） ──
  async function _downloadRemoteMedia(blocks, e) {
    var i;
    var remote = [];
    var map = {};
    var uniq = [];
    for (i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.type !== 'media' || b.status !== 'pending' || b.skip) continue;
      var src = String(b.src || '');
      if (!/^https?:/i.test(src)) continue;
      b._tag = 'm' + i;
      remote.push(b);
      if (!map[src]) { map[src] = []; uniq.push(src); }
      map[src].push(b);
    }
    var stat = { ok: 0, fail: 0, bytes: 0, reused: 0, cancelled: false };
    if (!remote.length) return stat;

    var pdir = _getPasteDir(e);
    if (!pdir) { remote.forEach(function (x) { x.status = 'failed'; x.error = 'no_dest_dir'; }); stat.fail = uniq.length; return stat; }
    if (!(bridge && bridge.pasteDl && bridge.pasteDl.fetch)) {
      remote.forEach(function (x) { x.status = 'failed'; x.error = 'bridge_unavailable'; });
      stat.fail = uniq.length;
      return stat;
    }
    try { await bridge.fs.mkdir(pdir); } catch (_) { }

    var tasks = uniq.map(function (s, idx) {
      return { url: s, kind: map[s][0].kind || 'image', destDir: pdir, referrer: map[s][0].referrer || '', tag: 't' + idx };
    });
    var jobId = 'pp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    var ioast = window.qqqideIoast;
    // ★ 每作业独立任务卡（并发粘贴不互相覆写进度/取消——同 id 会让后一次粘贴吞掉前一次的取消句柄）
    var TASK_ID = 'paste-media:' + jobId;
    var doneN = 0, totalN = tasks.length;
    function _updCard() {
      if (ioast && ioast.task) {
        try {
          ioast.task(TASK_ID, {
            title: _i18n('pasteRouter.mediaTask', '网页媒体下载'),
            subtitle: _i18n('pasteRouter.mediaProgress', '{done}/{total}', { done: doneN, total: totalN }),
            count: { done: doneN, total: totalN },
            cancelable: true,
            onCancel: function () { try { bridge.pasteDl.cancel(jobId); } catch (_) { } },
          });
        } catch (_) { }
      }
    }
    _updCard();

    var off = null;
    try {
      off = bridge.pasteDl.onProgress(function (msg) {
        if (!msg || msg.jobId !== jobId) return;
        doneN = msg.done || doneN;
        _updCard();
      });
    } catch (_) { off = null; }

    var res = null;
    try {
      res = await bridge.pasteDl.fetch({ jobId: jobId, destDir: pdir, securityLevel: _securityLevel(), tasks: tasks });
    } catch (errFetch) {
      // 下载机抛异常（IPC 断/壳层崩）→ 收掉任务卡并上抛（上层回落纯文本，内容零丢失）
      if (ioast) { try { ioast.fail(TASK_ID, { summary: _i18n('pasteRouter.mediaSummary', '成功 {ok} · 失败 {fail}', { ok: 0, fail: tasks.length }) }); } catch (_) { } }
      throw errFetch;
    } finally {
      if (off) { try { off(); } catch (_) { } }
    }

    var byTag = {};
    if (res && res.results) {
      for (i = 0; i < res.results.length; i++) {
        var r0 = res.results[i];
        if (r0 && r0.tag) byTag[r0.tag] = r0;
      }
    }
    for (i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var r = byTag[t.tag] || null;
      var list = map[t.url] || [];
      for (var j = 0; j < list.length; j++) {
        var bb = list[j];
        if (r && r.ok && r.path) {
          bb.path = r.path;
          bb.sha256 = r.sha256 || '';
          bb.fileName = r.name || String(r.path).replace(/\\/g, '/').split('/').pop();
          bb.status = 'ok';
          bb.bytes = r.bytes || 0;
          if (r.reused) stat.reused++;
        } else {
          bb.status = 'failed';
          bb.error = (r && r.error) || 'unknown';
        }
      }
      if (r && r.ok) { stat.ok++; stat.bytes += (r.bytes || 0); } else { stat.fail++; }
    }
    if (res && res.stats && res.stats.cancelled) stat.cancelled = true;

    if (ioast) {
      try {
        var summary = _i18n('pasteRouter.mediaSummary', '成功 {ok} · 失败 {fail}', { ok: stat.ok, fail: stat.fail });
        if (stat.ok > 0) ioast.done(TASK_ID, { summary: summary });
        else ioast.fail(TASK_ID, { summary: summary });
      } catch (_) { }
    }
    return stat;
  }

  // ── 组装文本 + 📎 令牌 → 单次 executeEdits → 逐令牌位置登记 ──
  function _normBlockText(t) {
    return String(t == null ? '' : t)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 返回: 'ok' | 'empty'（无内容）| 'dead'（目标编辑器/模型已消失）
  function _insertRich(targetEd, blocks, anchor) {
    var parts = [];
    var tokens = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.type === 'text') {
        var t = _normBlockText(b.text);
        if (t) parts.push(t);
      } else if (b.type === 'media') {
        if (b.path) {
          var fileName = b.fileName || String(b.path).replace(/\\/g, '/').split('/').pop() || 'file';
          var token = _makeAnchorToken(b.sha256 || '', fileName);
          parts.push(token);
          tokens.push({ token: token, meta: { path: b.path, sha256: b.sha256 || '', fileName: fileName } });
        } else if (b.src && !/^data:/i.test(String(b.src))) {
          // 未下载成功的媒体 → 保留原始 URL（data: 巨大内联串禁入正文）
          var su = String(b.src);
          if (su.length <= 500) parts.push(su);
        }
      }
    }
    var content = parts.join('\n');
    content = content.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!content) return 'empty';
    content += '\n';

    var b = _resolveInsertBase(targetEd, anchor);
    if (!b.ok) return 'dead';
    var startLine = b.l;
    var startCol = b.c;
    var prefix = '';
    if (b.range.isEmpty() && startCol > 1) {
      try {
        var cBefore = b.model.getValueInRange({
          startLineNumber: startLine, startColumn: startCol - 1,
          endLineNumber: startLine, endColumn: startCol,
        });
        if (cBefore && !/^[\s\n\r]$/.test(cBefore)) prefix = '\n';
      } catch (_) { /* */ }
    }
    var insertText = prefix + content;
    _applyInsert(targetEd, b.model, b.range, insertText);
    if (anchor) _anchorAdvance(anchor, insertText.length);

    // 令牌位置重算 + viewport 注册（单次插入需要逐令牌登记——缺它相框 path null 破图）
    var machine = window.qqqViewportMachine;
    if (machine && machine.registerPastedAnchor && tokens.length) {
      var regEd = targetEd;
      try { if (_modelOf(targetEd) !== b.model) regEd = _liveEdForModel(b.model) || targetEd; } catch (_) {}
      var lineStarts = [0];
      for (var idx = 0; idx < insertText.length; idx++) {
        if (insertText.charAt(idx) === '\n') lineStarts.push(idx + 1);
      }
      var cursor = 0;
      for (var k = 0; k < tokens.length; k++) {
        var tk = tokens[k];
        var at = insertText.indexOf(tk.token, cursor);
        if (at < 0) continue;
        cursor = at + tk.token.length;
        var lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
          var mid = (lo + hi + 1) >> 1;
          if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1;
        }
        var col = (lo === 0) ? (startCol + at) : (at - lineStarts[lo] + 1);
        var absLine = startLine + lo;
        try {
          var metaIn = tk.meta;
          metaIn.rawLen = tk.token.length;
          machine.registerPastedAnchor(regEd, absLine, col, metaIn);
        } catch (_) { /* */ }
      }
    }
    return 'ok';
  }

  // ── 富文本粘贴主编排 ──
  async function _richPaste(targetEd, e, conv, anchor) {
    var blocks = conv.blocks || [];
    var i;

    // autoDownload=false → 视频类媒体不下载（保留原始 URL 文本）
    var autoDl = _autoDownloadOn();
    var vidSkipped = 0;
    if (!autoDl) {
      for (i = 0; i < blocks.length; i++) {
        var vb = blocks[i];
        if (vb.type === 'media' && vb.kind === 'video' && vb.status === 'pending') { vb.skip = true; vidSkipped++; }
      }
    }

    // 给媒体补 referrer（<base href> 若在；防盗链站点提升命中率）
    var baseRef = (conv.meta && conv.meta.baseUrl) || '';
    if (baseRef) {
      for (i = 0; i < blocks.length; i++) {
        var rb = blocks[i];
        if (rb.type === 'media' && !rb.referrer) rb.referrer = baseRef;
      }
    }

    // 本地媒体（data:/file:）→ 渲染层直接落盘
    await _materializeLocalMedia(blocks, e);

    // 远程媒体（http/https）→ 壳层下载机
    var stat = await _downloadRemoteMedia(blocks, e);

    // 组装 + 单次插入（'dead' = 目标编辑器已关闭：媒体已保存的诚实反馈——内容仍在剪贴板可重贴）
    var ins = _insertRich(targetEd, blocks, anchor);
    if (ins === 'dead') {
      var savedN = 0;
      for (i = 0; i < blocks.length; i++) { if (blocks[i].type === 'media' && blocks[i].status === 'ok') savedN++; }
      if (savedN > 0 && window.qqqideQoast) {
        window.qqqideQoast.show(_i18n('pasteRouter.editorClosed', '目标编辑器已关闭：{n} 个媒体已保存到 _qqqvault（内容仍在剪贴板，可重新粘贴）', { n: savedN }), { duration: 8000 });
      }
      return true;   // 编排终结（无处可插，不再回落纯文本）
    }
    if (ins !== 'ok') return false;

    // VIG 履历（媒体字节 + 文本长度）
    var textLen = 0;
    for (i = 0; i < blocks.length; i++) { if (blocks[i].type === 'text') textLen += (blocks[i].text || '').length; }
    if ((stat && stat.ok > 0) || textLen > 0) { _vigPaste(((stat && stat.bytes) ? stat.bytes : 0) + textLen); }

    // 失败汇总（有失败才提示；全成功静默——媒体帧即反馈）
    var failed = [];
    for (i = 0; i < blocks.length; i++) {
      var bb = blocks[i];
      if (bb.type === 'media' && bb.status === 'failed') failed.push(bb);
    }
    if (failed.length && window.qqqideQoast) {
      var codes = {};
      for (i = 0; i < failed.length; i++) {
        var c = String(failed[i].error || 'unknown');
        codes[c] = (codes[c] || 0) + 1;
      }
      var parts = [];
      for (var kk in codes) {
        if (Object.prototype.hasOwnProperty.call(codes, kk)) parts.push(_dlErrText(kk) + (codes[kk] > 1 ? (' ×' + codes[kk]) : ''));
      }
      // ★ yt-dlp 缺口 → qoast 挂「安装组件」按钮（一键按需安装；常驻待操作）
      var _ytMissing = !!codes['yt-dlp_not_installed'];
      var _qopts = { duration: _ytMissing ? 0 : 7000 };
      if (_ytMissing && bridge && bridge.components && bridge.components.install) {
        _qopts.actions = [{
          label: _i18n('pasteDl.installYtdlp', '安装 yt-dlp'),
          onClick: function () { _installYtdlp(); },
        }];
      }
      window.qqqideQoast.show(_i18n('pasteRouter.richSomeFail', '网页粘贴：{n} 个媒体未下载（{detail}）', { n: failed.length, detail: parts.join('；') }), _qopts);
    } else if (vidSkipped > 0 && window.qqqideQoast) {
      window.qqqideQoast.show(_i18n('pasteRouter.videoSkipped', '已保留 {n} 个视频链接（自动下载已关闭）', { n: vidSkipped }), { duration: 5000 });
    }
    return true;
  }

  // ── URL 粘贴（单条 URL；老 q3 dow.probeAndSelect 语义：直链直下 / 平台视频 yt-dlp / 网页嗅探视频）──
  //   规则: 下载成 → 📎 锚点；失败/取消/无视频 → 原文纯文本（内容零丢失，行为永不低于普通粘贴）。
  async function _urlPaste(targetEd, e, url, cls, anchor) {
    var ioast = window.qqqideIoast;

    // 直链图片/视频（含平台视频 URL）→ 下载管线（平台/分片在壳层自动分流 yt-dlp）
    if (cls === 'image' || cls === 'video') {
      await _richPaste(targetEd, e, {
        blocks: [{ type: 'media', kind: cls, src: url, status: 'pending' }],
        meta: { mediaCount: 1 },
      }, anchor);
      return;
    }

    // 普通网页 → 壳层抓取（无 CORS）→ 视频 URL 嗅探
    if (!(bridge && bridge.pasteDl && bridge.pasteDl.fetchPage)) {
      _insertPlainAtCursor(targetEd, url, anchor);
      return;
    }
    var jid = 'pf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var TASK_ID = 'paste-url:' + jid;   // ★ 每嗅探作业独立卡（并发粘贴不互相覆写）
    if (ioast) {
      try {
        ioast.task(TASK_ID, {
          title: _i18n('pasteDl.sniffTitle', '网页视频嗅探'),
          subtitle: _i18n('pasteDl.sniffFetching', '正在抓取页面…'),
          cancelable: true,
          onCancel: function () { try { bridge.pasteDl.cancel(jid); } catch (_) { } },
        });
      } catch (_) { }
    }
    var res = null;
    try {
      res = await bridge.pasteDl.fetchPage({ jobId: jid, url: url, securityLevel: _securityLevel() });
    } catch (_) { res = null; }
    if (ioast) { try { ioast.remove(TASK_ID); } catch (_) { } }

    // 无扩展名直链媒体（壳层按响应 mime 判型）→ 交下载机
    if (res && res.ok && res.directKind) {
      await _richPaste(targetEd, e, {
        blocks: [{ type: 'media', kind: res.directKind === 'video' ? 'video' : 'image', src: res.finalUrl || url, status: 'pending' }],
        meta: { mediaCount: 1 },
      }, anchor);
      return;
    }

    var vids = [];
    if (res && res.ok && res.html) {
      try {
        vids = window.qqqHtmlPaste ? window.qqqHtmlPaste.extractVideoUrls(res.html, res.finalUrl || url) : [];
      } catch (_) { vids = []; }
    }
    if (!vids.length) {
      // 无视频/抓取失败/取消 → 普通纯文本粘贴（零丢失）
      _insertPlainAtCursor(targetEd, url, anchor);
      return;
    }
    var blocks = [];
    for (var i = 0; i < vids.length; i++) {
      blocks.push({ type: 'media', kind: 'video', src: vids[i], status: 'pending', referrer: res.finalUrl || url });
    }
    await _richPaste(targetEd, e, { blocks: blocks, meta: { mediaCount: blocks.length } }, anchor);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 工作台入口（2026-10-03）：Paste 按钮 / 视频 Url 行——对目标编辑器执行等效操作
  // ════════════════════════════════════════════════════════════════════════

  // data: URL → Blob（桥读剪贴板图片合成粘贴载荷用；同步）
  function _dataUrlToBlob(dataUrl) {
    try {
      var m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(String(dataUrl || ''));
      if (!m) return null;
      var mime = m[1] || 'image/png';
      var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xFF;
      return new Blob([bytes], { type: mime });
    } catch (_) { return null; }
  }

  // 合成等价 ClipboardEvent 载荷（桥读内容 → klipzap.probe 同一机器解析 → 下游路由与真 Ctrl+V 完全同构）
  function _synthPasteEvent(targetEd, text, html, imageBlob, paths) {
    var types = [];
    var items = [];
    var data = {};
    var fileList = [];
    if (text) { types.push('text/plain'); data['text/plain'] = text; }
    if (html) { types.push('text/html'); data['text/html'] = html; }
    if (imageBlob) {
      types.push('Files');
      items.push({ kind: 'file', type: String(imageBlob.type || 'image/png'), getAsFile: function () { return imageBlob; } });
    }
    if (paths && paths.length) {
      types.push('Files');
      for (var i = 0; i < paths.length; i++) {
        var nm = String(paths[i]).replace(/\\/g, '/').split('/').pop() || 'file';
        var f = null;
        try { f = new File([], nm); } catch (_) { f = null; }
        if (!f) continue;
        (function (ff) {
          items.push({ kind: 'file', type: '', getAsFile: function () { return ff; } });
        })(f);
        fileList.push(f);
      }
    }
    if (!types.length) return null;
    var target = null;
    try { if (targetEd && targetEd.getDomNode) target = targetEd.getDomNode(); } catch (_) { target = null; }
    var cd = {
      types: types,
      items: items,
      files: fileList,
      getData: function (t) { return Object.prototype.hasOwnProperty.call(data, t) ? data[t] : ''; },
    };
    return {
      clipboardData: cd,
      target: target,
      preventDefault: function () { },
      stopPropagation: function () { },
      __qqqPasteEd: targetEd || null,
    };
  }

  // ★ Paste 按钮（工作台）：对目标编辑器执行「等效 Ctrl+V」
  //   语义 = 把剪贴板内容按同一条粘贴管线放进目标编辑器（图片/文件/网页富文本/URL 嗅探全支持）。
  //   实现 = 桥读剪贴板（probe/readText/readHtml/readImage/readFiles）→ 合成等价载荷 → 复用 _onPaste 全部下游。
  //   ★ 为什么不用 execCommand('paste')：Chromium 行为随权限/版本漂移不可验证；桥读路径 100% 确定。
  //   返回: 'ok' | 'empty'（剪贴板空）| 'need_bridge'（旧壳层）| 'no_editor'（无目标）
  async function pasteInto(ed) {
    var targetEd = ed || _editor || null;
    if (!targetEd) return 'no_editor';
    if (!(bridge && bridge.clipboard && bridge.clipboard.probe)) return 'need_bridge';
    try { if (targetEd.focus) targetEd.focus(); } catch (_) { }

    var p = null;
    try { p = await bridge.clipboard.probe(); } catch (_) { p = null; }
    if (!p) return 'need_bridge';

    var text = '';
    var html = '';
    var imageBlob = null;
    var paths = [];
    try { if (p.hasText && bridge.clipboard.readText) text = String((await bridge.clipboard.readText()) || ''); } catch (_) { }
    try { if (p.hasHtml && bridge.clipboard.readHtml) html = String((await bridge.clipboard.readHtml()) || ''); } catch (_) { }
    try {
      if (p.hasImage && bridge.clipboard.readImage) {
        var du = await bridge.clipboard.readImage();
        imageBlob = _dataUrlToBlob(du);
      }
    } catch (_) { }
    try { if (p.hasFile && bridge.clipboard.readFiles) paths = (await bridge.clipboard.readFiles()) || []; } catch (_) { paths = []; }
    if (!text && !html && !imageBlob && !(paths && paths.length)) return 'empty';

    var fake = _synthPasteEvent(targetEd, text, html, imageBlob, paths);
    if (!fake) return 'empty';
    var pr = klipzap ? klipzap.probe(fake) : null;
    if (!pr) return 'need_bridge';

    try { _getPasteDir(fake); } catch (_) { }   // 粘贴瞬间固化目标目录（长异步防漂移）

    var _hasRichHtml = !!(pr.hasHtml && !pr.hasImage && !pr.hasFile);
    if (pr.isPureText && !_hasRichHtml) {
      if (!text) return 'empty';
      var u1 = _singleUrlOf(text);
      var ucls = u1 ? _classifyUrl(u1) : '';
      var a0 = _anchorNew(targetEd);   // 位置冻结锚
      try {
        if (ucls && _autoDownloadOn() && bridge && bridge.pasteDl) {
          await _urlPaste(targetEd, fake, u1, ucls, a0);
        } else {
          _insertPlainAtCursor(targetEd, text, a0);
        }
      } finally {
        _anchorDrop(a0);
      }
      return 'ok';
    }

    var anchor = _anchorNew(targetEd);
    try { await _handleOwnedPaste(targetEd, fake, pr, anchor); }
    finally { _anchorDrop(anchor); }
    return 'ok';
  }

  // ★ 视频 Url 行（工作台）：把输入框 URL 交给同一条 URL 粘贴机器
  //   分流与粘贴完全同源（_classifyUrl → 直链图片/视频下载 / 平台视频 yt-dlp / 网页抓取嗅探）。
  //   插入 = 目标编辑器当前光标（冻结锚；下载期间切标签/打字安全）。
  //   返回: 'ok' | 'invalid'（非 http(s)）| 'no_dir'（目标文档未保存）| 'no_editor'
  async function pasteUrlInto(ed, url) {
    var targetEd = ed || _editor || null;
    if (!targetEd) return 'no_editor';
    var u = String(url == null ? '' : url).trim();
    var cls = u ? _classifyUrl(u) : '';
    if (!cls) return 'invalid';
    var fake = {
      clipboardData: null,
      target: null,
      preventDefault: function () { },
      stopPropagation: function () { },
      __qqqPasteEd: targetEd,
    };
    try { fake.target = targetEd.getDomNode ? targetEd.getDomNode() : null; } catch (_) { fake.target = null; }
    var dir = null;
    try { dir = _getPasteDir(fake); } catch (_) { dir = null; }
    if (!dir) return 'no_dir';   // 目标文档未保存 → 媒体无法落盘（宁可先如实拒绝）
    var anchor = _anchorNew(targetEd);
    try { await _urlPaste(targetEd, fake, u, cls, anchor); }
    finally { _anchorDrop(anchor); }
    return 'ok';
  }

  // ═══ 粘贴 handler ═══
  // ★ 关键: probe 是同步的，preventDefault 只在需要我们自己处理时才调！

  async function _onPaste(e) {
    // ★ 第 0 步：确认事件来自 Monaco 编辑器（document 监听会捕获所有 paste）。
    //   非编辑器区域 → 不拦截，让浏览器原生处理（input/textarea 等正常粘贴）。
    var targetEd = _findEditorFromEvent(e);
    if (!targetEd) return;  // not in any Monaco editor → pass through

    // ★ 第 1 步：真·同步探针（sub-ms，零 IPC）
    // 守卫：启动早期 klipzap 可能尚未加载 → 透传给 Monaco 原生处理
    if (!klipzap) return;
    var t0 = performance.now();
    var pr = klipzap.probe(e);
    var wqTime = performance.now() - t0;

    // ★ 第 2 步：记录前摇统计
    if (wqStats && wqStats.record) {
      wqStats.record(wqTime);
    }

    // ★ 第 3 步：纯文本（无图无文件）→ 让 Monaco 原生处理
    //   isPureText 只看图/文件，不管 HTML。浏览器粘贴标配 text/html+text/plain；
    //   纯文字（如记事本复制，无 HTML）仍走 Monaco 原生（零额外延迟）。
    // ★ 2026-10-03 网页粘贴：带 text/html 的粘贴改为本机接管（富文本转换 + 媒体下载 + 📎 相框）。
    // ★ 2026-10-03 URL 粘贴（老 q3 dow.probeAndSelect 移植）：剪贴板恰为单条 http(s) URL 且自动下载开启
    //   → 直链图片/视频直接下载；平台视频走 yt-dlp；普通网页抓取嗅探视频；失败一律回落普通纯文本粘贴。
    var _hasRichHtml = !!(pr.hasHtml && !pr.hasImage && !pr.hasFile);
    if (pr.isPureText && !_hasRichHtml) {
      if (_autoDownloadOn() && bridge && bridge.pasteDl) {
        var _urltxt = '';
        try { _urltxt = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : ''; } catch (_) { _urltxt = ''; }
        var _oneUrl = _singleUrlOf(_urltxt);
        var _ucls = _oneUrl ? _classifyUrl(_oneUrl) : '';
        if (_ucls) {
          e.preventDefault();
          e.stopPropagation();
          try { _getPasteDir(e); } catch (_) { }   // 粘贴瞬间固化目标目录（长异步防漂移）
          var _ancUrl = _anchorNew(targetEd);      // 位置冻结锚（嗅探/下载期间切标签/打字安全）
          try {
            await _urlPaste(targetEd, e, _oneUrl, _ucls, _ancUrl);
          } catch (errUrl) {
            console.warn('[paste-router] url paste failed → plain fallback:', errUrl);
            _insertPlainAtCursor(targetEd, _urltxt, _ancUrl);
          } finally {
            _anchorDrop(_ancUrl);
          }
          return;
        }
      }
      return;
    }

    // ★ 第 4 步：下面全是需要我们自己处理的情况 → 阻止 Monaco
    e.preventDefault();
    e.stopPropagation();

    // ★ 插入位置冻结（2026-10-03 边界审计）：按下瞬间固化目标目录 + 位置锚——下载/复制
    //   长异步期间切标签、打字、关 tab 都不会把内容落到错误位置（详见 _anchorNew/_resolveInsertBase）。
    try { _getPasteDir(e); } catch (_) { }
    var anchor = _anchorNew(targetEd);
    try {
      await _handleOwnedPaste(targetEd, e, pr, anchor);
    } catch (errOwn) {
      console.warn('[paste-router] owned paste failed:', errOwn);
    } finally {
      _anchorDrop(anchor);
    }
  }

  // ── 已接管粘贴的实体（第 5/6/7 步：图片 / 文件 / HTML 富文本；anchor = 位置冻结锚，可空）──
  async function _handleOwnedPaste(targetEd, e, pr, anchor) {

    // ★ 第 5 步：图片粘贴
    if (pr.hasImage && pr.imageBlobs.length > 0) {
      var _vigImgOk = 0, _vigImgBytes = 0, _imgLost = 0;
      for (var k = 0; k < pr.imageBlobs.length; k++) {
        var ib = pr.imageBlobs[k];
        var ext = mimeToExt[ib.type] || '.png';
        var result = await _saveImage(ib.blob, ext, e);
        if (result && result.path) {
          _vigImgOk++;
          _vigImgBytes += (ib.blob && ib.blob.size) || 0;
          var token = _makeAnchorToken(result.sha256, result.fileName);
          if (_insertTokenAtCursor(token, { path: result.path, sha256: result.sha256, fileName: result.fileName }, targetEd, anchor) === 'dead') _imgLost++;
        } else {
          // Image save failed — insert a placeholder token so user knows something happened
          var fn2 = genName(ext);
          var token2 = _makeAnchorToken('', fn2);
          if (_insertTokenAtCursor(token2, { path: null, sha256: '', fileName: fn2 }, targetEd, anchor) === 'dead') { /* 无处可插 */ }
          var errMsg = (result && result.error) ? result.error : (window._i ? window._i('pasteRouter.unknownErrSave', '未知错误（保存未返回结果）') : '未知错误（保存未返回结果）');
          console.error('[paste-router] 图片保存失败: ' + errMsg);
          if (window.qqqideQoast) {
            window.qqqideQoast.show((window._i ? window._i('pasteRouter.imgSaveFail', '粘贴图片失败: {msg}', { msg: errMsg }) : ('粘贴图片失败: ' + errMsg)), { duration: 5000 });
          }
        }
      }
      if (_vigImgOk > 0) { _vigPaste(_vigImgBytes); }
      if (_imgLost > 0 && _vigImgOk > 0 && window.qqqideQoast) {
        window.qqqideQoast.show(_i18n('pasteRouter.editorClosed', '目标编辑器已关闭：{n} 个媒体已保存到 _qqqvault（内容仍在剪贴板，可重新粘贴）', { n: _vigImgOk }), { duration: 8000 });
      }
      return;
    }

    // ★ 第 6 步：文件/文件夹粘贴
    //   2026-08-13 升级: CF_HDROP 完整路径优先 → 文件夹递归复制 + 原生流式，与 roam 共用
    //   同一主进程引擎（qqqide:fs:copyFile 目录感知）；文件夹复制进 _qqqvault/ 后插锚点
    //   （所见即所得：锚点带真实 path，可打开/渲染）。DOM-only（无 CF_HDROP）降级插文件名锚点。
    if (pr.hasFile && pr.fileList.length > 0) {
      var fullPaths = [];
      if (bridge && bridge.clipboard && bridge.clipboard.readFiles) {
        try { fullPaths = await bridge.clipboard.readFiles(); } catch (_) { fullPaths = []; }
      }
      if (fullPaths.length > 0) {
        var pdir = _getPasteDir(e);
        if (pdir) {
          try { if (bridge && bridge.fs && bridge.fs.mkdir) await bridge.fs.mkdir(pdir); } catch (_) {}
          var psep = pdir.indexOf('\\') >= 0 ? '\\' : '/';
          var seenP = {};
          var copiedOk = 0, copiedFail = 0, _fileLost = 0;
          var landedListP = [];
          for (var n = 0; n < fullPaths.length; n++) {
            var fp = fullPaths[n];
            var fnP = fp.replace(/\\/g, '/').split('/').pop() || 'file';
            if (seenP[fnP]) continue;
            seenP[fnP] = true;
            var dstP = pdir + psep + fnP;
            try {
              if (!bridge || !bridge.fs || !bridge.fs.copyFile) throw new Error('fs.copyFile missing');
              // ★ 2026-08-24: copyFile 返回最终落盘路径——去重命中（同内容已存在）或
              //   唯一化改名（" (n)"）后锚点必须指向真实文件，禁死用 dstP。
              var landed = await bridge.fs.copyFile(fp, dstP);
              copiedOk++;
              var landedPath = (typeof landed === 'string' && landed) ? landed : dstP;
              landedListP.push(landedPath);
              var landedName = landedPath.replace(/\\/g, '/').split('/').pop() || fnP;
              // 注册资产根目录（缩略图/打开可用）
              if (bridge && bridge.assetRoots && bridge.assetRoots.add) {
                bridge.assetRoots.add(pdir).catch(function () {});
              }
              if (_insertTokenAtCursor(_makeAnchorToken('', landedName), { path: landedPath, sha256: '', fileName: landedName }, targetEd, anchor) === 'dead') _fileLost++;
            } catch (err) {
              copiedFail++;
              console.warn('[paste-router] 复制失败:', fp, err && err.message);
            }
          }
          if (copiedFail > 0 && window.qqqideQoast) {
            window.qqqideQoast.show((window._i ? window._i('pasteRouter.imgPasteDone', '粘贴: {ok} 成功, {fail} 失败', { ok: copiedOk, fail: copiedFail }) : ('粘贴: ' + copiedOk + ' 成功, ' + copiedFail + ' 失败')), { duration: 4000 });
          }
          if (copiedOk > 0) { _vigPaste(await _sumSizes(landedListP)); }
          if (_fileLost > 0 && copiedOk > 0 && window.qqqideQoast) {
            window.qqqideQoast.show(_i18n('pasteRouter.editorClosed', '目标编辑器已关闭：{n} 个媒体已保存到 _qqqvault（内容仍在剪贴板，可重新粘贴）', { n: copiedOk }), { duration: 8000 });
          }
          return;
        }
        // 无编辑文件（_getPasteDir null）→ 降级插文件名锚点
      }
      // DOM-only 兜底（无 CF_HDROP：浏览器拖拽等）→ 仅文件名锚点
      var seen = {};
      for (var m = 0; m < pr.fileList.length; m++) {
        var df = pr.fileList[m];
        var fn = df.name || 'file';
        if (seen[fn]) continue;
        seen[fn] = true;
        var token3 = _makeAnchorToken('', fn);
        _insertTokenAtCursor(token3, { path: null, sha256: '', fileName: fn }, targetEd, anchor);
      }
      return;
    }

    // ★ 第 7 步：HTML 粘贴（网页/富文本，无图无文件）——老 q3 SmartPaste 移植
    //   转换（html-paste）→ 媒体物化（本地直落 / 远程壳层下载）→ 结构化文本 + 📎 锚点单次插入。
    //   任何环节失败 → 回退纯文本直插（行为永不低于旧版）。
    if (pr.hasHtml || pr.hasText) {
      var htmlStr = '';
      try { htmlStr = e.clipboardData ? (e.clipboardData.getData('text/html') || '') : ''; } catch (_) { }
      var plainStr = '';
      try { plainStr = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : ''; } catch (_) { }
      // ★ 乱码回修（编码检测增强）：plain 侧 UTF-8 被误读为 latin1 的文本还原（html 侧在 process() 内同源处理）
      if (plainStr && window.qqqHtmlPaste && window.qqqHtmlPaste.repairMojibake) {
        try { plainStr = window.qqqHtmlPaste.repairMojibake(plainStr); } catch (_) { }
      }

      if (htmlStr && window.qqqHtmlPaste) {
        var conv = null;
        try {
          conv = window.qqqHtmlPaste.process(htmlStr, plainStr, { forceTextFlow: _forceTextFlow() });
        } catch (errConv) {
          conv = null;
          console.warn('[paste-router] html-paste failed:', errConv);
        }
        if (conv && conv.blocks && conv.blocks.length) {
          // 老 q3 同规：纯文本像 Markdown 且 HTML 无媒体 → 原文直插（零改写）
          var markdownDirect = !!(plainStr && conv.meta && conv.meta.domMedia === 0 && window.qqqHtmlPaste.looksLikeMarkdown(plainStr));
          if (markdownDirect) {
            _insertPlainAtCursor(targetEd, plainStr, anchor);
            return;
          }
          try {
            var okRich = await _richPaste(targetEd, e, conv, anchor);
            if (okRich) return;
          } catch (errRich) {
            console.warn('[paste-router] rich paste failed → plain fallback:', errRich);
          }
        }
      }

      // 回退：纯文本直插（原行为）
      _insertPlainAtCursor(targetEd, plainStr, anchor);
      return;
    }
  }

  // ── 网页内容拖拽（无系统文件；浏览器选区/图片/链接）——与 Ctrl+V 富文本第 7 步同一机器 ──
  //   html → html-paste 转换（媒体经壳层下载落 _qqqvault 出相框）；uri-list-only → 纯文本
  //   （拖拽语义 = 把引用内容放进文档；「URL 粘贴嗅探下载」意图由粘贴路径承担，两者不混）。
  async function _handleWebDrop(targetEd, e, dt) {
    var html = '', plain = '', uri = '';
    try { html = dt.getData('text/html') || ''; } catch (_) { }
    try { plain = dt.getData('text/plain') || ''; } catch (_) { }
    try { uri = dt.getData('text/uri-list') || ''; } catch (_) { }
    if (!html && !uri) return false;   // 纯文本拖拽 → 不接管（Monaco 原生落点插入）

    e.preventDefault();
    e.stopPropagation();

    try { _getPasteDir(e); } catch (_) { }   // 拖放瞬间固化目标目录（下载长异步防漂移）
    var anchor = _anchorNew(targetEd, _dropPointOf(targetEd, e));   // ★ 落点冻结锚（指针位置优先，选区兜底）
    try {
      // 1) uri-list-only（链接/地址栏拖拽）→ 纯文本：file:// 归一为本地路径，多条目逐行
      if (!html && uri) {
        var _txt = plain;
        if (!_txt) {
          var _lines = String(uri).split(/\r?\n/);
          var _out = [];
          for (var li = 0; li < _lines.length; li++) {
            var _ln = _lines[li].trim();
            if (!_ln || _ln.charAt(0) === '#') continue;   // RFC 2483：'#' 开头为注释行
            _out.push(/^file:\/\//i.test(_ln) ? (_fileUriToLocalPath(_ln) || _ln) : _ln);
          }
          _txt = _out.join('\n');
        }
        if (_txt) _insertPlainAtCursor(targetEd, _txt, anchor);
        return true;
      }
      // 2) HTML 富文本（图片/视频 → 下载落盘出相框）——与第 7 步镜像
      var plainStr = plain;
      if (plainStr && window.qqqHtmlPaste && window.qqqHtmlPaste.repairMojibake) {
        try { plainStr = window.qqqHtmlPaste.repairMojibake(plainStr); } catch (_) { }
      }
      if (html && window.qqqHtmlPaste) {
        var conv = null;
        try {
          conv = window.qqqHtmlPaste.process(html, plainStr, { forceTextFlow: _forceTextFlow() });
        } catch (errConv) {
          conv = null;
          console.warn('[paste-router] drop html-paste failed:', errConv);
        }
        if (conv && conv.blocks && conv.blocks.length) {
          var markdownDirect = !!(plainStr && conv.meta && conv.meta.domMedia === 0 && window.qqqHtmlPaste.looksLikeMarkdown(plainStr));
          if (markdownDirect) {
            _insertPlainAtCursor(targetEd, plainStr, anchor);
            return true;
          }
          try {
            var okRich = await _richPaste(targetEd, e, conv, anchor);
            if (okRich) return true;
          } catch (errRich) {
            console.warn('[paste-router] drop rich paste failed → plain fallback:', errRich);
          }
        }
      }
      _insertPlainAtCursor(targetEd, plainStr, anchor);
      return true;
    } finally {
      _anchorDrop(anchor);
    }
  }

  // ═══ 拖放接收（2026-08-24；2026-10-03 网页内容接管）═══
  // 拖入 Monaco 编辑器 = 粘贴一切（WYSIWYG）:
  //   · 系统文件（Files）→ 图片/文件/文件夹 copyFile 进 _qqqvault/（目录感知递归复制，去重+唯一化）
  //   · ★ 网页内容（浏览器选区/图片/链接：无 Files 但有 text/html / text/uri-list）→ _handleWebDrop
  //   统一插入 📎 锚点 → ContentWidget 所见即所得；插入点 = 指针落点（不可得回落选区）。
  // 由主窗口 drop-overlay.js 在拖放悬停于编辑器时调用（内部 DOM 选区拖拽已由 overlay 让路）。
  async function handleDrop(e) {
    var targetEd = _findEditorFromEvent(e);
    if (!targetEd) return false;
    var dt = e.dataTransfer;
    if (!dt) return false;

    // ★ 无系统文件的网页内容 → 富文本管线（图片等媒体经壳层下载落 _qqqvault 出相框）
    if (!dt.files || dt.files.length === 0) {
      return await _handleWebDrop(targetEd, e, dt);
    }

    e.preventDefault();
    e.stopPropagation();

    try { _getPasteDir(e); } catch (_) { }   // 拖放瞬间固化目标目录（复制长异步防漂移）
    var anchor = _anchorNew(targetEd, _dropPointOf(targetEd, e));   // 位置冻结锚（落点；复制期间切标签/打字安全）

    var imageFiles = [];
    var otherFiles = [];
    for (var i = 0; i < dt.files.length; i++) {
      var f = dt.files[i];
      if (f.type && f.type.indexOf('image/') === 0) imageFiles.push(f);
      else otherFiles.push(f);
    }

    var pdir = _getPasteDir(e);
    if (pdir) {
      try { if (bridge && bridge.fs && bridge.fs.mkdir) await bridge.fs.mkdir(pdir); } catch (_) {}
    }

    var copiedOk = 0, copiedFail = 0, _dropLost = 0;
    var _dropLanded = [];
    var seen = {};

    // 统一落盘函数: 有完整路径 → 原生流式复制（保原名，目录感知）；无路径 → 图片 blob 写盘
    async function _land(f, isImage) {
      var name = f.name || 'file';
      if (seen[name]) return;
      seen[name] = true;

      if (!pdir) {
        // 无法确定落盘目录 → 仅插文件名锚点（无真实路径，所见即所得降级）
        _insertTokenAtCursor(_makeAnchorToken('', name), { path: null, sha256: '', fileName: name }, targetEd, anchor);
        return;
      }
      var sep = pdir.indexOf('\\') >= 0 ? '\\' : '/';

      // 有路径 → copyFile（流式 + 去重 + 唯一化，与 roam/粘贴共用主进程单一真理）
      if (f.path) {
        var dst = pdir + sep + name;
        try {
          var landed = await bridge.fs.copyFile(f.path, dst);
          copiedOk++;
          var landedPath = (typeof landed === 'string' && landed) ? landed : dst;
          _dropLanded.push(landedPath);
          var landedName = landedPath.replace(/\\/g, '/').split('/').pop() || name;
          if (bridge && bridge.assetRoots && bridge.assetRoots.add) {
            bridge.assetRoots.add(pdir).catch(function () {});
          }
          if (_insertTokenAtCursor(_makeAnchorToken('', landedName), { path: landedPath, sha256: '', fileName: landedName }, targetEd, anchor) === 'dead') _dropLost++;
        } catch (err) {
          copiedFail++;
          console.warn('[paste-router] drop 复制失败:', f.path, err && err.message);
        }
        return;
      }

      // 无路径图片 → blob 写盘（生成名）
      if (isImage) {
        var ext = mimeToExt[f.type] || _extFromName(name) || '.png';
        var result = await _saveImage(f, ext, e);
        if (result && result.path) {
          copiedOk++;
          _dropLanded.push(result.path);
          if (_insertTokenAtCursor(_makeAnchorToken(result.sha256, result.fileName), { path: result.path, sha256: result.sha256, fileName: result.fileName }, targetEd, anchor) === 'dead') _dropLost++;
        } else {
          copiedFail++;
          _insertTokenAtCursor(_makeAnchorToken('', name), { path: null, sha256: '', fileName: name }, targetEd, anchor);
          var errMsg = (result && result.error) ? result.error : (window._i ? window._i('pasteRouter.unknownErr', '未知错误') : '未知错误');
          console.error('[paste-router] drop 图片写盘失败: ' + errMsg);
          if (window.qqqideQoast) {
            window.qqqideQoast.show((window._i ? window._i('pasteRouter.dropImgFail', '拖放图片失败: {msg}', { msg: errMsg }) : ('拖放图片失败: ' + errMsg)), { duration: 5000 });
          }
        }
        return;
      }

      // 无路径非图片 → 仅文件名锚点
      _insertTokenAtCursor(_makeAnchorToken('', name), { path: null, sha256: '', fileName: name }, targetEd, anchor);
    }

    for (var k = 0; k < imageFiles.length; k++) await _land(imageFiles[k], true);
    for (var n = 0; n < otherFiles.length; n++) await _land(otherFiles[n], false);
    _anchorDrop(anchor);   // 插入已完成 → 锚收工（幂等；异常路径由装饰自然随模型消亡）

    if (copiedFail > 0 && window.qqqideQoast) {
      window.qqqideQoast.show((window._i ? window._i('pasteRouter.dropDone', '拖放: {ok} 成功, {fail} 失败', { ok: copiedOk, fail: copiedFail }) : ('拖放: ' + copiedOk + ' 成功, ' + copiedFail + ' 失败')), { duration: 4000 });
    }
    if (_dropLost > 0 && copiedOk > 0 && window.qqqideQoast) {
      window.qqqideQoast.show(_i18n('pasteRouter.editorClosed', '目标编辑器已关闭：{n} 个媒体已保存到 _qqqvault（内容仍在剪贴板，可重新粘贴）', { n: copiedOk }), { duration: 8000 });
    }
    if (copiedOk > 0) { _vigPaste(await _sumSizes(_dropLanded)); }
    return true;
  }

  // ═══ 附加/分离 ═══
  // ★ 2026-08-02 重构: 监听 document（capture）而非 per-editor DOM。
  //   旧架构 _domNode = editor.getDomNode() + _attached 只绑一次 →
  //     分屏/新 tab 中粘贴完全不被拦截（paste 在另一个 DOM 上触发）。
  //   新架构 document 单次监听 + _findEditorFromEvent 反查 → 零盲区。
  function attach(editor, monaco) {
    if (!editor) return;
    _editor = editor;
    _monaco = monaco;

    if (_attached) {
      _addAssetWhitelist(editor);
      return;
    }

    _pasteHandler = _onPaste;
    document.addEventListener('paste', _onPaste, true);
    _attached = true;
    _addAssetWhitelist(editor);
  }

  // ★ Auto-whitelist for qqqide-asset://file/ protocol
  //   不硬检查 scheme — 文件可能由 qqqide-asset://file/ 等 scheme 打开。
  function _addAssetWhitelist(editor) {
    if (!bridge || !bridge.assetRoots || !bridge.assetRoots.add) return;
    // ── 当前文件目录 + 其 _qqqvault/ ──
    var cf = null;
    try {
      var edModel2 = editor && editor.getModel && editor.getModel();
      if (edModel2 && edModel2.uri) {
        cf = edModel2.uri.fsPath || edModel2.uri.path;
      }
    } catch (e) { /* */ }
    if (cf) {
      // 补盘符（Monaco Uri.parse 可能吞掉 Windows 盘符）
      if (cf.indexOf(':') < 0 && window._workspaceRoot) {
        var wsDrive2 = window._workspaceRoot.slice(0, Math.max(0, window._workspaceRoot.indexOf(':') + 1));
        if (wsDrive2 && wsDrive2.indexOf(':') >= 0) cf = wsDrive2 + cf.replace(/^\/+/, '');
      }
      var sep2 = cf.indexOf('\\') >= 0 ? '\\' : '/';
      var cfDir = cf.slice(0, cf.lastIndexOf(sep2));
      if (cfDir) {
        bridge.assetRoots.add(cfDir).catch(function () {});
        bridge.assetRoots.add(cfDir + sep2 + '_qqqvault').catch(function () {});
      }
    }
    // ── 兜底：workspace root + 其 _qqqvault/ ──
    if (window._workspaceRoot) {
      bridge.assetRoots.add(window._workspaceRoot).catch(function () {});
      var ws2 = window._workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
      bridge.assetRoots.add(ws2 + '/_qqqvault').catch(function () {});
    }
  }

  function dispose() {
    if (_pasteHandler) {
      document.removeEventListener('paste', _pasteHandler, true);
      _pasteHandler = null;
    }
    _attached = false;
    _editor = null;
    _monaco = null;
  }

  window.qqqPasteRouter = {
    attach: attach,
    dispose: dispose,
    isActive: function () { return _attached; },
    handleDrop: handleDrop,
    handlePaste: _onPaste,
    pasteInto: pasteInto,       // 工作台 Paste 按钮（等效 Ctrl+V → 目标编辑器）
    pasteUrlInto: pasteUrlInto, // 工作台 视频 Url 行（URL → 同一条嗅探/下载机器）
    _makeAnchorToken: _makeAnchorToken,
  };

})();
