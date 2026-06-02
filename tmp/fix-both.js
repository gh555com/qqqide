var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var c = fs.readFileSync(p, 'utf8');

// The correct single-line table regex (built from parts to avoid \n corruption)
var BS = String.fromCharCode(92); // backslash
var N = BS + 'n';  // \n as two chars
var P = BS + '|';  // \| as two chars
var S = BS + 's';  // \s as two chars

var correctRegex = '    s = s.replace(/(?:' + N + '|^)(' + P + '.+' + P + ')' + N + P + '[-:' + S + '|]+' + P + N + '((?:' + P + '.+' + P + N + '?)*)/g, function(_, header, rows) {';

// Find the broken multi-line regex and replace
// The broken pattern: starts with "    s = s.replace(/(?:\n" where \n is actual newline
var brokenStart = '    s = s.replace(/(?:\n';
var idx = c.indexOf(brokenStart);
if (idx >= 0) {
    // Find the end of the broken regex (next occurrence of "function(" after a few lines)
    var rest = c.substring(idx);
    var endMatch = rest.match(/\n\?\)\*\)\/g, function/);
    if (endMatch) {
        var endIdx = idx + endMatch.index + endMatch[0].length;
        c = c.substring(0, idx) + correctRegex + c.substring(endIdx);
        console.log('Fixed table regex');
    } else {
        console.log('Could not find end of broken regex');
    }
} else {
    console.log('Broken regex start not found, checking variants...');
    // Try with \r\n
    brokenStart = '    s = s.replace(/(?:\r\n';
    idx = c.indexOf(brokenStart);
    if (idx >= 0) {
        var rest = c.substring(idx);
        var endMatch = rest.match(/\r\n\?\)\*\)\/g, function/);
        if (endMatch) {
            var endIdx = idx + endMatch.index + endMatch[0].length;
            c = c.substring(0, idx) + correctRegex + c.substring(endIdx);
            console.log('Fixed table regex (CRLF)');
        } else {
            console.log('Could not find end of broken regex (CRLF)');
        }
    } else {
        console.log('No broken regex found');
    }
}

// Also fix the agent._ctx guard
var oldGuard = 'userMsgEl._floor = agent._ctx.totalFloors;';
var newGuard = 'userMsgEl._floor = agent ? agent._ctx.totalFloors : 0;';
if (c.indexOf(oldGuard) >= 0) {
    c = c.replace(oldGuard, newGuard);
    console.log('Fixed agent._ctx guard');
} else if (c.indexOf(newGuard) >= 0) {
    console.log('Agent guard already present');
} else {
    console.log('Agent guard pattern not found!');
}

fs.writeFileSync(p, c, 'utf8');
console.log('Done');
