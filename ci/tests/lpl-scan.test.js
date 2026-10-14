// ci/tests/lpl-scan.test.js — 本地路径链接机（core/lpl.js）候选扫描回归守卫。
// lpl.js = 浏览器 IIFE（挂 window.linkifyLocalPaths/probeLocalPathLinks/qqqLpl）+ 尾部 module.exports 守卫。
// 守卫内容：C1 盘符绝对（含 file:/// 前缀整体成链）/ C2 相对（反斜杠形态恒可链；正斜杠仅「文件形」＝末段含
// 扩展名且扩展名含字母，md 预览 allowPosix 全放行）/ 行号后缀只链路径主体 / 行内代码整链 / 噪音闸不回潮
// （CJK 斜杠短语、比例 1/10、日期、无扩展名形态）；一切候选由主窗口存在性探针最终裁决。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Node 窗口桩：lpl.js 顶部以 typeof 守卫包裹窗口出口，先备桩再 require（node --test 单文件单进程，无污染）
global.window = { addEventListener() { }, qqqLpl: { config: { allowPosix: false, resolve: null } } };
global.document = { addEventListener() { } };
// 平台桩：C1b POSIX 绝对路径按「非 Windows」启用——测试固定为 mac 口径
//   （Node 22 自带 navigator.platform='Win32' 且为 getter——需 defineProperty 覆盖；不桩会关掉 C1b 分支）
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });

const lpl = require(path.join(__dirname, '..', '..', 'server-app', 'core', 'lpl.js'));
const CFG = global.window.qqqLpl.config;

function raws(text, mode) { return lpl.scanText(text, mode || 0).map((m) => m.raw); }
function spans(text, mode) { return lpl.scanText(text, mode || 0).map((m) => text.slice(m.start, m.end)); }
function codeTok(s) { return lpl.codeToken({ closest() { return null; }, textContent: s }); }

test('C2 正斜杠「文件形」放行（项目内文件正斜杠相对路径可链）', () => {
  assert.deepStrictEqual(
    raws('已存成纯文本文件：_qqq/genera/poster_qd_bullet_full_20261013_v2.txt 可精修'),
    ['_qqq/genera/poster_qd_bullet_full_20261013_v2.txt']);
  assert.deepStrictEqual(raws('见 server-app/core/lpl.js 第 1 行'), ['server-app/core/lpl.js']);
  assert.deepStrictEqual(raws('详见 do/拓扑/arch/更新与打包.txt'), ['do/拓扑/arch/更新与打包.txt']);
  assert.deepStrictEqual(
    codeTok('_qqq/genera/poster_qd_bullet_full_20261013_v2.txt'),
    { raw: '_qqq/genera/poster_qd_bullet_full_20261013_v2.txt', tail: '' });
});

test('噪音闸：CJK 斜杠短语 / 比例 / 日期 / 无扩展名形态 一律不链', () => {
  assert.deepStrictEqual(raws('包括持久化/重启恢复/多 等环节'), []);
  assert.deepStrictEqual(raws('不触发任何导航/裸窗口 的场景'), []);
  assert.deepStrictEqual(raws('内存占用约同类 1/10'), []);
  assert.deepStrictEqual(raws('日期 2026/10/14 记录'), []);
  assert.deepStrictEqual(raws('路径 a/b/c/d 不对'), []);
  assert.deepStrictEqual(raws('版本 v2/1.4 说明'), []);
  assert.deepStrictEqual(raws('去 do/拓扑 里找'), []);
  assert.strictEqual(codeTok('持久化/重启恢复/多'), null);
  assert.strictEqual(codeTok('a/b'), null);
});

test('回归：反斜杠与盘符绝对原样可链', () => {
  assert.deepStrictEqual(raws('见 do\\拓扑\\总纲.txt 铁律'), ['do\\拓扑\\总纲.txt']);
  assert.deepStrictEqual(
    raws('见 E:\\s\\wol\\py\\qqq-shell-v2\\do\\拓扑\\总纲.txt 全文'),
    ['E:\\s\\wol\\py\\qqq-shell-v2\\do\\拓扑\\总纲.txt']);
  assert.deepStrictEqual(codeTok('do\\拓扑\\总纲.txt'), { raw: 'do\\拓扑\\总纲.txt', tail: '' });
});

test('行号后缀：只链路径主体，后缀留纯文本', () => {
  assert.deepStrictEqual(spans('见 E:\\s\\wol\\py\\x.ts:120 处'), ['E:\\s\\wol\\py\\x.ts']);
  assert.deepStrictEqual(spans('见 server-app/core/lpl.js:120-140 处'), ['server-app/core/lpl.js']);
  assert.deepStrictEqual(raws('到 E:\\2026 里找'), ['E:\\2026']);   // 盘根目录名含数字：不误拆
  assert.deepStrictEqual(codeTok('_qqq/genera/x.txt:15'), { raw: '_qqq/genera/x.txt', tail: ':15' });
  assert.deepStrictEqual(codeTok('E:\\x\\y.ts:120-140'), { raw: 'E:\\x\\y.ts', tail: ':120-140' });
});

test('file:/// 前缀整体成链（正文与行内代码同规）', () => {
  assert.deepStrictEqual(raws('图在 file:///E:/s/wol/py/x.txt 这里'), ['file:///E:/s/wol/py/x.txt']);
  assert.deepStrictEqual(codeTok('file:///E:/s/wol/py/x.txt'), { raw: 'file:///E:/s/wol/py/x.txt', tail: '' });
});

test('URL 不误伤；网址形整串按候选交探针裁决', () => {
  assert.deepStrictEqual(raws('见 https://gh555.com/qd 官方'), []);
  // gh555.com/index.html：文件形候选——探针确认项目内真实存在才点亮，不存在还原纯文本（零假链）
  assert.deepStrictEqual(raws('打开 gh555.com/index.html 看看'), ['gh555.com/index.html']);
});

test('pre 模式：仅行首候选；行内代码中的代码片段不误链', () => {
  assert.deepStrictEqual(raws('前文 x/y.txt 不链', 1), []);
  assert.deepStrictEqual(raws('前一行\n_qqq/genera/x.txt\n后一行', 1), ['_qqq/genera/x.txt']);
  assert.strictEqual(codeTok("readFile('utf8')"), null);
});

test('md 预览语境（allowPosix=true）：正斜杠相对路径全放行', () => {
  CFG.allowPosix = true;
  try {
    assert.deepStrictEqual(raws('去 do/拓扑 里找'), ['do/拓扑']);
    assert.deepStrictEqual(codeTok('a/b'), { raw: 'a/b', tail: '' });
  } finally { CFG.allowPosix = false; }
});

test('C1b POSIX 绝对路径（mac/linux；测试环境非 Win 即启用）：正文/行内代码/行号后缀', () => {
  assert.deepStrictEqual(raws('图在 /Users/q/Desktop/shot.png 处'), ['/Users/q/Desktop/shot.png']);
  assert.deepStrictEqual(raws('日志 /var/log/system.log 看看'), ['/var/log/system.log']);
  assert.deepStrictEqual(spans('见 /Users/q/x.ts:120 处'), ['/Users/q/x.ts']);
  assert.deepStrictEqual(codeTok('/Users/q/x.png'), { raw: '/Users/q/x.png', tail: '' });
  // 单段（/tmp）/ 协议相对（//）/ 坏字符 → 不链
  assert.deepStrictEqual(raws('挂载点 /tmp 说明'), []);
  assert.deepStrictEqual(raws('开头双斜杠 //Users/q/x 测试'), []);
  assert.strictEqual(lpl.validPosixAbs('/Users/q/Desktop/x.png'), true);
  assert.strictEqual(lpl.validPosixAbs('//Users/q/x'), false);
  assert.strictEqual(lpl.validPosixAbs('/tmp'), false);
});

test('file:/// POSIX 形态：只剥 file://（第三斜杠留给路径）——正文与行内代码', () => {
  assert.deepStrictEqual(raws('图在 file:///Users/q/x.png 这里'), ['file:///Users/q/x.png']);
  assert.deepStrictEqual(codeTok('file:///Users/q/x.txt'), { raw: 'file:///Users/q/x.txt', tail: '' });
  assert.deepStrictEqual(codeTok('file:///Users/q/x.txt:15'), { raw: 'file:///Users/q/x.txt', tail: ':15' });
  // Windows 盘符形态照旧剥 8 字符（回归）——测试环境非 Win 也走盘符分支
  assert.deepStrictEqual(raws('图在 file:///E:/s/wol/py/x.txt 这里'), ['file:///E:/s/wol/py/x.txt']);
  assert.deepStrictEqual(codeTok('file:///E:/s/wol/py/x.txt'), { raw: 'file:///E:/s/wol/py/x.txt', tail: '' });
});
