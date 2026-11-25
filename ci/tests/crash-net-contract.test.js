// ci/tests/crash-net-contract.test.js — 崩溃记录网契约守卫。
// 三处曾经真出过问题（都是静默的，靠人肉翻日志才发现）：
//   ① 报告内嵌事件：boot 事件里带着上一份 report，report 里又嵌 tailEvents…
//      → events.log 逐次指数膨胀（实测 27 条事件已 177KB），8MB 轮转线撑不了几天，
//        等于把真正的死因证据冲掉。
//   ② 绿色包由启动器拉起，没有 stdout 管道：主进程 console.* 全部落空 →
//      跨模块溯源只能靠散落各处的专用日志，等于全瞎。
//   ③ 退出时 stdout 断裂（EPIPE）被记成 uncaught-exception：每次退出都记一次假崩溃 +
//      拍一张快照 + 污染稳定性计数（实测 ue=8 全是它），真正的 uncaught 反而被淹没。
// 守卫：报告必瘦身 / console 落盘唯一入口挂在 init / EPIPE 不进台账 / 退出源标签覆盖全部退出入口。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(R, rel), 'utf8');
const CN = read('shell/crash-net.ts');

test('报告：tailEvents / lastEvent 必过 _slimEvent（禁再嵌结构）', () => {
  assert.ok(CN.indexOf('return _slimEvent(JSON.parse(l))') > 0,
    'tailEvents 未瘦身 —— boot 事件内嵌上一份 report 会指数膨胀');
  assert.ok(CN.indexOf('report.lastEvent = report.tailEvents[report.tailEvents.length - 1]') > 0,
    'lastEvent 未取自瘦身后的 tailEvents');
  assert.ok(!/report\.lastEvent = last;/.test(CN), 'lastEvent 回潮成完整事件（嵌套炸弹）');
  assert.ok(/function _slimEvent\(e: any\)/.test(CN), '_slimEvent 实现缺失');
});

test('console：落盘 sink 唯一入口，且在 init 最前挂上', () => {
  const i = CN.indexOf('export function installMainLogSink(');
  assert.ok(i > 0, 'installMainLogSink 缺失');
  assert.ok(CN.indexOf("installMainLogSink(path.join(userData, 'Logs'))") > 0,
    'crashNetInit 未挂 console sink（主进程文本溯源只剩零散日志）');
  assert.ok(/if \(_conInstalled \|\| !logsDir\) return;/.test(CN), 'sink 未做幂等（重复挂 = 双重写盘）');
  assert.ok(CN.indexOf("orig.apply(console, args)") > 0, '原 console 行为必须保留');
});

test('EPIPE：stdout 断裂不算崩溃（不进台账 / 不拍快照）', () => {
  const h = CN.indexOf("process.on('uncaughtException'");
  assert.ok(h > 0, 'uncaughtException 处理器缺失');
  const body = CN.slice(h, CN.indexOf('\n    });', h));   // 处理器体一直取到同级收口（内层 `});` 会误截）
  const epipe = body.indexOf("indexOf('EPIPE')");
  const note = body.indexOf("_appendEvent('uncaught-exception'");
  assert.ok(epipe > 0, 'EPIPE / ECONNRESET 抑制缺失');
  assert.ok(note > epipe, '抑制行之后才记账 —— 抑制无效');
  assert.ok(body.indexOf('crashNetSnapshot') > epipe, 'EPIPE 仍会拍快照');
});

test('退出源：每个退出入口都先声明来源（先声明者为准）', () => {
  const sites = [
    ['shell/ipc-misc.ts', 'quit-all-ipc'],
    ['shell/shutdown.ts', 'window-all-closed'],
    ['shell/shutdown.ts', 'signal-sigint'],
    ['shell/shutdown.ts', 'signal-sigterm'],
    ['shell/main.ts', 'second-instance'],
    ['shell/main.ts', 'forced-update'],
    ['shell/mac-updater.ts', 'mac-update-restart'],
  ];
  for (const [file, label] of sites) {
    assert.ok(read(file).indexOf("crashNetNoteQuitSource('" + label + "')") > 0,
      file + ' 退出未声明来源：' + label);
  }
  assert.ok(CN.indexOf('if (!src || _quitSrc) return;') > 0, '来源必须首次声明为准');
});

test('clean-quit：带 src / from / uptimeSec，且分类判定仍只认标记是否存在', () => {
  const i = CN.indexOf("_atomicWrite('clean-quit.json'");
  assert.ok(i > 0, 'clean-quit.json 写入缺失');
  const payload = CN.slice(i, CN.indexOf('}));', i));
  for (const k of ['src', 'from', 'uptimeSec']) {
    assert.ok(payload.indexOf(k) > 0, 'clean-quit 缺字段：' + k);
  }
  assert.ok(/report\.cleanSrc = cq\.src \|\| ''/.test(CN), 'recovery-report 未带 cleanSrc');
  // ★ 分类判定不变：src 只做归因，绝不用来改判 clean/abnormal
  assert.ok(/if \(cleanExists\) \{\s*report\.lastExit = 'clean';/.test(CN),
    'clean 判定被改写成条件式（会制造假告警）');
  assert.ok(!/lastExit = 'abnormal';[\s\S]{0,80}src/.test(CN), 'abnormal 判定混入了来源标签');
});
