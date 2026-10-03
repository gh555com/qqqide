// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// drag-text.js — iframe 目标的「外拖文本」提取机（唯一真理源，2026-10-03）
//
// 定位: AI 面板 / inbox（dm）两个 iframe 目标的网页内容拖入共用机——
//   外拖文本（浏览器选区/链接/任意应用）→ 提取纯文本 → 各目标按自身粘贴语义落库
//   （AI 面板 = _insertPlainText 与 Ctrl+V 同一实现；inbox = insertMsgText 同源）。
//   编辑器（主窗口）不走此机: 那是富文本管线（html-paste 转换 + 媒体下载），语义不同（drop-overlay.js）。
//
// 契约:
//   · classify(dataTransfer, internal) → 'files' | 'text' | null
//       Files 恒优先（系统文件/网页图片均可能带 Files）；internal=本 doc 发起的拖拽
//       （原文拖拽/面板图片拖 OS）→ 一律 null（让路原生；本 doc 拖拽不可能含 Files）。
//   · extractText(dataTransfer) → 纯文本（同步；getData 仅 drop 事件可读）
//       优先级 = 粘贴同口径: text/plain → text/uri-list（跳过 # 注释行）→ text/html（兜底段落化）。
//   · installInternalGuard(doc) → isInternal()（dragstart 置位 / dragend·窗口失焦清 / 60s TTL 兜底）
//
// 边界穷举（详铁律 §4.6）:
//   · 本机内部拖拽（含把面板内图片拖去桌面）→ internal → 零接管
//   · 外部文件（含网页图片 blob）→ files 路径（原有语义不变）；纯文本/链接/网页选区 → text 路径
//   · 无文本无文件（自定义 MIME）→ null → 不接管（该载荷原生无导航面）
//   · 链接拖入未接管目标会触发 iframe 默认导航 → 接管目标恒对 uri-list/html preventDefault
//   · dragend 丢事件的理论残窗 = 窗口失焦清 + TTL 60s 兜底（与主窗口 drop-overlay 同款边界）
//
// 加载点: ai-panel/index.html + goods/dm/dm-ui.html（各 iframe 独立加载；浏览器 IIFE + Node 守卫）
// ============================================================================

(function () {
  'use strict';

  var INTERNAL_TTL_MS = 60000;

  function _has(dt, k) {
    try { return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, k) !== -1); } catch (_) { return false; }
  }

  // 拖拽分类（types 判定——dragover 阶段禁用 getData，只能看 types）
  function classify(dt, internal) {
    if (!dt || !dt.types) return null;
    if (_has(dt, 'Files')) return 'files';
    if (internal) return null;
    if (_has(dt, 'text/plain') || _has(dt, 'text/uri-list') || _has(dt, 'text/html')) return 'text';
    return null;
  }

  // uri-list 解析（RFC 2483 简化版: # 注释行 / 空行跳过；多行以 \n 连接）
  function parseUriList(str) {
    if (!str) return '';
    var lines = String(str).split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].replace(/\s+$/, '');
      if (!s) continue;
      if (s.charAt(0) === '#') continue;
      out.push(s);
    }
    return out.join('\n');
  }

  // html → 纯文本（兜底路径: text/plain 与 uri-list 皆空时才用；DOMParser 不加载资源不跑脚本）
  // br/块级元素补换行 → 段落化；连续空行折叠 ≤2；首尾换行剔除（不 trim 行内空白，保 pre 缩进）
  function htmlToText(html) {
    if (!html || typeof DOMParser === 'undefined') return '';
    var doc = null;
    try { doc = new DOMParser().parseFromString(String(html), 'text/html'); } catch (_) { return ''; }
    if (!doc || !doc.body) return '';
    try {
      var brs = doc.body.querySelectorAll('br');
      for (var i = 0; i < brs.length; i++) {
        var br = brs[i];
        if (br.parentNode) br.parentNode.replaceChild(doc.createTextNode('\n'), br);
      }
      var blocks = doc.body.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,blockquote,pre,table,ul,ol,hr');
      for (var j = 0; j < blocks.length; j++) {
        blocks[j].appendChild(doc.createTextNode('\n'));
      }
    } catch (_) { }
    var txt = '';
    try { txt = doc.body.textContent || ''; } catch (_) { return ''; }
    return txt.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }

  // 文本提取（仅 drop 事件可读 getData；优先级 = 粘贴同口径）
  function extractText(dt) {
    if (!dt) return '';
    var t = '';
    try { t = dt.getData('text/plain') || ''; } catch (_) { }
    if (t) return t;
    var ul = '';
    try { ul = dt.getData('text/uri-list') || ''; } catch (_) { }
    if (ul) { var p = parseUriList(ul); if (p) return p; }
    var html = '';
    try { html = dt.getData('text/html') || ''; } catch (_) { }
    if (html) return htmlToText(html);
    return '';
  }

  // 内部拖拽守卫: 本 doc dragstart 置位 → dragend 清（窗口失焦清 + 60s TTL 兜底——防极端丢事件）
  function installInternalGuard(doc) {
    var at = 0;
    var clear = function () { at = 0; };
    var win = null;
    try { win = doc && doc.defaultView; } catch (_) { }
    try {
      doc.addEventListener('dragstart', function () { at = Date.now(); }, true);
      doc.addEventListener('dragend', clear, true);
      if (win) win.addEventListener('blur', clear);
    } catch (_) { }
    return function () { return at > 0 && (Date.now() - at) < INTERNAL_TTL_MS; };
  }

  var API = {
    classify: classify,
    extractText: extractText,
    parseUriList: parseUriList,
    htmlToText: htmlToText,
    installInternalGuard: installInternalGuard
  };

  if (typeof window !== 'undefined') window.qqqDragText = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
