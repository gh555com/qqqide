'use strict';

// Markdown renderer (lightweight)
function renderMarkdown(src) {
    if (!src) return '';
    // 规范化：3+ 连续换行 → 2 换行（消除多余空行）
    var _src = src.replace(/\n{3,}/g, '\n\n');
    const codeBlocks = [];
    let s = _src.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
        const idx = codeBlocks.length;
        var rawCode = escHtml(code);
        var codeHtml = '<pre><code class="lang-' + (lang || '') + '">' + rawCode + '</code></pre>';
        var codeId = window._tableStore.length;
        window._tableStore.push(codeHtml);
        codeBlocks.push(
            '<div class="table-wrap">' +
            '<span class="table-view-btn" onclick="viewTable(' + codeId + ')">▶ 展开</span>' +
            codeHtml + '</div>'
        );
        return '\x00CB' + idx + '\x00';
    });
    s = escHtml(s);
    // Restore code blocks
    s = s.replace(/\x00CB(\d+)\x00/g, function (_, i) { return codeBlocks[+i]; });
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Headers
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // HR
    s = s.replace(/^---+$/gm, '<hr>');
    // Bold, italic
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // Tables (must run before lists to avoid confusing | with list markers)
    // ★ 防护：用 \x0a 代替 \n，防止 search_replace 工具将正则中的 \n 断裂成真换行
    s = s.replace(/(?:\x0a|^)(\|.+\|)\x0a\|[-:\s|]+\|\x0a((?:\|.+\|\x0a?)*)/g, function (_, header, rows) {
        if (!header || rows === undefined) return _;
        // slice(1,-1) 去掉首尾 | 产生的空串，保留中间空列（filter 会吞掉空表头）
        const ths = header.split('|').slice(1, -1).map(function (c) { return '<th>' + c.trim() + '</th>'; }).join('');
        const trs = rows.split('\n').filter(function (r) { return r.trim(); }).map(function (r) {
            const tds = r.split('|').slice(1, -1).map(function (c) { return '<td>' + c.trim() + '</td>'; }).join('');
            return '<tr>' + tds + '</tr>';
        }).join('');
        var rawTable = '<table><thead><tr>' + ths + '</tr></thead><tbody>' + trs + '</tbody></table>';
        var tblId = window._tableStore.length;
        window._tableStore.push(rawTable);
        // 悬浮按钮：hover 时右上角出现，易点击，底色黄醒目
        return '<div class="table-wrap">' +
            '<span class="table-view-btn" onclick="viewTable(' + tblId + ')">▶ 展开</span>' +
            '<div class="table-inner">' + rawTable + '</div></div>';
    });
    // Lists: 先转 <li>，再用占位符保护整个 <ul> 块，防止后续 <br> 和 <p> 破坏列表间距
    s = s.replace(/^[*\-+] (.+)$/gm, '<li>$1</li>');
    var listBlocks = [];
    s = s.replace(/((?:<li>.*<\/li>\n?)+)/g, function (_, block) {
        var idx = listBlocks.length;
        listBlocks.push('<ul>' + block.replace(/\n/g, '') + '</ul>');
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
    return s;
}
function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══ Table store (for full-window table viewer) ═══
window._tableStore = [];

function viewTable(id) {
    var html = window._tableStore[id];
    if (html) {
        // 用 class="msg-ai" 包裹，让父窗口 overlay 能复用 AI 面板 CSS
        var wrapped = '<div class="msg-ai">' + html + '</div>';
        _postToHost({ type: 'qqqide-overlay', action: 'open-table', html: wrapped });
    }
}
// Expose globally — onclick in HTML needs global scope
window.viewTable = viewTable;

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

function doStreamRender() {

    var aiDiv = _activeAgent._activeAiDiv;

    if (!aiDiv) { return; }
    if (!aiDiv._dirty) { aiDiv._renderScheduled = false; return; }

    aiDiv._renderScheduled = false;

    // ★ 引导确认期间：不产生流式 DOM（模型可能输出 XML 垃圾未清洗）
    // 仅清空积压的 _paras（释放内存），不触碰 DOM
    if (aiDiv._guideMode) {
        aiDiv._renderedCount = (aiDiv._paras || []).length;
        for (var _gpi = 0; _gpi < (aiDiv._paras || []).length; _gpi++) {
            aiDiv._paras[_gpi] = null;
        }
        aiDiv._dirty = false;
        return;
    }

    var rendered = aiDiv._renderedCount || 0;

    var paras = aiDiv._paras || [];

    // Render completed paragraphs (once, then release string for GC)

    while (rendered < paras.length) {

        var para = paras[rendered];
        // 跳过空段落（避免产生空白 div）
        if (para && para.trim()) {
            var pEl = document.createElement('div');
            pEl.className = 'stream-para';
            pEl.innerHTML = renderMarkdown(para);
            aiDiv._contentWrap.appendChild(pEl);
        }
        paras[rendered] = null;  // release for GC
        rendered++;
    }

    aiDiv._renderedCount = rendered;

    // Last (in-progress) paragraph: re-render in dedicated slot

    if (!aiDiv._lastParaEl) {

        aiDiv._lastParaEl = document.createElement('div');
        aiDiv._lastParaEl.className = 'stream-para';
        aiDiv._contentWrap.appendChild(aiDiv._lastParaEl);

    }

    // 增量解析：若处于代码围栏内，_buf 含开围栏标记，剥离后包裹 <pre><code>
    if (aiDiv._codeFenceOpen && aiDiv._buf) {
        var _codeContent = aiDiv._buf;
        // 剥离首行开围栏标记（``` 或 ```lang），仅显示代码本体
        var _firstNL = _codeContent.indexOf('\n');
        if (_firstNL > 0 && /^```/.test(_codeContent)) {
            _codeContent = _codeContent.slice(_firstNL + 1);
        }
        aiDiv._lastParaEl.innerHTML = '<pre><code>' + escHtml(_codeContent) + '</code></pre>';
    } else {
        aiDiv._lastParaEl.innerHTML = renderMarkdown(aiDiv._buf || '');
    }

    aiDiv._dirty = false;

}

// ═══ 唯一真理机：用户消息显示内容（剥离所有注入块，无论输入干净还是脏） ═══
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

// ═══ 唯一真理机：用户消息 DOM 元素（只有这一处创建用户豆腐块） ═══
function renderUserMessageEl(content) {
    var div = document.createElement('div');
    div.className = 'msg msg-user';
    var displayContent = getUserDisplayContent(content);
    div.innerHTML = renderMarkdown(displayContent);
    return div;
}

function addUserMessageEl(content) {
    var displayContent = getUserDisplayContent(content);
    var div = renderUserMessageEl(content);
    _appendToCard(div);
    _markLongMsg(div, 'user', displayContent);
    scrollToBottom(true);
    return div;
}

// ═══ 消息 DOM 插入辅助：优先插入活跃 Card 内容区 ═══
function _appendToCard(el) {
    if (cardPool && questActiveId) {
        var card = cardPool.getOrCreate(questActiveId);
        if (card && card._contentWrap) {
            card._contentWrap.appendChild(el);
            // 若 card 尚未显示（新创建 quest 首次消息），自动显示
            if (card.dom && card.dom.style.display === 'none') {
                card.dom.style.display = 'block';
                cardPool._activeId = questActiveId;
            }
            return;
        }
    }
    $messages.appendChild(el);
}

function addMessageEl(role, content) {
    const div = document.createElement('div');
    div.className = 'msg msg-' + role;
    if (role === 'ai') {
        div.innerHTML = renderMarkdown(content);
    } else if (role === 'error') {
        div.style.whiteSpace = 'pre-wrap';
        div.textContent = content;
    } else {
        return addUserMessageEl(content);
    }
    _appendToCard(div);
    if (role === 'ai') _markLongMsg(div, 'ai', content);
    scrollToBottom(role === 'user');
    return div;
}

function setStreaming(val) {
    streaming = val;
    $sendBtn.textContent = val ? 'Stop' : 'Send';
    $sendBtn.className = val ? 'stop' : '';
    updateQueueBtn();
    // 彗星环绕：streaming 时点亮 tofu 编号
    var tofu = document.getElementById('quest-tofu');
    if (tofu) {
        if (val) tofu.classList.add('quest-running');
        else tofu.classList.remove('quest-running');
    }
}
