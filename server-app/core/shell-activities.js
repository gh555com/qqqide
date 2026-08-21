// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-activities.js — 状态栏双活动豆腐块
//
// ① 清爽从2026（qqq-act-cool）：总消费（实扣+白嫖）0→10 ge 进度条
//    hover 瞬间弹出自定义文字框「清爽从2026」
//    点击 → 拼多多式活动弹窗（两阶段：未满 / 已满）→ 加 QQ 群 524906522 领 10 元红包
// ② 原料与基本权利（qqq-act-ge50）：总消费 0→50 ge 进度条
//    点击 → 任务清单弹窗（下载登录 ✓ / 消费50ge ✓ / 充值门槛(可配置,0=隐藏) / 二选一领取行）
//    领取：50 元话费（人工发放 ~2 工作日）或 50 ge（立即到账），二者二选一互斥
// ③ 2026, 我, vibe coding（qqq-act-vibe）：循环免费窗口豆腐块
//    免费时段（UTC）：周日全天 + 每日 01:00-03:00 / 13:00-15:00
//    进度条 = 随机免费余额剩余比例；数字 = 免费中显示余额 / 非免费显示距下次倒计时
//    点击 → 活动弹窗（余额 + 免费结束倒计时 + 距离下次免费 + 时段说明）
//
// 数据源: GET  /api/qqqide/activity             （登录）
//         POST /api/qqqide/activity/claim-ge50
//         POST /api/qqqide/activity/claim-phone50
// 消费定义与服务器 LV/排行榜同一真理源（实扣=doer_lv_seasons，白嫖=doer_free_budgets）
// ============================================================================

function bootActivities(boot) {
  'use strict';

  // F40: 与登录页同域（能打开登录页就能拉到数据）
  var API_BASE = 'https://gh555.com/api';
  // ★ 2026-08-07: 双线路 failover — 5xx/网络错误时降级 direct-cn 国内直连
  var API_BASE_FALLBACK = 'https://direct-cn.gh555.com/api';
  async function _apiFetch(path, opts) {
    var urls = [API_BASE, API_BASE_FALLBACK];
    var lastErr = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var resp = await fetch(urls[i] + path, opts);
        if (resp.status < 500) return resp;
        lastErr = 'HTTP ' + resp.status;
      } catch (e) { lastErr = e.message; }
    }
    if (lastErr) console.warn('[activities] _apiFetch all lines failed:', path, lastErr);
    return null;
  }
  var POLL_MS = 60000;
  var QQ_GROUP = '524906522';

  var _data = null;        // 服务端活动状态
  var _lastFetch = 0;
  var _fetching = false;
  var _tipEl = null;       // 自定义即时 hover 文字框
  var _overlay = null;     // 弹窗容器（复用单例）

  var $cool = document.getElementById('qqq-act-cool');
  var $ge50 = document.getElementById('qqq-act-ge50');
  var $coolFill = document.getElementById('qqq-act-cool-fill');
  var $coolNum = document.getElementById('qqq-act-cool-num');
  var $ge50Fill = document.getElementById('qqq-act-ge50-fill');
  var $ge50Num = document.getElementById('qqq-act-ge50-num');
  var $vibe = document.getElementById('qqq-act-vibe');
  var $vibeFill = document.getElementById('qqq-act-vibe-fill');
  var $vibeNum = document.getElementById('qqq-act-vibe-num');
  var $vibeName = null;    // 「2026, 我, vibe coding」名称 — 免费窗口内替换为「剩余/预算」数字
  var $vibePrefix = null; // 「剩/距下次」前缀 — 独立于等宽数字，与赞助商文字同外观
  if (!$cool || !$ge50) return;

  // ── 工具 ──────────────────────────────────────────────────────────────────
  function t(key, fb) {
    try { return window._i ? window._i(key, fb) : fb; } catch (e) { return fb; }
  }

  // 带 {param} 插值的翻译（_i 不处理插值，需直调 i18n.t）
  function tp(key, params, fb) {
    try {
      if (window.i18n && window.i18n.t) {
        var r = window.i18n.t(key, params);
        if (r && r !== key) return r;
      }
    } catch (e) { }
    return fb;
  }

  function isLoggedIn() {
    try { return !!(window.qqqLogin && window.qqqLogin.isLoggedIn()); } catch (e) { return false; }
  }

  function authToken() {
    try { return (window.qqqLogin && window.qqqLogin.getAuthToken()) || ''; } catch (e) { return ''; }
  }

  function qoast(msg, type, duration) {
    try {
      if (window.qqqideQoast && window.qqqideQoast.show) {
        window.qqqideQoast.show(msg, { duration: duration || 4000, type: type || 'info' });
      }
    } catch (e) { }
  }

  function fmt(v) {
    var n = parseFloat(v);
    if (isNaN(n)) return '0';
    return (Math.round(n * 100) / 100).toString();
  }

  // 1 位小数四舍五入（vibe 豆腐块免费窗口内数字）
  function fmt1(v) {
    var n = parseFloat(v);
    if (isNaN(n)) return '0';
    return (Math.round(n * 10) / 10).toString();
  }

  // 手机号脱敏：前5位 + 星号 + 后4位（8615802858204 → 86158****8204），方便用户截图自证
  function maskPhone(p) {
    if (!p) return '';
    var s = String(p);
    if (s.length <= 8) return s;
    return s.slice(0, 5) + '****' + s.slice(-4);
  }

  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve, function () { legacyCopy(text); resolve(); });
      } else { legacyCopy(text); resolve(); }
    });
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { }
  }

  function openLogin() {
    try { if (window.qqqLogin && window.qqqLogin.login) window.qqqLogin.login(); } catch (e) { }
  }

  // ── 数据拉取 ──────────────────────────────────────────────────────────────
  function fetchStatus(force) {
    var now = Date.now();
    if (!force && now - _lastFetch < POLL_MS) return;
    if (_fetching) return;
    _lastFetch = now;
    var token = authToken();
    if (!token) { _data = null; render(); return; }
    _fetching = true;
    _apiFetch('/qqqide/activity', {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-cache'
    })
      .then(function (r) {
        if (r.status === 401) { _data = null; render(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (data && data.ok) { _data = data; render(); }
      })
      .catch(function () { /* 静默，保留上次数据 */ })
      .finally(function () { _fetching = false; });
  }

  // ── 渲染进度条 ────────────────────────────────────────────────────────────
  function render() {
    var cons = (_data && _data.consumption) || {};
    var cool = (_data && _data.cool2026) || {};
    var g50 = (_data && _data.ge50) || {};
    var total = parseFloat(cons.total_ge) || 0;

    // 清爽从2026
    var coolTarget = parseFloat(cool.target_ge) || 10;
    var coolPct = Math.max(0, Math.min(100, total / coolTarget * 100));
    if ($coolFill) $coolFill.style.width = coolPct + '%';
    if ($coolNum) $coolNum.textContent = fmt(total) + '/' + coolTarget;
    if ($cool) $cool.classList.toggle('qqq-act-done', !!cool.reached);

    // 原料与基本权利
    var g50Target = parseFloat(g50.target_ge) || 50;
    var g50Pct = Math.max(0, Math.min(100, total / g50Target * 100));
    if ($ge50Fill) $ge50Fill.style.width = g50Pct + '%';
    if ($ge50Num) $ge50Num.textContent = fmt(total) + '/' + g50Target;
    if ($ge50) $ge50.classList.toggle('qqq-act-done', !!g50.reached);
  }

  // ── 自定义即时 hover 文字框 ───────────────────────────────────────────────
  function showTip(e, text) {
    if (!_tipEl) {
      _tipEl = document.createElement('div');
      _tipEl.className = 'qqq-act-tip';
      document.body.appendChild(_tipEl);
    }
    _tipEl.textContent = text;
    _tipEl.style.left = (e.clientX - _tipEl.offsetWidth / 2) + 'px';
    _tipEl.style.top = (e.clientY - _tipEl.offsetHeight - 8) + 'px';
    _tipEl.style.display = '';
  }

  function hideTip() { if (_tipEl) _tipEl.style.display = 'none'; }

  // ── 弹窗基础设施（单例 overlay） ──────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById('qqq-act-style')) return;
    var st = document.createElement('style');
    st.id = 'qqq-act-style';
    st.textContent =
      '.qqq-act-overlay{position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.55);animation:qqqActFade .18s ease;}' +
      '@keyframes qqqActFade{from{opacity:0}to{opacity:1}}' +
      '@keyframes qqqActPop{from{transform:scale(.86);opacity:0}to{transform:scale(1);opacity:1}}' +
      '@keyframes qqqActShimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}' +
      '@keyframes qqqActFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}' +
      '.qqq-act-modal{position:relative;width:520px;max-width:94vw;max-height:86vh;overflow-y:auto;border-radius:16px;' +
      'background:linear-gradient(165deg,#0d1a12 0%,#0d0d1a 55%,#10131f 100%);color:#e6e6e6;' +
      'border:1.5px solid rgba(52,211,153,.35);box-shadow:0 0 34px rgba(52,211,153,.22),0 10px 40px rgba(0,0,0,.5);' +
      'animation:qqqActPop .28s cubic-bezier(.34,1.56,.64,1);padding:26px 28px 24px;forced-color-adjust:none;}' +
      '.qqq-act-modal.qqq-act-ge50-modal{background:linear-gradient(165deg,#141b2e 0%,#0d0d1a 60%,#1a1024 100%);' +
      'border-color:rgba(217,100,92,.4);box-shadow:0 0 34px rgba(217,100,92,.25),0 10px 40px rgba(0,0,0,.5);forced-color-adjust:none;}' +
      // 原料弹窗全窗淡红主题（2026-08-09 定案）：标题/数字/高亮/关闭/CTA 全部归位淡红 #d9645c，消灭绿色残留
      '.qqq-act-modal.qqq-act-ge50-modal h2{background:linear-gradient(135deg,#d9645c,#e28c85);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}' +
      '.qqq-act-modal.qqq-act-ge50-modal .qqq-act-bignum{color:#d9645c;}' +
      '.qqq-act-modal.qqq-act-ge50-modal .qqq-act-desc b{color:#e28c85;}' +
      '.qqq-act-modal.qqq-act-ge50-modal .qqq-act-close:hover{background:rgba(217,100,92,.25);border-color:#d9645c;}' +
      '.qqq-act-modal.qqq-act-ge50-modal .qqq-act-cta{background:linear-gradient(90deg,#d9645c,#c9554e);box-shadow:0 4px 18px rgba(217,100,92,.4);}' +
      '.qqq-act-close{position:absolute;top:10px;right:12px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.18);' +
      'background:rgba(255,255,255,.08);color:#ddd;font-size:15px;line-height:26px;text-align:center;}' +
      '.qqq-act-close:hover{background:rgba(52,211,153,.25);border-color:#34d399;}' +
      '.qqq-act-modal h2{margin:2px 0 2px;font-size:26px;font-weight:900;text-align:center;' +
      'background:linear-gradient(135deg,#34d399,#06b6d4);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}' +
      '.qqq-act-modal .qqq-act-sub{margin:0 0 14px;text-align:center;font-size:13px;color:#9aa0b5;}' +
      '.qqq-act-modal .qqq-act-csub{margin:12px 0 18px;line-height:1.7;text-align:center;font-size:17px;font-weight:700;color:#34d399;}' +
      '.qqq-act-bigbar{margin:14px 0 6px;height:16px;border-radius:9px;background:rgba(255,255,255,.2);overflow:hidden;position:relative;forced-color-adjust:none;}' +
      '.qqq-act-bigfill{display:block;height:100%;border-radius:9px;' +
      'background:linear-gradient(90deg,#2aa198,#859900,#2aa198);background-size:200% 100%;animation:qqqActShimmer 2.4s linear infinite;' +
      'transition:width .8s;forced-color-adjust:none;}' +
      // 弹窗进度条配色与状态区豆腐块一一对应（2026-08-09 清爽↔vibe 互换；原料 2026-08-09 橙金→纯色淡红 #d9645c 无渐变）: 清爽=绿黄 / 原料=淡红纯色 / vibe=蓝
      '.qqq-act-bigfill.qqq-act-cool-fill{background:linear-gradient(90deg,#2aa198,#859900,#2aa198);background-size:200% 100%;}' +
      '.qqq-act-bigfill.qqq-act-ge50-fill{background:#d9645c;}' +
      '.qqq-act-bigfill.qqq-act-vibe-fill{background:linear-gradient(90deg,#268bd2,#2aa198,#268bd2);background-size:200% 100%;}' +
      '.qqq-act-bigfill.qqq-act-full{background:linear-gradient(90deg,#859900,#b58900,#859900);background-size:200% 100%;animation:qqqActShimmer 1.2s linear infinite;}' +
      '.qqq-act-bigfill.qqq-act-cool-fill.qqq-act-full{background:linear-gradient(90deg,#859900,#b58900,#859900);animation:qqqActShimmer 1.2s linear infinite;}' +
      '.qqq-act-bigfill.qqq-act-ge50-fill.qqq-act-full{background:#d9645c;}' +
      '.qqq-act-bignum{text-align:center;font-size:15px;font-weight:700;color:#34d399;font-family:Consolas,monospace;}' +
      '.qqq-act-desc{margin:14px 0 18px;text-align:center;font-size:14px;line-height:1.9;color:#c8c8d8;}' +
      '.qqq-act-desc b{color:#34d399;}' +
      // 免费时段行：UTC 版 2 秒后渐隐 → 切换用户系统时区版渐显固定（2026-08-20）
      '.qqq-act-desc .qqq-act-tzswap{display:inline-block;transition:opacity .6s ease;forced-color-adjust:none;}' +
      '.qqq-act-desc .qqq-act-tzswap.qqq-act-faded{opacity:0;}' +

      // 前8次免费窗口充能框 v7（2026-08-20）：单行 8 个 54×28 圆角矩形 + 标题行总统计（已用合计/额度合计）；
      //   内部仅数字=摇出额度；填充 = 充能（剩余比例，满=该窗口没用过）；hover 瞬间弹出框只显示实际已用额度
      //   ★ v7: 参照 ctx-btn 双层 background 模式（ai-panel/index.html #ctx-btn）——上层硬切点遮罩
      //     linear-gradient(to right, transparent var(--pct), 空区色 var(--pct)) + 下层全宽固定渐变（左偏蓝→右偏黄）
      //     颜色恒定不随填充长度压缩，且无额外遮罩 DOM（v6 的 .qqq-vibe-hist-empty 缺 width → 遮罩宽度 0 全部满格，已废弃）
      //     边框 vibe 蓝（F58 误改绿已还原）；数字去阴影纯白；标题行样式恢复 F57 删除前版本（12.5px / 700 / #8fa3c8 / margin 0 0 8px）
      '.qqq-vibe-hist{margin:10px 0 2px;}' +
      '.qqq-vibe-hist-title{margin:0 0 8px;font-size:12.5px;font-weight:700;color:#8fa3c8;text-align:center;forced-color-adjust:none;}' +
      '.qqq-vibe-hist-row{display:flex;gap:4px;justify-content:center;flex-wrap:nowrap;}' +
      '.qqq-vibe-hist-item{flex:0 0 54px;width:54px;height:28px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;' +
      'border-radius:8px;border:1px solid rgba(63,150,216,.55);' +
      'background:linear-gradient(to right,transparent var(--pct,0%),rgba(10,12,20,.8) var(--pct,0%)),' +
      'linear-gradient(90deg,rgba(42,161,152,.85) 0%,rgba(133,153,0,.8) 100%);forced-color-adjust:none;}' +
      '.qqq-vibe-hist-num{position:relative;font-size:15px;font-weight:800;color:#fff;font-family:Consolas,monospace;line-height:1;}' +
      '.qqq-act-cta{display:block;width:100%;padding:12px 0;border:none;border-radius:10px;font-size:16px;font-weight:800;' +
      'background:linear-gradient(90deg,#059669,#0d9488);color:#fff;box-shadow:0 4px 18px rgba(5,150,105,.4);forced-color-adjust:none;}' +
      '.qqq-act-cta:hover{filter:brightness(1.12);}' +
      '.qqq-act-cta.qqq-act-ghost{background:rgba(255,255,255,.1);color:#cfd3e6;box-shadow:none;font-weight:600;font-size:13px;margin-top:10px;}' +
      '.qqq-act-celebrate{text-align:center;font-size:52px;animation:qqqActFloat 2s ease-in-out infinite;}' +
      // 任务清单（50ge）
      '.qqq-act-tasks{list-style:none;margin:8px 0 4px;padding:0;}' +
      '.qqq-act-task{display:flex;align-items:center;gap:10px;padding:9px 12px;margin-bottom:8px;border-radius:9px;' +
      'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);font-size:13.5px;color:#d8d8e4;}' +
      '.qqq-act-task .qqq-act-check{flex:0 0 20px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
      'font-size:12px;font-weight:900;border:1.5px solid #5a6078;color:#5a6078;}' +
      '.qqq-act-task.qqq-act-task-done{border-color:rgba(133,153,0,.45);}' +
      '.qqq-act-task.qqq-act-task-done .qqq-act-check{border-color:#859900;background:#859900;color:#0d0d0d;}' +
      '.qqq-act-task.qqq-act-task-locked{opacity:.55;}' +
      '.qqq-act-task.qqq-act-task-recharge{transition:background .15s,border-color .15s;}' +
      '.qqq-act-task.qqq-act-task-recharge:hover{background:rgba(217,100,92,.14);border-color:#d9645c;}' +
      '.qqq-act-task .qqq-act-task-go{margin-left:auto;font-size:12px;font-weight:800;color:#d9645c;white-space:nowrap;}' +
      '.qqq-act-task .qqq-act-task-now{font-size:11.5px;color:#9aa0b5;white-space:nowrap;}' +
      '.qqq-act-or{text-align:center;font-size:12px;font-weight:700;color:#b58900;margin:4px 0 6px;}' +
      '.qqq-act-claims{display:flex;gap:10px;margin-top:0;}' +
      '.qqq-act-claim{flex:1;padding:11px 6px;border:none;border-radius:10px;font-size:13.5px;font-weight:800;color:#fff;' +
      'background:#d9645c;box-shadow:0 4px 14px rgba(217,100,92,.3);forced-color-adjust:none;}' +
      '.qqq-act-claim.qqq-act-claim-phone{background:linear-gradient(90deg,#268bd2,#2aa198);box-shadow:0 4px 14px rgba(38,139,210,.3);forced-color-adjust:none;}' +
      '.qqq-act-claim:disabled{filter:grayscale(1);opacity:.55;box-shadow:none;}' +
      '.qqq-act-claim:hover:not(:disabled){filter:brightness(1.1);}' +
      
      '.qqq-act-modal2{position:relative;width:420px;max-width:90vw;border-radius:14px;padding:26px 26px 22px;text-align:center;' +
      'background:linear-gradient(165deg,#10131f,#0d0d1a);color:#e6e6e6;border:1.5px solid rgba(52,211,153,.4);' +
      'box-shadow:0 0 30px rgba(52,211,153,.2);animation:qqqActPop .25s cubic-bezier(.34,1.56,.64,1);forced-color-adjust:none;}' +
      '.qqq-act-modal2 h3{margin:0 0 8px;font-size:19px;color:#34d399;}' +
      '.qqq-act-modal2 p{margin:0 0 18px;font-size:13.5px;line-height:1.8;color:#c8c8d8;word-break:break-all;}' +
      '.qqq-act-modal2 button{padding:9px 34px;border:none;border-radius:9px;font-size:14px;font-weight:700;color:#fff;' +
      'background:linear-gradient(90deg,#059669,#0d9488);}';
    document.head.appendChild(st);
  }

  function closeOverlay() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
    document.removeEventListener('keydown', escHandler);
  }

  function escHandler(e) { if (e.key === 'Escape') closeOverlay(); }

  function openOverlay(innerHtml, modalClass) {
    ensureStyle();
    closeOverlay();
    _overlay = document.createElement('div');
    _overlay.className = 'qqq-act-overlay';
    _overlay.innerHTML =
      '<div class="qqq-act-modal ' + (modalClass || '') + '">' +
      '<button class="qqq-act-close" title="' + t('common.close', '关闭') + '">✕</button>' +
      innerHtml +
      '</div>';
    document.body.appendChild(_overlay);
    _overlay.addEventListener('click', function (e) { if (e.target === _overlay) closeOverlay(); });
    _overlay.querySelector('.qqq-act-close').addEventListener('click', closeOverlay);
    document.addEventListener('keydown', escHandler);
    _overlay._esc = escHandler;
    return _overlay;
  }

  // ── 二次确认弹窗 ──────────────────────────────────────────────────────────
  function openConfirm(title, desc, btnText, onOk) {
    ensureStyle();
    closeOverlay();
    _overlay = document.createElement('div');
    _overlay.className = 'qqq-act-overlay';
    _overlay.innerHTML =
      '<div class="qqq-act-modal2">' +
      '<h3>' + title + '</h3>' +
      '<p>' + desc + '</p>' +
      '<button id="qqq-act-ok">' + (btnText || t('common.ok', '好')) + '</button>' +
      '</div>';
    document.body.appendChild(_overlay);
    _overlay.addEventListener('click', function (e) { if (e.target === _overlay) closeOverlay(); });
    _overlay.querySelector('#qqq-act-ok').addEventListener('click', function () {
      closeOverlay();
      if (onOk) onOk();
    });
    document.addEventListener('keydown', escHandler);
  }

  // ── 弹窗一：清爽从2026（两阶段） ─────────────────────────────────────────
  function copyQqGroup() {
    copyText(QQ_GROUP).then(function () {
      qoast(t('act.cool.copied', 'QQ 群号 524906522 已复制，去 QQ 搜索加群'), 'success', 5000);
    });
  }

  function openCoolPopup() {
    if (!isLoggedIn()) {
      openOverlay(
        '<h2>🧊 ' + t('act.cool.name', '清爽从2026') + '</h2>' +
        '<p class="qqq-act-sub">' + t('act.cool.popSub', '总消费满 10 ge 领 10 元红包') + '</p>' +
        '<p class="qqq-act-desc">' + t('act.cool.loginDesc', '登录后查看消费进度，进度条充满即可领 10 元红包') + '</p>' +
        '<button class="qqq-act-cta" id="qqq-act-login">' + t('act.ge50.loginBtn', '登录') + '</button>'
      );
      _overlay.querySelector('#qqq-act-login').addEventListener('click', function () { closeOverlay(); openLogin(); });
      return;
    }

    var cons = (_data && _data.consumption) || {};
    var cool = (_data && _data.cool2026) || {};
    var total = parseFloat(cons.total_ge) || 0;
    var target = parseFloat(cool.target_ge) || 10;
    var reached = !!cool.reached;
    var pct = Math.max(0, Math.min(100, total / target * 100));
    var phone = (_data && _data.phone) || '';

    var html;
    if (!reached) {
      // ★ 阶段一：未满
      html =
        '<div class="qqq-act-celebrate">🧊</div>' +
        '<h2>' + t('act.cool.name', '清爽从2026') + '</h2>' +
        '<p class="qqq-act-sub">' + t('act.cool.popSub', '总消费满 10 ge 领 10 元红包') + '</p>' +
        '<div class="qqq-act-bigbar"><span class="qqq-act-bigfill qqq-act-cool-fill" style="width:' + pct + '%"></span></div>' +
        '<div class="qqq-act-bignum">' + fmt(total) + ' / ' + target + ' ge</div>' +
        '<p class="qqq-act-desc">' +
        t('act.cool.p1', '进度条充满 = 总消费达到 <b>10 ge</b>（实扣 + 白嫖都算）！<br>即便全部白嫖，只要进度条充满，现在就可以加 QQ 群 <b>524906522</b> 领 <b>10 元红包</b>。') +
        '</p>' +
        '<button class="qqq-act-cta" id="qqq-act-copy">' + t('act.cool.copyGroup', '加 QQ 群 524906522 领 10 元红包') + '</button>';
    } else {
      // ★ 阶段二：已满 → 庆祝
      html =
        '<div class="qqq-act-celebrate">🎉</div>' +
        '<h2>' + tp('act.cool.p2Title', { phone: maskPhone(phone) }, '恭喜！' + maskPhone(phone) + ' 充能已满') + '</h2>' +
        '<p class="qqq-act-csub">' + t('act.cool.p2Subtitle', '从2026开始，更轻，更快') + '</p>' +
        '<p class="qqq-act-sub">' + t('act.cool.popSub', '总消费满 10 ge 领 10 元红包') + '</p>' +
        '<div class="qqq-act-bigbar"><span class="qqq-act-bigfill qqq-act-cool-fill qqq-act-full" style="width:100%"></span></div>' +
        '<div class="qqq-act-bignum">' + fmt(total) + ' / ' + target + ' ge ✓</div>' +
        '<p class="qqq-act-desc">' +
        t('act.cool.p2', '你的总消费已达 <b>10 ge</b>（含白嫖）！<br>现在就可以加 QQ 群 <b>524906522</b> 领 <b>10 元红包</b>。') +
        '</p>' +
        '<button class="qqq-act-cta" id="qqq-act-copy">' + t('act.cool.copyGroup2', '复制群号 524906522 去加群') + '</button>';
    }
    openOverlay(html);
    _overlay.querySelector('#qqq-act-copy').addEventListener('click', copyQqGroup);
  }

  // ── 弹窗二：原料与基本权利（任务清单） ──────────────────────────────────
  function claimGe50() {
    var g = _data && _data.ge50;
    if (!g || !g.claimable || g.claimed_ge50 || g.claimed_phone50) return;
    var token = authToken();
    if (!token) { openLogin(); return; }
    _apiFetch('/qqqide/activity/claim-ge50', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          if (data.already) {
            // 二选一已锁定：静默同步双方 claimed，两按钮置灰（不再弹 qoast）
            if (_data && _data.ge50) {
              _data.ge50.claimed_ge50 = true;
              if (data.other_claimed) _data.ge50.claimed_phone50 = true;
            }
            render();
            fetchStatus(true);
            return;
          }
          if (_data && _data.ge50) _data.ge50.claimed_ge50 = true;
          render();
          openConfirm(
            t('act.ge50.geModalTitle', '50 ge 立即到账'),
            t('act.ge50.geModalDesc', '50 ge 已发放到你的账户，立即到账！'),
            t('common.ok', '好')
          );
          fetchStatus(true);
        } else {
          qoast(t('act.ge50.err', '领取失败，请稍后重试'), 'error');
        }
      })
      .catch(function () { qoast(t('act.ge50.err', '领取失败，请稍后重试'), 'error'); });
  }

  function claimPhone50() {
    var g = _data && _data.ge50;
    if (!g || !g.claimable || g.claimed_phone50 || g.claimed_ge50) return;
    var token = authToken();
    if (!token) { openLogin(); return; }
    _apiFetch('/qqqide/activity/claim-phone50', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          if (data.already) {
            // 二选一已锁定：静默同步双方 claimed，两按钮置灰（不再弹 qoast）
            if (_data && _data.ge50) {
              _data.ge50.claimed_phone50 = true;
              if (data.other_claimed) _data.ge50.claimed_ge50 = true;
            }
            render();
            fetchStatus(true);
            return;
          }
          if (_data && _data.ge50) _data.ge50.claimed_phone50 = true;
          render();
          var phone = (data && data.phone) || (_data && _data.phone) || '';
          openConfirm(
            t('act.ge50.phoneModalTitle', '50 元话费'),
            tp('act.ge50.phoneModalDesc', { phone: phone }, '话费将在 2 个工作日内自动到账，请保持手机号 ' + phone + ' 畅通。'),
            t('common.ok', '好')
          );
          fetchStatus(true);
        } else {
          qoast(t('act.ge50.err', '领取失败，请稍后重试'), 'error');
        }
      })
      .catch(function () { qoast(t('act.ge50.err', '领取失败，请稍后重试'), 'error'); });
  }

  function openGe50Popup() {
    if (!isLoggedIn()) {
      openOverlay(
        '<h2>🎁 ' + t('act.ge50.name', '原料与基本权利') + '</h2>' +
        '<p class="qqq-act-sub">' + t('act.ge50.popSub', '总消费满 50 ge 领 50 元话费或 50 ge') + '</p>' +
        '<p class="qqq-act-desc">' + t('act.ge50.loginDesc', '登录后查看任务进度，满 50 ge 即可领取') + '</p>' +
        '<button class="qqq-act-cta" id="qqq-act-login">' + t('act.ge50.loginBtn', '登录') + '</button>',
        'qqq-act-ge50-modal'
      );
      _overlay.querySelector('#qqq-act-login').addEventListener('click', function () { closeOverlay(); openLogin(); });
      return;
    }

    var cons = (_data && _data.consumption) || {};
    var g = (_data && _data.ge50) || {};
    var cfg = (_data && _data.config) || {};
    var total = parseFloat(cons.total_ge) || 0;
    var target = parseFloat(g.target_ge) || 50;
    var pct = Math.max(0, Math.min(100, total / target * 100));
    var reqYuan = parseFloat(cfg.recharge_required_yuan) || 0;
    var rechargeOk = !!g.recharge_ok;
    var claimable = !!g.claimable;
    var claimedGe = !!g.claimed_ge50;
    var claimedPhone = !!g.claimed_phone50;
    var phone = (_data && _data.phone) || '';

    var tasks =
      '<li class="qqq-act-task qqq-act-task-done"><span class="qqq-act-check">✓</span>' +
      t('act.ge50.task1', '下载并登录 qqqide') + '</li>' +

      '<li class="qqq-act-task ' + (total >= target ? 'qqq-act-task-done' : 'qqq-act-task-locked') + '">' +
      '<span class="qqq-act-check">' + (total >= target ? '✓' : '') + '</span>' +
      t('act.ge50.task2', '总消费达到 50 ge（实扣 + 白嫖合计）') + ' · ' + fmt(total) + '/' + target +
      '</li>';

    // ★ 第三行：充值门槛（服务器配置 >0 才显示；当前 0 = 隐藏，直接到领取行）
    // 未充值 → 整行可点击，直达网站充值卡片（gh555.com/viewer/geflow?recharge=N，自动弹赞助卡+预选金额）
    if (reqYuan > 0) {
      tasks +=
        '<li id="qqq-act-task-recharge" class="qqq-act-task ' + (rechargeOk ? 'qqq-act-task-done' : 'qqq-act-task-locked qqq-act-task-recharge') + '" ' +
        (rechargeOk ? '' : 'title="' + t('act.ge50.task3GoTitle', '点击去充值') + '"') + '>' +
        '<span class="qqq-act-check">' + (rechargeOk ? '✓' : '') + '</span>' +
        tp('act.ge50.task3', { yuan: reqYuan }, '累计充值满 ' + reqYuan + ' 元') +
        (rechargeOk ? '' :
          '<span class="qqq-act-task-go">' + t('act.ge50.task3Go', '去充值 →') + '</span>') +
        '</li>';
    }

    var claims =
      '<div class="qqq-act-or">' + t('act.ge50.eitherOr', '二选一') + '</div>' +
      '<div class="qqq-act-claims">' +
      '<button class="qqq-act-claim qqq-act-claim-phone" id="qqq-act-claim-phone" ' +
      (claimable && !claimedPhone && !claimedGe ? '' : 'disabled') + '>' +
      (phone ? phone + '<br>' : '') + (claimedPhone ? t('act.ge50.claimPhoneClaimed', '额外再领取 50 元话费 · 已领取') : t('act.ge50.claimPhone', '额外再领取 50 元话费')) +
      '</button>' +
      '<button class="qqq-act-claim" id="qqq-act-claim-ge" ' +
      (claimable && !claimedGe && !claimedPhone ? '' : 'disabled') + '>' +
      (claimedGe ? t('act.ge50.claimGeClaimed', '额外再领取 50 ge · 已领取') : t('act.ge50.claimGe', '额外再领取 50 ge')) +
      '</button>' +
      '</div>';

    var html =
      '<div class="qqq-act-celebrate">🎁</div>' +
      '<h2>' + t('act.ge50.name', '原料与基本权利') + '</h2>' +
      '<p class="qqq-act-csub">' + t('act.ge50.subtitle', '你滴上下文资产现在归你') + '</p>' +
      '<p class="qqq-act-sub">' + t('act.ge50.popSub', '实扣 + 白嫖合计达到 50 ge 即可领取') + '</p>' +
      '<div class="qqq-act-bigbar"><span class="qqq-act-bigfill qqq-act-ge50-fill' + (total >= target ? ' qqq-act-full' : '') + '" style="width:' + pct + '%"></span></div>' +
      '<div class="qqq-act-bignum">' + fmt(total) + ' / ' + target + ' ge</div>' +
      '<ul class="qqq-act-tasks">' + tasks + '</ul>' +
      claims;

    openOverlay(html, 'qqq-act-ge50-modal');
    var $ph = _overlay.querySelector('#qqq-act-claim-phone');
    var $ge = _overlay.querySelector('#qqq-act-claim-ge');
    if ($ph) $ph.addEventListener('click', claimPhone50);
    if ($ge) $ge.addEventListener('click', claimGe50);
    // ★ 充值门槛行点击 → 网站充值卡片直达（自动弹赞助卡 + 预选 ¥{reqYuan}，广告页豁免）
    var $task3 = _overlay.querySelector('#qqq-act-task-recharge');
    if ($task3 && !rechargeOk) {
      $task3.addEventListener('click', function () {
        var url = 'https://gh555.com/viewer/geflow?lang=zh&recharge=' + reqYuan;
        if (window.qqqideBridge && window.qqqideBridge.shell && window.qqqideBridge.shell.openExternal) {
          window.qqqideBridge.shell.openExternal(url);
        } else {
          window.open(url, '_blank');
        }
      });
    }
  }

  // ── ③ 2026, 我, vibe coding（循环免费窗口豆腐块） ──────────────────────
  // 免费时段: 周日全天 + 每日 01:00-03:00 / 13:00-15:00 (UTC)
  function isFreeWindow(utcMs) {
    var d = new Date(utcMs);
    var day = d.getUTCDay();
    if (day === 0) return true;
    var h = d.getUTCHours();
    return (h >= 1 && h < 3) || (h >= 13 && h < 15);
  }

  function nextFreeBoundary(utcMs) {
    var d = new Date(utcMs);
    var day = d.getUTCDay();
    var h = d.getUTCHours();
    if (isFreeWindow(utcMs)) {
      if (day === 0) { d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); }
      if (h >= 1 && h < 3) { d.setUTCHours(3, 0, 0, 0); return d.getTime(); }
      d.setUTCHours(15, 0, 0, 0); return d.getTime();
    }
    if (h < 1) { d.setUTCHours(1, 0, 0, 0); return d.getTime(); }
    if (h < 13) { d.setUTCHours(13, 0, 0, 0); return d.getTime(); }
    d.setUTCHours(1, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); return d.getTime();
  }

  // 免费时段本地化：把 UTC 小时换算成用户系统时区（按当前偏移，跨日取模），如 +8 时区 → 09:00-11:00/21:00-23:00
  function localFreeSpan() {
    var offMin = -new Date().getTimezoneOffset(); // 本地领先 UTC 的分钟数（东八区 = +480）
    function loc(h) {
      var m = (h * 60 + offMin) % 1440;
      if (m < 0) m += 1440;
      return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    }
    return loc(1) + '-' + loc(3) + '/' + loc(13) + '-' + loc(15);
  }

  // 用户系统时区名（Intl 权威，失败兜底 UTC）
  function localTzName() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) return tz;
    } catch (e) { }
    return 'UTC';
  }

  function fmtHMS(ms) {
    if (ms <= 0) return '00:00:00';
    var s = Math.ceil(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function vibeUtcNow() {
    try {
      if (window._sseTimeAnchor && window._sseTimeAnchor.perfNow && window._sseTimeAnchor.utcMs) {
        return window._sseTimeAnchor.utcMs + (performance.now() - window._sseTimeAnchor.perfNow);
      }
    } catch (e) { }
    return Date.now();
  }

  function vibeState(utcMs) {
    return { free: isFreeWindow(utcMs), remaining: nextFreeBoundary(utcMs) - utcMs };
  }

  var _vibeFree = null;
  var _vibeLastFetch = 0;

  // force=true 忽略 30s 冷却（弹窗打开时强制拉最新，含前8次窗口历史）
  function fetchVibeBudget(force) {
    var token = authToken();
    if (!token) return Promise.resolve(null);
    var now = Date.now();
    if (!force && now - _vibeLastFetch < 30000) return Promise.resolve(null);
    _vibeLastFetch = now;
    return fetch('https://direct-cn.gh555.com/api/qqq/free-budget', {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-cache'
    })
      .then(function (r) { if (!r.ok) return null; return r.json(); })
      .then(function (data) { if (data && data.ok) _vibeFree = data; return data; })
      .catch(function () { return null; });
  }

  function vibeBudget() {
    // 服务端 remaining_ge/budget_ge 是字符串（FormatGe），必须 parseFloat
    var d = _vibeFree;
    var rem = NaN, bud = 0, bonus = 0;
    if (d) {
      if (d.remaining_ge !== undefined && d.remaining_ge !== null && d.remaining_ge !== '') rem = parseFloat(d.remaining_ge);
      if (d.budget_ge !== undefined && d.budget_ge !== null && d.budget_ge !== '') bud = parseFloat(d.budget_ge);
      if (typeof d.season_bonus === 'number') bonus = d.season_bonus; else if (d.season_bonus) bonus = parseFloat(d.season_bonus);
    }
    return { rem: rem, bud: bud, valid: isFinite(rem) && rem >= 0, bonus: bonus };
  }

  function renderVibe() {
    if (!$vibe || !$vibeNum) return;
    var st = vibeState(vibeUtcNow());
    var b = vibeBudget();

    // ★ 免费窗口内：豆腐块名称「2026, 我, vibe coding」替换为「剩余/预算」数字（如 1.3 / 4.1，1 位小数）
    //   非免费 / 未登录 / 余额未拉到 → 显示回活动名
    if (!$vibeName) $vibeName = $vibe.querySelector('.qqq-act-name');
    if ($vibeName) {
      $vibeName.textContent = (st.free && b.valid)
        ? fmt1(b.rem) + ' / ' + fmt1(b.bud)
        : t('act.vibe.name', '2026, 我, vibe coding');
    }

    // ★ 统一：免费中「剩」+ 倒计时，非免费「距下次」+ 倒计时（不再需要点开弹窗才看到剩余时间）
    //   进度条 = 免费中余额剩余比例（余额未拉到则满格）/ 非免费 0%
    var prefix = st.free ? t('act.vibe.shortFree', '剩') : t('act.vibe.shortNext', '距下次');
    // 前缀插在等宽数字之前（widget 直接子节点）→ 继承 body 默认 UI 字体，与赞助商文字 100% 同外观；数字保持等宽
    if (!$vibePrefix) {
      $vibePrefix = document.createElement('span');
      $vibePrefix.className = 'qqq-act-txt';
      $vibe.insertBefore($vibePrefix, $vibeNum);
    }
    $vibePrefix.textContent = prefix + ' ';
    $vibeNum.textContent = fmtHMS(st.remaining);
    if ($vibeFill) {
      if (st.free && b.valid) {
        $vibeFill.style.width = Math.max(0, Math.min(100, b.bud > 0 ? b.rem / b.bud * 100 : 100)) + '%';
      } else if (st.free) {
        $vibeFill.style.width = '100%';
      } else {
        $vibeFill.style.width = '0%';
      }
    }

    // 弹窗内倒计时实时刷新（若打开）
    // ★ 免费中 → 不显示「距离下次免费」（与「免费将结束」自相矛盾），改为状态提示
    var $end = document.getElementById('qqq-vibe-end');
    var $next = document.getElementById('qqq-vibe-next');
    if ($end) $end.textContent = st.free
      ? tp('act.vibe.popFreeNow', { time: fmtHMS(st.remaining) }, '🟢 免费中 · 免费将结束 ' + fmtHMS(st.remaining))
      : t('act.vibe.popNotInWindow', '当前不在免费时段');
    if ($next) $next.textContent = st.free
      ? t('act.vibe.popInWindow', '🟢 正在免费时段 · 随机免费余额已开启')
      : tp('act.vibe.popNext', { time: fmtHMS(st.remaining) }, '⏳ 距离下次免费 ' + fmtHMS(st.remaining));
  }

  function vibeTipText() {
    var st = vibeState(vibeUtcNow());
    var b = vibeBudget();
    if (st.free) {
      var ge = b.valid ? fmt(b.rem) + '/' + fmt(b.bud) : '--';
      return tp('act.vibe.tipFree', { time: fmtHMS(st.remaining), ge: ge }, '💎 免费中 · 免费将结束 ' + fmtHMS(st.remaining) + ' · 余额 ' + ge + ' ge');
    }
    return tp('act.vibe.tipNext', { time: fmtHMS(st.remaining) }, '🤍 距离下次免费 ' + fmtHMS(st.remaining));
  }

  // 弹窗入口：先强制拉最新数据（含前8次窗口历史）再渲染，失败用已有缓存兜底
  function openVibePopup() {
    fetchVibeBudget(true).then(function () {
      renderVibePopup();
    }).catch(function () {
      renderVibePopup();
    });
  }

  // 「前8次免费窗口」区域 v4：单行圆角矩形充能框 + 标题行总统计（已用合计 / 额度合计，如 31.8 / 61.3）
  //   每框 54×28：内部仅数字 = 该窗口摇出额度；背景填充百分比 = 充能（剩余比例，满=没用过）
  //   hover → 瞬间弹出框只显示该窗口实际已用额度（data-used 供事件绑定）
  function vibeHistoryHtml() {
    var d = _vibeFree;
    if (!d || !Array.isArray(d.history) || !d.history.length) return '';
    var sumBud = 0, sumCon = 0, items = [];
    d.history.forEach(function (h) {
      var bud = parseFloat(h.budget_ge);
      var con = parseFloat(h.consumed_ge);
      var rem = parseFloat(h.remaining_ge);
      if (!isFinite(bud) || bud <= 0) return;
      if (!isFinite(rem) || rem < 0) rem = 0;
      if (!isFinite(con) || con < 0) con = 0;
      sumBud += bud; sumCon += con;
      var pct = Math.max(0, Math.min(100, rem / bud * 100));
      // ★ v7: 参照 ctx-btn 双层 background——item 内联 CSS 变量 --pct，上层硬切点遮罩 + 下层全宽固定渐变，颜色恒定不随填充长度压缩
      items.push('<div class="qqq-vibe-hist-item" style="--pct:' + pct + '%" data-used="' + fmt1(con) + '">' +
        '<span class="qqq-vibe-hist-num">' + fmt1(bud) + '</span></div>');
    });
    if (!items.length) return '';
    var title = tp('act.vibe.histTitle', { used: fmt1(sumCon), budget: fmt1(sumBud) },
      '前 8 次免费窗口：' + fmt1(sumCon) + ' / ' + fmt1(sumBud));
    return '<div class="qqq-vibe-hist"><div class="qqq-vibe-hist-title">' + title + '</div>' +
      '<div class="qqq-vibe-hist-row">' + items.join('') + '</div></div>';
  }

  function renderVibePopup() {
    var st = vibeState(vibeUtcNow());
    var b = vibeBudget();

    var budgetHtml;
    if (!isLoggedIn()) {
      budgetHtml = '<p class="qqq-act-desc" style="margin-bottom:6px;">' + t('act.vibe.popLogin', '登录后查看随机捞到滴免费余额') + '</p>';
    } else if (b.valid) {
      var pct = Math.max(0, Math.min(100, b.bud > 0 ? b.rem / b.bud * 100 : 100));
      budgetHtml =
        '<div class="qqq-act-bigbar"><span class="qqq-act-bigfill qqq-act-vibe-fill" style="width:' + pct + '%"></span></div>' +
        '<div class="qqq-act-bignum">💎 ' + fmt(b.rem) + ' / ' + fmt(b.bud) + ' ge' +
        (b.bonus > 0 ? ' <span style="font-size:14px;font-weight:700;color:#e0b400;">' + tp('act.vibe.popBonus', { v: fmt(b.bonus) }, '季节加成 +' + fmt(b.bonus) + ' ge') + '</span>' : '') +
        '</div>';
    } else if (st.free) {
      // 免费中但余额尚未拉到（请求中/失败）→ 加载态，不误报未登录
      budgetHtml = '<p class="qqq-act-desc" style="margin-bottom:6px;">' + t('act.vibe.popLoading', '随机免费余额加载中…') + '</p>';
    } else {
      // 非免费时段：无活动余额可展示
      budgetHtml = '<p class="qqq-act-desc" style="margin-bottom:6px;">' + t('act.vibe.popNoBudget', '随机免费额度在免费时间窗发放') + '</p>';
    }

    var html =
      '<div class="qqq-act-celebrate">💎</div>' +
      '<h2>' + t('act.vibe.name', '2026, 我, vibe coding') + '</h2>' +
      budgetHtml +
      vibeHistoryHtml() +
      '<p class="qqq-act-desc">' +
      '<span id="qqq-vibe-end">' + (st.free
        ? tp('act.vibe.popFreeNow', { time: fmtHMS(st.remaining) }, '🟢 免费中 · 免费将结束 ' + fmtHMS(st.remaining))
        : t('act.vibe.popNotInWindow', '当前不在免费时段')) +
      '</span><br>' +
      '<span id="qqq-vibe-next">' + (st.free
        ? t('act.vibe.popInWindow', '🟢 正在免费时段 · 随机免费余额已开启')
        : tp('act.vibe.popNext', { time: fmtHMS(st.remaining) }, '⏳ 距离下次免费 ' + fmtHMS(st.remaining))) + '</span><br>' +
      '<span id="qqq-vibe-window" class="qqq-act-tzswap">' + t('act.vibe.popWindow', '📅 免费时段：(UTC) 周日全天+每日01:00-03:00/13:00-15:00') + '</span>' +
      '</p>';

    openOverlay(html);

    // ★ 历史充能框 hover：瞬间弹出框只显示该窗口实际已用额度（只显示数字，如 6.4）
    Array.prototype.forEach.call(_overlay.querySelectorAll('.qqq-vibe-hist-item'), function (el) {
      var used = el.getAttribute('data-used') || '';
      el.addEventListener('mouseenter', function (e) { showTip(e, used); });
      el.addEventListener('mousemove', function (e) { showTip(e, used); });
      el.addEventListener('mouseleave', hideTip);
    });

    // ★ 免费时段行：先显示 (UTC) 版 2 秒 → 渐隐 → 切换用户系统时区版（时间区间同步换算）→ 渐显固定
    var $win = document.getElementById('qqq-vibe-window');
    if ($win) {
      var tz = localTzName();
      var localText = tp('act.vibe.popWindowLocal', { tz: tz, span: localFreeSpan() },
        '📅 (' + tz + ') 周日全天+每日' + localFreeSpan());
      setTimeout(function () {
        $win.classList.add('qqq-act-faded');
        setTimeout(function () {
          $win.textContent = localText;
          $win.classList.remove('qqq-act-faded');
        }, 650);
      }, 2000);
    }
  }

  // ── 事件绑定 ──────────────────────────────────────────────────────────────
  $cool.addEventListener('mouseenter', function (e) { showTip(e, t('act.cool.tip', '清爽从2026')); });
  $cool.addEventListener('mousemove', function (e) { showTip(e, t('act.cool.tip', '清爽从2026')); });
  $cool.addEventListener('mouseleave', hideTip);
  $cool.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hideTip(); openCoolPopup(); });

  $ge50.addEventListener('mouseenter', function (e) { showTip(e, t('act.ge50.tip', '总消费满 50 ge · 50 元话费 / 50 ge 二选一')); });
  $ge50.addEventListener('mousemove', function (e) { showTip(e, t('act.ge50.tip', '总消费满 50 ge · 50 元话费 / 50 ge 二选一')); });
  $ge50.addEventListener('mouseleave', hideTip);
  $ge50.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hideTip(); openGe50Popup(); });

  if ($vibe) {
    $vibe.addEventListener('mouseenter', function (e) { showTip(e, vibeTipText()); });
    $vibe.addEventListener('mousemove', function (e) { showTip(e, vibeTipText()); });
    $vibe.addEventListener('mouseleave', hideTip);
    $vibe.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hideTip(); openVibePopup(); });
    fetchVibeBudget();
    setInterval(fetchVibeBudget, 30000);
    setInterval(renderVibe, 1000);
    renderVibe();
  }

  // 登录状态变化 → 立即刷新
  try {
    if (window.qqqLogin && window.qqqLogin.onStateChange) {
      window.qqqLogin.onStateChange(function () { fetchStatus(true); setTimeout(function () { fetchVibeBudget(); }, 200); });
    }
  } catch (e) { }

  // 建楼计费事件 → 立即刷新（消费实时变化）
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'qqq-lv-tick') { fetchStatus(true); fetchVibeBudget(); }
  });

  // 定时轮询
  fetchStatus(true);
  setInterval(function () { fetchStatus(false); }, POLL_MS);
}
