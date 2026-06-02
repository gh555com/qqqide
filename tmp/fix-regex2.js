const fs = require('fs');
const path = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
let content = fs.readFileSync(path, 'utf8');

// Find the corrupted table regex that has literal newlines instead of \n escapes
// The pattern: starts with the comment, then a line with "s = s.replace(/(?:" then broken across lines
const brokenPattern = /  \/\/ Tables \(must run before lists[\s\S]*?(?:\r?
s = s\.replace\(\/\(\?:) \r ?
    (\| [^^] *?) \r ?
        (\\\|\[-: \\s\|]\+\\\\\|) \r ?
            (\(\()[\s\S]*?\r ?
                (\?\) \*\) \/g, function\(_, header, rows\) \{)/;

const match = content.match(brokenPattern);
if (match) {
    console.log('Found broken regex at index', match.index);
    const fixed = '  // Tables (must run before lists to avoid confusing | with list markers)\r\n    s = s.replace(/(?:\\n|^)(\\|.+\\|)\\n\\|[-:\\s|]+\\|\\n((?:\\|.+\\|\\n?)*)/g, function(_, header, rows) {';
    content = content.replace(match[0], fixed);
    fs.writeFileSync(path, content, 'utf8');
    console.log('Fixed!');
} else {
    console.log('Pattern not found');
    // Debug: show lines 655-661
    const lines = content.split('\r\n');
    for (let i = 654; i <= 662; i++) {
        console.log(i + ': ' + JSON.stringify(lines[i]));
    }
}
