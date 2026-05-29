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
// Falls back to in-memory mocks when running in a plain browser (no qqqBridge).
// ============================================================================

(function () {
  'use strict';

  function _bridge() {
    return (typeof window !== 'undefined' && window.qqqBridge && window.qqqBridge.state)
      || (typeof window !== 'undefined' && window.qqq && window.qqq.state)
      || null;
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
  var _qgReg = {};       // qg()     — keyed by rootDir + '\x00' + nsName
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

  // ---- qg — project-level FS state (.qqq/qg/) -------------------------
  //
  //   const state = qg('/path/to/project', 'my-ns');
  //   const state = qg('/path/to/project', 'my-ns', { form:'blob' });
  //   const state = qg('/path/to/project', 'my-ns', { form:'log'  });
  //
  //   await state.set('key', value);
  //   const v = await state.get('key');
  //   await state.del('key');
  //   const keys = await state.list();
  //   state.onChange((key, value, deleted) => { ... });
  //
  function qg(rootDir, nsName, opts) {
    if (!rootDir || !nsName) throw new Error('qg: rootDir and nsName required');
    const form = (opts && opts.form) || 'doc';
    const schema = { v: 1, form: form };
    // Cache key isolates per-project: rootDir + ns avoids cross-project collisions
    const _cacheNs = rootDir + '\x00' + nsName;
    let _registered = false;
    let _registerPromise = null;

    async function _ensureRegistered() {
      if (_registered) { return; }
      if (_registerPromise) { return _registerPromise; }
      var existing = _qgReg[_cacheNs];
      if (existing) {
        if (existing.done) { _registered = true; return; }
        _registerPromise = existing.promise.catch(function () { });
        await _registerPromise;
        _registered = true;
        return;
      }
      var promise = (async () => {
        const b = _bridge();
        if (!b || !b.qg) { _registered = true; return; }
        try { await b.qg.register(rootDir, nsName, schema); } catch (e) {
          console.warn('[qg] register failed for', nsName, e);
        }
        _registered = true;
      })();
      _qgReg[_cacheNs] = { promise: promise, done: false };
      _registerPromise = promise;
      await promise;
      _qgReg[_cacheNs].done = true;
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
        if (b && b.qg && b.qg.get) { v = await b.qg.get(rootDir, nsName, key); }
        else { v = _memGet(_cacheNs, key); }
        _cacheSet(_cacheNs, key, v);
        return v;
      },
      set: async (key, value) => {
        await _ensureRegistered();
        _cacheSet(_cacheNs, key, value);
        var b = _bridge();
        if (b && b.qg && b.qg.set) { return b.qg.set(rootDir, nsName, key, value); }
        _memSet(_cacheNs, key, value); return true;
      },
      setNow: async (key, value) => {
        await _ensureRegistered();
        _cacheSet(_cacheNs, key, value);
        var b = _bridge();
        if (b && b.qg && b.qg.setNow) { return b.qg.setNow(rootDir, nsName, key, value); }
        _memSet(_cacheNs, key, value); return true;
      },
      append: async (key, event) => {
        await _ensureRegistered();
        const b = _bridge();
        if (b && b.qg && b.qg.append) { return b.qg.append(rootDir, nsName, key, event); }
        _memAppend(_cacheNs, key, event); return true;
      },
      del: async (key) => {
        await _ensureRegistered();
        _cacheDel(_cacheNs, key);
        var b = _bridge();
        if (b && b.qg && b.qg.del) { return b.qg.del(rootDir, nsName, key); }
        return _memDel(_cacheNs, key);
      },
      list: async () => {
        await _ensureRegistered();
        const b = _bridge();
        if (b && b.qg && b.qg.list) { return b.qg.list(rootDir, nsName); }
        return _memList(_cacheNs);
      },
      flush: async () => {
        const b = _bridge();
        if (b && b.qg && b.qg.flush) { return b.qg.flush(rootDir); }
        return true;
      },
      flushOne: async (key) => {
        await _ensureRegistered();
        const b = _bridge();
        if (b && b.qg && b.qg.flushOne) { return b.qg.flushOne(rootDir, nsName, key); }
        return true;
      },
      onChange: (cb) => {
        const b = _bridge();
        if (!b || !b.qg || !b.qg.onChange) { return function () { }; }
        return b.qg.onChange(function (msg) {
          if (msg && msg.ns === nsName && msg.rootDir === rootDir) {
            try { cb(msg.key, msg.value, !!msg.deleted); } catch (e) { console.warn('[qg.onChange]', e); }
          }
        });
      },
    };
  }

  // ---- project — project-level SQLite (quest.sq3, per-project persistence) ----
  //
  //   const state = project('/path/qqq/quests/quest.sq3', 'my-ns');
  //   const state = project('/path/qqq/quests/quest.sq3', 'my-ns', { form:'log' });
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
        if (b && b.project && b.project.flushOne) { return b.project.flushOne(dbPath, nsName, key); }
        return true;
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
    qg,
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
    window.qg = qg;
    window.qgs = qgs;
    window.qqqState = qgs; // legacy alias
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = qgs;
  }
})();
