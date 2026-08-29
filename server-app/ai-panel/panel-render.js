// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// Markdown renderer (lightweight)
function renderMarkdown(src) {
    if (!src) return '';
    // 规范化：3+ 连续换行 → 2 换行（消除多余空行）
    var _src = src.replace(/\n{3,}/g, '\n\n');
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
    // Headers
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
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
    s = s.replace(/^\d+\. (.+)$/gm, '<li data-list="ol">$1</li>');
    s = s.replace(/^[*\-+] (.+)$/gm, '<li data-list="ul">$1</li>');
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
    s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
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

