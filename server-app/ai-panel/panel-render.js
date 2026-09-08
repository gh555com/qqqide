// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// Markdown renderer (lightweight)
function renderMarkdown(src) {
    if (!src) return '';
    // 规范化：3+ 连续换行 → 2 换行（消除多余空行）
    // ★ 换行归一（2026-09-07 q242 f148 事故防御）：上游偶发把换行输出成 \r 或 \r\r\n 时，
    //   标题/表格/列表正则全部失明（. 吞 \r、$ 失效）→ 先统一为 \n 再走其余规则
    var _src = src.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
    const codeBlocks = [];
    let s = _src.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
        const idx = codeBlocks.length;
        // ★ 代码块保护（2026-08-21 底层 bug 修复）：escHtml 只转义 &<>"，markdown 链接语法
        //   [文字](URL) 转义后原样保留；若代码块立即恢复进 s，后续 Links 规则会把代码块内
        //   的 [文字](URL) 误转成真实 <a>（悬浮预览层里代码块文本变蓝色链接实锤）。
        //   故：代码块延迟到最后恢复（占位符 \x00CBn\x00 不含任何正则匹配字符，全程安全），
        //   同时换行用 \x00N 占位保护，避免经过 \n→<br> 规则破坏 <pre> 语义。
        var rawCode = escHtml(code).replace(/\n/g, '\x00N');
        var codeHtml = '<pre><code class="lang-' + (lang || '') + '">' + rawCode + '</code></pre>';
        codeBlocks.push(
            '<div class="table-wrap">' +
            '<span class="table-view-btn">View</span>' +
            codeHtml + '</div>'
        );
        return '\x00CB' + idx + '\x00';
    });
    // ★ 代码块恢复延后：必须等全部行内规则（inline code/headers/hr/bold/italic/images/links/tables/lists/blockquote）
    //   处理完再恢复，杜绝代码块内文本被行内规则误转（Links 误转实锤）
    // Inline code（同样延迟恢复 + escHtml：`[文字](URL)` 防被 Links 误转，<script> 防 XSS）
    // ★ 2026-08-25 扫描器重写（q229 表格截断事故根治，q181 f87 实锤）：
    //   旧正则 /`([^`]+)`/g 两大缺陷：① 只认单反引号定界符——`` ` ``（双反引号定界包裹字面
    //   反引号，标准 GFM 写法）被错配拆碎；② [^`]+ 跨换行贪婪——错配后一路吞到全文下一个
    //   反引号（PowerShell 行尾 `` ` `` 第三游程吞掉整段：剩余表格行+段落 → 表格截断成 3 行+
    //   后续文本变无格式干打印）。新实现：反引号游程等长配对（GFM 严格语义，开闭定界符必须
    //   等长）+ 无闭合 → 字面输出零吞噬。
    function _scanInlineCodes(src) {
        var codes = [];
        var out = '', i = 0, n = src.length;
        while (i < n) {
            var ch = src.charAt(i);
            if (ch !== '`') { out += ch; i++; continue; }
            var j = i;
            while (j < n && src.charAt(j) === '`') j++;
            var len = j - i;
            // 快速路径：后面无任何反引号 → 剩余全部字面输出
            if (src.indexOf('`', j) === -1) { out += src.slice(i); break; }
            // 向前找等长游程作为闭合定界符（GFM：开闭必须等长，异长游程只算内容）
            var k = j, close = -1;
            while (k < n) {
                if (src.charAt(k) === '`') {
                    var k2 = k;
                    while (k2 < n && src.charAt(k2) === '`') k2++;
                    if (k2 - k === len) { close = k; break; }
                    k = k2;
                } else { k++; }
            }
            if (close !== -1) {
                var idx = codes.length;
                var content = src.slice(j, close);
                // GFM 归一：内容首尾均为空格且非全空格 → 各剥一个
                if (content.length > 1 && content.charAt(0) === ' ' && content.charAt(content.length - 1) === ' ' && /[^ ]/.test(content)) {
                    content = content.slice(1, -1);
                }
                codes.push('<code>' + escHtml(content) + '</code>');
                out += '\x00IC' + idx + '\x00';
                i = close + len;
            } else {
                out += src.slice(i, j); // 无闭合：反引号按字面输出，绝不吞后续内容
                i = j;
            }
        }
        return { text: out, codes: codes };
    }
    var _ic = _scanInlineCodes(s);
    s = _ic.text;
    var inlineCodes = _ic.codes;
    // ★ 数学公式 KaTeX 渲染（2026-08-29）：行内 $...$ / 独立 $$...$$
    //   扫描器位置铁律：行内代码占位之后（代码内 $ 已保护）→ 表格之前（$P(A|B)$ 的 | 不破表）
    //   守卫（remark-math 同款）：开 $ 前非字母数字 / 后非空白数字；闭 $ 前非空白 / 后非数字；\\$ 字面
    //   KaTeX 未加载/解析失败 → 原样回退字面文本，零渲染中断
    function _renderMath(body, displayMode) {
        try {
            if (typeof katex === 'undefined' || !katex || !katex.renderToString) return '$' + body + '$';
            return katex.renderToString(body, { displayMode: !!displayMode, throwOnError: false });
        } catch (_) { return '$' + body + '$'; }
    }
    function _scanMath(src) {
        var maths = [], out = '', i = 0, n = src.length;
        while (i < n) {
            var ch = src.charAt(i);
            if (ch === '\\' && i + 1 < n && src.charAt(i + 1) === '$') { out += '$'; i += 2; continue; }  // \\$ → 字面 $
            if (ch !== '$') { out += ch; i++; continue; }
            var prev = i > 0 ? src.charAt(i - 1) : '';
            if (/[A-Za-z0-9]/.test(prev)) { out += '$'; i++; continue; }  // 5$ / abc$ 不触发
            if (i + 1 < n && src.charAt(i + 1) === '$') {
                // 独立公式 $$...$$
                var close = src.indexOf('$$', i + 2);
                if (close !== -1 && close > i + 2) {
                    var body = src.slice(i + 2, close);
                    if (body.charAt(0) !== ' ' && body.charAt(body.length - 1) !== ' ') {
                        var idx = maths.length;
                        maths.push(_renderMath(body, true));
                        out += '\x00MK' + idx + '\x00';
                        i = close + 2; continue;
                    }
                }
                out += '$'; i += 1; continue;  // 无闭合/空体 → 字面
            }
            var nx = src.charAt(i + 1);
            if (!nx || /\s/.test(nx) || /\d/.test(nx)) { out += '$'; i++; continue; }  // $ 5 / $5 不触发
            var k = src.indexOf('$', i + 1), matched = false;
            while (k !== -1) {
                if (src.slice(i + 1, k).indexOf('\n') !== -1) break;  // 行内公式不跨行
                var pv = src.charAt(k - 1), nn = src.charAt(k + 1);
                if (pv !== ' ' && pv !== '\t' && !(nn && /\d/.test(nn))) {
                    var b2 = src.slice(i + 1, k);
                    if (b2.charAt(0) !== ' ' && b2.charAt(b2.length - 1) !== ' ') {
                        var idx2 = maths.length;
                        maths.push(_renderMath(b2, false));
                        out += '\x00MK' + idx2 + '\x00';
                        i = k + 1; matched = true; break;
                    }
                }
                k = src.indexOf('$', k + 1);
            }
            if (!matched) { out += '$'; i++; }
        }
        return { text: out, maths: maths };
    }
    var _mk = _scanMath(s);
    s = _mk.text;
    var mathBlocks = _mk.maths;
    // ★ 2026-08-29 顺序定案：行内代码 + 数学公式扫描在 escHtml 之前——
    //   数学 body 保持原始字符（$a<b$ 的 < 原样进 KaTeX；实体转义版 &lt; 在 KaTeX 中渲染错误实锤），
    //   行内代码内容单次转义（旧顺序双重转义：`<b>` 显示成 &lt;b&gt; 的老 bug 顺带根治）
    s = escHtml(s);
    // Headers — ★ 标题行内容上限守卫（2026-09-07 q242 f148 巨字事故根治）：
    //   上游丢换行 → 全文挤一行，/^## (.+)$/ 的 (.+) 从 "## " 吞到文末 → 整篇变 <h2> 巨字
    //   （f148 2617 字符零换行实锤：ai_html 整段 <h2>…</h2>）。行首标记后内容超限 →
    //   不视为标题，原样回落正文渲染（字号正常，巨字 100% 杜绝）。
    var _HEAD_TITLE_MAX = 80;
    function _hWrap(m, tag, t) { return t.length > _HEAD_TITLE_MAX ? m : '<' + tag + '>' + t + '</' + tag + '>'; }
    s = s.replace(/^### (.+)$/gm, function (m, t) { return _hWrap(m, 'h3', t); });
    s = s.replace(/^## (.+)$/gm, function (m, t) { return _hWrap(m, 'h2', t); });
    s = s.replace(/^# (.+)$/gm, function (m, t) { return _hWrap(m, 'h1', t); });
    // HR
    s = s.replace(/^---+$/gm, '<hr>');
    // Bold, italic
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Images — must run BEFORE links to prevent ![alt](url) being caught as [alt](url)
    // ★ 过滤明显占位/截断路径（含 ... 的 file:/// URL），避免浏览器 404
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (m, alt, url) {
        if (/^file:\/\/\/.*\.\.\./.test(url)) { return '<em>[' + (alt || 'image') + ']</em>'; }
        // ★ 本地图片（file:///）额外挂 Roam 按钮：hover 定位到文件所在目录并选中
        var _roamBtn = /^file:\/\//i.test(url) ? '<span class="table-roam-btn">Roam</span>' : '';
        return '<div class="table-wrap img-wrap"><span class="table-view-btn">View</span>' + _roamBtn + '<span class="img-info"></span><img src="' + url + '" alt="' + alt + '" style="max-width:100%;display:block;" onerror="this.style.display=\'none\'"></div>';
    });
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // Tables (must run before lists to avoid confusing | with list markers)
    // ★ 防护：用 \x0a 代替 \n，防止 search_replace 工具将正则中的 \n 断裂成真换行
    // ★ 转义管道符（2026-08-21 二次根治，逐字符扫描）：\| → 字面 |（不拆列）；
    //   \\ → 字面 \；\\| → 字面 \ + 列分隔符（GFM 严格语义）。
    //   split('|') 占位符版无法区分 \\| 与 \|（占位法把 \\| 误当 \| 不拆列）
    function _splitRowCells(row) {
        var cells = [], cur = '', i = 0;
        while (i < row.length) {
            var ch = row.charAt(i);
            if (ch === '\\' && i + 1 < row.length) {
                var nx = row.charAt(i + 1);
                if (nx === '|') { cur += '|'; i += 2; continue; }
                if (nx === '\\') { cur += '\\'; i += 2; continue; }
                cur += ch; i++; continue;
            }
            if (ch === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
            cur += ch; i++;
        }
        cells.push(cur.trim());
        // 剥首尾语法管道产生的空单元格（表格行以 | 开头/结尾）
        if (cells.length && cells[0] === '' && row.charAt(0) === '|') cells.shift();
        if (cells.length && cells[cells.length - 1] === '' && row.charAt(row.length - 1) === '|') cells.pop();
        return cells;
    }
    s = s.replace(/(?:\x0a|^)(\|.+\|)\x0a\|[-:\s|]+\|\x0a((?:\|.+\|\x0a?)*)/g, function (_, header, rows) {
        if (!header || rows === undefined) return _;
        // slice(1,-1) 去掉首尾 | 产生的空串，保留中间空列（filter 会吞掉空表头）
        const ths = _splitRowCells(header).map(function (c) { return '<th>' + c + '</th>'; }).join('');
        const trs = rows.split('\n').filter(function (r) { return r.trim(); }).map(function (r) {
            const tds = _splitRowCells(r).map(function (c) { return '<td>' + c + '</td>'; }).join('');
            return '<tr>' + tds + '</tr>';
        }).join('');
        var rawTable = '<table><thead><tr>' + ths + '</tr></thead><tbody>' + trs + '</tbody></table>';
        return '<div class="table-wrap">' +
            '<span class="table-view-btn">View</span>' +
            '<div class="table-inner">' + rawTable + '</div></div>';
    });
    // Lists: 先转 <li>，再用占位符保护整个 <ul>/<ol> 块，防止后续 <br> 和 <p> 破坏列表间距
    // 有序列表（1. 2. 3.）→ <ol>；无序列表（* - +）→ <ul>
    // ★ 用 data-list 属性标记有序/无序（嵌在 <li> 内部），杜绝 \x00 孤儿前缀泄露
    // ★ 列表行同款长度守卫（同巨字事故形态：无换行全文被行首 "1. " 吞成整段 <li> 列表块）
    var _LINE_MARK_MAX = 200;
    s = s.replace(/^\d+\. (.+)$/gm, function (m, t) { return t.length > _LINE_MARK_MAX ? m : '<li data-list="ol">' + t + '</li>'; });
    s = s.replace(/^[*\-+] (.+)$/gm, function (m, t) { return t.length > _LINE_MARK_MAX ? m : '<li data-list="ul">' + t + '</li>'; });
    var listBlocks = [];
    s = s.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, function (_, block) {
        var idx = listBlocks.length;
        var isOrdered = /^<li data-list="ol">/.test(block);
        block = block.replace(/ data-list="(?:ol|ul)"/g, '');
        var tag = isOrdered ? 'ol' : 'ul';
        listBlocks.push('<' + tag + '>' + block.replace(/\n/g, '') + '</' + tag + '>');
        return '\x00UL' + idx + '\x00';
    });
    // Blockquote
    s = s.replace(/^&gt; (.+)$/gm, function (m, t) { return t.length > _LINE_MARK_MAX ? m : '<blockquote>' + t + '</blockquote>'; });
    // Paragraphs
    s = s.replace(/\n\n/g, '</p><p>');
    s = '<p>' + s + '</p>';
    s = s.replace(/<p><\/p>/g, '');
    // Line breaks
    s = s.replace(/\n/g, '<br>');
    // Restore list blocks（去掉包裹它们的 <p> 标签，<ul> 不能在 <p> 内）
    s = s.replace(/<p>\x00UL(\d+)\x00<\/p>/g, function (_, i) { return listBlocks[+i]; });
    s = s.replace(/\x00UL(\d+)\x00/g, function (_, i) { return listBlocks[+i]; });
    // ★ 最后恢复代码块 + 行内代码（所有行内规则已处理完；\x00N 还原为 \n）
    s = s.replace(/\x00CB(\d+)\x00/g, function (_, i) { return codeBlocks[+i]; });
    s = s.replace(/\x00IC(\d+)\x00/g, function (_, i) { return inlineCodes[+i]; });
    // ★ 数学公式最后恢复（KaTeX 成品 HTML 不再经过任何行内规则）
    s = s.replace(/\x00MK(\d+)\x00/g, function (_, i) { return mathBlocks[+i]; });
    s = s.replace(/\x00N/g, '\n');
    return s;
}
function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(n) {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function _formatSizeCompact(bytes) {
    if (!bytes || bytes < 0) return '0';
    if (bytes < 1024) return bytes + ' B';
    var kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(1) + 'k';
    var mb = kb / 1024;
    return mb.toFixed(2) + 'M';
}

function scrollToBottom(force) {
    if (cardPool) cardPool.scrollActiveToBottom(force);
}

// ★ 延迟滚到底：多重 rAF + 递进 setTimeout 兜底（应对大 DOM / 慢渲染）
function _scrollToBottomDeferred(force) {
    function _do() {
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                scrollToBottom(force);
                // 递进兜底：50ms / 200ms / 500ms（最后一击必定滚到底）
                setTimeout(function () { scrollToBottom(force); }, 50);
                setTimeout(function () { scrollToBottom(force); }, 200);
                setTimeout(function () { scrollToBottom(true); }, 500);
            });
        });
    }
    // 首帧先等 painting 完成
    requestAnimationFrame(_do);
}

// ★ 延迟恢复滚动位置：等 DOM 布局完成后再设（用于窗口重启时）
function _restoreScrollDeferred(scrollTop) {
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            $messages.scrollTop = scrollTop;
            setTimeout(function () { $messages.scrollTop = scrollTop; }, 50);
        });
    });
}

// doStreamRender: 1fps event-driven incremental render (no polling, no full-text accumulation)

// doStreamRender: 代理到 _activeAgent._doStreamRender（若给定 ag 则用 ag）
// 调用方可选传入 agent 引用，避免后台 agent 的流写入前台 Card
function doStreamRender(ag) {
    var _ag = ag || _activeAgent;
    if (_ag && _ag._doStreamRender) { _ag._doStreamRender(); }
}

// ═══ 唯一真理机：用户消息显示内容（剥离所有注入块，无论键入干净还是脏） ═══
function getUserDisplayContent(content) {
    if (typeof content !== 'string') return '';
    var text = content;
    // Strip rules blocks
    text = text.replace(/\[GLOBAL RULES[\s\S]*?\[END GLOBAL RULES\]/g, '');
    text = text.replace(/\[PROJECT RULES[\s\S]*?\[END PROJECT RULES\]/g, '');
    // Clean --- separators
    text = text.replace(/^\s*---\s*\n?/gm, '').trim();
    // Strip file/directory/attached content blocks
    var cutIdx = text.search(/\n\n\[(?:File|Directory|Attached):/);
    if (cutIdx !== -1) text = text.substring(0, cutIdx).trim();
    // Strip [GUIDE] prefix
    text = text.replace(/^\[GUIDE\]\s*/, '');
    return text;
}

// ═══ 超长消息标记：添加可滚动容器（不截断不遮罩，内容完整可搜索可全选） ═══
var MSG_LONG = { user: Infinity, ai: 10000 };
function _markLongMsg(el, role, rawText) {
    var limit = MSG_LONG[role] || 10000;
    if (rawText.length > limit) el.classList.add('msg-long');
}

// ═══ 用户消息复制按钮（追加到 .msg-user 右上角） ═══
function _addCopyBtnToUserMsg(el) {
    var btn = document.createElement('span');
    btn.className = 'msg-user-copy';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    btn.title = typeof _i === 'function' ? _i('qqq.user.copy', '复制') : '复制';
    btn.onclick = function (e) {
        e.stopPropagation();
        var text = el.textContent || '';
        navigator.clipboard.writeText(text).then(function () {
            btn.classList.add('copied');
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            setTimeout(function () {
                btn.classList.remove('copied');
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
            }, 1500);
        }).catch(function () {
            // fallback: select and execCommand
            var range = document.createRange();
            range.selectNodeContents(el);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            try { document.execCommand('copy'); } catch (_) { }
            sel.removeAllRanges();
        });
    };
    // ★ 插入为 first child 使 float:right 居于右上角，sticky 在滚动时追踪 50% 视口
    if (el.firstChild) {
        el.insertBefore(btn, el.firstChild);
    } else {
        el.appendChild(btn);
    }
}

// ═══ AI 消息复制按钮（左侧，复制原始 Markdown + az 区统计） ═══
function _addCopyBtnToAiMsg(el, rawMarkdown) {
    // ★ 把原始 Markdown 存到元素上（不为空时覆盖，为空时不擦已有数据）
    if (rawMarkdown) el._rawMarkdown = rawMarkdown;
    var btn = document.createElement('span');
    btn.className = 'msg-ai-copy';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    btn.title = typeof _i === 'function' ? _i('qqq.ai.copy', '复制 Markdown') : '复制 Markdown';
    btn.onclick = function (e) {
        e.stopPropagation();
        // ★ Markdown：优先从 _rawMarkdown，兜底 _fullText（流式缓冲区），再兜底 textContent
        var markdown = el._rawMarkdown || el._fullText || '';
        // ★ az 区：搜集 _contentWrap 之后所有兄弟块的文字（时钟/A1/A4/文件快照）
        var azLines = [];
        if (el._contentWrap) {
            var pastCw = false;
            for (var ci = 0; ci < el.children.length; ci++) {
                var child = el.children[ci];
                if (child === el._contentWrap) { pastCw = true; continue; }
                if (!pastCw) continue;
                if (child.classList.contains('msg-ai-copy')) continue;
                var t = child.textContent.trim();
                if (t) azLines.push(t);
            }
        }
        var text = markdown;
        if (azLines.length > 0) text += '\n\n' + azLines.join('\n');
        if (!text.trim()) text = el.textContent || '';
        navigator.clipboard.writeText(text).then(function () {
            btn.classList.add('copied');
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            setTimeout(function () {
                btn.classList.remove('copied');
                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
            }, 1500);
        }).catch(function () {
            var range = document.createRange();
            range.selectNodeContents(el);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            try { document.execCommand('copy'); } catch (_) { }
            sel.removeAllRanges();
        });
    };
    if (el.firstChild) {
        el.insertBefore(btn, el.firstChild);
    } else {
        el.appendChild(btn);
    }
}

// ═══ 唯一真理机：用户消息 DOM 元素（只有这一处创建用户豆腐块） ═══
function renderUserMessageEl(content) {
    var div = document.createElement('div');
    div.className = 'msg msg-user';
    div.style.whiteSpace = 'pre-wrap';
    var displayContent = getUserDisplayContent(content);
    var esc = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    div.textContent = displayContent;
    _addCopyBtnToUserMsg(div);
    return div;
}

function addUserMessageEl(content) {
    var displayContent = getUserDisplayContent(content);
    var div = renderUserMessageEl(content);
    _appendToCard(div);
    _markLongMsg(div, 'user', displayContent);
    scrollToBottom(true);
    // ★ 诊断：记录用户气泡上屏（render-log.jsonl，2MB 双代轮转）
    if (typeof _logRenderEvent === 'function') {
        _logRenderEvent('user_bubble', questActiveId, div._floor || 0, content);
    }
    return div;
}

// ═══ 消息 DOM 插入辅助：优先插入活跃 Card 内容区 ═══
function _appendToCard(el, optQuestId) {
    var targetId = optQuestId || questActiveId;  // ★ P10：支持显式 questId，用于后台 agent 错误路由
    if (cardPool && targetId) {
        var card = cardPool.getOrCreate(targetId);
        if (card && card._contentWrap) {
            card._contentWrap.appendChild(el);
            // 若 card 尚未显示（新创建 quest 首次消息），自动显示
            if (card.dom && card.dom.style.display === 'none') {
                card.dom.style.display = 'block';
                cardPool._activeId = targetId;
            }
            return;
        }
    }
    // ★ F121 加固: $messages 兜底路径也可能缺失（面板早期/竞态）→ 显式报错不静默崩
    if ($messages) $messages.appendChild(el);
    else console.error('[panel-render] _appendToCard: $messages missing, message dropped');
}

function addMessageEl(role, content, optQuestId) {
    const div = document.createElement('div');
    div.className = 'msg msg-' + role;
    if (role === 'ai') {
        div.innerHTML = renderMarkdown(content);
        // ★ 本地路径链接机：AI 回复正文中的本地路径 → 可点击 Roam 定位
        try { if (typeof window.linkifyLocalPaths === 'function') window.linkifyLocalPaths(div); } catch (_) { }
        try { if (typeof window.probeLocalPathLinks === 'function') window.probeLocalPathLinks(div); } catch (_) { }
        if (typeof _addCopyBtnToAiMsg === 'function') _addCopyBtnToAiMsg(div, content);
    } else if (role === 'error') {
        div.style.whiteSpace = 'pre-wrap';
        div.textContent = content;
    } else {
        return addUserMessageEl(content);
    }
    _appendToCard(div, optQuestId);  // ★ P10：支持指定 quest，无则走当前 questActiveId
    if (role === 'ai') _markLongMsg(div, 'ai', content);
    scrollToBottom(role === 'user');
    return div;
}

// ═══ 引导按钮：仅建楼中可用（fatal 态禁用） ═══
function updateGuideBtn() {
    var _ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    if (_ag && _ag._stopState === 'fatal') {
        $guideBtn.disabled = true;
        $guideBtn.style.opacity = '0.35';
        return;
    }
    var building = _sending || streaming;
    $guideBtn.disabled = !building;
    $guideBtn.style.opacity = building ? '1' : '0.35';
}
// ★ 立即初始化：闲置 = 禁用（HTML 已 disabled，再确保 JS 支配）
updateGuideBtn();

function setStreaming(val) {
    streaming = val;
    updateGuideBtn();
    // ★ Stop 闭环：三态 UX（IDLE / SENDING / STOPPING）
    //   val=true 表示流式输出中；_stopState 仅用于 STOPPING 覆盖
    var _ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    var _state = _ag ? _ag._stopState : 'idle';
    if (_state === 'stopping') {
        $sendBtn.textContent = '....';
        $sendBtn.className = 'stop';
        $sendBtn.disabled = true;
    } else if (_ag && _ag._compressing) {
        $sendBtn.textContent = '\u23f3';
        $sendBtn.className = 'compressing';
        $sendBtn.disabled = true;
    } else {
        $sendBtn.textContent = val ? 'Stop' : 'Send';
        $sendBtn.className = val ? 'stop' : '';
        // ★ 永不锁按钮
        $sendBtn.disabled = false;
    }
    // ★ 红框 ACTIVE 态：按钮保持 Stop（红色可点），用户可选「继续任务」或 Stop
    if (_ag && _ag._stopState === 'fatal') {
        var _hasActive = false;
        // ★ V14: 从 _questErrorState 判断是否有未封顶红框
        if (_ag._questErrorState) {
            for (var _fn in _ag._questErrorState) {
                if (!_ag._questErrorState[_fn].capped) { _hasActive = true; break; }
            }
        }
        if (_hasActive) {
            $sendBtn.textContent = 'Stop';
            $sendBtn.className = 'stop';
            $sendBtn.disabled = false;
            return;
        }
        // 无活跃红框（已封顶）→ 按钮正常走 val-based 逻辑（Send）
    }
    updateQueueBtn();
    // ★ 微型电子钟：开始建楼启动，建楼结束停止
    if (val) {
        if (typeof _startQuestClock === 'function') _startQuestClock();
    } else {
        if (typeof _stopQuestClock === 'function') _stopQuestClock();
    }
}

// ★★★ 渲染事件日志：写入 _qqq/new_log/render-log.jsonl，每行一个 JSON 事件
// 主进程 append 侧 2MB 双代轮转（总量 ≤4MB）；window.__qqq_file_log=false 可关闭
function _logRenderEvent(eventType, questId, floorNum, detail) {
    try {
        if (typeof window !== "undefined" && window.__qqq_file_log === false) return;
        var bridge = window.parent && window.parent.qqqideBridge;
        if (!bridge || !bridge.fs) return;
        var ts = new Date().toISOString();
        var preview = '';
        var len = 0;
        if (typeof detail === 'string') {
            len = detail.length;
            preview = detail.slice(0, 200).replace(/\n/g, '\\n');
        } else if (detail && detail.content) {
            len = detail.content.length;
            preview = detail.content.slice(0, 200).replace(/\n/g, '\\n');
        }
        var line = JSON.stringify({
            ts: ts,
            event: eventType,
            q: questId || '',
            f: floorNum || 0,
            len: len,
            preview: preview,
            extra: detail && detail.extra || ''
        }) + '\n';
        var root = (typeof questStore !== 'undefined' && questStore.getProjectRoot) ? questStore.getProjectRoot() : null;
        if (root) {
            var logPath = root.replace(/\\/g, '/') + '/_qqq/new_log/render-log.jsonl';
            bridge.fs.append(logPath, line).catch(function () { });
        }
    } catch (_) { /* 静默降级 */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══ 本地路径链接机（2026-09-06）：AI 最终回复里滴本地路径 → 可点击 → Roam 定位 ═══
// 三类候选：
//   C1 盘符绝对路径  E:\a\b 或 E:/a/b      —— 任意位置（含代码块内，JSON 双反斜杠转义天然兼容）
//   C2 反斜杠路径    do\专利\xxx            —— 正文任意位置；行内代码(<code>非<pre>)整个内容算一个
//                                              token（反引号包裹即作者意图，含空格路径也能整链）；
//                                              多行代码块(<pre>)内仅限行首（防 \s\w 正则噪音）。
//   ★ 2026-09-07 收紧：C2 必须含 ≥1 反斜杠 —— 纯正斜杠形态（持久化/重启恢复/多、server-app/core/x.js、
//     do/专利/x）在中文正文与代码引用里极常见，噪音闸只管 ASCII 漏掉 CJK 斜杠短语（实锤误链），
//     一律不链；斜杠路径如需可点请用盘符绝对（C1）或反斜杠形态（C2）
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
  if (tok.indexOf('\\') === -1) return false;   // ★ 纯正斜杠不链：斜杠分隔在正文/代码引用里太常见（CJK 斜杠短语实锤）
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
  if (t.indexOf('\\') === -1) return null;   // ★ 纯正斜杠不链（与正文 C2 同规：反引号包裹也须反斜杠形态）
  if (t.charAt(0) === '\\' || t.charAt(0) === '/') return null;
  if (t.indexOf(':') !== -1) return null;
  var core = t.replace(/[\\/]+$/, '');
  var parts = core.split(/[\\/]/);
  if (parts.length < 2) return null;
  for (var i = 0; i < parts.length; i++) if (!parts[i]) return null;
  return t;
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
    a.setAttribute('data-p', m.raw);
    var ctxRaw = lastByBlock.get(block) || '';
    if (ctxRaw) a.setAttribute('data-c', ctxRaw);
    a.title = '在 Roam 中打开';
    a.appendChild(node.ownerDocument.createTextNode(m.raw));
    frag.appendChild(a);
    lastByBlock.set(block, m.raw);
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
          ca.setAttribute('data-p', whole);
          if (ctxCode) ca.setAttribute('data-c', ctxCode);
          ca.title = '在 Roam 中打开';
          ca.textContent = whole;
          pe.appendChild(ca);
          lastByBlock.set(blockCode, whole);
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
            a3.setAttribute('data-p', hit.raw);
            if (ctxRaw) a3.setAttribute('data-c', ctxRaw);
            a3.title = '在 Roam 中打开';
            a3.appendChild(tailN);
            loc.node.parentNode.insertBefore(a3, restN);
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
      if (!el.title) el.title = '在 Roam 中打开';
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
      if (typeof _postToHost === 'function') {
        _postToHost({
          type: 'qqqide-overlay',
          action: 'lpl-probe',
          reqId: 'lpl' + (++_lplReqSeq) + '_' + Date.now().toString(36),
          items: items
        });
      } else {
        for (var fi = 0; fi < batch.length; fi++) settleFail(batch[fi]);
      }
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
        _lplSchedule(p, el.getAttribute('data-c') || '').then(function (ok) { _lplApplyResult(el, ok); });
      })(a);
    }
  } catch (_) { }
}
window.probeLocalPathLinks = probeLocalPathLinks;

// ═══ 点击委托：本地路径链接 → 主窗口 Roam 定位（capture 阶段，任何子树/热重载后新 DOM 一律命中）═══
// 门控：仅已确认存在（.qqq-path-ok）立即跳；未确认（探针在途）先等结果——存在才跳，不存在零动作。
document.addEventListener('click', function (e) {
  var _t = e.target;
  if (!_t || !_t.closest) return;
  var _pl = _t.closest('.qqq-path-link');
  if (!_pl) return;
  e.preventDefault();
  e.stopPropagation();
  var _p = _pl.getAttribute('data-p') || _pl.textContent || '';
  var _c = _pl.getAttribute('data-c') || '';
  function _lplNav() {
    try {
      if (typeof _postToHost === 'function') {
        _postToHost({ type: 'qqqide-overlay', action: 'roam-reveal-path', text: _p, ctx: _c });
      }
    } catch (_) { }
  }
  if (_pl.classList.contains('qqq-path-ok')) { _lplNav(); return; }
  _lplSchedule(_p, _c).then(function (ok) {
    if (ok && _pl.isConnected) _lplNav();
  });
}, true);

