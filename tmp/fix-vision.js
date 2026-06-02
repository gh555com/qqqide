var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/system-prompt.js';
var c = fs.readFileSync(p, 'utf8');

// Find the start of buildVisionContext
var marker = "lines.push('═══ AI 视口 (VISION CONTEXT) ═══');";
var idx = c.indexOf(marker);
if (idx < 0) { console.log('NOT FOUND'); process.exit(1); }

// Find the separator line at the end
var endMarker = "lines.push('══════════════════════════════');";
var endIdx = c.indexOf(endMarker, idx);
if (endIdx < 0) { console.log('END NOT FOUND'); process.exit(1); }
endIdx += endMarker.length;

// Old block (from first lines.push to the separator)
var old = c.substring(idx, endIdx);

// New block
var nw = [
    "lines.push('═══ VISION CONTEXT ═══');",
    "lines.push('Folders visible in your IDE titlebar:');",
    "for (var i = 0; i < vps.length; i++) {",
    "    var f = vps[i];",
    "    var isMain = main && f.path === main.path;",
    "    if (isMain) {",
    "        lines.push('● ' + f.name + ' (' + f.path + ') ← MAIN PROJECT');",
    "        lines.push('  \"our project\" = this folder. Persistence (history, rules) lives in its qqq/ subdir.');",
    "    } else {",
    "        lines.push('○ ' + f.name + ' (' + f.path + ') ← auxiliary');",
    "        lines.push('  Reference/search/edit only. No persistence.');",
    "    }",
    "}",
    "lines.push('');",
    "lines.push('RULE: \"our project\" always means the ● MAIN PROJECT above.');"
].join('\r\n        ');

c = c.replace(old, nw);
fs.writeFileSync(p, c, 'utf8');
console.log('OK');
