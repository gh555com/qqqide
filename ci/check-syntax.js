#!/usr/bin/env node
/**
 * ci/check-syntax.js — JS 语法静态门（零依赖）
 *
 * 对 server-app / shell-build / ci 下全部 .js|.cjs|.mjs 逐文件执行 `node --check`，
 * 任一文件语法错误 → 退出码 1（CI 阻断）。第三方 vendor 与构建缓存跳过。
 *
 * 本地用法: npm run check:syntax
 * CI 入口:  .github/workflows/static-checks.yml
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['server-app', 'shell-build', 'ci'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'engines', '_cache', '__pycache__', '.build']);
const EXT_RE = /\.(js|cjs|mjs)$/;

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile() && EXT_RE.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

const started = Date.now();
const files = [];
for (const t of TARGETS) walk(path.join(ROOT, t), files);

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed.push({ file: f, msg: String(r.stderr || r.stdout || '').trim() });
  }
}

console.log(
  `[syntax] ${files.length} files checked (${TARGETS.join(', ')}), ` +
  `${failed.length} failed, ${Date.now() - started}ms`
);

for (const { file, msg } of failed) {
  console.error(`\nFAIL ${rel(file)}`);
  for (const line of msg.split(/\r?\n/).slice(0, 8)) console.error('  ' + line);
}

if (failed.length) {
  console.error(`\n[syntax] FAILED — ${failed.length} file(s) with syntax errors`);
  process.exit(1);
}
console.log('[syntax] OK');
