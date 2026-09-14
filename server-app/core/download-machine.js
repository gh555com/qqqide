// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// download-machine.js — 唯一真理下载机器（2026-09-14）
//
// 定位：一切「用户可见文件下载」的唯一入口（inbox 附件 / 图片 / 未来任何 goods）。
//   window.qqqideDownload.save(url, filename, opts) → Promise
//   opts.ask = true → 强制另存为（弹保存对话框；调用方 Shift+点击 传 true）
//
// ★ 目录记忆（2026-09-14 第二轮）：上次保存目录存程序级 global.sq3
//   （ns=qqq.download，key=lastDir，cloud:false 设备本地，不云同步）。
//   非 ask 且记忆目录存在 → 静默直存（零对话框；重名由主进程自动 name (1).ext 绝不覆盖），
//   完成 qoast 报最终文件名 + 「📂 Roam 定位」（shell-overlay 定位引擎，点击直达 Roam 选中文件）；
//   静默失败（目录失效等）→ 自动回退保存对话框。首次下载无记忆 → 弹框，选过一次后不再每次问。
// ★ opts.onDone({ok, path, name} | {ok:false, error|cancelled|external})：完成回调（2026-09-14）——
//   inbox 四小链接 open/Roam 靠它拿到最终落盘路径再动作；blob 兜底回 {ok:true, blob:true}（无路径）。
//
// 双通道（自动选优，调用方零感知）：
//   ① 原生通道（首选）：bridge.download → shell/download-service.ts（主进程流式落盘）
//      —— 保存对话框/静默直存 / 断点续传 / 进度 ioast 卡片 / 取消 / 完成后 qoast。
//      任意尺寸零内存压力；旧壳层未注册 IPC handler 时 invoke 拒绝 → 自动降级 ②。
//   ② 兜底通道：主窗口 fetch（CDN CORS: ACAO:*）→ Blob → a[download] 另存。
//      超大文件（>600MB）或 fetch 失败 → 外部浏览器原生下载（流式，最后兜底）。
//
// 进度：bridge.download.onProgress 全局广播（全窗口），本机按 entry.id / 待发起 url 过滤。
// ============================================================================

(function () {
  'use strict';
  if (window.qqqideDownload) return;

  var _listening = false;
  var _tasks = {};      // entry.id → { taskId, name, lastTs, lastBytes, bps }
  var _pending = {};    // url → true（start 已发起、id 未回：期间到达的进度先存孤儿区）
  var _orphans = {};    // url → 最新 entry（首事件先于 start resolve 的竞态兜底）

  function _b() { try { return window.qqqideBridge || null; } catch (_) { return null; } }
  function _io() { try { return window.qqqideIoast || null; } catch (_) { return null; } }
  function _qoast(m, o) { try { if (window.qqqideQoast) { window.qqqideQoast.show(m, o || {}); } } catch (_) {} }

  function _fmt(n) {
    n = Number(n) || 0;
    var u = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < 3) { n = n / 1024; i++; }
    return (i ? n.toFixed(1) : Math.round(n)) + u[i];
  }

  function _progressText(done, total, bps) {
    var s = _fmt(done) + (total ? ' / ' + _fmt(total) : '');
    if (bps > 0) { s += ' · ' + _fmt(bps) + '/s'; }
    if (total > 0) { s += ' · ' + Math.floor(done * 100 / total) + '%'; }
    return s;
  }

  function _external(url) {
    try {
      var b = _b();
      if (b && b.shell && b.shell.openExternal) { b.shell.openExternal(url); return true; }
      if (b && b.openExternal) { b.openExternal(url); return true; }
    } catch (_) {}
    try { window.open(url, '_blank'); return true; } catch (_) { return false; }
  }

  // ── 「打开位置」唯一出口 = Roam 定位（shell-overlay 定位引擎；不可用回退资源管理器）──
  function _revealLocal(p) {
    if (!p) return;
    try { if (typeof window.__qqq_roamRevealPath === 'function') { window.__qqq_roamRevealPath(p); return; } } catch (_) {}
    try { var b = _b(); if (b && b.shell && b.shell.showItemInFolder) { b.shell.showItemInFolder(p); } } catch (_) {}
  }

  // ── 上次保存目录记忆（程序级 global.sq3，设备本地） ──
  var _PREF_NS = 'qqq.download';
  function _prefs() {
    try { return (window.qgs && window.qgs.simple) ? window.qgs.simple(_PREF_NS, { cloud: false }) : null; } catch (_) { return null; }
  }
  function _getLastDir() {
    var p = _prefs(); if (!p) return '';
    try { var d = p.get('lastDir'); return (typeof d === 'string') ? d : ''; } catch (_) { return ''; }
  }
  function _setLastDir(d) {
    if (!d) return;
    var p = _prefs(); if (!p) return;
    try { p.set('lastDir', d); } catch (_) {}
  }
  function _dirOf(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : '';
  }
  function _baseOf(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // ── 原生通道进度订阅（全局一次） ──
  function _bindProgress() {
    var b = _b();
    if (_listening || !b || !b.download || !b.download.onProgress) return;
    _listening = true;
    b.download.onProgress(function (entry) {
      if (!entry || !entry.id) return;
      if (!_tasks[entry.id]) {
        if (_pending[entry.url]) { _orphans[entry.url] = entry; }   // start 未回：竞态兜底
        return;
      }
      _onEntry(entry);
    });
  }

  function _onEntry(entry) {
    var t = _tasks[entry.id];
    if (!t) return;
    var io = _io();
    if (entry.done) {
      var fin = t.onDone; t.onDone = null;
      if (entry.error) {
        if (entry.error === 'cancelled') {
          if (io) io.remove(t.taskId);
        } else {
          var emsg = String(entry.error).slice(0, 80);
          if (io) io.fail(t.taskId, { summary: '下载失败：' + emsg });
          _qoast('下载失败：' + t.name + '（' + emsg + '）', { type: 'error', duration: 12000 });
        }
        if (fin) { try { fin({ ok: false, error: entry.error, cancelled: entry.error === 'cancelled' }); } catch (_) {} }
      } else {
        // 终稿文件名取实际落盘名（静默直存重名时 = name (1).ext，与用户看到的磁盘一致）
        var finalName = t.name;
        if (entry.filePath) { var bn = _baseOf(entry.filePath); if (bn) { finalName = bn; } }
        if (io) io.done(t.taskId, { summary: '已保存：' + (entry.filePath || t.name) });
        _qoast('已保存：' + finalName, {
          type: 'success', duration: 12000,
          action: {
            label: '📂 Roam 定位',
            onClick: function () { _revealLocal(entry.filePath); },
          },
        });
        if (fin) { try { fin({ ok: true, path: entry.filePath || '', name: finalName }); } catch (_) {} }
      }
      delete _tasks[entry.id];
      return;
    }
    // progressing
    var now = Date.now();
    if (!t.lastTs) { t.lastTs = now; t.lastBytes = entry.bytesDone || 0; }
    if (now - t.lastTs >= 500) {
      t.bps = (entry.bytesDone - t.lastBytes) / ((now - t.lastTs) / 1000);
      t.lastTs = now;
      t.lastBytes = entry.bytesDone || 0;
    }
    var total = entry.totalBytes || 0;
    var done = entry.bytesDone || 0;
    if (io) {
      io.task(t.taskId, {
        title: '⬇ ' + t.name,
        subtitle: _progressText(done, total, t.bps),
        progress: total > 0 ? Math.min(1, done / total) : 0,
        cancelable: true,
        onCancel: function () { try { _b().download.cancel(entry.id); } catch (_) {} },
      });
    }
  }

  // ── 兜底通道：主窗口 fetch → Blob → 另存 ──
  function _blobSave(url, filename, opts) {
    opts = opts || {};
    var io = _io();
    var name = filename || '文件';
    var fin = (typeof opts.onDone === 'function') ? opts.onDone : null;
    function fireFin(r) { if (fin) { try { fin(r); } catch (_) {} } }
    var taskId = 'qdl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    var MAX_BLOB = 600 * 1024 * 1024;
    if (opts.size && opts.size > MAX_BLOB) { _external(url); fireFin({ ok: false, external: true }); return Promise.resolve({ ok: false, external: true }); }
    if (io) io.task(taskId, { title: '⬇ ' + name, subtitle: '下载中…', progress: 0 });
    var lastTs = Date.now(), lastBytes = 0, bps = 0;
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      var total = parseInt(r.headers.get('content-length') || '0', 10) || 0;
      if (total > MAX_BLOB) {
        try { if (r.body && r.body.cancel) { r.body.cancel(); } } catch (_) {}
        if (io) io.remove(taskId);
        _external(url);
        fireFin({ ok: false, external: true });
        return { ok: false, external: true };
      }
      var reader = (r.body && r.body.getReader) ? r.body.getReader() : null;
      if (!reader) { return r.blob().then(function (bl) { return _finish(bl); }); }
      var chunks = [], done = 0;
      function pump() {
        return reader.read().then(function (rr) {
          if (rr.done) {
            return _finish(new Blob(chunks, { type: r.headers.get('content-type') || 'application/octet-stream' }));
          }
          chunks.push(rr.value);
          done += rr.value.length;
          var now = Date.now();
          if (now - lastTs >= 400) {
            bps = (done - lastBytes) / ((now - lastTs) / 1000);
            lastTs = now;
            lastBytes = done;
            if (io) io.task(taskId, { title: '⬇ ' + name, subtitle: _progressText(done, total, bps), progress: total > 0 ? Math.min(1, done / total) : 0 });
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      var emsg = String((err && err.message) || err).slice(0, 80);
      if (io) io.fail(taskId, { summary: '下载失败：' + emsg });
      _qoast('下载失败：' + name + '（' + emsg + '）', { type: 'error', duration: 12000 });
      fireFin({ ok: false, error: emsg });
      return { ok: false, error: emsg };
    });

    function _finish(bl) {
      var objUrl = URL.createObjectURL(bl);
      var a = document.createElement('a');
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { URL.revokeObjectURL(objUrl); } catch (_) {}
        try { a.remove(); } catch (_) {}
      }, 5000);
      if (io) io.done(taskId, { summary: '已保存：' + name + '（' + _fmt(bl.size) + '）' });
      _qoast('已保存：' + name, { type: 'success', duration: 12000 });
      fireFin({ ok: true, blob: true, name: name });
      return { ok: true, blob: true };
    }
  }

  // ── 原生通道单次发起（静默直存 / 保存对话框 两路复用） ──
  function _startNative(url, filename, payload, waitingText, onDone) {
    var b = _b();
    var io = _io();
    var taskId = 'qdl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    var name = filename || '文件';
    var t = { taskId: taskId, name: name, lastTs: 0, lastBytes: 0, bps: 0, onDone: (typeof onDone === 'function') ? onDone : null };
    if (io) io.task(taskId, { title: '⬇ ' + name, subtitle: waitingText || '准备中…', progress: 0 });
    _pending[url] = true;
    return b.download.start(payload).then(function (r) {
      delete _pending[url];
      if (r && r.ok && r.id) {
        _tasks[r.id] = t;
        // 记住最终目录（静默/对话框两路主进程都回传 dir；旧壳层回退从 filePath 推导）
        var d = (r.dir && typeof r.dir === 'string') ? r.dir : _dirOf(r.filePath);
        if (d) { _setLastDir(d); }
        if (_orphans[url]) { var ev0 = _orphans[url]; delete _orphans[url]; _onEntry(ev0); }
        return r;
      }
      if (io) io.remove(taskId);
      if (r && r.canceled) { return r; }
      return r || { ok: false };
    }).catch(function (err) {
      delete _pending[url];
      var msg = String((err && err.message) || err);
      if (/No handler registered/i.test(msg)) {
        // 旧壳层：preload 有桥但主进程 IPC 未注册 → blob 兜底（无需重启即可用）
        if (io) io.remove(taskId);
        return _blobSave(url, filename, { onDone: onDone });
      }
      if (io) io.remove(taskId);
      _qoast('无法开始下载：' + msg.slice(0, 60), { type: 'error', duration: 10000 });
      return { ok: false, error: msg };
    });
  }

  function _afterStart(r) {
    if (r && (r.ok || r.canceled)) { return r; }
    _qoast('无法开始下载' + (r && r.error ? '：' + r.error : ''), { type: 'error', duration: 10000 });
    return r || { ok: false };
  }

  // ── 唯一入口 ──
  function save(url, filename, opts) {
    url = String(url || '');
    if (!/^https?:\/\//i.test(url)) { return Promise.resolve({ ok: false, error: 'invalid_url' }); }
    var b = _b();
    if (!(b && b.download && b.download.start)) { return _blobSave(url, filename, opts); }
    _bindProgress();
    opts = opts || {};
    var onDone = (typeof opts.onDone === 'function') ? opts.onDone : null;
    var lastDir = _getLastDir();
    if (lastDir && !opts.ask) {
      // 记忆命中：静默直存（零对话框；重名自动唯一化不覆盖）——失败回退保存对话框
      return _startNative(url, filename, { url: url, fileName: filename || '', dir: lastDir, saveAs: false }, '保存中…', onDone)
        .then(function (r) {
          if (r && r.ok) { return r; }
          if (r && r.canceled) { return r; }
          return _startNative(url, filename, { url: url, fileName: filename || '', dir: lastDir, saveAs: true }, '等待选择保存位置…', onDone)
            .then(_afterStart);
        });
    }
    return _startNative(url, filename, { url: url, fileName: filename || '', dir: lastDir, saveAs: true }, '等待选择保存位置…', onDone)
      .then(_afterStart);
  }

  window.qqqideDownload = { save: save, getLastDir: _getLastDir, setLastDir: _setLastDir };
})();
