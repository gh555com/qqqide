var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/agent-loop.js';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// Find the empty line after if(dynamicCtx) closing }, before var body
var insertAt = -1;
for (var i = 0; i < lines.length - 2; i++) {
    if (lines[i].trim() === '}' &&
        lines[i + 1].trim() === '' &&
        lines[i + 2].trim().startsWith('var body = {')) {
        // Check if this } closes if(dynamicCtx) by looking back
        for (var j = i - 1; j >= 0; j--) {
            if (lines[j].trim() === 'if (dynamicCtx) {') {
                insertAt = i + 1; // after the } closing if(dynamicCtx), on the blank line
                break;
            }
            if (lines[j].trim().startsWith('if ') || lines[j].trim().startsWith('var ')) break;
        }
        if (insertAt >= 0) break;
    }
}

if (insertAt < 0) { console.log('NOT FOUND'); process.exit(1); }

console.log('Insert at line', insertAt + 1);

var langBlock = [
    '',
    '        // ═══ Language detection + forced injection (MUST run regardless of dynamicCtx) ═══',
    '        // Force model to think in user language (never English)',
    '        var _langDetected = \'en\';',
    '        if (lastUserQuery) {',
    '            var _langSample = lastUserQuery.replace(/\\s/g, \'\').slice(0, 200);',
    '            var _cjkCount = 0, _arabicCount = 0, _totalChars = _langSample.length || 1;',
    '            for (var _li = 0; _li < _langSample.length; _li++) {',
    '                var _ch = _langSample.charCodeAt(_li);',
    '                if ((_ch >= 0x4E00 && _ch <= 0x9FFF) || (_ch >= 0x3400 && _ch <= 0x4DBF) || (_ch >= 0x3000 && _ch <= 0x303F) || (_ch >= 0x3040 && _ch <= 0x309F) || (_ch >= 0x30A0 && _ch <= 0x30FF) || (_ch >= 0xAC00 && _ch <= 0xD7AF)) _cjkCount++;',
    '                else if ((_ch >= 0x0600 && _ch <= 0x06FF) || (_ch >= 0x0750 && _ch <= 0x077F) || (_ch >= 0xFB50 && _ch <= 0xFDFF) || (_ch >= 0xFE70 && _ch <= 0xFEFF)) _arabicCount++;',
    '            }',
    '            if (_cjkCount / _totalChars > 0.15) {',
    '                var _hiraganaCount = 0, _hangulCount = 0;',
    '                for (var _li2 = 0; _li2 < _langSample.length; _li2++) {',
    '                    var _ch2 = _langSample.charCodeAt(_li2);',
    '                    if (_ch2 >= 0x3040 && _ch2 <= 0x309F) _hiraganaCount++;',
    '                    if (_ch2 >= 0xAC00 && _ch2 <= 0xD7AF) _hangulCount++;',
    '                }',
    '                _langDetected = _hiraganaCount > 3 ? \'ja\' : _hangulCount > 3 ? \'ko\' : \'zh\';',
    '            } else if (_arabicCount / _totalChars > 0.15) {',
    '                _langDetected = \'ar\';',
    '            }',
    '        }',
    '',
    '        var _langNames = { zh: \'Chinese (中文)\', ja: \'Japanese (日本語)\', ko: \'Korean (한국어)\', ar: \'Arabic (العربية)\' };',
    '        var _langName = _langNames[_langDetected];',
    '        if (_langName) {',
    '            var _langDirective = \'\\n\\n[CRITICAL LANGUAGE OVERRIDE: The user writes in \' + _langName + \'. You MUST think in \' + _langName + \' — ALL <thinking> blocks, reasoning, and responses MUST be in \' + _langName + \', NEVER English. This overrides all other preferences.]\';',
    '            if (apiMessages === messages) apiMessages = messages.slice();',
    '            var _lastIdx2 = apiMessages.length - 1;',
    '            if (_lastIdx2 >= 0 && apiMessages[_lastIdx2] && apiMessages[_lastIdx2].role === \'user\') {',
    '                apiMessages[_lastIdx2] = { role: \'user\', content: apiMessages[_lastIdx2].content + _langDirective };',
    '            }',
    '        }',
    ''
];

lines.splice(insertAt, 0, ...langBlock);
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('OK');
