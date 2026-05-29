// ============================================================================
// ai-viewport.js - AI 视口组件
//
// 菜单栏 row-1 的横向豆腐块容器。每个豆腐块 = AI 能看到的一个项目文件夹。
// - 空态：虚线框 + "+"
// - 有项目：实线框 + 📁图标 + 文件夹名 + "−"
// - hover：展开该文件夹的目录树下拉（级联子目录向右展开）
// - 单击目录树中任意项：附加到 AI 对话
//
// API: window.qqqAiViewport = { build, addProject, removeProject, getProjects, getMainProject }
// ============================================================================

(function () {
  'use strict';

  const bridge = window.qqqBridge;

  // ---- state ----
  let projects = []; // [{path, name}]
  let container = null;
  let activeDropdown = null; // currently visible dropdown element
  let activeSubmenus = [];   // all open submenu elements

  // ---- module-level close timer (shared by dropdown + all submenus) ----
  let _closeTimer = null;
  let _activeBlockEl = null;
  function scheduleClose() {
    if (_closeTimer) return; // already scheduled
    _closeTimer = setTimeout(() => {
      _closeTimer = null;
      closeDropdown();
      if (_activeBlockEl) { _activeBlockEl.classList.remove('aiv-block-active'); _activeBlockEl = null; }
    }, 2000);
  }
  function cancelClose() {
    if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
  }

  // ---- helpers ----
  function basename(p) {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || p;
  }

  function truncName(name, max) {
    max = max || 22;
    return name.length > max ? name.slice(0, max) + '…' : name;
  }

  function pathJoin(a, b) {
    if (!a) return b;
    if (a.endsWith('/') || a.endsWith('\\')) return a + b;
    return a + (a.includes('\\') ? '\\' : '/') + b;
  }

  async function listDir(p) {
    try {
      const entries = await bridge.fs.list(p);
      entries.sort((x, y) => {
        if (!!x.isDir !== !!y.isDir) return x.isDir ? -1 : 1;
        return String(x.name).localeCompare(String(y.name));
      });
      return entries;
    } catch (e) {
      return [];
    }
  }

  // ---- persist (localStorage — fast sync; qgs backup on unload) ----
  var STORAGE_KEY = 'qqq-ai-viewport-projects';
  var _shellHandle = null;  // cached — NEVER call qgs.ns() more than once

  function _getShellHandle() {
    if (_shellHandle) return _shellHandle;
    if (window.qgs && typeof window.qgs.ns === 'function') {
      _shellHandle = window.qgs.ns('qqq.shell', { v: 1, form: 'doc' });
    }
    return _shellHandle;
  }

  function loadProjects() {
    // 新窗口（?fresh=1）：强制清空，零项目
    if (window.location.search.indexOf('fresh=1') !== -1) {
      projects = [];
      return;
    }
    // 优先从 qgs 全局 SQLite 加载（跨重启）
    try {
      var s = _getShellHandle();
      if (s) {
        s.get('ai_viewport_projects').then(function (data) {
          if (data && Array.isArray(data) && data.length > 0) {
            projects = data;
            render();
            window.dispatchEvent(new CustomEvent('qqq-ai-viewport-changed', { detail: { projects } }));
          }
        }).catch(function () { });
      }
    } catch (_) { }
    // 同步回退：localStorage
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { var parsed = JSON.parse(raw); if (parsed.length > 0) projects = parsed; }
    } catch (_) { }
  }
  function saveProjects() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); } catch (_) { }
  }
  // 窗口关闭前写入 qgs 全局快照（跨重启恢复）
  window.addEventListener('beforeunload', function () {
    try {
      if (projects.length > 0) {
        var s = _getShellHandle();
        if (s) s.setNow('ai_viewport_projects', projects).catch(function () { });
      }
    } catch (_) { }
  });
  // ---- close active dropdown ----
  function closeDropdown() {
    closeAllSubmenus();
    if (activeDropdown) {
      activeDropdown.remove();
      activeDropdown = null;
    }
  }

  function closeAllSubmenus() {
    activeSubmenus.forEach(s => { try { s.remove(); } catch (_) { } });
    activeSubmenus = [];
  }

  // Close a submenu and all its descendant submenus
  function closeSubmenuTree(sub) {
    if (!sub) return;
    if (sub._childSub) { closeSubmenuTree(sub._childSub); sub._childSub = null; }
    const idx = activeSubmenus.indexOf(sub);
    if (idx !== -1) activeSubmenus.splice(idx, 1);
    try { sub.remove(); } catch (_) { }
  }

  // ---- attach to AI: dispatch event + postMessage to AI iframe ----
  function attachToAi(filePath) {
    console.log('[ai-viewport] attachToAi called with →', filePath);
    closeDropdown();
    // Direct cross-frame call (same origin, most reliable)
    const aiFrame = document.querySelector('#qqq-ai-zone iframe');
    if (!aiFrame || !aiFrame.contentWindow) {
      console.warn('[ai-viewport] no AI iframe found');
      return;
    }
    if (typeof aiFrame.contentWindow.qqqAiAttach === 'function') {
      try {
        aiFrame.contentWindow.qqqAiAttach(filePath);
        console.log('[ai-viewport] qqqAiAttach OK →', filePath);
      } catch (e) {
        console.warn('[ai-viewport] qqqAiAttach threw:', e);
      }
    } else {
      // Fallback: postMessage
      aiFrame.contentWindow.postMessage({ type: 'qqq-ai-attach', path: filePath }, '*');
      console.log('[ai-viewport] postMessage fallback →', filePath);
    }
  }

  // ---- render: directory tree dropdown ----
  function showDropdown(blockEl, project) {
    closeDropdown();
    cancelClose();
    _activeBlockEl = blockEl;

    const rect = blockEl.getBoundingClientRect();
    const dd = document.createElement('div');
    dd.className = 'aiv-dropdown';
    // Fill maximum vertical space: from below block to bottom of viewport (minus 8px margin)
    const topPx = rect.bottom;
    const maxH = Math.max(200, window.innerHeight - topPx - 8);
    dd.style.cssText =
      'position:fixed; z-index:99999; ' +
      'left:' + rect.left + 'px; top:' + topPx + 'px; ' +
      'min-width:240px; max-width:360px; height:' + maxH + 'px; overflow-y:auto; overflow-x:hidden; ' +
      'background:var(--card-bg); border:1px dashed var(--border-color); ' +
      'border-radius:3px; box-shadow:0 4px 16px rgba(0,0,0,.18); padding:4px 0;';

    // wrap the block + dropdown in a visual dashed frame
    blockEl.classList.add('aiv-block-active');

    loadDirInto(dd, project.path);
    document.body.appendChild(dd);
    activeDropdown = dd;

    // Use module-level timer: mouse in block/dropdown cancels, mouse out schedules
    blockEl.addEventListener('mouseleave', scheduleClose);
    blockEl.addEventListener('mouseenter', cancelClose);
    dd.addEventListener('mouseleave', scheduleClose);
    dd.addEventListener('mouseenter', cancelClose);
  }

  function fileIconFor(name, isDir) {
    if (isDir) return '📁';
    const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = m ? m[1] : '';
    if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'ape'].indexOf(ext) !== -1) return '🎵';
    if (['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', '3gp'].indexOf(ext) !== -1) return '🎬';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'avif'].indexOf(ext) !== -1) return '🖼️';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2'].indexOf(ext) !== -1) return '📦';
    if (['pdf'].indexOf(ext) !== -1) return '📕';
    if (['doc', 'docx', 'rtf'].indexOf(ext) !== -1) return '📘';
    if (['xls', 'xlsx', 'csv'].indexOf(ext) !== -1) return '📗';
    if (['ppt', 'pptx'].indexOf(ext) !== -1) return '📙';
    if (['exe', 'msi', 'dll'].indexOf(ext) !== -1) return '⚙️';
    return '📄';
  }

  async function loadDirInto(parentEl, dirPath) {
    const entries = await listDir(dirPath);
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:6px 12px; color:var(--base1); font-size:11px;';
      empty.textContent = '(空)';
      parentEl.appendChild(empty);
      return;
    }
    for (const ent of entries) {
      const row = document.createElement('div');
      row.className = 'aiv-dd-row';
      row.style.cssText =
        'display:flex; align-items:center; padding:3px 10px; cursor:pointer; ' +
        'font-size:12px; color:var(--text-primary); white-space:nowrap; position:relative;';
      const icon = document.createElement('span');
      icon.textContent = fileIconFor(ent.name, ent.isDir);
      icon.style.cssText = 'margin-right:6px; font-size:11px;';
      const label = document.createElement('span');
      label.textContent = ent.name;
      label.style.cssText = 'overflow:hidden; text-overflow:ellipsis;';
      if (ent.isDir) {
        const arrow = document.createElement('span');
        arrow.textContent = '›';
        arrow.style.cssText = 'margin-left:auto; padding-left:8px; color:var(--base1);';
        row.appendChild(icon); row.appendChild(label); row.appendChild(arrow);
      } else {
        row.appendChild(icon); row.appendChild(label);
      }

      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--background-color)';
        // Only close the CHILD submenu of this parent, not the parent itself
        if (parentEl._childSub) {
          closeSubmenuTree(parentEl._childSub);
          parentEl._childSub = null;
        }
        // if dir, expand submenu to the right
        if (ent.isDir) {
          const sub = openSubmenu(row, pathJoin(dirPath, ent.name));
          parentEl._childSub = sub;
        }
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = '';
      });

      // mousedown — fires earlier than click, more reliable across nested popups.
      // capture: true ensures we always see it before any descendant.
      const onAttach = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const fullPath = pathJoin(dirPath, ent.name);
        console.log('[ai-viewport] row mousedown →', fullPath, '(isDir=' + ent.isDir + ')');
        attachToAi(fullPath);
      };
      row.addEventListener('mousedown', onAttach);
      // Also keep click as a safety net
      row.addEventListener('click', (e) => { e.stopPropagation(); });

      parentEl.appendChild(row);
    }
  }

  function openSubmenu(rowEl, dirPath) {
    const sub = document.createElement('div');
    sub.className = 'aiv-submenu';
    // position to the right of the row
    const rect = rowEl.getBoundingClientRect();
    // Fill maximum vertical space: from row top down to viewport bottom
    const topPx = rect.top;
    const maxH = Math.max(200, window.innerHeight - topPx - 8);
    sub.style.cssText =
      'position:fixed; z-index:100000; ' +
      'min-width:220px; max-width:340px; height:' + maxH + 'px; overflow-y:auto; overflow-x:hidden; ' +
      'background:var(--card-bg); border:1px solid var(--border-color); ' +
      'border-radius:3px; box-shadow:0 4px 12px rgba(0,0,0,.15); padding:4px 0;';
    sub.style.left = rect.right + 'px';
    sub.style.top = topPx + 'px';

    // Submenus also participate in the shared close timer
    sub.addEventListener('mouseenter', cancelClose);
    sub.addEventListener('mouseleave', scheduleClose);

    document.body.appendChild(sub);
    activeSubmenus.push(sub);
    loadDirInto(sub, dirPath);
    return sub;
  }

  // ---- render: blocks ----
  function render() {
    if (!container) return;
    container.innerHTML = '';

    // each existing project → solid block
    projects.forEach((proj, idx) => {
      const block = createBlock(proj, idx);
      container.appendChild(block);
    });

    // trailing "add" block (dashed)
    container.appendChild(createAddBlock());
  }

  function createBlock(proj, idx) {
    const block = document.createElement('div');
    block.className = 'aiv-block aiv-block-filled';
    block.title = proj.path;

    const icon = document.createElement('span');
    icon.textContent = '📁';
    icon.style.cssText = 'font-size:11px; margin-right:4px;';

    const name = document.createElement('span');
    name.className = 'aiv-block-name';
    name.textContent = truncName(proj.name);

    const rmBtn = document.createElement('span');
    rmBtn.className = 'aiv-block-rm';
    if (idx === 0) {
      // 主文件夹不可删除
      rmBtn.title = window._i('shell.viewport.mainFolder', '主文件夹（不可移除）');
      rmBtn.style.opacity = '0.3';
      rmBtn.style.cursor = 'not-allowed';
    } else {
      rmBtn.textContent = '−';
      rmBtn.title = window._i('shell.viewport.removeProject', '移除此项目');
      rmBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmRemove(proj);
        if (ok) {
          removeProject(idx);
        }
      });
    }

    block.appendChild(icon);
    block.appendChild(name);
    block.appendChild(rmBtn);

    // hover → dropdown
    block.addEventListener('mouseenter', () => {
      showDropdown(block, proj);
    });

    return block;
  }

  function createAddBlock() {
    const block = document.createElement('div');
    block.className = 'aiv-block aiv-block-empty';
    block.title = window._i('shell.viewport.addProject', '添加项目文件夹到 AI 视口');

    const plus = document.createElement('span');
    plus.className = 'aiv-block-plus';
    plus.textContent = '+';

    block.appendChild(plus);

    block.addEventListener('click', async () => {
      const result = await bridge.dialog.open({
        properties: ['openDirectory'],
        title: window._i('shell.viewport.selectFolder', '选择要添加到 AI 视口的文件夹'),
      });
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        addProject(result.filePaths[0]);
      }
    });

    return block;
  }

  async function confirmRemove(proj) {
    try {
      const r = await bridge.dialog.message({
        type: 'question',
        title: '移除项目',
        message: `确定从 AI 视口移除「${proj.name}」？`,
        detail: proj.path,
        buttons: ['移除', '取消'],
        defaultId: 1,
        cancelId: 1,
      });
      return r && r.response === 0;
    } catch (_) {
      return confirm(`移除「${proj.name}」？`);
    }
  }

  // ---- public API ----
  function addProject(folderPath) {
    const name = basename(folderPath);
    // no duplicates
    if (projects.some(p => p.path === folderPath)) return;
    projects.push({ path: folderPath, name: name });
    saveProjects();
    render();
    // notify file explorer to rebuild
    window.dispatchEvent(new CustomEvent('qqq-ai-viewport-changed', { detail: { projects } }));
  }

  function removeProject(idx) {
    if (idx < 0 || idx >= projects.length) return;
    projects.splice(idx, 1);
    saveProjects();
    render();
    window.dispatchEvent(new CustomEvent('qqq-ai-viewport-changed', { detail: { projects } }));
  }

  function getProjects() { return projects.slice(); }

  function getMainProject() {
    return projects.length > 0 ? projects[0] : null;
  }

  function build(host) {
    container = host;
    container.className = 'aiv-container';
    loadProjects();
    render();
    // close dropdown when clicking outside
    document.addEventListener('mousedown', (e) => {
      if (!activeDropdown) return;
      if (activeDropdown.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.aiv-block')) return;
      // Submenu rows are sibling divs in body — treat them as inside-dropdown too
      if (e.target.closest && e.target.closest('.aiv-submenu')) return;
      closeDropdown();
      document.querySelectorAll('.aiv-block-active').forEach(el => el.classList.remove('aiv-block-active'));
    });
  }

  window.qqqAiViewport = { build, addProject, removeProject, getProjects, getMainProject };
})();
