var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
// Find and delete line with "?)*)/g, function (_, header, rows) {"
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('?)*)/g, function (_, header, rows) {') >= 0) {
        // Verify previous line has the complete correct regex
        if (lines[i - 1] && lines[i - 1].indexOf('s = s.replace(/(?:\n|^)') >= 0) {
            console.log('Removing duplicate at line', i);
            lines.splice(i, 1);
            break;
        }
    }
}
fs.writeFileSync(p, lines.join('\r\n'), 'utf8');
console.log('Done');
