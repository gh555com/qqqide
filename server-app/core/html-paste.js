// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// html-paste.js — 网页/富文本粘贴转换机（老 q3 SmartPaste + h.js 100% 语义移植）
//
// 定位: 剪贴板 text/html → 结构化 blocks（文本 + 媒体）+ 方案自动裁决。
//   · 方案 2（DOM→结构化文本）: 标题/列表/表格/链接/加粗/代码块 → 文本；img/video → media 块
//   · 方案 1（纯文本流 zip）: 用 text/plain 清洗文本与 DOM 结构做锚点对齐（顽固乱码修复）
//   · 质量信号: 编码置信度(乱码比) / HTML 完整性(断标签) / 纯文本对齐(三锚点命中)
//   · forceTextFlowScheme → 强制方案 1；方案 2 质量不合格自动回退方案 1
//   · 视频 URL 抽取: video/source/iframe + 脚本内 JSON（老 q3 extractVideoUrlsFromHtmlFragment）
//
// 消费方唯一入口 = paste-router.js 第 7 步（网页粘贴）；下载/落盘/锚点由 paste-router 编排。
//
// 暴露: window.qqqHtmlPaste
//   process(html, plainText, opts) → { blocks, scheme, meta } | null
//   extractVideoUrls(html, baseUrl) → string[]
//   looksLikeMarkdown(text) → boolean
//   blocks = [{type:'text', text} | {type:'media', kind:'image'|'video', src, status:'pending'}]
// ============================================================================

(function () {
  'use strict';

  var MAX_HTML_CHARS = 4 * 1024 * 1024;   // 剪贴板 HTML 上限（防巨型页面卡死）
  var MAX_EXTRACTED_VIDEOS = 30;          // 视频 URL 抽取上限（防 SPA 页面噪声洪峰）

  // ═══ 通用工具 ═══

  function _normInline(s) {
    return String(s == null ? '' : s)
      .replace(/\u00A0/g, ' ')
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/ *\n */g, '\n')
      .trim();
  }

  function _resolveUrl(raw, baseUrl) {
    raw = String(raw == null ? '' : raw).trim().replace(/^["']+|["']+$/g, '');
    if (!raw) return '';
    if (/^data:/i.test(raw)) return raw;
    if (/^https?:/i.test(raw)) return raw;
    if (raw.indexOf('//') === 0) return 'https:' + raw;
    if (/^(file|blob|about|cid|javascript|mailto|tel):/i.test(raw)) return raw;
    try {
      if (baseUrl) return new URL(raw, baseUrl).href;
    } catch (_) { /* */ }
    return raw;
  }

  function _firstSrcsetUrl(srcset) {
    var s = String(srcset || '');
    if (!s) return '';
    var first = s.split(',')[0] || '';
    first = first.trim().split(/\s+/)[0] || '';
    if (!first || /^data:/i.test(first)) return '';
    return first;
  }

  // ── 媒体源拾取（老 q3 img 属性链 + Win11 srcset 兜底）──
  function _pickImgSrc(el, baseUrl) {
    var chain = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url'];
    for (var i = 0; i < chain.length; i++) {
      var v = el.getAttribute(chain[i]);
      if (v) {
        v = String(v).trim();
        if (v && !/^javascript:/i.test(v)) return _resolveUrl(v, baseUrl);
      }
    }
    var first = _firstSrcsetUrl(el.getAttribute('srcset') || el.getAttribute('data-srcset'));
    if (first) return _resolveUrl(first, baseUrl);
    return '';
  }

  function _pickPictureSrc(el, baseUrl) {
    var img = el.querySelector && el.querySelector('img');
    if (img) {
      var s = _pickImgSrc(img, baseUrl);
      if (s) return s;
    }
    var sources = el.querySelectorAll ? el.querySelectorAll('source') : [];
    for (var i = 0; i < sources.length; i++) {
      var first = _firstSrcsetUrl(sources[i].getAttribute('srcset'));
      if (first) return _resolveUrl(first, baseUrl);
      var srcAttr = sources[i].getAttribute('src');
      if (srcAttr) return _resolveUrl(srcAttr, baseUrl);
    }
    return '';
  }

  function _pickVideoSrc(el, baseUrl) {
    var v = el.getAttribute('src') || el.getAttribute('data-src');
    if (v) return _resolveUrl(v, baseUrl);
    var sources = el.querySelectorAll ? el.querySelectorAll('source') : [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i].getAttribute('src');
      if (s) return _resolveUrl(s, baseUrl);
    }
    return '';
  }

  // ═══ 视频 URL 判定（老 q3 dow.js isPlatformOrSegmentVideo + 关键词过滤）═══
  var _PLATFORM_RES = [
    /youtube\.com|youtu\.be/i,
    /bilibili\.com|b23\.tv/i,
    /twitter\.com|x\.com/i,
    /vimeo\.com/i,
    /dailymotion\.com/i,
    /tiktok\.com|douyin\.com/i,
    /weibo\.com/i,
    /\.m3u8(\?|$)/i,
    /\.mpd(\?|$)/i,
  ];
  function _isPlatformOrSegmentVideo(url) {
    var s = String(url || '');
    for (var i = 0; i < _PLATFORM_RES.length; i++) if (_PLATFORM_RES[i].test(s)) return true;
    return false;
  }
  // iframe/embed 噪声过滤：仅视频平台 / 播放器特征 URL 作为视频候选（防广告 iframe 洪峰）
  function _isLikelyVideoEmbed(url) {
    var s = String(url || '');
    if (_isPlatformOrSegmentVideo(s)) return true;
    return /video|player|embed|watch/i.test(s);
  }

  // ═══ 质量信号（老 q3 三件套移植）═══
  function _checkHtmlIntegrity(htmlText) {
    var s = String(htmlText || '');
    if (!s) return 0;
    var brokenClose = (s.match(/[\?\uFFFD]\/[a-z]{1,12}\s*>/gi) || []).length;
    var brokenOpen = (s.match(/[\?\uFFFD][a-z]{1,12}[\s>]/gi) || []).length;
    var total = (s.match(/<\/?[a-z]{1,12}/gi) || []).length;
    if (total === 0) return 0.5;
    var ratio = (brokenClose + brokenOpen) / total;
    return Math.max(0, 1 - ratio * 5);
  }

  function _detectEncodingConfidence(text) {
    var s = String(text || '');
    if (!s.length) return 0;
    var bad = (s.match(/\uFFFD/g) || []).length;
    var moji = (s.match(/[\u00C0-\u00C3][\u0080-\u00BF\u00A0-\u017F]/g) || []).length; // Ã¤ / Â» 系乱码
    var qruns = (s.match(/\?{3,}/g) || []).length;
    var badRatio = (bad + moji * 2) / s.length;
    var score = 1 - Math.min(1, badRatio * 40);
    score -= Math.min(0.4, qruns * 0.08);
    return Math.max(0, Math.min(1, score));
  }

  // ═══ 乱码回修机（编码检测增强：UTF-8 字节被当 latin1/cp1252 解码的文本还原）═══
  //   适用: 剪贴板来源把 UTF-8 字节逐字节当西欧字符抛出（Ã© / ä½ å¥½ / ðŸ˜€ 系）。
  //   接受条件: 全串可反映射为字节 + 严格 UTF-8 解码成功 + 乱码签名计数必须下降（否则原样返回）。
  var _CP1252_REV = {
    '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84, '\u2026': 0x85,
    '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88, '\u2030': 0x89, '\u0160': 0x8A,
    '\u2039': 0x8B, '\u0152': 0x8C, '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92,
    '\u201C': 0x93, '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
    '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B, '\u0153': 0x9C,
    '\u017E': 0x9E, '\u0178': 0x9F
  };
  function _mojiScore(s) {
    return (String(s).match(/[\u00C0-\u00FF]/g) || []).length;
  }
  function _mojiToBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code <= 0xFF) { out[i] = code; continue; }
      var b = _CP1252_REV[s.charAt(i)];
      if (b === undefined) return null;   // 含真正非 latin1 字符（CJK 等）→ 不可能同源
      out[i] = b;
    }
    return out;
  }
  function repairMojibake(text) {
    var s = String(text == null ? '' : text);
    if (!s || s.length < 4) return s;
    if (!/[\u00C0-\u00FF]/.test(s)) return s;
    var bytes = _mojiToBytes(s);
    if (!bytes) return s;
    var dec = '';
    try { dec = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { return s; }
    if (!dec || dec === s) return s;
    if (_mojiScore(dec) >= _mojiScore(s)) return s;
    return dec;
  }

  function _checkPlainTextAlignment(root, plainText) {
    try {
      if (!plainText) return false;
      var textContent = String(root.textContent || '').trim();
      if (textContent.length < 10) return true;
      var anchors = [
        textContent.substring(0, 20),
        textContent.substring(Math.floor(textContent.length / 2), Math.floor(textContent.length / 2) + 20),
        textContent.substring(Math.max(0, textContent.length - 20)),
      ].map(function (x) { return x.replace(/\s+/g, ' ').trim(); }).filter(function (x) { return x.length > 5; });
      if (!anchors.length) return true;
      var hit = 0;
      for (var i = 0; i < anchors.length; i++) if (plainText.indexOf(anchors[i]) >= 0) hit++;
      return hit >= Math.min(anchors.length, 2);
    } catch (_) { return false; }
  }

  function _acceptable(blocks) {
    if (!blocks || !blocks.length) return false;
    var all = '';
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].type === 'text') all += (blocks[i].text || '');
    }
    if (!all.length) return true;
    var bad = (all.match(/\uFFFD/g) || []).length;
    var q = (all.match(/\?{3,}/g) || []).length;
    return (bad / all.length) < 0.05 && q < 3;
  }

  // ═══ Markdown 检测（老 q3 _looksLikeMarkdown：纯文本含 Markdown 符号 + HTML 无媒体时优先纯文本）═══
  function looksLikeMarkdown(text) {
    if (!text || text.length < 3) return false;
    if (/^#{1,6}\s+\S/m.test(text) || /^---\s*$/m.test(text) || /^\*\*\*\s*$/m.test(text) || /^```/m.test(text)) return true;
    var pats = [
      /^\s*[-*+]\s+\S/m,
      /^\s*\d+\.\s+\S/m,
      /^\s*>\s+\S/m,
      /^___\s*$/m,
      /\*\*[^*]+\*\*/,
      /\*[^*]+\*/,
      /`[^`]+`/,
      /\[([^\]]+)\]\(([^)]+)\)/,
      /!\[([^\]]*)\]\(([^)]+)\)/,
    ];
    var n = 0;
    for (var i = 0; i < pats.length; i++) if (pats[i].test(text)) n++;
    return n >= 2;
  }

  // ═══ DOM 清洗（脚本/样式/表单交互件移除；SVG 保留只取文本由 walker 处理）═══
  function _scrub(root) {
    var kill = root.querySelectorAll('script, style, noscript, template, link, meta, title, form, input, button, textarea, select, option');
    for (var i = kill.length - 1; i >= 0; i--) {
      var el = kill[i];
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  }

  // ═══ 方案 2: DOM → 结构化文本 blocks（标题/列表/表格/引用/代码块/链接/加粗 + 媒体）═══

  var _MA = '\uE000';
  var _MB = '\uE001';

  function _inline(node, baseUrl, mediaBag) {
    // 返回含媒体占位符 \uE000n\uE001 的内联字符串
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    var tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return '';
    if (tag === 'br') return '\n';
    if (tag === 'img') {
      var s = _pickImgSrc(node, baseUrl);
      if (s) { mediaBag.push({ kind: 'image', src: s }); return _MA + (mediaBag.length - 1) + _MB; }
      return '';
    }
    if (tag === 'picture') {
      var ps = _pickPictureSrc(node, baseUrl);
      if (ps) { mediaBag.push({ kind: 'image', src: ps }); return _MA + (mediaBag.length - 1) + _MB; }
      return '';
    }
    if (tag === 'video' || tag === 'audio') {
      var vs = _pickVideoSrc(node, baseUrl);
      if (vs) { mediaBag.push({ kind: 'video', src: vs }); return _MA + (mediaBag.length - 1) + _MB; }
      return '';
    }
    if (tag === 'iframe' || tag === 'embed') {
      var is = _resolveUrl(node.getAttribute('src'), baseUrl);
      if (is && _isLikelyVideoEmbed(is)) { mediaBag.push({ kind: 'video', src: is }); return _MA + (mediaBag.length - 1) + _MB; }
      return '';
    }
    if (tag === 'svg' || tag === 'canvas') return '';
    var inner = '';
    var ch = node.childNodes;
    for (var i = 0; i < ch.length; i++) inner += _inline(ch[i], baseUrl, mediaBag);
    switch (tag) {
      case 'strong': case 'b': return inner.trim() ? '**' + inner + '**' : inner;
      case 'em': case 'i': return inner.trim() ? '*' + inner + '*' : inner;
      case 'del': case 's': case 'strike': return inner.trim() ? '~~' + inner + '~~' : inner;
      case 'code': return inner.trim() ? '`' + inner + '`' : inner;
      case 'a': {
        var href = _resolveUrl(node.getAttribute('href'), baseUrl);
        if (href && !/^javascript:/i.test(href) && inner.trim()) {
          if (href === inner.trim()) return inner;
          return '[' + inner + '](' + href + ')';
        }
        return inner;
      }
      case 'sup': case 'sub': case 'u': case 'mark': case 'small': case 'big': case 'font':
        return inner;
      default:
        return inner;
    }
  }

  // 把含占位符的内联串拆成 [文本|媒体] block 序列；firstPrefix 用于列表标记
  function _emitInline(s, mediaBag, out, firstPrefix) {
    var re = new RegExp(_MA + '(\\d+)' + _MB, 'g');
    var last = 0, m, first = true;
    function pushText(t) {
      t = _normInline(t);
      if (!t) return;
      if (first && firstPrefix) { t = firstPrefix + t; first = false; }
      out.push({ type: 'text', text: t });
    }
    while ((m = re.exec(s)) !== null) {
      pushText(s.slice(last, m.index));
      var item = mediaBag[parseInt(m[1], 10)];
      if (item) out.push({ type: 'media', kind: item.kind, src: item.src, status: 'pending' });
      last = m.index + m[0].length;
    }
    pushText(s.slice(last));
  }

  function _isBlockTag(tag) {
    return /^(p|div|section|article|header|footer|main|aside|nav|figure|figcaption|table|ul|ol|li|blockquote|pre|h[1-6]|hr|dl|dt|dd|center|address|details|summary|fieldset)$/.test(tag);
  }

  function _walkBlock(el, baseUrl, out, ctx) {
    var tag = el.tagName.toLowerCase();
    var mediaBag = [];

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        var s = _inline(el, baseUrl, mediaBag);
        _emitInline('#' + new Array(parseInt(tag.charAt(1), 10) + 1).join('#') + ' ' + s, mediaBag, out);
        return;
      }
      case 'ul': case 'ol': {
        _walkList(el, baseUrl, out, ctx, 0);
        return;
      }
      case 'blockquote': {
        var sub = [];
        _walkChildren(el, baseUrl, sub, ctx);
        for (var i = 0; i < sub.length; i++) {
          if (sub[i].type === 'text') {
            sub[i].text = sub[i].text.split('\n').map(function (ln) { return ln ? '> ' + ln : '>'; }).join('\n');
          }
          out.push(sub[i]);
        }
        return;
      }
      case 'pre': {
        var raw = String(el.textContent || '').replace(/\r\n?/g, '\n').replace(/[\u200B\uFEFF]/g, '');
        raw = raw.replace(/\n+$/, '');
        if (raw.trim()) {
          var lang = '';
          var langSrc = (el.getAttribute('class') || '') + ' ' + (el.querySelector('code') ? (el.querySelector('code').getAttribute('class') || '') : '');
          var lm = /(?:language|lang|highlight-source)-([a-z0-9#+._-]{1,20})/i.exec(langSrc);
          if (lm) lang = lm[1];
          out.push({ type: 'text', text: '```' + lang + '\n' + raw + '\n```' });
        }
        return;
      }
      case 'hr':
        out.push({ type: 'text', text: '---' });
        return;
      case 'table': {
        _walkTable(el, baseUrl, out);
        return;
      }
      case 'figure': case 'figcaption': case 'dl': case 'dt': case 'dd':
      case 'p': case 'li': case 'div': case 'section': case 'article': case 'header': case 'footer':
      case 'main': case 'aside': case 'nav': case 'center': case 'address': case 'details': case 'summary':
      case 'fieldset':
      default: {
        // 含块级子元素 → 递归；纯内联 → 当作段落
        var hasBlock = false;
        var ch = el.childNodes;
        for (var j = 0; j < ch.length; j++) {
          if (ch[j].nodeType === 1 && _isBlockTag(ch[j].tagName.toLowerCase()) && !/^(a|span|em|strong|b|i|code|img|br|small|sub|sup|u|mark)$/.test(ch[j].tagName.toLowerCase())) { hasBlock = true; break; }
        }
        if (hasBlock) {
          _walkChildren(el, baseUrl, out, ctx);
        } else {
          var ps = _inline(el, baseUrl, mediaBag);
          _emitInline(ps, mediaBag, out);
        }
        return;
      }
    }
  }

  function _walkChildren(el, baseUrl, out, ctx) {
    var ch = el.childNodes;
    for (var i = 0; i < ch.length; i++) {
      var n = ch[i];
      if (n.nodeType === 3) {
        var t = _normInline(n.nodeValue);
        if (t) out.push({ type: 'text', text: t });
      } else if (n.nodeType === 1) {
        var tag = n.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
        if (tag === 'img' || tag === 'picture' || tag === 'video' || tag === 'audio' || tag === 'iframe' || tag === 'embed') {
          var mb = [];
          var s = _inline(n, baseUrl, mb);
          _emitInline(s, mb, out);
          continue;
        }
        if (_isBlockTag(tag)) {
          _walkBlock(n, baseUrl, out, ctx);
        } else {
          // 块级位置上的内联元素 → 段落
          var mb2 = [];
          var s2 = _inline(n, baseUrl, mb2);
          _emitInline(s2, mb2, out);
        }
      }
    }
  }

  function _walkList(el, baseUrl, out, ctx, depth) {
    var ordered = el.tagName.toLowerCase() === 'ol';
    var idx = 1;
    var li = el.children;
    for (var i = 0; i < li.length; i++) {
      if (li[i].tagName.toLowerCase() !== 'li') continue;
      var prefix = new Array(depth + 1).join('  ') + (ordered ? (idx + '. ') : '- ');
      idx++;
      // li 内：先内联文本（除嵌套列表），再递归嵌套列表
      var mb = [];
      var s = '';
      var ch = li[i].childNodes;
      for (var j = 0; j < ch.length; j++) {
        if (ch[j].nodeType === 1 && (ch[j].tagName.toLowerCase() === 'ul' || ch[j].tagName.toLowerCase() === 'ol')) continue;
        s += _inline(ch[j], baseUrl, mb);
      }
      _emitInline(s, mb, out, prefix);
      for (var k = 0; k < ch.length; k++) {
        if (ch[k].nodeType === 1 && (ch[k].tagName.toLowerCase() === 'ul' || ch[k].tagName.toLowerCase() === 'ol')) {
          _walkList(ch[k], baseUrl, out, ctx, depth + 1);
        }
      }
    }
  }

  function _walkTable(el, baseUrl, out) {
    var rows = el.querySelectorAll('tr');
    if (!rows.length) return;
    var lines = [];
    var mediaAfter = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('th, td');
      if (!cells.length) continue;
      var arr = [];
      for (var j = 0; j < cells.length; j++) {
        var mb = [];
        var s = _normInline(_inline(cells[j], baseUrl, mb)).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
        // 单元格内媒体 → 表格后附媒体块（Markdown 表格容不下媒体）
        for (var q = 0; q < mb.length; q++) mediaAfter.push(mb[q]);
        arr.push(s);
      }
      lines.push('| ' + arr.join(' | ') + ' |');
      if (i === 0) {
        var sep = [];
        for (var k = 0; k < arr.length; k++) sep.push('---');
        lines.push('| ' + sep.join(' | ') + ' |');
      }
    }
    if (lines.length) out.push({ type: 'text', text: lines.join('\n') });
    for (var w = 0; w < mediaAfter.length; w++) {
      out.push({ type: 'media', kind: mediaAfter[w].kind, src: mediaAfter[w].src, status: 'pending' });
    }
  }

  function _buildBlocks(root, baseUrl) {
    var out = [];
    _walkChildren(root, baseUrl, out, {});
    // 后处理: 去空 / 合并连续空行
    var cleaned = [];
    for (var i = 0; i < out.length; i++) {
      var b = out[i];
      if (b.type === 'text') {
        var t = _normInline(b.text);
        // 保留代码块/表格内部结构（_normInline 已归一但保留 \n）
        if (!t) continue;
        if (b.text.indexOf('```') === 0) t = b.text;   // 代码块原文（含缩进）
        if (cleaned.length && cleaned[cleaned.length - 1].type === 'text') {
          var prev = cleaned[cleaned.length - 1];
          if (prev.text === t) continue;               // 相邻重复文本去重（常见于嵌套容器）
          prev.text += '\n' + t;
        } else {
          cleaned.push({ type: 'text', text: t });
        }
      } else {
        cleaned.push(b);
      }
    }
    return cleaned.length ? cleaned : [{ type: 'text', text: '' }];
  }

  // ═══ 方案 1: 纯文本流 zip（老 q3 _zipDomWithCleanText 移植）═══

  function _zipWithCleanText(root, cleanText, baseUrl) {
    var blocks = [];
    var flat = [];

    (function structural(n) {
      if (n.nodeType === 3) {
        var t = n.nodeValue;
        if (t && t.length) flat.push({ t: 'text', c: t });
      } else if (n.nodeType === 1) {
        var tag = n.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
        if (tag === 'img') {
          var s = _pickImgSrc(n, baseUrl);
          if (s) flat.push({ t: 'media', kind: 'image', src: s });
          return;
        }
        if (tag === 'picture') {
          var ps = _pickPictureSrc(n, baseUrl);
          if (ps) flat.push({ t: 'media', kind: 'image', src: ps });
          return;
        }
        if (tag === 'video' || tag === 'audio') {
          var vs = _pickVideoSrc(n, baseUrl);
          if (vs) flat.push({ t: 'media', kind: 'video', src: vs });
          return;
        }
        if (tag === 'iframe' || tag === 'embed') {
          var is = _resolveUrl(n.getAttribute('src'), baseUrl);
          if (is && _isLikelyVideoEmbed(is)) flat.push({ t: 'media', kind: 'video', src: is });
          return;
        }
        var ch = n.childNodes;
        for (var i = 0; i < ch.length; i++) structural(ch[i]);
      }
    })(root);

    cleanText = String(cleanText || '');
    var textCursor = 0;

    function getSmartAnchor(str, startFrom, len) {
      startFrom = startFrom || 0; len = len || 10;
      if (str.length <= len) return { text: str, offset: 0 };
      var sub = str.substring(startFrom);
      var match = /[\p{L}\p{N}]{4,}/u.exec(sub);
      if (match) {
        var safeLen = Math.min(match[0].length, len);
        return { text: match[0].substring(0, safeLen), offset: startFrom + match.index };
      }
      return { text: str.substring(startFrom, startFrom + len), offset: startFrom };
    }

    for (var i = 0; i < flat.length; i++) {
      var node = flat[i];
      if (node.t === 'media') {
        blocks.push({ type: 'media', kind: node.kind, src: node.src, status: 'pending' });
        continue;
      }
      var htmlContent = node.c;
      if (htmlContent == null) continue;
      var trimmed = String(htmlContent).trim();
      if (!trimmed) {
        // 空白文本节点：仅当 plain 同位也是空白时吞掉对应空白
        var wsM = cleanText.slice(textCursor).match(/^\s+/);
        if (wsM && htmlContent.length < 5) {
          var cur = cleanText.slice(textCursor, textCursor + htmlContent.length);
          if (/^\s+$/.test(cur)) {
            blocks.push({ type: 'text', text: cur });
            textCursor += cur.length;
          }
        }
        continue;
      }
      if (textCursor >= cleanText.length) continue;

      var windowSize = trimmed.length < 10 ? 60 : (trimmed.length < 50 ? 200 : Math.min(trimmed.length * 1.5 + 100, 600));
      var searchArea = cleanText.slice(textCursor, textCursor + windowSize);

      var startAnchor = getSmartAnchor(trimmed, 0, 10);
      var idx = searchArea.indexOf(startAnchor.text);
      var matchedOffset = startAnchor.offset;
      if (idx === -1 && trimmed.length > 20) {
        var second = getSmartAnchor(trimmed, Math.floor(trimmed.length / 3), 10);
        var idx2 = searchArea.indexOf(second.text);
        if (idx2 !== -1) { idx = idx2; matchedOffset = second.offset; }
      }

      if (idx !== -1) {
        var blockStartRel = idx - matchedOffset;
        if (blockStartRel < 0) blockStartRel = 0;
        if (blockStartRel > 0) {
          blocks.push({ type: 'text', text: searchArea.substring(0, blockStartRel) });
          textCursor += blockStartRel;
        }
        // 尾锚点
        var endAnchor;
        var tailLimit = 150;
        var tailStart = Math.max(0, trimmed.length - tailLimit);
        var tailStr = trimmed.substring(tailStart);
        if (tailStr.length >= 15) endAnchor = { text: tailStr.substring(tailStr.length - 15), offset: tailStart + tailStr.length - 15 };
        else if (tailStr.length >= 8) endAnchor = { text: tailStr.substring(tailStr.length - 8), offset: tailStart + tailStr.length - 8 };
        else endAnchor = { text: trimmed.substring(Math.max(0, trimmed.length - 10)), offset: Math.max(0, trimmed.length - 10) };

        var maxLen = trimmed.length * 1.5 + 20;
        var contentArea = cleanText.slice(textCursor, textCursor + maxLen);
        var contentLen = 0;
        if (trimmed.length < 5) {
          contentLen = trimmed.length;
        } else {
          var subIdx = contentArea.lastIndexOf(endAnchor.text);
          if (subIdx !== -1) {
            contentLen = subIdx + endAnchor.text.length;
          } else if (endAnchor.text.length > 4) {
            var shortAnchor = endAnchor.text.substring(endAnchor.text.length - 4);
            var subIdx2 = contentArea.lastIndexOf(shortAnchor);
            contentLen = subIdx2 !== -1 ? subIdx2 + shortAnchor.length : trimmed.length;
          } else {
            contentLen = trimmed.length;
          }
        }
        if (contentLen > contentArea.length) contentLen = contentArea.length;
        if (contentLen < 0) contentLen = 0;
        blocks.push({ type: 'text', text: cleanText.substr(textCursor, contentLen) });
        textCursor += contentLen;
      } else {
        var safeLen = Math.min(htmlContent.length, cleanText.length - textCursor);
        if (safeLen > 0) {
          blocks.push({ type: 'text', text: cleanText.substr(textCursor, safeLen) });
          textCursor += safeLen;
        }
      }
    }
    if (textCursor < cleanText.length) {
      blocks.push({ type: 'text', text: cleanText.substring(textCursor) });
    }
    return blocks.length ? blocks : [{ type: 'text', text: '' }];
  }

  // ═══ 视频 URL 抽取（老 q3 extractVideoUrlsFromHtmlFragment：DOM 扫描 + 脚本 JSON 扫描）═══
  var _VIDEO_EXT_RE = /\.(mp4|webm|ogg|mov|avi|m4v|flv|mkv|m3u8|mpd)(\?|$)/i;

  // 脚本文本 → 视频 URL 列表（纯函数；独立化便于单测——与 extractVideoUrls 同语义）
  function scanScriptText(sc, baseUrl) {
    var out = [];
    var seen = {};
    function push(u) {
      if (!u || seen[u] || out.length >= MAX_EXTRACTED_VIDEOS) return;
      seen[u] = 1;
      out.push(u);
    }
    sc = String(sc == null ? '' : sc).replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
    if (!sc || sc.length > 800000) return out;
    var keys = ['play_url', 'video_url', 'playUrl', 'videoUrl', 'mp4', 'm3u8'];
    var keyRe = new RegExp('(' + keys.join('|') + ')[^:="\']*[:="\']+\\s*["\']?(https?://[^"\']+)["\']?', 'gi');
    var genRe = /https?:\/\/[^\s"'<>()\[\]{}]+?\.(mp4|webm|ogg|mov|avi|m4v|flv|mkv|m3u8|mpd)[^\s"'<>()\[\]{}]*(\?[\w\-._~:?#[\]@!$&'()*+,;=%]*)?/gi;
    var km;
    keyRe.lastIndex = 0;
    while ((km = keyRe.exec(sc)) !== null) {
      var pot = km[2];
      if (pot && (_VIDEO_EXT_RE.test(pot) || /video/i.test(pot))) push(_resolveUrl(pot, baseUrl));
      if (out.length >= MAX_EXTRACTED_VIDEOS) break;
    }
    var gm;
    genRe.lastIndex = 0;
    while ((gm = genRe.exec(sc)) !== null) {
      push(_resolveUrl(gm[0], baseUrl));
      if (out.length >= MAX_EXTRACTED_VIDEOS) break;
    }
    return out;
  }

  function extractVideoUrls(html, baseUrl) {
    var found = [];
    var seen = {};
    function add(u) {
      if (!u || seen[u] || found.length >= MAX_EXTRACTED_VIDEOS) return;
      seen[u] = 1;
      found.push(u);
    }
    try {
      var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      var root = doc.body || doc.documentElement;
      if (!root) return [];
      // <video>/<source>（可信 → 直接收）
      var vids = root.querySelectorAll('video, video source');
      for (var i = 0; i < vids.length; i++) {
        var attrs = ['src', 'data-src', 'data-source', 'data-video', 'data-url'];
        for (var a = 0; a < attrs.length; a++) {
          var v = vids[i].getAttribute(attrs[a]);
          if (v) add(_resolveUrl(v, baseUrl));
        }
      }
      // <iframe>（仅视频平台/播放器特征）
      var ifr = root.querySelectorAll('iframe');
      for (var j = 0; j < ifr.length; j++) {
        var s = _resolveUrl(ifr[j].getAttribute('src'), baseUrl);
        if (s && _isLikelyVideoEmbed(s)) add(s);
      }
      // 链接/属性中按扩展名判定
      var links = root.querySelectorAll('a[href], [data-href]');
      for (var k = 0; k < links.length; k++) {
        var h = links[k].getAttribute('href') || links[k].getAttribute('data-href');
        if (h && _VIDEO_EXT_RE.test(h)) add(_resolveUrl(h, baseUrl));
      }
      // 脚本内 JSON 扫描（SPA/移动端页面常见；纯函数 scanScriptText 可单测）
      var scripts = root.querySelectorAll('script');
      for (var m = 0; m < scripts.length; m++) {
        var list = scanScriptText(scripts[m].textContent, baseUrl);
        for (var q = 0; q < list.length; q++) {
          add(list[q]);
          if (found.length >= MAX_EXTRACTED_VIDEOS) break;
        }
      }
    } catch (_) { /* */ }
    return found;
  }

  // ═══ 主入口 ═══
  // opts: { forceTextFlow: boolean }
  function process(html, plainText, opts) {
    opts = opts || {};
    html = String(html || '');
    plainText = String(plainText || '');
    // ★ 乱码回修（编码检测增强）：UTF-8 字节被当 latin1/cp1252 解码的文本 → 回修还原
    var repaired = false;
    var htmlR = repairMojibake(html);
    if (htmlR !== html) { html = htmlR; repaired = true; }
    var plainR = repairMojibake(plainText);
    if (plainR !== plainText) { plainText = plainR; repaired = true; }
    if (!html || html.length > MAX_HTML_CHARS) return null;

    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return null; }
    var root = doc.body || doc.documentElement;
    if (!root) return null;

    var baseUrl = '';
    try {
      var baseEl = doc.querySelector('base[href]');
      if (baseEl) baseUrl = baseEl.getAttribute('href') || '';
    } catch (_) { /* */ }

    var domMedia = 0;
    try {
      domMedia = root.querySelectorAll('img, video, iframe, embed, object, picture').length;
    } catch (_) { /* */ }

    _scrub(root);

    var integrity = _checkHtmlIntegrity(html);
    var conf = _detectEncodingConfidence(root.textContent || '');
    var plainOk = plainText ? _checkPlainTextAlignment(root, plainText) : false;

    var scheme;
    if (opts.forceTextFlow) {
      scheme = 1;
    } else if (conf > 0.8 && integrity > 0.8) {
      scheme = 2;
    } else if (plainOk) {
      scheme = 1;
    } else {
      scheme = 2;
    }

    var blocks;
    if (scheme === 1 && plainText) {
      blocks = _zipWithCleanText(root, plainText, baseUrl);
    } else {
      blocks = _buildBlocks(root, baseUrl);
      if (!_acceptable(blocks) && plainText) {
        scheme = 1;
        blocks = _zipWithCleanText(root, plainText, baseUrl);
      }
    }

    // 视频 URL 追加（DOM 已含的跳过）
    var existing = {};
    for (var i = 0; i < blocks.length; i++) if (blocks[i].type === 'media') existing[blocks[i].src] = 1;
    var vids = extractVideoUrls(html, baseUrl);
    for (var j = 0; j < vids.length; j++) {
      if (existing[vids[j]]) continue;
      existing[vids[j]] = 1;
      blocks.push({ type: 'media', kind: 'video', src: vids[j], status: 'pending' });
    }

    var mediaCount = 0;
    for (var k = 0; k < blocks.length; k++) if (blocks[k].type === 'media') mediaCount++;

    return {
      blocks: blocks,
      scheme: scheme,
      meta: {
        conf: conf,
        integrity: integrity,
        plainOk: plainOk,
        baseUrl: baseUrl,
        domMedia: domMedia,
        mediaCount: mediaCount,
        repaired: repaired,
      },
    };
  }

  var api = {
    process: process,
    extractVideoUrls: extractVideoUrls,
    scanScriptText: scanScriptText,
    isPlatformVideoUrl: _isPlatformOrSegmentVideo,
    looksLikeMarkdown: looksLikeMarkdown,
    repairMojibake: repairMojibake,
    _checkHtmlIntegrity: _checkHtmlIntegrity,
    _detectEncodingConfidence: _detectEncodingConfidence,
    _acceptable: _acceptable,
  };
  // 浏览器: window 挂载；Node 单测: module.exports（尾部守卫——浏览器零影响）
  if (typeof window !== 'undefined') window.qqqHtmlPaste = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
