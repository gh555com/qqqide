var fs = require('fs');
var c = fs.readFileSync('server-app/ai-panel/tools-exec.js', 'utf8');
var d = 0;
var inS = 0, inSQ = 0, inB = 0, inC = 0;
for (var i = 0; i < c.length; i++) {
    var ch = c[i];
    if (ch === '"' && inSQ === 0 && inB === 0) { inS = 1 - inS; }
    else if (ch === "'" && inS === 0 && inB === 0) { inSQ = 1 - inSQ; }
    else if (ch === '`' && inS === 0 && inSQ === 0) { inB = 1 - inB; }
    else if (ch === '/' && inS === 0 && inSQ === 0 && inB === 0) {
        if (c[i + 1] === '/') { while (i < c.length && c[i] !== '\n') i++; }
        else if (c[i + 1] === '*') { inC = 1; i++; }
    }
    else if (ch === '*' && inC === 1 && c[i + 1] === '/') { inC = 0; i++; }
    else if (inS === 0 && inSQ === 0 && inB === 0 && inC === 0) {
        if (ch === '{') d++;
        if (ch === '}') d--;
    }
}
console.log('Final depth:', d);
