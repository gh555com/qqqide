// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// panel-drop.js — AI 面板文件拖放接收（2026-08-24）
//
// 语义（与既有管线对齐）:
//   · 图片文件 → 等同直接粘贴 → 多图粘贴管线（串行队列 + 20槽/30MB/4096px 三重硬帽）
//   · 其他文件/文件夹 → 等同 Roam 'a' 键喂给 AI → 📎"path" 锚点插入编辑框（多选按序）
//
// 交互:
//   · 拖入本面板任意位置 → 橙色虚线框覆盖整个面板（= 接收范围）
//   · 无主文件夹时拖入 → 弹文件夹选择（与粘贴守卫同语义）
//
// 依赖: panel-input.js（_enqueuePaste/_pasteImages/_hasMainProject/_triggerSelectMainProject）
//       panel-send.js（insertChipAtCursor）
// 加载点: ai-panel/index.html（panel-send.js 之后）
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

  // ── 只响应系统文件拖拽（types 含 Files），内部文本拖拽零干扰 ──
  function _isFileDrag(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    return Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
  }

  // ── 进入/离开计数（防子元素间移动闪烁；离开文档归零）──
  var _depth = 0;
  document.addEventListener('dragenter', function (e) {
    if (!_isFileDrag(e)) return;
    e.preventDefault();
    _depth++;
    _showOv();
  }, true);
  document.addEventListener('dragover', function (e) {
    if (!_isFileDrag(e)) return;
    e.preventDefault(); // 允许 drop
    _showOv();
  }, true);
  document.addEventListener('dragleave', function (e) {
    if (!_isFileDrag(e)) return;
    _depth--;
    if (_depth <= 0) { _depth = 0; _hideOv(); }
  }, true);

  // 失焦兜底（ALT+TAB 中途取消拖拽可能无 dragleave）
  window.addEventListener('blur', function () { _depth = 0; _hideOv(); });

  // ── drop：图片 → 粘贴管线；其余 → 喂 AI 锚点（多选按序）──
  document.addEventListener('drop', function (e) {
    _depth = 0;
    _hideOv();
    if (!_isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    var dt = e.dataTransfer;
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

    // 图片 → 多图粘贴管线（串行保序 + 三重硬帽）
    if (imgs.length > 0) {
      _enqueuePaste(function () { return _pasteImages(imgs); });
    }

    // 其余（文件/文件夹）→ 📎 锚点喂 AI；stat 判定目录（比扩展名启发式更准）
    if (others.length > 0) {
      _enqueuePaste(function () {
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
