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
        label: '文件',
        sub: [
          { label: '新建', accel: 'CmdOrCtrl+N', cmd: 'file.new' },
          { label: '打开', accel: 'CmdOrCtrl+O', cmd: 'file.open' },
          { type: 'separator' },
          { label: '开新窗口', cmd: 'file.newWindow' },
          { type: 'separator' },
          { label: '退出', role: 'quit' },
        ],
      },
      {
        label: '工具',
        sub: [
          { label: '开发者工具', accel: 'F12', cmd: 'tools.toggleDevTools' },
        ],
      },
    ],
  };

  window.qqqDefaultMenuSchema = SCHEMA;
})();
