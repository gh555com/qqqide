'use strict';
// \u2550\u2550\u2550 panel-send.js \u2550\u2550\u2550
// sendMessage, input helpers, event handlers, window exports

// ★ skipFloorCreation: true=恢复到死胡同楼层（不建新目录/不增 floorNum）
async function sendMessage(skipFloorCreation) {
    if (_activeAgent && _activeAgent._stopState === 'sending') return;
    if (_activeAgent && _activeAgent._stopState === 'stopping') return;
    // ★ recovery+fatal 放行（_isRecovery=true 时允许通过 fatal 闸门）
    if (_activeAgent && _activeAgent._stopState === 'fatal' && !_activeAgent._isRecovery) return;
    if (_activeAgent && _activeAgent._recoveryInProgress && !skipFloorCreation) return;
    if (!_hasMainProject()) { _triggerSelectMainProject(); return; }
    // ── Draft: 先创建真实 quest + agent（必须早于一切 agent 操作）──
    if (_isDraft(questActiveId)) {
        var _dText = getInputText().trim();
        var _dChips = getInputChipPaths();
        if (!_dText && _dChips.length === 0) return;
        try {
            var _dOldId = questActiveId;
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
            var _dFirst = _dText;
            var _dRoot = questStore.getProjectRoot();
            if (_dRoot) {
                var _dQNum = parseInt(questActiveId.slice(1)) || 1;
                var _dQName = _makeName('q', _dQNum, _dFirst);
                var _dFName = _makeName('f', 1, _dFirst);
                var _dDot = _dQName.indexOf('.');
                var _dTitle = _dDot >= 0 ? _dQName.slice(_dDot + 1) : ('Quest ' + _dQNum);
                await questStore.rename(questActiveId, _dTitle, _dQNum);
                await _ensureQuestDir(_dRoot, _dQName, _dFName);
            }
            await renderTabs();
            if (cardPool && _isDraft(cardPool._activeId)) {
                var _dCdOld = cardPool._activeId;
                var _dCd = cardPool._cards[_dCdOld];
                if (_dCd && _dCd._contentWrap) {
                    var _dReal = cardPool.getOrCreate(questActiveId);
                    while (_dCd._contentWrap.firstChild) _dReal._contentWrap.appendChild(_dCd._contentWrap.firstChild);
                    _dCd.dom.style.display = 'none';
                    _dReal.dom.style.display = 'block';
                    cardPool._activeId = questActiveId;
                    cardPool.removeCard(_dCdOld);
                }
            }
            // ★ 草稿已晋升为真实 quest，清除草稿的 UI 记忆
            //   防止下次 ~New quest~ 携带本次已发送的旧内容（入框文本/图片/tier）
            delete questUIStates[_dOldId];
            if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
                onlyStore.setNow('ai.uiStates.' + _panelId, questUIStates);
            }
            // ★ 同步清除池中草稿 agent 的队列
            //   switchQuest(_draftId) 会重用池中 agent，不对队列清零，产生复活
            if (parent.__qqq_agentPool && parent.__qqq_agentPool[_dOldId]) {
                parent.__qqq_agentPool[_dOldId]._queue = [];
            }
        } catch (_dErr) {
            console.warn('[send] draft creation failed:', _dErr && _dErr.message);
            addMessageEl('error', '创建 Quest 失败：' + ((_dErr && _dErr.message) || '未知错误'));
            return;
        }
    }
    // ★ 终极兜底：此处起 _activeAgent 必定非 null（非草稿时 switchQuest 已设，草稿时上方已创建）
    if (!_activeAgent) return;
    // ★ invariant：agent 与 quest 绑定一致性（非草稿时 agent 必须在 agentPool 中）
    if (!_isDraft(questActiveId) && parent && parent.__qqq_agentPool && parent.__qqq_agentPool[questActiveId] !== _activeAgent) {
        console.warn('[invariant] _activeAgent stale: pool quest=' + questActiveId + ' agent=' + (parent.__qqq_agentPool[questActiveId] ? 'other' : 'missing'));
    }
    // ★ 同步锁：防同一面板并发（agent._stopState 是唯一真理源，_sending 由 getter 派生）
    _activeAgent.setStopState('sending');
    // ★ 本地快照：闭包捕获，永不丢失。即使 switchQuest 更换 _activeAgent 也不影响
    var agent = _activeAgent;
    var qid = questActiveId;
    // ★ 非恢复路径：强制清除延迟渲染标记（防前次失败恢复残留）
    //   恢复路径（_isRecovery=true）由 onToken/onDone 消费，不可提前清除
    if (!skipFloorCreation && agent._deferRenderUntilHouse1 && !agent._isRecovery) {
        agent._deferRenderUntilHouse1 = false;
    }
    var _guideStatuses = document.querySelectorAll('.guide-status');
    for (var _gsi = 0; _gsi < _guideStatuses.length; _gsi++) { _guideStatuses[_gsi].remove(); }
    // ═══ 所有权守卫：仅父注册表（唯一真理源） ═══
    if (qid) {
        try {
            var _ssSyncOwner = _parentGetQuestOwner(qid);
            if (_ssSyncOwner !== undefined && _ssSyncOwner !== _panelId) {
                // 另一面板持有此 quest → 跳转焦点，放弃发送
                _setPanelFocus(false);
                _broadcast('focus-request', qid, { targetPanel: _ssSyncOwner });
                agent.setStopState('idle');
                updateQueueBtn();
                return;
            }
            // 无人持有 → 声明所有权（兜底：新建 quest 时 switchQuest 未调用）
            if (_ssSyncOwner === undefined) {
                _parentClaimQuest(qid);
                _broadcast('owner-claimed', qid);
            }
        } catch (_) { }
    }
    updateQueueBtn();
    var text = getInputText().trim();
    var chipPaths = getInputChipPaths();
    if (!text && chipPaths.length === 0) { agent.setStopState('idle'); updateQueueBtn(); return; }
    if (streaming) { agent.setStopState('idle'); updateQueueBtn(); return; }

    if (!_isLoggedIn()) {
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('请先在菜单栏点击登录', { type: 'warning', duration: 6000 }); } catch (_) { }
        agent.setStopState('idle');
        updateQueueBtn();
        return;
    }

    // Build user content with attached file chips
    var userContent = text;
    var allPaths = chipPaths;
    if (allPaths.length > 0) {
        var contentParts = [];
        for (var pi = 0; pi < allPaths.length; pi++) {
            var p = allPaths[pi];
            try {
                var bridge = _getBridge();
                if (!bridge) { contentParts.push('[Attached: ' + p + ']\n(bridge unavailable)'); continue; }
                var isDir = false;
                var statInfo = null;
                try {
                    statInfo = await bridge.fs.stat(p);
                    if (statInfo && statInfo.isDir) isDir = true;
                } catch (e) { }
                if (isDir) {
                    try {
                        var entries = await bridge.fs.list(p);
                        var tree = entries.slice(0, 200).map(function (e) { return (e.isDir ? '\ud83d\udcc1 ' : '   ') + e.name; }).join('\n');
                        var suffix = entries.length > 200 ? '\n... (' + entries.length + ' total entries, showing first 200)' : '';
                        contentParts.push('[Directory: ' + p + ']\n' + tree + suffix);
                    } catch (e) { contentParts.push('[Directory: ' + p + ']\n(read error: ' + e.message + ')'); }
                } else {
                    var m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
                    var ext = m ? m[1] : '';
                    var BIN_EXT = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'ape',
                        'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', '3gp',
                        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'avif',
                        'zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2',
                        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
                        'exe', 'msi', 'dll', 'so', 'dylib', 'bin', 'dat',
                        'ttf', 'otf', 'woff', 'woff2', 'eot',
                        'vsix', 'jar', 'class', 'wasm'];
                    var isBinary = BIN_EXT.indexOf(ext) !== -1;
                    if (isBinary) {
                        var sizeStr = statInfo && statInfo.size ? formatBytes(statInfo.size) : '?';
                        var mtimeStr = statInfo && statInfo.mtime ? new Date(statInfo.mtime).toLocaleString() : '?';
                        contentParts.push('[File: ' + p + ']\n- type: .' + ext + ' (binary)\n- size: ' + sizeStr + '\n- mtime: ' + mtimeStr);
                    } else {
                        try {
                            var content = await bridge.fs.read(p);
                            if (!content && content !== '') { contentParts.push('[File: ' + p + ']\n(read error: null result)'); continue; }
                            var MAX_SIZE = 50 * 1024;
                            if (content.length > MAX_SIZE) {
                                var head = content.substring(0, 20 * 1024);
                                var tail = content.substring(content.length - 20 * 1024);
                                content = head + '\n\n... [truncated: ' + content.length + ' bytes total, showing first/last 20KB] ...\n\n' + tail;
                            }
                            contentParts.push('[File: ' + p + ']\n```\n' + content + '\n```');
                        } catch (e) { contentParts.push('[File: ' + p + ']\n(read error: ' + e.message + ')'); }
                    }
                }
            } catch (e) { contentParts.push('[Attached: ' + p + ']\n(error: ' + e.message + ')'); }
        }
        userContent = text + (contentParts.length ? '\n\n' + contentParts.join('\n\n') : '');
    }

    // 构建用户消息显示
    // ★ 恢复模式：用户气泡已存在（首次发送时已渲染），不重复创建
    var _deferUserBubble = agent && agent._deferRenderUntilHouse1;
    var userMsgEl;
    if (_deferUserBubble) {
        // 恢复模式：不创建用户气泡（铁律：一次渲染永久不变）
        userMsgEl = null;
        agent._deferredUserEl = null;  // 清旧引用
    } else {
        userMsgEl = addMessageEl('user', text);
        userMsgEl._floor = agent ? agent._ctx.totalFloors : 0;
    }
    if (pendingImages.length > 0) {
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

    var images = pendingImages.length > 0 ? pendingImages.map(function (img) { return { id: img.id, base64: img.base64, dataUrl: img.dataUrl, fileName: img.fileName || '' }; }) : null;

    saveQuestUIState(qid);
    $input.value = '';
    $input._resetUndo();
    pendingImages = [];
    renderImageStrip();
    $input.focus();

    // \u82e5\u5c1a\u65e0 active quest\uff0c\u521b\u5efa\u5e76\u547d\u540d
    var floorNum;
    var root2 = questStore.getProjectRoot();
    var qDirName2, fDirName2, _allTxtDirLocal, _allTxtPathLocal;
    if (skipFloorCreation) {
        // ★ 恢复模式：复用死胡同楼层
        floorNum = agent._currentFloorNum;
        // 复用已有目录（_floorMeta 已有记录）
        if (agent._floorMeta && agent._floorMeta[floorNum]) {
            _allTxtDirLocal = agent._floorMeta[floorNum]._fDir || '';
            _allTxtPathLocal = agent._floorMeta[floorNum].allTxtPath || '';
        }
        if (!_allTxtPathLocal && root2) {
            // 兜底：扫描已有目录
            _allTxtDirLocal = ''; _allTxtPathLocal = '';
        }
    } else {
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
            // ★ 保存图片到楼层目录（二进制落盘，与 all.json/all.txt 同目录）
            if (_ensured && _ensured.fDir && images && images.length > 0) {
                var _bridge2 = window.parent && window.parent.qqqideBridge;
                if (_bridge2 && _bridge2.fs) {
                    for (var _imi = 0; _imi < images.length; _imi++) {
                        var _pimg = images[_imi];
                        var _fileName = 'img_' + _pimg.id + '.png';
                        try {
                            if (typeof _bridge2.fs.writeBase64 === 'function') {
                                await _bridge2.fs.writeBase64(_ensured.fDir + _fileName, _pimg.base64);
                            } else {
                                // 兜底：dataUrl → 去掉前缀写入
                                var _b64Only = _pimg.base64 || _pimg.dataUrl.split(',')[1] || '';
                                await _bridge2.fs.writeBase64(_ensured.fDir + _fileName, _b64Only);
                            }
                            _pimg.fileName = _fileName;  // ★ 回写 fileName 供 conversation/images 持久化
                        } catch (_imgSaveErr) {
                            console.warn('[img-save] failed to save image to disk:', _imgSaveErr);
                        }
                    }
                    // ★ 已完成落盘，后续 agent.send({images}) 携带 fileName → card 重渲染可从磁盘加载
                }
            }
        }
    }
    // ★ 铁律：不再修改 _ctx.totalFloors。_currentFloorNum 是楼层的未可变标识。
    // ★ 恢复模式：保持 _floorStartIdx 不变（原始用户消息位置），新消息追加到其后
    if (!skipFloorCreation) {
        var _floorStartIdx = agent.conversation.length;
        agent._floorStartIdx = _floorStartIdx;
    }
    agent._currentFloorNum = floorNum;
    // ★ 新楼层开始，清空 agent._houses / _a4Snapshots 防止读到上一楼层残影
    //   MUST 在 _currentFloorNum 赋值后立即执行，关闭 auto-save 竞态窗口
    //   （_currentFloorNum 已指向新楼层但 _a4Snapshots 尚未清除 → auto-save 串台）
    agent._houses = [];
    agent._a4Snapshots = {};
    agent._lastAutoSaveLen = 0;
    agent._lastFloorTimingRecord = null;
    // ★ 存储该楼层的未可变元数据（所有保存路径使用此元数据，而非 agent 全局变量）
    if (!agent._floorMeta) agent._floorMeta = {};
    var _projectRoot = root2 || questStore.getProjectRoot();
    if (!_allTxtDirLocal && _projectRoot) {
        _allTxtDirLocal = _projectRoot + '/qqq/quests/' + (typeof qDirName2 !== 'undefined' ? qDirName2 : '') + '/' + (typeof fDirName2 !== 'undefined' ? fDirName2 : '') + '/';
    }
    if (!_allTxtPathLocal) _allTxtPathLocal = _allTxtDirLocal ? _allTxtDirLocal + 'all.txt' : '';
    agent._allTxtPath = _allTxtPathLocal;
    if (!skipFloorCreation) {
        agent._floorMeta[floorNum] = {
            floorStartIdx: agent._floorStartIdx,
            allTxtPath: _allTxtPathLocal,
            _fDir: _allTxtDirLocal,
            createdAt: Date.now()
        };
        var _bridge = window.parent && window.parent.qqqideBridge;
        if (_bridge && _allTxtDirLocal) {
            try { await _bridge.fs.mkdir(_allTxtDirLocal); } catch (_) { }
        }
    }
    var aiDiv = cardPool.startBuildingFloor(qid, floorNum, _allTxtPathLocal);
    if (!aiDiv) { agent.setStopState('idle'); updateQueueBtn(); return; }
    aiDiv._allTxtPath = _allTxtPathLocal;
    // ★ 恢复模式：AI div 已存在（startBuildingFloor 复用），无需重建 DOM
    //   但需重置流式状态为新重试做准备
    if (skipFloorCreation) {
        // 流式状态已在 startBuildingFloor 的复用分支中重置，此处仅做兜底
        aiDiv._buf = aiDiv._buf || '';
        aiDiv._paras = aiDiv._paras || [];
    }
    // ★ 延迟渲染已废弃（恢复模式不创建新 DOM，旧延迟渲染逻辑移除）
    if (!skipFloorCreation) {
        agent._aiStartTime = new Date().toISOString().replace('T', ' ').slice(0, 19);
        agent._aiTierLabel = 'A' + (selectedTier || 6);
    }
    agent._streamingContent = null;  // ★ P10/P11 根治：每楼层重置流式缓冲区
    agent._streaming = true;  // ★ aq1/工具执行守卫：标记流式中
    if (!skipFloorCreation) {
        startFloorTimer(aiDiv, agent);
        _startAllTxtStream(aiDiv, _allTxtPathLocal, agent, floorNum, text, '');
    }
    scrollToBottom(true);
    // ★ 中央建楼状态机：登记 quest 开始建楼
    if (typeof _registerBuilding === 'function') _registerBuilding(qid, typeof _panelId !== 'undefined' ? _panelId : 1);
    setStreaming(true);
    // ★ P10 根治：agent 必须知道自己的新 aiDiv，否则 _doStreamRender 读到旧 quest 的 DOM
    agent._activeAiDiv = aiDiv;
    // ★ aq1：仅非恢复路径插入 tier 指示器（恢复时 aq1 已从首次尝试时存在）
    if (!skipFloorCreation && aiDiv && aiDiv.parentNode) {
        var _aq1El = document.createElement('div');
        _aq1El.className = 'msg-tier-indicator';
        _aq1El.textContent = agent._aiTierLabel + ' start in ' + agent._aiStartTime;
        aiDiv.parentNode.insertBefore(_aq1El, aiDiv);
    }

    // ═══ E-Flow:ow: Expert Document Framework trigger ═══
    // First floor of first quest (100%) or random 10% on other floors
    try {
        if (typeof ExpertFlow !== 'undefined' && root2) {
            var _firstQuest = false;
            try {
                var _allQuests = await questStore.list();
                // First quest: this is the only quest with a floor
                var _qWithContent = 0;
                for (var _qi = 0; _qi < (_allQuests ? _allQuests.length : 0); _qi++) {
                    if (_allQuests[_qi].floorCount > 0) _qWithContent++;
                }
                // ★ Only q1 (the very first quest) triggers at 100%.
                // Once q1 has floors, all other quests uniformly use 10%.
                _firstQuest = (_qWithContent === 0);
            } catch (_) { }
            if (ExpertFlow.shouldTrigger(_firstQuest, floorNum)) {
                ExpertFlow.markTriggered();
                ExpertFlow.setMode(ExpertFlow.MODE_PENDING);  // ★ block re-trigger until user replies
                var _eMsg = ExpertFlow.buildInjectMessage(root2);
                agent.inject(_eMsg);
            }
        }
    } catch (_) { /* silent: E-flow failure must not break send */ }

    try {
        var token = getLoginToken();
        await agent.send(userContent, {
            images: images,
            token: token,
            tier: selectedTier ? TIER_LIST[selectedTier] : null,
            onToken: function (chunk) {
                // ★ 恢复模式延迟渲染：首 token 抵达 = house1 网已通 → 启封按钮 + 启动时钟
                if (agent._deferRenderUntilHouse1) {
                    agent._deferRenderUntilHouse1 = false;
                    agent._deferredUserEl = null;
                    agent._deferredAiDiv = null;
                    // ★ 隐藏红框中的「继续任务」链接
                    if (typeof _hideRecoveryLink === 'function') _hideRecoveryLink(agent);
                    // ★ 启动时钟和 all.txt 流（首次尝试时被 onError 停了）
                    if (typeof startFloorTimer === 'function') startFloorTimer(aiDiv, agent);
                    if (typeof _startAllTxtStream === 'function') _startAllTxtStream(aiDiv, _allTxtPathLocal, agent, floorNum, '', '');
                    // ★ 启封按钮
                    if ($sendBtn) $sendBtn.disabled = false;
                    if (typeof updateGuideBtn === 'function') updateGuideBtn();
                    if (typeof updateQueueBtn === 'function') updateQueueBtn();
                    scrollToBottom(true);
                }
                var _targetDiv = (aiDiv && aiDiv.isConnected) ? aiDiv : (agent._activeAiDiv || aiDiv);
                if (!_targetDiv) {
                    // ★ 后台 agent DOM 脱落：缓冲到 agent._streamingContent（不丢流式数据）
                    //   agent-loop.js L732 以此为准推入 conversation → 最终落盘
                    agent._streamingContent = (agent._streamingContent || '') + chunk;
                    return;
                }
                _targetDiv._buf = (_targetDiv._buf || '') + chunk;
                _targetDiv._fullText = (_targetDiv._fullText || '') + chunk;
                _targetDiv._paras = _targetDiv._paras || [];
                // ★ 增量拆分：只 split 从 _splitCursor 之后的新内容，避免每轮重推全部历史段落
                //   _splitCursor = 上次已 split 到的 _buf 字符位置
                if (typeof _targetDiv._splitCursor !== 'number') _targetDiv._splitCursor = 0;

                // ═══ 增量解析器：代码围栏（```...```）感知拆分 ═══
                // 核心：围栏内部的 \n\n 是代码内容，未可拆分为段落
                // 用 ``` 行首标记的奇偶性判断是否在围栏内部

                if (_targetDiv._codeFenceOpen) {
                    // 已在围栏内：检查 _buf 是否已闭合（偶数个 ``` 行首标记）
                    var _allFences = _targetDiv._buf.match(/^```/gm);
                    var _allFc = _allFences ? _allFences.length : 0;
                    if (_allFc % 2 === 0 && _allFc > 0) {
                        // 闭合了：整段作为一个段落推送
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

                // ★ 只 split _buf 从 _splitCursor 开始的增量部分
                //   但需向前回溯到最近的 \n\n 边界，确保断开的段落被完整捕获
                var _newRegion = _targetDiv._buf.slice(_targetDiv._splitCursor);
                // 向前回溯：找 _splitCursor 之前最近的 \n\n，确保当前段落不从中间开始
                var _lookback = _targetDiv._buf.lastIndexOf('\n\n', _targetDiv._splitCursor - 1);
                var _scanStart = _lookback >= 0 ? _lookback + 2 : 0;  // +2 跳过 \n\n 本身
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
                        // 奇数个 ```：围栏打开，从它开始回退到 _buf，重设 splitCursor
                        _targetDiv._buf = parts.slice(pi).join('\n\n');
                        _targetDiv._splitCursor = _scanStart + parts.slice(0, pi).join('\n\n').length + (pi > 0 ? 2 : 0);
                        _targetDiv._codeFenceOpen = true;
                        _stopped = true;
                        break;
                    }
                }
                if (!_stopped) {
                    // ★ 更新 _splitCursor 到最后的 \n\n 之后（或保持原位置）
                    _targetDiv._splitCursor = _targetDiv._buf.length - (parts[parts.length - 1] || '').length;
                }
                for (var _sp = 0; _sp < _safeParas.length; _sp++) {
                    _targetDiv._paras.push(_safeParas[_sp]);
                }

                _targetDiv._dirty = true;
                if (!_targetDiv._renderScheduled) {
                    _targetDiv._renderScheduled = true;
                    var _rd2 = _targetDiv._firstRenderDone ? 1000 : 16; _targetDiv._firstRenderDone = true;
                    setTimeout(function () { doStreamRender(agent); }, _rd2);
                }
                if (_activeAgent === agent && !_scrollPending) {
                    _scrollPending = true;
                    requestAnimationFrame(function () {
                        scrollToBottom();
                        _scrollPending = false;
                    });
                }
            },

            onDone: async function (content, timing) {
                // ★ 恢复模式兜底：若 onToken 从未触发（纯 tool_calls 无文本），此处补启封
                if (agent._deferRenderUntilHouse1) {
                    agent._deferRenderUntilHouse1 = false;
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
                    // ═══ 一次渲染 终身不变：清除流式临时标记，不改 DOM 结构 ═══
                    _targetDiv2._guideMode = false;

                    // ★ 先冲洗未渲染的段落到 DOM（流式 1fps 节流可能导致积压）
                    // 先移除 _lastParaEl（临时槽位），避免与下文的 _buf 冲洗重复
                    if (_targetDiv2._lastParaEl) {
                        _targetDiv2._lastParaEl.remove();
                        _targetDiv2._lastParaEl = null;
                    }
                    var _rendered = _targetDiv2._renderedCount || 0;
                    var _pendingParas = _targetDiv2._paras || [];
                    while (_rendered < _pendingParas.length) {
                        var _pp = _pendingParas[_rendered];
                        if (_pp && _pp.trim()) {
                            var _pDiv = document.createElement('div');
                            _pDiv.innerHTML = (typeof renderMarkdown === 'function') ? renderMarkdown(_pp) : escHtml(_pp);
                            _targetDiv2._contentWrap.appendChild(_pDiv);
                        }
                        _pendingParas[_rendered] = null;
                        _rendered++;
                    }
                    _targetDiv2._renderedCount = _rendered;
                    // 冲洗 _buf（未闭合代码块末尾 / 最后一段未完成文本）
                    // ★ 只冲 _splitCursor 之后的尾部：已完成段落已在 _doStreamRender 或上方 flush 中入 DOM，
                    //   全量冲 _buf 会把前半部分再印一遍（_buf 从未被截断，始终累加全文）
                    //   但围栏未闭合时 _buf 已在 onToken 中重写为纯围栏内容，_splitCursor 可能跨坐标系失效，
                    //   故围栏路径仍用全量 _buf，非围栏路径用 _splitCursor 切片
                    if (_targetDiv2._codeFenceOpen) {
                        if (_targetDiv2._buf && _targetDiv2._buf.trim()) {
                            var _fDiv = document.createElement('div');
                            var _fc = _targetDiv2._buf;
                            var _fnl = _fc.indexOf('\n');
                            if (_fnl > 0 && /^```/.test(_fc)) _fc = _fc.slice(_fnl + 1);
                            _fDiv.innerHTML = '<pre><code>' + (typeof escHtml === 'function' ? escHtml(_fc) : _fc) + '</code></pre>';
                            _targetDiv2._contentWrap.appendChild(_fDiv);
                        }
                    } else {
                        var _trailStart2 = _targetDiv2._splitCursor || 0;
                        var _trailing2 = _targetDiv2._buf ? _targetDiv2._buf.slice(_trailStart2) : '';
                        if (_trailing2 && _trailing2.trim()) {
                            var _fDiv = document.createElement('div');
                            _fDiv.innerHTML = (typeof renderMarkdown === 'function') ? renderMarkdown(_trailing2) : escHtml(_trailing2);
                            _targetDiv2._contentWrap.appendChild(_fDiv);
                        }
                    }

                    // 去掉所有 stream-para 类（流式临时标记，成品不需要）
                    var _spParas = _targetDiv2._contentWrap.querySelectorAll('.stream-para');
                    for (var _spi = 0; _spi < _spParas.length; _spi++) {
                        _spParas[_spi].classList.remove('stream-para');
                    }
                    // 移除初始状态提示（已在 startBuildingFloor 中删除，此处兜底）
                    var _initStatus = _targetDiv2._contentWrap.querySelector('.msg-status');
                    if (_initStatus) _initStatus.remove();
                }
                // ★ AI 复制按钮（左侧，复制原始 Markdown），流式完成后挂载
                if (typeof _addCopyBtnToAiMsg === 'function' && _targetDiv2 && _targetDiv2.parentNode) {
                    _addCopyBtnToAiMsg(_targetDiv2, content || '');
                }

                if (aiDiv) {
                    aiDiv._paras = null;
                    aiDiv._buf = null;
                    aiDiv._fullText = null;
                    aiDiv._lastParaEl = null;
                    aiDiv._codeFenceOpen = false;
                    aiDiv._renderedCount = 0;
                    aiDiv._dirty = false;
                    aiDiv._splitCursor = 0;
                }

                var _divDetached = !(aiDiv && aiDiv.isConnected);

                if (_activeAgent === agent) {
                    stopFloorTimer(timing || { networkMs: 0, aiMs: 0, otherMs: 0 }, agent);
                    scrollToBottom();
                } else {
                    // ★ 后台 agent 楼层完结：停 timer + 记录 timing（不停 timer 会导致切回后时钟继续走）
                    if (agent._floorTimerId) { clearInterval(agent._floorTimerId); agent._floorTimerId = null; }
                    var _elapsed = performance.now() - agent._floorStartPerf;
                    agent._floorTimings = agent._floorTimings || [];
                    var _bgRecord = {
                        floorIndex: agent._ctx.totalFloors,
                        durationMs: Math.round(_elapsed),
                        networkMs: (timing && timing.networkMs) || 0,
                        aiMs: (timing && timing.aiMs) || 0,
                        otherMs: (timing && timing.otherMs) || 0,
                        finishedAt: new Date().toISOString()
                    };
                    agent._floorTimings.push(_bgRecord);
                    agent._lastFloorTimingRecord = _bgRecord;
                    // 若后台 agent 的 aiDiv 仍在线（同面板切换未清理），设时钟为停止态
                    var _bgAiDiv = agent._activeAiDiv;
                    if (_bgAiDiv && _bgAiDiv._clockBlock) {
                        _bgAiDiv._clockBlock.className = 'msg-ai-clock';
                        var _bgDurS = Math.floor(_elapsed / 1000);
                        if (_bgAiDiv._clockMin) _bgAiDiv._clockMin.textContent = Math.floor(_bgDurS / 60) + 'm';
                        if (_bgAiDiv._clockSec) _bgAiDiv._clockSec.textContent = ':' + (_bgDurS % 60 < 10 ? '0' : '') + (_bgDurS % 60) + 's';
                        if (_bgAiDiv._clockCanvas) {
                            _bgAiDiv._clockCanvas.style.visibility = 'visible';
                            var _bgTm = timing || { networkMs: 0, aiMs: 0, otherMs: 0 };
                            _bgTm.totalMs = _elapsed;
                            if (typeof drawPie === 'function') drawPie(_bgAiDiv._clockCanvas, _bgTm);
                        }
                    }
                }

                // ★ 必须在保存前清除 _streaming，否则 all.json 永久记录 _streaming:true（僵尸）
                agent._streaming = false;
                if (typeof _unregisterBuilding === 'function') _unregisterBuilding(qid);
                if (_activeAgent === agent) {
                    setStreaming(false);
                }

                await _saveAgentQuestData(qid, agent, floorNum);

                if (cardPool) cardPool.completeBuildingFloor(qid, floorNum);

                // ★ 根治：后台完成时数据已落盘，强制标记 card 待重载。
                //   否则 cardPool.switchTo 见 totalFloors>0 就不刷新，永远显示建楼中旧 DOM。
                if (_activeAgent !== agent) {
                    var _qCard = cardPool && cardPool._cards && cardPool._cards[qid];
                    if (_qCard) {
                        _qCard._contentWrap && (_qCard._contentWrap.innerHTML = '');
                        _qCard.totalFloors = 0;
                        _qCard.floors = [];
                        _qCard.floorDOM = {};
                    }
                }

                if (_activeAgent === agent && _divDetached) {
                    console.warn('[onDone] div detached but card pool not available, skipping rebuild');
                }

                var _ftxtPath = (_targetDiv2 && _targetDiv2._allTxtPath) || agent._allTxtPath || '';
                await _finalizeAllTxt(_targetDiv2 || aiDiv, _ftxtPath, agent, floorNum, timing);
                if (_activeAgent === agent) {
                    updateCtxBtn();
                    // ═══ E-Flow post-floor auto-detect ═══
                    // After floor completes, check if AI created standard framework files.
                    // If index.md now exists and mode is 'none', auto-set to 'standard'.
                    try {
                        if (typeof ExpertFlow !== 'undefined' && root2 && ExpertFlow.getMode() === ExpertFlow.MODE_NONE) {
                            ExpertFlow.autoDetect(root2);
                        }
                    } catch (_) { /* silent */ }
                    if (!_queuePaused) {
                        _triggerQueueSend();
                    } else {
                        renderQueueStrip();
                    }
                }
                // ★ P11 根治：updateQuestTofu 移到守卫外 — 后台 quest 完成后也必须刷新 tofu
                updateQuestTofu();
            },

            onGuideAckDone: function () {
                var _aiDiv3 = agent._activeAiDiv;  // ★ P10：必须用 agent，不能用 _activeAgent（可能已切走）
                if (_aiDiv3) {
                    _aiDiv3._guideMode = false;
                    // 只清流式缓冲，保留已渲染的 DOM 和段落跟踪
                    _aiDiv3._buf = '';
                }
            },

            onCost: async function (cost, total, isFree) {
                if (_activeAgent === agent) {
                    var costNum = parseFloat(cost);
                    if (!isNaN(costNum)) {
                        /* GE 累计已移至父窗口 login.js 管理 */
                    }
                    /* GE 显示已移至父窗口菜单行2 */
                    var _targetDiv3 = (aiDiv && aiDiv.isConnected) ? aiDiv : (agent._activeAiDiv || aiDiv);
                    if (_targetDiv3 && _targetDiv3._clockCost) {
                        var _rawGe = agent._floorCostWge / 10000;
                        var _displayGe = _formatGeDisplay(_rawGe);
                        _targetDiv3._clockCost._rawGe = _formatGeRaw(_rawGe);
                        _targetDiv3._clockCost.textContent = _displayGe + ' ge' + (isFree ? ' Free' : '');
                        _targetDiv3._clockCost.style.display = 'inline';
                        _targetDiv3._clockCost._houses = agent._houses;
                        _targetDiv3._clockCost._floorNum = agent._currentFloorNum;
                        _targetDiv3._clockCost._passby = { questId: qid, floorNum: agent._currentFloorNum, houses: (agent._passbyBaseHouses || 0) + (agent._houses ? agent._houses.length : 0), tokens: (agent._passbyBaseTokens || 0) + (typeof _computeFloorTokens === 'function' ? _computeFloorTokens(agent) : 0), wge: (agent._passbyBaseWge || 0) + (agent._floorCostWge || 0), drift: agent._serverDrift || 0, city: agent._serverCity || '' };
                        if (isFree) {
                            _targetDiv3._clockCost.style.color = '#859900';
                        } else {
                            _targetDiv3._clockCost.style.color = '';
                        }
                    }
                }
            },
            onError: function (msg) {
                if (agent) {
                    agent._floorOnErrorCalled = true;  // ★ 看门狗：标记已处理
                    // ★ P10/P11 根治：先保存流式内容到 conversation（防 onError 丢数据）
                    //   优先用 _streamingContent（_doStreamRender 累积），回退到 _paras 残留
                    var _streamedText = agent._streamingContent || '';
                    // 防重复：若截断路径（agent-loop L680 _truncated）已写 → 跳过
                    var _lastConv3 = agent.conversation[agent.conversation.length - 1];
                    if (_lastConv3 && _lastConv3.role === 'assistant' && _lastConv3._floor === agent._ctx.totalFloors && _lastConv3.content) {
                        _streamedText = '';  // 已由 agent-loop 写入，不重复
                    }
                    if (!_streamedText.trim()) {
                        // 兜底：_doStreamRender 还没跑过 → 从 aiDiv._paras 提取
                        var _aiDiv3 = agent._activeAiDiv;
                        if (_aiDiv3 && _aiDiv3._paras) {
                            for (var _si = 0; _si < _aiDiv3._paras.length; _si++) {
                                if (_aiDiv3._paras[_si]) {
                                    if (_streamedText) _streamedText += '\n\n';
                                    _streamedText += _aiDiv3._paras[_si];
                                }
                            }
                        }
                    }
                    if (_streamedText.trim()) {
                        agent.conversation.push({
                            role: 'assistant',
                            content: _streamedText.trim(),
                            _floor: agent._ctx.totalFloors
                        });
                    }
                    agent._streamingContent = null;
                    // ★ 一次渲染永久不变：错误消息推入 conversation 持久化
                    agent.conversation.push({
                        role: 'assistant',
                        content: msg,
                        _error: true,
                        _floor: agent._ctx.totalFloors
                    });
                    // ★ 中断防护：在清理 DOM 前抓取完整 ai_html 快照（含所有 house 渲染内容）
                    //   防 _a4BuildCompleteFloorPayload 因 _activeAiDiv 失效而回退到空 conversation
                    //   ⚠ 不用 _doStreamRender()：1fps 节流，网络中断可能发生在两次 tick 之间，
                    //      _buf 尾巴未入 DOM 就丢。手动 flush _paras + _buf 到 DOM 再抓 innerHTML。
                    var _onErrDiv = agent._activeAiDiv;
                    if (_onErrDiv && _onErrDiv._contentWrap) {
                        var _rendered2 = _onErrDiv._renderedCount || 0;
                        var _pending2 = _onErrDiv._paras || [];
                        var _rm2 = typeof renderMarkdown === 'function' ? renderMarkdown : function (s) { return s; };
                        while (_rendered2 < _pending2.length) {
                            var _pp2 = _pending2[_rendered2];
                            if (_pp2 && _pp2.trim()) {
                                var _pDiv2 = document.createElement('div');
                                _pDiv2.innerHTML = _rm2(_pp2);
                                _onErrDiv._contentWrap.appendChild(_pDiv2);
                            }
                            _pending2[_rendered2] = null;
                            _rendered2++;
                        }
                        _onErrDiv._renderedCount = _rendered2;
                        if (_onErrDiv._codeFenceOpen && _onErrDiv._buf) {
                            var _fc2 = _onErrDiv._buf;
                            var _fnl2 = _fc2.indexOf('\n');
                            if (_fnl2 > 0 && /^```/.test(_fc2)) _fc2 = _fc2.slice(_fnl2 + 1);
                            if (_fc2.trim()) {
                                var _fDiv2 = document.createElement('div');
                                _fDiv2.innerHTML = '<pre><code>' + (typeof escHtml === 'function' ? escHtml(_fc2) : _fc2) + '</code></pre>';
                                _onErrDiv._contentWrap.appendChild(_fDiv2);
                            }
                        } else {
                            var _trailStart3 = _onErrDiv._splitCursor || 0;
                            var _trailing3 = _onErrDiv._buf ? _onErrDiv._buf.slice(_trailStart3) : '';
                            if (_trailing3 && _trailing3.trim()) {
                                var _tDiv2 = document.createElement('div');
                                _tDiv2.innerHTML = _rm2(_trailing3);
                                _onErrDiv._contentWrap.appendChild(_tDiv2);
                            }
                        }
                        if (_onErrDiv._lastParaEl) {
                            _onErrDiv._lastParaEl.remove();
                            _onErrDiv._lastParaEl = null;
                        }
                        var _spAll2 = _onErrDiv._contentWrap.querySelectorAll('.stream-para');
                        for (var _spi2 = 0; _spi2 < _spAll2.length; _spi2++) {
                            _spAll2[_spi2].classList.remove('stream-para');
                        }
                        _onErrDiv._dirty = false;
                        try { agent._emergencyAiHtml = _onErrDiv._contentWrap.innerHTML; } catch (_) { }
                    }
                    // ★ 100% 落盘保证：错误楼层的用户消息+错误消息强制写盘，不依赖 auto-save 竞态
                    if (qid && typeof _saveAgentQuestData === 'function') {
                        _saveAgentQuestData(qid, agent, agent._currentFloorNum).catch(function () { });
                    }
                }
                // ★ 清理 aiDiv 流式渲染状态，防止 doStreamRender 定时器"诈尸"
                if (aiDiv) {
                    aiDiv._renderScheduled = false;
                    aiDiv._dirty = false;
                    aiDiv._guideMode = false;
                    if (aiDiv._lastParaEl) { aiDiv._lastParaEl.remove(); aiDiv._lastParaEl = null; }
                }
                if (typeof _unregisterBuilding === 'function') _unregisterBuilding(qid);
                if (_activeAgent === agent) {
                    if (aiDiv && aiDiv._floorCompleted) {
                        setStreaming(false);
                        return;
                    }
                    // ★ 聚合红框：追加错误行到 quest 级错误日志，渲染一个框
                    var _now = new Date();
                    var _ts = _now.getHours().toString().padStart(2, '0') + ':' + _now.getMinutes().toString().padStart(2, '0');
                    if (agent) {
                        agent._questErrorLog.push({ time: _ts, reason: msg });
                    }
                    // ★ 清理延迟渲染残骸（兜底）
                    // ★ 注意：不清 _deferRenderUntilHouse1（恢复中 onError 需保持，由 _finishRecovery 处理）
                    if (agent) {
                        agent._deferredUserEl = null;
                        agent._deferredAiDiv = null;
                    }
                    _renderQuestErrorBox(agent, aiDiv);
                    _stopAllTxtStream(agent);
                    stopFloorTimer(null, agent);
                    setStreaming(false);
                    if ($sendBtn) $sendBtn.disabled = true;
                } else {
                    // ★ 后台 agent 错误：仍需停 timer + 停 all.txt 流（否则时钟僵尸 + 轮询泄漏）
                    //   running 标记已在上方统一释放，此处不再重复
                    if (agent && agent._floorTimerId) {
                        clearInterval(agent._floorTimerId);
                        agent._floorTimerId = null;
                    }
                    _stopAllTxtStream(agent);
                    // 后台 agent 的 aiDiv 时钟设为停止态
                    var _bgAiDiv2 = agent && agent._activeAiDiv;
                    if (_bgAiDiv2 && _bgAiDiv2._clockBlock) {
                        _bgAiDiv2._clockBlock.className = 'msg-ai-clock';
                        var _elapsed3 = performance.now() - agent._floorStartPerf;
                        var _durS3 = Math.floor(_elapsed3 / 1000);
                        if (_bgAiDiv2._clockMin) _bgAiDiv2._clockMin.textContent = Math.floor(_durS3 / 60) + 'm';
                        if (_bgAiDiv2._clockSec) _bgAiDiv2._clockSec.textContent = ':' + (_durS3 % 60 < 10 ? '0' : '') + (_durS3 % 60) + 's';
                    }
                    // 记录错误 timing
                    agent._floorTimings = agent._floorTimings || [];
                    agent._floorTimings.push({
                        floorIndex: agent._ctx ? agent._ctx.totalFloors : 0,
                        durationMs: Math.round(performance.now() - agent._floorStartPerf),
                        error: msg,
                        finishedAt: new Date().toISOString()
                    });
                    // ★ P11：后台 agent 错误后刷新 tofu
                    updateQuestTofu();
                }
            }
        });
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            // ★ 延迟渲染残骸清理：同步异常时清理暂存引用
            if (agent) {
                agent._deferredUserEl = null;
                agent._deferredAiDiv = null;
                agent._deferRenderUntilHouse1 = false;
            }
            addMessageEll('error', err.message || 'Unknown error', qid);  // ★ P10：错误消息记入被捕获 quest 的 card
            // ★ 异常不可恢复 → fatal（统一归入 fatal 管线，不依赖 auto-save）
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
            // ★ fatal 态禁队列排水
        }
    } finally {
        // ★ 一次渲染永久不变：在清理 _activeAiDiv 之前，先保存当前楼层数据（含流式文本）
        //   sending 态正常保存；fatal 态也保存（belt-and-suspenders：onError 已火线落盘，此处兜底）
        // ★ 正常完结楼层：保存最终所有.json（包括恢复成功后的全量数据）
        if (agent && qid && agent._floorCompletedCleanly) {
            try { await _saveAgentQuestData(qid, agent, agent._currentFloorNum); } catch (_) { }
        }
        // ★ sending/fatal 态保存（belt-and-suspenders）
        if (agent && qid && !agent._floorCompletedCleanly
            && (agent._stopState === 'sending' || agent._floorFatal)) {
            try { await _saveAgentQuestData(qid, agent, agent._currentFloorNum); } catch (_) { }
        }
        _stopAllTxtStream(agent);
        // ★ 通用 timer 清理：无论前台/后台，防止僵尸 timer
        if (agent && agent._floorTimerId) {
            clearInterval(agent._floorTimerId);
            agent._floorTimerId = null;
        }
        // ★ Stop 闭环：STOPPING 态显式持久化 + 状态机复位
        if (agent && agent._stopState === 'stopping') {
            if (typeof stopFloorTimer === 'function') {
                stopFloorTimer(agent._floorTiming || { networkMs: 0, aiMs: 0, otherMs: 0 }, agent);
            }
            setStreaming(false);
            // ★ 永不自停：Stop 不暂停队列，用户手动点暂停才停
            // 保存楼层数据到 sq3
            if (qid) {
                try { await _saveAgentQuestData(qid, agent, agent._currentFloorNum); } catch (_) { }
            }
            agent.setStopState('idle');
            agent._stopCtrl = null;
        }
        // ★ 时钟收尾：无论 agent 是否当前活跃，楼层完结即设停止态（变黑）
        if (agent) {
            if (agent._activeAiDiv) {
                var _elapsed = performance.now() - agent._floorStartPerf;
                var _totalS = Math.floor(_elapsed / 1000);
                var _min = Math.floor(_totalS / 60);
                var _sec = _totalS % 60;
                if (agent._activeAiDiv._clockBlock) {
                    agent._activeAiDiv._clockBlock.className = 'msg-ai-clock';
                }
                if (agent._activeAiDiv._clockMin) {
                    agent._activeAiDiv._clockMin.textContent = _min + 'm';
                    agent._activeAiDiv._clockSec.textContent = ':' + (_sec < 10 ? '0' : '') + _sec + 's';
                }
                agent._activeAiDiv._renderScheduled = false;
                agent._activeAiDiv = null;
            }
        }
        // ═══ 楼层看门狗：仅当 onDone 和 onError 都未调用时才自动恢复 ═══
        // 铁律：绝不 reload，但必须持久化计时数据（否则重启窗口丢失 A3 时钟/饼图）
        if (agent && !agent._floorCompletedCleanly && agent._stopState === 'sending' && !agent._floorOnErrorCalled) {
            console.log('[watchdog] floor ended headless — saving timing then yielding');
            // ★ 可点击"重新发送"：用户一键回滚断头楼层并重发
            var _errDiv = document.createElement('div');
            _errDiv.className = 'msg msg-error';
            _errDiv.style.whiteSpace = 'pre-wrap';
            _errDiv.appendChild(document.createTextNode('\u26a0\ufe0f \u697c\u5c42\u5f02\u5e38\u4e2d\u65ad\uff0c\u5bf9\u8bdd\u5df2\u4fdd\u5b58\u3002'));
            var _resendLink = document.createElement('a');
            _resendLink.textContent = '\u91cd\u65b0\u53d1\u9001';
            _resendLink.href = '#';
            _resendLink.style.cssText = 'cursor:pointer;text-decoration:underline;color:var(--accent-color,#4a9eff);margin-left:2px;';
            _resendLink.onclick = function (e) {
                e.preventDefault();
                _resendLink.onclick = null;
                _resendLink.textContent = '正在发送...';
                // ★ 不滚 conversation、不删 DOM、不减楼层
                //    模拟用户用原话 + 诊断原因发送一条"继续"消息
                var _userText = (agent._lastUserInput && agent._lastUserInput.text) || '';
                var _diag = '';
                try { _diag = (agent._buildDiagnosis && agent._buildDiagnosis()) || ''; } catch (__) { }
                var _continueMsg = '由于 ' + (_diag || '未知原因') + ' 导致会话中断，请继续。';
                // ★ 原用户键入 + 中断诊断一起体现
                var _fullMsg = _continueMsg + '\n\n[原始请求]: ' + _userText;
                // 清理错误条（不移除用户消息/AI在建div，保持上下文完整）
                if (_errDiv.parentNode) _errDiv.remove();
                // 模拟用户发送
                $input.value = _fullMsg;
                $input.focus();
                sendMessage();
            }
            _errDiv.appendChild(_resendLink);
            _appendToCard(_errDiv);
            // ★ 持久化断头楼层的时钟数据（否则重启窗口后 A3 归零）
            var _elapsed2 = performance.now() - agent._floorStartPerf;
            var _tm = agent._floorTiming || { networkMs: 0, aiMs: 0, otherMs: 0 };
            var _record = {
                floorIndex: agent._ctx ? agent._ctx.totalFloors : 0,
                durationMs: Math.round(_elapsed2),
                networkMs: _tm.networkMs || 0,
                aiMs: _tm.aiMs || 0,
                otherMs: _tm.otherMs || 0,
                finishedAt: new Date().toISOString()
            };
            agent._lastFloorTimingRecord = _record;
            agent._floorTimings = agent._floorTimings || [];
            agent._floorTimings.push(_record);
            // 触发一次保存（异步，best-effort）
            if (typeof saveQuestData === 'function') {
                saveQuestData().catch(function () { });
            }
        }
        if (agent) {
            agent._streaming = false;
        }
        // ★ 中央建楼状态机：确保注销（onDone/onError 已处理，此处兜底看门狗/异常路径）
        if (qid && typeof _unregisterBuilding === 'function') _unregisterBuilding(qid);
        _queueBusy = false;
        // ★ 队列自动排水：楼层完结后（onDone 内因 _queueBusy=true 被阻断），此处补排
        if (_queue && _queue.length > 0 && !_queuePaused && _activeAgent === agent) {
            _triggerQueueSend();
        }
        if (_activeAgent === agent) {
            setStreaming(false);
        } else if (qid && !agent._floorCompletedCleanly && !agent._floorOnErrorCalled) {

        }
    }
}

function _continueQueue() {
    var _qs = document.getElementById('queue-sending-status');
    if (_qs) _qs.remove();
    if (_queuePaused) return;
    if (_activeAgent !== agent) return;
    _triggerQueueSend();
}

// ═══ 聚合红框：per-floor 单框多行错误 + 单链接（一次渲染永久不变，仅追加） ═══
// ★ 铁律：红框追加到楼层 AI div 的 _contentWrap 内，永不 innerHTML 清空
//   aiDiv: 可选，不传则自动从活跃 agent 的 _activeAiDiv 获取
function _renderQuestErrorBox(agent, aiDiv) {
    if (!agent || !questActiveId) return;
    var _log = agent._questErrorLog;
    if (!_log || _log.length === 0) return;

    // ★ 跨楼层红框：优先使用 agent._questErrorDiv（封顶楼层引用的红框）
    var _box = null;
    if (agent._questErrorDiv && agent._questErrorDiv.isConnected) {
        _box = agent._questErrorDiv;
    }
    // ★ 跨楼层搜索：card-pool 重载后缓存的 _questErrorDiv 已断开，
    //   需搜索所有楼层 DOM 中已有的红框（_buildConversationFlowHtml 静态重建的）
    if (!_box) {
        var _card = cardPool && cardPool.getActive();
        if (_card && _card.floorDOM) {
            var _fnums = Object.keys(_card.floorDOM).map(Number).sort(function (a, b) { return b - a; });
            for (var _fi = 0; _fi < _fnums.length && !_box; _fi++) {
                var _fDom = _card.floorDOM[_fnums[_fi]];
                if (_fDom && _fDom.aiEl && _fDom.aiEl._contentWrap) {
                    _box = _fDom.aiEl._contentWrap.querySelector('.msg-quest-error');
                }
            }
        }
    }
    // 仍找不到 → 在当前楼层 AI div 内建新红框
    if (!_box) {
        var _targetAi = aiDiv || (agent._activeAiDiv);
        if (!_targetAi || !_targetAi._contentWrap) return;
        _box = document.createElement('div');
        _box.className = 'msg-quest-error';
        _targetAi._contentWrap.appendChild(_box);
    }
    // ★ 存储跨楼层引用（铁律：一次渲染永久不变）
    agent._questErrorDiv = _box;

    // ★ 仅追加新行（不清空）
    var _lastLog = _log[_log.length - 1];
    if (_lastLog) {
        var _row = document.createElement('div');
        _row.className = 'qe-row';
        _row.textContent = (_lastLog.time || '') + '  ' + (_lastLog.reason || '');
        _box.appendChild(_row);
    }

    // ★ 更新 / 创建「继续任务」链接（始终在最底部）
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
        if (!agent._deferRenderUntilHouse1) {
            _link.style.display = '';
            _link.className = 'msg-err-continue';
            _link._qqqRecoveryBusy = false;
            _link.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
        }
    }
}

// ★ 清除红框中的「继续任务」链接/白块（恢复成功后彻底移除，不藏不残留）
function _hideRecoveryLink(agent) {
    if (!agent) return;
    var _link = null;
    // 路径1：跨楼层红框链接
    if (agent._questErrorDiv && agent._questErrorDiv._continueLink && agent._questErrorDiv._continueLink.isConnected) {
        _link = agent._questErrorDiv._continueLink;
        agent._questErrorDiv._continueLink = null;
    }
    // 路径2：通过 _recoveryLinkEl
    if (!_link && agent._recoveryLinkEl && agent._recoveryLinkEl.isConnected) {
        _link = agent._recoveryLinkEl;
        agent._recoveryLinkEl = null;
    }
    // 路径3：从当前 _contentWrap 中查找（兜底，搜动画 + 非动画两类 class）
    if (!_link && agent._activeAiDiv && agent._activeAiDiv._contentWrap) {
        _link = agent._activeAiDiv._contentWrap.querySelector('.msg-err-recovery-light, .msg-err-continue');
    }
    if (!_link) return;
    // ★ 彻底清除：先杀动画 class → 停 CSS animation → 再删 DOM 节点
    _link.className = '';
    _link.style.cssText = '';
    _link.textContent = '';
    _link._qqqRecoveryDone = true;
    _link._qqqRecoveryBusy = false;
    _link._qqqRecoveryOrigText = '';
    _link.onclick = null;
    try { _link.remove(); } catch (_) { _link.parentNode && _link.parentNode.removeChild(_link); }
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
    if (agent._questErrorLog && agent._questErrorLog.length > 0) {
        _recoveryText = '网络恢复重连。此前中断记录：';
        for (var _ei = 0; _ei < agent._questErrorLog.length; _ei++) {
            _recoveryText += '｜' + agent._questErrorLog[_ei].time + ' ' + agent._questErrorLog[_ei].reason;
        }
        _recoveryText += '｜请基于上下文继续完成原始任务。';
    }

    // ★ 将恢复消息写入输入框（sendMessage 读取它作为 userContent）
    var _savedInput = $input.value;
    $input.value = _recoveryText;

    // ★ 配置恢复标记：
    //   _isRecovery → agent-loop 为 userMsg 标 _system:true + 不增 totalFloors（同楼层追加）
    agent._isRecovery = true;
    agent._inRecoverySend = false;
    agent._recoveryInProgress = false;
    // ★ 启封按钮：退出 fatal 态 → sendMessage 内 setStreaming(true) 可正确启用 Stop 按钮
    agent.setStopState('sending');

    try {
        await sendMessage(true);
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
        // ★ 不恢复 _recoveryInProgress：_finishRecovery 已正确处理（设 false）
        //   若还原旧值（true），agent 将永远卡在恢复中
        $input.value = _savedInput;
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
    if (agent._questErrorLog && agent._questErrorLog.length > 0) {
        for (var _ei = 0; _ei < agent._questErrorLog.length; _ei++) {
            _recoveryText += '｜' + agent._questErrorLog[_ei].time + ' ' + agent._questErrorLog[_ei].reason;
        }
    }
    _recoveryText += '｜请基于完整对话上下文继续完成原始任务。';

    // ★ 将恢复消息写入输入框
    var _savedInput = $input.value;
    $input.value = _recoveryText;

    // ★ 配置恢复标记：
    //   _isRecovery → agent-loop 为 userMsg 标 _system:true
    //   不传 skipFloorCreation → 创建新楼层（新粉色气泡）
    agent._isRecovery = true;
    agent._inRecoverySend = false;
    agent._recoveryInProgress = false;
    // ★ N-house 恢复：新楼层必须创建粉色气泡，解除 _deferRenderUntilHouse1
    //   该 flag 仅为 0-house 恢复设计（复用已有气泡），N-house 新建楼层不适用
    agent._deferRenderUntilHouse1 = false;
    // ★ 启封按钮：退出 fatal 态 → sendMessage 内 setStreaming(true) 可正确启用 Stop 按钮
    agent.setStopState('sending');

    try {
        await sendMessage(false);  // ★ false = 创建新楼层
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
        // ★ 失败：光块恢复为"继续任务"（红框已在 onError 中追加新行）
        if (linkEl && linkEl.isConnected) {
            linkEl._qqqRecoveryDone = false;
            linkEl.textContent = linkEl._qqqRecoveryOrigText ||
                ((typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务');
            linkEl.className = 'msg-err-continue';
            linkEl.style.cssText = 'text-decoration:underline;cursor:pointer;color:var(--accent-color,#4a9eff);margin-left:4px;';
            linkEl._qqqRecoveryBusy = false;
            linkEl._qqqRecoveryOrigText = '';
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
