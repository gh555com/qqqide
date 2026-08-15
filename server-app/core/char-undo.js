// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// char-undo.js — 唯一真理逐字回退机器
//
// 覆盖范围：
//   <input> / <textarea> — snapshot 快照（value + cursor pos），200 条 / 10K 字符上限
//   Monaco Editor         — snapshot 快照（value + cursor pos + scrollTop），50 条 / 500K 上限
//
// 快捷键：
//   Ctrl+Z → 逐字回退  Ctrl+Y → 逐字重做
//
// API：
//   window.qqqCharUndo.attach(el, opts)        — 挂载到原生 input/textarea
//   window.qqqCharUndo.attachMonaco(ed, monaco, opts) — 挂载到 Monaco 编辑器
//   window.qqqCharUndo.detach(el)              — 卸载
//   window.qqqCharUndo.reset(el)               — 重置历史（如消息发送后）
//   window.qqqCharUndo.suppressOnce(el)        — 标记下次变更为程序化（跳过记录）
//   window.qqqCharUndo.canUndo(el)             — 是否可回退
//   window.qqqCharUndo.canRedo(el)             — 是否可重做
//   window.qqqCharUndo.autoAttach(root)        — 扫描 root 下所有 input/textarea 并挂载
//
// 铁律：
//   · 接入 §3 配色机器，不自定义颜色
//   · 不触碰 cursor 样式（§19）
//   · 兼容 key-hook.js（不拦截非编辑区 Ctrl+Z）
// ============================================================================

(function () {
  'use strict';

  // ── 配置常量 ──
  var NATIVE_MAX_HISTORY = 200;
  var NATIVE_CEIL_CHARS = 20000;   // 超过此长度的值不记历史（≥ EDITOR_CAP_CHARS 16K 保证全量覆盖）
  var MONACO_MAX_HISTORY = 50;
  var MONACO_CEIL_CHARS = 500000;  // 500KB

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

    var state = {
      history: [{ val: initialState, pos: initialPos }],
      index: 0,
      prog: false,
      onChange: onChange,
      maxHistory: maxHistory,
      ceilChars: ceilChars
    };
    _states.set(el, state);

    function onInput() {
      if (state.prog) { state.prog = false; return; }
      var v = el.value;
      // 分支截断
      if (state.index < state.history.length - 1) {
        state.history = state.history.slice(0, state.index + 1);
      }
      var last = state.history[state.history.length - 1];
      if (v !== last.val && v.length <= state.ceilChars) {
        state.history.push({ val: v, pos: el.selectionStart });
        state.index = state.history.length - 1;
        if (state.history.length > state.maxHistory) {
          var drop = Math.floor(state.maxHistory / 2);
          state.history = state.history.slice(drop);
          state.index -= drop;
        }
      }
      if (state.onChange) state.onChange();
    }

    function onKeydown(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (e.shiftKey) {
          // Ctrl+Shift+Z → Redo
          e.preventDefault(); e.stopPropagation();
          if (state.index < state.history.length - 1) {
            state.index++;
            state.prog = true;
            var entryR = state.history[state.index];
            el.value = entryR.val;
            el.setSelectionRange(entryR.pos, entryR.pos);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          // Ctrl+Z → Undo
          e.preventDefault(); e.stopPropagation();
          if (state.index > 0) {
            state.index--;
            state.prog = true;
            var entry = state.history[state.index];
            el.value = entry.val;
            el.setSelectionRange(entry.pos, entry.pos);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        // Ctrl+Y → Redo
        e.preventDefault(); e.stopPropagation();
        if (state.index < state.history.length - 1) {
          state.index++;
          state.prog = true;
          var entryY = state.history[state.index];
          el.value = entryY.val;
          el.setSelectionRange(entryY.pos, entryY.pos);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
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

    var initialVal = '';
    try { initialVal = editor.getValue() || ''; } catch (e) { /* ignore */ }
    var initialPos = { line: 1, col: 1 };
    var initialScroll = 0;
    try {
      var pos = editor.getPosition();
      if (pos) initialPos = { line: pos.lineNumber, col: pos.column };
      initialScroll = editor.getScrollTop();
    } catch (e) { /* ignore */ }

    var state = {
      history: [{ val: initialVal, pos: initialPos, scrollTop: initialScroll }],
      index: 0,
      prog: false,
      maxHistory: maxHistory,
      ceilChars: ceilChars
    };
    _states.set(editor, state);

    // 监听内容变更 → 记录快照
    var onChangeDisposable = editor.onDidChangeModelContent(function () {
      if (state.prog) { state.prog = false; return; }
      // 检查 _isRefreshing / 全局刷新锁（refreshLiveContent / 外部修改重载 / 跨窗口脏快照）
      if (editor._isRefreshing || editor._globalRefreshLock || window.__qqqGlobalRefreshLock) return;

      var v = '';
      try { v = editor.getValue() || ''; } catch (e) { return; }
      if (v.length > state.ceilChars) return;

      if (state.index < state.history.length - 1) {
        state.history = state.history.slice(0, state.index + 1);
      }
      var last = state.history[state.history.length - 1];
      if (v !== last.val) {
        var pos = { line: 1, col: 1 };
        var st = 0;
        try {
          var p = editor.getPosition();
          if (p) pos = { line: p.lineNumber, col: p.column };
          st = editor.getScrollTop();
        } catch (e) { /* ignore */ }
        state.history.push({ val: v, pos: pos, scrollTop: st });
        state.index = state.history.length - 1;
        if (state.history.length > state.maxHistory) {
          var drop = Math.floor(state.maxHistory / 2);
          state.history = state.history.slice(drop);
          state.index -= drop;
        }
      }
    });

    // 拦截 Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
    var onKeyDownDisposable = editor.onKeyDown(function (e) {
      if ((e.ctrlKey || e.metaKey) && e.keyCode === monaco.KeyCode.KeyZ) {
        if (e.shiftKey) {
          // Ctrl+Shift+Z → Redo
          e.preventDefault(); e.stopPropagation();
          if (state.index < state.history.length - 1) {
            state.index++;
            _applyMonacoSnapshot(editor, state);
          }
        } else {
          // Ctrl+Z → Undo
          e.preventDefault(); e.stopPropagation();
          if (state.index > 0) {
            state.index--;
            _applyMonacoSnapshot(editor, state);
          }
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.keyCode === monaco.KeyCode.KeyY) {
        // Ctrl+Y → Redo
        e.preventDefault(); e.stopPropagation();
        if (state.index < state.history.length - 1) {
          state.index++;
          _applyMonacoSnapshot(editor, state);
        }
        return;
      }
    });

    function _applyMonacoSnapshot(ed, st) {
      st.prog = true;
      var entry = st.history[st.index];
      try {
        ed.setValue(entry.val);
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
    if (el.tagName && (el.tagName.toUpperCase() === 'INPUT' || el.tagName.toUpperCase() === 'TEXTAREA')) {
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
    // 对原生元素，pos 是数字；对 Monaco，pos 是 {line, col}
    var entry = { val: v, pos: pos };
    if (!el.tagName || !(el.tagName.toUpperCase() === 'INPUT' || el.tagName.toUpperCase() === 'TEXTAREA')) {
      try { entry.scrollTop = el.getScrollTop(); } catch (e) { entry.scrollTop = 0; }
    }
    state.history = [entry];
    state.index = 0;
  }

  // ── 标记下一次变更为程序化（用于 setValue/文件打开等） ──
  function suppressOnce(el) {
    var state = _states.get(el);
    if (!state) return;
    state.prog = true;
  }

  // ── 查询可否 undo/redo ──
  function canUndo(el) {
    var state = _states.get(el);
    return !!(state && state.index > 0);
  }

  function canRedo(el) {
    var state = _states.get(el);
    return !!(state && state.index < state.history.length - 1);
  }

  // ── 执行 undo/redo（Monaco + 原生通用）──
  function _applySnapshot(el, st) {
    // Monaco editor (有 getValue/setValue)
    if (typeof el.getValue === 'function' && typeof el.setValue === 'function') {
      st.prog = true;
      var entry = st.history[st.index];
      try {
        el.setValue(entry.val);
        if (entry.pos) {
          el.setPosition({ lineNumber: entry.pos.line, column: entry.pos.col });
        }
        el.setScrollTop(entry.scrollTop || 0);
      } catch (e) { /* ignore */ }
      return;
    }
    // 原生 input/textarea
    if (el.tagName) {
      st.prog = true;
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
    canUndo: canUndo,
    canRedo: canRedo,
    undo: undo,
    redo: redo,
    autoAttach: autoAttach
  };

})();
