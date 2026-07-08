'use strict';
// ═══ panel-pipeline.js ═══
// sendMessage 管线：接受显式 content，零 $input 访问，零 saveQuestUIState 调用
// SendIntent 替代 skipFloorCreation boolean 分叉

// ── SendIntent 工厂 ──
// type: 'normal' | 'recovery-0house' | 'recovery-nhouse'
//   normal: 正常发送，创建新楼层
//   recovery-0house: 0-house 恢复，复用当前楼层
//   recovery-nhouse: N-house 恢复，封顶旧楼层后创建新楼层
function _buildSendIntent(questId, content, opts) {
    opts = opts || {};
    return {
        questId: questId,
        content: content,                    // ★ 显式传入，不读 $input
        images: opts.images || null,
        tierIndex: opts.tierIndex != null ? opts.tierIndex : selectedTier,
        type: opts.type || 'normal',
        // 恢复专用
        isRecovery: opts.isRecovery || false,
        savedLastUserInput: opts.savedLastUserInput || null,
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

    // ── 闸门 ──
    if (_activeAgent && _activeAgent._stopState === 'sending' && !isRecovery) return;
    if (_activeAgent && _activeAgent._stopState === 'stopping') return;
    if (_activeAgent && _activeAgent._stopState === 'fatal' && !isRecovery) return;
    if (_activeAgent && _activeAgent._recoveryInProgress && sendType === 'normal') return;
    if (!_hasMainProject()) { _triggerSelectMainProject(); return; }

    // ── Draft 晋升 ──
    if (_isDraft(questId)) {
        var _dText = content || '';
        var _dChips = getInputChipPaths ? getInputChipPaths() : [];
        if (!_dText && _dChips.length === 0) return;
        try {
            var _dOldId = questId;
            var _dQid = await questStore.create('');
            if (!_dQid) return;
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
            if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
                onlyStore.setNow('ai.uiStates.' + _panelId, questUIStates);
            }
            if (parent.__qqq_agentPool && parent.__qqq_agentPool[_dOldId]) {
                parent.__qqq_agentPool[_dOldId]._queue = [];
            }
        } catch (_dErr) {
            console.warn('[pipeline] draft creation failed:', _dErr && _dErr.message);
            addMessageEl('error', '创建 Quest 失败：' + ((_dErr && _dErr.message) || '未知错误'));
            return;
        }
    }

    if (!_activeAgent) return;
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
    if (!text && (!images || images.length === 0)) { agent.setStopState('idle'); updateQueueBtn(); return; }
    if (streaming) { agent.setStopState('idle'); updateQueueBtn(); return; }

    if (!_isLoggedIn()) {
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('请先在菜单栏点击登录', { type: 'warning', duration: 6000 }); } catch (_) { }
        agent.setStopState('idle');
        updateQueueBtn();
        return;
    }

    // ── 构建 userContent（含附件） ──
    var userContent = text;
    var chipPaths = getInputChipPaths ? getInputChipPaths() : [];
    var allPaths = chipPaths;
    if (allPaths.length > 0) {
        var contentParts = [];
        for (var pi = 0; pi < allPaths.length; pi++) {
            var p = allPaths[pi];
            try {
                var _bridgeChip = _getBridge();
                if (!_bridgeChip) { contentParts.push('[Attached: ' + p + ']\n(bridge unavailable)'); continue; }
                var isDir = false;
                var statInfo = null;
                try { statInfo = await _bridgeChip.fs.stat(p); if (statInfo && statInfo.isDir) isDir = true; } catch (e) { }
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
                            var MAX_SIZE = 50 * 1024;
                            if (fc.length > MAX_SIZE) {
                                var head = fc.substring(0, 20 * 1024);
                                var tail = fc.substring(fc.length - 20 * 1024);
                                fc = head + '\n\n... [truncated: ' + fc.length + ' bytes total, showing first/last 20KB] ...\n\n' + tail;
                            }
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
    if (_deferUserBubble) {
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
    if (sendType === 'normal' && qid === questActiveId) {
        $input.value = '';
        $input._resetUndo();
        pendingImages = [];
        renderImageStrip();
        $input.focus();
    }

    // ── 楼层分配 ── ──
    var floorNum;
    var root2 = questStore.getProjectRoot();
    var qDirName2, fDirName2, _allTxtDirLocal, _allTxtPathLocal;
    if (sendType === 'recovery-0house') {
        floorNum = agent._currentFloorNum;
        if (agent._floorMeta && agent._floorMeta[floorNum]) {
            _allTxtDirLocal = agent._floorMeta[floorNum]._fDir || '';
            _allTxtPathLocal = agent._floorMeta[floorNum].allTxtPath || '';
        }
        if (!_allTxtPathLocal && root2) { _allTxtDirLocal = ''; _allTxtPathLocal = ''; }
    } else {
        // normal 或 recovery-nhouse → 新楼层
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
    }

    if (sendType !== 'recovery-0house') {
        var _floorStartIdx = agent.conversation.length;
        agent._floorStartIdx = _floorStartIdx;
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
    if (sendType !== 'recovery-0house') {
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
    if (sendType === 'recovery-0house') {
        aiDiv._buf = aiDiv._buf || '';
        aiDiv._paras = aiDiv._paras || [];
    }
    if (sendType !== 'recovery-0house') {
        agent._aiStartTime = _fmtTime(new Date());
        agent._aiTierLabel = 'A' + (selectedTier || 6);
    }
    agent._streamingContent = null;
    agent._streaming = true;
    if (sendType !== 'recovery-0house') {
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
                    tierEl.textContent = agent._aiTierLabel + ' start in ' + agent._aiStartTime;
                    aiDiv.parentNode.insertBefore(tierEl, aiDiv);
                }
            }
        }
        // ★ 即时启用引导按钮（此时 _streaming=true, _stopState=sending, updateGuideBtn 才能读到）
        if (typeof updateGuideBtn === 'function') updateGuideBtn();
    }
    scrollToBottom(true);

    // 封顶旧楼层红框
    if (sendType !== 'recovery-0house' && floorNum > 1 && agent._questErrorLogByFloor && agent._questErrorLogByFloor[floorNum - 1]) {
        if (typeof _hideRecoveryLink === 'function') _hideRecoveryLink(agent, floorNum - 1);
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
        if (typeof ExpertFlow !== 'undefined' && ExpertFlow.shouldTrigger(_firstQuest, floorNum)) {
            ExpertFlow.markTriggered();
            ExpertFlow.setMode(ExpertFlow.MODE_PENDING);
            // ★ _system:true → AI sees it, UI does NOT render it (unlike _injected guide blocks)
            agent.inject('[E-FLOW trigger]', { _system: true });
        }
    } catch (_) { }

    // ── agent.send ──
    try {
        var token = getLoginToken();
        await agent.send(userContent, {
            images: _images,
            token: token,
            tier: selectedTier ? TIER_LIST[selectedTier] : null,
            onToken: function (chunk) {
                if (agent._deferRenderUntilHouse1) {
                    agent._deferRenderUntilHouse1 = false;
                    // ★ B2: 恢复成功，创建「继续」用户气泡（不显示完整恢复诊断文本）
                    var _recBubbleText = agent._deferredUserText || '继续';
                    agent._deferredUserText = null;
                    var _recBubble = addMessageEl('user', _recBubbleText);
                    if (_recBubble) _recBubble._floor = agent._currentFloorNum;
                    agent._deferredUserEl = null;
                    agent._deferredAiDiv = null;
                    if (typeof _hideRecoveryLink === 'function') _hideRecoveryLink(agent);
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
                _targetDiv._buf = (_targetDiv._buf || '') + chunk;
                _targetDiv._fullText = (_targetDiv._fullText || '') + chunk;
                _targetDiv._paras = _targetDiv._paras || [];
                if (typeof _targetDiv._splitCursor !== 'number') _targetDiv._splitCursor = 0;
                if (_targetDiv._codeFenceOpen) {
                    var _allFences = _targetDiv._buf.match(/^```/gm);
                    var _allFc = _allFences ? _allFences.length : 0;
                    if (_allFc % 2 === 0 && _allFc > 0) {
                        if (_targetDiv._buf.trim()) _targetDiv._paras.push(_targetDiv._buf);
                        _targetDiv._buf = '';
                        _targetDiv._splitCursor = 0;
                        _targetDiv._codeFenceOpen = false;
                    } else {
                        _targetDiv._dirty = true;
                        if (!_targetDiv._renderScheduled) {
                            _targetDiv._renderScheduled = true;
                            var _rd = _targetDiv._firstRenderDone ? 1000 : 16; _targetDiv._firstRenderDone = true;
                            setTimeout(function () { doStreamRender(agent); }, _rd);
                        }
                        return;
                    }
                }
                var _newRegion = _targetDiv._buf.slice(_targetDiv._splitCursor);
                var _lookback = _targetDiv._buf.lastIndexOf('\n\n', _targetDiv._splitCursor - 1);
                var _scanStart = _lookback >= 0 ? _lookback + 2 : 0;
                var _scanText = _targetDiv._buf.slice(_scanStart);
                var parts = _scanText.split('\n\n');
                var _safeParas = [];
                var _stopped = false;
                for (var pi = 0; pi < parts.length - 1; pi++) {
                    var _part = parts[pi];
                    var _fenceCount = (_part.match(/^```/gm) || []).length;
                    if (_fenceCount % 2 === 0) {
                        if (_part.trim()) _safeParas.push(_part);
                    } else {
                        _targetDiv._buf = parts.slice(pi).join('\n\n');
                        _targetDiv._splitCursor = _scanStart + parts.slice(0, pi).join('\n\n').length + (pi > 0 ? 2 : 0);
                        _targetDiv._codeFenceOpen = true;
                        _stopped = true;
                        break;
                    }
                }
                if (!_stopped) {
                    _targetDiv._splitCursor = _targetDiv._buf.length - (parts[parts.length - 1] || '').length;
                }
                for (var _sp = 0; _sp < _safeParas.length; _sp++) { _targetDiv._paras.push(_safeParas[_sp]); }
                _targetDiv._dirty = true;
                if (!_targetDiv._renderScheduled) {
                    _targetDiv._renderScheduled = true;
                    var _rd2 = _targetDiv._firstRenderDone ? 1000 : 16; _targetDiv._firstRenderDone = true;
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
                    // ★ B2: 恢复成功，创建「继续」用户气泡（不显示完整恢复诊断文本）
                    var _recBubbleText = agent._deferredUserText || '继续';
                    agent._deferredUserText = null;
                    var _recBubble = addMessageEl('user', _recBubbleText);
                    if (_recBubble) _recBubble._floor = agent._currentFloorNum;
                    agent._deferredUserEl = null;
                    agent._deferredAiDiv = null;
                    if (typeof _hideRecoveryLink === 'function') _hideRecoveryLink(agent);
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
                    // ★ Flush _buf trailing content into _paras BEFORE removing _lastParaEl
                    //   (otherwise the incomplete paragraph in _buf is silently discarded)
                    if (_targetDiv2._buf && (_targetDiv2._splitCursor || 0) < _targetDiv2._buf.length) {
                        var _trailing = _targetDiv2._codeFenceOpen ? _targetDiv2._buf : _targetDiv2._buf.slice(_targetDiv2._splitCursor || 0);
                        if (_trailing && _trailing.trim()) {
                            if (!_targetDiv2._paras) _targetDiv2._paras = [];
                            _targetDiv2._paras.push(_trailing);
                        }
                    }
                    if (_targetDiv2._lastParaEl) { _targetDiv2._lastParaEl.remove(); _targetDiv2._lastParaEl = null; }
                    var _rendered = _targetDiv2._renderedCount || 0;
                    var _allParas = _targetDiv2._paras || [];
                    for (var _ai = _rendered; _ai < _allParas.length; _ai++) {
                        var _pEl = document.createElement('div');
                        _pEl.className = 'msg-ai-p';
                        renderMarkdown(_allParas[_ai], _pEl, agent);
                        _targetDiv2._contentWrap.appendChild(_pEl);
                    }
                    _targetDiv2._renderedCount = _allParas.length;
                    _targetDiv2._paras = [];
                    _targetDiv2._buf = '';
                    _targetDiv2._splitCursor = 0;
                    _targetDiv2._codeFenceOpen = false;

                    // ★ P14 安全网：`content` 可能含 EnvelopeStripper.finalize() 清理出
                    //   的额外文本（如 <invoke> 内嵌内容），从未经 onToken 到达 _buf。
                    //   用前缀去重：仅追加 content 中超出已渲染 DOM 内容长度的后缀。
                    //   ★ 关键：只追加缺失尾部，不重复渲染整个 content（防内容重复）。
                    if (content && typeof content === 'string' && content.trim()) {
                        var _domText = _targetDiv2._contentWrap.textContent || '';
                        // 宽松容忍：允许渲染后的 HTML 有 ±80 字符偏差（Markdown→HTML 会引入空格/换行差异）
                        if (content.length > _domText.length + 80) {
                            var _suffix = content.slice(_domText.length);
                            if (_suffix.trim()) {
                                var _finalP = document.createElement('div');
                                _finalP.className = 'msg-ai-p msg-ai-final';
                                var _rm = typeof renderMarkdown === 'function' ? renderMarkdown : function (s) { return s; };
                                _finalP.innerHTML = _rm(_suffix);
                                _targetDiv2._contentWrap.appendChild(_finalP);
                            }
                        }
                    }
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
                if (typeof stopFloorTimer === 'function') stopFloorTimer(timing, agent);
                setStreaming(false);
                agent.setStopState('done');
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
                            var _errFloorNum = agent._currentFloorNum;
                            if (!agent._questErrorLogByFloor) agent._questErrorLogByFloor = {};
                            if (!agent._questErrorLogByFloor[_errFloorNum]) agent._questErrorLogByFloor[_errFloorNum] = [];
                            agent._questErrorLogByFloor[_errFloorNum].push({ time: _ts, reason: msg });
                            // ★ 闭环恢复: 同步写入 _error 消息到 conversation（重启后磁盘重建）
                            agent.conversation.push({
                                role: 'assistant',
                                content: msg,
                                _error: true,
                                _floor: _errFloorNum
                            });
                        }
                        if (agent) { agent._deferredUserEl = null; agent._deferredAiDiv = null; }
                        _renderQuestErrorBox(agent, aiDiv);
                        var _errTxtPath = aiDiv && aiDiv._allTxtPath;
                        if (_errTxtPath && agent && agent._houses && agent._houses.length > 0) {
                            try { if (typeof _forceFlushAllTxt === 'function') _forceFlushAllTxt(agent, _errTxtPath); } catch (_) { }
                        }
                        _stopAllTxtStream(agent);
                        stopFloorTimer(null, agent);
                        setStreaming(false);
                        if ($sendBtn) $sendBtn.disabled = true;
                    } else {
                        if (agent && agent._floorTimerId) { clearInterval(agent._floorTimerId); agent._floorTimerId = null; }
                        var _errTxtPath2 = agent._allTxtPath;
                        if (_errTxtPath2 && agent._houses && agent._houses.length > 0) {
                            try { if (typeof _forceFlushAllTxt === 'function') _forceFlushAllTxt(agent, _errTxtPath2); } catch (_) { }
                        }
                        _stopAllTxtStream(agent);
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
            if ($sendBtn) $sendBtn.disabled = true;
            if ($guideBtn) $guideBtn.disabled = true;
            if ($queueBtn) $queueBtn.disabled = true;
        }
    } finally {
        if (agent && qid && agent._floorCompletedCleanly) {
            try { await _saveAgentQuestData(qid, agent, agent._currentFloorNum); } catch (_) { }
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
            return;
        }
        if (agent) { agent._streaming = false; }
        if (qid && typeof _unregisterBuilding === 'function') _unregisterBuilding(qid);
        _queueBusy = false;
        if (_queue && _queue.length > 0 && !_queuePaused && _activeAgent === agent) {
            _triggerQueueSend();
        }
        if (_activeAgent === agent) {
            streaming = false;
            // ★ 楼层正常完结时 onDone 已正确设置按钮状态（含 guide 按钮启用），
            //   updateGuideBtn 此时 _stopState 已不在 sending → 会误禁用 → 跳过
            if (!agent._floorCompletedCleanly) updateGuideBtn();
        }
    }

    return { questId: qid, agent: agent, floorNum: floorNum, aiDiv: aiDiv };
}
