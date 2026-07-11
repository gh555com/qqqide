'use strict';
// \u2550\u2550\u2550 panel-send.js \u2550\u2550\u2550
// sendMessage, input helpers, event handlers, window exports

// ★ 管线入口：统一构建 SendIntent → _executeSend
async function sendMessage(content, opts) {
    if (content === undefined) {
        content = getInputText().trim();
        opts = { type: 'normal', images: null, tierIndex: selectedTier };
    }
    opts = opts || {};
    var intent = _buildSendIntent(questActiveId, content, opts);
    return _executeSend(intent);
}
function _continueQueue() {
    var _qs = document.getElementById('queue-sending-status');
    if (_qs) _qs.remove();
    if (_queuePaused) return;
    if (_activeAgent !== agent) return;
    _triggerQueueSend();
}

// ═══ 聚合红框：per-floor 单框多行错误 + 单链接（一次渲染永久不变，仅追加） ═══
// ★ 铁律：红框在楼层间（floor N az 之后、floor N+1 user 气泡之前），不在 _contentWrap 内
//   aiDiv: 可选，不传则自动从活跃 agent 的 _activeAiDiv 获取
// ★ floorNum: 可选，显式传入时使用
function _renderQuestErrorBox(agent, aiDiv, floorNum) {
    if (!agent || !questActiveId) return;
    var _floorNum = (floorNum != null) ? floorNum : agent._currentFloorNum;
    if (!_floorNum) return;
    if (!agent._questErrorLogByFloor) agent._questErrorLogByFloor = {};
    var _log = agent._questErrorLogByFloor[_floorNum];
    if (!_log || _log.length === 0) return;

    // ★ 分楼层红框缓存
    if (!agent._questErrorDivByFloor) agent._questErrorDivByFloor = {};
    var _box = agent._questErrorDivByFloor[_floorNum];
    if (_box && !_box.isConnected) _box = null;

    // ★ 楼层间搜索：在 card 中找 floor-gap 容器
    if (!_box) {
        var _card2 = cardPool && cardPool.getActive();
        if (_card2 && _card2.floorDOM) {
            var _fDom2 = _card2.floorDOM[_floorNum];
            if (_fDom2 && _fDom2.aiEl) {
                // 找 aiEl 之后的 .floor-gap 容器
                var _nextSib = _fDom2.aiEl.nextElementSibling;
                while (_nextSib && !_box) {
                    if (_nextSib.classList && _nextSib.classList.contains('floor-gap')) {
                        _box = _nextSib.querySelector('.msg-quest-error');
                    }
                    _nextSib = _nextSib.nextElementSibling;
                }
            }
        }
    }

    // ★ 仍找不到 → 在楼层间创建 floor-gap + 红框
    if (!_box) {
        var _targetAi = aiDiv || (agent._activeAiDiv);
        if (!_targetAi || !_targetAi.parentNode) return;
        // 找或创建 .floor-gap 容器（位于 aiDiv 之后）
        var _gap = _targetAi.nextElementSibling;
        if (!_gap || !_gap.classList || !_gap.classList.contains('floor-gap')) {
            _gap = document.createElement('div');
            _gap.className = 'floor-gap';
            _targetAi.parentNode.insertBefore(_gap, _targetAi.nextSibling);
        }
        _box = document.createElement('div');
        _box.className = 'msg-quest-error';
        _gap.appendChild(_box);
        _box._floorNum = _floorNum;
    }
    agent._questErrorDivByFloor[_floorNum] = _box;

    // ★ 仅追加新行（不清空）。track 已追加行数防重复
    _box._renderedCount = _box._renderedCount || 0;
    var _link = _box._continueLink;  // ★ 提前取引用，插入新行时需放在链接上方
    while (_box._renderedCount < _log.length) {
        var _entry = _log[_box._renderedCount];
        var _row = document.createElement('div');
        _row.className = 'qe-row';
        _row.textContent = (_entry.time || '') + '  ' + (_entry.reason || '');
        _box.insertBefore(_row, _link || null);  // ★ 始终在链接上方
        _box._renderedCount++;
    }

    // ★ 若 _capped → 不创建/更新链接（封顶红框无尾行）
    if (_box._capped) {
        if (_box._continueLink && _box._continueLink.isConnected) {
            _box._continueLink.remove();
        }
        _box._continueLink = null;
        return;
    }

    // ★ 封顶检测：下一楼层 DOM 已存在 且 非恢复中 → 自动 capped
    var _hasNextFloor = false;
    var _card3 = cardPool && cardPool.getActive();
    if (_card3 && _card3.floorDOM && _card3.floorDOM[_floorNum + 1]) _hasNextFloor = true;
    if (_hasNextFloor && !agent._deferRenderUntilHouse1 && !agent._recoveryInProgress) {
        _box._capped = true;
        if (_box._continueLink && _box._continueLink.isConnected) {
            _box._continueLink.remove();
        }
        _box._continueLink = null;
        return;
    }

    // ★ 创建/更新「继续任务」链接（始终在红框底部）
    _link = _box._continueLink;
    if (!_link || !_link.isConnected) {
        var _existingLink = _box.querySelector('.msg-err-continue');
        if (_existingLink) {
            _link = _existingLink;
        } else {
            _link = document.createElement('a');
            _link.href = '#';
            _link.className = 'msg-err-continue';
            _link.style.cssText = 'text-decoration:underline;cursor:pointer;color:var(--accent-color,#4a9eff);margin-left:4px;';
        }
        _link.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
        _link._qqqQuestId = questActiveId;
        _link._qqqAgent = agent;
        _link.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (this._qqqRecoveryBusy) return;
            this._qqqRecoveryBusy = true;
            _startRecovery(this._qqqQuestId, this._qqqAgent, this);
        };
        if (!_link.isConnected) {
            _box.appendChild(_link);
        }
        _box._continueLink = _link;
    } else {
        // 已存在链接 — 恢复中不更新（保持光块/恢复态）
        if (!agent._deferRenderUntilHouse1) {
            _link.style.display = '';
            _link.className = 'msg-err-continue';
            _link._qqqRecoveryBusy = false;
            _link.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
        }
    }
}

// ★ 封顶红框中的「继续任务」链接（整行 DOM 移除，不灰化不留字） ═══
// ★ floorNum: 可选，显式传入时使用，否则回退 agent._recoveryOriginFloor → _currentFloorNum
function _capRecoveryLink(agent, floorNum) {
    if (!agent) return;
    var _fn = (floorNum != null) ? floorNum : (agent._recoveryOriginFloor || agent._currentFloorNum);
    if (!_fn) return;

    var _box = agent._questErrorDivByFloor && agent._questErrorDivByFloor[_fn];
    // 路径2：兜底遍历找未 capped 的活跃红框
    if ((!_box || !_box.isConnected) && agent._questErrorDivByFloor) {
        for (var _f in agent._questErrorDivByFloor) {
            var _b = agent._questErrorDivByFloor[_f];
            if (_b && _b.isConnected && !_b._capped) { _box = _b; _fn = parseInt(_f); break; }
        }
    }
    if (!_box || !_box.isConnected) {
        // 路径3：通过 _recoveryLinkEl
        if (agent._recoveryLinkEl && agent._recoveryLinkEl.isConnected) {
            agent._recoveryLinkEl.remove();
            agent._recoveryLinkEl = null;
        }
        return;
    }

    // 移除链接 DOM
    if (_box._continueLink && _box._continueLink.isConnected) {
        _box._continueLink.remove();
    }
    _box._continueLink = null;
    _box._capped = true;
    if (agent._questErrorDivByFloor && agent._questErrorDivByFloor[_fn]) {
        agent._questErrorDivByFloor[_fn]._capped = true;
    }
    agent._recoveryLinkEl = null;
}

// ═══ 致命失败恢复："继续任务"唯一出口 ═══
// 终极架构（2026-07-03）：
//   0-house（AI没启动过）→ 同楼层重试，不新增粉色气泡，复用现有 AI div
//   N-house（建到一半）  → 封顶密封旧楼层，创建新楼层+新粉色气泡，走 0-house 闭环
//   新楼层失败 → 红框垒行（同一个跨楼层红框），恢复「继续任务」
// 流程：光块动画 → 网络重连 → house1 抵达时消链 + 启封按钮
// ★ 所有状态挂在 agent 上（per-quest 私有财产），切面板/后台零断链
var _RECOVERY_COOLDOWN_MS = 20000;   // 面板级防抖（恢复中不可再点）
var _RECOVERY_MAX_TOTAL_MS = 180000; // 总上限 3 分钟

function _startRecovery(questId, agent, linkEl) {
    if (!questId || !agent || agent._stopState !== 'fatal') return;

    // 1. ★ 记录原始 fatal 楼层号 + 预封顶所有更旧的红框
    agent._recoveryOriginFloor = agent._currentFloorNum;
    if (agent._questErrorDivByFloor) {
        for (var _fn in agent._questErrorDivByFloor) {
            if (parseInt(_fn) < agent._recoveryOriginFloor && typeof _capRecoveryLink === 'function') {
                _capRecoveryLink(agent, parseInt(_fn));
            }
        }
    }

    // 2. 标记恢复中
    agent._recoveryInProgress = true;
    agent._recoveryStartPerf = performance.now();
    agent._deferRenderUntilHouse1 = true;
    agent._recoveryLinkEl = linkEl;

    // 3. "继续任务"文字 → 光块（同一 <a> 元素，不删不隐）
    if (linkEl) {
        linkEl._qqqRecoveryOrigText = linkEl.textContent;
        linkEl.textContent = '';
        linkEl.className = 'msg-err-recovery-light';
        linkEl.style.cssText = '';
        linkEl._qqqRecoveryBusy = true;
    }

    // 4. ★ 永不锁按钮：恢复期间 guide/queue 禁用但 send 不锁
    if ($guideBtn) $guideBtn.disabled = true;
    if ($queueBtn) $queueBtn.disabled = true;

    // 5. ★ 统一路径：一律封顶旧楼层 + 建新楼层
    _attemptRecoverySendNewFloor(questId, agent, linkEl);
}

// ★ 统一恢复：封顶旧楼层，创建新楼层（含错误历史 + 粉色气泡「继续」）
async function _attemptRecoverySendNewFloor(questId, agent, linkEl) {
    var _totalElapsed = performance.now() - agent._recoveryStartPerf;
    if (_totalElapsed > _RECOVERY_MAX_TOTAL_MS) {
        _finishRecovery(linkEl, agent, false);
        return;
    }

    if (questActiveId !== questId) {
        _finishRecovery(linkEl, agent, false);
        return;
    }

    // ★ 恢复消息：含错误历史让 AI 看到中断原因（含时间戳）
    var _recoveryText = '网络恢复重连。此前楼层中断记录：';
    var _allLogs2 = [];
    if (agent._questErrorLogByFloor) {
        for (var _fn2 in agent._questErrorLogByFloor) {
            var _fl2 = agent._questErrorLogByFloor[_fn2];
            for (var _ei = 0; _ei < _fl2.length; _ei++) {
                _allLogs2.push(_fl2[_ei]);
            }
        }
    }
    if (_allLogs2.length > 0) {
        for (var _ei2 = 0; _ei2 < _allLogs2.length; _ei2++) {
            _recoveryText += '｜' + _allLogs2[_ei2].time + ' ' + _allLogs2[_ei2].reason;
        }
    }
    _recoveryText += '｜请基于完整对话上下文继续完成原始任务。';

    var _savedInput = $input.value;

    agent._isRecovery = true;
    agent._inRecoverySend = false;
    agent._recoveryInProgress = false;

    try {
        var _intent = _buildSendIntent(questId, _recoveryText, {
            type: 'recovery',
            isRecovery: true,
        });
        await _executeSend(_intent);
        if (agent._stopState === 'fatal') {
            _finishRecovery(linkEl, agent, false);
        } else {
            _finishRecovery(linkEl, agent, true);
        }
    } catch (_e) {
        agent.setStopState('fatal');
        agent._floorFatal = true;
        _finishRecovery(linkEl, agent, false);
    } finally {
        agent._inRecoverySend = false;
        $input.value = _savedInput;
        if (typeof saveQuestUIState === 'function') saveQuestUIState(questId);
    }
}

function _finishRecovery(linkEl, agent, succeeded) {
    agent._recoveryInProgress = false;
    agent._recoveryStartPerf = 0;
    agent._deferRenderUntilHouse1 = false;

    if (succeeded) {
        // ★ 成功：整行移除链接 DOM（不灰化不留字）
        agent._recoveryOriginFloor = 0;
        if (typeof _capRecoveryLink === 'function') _capRecoveryLink(agent);
    } else {
        // ★ 失败：恢复链接为可点击（同一红框垒行后用户可重试）
        if (linkEl && linkEl.isConnected) {
            linkEl._qqqRecoveryDone = false;
            linkEl.textContent = linkEl._qqqRecoveryOrigText ||
                ((typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务');
            linkEl.className = 'msg-err-continue';
            linkEl.style.cssText = 'text-decoration:underline;cursor:pointer;color:var(--accent-color,#4a9eff);margin-left:4px;';
            linkEl._qqqRecoveryBusy = false;
            linkEl._qqqRecoveryOrigText = '';
        }
        agent._recoveryLinkEl = null;
        // ★ 永不锁按钮
    }
}

// ★ Stop 按钮在 fatal+活跃红框态 → 封顶所有活跃红框 → idle
function _capRedBoxAndSeal() {
    var ag = _activeAgent;
    if (!ag || ag._stopState !== 'fatal') return;
    if (ag._questErrorDivByFloor) {
        for (var _fn in ag._questErrorDivByFloor) {
            var _bx = ag._questErrorDivByFloor[_fn];
            if (_bx && _bx.isConnected && !_bx._capped) {
                if (typeof _capRecoveryLink === 'function') _capRecoveryLink(ag, parseInt(_fn));
            }
        }
    }
    ag.setStopState('idle');
    ag._floorFatal = false;
    ag._recoveryOriginFloor = 0;
    ag._recoveryInProgress = false;
    if (typeof setStreaming === 'function') setStreaming(false);
}

// ---- textarea helpers ----s ----
function getInputText() {
    return $input.value;
}
function getInputPlainText() {
    return $input.value;
}
function getInputChipPaths() {
    var paths = [];
    var re = /[\ud83d\udcce\ud83d\udcc1]\u201c([^\u201d]+)\u201d/g;
    var m;
    while ((m = re.exec($input.value)) !== null) {
        paths.push(m[1]);
    }
    return paths;
}

// \u2550\u2550\u2550 \u8bb0\u4f4f $input \u5185\u6700\u540e\u5149\u6807\u4f4d\u7f6e \u2550\u2550\u2550
var _lastInputCaret = 0;
$input.addEventListener('keyup', function () { _lastInputCaret = $input.selectionStart; });
$input.addEventListener('mouseup', function () { _lastInputCaret = $input.selectionStart; });
$input.addEventListener('focus', function () {
    if (_lastInputCaret > 0 && $input.selectionStart === 0 && $input.selectionEnd === 0) {
        $input.setSelectionRange(_lastInputCaret, _lastInputCaret);
    }
});

function insertChipAtCursor(filePath, isDir, lineRange) {
    // ★ 去重：同一文件路径已在编辑框中→跳过，不重复注入
    if ($input.value.indexOf('\u201c' + filePath + '\u201d') !== -1) return;
    if (typeof isDir !== 'boolean') {
        isDir = !filePath.match(/\.[a-zA-Z0-9]+$/);
    }
    var icon = isDir ? '\ud83d\udcc1' : '\ud83d\udcce';
    var rangeStr = lineRange ? ' ' + lineRange : '';
    var tag = icon + '\u201c' + filePath + '\u201d' + rangeStr + ' ';
    $input.focus();
    var start = $input.selectionStart;
    var end = $input.selectionEnd;
    if (_lastInputCaret > 0 && start === 0 && end === 0) {
        start = _lastInputCaret;
        end = _lastInputCaret;
    }
    var before = $input.value.substring(0, start);
    var after = $input.value.substring(end);
    $input.value = before + tag + after;
    var newPos = start + tag.length;
    $input.setSelectionRange(newPos, newPos);
    _lastInputCaret = newPos;
}

window.qqqideAiAttach = insertChipAtCursor;

window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'qqq-ai-attach') {
        if (!_hasMainProject()) { _triggerSelectMainProject(); return; }
        var path = e.data.path;
        var isDir = e.data.isDir;
        var lineRange = e.data.lineRange;
        if (path) {
            insertChipAtCursor(path, isDir, lineRange);
        }
    }
});

document.addEventListener('qqq-ai-attach', function (e) {
    if (e.detail && e.detail.path) {
        insertChipAtCursor(e.detail.path, e.detail.isDir, e.detail.lineRange);
    }
});

// \u2550\u2550\u2550 \u9762\u677f\u5feb\u6377\u952e \u2550\u2550\u2550
document.addEventListener('keydown', function (e) {
    if (!_panelFocused) return;
    if (document.activeElement === $input || document.activeElement.closest('#input-area')) return;
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
    var key = e.key;
    if (key === '1') {
        e.preventDefault();
        // ★ 用户主动上滚 → 立即停自动跟滚
        if (cardPool) { var _c1 = cardPool.getActive(); if (_c1) _c1._userScrolledUp = true; }
        $messages.scrollBy({ top: -$messages.clientHeight * 0.175, behavior: 'smooth' });
        _showFloorIndicatorBriefly();
    } else if (key === '2') {
        e.preventDefault();
        $messages.scrollBy({ top: $messages.clientHeight * 0.175, behavior: 'smooth' });;
        _showFloorIndicatorBriefly();
    } else if (key === 'q' || key === 'w') {
        e.preventDefault();
        // ★ q 键往上跳 → 立即停自动跟滚；w 键往下跳 → 交给 scroll 事件检测底部
        if (key === 'q' && cardPool) { var _cq = cardPool.getActive(); if (_cq) _cq._userScrolledUp = true; }
        var card = cardPool ? cardPool.getActive() : null;
        var container = card ? card._contentWrap : $messages;
        var userMsgs = container.querySelectorAll('.msg-user');
        if (userMsgs.length === 0) return;
        var viewCenter = $messages.scrollTop + $messages.clientHeight / 2;
        var currentIdx = -1;
        var minDist = Infinity;
        for (var ui = 0; ui < userMsgs.length; ui++) {
            var el = userMsgs[ui];
            var absTop = 0;
            while (el && el !== container) {
                absTop += el.offsetTop || 0;
                el = el.offsetParent;
            }
            var dist = Math.abs(viewCenter - absTop);
            if (dist < minDist) { minDist = dist; currentIdx = ui; }
        }
        if (currentIdx < 0) return;
        var targetIdx = key === 'q' ? Math.max(0, currentIdx - 1) : Math.min(userMsgs.length - 1, currentIdx + 1);
        if (targetIdx === currentIdx && key === 'w' && currentIdx < userMsgs.length - 1) targetIdx = currentIdx + 1;
        if (targetIdx === currentIdx && key === 'q' && currentIdx > 0) targetIdx = currentIdx - 1;
        if (targetIdx !== currentIdx) {
            var target = userMsgs[targetIdx];
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        _showFloorIndicatorBriefly();
    }
});

// \u2550\u2550\u2550 \u81ea\u52a8\u8ddf\u7126 \u2550\u2550\u2550
$input.addEventListener('focus', function () {
    try { parent.postMessage({ type: 'qqq-ai-panel-focused', panel: _panelId }, '*'); } catch (_) { }
});

// \u2550\u2550\u2550 Lightbox \u2550\u2550\u2550
function openLightbox(src, base64) {
    _postToHost({ type: 'qqqide-overlay', action: 'open-image', src: src, base64: base64 || null });
}

function closeLightbox() {
    _postToHost({ type: 'qqqide-overlay', action: 'close' });
}

document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        closeLightbox();
    }
});

// \u7a97\u53e3\u5173\u95ed\u65f6\u91ca\u653e\u4e3b\u8fdb\u7a0b\u9879\u76ee\u6620\u5c04
window.addEventListener('beforeunload', function () {
    var root = questStore.getProjectRoot();
    if (root) {
        try {
            if (window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.window) {
                window.parent.qqqideBridge.window.releaseProject(root).catch(function () { });
            }
        } catch (_) { }
    }
});

// ═══ 引导块恢复：扫描 conversation 中 _guideAck 消息，重建 DOM 引导块 ═══
// ★ 方案 C 根治：onDone 的 innerHTML=renderMarkdown(content) 会摧毁建楼期间 DOM 追加的引导块；
//    ai_html 保存的也是摧毁后的 DOM → 重启后引导块 100% 丢失。
//    此函数同时在 onDone 和 _buildFloorDOM 两处调用，确保引导块永不丢失。
function _restoreGuideBlocksToContentWrap(contentWrap, conv, floorNum) {
    if (!contentWrap || !conv || !conv.length) return;
    // ★ 去重：引导块已存在则跳过（_buildConversationFlowHtml 已含时不重复追加）
    if (contentWrap.querySelector('.msg-flow-guide-inject') || contentWrap.querySelector('.msg-flow-guide-ack')) return;
    var escFn = window._escHtml || function (s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    for (var i = 0; i < conv.length; i++) {
        var m = conv[i];
        if (!m || !m._guideAck) continue;
        if (m._floor !== floorNum) continue;
        // 引导注入块（⚡）
        if (m._guideText) {
            var injectEl = document.createElement('div');
            injectEl.className = 'msg-flow-guide-inject';
            injectEl.innerHTML = '<div class="msg-flow-guide-hdr"><span class="msg-flow-icon">\u26a1</span> \u5f15\u5bfc\u4fe1\u606f</div><div class="msg-flow-guide-body">' + escFn(m._guideText) + '</div>';
            contentWrap.insertBefore(injectEl, contentWrap.firstChild);
        }
        // 引导确认块（✅）
        var ackText = (m.content || '\u5df2\u6536\u5230\u5f15\u5bfc').replace(/^\u2705\s*/, '').trim();
        var ackEl = document.createElement('div');
        ackEl.className = 'msg-flow-guide-ack';
        ackEl.innerHTML = '<div class="msg-flow-guide-ack-hdr"><span class="msg-flow-icon">\u2705</span> Guide received</div><div class="msg-flow-guide-ack-body">' + escFn(ackText || '\u5df2\u6536\u5230\u5f15\u5bfc') + '</div>';
        contentWrap.insertBefore(ackEl, contentWrap.firstChild);
    }
}

// ═══ 暴露给 card-pool.js 跨模块访问 ═══
window._initA1Block = _initA1Block;
window._initClockBlock = _initClockBlock;
window.renderMarkdown = renderMarkdown;
window.getUserDisplayContent = getUserDisplayContent;
window._countRooms = _countRooms;
window._updateA1Row1 = _updateA1Row1;
window.drawPie = drawPie;
window._showPieTooltip = _showPieTooltip;
window._hidePieTooltip = _hidePieTooltip;
window._restoreGuideBlocksToContentWrap = _restoreGuideBlocksToContentWrap;

// ═══ 崩溃防护：窗口关闭前阻塞等待楼层数据写盘完成 ═══
//   ⚠ 不用 fire-and-forget：之前 _saveAgentQuestData 是 async，不 await 的话
//     主进程 500ms 后 process.exit(0) 可能截断 JSON 写入，导致 all.json 半截。
//     改为 e.preventDefault() 挡住窗口销毁，等 save 完成或 2 秒超时才放行。
window.addEventListener('beforeunload', function (e) {
    var _ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    var _qid = (typeof questActiveId !== 'undefined') ? questActiveId : null;
    if (!_ag || !_qid) return;
    // 压缩中 → 标记异常供下次启动修复
    if (_ag._compressing && _ag._ctx) {
        _ag._uncleanShutdown = true;
        try { console.warn('[beforeunload] agent was compressing — marked unclean'); } catch (_) { }
    }
    // 阻挡窗口销毁直到保存完成（或超时）
    e.preventDefault();
    e.returnValue = '';  // Chrome 要求
    var _closed = false;
    var _finish = function () {
        if (_closed) return;
        _closed = true;
        try { window.close(); } catch (_) { }
    };
    if (typeof _saveAgentQuestData === 'function') {
        _saveAgentQuestData(_qid, _ag, _ag._currentFloorNum || 0).then(_finish).catch(_finish);
    } else {
        _finish();
    }
    setTimeout(_finish, 2000);
});
