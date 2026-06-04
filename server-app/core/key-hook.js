// ============================================================================
// key-hook.js - Unified keyboard hook for QQQ shell (renderer side).
//
// Four-layer architecture (one config drives all four):
//   1. globalShortcut       (main process; works even when window is unfocused)
//   2. window-level capture (document.addEventListener('keydown', ..., capture))
//   3. iframe dispatcher    (each qood iframe registers a key-hook adapter; the
//                            adapter posts {type:'qqq-key', accel, scope} up)
//   4. CodeMirror/Monaco/native input — these get priority; key-hook respects
//      the active focus element's "editing" state via the `noEditing` guard.
//
// Public API:
//   window.qqqideKeyHook.init(bindings)           // load JSON bindings
//   window.qqqideKeyHook.on(id, handler)          // register command handler
//   window.qqqideKeyHook.set(id, accel, scope)    // dynamic rebind
//   window.qqqideKeyHook.unbind(id)               // remove a binding
//   window.qqqideKeyHook.list()                   // dump current map
//   window.qqqideKeyHook.context(name, on)        // toggle "when" context flags
//   window.qqqideKeyHook.fire(id)                 // programmatic trigger
//
// Iframe-side helper:
//   window.qqqideKeyHookAdapter.attach({roam: true})
//     - call from inside the iframe document; it captures keydown,
//       computes the accel, and posts to parent.
// ============================================================================

(function () {
  'use strict';

  const bridge = (typeof window !== 'undefined' && window.qqqideBridge) || null;

  // ---- accel canonicalization ---------------------------------------------
  // Build a stable canonical string from a KeyboardEvent. e.g.
  //   Ctrl+Shift+I, F12, Q, Space, Ctrl+\, Ctrl+=
  function canonAccel(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    let key = e.key;
    if (!key) return '';
    // Normalize: single-letter -> uppercase; named keys kept as-is
    if (key.length === 1) {
      key = key.toUpperCase();
    } else {
      const map = {
        ' ': 'Space',
        'Spacebar': 'Space',
        'Esc': 'Escape',
        'Del': 'Delete',
      };
      key = map[key] || key;
    }
    // If only modifier was pressed, skip
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return '';
    parts.push(key);
    return parts.join('+');
  }

  // Normalize binding accel string ('Ctrl+=' / 'F12' / 'Space+Q') into the same
  // form canonAccel() produces. For chord-style (Space+Q) we keep verbatim.
  function normalizeAccel(s) {
    if (!s) return '';
    return String(s).split('+').map(p => p.trim()).filter(Boolean).join('+');
  }

  // ---- state ---------------------------------------------------------------
  // map: scope -> Map<accel, id>
  const _byScope = new Map();
  // id -> handler
  const _handlers = new Map();
  // when-context flags
  const _ctx = Object.create(null);
  // raw bindings (for list())
  let _bindings = [];
  // chord state (for Space+Q)
  let _chordHead = null;       // {accel, ts}
  const CHORD_TTL = 1000;

  function getMap(scope) {
    let m = _byScope.get(scope);
    if (!m) { m = new Map(); _byScope.set(scope, m); }
    return m;
  }

  function clearAll() {
    _byScope.clear();
    _bindings = [];
  }

  function add(binding) {
    const accel = normalizeAccel(binding.accel || '');
    if (!accel || !binding.id) return;
    const scope = binding.scope || 'window';
    getMap(scope).set(accel, binding);
    _bindings.push(binding);
  }

  // ---- when-clause evaluation ---------------------------------------------
  function whenOk(expr) {
    if (!expr) return true;
    // tiny eval: tokens separated by && or ||; bare token = ctx flag; "!x" = not
    // ctx.noEditing is implicit (auto)
    try {
      const parts = String(expr).split(/\|\|/);
      for (const orPart of parts) {
        const ands = orPart.split(/&&/).map(s => s.trim()).filter(Boolean);
        let all = true;
        for (const tok of ands) {
          const neg = tok.startsWith('!');
          const name = neg ? tok.slice(1) : tok;
          const val = !!_ctx[name];
          if (neg ? val : !val) { all = false; break; }
        }
        if (all) return true;
      }
      return false;
    } catch { return true; }
  }

  // implicit context: noEditing is computed from document.activeElement
  function refreshImplicit() {
    const el = document.activeElement;
    const tag = el && el.tagName ? el.tagName.toUpperCase() : '';
    const editable = el && (el.isContentEditable
      || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
    // Monaco editor's textarea is inside .monaco-editor; treat as editing.
    let monacoFocused = false;
    if (el) {
      let p = el;
      while (p) {
        if (p.classList && (p.classList.contains('monaco-editor')
          || p.classList.contains('inputarea'))) { monacoFocused = true; break; }
        p = p.parentElement;
      }
    }
    _ctx.noEditing = !(editable || monacoFocused);
  }

  // ---- dispatch ------------------------------------------------------------
  function dispatch(accel, scope, originalEvent) {
    const map = _byScope.get(scope);
    if (!map) return false;
    const b = map.get(accel);
    if (!b) return false;
    if (!whenOk(b.when)) return false;
    const handler = _handlers.get(b.id);
    if (handler) {
      try { handler({ id: b.id, accel, scope, event: originalEvent }); }
      catch (e) { console.warn('[key-hook] handler threw:', b.id, e); }
    } else {
      // Fallback dispatch via DOM event (so shell.js handleMenuCmd can pick up)
      try {
        document.dispatchEvent(new CustomEvent('qqq-key-cmd', { detail: { id: b.id, accel, scope } }));
      } catch {}
    }
    return true;
  }

  // chord: Space then Q within CHORD_TTL → 'Space+Q'
  function tryChord(accel) {
    if (!_chordHead) {
      // Only Space is currently used as a chord head; extend here if needed
      if (accel === 'Space') {
        _chordHead = { accel, ts: Date.now() };
      }
      return null;
    }
    const stale = Date.now() - _chordHead.ts > CHORD_TTL;
    const combined = _chordHead.accel + '+' + accel;
    _chordHead = null;
    return stale ? null : combined;
  }

  // window-level keydown capture
  function onKeydown(e) {
    refreshImplicit();
    const accel = canonAccel(e);
    if (!accel) return;

    // Try chord first (renderer-side; global chord handled by globalShortcut)
    const chord = tryChord(accel);
    if (chord && dispatch(chord, 'window', e)) {
      e.preventDefault(); e.stopPropagation(); return;
    }

    // window scope
    if (dispatch(accel, 'window', e)) {
      e.preventDefault(); e.stopPropagation(); return;
    }
  }

  // iframe scope: parent receives qqq-key message from iframe adapter
  function onMessage(ev) {
    if (!ev.data || ev.data.type !== 'qqq-key') return;
    const accel = normalizeAccel(ev.data.accel || '');
    const scope = ev.data.scope || 'iframe:unknown';
    if (!accel) return;
    refreshImplicit();
    dispatch(accel, scope, null);
  }

  // ---- init ----------------------------------------------------------------
  let _initted = false;
  let _globalOff = null;

  async function init(bindings) {
    if (_initted) return;
    _initted = true;

    clearAll();
    const arr = (bindings && bindings.bindings) || [];
    for (const b of arr) { add(b); }

    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('message', onMessage);

    // Register global shortcuts (scope=global) via main process
    if (bridge && bridge.key && bridge.key.registerGlobal) {
      for (const b of arr.filter(x => x.scope === 'global')) {
        try { await bridge.key.registerGlobal(b.accel, b.id); }
        catch (e) { console.warn('[key-hook] registerGlobal failed:', b.accel, e); }
      }
      if (bridge.key.onGlobal) {
        _globalOff = bridge.key.onGlobal((msg) => {
          // re-dispatch as if pressed in global scope
          const handler = _handlers.get(msg.id);
          if (handler) {
            try { handler({ id: msg.id, accel: msg.accel, scope: 'global', event: null }); }
            catch (e) { console.warn('[key-hook] global handler threw:', e); }
          } else {
            document.dispatchEvent(new CustomEvent('qqq-key-cmd',
              { detail: { id: msg.id, accel: msg.accel, scope: 'global' } }));
          }
        });
      }
    }

    console.log('[key-hook] init: ' + arr.length + ' bindings');
  }

  function on(id, handler) {
    _handlers.set(id, handler);
  }

  function set(id, accel, scope) {
    accel = normalizeAccel(accel);
    scope = scope || 'window';
    // Remove any existing binding for this id
    for (const [s, map] of _byScope) {
      for (const [a, b] of map) {
        if (b.id === id) { map.delete(a); }
      }
    }
    add({ id, accel, scope });
  }

  function unbind(id) {
    for (const [, map] of _byScope) {
      for (const [a, b] of map) {
        if (b.id === id) { map.delete(a); }
      }
    }
  }

  function context(name, on) {
    if (on === undefined) return !!_ctx[name];
    if (on) { _ctx[name] = true; }
    else { delete _ctx[name]; }
    return !!on;
  }

  function fire(id, extra) {
    const handler = _handlers.get(id);
    if (handler) { try { handler({ id, ...(extra || {}) }); } catch (e) { console.warn(e); } }
    else { document.dispatchEvent(new CustomEvent('qqq-key-cmd', { detail: { id, ...(extra || {}) } })); }
  }

  function list() {
    const out = [];
    for (const [scope, map] of _byScope) {
      for (const [accel, b] of map) { out.push({ scope, accel, id: b.id, when: b.when || null }); }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Iframe-side adapter: runs INSIDE qood iframe documents.
  // Captures keydown, forwards as postMessage(parent, {type:'qqq-key',...}).
  // -------------------------------------------------------------------------
  const adapter = {
    /**
     * @param opts.scope  string; will become the message scope value.
     *                    Example: 'iframe:roam'
     * @param opts.swallow keep preventDefault on captured keys (default true)
     */
    attach(opts) {
      const scope = (opts && opts.scope) || 'iframe:unknown';
      const swallow = !(opts && opts.swallow === false);
      const handler = (e) => {
        // Same canonicalization as parent
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
        let key = e.key;
        if (!key) return;
        if (key.length === 1) { key = key.toUpperCase(); }
        else if (key === ' ') { key = 'Space'; }
        if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return;
        parts.push(key);
        const accel = parts.join('+');

        try { parent.postMessage({ type: 'qqq-key', accel, scope }, '*'); } catch {}

        if (swallow) {
          // Don't swallow when typing in an input/contenteditable
          const el = document.activeElement;
          const tag = el && el.tagName ? el.tagName.toUpperCase() : '';
          const editing = el && (el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA');
          if (!editing) { e.preventDefault(); e.stopPropagation(); }
        }
      };
      document.addEventListener('keydown', handler, true);
      return () => document.removeEventListener('keydown', handler, true);
    }
  };

  window.qqqideKeyHook = {
    init, on, set, unbind, fire, list, context,
    canonAccel, normalizeAccel,
  };
  window.qqqideKeyHookAdapter = adapter;
})();
