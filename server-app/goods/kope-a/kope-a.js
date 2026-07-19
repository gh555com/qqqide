// ============================================================================
// goods/kope-a/kope-a.js — kope-a 剪贴板监控工具
// process-type goods: 无 A 区面板，仅后台进程 + 菜单管理
// ============================================================================
(function () {
  'use strict';

  const DEF = {
    id: 'kope-a',
    title: 'kope-a',
    type: 'process',
    lifecycle: 'independent',
    audio: { mode: 'independent' },
    allowMultiple: false,
    process: {
      script: 'goods/kope-a/q3.py',
      runtime: 'python',
    },
  };

  if (!window.qqqGaea) {
    window.addEventListener('DOMContentLoaded', () => {
      if (window.qqqGaea) window.qqqGaea.register(DEF);
    });
    return;
  }

  window.qqqGaea.register(DEF);
})();
