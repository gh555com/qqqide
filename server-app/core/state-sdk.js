// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// state-sdk.js
// Renderer-side sugar for bridge.state.* — auto-binds a namespace, so goods
// authors write less:
//
//   const myState = qqqState.ns('q4', { v: 1, form: 'log', cloud: true });
//   await myState.register();
//   const hist = await myState.get('clipboard_history');
//   await myState.append('clipboard_history', { t: Date.now(), text: '...' });
//
// Smart Cache: 5s TTL renderer-side memory cache.
//   - get() hits cache → 0 IPC (instant tab switch, repeated reads free)
//   - set()/setNow()/del() write-through (cache + bridge)
//   - onChange auto-invalidates cache entries
//
// Falls back to in-memory mocks when running in a plain browser (no qqqideBridge).
// ============================================================================

(function () {
  'use strict';

  function _bridge() {
    return (typeof window !== 'undefined' && window.qqqideBridge && window.qqqideBridge.state) || null;
  }

  // ★ qgf 桥接（FS 原子读写机）— qqideBridge.qgf 直接可取，不走 state
  function _qgfBridge() {
    return (typeof window !== 'undefined' && window.qqqideBridge && window.qqqideBridge.qgf) || null;
  }

  // Browser-dev fallback (in-memory; lost on reload — fine for goods authors).
  const _mem = new Map(); // ns -> Map(key -> value)
  function _memGet(ns, key) {
    const m = _mem.get(ns); return m ? m.get(key) : null;
  }
  function _memSet(ns, key, v) {
    if (!_mem.has(ns)) { _mem.set(ns, new Map()); }
    _mem.get(ns).set(key, v);
  }
  function _memAppend(ns, key, ev) {
    const cur = _memGet(ns, key) || [];
    cur.push(ev);
    _memSet(ns, key, cur);
  }
  function _memDel(ns, key) {
    const m = _mem.get(ns); if (m) { return m.delete(key); }
    return false;
  }
  function _memList(ns) {
    const m = _mem.get(ns); return m ? Array.from(m.keys()) : [];
  }

  // ---- Namespace handle factory --------------------------------------------
  // ---- Smart Cache (renderer-side, 5s TTL) ---------------------------------
  const CACHE_TTL_MS = 5000;
  const _scache = new Map(); // key = ns + '\x00' + key, val = { value, ts }
  let _globalChgUnsub = null;

  function _cacheKey(ns, key) { return ns + '\x00' + key; }

  function _cacheGet(ns, key) {
    var e = _scache.get(_cacheKey(ns, key));
    if (e && (Date.now() - e.ts) < CACHE_TTL_MS) return e.value;
    if (e) _scache.delete(_cacheKey(ns, key));
  }

  function _cacheSet(ns, key, value) {
    _scache.set(_cacheKey(ns, key), { value: value, ts: Date.now() });
  }

  function _cacheDel(ns, key) {
    _scache.delete(_cacheKey(ns, key));
  }

  // Module-level register dedup: multiple closures for same ns share ONE register IPC
  var _nsReg = {};       // ns()     — keyed by nsName
  var _qgfReg = {};      // qgf()    — keyed by rootDir + '\x00' + nsName
  var _projReg = {};     // project() — keyed by dbPath + '\x00' + nsName

  function _ensureGlobalChgListener() {
    if (_globalChgUnsub) return;
    var b = _bridge();
    if (!b || !b.onChange) return;
    _globalChgUnsub = b.onChange(function (msg) {
      if (msg && msg.ns && msg.key) _cacheDel(msg.ns, msg.key);
    });
  }

  function ns(nsName, schema) {
    if (!nsName || typeof nsName !== 'string') {
      throw new Error('qqqState.ns: nsName required');
    }
    let _registered = false;
    let _registerPromise = null;

    async function _ensureRegistered() {
      if (_registered) { return; }
      if (_registerPromise) { return _registerPromise; }
      // Cross-closure dedup: share ONE register IPC across all handles for this ns
      var existing = _nsReg[nsName];
      if (existing) {
        if (existing.done) { _registered = true; return; }
        _registerPromise = existing.promise.catch(function () { });
        await _registerPromise;
        _registered = true;
        return;
      }
      var promise = (async () => {
        const b = _bridge();
        if (!b || !schema) { _registered = true; return; }
        try {
          await b.register(nsName, schema);
        } catch (e) {
          console.warn('[state-sdk] register failed for', nsName, e);
        }
        _registered = true;
      })();
      _nsReg[nsName] = { promise: promise, done: false };
      _registerPromise = promise;
      await promise;
      _nsReg[nsName].done = true;
    }

    return {
      get nsName() { return nsName; },

      register: async (sc) => {
        if (sc) { schema = sc; }
        await _ensureRegistered();
      },

      get: async (key) => {
        await _ensureRegistered();
        // Smart Cache: check renderer-side cache first (0 IPC hit)
        var cached = _cacheGet(nsName, key);
        if (cached !== undefined) return cached;
        var b = _bridge();
        var v;
        if (b && b.get) { v = await b.get(nsName, key); }
        else { v = _memGet(nsName, key); }
        // Cache the result (even null)
        _cacheSet(nsName, key, v);
        return v;
      },

      set: async (key, value) => {
        await _ensureRegistered();
        _ensureGlobalChgListener();
        // Write-through: cache first, then bridge
        _cacheSet(nsName, key, value);
        var b = _bridge();
        if (b && b.set) { return b.set(nsName, key, value); }
        _memSet(nsName, key, value); return true;
      },

      setNow: async (key, value) => {
        await _ensureRegistered();
        _ensureGlobalChgListener();
        // Write-through: cache first, then bridge
        _cacheSet(nsName, key, value);
        var b = _bridge();
        if (b && b.setNow) { return b.setNow(nsName, key, value); }
        _memSet(nsName, key, value); return true;
      },

      append: async (key, event) => {
        await _ensureRegistered();
        const b = _bridge();
        if (b && b.append) { return b.append(nsName, key, event); }
        _memAppend(nsName, key, event); return true;
      },

      del: async (key) => {
        await _ensureRegistered();
        _ensureGlobalChgListener();
        // Invalidate cache
        _cacheDel(nsName, key);
        var b = _bridge();
        if (b && b.del) { return b.del(nsName, key); }
        return _memDel(nsName, key);
      },

      list: async () => {
        await _ensureRegistered();
        const b = _bridge();
        if (b && b.list) { return b.list(nsName); }
        return _memList(_cacheNs);
      },

      flush: async () => {
        const b = _bridge();
        if (b && b.flush) { return b.flush(); }
        return true;
      },

      flushOne: async (key) => {
        const b = _bridge();
        _cacheDel(nsName, key);  // invalidate renderer cache before flush
        if (b && b.flushOne) { return b.flushOne(nsName, key); }
        return true;
      },

      // Subscribe to changes within THIS namespace (filtered).
      onChange: (cb) => {
        const b = _bridge();
        if (!b || !b.onChange) { return () => { }; }
        return b.onChange((msg) => {
          if (msg && msg.ns === nsName) {
            try { cb(msg.key, msg.value, !!msg.deleted); } catch (e) { console.warn('[state-sdk.onChange]', e); }
          }
        });
      },
    };
  }

  // ---- Zero-config entry (≅ VS Code globalState) ------------------------
  //
  //   const state = qgs('my-good');              // doc form, no cloud
  //   const state = qgs('my-good', { cloud:true }); // cloud sync on
  //   const state = qgs('my-good', { form:'blob' }); // gzip for large data
  //   const state = qgs('my-good', { form:'log'  }); // append-only events
  //
  //   await state.set('key', value);
  //   const v = await state.get('key');
  //   await state.del('key');
  //   const keys = await state.list();
  //   state.onChange((key, value, deleted) => { ... });
  //
  function simple(nsName, opts) {
    const form = (opts && opts.form) || 'doc';
    const cloud = !!(opts && opts.cloud);
    return ns(nsName, { v: 1, form: form, cloud: cloud });
  }

  // ---- qgf — FS 原子读写真理机 (per-project _qqq/qgf/) -----------------
  //
  //   const state = qgf('/path/to/project', 'my-ns');
  //   const state = qgf('/path/to/project', 'my-ns', { form:'blob' });
  //   const state = qgf('/path/to/project', 'my-ns', { form:'log'  });
  //
  //   await state.set('key', value);
  //   const v = await state.get('key');
  //   await state.del('key');
  //   const keys = await state.list();
  //   state.onChange((key, value, deleted) => { ... });
  //
  function qgf(rootDir, nsName, opts) {
    if (!rootDir || !nsName) throw new Error('qgf: rootDir and nsName required');
    const form = (opts && opts.form) || 'doc';
    const schema = { v: 1, form: form };
    // Cache key isolates per-project: rootDir + ns avoids cross-project collisions
    const _cacheNs = rootDir + '\x00' + nsName;
    let _registered = false;
    let _registerPromise = null;

    async function _ensureRegistered() {
      if (_registered) { return; }
      if (_registerPromise) { return _registerPromise; }
      var existing = _qgfReg[_cacheNs];
      if (existing) {
        if (existing.done) { _registered = true; return; }
        _registerPromise = existing.promise.catch(function () { });
        await _registerPromise;
        _registered = true;
        return;
      }
      var promise = (async () => {
        const b = _qgfBridge();
        if (!b) { _registered = true; return; }
        try { await b.register(rootDir, nsName, schema); } catch (e) {
          console.warn('[qgf] register failed for', nsName, e);
        }
        _registered = true;
      })();
      _qgfReg[_cacheNs] = { promise: promise, done: false };
      _registerPromise = promise;
      await promise;
      _qgfReg[_cacheNs].done = true;
    }

    return {
      get nsName() { return nsName; },
      register: async (sc) => { if (sc) { Object.assign(schema, sc); } await _ensureRegistered(); },
      get: async (key) => {
        await _ensureRegistered();
        var cached = _cacheGet(_cacheNs, key);
        if (cached !== undefined) return cached;
        var b = _qgfBridge();
        var v;
        if (b && b.get) { v = await b.get(rootDir, nsName, key); }
        else { v = _memGet(_cacheNs, key); }
        _cacheSet(_cacheNs, key, v);
        return v;
      },
      set: async (key, value) => {
        await _ensureRegistered();
        _cacheSet(_cacheNs, key, value);
        var b = _qgfBridge();
        if (b && b.set) { return b.set(rootDir, nsName, key, value); }
        _memSet(_cacheNs, key, value); return true;
      },
      setNow: async (key, value) => {
        await _ensureRegistered();
        _cacheSet(_cacheNs, key, value);
        var b = _qgfBridge();
        if (b && b.setNow) { return b.setNow(rootDir, nsName, key, value); }
        _memSet(_cacheNs, key, value); return true;
      },
      append: async (key, event) => {
        await _ensureRegistered();
        const b = _qgfBridge();
        if (b && b.append) { return b.append(rootDir, nsName, key, event); }
        _memAppend(_cacheNs, key, event); return true;
      },
      del: async (key) => {
        await _ensureRegistered();
        _cacheDel(_cacheNs, key);
        var b = _qgfBridge();
        if (b && b.del) { return b.del(rootDir, nsName, key); }
        return _memDel(_cacheNs, key);
      },
      list: async () => {
        await _ensureRegistered();
        const b = _qgfBridge();
        if (b && b.list) { return b.list(rootDir, nsName); }
        return _memList(_cacheNs);
      },
      flush: async () => {
        const b = _qgfBridge();
        if (b && b.flush) { return b.flush(rootDir); }
        return true;
      },
      flushOne: async (key) => {
        await _ensureRegistered();
        const b = _qgfBridge();
        _cacheDel(_cacheNs, key);  // invalidate renderer cache before flush
        if (b && b.flushOne) { return b.flushOne(rootDir, nsName, key); }
        return true;
      },
      onChange: (cb) => {
        const b = _qgfBridge();
        if (!b || !b.onChange) { return function () { }; }
        return b.onChange(function (msg) {
          if (msg && msg.ns === nsName && msg.rootDir === rootDir) {
            try { cb(msg.key, msg.value, !!msg.deleted); } catch (e) { console.warn('[qgf.onChange]', e); }
          }
        });
      },
    };
  }

  // ---- project — project-level SQLite (quest.sq3, per-project persistence) ----
  //
//   const state = project('/path/_qqq/quests/quest.sq3', 'my-ns');
//   const state = project('/path/_qqq/quests/quest.sq3', 'my-ns', { form:'log' });
  //
  //   await state.set('key', value);
  //   const v = await state.get('key');
  //   await state.del('key');
  //   const keys = await state.list();
  //   state.onChange((key, value, deleted) => { ... });
  //
  function project(dbPath, nsName, opts) {
    if (!dbPath || !nsName) throw new Error('project: dbPath and nsName required');
    const form = (opts && opts.form) || 'doc';
    const schema = { v: 1, form: form };
    // Cache key isolates per-dbPath: dbPath + ns avoids cross-project collisions
    const _cacheNs = dbPath + '\x00' + nsName;
    let _registered = false;
    let _registerPromise = null;

    async function _ensureRegistered() {
      if (_registered) { return; }
      if (_registerPromise) { return _registerPromise; }
      var existing = _projReg[_cacheNs];
      if (existing) {
        if (existing.done) { _registered = true; return; }
        _registerPromise = existing.promise.catch(function () { });
        await _registerPromise;
        _registered = true;
        return;
      }
      var promise = (async () => {
        const b = _bridge();
        if (!b || !b.project) { _registered = true; return; }
        try { await b.project.register(dbPath, nsName, schema); } catch (e) {
          console.warn('[project] register failed for', nsName, e);
        }
        _registered = true;
      })();
      _projReg[_cacheNs] = { promise: promise, done: false };
      _registerPromise = promise;
      await promise;
      _projReg[_cacheNs].done = true;
    }

    return {
      get nsName() { return nsName; },
      register: async (sc) => { if (sc) { Object.assign(schema, sc); } await _ensureRegistered(); },
      get: async (key) => {
        await _ensureRegistered();
        var cached = _cacheGet(_cacheNs, key);
        if (cached !== undefined) return cached;
        var b = _bridge();
        var v;
        if (b && b.project && b.project.get) { v = await b.project.get(dbPath, nsName, key); }
        else { v = _memGet(_cacheNs, key); }
        _cacheSet(_cacheNs, key, v);
        return v;
      },
      set: async (key, value) => {
        await _ensureRegistered();
        _cacheSet(_cacheNs, key, value);
        var b = _bridge();
        if (b && b.project && b.project.set) { return b.project.set(dbPath, nsName, key, value); }
        _memSet(_cacheNs, key, value); return true;
      },
      setNow: async (key, value) => {
        await _ensureRegistered();
        _cacheSet(_cacheNs, key, value);
        var b = _bridge();
        if (b && b.project && b.project.setNow) { return b.project.setNow(dbPath, nsName, key, value); }
        _memSet(_cacheNs, key, value); return true;
      },
      append: async (key, event) => {
        await _ensureRegistered();
        const b = _bridge();
        if (b && b.project && b.project.append) { return b.project.append(dbPath, nsName, key, event); }
        _memAppend(_cacheNs, key, event); return true;
      },
      del: async (key) => {
        await _ensureRegistered();
        _cacheDel(_cacheNs, key);
        var b = _bridge();
        if (b && b.project && b.project.del) { return b.project.del(dbPath, nsName, key); }
        return _memDel(_cacheNs, key);
      },
      list: async () => {
        await _ensureRegistered();
        const b = _bridge();
        if (b && b.project && b.project.list) { return b.project.list(dbPath, nsName); }
        return _memList(_cacheNs);
      },
      flush: async () => {
        const b = _bridge();
        if (b && b.project && b.project.flush) { return b.project.flush(dbPath); }
        return true;
      },
      flushOne: async (key) => {
        await _ensureRegistered();
        const b = _bridge();
        _cacheDel(_cacheNs, key);  // invalidate renderer cache before flush
        if (b && b.project && b.project.flushOne) { return b.project.flushOne(dbPath, nsName, key); }
        return true;
      },
      // ★ 原子自增：SQLite 层面保证，零竞态。返回递增后的值。
      atomicIncr: async (key) => {
        await _ensureRegistered();
        var b = _bridge();
        if (b && b.project && b.project.atomicIncr) {
          var v = await b.project.atomicIncr(dbPath, nsName, key);
          _cacheSet(_cacheNs, key, v);
          return v;
        }
        // 降级：内存自增（非原子，仅 browser-dev fallback）
        var cur = _memGet(_cacheNs, key) || 0;
        cur = (typeof cur === 'number' ? cur : 0) + 1;
        _memSet(_cacheNs, key, cur);
        return cur;
      },
      onChange: (cb) => {
        const b = _bridge();
        if (!b || !b.project || !b.project.onChange) { return function () { }; }
        return b.project.onChange(dbPath, function (msg) {
          if (msg && msg.ns === nsName) {
            try { cb(msg.key, msg.value, !!msg.deleted); } catch (e) { console.warn('[project.onChange]', e); }
          }
        });
      },
    };
  }

  // ---- qgs — qqq goods state, the ONE persistence entry point -------------
  const qgs = {
    ns,
    simple,
    project,
    cloud: {
      pull: () => { const b = _bridge(); return b && b.cloud ? b.cloud.pull() : Promise.resolve({ ok: false, reason: 'no-bridge' }); },
      push: () => { const b = _bridge(); return b && b.cloud ? b.cloud.push() : Promise.resolve({ ok: false, reason: 'no-bridge' }); },
      sync: () => { const b = _bridge(); return b && b.cloud ? b.cloud.sync() : Promise.resolve({ ok: false, reason: 'no-bridge' }); },
    },
    sql: (query, params) => {
      const b = _bridge();
      if (b && b.sql) { return b.sql(query, params); }
      throw new Error('qgs.sql: bridge not available');
    },
    stats: () => { const b = _bridge(); return b && b.stats ? b.stats() : Promise.resolve({ dirtyKeys: 0, queuedOutbox: 0, namespaces: 0 }); },
    flush: () => { const b = _bridge(); return b && b.flush ? b.flush() : Promise.resolve(true); },
    isAvailable: () => !!_bridge(),
  };

  if (typeof window !== 'undefined') {
    window.qgf = qgf;
    window.qgs = qgs;
    window.qqqState = qgs; // legacy alias
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = qgs;
  }
})();
