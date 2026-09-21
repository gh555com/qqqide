// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// md-render.js — Markdown 渲染机（唯一真理源，2026-09-20）
// 抽取自 ai-panel/panel-render.js（原样搬运，行为零改动）：
//   · AI 面板（ai-panel/index.html）与 md 预览（goods/mdview/mdview.html）共享这一实现
//   · 依赖 katex 全局（可选——未加载/解析失败回退字面文本）
//   · 修改 md 渲染行为只改本文件（两处消费端同时生效）；禁在别处再定义第二套
// ============================================================================

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
