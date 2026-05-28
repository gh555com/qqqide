"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// shell/portable-paths.ts
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
function getAppRoot() {
  const execLower = process.execPath.replace(/\\/g, "/").toLowerCase();
  if (execLower.includes("node_modules") || execLower.includes("electron/dist")) {
    return path.resolve(__dirname, "..");
  }
  return path.dirname(process.execPath);
}
function applyPortablePaths() {
  const root = getAppRoot();
  const userData = path.join(root, "userData");
  const cache = path.join(root, "cache");
  const temp = path.join(root, "temp");
  const logs = path.join(root, "logs");
  const crashDumps = path.join(root, "crashDumps");
  for (const d of [userData, cache, temp, logs, crashDumps]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch {
    }
  }
  let app2;
  try {
    app2 = require("electron").app;
  } catch {
    console.warn("[portable-paths] electron.app not available, skipping path redirects");
    return { root, userData, cache, logs };
  }
  if (!app2) {
    console.warn("[portable-paths] electron.app is undefined, skipping path redirects");
    return { root, userData, cache, logs };
  }
  app2.setPath("userData", userData);
  app2.setPath("sessionData", userData);
  app2.setPath("cache", cache);
  app2.setPath("temp", temp);
  app2.setPath("logs", logs);
  app2.setPath("crashDumps", crashDumps);
  try {
    app2.setAppLogsPath(logs);
  } catch {
  }
  app2.commandLine.appendSwitch("user-data-dir", userData);
  app2.commandLine.appendSwitch("disk-cache-dir", cache);
  app2.commandLine.appendSwitch("no-default-browser-check");
  app2.commandLine.appendSwitch("disable-background-networking");
  app2.commandLine.appendSwitch("disable-component-update");
  app2.commandLine.appendSwitch("disable-domain-reliability");
  app2.commandLine.appendSwitch("disable-sync");
  app2.commandLine.appendSwitch("metrics-recording-only");
  app2.commandLine.appendSwitch("disable-default-apps");
  return { root, userData, cache, logs };
}

// shell/main.ts
var import_electron3 = require("electron");
var path13 = __toESM(require("path"));
var fs14 = __toESM(require("fs"));
var os2 = __toESM(require("os"));
var http4 = __toESM(require("http"));
var https4 = __toESM(require("https"));
var import_url4 = require("url");

// shell/engines.ts
var import_child_process = require("child_process");
var path2 = __toESM(require("path"));
var fs2 = __toESM(require("fs"));
var readline = __toESM(require("readline"));
var import_events = require("events");
var EngineHost = class extends import_events.EventEmitter {
  constructor(appRoot) {
    super();
    this.appRoot = appRoot;
    this.proc = null;
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.enginePath = "";
    this.alive = false;
    this.starting = null;
  }
  /** Resolve the engine binary path for current platform/arch. */
  resolveEngineBinary() {
    const platMap = { win32: "win", linux: "linux", darwin: "mac" };
    const archMap = { x64: "x64", arm64: "arm64" };
    const plat = platMap[process.platform];
    const arch = archMap[process.arch];
    if (!plat || !arch) {
      return null;
    }
    const ext = process.platform === "win32" ? ".exe" : "";
    const searchRoots = [
      this.appRoot,
      path2.join(this.appRoot, "resources", "app")
    ];
    const tries = [];
    for (const root of searchRoots) {
      tries.push(path2.join(root, "engines", `q_${plat}_${arch}${ext}`));
      if (plat === "win" && arch === "arm64") {
        tries.push(path2.join(root, "engines", `q_win_x64${ext}`));
      }
    }
    for (const candidate of tries) {
      if (fs2.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
  /**
   * Start the engine and wait for ping handshake. Returns true if alive.
   * Non-fatal if missing or fails - caller can still operate via fallback.
   */
  async start() {
    if (this.starting) {
      return this.starting;
    }
    if (this.alive) {
      return true;
    }
    this.starting = this.doStart();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }
  async doStart() {
    const bin = this.resolveEngineBinary();
    if (!bin) {
      console.warn("[engines] no rust engine binary found, fs.* will fall back to node native");
      return false;
    }
    this.enginePath = bin;
    try {
      const proc = (0, import_child_process.spawn)(bin, ["--daemon"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, QQQ_PARENT_PID: String(process.pid) }
      });
      this.proc = proc;
      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => this.onLine(line));
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (d) => {
        const text = String(d).trim();
        if (text) {
          console.error("[engine.stderr]", text);
        }
      });
      proc.on("exit", (code) => {
        this.alive = false;
        console.warn("[engines] engine exited code=" + code);
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new Error("engine exited"));
        }
        this.pending.clear();
        this.emit("exit", code);
      });
      proc.on("error", (err) => {
        console.error("[engines] proc error:", err);
        this.alive = false;
        this.emit("error", err);
      });
      console.log("[engines] spawned:", bin, "(pid", proc.pid + ")");
      const ok = await this.handshake();
      this.alive = ok;
      if (ok) {
        console.log("[engines] handshake OK");
        this.emit("ready");
      } else {
        console.warn("[engines] handshake failed, killing engine");
        try {
          proc.kill();
        } catch {
        }
        this.proc = null;
      }
      return ok;
    } catch (e) {
      console.error("[engines] failed to start:", e);
      this.alive = false;
      return false;
    }
  }
  /** Send ping, retry up to 15 times every 200ms. */
  async handshake() {
    for (let i = 0; i < 15; i++) {
      try {
        const pong = await this.rawCall("ping", {}, 1e3);
        if (pong && pong.status === "alive") {
          return true;
        }
      } catch {
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
  onLine(line) {
    if (!line || !line.trim()) {
      return;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      try {
        msg = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
      } catch {
        console.warn("[engines] bad json:", line.slice(0, 200));
        return;
      }
    }
    if (msg._id === void 0 || msg.event) {
      this.emit("event", msg);
      return;
    }
    const cb = this.pending.get(msg._id);
    if (!cb) {
      return;
    }
    this.pending.delete(msg._id);
    clearTimeout(cb.timer);
    if (msg.error) {
      cb.reject(new Error(String(msg.error)));
    } else {
      cb.resolve(msg);
    }
  }
  /** Internal raw call (does not check this.alive; used for handshake). */
  rawCall(action, params, timeoutMs) {
    if (!this.proc || this.proc.killed) {
      return Promise.reject(new Error("engine_not_running"));
    }
    const id = ++this.nextId;
    const cmd = JSON.stringify({ _id: id, action, ...params || {} }) + "\n";
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("engine_timeout: " + action));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve2, reject, timer });
      try {
        this.proc.stdin.write(cmd);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  /**
   * Public RPC: invoke an action on the engine.
   * If engine is not alive, rejects (caller should fall back to native fs).
   */
  invoke(action, params = {}, timeoutMs = 1e4) {
    if (!this.alive) {
      return Promise.reject(new Error("engine_not_available"));
    }
    return this.rawCall(action, params, timeoutMs);
  }
  isAlive() {
    return this.alive;
  }
  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
      }
      this.proc = null;
      this.alive = false;
    }
  }
};

// shell/audio-engine.ts
var import_child_process2 = require("child_process");
var path3 = __toESM(require("path"));
var fs3 = __toESM(require("fs"));
var readline2 = __toESM(require("readline"));
var AudioEngine = class {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.proc = null;
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.alive = false;
    this.starting = null;
  }
  resolveScript() {
    const candidates = [
      path3.join(this.appRoot, "engines", "miniaudio_bridge.py"),
      path3.join(this.appRoot, "resources", "app", "engines", "miniaudio_bridge.py")
    ];
    for (const p of candidates) {
      if (fs3.existsSync(p)) {
        return p;
      }
    }
    return null;
  }
  resolvePython() {
    if (process.env.QQQ_PYTHON) {
      return process.env.QQQ_PYTHON;
    }
    return process.platform === "win32" ? "python" : "python3";
  }
  /** Start lazily on first call. */
  async ensure() {
    if (this.alive) {
      return true;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.start();
    const ok = await this.starting;
    this.starting = null;
    return ok;
  }
  async start() {
    const script = this.resolveScript();
    if (!script) {
      console.warn("[audio] miniaudio_bridge.py not found, audio disabled");
      return false;
    }
    const py = this.resolvePython();
    try {
      const proc = (0, import_child_process2.spawn)(py, ["-u", script], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        cwd: path3.dirname(script),
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" }
      });
      this.proc = proc;
      const rl = readline2.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => this.onLine(line));
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (d) => {
        const s = String(d).trim();
        if (s) {
          console.error("[audio.stderr]", s);
        }
      });
      proc.on("exit", (code) => {
        this.alive = false;
        console.warn("[audio] python exited code=" + code);
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new Error("audio_engine_exited"));
        }
        this.pending.clear();
      });
      proc.on("error", (err) => {
        console.error("[audio] proc error:", err);
        this.alive = false;
      });
      console.log("[audio] spawned:", py, script, "(pid", proc.pid + ")");
      for (let i = 0; i < 5; i++) {
        try {
          const pong = await this.rawCall("ping", {}, 1500);
          if (pong && pong.status === "alive") {
            this.alive = true;
            console.log("[audio] handshake OK");
            return true;
          }
        } catch {
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      console.warn("[audio] handshake failed, killing");
      try {
        proc.kill();
      } catch {
      }
      this.proc = null;
      return false;
    } catch (e) {
      console.error("[audio] failed to start:", e);
      return false;
    }
  }
  onLine(line) {
    if (!line || !line.trim()) {
      return;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg._id === void 0) {
      return;
    }
    const cb = this.pending.get(msg._id);
    if (!cb) {
      return;
    }
    this.pending.delete(msg._id);
    clearTimeout(cb.timer);
    if (msg.error) {
      cb.reject(new Error(String(msg.error)));
    } else {
      cb.resolve(msg);
    }
  }
  rawCall(action, params, timeoutMs) {
    if (!this.proc || this.proc.killed) {
      return Promise.reject(new Error("audio_engine_not_running"));
    }
    const id = ++this.nextId;
    const cmd = JSON.stringify({ _id: id, action, ...params || {} }) + "\n";
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("audio_timeout: " + action));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve2, reject, timer });
      try {
        this.proc.stdin.write(cmd);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async invoke(action, params = {}, timeoutMs = 1e4) {
    const ok = await this.ensure();
    if (!ok) {
      throw new Error("audio_engine_unavailable");
    }
    return this.rawCall(action, params, timeoutMs);
  }
  isAlive() {
    return this.alive;
  }
  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
      }
      this.proc = null;
      this.alive = false;
    }
  }
};

// shell/menu-builder.ts
var import_electron = require("electron");
function toElectronTemplate(items, win) {
  return items.map((it) => {
    if (it.type === "separator") {
      return { type: "separator" };
    }
    const out = {
      label: it.label,
      type: it.type,
      enabled: it.enabled !== false
    };
    if (it.role) {
      out.role = it.role;
    }
    if (it.accel) {
      out.accelerator = it.accel;
    }
    if (it.checked !== void 0) {
      out.checked = it.checked;
    }
    if (it.sub && it.sub.length > 0) {
      out.submenu = toElectronTemplate(it.sub, win);
    } else if (it.cmd) {
      const cmd = it.cmd;
      out.click = () => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("qqq:menu:fired", cmd);
        }
      };
    }
    return out;
  });
}
function applyMenuSchema(schema, win) {
  if (!schema || !schema.items || schema.items.length === 0) {
    import_electron.Menu.setApplicationMenu(null);
    return;
  }
  const tpl = toElectronTemplate(schema.items, win);
  const menu = import_electron.Menu.buildFromTemplate(tpl);
  import_electron.Menu.setApplicationMenu(menu);
}

// shell/monaco-host.ts
var import_electron2 = require("electron");
var MonacoHost = class {
  constructor() {
    this.nextId = 1;
    this.instances = /* @__PURE__ */ new Map();
  }
  register() {
    import_electron2.ipcMain.handle("qqq:monaco:create", (_e, _opts) => {
      const h = { id: this.nextId++, file: null };
      this.instances.set(h.id, h);
      return h.id;
    });
    import_electron2.ipcMain.handle("qqq:monaco:open", (_e, id, file) => {
      const h = this.instances.get(id);
      if (!h) {
        return false;
      }
      h.file = file;
      return true;
    });
    import_electron2.ipcMain.handle("qqq:monaco:save", (_e, id) => {
      const h = this.instances.get(id);
      return !!h;
    });
    import_electron2.ipcMain.handle("qqq:monaco:dispose", (_e, id) => {
      return this.instances.delete(id);
    });
  }
};

// shell/main.ts
var import_child_process6 = require("child_process");

// shell/qz-spawn.ts
var import_child_process3 = require("child_process");
var path4 = __toESM(require("path"));
var fs4 = __toESM(require("fs"));
function resolveGhrunBin(appRoot) {
  const env = process.env.QDIR_GHRUN;
  if (env && fs4.existsSync(env)) {
    return env;
  }
  const qdir = process.env.QDIR;
  if (qdir) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const p = path4.join(qdir, "ghrun" + ext);
    if (fs4.existsSync(p)) {
      return p;
    }
  }
  if (appRoot) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const p = path4.join(appRoot, "engines", "ghrun" + ext);
    if (fs4.existsSync(p)) {
      return p;
    }
  }
  return null;
}
function resolveRunner(appRoot) {
  const candidates = [
    path4.join(appRoot, "engines", "runner.py"),
    path4.join(appRoot, "resources", "app", "engines", "runner.py")
  ];
  for (const p of candidates) {
    if (fs4.existsSync(p)) {
      const py = process.env.QQQ_PYTHON || (process.platform === "win32" ? "python" : "python3");
      return { script: p, python: py };
    }
  }
  return null;
}
function nodeTier(brief, appRoot) {
  return new Promise((resolve2) => {
    const start = Date.now();
    const args = brief.args || [];
    const timeoutMs = brief.timeout && brief.timeout > 0 ? brief.timeout : 6e4;
    const stallMs = brief.stallMs && brief.stallMs > 0 ? brief.stallMs : 0;
    const capture = brief.captureOutput !== false;
    const inheritEnv = brief.inheritEnv !== false;
    const useShell = brief.shell === true;
    const env = inheritEnv ? { ...process.env, ...brief.env || {} } : { ...brief.env || {} };
    let proc;
    try {
      proc = (0, import_child_process3.spawn)(brief.cmd, args, {
        cwd: brief.cwd || appRoot,
        windowsHide: true,
        shell: useShell,
        env,
        detached: process.platform !== "win32"
        // POSIX: own process group
      });
    } catch (err) {
      return resolve2({
        exitCode: -1,
        stdout: "",
        stderr: String(err && err.message || err),
        killReason: "spawn-error",
        tier: "node",
        durationMs: Date.now() - start
      });
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    let killReason = "";
    let lastIOAt = Date.now();
    const killTree = () => {
      if (!proc.pid) {
        return;
      }
      try {
        if (process.platform === "win32") {
          (0, import_child_process3.spawn)("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true });
        } else {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            try {
              proc.kill("SIGKILL");
            } catch {
            }
          }
        }
      } catch {
      }
    };
    if (capture && proc.stdout) {
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (d) => {
        stdout += d;
        lastIOAt = Date.now();
      });
    }
    if (capture && proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (d) => {
        stderr += d;
        lastIOAt = Date.now();
      });
    }
    const deadlineTimer = setTimeout(() => {
      killed = true;
      killReason = "deadline";
      killTree();
    }, timeoutMs);
    let stallTimer = null;
    if (stallMs > 0) {
      const tick = () => {
        if (killed) {
          return;
        }
        if (Date.now() - lastIOAt > stallMs) {
          killed = true;
          killReason = "stall";
          killTree();
          return;
        }
        stallTimer = setTimeout(tick, Math.max(1e3, Math.floor(stallMs / 4)));
      };
      stallTimer = setTimeout(tick, Math.max(1e3, Math.floor(stallMs / 4)));
    }
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      if (stallTimer) {
        clearTimeout(stallTimer);
      }
    };
    proc.on("exit", (code) => {
      cleanup();
      const extra = killed ? `
[killed: ${killReason} after ${Date.now() - start}ms]` : "";
      resolve2({
        exitCode: killed ? -1 : code ?? -1,
        stdout,
        stderr: stderr + extra,
        killReason,
        tier: "node",
        pid: proc.pid,
        durationMs: Date.now() - start
      });
    });
    proc.on("error", (err) => {
      cleanup();
      resolve2({
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + (err.message || String(err)),
        killReason: "spawn-error",
        tier: "node",
        pid: proc.pid,
        durationMs: Date.now() - start
      });
    });
  });
}
function runnerTier(brief, appRoot, resolved) {
  return new Promise((resolve2) => {
    const start = Date.now();
    const timeoutMs = brief.timeout && brief.timeout > 0 ? brief.timeout : 6e4;
    const guardMs = timeoutMs + 5e3;
    let proc;
    try {
      proc = (0, import_child_process3.spawn)(resolved.python, ["-u", resolved.script], {
        cwd: appRoot,
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
        detached: process.platform !== "win32"
      });
    } catch (err) {
      return resolve2({
        exitCode: -1,
        stdout: "",
        stderr: String(err && err.message || err),
        killReason: "spawn-error",
        tier: "runner",
        durationMs: Date.now() - start
      });
    }
    let outBuf = "";
    let errBuf = "";
    let killed = false;
    let resolved2 = false;
    const safeResolve = (r) => {
      if (resolved2) {
        return;
      }
      resolved2 = true;
      clearTimeout(guardTimer);
      try {
        proc.kill();
      } catch {
      }
      resolve2(r);
    };
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      outBuf += d;
      const nl = outBuf.indexOf("\n");
      if (nl >= 0) {
        const line = outBuf.slice(0, nl);
        try {
          const r = JSON.parse(line);
          safeResolve({
            exitCode: typeof r.exitCode === "number" ? r.exitCode : -1,
            stdout: String(r.stdout || ""),
            stderr: String(r.stderr || ""),
            killReason: r.killReason || "",
            tier: "runner",
            pid: proc.pid,
            durationMs: Date.now() - start
          });
        } catch (e) {
          safeResolve({
            exitCode: -1,
            stdout: "",
            stderr: "runner_bad_json: " + line.slice(0, 200),
            killReason: "spawn-error",
            tier: "runner",
            durationMs: Date.now() - start
          });
        }
      }
    });
    proc.stderr.on("data", (d) => {
      errBuf += d;
    });
    proc.on("exit", (code) => {
      if (resolved2) {
        return;
      }
      safeResolve({
        exitCode: code ?? -1,
        stdout: "",
        stderr: errBuf || "runner_no_result",
        killReason: killed ? "deadline" : "",
        tier: "runner",
        pid: proc.pid,
        durationMs: Date.now() - start
      });
    });
    proc.on("error", (err) => {
      safeResolve({
        exitCode: -1,
        stdout: "",
        stderr: String(err.message || err),
        killReason: "spawn-error",
        tier: "runner",
        pid: proc.pid,
        durationMs: Date.now() - start
      });
    });
    const guardTimer = setTimeout(() => {
      killed = true;
      safeResolve({
        exitCode: -1,
        stdout: "",
        stderr: "runner_guard_timeout",
        killReason: "deadline",
        tier: "runner",
        pid: proc.pid,
        durationMs: Date.now() - start
      });
    }, guardMs);
    try {
      const payload = JSON.stringify({
        cmd: brief.cmd,
        args: brief.args || [],
        cwd: brief.cwd || appRoot,
        env: brief.env || null,
        timeout: timeoutMs,
        stallMs: brief.stallMs || 0,
        captureOutput: brief.captureOutput !== false,
        inheritEnv: brief.inheritEnv !== false,
        shell: brief.shell === true
      }) + "\n";
      proc.stdin.write(payload);
      proc.stdin.end();
    } catch (err) {
      safeResolve({
        exitCode: -1,
        stdout: "",
        stderr: String(err.message || err),
        killReason: "spawn-error",
        tier: "runner",
        pid: proc.pid,
        durationMs: Date.now() - start
      });
    }
  });
}
function ghrunTier(brief, appRoot, ghrunBin) {
  return new Promise((resolve2) => {
    const start = Date.now();
    const timeoutMs = brief.timeout && brief.timeout > 0 ? brief.timeout : 6e4;
    const guardMs = timeoutMs + 5e3;
    const payload = JSON.stringify({
      cmd: brief.cmd,
      args: brief.args || [],
      cwd: brief.cwd || appRoot,
      env: brief.env || null,
      timeout: timeoutMs,
      stallMs: brief.stallMs || 0,
      captureOutput: brief.captureOutput !== false
    });
    let proc;
    try {
      proc = (0, import_child_process3.spawn)(ghrunBin, ["spawn", "--json"], {
        cwd: appRoot,
        windowsHide: true,
        env: { ...process.env }
      });
    } catch (err) {
      return resolve2({
        exitCode: -1,
        stdout: "",
        stderr: String(err && err.message || err),
        killReason: "spawn-error",
        tier: "ghrun",
        durationMs: Date.now() - start
      });
    }
    let outBuf = "";
    let errBuf = "";
    let done = false;
    const finish = (r) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(guard);
      try {
        proc.kill();
      } catch {
      }
      resolve2(r);
    };
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      outBuf += d;
    });
    proc.stderr.on("data", (d) => {
      errBuf += d;
    });
    proc.on("exit", (code) => {
      if (done) {
        return;
      }
      const nl = outBuf.indexOf("\n");
      const line = nl >= 0 ? outBuf.slice(0, nl) : outBuf;
      try {
        const r = JSON.parse(line);
        finish({
          exitCode: typeof r.exitCode === "number" ? r.exitCode : code ?? -1,
          stdout: String(r.stdout || ""),
          stderr: String(r.stderr || ""),
          killReason: r.killReason || "",
          tier: "ghrun",
          pid: proc.pid,
          durationMs: Date.now() - start
        });
      } catch {
        finish({
          exitCode: code ?? -1,
          stdout: outBuf,
          stderr: errBuf || "ghrun_bad_json",
          killReason: "spawn-error",
          tier: "ghrun",
          pid: proc.pid,
          durationMs: Date.now() - start
        });
      }
    });
    proc.on("error", (err) => finish({
      exitCode: -1,
      stdout: "",
      stderr: String(err.message || err),
      killReason: "spawn-error",
      tier: "ghrun",
      pid: proc.pid,
      durationMs: Date.now() - start
    }));
    const guard = setTimeout(() => finish({
      exitCode: -1,
      stdout: "",
      stderr: "ghrun_guard_timeout",
      killReason: "deadline",
      tier: "ghrun",
      pid: proc.pid,
      durationMs: Date.now() - start
    }), guardMs);
    try {
      proc.stdin.write(payload + "\n");
      proc.stdin.end();
    } catch (err) {
      finish({
        exitCode: -1,
        stdout: "",
        stderr: String(err.message || err),
        killReason: "spawn-error",
        tier: "ghrun",
        pid: proc.pid,
        durationMs: Date.now() - start
      });
    }
  });
}
var QzSpawn = class {
  constructor(appRoot) {
    this.appRoot = appRoot;
  }
  /** Probe ghrun availability (synchronous file check). */
  ghrunAlive() {
    return !!resolveGhrunBin(this.appRoot);
  }
  /** Probe runner.py availability. */
  runnerAlive() {
    return !!resolveRunner(this.appRoot);
  }
  /**
   * Locate a command in $PATH (synchronous, posix `command -v` equivalent).
   * Returns absolute path or null if not found.
   */
  which(cmd) {
    if (!cmd) {
      return null;
    }
    if (path4.isAbsolute(cmd)) {
      return fs4.existsSync(cmd) ? cmd : null;
    }
    const dirs = (process.env.PATH || "").split(path4.delimiter).filter(Boolean);
    const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.BAT;.CMD;.COM").split(";").filter(Boolean) : [""];
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path4.join(dir, cmd + ext);
        try {
          if (fs4.statSync(p).isFile()) {
            return p;
          }
        } catch {
        }
      }
    }
    return null;
  }
  /** Unified spawn entry. Tries ghrun → runner.py → node child_process. */
  async spawn(brief) {
    if (!brief || !brief.cmd) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: "qz.spawn: missing brief.cmd",
        killReason: "spawn-error",
        tier: "node",
        durationMs: 0
      };
    }
    const ghrun = resolveGhrunBin(this.appRoot);
    if (ghrun) {
      try {
        const r = await ghrunTier(brief, this.appRoot, ghrun);
        if (r.killReason !== "spawn-error") {
          return r;
        }
        console.warn("[qz] ghrun spawn-error, falling back to runner:", r.stderr.slice(0, 200));
      } catch (e) {
        console.warn("[qz] ghrun threw, falling back to runner:", e && e.message);
      }
    }
    const runner = resolveRunner(this.appRoot);
    if (runner) {
      try {
        const r = await runnerTier(brief, this.appRoot, runner);
        if (r.killReason !== "spawn-error") {
          return r;
        }
        console.warn("[qz] runner spawn-error, falling back to node:", r.stderr.slice(0, 200));
      } catch (e) {
        console.warn("[qz] runner threw, falling back to node:", e && e.message);
      }
    }
    return nodeTier(brief, this.appRoot);
  }
  /** Spawn a long-lived process with persistent stdin/stdout.
   *  Used by LSP bridge — process stays alive, messages flow bidirectionally. */
  spawnPersist(brief) {
    if (!brief || !brief.cmd) {
      console.error("[qz] spawnPersist: missing brief.cmd");
      return null;
    }
    const args = brief.args || [];
    const cwd = brief.cwd || this.appRoot;
    const inheritEnv = brief.inheritEnv !== false;
    const env = inheritEnv ? { ...process.env, ...brief.env || {} } : { ...brief.env || {} };
    const idleTimeout = brief.idleTimeout || 0;
    let proc;
    try {
      proc = (0, import_child_process3.spawn)(brief.cmd, args, {
        cwd,
        windowsHide: true,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      console.error("[qz] spawnPersist error:", err?.message || err);
      return null;
    }
    if (!proc.stdin || !proc.stdout) {
      console.error("[qz] spawnPersist: no stdio pipes");
      try {
        proc.kill();
      } catch {
      }
      return null;
    }
    const dataHandlers = [];
    const stderrHandlers = [];
    const exitHandlers = [];
    let alive = true;
    let lastDataAt = Date.now();
    let idleTimer = null;
    if (idleTimeout > 0) {
      const tick = () => {
        if (!alive)
          return;
        if (Date.now() - lastDataAt > idleTimeout) {
          console.warn("[qz] spawnPersist idle timeout, killing:", brief.cmd);
          try {
            proc.kill();
          } catch {
          }
          return;
        }
        idleTimer = setTimeout(tick, Math.max(5e3, Math.floor(idleTimeout / 4)));
      };
      idleTimer = setTimeout(tick, Math.max(5e3, Math.floor(idleTimeout / 4)));
    }
    let stdoutBuf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      lastDataAt = Date.now();
      stdoutBuf += chunk;
      while (stdoutBuf.length > 0) {
        const lspMatch = stdoutBuf.match(/^Content-Length: (\d+)\r\n\r\n/);
        if (lspMatch) {
          const headerLen = lspMatch[0].length;
          const bodyLen = parseInt(lspMatch[1], 10);
          if (isNaN(bodyLen) || bodyLen > 50 * 1024 * 1024) {
            stdoutBuf = "";
            break;
          }
          if (stdoutBuf.length >= headerLen + bodyLen) {
            const body = stdoutBuf.slice(headerLen, headerLen + bodyLen);
            stdoutBuf = stdoutBuf.slice(headerLen + bodyLen);
            for (const h of dataHandlers) {
              h(body);
            }
            continue;
          } else {
            break;
          }
        }
        const nl = stdoutBuf.indexOf("\n");
        if (nl >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line.trim()) {
            for (const h of dataHandlers) {
              h(line);
            }
          }
          continue;
        }
        break;
      }
    });
    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk) => {
        lastDataAt = Date.now();
        for (const h of stderrHandlers) {
          h(chunk);
        }
      });
    }
    proc.on("exit", (code) => {
      alive = false;
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      for (const h of exitHandlers) {
        h(code);
      }
    });
    proc.on("error", (err) => {
      console.error("[qz] spawnPersist process error:", err?.message || err);
      alive = false;
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      for (const h of exitHandlers) {
        h(-1);
      }
    });
    const handle = {
      pid: proc.pid || 0,
      alive: () => alive,
      send: (line) => {
        if (!alive || !proc.stdin)
          return;
        try {
          proc.stdin.write(line + "\n");
        } catch (e) {
          console.error("[qz] spawnPersist write error:", e);
        }
      },
      onData: (handler) => {
        dataHandlers.push(handler);
      },
      onStderr: (handler) => {
        stderrHandlers.push(handler);
      },
      onExit: (handler) => {
        exitHandlers.push(handler);
      },
      shutdown: async () => {
        if (!alive)
          return;
        try {
          proc.stdin?.end();
        } catch {
        }
        await new Promise((resolve2) => {
          const t = setTimeout(() => {
            try {
              proc.kill();
            } catch {
            }
            resolve2();
          }, 5e3);
          proc.on("exit", () => {
            clearTimeout(t);
            resolve2();
          });
        });
      },
      kill: () => {
        if (!alive)
          return;
        alive = false;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        try {
          proc.kill();
        } catch {
        }
      }
    };
    return handle;
  }
};

// shell/lsp-bridge.ts
var import_child_process4 = require("child_process");
var net = __toESM(require("net"));
var path5 = __toESM(require("path"));
var fs5 = __toESM(require("fs"));
var LSP_REGISTRY = {
  python: { component: "lsp/pyright", args: ["--stdio"], languageId: "python", fileExtensions: [".py", ".pyw"] },
  go: { component: "lsp/gopls", args: [], languageId: "go", fileExtensions: [".go"] },
  rust: { component: "lsp/rust-analyzer", args: [], languageId: "rust", fileExtensions: [".rs"] },
  c: { component: "lsp/clangd", args: [], languageId: "c", fileExtensions: [".c", ".h"] },
  cpp: { component: "lsp/clangd", args: [], languageId: "cpp", fileExtensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx"] }
};
function detectLanguage(filePath) {
  const ext = path5.extname(filePath).toLowerCase();
  const monacoBuiltins = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".json": "json",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".less": "less"
  };
  if (ext in monacoBuiltins)
    return null;
  for (const [lang, cfg] of Object.entries(LSP_REGISTRY)) {
    if (cfg.fileExtensions.includes(ext))
      return lang;
  }
  return null;
}
var nextId = 1;
var LSP_PORT_MAP = {
  "go": 9801,
  // gopls
  "python": 9802,
  // pyright
  "c": 9803,
  // clangd
  "cpp": 9803,
  // clangd (same process)
  "rust": 9804
  // rust-analyzer
};
var TcpLspTransport = class {
  constructor(port, host = "127.0.0.1") {
    this.buffer = "";
    this.dataCbs = [];
    this.exitCbs = [];
    this.stderrCbs = [];
    this.socket = net.createConnection({ port, host });
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const m = this.buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
        if (!m)
          break;
        const len = parseInt(m[1], 10);
        if (isNaN(len) || len > 50 * 1024 * 1024) {
          this.buffer = "";
          return;
        }
        const headerEnd = m[0].length;
        if (this.buffer.length < headerEnd + len)
          break;
        const body = this.buffer.slice(headerEnd, headerEnd + len);
        this.buffer = this.buffer.slice(headerEnd + len);
        for (const cb of this.dataCbs) {
          try {
            cb(body);
          } catch (e) {
          }
        }
      }
    });
    this.socket.on("error", (err) => {
      for (const cb of this.stderrCbs) {
        try {
          cb("[tcp] " + err.message);
        } catch (e) {
        }
      }
    });
    this.socket.on("close", () => {
      for (const cb of this.exitCbs) {
        try {
          cb(null);
        } catch (e) {
        }
      }
    });
  }
  send(data) {
    this.socket.write(data);
  }
  onData(cb) {
    this.dataCbs.push(cb);
  }
  onStderr(cb) {
    this.stderrCbs.push(cb);
  }
  onExit(cb) {
    this.exitCbs.push(cb);
  }
  async shutdown() {
    this.socket.destroy();
  }
};
var LspInstance = class {
  constructor(handle, lang, cfg) {
    this.pending = /* @__PURE__ */ new Map();
    this.openDocs = /* @__PURE__ */ new Set();
    this.serverCapabilities = null;
    this.initResult = null;
    this.initDone = false;
    this.handle = handle;
    this.lang = lang;
    this.cfg = cfg;
    this.handle.onData((data) => {
      try {
        const msg = JSON.parse(data);
        this._onMessage(msg);
      } catch (e) {
        console.warn("[lsp] bad JSON from", lang, ":", String(data).slice(0, 200));
      }
    });
    this.handle.onStderr((data) => {
      console.warn("[lsp]", lang, "stderr:", data.slice(0, 500));
    });
    this.handle.onExit((code) => {
      console.warn("[lsp]", lang, "exited with code", code);
      for (const [id, pr] of this.pending) {
        clearTimeout(pr.timer);
        pr.reject(new Error(`LSP server ${lang} exited (code ${code})`));
      }
      this.pending.clear();
    });
  }
  _onMessage(msg) {
    if (msg.id !== void 0 && this.pending.has(msg.id)) {
      const pr = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pr.timer);
      if (msg.error) {
        pr.reject(new Error(msg.error.message || "LSP error"));
      } else {
        pr.resolve(msg.result);
      }
      return;
    }
    if (msg.method && this.onNotification) {
      this.onNotification(msg.method, msg.params);
    }
  }
  /** Send a request and wait for response (with 30s timeout). */
  async request(method, params) {
    if (!this.initDone && method !== "initialize" && method !== "initialized") {
      throw new Error(`LSP ${this.lang}: not initialized yet`);
    }
    const id = nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    const body = JSON.stringify(msg);
    this.handle.send(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r
\r
${body}`);
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP ${this.lang} request '${method}' timed out`));
      }, 3e4);
      this.pending.set(id, { resolve: resolve2, reject, timer });
    });
  }
  /** Send a notification (no response expected). */
  notify(method, params) {
    const msg = { jsonrpc: "2.0", method, params };
    const body = JSON.stringify(msg);
    this.handle.send(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r
\r
${body}`);
  }
  /** Initialize the LSP session. Must be called before any document operations. */
  async initialize(rootUri) {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didChange: 2 },
          // incremental
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: {},
          references: {},
          documentSymbol: {}
        }
      },
      initializationOptions: void 0
    });
    this.serverCapabilities = result.capabilities;
    this.initResult = result;
    this.notify("initialized", {});
    this.initDone = true;
    console.log("[lsp]", this.lang, "initialized:", Object.keys(result.capabilities || {}).join(", "));
  }
  async openDocument(filePath, text) {
    if (this.openDocs.has(filePath))
      return;
    this.openDocs.add(filePath);
    const uri = filePathToUri(filePath);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.cfg.languageId, version: 1, text }
    });
  }
  async changeDocument(filePath, changes, version) {
    const uri = filePathToUri(filePath);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: changes
    });
  }
  async closeDocument(filePath) {
    if (!this.openDocs.has(filePath))
      return;
    this.openDocs.delete(filePath);
    this.notify("textDocument/didClose", {
      textDocument: { uri: filePathToUri(filePath) }
    });
  }
  /** Request hover info at a position (textDocument/hover). */
  async hover(filePath, line, character) {
    const uri = filePathToUri(filePath);
    return this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character }
    });
  }
  async shutdown() {
    try {
      await this.request("shutdown");
    } catch {
    }
    this.notify("exit", {});
    await this.handle.shutdown();
  }
};
var LspBridge = class _LspBridge {
  constructor(appRoot) {
    this.instances = /* @__PURE__ */ new Map();
    this.targets = /* @__PURE__ */ new Set();
    this.diagnosticsCache = /* @__PURE__ */ new Map();
    // uri → diagnostics[]
    /** Resolved binary paths: lang → full path */
    this.binPaths = /* @__PURE__ */ new Map();
    /** Open document count per language (for idle shutdown). */
    this.docCounts = /* @__PURE__ */ new Map();
    /** Idle shutdown timers per language. */
    this.idleTimers = /* @__PURE__ */ new Map();
    this.appRoot = appRoot;
    this.qz = new QzSpawn(appRoot);
  }
  static {
    /** Kill LSP after 5 minutes with zero open docs. */
    this.IDLE_SHUTDOWN_MS = 3e5;
  }
  /** Resolve TCP port for an LSP language (mirrors ghrun lsp_daemon.rs port_for). */
  resolvePort(lang) {
    return LSP_PORT_MAP[lang] || 0;
  }
  /** Try to connect to ghrun LSP daemon via TCP. Returns transport or null. */
  tryConnectTcp(lang) {
    const port = this.resolvePort(lang);
    if (port <= 0)
      return null;
    try {
      const t = new TcpLspTransport(port);
      console.log("[lsp] TCP connected to", lang, "on port", port);
      return t;
    } catch (e) {
      console.warn("[lsp] TCP connect to", lang, "port", port, "failed:", e.message);
      return null;
    }
  }
  /** Add a renderer target for diagnostics push (one per BrowserWindow). */
  addTarget(wc) {
    this.targets.add(wc);
    for (const [uri, diagnostics] of this.diagnosticsCache) {
      if (!wc.isDestroyed()) {
        wc.send("qqq:lsp:diagnostics", { uri, diagnostics });
      }
    }
  }
  /** Remove a renderer target (window closed). */
  removeTarget(wc) {
    this.targets.delete(wc);
  }
  /**
   * Resolve LSP binary path via ghrun `which` command.
   * Returns null if ghrun is not available or component not found.
   */
  resolveGhrunWhich(component) {
    const ghrunBin = this.findGhrun();
    if (!ghrunBin)
      return null;
    try {
      const result = (0, import_child_process4.spawnSync)(ghrunBin, ["which", component], {
        windowsHide: true,
        timeout: 5e3
      });
      if (result.status === 0 && result.stdout) {
        const line = result.stdout.toString("utf8").split("\n")[0];
        const parsed = JSON.parse(line);
        if (parsed.event === "which" && parsed.path) {
          return parsed.path;
        }
      }
    } catch (e) {
      console.warn("[lsp] ghrun which failed:", e);
    }
    return null;
  }
  /** Auto-start ghrun lsp-daemon in background, then retry TCP connect. */
  async tryAutoStartDaemon() {
    const ghrunBin = this.findGhrun();
    if (!ghrunBin)
      return;
    try {
      const proc = (0, import_child_process4.spawn)(ghrunBin, ["lsp-daemon"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      proc.unref();
      await new Promise((r) => setTimeout(r, 500));
      console.log("[lsp] auto-started ghrun lsp-daemon");
    } catch (e) {
      console.warn("[lsp] failed to auto-start ghrun daemon:", e.message);
    }
  }
  findGhrun() {
    const env = process.env.QDIR_GHRUN;
    if (env && fs5.existsSync(env))
      return env;
    const qdir = process.env.QDIR;
    if (qdir) {
      const ext2 = process.platform === "win32" ? ".exe" : "";
      const p2 = path5.join(qdir, "ghrun" + ext2);
      if (fs5.existsSync(p2))
        return p2;
    }
    const ext = process.platform === "win32" ? ".exe" : "";
    const p = path5.join(this.appRoot, "engines", "ghrun" + ext);
    if (fs5.existsSync(p))
      return p;
    return null;
  }
  /** Start LSP for a language. TCP (ghrun daemon) first, fallback to direct spawn. */
  async startLanguage(lang, rootUri) {
    if (this.instances.has(lang))
      return true;
    const cfg = LSP_REGISTRY[lang];
    if (!cfg) {
      console.warn("[lsp] no LSP config for language:", lang);
      return false;
    }
    const tryTcpInit = async (transport) => {
      const instance2 = new LspInstance(transport, lang, cfg);
      this.instances.set(lang, instance2);
      instance2.onNotification = (method, params) => {
        if (method === "textDocument/publishDiagnostics" && params && params.uri) {
          const filePath = uriToFilePath(params.uri);
          this.updateDiagnostics(filePath, params.diagnostics || []);
        }
      };
      try {
        await instance2.initialize(rootUri);
        return true;
      } catch (e) {
        console.warn("[lsp] TCP init failed for", lang, ":", e.message);
        instance2.shutdown().catch(() => {
        });
        this.instances.delete(lang);
        return false;
      }
    };
    const tcpTransport = this.tryConnectTcp(lang);
    if (tcpTransport && await tryTcpInit(tcpTransport))
      return true;
    await this.tryAutoStartDaemon();
    const retryTransport = this.tryConnectTcp(lang);
    if (retryTransport && await tryTcpInit(retryTransport))
      return true;
    let binPath = this.binPaths.get(lang);
    if (!binPath) {
      binPath = this.resolveGhrunWhich(cfg.component);
      if (!binPath) {
        const qdir = process.env.QDIR;
        if (qdir) {
          const dirName = cfg.component.replace("/", "_");
          const ext = process.platform === "win32" ? ".exe" : "";
          const guessedBin = cfg.component.split("/").pop() + ext;
          const probePaths = [
            path5.join(qdir, "f", "components", dirName, guessedBin),
            path5.join(qdir, "f", "components", dirName, cfg.component.split("/").pop() + ext)
          ];
          for (const p of probePaths) {
            if (fs5.existsSync(p)) {
              binPath = p;
              break;
            }
          }
        }
      }
      if (!binPath) {
        const which = this.qz.which(cfg.component.split("/").pop());
        if (which)
          binPath = which;
      }
      if (binPath) {
        this.binPaths.set(lang, binPath);
      }
    }
    if (!binPath) {
      console.warn("[lsp] cannot find binary for", lang, "(component:", cfg.component, ")");
      return false;
    }
    console.log("[lsp] direct spawn", lang, "\u2192", binPath);
    const handle = this.qz.spawnPersist({
      cmd: binPath,
      args: cfg.args,
      idleTimeout: 3e5
    });
    if (!handle) {
      console.error("[lsp] spawnPersist failed for", lang);
      return false;
    }
    const instance = new LspInstance(handle, lang, cfg);
    this.instances.set(lang, instance);
    instance.onNotification = (method, params) => {
      if (method === "textDocument/publishDiagnostics" && params && params.uri) {
        const filePath = uriToFilePath(params.uri);
        this.updateDiagnostics(filePath, params.diagnostics || []);
      }
    };
    try {
      await instance.initialize(rootUri);
      return true;
    } catch (e) {
      console.error("[lsp] initialize failed for", lang, ":", e.message);
      instance.shutdown().catch(() => {
      });
      this.instances.delete(lang);
      return false;
    }
  }
  /** Stop LSP for a language. */
  async stopLanguage(lang) {
    const inst = this.instances.get(lang);
    if (!inst)
      return;
    await inst.shutdown();
    this.instances.delete(lang);
    const timer = this.idleTimers.get(lang);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(lang);
    }
    this.docCounts.delete(lang);
  }
  /** Open a document in the appropriate LSP server. */
  async openDocument(filePath, text) {
    const lang = detectLanguage(filePath);
    if (!lang)
      return null;
    if (!this.instances.has(lang))
      return lang;
    const inst = this.instances.get(lang);
    await inst.openDocument(filePath, text);
    const count = (this.docCounts.get(lang) || 0) + 1;
    this.docCounts.set(lang, count);
    const timer = this.idleTimers.get(lang);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(lang);
    }
    return lang;
  }
  /** Notify LSP of document change. */
  async changeDocument(filePath, changes, version) {
    const lang = detectLanguage(filePath);
    if (!lang || !this.instances.has(lang))
      return;
    await this.instances.get(lang).changeDocument(filePath, changes, version);
  }
  /** Close a document. Triggers idle shutdown after 5 min with zero open docs. */
  async closeDocument(filePath) {
    const lang = detectLanguage(filePath);
    if (!lang || !this.instances.has(lang))
      return;
    await this.instances.get(lang).closeDocument(filePath);
    const count = Math.max(0, (this.docCounts.get(lang) || 1) - 1);
    this.docCounts.set(lang, count);
    if (count <= 0 && this.instances.has(lang)) {
      this.docCounts.delete(lang);
      const timer = setTimeout(() => {
        this.idleTimers.delete(lang);
        if ((this.docCounts.get(lang) || 0) <= 0 && this.instances.has(lang)) {
          console.log("[lsp] idle timeout for", lang, "\u2192 shutting down");
          this.stopLanguage(lang).catch(() => {
          });
        }
      }, _LspBridge.IDLE_SHUTDOWN_MS);
      this.idleTimers.set(lang, timer);
    }
  }
  /** Request hover info via LSP. Returns null if no language server is active. */
  async hover(filePath, line, character) {
    const lang = detectLanguage(filePath);
    if (!lang || !this.instances.has(lang))
      return null;
    try {
      return await this.instances.get(lang).hover(filePath, line, character);
    } catch (e) {
      console.warn("[lsp] hover failed for", lang, ":", e.message);
      return null;
    }
  }
  /** Push diagnostics to all target renderers. */
  updateDiagnostics(filePath, diagnostics) {
    const uri = filePathToUri(filePath);
    this.diagnosticsCache.set(uri, diagnostics);
    for (const wc of this.targets) {
      if (!wc.isDestroyed()) {
        wc.send("qqq:lsp:diagnostics", { uri, diagnostics });
      }
    }
  }
  /** Get cached diagnostics for a URI. */
  getDiagnostics(uri) {
    return this.diagnosticsCache.get(uri) || [];
  }
  /** Get all active language names. */
  activeLanguages() {
    return Array.from(this.instances.keys());
  }
  /** Stop all LSP servers. */
  async shutdownAll() {
    const langs = Array.from(this.instances.keys());
    await Promise.all(langs.map((l) => this.stopLanguage(l)));
    this.instances.clear();
    this.diagnosticsCache.clear();
  }
};
function filePathToUri(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.match(/^[a-zA-Z]:/)) {
    return "file:///" + normalized;
  }
  return "file://" + normalized;
}
function uriToFilePath(uri) {
  let p = decodeURIComponent(uri.replace(/^file:\/\/\//, "").replace(/^file:\/\//, ""));
  if (process.platform === "win32") {
    p = p.replace(/\//g, "\\");
  }
  return p;
}

// shell/cache-store.ts
var path6 = __toESM(require("path"));
var fs6 = __toESM(require("fs"));
var crypto = __toESM(require("crypto"));
var CacheStore = class {
  constructor(root) {
    this.root = root;
    this.kvDir = path6.join(root, "kv");
    this.bucketRoot = path6.join(root, "h");
    this.hashDir = path6.join(root, "hash");
    for (const d of [root, this.kvDir, this.bucketRoot, this.hashDir]) {
      try {
        fs6.mkdirSync(d, { recursive: true });
      } catch {
      }
    }
  }
  // ----- safe key -> filename ------------------------------------------------
  keyToFile(key) {
    const h = crypto.createHash("sha256").update(String(key)).digest("hex");
    return path6.join(this.kvDir, h.slice(0, 2), h + ".json");
  }
  // ----- KV API -------------------------------------------------------------
  async has(key) {
    const p = this.keyToFile(key);
    return fs6.existsSync(p);
  }
  async get(key) {
    const p = this.keyToFile(key);
    try {
      const raw = await fs6.promises.readFile(p, "utf8");
      const ent = JSON.parse(raw);
      if (ent.ttl && Date.now() - ent.t > ent.ttl) {
        return null;
      }
      return ent.v;
    } catch {
      return null;
    }
  }
  async put(key, value, opts) {
    const p = this.keyToFile(key);
    try {
      fs6.mkdirSync(path6.dirname(p), { recursive: true });
    } catch {
    }
    const ent = { v: value, t: Date.now() };
    if (opts && opts.ttlMs) {
      ent.ttl = opts.ttlMs;
    }
    try {
      await fs6.promises.writeFile(p, JSON.stringify(ent), "utf8");
      return true;
    } catch (e) {
      console.warn("[cache] put failed:", key, e);
      return false;
    }
  }
  async del(key) {
    const p = this.keyToFile(key);
    try {
      await fs6.promises.unlink(p);
      return true;
    } catch {
      return false;
    }
  }
  /** Absolute filesystem path of the KV entry for a key (may not exist). */
  async path(key) {
    return this.keyToFile(key);
  }
  // ----- File bucket --------------------------------------------------------
  /**
   * Resolve the bucketed path for a content signature (typically a hex hash).
   * `sig` is the full hash; bucket = first 2 chars.
   * Returns absolute path, regardless of whether the file exists.
   */
  bucketPath(sig, ext) {
    const clean = String(sig || "").replace(/[^a-zA-Z0-9]/g, "");
    if (!clean) {
      throw new Error("bucketPath: empty sig");
    }
    const bucket = clean.slice(0, 2).toLowerCase();
    const dir = path6.join(this.bucketRoot, bucket);
    try {
      fs6.mkdirSync(dir, { recursive: true });
    } catch {
    }
    const safeExt = ext && /^\.[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : "";
    return path6.join(dir, clean + safeExt);
  }
  /** Hash-service mtime db dir (kept separate so we can clean independently). */
  hashDbDir() {
    return this.hashDir;
  }
};

// shell/hash-service.ts
var fs7 = __toESM(require("fs"));
var crypto2 = __toESM(require("crypto"));
var HashService = class _HashService {
  constructor(cache) {
    this.cache = cache;
  }
  static {
    // -------------------------------------------------------------------------
    // xxh64 (pure JS, big-int based; matches h.js output)
    // -------------------------------------------------------------------------
    this.PRIME64_1 = 0x9E3779B185EBCA87n;
  }
  static {
    this.PRIME64_2 = 0xC2B2AE3D27D4EB4Fn;
  }
  static {
    this.PRIME64_3 = 0x165667B19E3779F9n;
  }
  static {
    this.PRIME64_4 = 0x85EBCA77C2B2AE63n;
  }
  static {
    this.PRIME64_5 = 0x27D4EB2F165667C5n;
  }
  static {
    this.MASK64 = 0xFFFFFFFFFFFFFFFFn;
  }
  static rotl64(x, r) {
    return (x << BigInt(r) | x >> BigInt(64 - r)) & _HashService.MASK64;
  }
  static round(acc, input) {
    let a = acc + (input & _HashService.MASK64) * _HashService.PRIME64_2 & _HashService.MASK64;
    a = _HashService.rotl64(a, 31);
    return a * _HashService.PRIME64_1 & _HashService.MASK64;
  }
  static mergeRound(acc, val) {
    const v = _HashService.round(0n, val);
    let a = acc ^ v;
    a = a * _HashService.PRIME64_1 + _HashService.PRIME64_4 & _HashService.MASK64;
    return a;
  }
  /** xxh64 of an entire Buffer (seed = 0). */
  static xxh64(buf, seed = 0n) {
    const len = buf.length;
    let h;
    let p = 0;
    if (len >= 32) {
      let v1 = seed + _HashService.PRIME64_1 + _HashService.PRIME64_2 & _HashService.MASK64;
      let v2 = seed + _HashService.PRIME64_2 & _HashService.MASK64;
      let v3 = seed;
      let v4 = seed - _HashService.PRIME64_1 & _HashService.MASK64;
      while (p + 32 <= len) {
        v1 = _HashService.round(v1, buf.readBigUInt64LE(p));
        p += 8;
        v2 = _HashService.round(v2, buf.readBigUInt64LE(p));
        p += 8;
        v3 = _HashService.round(v3, buf.readBigUInt64LE(p));
        p += 8;
        v4 = _HashService.round(v4, buf.readBigUInt64LE(p));
        p += 8;
      }
      h = _HashService.rotl64(v1, 1) + _HashService.rotl64(v2, 7) + _HashService.rotl64(v3, 12) + _HashService.rotl64(v4, 18) & _HashService.MASK64;
      h = _HashService.mergeRound(h, v1);
      h = _HashService.mergeRound(h, v2);
      h = _HashService.mergeRound(h, v3);
      h = _HashService.mergeRound(h, v4);
    } else {
      h = seed + _HashService.PRIME64_5 & _HashService.MASK64;
    }
    h = h + BigInt(len) & _HashService.MASK64;
    while (p + 8 <= len) {
      const k1 = _HashService.round(0n, buf.readBigUInt64LE(p));
      h ^= k1;
      h = _HashService.rotl64(h, 27) * _HashService.PRIME64_1 + _HashService.PRIME64_4 & _HashService.MASK64;
      p += 8;
    }
    if (p + 4 <= len) {
      h ^= BigInt(buf.readUInt32LE(p)) * _HashService.PRIME64_1 & _HashService.MASK64;
      h = _HashService.rotl64(h, 23) * _HashService.PRIME64_2 + _HashService.PRIME64_3 & _HashService.MASK64;
      p += 4;
    }
    while (p < len) {
      h ^= BigInt(buf[p]) * _HashService.PRIME64_5 & _HashService.MASK64;
      h = _HashService.rotl64(h, 11) * _HashService.PRIME64_1 & _HashService.MASK64;
      p += 1;
    }
    h ^= h >> 33n;
    h = h * _HashService.PRIME64_2 & _HashService.MASK64;
    h ^= h >> 29n;
    h = h * _HashService.PRIME64_3 & _HashService.MASK64;
    h ^= h >> 32n;
    return h.toString(16).padStart(16, "0");
  }
  // -------------------------------------------------------------------------
  // Buffer hashing
  // -------------------------------------------------------------------------
  hashBuffer(buf, mode = "fast") {
    const r = { size: buf.length };
    if (mode === "fast" || mode === "both") {
      r.xxh64 = _HashService.xxh64(buf);
    }
    if (mode === "strong" || mode === "both") {
      r.sha256 = crypto2.createHash("sha256").update(buf).digest("hex");
    }
    return r;
  }
  // -------------------------------------------------------------------------
  // File hashing (with mtime cache)
  // -------------------------------------------------------------------------
  cacheKey(absPath, size, mtimeMs) {
    return `hash:${absPath}|${size}|${Math.floor(mtimeMs)}`;
  }
  async hashFile(absPath, mode = "fast") {
    const stat = await fs7.promises.stat(absPath);
    const key = this.cacheKey(absPath, stat.size, stat.mtimeMs);
    const cached = await this.cache.get(key);
    if (cached) {
      const need = mode === "fast" && cached.xxh64 || mode === "strong" && cached.sha256 || mode === "both" && cached.xxh64 && cached.sha256;
      if (need) {
        return cached;
      }
    }
    const want = {
      fast: (mode === "fast" || mode === "both") && !(cached && cached.xxh64),
      strong: (mode === "strong" || mode === "both") && !(cached && cached.sha256)
    };
    const out = { ...cached || { size: stat.size }, size: stat.size, mtimeMs: stat.mtimeMs };
    if (want.strong || want.fast) {
      const FAST_CAP = 64 * 1024 * 1024;
      const useFullBuf = want.fast && stat.size <= FAST_CAP;
      if (useFullBuf) {
        const buf = await fs7.promises.readFile(absPath);
        out.xxh64 = _HashService.xxh64(buf);
        if (want.strong) {
          out.sha256 = crypto2.createHash("sha256").update(buf).digest("hex");
        }
      } else {
        const h = crypto2.createHash("sha256");
        const stream = fs7.createReadStream(absPath);
        await new Promise((resolve2, reject) => {
          stream.on("data", (d) => h.update(d));
          stream.on("end", () => resolve2());
          stream.on("error", reject);
        });
        if (want.strong) {
          out.sha256 = h.digest("hex");
        }
        if (want.fast && !out.xxh64) {
          out.xxh64 = (out.sha256 || h.digest("hex")).slice(0, 16);
        }
      }
    }
    try {
      await this.cache.put(key, out);
    } catch {
    }
    return out;
  }
};

// shell/media-service.ts
var path7 = __toESM(require("path"));
var fs8 = __toESM(require("fs"));
var MediaService = class {
  constructor(appRoot, qz, cache, hash) {
    this.appRoot = appRoot;
    this.qz = qz;
    this.cache = cache;
    this.hash = hash;
    this._ffmpegPath = null;
    this._ffprobePath = null;
    this._resolved = false;
  }
  // -------------------------------------------------------------------------
  // binary resolution
  // -------------------------------------------------------------------------
  resolveBin(name) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const envKey = name === "ffmpeg" ? "QQQ_FFMPEG" : "QQQ_FFPROBE";
    const overrideEnv = process.env[envKey];
    if (overrideEnv && fs8.existsSync(overrideEnv)) {
      return overrideEnv;
    }
    const qdir = process.env.QDIR;
    const tries = [];
    if (qdir) {
      tries.push(path7.join(qdir, "components", "ffmpeg", name + ext));
    }
    tries.push(path7.join(this.appRoot, "engines", "ffmpeg", name + ext));
    tries.push(path7.join(this.appRoot, "engines", name + ext));
    for (const p of tries) {
      try {
        if (fs8.existsSync(p)) {
          return p;
        }
      } catch {
      }
    }
    return this.qz.which(name);
  }
  ensureResolved() {
    if (this._resolved) {
      return;
    }
    this._ffmpegPath = this.resolveBin("ffmpeg");
    this._ffprobePath = this.resolveBin("ffprobe");
    this._resolved = true;
  }
  ffmpegPath() {
    this.ensureResolved();
    return { ffmpeg: this._ffmpegPath, ffprobe: this._ffprobePath };
  }
  // -------------------------------------------------------------------------
  // thumb
  // -------------------------------------------------------------------------
  async thumb(opts) {
    if (!opts || !opts.src) {
      return { ok: false, error: "no_src" };
    }
    if (!fs8.existsSync(opts.src)) {
      return { ok: false, error: "src_missing" };
    }
    this.ensureResolved();
    if (!this._ffmpegPath) {
      return { ok: false, error: "ffmpeg_not_found" };
    }
    const w = Math.max(16, Math.min(2048, opts.w || 256));
    const h = Math.max(16, Math.min(2048, opts.h || 256));
    const ts = Math.max(0, opts.ts != null ? opts.ts : 1);
    const format = opts.format || "jpg";
    const quality = opts.quality != null ? opts.quality : 5;
    const fit = opts.fit || "contain";
    const sig = (await this.hash.hashFile(opts.src, "fast")).xxh64 || "no-hash";
    const paramKey = `thumb|${w}x${h}|t=${ts}|f=${format}|q=${quality}|${fit}`;
    const fullKey = `${sig}|${paramKey}`;
    const dst = this.cache.bucketPath("thumb" + this.shortHash(fullKey), "." + format);
    if (fs8.existsSync(dst)) {
      return { ok: true, path: dst, cached: true };
    }
    const vf = fit === "cover" ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}` : `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
    const args = [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      String(ts),
      "-i",
      opts.src,
      "-vframes",
      "1",
      "-vf",
      vf
    ];
    if (format === "jpg") {
      args.push("-q:v", String(quality));
    } else if (format === "webp") {
      args.push("-quality", String(Math.max(1, Math.min(100, 90 - quality * 4))));
    }
    args.push(dst);
    const r = await this.qz.spawn({
      cmd: this._ffmpegPath,
      args,
      timeout: 3e4,
      stallMs: 15e3,
      captureOutput: true
    });
    if (r.exitCode !== 0 || !fs8.existsSync(dst)) {
      return {
        ok: false,
        error: "ffmpeg_failed",
        stderr: r.stderr.slice(-500),
        path: dst
      };
    }
    return { ok: true, path: dst, cached: false };
  }
  // -------------------------------------------------------------------------
  // transcode
  // -------------------------------------------------------------------------
  async transcode(opts) {
    if (!opts || !opts.src || !opts.format) {
      return { ok: false, error: "no_src_or_format" };
    }
    if (!fs8.existsSync(opts.src)) {
      return { ok: false, error: "src_missing" };
    }
    this.ensureResolved();
    if (!this._ffmpegPath) {
      return { ok: false, error: "ffmpeg_not_found" };
    }
    const sig = (await this.hash.hashFile(opts.src, "fast")).xxh64 || "no-hash";
    const paramKey = `tx|${opts.format}|${opts.vbr || ""}|${opts.abr || ""}|${(opts.extraArgs || []).join(",")}`;
    const fullKey = `${sig}|${paramKey}`;
    const dst = opts.dst || this.cache.bucketPath("tx" + this.shortHash(fullKey), "." + opts.format);
    if (!opts.dst && fs8.existsSync(dst)) {
      return { ok: true, path: dst, cached: true };
    }
    const args = ["-y", "-loglevel", "error", "-i", opts.src];
    if (opts.vbr) {
      args.push("-b:v", opts.vbr);
    }
    if (opts.abr) {
      args.push("-b:a", opts.abr);
    }
    if (opts.extraArgs && opts.extraArgs.length) {
      args.push(...opts.extraArgs);
    }
    args.push(dst);
    const r = await this.qz.spawn({
      cmd: this._ffmpegPath,
      args,
      timeout: 30 * 6e4,
      stallMs: 6e4,
      captureOutput: true
    });
    if (r.exitCode !== 0 || !fs8.existsSync(dst)) {
      return { ok: false, error: "ffmpeg_failed", stderr: r.stderr.slice(-500), path: dst };
    }
    return { ok: true, path: dst, cached: false };
  }
  // -------------------------------------------------------------------------
  // probe
  // -------------------------------------------------------------------------
  async probe(src) {
    if (!src || !fs8.existsSync(src)) {
      return { ok: false, error: "src_missing" };
    }
    this.ensureResolved();
    const sig = (await this.hash.hashFile(src, "fast")).xxh64 || "no-hash";
    const cacheKey = `probe:${sig}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
    if (this._ffprobePath) {
      const args = [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height,codec_name,duration:format=duration",
        "-of",
        "json",
        src
      ];
      const r = await this.qz.spawn({
        cmd: this._ffprobePath,
        args,
        timeout: 2e4,
        stallMs: 1e4,
        captureOutput: true
      });
      if (r.exitCode === 0 && r.stdout) {
        try {
          const j = JSON.parse(r.stdout);
          const stream = (j.streams || [])[0] || {};
          const duration = Number(stream.duration || j.format && j.format.duration || 0);
          const out = {
            ok: true,
            width: Number(stream.width) || void 0,
            height: Number(stream.height) || void 0,
            codec: stream.codec_name || void 0,
            duration: isFinite(duration) ? duration : void 0
          };
          await this.cache.put(cacheKey, out, { ttlMs: 30 * 24 * 36e5 });
          return out;
        } catch {
        }
      }
    }
    if (this._ffmpegPath) {
      const r = await this.qz.spawn({
        cmd: this._ffmpegPath,
        args: ["-i", src],
        timeout: 2e4,
        stallMs: 1e4,
        captureOutput: true
      });
      const txt = r.stderr || "";
      const out = { ok: true };
      const m1 = txt.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (m1) {
        out.duration = Number(m1[1]) * 3600 + Number(m1[2]) * 60 + Number(m1[3]);
      }
      const m2 = txt.match(/Video:\s*([^,]+),[^,]*,\s*(\d+)x(\d+)/);
      if (m2) {
        out.codec = m2[1].trim();
        out.width = Number(m2[2]);
        out.height = Number(m2[3]);
      }
      if (out.duration || out.width) {
        await this.cache.put(cacheKey, out, { ttlMs: 30 * 24 * 36e5 });
        return out;
      }
    }
    return { ok: false, error: "probe_failed" };
  }
  // -------------------------------------------------------------------------
  shortHash(s) {
    const crypto6 = require("crypto");
    return crypto6.createHash("sha256").update(s).digest("hex").slice(0, 16);
  }
};

// shell/state-sqlite.ts
var path8 = __toESM(require("path"));
var fs9 = __toESM(require("fs"));
var crypto3 = __toESM(require("crypto"));
var import_events2 = require("events");
var initSqlJs = require("sql.js");
var DEFAULT_DEBOUNCE_MS = 250;
var StateStore = class extends import_events2.EventEmitter {
  // ----- constructor --------------------------------------------------------
  constructor(userDataDir) {
    super();
    this._db = null;
    // sql.js Database (null until WASM loaded)
    this._SQL = null;
    // sql.js module
    this._ready = null;
    this._readyOk = false;
    this.outboxSeq = 0;
    this.schemas = /* @__PURE__ */ new Map();
    // debounce timers (key = ns\u0000key)
    this._debouncers = /* @__PURE__ */ new Map();
    // dirty tracking for stats
    this._dirtySet = /* @__PURE__ */ new Set();
    // ★ batched DB export (avoids per-key db.export() → one export per ~50ms window)
    this._saveDbPending = false;
    this._saveDbTimer = null;
    // ★ in-memory read cache (avoids append() re-reading from DB each time)
    this._memCache = /* @__PURE__ */ new Map();
    /** Hook for state-cloud.ts */
    this.onCloudDirty = null;
    this.setMaxListeners(0);
    const stateDir = path8.join(userDataDir, "state");
    try {
      fs9.mkdirSync(stateDir, { recursive: true });
    } catch {
    }
    this.dbPath = path8.join(stateDir, "state.db");
    this.outboxDir = path8.join(stateDir, "outbox");
    try {
      fs9.mkdirSync(this.outboxDir, { recursive: true });
    } catch {
    }
    this.deviceId = this._loadOrCreateDeviceId(stateDir);
    this._restoreOutboxSeq();
    console.log("[state-sqlite] db=", this.dbPath, "device=", this.deviceId);
  }
  // ----- init (lazy, triggered on first use) --------------------------------
  _init() {
    if (this._ready)
      return this._ready;
    this._ready = this._doInit();
    return this._ready;
  }
  async _doInit() {
    try {
      this._SQL = await initSqlJs();
      if (fs9.existsSync(this.dbPath)) {
        try {
          const buf = fs9.readFileSync(this.dbPath);
          this._db = new this._SQL.Database(buf);
        } catch (e) {
          console.warn("[state-sqlite] failed to load state.db, starting fresh:", e);
          const bak = this.dbPath + ".corrupt." + Date.now();
          try {
            fs9.renameSync(this.dbPath, bak);
          } catch {
          }
          this._db = new this._SQL.Database();
        }
      } else {
        this._db = new this._SQL.Database();
      }
      this._db.run(`CREATE TABLE IF NOT EXISTS state (
                ns TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                meta TEXT,
                updated_at INTEGER DEFAULT 0,
                PRIMARY KEY (ns, key)
            )`);
      this._db.run("CREATE INDEX IF NOT EXISTS idx_state_ns ON state(ns)");
      this._db.run("PRAGMA journal_mode=WAL");
      this._db.run("PRAGMA synchronous=FULL");
      this._db.run("PRAGMA busy_timeout=30000");
      this._loadSchemas();
      this._readyOk = true;
      console.log("[state-sqlite] ready, schemas:", this.schemas.size);
    } catch (e) {
      console.error("[state-sqlite] init FAILED:", e);
      throw e;
    }
  }
  _ensureReady() {
    return this._init();
  }
  _assertReady() {
    if (!this._readyOk || !this._db) {
      this._init().catch(() => {
      });
    }
  }
  // ----- device id ----------------------------------------------------------
  _loadOrCreateDeviceId(stateDir) {
    const f = path8.join(stateDir, "device.id");
    try {
      if (fs9.existsSync(f)) {
        const s = fs9.readFileSync(f, "utf8").trim();
        if (s && s.length >= 8)
          return s;
      }
    } catch {
    }
    const id = "dev_" + crypto3.randomBytes(8).toString("hex");
    try {
      fs9.writeFileSync(f, id, "utf8");
    } catch {
    }
    return id;
  }
  _restoreOutboxSeq() {
    try {
      const files = fs9.readdirSync(this.outboxDir);
      for (const f of files) {
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
  // ----- schema registry ----------------------------------------------------
  _loadSchemas() {
    try {
      this._db.run(`CREATE TABLE IF NOT EXISTS registry (
                ns TEXT PRIMARY KEY,
                v INTEGER NOT NULL,
                form TEXT NOT NULL,
                cloud INTEGER DEFAULT 0,
                quota_bytes INTEGER
            )`);
      const rows = this._db.prepare("SELECT * FROM registry").all();
      for (const r of rows) {
        this.schemas.set(r.ns, {
          v: r.v,
          form: r.form,
          cloud: !!r.cloud,
          quotaBytes: r.quota_bytes || void 0
        });
      }
    } catch (e) {
      console.warn("[state-sqlite] _loadSchemas failed:", e);
    }
  }
  _persistSchema(ns, sc) {
    if (!this._readyOk || !this._db)
      return;
    try {
      this._db.run(
        `INSERT OR REPLACE INTO registry (ns, v, form, cloud, quota_bytes) VALUES (?,?,?,?,?)`,
        [ns, sc.v, sc.form, sc.cloud ? 1 : 0, sc.quotaBytes || null]
      );
    } catch (e) {
      console.warn("[state-sqlite] _persistSchema failed:", e);
    }
  }
  // ----- public introspection -----------------------------------------------
  getDeviceId() {
    return this.deviceId;
  }
  getRootDir() {
    return path8.dirname(this.dbPath);
  }
  getOutboxDir() {
    return this.outboxDir;
  }
  getRegisteredNs() {
    return Array.from(this.schemas.keys());
  }
  getSchema(ns) {
    return this.schemas.get(ns);
  }
  sql(query, params) {
    try {
      if (params && params.length) {
        if (query.trim().toUpperCase().startsWith("SELECT")) {
          return this._db.prepare(query).all(params);
        }
        this._db.run(query, params);
        this._scheduleSaveDb();
        return { changes: this._db.getRowsModified() };
      }
      if (query.trim().toUpperCase().startsWith("SELECT")) {
        return this._db.prepare(query).all([]);
      }
      this._db.run(query);
      this._scheduleSaveDb();
      return { changes: this._db.getRowsModified() };
    } catch (e) {
      console.warn("[state-sqlite] sql error:", query, e);
      throw e;
    }
  }
  stats() {
    let outbox = 0;
    try {
      outbox = fs9.readdirSync(this.outboxDir).filter((f) => f.endsWith(".json")).length;
    } catch {
    }
    return {
      dirtyKeys: this._dirtySet.size,
      queuedOutbox: outbox,
      lastSyncAt: this.lastSyncAt,
      namespaces: this.schemas.size
    };
  }
  markSyncedAt(t) {
    this.lastSyncAt = t;
  }
  // ----- registration -------------------------------------------------------
  register(ns, schema) {
    if (!ns || typeof ns !== "string")
      throw new Error("state.register: bad ns");
    if (!schema || !schema.form || !["doc", "blob", "log"].includes(schema.form)) {
      throw new Error("state.register: bad schema.form, must be doc/blob/log");
    }
    if (typeof schema.v !== "number" || schema.v < 1) {
      throw new Error("state.register: schema.v must be >=1");
    }
    const existing = this.schemas.get(ns);
    if (existing) {
      if (existing.form !== schema.form) {
        throw new Error(`state.register: ns "${ns}" form mismatch (existing=${existing.form}, new=${schema.form})`);
      }
    }
    this.schemas.set(ns, schema);
    this._persistSchema(ns, schema);
    console.log("[state-sqlite] register ns=", ns, "v=", schema.v, "form=", schema.form, "cloud=", !!schema.cloud);
  }
  // ----- encode / decode ----------------------------------------------------
  _encode(form, value) {
    if (form === "doc") {
      return JSON.stringify(value);
    }
    if (form === "blob") {
      return JSON.stringify(value);
    }
    if (!Array.isArray(value))
      value = [];
    return JSON.stringify(value);
  }
  _decode(form, raw) {
    if (!raw)
      return form === "log" ? [] : null;
    try {
      return JSON.parse(raw);
    } catch {
      return form === "log" ? [] : null;
    }
  }
  // ----- public API: get / set / setNow / append / del / list ----------------
  async get(ns, key) {
    await this._ensureReady();
    this._requireSchema(ns);
    const cid = ns + "\0" + key;
    const cached = this._memCache.get(cid);
    if (cached !== void 0)
      return cached;
    try {
      const row = this._db.prepare("SELECT value FROM state WHERE ns=? AND key=?").get([ns, key]);
      if (!row || row.value === null || row.value === void 0) {
        const sc2 = this.schemas.get(ns);
        return sc2.form === "log" ? [] : null;
      }
      const sc = this.schemas.get(ns);
      const val = this._decode(sc.form, row.value);
      this._memCache.set(cid, val);
      return val;
    } catch (e) {
      console.warn("[state-sqlite] get error", ns, key, e);
      const sc = this.schemas.get(ns);
      return sc && sc.form === "log" ? [] : null;
    }
  }
  async set(ns, key, value) {
    await this._ensureReady();
    const sc = this._requireSchema(ns);
    if (sc.form === "log" && !Array.isArray(value)) {
      throw new Error(`state.set on log form requires an array; ns=${ns} key=${key}`);
    }
    this._markDirty(ns, key, sc, value);
    if (sc.cloud && this.onCloudDirty) {
      try {
        this.onCloudDirty(ns, key);
      } catch {
      }
    }
  }
  async setNow(ns, key, value) {
    await this._ensureReady();
    const sc = this._requireSchema(ns);
    if (sc.form === "log" && !Array.isArray(value)) {
      throw new Error(`state.setNow on log form requires an array; ns=${ns} key=${key}`);
    }
    const id = ns + "\0" + key;
    const t = this._debouncers.get(id);
    if (t) {
      clearTimeout(t);
      this._debouncers.delete(id);
    }
    this._writeKey(ns, key, sc, value);
    this._dirtySet.delete(id);
    this._doSaveDb();
    if (sc.cloud && this.onCloudDirty) {
      try {
        this.onCloudDirty(ns, key);
      } catch {
      }
    }
  }
  async append(ns, key, event) {
    await this._ensureReady();
    const sc = this._requireSchema(ns);
    if (sc.form !== "log")
      throw new Error(`state.append only valid for form=log; ns=${ns}`);
    const cid = ns + "\0" + key;
    let arr = this._memCache.get(cid);
    if (arr === void 0) {
      arr = await this.get(ns, key);
    }
    if (!Array.isArray(arr))
      arr = [];
    arr.push(event);
    this._memCache.set(cid, arr);
    this._markDirty(ns, key, sc, arr);
    if (sc.cloud && this.onCloudDirty) {
      try {
        this.onCloudDirty(ns, key);
      } catch {
      }
    }
  }
  async del(ns, key) {
    await this._ensureReady();
    this._requireSchema(ns);
    try {
      const id = ns + "\0" + key;
      const t = this._debouncers.get(id);
      if (t) {
        clearTimeout(t);
        this._debouncers.delete(id);
      }
      this._dirtySet.delete(id);
      this._memCache.delete(id);
      const info = this._db.prepare("DELETE FROM state WHERE ns=? AND key=?").run([ns, key]);
      const any = info.changes > 0;
      if (any) {
        this.emit("changed", { ns, key, value: null, deleted: true });
        const sc = this.schemas.get(ns);
        if (sc && sc.cloud) {
          this._queueOutbox(ns, key, null, true);
        }
      }
      return any;
    } catch (e) {
      console.warn("[state-sqlite] del error", ns, key, e);
      return false;
    }
  }
  async list(ns) {
    await this._ensureReady();
    this._requireSchema(ns);
    try {
      const rows = this._db.prepare("SELECT key FROM state WHERE ns=?").all([ns]);
      return rows.map((r) => r.key);
    } catch (e) {
      return [];
    }
  }
  // ----- internal: dirty + debounce + write ---------------------------------
  _markDirty(ns, key, sc, value) {
    const id = ns + "\0" + key;
    this._dirtySet.add(id);
    const existing = this._debouncers.get(id);
    if (existing)
      clearTimeout(existing);
    const debounceMs = typeof sc.debounceMs === "number" ? sc.debounceMs : DEFAULT_DEBOUNCE_MS;
    this._debouncers.set(id, setTimeout(() => {
      this._debouncers.delete(id);
      this._dirtySet.delete(id);
      try {
        this._writeKey(ns, key, sc, value);
      } catch (e) {
        console.warn("[state-sqlite] debounced write error", ns, key, e);
      }
    }, debounceMs));
  }
  _writeKey(ns, key, sc, value) {
    if (!this._readyOk || !this._db)
      return;
    try {
      const encoded = this._encode(sc.form, value);
      const meta = JSON.stringify({
        v: sc.v,
        ts: Date.now(),
        deviceId: this.deviceId,
        form: sc.form
      });
      this._db.run(
        `INSERT OR REPLACE INTO state (ns, key, value, meta, updated_at) VALUES (?,?,?,?,?)`,
        [ns, key, encoded, meta, Date.now()]
      );
      this._memCache.set(ns + "\0" + key, value);
      this._scheduleSaveDb();
      if (sc.cloud) {
        this._queueOutbox(ns, key, value, false);
      }
      this.emit("changed", { ns, key, value, deleted: false });
    } catch (e) {
      console.warn("[state-sqlite] _writeKey error", ns, key, e);
    }
  }
  // ★ Schedule batched DB export (50ms window, multiple writes share one export)
  _scheduleSaveDb() {
    this._saveDbPending = true;
    if (this._saveDbTimer)
      return;
    this._saveDbTimer = setTimeout(() => {
      this._saveDbTimer = null;
      if (!this._saveDbPending)
        return;
      this._doSaveDb();
    }, 50);
  }
  _doSaveDb() {
    if (!this._readyOk || !this._db)
      return;
    this._saveDbPending = false;
    if (this._saveDbTimer) {
      clearTimeout(this._saveDbTimer);
      this._saveDbTimer = null;
    }
    try {
      const data = this._db.export();
      const buf = Buffer.from(data);
      const tmp = this.dbPath + ".tmp." + Date.now();
      fs9.writeFileSync(tmp, buf);
      try {
        fs9.renameSync(tmp, this.dbPath);
      } catch (e) {
        if (e && (e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES")) {
          try {
            fs9.unlinkSync(this.dbPath);
          } catch {
          }
          fs9.renameSync(tmp, this.dbPath);
        } else {
          try {
            fs9.unlinkSync(tmp);
          } catch {
          }
          throw e;
        }
      }
    } catch (e) {
      console.warn("[state-sqlite] _doSaveDb failed:", e);
    }
  }
  // ----- flush --------------------------------------------------------------
  async flush() {
    if (!this._readyOk || !this._db)
      return;
    const ids = Array.from(this._debouncers.keys());
    for (const id of ids) {
      const t = this._debouncers.get(id);
      if (t) {
        clearTimeout(t);
        this._debouncers.delete(id);
      }
      this._dirtySet.delete(id);
    }
    this._doSaveDb();
  }
  /** Synchronous flush for crash/shutdown. */
  flushSync() {
    if (!this._readyOk || !this._db)
      return;
    for (const [id, t] of this._debouncers) {
      clearTimeout(t);
      this._debouncers.delete(id);
    }
    this._dirtySet.clear();
    this._memCache.clear();
    this._doSaveDb();
  }
  async flushOne(ns, key) {
    const id = ns + "\0" + key;
    const t = this._debouncers.get(id);
    if (t) {
      clearTimeout(t);
      this._debouncers.delete(id);
    }
    this._dirtySet.delete(id);
    this._memCache.delete(id);
    this._doSaveDb();
  }
  // ----- schema helpers -----------------------------------------------------
  _requireSchema(ns) {
    const sc = this.schemas.get(ns);
    if (!sc)
      throw new Error(`state: ns "${ns}" not registered`);
    return sc;
  }
  // ----- outbox (cloud sync queue; state-cloud.ts drains it) ----------------
  _queueOutbox(ns, key, value, deleted) {
    try {
      this.outboxSeq += 1;
      const seq = String(this.outboxSeq).padStart(12, "0");
      const f = path8.join(this.outboxDir, seq + ".json");
      const payload = { seq, ns, key, ts: Date.now(), deleted, value: deleted ? null : value };
      const tmp = f + ".tmp." + Date.now();
      fs9.writeFileSync(tmp, JSON.stringify(payload));
      try {
        fs9.renameSync(tmp, f);
      } catch {
        try {
          if (fs9.existsSync(f))
            fs9.unlinkSync(f);
        } catch {
        }
        fs9.renameSync(tmp, f);
      }
    } catch (e) {
      console.warn("[state-sqlite] _queueOutbox failed:", e);
    }
  }
  listOutbox() {
    const out = [];
    try {
      const files = fs9.readdirSync(this.outboxDir).filter((f) => f.endsWith(".json")).sort();
      for (const f of files) {
        out.push({ seq: f.replace(/\.json$/, ""), file: path8.join(this.outboxDir, f) });
      }
    } catch {
    }
    return out;
  }
  dropOutbox(seq) {
    const f = path8.join(this.outboxDir, seq + ".json");
    try {
      fs9.unlinkSync(f);
      return true;
    } catch {
      return false;
    }
  }
  // ----- merge-on-save (delegated to schema.merger) -------------------------
  // SQLite WAL mode provides natural isolation. Multi-window merge is handled
  // at the application level (q4.js) rather than at the storage level.
  // The 'merger' property in NsSchema is still used by state-cloud.ts for
  // cloud sync merge logic.
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

// shell/state-cloud.ts
var path9 = __toESM(require("path"));
var fs10 = __toESM(require("fs"));
var os = __toESM(require("os"));
var https = __toESM(require("https"));
var http = __toESM(require("http"));
var import_url = require("url");
var AUTH_FILE = path9.join(os.homedir(), ".qqq", "auth.json");
var CLOUD_BASE = process.env.QQQ_CLOUD_BASE || "https://gh555.com";
var REQ_TIMEOUT_MS = 12e3;
function readAuth() {
  try {
    if (!fs10.existsSync(AUTH_FILE)) {
      return null;
    }
    const j = JSON.parse(fs10.readFileSync(AUTH_FILE, "utf8"));
    if (!j || !j.phone || !j.token) {
      return null;
    }
    return { phone: String(j.phone), token: String(j.token), device_name: j.device_name || os.hostname() };
  } catch {
    return null;
  }
}
function httpsPostJson(urlStr, body) {
  return new Promise((resolve2, reject) => {
    let u;
    try {
      u = new import_url.URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const data = Buffer.from(JSON.stringify(body || {}), "utf8");
    const req = lib.request({
      method: "POST",
      protocol: u.protocol,
      host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: {
        "content-type": "application/json",
        "content-length": String(data.length),
        "user-agent": "qqq-shell-state-cloud/1"
      },
      timeout: REQ_TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          json = { _raw: raw };
        }
        resolve2({ status: res.statusCode || 0, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.write(data);
    req.end();
  });
}
var StateCloud = class {
  constructor(store) {
    this.store = store;
    this.store.onCloudDirty = (_ns, _key) => {
    };
  }
  // -----------------------------------------------------------------------
  // List all cloud-eligible keys from currently registered namespaces.
  // -----------------------------------------------------------------------
  async _enumerateCloudKeys() {
    const out = [];
    for (const ns of this.store.getRegisteredNs()) {
      const sc = this.store.getSchema(ns);
      if (!sc || !sc.cloud) {
        continue;
      }
      const keys = await this.store.list(ns);
      for (const k of keys) {
        out.push(ns + "/" + k);
      }
    }
    return out;
  }
  // -----------------------------------------------------------------------
  // pull(): GET server blobs for all cloud keys; merge into local via store.
  // -----------------------------------------------------------------------
  async pull() {
    const auth = readAuth();
    if (!auth) {
      return { ok: false, reason: "no-auth", pulled: [], conflicts: [] };
    }
    const keys = await this._enumerateCloudKeys();
    const body = {
      phone: auth.phone,
      token: auth.token,
      device_id: this.store.getDeviceId(),
      device_name: auth.device_name,
      keys
    };
    let resp;
    try {
      resp = await httpsPostJson(CLOUD_BASE + "/api/gaea/qqq/state/pull", body);
    } catch (e) {
      return { ok: false, reason: "network: " + (e && e.message), pulled: [], conflicts: [] };
    }
    if (resp.status !== 200 || !resp.json || !resp.json.ok) {
      return { ok: false, reason: "http " + resp.status + ": " + (resp.json && resp.json.error), pulled: [], conflicts: [] };
    }
    const blobs = resp.json.blobs || {};
    const pulled = [];
    const conflicts = [];
    for (const fullKey of Object.keys(blobs)) {
      const slash = fullKey.indexOf("/");
      if (slash <= 0) {
        continue;
      }
      const ns = fullKey.slice(0, slash);
      const key = fullKey.slice(slash + 1);
      const sc = this.store.getSchema(ns);
      if (!sc) {
        continue;
      }
      const blob = blobs[fullKey];
      if (blob.deleted) {
        try {
          await this.store.del(ns, key);
          pulled.push(fullKey);
        } catch {
        }
        continue;
      }
      try {
        const local = await this.store.get(ns, key);
        let merged;
        if (sc.merger) {
          merged = sc.merger(local, blob.data, { ns, key });
        } else {
          const localTs = 0;
          merged = blob.ts >= localTs ? blob.data : local;
        }
        await this.store.setNow(ns, key, merged);
        pulled.push(fullKey);
      } catch (e) {
        console.warn("[cloud.pull] merge failed", fullKey, e);
        conflicts.push(fullKey);
      }
    }
    return { ok: true, pulled, conflicts };
  }
  // -----------------------------------------------------------------------
  // push(): send all outbox-queued payloads, drop on success.
  // -----------------------------------------------------------------------
  async push() {
    const auth = readAuth();
    if (!auth) {
      return { ok: false, reason: "no-auth", pushed: [], failed: [] };
    }
    const entries = this.store.listOutbox();
    if (entries.length === 0) {
      return { ok: true, pushed: [], failed: [] };
    }
    const lastByKey = /* @__PURE__ */ new Map();
    for (const ent of entries) {
      try {
        const raw = fs10.readFileSync(ent.file, "utf8");
        const p = JSON.parse(raw);
        if (!p || !p.ns || !p.key) {
          continue;
        }
        lastByKey.set(p.ns + "/" + p.key, { seq: ent.seq, payload: p });
      } catch (e) {
        console.warn("[cloud.push] bad outbox entry", ent.file, e);
      }
    }
    const blobs = {};
    for (const [fullKey, item] of lastByKey.entries()) {
      const sc = this.store.getSchema(item.payload.ns);
      if (!sc) {
        continue;
      }
      blobs[fullKey] = {
        data: item.payload.value,
        ts: item.payload.ts || Date.now(),
        v: sc.v,
        form: sc.form,
        deleted: !!item.payload.deleted
      };
    }
    const body = {
      phone: auth.phone,
      token: auth.token,
      device_id: this.store.getDeviceId(),
      device_name: auth.device_name,
      blobs
    };
    let resp;
    try {
      resp = await httpsPostJson(CLOUD_BASE + "/api/gaea/qqq/state/push", body);
    } catch (e) {
      return { ok: false, reason: "network: " + (e && e.message), pushed: [], failed: Object.keys(blobs) };
    }
    if (resp.status !== 200 || !resp.json || !resp.json.ok) {
      return { ok: false, reason: "http " + resp.status + ": " + (resp.json && resp.json.error), pushed: [], failed: Object.keys(blobs) };
    }
    const accepted = Array.isArray(resp.json.accepted) ? resp.json.accepted : Object.keys(blobs);
    const rejected = Array.isArray(resp.json.rejected) ? resp.json.rejected : [];
    const failedKeys = new Set(rejected.map((r) => r.key));
    for (const ent of entries) {
      try {
        const raw = fs10.readFileSync(ent.file, "utf8");
        const p = JSON.parse(raw);
        const fullKey = p.ns + "/" + p.key;
        if (!failedKeys.has(fullKey)) {
          this.store.dropOutbox(ent.seq);
        }
      } catch {
      }
    }
    this.store.markSyncedAt(Date.now());
    return { ok: true, pushed: accepted, failed: rejected.map((r) => r.key) };
  }
  // -----------------------------------------------------------------------
  // sync(): three-step pull → flush → push.
  // -----------------------------------------------------------------------
  async sync() {
    const auth = readAuth();
    if (!auth) {
      return { ok: false, reason: "no-auth" };
    }
    const pullR = await this.pull();
    try {
      await this.store.flush();
    } catch {
    }
    const pushR = await this.push();
    return {
      ok: pullR.ok && pushR.ok,
      reason: !pullR.ok ? pullR.reason : !pushR.ok ? pushR.reason : void 0,
      pull: pullR,
      push: pushR
    };
  }
};

// shell/qg.ts
var path10 = __toESM(require("path"));
var fs11 = __toESM(require("fs"));
var zlib = __toESM(require("zlib"));
var crypto4 = __toESM(require("crypto"));
var import_events3 = require("events");
var DEFAULT_DEBOUNCE_MS2 = 250;
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
    const h = crypto4.createHash("sha256").update(v).digest("hex").slice(0, 32);
    v = v.slice(0, MAX_SAFE_NAME - 33) + "_" + h;
  }
  return v;
}
async function atomicWrite(absPath, data) {
  const dir = path10.dirname(absPath);
  await fs11.promises.mkdir(dir, { recursive: true });
  const tmp = absPath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 8);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  await fs11.promises.writeFile(tmp, buf);
  try {
    await fs11.promises.rename(tmp, absPath);
  } catch (e) {
    if (e && (e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES")) {
      try {
        await fs11.promises.unlink(absPath);
      } catch {
      }
      await fs11.promises.rename(tmp, absPath);
    } else {
      try {
        await fs11.promises.unlink(tmp);
      } catch {
      }
      throw e;
    }
  }
}
function atomicWriteSync(absPath, data) {
  const dir = path10.dirname(absPath);
  try {
    fs11.mkdirSync(dir, { recursive: true });
  } catch {
  }
  const tmp = absPath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 8);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  fs11.writeFileSync(tmp, buf);
  try {
    fs11.renameSync(tmp, absPath);
  } catch (e) {
    if (e && (e.code === "EEXIST" || e.code === "EPERM" || e.code === "EACCES")) {
      try {
        fs11.unlinkSync(absPath);
      } catch {
      }
      fs11.renameSync(tmp, absPath);
    } else {
      try {
        fs11.unlinkSync(tmp);
      } catch {
      }
      throw e;
    }
  }
}
var Qg = class _Qg extends import_events3.EventEmitter {
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
    this.nsDir = path10.join(rootDir, "ns");
    this.locksDir = path10.join(rootDir, "locks");
    this.outboxDir = path10.join(rootDir, "outbox");
    this.corruptDir = path10.join(rootDir, "corrupt");
    for (const d of [this.nsDir, this.locksDir, this.outboxDir, this.corruptDir]) {
      try {
        fs11.mkdirSync(d, { recursive: true });
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
      for (const f of fs11.readdirSync(this.outboxDir)) {
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
      outbox = fs11.readdirSync(this.outboxDir).filter((f) => f.endsWith(".json")).length;
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
    return path10.join(this.nsDir, safeNs, safeKey + ext);
  }
  _lockPath(safeNs, safeKey) {
    return path10.join(this.locksDir, safeNs + "__" + safeKey + ".lock");
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
    await fs11.promises.mkdir(path10.dirname(lp), { recursive: true });
    for (let i = 0; i < 40; i++) {
      try {
        const fd = fs11.openSync(lp, "wx");
        fs11.writeSync(fd, JSON.stringify({ pid: process.pid, ts: nowMs() }));
        fs11.closeSync(fd);
        return lp;
      } catch (e) {
        if (e && e.code === "EEXIST") {
          let stale = false;
          try {
            const info = JSON.parse(fs11.readFileSync(lp, "utf8"));
            if (typeof info.ts === "number" && nowMs() - info.ts > LOCK_STALE_MS)
              stale = true;
          } catch {
            stale = true;
          }
          if (stale) {
            try {
              fs11.unlinkSync(lp);
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
      fs11.unlinkSync(lp);
    } catch {
    }
  }
  // ----- corrupt isolation --------------------------------------------------
  _quarantine(safeNs, safeKey, form, reason) {
    try {
      const src = this._payloadPath(safeNs, safeKey, form);
      if (!fs11.existsSync(src))
        return;
      const ext = path10.extname(src);
      const ts = nowMs();
      const dst = path10.join(this.corruptDir, safeNs + "__" + safeKey + "." + ts + ext);
      fs11.mkdirSync(this.corruptDir, { recursive: true });
      fs11.renameSync(src, dst);
      console.warn("[qg] quarantined", src, "->", dst, "reason=", reason);
    } catch (e) {
      console.warn("[qg] _quarantine failed:", e);
    }
  }
  // ----- load ---------------------------------------------------------------
  async _loadFromDisk(st) {
    const sc = this._requireSchema(st.ns);
    const payload = this._payloadPath(st.safeNs, st.safeKey, sc.form);
    if (!fs11.existsSync(payload)) {
      st.value = sc.form === "log" ? [] : null;
      st.loaded = true;
      return;
    }
    try {
      const buf = await fs11.promises.readFile(payload);
      st.value = this._decode(sc.form, buf);
      if (sc.form === "log") {
        const tailPath = payload + ".tail";
        if (fs11.existsSync(tailPath)) {
          try {
            const tailBuf = await fs11.promises.readFile(tailPath);
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
      await fs11.promises.mkdir(path10.dirname(tailPath), { recursive: true });
      await fs11.promises.appendFile(tailPath, line, "utf8");
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
      if (fs11.existsSync(payload)) {
        await fs11.promises.unlink(payload);
        any = true;
      }
    } catch {
    }
    try {
      const tp = payload + ".tail";
      if (fs11.existsSync(tp))
        await fs11.promises.unlink(tp);
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
    const dir = path10.join(this.nsDir, safeName(ns));
    const out = [];
    try {
      for (const f of await fs11.promises.readdir(dir)) {
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
    const ms = typeof sc.debounceMs === "number" ? sc.debounceMs : DEFAULT_DEBOUNCE_MS2;
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
  async flushOne(ns, key) {
    const id = ns + "::" + key;
    const st = this.states.get(id);
    if (!st)
      return;
    const sc = this.schemas.get(ns);
    if (!sc)
      return;
    await this._flushKey(st, sc);
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
        if (fs11.existsSync(tailPath)) {
          try {
            const tailBuf = await fs11.promises.readFile(tailPath);
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
          if (fs11.existsSync(tailPath))
            await fs11.promises.unlink(tailPath);
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
    if (!fs11.existsSync(payload))
      return;
    let diskVal;
    try {
      diskVal = this._decode(sc.form, await fs11.promises.readFile(payload));
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
      const f = path10.join(this.outboxDir, seq + ".json");
      const payload = { seq, ns, key, ts: nowMs(), deleted, value: deleted ? null : value };
      atomicWriteSync(f, JSON.stringify(payload));
    } catch (e) {
      console.warn("[qg] _queueOutbox failed:", e);
    }
  }
  listOutbox() {
    const out = [];
    try {
      const files = fs11.readdirSync(this.outboxDir).filter((f) => f.endsWith(".json")).sort();
      for (const f of files)
        out.push({ seq: f.replace(/\.json$/, ""), file: path10.join(this.outboxDir, f) });
    } catch {
    }
    return out;
  }
  dropOutbox(seq) {
    const f = path10.join(this.outboxDir, seq + ".json");
    try {
      fs11.unlinkSync(f);
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

// shell/download-service.ts
var http2 = __toESM(require("http"));
var https2 = __toESM(require("https"));
var fs12 = __toESM(require("fs"));
var path11 = __toESM(require("path"));
var crypto5 = __toESM(require("crypto"));
var import_url2 = require("url");
var DownloadService = class {
  constructor(cacheDir) {
    this._active = /* @__PURE__ */ new Map();
    this._sendProgress = null;
    this._cacheDir = path11.join(cacheDir, "downloads");
    try {
      fs12.mkdirSync(this._cacheDir, { recursive: true });
    } catch {
    }
  }
  /** Set the progress callback. Called from main.ts after window is created. */
  setProgressSender(fn) {
    this._sendProgress = fn;
  }
  // ---- public API ----
  /** Start a download. Returns the entry immediately; progress is async. */
  start(opts) {
    const id = "dl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    const dir = opts.dir || this._cacheDir;
    const fileName = opts.fileName || this._extractFileName(opts.url);
    const filePath = path11.join(dir, fileName);
    const entry = {
      id,
      url: opts.url,
      filePath,
      totalBytes: 0,
      bytesDone: 0,
      done: false,
      error: null,
      sha256Ok: false
    };
    let resumeFrom = 0;
    try {
      if (fs12.existsSync(filePath)) {
        resumeFrom = fs12.statSync(filePath).size;
        entry.bytesDone = resumeFrom;
      }
    } catch {
    }
    const controller = new AbortController();
    this._active.set(id, { controller, entry });
    this._doDownload(entry, opts, controller.signal, resumeFrom).catch((err) => {
      if (!entry.done) {
        entry.error = String(err && err.message || err);
        entry.done = true;
        this._emit(entry);
      }
    });
    this._emit(entry);
    return entry;
  }
  cancel(id) {
    const a = this._active.get(id);
    if (!a)
      return false;
    try {
      a.controller.abort();
    } catch {
    }
    a.entry.done = true;
    a.entry.error = "cancelled";
    this._emit(a.entry);
    this._active.delete(id);
    return true;
  }
  list() {
    return Array.from(this._active.values()).map((a) => a.entry);
  }
  // ---- internal ----
  _emit(entry) {
    if (this._sendProgress) {
      try {
        this._sendProgress(entry);
      } catch {
      }
    }
  }
  _extractFileName(url) {
    try {
      const u = new import_url2.URL(url);
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length > 0) {
        const last = decodeURIComponent(segs[segs.length - 1]);
        if (last && last.indexOf(".") >= 0)
          return last;
      }
    } catch {
    }
    let host = "download";
    try {
      host = new import_url2.URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    } catch {
    }
    return host + "_" + Date.now().toString(36) + ".bin";
  }
  async _doDownload(entry, opts, signal, resumeFrom) {
    const parsedUrl = new import_url2.URL(opts.url);
    const lib = parsedUrl.protocol === "https:" ? https2 : http2;
    try {
      fs12.mkdirSync(path11.dirname(entry.filePath), { recursive: true });
    } catch {
    }
    let hasher = null;
    if (opts.sha256) {
      hasher = crypto5.createHash("sha256");
    }
    const flags = resumeFrom > 0 ? "a" : "w";
    let fd = null;
    try {
      fd = fs12.openSync(entry.filePath, flags);
    } catch (e) {
      entry.error = "cannot open file: " + (e.message || String(e));
      entry.done = true;
      this._emit(entry);
      return;
    }
    try {
      const contentLength = await this._headRequest(parsedUrl, opts, signal, resumeFrom);
      if (contentLength < 0) {
        try {
          fs12.ftruncateSync(fd);
        } catch {
        }
        try {
          fs12.closeSync(fd);
        } catch {
        }
        fd = fs12.openSync(entry.filePath, "w");
        resumeFrom = 0;
        entry.bytesDone = 0;
      } else {
        entry.totalBytes = resumeFrom + contentLength;
      }
      if (signal.aborted) {
        entry.error = "cancelled";
        entry.done = true;
        this._emit(entry);
        try {
          fs12.closeSync(fd);
        } catch {
        }
        return;
      }
      const headers = {
        ...opts.headers || {},
        "User-Agent": "qqq-shell-v2/0.1",
        "Accept": "*/*"
      };
      if (resumeFrom > 0) {
        headers["Range"] = "bytes=" + resumeFrom + "-";
      }
      const reqOpts = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ""),
        method: "GET",
        headers
      };
      await new Promise((resolve2, reject) => {
        const req = lib.request(reqOpts, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            try {
              fs12.closeSync(fd);
            } catch {
            }
            fd = null;
            req.destroy();
            const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
            const nextUrl = new import_url2.URL(loc, opts.url).toString();
            const nextOpts = { ...opts, url: nextUrl };
            this._doDownload(entry, nextOpts, signal, 0).then(resolve2, reject);
            return;
          }
          const cl = res.headers["content-length"];
          if (cl) {
            const clStr = Array.isArray(cl) ? cl[0] : cl;
            const parsed = parseInt(clStr, 10);
            if (!isNaN(parsed)) {
              if (res.statusCode === 206) {
                entry.totalBytes = resumeFrom + parsed;
              } else if (res.statusCode === 200) {
                entry.totalBytes = parsed;
              }
            }
          }
          if (hasher && resumeFrom > 0) {
            try {
              const existing = fs12.readFileSync(entry.filePath);
              hasher.update(existing);
            } catch {
            }
          }
          res.on("data", (chunk) => {
            if (signal.aborted) {
              req.destroy();
              return;
            }
            try {
              fs12.writeSync(fd, chunk);
              entry.bytesDone += chunk.length;
              if (hasher)
                hasher.update(chunk);
              this._emit(entry);
            } catch (e) {
              req.destroy();
              reject(e);
            }
          });
          res.on("end", () => {
            try {
              fs12.closeSync(fd);
            } catch {
            }
            fd = null;
            if (hasher) {
              const digest = hasher.digest("hex");
              entry.sha256Ok = digest === opts.sha256;
              if (!entry.sha256Ok) {
                entry.error = "sha256 mismatch: expected " + opts.sha256 + " got " + digest;
                entry.done = true;
                this._emit(entry);
                reject(new Error(entry.error));
                return;
              }
            }
            entry.done = true;
            entry.error = null;
            this._emit(entry);
            this._active.delete(entry.id);
            resolve2();
          });
          res.on("error", (e) => {
            try {
              fs12.closeSync(fd);
            } catch {
            }
            fd = null;
            reject(e);
          });
        });
        req.on("error", (e) => {
          if (e.name === "AbortError" || signal.aborted) {
            entry.error = "cancelled";
          } else {
            entry.error = String(e.message || e);
          }
          try {
            fs12.closeSync(fd);
          } catch {
          }
          fd = null;
          entry.done = true;
          this._emit(entry);
          reject(e);
        });
        if (signal.aborted) {
          req.destroy();
          try {
            fs12.closeSync(fd);
          } catch {
          }
          fd = null;
          entry.error = "cancelled";
          entry.done = true;
          this._emit(entry);
          reject(new Error("cancelled"));
          return;
        }
        signal.addEventListener("abort", () => {
          try {
            req.destroy();
          } catch {
          }
          try {
            fs12.closeSync(fd);
          } catch {
          }
          fd = null;
        });
        req.end();
      });
    } catch (e) {
      if (fd !== null) {
        try {
          fs12.closeSync(fd);
        } catch {
        }
      }
      if (!entry.error) {
        entry.error = String(e.message || e);
      }
      entry.done = true;
      this._emit(entry);
      this._active.delete(entry.id);
    }
  }
  /** HEAD request to check if server supports Range, returns content-length or -1 */
  _headRequest(parsedUrl, opts, signal, resumePos) {
    return new Promise((resolve2) => {
      const lib = parsedUrl.protocol === "https:" ? https2 : http2;
      const headers = {
        ...opts.headers || {},
        "User-Agent": "qqq-shell-v2/0.1"
      };
      if (resumePos > 0) {
        headers["Range"] = "bytes=0-0";
      }
      const req = lib.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + (parsedUrl.search || ""),
        method: resumePos > 0 ? "GET" : "HEAD",
        headers
      }, (res) => {
        if (res.statusCode === 206) {
          const cr = res.headers["content-range"];
          if (cr) {
            const crStr = Array.isArray(cr) ? cr[0] : cr;
            const m = /bytes \d+-\d+\/(\d+)/.exec(crStr);
            if (m) {
              resolve2(parseInt(m[1], 10) || -1);
              return;
            }
          }
          const cl = res.headers["content-length"];
          if (cl) {
            const clStr = Array.isArray(cl) ? cl[0] : cl;
            resolve2(parseInt(clStr, 10));
            return;
          }
          resolve2(-1);
          return;
        }
        if (res.statusCode === 200) {
          const cl2 = res.headers["content-length"];
          if (cl2) {
            const cl2Str = Array.isArray(cl2) ? cl2[0] : cl2;
            resolve2(parseInt(cl2Str, 10));
          } else {
            resolve2(-1);
          }
          return;
        }
        resolve2(-1);
      });
      req.on("error", () => resolve2(-1));
      signal.addEventListener("abort", () => {
        try {
          req.destroy();
        } catch {
        }
      });
      if (resumePos > 0) {
        req.end();
      } else {
        req.end();
      }
      setTimeout(() => {
        try {
          req.destroy();
        } catch {
        }
        resolve2(-1);
      }, 8e3);
    });
  }
};

// shell/update-service.ts
var http3 = __toESM(require("http"));
var https3 = __toESM(require("https"));
var fs13 = __toESM(require("fs"));
var path12 = __toESM(require("path"));
var import_url3 = require("url");
var import_child_process5 = require("child_process");
var UPDATE_MANIFEST_URL = "https://gh555.com/qqq-app/version.json";
var UPDATE_TAR_URL = "https://gh555.com/qqq-app/server-app.tar.xz";
var UpdateService = class {
  constructor(appRoot, currentVersion) {
    this._abortController = null;
    this._appRoot = appRoot;
    this._currentVersion = currentVersion || "0.0.0";
    this._statePath = path12.join(appRoot, "userData", "update-state.json");
    this._state = this._loadState();
  }
  // ---- public API ----
  /** Check for updates. Returns latest version info. */
  async check() {
    const latest = await this._fetchVersion();
    this._state.lastCheck = Date.now();
    if (latest) {
      this._state.lastVersion = latest;
    }
    this._saveState();
    const need = this._compareVersions(this._currentVersion, latest || "0.0.0") < 0;
    return {
      latestVersion: latest || this._currentVersion,
      currentVersion: this._currentVersion,
      needUpdate: need
    };
  }
  /** Download and apply update. Returns result. */
  async apply() {
    this._abortController = new AbortController();
    try {
      const latestVersion = this._state.lastVersion || await this._fetchVersionDirect();
      if (!latestVersion) {
        return { success: false, version: "", error: "Failed to fetch latest version" };
      }
      const stagingDir = path12.join(this._appRoot, "cache", "staging");
      const tarPath = path12.join(stagingDir, "server-app.tar.xz");
      const extractDir = path12.join(stagingDir, "server-app");
      try {
        fs13.mkdirSync(stagingDir, { recursive: true });
      } catch {
      }
      try {
        fs13.rmSync(extractDir, { recursive: true, force: true });
      } catch {
      }
      const downloadOk = await this._downloadFile(
        UPDATE_TAR_URL,
        tarPath,
        this._abortController.signal
      );
      if (!downloadOk) {
        return { success: false, version: "", error: "Download failed" };
      }
      const extractOk = this._extractTarXz(tarPath, extractDir);
      if (!extractOk) {
        return { success: false, version: "", error: "Extraction failed" };
      }
      const serverAppDir = path12.join(this._appRoot, "server-app");
      const oldDir = path12.join(this._appRoot, "server-app.old");
      try {
        fs13.rmSync(oldDir, { recursive: true, force: true });
      } catch {
      }
      try {
        if (fs13.existsSync(serverAppDir)) {
          fs13.renameSync(serverAppDir, oldDir);
        }
      } catch (e) {
        return { success: false, version: "", error: "Atomic swap failed (backup): " + (e.message || e) };
      }
      try {
        fs13.renameSync(extractDir, serverAppDir);
      } catch (e) {
        try {
          fs13.renameSync(oldDir, serverAppDir);
        } catch {
        }
        return { success: false, version: "", error: "Atomic swap failed (replace): " + (e.message || e) };
      }
      try {
        fs13.unlinkSync(tarPath);
      } catch {
      }
      try {
        fs13.rmSync(oldDir, { recursive: true, force: true });
      } catch {
      }
      this._state.currentVersion = latestVersion;
      this._state.lastApplied = latestVersion;
      this._saveState();
      this._currentVersion = latestVersion;
      return { success: true, version: latestVersion };
    } catch (e) {
      return { success: false, version: "", error: e.message || String(e) };
    } finally {
      this._abortController = null;
    }
  }
  /** Get current update state. */
  getState() {
    return { ...this._state };
  }
  /** Abort current download. */
  abort() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }
  // ---- internal ----
  _loadState() {
    const defaults = {
      lastCheck: 0,
      lastVersion: this._currentVersion,
      currentVersion: this._currentVersion,
      lastApplied: ""
    };
    try {
      if (!fs13.existsSync(this._statePath))
        return defaults;
      const raw = fs13.readFileSync(this._statePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        lastCheck: typeof parsed.lastCheck === "number" ? parsed.lastCheck : 0,
        lastVersion: typeof parsed.lastVersion === "string" ? parsed.lastVersion : this._currentVersion,
        currentVersion: typeof parsed.currentVersion === "string" ? parsed.currentVersion : this._currentVersion,
        lastApplied: typeof parsed.lastApplied === "string" ? parsed.lastApplied : ""
      };
    } catch {
      return defaults;
    }
  }
  _saveState() {
    try {
      const dir = path12.dirname(this._statePath);
      try {
        fs13.mkdirSync(dir, { recursive: true });
      } catch {
      }
      fs13.writeFileSync(this._statePath, JSON.stringify(this._state, null, 2), "utf8");
    } catch {
    }
  }
  // ---- HTTP helpers ----
  _httpsGet(url) {
    return new Promise((resolve2, reject) => {
      const u = new import_url3.URL(url);
      const get3 = u.protocol === "https:" ? https3.get : http3.get;
      const req = get3(url, { timeout: 15e3 }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => resolve2({ status: res.statusCode || 0, data }));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
    });
  }
  async _fetchVersion() {
    try {
      const { status, data } = await this._httpsGet(UPDATE_MANIFEST_URL);
      if (status !== 200)
        return null;
      const parsed = JSON.parse(data);
      return parsed.version || null;
    } catch {
      return null;
    }
  }
  async _fetchVersionDirect() {
    return this._fetchVersion();
  }
  _downloadFile(url, dest, signal) {
    return new Promise((resolve2) => {
      const u = new import_url3.URL(url);
      const get3 = u.protocol === "https:" ? https3.get : http3.get;
      const req = get3(url, { timeout: 12e4 }, (res) => {
        if (res.statusCode !== 200) {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const loc = res.headers.location;
            if (loc) {
              this._downloadFile(loc, dest, signal).then(resolve2);
              return;
            }
          }
          resolve2(false);
          return;
        }
        const file = fs13.createWriteStream(dest);
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          file.write(chunk);
        });
        res.on("end", () => {
          file.end();
          resolve2(bytes > 0);
        });
        res.on("error", () => {
          try {
            file.close();
          } catch {
          }
          resolve2(false);
        });
      });
      req.on("error", () => resolve2(false));
      req.on("timeout", () => {
        req.destroy();
        resolve2(false);
      });
      signal.addEventListener("abort", () => {
        req.destroy();
        resolve2(false);
      });
    });
  }
  _extractTarXz(tarPath, destDir) {
    try {
      try {
        fs13.mkdirSync(destDir, { recursive: true });
      } catch {
      }
      const result = (0, import_child_process5.spawnSync)("tar", ["-xJf", tarPath, "-C", destDir], {
        stdio: "pipe",
        timeout: 3e4
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }
  /** Compare two semver-like version strings. Returns -1/0/1 */
  _compareVersions(a, b) {
    const pa = (a || "0.0.0").split(".").map(Number);
    const pb = (b || "0.0.0").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb)
        return 1;
      if (na < nb)
        return -1;
    }
    return 0;
  }
};

// shell/main.ts
var portable = applyPortablePaths();
import_electron3.app.commandLine.appendSwitch("forced-colors", "none");
import_electron3.app.commandLine.appendSwitch("force-color-profile", "srgb");
import_electron3.app.commandLine.appendSwitch("disable-features", "ForcedColors,AutoDarkMode");
var APP_VERSION = "0.0.2";
var DEFAULT_REMOTE_URL = "http://127.0.0.1:8090/qqq-app/";
function loadBootConfig() {
  const cfgPath = path13.join(portable.root, "config.json");
  let cfg = { url: DEFAULT_REMOTE_URL, healthTimeoutMs: 3e3 };
  if (fs14.existsSync(cfgPath)) {
    try {
      const j = JSON.parse(fs14.readFileSync(cfgPath, "utf8"));
      if (j.url) {
        cfg.url = j.url;
      }
      if (j.healthTimeoutMs) {
        cfg.healthTimeoutMs = j.healthTimeoutMs;
      }
    } catch (e) {
      console.warn("[main] bad config.json:", e);
    }
  } else {
    try {
      const tpl = {
        url: DEFAULT_REMOTE_URL,
        healthTimeoutMs: 3e3,
        _comment: "qz/VM-snapshot friendly. Edit url to point at your server. NEVER stored in AppData."
      };
      fs14.writeFileSync(cfgPath, JSON.stringify(tpl, null, 2), "utf8");
      console.log("[main] wrote default config.json ->", cfgPath);
    } catch (e) {
      console.warn("[main] could not write default config.json:", e);
    }
  }
  if (process.env.QQQ_URL) {
    cfg.url = process.env.QQQ_URL;
  }
  for (const arg of process.argv.slice(1)) {
    if (arg.startsWith("--url=")) {
      cfg.url = arg.slice(6);
    }
  }
  return cfg;
}
var bootConfig = loadBootConfig();
var isOfflineFlag = process.argv.includes("--offline");
var isDevFlag = process.argv.includes("--dev") || process.env.QQQ_DEV === "1";
function healthCheck(urlStr, timeoutMs) {
  return new Promise((resolve2) => {
    if (isOfflineFlag) {
      return resolve2(false);
    }
    let healthUrl;
    try {
      const u = new import_url4.URL("health", urlStr.endsWith("/") ? urlStr : urlStr + "/");
      healthUrl = u.toString();
    } catch {
      return resolve2(false);
    }
    const lib = healthUrl.startsWith("https") ? https4 : http4;
    const req = lib.get(healthUrl, { timeout: timeoutMs }, (res) => {
      const ok = !!(res.statusCode && res.statusCode >= 200 && res.statusCode < 400);
      res.resume();
      resolve2(ok);
    });
    req.on("error", () => resolve2(false));
    req.on("timeout", () => {
      req.destroy();
      resolve2(false);
    });
  });
}
import_electron3.protocol.registerSchemesAsPrivileged([
  { scheme: "qqq-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
var mainWindow = null;
var engineHost = new EngineHost(portable.root);
var audioEngine = new AudioEngine(portable.root);
var monacoHost = new MonacoHost();
var qzSpawn = new QzSpawn(portable.root);
var lspBridge = new LspBridge(portable.root);
var cacheStore = new CacheStore(portable.cache);
var hashService = new HashService(cacheStore);
var mediaService = new MediaService(portable.root, qzSpawn, cacheStore, hashService);
var stateStore = new StateStore(portable.userData);
var stateCloud = new StateCloud(stateStore);
var _qgInstances = /* @__PURE__ */ new Map();
var downloadService = new DownloadService(portable.cache);
var updateService = new UpdateService(portable.root, APP_VERSION);
function registerShellState() {
  try {
    stateStore.register("qqq.shell", {
      v: 1,
      form: "doc",
      cloud: true,
      // merger: prefer remote scalars; for asset_roots merge as union of arrays
      merger: (local, remote, ctx) => {
        if (!local) {
          return remote;
        }
        if (!remote) {
          return local;
        }
        if (typeof local === "object" && typeof remote === "object" && !Array.isArray(local) && !Array.isArray(remote)) {
          return { ...local, ...remote };
        }
        if (Array.isArray(local) && Array.isArray(remote)) {
          const s = /* @__PURE__ */ new Set([...local, ...remote]);
          return Array.from(s);
        }
        return remote;
      }
    });
  } catch (e) {
    console.warn("[state] registerShellState failed:", e);
  }
}
stateStore.on("changed", (msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("qqq:state:changed", msg);
    } catch {
    }
  }
});
var zoomFile = path13.join(portable.root, "zoom.json");
var zoomFactor = 0.85;
async function _restoreWindowBounds(win) {
  try {
    const v = await stateStore.get("qqq.shell", "window_bounds");
    if (!v) {
      return;
    }
    if (v.maximized) {
      win.maximize();
      return;
    }
    if (typeof v.w === "number" && typeof v.h === "number" && v.w > 0 && v.h > 0) {
      const displays = import_electron3.screen.getAllDisplays();
      const anyOverlap = displays.some((d) => {
        const dx = d.bounds.x, dy = d.bounds.y, dw = d.bounds.width, dh = d.bounds.height;
        return v.x < dx + dw && v.x + v.w > dx && v.y < dy + dh && v.y + v.h > dy;
      });
      if (anyOverlap) {
        win.setBounds({ x: v.x || 0, y: v.y || 0, width: v.w, height: v.h });
      }
    }
  } catch (e) {
  }
}
async function restoreWindowBounds(win) {
  await _restoreWindowBounds(win);
}
function _loadZoomBoot() {
  try {
    if (fs14.existsSync(zoomFile)) {
      const z = JSON.parse(fs14.readFileSync(zoomFile, "utf8"));
      if (typeof z.factor === "number" && z.factor >= 0.5 && z.factor <= 2) {
        zoomFactor = z.factor;
      }
    }
  } catch (e) {
  }
}
_loadZoomBoot();
async function _hydrateZoomFromState() {
  try {
    const v = await stateStore.get("qqq.shell", "zoom");
    if (v && typeof v.factor === "number" && v.factor >= 0.5 && v.factor <= 2) {
      zoomFactor = v.factor;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.setZoomFactor(zoomFactor);
      }
    } else {
      await stateStore.setNow("qqq.shell", "zoom", { factor: zoomFactor });
      try {
        if (fs14.existsSync(zoomFile)) {
          fs14.renameSync(zoomFile, zoomFile + ".migrated");
        }
      } catch {
      }
    }
  } catch (e) {
    console.warn("[state] _hydrateZoomFromState failed:", e);
  }
}
var saveZoom = () => {
  try {
    stateStore.set("qqq.shell", "zoom", { factor: zoomFactor });
  } catch {
  }
};
function createWindow() {
  const preloadPath = path13.join(__dirname, "preload.js");
  const win = new import_electron3.BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 800,
    show: false,
    frame: false,
    backgroundColor: "#fdf6e3",
    // solarized base3
    title: "qqq-shell",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      // allow cross-origin fetch (AI panel → gh555.com)
      // explicit: never share node features into renderer
      additionalArguments: [
        `--qqq-app-root=${portable.root}`,
        `--qqq-version=${APP_VERSION}`
      ]
    }
  });
  win.removeMenu();
  win.once("ready-to-show", async () => {
    await restoreWindowBounds(win);
    win.show();
  });
  win.on("closed", () => {
    lspBridge.removeTarget(win.webContents);
    mainWindow = null;
  });
  let boundsSaveTimer = null;
  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) {
      return;
    }
    const b = win.getBounds();
    try {
      stateStore.set("qqq.shell", "window_bounds", { x: b.x, y: b.y, w: b.width, h: b.height, maximized: false });
    } catch {
    }
  };
  const debouncedSaveBounds = () => {
    if (boundsSaveTimer) {
      clearTimeout(boundsSaveTimer);
    }
    boundsSaveTimer = setTimeout(saveBounds, 500);
  };
  win.on("resize", debouncedSaveBounds);
  win.on("move", debouncedSaveBounds);
  win.on("maximize", () => {
    try {
      stateStore.set("qqq.shell", "window_bounds", { maximized: true });
    } catch {
    }
  });
  win.on("unmaximize", () => {
    saveBounds();
  });
  downloadService.setProgressSender((entry) => {
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send("qqq:download:progress", entry);
      } catch {
      }
    }
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(zoomFactor);
    lspBridge.addTarget(win.webContents);
  });
  win.webContents.on("before-input-event", (ev, input) => {
    if (input.type !== "keyDown") {
      return;
    }
    const ctrl = input.control || input.meta;
    if (!ctrl) {
      return;
    }
    const k = input.key;
    if (k === "=" || k === "+") {
      ev.preventDefault();
      zoomFactor = Math.min(2, +(zoomFactor + 0.05).toFixed(2));
      win.webContents.setZoomFactor(zoomFactor);
      saveZoom();
    } else if (k === "-" || k === "_") {
      ev.preventDefault();
      zoomFactor = Math.max(0.5, +(zoomFactor - 0.05).toFixed(2));
      win.webContents.setZoomFactor(zoomFactor);
      saveZoom();
    } else if (k === "0") {
      ev.preventDefault();
      zoomFactor = 1;
      win.webContents.setZoomFactor(zoomFactor);
      saveZoom();
    }
  });
  if (isDevFlag) {
    win.webContents.openDevTools({ mode: "detach" });
    win.webContents.session.clearCache().catch(() => {
    });
    win.webContents.on("before-input-event", (ev, input) => {
      if (input.type !== "keyDown") {
        return;
      }
      if (input.key === "F5" || input.control && input.key.toLowerCase() === "r") {
        ev.preventDefault();
        win.webContents.reloadIgnoringCache();
      }
      if (input.control && input.shift && input.key.toLowerCase() === "i") {
        ev.preventDefault();
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools();
        } else {
          win.webContents.openDevTools({ mode: "detach" });
        }
      }
    });
    console.log("[main] DEV MODE: DevTools detached, cache cleared, F5/Ctrl+R reload, Ctrl+Shift+I devtools");
  }
  return win;
}
var lastBootMode = "fallback";
async function loadStaticFallback(reason) {
  if (!mainWindow) {
    return;
  }
  lastBootMode = "fallback";
  console.warn("[boot] static fallback:", reason);
  const candidates = [
    path13.join(__dirname, "..", "shell", "boot-fallback.html"),
    path13.join(__dirname, "boot-fallback.html"),
    path13.join(portable.root, "shell", "boot-fallback.html")
  ];
  for (const p of candidates) {
    if (fs14.existsSync(p)) {
      await mainWindow.loadFile(p, { query: { url: bootConfig.url, reason } });
      return;
    }
  }
  await mainWindow.loadURL("data:text/html,<h1>qqq-shell offline</h1>");
}
async function loadRemoteWithCacheGuard() {
  if (!mainWindow) {
    return false;
  }
  const wc = mainWindow.webContents;
  return new Promise((resolve2) => {
    let settled = false;
    const finish = (ok, mode) => {
      if (settled) {
        return;
      }
      settled = true;
      lastBootMode = mode;
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
      resolve2(ok);
    };
    const onFinish = () => {
      finish(true, "live");
    };
    const onFail = (_e, code, desc, validatedURL, isMain) => {
      if (!isMain) {
        return;
      }
      console.warn("[boot] did-fail-load", code, desc, validatedURL);
      finish(false, "fallback");
    };
    wc.on("did-finish-load", onFinish);
    wc.on("did-fail-load", onFail);
    mainWindow.loadURL(bootConfig.url).catch((err) => {
      console.warn("[boot] loadURL threw:", err && err.message);
      finish(false, "fallback");
    });
  });
}
async function boot() {
  mainWindow = createWindow();
  const healthy = await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs);
  if (healthy) {
    console.log("[boot] server OK ->", bootConfig.url);
  } else {
    console.warn("[boot] server unreachable; relying on PWA cache (if any)");
  }
  const ok = await loadRemoteWithCacheGuard();
  if (!ok) {
    await loadStaticFallback(healthy ? "load-failed" : "no-network-no-cache");
  } else if (!healthy) {
    lastBootMode = "cache";
    console.log("[boot] served from PWA cache");
  }
}
var _assetFileBuiltinRoots = [
  path13.normalize(portable.cache),
  path13.normalize(os2.homedir())
];
var _assetFileWorkspaceRoots = /* @__PURE__ */ new Set();
var _assetRootsStorePath = path13.join(portable.userData, "asset-roots.json");
function loadAssetRoots() {
  try {
    if (!fs14.existsSync(_assetRootsStorePath)) {
      return;
    }
    const raw = fs14.readFileSync(_assetRootsStorePath, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const r of arr) {
        if (typeof r === "string" && r) {
          _assetFileWorkspaceRoots.add(path13.normalize(r));
        }
      }
      console.log("[asset-roots] loaded", _assetFileWorkspaceRoots.size, "workspace root(s)");
    }
  } catch (e) {
    console.warn("[asset-roots] load failed:", e);
  }
}
async function _hydrateAssetRootsFromState() {
  try {
    const v = await stateStore.get("qqq.shell", "asset_roots");
    if (Array.isArray(v) && v.length > 0) {
      for (const r of v) {
        if (typeof r === "string" && r) {
          _assetFileWorkspaceRoots.add(path13.normalize(r));
        }
      }
      console.log("[asset-roots] hydrated", _assetFileWorkspaceRoots.size, "from state");
    } else {
      const arr = Array.from(_assetFileWorkspaceRoots);
      await stateStore.setNow("qqq.shell", "asset_roots", arr);
      try {
        if (fs14.existsSync(_assetRootsStorePath)) {
          fs14.renameSync(_assetRootsStorePath, _assetRootsStorePath + ".migrated");
        }
      } catch {
      }
    }
  } catch (e) {
    console.warn("[state] _hydrateAssetRootsFromState failed:", e);
  }
}
function persistAssetRoots() {
  try {
    const arr = Array.from(_assetFileWorkspaceRoots);
    stateStore.set("qqq.shell", "asset_roots", arr);
  } catch (e) {
    console.warn("[asset-roots] persist failed:", e);
  }
}
function addAssetRoot(absDir) {
  if (!absDir || typeof absDir !== "string") {
    return false;
  }
  if (!path13.isAbsolute(absDir)) {
    return false;
  }
  let norm;
  try {
    norm = path13.normalize(absDir);
  } catch {
    return false;
  }
  try {
    const st = fs14.statSync(norm);
    if (!st.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  if (_assetFileWorkspaceRoots.has(norm)) {
    return false;
  }
  _assetFileWorkspaceRoots.add(norm);
  persistAssetRoots();
  console.log("[asset-roots] added", norm);
  return true;
}
function isPathAllowed(abs) {
  const norm = path13.normalize(abs);
  for (const root of _assetFileBuiltinRoots) {
    if (norm === root || norm.startsWith(root + path13.sep)) {
      return true;
    }
  }
  for (const root of _assetFileWorkspaceRoots) {
    if (norm === root || norm.startsWith(root + path13.sep)) {
      return true;
    }
  }
  return false;
}
loadAssetRoots();
function registerAssetProtocol() {
  const roots = {
    // monaco-editor min build
    monaco: path13.join(portable.root, "node_modules", "monaco-editor", "min"),
    // shell-bundled static files (e.g. boot-fallback)
    shell: path13.join(portable.root, "shell")
  };
  import_electron3.protocol.registerFileProtocol("qqq-asset", (request, callback) => {
    try {
      const url = new import_url4.URL(request.url);
      const resource = url.hostname;
      const subPath = decodeURIComponent(url.pathname);
      if (resource === "file") {
        let abs = subPath.startsWith("/") ? subPath.slice(1) : subPath;
        abs = path13.normalize(abs);
        if (!path13.isAbsolute(abs) || !isPathAllowed(abs)) {
          console.warn("[qqq-asset/file] denied:", abs);
          return callback({
            error: -10
            /* ACCESS_DENIED */
          });
        }
        if (!fs14.existsSync(abs)) {
          return callback({
            error: -6
            /* FILE_NOT_FOUND */
          });
        }
        return callback({ path: abs });
      }
      const root = roots[resource];
      if (!root) {
        return callback({
          error: -6
          /* FILE_NOT_FOUND */
        });
      }
      const resolved = path13.normalize(path13.join(root, subPath));
      if (!resolved.startsWith(root)) {
        return callback({
          error: -10
          /* ACCESS_DENIED */
        });
      }
      callback({ path: resolved });
    } catch (e) {
      console.warn("[qqq-asset] bad url:", request.url, e);
      callback({
        error: -2
        /* FAILED */
      });
    }
  });
}
var _diskFreeCache = null;
var _DISK_FREE_TTL_MS = 30 * 1e3;
function resolveKpBridge() {
  const candidates = [
    path13.join(portable.root, "engines", "kp_bridge.py"),
    path13.join(portable.root, "resources", "app", "engines", "kp_bridge.py")
  ];
  for (const p of candidates) {
    if (fs14.existsSync(p)) {
      const py = process.env.QQQ_PYTHON || (process.platform === "win32" ? "python" : "python3");
      return { script: p, python: py };
    }
  }
  return null;
}
function diskFreeNodeFallback(drives) {
  const result = {};
  for (const d of drives || []) {
    try {
      const stats = fs14.statfsSync(d);
      const bsize = stats.bsize;
      const letter = (d.charAt(0) || "X").toUpperCase();
      result[letter] = {
        free: stats.bfree * bsize,
        total: stats.blocks * bsize
      };
    } catch {
    }
  }
  try {
    const desktop = path13.join(os2.homedir(), "Desktop");
    let used = 0;
    const entries = fs14.readdirSync(desktop);
    for (const e of entries) {
      try {
        used += fs14.statSync(path13.join(desktop, e)).size;
      } catch {
      }
    }
    result["DESKTOP"] = { used, path: desktop };
  } catch {
    result["DESKTOP"] = { used: 0 };
  }
  result["RECYCLE"] = { used: 0 };
  return result;
}
async function diskFreeViaKpBridge(drives) {
  const kp = resolveKpBridge();
  if (!kp) {
    return null;
  }
  return await new Promise((resolve2) => {
    let proc;
    try {
      proc = (0, import_child_process6.spawn)(kp.python, ["-u", kp.script], {
        cwd: portable.root,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: process.env
      });
    } catch (e) {
      console.warn("[diskFree] kp_bridge spawn failed:", e);
      return resolve2(null);
    }
    let out = "";
    let err = "";
    const guard = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
      }
    }, 8e3);
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (d) => {
      out += d;
    });
    proc.stderr?.on("data", (d) => {
      err += d;
    });
    proc.on("error", (e) => {
      clearTimeout(guard);
      console.warn("[diskFree] kp_bridge error:", e && e.message);
      resolve2(null);
    });
    proc.on("exit", (code) => {
      clearTimeout(guard);
      if (code !== 0) {
        if (err.trim()) {
          console.warn("[diskFree] kp_bridge stderr:", err.slice(0, 400));
        }
        return resolve2(null);
      }
      try {
        const j = JSON.parse(out.trim() || "{}");
        if (j && j.ok && j.data) {
          return resolve2(j.data);
        }
        console.warn("[diskFree] kp_bridge bad payload:", String(j.error || "").slice(0, 300));
        resolve2(null);
      } catch (e) {
        console.warn("[diskFree] kp_bridge json parse:", e && e.message, out.slice(0, 200));
        resolve2(null);
      }
    });
    try {
      const payload = JSON.stringify({ action: "disk_free_batch", drives: drives || [] });
      proc.stdin?.end(payload, "utf8");
    } catch (e) {
      clearTimeout(guard);
      console.warn("[diskFree] kp_bridge stdin failed:", e);
      resolve2(null);
    }
  });
}
async function diskFreeBatch(drives) {
  const key = JSON.stringify(drives || []);
  const now = Date.now();
  if (_diskFreeCache && _diskFreeCache.key === key && now - _diskFreeCache.t < _DISK_FREE_TTL_MS) {
    return _diskFreeCache.data;
  }
  let data = await diskFreeViaKpBridge(drives);
  if (!data) {
    data = diskFreeNodeFallback(drives);
  }
  _diskFreeCache = { t: now, key, data };
  return data;
}
function registerGlobalKey(accel, id) {
  try {
    const ok = import_electron3.globalShortcut.register(accel, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send("qqq:key:global", { id, accel });
        } catch {
        }
      }
    });
    if (!ok) {
      console.warn("[key.global] register failed:", accel, id);
    }
    return ok;
  } catch (e) {
    console.warn("[key.global] threw:", accel, id, e);
    return false;
  }
}
function registerIpc() {
  import_electron3.ipcMain.handle("qqq:app:root", () => portable.root);
  import_electron3.ipcMain.handle("qqq:boot:info", () => ({
    url: bootConfig.url,
    version: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    appRoot: portable.root,
    userData: portable.userData,
    cacheDir: portable.cache,
    logsDir: portable.logs,
    cwd: process.cwd(),
    homedir: os2.homedir(),
    engineAlive: engineHost.isAlive(),
    bootMode: lastBootMode
  }));
  import_electron3.ipcMain.handle("qqq:boot:retry", async () => {
    if (!mainWindow) {
      return false;
    }
    const healthy = await healthCheck(bootConfig.url, bootConfig.healthTimeoutMs);
    if (healthy) {
      console.log("[boot.retry] server OK -> reload");
      await mainWindow.loadURL(bootConfig.url);
      lastBootMode = "live";
      return true;
    }
    const ok = await loadRemoteWithCacheGuard();
    if (!ok) {
      await loadStaticFallback("retry-failed");
      return false;
    }
    lastBootMode = "cache";
    return true;
  });
  import_electron3.ipcMain.handle("qqq:boot:probe", async () => {
    return healthCheck(bootConfig.url, Math.min(bootConfig.healthTimeoutMs, 2e3));
  });
  import_electron3.ipcMain.handle("qqq:fs:read", async (_e, p) => {
    if (engineHost.isAlive()) {
      try {
        return await engineHost.invoke("fs.read", { path: p });
      } catch {
      }
    }
    return fs14.promises.readFile(p, "utf8");
  });
  import_electron3.ipcMain.handle("qqq:fs:readBase64", async (_e, p) => {
    const buf = await fs14.promises.readFile(p);
    return buf.toString("base64");
  });
  import_electron3.ipcMain.handle("qqq:fs:writeBase64", async (_e, p, base64) => {
    try {
      await fs14.promises.mkdir(path13.dirname(p), { recursive: true });
    } catch {
    }
    const buf = Buffer.from(base64 || "", "base64");
    await fs14.promises.writeFile(p, buf);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:fs:write", async (_e, p, content) => {
    if (engineHost.isAlive()) {
      try {
        return await engineHost.invoke("fs.write", { path: p, content });
      } catch {
      }
    }
    await fs14.promises.writeFile(p, content);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:fs:list", async (_e, p) => {
    if (engineHost.isAlive()) {
      try {
        return await engineHost.invoke("fs.list", { path: p });
      } catch {
      }
    }
    const entries = await fs14.promises.readdir(p, { withFileTypes: true });
    const result = [];
    for (const e of entries) {
      const item = { name: e.name, isDir: e.isDirectory() };
      try {
        const s = await fs14.promises.stat(path13.join(p, e.name));
        item.size = s.size;
        item.mtime = s.mtimeMs;
        item.ctime = s.birthtimeMs;
      } catch {
      }
      result.push(item);
    }
    return result;
  });
  import_electron3.ipcMain.handle("qqq:fs:stat", async (_e, p) => {
    try {
      const s = await fs14.promises.stat(p);
      return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory(), isFile: s.isFile() };
    } catch {
      return null;
    }
  });
  import_electron3.ipcMain.handle("qqq:fs:exists", async (_e, p) => fs14.existsSync(p));
  import_electron3.ipcMain.handle("qqq:fs:mkdir", async (_e, p) => {
    await fs14.promises.mkdir(p, { recursive: true });
    return true;
  });
  import_electron3.ipcMain.handle("qqq:fs:remove", async (_e, p) => {
    const s = await fs14.promises.stat(p);
    if (s.isDirectory())
      await fs14.promises.rm(p, { recursive: true, force: true });
    else
      await fs14.promises.unlink(p);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:fs:rename", async (_e, oldP, newP) => {
    await fs14.promises.rename(oldP, newP);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:fs:drives", async () => {
    const drives = [];
    if (process.platform === "win32") {
      for (let i = 65; i <= 90; i++) {
        const d = String.fromCharCode(i) + ":\\";
        try {
          if (fs14.existsSync(d))
            drives.push(d);
        } catch {
        }
      }
      if (drives.length === 0)
        drives.push("C:\\");
    } else {
      drives.push("/");
    }
    return drives;
  });
  import_electron3.ipcMain.handle("qqq:fs:diskFree", async (_e, drives) => {
    return await diskFreeBatch(drives);
  });
  import_electron3.ipcMain.handle("qqq:dialog:open", async (_e, opts) => {
    if (!mainWindow) {
      return null;
    }
    const result = await import_electron3.dialog.showOpenDialog(mainWindow, opts || {});
    try {
      const wantsDir = !!(opts && Array.isArray(opts.properties) && opts.properties.indexOf("openDirectory") !== -1);
      if (result && Array.isArray(result.filePaths)) {
        for (const p of result.filePaths) {
          if (!p) {
            continue;
          }
          if (wantsDir) {
            addAssetRoot(p);
          } else {
            const dir = path13.dirname(p);
            if (dir) {
              addAssetRoot(dir);
            }
          }
        }
      }
    } catch (e) {
      console.warn("[qqq:dialog:open] asset-root auto-extend failed:", e);
    }
    return result;
  });
  import_electron3.ipcMain.handle("qqq:dialog:save", async (_e, opts) => {
    if (!mainWindow) {
      return null;
    }
    return import_electron3.dialog.showSaveDialog(mainWindow, opts || {});
  });
  import_electron3.ipcMain.handle("qqq:dialog:message", async (_e, opts) => {
    if (!mainWindow) {
      return null;
    }
    return import_electron3.dialog.showMessageBox(mainWindow, opts || {});
  });
  import_electron3.ipcMain.handle("qqq:assetRoots:add", async (_e, absDir) => addAssetRoot(absDir));
  import_electron3.ipcMain.handle("qqq:assetRoots:list", async () => Array.from(_assetFileWorkspaceRoots));
  import_electron3.ipcMain.handle("qqq:assetRoots:remove", async (_e, absDir) => {
    if (!absDir) {
      return false;
    }
    const ok = _assetFileWorkspaceRoots.delete(path13.normalize(absDir));
    if (ok) {
      persistAssetRoots();
    }
    return ok;
  });
  import_electron3.ipcMain.handle("qqq:window:minimize", () => {
    mainWindow?.minimize();
  });
  import_electron3.ipcMain.handle("qqq:window:maximize", () => {
    mainWindow?.maximize();
  });
  import_electron3.ipcMain.handle("qqq:window:unmaximize", () => {
    mainWindow?.unmaximize();
  });
  import_electron3.ipcMain.handle("qqq:window:close", () => {
    mainWindow?.close();
  });
  import_electron3.ipcMain.handle("qqq:window:isMaximized", () => mainWindow?.isMaximized() ?? false);
  import_electron3.ipcMain.handle("qqq:window:setTitle", (_e, s) => {
    mainWindow?.setTitle(String(s));
  });
  import_electron3.ipcMain.handle("qqq:window:toggleDevTools", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const wc = mainWindow.webContents;
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
    } else {
      wc.openDevTools({ mode: "detach" });
    }
  });
  import_electron3.ipcMain.handle("qqq:zoom:get", () => zoomFactor);
  import_electron3.ipcMain.handle("qqq:zoom:set", (_e, factor) => {
    const f = Math.max(0.5, Math.min(2, +Number(factor).toFixed(2)));
    zoomFactor = f;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(f);
    }
    saveZoom();
    return f;
  });
  import_electron3.ipcMain.handle("qqq:zoom:adjust", (_e, delta) => {
    const next = Math.max(0.5, Math.min(2, +(zoomFactor + Number(delta)).toFixed(2)));
    zoomFactor = next;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(next);
    }
    saveZoom();
    return next;
  });
  import_electron3.ipcMain.handle("qqq:menu:set", (_e, schema) => {
    applyMenuSchema(schema, mainWindow);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:engine:invoke", async (_e, method, params) => {
    if (method === "spawn" && params && params.cmd) {
      return qzSpawn.spawn(params);
    }
    return engineHost.invoke(method, params);
  });
  import_electron3.ipcMain.handle("qqq:engine:isAlive", () => engineHost.isAlive());
  import_electron3.ipcMain.handle("qqq:ghrun:exec", async (_e, cmd, args, opts) => {
    return qzSpawn.spawn({ cmd, args, ...opts || {} });
  });
  import_electron3.ipcMain.handle("qqq:ghrun:isAlive", () => qzSpawn.ghrunAlive());
  import_electron3.ipcMain.handle("qqq:qz:spawn", async (_e, brief) => {
    return qzSpawn.spawn(brief || {});
  });
  import_electron3.ipcMain.handle("qqq:qz:which", async (_e, cmd) => qzSpawn.which(cmd));
  import_electron3.ipcMain.handle("qqq:qz:ghrunAlive", () => qzSpawn.ghrunAlive());
  import_electron3.ipcMain.handle("qqq:qz:runnerAlive", () => qzSpawn.runnerAlive());
  import_electron3.ipcMain.handle("qqq:lsp:startLanguage", async (_e, lang, rootUri) => {
    return lspBridge.startLanguage(lang, rootUri);
  });
  import_electron3.ipcMain.handle("qqq:lsp:stopLanguage", async (_e, lang) => {
    await lspBridge.stopLanguage(lang);
  });
  import_electron3.ipcMain.handle("qqq:lsp:openDocument", async (_e, filePath, text) => {
    return lspBridge.openDocument(filePath, text);
  });
  import_electron3.ipcMain.handle("qqq:lsp:changeDocument", async (_e, filePath, changes, version) => {
    await lspBridge.changeDocument(filePath, changes, version);
  });
  import_electron3.ipcMain.handle("qqq:lsp:closeDocument", async (_e, filePath) => {
    await lspBridge.closeDocument(filePath);
  });
  import_electron3.ipcMain.handle("qqq:lsp:getDiagnostics", async (_e, uri) => {
    return lspBridge.getDiagnostics(uri);
  });
  import_electron3.ipcMain.handle("qqq:lsp:activeLanguages", () => lspBridge.activeLanguages());
  import_electron3.ipcMain.handle("qqq:lsp:hover", async (_e, filePath, line, character) => {
    return lspBridge.hover(filePath, line, character);
  });
  import_electron3.ipcMain.handle("qqq:ai:hover", async (_e, context) => {
    const token = process.env.QQQ_AI_TOKEN || "";
    if (!token || !context)
      return null;
    try {
      const resp = await fetch("https://gh555.com/api/v3/ai/chat", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: context }],
          max_tokens: 200,
          temperature: 0.3
        })
      });
      if (!resp.ok)
        return null;
      const data = await resp.json();
      return data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
    } catch (e) {
      return null;
    }
  });
  import_electron3.ipcMain.handle("qqq:cache:get", async (_e, key) => cacheStore.get(key));
  import_electron3.ipcMain.handle("qqq:cache:put", async (_e, key, value, opts) => cacheStore.put(key, value, opts));
  import_electron3.ipcMain.handle("qqq:cache:has", async (_e, key) => cacheStore.has(key));
  import_electron3.ipcMain.handle("qqq:cache:delete", async (_e, key) => cacheStore.del(key));
  import_electron3.ipcMain.handle("qqq:cache:path", async (_e, key) => cacheStore.path(key));
  import_electron3.ipcMain.handle("qqq:cache:bucketPath", async (_e, sig, ext) => cacheStore.bucketPath(sig, ext));
  import_electron3.ipcMain.handle("qqq:state:register", async (_e, ns, schema) => {
    const safeSchema = {
      v: schema.v,
      form: schema.form,
      quotaBytes: schema.quotaBytes,
      cloud: !!schema.cloud,
      debounceMs: schema.debounceMs,
      compactThresholdBytes: schema.compactThresholdBytes
    };
    stateStore.register(ns, safeSchema);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:state:get", async (_e, ns, key) => stateStore.get(ns, key));
  import_electron3.ipcMain.handle("qqq:state:set", async (_e, ns, key, v) => {
    await stateStore.set(ns, key, v);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:state:setNow", async (_e, ns, key, v) => {
    await stateStore.setNow(ns, key, v);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:state:append", async (_e, ns, key, ev) => {
    await stateStore.append(ns, key, ev);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:state:del", async (_e, ns, key) => stateStore.del(ns, key));
  import_electron3.ipcMain.handle("qqq:state:list", async (_e, ns) => stateStore.list(ns));
  import_electron3.ipcMain.handle("qqq:state:flush", async () => {
    await stateStore.flush();
    return true;
  });
  import_electron3.ipcMain.handle("qqq:state:flushOne", async (_e, ns, key) => {
    await stateStore.flushOne(ns, key);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:state:stats", () => stateStore.stats());
  import_electron3.ipcMain.handle("qqq:state:cloud:pull", async () => stateCloud.pull());
  import_electron3.ipcMain.handle("qqq:state:cloud:push", async () => stateCloud.push());
  import_electron3.ipcMain.handle("qqq:state:cloud:sync", async () => stateCloud.sync());
  import_electron3.ipcMain.handle("qqq:state:sql", async (_e, query, params) => stateStore.sql(query, params));
  function _getQg(rootDir) {
    let inst = _qgInstances.get(rootDir);
    if (!inst) {
      inst = new Qg(rootDir);
      inst.on("changed", (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send("qqq:qg:changed", { ...msg, rootDir });
          } catch {
          }
        }
      });
      _qgInstances.set(rootDir, inst);
    }
    return inst;
  }
  import_electron3.ipcMain.handle("qqq:qg:register", async (_e, rootDir, ns, schema) => {
    const safeSchema = { v: schema.v, form: schema.form, cloud: false };
    _getQg(rootDir).register(ns, safeSchema);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:qg:get", async (_e, rootDir, ns, key) => _getQg(rootDir).get(ns, key));
  import_electron3.ipcMain.handle("qqq:qg:set", async (_e, rootDir, ns, key, v) => {
    const qg = _getQg(rootDir);
    await qg.set(ns, key, v);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:qg:setNow", async (_e, rootDir, ns, key, v) => {
    const qg = _getQg(rootDir);
    await qg.setNow(ns, key, v);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:qg:append", async (_e, rootDir, ns, key, ev) => {
    const qg = _getQg(rootDir);
    await qg.append(ns, key, ev);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:qg:del", async (_e, rootDir, ns, key) => _getQg(rootDir).del(ns, key));
  import_electron3.ipcMain.handle("qqq:qg:list", async (_e, rootDir, ns) => _getQg(rootDir).list(ns));
  import_electron3.ipcMain.handle("qqq:qg:flush", async (_e, rootDir) => {
    const qg = _getQg(rootDir);
    await qg.flush();
    return true;
  });
  import_electron3.ipcMain.handle("qqq:qg:stats", async (_e, rootDir) => _getQg(rootDir).stats());
  import_electron3.ipcMain.handle("qqq:qg:flushOne", async (_e, rootDir, ns, key) => {
    await _getQg(rootDir).flushOne(ns, key);
    return true;
  });
  import_electron3.ipcMain.handle("qqq:hash:file", async (_e, p, mode) => hashService.hashFile(p, mode || "fast"));
  import_electron3.ipcMain.handle("qqq:hash:buffer", async (_e, b64, mode) => hashService.hashBuffer(Buffer.from(b64, "base64"), mode || "fast"));
  import_electron3.ipcMain.handle("qqq:media:thumb", async (_e, opts) => mediaService.thumb(opts || {}));
  import_electron3.ipcMain.handle("qqq:media:transcode", async (_e, opts) => mediaService.transcode(opts || {}));
  import_electron3.ipcMain.handle("qqq:media:probe", async (_e, src) => mediaService.probe(src));
  import_electron3.ipcMain.handle("qqq:media:ffmpegPath", () => mediaService.ffmpegPath());
  import_electron3.ipcMain.handle("qqq:key:registerGlobal", async (_e, accel, id) => {
    return registerGlobalKey(accel, id);
  });
  import_electron3.ipcMain.handle("qqq:key:unregisterGlobal", async (_e, accel) => {
    try {
      require("electron").globalShortcut.unregister(accel);
    } catch {
    }
    return true;
  });
  import_electron3.ipcMain.handle("qqq:key:unregisterAllGlobal", async () => {
    try {
      require("electron").globalShortcut.unregisterAll();
    } catch {
    }
    return true;
  });
  import_electron3.ipcMain.handle("qqq:audio:play", async (_e, file, opts) => {
    try {
      const action = opts && opts.sfx ? "play_sfx" : "play_music";
      return await audioEngine.invoke(action, { path: file, ...opts || {} });
    } catch (e) {
      console.warn("[audio.play]", e && e.message);
      return { ok: false, error: String(e && e.message) };
    }
  });
  import_electron3.ipcMain.handle("qqq:audio:stop", async (_e, scope) => {
    try {
      const action = scope === "music" ? "stop_music" : "stop_all";
      return await audioEngine.invoke(action, {});
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });
  import_electron3.ipcMain.handle("qqq:audio:invoke", async (_e, action, params) => {
    return audioEngine.invoke(action, params || {});
  });
  import_electron3.ipcMain.handle("qqq:audio:isAlive", () => audioEngine.isAlive());
  import_electron3.ipcMain.handle("qqq:shell:openExternal", (_e, url) => import_electron3.shell.openExternal(url));
  import_electron3.ipcMain.handle("qqq:shell:openPath", (_e, p) => import_electron3.shell.openPath(p));
  import_electron3.ipcMain.handle("qqq:download:start", async (_e, opts) => {
    return downloadService.start(opts || {});
  });
  import_electron3.ipcMain.handle("qqq:download:cancel", async (_e, id) => {
    return downloadService.cancel(id);
  });
  import_electron3.ipcMain.handle("qqq:download:list", async () => {
    return downloadService.list();
  });
  import_electron3.ipcMain.handle("qqq:clipboard:readText", () => {
    return require("electron").clipboard.readText();
  });
  import_electron3.ipcMain.handle("qqq:clipboard:writeText", (_e, s) => {
    require("electron").clipboard.writeText(s);
  });
  import_electron3.ipcMain.handle("qqq:clipboard:readImage", () => {
    const img = require("electron").clipboard.readImage();
    if (img.isEmpty())
      return null;
    return img.toPNG().toString("base64");
  });
  import_electron3.ipcMain.handle("qqq:clipboard:hasImage", () => {
    return !require("electron").clipboard.readImage().isEmpty();
  });
  import_electron3.ipcMain.handle("qqq:update:check", async () => {
    return updateService.check();
  });
  import_electron3.ipcMain.handle("qqq:update:apply", async () => {
    return updateService.apply();
  });
  import_electron3.ipcMain.handle("qqq:update:state", async () => {
    return updateService.getState();
  });
  import_electron3.ipcMain.handle("qqq:update:abort", async () => {
    updateService.abort();
    return true;
  });
  monacoHost.register();
}
function hardenSession() {
  const ses = import_electron3.session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  ses.webRequest.onHeadersReceived((details, cb) => {
    const headers = details.responseHeaders || {};
    delete headers["x-frame-options"];
    delete headers["X-Frame-Options"];
    if (details.url.includes("gh555.com")) {
      headers["access-control-allow-origin"] = ["*"];
      headers["access-control-allow-headers"] = ["Content-Type, Authorization"];
      headers["access-control-allow-methods"] = ["GET, POST, PUT, DELETE, OPTIONS"];
      if (details.method === "OPTIONS") {
        cb({ responseHeaders: headers, statusLine: "HTTP/1.1 200 OK" });
        return;
      }
    }
    cb({ responseHeaders: headers });
  });
}
import_electron3.app.whenReady().then(async () => {
  import_electron3.nativeTheme.themeSource = "light";
  hardenSession();
  registerAssetProtocol();
  registerShellState();
  registerIpc();
  engineHost.start();
  await boot();
  await _hydrateZoomFromState();
  await _hydrateAssetRootsFromState();
});
var _flushedOnce = false;
function _flushStateSync(reason) {
  if (_flushedOnce) {
    return;
  }
  _flushedOnce = true;
  try {
    console.log("[state] flushSync on", reason);
    stateStore.flushSync();
    for (const [rootDir, qg] of _qgInstances) {
      try {
        qg.flushSync();
      } catch (e2) {
        console.warn("[qg] flushSync failed for", rootDir, e2);
      }
    }
  } catch (e) {
    console.warn("[state] flushSync failed:", e);
  }
}
import_electron3.app.on("before-quit", async (e) => {
  if (_flushedOnce) {
    return;
  }
  try {
    e.preventDefault();
    await stateStore.flush();
  } catch (err) {
    console.warn("[state] async flush before-quit failed:", err);
  } finally {
    _flushStateSync("before-quit");
    import_electron3.app.exit(0);
  }
});
process.on("SIGINT", () => {
  _flushStateSync("SIGINT");
  try {
    import_electron3.app.quit();
  } catch {
    process.exit(0);
  }
});
process.on("SIGTERM", () => {
  _flushStateSync("SIGTERM");
  try {
    import_electron3.app.quit();
  } catch {
    process.exit(0);
  }
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  _flushStateSync("uncaughtException");
  try {
    const f = path13.join(portable.logs, "crash-" + Date.now() + ".log");
    fs14.writeFileSync(f, String(err && err.stack || err));
  } catch {
  }
});
process.on("unhandledRejection", (reason) => {
  console.warn("[unhandledRejection]", reason);
});
import_electron3.app.on("window-all-closed", () => {
  try {
    import_electron3.globalShortcut.unregisterAll();
  } catch {
  }
  engineHost.stop();
  audioEngine.stop();
  if (process.platform !== "darwin") {
    import_electron3.app.quit();
  }
});
import_electron3.app.on("activate", () => {
  if (import_electron3.BrowserWindow.getAllWindows().length === 0) {
    boot();
  }
});
import_electron3.app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    import_electron3.shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    try {
      const target = new import_url4.URL(url);
      const allowed = new import_url4.URL(bootConfig.url);
      if (target.origin !== allowed.origin && !url.startsWith("file://")) {
        e.preventDefault();
        import_electron3.shell.openExternal(url);
      }
    } catch {
      e.preventDefault();
    }
  });
});
