// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// workspace-seat.js — 落座机器（机器财产模型：一机一座 · 常量基地名 · 一次铸造）
//
// 唯一入口（主窗口全局）：window.qqqideSeat = { run, baseHint, base }
//
// 三层模型（全部可断言）：
//   基地 Base   {根}/az          名字恒 'az'——代码里没有第二个候选名（第二个基地在语法上不存在）
//   叶子 Leaf   {基地}/proj{m}   m = 最小空闲号（空目录自动复用 → 编号不膨胀）
//   账本 Seat   ws.sq3 键 'seat'  { v, state, base, leaf, root, at }（OS 级：跨窗口/跨包同一份）
//
// 阶梯（唯一入口 run()）：
//   S0 already  本窗口已有主文件夹 → 零动作
//   S1 adopt    账本 base 可达 → 先认账本叶子，被活锁占用就取最小空闲叶子
//   S2 reseat   账本 base 被删但盘还在 → 按账本同路径重建（名字常量 → 不是第二个基地）
//   S3 recover  账本丢 + 最近记录里有 */az/proj* 且存在 → 认它 + 补账本
//   S4 probe    账本丢 → 逐盘探已存在的 {根}/az（含 projN 子目录 或 空目录）→ 认 + 补账本
//   S5 mint     以上全空（真首启）→ {根}/az + proj1：全机器生命周期唯一一次
//   S6 ask      账本 base 不可达（盘拔了/改盘符）/ 无任何可用根 → 交回调用方（系统对话框）
//
// 铁律：
//   ① 基地名恒 az —— 禁编号、禁变体避让（唯一性靠构造，不靠判据）
//   ② 冲突 ≠ 创建 —— 叶子被活锁占用 → 换下一个空闲叶子；基地不可达 → 问人，绝不换盘再铸
//   ③ 本机器永不删除任何目录（认领失败的空壳靠最小空闲号自然复用，残骸自限）
//   ④ 零 marker 文件 —— 归属指纹 = 基地内的 projN 条目（只有我们会用这种名字）
//   ⑤ 触发面只在「真的要写盘」处（发送 / 附图落盘）：点击、聚焦、打字、纯文本粘贴零磁盘变化
// ============================================================================

(function () {
  'use strict';

  var BASE = 'az';              // 基地名（跨机器恒定；禁编号/禁变体）
  var LEAF = 'proj';            // 叶子名（proj1 … proj999）
  var LEAF_MAX = 999;
  var MIN_FREE = 1024 * 1024 * 1024;   // 剩余空间 < 1GB 的根不作候选
  var CLAIM_WAIT = 2000;        // 认领后确认窗
  var MAX_LOCK_SCAN = 8;        // 连续撞上活锁叶子的上限（超过 → 如实报 blocked）
  var SEAT_KEY = 'seat';        // ws.sq3 键（机器账本）

  var _flight = null;           // 单飞（多面板同时触发只跑一条）
  var _lastBase = '';           // 本次运行内认过的基地（baseHint 用）

  // ---- 基础设施 ----
  function _br() { try { return window.qqqideBridge || null; } catch (e) { return null; } }
  function _fs() { var b = _br(); return (b && b.fs) || null; }
  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function _norm(p) {
    var s = String(p || '').replace(/\\/g, '/');
    while (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
    return s;
  }
  function _baseNameOf(p) { var s = _norm(p); var i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
  function _parentOf(p) {
    var s = _norm(p);
    var i = s.lastIndexOf('/');
    if (i > 0) return s.slice(0, i);
    return (i === 0 && s.charAt(0) === '/') ? '/' : '';
  }
  // 盘根恒带斜杠（裸 'D:' 在 Windows 上是「D 盘当前目录」——stat 它会返回无关目录）
  function _rootOf(base) {
    var par = _parentOf(base);
    if (/^[a-zA-Z]:$/.test(par)) return par + '/';
    return par;
  }
  function _join(root, name) {
    var r = _norm(root);
    return (r === '/' ? '' : r) + '/' + name;   // POSIX 根 '/' 不叠双斜杠
  }
  function _vp() { try { return window.qqqideViewport || null; } catch (e) { return null; } }

  function _currentMain() {
    var vp = _vp();
    try {
      var m = (vp && vp.getMainProject) ? vp.getMainProject() : null;
      return (m && m.path) ? _norm(m.path) : '';
    } catch (e) { return ''; }
  }

  function _bootInfo() {
    if (window.qqqBootInfo && window.qqqBootInfo.appRoot) return Promise.resolve(window.qqqBootInfo);
    var br = _br();
    if (br && br.boot && br.boot.getInfo) return br.boot.getInfo().catch(function () { return {}; });
    return Promise.resolve({});
  }

  // 原子独占建目录：ok / EEXIST / 其他（只读·无权限·父级不存在…）
  function _mkdirCode(p) {
    var fsb = _fs();
    if (!fsb) return Promise.resolve({ ok: false, code: 'ENOBRIDGE' });
    if (fsb.mkdirExclusive) {
      return Promise.resolve(fsb.mkdirExclusive(p)).catch(function () { return { ok: false, code: 'EFAIL' }; });
    }
    // 旧壳层兜底（无原子原语）：存在即占用，不存在才建
    return fsb.exists(p).catch(function () { return true; }).then(function (ex) {
      if (ex) return { ok: false, code: 'EEXIST' };
      return fsb.mkdir(p).then(function () { return { ok: true }; },
        function (e2) { return { ok: false, code: (e2 && e2.code) || 'EFAIL' }; });
    });
  }

  function _stat(p) {
    var fsb = _fs();
    if (!fsb || !fsb.stat) return Promise.resolve(null);
    return fsb.stat(p).catch(function () { return null; });
  }
  function _isDir(p) {
    return _stat(p).then(function (st) { return !!(st && (st.isDir || st.isDirectory)); });
  }
  // 目录是否为空（读不了 = 视为占用：绝不碰读不到的目录）
  function _isEmpty(p) {
    var fsb = _fs();
    if (!fsb || !fsb.list) return Promise.resolve(false);
    return fsb.list(p).then(function (l) { return !l || l.length === 0; }, function () { return false; });
  }

  // ---- 机器账本（ws.sq3；每次 run 必读，禁缓存）----
  function _ws() {
    var br = _br();
    if (br && br.wsState && typeof br.wsState.get === 'function') return br.wsState;
    return null;
  }
  function _readSeat() {
    var ws = _ws();
    if (!ws) return Promise.resolve(null);
    return ws.get(SEAT_KEY).then(function (v) {
      if (!v || typeof v !== 'object') return null;
      var base = _norm(v.base);
      if (!base) return null;
      return {
        state: (v.state === 'minting') ? 'minting' : 'seated',
        base: base,
        leaf: _norm(v.leaf),
        root: _norm(v.root),
        at: v.at || 0
      };
    }, function () { return null; });
  }
  function _writeSeat(rec) {
    var ws = _ws();
    if (!ws || !ws.set) return Promise.resolve(false);
    return ws.set(SEAT_KEY, rec).then(function () { return true; }, function () { return false; });
  }

  // ---- 归属指纹：基地内存在 projN 条目 = 只有我们会用这种名字（零 marker 文件）----
  //   同名是文件也算：宁可当自己的（继续用同一基地，绝不因此另铸第二个基地）
  function _looksOurs(base) {
    var fsb = _fs();
    if (!fsb || !fsb.list) return Promise.resolve(true);   // 读不了 → 交给后续 mkdir/认领判，不据此拉黑
    return fsb.list(base).then(function (l) {
      var arr = Array.isArray(l) ? l : [];
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i] || {};
        var nm = String(it.name || '').replace(/\/$/, '');
        if (/^proj[0-9]+$/i.test(nm)) return true;
      }
      return false;
    }, function () { return true; });
  }

  // ---- 选区：盘符升序（可复现、不随磁盘占用漂移）+ 用户主目录兜底 ----
  function _freeOf(free, root) {
    if (!free || typeof free !== 'object') return null;
    var cands = [root, root + '/', root + '\\'];
    var letter = String(root || '').charAt(0).toUpperCase();
    if (letter) { cands.push(letter + ':', letter + ':/', letter + ':\\', letter); }
    for (var i = 0; i < cands.length; i++) {
      var e = free[cands[i]];
      if (e && typeof e.free === 'number') return e;
    }
    return null;
  }

  function _places(info) {
    var fsb = _fs();
    var plat = (info && info.platform) || 'win32';
    var home = _norm(info && info.homedir);
    if (plat !== 'win32' || !fsb || !fsb.drives) {
      return Promise.resolve(home ? [home] : []);
    }
    return fsb.drives().catch(function () { return []; }).then(function (drives) {
      var list = (Array.isArray(drives) ? drives : []).slice().sort();   // 盘符升序
      var roots = [];
      for (var i = 0; i < list.length; i++) {
        var d = String(list[i] || '');
        var letter = d.charAt(0).toUpperCase();
        if (!letter || letter === 'C') continue;   // 系统盘永不作基地根（盘根 UAC 虚拟化 = 假成功）
        roots.push(_norm(d));
      }
      var freeP = (fsb.diskFree && roots.length)
        ? fsb.diskFree(list).catch(function () { return {}; })
        : Promise.resolve({});
      return freeP.then(function (free) {
        var res = [];
        for (var k = 0; k < roots.length; k++) {
          var e = _freeOf(free, roots[k]);
          if (e && e.free < MIN_FREE) continue;    // 空间不足 → 不候选
          res.push(roots[k] + '/');                // 盘根恒带斜杠（裸 'D:' = 该盘当前目录）
        }
        if (home) res.push(home);                  // 兜底：用户主目录（单盘机器唯一出口）
        return res;
      });
    });
  }

  // 只读探针：{根}/az 是否是「我们的基地」（已存在且空 / 含 projN）
  function _probeExisting(root) {
    var p = _join(root, BASE);
    return _stat(p).then(function (st) {
      if (!st || !(st.isDir || st.isDirectory)) return null;
      return _isEmpty(p).then(function (empty) {
        if (empty) return { base: p, kind: 'empty' };
        return _looksOurs(p).then(function (ours) { return ours ? { base: p, kind: 'ours' } : null; });
      });
    });
  }

  // 认领：项目锁仲裁 → 视口主文件夹（等确认）
  function _claimViaViewport(p) {
    var vp = _vp();
    if (!vp || typeof vp.addProject !== 'function') return Promise.resolve(false);
    try { vp.addProject(p); } catch (e) { return Promise.resolve(false); }
    var t0 = Date.now();
    function poll() {
      if (_norm(_currentMain()) === _norm(p)) return Promise.resolve(true);
      if (Date.now() - t0 >= CLAIM_WAIT) return Promise.resolve(false);
      return _sleep(120).then(poll);
    }
    return poll();
  }

  function _claim(p) {
    var br = _br();
    var pl = br && br.projectLock;
    // 先 query：已有活锁的叶子直接跳过——claim 会把对方窗口抢到前台（用户正在别处打字 → 禁静默夺焦）
    var pre = (pl && pl.query) ? pl.query(p).catch(function () { return null; }) : Promise.resolve(null);
    return pre.then(function (q) {
      if (q && q.locked) return { ok: false, reason: 'locked' };
      if (!pl || !pl.claim) return null;
      return pl.claim(p).catch(function () { return null; });
    }).then(function (res) {
      if (res && res.ok === false) {
        // 极小概率的竞态窗口（query 到 claim 之间被抢）→ 当作被占，换下一个空闲叶子
        return { ok: false, reason: (res.reason || 'locked') };
      }
      return _claimViaViewport(p).then(function (ok) {
        if (ok) return { ok: true };
        // 抢到锁却没绑上（视口缺失/拒绝）→ 立刻还锁，绝不留孤儿锁
        if (res && res.ok && pl && pl.release) { try { pl.release(p).catch(function () { }); } catch (_) { } }
        return { ok: false, reason: 'bind-failed' };
      });
    });
  }

  // 单个叶子：建（或复用已有）→ 认领
  //   返回 {ok:true,path,fresh} | {ok:false,reason,fatal?}
  function _tryLeaf(p) {
    return _mkdirCode(p).then(function (mk) {
      if (!mk.ok && mk.code !== 'EEXIST') return { ok: false, reason: 'unwritable', fatal: true };
      var existed = !mk.ok;
      var guard = Promise.resolve(true);
      if (existed) guard = _isDir(p);      // 同名是文件 → 跳过该号
      return guard.then(function (isDir) {
        if (!isDir) return { ok: false, reason: 'taken' };
        return _claim(p).then(function (cl) {
          if (cl.ok) return { ok: true, path: p, fresh: !existed };
          // 我们自己刚建的空目录认领失败 = 异常（不留残骸、也不再造新目录）
          return { ok: false, reason: cl.reason || 'locked', fatal: existed ? false : true };
        });
      });
    });
  }

  // 在基地内落座：先试账本叶子，再按最小空闲号推进
  function _seatLeaf(base, prefer) {
    var pf = _norm(prefer || '');
    var tried = {};
    var locked = 0;
    var seq = pf ? [pf] : [];
    for (var m = 1; m <= LEAF_MAX; m++) seq.push(base + '/' + LEAF + m);
    var i = 0;
    function step() {
      if (i >= seq.length) return Promise.resolve({ ok: false, reason: 'exhausted' });
      var p = seq[i];
      i++;
      if (tried[p]) return step();
      tried[p] = true;
      return _tryLeaf(p).then(function (r) {
        if (r.ok) return r;
        if (r.fatal) return r;
        if (r.reason === 'locked' || r.reason === 'bind-failed') {
          locked++;
          if (locked >= MAX_LOCK_SCAN) return { ok: false, reason: r.reason };
        }
        return step();
      });
    }
    return step();
  }

  // 附加：基地进 Roam 历史置顶区（先读后并写，绝不整体覆盖）
  function _attach(base) {
    var br = _br();
    if (!base || !br || !br.roam || !br.roam.get || !br.roam.set) return Promise.resolve(false);
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

  // 项目路径合法性（程序域互斥 / 盘根）：唯一谓词在视口（禁第二套判据）
  function _pathOk(p) {
    var vp = _vp();
    if (!vp || typeof vp.classifyProjectPath !== 'function') return Promise.resolve(true);
    return Promise.resolve(vp.classifyProjectPath(p)).then(
      function (r) { return !!(r && r.ok); }, function () { return true; });
  }

  // 账本 base 可达性：不存在但盘在 → 按同路径重建（S2 reseat）；盘不在 / 落在程序域 → 不可达（S6 ask）
  async function _baseAlive(base) {
    if (!(await _pathOk(base))) return false;
    var st = await _stat(base);
    if (st && (st.isDir || st.isDirectory)) return true;
    var root = _rootOf(base);
    if (!root) return false;
    var rst = await _stat(root);
    if (!rst || !(rst.isDir || rst.isDirectory)) return false;   // 盘不在（U 盘/网络盘/改盘符）
    var mk = await _mkdirCode(base);                              // 盘在 → 同路径重建
    return !!mk.ok;
  }

  // 账本丢失时的记忆回捞：只认「我们基地里的」项目（避免把用户自有工程错当基地）
  function _fromMemory() {
    var br = _br();
    var ws = _ws();
    var cands = [];
    var p1 = (ws && ws.get) ? ws.get('lastMainFolder').catch(function () { return null; }) : Promise.resolve(null);
    return p1.then(function (lmf) {
      if (lmf && typeof lmf === 'string') cands.push(lmf);
      var p2 = (ws && ws.get) ? ws.get('recentFolders').catch(function () { return null; }) : Promise.resolve(null);
      return p2;
    }).then(function (rec) {
      if (Array.isArray(rec)) {
        for (var i = 0; i < rec.length && cands.length < 24; i++) {
          var p = rec[i] && rec[i].path;
          if (p) cands.push(p);
        }
      }
      var g = (br && br.state && br.state.get)
        ? br.state.get('qqqide', 'last_main_folder').catch(function () { return null; })
        : Promise.resolve(null);
      return g;
    }).then(function (gpath) {
      if (gpath && typeof gpath === 'string') cands.push(gpath);
      var i = 0;
      function step() {
        if (i >= cands.length) return null;
        var path = _norm(cands[i]);
        i++;
        var parent = _parentOf(path);
        if (!parent || _baseNameOf(parent).toLowerCase() !== BASE) return step();
        return _isDir(path).then(function (ok) {
          if (!ok) return step();
          return _pathOk(path).then(function (good) { return good ? { base: parent, leaf: path } : step(); });
        });
      }
      return step();
    });
  }

  async function _settle(leaf, base, code, fresh) {
    _lastBase = base;
    await _writeSeat({ v: 1, state: 'seated', base: base, leaf: leaf, root: _rootOf(base), at: Date.now() });
    _attach(base).catch(function () { });
    if (fresh) _announce(leaf);
    return { ok: true, code: code, proj: leaf, base: base };
  }

  async function _runOnce() {
    var info = await _bootInfo();

    // S1 / S2 —— 账本（唯一权威指针）
    var seat = await _readSeat();
    if (seat && seat.base) {
      var alive = await _baseAlive(seat.base);
      if (!alive) return { ok: false, code: 'ask', base: seat.base, reason: 'base-unreachable' };
      var r1 = await _seatLeaf(seat.base, seat.leaf);
      if (r1.ok) return _settle(r1.path, seat.base, 'adopt', r1.fresh);
      if (r1.reason === 'exhausted') return { ok: false, code: 'ask', base: seat.base, reason: 'leaf-exhausted' };
      return { ok: false, code: 'blocked', base: seat.base, reason: r1.reason || 'locked' };
    }

    // S3 —— 账本丢：最近记录
    var rec = await _fromMemory();
    if (rec) {
      var r2 = await _seatLeaf(rec.base, rec.leaf);
      if (r2.ok) return _settle(r2.path, rec.base, 'recover', r2.fresh);
    }

    // 根候选（盘符升序 → 用户主目录）
    var places = await _places(info);

    // S4 —— 账本丢：探已存在的基地（先认旧，绝不先造新）
    for (var i = 0; i < places.length; i++) {
      var pr = await _probeExisting(places[i]);
      if (!pr) continue;
      var r3 = await _seatLeaf(pr.base, '');
      if (r3.ok) return _settle(r3.path, pr.base, 'probe', r3.fresh);
      if (r3.reason === 'exhausted') return { ok: false, code: 'ask', base: pr.base, reason: 'leaf-exhausted' };
    }

    // S5 —— 真首启：铸造（唯一一次）
    for (var j = 0; j < places.length; j++) {
      var root = places[j];
      if (!_norm(root)) continue;
      var base = _join(root, BASE);
      if (!(await _pathOk(base))) continue;                  // 落在程序域（包解到盘根）/ 盘根 → 换根
      var mk = await _mkdirCode(base);
      if (!mk.ok && mk.code !== 'EEXIST') continue;         // 该根不可建（只读/权限/盘不在）
      if (mk.code === 'EEXIST') {
        var st = await _stat(base);
        if (!st || !(st.isDir || st.isDirectory)) continue; // 同名是文件 → 换根
        var empty = await _isEmpty(base);
        if (!empty) {
          var ours = await _looksOurs(base);
          if (!ours) continue;                              // 别人的 az → 绝不碰、绝不改名
        }
      }
      // 意图先落盘（minting）：别的窗口/实例读到就跟随同一条路径
      await _writeSeat({ v: 1, state: 'minting', base: base, leaf: '', root: root, at: Date.now() });
      var r4 = await _seatLeaf(base, '');
      if (r4.ok) return _settle(r4.path, base, mk.ok ? 'minted' : 'adopt', r4.fresh);
      return { ok: false, code: 'blocked', base: base, reason: r4.reason || 'locked' };
    }

    return { ok: false, code: 'ask', reason: 'no-place' };
  }

  // ---- 主流程（幂等 / 单飞 / 已有一律短路）----
  function run() {
    if (_flight) return _flight;
    var cur = _currentMain();
    if (cur) return Promise.resolve({ ok: true, code: 'already', proj: cur, base: '' });
    _flight = _runOnce().then(
      function (r) { _flight = null; return r || { ok: false, code: 'error' }; },
      function () { _flight = null; return { ok: false, code: 'error' }; }
    );
    return _flight;
  }

  // ---- 对话框默认落点（视口「+」/ 选文件夹）：恒指向我们的基地 ----
  async function baseHint() {
    var cur = _currentMain();
    if (cur) {
      var par = _parentOf(cur);
      if (par && new RegExp('^' + LEAF + '[0-9]+$', 'i').test(_baseNameOf(cur))) return par;
      return cur;
    }
    if (_lastBase) return _lastBase;
    var seat = await _readSeat();
    if (seat && seat.base) {
      // 盘还在就回账本路径（基地被删了也会在下次落座时按同路径重建）
      var st = await _stat(seat.base);
      if (st) return seat.base;
      var rst = await _stat(_rootOf(seat.base));
      if (rst) return seat.base;
    }
    var info = await _bootInfo();
    var places = await _places(info);
    for (var i = 0; i < places.length; i++) {
      var pr = await _probeExisting(places[i]);
      if (pr) return pr.base;
    }
    return places.length ? String(places[0]) : '';
  }

  window.qqqideSeat = {
    run: run,
    baseHint: baseHint,
    base: function () { return _lastBase; }
  };
})();
