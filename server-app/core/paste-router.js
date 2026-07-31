// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// paste-router.js — 编辑器粘贴路由（替代旧 paste.js 字符串转译）
//
// 管线:
//   用户 Ctrl+V
//   → Monaco paste handler (capture phase)
//   → klipzap.probe() — 零 spawn 探针
//   → 路由:
//       · 纯文本 → Monaco 原生粘贴（零额外延迟）
//       · 图片   → 写盘 → 📎 锚点 → ContentWidget
//       · 文件   → TransactionManager + Progress UI → 📎 锚点 → ContentWidget
//       · HTML   → 解析 → 媒体检测 → 路由
//       · 混合   → 按优先级: 文件 > 图片 > HTML > 文本
//
// 暴露: window.qqqPasteRouter
//
// 依赖: klipzap, wq-stats, transaction-manager, batch-ops, progress-service, anchor-map
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;
  var klipzap = window.qqqideKlipzap;
  var wqStats = window.qqqWqStats;
  var txnMgr = window.qqqTransactionManager;
  var batchOps = window.qqqBatchOps;
  var progressSvc = window.qqqProgressService;
  var anchorMap = window.qqqAnchorMap;

  var _editor = null;
  var _monaco = null;
  var _domNode = null;
  var _attached = false;

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

  // ═══ 获取粘贴目标目录 ═══

  function _getPasteDir() {
    var curFile = window.qqqEditor && window.qqqEditor.currentFile && window.qqqEditor.currentFile();
    if (!curFile) {
      // Fallback: project root
      var projRoot = window.qqqEditor && window.qqqEditor.projectRoot;
      if (projRoot) return projRoot;
      return null;
    }
    var sep = curFile.indexOf('\\') >= 0 ? '\\' : '/';
    return curFile.slice(0, curFile.lastIndexOf(sep));
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

  // ═══ 写盘 + hash dedup ═══

  async function _saveImage(blob, ext) {
    var dir = _getPasteDir();
    var ab = await blobToArrayBuffer(blob);
    var base64 = arrayBufferToBase64(ab);

    // Hash dedup via bridge
    var sha256 = '';
    var cacheHit = false;
    if (bridge && bridge.hash && bridge.hash.buffer) {
      try {
        var h = await bridge.hash.buffer(base64, 'both');
        sha256 = (h && (h.sha256 || h.xxh64)) || '';
        if (sha256 && bridge.cache && bridge.cache.bucketPath) {
          var cachePath = await bridge.cache.bucketPath('paste', sha256 + ext);
          var exists = await bridge.fs.exists(cachePath);
          if (exists) {
            // Cache HIT — reuse
            return { path: cachePath, sha256: sha256, fileName: cachePath.replace(/\\/g, '/').split('/').pop() };
          }
          // Write to cache bucket
          if (bridge.fs.writeBase64) {
            await bridge.fs.writeBase64(cachePath, base64);
          }
        }
      } catch (e) {
        console.warn('[paste-router] hash dedup failed:', e);
      }
    }

    // Write to target directory
    var fileName = genName(ext);
    var fullPath = null;
    if (dir) {
      var sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
      fullPath = dir + sep + fileName;
      try {
        if (bridge.fs.writeBase64) {
          await bridge.fs.writeBase64(fullPath, base64);
        } else {
          await bridge.fs.write(fullPath, base64);
        }
      } catch (e) {
        console.warn('[paste-router] write failed:', e);
        return null;
      }
    }

    return { path: fullPath, sha256: sha256, fileName: fileName };
  }

  // ═══ 插入锚点到编辑器 ═══

  function _insertTokenAtCursor(token) {
    if (!_editor) return;
    try {
      var sel = _editor.getSelection();
      var id = { major: 1, minor: 1 };
      _editor.executeEdits('qqq-paste-router', [{
        range: sel,
        text: token + '\n',
        forceMoveMarkers: true,
      }]);
      _editor.focus();
      // Trigger anchor-map rescan
      if (anchorMap && anchorMap._fullScan) {
        setTimeout(function () { anchorMap._fullScan(); }, 50);
      }
    } catch (e) {
      console.warn('[paste-router] insert token failed:', e);
    }
  }

  // ═══ 粘贴 handler ═══

  async function _onPaste(e) {
    // Measure wq
    var t0 = performance.now();

    var probeResult;
    try {
      probeResult = await klipzap.probe();
    } catch (err) {
      console.warn('[paste-router] probe failed:', err);
      return; // Let Monaco handle natively
    }

    var wqTime = performance.now() - t0;
    if (wqStats && wqStats.record) {
      wqStats.record(wqTime);
    }

    // No media content — let Monaco handle natively (instant text paste)
    if (!probeResult.hasImage && !probeResult.hasFile) {
      return;
    }

    // Prevent default — we take over
    e.preventDefault();
    e.stopPropagation();

    var cb = e.clipboardData;
    if (!cb) return;

    // ═══ 1. File paste (CF_HDROP) ═══
    if (probeResult.hasFile) {
      var files;
      try {
        files = await klipzap.readFiles();
      } catch (err) {
        console.warn('[paste-router] readFiles failed:', err);
        return;
      }
      if (files && files.length > 0) {
        _pasteFiles(files);
        return;
      }
    }

    // ═══ 2. Image paste (bitmap from clipboard) ═══
    if (probeResult.hasImage) {
      var items = cb.items;
      if (items) {
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
            var blob = it.getAsFile();
            if (!blob) continue;
            var ext = mimeToExt[blob.type] || '.png';
            var result = await _saveImage(blob, ext);
            if (result && result.path) {
              var token = _makeAnchorToken(result.sha256, result.fileName);
              _insertTokenAtCursor(token);
            }
            return;
          }
        }
      }

      // Fallback: clipboard image via bridge
      var imgDataUrl = null;
      try { imgDataUrl = await klipzap.readImage(); } catch (e2) { /* ignore */ }
      if (imgDataUrl) {
        // Convert data URL to blob, then save
        var parts = imgDataUrl.split(',');
        if (parts.length === 2) {
          var mime = (parts[0].match(/data:(.*?);/) || [])[1] || 'image/png';
          var ext2 = mimeToExt[mime] || '.png';
          var base64Data = parts[1];
          var binStr = atob(base64Data);
          var bytes2 = new Uint8Array(binStr.length);
          for (var j = 0; j < binStr.length; j++) {
            bytes2[j] = binStr.charCodeAt(j);
          }
          var blob2 = new Blob([bytes2], { type: mime });
          var result2 = await _saveImage(blob2, ext2);
          if (result2 && result2.path) {
            var token2 = _makeAnchorToken(result2.sha256, result2.fileName);
            _insertTokenAtCursor(token2);
          }
        }
        return;
      }
    }

    // ═══ 3. HTML paste (future: sniff <img> tags) ═══
    if (probeResult.hasHtml) {
      // For now, let text through — future: parse HTML for embedded images
      return; // Let Monaco handle as text
    }
  }

  // ═══ 文件粘贴 ═══

  async function _pasteFiles(filePaths) {
    if (!filePaths || filePaths.length === 0) return;

    var dir = _getPasteDir();
    if (!dir) {
      console.warn('[paste-router] no target directory for file paste');
      return;
    }

    // Create transaction
    var transId = 'paste-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var trans = {
      id: transId,
      targetDir: dir,
      taskType: 'local_file',
      tempFiles: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    if (txnMgr && txnMgr.saveTransaction) {
      txnMgr.saveTransaction(trans);
    }

    // Progress UI
    var progressCtrl = null;
    if (progressSvc && progressSvc.show) {
      progressCtrl = progressSvc.show('copy', {
        files: filePaths,
        destDir: dir,
        transaction: trans,
      });
    }

    var sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    var results = [];
    var aborted = false;

    try {
      // batchCopy from batch-ops
      if (batchOps && batchOps.batchCopy) {
        var cancelToken = {};
        cancelToken.aborted = false;
        cancelToken.abort = function () {
          cancelToken.aborted = true;
          aborted = true;
        };

        results = await batchOps.batchCopy(filePaths, dir, function (info) {
          if (progressCtrl && progressCtrl.update) {
            progressCtrl.update({
              current: info.current,
              total: info.total,
              currentFile: info.currentFile,
              bytesDone: info.bytesDone || 0,
              totalBytes: info.totalBytes || 0,
            });
          }
        }, cancelToken);
      } else {
        // Fallback: copy one by one
        for (var i = 0; i < filePaths.length; i++) {
          var src = filePaths[i];
          var fileName = src.replace(/\\/g, '/').split('/').pop();
          var dest = dir + sep + fileName;
          try {
            await bridge.fs.copyFile(src, dest);
            results.push({ success: true, dest: dest, fileName: fileName });
          } catch (e) {
            results.push({ success: false, src: src, error: e.message });
          }
        }
      }
    } catch (e) {
      console.warn('[paste-router] batch copy failed:', e);
    }

    // Update transaction
    var landedFiles = [];
    for (var j = 0; j < results.length; j++) {
      if (results[j] && results[j].success) {
        landedFiles.push(results[j].dest);
      }
    }
    if (txnMgr && txnMgr.updateTransaction) {
      txnMgr.updateTransaction(transId, {
        status: aborted ? 'cancelled' : 'success',
        landedFiles: landedFiles,
      });
    }

    // Insert anchor tokens for each pasted file
    if (!aborted) {
      var fileNameSet = {};
      for (var k = 0; k < landedFiles.length; k++) {
        var fp = landedFiles[k];
        var fn2 = fp.replace(/\\/g, '/').split('/').pop();
        if (fileNameSet[fn2]) continue;
        fileNameSet[fn2] = true;
        var token = _makeAnchorToken('', fn2);
        _insertTokenAtCursor(token);
      }
    }

    // Complete progress
    if (progressCtrl && progressCtrl.done) {
      progressCtrl.done(results);
    }
  }

  // ═══ 附加/分离 ═══

  function attach(editor, monaco) {
    if (_attached) return;
    if (!editor) return;

    _editor = editor;
    _monaco = monaco;
    _domNode = editor.getDomNode && editor.getDomNode();

    if (!_domNode) {
      setTimeout(function () { attach(editor, monaco); }, 200);
      return;
    }

    _domNode.addEventListener('paste', _onPaste, true);
    _attached = true;
  }

  function dispose() {
    if (_domNode) {
      _domNode.removeEventListener('paste', _onPaste, true);
    }
    _attached = false;
    _editor = null;
    _monaco = null;
    _domNode = null;
  }

  window.qqqPasteRouter = {
    attach: attach,
    dispose: dispose,
    _pasteFiles: _pasteFiles,
    _makeAnchorToken: _makeAnchorToken,
  };

})();
