// char-undo：逐字回退的深度 / 上限 / 超限停摆 —— 阈值与边界回归钉子
//   契约（详 do/拓扑/arch/编辑器与粘贴.txt「撤销保障」节）：
//     ① 200 条 + 单快照 3M 字符（Monaco）/ 10 万字符（输入框）+ 历史字符总预算 128M / 8M（双闸裁剪，每次只丢最老 1 条）
//     ② 正文超单快照上限 → 本机整体停摆（不记账、不拦截 Ctrl+Z/Y，交编辑器原生）——两档同规（Monaco 与输入框）
//     ③ 回落上限内 → 以当前文本重新武装，栈底那一下继续放行原生（不留无效键）
//     ④ 语义恒为「一次内容变更 = 一条全文快照」——mark()（粘贴相框/锚点）必须可撤
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server-app', 'core', 'char-undo.js'), 'utf8');

function load() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.Event = class Event {
    constructor(type, o) { this.type = type; this.bubbles = !!(o && o.bubbles); }
  };
  sandbox.document = {
    readyState: 'complete',
    body: null,
    addEventListener() { },
    removeEventListener() { }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'char-undo.js' });
  return sandbox.window.qqqCharUndo;
}

const MONACO = { KeyCode: { KeyZ: 90, KeyY: 89 } };

// 假编辑器：内容 / 变更事件 / 键盘事件 / 最小编辑区 applyEdits 全真语义
function makeEditor(initial) {
  let text = initial;
  const listeners = { change: [], keydown: [] };
  function posAt(off) {
    const before = text.slice(0, off);
    const nl = before.lastIndexOf('\n');
    return { lineNumber: before.split('\n').length, column: off - nl };
  }
  function offAt(p) {
    const lines = text.split('\n');
    let off = 0;
    for (let i = 0; i < p.lineNumber - 1; i++) off += lines[i].length + 1;
    return off + p.column - 1;
  }
  const model = {
    isDisposed: () => false,
    getValueLength: () => text.length,
    getPositionAt: posAt,
    applyEdits: (ops) => {
      for (const op of ops) {
        const r = op.range;
        const s = offAt({ lineNumber: r.startLineNumber, column: r.startColumn });
        const e = offAt({ lineNumber: r.endLineNumber, column: r.endColumn });
        text = text.slice(0, s) + op.text + text.slice(e);
      }
      listeners.change.forEach((f) => f());
    }
  };
  return {
    _isRefreshing: false,
    _globalRefreshLock: false,
    onDidChangeModelContent: (f) => { listeners.change.push(f); return { dispose() { } }; },
    onKeyDown: (f) => { listeners.keydown.push(f); return { dispose() { } }; },
    getModel: () => model,
    getValue: () => text,
    setValue: (v) => { text = v; listeners.change.forEach((f) => f()); },
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    setPosition: () => { },
    getScrollTop: () => 0,
    setScrollTop: () => { },
    // 测试操作
    _type: (s) => { text += s; listeners.change.forEach((f) => f()); },
    _set: (v) => { text = v; listeners.change.forEach((f) => f()); },
    _key: (keyCode, shift) => {
      let prevented = false;
      listeners.keydown.forEach((f) => f({
        ctrlKey: true, metaKey: false, shiftKey: !!shift, keyCode,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { }
      }));
      return prevented;   // true = 本机拦截；false = 放行原生
    },
    _len: () => text.length
  };
}

test('逐字回退：深度 200 条（含当前态 → 可撤 199 步），撤销与重做对称', () => {
  const U = load();
  const ed = makeEditor('');
  U.attachMonaco(ed, MONACO, { ceilChars: 3000000 });
  for (let i = 0; i < 400; i++) ed._type('x');   // 远超上限 → 必须靠裁剪压住
  let steps = 0;
  while (U.canUndo(ed)) { U.undo(ed); steps++; }
  assert.strictEqual(steps, 199, '可撤步数必须恰好 199（200 条快照含当前态）');
  assert.ok(ed._len() <= 201, '撤到底必须回到最初附近');
  let rs = 0;
  while (U.canRedo(ed)) { U.redo(ed); rs++; }
  assert.strictEqual(ed._len(), 400, '重做必须回到 400 字符');
  assert.strictEqual(rs, 199);
});

test('逐字回退：字符总预算 128M —— 大文件深度平滑收敛，且至少保留 1 步', () => {
  const U = load();
  const ed = makeEditor('a'.repeat(1000000));     // 100 万字符正文
  U.attachMonaco(ed, MONACO, { ceilChars: 3000000 });
  for (let i = 0; i < 160; i++) ed._type('b');
  let steps = 0;
  while (U.canUndo(ed)) { U.undo(ed); steps++; }
  assert.ok(steps >= 110 && steps <= 150, '100 万字符正文深度应落在预算内（≈127 步），实测 ' + steps);
  assert.ok(steps >= 1, '预算再紧也必须保留至少 1 步');
});

test('逐字回退：超上限停摆 —— 不记账不拦截，交编辑器原生撤销', () => {
  const U = load();
  const ed = makeEditor('start');
  U.attachMonaco(ed, MONACO, { ceilChars: 3000000 });
  ed._type('x');
  assert.strictEqual(U.canUndo(ed), true, '上限内必须正常记账');

  ed._set('z'.repeat(3100000));                   // 撑爆单快照上限
  assert.strictEqual(U.canUndo(ed), false, '超限后本机停摆（不得留下半截历史）');
  assert.strictEqual(ed._key(MONACO.KeyCode.KeyZ), false, '超限态 Ctrl+Z 必须放行原生（禁静默失效）');
  assert.strictEqual(ed._key(MONACO.KeyCode.KeyY), false, '超限态 Ctrl+Y 必须放行原生');

  ed._set('y'.repeat(1000000));                   // 回落上限内
  assert.strictEqual(U.canUndo(ed), false, '回落后重新武装（旧历史不可信）');
  assert.strictEqual(ed._key(MONACO.KeyCode.KeyZ), false, '回落栈底这一下仍放行原生');

  ed._type('q');                                  // 真编辑 → 恢复拦截
  assert.strictEqual(U.canUndo(ed), true);
  assert.strictEqual(ed._key(MONACO.KeyCode.KeyZ), true, '恢复记账后必须自己拦截');
  assert.strictEqual(ed._len(), 1000000, '撤销必须回到上一快照长度');
});

test('逐字回退：上限边界 —— 恰好 3M 可记录，3M+1 即停摆', () => {
  const U = load();
  const ed = makeEditor('a'.repeat(3000000));
  U.attachMonaco(ed, MONACO, { ceilChars: 3000000 });
  ed._type('b');                                  // 3,000,001 字符
  assert.strictEqual(U.canUndo(ed), false, '超 1 字符即停摆');
  assert.strictEqual(ed._key(MONACO.KeyCode.KeyZ), false);
  ed._set('a'.repeat(2999999));
  ed._type('c');                                  // 回到 3M 以内
  assert.strictEqual(U.canUndo(ed), true, '回到上限内必须恢复记账');
});

test('程序化插入（粘贴相框/重命名锚点）：mark() 后必须可撤，且撤销走最小编辑区', () => {
  const U = load();
  const ed = makeEditor('hello');
  U.attachMonaco(ed, MONACO, { ceilChars: 3000000 });
  U.suppressOnce(ed);                             // 模拟：变更事件被抑制窗口吞掉
  ed._set('hello 📎abc:"x.png"');
  assert.strictEqual(U.mark(ed), true, 'mark() 必须强制记账');
  assert.strictEqual(U.canUndo(ed), true);
  U.undo(ed);
  assert.strictEqual(ed.getValue(), 'hello', '撤销必须回到粘贴前正文');
});

// ── 原生输入框（input/textarea）档：同规限额与停摆 ──
function makeInput(initial) {
  return {
    tagName: 'TEXTAREA',
    value: initial,
    selectionStart: initial.length,
    _l: { input: [], keydown: [] },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    removeEventListener(t, f) { const a = this._l[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    setSelectionRange(p) { this.selectionStart = p; },
    dispatchEvent(ev) { (this._l[ev.type] || []).slice().forEach((f) => f(ev)); return true; }
  };
}
function typeN(el, s) {
  el.value += s; el.selectionStart = el.value.length; el.dispatchEvent({ type: 'input' });
}
function keyN(el, key, shift) {
  let prevented = false;
  el.dispatchEvent({
    type: 'keydown', ctrlKey: true, metaKey: false, shiftKey: !!shift, key,
    preventDefault() { prevented = true; }, stopPropagation() { }
  });
  return prevented;   // true = 本机拦截；false = 放行浏览器原生
}

test('逐字回退（输入框）：小正文逐字撤销/重做对称', () => {
  const U = load();
  const ta = makeInput('');
  U.attach(ta);
  typeN(ta, 'a'); typeN(ta, 'b'); typeN(ta, 'c');
  assert.strictEqual(keyN(ta, 'z'), true);
  assert.strictEqual(ta.value, 'ab');
  keyN(ta, 'z'); keyN(ta, 'z');
  assert.strictEqual(ta.value, '');
  keyN(ta, 'y'); keyN(ta, 'y'); keyN(ta, 'y');
  assert.strictEqual(ta.value, 'abc', '重做必须回到 abc');
});

test('逐字回退（输入框）：超单框上限 → 停摆放行原生；回落后重新武装', () => {
  const U = load();
  const ta = makeInput('a'.repeat(100000));
  U.attach(ta);
  typeN(ta, 'b');                                 // 100,001 字符 → 超上限
  assert.strictEqual(U.canUndo(ta), false, '超限后本机停摆（不得留下半截历史）');
  assert.strictEqual(keyN(ta, 'z'), false, '超限态 Ctrl+Z 必须放行原生（禁静默失效）');
  assert.strictEqual(keyN(ta, 'y'), false, '超限态 Ctrl+Y 必须放行原生');

  ta.value = 'c'.repeat(90000); ta.selectionStart = 90000; ta.dispatchEvent({ type: 'input' });
  assert.strictEqual(U.canUndo(ta), false, '回落后重新武装（旧历史不可信）');
  assert.strictEqual(keyN(ta, 'z'), false, '回落栈底这一下仍放行原生');

  typeN(ta, 'd');
  assert.strictEqual(U.canUndo(ta), true);
  assert.strictEqual(keyN(ta, 'z'), true, '恢复记账后必须自己拦截');
  assert.strictEqual(ta.value.length, 90000, '撤销必须回到上一快照长度');
});

test('逐字回退（输入框）：8M 字符总预算 —— 9 万字符正文按预算收窄（约 92 步）', () => {
  const U = load();
  const ta = makeInput('a'.repeat(90000));
  U.attach(ta);
  for (let i = 0; i < 150; i++) typeN(ta, 'b');   // 90,150 —— 始终在单框上限内
  let steps = 0;
  while (U.canUndo(ta)) { U.undo(ta); steps++; }
  assert.ok(steps >= 70 && steps <= 115, '9 万字符正文深度应落在预算内（≈92 步），实测 ' + steps);
});

test('撤销后再次输入 → 重做分支必须截断', () => {
  const U = load();
  const ed = makeEditor('');
  U.attachMonaco(ed, MONACO, { ceilChars: 3000000 });
  ed._type('a'); ed._type('b'); ed._type('c');
  U.undo(ed); U.undo(ed);
  assert.strictEqual(ed.getValue(), 'a');
  ed._type('Z');
  assert.strictEqual(U.canRedo(ed), false, '分支必须被截断');
});
