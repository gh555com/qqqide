// ============================================================================
// menu-schema.js - default native menu schema sent to shell on boot.
// Keep MINIMAL. Most actions are surface DOM, native menu only for OS-level
// items (cut/copy/paste, devtools, quit) and rare power-user shortcuts.
// ============================================================================

(function () {
  'use strict';

  const SCHEMA = {
    items: [
      {
        label: 'qqqide',
        sub: [
          { label: '开新窗口', i18n: 'shell.menu.fileNewWindow', cmd: 'file.newWindow', hasRecent: true },
          { label: '导师', i18n: 'shell.menu.evangelist', cmd: 'evangelist.designate', hasEvangelistSub: true },
          { label: '激活', i18n: 'shell.menu.activate', cmd: 'file.activate', hasActivation: true },
          { label: '退出', i18n: 'shell.menu.fileExit', cmd: 'file.exit' },
        ],
      },
      {
        label: '的梦gaea',
        sub: [
          { label: 'kope-a', cmd: 'gaea.kopeA', hasGaeaProcess: 'kope-a', gpScript: 'goods/kope-a/q3.py', gpRuntime: 'python', gpLifecycle: 'independent', gpAllowMultiple: false },
          { label: 'window there', cmd: 'gaea.windowThere', hasGaeaProcess: 'window-there', gpScript: 'goods/window-there/q3.py', gpRuntime: 'python', gpLifecycle: 'attached', gpAllowMultiple: false },
        ],
      },
    ],
  };

  window.qqqDefaultMenuSchema = SCHEMA;
})();
