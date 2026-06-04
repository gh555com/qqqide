// ============================================================================
// goods/_shim.js
// Tiny vscode-API-subset compatibility layer so old qqq extensions can be
// ported with ~30% rewrite. Exposes globalThis.qoods (legacy name kept).
//
// NOT a full vscode polyfill - intentionally minimal:
//   commands.{register, execute, getAll}
//   window.{showInformationMessage, showInputBox, createWebviewPanel}
//   workspace.{openTextDocument, fs}
//   Uri.{file, parse}
//   events: onDidPasteImage, onDidChangeActiveFile
// ============================================================================

(function () {
  'use strict';

  const bridge = window.qqqideBridge;

  // ---- commands registry ----
  const COMMANDS = new Map();
  const commands = {
    register(id, fn) { COMMANDS.set(id, fn); return { dispose: () => COMMANDS.delete(id) }; },
    execute(id, ...args) {
      const fn = COMMANDS.get(id);
      if (!fn) { return Promise.reject(new Error('command not found: ' + id)); }
      try { return Promise.resolve(fn(...args)); }
      catch (e) { return Promise.reject(e); }
    },
    getAll() { return Array.from(COMMANDS.keys()); },
  };

  // ---- window UI helpers ----
  const windowApi = {
    showInformationMessage(message, ...items) {
      const opts = { type: 'info', message: String(message), buttons: items.length ? items : ['OK'] };
      return bridge.dialog.message(opts).then(r => items[r && r.response]);
    },
    showWarningMessage(message, ...items) {
      const opts = { type: 'warning', message: String(message), buttons: items.length ? items : ['OK'] };
      return bridge.dialog.message(opts).then(r => items[r && r.response]);
    },
    showErrorMessage(message, ...items) {
      const opts = { type: 'error', message: String(message), buttons: items.length ? items : ['OK'] };
      return bridge.dialog.message(opts).then(r => items[r && r.response]);
    },
    showInputBox(opts) {
      return new Promise(resolve => {
        const v = window.prompt((opts && opts.prompt) || 'Input:', (opts && opts.value) || '');
        resolve(v == null ? undefined : v);
      });
    },
    createWebviewPanel(viewType, title, _showOptions, options) {
      const id = 'webview.' + viewType + '.' + Date.now();
      const html = (options && options.html) || '';
      if (window.qqqGaea) {
        window.qqqGaea.register({
          id: id,
          title: title,
          build: (h) => {
            const f = document.createElement('iframe');
            f.style.cssText = 'width:100%; height:100%; border:0; background:#fff;';
            f.srcdoc = html;
            h.appendChild(f);
          },
        });
        window.qqqGaea.show(id);
      }
      return {
        webview: { set html(v) { /* noop */ } },
        reveal() { window.qqqGaea && window.qqqGaea.show(id); },
        dispose() { window.qqqGaea && window.qqqGaea.remove(id); },
      };
    },
  };

  // ---- workspace ----
  const workspace = {
    fs: {
      readFile: (uri) => bridge.fs.read(uri.fsPath || uri).then(s => new TextEncoder().encode(s)),
      writeFile: (uri, content) => {
        const data = (content instanceof Uint8Array) ? new TextDecoder().decode(content) : String(content);
        return bridge.fs.write(uri.fsPath || uri, data);
      },
      stat: (uri) => bridge.fs.stat(uri.fsPath || uri).then(s => ({
        size: s && s.size, mtime: s && s.mtimeMs, type: (s && s.isDirectory) ? 2 : (s && s.isFile) ? 1 : 0
      })),
      exists: (uri) => bridge.fs.exists(uri.fsPath || uri),
    },
    openTextDocument(p) {
      return bridge.fs.read(p).then(content => ({ getText: () => content, fileName: p, languageId: detectLang(p) }));
    },
  };

  // ---- Uri ----
  const Uri = {
    file(p) { return { scheme: 'file', fsPath: String(p), path: String(p), toString: () => 'file://' + p }; },
    parse(s) {
      try { const u = new URL(s); return { scheme: u.protocol.replace(':',''), fsPath: u.pathname, path: u.pathname, toString: () => s }; }
      catch { return Uri.file(s); }
    },
  };

  function detectLang(p) {
    const ext = (p.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    const map = { js:'javascript', ts:'typescript', json:'json', md:'markdown', html:'html', css:'css', py:'python', rs:'rust' };
    return map[ext.toLowerCase()] || 'plaintext';
  }

  // ---- minimal event bus ----
  const EVENTS = {};
  function emit(name, payload) {
    const ls = EVENTS[name] || [];
    for (const fn of ls) { try { fn(payload); } catch (e) { console.warn('[goods]', name, e); } }
  }
  function on(name, fn) {
    if (!EVENTS[name]) { EVENTS[name] = []; }
    EVENTS[name].push(fn);
    return { dispose() { EVENTS[name] = (EVENTS[name] || []).filter(f => f !== fn); } };
  }

  globalThis.qoods = {
    commands,
    window: windowApi,
    workspace,
    Uri,
    on, emit,
    bridge: bridge,
  };

  console.log('[goods] shim ready');
})();
