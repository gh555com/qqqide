// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/solar-house/solar-app.js — Solar House 客户端（纯渲染 + 遥控杆）
//
// 客户端边界（设计 §14，铁律）: 只做 键事件上报 / 快照渲染 / ≤1 帧插值 /
//   q 视觉预测 / UI 展示。零随机生成、零碰撞判定、零伤害/分数计算、
//   零轨迹规则、零数值表（仅下方 RENDER_ONLY 渲染视觉常量）、零技能裁决。
// 服务器是唯一真理: 玩法/协议规格源 gaea/docs/Solar House 设计.md §10。
//
// 二进制帧（10Hz, 大端）:
//   snap  [0]=2 [1]=0 [2-3]seq [4-5]qx [6]hp [7-8]score [9-14]cd1..3(ms)
//         [15]flags(bit0晕 bit1无敌) [16]alive [17-18]revive_ms [19]count
//         [20..] ×count(9B): kind u8 + id u16 + x u16 + y u16 + size u8 + ang u8
//   event [0]=2 [1]=1 [2]code: 0hit(dmg,hp) 1heal(amt,hp) 2score(n u16)
//         3skill(skill,cleared) 4revive 8die;  5=game_over(+score u16 alive u32 revive u8)
// ★ v2: 实体帧带稳定 id（v1 曾 7B/实体 8B 读 → 错位鬼影; 双帧插值改 id 锚定）
// 上行: {type:'msg', ch:'solar:{run_id}', text:'{"k":"l|r|1|2|3|abort","d":0|1}'}
// ============================================================================
(function () {
  'use strict';

  // ⭐ 渲染视觉常量（仅画布展示用，绝不参与任何判定）
  var WORLD_W = 300, UI_H = 56, Q_R = 12, Q_SPEED = 200, Q_Y_BASE = 44;
  var LASER_W = 120, ABSORB_H = 600, CD_TOTAL = [30000, 10000, 30000];

  // 加分菱形（正菱形）外观 = 菜单行1 的梦gaea kope/window 运行态状态灯 100% 同款
  // （gp-dot-kaleido 马卡龙万花筒: 六色各 60° 硬切扇区 + 黑细描边; 相位 spawn 随机
  //   定格零旋转动画 —— 用户定案 2026-09-06; 纯视觉, 不参与任何判定）
  var KALEIDO = ['#ff8ba0', '#ffc46b', '#ffe98a', '#8fe8b8', '#8cc9ff', '#d3a6ff'];
  var kaleidoPhase = {}; // 按实体稳定 id 记相位（id 锚定 → 帧间不闪; 新局 resetGameState 清空）
  var API_BASE = 'https://cnk.gh555.com/api/solar';
  var WS_BASE = 'wss://cnk.gh555.com/ws';
  var REVIVE_MS = 30000;

  // ── DOM ──
  function $(id) { return document.getElementById(id); }
  var elHome = $('sh-home'), elGame = $('sh-game'), elOver = $('sh-over');
  var elWrap = $('sh-wrap'), elCanvas = $('sh-canvas');
  var ctx = elCanvas.getContext('2d');
  var elRevive = $('sh-revive'), elToast = $('sh-toast');
  var elMsg = $('sh-msg'), elRvMsg = $('sh-rv-msg');
  var toastTimer = null;

  function toast(text) {
    elToast.textContent = text;
    elToast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.classList.remove('on'); }, 3200);
  }
  function setMsg(el, text) { el.textContent = text || ''; }

  function showPage(p) {
    [elHome, elGame, elOver].forEach(function (el) { el.classList.remove('on'); });
    p.classList.add('on');
  }

  // ── auth（登录态取自主窗口 qqqLogin, 同源 iframe 直接访问）──
  function token() {
    try {
      var w = window.parent;
      while (w && w !== window && !(w.qqqLogin && w.qqqLogin.getAuthToken)) w = w.parent;
      if (w && w.qqqLogin && w.qqqLogin.getAuthToken) return w.qqqLogin.getAuthToken() || '';
    } catch (_) { }
    return '';
  }

  // ── REST ──
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Authorization': 'Bearer ' + token() };
    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(API_BASE + path, init).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    });
  }
  function isLogged() { return !!token(); }

  // ── 手机号脱敏展示 ──
  function maskName(id) {
    if (!id) return '';
    var s = String(id).replace(/^\+/, '');
    if (s.length <= 8) return s;
    return s.slice(0, 3) + '****' + s.slice(-4);
  }
  function fmtAlive(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m > 0 ? (m + ' 分 ' + s + ' 秒') : (s + ' 秒');
  }

  // ── 榜 ──
  var boardTimer = null;
  function boardDay() { return new Date().toISOString().slice(0, 10); } // UTC 日

  function loadBoard(intoRows, intoMe, day) {
    return api('/board?day=' + (day || boardDay())).then(function (r) {
      if (!r.body || r.body.ok !== true) return null;
      return r.body;
    }).catch(function () { return null; });
  }

  function renderBoard() {
    var rowsEl = $('sh-board-rows'), meEl = $('sh-board-me');
    loadBoard().then(function (b) {
      if (!b) { setMsg(elMsg, '榜单拉取失败（网络或未部署）'); return; }
      rowsEl.innerHTML = '';
      var rows = b.rows || [];
      if (rows.length === 0) {
        var e0 = document.createElement('div');
        e0.className = 'sh-mynone';
        e0.textContent = '暂无成绩 —— 今晚榜首虚位以待';
        rowsEl.appendChild(e0);
      }
      rows.forEach(function (row, i) {
        var div = document.createElement('div');
        div.className = 'sh-brow';
        var rk = document.createElement('span');
        rk.className = 'rk' + (i < 3 ? ' top' : '');
        rk.textContent = row.rank;
        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = maskName(row.doer_id);
        var sc = document.createElement('span');
        sc.className = 'sc';
        sc.textContent = row.score;
        div.appendChild(rk); div.appendChild(nm); div.appendChild(sc);
        if (row.prize_ge) {
          var pr = document.createElement('span');
          pr.className = 'pr';
          pr.textContent = '+' + row.prize_ge;
          div.appendChild(pr);
        }
        if (b.me && row.doer_id === b.me.doer_id) div.classList.add('me');
        rowsEl.appendChild(div);
      });
      if (b.me) {
        meEl.innerHTML = '';
        var my = document.createElement('div');
        my.className = 'sh-mynone';
        if (b.me.rank) {
          my.textContent = '你当前：第 ' + b.me.rank + ' 名 · ' + b.me.score + ' 分';
        } else {
          my.textContent = '你今日尚无上榜成绩';
        }
        meEl.appendChild(my);
      }
    });
  }
  function startBoardPoll() {
    stopBoardPoll();
    renderBoard();
    boardTimer = setInterval(renderBoard, 30000);
  }
  function stopBoardPoll() { if (boardTimer) { clearInterval(boardTimer); boardTimer = null; } }

  // ═══════════════════════════════════════════════════════════════
  // 局状态（S = 客户端渲染态；一切真值来自服务器帧）
  // ═══════════════════════════════════════════════════════════════
  var S = {
    runId: null, day: null, ckey: null,
    D: 600,           // 世界高（开局上报, 锁定局内）
    startedAt: 0,     // performance.now() 开局时刻（aliveMs 兜底估算用）
    qxLocal: 150,     // 视觉 qx（本地按键积分, snap 校准）
    qxTruth: 150, hp: 100, score: 0, cd: [0, 0, 0],
    stun: false, invuln: false, alive: true, reviveMs: 0,
    curItems: [], prevItems: [],
    curById: null, prevById: null, // id → item 稳定映射（v2 插值锚点）
    snapAt: 0, snapDelta: 100,     // 上帧到达时刻/间隔（插值 alpha 墙钟基）
    dead: false, over: false,
    holdL: false, holdR: false,
    fx: [],           // {t, dur, kind, x?, n?}
    ws: null, wsRetry: 0, wsRetryTimer: null,
    lastFrameAt: 0,   // 服务器帧超时兜底判定
    reviveWaitEnd: 0, // 本地复活窗超时兜底（performance.now ms）
  };

  function resetGameState() {
    S.qxLocal = S.qxTruth = 150; S.hp = 100; S.score = 0;
    S.cd = [0, 0, 0]; S.stun = false; S.invuln = false;
    S.alive = true; S.dead = false; S.over = false;
    S.reviveMs = 0; S.holdL = false; S.holdR = false;
    S.curItems = []; S.prevItems = [];
    S.curById = null; S.prevById = null;
    S.snapAt = 0; S.snapDelta = 100;
    S.fx = [];
    S.wsRetry = 0;
    kaleidoPhase = {}; // 新局万花筒相位全部重掷
  }

  // ── 画布适配（D 锁定, 窗口变化只等比缩放）──
  function fitScale() {
    var rect = elGame.getBoundingClientRect();
    if (!rect.height) return;
    var s = Math.min(1, rect.height / (S.D + UI_H), rect.width / WORLD_W);
    var ph = (S.D + UI_H) * s;
    // 超高窗口（D 已封顶 4096）→ 画布贴底, 顶部留白（高窗优势 4096 封顶语义）
    elWrap.style.top = Math.max(0, Math.round(rect.height - ph)) + 'px';
    elWrap.style.width = Math.round(WORLD_W * s) + 'px';
    elWrap.style.marginLeft = Math.round(-WORLD_W * s / 2) + 'px';
    elCanvas.style.width = Math.round(WORLD_W * s) + 'px';
  }

  function enterGameView() {
    resetGameState();
    showPage(elGame);
    // 先显示再量（hidden 页面 rect 为 0）
    requestAnimationFrame(function () {
      var rect = elGame.getBoundingClientRect();
      var avail = Math.max(0, rect.height - UI_H);
      var D = Math.min(4096, Math.max(600, Math.round(avail)));
      S.D = D;
      // dpr 高清缓冲（高分屏 1px 细线锐利, 防缩放模糊重影感）
      var dpr = window.devicePixelRatio || 1;
      elCanvas.width = Math.max(2, Math.round(WORLD_W * dpr));
      elCanvas.height = Math.max(2, Math.round((D + UI_H) * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fitScale();
      beginRun();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 开局/终局/复活（REST 钱操作）
  // ═══════════════════════════════════════════════════════════════
  function uuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) { }
    var s = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return s.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  var startBusy = false;
  function beginRun() {
    if (!isLogged()) { setMsg(elMsg, '未登录 —— 请先在主窗口登录'); showPage(elHome); return; }
    if (startBusy) return;
    startBusy = true;
    setMsg(elMsg, '');
    toast('游戏开始 —— 点击画面后按 Q/W 移动');
    var ckey = uuid();
    S.ckey = ckey;
    api('/start', { method: 'POST', body: { ckey: ckey, h: S.D } }).then(function (r) {
      startBusy = false;
      var b = r.body || {};
      if (b.ok === true) {
        S.runId = b.run_id; S.day = b.day;
        S.startedAt = performance.now();
        startGameLoop();
        wsConnect(true);
      } else if (b.code === 'game_active') {
        setMsg(elMsg, '已有进行中的一局（可能开在其它窗口）——请到那局继续或等它结束');
        showPage(elHome);
      } else if (b.code === 'insufficient_ge') {
        setMsg(elMsg, '余额不足 —— 开局需 1 ge');
        showPage(elHome);
      } else if (r.status === 401) {
        setMsg(elMsg, '登录状态已过期 —— 请在主窗口重新登录');
        showPage(elHome);
      } else {
        setMsg(elMsg, '开局失败（' + (b.code || r.status) + '）—— 稍后再试');
        showPage(elHome);
      }
    }).catch(function () {
      startBusy = false;
      setMsg(elMsg, '网络错误 —— 开局失败，请重试（已防重复扣费）');
      showPage(elHome);
    });
  }

  function sendRevive() {
    if (!S.runId) return;
    setMsg(elRvMsg, '');
    var btn = $('sh-revive-yes');
    btn.disabled = true;
    api('/revive', { method: 'POST', body: { run_id: S.runId } }).then(function (r) {
      btn.disabled = false;
      var b = r.body || {};
      if (b.ok === true) {
        setMsg(elRvMsg, '续命成功 —— 满血复活');
      } else if (b.code === 'insufficient_ge') {
        setMsg(elRvMsg, '余额不足 —— 续命需 1 ge');
      } else if (b.code === 'revive_window_closed') {
        setMsg(elRvMsg, '复活窗已过 —— 本局结束');
      } else if (r.status === 401) {
        setMsg(elRvMsg, '登录过期 —— 请在主窗口重新登录后重试');
      } else {
        setMsg(elRvMsg, '续命失败（' + (b.code || r.status) + '）');
      }
    }).catch(function () {
      btn.disabled = false;
      setMsg(elRvMsg, '网络错误 —— 请重试（已防重复扣费）');
    });
  }

  function quitRun() { // 主动弃局
    if (!S.runId) return;
    api('/abort', { method: 'POST', body: { run_id: S.runId } }).then(function () {
      // 服务器下一 tick 终局 → game_over 帧到达后转结算页
      toast('已请求弃局……');
    }).catch(function () {
      toast('弃局请求失败 —— 请重试');
    });
  }

  function showOver(score, aliveMs, revived) {
    S.over = true;
    stopLoop();
    closeWs();
    elRevive.classList.remove('on');
    $('sh-o-score').textContent = score;
    $('sh-o-alive').textContent = fmtAlive(aliveMs);
    $('sh-o-rankline').style.display = 'none';
    $('sh-o-note').textContent = '';
    showPage(elOver);
    // 今日名次 + 榜刷新
    loadBoard().then(function (b) {
      if (!b) return;
      var me = b.me;
      if (me && me.rank && me.rank <= 10) {
        $('sh-o-rankline').style.display = '';
        $('sh-o-rank').textContent = '第 ' + me.rank + ' 名';
        $('sh-o-note').textContent = me.prize_ge ? ('🎉 当前位列发奖区（+' + me.prize_ge + ' ge）—— 以 UTC 日结算为准') : '';
      } else if (me && me.rank) {
        $('sh-o-rankline').style.display = '';
        $('sh-o-rank').textContent = '第 ' + me.rank + ' 名';
        $('sh-o-note').textContent = '再接再厉 —— 日榜前 10 有奖';
      } else {
        $('sh-o-rankline').style.display = 'none';
        $('sh-o-note').textContent = '今日未上榜 —— 再接再厉';
      }
    });
  }

  // 兜底终局：服务器已停发帧（复活窗超时后无 code5 —— 网络断尾等）
  function showOverFallback() {
    var aliveMs = Math.max(0, Math.round(performance.now() - S.startedAt));
    showOver(S.score, aliveMs, false);
    toast('连接中断 —— 以服务器结算为准');
  }

  // ═══════════════════════════════════════════════════════════════
  // WS（遥控杆 + 帧接收; 断线指数退避重连, 60s 服务器放弃窗口内必回）
  // ═══════════════════════════════════════════════════════════════
  function wsConnect(first) {
    if (S.over || !S.runId) return;
    closeWs();
    if (!isLogged()) { wsRetryLater(3000); return; }
    var ws;
    try { ws = new WebSocket(WS_BASE + '?token=' + encodeURIComponent(token())); } catch (_) {
      wsRetryLater(3000); return;
    }
    ws.binaryType = 'arraybuffer';
    S.ws = ws;
    ws.onopen = function () {
      S.wsRetry = 0;
      ws.send(JSON.stringify({ type: 'sub', ch: 'solar:' + S.runId }));
      // 试探: 若局已被服务器放弃（断线过久）→ 回执 err unknown_run → 转结算
      sendInput('r', 0);
      // 重连补发按住状态（断线期间服务器的按键态丢失）
      if (S.holdL) sendInput('l', 1);
      if (S.holdR) sendInput('r', 1);
      if (!first) toast('已重连');
    };
    ws.onmessage = function (e) { handleWsMsg(e.data); };
    ws.onclose = function () {
      if (S.ws !== ws) return;
      S.ws = null;
      if (S.over) return;
      wsRetryLater(Math.min(1000 * Math.pow(2, S.wsRetry++), 8000));
    };
    ws.onerror = function () { /* onclose 接管 */ };
  }
  function wsRetryLater(ms) {
    if (S.wsRetryTimer || S.over) return;
    S.wsRetryTimer = setTimeout(function () {
      S.wsRetryTimer = null;
      wsConnect(false);
    }, ms);
  }
  function closeWs() {
    if (S.wsRetryTimer) { clearTimeout(S.wsRetryTimer); S.wsRetryTimer = null; }
    if (S.ws) {
      var ws = S.ws;
      S.ws = null;
      try { ws.onclose = null; ws.close(); } catch (_) { }
    }
  }

  function handleWsMsg(data) {
    if (S.over) return;
    if (typeof data === 'string') {
      // 服务器文本回执（err 等）
      try {
        var m = JSON.parse(data);
        if (m.type === 'err') {
          if (m.code === 'unknown_run') {
            toast('本局已被服务器结束（离线过久）');
            showOverFallback();
          } else if (m.code === 'login_required') {
            toast('连接登录态失效 —— 重连中……');
            wsConnect(false);
          }
        }
      } catch (_) { }
      return;
    }
    try { parseBinaryFrame(new DataView(data)); }
    catch (e) { /* 帧解析失败丢弃（版本不匹配等） */ }
  }

  function parseBinaryFrame(dv) {
    if (dv.byteLength < 3) return;
    var ver = dv.getUint8(0), type = dv.getUint8(1);
    if (ver !== 2) {
      if (ver === 1) toast('服务器协议过旧 —— 请等待部署完成');
      return;
    }
    S.lastFrameAt = performance.now();
    if (type === 0) parseSnap(dv);
    else if (type === 1) parseEvent(dv);
  }

  function parseSnap(dv) {
    var off = 2;
    var seq = dv.getUint16(off); off += 2;
    var qx = dv.getUint16(off); off += 2;
    var hp = dv.getUint8(off); off += 1;
    var score = dv.getUint16(off); off += 2;
    var cd1 = dv.getUint16(off); off += 2;
    var cd2 = dv.getUint16(off); off += 2;
    var cd3 = dv.getUint16(off); off += 2;
    var flags = dv.getUint8(off); off += 1;
    var alive = dv.getUint8(off) === 1; off += 1;
    var reviveMs = dv.getUint16(off); off += 2;
    var count = dv.getUint8(off); off += 1;
    var items = [], byId = {};
    for (var i = 0; i < count; i++) {
      if (off + 9 > dv.byteLength) break;
      var it = {
        id: dv.getUint16(off + 1),
        kind: dv.getUint8(off),
        x: dv.getUint16(off + 3),
        y: dv.getUint16(off + 5),
        d: dv.getUint8(off + 7),
        ang: dv.getUint8(off + 8),
      };
      items.push(it);
      byId[it.id] = it;
      off += 9;
    }
    // 换帧: 旧 cur → prev 参考; 记到达时刻（插值 alpha = 距此刻墙钟比例）
    var now2 = performance.now();
    S.prevItems = S.curItems;
    S.prevById = S.curById;
    S.curItems = items;
    S.curById = byId;
    S.snapDelta = Math.min(250, Math.max(50, now2 - (S.snapAt || now2 - 100)));
    S.snapAt = now2;
    S.qxTruth = qx;
    if (Math.abs(qx - S.qxLocal) > 12) S.qxLocal = qx; // 偏差超阈值才校准
    S.hp = hp; S.score = score;
    S.cd = [cd1, cd2, cd3];
    S.stun = (flags & 1) !== 0;
    S.invuln = (flags & 2) !== 0;
    if (alive) {
      S.alive = true;
      if (S.dead) { // 续命成功回到场上
        S.dead = false;
        elRevive.classList.remove('on');
        setMsg(elRvMsg, '');
        S.fx.push({ t: performance.now(), dur: 900, kind: 'revive' });
      }
    } else {
      S.alive = false;
      S.reviveMs = reviveMs;
      if (!S.dead) {
        S.dead = true;
        // 显示复活窗
        $('sh-rv-score').textContent = '当前得分 ' + S.score;
        $('sh-revive-yes').disabled = false;
        setMsg(elRvMsg, '');
        elRevive.classList.add('on');
        S.reviveWaitEnd = performance.now() + REVIVE_MS + 4000;
      }
    }
  }

  function parseEvent(dv) {
    var off = 2;
    var code = dv.getUint8(off); off += 1;
    var now = performance.now();
    if (code === 0) { // hit: dmg + hp_remain
      var dmg = dv.getUint8(off);
      var hpRemain = dv.getUint8(off + 1);
      S.hp = hpRemain;
      S.fx.push({ t: now, dur: 420, kind: 'hit', n: dmg });
    } else if (code === 1) { // heal: amt + hp
      var amt = dv.getUint8(off);
      var hpNew = dv.getUint8(off + 1);
      S.hp = hpNew;
      S.fx.push({ t: now, dur: 700, kind: 'heal', n: amt });
    } else if (code === 2) { // score: +n
      var n = dv.getUint16(off);
      S.fx.push({ t: now, dur: 800, kind: 'score', n: n });
    } else if (code === 3) { // skill_ok: skill(1-3) + cleared
      var sk = dv.getUint8(off);
      var cleared = dv.getUint8(off + 1);
      if (sk === 1) S.fx.push({ t: now, dur: 480, kind: 'laser', x: S.qxTruth, n: cleared });
      else if (sk === 2) S.fx.push({ t: now, dur: 700, kind: 'heal', n: 0 });
      else if (sk === 3) S.fx.push({ t: now, dur: 500, kind: 'absorb', n: cleared });
    } else if (code === 4) { // revive_ok
      S.fx.push({ t: now, dur: 900, kind: 'revive' });
    } else if (code === 5) { // game_over: score u16 + alive_ms u32 + revive u8
      if (dv.byteLength >= 10) {
        var gs = dv.getUint16(off);
        var galive = dv.getUint32(off + 2);
        var grev = dv.getUint8(off + 6);
        showOver(gs, galive, grev === 1);
      }
    } else if (code === 8) { // die
      S.fx.push({ t: now, dur: 600, kind: 'die' });
    }
  }

  // ── 上行遥控杆 ──
  function sendInput(k, d) {
    if (!S.ws || S.ws.readyState !== 1 || !S.runId) return;
    try {
      S.ws.send(JSON.stringify({
        type: 'msg', ch: 'solar:' + S.runId,
        text: JSON.stringify({ k: k, d: d })
      }));
    } catch (_) { }
  }

  // ═══════════════════════════════════════════════════════════════
  // 渲染循环（25fps: rAF + 40ms accumulator; 纯展示零逻辑）
  // ═══════════════════════════════════════════════════════════════
  var rafId = 0, lastTs = 0, acc = 0, loopOn = false;

  function startGameLoop() {
    stopLoop();
    lastTs = 0; acc = 0; loopOn = true;
    rafId = requestAnimationFrame(frameTick);
  }
  function stopLoop() {
    loopOn = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }
  function frameTick(ts) {
    if (!loopOn) return;
    rafId = requestAnimationFrame(frameTick);
    if (!lastTs) lastTs = ts;
    var dt = ts - lastTs;
    lastTs = ts;
    if (dt > 300) dt = 300;   // 切走回来/卡顿: 不跳秒
    acc += dt;
    var steps = 0;
    while (acc >= 40 && steps < 6) { stepLocal(0.04); acc -= 40; steps++; }
    if (steps === 6) acc = 0;
    draw();
    tickWatchdogs(dt);
  }

  // 视觉层预测推进（服务器裁决不受影响; 晕中不响应输入）
  function stepLocal(dtS) {
    var dir = 0;
    if (!S.stun) {
      if (S.holdL) dir -= 1;
      if (S.holdR) dir += 1;
    }
    if (dir !== 0) {
      S.qxLocal += dir * Q_SPEED * dtS;
      if (S.qxLocal < Q_R) S.qxLocal = Q_R;
      if (S.qxLocal > WORLD_W - Q_R) S.qxLocal = WORLD_W - Q_R;
    }
  }

  // 服务器帧断尾兜底: 复活窗结束后若长时间无帧（网络断尾）→ 本地结算
  function tickWatchdogs(dt) {
    var now = performance.now();
    if (S.dead && !S.over && now > S.reviveWaitEnd) {
      if (now - S.lastFrameAt > 3200 && S.lastFrameAt > 0) {
        showOverFallback();
      }
    }
  }

  // ── 绘制（alpha 在内部按墙钟算 — 见实体插值注释）──
  function draw() {
    var D = S.D, W = WORLD_W;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, D + UI_H);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, D + UI_H - 1);

    var now = performance.now();
    S.fx = S.fx.filter(function (f) { return now - f.t < f.dur; });

    // 技能特效（画在世界区, 在实体之下）
    drawFxBack(now);

    // 实体插值（v2 按稳定 id 锚定 prev 帧; 新实体直画）
    // ★ alpha 恒为距上帧的墙钟比例 — 曾用 40ms 步进归零的 acc, 实体每 40ms 跳回旧位置再
    //   插回来 = 高频往复, 视觉即用户反馈的「弹幕重影」（2026-09-06 实测反馈根因）
    var al = 1;
    if (S.snapAt) al = Math.min(1, Math.max(0, (now - S.snapAt) / S.snapDelta));
    var prev = S.prevById;
    var c = S.curItems;
    for (var i = 0; i < c.length; i++) {
      var it = c[i];
      var ox = it.x, oy = it.y;
      var pr = prev ? prev[it.id] : null;
      if (pr && pr.kind === it.kind && Math.abs(it.x - pr.x) < 500 && Math.abs(it.y - pr.y) < 700) {
        ox = pr.x + (it.x - pr.x) * al;
        oy = pr.y + (it.y - pr.y) * al;
      }
      drawItem(it, ox, oy);
    }

    drawFxFront(now);
    drawQ(now);
    drawUI(now);

    // 顶部得分（最顶层, 不被实体遮挡）
    ctx.fillStyle = '#000';
    ctx.font = '700 15px Tahoma, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('' + S.score, W / 2, 6);
  }

  function drawItem(it, x, y) {
    var d = Math.max(2, it.d);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    if (it.kind === 3 || it.kind === 4) {
      ctx.lineWidth = 1.2;   // 好物细线
    } else {
      ctx.lineWidth = 2;     // 坏物粗线
    }
    if (it.kind === 0) { // 方
      ctx.strokeRect(x - d / 2, y - d / 2, d, d);
    } else if (it.kind === 1) { // 圆
      ctx.beginPath();
      ctx.arc(x, y, d / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else if (it.kind === 2) { // 三角（尖端朝运动方向, ang: 0-255 → 0-2π, 0=正下）
      var th = (it.ang / 256) * Math.PI * 2;
      var h = d * Math.sqrt(3) / 2;
      var ux = Math.sin(th), uy = Math.cos(th);
      var ex = Math.cos(th), ey = -Math.sin(th);
      var tipX = x + ux * h * 2 / 3, tipY = y + uy * h * 2 / 3;
      var bx = x - ux * h / 3, by = y - uy * h / 3;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(bx + ex * d / 2, by + ey * d / 2);
      ctx.lineTo(bx - ex * d / 2, by - ey * d / 2);
      ctx.closePath();
      ctx.stroke();
    } else if (it.kind === 3) { // 正菱形（好物 +1 分）——马卡龙万花筒填充
      var ph = kaleidoPhase[it.id];
      if (ph === undefined) ph = kaleidoPhase[it.id] = Math.random() * 360; // 随机定格, 不旋转
      // canvas conic 起点 = 3 点钟方向; CSS 原版 from 0deg = 12 点 → 对齐减 90°
      var gr = ctx.createConicGradient((ph - 90) * Math.PI / 180, x, y);
      for (var ki = 0; ki < KALEIDO.length; ki++) {
        gr.addColorStop(ki / KALEIDO.length, KALEIDO[ki]);
        gr.addColorStop((ki + 1) / KALEIDO.length, KALEIDO[ki]); // 同位置双 stop = 硬切扇区
      }
      ctx.fillStyle = gr;
      var r = d * 0.72;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.fillStyle = '#fff'; // 复位, 防污染后续绘制
    } else if (it.kind === 4) { // 心（好物 +25 HP）
      var s = d / 20;
      ctx.beginPath();
      ctx.moveTo(x, y + 6 * s);
      ctx.bezierCurveTo(x - 10 * s, y - 1 * s, x - 6 * s, y - 9 * s, x, y - 3 * s);
      ctx.bezierCurveTo(x + 6 * s, y - 9 * s, x + 10 * s, y - 1 * s, x, y + 6 * s);
      ctx.stroke();
      ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
    }
  }

  function drawQ(now) {
    // 无敌闪烁
    if (S.invuln && Math.floor(now / 90) % 2 === 0 && S.alive) return;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(S.qxLocal, S.D - Q_Y_BASE, Q_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(S.qxLocal - 3.5, S.D - Q_Y_BASE - 3.5, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFxBack(now) {
    S.fx.forEach(function (f) {
      var k = 1 - (now - f.t) / f.dur;
      if (f.kind === 'laser' && k > 0) {
        var x = f.x || S.qxTruth;
        ctx.globalAlpha = 0.55 * k;
        ctx.fillStyle = '#000';
        ctx.fillRect(Math.max(0, x - LASER_W / 2), 24, LASER_W, S.D - 24 - Q_Y_BASE - Q_R);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'absorb' && k > 0) {
        ctx.globalAlpha = 0.22 * k;
        ctx.fillStyle = '#000';
        var top = Math.max(24, S.D - Q_Y_BASE - Q_R - ABSORB_H);
        ctx.fillRect(0, top, WORLD_W, S.D - Q_Y_BASE - Q_R - top);
        ctx.globalAlpha = 1;
      }
    });
  }

  function drawFxFront(now) {
    var qx = S.qxLocal, qy = S.D - Q_Y_BASE;
    S.fx.forEach(function (f) {
      var k = 1 - (now - f.t) / f.dur;
      if (k <= 0) return;
      if (f.kind === 'hit') {
        ctx.globalAlpha = 0.5 * k;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(qx, qy, Q_R + (1 - k) * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'heal') {
        ctx.globalAlpha = Math.min(1, k * 2);
        ctx.fillStyle = '#000';
        ctx.font = '700 15px Tahoma, sans-serif';
        ctx.textAlign = 'center';
        var txt = f.n > 0 ? ('+' + f.n) : '回血';
        ctx.fillText(txt, qx, qy - Q_R - 22 + (1 - k) * 14);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'score') {
        ctx.globalAlpha = Math.min(1, k * 2);
        ctx.fillStyle = '#000';
        ctx.font = '700 14px Tahoma, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('+' + f.n, Math.max(30, Math.min(WORLD_W - 30, qx)), qy + 26 + (1 - k) * 10);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'die') {
        ctx.globalAlpha = 0.6 * k;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(qx, qy, Q_R + (1 - k) * 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'revive') {
        ctx.globalAlpha = 0.5 * k;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(qx, qy, Q_R + (1 - k) * 34, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });
  }

  // ── UI 行（56px: 左 HP 数字 + 右 3 技能槽, 一眼可读充能与 OK）──
  function drawUI(now) {
    var y0 = S.D + 6, x0 = 8;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(2, S.D + 0.5);
    ctx.lineTo(WORLD_W - 2, S.D + 0.5);
    ctx.stroke();

    // HP（受击 420ms 红闪）
    var hitFx = null;
    for (var i = 0; i < S.fx.length; i++) { if (S.fx[i].kind === 'hit') { hitFx = S.fx[i]; break; } }
    var hpRed = hitFx && (now - hitFx.t < 300);
    ctx.fillStyle = hpRed ? '#dc322f' : '#000';
    ctx.font = '700 19px Tahoma, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('HP', x0, y0 + 2);
    ctx.fillText('' + S.hp, x0 + 4, y0 + 23);
    ctx.font = '10px Tahoma, sans-serif';
    ctx.fillStyle = '#888';
    ctx.fillText('Q/W 移', x0, y0 + 45);

    // 技能槽（1/2/3）
    var slotX = [78, 152, 226];
    var slotW = 64, slotH = 44;
    var labels = ['1', '2', '3'];
    for (var s = 0; s < 3; s++) {
      var x = slotX[s], cd = S.cd[s];
      var ok = cd <= 0;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = ok ? 2.5 : 1;
      ctx.strokeRect(x + 0.5, y0 - 1, slotW, slotH + 2);
      // 键号
      ctx.fillStyle = '#888';
      ctx.font = '9px Tahoma, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(labels[s], x + slotW - 4, y0 + 1);
      if (ok) {
        ctx.fillStyle = '#000';
        ctx.font = '700 15px Tahoma, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('OK', x + slotW / 2, y0 + 13);
      } else {
        // 充能: 自下而上黑色填充剩余比例 + 剩余秒
        var remain = Math.max(0, cd);
        var frac = Math.min(1, remain / CD_TOTAL[s]);
        var bh = Math.max(2, Math.round((slotH - 4) * frac));
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#000';
        ctx.fillRect(x + 2, y0 + slotH - 2 - bh, slotW - 4, bh);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.font = '700 14px Tahoma, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Math.ceil(remain / 1000) + 's', x + slotW / 2, y0 + 12);
      }
    }
    // 复活窗倒计时（覆盖层文本由 watchdogs 驱动刷新）
    if (S.dead) {
      var left = Math.max(0, Math.ceil((S.reviveWaitEnd - 4000 - now) / 1000));
      $('sh-rv-cd').textContent = left + 's';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 键盘（仅游戏面板持有焦点时捕获 — iframe 天然焦点隔离）
  // ═══════════════════════════════════════════════════════════════
  var keyMap = { q: 'l', w: 'r' };
  function onKeyDown(e) {
    if (!loopOn || S.over || S.dead) return; // 游戏中才响应移动
    if (e.repeat) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'q' || k === 'w') {
      e.preventDefault();
      var dir = keyMap[k];
      S[dir === 'l' ? 'holdL' : 'holdR'] = true;
      sendInput(dir, 1);
    } else if (k === '1' || k === '2' || k === '3') {
      e.preventDefault();
      sendInput(k, 1);
    }
  }
  function onKeyUp(e) {
    if (!loopOn || S.over) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'q' || k === 'w') {
      e.preventDefault();
      var dir = keyMap[k];
      S[dir === 'l' ? 'holdL' : 'holdR'] = false;
      sendInput(dir, 0);
    }
  }
  function onBlur() {
    // iframe 失焦: 松开一切按键（防幽灵按住）
    if (S.holdL) { S.holdL = false; sendInput('l', 0); }
    if (S.holdR) { S.holdR = false; sendInput('r', 0); }
  }
  function onVis() {
    if (document.hidden) { onBlur(); } else { lastTs = 0; }
  }

  // ═══════════════════════════════════════════════════════════════
  // boot
  // ═══════════════════════════════════════════════════════════════
  function goHome() {
    stopLoop();
    closeWs();
    showPage(elHome);
    startBoardPoll();
    renderBoard();
  }
  function bind() {
    $('sh-start').addEventListener('click', function () {
      setMsg(elMsg, '');
      if (!isLogged()) { setMsg(elMsg, '未登录 —— 请先在主窗口登录'); return; }
      enterGameView();
    });
    $('sh-revive-yes').addEventListener('click', sendRevive);
    $('sh-revive-no').addEventListener('click', function () {
      quitRun(); // REST abort（WS 断线时也可靠）
    });
    $('sh-quit').addEventListener('click', function () {
      if (window.confirm) {
        try {
          if (!window.confirm('确定放弃本局？当前分数仍会记录')) return;
        } catch (_) { }
      }
      quitRun();
    });
    $('sh-again').addEventListener('click', function () {
      goHome(); // 回榜单（本局分数已上榜, 刷新名次）; 再点开局按钮重开
    });
    $('sh-backhome').addEventListener('click', goHome);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', function () {
      if (loopOn) { lastTs = 0; fitScale(); }
    });
    // 点任意处聚焦回画布窗口（点击 iframe 自动聚焦, 此处仅保险）
    document.addEventListener('mousedown', function () { try { window.focus(); } catch (_) { } }, true);
    // 主窗口主题联动（gaea-host syncTheme postMessage）
    window.addEventListener('message', function (e) {
      if (e && e.data && e.data.type === 'qqqide-theme-change') {
        document.documentElement.setAttribute('data-theme', e.data.dark ? 'dark' : 'light');
      }
    });
  }

  function boot() {
    bind();
    goHome();
    // 未登录提示轮询（登录后自动可开局）
    setInterval(function () {
      if (!isLogged()) {
        setMsg(elMsg, '未登录 —— 请先在主窗口登录后再来');
      } else if (elMsg.textContent === '未登录 —— 请先在主窗口登录后再来') {
        setMsg(elMsg, '');
      }
    }, 4000);
    // 主题联动
    try {
      var th = window.parent && window.parent.document && window.parent.document.documentElement
        ? window.parent.document.documentElement.getAttribute('data-theme') : null;
      if (th) document.documentElement.setAttribute('data-theme', th);
    } catch (_) { }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
