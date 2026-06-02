var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/core/editor.js';
var lines = fs.readFileSync(p, 'utf8').split('\n');

// 1. Add _paneEditors and _paneFiles after _editorRef (line 648, 0-indexed: 647)
lines.splice(648, 0, '  let _paneEditors = {};    // filePath → editor instance (for live refresh)');
lines.splice(648, 0, '  let _paneFiles = {};      // editor dom node → filePath (reverse lookup for dispose cleanup)');

// 2. In openInPane, store editor in _paneEditors
// Find: "return ed;" inside openInPane. Line ~726.
for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'return ed;' && i > 700 && i < 730) {
        lines.splice(i, 1,
            '      // track pane editor for live refresh (chat.txt etc.)',
            '      _paneEditors[filePath] = ed;',
            '      _paneFiles[host] = filePath;',
            '      ed.onDidDispose(function() {',
            '        delete _paneEditors[filePath];',
            '        delete _paneFiles[host];',
            '      });',
            '      return ed;');
        break;
    }
}

// 3. Add refreshLiveContent function before "window.qqqEditor = {" line (~752)
var windowQqqEditorIdx = -1;
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('window.qqqEditor = {') >= 0) { windowQqqEditorIdx = i; break; }
}
if (windowQqqEditorIdx > 0) {
    lines.splice(windowQqqEditorIdx, 0,
        '',
        '  // ---- refreshLiveContent: update an already-open pane editor with new content (for live chat.txt) ----',
        '  function refreshLiveContent(filePath, content) {',
        '    var ed = _paneEditors[filePath];',
        '    if (!ed) return false;',
        '    try {',
        '      ed._isRefreshing = true;',
        '      ed.setValue(content == null ? \'\' : String(content));',
        '      ed._isRefreshing = false;',
        '      // auto-scroll to bottom',
        '      var model = ed.getModel();',
        '      if (model) ed.revealLine(model.getLineCount());',
        '      return true;',
        '    } catch (e) {',
        '      console.warn(\'[editor] refreshLiveContent failed:\', e && e.message);',
        '      ed._isRefreshing = false;',
        '      return false;',
        '    }',
        '  }',
        ''
    );
    // Also add refreshLiveContent to the export object
    for (var i = windowQqqEditorIdx + 18; i < lines.length; i++) {
        if (lines[i].trim() === '};' && i > windowQqqEditorIdx + 21) {
            lines.splice(i, 0, '    refreshLiveContent,');
            break;
        }
    }
}

// 4. In openInPane, add readOnly support via opts parameter
// The function signature is: async function openInPane(host, filePath, content) {
// Change to: async function openInPane(host, filePath, content, opts) {
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('async function openInPane(host, filePath, content)') >= 0) {
        lines[i] = lines[i].replace('content)', 'content, opts)');
        break;
    }
}

// Add readOnly option support in monaco.editor.create
// Find: "automaticLayout: true," and add readOnly after it
var foundAutomatic = false;
for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'automaticLayout: true,' && !foundAutomatic && i > 650 && i < 680) {
        lines.splice(i + 1, 0, '        readOnly: (opts && opts.readOnly) || false,');
        foundAutomatic = true;
        break;
    }
}

// 5. In openInPane, skip dirty tracking for readOnly editors
// Find "ed.onDidChangeModelContent(() => { _markDirty(); });"
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('ed.onDidChangeModelContent(() => { _markDirty(); })') >= 0) {
        lines[i] = '      ed.onDidChangeModelContent(function() { if (!ed._isRefreshing) _markDirty(); });';
        break;
    }
}

// 6. Skip auto-save on blur for readOnly editors
for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('ed.onDidBlurEditorWidget(async () => {') >= 0) {
        lines[i] = '      ed.onDidBlurEditorWidget(async function() {';
        // Find the corresponding closing and add readOnly guard
        for (var j = i; j < lines.length; j++) {
            if (lines[j].trim() === '});' && j > i && j < i + 15) {
                // Replace the if (_paneDirty...) line in between
                for (var k = i + 1; k < j; k++) {
                    if (lines[k].indexOf('if (_paneDirty && filePath)') >= 0) {
                        lines[k] = lines[k].replace('if (_paneDirty && filePath)', 'if (_paneDirty && filePath && !(opts && opts.readOnly))');
                        break;
                    }
                }
                break;
            }
        }
        break;
    }
}

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('OK');
