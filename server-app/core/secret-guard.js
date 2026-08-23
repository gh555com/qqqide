// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// secret-guard.js — 协助密钥脱敏（事件驱动懒惰脱敏机器）
//
// 理念（2026-08-21 定案）:
//   · 不做全盘扫描。只在 AI 视口 git badge 轮询（ai-viewport.js）发现项目有
//     未提交更改时干活 —— 上升沿触发（porcelain 原文变化才处理）
//   · 三层识别: T1 强签名(前缀+格式) → 自动抹除
//              T2 强标签+高熵      → 自动抹除
//              T3 弱标签/边界熵    → 常驻 qoast + 用户协同面板
//   · 只确保用户最终提交(git)的内容干净；不确定的一律交人工判断
//   · 编辑器正在打开的文件一律跳过（防覆盖用户未保存的编辑）
//
// 数据落盘（项目级）:
//   {项目}/_qqq/secret-guard/state.json      值级去重（hash(值) → ts，30 天）
//   {项目}/_qqq/secret-guard/whitelist.json  用户白名单（文件级 / 值级）
//   {项目}/_qqq/secret-guard.log             审计日志（append）
//
// 开关: 设置 → 高级 → 协助密钥脱敏（secret.maskHelp，默认开）
// ============================================================================

(function () {
  'use strict';

  // ═══════════ 常量 ═══════════
  var REDACTED = '***REDACTED***';
  var MAX_FILE_BYTES = 2 * 1024 * 1024;   // >2MB 视为大文件跳过
  var MIN_T2_LEN = 12;                    // T2 强标签值最小长度
  var T2_ENTROPY = 3.2;                   // T2 熵阈值
  var T3_MIN_LEN = 6;                     // T3 值最小长度
  var T3_ENTROPY = 2.5;                   // T3 宽标签熵阈值
  var STATE_TTL = 30 * 24 * 3600 * 1000;  // 值级去重 30 天
  var SKIP_DIRS = ['_qqq/', '_qqqvault/', '.git/'];

  // ═══════════ 状态 ═══════════
  var _lastPorcelain = {};   // path → porcelain 原文（上升沿检测）
  var _processing = {};      // path → Promise（并发保护）
  var _state = {};           // path → { vKey: ts }
  var _stateLoaded = {};
  var _wlFiles = {};         // path → { filePath: ts }
  var _wlValues = {};        // path → { vKey: ts }
  var _wlLoaded = {};
  var _pendingT3 = {};       // path → [ {file,line,value,label,context,start,end,quote,staged,_vKey} ]
  var _qoast = null;         // 常驻 qoast 句柄
  var _panelEl = null, _panelOv = null, _panelProj = null;
  var _gitBinCache = null;

  // ═══════════ 工具 ═══════════
  function _b() { return window.qqqideBridge || null; }

  function _enabled() {
    try {
      var v = window.qqqSettings && window.qqqSettings.get('secret.maskHelp', 'true');
      return v !== false && v !== 'false';
    } catch (_) { return true; }
  }

  function _t(key, fallback, vars) {
    var s = fallback;
    try { s = window._i ? window._i(key, fallback) : fallback; } catch (_) { s = fallback; }
    if (vars) {
      s = String(s).replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] !== undefined ? String(vars[k]) : m;
      });
    }
    return s;
  }

  function _entropy(s) {
    var freq = {}, n = s.length;
    for (var i = 0; i < n; i++) freq[s[i]] = (freq[s[i]] || 0) + 1;
    var e = 0;
    for (var k in freq) { var p = freq[k] / n; e -= p * Math.log2(p); }
    return e;
  }

  // 确定性 hash（去重用，非密码学）
  function _valHash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36) + '_' + s.length;
  }

  async function _gitBin() {
    if (_gitBinCache) return _gitBinCache;
    try {
      var b = _b();
      if (b && b.components && b.components.getBin) {
        var bin = await b.components.getBin('git');
        if (bin) { _gitBinCache = bin; return bin; }
      }
    } catch (_) {}
    return 'git';
  }

  // ═══════════ 识别器 ═══════════
  // T1: 前缀+格式双重校验的强签名。kind: prefix(保留前缀)/block(私钥块)/url(连接串)
  var T1_PATTERNS = [
    { name: '阿里云 AccessKey', kind: 'prefix', keepPrefix: 4, re: /\bLTAI[A-Za-z0-9]{16,24}\b/g },
    { name: 'AWS AccessKey',    kind: 'prefix', keepPrefix: 4, re: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: 'GitHub Token',     kind: 'prefix', keepPrefix: 4, re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,200}\b/g },
    { name: 'GitHub PAT',       kind: 'prefix', keepPrefix: 12, re: /\bgithub_pat_[A-Za-z0-9_]{22,200}\b/g },
    { name: 'GitLab PAT',       kind: 'prefix', keepPrefix: 6, re: /\bglpat-[A-Za-z0-9_\-]{20,200}\b/g },
    { name: 'Cloudflare Token', kind: 'prefix', keepPrefix: 5, re: /\bcfut_[A-Za-z0-9]{40}\b/g },
    { name: 'OpenAI Key',       kind: 'prefix', keepPrefix: 3, re: /\bsk-[A-Za-z0-9]{20,200}\b/g },
    { name: 'Stripe Key',       kind: 'prefix', keepPrefix: 8, re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,200}\b/g },
    { name: 'Google API Key',   kind: 'prefix', keepPrefix: 4, re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
    { name: 'Slack Token',      kind: 'prefix', keepPrefix: 5, re: /\bxox[baprs]-[A-Za-z0-9\-]{10,200}\b/g },
    { name: 'Telegram Bot Token', kind: 'prefix', keepPrefix: 0, re: /\b\d{8,10}:AA[A-Za-z0-9_\-]{30,40}\b/g },
    { name: 'npm Token',        kind: 'prefix', keepPrefix: 4, re: /\bnpm_[A-Za-z0-9]{36}\b/g },
    { name: '私钥块', kind: 'block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
    { name: '数据库连接串', kind: 'url', re: /\b(?:postgres|postgresql|mysql|mariadb|redis|rediss|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/g }
  ];

  // T2/T3 共用: 强标签（值长度/熵分级）
  var STRONG_LABEL_RE = /((?:api[_-]?key|secret|token|passwd|password|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|bearer|密码|密钥|口令)\s*[:=：]\s*)(['"]?)([^\s'",;)}\]]+)\2/gi;
  // T3: 宽泛标签
  var WIDE_LABEL_RE = /((?:\bkey\b|code|auth|session|credential|cred|pwd|pass|令牌)\s*[:=：]\s*)(['"]?)([^\s'",;)}\]]+)\2/gi;

  // 值形态过滤（变量引用/URL/路径 → 非密钥）
  function _skipValue(val) {
    if (val.length === 0) return true;
    if (/[$%{}\*]/.test(val)) return true;                  // 模板/变量/掩码
    if (/^[a-z][a-z0-9+]*:\/\//i.test(val)) return true;    // URL
    if (/^[\/\\]/.test(val)) return true;                   // 路径
    if (/^[.#]/.test(val)) return true;                     // 相对路径/注释
    // ★ 2026-08-23 四次误伤修复：括号开头表达式（(_activeAgent 等）——T2 token 标签
    //   抓到 `var token = ***REDACTED*** && ...` 的值 = `(_activeAgent`（12 字符≥阈值）被自动抹除
    //   → panel-quest-ui.js 语法炸（q178 f85 实锤）。base64 字符集无 ( 开头 → 零误报风险。
    if (/^[(\[]/.test(val)) return true;                     // 括号包裹的代码表达式
    // ★ 2026-08-21 误伤修复：表达式形态（函数调用 parsed.xxx.get('token') / 属性访问
    //   config.token / 数组取值 env['KEY']）→ 非字面量密钥值，跳过。
    //   事故：const token = ***REDACTED***'token') 被 T2 抹成 ***REDACTED*** 破坏源码（构建失败）。
    if (/^[A-Za-z_$][\w$]*[\w.$]*[(\[]/.test(val)) return true;
    // ★ 2026-08-21 二次误伤修复：纯属性访问链（window.qqqLogin.getAuthToken，无括号）——
    //   旧正则要求 ( [ 结尾，属性链漏网被 T2 抹坏 gaea-host.js L472/L512（F7 实测）。
    //   代价：JWT 形态（eyJ..xx.yy）会被误判为属性链跳过 → 漏报可接受，源码被抹坏不可接受。
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(val)) return true;
    // ★ 2026-08-23 三次误伤修复：单标识符（CHAR_PER_TOKEN 等变量引用，无点无括号）——
    //   表达式正则要求 ( [ 结尾、属性链正则要求至少一个点，单标识符两不满足漏网，
    //   值 14 字符+熵 3.25 ≥ T2 阈值被自动抹除 → content-gateway.js 语法炸（q178 f75 实锤）。
    //   代价：纯字母数字形态的密钥值会漏报 → 漏报可接受，源码被抹坏不可接受（同二次修复原则）。
    if (/^[A-Za-z_$][\w$]*$/.test(val)) return true;
    return false;
  }

  function _redactUrl(url) {
    var m = /^([a-z+]+:\/\/)([^@\/]*)(@[\s\S]*)$/i.exec(url);
    if (m && m[2]) return m[1] + REDACTED + m[3];
    var qm = /(\?|&)(password|passwd|token|secret|key|pwd)=([^&\s]+)/gi.exec(url);
    if (qm) {
      var vStart = qm.index + qm[0].indexOf(qm[3]);
      return url.slice(0, vStart) + REDACTED + url.slice(vStart + qm[3].length);
    }
    return null; // 无凭据 → 不处理
  }

  function _redactBlock(block) {
    var m = /^(-----BEGIN [A-Z ]+-----)[\s\S]*?(-----END [A-Z ]+-----)$/.exec(block);
    if (m) return m[1] + '\n' + REDACTED + '\n' + m[2];
    return REDACTED;
  }

  // 扫描全文 → findings（按 start 升序，互不重叠，T1 优先占位）
  function _scanContent(content) {
    var findings = [];
    var occupied = [];
    var m;

    function overlaps(s, e) {
      for (var i = 0; i < occupied.length; i++) {
        if (s < occupied[i][1] && e > occupied[i][0]) return true;
      }
      return false;
    }
    function lineOf(pos) { return content.slice(0, pos).split('\n').length; }

    // ── T1 ──
    for (var ti = 0; ti < T1_PATTERNS.length; ti++) {
      var pat = T1_PATTERNS[ti];
      var re = new RegExp(pat.re.source, 'g');
      while ((m = re.exec(content)) !== null) {
        if (!m[0].length) { re.lastIndex++; continue; }
        if (pat.kind === 'url' && _redactUrl(m[0]) === null) { re.lastIndex = m.index + m[0].length; continue; }
        if (overlaps(m.index, m.index + m[0].length)) { re.lastIndex = m.index + m[0].length; continue; }
        occupied.push([m.index, m.index + m[0].length]);
        findings.push({
          tier: 1, name: pat.name, kind: pat.kind, keepPrefix: pat.keepPrefix || 0,
          line: lineOf(m.index), start: m.index, end: m.index + m[0].length, value: m[0]
        });
        re.lastIndex = m.index + m[0].length;
      }
    }

    // ── T2/T3 强标签 ──
    var re2 = new RegExp(STRONG_LABEL_RE.source, 'gi');
    while ((m = re2.exec(content)) !== null) {
      if (!m[0].length) { re2.lastIndex++; continue; }
      var val = m[3];
      var s = m.index + m[1].length + m[2].length;
      var e = m.index + m[0].length - m[2].length;
      if (overlaps(s, e)) { re2.lastIndex = e; continue; }
      if (_skipValue(val) || val.length < T3_MIN_LEN) { re2.lastIndex = e; continue; }
      var len = val.length, ent = _entropy(val);
      var tier = (len >= MIN_T2_LEN && ent >= T2_ENTROPY) ? 2 : 3;
      occupied.push([s, e]);
      findings.push({
        tier: tier, name: m[1].trim(), kind: 'value',
        line: lineOf(s), start: s, end: e, value: val, label: m[1].trim(), quote: m[2]
      });
      re2.lastIndex = e;
    }

    // ── T3 宽标签 ──
    var re3 = new RegExp(WIDE_LABEL_RE.source, 'gi');
    while ((m = re3.exec(content)) !== null) {
      if (!m[0].length) { re3.lastIndex++; continue; }
      var val3 = m[3];
      var s3 = m.index + m[1].length + m[2].length;
      var e3 = m.index + m[0].length - m[2].length;
      if (overlaps(s3, e3)) { re3.lastIndex = e3; continue; }
      if (_skipValue(val3) || val3.length < 8 || _entropy(val3) < T3_ENTROPY) { re3.lastIndex = e3; continue; }
      occupied.push([s3, e3]);
      findings.push({
        tier: 3, name: m[1].trim(), kind: 'value',
        line: lineOf(s3), start: s3, end: e3, value: val3, label: m[1].trim(), quote: m[2]
      });
      re3.lastIndex = e3;
    }

    return findings;
  }

  // 应用抹除（从后往前，返回实际替换的 findings）
  function _applyRedactions(content, findings) {
    var out = content;
    var applied = [];
    var edits = findings.slice().sort(function (a, b) { return b.start - a.start; });
    for (var i = 0; i < edits.length; i++) {
      var f = edits[i];
      var rep;
      if (f.kind === 'url') { rep = _redactUrl(f.value); if (rep === null) continue; }
      else if (f.kind === 'block') { rep = _redactBlock(f.value); }
      else if (f.kind === 'prefix') { rep = f.value.slice(0, f.keepPrefix) + REDACTED; }
      else { rep = (f.quote || '') + REDACTED + (f.quote || ''); }
      out = out.slice(0, f.start) + rep + out.slice(f.end);
      applied.push(f);
    }
    return { content: out, applied: applied };
  }

  // 上下文片段：值打码只留前后 4 字符（防面板自身泄露）
  function _maskedContext(content, s, e) {
    var lineStart = content.lastIndexOf('\n', s - 1) + 1;
    var lineEnd = content.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = content.length;
    var val = content.slice(s, e);
    var maskedVal = val.length <= 8 ? '****' : val.slice(0, 4) + '****' + val.slice(-4);
    return content.slice(lineStart, s) + maskedVal + content.slice(e, lineEnd);
  }

  // ═══════════ 持久化 ═══════════
  function _guardDir(projPath) { return projPath.replace(/\\/g, '/').replace(/\/$/, '') + '/_qqq/secret-guard'; }
  function _stateFile(projPath) { return _guardDir(projPath) + '/state.json'; }
  function _wlFile(projPath) { return _guardDir(projPath) + '/whitelist.json'; }
  function _logFile(projPath) { return _guardDir(projPath) + '.log'; }
  function _fullPath(projPath, rel) { return projPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + rel.replace(/\\/g, '/'); }

  async function _loadJson(path) {
    try {
      var b = _b();
      if (!b || !b.fs || !b.fs.read) return null;
      var raw = await b.fs.read(path);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  function _saveJson(path, obj) {
    try {
      var b = _b();
      if (!b || !b.fs || !b.fs.write) return;
      b.fs.write(path, JSON.stringify(obj, null, 1)).catch(function () {});
    } catch (_) {}
  }

  async function _ensureState(projPath) {
    if (!_stateLoaded[projPath]) {
      _state[projPath] = (await _loadJson(_stateFile(projPath))) || {};
      _stateLoaded[projPath] = true;
    }
    return _state[projPath];
  }

  async function _ensureWl(projPath) {
    if (!_wlLoaded[projPath]) {
      var raw = (await _loadJson(_wlFile(projPath))) || {};
      _wlFiles[projPath] = raw.files || {};
      _wlValues[projPath] = raw.values || {};
      _wlLoaded[projPath] = true;
    }
    return { files: _wlFiles[projPath], values: _wlValues[projPath] };
  }

  function _saveWl(projPath) {
    _saveJson(_wlFile(projPath), { files: _wlFiles[projPath] || {}, values: _wlValues[projPath] || {} });
  }

  function _appendLog(projPath, line) {
    try {
      var b = _b();
      if (!b || !b.fs) return;
      var entry = new Date().toISOString() + ' ' + line + '\n';
      if (b.fs.append) { b.fs.append(_logFile(projPath), entry).catch(function () {}); return; }
      b.fs.read(_logFile(projPath)).then(function (old) {
        b.fs.write(_logFile(projPath), (typeof old === 'string' ? old : '') + entry);
      }).catch(function () {});
    } catch (_) {}
  }

  // ═══════════ 事件入口（上升沿） ═══════════
  function _onGitDirty(e) {
    if (!_enabled()) return;
    var detail = e && e.detail;
    if (!detail || !detail.path) return;
    var projPath = detail.path;
    var porcelain = detail.porcelain || '';
    if (_lastPorcelain[projPath] === porcelain) return;
    _lastPorcelain[projPath] = porcelain;
    if (_processing[projPath]) {
      _processing[projPath] = _processing[projPath].then(function () { return _processProject(projPath, porcelain); });
      return;
    }
    _processing[projPath] = _processProject(projPath, porcelain).finally(function () {
      _processing[projPath] = null;
    });
  }

  // ═══════════ 项目处理 ═══════════
  // porcelain 解析（事件路径与 dsecret 扫描共用）
  function _parsePorcelain(porcelain) {
    var files = [];
    var lines = porcelain.split('\n').filter(Boolean);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var status = ln.slice(0, 2);
      var p = ln.slice(3);
      if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') {
        p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      if (!p) continue;
      var x = status[0], y = status[1];
      if (x === 'D' || y === 'D') continue;   // 删除
      if (x === 'R' || y === 'R') continue;   // 重命名
      if (status !== '??' && x === ' ' && y === ' ') continue;
      files.push({ path: p, staged: x !== ' ' && x !== '?' });
    }
    return files;
  }

  async function _processProject(projPath, porcelain) {
    try {
      if (!_enabled()) return;
      var files = _parsePorcelain(porcelain);
      if (!files.length) { _clearPending(projPath); return; }

      var t3List = [];
      for (var fi = 0; fi < files.length; fi++) {
        var f = files[fi];
        var fp = f.path.replace(/\\/g, '/');
        var skip = false;
        for (var si = 0; si < SKIP_DIRS.length; si++) {
          if (fp.indexOf(SKIP_DIRS[si]) === 0) { skip = true; break; }
        }
        if (skip) continue;
        var res = await _processFile(projPath, _fullPath(projPath, fp), fp, f.staged);
        if (res && res.t3 && res.t3.length) {
          for (var tj = 0; tj < res.t3.length; tj++) t3List.push(res.t3[tj]);
        }
      }

      if (t3List.length) { _pendingT3[projPath] = t3List; _showCoopQoast(projPath); }
      else { _clearPending(projPath); }
    } catch (err) {
      _appendLog(projPath, 'ERROR ' + (err && err.message ? err.message : err));
    }
  }

  // 单文件处理。返回 { t3: [...] } 或 null
  async function _processFile(projPath, fullPath, relPath, staged) {
    try {
      var b = _b();
      if (!b || !b.fs) return null;
      var st = await b.fs.stat(fullPath);
      if (st && st.size > MAX_FILE_BYTES) return null;
      var raw = await b.fs.read(fullPath);
      if (typeof raw !== 'string' || !raw) return null;
      if (raw.indexOf('\x00') !== -1) return null; // 二进制

      var findings = _scanContent(raw);
      if (!findings.length) return null;

      // 过滤已处理 / 白名单
      var state = await _ensureState(projPath);
      var wl = await _ensureWl(projPath);
      var todo = [], t3 = [];
      for (var i = 0; i < findings.length; i++) {
        var f = findings[i];
        var vh = _valHash(f.value);
        var vKey = relPath + '\x00' + vh;
        if (wl.files[relPath]) continue;
        if (wl.values[vKey]) continue;
        if (state[vKey] && Date.now() - state[vKey] < STATE_TTL) continue;
        f._vh = vh; f._vKey = vKey;
        if (f.tier <= 2) todo.push(f);
        else t3.push(f);
      }
      if (!todo.length && !t3.length) return null;

      // 编辑器正在打开 → 跳过（防覆盖用户未保存编辑 / 保存时回写旧内容）
      var openInEditor = false;
      try {
        if (window.qqqEditor && typeof window.qqqEditor.getEditorForFile === 'function' &&
            window.qqqEditor.getEditorForFile(fullPath)) openInEditor = true;
      } catch (_) {}
      if (openInEditor) {
        if (todo.length) _appendLog(projPath, 'SKIP(editor-open) ' + relPath + ' (' + todo.length + ' auto)');
        return null;
      }

      var auto = [];
      if (todo.length) {
        var red = _applyRedactions(raw, todo);
        if (red.applied.length) {
          await b.fs.write(fullPath, red.content);
          if (staged) {
            try {
              await b.qz.spawn({ cmd: await _gitBin(), args: ['-C', projPath, 'add', '--', relPath], timeout: 8000 });
            } catch (_) {}
          }
          var now = Date.now();
          for (var ai = 0; ai < red.applied.length; ai++) {
            var af = red.applied[ai];
            state[af._vKey] = now;
            auto.push({ tier: af.tier, name: af.name, file: relPath, line: af.line, value: af.value.slice(0, 16) + '...', context: _maskedContext(raw, af.start, af.end) });
            _appendLog(projPath, 'REDACT[' + (af.tier === 1 ? 'T1' : 'T2') + ':' + af.name + '] ' + relPath + ':' + af.line + ' ' + af.value.slice(0, 16) + '...');
          }
          _saveJson(_stateFile(projPath), state);
        }
      }

      if (t3.length) {
        for (var tj = 0; tj < t3.length; tj++) {
          t3[tj].context = _maskedContext(raw, t3[tj].start, t3[tj].end);
          t3[tj].file = relPath;
          t3[tj].staged = staged;
        }
        return { t3: t3, auto: auto };
      }
      return auto.length ? { t3: [], auto: auto } : null;
    } catch (err) {
      _appendLog(projPath, 'ERROR ' + relPath + ' ' + (err && err.message ? err.message : err));
      return null;
    }
  }

  // ═══════════ 协同 qoast + 面板 ═══════════
  function _showCoopQoast(projPath) {
    if (!_enabled()) return;
    var list = _pendingT3[projPath] || [];
    if (!list.length) return;
    if (_qoast) {
      if (_qoast._proj !== projPath) { try { _qoast.dismiss(); } catch (_) {} _qoast = null; }
      else return;
    }
    var msg = _t('secretGuard.qoastMsg', '⚠️ 检测到 {n} 处疑似密钥（无法自动确认），提交前请处理', { n: list.length });
    _qoast = window.qqqideQoast.show(msg, {
      duration: 0,
      type: 'warning',
      action: {
        label: _t('secretGuard.btnGo', '去处理'),
        onClick: function () { _openPanel(projPath); }
      }
    });
    _qoast._proj = projPath;
  }

  function _clearPending(projPath) {
    if (_pendingT3[projPath]) delete _pendingT3[projPath];
    if (_qoast && _qoast._proj === projPath) {
      try { _qoast.dismiss(); } catch (_) {}
      _qoast = null;
    }
    if (_panelProj === projPath) _closePanel();
  }

  // ── 面板 ──
  function _openPanel(projPath) {
    _panelProj = projPath;
    _renderPanel(projPath);
    if (_panelEl) _panelEl.style.display = '';
    if (_panelOv) _panelOv.style.display = '';
    document.addEventListener('keydown', _panelEsc);
  }

  function _closePanel() {
    if (_panelEl) _panelEl.style.display = 'none';
    if (_panelOv) _panelOv.style.display = 'none';
    _panelProj = null;
    document.removeEventListener('keydown', _panelEsc);
  }

  function _panelEsc(e) {
    if (e.key === 'Escape') _closePanel();
  }

  function _ensurePanelDom() {
    if (_panelEl) return;
    _panelOv = document.createElement('div');
    _panelOv.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:9998;';
    _panelOv.addEventListener('click', function (e) { if (e.target === _panelOv) _closePanel(); });
    _panelEl = document.createElement('div');
    _panelEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:760px;max-width:92vw;max-height:82vh;overflow-y:auto;z-index:9999;padding:0;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.35);background:var(--card-bg);color:var(--text-primary);border:1px solid var(--border-color);';
    _panelOv.appendChild(_panelEl);
    document.body.appendChild(_panelOv);
  }

  function _mkBtn(label, fn, danger) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:3px 12px;border:1px solid var(--border-color);border-radius:3px;background:var(--card-bg);color:' + (danger ? 'var(--red)' : 'var(--text-primary)') + ';font-size:12px;';
    b.onclick = function (ev) { ev.stopPropagation(); fn(); };
    return b;
  }

  function _renderPanel(projPath) {
    var list = _pendingT3[projPath] || [];
    if (!list.length) {
      if (_qoast && _qoast._proj === projPath) { try { _qoast.dismiss(); } catch (_) {} _qoast = null; }
      _closePanel();
      return;
    }
    _ensurePanelDom();
    _panelEl.innerHTML = '';

    var hd = document.createElement('div');
    hd.style.cssText = 'padding:14px 20px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;';
    var title = document.createElement('span');
    title.style.cssText = 'font-size:15px;font-weight:bold;color:var(--text-primary);';
    title.textContent = _t('secretGuard.panelTitle', '密钥脱敏 · 协同处理');
    hd.appendChild(title);
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.style.cssText = 'width:24px;height:24px;border:1px solid var(--border-color);border-radius:3px;background:transparent;color:var(--text-secondary);font-size:14px;line-height:22px;text-align:center;';
    closeBtn.onclick = _closePanel;
    hd.appendChild(closeBtn);
    _panelEl.appendChild(hd);

    var desc = document.createElement('div');
    desc.style.cssText = 'padding:10px 20px;font-size:12px;color:var(--text-secondary);line-height:1.6;border-bottom:1px solid var(--border-color);';
    desc.textContent = _t('secretGuard.panelDesc', '以下内容疑似包含密钥，无法自动确认。已打码展示，请人工判断后处理。');
    _panelEl.appendChild(desc);

    var body = document.createElement('div');
    body.style.cssText = 'padding:12px 20px;max-height:46vh;overflow-y:auto;';
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var row = document.createElement('div');
      row.style.cssText = 'margin-bottom:10px;padding:10px 12px;border:1px solid var(--border-color);border-radius:4px;';
      var head = document.createElement('div');
      head.style.cssText = 'font-size:12px;color:var(--text-primary);margin-bottom:6px;word-break:break-all;';
      var loc = document.createElement('span');
      loc.style.cssText = 'font-weight:bold;';
      loc.textContent = item.file + ':' + item.line;
      var tag = document.createElement('span');
      tag.style.cssText = 'margin-left:8px;font-size:11px;color:var(--orange);';
      tag.textContent = item.label || '';
      head.appendChild(loc); head.appendChild(tag);
      row.appendChild(head);
      var ctx = document.createElement('div');
      ctx.style.cssText = 'font-family:Consolas,monospace;font-size:12px;color:var(--text-secondary);background:var(--border-color);padding:6px 8px;border-radius:3px;white-space:pre-wrap;word-break:break-all;margin-bottom:8px;';
      ctx.textContent = item.context;
      row.appendChild(ctx);
      var btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;';
      btns.appendChild(_mkBtn(_t('secretGuard.btnErase', '抹除'), function () { _eraseOne(projPath, item).then(function () { _renderPanel(projPath); }); }, true));
      btns.appendChild(_mkBtn(_t('secretGuard.btnKeep', '保留'), function () { _keepOne(projPath, item).then(function () { _renderPanel(projPath); }); }));
      btns.appendChild(_mkBtn(_t('secretGuard.btnIgnoreFile', '忽略此文件'), function () { _ignoreFile(projPath, item).then(function () { _renderPanel(projPath); }); }));
      row.appendChild(btns);
      body.appendChild(row);
    }
    _panelEl.appendChild(body);

    var foot = document.createElement('div');
    foot.style.cssText = 'padding:12px 20px;border-top:1px solid var(--border-color);display:flex;gap:8px;align-items:center;';
    foot.appendChild(_mkBtn(_t('secretGuard.btnEraseAll', '全部抹除'), function () { _eraseAll(projPath); }, true));
    foot.appendChild(_mkBtn(_t('secretGuard.btnKeepAll', '全部保留'), function () { _keepAll(projPath); }));
    var hint = document.createElement('span');
    hint.style.cssText = 'margin-left:auto;font-size:11px;color:var(--text-secondary);';
    hint.textContent = _t('secretGuard.editorOpenHint', '提示：已在编辑器中打开的文件会被跳过，避免覆盖未保存的编辑');
    foot.appendChild(hint);
    _panelEl.appendChild(foot);
  }

  // ── 协同动作 ──
  function _dropFromQueue(projPath, fn) {
    var list = _pendingT3[projPath] || [];
    _pendingT3[projPath] = list.filter(fn);
  }

  async function _eraseOne(projPath, item) {
    try {
      var b = _b();
      if (!b || !b.fs) return;
      var full = _fullPath(projPath, item.file);
      var raw = await b.fs.read(full);
      if (typeof raw !== 'string') return;
      var idx = raw.indexOf(item.value);
      if (idx === -1) { _appendLog(projPath, 'SKIP(t3-value-missing) ' + item.file); return; }
      var rep = (item.quote || '') + REDACTED + (item.quote || '');
      var out = raw.slice(0, idx) + rep + raw.slice(idx + item.value.length);
      await b.fs.write(full, out);
      if (item.staged) {
        try {
          await b.qz.spawn({ cmd: await _gitBin(), args: ['-C', projPath, 'add', '--', item.file], timeout: 8000 });
        } catch (_) {}
      }
      var state = await _ensureState(projPath);
      state[item._vKey] = Date.now();
      _saveJson(_stateFile(projPath), state);
      _appendLog(projPath, 'REDACT[T3] ' + item.file + ':' + item.line + ' (user-confirmed)');
    } catch (err) {
      _appendLog(projPath, 'ERROR T3 ' + item.file + ' ' + (err && err.message ? err.message : err));
    }
    // ★ 2026-08-21 dsecret 多扫描路径实锤：item 引用可能来自 full/dirty 不同扫描批次，
    //   禁引用比较（x !== item 永远不过滤）；统一按 _vKey（relPath+值hash）去重
    _dropFromQueue(projPath, function (x) { return x._vKey !== item._vKey; });
  }

  async function _keepOne(projPath, item) {
    var wl = await _ensureWl(projPath);
    wl.values[item._vKey] = Date.now();
    _saveWl(projPath);
    _dropFromQueue(projPath, function (x) { return x._vKey !== item._vKey; });
  }

  async function _ignoreFile(projPath, item) {
    var wl = await _ensureWl(projPath);
    wl.files[item.file] = Date.now();
    _saveWl(projPath);
    _dropFromQueue(projPath, function (x) { return x.file !== item.file; });
  }

  async function _eraseAll(projPath) {
    var list = (_pendingT3[projPath] || []).slice();
    for (var i = 0; i < list.length; i++) await _eraseOne(projPath, list[i]);
    _renderPanel(projPath);
  }

  async function _keepAll(projPath) {
    var list = (_pendingT3[projPath] || []).slice();
    for (var i = 0; i < list.length; i++) await _keepOne(projPath, list[i]);
    _renderPanel(projPath);
  }

  // ═══════════ 开关联动 ═══════════
  function _onToggle(v) {
    var on = v !== false && v !== 'false';
    if (!on) {
      for (var p in _pendingT3) _clearPending(p);
    }
  }

  // ═══════════ dsecret 专职 goods API（2026-08-21） ═══════════
  async function _gitPorcelain(projPath) {
    try {
      var b = _b();
      if (!b || !b.qz || !b.qz.spawn) return '';
      var r = await b.qz.spawn({ cmd: await _gitBin(), args: ['-C', projPath, 'status', '--porcelain'], timeout: 8000 });
      if (!r || r.exitCode !== 0) return '';
      return r.stdout || '';
    } catch (_) { return ''; }
  }

  // 全量遍历跳过目录（full 体检模式）
  var FULL_SKIP_DIRS = ['_qqq/', '_qqqvault/', '.git/', 'node_modules/', 'dist/', 'build/', 'out/', '.idea/', '.vscode/', '.venv/', 'venv/', 'target/', 'vendor/', 'backup/'];

  // 全量目录遍历（只读体检用）。fs.list 条目: {name,isDir,size,...}
  async function _walkFiles(projPath, dirRel, out) {
    var b = _b();
    if (!b || !b.fs || !b.fs.list) return;
    var base = dirRel ? projPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + dirRel : projPath;
    var entries;
    try { entries = await b.fs.list(base); } catch (_) { return; }
    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      var name = ent && ent.name;
      if (!name || name === '.' || name === '..') continue;
      var rel = dirRel ? dirRel + '/' + name : name;
      if (ent.isDir) {
        var skip = false;
        for (var si = 0; si < FULL_SKIP_DIRS.length; si++) {
          var d = FULL_SKIP_DIRS[si].replace(/\/$/, '');
          if (rel === d || rel.indexOf(d + '/') !== -1) { skip = true; break; }
        }
        if (skip) continue;
        await _walkFiles(projPath, rel, out);
      } else {
        out.push(rel);
      }
    }
  }

  // 未提交扫描（dirty）：同后台事件路径，自动抹除 T1/T2 + 收集 T3
  async function _sgScanDirty(projPath) {
    if (!_enabled()) return { disabled: true };
    var porcelain = await _gitPorcelain(projPath);
    var files = _parsePorcelain(porcelain);
    var auto = [], t3 = [], skip = [];
    for (var fi = 0; fi < files.length; fi++) {
      var f = files[fi];
      var fp = f.path.replace(/\\/g, '/');
      var isSkip = false;
      for (var si = 0; si < SKIP_DIRS.length; si++) {
        if (fp.indexOf(SKIP_DIRS[si]) === 0) { isSkip = true; break; }
      }
      if (isSkip) { skip.push(fp); continue; }
      var res = await _processFile(projPath, _fullPath(projPath, fp), fp, f.staged);
      if (res) {
        if (res.auto && res.auto.length) { for (var ai = 0; ai < res.auto.length; ai++) auto.push(res.auto[ai]); }
        if (res.t3 && res.t3.length) { for (var tj = 0; tj < res.t3.length; tj++) t3.push(res.t3[tj]); }
      }
    }
    if (t3.length) { _pendingT3[projPath] = t3; _showCoopQoast(projPath); }
    else { _clearPending(projPath); }
    return { mode: 'dirty', porcelain: porcelain, fileCount: files.length, auto: auto, t3: t3, skip: skip };
  }

  // 全量体检扫描（full）：只读不写盘，展示全部命中
  async function _sgScanFull(projPath) {
    var files = [];
    await _walkFiles(projPath, '', files);
    var state = await _ensureState(projPath);
    var wl = await _ensureWl(projPath);
    var t1 = [], t2 = [], t3 = [];
    var b = _b();
    for (var i = 0; i < files.length; i++) {
      var fp = files[i];
      var full = _fullPath(projPath, fp);
      var st;
      try { st = b && b.fs ? await b.fs.stat(full) : null; } catch (_) { st = null; }
      if (st && st.size > MAX_FILE_BYTES) continue;
      var raw;
      try { raw = b && b.fs ? await b.fs.read(full) : null; } catch (_) { raw = null; }
      if (typeof raw !== 'string' || !raw || raw.indexOf('\x00') !== -1) continue;
      var findings = _scanContent(raw);
      if (!findings.length) continue;
      var fileWl = wl.files[fp];
      for (var j = 0; j < findings.length; j++) {
        var f = findings[j];
        if (fileWl) break;
        var vKey = fp + '\x00' + _valHash(f.value);
        if (wl.values[vKey]) continue;
        if (state[vKey] && Date.now() - state[vKey] < STATE_TTL) continue;
        f._vKey = vKey;
        f.file = fp;
        f.context = _maskedContext(raw, f.start, f.end);
        if (f.tier === 1) t1.push(f);
        else if (f.tier === 2) t2.push(f);
        else t3.push(f);
      }
    }
    return { mode: 'full', fileCount: files.length, t1: t1, t2: t2, t3: t3 };
  }

  async function _sgGetData(projPath) {
    var state = await _ensureState(projPath);
    var wl = await _ensureWl(projPath);
    var log = '';
    try {
      var b = _b();
      if (b && b.fs && b.fs.read) log = (await b.fs.read(_logFile(projPath))) || '';
    } catch (_) {}
    return { state: state, wlFiles: wl.files, wlValues: wl.values, log: log, pendingT3: _pendingT3[projPath] || [] };
  }

  async function _sgRemoveWl(projPath, kind, key) {
    var wl = await _ensureWl(projPath);
    if (kind === 'files' && wl.files[key]) delete wl.files[key];
    if (kind === 'values' && wl.values[key]) delete wl.values[key];
    _saveWl(projPath);
    return true;
  }

  async function _sgGitLogSearch(projPath, value) {
    try {
      var b = _b();
      if (!b || !b.qz || !b.qz.spawn) return { found: false, detail: 'bridge unavailable' };
      var r = await b.qz.spawn({ cmd: await _gitBin(), args: ['-C', projPath, 'log', '--all', '-S', value, '--oneline'], timeout: 30000 });
      var out = String(r.stdout || '').trim();
      return { found: out.length > 0, detail: out || '（全历史零命中，未暴露）' };
    } catch (e) { return { found: false, detail: 'err: ' + (e && e.message ? e.message : e) }; }
  }

  async function _sgGitIgnoreAdd(projPath, relPath, rmCached) {
    try {
      var b = _b();
      if (!b || !b.fs) return { ok: false, msg: 'fs unavailable' };
      var gi = projPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.gitignore';
      var cur = '';
      try { cur = (await b.fs.read(gi)) || ''; } catch (_) {}
      if (cur.indexOf(relPath) === -1) {
        var line = (cur && cur.slice(-1) !== '\n' ? '\n' : '') + relPath + '\n';
        await b.fs.write(gi, cur + line);
      }
      if (rmCached) {
        try {
          await b.qz.spawn({ cmd: await _gitBin(), args: ['-C', projPath, 'rm', '--cached', '--', relPath], timeout: 15000 });
        } catch (e) {
          return { ok: true, msg: '已加入 .gitignore（rm --cached 失败: ' + (e && e.message ? e.message : e) + '）' };
        }
      }
      return { ok: true, msg: rmCached ? '已忽略并取消跟踪' : '已加入 .gitignore' };
    } catch (e) { return { ok: false, msg: 'err: ' + (e && e.message ? e.message : e) }; }
  }

  function _sgSetEnabled(on) {
    try {
      var s = window.qqqSettings;
      if (s && typeof s.set === 'function') s.set('secret.maskHelp', on ? 'true' : 'false');
    } catch (_) {}
    _onToggle(on);
  }

  function _sgOnDirty(cb) {
    var fn = function (e) {
      try { cb({ path: e.detail.path, porcelain: e.detail.porcelain, count: e.detail.count }); } catch (_) {}
    };
    window.addEventListener('qqq:git-dirty', fn);
    return function () { window.removeEventListener('qqq:git-dirty', fn); };
  }

  // dsecret goods 专属接口（iframe 经 parent dsecret.js 中转调用）
  window.__qqqSecretGuard = {
    scanProject: async function (projPath, mode) {
      return mode === 'full' ? await _sgScanFull(projPath) : await _sgScanDirty(projPath);
    },
    act: async function (projPath, action, item) {
      if (action === 'erase') await _eraseOne(projPath, item);
      else if (action === 'keep') await _keepOne(projPath, item);
      else if (action === 'ignoreFile') await _ignoreFile(projPath, item);
      else if (action === 'eraseAll') await _eraseAll(projPath);
      else if (action === 'keepAll') await _keepAll(projPath);
      return _pendingT3[projPath] || [];
    },
    getData: _sgGetData,
    removeWl: _sgRemoveWl,
    gitLogSearch: _sgGitLogSearch,
    gitIgnoreAdd: _sgGitIgnoreAdd,
    setEnabled: _sgSetEnabled,
    onDirty: _sgOnDirty,
    isEnabled: _enabled
  };

  // ═══════════ 初始化 ═══════════
  function _init() {
    window.addEventListener('qqq:git-dirty', _onGitDirty);
    if (window.qqqSettings && window.qqqSettings.onChange) {
      window.qqqSettings.onChange('secret.maskHelp', _onToggle);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
