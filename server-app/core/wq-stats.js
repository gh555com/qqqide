// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// wq-stats.js — 前摇统计器（探针性能追踪 + 状态栏显示）
//
// 照搬 q3 global.js 的 saveWqStats 逻辑。
// 追踪 klipzap.probe() 的执行时间，统计平均/最近7次/历史最大。
//
// API:
//   wqStats.record(executionTimeMs)  — 记录一次前摇
//   wqStats.getSnapshot()            — 返回 { avg, recent, max, count }
//   wqStats.reset()                  — 重置统计
//   wqStats.injectStatusBar()        — 自动注入状态栏显示（页面加载后调用一次）
//
// 持久化: qgs.simple('qqq-wq-stats') 项目级
// ============================================================================

(function () {
  'use strict';

  var _totalTime = 0;
  var _count = 0;
  var _recentTimes = [];  // 最近 7 次
  var _maxTime = 0;
  var _initialized = false;
  var _$el = null;        // 状态栏 DOM 元素

  var NS = 'qqq-wq-stats';

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

  function _updateDom() {
    if (!_$el) return;
    var s = getSnapshot();
    if (s.count === 0) {
      _$el.textContent = 'wq: --';
      return;
    }
    var recentStr = s.recent.map(function (t) { return t.toFixed(0); }).join(' ');
    _$el.textContent = 'wq: ' + s.avg.toFixed(1) + 'ms avg (' + s.count + ') [' + recentStr + ']';

    // 颜色：超过 20ms 变橙，超过 50ms 变红
    if (s.avg > 50) {
      _$el.style.color = '#dc322f';
    } else if (s.avg > 20) {
      _$el.style.color = '#b58900';
    } else {
      _$el.style.color = '';
    }
  }

  // 记录一次前摇时间（毫秒）
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

  // 格式化显示字符串（用于状态栏）
  function format() {
    var s = getSnapshot();
    if (s.count === 0) return 'wq: --';
    return 'wq: ' + s.avg.toFixed(1) + 'ms avg (' + s.count + ')';
  }

  // ═══ 状态栏注入 ═══
  // 在 qqq-status-row 中创建 qqq-status-wq 元素，显示前摇统计
  function injectStatusBar() {
    if (_$el) return; // 已注入

    var row = document.querySelector('.qqq-status-row');
    if (!row) {
      // 状态栏还没渲染，等 500ms 重试
      setTimeout(injectStatusBar, 500);
      return;
    }

    // 在时钟元素前插入
    var $clk = document.getElementById('qqq-status-clock');
    _$el = document.createElement('span');
    _$el.className = 'qqq-status-item';
    _$el.id = 'qqq-status-wq';
    _$el.style.cssText = 'font-family:Consolas,monospace;font-size:11px;cursor:pointer;';
    _$el.title = 'wq 前摇统计：粘贴探针执行时间\n点击重置';
    _$el.textContent = 'wq: --';

    _$el.addEventListener('click', function () {
      reset();
      if (window.qqqideQoast) {
        window.qqqideQoast.show('wq stats reset', { duration: 1500 });
      }
    });

    if ($clk) {
      row.insertBefore(_$el, $clk);
    } else {
      row.appendChild(_$el);
    }

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
