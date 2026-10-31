// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// ═══ renderMarkdown + escHtml 已抽移至 core/md-render.js（唯一渲染机，2026-09-20）═══
// ═══ 本地路径链接机（linkifyLocalPaths/probeLocalPathLinks）已抽移至 core/lpl.js（唯一真理源，2026-09-20）═══
//   AI 面板调用点（本文件 addMessageEl / card-pool / panel-pipeline）零改动——lpl.js 同名 window.* 出口。
//   AI 面板经 ai-panel/index.html 加载 ../core/md-render.js 获得同一实现；md 预览同源。
//   修改 md 渲染行为只改 core/md-render.js —— 此处禁再定义第二套。


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
    // ★ 图标 = qqq-icons 手绘唯一真源（qqi-act-copy；与分享/收藏同网格同笔触同尺寸，禁内联第二套 SVG）
    btn.innerHTML = '<span class="qqi qqi-act-copy"></span>';
    btn.title = typeof _i === 'function' ? _i('qqq.user.copy', '复制') : '复制';
    btn.setAttribute('data-i18n-title', 'qqq.user.copy');   // ★ 语言切换自动保鲜（父窗 updateDom 直刷）
    btn.onclick = function (e) {
        e.stopPropagation();
        var text = el.textContent || '';
        navigator.clipboard.writeText(text).then(function () {
            // 已复制 = 同一枚图标转绿 1.5s（不换第四枚图标：三钮恒为同一套笔触）
            btn.classList.add('copied');
            setTimeout(function () { btn.classList.remove('copied'); }, 1500);
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

// ═══ 楼层动作（复制 / 分享）——唯一真理机：只活在 az 行内、收藏星标左侧 ═══
// 反模式（已废，禁回潮）：① sticky 悬浮 + 插为 el 首子节点 → 正文前多出一条 22px 行盒
//   （就是「问与答之间那条空隙」的根因）；② 追加为 el 末子节点 → 尾巴再多一条行盒。
// 结论：按钮不属于正文流，只属于 az 行（时钟行）；一切插入点收敛到 _ensureAiActs。
function _mkAiCopyBtn(el) {
    var btn = document.createElement('span');
    btn.className = 'msg-ai-copy';
    // ★ 图标 = qqq-icons 手绘唯一真源（qqi-act-copy；与分享/收藏同网格同笔触同尺寸，禁内联第二套 SVG）
    btn.innerHTML = '<span class="qqi qqi-act-copy"></span>';
    btn.title = typeof _i === 'function' ? _i('qqq.ai.copy', '复制 Markdown') : '复制 Markdown';
    btn.setAttribute('data-i18n-title', 'qqq.ai.copy');   // ★ 语言切换自动保鲜（父窗 updateDom 直刷）
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
                if (child.classList && child.classList.contains('msg-ai-acts')) continue;
                var t = child.textContent.trim();
                if (t) azLines.push(t);
            }
        }
        var text = markdown;
        if (azLines.length > 0) text += '\n\n' + azLines.join('\n');
        if (!text.trim()) text = el.textContent || '';
        navigator.clipboard.writeText(text).then(function () {
            // 已复制 = 同一枚图标转绿 1.5s（不换图标：三钮恒为同一套笔触）
            btn.classList.add('copied');
            setTimeout(function () { btn.classList.remove('copied'); }, 1500);
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
    return btn;
}

function _mkAiShareBtn(el) {
    var shBtn = document.createElement('span');
    shBtn.className = 'msg-ai-share';
    // ★ 图标 = qqq-icons 手绘唯一真源（qqi-act-share，与复制/收藏同笔触）
    shBtn.innerHTML = '<span class="qqi qqi-act-share"></span>';
    shBtn.title = typeof _i === 'function' ? _i('qqq.ai.share', '分享此回答') : '分享此回答';
    shBtn.setAttribute('data-i18n-title', 'qqq.ai.share');
    shBtn.onclick = function (e) {
        e.stopPropagation();
        if (typeof window.shareOpen !== 'function') return;
        // 选区即精确截取：只认落在本回答内部的选区（跨块选择不算——避免把隔壁楼层误带出去）
        var sel = '';
        try {
            var s = window.getSelection();
            if (s && s.rangeCount && !s.isCollapsed) {
                var t = String(s.toString() || '');
                var a = s.anchorNode, f = s.focusNode;
                if (t.trim() && a && f && el.contains(a) && el.contains(f)) sel = t;
            }
        } catch (_) { }
        window.shareOpen(el, sel);
    };
    return shBtn;
}

// ★ 动作组归位（幂等）：有时钟行 → 恒在时钟行内、星标左侧；无时钟行（致命楼/遗留注记）→ 自挂一行
function _ensureAiActs(el) {
    var host = el._clockBlock || null;
    var orphan = el.querySelector(':scope > .msg-ai-acts');
    var grp = host ? host.querySelector('.msg-ai-acts') : orphan;
    if (host && orphan && orphan !== grp && orphan.parentNode) orphan.parentNode.removeChild(orphan);
    if (!grp) {
        grp = document.createElement('span');
        grp.className = 'msg-ai-acts';
        if (host) {
            // ★ 星标外层的 .msg-ai-fav 是位置保险（auto 外边距在它身上）——动作组挂它内部、星标左侧
            var favWrap = host.querySelector(':scope > .msg-ai-fav');
            if (favWrap) {
                favWrap.insertBefore(grp, favWrap.firstChild);
            } else {
                var star = host.querySelector(':scope > .clock-fav');
                host.insertBefore(grp, star || null);
            }
        } else {
            el.appendChild(grp);
        }
    }
    if (!grp.querySelector('.msg-ai-copy')) grp.appendChild(_mkAiCopyBtn(el));
    if (!grp.querySelector('.msg-ai-share')) grp.appendChild(_mkAiShareBtn(el));
    return grp;
}

function _addCopyBtnToAiMsg(el, rawMarkdown) {
    // ★ 把原始 Markdown 存到元素上（不为空时覆盖，为空时不擦已有数据）
    if (rawMarkdown) el._rawMarkdown = rawMarkdown;
    _ensureAiActs(el);
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

function addUserMessageEl(content, optQuestId) {
    var displayContent = getUserDisplayContent(content);
    var div = renderUserMessageEl(content);
    _appendToCard(div, optQuestId);
    _markLongMsg(div, 'user', displayContent);
    scrollToBottom(true);
    // ★ 诊断：记录用户气泡上屏（render-log.jsonl，2MB 双代轮转）
    if (typeof _logRenderEvent === 'function') {
        _logRenderEvent('user_bubble', optQuestId || questActiveId, div._floor || 0, content);
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
            // ★ 点亮唯一条件：目标就是面板当前显示的 quest。
            //   旧实现「顺手点亮隐藏卡片」且不隐藏旧卡 → 两张卡同时 display:block（串台放大器：
            //   气泡画在 B 的卡里、旧卡 A 仍然可见）。后台 quest 的气泡/错误框一律只进自己的隐藏卡。
            if (card.dom && card.dom.style.display === 'none' && targetId === questActiveId) {
                if (cardPool._activeId && cardPool._activeId !== targetId && cardPool._cards[cardPool._activeId] && cardPool._cards[cardPool._activeId].dom) {
                    cardPool._cards[cardPool._activeId].dom.style.display = 'none';
                }
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
        return addUserMessageEl(content, optQuestId);
    }
    _appendToCard(div, optQuestId);  // ★ P10：支持指定 quest，无则走当前 questActiveId

    if (role === 'ai') _markLongMsg(div, 'ai', content);
    scrollToBottom(role === 'user');
    return div;
}

// ═══ 引导按钮：仅建楼中可用（fatal 态禁用） ═══
function updateGuideBtn() {
    var _ag = (typeof _resolveBtnAgent === 'function') ? _resolveBtnAgent() : ((typeof _activeAgent !== 'undefined') ? _activeAgent : null);
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

// ═══ Send 按钮真理机（唯一渲染源）═══
// 反模式（已废）：按钮字面由一次性打印决定（最后写入者赢、零对账）——任一假值打印一旦成为
// "最后一次"就冻结到任务结束；点击判定却实时读 _stopState → 字面 Send + 点击 busy = 永停不了
// （q13 事故）。现在：外观恒从真理源（_stopState / 红框）推导，点击与字面同源。
// 三态字面：Send（闲置）/ Stop（建楼中可点）/ Stop...（stopping = inert 态：置灰外观 + 点击零动作 + 悬停即时提示）。
// 字面恒此三态（无 '....' / ⏳）——新增字面必须同批扩展 _sendBtnTruth 与点击分派（panel-input $sendBtn.onclick）。
function _resolveBtnAgent() {
    // 按钮绑定"当前显示任务"的建楼 agent = 面板真身（唯一入口 _panelAgent）。
    return (typeof _panelAgent === 'function') ? _panelAgent() : ((typeof _activeAgent !== 'undefined') ? (_activeAgent || null) : null);
}

function _sendBtnTruth() {
    var _ag = _resolveBtnAgent();
    var _st = _ag ? _ag._stopState : 'idle';
    if (_st === 'stopping') return { label: 'Stop...', cls: 'stop', inert: true, st: _st, ag: _ag };
    if (_st === 'sending') return { label: 'Stop', cls: 'stop', inert: false, st: _st, ag: _ag };
    if (_st === 'fatal' && _ag) {
        // ★ 红框 ACTIVE 态：按钮保持 Stop（红色可点）；无活跃红框（已封顶）→ Send
        var _hasActive = false;
        if (_ag._questErrorState) {
            for (var _fn in _ag._questErrorState) {
                if (!_ag._questErrorState[_fn].capped) { _hasActive = true; break; }
            }
        }
        if (_hasActive) return { label: 'Stop', cls: 'stop', inert: false, st: _st, ag: _ag };
    }
    return { label: 'Send', cls: '', inert: false, st: _st, ag: _ag };
}

var _sendBtnLastKey = '';      // 已渲染快照（diff：仅在真变化时写 DOM）
var _sendBtnDriftLogTs = 0;    // 漂移取证日志节流（≥5s）
function _renderSendBtn(fromReconcile) {
    if (!$sendBtn) return;
    var _t = _sendBtnTruth();
    var _key = _t.label + '|' + _t.cls + '|' + (_t.inert ? '1' : '0');
    if (_key === _sendBtnLastKey) return;
    // ★ 漂移取证：只有对账机才发现的变化 = 存在漏刷新（q13 类）→ agent-*.log 留一行，供事后秒定位
    if (fromReconcile && _sendBtnLastKey) {
        var _now = Date.now();
        if (_now - _sendBtnDriftLogTs > 5000) {
            _sendBtnDriftLogTs = _now;
            try {
                var _dAg = _t.ag;
                if (_dAg && typeof _dAg._writeFileLog === 'function') {
                    _dAg._writeFileLog('⚠ SEND-BTN reconcile: ' + _sendBtnLastKey.split('|')[0] + ' → ' + _t.label + ' state=' + _t.st + ' streaming=' + !!_dAg._streaming);
                }
            } catch (_) { }
        }
    }
    _sendBtnLastKey = _key;
    $sendBtn.textContent = _t.label;
    // ★ inert 不复用 disabled 属性：disabled 元素吞指针事件 → 悬停即时提示失效；
    //   改类名模拟置灰外观 + 点击守卫零动作（panel-input.js stopping 早退）
    $sendBtn.className = (_t.cls + (_t.inert ? ' inert' : '')).trim();
    // 悬停中状态迁移 → 提示即刷新/收起（防"正在停止…"定格在已归 Send 的按钮上）
    _refreshSendTip();
}

// ═══ 面板真相对账（1s，与 Send 按钮同一拍）：可见卡 / 面板当前 quest / 面板 agent 三者必须同源 ═══
//   串台事故的判据就是这三者被拉开；留一行日志 = 把「半年时隐时现」变成可定位证据。
//   ★ 指针漂了就地自愈（幂等）：面板级状态全部经 questActiveId 直取真身（panel-state._panelAgent），
//   此处把 _activeAgent 拉回真身——不依赖任何一条特定链的收尾时机。
//   静默条件：草稿期（id 未定）与切换进行中（switchQuest 内先改 id 后换 agent 的 await 窗）。
var _desyncLogTs = 0;
function _panelDesyncCheck() {
    try {
        if (typeof questActiveId === 'undefined' || !questActiveId || !cardPool) return;
        if (typeof _switching !== 'undefined' && _switching) return;
        var _vis = cardPool._activeId;
        if (!_vis) return;
        if (typeof _isDraft === 'function' && (_isDraft(_vis) || _isDraft(questActiveId))) return;
        var _bad = [];
        if (_vis !== questActiveId) _bad.push('card=' + _vis);
        var _home = (typeof _panelAgent === 'function') ? _panelAgent() : null;
        if (_home && _activeAgent !== _home) {
            _bad.push('agent=' + (_activeAgent && _activeAgent._questId));
            _activeAgent = _home;   // 自愈：面板指针恒等于真身
        }
        if (_bad.length === 0) return;
        var _now = Date.now();
        if (_now - _desyncLogTs < 5000) return;
        _desyncLogTs = _now;
        if (_home && typeof _home._writeFileLog === 'function') {
            _home._writeFileLog('⚠ PANEL-DESYNC ' + _bad.join(' ') + ' active=' + questActiveId);
        }
    } catch (_) { }
}

// ★ 1s 对账机：任何来源的状态漂移最多存活 1s（自愈兜底；纯布尔读取 + diff 写入，零常态开销）
setInterval(function () {
    try {
        if (document.hidden) return;
        _renderSendBtn(true);
        _panelDesyncCheck();
    } catch (_) { }
}, 1000);

// ═══ Send 按钮即时悬停提示（零延迟弹出，仅 Stop... 态展示）═══
var _sendTipEl = null;
function _sendTipText() {
    var _l = _sendBtnTruth().label;
    var _q = (typeof _qq === 'function') ? _qq : function (k, fb) { return fb; };
    if (_l === 'Stop...') return _q('ai.sendTipStopping', '正在停止…');
    return '';
}
function _showSendTip() {
    if (!$sendBtn) return;
    var _txt = _sendTipText();
    if (!_txt) return;
    if (!_sendTipEl) {
        _sendTipEl = document.createElement('div');
        _sendTipEl.id = 'send-tip';
        document.body.appendChild(_sendTipEl);
    }
    if (_sendTipEl.textContent !== _txt) _sendTipEl.textContent = _txt;
    _sendTipEl.style.display = 'block';
    var _r = $sendBtn.getBoundingClientRect();
    var _l2 = _r.left + _r.width / 2 - _sendTipEl.offsetWidth / 2;
    var _tp = _r.top - _sendTipEl.offsetHeight - 6;
    if (_l2 < 4) _l2 = 4;
    if (_l2 + _sendTipEl.offsetWidth > window.innerWidth - 4) _l2 = window.innerWidth - _sendTipEl.offsetWidth - 4;
    if (_tp < 4) _tp = _r.bottom + 6;
    _sendTipEl.style.left = _l2 + 'px';
    _sendTipEl.style.top = _tp + 'px';
}
function _hideSendTip() { if (_sendTipEl) _sendTipEl.style.display = 'none'; }
// 悬停期间状态迁移：正在展示的提示即刷新；字面已无提示（如回 Send）则收起
function _refreshSendTip() {
    if (!_sendTipEl || _sendTipEl.style.display !== 'block') return;
    if (!_sendTipText()) { _hideSendTip(); return; }
    _showSendTip();
}
if ($sendBtn) {
    $sendBtn.addEventListener('mouseenter', _showSendTip);
    $sendBtn.addEventListener('mouseleave', _hideSendTip);
}

function setStreaming(val, optAgent) {
    // ★ 历史签名保留：val 不再决定按钮外观（旧"一次性打印"是死胡同根因），外观恒从真理源推导
    //   （真理源 = 面板真身，与调用方传入的 agent 无关）；val 仅供 quest 电子钟起停等副作用使用。
    updateGuideBtn();
    _renderSendBtn(false);
    updateQueueBtn();
    // ★ 电子钟只服务可见任务：后台任务（队列排水/恢复楼/压缩楼）的起停不得动本面板的钟
    //   （旧实现后台楼收尾 = _stopQuestClock() 把前台正在走的钟一并掐掉）。
    if (optAgent && optAgent !== _resolveBtnAgent()) return;
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
// ★ 本地路径链接机已于 2026-09-20 抽移至 core/lpl.js（唯一真理源，AI 面板与 md 预览共享）：
//   window.linkifyLocalPaths / window.probeLocalPathLinks 由 lpl.js 提供（同名出口，调用点零改动）。
//   本文件只保留调用（addMessageEl 等）；card-pool / panel-pipeline 各自调用点不变。
//   修改路径识别 / 探针 / 点击行为只改 core/lpl.js —— 此处禁再定义第二套。
// ═══════════════════════════════════════════════════════════════════════════
