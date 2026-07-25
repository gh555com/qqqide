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
      '#qqqide-qoast-container { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:99999; display:flex; flex-direction:column-reverse; gap:8px; pointer-events:none; align-items:center; }',
      '.qqoast {',
      '  pointer-events:auto; padding:16px 24px; border-radius:8px; font-size:16px; line-height:1.5;',
      '  min-width:280px; max-width:520px;',
      '  opacity:0; transform:translateY(40px); transition:all .25s ease;',
      '  color:var(--text-primary); background:var(--card-bg);',
      '  border:1px solid var(--border-color); box-shadow:0 -4px 20px rgba(0,0,0,.22);',
      '  display:flex; align-items:flex-start; gap:12px; cursor:default;',
      '}',
      '.qqoast--show { opacity:1; transform:translateY(0); }',
      '.qqoast--error  { border-left:4px solid var(--red); }',
      '.qqoast--warn   { border-left:4px solid var(--orange); }',
      '.qqoast--success{ border-left:4px solid var(--green); }',
      '.qqoast--info   { border-left:4px solid var(--blue); }',
      '.qqoast-body { flex:1; user-select:text; }',
      '.qqoast-body .qqoast-msg { white-space:pre-wrap; word-break:break-word; user-select:text; }',
      '.qqoast-body .qqoast-action { margin-top:8px; }',
      '.qqoast-body .qqoast-action button {',
      '  padding:4px 16px; cursor:pointer; border:1px solid var(--border-color); border-radius:4px;',
      '  background:var(--card-bg); color:var(--text-primary); font-size:14px;',
      '}',
      '.qqoast-body .qqoast-action button:hover { background:var(--border-color); }',
      '.qqoast-close { cursor:pointer; opacity:.4; font-size:20px; line-height:1; flex-shrink:0; padding:2px; user-select:none; }',
      '.qqoast-close:hover { opacity:1; }',
      '.qqoast-copy { cursor:pointer; opacity:.3; font-size:13px; line-height:1; flex-shrink:0; padding:2px 4px; user-select:none; }',
      '.qqoast-copy:hover { opacity:.8; }',
      '.qqoast-timer { font-size:13px; opacity:.35; margin-left:8px; flex-shrink:0; user-select:none; }',
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

      var copyBtn = document.createElement('span');
      copyBtn.className = 'qqoast-copy';
      copyBtn.textContent = '\uD83D\uDCCB';
      copyBtn.title = '\u590D\u5236';
      copyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        navigator.clipboard.writeText(message)['catch'](function () {
          var ta = document.createElement('textarea');
          ta.value = message;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        });
        copyBtn.textContent = '\u2713';
        setTimeout(function () { copyBtn.textContent = '\uD83D\uDCCB'; }, 1200);
      });

      el.appendChild(body);
      el.appendChild(copyBtn);
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
