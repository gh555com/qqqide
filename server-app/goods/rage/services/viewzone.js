// ============================================================================
// qqq-viewzone.js — q1 "相框 / 图标框" WYSIWYG for Monaco
//
// Scans /\ path \/ tokens and renders:
//   - whole-line token  → ViewZone (相框): full image / <video controls>
//   - inline token      → ContentWidget (图标框): 16x16 thumbnail + filename
//
// Thumbnails via bridge.media.thumb({src, w, h}) → cached by content hash.
// Local files served through qqqide-asset://file/<encoded-abs-path>.
//
// Multi-editor: each call to attach(ed) creates an isolated controller.
// ============================================================================

(function () {
  'use strict';

  const bridge = window.qqqideBridge;
  const PATH_REGEX = /\/\\\s*([\s\S]*?)\s*\\\//g;
  const IMAGE_EXT = new Set(['.png','.jpg','.jpeg','.gif','.bmp','.webp','.svg','.ico','.avif']);
  const VIDEO_EXT = new Set(['.mp4','.mkv','.avi','.mov','.webm','.m4v','.ts','.mpg']);
  const AUDIO_EXT = new Set(['.mp3','.wav','.flac','.ogg','.m4a','.aac','.opus']);

  function extOf(p) {
    const i = p.lastIndexOf('.');
    return i < 0 ? '' : p.slice(i).toLowerCase();
  }
  function isImg(e) { return IMAGE_EXT.has(e); }
  function isVid(e) { return VIDEO_EXT.has(e); }
  function isAud(e) { return AUDIO_EXT.has(e); }
  function isMedia(e) { return isImg(e) || isVid(e) || isAud(e); }

  function fileToAssetUrl(absPath) {
    // qqqide-asset://file/<encoded-abs-path>
    // Normalize to forward slashes; preserve the drive letter; encode each segment.
    let p = String(absPath).replace(/\\/g, '/');
    // encodeURI keeps '/' but encodes spaces / non-ascii
    return 'qqqide-asset://file/' + encodeURI(p);
  }

  function resolveAbsPath(rawPath, currentFile) {
    const t = (rawPath || '').trim().replace(/\r?\n/g, '');
    if (!t) return null;
    if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/')) return t;
    if (!currentFile) return null;
    const sep = currentFile.includes('\\') ? '\\' : '/';
    const dir = currentFile.slice(0, currentFile.lastIndexOf(sep));
    return dir + sep + t.replace(/[/\\]/g, sep);
  }

  // ---- shared CSS ----
  function injectStyles() {
    if (document.getElementById('qqq-viewzone-styles')) return;
    const s = document.createElement('style');
    s.id = 'qqq-viewzone-styles';
    s.textContent = `
      .qqq-vz-frame {
        display: flex; align-items: center; justify-content: center;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        margin: 6px 10px;
        padding: 4px;
        overflow: hidden;
        box-sizing: border-box;
      }
      .qqq-vz-frame img,
      .qqq-vz-frame video {
        max-width: 100%; max-height: 100%;
        display: block;
        border-radius: 4px;
      }
      .qqq-vz-frame audio {
        width: 100%; display: block;
      }
      .qqq-vz-frame .qqq-vz-fail {
        padding: 12px;
        font: 12px ui-monospace, Consolas, monospace;
        color: var(--text-secondary);
      }
      .qqq-icon-frame {
        display: inline-flex; align-items: center; gap: 4px;
        height: 18px; vertical-align: middle;
        padding: 0 6px; border-radius: 4px;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        font: 11px ui-monospace, Consolas, monospace;
        line-height: 16px;
        pointer-events: none;
        max-width: 280px;
      }
      .qqq-icon-frame img {
        width: 16px; height: 16px; object-fit: cover;
        border-radius: 2px;
        flex: 0 0 16px;
      }
      .qqq-icon-frame .qqq-icon-name {
        color: var(--text-secondary);
        max-width: 200px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        flex: 0 1 auto;
      }
    `;
    document.head.appendChild(s);
  }

  // ---- thumbnail cache (in-memory; main-process cache lives via bridge.media.thumb) ----
  const _thumbCache = new Map(); // absPath -> Promise<thumbUrl>
  function getThumb(absPath, w, h) {
    const key = absPath + '|' + w + 'x' + h;
    if (_thumbCache.has(key)) return _thumbCache.get(key);
    const p = (async () => {
      try {
        if (!bridge || !bridge.media || !bridge.media.thumb) return null;
        const out = await bridge.media.thumb({ src: absPath, w, h, format: 'jpg', fit: 'cover' });
        if (!out || !out.path) return null;
        return fileToAssetUrl(out.path);
      } catch (e) {
        console.warn('[qqq-viewzone] thumb failed:', absPath, e && e.message);
        return null;
      }
    })();
    _thumbCache.set(key, p);
    return p;
  }

  // ---- per-editor controller ----
  function attach(editor, opts) {
    if (!editor) return null;
    const monaco = window.qqqEditor && window.qqqEditor.getMonaco();
    if (!monaco) {
      setTimeout(() => attach(editor, opts), 300);
      return null;
    }
    injectStyles();

    const currentFileFn = (opts && opts.currentFile) || (() => window.qqqEditor.currentFile());
    let _viewZoneIds = [];   // monaco view zone ids
    let _widgets = [];       // content widgets [{w, id}]
    let _disposed = false;
    let _debounceTimer = null;

    function clearAll() {
      try {
        editor.changeViewZones(acc => { _viewZoneIds.forEach(id => acc.removeZone(id)); });
      } catch { /* editor disposed */ }
      _viewZoneIds = [];
      for (const w of _widgets) {
        try { editor.removeContentWidget(w); } catch { /* ignore */ }
      }
      _widgets = [];
    }

    function buildFrame(absPath, ext) {
      const node = document.createElement('div');
      node.className = 'qqq-vz-frame';
      node.style.height = '180px';
      const url = fileToAssetUrl(absPath);
      if (isImg(ext)) {
        const img = document.createElement('img');
        img.src = url;
        img.onerror = () => {
          node.innerHTML = '<div class="qqq-vz-fail">image not available: ' + absPath + '</div>';
        };
        node.appendChild(img);
      } else if (isVid(ext)) {
        const v = document.createElement('video');
        v.src = url; v.controls = true; v.preload = 'metadata';
        v.style.maxHeight = '100%';
        node.appendChild(v);
      } else if (isAud(ext)) {
        const a = document.createElement('audio');
        a.src = url; a.controls = true; a.style.width = '100%';
        node.appendChild(a);
        node.style.height = '40px';
      } else {
        node.innerHTML = '<div class="qqq-vz-fail">' + absPath + '</div>';
      }
      return node;
    }

    function buildIcon(absPath, ext, name) {
      const node = document.createElement('span');
      node.className = 'qqq-icon-frame';
      const img = document.createElement('img');
      // Use thumb for images/videos; for others, leave placeholder.
      if (isImg(ext) || isVid(ext)) {
        img.alt = ''; node.appendChild(img);
        getThumb(absPath, 32, 32).then(url => {
          if (_disposed) return;
          if (url) img.src = url;
          else node.removeChild(img);
        });
      } else {
        // generic file icon (emoji)
        const ic = document.createElement('span');
        ic.textContent = isAud(ext) ? '🎵' : '📄';
        node.appendChild(ic);
      }
      const label = document.createElement('span');
      label.className = 'qqq-icon-name';
      label.textContent = name;
      node.appendChild(label);
      return node;
    }

    function refresh() {
      if (_disposed) return;
      const model = editor.getModel();
      if (!model) return;
      clearAll();
      const text = model.getValue();
      const re = new RegExp(PATH_REGEX.source, PATH_REGEX.flags);
      let m;
      const currentFile = currentFileFn();

      // We need to plan view zones inside one changeViewZones call
      const pendingZones = []; // {line, height, domNode}
      const pendingIcons = []; // {line, col, absPath, ext, name}

      while ((m = re.exec(text)) !== null) {
        const raw = (m[1] || '').trim();
        if (!raw) continue;
        const abs = resolveAbsPath(raw, currentFile);
        if (!abs) continue;
        const ext = extOf(abs);

        const startOff = m.index;
        const endOff = startOff + m[0].length;
        const startPos = model.getPositionAt(startOff);
        const endPos = model.getPositionAt(endOff);

        const lineNo = startPos.lineNumber;
        const lineContent = model.getLineContent(lineNo);
        // "whole-line" = the token spans the entire line (only whitespace around it
        // on the start line and ends on the same line).
        const beforeStart = lineContent.slice(0, startPos.column - 1).trim();
        const afterEnd = (endPos.lineNumber === lineNo)
          ? lineContent.slice(endPos.column - 1).trim()
          : '';
        const wholeLine = (endPos.lineNumber === lineNo) && !beforeStart && !afterEnd;

        if (wholeLine && isMedia(ext)) {
          // 相框 (only for media; non-media stays as icon)
          const dom = buildFrame(abs, ext);
          const height = isAud(ext) ? 50 : 200;
          pendingZones.push({ line: lineNo, height, domNode: dom });
        } else {
          // 图标框: anchor at end of token
          const name = abs.split(/[\\/]/).pop();
          pendingIcons.push({
            line: endPos.lineNumber,
            col: endPos.column,
            absPath: abs, ext, name,
          });
        }
      }

      // Apply view zones in single batch
      if (pendingZones.length) {
        try {
          editor.changeViewZones(acc => {
            for (const z of pendingZones) {
              const id = acc.addZone({
                afterLineNumber: z.line,
                heightInPx: z.height,
                domNode: z.domNode,
              });
              _viewZoneIds.push(id);
            }
          });
        } catch (e) { console.warn('[qqq-viewzone] changeViewZones:', e); }
      }

      // Apply content widgets
      let widgetSeq = 0;
      for (const ic of pendingIcons) {
        const dom = buildIcon(ic.absPath, ic.ext, ic.name);
        const widgetId = 'qqq-icon-' + (++widgetSeq) + '-' + Date.now();
        const w = {
          getId: () => widgetId,
          getDomNode: () => dom,
          getPosition: () => ({
            position: { lineNumber: ic.line, column: ic.col },
            preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
          }),
        };
        try { editor.addContentWidget(w); _widgets.push(w); }
        catch (e) { console.warn('[qqq-viewzone] addContentWidget:', e); }
      }
    }

    function scheduleRefresh() {
      if (_disposed) return;
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(refresh, 250);
    }

    const d1 = editor.onDidChangeModelContent(scheduleRefresh);
    const d2 = editor.onDidChangeModel(() => { clearAll(); scheduleRefresh(); });

    // initial pass
    setTimeout(refresh, 80);

    const controller = {
      refresh,
      dispose() {
        _disposed = true;
        if (_debounceTimer) clearTimeout(_debounceTimer);
        try { d1.dispose(); } catch {}
        try { d2.dispose(); } catch {}
        clearAll();
      },
    };
    return controller;
  }

  // Backward-compat init() using primary editor.
  function init() {
    const ed = window.qqqEditor && window.qqqEditor.getEditorInstance();
    if (!ed) { setTimeout(init, 400); return; }
    attach(ed);
    console.log('[qqq-viewzone] init (primary editor)');
  }

  window.qqqViewZone = { attach, init };

  // rage service protocol
  window.qqqRageViewzone = {
    start: function (ctx) { init(); },
    stop: function () { /* Monaco ViewZone cleanup */ },
  };
})();
