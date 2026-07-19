'use strict';
// ═══ panel-pipeline.js ═══
// sendMessage 管线：接受显式 content，零 $input 访问，零 saveQuestUIState 调用
// SendIntent 替代 skipFloorCreation boolean 分叉
// ★ 模块级同步发送锁：防同面板并发发送（核心：连点回车去重）
var _execSendBusy = false;

// ── SendIntent 工厂 ──
// type: 'normal' | 'recovery' | 'compress'
//   normal: 正常发送，创建新楼层
//   recovery: 恢复发送，封顶旧楼层后创建新楼层
//   compress: facts 提取楼层（_compressFloor=true，不进饼干，tier 4，f3 标签）
function _buildSendIntent(questId, content, opts) {
    opts = opts || {};
    return {
        questId: questId,
        content: content,
        images: opts.images || null,
        tierIndex: opts.tierIndex != null ? opts.tierIndex : selectedTier,
        type: opts.type || 'normal',
        isRecovery: opts.isRecovery || false,
        compressFloor: opts.compressFloor || false,
    };
}

// ── 执行管线 ──
// 从 sendMessage 提取核心逻辑，接收 intent 而非读全局
async function _executeSend(intent) {
    var questId = intent.questId;
    var content = intent.content;
    var images = intent.images;
    var tierIndex = intent.tierIndex;
    var sendType = intent.type;
    var isRecovery = intent.isRecovery;

    // ★ 同步发送锁：防同面板并发发送（核心：连点回车 draft 晋升竟态→两个 quest）
    if (_execSendBusy) return;

    // ── 闸门 ──
    var _isCompress = (sendType === 'compress') || intent.compressFloor;
    if (_activeAgent && _activeAgent._stopState === 'sending' && !isRecovery && !_isCompress) return;
    if (_activeAgent && _activeAgent._stopState === 'stopping') return;
    if (_activeAgent && _activeAgent._stopState === 'fatal' && !isRecovery) return;
    if (_activeAgent && _activeAgent._recoveryInProgress && sendType === 'normal') return;
    if (!_hasMainProject()) { _triggerSelectMainProject(); return; }

    // ★ 所有闸门已过 → 加锁
    _execSendBusy = true;

    // ── Draft 晋升 ──
    if (_isDraft(questId)) {
        var _dText = content || '';
        var _dChips = getInputChipPaths ? getInputChipPaths() : [];
        if (!_dText && _dChips.length === 0) { _execSendBusy = false; return; }
        try {
            var _dOldId = questId;
            var _dQid = await questStore.create('');
            if (!_dQid) { _execSendBusy = false; return; }
            questActiveId = _dQid;
            if (questUIStates[_dOldId] && typeof questUIStates[_dOldId].selectedTier === 'number') {
                if (!questUIStates[questActiveId]) questUIStates[questActiveId] = {};
                questUIStates[questActiveId].selectedTier = questUIStates[_dOldId].selectedTier;
                selectedTier = questUIStates[_dOldId].selectedTier;
            }
            _activeAgent = _getOrCreateAgent(questActiveId);
            if (_panelId === 1) await questStore.setActiveId(questActiveId);
            _persistPanelResume(questActiveId);
            _parentClaimQuest(questActiveId);
            _broadcast('owner-claimed', questActiveId);
            questId = questActiveId;
            var _dFirst = _dText;
            var _dRoot = questStore.getProjectRoot();
            if (_dRoot) {
                var _dQNum = parseInt(questId.slice(1)) || 1;
                var _dQName = _makeName('q', _dQNum, _dFirst);
                var _dFName = _makeName('f', 1, _dFirst);
                var _dDot = _dQName.indexOf('.');
                var _dTitle = _dDot >= 0 ? _dQName.slice(_dDot + 1) : ('Quest ' + _dQNum);
                await questStore.rename(questId, _dTitle, _dQNum);
                await _ensureQuestDir(_dRoot, _dQName, _dFName);
            }
            await renderTabs();
            if (cardPool && _isDraft(cardPool._activeId)) {
                var _dCdOld = cardPool._activeId;
                var _dCd = cardPool._cards[_dCdOld];
                if (_dCd && _dCd._contentWrap) {
                    var _dReal = cardPool.getOrCreate(questId);
                    while (_dCd._contentWrap.firstChild) _dReal._contentWrap.appendChild(_dCd._contentWrap.firstChild);
                    _dCd.dom.style.display = 'none';
                    _dReal.dom.style.display = 'block';
                    cardPool._activeId = questId;
                    cardPool.removeCard(_dCdOld);
                }
            }
            delete questUIStates[_dOldId];
            // ★ 豆沙包：草稿晋升后清除旧 draft flag
            if (parent && parent.__qqq_draftFlags && parent.__qqq_draftFlags[_dOldId]) {
                delete parent.__qqq_draftFlags[_dOldId];
                if (typeof _broadcast === 'function') _broadcast('draft-changed', _dOldId);
            }
            if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
                onlyStore.setNow('ai.uiStates.' + _panelId, questUIStates);
            }
            if (parent.__qqq_agentPool && parent.__qqq_agentPool[_dOldId]) {
                parent.__qqq_agentPool[_dOldId]._queue = [];
            }
        } catch (_dErr) {
            console.warn('[pipeline] draft creation failed:', _dErr && _dErr.message);
            addMessageEl('error', '创建 Quest 失败：' + ((_dErr && _dErr.message) || '未知错误'));
            _execSendBusy = false;
            return;
        }
    }

    if (!_activeAgent) { _execSendBusy = false; return; }
    if (!_isDraft(questId) && parent && parent.__qqq_agentPool && parent.__qqq_agentPool[questId] !== _activeAgent) {
        console.warn('[pipeline] _activeAgent stale');
    }

    _activeAgent.setStopState('sending');
    var agent = _activeAgent;
    var qid = questId;

    // 清除残留标记
    if (sendType === 'normal' && agent._deferRenderUntilHouse1 && !isRecovery) {
        agent._deferRenderUntilHouse1 = false;
    }

    var _guideStatuses = document.querySelectorAll('.guide-status');
    for (var _gsi = 0; _gsi < _guideStatuses.length; _gsi++) { _guideStatuses[_gsi].remove(); }

    // 所有权守卫
    if (qid) {
        try {
            var _ssSyncOwner = _parentGetQuestOwner(qid);
            if (_ssSyncOwner !== undefined && _ssSyncOwner !== _panelId) {
                _setPanelFocus(false);
                _broadcast('focus-request', qid, { targetPanel: _ssSyncOwner });
                agent.setStopState('idle');
                updateQueueBtn();
                _execSendBusy = false;
                return;
            }
            if (_ssSyncOwner === undefined) {
                _parentClaimQuest(qid);
                _broadcast('owner-claimed', qid);
            }
        } catch (_) { }
    }
    updateQueueBtn();

    // ★ 内容验证（显式传入，不读 $input）
    var text = (content || '').trim();
    if (!text && (!images || images.length === 0)) { agent.setStopState('idle'); updateQueueBtn(); _execSendBusy = false; return; }
    if (streaming) { agent.setStopState('idle'); updateQueueBtn(); _execSendBusy = false; return; }

    if (!_isLoggedIn()) {
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('请先在菜单栏点击登录', { type: 'warning', duration: 6000 }); } catch (_) { }
        agent.setStopState('idle');
        updateQueueBtn();
        _execSendBusy = false;
        return;
    }

    // ── 构建 userContent（含附件） ──
    var userContent = text;
    var chipPaths = getInputChipPaths ? getInputChipPaths() : [];
    var allPaths = chipPaths;
    // ★ 去重：同一文件可多次注入编辑框（自然表达流），但文件内容只喂一次给 AI，不浪费上下文
    var _seenChip = {};
    allPaths = allPaths.filter(function (p) { if (_seenChip[p]) return false; _seenChip[p] = true; return true; });
    if (allPaths.length > 0) {
        var contentParts = [];
        for (var pi = 0; pi < allPaths.length; pi++) {
            var p = allPaths[pi];
            try {
                var _bridgeChip = _getBridge();
                if (!_bridgeChip) { contentParts.push('[Attached: ' + p + ']\n(bridge unavailable)'); continue; }
                var isDir = false;
                var statInfo = null;
                try { statInfo = await _bridgeChip.fs.stat(p); if (statInfo && statInfo.isDir) isDir = true; } catch (e) { continue; }
                if (isDir) {
                    try {
                        var entries = await _bridgeChip.fs.list(p);
                        var tree = entries.slice(0, 200).map(function (e) { return (e.isDir ? '\ud83d\udcc1 ' : '   ') + e.name; }).join('\n');
                        var suffix = entries.length > 200 ? '\n... (' + entries.length + ' total entries, showing first 200)' : '';
                        contentParts.push('[Directory: ' + p + ']\n' + tree + suffix);
                    } catch (e) { contentParts.push('[Directory: ' + p + ']\n(read error: ' + e.message + ')'); }
                } else {
                    var m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
                    var ext = m ? m[1] : '';
                    var BIN_EXT = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'ape', 'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', '3gp', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'avif', 'zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'exe', 'msi', 'dll', 'so', 'dylib', 'bin', 'dat', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'vsix', 'jar', 'class', 'wasm'];
                    var isBinary = BIN_EXT.indexOf(ext) !== -1;
                    if (isBinary) {
                        var sizeStr = statInfo && statInfo.size ? formatBytes(statInfo.size) : '?';
                        var mtimeStr = statInfo && statInfo.mtime ? new Date(statInfo.mtime).toLocaleString() : '?';
                        contentParts.push('[File: ' + p + ']\n- type: .' + ext + ' (binary)\n- size: ' + sizeStr + '\n- mtime: ' + mtimeStr);
                    } else {
                        try {
                            var fc = await _bridgeChip.fs.read(p);
                            if (!fc && fc !== '') { contentParts.push('[File: ' + p + ']\n(read error: null result)'); continue; }
                            // ★ 统一内容门
                            fc = (typeof ContentGateway !== 'undefined' && ContentGateway.gate) ? ContentGateway.gate(fc) : fc;
                            contentParts.push('[File: ' + p + ']\n```\n' + fc + '\n```');
                        } catch (e) { contentParts.push('[File: ' + p + ']\n(read error: ' + e.message + ')'); }
                    }
                }
            } catch (e) { contentParts.push('[Attached: ' + p + ']\n(error: ' + e.message + ')'); }
        }
        userContent = text + (contentParts.length ? '\n\n' + contentParts.join('\n\n') : '');
    }

    // ── 用户气泡 ──
    var _deferUserBubble = agent && agent._deferRenderUntilHouse1;
    var userMsgEl;
    if (_isCompress) {
        // ★ V15: compress 楼层不创建用户气泡（Q 是机器生成的子弹引用）
        userMsgEl = null;
    } else if (_deferUserBubble) {
        userMsgEl = null;
        agent._deferredUserEl = null;
        agent._deferredUserText = '继续';  // ★ B2: 恢复消息气泡只显示「继续」
    } else {
        userMsgEl = addMessageEl('user', text);
        if (userMsgEl) userMsgEl._floor = agent._ctx.totalFloors;
    }
    if (pendingImages && pendingImages.length > 0 && userMsgEl) {
        var imgRow = document.createElement('div');
        imgRow.style.cssText = 'margin-top:6px;';
        pendingImages.forEach(function (img) {
            var wrap = document.createElement('span');
            wrap.className = 'msg-img-wrap';
            var imgEl = document.createElement('img');
            imgEl.src = img.dataUrl;
            imgEl.dataset.base64 = img.base64;
            wrap.appendChild(imgEl);
            var badge = document.createElement('span');
            badge.className = 'msg-img-badge';
            badge.textContent = '#' + img.id;
            badge.onclick = function () { openLightbox(img.dataUrl, img.base64); };
            wrap.appendChild(badge);
            imgRow.appendChild(wrap);
        });
        userMsgEl.appendChild(imgRow);
    }

    var _images = pendingImages && pendingImages.length > 0 ? pendingImages.map(function (img) { return { id: img.id, base64: img.base64, dataUrl: img.dataUrl, fileName: img.fileName || '' }; }) : null;

    // ★ $input 清理：仅 normal 类型且当前活跃 quest 才清除（防队列/后台发送误清）
    //   compress 类型不清理（机器生成的楼层，不影响用户编辑状态）
    if (sendType === 'normal' && qid === questActiveId) {
        $input.value = '';
        $input._resetUndo();
        pendingImages = [];
        renderImageStrip();
        $input.focus();
        // ★ 豆沙包：发送后清除当前 quest 的草稿标记
        if (parent && parent.__qqq_draftFlags && parent.__qqq_draftFlags[qid]) {
            delete parent.__qqq_draftFlags[qid];
            if (typeof _broadcast === 'function') _broadcast('draft-changed', qid);
        }
    }

    // ── 楼层分配 ── (recovery 和 normal 都走新楼层)
    var floorNum;
    var root2 = questStore.getProjectRoot();
    var qDirName2, fDirName2, _allTxtDirLocal, _allTxtPathLocal;
    // ★ 统一：一律通过 nextFloorNum() 创建新楼层
    floorNum = await questStore.nextFloorNum(qid);
    if (root2 && floorNum > 0) {
        var userQuestion = text || (userContent || '').split('\n')[0];
        var quests2 = await questStore.list();
        var qEntry = quests2.find(function (qx) { return qx.id === qid; });
        var qTitle2 = (qEntry && qEntry.title && qEntry.title !== 'New Chat') ? qEntry.title : '';
        var qNumericId = (qEntry && qEntry.numericId) ? qEntry.numericId : parseInt(qid.replace('q', ''), 10) || 0;
        qDirName2 = await _resolveQuestDirName(root2, qid, qNumericId, qTitle2);
        fDirName2 = _makeName('f', floorNum, userQuestion);
        var _ensured = await _ensureQuestDir(root2, qDirName2, fDirName2);
        if (_ensured && _ensured.fDir && _images && _images.length > 0) {
            var _bridge2 = window.parent && window.parent.qqqideBridge;
            if (_bridge2 && _bridge2.fs) {
                for (var _imi = 0; _imi < _images.length; _imi++) {
                    var _pimg = _images[_imi];
                    var _fileName = 'img_' + _pimg.id + '.png';
                    try {
                        if (typeof _bridge2.fs.writeBase64 === 'function') {
                            await _bridge2.fs.writeBase64(_ensured.fDir + _fileName, _pimg.base64);
                        } else {
                            var _b64Only = _pimg.base64 || _pimg.dataUrl.split(',')[1] || '';
                            await _bridge2.fs.writeBase64(_ensured.fDir + _fileName, _b64Only);
                        }
                        _pimg.fileName = _fileName;
                    } catch (_imgSaveErr) { console.warn('[img-save] failed:', _imgSaveErr); }
                }
            }
        }
    }

    if (sendType !== 'recovery') {
        var _floorStartIdx = agent.conversation.length;
        agent._floorStartIdx = _floorStartIdx;
    }
    // ★ 推进 passby 基线：新楼层开始时，将刚完成的上一楼层计入基线（仅楼层号变化时推进）
    var _oldFloorNum2 = agent._currentFloorNum;
    // ★ 自愈守卫：若 passbyBaseFloorNum 为 0 但有多层历史（元数据未初始化），
    //   说明上次启动时 quest 元数据未保存，基线处于出厂状态。此时不能信任
    //   _passbyBaseWge（可能为 0），直接从 _oldFloorNum2 推断：上楼层 passby
    //   已冻结在 all.json 中，push 应增量加当前 houses/costWge。
    //   但若 _passbyBaseFloorNum === 0 且 _oldFloorNum2 > 1，说明基线从未初始化，
    //   此时 _passbyBaseWge 可能为 0，增量加是对的（0+上楼层=上楼层）。
    //   真正的问题是：基线为 0 时 _oldFloorNum2 也为 0（元数据缺失），已被
    //   _restoreAgentFromStore 兜底修复。此处仅做安全网。
    if (sendType !== 'recovery' && _oldFloorNum2 && _oldFloorNum2 !== floorNum) {
        agent._passbyBaseHouses = (agent._passbyBaseHouses || 0) + (agent._houses ? agent._houses.length : 0);
        agent._passbyBaseWge = (agent._passbyBaseWge || 0) + (agent._floorCostWge || 0);
        agent._passbyBaseTokens = (agent._passbyBaseTokens || 0) + (typeof _computeFloorTokens === 'function' ? _computeFloorTokens(agent) : 0);
        agent._passbyBaseFloorNum = _oldFloorNum2;
    }
    agent._currentFloorNum = floorNum;
    agent._houses = [];
    agent._a4Snapshots = {};
    agent._lastAutoSaveLen = 0;
    agent._lastFloorTimingRecord = null;
    if (!agent._floorMeta) agent._floorMeta = {};
    var _projectRoot = root2 || questStore.getProjectRoot();
    if (!_allTxtDirLocal && _projectRoot) {
        _allTxtDirLocal = _projectRoot + '/qqq/quests/' + (typeof qDirName2 !== 'undefined' ? qDirName2 : '') + '/' + (typeof fDirName2 !== 'undefined' ? fDirName2 : '') + '/';
    }
    if (!_allTxtPathLocal) _allTxtPathLocal = _allTxtDirLocal ? _allTxtDirLocal + 'all.txt' : '';
    agent._allTxtPath = _allTxtPathLocal;
    if (sendType !== 'recovery') {
        agent._floorMeta[floorNum] = {
            floorStartIdx: agent._floorStartIdx,
            allTxtPath: _allTxtPathLocal,
            _fDir: _allTxtDirLocal,
            createdAt: Date.now()
        };
        var _bridgeMk = window.parent && window.parent.qqqideBridge;
        if (_bridgeMk && _allTxtDirLocal) { try { await _bridgeMk.fs.mkdir(_allTxtDirLocal); } catch (_) { } }
    }

    var aiDiv = cardPool.startBuildingFloor(qid, floorNum, _allTxtPathLocal);
    if (!aiDiv) { agent.setStopState('idle'); updateQueueBtn(); return; }
    aiDiv._allTxtPath = _allTxtPathLocal;
    // ★ Path B: recovery 时楼层对用户不可见，house 1 到达时才揭示（防空楼闪出）
    if (sendType === 'recovery') {
        aiDiv.style.display = 'none';
    }
    // ★ recovery: 流式状态已在 agent 上，直接复用
    agent._streamBuf = agent._streamBuf || '';
    agent._streamParas = agent._streamParas || [];
    // ★ V15: compress 楼层标记（az 区外观正常，GE 账单 type=f3）
    if (_isCompress) {
        agent._compressFloor = true;
        agent._aiStartTime = _fmtTime(new Date());
        agent._aiTierLabel = 'A' + (selectedTier || 4);
    } else if (sendType !== 'recovery') {
        agent._aiStartTime = _fmtTime(new Date());
        agent._aiTierLabel = 'A' + (selectedTier || 6);
    }
    agent._streamingContent = null;
    agent._streaming = true;
    // ★ 背包重量估算（K tokens = chars / 2.7 / 1000）
    // 完整对齐背包图解：guard + Z + biscuit + facts + 用户输入 + tools + body
    if (sendType !== 'recovery') {
        var _bpChars = 0;
        // 1. 服务端甲壳（与 panel-quest-ui.js guardChars 同步）
        _bpChars += 14964;
        // 2. 客户端注入消息：Z（_persistent）+ biscuit + facts
        var _conv = agent.conversation || [];
        for (var _ci = 0; _ci < _conv.length; _ci++) {
            var _cm = _conv[_ci];
            if (_cm._persistent || _cm._biscuit || _cm._facts) {
                _bpChars += (_cm.content || '').length;
            }
        }
        // 3. 当前用户输入
        _bpChars += (text || '').length;
        // 4. 工具定义 JSON（与背包图解一致）
        try {
            if (typeof getTools === 'function') {
                var _tools = getTools();
                if (_tools && _tools.length) _bpChars += JSON.stringify(_tools).length;
            }
        } catch (_) {}
        // 5. body 常量字段 + JSON overhead（~250 chars，<0.1K）
        _bpChars += 250;
        agent._aiBackpackEst = Math.round(_bpChars / 2.7 / 1000);
    }
    // ★ 即时同步按钮 UI：建楼开始 → 按钮变红 Stop（必须在 agent._streaming 之后）
    setStreaming(true);
    if (sendType !== 'recovery') {
        if (typeof startFloorTimer === 'function') startFloorTimer(aiDiv, agent);
        if (typeof _startAllTxtStream === 'function') _startAllTxtStream(aiDiv, _allTxtPathLocal, agent, floorNum, text, '');
        // ★ aq1 tier indicator: insert between user bubble and AI reply (live building path)
        if (agent._aiStartTime && agent._aiTierLabel) {
            var _tCard = cardPool._cards[qid];
            if (_tCard && aiDiv && aiDiv.parentNode) {
                var _prev = aiDiv.previousElementSibling;
                if (!_prev || !_prev.classList.contains('msg-tier-indicator')) {
                    var tierEl = document.createElement('div');
                    tierEl.className = 'msg-tier-indicator';
                    tierEl.textContent = agent._aiTierLabel + ' · ' + agent._aiStartTime + ' · ' + '\u2726' + (agent._aiBackpackEst || '?') + 'K';
                    aiDiv.parentNode.insertBefore(tierEl, aiDiv);
                }
            }
        }
        // ★ 即时启用引导按钮（此时 _streaming=true, _stopState=sending, updateGuideBtn 才能读到）
        if (typeof updateGuideBtn === 'function') updateGuideBtn();
    }
    scrollToBottom(true);

    // ★ V14: 封顶所有旧楼层红框（normal send 需遍历 _questErrorState）
    if (sendType !== 'recovery' && agent._questErrorState) {
        for (var _fn in agent._questErrorState) {
            var _fnNum = parseInt(_fn);
            if (_fnNum < floorNum && !agent._questErrorState[_fn].capped && typeof _capRecoveryLink === 'function') {
                _capRecoveryLink(agent, _fnNum);
            }
        }
    }
    if (typeof _registerBuilding === 'function') _registerBuilding(qid, typeof _panelId !== 'undefined' ? _panelId : 1);
    if (typeof updateQuestTofu === 'function') updateQuestTofu();

    // ── E-flow ──
    try {
        var _firstQuest = false;
        try {
            if (typeof onlyStore !== 'undefined' && onlyStore.isInited() && typeof _checkFirstQuestFlag === 'function') {
                _firstQuest = _checkFirstQuestFlag(questStore.getProjectRoot());
            }
        } catch (_) { }
        // ★ Only center panel (main project) triggers E-Flow
        if (typeof ExpertFlow !== 'undefined' && ExpertFlow.shouldTrigger(_firstQuest, floorNum) && typeof _panelId !== 'undefined' && _panelId === 1) {
            ExpertFlow.markTriggered();
            ExpertFlow.setMode(ExpertFlow.MODE_PENDING);
            // ★ _system:true → AI sees it, UI does NOT render it (unlike _injected guide blocks)
            agent.inject('[E-FLOW trigger]', { _system: true });
        }
    } catch (_) { }

    // ── agent.send ──
    try {
        var token = getLoginToken();
        // ★ V15: compress 楼层强制 tier 4（facts 提取）
        var _actualTier = _isCompress ? TIER_LIST[4] : (selectedTier ? TIER_LIST[selectedTier] : null);
        await agent.send(userContent, {
            images: _images,
            token: token,
            tier: _actualTier,
            onToken: function (chunk) {
                if (agent._deferRenderUntilHouse1) {
                    agent._deferRenderUntilHouse1 = false;
                    // ★ Path B: 揭示之前隐藏的楼层（仅在 house 1 到达时展示）
                    if (aiDiv && aiDiv.style.display === 'none') {
                        aiDiv.style.display = '';
                        if (sendType === 'recovery' && agent._aiStartTime && agent._aiTierLabel) {
                            var _tCard2 = cardPool._cards[qid];
                            if (_tCard2 && aiDiv && aiDiv.parentNode) {
                                var _prev2 = aiDiv.previousElementSibling;
                                if (!_prev2 || !_prev2.classList.contains('msg-tier-indicator')) {
                                    var tierEl2 = document.createElement('div');
                                    tierEl2.className = 'msg-tier-indicator';
                                    tierEl2.textContent = agent._aiTierLabel + ' · ' + agent._aiStartTime + ' · ' + '\u2726' + (agent._aiBackpackEst || '?') + 'K';
                                    aiDiv.parentNode.insertBefore(tierEl2, aiDiv);
                                }
                            }
                        }
                    }
                    // ★ B2: 恢复成功，创建「继续」用户气泡
                    var _recBubbleText = agent._deferredUserText || '继续';
                    agent._deferredUserText = null;
                    var _recBubble = addMessageEl('user', _recBubbleText);
                    if (_recBubble) {
                        _recBubble._floor = agent._currentFloorNum;
                        if (aiDiv && aiDiv.parentNode) aiDiv.parentNode.insertBefore(_recBubble, aiDiv);
                    }
                    // ★ V14: 持久化粉泡
                    if (!agent._questErrorState) agent._questErrorState = {};
                    if (!agent._questErrorState[floorNum]) agent._questErrorState[floorNum] = { log: [], capped: false, bubbleText: null };
                    agent._questErrorState[floorNum].bubbleText = _recBubbleText;
                    agent._deferredUserEl = null;
                    agent._deferredAiDiv = null;
                    // ★ Path B: house 1 到达 → 立即消除白块 + 底部链接行（重连已成功，不再需要）
                    if (agent._recoveryLinkEl && agent._recoveryLinkEl.isConnected) {
                        var _errBox2 = agent._recoveryLinkEl.parentElement;
                        agent._recoveryLinkEl.remove();
                        agent._recoveryLinkEl = null;
                        if (_errBox2 && _errBox2.classList.contains('msg-quest-error')) {
                            var _lastRow2 = _errBox2.querySelector('.qe-row:last-of-type');
                            if (_lastRow2) _lastRow2.style.borderBottom = 'none';
                        }
                    }
                    // ★ Path B: 不在此封顶 — onToken 只揭示，_finishRecovery(true) 独家 cap
                    if (typeof startFloorTimer === 'function') startFloorTimer(aiDiv, agent);
                    if (typeof _startAllTxtStream === 'function') _startAllTxtStream(aiDiv, _allTxtPathLocal, agent, floorNum, '', '');
                    if ($sendBtn) $sendBtn.disabled = false;
                    if (typeof updateGuideBtn === 'function') updateGuideBtn();
                    if (typeof updateQueueBtn === 'function') updateQueueBtn();
                    scrollToBottom(true);
                }
                var _targetDiv = (aiDiv && aiDiv.isConnected) ? aiDiv : (agent._activeAiDiv || aiDiv);
                if (!_targetDiv) {
                    agent._streamingContent = (agent._streamingContent || '') + chunk;
                    return;
                }
                // ★ B 重构：流式状态写 agent，非 aiDiv
                agent._streamBuf = (agent._streamBuf || '') + chunk;
                agent._streamFullText = (agent._streamFullText || '') + chunk;
                agent._streamParas = agent._streamParas || [];
                if (typeof agent._streamSplitCursor !== 'number') agent._streamSplitCursor = 0;
                if (agent._streamCodeFenceOpen) {
                    var _allFences = agent._streamBuf.match(/^```/gm);
                    var _allFc = _allFences ? _allFences.length : 0;
                    if (_allFc % 2 === 0 && _allFc > 0) {
                        if (agent._streamBuf.trim()) agent._streamParas.push(agent._streamBuf);
                        agent._streamBuf = '';
                        agent._streamSplitCursor = 0;
                        agent._streamCodeFenceOpen = false;
                    } else {
                        _targetDiv._dirty = true;
                        if (!_targetDiv._renderScheduled) {
                            _targetDiv._renderScheduled = true;
                            var _rd = agent._streamFirstRenderDone ? 1000 : 16; agent._streamFirstRenderDone = true;
                            setTimeout(function () { doStreamRender(agent); }, _rd);
                        }
                        return;
                    }
                }
                var _newRegion = agent._streamBuf.slice(agent._streamSplitCursor);
                var _lookback = agent._streamBuf.lastIndexOf('\n\n', agent._streamSplitCursor - 1);
                var _scanStart = _lookback >= 0 ? _lookback + 2 : 0;
                var _scanText = agent._streamBuf.slice(_scanStart);
                var parts = _scanText.split('\n\n');
                var _safeParas = [];
                var _stopped = false;
                for (var pi = 0; pi < parts.length - 1; pi++) {
                    var _part = parts[pi];
                    var _fenceCount = (_part.match(/^```/gm) || []).length;
                    if (_fenceCount % 2 === 0) {
                        if (_part.trim()) _safeParas.push(_part);
                    } else {
                        agent._streamBuf = parts.slice(pi).join('\n\n');
                        agent._streamSplitCursor = _scanStart + parts.slice(0, pi).join('\n\n').length + (pi > 0 ? 2 : 0);
                        agent._streamCodeFenceOpen = true;
                        _stopped = true;
                        break;
                    }
                }
                if (!_stopped) {
                    agent._streamSplitCursor = agent._streamBuf.length - (parts[parts.length - 1] || '').length;
                }
                for (var _sp = 0; _sp < _safeParas.length; _sp++) { agent._streamParas.push(_safeParas[_sp]); }
                _targetDiv._dirty = true;
                if (!_targetDiv._renderScheduled) {
                    _targetDiv._renderScheduled = true;
                    var _rd2 = agent._streamFirstRenderDone ? 1000 : 16; agent._streamFirstRenderDone = true;
                    setTimeout(function () { doStreamRender(agent); }, _rd2);
                }
                if (_activeAgent === agent && !_scrollPending) {
                    _scrollPending = true;
                    requestAnimationFrame(function () { scrollToBottom(); _scrollPending = false; });
                }
            },
            onDone: async function (content, timing) {
                if (agent._deferRenderUntilHouse1) {
                    agent._deferRenderUntilHouse1 = false;
                    // ★ Path B: 揭示之前隐藏的楼层（仅在 house 1 到达时展示）
                    if (aiDiv && aiDiv.style.display === 'none') {
                        aiDiv.style.display = '';
                        if (sendType === 'recovery' && agent._aiStartTime && agent._aiTierLabel) {
                            var _tCard2 = cardPool._cards[qid];
                            if (_tCard2 && aiDiv && aiDiv.parentNode) {
                                var _prev2 = aiDiv.previousElementSibling;
                                if (!_prev2 || !_prev2.classList.contains('msg-tier-indicator')) {
                                    var tierEl2 = document.createElement('div');
                                    tierEl2.className = 'msg-tier-indicator';
                                    tierEl2.textContent = agent._aiTierLabel + ' · ' + agent._aiStartTime + ' · ' + '\u2726' + (agent._aiBackpackEst || '?') + 'K';
                                    aiDiv.parentNode.insertBefore(tierEl2, aiDiv);
                                }
                            }
                        }
                    }
                    // ★ B2: 恢复成功，创建「继续」用户气泡
                    var _recBubbleText = agent._deferredUserText || '继续';
                    agent._deferredUserText = null;
                    var _recBubble = addMessageEl('user', _recBubbleText);
                    if (_recBubble) {
                        _recBubble._floor = agent._currentFloorNum;
                        if (aiDiv && aiDiv.parentNode) aiDiv.parentNode.insertBefore(_recBubble, aiDiv);
                    }
                    // ★ V14: 持久化粉泡
                    if (!agent._questErrorState) agent._questErrorState = {};
                    if (!agent._questErrorState[floorNum]) agent._questErrorState[floorNum] = { log: [], capped: false, bubbleText: null };
                    agent._questErrorState[floorNum].bubbleText = _recBubbleText;
                    agent._deferredUserEl = null;
                    agent._deferredAiDiv = null;
                    // ★ Path B: 封顶由 _finishRecovery(true) 独家负责（onDone 提前 cap 会导致 double-cap → fallback 误伤 recovery 楼层 → 空红框刀疤）
                    if (typeof startFloorTimer === 'function') startFloorTimer(aiDiv, agent);
                    if (typeof _startAllTxtStream === 'function') _startAllTxtStream(aiDiv, _allTxtPathLocal, agent, floorNum, '', '');
                    if ($sendBtn) $sendBtn.disabled = false;
                    if (typeof updateGuideBtn === 'function') updateGuideBtn();
                    if (typeof updateQueueBtn === 'function') updateQueueBtn();
                    scrollToBottom(true);
                }
                if (aiDiv) aiDiv._floorCompleted = true;
                aiDiv._renderScheduled = false;
                var _targetDiv2 = (aiDiv && aiDiv.isConnected) ? aiDiv : (agent._activeAiDiv || aiDiv);
                if (_targetDiv2 && _targetDiv2._contentWrap) {
                    _targetDiv2._guideMode = false;
                    // ★ C 重构：content = API 完整回复 = 唯一权威真理源
                    //   流式阶段（onToken→_doStreamRender）仅为实时预览。
                    //   _contentWrap 仅含 AI 段落，aq1/时钟/A1/A4 均在外部，零副作用。
                    //   不再做 _buf/_paras flush、尾段补丁、textContent 对比——全删。
                    if (_targetDiv2._lastParaEl) { _targetDiv2._lastParaEl.remove(); _targetDiv2._lastParaEl = null; }
                    if (content && typeof content === 'string' && content.trim()) {
                        var _rendered = renderMarkdown(content);
                        if (_targetDiv2._firstHouseDone) {
                            // ★ V12：多 house 楼层 — 追加分隔条 + 新内容，不复写前面 house
                            var _sep = document.createElement('div');
                            _sep.className = 'msg-flow-house-sep';
                            _targetDiv2._contentWrap.appendChild(_sep);
                            var _newDiv = document.createElement('div');
                            _newDiv.innerHTML = _rendered;
                            _targetDiv2._contentWrap.appendChild(_newDiv);
                        } else {
                            _targetDiv2._contentWrap.innerHTML = _rendered;
                            _targetDiv2._firstHouseDone = true;
                        }
                    }
                    // ★ 方案 C：仅首 house 恢复引导块（后续 house 引导块已存在，_restoreGuideBlocksToContentWrap 内置去重）
                    if (typeof _restoreGuideBlocksToContentWrap === 'function') {
                        _restoreGuideBlocksToContentWrap(_targetDiv2._contentWrap, agent.conversation, floorNum);
                    }
                    _targetDiv2._dirty = false;
                    _targetDiv2._renderScheduled = false;
                    // ★ C 重构：innerHTML 已覆盖，清 agent 流状态防 _a4BuildCompleteFloorPayload DOM flush 重复追加
                    agent._streamBuf = '';
                    agent._streamParas = [];
                    agent._streamSplitCursor = 0;
                    agent._streamCodeFenceOpen = false;
                    agent._streamRenderedCount = 0;
                    agent._streamFullText = '';
                    agent._streamFirstRenderDone = false;
                }
                agent._floorCompletedCleanly = true;
                agent._floorTiming = timing;
                agent._floorOnErrorCalled = false;
                // ★ Clear building floor state (was never cleared after onDone,
                //   causing switchQuest to treat capped floor as still-building →
                //   card cleared & reloaded on re-switch → first-render DOM lost)
                var _cardDone = cardPool._cards[qid];
                if (_cardDone && _cardDone.buildingFloor === floorNum) {
                    _cardDone.buildingFloor = null;
                    if (aiDiv) aiDiv.classList.remove('card-building');
                }
                if (typeof _finalizeAllTxt === 'function') await _finalizeAllTxt(aiDiv, _allTxtPathLocal, agent, floorNum, timing);
                // ★ onDone 强制刷新 A1 第二行（FILE/ROW），防 all.txt 轮询漏掉
                if (aiDiv && aiDiv._a1Block && typeof _updateA1Row2 === 'function') {
                    try { _updateA1Row2(aiDiv._a1Block, agent, true); } catch (_) { }
                }
                if (typeof stopFloorTimer === 'function') stopFloorTimer(timing, agent);
                setStreaming(false);
                agent.setStopState('done');
                // ★ 每层完工后保存 quest 元数据（currentFloorNum / passbyBase 等），
                //   防重启时元数据缺失导致 _restoreAgentFromStore 无法正确恢复基线
                if (typeof saveQuestData === 'function') saveQuestData().catch(function () { });
                if (typeof _unregisterBuilding === 'function') _unregisterBuilding(qid);
                if (typeof updateQueueBtn === 'function') updateQueueBtn();
                if (typeof updateGuideBtn === 'function') updateGuideBtn();
                if ($sendBtn) $sendBtn.disabled = false;
                if ($guideBtn) $guideBtn.disabled = false;
            },
            onError: function (msg) {
                if (agent._floorOnErrorCalled) return;
                agent._floorOnErrorCalled = true;
                try {
                    var _saveQid = qid;
                    if (typeof _processHouseCollapse === 'function') _processHouseCollapse(agent);
                    if (aiDiv) {
                        aiDiv._renderScheduled = false;
                        aiDiv._dirty = false;
                        aiDiv._guideMode = false;
                        if (aiDiv._lastParaEl) { aiDiv._lastParaEl.remove(); aiDiv._lastParaEl = null; }
                    }
                    if (typeof _unregisterBuilding === 'function') _unregisterBuilding(qid);
                    if (_activeAgent === agent) {
                        if (aiDiv && aiDiv._floorCompleted) { setStreaming(false); return; }
                        var _now = new Date();
                        var _ts = _now.getHours().toString().padStart(2, '0') + ':' + _now.getMinutes().toString().padStart(2, '0');
                        if (agent) {
                            // ★ 恢复中：错误归因到原始 fatal 楼层，非新楼层
                            var _errFloorNum = agent._recoveryOriginFloor || agent._currentFloorNum;
                            if (!agent._questErrorLogByFloor) agent._questErrorLogByFloor = {};
                            if (!agent._questErrorLogByFloor[_errFloorNum]) agent._questErrorLogByFloor[_errFloorNum] = [];
                            agent._questErrorLogByFloor[_errFloorNum].push({ time: _ts, reason: msg });
                            // ★ V14: 同步写入 _questErrorState（数据驱动渲染的真理源）
                            if (!agent._questErrorState) agent._questErrorState = {};
                            if (!agent._questErrorState[_errFloorNum]) agent._questErrorState[_errFloorNum] = { log: [], capped: false, bubbleText: null };
                            agent._questErrorState[_errFloorNum].log.push({ time: _ts, reason: msg });
                            // ★ 闭环恢复: 同步写入 _error 消息到 conversation（重启后磁盘重建）
                            agent.conversation.push({
                                role: 'assistant',
                                content: msg,
                                _error: true,
                                _floor: agent._currentFloorNum,
                                _errorTime: _ts  // ★ V9 fix: 时间戳持久化，重启后红框显示精确时间
                            });
                        }
                        if (agent) {
                            agent._deferredUserEl = null;
                            agent._deferredAiDiv = null;
                            agent._deferRenderUntilHouse1 = false;
                        }
                        _renderQuestErrorBox(agent, null, agent._recoveryOriginFloor || agent._currentFloorNum);
                        var _errTxtPath = aiDiv && aiDiv._allTxtPath;
                        if (_errTxtPath && agent && agent._houses && agent._houses.length > 0) {
                            try { if (typeof _forceFlushAllTxt === 'function') _forceFlushAllTxt(agent, _errTxtPath); } catch (_) { }
                        }
                        _stopAllTxtStream(agent);
                        stopFloorTimer(null, agent);
                        setStreaming(false);
                        // ★ 永不锁按钮
                    } else {
                        if (agent && agent._floorTimerId) { clearInterval(agent._floorTimerId); agent._floorTimerId = null; }
                        var _errTxtPath2 = agent._allTxtPath;
                        if (_errTxtPath2 && agent._houses && agent._houses.length > 0) {
                            try { if (typeof _forceFlushAllTxt === 'function') _forceFlushAllTxt(agent, _errTxtPath2); } catch (_) { }
                        }
                        _stopAllTxtStream(agent);
                        // ★ 治根：后台 agent 失败时清理 buildingFloor（防切回时 switchQuest L69
                        //   因 buildingFloor!==null 清空卡片 → restore 读空数据 → fatal）
                        var _bgCard = cardPool._cards[qid];
                        if (_bgCard && _bgCard.buildingFloor === floorNum) {
                            _bgCard.buildingFloor = null;
                            var _bgAiEl = _bgCard.floorDOM && _bgCard.floorDOM[floorNum] ? _bgCard.floorDOM[floorNum].aiEl : null;
                            if (_bgAiEl) _bgAiEl.classList.remove('card-building');
                        }
                        var _bgAiDiv2 = agent && agent._activeAiDiv;
                        if (_bgAiDiv2 && _bgAiDiv2._clockBlock) {
                            _bgAiDiv2._clockBlock.className = 'msg-ai-clock';
                            var _elapsed3 = performance.now() - agent._floorStartPerf;
                            var _durS3 = Math.floor(_elapsed3 / 1000);
                            if (_bgAiDiv2._clockMin) _bgAiDiv2._clockMin.textContent = Math.floor(_durS3 / 60) + 'm';
                            if (_bgAiDiv2._clockSec) _bgAiDiv2._clockSec.textContent = ':' + (_durS3 % 60 < 10 ? '0' : '') + (_durS3 % 60) + 's';
                        }
                        agent._floorTimings = agent._floorTimings || [];
                        agent._floorTimings.push({
                            floorIndex: agent._ctx ? agent._ctx.totalFloors : 0,
                            durationMs: Math.round(performance.now() - agent._floorStartPerf),
                            error: msg,
                            finishedAt: new Date().toISOString()
                        });
                        if (typeof updateQuestTofu === 'function') updateQuestTofu();
                    }
                } catch (_oe) { console.warn('[onError] inner:', _oe); }
            }
        });
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            if (agent) {
                agent._deferredUserEl = null;
                agent._deferredAiDiv = null;
                agent._deferRenderUntilHouse1 = false;
            }
            addMessageEl('error', err.message || 'Unknown error', qid);
            if (agent) {
                agent._floorFatal = true;
                agent.setStopState('fatal');
                if (!agent._floorOnErrorCalled) {
                    agent.conversation.push({
                        role: 'assistant',
                        content: 'Send failed: ' + (err.message || 'Unknown error'),
                        _error: true,
                        _floor: agent._ctx.totalFloors
                    });
                }
                if (qid && typeof _saveAgentQuestData === 'function') {
                    _saveAgentQuestData(qid, agent, agent._currentFloorNum).catch(function () { });
                }
            }
            if ($guideBtn) $guideBtn.disabled = true;
            if ($queueBtn) $queueBtn.disabled = true;
        }
    } finally {
        if (agent && qid && agent._floorCompletedCleanly) {
            try { await _saveAgentQuestData(qid, agent, agent._currentFloorNum); } catch (_) { }
            // ★ V12: 楼层完结 → 自动重组背包（原地追加饼干 + DE，零 splice，前缀缓存命中）
            //    必须在 _saveAgentQuestData 之后运行！压缩会从 conversation 中删除原楼层消息，
            //    若先压缩再保存 → all.json 丢失全部 assistant 消息 → search_quest 显示 (no answer)
            //    + 重启后 ai_html 空 → 屏幕只剩「工具执行完毕」。
            if (typeof agent._rebuildBackpack === 'function') {
                try { await agent._rebuildBackpack(); } catch (_) { /* 压缩失败不阻断楼层完结 */ }
            }
            // ★ ctx 已迁至 ctx.json（B 方案）。D 路径兜底：ctx.json 损坏时 _rebuildBackpack 自愈。
            if (typeof _writeCtxJson === 'function') {
                try { await _writeCtxJson(qid, agent._ctx); } catch (_) { }
            }
        }
        if (agent && qid && !agent._floorCompletedCleanly && (agent._stopState === 'sending' || agent._floorFatal)) {
            try { await _saveAgentQuestData(qid, agent, agent._currentFloorNum); } catch (_) { }
        }
        if (typeof _stopAllTxtStream === 'function') _stopAllTxtStream(agent);
        if (agent && agent._floorTimerId) { clearInterval(agent._floorTimerId); agent._floorTimerId = null; }
        if (agent && agent._stopState === 'stopping') {
            if (typeof stopFloorTimer === 'function') stopFloorTimer(agent._floorTiming || { networkMs: 0, aiMs: 0, otherMs: 0 }, agent);
            setStreaming(false);
            if (qid) { try { await _saveAgentQuestData(qid, agent, agent._currentFloorNum); } catch (_) { } }
            agent.setStopState('idle');
            agent._stopCtrl = null;
        }
        if (agent) {
            if (agent._activeAiDiv) {
                var _elapsed = performance.now() - agent._floorStartPerf;
                var _totalS = Math.floor(_elapsed / 1000);
                var _min = Math.floor(_totalS / 60);
                var _sec = _totalS % 60;
                if (agent._activeAiDiv._clockBlock) agent._activeAiDiv._clockBlock.className = 'msg-ai-clock';
                if (agent._activeAiDiv._clockMin) {
                    agent._activeAiDiv._clockMin.textContent = _min + 'm';
                    agent._activeAiDiv._clockSec.textContent = ':' + (_sec < 10 ? '0' : '') + _sec + 's';
                }
                agent._activeAiDiv._renderScheduled = false;
                agent._activeAiDiv = null;
            }
        }
        if (agent && !agent._floorCompletedCleanly && agent._stopState === 'sending' && !agent._floorOnErrorCalled) {
            agent._streaming = false;
            console.log('[pipeline] floor ended headless');
            if (qid && typeof _unregisterBuilding === 'function') _unregisterBuilding(qid);
            _execSendBusy = false;
            return;
        }
        if (agent) { agent._streaming = false; }
        if (qid && typeof _unregisterBuilding === 'function') _unregisterBuilding(qid);
        _queueBusy = false;
        // ★ 先释放发送锁，再触发排队排水（否则 _triggerQueueSend → sendMessage → _execSendBusy 仍为 true → 永久阻塞）
        _execSendBusy = false;
        if (_queue && _queue.length > 0 && !_queuePaused && _activeAgent === agent) {
            _triggerQueueSend();
        }
        if (_activeAgent === agent) {
            // ★ 无条件同步按钮 UI：无论正常完成/停止/报错，finally 做最后一次按钮刷新
            //   setStreaming(false) 内部已含 updateGuideBtn，下方不再重复调用
            setStreaming(false);
        }
    }

    return { questId: qid, agent: agent, floorNum: floorNum, aiDiv: aiDiv };
}
