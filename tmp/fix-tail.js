var fs = require('fs');
var path = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var content = fs.readFileSync(path, 'utf8');

// Remove duplicate tail from table regex
var badPattern = '?)*)/g, function (_, header, rows) {';
var idx = content.indexOf(badPattern);
if (idx >= 0) {
    // Check if the line before has the correct regex already
    var before = content.substring(Math.max(0, idx - 200), idx);
    if (before.indexOf('s = s.replace(/(?:\n|^)(\\|.+\\|)\n') >= 0) {
        // Remove the duplicate tail (including the newline before it)
        content = content.replace(/\r?\n\?\)\*\)\/g, function \(_, header, rows\) \{/, '');
        console.log('Fixed duplicate tail');
    }
}

fs.writeFileSync(path, content, 'utf8');
console.log('Done');
