var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// ============================================================
// Phase 2: Modify sendMessage body
// ============================================================

// 1. After "startFloorTimer(aiDiv);" (find it in sendMessage context)
//    Insert chat.txt path computation + A1 init + streaming start
for (var i = 2550; i < lines.length; i++) {
    if (lines[i].trim() === 'startFloorTimer(aiDiv);' && i > 2500) {
        lines.splice(i + 1, 0,
            '  // ═══ Chat.txt streaming: compute path + init A1 ═══',
            '  var _chatTxtDirLocal = (root2 || questStore.getProjectRoot()) + \'/qqq/quests/\' + (typeof qDirName2 !== \'undefined\' ? qDirName2 : \'\') + \'/\' + (typeof fDirName2 !== \'undefined\' ? fDirName2 : \'\') + \'/\';',
            '  var _chatTxtPathLocal = _chatTxtDirLocal + \'chat.txt\';',
            '  _chatTxtPath = _chatTxtPathLocal;',
            '  var _bridge = window.parent && window.parent.qqqBridge;',
            '  if (_bridge) {',
            '    try { await _bridge.fs.mkdir(_chatTxtDirLocal); } catch (_) {}',
            '  }',
            '  var _a1Block = _initA1Block(aiDiv, _chatTxtPathLocal);',
            '  aiDiv._chatTxtPath = _chatTxtPathLocal;',
            '  _startChatTxtStream(aiDiv, _chatTxtPathLocal, _capturedAgent, floorNum, text, \'\');'
        );
        break;
    }
}

// 2. After "_saveAgentQuestData" in onDone, add _finalizeChatTxt
for (var i = 2620; i < lines.length; i++) {
    if (lines[i].indexOf('await _saveAgentQuestData(_capturedQuestId, _capturedAgent, _capturedAgent._floorStartIdx)') >= 0) {
        lines.splice(i + 1, 0,
            '        // ═══ Finalize chat.txt ═══',
            '        await _finalizeChatTxt(aiDiv, aiDiv._chatTxtPath || _chatTxtPath, _capturedAgent, floorNum, timing || _capturedAgent._floorTiming);'
        );
        break;
    }
}

// 3. In onError (after "addMessageEl('error', msg);"), add _stopChatTxtStream
for (var i = 2640; i < Math.min(2660, lines.length); i++) {
    if (lines[i].indexOf("addMessageEl('error', msg)") >= 0 && lines[i].indexOf('_continueQueue') < 0) {
        lines.splice(i + 1, 0,
            '          _stopChatTxtStream();'
        );
        break;
    }
}

// 4. In finally block, add _stopChatTxtStream
for (var i = 2655; i < Math.min(2680, lines.length); i++) {
    if (lines[i].indexOf('// 确保即使 abort') >= 0) {
        lines.splice(i + 1, 0,
            '    _stopChatTxtStream();'
        );
        break;
    }
}

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('Phase 2 OK');
