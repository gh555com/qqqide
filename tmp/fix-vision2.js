var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/system-prompt.js';
var c = fs.readFileSync(p, 'utf8');

// Build the old block we want to replace - find start/end by content
var startSearch = 'var lines = [];\r\n        lines.push(\'═══ AI';
var endSearch = 'lines.push(\'══════════════════════════════\');';

var s = c.indexOf(startSearch);
var e = c.indexOf(endSearch, s);
if (s < 0 || e < 0) { console.log('FAIL: markers not found'); process.exit(1); }
e += endSearch.length;

// Replace
var nw = [
    "var lines = [];",
    "        lines.push('═══ VISION CONTEXT ═══');",
    "        lines.push('Folders visible in your IDE titlebar:');",
    "        for (var i = 0; i < vps.length; i++) {",
    "            var f = vps[i];",
    "            var isMain = main && f.path === main.path;",
    "            if (isMain) {",
    "                lines.push('● ' + f.name + ' (' + f.path + ') ← MAIN PROJECT');",
    "                lines.push('  \"our project\" = this folder. Persistence (history, rules) lives in its qqq/ subdir.');",
    "            } else {",
    "                lines.push('○ ' + f.name + ' (' + f.path + ') ← auxiliary');",
    "                lines.push('  Reference/search/edit only. No persistence.');",
    "            }",
    "        }",
    "        lines.push('');",
    "        lines.push('RULE: \"our project\" always means the ● MAIN PROJECT above.');"
].join('\r\n');

c = c.substring(0, s) + nw + c.substring(e);
fs.writeFileSync(p, c, 'utf8');
console.log('OK');
