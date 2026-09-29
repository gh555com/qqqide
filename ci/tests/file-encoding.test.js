// ci/tests/file-encoding.test.js — 文本编码机器三态检测（BOM / 严格 UTF-8 / GBK 兜底）
// 对象: shell/file-encoding.ts（esbuild bundle → .build/file-encoding.cjs）
// 语义锚: do/消除乱码 · 铁律 §8.1（检测链 BOM(utf8/utf16le/be) → 严格 UTF-8 fatal → GBK）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fx = require(path.join(__dirname, '.build', 'file-encoding.cjs'));

// 「中文」的两种字节形态（检测分流的关键证据）
const CN_UTF8 = Buffer.from([0xE4, 0xB8, 0xAD, 0xE6, 0x96, 0x87]); // 中 文
const CN_GBK = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]);               // 中 文

test('detectEncoding: UTF-8 BOM → utf8 + bom=true', () => {
  const r = fx.detectEncoding(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), CN_UTF8]));
  assert.equal(r.enc, 'utf8');
  assert.equal(r.bom, true);
});

test('detectEncoding: UTF-16LE BOM → utf16le + bom=true', () => {
  const r = fx.detectEncoding(Buffer.from([0xFF, 0xFE, 0x41, 0x00]));
  assert.equal(r.enc, 'utf16le');
  assert.equal(r.bom, true);
});

test('detectEncoding: UTF-16BE BOM → utf16be + bom=true', () => {
  const r = fx.detectEncoding(Buffer.from([0xFE, 0xFF, 0x00, 0x41]));
  assert.equal(r.enc, 'utf16be');
  assert.equal(r.bom, true);
});

test('detectEncoding: 纯 ASCII → utf8 无 BOM', () => {
  const r = fx.detectEncoding(Buffer.from('hello world', 'utf8'));
  assert.equal(r.enc, 'utf8');
  assert.equal(r.bom, false);
});

test('detectEncoding: 合法 UTF-8 中文 → utf8（严格 fatal 解码通过）', () => {
  const r = fx.detectEncoding(CN_UTF8);
  assert.equal(r.enc, 'utf8');
  assert.equal(r.bom, false);
});

test('detectEncoding: GBK 字节（非法 UTF-8）→ gbk 兜底', () => {
  const r = fx.detectEncoding(CN_GBK);
  assert.equal(r.enc, 'gbk');
  assert.equal(r.bom, false);
});

test('detectEncoding: 空缓冲 → utf8 无 BOM（安全默认）', () => {
  const r = fx.detectEncoding(Buffer.alloc(0));
  assert.equal(r.enc, 'utf8');
  assert.equal(r.bom, false);
});

test('encodeText: utf8 + BOM 前缀字节序列固定 EF BB BF', () => {
  const b = fx.encodeText('utf8', true, '中');
  assert.deepEqual([...b.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.equal(b.subarray(3).toString('utf8'), '中');
});

test('encodeText: utf16be 无 BOM → 字节序正确（A=00 41 / 中=4E 2D）', () => {
  assert.deepEqual([...fx.encodeText('utf16be', false, 'A')], [0x00, 0x41]);
  assert.deepEqual([...fx.encodeText('utf16be', false, '中')], [0x4E, 0x2D]);
});

test('encodeText: utf16le 无 BOM → 字节序正确（中=2D 4E）', () => {
  assert.deepEqual([...fx.encodeText('utf16le', false, '中')], [0x2D, 0x4E]);
});

test('encodeText: gbk 编码产出与已知字节一致（roundtrip 字节级）', () => {
  assert.deepEqual([...fx.encodeText('gbk', false, '中文')], [...CN_GBK]);
});

test('encLabel: 已知编码标签唯一映射', () => {
  assert.equal(fx.encLabel('utf8'), 'UTF-8');
  assert.equal(fx.encLabel('gbk'), 'GBK');
  assert.equal(fx.encLabel('utf16be'), 'UTF-16 BE');
});
