// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// ipc-bridge.js
// Renderer-side wrapper around window.qqqideBridge.* exposed by preload.
// Provides safe defaults for non-Electron environments (browser dev mode).
// ============================================================================

(function () {
  'use strict';

  // ★ preload.ts exposes as window.qqqideBridge (contextBridge key)
  const isElectron = typeof window !== 'undefined' && typeof window.qqqideBridge === 'object' && !!window.qqqideBridge;

  // Browser-mode stub so the page can be developed in a normal browser
  const stub = {
    fs: {
      read: () => Promise.reject(new Error('not in shell')),
      write: () => Promise.reject(new Error('not in shell')),
      list: () => Promise.resolve([]),
      stat: () => Promise.resolve(null),
      exists: () => Promise.resolve(false),
      drives: () => Promise.resolve(['C:\\']),
      diskFree: () => Promise.resolve({}),
      remove: () => Promise.resolve(true),
      rename: () => Promise.resolve(true),
      copyFile: () => Promise.resolve(true),
      mkdir: () => Promise.resolve(true),
    },
    dialog: {
      open: () => Promise.resolve({ canceled: true, filePaths: [] }),
      save: () => Promise.resolve({ canceled: true, filePath: '' }),
      message: () => Promise.resolve({ response: 0 }),
    },
    window: {
      minimize: () => { }, maximize: () => { }, unmaximize: () => { },
      close: () => window.close(), closeConfirmed: () => { window.close(); }, onCloseConfirm: () => () => {},
      isMaximized: () => Promise.resolve(false),
      setTitle: s => { document.title = s; },
    },
    menu: {
      set: () => Promise.resolve(true),
      onFired: () => () => { },
    },
    monaco: {
      create: () => Promise.resolve(0),
      open: () => Promise.resolve(true),
      save: () => Promise.resolve(true),
      dispose: () => Promise.resolve(true),
    },
    engine: {
      invoke: () => Promise.reject(new Error('not in shell')),
      isAlive: () => Promise.resolve(false),
    },
    audio: {
      play: () => Promise.resolve(true),
      stop: () => Promise.resolve(true),
      invoke: () => Promise.reject(new Error('not in shell')),
      isAlive: () => Promise.resolve(false),
    },
    clipboard: {
      probe: () => Promise.resolve({ hasText: false, hasHtml: false, hasImage: false, hasFile: false, _rawFormats: [] }),
      readText: () => Promise.resolve(''),
      writeText: () => Promise.resolve(true),
      readImage: () => Promise.resolve(null),
      hasImage: () => Promise.resolve(false),
      readHtml: () => Promise.resolve(''),
      readFiles: () => Promise.resolve([]),
      writeFiles: () => Promise.resolve(false),
    },
    shell: {
      openExternal: u => { window.open(u, '_blank'); },
      openPath: () => Promise.resolve(''),
    },
    ghrun: {
      exec: () => Promise.reject(new Error('not in shell')),
      isAlive: () => Promise.resolve(false),
    },
    boot: {
      getInfo: () => Promise.resolve({
        url: location.href,
        version: 'browser-dev',
        platform: 'browser',
        arch: 'na',
        appRoot: '',
        userData: '',
        cacheDir: '',
        logsDir: '',
        engineAlive: false,
        bootMode: 'live',
      }),
      retry: () => { location.reload(); return Promise.resolve(true); },
      probe: () => Promise.resolve(true),
    },
    roam: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(true),
      getAll: () => Promise.resolve({}),
      onChanged: () => () => {},
    },
  };

  // ★ Trick: preload exposeInMainWorld 的 key 是 'qqqideBridge'，
  //    但在 contextIsolation 下 window.qqqideBridge 指向 preload 注入的真实桥，
  //    而这里赋值会覆盖它。所以我们在 isElectron 时保留 window.qqqideBridge 不动。
  if (!isElectron) {
    window.qqqideBridge = stub;
  }
  window.qqqIsElectron = isElectron;
})();
