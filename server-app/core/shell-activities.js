// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-activities.js — 状态栏双活动豆腐块
//
// ① 清爽从2026（qqq-act-cool）：总消费（实扣+白嫖）0→10 ge 进度条
//    hover 瞬间弹出自定义文字框「清爽从2026」
//    点击 → 拼多多式活动弹窗（两阶段：未满 / 已满）→ 加 QQ 群 524906522 领 10 元红包
// ② 50ge 大礼（qqq-act-ge50）：总消费 0→50 ge 进度条
//    点击 → 任务清单弹窗（下载登录 ✓ / 消费50ge ✓ / 充值门槛(可配置,0=隐藏) / 领取按钮行）
//    领取：50 元话费（人工发放 ~2 工作日）或 50 ge（立即到账）
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
  if (!$cool || !$ge50) return;

  // ── 工具 ──────────────────────────────────────────────────────────────────
  function t(key, fb) {
    try { return window._i ? window._i(key, fb) : fb; } catch (e) { return fb; }
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
    fetch(API_BASE + '/qqqide/activity', {
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

    // 50ge 大礼
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
      'animation:qqqActPop .28s cubic-bezier(.34,1.56,.64,1);padding:26px 28px 24px;}' +
      '.qqq-act-modal.qqq-act-ge50-modal{background:linear-gradient(165deg,#141b2e 0%,#0d0d1a 60%,#1a1024 100%);' +
      'border-color:rgba(108,113,196,.4);box-shadow:0 0 34px rgba(108,113,196,.25),0 10px 40px rgba(0,0,0,.5);}' +
      '.qqq-act-close{position:absolute;top:10px;right:12px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.18);' +
      'background:rgba(255,255,255,.08);color:#ddd;font-size:15px;line-height:26px;text-align:center;}' +
      '.qqq-act-close:hover{background:rgba(52,211,153,.25);border-color:#34d399;}' +
      '.qqq-act-modal h2{margin:2px 0 2px;font-size:26px;font-weight:900;text-align:center;' +
      'background:linear-gradient(135deg,#34d399,#06b6d4);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}' +
      '.qqq-act-modal .qqq-act-sub{margin:0 0 14px;text-align:center;font-size:13px;color:#9aa0b5;}' +
      '.qqq-act-bigbar{margin:14px 0 6px;height:16px;border-radius:9px;background:rgba(255,255,255,.08);overflow:hidden;position:relative;}' +
      '.qqq-act-bigfill{display:block;height:100%;border-radius:9px;' +
      'background:linear-gradient(90deg,#2aa198,#859900,#2aa198);background-size:200% 100%;animation:qqqActShimmer 2.4s linear infinite;' +
      'transition:width .8s;}' +
      '.qqq-act-bigfill.qqq-act-full{background:linear-gradient(90deg,#859900,#b58900,#859900);background-size:200% 100%;animation:qqqActShimmer 1.2s linear infinite;}' +
      '.qqq-act-bignum{text-align:center;font-size:15px;font-weight:700;color:#34d399;font-family:Consolas,monospace;}' +
      '.qqq-act-desc{margin:14px 0 18px;text-align:center;font-size:14px;line-height:1.9;color:#c8c8d8;}' +
      '.qqq-act-desc b{color:#34d399;}' +
      '.qqq-act-cta{display:block;width:100%;padding:12px 0;border:none;border-radius:10px;font-size:16px;font-weight:800;' +
      'background:linear-gradient(90deg,#059669,#0d9488);color:#fff;box-shadow:0 4px 18px rgba(5,150,105,.4);}' +
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
      '.qqq-act-claims{display:flex;gap:10px;margin-top:6px;}' +
      '.qqq-act-claim{flex:1;padding:11px 6px;border:none;border-radius:10px;font-size:13.5px;font-weight:800;color:#fff;' +
      'background:linear-gradient(90deg,#6c71c4,#b58900);box-shadow:0 4px 14px rgba(108,113,196,.3);}' +
      '.qqq-act-claim.qqq-act-claim-phone{background:linear-gradient(90deg,#268bd2,#2aa198);box-shadow:0 4px 14px rgba(38,139,210,.3);}' +
      '.qqq-act-claim:disabled{filter:grayscale(1);opacity:.55;box-shadow:none;}' +
      '.qqq-act-claim:hover:not(:disabled){filter:brightness(1.1);}' +
      '.qqq-act-lockhint{text-align:center;font-size:12px;color:#7a8098;margin-top:8px;}' +
      '.qqq-act-modal2{position:relative;width:420px;max-width:90vw;border-radius:14px;padding:26px 26px 22px;text-align:center;' +
      'background:linear-gradient(165deg,#10131f,#0d0d1a);color:#e6e6e6;border:1.5px solid rgba(52,211,153,.4);' +
      'box-shadow:0 0 30px rgba(52,211,153,.2);animation:qqqActPop .25s cubic-bezier(.34,1.56,.64,1);}' +
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

    var html;
    if (!reached) {
      // ★ 阶段一：未满
      html =
        '<div class="qqq-act-celebrate">🧊</div>' +
        '<h2>' + t('act.cool.name', '清爽从2026') + '</h2>' +
        '<p class="qqq-act-sub">' + t('act.cool.popSub', '总消费满 10 ge 领 10 元红包') + '</p>' +
        '<div class="qqq-act-bigbar"><span class="qqq-act-bigfill" style="width:' + pct + '%"></span></div>' +
        '<div class="qqq-act-bignum">' + fmt(total) + ' / ' + target + ' ge</div>' +
        '<p class="qqq-act-desc">' +
        t('act.cool.p1', '进度条充满 = 总消费达到 <b>10 ge</b>（实扣 + 白嫖都算）！<br>即便全部白嫖，只要进度条充满，现在就可以加 QQ 群 <b>524906522</b> 领 <b>10 元红包</b>。') +
        '</p>' +
        '<button class="qqq-act-cta" id="qqq-act-copy">' + t('act.cool.copyGroup', '加 QQ 群 524906522 领 10 元红包') + '</button>';
    } else {
      // ★ 阶段二：已满 → 庆祝
      html =
        '<div class="qqq-act-celebrate">🎉</div>' +
        '<h2>' + t('act.cool.p2Title', '恭喜！进度条已充满') + '</h2>' +
        '<p class="qqq-act-sub">' + t('act.cool.popSub', '总消费满 10 ge 领 10 元红包') + '</p>' +
        '<div class="qqq-act-bigbar"><span class="qqq-act-bigfill qqq-act-full" style="width:100%"></span></div>' +
        '<div class="qqq-act-bignum">' + fmt(total) + ' / ' + target + ' ge ✓</div>' +
        '<p class="qqq-act-desc">' +
        t('act.cool.p2', '你的总消费已达 <b>10 ge</b>（含白嫖）！<br>现在就可以加 QQ 群 <b>524906522</b> 领 <b>10 元红包</b>。') +
        '</p>' +
        '<button class="qqq-act-cta" id="qqq-act-copy">' + t('act.cool.copyGroup2', '复制群号 524906522 去加群') + '</button>';
    }
    openOverlay(html);
    _overlay.querySelector('#qqq-act-copy').addEventListener('click', copyQqGroup);
  }

  // ── 弹窗二：50ge 大礼（任务清单） ────────────────────────────────────────
  function claimGe50() {
    var g = _data && _data.ge50;
    if (!g || !g.claimable || g.claimed_ge50) return;
    var token = authToken();
    if (!token) { openLogin(); return; }
    fetch(API_BASE + '/qqqide/activity/claim-ge50', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          if (data.already) {
            qoast(t('act.ge50.already', '你已领取过该奖励'), 'info');
            if (_data && _data.ge50) _data.ge50.claimed_ge50 = true;
            render();
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
    if (!g || !g.claimable || g.claimed_phone50) return;
    var token = authToken();
    if (!token) { openLogin(); return; }
    fetch(API_BASE + '/qqqide/activity/claim-phone50', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          if (data.already) {
            qoast(t('act.ge50.already', '你已领取过该奖励'), 'info');
            if (_data && _data.ge50) _data.ge50.claimed_phone50 = true;
            render();
            return;
          }
          if (_data && _data.ge50) _data.ge50.claimed_phone50 = true;
          render();
          var phone = (data && data.phone) || (_data && _data.phone) || '';
          openConfirm(
            t('act.ge50.phoneModalTitle', '50 元话费'),
            t('act.ge50.phoneModalDesc', '话费将在 2 个工作日内自动到账，请保持手机号 ' + phone + ' 畅通。'),
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
        '<h2>🎁 ' + t('act.ge50.name', '50ge 大礼') + '</h2>' +
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
    if (reqYuan > 0) {
      tasks +=
        '<li class="qqq-act-task ' + (rechargeOk ? 'qqq-act-task-done' : 'qqq-act-task-locked') + '">' +
        '<span class="qqq-act-check">' + (rechargeOk ? '✓' : '') + '</span>' +
        t('act.ge50.task3', '充值 ' + reqYuan + ' 元') +
        '</li>';
    }

    var claims =
      '<div class="qqq-act-claims">' +
      '<button class="qqq-act-claim qqq-act-claim-phone" id="qqq-act-claim-phone" ' +
      (claimable && !claimedPhone ? '' : 'disabled') + '>' +
      (phone ? phone + '<br>' : '') + (claimedPhone ? t('act.ge50.claimed', '已领取') : t('act.ge50.claimPhone', '获取 50 元话费')) +
      '</button>' +
      '<button class="qqq-act-claim" id="qqq-act-claim-ge" ' +
      (claimable && !claimedGe ? '' : 'disabled') + '>' +
      (claimedGe ? t('act.ge50.claimed', '已领取') : t('act.ge50.claimGe', '立即获取 50 ge')) +
      '</button>' +
      '</div>' +
      (claimable ? '' : '<div class="qqq-act-lockhint">' + t('act.ge50.taskLocked', '完成上方任务后解锁') + '</div>');

    var html =
      '<div class="qqq-act-celebrate">🎁</div>' +
      '<h2>' + t('act.ge50.name', '50ge 大礼') + '</h2>' +
      '<p class="qqq-act-sub">' + t('act.ge50.popSub', '实扣 + 白嫖合计达到 50 ge 即可领取') + '</p>' +
      '<div class="qqq-act-bigbar"><span class="qqq-act-bigfill' + (total >= target ? ' qqq-act-full' : '') + '" style="width:' + pct + '%"></span></div>' +
      '<div class="qqq-act-bignum">' + fmt(total) + ' / ' + target + ' ge</div>' +
      '<ul class="qqq-act-tasks">' + tasks + '</ul>' +
      claims;

    openOverlay(html, 'qqq-act-ge50-modal');
    var $ph = _overlay.querySelector('#qqq-act-claim-phone');
    var $ge = _overlay.querySelector('#qqq-act-claim-ge');
    if ($ph) $ph.addEventListener('click', claimPhone50);
    if ($ge) $ge.addEventListener('click', claimGe50);
  }

  // ── 事件绑定 ──────────────────────────────────────────────────────────────
  $cool.addEventListener('mouseenter', function (e) { showTip(e, t('act.cool.tip', '清爽从2026')); });
  $cool.addEventListener('mousemove', function (e) { showTip(e, t('act.cool.tip', '清爽从2026')); });
  $cool.addEventListener('mouseleave', hideTip);
  $cool.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hideTip(); openCoolPopup(); });

  $ge50.addEventListener('mouseenter', function (e) { showTip(e, t('act.ge50.tip', '总消费满 50 ge · 领 50 元话费或 50 ge')); });
  $ge50.addEventListener('mousemove', function (e) { showTip(e, t('act.ge50.tip', '总消费满 50 ge · 领 50 元话费或 50 ge')); });
  $ge50.addEventListener('mouseleave', hideTip);
  $ge50.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hideTip(); openGe50Popup(); });

  // 登录状态变化 → 立即刷新
  try {
    if (window.qqqLogin && window.qqqLogin.onStateChange) {
      window.qqqLogin.onStateChange(function () { fetchStatus(true); });
    }
  } catch (e) { }

  // 建楼计费事件 → 立即刷新（消费实时变化）
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'qqq-lv-tick') fetchStatus(true);
  });

  // 定时轮询
  fetchStatus(true);
  setInterval(function () { fetchStatus(false); }, POLL_MS);
}
