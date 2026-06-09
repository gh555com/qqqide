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
        label: '文件', i18n: 'shell.menu.file',
        sub: [
          { label: '新建', i18n: 'shell.menu.fileNew', accel: 'CmdOrCtrl+N', cmd: 'file.new' },
          { label: '打开', i18n: 'shell.menu.fileOpen', accel: 'CmdOrCtrl+O', cmd: 'file.open' },
          { type: 'separator' },
          { label: '开新窗口', i18n: 'shell.menu.fileNewWindow', cmd: 'file.newWindow' },
          { type: 'separator' },
          { label: '退出', i18n: 'shell.menu.fileExit', cmd: 'file.exit' },
        ],
      },
      {
        label: '工具', i18n: 'shell.menu.tools',
        sub: [
          { label: '开发者工具', i18n: 'shell.menu.devTools', accel: 'F12', cmd: 'tools.toggleDevTools' },
        ],
      },
    ],
  };

  window.qqqDefaultMenuSchema = SCHEMA;
})();
