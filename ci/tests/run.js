// ci/tests/run.js — `npm test` 编排器。
// ① 构建 TS 单测 bundle（esbuild）→ ② node --test 跑 ci/tests/*.test.js 全量。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

(async () => {
  const { buildAll } = require('./build-bundles.js');
  try {
    await buildAll();
  } catch (e) {
    console.error('[npm test] bundle build failed:', (e && e.message) || e);
    process.exit(1);
  }
  const files = fs.readdirSync(__dirname)
    .filter((f) => /\.test\.js$/.test(f))
    .sort()
    .map((f) => path.join(__dirname, f));
  if (!files.length) {
    console.error('[npm test] no *.test.js files found');
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
})();
