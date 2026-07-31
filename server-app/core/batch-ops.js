// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// batch-ops.js — 批量文件操作引擎
//
// 职责:
//   · copyFileWithProgress — 单文件流式复制 + 进度回调 + 取消
//   · batchCopy — 批量复制（50个/批 + yieldToEventLoop）
//   · calcDirSize — 递归目录大小 + session 缓存
//
// 迁移自: q3 h.js:584-660 (copyFileWithProgress)
// 暴露: window.qqqBatchOps
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;

  // ═══ 单文件复制（流式 + 进度 + 取消） ═══
  // 参数:
  //   src        — 源路径
  //   dest       — 目标路径
  //   onProgress — ({ copied, total }) => void
  //   cancelToken— { cancelled: boolean, onCancel: (fn) => void }
  // 返回: Promise<boolean>
  function copyFileWithProgress(src, dest, onProgress, cancelToken) {
    return new Promise(function (resolve, reject) {
      // 取消检查
      if (cancelToken && cancelToken.cancelled) {
        return reject(new Error('cancelled'));
      }

      var cancelled = false;
      var cancelHandler = null;

      if (cancelToken && cancelToken.onCancel) {
        cancelHandler = function () {
          cancelled = true;
          // 尝试清理半成品
          if (bridge && bridge.fs && bridge.fs.remove) {
            bridge.fs.remove(dest).catch(function () { });
          }
          reject(new Error('cancelled'));
        };
        cancelToken.onCancel(cancelHandler);
      }

      // 走主进程 copyFile（流式 + 进度事件）
      if (bridge && bridge.fs && bridge.fs.copyFile) {
        bridge.fs.copyFile(src, dest, function (p) {
          if (cancelled) return;
          if (onProgress) {
            try { onProgress(p.copied, p.total); } catch (e) { /* ignore */ }
          }
        }).then(function (result) {
          if (cancelled) return;
          resolve(result !== false);
        }).catch(function (err) {
          if (cancelled) return;
          reject(err);
        });
        return;
      }

      // Fallback: 无 copyFile API（浏览器模式）→ reject
      reject(new Error('copyFile not available (not in shell)'));
    });
  }

  // ═══ 批量复制 ═══
  // 参数:
  //   files       — [{ src, dest }] 或 [srcPath, ...] + destDir
  //   destDir     — 目标目录（当 files 是路径数组时）
  //   onProgress  — ({ current, total, currentFile, bytesCopied, totalBytes }) => void
  //   cancelToken — { cancelled, onCancel }
  // 返回: Promise<{success:[], failed:[{file,error}]}>
  function batchCopy(files, destDir, onProgress, cancelToken) {
    return new Promise(async function (resolve, reject) {
      // Normalize input
      var ops = [];
      if (Array.isArray(files) && typeof files[0] === 'string' && destDir) {
        // files = [srcPath, ...], destDir = string
        var dir = destDir;
        files.forEach(function (src) {
          var name = src.replace(/\\/g, '/').split('/').pop();
          ops.push({ src: src, dest: dir + '/' + name });
        });
      } else if (Array.isArray(files) && typeof files[0] === 'object') {
        ops = files;
      }

      if (ops.length === 0) {
        return resolve({ success: [], failed: [] });
      }

      // Calculate total size for progress
      var totalBytes = 0;
      var fileSizes = [];
      for (var i = 0; i < ops.length; i++) {
        var sz = 0;
        try {
          if (bridge && bridge.fs && bridge.fs.stat) {
            var st = await bridge.fs.stat(ops[i].src);
            if (st && st.size) sz = st.size;
          }
        } catch (e) { /* ignore */ }
        fileSizes.push(sz);
        totalBytes += sz;
      }

      var success = [];
      var failed = [];
      var bytesCopied = 0;
      var BATCH_SIZE = 50;

      function reportProgress(current) {
        if (onProgress) {
          try {
            onProgress({
              current: current,
              total: ops.length,
              currentFile: ops[current - 1] ? (ops[current - 1].src.replace(/\\/g, '/').split('/').pop()) : '',
              bytesCopied: bytesCopied,
              totalBytes: totalBytes,
            });
          } catch (e) { /* ignore */ }
        }
      }

      // Process in batches of 50 with event loop yielding
      for (var batchStart = 0; batchStart < ops.length; batchStart += BATCH_SIZE) {
        var batchEnd = Math.min(batchStart + BATCH_SIZE, ops.length);
        var batch = ops.slice(batchStart, batchEnd);

        for (var j = 0; j < batch.length; j++) {
          var idx = batchStart + j;
          var op = batch[j];

          // Cancel check
          if (cancelToken && cancelToken.cancelled) {
            failed.push({ file: op.src, error: 'cancelled' });
            // Add remaining files as failed
            for (var k = j + 1; k < batch.length; k++) {
              failed.push({ file: batch[k].src, error: 'cancelled' });
            }
            for (var m = batchEnd; m < ops.length; m++) {
              failed.push({ file: ops[m].src, error: 'cancelled' });
            }
            return resolve({ success: success, failed: failed });
          }

          reportProgress(idx + 1);

          try {
            await copyFileWithProgress(
              op.src,
              op.dest,
              function (copied, total) {
                bytesCopied += (copied - (bytesCopied % (fileSizes[idx] || 1)));
                // byte-level tracking is approximate in batch mode
              },
              cancelToken
            );
            success.push(op.src);
            bytesCopied += fileSizes[idx] || 0;
          } catch (e) {
            failed.push({ file: op.src, error: (e && e.message) || String(e) });
          }
        }

        // Yield to event loop every batch (prevent UI freeze)
        if (batchEnd < ops.length) {
          await new Promise(function (r) { setTimeout(r, 0); });
        }
      }

      resolve({ success: success, failed: failed });
    });
  }

  // ═══ 目录大小计算（递归 + 缓存） ═══
  var _sizeCache = {}; // path → { size, ts }

  async function calcDirSize(dir) {
    if (!dir) return 0;
    var norm = dir.replace(/\\/g, '/').replace(/\/$/, '');
    var cached = _sizeCache[norm];
    if (cached && (Date.now() - cached.ts < 30000)) {
      return cached.size;
    }

    var totalSize = 0;
    try {
      if (bridge && bridge.fs && bridge.fs.list) {
        var entries = await bridge.fs.list(dir);
        if (Array.isArray(entries)) {
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var fullPath = norm + '/' + e.name;
            if (e.isDir) {
              totalSize += await calcDirSize(fullPath);
            } else {
              totalSize += (e.size || 0);
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors — return 0
    }

    _sizeCache[norm] = { size: totalSize, ts: Date.now() };
    return totalSize;
  }

  function clearSizeCache() {
    _sizeCache = {};
  }

  function clearSizeCacheFor(dir) {
    if (!dir) return;
    var norm = dir.replace(/\\/g, '/').replace(/\/$/, '');
    delete _sizeCache[norm];
  }

  window.qqqBatchOps = {
    copyFileWithProgress: copyFileWithProgress,
    batchCopy: batchCopy,
    calcDirSize: calcDirSize,
    clearSizeCache: clearSizeCache,
    clearSizeCacheFor: clearSizeCacheFor,
  };

})();
