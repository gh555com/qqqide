// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// lpl.js — 本地路径链接机（唯一真理源，2026-09-20）
//
// 抽取自 ai-panel/panel-render.js（原样搬运 + 唯一入口扩展）：
//   · AI 面板（ai-panel/index.html）与 md 预览（goods/mdview/mdview.html）共享这一实现
//   · 修改路径识别/探针/点击行为只改本文件（两处消费端同时生效）；禁在别处再定义第二套
//
// 出口（保持 AI 面板调用点零改动——card-pool/panel-pipeline/panel-render 均调 window.*）：
//   window.linkifyLocalPaths(root)    渲染后把本地路径文本链接化（幂等）
//   window.probeLocalPathLinks(root)  存在性探针（确认存在才显示为链接，不存在还原纯文本）
//   window.qqqLpl.config              配置（唯一入口扩展点）：
//     · allowPosix: false —— 默认禁纯正斜杠相对路径（AI 面板语义，见下方 2026-09-07 注释）；
//       md 预览（文档语境）置 true：放行正斜杠相对路径，风险由存在性探针兜底（不存在即还原）
//     · resolve(raw) -> string | [主候选, 备候选] —— 链接生成前改写 data-p（md 预览把相对路径
//       解析为「相对文档目录」的绝对路径做主候选，原样相对做备候选交给主窗口逐根解析）
//
// 点击/回执协议（与主窗口 core/shell-overlay.js 既有机器共用，零新协议）：
//   postMessage {type:'qqqide-overlay', action:'lpl-probe', items:[{p,c}]} → 主窗口批量裁决
//   ← {type:'qqq-lpl-probe-result', results:[{p,c,ok}]}
//   postMessage {type:'qqqide-overlay', action:'roam-reveal-path', text, ctx} → Roam 定位
// ============================================================================

(function () {
'use strict';

var _fwSeq = 0;
function _post(msg) {
    try { msg._fwId = 'fw' + (++_fwSeq) + '_' + Date.now().toString(36); } catch (_) { }
    try { parent.postMessage(msg, '*'); } catch (_) { }
}
function _t(key, fb) {
    try { if (typeof window._qq === 'function') return window._qq(key, fb); } catch (_) { }
    return fb;
}
function _CFG() {
    try { return (window.qqqLpl && window.qqqLpl.config) || {}; } catch (_) { return {}; }
}

// ═══ 本地路径链接机（2026-09-06）：AI 最终回复里滴本地路径 → 可点击 → Roam 定位 ═══
// 三类候选：
//   C1 盘符绝对路径  E:\a\b 或 E:/a/b      —— 任意位置（含代码块内，JSON 双反斜杠转义天然兼容）
//   C2 反斜杠路径    do\专利\xxx            —— 正文任意位置；行内代码(<code>非<pre>)整个内容算一个
//                                              token（反引号包裹即作者意图，含空格路径也能整链）；
//                                              多行代码块(<pre>)内仅限行首（防 \s\w 正则噪音）。
//   ★ 2026-09-07 收紧：C2 必须含 ≥1 反斜杠 —— 纯正斜杠形态（持久化/重启恢复/多、server-app/core/x.js、
//     do/专利/x）在中文正文与代码引用里极常见，噪音闸只管 ASCII 漏掉 CJK 斜杠短语（实锤误链），
//     一律不链；斜杠路径如需可点请用盘符绝对（C1）或反斜杠形态（C2）
//     ★ 2026-09-20 唯一入口扩展：config.allowPosix=true（md 预览）放行正斜杠相对路径——
//     文档语境正斜杠是大头，风险由存在性探针兜底（不存在即还原纯文本，零假链接）
//   C3 树图叶子名    ├── xxx.zip            —— 仅代码块内盒线行：行首盒线后首个含 . 的词；
//                                              点击时由主窗口按「上文最近锚点目录」拼接解析
// 幂等：已有 <a>（含 markdown 链接/历史 ai_html）内部文本跳过，重复执行零影响。
// 点击：document 级委托（capture），任何子树/恢复/热重载后新 DOM 一律命中。
// 边界：磁盘不存在/已删除 → 主窗口 stat 爬升最近存在祖先目录 + toast（见 shell-overlay）。
// ═══════════════════════════════════════════════════════════════════════════
var _LPL_TERM = " \t\n\r\"'`<>()[]{}，。；：、！？…“”‘’（）【】《》〈〉·×★←→↑↓↔│";
var _LPL_BLOCK_SEL = 'p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,pre,blockquote,div';

function _lplIsTerm(c) { return !c || _LPL_TERM.indexOf(c) !== -1; }
function _lplIsSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }
function _lplBad(p) { return /[*?"<>|\u0000-\u001f]/.test(p); }
function _lplTrimTail(p) {
  var s = p;
  if (s.length > 3 && s.slice(-3) === '...') s = s.slice(0, -3);      // 截断省略号
  else if (s.length > 1 && s.charAt(s.length - 1) === '.' && !s.endsWith('..')) s = s.slice(0, -1); // 句号
  return s;
}
// 相对路径合法性：不以斜杠开头、无冒号、≥2 段且每段非空（允许末尾一个分隔符=目录标记）
function _lplValidRel(tok) {
  if (!tok || tok.length < 3 || tok.length > 320) return false;
  if (tok.charAt(0) === '\\' || tok.charAt(0) === '/') return false;
  if (tok.indexOf(':') !== -1) return false;
  // ★ 2026-09-20 唯一入口扩展：默认纯正斜杠不链（见头部 2026-09-07 注释）；
  //   config.allowPosix=true（md 预览）放行——探针兜底（不存在即还原，零假链接）
  if (tok.indexOf('\\') === -1) {
    if (!(_CFG().allowPosix && tok.indexOf('/') !== -1)) return false;
  }
  if (_lplBad(tok)) return false;
  var core = tok.replace(/[\\/]+$/, '');
  if (!core) return false;
  var parts = core.split(/[\\/]/);
  if (parts.length < 2) return false;
  for (var i = 0; i < parts.length; i++) if (!parts[i]) return false;
  // 噪音闸①：纯 ASCII 且无扩展点且分隔符 <3 → 拒（a\b / and/or / 2026/09/06 / 正则 \n\t\s 型）
  var hasCjk = /[^\x00-\x7F]/.test(tok);
  if (!hasCjk) {
    var hasDot = tok.indexOf('.') !== -1;
    var seps = 0;
    for (var si = 0; si < tok.length; si++) if (tok.charAt(si) === '\\' || tok.charAt(si) === '/') seps++;
    if (!hasDot && seps < 3) return false;
  }
  // 噪音闸②：全部段都是单 ASCII 字符（转义残留）→ 拒
  var allSingle = parts.every(function (p) { return /^[A-Za-z0-9]$/.test(p); });
  if (allSingle) return false;
  return true;
}
function _lplValidAbs(tok) {
  if (!tok || tok.length < 3 || tok.length > 320) return false;
  if (!/^[A-Za-z]:[\\/]/.test(tok)) return false;
  if (tok.length === 3) return true;                    // 盘根 E:\ / E:/
  return !_lplBad(tok);
}
// 文本扫描：返回 [{start,end,raw}]（不含 C3，C3 由盒线行补扫处理）
// mode: 0=正文任意位置  1=pre 仅行首
function _lplScanText(s, mode) {
  var out = [];
  var n = s.length;
  var i = 0;
  while (i < n) {
    var ch = s.charAt(i);
    // ── C1 盘符绝对路径（任何位置） ──
    if (/[A-Za-z]/.test(ch) && i + 2 < n && s.charAt(i + 1) === ':' && (s.charAt(i + 2) === '\\' || s.charAt(i + 2) === '/')) {
      if (i > 0 && /[A-Za-z0-9_]/.test(s.charAt(i - 1))) { i++; continue; }   // 前边界（https: 防误伤）
      var j = i + 3;
      while (j < n && !_lplIsTerm(s.charAt(j)) && !_lplIsSpace(s.charAt(j))) j++;
      var raw = _lplTrimTail(s.slice(i, j));
      if (_lplValidAbs(raw)) out.push({ start: i, end: i + raw.length, raw: raw });
      i = Math.max(j, i + 1);
      continue;
    }
    // ── C2 反斜杠/正斜杠相对路径 ──
    if (_lplIsSpace(ch) || _lplIsTerm(ch) || ch === '\\' || ch === '/') { i++; continue; }
    if (mode === 1 && i > 0 && s.charAt(i - 1) !== '\n') {
      // pre 内仅行首（本行从行首到 i 只允许空白）
      var li = s.lastIndexOf('\n', i - 1);
      var seg0 = s.slice(li + 1, i);
      if (/\S/.test(seg0)) { i++; continue; }
    }
    var k = i;
    while (k < n && !_lplIsTerm(s.charAt(k)) && !_lplIsSpace(s.charAt(k))) k++;
    var tok = _lplTrimTail(s.slice(i, k));
    if (_lplValidRel(tok)) out.push({ start: i, end: i + tok.length, raw: tok });
    i = Math.max(k, i + 1);
  }
  return out;
}
// C3：pre 内树图行叶子名（盒线行首个含 . 的词）
function _lplScanPreTreeLine(line) {
  var m = line.match(/^[\s]*[├└│┌┐┘┗┏┓┃╰╭╮╯┼─━═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╩╪╫╬]+[\s]*([^\s]+)/);
  if (!m) return null;
  var w = m[1];
  w = w.replace(/[，。；：、！？…“”‘’（）【】《》〈〉]+$/, '');
  // 全角括号 = 行尾注释（x.zip（零填充））→ 截断到括号前；ASCII (1) 复制后缀保留
  var bIdx = w.search(/[（【]/);
  if (bIdx > 0) w = w.slice(0, bIdx);
  if (!w || w.length < 2 || w.length > 200) return null;
  if (w.indexOf('.') === -1) return null;               // 只认文件名（含扩展名）
  if (w.indexOf('\\') !== -1 || w.indexOf('/') !== -1) return null;
  if (_lplBad(w)) return null;
  return { raw: w, at: m.index + m[0].indexOf(w) };
}
// 行内代码（非 pre）：整个内容即一个候选 token（反引号包裹=作者意图，允许内部空格）
function _lplCodeToken(codeEl) {
  if (!codeEl || codeEl.closest('pre')) return null;
  var t = (codeEl.textContent || '').trim();
  if (!t || t.length < 3 || t.length > 320) return null;
  if (/[\r\n\t]/.test(t)) return null;
  if (/^[A-Za-z]:[\\/]/.test(t)) return _lplValidAbs(t) ? t : null;
  // ★ 2026-09-20：纯正斜杠默认不链（与正文 C2 同规：反引号包裹也须反斜杠形态）；
  //   config.allowPosix=true（md 预览）放行——探针兜底
  if (t.indexOf('\\') === -1 && !(_CFG().allowPosix && t.indexOf('/') !== -1)) return null;
  if (t.charAt(0) === '\\' || t.charAt(0) === '/') return null;
  if (t.indexOf(':') !== -1) return null;
  var core = t.replace(/[\\/]+$/, '');
  var parts = core.split(/[\\/]/);
  if (parts.length < 2) return null;
  for (var i = 0; i < parts.length; i++) if (!parts[i]) return null;
  return t;
}
// data-p 写入统一入口：config.resolve 改写（string 或 [主候选, 备候选]）
function _lplSetP(a, raw) {
  var r = raw;
  try { if (typeof _CFG().resolve === 'function') r = _CFG().resolve(raw); } catch (_) { r = raw; }
  if (r == null || r === '') r = raw;
  if (Object.prototype.toString.call(r) === '[object Array]') {
    a.setAttribute('data-p', String(r[0]));
    if (r.length > 1 && r[1]) a.setAttribute('data-p-alt', String(r[1]));
    return String(r[0]);
  }
  a.setAttribute('data-p', String(r));
  return String(r);
}
function _lplBlockOf(el, root) {
  while (el && el !== root) {
    if (el.nodeType === 1 && el.matches && el.matches(_LPL_BLOCK_SEL)) return el;
    el = el.parentElement;
  }
  return root;
}
function _lplWrapTextNode(node, lastByBlock, block) {
  var text = node.data || '';
  var inPre = !!(node.parentElement && node.parentElement.closest('pre'));
  var matches = _lplScanText(text, inPre ? 1 : 0);
  if (!matches || !matches.length) return;
  var frag = node.ownerDocument.createDocumentFragment();
  var cursor = 0;
  for (var mi = 0; mi < matches.length; mi++) {
    var m = matches[mi];
    if (m.end <= cursor) continue;
    if (m.start > cursor) frag.appendChild(node.ownerDocument.createTextNode(text.slice(cursor, m.start)));
    var a = node.ownerDocument.createElement('a');
    a.className = 'qqq-path-link';
    var pv = _lplSetP(a, m.raw);
    var ctxRaw = lastByBlock.get(block) || '';
    if (ctxRaw) a.setAttribute('data-c', ctxRaw);
    a.title = _t('ai.roamOpen', '在 Roam 中打开');
    a.appendChild(node.ownerDocument.createTextNode(m.raw));
    frag.appendChild(a);
    lastByBlock.set(block, pv);
    cursor = m.end;
  }
  if (cursor < text.length) frag.appendChild(node.ownerDocument.createTextNode(text.slice(cursor)));
  if (node.parentNode) node.parentNode.replaceChild(frag, node);
}
// pre 内现有锚点索引（DOM 序 + 文本偏移）：C3 上下文 = 该词之前最近锚点
function _lplAnchorIndex(pre) {
  var list = [];
  var acc = 0;
  var w = pre.ownerDocument.createTreeWalker(pre, NodeFilter.SHOW_TEXT, null, false);
  while (w.nextNode()) {
    var tn = w.currentNode;
    var tl = (tn.data || '').length;
    var anc = tn.parentElement && tn.parentElement.closest ? tn.parentElement.closest('.qqq-path-link') : null;
    if (anc && (!list.length || list[list.length - 1].el !== anc)) {
      list.push({ el: anc, start: acc, end: acc + tl, raw: anc.getAttribute('data-p') || tn.data });
    }
    acc += tl;
  }
  return list;
}
function _lplCtxForOffset(anchors, absStart) {
  var best = '';
  for (var i = 0; i < anchors.length; i++) {
    if (anchors[i].end <= absStart) best = anchors[i].raw;
    else break;
  }
  return best;
}
// 文本绝对偏移 → DOM 文本节点定位
function _lplLocateOffset(pre, absStart) {
  try {
    var w = pre.ownerDocument.createTreeWalker(pre, NodeFilter.SHOW_TEXT, null, false);
    var acc = 0;
    while (w.nextNode()) {
      var tn = w.currentNode;
      var tl = (tn.data || '').length;
      if (acc + tl > absStart) return { node: tn, offset: Math.max(0, absStart - acc) };
      acc += tl;
    }
  } catch (_) { }
  return null;
}
// 唯一入口：对容器内全部文本节点做路径链接化（幂等）
function linkifyLocalPaths(root) {
  try {
    if (!root || root.nodeType !== 1) return;
    if (!root.ownerDocument || !root.querySelectorAll) return;
    var lastByBlock = new Map();
    var walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var ni = 0; ni < nodes.length; ni++) {
      var node = nodes[ni];
      var pe = node.parentElement;
      if (!pe) continue;
      // 行内代码（非 pre）：CODE 级整链（一次），锚点插入 CODE 内保留代码样式
      if (pe.tagName === 'CODE' && !pe.closest('pre')) {
        if (pe._lplDoneCode) continue;
        pe._lplDoneCode = true;
        var whole = _lplCodeToken(pe);
        if (whole) {
          var blockCode = _lplBlockOf(pe, root);
          var ctxCode = lastByBlock.get(blockCode) || '';
          pe.textContent = '';
          var ca = root.ownerDocument.createElement('a');
          ca.className = 'qqq-path-link';
          var pvc = _lplSetP(ca, whole);
          if (ctxCode) ca.setAttribute('data-c', ctxCode);
          ca.title = _t('ai.roamOpen', '在 Roam 中打开');
          ca.textContent = whole;
          pe.appendChild(ca);
          lastByBlock.set(blockCode, pvc);
        }
        continue;
      }
      // 跳过已有锚点/按钮内文本（幂等 + 不动 markdown 链接）
      if (pe.closest('a,button')) continue;
      var text = node.data || '';
      if (!text.trim()) continue;
      _lplWrapTextNode(node, lastByBlock, _lplBlockOf(pe, root));
    }
    // C3 树图叶子名补扫：pre 内盒线行（第一遍 C1/C2 切碎文本后统一以行视角处理）
    var pres = root.querySelectorAll('pre');
    for (var pi = 0; pi < pres.length; pi++) {
      var pre = pres[pi];
      var preText = pre.textContent || '';
      if (!preText || !/^[\s]*[├└│┌┐┘┗┏┓┃╰╭╮╯┼─━═║]/.test(preText)) continue;
      var anchors = _lplAnchorIndex(pre);
      var lines = preText.split('\n');
      var base = 0;
      for (var li2 = 0; li2 < lines.length; li2++) {
        var ln = lines[li2];
        var hit = _lplScanPreTreeLine(ln);
        if (hit) {
          var absStart = base + (hit.at != null ? hit.at : ln.indexOf(hit.raw));
          var ctxRaw = _lplCtxForOffset(anchors, absStart);
          var loc = _lplLocateOffset(pre, absStart);
          if (loc && loc.node && loc.offset >= 0 &&
              (!loc.node.parentElement || !loc.node.parentElement.closest('.qqq-path-link'))) {
            var tailN = loc.node.splitText(loc.offset);
            var restN = null;
            if (tailN.data.length > hit.raw.length) restN = tailN.splitText(hit.raw.length);
            var a3 = pre.ownerDocument.createElement('a');
            a3.className = 'qqq-path-link';
            var pv3 = _lplSetP(a3, hit.raw);
            if (ctxRaw) a3.setAttribute('data-c', ctxRaw);
            a3.title = _t('ai.roamOpen', '在 Roam 中打开');
            a3.appendChild(tailN);
            loc.node.parentNode.insertBefore(a3, restN);
            void pv3;
          }
        }
        base += ln.length + 1;
      }
    }
  } catch (_e4) { /* 链接化失败绝不阻断渲染 */ }
}

// ═══ 存在性探针（2026-09-07）：链接先经主窗口确认本地真实存在，才显示为可点链接 ═══
// 触发时机：仅权威渲染——楼层完结 onDone / 任务切换与恢复 _buildFloorDOM / addMessageEl 三处
//           （紧贴 linkifyLocalPaths 调用点）。流式途中、滚动、纯 CSS 显隐重渲染零探测。
// 性能：会话级缓存（存在/不存在 + 单飞 pending 去重），同一链接全程最多 stat 一次；
//       批量 <300/请求一次 postMessage 送达主窗口逐根裁决；后续任意重渲染零 IPC。
// 语义：确认存在 → 加 .qqq-path-ok（虚线下划线可点样式）；不存在 → 立即解除还原纯文本，
//       绝无「看着像链接点进去却是死的」假链接。磁盘事后变化由点击时主窗口爬升引擎兜底。
var _lplCache = new Map();     // key(p+ctx) → true 存在 | false 不存在（FIFO 上限 3000）
var _lplPend = new Map();      // key → { promise, resolve, timer }（8s 无回执按不存在处理）
var _lplQueue = new Map();     // key → { p, c } 待批量发送（元素经 promise .then 应用，不入队）
var _lplFlushT = null;
var _lplReqSeq = 0;
function _lplKeyOf(p, c) { return (c || '') + '\u0001' + (p || ''); }
function _lplApplyResult(el, ok) {
  try {
    if (!el || !el.isConnected) return;
    if (ok) {
      el.classList.add('qqq-path-ok');
      if (!el.title) el.title = _t('ai.roamOpen', '在 Roam 中打开');
    } else {
      var tn = el.ownerDocument.createTextNode(el.textContent || '');
      if (el.parentNode) el.parentNode.replaceChild(tn, el);
    }
  } catch (_) { }
}
// 返回 key 对应探针 promise（存在/不存在）；缓存命中同步落结果，miss 入批量队列——
// 应用方一律 .then 里落地（微任务时序：_buildFloorDOM 等先插 DOM 后应用，杜绝 isConnected 盲区）
function _lplSchedule(p, c) {
  var key = _lplKeyOf(p, c);
  var st = _lplCache.get(key);
  if (st !== undefined) return Promise.resolve(st);
  var pend = _lplPend.get(key);
  if (pend) return pend.promise;
  var ent = _lplQueue.get(key);
  if (!ent) { ent = { p: p, c: c || '' }; _lplQueue.set(key, ent); }
  var resolveFn;
  var promise = new Promise(function (res) { resolveFn = res; });
  var timer = setTimeout(function () {   // 主窗口未应答（面板独立运行/引擎未载）→ 视为不存在
    _lplPend.delete(key);
    _lplCache.set(key, false);
    resolveFn(false);
  }, 8000);
  _lplPend.set(key, { promise: promise, timer: timer, resolve: resolveFn });
  if (!_lplFlushT) _lplFlushT = setTimeout(_lplFlush, 0);
  return promise;
}
function _lplFlush() {
  _lplFlushT = null;
  if (!_lplQueue.size) return;
  var ents = Array.from(_lplQueue.values());
  _lplQueue.clear();
  var settleFail = function (ent) {
    var k = _lplKeyOf(ent.p, ent.c);
    var pe = _lplPend.get(k);
    if (pe) { clearTimeout(pe.timer); _lplPend.delete(k); _lplCache.set(k, false); pe.resolve(false); }
  };
  for (var si = 0; si < ents.length; si += 300) {
    var batch = ents.slice(si, si + 300);
    var items = [];
    for (var bi = 0; bi < batch.length; bi++) items.push({ p: batch[bi].p, c: batch[bi].c });
    try {
      _post({
        type: 'qqqide-overlay',
        action: 'lpl-probe',
        reqId: 'lpl' + (++_lplReqSeq) + '_' + Date.now().toString(36),
        items: items
      });
    } catch (_) {
      for (var fi2 = 0; fi2 < batch.length; fi2++) settleFail(batch[fi2]);
    }
  }
}
// 探针回执：主窗口逐根裁决结果按 key 落缓存并释放 pending（响应忽略 reqId，key 全局唯一）
window.addEventListener('message', function (e) {
  try {
    if (!e.data || e.data.type !== 'qqq-lpl-probe-result') return;
    var results = e.data.results;
    if (!Array.isArray(results)) return;
    for (var ri = 0; ri < results.length; ri++) {
      var r = results[ri];
      if (!r) continue;
      var key = _lplKeyOf(r.p, r.c);
      var ok = !!r.ok;
      _lplCache.set(key, ok);
      if (_lplCache.size > 3000) {
        var it = _lplCache.keys().next();
        if (!it.done) _lplCache.delete(it.value);
      }
      var pe = _lplPend.get(key);
      if (pe) { clearTimeout(pe.timer); _lplPend.delete(key); pe.resolve(ok); }
    }
  } catch (_) { }
});
// 权威渲染点调用：确认存在才显示为链接，不存在立即还原纯文本（零残留假链接）
// ★ 2026-09-20：支持备候选（data-p-alt，config.resolve 产出）——主候选不存在时试备候选，
//   命中即改写 data-p 为备候选（点击跳转随 winner 走），双否才还原
function probeLocalPathLinks(root) {
  try {
    if (!root || !root.querySelectorAll) return;
    var links = root.querySelectorAll('a.qqq-path-link');
    if (!links || !links.length) return;
    for (var li = 0; li < links.length; li++) {
      var a = links[li];
      var p = a.getAttribute('data-p');
      if (!p) continue;
      (function (el) {
        var c = el.getAttribute('data-c') || '';
        var pAlt = el.getAttribute('data-p-alt') || '';
        var prMain = _lplSchedule(p, c);
        if (!pAlt) {
          prMain.then(function (ok) { _lplApplyResult(el, ok); });
          return;
        }
        prMain.then(function (ok) {
          if (ok) { _lplApplyResult(el, true); return; }
          _lplSchedule(pAlt, '').then(function (ok2) {
            if (ok2) {
              el.setAttribute('data-p', pAlt);
              el.removeAttribute('data-p-alt');
              _lplApplyResult(el, true);
            } else {
              _lplApplyResult(el, false);
            }
          });
        });
      })(a);
    }
  } catch (_) { }
}
window.probeLocalPathLinks = probeLocalPathLinks;

// ═══ 点击委托：本地路径链接 → 主窗口 Roam 定位（capture 阶段，任何子树/热重载后新 DOM 一律命中）═══
// 门控：仅已确认存在（.qqq-path-ok）立即跳；未确认（探针在途）先等结果——存在才跳，不存在零动作。
document.addEventListener('click', function (e) {
  var _t2 = e.target;
  if (!_t2 || !_t2.closest) return;
  var _pl = _t2.closest('.qqq-path-link');
  if (!_pl) return;
  e.preventDefault();
  e.stopPropagation();
  function _lplNav() {
    try {
      _post({
        type: 'qqqide-overlay',
        action: 'roam-reveal-path',
        text: _pl.getAttribute('data-p') || _pl.textContent || '',
        ctx: _pl.getAttribute('data-c') || ''
      });
    } catch (_) { }
  }
  if (_pl.classList.contains('qqq-path-ok')) { _lplNav(); return; }
  var _p = _pl.getAttribute('data-p') || _pl.textContent || '';
  var _c = _pl.getAttribute('data-c') || '';
  var _pAlt = _pl.getAttribute('data-p-alt') || '';
  _lplSchedule(_p, _c).then(function (ok) {
    if (!_pl.isConnected) return;
    if (ok) { _lplNav(); return; }
    if (_pAlt) {
      _lplSchedule(_pAlt, '').then(function (ok2) {
        if (ok2 && _pl.isConnected) {
          _pl.setAttribute('data-p', _pAlt);
          _pl.removeAttribute('data-p-alt');
          _lplNav();
        }
      });
    }
  });
}, true);

// 出口：AI 面板调用点（card-pool/panel-pipeline/panel-render）全部走 window.* 同名入口
window.linkifyLocalPaths = linkifyLocalPaths;
window.qqqLpl = {
    linkify: linkifyLocalPaths,
    probe: probeLocalPathLinks,
    config: { allowPosix: false, resolve: null }
};

})();
