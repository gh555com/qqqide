var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var c = fs.readFileSync(p, 'utf8');

// Fix: agent._ctx.totalFloors -> agent ? agent._ctx.totalFloors : 0
// at the line just after addMessageEl('user', text)
var old = "userMsgEl._floor = agent._ctx.totalFloors;";
var nw = "userMsgEl._floor = agent ? agent._ctx.totalFloors : 0;";
if (c.indexOf(old) >= 0) {
    c = c.replace(old, nw);
    fs.writeFileSync(p, c, 'utf8');
    console.log('Fixed agent._ctx guard');
} else {
    console.log('Pattern not found');
}
