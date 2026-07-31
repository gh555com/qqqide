// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// transaction-manager.js — 文件事务系统（照搬 q3 TransactionManager）
//
// 职责:
//   · 追踪文件复制/移动操作的事务生命周期
//   · 提供快照+回滚能力
//   · 自动清理临时文件 (.part/.ytdl/.tmp)
//   · LRU 截断 (200条上限, 60天过期)
//
// 持久化: qgs.simple('roam-transactions')
// 暴露: window.qqqTransactionManager
//
// 迁移自: q3 global.js:5296-5600
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;
  var NS = 'roam-transactions';
  var SIXTY_DAYS = 5184000000; // 60 days in ms
  var SIX_MINUTES = 360000;    // 6 min in ms

  // ═══ 内部工具 ═══

  function _getStore() {
    if (window.qgs && window.qgs.simple) {
      return window.qgs.simple(NS);
    }
    return null;
  }

  function _getAll() {
    var store = _getStore();
    if (!store) return [];
    try {
      return store.get('list') || [];
    } catch (e) {
      return [];
    }
  }

  function _saveAll(list) {
    var store = _getStore();
    if (!store) return;
    try {
      store.set('list', list);
    } catch (e) {
      console.warn('[txn] save failed:', e);
    }
  }

  // Normalize path for comparison
  function _norm(p) {
    if (!p) return '';
    return p.replace(/\\/g, '/').replace(/\/$/, '');
  }

  // ═══ 公共 API ═══

  function getTransactions() {
    return _getAll();
  }

  function saveTransaction(trans) {
    var list = _getAll();
    var now = Date.now();

    var cleanTrans = {
      id: trans.id,
      targetDir: trans.targetDir || '',
      targetUri: typeof trans.targetUri === 'string' ? trans.targetUri : '',
      docUri: typeof trans.docUri === 'string' ? trans.docUri : '',
      tempFiles: Array.isArray(trans.tempFiles) ? trans.tempFiles : [],
      status: 'pending',
      createdAt: trans.createdAt || now,
      lastActiveAt: trans.lastActiveAt || now,
      taskType: trans.taskType || 'unknown',
      extra: trans.extra || {},
      landedFiles: Array.isArray(trans.landedFiles) ? trans.landedFiles : [],
    };

    list.push(cleanTrans);

    // LRU truncation: 200 max, priority delete closed+expired
    if (list.length > 200) {
      var getWeight = function (t) {
        var w = 0;
        if (t.status === 'success' || t.status === 'cancelled') w += 2;
        if (now - (t.createdAt || 0) > SIXTY_DAYS) w += 1;
        return w;
      };
      var sorted = list.slice().sort(function (a, b) {
        var wa = getWeight(a), wb = getWeight(b);
        if (wa !== wb) return wb - wa;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      var toDeleteIds = new Set();
      for (var i = 0; i < 100; i++) {
        if (sorted[i]) toDeleteIds.add(sorted[i].id);
      }
      list = list.filter(function (t) { return !toDeleteIds.has(t.id); });
    }

    _saveAll(list);
  }

  function updateTransaction(id, updates) {
    var list = _getAll();
    list = list.map(function (t) { return t.id === id ? Object.assign({}, t, updates) : t; });
    _saveAll(list);
  }

  // Throttled lastActiveAt update (5s)
  var _lastActiveThrottle = {};
  function touchLastActive(transId) {
    if (!transId) return;
    var now = Date.now();
    var lastTouch = _lastActiveThrottle[transId] || 0;
    if (now - lastTouch < 5000) return;
    _lastActiveThrottle[transId] = now;

    var list = _getAll();
    var found = false;
    list = list.map(function (t) {
      if (t.id === transId) { found = true; return Object.assign({}, t, { lastActiveAt: now }); }
      return t;
    });
    if (found) _saveAll(list);
  }

  function removeTransaction(id) {
    var list = _getAll();
    list = list.filter(function (t) { return t.id !== id; });
    _saveAll(list);
  }

  // ═══ 文件清理 ═══

  // Get referenced items from documents (files referenced by 📎 anchors)
  function _getReferencedItems(dir) {
    // For now, return empty — no document scanning in initial version
    // Future: scan editor content for 📎 anchors referencing files in this dir
    return new Set();
  }

  // Clean temp files in targetDir
     async function _cleanupTempFiles(targetDir, trans, options) {
        if (!targetDir) return;

        var exists = false;
        try { exists = await bridge.fs.exists(targetDir); } catch (e) { /* ignore */ }

        if (!exists) return;

        var transId = (trans && trans.id) || null;
        var landedFilesSet = new Set();
        if (options && options.landedFilesSet) landedFilesSet = options.landedFilesSet;

        var files = [];
        try {
            var listResult = await bridge.fs.list(targetDir);
            files = Array.isArray(listResult) ? listResult : [];
        } catch (e) {
            return;
        }

        if (files.length === 0) return;

        var tempExts = ['.part', '.ytdl', '.tmp', '.download'];
        var referencedItems = _getReferencedItems(targetDir);
        var deletedCount = 0;
        var sep = targetDir.indexOf('\\') >= 0 ? '\\' : '/';

        for (var i = 0; i < files.length; i++) {
            var entry = files[i];
            // bridge.fs.list returns objects: {name, isDir, mtimeMs, ctimeMs, size}
            var fileName = typeof entry === 'string' ? entry.replace(/\\/g, '/').split('/').pop() : (entry && entry.name ? entry.name : '');
            if (!fileName) continue;
            var fullPath = targetDir + sep + fileName;
            var ext = (fileName.indexOf('.') >= 0 ? '.' + fileName.split('.').pop() : '').toLowerCase();

            // Skip referenced files
            if (referencedItems.has(fileName.toLowerCase())) continue;
            // Skip landed files
            if (landedFilesSet.has(_norm(fullPath))) continue;

            var shouldDelete = false;

            // transId anchor match (first 4 chars) — no time limit
            if (transId && transId.length >= 4 && fileName.indexOf(transId.slice(0, 4)) === 0) {
                shouldDelete = true;
            } else if (tempExts.indexOf(ext) >= 0 || /\.f\d+\.(mp4|m4a|webm|mkv|mp3|opus|aac)(\.part)?$/i.test(fileName)) {
                // Fuzzy temp file — need age check
                try {
                    var st = await bridge.fs.stat(fullPath);
                    if (st && st.mtimeMs) {
                        var age = Date.now() - st.mtimeMs;
                        shouldDelete = age >= 0 && age < SIX_MINUTES;
                    }
                } catch (e) { /* skip */ }
            }

            if (!shouldDelete) continue;

            // Retry up to 5 times — use fs.remove (preload API name)
            for (var retry = 0; retry < 5; retry++) {
                try {
                    await bridge.fs.remove(fullPath);
                    deletedCount++;
                    break;
                } catch (e) {
                    if (retry < 4) {
                        await new Promise(function (r) { setTimeout(r, 100 + retry * 100); });
                    }
                }
            }
        }
    }

  // Clean orphan files (files not referenced by any transaction)
  async function _cleanupOrphanFiles(targetDir) {
    // Simplified — in the full version this scans the directory
    // for files that were created during a now-deleted transaction
    if (!targetDir) return;
    try {
      await _cleanupTempFiles(targetDir, null, {});
    } catch (e) { /* ignore */ }
  }

  // ═══ 回滚 ═══

  async function rollback(transOrId, options) {
    var transId = typeof transOrId === 'string' ? transOrId : (transOrId && transOrId.id);
    if (!transId) {
      console.warn('[txn] rollback: invalid id');
      return;
    }

    var trans = _getAll().find(function (t) { return t.id === transId; });
    if (!trans) {
      console.warn('[txn] rollback: transaction not found:', transId);
      return;
    }

    // If landedFiles is non-empty, the copy already succeeded — skip file deletion
    if (Array.isArray(trans.landedFiles) && trans.landedFiles.length > 0) {
      removeTransaction(trans.id);
      return trans;
    }

    console.warn('[txn] rolling back:', trans.id);

    // Build landed files set for protection
    var landedFilesSet = new Set();
    if (Array.isArray(trans.landedFiles)) {
      trans.landedFiles.forEach(function (f) { if (f) landedFilesSet.add(_norm(f)); });
    }

    removeTransaction(trans.id);

    // Background cleanup (non-blocking)
    var targetDir = trans.targetDir;
    if (targetDir) {
      var isRecover = (options && options.isRecover === true);

      // Phase 1: temp file cleanup (100ms delay)
      setTimeout(function () {
        _cleanupTempFiles(targetDir, trans, { isRecover: isRecover, landedFilesSet: landedFilesSet }).catch(function (e) {
          console.warn('[txn] temp cleanup failed:', e);
        });
      }, 100);

      // Phase 2: taskType-specific cleanup
      var taskType = trans.taskType || '';
      var delay = 11000; // default 11s
      if (taskType === 'video') {
        // video: skip (handled by VideoDownloadController after killAll)
        delay = 0;
      } else if (taskType === 'html') {
        delay = 1000; // 1s
      }

      if (delay > 0) {
        setTimeout(function () {
          _cleanupOrphanFiles(targetDir).catch(function (e) {
            console.warn('[txn] orphan cleanup failed:', e);
          });
        }, delay);
      }
    }

    return trans;
  }

  window.qqqTransactionManager = {
    getTransactions: getTransactions,
    saveTransaction: saveTransaction,
    updateTransaction: updateTransaction,
    touchLastActive: touchLastActive,
    removeTransaction: removeTransaction,
    rollback: rollback,
    _cleanupTempFiles: _cleanupTempFiles,
    _cleanupOrphanFiles: _cleanupOrphanFiles,
  };

})();
