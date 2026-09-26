// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-overlay.js — AI 悬浮预览层（图片 + 表格，全窗口）（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window._i, window.qqqideTheme
// ============================================================================

function bootAiOverlay() {
  var bridge = window.qqqideBridge;
  // 全局唯一 overlay ID（用于跨窗口协调：同时最多一个悬浮预览）
  var _overlayId = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  // IPC sync 替代 BroadcastChannel：跨窗口 overlay 协调
  var _ovUnsub = null;
  try {
    if (bridge && bridge.sync) {
      _ovUnsub = bridge.sync.onMessage(function (channel, data) {
        if (channel === 'overlay-open' && data && data.id !== _overlayId) {
          // 其他窗口打开了 overlay → 关闭自己的
          close();
        }
      });
    }
  } catch (_) { }

  var overlay = document.createElement('div');
  overlay.id = 'qqqide-overlay';
  overlay.setAttribute('tabindex', '-1');  // ★ 可编程聚焦（媒体打开即抢焦点 → 键盘快捷键不再被 iframe 吞，2026-09-26 v2）
  overlay.style.cssText =
    'display:none; outline:none; position:absolute; inset:0; z-index:99999; ' +
    'background:rgba(0,0,0,0.88);';

  // ── 滚动条/拖选色由 shell-base.css「内嵌弹窗统一块」提供（铁律 §4.1 单源——原自注入已迁删）──

  // ── 链接主题色（2026-08-21：禁蓝色链接——悬浮预览层内 <a> 一律继承前景色，仅保留下划线）──
  var _ovLinkStyle = document.createElement('style');
  _ovLinkStyle.textContent =
    '#qqq-ai-overlay-content a{color:inherit;text-decoration:underline;}' +
    '#qqq-ai-overlay-content a:hover{color:inherit;text-decoration:underline;}' +
    '#qqq-ai-overlay-content a.qqq-path-link{color:inherit;text-decoration:none;cursor:auto}' +
    '#qqq-ai-overlay-content .qqq-path-link.qqq-path-ok{text-decoration:underline dotted;text-underline-offset:2px;cursor:pointer}' +
    '#qqq-ai-overlay-content .qqq-path-link.qqq-path-ok:hover{text-decoration:underline;background:rgba(181,137,0,0.18)}';
  document.head.appendChild(_ovLinkStyle);

  // ── 全文匹配高亮（overlay 专属）：::highlight(ov-matches) 半透明同橙系，区分用户选区
  //    （拖选色 ::selection 由 shell-base.css「内嵌弹窗统一块」提供——铁律 §4.1 单源）──
  var _selStyle = document.createElement('style');
  _selStyle.textContent =
    '::highlight(ov-matches){background:rgba(255,140,110,0.38);color:inherit;border-radius:2px}';
  document.head.appendChild(_selStyle);

  // ── ★ 媒体控制条 ovmb（2026-09-26）：自建控件样式（原生控件已弃用——⋮ 折叠菜单/系统语言/不可加循环）──
  var _ovMediaStyle = document.createElement('style');
  _ovMediaStyle.textContent =
    '.ovmb{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:5;display:flex;align-items:center;gap:4px;' +
    'padding:7px 10px;border-radius:12px;background:rgba(15,15,15,0.84);border:1px solid rgba(255,255,255,0.14);' +
    'box-shadow:0 6px 24px rgba(0,0,0,0.45);user-select:none;font-family:system-ui,-apple-system,sans-serif;' +
    'width:min(760px,94%);box-sizing:border-box}' +
    '.ovmb-inline{position:static;left:auto;bottom:auto;transform:none;width:560px;max-width:100%}' +
    '.ovmb-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;' +
    'border-radius:7px;background:transparent;color:#e8e6e0;flex:0 0 auto;outline:none;transition:background .12s}' +
    '.ovmb-btn:hover{background:rgba(255,255,255,0.14)}' +
    '.ovmb-btn.ovmb-on{color:#ffd301;background:rgba(255,211,1,0.16)}' +
    '.ovmb-rate{width:auto;min-width:42px;padding:0 6px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}' +
    '.ovmb-time{font-size:12px;color:#cfcbc2;flex:0 0 auto;font-variant-numeric:tabular-nums;text-align:center;min-width:36px}' +
    '.ovmb-seek{position:relative;flex:1 1 auto;height:20px;display:flex;align-items:center;min-width:50px}' +
    '.ovmb-seek-track{position:absolute;left:0;right:0;height:4px;border-radius:2px;background:rgba(255,255,255,0.22)}' +
    '.ovmb-seek-fill{height:100%;width:0%;background:#ffd301;border-radius:2px}' +
    '.ovmb-seek-dot{position:absolute;width:11px;height:11px;border-radius:50%;background:#ffd301;top:50%;left:0%;' +
    'transform:translate(-50%,-50%);opacity:0;transition:opacity .12s}' +
    '.ovmb-seek:hover .ovmb-seek-dot,.ovmb-seek.ovmb-drag .ovmb-seek-dot{opacity:1}' +
    '.ovmb-vol{-webkit-appearance:none;appearance:none;width:58px;height:4px;border-radius:2px;' +
    'background:rgba(255,255,255,0.22);outline:none;flex:0 0 auto;margin:0}' +
    '.ovmb-vol::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:11px;height:11px;border-radius:50%;background:#ffd301;border:none}' +
    '.ovmb-wrap:fullscreen{width:100%;height:100%;max-width:none;max-height:none;background:#000}' +
    '.ovmb-wrap:fullscreen video{max-width:100vw;max-height:100vh}' +
    '.ovmb-ratehost{position:relative;display:flex;flex:0 0 auto}' +
    '.ovmb-modehost{position:relative;display:flex;flex:0 0 auto}' +
    '.ovmb-loop{position:relative}' +
    '.ovmb-m1{position:absolute;right:2px;bottom:1px;font-size:9px;font-weight:700;line-height:1;color:#ffd301;pointer-events:none}' +
    '.ovmb-pos{font-size:11px;color:#b9b5ac;flex:0 0 auto;font-variant-numeric:tabular-nums;padding:0 2px;white-space:nowrap}' +
    // ★ 播放模式面板 v2（2026-09-26）：循环/随机 两独立维度行并列组合；文本行弹性布局（无 fr 轨道——防 absolute shrink-to-fit 塌缩，同倍速面板契约）
    '.ovmb-modepanel{position:absolute;bottom:calc(100% + 10px);right:0;z-index:6;display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:11px;' +
    'background:rgba(18,18,18,0.96);border:1px solid rgba(255,255,255,0.16);box-shadow:0 8px 28px rgba(0,0,0,0.5);white-space:nowrap}' +
    '.ovmb-mrow{display:flex;align-items:center;gap:5px}' +
    '.ovmb-mlab{font-size:11px;color:#a8a49b;flex:0 0 auto;padding-right:2px}' +
    '.ovmb-mopt{height:26px;padding:0 10px;border:none;border-radius:6px;background:rgba(255,255,255,0.08);color:#e8e6e0;' +
    'font-size:12px;white-space:nowrap;outline:none;transition:background .1s}' +
    '.ovmb-mopt:hover{background:rgba(255,255,255,0.18)}' +
    '.ovmb-mopt.ovmb-on{color:#ffd301;background:rgba(255,211,1,0.18)}' +
    // ★ 播放列表面板（2026-09-26 v2）：定宽 + 内部滚动；当前轨金色高亮
    '.ovmb-plhost{position:relative;display:flex;flex:0 0 auto}' +
    '.ovmb-plpanel{position:absolute;bottom:calc(100% + 10px);right:0;z-index:6;display:flex;flex-direction:column;width:300px;max-width:72vw;max-height:min(46vh,340px);padding:9px;border-radius:11px;' +
    'background:rgba(18,18,18,0.96);border:1px solid rgba(255,255,255,0.16);box-shadow:0 8px 28px rgba(0,0,0,0.5);box-sizing:border-box}' +
    '.ovmb-plhead{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#a8a49b;padding:1px 6px 7px;flex:0 0 auto}' +
    '.ovmb-pllist{display:flex;flex-direction:column;gap:2px;overflow-y:auto;min-height:0}' +
    // ★ 行结构 v3（2026-09-26 q319）：行容器（wrap）= 视觉/高亮/拖动单元；名称区 = 内嵌按钮（禁 button 套 button）；行尾三钮（↑ 上移 / ↓ 下移 / − 移除）
    '.ovmb-prowwrap{display:flex;align-items:center;gap:2px;height:28px;padding:0 5px 0 8px;border-radius:6px;color:#e8e6e0;flex:0 0 auto;transition:background .1s}' +
    '.ovmb-prowwrap:hover{background:rgba(255,255,255,0.12)}' +
    '.ovmb-prowwrap.ovmb-cur{color:#ffd301;background:rgba(255,211,1,0.14)}' +
    '.ovmb-prowwrap.ovmb-cur .ovmb-pidx{color:#ffd301}' +
    '.ovmb-prow{display:flex;align-items:center;gap:7px;height:28px;padding:0;border:none;background:transparent;color:inherit;flex:1 1 auto;' +
    'font-size:12px;text-align:left;min-width:0;outline:none}' +
    '.ovmb-pops{display:flex;align-items:center;gap:1px;flex:0 0 auto}' +
    '.ovmb-pop{display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;' +
    'color:#b9b5ac;font-size:12px;line-height:1;outline:none;transition:background .1s,color .1s}' +
    '.ovmb-pop:hover{background:rgba(255,255,255,0.16);color:#fff}' +
    '.ovmb-pop:disabled{opacity:.28}' +
    '.ovmb-pop:disabled:hover{background:transparent;color:#b9b5ac}' +
    '.ovmb-prowwrap.ovmb-dragging{opacity:.4}' +
    '.ovmb-prowwrap.ovmb-dtop{box-shadow:inset 0 2px 0 0 #ffd301}' +
    '.ovmb-prowwrap.ovmb-dbot{box-shadow:inset 0 -2px 0 0 #ffd301}' +
    '.ovmb-pmark{flex:0 0 auto;width:11px;font-size:9px;line-height:1}' +
    '.ovmb-pidx{flex:0 0 auto;min-width:20px;text-align:right;color:#b9b5ac;font-size:11px;font-variant-numeric:tabular-nums}' +
    '.ovmb-pname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    // ★ 定值轨道（2026-09-26）：absolute 容器 + 全 fr 轨道 → shrink-to-fit 内在尺寸塔缩（实测轨道 1.75px、按钮互叠 12 对）；
    //   repeat(4,48px) 内在尺寸恒确定（零依赖 fr 内在算法）；按钮 border-box + width:100% 防 content-box 挤出轨道
    '.ovmb-ratepanel{position:absolute;bottom:calc(100% + 10px);right:0;z-index:6;display:grid;' +
    'grid-template-columns:repeat(4,48px);gap:5px;padding:9px;border-radius:11px;' +
    'background:rgba(18,18,18,0.96);border:1px solid rgba(255,255,255,0.16);box-shadow:0 8px 28px rgba(0,0,0,0.5)}' +
    '.ovmb-rbtn{box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 4px;border:none;border-radius:6px;background:rgba(255,255,255,0.08);' +
    'color:#e8e6e0;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;outline:none;transition:background .1s}' +
    '.ovmb-rbtn:hover{background:rgba(255,255,255,0.18)}' +
    '.ovmb-rbtn.ovmb-on{color:#ffd301;background:rgba(255,211,1,0.18)}' +
    '.ovmb-rrow{grid-column:1/-1;display:flex;gap:5px;margin-top:2px}' +
    '.ovmb-rinput{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);' +
    'background:rgba(0,0,0,0.4);color:#e8e6e0;font-size:12px;outline:none;box-sizing:border-box}' +
    '.ovmb-rinput:focus{border-color:#ffd301}' +
    '.ovmb-rok{height:26px;padding:0 10px;border:none;border-radius:6px;background:rgba(255,211,1,0.22);color:#ffd301;' +
    'font-size:12px;font-weight:600;flex:0 0 auto}' +
    '.ovmb-rok:hover{background:rgba(255,211,1,0.34)}' +
    // ★ A-B 循环（2026-09-26 q319）：按钮双字独金 + 进度条区间底色 + 两端内指三角（▶ 起点 / ◀ 终点）
    '.ovmb-ab{width:auto;min-width:42px;padding:0 6px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}' +
    '.ovmb-aba,.ovmb-abb{opacity:.4}' +
    '.ovmb-ab.ovmb-arm .ovmb-aba{opacity:1;color:#ffd301}' +
    '.ovmb-ab.ovmb-on .ovmb-aba,.ovmb-ab.ovmb-on .ovmb-abb{opacity:1;color:#ffd301}' +
    '.ovmb-abzone{position:absolute;top:50%;transform:translateY(-50%);height:4px;border-radius:2px;background:rgba(255,211,1,0.22);display:none;pointer-events:none}' +
    '.ovmb-abmark{position:absolute;top:50%;width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;transform:translate(-50%,-50%);display:none;pointer-events:none}' +
    '.ovmb-abmark-a{border-left:6px solid #ffd301}' +
    '.ovmb-abmark-b{border-right:6px solid #ffd301}';
  document.head.appendChild(_ovMediaStyle);

  var contentEl = document.createElement('div');
  contentEl.id = 'qqq-ai-overlay-content';
  contentEl.style.cssText =
    'position:absolute; top:0; left:0; right:0; bottom:64px; display:flex; align-items:center; ' +
    'justify-content:center; padding:32px; overflow:hidden;';

  // ★ 悬浮预览内路径链接 → Roam 定位（2026-09-06：代码块/表格 View 展开场景，_roamRevealText 同闭包）
  // ★ 2026-09-07 门控：仅已确认存在（面板探针打过 .qqq-path-ok）直接跳；未确认拷贝 → 主窗口直连裁决一次
  contentEl.addEventListener('click', function (e) {
    var _pl = e.target && e.target.closest ? e.target.closest('.qqq-path-link') : null;
    if (!_pl) return;
    e.preventDefault();
    e.stopPropagation();
    var _p = _pl.getAttribute('data-p') || _pl.textContent || '';
    var _c = _pl.getAttribute('data-c') || '';
    if (_pl.classList.contains('qqq-path-ok')) { _roamRevealText(_p, _c); return; }
    _ovProbeThen(_p, _c, _pl, function () { _roamRevealText(_p, _c); });
  });

  // Bottom toolbar
  var toolbar = document.createElement('div');
  toolbar.id = 'qqq-ai-overlay-toolbar';
  toolbar.style.cssText =
    'position:absolute; bottom:0; left:0; right:0; height:64px; display:flex; ' +
    'align-items:center; justify-content:center; gap:16px; ' +
    'background:rgba(0,0,0,0.5); border-top:1px solid rgba(255,255,255,0.1);';

  function tbBtn(text, title, styles) {
    var b = document.createElement('button');
    b.textContent = text;
    b.title = title || '';
    b.tabIndex = -1;  // ★ 防焦点窃取：按钮不抢焦点，确保 Ctrl+C 原生复制可用
    b.style.cssText = 'padding:8px 18px; border:1px solid rgba(255,255,255,0.25); border-radius:6px; ' +
      'background:rgba(255,255,255,0.1); color:#fff; font-size:14px; ' +
      'user-select:none; line-height:1; outline:none; ' + (styles || '');
    return b;
  }

  var zoomScale = 1.0;
  // 拖拽偏移（图片和表格共用 translate）
  var _dragX = 0, _dragY = 0;

  // ── 选中高亮全文匹配（CSS Highlight API — 零 DOM 操作，不阻复制、零抖动）──
  var _ovLastMatchText = '';
  // ★ 图片本地路径（open-image 消息 localPath 透传；dataUrl 缩略图场景的文件/路径按钮靠它）
  var _ovLocalPath = null;
  // ★ 媒体截图落盘基准（原始文件路径；转码回放时 _ovLocalPath 指向 Cache 产物 → 截图必须落原始文件目录）
  var _ovShotBase = null;

  function _ovApplyHighlights(text) {
    _ovClearHighlights();
    if (!text || text.length < 1) return;
    _ovLastMatchText = text;
    // 找到表格/代码块的 wrapper
    var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper');
    if (!wrapper) {
      var d2 = contentEl.querySelector('div > div');
      if (d2 && !d2.querySelector('img')) wrapper = d2;
    }
    if (!wrapper) return;
    var tLower = text.toLowerCase();
    var ranges = [];
    var walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (!node.textContent || !node.textContent.trim()) continue;
      var lower = node.textContent.toLowerCase();
      var searchFrom = 0;
      while (searchFrom < lower.length) {
        var idx = lower.indexOf(tLower, searchFrom);
        if (idx < 0) break;
        var r = new Range();
        r.setStart(node, idx);
        r.setEnd(node, idx + text.length);
        ranges.push(r);
        searchFrom = idx + tLower.length;
      }
    }
    if (ranges.length > 0) {
      try {
        var hl = new Highlight();
        for (var ri = 0; ri < ranges.length; ri++) hl.add(ranges[ri]);
        CSS.highlights.set('ov-matches', hl);
      } catch (_) { /* CSS Highlight API 不可用则静默降级 */ }
    }
  }

  function _ovClearHighlights() {
    try { CSS.highlights.delete('ov-matches'); } catch (_) { }
    _ovLastMatchText = '';
  }
  function applyZoom() {
    var img = contentEl.querySelector('img');
    if (img) {
      img.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
      img.style.transition = 'transform 0.15s ease';
      return;
    }
    // 表格：wrapper 在 clipBox 内，统一采用 scale+translate（禁止 reflow，保持原始比例与换行）
    var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper');
    if (!wrapper) {
      // 回退：可能是旧版本无 class 的 div
      var div = contentEl.querySelector('div > div');
      if (div && !div.querySelector('img')) wrapper = div;
    }
    if (!wrapper) {
      var div2 = contentEl.querySelector('div');
      if (div2 && !div2.querySelector('img') && !div2.classList.contains('qqq-overlay-table-wrapper')) wrapper = div2;
    }
    if (wrapper) {
      wrapper.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
      wrapper.style.transition = 'transform 0.15s ease';
    }
  }

  // Copy button — 固定文字，禁止 i18n 覆写和动画（防按钮变宽→焦点窃取→Ctrl+C 失效）
  var _ovSavedRange = null;  // ★ 保存最后选区，点击复制按钮时选区已被浏览器清掉，用此恢复
  var copyBtnLabel = window._i('shell.overlay.copy', '复制到剪贴板');
  var copyBtn = tbBtn('\uD83D\uDCCB ' + copyBtnLabel, copyBtnLabel);
  // ★ 不设 data-i18n — i18n updateDom 会覆写 textContent 导致按钮变宽→焦点变化→Ctrl+C 截断
  function doCopy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
    function fallbackCopy(t) {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { }
      document.body.removeChild(ta);
    }
  }
  copyBtn.addEventListener('mousedown', function (e) {
    // ★ 在浏览器清掉选区之前，先保存当前 Range（click 事件触发时选区已空）
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
      _ovSavedRange = sel.getRangeAt(0).cloneRange();
    } else {
      _ovSavedRange = null;
    }
  });
  copyBtn.addEventListener('click', function () {
    var sel = window.getSelection();
    var text = sel && sel.toString().trim();
    // 若当前选区已被清空，回退到 mousedown 时保存的 Range
    if (!text && _ovSavedRange) {
      text = _ovSavedRange.toString().trim();
    }
    if (text) {
      doCopy(text);
      // ★ 复制后恢复选区（黄色高亮不丢）
      if (_ovSavedRange) {
        try {
          var s = window.getSelection();
          s.removeAllRanges();
          s.addRange(_ovSavedRange);
        } catch (_) { }
      }
      return;
    }
    // ★ 文本优先 — img.src 仅当无文本内容时兜底（防代码块内含 <img> 时复制 file:// URL）
    var wrapper = contentEl.querySelector('.qqq-overlay-table-wrapper') || contentEl.querySelector('div');
    if (wrapper) {
      var txt = wrapper.innerText || wrapper.textContent || '';
      if (txt.trim()) { doCopy(txt); return; }
    }
    var img = contentEl.querySelector('img');
    if (img) { doCopy(img.src); return; }
  });

  // ★ 图片专用三按钮（内存/文件/路径）——仅图片预览显示；表格/代码块隐藏，保持原样
  var memBtn = tbBtn(window._i('shell.overlay.mem', '内存'), window._i('shell.overlay.memTitle', '图片进入内存（剪贴板图像），可直接粘贴到聊天或画布'));
  var fileBtn = tbBtn(window._i('shell.overlay.file', '文件'), window._i('shell.overlay.fileTitle', '复制图片文件，可粘贴到聊天/Roam/资源管理器'));
  var pathBtn = tbBtn(window._i('shell.overlay.path', '路径'), window._i('shell.overlay.pathTitle', '复制图片路径'));

  // 当前 overlay 媒体元素（视频/音频预览存在 <video>/<audio>）
  function _ovMediaEl() {
    return contentEl.querySelector('video') || contentEl.querySelector('audio');
  }
  // 关闭/切换/重开前停止媒体播放（Element 从 DOM 移除不保证停播——必须显式 pause+卸载，防「关了还在响」）
  // ★ 2026-09-26：并执行媒体会话清理钩子（控制条监听/键盘钩子/全屏退出）——open-image/open-table 直切不经 close 包装器也必清
  var _ovMediaCleanup = null;
  function _stopMedia() {
    try {
      var m = _ovMediaEl();
      if (m) { m.pause(); m.removeAttribute('src'); m.load(); }
    } catch (_) { }
    if (_ovMediaCleanup) { var _mc = _ovMediaCleanup; _ovMediaCleanup = null; try { _mc(); } catch (_) { } }
  }
  // 当前 overlay 主体 src（图片优先；媒体兜底——文件/路径按钮对两者通用）
  function _currentOverlayImgSrc() {
    var img = contentEl.querySelector('img');
    if (img) return img.src;
    var m = _ovMediaEl();
    return m ? m.src : null;
  }
  // src → 本地文件路径：file:/// URL 解码 / 裸盘符路径（A4/徽章/灯箱直传形态）直接收
  function _localPathFromSrc(src) {
    if (typeof src !== 'string') return null;
    if (/^file:\/\//i.test(src)) {
      var p = src.replace(/^file:\/\/\//i, '');
      try { p = decodeURIComponent(p); } catch (_) { }
      return p;
    }
    if (/^[A-Za-z]:[\\/]/.test(src)) return src;
    return null;
  }
  function _ovToast(msg, type) {
    if (window.qqqideQoast) window.qqqideQoast.show(msg, { type: type || 'info', duration: 2500 });
  }

  // ═══ ★ 转码兜底（2026-09-21）：Chromium 原生解不了的格式（avi/wmv/flv/rmvb/prores/psd…）═══
  //   壳层 ffmpeg 智能转码（media.playable：同编码 copy 秒级重封装 / 否则 x264）→ 产物回放/回显
  //   进度 qqqide:media:playable:progress；取消 = media.playableCancel；关闭/切换自动取消在飞任务
  var _OV_TX_FIRST_EXTS = { '.avi': 1, '.wmv': 1, '.flv': 1, '.rmvb': 1, '.rm': 1, '.mpg': 1, '.mpeg': 1, '.m2ts': 1, '.mts': 1, '.3gp': 1, '.vob': 1, '.asf': 1, '.f4v': 1, '.ogm': 1, '.wma': 1, '.aiff': 1, '.aif': 1, '.ape': 1, '.ac3': 1, '.mka': 1, '.amr': 1, '.au': 1, '.psd': 1, '.tif': 1, '.tiff': 1 };
  function _ovTxExt(p) {
    var s = String(p || '').toLowerCase();
    var i = s.lastIndexOf('.');
    return i === -1 ? '' : s.substring(i);
  }
  var _ovTxReqId = null;
  var _ovTxUnsub = null;
  var _ovTxBarEl = null, _ovTxBarText = null;
  function _ovTxBarShow(show) {
    if (!_ovTxBarEl) {
      if (!show) { return; }
      _ovTxBarEl = document.createElement('div');
      _ovTxBarEl.style.cssText = 'position:absolute;left:50%;bottom:88px;transform:translateX(-50%);z-index:100002;' +
        'display:flex;align-items:center;gap:12px;background:rgba(0,0,0,0.78);color:#fff;border-radius:10px;' +
        'padding:10px 16px;font-size:13px;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,0.5);';
      _ovTxBarText = document.createElement('span');
      _ovTxBarText.textContent = window._i('shell.overlay.transcoding', '正在转码预览…');
      var _txCancelBtn = document.createElement('button');
      _txCancelBtn.textContent = window._i('common.cancel', '取消');
      _txCancelBtn.setAttribute('data-no-cd', '');
      _txCancelBtn.style.cssText = 'padding:3px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.35);' +
        'background:transparent;color:#fff;font-size:12px;cursor:pointer;';
      _txCancelBtn.addEventListener('click', function () {
        _ovTxAbort();
        try { close(); } catch (_) { }
      });
      _ovTxBarEl.appendChild(_ovTxBarText);
      _ovTxBarEl.appendChild(_txCancelBtn);
      overlay.appendChild(_ovTxBarEl);
    }
    _ovTxBarEl.style.display = show ? 'flex' : 'none';
  }
  function _ovTxAbort() {
    if (_ovTxUnsub) { try { _ovTxUnsub(); } catch (_) { } _ovTxUnsub = null; }
    if (_ovTxReqId && bridge && bridge.media && bridge.media.playableCancel) {
      try { bridge.media.playableCancel(_ovTxReqId); } catch (_) { }
    }
    _ovTxReqId = null;
    _ovTxBarShow(false);
  }
  // 启动转码：成功后回调 onOk(正斜杠产物路径)；失败/取消回调 onFail()
  function _ovTxRun(filePath, kind, onOk, onFail) {
    if (!filePath || !bridge || !bridge.media || !bridge.media.playable) {
      try { onFail(); } catch (_) { }
      return;
    }
    var rid = 'ov-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    _ovTxReqId = rid;
    _ovTxBarShow(true);
    if (bridge.media.onPlayableProgress) {
      try {
        _ovTxUnsub = bridge.media.onPlayableProgress(function (m) {
          if (!m || m.reqId !== rid || !_ovTxBarText) { return; }
          var base = window._i('shell.overlay.transcoding', '正在转码预览…');
          _ovTxBarText.textContent = (m.pct != null && m.pct >= 0) ? (base + ' ' + m.pct + '%') : base;
        });
      } catch (_) { }
    }
    bridge.media.playable({ src: filePath, kind: kind, reqId: rid }).then(function (r) {
      if (_ovTxReqId !== rid) { return; }   // 已被取消/切换（abort 置 null）→ 丢弃结果
      if (_ovTxUnsub) { try { _ovTxUnsub(); } catch (_) { } _ovTxUnsub = null; }
      _ovTxReqId = null;
      _ovTxBarShow(false);
      if (r && r.ok && r.path) {
        try { onOk(String(r.path).replace(/\\/g, '/')); } catch (_) { }
      } else if (r && r.cancelled) {
        /* 用户取消：静默 */
      } else {
        try { onFail(); } catch (_) { }
      }
    }).catch(function () {
      if (_ovTxReqId !== rid) { return; }
      _ovTxReqId = null;
      _ovTxBarShow(false);
      try { onFail(); } catch (_) { }
    });
  }

  // 内存 — 图片进剪贴板（图像数据），可直接粘贴到聊天/画布
  memBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) { _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return; }
    var p = _ovLocalPath || _localPathFromSrc(src);
    var payload = p ? { path: p } : (/^data:/i.test(src) ? { dataUrl: src } : null);
    if (!payload || !bridge || !bridge.clipboard || !bridge.clipboard.writeImage) {
      _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeImage(payload).then(function (ok) {
      _ovToast(ok ? window._i('shell.overlay.memOk', '图片已进入内存，可直接粘贴') : window._i('shell.overlay.copyFailed', '复制失败'), ok ? 'success' : 'error');
    }).catch(function () { _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
  });

  // 文件 — 复制图片文件本体（CF_HDROP），可粘贴到聊天/Roam/资源管理器
  fileBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) return;
    var p = _ovLocalPath || _localPathFromSrc(src);
    if (!p) { _ovToast(window._i('shell.overlay.noLocalFile', '该图片无本地文件，无法复制文件'), 'info'); return; }
    if (!bridge || !bridge.clipboard || !bridge.clipboard.writeFiles) {
      _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeFiles([p]).then(function (ok) {
      _ovToast(ok ? window._i('shell.overlay.fileOk', '文件已复制，可直接粘贴') : window._i('shell.overlay.copyFailed', '复制失败'), ok ? 'success' : 'error');
    }).catch(function () { _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
  });

  // 路径 — 复制图片文件路径
  pathBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) return;
    var p = _ovLocalPath || _localPathFromSrc(src);
    if (!p) {
      if (/^data:/i.test(src)) { _ovToast(window._i('shell.overlay.noLocalPath', '该图片无本地路径'), 'info'); return; }
      _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    if (!bridge || !bridge.clipboard || !bridge.clipboard.writeText) {
      _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeText(p).then(function () {
      _ovToast(window._i('shell.overlay.copied', '已复制'), 'success');
    }).catch(function () { _ovToast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
  });

  // Zoom out（跳过冷却护盾，准许快速连按）
  var zoomOutBtn = tbBtn('\u2212', window._i('shell.overlay.zoomOut', '缩小'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
  zoomOutBtn.setAttribute('data-no-cd', '');
  zoomOutBtn.addEventListener('click', function () {
    zoomScale = Math.max(0.25, zoomScale * 0.8);
    applyZoom();
  });

  // Zoom in（跳过冷却护盾，准许快速连按）
  var zoomInBtn = tbBtn('+', window._i('shell.overlay.zoomIn', '放大'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
  zoomInBtn.setAttribute('data-no-cd', '');
  zoomInBtn.addEventListener('click', function () {
    zoomScale = Math.min(5.0, zoomScale * 1.25);
    applyZoom();
  });

  // Close (extra large) — custom tooltip: high-contrast instant cursor-following
  var closeBtnEl = tbBtn('\u2715', '', 'font-size:24px; font-weight:bold; padding:8px 22px; ' +
    'background:rgba(220,50,47,0.5); border-color:rgba(220,50,47,0.7);');
  closeBtnEl.addEventListener('click', close);

  // ★ 自定义高对比度瞬间弹出 tooltip，跟随光标
  var _closeTt = document.createElement('div');
  _closeTt.textContent = '= Right Click';
  _closeTt.style.cssText = 'display:none;position:fixed;z-index:100001;pointer-events:none;' +
    'background:#000;color:#ffd301;padding:4px 10px;font-size:12px;font-weight:700;' +
    'font-family:system-ui,-apple-system,sans-serif;border:2px solid #ffd301;border-radius:4px;white-space:nowrap;' +
    'line-height:1.4;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.8);';
  document.body.appendChild(_closeTt);
  closeBtnEl.addEventListener('mouseenter', function (e) {
    _closeTt.style.display = '';
    _closeTt.style.left = (e.clientX + 16) + 'px';
    _closeTt.style.top = (e.clientY - 36) + 'px';
  });
  closeBtnEl.addEventListener('mousemove', function (e) {
    _closeTt.style.left = (e.clientX + 16) + 'px';
    _closeTt.style.top = (e.clientY - 36) + 'px';
  });
  closeBtnEl.addEventListener('mouseleave', function () {
    _closeTt.style.display = 'none';
  });

  // 右键关闭
  overlay.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    close();
  });

  toolbar.appendChild(copyBtn);
  toolbar.appendChild(memBtn);
  toolbar.appendChild(fileBtn);
  toolbar.appendChild(pathBtn);
  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(closeBtnEl);

  overlay.appendChild(contentEl);
  overlay.appendChild(toolbar);
  // ★ 挂到 #qqq-main + inset:0 → 悬浮城 = 菜单行 + 中区（含中AI面板）+ 状态栏；
  //    左右翼是 #qqq-main 的兄弟节点（shell-wings _applyWings 通过 main 的 left/right 让位）
  //    → 天然不覆盖翼板，100% 等同历史悬浮城区域
  var _mainEl = document.getElementById('qqq-main');
  (_mainEl || document.body).appendChild(overlay);

  function close() {
    _ovLocalPath = null;
    try { _stopRepeat(); } catch (_) { }
    try { _stopMedia(); } catch (_) { }
    try { _ovTxAbort(); } catch (_) { }
    try { _ovClearHighlights(); } catch (_) { }
    _closeTt.style.display = 'none';
    overlay.style.display = 'none';
    dpad.style.display = 'none';
    contentEl.innerHTML = '';
    contentEl.style.overflow = '';
    zoomScale = 1.0;
    _dragX = 0; _dragY = 0;
  }
  var _baseClose = close;  // 保存原始 close，用于恢复

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) close();
  });

  // ★ Ctrl+C：让浏览器原生处理（tabIndex=-1 防焦点窃取已确保原生复制通路畅通）
  //    不设自定义拦截 — preventDefault 会阻断浏览器维持选区，导致黄色高亮消失
  //    Escape 仍然手动处理
  document.addEventListener('keydown', function (e) {
    if (overlay.style.display === 'none') return;
    if (e.key === 'Escape') {
      // ★ 倍速面板打开 → Esc 先关面板（2026-09-26 v2）
      if (_ovMediaEscapeFn) { try { if (_ovMediaEscapeFn()) return; } catch (_) { } }
      // ★ 全屏中 Esc 先退全屏（浏览器原生处理），不关悬浮层（2026-09-26 自建控制条配套）
      if (document.fullscreenElement) return;
      close(); return;
    }
    if (_ovMediaKeysFn) { try { _ovMediaKeysFn(e); } catch (_) { } }
  });

  // ── 选中高亮全文匹配（CSS Highlight API）──
  overlay.addEventListener('mouseup', function (e) {
    if (overlay.style.display === 'none') return;
    if (e.target.closest('#qqq-ai-overlay-toolbar')) return;
    if (e.target.closest('button')) return;
    // ★ 保存当前选区 Range（供复制按钮恢复用）
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
      _ovSavedRange = sel.getRangeAt(0).cloneRange();
    }
    setTimeout(function () {
      if (overlay.style.display === 'none') return;
      var sel2 = window.getSelection();
      var text = sel2 && sel2.toString().trim();
      if (text && text.length >= 1 && text !== _ovLastMatchText) {
        _ovApplyHighlights(text);
      } else if (!text) {
        _ovClearHighlights();
      }
    }, 80);
  });

  overlay.addEventListener('mousedown', function (e) {
    if (overlay.style.display === 'none') return;
    // 工具栏/D-pad 区域不触发高亮清除（否则点复制按钮会消掉选区）
    if (e.target.closest('#qqq-ai-overlay-toolbar')) return;
    if (e.target.closest('button')) return;
    setTimeout(function () {
      if (overlay.style.display === 'none') return;
      var sel = window.getSelection();
      var newText = sel && sel.toString().trim();
      if (!newText || newText !== _ovLastMatchText) {
        _ovClearHighlights();
      }
    }, 100);
  });

  // Mouse wheel zoom（统一图片和表格，滚轮=缩放）
  overlay.addEventListener('wheel', function (e) {
    if (overlay.style.display === 'none') return;
    e.preventDefault(); e.stopPropagation();
    if (e.deltaY < 0) { zoomScale = Math.min(5.0, zoomScale * 1.15); }
    else { zoomScale = Math.max(0.25, zoomScale * 0.87); }
    applyZoom();
  }, { passive: false, capture: true });

  // ── 十字方向键（Game Boy 风格，独立控件，移动画布）──
  var dpad = document.createElement('div');
  dpad.style.cssText =
    'display:none; position:absolute; right:14px; bottom:78px; z-index:100000; ' +
    'width:96px; height:96px; user-select:none;';
  var BS = 32; // button size
  function _crossBtn(sym, top, left) {
    var b = document.createElement('button');
    b.textContent = sym; b.setAttribute('data-no-cd', '');
    b.tabIndex = -1;  // ★ 防焦点窃取
    b.style.cssText = 'position:absolute; width:' + BS + 'px; height:' + BS + 'px; padding:0; font-size:16px; line-height:1; ' +
      'border:1px solid rgba(255,255,255,0.35); border-radius:4px; background:rgba(0,0,0,0.55); ' +
      'color:#ccc; display:flex; align-items:center; justify-content:center; outline:none;';
    b.style.top = top + 'px'; b.style.left = left + 'px';
    return b;
  }
  var btnUp = _crossBtn('\u25B2', 0, BS);
  var btnLeft = _crossBtn('\u25C0', BS, 0);
  var btnCenter = _crossBtn('\u2302', BS, BS);
  var btnRight = _crossBtn('\u25B6', BS, BS * 2);
  var btnDown = _crossBtn('\u25BC', BS * 2, BS);
  btnCenter.title = window._i('shell.overlay.resetPosition', '重置位置');
  btnCenter.style.background = 'rgba(255,255,255,0.12)';
  btnCenter.style.borderColor = 'rgba(255,255,255,0.25)';
  var _initZoom = 1.0;
  function _nudge(dx, dy) {
    var step = 80;
    var s = zoomScale || 1;
    // 图片和表格统一用 _dragX/_dragY + translate，scrollLeft 在 transform scale 下无效
    _dragX -= dx * step / s;
    _dragY -= dy * step / s;
    applyZoom();
  }
  function _resetView() {
    _dragX = 0; _dragY = 0;
    var w = contentEl.querySelector('.qqq-overlay-table-wrapper') || contentEl.querySelector('img');
    if (w) { zoomScale = _initZoom; }
    else { zoomScale = 1.0; }
    applyZoom();
  }
  // ── 按住连点：mousedown 启动定时器，mouseup/mouseleave 停止 ──
  var _repeatTimer = 0, _repeatDelay = 150, _repeatInterval = 50;
  function _startRepeat(dx, dy) {
    _nudge(dx, dy);
    _repeatTimer = setTimeout(function () {
      _repeatTimer = setInterval(function () { _nudge(dx, dy); }, _repeatInterval);
    }, _repeatDelay);
  }
  function _stopRepeat() {
    if (_repeatTimer) { clearTimeout(_repeatTimer); clearInterval(_repeatTimer); _repeatTimer = 0; }
  }
  function _bindDpadBtn(btn, dx, dy) {
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); _startRepeat(dx, dy); });
    btn.addEventListener('mouseup', function (e) { e.preventDefault(); _stopRepeat(); });
    btn.addEventListener('mouseleave', function (e) { _stopRepeat(); });
  }
  _bindDpadBtn(btnUp, 0, -1);
  _bindDpadBtn(btnDown, 0, 1);
  _bindDpadBtn(btnLeft, -1, 0);
  _bindDpadBtn(btnRight, 1, 0);
  btnCenter.addEventListener('mousedown', function (e) { e.preventDefault(); _resetView(); });
  dpad.appendChild(btnUp); dpad.appendChild(btnLeft); dpad.appendChild(btnCenter);
  dpad.appendChild(btnRight); dpad.appendChild(btnDown);
  overlay.appendChild(dpad);

  // ═══ ★ 媒体控制条（2026-09-26）：悬浮层播放器弃用原生控件 → 自建控制条 ═══
  //   动机：原生控件 = Chromium 内置（⋮ 折叠菜单 / 系统语言文案 / 不可加按钮 / 不接本机 i18n）；
  //   自建 = 播放/逐帧/截图/进度/时间/音量/倍速/播放模式/A-B 循环/画中画/全屏 全部直显、一键可达，文案全走 window._i（13 语言）。
  //   倍速 = 点击展开面板（0.5~4 预设单按钮网格 + 自定义倍数输入·确认/回车；非 1× 金色高亮）；
  //   循环按钮 = 播放模式入口（点击上展模式面板：循环[关/列表循环/单曲循环] × 随机[关/开] 并列组合；L 键切循环 / R 键切随机）；倍速/播放模式会话内粘性（重开下一个文件保持）；
  //   按钮 data-no-cd 跳过全局冷却护盾（准许连点）；会话清理经 _stopMedia 统一执行（close/切换全覆盖）。
  var _OV_MEDIA_RATE_PRESETS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];   // 面板预设（每步一个按钮）
  var _ovMediaRate = 1;         // 会话粘性（支持任意自定义值）
  var _ovMediaFps = 0;          // 逐帧步进用实测帧率（rVFC 测量，未测到回落 30）
  var _ovMediaEscapeFn = null;  // Esc 前置钩子（倍速/模式面板打开时先关面板，不关悬浮层）
  // ★ 播放模式 v2（2026-09-26 q319 用户定案）：循环（关/列表循环/单曲循环）与 随机（关/开）为两个并列独立维度，任意组合
  //   —— 组合覆盖：顺序单次 / 顺序循环 / 随机单次 / 随机循环 / 单曲循环；会话粘性；多文件列表打开时重置为 循环=列表循环 + 随机=关
  var _ovMediaLoop = 'off';       // 'off' | 'all' | 'one'
  var _ovMediaShuffle = false;    // 随机维度（与循环并列）
  function _ovLoopName(v) {
    if (v === 'all') { return window._i('shell.overlay.modeListLoop', '列表循环'); }
    if (v === 'one') { return window._i('shell.overlay.modeOne', '单曲循环'); }
    return window._i('shell.overlay.mOff', '关');
  }
  function _ovShufName(v) { return v ? window._i('shell.overlay.mOn', '开') : window._i('shell.overlay.mOff', '关'); }
  var _ovMediaKeysFn = null;   // 媒体键盘钩子（打开期间有效；_stopMedia 自动摘除）

  function _ovMediaIcon(d) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" ' +
      'style="display:block;pointer-events:none"><path d="' + d + '"/></svg>';
  }
  var _OV_MEDIA_ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    volMute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    prev: 'M6 6h2v12H6zM9.5 12l8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    step: 'M7 5v14l8-7zM17 5h-2v14h2z',
    shot: 'M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z',
    pip: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
    fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    fsExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z'
  };
  function _ovFmtT(s) {
    if (!isFinite(s) || s < 0) { return '--:--'; }
    var t = Math.floor(s);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
    return (h > 0 ? h + ':' + (m < 10 ? '0' + m : m) : m) + ':' + (ss < 10 ? '0' + ss : ss);
  }

  // 构建控制条 → { bar, cleanup, keys, setTrack, resetAB }；wrapEl = 全屏目标（视频包装层；音频为 null）
  //   api（可选）= 播放列表上下文 { n, idx, onEnded, onPrev, onNext }——n>1 时出 ⏮/⏭ + n/N 计数；ended 交外部裁决
  function _ovBuildMediaBar(mEl, isVid, wrapEl, api) {
    var bar = document.createElement('div');
    bar.className = 'ovmb' + (isVid ? '' : ' ovmb-inline');

    function _mBtn(d, title) {
      var b = document.createElement('button');
      b.className = 'ovmb-btn';
      b.tabIndex = -1;
      b.setAttribute('data-no-cd', '');
      b.innerHTML = _ovMediaIcon(d);
      if (title) { b.title = title; }
      // 防焦点窃取（点后 Space 不误触按钮激活 → 键盘空格=播放/暂停 唯一语义）
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      return b;
    }

    var playB = _mBtn(_OV_MEDIA_ICONS.play, window._i('shell.overlay.mplay', '播放'));
    var curT = document.createElement('span'); curT.className = 'ovmb-time'; curT.textContent = '0:00';
    var seek = document.createElement('div'); seek.className = 'ovmb-seek';
    var seekTrack = document.createElement('div'); seekTrack.className = 'ovmb-seek-track';
    var seekFill = document.createElement('div'); seekFill.className = 'ovmb-seek-fill';
    var seekDot = document.createElement('div'); seekDot.className = 'ovmb-seek-dot';
    // ★ A-B 循环可视化（2026-09-26）：区间底色 + 两端内指三角（▶ 起点 / ◀ 终点）；滑块最后叠顶
    var abZone = document.createElement('div'); abZone.className = 'ovmb-abzone';
    var abMarkA = document.createElement('div'); abMarkA.className = 'ovmb-abmark ovmb-abmark-a';
    var abMarkB = document.createElement('div'); abMarkB.className = 'ovmb-abmark ovmb-abmark-b';
    seekTrack.appendChild(seekFill);
    seek.appendChild(seekTrack);
    seek.appendChild(abZone); seek.appendChild(abMarkA); seek.appendChild(abMarkB);
    seek.appendChild(seekDot);
    var durT = document.createElement('span'); durT.className = 'ovmb-time'; durT.textContent = '--:--';
    var volB = _mBtn(_OV_MEDIA_ICONS.vol, window._i('shell.overlay.mmute', '静音'));
    var volS = document.createElement('input');
    volS.type = 'range'; volS.className = 'ovmb-vol';
    volS.min = '0'; volS.max = '1'; volS.step = '0.05';
    volS.tabIndex = -1; volS.title = window._i('shell.overlay.mvolume', '音量');
    var rateHost = document.createElement('div');
    rateHost.className = 'ovmb-ratehost';
    var rateB = document.createElement('button');
    rateB.className = 'ovmb-btn ovmb-rate'; rateB.tabIndex = -1;
    rateB.setAttribute('data-no-cd', '');
    rateB.title = window._i('shell.overlay.mspeed', '倍速播放（点击选择）');
    rateB.addEventListener('mousedown', function (e) { e.preventDefault(); });
    rateHost.appendChild(rateB);
    // ★ 播放模式按钮（2026-09-26 q319；v2 并列双维度）：点击上展模式面板（循环[关/列表循环/单曲循环] × 随机[关/开]）
    var loopB = _mBtn(_OV_MEDIA_ICONS.repeat, window._i('shell.overlay.mmode', '播放模式（L 循环 / R 随机）'));
    loopB.classList.add('ovmb-loop');
    var modeHost = document.createElement('div');
    modeHost.className = 'ovmb-modehost';
    modeHost.appendChild(loopB);
    // ★ 播放列表按钮（2026-09-26 q319 v2）：列表（n>1）时出现——点击上展播放列表面板（列表结构全览 + 当前轨高亮 + 点击任意行切轨）
    var plHost = null, plB = null;
    if (api && api.n > 1) {
      plHost = document.createElement('div');
      plHost.className = 'ovmb-plhost';
      plB = _mBtn(_OV_MEDIA_ICONS.list, window._i('shell.overlay.mplist', '播放列表'));
      plB.classList.add('ovmb-pbtn');
      plB.addEventListener('click', _togglePlPanel);
      plHost.appendChild(plB);
    }
    // ★ A-B 循环按钮（2026-09-26 q319）：三态循环——首点标 A → 次点标 B 起循（跳回 A）→ 再点清除；A/B 字各自金色指示状态
    var abB = document.createElement('button');
    abB.className = 'ovmb-btn ovmb-ab';
    abB.tabIndex = -1;
    abB.setAttribute('data-no-cd', '');
    abB.addEventListener('mousedown', function (e) { e.preventDefault(); });
    abB.innerHTML = '<span class="ovmb-aba">A</span>-<span class="ovmb-abb">B</span>';
    var pipB = null, fsB = null, stepB = null, shotB = null, prevB = null, nextB = null, posT = null;
    // ★ 播放列表控件（2026-09-26 q319）：n>1 才出现——上一个/下一个 + 位置计数（n/N）
    if (api && api.n > 1) {
      prevB = _mBtn(_OV_MEDIA_ICONS.prev, window._i('shell.overlay.mprev', '上一个'));
      prevB.classList.add('ovmb-prev');
      nextB = _mBtn(_OV_MEDIA_ICONS.next, window._i('shell.overlay.mnext', '下一个'));
      nextB.classList.add('ovmb-next');
      prevB.addEventListener('click', function () { if (api.onPrev) { api.onPrev(); } });
      nextB.addEventListener('click', function () { if (api.onNext) { api.onNext(); } });
      posT = document.createElement('span');
      posT.className = 'ovmb-pos';
      posT.textContent = (api.idx + 1) + '/' + api.n;
    }

    // 粘性应用（会话内跨文件保持）
    mEl.playbackRate = _ovMediaRate;

    function _togglePlay() {
      if (mEl.paused || mEl.ended) {
        if (mEl.ended) { try { mEl.currentTime = 0; } catch (_) { } }   // 播毕重播（模式引擎弃用原生 loop 后的重播入口）
        var p = mEl.play(); if (p && p.catch) { p.catch(function () { }); }
      } else { mEl.pause(); }
    }
    function syncPlay() {
      var playing = !mEl.paused && !mEl.ended;
      playB.innerHTML = _ovMediaIcon(playing ? _OV_MEDIA_ICONS.pause : _OV_MEDIA_ICONS.play);
      playB.title = playing ? window._i('shell.overlay.mpause', '暂停') : window._i('shell.overlay.mplay', '播放');
    }
    function syncVol() {
      var m = !!mEl.muted || mEl.volume === 0;
      volB.innerHTML = _ovMediaIcon(m ? _OV_MEDIA_ICONS.volMute : _OV_MEDIA_ICONS.vol);
      volB.title = m ? window._i('shell.overlay.munmute', '取消静音') : window._i('shell.overlay.mmute', '静音');
      volS.value = String(mEl.volume);
    }
    function syncProg() {
      var d = mEl.duration, ok = isFinite(d) && d > 0;
      var pct = ok ? Math.max(0, Math.min(100, (mEl.currentTime / d) * 100)) : 0;
      seekFill.style.width = pct + '%';
      seekDot.style.left = pct + '%';
      curT.textContent = _ovFmtT(mEl.currentTime);
      durT.textContent = ok ? _ovFmtT(d) : '--:--';
    }
    function _ovFmtRate(v) { return String(Math.round(v * 100) / 100) + '\u00D7'; }
    function syncRate() {
      rateB.textContent = _ovFmtRate(_ovMediaRate);
      rateB.classList.toggle('ovmb-on', _ovMediaRate !== 1);
      if (_panel) {
        var _rpnBtns = _panel.querySelectorAll('.ovmb-rbtn');
        for (var _rpi = 0; _rpi < _rpnBtns.length; _rpi++) {
          _rpnBtns[_rpi].classList.toggle('ovmb-on', Math.abs(parseFloat(_rpnBtns[_rpi].textContent) - _ovMediaRate) < 0.001);
        }
      }
    }
    // ★ 倍速面板（2026-09-26 v2 用户定案）：点击 [1×] 在按钮上方展开——0.5~4 预设单按钮网格（每步一个按钮）+ 自定义倍数（确认/回车任意值）
    var _panel = null, _panelDocFn = null;
    function _applyRate(v) {
      if (!isFinite(v)) { return; }
      v = Math.round(Math.max(0.0625, Math.min(16, v)) * 100) / 100;
      _ovMediaRate = v;
      mEl.playbackRate = v;
      syncRate();
    }
    function _closeRatePanel() {
      if (_panelDocFn) { document.removeEventListener('pointerdown', _panelDocFn, true); _panelDocFn = null; }
      if (_panel && _panel.parentNode) { _panel.parentNode.removeChild(_panel); }
      _panel = null;
      _refreshEscapeHook();
    }
    function _toggleRatePanel() {
      if (_panel) { _closeRatePanel(); return; }
      _closeModePanel(); _closePlPanel();
      var pn = document.createElement('div');
      pn.className = 'ovmb-ratepanel';
      for (var ri = 0; ri < _OV_MEDIA_RATE_PRESETS.length; ri++) {
        var rb = document.createElement('button');
        rb.className = 'ovmb-rbtn' + (Math.abs(_OV_MEDIA_RATE_PRESETS[ri] - _ovMediaRate) < 0.001 ? ' ovmb-on' : '');
        rb.tabIndex = -1;
        rb.setAttribute('data-no-cd', '');
        rb.textContent = _ovFmtRate(_OV_MEDIA_RATE_PRESETS[ri]);
        (function (rv) {
          rb.addEventListener('click', function () { _applyRate(rv); _closeRatePanel(); });
        })(_OV_MEDIA_RATE_PRESETS[ri]);
        pn.appendChild(rb);
      }
      var row = document.createElement('div');
      row.className = 'ovmb-rrow';
      var inp = document.createElement('input');
      inp.className = 'ovmb-rinput';
      inp.type = 'text'; inp.inputMode = 'decimal';
      inp.placeholder = window._i('shell.overlay.mspeedCustom', '自定义倍数');
      inp.setAttribute('data-no-cd', '');
      var okB = document.createElement('button');
      okB.className = 'ovmb-rok'; okB.tabIndex = -1;
      okB.setAttribute('data-no-cd', '');
      okB.textContent = window._i('shell.overlay.mspeedOk', '确认');
      okB.addEventListener('click', function () { _applyRate(parseFloat(inp.value)); _closeRatePanel(); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); _applyRate(parseFloat(inp.value)); _closeRatePanel(); }
      });
      row.appendChild(inp); row.appendChild(okB);
      pn.appendChild(row);
      rateHost.appendChild(pn);
      _panel = pn;
      _panelDocFn = function (e) { if (!rateHost.contains(e.target)) { _closeRatePanel(); } };
      document.addEventListener('pointerdown', _panelDocFn, true);
      _refreshEscapeHook();
      try { inp.focus(); } catch (_) { }
    }
    // ═══ ★ 播放模式机器（2026-09-26 q319）：按钮 = 进入点（位置与语义 = 全行业标准循环位，禁另设第二控件）═══
    //   面板全列五模式（单选即生效）；按钮外观随模式（once/listOnce = 暗色 ↔ one/listLoop/shuffle = 金色；one 带角落 1；shuffle 换图标）
    var _mpanel = null, _mpanelDocFn = null;
    function _refreshEscapeHook() {
      _ovMediaEscapeFn = function () {
        if (_plpanel) { _closePlPanel(); return true; }
        if (_mpanel) { _closeModePanel(); return true; }
        if (_panel) { _closeRatePanel(); return true; }
        return false;
      };
    }
    function syncMode() {
      loopB.dataset.loop = _ovMediaLoop;
      loopB.dataset.shuffle = _ovMediaShuffle ? '1' : '0';
      loopB.innerHTML = _ovMediaIcon(_ovMediaShuffle ? _OV_MEDIA_ICONS.shuffle : _OV_MEDIA_ICONS.repeat) +
        (_ovMediaLoop === 'one' ? '<span class="ovmb-m1">1</span>' : '');
      loopB.classList.toggle('ovmb-on', _ovMediaLoop !== 'off' || _ovMediaShuffle);
      loopB.title = window._i('shell.overlay.mmode', '播放模式（L 循环 / R 随机）') + ' · ' +
        window._i('shell.overlay.mlooplab', '循环') + '：' + _ovLoopName(_ovMediaLoop) + ' · ' +
        window._i('shell.overlay.mshuflab', '随机') + '：' + _ovShufName(_ovMediaShuffle);
      if (_mpanel) {
        var _mbs = _mpanel.querySelectorAll('.ovmb-mopt');
        for (var _mi = 0; _mi < _mbs.length; _mi++) {
          var _mvOn = (_mbs[_mi].dataset.dim === 'loop' && _mbs[_mi].dataset.val === _ovMediaLoop) ||
            (_mbs[_mi].dataset.dim === 'shuffle' && _mbs[_mi].dataset.val === (_ovMediaShuffle ? '1' : '0'));
          _mbs[_mi].classList.toggle('ovmb-on', _mvOn);
        }
      }
    }
    // 维度写入唯一收敛点（面板点击 / L·R 键共走）：写状态 → 刷新外观 → 通知外部（随机开启时重建随机袋）
    function _applyLoop(v) {
      _ovMediaLoop = v; syncMode();
      if (api && api.onModeChange) { try { api.onModeChange('loop'); } catch (_) { } }
    }
    function _applyShuffle(v) {
      _ovMediaShuffle = !!v; syncMode();
      if (api && api.onModeChange) { try { api.onModeChange('shuffle'); } catch (_) { } }
    }
    function _closeModePanel() {
      if (_mpanelDocFn) { document.removeEventListener('pointerdown', _mpanelDocFn, true); _mpanelDocFn = null; }
      if (_mpanel && _mpanel.parentNode) { _mpanel.parentNode.removeChild(_mpanel); }
      _mpanel = null;
      _refreshEscapeHook();
    }
    // 面板 = 两行并列维度（循环 / 随机）——单选即生效、面板保持打开（另一维可接着调）；外点/Esc 关闭
    function _toggleModePanel() {
      if (_mpanel) { _closeModePanel(); return; }
      _closeRatePanel(); _closePlPanel();
      var pn = document.createElement('div');
      pn.className = 'ovmb-modepanel';
      function _mRow(labKey, labFb, opts) {
        var row = document.createElement('div');
        row.className = 'ovmb-mrow';
        var lab = document.createElement('span');
        lab.className = 'ovmb-mlab';
        lab.textContent = window._i(labKey, labFb);
        row.appendChild(lab);
        for (var oi = 0; oi < opts.length; oi++) {
          (function (opt) {
            var b = document.createElement('button');
            b.className = 'ovmb-mopt';
            b.tabIndex = -1;
            b.setAttribute('data-no-cd', '');
            b.dataset.dim = opt[0]; b.dataset.val = opt[1];
            b.textContent = opt[2];
            b.addEventListener('mousedown', function (e) { e.preventDefault(); });
            b.addEventListener('click', function () {
              if (opt[0] === 'loop') { _applyLoop(opt[1]); } else { _applyShuffle(opt[1] === '1'); }
            });
            row.appendChild(b);
          })(opts[oi]);
        }
        return row;
      }
      pn.appendChild(_mRow('shell.overlay.mlooplab', '循环', [
        ['loop', 'off', window._i('shell.overlay.mOff', '关')],
        ['loop', 'all', window._i('shell.overlay.modeListLoop', '列表循环')],
        ['loop', 'one', window._i('shell.overlay.modeOne', '单曲循环')]
      ]));
      pn.appendChild(_mRow('shell.overlay.mshuflab', '随机', [
        ['shuffle', '0', window._i('shell.overlay.mOff', '关')],
        ['shuffle', '1', window._i('shell.overlay.mOn', '开')]
      ]));
      modeHost.appendChild(pn);
      _mpanel = pn;
      syncMode();
      _mpanelDocFn = function (e) { if (!modeHost.contains(e.target)) { _closeModePanel(); } };
      document.addEventListener('pointerdown', _mpanelDocFn, true);
      _refreshEscapeHook();
    }
    function _cycleLoop() {
      _applyLoop(_ovMediaLoop === 'off' ? 'all' : (_ovMediaLoop === 'all' ? 'one' : 'off'));
      _ovToast(window._i('shell.overlay.mlooplab', '循环') + '：' + _ovLoopName(_ovMediaLoop));
    }
    function _toggleShuffle() {
      _applyShuffle(!_ovMediaShuffle);
      _ovToast(window._i('shell.overlay.mshuflab', '随机') + '：' + _ovShufName(_ovMediaShuffle));
    }
    // ═══ ★ 播放列表面板（v3，2026-09-26 q319）：序号 + 文件名 + 行尾三钮（上移/下移/移除）；拖动 = 指针拖拽重排（阈值 5px，未达阈值零干扰）；
    //   当前轨 ▶ 金色高亮、自动进位/重排/移除后高亮跟随并滚入视野；点击任意行切轨（拖动余波点击自动抑制）═══
    var _plpanel = null, _plpanelDocFn = null;
    var _plListEl = null, _plHeadCntEl = null;
    var _plDrag = { from: -1, on: false, y0: 0, j: -1, after: false, el: null };
    var _plDragEndAt = 0;   // 拖动收尾余波点击抑制（<400ms 内行点击忽略）
    function _closePlPanel() {
      if (_plpanelDocFn) { document.removeEventListener('pointerdown', _plpanelDocFn, true); _plpanelDocFn = null; }
      if (_plpanel && _plpanel.parentNode) { _plpanel.parentNode.removeChild(_plpanel); }
      _plpanel = null;
      try { _plDragClear(); } catch (_) { }
      _plListEl = null; _plHeadCntEl = null;
      _refreshEscapeHook();
    }
    function _syncPl() {
      if (!_plpanel || !api || !api.list) { return; }
      var rows = _plpanel.querySelectorAll('.ovmb-prowwrap');
      var cur = api.idx || 0;
      for (var pi = 0; pi < rows.length; pi++) {
        var isCur = (pi === cur);
        rows[pi].classList.toggle('ovmb-cur', isCur);
        var mk = rows[pi].querySelector('.ovmb-pmark');
        if (mk) { mk.textContent = isCur ? '\u25B6' : ''; }
        if (isCur) {   // 仅滚动列表自身（scrollIntoView 会连祖先容器一起滚——列表外溢时可能挪动面板，禁）
          try {
            var _le = _plpanel.querySelector('.ovmb-pllist');
            if (_le) {
              var _lr = _le.getBoundingClientRect(), _rr = rows[pi].getBoundingClientRect();
              if (_rr.top < _lr.top) { _le.scrollTop -= (_lr.top - _rr.top); }
              else if (_rr.bottom > _lr.bottom) { _le.scrollTop += (_rr.bottom - _lr.bottom); }
            }
          } catch (_) { }
        }
      }
    }
    // 行操作三钮（上移/下移/移除）——不拖也能整理列表；首/末行对应方向钮禁用（禁 button 嵌套：行容器 = div，名称区 = 内嵌按钮）
    function _plOpBtn(op, glyph, title, idx) {
      var b = document.createElement('button');
      b.className = 'ovmb-pop';
      b.tabIndex = -1;
      b.setAttribute('data-no-cd', '');
      b.textContent = glyph;
      b.title = title;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) { e.stopPropagation(); _plRowOp(op, idx); });
      return b;
    }
    // 行重建（唯一渲染入口：开面板/上移/下移/移除/拖动提交全走它）
    function _fillPlRows() {
      if (!_plpanel || !_plListEl) { return; }
      var _L = (api && api.list) || [];
      var _st = _plListEl.scrollTop;
      _plListEl.innerHTML = '';
      if (_plHeadCntEl) { _plHeadCntEl.textContent = String(_L.length); }
      for (var pi2 = 0; pi2 < _L.length; pi2++) {
        (function (idx, item) {
          var wrap = document.createElement('div');
          wrap.className = 'ovmb-prowwrap';
          wrap.dataset.i = String(idx);
          var row = document.createElement('button');
          row.className = 'ovmb-prow';
          row.tabIndex = -1;
          row.setAttribute('data-no-cd', '');
          row.addEventListener('mousedown', function (e) { e.preventDefault(); });
          var mk = document.createElement('span'); mk.className = 'ovmb-pmark';
          var nm = document.createElement('span'); nm.className = 'ovmb-pidx'; nm.textContent = String(idx + 1);
          var tx = document.createElement('span'); tx.className = 'ovmb-pname';
          tx.textContent = (item && item.name) || String((item && item.localPath) || '').split(/[\\/]/).pop() || '';
          row.appendChild(mk); row.appendChild(nm); row.appendChild(tx);
          wrap.appendChild(row);
          wrap.title = tx.textContent;
          var ops = document.createElement('span'); ops.className = 'ovmb-pops';
          var upB = _plOpBtn('up', '\u2191', window._i('shell.overlay.mplUp', '上移'), idx);
          var dnB = _plOpBtn('down', '\u2193', window._i('shell.overlay.mplDown', '下移'), idx);
          var dlB = _plOpBtn('del', '\u2212', window._i('shell.overlay.mplDel', '从播放列表移除'), idx);
          if (idx === 0) { upB.disabled = true; }
          if (idx === _L.length - 1) { dnB.disabled = true; }
          ops.appendChild(upB); ops.appendChild(dnB); ops.appendChild(dlB);
          wrap.appendChild(ops);
          wrap.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('.ovmb-pop')) { return; }
            if (Date.now() - _plDragEndAt < 400) { return; }   // 拖动收尾的余波点击 → 忽略（防误切轨）
            if (api && api.jump) { api.jump(idx); }
          });
          _plListEl.appendChild(wrap);
        })(pi2, _L[pi2]);
      }
      _plListEl.scrollTop = _st;
    }
    // 行操作执行：外部列表变更（api.move/api.remove）→ 面板重建 + 计数/高亮对齐；列表缩到单轨 → 藏列表系控件（同单文件态）
    function _plRowOp(op, idx) {
      if (!api || !api.list) { return; }
      if (op === 'up' && api.move) { api.move(idx, idx - 1); }
      else if (op === 'down' && api.move) { api.move(idx, idx + 1); }
      else if (op === 'del' && api.remove) { api.remove(idx); }
      var many = !!(api.n > 1);
      if (prevB) { prevB.style.display = many ? '' : 'none'; }
      if (nextB) { nextB.style.display = many ? '' : 'none'; }
      if (posT) { posT.style.display = many ? '' : 'none'; }
      if (plHost) { plHost.style.display = many ? '' : 'none'; }
      if (!many) { _closePlPanel(); return; }
      if (_plpanel) { _fillPlRows(); setTrack(api.idx || 0); }
    }
    // ── 指针拖动重排（阈值 5px：未达阈值 = 纯点击，零干扰；拖动中只换顺序不动播放）──
    function _plDragCalc(cy) {
      if (!_plListEl) { return; }
      var ws = _plListEl.querySelectorAll('.ovmb-prowwrap');
      if (!ws.length) { return; }
      var j = -1, after = false;
      for (var di = 0; di < ws.length; di++) {
        var r = ws[di].getBoundingClientRect();
        if (cy >= r.top && cy <= r.bottom) { j = di; after = (cy > r.top + r.height / 2); break; }
      }
      if (j === -1) {
        var r0 = ws[0].getBoundingClientRect(), rl = ws[ws.length - 1].getBoundingClientRect();
        if (cy < r0.top) { j = 0; after = false; } else { j = ws.length - 1; after = true; }
      }
      _plDrag.j = j; _plDrag.after = after;
      for (var ci = 0; ci < ws.length; ci++) { ws[ci].classList.remove('ovmb-dtop', 'ovmb-dbot'); }
      if (ws[j]) { ws[j].classList.add(after ? 'ovmb-dbot' : 'ovmb-dtop'); }
      var lr = _plListEl.getBoundingClientRect();
      if (cy < lr.top + 18) { _plListEl.scrollTop -= 6; }
      else if (cy > lr.bottom - 18) { _plListEl.scrollTop += 6; }
    }
    function _plDragClear() {
      if (_plListEl) {
        var ws = _plListEl.querySelectorAll('.ovmb-prowwrap');
        for (var ci = 0; ci < ws.length; ci++) { ws[ci].classList.remove('ovmb-dragging', 'ovmb-dtop', 'ovmb-dbot'); }
      }
      _plDrag.from = -1; _plDrag.on = false; _plDrag.j = -1; _plDrag.el = null;
    }
    function _plDragEnd(e) {
      if (_plDrag.from < 0) { return; }
      var from = _plDrag.from, on = _plDrag.on, j = _plDrag.j, after = _plDrag.after;
      try { if (on && _plListEl) { _plListEl.releasePointerCapture(e.pointerId); } } catch (_) { }
      _plDragClear();
      if (!on || j < 0) { return; }             // 未达阈值 = 普通点击（click 流程照常）
      _plDragEndAt = Date.now();
      if (!api || !api.move) { return; }
      var ins0 = after ? j + 1 : j;
      var to = ins0 > from ? ins0 - 1 : ins0;
      if (to === from) { return; }
      api.move(from, to);
      if (_plpanel) { _fillPlRows(); setTrack(api.idx || 0); }
    }
    function _togglePlPanel() {
      if (!plHost) { return; }
      if (_plpanel) { _closePlPanel(); return; }
      _closeRatePanel(); _closeModePanel();
      var pn = document.createElement('div');
      pn.className = 'ovmb-plpanel';
      var head = document.createElement('div');
      head.className = 'ovmb-plhead';
      var ht = document.createElement('span');
      ht.textContent = window._i('shell.overlay.mplist', '播放列表');
      var hc = document.createElement('span');
      hc.className = 'ovmb-plcnt';
      hc.textContent = String(api ? api.n : 0);
      head.appendChild(ht); head.appendChild(hc);
      pn.appendChild(head);
      var listEl = document.createElement('div');
      listEl.className = 'ovmb-pllist';
      _plListEl = listEl; _plHeadCntEl = hc;
      // 指针拖动重排：pointerdown 记源 → 越过阈值（5px）才进入拖动（未达阈值 = 纯点击零干扰；行尾按钮上不启动）
      listEl.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) { return; }
        if (e.target && e.target.closest && e.target.closest('.ovmb-pop')) { return; }
        var wrap = (e.target && e.target.closest) ? e.target.closest('.ovmb-prowwrap') : null;
        if (!wrap) { return; }
        _plDrag.from = +wrap.dataset.i; _plDrag.on = false; _plDrag.y0 = e.clientY; _plDrag.el = wrap;
      });
      listEl.addEventListener('pointermove', function (e) {
        if (_plDrag.from < 0) { return; }
        if (!_plDrag.on) {
          if (Math.abs(e.clientY - _plDrag.y0) < 5) { return; }
          _plDrag.on = true;
          try { listEl.setPointerCapture(e.pointerId); } catch (_) { }
          if (_plDrag.el) { _plDrag.el.classList.add('ovmb-dragging'); }
        }
        e.preventDefault();
        _plDragCalc(e.clientY);
      });
      listEl.addEventListener('pointerup', _plDragEnd);
      listEl.addEventListener('pointercancel', function () { _plDragClear(); });
      pn.appendChild(listEl);
      plHost.appendChild(pn);
      _plpanel = pn;
      _fillPlRows();
      _syncPl();
      _plpanelDocFn = function (e) { if (!plHost.contains(e.target)) { _closePlPanel(); } };
      document.addEventListener('pointerdown', _plpanelDocFn, true);
      _refreshEscapeHook();
    }

    // ═══ ★ A-B 循环（2026-09-26 q319）：A/B 点均存在且在播 → currentTime ≥ B 跳回 A ═══
    //   驱动 = rAF 高频（≤1 帧过冲）+ timeupdate 兜底（后台标签 rAF 节流）；拖动进度中不干预（_seeking）；
    //   时间点无跨文件意义 → 状态 per-file（打开即清零，不作会话粘性）。
    var _abA = null, _abB = null, _abRaf = 0;
    function _abRender() {
      var d = mEl.duration, ok = isFinite(d) && d > 0;
      var okA = _abA !== null && ok, okB = _abB !== null && ok;
      var aPct = okA ? Math.max(0, Math.min(100, (_abA / d) * 100)) : 0;
      var bPct = okB ? Math.max(0, Math.min(100, (_abB / d) * 100)) : 0;
      abMarkA.style.display = okA ? 'block' : 'none';
      abMarkB.style.display = okB ? 'block' : 'none';
      if (okA) { abMarkA.style.left = aPct + '%'; }
      if (okB) { abMarkB.style.left = bPct + '%'; }
      abZone.style.display = (okA && okB) ? 'block' : 'none';
      if (okA && okB) { abZone.style.left = aPct + '%'; abZone.style.width = Math.max(0, bPct - aPct) + '%'; }
      abB.classList.toggle('ovmb-arm', _abA !== null && _abB === null);
      abB.classList.toggle('ovmb-on', _abA !== null && _abB !== null);
      abB.title = _abA === null
        ? window._i('shell.overlay.mab', 'A-B 循环（快捷键 A）')
        : (_abB === null
          ? window._i('shell.overlay.mabA', '标 B 点（A: {t}，快捷键 A）', { t: _ovFmtT(_abA) })
          : window._i('shell.overlay.mabAB', '清除 A-B 循环（{a} → {b}，快捷键 A）', { a: _ovFmtT(_abA), b: _ovFmtT(_abB) }));
    }
    function _abCheck() {
      if (_abA === null || _abB === null || _seeking) { return; }
      if (!mEl.paused && !mEl.ended && mEl.currentTime >= _abB - 0.012) {
        try { mEl.currentTime = _abA; } catch (_) { }
      }
    }
    function _abTick() { _abRaf = 0; _abCheck(); _abStart(); }
    function _abStart() {
      if (!_abRaf && _abA !== null && _abB !== null && !mEl.paused && !mEl.ended) {
        _abRaf = requestAnimationFrame(_abTick);
      }
    }
    function _abStop() { if (_abRaf) { cancelAnimationFrame(_abRaf); _abRaf = 0; } }
    function _abCycle() {
      try {
        if (_abA === null) {
          _abA = mEl.currentTime;
          _abRender();
          _ovToast(window._i('shell.overlay.mabSetA', '已标记 A 点：{t}', { t: _ovFmtT(_abA) }));
          return;
        }
        if (_abB === null) {
          var a = _abA, b = mEl.currentTime;
          if (b < a) { var sw = a; a = b; b = sw; }                      // 反向标记 → 交换（区间恒 A<B）
          var _dur = (isFinite(mEl.duration) && mEl.duration > 0) ? mEl.duration : null;
          if (b - a < 0.15) { b = a + 0.15; }                            // 过近 → 撑开最小区间 0.15s
          if (_dur && b > _dur) { b = _dur; if (b - a < 0.15) { a = Math.max(0, b - 0.15); } }
          _abA = a; _abB = b;
          try { mEl.currentTime = a; } catch (_) { }                     // 标记即起循：跳回 A 点
          _abRender(); _abStart();
          _ovToast(window._i('shell.overlay.mabSetB', 'A-B 循环已开启：{a} → {b}', { a: _ovFmtT(a), b: _ovFmtT(b) }));
          return;
        }
        _abA = null; _abB = null;
        _abStop(); _abRender();
        _ovToast(window._i('shell.overlay.mabClear', '已清除 A-B 循环'));
      } catch (_) { }
    }
    abB.addEventListener('click', _abCycle);

    // 播放状态事件
    mEl.addEventListener('play', syncPlay);
    mEl.addEventListener('pause', syncPlay);
    mEl.addEventListener('ended', syncPlay);
    mEl.addEventListener('timeupdate', syncProg);
    mEl.addEventListener('timeupdate', _abCheck);
    mEl.addEventListener('loadedmetadata', syncProg);
    mEl.addEventListener('loadedmetadata', _abRender);
    mEl.addEventListener('durationchange', syncProg);
    mEl.addEventListener('durationchange', _abRender);
    mEl.addEventListener('volumechange', syncVol);
    mEl.addEventListener('play', _abStart);
    mEl.addEventListener('pause', _abStop);
    mEl.addEventListener('ended', _abStop);
    // ★ 播放模式引擎（2026-09-26 q319）：ended → A-B 优先（跳回 A 续循环，显式意图更强）；否则交外部 onEnded（列表/单文件退化裁决）
    mEl.addEventListener('ended', function () {
      if (_abA !== null) {
        try { mEl.currentTime = _abA; } catch (_) { }
        var _ap = mEl.play(); if (_ap && _ap.catch) { _ap.catch(function () { }); }
        return;
      }
      if (api && api.onEnded) { try { api.onEnded(); } catch (_) { } }
    });

    // 按钮
    playB.addEventListener('click', _togglePlay);
    volB.addEventListener('click', function () {
      mEl.muted = !mEl.muted;
      if (!mEl.muted && mEl.volume === 0) { mEl.volume = 1; }
    });
    volS.addEventListener('input', function () {
      var v = parseFloat(volS.value); if (!isFinite(v)) { v = 0; }
      v = Math.max(0, Math.min(1, v));
      mEl.volume = v;
      mEl.muted = v === 0;
    });
    rateB.addEventListener('click', _toggleRatePanel);
    loopB.addEventListener('click', _toggleModePanel);
    if (isVid) {
      // 点击画面 = 播放/暂停（原生控件同款手势）
      mEl.addEventListener('click', function () { _togglePlay(); });
    }

    // 拖动进度（指针捕获：拖出条外也跟手）
    var _seeking = false;
    function _seekAt(clientX) {
      var r = seekTrack.getBoundingClientRect();
      if (!r.width) { return; }
      var ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      seekFill.style.width = (ratio * 100) + '%';
      seekDot.style.left = (ratio * 100) + '%';
      var d = mEl.duration;
      if (isFinite(d) && d > 0) {
        curT.textContent = _ovFmtT(ratio * d);
        try { mEl.currentTime = ratio * d; } catch (_) { }
      }
    }
    seek.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) { return; }
      _seeking = true;
      seek.classList.add('ovmb-drag');
      try { seek.setPointerCapture(e.pointerId); } catch (_) { }
      _seekAt(e.clientX);
      e.preventDefault();
    });
    seek.addEventListener('pointermove', function (e) { if (_seeking) { _seekAt(e.clientX); } });
    function _seekEnd(e) {
      if (!_seeking) { return; }
      _seeking = false;
      seek.classList.remove('ovmb-drag');
      try { seek.releasePointerCapture(e.pointerId); } catch (_) { }
    }
    seek.addEventListener('pointerup', _seekEnd);
    seek.addEventListener('pointercancel', _seekEnd);

    // 画中画 + 全屏（仅视频）★ 2026-09-26 v2：失败可见（qoast 携原因，绝不静默吞）
    function _ovFsFail(reason) {
      try { _ovToast(window._i('shell.overlay.mfsFail', '全屏失败') + (reason ? '（' + reason + '）' : ''), 'error'); } catch (_) { }
    }
    function _toggleFs() {
      try {
        if (document.fullscreenElement) {
          var _ex = document.exitFullscreen();
          if (_ex && _ex.catch) { _ex.catch(function () { }); }
          return;
        }
        if (!wrapEl || !wrapEl.requestFullscreen) { _ovFsFail('unsupported'); return; }
        var r = wrapEl.requestFullscreen();
        if (r && r.catch) { r.catch(function (e) { _ovFsFail(e && (e.name || e.message)); }); }
      } catch (e) { _ovFsFail(e && (e.name || e.message)); }
    }
    var _onFsChange = function () {
      if (fsB) { fsB.innerHTML = _ovMediaIcon(document.fullscreenElement === wrapEl ? _OV_MEDIA_ICONS.fsExit : _OV_MEDIA_ICONS.fs); }
    };
    // ★ 逐帧步进（2026-09-26 v2）：暂停并前进/后退一帧；帧率 = rVFC 实测（EMA），未测到回落 30fps
    function _stepFrame(dir) {
      try {
        if (!mEl.paused) { mEl.pause(); }
        var fps = (_ovMediaFps > 1 && _ovMediaFps < 241) ? _ovMediaFps : 30;
        var d = (isFinite(mEl.duration) && mEl.duration > 0) ? mEl.duration : 1e9;
        var nt = mEl.currentTime + dir * (1 / fps);
        mEl.currentTime = Math.max(0, Math.min(nt, d - 0.0005));
      } catch (_) { }
    }

    // ═══ ★ 单帧截图（2026-09-26 q319）：当前帧 → 全分辨率 PNG（canvas 原尺寸）═══
    //   落盘 = bridge.fs.writeBase64（主进程原子写）；目标 = 源文件同目录（重名自动 _1/_2…绝不覆盖——Roam 风格末尾下划线，2026-09-26 定案）；
    //   转码回放场景基准恒为原始文件（_ovShotBase），不污染 Cache 产物目录；完成 qoast 带「📂 Roam 定位」（快捷键 S）。
    function _ovShotTc(sec) {
      function z(n, w) { n = String(n); while (n.length < w) { n = '0' + n; } return n; }
      var ms = Math.floor((sec % 1) * 1000);
      return z(Math.floor(sec / 3600), 2) + '-' + z(Math.floor(sec / 60) % 60, 2) + '-' + z(Math.floor(sec) % 60, 2) + '.' + z(ms, 3);
    }
    function _ovShotJoin(dir, name) {
      var sep = (dir.indexOf('\\') >= 0 || dir.indexOf('/') < 0) ? '\\' : '/';
      return dir + (/[\\/]$/.test(dir) ? '' : sep) + name;
    }
    function _ovShotReveal(p) {
      try { if (typeof window.__qqq_roamRevealPath === 'function') { window.__qqq_roamRevealPath(p); return; } } catch (_) { }
      try { if (bridge && bridge.shell && bridge.shell.showItemInFolder) { bridge.shell.showItemInFolder(p); } } catch (_) { }
    }
    function _ovShot() {
      if (!isVid) { return; }
      function _fail(reason) {
        _ovToast(window._i('shell.overlay.mshotFail', '截图失败') + (reason ? '（' + reason + '）' : ''), 'error');
      }
      var b64 = '';
      try {
        if (!mEl.videoWidth || !mEl.videoHeight) { _fail('not-ready'); return; }
        var cv = document.createElement('canvas');
        cv.width = mEl.videoWidth; cv.height = mEl.videoHeight;
        cv.getContext('2d').drawImage(mEl, 0, 0, cv.width, cv.height);
        var durl = cv.toDataURL('image/png');
        var comma = durl.indexOf(',');
        if (comma < 0 || !durl.slice(comma + 1)) { _fail('encode'); return; }
        b64 = durl.slice(comma + 1);
      } catch (err) { _fail((err && err.name) || 'capture'); return; }
      var srcPath = String(_ovShotBase || _ovLocalPath || _localPathFromSrc(mEl.src) || '');
      var dir = '', base = '';
      var mm = /^(.*)[\\/]([^\\/]*)$/.exec(srcPath);
      if (mm && mm[1] && mm[2]) { dir = mm[1]; base = mm[2].replace(/\.[^.]*$/, ''); }
      if (!dir) {
        try { if (window.qqqideDownload && window.qqqideDownload.getLastDir) { dir = String(window.qqqideDownload.getLastDir() || ''); } } catch (_) { }
        base = base || 'screenshot';
      }
      if (!dir || !bridge || !bridge.fs || !bridge.fs.writeBase64) { _fail('no-path'); return; }
      var tc = _ovShotTc(mEl.currentTime || 0);
      function _try(idx) {
        var fname = base + '_' + tc + (idx ? '_' + idx : '') + '.png';
        var target = _ovShotJoin(dir, fname);
        var chk = (bridge.fs.exists) ? bridge.fs.exists(target) : Promise.resolve(false);
        chk.then(function (ex) {
          if (ex) { if (idx < 99) { _try(idx + 1); } else { _fail('collision'); } return; }
          return bridge.fs.writeBase64(target, b64).then(function (ok) {
            if (!ok) { _fail('write'); return; }
            var msg = window._i('shell.overlay.mshotSaved', '已保存截图：{name}', { name: fname });
            try {
              if (window.qqqideQoast) {
                window.qqqideQoast.show(msg, {
                  type: 'success', duration: 12000,
                  action: { label: window._i('shell.dl.roamLocate', '📂 Roam 定位'), onClick: function () { _ovShotReveal(target); } },
                });
                return;
              }
            } catch (_) { }
            _ovToast(msg, 'success');
          });
        }).catch(function () { _fail('write'); });
      }
      _try(0);
    }
    if (isVid) {
      if (document.pictureInPictureEnabled) {
        pipB = _mBtn(_OV_MEDIA_ICONS.pip, window._i('shell.overlay.mpip', '画中画'));
        pipB.addEventListener('click', function () {
          try {
            if (document.pictureInPictureElement) { document.exitPictureInPicture(); }
            else { var pv = mEl.requestPictureInPicture(); if (pv && pv.catch) { pv.catch(function () { }); } }
          } catch (_) { }
        });
      }
      fsB = _mBtn(_OV_MEDIA_ICONS.fs, window._i('shell.overlay.mfs', '全屏'));
      fsB.addEventListener('click', _toggleFs);
      document.addEventListener('fullscreenchange', _onFsChange);
      // ★ 逐帧按钮 + 帧率实测（rVFC：mediaTime 相邻差 → EMA；无 API 的旧内核自动回落 30fps）
      stepB = _mBtn(_OV_MEDIA_ICONS.step, window._i('shell.overlay.mstep', '逐帧步进（快捷键 . 前进 / , 后退）'));
      stepB.addEventListener('click', function () { _stepFrame(1); });
      // ★ 单帧截图按钮（2026-09-26 q319）：当前帧 → PNG 落盘源文件旁（快捷键 S）
      shotB = _mBtn(_OV_MEDIA_ICONS.shot, window._i('shell.overlay.mshot', '单帧截图（快捷键 S）'));
      shotB.addEventListener('click', function () { _ovShot(); });
      _ovMediaFps = 0;
      var _vfcLast = 0, _vfcId = 0, _vfcFn = null;
      if (mEl.requestVideoFrameCallback) {
        _vfcFn = function (_now, meta) {
          var mt = meta && meta.mediaTime;
          if (_vfcLast && mt > _vfcLast) {
            var dt = mt - _vfcLast;
            if (dt > 0.002 && dt < 0.2) {
              var fp = 1 / dt;
              if (fp > 5 && fp < 241) { _ovMediaFps = _ovMediaFps ? (_ovMediaFps * 0.6 + fp * 0.4) : fp; }
            }
          }
          _vfcLast = mt;
          try { _vfcId = mEl.requestVideoFrameCallback(_vfcFn); } catch (_) { }
        };
        try { _vfcId = mEl.requestVideoFrameCallback(_vfcFn); } catch (_) { }
      }
    }

    if (prevB) { bar.appendChild(prevB); }
    bar.appendChild(playB);
    if (nextB) { bar.appendChild(nextB); }
    if (stepB) { bar.appendChild(stepB); }
    bar.appendChild(curT);
    bar.appendChild(seek);
    bar.appendChild(durT);
    if (posT) { bar.appendChild(posT); }
    bar.appendChild(volB);
    bar.appendChild(volS);
    bar.appendChild(rateHost);
    bar.appendChild(modeHost);
    if (plHost) { bar.appendChild(plHost); }
    bar.appendChild(abB);
    if (shotB) { bar.appendChild(shotB); }
    if (pipB) { bar.appendChild(pipB); }
    if (fsB) { bar.appendChild(fsB); }

    // 键盘（空格/←→/↑↓/M/L/F——经 _ovMediaKeysFn 由全局 keydown 派发）
    function keys(e) {
      // ★ 输入框/可编辑目标内让路（倍速自定义输入——空格/数字/字母不得触发播放控制，2026-09-26 v2）
      var _tg = e.target;
      if (_tg && (_tg.tagName === 'INPUT' || _tg.tagName === 'TEXTAREA' || _tg.isContentEditable)) { return; }
      if (e.ctrlKey || e.metaKey || e.altKey) { return; }
      var k = e.key;
      if (k === ' ' || k === 'Spacebar') {
        e.preventDefault(); _togglePlay();
      } else if (k === 'ArrowLeft') {
        e.preventDefault();
        mEl.currentTime = Math.max(0, mEl.currentTime - 5);
      } else if (k === 'ArrowRight') {
        e.preventDefault();
        var dd = isFinite(mEl.duration) && mEl.duration > 0 ? mEl.duration : 1e9;
        mEl.currentTime = Math.min(dd, mEl.currentTime + 5);
      } else if (k === 'ArrowUp') {
        e.preventDefault();
        mEl.muted = false;
        mEl.volume = Math.min(1, Math.round((mEl.volume + 0.05) * 100) / 100);
      } else if (k === 'ArrowDown') {
        e.preventDefault();
        mEl.volume = Math.max(0, Math.round((mEl.volume - 0.05) * 100) / 100);
      } else if (k === 'm' || k === 'M') {
        mEl.muted = !mEl.muted;
      } else if (k === 'l' || k === 'L') {
        _cycleLoop();
      } else if (k === 'r' || k === 'R') {
        _toggleShuffle();
      } else if (k === 'a' || k === 'A') {
        _abCycle();
      } else if (isVid && (k === 's' || k === 'S')) {
        _ovShot();
      } else if ((k === 'f' || k === 'F') && isVid) {
        _toggleFs();
      } else if (isVid && (k === '.' || k === '>')) {
        e.preventDefault(); _stepFrame(1);
      } else if (isVid && (k === ',' || k === '<')) {
        e.preventDefault(); _stepFrame(-1);
      }
    }

    function cleanup() {
      try { _abStop(); } catch (_) { }
      try { _closeRatePanel(); } catch (_) { }
      try { _closeModePanel(); } catch (_) { }
      try { _closePlPanel(); } catch (_) { }
      try { if (_vfcId) { mEl.cancelVideoFrameCallback(_vfcId); _vfcId = 0; } } catch (_) { }
      try { if (isVid) { document.removeEventListener('fullscreenchange', _onFsChange); } } catch (_) { }
      try { if (wrapEl && document.fullscreenElement === wrapEl) { document.exitFullscreen(); } } catch (_) { }
    }

    // ★ 播放列表协作者接口（2026-09-26 q319）：外部切轨后刷新位置计数；A-B 状态切轨即清零（时间点无跨文件意义）
    function setTrack(n) {
      if (api) { api.idx = n; }
      if (posT) { posT.textContent = (n + 1) + '/' + (api ? api.n : 1); }
      _syncPl();
    }
    function resetAB() { _abA = null; _abB = null; _abStop(); _abRender(); }

    // 初始同步
    syncPlay(); syncVol(); syncProg(); syncRate(); syncMode(); _abRender(); _refreshEscapeHook();

    return { bar: bar, cleanup: cleanup, keys: keys, setTrack: setTrack, resetAB: resetAB };
  }

  // Listen for messages from AI iframe
  window.addEventListener('message', function (e) {
    // ★ roam iframe 命令回执（2026-09-08）：命令已消费即停发。旧实现零确认——首次导航成功后
    //   仍每 300ms 重发满 25 次（7.5s），期间用户任何手动导航都被下一条重发拉回目标目录 = 硬控。
    //   独立 type 分支必须先于 qqqide-overlay 过滤（ack 消息走 roam 自身 type）
    if (e.data && e.data.type === 'qqq-roam-cmd-ack') {
      if (_roamCmdTimer && e.data.reqId && String(e.data.reqId) === String(_roamCmdToken)) {
        clearInterval(_roamCmdTimer);
        _roamCmdTimer = null;
      }
      return;
    }
    if (!e.data || e.data.type !== 'qqqide-overlay') return;
    if (e.data.action === 'close') { close(); return; }

    // 跨窗口协调：广播自己的 overlay ID，其他窗口收到后自动关闭
    try {
      if (bridge && bridge.sync) {
        bridge.sync.broadcast('overlay-open', { id: _overlayId });
      }
    } catch (_) { }

    if (e.data.action === 'open-image') {
      // 强制清理上一轮残留状态（含 close 函数恢复）
      close = _baseClose;
      _ovLocalPath = e.data.localPath || null;
      _stopRepeat();
      _stopMedia();
      _ovTxAbort();
      overlay.style.display = 'none';
      contentEl.innerHTML = '';
      contentEl.style.overflow = '';
      zoomScale = 1.0;
      _dragX = 0; _dragY = 0;
      // ★ 先让 overlay 可见以取得正确容器尺寸，再加载图片（避免缓存图 onload 同步触发时容器尺寸为 0）
      overlay.style.display = 'block';
      contentEl.style.overflow = 'hidden';
      // ★ 直转码组（2026-09-21）：psd/tif/tiff = Chromium 永不解码 —— 不白试原生 img，直接进 ffmpeg 转码
      //   （与媒体组 _OV_TX_FIRST_EXTS 同语义；其余图片失败兜底仍在 img.onerror 保留）
      var _imgTxEarlyExt = _ovTxExt(_ovLocalPath || '');
      if (!e.data._tx && _ovLocalPath && (_imgTxEarlyExt === '.psd' || _imgTxEarlyExt === '.tif' || _imgTxEarlyExt === '.tiff')) {
        _ovTxRun(_ovLocalPath, 'image', function (newPath) {
          window.postMessage({ type: 'qqqide-overlay', action: 'open-image', src: 'file:///' + newPath, localPath: newPath, _tx: 1 }, '*');
        }, function () {
          _ovToast(window._i('shell.overlay.loadFailed', '图片加载失败，无法预览'), 'error');
          try { close(); } catch (_) { }
        });
        dpad.style.display = 'block';
        copyBtn.style.display = 'none';
        memBtn.style.display = '';
        fileBtn.style.display = '';
        pathBtn.style.display = '';
        zoomOutBtn.style.display = '';
        zoomInBtn.style.display = '';
        return;
      }
      // ── 边界适配：尝试 2x 放大，但绝不超出内容区可用空间 ──
      var img = new Image();
      img.onload = function () {
        var nw = img.naturalWidth, nh = img.naturalHeight;
        // 内容区可用空间：overlay = 悬浮城（菜单+中区含中AI+状态栏，不含左右翼），扣除工具栏 64px + 内边距 32px×2
        var availW = Math.max(200, (overlay.clientWidth || window.innerWidth) - 64);
        var availH = Math.max(150, (overlay.clientHeight || window.innerHeight) - 64 - 64);
        // 理想：2x 放大；上限：不超过可用空间
        var targetW = Math.min(nw * 2, availW);
        var targetH = Math.min(nh * 2, availH);
        // 统一缩放比：取宽高两个方向中更紧的那个，且不超 2.0（2x 封顶）
        var scale = Math.min(targetW / nw, targetH / nh, 2.0);
        // 若原图已大于可用空间，scale < 1.0 → 缩小适配
        var finalW = Math.round(nw * scale), finalH = Math.round(nh * scale);
        img.style.cssText =
          'width:' + finalW + 'px; height:' + finalH + 'px; ' +
          'object-fit:contain; box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
          'display:block; user-select:none; will-change:transform;';
        contentEl.appendChild(img);
        contentEl.style.overflow = 'visible';
        // ── 拖拽平移 ──
        var dragging = false, sx = 0, sy = 0, _raf = 0, _pending = false;
        function onMD(ev) {
          if (ev.button !== 0) return;
          dragging = true; sx = ev.clientX; sy = ev.clientY;
          img.style.transition = 'none';
          ev.preventDefault();
        }
        function onMM(ev) {
          if (!dragging) return;
          var s = zoomScale || 1;
          _dragX += (ev.clientX - sx) / s; _dragY += (ev.clientY - sy) / s;
          sx = ev.clientX; sy = ev.clientY;
          if (!_pending) {
            _pending = true;
            _raf = requestAnimationFrame(function () {
              _pending = false;
              img.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
            });
          }
        }
        function onMU() {
          dragging = false;
          if (_raf) { cancelAnimationFrame(_raf); _raf = 0; _pending = false; }
          img.style.transition = '';
        }
        img.addEventListener('mousedown', onMD);
        window.addEventListener('mousemove', onMM);
        window.addEventListener('mouseup', onMU);
        // ── 关闭时清理 ──
        var _origClose = close;
        close = function () {
          window.removeEventListener('mousemove', onMM);
          window.removeEventListener('mouseup', onMU);
          contentEl.style.overflow = '';
          close = _origClose;
          _origClose();
        };
      };
      // ★ 加载失败兜底（2026-09-21）：psd/tiff 等 Chromium 不解的图片 → ffmpeg 抽帧 png 再显；再无救才提示关闭
      img.onerror = function () {
        var _ipath = _ovLocalPath || _localPathFromSrc(e.data.src);
        var _iext = _ovTxExt(_ipath || '');
        if (!e.data._tx && _ipath && (_iext === '.psd' || _iext === '.tif' || _iext === '.tiff')) {
          _ovTxRun(_ipath, 'image', function (newPath) {
            // 产物 → 以同一管线重开（_tx:1 防二次转码）
            window.postMessage({ type: 'qqqide-overlay', action: 'open-image', src: 'file:///' + newPath, localPath: newPath, _tx: 1 }, '*');
          }, function () {
            _ovToast(window._i('shell.overlay.loadFailed', '图片加载失败，无法预览'), 'error');
            try { close(); } catch (_) { }
          });
          return;
        }
        _ovToast(window._i('shell.overlay.loadFailed', '图片加载失败，无法预览'), 'error');
        try { close(); } catch (_) { }
      };
      img.src = e.data.src;
      dpad.style.display = 'block';
      // ★ 图片模式：三按钮（内存/文件/路径），复制按钮隐藏
      copyBtn.style.display = 'none';
      memBtn.style.display = '';
      fileBtn.style.display = '';
      pathBtn.style.display = '';
      zoomOutBtn.style.display = '';
      zoomInBtn.style.display = '';
    }

    if (e.data.action === 'open-table') {
      _ovLocalPath = null;
      try {
        // 强制清理上一轮残留状态（含 close 函数恢复）
        close = _baseClose;
        _stopRepeat();
        _stopMedia();
        _ovTxAbort();
        overlay.style.display = 'none';
        contentEl.innerHTML = '';
        contentEl.style.overflow = 'hidden';
        zoomScale = 1.0;
        _dragX = 0; _dragY = 0;

        // ★ 先让 overlay 布局生效再测可用空间：display:none 时 clientWidth=0，
        //   旧代码回退 window.innerWidth = 全窗口宽（含左右翼）→ clipBox 按错误宽度
        //   创建 → fitZoom 偏大 → 自动放大两级后超出真实悬浮城边界（小分辨率+翼开必现）
        //   overlay 挂 #qqq-main → clientWidth 即悬浮城宽（菜单+中区含中AI+状态栏，不含左右翼）
        overlay.style.visibility = 'hidden';
        overlay.style.display = 'block';
        var _availW = Math.max(200, overlay.clientWidth - 64);
        var _availH = Math.max(150, overlay.clientHeight - 64 - 64);

        var clipBox = document.createElement('div');
        clipBox.style.cssText =
          'width:' + _availW + 'px; height:' + _availH + 'px; overflow:hidden; ' +
          'display:flex; align-items:center; justify-content:center;';

        var wrapper = document.createElement('div');
        wrapper.className = 'qqq-overlay-table-wrapper';
        var _overlayDark = window.qqqideTheme && window.qqqideTheme.isDark();
        wrapper.style.cssText =
          'background:' + (_overlayDark ? '#2a2a2a' : '#ede4cf') + '; color:var(--text-primary,#dcd8d0); ' +
          'border-radius:8px; padding:20px; user-select:text; ' +
          'box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
          'transform-origin:center center; ' +
          'transition:transform 0.15s ease; display:inline-block;';
        wrapper.innerHTML = e.data.html;

        var tables = wrapper.querySelectorAll('table');
        for (var ti = 0; ti < tables.length; ti++) {
          var tab = tables[ti];
          tab.style.borderCollapse = 'collapse';
          tab.style.fontSize = '13px';
          tab.style.tableLayout = 'auto';
          tab.style.width = 'auto';
        }
        var cells = wrapper.querySelectorAll('th,td');
        for (var ci = 0; ci < cells.length; ci++) {
          var c = cells[ci];
          c.style.border = '1px solid var(--border-color,#333)';
          if (!c.style.padding) c.style.padding = '4px 8px';
          if (!c.style.textAlign || c.style.textAlign === '') c.style.textAlign = 'left';
          if (!c.style.whiteSpace || c.style.whiteSpace === '') c.style.whiteSpace = 'nowrap';
        }
        var ths = wrapper.querySelectorAll('th');
        for (var hi = 0; hi < ths.length; hi++) {
          ths[hi].style.background = 'var(--card-bg,#1e1e1e)';
        }

        // ★ 表格块展开：原样保留 AI 面板渲染结果，不覆盖样式
        // pre/code 保持原 CSS class（如 .lang-xxx），不强制改写换行/断字

        clipBox.appendChild(wrapper);
        contentEl.appendChild(clipBox);

        var tables2 = wrapper.querySelectorAll('table');
        for (var t2i = 0; t2i < tables2.length; t2i++) {
          var tb = tables2[t2i];
          var firstRow = tb.querySelector('tr');
          if (firstRow) {
            var colWidths = [];
            var rowCells = firstRow.children;
            for (var rci = 0; rci < rowCells.length; rci++) {
              colWidths.push(rowCells[rci].offsetWidth);
            }
            tb.style.tableLayout = 'fixed';
            tb.style.width = 'auto';
            var colgroup = document.createElement('colgroup');
            for (var cwi = 0; cwi < colWidths.length; cwi++) {
              var col = document.createElement('col');
              col.style.width = colWidths[cwi] + 'px';
              colgroup.appendChild(col);
            }
            if (tb.firstChild) {
              tb.insertBefore(colgroup, tb.firstChild);
            } else {
              tb.appendChild(colgroup);
            }
          }
        }

        var natW = wrapper.scrollWidth, natH = wrapper.scrollHeight;
        // fitZoom: 表格缩放后刚好不超出 clipBox 边界（可能 <1 需缩小，也可能 >1 表格本就小于视口）
        var fitZoom = Math.min(_availW / Math.max(1, natW), _availH / Math.max(1, natH));
        // _initZoom: 重置按钮用 — 取 fitZoom 和 1.0 中较小者（至多原样，不放大）
        _initZoom = Math.min(1, fitZoom);
        // 初始缩放：放大两级（1.25²=1.5625），但绝不超出边界 fitZoom
        zoomScale = Math.min(5.0, _initZoom * 1.5625, fitZoom);
        applyZoom();

        overlay.style.visibility = '';

        clipBox.addEventListener('wheel', function (we) {
          we.preventDefault(); we.stopPropagation();
          if (we.deltaY < 0) { zoomScale = Math.min(5.0, zoomScale * 1.15); }
          else { zoomScale = Math.max(0.25, zoomScale * 0.87); }
          applyZoom();
        }, { passive: false });

        dpad.style.display = 'block';
        // ★ 表格/代码块模式：复制按钮原样，三按钮隐藏
        copyBtn.style.display = '';
        memBtn.style.display = 'none';
        fileBtn.style.display = 'none';
        pathBtn.style.display = 'none';
        zoomOutBtn.style.display = '';
        zoomInBtn.style.display = '';
      } catch (_) {
        // 出错时强制复位，避免 overlay 残留 invisible 阻挡 UI
        overlay.style.display = 'none';
        overlay.style.visibility = '';
        contentEl.innerHTML = '';
        dpad.style.display = 'none';
      }
    }

    // ★ 媒体直开（2026-09-21；2026-09-26 自建控制条 + 播放列表）：视频/音频 → 内置播放器（ovmb 自建控制条，弃原生控件）
    //   实测 Electron 22 全解码: h264/aac/hevc/vp9/opus/flac/wav + mkv/mov 容器可播；关闭/切换/重开必停播
    //   ★ 转码兜底（2026-09-21 增）：原生解不了的容器/编码（avi/prores-mov/wmv…）→ 壳层 ffmpeg 转码后回放
    if (e.data.action === 'open-video' || e.data.action === 'open-audio') {
      var _isVid = e.data.action === 'open-video';
      close = _baseClose;
      _ovLocalPath = e.data.localPath || null;
      // ★ 截图基准 = 原始文件路径（转码回放 _tx 时 _ovLocalPath 指向 Cache 产物 → 截图仍落原始文件目录）
      if (!e.data._tx) { _ovShotBase = e.data.localPath || _localPathFromSrc(e.data.src) || null; }
      // ═══ ★ 播放列表（2026-09-26 q319）：roam 多选媒体 → { list, index } 载荷；≥2 项 = 列表模式 ═══
      var _plList = (e.data.list && e.data.list.length > 1) ? e.data.list : null;
      var _plN = _plList ? _plList.length : 1;
      var _plIdx = (_plList && typeof e.data.index === 'number' && e.data.index >= 0 && e.data.index < _plN) ? e.data.index : 0;
      var _actItem = _plList ? _plList[_plIdx] : null;
      if (_plList) {
        // 列表模式：截图基准/本地路径恒取轨原始文件（_tx 重开时 e.data.localPath 是 Cache 产物 → 必须忽略）
        _ovLocalPath = _actItem.localPath || null;
        _ovShotBase = _actItem.localPath || null;
        // 多文件打开 → 重置 循环=列表循环 + 随机=关（用户定案）；仅全新打开重置，_tx 重开/中途切轨不覆盖用户已选模式
        if (!e.data._tx) { _ovMediaLoop = 'all'; _ovMediaShuffle = false; }
      }
      _stopRepeat();
      _stopMedia();
      _ovTxAbort();
      overlay.style.display = 'none';
      contentEl.innerHTML = '';
      contentEl.style.overflow = 'hidden';
      zoomScale = 1.0;
      _dragX = 0; _dragY = 0;
      overlay.style.display = 'block';
      // ★ 打开即聚焦主文档（2026-09-26 v2）：roam q 场景焦点留在 iframe → 主窗口 keydown 收不到（空格/F/Esc 全哑）→ 播放器接管键盘
      try { overlay.focus(); } catch (_) { }

      var _mEl = document.createElement(_isVid ? 'video' : 'audio');
      _mEl.autoplay = true;
      _mEl.setAttribute('playsinline', '');
      // ★ 2026-09-26：弃用原生控件（⋮ 折叠菜单/系统语言/不可定制/不可加循环）→ 自建控制条 ovmb
      var _vWrap = null, _aBox = null, _aNameEl = null;
      if (_isVid) {
        _vWrap = document.createElement('div');
        _vWrap.className = 'ovmb-wrap';
        _vWrap.style.cssText = 'position:relative; width:100%; height:100%; display:flex; ' +
          'align-items:center; justify-content:center;';
        _mEl.style.cssText = 'max-width:100%; max-height:100%; outline:none; ' +
          'border-radius:4px; background:#000; box-shadow:0 4px 32px rgba(0,0,0,0.4);';
        _vWrap.appendChild(_mEl);
        contentEl.appendChild(_vWrap);
      } else {
        // 音频：轻盒（音符 + 文件名 + 自建控制条）居中呈现
        _aBox = document.createElement('div');
        _aBox.style.cssText = 'position:relative; display:flex; flex-direction:column; align-items:center; gap:18px; ' +
          'background:rgba(0,0,0,0.45); border:1px solid rgba(255,255,255,0.12); border-radius:12px; ' +
          'padding:30px 40px; max-width:80%;';
        var _aGlyph = document.createElement('div');
        _aGlyph.textContent = '\u266A';
        _aGlyph.style.cssText = 'font-size:38px; line-height:1; color:#ffd301;';
        var _aName = document.createElement('div');
        _aNameEl = _aName;
        var _lp = String((_actItem && _actItem.localPath) || e.data.localPath || '');
        _aName.textContent = (_actItem && _actItem.name) ? _actItem.name : (_lp ? _lp.split(/[\\/]/).pop() : '');
        _aName.style.cssText = 'color:#dcd8d0; font-size:15px; line-height:1.4; word-break:break-all; text-align:center; max-width:480px;';
        _mEl.style.cssText = 'position:absolute; width:0; height:0; opacity:0; pointer-events:none;';
        _aBox.appendChild(_aGlyph);
        _aBox.appendChild(_aName);
        _aBox.appendChild(_mEl);
        contentEl.appendChild(_aBox);
      }
      // ★ 自建控制条挂载（视频 = 包装层底部浮层；音频 = 轻盒内联）——api 携播放列表上下文（多轨出 ⏮/⏭ + n/N 计数）
      var _plApi = { n: _plN, idx: _plIdx, onEnded: null, onPrev: null, onNext: null, list: _plList, jump: null, onModeChange: null };
      var _barApi = _ovBuildMediaBar(_mEl, _isVid, _vWrap, _plApi);
      (_vWrap || _aBox).appendChild(_barApi.bar);
      // ═══ ★ 播放列表机器（2026-09-26 q319）：切轨/失败链/模式裁决——_tx 重开携 {list,index} 保队列与当前轨 ═══
      var _txKind = _isVid ? 'video' : 'audio';
      var _txTried = !!e.data._tx;
      var _metaOk = false;
      var _fallTimer = 0;
      var _plSkipLeft = _plN;   // 列表：单轨彻底失败 → 跳下一轨（全轮试完才关播放器）
      function _curLocal() { return _plList ? ((_plList[_plIdx] && _plList[_plIdx].localPath) || null) : _ovLocalPath; }
      var _ovMediaFail = function () {
        if (_plList && _plSkipLeft > 1) {
          _plSkipLeft--;
          var _bad = _plList[_plIdx];
          _ovToast(window._i('shell.overlay.mskip', '无法播放，已跳过：{name}', { name: (_bad && _bad.name) || '' }), 'error');
          _advanceTo((_plIdx + 1) % _plN);
          return;
        }
        _ovToast(window._i('shell.overlay.mediaFailed', '媒体加载失败，可能格式不受支持或文件已损坏'), 'error');
        try { close(); } catch (_) { }
      };
      var _ovMediaTx = function () {
        var _file = _curLocal();
        if (_txTried || !_file) { _ovMediaFail(); return; }
        _txTried = true;
        _ovTxRun(_file, _txKind, function (newPath) {
          var _tm = { type: 'qqqide-overlay', action: _isVid ? 'open-video' : 'open-audio', src: 'file:///' + newPath, localPath: newPath, _tx: 1 };
          if (_plList) { _tm.list = _plList; _tm.index = _plIdx; }   // 列表重开保队列与当前轨（漏它 → 转码后丢列表）
          window.postMessage(_tm, '*');
        }, _ovMediaFail);
      };
      function _loadNative(src, isTx) {
        _metaOk = false;
        if (_fallTimer) { clearTimeout(_fallTimer); _fallTimer = 0; }
        _mEl.src = src;
        try { var _p = _mEl.play(); if (_p && _p.catch) { _p.catch(function () { }); } } catch (_) { }
        if (!isTx) {
          // 静默卡死兜底：8s 无元数据也无 error → 走转码
          _fallTimer = setTimeout(function () {
            if (!_metaOk) {
              try { _mEl.removeAttribute('src'); _mEl.load(); } catch (_) { }
              _ovMediaTx();
            }
          }, 8000);
        }
      }
      function _replayCur() {
        try { _mEl.currentTime = 0; } catch (_) { }
        try { var _p2 = _mEl.play(); if (_p2 && _p2.catch) { _p2.catch(function () { }); } } catch (_) { }
      }
      // ═══ ★ 随机袋（v2）：随机 = 独立维度——袋 = 本轮未播索引；空袋 + 循环开 = 重洗续播 / 空袋 + 循环关 = 播完停（随机单次）═══
      var _plBag = {};
      function _bagReset() {
        _plBag = {};
        for (var _bi = 0; _bi < _plN; _bi++) { if (_bi !== _plIdx) { _plBag[_bi] = 1; } }
      }
      function _bagPick() {
        var _cand = [];
        for (var _bk in _plBag) { _cand.push(+_bk); }
        return _cand.length ? _cand[Math.floor(Math.random() * _cand.length)] : null;
      }
      function _shuffleNext(manual) {
        var _k = _bagPick();
        if (_k === null && (_ovMediaLoop === 'all' || manual)) { _bagReset(); _k = _bagPick(); }   // 空袋：循环开→重洗；手动 ⏭→必进
        if (_k === null) { return false; }
        _advanceTo(_k);
        return true;
      }
      if (_plList && _ovMediaShuffle) { _bagReset(); }
      // 切轨：本地路径/截图基准/文件名/位置计数/A-B 全量对齐该轨（A-B 时间点无跨文件意义 → 切轨即清零）
      function _advanceTo(k) {
        _ovTxAbort();
        _plIdx = k;
        delete _plBag[k];
        _txTried = false;
        var it = _plList[_plIdx];
        _ovLocalPath = it.localPath || null;
        _ovShotBase = it.localPath || null;
        if (_aNameEl) { _aNameEl.textContent = it.name || String(it.localPath || '').split(/[\\/]/).pop(); }
        if (_barApi.setTrack) { _barApi.setTrack(k); }
        if (_barApi.resetAB) { _barApi.resetAB(); }
        if (_OV_TX_FIRST_EXTS[_ovTxExt(it.localPath || it.src)]) { _ovMediaTx(); return; }
        _loadNative(it.src, false);
      }
      // 模式裁决（ended 后；A-B 已由控制条先行拦截）——循环 × 随机 两独立维度
      function _plOnEnded() {
        if (_ovMediaLoop === 'one') { _replayCur(); return; }             // 单曲循环（含单文件）
        if (!_plList || _plN < 2) {                                        // 单文件：循环关=播完停；循环开（列表/单曲同效）=重播
          if (_ovMediaLoop !== 'off') { _replayCur(); }
          return;
        }
        if (_ovMediaShuffle) { _shuffleNext(false); return; }              // 随机：袋中取未播（空袋 → 循环开重洗 / 循环关播完停）
        if (_plIdx < _plN - 1) { _advanceTo(_plIdx + 1); return; }         // 顺序下一轨
        if (_ovMediaLoop === 'all') { _advanceTo(0); }                     // 尾接首
      }
      function _plPrev() { if (_plList && _plN > 1) { _advanceTo((_plIdx - 1 + _plN) % _plN); } }
      function _plNext() {
        if (!_plList || _plN < 2) { return; }                              // 单轨（含移除缩到 1）→ 无跳轨语义
        if (_ovMediaShuffle && _plN > 1) { _shuffleNext(true); return; }   // 随机下手动 ⏭：袋中取（空袋必进）
        _advanceTo((_plIdx + 1) % _plN);
      }
      _plApi.onEnded = _plOnEnded; _plApi.onPrev = _plPrev; _plApi.onNext = _plNext;
      _plApi.jump = function (k) {                                        // 列表面板点击切轨（当前轨零动作）
        if (!_plList || typeof k !== 'number' || k < 0 || k >= _plN || k === _plIdx) { return; }
        _advanceTo(k);
      };
      _plApi.onModeChange = function (dim) {                              // 随机开启 → 袋按当前轨重建
        if (dim === 'shuffle' && _ovMediaShuffle && _plList) { _bagReset(); }
      };
      // ═══ ★ 列表行操作（2026-09-26 q319 v3）：拖动/箭头重排 + 单行移除——重排不打断播放（当前轨索引跟随）；
      //   移除当前轨 → 原位接播切片后同索引（末位回落新末位）；空列表 → 关悬浮层；随机袋按新列表卫生化 ═══
      function _plBagSanitize() {
        for (var _bk in _plBag) { if (+_bk >= _plN || +_bk === _plIdx) { delete _plBag[_bk]; } }
      }
      _plApi.move = function (from, to) {
        if (!_plList || typeof from !== 'number' || typeof to !== 'number') { return; }
        var _n = _plList.length;
        if (from < 0 || from >= _n) { return; }
        to = Math.max(0, Math.min(_n - 1, to));
        if (from === to) { return; }
        var _it = _plList.splice(from, 1)[0];
        _plList.splice(to, 0, _it);
        if (_plIdx === from) { _plIdx = to; }
        else if (from < _plIdx && to >= _plIdx) { _plIdx--; }
        else if (from > _plIdx && to <= _plIdx) { _plIdx++; }
        _plApi.idx = _plIdx;
        _plBagSanitize();
      };
      _plApi.remove = function (i) {
        if (!_plList || typeof i !== 'number' || i < 0 || i >= _plList.length) { return; }
        if (i === _plIdx) {                                     // 移除当前轨 → 原位接播（切片后同索引 = 下一轨；末位 → 新末位）
          _plList.splice(i, 1);
          _plN = _plList.length; _plApi.n = _plN;
          if (_plN === 0) { try { close(); } catch (_) { } return; }
          _plSkipLeft = Math.min(_plSkipLeft, _plN);
          _plBagSanitize();
          _advanceTo(Math.min(i, _plN - 1));
          return;
        }
        _plList.splice(i, 1);
        _plN = _plList.length; _plApi.n = _plN;
        if (i < _plIdx) { _plIdx--; _plApi.idx = _plIdx; }
        _plSkipLeft = Math.min(_plSkipLeft, _plN);
        _plBagSanitize();
      };
      _mEl.addEventListener('error', function () { _ovMediaTx(); });
      _mEl.addEventListener('loadedmetadata', function () {
        _metaOk = true;
        _plSkipLeft = _plN;   // 成功轨 → 重置跳过预算
        if (_fallTimer) { clearTimeout(_fallTimer); _fallTimer = 0; }
      });
      // ★ 关闭时停止播放（DOM 移除不保证停播——必须显式 pause+卸载）+ 清兜底定时器
      var _mPrevClose = close;
      close = function () {
        try { if (_fallTimer) { clearTimeout(_fallTimer); _fallTimer = 0; } } catch (_) { }
        try { _mEl.pause(); _mEl.removeAttribute('src'); _mEl.load(); } catch (_) { }
        close = _mPrevClose;
        _mPrevClose();
      };
      // ★ 会话清理挂 _stopMedia（close 与一切切换路径全覆盖——单挂 close 包装器会漏 open-image/open-table 直切）
      _ovMediaKeysFn = _barApi.keys;
      _ovMediaCleanup = function () {
        if (_fallTimer) { clearTimeout(_fallTimer); _fallTimer = 0; }
        _ovMediaKeysFn = null;
        try { _barApi.cleanup(); } catch (_) { }
      };
      // 初始加载：_tx 产物直载 / 首发命中转码组直接转码（黑框 + 状态条进度）/ 否则原生 + 静默卡死兜底
      if (e.data._tx) {
        _loadNative(e.data.src, true);
      } else if (_OV_TX_FIRST_EXTS[_ovTxExt((_actItem && _actItem.localPath) || _ovLocalPath || _localPathFromSrc(e.data.src) || e.data.src)]) {
        _ovMediaTx();
      } else {
        _loadNative(e.data.src, false);
      }
      // ★ 媒体模式：自适应无需缩放——藏缩放/D-pad/复制/内存按钮，留文件/路径/关闭
      dpad.style.display = 'none';
      copyBtn.style.display = 'none';
      memBtn.style.display = 'none';
      fileBtn.style.display = '';
      pathBtn.style.display = '';
      zoomOutBtn.style.display = 'none';
      zoomInBtn.style.display = 'none';
    }

    // ★ AI 面板图片 hover「Roam」按钮：激活 roam tab + 聚焦 + 跳到目录选中文件
    if (e.data.action === 'reveal-in-roam') {
      if (typeof e.data.src === 'string' && /^file:\/\//i.test(e.data.src)) _roamRevealText(e.data.src, '');
      else _roamQoast(window._i('shell.overlay.roamNoFile', '该图片无本地文件，无法在 Roam 定位'));
      return;
    }
    // ★ 本地路径存在性探针（2026-09-07）：AI 面板权威渲染后批量确认，存在才允许显示为链接
    if (e.data.action === 'lpl-probe') {
      _lplHandleProbe(e);
      return;
    }
    // ★ AI 回复本地路径链接：Roam 定位目录/文件（2026-09-06）
    if (e.data.action === 'roam-reveal-path') {
      _roamRevealText(e.data.text || '', e.data.ctx || '');
      return;
    }
  });

  // ═══ Roam 定位引擎（2026-09-06 泛化）：任意本地路径 → 激活 roam + 跳转/选中 ═══
  // 支持：盘符绝对 / 相对路径（依 AI 视口阵营逐根解析，主文件夹优先）/ 树图裸文件名（ctx 拼接）
  // 边界兜底：不存在/已删除 → 爬升最近存在祖先 + toast，绝不静默死链；
  //           roam tab/iframe 未就绪 → 自建 tab + 轮询重发（7.5s 上限）。
  function _roamQoast(msg) {
    try {
      if (window.qqqideQoast && window.qqqideQoast.show) window.qqqideQoast.show(msg, { type: 'info', duration: 3500 });
    } catch (_) { }
  }
  function _roamFs() { try { return window.qqqideBridge && window.qqqideBridge.fs; } catch (_) { return null; } }
  function _roamStat(p) {
    var fs = _roamFs();
    if (!fs || !fs.stat) return Promise.resolve(null);
    return fs.stat(p).catch(function () { return null; });
  }
  function _roamRoots() {
    var out = [];
    try {
      var vp = window.qqqideViewport;
      var ps = vp && vp.getProjects ? vp.getProjects() : null;
      if (ps) {
        for (var i = 0; i < ps.length; i++) {
          if (ps[i] && ps[i].path) out.push(String(ps[i].path).replace(/\\/g, '/').replace(/\/+$/, ''));
        }
      }
    } catch (_) { }
    return out;
  }
  function _roamJoin(base, rel) {
    var b = String(base || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var r = String(rel || '').replace(/\\/g, '/');
    while (r.indexOf('./') === 0) r = r.slice(2);
    return b + '/' + r;
  }
  // ★ 平台：POSIX 绝对路径判定（mac/linux 首字符 '/'）——2026-09-17；Windows 平台恒 false（q2-roam.js _ROAM_IS_MAC 同口径）
  var _ROAM_MAC = /Mac/i.test(String(navigator.platform || '') + ' ' + String(navigator.userAgent || ''));
  function _roamPosixAbs(t) { return _ROAM_MAC && String(t || '').charAt(0) === '/'; }
  function _roamParent(p) {
    var s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var i = s.lastIndexOf('/');
    if (i <= 0) return /^[A-Za-z]:$/.test(s) ? s + '/' : null;
    return s.slice(0, i);
  }
  function _roamShort(p) {
    var s = String(p || '');
    return s.length > 52 ? '…' + s.slice(s.length - 51) : s;
  }
  // 逐级上爬：返回第一个仍存在滴祖先（含自身）
  async function _roamClimb(p) {
    var cur = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!cur) return null;
    var fs = _roamFs();
    if (!fs) return null;
    for (var guard = 0; guard < 80 && cur; guard++) {
      // 盘根歧义兜底：fs.stat('E:') 语义=E盘cwd，必须带尾斜杠才等价盘根
      if (/^[A-Za-z]:$/.test(cur)) cur = cur + '/';
      var st = await fs.stat(cur).catch(function () { return null; });
      if (st) return { path: cur, isDir: !!st.isDir };
      var nx = _roamParent(cur);
      if (!nx || nx === cur) return null;
      cur = nx;
    }
    return null;
  }
  // 激活 roam tab（缺则硬建）+ 轮询向 iframe 发命令
  function _roamEnsureTab() {
    try {
      var gaeaGrp = window.qqqTabs && window.qqqTabs.getGaeaGroup ? window.qqqTabs.getGaeaGroup() : null;
      if (!gaeaGrp) return false;
      var roamTab = gaeaGrp.tabs.find(function (t) { return t.gaeaId === 'roam'; });
      if (!roamTab && window.qqqTabs.addGaeaTab) {
        try {
          window.qqqTabs.addGaeaTab('roam', 'Roam', function (pane) {
            pane.style.cssText = 'position:relative; width:100%; height:100%; overflow:hidden;';
            var iframe = document.createElement('iframe');
            iframe.src = '/qqqide/goods/file-explorer/q2-roam.html';
            iframe.style.cssText = 'width:100%; height:100%; border:none;';
            iframe.setAttribute('frameborder', '0');
            pane.appendChild(iframe);
          }, { closable: false });
          roamTab = gaeaGrp.tabs.find(function (t) { return t.gaeaId === 'roam'; });
        } catch (_) { }
      }
      if (roamTab && window.qqqTabs.activateTab) {
        try { window.qqqTabs.activateTab(gaeaGrp, roamTab.id); } catch (_) { }
      }
      return !!roamTab;
    } catch (_) { return false; }
  }
  // Roam 命令单飞发送器（2026-09-08 ack 回路）：命令带 reqId，iframe 消费后回执 → 立即停发。
  // 单飞 = 新命令先清旧发送器（快速连点两个链接时旧命令不得继续把用户拉来拉去）；
  // 25 次/7.5s 仅作 iframe 未就绪（懒加载/重建）兜底，正常路径 ~300ms 内 ack 即停，零硬控。
  var _roamCmdTimer = null, _roamCmdToken = 0;
  function _roamSendCmd(cmd, path) {
    if (!path) return;
    if (_roamCmdTimer) { clearInterval(_roamCmdTimer); _roamCmdTimer = null; }
    _roamEnsureTab();
    var token = ++_roamCmdToken;
    var sent = 0;
    var wasNull = true;
    var timer = setInterval(function () {
      var it = document.querySelector('iframe[src*="q2-roam"]');
      if (it && it.contentWindow) {
        try {
          // iframe 首次出现才抢焦点——旧实现每 300ms focus 一次，7.5s 内反复抢焦点同样在硬控用户
          if (wasNull) { try { it.contentWindow.focus(); } catch (_) { } wasNull = false; }
          it.contentWindow.postMessage({ type: 'qqq-roam-cmd', cmd: cmd, path: path, reqId: token }, '*');
        } catch (_) { }
      }
      sent++;
      if (sent >= 25 || _roamCmdToken !== token) {   // 达上限 / 被新命令顶替 → 自清
        clearInterval(timer);
        if (_roamCmdTimer === timer) _roamCmdTimer = null;
      }
    }, 300);
    _roamCmdTimer = timer;
  }
  function _roamRevealHit(path, st) {
    if (st && st.isDir) _roamSendCmd('roam.navTo', path);
    else _roamSendCmd('roam.revealFile', path);
  }
  // ═══ 命中裁决（2026-09-07 共享）：点击定位与存在性探针同一裁决，零双写漂移 ═══
  // 返回 { hit:{path,isDir} | null, first:爬升基准, err:fs 不可用 }；只做①直接候选 ②ctx 裸名拼接，不爬升。
  async function _roamResolveHits(text, ctx) {
    var fs = _roamFs();
    if (!fs || !fs.stat) return { hit: null, first: null, err: true };
    var t = String(text || '').trim();
    var wasFileUrl = /^file:\/\/\//i.test(t);
    if (wasFileUrl) {
      t = t.replace(/^file:\/\/\//i, '');
      try { t = decodeURIComponent(t); } catch (_) { }
    }
    t = t.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!t) return { hit: null, first: null, err: false };
    var isAbs = /^[A-Za-z]:\//.test(t) || _roamPosixAbs(t);   // mac：'/Users/…' = 真绝对（Windows 首字符 '/' 维持逐根相对解析）
    var roots = _roamRoots();
    var hasSep = t.indexOf('/') !== -1;
    // ① 直接候选：绝对原样；相对逐根拼接（主文件夹优先）
    var direct = [];
    if (isAbs) {
      direct.push(t.length === 2 ? t + '/' : t);
    } else if (hasSep) {
      if (!roots.length) direct.push(t);
      for (var ri = 0; ri < roots.length; ri++) direct.push(_roamJoin(roots[ri], t));
    }
    var fallback = direct[0] || (isAbs ? t : (roots.length ? _roamJoin(roots[0], t) : t));
    for (var di = 0; di < direct.length; di++) {
      var stD = await fs.stat(direct[di]).catch(function () { return null; });
      if (stD) return { hit: { path: direct[di], isDir: !!stD.isDir }, first: fallback, err: false };
    }
    // ② 裸文件名 + ctx：先解析 ctx 锚点（绝对或逐根），文件取父目录，再拼名
    if (!hasSep && !isAbs && ctx) {
      var c = String(ctx).replace(/\\/g, '/').replace(/\/+$/, '');
      var cAbs = /^[A-Za-z]:\//.test(c) || _roamPosixAbs(c);
      var cbases = cAbs ? [c] : [];
      if (!cAbs) for (var ci = 0; ci < roots.length; ci++) cbases.push(_roamJoin(roots[ci], c));
      for (var cbi = 0; cbi < cbases.length; cbi++) {
        var stC = await fs.stat(cbases[cbi]).catch(function () { return null; });
        if (!stC) continue;
        var dirC = stC.isDir ? cbases[cbi] : _roamParent(cbases[cbi]);
        if (!dirC) continue;
        var leaf = _roamJoin(dirC, t);
        var stL = await fs.stat(leaf).catch(function () { return null; });
        if (stL) return { hit: { path: leaf, isDir: !!stL.isDir }, first: fallback, err: false };
      }
    }
    return { hit: null, first: fallback, err: false };
  }
  // 唯一入口：text=候选路径原文，ctx=树图上文目录（可选）——命中直达；未命中爬升最近祖先，杜绝死链
  async function _roamRevealText(text, ctx) {
    var r = await _roamResolveHits(text, ctx);
    if (r.err) { _roamQoast(window._i('shell.overlay.roamUnavailable', 'Roam 定位暂不可用，请稍后再试')); return; }
    var orig = String(text || '').trim();
    if (!r.first) { _roamQoast(window._i('shell.overlay.roamNoPath', '该路径无本地文件，无法在 Roam 定位')); return; }
    if (r.hit) { _roamRevealHit(r.hit.path, { isDir: r.hit.isDir }); return; }
    var near = await _roamClimb(r.first);
    if (near) {
      _roamQoast(window._i('shell.overlay.roamMoved', '路径已不存在（可能被移动/删除）：') + _roamShort(orig) + window._i('shell.overlay.roamMoved2', ' → 已定位到最近目录 ') + _roamShort(near.path));
      _roamSendCmd('roam.navTo', near.path);
    } else {
      _roamQoast(window._i('shell.overlay.roamNotFound', '未在磁盘上找到：') + _roamShort(orig));
    }
  }
  // ★ 全局入口（2026-09-11）：timeline diff 窗口 op 菜单「Roam」→ 主进程 executeJavaScript 调用。
  //   与 AI 面板本地链接点击共用同一台机器（_roamRevealText），差异仅在消息入口：
  //   面板走 postMessage(roam-reveal-path)，diff 窗口走 IPC → 此函数。
  window.__qqq_roamRevealPath = function (text, ctx) {
    try { _roamRevealText(text, ctx || ''); } catch (_) { }
  };

  // ═══ 存在性探针裁决（2026-09-07）：面板批量确认 + 悬浮预览拷贝兜底共用 ═══
  var _lplOvCache = new Map();   // 主窗口侧会话缓存（key=p+ctx → true/false，FIFO 上限 3000）
  function _lplOvSet(key, ok) {
    _lplOvCache.set(key, ok);
    if (_lplOvCache.size > 3000) {
      var it = _lplOvCache.keys().next();
      if (!it.done) _lplOvCache.delete(it.value);
    }
  }
  async function _lplOvCheck(p, c) {
    var key = String(c || '') + '\u0001' + String(p || '');
    var st = _lplOvCache.get(key);
    if (st !== undefined) return !!st;
    var ok = false;
    try { var r = await _roamResolveHits(p, c); ok = !!(r && r.hit); } catch (_) { ok = false; }
    _lplOvSet(key, ok);
    return ok;
  }
  // AI 面板 lpl-probe：逐条裁决（顺序 await 防 stat 风暴），结果回传发起方 iframe
  async function _lplHandleProbe(e) {
    var items = (e.data && Array.isArray(e.data.items)) ? e.data.items.slice(0, 900) : [];
    var results = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var p = String(it.p || '');
      var c = String(it.c || '');
      var ok = false;
      try { ok = await _lplOvCheck(p, c); } catch (_) { ok = false; }
      results.push({ p: p, c: c, ok: ok });
    }
    try {
      if (e.source && e.source.postMessage) {
        e.source.postMessage({ type: 'qqq-lpl-probe-result', reqId: e.data.reqId || '', results: results }, '*');
      }
    } catch (_) { }
  }
  // 悬浮预览内未确认拷贝链接：主窗口直连裁决——存在则激活并跳转，不存在解除为纯文本
  async function _ovProbeThen(p, c, el, onOk) {
    var ok = false;
    try { ok = await _lplOvCheck(p, c); } catch (_) { ok = false; }
    if (!el.isConnected) return;
    if (ok) {
      el.classList.add('qqq-path-ok');
      if (!el.title) el.title = (window._i ? window._i('ai.roamOpen', '在 Roam 中打开') : '在 Roam 中打开');
      if (onOk) onOk();
    } else {
      try {
        var tn = el.ownerDocument.createTextNode(el.textContent || '');
        if (el.parentNode) el.parentNode.replaceChild(tn, el);
      } catch (_) { }
    }
  }

  // Theme sync
  if (window.qqqideTheme && window.qqqideTheme.onChange) {
    window.qqqideTheme.onChange(function (dark) {
      var wrapper = contentEl.querySelector('div > div') || contentEl.querySelector('div');
      if (wrapper) {
        wrapper.style.background = dark ? '#2a2a2a' : '#ede4cf';
        wrapper.style.color = dark ? '#dcd8d0' : '#656360';
      }
    });
  }
}
