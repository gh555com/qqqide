var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/agent-loop.js';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// Find the language detection block (starts with comment "Language detection")
var langStart = -1, langEnd = -1;
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('Language detection + forced injection') >= 0) {
        langStart = i;
    }
    if (langStart >= 0 && lines[i].indexOf('var _langDirective') >= 0) {
        // find the closing } of if(_langName) and the next }
        for (var j = i; j < lines.length; j++) {
            if (lines[j].trim() === '}' && j > i + 3) {
                if (langEnd < 0) {
                    langEnd = j; // first } closes if(_langName)
                } else {
                    // second } found, this might be if(dynamicCtx) closing
                    // We want langEnd to be the last line of our block
                    break;
                }
            }
        }
        break;
    }
}

if (langStart < 0) { console.log('NOT FOUND langStart'); process.exit(1); }

// langEnd should be the last line of the language block.
// The block is from langStart to langEnd (inclusive).
// We need to find the } that closes if(dynamicCtx) and move the block there.

// Find "var body" to get the right spot
var bodyLine = -1;
for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('var body = {')) {
        bodyLine = i;
        break;
    }
}

console.log('langStart:', langStart + 1, 'bodyLine:', bodyLine + 1);

// Extract the language block
var blockLines = [];
var captureStart = -1;
for (var i = langStart; i < bodyLine; i++) {
    if (lines[i].indexOf('Language detection + forced injection') >= 0) captureStart = i;
    if (captureStart >= 0) blockLines.push(lines[i]);
}

// Remove old block (from captureStart to bodyLine-1)
var oldStart = captureStart;
var oldCount = bodyLine - oldStart;
lines.splice(oldStart, oldCount);

// Find the position right after if(dynamicCtx) closing
// After removal, look for the } that closes if(dynamicCtx) then a blank line then var body
var insertAt = -1;
for (var i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i].trim() === '' && lines[i + 1] && lines[i + 1].trim().startsWith('var body = {')) {
        // Check if previous line is a lone }
        var prev = lines[i - 1].trim();
        if (prev === '}') {
            insertAt = i;
            break;
        }
    }
}

if (insertAt < 0) {
    console.log('Cannot find insertion point, lines around body:');
    for (var i = Math.max(0, bodyLine - 20); i < Math.min(lines.length, bodyLine + 3); i++) {
        console.log((i + 1) + ': ' + lines[i]);
    }
    process.exit(1);
}

console.log('Insert at line', insertAt + 1);

// Insert the block
lines.splice(insertAt, 0, ...blockLines);
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('DONE');
