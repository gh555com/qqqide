// ============================================================================
// goods/window-there/window-there.js — window there 窗口布局管理
// process-type goods: 无 A 区面板，仅后台进程 + 菜单管理
// ============================================================================
(function () {
  'use strict';

  const DEF = {
    id: 'window-there',
    title: 'window there',
    type: 'process',
    lifecycle: 'attached',
    audio: { mode: 'ide' },
    process: {
      script: 'goods/window-there/q3.py',
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
