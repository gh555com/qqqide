'use strict';
// \u2550\u2550\u2550 panel-send.js \u2550\u2550\u2550
// sendMessage, input helpers, event handlers, window exports

// ★ skipFloorCreation: true=恢复到死胡同楼层（不建新目录/不增 floorNum）
async function sendMessage(content, opts) {
    // ★ 管线入口：统一构建 SendIntent → _executeSend
    //   兼容旧调用: sendMessage() / sendMessage(true) / sendMessage(false)
    if (content === undefined || content === true || content === false) {
        var legacySkip = (content === true);
        content = getInputText().trim();
        opts = {
            type: legacySkip ? 'recovery-0house' : 'normal',
            images: null,  // pendingImages 由 _executeSend 内部处理
            tierIndex: selectedTier
        };
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
    while (_box._renderedCount < _log.length) {
        var _entry = _log[_box._renderedCount];
        var _row = document.createElement('div');
        _row.className = 'qe-row';
        _row.textContent = (_entry.time || '') + '  ' + (_entry.reason || '');
        _box.appendChild(_row);
        _box._renderedCount++;
    }

    // ★ 更新 / 创建「继续任务」链接（始终在红框底部）
    //   若下一楼层已存在（floorNum+1 有DOM）→ 链接变灰只读（历史记录）

    // ★ 全局唯一：先灰化本 quest 所有旧楼层的活跃链接（防多链接同时出现）
    if (agent._questErrorDivByFloor) {
        for (var _fn in agent._questErrorDivByFloor) {
            var _fnNum = parseInt(_fn);
            if (isNaN(_fnNum) || _fnNum !== _floorNum) continue;
            var _oldBox = agent._questErrorDivByFloor[_fn];
            if (!_oldBox || !_oldBox.isConnected) continue;
            var _oldLink = _oldBox._continueLink;
            if (_oldLink && _oldLink.isConnected && !_oldLink.classList.contains('msg-err-resolved')) {
                _oldLink.className = 'msg-err-continue msg-err-resolved';
                _oldLink.style.cssText = 'text-decoration:none;cursor:default;color:var(--muted);margin-left:4px;opacity:0.5;';
                _oldLink.textContent = (typeof _i === 'function') ? _i('ai.error.floorRecovered', '已恢复') : '已恢复';
                _oldLink.onclick = function (e) { e.preventDefault(); };
            }
        }
    }

    var _hasNextFloor = false;
    var _card3 = cardPool && cardPool.getActive();
    if (_card3 && _card3.floorDOM && _card3.floorDOM[_floorNum + 1]) _hasNextFloor = true;

    var _link = _box._continueLink;
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
        if (_hasNextFloor) {
            _link.className = 'msg-err-continue msg-err-resolved';
            _link.style.cssText = 'text-decoration:none;cursor:default;color:var(--muted);margin-left:4px;opacity:0.5;';
            _link.textContent = (typeof _i === 'function') ? _i('ai.error.floorRecovered', '已恢复') : '已恢复';
            _link.onclick = function (e) { e.preventDefault(); };  // 无操作
        } else {
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
        }
        if (!_link.isConnected) {
            _box.appendChild(_link);
        }
        _box._continueLink = _link;
    } else {
        // 已存在链接 — 检查是否需要更新（从活跃变已恢复 或 从恢复中恢复）
        if (!agent._deferRenderUntilHouse1) {
            if (_hasNextFloor) {
                _link.className = 'msg-err-continue msg-err-resolved';
                _link.style.cssText = 'text-decoration:none;cursor:default;color:var(--muted);margin-left:4px;opacity:0.5;';
                _link.textContent = (typeof _i === 'function') ? _i('ai.error.floorRecovered', '已恢复') : '已恢复';
                _link.onclick = function (e) { e.preventDefault(); };
            } else {
                _link.style.display = '';
                _link.className = 'msg-err-continue';
                _link._qqqRecoveryBusy = false;
                _link.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
            }
        }
    }
}

// ★ 清除红框中的「继续任务」链接/白块（恢复成功后转为"已恢复"灰色不可点，不删） ═══
// ★ floorNum: 可选，显式传入时使用，否则回退 agent._currentFloorNum
function _hideRecoveryLink(agent, floorNum) {
    if (!agent) return;
    var _link = null;
    var _floorNum = (floorNum != null) ? floorNum : agent._currentFloorNum;
    // 路径1：分楼层红框链接
    if (agent._questErrorDivByFloor && agent._questErrorDivByFloor[_floorNum] && agent._questErrorDivByFloor[_floorNum]._continueLink && agent._questErrorDivByFloor[_floorNum]._continueLink.isConnected) {
        _link = agent._questErrorDivByFloor[_floorNum]._continueLink;
    }
    // 路径2：通过 _recoveryLinkEl
    if (!_link && agent._recoveryLinkEl && agent._recoveryLinkEl.isConnected) {
        _link = agent._recoveryLinkEl;
        agent._recoveryLinkEl = null;
    }
    // 路径3：从当前楼层 gap 中查找（兜底，搜动画 + 非动画两类 class）
    if (!_link && _floorNum) {
        var _card = cardPool && cardPool.getActive();
        if (_card && _card.floorDOM && _card.floorDOM[_floorNum] && _card.floorDOM[_floorNum].aiEl) {
            var _next = _card.floorDOM[_floorNum].aiEl.nextElementSibling;
            while (_next) {
                if (_next.classList && _next.classList.contains('floor-gap')) {
                    _link = _next.querySelector('.msg-err-recovery-light, .msg-err-continue');
                    break;
                }
                _next = _next.nextElementSibling;
            }
        }
    }
    // 路径4：遍历所有楼层 errorDiv（兜底：_currentFloorNum 可能已变更为新楼层）
    if (!_link && agent._questErrorDivByFloor) {
        for (var _fn4 in agent._questErrorDivByFloor) {
            var _bx4 = agent._questErrorDivByFloor[_fn4];
            if (_bx4 && _bx4.isConnected && _bx4._continueLink && _bx4._continueLink.isConnected && !_bx4._continueLink.classList.contains('msg-err-resolved')) {
                _link = _bx4._continueLink;
                break;
            }
        }
    }
    if (!_link) return;
    // ★ 转为"已恢复"灰色不可点（保留红框历史，不删除）
    _link.className = 'msg-err-continue msg-err-resolved';
    _link.style.cssText = 'text-decoration:none;cursor:default;color:var(--muted);margin-left:4px;opacity:0.5;';
    _link.textContent = (typeof _i === 'function') ? _i('ai.error.floorRecovered', '已恢复') : '已恢复';
    _link._qqqRecoveryDone = true;
    _link._qqqRecoveryBusy = false;
    _link._qqqRecoveryOrigText = '';
    _link.onclick = function (e) { e.preventDefault(); };
    // ★ 清理引用
    if (agent._questErrorDivByFloor && agent._questErrorDivByFloor[_floorNum]) {
        agent._questErrorDivByFloor[_floorNum]._continueLink = null;
    }
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

    // 1. 标记恢复中
    agent._recoveryInProgress = true;
    agent._recoveryStartPerf = performance.now();
    agent._deferRenderUntilHouse1 = true;
    agent._recoveryLinkEl = linkEl;

    // 2. "继续任务"文字 → 光块（同一 <a> 元素，不删不隐）
    if (linkEl) {
        linkEl._qqqRecoveryOrigText = linkEl.textContent;
        linkEl.textContent = '▌';
        linkEl.className = 'msg-err-recovery-light';
        linkEl.style.cssText = '';
        linkEl._qqqRecoveryBusy = true;
    }

    // 3. 禁用按钮
    if ($sendBtn) $sendBtn.disabled = true;
    if ($guideBtn) $guideBtn.disabled = true;
    if ($queueBtn) $queueBtn.disabled = true;

    // 4. ★ 分叉：0-house → 同楼层重试 / N-house → 新楼层
    var _hasHouses = agent._houses && agent._houses.length > 0;
    if (_hasHouses) {
        _attemptRecoverySendNewFloor(questId, agent, linkEl);
    } else {
        _attemptRecoverySend(questId, agent, linkEl);
    }
}

async function _attemptRecoverySend(questId, agent, linkEl) {
    var _totalElapsed = performance.now() - agent._recoveryStartPerf;
    if (_totalElapsed > _RECOVERY_MAX_TOTAL_MS) {
        _finishRecovery(linkEl, agent, false);
        return;
    }

    // ★ 守卫：当前 quest 切走了 → 放弃
    if (questActiveId !== questId) {
        _finishRecovery(linkEl, agent, false);
        return;
    }

    // ★ 保存原始 _lastUserInput（agent.send 会覆写，恢复后需还原）
    var _savedLastUserInput = agent._lastUserInput;

    // ★ 恢复消息：含错误历史让 AI 看到中断原因（_system:true 不入粉色气泡）
    var _recoveryText = '网络已恢复，请继续。';
    var _allLogs = [];
    if (agent._questErrorLogByFloor) {
        for (var _fn in agent._questErrorLogByFloor) {
            var _fl = agent._questErrorLogByFloor[_fn];
            for (var _ei = 0; _ei < _fl.length; _ei++) {
                _allLogs.push(_fl[_ei]);
            }
        }
    }
    if (_allLogs.length > 0) {
        _recoveryText = '网络恢复重连。此前中断记录：';
        for (var _ei2 = 0; _ei2 < _allLogs.length; _ei2++) {
            _recoveryText += '｜' + _allLogs[_ei2].time + ' ' + _allLogs[_ei2].reason;
        }
        _recoveryText += '｜请基于上下文继续完成原始任务。';
    }

    // ★ 保存用户原文（零 $input 污染：恢复消息走管线 content 参数）
    var _savedInput = $input.value;

    // ★ 配置恢复标记：
    agent._isRecovery = true;
    agent._inRecoverySend = false;
    agent._recoveryInProgress = false;

    try {
        // ★ 直接通过管线发送，显式传入恢复消息（零 $input 污染）
        var _intent = _buildSendIntent(questId, _recoveryText, {
            type: 'recovery-0house',
            isRecovery: true,
            savedLastUserInput: _savedLastUserInput,
        });
        await _executeSend(_intent);
        // ★ 恢复 _lastUserInput（agent.send 在 recovery 时不覆写，此乃兜底）
        if (agent._lastUserInput && agent._lastUserInput.text === _recoveryText) {
            agent._lastUserInput = _savedLastUserInput;
        }
        if (agent._stopState === 'fatal') {
            _finishRecovery(linkEl, agent, false);
        } else {
            _finishRecovery(linkEl, agent, true);
        }
    } catch (_e) {
        agent._lastUserInput = _savedLastUserInput;
        agent.setStopState('fatal');
        agent._floorFatal = true;
        _finishRecovery(linkEl, agent, false);
    } finally {
        agent._inRecoverySend = false;
        $input.value = _savedInput;
        if (typeof saveQuestUIState === 'function') saveQuestUIState(questId);
    }
}

// ★ N-house 恢复：创建新楼层（封顶旧楼层，新粉色气泡）
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

    // ★ 恢复消息：含错误历史让 AI 看到中断原因（_system:true 不入粉色气泡）
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

    // ★ 保存用户原文（零 $input 污染）
    var _savedInput = $input.value;

    // ★ 配置恢复标记：
    agent._isRecovery = true;
    agent._inRecoverySend = false;
    agent._recoveryInProgress = false;

    try {
        var _intent = _buildSendIntent(questId, _recoveryText, {
            type: 'recovery-nhouse',
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
        // ★ 持久化用户原文（同 _attemptRecoverySend）
        if (typeof saveQuestUIState === 'function') saveQuestUIState(questId);
    }
}

function _finishRecovery(linkEl, agent, succeeded) {
    agent._recoveryInProgress = false;
    agent._recoveryStartPerf = 0;
    agent._deferRenderUntilHouse1 = false;  // ★ 核爆清除：防止残留标记导致下一次正常 send 走错路

    if (succeeded) {
        // ★ 成功：彻底清除链接/白块 DOM + 动画 + 引用（由 _hideRecoveryLink 统一处理）
        if (typeof _hideRecoveryLink === 'function') _hideRecoveryLink(agent);
    } else {
        // ★ 失败：恢复链接
        // ★ 核心：若已有更新楼层（N-house 恢复已建了新楼层并挂了新红框），
        //   则此旧链接应灰化而非重激活，防止同一 quest 出现两个「继续任务」
        var _newerFloorExists = false;
        if (agent._questErrorDivByFloor) {
            var _curFloor2 = agent._currentFloorNum;
            for (var _fn2 in agent._questErrorDivByFloor) {
                if (parseInt(_fn2) > _curFloor2) { _newerFloorExists = true; break; }
            }
        }
        if (_newerFloorExists) {
            // N-house 恢复：新楼层已有红框+链接，旧链接灰化
            if (linkEl && linkEl.isConnected) {
                linkEl.className = 'msg-err-continue msg-err-resolved';
                linkEl.style.cssText = 'text-decoration:none;cursor:default;color:var(--muted);margin-left:4px;opacity:0.5;';
                linkEl.textContent = (typeof _i === 'function') ? _i('ai.error.floorRecovered', '已恢复') : '已恢复';
                linkEl.onclick = function (e) { e.preventDefault(); };
                linkEl._qqqRecoveryDone = true;
                linkEl._qqqRecoveryBusy = false;
            }
            // ★ 防御：灰化所有非当前楼层链接
            if (agent._questErrorDivByFloor) {
                for (var _fn3 in agent._questErrorDivByFloor) {
                    if (parseInt(_fn3) === _curFloor2) continue;
                    var _bx3 = agent._questErrorDivByFloor[_fn3];
                    if (_bx3 && _bx3.isConnected && _bx3._continueLink && _bx3._continueLink.isConnected && !_bx3._continueLink.classList.contains('msg-err-resolved')) {
                        _bx3._continueLink.className = 'msg-err-continue msg-err-resolved';
                        _bx3._continueLink.style.cssText = 'text-decoration:none;cursor:default;color:var(--muted);margin-left:4px;opacity:0.5;';
                        _bx3._continueLink.textContent = (typeof _i === 'function') ? _i('ai.error.floorRecovered', '已恢复') : '已恢复';
                        _bx3._continueLink.onclick = function (e) { e.preventDefault(); };
                    }
                }
            }
        } else {
            // 0-house 恢复：同楼层重试，恢复链接为可点击
            if (linkEl && linkEl.isConnected) {
                linkEl._qqqRecoveryDone = false;
                linkEl.textContent = linkEl._qqqRecoveryOrigText ||
                    ((typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务');
                linkEl.className = 'msg-err-continue';
                linkEl.style.cssText = 'text-decoration:underline;cursor:pointer;color:var(--accent-color,#4a9eff);margin-left:4px;';
                linkEl._qqqRecoveryBusy = false;
                linkEl._qqqRecoveryOrigText = '';
            }
        }
        // ★ 清理引用（即使 DOM 已断连也要 null，防僵尸引用）
        agent._recoveryLinkEl = null;
        if ($sendBtn) $sendBtn.disabled = true;
        if ($guideBtn) $guideBtn.disabled = true;
        if ($queueBtn) $queueBtn.disabled = true;
    }
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
        $messages.scrollBy({ top: -$messages.clientHeight * 0.35, behavior: 'smooth' });
        _showFloorIndicatorBriefly();
    } else if (key === '2') {
        e.preventDefault();
        $messages.scrollBy({ top: $messages.clientHeight * 0.35, behavior: 'smooth' });
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

// \u2550\u2550\u2550 \u66b4\u9732\u7ed9 card-pool.js \u8de8\u6a21\u5757\u8bbf\u95ee \u2550\u2550\u2550
window._initA1Block = _initA1Block;
window._initClockBlock = _initClockBlock;
window.renderMarkdown = renderMarkdown;
window.getUserDisplayContent = getUserDisplayContent;
window._countRooms = _countRooms;
window._updateA1Row1 = _updateA1Row1;
window.drawPie = drawPie;
window._showPieTooltip = _showPieTooltip;
window._hidePieTooltip = _hidePieTooltip;

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
