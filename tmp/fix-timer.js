var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// Fix: restart _chatTxtLiveTimer on each A1 click (use latest chatTxtPath)
for (var i = 0; i < lines.length; i++) {
    var marker = 'if (!_chatTxtLiveTimer)';
    if (lines[i].indexOf(marker) >= 0) {
        // Replace "if (!_chatTxtLiveTimer) {" with restart logic
        lines[i] = '    if (_chatTxtLiveTimer) { clearInterval(_chatTxtLiveTimer); _chatTxtLiveTimer = null; }';
        // Next line should be the setInterval start
        var nextLine = lines[i + 1];
        if (nextLine.indexOf('_chatTxtLiveTimer = setInterval') >= 0) {
            // Already correct - leave it
        }
        console.log('Fixed timer restart at line', i + 1);
        break;
    }
}
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('OK');
