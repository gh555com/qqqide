// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-codelens.js — codelens 按钮机器（q3 q1.js FileCodeLensProvider 100% 移植）
//
// 老项目：每个相框上方一排按钮（VS Code codelens）。本机用 Monaco 原生 codeLens 复刻——
// 数据源 = viewport-machine 的 per-editor 锚点表（唯一渲染真理机，只读消费），
// 按钮点击 → 命令（老 qqq.* 命令语义 1:1；例外：首列 🗀qqq = 内置 Roam 定位，2026-09-17 用户定）。
//
// 等级 = 偏好 codelensLevel（老枚举 0/1/7 原值）:
//   0 = 无
//   1 = 仅文件信息行（open file，无 ✎ 前缀）
//   7 = 全套: [✎(文件夹体积) 🗀qqq] [✎rename] [✎c1 复制路径] [✎c2 复制文件] [✎c3 复制图片二进制*]
//            + 文件信息行 ✎(体积) {图标} {完整路径} {缩放% 宽x高}
//            + [✎qode*]     （*c3 仅图片；*qode 仅文本文件 → 在右分组打开）
//
// 样式接管 takeOverCodelensStyle=true → Tahoma 11 号 + 主题红（老「红色 13 号」，用户定 -1 后再 -1）
//
// 异步元数据机器（stat / 文件夹体积 / 文本探针 / 媒体探测）：
//   全部带记忆缓存；任一数据到位 → scheduleRefresh() → Monaco 重拉 provider（按钮渐进补齐）
//
// 暴露: window.qqqCodelens
// 依赖: qqqPrefs / qqqViewportMachine / qqqFrameRenderer / i18n(_i) / bridge / qqqideQoast / qqqTabs
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;

  // ═══ 偏好（qqq-prefs 未加载时按老项目默认模板）═══
  function _pref(key, dflt) {
    try {
      if (window.qqqPrefs && window.qqqPrefs.get) {
        var v = window.qqqPrefs.get(key);
        if (v !== undefined) return v;
      }
    } catch (e) { /* */ }
    return dflt;
  }
  function _level() {
    var v = String(_pref('codelensLevel', '7'));
    return (v === '0' || v === '1' || v === '7') ? v : '7';
  }
  function _takeover() { return _pref('takeOverCodelensStyle', true) !== false; }

  // ═══ i18n（键唯一真理源 locales/zh.json；其他语言 ky.py 自动翻译）═══
//   调用点恒传完整键字面量（editor.codelens.*）——审计 ⑦ 零动态拼接（铁律 §4.4）
  function _t(key, fallback, a0, a1) {
    var s = fallback;
    try { if (window._i) s = window._i(key, fallback); } catch (e) { /* */ }
    if (a0 !== undefined) s = String(s).replace('{0}', String(a0));
    if (a1 !== undefined) s = String(s).replace('{1}', String(a1));
    return s;
  }
  function _ti(key, fallback) {
    try { if (window._i) return window._i(key, fallback); } catch (e) { /* */ }
    return fallback;
  }

  // ═══ 格式化（老 global.js formatBytes / q1.js formatDuration·calculateAspectRatioString 逐字）═══
  function formatBytes(size, decimals) {
    if (size == null || isNaN(size)) return '?';
    var units = ['B', 'KB', 'MB', 'GB'];
    var idx = 0, val = Number(size);
    while (val >= 1024 && idx < units.length - 1) { val /= 1024; idx++; }
    return val.toFixed(idx > 0 ? (decimals === undefined ? 1 : decimals) : 0) + ' ' + units[idx];
  }
  function formatDuration(sec) {
    if (sec == null || isNaN(sec) || sec < 0) return '0s';
    if (sec >= 60) {
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      return m + 'm + ' + s.toFixed(2) + 's';
    }
    return Number(sec).toFixed(2) + 's';
  }
  function aspectRatioString(w, h) {
    if (!w || !h) return '';
    if (w >= h) {
      var r = (h / w) * 16;
      return '16__' + parseFloat(r.toFixed(1));
    }
    var r2 = (w / h) * 16;
    return parseFloat(r2.toFixed(1)) + '__16';
  }
  function _fmtDate(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleString(); } catch (e) { return ''; }
  }

  // ═══ 路径小工具 ═══
  function _extOf(name) {
    var d = String(name || '').lastIndexOf('.');
    return d >= 0 ? String(name).slice(d).toLowerCase() : '';
  }
  function _dirname(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : s;
  }
  function _joinPath(dir, name) {
    var sep = (String(dir).indexOf('\\') >= 0) ? '\\' : '/';
    return String(dir).replace(/[\\/]+$/, '') + sep + name;
  }

  // c3 可复制为位图的扩展名（老 h.js IMAGE_EXTS_FOR_CLIPBOARD 原表）
  var CLIPBOARD_IMAGE_EXTS = {
    '.png': 1, '.jpg': 1, '.jpeg': 1, '.gif': 1, '.bmp': 1, '.webp': 1, '.ico': 1, '.tiff': 1, '.tif': 1,
  };

  // ═══ 状态 ═══
  var _monaco = null;
  var _emitter = null;
  var _refreshTimer = null;

  var STAT_TTL = 120000;          // stat 记忆 2 分钟（到期后台刷新，先给旧值防闪）
  var FOLDER_TTL = 120000;        // 文件夹体积记忆 2 分钟（到期后台重算，先给旧值防闪）
  var FOLDER_RETRY_MS = 15000;    // 文件夹体积失败重试冷却（老 FOLDER_SIZE_SCAN_COOLDOWN 15000）

  var _statMemo = {};    // path → { data:{size,mtimeMs,birthtimeMs,isDir}, ts, pending }
  var _folderMemo = {};  // dir  → { data:{size,summary}, ts, triedAt, pending }
  var _textMemo = {};    // path → true | false | { pending:true }
  var _mediaMemo = {};   // path → info | null | { pending:true }

  // ════════════════════════════════════════════════════════════════════
  // 异步元数据机器
  // ════════════════════════════════════════════════════════════════════

  // stat（命中即同步返回；未命中触发异步取回 → 刷新）
  function _statKick(path) {
    var m = _statMemo[path];
    if (m && m.pending) return;
    if (!m) { m = _statMemo[path] = {}; }
    m.pending = true;
    var done = function (data) {
      m.pending = false;
      m.ts = Date.now();
      m.data = data;
      scheduleRefresh();
    };
    try {
      bridge.fs.stat(path).then(function (st) {
        done(st ? {
          size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs,
          isDir: !!(st.isDir || st.isDirectory),
        } : null);
      }).catch(function () { done(null); });
    } catch (e) { done(null); }
  }
  function _statGet(path) {
    var m = _statMemo[path];
    // ★ 有旧值优先给旧值（含后台刷新中）——否则 TTL 过期时 pending 分支吃掉旧值，按钮行每 2 分钟闪断一次
    if (m && m.data) {
      if (m.pending || !m.ts || (Date.now() - m.ts) > STAT_TTL) _statKick(path);   // 过期/刷新中：继续给旧值
      return m.data;
    }
    if (m && m.pending) return null;
    // 失败/不存在：重试冷却（防每次 provide 都抡 IPC；15s 后自然重探）
    if (m && m.ts && (Date.now() - m.ts) < FOLDER_RETRY_MS) return null;
    _statKick(path);
    return null;
  }

  // 文件夹体积（老 geqFolderSizeSync + fetchFolderSizeInternal 语义：异步扫，未就绪显示 ●）
  //   记忆语义 = stat 同款：有旧值先给旧值 + TTL 后台重算（不闪断）；失败按 FOLDER_RETRY_MS 冷却
  function _folderKick(dir) {
    var rec = _folderMemo[dir];
    if (!rec) { rec = _folderMemo[dir] = {}; }
    if (rec.pending) return;
    rec.pending = true;
    rec.triedAt = Date.now();
    try {
      bridge.fs.dirSummary(dir).then(function (r) {
        rec.pending = false;
        if (r && r.ok) {
          var parts = [];
          var totalFiles = 0;
          var stats = r.ext_stats || {};
          var entries = Object.keys(stats).map(function (k) { return [k, stats[k]]; });
          entries.sort(function (a, b) { return b[1] - a[1]; });
          for (var i = 0; i < entries.length; i++) {
            totalFiles += entries[i][1];
            parts.push(entries[i][1] + '★ ' + (entries[i][0] || _t('editor.codelens.noExtension', '无后缀')));
          }
          var summary;
          if (parts.length > 0) summary = _t('editor.codelens.filesCountWithBreakdown', '{0}个文件：{1}', totalFiles, parts.join(';  '));
          else if ((r.file_count_root || 0) > 0) summary = _t('editor.codelens.filesCount', '{0}个文件', r.file_count_root);
          else summary = _t('editor.codelens.emptyFolder', '空文件夹');
          rec.data = { size: r.total_size || 0, summary: summary };
          rec.ts = Date.now();
        }
        scheduleRefresh();
      }).catch(function () { rec.pending = false; scheduleRefresh(); });
    } catch (e) { rec.pending = false; }
  }
  function _folderGet(dir) {
    var m = _folderMemo[dir];
    if (m && m.data) {
      // TTL 到期：后台重算（继续给旧值；壳层同语义「旧值 + 后台重扫」，零阻塞零闪断）
      if (!m.pending && (!m.ts || (Date.now() - m.ts) > FOLDER_TTL)) _folderKick(dir);
      return m.data;
    }
    if (m && m.pending) return null;
    if (m && m.triedAt && (Date.now() - m.triedAt) < FOLDER_RETRY_MS) return null;
    if (!bridge || !bridge.fs || typeof bridge.fs.dirSummary !== 'function') return null;  // 壳层未重启
    _folderKick(dir);
    return null;
  }

  // 文本判定（老 isPlainTextFile 语义：扩展名白名单同步快径 → 8KB 头部嗅探）
  function _textGet(path, ext) {
    var fr = window.qqqFrameRenderer;
    if (fr && fr.isTextExt && fr.isTextExt(ext)) return true;
    var m = _textMemo[path];
    if (m === true || m === false) return m;
    if (m && m.pending) return null;
    if (fr && typeof fr.looksLikeText === 'function') {
      _textMemo[path] = { pending: true };
      try {
        fr.looksLikeText(path, ext).then(function (v) {
          _textMemo[path] = !!v;
          scheduleRefresh();
        }).catch(function () { _textMemo[path] = false; scheduleRefresh(); });
      } catch (e) { _textMemo[path] = false; }
    } else {
      _textMemo[path] = false;
    }
    return null;
  }

  // 媒体探测（复用 frame-renderer 的 memo；拿到结果后刷新出 缩放%/宽高/编码/时长）
  function _mediaGet(path) {
    var m = _mediaMemo[path];
    if (m !== undefined) return (m && m.pending) ? null : m;
    var fr = window.qqqFrameRenderer;
    if (!fr || typeof fr.probeMediaInfo !== 'function') return null;
    _mediaMemo[path] = { pending: true };
    try {
      fr.probeMediaInfo(path).then(function (info) {
        _mediaMemo[path] = info || null;
        scheduleRefresh();
      }).catch(function () { _mediaMemo[path] = null; scheduleRefresh(); });
    } catch (e) { _mediaMemo[path] = null; }
    return null;
  }

  // ════════════════════════════════════════════════════════════════════
  // 刷新机器（异步数据到位 / 锚点解析完成 / 偏好变更 → 通知 Monaco 重拉）
  // ════════════════════════════════════════════════════════════════════
  function scheduleRefresh() {
    if (!_emitter) return;
    if (_refreshTimer) return;
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      try { _emitter.fire({}); } catch (e) { /* */ }
    }, 120);
  }
  function refreshNow() {
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    try { _emitter.fire({}); } catch (e) { /* */ }
  }

  // ★ 源文件变更联动（viewport mtime 检出 → 调用）：该路径四本账作废 → 数字自动重算（零按钮）
  //   stat 保留旧值走重取（防闪断）；媒体/文本/所在文件夹作废重探；文件夹给旧值后台重算
  function _invalidatePath(path) {
    if (!path) return;
    try {
      var p = String(path);
      var sm = _statMemo[p];
      if (sm) { sm.ts = 0; }
      delete _mediaMemo[p];
      delete _textMemo[p];
      var d = _dirname(p);
      var fm = _folderMemo[d];
      if (fm) {
        if (fm.data) { if (!fm.pending) _folderKick(d); }
        else if (!fm.pending) { delete _folderMemo[d]; }
      }
      scheduleRefresh();
    } catch (e) { /* */ }
  }

  // ════════════════════════════════════════════════════════════════════
  // lens 构建（老 provideCodeLenses 语义逐条对齐）
  // ════════════════════════════════════════════════════════════════════
  function _lens(line, title, tooltip, cmdId, args) {
    var command = { id: cmdId, title: title, arguments: args || [] };
    if (tooltip) command.tooltip = tooltip;
    return { range: new _monaco.Range(line, 1, line, 1), command: command };
  }

  function _pushAnchorLenses(out, ent, level) {
    var path = ent.path;
    var st = _statGet(path);
    if (!st) return;                                    // 未就绪 / 不存在 → 先不出（老 stat 失败 continue）

    var fileName = ent.fileName || '';
    var ext = _extOf(fileName);
    var isDir = !!st.isDir;
    var fr = window.qqqFrameRenderer;
    var kind = (fr && fr.classifyExt) ? fr.classifyExt(ext) : 'file';   // image | video | audio | file
    var isVidOrImg = (kind === 'image' || kind === 'video');

    var isText = false;
    if (!isDir && !isVidOrImg && kind !== 'audio') {
      var tv = _textGet(path, ext);
      isText = (tv === true);
    }

    var line = ent.line;
    var tooltip = _t('editor.codelens.created', '创建') + ': ' + _fmtDate(st.birthtimeMs) +
      '\n' + _t('editor.codelens.modified', '修改') + ': ' + _fmtDate(st.mtimeMs);

    // ── level 7：左排按钮（老顺序：open folder / rename / c1 / c2 / [c3]）──
    if (level === '7') {
      var dir = _dirname(path);
      var fsum = _folderGet(dir);
      var fSizeStr = fsum ? formatBytes(fsum.size) : '●';
      var folderTip = fsum ? fsum.summary : _t('editor.codelens.calculatingFolderSize', '正在计算文件夹大小...');
      out.push(_lens(line, '✎( ' + fSizeStr + ') 🗀qqq', folderTip, 'qqqide.codelens.reveal', [path]));
      out.push(_lens(line, '✎rename', '', 'qqqide.codelens.rename', [{ path: path, fileName: fileName }]));
      out.push(_lens(line, '✎c1', path, 'qqqide.codelens.copyPath', [path]));
      out.push(_lens(line, '✎c2', '', 'qqqide.codelens.copyFile', [path]));
      if (!isDir && CLIPBOARD_IMAGE_EXTS[ext]) {
        out.push(_lens(line, '✎c3', '', 'qqqide.codelens.copyImage', [path]));
      }
    }

    // ── 文件信息行（老 title 拼接逐字：前缀(体积) 图标 空格 完整路径 尺寸后缀）──
    var titlePrefix = (level === '1') ? '' : '✎';
    var iconPart = '';
    var spacePart = '   ';
    var titleSuffix = '';

    if (isDir) {
      iconPart = ' 📁';
      spacePart = '';
    } else if (isVidOrImg) {
      var info = _mediaGet(path);
      if (info && info.width && info.height) {
        if (kind === 'video') { iconPart = '🎬'; spacePart = ''; }
        if (fr && fr.getFrameConfig && fr.fitIntoBox) {
          var cfg = fr.getFrameConfig(info);
          var fit = fr.fitIntoBox(info.width, info.height, cfg.width, cfg.height, _pref('enlargeSmallImages', false) === true);
          titleSuffix = '   (' + Math.round(fit.scale * 100) + '%)  ' + info.width + 'x' + info.height;
        }
        if (info.codec) tooltip += '\n' + _t('editor.codelens.codec', '编码') + ': ' + info.codec;
        var arStr = aspectRatioString(info.width, info.height);
        if (arStr) tooltip += '\n' + _t('editor.codelens.aspectRatio', '宽高比') + ': ' + arStr;
        if ((kind === 'video' || ext === '.gif') && info.duration > 0.1) {
          tooltip += '\n⌛' + _t('editor.codelens.originalDuration', '原始时长') + ': ' + formatDuration(info.duration);
        }
      }
    } else if (isText) {
      iconPart = ' 📄';
      spacePart = '';
    }

    out.push(_lens(line,
      titlePrefix + '( ' + formatBytes(st.size) + ')' + iconPart + spacePart + path + titleSuffix,
      tooltip, 'qqqide.codelens.open', [path]));

    // ── qode（仅文本文件 + level 7：在右分组打开并进入编辑状态）──
    if (level === '7' && isText) {
      out.push(_lens(line, '✎qode', _t('editor.codelens.openRight', '在右边分组打开文件并进入编辑状态'),
        'qqqide.codelens.qode', [path]));
    }
  }

  function _provide(model) {
    var empty = { lenses: [], dispose: function () { } };
    if (!_monaco || !model) return empty;
    var level = _level();
    if (level === '0') return empty;
    if (!window.qqqViewportMachine) return empty;

    // 本模型 → 锚点表（任一持有该 model 的 editor 的锚点表等价）
    var anchors = null;
    try {
      var eds = _monaco.editor.getEditors ? _monaco.editor.getEditors() : [];
      for (var i = 0; i < eds.length; i++) {
        if (eds[i].getModel && eds[i].getModel() === model) {
          anchors = window.qqqViewportMachine.getAnchors(eds[i]);
          break;
        }
      }
    } catch (e) { /* */ }
    if (!anchors) return empty;

    var lenses = [];
    try {
      var keys = Object.keys(anchors);
      for (var k = 0; k < keys.length; k++) {
        var ent = anchors[keys[k]];
        if (!ent || !ent.path) continue;
        try { _pushAnchorLenses(lenses, ent, level); } catch (e2) { /* 单锚点异常不拖累整表 */ }
      }
    } catch (e3) { /* */ }
    return { lenses: lenses, dispose: function () { } };
  }

  // ════════════════════════════════════════════════════════════════════
  // 命令实现（老 qqq.* 命令 1:1）
  // ════════════════════════════════════════════════════════════════════
  function _toast(msg, type) {
    try {
      if (window.qqqideQoast && window.qqqideQoast.show) {
        window.qqqideQoast.show(msg, { type: type || 'info', duration: type === 'error' ? 6000 : 3000 });
      }
    } catch (e) { /* */ }
  }

  // 🗀qqq → 在当前 Roam 中打开并定位该文件（2026-09-17 用户定：全平台统一，弃系统资源管理器）
  // 定位机器唯一入口 = shell-overlay window.__qqq_roamRevealPath：命中 → revealFile 选中+滚动 / 目录 → navTo；
  // 文件缺失 → 自动爬升最近祖先目录 + qoast 提示（引擎自带裁决，零死链）。
  function _cmdReveal(path) {
    try {
      if (typeof window.__qqq_roamRevealPath === 'function') { window.__qqq_roamRevealPath(String(path)); return; }
    } catch (e) { /* */ }
    // 兜底（shell-overlay 未加载）：系统资源管理器定位
    try {
      if (bridge && bridge.shell && bridge.shell.showItemInFolder) { bridge.shell.showItemInFolder(path); return; }
      if (bridge && bridge.shell && bridge.shell.openPath) { bridge.shell.openPath(_dirname(path)); }
    } catch (e) { /* */ }
  }

  // 文件信息行 → 用系统默认程序打开（老 qqq.openFile 语义）
  function _cmdOpen(path) {
    try { if (bridge && bridge.shell && bridge.shell.openPath) bridge.shell.openPath(path); } catch (e) { /* */ }
  }

  // c1 → 复制纯文本路径
  function _cmdCopyPath(path) {
    var p;
    try { p = bridge.clipboard.writeText(String(path)); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function () {
      _toast(_t('editor.codelens.copyPathSuccess', '已复制成功 — 纯文本路径'), 'success');
    }).catch(function (e) {
      _toast(_t('editor.codelens.copyPathFailed', '复制失败 — 纯文本路径: {0}', (e && e.message) || 'clipboard'), 'error');
    });
  }

  // c2 → 复制文件进剪贴板（CF_HDROP，等于资源管理器 Ctrl+C）
  function _cmdCopyFile(path) {
    var p;
    try { p = bridge.clipboard.writeFiles([String(path)]); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (ok) {
      if (ok) _toast(_t('editor.codelens.copyFileSuccess', '已复制成功 — 文件'), 'success');
      else _toast(_t('editor.codelens.copyFileFailed', '复制失败 — 文件: {0}', 'writeFiles'), 'error');
    }).catch(function (e) {
      _toast(_t('editor.codelens.copyFileFailed', '复制失败 — 文件: {0}', (e && e.message) || 'error'), 'error');
    });
  }

  // c3 → 复制图片为位图二进制（可直接粘贴进聊天/画布）
  function _cmdCopyImage(path) {
    var p;
    try { p = bridge.clipboard.writeImage({ path: String(path) }); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (ok) {
      if (ok) _toast(_t('editor.codelens.copyImageSuccess', '已复制成功 — 位图二进制'), 'success');
      else _toast(_t('editor.codelens.copyImageFailed', '复制失败 — 位图二进制: {0}', 'unsupported format'), 'error');
    }).catch(function (e) {
      _toast(_t('editor.codelens.copyImageFailed', '复制失败 — 位图二进制: {0}', (e && e.message) || 'error'), 'error');
    });
  }

  // qode → 在右分组打开（老 openFileInRightGroup）
  function _cmdQode(path) {
    try {
      if (window.qqqTabs && window.qqqTabs.openFileInRightGroup) { window.qqqTabs.openFileInRightGroup(path); return; }
      if (window.qqqTabs && window.qqqTabs.openFile) { window.qqqTabs.openFile(path); }
    } catch (e) { /* */ }
  }

  // ── 锚点定位（弹窗/命令执行期间文档可能已位移 → 每次实时重定位）──
  function _findAnchor(path, fileName) {
    try {
      var eds = _monaco.editor.getEditors ? _monaco.editor.getEditors() : [];
      for (var i = 0; i < eds.length; i++) {
        var map = window.qqqViewportMachine.getAnchors(eds[i]);
        var keys = Object.keys(map);
        for (var j = 0; j < keys.length; j++) {
          var e = map[keys[j]];
          if (e && e.path === path && (!fileName || e.fileName === fileName)) {
            return { editor: eds[i], entry: e };
          }
        }
      }
    } catch (e2) { /* */ }
    return null;
  }

  function _tokenLen(ent) {
    if (ent && ent._rawLen > 0) return ent._rawLen;
    var sha = ent && ent.sha256 ? String(ent.sha256) : '';
    var name = ent && ent.fileName ? String(ent.fileName) : '';
    if (/[\s"]/.test(name)) name = '"' + name + '"';   // 引号式令牌宽度同口径（漏它 → 重命名会啃掉半个令牌）
    return 2 + sha.length + 1 + name.length;            // 📎 = 2 UTF-16 单元
  }

  function _buildToken(sha, name) {
    var s = sha ? String(sha).toLowerCase() : '';
    var nm = String(name);
    if (/[\s"]/.test(nm)) nm = '"' + nm + '"';
    return '\uD83D\uDCCE' + s + ':' + nm;
  }

  // 重命名落地：改盘 + 改文档锚点令牌 + 视口重扫（帧跟着换）
  function _applyRenameToDoc(anchorPath, oldName, newName, newAbs) {
    try {
      var found = _findAnchor(anchorPath, oldName);
      if (!found || !found.editor) { scheduleRefresh(); return; }
      var ed = found.editor;
      var ent = found.entry;
      var len = _tokenLen(ent);
      var token = _buildToken(ent.sha256, newName);
      var line = ent.line, col = ent.col;
      ed.executeEdits('qqq-codelens-rename', [{
        range: new _monaco.Range(line, col, line, col + len),
        text: token,
      }]);
      try {
        window.qqqViewportMachine.registerPastedAnchor(ed, line, col, {
          path: newAbs, fileName: newName, sha256: ent.sha256, rawLen: token.length,
        });
      } catch (e1) { /* */ }
      try { window.qqqViewportMachine.refresh(ed); } catch (e2) { /* */ }
      scheduleRefresh();
    } catch (e) { /* */ }
  }

  // ── 重命名弹窗（Electron 无 window.prompt → 自建最小输入框；老 validateInput 语义）──
  var _modalEl = null;
  function _closeRenameModal() {
    if (_modalEl && _modalEl.parentNode) {
      try { _modalEl.parentNode.removeChild(_modalEl); } catch (e) { /* */ }
    }
    _modalEl = null;
  }
  function _openRenameModal(path, fileName) {
    _closeRenameModal();
    var cur = String(fileName || '');

    var mask = document.createElement('div');
    mask.className = 'qqq-cl-mask';
    var box = document.createElement('div');
    box.className = 'qqq-cl-box';

    var title = document.createElement('div');
    title.className = 'qqq-cl-title';
    title.textContent = _t('editor.codelens.rename', '重命名');

    var input = document.createElement('input');
    input.className = 'qqq-cl-input';
    input.type = 'text';
    input.value = cur;
    input.spellcheck = false;

    var err = document.createElement('div');
    err.className = 'qqq-cl-err';

    var btns = document.createElement('div');
    btns.className = 'qqq-cl-btns';
    var btnCancel = document.createElement('button');
    btnCancel.className = 'qqq-cl-btn';
    btnCancel.textContent = _ti('common.cancel', '取消');
    var btnOk = document.createElement('button');
    btnOk.className = 'qqq-cl-btn qqq-cl-btn--ok';
    btnOk.textContent = _ti('common.confirm', '确定');

    btns.appendChild(btnCancel);
    btns.appendChild(btnOk);
    box.appendChild(title);
    box.appendChild(input);
    box.appendChild(err);
    box.appendChild(btns);
    mask.appendChild(box);
    document.body.appendChild(mask);
    _modalEl = mask;

    var busy = false;
    function submit() {
      if (busy) return;
      var v = String(input.value || '').trim();
      if (!v) { err.textContent = _t('editor.codelens.fileNameEmpty', '文件名不能为空'); return; }
      if (v === cur) { _closeRenameModal(); return; }
      var newAbs = _joinPath(_dirname(path), v);
      err.textContent = '';
      busy = true;
      var doRename = function () {
        bridge.fs.rename(path, newAbs).then(function () {
          _closeRenameModal();
          _applyRenameToDoc(path, cur, v, newAbs);
          _toast(_t('editor.codelens.renameSuccess', '重命名成功: {0}', v), 'success');
        }).catch(function (e) {
          busy = false;
          err.textContent = _t('editor.codelens.renameFailed', '重命名失败: {0}', (e && e.message) || 'rename failed');
        });
      };
      try {
        bridge.fs.exists(newAbs).then(function (exists) {
          if (exists) { busy = false; err.textContent = _t('editor.codelens.targetFileExists', '目标文件已存在'); return; }
          doRename();
        }).catch(function () { doRename(); });
      } catch (e) { doRename(); }
    }

    btnCancel.addEventListener('click', function () { _closeRenameModal(); });
    btnOk.addEventListener('click', submit);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) _closeRenameModal(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _closeRenameModal(); }
    });
    setTimeout(function () {
      try {
        input.focus();
        input.select();
      } catch (e) { /* */ }
    }, 0);
  }

  // ════════════════════════════════════════════════════════════════════
  // 样式接管（takeOverCodelensStyle：红色 11 号 = 老 13 号口径 -2；用户两次定 -1）
  // ════════════════════════════════════════════════════════════════════
  function _applyStyleClass() {
    try {
      var on = _takeover();
      var el = document.documentElement;
      if (!el) return;
      if (on) el.classList.add('qqq-codelens-style');
      else el.classList.remove('qqq-codelens-style');
    } catch (e) { /* */ }
  }

  function _applyOptions(ed) {
    if (!ed || typeof ed.updateOptions !== 'function') return;
    try {
      var on = _takeover();
      ed.updateOptions({
        codeLens: _level() !== '0',
        codeLensFontFamily: on ? 'Tahoma, Liberation Sans, DejaVu Sans, sans-serif' : '',
        codeLensFontSize: on ? 11 : 0,
      });
    } catch (e) { /* */ }
  }
  function _applyAllEditors() {
    try {
      var eds = _monaco && _monaco.editor.getEditors ? _monaco.editor.getEditors() : [];
      for (var i = 0; i < eds.length; i++) _applyOptions(eds[i]);
    } catch (e) { /* */ }
    _applyStyleClass();
  }

  function _onPrefsChange(key) {
    if (key !== null && key !== undefined) {
      if (key !== 'codelensLevel' && key !== 'takeOverCodelensStyle') {
        // 其余偏好不改变按钮集合，但可能改变信息行（frameSizeMode/enlargeSmallImages → 缩放%）
        if (key === 'frameSizeMode' || key === 'enlargeSmallImages') refreshNow();
        return;
      }
    }
    _applyAllEditors();
    refreshNow();
  }

  // ════════════════════════════════════════════════════════════════════
  // 安装（editor.js 在 Monaco 就绪后调用一次）
  // ════════════════════════════════════════════════════════════════════
  var _installed = false;
  function install(monaco) {
    if (!monaco || !monaco.editor || !monaco.languages) return;
    if (_installed && _monaco === monaco) return;
    _monaco = monaco;
    _installed = true;

    try { _emitter = new monaco.Emitter(); } catch (e) { _emitter = null; }

    // ── 命令注册（老 qqq.* 命令 1:1）──
    var reg = function (id, fn) {
      try { monaco.editor.registerCommand(id, function (accessor, arg) { fn(arg); }); } catch (e) { /* */ }
    };
    reg('qqqide.codelens.reveal', _cmdReveal);
    reg('qqqide.codelens.open', _cmdOpen);
    reg('qqqide.codelens.copyPath', _cmdCopyPath);
    reg('qqqide.codelens.copyFile', _cmdCopyFile);
    reg('qqqide.codelens.copyImage', _cmdCopyImage);
    reg('qqqide.codelens.qode', _cmdQode);
    reg('qqqide.codelens.rename', function (arg) {
      if (!arg || !arg.path) return;
      _openRenameModal(arg.path, arg.fileName || '');
    });

    // ── provider（通配语言：任何语言的文档都可能有锚点）──
    try {
      monaco.languages.registerCodeLensProvider('*', {
        onDidChange: _emitter ? _emitter.event : undefined,
        provideCodeLenses: function (model) { return _provide(model); },
      });
    } catch (e) { /* */ }

    // ── 已存在 + 新建 editor 全部应用 codelens 选项 ──
    _applyAllEditors();
    try {
      monaco.editor.onDidCreateEditor(function (ed) {
        _applyOptions(ed);
        scheduleRefresh();
      });
    } catch (e2) { /* */ }

    // ── 偏好变更 ──
    try { if (window.qqqPrefs && window.qqqPrefs.onChange) window.qqqPrefs.onChange(_onPrefsChange); } catch (e3) { /* */ }
  }

  // ═══ Public API ═══
  window.qqqCodelens = {
    install: install,
    scheduleRefresh: scheduleRefresh,
    refreshNow: refreshNow,
    invalidatePath: _invalidatePath,
    getLevel: _level,
    openRenameModal: _openRenameModal,
    _state: function () {
      return { installed: _installed, level: _level(), takeover: _takeover() };
    },
  };

})();
