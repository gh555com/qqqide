var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/core/shell.js';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// Replace lines 978-982 (0-indexed: 977-981) with new qqq-file-open-right + qqq-editor-refresh handlers
var nw = [
    '      // Handle qqq-file-open-right from iframes — opens file in right editor group',
    '      if (e.data.type === \'qqq-file-open-right\' && e.data.path && window.qqqTabs && window.qqqTabs.openFileInRightGroup) {',
    '        if (e.data.readOnly) { window._nextPaneOpts = { readOnly: true }; }',
    '        window.qqqTabs.openFileInRightGroup(e.data.path);',
    '        return;',
    '      }',
    '',
    '      // Handle qqq-editor-refresh from iframes — live-update already-open editor content (chat.txt, etc.)',
    '      if (e.data.type === \'qqq-editor-refresh\' && e.data.path && window.qqqEditor && window.qqqEditor.refreshLiveContent) {',
    '        window.qqqEditor.refreshLiveContent(e.data.path, e.data.content);',
    '        return;',
    '      }'
];
lines.splice(977, 5, ...nw);

// Now fix the qqq-file-open-in-pane handler to support opts
// Find: window.qqqEditor.openInPane(editorMount, filePath, content);
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('window.qqqEditor.openInPane(editorMount, filePath, content)') >= 0) {
        lines[i] = '          var _paneOpts = window._nextPaneOpts || {}; window._nextPaneOpts = null;';
        lines.splice(i + 1, 0, '          window.qqqEditor.openInPane(editorMount, filePath, content, _paneOpts);');
        break;
    }
}

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('OK');
