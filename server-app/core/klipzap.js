// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// klipzap.js — 跨平台中心剪贴板机（唯一真理源）
//
// ★ 真·同步探针：读 e.clipboardData.types（MIME 类型数组），零 IPC，sub-ms。
//   旧 q3 需要 Rust 常驻进程才能探针，现在我们用 DOM API 直接读，更快更简单。
//
// ★ isPureText 铁律（2026-08-01 修）: 只看图/文件，不管 HTML。
//   text/html 是浏览器正常粘贴的标配（网页/Monaco 自身都会带），
//   把它当"非纯文本"会导致纯文字粘贴 global 被封——这是之前 paste 全挂的根因。
//
// 暴露: window.qqqideKlipzap
// ============================================================================

(function () {
  'use strict';

  // ═══ probe(e) — 同步探针（从 ClipboardEvent） ═══
  // 参数: e = ClipboardEvent (paste 事件的 event 对象)
  // 返回: {
  //   hasText, hasHtml, hasImage, hasFile,
  //   imageBlobs: [{ blob, type }],
  //   fileList: [File],     // DOM File 对象（文件名可用，无完整路径）
  //   types: [string],      // MIME 类型数组
  //   isPureText: boolean,  // 纯文本（无图/无文件）—— hasHtml 不参与判定
  // }
  function probe(e) {
    var cb = e && e.clipboardData;
    var result = {
      hasText: false,
      hasHtml: false,
      hasImage: false,
      hasFile: false,
      imageBlobs: [],
      fileList: [],
      types: [],
      isPureText: true,
    };

    if (!cb) return result;

    // ── MIME types (synchronous, always available) ──
    var types = cb.types || [];
    result.types = types.slice();
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      if (t === 'text/plain') result.hasText = true;
      else if (t === 'text/html') result.hasHtml = true;
      else if (t === 'Files') result.hasFile = true;
    }

    // ── items scan (synchronous — getAsFile is sync, blob extraction is sync) ──
    if (cb.items) {
      for (var j = 0; j < cb.items.length; j++) {
        var it = cb.items[j];
        if (it.kind === 'file') {
          var blob = it.getAsFile(); // synchronous — returns File/Blob or null
          if (!blob) continue;
          if (it.type && it.type.indexOf('image/') === 0) {
            result.hasImage = true;
            result.imageBlobs.push({ blob: blob, type: it.type });
          } else {
            result.hasFile = true;
            result.fileList.push(blob);
          }
        } else if (it.kind === 'string') {
          if (it.type === 'text/plain') result.hasText = true;
          else if (it.type === 'text/html') result.hasHtml = true;
        }
      }
    }

    // ── Pure text? ──
    // ★ hasHtml 不参与判定。浏览器粘贴几乎永远带 text/html，若排除它则
    //   所有纯文字 Ctrl+V 都会被当成"非纯文本"→preventDefault→粘贴被封。
    result.isPureText = !result.hasImage && !result.hasFile;

    return result;
  }

  // ═══ pasteType — 返回粘贴类型（用于路由决策） ═══
  function pasteType(e) {
    var p = probe(e);
    if (p.hasFile) return 'file';
    if (p.hasImage) return 'image';
    if (p.hasHtml && p.hasText) return 'html';
    if (p.hasText) return 'text';
    return 'empty';
  }

  window.qqqideKlipzap = {
    probe: probe,
    pasteType: pasteType,
  };

})();
