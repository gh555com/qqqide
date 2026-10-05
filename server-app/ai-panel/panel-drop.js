// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// panel-drop.js — AI 面板拖放接收（2026-08-24；2026-10-03 网页文本接管）
//
// 语义（与既有管线对齐）:
//   · 系统文件（types 含 Files）——
//       图片 → 等同直接粘贴 → 多图粘贴管线（串行队列 + 20槽 + 原图直通/越界重编码硬帽）
//       其他文件/文件夹 → 等同 Roam 'a' 键喂给 AI → 📎"path" 锚点插入编辑框（多选按序）
//   · ★ 外拖文本（浏览器选区/链接/任意应用: 无 Files 但有 text/*）——
//       等同在编辑框 Ctrl+V 纯文本（插入机 = _insertPlainText，与粘贴同一实现）：
//       输入框持焦点 → 光标处（有选区则替换）；未持焦点 → 焦点 + 追加末尾；上限截断 qoast 同粘贴。
//       提取机 = core/drag-text.js（唯一真理源：plain → uri-list → html 三级）。
//   · 本面板内部拖拽（原文拖拽/面板图片拖出 OS）→ 零接管（dragstart 守卫让路原生）
//   · 他方输入框为目标（搜索框/改名框）→ 让路原生，不接管
//
// 交互:
//   · 拖入本面板任意位置 → 橙色虚线框覆盖整个面板（= 接收范围）
//   · 外部拖拽一律 preventDefault（防链接/URL 拖入触发 iframe 默认导航）
//   · 无主文件夹时拖入 → 弹文件夹选择（与粘贴守卫同语义）
//
// 依赖: panel-input.js（_enqueuePasteBusy/_pasteImages/_insertPlainText/_hasMainProject/_triggerSelectMainProject）
//       panel-send.js（insertChipAtCursor）
//       ../core/drag-text.js（window.qqqDragText: classify/extractText/installInternalGuard）
// 加载点: ai-panel/index.html（core/drag-text.js 之后、panel-send.js 之后）
// ============================================================================

(function () {
  'use strict';

  // ── 橙色接收框（fixed 覆盖整个 iframe 视口 = 面板接收范围）──
  var _ov = document.createElement('div');
  _ov.id = 'qqq-panel-drop-overlay';
  _ov.style.cssText =
    'position:fixed;left:0;top:0;right:0;bottom:0;display:none;pointer-events:none;' +
    'z-index:999999;border:3px dashed #e07020;border-radius:4px;' +
    'box-shadow:inset 0 0 0 2px rgba(224,112,32,0.12), 0 0 0 2px rgba(224,112,32,0.18);';
  document.body.appendChild(_ov);

  function _showOv() { _ov.style.display = 'block'; }
  function _hideOv() { _ov.style.display = 'none'; }

  // ── 拖拽分类（唯一真理源 core/drag-text.js；脚本缺失降级为旧「仅系统文件」行为）──
  var DT = (typeof window !== 'undefined') ? window.qqqDragText : null;
  var _isInternal = DT ? DT.installInternalGuard(document) : function () { return false; };
  function _classify(e) {
    if (DT) return DT.classify(e.dataTransfer, _isInternal());
    var dt = e.dataTransfer;   // 降级: 无 drag-text.js（半载缓存）→ 仅系统文件（旧行为零回归）
    if (!dt || !dt.types) return null;
    return Array.prototype.indexOf.call(dt.types, 'Files') !== -1 ? 'files' : null;
  }

  // 文本分支例外: 落点是他方输入框（搜索框/改名框等）→ 让路原生，不接管
  function _isForeignEditable(t) {
    if (!t || t === $input) return false;
    var tag = t.tagName ? t.tagName.toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
  }

  // ── 进入/离开计数（防子元素间移动闪烁；离开文档归零）──
  var _depth = 0;
  var _kind = null;
  document.addEventListener('dragenter', function (e) {
    var k = _classify(e);
    if (!k) return;
    _depth++;
    _kind = k;
    if (k === 'text' && _isForeignEditable(e.target)) return;   // 他方输入框: 原生全权（无 preventDefault）
    e.preventDefault();
    _showOv();
  }, true);
  document.addEventListener('dragover', function (e) {
    var k = _classify(e) || _kind;
    if (!k) return;
    if (k === 'text' && _isForeignEditable(e.target)) { _hideOv(); return; }   // 原生全权
    e.preventDefault();      // 允许 drop + 防链接拖入默认导航
    _showOv();
  }, true);
  document.addEventListener('dragleave', function (e) {
    if (!_kind) return;
    _depth--;
    if (_depth <= 0) { _depth = 0; _kind = null; _hideOv(); }
  }, true);

  // 失焦兜底（ALT+TAB 中途取消拖拽可能无 dragleave）
  window.addEventListener('blur', function () { _depth = 0; _kind = null; _hideOv(); });

  // ── drop 总入口：先分类，再按分支执行 ──
  document.addEventListener('drop', function (e) {
    var k = _kind || _classify(e);   // 极少数无 dragenter 的直达 drop 兜底
    _depth = 0;
    _kind = null;
    _hideOv();
    if (!k) return;
    if (k === 'text' && _isForeignEditable(e.target)) return;    // 让路他方输入框（原生 drop）
    e.preventDefault();
    e.stopPropagation();

    var dt = e.dataTransfer;

    // ══ 文本分支: 等同在编辑框 Ctrl+V（插入机与粘贴同源）══
    if (k === 'text') {
      if (!_hasMainProject()) { _triggerSelectMainProject(); return; }   // 与粘贴守卫同语义
      var text = DT ? DT.extractText(dt) : '';
      if (!text) return;   // 空文本载荷 → 定义为 no-op（默认导航已由 preventDefault 封死）
      _enqueuePasteBusy(function () {
        var wasActive = (document.activeElement === $input);
        $input.focus();
        if (!wasActive) {
          try { var L = $input.value.length; $input.setSelectionRange(L, L); } catch (_) { }
        }
        _insertPlainText(text);
      });
      return;
    }

    // ══ 文件分支（原语义不变）══
    if (!dt || !dt.files || dt.files.length === 0) return;
    var files = [];
    for (var i = 0; i < dt.files.length; i++) files.push(dt.files[i]);

    // 无主文件夹 → 与粘贴守卫同语义：弹文件夹选择
    if (!_hasMainProject()) { _triggerSelectMainProject(); return; }

    var imgs = [];
    var others = [];
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      if (f.type && f.type.indexOf('image/') === 0) imgs.push(f);
      else others.push(f);
    }

    // 图片 → 多图粘贴管线（串行保序 + 直通/重编码硬帽；busy 包装：处理期间发送入口拦截）
    if (imgs.length > 0) {
      _enqueuePasteBusy(function () { return _pasteImages(imgs); });
    }

    // 其余（文件/文件夹）→ 📎 锚点喂 AI；stat 判定目录（比扩展名启发式更准；busy 包装同规）
    if (others.length > 0) {
      _enqueuePasteBusy(function () {
        var chain = Promise.resolve();
        others.forEach(function (f) {
          chain = chain.then(function () {
            var p = f.path; // Electron File.path：系统拖入带完整路径
            if (!p) return; // 无完整路径（浏览器拖入）→ 无法喂 AI，跳过
            var b = null;
            try { b = window.parent.qqqideBridge; } catch (_) { }
            if (b && b.fs && b.fs.stat) {
              return b.fs.stat(p).then(function (st) {
                insertChipAtCursor(p, !!(st && st.isDir), null);
              }, function () {
                insertChipAtCursor(p, null, null);
              });
            }
            insertChipAtCursor(p, null, null);
          });
        });
        return chain;
      });
    }
  }, true);
})();
