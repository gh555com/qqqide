// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// __diag_cl.js — 临时诊断脚本（2026-09-14，用完即删）
//
// 目的：dev 实例「codelens 无按钮 + 文本胶片不出图」的运行时取证。
// 行为：Ctrl+R 后 3.5s / 9s 各写一份全状态 JSON 到 {项目}/tmp/cl-diag-{a,b}.json
//   （渲染层：模块加载/monaco API/codeLens 选项/锚点表/帧缓存/DOM；
//    壳层：stat/fileIcon/readHead/textPreview/dirSummary 探针 + 原始错误）
// 回收：诊断完成 → 本文件 + index.html 脚本引用 + SW 预缓存一并删除。
// ============================================================================
(function () {
  'use strict';

  var OUT = 'E:/s/wol/py/qqq-shell-v2/tmp/';
  var seen = [];
  try {
    window.addEventListener('error', function (e) {
      seen.push('err: ' + (e && e.message) + ' @ ' + (e && e.filename) + ':' + (e && e.lineno));
    });
  } catch (e) { /* */ }
  try {
    window.addEventListener('unhandledrejection', function (e) {
      seen.push('rej: ' + String((e && e.reason && (e.reason.message || e.reason)) || e));
    });
  } catch (e) { /* */ }
  try {
    var _ce = console.error;
    console.error = function () {
      try {
        seen.push('console.error: ' + Array.prototype.map.call(arguments, function (a) { return String(a).slice(0, 300); }).join(' | '));
      } catch (e) { /* */ }
      return _ce.apply(console, arguments);
    };
  } catch (e) { /* */ }

  function safe(fn, dflt) {
    try { return fn(); } catch (e) { return (dflt !== undefined ? dflt : ('THROW: ' + (e && e.message))); }
  }
  function rerr(e) { return 'ERR: ' + String((e && e.message) || e); }

  async function probeFile(b, p) {
    var rec = { file: p };
    try {
      var st = await b.fs.stat(p);
      rec.stat = st ? { size: st.size, mtimeMs: st.mtimeMs, isDir: !!(st.isDir || st.isDirectory) } : null;
    } catch (e) { rec.stat = rerr(e); }
    if (!rec.stat || rec.stat.isDir || !rec.stat.size) { return rec; }
    try { var ic = await b.fs.fileIcon(p); rec.icon = (ic && ic.ok) ? 'ok' : JSON.stringify(ic).slice(0, 200); } catch (e) { rec.icon = rerr(e); }
    try {
      var hd = await b.fs.readHead(p, 8192);
      rec.readHead = (hd && hd.ok) ? ('ok b64len=' + String(hd.base64 || '').length) : JSON.stringify(hd).slice(0, 160);
    } catch (e) { rec.readHead = rerr(e); }
    if (/\.(txt|bat|md|js|json|log|ini|cfg|cmd|ps1)$/i.test(p)) {
      try { rec.textPreview = await b.media.textPreview({ src: p, scheme: 'light', fontSize: 14 }); }
      catch (e) { rec.textPreview = { threw: rerr(e) }; }
    }
    return rec;
  }

  async function dump(tag) {
    var out = { ts: Date.now(), tag: tag };
    try {
      out.href = location.href;
      try { out.swCtrl = (navigator.serviceWorker && navigator.serviceWorker.controller) ? navigator.serviceWorker.controller.scriptURL : null; } catch (e) { /* */ }
      try { out.caches = await caches.keys(); } catch (e) { /* */ }
      out.scripts = safe(function () {
        return Array.prototype.map.call(document.scripts, function (s) { return s.getAttribute('src') || ''; })
          .filter(function (s) { return /codelens|prefs|viewport|frame-renderer|paste-router|editor\.js|__diag/.test(s); });
      }, []);
      out.resources = safe(function () {
        return performance.getEntriesByType('resource').map(function (r) { return r.name; })
          .filter(function (n) { return /qqq-codelens|viewport-machine|qqq-prefs|frame-renderer|__diag/.test(n); });
      }, []);
      out.globals = {
        codelens: safe(function () { return typeof window.qqqCodelens; }),
        prefs: safe(function () { return typeof window.qqqPrefs; }),
        vm: safe(function () { return typeof window.qqqViewportMachine; }),
        fr: safe(function () { return typeof window.qqqFrameRenderer; }),
        monaco: safe(function () { return typeof window.monaco; }),
        bridge: safe(function () { return typeof window.qqqideBridge; }),
        wsRoot: safe(function () { return window._workspaceRoot || null; }),
        clState: safe(function () { return window.qqqCodelens ? window.qqqCodelens._state() : null; }),
        clStyleClass: safe(function () { return document.documentElement.classList.contains('qqq-codelens-style'); })
      };
      out.prefs = safe(function () {
        var q = window.qqqPrefs;
        if (!q || !q.get) { return null; }
        return {
          codelensLevel: q.get('codelensLevel'),
          perf: q.get('performanceMode'),
          takeover: q.get('takeOverCodelensStyle')
        };
      });

      try { if (window.qqqCodelens && window.qqqCodelens.refreshNow) { window.qqqCodelens.refreshNow(); } } catch (e) { /* */ }

      var monaco = window.monaco;
      out.editorCount = 'n/a';
      out.editors = [];
      if (monaco && monaco.editor && monaco.editor.getEditors) {
        var eds = monaco.editor.getEditors();
        out.editorCount = eds.length;
        for (var i = 0; i < eds.length; i++) {
          (function (ed, idx) {
            var o = { idx: idx };
            o.clOpt = safe(function () {
              var v = ed.getOption(monaco.editor.EditorOption.codeLens);
              return (v && typeof v === 'object' && v !== null && ('value' in v)) ? v.value : v;
            });
            o.model = safe(function () {
              var m = ed.getModel();
              if (!m) { return null; }
              var val = m.getValue();
              return { uri: String(m.uri), len: val.length, pi: (val.match(/\uD83D\uDCCE/g) || []).length, head: val.slice(0, 220) };
            });
            o.anchors = safe(function () {
              var map = window.qqqViewportMachine.getAnchors(ed);
              var ks = Object.keys(map);
              return {
                n: ks.length,
                list: ks.slice(0, 25).map(function (k) {
                  var e2 = map[k];
                  return { k: k, name: e2.fileName, path: e2.path, line: e2.line, col: e2.col, rawLen: e2._rawLen, tried: !!e2._resolveTried, tail: e2._tail || null };
                })
              };
            });
            out.editors.push(o);
          })(eds[i], i);
        }
      }
      out.vm = safe(function () {
        var reg = window.qqqViewportMachine && window.qqqViewportMachine._registry;
        if (!reg) { return null; }
        var arr = [];
        reg.forEach(function (vp) {
          arr.push({
            state: vp.state,
            fp: vp.filePath,
            anchors: Object.keys(vp._anchorMap || {}).length,
            zones: Object.keys(vp._zoneMeta || {}).length,
            frames: Object.keys(vp._frameCache || {}).map(function (k) {
              var c = vp._frameCache[k];
              return { k: k, dom: !!(c && c.frameDom), path: c && c.path };
            }),
            building: Object.keys(vp._building || {})
          });
        });
        return arr;
      });
      out.dom = safe(function () {
        return {
          codelensEls: document.querySelectorAll('.codelens-decoration').length,
          viewZoneRows: document.querySelectorAll('.view-zones > div').length,
          qqqVzMedia: document.querySelectorAll('.qqq-vz-media').length,
          anchorHidden: document.querySelectorAll('.qqq-anchor-hidden').length,
          monacoEditors: document.querySelectorAll('.monaco-editor').length
        };
      });

      var b = window.qqqideBridge;
      out.probes = [];
      if (b && b.fs) {
        var files = ['F:\\gaea\\ak__.txt', 'F:\\gaea\\ksc.bat'];
        try {
          for (var ei = 0; ei < out.editors.length; ei++) {
            var lst = (out.editors[ei].anchors && out.editors[ei].anchors.list) || [];
            for (var li = 0; li < lst.length; li++) {
              if (lst[li].path && files.indexOf(lst[li].path) < 0) { files.push(lst[li].path); }
            }
          }
        } catch (e) { /* */ }
        files = files.slice(0, 6);
        for (var fi = 0; fi < files.length; fi++) {
          out.probes.push(await probeFile(b, files[fi]));
        }
        try {
          var ds = await b.fs.dirSummary('E:/s/wol/py/qqq-shell-v2/server-app');
          out.probes.push({ p: 'dirSummary', ok: ds && ds.ok, size: ds && ds.total_size, files: ds && ds.file_count_root, extKeys: ds && ds.ext_stats ? Object.keys(ds.ext_stats).length : 0 });
        } catch (e) { out.probes.push({ p: 'dirSummary', err: rerr(e) }); }
        if (tag === 'b') {
          try { out.ptBucket = await b.fs.list('E:/s/wol/py/qqq-shell-v2/Data/Cache/h/pt'); } catch (e) { out.ptBucket = rerr(e); }
        }
      }
      out.errorsSeen = seen.slice(0, 60);
      await b.fs.write(OUT + 'cl-diag-' + tag + '.json', JSON.stringify(out, null, 1));
    } catch (e) {
      try { await window.qqqideBridge.fs.write(OUT + 'cl-diag-' + tag + '-error.txt', String((e && e.stack) || e)); } catch (e2) { /* */ }
    }
  }

  window.__clDiagDump = dump;
  setTimeout(function () { dump('a'); }, 3500);
  setTimeout(function () { dump('b'); }, 9000);
})();
