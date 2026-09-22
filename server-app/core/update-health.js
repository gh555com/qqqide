// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// update-health.js — 设置面板「升级健康位」（2026-09-22 q292）
//
//   渲染位: #qqq-upd-health（settings.js 面板标题行，重置窗口右侧）
//   数据源双通道:
//     ① 壳层快照 bridge.update.health()（qqqide:update:health，shell/update-health.ts）
//        —— 版本 / 更新状态 / 失败数 / 暂存就绪 / 后台准备中 / dev 态
//     ② 构建戳比对（原 index.html 内联机迁入）：SW 缓存 __stamp.js vs 磁盘 _BUILD_STAMP.json
//        —— SW 缓存旧 → 红色⚠️（按「重置窗口」）；正常态并入悬停明细
//   胶囊优先级: 缓存旧⚠️ > 待更新↑ > 更新异常⚠️ > 准备中↓ > 最新✅ > 未检查 / dev
//   图标铁律: 状态图标必须用单色字形（↑/↓/✓…）以受主题色控制——禁彩色 emoji（⬆️/⏳ 等
//             恒显系统蓝/灰，style.color 对它零效果）。
//   点击胶囊 → 升级诊断查看器（bridge.update.diag/diagFile/diagReport）：
//     9 个核心失败/更新日志尾段只读展示 + 单件复制/定位 + 一键复制报告 +
//     生成报告文件（Data/diag/update-diag-*.txt 自动定位）+ 打开日志目录。
//     零网络零自动外发——是否发给管理员 100% 由用户决定。
//   旧壳层（无 update.health/diag）→ 退回纯构建戳显示；点击提示「需重启实例」。
//
//   性能: 壳层 JSON 读 mtime 缓存；本层 paint 差异跳过（无变化零 DOM 写）；
//         构建戳比对 30s 节拍（health 15s）；面板关闭定时器自清；查看器零轮询。
// ============================================================================
(function () {
  'use strict';

  var _stamp = null;   // {state:'ok'|'stale'|'none'|'fail', id, disk, browser}
  var _health = null;  // 壳层升级健康快照
  var _timer = null;   // 面板打开期间 15s 轮询（元素消失自清）
  var _tick = 0;       // 构建戳降频用（health 15s / stamp 30s）
  var _viewer = null;  // 诊断查看器 {ov, panel, body, idx, tails, sections}

  var ORANGE = 'var(--orange, #e8a030)';
  var RED = '#dc322f';

  function t(key, fb, params) {
    try { if (typeof window._i === 'function') { return window._i(key, fb, params); } } catch (_) { }
    var s = String(fb == null ? '' : fb);
    if (params) { for (var k in params) { s = s.split('{' + k + '}').join(String(params[k])); } }
    return s;
  }
  function _pad(n) { return (n < 10 ? '0' : '') + n; }
  function _fmtTs(ms) {
    try {
      var v = Number(ms) || 0;
      if (!v) { return ''; }
      var d = new Date(v);
      if (!isFinite(d.getTime())) { return ''; }
      return _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()) + ' ' + _pad(d.getHours()) + ':' + _pad(d.getMinutes());
    } catch (_) { return ''; }
  }
  function _fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) { return n + ' B'; }
    if (n < 1048576) { return (n / 1024).toFixed(1) + ' KB'; }
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function _bridge() {
    try { return window.qqqideBridge || null; } catch (_) { return null; }
  }
  function _hasDiag() {
    var b = _bridge();
    return !!(b && b.update && typeof b.update.diag === 'function');
  }
  function _qoast(msg) {
    try {
      if (window.qqqideQoast && typeof window.qqqideQoast.show === 'function') {
        window.qqqideQoast.show(msg, { duration: 6000 });
        return;
      }
    } catch (_) { }
    try { console.log('[upd-health]', msg); } catch (_) { }
  }

  function _stampLine() {
    if (!_stamp) { return ''; }
    if (_stamp.state === 'ok') { return t('settings.stamp.ok', '最新代码 ✅ buildId={id}', { id: _stamp.id || '' }); }
    if (_stamp.state === 'stale') { return t('settings.stamp.stale', 'SW缓存了旧代码！磁盘={disk} 浏览器={browser}', { disk: _stamp.disk || '', browser: _stamp.browser || '' }); }
    if (_stamp.state === 'none') { return t('settings.stamp.readFail', '构建戳读取失败'); }
    return t('settings.stamp.fetchFail', '❌ fetch失败');
  }

  function _staleText() {
    return '\u26a0\ufe0f ' + String(_stamp.disk || '').slice(0, 8) + '\u2260' + String(_stamp.browser || '').slice(0, 6);
  }

  function compose() {
    var r = { text: '', color: '', title: '', bold: false };
    var h = _health;

    // ── 无健康快照（旧壳层 / IPC 不可用）→ 纯构建戳（旧行为）──
    if (!h) {
      if (!_stamp) { r.text = '\u00b7\u00b7\u00b7'; return r; }
      if (_stamp.state === 'ok') {
        r.text = '\u2705 ' + String(_stamp.id || '').slice(0, 8);
        r.title = _stampLine();
      } else if (_stamp.state === 'stale') {
        r.text = _staleText(); r.color = RED; r.bold = true; r.title = _stampLine();
      } else if (_stamp.state === 'none') {
        r.text = '\u274c ' + t('settings.stamp.none', '无'); r.color = RED; r.title = _stampLine();
      } else {
        r.text = '\u274c fetch\u5931\u8d25'; r.color = RED; r.title = _stampLine();
      }
      return r;
    }

    // ── 健康快照可用 ──
    var lines = [];
    var ver = h.ver || '';

    if (h.dev) {
      r.text = t('settings.upd.dev', 'dev');
      lines.push(t('settings.upd.ttDev', '开发实例 — 更新由开发流程管理'));
    } else if (_stamp && _stamp.state === 'stale') {
      r.text = _staleText(); r.color = RED; r.bold = true;
      lines.push(_stampLine());
    } else if (h.stagedReady) {
      // 单色 ↑（受主题色控制；彩色 emoji ⬆️ 恒显系统蓝）
      r.text = '\u2191 ' + (h.staged || '');
      r.color = ORANGE;
      lines.push(t('settings.upd.ttStaged', '新版本 v{v} 已就绪 — 重启后自动完成更新', { v: h.staged || '?' }));
    } else if (h.status === 'failed' || h.fails > 0) {
      r.text = '\u26a0\ufe0f ' + t('settings.upd.failedShort', '更新异常');
      r.color = RED;
      var when = _fmtTs(h.statusTs);
      lines.push(t('settings.upd.ttFailed', '上次更新失败') + (when ? '\uff08' + when + '\uff09' : ''));
      if (h.statusLine) { lines.push(t('settings.upd.ttEvent', '最近事件：{line}', { line: h.statusLine })); }
    } else if (h.prep) {
      // 单色 ↓ = 后台下载/准备中
      r.text = '\u2193 ' + h.prep;
      r.color = ORANGE;
      lines.push(t('settings.upd.ttPrep', '正在后台准备更新 v{v}', { v: h.prep }));
    } else if (h.status === 'ok' || h.status === 'waiting') {
      r.text = '\u2705' + (ver ? ' v' + ver : '');
      r.color = 'var(--green, #859900)';
      lines.push(t('settings.upd.ttOk', '已是最新（检查于 {time}）', { time: _fmtTs(h.statusTs) || '\u2014' }));
    } else {
      r.text = ver ? ('v' + ver) : '\u2014';
      lines.push(t('settings.upd.ttNone', '更新器尚未完成首次检查'));
    }

    // ── 公共明细行（去重）──
    if (ver) { lines.push(t('settings.upd.ttVer', '当前版本 v{v}', { v: ver })); }
    if (h.launcher) { lines.push(t('settings.upd.ttLauncher', '启动器 {l}', { l: h.launcher })); }
    if (h.fails > 0) { lines.push(t('settings.upd.ttFails', '失败计数 {n}', { n: h.fails })); }
    var sl = _stampLine();
    if (sl) { lines.push(sl); }
    if (_hasDiag()) { lines.push(t('settings.upd.ttClick', '点击查看核心失败记录')); }

    var seen = {}, uniq = [];
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (!L || seen[L]) { continue; }
      seen[L] = 1; uniq.push(L);
    }
    r.title = uniq.join('\n');
    return r;
  }

  function paint() {
    var r = compose();
    var els = [];
    try { els = document.querySelectorAll('#qqq-upd-health'); } catch (_) { }
    var color = r.color || '', weight = r.bold ? 'bold' : '', title = r.title || '';
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      try {
        // 差异跳过（15s 轮询绝大多数拍无变化 → 零 DOM 写）
        if (el.textContent !== r.text) { el.textContent = r.text; }
        if (el.style.color !== color) { el.style.color = color; }
        if (el.style.fontWeight !== weight) { el.style.fontWeight = weight; }
        if (el.title !== title) { el.title = title; }
      } catch (_) { }
    }
  }

  // ── 构建戳双通道比对（原 index.html 内联机迁入）──
  function refreshStamp() {
    try {
      var diskId = window.__QQQ_BUILD_ID || '????';
      fetch('/qqqide/qqq/_BUILD_STAMP.json?_=' + Date.now(), { cache: 'no-cache' })
        .then(function (resp) { return resp && resp.ok ? resp.json() : null; })
        .then(function (data) {
          if (!data || !data.buildId) { _stamp = { state: 'none' }; }
          else if (data.buildId === window.__QQQ_BUILD_ID) { _stamp = { state: 'ok', id: data.buildId }; }
          else { _stamp = { state: 'stale', disk: data.buildId, browser: diskId }; }
          paint();
        })
        ['catch'](function () { _stamp = { state: 'fail' }; paint(); });
    } catch (_) { _stamp = { state: 'fail' }; paint(); }
  }

  // ── 壳层快照 ──
  function refreshHealth() {
    var b = _bridge();
    if (!b || !b.update || !b.update.health) { _health = null; paint(); return; }
    try {
      Promise.resolve(b.update.health()).then(function (h) {
        _health = (h && typeof h === 'object' && h.ok !== false) ? h : null;
        paint();
      })['catch'](function () { _health = null; paint(); });
    } catch (_) { _health = null; paint(); }
  }

  function ensureTimer() {
    if (_timer) { return; }
    _timer = setInterval(function () {
      var present = false;
      try { present = !!document.querySelector('#qqq-upd-health'); } catch (_) { }
      if (!present) { try { clearInterval(_timer); } catch (_) { } _timer = null; return; }
      refreshHealth();
      _tick++;
      if (_tick % 2 === 0) { refreshStamp(); }   // 构建戳 30s 节拍（本地 fetch，降频省开销）
    }, 15000);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 诊断查看器（点击胶囊打开）
  // ══════════════════════════════════════════════════════════════════════
  function _theme() {
    var dark = false;
    try { dark = document.documentElement.getAttribute('data-theme') === 'dark'; } catch (_) { }
    return dark
      ? { bg: '#1e1e1e', text: '#dcd8d0', dim: '#8a8680', border: '#3a3a3a', code: '#141414', codeText: '#cfcabc' }
      : { bg: '#fdf6e3', text: '#4d4a44', dim: '#8a8680', border: '#d3c6aa', code: '#f7f0dd', codeText: '#5a564e' };
  }

  function _miniBtn(label, th, on, accent) {
    var b = document.createElement('button');
    b.style.cssText = 'padding:2px 9px;border:1px solid ' + (accent ? ORANGE : th.border) + ';border-radius:3px;background:transparent;color:' + (accent ? ORANGE : th.text) + ';font-size:11px;';
    b.textContent = label;
    if (on) { b.addEventListener('click', on); }
    return b;
  }

  function _copyText(text) {
    var b = _bridge();
    try {
      if (b && b.clipboard && typeof b.clipboard.writeText === 'function') {
        return Promise.resolve(b.clipboard.writeText(text));
      }
    } catch (_) { }
    return new Promise(function (resolve) {
      try {
        var ta = document.createElement('textarea');
        ta.value = String(text == null ? '' : text);
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (_) { }
      resolve();
    });
  }

  function _closeViewer() {
    if (!_viewer) { return; }
    try { if (_viewer.ov && _viewer.ov.parentNode) { _viewer.ov.parentNode.removeChild(_viewer.ov); } } catch (_) { }
    try { document.removeEventListener('keydown', _viewer.onKey, true); } catch (_) { }
    _viewer = null;
  }

  function _fileText(v, f) {
    if (!f.exists) { return t('settings.upd.diagMissing', '文件不存在'); }   // 缺失 → 终态（不会有人来填）
    var tail = v.tails[f.id];
    if (tail == null) { return t('settings.upd.diagLoad', '读取中…'); }
    return tail || t('settings.upd.diagEmptyLine', '（空）');
  }

  function _renderDiagIndex(v, idx, th) {
    var files = (idx && idx.files) || [];
    v.idx = idx;
    v.tails = {};
    v.sections = {};
    var body = v.body;
    body.textContent = '';

    for (var i = 0; i < files.length; i++) {
      (function (f) {
        var sec = document.createElement('div');
        sec.style.cssText = 'padding:9px 0;border-bottom:1px dashed ' + th.border + ';';

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        var nm = document.createElement('span');
        nm.style.cssText = 'font-weight:bold;font-size:12px;color:' + th.text + ';';
        nm.textContent = t('settings.upd.diagF.' + f.id, f.name);
        var meta = document.createElement('span');
        meta.style.cssText = 'font-size:11px;color:' + th.dim + ';font-family:Consolas,monospace;';
        meta.textContent = f.exists ? (_fmtBytes(f.size) + (f.mtimeMs ? ' · ' + _fmtTs(f.mtimeMs) : '')) : '\u2014';
        var cb = _miniBtn(t('settings.upd.diagCopy', '复制'), th, function () {
          var txt = '===== ' + f.name + ' =====\n' + f.path + '\n' + _fileText(v, f);
          Promise.resolve(_copyText(txt)).then(function () {
            _qoast(t('settings.upd.diagCopied', '已复制到剪贴板'));
          });
        });
        var rb = _miniBtn(t('settings.upd.diagReveal', '定位'), th, function () {
          var b = _bridge();
          try { if (b && b.shell && b.shell.showItemInFolder) { b.shell.showItemInFolder(f.path); } } catch (_) { }
        });
        row.appendChild(nm); row.appendChild(meta); row.appendChild(cb); row.appendChild(rb);
        sec.appendChild(row);

        var pth = document.createElement('div');
        pth.style.cssText = 'font-size:10.5px;color:' + th.dim + ';font-family:Consolas,monospace;word-break:break-all;margin-top:2px;';
        pth.textContent = f.path;
        sec.appendChild(pth);

        var pre = document.createElement('pre');
        pre.style.cssText = 'display:none;margin:6px 0 0;padding:8px;max-height:200px;overflow:auto;background:' + th.code + ';color:' + th.codeText + ';border:1px solid ' + th.border + ';border-radius:3px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;';
        pre.textContent = _fileText(v, f);
        sec.appendChild(pre);
        if (f.exists) { pre.style.display = ''; }

        v.sections[f.id] = { pre: pre, f: f };
        body.appendChild(sec);

        if (f.exists) {
          var b2 = _bridge();
          try {
            Promise.resolve(b2.update.diagFile(f.id)).then(function (r) {
              if (_viewer !== v || !r || !r.ok) { return; }
              v.tails[f.id] = r.tail || '';
              var s = v.sections[f.id];
              if (s) { s.pre.textContent = _fileText(v, f); }
            })['catch'](function () { });
          } catch (_) { }
        }
      })(files[i]);
    }
    if (!files.length) { body.textContent = t('settings.upd.diagEmpty', '暂无日志文件（尚未产生记录）'); }
  }

  function _composeReportText(v) {
    var head = [];
    head.push('qqqide diag report — 升级诊断报告');
    head.push('生成时间: ' + _fmtTs(Date.now()));
    if (_health) {
      head.push('当前版本: ' + (_health.ver || '-') + ' | 启动器: ' + (_health.launcher || '-') + ' | 更新状态: ' + (_health.status || '-') + ' | 失败计数: ' + (_health.fails || 0) + ( _health.stagedReady ? (' | 暂存: ' + _health.staged) : ''));
    }
    var idx = v.idx || {};
    if (idx.packRoot) { head.push('托管根: ' + idx.packRoot); }
    if (idx.dataDir) { head.push('数据目录: ' + idx.dataDir); }
    var files = idx.files || [];
    var parts = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      parts.push('');
      parts.push('===== ' + f.name + (f.exists ? (' (' + _fmtBytes(f.size) + (f.mtimeMs ? ' @ ' + _fmtTs(f.mtimeMs) : '') + ')') : ' (missing)') + ' =====');
      parts.push(f.path);
      parts.push((v.tails[f.id] || '').slice(0, 6000) || '(no data)');
    }
    var txt = head.join('\n') + '\n' + parts.join('\n');
    if (txt.length > 16000) { txt = txt.slice(0, 16000) + '\n…(truncated)'; }
    return txt;
  }

  function _openViewer() {
    var b = _bridge();
    if (!b || !b.update || typeof b.update.diag !== 'function') {
      _qoast(t('settings.upd.diagNeedRestart', '需重启 qqqide 实例后可用'));
      return;
    }
    if (_viewer) { _closeViewer(); }
    var th = _theme();

    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:100050;display:flex;align-items:center;justify-content:center;';
    var panel = document.createElement('div');
    panel.style.cssText = 'width:780px;max-width:92vw;max-height:84vh;overflow-y:auto;background:' + th.bg + ';color:' + th.text + ';border:1px solid ' + th.border + ';border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.35);font-size:13px;';
    ov.appendChild(panel);

    var v = { ov: ov, panel: panel, idx: null, tails: {}, sections: {}, onKey: null };

    // 头部
    var head = document.createElement('div');
    head.style.cssText = 'position:sticky;top:0;background:' + th.bg + ';padding:12px 16px 10px;border-bottom:1px solid ' + th.border + ';z-index:2;';
    var ttl = document.createElement('div');
    ttl.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
    var t1 = document.createElement('span');
    t1.style.cssText = 'font-size:14px;font-weight:bold;';
    t1.textContent = t('settings.upd.diagTitle', '升级诊断记录');
    var x = document.createElement('button');
    x.style.cssText = 'width:24px;height:24px;flex:0 0 auto;border:1px solid ' + th.border + ';border-radius:3px;background:transparent;color:' + th.dim + ';font-size:13px;line-height:20px;';
    x.textContent = '\u2715';
    x.addEventListener('click', _closeViewer);
    ttl.appendChild(t1); ttl.appendChild(x);
    var hint = document.createElement('div');
    hint.style.cssText = 'margin-top:6px;font-size:11px;line-height:1.7;color:' + th.dim + ';';
    hint.textContent = t('settings.upd.diagHint', '以下为核心失败 / 更新日志的末尾片段。点「复制报告」或「生成报告文件」发给管理员即可协助排查。');
    head.appendChild(ttl); head.appendChild(hint);
    panel.appendChild(head);

    // 主体
    var body = document.createElement('div');
    body.style.cssText = 'padding:8px 16px 4px;';
    body.textContent = t('settings.upd.diagLoad', '读取中…');
    panel.appendChild(body);
    v.body = body;

    // 底部
    var foot = document.createElement('div');
    foot.style.cssText = 'position:sticky;bottom:0;background:' + th.bg + ';padding:10px 16px 12px;border-top:1px solid ' + th.border + ';display:flex;gap:8px;flex-wrap:wrap;z-index:2;';
    foot.appendChild(_miniBtn(t('settings.upd.diagCopyAll', '复制报告'), th, function () {
      Promise.resolve(_copyText(_composeReportText(v))).then(function () {
        _qoast(t('settings.upd.diagCopied', '已复制到剪贴板'));
      });
    }, true));
    foot.appendChild(_miniBtn(t('settings.upd.diagSave', '生成报告文件'), th, function () {
      var bb = _bridge();
      if (!bb || !bb.update || typeof bb.update.diagReport !== 'function') { return; }
      Promise.resolve(bb.update.diagReport()).then(function (r) {
        if (r && r.ok && r.path) {
          try { if (bb.shell && bb.shell.showItemInFolder) { bb.shell.showItemInFolder(r.path); } } catch (_) { }
          _qoast(t('settings.upd.diagSaved', '报告已生成并定位：{p}', { p: r.path }));
        } else {
          _qoast(t('settings.upd.diagFail', '操作失败'));
        }
      })['catch'](function () { _qoast(t('settings.upd.diagFail', '操作失败')); });
    }));
    foot.appendChild(_miniBtn(t('settings.upd.diagOpenDir', '打开日志目录'), th, function () {
      var bb = _bridge();
      var dir = (v.idx && v.idx.dataDir) || '';
      if (!dir) { return; }
      try { if (bb && bb.shell && bb.shell.openPath) { bb.shell.openPath(dir); } } catch (_) { }
    }));
    foot.appendChild(_miniBtn(t('settings.upd.diagClose', '关闭'), th, _closeViewer));
    panel.appendChild(foot);

    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) { _closeViewer(); } });
    v.onKey = function (e) { if (e && e.key === 'Escape') { _closeViewer(); } };
    document.addEventListener('keydown', v.onKey, true);

    _viewer = v;

    try {
      Promise.resolve(b.update.diag()).then(function (idx) {
        if (_viewer !== v) { return; }
        _renderDiagIndex(v, idx || {}, th);
      })['catch'](function () {
        if (_viewer !== v) { return; }
        try { body.textContent = t('settings.upd.diagEmpty', '暂无日志文件（尚未产生记录）'); } catch (_) { }
      });
    } catch (_) {
      try { body.textContent = t('settings.upd.diagEmpty', '暂无日志文件（尚未产生记录）'); } catch (_) { }
    }
  }

  // 胶囊点击（document 级委托——settings 面板重渲染不丢）
  try {
    document.addEventListener('click', function (e) {
      var n = e.target;
      while (n && n.nodeType === 1) {
        if (n.id === 'qqq-upd-health') { _openViewer(); return; }
        n = n.parentNode;
      }
    }, false);
  } catch (_) { }

  // 唯一刷新入口（settings.js 面板每次渲染时调用）
  window.__qqqUpdHealthRefresh = function () {
    paint();          // 缓存先同步渲染（面板重开零闪烁）
    refreshStamp();
    refreshHealth();
    ensureTimer();
  };

  // 语言切换 → 悬停明细即时换语言；查看器开着 → 关闭重开（文案换新，本地读取零成本）
  try {
    window.addEventListener('qqq-lang-change', function () {
      paint();
      if (_viewer) { _closeViewer(); _openViewer(); }
    });
  } catch (_) { }
})();
