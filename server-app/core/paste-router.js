// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// paste-router.js — 编辑器粘贴路由（v3 重写：真·同步探针优先）
//
// 管线:
//   用户 Ctrl+V
//   → klipzap.probe(e) — 同步，sub-ms，零 IPC
//   → 路由:
//       · 纯文本 → return（Monaco 原生粘贴，零额外延迟）
//       · 图片   → preventDefault → 写盘 → 📎{sha256}:{name} 锚点 → ContentWidget
//       · 文件   → preventDefault → 📎:filename 锚点（DOM API 无完整路径）
//       · HTML   → preventDefault → 解析 → 路由或交给 Monaco
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
  var anchorMap = window.qqqAnchorMap;

  var _editor = null;
  var _monaco = null;
  var _attached = false;
  var _pasteHandler = null;  // bound handler for cleanup

  // ═══ Token 生成 ═══
  function _makeAnchorToken(sha256, fileName) {
    var prefix = (sha256 || '').slice(0, 12);
    return '\u{1F4CE}' + prefix + ':' + (fileName || 'file');
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
    if (!e || !e.target || !_monaco) return _editor;
    try {
      if (_monaco.editor && _monaco.editor.getEditors) {
        var editors = _monaco.editor.getEditors();
        for (var i = 0; i < editors.length; i++) {
          var dn = editors[i].getDomNode && editors[i].getDomNode();
          if (dn && dn.contains(e.target)) return editors[i];
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
    var targetEditor = _findEditorFromEvent(e);
    if (!targetEditor) return null;

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
    if (!dir) return null;
    return dir + sep + '_qqqvault';
  }

  var mimeToExt = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
  };

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

  // ═══ 写盘 + hash ═══
  async function _saveImage(blob, ext, e) {
    var dir = _getPasteDir(e);
    if (!dir) {
      console.error('[paste-router] _saveImage: _getPasteDir returned null');
      return { error: '无法确定粘贴目录（编辑器未关联文件？）' };
    }
    console.log('[paste-router] _saveImage: dir=' + dir);

    var ab = await blobToArrayBuffer(blob);
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
    } catch (ex) {
      console.error('[paste-router] writeBase64 失败:', ex && (ex.message || ex), 'fullPath=' + fullPath);
      return { error: '写盘失败: ' + (ex && (ex.message || ex)) };
    }

    // Register paste dir as asset root for thumbnail serving
    if (bridge && bridge.assetRoots && bridge.assetRoots.add) {
      bridge.assetRoots.add(dir).catch(function () {});
    }

    return { path: fullPath, sha256: sha256, fileName: fileName };
  }

  // ═══ 插入锚点到编辑器 ═══
  // ★ 2026-08-02 fix: 若光标前一个字符不是空白/换行/文件头 → 先插 \n 再插 token。
  //   防止 📎prev:file📎new:file 相邻锚点拼接（regex 会吞掉后一个 📎 → 合并成一个巨锚点）。
  //   ed 参数: 目标编辑器（分屏安全），不传则用 _editor。
  function _insertTokenAtCursor(token, metadata, ed) {
    var targetEd = ed || _editor;
    if (!targetEd) return;
    try {
      var sel = targetEd.getSelection();
      if (!sel) return;
      var insLine = sel.startLineNumber;
      var insCol = sel.startColumn;
      var isEmpty = sel.isEmpty();

      // If cursor is at a zero-width position and the char before it is not
      // whitespace/newline/BOL → prepend \n to avoid concatenation with previous anchor.
      var prefix = '';
      if (isEmpty && insCol > 1) {
        try {
          var model = targetEd.getModel();
          if (model) {
            var charBefore = model.getValueInRange({
              startLineNumber: insLine, startColumn: insCol - 1,
              endLineNumber: insLine, endColumn: insCol
            });
            if (charBefore && !/^[\s\n\r]$/.test(charBefore)) {
              prefix = '\n';
              insLine = insLine + 1;
              insCol = 1;
            }
          }
        } catch (_) {}
      }

      targetEd.executeEdits('qqq-paste-router', [{
        range: sel,
        text: prefix + token + '\n',
        forceMoveMarkers: true,
      }]);
      targetEd.focus();
      // Register path immediately so ContentWidget can resolve
      if (metadata && metadata.path && anchorMap && anchorMap.setPath) {
        anchorMap.setPath(insLine, insCol, metadata.path);
      }
      // Notify ContentWidget to sync
      if (anchorMap && anchorMap._notifyListeners) {
        setTimeout(function () { anchorMap._notifyListeners(); }, 80);
      }
    } catch (e) {
      console.warn('[paste-router] insert token failed:', e);
    }
  }

  // ═══ 粘贴 handler ═══
  // ★ 关键: probe 是同步的，preventDefault 只在需要我们自己处理时才调！

  async function _onPaste(e) {
    // ★ 第 0 步：确认事件来自 Monaco 编辑器（document 监听会捕获所有 paste）。
    //   非编辑器区域 → 不拦截，让浏览器原生处理（input/textarea 等正常粘贴）。
    var targetEd = _findEditorFromEvent(e);
    if (!targetEd) return;  // not in any Monaco editor → pass through

    // ★ 第 1 步：真·同步探针（sub-ms，零 IPC）
    var t0 = performance.now();
    var pr = klipzap.probe(e);
    var wqTime = performance.now() - t0;

    // ★ 第 2 步：记录前摇统计
    if (wqStats && wqStats.record) {
      wqStats.record(wqTime);
    }

    // ★ 第 3 步：纯文本（无图无文件）→ 让 Monaco 原生处理
    //   isPureText 只看图/文件，不管 HTML。浏览器粘贴标配 text/html+text/plain，
    //   若 hasHtml 也排除纯文本，那几乎所有外部 Ctrl+V 都会被拦截。
    if (pr.isPureText) {
      return;
    }

    // ★ 第 4 步：下面全是需要我们自己处理的情况 → 阻止 Monaco
    e.preventDefault();
    e.stopPropagation();

    // ★ 第 5 步：图片粘贴
    if (pr.hasImage && pr.imageBlobs.length > 0) {
      for (var k = 0; k < pr.imageBlobs.length; k++) {
        var ib = pr.imageBlobs[k];
        var ext = mimeToExt[ib.type] || '.png';
        var result = await _saveImage(ib.blob, ext, e);
        if (result && result.path) {
          var token = _makeAnchorToken(result.sha256, result.fileName);
          _insertTokenAtCursor(token, { path: result.path, sha256: result.sha256, fileName: result.fileName }, targetEd);
        } else {
          // Image save failed — insert a placeholder token so user knows something happened
          var fn2 = genName(ext);
          var token2 = _makeAnchorToken('', fn2);
          _insertTokenAtCursor(token2, { path: null, sha256: '', fileName: fn2 }, targetEd);
          var errMsg = (result && result.error) ? result.error : '未知错误（_saveImage 返回 null）';
          console.error('[paste-router] 图片保存失败: ' + errMsg);
          if (window.qqqideQoast) {
            window.qqqideQoast.show('粘贴图片失败: ' + errMsg, { duration: 5000 });
          }
        }
      }
      return;
    }

    // ★ 第 6 步：文件粘贴（DOM API 只能拿到文件名，无完整路径）
    if (pr.hasFile && pr.fileList.length > 0) {
      var seen = {};
      for (var m = 0; m < pr.fileList.length; m++) {
        var df = pr.fileList[m];
        var fn = df.name || 'file';
        if (seen[fn]) continue;
        seen[fn] = true;
        var token3 = _makeAnchorToken('', fn);
        _insertTokenAtCursor(token3, { path: null, sha256: '', fileName: fn }, targetEd);
      }
      return;
    }

    // ★ 第 7 步：HTML 粘贴（text/html 存在，但无图无文件）
    if (pr.hasHtml && pr.hasText) {
      var plainText = '';
      try { plainText = e.clipboardData.getData('text/plain'); } catch (_) {}
      if (plainText) {
        targetEd.executeEdits('qqq-paste-router', [{
          range: targetEd.getSelection(),
          text: plainText,
          forceMoveMarkers: true,
        }]);
        targetEd.focus();
      }
      return;
    }

    // Fallback: plain text
    if (pr.hasText) {
      var pt = '';
      try { pt = e.clipboardData.getData('text/plain'); } catch (_) {}
      if (pt) {
        targetEd.executeEdits('qqq-paste-router', [{
          range: targetEd.getSelection(),
          text: pt,
          forceMoveMarkers: true,
        }]);
        targetEd.focus();
      }
    }
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
    _makeAnchorToken: _makeAnchorToken,
  };

})();
