var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var c = fs.readFileSync(p, 'utf8');
var BS = String.fromCharCode(92);

// ── Step 1: Add ipc-bridge.js + state-sdk.js scripts at line 274 ──
var marker1 = '<script src="only-store.js"></script>';
var insert1 = '<script src="../core/ipc-bridge.js"></script>\n<script src="../core/state-sdk.js"></script>\n';
var idx1 = c.indexOf(marker1);
if (idx1 >= 0) {
    c = c.substring(0, idx1) + insert1 + c.substring(idx1);
    console.log('Step 1: added ipc-bridge + state-sdk scripts');
} else {
    console.log('Step 1 FAIL: marker not found');
}

// ── Step 2: Modify _hasMainProject to also check _standaloneRoot ──
var oldHasMain = 'function _hasMainProject() {\n  try {\n    return !!(parent && parent.qqqAiViewport && parent.qqqAiViewport.getMainProject());\n  } catch(_) { return false; }\n}';
var newHasMain = 'function _hasMainProject() {\n  try {\n    if (parent && parent.qqqAiViewport && parent.qqqAiViewport.getMainProject()) return true;\n  } catch(_) {}\n  return !!_standaloneRoot;\n}';
if (c.indexOf(oldHasMain) >= 0) {
    c = c.replace(oldHasMain, newHasMain);
    console.log('Step 2: modified _hasMainProject');
} else {
    console.log('Step 2 FAIL: _hasMainProject not found');
}

// ── Step 3: Add _standaloneRoot var + _projectSyncChannel after _syncChannel ──
var marker3 = 'var _syncChannel = null;';
var insert3 = 'var _projectSyncChannel = null;\nvar _standaloneRoot = null; // BroadcastChannel 同步的项目路径（僚机窗口使用）';
if (c.indexOf(marker3) >= 0 && c.indexOf('_standaloneRoot') < 0) {
    c = c.replace(marker3, marker3 + '\n' + insert3);
    console.log('Step 3: added _standaloneRoot + _projectSyncChannel');
} else {
    console.log('Step 3: ' + (c.indexOf('_standaloneRoot') >= 0 ? 'already present' : 'marker not found'));
}

// ── Step 4: Add project sync channel listener after _handleSyncMessage setup ──
// The _handleSyncMessage function is defined. We need to add a new listener that handles 'project-path' messages.
// Actually, better: integrate into _handleSyncMessage by adding a case.

// Find _handleSyncMessage and add 'project-path' case
// We'll look for: "var _syncChannel = null;" block and add init after.
// Better approach: add a standalone init block that sets up the project sync channel.

// ── Step 5: In bindMainProject, after successful binding, broadcast project path ──
var marker5 = "console.log('[quests] bindMainProject: bound ' + root);";
var insert5 = "console.log('[quests] bindMainProject: bound ' + root);\n  // 向僚机窗口广播主项目路径\n  try {\n    if (_projectSyncChannel) _projectSyncChannel.close();\n    _projectSyncChannel = new BroadcastChannel('qqq-project-path');\n    _projectSyncChannel.postMessage({ type: 'project-path', path: root });\n    console.log('[quests] broadcast project path: ' + root);\n  } catch(e) { console.warn('[quests] project-path broadcast failed:', e); }";
if (c.indexOf(marker5) >= 0 && c.indexOf('project-path broadcast') < 0) {
    c = c.replace(marker5, insert5);
    console.log('Step 5: added project path broadcast in bindMainProject');
} else {
    console.log('Step 5: ' + (c.indexOf('project-path broadcast') >= 0 ? 'already present' : 'marker not found'));
}

// ── Step 6: Add standalone project sync listener ──
// Add it before the bindMainProject() call at the bottom
var marker6 = 'bindMainProject();';
// We need to add a listener BEFORE bindMainProject is called.
// Find the window.addEventListener('message'...) that handles qqq-ai-viewport-changed
var marker6a = "if (e.data && e.data.type === 'qqq-ai-viewport-changed') {";
if (c.indexOf(marker6a) >= 0 && c.indexOf('qqq-project-path') < 0) {
    // Add a new listener for BroadcastChannel project path sync
    // Find the block: "window.addEventListener('message', function(e) {" just before bindMainProject
    var msgListenerBlock = "// 监听视口变化：主文件夹改变时重新绑定\nwindow.addEventListener('message', function(e) {\n  if (e.data && e.data.type === 'qqq-ai-viewport-changed') {\n    bindMainProject();\n  }";
    var newBlock = "// 监听视口变化：主文件夹改变时重新绑定\nwindow.addEventListener('message', function(e) {\n  if (e.data && e.data.type === 'qqq-ai-viewport-changed') {\n    bindMainProject();\n  }";

    // Add the project sync listener as a separate block
    var projectSyncBlock = BS + 'n' + BS + 'n' + '// ═══ 僚机窗口：监听 BroadcastChannel 获取主项目路径 ═══' + BS + 'n' +
        '(function initProjectSync() {' + BS + 'n' +
        '  // 如果已经有主项目（主窗口），跳过' + BS + 'n' +
        '  if (_hasMainProject()) return;' + BS + 'n' +
        '  console.log(\\'[quests] standalone mode: listening for project path...\\');' + BS + 'n' +
            '  try {' + BS + 'n' +
            '    var ch = new BroadcastChannel(\\'qqq - project - path\\');' + BS + 'n' +
                '    ch.onmessage = function(e) {' + BS + 'n' +
                '      if (e.data && e.data.type === \\'project - path\\' && e.data.path) {' + BS + 'n' +
                    '        console.log(\\'[quests] received project path: \\' + e.data.path);' + BS + 'n' +
                        '        _standaloneRoot = e.data.path;' + BS + 'n' +
                        '        bindMainProject();' + BS + 'n' +
                        '        ch.close();' + BS + 'n' +
                        '      }' + BS + 'n' +
                        '    };' + BS + 'n' +
                        '  } catch(e) { console.warn(\\'[quests] project sync unavailable: \\', e); }' + BS + 'n' +
                            '})();';

    c = c.replace(marker6, projectSyncBlock + BS + 'n' + marker6);
    console.log('Step 6: added project sync listener');
} else {
    console.log('Step 6: ' + (c.indexOf('qqq-project-path') >= 0 ? 'already present' : 'marker not found'));
}

fs.writeFileSync(p, c, 'utf8');
console.log('Done. Verifying...');

// Verify all changes
var v = fs.readFileSync(p, 'utf8');
var checks = [
    ['ipc-bridge.js', '<script src="../core/ipc-bridge.js"></script>'],
    ['state-sdk.js', '<script src="../core/state-sdk.js"></script>'],
    ['_standaloneRoot', '_standaloneRoot'],
    ['_hasMainProject standalone', '!!_standaloneRoot'],
    ['project-path broadcast', 'qqq-project-path'],
    ['project sync listener', 'initProjectSync'],
    ['captured refs', '_capturedQuestId = questActiveId;'],
];
var allOk = true;
for (var i = 0; i < checks.length; i++) {
    var ok = v.indexOf(checks[i][1]) >= 0;
    console.log((ok ? '✓' : '✗') + ' ' + checks[i][0]);
    if (!ok) allOk = false;
}
if (allOk) console.log('ALL VERIFIED');
else console.log('SOME CHECKS FAILED');
