'use strict';
// \u2550\u2550\u2550 panel-alltxt.js \u2550\u2550\u2550
// Rules edit, stopStream, all.txt streaming, A1 block, audit, translate

// \u2500\u2500 Rules edit button \u2500\u2500
var _rulesBtnBusy = false;
document.getElementById('rules-edit').onclick = async function () {
    if (_rulesBtnBusy) return;
    _rulesBtnBusy = true;
    try {
        var bridge = _getBridge();

        var appRoot = await bridge.app.root();
        var appRootClean = appRoot.replace(/\\/g, '/').replace(/\/$/, '');
        var globalPath = appRootClean + '/userData/global.txt';
        var globalExists = await bridge.fs.exists(globalPath);
        if (!globalExists) {
            await bridge.fs.write(globalPath, '# qqq AI Global Rules\n# Write rules here that apply to ALL projects.\n# They will be injected at the start of every new conversation.\n# Rules are only sent once (first turn) \u2014 AI remembers them from conversation history.\n');
        }
        _postToHost({ type: 'qqq-file-open', path: globalPath });

        var projRoot = questStore.getProjectRoot();
        if (projRoot) {
            var projRootClean = projRoot.replace(/\\/g, '/').replace(/\/$/, '');
            var projDir = projRootClean + '/qqq/alphal/rule';
            var projPath = projDir + '/project.txt';
            var projExists = await bridge.fs.exists(projPath);
            if (!projExists) {
                try { await bridge.fs.mkdir(projDir, { recursive: true }); } catch (_) { }
                await bridge.fs.write(projPath, '# qqq AI Project Rules\n# Write rules here that apply ONLY to this project.\n# They will be injected at the start of every new conversation.\n# Rules are only sent once (first turn) \u2014 AI remembers them from conversation history.\n');
            }
            _postToHost({ type: 'qqq-file-open-right', path: projPath });
        }

        setTimeout(function () {
            loadQqqideRules();
            if (typeof loadQqqideProjectRules === 'function') {
                loadQqqideProjectRules(projRoot);
            }
            if (typeof buildQqqideVisionContext === 'function') {
                buildQqqideVisionContext();
            }
        }, 3000);
    } catch (e) {
        console.warn('[rules] edit error:', e);
    }
    _rulesBtnBusy = false;
};

function stopStream() {
    if (!_activeAgent || _activeAgent._compressing) return;
    try { _activeAgent.abort(); } catch (_) { }
    if (_activeAgent._activeAiDiv) _activeAgent._activeAiDiv._renderScheduled = false;
    _sending = false;
    setStreaming(false);
}

// ═══ All.txt streaming (per-floor) ═══
var _allTxtPollTimer = null;
function _countRooms(houses) {
    if (!houses) return 0;
    var n = 0;
    for (var i = 0; i < houses.length; i++) {
        if (houses[i].tools) n += houses[i].tools.length;
    }
    return n;
}

var _pad2 = function (n) { return String(n).padStart(2, '0'); };
function _ts(d) {
    if (!d) d = new Date();
    return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate()) + ' ' + _pad2(d.getHours()) + ':' + _pad2(d.getMinutes()) + ':' + _pad2(d.getSeconds());
}

function _buildFloorHeaderLines(agent, floorNum, userInput, visionInput, timing) {
    var lines = [];
    var floorTs = timing && timing.floorStartServerMs ? new Date(timing.floorStartServerMs) : new Date();
    lines.push('floor.' + floorNum + '   ' + _ts(floorTs));
    lines.push('');
    var fmtK = function (bytes) { return (bytes / 1024).toFixed(3) + 'k'; };
    var askBytes = userInput ? new TextEncoder().encode(userInput).length : 0;
    var sourceBytes = visionInput ? new TextEncoder().encode(visionInput).length : 0;
    var promptBytes = 0;
    var ruleBytes = 0;
    var memoryBytes = 0;
    if (agent && agent.conversation) {
        var conv = agent.conversation;
        for (var ci = 0; ci < conv.length; ci++) {
            var cm = conv[ci];
            if (!cm || typeof cm.content !== 'string') continue;
            var cb = new TextEncoder().encode(cm.content).length;
            if (cm._persistent) {
                if (typeof SYSTEM_PROMPT !== 'undefined' && cm.content.indexOf(SYSTEM_PROMPT) === 0) {
                    promptBytes += cb;
                } else {
                    ruleBytes += cb;
                }
            } else {
                memoryBytes += cb;
            }
        }
    }
    var totalBytes = askBytes + sourceBytes + promptBytes + ruleBytes + memoryBytes;
    lines.push('(body ' + fmtK(totalBytes) + ': ask ' + fmtK(askBytes) + ' + rule ' + fmtK(ruleBytes) + ' + Source code ' + fmtK(sourceBytes) + ' + prompt ' + fmtK(promptBytes) + ' + memory ' + fmtK(memoryBytes) + ')');
    lines.push('');
    if (userInput) { lines.push(userInput); lines.push(''); }
    if (visionInput) { lines.push(visionInput); lines.push(''); }
    return lines;
}

function _buildHouseLines(h) {
    if (h._lines) return h._lines;
    var lines = [];
    var houseTs = h.ts ? new Date(h.ts) : new Date();
    lines.push('\u2550\u2550\u2550\u2550 HOUSE ' + h.index + ' \u2550\u2550\u2550\u2550 ' + _ts(houseTs) + ' [' + h.ms + 'ms] \u2550\u2550\u2550\u2550');
    if (h.reasoning) {
        lines.push('<thinking>');
        lines.push(h.reasoning);
        lines.push('</thinking>');
        lines.push('');
    }
    if (h.tools && h.tools.length > 0) {
        for (var ti = 0; ti < h.tools.length; ti++) {
            var t = h.tools[ti];
            var argsStr = (typeof t.args === 'string') ? t.args : JSON.stringify(t.args || {});
            lines.push('  \u2500\u2500 ROOM ' + h.index + '.' + (ti + 1) + '  ' + t.name + '(' + argsStr + ') \u2500\u2500');
            if (h.toolResults && h.toolResults[ti]) {
                lines.push(h.toolResults[ti]);
                lines.push('');
            }
        }
    }
    if (h.type === 'final' && h.answer) {
        lines.push('  <answer>');
        lines.push(h.answer);
        lines.push('  </answer>');
    }
    if (h.type === 'guide_ack' && h.answer) {
        lines.push('  \u26a1 \u5f15\u5bfc\u786e\u8ba4 (AI \u5df2\u6536\u5230\u8865\u5145\u4fe1\u606f):');
        lines.push('  ' + h.answer);
    }
    lines.push('');
    h._lines = lines;
    return lines;
}

function _buildFloorStatsLines(timing, floorNum, agent) {
    var lines = [];
    if (timing) {
        lines.push('\u2550\u2550\u2550\u2550 floor ' + floorNum + ' stats \u2550\u2550\u2550\u2550');
        var costStr = (agent && agent._floorCostWge !== undefined) ? '  cost: ' + (agent._floorCostWge / 10000).toFixed(4) + ' ge' : '';
        lines.push('network: ' + (timing.networkMs ? timing.networkMs.toFixed(0) : '0') + 'ms  AI: ' + (timing.deepseekMs ? timing.deepseekMs.toFixed(0) : '0') + 'ms  tool: ' + (timing.toolMs ? timing.toolMs.toFixed(0) : '0') + 'ms' + costStr);
    }
    return lines;
}

async function _appendToFile(path, text) {
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge) return false;
    try {
        var existing = '';
        try { existing = await bridge.fs.read(path); } catch (_) { }
        var updated = existing + text;
        await bridge.fs.write(path, updated);
        return true;
    } catch (e) {
        console.warn('[all-txt] append failed:', e && e.message);
        return false;
    }
}

var _ALL_TXT_MAX_MB = 4;
var _allTxtBlocked = false;
var _allTxtBlockedQoastTs = 0;

function _guardAllTxtSize(lines) {
    if (_allTxtBlocked) return false;
    var content = lines.join('\n');
    var sizeBytes = new Blob([content]).size;
    var sizeMB = sizeBytes / (1024 * 1024);
    if (sizeMB <= _ALL_TXT_MAX_MB) return true;

    _allTxtBlocked = true;
    console.error('[all-txt] BLOCKED: ' + sizeMB.toFixed(1) + 'MB exceeds ' + _ALL_TXT_MAX_MB + 'MB limit \u2014 archive paused this floor');
    var now = Date.now();
    if (now - _allTxtBlockedQoastTs > 30000) {
        _allTxtBlockedQoastTs = now;
        try {
            if (parent && parent.qqqideQoast) parent.qqqideQoast.show(
                '\u26a0\ufe0f all.txt ' + sizeMB.toFixed(1) + 'MB \u8d85\u8fc7 ' + _ALL_TXT_MAX_MB + 'MB \u4e0a\u9650\uff0c\u5f52\u6863\u5df2\u6682\u505c\uff08SQLite \u5b8c\u597d\uff09',
                { type: 'error', duration: 8000 }
            );
        } catch (_) { }
    }
    return false;
}

async function _safeWriteAllTxt(path, lines, lastMtime) {
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge) return false;
    if (!_guardAllTxtSize(lines)) return false;
    try {
        var content = lines.join('\n');
        var stat = await bridge.fs.stat(path).catch(function () { return null; });
        if (lastMtime > 0 && stat && stat.mtimeMs && Math.abs(stat.mtimeMs - lastMtime) > 100) {
            console.warn('[all-txt] externally modified, skipping write');
            return false;
        }
        await bridge.fs.write(path, content);
        return true;
    } catch (e) {
        console.warn('[all-txt] write failed:', e && e.message);
        return false;
    }
}

// \u2550\u2550\u2550 \u5ba1\u8ba1\u76ee\u6807\u8bed\u8a00\u5217\u8868 \u2550\u2550\u2550
var AUDIT_LANGS = [
    { id: 'zh', label: '\u7b80\u4f53\u4e2d\u6587' },
    { id: 'zh-tw', label: '\u7e41\u9ad4\u4e2d\u6587' },
    { id: 'en', label: 'English' },
    { id: 'ja', label: '\u65e5\u672c\u8a9e' },
    { id: 'de', label: 'Deutsch' },
    { id: 'ko', label: '\ud55c\uad6d\uc5b4' },
    { id: 'ru', label: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439' },
    { id: 'ar', label: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629' },
    { id: 'es', label: 'Espa\u00f1ol' },
    { id: 'fr', label: 'Fran\u00e7ais' },
    { id: 'pt-BR', label: 'Portugu\u00eas' },
    { id: 'hi', label: '\u0939\u093f\u0928\u094d\u0926\u0940' },
    { id: 'vi', label: 'Ti\u1ebfng Vi\u1ec7t' }
];

function _getPreferredAuditLang() {
    try {
        if (window.parent && window.parent.i18n && typeof window.parent.i18n.getLang === 'function') {
            return window.parent.i18n.getLang();
        } else if (window.i18n && typeof window.i18n.getLang === 'function') {
            return window.i18n.getLang();
        }
    } catch (_) { }
    return 'zh';
}

// \u2550\u2550\u2550 A1 \u8c46\u8150\u5757 \u2550\u2550\u2550
var A1_SP = '\u00A0';
var A1_INNER_SP = '\u2009';

function _a1Label(text) {
    var s = document.createElement('span'); s.className = 'msg-a1-label'; s.textContent = text; return s;
}
function _a1Num(text) {
    var s = document.createElement('span'); s.className = 'msg-a1-num'; s.textContent = text; return s;
}
function _a1Sp() {
    var s = document.createElement('span'); s.className = 'msg-a1-sp'; s.textContent = A1_SP; return s;
}
function _a1InnerSp() {
    var s = document.createElement('span'); s.className = 'msg-a1-sp'; s.textContent = A1_INNER_SP; return s;
}

function _initA1Block(aiDiv, allTxtPath, questId, floorNum) {
    if (aiDiv._a1Block) return aiDiv._a1Block;
    var block = document.createElement('div');
    block.className = 'msg-a1';
    block._path = allTxtPath;
    block._aiDiv = aiDiv;
    block._questId = questId || '';
    block._floorNum = floorNum || 0;
    block._auditLang = _getPreferredAuditLang();

    var r1 = document.createElement('div'); r1.className = 'msg-a1-r1';
    block._r1f = _a1Label('Floor'); block._r1fn = _a1Num('0');
    block._r1h = _a1Label('House'); block._r1hn = _a1Num('0');
    block._r1r = _a1Label('Room'); block._r1rn = _a1Num('0');
    block._r1sz = _a1Num('0');
    r1.appendChild(block._r1f); r1.appendChild(_a1InnerSp()); r1.appendChild(block._r1fn); r1.appendChild(_a1Sp());
    r1.appendChild(block._r1h); r1.appendChild(_a1InnerSp()); r1.appendChild(block._r1hn); r1.appendChild(_a1Sp());
    r1.appendChild(block._r1r); r1.appendChild(_a1InnerSp()); r1.appendChild(block._r1rn); r1.appendChild(_a1Sp()); r1.appendChild(_a1Sp());
    r1.appendChild(block._r1sz);
    block._r1 = r1;

    var r2 = document.createElement('div'); r2.className = 'msg-a1-r2';
    block._r2a = _a1Num('FILE 0');
    block._r2b = _a1Num('ROW +0 -0');
    r2.appendChild(block._r2a); r2.appendChild(_a1Sp()); r2.appendChild(block._r2b);
    block._r2 = r2;

    var r3 = document.createElement('div');
    r3.className = 'msg-a1-r3-wrap';
    r3.style.cssText = 'display:flex;align-items:stretch;gap:8px;';

    var auditBtn = document.createElement('button');
    auditBtn.className = 'msg-a1-audit-btn';
    auditBtn.textContent = '\u5ba1\u8ba1';
    auditBtn.title = '\u4ece\u6570\u636e\u5e93\u751f\u6210 chat.txt\uff08\u601d\u8003\u94fe + \u5de5\u5177\u8c03\u7528 + \u95ee\u7b54\uff09';
    auditBtn.onclick = function (e) { e.stopPropagation(); _onAuditClick(block); };

    var translateBtn = document.createElement('button');
    translateBtn.className = 'msg-a1-audit-btn';
    translateBtn.textContent = '\u7ffb\u8bd1';
    translateBtn.title = 'AI \u7ffb\u8bd1 chat.txt \u81ea\u7136\u8bed\u8a00\u90e8\u5206\u5230\u76ee\u6807\u8bed\u8a00';
    translateBtn.setAttribute('data-cd', '30000');
    translateBtn.onclick = function (e) { e.stopPropagation(); _onTranslateClick(block); };

    var langSelect = document.createElement('select');
    langSelect.className = 'msg-a1-lang-select';
    for (var li = 0; li < AUDIT_LANGS.length; li++) {
        var opt = document.createElement('option');
        opt.value = AUDIT_LANGS[li].id;
        opt.textContent = AUDIT_LANGS[li].label;
        if (AUDIT_LANGS[li].id === block._auditLang) opt.selected = true;
        langSelect.appendChild(opt);
    }
    langSelect.onclick = function (e) { e.stopPropagation(); };
    langSelect.onchange = function () { block._auditLang = langSelect.value; };

    r3.appendChild(auditBtn);
    r3.appendChild(translateBtn);
    r3.appendChild(langSelect);
    block._r3 = r3;
    block._auditBtn = auditBtn;
    block._translateBtn = translateBtn;
    block._auditSelect = langSelect;

    block.appendChild(r1);
    block.appendChild(r2);
    block.appendChild(r3);

    var clockBlock = aiDiv._clockBlock;
    if (clockBlock) {
        aiDiv.insertBefore(block, clockBlock);
    } else {
        aiDiv.appendChild(block);
    }

    block.onclick = function (e) {
        if (e.target === r3 || r3.contains(e.target)) return;
        _postToHost({ type: 'qqq-file-open-right', path: allTxtPath, readOnly: true, search: 'ROOM' });
        aiDiv._allTxtOpenInEditor = true;
    };

    aiDiv._a1Block = block;
    return block;
}

function _startAllTxtStream(aiDiv, allTxtPath, agent, floorNum, userContent, visionContent) {
    _stopAllTxtStream();
    _allTxtBlocked = false;
    var lastWriteMs = 0;
    var lastHouseCount = 0;
    var lastRoomCount = 0;

    _allTxtPollTimer = setInterval(function () {
        if (document.hidden) return;
        if (!agent._houses) return;
        var hCount = agent._houses.length;
        var rCount = _countRooms(agent._houses);

        var a1 = aiDiv._a1Block;
        if (a1 && a1._r1fn) {
            _updateA1Row1(a1, floorNum, hCount, rCount);
        }

        var now = Date.now();
        var hasNew = hCount > lastHouseCount || rCount > lastRoomCount;
        if (now - lastWriteMs > 10000 || hasNew) {
            lastWriteMs = now;
            lastHouseCount = hCount;
            lastRoomCount = rCount;

            var uiText = (userContent || '').replace(/\n/g, ' ').trim();
            var vtText = (visionContent || '').trim();
            var headerLines = _buildFloorHeaderLines(agent, floorNum, uiText, vtText, agent._floorTiming);
            var allLines = headerLines.slice();
            var houses = agent._houses;
            for (var hi = 0; hi < houses.length; hi++) {
                allLines = allLines.concat(_buildHouseLines(houses[hi]));
            }
            _safeWriteAllTxt(allTxtPath, allLines, 0).then(function (ok) {
                if (ok) {
                    _updateA1Size(a1, floorNum, hCount, rCount, allTxtPath);
                    if (aiDiv._allTxtOpenInEditor) {
                        var bridge2 = window.parent && window.parent.qqqideBridge;
                        if (bridge2) {
                            bridge2.fs.read(allTxtPath).then(function (content) {
                                _postToHost({ type: 'qqq-editor-refresh', path: allTxtPath, content: content });
                            }).catch(function () { });
                        }
                    }
                }
            }).catch(function () { });
        }
        _updateA1Row2(a1, agent);
    }, 1000);
}

function _updateA1Size(a1, floorNum, hCount, rCount, allTxtPath) {
    var b2 = window.parent && window.parent.qqqideBridge;
    if (!b2 || !a1 || !a1._r1fn) return;
    b2.fs.stat(allTxtPath).then(function (st) {
        if (st && st.size) {
            _updateA1Row1(a1, floorNum, hCount, rCount, st.size);
        }
    }).catch(function () { });
}

async function _finalizeAllTxt(aiDiv, allTxtPath, agent, floorNum, timing) {
    // ★ 先强制刷新 FILE/ROW 计数（_updateA1Row2 有 5s 节流，finalize 必须冲破）
    var a1 = aiDiv._a1Block;
    if (a1 && agent) { _updateA1Row2(a1, agent, true); }
    _stopAllTxtStream();
    if (!allTxtPath) return;
    var bridge = window.parent && window.parent.qqqideBridge;
    if (!bridge) return;
    try {
        var st = await bridge.fs.stat(allTxtPath).catch(function () { return null; });
        var a1 = aiDiv._a1Block;
        if (a1 && a1._r1fn && st && st.size) {
            var hCount = agent._houses ? agent._houses.length : 0;
            var rCount = _countRooms(agent._houses);
            _updateA1Row1(a1, floorNum, hCount, rCount, st.size);
        }
        if (aiDiv._allTxtOpenInEditor) {
            var content = await bridge.fs.read(allTxtPath).catch(function () { return ''; });
            parent.postMessage({ type: 'qqq-editor-refresh', path: allTxtPath, content: content }, '*');
        }
    } catch (e) {
        console.warn('[all-txt] finalize failed:', e && e.message);
    }
}

function _stopAllTxtStream() {
    if (_allTxtPollTimer) { clearInterval(_allTxtPollTimer); _allTxtPollTimer = null; }
}

// \u2550\u2550\u2550 A1 \u6570\u5b57\u589e\u957f\u70ab\u5f69\u52a8\u753b \u2550\u2550\u2550
function _a1AnimateNum(el, newText) {
    if (!el) return;
    if (el.textContent === newText) return;
    el.textContent = newText;
    el.classList.remove('msg-a1-num-pop');
    void el.offsetWidth;
    el.classList.add('msg-a1-num-pop');
}

function _updateA1Row1(block, floorNum, hCount, rCount, fileSize) {
    if (!block || !block._r1fn) return;
    _a1AnimateNum(block._r1fn, String(floorNum >= 0 ? floorNum : '?'));
    _a1AnimateNum(block._r1hn, String(hCount));
    _a1AnimateNum(block._r1rn, String(rCount));
    if (fileSize !== undefined && fileSize !== null && fileSize !== 0) {
        var szText = _formatSizeCompact(fileSize);
        _a1AnimateNum(block._r1sz, szText);
    }
}

var _fileStatsCache = {};
function _updateA1Row2(block, agent, force) {
    if (!block || !block._r2 || !agent) return;
    var houses = agent._houses;
    if (!houses) return;
    var now = Date.now();
    var cacheKey = block._aiDiv ? block._aiDiv._allTxtPath || 'unknown' : 'unknown';
    var cache = _fileStatsCache[cacheKey];
    if (!cache) {
        cache = { files: {}, added: 0, deleted: 0, lastTs: 0 };
        _fileStatsCache[cacheKey] = cache;
    }
    if (!force && now - cache.lastTs < 5000 && cache._seenHouses >= houses.length && houses.length > 0) return;
    cache.lastTs = now;
    cache._seenHouses = houses.length;
    var fs = _computeFileStats(houses);
    if (fs.fileCount > 0 || fs.added > 0 || fs.deleted > 0) {
        cache.files = {}; cache.added = fs.added; cache.deleted = fs.deleted;
    }
    if (block._r2a) _a1AnimateNum(block._r2a, 'FILE ' + fs.fileCount);
    if (block._r2b) _a1AnimateNum(block._r2b, '   ROW +' + fs.added + ' -' + fs.deleted);
}

// \u2550\u2550\u2550 \u8bed\u8a00\u68c0\u6d4b \u2550\u2550\u2550
function _detectLanguage(text) {
    if (!text) return 'english';
    var sample = text.slice(0, 200);
    var total = sample.length;
    if (total === 0) return 'english';
    var arabic = 0;
    for (var i = 0; i < sample.length; i++) {
        var c = sample.charCodeAt(i);
        if (c >= 0x0600 && c <= 0x06FF) arabic++;
    }
    if (arabic / total > 0.15) return 'arabic';
    var cjk = 0;
    for (var i2 = 0; i2 < sample.length; i2++) {
        var c2 = sample.charCodeAt(i2);
        if ((c2 >= 0x4E00 && c2 <= 0x9FFF) || (c2 >= 0x3400 && c2 <= 0x4DBF) ||
            (c2 >= 0xF900 && c2 <= 0xFAFF) || (c2 >= 0x3040 && c2 <= 0x309F) ||
            (c2 >= 0x30A0 && c2 <= 0x30FF) || (c2 >= 0xAC00 && c2 <= 0xD7AF)) cjk++;
    }
    if (cjk / total > 0.15) {
        var hiragana = 0, hangul = 0;
        for (var i3 = 0; i3 < sample.length; i3++) {
            var c3 = sample.charCodeAt(i3);
            if (c3 >= 0x3040 && c3 <= 0x309F) hiragana++;
            if (c3 >= 0xAC00 && c3 <= 0xD7AF) hangul++;
        }
        if (hangul > 0) return 'korean';
        if (hiragana > 0) return 'japanese';
        return 'chinese';
    }
    var cyrillic = 0;
    for (var i4 = 0; i4 < sample.length; i4++) {
        var c4 = sample.charCodeAt(i4);
        if (c4 >= 0x0400 && c4 <= 0x04FF) cyrillic++;
    }
    if (cyrillic / total > 0.15) return 'russian';
    return 'english';
}

// \u2550\u2550\u2550 \u5ba1\u8ba1 + \u7ffb\u8bd1 \u2550\u2550\u2550
var _auditBusy = false;
var _translateBusy = false;
var _auditLastLang = null;

function _generateChatTxt(floorData, questMeta, floorNum) {
    var lines = [];
    var now = new Date();
    var pad2 = function (n) { return String(n).padStart(2, '0'); };
    var ts = function (d) { return d ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) : ts(now); };

    var floorTs = now;
    var timing = null;
    if (questMeta && questMeta.floorTimings) {
        for (var ti = 0; ti < questMeta.floorTimings.length; ti++) {
            if (questMeta.floorTimings[ti].floorIndex === floorNum) {
                timing = questMeta.floorTimings[ti];
                if (timing.finishedAt) {
                    floorTs = new Date(new Date(timing.finishedAt).getTime() - (timing.durationMs || 0));
                }
                break;
            }
        }
    }
    lines.push('floor.' + floorNum + '   ' + ts(floorTs));
    lines.push('');

    var question = (floorData && floorData.question) || '';
    if (question) { lines.push(question); lines.push(''); }

    var userBytes = question ? new TextEncoder().encode(question).length : 0;
    var convBytes = 0;
    var conv = (floorData && floorData.conversation) || [];
    for (var ci = 0; ci < conv.length; ci++) {
        if (conv[ci] && typeof conv[ci].content === 'string') {
            convBytes += new TextEncoder().encode(conv[ci].content).length;
        }
    }
    lines.push('(body ' + (userBytes / 1024).toFixed(3) + 'k: ask ' + (userBytes / 1024).toFixed(3) + 'k + conv ' + (convBytes / 1024).toFixed(3) + 'k)');
    lines.push('');

    var houses = (floorData && floorData.houses) || [];
    var TRUNCATE_TOOL_RESULT = 300;
    for (var hi = 0; hi < houses.length; hi++) {
        var h = houses[hi];
        var hTs = h.ts ? new Date(h.ts) : now;
        lines.push('\u2550\u2550\u2550\u2550 HOUSE ' + h.index + ' \u2550\u2550\u2550\u2550 ' + ts(hTs) + ' [' + (h.ms || 0) + 'ms] \u2550\u2550\u2550\u2550');
        if (h.reasoning) {
            lines.push('<thinking>');
            lines.push(h.reasoning);
            lines.push('</thinking>');
            lines.push('');
        }
        if (h.tools && h.tools.length > 0) {
            for (var ti2 = 0; ti2 < h.tools.length; ti2++) {
                var t = h.tools[ti2];
                var argsStr = (typeof t.args === 'string') ? t.args : JSON.stringify(t.args || {});
                lines.push('  \u2500\u2500 ROOM ' + h.index + '.' + (ti2 + 1) + '  ' + t.name + '(' + argsStr + ') \u2500\u2500');
                if (h.toolResults && h.toolResults[ti2]) {
                    var result = String(h.toolResults[ti2]);
                    if (result.length > TRUNCATE_TOOL_RESULT) {
                        result = result.slice(0, TRUNCATE_TOOL_RESULT) + '\u2026 [' + result.length + ' chars total]';
                    }
                    lines.push(result);
                    lines.push('');
                }
            }
        }
        if (h.type === 'final' && h.answer) {
            lines.push('  <answer>');
            lines.push(h.answer);
            lines.push('  </answer>');
        }
        lines.push('');
    }

    if (timing) {
        lines.push('\u2550\u2550\u2550\u2550 floor ' + floorNum + ' stats \u2550\u2550\u2550\u2550');
        lines.push('network: ' + (timing.networkMs ? timing.networkMs.toFixed(0) : '0') + 'ms  AI: ' + (timing.deepseekMs ? timing.deepseekMs.toFixed(0) : '0') + 'ms  tool: ' + (timing.toolMs ? timing.toolMs.toFixed(0) : '0') + 'ms  cost: ' + ((floorData.costWge || 0) / 10000).toFixed(4) + ' ge');
    }

    return lines.join('\n');
}

async function _onAuditClick(block) {
    if (_auditBusy) return;
    _auditBusy = true;
    var btn = block._auditBtn;
    var origText = btn ? btn.textContent : '\u5ba1\u8ba1';
    if (btn) { btn.textContent = '\u2026'; btn.disabled = true; }

    try {
        var questId = block._questId;
        var floorNum = block._floorNum;
        if (!questId || !floorNum) { _auditBusy = false; if (btn) { btn.textContent = origText; btn.disabled = false; } return; }

        var floorData = await questStore.loadFloor(questId, floorNum);
        if (!floorData) {
            console.warn('[audit] floor data not found for ' + questId + ' floor ' + floorNum);
            _auditBusy = false; if (btn) { btn.textContent = origText; btn.disabled = false; } return;
        }
        var questMeta = await questStore.load(questId);
        var chatContent = _generateChatTxt(floorData, questMeta, floorNum);

        var chatPath = block._path.replace(/all\.txt$/, 'chat.txt');
        var bridge = window.parent && window.parent.qqqideBridge;
        if (bridge) {
            await bridge.fs.write(chatPath, chatContent);
        }

        _postToHost({ type: 'qqq-file-open-right', path: chatPath, readOnly: true });

        if (btn) { btn.textContent = '\u2713'; btn.disabled = false; }
        setTimeout(function () { if (btn) btn.textContent = '\u5ba1\u8ba1'; }, 1500);
    } catch (e) {
        console.warn('[audit] failed:', e && e.message);
        if (btn) { btn.textContent = origText; btn.disabled = false; }
    } finally {
        _auditBusy = false;
    }
}

var _translateCache = {};

async function _onTranslateClick(block) {
    if (_translateBusy) return;
    _translateBusy = true;
    var btn = block._translateBtn;
    var origText = btn ? btn.textContent : '\u7ffb\u8bd1';
    if (btn) { btn.textContent = '\u2026'; btn.disabled = true; }

    try {
        var lang = block._auditLang || 'zh';
        var chatPath = block._path.replace(/all\.txt$/, 'chat.txt');
        var translatedPath = chatPath.replace(/\.txt$/, '.' + lang + '.txt');
        var bridge = window.parent && window.parent.qqqideBridge;
        if (!bridge) { _translateBusy = false; if (btn) { btn.textContent = origText; btn.disabled = false; } return; }

        var chatContent = '';
        try { chatContent = await bridge.fs.read(chatPath); } catch (_) { }
        if (!chatContent) {
            var questId = block._questId;
            var floorNum = block._floorNum;
            if (questId && floorNum) {
                var floorData = await questStore.loadFloor(questId, floorNum);
                var questMeta = await questStore.load(questId);
                if (floorData) {
                    chatContent = _generateChatTxt(floorData, questMeta, floorNum);
                    await bridge.fs.write(chatPath, chatContent);
                }
            }
            if (!chatContent) { _translateBusy = false; if (btn) { btn.textContent = origText; btn.disabled = false; } return; }
        }

        var cache = _translateCache[chatPath];
        if (cache && cache.lang !== lang) {
            cache = null;
        }

        if (cache && cache.sourceContent === chatContent) {
            var _exists = false;
            try { var _st = await bridge.fs.stat(translatedPath); _exists = !!_st; } catch (_) { }
            if (_exists) {
                _postToHost({ type: 'qqq-file-open-right', path: translatedPath, readOnly: true });
                if (btn) { btn.textContent = '\u2713'; btn.disabled = false; }
                setTimeout(function () { if (btn) btn.textContent = '\u7ffb\u8bd1'; }, 1500);
                _translateBusy = false;
                return;
            }
        }

        var toTranslate, isIncremental;
        if (cache && cache.sourceContent && chatContent.startsWith(cache.sourceContent)) {
            var newPart = chatContent.slice(cache.sourceContent.length);
            if (newPart.trim()) {
                toTranslate = newPart;
                isIncremental = true;
            } else {
                _postToHost({ type: 'qqq-file-open-right', path: translatedPath, readOnly: true });
                if (btn) { btn.textContent = '\u2713'; btn.disabled = false; }
                setTimeout(function () { if (btn) btn.textContent = '\u7ffb\u8bd1'; }, 1500);
                _translateBusy = false;
                return;
            }
        } else {
            toTranslate = chatContent;
            isIncremental = false;
        }

        var translatedPart = await _translateViaAI(toTranslate, lang, isIncremental);

        var finalTranslated;
        if (isIncremental && cache && cache.translatedContent) {
            finalTranslated = cache.translatedContent + translatedPart;
        } else {
            finalTranslated = translatedPart;
        }

        _translateCache[chatPath] = {
            sourceContent: chatContent,
            translatedContent: finalTranslated,
            lang: lang
        };

        await bridge.fs.write(translatedPath, finalTranslated);
        _postToHost({ type: 'qqq-file-open-right', path: translatedPath, readOnly: true });

        if (btn) { btn.textContent = '\u2713'; btn.disabled = false; }
        setTimeout(function () { if (btn) btn.textContent = '\u7ffb\u8bd1'; }, 1500);
    } catch (e) {
        console.warn('[translate] failed:', e && e.message);
        if (btn) { btn.textContent = origText; btn.disabled = false; }
    } finally {
        _translateBusy = false;
    }
}

async function _translateViaAI(text, targetLang, isIncremental) {
    var langNames = {
        'zh': 'Simplified Chinese (\u7b80\u4f53\u4e2d\u6587)', 'zh-tw': 'Traditional Chinese (\u7e41\u9ad4\u4e2d\u6587)',
        'en': 'English', 'ja': 'Japanese (\u65e5\u672c\u8a9e)', 'de': 'German (Deutsch)',
        'ko': 'Korean (\ud55c\uad6d\uc5b4)', 'ru': 'Russian (\u0420\u0443\u0441\u0441\u043a\u0438\u0439)', 'ar': 'Arabic (\u0627\u0644\u0639\u0631\u0628\u064a\u0629)',
        'es': 'Spanish (Espa\u00f1ol)', 'fr': 'French (Fran\u00e7ais)',
        'pt-BR': 'Portuguese (Portugu\u00eas)', 'hi': 'Hindi (\u0939\u093f\u0928\u094d\u0926\u0940)', 'vi': 'Vietnamese (Ti\u1ebfng Vi\u1ec7t)'
    };
    var langName = langNames[targetLang] || targetLang;
    var prompt;
    if (isIncremental) {
        prompt = 'This is a CONTINUATION of a chat log. Translate ONLY the following new text to ' + langName + '.\n' +
            'CRITICAL: Preserve ALL structure markers unchanged: "\u2550\u2550\u2550\u2550 HOUSE", "floor.", "<thinking>", "</thinking>", "<answer>", "</answer>", "\u2500\u2500 ROOM".\n' +
            'Keep ALL code, file paths, JSON, numbers, and technical terms unchanged.\n' +
            'Translate ONLY the natural language content.\n' +
            'Output ONLY the translated text \u2014 no explanations.\n\n' + text;
    } else {
        prompt = 'Translate the natural language parts of this chat log to ' + langName + '.\n' +
            'CRITICAL: Preserve ALL structure markers unchanged: "\u2550\u2550\u2550\u2550 HOUSE", "floor.", "<thinking>", "</thinking>", "<answer>", "</answer>", "\u2500\u2500 ROOM".\n' +
            'Keep ALL code, file paths, JSON, numbers, and technical terms unchanged.\n' +
            'Translate ONLY the natural language content (thinking text, answers, user messages).\n' +
            'Output the COMPLETE file with original structure, only the language parts translated.\n\n' + text;
    }

    var token = getToken();
    if (!token) {
        console.warn('[translate] no token, returning original');
        return text;
    }

    var resp = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
            model: 'flash',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: Math.min(Math.ceil(text.length * 1.5) + 200, 32000),
            temperature: 0.1,
            thinking: { type: 'disabled' },
            stream: false
        })
    });

    if (!resp.ok) {
        var errBody = '';
        try { errBody = await resp.text(); } catch (_) { }
        throw new Error('Translation API returned ' + resp.status + ': ' + errBody.slice(0, 100));
    }

    var data = await resp.json();
    var content = (data && data.choices && data.choices[0] && data.choices[0].message)
        ? data.choices[0].message.content
        : null;

    if (!content || content.trim().length === 0) {
        throw new Error('Translation returned empty');
    }

    return content;
}
