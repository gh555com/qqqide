// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// workspace-seat.js — 落座机器（首启打样：主文件夹 / 项目基地一键就绪）
//
// 唯一入口（主窗口全局）：window.qqqideSeat = { run, baseHint, base }
//
// 语义（状态驱动，不依赖「第几次启动」）：
//   0 短路  已有主文件夹 → 零动作
//   1 选址  非系统盘·可用空间最足者 → {盘}/az{n}（n=1 起第一个可用；非空恒不碰）
//   2 落座  原子建 {基地}/proj{m}（m=1 起第一个可用）
//   3 认领  qqqideViewport.addProject(叶子) → 成为主文件夹（自带最近列表 bump）
//   4 附加  基地进 Roam 右上角历史置顶区（roam.pinnedDirs，只并写不覆盖）
//   5 告知  qoast：已就绪 · <路径> 你可以直接开始
//
// 铁律：不写 marker / 不写一次性 flag / 不弹确认框 / 不新增家目录来源（_qqq 仍由
//       绑定时自然生成）。失败唯一出口 = 系统对话框（由调用方兜底）。
// 基地永远不是项目：只进 roam.pinnedDirs（点击 = Roam 内跳转），绝不进视口最近列表。
// ============================================================================

(function () {
  'use strict';

  var BASE = 'az';              // 基地名（跨机器恒定、可搜索、可识别）
  var BASE_MAX = 999999;        // az … az999999
  var LEAF = 'proj';
  var LEAF_MAX = 999;
  var MIN_FREE = 1024 * 1024 * 1024;   // 1GB 以下不候选
  var CLAIM_TRIES = 3;          // 叶子被项目锁占用时的重试次数
  var CLAIM_WAIT = 2000;        // 认领后确认窗

  var _flight = null;           // 单飞 promise（多面板同时触发只跑一条）
  var _lastBase = '';           // 本次运行内认过的基地（baseHint 用）

  // ---- 基础设施 ----
  function _br() { try { return window.qqqideBridge || null; } catch (e) { return null; } }
  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function _norm(p) {
    var s = String(p || '').replace(/\\/g, '/');
    while (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
    return s;
  }
  function _vp() { try { return window.qqqideViewport || null; } catch (e) { return null; } }

  function _bootInfo() {
    if (window.qqqBootInfo && window.qqqBootInfo.appRoot) return Promise.resolve(window.qqqBootInfo);
    var br = _br();
    if (br && br.boot && br.boot.getInfo) {
      return br.boot.getInfo().catch(function () { return {}; });
    }
    return Promise.resolve({});
  }

  // 原子独占建目录：ok / EEXIST / 其他（只读·无权限·父级不存在…）
  function _mkdirCode(p) {
    var br = _br();
    if (!br || !br.fs) return Promise.resolve({ ok: false, code: 'ENOBRIDGE' });
    if (br.fs.mkdirExclusive) {
      return br.fs.mkdirExclusive(p).catch(function () { return { ok: false, code: 'EFAIL' }; });
    }
    // 旧壳层兜底（无原子原语）：存在即占用，不存在才建
    return br.fs.exists(p).catch(function () { return true; }).then(function (ex) {
      if (ex) return { ok: false, code: 'EEXIST' };
      return br.fs.mkdir(p).then(function () { return { ok: true }; },
        function (e2) { return { ok: false, code: (e2 && e2.code) || 'EFAIL' }; });
    });
  }

  // 目录是否为空（读不了 = 视为占用：绝不碰读不到的目录）
  function _isEmpty(p) {
    var br = _br();
    if (!br || !br.fs) return Promise.resolve(false);
    return br.fs.list(p).then(function (l) { return !l || l.length === 0; },
      function () { return false; });
  }

  // ---- 选址：有序候选（非系统盘·空间最足在前；用户主目录恒为兜底）----
  function _places(info) {
    var br = _br();
    var plat = (info && info.platform) || 'win32';
    var home = _norm(info && info.homedir);
    var out = [];
    var drivesP = (br && br.fs && br.fs.drives) ? br.fs.drives() : Promise.resolve([]);
    return drivesP.catch(function () { return []; }).then(function (drives) {
      var list = Array.isArray(drives) ? drives : [];
      if (plat !== 'win32') return out;   // mac / linux：只走用户主目录
      var freeP = (br && br.fs && br.fs.diskFree && list.length)
        ? br.fs.diskFree(list).catch(function () { return {}; })
        : Promise.resolve({});
      return freeP.then(function (free) {
        var rows = [];
        for (var i = 0; i < list.length; i++) {
          var d = String(list[i] || '');
          var letter = d.charAt(0).toUpperCase();
          // 系统盘永不作候选：盘根不可写（UAC 虚拟化）+ 系统域
          if (!letter || letter === 'C') continue;
          var entry = (free && free[letter]) || (free && free[d]) || null;
          var known = !!(entry && typeof entry.free === 'number');
          var b = known ? entry.free : 0;
          if (known && b < MIN_FREE) continue;              // 明确空间不足 → 不候选
          rows.push({ root: _norm(d), free: b, known: known });   // 空间未知（度量桥不可用）仍候选，排已知之后
        }
        rows.sort(function (a, b2) {
          if (a.known !== b2.known) return a.known ? -1 : 1;
          return b2.free - a.free;
        });
        for (var k = 0; k < rows.length; k++) out.push(rows[k].root);
        return out;
      });
    }).then(function (list2) {
      if (home) list2.push(home);   // 兜底：用户主目录（免权限、恒可写；单盘机器唯一出口）
      return list2;
    });
  }

  // ---- 基地：{根}/az{n} 第一个可用（不存在 → 建；空目录 → 直接用；非空 → 绝不碰，推下一个）----
  function _pickBase(root) {
    var n = 1;
    function step() {
      if (n > BASE_MAX) return Promise.resolve(null);
      var name = n === 1 ? BASE : BASE + n;
      n++;
      var p = _norm(root) + '/' + name;
      return _mkdirCode(p).then(function (mk) {
        if (mk.ok) return { base: p, fresh: true };
        if (mk.code !== 'EEXIST') return null;              // 该位置不可用（只读 / 权限）→ 换盘
        return _isEmpty(p).then(function (empty) {
          if (empty) return { base: p, fresh: false };      // 已存在且空：直接用，不写不改
          return step();                                    // 非空：绝不碰
        });
      });
    }
    return step();
  }

  // ---- 叶子：{基地}/proj{m} 第一个可用（skip = 已试过但认领失败的，绝不得重选）----
  function _pickLeaf(base, skip) {
    var m = 1;
    var tried = skip || {};
    function step() {
      if (m > LEAF_MAX) return Promise.resolve(null);
      var p = base + '/' + LEAF + m;
      m++;
      if (tried[p]) return step();
      return _mkdirCode(p).then(function (mk) {
        if (mk.ok) return { path: p, fresh: true };
        if (mk.code !== 'EEXIST') return null;
        return _isEmpty(p).then(function (empty) { return empty ? { path: p, fresh: false } : step(); });
      });
    }
    return step();
  }

  // 认领：成为视口主文件夹（addProject 自带最近列表 bump），并等确认
  function _claim(p) {
    var vp = _vp();
    if (!vp || typeof vp.addProject !== 'function') return Promise.resolve(false);
    try { vp.addProject(p); } catch (e) { return Promise.resolve(false); }
    var t0 = Date.now();
    function poll() {
      var m = null;
      try { m = vp.getMainProject(); } catch (e2) { m = null; }
      if (m && m.path) return Promise.resolve(_norm(m.path) === _norm(p));
      if (Date.now() - t0 >= CLAIM_WAIT) return Promise.resolve(false);
      return _sleep(120).then(poll);
    }
    return poll();
  }

  // 附加：基地进 Roam 历史置顶区（先读后并写，绝不整体覆盖）
  function _attach(base) {
    var br = _br();
    if (!br || !br.roam || !br.roam.get || !br.roam.set) return Promise.resolve(false);
    return br.roam.get('roam.pinnedDirs').catch(function () { return null; }).then(function (cur) {
      var arr = Array.isArray(cur) ? cur.slice() : [];
      var key = _norm(base).toLowerCase();
      for (var i = 0; i < arr.length; i++) {
        if (_norm(arr[i]).toLowerCase() === key) return true;
      }
      arr.push(base);
      return br.roam.set('roam.pinnedDirs', arr).then(function () { return true; },
        function () { return false; });
    });
  }

  function _announce(leaf) {
    try {
      var txt = window._i('shell.seat.ready', '已就绪 · {p} 你可以直接开始', { p: leaf });
      if (window.qqqideQoast) window.qqqideQoast.show(txt, { type: 'success', duration: 9000 });
    } catch (e) { }
  }

  // 刚建的空目录没派上用场 → 清掉（不留残骸；只删确认仍为空的目录）
  function _dropEmptyDir(base) {
    var br = _br();
    if (!br || !br.fs) return Promise.resolve(false);
    return _isEmpty(base).then(function (empty) {
      if (!empty) return false;
      return br.fs.remove(base).then(function () { return true; }, function () { return false; });
    });
  }

  // ---- 主流程 ----
  function run() {
    if (_flight) return _flight;
    var vp0 = _vp();
    var cur0 = null;
    try { cur0 = vp0 && vp0.getMainProject ? vp0.getMainProject() : null; } catch (e) { cur0 = null; }
    if (cur0 && cur0.path) return Promise.resolve({ ok: true, code: 'already', proj: cur0.path, base: '' });
    _flight = (function () {
      var vp = vp0;
      return _bootInfo().then(function (info) {
        return _places(info).then(function (places) {
          var i = 0;
          function nextPlace() {
            if (i >= places.length) return Promise.resolve({ ok: false, code: 'no_place' });
            var root = places[i];
            i++;
            return _pickBase(root).then(function (picked) {
              if (!picked) return nextPlace();
              return _seatIn(picked).then(function (r) {
                if (r && r.ok) return r;
                if (picked.fresh) return _dropEmptyDir(picked.base).then(nextPlace);
                return nextPlace();
              });
            });
          }
          function _seatIn(picked) {
            var t = 0;
            var tried = {};
            function attempt() {
              var now = null;
              try { now = vp && vp.getMainProject ? vp.getMainProject() : null; } catch (e) { now = null; }
              if (now && now.path) return Promise.resolve({ ok: true, code: 'already', proj: now.path, base: '' });
              if (t >= CLAIM_TRIES) return Promise.resolve({ ok: false, code: 'locked' });
              t++;
              return _pickLeaf(picked.base, tried).then(function (leaf) {
                if (!leaf) return { ok: false, code: 'no_leaf' };
                tried[leaf.path] = true;
                return _claim(leaf.path).then(function (ok) {
                  if (!ok) {
                    // 自己刚建的空目录认领失败 → 清掉再试；已有目录（别的实例建的）一字不碰
                    if (!leaf.fresh) return attempt();
                    return _dropEmptyDir(leaf.path).then(attempt);
                  }
                  _lastBase = picked.base;
                  _attach(picked.base);
                  _announce(leaf.path);
                  return { ok: true, code: 'seated', proj: leaf.path, base: picked.base };
                });
              });
            }
            return attempt();
          }
          return nextPlace();
        });
      }).catch(function () {
        return { ok: false, code: 'error' };
      }).then(function (r) {
        if (!r || r.code !== 'seated') _lastBase = '';
        _flight = null;
        return r || { ok: false, code: 'error' };
      }, function () {
        _flight = null;
        return { ok: false, code: 'error' };
      });
    })();
    return _flight;
  }

  // ---- 对话框默认落点（点视口「+」时用：恒指向基地，从源头治住 Downloads 默认目录）----
  //   ① 已有主文件夹 → 它的基地/所在目录  ② 本次认过的基地
  //   ③ 首个已存在的 {盘}/az            ④ 空间最足的候选盘根（用户自己挑新位置）
  function baseHint() {
    var vp = _vp();
    var m = null;
    try { m = vp && vp.getMainProject ? vp.getMainProject() : null; } catch (e) { m = null; }
    if (m && m.path) {
      var p = _norm(m.path);
      var cut = p.lastIndexOf('/');
      if (cut > 0 && new RegExp('^' + LEAF + '[0-9]+$', 'i').test(p.slice(cut + 1))) return Promise.resolve(p.slice(0, cut));
      return Promise.resolve(p);
    }
    if (_lastBase) return Promise.resolve(_lastBase);
    var br = _br();
    return _bootInfo().then(function (info) {
      return _places(info).then(function (places) {
        var i = 0;
        function probe() {
          if (i >= places.length) return '';
          var root = _norm(places[i]);
          i++;
          if (!br || !br.fs || !br.fs.exists) return root;
          return br.fs.exists(root + '/' + BASE).then(function (ex) {
            return ex ? root + '/' + BASE : probe();
          }, function () { return probe(); });
        }
        return probe();
      });
    }).catch(function () { return ''; });
  }

  window.qqqideSeat = {
    run: run,
    baseHint: baseHint,
    base: function () { return _lastBase; }
  };
})();
