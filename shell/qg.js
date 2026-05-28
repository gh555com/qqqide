"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// shell/qg.ts
var qg_exports = {};
__export(qg_exports, {
  Qg: () => Qg
});
module.exports = __toCommonJS(qg_exports);
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var zlib = __toESM(require("zlib"));
var crypto = __toESM(require("crypto"));
var import_events = require("events");
var DEFAULT_DEBOUNCE_MS = 250;
var DEFAULT_LOG_COMPACT_BYTES = 2 * 1024 * 1024;
var LOCK_STALE_MS = 6e4;
var MAX_SAFE_NAME = 200;
var BAD_CHARS_RE = /[/\\:*?"<>|\x00-\x1f]/g;
function nowMs() {
  return Date.now();
}
function safeName(s) {
  if (s === null || s === void 0)
    return "_";
  let v = String(s).replace(BAD_CHARS_RE, "_").replace(/^\.+/, "_").trim();
  if (!v)
    v = "_";
  if (v.length > MAX_SAFE_NAME) {
    const h = crypto.createHash("sha256").update(v).digest("hex").slice(0, 32);
    v = v.slice(0, MAX_SAFE_NAME - 33) + "_" + h;
  }
  return v;
}
async function atomicWrite(absPath, data) {
  const dir = path.dirname(absPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = absPath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 8);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  await fs.promises.writeFile(tmp, buf);
  try {
    await fs.promises.rename(tmp, absPath);
  } catch (e) {
    if (e && (e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES")) {
      try {
        await fs.promises.unlink(absPath);
      } catch {
      }
      await fs.promises.rename(tmp, absPath);
    } else {
      try {
        await fs.promises.unlink(tmp);
      } catch {
      }
      throw e;
    }
  }
}
function atomicWriteSync(absPath, data) {
  const dir = path.dirname(absPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
  }
  const tmp = absPath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 8);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, absPath);
  } catch (e) {
    if (e && (e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES")) {
      try {
        fs.unlinkSync(absPath);
      } catch {
      }
      fs.renameSync(tmp, absPath);
    } else {
      try {
        fs.unlinkSync(tmp);
      } catch {
      }
      throw e;
    }
  }
}
var Qg = class _Qg extends import_events.EventEmitter {
  // ----- constructor --------------------------------------------------------
  /**
   * @param rootDir  e.g. "/path/to/project/.qqq/qg"
   */
  constructor(rootDir) {
    super();
    this.outboxSeq = 0;
    this.schemas = /* @__PURE__ */ new Map();
    this.states = /* @__PURE__ */ new Map();
    this._dirCache = /* @__PURE__ */ new Map();
    // ★ ns → key list cache
    /** Hook for cloud sync (qg doesn't auto-push; state-cloud.ts drains outbox). */
    this.onCloudDirty = null;
    this.setMaxListeners(0);
    this.rootDir = rootDir;
    this.nsDir = path.join(rootDir, "ns");
    this.locksDir = path.join(rootDir, "locks");
    this.outboxDir = path.join(rootDir, "outbox");
    this.corruptDir = path.join(rootDir, "corrupt");
    for (const d of [this.nsDir, this.locksDir, this.outboxDir, this.corruptDir]) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch {
      }
    }
    this._restoreOutboxSeq();
  }
  static {
    // ★ blob fast path threshold
    this.BLOB_NOCOMPRESS_BYTES = 4096;
  }
  _restoreOutboxSeq() {
    try {
      for (const f of fs.readdirSync(this.outboxDir)) {
        const m = f.match(/^(\d+)\.json$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > this.outboxSeq)
            this.outboxSeq = n;
        }
      }
    } catch {
    }
  }
  // ----- introspection ------------------------------------------------------
  stats() {
    let dirty = 0;
    for (const st of this.states.values()) {
      if (st.dirty)
        dirty++;
    }
    let outbox = 0;
    try {
      outbox = fs.readdirSync(this.outboxDir).filter((f) => f.endsWith(".json")).length;
    } catch {
    }
    return { dirtyKeys: dirty, queuedOutbox: outbox, lastSyncAt: this.lastSyncAt, namespaces: this.schemas.size };
  }
  markSyncedAt(t) {
    this.lastSyncAt = t;
  }
  getRegisteredNs() {
    return Array.from(this.schemas.keys());
  }
  getSchema(ns) {
    return this.schemas.get(ns);
  }
  // ----- registration -------------------------------------------------------
  register(ns, schema) {
    if (!ns || typeof ns !== "string")
      throw new Error("qg.register: bad ns");
    if (!schema || !["doc", "blob", "log"].includes(schema.form))
      throw new Error("qg.register: schema.form must be doc/blob/log");
    if (typeof schema.v !== "number" || schema.v < 1)
      throw new Error("qg.register: schema.v >=1");
    const existing = this.schemas.get(ns);
    if (existing && existing.form !== schema.form)
      throw new Error(`qg.register: ns "${ns}" form mismatch`);
    this.schemas.set(ns, schema);
  }
  // ----- path helpers -------------------------------------------------------
  _payloadPath(safeNs, safeKey, form) {
    const ext = form === "doc" ? ".json" : form === "blob" ? ".bin" : ".log";
    return path.join(this.nsDir, safeNs, safeKey + ext);
  }
  _lockPath(safeNs, safeKey) {
    return path.join(this.locksDir, safeNs + "__" + safeKey + ".lock");
  }
  _resolveKeyState(ns, key) {
    const id = ns + "\0" + key;
    let st = this.states.get(id);
    if (!st) {
      st = {
        ns,
        key,
        safeNs: safeName(ns),
        safeKey: safeName(key),
        value: void 0,
        dirty: false,
        saveChain: Promise.resolve(),
        loaded: false
      };
      this.states.set(id, st);
    }
    return st;
  }
  _requireSchema(ns) {
    const sc = this.schemas.get(ns);
    if (!sc)
      throw new Error(`qg: ns "${ns}" not registered`);
    return sc;
  }
  // ★ Invalidate directory cache for a namespace.
  _invalidateDirCache(ns) {
    this._dirCache.delete(ns);
  }
  // ----- encode / decode ----------------------------------------------------
  _encode(form, value) {
    if (form === "doc")
      return Buffer.from(JSON.stringify(value), "utf8");
    if (form === "blob") {
      const json = Buffer.from(JSON.stringify(value), "utf8");
      if (json.length <= _Qg.BLOB_NOCOMPRESS_BYTES)
        return json;
      return zlib.brotliCompressSync(json);
    }
    if (!Array.isArray(value))
      value = [];
    const lines = value.map((ev) => JSON.stringify(ev)).join("\n");
    return Buffer.from(lines + (lines ? "\n" : ""), "utf8");
  }
  _decode(form, buf) {
    if (form === "doc")
      return JSON.parse(buf.toString("utf8"));
    if (form === "blob") {
      const first = buf.length > 0 ? buf[0] : 0;
      if (first === 123 || first === 91) {
        return JSON.parse(buf.toString("utf8"));
      }
      const json = zlib.brotliDecompressSync(buf).toString("utf8");
      return JSON.parse(json);
    }
    const txt = buf.toString("utf8");
    const out = [];
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (!t)
        continue;
      try {
        out.push(JSON.parse(t));
      } catch {
      }
    }
    return out;
  }
  // ----- file lock (O_EXCL + stale detection) --------------------------------
  async _acquireLock(safeNs, safeKey) {
    const lp = this._lockPath(safeNs, safeKey);
    await fs.promises.mkdir(path.dirname(lp), { recursive: true });
    for (let i = 0; i < 40; i++) {
      try {
        const fd = fs.openSync(lp, "wx");
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: nowMs() }));
        fs.closeSync(fd);
        return lp;
      } catch (e) {
        if (e && e.code === "EEXIST") {
          let stale = false;
          try {
            const info = JSON.parse(fs.readFileSync(lp, "utf8"));
            if (typeof info.ts === "number" && nowMs() - info.ts > LOCK_STALE_MS)
              stale = true;
          } catch {
            stale = true;
          }
          if (stale) {
            try {
              fs.unlinkSync(lp);
            } catch {
            }
            continue;
          }
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        throw e;
      }
    }
    console.warn("[qg] _acquireLock timeout", lp);
    return lp;
  }
  _releaseLock(lp) {
    try {
      fs.unlinkSync(lp);
    } catch {
    }
  }
  // ----- corrupt isolation --------------------------------------------------
  _quarantine(safeNs, safeKey, form, reason) {
    try {
      const src = this._payloadPath(safeNs, safeKey, form);
      if (!fs.existsSync(src))
        return;
      const ext = path.extname(src);
      const ts = nowMs();
      const dst = path.join(this.corruptDir, safeNs + "__" + safeKey + "." + ts + ext);
      fs.mkdirSync(this.corruptDir, { recursive: true });
      fs.renameSync(src, dst);
      console.warn("[qg] quarantined", src, "->", dst, "reason=", reason);
    } catch (e) {
      console.warn("[qg] _quarantine failed:", e);
    }
  }
  // ----- load ---------------------------------------------------------------
  async _loadFromDisk(st) {
    const sc = this._requireSchema(st.ns);
    const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
    if (!fs.existsSync(payload)) {
      st.value = sc.form === "log" ? [] : null;
      st.loaded = true;
      return;
    }
    try {
      const buf = await fs.promises.readFile(payload);
      st.value = this._decode(sc.form, buf);
      if (sc.form === "log") {
        const tailPath = payload + ".tail";
        if (fs.existsSync(tailPath)) {
          try {
            const tailBuf = await fs.promises.readFile(tailPath);
            const tailEvents = this._decode(sc.form, tailBuf);
            if (Array.isArray(tailEvents) && tailEvents.length > 0) {
              if (!Array.isArray(st.value))
                st.value = [];
              st.value.push(...tailEvents);
            }
          } catch {
          }
        }
        st._logTail = [];
      }
      st.loaded = true;
    } catch (e) {
      console.warn("[qg] decode failed for", st.ns, st.key, "\u2014 quarantining:", e);
      this._quarantine(st.safeNs, st.safeKey, sc.form, String(e));
      st.value = sc.form === "log" ? [] : null;
      st.loaded = true;
    }
  }
  async _ensureLoaded(st) {
    if (!st.loaded)
      await this._loadFromDisk(st);
  }
  // ----- public API ---------------------------------------------------------
  async get(ns, key) {
    this._requireSchema(ns);
    const st = this._resolveKeyState(ns, key);
    await this._ensureLoaded(st);
    return st.value;
  }
  async set(ns, key, value) {
    const sc = this._requireSchema(ns);
    if (sc.form === "log" && !Array.isArray(value))
      throw new Error(`qg.set on log form requires array; ns=${ns} key=${key}`);
    const st = this._resolveKeyState(ns, key);
    await this._ensureLoaded(st);
    st.value = value;
    st.dirty = true;
    this._scheduleSave(st, sc);
    if (sc.cloud && this.onCloudDirty) {
      try {
        this.onCloudDirty(ns, key);
      } catch {
      }
    }
  }
  async setNow(ns, key, value) {
    const sc = this._requireSchema(ns);
    if (sc.form === "log" && !Array.isArray(value))
      throw new Error(`qg.setNow on log form requires array; ns=${ns} key=${key}`);
    const st = this._resolveKeyState(ns, key);
    await this._ensureLoaded(st);
    st.value = value;
    st.dirty = true;
    await this._flushKey(st, sc);
    if (sc.cloud && this.onCloudDirty) {
      try {
        this.onCloudDirty(ns, key);
      } catch {
      }
    }
  }
  async append(ns, key, event) {
    const sc = this._requireSchema(ns);
    if (sc.form !== "log")
      throw new Error(`qg.append only for log form; ns=${ns}`);
    const st = this._resolveKeyState(ns, key);
    await this._ensureLoaded(st);
    if (!Array.isArray(st.value))
      st.value = [];
    if (!st._logTail)
      st._logTail = [];
    st.value.push(event);
    st._logTail.push(event);
    st.dirty = true;
    const tailPath = this._payloadPath(st.safeNs, st.safeKey, sc.form) + ".tail";
    const line = JSON.stringify(event) + "\n";
    try {
      await fs.promises.mkdir(path.dirname(tailPath), { recursive: true });
      await fs.promises.appendFile(tailPath, line, "utf8");
    } catch {
    }
    this._scheduleSave(st, sc);
    if (sc.cloud && this.onCloudDirty) {
      try {
        this.onCloudDirty(ns, key);
      } catch {
      }
    }
  }
  async del(ns, key) {
    const sc = this._requireSchema(ns);
    const st = this._resolveKeyState(ns, key);
    if (st.debounceTimer) {
      clearTimeout(st.debounceTimer);
      st.debounceTimer = void 0;
    }
    const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
    let any = false;
    try {
      if (fs.existsSync(payload)) {
        await fs.promises.unlink(payload);
        any = true;
      }
    } catch {
    }
    try {
      const tp = payload + ".tail";
      if (fs.existsSync(tp))
        await fs.promises.unlink(tp);
    } catch {
    }
    this.states.delete(ns + "\0" + key);
    this._invalidateDirCache(ns);
    if (any) {
      this.emit("changed", { ns, key, value: null, deleted: true });
      if (sc.cloud)
        this._queueOutbox(ns, key, null, true);
    }
    return any;
  }
  async list(ns) {
    this._requireSchema(ns);
    const cached = this._dirCache.get(ns);
    if (cached)
      return cached;
    const dir = path.join(this.nsDir, safeName(ns));
    const out = [];
    try {
      for (const f of await fs.promises.readdir(dir)) {
        if (f.endsWith(".tmp"))
          continue;
        if (f.endsWith(".tail"))
          continue;
        const m = f.match(/^(.+)\.(json|bin|log)$/);
        if (m)
          out.push(m[1]);
      }
    } catch {
    }
    this._dirCache.set(ns, out);
    return out;
  }
  // ----- save chain ---------------------------------------------------------
  _scheduleSave(st, sc) {
    const ms = typeof sc.debounceMs === "number" ? sc.debounceMs : DEFAULT_DEBOUNCE_MS;
    if (st.debounceTimer)
      clearTimeout(st.debounceTimer);
    st.debounceTimer = setTimeout(() => {
      st.debounceTimer = void 0;
      st.saveChain = st.saveChain.then(() => this._doSaveOnce(st, sc)).catch((e) => {
        console.warn("[qg] save error", st.ns, st.key, e);
      });
    }, ms);
  }
  async _flushKey(st, sc) {
    if (st.debounceTimer) {
      clearTimeout(st.debounceTimer);
      st.debounceTimer = void 0;
    }
    st.saveChain = st.saveChain.then(() => this._doSaveOnce(st, sc));
    await st.saveChain;
  }
  async flush() {
    const tasks = [];
    for (const st of this.states.values()) {
      const sc = this.schemas.get(st.ns);
      if (!sc)
        continue;
      if (st.dirty || st.debounceTimer)
        tasks.push(this._flushKey(st, sc));
    }
    await Promise.all(tasks);
  }
  flushSync() {
    for (const st of this.states.values()) {
      const sc = this.schemas.get(st.ns);
      if (!sc)
        continue;
      if (st.debounceTimer) {
        clearTimeout(st.debounceTimer);
        st.debounceTimer = void 0;
      }
      if (!st.dirty)
        continue;
      try {
        this._doSaveOnceSync(st, sc);
      } catch (e) {
        console.warn("[qg] flushSync error", st.ns, st.key, e);
      }
    }
  }
  // ----- the actual save ----------------------------------------------------
  async _doSaveOnce(st, sc) {
    if (!st.dirty)
      return;
    const lp = await this._acquireLock(st.safeNs, st.safeKey);
    try {
      if (sc.form === "log") {
        const tailPath = this._payloadPath(st.safeNs, st.safeKey, sc.form) + ".tail";
        if (fs.existsSync(tailPath)) {
          try {
            const tailBuf = await fs.promises.readFile(tailPath);
            const tailEvents = this._decode(sc.form, tailBuf);
            if (Array.isArray(tailEvents) && tailEvents.length > 0) {
              if (!Array.isArray(st.value))
                st.value = [];
              const seen = new Set(st.value.map((e) => JSON.stringify(e)));
              for (const ev of tailEvents) {
                const k = JSON.stringify(ev);
                if (!seen.has(k)) {
                  seen.add(k);
                  st.value.push(ev);
                }
              }
            }
          } catch {
          }
        }
      }
      await this._mergeFromDisk(st, sc);
      let buf = this._encode(sc.form, st.value);
      if (sc.quotaBytes && buf.length > sc.quotaBytes) {
        if (sc.form === "log" && Array.isArray(st.value)) {
          st.value = st.value.slice(Math.floor(st.value.length / 2));
          buf = this._encode(sc.form, st.value);
        }
        if (buf.length > sc.quotaBytes)
          throw new Error("quota exceeded");
      }
      const needsCompact = sc.form === "log" && sc.compactThresholdBytes && buf.length > sc.compactThresholdBytes;
      const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
      await atomicWrite(payload, buf);
      if (sc.form === "log") {
        st._logTail = [];
        const tailPath = payload + ".tail";
        try {
          if (fs.existsSync(tailPath))
            await fs.promises.unlink(tailPath);
        } catch {
        }
      }
      st.dirty = false;
      this._invalidateDirCache(st.ns);
      if (sc.cloud)
        this._queueOutbox(st.ns, st.key, st.value, false);
      this.emit("changed", { ns: st.ns, key: st.key, value: st.value, deleted: false });
      if (needsCompact) {
        setImmediate(() => this._maybeCompact(st, sc).catch(() => {
        }));
      }
    } finally {
      this._releaseLock(lp);
    }
  }
  _doSaveOnceSync(st, sc) {
    if (!st.dirty)
      return;
    const buf = this._encode(sc.form, st.value);
    const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
    atomicWriteSync(payload, buf);
    st.dirty = false;
    this._invalidateDirCache(st.ns);
    if (sc.cloud)
      this._queueOutbox(st.ns, st.key, st.value, false);
  }
  // ----- merge-on-save ------------------------------------------------------
  async _mergeFromDisk(st, sc) {
    const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
    if (!fs.existsSync(payload))
      return;
    let diskVal;
    try {
      diskVal = this._decode(sc.form, await fs.promises.readFile(payload));
    } catch {
      return;
    }
    try {
      if (sc.form === "log" && Array.isArray(diskVal) && Array.isArray(st.value)) {
        const seen = /* @__PURE__ */ new Set();
        const out = [];
        for (const ev of diskVal) {
          const k = JSON.stringify(ev);
          if (!seen.has(k)) {
            seen.add(k);
            out.push(ev);
          }
        }
        for (const ev of st.value) {
          const k = JSON.stringify(ev);
          if (!seen.has(k)) {
            seen.add(k);
            out.push(ev);
          }
        }
        st.value = sc.merger ? sc.merger(diskVal, st.value, { ns: st.ns, key: st.key }) : out;
      } else {
        st.value = sc.merger ? sc.merger(diskVal, st.value, { ns: st.ns, key: st.key }) : st.value;
      }
    } catch (e) {
      console.warn("[qg] merger threw \u2014 keeping in-memory value", st.ns, st.key, e);
    }
  }
  // ----- log compaction -----------------------------------------------------
  _compactLog(st, sc) {
    if (!Array.isArray(st.value))
      return null;
    if (sc.merger) {
      try {
        const compacted = sc.merger([], st.value, { ns: st.ns, key: st.key });
        if (Array.isArray(compacted))
          return compacted;
      } catch (e) {
        console.warn("[qg] compactLog merger threw", st.ns, st.key, e);
      }
    }
    return st.value.slice(Math.floor(st.value.length / 2));
  }
  /** ★ Async log compaction — non-blocking, runs after save completes. */
  async _maybeCompact(st, sc) {
    if (!Array.isArray(st.value))
      return;
    const compacted = this._compactLog(st, sc);
    if (!compacted)
      return;
    st.value = compacted;
    st.dirty = true;
    const buf = this._encode(sc.form, st.value);
    const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
    await atomicWrite(payload, buf);
    st.dirty = false;
    this._invalidateDirCache(st.ns);
    if (sc.cloud)
      this._queueOutbox(st.ns, st.key, st.value, false);
  }
  // ----- outbox (cloud-sync queue) ------------------------------------------
  _queueOutbox(ns, key, value, deleted) {
    try {
      this.outboxSeq += 1;
      const seq = String(this.outboxSeq).padStart(12, "0");
      const f = path.join(this.outboxDir, seq + ".json");
      const payload = { seq, ns, key, ts: nowMs(), deleted, value: deleted ? null : value };
      atomicWriteSync(f, JSON.stringify(payload));
    } catch (e) {
      console.warn("[qg] _queueOutbox failed:", e);
    }
  }
  listOutbox() {
    const out = [];
    try {
      const files = fs.readdirSync(this.outboxDir).filter((f) => f.endsWith(".json")).sort();
      for (const f of files)
        out.push({ seq: f.replace(/\.json$/, ""), file: path.join(this.outboxDir, f) });
    } catch {
    }
    return out;
  }
  dropOutbox(seq) {
    const f = path.join(this.outboxDir, seq + ".json");
    try {
      fs.unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  }
  // ----- onChange convenience -----------------------------------------------
  onChange(ns, key, cb) {
    const h = (msg) => {
      if (msg.ns === ns && msg.key === key)
        cb(msg.value, msg.deleted);
    };
    this.on("changed", h);
    return () => {
      this.off("changed", h);
    };
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Qg
});
