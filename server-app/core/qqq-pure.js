// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-pure.js — 工作台 Pure 机器（老 q3 pureCommand 移植 + 新架构闭环升级）
//
// 语义: 扫描目标文档旁的 _qqqvault/，找出「未被本目录任何文档引用」的孤儿项
//   （文件 + 文件夹），生成审阅清单 _qqqvault.pure 并在编辑器中打开。
//   ★ 只生成清单，绝不自动删除任何文件——删除由用户在 Roam 中手动执行（默认进系统回收站，可恢复）。
//
// 与老 q3 的差异（移植 + 必要升级；每处都因新架构引用形态 / 闭环缺口而改）:
//   · 引用形态: 老锚点 /\qqq/name\/（已死）→ 新 📎{sha}:{name} / _qqqvault/name / 绝对路径 / file:/// 等
//     统一收敛为「名字令牌」宽松匹配（见 _refHit）——名字按独立令牌出现即视为引用。
//   · 实时缓冲: 打开中的文件优先读 Monaco 模型（未保存的最新编辑——刚插入的 📎 锚点也算引用，
//     否则「刚粘的图在保存前被标成孤儿」是旧逻辑的真实数据丢失缺口）。
//   · 集合写入: 老版写 qqq.pure 且内含 del/rmdir 永久删除命令；新版只写清单 + Roam/回收站指引（无命令）。
//
// 匹配方向铁律（宁多勿杀）: 命中 ⇒ 引用 ⇒ 不进清单 ⇒ 不引导删除（多留=零风险）；
//   未命中 ⇒ 可能误标孤儿 ⇒ 用户复核 + 回收站兜底（错删才是事故，故匹配恒取宽松端）。
//   · 边界保护仅对 ASCII [A-Za-z0-9_]（防 mylogo.png 误判为 logo.png 的引用）；
//     CJK / 句号 / 连字符 / 引号等一律视为分隔符（"见logo.png。"、"logo.png." 都算引用）。
//   · URL 编码变体（encodeURIComponent）同查（markdown 链接里 %20 形态也算引用）。
//
// 边界（诚实口径）:
//   · 扫描范围 = 目标文档所在目录（1 层文本文件，单文件 ≤2MB，二进制扩展名跳过）；子目录不在扫描面。
//   · 读取失败 / 超限 / 超数量的文件 → 计入 skipped 并在清单头部如实标注「未完整扫描（结果可能偏多）」。
//
// 暴露: window.qqqPure（run）；Node 守卫导出纯函数供单测（_refHit/_findOrphans/_fmtBytes）。
// 加载点: server-app/index.html（core/paste-router.js 相邻）。
// ============================================================================

(function () {
  'use strict';

  var MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件扫描上限（2MB）
  var MAX_FILES = 500;                    // 同级文档扫描数量上限（超出如实标注未完整扫描）
  var MAX_ITEMS = 2000;                   // _qqqvault 项上限（列出/匹配上限）
  var HISTORY_OUT_NAME = '_qqqvault.pure';
  var VAULT_NAME = '_qqqvault';

  // 二进制扩展名跳过表（文本才可能含引用；跳过 = 无引用语义，不计入 skipped）
  var _BIN_EXT = {
    png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, ico: 1, tif: 1, tiff: 1, psd: 1, avif: 1,
    mp4: 1, webm: 1, mov: 1, m4v: 1, mkv: 1, avi: 1, wmv: 1, flv: 1, ogv: 1, rm: 1, rmvb: 1,
    mp3: 1, wav: 1, flac: 1, m4a: 1, aac: 1, ogg: 1, opus: 1, wma: 1, aiff: 1, ape: 1,
    zip: 1, '7z': 1, rar: 1, gz: 1, xz: 1, bz2: 1, tar: 1, zst: 1,
    exe: 1, dll: 1, so: 1, dylib: 1, bin: 1, node: 1, wasm: 1,
    woff: 1, woff2: 1, ttf: 1, otf: 1, eot: 1, pdf: 1, sq3: 1, db: 1, sqlite: 1
  };

  function _t(key, fb, params) {
    var v = fb;
    try { if (window._i) v = window._i(key, fb); } catch (_) { }
    if (params) {
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) {
          v = v.split('{' + k + '}').join(String(params[k]));
        }
      }
    }
    return v;
  }
  function _qoast(m, o) { try { if (window.qqqideQoast) { window.qqqideQoast.show(m, o || {}); } } catch (_) { } }

  function _isWordCode(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  }

  // 名字令牌命中（宽松匹配；方向说明见头注释「匹配方向铁律」）
  function _refHit(lower, needle) {
    if (!lower || !needle) return false;
    var from = 0;
    while (true) {
      var at = lower.indexOf(needle, from);
      if (at < 0) return false;
      if ((at === 0 || !_isWordCode(lower.charCodeAt(at - 1))) &&
        (at + needle.length >= lower.length || !_isWordCode(lower.charCodeAt(at + needle.length)))) {
        return true;
      }
      from = at + 1;
    }
  }

  // URL 编码变体（encodeURIComponent；与原名相同则返回空串）
  function _encName(name) {
    try {
      var e = encodeURIComponent(name);
      return e !== name ? e.toLowerCase() : '';
    } catch (_) { return ''; }
  }

  // 孤儿判定（纯函数——单测入口）
  //   items: [{name, isDir, size}]；contentsLower: [已小写文本]
  function _findOrphans(items, contentsLower) {
    var out = [];
    var blobs = contentsLower || [];
    for (var i = 0; i < items.length && i < MAX_ITEMS; i++) {
      var it = items[i];
      var nl = String(it.name || '').toLowerCase();
      if (!nl) continue;
      var enc = _encName(it.name);
      var hit = false;
      for (var j = 0; j < blobs.length; j++) {
        var lc = blobs[j];
        if (!lc) continue;
        if (_refHit(lc, nl) || (enc && _refHit(lc, enc))) { hit = true; break; }
      }
      if (!hit) out.push(it);
    }
    return out;
  }

  function _fmtBytes(size) {
    if (size == null || isNaN(size)) return '?';
    var units = ['B', 'KB', 'MB', 'GB'];
    var idx = 0, val = Number(size);
    while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++; }
    return val.toFixed(idx > 0 ? 1 : 0) + ' ' + units[idx];
  }

  function _fmtTime(d) {
    function p2(n) { return String(n).padStart(2, '0'); }
    var n = d || new Date();
    return n.getFullYear() + '-' + p2(n.getMonth() + 1) + '-' + p2(n.getDate()) + ' ' + p2(n.getHours()) + ':' + p2(n.getMinutes());
  }

  function _normKey(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

  function _binExt(name) {
    var dot = String(name).lastIndexOf('.');
    if (dot < 0) return false;
    return !!_BIN_EXT[String(name).slice(dot + 1).toLowerCase()];
  }

  // 打开中的 Monaco 模型对照表（normKey(path) → 文本；未保存的最新编辑即真源）
  function _liveModels() {
    var map = {};
    try {
      var monaco = window.monaco;
      var models = (monaco && monaco.editor && monaco.editor.getModels) ? (monaco.editor.getModels() || []) : [];
      for (var i = 0; i < models.length; i++) {
        var mo = models[i];
        var mp = '';
        try { mp = (mo.uri && (mo.uri.fsPath || mo.uri.path)) || ''; } catch (_) { mp = ''; }
        if (!mp) continue;
        // Monaco Uri.parse('E:/x') 会吞盘符（paste-router 同款兜底）
        if (mp.charAt(0) === '/' && window._workspaceRoot) {
          var ws = String(window._workspaceRoot);
          var colon = ws.indexOf(':');
          if (colon > 0) mp = ws.slice(0, colon + 1) + mp.replace(/^\/+/, '');
        }
        var val = '';
        try { val = mo.getValue(); } catch (_) { continue; }
        map[_normKey(mp)] = val;
      }
    } catch (_) { }
    return map;
  }

  var _busy = false;

  // 主入口（工作台 Pure 按钮消费）
  //   返回: {ok:true, count, scanned, items, skipped, outPath} | {ok:false, reason, ...}
  //   reason: 'no_bridge' | 'no_dir' | 'no_vault' | 'write_fail' | 'busy'
  async function run(filePath) {
    if (_busy) return { ok: false, reason: 'busy' };
    _busy = true;
    try {
      return await _runInner(filePath);
    } finally {
      _busy = false;
    }
  }

  async function _runInner(filePath) {
    var b = null;
    try { b = window.qqqideBridge; } catch (_) { b = null; }
    if (!b || !b.fs || !b.fs.list || !b.fs.read || !b.fs.write) return { ok: false, reason: 'no_bridge' };

    var fpRaw = String(filePath || '');
    var hasBS = fpRaw.indexOf('\\') >= 0;
    var wsep = hasBS ? '\\' : '/';
    var dir = fpRaw.slice(0, fpRaw.lastIndexOf(wsep));
    if (!dir) return { ok: false, reason: 'no_dir' };
    var vaultDir = dir + wsep + VAULT_NAME;
    var outPath = dir + wsep + HISTORY_OUT_NAME;

    // ① 列 _qqqvault
    var vent = null;
    try { vent = await b.fs.list(vaultDir); } catch (_) { vent = null; }
    if (!Array.isArray(vent) || !vent.length) return { ok: false, reason: 'no_vault', dir: dir };
    var items = [];
    for (var i = 0; i < vent.length && i < MAX_ITEMS; i++) {
      var e0 = vent[i];
      if (!e0 || !e0.name) continue;
      items.push({ name: String(e0.name), isDir: !!e0.isDir, size: Number(e0.size) || 0 });
    }
    if (!items.length) return { ok: false, reason: 'no_vault', dir: dir };

    // ② 同级文档（1 层文本文件；打开中的优先读实时模型）
    var dent = null;
    try { dent = await b.fs.list(dir); } catch (_) { dent = null; }
    var list = Array.isArray(dent) ? dent : [];
    var liveMap = _liveModels();
    var vaultKey = _normKey(vaultDir);
    var outKey = _normKey(outPath);
    var contents = [];
    var scanned = 0, skipped = 0;
    for (var fi = 0; fi < list.length; fi++) {
      var f = list[fi];
      if (!f || f.isDir || !f.name) continue;
      var fpath = dir + wsep + String(f.name);
      var fkey = _normKey(fpath);
      if (fkey === vaultKey || fkey === outKey) continue;      // vault 本体 / 清单自身（防自引用）
      if (_binExt(String(f.name))) continue;                    // 二进制跳过（无引用语义，不计 skipped）
      var live = Object.prototype.hasOwnProperty.call(liveMap, fkey) ? liveMap[fkey] : null;
      if (live != null) {
        contents.push(String(live).toLowerCase());
        scanned++;
        continue;
      }
      if (scanned + skipped >= MAX_FILES) { skipped++; continue; }
      if ((Number(f.size) || 0) > MAX_FILE_BYTES) { skipped++; continue; }
      try {
        var txt = await b.fs.read(fpath);
        if (typeof txt === 'string') { contents.push(txt.toLowerCase()); scanned++; }
        else { skipped++; }
      } catch (_) { skipped++; }
    }

    // ③ 孤儿判定
    var orphans = _findOrphans(items, contents);
    if (!orphans.length) {
      return { ok: true, count: 0, scanned: scanned, items: items.length, skipped: skipped, outPath: '' };
    }

    // ④ 生成审阅清单（只写清单，不删除任何文件）
    var lines = [];
    lines.push(_t('pure.fileTitle', '_qqqvault 孤儿清单（未删除任何文件）'));
    lines.push('');
    lines.push(_t('pure.fileScan', '扫描 {files} 个同级文档 · {items} 个 _qqqvault 项 → {orphans} 个孤儿项',
      { files: scanned, items: items.length, orphans: orphans.length }));
    lines.push('');
    lines.push(_t('pure.fileNote', '这些项未被本目录任何文档引用（含编辑器里未保存的最新内容）。\n确认不需要后，可在 Roam 中选中删除——默认移入系统回收站，可恢复。\n本工具只生成清单，不会自动删除任何文件。'));
    lines.push('');
    for (var oi = 0; oi < orphans.length; oi++) {
      var o = orphans[oi];
      var tag = o.isDir
        ? ('[' + _t('pure.fileDirLabel', '目录') + '] ')
        : ('[' + _fmtBytes(o.size) + '] ');
      lines.push(tag + VAULT_NAME + '/' + o.name);
    }
    lines.push('');
    if (skipped > 0) {
      lines.push(_t('pure.fileSkipped', '⚠ 未完整扫描：{n} 个文件被跳过（结果可能偏多，请仔细核对）', { n: skipped }));
    }
    lines.push(_t('pure.fileGenerated', '生成时间：{t}', { t: _fmtTime() }));
    var content = lines.join('\n') + '\n';

    try {
      await b.fs.write(outPath, content);
    } catch (e2) {
      return { ok: false, reason: 'write_fail', error: String((e2 && (e2.message || e2)) || '') };
    }

    // ⑤ 打开清单（老行为：顺手打开；失败不致命——文件已生成）
    try { if (window.qqqTabs && window.qqqTabs.openFile) window.qqqTabs.openFile(outPath); } catch (_) { }

    var names = [];
    for (var ni = 0; ni < orphans.length; ni++) names.push(orphans[ni].name);
    return {
      ok: true,
      count: orphans.length,
      orphanNames: names,
      scanned: scanned,
      items: items.length,
      skipped: skipped,
      outPath: outPath
    };
  }

  var API = {
    run: run,
    _refHit: _refHit,
    _findOrphans: _findOrphans,
    _fmtBytes: _fmtBytes,
    _binExt: _binExt
  };

  if (typeof window !== 'undefined') window.qqqPure = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
