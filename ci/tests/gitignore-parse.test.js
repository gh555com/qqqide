// ci/tests/gitignore-parse.test.js — git check-ignore 输出解析三态（真命中 / 未命中 / 空模式伪命中）
// 对象: server-app/core/ensure-gitignore.js（单测钩直出；浏览器零影响）
// 语义锚: 实测坑——部分 git 对「未命中」回显 .gitignore:<空行>:\t<path>（模式为空）→ 必须判未忽略
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const fx = require(path.join(ROOT, 'server-app', 'core', 'ensure-gitignore.js'));
const { _parseCheckIgnoreOut } = fx;

test('真命中（有行号 + 模式非空）→ true', () => {
  assert.equal(_parseCheckIgnoreOut('.gitignore:73:_qqq/\t_qqq/'), true);
});

test('明确未忽略（:: 前缀，-n 回显）→ false', () => {
  assert.equal(_parseCheckIgnoreOut('::\t_qqq/'), false);
});

test('空模式伪命中（.gitignore:<空行>:）→ false（实测坑）', () => {
  assert.equal(_parseCheckIgnoreOut('.gitignore:55:\t_qqq/'), false);
});

test('空输出 / 纯空白 → null（未知，调用方放弃本次）', () => {
  assert.equal(_parseCheckIgnoreOut(''), null);
  assert.equal(_parseCheckIgnoreOut('   \n  '), null);
});

test('非字符串输入 → null（防御）', () => {
  assert.equal(_parseCheckIgnoreOut(undefined), null);
  assert.equal(_parseCheckIgnoreOut(null), null);
  assert.equal(_parseCheckIgnoreOut(42), null);
});

test('无 tab 行 → null', () => {
  assert.equal(_parseCheckIgnoreOut('something'), null);
  assert.equal(_parseCheckIgnoreOut('::'), null);
});

test('异常格式（无行号）→ false（不以忽略论）', () => {
  assert.equal(_parseCheckIgnoreOut('notaformat\tpath'), false);
});

test('前导空行跳过后取首个有效判定行', () => {
  assert.equal(_parseCheckIgnoreOut('\n.gitignore:1:_qqq/\t_qqq/'), true);
});

test('多行输出以首个有效判定行为准', () => {
  assert.equal(_parseCheckIgnoreOut('.gitignore:5:_qqqvault/\t_qqqvault/\n.gitignore:9:tmp/\ttmp/'), true);
});
