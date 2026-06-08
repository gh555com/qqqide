'use strict';
// \u2550\u2550\u2550 panel-send.js \u2550\u2550\u2550
// sendMessage, input helpers, event handlers, window exports

async function sendMessage() {
    if (_sending) return;
    if (!_hasMainProject()) { _triggerSelectMainProject(); return; }
    _checkTokenReset();
    _sending = true;
    var _guideStatuses = document.querySelectorAll('.guide-status');
    for (var _gsi = 0; _gsi < _guideStatuses.length; _gsi++) { _guideStatuses[_gsi].remove(); }
    // \u2550\u2550\u2550 \u6240\u6709\u6743\u5b88\u536b \u2550\u2550\u2550
    // ── 快照 quest 上下文（所有 await 之前，防并发切 quest 错位）──
    _capturedQuestId = questActiveId;
    _capturedAgent = _activeAgent;
    if (_capturedQuestId) {
        try {
            var _owner = await questStore.getOwner(_capturedQuestId);
            if (_owner && _owner.windowId !== _windowId) {
                _setPanelFocus(false);
                _broadcast('focus-request', _capturedQuestId, { targetWindow: _owner.windowId });
                _sending = false;
                updateQueueBtn();
                return;
            }
            if (!_owner) {
                await questStore.claimOwner(_capturedQuestId, _windowId);
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
        addMessageEl('error', '\u8bf7\u5148\u5728\u9876\u90e8\u8f93\u5165 Token \u5e76\u70b9\u51fb Save');
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

    var images = pendingImages.length > 0 ? pendingImages.map(function (img) { return { id: img.id, base64: img.base64 }; }) : null;

    saveQuestUIState(_capturedQuestId);
    $input.value = '';
    $input._resetUndo();
    pendingImages = [];
    renderImageStrip();
    $input.focus();

    // \u82e5\u5c1a\u65e0 active quest\uff0c\u521b\u5efa\u5e76\u547d\u540d
    if (_isDraft(_capturedQuestId)) {
        var qId = await questStore.create('');
        if (!qId) { _sending = false; updateQueueBtn(); return; }
        questActiveId = qId;
        _activeAgent = _getOrCreateAgent(questActiveId);
        if (_panelId === 1) await questStore.setActiveId(questActiveId);
        if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
            onlyStore.set('ai.window.' + _windowId + '.activeQuestId', questActiveId);
        }
        await questStore.claimOwner(questActiveId, _windowId);
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
        renderTabs();
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
    }
    var floorNum = await questStore.nextFloorNum(_capturedQuestId);
    var root2 = questStore.getProjectRoot();
    if (root2 && floorNum > 0) {
        var userQuestion = text || (userContent || '').split('\n')[0];
        var quests2 = await questStore.list();
        var qEntry = quests2.find(function (qx) { return qx.id === _capturedQuestId; });
        var qTitle2 = (qEntry && qEntry.title && qEntry.title !== 'New Chat') ? qEntry.title : _capturedQuestId;
        var qDirName2 = _makeName("q", qEntry && qEntry.numericId ? qEntry.numericId : 0, qTitle2);
        var fDirName2 = _makeName('f', floorNum, userQuestion);
        await _ensureQuestDir(root2, qDirName2, fDirName2);
    }
    agent._ctx.totalFloors = floorNum - 1;
    var _floorStartIdx = agent.conversation.length;
    agent._floorStartIdx = _floorStartIdx;

    // ---- Agentic loop ----
    setStreaming(true);
    var _projectRoot = root2 || questStore.getProjectRoot();
    var _allTxtDirLocal = '';
    if (_projectRoot) {
        _allTxtDirLocal = _projectRoot + '/qqq/quests/' + (typeof qDirName2 !== 'undefined' ? qDirName2 : '') + '/' + (typeof fDirName2 !== 'undefined' ? fDirName2 : '') + '/';
    }
    var _allTxtPathLocal = _allTxtDirLocal ? _allTxtDirLocal + 'all.txt' : '';
    agent._allTxtPath = _allTxtPathLocal;
    var _bridge = window.parent && window.parent.qqqideBridge;
    if (_bridge && _allTxtDirLocal) {
        try { await _bridge.fs.mkdir(_allTxtDirLocal); } catch (_) { }
    }
    var aiDiv = cardPool.startBuildingFloor(_capturedQuestId, floorNum, _allTxtPathLocal);
    if (!aiDiv) { _sending = false; updateQueueBtn(); return; }
    aiDiv._allTxtPath = _allTxtPathLocal;
    // ★ 新楼层开始，清空 agent._houses 防止 _updateA1Row2 读到上一楼层残影
    _capturedAgent._houses = [];
    startFloorTimer(aiDiv, _capturedAgent);
    _startAllTxtStream(aiDiv, _allTxtPathLocal, _capturedAgent, floorNum, text, '');
    _startAutoSave();
    scrollToBottom(true);
    try {
        await agent.send(userContent, {
            images: images,
            token: token,
            tier: selectedTier ? TIER_LIST[selectedTier] : null,
            onToken: function (chunk) {
                var _targetDiv = (aiDiv && aiDiv.isConnected) ? aiDiv : (_capturedAgent._activeAiDiv || aiDiv);
                if (!_targetDiv) return;
                _targetDiv._buf = (_targetDiv._buf || '') + chunk;
                _targetDiv._fullText = (_targetDiv._fullText || '') + chunk;
                var parts = _targetDiv._buf.split('\n\n');
                _targetDiv._paras = _targetDiv._paras || [];
                for (var pi = 0; pi < parts.length - 1; pi++) {
                    if (parts[pi].trim()) _targetDiv._paras.push(parts[pi]);
                }
                _targetDiv._buf = parts[parts.length - 1];
                _targetDiv._dirty = true;
                if (!_targetDiv._renderScheduled) {
                    _targetDiv._renderScheduled = true;
                    setTimeout(doStreamRender, 1000);
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
                    var _rm = [];
                    var _kids = _targetDiv2._contentWrap.children;
                    for (var _gi = _kids.length - 1; _gi >= 0; _gi--) {
                        var _gc = _kids[_gi];
                        if (_gc.classList && (_gc.classList.contains('stream-para') ||
                            (_gc.classList.contains('msg-status') && !_gc.classList.contains('guide-marker')))) {
                            _rm.push(_gc);
                        }
                    }
                    if (_targetDiv2._lastParaEl && _targetDiv2._lastParaEl.parentNode) {
                        _rm.push(_targetDiv2._lastParaEl);
                    }
                    for (var _rj = 0; _rj < _rm.length; _rj++) { _rm[_rj].remove(); }
                    _targetDiv2._lastParaEl = null;
                    _targetDiv2._guideMode = false;
                    var _finalDiv = document.createElement('div');
                    _finalDiv.innerHTML = renderMarkdown(content);
                    _targetDiv2._contentWrap.appendChild(_finalDiv);
                }
                if (aiDiv) {
                    aiDiv._paras = null;
                    aiDiv._buf = null;
                    aiDiv._fullText = null;
                    aiDiv._lastParaEl = null;
                    aiDiv._renderedCount = 0;
                    aiDiv._dirty = false;
                }

                var _divDetached = !(aiDiv && aiDiv.isConnected);

                if (_activeAgent === _capturedAgent) {
                    stopFloorTimer(timing || { networkMs: 0, deepseekMs: 0, toolMs: 0 }, _capturedAgent);
                    scrollToBottom();
                } else {
                    var _elapsed = performance.now() - _capturedAgent._floorStartPerf;
                    _capturedAgent._floorTimings = _capturedAgent._floorTimings || [];
                    var _bgRecord = {
                        floorIndex: _capturedAgent._ctx.totalFloors,
                        durationMs: Math.round(_elapsed),
                        networkMs: (timing && timing.networkMs) || 0,
                        deepseekMs: (timing && timing.deepseekMs) || 0,
                        toolMs: (timing && timing.toolMs) || 0,
                        finishedAt: new Date().toISOString()
                    };
                    _capturedAgent._floorTimings.push(_bgRecord);
                    _capturedAgent._lastFloorTimingRecord = _bgRecord;
                }

                await _saveAgentQuestData(_capturedQuestId, _capturedAgent, _capturedAgent._floorStartIdx);

                if (cardPool) cardPool.completeBuildingFloor(_capturedQuestId, floorNum);

                if (_activeAgent === _capturedAgent && _divDetached) {
                    console.warn('[onDone] div detached but card pool not available, skipping rebuild');
                }

                var _ftxtPath = (_targetDiv2 && _targetDiv2._allTxtPath) || _capturedAgent._allTxtPath || '';
                await _finalizeAllTxt(_targetDiv2 || aiDiv, _ftxtPath, _capturedAgent, floorNum, timing);
                if (_activeAgent === _capturedAgent) {
                    updateCtxBtn();
                    if (!_queuePaused) {
                        _triggerQueueSend();
                    } else {
                        renderQueueStrip();
                    }
                }
            },

            onGuideAckDone: function () {
                if (_activeAgent._activeAiDiv) _activeAgent._activeAiDiv._guideMode = false;
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
                        var _floorGe = (_capturedAgent._floorCostWge / 10000).toFixed(4);
                        _targetDiv3._clockCost.textContent = _floorGe + ' ge' + (isFree ? ' Free' : '');
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
                _stopAutoSave();
                if (_activeAgent === _capturedAgent) {
                    if (aiDiv && aiDiv._floorCompleted) {
                        setStreaming(false);
                        return;
                    }
                    var _errDiv = addMessageEl('error', msg);
                    if (msg.indexOf('\u5237\u65b0') >= 0) {
                        var _actRow = document.createElement('div');
                        _actRow.style.cssText = 'margin-top:8px;display:flex;gap:8px;';
                        var _refreshBtn = document.createElement('button');
                        _refreshBtn.textContent = '\ud83d\udd04 \u5237\u65b0\u9762\u677f';
                        _refreshBtn.style.cssText = 'padding:4px 14px;font-size:12px;border:1px solid var(--border-color);border-radius:4px;background:var(--card-bg);color:var(--text-primary);cursor:pointer;';
                        _refreshBtn.onclick = function () { window.location.reload(); };
                        var _dismissBtn = document.createElement('button');
                        _dismissBtn.textContent = '\u6211\u77e5\u9053\u4e86';
                        _dismissBtn.style.cssText = 'padding:4px 14px;font-size:12px;border:1px solid var(--border-color);border-radius:4px;background:var(--card-bg);color:var(--text-primary);cursor:pointer;';
                        _dismissBtn.onclick = function () { _actRow.remove(); };
                        _actRow.appendChild(_refreshBtn);
                        _actRow.appendChild(_dismissBtn);
                        _errDiv.appendChild(_actRow);
                    }
                    _stopAllTxtStream();
                    stopFloorTimer(null, _capturedAgent);
                    setStreaming(false);
                    _continueQueue();
                }
            }
        });
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            addMessageEl('error', err.message || 'Unknown error');
            _continueQueue();
        }
    } finally {
        _stopAutoSave();
        _stopAllTxtStream();
        if (_activeAgent === _capturedAgent) {
            if (_capturedAgent._floorTimerId) { clearInterval(_capturedAgent._floorTimerId); _capturedAgent._floorTimerId = null; }
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
        _capturedAgent._sending = false;
        _capturedAgent._streaming = false;
        _queueBusy = false;
        if (_activeAgent === _capturedAgent) {
            setStreaming(false);
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

function insertChipAtCursor(filePath) {
    var isDir = !filePath.match(/\.[a-zA-Z0-9]+$/);
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
        if (path) {
            insertChipAtCursor(path);
        }
    }
});

document.addEventListener('qqq-ai-attach', function (e) {
    if (e.detail && e.detail.path) {
        insertChipAtCursor(e.detail.path);
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
        $messages.scrollBy({ top: -$messages.clientHeight * 0.35, behavior: 'smooth' });
        _showFloorIndicatorBriefly();
    } else if (key === '2') {
        e.preventDefault();
        $messages.scrollBy({ top: $messages.clientHeight * 0.35, behavior: 'smooth' });
        _showFloorIndicatorBriefly();
    } else if (key === 'q' || key === 'w') {
        e.preventDefault();
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
window._initTreasureBlock = _initTreasureBlock;
window._renderTreasures = _renderTreasures;
window._initA1Block = _initA1Block;
window._initClockBlock = _initClockBlock;
window.renderMarkdown = renderMarkdown;
window.getUserDisplayContent = getUserDisplayContent;
window._countRooms = _countRooms;
window._updateA1Row1 = _updateA1Row1;
window.drawPie = drawPie;
window._showPieTooltip = _showPieTooltip;
window._hidePieTooltip = _hidePieTooltip;
