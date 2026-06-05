// ============================================================================
// ai-viewport.js - AI 视口组件
//
// 菜单栏 row-1 的横向豆腐块容器。每个豆腐块 = AI 能看到的一个项目文件夹。
// - 空态：虚线框 + "+"
// - 有项目：实线框 + 📁图标 + 文件夹名 + "−"
// - hover 项目块：展开该文件夹的目录树下拉（级联子目录向右展开）
// - hover "+" 块：展开最近 20 个主文件夹下拉（qgs global 持久化）
// - 单击目录树中任意项：附加到 AI 对话
// - 单击最近文件夹：在当前窗口添加（空窗口→主文件夹，有主文件夹→辅文件夹）
//
// 持久化层级: global(recent_folders) → project(editor tabs) → quest → floor → house → room
//
// API: window.qqqideViewport = { build, addProject, removeProject, getProjects, getMainProject }
// ============================================================================

(function () {
  'use strict';

  const bridge = window.qqqideBridge;

  // ---- state ----
  let projects = []; // [{path, name}]
  let container = null;
  let activeDropdown = null; // currently visible dropdown element
  let activeSubmenus = [];   // all open submenu elements

  // ---- module-level close timer (shared by dropdown + all submenus) ----
  let _closeTimer = null;
  let _activeBlockEl = null;
  let _hoverTimer = null;
  function cancelHover() { if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; } }
  let _dirCache = new Map(); // per-dropdown cache: key=dirPath, value=entries[]
  function scheduleClose() {
    cancelHover();
    if (_closeTimer) return; // already scheduled
    _closeTimer = setTimeout(() => {
      _closeTimer = null;
      closeDropdown();
      if (_activeBlockEl) { _activeBlockEl.classList.remove('aiv-block-active'); _activeBlockEl = null; }
    }, 500);
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

  var SKIP_DIRS = ['node_modules', '.git', 'logs', 'cache', 'temp', 'crashDumps', '.qoder', '.github'];

  async function listDir(p) {
    if (_dirCache.has(p)) return _dirCache.get(p);
    try {
      const entries = await bridge.fs.list(p);
      entries.sort((x, y) => {
        if (x.isDir !== y.isDir) return x.isDir ? -1 : 1;
        return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
      });
      _dirCache.set(p, entries);
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
      _shellHandle = window.qgs.ns('qqqide', { v: 1, form: 'doc' });
    }
    return _shellHandle;
  }

  // ---- recent folders (global, max 20, qgs persisted) ----
  var RECENT_KEY = 'recent_folders';
  var MAX_RECENT = 20;
  var _recentFolders = []; // [{path, name, atime}]

  function _loadRecents() {
    try {
      var s = _getShellHandle();
      if (s) {
        s.get(RECENT_KEY).then(function (data) {
          if (data && Array.isArray(data)) {
            _recentFolders = data.slice(0, MAX_RECENT);
          }
        }).catch(function () { });
      }
    } catch (_) { }
  }

  function _saveRecents() {
    try {
      var s = _getShellHandle();
      if (s) s.set(RECENT_KEY, _recentFolders).catch(function () { });
    } catch (_) { }
  }

  function _bumpRecent(folderPath) {
    var name = basename(folderPath);
    var now = Date.now();
    // 移除旧条目（若有）
    _recentFolders = _recentFolders.filter(function (f) { return f.path !== folderPath; });
    // 插入到最前
    _recentFolders.unshift({ path: folderPath, name: name, atime: now });
    // 截断到 MAX_RECENT
    if (_recentFolders.length > MAX_RECENT) _recentFolders.length = MAX_RECENT;
    _saveRecents();
  }

  // 异步校验主文件夹锁：若该项目已被其他窗口锁定，从视口移除
  // 仅在 ?folder= 新窗口场景使用，作为主进程锁检查的兜底
  function _verifyFolderLock(folderPath) {
    var lockPath = folderPath.replace(/\\/g, '/').replace(/\/$/, '') + '/qqq/alphal/.lock';
    // 延迟 2s 再检查，避开本窗口 bindMainProject 的锁写入
    setTimeout(function () {
      bridge.fs.stat(lockPath).then(function (statInfo) {
        if (!statInfo) return; // 锁文件不存在，安全
        return bridge.fs.read(lockPath).then(function (raw) {
          try {
            var data = JSON.parse(raw);
            var age = Date.now() - (data.atime || 0);
            // 锁有效且年龄 > 3s（避免误判本窗口刚写入的锁）→ 从视口移除
            if (age > 3000 && age < 60000) {
              console.warn('[ai-viewport] stale lock detected for ' + folderPath + ' (age=' + (age/1000).toFixed(1) + 's), removing from viewport');
              var idx = -1;
              for (var i = 0; i < projects.length; i++) {
                if (projects[i].path === folderPath) { idx = i; break; }
              }
              if (idx >= 0) {
                projects.splice(idx, 1);
                saveProjects();
                render();
                _notifyChanged();
              }
            }
          } catch (_) { }
        });
      }).catch(function () { /* 锁文件不存在 */ });
    }, 2000);
  }

  function loadProjects() {
    // 新窗口（?fresh=1）：强制清空，零项目
    if (window.location.search.indexOf('fresh=1') !== -1) {
      projects = [];
      // 若有 ?folder= 参数，自动添加为主文件夹
      var m = window.location.search.match(/[?&]folder=([^&]+)/);
      if (m) {
        try {
          var folderPath = decodeURIComponent(m[1]);
          if (folderPath) {
            // 先添加到 projects（同步，保证 UI 即时响应），然后异步校验锁
            projects.push({ path: folderPath, name: basename(folderPath) });
            _bumpRecent(folderPath);
            // 异步校验：若主文件夹被其他窗口锁定，立即移除
            _verifyFolderLock(folderPath);
          }
        } catch (_) { }
      }
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
            _notifyChanged();
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
    _dirCache.clear();
    if (activeDropdown) {
      activeDropdown.remove();
      activeDropdown = null;
    }
  }

  function closeAllSubmenus() {
    activeSubmenus.forEach(s => {
      if (s._parentRow) { s._parentRow.classList.remove('aiv-breadcrumb'); s._parentRow = null; }
      try { s.remove(); } catch (_) { }
    });
    activeSubmenus = [];
  }

  // Close a submenu and all its descendant submenus
  function closeSubmenuTree(sub) {
    if (!sub) return;
    if (sub._childSub) { closeSubmenuTree(sub._childSub); sub._childSub = null; }
    if (sub._parentRow) { sub._parentRow.classList.remove('aiv-breadcrumb'); sub._parentRow = null; }
    const idx = activeSubmenus.indexOf(sub);
    if (idx !== -1) activeSubmenus.splice(idx, 1);
    try { sub.remove(); } catch (_) { }
  }

  // ---- attach to AI: dispatch event + postMessage to AI iframe ----
  // ── AI 面板目标路由（自动跟焦）──
// -1=左僚机  0=主窗口(默认)  1=右僚机
window.__qqq_aiTarget = 0;

function _sendToWingman(filePath, index) {
  const sb = window.qqqideBridge && window.qqqideBridge.sync;
  if (sb) {
    sb.broadcast('host-message', {
      type: 'qqq-ai-attach',
      path: filePath,
      _targetWingman: index
    });
  }
}

function attachToAi(filePath) {
  console.log('[ai-viewport] attachToAi →', filePath, 'target=', window.__qqq_aiTarget);
  closeDropdown();

  const target = window.__qqq_aiTarget || 0;

  // ── 僚机目标：走 IPC sync ──
  if (target === -1 || target === 1) {
    _sendToWingman(filePath, target);
    return;
  }

  // ── 主窗口：直接发给 AI iframe ──
  const aiFrame = document.querySelector('#qqq-ai-zone iframe');
  if (!aiFrame || !aiFrame.contentWindow) {
    console.warn('[ai-viewport] no AI iframe found');
    return;
  }
  if (typeof aiFrame.contentWindow.qqqideAiAttach === 'function') {
    try {
      aiFrame.contentWindow.qqqideAiAttach(filePath);
      console.log('[ai-viewport] qqqideAiAttach OK →', filePath);
    } catch (e) {
      console.warn('[ai-viewport] qqqideAiAttach threw:', e);
    }
  } else {
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
      // Skip known-heavy directories to prevent OOM from hover-triggered listing
      if (ent.isDir && SKIP_DIRS.indexOf(ent.name) !== -1) continue;
      const row = document.createElement('div');
      row.className = 'aiv-dd-row';
      row.style.cssText =
        'display:flex; align-items:center; padding:4px 10px; cursor:pointer; ' +
        'font-size:14px; font-weight:600; color:var(--text-primary); white-space:nowrap; position:relative;';
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
        // Only close the CHILD submenu of this parent, not the parent itself
        if (parentEl._childSub) {
          closeSubmenuTree(parentEl._childSub);
          parentEl._childSub = null;
        }
        // if dir, expand submenu to the right (150ms debounce via shared _hoverTimer)
        if (ent.isDir) {
          cancelHover();
          _hoverTimer = setTimeout(() => {
            _hoverTimer = null;
            const sub = openSubmenu(row, pathJoin(dirPath, ent.name));
            parentEl._childSub = sub;
          }, 150);
        }
      });

      // mousedown — fires earlier than click, more reliable across nested popups.
      const onAttach = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const fullPath = pathJoin(dirPath, ent.name);
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

    // breadcrumb: mark the parent row so the path stays highlighted
    rowEl.classList.add('aiv-breadcrumb');
    sub._parentRow = rowEl;

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
      // 主文件夹不可删除，显示 ★ 标记
      rmBtn.textContent = '★';
      rmBtn.title = window._i('shell.viewport.mainFolder', '主文件夹（不可移除）');
      rmBtn.style.cssText = 'color:var(--yellow,#b58900);font-size:14px;cursor:default;font-weight:bold;';
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

    // hover → dropdown (150ms debounce: skip flicker when mouse zips across blocks)
    block.addEventListener('mouseenter', () => {
      cancelHover();
      _hoverTimer = setTimeout(() => { _hoverTimer = null; showDropdown(block, proj); }, 150);
    });
    block.addEventListener('mouseleave', () => { cancelHover(); });

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

    // click → 原生对话框选择新文件夹
    block.addEventListener('click', async (e) => {
      // 先关闭可能已打开的下拉（最近文件夹等），再弹出原生对话框
      closeDropdown();
      if (_activeBlockEl) { _activeBlockEl.classList.remove('aiv-block-active'); _activeBlockEl = null; }
      const result = await bridge.dialog.open({
        properties: ['openDirectory'],
        title: window._i('shell.viewport.selectFolder', '选择要添加到 AI 视口的文件夹'),
      });
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        addProject(result.filePaths[0]);
      }
    });

    // hover → 150ms 后展示最近 20 个主文件夹下拉
    block.addEventListener('mouseenter', () => {
      cancelHover();
      _hoverTimer = setTimeout(() => { _hoverTimer = null; _showRecentDropdown(block); }, 150);
    });
    block.addEventListener('mouseleave', () => { cancelHover(); });

    return block;
  }

  // ---- recent folders dropdown (hover "+" block) ----
  function _showRecentDropdown(blockEl) {
    closeDropdown();
    cancelClose();
    _activeBlockEl = blockEl;
    blockEl.classList.add('aiv-block-active');

    var rect = blockEl.getBoundingClientRect();
    var topPx = rect.bottom;
    var maxH = Math.max(200, window.innerHeight - topPx - 8);

    var dd = document.createElement('div');
    dd.className = 'aiv-dropdown aiv-recent-dropdown';
    dd.style.cssText =
      'position:fixed; z-index:99999; ' +
      'left:' + rect.left + 'px; top:' + topPx + 'px; ' +
      'min-width:280px; max-width:420px; height:' + maxH + 'px; overflow-y:auto; overflow-x:hidden; ' +
      'background:var(--card-bg); border:1px dashed var(--border-color); ' +
      'border-radius:3px; box-shadow:0 4px 16px rgba(0,0,0,.18); padding:4px 0;';

    // 标题行
    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'padding:6px 12px; font-size:11px; color:var(--text-muted); border-bottom:1px solid var(--border-color); margin-bottom:2px;';
    titleRow.textContent = window._i ? window._i('shell.viewport.recentFolders', '最近打开的主文件夹') : '最近打开的主文件夹';
    dd.appendChild(titleRow);

    if (_recentFolders.length === 0) {
      var emptyRow = document.createElement('div');
      emptyRow.style.cssText = 'padding:10px 12px; font-size:12px; color:var(--text-muted); font-style:italic;';
      emptyRow.textContent = window._i ? window._i('shell.viewport.noRecent', '暂无最近记录，点击 + 选择文件夹') : '暂无最近记录，点击 + 选择文件夹';
      dd.appendChild(emptyRow);
    } else {
      _recentFolders.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'aiv-row aiv-recent-row';
        row.style.cssText = 'padding:8px 12px; cursor:default; font-size:14px; font-weight:600; display:flex; align-items:center; gap:6px;';

        var icon = document.createElement('span');
        icon.textContent = '📁';
        icon.style.cssText = 'font-size:11px; flex-shrink:0;';

        var nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px;';
        nameSpan.textContent = truncName(f.name, 24);

        var pathSpan = document.createElement('span');
        pathSpan.style.cssText = 'color:var(--text-muted); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;';
        pathSpan.textContent = f.path;
        pathSpan.title = f.path;

        row.appendChild(icon);
        row.appendChild(nameSpan);
        row.appendChild(pathSpan);

        row.addEventListener('mousedown', function (e) {
          e.stopPropagation();
          e.preventDefault();
          closeDropdown();
          blockEl.classList.remove('aiv-block-active');
          _bumpRecent(f.path);
          // 在当前窗口添加：空窗口→主文件夹，有主文件夹→辅文件夹
          addProject(f.path);
        });

        dd.appendChild(row);
      });
    }

    document.body.appendChild(dd);
    activeDropdown = dd;

    blockEl.addEventListener('mouseleave', scheduleClose);
    blockEl.addEventListener('mouseenter', cancelClose);
    dd.addEventListener('mouseleave', scheduleClose);
    dd.addEventListener('mouseenter', cancelClose);
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

  // ---- notify: CustomEvent (same window) + postMessage (AI iframe) ----
  function _notifyChanged() {
    var detail = { projects: projects };
    // 同窗口订阅者（file-explorer 等）
    window.dispatchEvent(new CustomEvent('qqq-ai-viewport-changed', { detail: detail }));
    // AI iframe（跨 frame 通信必须用 postMessage）
    var aiFrame = document.querySelector('#qqq-ai-zone iframe');
    if (aiFrame && aiFrame.contentWindow) {
      try {
        aiFrame.contentWindow.postMessage({ type: 'qqq-ai-viewport-changed', projects: projects }, '*');
      } catch (_) { }
    }
  }

  // ---- public API ----
  function addProject(folderPath) {
    const name = basename(folderPath);
    // no duplicates
    if (projects.some(p => p.path === folderPath)) return;
    // 当视口为空时（即将成为主文件夹），异步校验锁
    if (projects.length === 0) {
      _verifyFolderLockBeforeAdd(folderPath, name);
    } else {
      _doAddProject(folderPath, name);
    }
  }

  function _doAddProject(folderPath, name) {
    projects.push({ path: folderPath, name: name });
    _bumpRecent(folderPath);
    saveProjects();
    render();
    _notifyChanged();
  }

  // 空视口添加主文件夹前的锁预检
  function _verifyFolderLockBeforeAdd(folderPath, name) {
    var lockPath = folderPath.replace(/\\/g, '/').replace(/\/$/, '') + '/qqq/alphal/.lock';
    bridge.fs.stat(lockPath).then(function (statInfo) {
      if (!statInfo) { _doAddProject(folderPath, name); return; }
      return bridge.fs.read(lockPath).then(function (raw) {
        try {
          var data = JSON.parse(raw);
          var age = Date.now() - (data.atime || 0);
          if (age < 60000) {
            // 锁有效 → 拒绝添加
            console.warn('[ai-viewport] lock pre-check failed for ' + folderPath + ' (age=' + (age/1000).toFixed(1) + 's)');
            if (window.qqqideQoast) {
              window.qqqideQoast.show('⚠️ 该项目已在另一个 QQQ 窗口中作为主文件夹打开', { duration: 6000, type: 'warn' });
            }
            return;
          }
          // 僵尸锁 → 允许添加
          _doAddProject(folderPath, name);
        } catch (_) { _doAddProject(folderPath, name); }
      });
    }).catch(function () { _doAddProject(folderPath, name); });
  }

  function removeProject(idx) {
    if (idx < 0 || idx >= projects.length) return;
    // 主文件夹（索引 0）不可删除
    if (idx === 0) {
      console.warn('[ai-viewport] cannot remove main project');
      return;
    }
    projects.splice(idx, 1);
    saveProjects();
    render();
    _notifyChanged();
  }

  function getProjects() { return projects.slice(); }

  function getMainProject() {
    return projects.length > 0 ? projects[0] : null;
  }

  function build(host) {
    container = host;
    container.className = 'aiv-container';
    _loadRecents();
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

    // 暴露更新函数供外部 focus 消息调用（由 shell/index.html 的 message 监听器调用）
    window.__qqq_updateAiTarget = function(newTarget) {
      window.__qqq_aiTarget = newTarget;
    };
  }

  // 监听 AI 面板发来的锁冲突通知：从视口移除被锁的项目
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'qqq-ai-viewport-remove-project' && e.data.path) {
      var p = e.data.path;
      var idx = -1;
      for (var i = 0; i < projects.length; i++) {
        if (projects[i].path === p) { idx = i; break; }
      }
      if (idx >= 0) {
        console.warn('[ai-viewport] lock conflict: removing project ' + p);
        projects.splice(idx, 1);
        saveProjects();
        render();
        _notifyChanged();
      }
    }
  });

  window.qqqideViewport = { build, addProject, removeProject, getProjects, getMainProject };
})();
