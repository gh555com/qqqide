var fs = require('fs');
var path = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var content = fs.readFileSync(path, 'utf8');

var BS = String.fromCharCode(92); // backslash

// Build the correct single-line regex
var correctRegex = 's = s.replace(/(?:' + BS + 'n|^)(\\|.+\\|)' + BS + 'n\\|[-:' + BS + 's|]+\\|' + BS + 'n((?:\\|.+\\|' + BS + 'n?)*)/g, function(_, header, rows) {';

// The corrupted pattern: multiline with actual newlines
// Find lines starting with "    s = s.replace(/(?:" and ending with "function(_, header, rows) {"
var lines = content.split('\n');
var startIdx = -1;
var endIdx = -1;

for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (startIdx === -1 && trimmed.indexOf('s = s.replace(/(?:') === 0) {
        startIdx = i;
    }
    if (startIdx >= 0 && trimmed.indexOf('function(_, header, rows) {') >= 0) {
        endIdx = i;
        break;
    }
}

if (startIdx >= 0 && endIdx >= 0) {
    console.log('Found corrupted regex from line', startIdx, 'to', endIdx);
    console.log('Replacing with single-line regex');
    // Replace the range with the single correct line
    lines.splice(startIdx, endIdx - startIdx + 1, '    ' + correctRegex);
    fs.writeFileSync(path, lines.join('\n'), 'utf8');

    // Verify
    var verify = fs.readFileSync(path, 'utf8');
    var found = verify.indexOf('s = s.replace(/(?:');
    if (found >= 0) {
        var excerpt = verify.substring(found, found + 100);
        console.log('Verified:', excerpt);
        if (excerpt.indexOf('\n') < excerpt.indexOf('function(')) {
            console.log('WARNING: regex still multiline!');
        } else {
            console.log('OK: regex is single-line');
        }
    }
} else {
    console.log('No corrupted regex found');
}
