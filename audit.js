// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

var fs = require('fs');
var s = fs.readFileSync('server-app/ai-panel/index.html','utf8');

var fns = [
  'saveQuestUIState',
  'restoreQuestUIState', 
  'initQuests',
  '_unloadQuest',
  'createNewQuest',
  'switchQuest',
  '_handleSyncMessage',
  'bindMainProject',
  '_initWorkspace'
];

fns.forEach(function(fn) {
  var callRe = new RegExp(fn + '\\(', 'g');
  var callCount = (s.match(callRe) || []).length;
  var defCount = (s.match(new RegExp('function ' + fn, 'g')) || []).length;
  defCount += (s.match(new RegExp('async function ' + fn, 'g')) || []).length;
  console.log(fn + ': called=' + callCount + ' defined=' + defCount);
});
