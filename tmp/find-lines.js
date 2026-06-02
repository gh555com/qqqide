var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// ===== Find key line numbers =====
var generateFloorTxtIdx = -1;  // line where generateFloorTxt is defined
var sendMessageIdx = -1;       // line where sendMessage starts
var formatBytesIdx = -1;       // line where formatBytes is defined
var setStreamingIdx = -1;      // line where setStreaming is defined

for (var i = 0; i < lines.length; i++) {
    var t = lines[i];
    if (t.indexOf('async function generateFloorTxt()') >= 0) generateFloorTxtIdx = i;
    if (t.indexOf('async function sendMessage()') >= 0) sendMessageIdx = i;
    if (t.indexOf('function formatBytes(') >= 0) formatBytesIdx = i;
    if (t.indexOf('function setStreaming(') >= 0) setStreamingIdx = i;
}

console.log('generateFloorTxtIdx:', generateFloorTxtIdx + 1);
console.log('sendMessageIdx:', sendMessageIdx + 1);
console.log('formatBytesIdx:', formatBytesIdx + 1);
console.log('setStreamingIdx:', setStreamingIdx + 1);
