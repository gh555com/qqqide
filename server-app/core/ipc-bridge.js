// ============================================================================
// ipc-bridge.js
// Renderer-side wrapper around window.qqqide.* exposed by preload.
// Provides safe defaults for non-Electron environments (browser dev mode).
// ============================================================================

(function () {
  'use strict';

  const isElectron = typeof window !== 'undefined' && !!window.qqqide;

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
    },
    dialog: {
      open: () => Promise.resolve({ canceled: true, filePaths: [] }),
      save: () => Promise.resolve({ canceled: true, filePath: '' }),
      message: () => Promise.resolve({ response: 0 }),
    },
    window: {
      minimize: () => {}, maximize: () => {}, unmaximize: () => {},
      close: () => window.close(), isMaximized: () => Promise.resolve(false),
      setTitle: s => { document.title = s; },
    },
    menu: {
      set: () => Promise.resolve(true),
      onFired: () => () => {},
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
  };

  window.qqqideBridge = isElectron ? window.qqqide : stub;
  window.qqqIsElectron = isElectron;
})();
