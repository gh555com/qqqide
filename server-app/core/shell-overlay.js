// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-overlay.js — AI 悬浮预览层（图片 + 表格，全窗口）（从 shell.js 拆分）
//   ★ 2026-10-02 单宿主大整改：播放器已独立成窗（player/player.html，Roam Q 直开）——
//     本层不再承载任何媒体（open-video/open-audio/stow/交接全删）；仅保留图片/表格预览，
//     并借用共享引擎的转码工具（psd/tif 图片 → ffmpeg 抽帧）与 Roam 定位引擎。
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
  overlay.setAttribute('tabindex', '-1');  // ★ 可编程聚焦（打开即抢焦点 → 键盘快捷键不再被 iframe 吞；关层归还，详 _ovClaimFocus）
  overlay.style.cssText =
    'display:none; outline:none; position:absolute; inset:0; z-index:99999; ' +
    'background:rgba(0,0,0,0.88);';
  // ★ 键位标准色 q（同值源 = player.html :root --key-q）：本层翻页键帽 .ovmb-kcap 的字符色依赖此变量
  overlay.style.setProperty('--key-q', '#ff7e8a');


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
  // ★ 缩放域 1%~6400%（滚轮/±钮/指示钮共用边界，唯一常量）；放大超 1:1 一律 pixelated 原始像素
  var _OV_ZOOM_MAX = 64, _OV_ZOOM_MIN = 0.01;
  var _ovZoomTouched = false;   // 本层打开期间用户动过缩放——决定「缩放指示钮」显隐
  // 拖拽偏移（图片和表格共用 translate）
  var _dragX = 0, _dragY = 0;
  // ★ 画布拖拽平移（2026-10-02）：仅表格/代码块模式武装——渲染区（wrapper）外的暗色区域按住拖拽 = 平移整个图层
  var _ovTablePanMode = false;      // 仅 open-table 模式武装（图片模式拖图片本身，不用此机）
  var _ovPanDrag = null;            // 本次拖拽会话 {sx,sy,raf,pending,moved}
  var _ovPanSwallowClick = false;   // 拖拽后紧随的 click 吞掉（防 mouseup 落点漂移命中 overlay 背景 → 误关层）

  // ── 选中高亮全文匹配（CSS Highlight API — 零 DOM 操作，不阻复制、零抖动）──
  var _ovLastMatchText = '';
  // ★ 图片本地路径（open-image 消息 localPath 透传；dataUrl 缩略图场景的文件/路径按钮靠它）
  var _ovLocalPath = null;
  // ★ 翻页机器（共用唯一实现）：open-image 消息可携 nav={list:[{src,localPath}],index}——
  //   左右贴边全高翻页钮沿该序列上/下一张（首尾环状）；序列与顺序恒由来源方给定：
  //   Roam=来源文件夹的排序快照 / AI 面板=会话图片显示顺序 / MD 文档=文中图片顺序。
  var _ovNav = null;
  var _ovNavLeft = null, _ovNavRight = null;   // 贴边翻页钮（_ovNavBtn 创建后赋值；钮上键帽 q/w = 翻页快捷键）
  // ★ 当前图片拖拽监听清理器（翻页/重开/关闭先跑——防监听随翻页堆积）
  var _ovImgCleanup = null;
  // ★ 图片直显代际令牌（翻页快按：仅最后一张生效——旧加载/转码回调一律作废，防旧图回抢）
  var _ovShowGen = 0;
  // ★ 本轮连续跳过计数（文件被外部删除/移动/损坏 → 标死续跳；落定到可显示图片后一次性如实提示）
  var _ovNavSkips = 0;
  // ★ 旋转机器（图片专属）：当前图旋转角——连续累计（保旋转动画恒走短边）；归一值 0/90/180/270 仅用于适配/记忆
  var _ovRotDeg = 0;
  // ★ 旋转视图记忆（path 键·反斜杠归一正斜杠；app 运行期内存表——关层重开/跨来源保持，重启清零，绝不落盘；FIFO 上限 500）
  var _ovRotMemo = new Map();

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
  // ★ 图片滤镜裁定：显示总倍率（基础适配 × 缩放，含小图初始上采样）>1:1 → pixelated 原始像素零插值；≤1:1 平滑；svg 恒平滑
  function _ovApplyImgFilter(img) {
    var total = zoomScale * (img._ovBaseScale || 1);
    var isSvg = /\.svg$/i.test(String(_ovLocalPath || '')) || /^data:image\/svg/i.test(String(img.src || ''));
    img.style.imageRendering = (total > 1.0001 && !isSvg) ? 'pixelated' : 'auto';
  }
  // ═══ ★ 旋转机器（图片专属）═══
  // 变换链恒 = scale(z)·translate(d)·rotate(θ)：rotate 恒最内——拖拽补偿恒 /z 不变、拖动恒屏幕方向；
  // 旋转轴 = 元素中心；旋转即回中（d=0）→ 轴 = 视口中心（正在注视的内容原地旋转）。
  function _ovImgTransform() {
    return 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px) rotate(' + _ovRotDeg + 'deg)';
  }
  // 适配盒（旋转感知：90/270 视觉宽高互换 → 100% 视图恒整图可见；2x 上采样封顶与旧口径等价）
  function _ovFitBox(nw, nh) {
    var rn = ((_ovRotDeg % 360) + 360) % 360;
    var _rq = Math.round(rn / 90) % 4;   // 适配盒档位 = 就近 90°（微调角跨档即跟随；步进恒为精确档）
    var swap = (_rq === 1 || _rq === 3);
    var availW = Math.max(200, (overlay.clientWidth || window.innerWidth) - 64);
    var availH = Math.max(150, (overlay.clientHeight || window.innerHeight) - 64 - 64);
    var rw = swap ? nh : nw, rh = swap ? nw : nh;
    var scale = Math.min(availW / Math.max(1, rw), availH / Math.max(1, rh), 2.0);
    var w = Math.round(nw * scale), h = Math.round(nh * scale);
    return { w: w, h: h, base: nw > 0 ? w / nw : 1 };
  }
  // 旋转后重算适配盒（元素盒宽高 + 基础倍率；filter 裁定基准同步）
  function _ovRefitImg(img) {
    var nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return;
    var f = _ovFitBox(nw, nh);
    img.style.width = f.w + 'px';
    img.style.height = f.h + 'px';
    img._ovBaseScale = f.base;
  }
  // 视图记忆读取（path 键·反斜杠归一正斜杠——同文件跨入口记忆相通；无路径不记忆——剪贴板/内存图天然瞬态）
  function _ovRotKeyOf(lp) { return lp ? String(lp).replace(/\\/g, '/') : ''; }
  function _ovRotGet(lp) { try { var _k = _ovRotKeyOf(lp); return (_k && _ovRotMemo.get(_k)) || 0; } catch (_) { return 0; } }
  // 旋转记账（两层记忆：翻页序列项 rot + path 键运行期表；步进/微调共用唯一实现）
  function _ovRotCommit() {
    var rn = ((_ovRotDeg % 360) + 360) % 360;
    if (_ovNav && _ovNav.list && _ovNav.list[_ovNav.index]) _ovNav.list[_ovNav.index].rot = rn;
    var _rp = _ovRotKeyOf(_ovLocalPath);
    if (_rp) {
      if (rn) {
        _ovRotMemo.set(_rp, rn);
        if (_ovRotMemo.size > 500) { var _fk = _ovRotMemo.keys().next(); if (!_fk.done) _ovRotMemo.delete(_fk.value); }
      } else { _ovRotMemo.delete(_rp); }
    }
  }
  // 旋转步进（dir：-1 逆时针 / +1 顺时针；90° 步进；执行时机 = 钮抬起——详按住机器；无键盘监听）
  function _ovRotate(dir) {
    if (_ovTablePanMode) return;
    _ovRotDeg += (dir > 0 ? 90 : -90);
    _ovRotCommit();
    var img = contentEl.querySelector('img');
    if (!img) return;   // 图未就绪（加载中）：状态先落，onload 按当前状态显示
    _ovRefitImg(img);
    _dragX = 0; _dragY = 0;   // 旋转即回中
    applyZoom();
  }
  // 角度微调（仅按住机器进档后调用；每次 ±1°）：纯旋转——不重算适配盒、不叠步进（微幅转动视线不跳）
  function _ovRotFine(dir) {
    if (_ovTablePanMode) return;
    _ovRotDeg += (dir > 0 ? 1 : -1);
    _ovRotCommit();
    var img = contentEl.querySelector('img');
    if (img) applyZoom();   // 图未就绪：状态先落，onload 按当前状态显示
  }
  // ★ 旋转钮按住机器（唯一交互）：单击 = 抬起时 90° 步进（<500ms 且落点回钮）；按住 ≥500ms = 角度微调
  //   （进档即回中并 ±1°，此后每 50ms ±1°；微调后抬起不做任何事——绝不叠加步进）
  //   松手丢事件防线（播放器按住连按同款）：窗口捕获相位 pointerup/pointercancel + pointermove 见 buttons==0 补收尾 + setPointerCapture 兜底；
  //   取消 / 窗口失焦 / 换图 / 关层 = 中止（不出步进）
  var _rotHold = null;
  var _ROT_HOLD_MS = 500, _ROT_FINE_MS = 50;
  function _ovRotHoldAbort() {
    var h = _rotHold;
    if (!h) return;
    _rotHold = null;
    if (h.t500) { clearTimeout(h.t500); h.t500 = 0; }
    if (h.tick) { clearInterval(h.tick); h.tick = 0; }
    if (h.btn) h.btn.style.background = 'rgba(255,255,255,0.1)';
    try {
      window.removeEventListener('pointerup', _rotHoldOnUp, true);
      window.removeEventListener('pointercancel', _rotHoldOnCancel, true);
      window.removeEventListener('pointermove', _rotHoldOnMove, true);
      window.removeEventListener('blur', _rotHoldOnBlur, true);
    } catch (_) { }
  }
  function _rotHoldSettle(ev, cancelled) {
    var h = _rotHold;
    if (!h) return;
    var held = performance.now() - h.t0, inside = false;
    if (ev && h.btn) {
      var r = h.btn.getBoundingClientRect();
      inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    }
    var dir = h.dir;
    _ovRotHoldAbort();
    if (!cancelled && held < _ROT_HOLD_MS && inside) _ovRotate(dir);   // 单击在抬起执行；微调情形抬起不做任何事
  }
  function _rotHoldOnUp(ev) { _rotHoldSettle(ev, false); }
  function _rotHoldOnCancel(ev) { _rotHoldSettle(ev, true); }
  function _rotHoldOnMove(ev) { if (typeof ev.buttons === 'number' && ev.buttons === 0) _rotHoldSettle(null, true); }
  function _rotHoldOnBlur() { _ovRotHoldAbort(); }
  function _ovRotHoldStart(btn, dir, e) {
    if (_ovTablePanMode) return;
    if (e && e.pointerType === 'mouse' && e.button !== 0) return;   // 仅左键
    if (e) e.preventDefault();
    _ovRotHoldAbort();
    var h = { dir: dir, btn: btn, t0: performance.now(), t500: 0, tick: 0 };
    _rotHold = h;
    btn.style.background = 'rgba(255,255,255,0.3)';   // 按住反馈（<500ms 静默期唯一视觉应答）
    try { if (e && btn.setPointerCapture) btn.setPointerCapture(e.pointerId); } catch (_) { }
    h.t500 = setTimeout(function () {
      h.t500 = 0;
      if (_rotHold !== h) return;
      if (_ovTablePanMode) { _ovRotHoldAbort(); return; }   // 层已切表格模式 = 放弃微调（收尾仍走抬起/中止路径）
      _dragX = 0; _dragY = 0;   // 进档先回中（同步进：轴 = 视口中心）
      _ovRotResetHint();   // ★ 首次对该图进微调 → 文字提示 + 房子钮黄色同步闪烁
      _ovRotFine(dir);
      h.tick = setInterval(function () { if (_rotHold === h) _ovRotFine(dir); }, _ROT_FINE_MS);
    }, _ROT_HOLD_MS);
    try {
      window.addEventListener('pointerup', _rotHoldOnUp, true);
      window.addEventListener('pointercancel', _rotHoldOnCancel, true);
      window.addEventListener('pointermove', _rotHoldOnMove, true);
      window.addEventListener('blur', _rotHoldOnBlur, true);
    } catch (_) { }
  }
  function applyZoom() {
    var img = contentEl.querySelector('img');
    if (img) {
      img.style.transform = _ovImgTransform();
      img.style.transition = 'transform 0.15s ease';
      _ovApplyImgFilter(img);
      _ovZoomBadge();
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
    _ovZoomBadge();
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

  // ★ 图片专用三按钮——标签恒英文小写 mem/file/path（用户定案：全语言百分百统一、免 i18n）；仅图片预览显示，表格/代码块隐藏
  var memBtn = tbBtn('mem', window._i('shell.overlay.memTitle', '图片进入内存（剪贴板图像），可直接粘贴到聊天或画布'));
  var fileBtn = tbBtn('file', window._i('shell.overlay.fileTitle', '复制图片文件，可粘贴到聊天/Roam/资源管理器'));
  var pathBtn = tbBtn('path', window._i('shell.overlay.pathTitle', '复制图片路径'));

  // ★ 缩放指示钮（内存钮左侧·恒占槽——显/隐零挪位）：用户改过缩放且非 100% 才现，点击回 100% 并复位视图
  var zoomPctBtn = tbBtn('', window._i('shell.overlay.zoomReset', '点击回到 100%'), 'width:66px; padding:8px 0; font-variant-numeric:tabular-nums;');
  zoomPctBtn.setAttribute('data-no-cd', '');
  zoomPctBtn.style.visibility = 'hidden';
  zoomPctBtn.addEventListener('click', function () {
    zoomScale = 1.0;
    _dragX = 0; _dragY = 0;
    applyZoom();
  });
  function _ovZoomBadge() {
    if (!zoomPctBtn) return;
    var vis = _ovZoomTouched && Math.abs(zoomScale - 1) > 0.001;
    zoomPctBtn.style.visibility = vis ? '' : 'hidden';
    if (vis) { zoomPctBtn.textContent = Math.round(zoomScale * 100) + '%'; }
  }

  // 当前 overlay 主体 src（图片）
  function _currentOverlayImgSrc() {
    var img = contentEl.querySelector('img');
    return img ? img.src : null;
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
  function _ovQoast(msg, type) {
    if (window.qqqideQoast) window.qqqideQoast.show(msg, { type: type || 'info', duration: 2500 });
  }

  // ═══ ★ 共享媒体引擎（2026-10-02 单宿主后）：悬浮层只借用「转码工具」（open-image psd/tif 直转码） ═══
  //   媒体播放本体已全部移交独立播放器窗（player/player.html，Roam Q 直开），本文件不再 mount 任何媒体。
  var _ME = null;
  if (window.QQQMediaEngine) {
    _ME = window.QQQMediaEngine.configure({
      bridge: bridge,
      rootEl: overlay,
      i18n: function (k, fb, prm) { return window._i(k, fb, prm); },
      qoast: function (m, o) {
        try {
          var op = (typeof o === 'string') ? { type: o } : (o || {});
          if (!op.duration && !op.action) { op.duration = 2500; }
          if (window.qqqideQoast) { window.qqqideQoast.show(m, op); }
        } catch (_) { }
      },
      onClose: function () { try { close(); } catch (_) { } }
    });
  }
  // ★ 转码工具别名（open-image psd/tif 直转码 + close 清理共用；实现 = 引擎）
  function _ovTxExt(p) { return _ME ? _ME.extOf(p) : ''; }
  function _ovTxRun(f, k, ok, fail) { if (_ME) { _ME.txRun(f, k, ok, fail); } else { try { if (fail) { fail(); } } catch (_) { } } }
  function _ovTxAbort() { try { if (_ME) { _ME.txAbort(); } } catch (_) { } }


  // 内存 — 图片进剪贴板（图像数据），可直接粘贴到聊天/画布
  memBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) { _ovQoast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return; }
    var p = _ovLocalPath || _localPathFromSrc(src);
    var payload = p ? { path: p } : (/^data:/i.test(src) ? { dataUrl: src } : null);
    if (!payload || !bridge || !bridge.clipboard || !bridge.clipboard.writeImage) {
      _ovQoast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeImage(payload).then(function (ok) {
      _ovQoast(ok ? window._i('shell.overlay.memOk', '图片已进入内存，可直接粘贴') : window._i('shell.overlay.copyFailed', '复制失败'), ok ? 'success' : 'error');
    }).catch(function () { _ovQoast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
  });

  // 文件 — 复制图片文件本体（CF_HDROP），可粘贴到聊天/Roam/资源管理器
  fileBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) return;
    var p = _ovLocalPath || _localPathFromSrc(src);
    if (!p) { _ovQoast(window._i('shell.overlay.noLocalFile', '该图片无本地文件，无法复制文件'), 'info'); return; }
    if (!bridge || !bridge.clipboard || !bridge.clipboard.writeFiles) {
      _ovQoast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeFiles([p]).then(function (ok) {
      _ovQoast(ok ? window._i('shell.overlay.fileOk', '文件已复制，可直接粘贴') : window._i('shell.overlay.copyFailed', '复制失败'), ok ? 'success' : 'error');
    }).catch(function () { _ovQoast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
  });

  // 路径 — 复制图片文件路径
  pathBtn.addEventListener('click', function () {
    var src = _currentOverlayImgSrc();
    if (!src) return;
    var p = _ovLocalPath || _localPathFromSrc(src);
    if (!p) {
      if (/^data:/i.test(src)) { _ovQoast(window._i('shell.overlay.noLocalPath', '该图片无本地路径'), 'info'); return; }
      _ovQoast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    if (!bridge || !bridge.clipboard || !bridge.clipboard.writeText) {
      _ovQoast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); return;
    }
    bridge.clipboard.writeText(p).then(function () {
      _ovQoast(window._i('shell.overlay.copied', '已复制'), 'success');
    }).catch(function () { _ovQoast(window._i('shell.overlay.copyFailed', '复制失败'), 'error'); });
  });

  // Zoom out（跳过冷却护盾，准许快速连按）
  var zoomOutBtn = tbBtn('\u2212', window._i('shell.overlay.zoomOut', '缩小'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
  zoomOutBtn.setAttribute('data-no-cd', '');
  zoomOutBtn.addEventListener('click', function () {
    zoomScale = Math.max(_OV_ZOOM_MIN, zoomScale * 0.8);
    _ovZoomTouched = true;
    applyZoom();
  });

  // Zoom in（跳过冷却护盾，准许快速连按）
  var zoomInBtn = tbBtn('+', window._i('shell.overlay.zoomIn', '放大'), 'font-size:20px; font-weight:bold; padding:8px 14px;');
  zoomInBtn.setAttribute('data-no-cd', '');
  zoomInBtn.addEventListener('click', function () {
    zoomScale = Math.min(_OV_ZOOM_MAX, zoomScale * 1.25);
    _ovZoomTouched = true;
    applyZoom();
  });

  // ★ 旋转钮（图片专属；逆/顺 90° 四态循环；抬起执行 + 按住微调——详按住机器；图标 = qqq-icons 手绘 rotate-ccw/cw；无键盘监听）
  var rotLBtn = tbBtn('', window._i('shell.overlay.rotateLeft', '逆时针旋转 90°（按住可微调）'), 'padding:8px 12px;');
  rotLBtn.setAttribute('data-no-cd', '');
  if (window.qqqIcons && window.qqqIcons.el) rotLBtn.appendChild(window.qqqIcons.el('rotate-ccw', 'font-size:18px;pointer-events:none'));
  else rotLBtn.textContent = '\u21BA';
  rotLBtn.addEventListener('pointerdown', function (e) { _ovRotHoldStart(rotLBtn, -1, e); });
  var rotRBtn = tbBtn('', window._i('shell.overlay.rotateRight', '顺时针旋转 90°（按住可微调）'), 'padding:8px 12px;');
  rotRBtn.setAttribute('data-no-cd', '');
  if (window.qqqIcons && window.qqqIcons.el) rotRBtn.appendChild(window.qqqIcons.el('rotate-cw', 'font-size:18px;pointer-events:none'));
  else rotRBtn.textContent = '\u21BB';
  rotRBtn.addEventListener('pointerdown', function (e) { _ovRotHoldStart(rotRBtn, 1, e); });

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
  toolbar.appendChild(zoomPctBtn);
  toolbar.appendChild(memBtn);
  toolbar.appendChild(fileBtn);
  toolbar.appendChild(pathBtn);
  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(rotLBtn);
  toolbar.appendChild(rotRBtn);
  toolbar.appendChild(closeBtnEl);

  overlay.appendChild(contentEl);
  overlay.appendChild(toolbar);

  // ═══ ★ 旋转还原提示（用户定案）：首次对一张图进入角度微调时——工具栏正上方现一行提示 +
  //   十字键房子钮，两者同一动画节奏（_ROT_FLASH_MS/_N）黄色同步闪；每张图仅一次
  //   （app 运行期去重，与旋转记忆同生命周期）；关层即收（详 close）。
  var _ovRotHintSeen = new Set();
  var _ovRotHintWrap = document.createElement('div');
  _ovRotHintWrap.style.cssText = 'display:none; position:absolute; left:0; right:0; bottom:76px; z-index:100001; text-align:center; pointer-events:none;';
  var _ovRotHintPill = document.createElement('span');
  _ovRotHintPill.style.cssText = 'display:inline-block; max-width:80%; background:rgba(0,0,0,0.75); color:#fff; ' +
    'font-size:13px; line-height:1.5; padding:6px 14px; border-radius:14px; border:1px solid rgba(255,255,255,0.2); ' +
    'opacity:0; transition:opacity 0.25s ease;';
  _ovRotHintPill.textContent = window._i('shell.overlay.rotResetHint', '点按右侧十字键中央的房子按钮，可还原到原始角度');
  _ovRotHintWrap.appendChild(_ovRotHintPill);
  overlay.appendChild(_ovRotHintWrap);
  // ★ 黄色闪烁节奏唯一源：提示文字与房子钮同挂同摘、同参数动画（同一同步块起跳 = 永不失步）
  var _ROT_FLASH_MS = 3600, _ROT_FLASH_N = 4;
  var _rotFlashTiming = (_ROT_FLASH_MS / _ROT_FLASH_N / 1000) + 's ease-in-out ' + _ROT_FLASH_N;
  var _ovHintCss = document.createElement('style');
  _ovHintCss.textContent =
    '@keyframes ov-home-hl{0%,100%{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.25);box-shadow:none}' +
    '50%{background:rgba(255,211,1,0.45);border-color:#ffd301;box-shadow:0 0 10px rgba(255,211,1,0.7)}}' +
    '@keyframes ov-rot-hint-flash{0%,100%{color:#fff;border-color:rgba(255,255,255,0.2);box-shadow:none}' +
    '50%{color:#ffd301;border-color:#ffd301;box-shadow:0 0 10px rgba(255,211,1,0.7)}}' +
    '#qqqide-overlay .ov-home-hl{animation:ov-home-hl ' + _rotFlashTiming + ';}' +
    '#qqqide-overlay .ov-rot-hint-flash{animation:ov-rot-hint-flash ' + _rotFlashTiming + ';}';
  document.head.appendChild(_ovHintCss);
  var _ovHintT1 = 0, _ovHintT2 = 0, _ovHomeHlT = 0;
  function _ovRotHintHide() {
    if (_ovHintT1) { clearTimeout(_ovHintT1); _ovHintT1 = 0; }
    if (_ovHintT2) { clearTimeout(_ovHintT2); _ovHintT2 = 0; }
    if (_ovHomeHlT) { clearTimeout(_ovHomeHlT); _ovHomeHlT = 0; }
    _ovRotHintPill.style.opacity = '0';
    _ovRotHintWrap.style.display = 'none';
    try { _ovRotHintPill.classList.remove('ov-rot-hint-flash'); btnCenter.classList.remove('ov-home-hl'); } catch (_) { }
  }
  function _ovRotResetHint() {
    var _k = _ovRotKeyOf(_ovLocalPath);
    if (!_k) { var _s = _currentOverlayImgSrc() || ''; _k = _s ? ('src:' + _s.length + '|' + _s.slice(0, 120)) : ''; }
    if (!_k || _ovRotHintSeen.has(_k)) return;
    _ovRotHintSeen.add(_k);
    if (_ovRotHintSeen.size > 500) { var _fk = _ovRotHintSeen.values().next(); if (!_fk.done) _ovRotHintSeen.delete(_fk.value); }
    _ovRotHintWrap.style.display = 'block';
    _ovRotHintPill.style.opacity = '1';
    if (_ovHintT1) clearTimeout(_ovHintT1);
    if (_ovHintT2) { clearTimeout(_ovHintT2); _ovHintT2 = 0; }
    _ovHintT1 = setTimeout(function () {
      _ovHintT1 = 0;
      _ovRotHintPill.style.opacity = '0';
      _ovHintT2 = setTimeout(function () { _ovHintT2 = 0; _ovRotHintWrap.style.display = 'none'; }, 300);
    }, _ROT_FLASH_MS);
    // 黄闪重放（摘类 → 强制重排 → 挂类）：文字与房子钮同拍挂类 = 同一帧起跳，节奏恒同步
    try {
      _ovRotHintPill.classList.remove('ov-rot-hint-flash');
      btnCenter.classList.remove('ov-home-hl');
      void btnCenter.offsetWidth;
      _ovRotHintPill.classList.add('ov-rot-hint-flash');
      btnCenter.classList.add('ov-home-hl');
    } catch (_) { }
    if (_ovHomeHlT) clearTimeout(_ovHomeHlT);
    _ovHomeHlT = setTimeout(function () { _ovHomeHlT = 0; try { btnCenter.classList.remove('ov-home-hl'); } catch (_) { } }, _ROT_FLASH_MS);
  }

  // ═══ 左右贴边全高翻页钮（翻页唯一控件；nav 缺席/单张 → 隐藏，显隐判据归 _ovNavSync）═══
  function _ovNavBtn(side) {
    var d = document.createElement('div');
    d.style.cssText = 'display:none; position:absolute; top:0; bottom:0; width:48px; z-index:100000; ' +
      (side === 'left' ? 'left:0;' : 'right:0;') +
      ' flex-direction:column; align-items:center; justify-content:center; gap:10px; cursor:pointer; user-select:none; ' +
      'background:rgba(255,255,255,0.04);';
    d.title = window._i(side === 'left' ? 'shell.overlay.prevImage' : 'shell.overlay.nextImage', side === 'left' ? '上一张' : '下一张');
    var ic = null;
    try { if (window.qqqIcons && window.qqqIcons.el) ic = window.qqqIcons.el(side === 'left' ? 'chevron-left' : 'chevron-right'); } catch (_) { }
    if (ic) { ic.style.cssText = 'font-size:24px; color:#fff; pointer-events:none;'; }
    else {
      ic = document.createElement('span');
      ic.textContent = side === 'left' ? '\u2039' : '\u203A';
      ic.style.cssText = 'font-size:30px; color:#fff; line-height:1; pointer-events:none;';
    }
    d.appendChild(ic);
    // ★ 键帽 = q/w（左 q 右 w；百分百复用播放器键帽 class .ovmb-kcap——样式表由 media-engine 注入本窗口）
    var _kc = document.createElement('span');
    _kc.className = 'ovmb-kcap';
    _kc.textContent = side === 'left' ? 'Q' : 'W';
    d.appendChild(_kc);
    d.addEventListener('mouseenter', function () { d.style.background = 'rgba(255,255,255,0.12)'; });
    d.addEventListener('mouseleave', function () { d.style.background = 'rgba(255,255,255,0.04)'; });
    d.addEventListener('click', function (ev) {
      ev.stopPropagation();
      _ovNavStep(side === 'left' ? -1 : 1);
    });
    return d;
  }
  _ovNavLeft = _ovNavBtn('left');
  _ovNavRight = _ovNavBtn('right');
  overlay.appendChild(_ovNavLeft);
  overlay.appendChild(_ovNavRight);
  // 翻到上/下一张（环状）；渲染复用同一条图片直显机（_ovShowImage）
  // ★ 死条目跳过（2026-10-05）：文件被外部删除/移动/损坏 → 标死并顺方向续跳，绝不空转/卡死
  function _ovNavSeek(dir, fromIdx) {
    var list = _ovNav.list, n = list.length;
    for (var i = 1; i <= n - 1; i++) {
      var idx = ((fromIdx + dir * i) % n + n) % n;
      if (!list[idx].dead && list[idx].src) return idx;
    }
    return -1;
  }
  function _ovNavShow(idx) {
    _ovNav.index = idx;
    var it = _ovNav.list[idx] || {};
    _ovShowImage(String(it.src), it.localPath || null, false);
    _ovRotDeg = it.rot || 0;   // ★ 恢复该图旋转（逐张独立记忆；onload 按当前状态显示）
  }
  function _ovNavStep(dir) {
    if (!_ovNav || !_ovNav.list || _ovNav.list.length < 2) return;
    _ovNav.dir = dir;
    var idx = _ovNavSeek(dir, _ovNav.index);
    if (idx < 0) { _ovQoast(window._i('shell.overlay.noMoreImages', '没有更多可显示的图片了'), 'info'); return; }
    _ovNavShow(idx);
  }
  // 图片不可读（加载失败/转码失败/文件已删）→ 序列在场则标死续跳；全死返回 false（交回既有失败收场）
  function _ovNavFail() {
    if (!_ovNav || !_ovNav.list || _ovNav.list.length < 2) return false;
    var cur = _ovNav.list[_ovNav.index];
    if (cur) cur.dead = true;
    _ovNavSkips++;
    var dir = _ovNav.dir || 1;
    var idx = _ovNavSeek(dir, _ovNav.index);
    if (idx >= 0) { _ovNavShow(idx); return true; }
    return false;
  }
  // 翻页钮显隐（唯一判据：序列可用且层可见）
  function _ovNavSync() {
    var vis = !!(_ovNav && _ovNav.list && _ovNav.list.length > 1 && overlay.style.display !== 'none');
    var d = vis ? 'flex' : 'none';
    if (_ovNavLeft && _ovNavLeft.style.display !== d) _ovNavLeft.style.display = d;
    if (_ovNavRight && _ovNavRight.style.display !== d) _ovNavRight.style.display = d;
  }
  // ★ 挂到 #qqq-main + inset:0 → 悬浮城 = 菜单行 + 中区（含中AI面板）+ 状态栏；
  //    左右翼是 #qqq-main 的兄弟节点（shell-wings _applyWings 通过 main 的 left/right 让位）
  //    → 天然不覆盖翼板，100% 等同历史悬浮城区域
  var _mainEl = document.getElementById('qqq-main');
  (_mainEl || document.body).appendChild(overlay);

  // ═══ ★ 焦点接管 + 层状态广播（2026-10-05）════
  // 打开即抢焦点：键盘事件从来源 iframe（Roam/AI 面板）回到本层——来源快捷键不再被误触；
  // 同时向全部 iframe 广播层状态（iframe 侧据此屏蔽自身快捷键，q/w 反向转发回本层翻页）；
  // 关闭即归还焦点给来源元素（回到 Roam 后一切键照旧）。
  var _ovFocusReturn = null;
  function _ovBroadcastState(open) {
    try {
      var _fr = document.querySelectorAll('iframe');
      for (var _fi = 0; _fi < _fr.length; _fi++) {
        try { if (_fr[_fi].contentWindow) _fr[_fi].contentWindow.postMessage({ type: 'qqqide-overlay-state', open: !!open }, '*'); } catch (_) { }
      }
    } catch (_) { }
  }
  function _ovClaimFocus() {
    if (_ovFocusReturn === null) {
      var _ae = document.activeElement;
      _ovFocusReturn = (_ae && _ae !== document.body && _ae !== document.documentElement && typeof _ae.focus === 'function') ? _ae : false;
    }
    try { overlay.focus({ preventScroll: true }); } catch (_) { }
    _ovBroadcastState(true);
  }
  // 全局可见探针（shell.js x 键呈递机器等按需查询；关闭态恒 false）
  window.__qqqOvVisible = function () { return overlay.style.display !== 'none'; };

  function close() {
    // ★ 层关闭：广播解除来源 iframe 屏蔽 + 焦点归还原来源（详 _ovClaimFocus）
    _ovBroadcastState(false);
    try {
      var _ae = document.activeElement;
      var _inOv = _ae && overlay.contains(_ae);
      if (_ovFocusReturn && _ovFocusReturn !== false && _ovFocusReturn.isConnected &&
          typeof _ovFocusReturn.focus === 'function' && (_inOv || _ae === document.body || !_ae)) {
        _ovFocusReturn.focus();
      }
    } catch (_) { }
    _ovFocusReturn = null;
    _ovLocalPath = null;
    _ovNav = null;
    _ovNavSkips = 0;
    _ovImgDispose();
    _ovTablePanMode = false;
    _ovPanDrag = null;
    _ovPanSwallowClick = false;
    try { _stopRepeat(); } catch (_) { }
    try { _ovRotHoldAbort(); } catch (_) { }
    try { _ovTxAbort(); } catch (_) { }
    try { _ovClearHighlights(); } catch (_) { }
    try { _ovRotHintHide(); } catch (_) { }
    _closeTt.style.display = 'none';
    overlay.style.display = 'none';
    dpad.style.display = 'none';
    contentEl.innerHTML = '';
    contentEl.style.overflow = '';
    zoomScale = 1.0;
    _dragX = 0; _dragY = 0;
    _ovRotDeg = 0;
    _ovZoomTouched = false;
    _ovNavSync();
  }


  overlay.addEventListener('click', function (e) {
    // ★ 拖拽平移后紧随的 click 吞掉（mouseup 落点漂移可能命中 overlay 背景 → 防误关层，2026-10-02）
    if (_ovPanSwallowClick) { _ovPanSwallowClick = false; return; }
    if (e.target === overlay) close();
  });

  // ★ Ctrl+C：让浏览器原生处理（tabIndex=-1 防焦点窃取已确保原生复制通路畅通）
  //    不设自定义拦截 — preventDefault 会阻断浏览器维持选区，导致黄色高亮消失
  //    Escape 仍然手动处理
  document.addEventListener('keydown', function (e) {
    if (overlay.style.display === 'none') return;
    if (e.key === 'Escape') { close(); return; }
    // ★ 翻页快捷键 q/w（与钮上键帽同源；层打开期间恒归本层——仅无修饰纯按；输入态让路）
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var _et = e.target;
    if (_et && (_et.tagName === 'INPUT' || _et.tagName === 'TEXTAREA' || _et.isContentEditable)) return;
    var _ek = (e.key || '').toLowerCase();
    if (_ek === 'q' || _ek === 'w') {
      e.preventDefault();
      _ovNavStep(_ek === 'q' ? -1 : 1);
    }
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
    if (e.deltaY < 0) { zoomScale = Math.min(_OV_ZOOM_MAX, zoomScale * 1.15); }
    else { zoomScale = Math.max(_OV_ZOOM_MIN, zoomScale * 0.87); }
    _ovZoomTouched = true;
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
  btnCenter.title = window._i('shell.overlay.resetPosition', '重置位置与角度');
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
  // ★ 房子中键 = 重置视图：位置归零 + 缩放归基准 + 旋转角还原原始（含记忆清零——重开/翻回不再带角度）
  function _resetView() {
    _dragX = 0; _dragY = 0;
    var w = contentEl.querySelector('.qqq-overlay-table-wrapper') || contentEl.querySelector('img');
    if (w) { zoomScale = _initZoom; }
    else { zoomScale = 1.0; }
    if (_ovRotDeg && !_ovTablePanMode) {
      _ovRotDeg = 0;
      _ovRotCommit();
      var _rimg = contentEl.querySelector('img');
      if (_rimg) _ovRefitImg(_rimg);   // 适配盒回未旋转档（90/270 宽高互换还原）
    }
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

  // ── ★ 画布拖拽平移（2026-10-02）：表格/代码块模式——在渲染区（wrapper）之外的暗色区域
  //    按住拖拽即平移整个图层（与图片拖拽同款手感：mousedown 起手 + rAF 合帧 + transform translate）；
  //    渲染区内起手不参与（保持原生文本选择），D-pad 十字键保留不变。
  function _ovPanWrap() { return contentEl.querySelector('.qqq-overlay-table-wrapper'); }
  function _ovPanEnd(sawMouseUp) {
    var d = _ovPanDrag;
    if (!d) return;
    _ovPanDrag = null;
    if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; }
    var w = _ovPanWrap();
    if (w) w.style.transition = 'transform 0.15s ease';
    if (sawMouseUp && d.moved) _ovPanSwallowClick = true;
  }
  contentEl.addEventListener('mousedown', function (ev) {
    if (overlay.style.display === 'none') return;
    if (!_ovTablePanMode || ev.button !== 0) return;
    var t = ev.target;
    if (t && t.closest && (t.closest('.qqq-overlay-table-wrapper') ||
        t.closest('#qqq-ai-overlay-toolbar') || t.closest('button'))) return;
    var w = _ovPanWrap();
    if (!w) return;
    _ovPanSwallowClick = false;
    _ovPanDrag = { sx: ev.clientX, sy: ev.clientY, raf: 0, pending: false, moved: false };
    w.style.transition = 'none';
    ev.preventDefault();   // 防起手拖出全片文本选择
  });
  window.addEventListener('mousemove', function (ev) {
    var d = _ovPanDrag;
    if (!d) return;
    // 拖拽中模式失效 / 按键已在窗口外松开（buttons 归零）→ 收尾
    if (!_ovTablePanMode || (typeof ev.buttons === 'number' && ev.buttons === 0)) { _ovPanEnd(false); return; }
    var dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;   // 微抖不算拖拽（点击语义零变化）
    d.moved = true;
    var s = zoomScale || 1;
    _dragX += dx / s; _dragY += dy / s;
    d.sx = ev.clientX; d.sy = ev.clientY;
    if (!d.pending) {
      d.pending = true;
      d.raf = requestAnimationFrame(function () {
        var dd = _ovPanDrag;
        if (!dd) return;
        dd.pending = false; dd.raf = 0;
        var w2 = _ovPanWrap();
        if (w2) w2.style.transform = 'scale(' + zoomScale + ') translate(' + _dragX + 'px,' + _dragY + 'px)';
      });
    }
  });
  window.addEventListener('mouseup', function () { _ovPanEnd(true); });

  // ═══ 图片直显唯一渲染机（外部消息 / 翻页 / 转码产物回填 共用；防多套实现）═══
  function _ovImgDispose() {
    if (_ovImgCleanup) { try { _ovImgCleanup(); } catch (_) { } _ovImgCleanup = null; }
  }
  function _ovShowImage(src, localPath, isTx) {
    var _gen = ++_ovShowGen;   // 代际令牌：本次调用之外的旧回调一律作废
    // 强制清理上一轮残留（含上一张图的拖拽监听）
    _ovImgDispose();
    // ★ 路径缺省自解码（file:/// → 本地路径）：旋转记忆/文件按钮不依赖调用方传参（防漏传致记忆断链）
    _ovLocalPath = localPath || _localPathFromSrc(src) || null;
    _ovTablePanMode = false;
    _ovPanDrag = null;
    _stopRepeat();
    _ovTxAbort();
    overlay.style.display = 'none';
    contentEl.innerHTML = '';
    contentEl.style.overflow = '';
    zoomScale = 1.0;
    _dragX = 0; _dragY = 0;
    if (!isTx) _ovRotDeg = 0;     // 逐张旋转复位（转码产物回填 = 同图续显，旋转保持）
    if (!isTx) _ovRotHoldAbort(); // 换图 = 终止进行中的按住会话（防微调落到下一张）
    _initZoom = 1.0;              // 图片模式重置基准 = 100%（D-pad 中键「重置位置」同步受益）
    _ovZoomTouched = false;       // 每张图从 100% 起（翻页=重新适配，不带上一张的缩放）
    _ovZoomBadge();
    // ★ 先让 overlay 可见以取得正确容器尺寸，再加载图片（避免缓存图 onload 同步触发时容器尺寸为 0）
    overlay.style.display = 'block';
    contentEl.style.overflow = 'hidden';
    // ★ 直转码组：psd/tif/tiff = Chromium 永不解码 —— 不白试原生 img，直接进 ffmpeg 转码
    //   （其余图片失败兜底仍在 img.onerror 保留）
    var _imgTxEarlyExt = _ovTxExt(_ovLocalPath || '');
    if (!isTx && _ovLocalPath && (_imgTxEarlyExt === '.psd' || _imgTxEarlyExt === '.tif' || _imgTxEarlyExt === '.tiff')) {
      _ovTxRun(_ovLocalPath, 'image', function (newPath) {
        if (_gen !== _ovShowGen) return;                     // 已翻页/已重开：旧转码产物不回抢
        _ovShowImage('file:///' + newPath, newPath, true);   // 产物直载（isTx 防环）
      }, function () {
        if (_gen !== _ovShowGen) return;
        if (_ovNavFail()) return;                            // 翻页序列在场：标死续跳
        _ovQoast(window._i('shell.overlay.loadFailed', '图片加载失败，无法预览'), 'error');
        try { close(); } catch (_) { }
      });
      dpad.style.display = 'block';
      copyBtn.style.display = 'none';
      memBtn.style.display = '';
      fileBtn.style.display = '';
      pathBtn.style.display = '';
      zoomOutBtn.style.display = '';
      zoomInBtn.style.display = '';
      rotLBtn.style.display = '';
      rotRBtn.style.display = '';
      _ovNavSync();
      return;
    }
    // ── 边界适配：尝试 2x 放大，但绝不超出内容区可用空间 ──
    var img = new Image();
    img.onload = function () {
      if (_gen !== _ovShowGen) return;   // 旧图迟到：丢弃（快按翻页仅最后一张生效）
      var nw = img.naturalWidth, nh = img.naturalHeight;
      // 适配盒（旋转感知：90/270 宽高互换；可用空间 = 悬浮城扣除工具栏 64px + 内边距 32px×2；2x 上采样封顶）
      var _fit = _ovFitBox(nw, nh);
      var finalW = _fit.w, finalH = _fit.h;
      img.style.cssText =
        'width:' + finalW + 'px; height:' + finalH + 'px; ' +
        'object-fit:contain; box-shadow:0 4px 32px rgba(0,0,0,0.4); ' +
        'display:block; user-select:none; will-change:transform;';
      img._ovBaseScale = _fit.base;                  // 基础适配倍率（放大裁定基准 = 本值 × zoomScale）
      _ovApplyImgFilter(img);                        // 小图初始上采样同为「原始像素」显示
      contentEl.appendChild(img);
      contentEl.style.overflow = 'visible';
      if (_ovRotDeg) applyZoom();   // ★ 恢复旋转（同帧直设 → 首帧零动画；transition 由此武装）
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
            img.style.transform = _ovImgTransform();
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
      // 监听清理器：下一张图 / 关闭时统一释放（经 _ovImgDispose）
      _ovImgCleanup = function () {
        window.removeEventListener('mousemove', onMM);
        window.removeEventListener('mouseup', onMU);
      };
      // ★ 跳过后落定：如实提示本轮跳过张数（计数归零）
      if (_ovNavSkips > 0) {
        var _skN = _ovNavSkips; _ovNavSkips = 0;
        _ovQoast(window._i('shell.overlay.skipMissing', '已跳过 {0} 张无法显示的图片', { 0: _skN }), 'info');
      }
    };
    // ★ 加载失败兜底：psd/tiff 等 Chromium 不解的图片 → ffmpeg 抽帧 png 再显；再无救才提示关闭
    img.onerror = function () {
      if (_gen !== _ovShowGen) return;   // 旧图迟到：丢弃
      var _ipath = _ovLocalPath || _localPathFromSrc(src);
      var _iext = _ovTxExt(_ipath || '');
      if (!isTx && _ipath && (_iext === '.psd' || _iext === '.tif' || _iext === '.tiff')) {
        _ovTxRun(_ipath, 'image', function (newPath) {
          if (_gen !== _ovShowGen) return;
          _ovShowImage('file:///' + newPath, newPath, true);   // 产物直载（isTx 防环）
        }, function () {
          if (_gen !== _ovShowGen) return;
          if (_ovNavFail()) return;                            // 翻页序列在场：标死续跳
          _ovQoast(window._i('shell.overlay.loadFailed', '图片加载失败，无法预览'), 'error');
          try { close(); } catch (_) { }
        });
        return;
      }
      if (_ovNavFail()) return;                                // 翻页序列在场：标死续跳
      _ovQoast(window._i('shell.overlay.loadFailed', '图片加载失败，无法预览'), 'error');
      try { close(); } catch (_) { }
    };
    img.src = src;
    dpad.style.display = 'block';
    // ★ 图片模式：三按钮（内存/文件/路径），复制按钮隐藏
    copyBtn.style.display = 'none';
    memBtn.style.display = '';
    fileBtn.style.display = '';
    pathBtn.style.display = '';
    zoomOutBtn.style.display = '';
    zoomInBtn.style.display = '';
    rotLBtn.style.display = '';
    rotRBtn.style.display = '';
    _ovNavSync();
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
    // ★ 来源 iframe 反向转发：层打开期间 q/w 落在 Roam/AI 面板 iframe 内 → 统一回到本层翻页
    if (e.data && e.data.type === 'qqqide-overlay-nav') {
      if (overlay.style.display === 'none') return;
      var _nd = Number(e.data.dir);
      if (_nd === 1 || _nd === -1) _ovNavStep(_nd);
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
      // ★ 翻页上下文校验（nav={list:[{src,localPath}],index}）：坏项剔除并校正当前序号；
      //   不足两张 / 序号无效 → 无翻页钮（退化为普通单张预览）
      _ovNav = null;
      _ovNavSkips = 0;
      var _nav = e.data.nav;
      if (_nav && Array.isArray(_nav.list) && _nav.list.length > 1) {
        var _nIdx = (typeof _nav.index === 'number' && _nav.index >= 0 && _nav.index < _nav.list.length) ? _nav.index : -1;
        if (_nIdx >= 0) {
          var _nList = [], _nCur = -1;
          for (var _ni = 0; _ni < _nav.list.length; _ni++) {
            var _it = _nav.list[_ni];
            var _itOk = !!(_it && typeof _it.src === 'string' && _it.src);
            if (_ni === _nIdx) _nCur = _itOk ? _nList.length : -1;
            if (_itOk) { var _ilp = _it.localPath || _localPathFromSrc(_it.src) || null; _nList.push({ src: _it.src, localPath: _ilp, rot: _ovRotGet(_ilp) }); }
          }
          if (_nCur >= 0 && _nList.length > 1) _ovNav = { list: _nList, index: _nCur, dir: 1 };
        }
      }
      _ovShowImage(e.data.src, e.data.localPath || null, false);
      _ovRotDeg = _ovNav ? (_ovNav.list[_ovNav.index].rot || 0) : _ovRotGet(_ovLocalPath);
      _ovClaimFocus();   // 抢焦点 + 广播层状态（来源 iframe 快捷键让路）
    }

    if (e.data.action === 'open-table') {
      _ovLocalPath = null;
      _ovNav = null;   // 表格/代码块无翻页序列
      // ★ 武装画布拖拽平移（渲染区外暗色区域按住拖拽 = 平移整个图层；D-pad 照常）
      _ovTablePanMode = true;
      _ovPanDrag = null;
      _ovPanSwallowClick = false;
      try {
        // 强制清理上一轮残留状态
        _stopRepeat();
        _ovTxAbort();
        overlay.style.display = 'none';
        contentEl.innerHTML = '';
        contentEl.style.overflow = 'hidden';
        zoomScale = 1.0;
        _dragX = 0; _dragY = 0;
        _ovRotDeg = 0;
        _ovZoomTouched = false;

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
        zoomScale = Math.min(_OV_ZOOM_MAX, _initZoom * 1.5625, fitZoom);
        applyZoom();

        overlay.style.visibility = '';
        _ovNavSync();

        clipBox.addEventListener('wheel', function (we) {
          we.preventDefault(); we.stopPropagation();
          if (we.deltaY < 0) { zoomScale = Math.min(_OV_ZOOM_MAX, zoomScale * 1.15); }
          else { zoomScale = Math.max(_OV_ZOOM_MIN, zoomScale * 0.87); }
          _ovZoomTouched = true;
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
        rotLBtn.style.display = 'none';   // 旋转仅属图片模式
        rotRBtn.style.display = 'none';
        _ovClaimFocus();   // 抢焦点 + 广播层状态（来源 iframe 快捷键让路）
      } catch (_) {
        // 出错时强制复位，避免 overlay 残留 invisible 阻挡 UI
        overlay.style.display = 'none';
        overlay.style.visibility = '';
        contentEl.innerHTML = '';
        dpad.style.display = 'none';
        _ovTablePanMode = false;
      }
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
  // 边界兜底：不存在/已删除 → 爬升最近存在祖先 + qoast，绝不静默死链；
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
  // ★ POSIX 绝对路径判定（mac + linux）——Windows 首字符 '/' 维持逐根相对解析
  var _ROAM_WIN = /Win/i.test(String(navigator.platform || ''));
  function _roamPosixAbs(t) { return !_ROAM_WIN && String(t || '').charAt(0) === '/'; }
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
          window.qqqTabs.addGaeaTab('roam', (window.qqqTabs.roamTitle ? window.qqqTabs.roamTitle() : 'Roam'), function (pane) {
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
  // ★ 命令序号裁决（2026-10-03 q395 实锤「连点丢定位」根治）：进入 reveal 流程即取号（先于一切 await——
  //   stat 等待完成先后不可信）；发送时旧号一律作废（绝不覆盖更新的命令）；消息携 seq → roam 侧按号裁决
  //   （旧命令/旧轮询不得回抢最新选择）。无号直调现取号，旧行为不变。
  var _roamCmdTimer = null, _roamCmdToken = 0, _roamCmdSeq = 0, _roamCmdSentSeq = 0;
  function _roamNextSeq() { return ++_roamCmdSeq; }
  function _roamSendCmd(cmd, path, seq) {
    if (!path) return;
    var s = (typeof seq === 'number' && seq > 0) ? seq : _roamNextSeq();
    // ★ 仅按「已发送水位」作废：已有更晚且已发出的命令 → 本条丢弃（旧命令绝不回抢）；
    //   只取号未发送的旧命令（如无效路径仅 qoast）不进水位——不得误伤在途有效命令。
    if (s < _roamCmdSentSeq) { return; }
    if (s > _roamCmdSentSeq) { _roamCmdSentSeq = s; }
    if (_roamCmdTimer) { clearInterval(_roamCmdTimer); _roamCmdTimer = null; }
    _roamEnsureTab();
    var token = ++_roamCmdToken;
    var sent = 0;
    var wasNull = true;
    var timer = null;
    var tick = function () {
      var it = document.querySelector('iframe[src*="q2-roam"]');
      if (it && it.contentWindow) {
        try {
          // iframe 首次出现才抢焦点——旧实现每 300ms focus 一次，7.5s 内反复抢焦点同样在硬控用户
          if (wasNull) { try { it.contentWindow.focus(); } catch (_) { } wasNull = false; }
          it.contentWindow.postMessage({ type: 'qqq-roam-cmd', cmd: cmd, path: path, reqId: token, seq: s }, '*');
        } catch (_) { }
      }
      sent++;
      if (sent >= 25 || _roamCmdToken !== token) {   // 达上限 / 被新命令顶替 → 自清
        clearInterval(timer);
        if (_roamCmdTimer === timer) _roamCmdTimer = null;
      }
    };
    timer = setInterval(tick, 300);
    _roamCmdTimer = timer;
    tick();   // ★ 立即首发（2026-10-03：旧实现首个 300ms 空窗内被新命令打断 = 整条 reveal 静默失效实锤）
  }
  function _roamRevealHit(path, st, seq) {
    if (st && st.isDir) _roamSendCmd('roam.navTo', path, seq);
    else _roamSendCmd('roam.revealFile', path, seq);
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
    var seq = _roamNextSeq();   // ★ 入口即取号（先于一切 await——命令先后 = 进入先后，与 stat 完成顺序无关）
    var r = await _roamResolveHits(text, ctx);
    if (r.err) { _roamQoast(window._i('shell.overlay.roamUnavailable', 'Roam 定位暂不可用，请稍后再试')); return; }
    var orig = String(text || '').trim();
    if (!r.first) { _roamQoast(window._i('shell.overlay.roamNoPath', '该路径无本地文件，无法在 Roam 定位')); return; }
    if (r.hit) { _roamRevealHit(r.hit.path, { isDir: r.hit.isDir }, seq); return; }
    var near = await _roamClimb(r.first);
    if (near) {
      _roamQoast(window._i('shell.overlay.roamMoved', '路径已不存在（可能被移动/删除）：') + _roamShort(orig) + window._i('shell.overlay.roamMoved2', ' → 已定位到最近目录 ') + _roamShort(near.path));
      _roamSendCmd('roam.navTo', near.path, seq);
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
