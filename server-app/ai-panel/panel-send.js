// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';
// \u2550\u2550\u2550 panel-send.js \u2550\u2550\u2550
// sendMessage, input helpers, event handlers, window exports

// ★ 管线入口：统一构建 SendIntent → _executeSend
//   _execSendBusyAgent 使不同 quest 各自独立，不互相阻塞
async function sendMessage(content, opts) {
    // ★ per-quest 串行执行器（2026-08-11 重构）：内部入口直接入链（排队语义，永不丢消息），
    //   同 quest 串行执行（链追加原子 → 零并发窗口），不同 quest 并行（三通开工保留）；
    //   用户交互入口（Enter/发送按钮）的忙检查在 panel-input.js _sendActive（内容保留编辑框）
    if (content === undefined) {
        content = getInputText().trim();
        opts = { type: 'normal', images: null, tierIndex: selectedTier };
    }
    opts = opts || {};
    var intent = _buildSendIntent(questActiveId, content, opts);
    return _enqueueSend(questActiveId, intent);
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
// ═══ V14: 纯定位 — 在指定楼层创建/定位 floor-gap + .msg-quest-error DOM ═══
// 返回 box DOM 元素，不处理内容填充。锚点严格用 card.floorDOM[floorNum].aiEl
function _ensureErrorBoxDOM(agent, floorNum) {
    if (!agent || !cardPool) return null;
    var _card = cardPool.getActive();
    if (!_card || !_card.floorDOM) return null;
    var _fDom = _card.floorDOM[floorNum];
    if (!_fDom || !_fDom.aiEl) return null;

    var _aiEl = _fDom.aiEl;
    // 找或建 floor-gap（紧接 aiEl 之后）
    var _gap = _aiEl.nextElementSibling;
    while (_gap && _gap.nodeType === 1 && !_gap.classList.contains('floor-gap')) {
        _gap = _gap.nextElementSibling;
    }
    if (!_gap || !_gap.classList || !_gap.classList.contains('floor-gap')) {
        _gap = document.createElement('div');
        _gap.className = 'floor-gap';
        _aiEl.parentNode.insertBefore(_gap, _aiEl.nextSibling);
    }
    // 找或建 .msg-quest-error
    var _box = _gap.querySelector('.msg-quest-error');
    if (!_box) {
        _box = document.createElement('div');
        _box.className = 'msg-quest-error';
        _gap.appendChild(_box);
    }
    _box._floorNum = floorNum;
    return _box;
}

// ═══ V14: 统一数据驱动渲染 — 从 agent._questErrorState 重建全部红框 ═══
function _renderAllErrorBoxes(agent) {
    if (!agent || !agent._questErrorState) return;
    var _floors = Object.keys(agent._questErrorState).map(Number).sort(function (a, b) { return a - b; });
    for (var _fi = 0; _fi < _floors.length; _fi++) {
        var _fn = _floors[_fi];
        var _st = agent._questErrorState[_fn];
        if (!_st || !_st.log || _st.log.length === 0) continue;

        var _box = _ensureErrorBoxDOM(agent, _fn);
        if (!_box) continue;

        // ★ 同步 state 到 DOM 标记
        _box._capped = !!_st.capped;

        // ★ 全量重建行（清空 → 从 state.log 重建）
        var _link = _box._continueLink;
        _box.innerHTML = '';
        _box._renderedCount = 0;

        for (var _li = 0; _li < _st.log.length; _li++) {
            var _entry = _st.log[_li];
            var _row = document.createElement('div');
            _row.className = 'qe-row';
            _row.textContent = (_entry.time || '') + '  ' + (_entry.reason || '');
            _box.appendChild(_row);
            _box._renderedCount++;
        }

        // ★ capped → 不渲染链接
        if (_st.capped) {
            _box._continueLink = null;
            continue;
        }

        // ★ V14: 封顶检测：下一楼层 DOM 已存在且可见且非恢复中
        var _card2 = cardPool && cardPool.getActive();
        var _hasNextFloor = false;
        if (_card2 && _card2.floorDOM && _card2.floorDOM[_fn + 1]) {
            var _nextAi = _card2.floorDOM[_fn + 1].aiEl;
            // ★ Path B: recovery 隐藏楼层不算（display:none 表示还未揭示给用户）
            if (_nextAi && _nextAi.style.display !== 'none' && _nextAi.offsetParent !== null) _hasNextFloor = true;
        }
        if (_hasNextFloor && !agent._stateMeta.deferRenderUntilHouse1 && !agent._stateMeta.recoveryInProgress) {
            _st.capped = true;
            _box._capped = true;
            _box._continueLink = null;
            continue;
        }

        // ★ 创建「继续任务」链接
        var _existingLink = _box._continueLink;
        if (!_existingLink || !_existingLink.isConnected) {
            _existingLink = document.createElement('a');
            _existingLink.href = '#';
            _existingLink.className = 'msg-err-continue';
            _existingLink.style.cssText = 'text-decoration:underline;cursor:pointer;color:var(--accent-color,#4a9eff);margin-left:4px;';
            _existingLink._qqqQuestId = questActiveId;
            _existingLink._qqqAgent = agent;
            _existingLink.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (this._qqqRecoveryBusy) return;
                this._qqqRecoveryBusy = true;
                _startRecovery(this._qqqQuestId, this._qqqAgent, this);
            };
        }
        _existingLink.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
        if (!_existingLink.isConnected) _box.appendChild(_existingLink);
        _box._continueLink = _existingLink;
    }

    // ★ 清理 state 中已不存在 DOM 的楼层（card 被清后 floorDOM 无对应 aiEl）
    var _card3 = cardPool && cardPool.getActive();
    if (_card3) {
        var _newState = {};
        for (var _fn2 in agent._questErrorState) {
            if (_card3.floorDOM && _card3.floorDOM[_fn2] && _card3.floorDOM[_fn2].aiEl) {
                _newState[_fn2] = agent._questErrorState[_fn2];
            }
        }
        agent._questErrorState = _newState;
    }
}

// ═══ @deprecated 旧 _renderQuestErrorBox — 兼容包装，逐步迁移到 _renderAllErrorBoxes ═══
function _renderQuestErrorBox(agent, aiDiv, floorNum) {
    // ★ V14: 忽略 aiDiv 参数，统一走数据驱动渲染
    var _floorNum = (floorNum != null) ? floorNum : (agent && agent._currentFloorNum);
    if (!agent || !_floorNum) return;

    // ★ 同步旧 _questErrorLogByFloor 到 _questErrorState（过渡期）
    if (!agent._questErrorState) agent._questErrorState = {};
    if (agent._questErrorLogByFloor && agent._questErrorLogByFloor[_floorNum]) {
        if (!agent._questErrorState[_floorNum]) {
            agent._questErrorState[_floorNum] = {
                log: agent._questErrorLogByFloor[_floorNum],
                capped: false,
                bubbleText: null
            };
        }
    }

    // ★ 若 state 中无此楼层数据则跳过
    var _st = agent._questErrorState[_floorNum];
    if (!_st || !_st.log || _st.log.length === 0) return;

    var _box = _ensureErrorBoxDOM(agent, _floorNum);
    if (!_box) return;

    _box._capped = !!_st.capped;

    // 追加新行（兼容增量调用）
    _box._renderedCount = _box._renderedCount || 0;
    while (_box._renderedCount < _st.log.length) {
        var _entry = _st.log[_box._renderedCount];
        var _row = document.createElement('div');
        _row.className = 'qe-row';
        _row.textContent = (_entry.time || '') + '  ' + (_entry.reason || '');
        var _cLink = _box._continueLink;
        _box.insertBefore(_row, _cLink || null);
        _box._renderedCount++;
    }

    // capped + link 逻辑
    if (_st.capped) {
        if (_box._continueLink && _box._continueLink.isConnected) _box._continueLink.remove();
        _box._continueLink = null;
        return;
    }

    var _card2 = cardPool && cardPool.getActive();
    var _hasNextFloor2 = false;
    if (_card2 && _card2.floorDOM && _card2.floorDOM[_floorNum + 1]) {
        var _nextAi2 = _card2.floorDOM[_floorNum + 1].aiEl;
        if (_nextAi2 && _nextAi2.style.display !== 'none' && _nextAi2.offsetParent !== null) _hasNextFloor2 = true;
    }
    if (_hasNextFloor2 && !agent._stateMeta.deferRenderUntilHouse1 && !agent._stateMeta.recoveryInProgress) {
        _st.capped = true;
        _box._capped = true;
        if (_box._continueLink && _box._continueLink.isConnected) _box._continueLink.remove();
        _box._continueLink = null;
        return;
    }

    var _link2 = _box._continueLink;
    if (!_link2 || !_link2.isConnected) {
        _link2 = _box.querySelector('.msg-err-continue');
        if (!_link2) {
            _link2 = document.createElement('a');
            _link2.href = '#';
            _link2.className = 'msg-err-continue';
            _link2.style.cssText = 'text-decoration:underline;cursor:pointer;color:var(--accent-color,#4a9eff);margin-left:4px;';
            _link2._qqqQuestId = questActiveId;
            _link2._qqqAgent = agent;
            _link2.onclick = function (e) {
                e.preventDefault(); e.stopPropagation();
                if (this._qqqRecoveryBusy) return;
                this._qqqRecoveryBusy = true;
                _startRecovery(this._qqqQuestId, this._qqqAgent, this);
            };
        }
        _link2.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
        if (!_link2.isConnected) _box.appendChild(_link2);
        _box._continueLink = _link2;
    } else if (!agent._stateMeta.deferRenderUntilHouse1) {
        _link2.style.display = '';
        _link2.className = 'msg-err-continue';
        _link2._qqqRecoveryBusy = false;
        _link2.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
    }
}

// ★ 封顶红框中的「继续任务」链接（整行 DOM 移除，不灰化不留字） ═══
// ★ V14: 数据驱动版 — 设 _questErrorState[fn].capped=true 后统一渲染
function _capRecoveryLink(agent, floorNum) {
    if (!agent) return;
    var _fn = (floorNum != null) ? floorNum : (agent._recoveryOriginFloor || agent._currentFloorNum);
    if (!_fn) return;

    // ★ V14: 数据驱动 — 找 _questErrorState 中未 capped 的楼层
    if (!agent._questErrorState) return;
    var _st = agent._questErrorState[_fn];
    if (!_st || _st.capped) {
        // 兜底遍历找未 capped 的活跃楼层
        for (var _f in agent._questErrorState) {
            if (!agent._questErrorState[_f].capped) { _st = agent._questErrorState[_f]; _fn = parseInt(_f); break; }
        }
    }
    if (!_st || _st.capped) {
        if (agent._stateMeta && agent._stateMeta.recoveryLinkEl && agent._stateMeta.recoveryLinkEl.isConnected) {
            agent._stateMeta.recoveryLinkEl.remove();
            agent._stateMeta.recoveryLinkEl = null;
        }
        return;
    }

    _st.capped = true;

    // ★ DOM 层：找红框 DOM 移除链接 + 标记 capped + 消最后分割线
    var _box = _ensureErrorBoxDOM(agent, _fn);
    if (_box) {
        if (_box._continueLink && _box._continueLink.isConnected) _box._continueLink.remove();
        _box._continueLink = null;
        _box._capped = true;
        // ★ 消除最后一行的分隔线（capped 后底部不再有链接行，回收 Y 轴空间）
        var _lastRow = _box.querySelector('.qe-row:last-of-type');
        if (_lastRow) _lastRow.style.borderBottom = 'none';
    }

    if (agent._stateMeta) agent._stateMeta.recoveryLinkEl = null;
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

    // 1. ★ 记录原始 fatal 楼层号（仅首次，不覆盖）+ 预封顶所有更旧的红框
    if (!agent._recoveryOriginFloor) agent._recoveryOriginFloor = agent._currentFloorNum;
    if (agent._questErrorState) {
        for (var _fn in agent._questErrorState) {
            if (parseInt(_fn) < agent._recoveryOriginFloor && !agent._questErrorState[_fn].capped && typeof _capRecoveryLink === 'function') {
                _capRecoveryLink(agent, parseInt(_fn));
            }
        }
    }

    // 2. 标记恢复中
    agent._recoveryInProgress = true;
    agent._recoveryStartPerf = performance.now();
    agent._deferRenderUntilHouse1 = true;
    agent._recoveryLinkEl = linkEl;

    // 3. "继续任务"文字 → █ 光块（█ 字符天生可视，CSS 只负责左右横跳）
    if (linkEl) {
        linkEl._qqqRecoveryOrigText = linkEl.textContent;
        linkEl.textContent = '\u2588';
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

// ★ 统一恢复：0-house → 同层重试；N-house → 封顶旧楼层 + 建新楼层
//   0-house 重试上限 3 次，超限永久封顶红框
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

    // ★ 分叉：0-house → 同层重试；N-house → 新楼层
    var _is0House = !agent._houses || agent._houses.length === 0;
    if (_is0House) {
        await _retrySameFloor(questId, agent, linkEl);
        return;
    }

    // ── N-house 路径（不变）：封顶旧楼层 + 建新楼层 ──

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
        agent._deferRenderUntilHouse1 = false;  // ★ V7 fix: 防极端异常路径残留
        $input.value = _savedInput;
        if (typeof saveQuestUIState === 'function') saveQuestUIState(questId);
    }
}

// ★ 0-house 同层重试（AI 从未启动过 → 同一楼层重发，不建新楼）
//   上限 3 次，超限永久封顶红框不再显示"继续任务"
async function _retrySameFloor(questId, agent, linkEl) {
    var _originFloor = agent._recoveryOriginFloor || agent._currentFloorNum || 0;

    // 1. 次数守卫
    if (!agent._recoveryRetryCount) agent._recoveryRetryCount = 0;
    if (agent._recoveryRetryCount >= 3) {
        if (typeof _capRecoveryLink === 'function') _capRecoveryLink(agent, _originFloor);
        _finishRecovery(linkEl, agent, false);
        try {
            if (parent && parent.qqqideQoast) parent.qqqideQoast.show(
                '已重试 3 次仍未成功，可能是计费/配额耗尽或服务器故障，请稍后再试',
                { type: 'error', duration: 5000 }
            );
        } catch (_) { }
        return;
    }
    agent._recoveryRetryCount++;

    // 2. 清旧错误日志（0-house 重试不垒行）
    if (agent._questErrorState) delete agent._questErrorState[_originFloor];
    if (agent._questErrorLogByFloor) delete agent._questErrorLogByFloor[_originFloor];
    if (agent.conversation) {
        for (var _ri = agent.conversation.length - 1; _ri >= 0; _ri--) {
            if (agent.conversation[_ri]._error && agent.conversation[_ri]._floor === _originFloor) {
                agent.conversation.splice(_ri, 1);
            }
        }
    }

    // 3. 取最新 linkEl（防 _renderAllErrorBoxes 重建红框后旧 linkEl 脱离 DOM）
    var _box = typeof _ensureErrorBoxDOM === 'function' ? _ensureErrorBoxDOM(agent, _originFloor) : null;
    if (_box && _box._continueLink && _box._continueLink.isConnected) {
        linkEl = _box._continueLink;
        agent._recoveryLinkEl = linkEl;
    }

    // 4. linkEl → █ 光块
    if (linkEl && linkEl.isConnected) {
        linkEl._qqqRecoveryOrigText = linkEl.textContent;
        linkEl.textContent = '\u2588';
        linkEl.className = 'msg-err-recovery-light';
        linkEl.style.cssText = '';
        linkEl._qqqRecoveryBusy = true;
    }

    // 5. 用原消息走 _executeSend（forceFloorNum 跳过 nextFloorNum，复用旧楼层 DOM）
    var _userContent2 = agent._lastUserMsg || '';
    if (!_userContent2) {
        _finishRecovery(linkEl, agent, false);
        return;
    }

    agent._isRecovery = true;
    agent._inRecoverySend = false;
    agent._recoveryInProgress = false;

    var _savedInput2 = $input ? $input.value : '';

    try {
        var _intent = _buildSendIntent(questId, _userContent2, {
            type: 'recovery',
            isRecovery: true,
            forceFloorNum: _originFloor,  // ★ 同层重试：跳过 nextFloorNum
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
        agent._deferRenderUntilHouse1 = false;
        if ($input && _savedInput2 !== undefined) $input.value = _savedInput2;
        if (typeof saveQuestUIState === 'function') saveQuestUIState(questId);
    }
}

function _finishRecovery(linkEl, agent, succeeded) {
    agent._recoveryInProgress = false;
    agent._recoveryStartPerf = 0;
    agent._deferRenderUntilHouse1 = false;

    if (succeeded) {
        // ★ V1 fix: 保存原始 fatal 楼层号，清除 _error 消息防重启假复活
        var _originFloor = agent._recoveryOriginFloor || 0;
        agent._recoveryOriginFloor = 0;
        if (_originFloor > 0 && agent.conversation) {
            for (var _rci = 0; _rci < agent.conversation.length; _rci++) {
                var _rcm = agent.conversation[_rci];
                if (_rcm._error && _rcm._floor === _originFloor) {
                    _rcm._recovered = true;
                }
            }
            // 清除内存错误日志（防 _renderQuestErrorBox 重复渲染）
            if (agent._questErrorLogByFloor && agent._questErrorLogByFloor[_originFloor]) {
                delete agent._questErrorLogByFloor[_originFloor];
            }
        }
        // ★ V14 fix: 传 _originFloor 防 _recoveryOriginFloor 已清零导致误伤新楼层
        if (typeof _capRecoveryLink === 'function') _capRecoveryLink(agent, _originFloor);
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
    // ★ V14: 从 _questErrorState 遍历未封顶楼层
    if (ag._questErrorState) {
        for (var _fn in ag._questErrorState) {
            if (!ag._questErrorState[_fn].capped) {
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
// ★ 2026-08-14 F12 q1 附件静默丢失事故：Enter 立即反馈（08-10）已同步清空 $input，
//   管线阶段再读 $input.value 恒空 → 附件零注入，AI 只收到原始 📎"path" 文本。
//   chips 必须从「发送捕获文本」解析：getInputChipPaths(sourceText)，缺省才回退 $input.value。
//   同时正则加固：旧 [\ud83d\udcce\ud83d\udcc1] 无 /u 匹配的是孤立代理半元，现精确匹配整对 emoji。
function getInputChipPaths(sourceText) {
    var src = (sourceText !== undefined && sourceText !== null) ? sourceText : $input.value;
    var paths = [];
    var re = /(?:\ud83d\udcce|\ud83d\udcc1)"([^"]+)"/g;
    var m;
    while ((m = re.exec(src)) !== null) {
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
    // ★ L1 守卫：仅拒绝 ASCII 直双引号 " (U+0022)，NTFS 禁用此字符 → 分隔符与路径零碰撞
    if (filePath.indexOf('"') !== -1) {
        try { if (parent && parent.qqqideQoast) parent.qqqideQoast.show('路径含不兼容字符，无法附加', { type: 'warning', duration: 4000 }); } catch (_) { }
        return;
    }
    // ★ 准许多次注入同一文件（如先喂 L1-L20 再喂 L500-L520，自然对话中多次提及同一文件）
    if (typeof isDir !== 'boolean') {
        isDir = !filePath.match(/\.[a-zA-Z0-9]+$/);
    }
    var icon = isDir ? '\ud83d\udcc1' : '\ud83d\udcce';
    var rangeStr = lineRange ? ' ' + lineRange : '';
    var tag = icon + '"' + filePath + '"' + rangeStr + ' ';
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
        // 引导确认块（✅）— 先插入，作为锚点
        var ackText = (m.content || '\u5df2\u6536\u5230\u5f15\u5bfc').replace(/^\u2705\s*/, '').trim();
        var ackEl = document.createElement('div');
        ackEl.className = 'msg-flow-guide-ack';
        ackEl.innerHTML = '<div class="msg-flow-guide-ack-hdr"><span class="msg-flow-icon">\u2705</span> Guide received</div><div class="msg-flow-guide-ack-body">' + escFn(ackText || '\u5df2\u6536\u5230\u5f15\u5bfc') + '</div>';
        contentWrap.insertBefore(ackEl, contentWrap.firstChild);
        // 引导注入块（⚡）— 插入到 ackEl 之前 → 红条在绿条上方
        if (m._guideText) {
            var injectEl = document.createElement('div');
            injectEl.className = 'msg-flow-guide-inject';
            injectEl.innerHTML = '<div class="msg-flow-guide-hdr"><span class="msg-flow-icon">\u26a1</span> \u5f15\u5bfc\u4fe1\u606f</div><div class="msg-flow-guide-body">' + escFn(m._guideText) + '</div>';
            contentWrap.insertBefore(injectEl, ackEl);
        }
    }
}

// ═══ 子弹按钮 — 粘贴板→磁盘文件→编辑框 📎 注入 ═══
// 子弹文件目录: {project}/_qqq/bullet/  上限 20MB FIFO 轮转
// 文件名: bullet_{本地时间戳}_{questId}_f{floorNum}.txt
// 写入后自动 insertChipAtCursor → 走已有附件管线 → ContentGateway 截断 → 饼干自动剥离
(function () {
    var _bulletBtn = document.getElementById('bullet-btn');
    if (!_bulletBtn) return;

    // ★ 子弹音效 — 预掷骰子，qa必播 → 1/3 qx(0.4~0.8s后) → 1/2 qs(qa结束后0.4~1s)
    function _bulletPlaySound() {
        var ASSET = '../assets/bullet/';
        // ★ 走主路音量
        var vol = 1.0;
        try { vol = parent.window.qqqAudio ? parent.window.qqqAudio.getMainVolume() : 1.0; } catch (_) { }
        var rollQx = Math.random() < 1 / 3;
        var rollQs = Math.random() < 0.5;
        var qxDelay = rollQx ? (400 + Math.random() * 400) : 0;
        var qsGap = rollQs ? (400 + Math.random() * 600) : 0;
        var qxFile = '';
        if (rollQx) {
            var qxPool = ['ric_conc-1.wav', 'ric_conc-2.wav', 'ric_metal-1.wav'];
            qxFile = ASSET + qxPool[Math.floor(Math.random() * 3)];
        }
        var qaFile = Math.random() < 0.5 ? ASSET + 'scout_fire-1.wav' : ASSET + 'g3sg1-fire-2.wav';
        // ★ 统一音频机器（主进程 AudioEngine）— 无 ended 事件，qs 用固定延迟（qa 为短枪声，~700ms 足够播完）
        var _bridge = parent.window && parent.window.qqqideBridge;
        if (_bridge && _bridge.audio) {
            _bridge.audio.play(qaFile, { volume: vol }).catch(function () { });
            if (rollQx) {
                setTimeout(function () {
                    _bridge.audio.play(qxFile, { volume: vol }).catch(function () { });
                }, qxDelay);
            }
            if (rollQs) {
                setTimeout(function () {
                    _bridge.audio.play(ASSET + 'p90_boltpull.wav', { volume: vol }).catch(function () { });
                }, 700 + qsGap);
            }
        }
    }

    // ★ 子弹动画 — 射出(50ms,3弹拖尾) → 装填滑入(350ms,塞贝尔变速)
    var _bulletAnimating = false;
    var _bulletClones = [];       // 拖尾克隆 DOM，供取消时清理
    var _bulletShootAnim = null;  // 射出 Web Animation
    var _bulletReloadTimer = null;// 装填 setTimeout id
    var _bulletReloadAnim = null; // 装填 Web Animation

    function _cancelBulletAnimation() {
        if (_bulletReloadTimer) { clearTimeout(_bulletReloadTimer); _bulletReloadTimer = null; }
        if (_bulletReloadAnim) { _bulletReloadAnim.cancel(); _bulletReloadAnim = null; }
        if (_bulletShootAnim) { _bulletShootAnim.cancel(); _bulletShootAnim = null; }
        for (var k = 0; k < _bulletClones.length; k++) {
            if (_bulletClones[k].parentNode) _bulletClones[k].parentNode.removeChild(_bulletClones[k]);
        }
        _bulletClones = [];
        var img = _bulletBtn.querySelector('img');
        if (img) {
            img.style.top = '';
            img.style.opacity = '';
            img.style.transform = '';
        }
        _bulletAnimating = false;
    }

    function _bulletAnimate() {
        if (_bulletAnimating) return;
        _bulletAnimating = true;
        var btn = _bulletBtn;
        var img = btn.querySelector('img');
        if (!img) { _bulletAnimating = false; return; }
        var btnH = btn.offsetHeight;
        if (btnH < 20) { _bulletAnimating = false; return; }

        var startPct = 60;                     // CSS top:60% = 靠下 2/5
        var startY = btnH * startPct / 100;
        var endY = -30;
        var travelDist = startY - endY;
        var gap = Math.max(travelDist / 3, 6);

        var src = img.src;
        var baseOpacity = img.style.opacity || '0.75';
        var baseFilter = img.style.filter || '';

        // ── Phase 1: 射出 (50ms, 3弹拖尾) ──
        _bulletClones = [];
        for (var i = 1; i <= 2; i++) {
            var c = document.createElement('img');
            c.src = src;
            c.style.cssText = 'position:absolute;left:50%;transform:translate(-50%,-50%);width:auto;height:auto;pointer-events:none;z-index:5;';
            c.style.top = (startY - gap * i) + 'px';
            c.style.opacity = (0.55 - i * 0.18);
            if (baseFilter) c.style.filter = baseFilter;
            btn.appendChild(c);
            c.animate([
                { top: (startY - gap * i) + 'px', opacity: parseFloat(c.style.opacity) },
                { top: (endY - gap * i) + 'px', opacity: 0 }
            ], { duration: 50, easing: 'linear', fill: 'forwards' });
            _bulletClones.push(c);
        }

        _bulletShootAnim = img.animate([
            { top: startY + 'px', opacity: baseOpacity },
            { top: endY + 'px', opacity: 0 }
        ], { duration: 50, easing: 'linear', fill: 'forwards' });

        // ── Phase 2: 装填滑入 (350ms, 塞贝尔变速) ──
        _bulletReloadTimer = setTimeout(function () {
            _bulletReloadTimer = null;
            // 清理拖尾克隆
            for (var k = 0; k < _bulletClones.length; k++) {
                if (_bulletClones[k].parentNode) _bulletClones[k].parentNode.removeChild(_bulletClones[k]);
            }
            _bulletClones = [];
            // 取消射出动画，复位 img 到下方
            if (_bulletShootAnim) { _bulletShootAnim.cancel(); _bulletShootAnim = null; }
            // ★ 重读 btnH：编辑框高度可能在动画期间变化了
            var curH = btn.offsetHeight;
            var curStartY = curH * startPct / 100;
            img.style.top = (curH + 16) + 'px';
            img.style.opacity = '0.25';

            _bulletReloadAnim = img.animate([
                { top: (curH + 16) + 'px', opacity: 0.25 },
                { top: curStartY + 'px', opacity: baseOpacity }
            ], {
                duration: 350,
                easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
                fill: 'forwards'
            });
            _bulletReloadAnim.onfinish = function () {
                //  取消动画释放 fill-mode  CSS top:60% 重新生效
                if (_bulletReloadAnim) { _bulletReloadAnim.cancel(); }
                _bulletReloadAnim = null;
                img.style.top = '';
                img.style.opacity = baseOpacity;
                img.style.transform = '';
                _bulletAnimating = false;
            };
        }, 60);
    }

    // ★ ResizeObserver：编辑框高度变化 → 子弹位置恒定在 2/5
    //   非动画时 CSS top:60% 自动处理；动画中则取消并重启动画以适配新高度
    var _lastBulletBtnH = _bulletBtn.offsetHeight;
    var _bulletResizeObs = new ResizeObserver(function () {
        var newH = _bulletBtn.offsetHeight;
        if (newH === _lastBulletBtnH) return;
        _lastBulletBtnH = newH;
        if (_bulletAnimating) {
            _cancelBulletAnimation();
            // 等 DOM 稳定后重启动画（微小延迟防连续 resize 抖动）
            setTimeout(function () { _bulletAnimate(); }, 30);
        }
        // 非动画时：CSS top:60% 自动跟随，无需 JS 干预
    });
    _bulletResizeObs.observe(_bulletBtn);
    _bulletBtn.onclick = async function () {
        if (!_hasMainProject()) { _triggerSelectMainProject(); return; }

        // 1. 读粘贴板 — 走 IPC bridge（Electron 主进程 clipboard），绕过 iframe 权限限制
        var clipText = '';
        try {
            var b = _getBridge();
            if (b && b.clipboard && b.clipboard.readText) {
                clipText = await b.clipboard.readText();
            } else {
                clipText = await navigator.clipboard.readText();
            }
        } catch (e) {
            try { if (parent && parent.qqqideQoast) parent.qqqideQoast.show('无法读取剪贴板，请授予权限后重试', { type: 'warning', duration: 4000 }); } catch (_) { }
            return;
        }
        if (!clipText || !clipText.trim()) {
            try { if (parent && parent.qqqideQoast) parent.qqqideQoast.show('剪贴板为空，请先复制内容', { type: 'info', duration: 3000 }); } catch (_) { }
            return;
        }

        // 2. 硬帽 3MB，超则取首尾各1.5MB
        var MAX_BULLET = 3 * 1024 * 1024;
        if (clipText.length > MAX_BULLET) {
            var HALF = MAX_BULLET / 2;
            clipText = clipText.slice(0, HALF) + '\n\n... [中间已截断, 原始 ' + Math.round(clipText.length / 1024) + 'KB] ...\n\n' + clipText.slice(-HALF);
        }

        // 3. 项目路径
        var root = '';
        try { if (typeof questStore !== 'undefined' && questStore.getProjectRoot) root = questStore.getProjectRoot(); } catch (_) { }
        if (!root && typeof _workspaceRoot !== 'undefined') root = _workspaceRoot;
        if (!root) return;
        root = root.replace(/\\/g, '/').replace(/\/$/, '');

        // 4. 文件名：本地时区时间戳 + quest + floor
        var now = new Date();
        var _p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        var ts = now.getFullYear() + _p2(now.getMonth() + 1) + _p2(now.getDate())
            + '_' + _p2(now.getHours()) + _p2(now.getMinutes()) + _p2(now.getSeconds());
        var qid = (typeof questActiveId !== 'undefined' && questActiveId) ? questActiveId : 'draft';
        var floorNum = 0;
        try { if (typeof _activeAgent !== 'undefined' && _activeAgent && _activeAgent._currentFloorNum) floorNum = _activeAgent._currentFloorNum; } catch (_) { }
        var filename = 'bullet_' + ts + '_' + qid + '_f' + floorNum + '.txt';
       var bulletDir = root + '/_qqq/bullet';;
        var filePath = bulletDir + '/' + filename;

        // 5. Bridge
        var bridge = _getBridge();
        if (!bridge) return;

        try {
            // 确保目录
            var dirExists = false;
            try { await bridge.fs.stat(bulletDir); dirExists = true; } catch (_) { }
            if (!dirExists) await bridge.fs.mkdir(bulletDir);

            // 轮转：20MB FIFO，mtime 升序删最老
            var BULLET_CAP = 20 * 1024 * 1024;
            try {
                var entries = await bridge.fs.list(bulletDir);
                var files = [];
                var totalSize = 0;
                for (var ei = 0; ei < entries.length; ei++) {
                    var ent = entries[ei];
                    if (ent.isDir) continue;
                    var fp = bulletDir + '/' + ent.name;
                    try {
                        var st = await bridge.fs.stat(fp);
                        files.push({ path: fp, size: st.size || 0, mtime: st.mtime || 0 });
                        totalSize += st.size || 0;
                    } catch (_) { }
                }
                files.sort(function (a, b) { return a.mtime - b.mtime; });
                while (files.length > 0 && totalSize + clipText.length > BULLET_CAP) {
                    var oldest = files.shift();
                    try { await bridge.fs.remove(oldest.path); totalSize -= oldest.size; } catch (_) { }
                }
            } catch (_) { }

            // 6. 原子写
            await bridge.fs.write(filePath, clipText);

            // 7. 注入编辑框 — 走已有 insertChipAtCursor → 📎"path" 格式
            if (typeof insertChipAtCursor === 'function') insertChipAtCursor(filePath, false);

            // 8. 音效 + 动画
            _bulletPlaySound();
            _bulletAnimate();

            // 9. Qoast
            var sizeKB = Math.round(clipText.length / 1024);
            var sizeStr = sizeKB >= 1024 ? (sizeKB / 1024).toFixed(1) + 'MB' : sizeKB + 'KB';
            try { if (parent && parent.qqqideQoast) parent.qqqideQoast.show('子弹已射出 ' + sizeStr + ' → ' + filename, { type: 'success', duration: 3500 }); } catch (_) { }

        } catch (err) {
            try { if (parent && parent.qqqideQoast) parent.qqqideQoast.show('子弹写入失败: ' + (err.message || err), { type: 'error', duration: 5000 }); } catch (_) { }
        }
    };
})();

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

// ═══ 关闭刷盘：beforeunload 同步尽力保存，不拦截关闭（2026-08-08 F13 定案）═══
//   ★ 拦截-重试收敛已废除：三面板 beforeunload 全拦截 + hidden iframe（visibilityState=hidden）
//     的 setTimeout 被 Chromium 节流到 ~1/min → _finish 的 2s 超时兜底失效 → 收敛死锁：
//     回车后窗口 60s 才关/看起来永不关（F11 实测症状），60s 后自动关被误认为闪退。
//   ★ 现改为：不 preventDefault（窗口确认后立即关闭），保存走 fire-and-forget IPC ——
//     请求一旦到达主进程，渲染进程销毁不影响主进程完成写盘；all.json 另有 auto-save
//     500ms 持续刷盘（最后一笔最多丢 500ms 流式预览，重启自磁盘恢复，零损坏）。
//     其余面板 beforeunload 同步刷盘照常（only-store/ai-viewport/panel-quest/panel-clock）。
//   ★ F7/F10 的 _buBlocked/_buSaveDone/_finish/closeConfirmed 重试闭环整体删除。
window.addEventListener('beforeunload', function () {
    // 用户点击「重置窗口」→ 旁路标签，不拦截
    // ★ iframe 内 window !== parent.window，必须也查 parent
    var _rl = window.__qqq_reloading;
    try { if (!_rl && window.parent && window.parent !== window) _rl = window.parent.__qqq_reloading; } catch (_) {}
    try { if (!_rl && window.top && window.top !== window) _rl = window.top.__qqq_reloading; } catch (_) {}
    if (_rl) return;
    var _ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    var _qid = (typeof questActiveId !== 'undefined') ? questActiveId : null;
    if (!_ag || !_qid) return;
    // 压缩中 → 标记异常供下次启动修复
    if (_ag._compressing && _ag._ctx) {
        _ag._uncleanShutdown = true;
        try { console.warn('[beforeunload] agent was compressing — marked unclean'); } catch (_) { }
    }
    // 尽力保存：fire-and-forget，不拦截关闭
    if (typeof _saveAgentQuestData === 'function') {
        try { _saveAgentQuestData(_qid, _ag, _ag._currentFloorNum || 0).catch(function () { }); } catch (_) { }
    }
});
