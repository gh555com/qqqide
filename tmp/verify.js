var c = require('fs').readFileSync('e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html', 'utf8');
var ok = true;
var m = c.match(/<script>([\s\S]*?)<\/script>/);
try { new Function(m[1]) } catch (e) { ok = false; console.log('JS ERR:', e.message.substring(0, 100)) }
if (ok) console.log('JS OK');
console.log('Guard:', c.includes('agent ? agent._ctx.totalFloors'));
console.log('Table regex present:', c.includes('un before lists'));
