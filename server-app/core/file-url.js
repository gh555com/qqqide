// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// file-url.js — 「本机绝对路径 → file URL」唯一机器
//
// 为什么必须唯一（2026-10-30 实锤）：
//   旧写法到处都是 'file:///' + path。Windows 路径形如 E:/x/a.png，拼出 file:///E:/x/a.png 恰好正确；
//   但 POSIX 绝对路径 /Users/q/a.png 会拼成 file:////Users/q/a.png —— 四个斜杠里第 4 个起被 URL 解析器
//   当成 **authority（主机名）**：Chromium 实测 new URL('file:////Users/q/a b.png').href
//   === 'file://users/q/a%20b.png'（主机 = users，且大小写被归一）。file URL 带非空主机在 POSIX 上
//   一律拒绝加载（只有 Windows 走 UNC 分支）→ mac / Linux 上一切本机媒体（悬浮层图片 / 播放器窗 /
//   相框缩略图 / AI 回答里的本地图）全部打不开。
//   顺带根治：路径里的 # ? % 未转义（# → 被当片段、? → 被当查询、% → 非法转义）——全平台同名坑。
//
// 契约：
//   · 输出恒为「三斜杠」规范式：Windows 盘符 → file:///E:/x/a.png ；POSIX → file:///Users/q/a.png
//   · UNC（\\nas\share\x 或 //nas/share/x）→ file://nas/share/x（主机 = 服务器名）
//   · 已是 file:// URL 的入参原样返回（幂等——调用方可放心重入）
//   · 逐段百分号编码（空格 / 中文 / # ? % 全转义；盘符冒号保留 = 浏览器同款）
// 消费方：codelens / Roam / 悬浮层 / 播放器 / 相框 / A4 / 本地路径链接 / md 预览
// 暴露: window.qqqFileUrl ；单测入口: module.exports
// ============================================================================

(function () {
  'use strict';

  function _encSeg(seg) {
    try {
      // 盘符冒号必须保留（E: → E:），否则 file:///E%3A/… 打不开
      return encodeURIComponent(seg).replace(/%3A/g, ':');
    } catch (e) {
      return seg;
    }
  }

  /**
   * 本机绝对路径 → file URL（唯一入口）
   * @param {string} p 绝对路径（正/反斜杠皆可）或已成的 file:// URL
   * @returns {string} 规范 file URL；空入参返回空串
   */
  function qqqFileUrl(p) {
    var s = (p == null) ? '' : String(p);
    if (!s) return '';
    if (/^file:\/\//i.test(s)) return s;          // 幂等：已是 file URL
    s = s.replace(/\\/g, '/');

    if (s.slice(0, 2) === '//') {                 // UNC：\\server\share\… → file://server/share/…
      var rest = s.slice(2);
      var cut = rest.indexOf('/');
      var host = (cut === -1) ? rest : rest.slice(0, cut);
      var tail = (cut === -1) ? '' : rest.slice(cut);
      return 'file://' + host + tail.split('/').map(_encSeg).join('/');
    }

    // 绝对路径去掉前导斜杠：file:/// 自己已经带了路径首斜杠（这是 POSIX 四斜杠 bug 的根治点）
    var body = s.replace(/^\/+/, '');
    return 'file:///' + body.split('/').map(_encSeg).join('/');
  }

  /**
   * file URL → 本机绝对路径（qqqFileUrl 的唯一逆映射；非 file URL 返回 null）
   *   file:///E:/x/a.png     → E:/x/a.png
   *   file:///Users/q/a.png   → /Users/q/a.png（前导斜杠必须补回——丢了就是相对路径）
   *   file://nas/share/a.png  → //nas/share/a.png
   */
  function qqqFilePathFromUrl(u) {
    var s = (u == null) ? '' : String(u);
    var m = /^file:\/\/([^\/]*)(\/[\s\S]*)$/i.exec(s);
    if (!m) return null;
    var host = m[1], pathPart = m[2], p;
    if (host) { p = '//' + host + pathPart; }
    else if (/^\/[A-Za-z]:\//.test(pathPart)) { p = pathPart.slice(1); }
    else { p = pathPart; }
    try { p = decodeURIComponent(p); } catch (e) { /* 保留原样（非法转义时不解） */ }
    return p;
  }

  try { window.qqqFileUrl = qqqFileUrl; window.qqqFilePathFromUrl = qqqFilePathFromUrl; } catch (e) { /* Node 单测环境（无 window） */ }
  // 单测入口（ci/tests/file-url.test.js）；浏览器里 module 不存在，恒不执行
  try {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = qqqFileUrl;
      module.exports.filePathFromUrl = qqqFilePathFromUrl;
    }
  } catch (e2) { /* */ }

})();
