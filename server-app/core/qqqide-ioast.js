// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqqide-ioast.js — 唯一真理 ioast 任务坞（2026-08-24 定案）
// 与 qoast 的分工:
//   qoast = 快进快出通知（默认 9s，告知语义）→ 视口底部居中，位置不动
//   ioast = 任务绑定交互（进度/耗时/取消/摘要，任务不结束不消失）→ X 区右下任务坞
// 生命周期: task() 创建（幂等更新）→ done()/fail() 摘要 5s/8s → 自动消失
// 空闲零占用: 容器无卡片时 display:none；>3 卡自动折叠胶囊（点击展开）
// API:
//   qqqideIoast.task(id, opts)  创建/更新。opts: title/subtitle/progress(0-1)/
//                                count{done,total}/cancelable/onCancel/elapsed(秒)
//   qqqideIoast.done(id, opts)  成功摘要。opts.summary
//   qqqideIoast.fail(id, opts)  失败摘要。opts.summary
//   qqqideIoast.remove(id)      立即移除
//   qqqideIoast.waitBar.set(key, opts)  聚合等待细条（N 个等待只出一条；opts: text/durS/note/onStop）
//   qqqideIoast.waitBar.clear(key)      条目移除（全空 → 细条自动消失）
// iframe 内页面经 parent.qqqideIoast 调用（同 qoast 模式）
// ============================================================================

(function () {
  'use strict';

  var MAX_VISIBLE = 3;       // 收起态最多同时显示卡片数
  var DONE_KEEP_MS = 5000;   // 成功摘要停留
  var FAIL_KEEP_MS = 8000;   // 失败摘要停留

  var container = null;
  var capsule = null;
  var _tasks = {};   // id -> { el, kind: 'active'|'done'|'fail', onCancel, timer }
  var _expanded = false;

  function _host() {
    return document.querySelector('.qqq-x-zone') || document.body;
  }

  function ensureContainer() {
    if (container) return;
    container = document.createElement('div');
    container.id = 'qqqide-ioast-container';
    var h = _host();
    if (h !== document.body) {
      // ★ X 区无定位 → 强制 relative，保证 absolute 落点正确
      if (window.getComputedStyle(h).position === 'static') h.style.position = 'relative';
    } else {
      container.classList.add('qqqide-ioast--fallback');
    }
    h.appendChild(container);
  }

  function injectStyle() {
    if (document.getElementById('qqqide-ioast-style')) return;
    var s = document.createElement('style');
    s.id = 'qqqide-ioast-style';
    s.textContent = [
      '#qqqide-ioast-container {',
      '  position:absolute; right:14px; bottom:14px; z-index:99990;',
      '  display:none; flex-direction:column; gap:8px; align-items:flex-end;',
      '  pointer-events:none; max-width:380px; width:min(380px, 60vw);',
      '}',
      '#qqqide-ioast-container.qqqide-ioast--fallback { position:fixed; }',
      '.qiioast {',
      '  pointer-events:auto; width:100%; box-sizing:border-box;',
      '  background:var(--card-bg); border:1px solid var(--border-color);',
      '  border-left:3px solid var(--blue); border-radius:6px;',
      '  padding:10px 12px; font-size:13px; line-height:1.4;',
      '  box-shadow:0 -2px 12px rgba(0,0,0,.18); color:var(--text-primary);',
      '}',
      '.qiioast--done { border-left-color:var(--green); }',
      '.qiioast--fail { border-left-color:var(--red); }',
      '.qiioast-head { display:flex; align-items:center; gap:8px; }',
      '.qiioast-title { flex:1; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.qiioast-close { cursor:pointer; opacity:.4; font-size:15px; line-height:1; padding:2px; user-select:none; }',
      '.qiioast-close:hover { opacity:1; }',
      '.qiioast-bar { margin-top:6px; height:4px; background:var(--border-color); border-radius:2px; overflow:hidden; }',
      '.qiioast-bar-in { height:100%; width:0; background:var(--blue); border-radius:2px; transition:width .2s ease; }',
      '.qiioast-sub { margin-top:5px; font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.qiioast-foot { margin-top:6px; display:flex; align-items:center; gap:10px; font-size:12px; color:var(--text-secondary); }',
      '.qiioast-count { font-variant-numeric:tabular-nums; }',
      '.qiioast-elapsed { font-variant-numeric:tabular-nums; }',
      '.qiioast-cancel { margin-left:auto; padding:2px 12px; font-size:12px; cursor:pointer;',
      '  border:1px solid var(--border-color); border-radius:4px;',
      '  background:var(--card-bg); color:var(--text-primary); }',
      '.qiioast-cancel:hover { background:var(--border-color); }',
      '.qiioast-cancel:disabled { opacity:.5; cursor:default; }',
      '.qiioast-summary { margin-top:4px; font-size:12px; color:var(--text-secondary); }',
      '.qiioast-capsule {',
      '  pointer-events:auto; cursor:pointer; user-select:none;',
      '  background:var(--card-bg); border:1px solid var(--border-color); border-radius:999px;',
      '  padding:6px 14px; font-size:13px; color:var(--text-primary);',
      '  box-shadow:0 -2px 12px rgba(0,0,0,.18);',
      '}',
      '.qiioast-capsule:hover { background:var(--border-color); }',
      '.qwbar {',
      '  pointer-events:auto; width:100%; box-sizing:border-box;',
      '  background:var(--card-bg); border:1px solid var(--border-color);',
      '  border-left:3px solid var(--blue); border-radius:6px;',
      '  padding:6px 12px; font-size:12px; line-height:1.45;',
      '  box-shadow:0 -2px 12px rgba(0,0,0,.18); color:var(--text-primary);',
      '}',
      '.qwbar-head { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }',
      '.qwbar-txt { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums; }',
      '.qwbar-caret { flex-shrink:0; opacity:.5; font-size:11px; }',
      '.qwbar-close { flex-shrink:0; cursor:pointer; opacity:.4; font-size:14px; line-height:1; padding:2px; }',
      '.qwbar-close:hover { opacity:1; }',
      '.qwbar-rows { display:flex; flex-direction:column; gap:5px; margin-top:6px; padding-top:6px; border-top:1px dashed var(--border-color); }',
      '.qwbar-row { display:flex; align-items:center; gap:8px; }',
      '.qwbar-row-txt { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-secondary); }',
      '.qwbar-row-dur { flex-shrink:0; font-variant-numeric:tabular-nums; color:var(--text-secondary); }',
      '.qwbar-row-stop { flex-shrink:0; padding:1px 8px; font-size:12px; cursor:pointer;',
      '  border:1px solid var(--border-color); border-radius:4px;',
      '  background:var(--card-bg); color:var(--text-primary); }',
      '.qwbar-row-stop:hover { background:var(--border-color); }',
      '.qwbar-row-stop:disabled { opacity:.5; cursor:default; }',
      '.qiioast-hidden { display:none !important; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  function _makeCard(id) {
    var el = document.createElement('div');
    el.className = 'qiioast';
    el.innerHTML = [
      '<div class="qiioast-head">',
      '  <span class="qiioast-title"></span>',
      '  <span class="qiioast-close" title="' + (window._i ? window._i('common.close', '关闭') : '关闭') + '">\u2715</span>',
      '</div>',
      '<div class="qiioast-bar"><div class="qiioast-bar-in"></div></div>',
      '<div class="qiioast-sub"></div>',
      '<div class="qiioast-foot">',
      '  <span class="qiioast-count"></span>',
      '  <span class="qiioast-elapsed"></span>',
      '  <button class="qiioast-cancel"></button>',
      '</div>',
      '<div class="qiioast-summary" style="display:none"></div>',
    ].join('');
    el.querySelector('.qiioast-close').addEventListener('click', function (e) {
      e.stopPropagation();
      _remove(id);
    });
    el.querySelector('.qiioast-cancel').textContent = (window._i ? window._i('common.cancel', '取消') : '\u53D6\u6D88');
    el.querySelector('.qiioast-cancel').addEventListener('click', function (e) {
      e.stopPropagation();
      var t = _tasks[id];
      if (!t || typeof t.onCancel !== 'function') return;
      var btn = this;
      btn.disabled = true;
      var cb = t.onCancel;
      t.onCancel = null;
      cb();
    });
    container.appendChild(el);
    return el;
  }

  function _applyCard(id, opts) {
    var t = _tasks[id];
    if (!t) return;
    var el = t.el;
    if (opts.title != null) el.querySelector('.qiioast-title').textContent = opts.title;
    if (opts.subtitle != null) el.querySelector('.qiioast-sub').textContent = opts.subtitle;

    var bar = el.querySelector('.qiioast-bar');
    var barIn = el.querySelector('.qiioast-bar-in');
    var pct = null;
    if (typeof opts.progress === 'number') pct = Math.max(0, Math.min(1, opts.progress));
    else if (opts.count && opts.count.total > 0) pct = Math.min(1, opts.count.done / opts.count.total);
    if (pct == null) bar.style.display = 'none';
    else { bar.style.display = ''; barIn.style.width = Math.round(pct * 100) + '%'; }

    var countEl = el.querySelector('.qiioast-count');
    if (opts.count && opts.count.total > 0) countEl.textContent = opts.count.done + '/' + opts.count.total;
    else countEl.textContent = '';

    var elapsedEl = el.querySelector('.qiioast-elapsed');
    if (typeof opts.elapsed === 'number') elapsedEl.textContent = '\u23F1 ' + opts.elapsed.toFixed(1) + 's';
    else elapsedEl.textContent = '';

    // ★ 取消按钮默认隐藏（2026-10-01）：仅显式 cancelable:true + onCancel 才出现——
    //   旧实现未传 cancelable 的卡会渲染一枚死按钮（点了静默无反应），比没有更糟
    var btn = el.querySelector('.qiioast-cancel');
    if (opts.cancelable === true && typeof opts.onCancel === 'function' && t.kind === 'active') {
      btn.style.display = '';
      btn.disabled = false;
      t.onCancel = opts.onCancel;
    } else {
      t.onCancel = null;
      btn.style.display = 'none';
    }
  }

  function _setKind(id, kind) {
    var t = _tasks[id];
    if (!t) return;
    t.kind = kind;
    t.el.classList.remove('qiioast--done', 'qiioast--fail');
    if (kind === 'done') t.el.classList.add('qiioast--done');
    else if (kind === 'fail') t.el.classList.add('qiioast--fail');
    t.onCancel = null;
    t.el.querySelector('.qiioast-cancel').style.display = 'none';
  }

  function _remove(id) {
    var t = _tasks[id];
    if (!t) return;
    clearTimeout(t.timer);
    if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
    delete _tasks[id];
    _updateVisibility();
  }

  function _capsule() {
    if (!capsule) {
      capsule = document.createElement('div');
      capsule.className = 'qiioast-capsule';
      capsule.addEventListener('click', function () {
        _expanded = !_expanded;
        _updateCollapse();
      });
      container.appendChild(capsule);
    }
    return capsule;
  }

  function _updateCollapse() {
    if (!container) return;
    var ids = Object.keys(_tasks);
    var n = ids.length;
    if (n <= MAX_VISIBLE) {
      _expanded = false;
      ids.forEach(function (id) { _tasks[id].el.classList.remove('qiioast-hidden'); });
      if (capsule) capsule.style.display = 'none';
      return;
    }
    if (_expanded) {
      ids.forEach(function (id) { _tasks[id].el.classList.remove('qiioast-hidden'); });
      var cap = _capsule();
      cap.textContent = '\u6536\u8D77';
      cap.style.display = '';
      return;
    }
    ids.forEach(function (id, idx) {
      _tasks[id].el.classList.toggle('qiioast-hidden', idx >= MAX_VISIBLE);
    });
    var cap2 = _capsule();
    cap2.textContent = '\u23F3 ' + (n - MAX_VISIBLE) + ' \u4E2A\u4EFB\u52A1\u8FDB\u884C\u4E2D';
    cap2.style.display = '';
  }

  function _updateVisibility() {
    if (!container) return;
    // waitBar 计入容器可见性（仅它存在时容器也必须显示）
    var n = Object.keys(_tasks).length + ((_wbVisibleNow() && Object.keys(_wb).length) ? 1 : 0);
    container.style.display = n > 0 ? 'flex' : 'none';
    _updateCollapse();
  }

  // ═══ waitBar — 聚合等待细条（2026-10-01 定案）═══
  // 语义：N 个楼层等待上游 → 只出一条 ~30px 细条（聚合零占，不再 N 卡堆角）；点开才展明细
  //（逐行 ■ 停止 = 真停该楼层）；✕ = 本轮静默（已列条目不再显示；出现新的等待楼层才再提示）；
  // 条目 15s 无刷新自动清（iframe 重载兜底）；条目只注册 = 行文本由调用方本地化后传入。
  var _wb = {};          // key -> { text, durS, note, onStop, muted, ts }
  var _wbRowEls = {};    // key -> row element
  var _wbEl = null;
  var _wbExpanded = false;
  var _wbSweep = null;
  var WB_STALE_MS = 15000;

  function _wbi(key, fb, params) {
    try { return window._i ? window._i(key, fb, params) : fb; } catch (_) { return fb; }
  }

  function _wbDurText(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60);
    return m + 'm' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  function _wbVisibleNow() {
    var ks = Object.keys(_wb);
    for (var i = 0; i < ks.length; i++) { if (!_wb[ks[i]].muted) return true; }
    return false;
  }

  function _wbEnsureEl() {
    if (_wbEl) return _wbEl;
    ensureContainer();
    injectStyle();
    var el = document.createElement('div');
    el.className = 'qwbar';
    el.innerHTML = [
      '<div class="qwbar-head">',
      '  <span class="qwbar-txt"></span>',
      '  <span class="qwbar-caret"></span>',
      '  <span class="qwbar-close">\u2715</span>',
      '</div>',
      '<div class="qwbar-rows"></div>',
    ].join('');
    el.querySelector('.qwbar-close').addEventListener('click', function (e) {
      e.stopPropagation();
      // 本轮静默：现有条目全部标记 muted；新条目出现（muted=false）才会再提示
      var ks = Object.keys(_wb);
      for (var i = 0; i < ks.length; i++) _wb[ks[i]].muted = true;
      _wbRender();
    });
    el.querySelector('.qwbar-head').addEventListener('click', function () {
      _wbExpanded = !_wbExpanded;
      _wbRender();
    });
    _wbEl = el;
    return el;
  }

  function _wbRenderRows(rowsEl, ks) {
    var seen = {};
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i], e = _wb[k];
      seen[k] = 1;
      var row = _wbRowEls[k];
      if (!row) {
        row = document.createElement('div');
        row.className = 'qwbar-row';
        row.innerHTML = '<span class="qwbar-row-txt"></span><span class="qwbar-row-dur"></span><button type="button" class="qwbar-row-stop"></button>';
        (function (key) {
          row.querySelector('.qwbar-row-stop').addEventListener('click', function (ev) {
            ev.stopPropagation();
            var ent = _wb[key];
            if (!ent) return;
            this.disabled = true;
            var cb = ent.onStop;
            ent.onStop = null;
            try { if (typeof cb === 'function') cb(); } catch (_) { }
          });
        })(k);
        _wbRowEls[k] = row;
      }
      row.querySelector('.qwbar-row-txt').textContent = e.text || '';
      row.querySelector('.qwbar-row-dur').textContent = _wbDurText(e.durS);
      row.querySelector('.qwbar-row-stop').textContent = _wbi('ai.gwWait.stop', '\u25A0 停止');
      if (e.note) row.title = e.note; else row.removeAttribute('title');
      rowsEl.appendChild(row);
    }
    Object.keys(_wbRowEls).forEach(function (k2) {
      if (!seen[k2]) {
        var r = _wbRowEls[k2];
        if (r.parentNode) r.parentNode.removeChild(r);
        delete _wbRowEls[k2];
      }
    });
  }

  function _wbRender() {
    if (!container) return;
    var ks = Object.keys(_wb);
    var visible = ks.length > 0 && _wbVisibleNow();
    if (!visible) {
      if (_wbEl && _wbEl.parentNode) _wbEl.parentNode.removeChild(_wbEl);
      if (!ks.length) {
        _wbExpanded = false;
        _wbRowEls = {};
        if (_wbSweep) { clearInterval(_wbSweep); _wbSweep = null; }
      }
      _updateVisibility();
      return;
    }
    var el = _wbEnsureEl();
    if (el.parentNode !== container) container.appendChild(el);
    var maxS = 0;
    for (var i = 0; i < ks.length; i++) { var d = _wb[ks[i]].durS || 0; if (d > maxS) maxS = d; }
    el.querySelector('.qwbar-txt').textContent = ks.length > 1
      ? _wbi('ai.gwWait.barMulti', '\u23F3 {0} 个楼层等待上游 · 最长 {1}', { 0: ks.length, 1: _wbDurText(maxS) })
      : _wbi('ai.gwWait.title', '\u23F3 上游无响应 {0}', { 0: _wbDurText(maxS) });
    var caret = el.querySelector('.qwbar-caret');
    caret.textContent = _wbExpanded ? '\u25BE' : '\u25B8';
    caret.title = _wbExpanded ? _wbi('ai.gwWait.collapse', '收起') : _wbi('ai.gwWait.expand', '展开明细');
    el.querySelector('.qwbar-close').title = _wbi('ai.gwWait.muteTip', '本次不再提示');
    var rowsEl = el.querySelector('.qwbar-rows');
    rowsEl.style.display = _wbExpanded ? '' : 'none';
    if (_wbExpanded) _wbRenderRows(rowsEl, ks);
    _updateVisibility();
  }

  function _wbKickSweep() {
    if (_wbSweep) return;
    _wbSweep = setInterval(function () {
      var now = Date.now(), changed = false;
      Object.keys(_wb).forEach(function (k) {
        if (now - (_wb[k].ts || 0) > WB_STALE_MS) {
          delete _wb[k];
          var r = _wbRowEls[k];
          if (r && r.parentNode) r.parentNode.removeChild(r);
          delete _wbRowEls[k];
          changed = true;
        }
      });
      if (changed) _wbRender();
    }, 5000);
  }

  window.qqqideIoast = {
    task: function (id, opts) {
      if (!id || !opts) return;
      ensureContainer();
      injectStyle();
      var t = _tasks[id];
      if (!t) {
        t = _tasks[id] = { el: _makeCard(id), kind: 'active', onCancel: null, timer: 0 };
      } else {
        // done/fail 后复用同 id → 回到活跃态
        clearTimeout(t.timer);
        t.kind = 'active';
        t.el.classList.remove('qiioast--done', 'qiioast--fail');
      }
      t.el.classList.remove('qiioast-hidden');
      _applyCard(id, opts);
      _updateVisibility();
    },
    done: function (id, opts) {
      if (!id || !_tasks[id]) return;
      var t = _tasks[id];
      clearTimeout(t.timer);
      _setKind(id, 'done');
      var summaryEl = t.el.querySelector('.qiioast-summary');
      if (opts && opts.summary) {
        summaryEl.textContent = '\u2713 ' + opts.summary;
        summaryEl.style.display = '';
      } else {
        summaryEl.style.display = 'none';
      }
      t.el.querySelector('.qiioast-sub').textContent = '';
      t.timer = setTimeout(function () { _remove(id); }, DONE_KEEP_MS);
      _updateCollapse();
    },
    fail: function (id, opts) {
      if (!id || !_tasks[id]) return;
      var t = _tasks[id];
      clearTimeout(t.timer);
      _setKind(id, 'fail');
      var summaryEl = t.el.querySelector('.qiioast-summary');
      if (opts && opts.summary) {
        summaryEl.textContent = '\u2717 ' + opts.summary;
        summaryEl.style.display = '';
      } else {
        summaryEl.style.display = 'none';
      }
      t.el.querySelector('.qiioast-sub').textContent = '';
      t.timer = setTimeout(function () { _remove(id); }, FAIL_KEEP_MS);
      _updateCollapse();
    },
    remove: function (id) {
      _remove(id);
    },
    waitBar: {
      set: function (key, opts) {
        if (!key || !opts) return;
        ensureContainer();
        injectStyle();
        var e = _wb[key];
        if (!e) e = _wb[key] = { text: '', durS: 0, note: '', onStop: null, muted: false, ts: 0 };
        if (opts.text != null) e.text = opts.text;
        if (typeof opts.durS === 'number') e.durS = opts.durS;
        if (opts.note != null) e.note = opts.note;
        if (typeof opts.onStop === 'function') e.onStop = opts.onStop;
        e.ts = Date.now();
        _wbKickSweep();
        _wbRender();
      },
      clear: function (key) {
        if (!key || !_wb[key]) return;
        delete _wb[key];
        var r = _wbRowEls[key];
        if (r && r.parentNode) r.parentNode.removeChild(r);
        delete _wbRowEls[key];
        _wbRender();
      }
    }
  };
})();
