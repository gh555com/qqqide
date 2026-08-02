// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qoods/paste-image/paste-image.js
// Listens for Ctrl+V (and `paste` events) on the document. If the clipboard
// has an image, save it next to the active editor file and insert a markdown
// reference at the cursor.
// ============================================================================

(function () {
  'use strict';
  if (!globalThis.qoods) { console.warn('[paste-image] qoods shim missing'); return; }

  const Q = globalThis.qoods;

  function tsName() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return 'paste_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.png';
  }

  function dataUrlToBytes(dataUrl) {
    const i = dataUrl.indexOf(','); if (i < 0) { return null; }
    const b64 = dataUrl.slice(i + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) { bytes[j] = bin.charCodeAt(j); }
    return bytes;
  }

  function bytesToBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) { s += String.fromCharCode(u8[i]); }
    return btoa(s);
  }

  function dirOf(p) { return (p || '').replace(/[\\/][^\\/]+$/, ''); }

  async function saveImageBytes(activeFile, u8) {
    const dir = dirOf(activeFile) || (Q.bridge && (await Q.bridge.boot.getInfo()).appRoot) || '.';
    const sep = (activeFile && activeFile.indexOf('\\') >= 0) ? '\\' : '/';
    const name = tsName();
    const fullPath = dir + sep + name;
    // Write as base64 string with a special marker; engines.fs.write handles raw text.
    // Engineers wishing for binary writes should add fs.writeBinary later.
    // For now we write base64-encoded payload prefixed with "BASE64:" so the user
    // can decode externally; if the engine supports binary we'd swap this to bytes.
    // Most node fs writes via fs.promises.writeFile will accept Buffer; the IPC
    // serializer converts ArrayBuffer/Uint8Array to Buffer. So pass raw buffer.
    try {
      // try direct binary path: qqq:fs:write accepts Buffer-like
      await Q.workspace.fs.writeFile(Q.Uri.file(fullPath), u8);
    } catch (e) {
      // fallback: write base64 with marker
      const b64 = 'BASE64:' + bytesToBase64(u8);
      await Q.bridge.fs.write(fullPath, b64);
    }
    return { path: fullPath, name: name };
  }

  async function handlePaste(evt) {
    // ★ 如果新版 paste-router 已挂载，跳过此旧处理器（避免双重保存）
    if (window.qqqPasteRouter && window.qqqPasteRouter.isActive && window.qqqPasteRouter.isActive()) {
      return;
    }
    const cd = evt.clipboardData || window.clipboardData;
    if (!cd) { return; }
    const items = cd.items || [];
    let blob = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === 'file' && /^image\//.test(it.type || '')) {
        blob = it.getAsFile();
        break;
      }
    }
    if (!blob) { return; }
    evt.preventDefault();

    const buf = await blob.arrayBuffer();
    const u8 = new Uint8Array(buf);

    const editor = window.qqqEditor;
    const activeFile = editor && editor.currentFile && editor.currentFile();
    let target;
    try { target = await saveImageBytes(activeFile || '', u8); }
    catch (e) {
      console.warn('[paste-image] save failed:', e);
      Q.window.showErrorMessage(window._i('goods.pasteImage.saveFailed', '粘贴图片保存失败') + '：' + (e && e.message));
      return;
    }
    Q.emit('paste-image.saved', target);

    // Insert markdown reference if monaco editor is focused and has a file open
    if (editor && editor.insertAtCursor) {
      const rel = target.name; // assume same dir as active file
      editor.insertAtCursor('![](' + rel + ')');
    } else {
      Q.window.showInformationMessage(window._i('goods.pasteImage.saved', '已保存图片到') + ' ' + target.path);
    }
  }

  document.addEventListener('paste', handlePaste, true);

  Q.commands.register('paste-image.paste', () => {
    Q.window.showInformationMessage('请使用 Ctrl+V 粘贴图片');
  });

  // [silent] paste-image ready
})();
