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
        codeBlocks.push(
            '<div class="table-wrap">' +
            '<span class="table-view-btn">▶ 展开</span>' +
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
    // Images — must run BEFORE links to prevent ![alt](url) being caught as [alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" style="max-width:100%;display:block;margin:8px 0;" onerror="this.style.display=\'none\'">');
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
        return '<div class="table-wrap">' +
            '<span class="table-view-btn">▶ 展开</span>' +
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
    return s;
}
function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// ═══ 唯一真理机：用户消息 DOM 元素（只有这一处创建用户豆腐块） ═══
function renderUserMessageEl(content) {
    var div = document.createElement('div');
    div.className = 'msg msg-user';
    div.style.whiteSpace = 'pre-wrap';
    var displayContent = getUserDisplayContent(content);
    var esc = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    div.textContent = displayContent;
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

var _panelRunningQuestId = null;  // 本面板标记为 running 的 quest（配对更新中心机器用）

function _markQuestRunning(questId, isRunning) {
    if (!questId || _isDraft(questId)) return;
    try { if (parent && parent.__qqq_setQuestRunning) parent.__qqq_setQuestRunning(questId, isRunning); } catch (_) { }
    _broadcast('quest-running', questId, { isRunning: isRunning });
}

// ═══ 引导按钮：仅建楼中可用 ═══
function updateGuideBtn() {
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
    var _state = _activeAgent ? _activeAgent._stopState : 'idle';
    if (_state === 'stopping') {
        $sendBtn.textContent = '....';
        $sendBtn.className = 'stop';
        $sendBtn.disabled = true;
    } else if (_activeAgent && _activeAgent._compressing) {
        $sendBtn.textContent = '\u23f3';
        $sendBtn.className = 'compressing';
        $sendBtn.disabled = true;
    } else {
        $sendBtn.textContent = val ? 'Stop' : 'Send';
        $sendBtn.className = val ? 'stop' : '';
        $sendBtn.disabled = false;
    }
    updateQueueBtn();
    // ★ 彗星环绕：开始建楼时写入父窗口中心注册表（释放由 onDone/onError/finally 显式处理）
    //   setStreaming(false) 只做 UI 清理，绝不动中心机器（防 switchQuest/_unloadQuest 误写）
    if (val && questActiveId && !_isDraft(questActiveId)) {
        if (_panelRunningQuestId && _panelRunningQuestId !== questActiveId) {
            _markQuestRunning(_panelRunningQuestId, false);
        }
        _panelRunningQuestId = questActiveId;
        _markQuestRunning(questActiveId, true);
    }
    // 彗星环绕：当前面板 tofu 立即更新（读中心机器，跨面板一致）
    var tofu = document.getElementById('quest-tofu');
    if (tofu) {
        var runningNow = _getRunningQuestIds();
        if (runningNow.indexOf(questActiveId) >= 0) tofu.classList.add('quest-running');
        else tofu.classList.remove('quest-running');
    }
    // 刷新下拉列表中的彗星标记（如果当前打开）
    if (typeof _questDrop !== 'undefined' && _questDrop) renderQuestDrop();
}
