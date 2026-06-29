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
                await bridge.fs.write(projPath, '# You may optionally add must-read files or folders below.\n# Format: rule"<path>" \u2014 <path> is an absolute file or folder path.\n# Total lines across all added items combined are preferably under ~2000.\n# Suggest adding core architecture / iron-rule docs, like:\n# rule"D:\\your\\project\\docs\\rules.txt"\n');
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
    // ★ 终极 Stop 闭环：单一入口 agent.stop() → _stopCtrl 级联中断一切 async 操作
    //   UX (按钮/A3时钟/队列/持久化) 由 panel-send.js finally 块统一处理
    if (_activeAgent) _activeAgent.stop();
}

// ═══ All.txt streaming (per-floor) ═══
var _allTxtPollTimer = null;
function _countRooms(houses) {
    if (!houses) return 0;
    var n = 0;
    for (var i = 0; i < houses.length; i++) {
        // ★ 优先使用 toolCount（从保存数据恢复），降级到 tools 数组（实时流式数据）
        if (typeof houses[i].toolCount === 'number') n += houses[i].toolCount;
        else if (houses[i].tools) n += houses[i].tools.length;
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

// ★ 统一 house 格式化：all.txt（全量）和 reasoning.txt（截断300字）共用同一逻辑
//   maxToolResultLen: 0=不截断, >0=截断到该字符数
function _buildHouseLines(h, maxToolResultLen) {
    if (h._lines && !maxToolResultLen) return h._lines;
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
                var result = String(h.toolResults[ti]);
                if (maxToolResultLen && result.length > maxToolResultLen) {
                    result = result.slice(0, maxToolResultLen) + '\u2026 [' + result.length + ' chars total]';
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
    if (h.type === 'guide_ack' && h.answer) {
        lines.push('  \u26a1 \u5f15\u5bfc\u786e\u8ba4 (AI \u5df2\u6536\u5230\u8865\u5145\u4fe1\u606f):');
        lines.push('  ' + h.answer);
    }
    lines.push('');
    if (!maxToolResultLen) h._lines = lines;
    return lines;
}

function _buildFloorStatsLines(timing, floorNum, agent) {
    var lines = [];
    if (timing) {
        lines.push('\u2550\u2550\u2550\u2550 floor ' + floorNum + ' stats \u2550\u2550\u2550\u2550');
        var costStr = (agent && agent._floorCostWge !== undefined) ? '  cost: ' + (agent._floorCostWge / 10000).toFixed(4) + ' ge' : '';
        lines.push('network: ' + (timing.networkMs ? timing.networkMs.toFixed(0) : '0') + 'ms  AI: ' + (timing.aiMs ? timing.aiMs.toFixed(0) : '0') + 'ms  tool: ' + (timing.otherMs ? timing.otherMs.toFixed(0) : '0') + 'ms' + costStr);
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
    r2.style.display = 'none';  // 默认隐藏，有文件变更时才显示
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
    auditBtn.title = '\u7b49\u540c\u4e8e\u5f53\u524d\u78c1\u76d8\u6ef4 all.txt \uff0c\u53ea\u662f\u5de5\u5177\u8c03\u7528\u6ef4\u8fd4\u56de\u4f1a\u88ab\u622a\u65ad\uff0c\u65b9\u4fbf\u67e5\u770b AI \u63a8\u7406\uff0c\u5982\u679c\u78c1\u76d8\u4e0a\u6ef4 all.txt \u4e22\u5931\u6216\u88ab\u7834\u574f\uff0c\u5ba1\u8ba1\u6587\u672c reasoning.txt \u4f1a\u7b49\u540c\u6ef4\u4e22\u5931\u6216\u7834\u574f';
    var translateBtn = document.createElement('button');
    translateBtn.className = 'msg-a1-audit-btn';
    translateBtn.textContent = '\u7ffb\u8bd1';
    translateBtn.title = 'AI \u7ffb\u8bd1 reasoning.txt \u81ea\u7136\u8bed\u8a00\u90e8\u5206\u5230\u76ee\u6807\u8bed\u8a00';
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
        // ★ 固定 5 秒间隔写盘（统一节奏，简单可维护）
        if (now - lastWriteMs > 5000) {
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
            // ★ 扫描 conversation 中未入 houses 的特殊消息（guide、DYNAMIC CONTEXT）
            var conv = agent.conversation;
            if (conv && conv.length) {
                var _sysAdded = false;
                for (var ci = 0; ci < conv.length; ci++) {
                    var cm = conv[ci];
                    if (!cm || !cm.content) continue;
                    var isDynamicCtx = cm._dynamic && cm.role === 'system';
                    var isGuide = cm.role === 'user' && cm.content.indexOf('[Guide]') === 0;
                    if (isDynamicCtx || isGuide) {
                        if (!_sysAdded) { allLines.push(''); allLines.push('\u2550\u2550\u2550 SYSTEM INJECTIONS \u2550\u2550\u2550'); _sysAdded = true; }
                        var label = isDynamicCtx ? '\u{1F4E6} DYNAMIC CONTEXT' : '\u{1F4AC} GUIDE';
                        allLines.push(label + ' (floor ' + (cm._floor || '?') + '):');
                        allLines.push(cm.content);
                        allLines.push('');
                    }
                }
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
    // ★ animationend 自动清理：摘掉 class 释放 will-change GPU 合成层
    //    用代数 gen 防竞态：新动画触发后旧回调不再误删 class
    var gen = (el._a1Gen || 0) + 1;
    el._a1Gen = gen;
    el.addEventListener('animationend', function () {
        if (el._a1Gen === gen) el.classList.remove('msg-a1-num-pop');
    }, { once: true });
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
    var fs = _computeFileStats(houses, agent._a4Snapshots);
    var hasChanges = fs.fileCount > 0 || fs.added > 0 || fs.deleted > 0;
    if (hasChanges) {
        cache.files = {}; cache.added = fs.added; cache.deleted = fs.deleted;
    }
    if (block._r2) {
        block._r2.style.display = hasChanges ? '' : 'none';
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

function _generateReasoningTxt(floorData, questMeta, floorNum) {
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
    for (var hi = 0; hi < houses.length; hi++) {
        var houseLines = _buildHouseLines(houses[hi], 300);
        for (var hli = 0; hli < houseLines.length; hli++) {
            lines.push(houseLines[hli]);
        }
    }

    if (timing) {
        lines.push('\u2550\u2550\u2550\u2550 floor ' + floorNum + ' stats \u2550\u2550\u2550\u2550');
        lines.push('network: ' + (timing.networkMs ? timing.networkMs.toFixed(0) : '0') + 'ms  AI: ' + (timing.aiMs ? timing.aiMs.toFixed(0) : '0') + 'ms  tool: ' + (timing.otherMs ? timing.otherMs.toFixed(0) : '0') + 'ms  cost: ' + ((floorData.costWge || 0) / 10000).toFixed(4) + ' ge');
    }

    return lines.join('\n');
}

// ★ 从 all.txt 截断工具结果生成 reasoning.txt（主路径用）
//   all.txt 格式中，工具结果在 "  ── ROOM X.Y  func(args) ──" 和下一个 ROOM/HOUSE 头之间
function _truncateAllTxtToolResults(text, maxLen) {
    var lines = text.split('\n');
    var out = [];
    var inTool = false;
    var toolChars = 0;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        // 下一节开始（ROOM 头 / HOUSE 头 / <answer> / floor stats / az> / 空行后的下一块）
        var isHeader = /^  \u2500\u2500 ROOM \d+\.\d+  /.test(line) || /^\u2550\u2550\u2550\u2550 HOUSE/.test(line) || /^  <answer>/.test(line) || /^\u2550\u2550\u2550\u2550 floor/.test(line) || /^az> /.test(line);
        if (isHeader) inTool = false;
        // 新的工具结果区开始
        if (/^  \u2500\u2500 ROOM \d+\.\d+  /.test(line)) {
            inTool = true;
            toolChars = 0;
        }
        if (inTool && !/^  \u2500\u2500 ROOM \d+\.\d+  /.test(line)) {
            if (toolChars >= maxLen) continue;  // 已超限，跳过
            if (toolChars + line.length > maxLen) {
                line = line.slice(0, maxLen - toolChars) + '\u2026';
            }
            toolChars += line.length + 1;  // +1 for \n
        }
        out.push(line);
    }
    return out.join('\n');
}

// ═══ 审计按钮 — 一键复制偏差审计文本到剪贴板 ═══
//   粘贴到任意免费 AI 对话框即可获得偏差分析表
//   4 块数据结构见 do/偏差比 §2-5
async function _onAuditClick(block) {
    if (_auditBusy) return;
    _auditBusy = true;
    var btn = block._auditBtn;
    var origText = btn ? btn.textContent : '\u5ba1\u8ba1';
    if (btn) { btn.textContent = '\u2026'; btn.disabled = true; }

    try {
        var questId = block._questId;
        var floorNum = block._floorNum;
        var bridge = window.parent && window.parent.qqqideBridge;
        if (!bridge || !questId) { _auditBusy = false; if (btn) { btn.textContent = origText; btn.disabled = false; } return; }

        // ★ 获取 agent（共享池中的 live 数据）
        var agent = parent.__qqq_agentPool && parent.__qqq_agentPool[questId];

        // ★ 加载全部楼层（用于 Block 3 chart）
        var allFloors = [];
        try { allFloors = await questStore.loadAllFloors(questId) || []; } catch (_) {}

        // ═══ 拼接审计文本 ═══
        var parts = [];

        // ── Block 1: Rules (msg[0]，不含服务端甲壳) ──
        parts.push('/** BLOCK 1: RULES — msg[0] 规则铁律块（不含服务端甲壳） **/');
        if (agent && agent.conversation && agent.conversation[0] && agent.conversation[0]._persistent) {
            parts.push(agent.conversation[0].content);
        }
        parts.push('');

        // ── Block 2: Facts（压缩上下文事实）─
        parts.push('/** BLOCK 2: FACTS — 压缩上下文提取的关键事实 **/');
        var facts = (agent && agent._ctx && agent._ctx.facts) || [];
        if (facts.length) {
            for (var fi = 0; fi < facts.length; fi++) {
                var f = facts[fi];
                parts.push('- [' + (f.type || '') + '] ' + (f.content || ''));
            }
        } else {
            parts.push('(无压缩事实)');
        }
        parts.push('');

        // ── Block 3: Chart（所有楼层的 Q&A 摘要）─
        parts.push('/** BLOCK 3: CHART — 全部 ' + allFloors.length + ' 层楼的用户问题 + AI 最终回答 **/');
        for (var fli = 0; fli < allFloors.length; fli++) {
            var fEntry = allFloors[fli];
            var fData = fEntry.data;
            if (!fData) continue;
            var fn = fEntry.floorNum;
            var qClean = (fData.question_clean || fData.question || '');
            // 找该层最后一次 AI 回答
            var lastAi = '';
            var conv = fData.conversation || [];
            for (var ci = conv.length - 1; ci >= 0; ci--) {
                if (conv[ci].role === 'assistant' && conv[ci].content) {
                    lastAi = conv[ci].content;
                    break;
                }
            }
            var marker = (fn === floorNum) ? ' ← 当前审计楼层' : '';
            parts.push('--- Floor ' + fn + marker + ' ---');
            parts.push('Q: ' + qClean.slice(0, 600));
            parts.push('A: ' + lastAi.slice(0, 1000));
            parts.push('');
        }

        // ── Block 4: Current（当前楼层的 house 级详情，每项 ≤4KB）─
        parts.push('/** BLOCK 4: CURRENT — 楼层 ' + floorNum + ' 逐 house 详情 **/');
        var houses = [];
        var isLiveFloor = agent && agent._currentFloorNum === floorNum && agent._houses && agent._houses.length > 0;
        if (isLiveFloor) {
            houses = agent._houses;
        } else {
            // 历史楼层：从 all.json 读
            try {
                var _fDat = await questStore.loadFloor(questId, floorNum);
                if (_fDat && _fDat.houses) houses = _fDat.houses;
            } catch (_) {}
        }
        for (var hi = 0; hi < houses.length; hi++) {
            var h = houses[hi];
            parts.push('---- HOUSE ' + (h.index || (hi + 1)) + ' [' + (h.type || 'tools') + '] ----');
            if (h.reasoning) {
                var rsn = String(h.reasoning).slice(0, 4096);
                if (String(h.reasoning).length > 4096) rsn += '\n\u2026 [截断，原始 ' + String(h.reasoning).length + ' chars]';
                parts.push('<thinking>');
                parts.push(rsn);
                parts.push('</thinking>');
            }
            if (h.tools && h.tools.length) {
                for (var ti = 0; ti < h.tools.length; ti++) {
                    var t = h.tools[ti];
                    var argsStr = (typeof t.args === 'string') ? t.args : JSON.stringify(t.args || {});
                    parts.push('  ROOM ' + (h.index || (hi + 1)) + '.' + (ti + 1) + '  ' + t.name + '(' + argsStr.slice(0, 600) + ')');
                    if (h.toolResults && h.toolResults[ti]) {
                        var res = String(h.toolResults[ti]).slice(0, 4096);
                        if (String(h.toolResults[ti]).length > 4096) res += '\n\u2026 [截断，原始 ' + String(h.toolResults[ti]).length + ' chars]';
                        parts.push(res);
                    }
                }
            }
            if (h.type === 'final' && h.answer) {
                parts.push('  <answer>');
                parts.push(String(h.answer).slice(0, 4096));
                parts.push('  </answer>');
            }
            parts.push('');
        }

        // ── 审计指令（粘贴给外部 AI 的 prompt）─
        parts.push('═══════════════════════════════════════');
        parts.push('═══ 审计指令 — 粘贴给任意 AI 即可 ═══');
        parts.push('═══════════════════════════════════════');
        parts.push('');
        parts.push('你是代码审计专家。上面 4 个 BLOCK 是一个 AI 智能体在开发过程中的完整上下文：');
        parts.push('  BLOCK 1 = 发给 AI 的系统规则（不含服务端机密）');
        parts.push('  BLOCK 2 = 压缩上下文提取的关键事实');
        parts.push('  BLOCK 3 = 所有历史楼层的用户问题 + AI 回答摘要');
        parts.push('  BLOCK 4 = 当前楼层（' + floorNum + '）的逐 house 推理和工具调用');
        parts.push('');
        parts.push('**你的任务：** 对 BLOCK 4 的每一段 <thinking> 和每一行 ROOM 做偏差审计，生成一个 Markdown 表格。');
        parts.push('');
        parts.push('表格 6 列：| # | H | R | 消息摘要(≤25字) | 评分 | 备注 |');
        parts.push('');
        parts.push('评分标准（三者选一）：');
        parts.push('  ✓ 绿 — 推理方向正确，工具选择合理，步骤高效推进目标');
        parts.push('  ◉ 黄 — 绕路但未出错（读不存在的文件/搜不到关键词后不换策略/深挖非核心细节/比最优路径多走了一步）');
        parts.push('  ✗ 红 — 明显判断错误（工具假阴性后反复同质查询不 pivot/无视已有信息/方向性错误/理解偏差导致无效工作）。备注必须详细说明错在哪、正确做法是什么。');
        parts.push('');
        parts.push('最后计算 **偏差比** = (黄×1 + 红×2) ÷ (可评分消息数×2) × 100%。');
        parts.push('  可评分 = AI 的 thinking 段 + AI 发起的 tool_calls。');
        parts.push('  工具返回值本身不评分。系统消息不评分。');
        parts.push('');
        parts.push('输出格式（零废话，纯 Markdown）：');
        parts.push('1. 先输出 ## 偏差审计表');
        parts.push('2. 再输出表格');
        parts.push('3. 最后输出 **偏差比: X.X%** + 五档定性');
        parts.push('   五档: 优秀(<10%) / 值得注意(10-25%) / 存在偏差(25-50%) / 严重偏差(50-75%) / 灾难(>75%)');
        parts.push('4. 偏差比>0% 时简要定性最大问题');

        var auditText = parts.join('\n');

        // ★ 复制到剪贴板
        var copied = false;
        try {
            await navigator.clipboard.writeText(auditText);
            copied = true;
        } catch (_) {
            try {
                var ta = document.createElement('textarea');
                ta.value = auditText;
                ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                copied = true;
            } catch (_2) {}
        }

        if (copied) {
            if (btn) { btn.textContent = '\u2713'; btn.disabled = false; }
            // qoast 通知
            var kb = (auditText.length / 1024).toFixed(0);
            try {
                if (window.parent && window.parent.qqqideQoast) {
                    window.parent.qqqideQoast.show('\u5ba1\u8ba1\u6587\u672c\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f (' + kb + ' KB)\uff0c\u53ef\u7c98\u8d34\u5230\u4efb\u610f AI \u5bf9\u8bdd\u6846\u3002', { duration: 5000, type: 'success' });
                }
            } catch (_) {}
            setTimeout(function () { if (btn) btn.textContent = '\u5ba1\u8ba1'; }, 2000);
        } else {
            if (btn) { btn.textContent = origText; btn.disabled = false; }
            console.warn('[audit] clipboard write failed');
        }
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
        var reasoningPath = block._path.replace(/all\.txt$/, 'reasoning.txt');
        var translatedPath = reasoningPath.replace(/\.txt$/, '.' + lang + '.txt');
        var bridge = window.parent && window.parent.qqqideBridge;
        if (!bridge) { _translateBusy = false; if (btn) { btn.textContent = origText; btn.disabled = false; } return; }

        var reasoningContent = '';
        try { reasoningContent = await bridge.fs.read(reasoningPath); } catch (_) { }
        if (!reasoningContent) {
            var questId = block._questId;
            var floorNum = block._floorNum;
            if (questId && floorNum) {
                var floorData = await questStore.loadFloor(questId, floorNum);
                var questMeta = await questStore.load(questId);
                if (floorData) {
                    reasoningContent = _generateReasoningTxt(floorData, questMeta, floorNum);
                    await bridge.fs.write(reasoningPath, reasoningContent);
                }
            }
            if (!reasoningContent) { _translateBusy = false; if (btn) { btn.textContent = origText; btn.disabled = false; } return; }
        }
        var cache = _translateCache[reasoningPath];
        if (cache && cache.lang !== lang) {
            cache = null;
        }
        if (cache && cache.sourceContent === reasoningContent) {
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
        if (cache && cache.sourceContent && reasoningContent.startsWith(cache.sourceContent)) {
            var newPart = reasoningContent.slice(cache.sourceContent.length);
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
            toTranslate = reasoningContent;
            isIncremental = false;
        }

        var translatedPart = await _translateViaAI(toTranslate, lang, isIncremental);

        var finalTranslated;
        if (isIncremental && cache && cache.translatedContent) {
            finalTranslated = cache.translatedContent + translatedPart;
        } else {
            finalTranslated = translatedPart;
        }
        _translateCache[reasoningPath] = {
            sourceContent: reasoningContent,
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
        prompt = 'This is a CONTINUATION of a reasoning log. Translate ONLY the following new text to ' + langName + '.\n' +
            'CRITICAL: Preserve ALL structure markers unchanged: "\u2550\u2550\u2550\u2550 HOUSE", "floor.", "<thinking>", "</thinking>", "<answer>", "</answer>", "\u2500\u2500 ROOM".\n' +
            'Keep ALL code, file paths, JSON, numbers, and technical terms unchanged.\n' +
            'Translate ONLY the natural language content.\n' +
            'Output ONLY the translated text \u2014 no explanations.\n\n' + text;
    } else {
        prompt = 'Translate the natural language parts of this reasoning log to ' + langName + '.\n' +
            'CRITICAL: Preserve ALL structure markers unchanged: "\u2550\u2550\u2550\u2550 HOUSE", "floor.", "<thinking>", "</thinking>", "<answer>", "</answer>", "\u2500\u2500 ROOM".\n' +
            'Keep ALL code, file paths, JSON, numbers, and technical terms unchanged.\n' +
            'Translate ONLY the natural language content (thinking text, answers, user messages).\n' +
            'Output the COMPLETE file with original structure, only the language parts translated.\n\n' + text;
    }

    var token = (typeof getLoginToken === 'function') ? getLoginToken() : '';
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
            stream: false,
            floor_id: (typeof _capturedAgent !== 'undefined' && _capturedAgent._floorId) || ''
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
