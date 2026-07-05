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
        label: 'qqq IDE',
        sub: [
          { label: '开新窗口', i18n: 'shell.menu.fileNewWindow', cmd: 'file.newWindow', hasRecent: true },
          { label: '开发者工具', i18n: 'shell.menu.devTools', cmd: 'tools.toggleDevTools' },
          { label: '退出', i18n: 'shell.menu.fileExit', cmd: 'file.exit' },
        ],
      },
      {
        label: '的梦gaea',
        sub: [
          { label: 'kope-a', cmd: 'gaea.kopeA', hasKopeA: true },
        ],
      },
    ],
  };

  window.qqqDefaultMenuSchema = SCHEMA;
})();
