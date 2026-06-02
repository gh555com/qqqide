const fs = require('fs');
const path = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
let content = fs.readFileSync(path, 'utf8');

// The broken regex spans lines 657-661 (0-indexed 656-660)
const lines = content.split('\r\n');

// Line 656 (comment) should be kept as-is
// Lines 657-660 contain the broken regex
// Replace lines 656-660 with the fixed single-line regex

const fixedComment = '  // Tables (must run before lists to avoid confusing | with list markers)';
const fixedRegex = '    s = s.replace(/(?:\\n|^)(\\|.+\\|)\\n\\|[-:\\s|]+\\|\\n((?:\\|.+\\|\\n?)*)/g, function(_, header, rows) {';

// Replace lines 656-660 (0-indexed)
lines.splice(656, 5, fixedComment, fixedRegex);

fs.writeFileSync(path, lines.join('\r\n'), 'utf8');
console.log('Fixed. New line 657: ' + lines[656]);
console.log('New line 658: ' + lines[657]);
