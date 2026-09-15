// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// frame-renderer.js — WYSIWYG 相框渲染引擎（q3 q1.js 100% 移植）
//
// 帧族（老口径逐一对齐）:
//   · 媒体帧  image / video — 512x288 大框 或 256x144 小框（frameSizeMode:
//                            large / small / fix=按原图尺寸自动选）
//   · 文本胶片             — ffmpeg drawtext 514x290 webp（textSlideColorScheme /
//                            textSlideFontSize 生效），老 generateTextPreview 移植
//   · 图标帧  file/dir/aud — 原生 32x32 图标（老 extract_icon 引擎 → Electron
//                            app.getFileIcon 对齐），ffmpeg 解析不了的文件也走此帧
//   · 进度条               — optmum 专属（黑底 + 米色扫过，一圈 = 媒体时长，无限循环）
//   · 水印                 — al.png(大框) / as.png(小框)，removeWatermark=true 才去掉
//
// 几何（老 q1.js buildAfterStyle 口径）:
//   外框 = preview + 12（box-sizing: border-box；= 6 内容余量 + 2*2 padding + 2*1 虚线边）
//   内容区 = preview + 6；图像显示尺寸由 fitIntoBox 决定（enlargeSmallImages 控放大）
//
// 构建是异步的（探测 + 预览生成），返回的 DOM 自带 _zoneH（视口机器据此设 ViewZone 高度）；
// 预览失败时原地降级为图标帧并调 _requestResize（老语义：ffmpeg 解析不了 → 图标框）。
//
// 暴露: window.qqqFrameRenderer
// 依赖: qqqPrefs / qqqThumbnailCache / bridge.fs / bridge.media
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;

  // ═══ 常量（老 q3 q1.js 原值）═══
  var LARGE_W = 512, LARGE_H = 288;
  var SMALL_W = 256, SMALL_H = 144;
  var OUT_PAD = 12;          // 外框 = preview + 12
  var ICON_SIZE = 32;        // 图标帧内容 32x32（老 extract_icon LARGEICON）
  var BG_LIGHT = '#fef6e3';
  var BG_DARK = '#1B1411';
  var CHECKER_A = '#fdf6e3';
  var CHECKER_B = '#e6e1cf';
  var WM_LARGE = 'assets/frames/al.png';
  var WM_SMALL = 'assets/frames/as.png';
  var TEXT_FONT_DEFAULT = 14;

  var _removeWatermark = false;
  function setRemoveWatermark(v) { _removeWatermark = !!v; }
  function shouldRemoveWatermark() { return _removeWatermark; }

  // ═══ 用户偏好（core/qqq-prefs.js；未加载时按老项目默认模板）═══
  function _pref(key) {
    try {
      if (window.qqqPrefs && window.qqqPrefs.get) return window.qqqPrefs.get(key);
    } catch (e) { /* */ }
    return undefined;
  }
  function _perfMode() { return _pref('performanceMode') || 'optmum'; }
  function _frameSizeMode() { return _pref('frameSizeMode') || 'fix'; }
  function _enlarge() { return !!_pref('enlargeSmallImages'); }
  function _textScheme() { return _pref('textSlideColorScheme') || 'light'; }
  function _textFontSize() {
    var n = Number(_pref('textSlideFontSize'));
    return (isFinite(n) && n > 0) ? n : TEXT_FONT_DEFAULT;
  }
  function _bgColor() { return _textScheme() === 'dark' ? BG_DARK : BG_LIGHT; }

  // 影响帧 DOM 的偏好组合键（视口机器据此判定重建）
  function variantKey() {
    return [
      _perfMode(), _frameSizeMode(), _enlarge() ? 1 : 0,
      _textScheme(), _textFontSize(), _removeWatermark ? 1 : 0,
    ].join('|');
  }

  // ═══ 扩展名表（老 q3 global.js 原表）═══
  var IMAGE_EXTS = { '.png':1,'.jpg':1,'.jpeg':1,'.gif':1,'.bmp':1,'.webp':1,'.ico':1,'.tiff':1,'.tif':1,'.svg':1,'.ai':1,'.eps':1,'.cdr':1,'.psd':1 };
  var VIDEO_EXTS = { '.mp4':1,'.mkv':1,'.webm':1,'.avi':1,'.mov':1,'.wmv':1,'.flv':1,'.rmvb':1,'.mpeg':1,'.mpg':1,'.3gp':1,'.m4v':1,'.f4v':1,'.ts':1,'.mts':1,'.m2ts':1,'.vob':1 };
  var AUDIO_EXTS = { '.mp3':1,'.wav':1,'.flac':1,'.m4a':1,'.aac':1,'.ogg':1,'.wma':1 };
  var BROWSER_NATIVE = { '.png':1,'.jpg':1,'.jpeg':1,'.gif':1,'.bmp':1,'.webp':1,'.svg':1,'.ico':1 };
  var TEXT_EXTS = {
    '.txt':1,'.md':1,'.markdown':1,'.log':1,'.ini':1,'.cfg':1,'.conf':1,'.config':1,
    '.json':1,'.xml':1,'.yaml':1,'.yml':1,'.toml':1,
    '.js':1,'.ts':1,'.jsx':1,'.tsx':1,'.mjs':1,'.cjs':1,
    '.py':1,'.pyw':1,'.pyi':1,'.java':1,'.kt':1,'.kts':1,'.scala':1,'.groovy':1,
    '.c':1,'.h':1,'.cpp':1,'.hpp':1,'.cc':1,'.cxx':1,'.hxx':1,
    '.cs':1,'.vb':1,'.fs':1,'.fsx':1,'.go':1,'.rs':1,'.swift':1,'.m':1,'.mm':1,
    '.rb':1,'.php':1,'.pl':1,'.pm':1,'.lua':1,'.r':1,
    '.sh':1,'.bash':1,'.zsh':1,'.fish':1,'.ps1':1,'.psm1':1,'.bat':1,'.cmd':1,
    '.html':1,'.htm':1,'.css':1,'.scss':1,'.sass':1,'.less':1,
    '.sql':1,'.graphql':1,'.gql':1,'.env':1,'.gitignore':1,'.gitattributes':1,'.editorconfig':1,
    '.dockerfile':1,'.makefile':1,'.cmake':1,
    '.rst':1,'.tex':1,'.bib':1,'.csv':1,'.tsv':1,
    '.vue':1,'.svelte':1,'.astro':1,
    '.asm':1,'.s':1,'.nasm':1,'.lisp':1,'.cl':1,'.el':1,'.scm':1,'.rkt':1,
    '.hs':1,'.lhs':1,'.ml':1,'.mli':1,'.elm':1,'.erl':1,'.ex':1,'.exs':1,
    '.clj':1,'.cljs':1,'.cljc':1,'.edn':1,'.nim':1,'.zig':1,'.v':1,'.d':1,
  };

  function extOf(name) {
    if (!name) return '';
    var d = name.lastIndexOf('.');
    return d >= 0 ? name.slice(d).toLowerCase() : '';
  }

  function _fileUrl(p) {
    var s = String(p || '').replace(/\\/g, '/');
    try { return 'file:///' + encodeURI(s); } catch (e) { return 'file:///' + s; }
  }

  // ═══ fitIntoBox — 老 q1.js 逐字移植 ═══
  function fitIntoBox(srcW, srcH, boxW, boxH, enlarge) {
    if (!srcW || !srcH) {
      return { width: boxW, height: boxH, scale: 1, unknown: true };
    }
    var finalW, finalH, s;
    if (enlarge) {
      var scale = Math.min(boxW / srcW, boxH / srcH);
      s = scale;
      finalW = Math.max(1, Math.round(srcW * scale));
      finalH = Math.max(1, Math.round(srcH * scale));
    } else {
      if (srcW > boxW || srcH > boxH) {
        var scale2 = Math.min(boxW / srcW, boxH / srcH);
        s = scale2;
        finalW = Math.max(1, Math.round(srcW * scale2));
        finalH = Math.max(1, Math.round(srcH * scale2));
      } else {
        s = 1;
        finalW = srcW;
        finalH = srcH;
      }
    }
    return { width: finalW, height: finalH, scale: s };
  }

  // ═══ 相框尺寸决策 — 老 q1.js getFrameConfig 逐字移植 ═══
  //   fix: 原图 <= 256x144 → 小框，否则大框；尺寸未知 → 大框（small 模式除外）
  function getFrameConfig(info) {
    var mode = 'large';
    var width = LARGE_W;
    var height = LARGE_H;
    var fsm = _frameSizeMode();

    if (!info || !info.width || !info.height) {
      if (fsm === 'small') { mode = 'small'; width = SMALL_W; height = SMALL_H; }
    } else {
      if (fsm === 'small') { mode = 'small'; width = SMALL_W; height = SMALL_H; }
      else if (fsm === 'large') { mode = 'large'; width = LARGE_W; height = LARGE_H; }
      else {
        if (info.width <= SMALL_W && info.height <= SMALL_H) {
          mode = 'small'; width = SMALL_W; height = SMALL_H;
        }
      }
    }
    return { mode: mode, width: width, height: height };
  }

  // ═══ 棋盘格 + 底色（老 buildAfterStyle 口径：conic 20px + 底色）═══
  //   kind='text' → 底色满幅：文本胶片不留棋盘格缝（用户口径「在格子上填底色」要盖满）
  function _bgCss(kind) {
    var s = 'background-color:' + _bgColor() + ';';
    if (kind === 'text') return s;
    return s +
      'background-image:conic-gradient(' + CHECKER_A + ' 0.25turn,' + CHECKER_B + ' 0.25turn 0.5turn,' +
      CHECKER_A + ' 0.5turn 0.75turn,' + CHECKER_B + ' 0.75turn);' +
      'background-size:20px 20px;';
  }

  // ═══ 点击 → 打开文件（老 hover「Open file」语义；OS 默认程序）═══
  //   桥路径唯一：bridge.shell.openPath（qqqide:shell:openPath，win32 走 cmd 短命 relay）
  function _bindClick(root, entry) {
    if (!root || !entry || !entry.path) return;
    root.style.cursor = 'pointer';
    root.title = entry.fileName || '';
    root.addEventListener('click', function () {
      try {
        var sh = bridge && bridge.shell;
        if (sh && sh.openPath) { sh.openPath(entry.path); return; }
        if (sh && sh.openExternal) {
          sh.openExternal('file:///' + String(entry.path).replace(/\\/g, '/'));
        }
      } catch (e) { /* */ }
    });
  }

  // ═══ 帧外壳（媒体/文本/图标三族共用几何）═══
  function _buildShell(entry, opts) {
    var pw = opts.pw;
    var ph = opts.ph;

    var root = document.createElement('div');
    root.className = 'qqq-frame qqq-frame-' + opts.kind;
    root.style.cssText = 'display:inline-block;margin:4px 0;';

    var box = document.createElement('div');
    box.className = 'qqq-frame-box';
    box.style.cssText =
      'position:relative;box-sizing:border-box;' +
      'width:' + (pw + OUT_PAD) + 'px;height:' + (ph + OUT_PAD) + 'px;' +
      'padding:2px;border:1px dashed #888;' + _bgCss(opts.kind);
    root.appendChild(box);

    var img = document.createElement('img');
    img.className = 'qqq-frame-img';
    img.alt = entry.fileName || '';
    img.draggable = false;
    img.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:block;';
    box.appendChild(img);

    // 进度条（optmum 专属；老 createProgressSvg 一层——黑底 4px + 米色扫过）
    var pbar = document.createElement('div');
    pbar.className = 'qqq-frame-pbar';
    pbar.style.width = pw + 'px';
    var pfill = document.createElement('div');
    pfill.className = 'qqq-frame-pbar-fill';
    pbar.appendChild(pfill);
    box.appendChild(pbar);

    // 水印（老：仅精确命中大/小框尺寸时贴对应水印）
    if (!_removeWatermark && ((pw === LARGE_W && ph === LARGE_H) || (pw === SMALL_W && ph === SMALL_H))) {
      var wm = document.createElement('img');
      wm.className = 'qqq-frame-wm';
      wm.draggable = false;
      wm.src = (pw === LARGE_W) ? WM_LARGE : WM_SMALL;
      wm.onerror = function () { try { wm.style.display = 'none'; } catch (e) { /* */ } };
      box.appendChild(wm);
      root._wmEl = wm;
    }

    root._boxEl = box;
    root._imgEl = img;
    root._pbarEl = pbar;
    root._pfillEl = pfill;
    root._pw = pw;
    root._ph = ph;
    root._zoneH = ph + OUT_PAD + 8;   // 视口机器 ViewZone 高度（+ 上下各 4px 外边距）
    _bindClick(root, entry);
    return root;
  }

  function _showProgressBar(frameDom, duration) {
    var bar = frameDom && frameDom._pbarEl;
    var fill = frameDom && frameDom._pfillEl;
    if (!bar || !fill) return;
    var d = Number(duration) || 0;
    if (!(d > 0.1)) return;
    d = Math.max(0.2, Math.min(600, d));
    fill.style.animationDuration = d.toFixed(3) + 's';
    bar.classList.add('qqq-pbar-on');
  }

  // ═══ 图像落地（fit 模式：老 outputSize 语义；natural/fill 备选）═══
  function _setMediaSrc(dom, filePath, mode, natW, natH, onFail) {
    var img = dom && dom._imgEl;
    if (!img) return;
    img.onload = function () {
      var nw = natW || img.naturalWidth || 0;
      var nh = natH || img.naturalHeight || 0;
      if (mode === 'fill') {
        img.style.width = dom._pw + 'px';
        img.style.height = dom._ph + 'px';
        return;
      }
      if (mode === 'natural') {
        img.style.width = (nw || dom._pw) + 'px';
        img.style.height = (nh || dom._ph) + 'px';
        return;
      }
      var fit = fitIntoBox(nw, nh, dom._pw, dom._ph, _enlarge());
      img.style.width = fit.width + 'px';
      img.style.height = fit.height + 'px';
    };
    img.onerror = function () { if (onFail) { try { onFail(); } catch (e) { /* */ } } };
    img.src = _fileUrl(filePath);
  }

  // ═══ 媒体信息探测（dims/duration/size）═══
  var _infoMemo = {};
  async function probeMediaInfo(filePath) {
    if (!filePath) return null;
    var k = String(filePath).replace(/\\/g, '/');
    if (Object.prototype.hasOwnProperty.call(_infoMemo, k)) return _infoMemo[k];
    var out = null;
    try {
      if (bridge && bridge.media && bridge.media.probe) {
        var r = await bridge.media.probe(filePath);
        if (r && r.ok) {
          out = { width: r.width || 0, height: r.height || 0, duration: r.duration || 0, codec: r.codec || '' };
        }
      }
    } catch (e) { out = null; }
    if (out) {
      try {
        var st = await bridge.fs.stat(filePath);
        if (st && st.size) out.size = st.size;
      } catch (e) { /* */ }
    }
    _infoMemo[k] = out;
    return out;
  }

  // ═══ 原生文件图标（老 extract_icon → Electron app.getFileIcon）═══
  var _iconMemo = {};
  async function _fetchIcon(filePath) {
    if (!filePath) return null;
    var k = String(filePath).replace(/\\/g, '/');
    if (Object.prototype.hasOwnProperty.call(_iconMemo, k)) return _iconMemo[k];
    var out = null;
    try {
      if (bridge && bridge.fs && bridge.fs.fileIcon) {
        var r = await bridge.fs.fileIcon(filePath);
        if (r && r.ok && r.dataUrl) out = r.dataUrl;
      }
    } catch (e) { out = null; }
    _iconMemo[k] = out;
    return out;
  }

  function _glyphFor(entry, isDir) {
    if (isDir) return '\uD83D\uDCC1';
    var ext = extOf(entry && entry.fileName);
    if (AUDIO_EXTS[ext]) return '\uD83C\uDFB5';
    return '\uD83D\uDCC4';
  }

  // ═══ 图标帧体（几何重设为 32x32 内容框）═══
  async function _applyIconBody(dom, entry, isDir) {
    if (!dom || !dom._boxEl) return false;
    dom._pw = ICON_SIZE;
    dom._ph = ICON_SIZE;
    dom._boxEl.style.width = (ICON_SIZE + OUT_PAD) + 'px';
    dom._boxEl.style.height = (ICON_SIZE + OUT_PAD) + 'px';
    if (dom._pbarEl) { dom._pbarEl.style.display = 'none'; }
    if (dom._wmEl) { dom._wmEl.style.display = 'none'; }

    // 文本胶片降级为图标帧 → 底色恢复棋盘格（防「满幅纸面」样式残留）
    try {
      dom._boxEl.style.backgroundImage = 'conic-gradient(' + CHECKER_A + ' 0.25turn,' + CHECKER_B + ' 0.25turn 0.5turn,' + CHECKER_A + ' 0.5turn 0.75turn,' + CHECKER_B + ' 0.75turn)';
      dom._boxEl.style.backgroundSize = '20px 20px';
    } catch (_ebg) { /* */ }

    if (dom._isIcon) return true;   // 幂等（防重复调用叠字形）
    var iconUrl = await _fetchIcon(entry.path);
    var img = dom._imgEl;
    if (iconUrl) {
      img.style.width = ICON_SIZE + 'px';
      img.style.height = ICON_SIZE + 'px';
      img.src = iconUrl;
    } else if (img) {
      // 壳层未重启（fileIcon 桥缺失）→ 字形兜底，防止空框
      img.style.display = 'none';
      var g = document.createElement('span');
      g.textContent = _glyphFor(entry, !!isDir);
      g.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:22px;line-height:1;';
      dom._boxEl.appendChild(g);
    }
    dom._zoneH = ICON_SIZE + OUT_PAD + 8;
    dom._isIcon = true;
    if (typeof dom._requestResize === 'function') {
      try { dom._requestResize(); } catch (e) { /* */ }
    }
    return true;
  }

  // 媒体预览失败 → 降级为图标帧（老语义：ffmpeg 解析不了 → 图标框）
  async function _swapToIcon(dom, entry) {
    var isDir = false;
    try {
      var st = entry && entry.path ? await bridge.fs.stat(entry.path) : null;
      isDir = !!(st && (st.isDirectory || st.isDir));
    } catch (e) { /* */ }
    return await _applyIconBody(dom, entry, isDir);
  }

  // ═══ 异步内容加载：媒体帧 ═══
  // 判定「handler 不存在」（壳层未重启；preload 已更新而主进程未重启时 invoke 拒绝）
  function _isNoHandler(e) {
    return !!(e && String(e.message || e).indexOf('No handler registered') >= 0);
  }

  async function _loadMediaContent(dom, entry, info) {
    var perf = _perfMode();
    var hasBridge = !!(bridge && bridge.media && bridge.media.preview);
    var res = null;
    var noHandler = false;
    try {
      if (hasBridge) { res = await bridge.media.preview({ src: entry.path, mode: perf }); }
    } catch (e) { res = null; noHandler = _isNoHandler(e); }

    if (res && res.ok && res.path) {
      _setMediaSrc(dom, res.path, 'fit', res.width, res.height);
      // 进度条：老口径 webpDuration > 0.1 且 optmum 才显示
      if (perf === 'optmum' && res.duration > 0.1) { _showProgressBar(dom, res.duration); }
      return;
    }
    // 壳层未重启（preview 桥缺失 / handler 缺失）→ 退回直显原文件（老直读语义；绝不让媒体全变图标框）
    if (!hasBridge || noHandler) {
      _setMediaSrc(dom, entry.path, 'fit', info && info.width, info && info.height, function () {
        _swapToIcon(dom, entry);   // 浏览器原生解码不了（如 AVI）→ 退回图标帧，不留空框
      });
      return;
    }
    // 预览生成失败（ffmpeg 缺失/源损坏）→ 老语义：图标帧
    await _swapToIcon(dom, entry);
  }

  // ═══ 文本胶片（老 generateTextPreview → 壳层 drawtext；失败降级图标帧）═══
  async function _loadTextContent(dom, entry) {
    var res = null;
    try {
      if (bridge && bridge.media && bridge.media.textPreview) {
        res = await bridge.media.textPreview({
          src: entry.path,
          scheme: _textScheme(),
          fontSize: _textFontSize(),
        });
      }
    } catch (e) { res = null; }
    if (res && res.ok && res.path) {
      _setMediaSrc(dom, res.path, 'natural', res.width, res.height);
      return;
    }
    await _swapToIcon(dom, entry);
  }

  // ═══ 文本探测（老 isPlainTextFile 全语义移植：扩展名白名单 → 8KB 头部嗅探 → 二进制签名）═══
  //   老口径三段判：① 空字节 → 非文本 ② 控制字符 >10% → 非文本 ③ 头部魔数命中二进制签名 → 非文本
  var BINARY_SIGS = [
    '89504e47',                                                          // PNG
    'ffd8ffe0', 'ffd8ffe1', 'ffd8ffe2', 'ffd8ffdb', 'ffd8ffee',          // JPEG
    '47494638',                                                          // GIF
    '52494646',                                                          // RIFF (WebP/AVI/WAV)
    '504b0304',                                                          // ZIP/DOCX/XLSX
    '25504446',                                                          // PDF
    '7f454c46',                                                          // ELF
    '4d5a9000', '4d5a5000', '4d5a0000',                                  // PE/MZ
    'cafebabe',                                                          // Java class
    'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe',                      // Mach-O
  ];
  var _textMemo = {};

  // 头部字节（优先壳层 fs.readHead：只读前 N 字节，200MB 文件零负担；
  // 壳层未重启时回退 readBase64 首段，仅限 ≤2MB 文件）
  async function _readHeadBytes(filePath, maxBytes) {
    var base64 = '';
    try {
      if (bridge && bridge.fs && bridge.fs.readHead) {
        try {
          var r = await bridge.fs.readHead(filePath, maxBytes);
          if (r && r.ok && r.base64) base64 = r.base64;
        } catch (e1) { /* handler 缺失（壳层未重启）→ 走下方 readBase64 兜底 */ }
      }
      if (!base64 && bridge && bridge.fs && bridge.fs.readBase64) {
        var st = await bridge.fs.stat(filePath);
        if (!st || !(st.size > 0) || st.size > 2 * 1024 * 1024) return null;
        var full = await bridge.fs.readBase64(filePath);
        if (full) {
          var keep = Math.floor((maxBytes * 4) / 3 / 4) * 4;
          base64 = full.length > keep ? full.slice(0, keep) : full;
        }
      }
    } catch (e) { return null; }
    if (!base64) return null;
    try {
      var bin = atob(base64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xFF;
      return out;
    } catch (e2) { return null; }
  }

  async function _looksLikeText(filePath, ext) {
    if (TEXT_EXTS[ext]) return true;
    if (IMAGE_EXTS[ext] || VIDEO_EXTS[ext] || AUDIO_EXTS[ext]) return false;
    if (!filePath) return false;
    var k = String(filePath).replace(/\\/g, '/');
    if (Object.prototype.hasOwnProperty.call(_textMemo, k)) return _textMemo[k];
    var verdict = false;
    try {
      var head = await _readHeadBytes(filePath, 8192);
      if (head === null) {
        verdict = false;                       // 读不到（不存在/权限）→ 非文本（后续降级图标帧）
      } else if (head.length === 0) {
        verdict = true;                        // 空文件 = 文本（老语义）
      } else {
        var nulls = 0, ctrl = 0;
        for (var i = 0; i < head.length; i++) {
          var c = head[i];
          if (c === 0) nulls++;
          else if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
        }
        if (nulls > 0) verdict = false;
        else if (ctrl > head.length * 0.1) verdict = false;
        else if (head.length >= 4) {
          var hex = '';
          for (var j = 0; j < 4; j++) hex += ('0' + head[j].toString(16)).slice(-2);
          verdict = BINARY_SIGS.indexOf(hex) < 0;
        } else verdict = true;
      }
    } catch (e) { verdict = false; }
    _textMemo[k] = verdict;
    return verdict;
  }

  // ═══ 类型解析（老 renderImages 分流语义）═══
  function _resolveType(entry) {
    var ext = extOf(entry && entry.fileName);
    if (entry && entry.type === 'directory') return 'dir';
    if (IMAGE_EXTS[ext]) return 'image';
    if (VIDEO_EXTS[ext]) return 'video';
    if (AUDIO_EXTS[ext]) return 'audio';
    return 'file';
  }

  // ═══ 帧构建入口（异步；返回的 DOM 自带 _zoneH）═══

  async function _buildMediaFrame(entry, type) {
    var info = await probeMediaInfo(entry.path);
    var ext = extOf(entry.fileName);

    if ((!info || !info.width || !info.height) && !BROWSER_NATIVE[ext]) {
      // 老语义：ffmpeg 解析不了 → 图标帧
      var domIcon = _buildShell(entry, { pw: ICON_SIZE, ph: ICON_SIZE, kind: 'icon' });
      await _applyIconBody(domIcon, entry, false);
      return domIcon;
    }

    var cfg = getFrameConfig(info);
    var dom = _buildShell(entry, { pw: cfg.width, ph: cfg.height, kind: type });
    dom._info = info;
    _loadMediaContent(dom, entry, info).catch(function () { /* 已内部降级 */ });
    return dom;
  }

  async function _buildTextFilmFrame(entry) {
    var cfg = getFrameConfig(null);
    var dom = _buildShell(entry, { pw: cfg.width, ph: cfg.height, kind: 'text' });
    _loadTextContent(dom, entry).catch(function () { /* 已内部降级 */ });
    return dom;
  }

  async function _buildIconFrame(entry, isDir) {
    var dom = _buildShell(entry, { pw: ICON_SIZE, ph: ICON_SIZE, kind: 'icon' });
    await _applyIconBody(dom, entry, isDir);
    return dom;
  }

  async function buildFrame(entry) {
    if (!entry || !entry.path) return null;   // 路径未解析 → 不建帧（自愈后重扫会补上）
    var type = _resolveType(entry);

    if (type === 'image' || type === 'video') {
      return await _buildMediaFrame(entry, type);
    }
    if (type === 'audio') {
      return await _buildIconFrame(entry, false);
    }
    if (type === 'dir') {
      return await _buildIconFrame(entry, true);
    }
    // file：目录定先（folder 图标）；已知文本扩展名 → 文本胶片；未知 → 按内容判（老 isPlainTextFile）
    var st = null;
    try { st = await bridge.fs.stat(entry.path); } catch (e) { /* */ }
    if (st && (st.isDir || st.isDirectory)) {
      return await _buildIconFrame(entry, true);
    }
    var ext = extOf(entry.fileName);
    if (await _looksLikeText(entry.path, ext)) {
      return await _buildTextFilmFrame(entry);
    }
    return await _buildIconFrame(entry, false);
  }

  // ═══ memo 失效（viewport mtime 校验发现源文件变更 → 帧重建前调用）═══
  function invalidateMemo(p) {
    if (!p) return;
    var k = String(p).replace(/\\/g, '/');
    delete _infoMemo[k];
    delete _iconMemo[k];
    delete _textMemo[k];
  }

  // ═══ Public API ═══

  window.qqqFrameRenderer = {
    buildFrame: buildFrame,
    invalidateMemo: invalidateMemo,
    getFrameConfig: getFrameConfig,
    fitIntoBox: fitIntoBox,
    probeMediaInfo: probeMediaInfo,
    // ★ codelens 按钮机器消费（qqq-codelens.js）：类型判定与文本探针（老 isPlainTextFile 三段语义同源）
    classifyExt: function (ext) {
      var e = String(ext || '').toLowerCase();
      if (IMAGE_EXTS[e]) return 'image';
      if (VIDEO_EXTS[e]) return 'video';
      if (AUDIO_EXTS[e]) return 'audio';
      return 'file';
    },
    isTextExt: function (ext) { return !!TEXT_EXTS[String(ext || '').toLowerCase()]; },
    looksLikeText: _looksLikeText,
    variantKey: variantKey,
    setRemoveWatermark: setRemoveWatermark,
    shouldRemoveWatermark: shouldRemoveWatermark,
    LARGE_W: LARGE_W,
    LARGE_H: LARGE_H,
    SMALL_W: SMALL_W,
    SMALL_H: SMALL_H,
    ICON_SIZE: ICON_SIZE,
    OUT_PAD: OUT_PAD,
  };

})();
