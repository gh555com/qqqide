var fs = require('fs');
var path = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var content = fs.readFileSync(path, 'utf8');

var lines = content.split('\r\n');
console.log('Total lines:', lines.length);

// Find the broken regex lines
for (var i = 0; i < lines.length; i++) {
    if (lines[i] && lines[i].indexOf('Tables (must run before lists') >= 0) {
        console.log('Found at line', i, ':', lines[i].substring(0, 60));
        console.log('Next line:', JSON.stringify(lines[i + 1]));
        console.log('+1:', JSON.stringify(lines[i + 2]));
        console.log('+2:', JSON.stringify(lines[i + 3]));
        console.log('+3:', JSON.stringify(lines[i + 4]));
        console.log('+4:', JSON.stringify(lines[i + 5]));

        // Replace the 5 lines (comment + 4 broken regex lines) with 2 lines
        var fixedLine1 = '  // Tables (must run before lists to avoid confusing | with list markers)';
        var fixedLine2 = '    s = s.replace(/(?:\\n|^)(\\|.+\\|)\\n\\|[-:\\s|]+\\|\\n((?:\\|.+\\|\\n?)*)/g, function(_, header, rows) {';

        lines.splice(i, 5, fixedLine1, fixedLine2);
        console.log('Replaced. New line at', i, ':', lines[i]);
        console.log('New line at', i + 1, ':', lines[i + 1]);
        break;
    }
}

fs.writeFileSync(path, lines.join('\r\n'), 'utf8');
console.log('Done');
