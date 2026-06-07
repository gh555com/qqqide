// ============================================================================
// qoods/wysiwyg/wysiwyg.js
// Lightweight markdown WYSIWYG preview that renders alongside the active
// editor. Registers `qqq.wysiwyg.toggle` and a gaea panel.
// Pure renderer, no external deps. Solarized light styling.
// ============================================================================

(function () {
  'use strict';
  if (!globalThis.qoods) { console.warn('[wysiwyg] qoods shim missing'); return; }
  const Q = globalThis.qoods;

  // ---- Tiny markdown -> HTML ----------------------------------------------
  // Intentionally minimal subset: # h1..6, **bold**, *em*, `code`, ``` blocks,
  // - lists, > quotes, [text](url), images, paragraphs, hr.
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }
  function mdToHtml(md) {
    if (!md) { return ''; }
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // fenced code
      if (/^```/.test(line)) {
        let block = ''; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { block += lines[i] + '\n'; i++; }
        i++; html += '<pre><code>' + escapeHtml(block) + '</code></pre>';
        continue;
      }
      // hr
      if (/^---+\s*$/.test(line)) { html += '<hr/>'; i++; continue; }
      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; i++; continue; }
      // blockquote
      if (/^>\s?/.test(line)) {
        let block = '';
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          block += inline(lines[i].replace(/^>\s?/, '')) + '<br/>';
          i++;
        }
        html += '<blockquote>' + block + '</blockquote>';
        continue;
      }
      // ul
      if (/^\s*[-*]\s+/.test(line)) {
        let block = '<ul>';
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          block += '<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>';
          i++;
        }
        html += block + '</ul>';
        continue;
      }
      // ol
      if (/^\s*\d+\.\s+/.test(line)) {
        let block = '<ol>';
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          block += '<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>';
          i++;
        }
        html += block + '</ol>';
        continue;
      }
      // blank
      if (line.trim() === '') { i++; continue; }
      // paragraph (collect consecutive non-empty)
      let para = inline(line); i++;
      while (i < lines.length && lines[i].trim() !== '' && !/^(#|>|```|---|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) {
        para += '<br/>' + inline(lines[i]); i++;
      }
      html += '<p>' + para + '</p>';
    }
    return html;
  }

  // ---- Panel ---------------------------------------------------------------
  let host = null;
  let preview = null;
  let pollTimer = null;
  let lastRendered = '';

  function buildPanelInto(h) {
    host = h; host.innerHTML = '';
    host.style.cssText = 'height:100%; display:flex; flex-direction:column;';
    const bar = document.createElement('div');
    bar.style.cssText = 'flex:0 0 24px; padding:0 8px; display:flex; align-items:center; gap:8px;' +
      'border-bottom:1px solid var(--border-color); background:var(--background-color);' +
      'font-size:11px; color:var(--text-primary);';
    bar.textContent = 'WYSIWYG · auto preview';
    preview = document.createElement('div');
    preview.style.cssText = 'flex:1 1 auto; overflow:auto; padding:14px 16px;' +
      'background:var(--background-color); color:var(--text-primary); line-height:1.6; font-size:14px;' +
      'font-family: Tahoma,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;';
    host.appendChild(bar);
    host.appendChild(preview);
    startPolling();
  }

  function renderNow() {
    if (!preview || !window.qqqEditor) { return; }
    const md = window.qqqEditor.getValue() || '';
    if (md === lastRendered) { return; }
    lastRendered = md;
    preview.innerHTML = mdToHtml(md);
  }
  function startPolling() {
    if (pollTimer) { clearInterval(pollTimer); }
    pollTimer = setInterval(renderNow, 600);
    renderNow();
  }

  // Register as gaea panel
  if (window.qqqGaea) {
    window.qqqGaea.register({
      id: 'wysiwyg',
      title: 'WYSIWYG',
      render: (h) => buildPanelInto(h),
    });
  }

  Q.commands.register('wysiwyg.toggle', () => {
    if (window.qqqGaea) { window.qqqGaea.show('wysiwyg'); }
  });
  Q.commands.register('wysiwyg.refresh', () => { lastRendered = ''; renderNow(); });

  // [silent] wysiwyg ready
})();
