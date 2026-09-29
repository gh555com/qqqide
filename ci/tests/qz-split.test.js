// ci/tests/qz-split.test.js — Windows cmd 引号地狱分词状态机 + 数组 spawn 裁决
// 对象: server-app/ai-panel/tools-exec-effect.js（单测钩直出；浏览器零影响）
// 语义锚: 架构「qz spawn 管线」· 多行命令数组分流（cmd 嵌套引号配对错乱 = 静默失败）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const fx = require(path.join(ROOT, 'server-app', 'ai-panel', 'tools-exec-effect.js'));
const { _splitCmdLine, _unquoteCmdTok, _cmdArrayEligible } = fx;

// ── _splitCmdLine: POSIX 转义语义扫描（引号段内 \" 不关段）──

test('_splitCmdLine: 基础分词 + outer 采集引号外字符', () => {
  const r = _splitCmdLine('python script.py');
  assert.deepEqual(r.toks, ['python', 'script.py']);
  assert.equal(r.outer, 'pythonscript.py');
});

test('_splitCmdLine: 双引号段整体保留为单 token，outer 不计段内内容', () => {
  const r = _splitCmdLine('python -c "a b"');
  assert.deepEqual(r.toks, ['python', '-c', '"a b"']);
  assert.equal(r.outer, 'python-c');
});

test('_splitCmdLine: 引号段内 \\" 不关段（cmd 引号地狱核心）', () => {
  const r = _splitCmdLine('python -c "x=\\"y\\""');
  assert.deepEqual(r.toks, ['python', '-c', '"x=\\"y\\""']);
  assert.equal(r.outer, 'python-c');
});

test('_splitCmdLine: 单引号段不做转义处理（\\ 原样）', () => {
  const r = _splitCmdLine("echo 'a\\b'");
  assert.deepEqual(r.toks, ['echo', "'a\\b'"]);
});

test('_splitCmdLine: 未闭合引号吃到串尾', () => {
  const r = _splitCmdLine('echo "abc');
  assert.deepEqual(r.toks, ['echo', '"abc']);
});

test('_splitCmdLine: 空引号段保留为独立 token', () => {
  const r = _splitCmdLine('python ""');
  assert.deepEqual(r.toks, ['python', '""']);
});

test('_splitCmdLine: 引号紧贴 token（a"b c"d）', () => {
  const r = _splitCmdLine('a"b c"d');
  assert.deepEqual(r.toks, ['a', '"b c"', 'd']);
  assert.equal(r.outer, 'ad');
});

// ── _unquoteCmdTok: 仅 \" → " 解转义；\\ 保留（Windows 路径零破坏）──

test('_unquoteCmdTok: 双引号整段剥离', () => {
  assert.equal(_unquoteCmdTok('"a b"'), 'a b');
});

test('_unquoteCmdTok: 单引号整段剥离', () => {
  assert.equal(_unquoteCmdTok("'x y'"), 'x y');
});

test('_unquoteCmdTok: 非整段引号原样返回', () => {
  assert.equal(_unquoteCmdTok('a"b"'), 'a"b"');
  assert.equal(_unquoteCmdTok('plain'), 'plain');
});

test('_unquoteCmdTok: \\" 解转义为 "', () => {
  assert.equal(_unquoteCmdTok('"x=\\"y\\""'), 'x="y"');
});

test('_unquoteCmdTok: \\ 后非引号（如路径 \\d）原样保留', () => {
  assert.equal(_unquoteCmdTok('"C:\\dir\\x"'), 'C:\\dir\\x');
});

// ── _cmdArrayEligible: 数组 spawn（shell:false）唯一裁决点 ──

test('_cmdArrayEligible: 多行 python -c → 数组路径（cmd+args 已剥引号）', () => {
  const p = _cmdArrayEligible('python -c "print(1)\nprint(2)"');
  assert.ok(p, 'expected array-spawn plan');
  assert.equal(p.cmd, 'python');
  assert.deepEqual(p.args, ['-c', 'print(1)\nprint(2)']);
});

test('_cmdArrayEligible: 单行含 \\" 同样走数组路径', () => {
  const p = _cmdArrayEligible('python -c "x=\\"y\\""');
  assert.ok(p);
  assert.equal(p.cmd, 'python');
  assert.deepEqual(p.args, ['-c', 'x="y"']);
});

test('_cmdArrayEligible: 引号内元字符免检（& 在引号段内 → 仍走数组）', () => {
  const p = _cmdArrayEligible('python -c "echo a & b"');
  assert.ok(p);
  assert.deepEqual(p.args, ['-c', 'echo a & b']);
});

test('_cmdArrayEligible: 引号外 & 元字符 → null（回落整串 shell）', () => {
  assert.equal(_cmdArrayEligible('echo a & echo b\npython x'), null);
});

test('_cmdArrayEligible: 引号外 | 元字符 → null', () => {
  assert.equal(_cmdArrayEligible('python a | python b'), null);
});

test('_cmdArrayEligible: cd 开头 → null（cmd 内部命令）', () => {
  assert.equal(_cmdArrayEligible('cd /d C:\\x\npython y'), null);
});

test('_cmdArrayEligible: 其他 cmd 内部命令 → null', () => {
  assert.equal(_cmdArrayEligible('dir C:\\x\npython y'), null);
  assert.equal(_cmdArrayEligible('echo hello\npython y'), null);
});

test('_cmdArrayEligible: .bat/.cmd 脚本 → null（必须交 cmd 解析）', () => {
  assert.equal(_cmdArrayEligible('build.bat a\nb'), null);
  assert.equal(_cmdArrayEligible('run.CMD a\nb'), null);
});

test('_cmdArrayEligible: 单 token（无参数）→ null', () => {
  assert.equal(_cmdArrayEligible('python'), null);
});

test('_cmdArrayEligible: 纯单行无引号也返回计划（调用方本就不进此分支，函数语义本身自洽）', () => {
  const p = _cmdArrayEligible('python script.py');
  assert.ok(p);
  assert.deepEqual(p.args, ['script.py']);
});
