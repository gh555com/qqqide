var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var c = fs.readFileSync(p, 'utf8');
var LN = String.fromCharCode(10); // \n

// Step 1: Replace USER block + HOUSE separator
// Find the exact text: from "var timing = agent._floorTiming;" through the HOUSE separator line
var marker1 = 'var timing = agent._floorTiming;'
var marker2 = "lines.push('── HOUSE ' + h.index + ' ── ' + ts() + ' [' + h.ms + 'ms] ──');"

var idx1 = c.indexOf(marker1);
var idx2 = c.indexOf(marker2);

if (idx1 >= 0 && idx2 >= 0) {
    var idx2end = idx2 + marker2.length;
    var before = c.substring(0, idx1);
    var after = c.substring(idx2end);

    // Build new block
    var newBlock = [
        '    var timing = agent._floorTiming;',
        '    var lines = [];',
        '',
        '    // ' + String.fromCharCode(0x2550).repeat(3) + ' 计算 body size ' + String.fromCharCode(0x2550).repeat(3),
        '    var fmtK = function(bytes) { return (bytes / 1024).toFixed(3) + \'k\'; };',
        '    var userText = (ui && ui.text) ? ui.text.trim() : \'\';',
        '    var visionText = (ui && ui.vision) ? ui.vision.trim() : \'\';',
        '    var askBytes = userText ? new TextEncoder().encode(userText).length : 0;',
        '    var sourceBytes = visionText ? new TextEncoder().encode(visionText).length : 0;',
        '    var promptBytes = 0;',
        '    var ruleBytes = 0;',
        '    var memoryBytes = 0;',
        '    var conv = agent.conversation;',
        '    for (var ci = 0; ci < conv.length; ci++) {',
        '      var cm = conv[ci];',
        '      if (!cm || typeof cm.content !== \'string\') continue;',
        '      var cb = new TextEncoder().encode(cm.content).length;',
        '      if (cm._persistent) {',
        '        if (typeof SYSTEM_PROMPT !== \'undefined\' && cm.content.indexOf(SYSTEM_PROMPT) === 0) {',
        '          promptBytes += cb;',
        '        } else {',
        '          ruleBytes += cb;',
        '        }',
        '      } else if (cm.role === \'user\' && cm._floor === floorNum) {',
        '        memoryBytes += Math.max(0, cb - askBytes - sourceBytes);',
        '      } else {',
        '        memoryBytes += cb;',
        '      }',
        '    }',
        '    var totalBytes = askBytes + sourceBytes + promptBytes + ruleBytes + memoryBytes;',
        '',
        '    // ' + String.fromCharCode(0x2550).repeat(3) + ' floor 头 ' + String.fromCharCode(0x2550).repeat(3),
        '    var floorTs = timing && timing.floorStartServerMs ? new Date(timing.floorStartServerMs) : now;',
        '    lines.push(\'floor.\' + floorNum + \'   \' + ts(floorTs));',
        '    lines.push(\'\');',
        '    lines.push(\'(body \' + fmtK(totalBytes) + \': ask \' + fmtK(askBytes) + \' + rule \' + fmtK(ruleBytes) + \' + Source code \' + fmtK(sourceBytes) + \' + prompt \' + fmtK(promptBytes) + \' + memory \' + fmtK(memoryBytes) + \')\');',
        '    lines.push(\'\');',
        '    if (userText) { lines.push(userText); lines.push(\'\'); }',
        '    if (visionText) { lines.push(visionText); lines.push(\'\'); }',
        '',
        '    // ' + String.fromCharCode(0x2550).repeat(3) + ' HOUSE + ROOM 块 ' + String.fromCharCode(0x2550).repeat(3),
        '    for (var hi = 0; hi < houses.length; hi++) {',
        '      var h = houses[hi];',
        '      var houseTs = h.ts ? new Date(h.ts) : now;',
        '      lines.push(\'' + String.fromCharCode(0x2550).repeat(4) + ' HOUSE \' + h.index + \' ' + String.fromCharCode(0x2550).repeat(4) + ' \' + ts(houseTs) + \' [\' + h.ms + \'ms] ' + String.fromCharCode(0x2550).repeat(4) + '\');',
        ''
    ].join('\r\n');

    c = before + newBlock + after;
    console.log('Block replaced');
} else {
    console.log('Markers not found: idx1=' + idx1 + ', idx2=' + idx2);
}

// Step 2: Fix floor stats separator
var oldStats = "lines.push('── floor ' + floorNum + ' stats ──');";
var newStats = "lines.push('" + String.fromCharCode(0x2550).repeat(4) + " floor ' + floorNum + ' stats " + String.fromCharCode(0x2550).repeat(4) + "');";
if (c.indexOf(oldStats) >= 0) {
    c = c.replace(oldStats, newStats);
    console.log('Stats fixed');
} else {
    console.log('Stats marker not found');
}

fs.writeFileSync(p, c, 'utf8');

// Step 3: Fix table regex if corrupted
var BS = String.fromCharCode(92);
var correctRegex = 's = s.replace(/(?:' + BS + 'n|^)(\\|.+\\|)' + BS + 'n\\|[-:' + BS + 's|]+\\|' + BS + 'n((?:\\|.+\\|' + BS + 'n?)*)/g, function(_, header, rows) {';
var lines = c.split('\n');
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
if (startIdx >= 0 && endIdx >= 0 && endIdx > startIdx) {
    lines.splice(startIdx, endIdx - startIdx + 1, '    ' + correctRegex);
    fs.writeFileSync(p, lines.join('\n'), 'utf8');
    console.log('Table regex fixed');
} else {
    console.log('Table regex OK (no corruption)');
}
console.log('Done');
