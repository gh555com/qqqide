// ci/tests/stubs/electron.js — esbuild 别名目标: 让 shell/*.ts 在纯 Node 单测里可加载。
// 单测只触碰纯函数；Electron API 仅被模块顶层「引用」、不被调用 → 最小 stub 足够。
// （squad-manager.ts / file-encoding.ts 的 ipcMain.handle、BrowserWindow 调用都发生在
//   函数体内，加载期不执行。）
'use strict';

module.exports = {
  app: {
    getLocale: () => 'en',
    getPath: () => require('os').tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  ipcMain: {
    handle() { },
    on() { },
    removeHandler() { },
    emit() { },
  },
  BrowserWindow: class BrowserWindow {
    static fromId() { return null; }
    static getAllWindows() { return []; }
  },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: {},
  shell: {},
  screen: {},
  session: {},
  webContents: {},
  safeStorage: { isEncryptionAvailable: () => false },
  powerMonitor: { on() { } },
};
