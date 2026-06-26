'use strict';
// \u2550\u2550\u2550 panel-send.js \u2550\u2550\u2550
// sendMessage, input helpers, event handlers, window exports

async function sendMessage() {
    if (_sending) return;
    // ★ Stop 闭环：STOPPING 态下禁止新发送（等清理完成才能 Send）
    if (_activeAgent && _activeAgent._stopState === 'stopping') return;
    if (!_hasMainProject()) { _triggerSelectMainProject(); return; }
    _checkTokenReset();
    _sending = true;
    var _guideStatuses = document.querySelectorAll('.guide-status');
    for (var _gsi = 0; _gsi < _guideStatuses.length; _gsi++) { _guideStatuses[_gsi].remove(); }
    // ═══ 所有权守卫：仅父注册表（唯一真理源） ═══
    // ── 快照 quest 上下文（所有 await 之前，防并发切 quest 错位）──
    _capturedQuestId = questActiveId;
    _capturedAgent = _activeAgent;
    if (_capturedQuestId) {
        try {
            var _ssSyncOwner = _parentGetQuestOwner(_capturedQuestId);
            if (_ssSyncOwner !== undefined && _ssSyncOwner !== _panelId) {
                // 另一面板持有此 quest → 跳转焦点，放弃发送
                _setPanelFocus(false);
                _broadcast('focus-request', _capturedQuestId, { targetPanel: _ssSyncOwner });
                _sending = false;
                updateQueueBtn();
                return;
            }
            // 无人持有 → 声明所有权（兜底：新建 quest 时 switchQuest 未调用）
            if (_ssSyncOwner === undefined) {
                _parentClaimQuest(_capturedQuestId);
                _broadcast('owner-claimed', _capturedQuestId);
            }
        } catch (_) { }
    }
    updateQueueBtn();
    var text = getInputText().trim();
    var chipPaths = getInputChipPaths();
    if (!text && chipPaths.length === 0) { _sending = false; updateQueueBtn(); return; }
    if (streaming) { _sending = false; updateQueueBtn(); return; }

    var token = getToken();
    if (!token) {
        try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('请先在顶部键入 Token 并点击 Save', { type: 'warning', duration: 6000 }); } catch (_) { }
        _sending = false;
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

    // \u6784\u5efa\u7528\u6237\u6d88\u606f\u663e\u793a
    var userMsgEl = addMessageEl('user', text);
    userMsgEl._floor = agent ? agent._ctx.totalFloors : 0;
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

    saveQuestUIState(_capturedQuestId);
    $input.value = '';
    $input._resetUndo();
    pendingImages = [];
    renderImageStrip();
    $input.focus();

    // \u82e5\u5c1a\u65e0 active quest\uff0c\u521b\u5efa\u5e76\u547d\u540d
    if (_isDraft(_capturedQuestId)) {
        try {
            var qId = await questStore.create('');
            if (!qId) { _sending = false; updateQueueBtn(); return; }
            questActiveId = qId;
            // ★ Copy draft's tier preference to real quest (per-quest tier memory)
            if (questUIStates[_capturedQuestId] && typeof questUIStates[_capturedQuestId].selectedTier === 'number') {
                if (!questUIStates[questActiveId]) questUIStates[questActiveId] = {};
                questUIStates[questActiveId].selectedTier = questUIStates[_capturedQuestId].selectedTier;
                selectedTier = questUIStates[_capturedQuestId].selectedTier;
            }
            _activeAgent = _getOrCreateAgent(questActiveId);
            if (_panelId === 1) await questStore.setActiveId(questActiveId);
            if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
                // ★ setNow 立即写盘：新建 quest 后必须可靠持久化 activeQuestId
                onlyStore.setNow('ai.panel.' + _panelId + '.activeQuestId', questActiveId);
            }
            _parentClaimQuest(questActiveId);
            _broadcast('owner-claimed', questActiveId);
            var firstMsg = text || (userContent || '').split('\n')[0];
            var root = questStore.getProjectRoot();
            if (root) {
                var questNum = parseInt(questActiveId.slice(1)) || 1;
                var qName = _makeName('q', questNum, firstMsg);
                var fName = _makeName('f', 1, firstMsg);
                var dotIdx = qName.indexOf('.');
                var questTitle = dotIdx >= 0 ? qName.slice(dotIdx + 1) : ('Quest ' + questNum);
                await questStore.rename(questActiveId, questTitle, questNum);
                await _ensureQuestDir(root, qName, fName);
            }
            await renderTabs();  // ★ 必须 await：确保 tofu 在卡片迁移前更新
            // ★ Fix: draft → real quest card 迁移
            // 用户消息已附加到 draft card，需迁移到真实 quest card
            if (cardPool && _isDraft(cardPool._activeId)) {
                var _oldDraftId = cardPool._activeId;
                var _draftCard = cardPool._cards[_oldDraftId];
                if (_draftCard && _draftCard._contentWrap) {
                    var _realCard = cardPool.getOrCreate(questActiveId);
                    while (_draftCard._contentWrap.firstChild) {
                        _realCard._contentWrap.appendChild(_draftCard._contentWrap.firstChild);
                    }
                    _draftCard.dom.style.display = 'none';
                    _realCard.dom.style.display = 'block';
                    cardPool._activeId = questActiveId;
                    // 清理 draft card 释放 pool 槽位
                    cardPool.removeCard(_oldDraftId);
                }
            }
            _capturedQuestId = questActiveId;
            _capturedAgent = _activeAgent;
        } catch (_draftErr) {
            console.warn('[send] draft->quest creation failed:', _draftErr && _draftErr.message);
            addMessageEl('error', '创建 Quest 失败：' + ((_draftErr && _draftErr.message) || '未知错误'));
            _sending = false;
            updateQueueBtn();
            return;
        }
    }
    var floorNum = await questStore.nextFloorNum(_capturedQuestId);
    var root2 = questStore.getProjectRoot();
    if (root2 && floorNum > 0) {
        var userQuestion = text || (userContent || '').split('\n')[0];
        var quests2 = await questStore.list();
        var qEntry = quests2.find(function (qx) { return qx.id === _capturedQuestId; });
        var qTitle2 = (qEntry && qEntry.title && qEntry.title !== 'New Chat') ? qEntry.title : '';
        var qNumericId = (qEntry && qEntry.numericId) ? qEntry.numericId : parseInt(_capturedQuestId.replace('q', ''), 10) || 0;
        // ★ 前缀搜索已有目录（B+ 方案：懒惰修正，不实时 rename）
        var qDirName2 = await _resolveQuestDirName(root2, _capturedQuestId, qNumericId, qTitle2);
        var fDirName2 = _makeName('f', floorNum, userQuestion);
        var _ensured = await _ensureQuestDir(root2, qDirName2, fDirName2);
        // ★ 保存图片到楼层目录（确保重启后可还原）
        if (_ensured && _ensured.fDir && pendingImages.length > 0) {
            var _bridge = window.parent && window.parent.qqqideBridge;
            if (_bridge && _bridge.fs) {
                for (var _imi = 0; _imi < pendingImages.length; _imi++) {
                    var _pimg = pendingImages[_imi];
                    var _fileName = 'img_' + _pimg.id + '.png';
                    try {
                        var _binStr = atob(_pimg.base64);
                        var _bytes = new Uint8Array(_binStr.length);
                        for (var _bi = 0; _bi < _binStr.length; _bi++) { _bytes[_bi] = _binStr.charCodeAt(_bi); }
                        // fs.write expects UTF-8 string; write base64 as file via bridge
                        // ★ 使用 write_file（bridge.fs.write）写二进制：传 base64 标记
                        if (typeof _bridge.fs.writeBase64 === 'function') {
                            await _bridge.fs.writeBase64(_ensured.fDir + _fileName, _pimg.base64);
                        } else {
                            // 降级：存 dataUrl（可被识别为图片）
                            await _bridge.fs.write(_ensured.fDir + _fileName, _pimg.dataUrl);
                        }
                        _pimg.fileName = _fileName;
                    } catch (_imgSaveErr) {
                        console.warn('[img-save] failed to save image to disk:', _imgSaveErr);
                    }
                }
            }
        }
    }
    // ★ 铁律：不再修改 _ctx.totalFloors。_currentFloorNum 是楼层的不可变标识。
    var _floorStartIdx = agent.conversation.length;
    agent._floorStartIdx = _floorStartIdx;
    agent._currentFloorNum = floorNum;
    // ★ 存储该楼层的不可变元数据（所有保存路径使用此元数据，而非 agent 全局变量）
    if (!agent._floorMeta) agent._floorMeta = {};
    var _projectRoot = root2 || questStore.getProjectRoot();
    var _allTxtDirLocal = '';
    if (_projectRoot) {
        _allTxtDirLocal = _projectRoot + '/qqq/quests/' + (typeof qDirName2 !== 'undefined' ? qDirName2 : '') + '/' + (typeof fDirName2 !== 'undefined' ? fDirName2 : '') + '/';
    }
    var _allTxtPathLocal = _allTxtDirLocal ? _allTxtDirLocal + 'all.txt' : '';
    agent._allTxtPath = _allTxtPathLocal;
    agent._floorMeta[floorNum] = {
        floorStartIdx: _floorStartIdx,
        allTxtPath: _allTxtPathLocal,
        _fDir: _allTxtDirLocal,
        createdAt: Date.now()
    };
    var _bridge = window.parent && window.parent.qqqideBridge;
    if (_bridge && _allTxtDirLocal) {
        try { await _bridge.fs.mkdir(_allTxtDirLocal); } catch (_) { }
    }
    var aiDiv = cardPool.startBuildingFloor(_capturedQuestId, floorNum, _allTxtPathLocal);
    if (!aiDiv) { _sending = false; updateQueueBtn(); return; }
    aiDiv._allTxtPath = _allTxtPathLocal;
    // ★ 新楼层开始，清空 agent._houses / _a4Snapshots 防止读到上一楼层残影
    _capturedAgent._houses = [];
    _capturedAgent._a4Snapshots = {};
    _capturedAgent._lastAutoSaveLen = 0;
    _capturedAgent._lastFloorTimingRecord = null;
    _capturedAgent._aiStartTime = '';
    _capturedAgent._aiTierLabel = '';
    startFloorTimer(aiDiv, _capturedAgent);
    _startAllTxtStream(aiDiv, _allTxtPathLocal, _capturedAgent, floorNum, text, '');
    _startAutoSave();
    scrollToBottom(true);
    setStreaming(true);
    // ★ 中央建楼状态机：登记 quest 开始建楼
    if (typeof _registerBuilding === 'function') _registerBuilding(_capturedQuestId, typeof _panelId !== 'undefined' ? _panelId : 1);

    // ═══ E-Flow: Expert Document Framework trigger ═══
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
        await agent.send(userContent, {
            images: images,
            token: token,
            tier: selectedTier ? TIER_LIST[selectedTier] : null,
            onToken: function (chunk) {
                // ★ 记录 AI 真正开始干活的时间（仅第一次）
                if (!_capturedAgent._aiStartTime) {
                    _capturedAgent._aiStartTime = new Date().toISOString().replace('T', ' ').slice(0, 19);
                    _capturedAgent._aiTierLabel = 'A' + (selectedTier || 6);
                }
                var _targetDiv = (aiDiv && aiDiv.isConnected) ? aiDiv : (_capturedAgent._activeAiDiv || aiDiv);
                if (!_targetDiv) return;
                _targetDiv._buf = (_targetDiv._buf || '') + chunk;
                _targetDiv._fullText = (_targetDiv._fullText || '') + chunk;
                _targetDiv._paras = _targetDiv._paras || [];
                // ★ 增量拆分：只 split 从 _splitCursor 之后的新内容，避免每轮重推全部历史段落
                //   _splitCursor = 上次已 split 到的 _buf 字符位置
                if (typeof _targetDiv._splitCursor !== 'number') _targetDiv._splitCursor = 0;

                // ═══ 增量解析器：代码围栏（```...```）感知拆分 ═══
                // 核心：围栏内部的 \n\n 是代码内容，不可拆分为段落
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
                            setTimeout(function () { doStreamRender(_capturedAgent); }, _rd);
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
                    setTimeout(function () { doStreamRender(_capturedAgent); }, _rd2);
                }
                if (_activeAgent === _capturedAgent && !_scrollPending) {
                    _scrollPending = true;
                    requestAnimationFrame(function () {
                        scrollToBottom();
                        _scrollPending = false;
                    });
                }
            },

            onDone: async function (content, timing) {
                _stopAutoSave();
                if (aiDiv) aiDiv._floorCompleted = true;
                aiDiv._renderScheduled = false;
                var _targetDiv2 = (aiDiv && aiDiv.isConnected) ? aiDiv : (_capturedAgent._activeAiDiv || aiDiv);
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
                        _rendered++;
                    }
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

                if (_activeAgent === _capturedAgent) {
                    stopFloorTimer(timing || { networkMs: 0, aiMs: 0, otherMs: 0 }, _capturedAgent);
                    scrollToBottom();
                } else {
                    // ★ 后台 agent 楼层完结：停 timer + 记录 timing（不停 timer 会导致切回后时钟继续走）
                    if (_capturedAgent._floorTimerId) { clearInterval(_capturedAgent._floorTimerId); _capturedAgent._floorTimerId = null; }
                    var _elapsed = performance.now() - _capturedAgent._floorStartPerf;
                    _capturedAgent._floorTimings = _capturedAgent._floorTimings || [];
                    var _bgRecord = {
                        floorIndex: _capturedAgent._ctx.totalFloors,
                        durationMs: Math.round(_elapsed),
                        networkMs: (timing && timing.networkMs) || 0,
                        aiMs: (timing && timing.aiMs) || 0,
                        otherMs: (timing && timing.otherMs) || 0,
                        finishedAt: new Date().toISOString()
                    };
                    _capturedAgent._floorTimings.push(_bgRecord);
                    _capturedAgent._lastFloorTimingRecord = _bgRecord;
                    // 若后台 agent 的 aiDiv 仍在线（同面板切换未清理），设时钟为停止态
                    var _bgAiDiv = _capturedAgent._activeAiDiv;
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
                _capturedAgent._streaming = false;
                // ★ 释放中心机器 running 标记（setStreaming(false) 不再负责此事）
                _markQuestRunning(_capturedQuestId, false);
                // ★ 中央建楼状态机：注销 quest 建楼状态
                if (typeof _unregisterBuilding === 'function') _unregisterBuilding(_capturedQuestId);
                if (_panelRunningQuestId === _capturedQuestId) _panelRunningQuestId = null;
                if (_activeAgent === _capturedAgent) {
                    setStreaming(false);
                }

                await _saveAgentQuestData(_capturedQuestId, _capturedAgent, floorNum);

                if (cardPool) cardPool.completeBuildingFloor(_capturedQuestId, floorNum);

                if (_activeAgent === _capturedAgent && _divDetached) {
                    console.warn('[onDone] div detached but card pool not available, skipping rebuild');
                }

                var _ftxtPath = (_targetDiv2 && _targetDiv2._allTxtPath) || _capturedAgent._allTxtPath || '';
                await _finalizeAllTxt(_targetDiv2 || aiDiv, _ftxtPath, _capturedAgent, floorNum, timing);
                if (_activeAgent === _capturedAgent) {
                    updateCtxBtn();
                    updateQuestTofu();  // ★ 楼层完成后刷新 tofu（防草稿→正式 quest 后未及时更新）
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
            },

            onGuideAckDone: function () {
                var _aiDiv3 = _activeAgent._activeAiDiv;
                if (_aiDiv3) {
                    _aiDiv3._guideMode = false;
                    // 只清流式缓冲，保留已渲染的 DOM 和段落跟踪
                    _aiDiv3._buf = '';
                }
            },

            onCost: async function (cost, total, isFree) {
                if (_activeAgent === _capturedAgent) {
                    var costNum = parseFloat(cost);
                    if (!isNaN(costNum)) {
                        _windowTotalCostGe += costNum;
                    }
                    _updateCostDisplay();
                    _fetchBalanceIfNeeded();
                    var _targetDiv3 = (aiDiv && aiDiv.isConnected) ? aiDiv : (_capturedAgent._activeAiDiv || aiDiv);
                    if (_targetDiv3 && _targetDiv3._clockCost) {
                        var _rawGe = _capturedAgent._floorCostWge / 10000;
                        var _displayGe = _formatGeDisplay(_rawGe);
                        _targetDiv3._clockCost._rawGe = _formatGeRaw(_rawGe);
                        _targetDiv3._clockCost.textContent = _displayGe + ' ge' + (isFree ? ' Free' : '');
                        _targetDiv3._clockCost.style.display = 'inline';
                        if (isFree) {
                            _targetDiv3._clockCost.style.color = '#859900';
                        } else {
                            _targetDiv3._clockCost.style.color = '';
                        }
                    }
                }
            },
            onError: function (msg) {
                if (_activeAgent === _capturedAgent) _sending = false;  // ★ 仅前台复位，后台 agent 错误不影响前台
                _stopAutoSave();
                if (_capturedAgent) {
                    _capturedAgent._floorOnErrorCalled = true;  // ★ 看门狗：标记已处理
                    // ★ 一次渲染永久不变：错误消息推入 conversation 持久化
                    _capturedAgent.conversation.push({
                        role: 'assistant',
                        content: msg,
                        _error: true,
                        _floor: _capturedAgent._ctx.totalFloors
                    });
                }
                // ★ 清理 aiDiv 流式渲染状态，防止 doStreamRender 定时器"诈尸"
                if (aiDiv) {
                    aiDiv._renderScheduled = false;
                    aiDiv._dirty = false;
                    aiDiv._guideMode = false;
                    if (aiDiv._lastParaEl) { aiDiv._lastParaEl.remove(); aiDiv._lastParaEl = null; }
                }
                // ★ 释放中心机器 running 标记（setStreaming 不再负责此事）
                _markQuestRunning(_capturedQuestId, false);
                // ★ 中央建楼状态机：注销 quest 建楼状态
                if (typeof _unregisterBuilding === 'function') _unregisterBuilding(_capturedQuestId);
                if (_panelRunningQuestId === _capturedQuestId) _panelRunningQuestId = null;
                if (_activeAgent === _capturedAgent) {
                    if (aiDiv && aiDiv._floorCompleted) {
                        setStreaming(false);
                        return;
                    }
                    // ★ 统一红框：消息文本 + "继续任务"链接（仅聚焦键入框）
                    var _errDiv = addMessageEl('error', msg);
                    if (_errDiv) {
                        var _continueLink = document.createElement('a');
                        _continueLink.textContent = (typeof _i === 'function') ? _i('ai.error.continueTask', '继续任务') : '继续任务';
                        _continueLink.href = '#';
                        _continueLink.className = 'msg-err-continue';
                        _continueLink.style.cssText = 'text-decoration:underline;cursor:pointer;color:var(--accent-color,#4a9eff);margin-left:4px;';
                        _continueLink.onclick = function (e) {
                            e.preventDefault();
                            $input.focus();
                            scrollToBottom(true);
                        };
                        _errDiv.appendChild(_continueLink);
                    }
                    _stopAllTxtStream();
                    stopFloorTimer(null, _capturedAgent);
                    setStreaming(false);
                    // ★ 永不自停：任何错误都继续队列，网络波动不阻断
                    if (_queue.length > 0) {
                        _continueQueue();
                    }
                } else {
                    // ★ 后台 agent 错误：仍需停 timer + 停 all.txt 流（否则时钟僵尸 + 轮询泄漏）
                    //   running 标记已在上方统一释放，此处不再重复
                    if (_capturedAgent && _capturedAgent._floorTimerId) {
                        clearInterval(_capturedAgent._floorTimerId);
                        _capturedAgent._floorTimerId = null;
                    }
                    _stopAllTxtStream();
                    // 后台 agent 的 aiDiv 时钟设为停止态
                    var _bgAiDiv2 = _capturedAgent && _capturedAgent._activeAiDiv;
                    if (_bgAiDiv2 && _bgAiDiv2._clockBlock) {
                        _bgAiDiv2._clockBlock.className = 'msg-ai-clock';
                        var _elapsed3 = performance.now() - _capturedAgent._floorStartPerf;
                        var _durS3 = Math.floor(_elapsed3 / 1000);
                        if (_bgAiDiv2._clockMin) _bgAiDiv2._clockMin.textContent = Math.floor(_durS3 / 60) + 'm';
                        if (_bgAiDiv2._clockSec) _bgAiDiv2._clockSec.textContent = ':' + (_durS3 % 60 < 10 ? '0' : '') + (_durS3 % 60) + 's';
                    }
                    // 记录错误 timing
                    _capturedAgent._floorTimings = _capturedAgent._floorTimings || [];
                    _capturedAgent._floorTimings.push({
                        floorIndex: _capturedAgent._ctx ? _capturedAgent._ctx.totalFloors : 0,
                        durationMs: Math.round(performance.now() - _capturedAgent._floorStartPerf),
                        error: msg,
                        finishedAt: new Date().toISOString()
                    });
                }
            }
        });
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            addMessageEl('error', err.message || 'Unknown error');
            _continueQueue();
        }
    } finally {
        // ★ 一次渲染永久不变：在清理 _activeAiDiv 之前，先保存当前楼层数据（含流式文本）
        if (_capturedAgent && _capturedQuestId && !_capturedAgent._floorCompletedCleanly && _capturedAgent._stopState === 'sending') {
            try { await _saveAgentQuestData(_capturedQuestId, _capturedAgent, _capturedAgent._currentFloorNum); } catch (_) { }
        }
        _stopAllTxtStream();
        // ★ 通用 timer 清理：无论前台/后台，防止僵尸 timer
        if (_capturedAgent && _capturedAgent._floorTimerId) {
            clearInterval(_capturedAgent._floorTimerId);
            _capturedAgent._floorTimerId = null;
        }
        // ★ Stop 闭环：STOPPING 态显式持久化 + 状态机复位
        if (_capturedAgent && _capturedAgent._stopState === 'stopping') {
            _stopAutoSave();
            if (typeof stopFloorTimer === 'function') {
                stopFloorTimer(_capturedAgent._floorTiming || { networkMs: 0, aiMs: 0, otherMs: 0 }, _capturedAgent);
            }
            setStreaming(false);
            // ★ 永不自停：Stop 不暂停队列，用户手动点暂停才停
            // 保存楼层数据到 sq3
            if (_capturedQuestId) {
                try { await _saveAgentQuestData(_capturedQuestId, _capturedAgent, _capturedAgent._currentFloorNum); } catch (_) { }
            }
            _capturedAgent._stopState = 'idle';
            _capturedAgent._stopCtrl = null;
        }
        // ★ null guard：draft→quest 创建失败时两者皆 null，跳过时钟清理（零影响）
        if (_capturedAgent && _activeAgent === _capturedAgent) {
            if (_capturedAgent._activeAiDiv) {
                var _elapsed = performance.now() - _capturedAgent._floorStartPerf;
                var _totalS = Math.floor(_elapsed / 1000);
                var _min = Math.floor(_totalS / 60);
                var _sec = _totalS % 60;
                if (_capturedAgent._activeAiDiv._clockBlock) {
                    _capturedAgent._activeAiDiv._clockBlock.className = 'msg-ai-clock';
                }
                if (_capturedAgent._activeAiDiv._clockMin) {
                    _capturedAgent._activeAiDiv._clockMin.textContent = _min + 'm';
                    _capturedAgent._activeAiDiv._clockSec.textContent = ':' + (_sec < 10 ? '0' : '') + _sec + 's';
                }
                _capturedAgent._activeAiDiv._renderScheduled = false;
                _capturedAgent._activeAiDiv = null;
            }
        }
        // ═══ 楼层看门狗：仅当 onDone 和 onError 都未调用时才自动恢复 ═══
        // 铁律：绝不 reload，但必须持久化计时数据（否则重启窗口丢失 A3 时钟/饼图）
        if (_capturedAgent && !_capturedAgent._floorCompletedCleanly && _capturedAgent._stopState === 'sending' && !_capturedAgent._floorOnErrorCalled) {
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
                var _userText = (_capturedAgent._lastUserInput && _capturedAgent._lastUserInput.text) || '';
                var _diag = '';
                try { _diag = (_capturedAgent._buildDiagnosis && _capturedAgent._buildDiagnosis()) || ''; } catch (__) { }
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
            var _elapsed2 = performance.now() - _capturedAgent._floorStartPerf;
            var _tm = _capturedAgent._floorTiming || { networkMs: 0, aiMs: 0, otherMs: 0 };
            var _record = {
                floorIndex: _capturedAgent._ctx ? _capturedAgent._ctx.totalFloors : 0,
                durationMs: Math.round(_elapsed2),
                networkMs: _tm.networkMs || 0,
                aiMs: _tm.aiMs || 0,
                otherMs: _tm.otherMs || 0,
                finishedAt: new Date().toISOString()
            };
            _capturedAgent._lastFloorTimingRecord = _record;
            _capturedAgent._floorTimings = _capturedAgent._floorTimings || [];
            _capturedAgent._floorTimings.push(_record);
            // 触发一次保存（异步，best-effort）
            if (typeof saveQuestData === 'function') {
                saveQuestData().catch(function () { });
            }
        }
        if (_capturedAgent) {
            _capturedAgent._sending = false;
            _capturedAgent._streaming = false;
        }
        _queueBusy = false;
        if (_activeAgent === _capturedAgent) _sending = false;  // ★ 仅前台复位
        // ★ 队列自动排水：楼层完结后（onDone 内因 _queueBusy=true 被阻断），此处补排
        if (_queue && _queue.length > 0 && !_queuePaused && _activeAgent === _capturedAgent) {
            _triggerQueueSend();
        }
        if (_activeAgent === _capturedAgent) {
            setStreaming(false);
        } else if (_capturedQuestId && !_capturedAgent._floorCompletedCleanly && !_capturedAgent._floorOnErrorCalled) {
            // ★ 后台 agent finally 兜底：onDone/onError 均未触发时才释放 running 标记
            //   （若 onDone/onError 已触发，它们已在上方统一释放，此处不重复）
            _markQuestRunning(_capturedQuestId, false);
            if (_panelRunningQuestId === _capturedQuestId) _panelRunningQuestId = null;
        }
    }
}

function _continueQueue() {
    var _qs = document.getElementById('queue-sending-status');
    if (_qs) _qs.remove();
    if (_queuePaused) return;
    if (_activeAgent !== _capturedAgent) return;
    _triggerQueueSend();
}

// ---- textarea helpers ----
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

function insertChipAtCursor(filePath, isDir) {
    if (typeof isDir !== 'boolean') {
        isDir = !filePath.match(/\.[a-zA-Z0-9]+$/);
    }
    var icon = isDir ? '\ud83d\udcc1' : '\ud83d\udcce';
    var tag = icon + '\u201c' + filePath + '\u201d ';
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
        if (path) {
            insertChipAtCursor(path, isDir);
        }
    }
});

document.addEventListener('qqq-ai-attach', function (e) {
    if (e.detail && e.detail.path) {
        insertChipAtCursor(e.detail.path, e.detail.isDir);
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

// ═══ 崩溃防护：窗口关闭前尽力保存当前楼层/压缩状态 ═══
window.addEventListener('beforeunload', function () {
    var _ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    var _qid = (typeof questActiveId !== 'undefined') ? questActiveId : null;
    if (!_ag || !_qid) return;
    // fire-and-forget 保存（不 await，浏览器会尽力完成 IPC）
    if (typeof _saveAgentQuestData === 'function') {
        try { _saveAgentQuestData(_qid, _ag, _ag._currentFloorNum || 0).catch(function () { }); } catch (_) { }
    }
    // 压缩中 → 尽力回滚快照（不保证完成），标记异常供下次启动修复
    if (_ag._compressing && _ag._ctx) {
        _ag._uncleanShutdown = true;
        try { console.warn('[beforeunload] agent was compressing — marked unclean'); } catch (_) { }
    }
});
