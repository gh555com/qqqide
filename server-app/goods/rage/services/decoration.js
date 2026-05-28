// ============================================================================
// qqq-decoration.js - Monaco Decoration for path highlighting
//
// Highlights /\ path \/ references with background color and subtle styling.
// Uses editor.deltaDecorations (native Monaco API).
// ============================================================================

(function () {
  'use strict';

  const PATH_REGEX = /\/\\\s*([\s\S]*?)\s*\\\//gi;

  let _decorationIds = [];
  let _disposables = [];
  let _delimitersClassName = 'qqq-path-delimiter';
  let _pathClassName = 'qqq-path-highlight';

  // Inject CSS for decorations
  function injectStyles() {
    if (document.getElementById('qqq-decoration-styles')) return;
    const style = document.createElement('style');
    style.id = 'qqq-decoration-styles';
    style.textContent = `
      .qqq-path-highlight {
        background-color: var(--card-bg);
        border-radius: 3px;
      }
      .qqq-path-delimiter {
        opacity: 0.35;
        font-size: 0.85em;
      }
    `;
    document.head.appendChild(style);
  }

  function updateDecorations(editor, monaco) {
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const text = model.getValue();
    const regex = new RegExp(PATH_REGEX.source, PATH_REGEX.flags);
    const newDecorations = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0];
      const innerPath = match[1] || '';
      const startOffset = match.index;
      const endOffset = startOffset + fullMatch.length;

      // Full match range (for path highlight)
      const startPos = model.getPositionAt(startOffset);
      const endPos = model.getPositionAt(endOffset);

      // Inner path highlight
      const innerStart = startOffset + fullMatch.indexOf(innerPath);
      const innerEnd = innerStart + innerPath.length;
      const innerStartPos = model.getPositionAt(innerStart);
      const innerEndPos = model.getPositionAt(innerEnd);

      newDecorations.push({
        range: new monaco.Range(
          innerStartPos.lineNumber, innerStartPos.column,
          innerEndPos.lineNumber, innerEndPos.column
        ),
        options: {
          inlineClassName: _pathClassName,
          hoverMessage: { value: innerPath.trim() },
        }
      });

      // Opening delimiter /\ highlight
      const openEnd = startOffset + 2; // "/\" is 2 chars
      const openStartPos = model.getPositionAt(startOffset);
      const openEndPos = model.getPositionAt(openEnd);
      newDecorations.push({
        range: new monaco.Range(
          openStartPos.lineNumber, openStartPos.column,
          openEndPos.lineNumber, openEndPos.column
        ),
        options: { inlineClassName: _delimitersClassName }
      });

      // Closing delimiter \/ highlight
      const closeStart = endOffset - 2; // "\/" is 2 chars
      const closeStartPos = model.getPositionAt(closeStart);
      const closeEndPos = model.getPositionAt(endOffset);
      newDecorations.push({
        range: new monaco.Range(
          closeStartPos.lineNumber, closeStartPos.column,
          closeEndPos.lineNumber, closeEndPos.column
        ),
        options: { inlineClassName: _delimitersClassName }
      });
    }

    _decorationIds = editor.deltaDecorations(_decorationIds, newDecorations);
  }

  function init() {
    const monaco = window.qqqEditor.getMonaco();
    const ed = window.qqqEditor.getEditorInstance();
    if (!monaco || !ed) {
      setTimeout(init, 500);
      return;
    }
    attach(ed);
  }

  // attach(ed): per-editor state + listeners (multi-editor support).
  function attach(ed) {
    const monaco = window.qqqEditor.getMonaco();
    if (!monaco || !ed) return null;

    injectStyles();

    let localDecorationIds = [];
    function localUpdate() {
      const model = ed.getModel();
      if (!model) return;
      const text = model.getValue();
      const regex = new RegExp(PATH_REGEX.source, PATH_REGEX.flags);
      const newDecorations = [];
      let match;
      while ((match = regex.exec(text)) !== null) {
        const fullMatch = match[0];
        const innerPath = match[1] || '';
        const startOffset = match.index;
        const endOffset = startOffset + fullMatch.length;
        const innerStart = startOffset + fullMatch.indexOf(innerPath);
        const innerEnd = innerStart + innerPath.length;

        // Skip whole-line tokens (viewzone owns those, avoid overlay)
        const sp = model.getPositionAt(startOffset);
        const ep = model.getPositionAt(endOffset);
        if (sp.lineNumber === ep.lineNumber) {
          const lineContent = model.getLineContent(sp.lineNumber);
          const before = lineContent.slice(0, sp.column - 1).trim();
          const after = lineContent.slice(ep.column - 1).trim();
          if (!before && !after) {
            // whole-line: skip inline highlight (viewzone shows the frame)
            continue;
          }
        }

        const innerStartPos = model.getPositionAt(innerStart);
        const innerEndPos = model.getPositionAt(innerEnd);
        newDecorations.push({
          range: new monaco.Range(
            innerStartPos.lineNumber, innerStartPos.column,
            innerEndPos.lineNumber, innerEndPos.column
          ),
          options: {
            inlineClassName: _pathClassName,
            hoverMessage: { value: innerPath.trim() },
          }
        });
        const openEnd = startOffset + 2;
        const openStartPos = model.getPositionAt(startOffset);
        const openEndPos = model.getPositionAt(openEnd);
        newDecorations.push({
          range: new monaco.Range(
            openStartPos.lineNumber, openStartPos.column,
            openEndPos.lineNumber, openEndPos.column
          ),
          options: { inlineClassName: _delimitersClassName }
        });
        const closeStart = endOffset - 2;
        const closeStartPos = model.getPositionAt(closeStart);
        const closeEndPos = model.getPositionAt(endOffset);
        newDecorations.push({
          range: new monaco.Range(
            closeStartPos.lineNumber, closeStartPos.column,
            closeEndPos.lineNumber, closeEndPos.column
          ),
          options: { inlineClassName: _delimitersClassName }
        });
      }
      localDecorationIds = ed.deltaDecorations(localDecorationIds, newDecorations);
    }

    let timer = null;
    const d1 = ed.onDidChangeModelContent(function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(localUpdate, 200);
    });
    const d2 = ed.onDidChangeModel(function () {
      localDecorationIds = [];
      setTimeout(localUpdate, 50);
    });
    _disposables.push(d1, d2);
    setTimeout(localUpdate, 30);
    console.log('[qqq-decoration] attached');
    return {
      refresh: localUpdate,
      dispose() {
        try { d1.dispose(); } catch {}
        try { d2.dispose(); } catch {}
        try { ed.deltaDecorations(localDecorationIds, []); } catch {}
      },
    };
  }

  function dispose() {
    _disposables.forEach(function (d) { d.dispose(); });
    _disposables = [];
    _decorationIds = [];
  }

  window.qqqDecoration = { init, attach, dispose };

  // rage service protocol
  window.qqqRageDecoration = {
    start: function (ctx) { init(); },
    stop: function () { dispose(); },
  };
})();
