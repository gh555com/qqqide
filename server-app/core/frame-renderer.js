// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// frame-renderer.js — WYSIWYG frame + icon-frame rendering engine
// Ported from q3 q1.js core algorithms, using real DOM (Monaco ContentWidget).
// Old q3 used CSS background-image layering due to VS Code decoration limits;
// new architecture builds real DOM — easier to debug, interactive, supports loading states.
//
// Frame types:
//   Media frames: image, video, text-film, audio
//   Icon frames:  file icon, directory icon
//
// Exposes: window.qqqFrameRenderer
// Depends: qqqThumbnailCache, bridge.fs, bridge.media
// ============================================================================

(function () {
  'use strict';

  var bridge = window.qqqideBridge;
  var thumbCache = window.qqqThumbnailCache;

  // ═══ Constants (from q3 q1.js) ═══
  var LARGE_W = 512, LARGE_H = 288;
  var SMALL_W = 256, SMALL_H = 144;
  var BORDER_W = 6;
  var BG_LIGHT = '#fef6e3';
  var BG_DARK = '#1a1a1a';
  var CHECKER_LIGHT = '#e6e1cf';
  var CHECKER_DARK = '#333';
  var TEXT_FONT_SIZE = 12;

  // Ext sets
  var IMG_EXTS = { '.png':1,'.jpg':1,'.jpeg':1,'.gif':1,'.bmp':1,'.webp':1,'.svg':1,'.ico':1,'.tiff':1,'.avif':1 };
  var VID_EXTS = { '.mp4':1,'.mkv':1,'.avi':1,'.mov':1,'.webm':1,'.flv':1,'.wmv':1,'.m4v':1,'.ts':1,'.mpg':1 };
  var AUD_EXTS = { '.mp3':1,'.wav':1,'.flac':1,'.ogg':1,'.m4a':1,'.aac':1,'.wma':1,'.opus':1 };
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

  // ═══ fitIntoBox — from q3 q1.js exactly ═══
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

  // ═══ Checkerboard background ═══
  function _checkerCss(light, dark) {
    var a = light || CHECKER_LIGHT;
    var b = dark || BG_LIGHT;
    return 'background-image:conic-gradient(' + a + ' 0.25turn,' + b + ' 0.25turn 0.5turn,' + a + ' 0.5turn 0.75turn,' + b + ' 0.75turn);background-size:20px 20px;';
  }

  // ═══ Utility ═══
  function _fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function _fmtDuration(sec) {
    if (!sec && sec !== 0) return '';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }
    return m + ':' + String(s).padStart(2,'0');
  }

  function _fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
  }

  // ═══ File stat cache ═══
  var _statCache = {};
  async function _statFile(filePath) {
    if (!filePath) return null;
    var np = filePath.replace(/\\/g, '/');
    if (_statCache[np]) return _statCache[np];
    if (!bridge || !bridge.fs || !bridge.fs.stat) return null;
    try {
      var st = await bridge.fs.stat(filePath);
      if (st) _statCache[np] = st;
      return st;
    } catch (e) { return null; }
  }

  // ═══ Icon emoji by type ═══
  function _iconForFile(name, isDir) {
    if (isDir) return '\uD83D\uDCC1';
    var ext = extOf(name);
    if (IMG_EXTS[ext]) return '\uD83D\uDDBC';
    if (VID_EXTS[ext]) return '\uD83C\uDFAC';
    if (AUD_EXTS[ext]) return '\uD83C\uDFB5';
    if (TEXT_EXTS[ext]) return '\uD83D\uDCC4';
    if (ext === '.zip' || ext === '.rar' || ext === '.7z' || ext === '.tar' || ext === '.gz') return '\uD83D\uDCE6';
    if (ext === '.pdf') return '\uD83D\uDCD5';
    if (ext === '.exe' || ext === '.dll' || ext === '.msi') return '\u2699';
    return '\uD83D\uDCC4';
  }

  function _colorForType(name, isDir) {
    if (isDir) return '#b58900';
    var ext = extOf(name);
    if (IMG_EXTS[ext]) return '#2aa198';
    if (VID_EXTS[ext]) return '#d33682';
    if (AUD_EXTS[ext]) return '#6c71c4';
    if (TEXT_EXTS[ext]) return '#268bd2';
    return '#839496';
  }

  // ═══ Click handler — open file ═══
  function _bindClick(root, entry) {
    if (!root || !entry || !entry.path) return;
    root.style.cursor = 'pointer';
    root.addEventListener('click', function () {
      if (bridge && bridge.fs && bridge.fs.openExternal) {
        bridge.fs.openExternal(entry.path).catch(function () {});
      }
    });
  }

  // ═══ Image Frame ═══
  function buildImageFrame(entry, opts) {
    opts = opts || {};
    var mode = opts.mode || 'large';
    var boxW = mode === 'large' ? LARGE_W : SMALL_W;
    var boxH = mode === 'large' ? LARGE_H : SMALL_H;
    var info = opts.info || null;

    var root = document.createElement('div');
    root.className = 'qqq-frame qqq-frame-image';
    root.style.cssText = 'display:inline-block;margin:4px 0;';

    var bg = document.createElement('div');
    bg.className = 'qqq-frame-bg';
    bg.style.cssText =
      _checkerCss(CHECKER_LIGHT, BG_LIGHT) +
      'width:' + boxW + 'px;height:' + boxH + 'px;' +
      'display:flex;align-items:center;justify-content:center;' +
      'border:1px dashed #888;padding:2px;position:relative;';
    root.appendChild(bg);

    var img = document.createElement('img');
    img.className = 'qqq-frame-thumb';
    img.alt = entry.fileName || '';
    img.title = (entry.fileName || '') + ' | Click to open | Space for info';
    img.style.cssText = 'display:block;';

    if (info && info.width && info.height) {
      var fit = fitIntoBox(info.width, info.height, boxW - BORDER_W, boxH - BORDER_W, false);
      img.style.maxWidth = fit.width + 'px';
      img.style.maxHeight = fit.height + 'px';
      img.style.width = 'auto';
      img.style.height = 'auto';
    } else {
      img.style.maxWidth = (boxW - BORDER_W) + 'px';
      img.style.maxHeight = (boxH - BORDER_W) + 'px';
    }
    bg.appendChild(img);

    var meta = document.createElement('div');
    meta.className = 'qqq-frame-meta';
    meta.style.cssText = 'font-size:11px;line-height:1.4;margin-top:2px;color:#888;text-align:center;';
    var parts = [entry.fileName || ''];
    if (info && info.width && info.height) parts.push(info.width + 'x' + info.height);
    if (info && info.size) parts.push(_fmtSize(info.size));
    meta.textContent = parts.join(' \u00B7 ');
    root.appendChild(meta);

    root._imgEl = img;
    root._bgEl = bg;
    root._metaEl = meta;
    root._boxW = boxW;
    root._boxH = boxH;

    _bindClick(root, entry);
    return root;
  }

  // ═══ Video Frame ═══
  function buildVideoFrame(entry, opts) {
    opts = opts || {};
    var mode = opts.mode || 'large';
    var boxW = mode === 'large' ? LARGE_W : SMALL_W;
    var boxH = mode === 'large' ? LARGE_H : SMALL_H;
    var info = opts.info || null;

    var root = document.createElement('div');
    root.className = 'qqq-frame qqq-frame-video';
    root.style.cssText = 'display:inline-block;margin:4px 0;';

    var bg = document.createElement('div');
    bg.className = 'qqq-frame-bg';
    bg.style.cssText =
      _checkerCss(CHECKER_DARK, BG_DARK) +
      'width:' + boxW + 'px;height:' + boxH + 'px;' +
      'display:flex;align-items:center;justify-content:center;' +
      'border:1px dashed #666;padding:2px;position:relative;';
    root.appendChild(bg);

    var img = document.createElement('img');
    img.className = 'qqq-frame-thumb';
    img.alt = entry.fileName || '';
    img.title = (entry.fileName || '') + ' | Click to play | Space for info';
    img.style.cssText = 'display:block;';
    if (info && info.width && info.height) {
      var fit = fitIntoBox(info.width, info.height, boxW - BORDER_W, boxH - BORDER_W, false);
      img.style.maxWidth = fit.width + 'px';
      img.style.maxHeight = fit.height + 'px';
    } else {
      img.style.maxWidth = (boxW - BORDER_W) + 'px';
      img.style.maxHeight = (boxH - BORDER_W) + 'px';
    }
    bg.appendChild(img);

    var play = document.createElement('span');
    play.className = 'qqq-frame-play';
    play.textContent = '\u25B6';
    play.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'font-size:36px;color:rgba(255,255,255,0.85);pointer-events:none;' +
      'text-shadow:0 0 8px rgba(0,0,0,0.6);z-index:1;';
    bg.appendChild(play);

    var meta = document.createElement('div');
    meta.className = 'qqq-frame-meta';
    meta.style.cssText = 'font-size:11px;line-height:1.4;margin-top:2px;color:#888;text-align:center;';
    var parts = ['\uD83C\uDFAC ' + (entry.fileName || '')];
    if (info && info.width && info.height) parts.push(info.width + 'x' + info.height);
    if (info && info.duration) parts.push(_fmtDuration(info.duration));
    if (info && info.size) parts.push(_fmtSize(info.size));
    meta.textContent = parts.join(' \u00B7 ');
    root.appendChild(meta);

    root._imgEl = img;
    root._bgEl = bg;
    root._metaEl = meta;
    root._boxW = boxW;
    root._boxH = boxH;

    _bindClick(root, entry);
    return root;
  }

  // ═══ Text Film Frame ═══
  function buildTextFilmFrame(entry, opts) {
    opts = opts || {};
    var mode = opts.mode || 'large';
    var boxW = mode === 'large' ? 514 : 257;
    var boxH = mode === 'large' ? 290 : 145;
    var previewText = opts.previewText || '';

    var root = document.createElement('div');
    root.className = 'qqq-frame qqq-frame-textfilm';
    root.style.cssText = 'display:inline-block;margin:4px 0;';

    var pre = document.createElement('pre');
    pre.className = 'qqq-frame-textpre';
    pre.style.cssText =
      'width:' + boxW + 'px;height:' + boxH + 'px;' +
      'overflow:hidden;font-family:Consolas,"Courier New",monospace;' +
      'font-size:' + TEXT_FONT_SIZE + 'px;line-height:1.5;' +
      'border:1px dashed #888;padding:8px;margin:0;' +
      'background:' + BG_LIGHT + ';color:#586e75;' +
      'white-space:pre-wrap;word-wrap:break-word;' +
      'user-select:none;-webkit-user-select:none;';
    pre.textContent = previewText || '(Loading preview...)';
    root.appendChild(pre);

    var meta = document.createElement('div');
    meta.className = 'qqq-frame-meta';
    meta.style.cssText = 'font-size:11px;line-height:1.4;margin-top:2px;color:#888;text-align:center;';
    var info = opts.info || {};
    var parts = ['\uD83D\uDCDD ' + (entry.fileName || '')];
    if (info.lineCount) parts.push(info.lineCount + ' lines');
    if (info.size) parts.push(_fmtSize(info.size));
    meta.textContent = parts.join(' \u00B7 ');
    root.appendChild(meta);

    root._preEl = pre;
    root._metaEl = meta;
    root._boxW = boxW;
    root._boxH = boxH;

    _bindClick(root, entry);
    return root;
  }

  // ═══ Audio Frame ═══
  function buildAudioFrame(entry, opts) {
    opts = opts || {};
    var info = opts.info || {};

    var root = document.createElement('div');
    root.className = 'qqq-frame qqq-frame-audio';
    root.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;padding:6px 10px;' +
      'border:1px dashed #888;border-radius:4px;background:' + BG_LIGHT + ';max-width:512px;';

    var icon = document.createElement('span');
    icon.style.cssText = 'font-size:32px;flex-shrink:0;';
    icon.textContent = '\uD83C\uDFB5';
    root.appendChild(icon);

    var infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'font-size:12px;line-height:1.5;color:#586e75;min-width:0;';
    var lines = [entry.fileName || 'Audio'];
    if (info.duration) lines.push('Duration: ' + _fmtDuration(info.duration));
    if (info.size) lines.push(_fmtSize(info.size));
    if (info.codec) lines.push('Codec: ' + info.codec);
    infoDiv.textContent = lines.join(' \u00B7 ');
    root.appendChild(infoDiv);

    root._metaEl = infoDiv;

    _bindClick(root, entry);
    return root;
  }

  // ═══ File Icon Frame ═══
  function buildFileIconFrame(entry, opts) {
    opts = opts || {};
    var info = opts.info || {};

    var root = document.createElement('div');
    root.className = 'qqq-frame qqq-frame-icon qqq-frame-file';
    root.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;padding:6px 10px;' +
      'border:1px dashed #888;border-radius:4px;background:' + BG_LIGHT + ';max-width:512px;';

    var icon = document.createElement('span');
    icon.style.cssText = 'font-size:28px;flex-shrink:0;';
    icon.textContent = _iconForFile(entry.fileName, false);
    root.appendChild(icon);

    var infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'font-size:12px;line-height:1.5;color:#586e75;min-width:0;';
    var lines = [entry.fileName || 'File'];
    if (info.size) lines.push(_fmtSize(info.size));
    if (info.mtimeMs) lines.push(_fmtDate(info.mtimeMs));
    infoDiv.textContent = lines.join(' \u00B7 ');
    root.appendChild(infoDiv);

    var dot = document.createElement('span');
    dot.style.cssText = 'width:6px;height:6px;border-radius:50%;flex-shrink:0;align-self:flex-start;margin-top:6px;' +
      'background:' + _colorForType(entry.fileName, false) + ';';
    root.appendChild(dot);

    root._metaEl = infoDiv;

    _bindClick(root, entry);
    return root;
  }

  // ═══ Directory Icon Frame ═══
  function buildDirIconFrame(entry, opts) {
    opts = opts || {};
    var info = opts.info || {};

    var root = document.createElement('div');
    root.className = 'qqq-frame qqq-frame-icon qqq-frame-dir';
    root.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;padding:6px 10px;' +
      'border:1px dashed #b58900;border-radius:4px;background:' + BG_LIGHT + ';max-width:512px;';

    var icon = document.createElement('span');
    icon.style.cssText = 'font-size:28px;flex-shrink:0;';
    icon.textContent = '\uD83D\uDCC1';
    root.appendChild(icon);

    var infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'font-size:12px;line-height:1.5;color:#586e75;min-width:0;';
    var lines = [entry.fileName || 'Directory'];
    if (info.fileCount !== undefined) lines.push(info.fileCount + ' files');
    if (info.size) lines.push(_fmtSize(info.size));
    infoDiv.textContent = lines.join(' \u00B7 ');
    root.appendChild(infoDiv);

    root._metaEl = infoDiv;

    _bindClick(root, entry);
    return root;
  }

  // ═══ Async thumbnail loading ═══

  async function loadThumbnail(frameDom, entry) {
    if (!frameDom || !entry || !frameDom._imgEl) return;
    var imgEl = frameDom._imgEl;
    var filePath = entry.path;
    if (!filePath) return;

    var ext = extOf(entry.fileName);
    if (IMG_EXTS[ext] && !VID_EXTS[ext]) {
      var fileUrl = 'file:///' + filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
      imgEl.src = fileUrl;
      imgEl.onerror = function () {
        // ★ F121 加固: 文件名 `_` 变体容错 — 旧格式 token（paste_20260809_110322hg4vt.png）
        //   引用新格式文件（paste_20260809_110322_hg4vt.png）→ 404 破图。exists 校验后切换，零误伤。
        _tryFileNameVariant(filePath, imgEl);
      };
      return;
    }
    _loadViaThumbCache(filePath, imgEl);
  }

  // ★ F121: 文件名 `_` 变体容错 — 双向尝试（去最后一个 `_` / 6位数字+5位随机间补 `_`）
  function _tryFileNameVariant(filePath, imgEl) {
    var variants = [];
    var a = filePath.replace(/_([^_\\/]*)$/, '$1');  // 去最后 `_`（旧格式）
    if (a !== filePath) variants.push(a);
    var b = filePath.replace(/(\d{6})([a-z0-9]{5})(\.\w+)$/, '$1_$2$3');  // 补 `_`（新格式）
    if (b !== filePath && variants.indexOf(b) < 0) variants.push(b);
    var next = function (i) {
      if (i >= variants.length) { _loadViaThumbCache(filePath, imgEl); return; }
      var alt = variants[i];
      if (!bridge || !bridge.fs || !bridge.fs.exists) { _loadViaThumbCache(filePath, imgEl); return; }
      bridge.fs.exists(alt).then(function (ok) {
        if (ok && imgEl) {
          var altUrl = 'file:///' + alt.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
          imgEl.src = altUrl;
        } else {
          next(i + 1);
        }
      }).catch(function () { next(i + 1); });
    };
    next(0);
  }

  function _loadViaThumbCache(filePath, imgEl) {
    if (!thumbCache || !thumbCache.getThumbnail) return;
    thumbCache.getThumbnail(filePath, 'large').then(function (thumbPath) {
      if (thumbPath && imgEl) {
        var thumbUrl = 'file:///' + thumbPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
        imgEl.src = thumbUrl;
      }
    }).catch(function () {});
  }

  // ═══ Async text preview ═══

  async function loadTextPreview(frameDom, entry) {
    if (!frameDom || !entry || !entry.path || !frameDom._preEl) return;
    if (!bridge || !bridge.fs || !bridge.fs.readFile) return;
    try {
      var content = await bridge.fs.readFile(entry.path);
      if (content && frameDom._preEl) {
        // Trim to first ~1500 chars for display
        var preview = typeof content === 'string' ? content : String(content);
        if (preview.length > 1500) preview = preview.slice(0, 1500) + '\n...(truncated)';
        frameDom._preEl.textContent = preview;
      }
    } catch (e) {
      if (frameDom._preEl) {
        frameDom._preEl.textContent = '(Cannot preview)';
      }
    }
  }

  // ═══ Async file info loading ═══

  async function loadFileInfo(frameDom, entry) {
    if (!frameDom || !entry || !entry.path) return;
    var st = await _statFile(entry.path);
    if (!st || !frameDom._metaEl) return;

    var parts = [];
    if (st.size) parts.push(_fmtSize(st.size));
    if (st.mtimeMs) parts.push(_fmtDate(st.mtimeMs));
    var existing = frameDom._metaEl.textContent || '';
    var namePart = existing.split(' \u00B7 ')[0] || '';
    frameDom._metaEl.textContent = [namePart].concat(parts).join(' \u00B7 ');
  }

  // ═══ Media probe ═══

  async function probeMediaInfo(filePath) {
    if (!filePath) return null;
    if (thumbCache && thumbCache.getInfo) {
      try { return await thumbCache.getInfo(filePath); } catch (e) { /* */ }
    }
    if (bridge && bridge.media && bridge.media.probe) {
      try {
        var result = await bridge.media.probe(filePath);
        if (result && result.ok) return result;
      } catch (e) { /* */ }
    }
    return null;
  }

  // ═══ Main entry: build a full frame for an anchor entry ═══

  function buildFrame(entry) {
    if (!entry) return null;

    var type = entry.type;
    var ext = extOf(entry.fileName);
    var isText = TEXT_EXTS[ext];
    var isImg = IMG_EXTS[ext];
    var isVid = VID_EXTS[ext];
    var isAud = AUD_EXTS[ext];

    if (type === 'file' && isImg) type = 'image';
    if (type === 'file' && isVid) type = 'video';
    if (type === 'file' && isAud) type = 'audio';
    if (type === 'file' && isText) type = 'text';

    var frameDom;

    switch (type) {
      case 'image':
        frameDom = buildImageFrame(entry, { mode: 'large' });
        break;
      case 'video':
        frameDom = buildVideoFrame(entry, { mode: 'large' });
        break;
      case 'audio':
        frameDom = buildAudioFrame(entry, {});
        break;
      case 'text':
        frameDom = buildTextFilmFrame(entry, { mode: 'large' });
        break;
      case 'directory':
        frameDom = buildDirIconFrame(entry, {});
        break;
      default:
        frameDom = buildFileIconFrame(entry, {});
        break;
    }

    if (!frameDom) return null;

    // Async: load thumbnail / text preview / file info
    if (type === 'image' || type === 'video') {
      loadThumbnail(frameDom, entry);
      probeMediaInfo(entry.path).then(function (info) {
        if (info && frameDom._metaEl) {
          var parts = [entry.fileName || ''];
          if (info.width && info.height) parts.push(info.width + 'x' + info.height);
          if (info.duration) parts.push(_fmtDuration(info.duration));
          if (info.size) parts.push(_fmtSize(info.size));
          frameDom._metaEl.textContent = parts.join(' \u00B7 ');
        }
      });
    }
    if (type === 'text') {
      loadTextPreview(frameDom, entry);
    }
    if (type === 'file' || type === 'directory') {
      loadFileInfo(frameDom, entry);
    }

    frameDom._entryType = type;
    return frameDom;
  }

  // ═══ Public API ═══

  window.qqqFrameRenderer = {
    fitIntoBox: fitIntoBox,
    buildFrame: buildFrame,
    buildImageFrame: buildImageFrame,
    buildVideoFrame: buildVideoFrame,
    buildTextFilmFrame: buildTextFilmFrame,
    buildAudioFrame: buildAudioFrame,
    buildFileIconFrame: buildFileIconFrame,
    buildDirIconFrame: buildDirIconFrame,
    loadThumbnail: loadThumbnail,
    loadTextPreview: loadTextPreview,
    loadFileInfo: loadFileInfo,
    probeMediaInfo: probeMediaInfo,
    LARGE_W: LARGE_W,
    LARGE_H: LARGE_H,
    SMALL_W: SMALL_W,
    SMALL_H: SMALL_H,
  };

})();
