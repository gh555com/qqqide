var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/system-prompt.js';
var lines = fs.readFileSync(p, 'utf8').split('\n');

var nw = [
    "        var lines = [];",
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
];
lines.splice(109, 19, nw.join('\n'));
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('OK');
