var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var l = fs.readFileSync(p, 'utf8');
l = l.replace("String.fromCharCode(78,101,119,32,67,104,97,116)", "'New Chat'");
fs.writeFileSync(p, l, 'utf8');
console.log('OK');
