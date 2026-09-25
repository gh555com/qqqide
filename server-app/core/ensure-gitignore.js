// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ensure-gitignore.js — gitignore 保障机器（qd 工作目录泄露兜底）
//
// 定位（2026-09-24）: qd 会在项目里自建 _qqq/（AI 临时文件/对话数据）、
//   _qqqvault/（粘贴资产）、旧版根 tmp/ —— 若项目 .gitignore 未忽略它们，
//   一次 `git add -A && push` 就可能把 AI 临时文件/敏感内容提交出去。
//   本机器在 git 仓库首次可见时检测，缺项 → qoast 一键补全。
//
// 触发: ai-viewport.js git badge 轮询派发的 qqq:git-dirty（仅 git 仓库 status
//   成功才会派发）→ 每项目每会话检测一次。
// 检测: git check-ignore -n -v 单候选查询。⚠ 实测部分 git 对「未命中」会回显
//   伪命中（.gitignore:<空行>:\t<path>，模式为空）→ 模式为空一律判「未忽略」；
//   `::` 前缀 = 明确的「未忽略」；真实命中 = 有行号且模式非空。
// 修复: 仅用户点击 qoast「补全 .gitignore」才写盘（零静默改用户文件）。
//
// 状态: qgs.simple('qqq.gitignoreEnsure') → { [root]: { at, fixed } }
//   未修复且用户不点 → 7 天冷却；已修复 → 每次仍检测（回退即重新提醒）。
// ============================================================================
(function () {
  'use strict';

  var NS = 'qqq.gitignoreEnsure';
  var KEY = 'state';
  var COOLDOWN_MS = 7 * 24 * 3600 * 1000;

  var _done = {};    // root → true（本会话已完整检测）
  var _busy = {};    // root → true（检测/修复进行中）
  var _retry = {};   // root → 连续失败次数（git 异常时累计，3 次后放弃本会话）
  var _qoast = {};   // root → qoast 句柄

  function _b() { return window.qqqideBridge || null; }

  function _t(key, fb, vars) {
    var s = fb;
    try { s = window._i ? window._i(key, fb) : fb; } catch (_) { s = fb; }
    if (vars) {
      s = String(s).replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] !== undefined ? String(vars[k]) : m;
      });
    }
    return s;
  }

  function _norm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); }

  function _state() {
    try {
      if (window.qgs && typeof window.qgs.simple === 'function') return window.qgs.simple(NS);
    } catch (_) { }
    return null;
  }
  function _readState() {
    var st = _state();
    if (!st) return Promise.resolve({});
    return Promise.resolve(st.get(KEY)).then(function (v) {
      return (v && typeof v === 'object') ? v : {};
    })['catch'](function () { return {}; });
  }
  function _writeState(obj) {
    var st = _state();
    if (!st) return;
    try {
      if (typeof st.setNow === 'function') st.setNow(KEY, obj);
      else if (typeof st.set === 'function') st.set(KEY, obj);
    } catch (_) { }
  }

  async function _gitBin() {
    var b = _b();
    try {
      if (b && b.components && b.components.getBin) {
        var bin = await b.components.getBin('git');
        if (bin) return bin;
      }
    } catch (_) { }
    return 'git';
  }

  // 单候选查询: true=已忽略 / false=未忽略 / null=未知（git 异常 → 放弃）
  async function _isIgnored(gitBin, root, cand) {
    var b = _b();
    var r = await b.qz.spawn({
      cmd: gitBin,
      args: ['-C', root, 'check-ignore', '-n', '-v', '--', cand + '/'],
      timeout: 8000
    });
    if (!r || typeof r.stdout !== 'string') return null;
    var out = r.stdout;
    if (!out.trim()) return null;
    var lines = out.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var tab = line.indexOf('\t');
      if (tab < 0) continue;
      var head = line.slice(0, tab);
      if (head.indexOf('::') === 0) return false;       // 明确「未忽略」
      var m = /^(.*):\d+:(.*)$/.exec(head);
      if (!m) return false;                              // 异常格式 → 不以忽略论
      return m[2].length > 0;                            // 空模式=伪命中 → 未忽略
    }
    return null;
  }

  async function _scan(root) {
    var b = _b();
    if (!b || !b.fs || !b.qz || !window.qqqideQoast) return;
    var key = _norm(root);
    if (!key || _done[key] || _busy[key]) return;
    _busy[key] = true;
    try {
      var cands = ['_qqq', '_qqqvault'];
      try { if (await b.fs.exists(key + '/tmp')) cands.push('tmp'); } catch (_) { }

      var gitBin = await _gitBin();
      var missing = [];
      for (var i = 0; i < cands.length; i++) {
        var ig = await _isIgnored(gitBin, root, cands[i]);
        if (ig === null) {
          _retry[key] = (_retry[key] || 0) + 1;
          if (_retry[key] >= 3) _done[key] = true;   // 连续异常 → 本会话放弃
          return;
        }
        if (!ig) missing.push(cands[i] + '/');
      }
      _done[key] = true;
      if (!missing.length) return;

      var st = await _readState();
      var rec = st[key];
      if (rec && !rec.fixed && rec.at && (Date.now() - rec.at) < COOLDOWN_MS) return;

      _show(key, missing, st);
    } catch (_) { /* 保障机器绝不打断用户 */ }
    finally { delete _busy[key]; }
  }

  function _show(key, missing, st) {
    if (_qoast[key]) { try { _qoast[key].dismiss(); } catch (_) { } }
    var msg = _t('gitignoreEnsure.msg',
      '⚠️ 本项目 .gitignore 未忽略 {list} —— qd 工作目录（含 AI 临时文件）可能被 git 提交',
      { list: missing.join('、') });
    try {
      _qoast[key] = window.qqqideQoast.show(msg, {
        duration: 0,
        type: 'warning',
        action: {
          label: _t('gitignoreEnsure.btnFix', '补全 .gitignore'),
          onClick: function () { _apply(key, missing, st); }
        }
      });
    } catch (_) { }
    var rec = st[key] || {};
    rec.at = Date.now();
    if (rec.fixed !== true) rec.fixed = false;
    st[key] = rec;
    _writeState(st);
  }

  async function _apply(key, missing, st) {
    var b = _b();
    if (!b || !b.fs || _busy[key + ':fix']) return;
    _busy[key + ':fix'] = true;
    try {
      var gi = key + '/.gitignore';
      var cur = '';
      try { cur = (await b.fs.read(gi)) || ''; } catch (_) { cur = ''; }
      var lines = String(cur).replace(/\r\n/g, '\n').split('\n');
      var have = {};
      for (var i = 0; i < lines.length; i++) have[lines[i].trim()] = true;
      var add = [];
      for (var j = 0; j < missing.length; j++) {
        if (!have[missing[j]]) add.push(missing[j]);
      }
      if (add.length) {
        var sep = (cur && cur.slice(-1) !== '\n') ? '\n' : '';
        await b.fs.write(gi, cur + sep + add.join('\n') + '\n');
      }
      st[key] = { at: Date.now(), fixed: true };
      _writeState(st);
      if (_qoast[key]) { try { _qoast[key].dismiss(); } catch (_) { } delete _qoast[key]; }
      window.qqqideQoast.show(
        _t('gitignoreEnsure.done', '✓ 已补全 .gitignore：{list}', { list: (add.length ? add : missing).join('、') }),
        { duration: 9000 });
    } catch (e) {
      window.qqqideQoast.show(
        _t('gitignoreEnsure.fail', '补全 .gitignore 失败：{err}', { err: (e && e.message) ? e.message : String(e) }),
        { duration: 0, type: 'warning' });
    } finally { delete _busy[key + ':fix']; }
  }

  function _onGitDirty(e) {
    try {
      var p = e && e.detail && e.detail.path;
      if (p) _scan(p);
    } catch (_) { }
  }

  function _init() {
    window.addEventListener('qqq:git-dirty', _onGitDirty);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();

  window.qqqEnsureGitignore = { scan: _scan };
})();
