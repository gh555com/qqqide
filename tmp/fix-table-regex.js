var fs = require('fs');
var path = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var content = fs.readFileSync(path, 'utf8');

// The broken multi-line table regex - find and replace with correct single line
var brokenStart = '  // Tables (must run before lists to avoid confusing | with list markers)';
var correctLines = [
    '  // Tables (must run before lists to avoid confusing | with list markers)',
    '    s = s.replace(/(?:\\n|^)(\\|.+\\|)\\n\\|[-:\\s|]+\\|\\n((?:\\|.+\\|\\n?)*)/g, function(_, header, rows) {'
];

var lines = content.split(/\r?\n/);
for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() === brokenStart.trim()) {
        console.log('Found at line', i, ':', lines[i].substring(0, 60));
        console.log('+0:', JSON.stringify(lines[i]));
        console.log('+1:', JSON.stringify(lines[i + 1]));
        console.log('+2:', JSON.stringify(lines[i + 2]));
        console.log('+3:', JSON.stringify(lines[i + 3]));
        console.log('+4:', JSON.stringify(lines[i + 4]));

        // Replace 5 broken lines with 2 correct lines
        lines.splice(i, 5, correctLines[0], correctLines[1]);
        console.log('Replaced.');
        break;
    }
}

fs.writeFileSync(path, lines.join('\r\n'), 'utf8');
console.log('Done');
