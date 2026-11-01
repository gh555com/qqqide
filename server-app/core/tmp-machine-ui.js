// tmp-machine-ui.js — 壳层 tmp-machine 通知接收器（qoast/ioast 唯一出口）
// 事件 qqqide:tmp:swept（自动轮转汇总；无删零声 + 24h 节流 + 碎清静默由壳层把关）→ qoast（带「打开隔离区」钮直达 .trash）
// 手动 window.qqqTmpSweep()：ioast 任务坞 → 结果摘要（供菜单/面板/控制台调用）
(function () {
  'use strict';
  var b = window.qqqideBridge;
  if (!b || !b.tmpMachine) return;

  function _T(k, fb, p) {
    var v = null;
    try { if (window.i18n && window.i18n.t) { var r = window.i18n.t(k, p); if (r && r !== k) v = r; } } catch (e) { }
    if (v === null) { v = fb; if (p) { for (var x in p) { v = v.split('{' + x + '}').join(String(p[x])); } } }
    return v;
  }
  function fmtMb(mb) {
    mb = Math.round(mb || 0);
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb + ' MB';
  }
  function compose(d, dirs) {
    var n = (d.deleted || 0) + (d.quarantined || 0);
    var msg = _T('shell.tmp.swept', '临时区轮转：清理 {n} 项，释放 {mb}', { n: n, mb: fmtMb(d.freedMb) });
    if (d.quarantined > 0) {
      msg += '\n' + _T('shell.tmp.trash', '（{n} 项在隔离区，7 天内可捞回）', { n: d.quarantined });
      if (dirs && dirs.length === 1) { msg += '\n' + _T('shell.tmp.trashAt', '位置：{p}', { p: dirs[0] }); }
    }
    if (d.failed > 0) { msg += '\n' + _T('shell.tmp.occupied', '{n} 项被占用，稍后重试', { n: d.failed }); }
    if (d.overAfter) { msg += '\n' + _T('shell.tmp.pinned', '清理后仍超线；钉子占用 {mb}', { mb: fmtMb(d.pinMb) }); }
    return msg;
  }

  function trashDirsOf(d) {
    var out = [];
    var raw = d && d.trashDirs;
    if (raw && raw.length) { for (var i = 0; i < raw.length; i++) { if (raw[i]) { out.push(String(raw[i])); } } }
    return out;
  }
  // 打开隔离区（OS 文件管理器；多项目 tmp 时依次打开，均来自壳层回调的绝对路径）
  function openTrash(dirs) {
    if (!b.shell || !b.shell.openPath) { return; }
    for (var i = 0; i < dirs.length; i++) { try { b.shell.openPath(dirs[i]); } catch (e) { /* ignore */ } }
  }

  // 自动/后台轮转结果（无删且未超线时壳层零声；碎清静默；每 24h 至多 1 条）
  try {
    b.tmpMachine.onSwept(function (d) {
      if (!d || typeof d !== 'object') { return; }
      var type = (d.overAfter || d.failed > 0) ? 'warning' : 'info';
      var dirs = trashDirsOf(d);
      var opts = { type: type };
      if (dirs.length) {
        opts.duration = 15000;
        opts.action = { label: _T('shell.tmp.openTrash', '打开隔离区'), onClick: function () { openTrash(dirs); } };
      }
      if (window.qqqideQoast && window.qqqideQoast.show) { window.qqqideQoast.show(compose(d, dirs), opts); }
    });
  } catch (e) { /* ignore */ }

  // 手动：立即轮转（ioast 任务坞 → 结果摘要）
  window.qqqTmpSweep = function () {
    var io = window.qqqideIoast;
    var id = 'tmp-sweep';
    try { if (io && io.task) { io.task(id, { title: _T('shell.tmp.running', '临时区轮转中…') }); } } catch (e) { /* ignore */ }
    var settle = function (text, kind) {
      try {
        if (io && io[kind]) { io[kind](id, { summary: text.replace(/\n/g, '；') }); }
      } catch (e) { /* ignore */ }
    };
    return b.tmpMachine.sweep().then(function (r) {
      if (!r || r.ok === false) {
        settle(r && r.busy ? _T('shell.tmp.busy', '轮转正在运行，请稍候') : _T('shell.tmp.fail', '轮转失败，请稍后重试'), 'fail');
        return r;
      }
      var n = (r.deleted || 0) + (r.quarantined || 0);
      settle(n > 0 ? compose(r, trashDirsOf(r)) : _T('shell.tmp.clean', '临时区干净，无需清理'), 'done');
      return r;
    }).catch(function (e) {
      settle(_T('shell.tmp.fail', '轮转失败，请稍后重试'), 'fail');
      return null;
    });
  };
})();
