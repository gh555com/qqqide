// ============================================================================
// file-explorer.js - QOODS file explorer
//
// Sidebar tree view backed by window.qqq.fs.list().
// Click file -> qqqEditor.open(path)
// Lazy expand directories on click.
// ============================================================================

(function () {
  'use strict';

  const bridge = window.qqqBridge;

  // root = working dir of shell (set later via boot info)
  let root = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text != null) { e.textContent = text; }
    return e;
  }

  function pathJoin(a, b) {
    if (!a) return b;
    if (a.endsWith('/') || a.endsWith('\\')) { return a + b; }
    return a + (a.includes('\\') ? '\\' : '/') + b;
  }

  async function listDir(p) {
    try {
      const entries = await bridge.fs.list(p);
      // sort: dirs first, then alpha
      entries.sort((x, y) => {
        if (!!x.isDir !== !!y.isDir) { return x.isDir ? -1 : 1; }
        return String(x.name).localeCompare(String(y.name));
      });
      return entries;
    } catch (e) {
      console.error('[fx] list failed:', p, e);
      return [];
    }
  }

  async function expandNode(li, fullPath) {
    if (li._expanded) {
      const ul = li.querySelector(':scope > ul');
      if (ul) { ul.style.display = ''; }
      return;
    }
    li._expanded = true;
    const entries = await listDir(fullPath);
    const ul = el('ul', 'qqq-fx-children');
    ul.style.cssText = 'list-style:none; padding-left:14px; margin:0;';
    for (const ent of entries) {
      const child = makeNode(pathJoin(fullPath, ent.name), ent.name, ent.isDir);
      ul.appendChild(child);
    }
    li.appendChild(ul);
  }

  function collapseNode(li) {
    const ul = li.querySelector(':scope > ul');
    if (ul) { ul.style.display = 'none'; }
  }

  function makeNode(fullPath, name, isDir) {
    const li = el('li', 'qqq-fx-node');
    li.style.cssText = 'cursor:pointer; padding:1px 0; user-select:none;';
    const row = el('div', 'qqq-fx-row');
    row.style.cssText = 'display:flex; align-items:center; height:20px; padding:0 4px; border-radius:2px;';
    const icon = el('span', 'qqq-fx-icon', isDir ? '▶' : '·');
    icon.style.cssText = 'display:inline-block; width:14px; text-align:center; color:var(--base0); font-size:10px;';
    const label = el('span', 'qqq-fx-label', name);
    label.style.cssText = 'margin-left:4px; color:var(--text-primary); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    row.appendChild(icon);
    row.appendChild(label);
    li.appendChild(row);

    row.addEventListener('mouseenter', () => { row.style.background = 'var(--card-bg)'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });

    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isDir) {
        if (li._expanded) {
          const ul = li.querySelector(':scope > ul');
          const isHidden = ul && ul.style.display === 'none';
          if (isHidden) { ul.style.display = ''; icon.textContent = '▼'; }
          else { collapseNode(li); icon.textContent = '▶'; }
        } else {
          icon.textContent = '▼';
          await expandNode(li, fullPath);
        }
      } else {
        // file click -> open in tab group via custom event
        document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: fullPath } }));
      }
    });
    return li;
  }

  async function build(host, rootPath) {
    root = rootPath;
    host.innerHTML = '';

    // header
    const header = el('div', 'qqq-fx-header');
    header.style.cssText = 'padding:8px 10px; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-primary); border-bottom:1px solid var(--border-color); display:flex; align-items:center;';
    const hLabel = el('span', 'qqq-fx-header-label', 'EXPLORER');
    hLabel.style.flex = '1';
    const hPath = el('span', 'qqq-fx-header-path', shortPath(rootPath));
    hPath.style.cssText = 'font-size:10px; color:var(--base0); text-transform:none; letter-spacing:0; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    hPath.title = rootPath || '';
    header.appendChild(hLabel);
    header.appendChild(hPath);
    host.appendChild(header);

    // tree container
    const treeWrap = el('div', 'qqq-fx-tree');
    treeWrap.style.cssText = 'overflow:auto; padding:6px 4px; height:calc(100% - 36px);';
    const ul = el('ul');
    ul.style.cssText = 'list-style:none; margin:0; padding:0;';
    const rootNode = makeNode(rootPath, shortPath(rootPath) || '(root)', true);
    rootNode._expanded = true;
    const rootIcon = rootNode.querySelector('.qqq-fx-icon');
    if (rootIcon) { rootIcon.textContent = '▼'; }
    const childrenUl = el('ul', 'qqq-fx-children');
    childrenUl.style.cssText = 'list-style:none; padding-left:14px; margin:0;';
    rootNode.appendChild(childrenUl);
    const entries = await listDir(rootPath);
    for (const ent of entries) {
      childrenUl.appendChild(makeNode(pathJoin(rootPath, ent.name), ent.name, ent.isDir));
    }
    ul.appendChild(rootNode);
    treeWrap.appendChild(ul);
    host.appendChild(treeWrap);
  }

  function shortPath(p) {
    if (!p) return '';
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }

  window.qqqFileExplorer = { build };
})();
