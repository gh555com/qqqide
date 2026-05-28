// ============================================================================
// qqq-paste.js — Paste-everything for Monaco (image / file / path / rich text)
//
// Capabilities (per Task 6 in the plan):
//   - image blob → hash dedupe → cache hit ? reuse : write paste_<ts>_<rand>.<ext>
//                                    to current file's dir (or cache/paste/)
//   - file blob  → hash dedupe → save under same naming rule
//   - rich-text  → keep Monaco's native handling for now (TODO: sniff <img>)
//   - All saved paths are inserted as `/\ <abs-path> \/` tokens.
//
// Multi-editor: window.qqqPaste.attach(ed) — one DOM paste handler per editor.
// ============================================================================

(function () {
  'use strict';

  const bridge = window.qqqBridge;
  const _editorDisposables = new WeakMap(); // editor -> [dispose...]

  const mimeToExt = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
  };

  function pad2(n) { return String(n).padStart(2, '0'); }
  function nowStamp() {
    const n = new Date();
    return n.getFullYear() + pad2(n.getMonth() + 1) + pad2(n.getDate())
      + '_' + pad2(n.getHours()) + pad2(n.getMinutes()) + pad2(n.getSeconds());
  }
  function genName(ext) {
    const rand = Math.random().toString(36).slice(2, 7);
    return 'paste_' + nowStamp() + '_' + rand + ext;
  }

  function blobToArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(blob);
    });
  }
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function getPasteDir(getCurrentFile) {
    const cur = typeof getCurrentFile === 'function' ? getCurrentFile() : (window.qqqEditor && window.qqqEditor.currentFile());
    if (!cur) return null;
    const sep = cur.includes('\\') ? '\\' : '/';
    return cur.slice(0, cur.lastIndexOf(sep));
  }

  // ---- hash dedupe via bridge.hash.buffer + bridge.cache.bucketPath ----
  async function hashDedupedPath(ab, ext) {
    if (!bridge || !bridge.hash || !bridge.hash.buffer || !bridge.cache || !bridge.cache.bucketPath) {
      return null;
    }
    try {
      const base64 = arrayBufferToBase64(ab);
      const h = await bridge.hash.buffer(base64, 'both'); // {xxh64, sha256, size}
      const sig = h && (h.sha256 || h.xxh64);
      if (!sig) return null;
      const cachePath = await bridge.cache.bucketPath('paste', sig + ext);
      // existsSync via bridge.fs.exists
      const exists = await bridge.fs.exists(cachePath);
      return { sig, cachePath, exists, base64 };
    } catch (e) {
      console.warn('[qqq-paste] hash dedupe failed:', e && e.message);
      return null;
    }
  }

  async function saveBlob(ab, ext, dir, opts) {
    // Attempt hash dedupe + reuse from cache/h/paste/<sig>.ext bucket
    const dedupe = await hashDedupedPath(ab, ext);
    if (dedupe && dedupe.exists) {
      console.log('[qqq-paste] cache HIT:', dedupe.cachePath);
      return dedupe.cachePath;
    }
    const base64 = (dedupe && dedupe.base64) || arrayBufferToBase64(ab);

    // 1) Write to cache bucket so subsequent dupes are O(1) HITs.
    if (dedupe && dedupe.cachePath && bridge.fs.writeBase64) {
      try { await bridge.fs.writeBase64(dedupe.cachePath, base64); }
      catch (e) { console.warn('[qqq-paste] cache bucket write failed:', e); }
    }
    // 2) Also place a fresh-named copy in the user-visible dir (or cache only).
    const fileName = (opts && opts.preserveName) || genName(ext);
    if (!dir) {
      // No current file → return the cache bucket path as the canonical location.
      if (dedupe && dedupe.cachePath) return dedupe.cachePath;
      console.warn('[qqq-paste] no target dir and no cache bucket');
      return null;
    }
    const sep = dir.includes('\\') ? '\\' : '/';
    const fullPath = dir + sep + fileName;
    try {
      if (bridge.fs.writeBase64) await bridge.fs.writeBase64(fullPath, base64);
      else await bridge.fs.write(fullPath, base64);
      return fullPath;
    } catch (e) {
      console.error('[qqq-paste] save failed:', e);
      // Cache bucket is still usable
      return dedupe && dedupe.cachePath ? dedupe.cachePath : null;
    }
  }

  // ---- main attach API ----
  function attach(ed, opts) {
    if (!ed) return null;
    const monaco = window.qqqEditor && window.qqqEditor.getMonaco();
    if (!monaco) { setTimeout(() => attach(ed, opts), 300); return null; }

    const getCurrentFile = (opts && opts.getCurrentFile) || (() => window.qqqEditor.currentFile());

    function insertTokenAtCursor(p) {
      const text = '/\\ ' + p + ' \\/\n';
      try {
        const sel = ed.getSelection();
        ed.executeEdits('qqq-paste', [{ range: sel, text, forceMoveMarkers: true }]);
        ed.focus();
      } catch (e) {
        console.warn('[qqq-paste] insert failed:', e);
      }
    }

    const handler = async function (e) {
      const cb = e.clipboardData;
      if (!cb) return;
      const items = cb.items;
      if (!items || items.length === 0) return;

      // 1) Path/text paste: detect if clipboard is a single absolute path → token it.
      // Only when no files are present (else file path triggers via items.kind==='file').
      let hasFile = false;
      for (let i = 0; i < items.length; i++) { if (items[i].kind === 'file') { hasFile = true; break; } }
      if (!hasFile) {
        const txt = cb.getData('text/plain') || '';
        const trimmed = txt.trim();
        const looksLikePath = /^([A-Za-z]:[\\/].+|\/[^\s]+)$/.test(trimmed) && !trimmed.includes('\n');
        if (looksLikePath && !trimmed.startsWith('http')) {
          e.preventDefault();
          e.stopPropagation();
          insertTokenAtCursor(trimmed);
          return;
        }
        return; // let Monaco do its normal text/rich-text paste
      }

      // 2) Image paste (preferred over generic file)
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
          e.preventDefault();
          e.stopPropagation();
          const blob = it.getAsFile();
          if (!blob) return;
          const ext = mimeToExt[blob.type] || '.png';
          const dir = getPasteDir(getCurrentFile);
          const ab = await blobToArrayBuffer(blob);
          const saved = await saveBlob(ab, ext, dir);
          if (saved) insertTokenAtCursor(saved);
          return;
        }
      }

      // 3) Generic file paste
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && (!it.type || !it.type.startsWith('image/'))) {
          e.preventDefault();
          e.stopPropagation();
          const file = it.getAsFile();
          if (!file) return;
          const ext = (file.name && file.name.indexOf('.') >= 0)
            ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
            : '.bin';
          const dir = getPasteDir(getCurrentFile);
          const ab = await blobToArrayBuffer(file);
          const saved = await saveBlob(ab, ext, dir, { preserveName: file.name });
          if (saved) insertTokenAtCursor(saved);
          return;
        }
      }
    };

    const domNode = ed.getDomNode();
    if (!domNode) { setTimeout(() => attach(ed, opts), 200); return null; }
    domNode.addEventListener('paste', handler, true);
    const dispose = () => { try { domNode.removeEventListener('paste', handler, true); } catch {} };
    _editorDisposables.set(ed, [{ dispose }]);
    console.log('[qqq-paste] attached');
    return { dispose };
  }

  function init() {
    const ed = window.qqqEditor && window.qqqEditor.getEditorInstance();
    if (!ed) { setTimeout(init, 400); return; }
    attach(ed);
  }

  function dispose() {
    // Best-effort cleanup of all attached editors handled by WeakMap GC.
  }

  window.qqqPaste = { init, attach, dispose };

  // rage service protocol
  window.qqqRagePaste = {
    start: function (ctx) { init(); },
    stop: function () { dispose(); },
  };
})();
