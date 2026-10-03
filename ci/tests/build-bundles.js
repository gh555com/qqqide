// ci/tests/build-bundles.js — 单测用 bundle 构建器。
// shell/*.ts（TS + electron 依赖）→ esbuild bundle（CJS，electron 以 stub 插件替换）→
// ci/tests/.build/*.cjs，供 *.test.js 直接 require。
// 纯 JS 的 server-app 文件（除 browser 全局守卫外无依赖）不经此步，测试里直接 require。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, '.build');
const STUB = path.join(__dirname, 'stubs', 'electron.js');

const ENTRIES = [
  { name: 'file-encoding', src: path.join(ROOT, 'shell', 'file-encoding.ts') },
  { name: 'player-info', src: path.join(ROOT, 'shell', 'player-info.ts') },
  { name: 'squad-manager', src: path.join(ROOT, 'shell', 'squad-manager.ts') },
  { name: 'search-proto', src: path.join(ROOT, 'shell', 'search-proto.ts') },
  { name: 'transcode-hw', src: path.join(ROOT, 'shell', 'transcode-hw.ts') },
  { name: 'player-prefs', src: path.join(ROOT, 'shell', 'player-prefs.ts') },
  { name: 'player-reveal', src: path.join(ROOT, 'shell', 'player-reveal.ts') },
  { name: 'paste-fetch', src: path.join(ROOT, 'shell', 'paste-fetch.ts') },
];

async function buildAll() {
  const esbuild = require('esbuild');
  fs.mkdirSync(OUT, { recursive: true });
  for (const e of ENTRIES) {
    await esbuild.build({
      entryPoints: [e.src],
      outfile: path.join(OUT, e.name + '.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node16',
      logLevel: 'warning',
      plugins: [{
        name: 'stub-electron',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: STUB }));
        },
      }],
    });
  }
  return true;
}

module.exports = { buildAll, OUT, ROOT };

if (require.main === module) {
  buildAll()
    .then(() => console.log('[build-bundles] ok →', OUT))
    .catch((e) => { console.error('[build-bundles] failed:', (e && e.message) || e); process.exit(1); });
}
