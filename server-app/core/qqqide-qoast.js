// ============================================================================
// qqqide-qoast.js — 唯一真理 qoast 弹窗机器
// 升级 qoast 能力只需改本文件一处。一切通知必须走这里，禁止私造弹窗。
//
// API:
//   qqqideQoast.show(message, [opts])
//     opts.duration — 自动关闭毫秒 (默认 9000，0 = 不自动关)
//     opts.type     — 'error'|'warning'|'success'|'info' (默认 'info')
//     opts.action   — { label:'按钮文字', onClick:fn }
//   返回 { dismiss } — 手动关闭
// ============================================================================

(function () {
  'use strict';

  var DEFAULT_DURATION = 9000;
  var container = null;

  function ensreContainer() {
    var c = document.getElementById('qqqide-qoast-container');
    if (c) { container = c; return; }
    container = document.createElement('div');
    container.id = 'qqqide-qoast-container';
    if (document.body) { document.body.appendChild(container); }
    else { document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(container); }); }
  }

  var styleOnce = false;
  function injectStyle() {
    if (styleOnce || document.getElementById('qqqide-qoast-style')) return;
    styleOnce = true;
    var s = document.createElement('style');
    s.id = 'qqqide-qoast-style';
    s.textContent = [
      '#qqqide-qoast-container { position:fixed; top:44px; right:12px; z-index:99999; display:flex; flex-direction:column; gap:6px; pointer-events:none; }',
      '.qqoast {',
      '  pointer-events:auto; padding:8px 12px; border-radius:4px; font-size:12px; line-height:1.4;',
      '  min-width:200px; max-width:380px;',
      '  opacity:0; transform:translateX(40px); transition:all .25s ease;',
      '  color:var(--text-primary); background:var(--card-bg);',
      '  border:1px solid var(--border-color); box-shadow:0 2px 10px rgba(0,0,0,.18);',
      '  display:flex; align-items:flex-start; gap:8px; cursor:default;',
      '}',
      '.qqoast--show { opacity:1; transform:translateX(0); }',
      '.qqoast--error  { border-left:3px solid var(--red); }',
      '.qqoast--warn   { border-left:3px solid var(--orange); }',
      '.qqoast--success{ border-left:3px solid var(--green); }',
      '.qqoast--info   { border-left:3px solid var(--blue); }',
      '.qqoast-body { flex:1; }',
      '.qqoast-body .qqoast-msg { white-space:pre-wrap; word-break:break-word; }',
      '.qqoast-body .qqoast-action { margin-top:6px; }',
      '.qqoast-body .qqoast-action button {',
      '  padding:2px 10px; cursor:pointer; border:1px solid var(--border-color); border-radius:3px;',
      '  background:var(--card-bg); color:var(--text-primary); font-size:11px;',
      '}',
      '.qqoast-body .qqoast-action button:hover { background:var(--border-color); }',
      '.qqoast-close { cursor:pointer; opacity:.4; font-size:14px; line-height:1; flex-shrink:0; }',
      '.qqoast-close:hover { opacity:1; }',
      '.qqoast-timer { font-size:10px; opacity:.35; margin-left:4px; flex-shrink:0; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  function Qoast(el) { this.el = el; }
  Qoast.prototype.dismiss = function () {
    var el = this.el;
    if (!el || el._dismissed) return;
    el._dismissed = true;
    clearTimeout(el._timer);
    clearInterval(el._ticker);
    el.classList.remove('qqoast--show');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
  };

  window.qqqideQoast = {
    show: function (message, opts) {
      opts = opts || {};
      var duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION;
      var type = opts.type || 'info';
      var action = opts.action;

      ensreContainer();
      injectStyle();

      var el = document.createElement('div');
      el.className = 'qqoast qqoast--' + (type === 'warning' ? 'warn' : type);

      var body = document.createElement('div');
      body.className = 'qqoast-body';

      var msgSpan = document.createElement('div');
      msgSpan.className = 'qqoast-msg';
      msgSpan.textContent = message;
      body.appendChild(msgSpan);

      if (action && action.label) {
        var actionDiv = document.createElement('div');
        actionDiv.className = 'qqoast-action';
        var btn = document.createElement('button');
        btn.textContent = action.label;
        btn.addEventListener('click', function () {
          if (typeof action.onClick === 'function') action.onClick();
          qoaster.dismiss();
        });
        actionDiv.appendChild(btn);
        body.appendChild(actionDiv);
      }

      var closeBtn = document.createElement('span');
      closeBtn.className = 'qqoast-close';
      closeBtn.textContent = '\u2715';
      closeBtn.addEventListener('click', function () { qoaster.dismiss(); });

      el.appendChild(body);
      el.appendChild(closeBtn);
      container.appendChild(el);

      var qoaster = new Qoast(el);
      el._timer = 0;
      el._ticker = 0;

      if (duration > 0) {
        var timerSpan = document.createElement('span');
        timerSpan.className = 'qqoast-timer';
        var start = Date.now();
        var remain = duration;

        var updateTimer = function () {
          var r = duration - (Date.now() - start);
          if (r <= 0) { timerSpan.textContent = '0s'; return; }
          timerSpan.textContent = Math.ceil(r / 1000) + 's';
        };
        var tick = function () {
          remain = duration - (Date.now() - start);
          if (remain <= 0) { clearInterval(el._ticker); qoaster.dismiss(); return; }
          updateTimer();
        };

        el.appendChild(timerSpan);
        el._ticker = setInterval(tick, 1000);

        var setTimer = function (ms) {
          clearTimeout(el._timer);
          if (ms > 0) el._timer = setTimeout(function () { qoaster.dismiss(); }, ms);
        };
        setTimer(duration);

        // 悬停暂停
        el.addEventListener('mouseenter', function () {
          clearTimeout(el._timer);
          clearInterval(el._ticker);
        });
        el.addEventListener('mouseleave', function () {
          remain = duration - (Date.now() - start);
          if (remain > 0) {
            setTimer(remain);
            el._ticker = setInterval(tick, 1000);
            updateTimer();
          } else {
            qoaster.dismiss();
          }
        });

        updateTimer();
      }

      // 入场动画
      requestAnimationFrame(function () { el.classList.add('qqoast--show'); });

      return qoaster;
    }
  };

  ensreContainer();
})();
