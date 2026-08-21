// mem-warning.js — 主进程内存看门狗告警接收（crash-net 广播 qqqide:mem:warning）
// 2026-08-20: F51 性能审计落地 —— heapUsed≥1.5GB → qoast 建议重启窗口（1h 冷却由主进程控制）
(function () {
  'use strict';
  try {
    if (!window.qqqideBridge || !window.qqqideBridge.mem || !window.qqqideBridge.mem.onWarning) return;
    window.qqqideBridge.mem.onWarning(function (data) {
      var heapGB = (data && data.heapMB ? data.heapMB / 1024 : 1.5).toFixed(1);
      var rssGB = (data && data.rssMB ? data.rssMB / 1024 : 0).toFixed(1);
      var msg = '主进程内存偏高（堆 ' + heapGB + 'GB / 总 ' + rssGB + 'GB），建议重启窗口释放内存';
      if (window.qqqideQoast) {
        var q = window.qqqideQoast.show(msg, {
          duration: 0,
          type: 'warning',
          action: { label: '知道了', onClick: function () { try { q.dismiss(); } catch (_) {} } },
        });
      } else {
        console.warn('[mem-warning]', msg);
      }
    });
  } catch (e) { console.warn('[mem-warning] init failed:', e); }
})();
