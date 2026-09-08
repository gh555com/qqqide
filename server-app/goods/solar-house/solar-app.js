// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/solar-house/solar-app.js — Solar House 客户端（回算架构 v3, 2026-09-06）
//
// 传输模型（设计 §10.3）: 服务器幽灵预生成 10s 场景包（物品逐 tick 轨迹, 1/8px 定点）
//   → 客户端本地镜像 100% 平滑游玩, 零坐标校正（v2 快照纠正机制的彻底删除）。
// 客户端 = 手柄 + 本地镜像: 键入按 1s 一批（10 tick 方向采样 + 技能戳）上传;
//   服务器批驱动权威回算, 回执 = ack/die/revived/over（文本）。死亡→「回算确认」
//   复活窗按服务器裁决; 终局数字一律以回执为准（镜像仅供本地手感）。
// 本地镜像 = 服务器 sim 同公式纯算术复刻（q 运动/吸附/走廊碰撞/面积伤害/技能/冲击波）,
//   仅用于即时反馈; 一切结算以服务器为准。物品世界来自场景包（客户端零生成零物理）。
//
// 二进制包（ver=3, type=2, 大端）:
//   [0-1] 3,2 [2-5] base 绝对 tick u32 [6-7] meta 数 u16
//   meta ×5B: id u16 | kind u8 | d u16(1/8px)
//   之后每 tick(100): count u8 + count×7B: metaIdx u16 | x u16 | y u16 | ang u8 + 尾 1B pulseDmg
// 上行: {"t":"batch","b":起始tick,"s":[10×−1/0/1],"sk":[{k,b}],"p":1,"h":HP×1000,"sc":分数} | {"t":"abort"}
//   p/h/sc = 批末 tick 镜像状态上报 → 服务器事后监督（2026-09-07 用户定案: 服务器零位置校正,
//   只做数据监督: 分数不等或 HP 偏差 >1 即分叉中断本局 over status=5, 成绩作废）
// ============================================================================
(function () {
  'use strict';

  // ⭐ 镜像常量（与服务器 internal/solar 同值同公式; 注释标记 — 仅本地手感, 服务器为真理）
  var W = 300, Q_R = 12, Q_SPEED = 140, QY_PAD = 44, HP_FULL = 100; // Q_SPEED: 2026-09-06 用户手感 200→140（镜像同服务器 param.go QSpeed）
  var LASER_W = 60, LASER_CD = 30, HEAL_AMT = 20, HEAL_CD = 10;
  var ABSORB_R = 600, ABSORB_CD = 30, ABSORB_STUN = 0.5;
  var TRI_STUN = 0.5, HIT_INV = 0.4, REVIVE_INV = 1.0;
  var HEART_HEAL = 25;
  var ATT_K = 27.5, ATT_R0 = 120, ATT_RK = 2.6; // 2026-09-07 用户定案: 吸引力减半（镜像同服务器 param.go AttK）
  var GEO_SQ = 0.7071067811865476, GEO_TRI = 0.5773502691896258;
  var TICK_MS = 100, UI_H = 56, TICKS_PER_BATCH = 10;
  var REVIVE_TICKS = 300;

  // 渲染视觉常量（仅画布展示, 不参与判定）
  var KALEIDO = ['#ff8ba0', '#ffc46b', '#ffe98a', '#8fe8b8', '#8cc9ff', '#d3a6ff'];
  var API_BASE = 'https://cnk.gh555.com/api/solar';
  var WS_BASE = 'wss://cnk.gh555.com/ws';

  // ── DOM ──
  function $(id) { return document.getElementById(id); }
  var elHome = $('sh-home'), elGame = $('sh-game'), elOver = $('sh-over');
  var elWrap = $('sh-wrap'), elCanvas = $('sh-canvas');
  var ctx = elCanvas.getContext('2d');
  var elRevive = $('sh-revive'), elWait = $('sh-wait'), elToast = $('sh-toast');
  var elMsg = $('sh-msg'), elRvMsg = $('sh-rv-msg');
  var toastTimer = null;

  function toast(text) {
    elToast.textContent = text;
    elToast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.classList.remove('on'); }, 3400);
  }
  function setMsg(el, text) { el.textContent = text || ''; }

  function showPage(p) {
    [elHome, elGame, elOver].forEach(function (el) { el.classList.remove('on'); });
    p.classList.add('on');
  }

  // ── auth / REST / 榜（同 v2） ──
  function token() {
    try {
      var w = window.parent;
      while (w && w !== window && !(w.qqqLogin && w.qqqLogin.getAuthToken)) w = w.parent;
      if (w && w.qqqLogin && w.qqqLogin.getAuthToken) return w.qqqLogin.getAuthToken() || '';
    } catch (_) { }
    return '';
  }
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

  var boardTimer = null;
  function boardDay() { return new Date().toISOString().slice(0, 10); }
  function loadBoard() {
    return api('/board?day=' + boardDay()).then(function (r) {
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
  function startBoardPoll() { stopBoardPoll(); renderBoard(); boardTimer = setInterval(renderBoard, 30000); }
  function stopBoardPoll() { if (boardTimer) { clearInterval(boardTimer); boardTimer = null; } }

  // ═══════════════════════════════════════════════════════════════
  // 局状态（v3: 本地镜像; 服务器回执为准）
  // ═══════════════════════════════════════════════════════════════
  var S = {
    runId: null, day: null, ckey: null,
    D: 600,
    phase: 'home',   // home|sync|play|deadWait|revive|waitOver|over
    p0: 0,           // 锚点: tick = floor((now-p0)/100); 隐藏/恢复时冻结世界（服务器同冻结）
    procTick: 0,     // 下一待处理绝对 tick
    wins: [],        // [{base, meta:[{id,kind,d}], frames:[[{id,kind,d,x,y,ang}...]×100], pulse: Uint8Array}]
    // 镜像态
    qx: W / 2, hp: HP_FULL, score: 0, cd: [0, 0, 0],
    stun: 0, invuln: 0, dead: false,
    dieLocalK: -1, deadConf: false, reviveMs: 0, reviveUsed: false,
    holdL: false, holdR: false,
    removedAt: {},  // itemId → tick（镜像移除: 收集/激光/吸收）
    pendSkill: 0,   // bit0..2 待发技能（tick 边界消费）
    recDirs: [], recSk: [], unacked: [],
    // 渲染态
    stT1: null, stT: null, // 连续两 tick 的世界状态 {qx, items:[]}（插值基准）
    fx: [], kaleido: {},
    ws: null, wsRetry: 0, wsRetryTimer: null,
    lastAckK: -1, lastMsgAt: 0,
  };

  function resetGame() {
    S.runId = null; S.day = null; S.ckey = null; // 防旧局残留（ws ch / abort 兜底误用）
    S.qx = W / 2; S.hp = HP_FULL; S.score = 0; S.cd = [0, 0, 0];
    S.stun = 0; S.invuln = 0; S.dead = false;
    S.dieLocalK = -1; S.deadConf = false; S.reviveMs = 0; S.reviveUsed = false;
    S.holdL = false; S.holdR = false;
    S.removedAt = {}; S.pendSkill = 0;
    S.recDirs = []; S.recSk = []; S.unacked = [];
    S.stT1 = null; S.stT = null; S.fx = []; S.kaleido = {};
    S.wins = []; S.p0 = 0; S.procTick = 0;
    S.wsRetry = 0; S.lastAckK = -1;
    elRevive.classList.remove('on');
    elWait.classList.remove('on');
  }

  function qy() { return S.D - QY_PAD; }

  // ── 画布适配 ──
  function fitScale() {
    var rect = elGame.getBoundingClientRect();
    if (!rect.height) return;
    var s = Math.min(1, rect.height / (S.D + UI_H), rect.width / W);
    var ph = (S.D + UI_H) * s;
    elWrap.style.top = Math.max(0, Math.round(rect.height - ph)) + 'px';
    elWrap.style.width = Math.round(W * s) + 'px';
    elWrap.style.marginLeft = Math.round(-W * s / 2) + 'px';
    elCanvas.style.width = Math.round(W * s) + 'px';
  }

  function enterGameView() {
    resetGame();
    startGameLoop(); // ★ 2026-09-06 第二局空白修复: showOver stopLoop 后必须在此重启（boot 只启一次）
    showPage(elGame);
    requestAnimationFrame(function () {
      var rect = elGame.getBoundingClientRect();
      var avail = Math.max(0, rect.height - UI_H);
      S.D = Math.min(4096, Math.max(600, Math.round(avail)));
      var dpr = window.devicePixelRatio || 1;
      elCanvas.width = Math.max(2, Math.round(W * dpr));
      elCanvas.height = Math.max(2, Math.round((S.D + UI_H) * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fitScale();
      beginRun();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 开局 / 终局 / 复活（REST 钱操作）
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
        setPhase('sync'); // 等首批场景包（含 10s+ 余量才开玩）
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
    if (!S.runId || S.phase !== 'revive') return;
    setMsg(elRvMsg, '');
    var btn = $('sh-revive-yes');
    btn.disabled = true;
    api('/revive', { method: 'POST', body: { run_id: S.runId } }).then(function (r) {
      var b = r.body || {};
      if (b.ok === true) {
        setMsg(elRvMsg, '续命请求已确认 —— 等待服务器回算……');
      } else if (b.code === 'insufficient_ge') {
        btn.disabled = false;
        setMsg(elRvMsg, '余额不足 —— 续命需 1 ge');
      } else if (b.code === 'revive_window_closed') {
        btn.disabled = false;
        setMsg(elRvMsg, '复活窗已过 —— 本局结束');
      } else if (r.status === 401) {
        btn.disabled = false;
        setMsg(elRvMsg, '登录过期 —— 请在主窗口重新登录后重试');
      } else {
        btn.disabled = false;
        setMsg(elRvMsg, '续命失败（' + (b.code || r.status) + '）');
      }
    }).catch(function () {
      btn.disabled = false;
      setMsg(elRvMsg, '网络错误 —— 请重试（已防重复扣费）');
    });
  }

  function quitRun() {
    if (!S.runId) return;
    api('/abort', { method: 'POST', body: { run_id: S.runId } }).then(function () {
      toast('已请求弃局……');
      if (S.phase !== 'over') setPhase('waitOver');
    }).catch(function () {
      toast('弃局请求失败 —— 请重试');
    });
  }

  function showOver(score, aliveMs, revived, status) {
    S.phase = 'over';
    stopLoop(); closeWs();
    elRevive.classList.remove('on');
    elWait.classList.remove('on');
    $('sh-o-score').textContent = score;
    $('sh-o-alive').textContent = fmtAlive(aliveMs);
    $('sh-o-rankline').style.display = 'none';
    if (status === 5) {
      // 分叉中断: 服务器零校正直接终局（客户端与服务器状态不一致, 成绩不作记录）
      $('sh-o-title').textContent = '本 局 中 断';
      $('sh-o-note').textContent = '本地与服务器数据不一致 —— 本局成绩未记录（分叉监督）';
      showPage(elOver);
      return;
    }
    $('sh-o-title').textContent = '本 局 结 束';
    $('sh-o-note').textContent = '';
    showPage(elOver);
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

  // 兜底终局（未知局/超时; 以服务器结算为准, 展示本地镜像近似值）
  function showOverFallback(reason) {
    var aliveMs = S.procTick > 0 ? Math.round((S.procTick - (S.dieLocalK > 0 ? 0 : 0)) * TICK_MS) : 0;
    if (S.dieLocalK >= 0) aliveMs = Math.round(S.dieLocalK * TICK_MS);
    showOver(Math.round(S.score), aliveMs, S.reviveUsed);
    toast(reason || '连接中断 —— 以服务器结算为准');
  }

  // ═══════════════════════════════════════════════════════════════
  // 场景包 / 回执（WS）
  // ═══════════════════════════════════════════════════════════════
  function wsConnect(first) {
    if (S.phase === 'over' || !S.runId) return;
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
      // 重连: 补发全部未确认批（幂等, 服务器去重; 技能戳已在批内）
      S.unacked.forEach(function (bk) { sendBatchRaw(bk); });
      if (!first) toast('已重连');
    };
    ws.onmessage = function (e) { handleWsMsg(e.data); };
    ws.onclose = function () {
      if (S.ws !== ws) return;
      S.ws = null;
      if (S.phase === 'over') return;
      wsRetryLater(Math.min(1000 * Math.pow(2, S.wsRetry++), 8000));
    };
    ws.onerror = function () { };
  }
  function wsRetryLater(ms) {
    if (S.wsRetryTimer || S.phase === 'over') return;
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

  function sendBatchRaw(bk) {
    if (!S.ws || S.ws.readyState !== 1) return;
    try {
      S.ws.send(JSON.stringify({
        type: 'msg', ch: 'solar:' + S.runId,
        text: JSON.stringify({ t: 'batch', b: bk.b, s: bk.s, sk: bk.sk || [] })
      }));
    } catch (_) { }
  }

  function handleWsMsg(data) {
    if (S.phase === 'over') return;
    if (typeof data === 'string') {
      try {
        var m = JSON.parse(data);
        if (m.type === 'err') {
          if (m.code === 'unknown_run') {
            toast('本局已被服务器结束（离线过久或已结算）');
            showOverFallback();
          } else if (m.code === 'login_required') {
            toast('连接登录态失效 —— 重连中……');
            wsConnect(false);
          }
          return;
        }
        if (m.type === 'msg' && m.ch === 'solar:' + S.runId && m.data && typeof m.data === 'object' && m.data.ev) {
          handleVerdict(m.data);
        }
      } catch (_) { }
      return;
    }
    try { parsePkt(new DataView(data)); }
    catch (_) { }
  }

  function handleVerdict(v) {
    S.lastMsgAt = Date.now();
    var ev = v.ev;
    if (ev === 'ack') {
      S.lastAckK = v.b;
      // 清已确认批
      S.unacked = S.unacked.filter(function (bk) { return bk.b + TICKS_PER_BATCH > v.b; });
      // 权威状态轻同步（只动数字, 永不纠正 q 坐标 —— 无弹回）
      S.hp = v.alive === 1 ? Math.min(HP_FULL, Math.max(0, v.hp)) : Math.min(S.hp, 0);
      if (v.alive === 0 && !S.dead && v.db > 0) {
        // 服务器先于镜像判死（镜像偏差边缘）→ 进入回算死态
        onServerDeath(v.db, v.score, v.revive_ms);
      } else if (v.alive === 1 && S.dead && S.phase === 'deadWait') {
        // 服务器未判死而镜像判死（偏差边缘）→ 复活修正
        S.dead = false; S.deadConf = false;
        S.hp = v.hp; S.invuln = 0.6;
        setPhase('play');
        toast('网络修正 —— 继续');
      }
    } else if (ev === 'die') {
      onServerDeath(v.b, v.score, v.revive_ms);
    } else if (ev === 'revived') {
      S.dead = false; S.deadConf = false; S.reviveUsed = true;
      S.hp = HP_FULL; S.invuln = REVIVE_INV; S.pendSkill = 0;
      setPhase('play');
      S.fx.push({ t: performance.now(), dur: 900, kind: 'revive' });
      toast('续命成功 —— 满血复活');
    } else if (ev === 'over') {
      showOver(v.score, v.alive_ms, !!v.revive_used, v.status);
    }
  }

  // 服务器死亡裁决 → 回算确认 UI
  function onServerDeath(b, score, reviveMs) {
    S.dead = true; S.deadConf = true;
    S.dieLocalK = Math.max(S.dieLocalK, b);
    S.hp = 0;
    if (score !== undefined && score !== null) S.score = score;
    S.reviveMs = reviveMs;
    if (S.reviveUsed) { // 已续命过 → 直接终局（服务器稍后回 over）
      setPhase('waitOver');
      return;
    }
    setPhase('revive');
    $('sh-rv-score').textContent = '当前得分 ' + S.score;
    $('sh-revive-yes').disabled = false;
    setMsg(elRvMsg, '');
  }

  // ═══════════════════════════════════════════════════════════════
  // 场景包解析 / 窗口管理
  // ═══════════════════════════════════════════════════════════════
  function parsePkt(dv) {
    if (dv.byteLength < 10) return;
    var ver = dv.getUint8(0), type = dv.getUint8(1);
    if (ver !== 3) {
      if (ver < 3) toast('服务器协议过旧 —— 请等待部署完成');
      return;
    }
    if (type !== 2) return;
    var off = 2;
    var base = dv.getUint32(off); off += 4;
    if (base < S.procTick - 200) return; // 过期包丢弃
    var nMeta = dv.getUint16(off); off += 2;
    var meta = [];
    for (var i = 0; i < nMeta; i++) {
      var id = dv.getUint16(off);
      var kind = dv.getUint8(off + 2);
      var d = dv.getUint16(off + 3) / 8;
      meta.push({ id: id, kind: kind, d: d });
      off += 5;
    }
    var frames = [];
    var pulse = new Uint8Array(TICKS_PER_BATCH * 10); // 100
    for (var t = 0; t < 100; t++) {
      var cnt = dv.getUint8(off); off += 1;
      var rows = [];
      for (var j = 0; j < cnt && off + 7 <= dv.byteLength; j++) {
        var mi = dv.getUint16(off);
        var x = dv.getUint16(off + 2) / 8;
        var y = dv.getUint16(off + 4) / 8;
        var ang = dv.getUint8(off + 6);
        off += 7;
        if (mi < meta.length) {
          rows.push({ id: meta[mi].id, kind: meta[mi].kind, d: meta[mi].d, x: x, y: y, ang: ang });
        }
      }
      frames.push(rows);
      if (off < dv.byteLength) {
        pulse[t] = dv.getUint8(off);
        off += 1;
      }
    }
    // 去重插入（同 base 重发丢弃）
    for (var w = 0; w < S.wins.length; w++) {
      if (S.wins[w].base === base) return;
    }
    S.wins.push({ base: base, meta: meta, frames: frames, pulse: pulse });
    S.wins.sort(function (a, b2) { return a.base - b2.base; });
    dropOldWins();
    maybeStartPlay();
  }

  function dropOldWins() {
    while (S.wins.length > 6) S.wins.shift();
    while (S.wins.length > 0 && S.wins[0].base + 100 <= S.procTick - 10) S.wins.shift();
  }

  function winFor(t) {
    for (var i = S.wins.length - 1; i >= 0; i--) {
      var wn = S.wins[i];
      if (t >= wn.base && t < wn.base + 100) return wn;
    }
    return null;
  }

  // 开场: 拥有覆盖 0 的窗口 + 至少一个后续窗口（≥10s 余量）才开玩
  function maybeStartPlay() {
    if (S.phase !== 'sync' || !S.runId) return;
    var w0 = winFor(0);
    var next = winFor(100);
    if (!w0 || !next) return;
    S.procTick = 0;
    S.p0 = performance.now();
    setPhase('play');
  }

  function setPhase(p) {
    S.phase = p;
    elRevive.classList.remove('on');
    elWait.classList.remove('on');
    if (p === 'sync') {
      $('sh-wait-title').textContent = '同步中……';
      $('sh-wait-sub').textContent = '正在接收场景包（10 秒级网络也能本地顺畅游玩）';
      elWait.classList.add('on');
    } else if (p === 'deadWait') {
      $('sh-wait-title').textContent = '回算确认中……';
      $('sh-wait-sub').textContent = '已击落 —— 服务器正在复算本局';
      elWait.classList.add('on');
    } else if (p === 'waitOver') {
      $('sh-wait-title').textContent = '回算中……';
      $('sh-wait-sub').textContent = '服务器正在结算本局';
      elWait.classList.add('on');
    } else if (p === 'revive') {
      elRevive.classList.add('on');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 本地镜像（10Hz tick; 与服务器 sim 同公式; 纯本地手感, 服务器回算为准）
  // ═══════════════════════════════════════════════════════════════
  function geoR(kind, d) {
    if (kind === 0) return d * GEO_SQ;
    if (kind === 2) return d * GEO_TRI;
    return d * 0.5;
  }

  function diskOverlap(dd, r1, r2) {
    if (dd >= r1 + r2 || dd <= 0) {
      if (dd <= 0) return Math.PI * Math.min(r1, r2) * Math.min(r1, r2);
      return 0;
    }
    if (dd <= Math.abs(r1 - r2)) {
      var am = Math.min(r1, r2);
      return Math.PI * am * am;
    }
    var arg1 = (dd * dd + r1 * r1 - r2 * r2) / (2 * dd * r1);
    var arg2 = (dd * dd + r2 * r2 - r1 * r1) / (2 * dd * r2);
    if (arg1 < -1) arg1 = -1;
    if (arg1 > 1) arg1 = 1;
    if (arg2 < -1) arg2 = -1;
    if (arg2 > 1) arg2 = 1;
    var term = (-dd + r1 + r2) * (dd + r1 - r2) * (dd - r1 + r2) * (dd + r1 + r2);
    if (term < 0) term = 0;
    return r1 * r1 * Math.acos(arg1) + r2 * r2 * Math.acos(arg2) - 0.5 * Math.sqrt(term);
  }

  function visibleRow(id, k) { return !(S.removedAt[id] !== undefined && S.removedAt[id] <= k); }

  // 处理一个绝对 tick; 返回 false = 数据不足（暂停）
  function processTick(k) {
    var wn = winFor(k);
    if (!wn) return false;
    var idx = k - wn.base;
    if (idx < 0 || idx >= 100) return false;
    var curRows = wn.frames[idx];
    var pwn = winFor(k - 1);
    var prevRows = pwn ? pwn.frames[(k - 1) - pwn.base] : null;

    // ── timers（镜像服务器 stepTimers）──
    S.cd[0] = Math.max(0, S.cd[0] - 0.1);
    S.cd[1] = Math.max(0, S.cd[1] - 0.1);
    S.cd[2] = Math.max(0, S.cd[2] - 0.1);
    S.stun = Math.max(0, S.stun - 0.1);
    S.invuln = Math.max(0, S.invuln - 0.1);

    // ── 键入采样（本 tick 方向; 死态强制 0）──
    var dir = 0;
    if (!S.dead && S.stun <= 0 && (S.phase === 'play')) {
      if (S.holdL) dir -= 1;
      if (S.holdR) dir += 1;
    }
    S.recDirs.push(dir);

    // ── q 运动（镜像服务器 stepPlayer: 恒速 + 圆吸附; QxP 前置）──
    var qPrev = S.qx;
    if (!S.dead && S.stun <= 0 && dir !== 0) {
      S.qx += dir * Q_SPEED * 0.1;
    }
    if (!S.dead && S.stun <= 0 && prevRows) {
      var drift = 0;
      for (var i = 0; i < prevRows.length; i++) {
        var it0 = prevRows[i];
        if (it0.kind !== 1 || !visibleRow(it0.id, k - 1)) continue;
        var R = ATT_R0 + ATT_RK * it0.d;
        var dx = it0.x - S.qx;
        var dy = it0.y - qy();
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > R) continue;
        var f = 1 - dist / R;
        var sz = it0.d / 24;
        if (sz > 3) sz = 3;
        var sgn = dx < 0 ? -1 : 1;
        drift += ATT_K * sz * f * sgn;
      }
      var driftCap = 0.6 * Q_SPEED; // 与服务器 AttDriftCap 同式: 吸附只迟滞移动, 永不反向压过键入
      if (drift > driftCap) drift = driftCap;
      if (drift < -driftCap) drift = -driftCap;
      S.qx += drift * 0.1;
    }
    if (S.qx < Q_R) S.qx = Q_R;
    if (S.qx > W - Q_R) S.qx = W - Q_R;

      // ── 冲击波（服务器 applyPulses 位于技能前: 激光不可防; 无视无敌; 跳过死/幽灵）──
    var pd = wn.pulse[idx];
    if (pd > 0 && !S.dead) {
      S.hp -= pd;
      S.fx.push({ t: performance.now(), dur: 420, kind: 'hit', n: pd, pulse: true });
      if (S.hp <= 0) {
        S.hp = 0; S.dead = true;
        S.dieLocalK = k;
        S.fx.push({ t: performance.now(), dur: 600, kind: 'die' });
        setPhase('deadWait');
      }
    }

    // ── 技能（镜像服务器 fireSkills: tick 边界; curRows = 移动后位置）──
    var sk = S.pendSkill;
    S.pendSkill = 0;
    if (!S.dead) {
      if ((sk & 1) !== 0 && S.cd[0] <= 0) {
        S.cd[0] = LASER_CD;
        var cleared = 0;
        for (var li = 0; li < curRows.length; li++) {
          var lit = curRows[li];
          if (lit.kind <= 2 && Math.abs(lit.x - S.qx) <= LASER_W) {
            if (S.removedAt[lit.id] === undefined || S.removedAt[lit.id] > k) { cleared++; }
            S.removedAt[lit.id] = k;
          }
        }
        S.fx.push({ t: performance.now(), dur: 480, kind: 'laser', x: S.qx, n: cleared });
      }
      if ((sk & 2) !== 0 && S.cd[1] <= 0) {
        S.cd[1] = HEAL_CD;
        S.hp = Math.min(HP_FULL, S.hp + HEAL_AMT);
        S.fx.push({ t: performance.now(), dur: 700, kind: 'heal', n: HEAL_AMT });
      }
      if ((sk & 4) !== 0 && S.cd[2] <= 0) {
        S.cd[2] = ABSORB_CD;
        if (S.stun < ABSORB_STUN) S.stun = ABSORB_STUN;
        var qyy = qy();
        var got = 0;
        for (var ai = 0; ai < curRows.length; ai++) {
          var ait = curRows[ai];
          if (ait.kind === 3 && ait.y <= qyy && ait.y >= qyy - ABSORB_R) {
            if (S.removedAt[ait.id] === undefined || S.removedAt[ait.id] > k) { got++; }
            S.removedAt[ait.id] = k;
          }
        }
        if (got > 0) {
          S.score += got;
          S.fx.push({ t: performance.now(), dur: 800, kind: 'score', n: got });
        }
        S.fx.push({ t: performance.now(), dur: 500, kind: 'absorb', n: got });
      }
    }

    // ── 走廊碰撞 + 拾取（镜像服务器 collide; 跳过 removedAt ≤ k）──
    if (!S.dead && curRows) {
      var qyy2 = qy();
      for (var ci = 0; ci < curRows.length; ci++) {
        var it = curRows[ci];
        if (S.removedAt[it.id] !== undefined && S.removedAt[it.id] <= k) continue;
        var Rc = geoR(it.kind, it.d);
        // 上一 tick 位置（新物品: prev = 自身）
        var px = it.x, py = it.y;
        if (prevRows) {
          for (var pj = 0; pj < prevRows.length; pj++) {
            if (prevRows[pj].id === it.id) { px = prevRows[pj].x; py = prevRows[pj].y; break; }
          }
        }
        var yLo = Math.min(py, it.y), yHi = Math.max(py, it.y);
        if (yHi < qyy2 - Q_R - Rc || yLo > qyy2 + Q_R + Rc) continue;
        // 相对走廊最近点（服务器同式）
        var ax = px - qPrev, ay = py - qyy2;
        var bx = it.x - S.qx, by = it.y - qyy2;
        var ddx = bx - ax, ddy = by - ay;
        var d2 = ddx * ddx + ddy * ddy;
        var tt = 0;
        if (d2 > 0) {
          tt = -(ax * ddx + ay * ddy) / d2;
          if (tt < 0) tt = 0;
          if (tt > 1) tt = 1;
        }
        var ex = ax + ddx * tt, ey = ay + ddy * tt;
        var dd = Math.sqrt(ex * ex + ey * ey);
        var reach = Q_R + Rc;
        if (dd > reach) continue;
        if (it.kind === 3) { // 菱形 +1
          S.score += 1;
          S.removedAt[it.id] = k;
          S.fx.push({ t: performance.now(), dur: 800, kind: 'score', n: 1 });
          continue;
        }
        if (it.kind === 4) { // 心 +25
          S.hp = Math.min(HP_FULL, S.hp + HEART_HEAL);
          S.removedAt[it.id] = k;
          S.fx.push({ t: performance.now(), dur: 700, kind: 'heal', n: HEART_HEAL });
          continue;
        }
        if (S.invuln > 0) continue; // 无敌穿行
        var ov = diskOverlap(dd, Q_R, Rc);
        var aQ = Math.PI * Q_R * Q_R;
        var aI = Math.PI * Rc * Rc;
        var minA = Math.min(aQ, aI);
        var qQ = ov / minA;
        if (qQ < 0.3) qQ = 0.3;
        if (qQ > 1) qQ = 1;
        var ss = it.d / 24;
        if (ss > 5) ss = 5;
        var baseT = it.kind === 0 ? 14 : 10; // 镜像同服务器 typeDamage（2026-09-07 用户定案 攻击力减半）
        var dmg = baseT * ss * qQ;
        S.hp -= dmg;
        if (it.kind === 2) S.stun = TRI_STUN;
        S.invuln = HIT_INV;
        S.fx.push({ t: performance.now(), dur: 420, kind: 'hit', n: Math.round(dmg) });
        if (S.hp <= 0) {
          S.hp = 0; S.dead = true;
          S.dieLocalK = k;
          S.fx.push({ t: performance.now(), dur: 600, kind: 'die' });
          setPhase('deadWait');
          break;
        }
      }
    }

    // ── 渲染态推进 ──
    if (S.stT) S.stT1 = S.stT;
    var items = [];
    for (var ri = 0; ri < curRows.length; ri++) {
      var row = curRows[ri];
      if (row.y < 0 || !visibleRow(row.id, k)) continue;
      items.push({ id: row.id, kind: row.kind, d: row.d, x: row.x, y: row.y, ang: row.ang });
    }
    S.stT = { qx: S.qx, items: items, tick: k };

    // ── 技能记录 + 批发送 ──
    var batchedSk = [];
    while (S.recSk.length > 0 && S.recSk[0].b <= k) {
      var ev2 = S.recSk.shift();
      if (ev2.b >= k - 9) batchedSk.push(ev2);
    }
    if ((k + 1) % TICKS_PER_BATCH === 0) {
      var b0 = k - TICKS_PER_BATCH + 1;
      var dirs = S.recDirs.slice(-TICKS_PER_BATCH);
      if (dirs.length === TICKS_PER_BATCH) {
        var bk = { b: b0, s: dirs, sk: batchedSk, p: 1,
          h: Math.max(0, Math.round(S.hp * 1000)), sc: S.score }; // 批末 tick 镜像状态（监督用）
        S.unacked.push(bk);
        sendBatchRaw(bk);
      }
    }
    return true;
  }

  // 技能按键 → 记入下一 tick 边界施放（镜像 + 服务器同 tick）
  function castSkill(k) {
    if (S.phase !== 'play' || S.dead) return;
    var bit = 1 << (k - 1);
    if ((S.cd[k - 1] > 0)) return; // 冷却中
    S.pendSkill |= bit;
    S.recSk.push({ k: k, b: S.procTick });
  }

  // ═══════════════════════════════════════════════════════════════
  // 主循环（rAF; 墙钟锚点驱动 tick; 隐藏=世界冻结, 服务器同冻结）
  // ═══════════════════════════════════════════════════════════════
  var rafId = 0, lastTs = 0, loopOn = false, tickAcc = 0;

  function startGameLoop() {
    stopLoop();
    lastTs = 0; loopOn = true;
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
    if (dt > 300) dt = 300;
    tickAcc += dt;
    if (S.p0 > 0 && (S.phase === 'play' || S.phase === 'deadWait' || S.phase === 'revive' || S.phase === 'waitOver')) {
      var targetK = Math.floor((performance.now() - S.p0) / TICK_MS);
      var guard = 0;
      while (S.procTick <= targetK && guard < 12) {
        if (!processTick(S.procTick)) break;
        S.procTick++;
        guard++;
      }
      // 数据断供 → 同步态（世界暂停; 服务器也随批暂停, 无偏差）
      if (S.procTick <= targetK && guard >= 12 && winFor(S.procTick) === null) {
        if (S.phase === 'play') setPhase('sync');
      } else if (S.phase === 'sync' && winFor(S.procTick)) {
        S.p0 = performance.now() - S.procTick * TICK_MS;
        setPhase(S.dead ? 'deadWait' : 'play');
      }
    }
    draw(performance.now());
    tickWatchdogs();
  }

  // 复活窗倒计时兜底 / 无回执超时
  function tickWatchdogs() {
    var now = Date.now();
    if (S.phase === 'revive' && S.deadConf) {
      var leftMs = S.reviveMs - Math.max(0, S.procTick - S.dieLocalK) * TICK_MS;
      if (leftMs <= 0) { setPhase('waitOver'); }
    }
    if (S.phase === 'waitOver' && S.dead && !S.deadConf && now - S.lastMsgAt > 15000) {
      showOverFallback('回算超时 —— 以服务器结算为准');
    }
    if (S.phase === 'revive' && now - S.lastMsgAt > 20000 && S.wsRetry > 3) {
      showOverFallback('连接中断 —— 以服务器结算为准');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 渲染（25fps+; 状态插值: stT1 → stT, alpha 墙钟）
  // ═══════════════════════════════════════════════════════════════
  function draw(now) {
    var D = S.D;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, D + UI_H);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, D + UI_H - 1);

    S.fx = S.fx.filter(function (f) { return now - f.t < f.dur; });
    drawFxBack(now);
    drawPulseWarns(now);

    // 世界插值（stT1 → stT）
    var a = 1;
    var stA = S.stT1, stB = S.stT;
    if (!stA) { stA = stB; a = 0; }
    else if (stB) a = Math.min(1, Math.max(0, (now - (S.p0 + stB.tick * TICK_MS)) / TICK_MS + 1));
    if (stA && stB) {
      var byId = {};
      for (var i = 0; i < stA.items.length; i++) byId[stA.items[i].id] = stA.items[i];
      for (var j = 0; j < stB.items.length; j++) {
        var it = stB.items[j];
        var pr = byId[it.id];
        var x = it.x, y = it.y;
        if (pr && Math.abs(it.x - pr.x) < 600 && Math.abs(it.y - pr.y) < 800) {
          x = pr.x + (it.x - pr.x) * a;
          y = pr.y + (it.y - pr.y) * a;
        }
        drawItem(it, x, y);
      }
      // q（本地镜像位置; 死态不画）
      if (!S.dead && stB.qx !== undefined) {
        var qxR = stB.qx;
        if (stA.qx !== undefined) qxR = stA.qx + (stB.qx - stA.qx) * a;
        drawQ(now, qxR);
      }
    }

    drawFxFront(now);
    drawUI(now);
    ctx.fillStyle = '#000';
    ctx.font = '700 15px Tahoma, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('' + S.score, W / 2, 6);
  }

  // 冲击波预警: 最近 10 tick 内到达的波 → 顶部横扫线（纯视觉, 伤害由镜像在 At tick 结算）
  function drawPulseWarns(now) {
    if (!S.stT || S.phase === 'over') return;
    var curK = S.stT.tick;
    for (var wi = 0; wi < S.wins.length; wi++) {
      var wn = S.wins[wi];
      for (var t = 0; t < 100; t++) {
        var dmg = wn.pulse[t];
        if (!dmg) continue;
        var at = wn.base + t;
        var ahead = at - curK;
        if (ahead < 0 || ahead > 10) continue;
        var frac = 1 - ahead / 10;
        var yy = Math.min(S.D - QY_PAD - Q_R, Math.max(0, frac * (S.D - QY_PAD - Q_R)));
        ctx.globalAlpha = 0.35 * (0.3 + 0.7 * frac);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(2, yy);
        ctx.lineTo(W - 2, yy);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawItem(it, x, y) {
    var d = Math.max(2, it.d);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = (it.kind === 3 || it.kind === 4) ? 1.2 : 2;
    if (it.kind === 0) {
      ctx.strokeRect(x - d / 2, y - d / 2, d, d);
    } else if (it.kind === 1) {
      // 吸附范围虚线圈（2026-09-07 用户定案: 第二层虚线圆 = 吸引力范围, R = 服务器 AttR0+AttRk×d 同式）
      var attR = ATT_R0 + ATT_RK * d;
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, attR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, d / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else if (it.kind === 2) {
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
    } else if (it.kind === 3) {
      var ph = S.kaleido[it.id];
      if (ph === undefined) ph = S.kaleido[it.id] = Math.random() * 360;
      var gr = ctx.createConicGradient((ph - 90) * Math.PI / 180, x, y);
      for (var ki = 0; ki < KALEIDO.length; ki++) {
        gr.addColorStop(ki / KALEIDO.length, KALEIDO[ki]);
        gr.addColorStop((ki + 1) / KALEIDO.length, KALEIDO[ki]);
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
      ctx.fillStyle = '#fff';
    } else if (it.kind === 4) {
      var s = d / 20;
      ctx.beginPath();
      ctx.moveTo(x, y + 6 * s);
      ctx.bezierCurveTo(x - 10 * s, y - 1 * s, x - 6 * s, y - 9 * s, x, y - 3 * s);
      ctx.bezierCurveTo(x + 6 * s, y - 9 * s, x + 10 * s, y - 1 * s, x, y + 6 * s);
      ctx.stroke();
      ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
    }
  }

  function drawQ(now, qxR) {
    if (S.invuln > 0 && Math.floor(now / 90) % 2 === 0) return;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(qxR, qy(), Q_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(qxR - 3.5, qy() - 3.5, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFxBack(now) {
    S.fx.forEach(function (f) {
      var kk = 1 - (now - f.t) / f.dur;
      if (f.kind === 'laser' && kk > 0) {
        ctx.globalAlpha = 0.55 * kk;
        ctx.fillStyle = '#000';
        ctx.fillRect(Math.max(0, (f.x || S.qx) - 60), 24, 120, S.D - 24 - QY_PAD - Q_R);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'absorb' && kk > 0) {
        ctx.globalAlpha = 0.22 * kk;
        ctx.fillStyle = '#000';
        var top = Math.max(24, S.D - QY_PAD - Q_R - ABSORB_R);
        ctx.fillRect(0, top, W, S.D - QY_PAD - Q_R - top);
        ctx.globalAlpha = 1;
      }
    });
  }

  function drawFxFront(now) {
    var qxR = S.stT ? S.stT.qx : S.qx, qyy = qy();
    S.fx.forEach(function (f) {
      var kk = 1 - (now - f.t) / f.dur;
      if (kk <= 0) return;
      if (f.kind === 'hit') {
        ctx.globalAlpha = 0.5 * kk;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = f.pulse ? 3 : 2;
        ctx.beginPath();
        ctx.arc(qxR, qyy, Q_R + (1 - kk) * (f.pulse ? 44 : 26), 0, Math.PI * 2);
        ctx.stroke();
        if (f.pulse) {
          ctx.beginPath();
          ctx.moveTo(2, qyy);
          ctx.lineTo(W - 2, qyy);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else if (f.kind === 'heal') {
        ctx.globalAlpha = Math.min(1, kk * 2);
        ctx.fillStyle = '#000';
        ctx.font = '700 15px Tahoma, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('+' + f.n, qxR, qyy - Q_R - 22 + (1 - kk) * 14);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'score') {
        ctx.globalAlpha = Math.min(1, kk * 2);
        ctx.fillStyle = '#000';
        ctx.font = '700 14px Tahoma, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('+' + f.n, Math.max(30, Math.min(W - 30, qxR)), qyy + 26 + (1 - kk) * 10);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'die') {
        ctx.globalAlpha = 0.6 * kk;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(qxR, qyy, Q_R + (1 - kk) * 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'revive') {
        ctx.globalAlpha = 0.5 * kk;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(qxR, qyy, Q_R + (1 - kk) * 34, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });
  }

  function drawUI(now) {
    var y0 = S.D + 6, x0 = 8;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(2, S.D + 0.5);
    ctx.lineTo(W - 2, S.D + 0.5);
    ctx.stroke();

    var hitFx = null;
    for (var i = 0; i < S.fx.length; i++) { if (S.fx[i].kind === 'hit') { hitFx = S.fx[i]; break; } }
    var hpRed = hitFx && (now - hitFx.t < 300);
    ctx.fillStyle = hpRed ? '#dc322f' : '#000';
    ctx.font = '700 19px Tahoma, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('HP', x0, y0 + 2);
    ctx.fillText('' + Math.max(0, Math.round(S.hp)), x0 + 4, y0 + 23);
    ctx.font = '10px Tahoma, sans-serif';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText('Q/W 移', x0, y0 + 45);

    var slotX = [78, 152, 226], slotW = 64, slotH = 44;
    var labels = ['1', '2', '3'];
    var cdT = [LASER_CD, HEAL_CD, ABSORB_CD];
    for (var s = 0; s < 3; s++) {
      var x = slotX[s], cd = S.cd[s];
      var ok = cd <= 0;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = ok ? 2.5 : 1;
      ctx.strokeRect(x + 0.5, y0 - 1, slotW, slotH + 2);
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
        var frac = Math.min(1, cd / cdT[s]);
        var bh = Math.max(2, Math.round((slotH - 4) * frac));
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#000';
        ctx.fillRect(x + 2, y0 + slotH - 2 - bh, slotW - 4, bh);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.font = '700 14px Tahoma, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Math.ceil(cd) + 's', x + slotW / 2, y0 + 12);
      }
    }
    // 复活窗倒计时（权威裁决后）
    if (S.phase === 'revive' && S.deadConf) {
      var leftMs = S.reviveMs - Math.max(0, S.procTick - S.dieLocalK) * TICK_MS;
      $('sh-rv-cd').textContent = Math.max(0, Math.ceil(leftMs / 1000)) + 's';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 键盘（仅游戏面板持焦点; iframe 天然隔离）
  // ═══════════════════════════════════════════════════════════════
  var keyMap = { q: 'l', w: 'r' };
  function onKeyDown(e) {
    if (S.phase !== 'play' || S.dead) return;
    if (e.repeat) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'q' || k === 'w') {
      e.preventDefault();
      var dir = keyMap[k];
      S[dir === 'l' ? 'holdL' : 'holdR'] = true;
    } else if (k === '1' || k === '2' || k === '3') {
      e.preventDefault();
      castSkill(parseInt(k, 10));
    }
  }
  function onKeyUp(e) {
    if (S.phase === 'over') return;
    var k = (e.key || '').toLowerCase();
    if (k === 'q' || k === 'w') {
      e.preventDefault();
      var dir = keyMap[k];
      S[dir === 'l' ? 'holdL' : 'holdR'] = false;
    }
  }
  function onBlur() {
    S.holdL = false; S.holdR = false;
  }
  function onVis() {
    if (document.hidden) {
      onBlur();
    } else if (S.p0 > 0 && S.procTick >= 0 && (S.phase === 'play' || S.phase === 'deadWait' || S.phase === 'revive' || S.phase === 'waitOver')) {
      // 返回: 冻结期间世界暂停（服务器同冻结于批驱动）→ 锚点重对齐, 零追赶零偏差
      S.p0 = performance.now() - S.procTick * TICK_MS;
    }
    lastTs = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // boot
  // ═══════════════════════════════════════════════════════════════
  function goHome() {
    stopLoop(); closeWs();
    showPage(elHome);
    startBoardPoll();
  }
  function bind() {
    $('sh-start').addEventListener('click', function () {
      setMsg(elMsg, '');
      if (!isLogged()) { setMsg(elMsg, '未登录 —— 请先在主窗口登录'); return; }
      stopBoardPoll();
      enterGameView();
    });
    $('sh-revive-yes').addEventListener('click', sendRevive);
    $('sh-revive-no').addEventListener('click', function () { quitRun(); });
    $('sh-quit').addEventListener('click', function () {
      if (window.confirm) {
        try { if (!window.confirm('确定放弃本局？当前分数仍会记录')) return; } catch (_) { }
      }
      quitRun();
    });
    $('sh-again').addEventListener('click', function () { goHome(); });
    $('sh-backhome').addEventListener('click', goHome);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', function () {
      if (loopOn) { lastTs = 0; fitScale(); }
    });
    document.addEventListener('mousedown', function () { try { window.focus(); } catch (_) { } }, true);
    window.addEventListener('message', function (e) {
      if (e && e.data && e.data.type === 'qqqide-theme-change') {
        document.documentElement.setAttribute('data-theme', e.data.dark ? 'dark' : 'light');
      }
    });
  }

  function boot() {
    bind();
    goHome();
    startGameLoop(); // 常驻 rAF（home 页 draw 亦可用; 空场景零开销）
    setInterval(function () {
      if (!isLogged()) {
        setMsg(elMsg, '未登录 —— 请先在主窗口登录后再来');
      } else if (elMsg.textContent === '未登录 —— 请先在主窗口登录后再来') {
        setMsg(elMsg, '');
      }
    }, 4000);
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
