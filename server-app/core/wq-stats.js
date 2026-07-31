// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// wq-stats.js — 前摇统计器（探针性能追踪）
//
// 照搬 q3 global.js 的 saveWqStats 逻辑。
// 追踪 klipzap.probe() 的执行时间，统计平均/最近7次/历史最大。
//
// API:
//   wqStats.record(executionTimeMs)  — 记录一次前摇
//   wqStats.getSnapshot()            — 返回 { avg, recent, max, count }
//   wqStats.reset()                  — 重置统计
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

  // 记录一次前摇时间（毫秒）
  // 异常过滤: <1ms 或 >1000ms 不参与统计
  function record(executionTimeMs) {
    _load();
    var t = Number(executionTimeMs);
    if (isNaN(t) || t < 1 || t > 1000) return;

    _totalTime += t;
    _count++;
    _recentTimes.push(t);
    if (_recentTimes.length > 7) _recentTimes.shift();
    if (t > _maxTime) _maxTime = t;

    _save();
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
  }

  // 格式化显示字符串（用于状态栏）
  function format() {
    var s = getSnapshot();
    if (s.count === 0) return 'wq: --';
    return 'wq: ' + s.avg.toFixed(1) + 'ms avg (' + s.count + ')';
  }

  window.qqqWqStats = {
    record: record,
    getSnapshot: getSnapshot,
    reset: reset,
    format: format,
  };

})();
