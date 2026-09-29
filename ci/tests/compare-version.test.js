// ci/tests/compare-version.test.js — C 启动器 compareVersion 语义数字段比较（源级差分测试）
// 对象: launcher/launcher.c（唯一真理源——从源码提取函数 → 现场编译 → 逐例差分）
// 语义锚: 铁律 §2.1「版本 = 清单编号…比较仅发生在 C 启动器（compareVersion 语义数字段）」
//   防反向升级：必须按数字段比较（"0.3.9" < "0.3.48"），字符串排序会判反。
//
// 诚实边界: launcher/ 属私有部件（不入公开仓）→ 公开 CI 检出无此文件；本机无 C 编译器时
//   同样跳过。两种情况都显式报 skip（绝不假装通过）。结构契约破坏（函数消失/被改写）→ 测试红。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, '.build');
const LAUNCHER_C = path.join(ROOT, 'launcher', 'launcher.c');

// ── C 编译器探测（找不到 → 跳过，绝不假装通过）──
function findCompiler() {
  const cands = process.platform === 'win32'
    ? ['gcc', 'cc',
      'C:/msys64/mingw64/bin/gcc.exe', 'C:/msys64/usr/bin/gcc.exe',
      'C:/mingw64/bin/gcc.exe', 'C:/ProgramData/chocolatey/bin/gcc.exe']
    : ['cc', 'gcc'];
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0 && /gcc|clang/i.test(String(r.stdout || ''))) return c;
  }
  return null;
}

// ── 从 launcher.c 提取 compareVersion（结构契约破坏必须让测试红，不许静默）──
function extractCompareVersion() {
  const src = fs.readFileSync(LAUNCHER_C, 'utf8');
  const m = /static int compareVersion\(const char \*a, const char \*b\) \{[\s\S]*?\n\}/.exec(src);
  if (!m) throw new Error('compareVersion() not found in launcher/launcher.c — extraction contract broken');
  const fn = m[0];
  if (fn.indexOf('return na > nb ? 1 : -1;') < 0) {
    throw new Error('compareVersion() body changed shape — update this test with the new semantics');
  }
  return fn;
}

// ── 现场编译（.build/ 下临时产物）──
function buildHarness(compiler) {
  fs.mkdirSync(OUT, { recursive: true });
  const csrc = path.join(OUT, 'compareVersion.harness.c');
  const exe = path.join(OUT, 'compareVersion.harness' + (process.platform === 'win32' ? '.exe' : ''));
  const src = [
    '#include <stdio.h>',
    '#include <string.h>',
    extractCompareVersion(),
    'int main(int argc, char **argv) {',
    '    if (argc < 3) { fprintf(stderr, "usage: prog a b\\n"); return 2; }',
    '    printf("%d\\n", compareVersion(argv[1], argv[2]));',
    '    return 0;',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(csrc, src, 'utf8');
  const cc = spawnSync(compiler, ['-O2', '-o', exe, csrc], { encoding: 'utf8', timeout: 90000 });
  if (cc.status !== 0) {
    throw new Error('C harness compile failed via ' + compiler + ':\n' + String(cc.stderr || cc.stdout || ''));
  }
  return exe;
}

// 用例 = 真实版本号语义（含铁律点名的「0.3.9 vs 0.3.48」字符串陷阱）
const CASES = [
  ['0.2.335', '0.2.332', 1],
  ['0.2.332', '0.2.335', -1],
  ['0.2.50', '0.2.50', 0],
  ['0.3.9', '0.3.48', -1],   // 字符串排序会判 "0.3.9" > "0.3.48" —— 语义比较必须 9 < 48
  ['0.3.48', '0.3.9', 1],
  ['0.10.0', '0.9.9', 1],
  ['1.2.3', '1.10.0', -1],
  ['1.0', '1', 0],           // 缺段按 0
  ['1.0.1', '1', 1],
  ['0.2.50', '0.2.50.0', 0], // 尾随 .0 等值
  ['1.2.3', '1.2.3', 0],
];

const haveSrc = fs.existsSync(LAUNCHER_C);
const compiler = haveSrc ? findCompiler() : null;
let skip = false;
if (!haveSrc) skip = 'launcher/launcher.c not in this checkout (private component)';
else if (!compiler) skip = 'no C compiler found on this machine';

test('compareVersion: 语义数字段比较（launcher.c 源级差分）', { skip }, () => {
  const exe = buildHarness(compiler);
  for (const [a, b, want] of CASES) {
    const r = spawnSync(exe, [a, b], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, 'harness exit for (' + a + ', ' + b + '): ' + String(r.stderr || ''));
    const got = parseInt(String(r.stdout).trim(), 10);
    assert.equal(got, want, 'compareVersion("' + a + '", "' + b + '") = ' + got + ', want ' + want);
  }
});
