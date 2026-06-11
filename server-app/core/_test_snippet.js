(function () {
  'use strict';

  const isElectron = !!window.qqqIsElectron;
  const bridge = window.qqqideBridge;

  // ── qzlsp §10 Plan A: 配置 TypeScript Worker 编译选项 ──
  // Monaco 内置 TS Worker 默认 moduleResolution=Classic 且无 @types/node�?  // 会导�?Node.js 内置模块飘红(false positive) 和类型检查裸�?false negative)�?  // 此处注入编译选项 + Node 模块声明，对齐项�?tsconfig.json�?  var _tsConfigured = false;
  function configureMonacoTypescript(monaco) {
    if (_tsConfigured) return;
    _tsConfigured = true;
    var _tsDefaults = monaco.languages.typescript.typescriptDefaults;
    _tsDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      noImplicitAny: false,
      lib: ['ES2020', 'DOM'],
    });
    // 注入 Node.js 内置模块声明，消�?"Cannot find module 'http'" 等误�?    _tsDefaults.addExtraLib(
      'declare module "http" { const m: any; export = m; }\n' +
      'declare module "https" { const m: any; export = m; }\n' +
      'declare module "fs" { const m: any; export = m; }\n' +
      'declare module "path" { const m: any; export = m; }\n' +
      'declare module "crypto" { const m: any; export = m; }\n' +
      'declare module "url" { const m: any; export = m; }\n' +
      'declare module "stream" { const m: any; export = m; }\n' +
      'declare module "events" { const m: any; export = m; }\n' +
      'declare module "child_process" { const m: any; export = m; }\n' +
      'declare module "net" { const m: any; export = m; }\n' +
      'declare module "electron" { const m: any; export = m; }\n',
      'ts:node-builtins.d.ts'
    );
  }