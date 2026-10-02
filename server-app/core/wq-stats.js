// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// wq-stats.js — 前摇统计器（粘贴探针性能追踪 + 状态栏按钮 + hover 卡片）
//
// 照搬 q3 global.js 的 saveWqStats 逻辑：追踪 klipzap.probe() 执行时间，
// 统计平均 / 最近 7 次 / 历史最大。
//
// 2026-09-27 改版（q370）: 状态栏旧「变宽文本行」废除——旧行宽度随数字无界增长，
//   无限左右吞食状态区；改「固定宽按钮（迷你柱状图 + 均值，恒 64px）+ hover 卡片」：
//     · 前摇统计（平均 / 最大 / 次数 / 最近 7 次）
//     · 媒体缓存占用（40MB 上限）+ 命中率 / 熔断数
//     · 转码缓存占用（2GB 上限）
//   缓存读数 = 壳层 IPC qqqide:media:cacheStats（只读，不触发任何生成/淘汰）。
//   卡片交互对齐 MEM 卡：hover 即弹 / 点击钉住 / 点卡片外（含 iframe 内）关闭 / Esc 关闭；
//   重置按钮在卡片内（旧「点击即重置」废除——防误触）。
//
// API:
//   wqStats.record(executionTimeMs)  — 记录一次前摇
//   wqStats.getSnapshot()            — 返回 { avg, recent, max, count }
//   wqStats.reset()                  — 重置统计
//   wqStats.injectStatusBar()        — 自动注入状态栏按钮（页面加载后调用一次）
//
// 持久化: qgs.simple('qqq-wq-stats')
// ============================================================================

(function () {
  'use strict';

  var _totalTime = 0;
  var _count = 0;
  var _recentTimes = [];  // 最近 7 次
  var _maxTime = 0;
  var _initialized = false;
  var _$el = null;        // 状态栏按钮
  var _$val = null;       // 按钮文字
  var _$spark = null;     // 按钮迷你柱状图 <svg>

  // ── 卡片状态 ──
  var _card = null;
  var _shown = false;
  var _pinned = false;
  var _hideTimer = null;
  var _wired = false;
  var _cacheData = null;     // 最近一次缓存统计（qqqide:media:cacheStats 返回）
  var _cacheFetching = false;
  var _cacheTimer = null;

  var NS = 'qqq-wq-stats';

  // ── i18n 助手（翻译 + 回退 + {x} 插值；同 shell-statusbar 模式）──
  function _T(k, fb, p) {
    var v = null;
    try { if (window.i18n && window.i18n.t) { var r = window.i18n.t(k, p); if (r && r !== k) v = r; } } catch (e) { }
    if (v === null) {
      v = fb;
      if (p) { for (var x in p) v = v.split('{' + x + '}').join(String(p[x])); }
    }
    return v;
  }

  // ═══ 持久化 ═══
  function _load() {
    if (_initialized) return;
    _initialized = true;
    try {
      if (window.qgs && window.qgs.simple) {
        var saved = window.qgs.simple(NS).get('stats');
        if (saved && typeof saved === 'object') {
          _totalTime = saved.totalTime || 0;
          _count = saved.count || 0;
          _recentTimes = Array.isArray(saved.recentTimes) ? saved.recentTimes.slice(0, 7) : [];
          _maxTime = saved.maxTime || 0;
        }
      }
    } catch (e) {
      // 静默——统计不重要
    }
  }

  function _save() {
    try {
      if (window.qgs && window.qgs.simple) {
        window.qgs.simple(NS).set('stats', {
          totalTime: _totalTime,
          count: _count,
          recentTimes: _recentTimes,
          maxTime: _maxTime,
        });
      }
    } catch (e) {
      // 静默
    }
  }

  // ═══ 格式化 ═══
  // 有界宽度：<100 一位小数（12.3）/ ≥100 整数（132）——按钮/卡片恒不撑宽
  function _fmtMs(v) {
    v = Number(v) || 0;
    return v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
  }

  // 去尾零（"12.0"→"12"；"40" 保持；"0.30"→"0.3"）
  function _trimNum(v, d) {
    var s = Number(v).toFixed(d);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  // 占用对：按上限档位选单位（媒体缓存 40MB → MB 档；转码缓存 2GB → GB 档）
  function _fmtPair(bytes, max) {
    bytes = Number(bytes) || 0;
    max = Number(max) || 0;
    if (max >= 1073741824) {
      return _trimNum(bytes / 1073741824, 2) + ' / ' + _trimNum(max / 1073741824, 0) + ' GB';
    }
    return _trimNum(bytes / 1048576, 1) + ' / ' + _trimNum(max / 1048576, 0) + ' MB';
  }

  // 迷你柱状图 rects（老→新 左→右；相对高度归一，最短 1.5px 保证可见；currentColor 随按钮阈值色）
  function _sparkRects(values, w, h, barW, gap) {
    var n = Math.min(values.length, 7);
    if (!n) return '';
    var maxV = 1;
    for (var i = 0; i < n; i++) { if (values[i] > maxV) maxV = values[i]; }
    var totalW = n * barW + (n - 1) * gap;
    var x0 = (w - totalW) / 2;
    var html = '';
    for (var j = 0; j < n; j++) {
      var bh = Math.max(1.5, values[j] / maxV * (h - 2));
      bh = Math.round(bh * 10) / 10;
      html += '<rect x="' + (x0 + j * (barW + gap)) + '" y="' + (h - bh) + '" width="' + barW +
        '" height="' + bh + '" rx="' + Math.min(1, barW / 4) + '" fill="currentColor"/>';
    }
    return html;
  }

  // ═══ 状态栏按钮渲染 ═══
  function _updateDom() {
    if (!_$el) return;
    var s = getSnapshot();

    // 阈值配色（>20ms 橙黄 / >50ms 红 / 无记录 灰；迷你柱 currentColor 继承）
    _$el.classList.remove('qqq-wq-warn', 'qqq-wq-bad', 'qqq-wq-dim');
    if (s.count === 0) { _$el.classList.add('qqq-wq-dim'); }
    else if (s.avg > 50) { _$el.classList.add('qqq-wq-bad'); }
    else if (s.avg > 20) { _$el.classList.add('qqq-wq-warn'); }

    if (_$spark) { _$spark.innerHTML = s.count === 0 ? '' : _sparkRects(s.recent, 20, 12, 2, 1); }
    if (_$val) { _$val.textContent = s.count === 0 ? '--' : _fmtMs(s.avg) + 'ms'; }

    if (_shown) _renderCard(); // 卡片打开中实时同步
  }

  // ═══ 卡片骨架（懒构建一次）═══
  function _ensureCard() {
    if (_card) return;
    _card = document.createElement('div');
    _card.className = 'qqq-wq-hover';
    _card.innerHTML =
      '<div class="qqq-wq-hover-head">' +
        '<span class="qqq-wq-hover-title"><i class="qqq-wq-hover-dot"></i>' + _T('shell.wq.title', 'wq 探针') + '</span>' +
        '<button type="button" class="qqq-wq-hover-reset">' + _T('shell.wq.reset', '重置') + '</button>' +
      '</div>' +
      '<div class="qqq-wq-hover-num">' +
        '<span class="qqq-wq-hover-main"><b class="qqq-wq-hover-val">--</b><i class="qqq-wq-hover-unit">ms</i></span>' +
        '<svg class="qqq-wq-hover-spark" width="46" height="20" aria-hidden="true"></svg>' +
      '</div>' +
      '<div class="qqq-wq-hover-meta"></div>' +
      '<div class="qqq-wq-hover-sub"></div>' +
      '<div class="qqq-wq-hover-sep"></div>' +
      '<div class="qqq-wq-hover-cache">' +
        '<div class="qqq-wq-hover-crow"><span class="qqq-wq-hover-cname">' + _T('shell.wq.cacheMedia', '媒体缓存') + '</span><span class="qqq-wq-hover-cval qqq-wq-media-val">--</span></div>' +
        '<div class="qqq-wq-hover-cbar qqq-wq-media-bar"><i></i></div>' +
        '<div class="qqq-wq-hover-cmeta qqq-wq-media-meta"></div>' +
        '<div class="qqq-wq-hover-crow qqq-wq-play-row"><span class="qqq-wq-hover-cname">' + _T('shell.wq.cachePlay', '转码缓存') + '</span><span class="qqq-wq-hover-cval qqq-wq-play-val">--</span></div>' +
        '<div class="qqq-wq-hover-cbar qqq-wq-play-bar"><i></i></div>' +
      '</div>';
    document.body.appendChild(_card);

    var btn = _card.querySelector('.qqq-wq-hover-reset');
    if (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        reset();
        if (window.qqqideQoast) {
          window.qqqideQoast.show(_T('shell.wq.resetDone', 'wq 统计已重置'), { duration: 1600 });
        }
      });
    }
    // 卡片内点击不冒泡（防触 document 外部点击判定）
    _card.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  // 进度条（frac 0..1；hot=超 90% 转红）
  function _setBar(el, frac, hot) {
    if (!el) return;
    var i = el.firstChild;
    if (!i) return;
    frac = Number(frac) || 0;
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    i.style.width = (frac * 100).toFixed(1) + '%';
    el.classList.toggle('qqq-wq-hot', !!hot);
  }

  // ═══ 卡片渲染 ═══
  function _renderCard() {
    if (!_card) return;
    var s = getSnapshot();
    // 阈值同尺（卡片迷你柱/文字与按钮同色）
    _card.classList.remove('qqq-wq-t-warn', 'qqq-wq-t-bad');
    if (s.count > 0 && s.avg > 50) { _card.classList.add('qqq-wq-t-bad'); }
    else if (s.count > 0 && s.avg > 20) { _card.classList.add('qqq-wq-t-warn'); }
    var $val = _card.querySelector('.qqq-wq-hover-val');
    var $unit = _card.querySelector('.qqq-wq-hover-unit');
    var $meta = _card.querySelector('.qqq-wq-hover-meta');
    var $sub = _card.querySelector('.qqq-wq-hover-sub');
    var $spark = _card.querySelector('.qqq-wq-hover-spark');
    if (s.count === 0) {
      $val.textContent = '--';
      $unit.style.display = 'none';
      $meta.textContent = _T('shell.wq.empty', '暂无记录');
      $sub.textContent = '';
      $spark.innerHTML = '';
    } else {
      $unit.style.display = '';
      $val.textContent = _fmtMs(s.avg);
      $meta.textContent = _T('shell.wq.probeMeta', '最大 {max} ms · 共 {n} 次', { max: _fmtMs(s.max), n: String(s.count) });
      $sub.textContent = _T('shell.wq.recent', '最近 {list}', {
        list: s.recent.map(function (t) { return _fmtMs(t); }).join(' '),
      });
      $spark.innerHTML = _sparkRects(s.recent, 46, 20, 4, 2);
    }
    _renderCache();
  }

  function _renderCache() {
    if (!_card) return;
    var $mv = _card.querySelector('.qqq-wq-media-val');
    var $mb = _card.querySelector('.qqq-wq-media-bar');
    var $mm = _card.querySelector('.qqq-wq-media-meta');
    var $pv = _card.querySelector('.qqq-wq-play-val');
    var $pb = _card.querySelector('.qqq-wq-play-bar');
    var d = _cacheData;
    if (!d || !d.ok) {
      $mv.textContent = '--';
      _setBar($mb, 0, false);
      $mm.textContent = '';
      $pv.textContent = '--';
      _setBar($pb, 0, false);
      return;
    }
    // 媒体缓存（40MB 上限）
    var mMax = Number(d.mediaMax) || 1;
    var mBytes = Number(d.mediaBytes) || 0;
    $mv.textContent = _fmtPair(mBytes, mMax);
    _setBar($mb, mBytes / mMax, mBytes / mMax > 0.9);
    var hits = (Number(d.hit) || 0);
    var miss = (Number(d.miss) || 0);
    var total = hits + miss;
    var meta = total > 0
      ? _T('shell.wq.cacheMeta', '{n} 项 · 命中 {p}%', { n: String(d.mediaCount || 0), p: String(Math.round(hits / total * 100)) })
      : _T('shell.wq.cacheMetaNoHit', '{n} 项', { n: String(d.mediaCount || 0) });
    $mm.textContent = meta;
    var broken = Number(d.broken) || 0;
    if (broken > 0) {
      var sp = document.createElement('span');
      sp.className = 'qqq-wq-broken';
      sp.textContent = ' · ' + _T('shell.wq.cacheBroken', '熔断 {n}', { n: String(broken) });
      $mm.appendChild(sp);
    }
    // 转码缓存（2GB 上限）
    var pMax = Number(d.playMax) || 1;
    var pBytes = Number(d.playBytes) || 0;
    $pv.textContent = _fmtPair(pBytes, pMax);
    _setBar($pb, pBytes / pMax, pBytes / pMax > 0.9);
  }

  // ═══ 卡片定位 / 显隐 ═══
  function position() {
    if (!_card || !_$el) return;
    var r = _$el.getBoundingClientRect();
    var w = _card.offsetWidth || 264;
    var h = _card.offsetHeight || 170;
    var x = r.right - w + 4;
    if (x < 4) x = 4;
    var y = r.top - h - 10; // 恒上弹不遮状态区；空间不足贴顶
    if (y < 4) y = 4;
    _card.style.left = x + 'px';
    _card.style.top = y + 'px';
  }

  function show() {
    if (!_shown) {
      _ensureCard();
      if (_$el.offsetParent === null) return; // dense 退避隐藏中不弹
      _renderCard();
      position();
      _card.classList.add('qqq-wq-hover-show');
      _shown = true;
      _fetchCache();
      _startCacheTimer();
    } else {
      position();
    }
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  }

  function hide() {
    if (_pinned) return;
    if (!_shown) return;
    _card.classList.remove('qqq-wq-hover-show');
    _shown = false;
    _stopCacheTimer();
  }

  function hideSoon() {
    if (_pinned) return;
    if (_hideTimer) clearTimeout(_hideTimer);
    _hideTimer = setTimeout(hide, 350);
  }

  function closeCard() {
    _pinned = false;
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    if (_card) { _card.classList.remove('qqq-wq-hover-pinned'); _card.classList.remove('qqq-wq-hover-show'); }
    _shown = false;
    _stopCacheTimer();
  }

  // ═══ 缓存读数（壳层 IPC；桥缺失/旧壳层 → 显示 --，恢复后自动回填）═══
  function _fetchCache() {
    var b = window.qqqideBridge;
    if (!b || !b.media || !b.media.cacheStats) { _cacheData = null; _renderCache(); return; }
    if (_cacheFetching) return;
    _cacheFetching = true;
    Promise.resolve()
      .then(function () { return b.media.cacheStats(); })
      .then(function (d) { _cacheData = (d && d.ok) ? d : null; })
      .catch(function () { _cacheData = null; })
      .then(function () { _cacheFetching = false; if (_shown) _renderCache(); });
  }

  function _startCacheTimer() {
    if (_cacheTimer) return;
    _cacheTimer = setInterval(function () {
      if (!_shown) { _stopCacheTimer(); return; }
      _fetchCache();
    }, 5000);
  }

  function _stopCacheTimer() {
    if (_cacheTimer) { clearInterval(_cacheTimer); _cacheTimer = null; }
  }

  // ═══ 交互接线（一次）═══
  function _wire() {
    if (_wired) return;
    _wired = true;

    // 点卡片外任何区域 = 关闭（取消固定 + 立即隐藏）；卡片内 / 按钮自身除外
    function closeByOutsideClick() {
      if (!_shown) return;
      closeCard();
    }
    document.addEventListener('click', function (e) {
      if (!_shown) return;
      var t = e.target;
      if (_card && _card.contains(t)) return;
      if (_$el && (t === _$el || _$el.contains(t))) return;
      closeByOutsideClick();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _shown) closeByOutsideClick();
    });

    // 三面板/编辑器/goods/roam 均为独立 iframe document，主窗口 document click 收不到
    // iframe 内部点击 → 逐 iframe 绑定（同 MEM 卡机制，标记挂 document 防重复）
    function bindFrameClick(f) {
      var doc;
      try { doc = f.contentDocument; } catch (err) { return; } // 跨域尽力而为
      if (!doc || doc.__qqqWqBound) return;
      doc.__qqqWqBound = true;
      doc.addEventListener('click', closeByOutsideClick, true);
    }
    function hookFrames() {
      var fs = document.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i];
        if (!f.__qqqWqLoadHooked) {
          f.__qqqWqLoadHooked = true;
          f.addEventListener('load', function () { bindFrameClick(this); });
        }
        bindFrameClick(f);
      }
    }
    hookFrames();
    if (document.body && typeof MutationObserver !== 'undefined') {
      // ★ 2026-10-02 性能审计：body 级 childList 观察此前对一切文本/元素变更空跑（含每秒 tick 的
      //   文本节点替换）→ 过滤为「真含 iframe 的新增元素」才重扫 + rAF 合并同帧多次
      var _qfRaf = null;
      new MutationObserver(function (recs) {
        var hit = false;
        for (var i = 0; i < recs.length && !hit; i++) {
          var ns = recs[i].addedNodes;
          for (var j = 0; j < ns.length; j++) {
            var n = ns[j];
            if (n.nodeType === 1 && (n.tagName === 'IFRAME' || (n.querySelector && n.querySelector('iframe')))) { hit = true; break; }
          }
        }
        if (!hit || _qfRaf) return;
        _qfRaf = requestAnimationFrame(function () { _qfRaf = null; hookFrames(); });
      }).observe(document.body, { childList: true, subtree: true });
    }

    // 窗口 resize 跟随定位
    window.addEventListener('resize', function () { if (_shown) position(); });

    // dense 退避隐藏按钮 → 卡片同步消失；恢复时重新定位
    var area = document.querySelector('.qqq-status-area');
    if (area && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () {
        if (!_shown) return;
        if (_$el.offsetParent === null) { closeCard(); }
        else position();
      }).observe(area, { attributes: true, attributeFilter: ['class'] });
    }

    // 语言切换 → 卡片静态文案（构建期烧字）销毁重建，开着的保留开状态
    window.addEventListener('qqq-lang-change', function () {
      var wasShown = _shown;
      var wasPinned = _pinned;
      if (_card && _card.parentNode) _card.parentNode.removeChild(_card);
      _card = null;
      if (wasShown) {
        _ensureCard();
        _pinned = wasPinned;
        if (_pinned) _card.classList.add('qqq-wq-hover-pinned');
        _card.classList.add('qqq-wq-hover-show');
        _renderCard();
        position();
      }
    });
  }

  // ═══ 记录一次前摇时间（毫秒）═══
  // 异常过滤: <0.5ms 或 >1000ms 不参与统计
  function record(executionTimeMs) {
    _load();
    var t = Number(executionTimeMs);
    if (isNaN(t) || t < 0.5 || t > 1000) return;

    _totalTime += t;
    _count++;
    _recentTimes.push(t);
    if (_recentTimes.length > 7) _recentTimes.shift();
    if (t > _maxTime) _maxTime = t;

    _save();
    _updateDom();
  }

  function getSnapshot() {
    _load();
    var avg = _count > 0 ? Math.round(_totalTime / _count * 100) / 100 : 0;
    return {
      avg: avg,
      recent: _recentTimes.slice(),
      max: _maxTime,
      count: _count,
    };
  }

  function reset() {
    _totalTime = 0;
    _count = 0;
    _recentTimes = [];
    _maxTime = 0;
    _save();
    _updateDom();
  }

  // 格式化显示字符串（API 兼容保留）
  function format() {
    var s = getSnapshot();
    if (s.count === 0) return 'wq: --';
    return 'wq: ' + s.avg.toFixed(1) + 'ms avg (' + s.count + ')';
  }

  // ═══ 状态栏注入 ═══
  // ★ index.html 预置 <span id="qqq-status-wq">，固定宽按钮（迷你柱 + 均值）由本机填充。
  function injectStatusBar() {
    if (_$el) return;

    _$el = document.getElementById('qqq-status-wq');
    if (!_$el) {
      // HTML 里没有预置元素（异常），等 500ms 重试
      setTimeout(injectStatusBar, 500);
      return;
    }

    _$el.classList.add('qqq-wq-btn');
    _$el.innerHTML = '<svg class="qqq-wq-spark" width="20" height="12" viewBox="0 0 20 12" aria-hidden="true"></svg><span class="qqq-wq-val">--</span>';
    _$spark = _$el.querySelector('.qqq-wq-spark');
    _$val = _$el.querySelector('.qqq-wq-val');

    // 交互：hover 弹卡 / 点击钉住 / 点外关闭（旧「点击即重置」废除，重置在卡片内）
    _$el.addEventListener('mouseenter', show);
    _$el.addEventListener('mouseleave', hideSoon);
    _$el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!_pinned) {
        _pinned = true;
        _ensureCard();
        _card.classList.add('qqq-wq-hover-pinned');
        show();
      } else {
        closeCard();
      }
    });

    _wire();
    _updateDom();
  }

  // 页面加载完成后自动注入
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(injectStatusBar, 300);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(injectStatusBar, 300);
    });
  }

  window.qqqWqStats = {
    record: record,
    getSnapshot: getSnapshot,
    reset: reset,
    format: format,
    injectStatusBar: injectStatusBar,
  };

})();
