var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var c = fs.readFileSync(p, 'utf8');

// ── Change 1: Modify _hasMainProject ──
var old1 = "function _hasMainProject() {\n  try {\n    return !!(parent && parent.qqqAiViewport && parent.qqqAiViewport.getMainProject());\n  } catch(_) { return false; }\n}";
var new1 = "function _hasMainProject() {\n  try {\n    if (parent && parent.qqqAiViewport && parent.qqqAiViewport.getMainProject()) return true;\n  } catch(_) {}\n  return !!_standaloneRoot;\n}";
if (c.indexOf(old1) < 0) { console.log('CHANGE1 FAIL: old pattern not found'); } else {
    c = c.replace(old1, new1);
    console.log('CHANGE1 OK');
}

// ── Change 2: Add _standaloneRoot var ──
var old2 = "var _syncChannel = null;\nvar _readonlyQuest = false;";
var new2 = "var _syncChannel = null;\nvar _projectSyncChannel = null;\nvar _standaloneRoot = null;\nvar _readonlyQuest = false;";
if (c.indexOf(old2) < 0) { console.log('CHANGE2 FAIL'); } else {
    c = c.replace(old2, new2);
    console.log('CHANGE2 OK');
}

// ── Change 3: Broadcast project path in bindMainProject ──
var old3 = "console.log('[quests] bindMainProject: bound ' + root);";
var new3 = "console.log('[quests] bindMainProject: bound ' + root);\n  // Broadcast project path for wingman windows\n  try {\n    if (_projectSyncChannel) _projectSyncChannel.close();\n    _projectSyncChannel = new BroadcastChannel('qqq-project-path');\n    _projectSyncChannel.postMessage({ type: 'project-path', path: root });\n    console.log('[quests] broadcast project path: ' + root);\n  } catch(e) { console.warn('[quests] project-path broadcast failed:', e); }";
if (c.indexOf(old3) < 0) { console.log('CHANGE3 FAIL'); } else {
    c = c.replace(old3, new3);
    console.log('CHANGE3 OK');
}

// ── Change 4: Add project sync listener before bindMainProject() call ──
var old4 = "bindMainProject();";
var new4 = "// Standalone wingman: listen for project path via BroadcastChannel\n(function initProjectSync() {\n  if (_hasMainProject()) return;\n  console.log('[quests] standalone mode: listening for project path...');\n  try {\n    var ch = new BroadcastChannel('qqq-project-path');\n    ch.onmessage = function(e) {\n      if (e.data && e.data.type === 'project-path' && e.data.path) {\n        console.log('[quests] received project path: ' + e.data.path);\n        _standaloneRoot = e.data.path;\n        bindMainProject();\n        ch.close();\n      }\n    };\n  } catch(e) { console.warn('[quests] project sync unavailable:', e); }\n})();\nbindMainProject();";
if (c.indexOf(old4) < 0) { console.log('CHANGE4 FAIL: old4 not found'); } else {
    c = c.replace(old4, new4);
    console.log('CHANGE4 OK');
}

fs.writeFileSync(p, c, 'utf8');
console.log('All changes written.');

// Verify
var v = fs.readFileSync(p, 'utf8');
var checks = [
    ['_hasMainProject', '!!_standaloneRoot'],
    ['_standaloneRoot var', '_standaloneRoot = null'],
    ['project broadcast', 'qqq-project-path'],
    ['initProjectSync', 'initProjectSync'],
];
var ok = true;
for (var i = 0; i < checks.length; i++) {
    var found = v.indexOf(checks[i][1]) >= 0;
    console.log((found ? 'OK' : 'FAIL') + ' ' + checks[i][0]);
    if (!found) ok = false;
}
console.log(ok ? 'ALL VERIFIED' : 'SOME FAILED');
