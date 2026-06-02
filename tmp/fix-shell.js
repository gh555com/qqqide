var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/core/shell.js';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// 1. Modify qqq-file-open-right handler (line ~978-981)
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('qqq-file-open-right') >= 0 && lines[i].indexOf('openFileInRightGroup') >= 0) {
        // Replace the single line call with multi-line version that supports readOnly
        lines[i] = '        if (e.data.readOnly) { window._nextPaneOpts = { readOnly: true }; }';
        lines.splice(i + 1, 0, '        window.qqqTabs.openFileInRightGroup(e.data.path);');
        // The next line "return;" should still be there
        break;
    }
}

// 2. Add qqq-editor-refresh handler after qqq-file-open-right block
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('qqq-file-open-right') >= 0 && lines[i].indexOf('openFileInRightGroup(e.data.path)') >= 0) {
        // Insert after the "return;" line
        for (var j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            if (lines[j].trim() === 'return;') {
                lines.splice(j + 1, 0,
                    '      }',
                    '',
                    '      // Handle qqq-editor-refresh from iframes — live-update already-open editor content (chat.txt, etc.)',
                    '      if (e.data.type === \'qqq-editor-refresh\' && e.data.path && window.qqqEditor && window.qqqEditor.refreshLiveContent) {',
                    '        window.qqqEditor.refreshLiveContent(e.data.path, e.data.content);',
                    '        return;'
                );
                break;
            }
        }
        break;
    }
}

// 3. Modify qqq-file-open-in-pane handler to support opts
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('window.qqqEditor.openInPane(editorMount, filePath, content)') >= 0) {
        lines[i] = '          var _paneOpts = window._nextPaneOpts || {}; window._nextPaneOpts = null;';
        lines.splice(i + 1, 0, '          window.qqqEditor.openInPane(editorMount, filePath, content, _paneOpts);');
        break;
    }
}

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('OK');
