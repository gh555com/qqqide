// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-menu-fit.js — 菜单行2 宽度自适应「⋯ 收纳机器」（2026-10-02 q397 用户定案）
//
// 背景: 窗口极窄 / 渲染比例极大（200% 缩放 ⇒ 可用宽 = 屏宽 ÷ 2）时，行2 左右两组
//       总需求 > 可用宽 → 旧布局只能互相挤压/溢出裁切（打架）。本机器 = 唯一收缩责任方。
//
// 三层策略（结构 → 密度 → 收纳）:
//   ① 结构层（shell-base.css）: 右组恒冻结（flex-shrink:0）+ 左组 min-width:0 + 自含裁剪
//      ——机器未跑完的过渡帧也不打架；
//   ② 密度一档: 溢出先挂 .qqq-mf-tight（按钮 padding 10→7 / gap 2→1 / LV track 60→44 …）
//      ——按钮一个不少，只收紧呼吸空间（省 ≈75px）；
//   ③ 收纳: 仍溢出 → 按 ORDER 优先级把按钮逐个移入 ⋯ 下拉（display:none 隐藏，
//      按钮本体仍在 DOM——行点击 = 原按钮 click() 代理，开过的 tab 照常活着）；空间
//      恢复逆序放出（滞回 16px 防抖）；全部收完仍溢出 → 兜底裁切（应用物理下限 ≈640px）。
//
// 收纳优先级（先收 → 后收；用户角度: 有旁路入口的先收，直连交互的最末）:
//   kmd → qmd（x 键替身零损失）→ dsecret（低频安全工具）→ git（状态另由视口徽标承担）
//   → help（子菜单收纳实验位）→ search（高频启动器）→ inbox（未读直连，最末）
//   豁免（永不收纳）: 品牌（结构位）/ ★（收藏夹面板）/ qqq（工作台面板）——详铁律 §4.15
//
// ★ help 实验（带子菜单按钮的收纳 UX，用户定案）: ⋯ 下拉中 help 行 hover → 同一帮助菜单
//   （contact/video/community 三行 + 右侧子菜单）由 core/help-menu.js openAt(锚点) 重锚到
//   行右侧级联打开——菜单本体 100% 复用（零第二实现）；指针离开行 260ms 未进入菜单则收。
// ★ inbox 红点传染: inbox 被收纳且有未读 → ⋯ 按钮红点 + ⋯ 下拉 inbox 行显未读数。
//
// 触发（全覆盖）: ResizeObserver(工具栏) + MutationObserver(行2 子树: 重建/登录态/语言/
//   编队字/LV 数字) + 窗口 resize/focus/可见性 + gaea-host renderTabBar 尾部 refresh 挂钩。
// 诊断: window.qqqMenuFit.stats()
// ============================================================================

; (function () {
  'use strict';

  if (window.qqqMenuFit) return; // 幂等

  var HYS = 16;                 // 释放/松密度滞回（px）
  var MENU_CLOSE_DELAY = 250;   // ⋯ 下拉 hover 关闭延迟（对齐 help/qqq 家族）
  var HELP_CLOSE_DELAY = 260;   // help 行离开 → 帮助菜单关闭延迟

  // 收纳优先级（先收 → 后收）——唯一真理表，调整只改这一行（豁免件不在此表）
  var ORDER = ['kmd', 'qmd', 'dsecret', 'git', 'help', 'search', 'inbox'];

  var row = null, toolbar = null, goodsBar = null, spacerEl = null;
  var _orderItems = [];         // [{key, el}] 按优先序（仅当前存在的件）
  var _k = 0;                   // 已收纳数量（= _orderItems 前 k 个）
  var _tight = false;           // 密度一档
  var _blockR = null, _blockT = null; // 释放/松密度受阻水位（spacer 宽，防抖）
  var _ellBtn = null, _menuEl = null;
  var _menuCloseT = null, _helpCloseT = null, _helpRootBound = null;
  var _raf = null, _inSync = false, _attached = false, _attachTries = 0;
  var _ro = null, _mo = null;

  function _i(key, fb) { try { return window._i ? window._i(key, fb) : fb; } catch (e) { return fb; } }

  // ── 引用解析 ────────────────────────────────────────────────────────────
  function _ensureRefs() {
    if (!row || !row.isConnected) row = document.querySelector('.qqq-menu-row-2');
    if (!row) return false;
    if (!toolbar || !toolbar.isConnected) toolbar = document.getElementById('qqq-toolbar');
    if (!goodsBar || !goodsBar.isConnected) goodsBar = document.getElementById('qqq-goods-bar');
    if (!spacerEl || !spacerEl.isConnected) spacerEl = toolbar ? toolbar.querySelector('.qqq-spacer') : null;
    return !!(toolbar && goodsBar);
  }

  function _retrySoon() {
    if (_attachTries++ > 60) return; // 30s 上限，之后停（结构缺失非本机职责）
    setTimeout(_attach, 500);
  }

  // ── 收纳件解析（豁免: 品牌 / ★ / qqq 均不在表内）─────────────────────────
  function _findEl(key) {
    if (!goodsBar) return null;
    if (key === 'inbox') return goodsBar.querySelector('.qqq-inbox-btn');
    if (key === 'help') return goodsBar.querySelector('.qqq-help-btn');
    return goodsBar.querySelector('[data-gaea-id="' + key + '"]');
  }
  function _reconcileItems() {
    _orderItems = [];
    for (var i = 0; i < ORDER.length; i++) {
      var el = _findEl(ORDER[i]);
      if (el) _orderItems.push({ key: ORDER[i], el: el });
    }
    if (_k > _orderItems.length) _k = _orderItems.length;
  }

  // ── 溢出 / 余量测量 ─────────────────────────────────────────────────────
  // 溢出 = 取双信号 max：① goods-bar 右缘越过工具栏右缘（视觉真实溢出）
  //        ② scrollWidth 超 clientWidth（含 update 按钮等其它子项）
  function _overflow() {
    try {
      var t = toolbar.getBoundingClientRect();
      var b = goodsBar.getBoundingClientRect();
      var edge = b.right - t.right;
      var sw = toolbar.scrollWidth - toolbar.clientWidth;
      return Math.max(edge > 0 ? edge : 0, sw > 0 ? sw : 0);
    } catch (e) { return 0; }
  }
  function _spacerW() {
    try { return spacerEl ? spacerEl.getBoundingClientRect().width : 0; } catch (e) { return 0; }
  }

  function _setTight(b) {
    if (_tight === b) return;
    _tight = b;
    try { row.classList.toggle('qqq-mf-tight', b); } catch (e) { }
  }

  // 释放一个已收纳件：尝试放出 → 放得下保留，放不下收回（受阻水位防抖）
  function _tryRelease() {
    if (_blockR != null && _spacerW() <= _blockR + 4) return false;
    _k--;
    _applyState();
    if (_overflow() > 0.5) { _k++; _applyState(); _blockR = _spacerW(); return false; }
    _blockR = null;
    return true;
  }
  // 松开密度档：同款试放
  function _tryUntight() {
    if (_blockT != null && _spacerW() <= _blockT + 4) return false;
    _setTight(false);
    if (_overflow() > 0.5) { _setTight(true); _blockT = _spacerW(); return false; }
    _blockT = null;
    return true;
  }

  // ── 状态应用 ────────────────────────────────────────────────────────────
  function _applyState() {
    var k = Math.min(_k, _orderItems.length);
    for (var i = 0; i < _orderItems.length; i++) {
      var el = _orderItems[i].el;
      if (i < k) { if (el.style.display !== 'none') el.style.display = 'none'; }
      else { if (el.style.display === 'none') el.style.display = ''; }
    }
    _layoutEll();
  }

  // ⋯ 按钮：懒建 / 显隐 / 定位于「goods 区与豁免件（★）之间」/ 未读红点
  function _layoutEll() {
    if (!goodsBar) return;
    if (!_ellBtn) {
      _ellBtn = document.createElement('button');
      _ellBtn.type = 'button';
      _ellBtn.className = 'gaea-tab-btn qqq-goods-btn qqq-mf-btn';
      _ellBtn.textContent = '\u22EF';
      _ellBtn.style.cssText =
        'height:22px; padding:0 8px; margin:0 1px; border:1px solid var(--border-color); border-radius:3px;' +
        'background:transparent; color:var(--text-primary); font-size:13px; line-height:1;' +
        'transition: background 0.15s; position:relative;';
      _ellBtn.addEventListener('mouseenter', function () { _cancelMenuClose(); _openMenu(); });
      _ellBtn.addEventListener('mouseleave', _scheduleMenuClose);
      _ellBtn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 焦点卫生（点后不留焦点）
      _ellBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (_menuEl) _closeMenu('clickToggle'); else _openMenu(); // 触摸兜底：点击切换
      });
    }
    var tip = _i('shell.moreBtn', '更多按钮（窗口过窄时收纳于此）');
    if (_ellBtn.title !== tip) _ellBtn.title = tip;

    var need = _k > 0;
    if (need) {
      if (_ellBtn.style.display === 'none') _ellBtn.style.display = '';
    } else {
      if (_ellBtn.style.display !== 'none') _ellBtn.style.display = 'none';
      if (_menuEl) _closeMenu('empty');
    }
    if (_ellBtn.parentNode !== goodsBar) goodsBar.appendChild(_ellBtn);
    if (need) {
      // 固定槽位：首個豁免件（★ → qqq → help）之前；无豁免件则排最末
      var anchor = goodsBar.querySelector('.qqq-fav-btn') ||
        goodsBar.querySelector('.qqq-tools-btn') ||
        goodsBar.querySelector('.qqq-help-btn');
      if (anchor && anchor !== _ellBtn && anchor.previousSibling !== _ellBtn) {
        goodsBar.insertBefore(_ellBtn, anchor);
      } else if (!anchor && goodsBar.lastChild !== _ellBtn) {
        goodsBar.appendChild(_ellBtn);
      }
    }
    _refreshDot();
  }

  function _inboxUnreadText() {
    try {
      var b = document.getElementById('qqq-inbox-badge');
      if (!b) return '';
      var t = String(b.textContent || '').trim();
      return (b.style.display !== 'none' && t) ? t : '';
    } catch (e) { return ''; }
  }
  function _refreshDot() {
    if (!_ellBtn) return;
    var show = false;
    for (var i = 0; i < _k && i < _orderItems.length; i++) {
      if (_orderItems[i].key === 'inbox') { show = !!_inboxUnreadText(); break; }
    }
    try { _ellBtn.classList.toggle('qqq-mf-dot', show); } catch (e) { }
  }

  // ── 同步主循环 ──────────────────────────────────────────────────────────
  function _sync() {
    if (_inSync) return;
    _inSync = true;
    try {
      if (!_ensureRefs()) { _retrySoon(); return; }
      _reconcileItems();
      _applyState(); // 始终先恢复当前 k（renderTabBar 重建后重挂 + 重新隐藏）

      var guard = 0;
      // ① 释放相：无溢出且有余量才尝试（滞回 + 受阻水位防抖）
      while (guard++ < 32) {
        if (_overflow() > 0.5) break;
        var sp = _spacerW();
        if (_k > 0 && sp >= HYS) { if (_tryRelease()) continue; break; }
        if (_k === 0 && _tight && sp >= HYS) { if (_tryUntight()) continue; break; }
        break;
      }
      // ② 收纳相：溢出 → 先密度一档，再按优先级逐个收纳
      guard = 0;
      while (guard++ < 32) {
        if (_overflow() <= 0.5) break;
        _blockR = null; _blockT = null;
        if (!_tight && _k === 0) { _setTight(true); continue; }
        if (_k < _orderItems.length) { _k++; _applyState(); continue; }
        break; // 全部收完仍溢出 → 兜底裁切（应用物理下限）
      }
      if (_menuEl) { _renderMenuRows(); _positionMenu(); }
    } finally {
      _inSync = false;
    }
  }

  function _schedule() {
    if (_raf) return;
    _raf = requestAnimationFrame(function () { _raf = null; _sync(); });
  }

  // ── ⋯ 下拉 ──────────────────────────────────────────────────────────────
  function _labelOf(key) {
    if (key === 'inbox') return 'inbox'; // 按钮内含徽章子节点，恒用品牌名
    var el = _findEl(key);
    if (el) {
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3 && String(n.nodeValue || '').trim()) return String(n.nodeValue).trim();
      }
      var t = String(el.textContent || '').trim();
      if (t) return t;
    }
    return key;
  }

  function _renderMenuRows() {
    if (!_menuEl) return;
    _menuEl.innerHTML = '';
    var collected = _orderItems.slice(0, Math.min(_k, _orderItems.length));
    // DOM 序排列（阅读稳定：与被收纳件的原行序一致）
    collected.sort(function (a, b) {
      try {
        var pos = a.el.compareDocumentPosition(b.el);
        return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
      } catch (e) { return 0; }
    });
    for (var i = 0; i < collected.length; i++) {
      (function (it) {
        var itemRow = document.createElement('div');
        itemRow.className = 'qqq-mf-row';
        var lab = document.createElement('span');
        lab.textContent = _labelOf(it.key);
        itemRow.appendChild(lab);
        if (it.key === 'help') {
          // ★ 子菜单收纳实验：hover → 帮助菜单重锚到本行右侧级联（复用 core/help-menu.js）
          itemRow.classList.add('qqq-mf-row-sub');
          var arrow = document.createElement('span');
          arrow.className = 'qqq-mf-row-arrow';
          arrow.textContent = '\u203A';
          itemRow.appendChild(arrow);
          itemRow.addEventListener('mouseenter', function () { _openHelpAt(itemRow); });
          itemRow.addEventListener('mouseleave', _scheduleHelpClose);
          itemRow.addEventListener('click', function (e) { e.stopPropagation(); _openHelpAt(itemRow); });
        } else {
          if (it.key === 'inbox') {
            var cnt = _inboxUnreadText();
            if (cnt) {
              var chip = document.createElement('span');
              chip.className = 'qqq-mf-row-dot';
              chip.textContent = cnt;
              itemRow.appendChild(chip);
            }
          }
          itemRow.addEventListener('click', function (e) {
            e.stopPropagation();
            _closeMenu('pick');
            try { it.el.click(); } catch (_) { } // 点击代理 = 原按钮本体（被收纳 ≠ 销毁）
          });
        }
        _menuEl.appendChild(itemRow);
      })(collected[i]);
    }
  }

  function _positionMenu() {
    if (!_menuEl || !_ellBtn) return;
    var r = _ellBtn.getBoundingClientRect();
    var w = _menuEl.offsetWidth || 132, h = _menuEl.offsetHeight || 120;
    var left = r.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (left < 8) left = 8;
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(4, r.top - h - 4);
    _menuEl.style.left = left + 'px';
    _menuEl.style.top = top + 'px';
  }

  function _openMenu() {
    if (_k <= 0 || !_ellBtn) return;
    if (!_menuEl) {
      _menuEl = document.createElement('div');
      _menuEl.className = 'qqq-mf-menu';
      _menuEl.addEventListener('mouseenter', _cancelMenuClose);
      _menuEl.addEventListener('mouseleave', _scheduleMenuClose);
      document.body.appendChild(_menuEl);
      _bindMenuGlobal();
    }
    _renderMenuRows();
    _positionMenu();
    requestAnimationFrame(function () { if (_menuEl) _menuEl.classList.add('open'); });
  }

  function _scheduleMenuClose() {
    _cancelMenuClose();
    _menuCloseT = setTimeout(function () { _menuCloseT = null; _closeMenu('leave'); }, MENU_CLOSE_DELAY);
  }
  function _cancelMenuClose() {
    if (_menuCloseT) { clearTimeout(_menuCloseT); _menuCloseT = null; }
  }

  function _closeMenu(reason) {
    _cancelMenuClose();
    var had = !!_menuEl;
    if (_menuEl) { try { _menuEl.remove(); } catch (e) { } _menuEl = null; }
    _unbindMenuGlobal();
    if (had) _scheduleHelpClose(); // help 若经本菜单打开且指针不在其上 → 一并收（可被进入取消）
    void reason;
  }

  // ── 帮助菜单重锚（help 收纳实验）────────────────────────────────────────
  function _scheduleHelpClose() {
    if (_helpCloseT) { clearTimeout(_helpCloseT); }
    _helpCloseT = setTimeout(function () {
      _helpCloseT = null;
      if (!(_helpRootBound && _helpRootBound.isConnected)) return; // 非本菜单打开 → 不越权
      if (_helpUnderPointer()) return; // 指针在菜单上（其自身 mouseleave 管关闭）
      try { if (window.qqqHelpMenu && window.qqqHelpMenu.close) window.qqqHelpMenu.close(); } catch (e) { }
    }, HELP_CLOSE_DELAY);
  }
  function _cancelHelpClose() {
    if (_helpCloseT) { clearTimeout(_helpCloseT); _helpCloseT = null; }
  }
  function _helpUnderPointer() {
    try {
      if (_helpRootBound && _helpRootBound.isConnected && _helpRootBound.matches(':hover')) return true;
      var s = document.querySelector('.qqq-help-sub');
      if (s && s.matches(':hover')) return true;
    } catch (e) { }
    return false;
  }
  function _openHelpAt(anchorEl) {
    var hm = window.qqqHelpMenu;
    if (!hm || typeof hm.openAt !== 'function') return;
    _cancelHelpClose();
    var root = null;
    try { root = hm.openAt(anchorEl); } catch (e) { root = null; }
    if (root && root !== _helpRootBound) {
      _helpRootBound = root;
      root.addEventListener('mouseenter', function () { _cancelHelpClose(); });
    }
  }

  // ── 下拉全局收口（外点 / Esc / resize / blur）──────────────────────────
  function _helpUnderElement(t) {
    try {
      if (_helpRootBound && _helpRootBound.contains(t)) return true;
      var h = document.querySelector('.qqq-help-menu');
      if (h && h.contains(t)) return true;
      var s = document.querySelector('.qqq-help-sub');
      if (s && s.contains(t)) return true;
    } catch (e) { }
    return false;
  }
  function _onMenuOutside(ev) {
    var t = ev.target;
    if (_menuEl && _menuEl.contains(t)) return;
    if (_ellBtn && _ellBtn.contains(t)) return;
    if (_helpUnderElement(t)) return; // 帮助菜单上的交互不算外部（其自身收口照常）
    _closeMenu('outside');
  }
  function _onMenuEsc(ev) { if (ev.key === 'Escape') _closeMenu('esc'); }
  function _onMenuViewportGone() { _closeMenu('resize'); }
  function _onMenuBlur() { _closeMenu('blur'); }

  var _menuBound = false;
  function _bindMenuGlobal() {
    if (_menuBound) return;
    _menuBound = true;
    document.addEventListener('mousedown', _onMenuOutside, true);
    document.addEventListener('keydown', _onMenuEsc, true);
    window.addEventListener('resize', _onMenuViewportGone);
    window.addEventListener('blur', _onMenuBlur);
  }
  function _unbindMenuGlobal() {
    if (!_menuBound) return;
    _menuBound = false;
    document.removeEventListener('mousedown', _onMenuOutside, true);
    document.removeEventListener('keydown', _onMenuEsc, true);
    window.removeEventListener('resize', _onMenuViewportGone);
    window.removeEventListener('blur', _onMenuBlur);
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  function _attach() {
    if (!_ensureRefs()) { _retrySoon(); return; }
    if (!_attached) {
      _attached = true;
      try { _ro = new ResizeObserver(_schedule); _ro.observe(toolbar); } catch (e) { }
      try {
        _mo = new MutationObserver(_schedule);
        _mo.observe(row, {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['style', 'class']
        });
      } catch (e) { }
      window.addEventListener('resize', _schedule);
      window.addEventListener('focus', _schedule);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) _schedule(); });
      window.addEventListener('qqq-lang-change', _schedule);
    }
    _sync(); // 首轮同步（防亮相/重载后残留收纳态错位）
  }

  window.qqqMenuFit = {
    refresh: _schedule,
    stats: function () {
      return {
        k: _k,
        tight: _tight,
        order: ORDER.slice(),
        present: _orderItems.map(function (it) { return it.key; }),
        collected: _orderItems.slice(0, Math.min(_k, _orderItems.length)).map(function (it) { return it.key; }),
        overflowPx: Math.round(_overflow() * 10) / 10,
        spacerPx: Math.round(_spacerW() * 10) / 10
      };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _attach);
  } else {
    _attach();
  }
})();
