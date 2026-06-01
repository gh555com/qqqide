// ============================================================================
// only-store.js — 唯一真理配置机器
//
// 铁律：
//   1. 整个项目的全部偏好/状态/快照，必须经由此机器。零散落 localStorage/内存。
//   2. 一个 project 一个 only.sq3，放在 qqq/alphal/only.sq3。
//   3. 性能至上：读走内存缓存（零 I/O），写自动合并批量刷盘。
//   4. 无需维护关键事件表：任何 set() 调用自动触发延迟刷盘管线。
//   5. 防崩溃：beforeunload 同步刷盘 + 定时器兜底（最多丢 ~2 秒状态）。
//
// 管线：
//   onlyStore.set(key, value)
//     → 更新内存缓存（瞬时）
//     → 标记 dirty
//     → 重置 flush 定时器（500ms 空闲后自动刷）
//     → 若累计待刷 > 3000ms，立即刷盘（防长 burst 丢太多）
//
// API:
//   onlyStore.init(rootDir)           — 绑定项目根目录（必须最先调用）
//   onlyStore.get(key, fallback)      — 读（内存缓存，同步）
//   onlyStore.set(key, value)         — 写（内存 + 延迟刷盘管线）
//   onlyStore.setNow(key, value)      — 写 + 立即刷盘（用于关键瞬间）
//   onlyStore.flush()                 — 强制刷盘
//   onlyStore.getAll()                — 返回全部缓存快照
//   onlyStore.onFlush(fn)             — 订阅刷盘事件
// ============================================================================

var onlyStore = (function () {
  'use strict';

  var _qgs = null;
  var _rootDir = null;
  var _cache = {};           // 内存缓存：{ key: value }
  var _dirty = {};           // 脏标记：{ key: true }
  var _flushTimer = null;
  var _flushFirstDirty = 0;  // 最早脏的时间戳
  var _flushing = false;
  var _initDone = false;
  var _onFlushCb = null;

  var FLUSH_IDLE_MS = 500;   // 最后一次 set 后空闲多久刷盘
  var FLUSH_MAX_MS = 3000;   // 累计脏数据超过多久强制刷盘

  // ── bridge ──
  function _bridge() {
    if (_qgs) return _qgs;
    if (!_rootDir) return null;
    try {
      if (window.parent && window.parent.qgs && typeof window.parent.qgs.project === 'function') {
        _qgs = window.parent.qgs.project(_rootDir + '/qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
        console.log('[only-store] bridge OK: ' + _rootDir + '/qqq/alphal/only.sq3');
        return _qgs;
      }
    } catch (e) { console.warn('[only-store] bridge error:', e); }
    return null;
  }

  // ── 异步读（初始化时用）──
  async function _loadAll() {
    var b = _bridge();
    if (!b) return;
    try {
      // 尝试读所有已知 key 的前缀。qgs 不支持 list，所以用固定 key 集合。
      // 首次启动时 _cache 为空，后续 set 会填充。
      var keys = ['theme', 'ai.activeQuest', 'ai.activeFloor', 'ai.tier', 'ai.inputDraft',
        'ai.pendingImages', 'ai.queue', 'ai.scrollTop', 'editor.tabs', 'editor.activeTab',
        'viewport.splitPositions', 'window.geometry'];
      for (var i = 0; i < keys.length; i++) {
        try {
          var v = await b.get(keys[i]);
          if (v !== null && v !== undefined) _cache[keys[i]] = v;
        } catch (_) { }
      }
      _initDone = true;
      console.log('[only-store] loaded ' + Object.keys(_cache).length + ' keys from disk');
    } catch (e) { console.warn('[only-store] _loadAll error:', e); }
  }

  // ── 刷盘管线（唯一写入口）──
  function _scheduleFlush() {
    if (_flushTimer) clearTimeout(_flushTimer);
    var pending = Date.now() - _flushFirstDirty;
    if (pending >= FLUSH_MAX_MS) {
      // 累计太久，立即刷
      _doFlush();
    } else {
      // 空闲后刷
      _flushTimer = setTimeout(_doFlush, FLUSH_IDLE_MS);
    }
  }

  async function _doFlush() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (_flushing) return;
    var dirtyKeys = Object.keys(_dirty);
    if (dirtyKeys.length === 0) return;
    _flushing = true;
    var b = _bridge();
    if (!b) { _flushing = false; return; }
    try {
      // 批量写：逐个 setNow（qgs 不支持事务批处理，但 setNow 本身是原子的）
      for (var i = 0; i < dirtyKeys.length; i++) {
        var k = dirtyKeys[i];
        try { await b.setNow(k, _cache[k]); } catch (_) { }
      }
      _dirty = {};
      _flushFirstDirty = 0;
      if (_onFlushCb) { try { _onFlushCb(dirtyKeys); } catch (_) { } }
      console.log('[only-store] flushed ' + dirtyKeys.length + ' keys');
    } catch (e) { console.warn('[only-store] flush error:', e); }
    _flushing = false;
  }

  // ── beforeunload 同步刷盘（尽力）──
  function _onBeforeUnload() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    var dirtyKeys = Object.keys(_dirty);
    if (dirtyKeys.length === 0) return;
    var b = _bridge();
    if (!b) return;
    // 同步尽力刷：用 setNow 但不 await（beforeunload 不允许 async）
    for (var i = 0; i < dirtyKeys.length; i++) {
      var k = dirtyKeys[i];
      try { b.setNow(k, _cache[k]).catch(function () { }); } catch (_) { }
    }
    _dirty = {};
    _flushFirstDirty = 0;
  }

  // ═══ PUBLIC API ═══

  function init(rootDir) {
    if (!rootDir || typeof rootDir !== 'string') return;
    _rootDir = rootDir.replace(/\\/g, '/').replace(/\/$/, '');
    _qgs = null;
    _cache = {};
    _dirty = {};
    _initDone = false;
    _flushFirstDirty = 0;
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    // 异步加载已有数据
    _loadAll().catch(function () { });
    // 注册崩溃防护
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', _onBeforeUnload);
    }
    console.log('[only-store] init with root: ' + _rootDir);
  }

  function get(key, fallback) {
    if (key in _cache) return _cache[key];
    return fallback !== undefined ? fallback : null;
  }

  function set(key, value) {
    _cache[key] = value;
    _dirty[key] = true;
    if (!_flushFirstDirty) _flushFirstDirty = Date.now();
    _scheduleFlush();
  }

  function setNow(key, value) {
    _cache[key] = value;
    _dirty[key] = true;
    if (!_flushFirstDirty) _flushFirstDirty = Date.now();
    // 立即刷盘（跳过空闲等待）
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    _doFlush();
  }

  function flush() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    return _doFlush();
  }

  function getAll() {
    var snap = {};
    var keys = Object.keys(_cache);
    for (var i = 0; i < keys.length; i++) { snap[keys[i]] = _cache[keys[i]]; }
    return snap;
  }

  function onFlush(fn) {
    _onFlushCb = fn;
  }

  function isInited() { return _initDone; }

  // ═══ 项目文件锁 ═══
  var _lockPath = null;
  var _lockTimer = null;
  var LOCK_STALE_MS = 60000;
  var LOCK_HEARTBEAT_MS = 30000;

  function _fsBridge() {
    try {
      if (window.parent && window.parent.qqqBridge) return window.parent.qqqBridge;
      if (window.qqqBridge) return window.qqqBridge;
    } catch (_) { }
    return null;
  }

  async function claimLock() {
    if (!_rootDir) return { ok: false, error: 'no rootDir' };
    _lockPath = _rootDir + '/qqq/alphal/.lock';
    var fsb = _fsBridge();
    if (!fsb) return { ok: false, error: 'no bridge' };
    try {
      var statInfo = await fsb.fs.stat(_lockPath);
      if (statInfo) {
        var raw = await fsb.fs.read(_lockPath);
        var data = JSON.parse(raw);
        var age = Date.now() - (data.atime || 0);
        if (age < LOCK_STALE_MS) {
          return { ok: false, error: 'locked', age: age };
        }
        // 僵尸锁，清除
        try { await fsb.fs.remove(_lockPath); } catch (_) { }
      }
    } catch (_) { /* 锁不存在 */ }
    // 写入新锁
    try {
      await fsb.fs.write(_lockPath, JSON.stringify({ pid: 0, atime: Date.now() }));
      // 启动心跳
      if (_lockTimer) clearInterval(_lockTimer);
      _lockTimer = setInterval(async function () {
        try { await fsb.fs.write(_lockPath, JSON.stringify({ pid: 0, atime: Date.now() })); } catch (_) { }
      }, LOCK_HEARTBEAT_MS);
      console.log('[only-store] lock claimed: ' + _lockPath);
      return { ok: true };
    } catch (_) {
      return { ok: false, error: 'write failed' };
    }
  }

  async function releaseLock() {
    if (_lockTimer) { clearInterval(_lockTimer); _lockTimer = null; }
    if (_lockPath) {
      var fsb = _fsBridge();
      if (fsb) {
        try { await fsb.fs.remove(_lockPath); } catch (_) { }
      }
      console.log('[only-store] lock released: ' + _lockPath);
      _lockPath = null;
    }
  }

  // 注册关闭时释放锁
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', function () {
      if (_lockTimer) clearInterval(_lockTimer);
      if (_lockPath) {
        var fsb = _fsBridge();
        if (fsb) { try { fsb.fs.remove(_lockPath); } catch (_) { } }
      }
    });
  }

  return {
    init: init,
    get: get,
    set: set,
    setNow: setNow,
    flush: flush,
    getAll: getAll,
    onFlush: onFlush,
    isInited: isInited,
    claimLock: claimLock,
    releaseLock: releaseLock
  };

})();
