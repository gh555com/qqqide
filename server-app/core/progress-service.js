// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// progress-service.js — 共享进度提示框
//
// 职责:
//   · qoast 风格底部进度弹出（不阻塞操作）
//   · 双消费者: Roam 粘贴 + 编辑器粘贴 + 音频下载
//   · 取消 → TransactionManager.rollback()
//
// API:
//   progressService.show('copy', { files, destDir, transaction }) → { cancel, update, done }
//   progressService.show('download', { url, dest, transaction })
//
// 暴露: window.qqqProgressService
// ============================================================================

(function () {
  'use strict';

  var _activeTasks = {}; // id → { cancel, update, done, el }

  // ═══ DOM 构建 ═══
  function _createProgressEl(id, type, opts) {
    var el = document.createElement('div');
    el.className = 'qqq-progress-bar';
    el.setAttribute('data-task-id', id);
    el.innerHTML =
      '<div class="qqq-progress-file" data-i18n="">' + (opts.label || '') + '</div>' +
      '<div class="qqq-progress-track"><div class="qqq-progress-fill" style="width:0%"></div></div>' +
      '<div class="qqq-progress-info">' +
        '<span class="qqq-progress-status">0%</span>' +
        '<button class="qqq-progress-cancel" data-i18n="cancel">取消</button>' +
      '</div>';
    return el;
  }

  function _getContainer() {
    var c = document.getElementById('qqq-progress-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'qqq-progress-container';
      c.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99990;pointer-events:none;padding:0 8px 8px;';
      document.body.appendChild(c);
    }
    return c;
  }

  // ═══ CSS 注入（一次性） ═══
  var _cssInjected = false;
  function _injectCss() {
    if (_cssInjected) return;
    _cssInjected = true;
    var style = document.createElement('style');
    style.textContent =
      '.qqq-progress-bar{' +
        'background:var(--bg-primary,#fdf6e3);border:1px solid var(--border-color,#93a1a1);' +
        'border-radius:8px;padding:8px 12px;margin-top:4px;pointer-events:auto;' +
        'box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:480px;' +
      '}' +
      '.qqq-progress-file{font-size:13px;color:var(--text-primary,#586e75);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.qqq-progress-track{height:6px;background:var(--bg-secondary,#eee8d5);border-radius:3px;overflow:hidden;margin-bottom:4px;}' +
      '.qqq-progress-fill{height:100%;background:var(--accent,#268bd2);border-radius:3px;transition:width .15s ease;}' +
      '.qqq-progress-info{display:flex;justify-content:space-between;align-items:center;}' +
      '.qqq-progress-status{font-size:11px;color:var(--text-secondary,#839496);}' +
      '.qqq-progress-cancel{font-size:11px;border:none;background:none;color:var(--text-secondary,#839496);cursor:pointer;padding:2px 6px;border-radius:3px;}' +
      '.qqq-progress-cancel:hover{color:var(--text-primary,#dc322f);background:var(--bg-secondary,#eee8d5);}' +
      '.qqq-progress-bar.done .qqq-progress-fill{background:var(--green,#859900);}' +
      '.qqq-progress-bar.error .qqq-progress-fill{background:var(--red,#dc322f);}';
    document.head.appendChild(style);
  }

  // ═══ 公共 API ═══

  // type: 'copy' | 'download'
  // opts: { files, destDir, transaction, label, onCancel }
  // 返回: { cancel(), update({percent, label, status}), done() }
  function show(type, opts) {
    _injectCss();
    opts = opts || {};

    var id = type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    var container = _getContainer();

    var files = Array.isArray(opts.files) ? opts.files : [];
    var label = opts.label || (files.length > 1 ? '正在复制 ' + files.length + ' 个文件…' : (files[0] || '').replace(/\\/g, '/').split('/').pop());

    var el = _createProgressEl(id, type, { label: label });
    container.appendChild(el);

    var fillEl = el.querySelector('.qqq-progress-fill');
    var statusEl = el.querySelector('.qqq-progress-status');
    var fileEl = el.querySelector('.qqq-progress-file');
    var cancelBtn = el.querySelector('.qqq-progress-cancel');

    var resolved = false;

    function resolveOnce() {
      if (resolved) return;
      resolved = true;
      // Auto-remove after 3s
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 3000);
    }

    var task = {
      update: function (info) {
        if (resolved) return;
        info = info || {};
        if (info.percent != null) {
          fillEl.style.width = Math.min(100, Math.max(0, info.percent)) + '%';
          statusEl.textContent = Math.round(info.percent) + '%';
        }
        if (info.label) fileEl.textContent = info.label;
        if (info.status) statusEl.textContent = info.status;
      },
      done: function () {
        if (resolved) return;
        el.classList.add('done');
        fillEl.style.width = '100%';
        statusEl.textContent = '完成';
        cancelBtn.style.display = 'none';
        resolveOnce();
      },
      cancel: function () {
        if (resolved) return;
        el.classList.add('error');
        statusEl.textContent = '已取消';
        cancelBtn.style.display = 'none';
        resolveOnce();
        // Rollback
        if (opts.transaction && window.qqqTransactionManager) {
          window.qqqTransactionManager.rollback(opts.transaction).catch(function () { });
        }
        if (opts.onCancel) opts.onCancel();
      },
      error: function (msg) {
        if (resolved) return;
        el.classList.add('error');
        statusEl.textContent = msg || '失败';
        cancelBtn.style.display = 'none';
        resolveOnce();
      },
      el: el,
      id: id,
    };

    cancelBtn.addEventListener('click', function () {
      task.cancel();
    });

    // Click on the bar to pin (stop auto-dismiss)
    el.addEventListener('click', function (e) {
      if (e.target === cancelBtn) return;
      resolved = true; // Pin — don't auto-remove
    });

    _activeTasks[id] = task;
    return task;
  }

  window.qqqProgressService = {
    show: show,
    _activeTasks: _activeTasks,
  };

})();
