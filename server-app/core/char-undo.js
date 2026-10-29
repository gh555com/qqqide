// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// char-undo.js — 唯一真理逐字回退机器
//
// 覆盖范围：
//   <input> / <textarea> — snapshot 快照（value + cursor pos），200 条 / 单框 10 万字符 + 8M 字符总预算
//   Monaco Editor         — snapshot 快照（value + cursor pos + scrollTop），200 条 / 3M 字符上限
//                            条数之外另设字符总预算（budgetChars = 128M 字符）——大文件宁可少存几步，
//                            也不让撤消栈撑爆渲染进程内存（详见 _trimHistory）
//
// 快捷键：
//   Ctrl+Z → 逐字回退  Ctrl+Y → 逐字重做
//
// API：
//   window.qqqCharUndo.attach(el, opts)        — 挂载到原生 input/textarea
//   window.qqqCharUndo.attachMonaco(ed, monaco, opts) — 挂载到 Monaco 编辑器
//   window.qqqCharUndo.detach(el)              — 卸载
//   window.qqqCharUndo.reset(el)               — 重置历史（如消息发送后）
//   window.qqqCharUndo.suppressOnce(el)        — 标记下次变更为程序化（跳过记录；仅同任务内同步消耗有效，自动过期）
//   window.qqqCharUndo.mark(el)                — 强制记账：当前值入快照（程序化插入的可撤回保障；幂等）
//   window.qqqCharUndo.canUndo(el)             — 是否可回退
//   window.qqqCharUndo.canRedo(el)             — 是否可重做
//   window.qqqCharUndo.autoAttach(root)        — 扫描 root 下所有 input/textarea 并挂载
//
// 铁律：
//   · 接入 §3 配色机器，不自定义颜色
//   · 不触碰 cursor 样式（§19）
//   · 兼容 key-hook.js（不拦截非编辑区 Ctrl+Z）
//   · 禁差分存储：每条快照自持全文（相框/锚点/外部校准鲁棒性都绑在这一点上）；记忆开销只靠预算裁剪
//   · 程序化插入可撤回保障：插入后必须显式 mark()——变更事件会被抑制窗口（刷新/外部重载/suppressOnce）
//     吞掉 → 快照丢失 → Ctrl+Z 静默失效；suppressOnce 标记自动过期，防泄漏吞掉用户下一次真实编辑
//   · 超上限不静默：正文超 ceilChars 时本机整体停摆（不记账不拦截），Ctrl+Z/Y 全交编辑器原生——
//     禁「按键无反应」；回到上限内自动以当前文本重新武装（原生输入框同一套语义）
// ============================================================================

(function () {
  'use strict';

  // ── 配置常量 ──
  var NATIVE_MAX_HISTORY = 200;
  var NATIVE_CEIL_CHARS = 100000;        // 单框正文超此长度不记快照（长提示词同样要有逐字回退）
  var NATIVE_HISTORY_BUDGET_CHARS = 8 * 1024 * 1024;   // 200 × 10 万 = 20M > 预算 → 大框按预算收窄
  var MONACO_MAX_HISTORY = 200;
  var MONACO_CEIL_CHARS = 3000000; // 300 万字符（纯英文 ≈3MB / 纯汉字 ≈9MB）
  // 历史字符总预算（存着的字符串长度合计；UTF-16 上界 = 2 字节/字符 → 最坏 256MB/编辑器）：
  //   3M 字符正文 ≈ 42 步 · 2M ≈ 64 步 · 1M ≈ 128 步 · ≤640K = 满 200 步
  //   —— 换深度不换语义：仍全是全文快照，粘贴相框/锚点链路零改动；
  //   升预算 = 直接翻最坏内存，动这个数先算「预算 × 2 字节」。
  var MONACO_HISTORY_BUDGET_CHARS = 128 * 1024 * 1024;

  // ── 状态存储：WeakMap<element, state> ──
  var _states = typeof WeakMap !== 'undefined' ? new WeakMap() : (function () {
    // WeakMap polyfill fallback: use a hidden property
    var key = '__qqq_char_undo_state__';
    return {
      get: function (el) { return el[key]; },
      set: function (el, st) { el[key] = st; },
      delete: function (el) { delete el[key]; },
      has: function (el) { return !!el[key]; }
    };
  })();

  // ── 快照推入（Monaco / 原生共用；变更监听与 mark 同源，防行为漂移）──
  function _pushEntry(state, v, pos, scrollTop) {
    if (typeof v !== 'string' || v.length > state.ceilChars) return false;
    if (state.index < state.history.length - 1) {
      state.history = state.history.slice(0, state.index + 1);
    }
    var last = state.history[state.history.length - 1];
    if (last && v === last.val) return false;
    state.history.push({ val: v, pos: pos, scrollTop: scrollTop });
    state.index = state.history.length - 1;
    _trimHistory(state);
    return true;
  }

  // ── 历史裁剪：条数上限 + 字符总预算（双闸）──
  //   ★ 每次只丢最老的一条（不再一刀砍半）→ 深度平稳，不会出现「到顶那一下只剩一半」。
  //   ★ 预算只约束「存着的快照」总量，不影响单步撤销语义：仍然一条 = 一次内容变更。
  //   丢弃恒从最老端开始，且至少保留 1 条（当前位）——push 后 index 恒为末条。
  function _trimHistory(state) {
    var n = state.history.length;
    var chars = 0, i;
    for (i = 0; i < n; i++) chars += state.history[i].val.length;
    var drop = 0;
    while ((n - drop) > 1 &&
           ((n - drop) > state.maxHistory || (state.budgetChars > 0 && chars > state.budgetChars))) {
      chars -= state.history[drop].val.length;
      drop++;
    }
    if (drop > 0) {
      state.history = state.history.slice(drop);
      state.index = state.history.length - 1;
    }
  }

  // ── 程序化标记（suppressOnce / 快照回放的变更不入账）──
  //   ★ 自动过期：仅当标记后「同任务内」真的发生变更（同步事件消耗）才有效；
  //   未被消耗（目标内容相同无事件 / applyEdits 抛错等）→ 下一拍作废——
  //   否则残留标记会吞掉用户的下一次真实编辑（粘贴快照丢失 → Ctrl+Z 静默失效）。
  function _armProg(state) {
    state.prog = true;
    if (state._progTimer) { try { clearTimeout(state._progTimer); } catch (_) { } }
    state._progTimer = setTimeout(function () {
      state._progTimer = null;
      state.prog = false;
    }, 0);
  }

  // ── Monaco 值恢复 = 最小编辑区（公共前缀/后缀收缩）──
  //   ★ 禁 setValue：setValue = 全文档 flush 替换（模型装饰全销毁 + 全区巨型变更事件）——
  //   WYSIWYG 相框/隐藏令牌/codelens 全部被推倒重来 → 每次 Ctrl+Z 整屏闪烁（相框多的文档会炸）。
  //   最小编辑 = 普通增量变更事件：视口机器只按受影响区间更新，区间外相框零重建零位移。
  //   model 不可用等异常路径回落全域替换（setValue）——语义等价，仅贵。
  function _applyMonacoVal(ed, monacoRef, val) {
    var cur = '';
    try { cur = ed.getValue() || ''; } catch (e0) { return false; }
    if (cur === val) return true;
    var model = null;
    try { model = (typeof ed.getModel === 'function') ? ed.getModel() : null; } catch (e1) { model = null; }
    if (!model || (typeof model.isDisposed === 'function' && model.isDisposed()) ||
        typeof model.getPositionAt !== 'function' || typeof model.applyEdits !== 'function') {
      try { ed.setValue(val); return true; } catch (e2) { return false; }
    }
    var op = null;
    try {
      // 公共前缀 / 公共后缀 → 最小替换区（撤销一个字符 = 一个字符的编辑）
      var minLen = Math.min(cur.length, val.length);
      var pre = 0;
      while (pre < minLen && cur.charCodeAt(pre) === val.charCodeAt(pre)) pre++;
      var maxSuf = Math.min(cur.length - pre, val.length - pre);
      var suf = 0;
      while (suf < maxSuf && cur.charCodeAt(cur.length - 1 - suf) === val.charCodeAt(val.length - 1 - suf)) suf++;
      var sp = model.getPositionAt(pre);
      var ep = model.getPositionAt(cur.length - suf);
      var range = { startLineNumber: sp.lineNumber, startColumn: sp.column, endLineNumber: ep.lineNumber, endColumn: ep.column };
      if (monacoRef && monacoRef.Range) {
        range = new monacoRef.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
      }
      op = { range: range, text: val.slice(pre, val.length - suf), forceMoveMarkers: true };
    } catch (e3) { op = null; }
    if (!op) { try { ed.setValue(val); return true; } catch (e4) { return false; } }
    // 直接走 model.applyEdits（computeUndoEdits 默 false）：内容变更照发事件，但不污染原生撤销栈
    //（与 editor.js 外部重载同口径；光标/滚动由调用方显式恢复）
    var ok = false;
    try { model.applyEdits([op], false); ok = true; } catch (e5) { ok = false; }
    if (!ok) {
      try { ed.setValue(val); return true; } catch (e6) { return false; }
    }
    return true;
  }

  // ── MutationObserver 自动挂载 ──
  var _observer = null;
  var _observedRoots = [];

  function _startObserver() {
    if (_observer) return;
    if (typeof MutationObserver === 'undefined') return;
    _observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var addedNodes = mutations[i].addedNodes;
        for (var j = 0; j < addedNodes.length; j++) {
          var node = addedNodes[j];
          if (node.nodeType === 1) {
            autoAttach(node);
          }
        }
      }
    });
    // Observe body as soon as it exists
    if (document.body) {
      _observer.observe(document.body, { childList: true, subtree: true });
      _observedRoots.push(document.body);
    } else {
      // Wait for DOMContentLoaded
      var _dcb = function () {
        if (_observer && document.body) {
          _observer.observe(document.body, { childList: true, subtree: true });
          _observedRoots.push(document.body);
        }
        document.removeEventListener('DOMContentLoaded', _dcb);
      };
      document.addEventListener('DOMContentLoaded', _dcb);
    }
  }

  // ── 检查是否在 Monaco 编辑器内 ──
  function _isInsideMonaco(el) {
    var p = el;
    while (p) {
      if (p.classList && (p.classList.contains('monaco-editor') || p.classList.contains('inputarea'))) {
        return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  // ── 检查是否已有 char-undo 挂载 ──
  function _hasState(el) {
    return _states.has(el);
  }

  // ── 确认元素是否可挂载 ──
  function _isAttachable(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    return (tag === 'INPUT' || tag === 'TEXTAREA');
  }

  // ── 原生 input/textarea 挂载 ──
  function attach(el, opts) {
    if (!el || !_isAttachable(el)) return false;
    // 跳过 Monaco 内部的 textarea
    if (_isInsideMonaco(el)) return false;

    // 如果已挂载，只更新 onChange 回调
    if (_hasState(el)) {
      if (opts && typeof opts.onChange === 'function') {
        _states.get(el).onChange = opts.onChange;
      }
      return true;
    }

    opts = opts || {};
    var maxHistory = opts.maxHistory || NATIVE_MAX_HISTORY;
    var ceilChars = opts.ceilChars || NATIVE_CEIL_CHARS;
    var onChange = opts.onChange || null;

    var initialState = el.value || '';
    var initialPos = el.selectionStart || 0;
    var initialOverCeil = initialState.length > ceilChars;

    var state = {
      history: initialOverCeil ? [] : [{ val: initialState, pos: initialPos }],
      index: 0,
      prog: false,
      onChange: onChange,
      maxHistory: maxHistory,
      ceilChars: ceilChars,
      overCeil: initialOverCeil,
      armFromShrink: false,
      budgetChars: NATIVE_HISTORY_BUDGET_CHARS
    };
    _states.set(el, state);

    function onInput() {
      if (state.prog) { state.prog = false; return; }
      var v = el.value || '';
      // ★ 超上限（长正文）：本机整体停摆——不记账、不拦截，Ctrl+Z 全交浏览器原生（禁按键静默失效）
      if (v.length > state.ceilChars) {
        if (!state.overCeil) {
          state.overCeil = true;
          state.armFromShrink = false;
          state.history = [];
          state.index = 0;
        }
        if (state.onChange) state.onChange();
        return;
      }
      // 回到上限内：停摆期间变更未记账 → 旧历史不可信，以当前值为准重新武装
      if (state.overCeil) {
        state.overCeil = false;
        state.armFromShrink = true;
        state.history = [{ val: v, pos: el.selectionStart }];
        state.index = 0;
        if (state.onChange) state.onChange();
        return;
      }
      state.armFromShrink = false;
      _pushEntry(state, v, el.selectionStart, 0);
      if (state.onChange) state.onChange();
    }

    // 撤销/重做一步（原生档）：同一处实现，禁三处复制
    function _nativeStep(back) {
      var n = state.history.length;
      if (back) {
        if (state.index <= 0) return false;
        state.index--;
      } else {
        if (state.index >= n - 1) return false;
        state.index++;
      }
      _armProg(state);
      var entry = state.history[state.index];
      el.value = entry.val;
      el.setSelectionRange(entry.pos, entry.pos);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    function onKeydown(e) {
      // 停摆态（超上限）：一律放行浏览器原生撤销/重做（禁 preventDefault）
      if (state.overCeil) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      var k = e.key;
      var back = false, isZ = (k === 'z' || k === 'Z'), isY = (k === 'y' || k === 'Y');
      if (!isZ && !isY) return;
      back = isZ && !e.shiftKey;               // Ctrl+Z / Ctrl+Shift+Z→redo / Ctrl+Y→redo
      if (_nativeStep(back)) {
        e.preventDefault(); e.stopPropagation();
        state.armFromShrink = false;
        return;
      }
      // 走不动：恰由超上限回落重新武装 → 栈底这一下放行原生（不留无效键）；否则吞掉（禁回退到陈旧值）
      if (state.armFromShrink) return;
      e.preventDefault(); e.stopPropagation();
    }

    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKeydown);

    // 便利方法：兼容旧 _resetUndo 调用
    el._resetUndo = function () {
      reset(el);
    };

    // 存储清理函数
    el.__charUndoCleanup = function () {
      el.removeEventListener('input', onInput);
      el.removeEventListener('keydown', onKeydown);
      delete el._resetUndo;
      _states.delete(el);
    };

    return true;
  }

  // ── Monaco 编辑器挂载 ──
  function attachMonaco(editor, monaco, opts) {
    if (!editor || !monaco || _hasState(editor)) return false;

    opts = opts || {};
    var maxHistory = opts.maxHistory || MONACO_MAX_HISTORY;
    var ceilChars = opts.ceilChars || MONACO_CEIL_CHARS;
    var budgetChars = opts.budgetChars || MONACO_HISTORY_BUDGET_CHARS;

    var initialVal = '';
    var initialOverCeil = false;
    try {
      // 先用 getValueLength（O(1)、零分配）判上限；超大文件连首个全文快照都不存
      var _im = (typeof editor.getModel === 'function') ? editor.getModel() : null;
      if (_im && typeof _im.getValueLength === 'function' && _im.getValueLength() > ceilChars) {
        initialOverCeil = true;
      } else {
        initialVal = editor.getValue() || '';
        if (initialVal.length > ceilChars) { initialOverCeil = true; initialVal = ''; }
      }
    } catch (e) { /* ignore */ }
    var initialPos = { line: 1, col: 1 };
    var initialScroll = 0;
    try {
      var pos = editor.getPosition();
      if (pos) initialPos = { line: pos.lineNumber, col: pos.column };
      initialScroll = editor.getScrollTop();
    } catch (e) { /* ignore */ }

    var state = {
      history: initialOverCeil ? [] : [{ val: initialVal, pos: initialPos, scrollTop: initialScroll }],
      index: 0,
      prog: false,
      overCeil: initialOverCeil,
      armFromShrink: false,
      maxHistory: maxHistory,
      ceilChars: ceilChars,
      budgetChars: budgetChars
    };
    _states.set(editor, state);

    // 监听内容变更 → 记录快照
    var onChangeDisposable = editor.onDidChangeModelContent(function () {
      if (state.prog) { state.prog = false; return; }
      // 检查 _isRefreshing / 全局刷新锁（refreshLiveContent / 外部修改重载 / 跨窗口脏快照）
      if (editor._isRefreshing || editor._globalRefreshLock || window.__qqqGlobalRefreshLock) return;

      // ★ 超上限（超大文件）：本机整体停摆——不记账、不拦截，Ctrl+Z/Y 全让 Monaco 原生接管。
      //   禁「按键无反应」：拦截了却推不进快照 = 逐字回退对这篇文档静默失效。
      //   长度先走 getValueLength（O(1)、零分配）——大文件每敲一键不拷全文。
      var len = -1;
      try {
        var _m = (typeof editor.getModel === 'function') ? editor.getModel() : null;
        if (_m && typeof _m.getValueLength === 'function') len = _m.getValueLength();
      } catch (e0) { len = -1; }
      if (len > state.ceilChars) {
        if (!state.overCeil) {
          state.overCeil = true;
          state.armFromShrink = false;
          state.history = [];
          state.index = 0;
        }
        return;
      }
      var v = '';
      try { v = editor.getValue() || ''; } catch (e) { return; }
      var pos = { line: 1, col: 1 };
      var st = 0;
      try {
        var p = editor.getPosition();
        if (p) pos = { line: p.lineNumber, col: p.column };
        st = editor.getScrollTop();
      } catch (e) { /* ignore */ }
      if (v.length > state.ceilChars) {   // getValueLength 与正文字符数有 EOL 差异 → 精确复核
        if (!state.overCeil) {
          state.overCeil = true;
          state.armFromShrink = false;
          state.history = [];
          state.index = 0;
        }
        return;
      }
      // 回到上限内：停摆期间变更未记账 → 旧历史不可信，以当前文本重新武装；
      // armFromShrink 让「栈底再按一次」放行原生，不以一个无效键收尾
      if (state.overCeil) {
        state.overCeil = false;
        state.armFromShrink = true;
        state.history = [{ val: v, pos: pos, scrollTop: st }];
        state.index = 0;
        return;
      }
      state.armFromShrink = false;
      _pushEntry(state, v, pos, st);
    });

    // 拦截 Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
    var onKeyDownDisposable = editor.onKeyDown(function (e) {
      // 停摆态（超上限）：一律放行 Monaco 原生撤销/重做（禁 preventDefault）
      if (state.overCeil) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      var isZ = e.keyCode === monaco.KeyCode.KeyZ;
      var isY = e.keyCode === monaco.KeyCode.KeyY;
      if (!isZ && !isY) return;
      var back = (isZ && !e.shiftKey);          // Ctrl+Z / Shift+Ctrl+Z→redo / Ctrl+Y→redo
      var canMove = back ? (state.index > 0)
                         : (state.index >= 0 && state.index < state.history.length - 1);
      if (!canMove) {
        // 恰由超大回落重新武装：栈底这一下放行，交原生继续（不留无效键）
        if (state.armFromShrink) return;
        e.preventDefault(); e.stopPropagation();
        return;
      }
      e.preventDefault(); e.stopPropagation();
      state.armFromShrink = false;
      state.index += back ? -1 : 1;
      _applyMonacoSnapshot(editor, state);
    });

    function _applyMonacoSnapshot(ed, st) {
      _armProg(st);
      var entry = st.history[st.index];
      try {
        _applyMonacoVal(ed, monaco, entry.val);
        if (entry.pos) {
          ed.setPosition({ lineNumber: entry.pos.line, column: entry.pos.col });
        }
        ed.setScrollTop(entry.scrollTop || 0);
      } catch (e) { /* ignore */ }
    }

    // 便利方法
    editor._resetUndo = function () {
      reset(editor);
    };

    // 存储清理
    editor.__charUndoCleanup = function () {
      try { onChangeDisposable.dispose(); } catch (e) { /* ignore */ }
      try { onKeyDownDisposable.dispose(); } catch (e) { /* ignore */ }
      delete editor._resetUndo;
      _states.delete(editor);
    };

    return true;
  }

  // ── 卸载 ──
  function detach(el) {
    if (!el || !_hasState(el)) return false;
    if (typeof el.__charUndoCleanup === 'function') {
      el.__charUndoCleanup();
      delete el.__charUndoCleanup;
    }
    return true;
  }

  // ── 重置历史（消息发送后、切换 quest 后） ──
  function reset(el) {
    var state = _states.get(el);
    if (!state) return;
    var v = '';
    var pos = 0;
    // 区分原生元素和 Monaco
    var isNative = !!(el.tagName && (el.tagName.toUpperCase() === 'INPUT' || el.tagName.toUpperCase() === 'TEXTAREA'));
    if (isNative) {
      v = el.value || '';
      pos = el.selectionStart || 0;
    } else {
      // Monaco editor
      try { v = el.getValue() || ''; } catch (e) { /* ignore */ }
      try {
        var p = el.getPosition();
        if (p) pos = { line: p.lineNumber, col: p.column };
        else pos = { line: 1, col: 1 };
      } catch (e) { pos = { line: 1, col: 1 }; }
    }
    // 超大正文（原生 / Monaco 同规）：不存全文基，本机停摆（Ctrl+Z/Y 全交原生）
    if (state.ceilChars && v.length > state.ceilChars) {
      state.overCeil = true;
      state.armFromShrink = false;
      state.history = [];
      state.index = 0;
      return;
    }
    // 对原生元素，pos 是数字；对 Monaco，pos 是 {line, col}
    var entry = { val: v, pos: pos };
    if (isNative) {
      state.overCeil = false;
      state.armFromShrink = false;
    }
    if (!isNative) {
      try { entry.scrollTop = el.getScrollTop(); } catch (e) { entry.scrollTop = 0; }
      state.overCeil = false;
      state.armFromShrink = false;
    }
    state.history = [entry];
    state.index = 0;
  }

  // ── 标记下一次变更为程序化（用于 setValue/文件打开等；自动过期防泄漏） ──
  function suppressOnce(el) {
    var state = _states.get(el);
    if (!state) return;
    _armProg(state);
  }

  // ── 强制记账（mark）：程序化插入的可撤回保障唯一入口 ──
  //   paste-router / codelens rename 等程序化写入后显式调用——无论变更事件路径是否被
  //   抑制窗口吞掉，该次写入都必然成为可 Ctrl+Z 回退的快照（幂等：值未变时零动作）。
  function mark(el) {
    var state = _states.get(el);
    if (!state) return false;
    var v = '', pos = null, scrollTop = 0;
    if (el && el.tagName && (el.tagName.toUpperCase() === 'INPUT' || el.tagName.toUpperCase() === 'TEXTAREA')) {
      v = el.value || '';
      pos = el.selectionStart || 0;
    } else {
      try { v = el.getValue() || ''; } catch (e) { return false; }
      try { var p = el.getPosition(); pos = p ? { line: p.lineNumber, col: p.column } : null; } catch (e) { pos = null; }
      try { scrollTop = el.getScrollTop(); } catch (e) { scrollTop = 0; }
    }
    return _pushEntry(state, v, pos, scrollTop);
  }

  // ── 查询可否 undo/redo ──
  function canUndo(el) {
    var state = _states.get(el);
    return !!(state && state.index > 0 && state.index < state.history.length);
  }

  function canRedo(el) {
    var state = _states.get(el);
    return !!(state && state.index >= 0 && state.index < state.history.length - 1);
  }

  // ── 执行 undo/redo（Monaco + 原生通用）──
  function _applySnapshot(el, st) {
    // Monaco editor (有 getValue/setValue)
    if (typeof el.getValue === 'function' && typeof el.setValue === 'function') {
      _armProg(st);
      var entry = st.history[st.index];
      try {
        _applyMonacoVal(el, window.monaco, entry.val);
        if (entry.pos) {
          el.setPosition({ lineNumber: entry.pos.line, column: entry.pos.col });
        }
        el.setScrollTop(entry.scrollTop || 0);
      } catch (e) { /* ignore */ }
      return;
    }
    // 原生 input/textarea
    if (el.tagName) {
      _armProg(st);
      var e = st.history[st.index];
      el.value = e.val;
      el.setSelectionRange(e.pos, e.pos);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function undo(el) {
    var st = _states.get(el);
    if (!st || st.index <= 0) return false;
    st.index--;
    _applySnapshot(el, st);
    return true;
  }

  function redo(el) {
    var st = _states.get(el);
    if (!st || st.index >= st.history.length - 1) return false;
    st.index++;
    _applySnapshot(el, st);
    return true;
  }

  // ── 自动扫描挂载 ──
  function autoAttach(root) {
    if (!root) root = document;
    // 扫描 root 本身
    if (_isAttachable(root) && !_isInsideMonaco(root) && !_hasState(root)) {
      attach(root);
    }
    // 扫描子树
    if (root.querySelectorAll) {
      var inputs = root.querySelectorAll('input[type="text"], input:not([type]), textarea');
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        if (!_isInsideMonaco(el) && !_hasState(el)) {
          attach(el);
        }
      }
      // 也扫描 search/email/url/number 等 input 类型
      var otherInputs = root.querySelectorAll('input[type="search"], input[type="email"], input[type="url"], input[type="number"]');
      for (var j = 0; j < otherInputs.length; j++) {
        var el2 = otherInputs[j];
        if (!_isInsideMonaco(el2) && !_hasState(el2)) {
          attach(el2);
        }
      }
    }
  }

  // ── 启动：DOM 就绪后自动扫描 body + 开启 MutationObserver ──
  function _boot() {
    if (document.body) {
      autoAttach(document.body);
    }
    _startObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  // ── 导出 API ──
  window.qqqCharUndo = {
    attach: attach,
    attachMonaco: attachMonaco,
    detach: detach,
    reset: reset,
    suppressOnce: suppressOnce,
    mark: mark,
    canUndo: canUndo,
    canRedo: canRedo,
    undo: undo,
    redo: redo,
    autoAttach: autoAttach
  };

})();
