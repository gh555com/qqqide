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
      '  <span class="qiioast-close" title="关闭">\u2715</span>',
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
    el.querySelector('.qiioast-cancel').textContent = '\u53D6\u6D88';
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

    var btn = el.querySelector('.qiioast-cancel');
    if (opts.cancelable === true && typeof opts.onCancel === 'function' && t.kind === 'active') {
      btn.style.display = '';
      btn.disabled = false;
      t.onCancel = opts.onCancel;
    } else if (opts.cancelable === false || t.kind !== 'active') {
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
    var n = Object.keys(_tasks).length;
    container.style.display = n > 0 ? 'flex' : 'none';
    _updateCollapse();
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
    }
  };
})();
