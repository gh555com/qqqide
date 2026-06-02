var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// Line 2542 (0-indexed 2541): var qTitle2 = qEntry ? ...
// Line 2543 (0-indexed 2542): var qDirName2 = 'q' + ...
var newLines = [
    "    var qTitle2 = (qEntry && qEntry.title && qEntry.title !== 'New Chat') ? qEntry.title : questActiveId;",
    "    var qDirName2 = _makeName('q', qEntry && qEntry.numericId ? qEntry.numericId : 0, qTitle2);"
];

// Remove the trailing \r from old lines and replace
lines[2541] = '    var qTitle2 = (qEntry && qEntry.title && qEntry.title !== \'New Chat\') ? qEntry.title : questActiveId;';
lines[2542] = '    var qDirName2 = _makeName(\'q\', qEntry && qEntry.numericId ? qEntry.numericId : 0, qTitle2);';

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('OK');
