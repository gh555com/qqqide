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

  // ---- module-level state (dropdown stays forever until explicit dismiss) ----
  let _activeBlockEl = null;
  let _dirCache = new Map(); // per-dropdown cache: key=dirPath, value=entries[]
  let _hoverTimer = null;
  function cancelHover() { if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; } }

  // ---- 树展开快照：每个顶层文件夹记住关闭前的完整路径链 ----
  var _treeSnapshots = {}; // projectPath → [relPath1, relPath2, ...]
  // relPath = dirPath.substring(projectRoot.length)，如 ["src", "src/app", "src/app/components"]

  // 原生滚动条由 qh 真理机器接管隐藏，此处不再注入

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

  // ★ 中部截断（字符位宽）：首部占剩余空间，尾部固定 N 字符，省略号置中
  // 用字符数而非字节数——字节宽度未可预测（ASCII=1b, 中文=3b, 同字节数宽度差3倍）
  function truncMiddle(name, maxLen, tailChars) {
    maxLen = maxLen || 26;
    tailChars = tailChars || 12; // 覆盖 .configtion .config.js 等长后缀
    if (name.length <= maxLen) return name;
    var headLen = maxLen - tailChars - 1; // -1 为「…」
    if (headLen < 2) headLen = 2;
    var head = name.slice(0, headLen);
    var tail = name.slice(-tailChars);
    return head + '…' + tail;
  }

  function pathJoin(a, b) {
    if (!a) return b;
    if (a.endsWith('/') || a.endsWith('\\')) return a + b;
    return a + (a.includes('\\') ? '\\' : '/') + b;
  }

  var SKIP_DIRS = ['node_modules', '.git'];

  // ★ 自然排序：数字部分按数值比较，非数字部分按字符串比较
  //   如 q1 < q2 < q10 < q11（而非字典序 q1 < q10 < q11 < q2）
  function naturalCompare(a, b) {
    var re = /(\d+)|(\D+)/g;
    var aParts = String(a).match(re) || [];
    var bParts = String(b).match(re) || [];
    var maxLen = Math.max(aParts.length, bParts.length);
    for (var i = 0; i < maxLen; i++) {
      var ap = aParts[i] || '';
      var bp = bParts[i] || '';
      var aNum = parseInt(ap, 10);
      var bNum = parseInt(bp, 10);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        if (aNum !== bNum) return aNum - bNum;
      } else {
        if (ap !== bp) return ap < bp ? -1 : 1;
      }
    }
    return 0;
  }

  var CACHE_TTL = 10000;  // 缓存 10 秒后过期，下次 hover 重新读盘
  async function listDir(p) {
    var cached = _dirCache.get(p);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.entries;
    try {
      const entries = await bridge.fs.list(p);
      entries.sort((x, y) => {
        if (x.isDir !== y.isDir) return x.isDir ? -1 : 1;
        return naturalCompare(x.name, y.name);
      });
      _dirCache.set(p, { entries, ts: Date.now() });
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
  var _recentsReady = null; // Promise — resolve 后 _recentFolders 才是真实数据

  function _loadRecents() {
    _recentsReady = new Promise(function (resolve) {
      try {
        var s = _getShellHandle();
        if (s) {
          s.get(RECENT_KEY).then(function (data) {
            if (data && Array.isArray(data)) {
              // 去重：同 path 只保留第一条
              var seen = {};
              _recentFolders = [];
              for (var i = 0; i < data.length && _recentFolders.length < MAX_RECENT; i++) {
                var p = (data[i].path || '').replace(/\\/g, '/').replace(/\/$/, '');
                if (seen[p]) continue;
                seen[p] = true;
                _recentFolders.push(data[i]);
              }
            }
            resolve();
          }).catch(function () { resolve(); });
        } else { resolve(); }
      } catch (_) { resolve(); }
    });
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
    // ★ 必须先等 load 完成，否则 _saveRecents 会用空数组覆盖 global.sq3
    var ready = _recentsReady || Promise.resolve();
    ready.then(function () {
      _recentFolders = _recentFolders.filter(function (f) { return f.path !== folderPath; });
      _recentFolders.unshift({ path: folderPath, name: name, atime: now });
      if (_recentFolders.length > MAX_RECENT) _recentFolders.length = MAX_RECENT;
      _saveRecents();
    }).catch(function () { });
  }

  // ★ restore 模式：从 qgs 读取窗口快照，还原辅文件夹
  function _restoreFromSnapshot(folderPath) {
    var key = 'win_snap:' + folderPath.replace(/\\/g, '/').replace(/\/$/, '');
    try {
      var s = _getShellHandle();
      if (s) {
        s.get(key).then(function (snap) {
          if (!snap || !snap.auxFolders || !Array.isArray(snap.auxFolders)) return;
          for (var i = 0; i < snap.auxFolders.length; i++) {
            var aux = snap.auxFolders[i];
            if (!projects.some(function (p) { return p.path === aux; })) {
              projects.push({ path: aux, name: basename(aux) });
            }
          }
          saveProjects();
          render();
          _notifyChanged();
        }).catch(function () { });
      }
    } catch (_) { }
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
              console.warn('[ai-viewport] stale lock detected for ' + folderPath + ' (age=' + (age / 1000).toFixed(1) + 's), removing from viewport');
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

  // ★ 项目持久化 key：per-mainFolder 隔离，防多窗口互相覆盖
  var PROJ_KEY_BASE = 'ai_viewport:';
  function _projKey() {
    if (projects.length > 0 && projects[0].path) {
      return PROJ_KEY_BASE + projects[0].path.replace(/\\/g, '/').replace(/\/$/, '');
    }
    return null;
  }

  function loadProjects() {
    // 新窗口（?fresh=1）：强制清空，零项目
    if (window.location.search.indexOf('fresh=1') !== -1) {
      projects = [];
      var m = window.location.search.match(/[?&]folder=([^&]+)/);
      if (m) {
        try {
          var folderPath = decodeURIComponent(m[1]);
          if (folderPath) {
            projects.push({ path: folderPath, name: basename(folderPath) });
            _bumpRecent(folderPath);
            _verifyFolderLock(folderPath);
          }
        } catch (_) { }
      }
      return;
    }
    // ★ restore 模式（?restore=1&folder=xxx）：读 per-mainFolder key
    if (window.location.search.indexOf('restore=1') !== -1) {
      projects = [];
      var rm = window.location.search.match(/[?&]folder=([^&]+)/);
      if (rm) {
        try {
          var rFolderPath = decodeURIComponent(rm[1]);
          if (rFolderPath) {
            projects.push({ path: rFolderPath, name: basename(rFolderPath) });
            _bumpRecent(rFolderPath);
            _verifyFolderLock(rFolderPath);
            // ★ 从 per-mainFolder key 恢复（含辅文件夹）
            _restoreFromProjKey(rFolderPath);
            // 同时走 win_snap 兜底（兼容旧数据）
            _restoreFromSnapshot(rFolderPath);
          }
        } catch (_) { }
      }
      render();
      _notifyChanged();
      return;
    }
    // 同步回退：localStorage（首次启动或无主文件夹时）
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { var parsed = JSON.parse(raw); if (parsed.length > 0) projects = parsed; }
    } catch (_) { }
  }

  // ★ 从 per-mainFolder key 恢复辅文件夹（跨窗口跨重启）
  function _restoreFromProjKey(mainFolderPath) {
    var key = PROJ_KEY_BASE + mainFolderPath.replace(/\\/g, '/').replace(/\/$/, '');
    try {
      var s = _getShellHandle();
      if (s) {
        s.get(key).then(function (data) {
          if (!data || !Array.isArray(data) || data.length < 2) return;
          // data[0] 是主文件夹（跳过），data[1..] 是辅文件夹
          for (var i = 1; i < data.length; i++) {
            var aux = data[i];
            var auxPath = typeof aux === 'string' ? aux : aux.path;
            if (!projects.some(function (p) { return p.path === auxPath; })) {
              projects.push({ path: auxPath, name: basename(auxPath) });
            }
          }
          saveProjects();
          render();
          _notifyChanged();
        }).catch(function () { });
      }
    } catch (_) { }
  }

  function saveProjects() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); } catch (_) { }
    // ★ 写入 per-mainFolder key（多窗口隔离）
    try {
      var pk = _projKey();
      if (pk && projects.length > 0) {
        var s = _getShellHandle();
        if (s) s.set(pk, projects).catch(function () { });
      }
    } catch (_) { }
  }
  // 窗口关闭前兜底写入（防崩溃丢失）
  window.addEventListener('beforeunload', function () {
    try {
      var s = _getShellHandle();
      if (s) {
        var pk = _projKey();
        if (pk && projects.length > 0) s.setNow(pk, projects).catch(function () { });
        if (_recentFolders.length > 0) s.setNow(RECENT_KEY, _recentFolders).catch(function () { });
      }
    } catch (_) { }
  });
  // ---- close active dropdown: save snapshot then destroy ----
  function closeDropdown() {
    // ★ 关闭前快照：将当前展开路径链存入 _treeSnapshots
    if (activeDropdown && activeDropdown._projectRoot) {
      if (activeDropdown._expandedChain && activeDropdown._expandedChain.length > 0) {
        _treeSnapshots[activeDropdown._projectRoot] = activeDropdown._expandedChain.slice();
      }
    }
    cancelHover();
    closeAllSubmenus();
    if (activeDropdown) {
      activeDropdown.remove();
      activeDropdown = null;
    }
    if (_activeBlockEl) { _activeBlockEl.classList.remove('aiv-block-active'); _activeBlockEl = null; }
    // ★ 关闭遮罩 + 恢复 iframe 点击（两种下拉共用）
    _aivRemoveBackdrop();
    _setAiIframesPointerEvents('');
  }

  // ---- 透明遮罩：铺满菜单栏以下区域，拦截点击关闭下拉 ----
  var _aivBackdrop = null;
  function _aivEnsureBackdrop() {
    if (_aivBackdrop) return;
    _aivBackdrop = document.createElement('div');
    _aivBackdrop.style.cssText = 'position:fixed; left:0; right:0; bottom:0; z-index:99998; background:transparent;';
    _aivBackdrop.style.top = (container ? container.getBoundingClientRect().bottom : 32) + 'px';
    _aivBackdrop.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      closeDropdown();
    });
    document.body.appendChild(_aivBackdrop);
  }
  function _aivRemoveBackdrop() {
    if (_aivBackdrop) { _aivBackdrop.remove(); _aivBackdrop = null; }
  }

  function closeAllSubmenus() {
    activeSubmenus.forEach(s => {
      if (s._parentRow) { s._parentRow.classList.remove('aiv-breadcrumb'); s._parentRow = null; }
      try { s.remove(); } catch (_) { }
    });
    activeSubmenus = [];
  }

  // ★ 飞块动画：左键点击后，小矩形从点击位置飞到目标 AI 面板底部键入区
  var _flyBlock = null;
  function _animateFlyToPanel(rowEl, targetPanelId) {
    // 取消上一次动画
    if (_flyBlock) { _flyBlock.remove(); _flyBlock = null; }
    var srcRect = rowEl.getBoundingClientRect();
    if (srcRect.width === 0 && srcRect.height === 0) return;
    // 目标面板
    var zoneId = targetPanelId === 0 ? 'qqq-wing-left' : targetPanelId === 2 ? 'qqq-wing-right' : 'qqq-ai-zone';
    var zone = document.getElementById(zoneId);
    if (!zone) return;
    var dstRect = zone.getBoundingClientRect();
    if (dstRect.width === 0 || dstRect.height === 0) return;
    // 目标 Y：面板底部键入框区域（距底部 ~60px）
    var dstX = dstRect.left + dstRect.width / 2;
    var dstY = dstRect.bottom - 60;
    // 创建飞块
    var block = document.createElement('div');
    var startW = Math.round(srcRect.width * 0.55);
    var startH = Math.round(srcRect.height * 0.5);
    block.style.cssText =
      'position:fixed; z-index:999999; pointer-events:none; ' +
      'background:var(--yellow,#b58900); border-radius:2px; ' +
      'width:' + startW + 'px; height:' + startH + 'px; ' +
      'left:' + srcRect.left + 'px; top:' + srcRect.top + 'px; ' +
      'transition:left 0.32s cubic-bezier(0.25,0.46,0.45,0.94), ' +
      'top 0.32s cubic-bezier(0.25,0.46,0.45,0.94), ' +
      'width 0.32s cubic-bezier(0.25,0.46,0.45,0.94), ' +
      'height 0.32s cubic-bezier(0.25,0.46,0.45,0.94); ' +
      'opacity:0.95;';
    document.body.appendChild(block);
    _flyBlock = block;
    // 下一帧触发位移+缩放
    requestAnimationFrame(function () {
      block.style.left = (dstX - 12) + 'px';   // 终点 24×14
      block.style.top = (dstY - 7) + 'px';
      block.style.width = '24px';
      block.style.height = '14px';
    });
    // 前 260ms 保持不透明，最后 60ms 淡出消失
    setTimeout(function () {
      if (_flyBlock !== block) return;
      block.style.transition = 'opacity 0.06s ease-out';
      block.style.opacity = '0';
    }, 260);
    // 动画结束后清理
    setTimeout(function () {
      if (_flyBlock === block) { block.remove(); _flyBlock = null; }
    }, 380);
  }

  // ★ 冻结/恢复 AI iframe 点击：打开下拉时切断 iframe 交互，点击透传到遮罩
  function _setAiIframesPointerEvents(val) {
    var zones = ['qqq-wing-left', 'qqq-ai-zone', 'qqq-wing-right'];
    for (var i = 0; i < zones.length; i++) {
      var zone = document.getElementById(zones[i]);
      if (!zone) continue;
      var iframe = zone.querySelector('iframe');
      if (iframe) {
        iframe.style.pointerEvents = val;
      }
    }
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

  // ---- attach to AI: 路由到当前焦点面板（金色 q2 的面板）----
  // ★ 唯一真理喂 AI 管线：编辑器右键/视口左键 均走此入口
  //   参数：filePath 必填，isDir 可选（默认自动判断），lineRange 可选（如 "L15-L18"）
  //   将来要改目标面板路由/格式，只改这一处
  function _feedToAiPanel(filePath, isDir, lineRange) {
    if (typeof isDir !== 'boolean') {
      isDir = !filePath.match(/\.[a-zA-Z0-9]+$/);
    }
    var target = typeof window.__qqq_aiTarget === 'number' ? window.__qqq_aiTarget : 1;
    var zoneId = target === 0 ? 'qqq-wing-left' : target === 2 ? 'qqq-wing-right' : 'qqq-ai-zone';
    var zone = document.getElementById(zoneId);
    var aiFrame = zone ? zone.querySelector('iframe') : null;
    if (!aiFrame || !aiFrame.contentWindow) {
      aiFrame = document.querySelector('#qqq-ai-zone iframe');
      if (!aiFrame || !aiFrame.contentWindow) return;
    }
    if (typeof aiFrame.contentWindow.qqqideAiAttach === 'function') {
      try {
        aiFrame.contentWindow.qqqideAiAttach(filePath, isDir, lineRange || null);
      } catch (e) { console.warn('[ai-viewport] feedToAi error:', e); }
    } else {
      aiFrame.contentWindow.postMessage({
        type: 'qqq-ai-attach', path: filePath, isDir: isDir,
        lineRange: lineRange || null
      }, '*');
    }
  }
  window.__qqq_aiFeedFile = _feedToAiPanel;

  function attachToAi(filePath, isDir) {
    _feedToAiPanel(filePath, isDir, null);
  }

  // ---- 滚动容器包装：外层不滚 + 自定义变形滚动条（照抄 q3 Roam）----
  function _wrapScrollContainer(outer, depth) {
    // 外层禁止滚动（覆盖 CSS !important）
    outer.style.setProperty('overflow-y', 'hidden', 'important');
    outer.style.setProperty('overflow-x', 'hidden', 'important');
    var inner = document.createElement('div');
    inner.className = 'aiv-scroll-inner';
    inner.style.cssText = 'width:100%; height:100%; overflow-y:auto; overflow-x:hidden; ' +
      'scrollbar-width:none; -ms-overflow-style:none;';
    inner._depth = depth;
    inner._direction = outer._direction; // 方向决策需要
    inner._outer = outer;
    outer._scroll = inner;
    // 点击列表空白处 → 关闭当前列表弹出滴下级子菜单
    inner.addEventListener('click', function (e) {
      if (e.target !== inner) return;
      if (outer._childSub) { closeSubmenuTree(outer._childSub); outer._childSub = null; }
    });

    // ★ 自定义变形滚动条（滑轨锚定在外层，同步内层滚动）
    var sbOuter = document.createElement('div');
    sbOuter.className = 'qh-scroll-track';
    sbOuter.style.cssText = 'position:absolute; right:0; top:0; bottom:0; width:12px; z-index:50;';
    var sbThumb = document.createElement('div');
    sbThumb.className = 'qh-scroll-thumb';
    function _qhCol() {
      var dk = document.documentElement.getAttribute('data-theme') === 'dark';
      return { c: dk ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)' };
    }
    var _co = _qhCol();
    sbThumb.style.cssText = 'position:absolute; right:10px; width:1px; min-height:24px; border-radius:0; ' +
      'display:none; background:' + _co.c + '; cursor:pointer; ' +
      'transition: width 0.1s ease, right 0.1s ease, background 0.1s ease;';
    sbOuter.addEventListener('mouseenter', function () {
      sbThumb.style.width = '11px'; sbThumb.style.right = '0px'; sbThumb.style.background = _qhCol().c;
    });
    sbOuter.addEventListener('mouseleave', function () {
      sbThumb.style.width = '1px'; sbThumb.style.right = '10px'; sbThumb.style.background = _qhCol().c;
    });
    function _syncSB() {
      var sh = inner.scrollHeight, ch = inner.clientHeight;
      if (sh <= ch) { sbThumb.style.display = 'none'; sbOuter.style.display = 'none'; return; }
      sbThumb.style.display = '';
      sbOuter.style.display = '';
      var thumbH = Math.max(24, (ch / sh) * ch);
      var maxTop = ch - thumbH;
      sbThumb.style.height = thumbH + 'px';
      sbThumb.style.top = ((inner.scrollTop / (sh - ch)) * maxTop) + 'px';
    }
    inner.addEventListener('scroll', _syncSB);
    sbOuter.addEventListener('mousedown', function (e) {
      if (e.target === sbThumb || e.button !== 0) return;
      var sh = inner.scrollHeight, ch = inner.clientHeight;
      if (sh <= ch) return;
      var ratio = (e.clientY - sbOuter.getBoundingClientRect().top) / ch;
      inner.scrollTop = Math.max(0, Math.min(sh - ch, Math.round(ratio * (sh - ch))));
      e.preventDefault();
    });
    var _dr = false, _dsY = 0, _dsS = 0;
    sbThumb.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      _dr = true; _dsY = e.clientY; _dsS = inner.scrollTop;
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', function (e) {
      if (!_dr) return;
      var sh = inner.scrollHeight, ch = inner.clientHeight;
      if (sh <= ch) return;
      var thumbH = Math.max(24, (ch / sh) * ch);
      var ratio = (e.clientY - _dsY) / (ch - thumbH);
      inner.scrollTop = Math.max(0, Math.min(sh - ch, _dsS + ratio * (sh - ch)));
    });
    document.addEventListener('mouseup', function () { _dr = false; });
    setTimeout(_syncSB, 50);
    // 仅监听直接子节点变更（行平铺无嵌套），subtree:false 省去递归遍历开销
    var _sbObs = new MutationObserver(function () { setTimeout(_syncSB, 30); });
    _sbObs.observe(inner, { childList: true });
    var _themeObs = new MutationObserver(function () {
      var co3 = _qhCol();
      sbThumb.style.background = co3.c;
    });
    _themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    sbOuter.appendChild(sbThumb);
    outer.appendChild(sbOuter);
    outer.appendChild(inner);
    return inner;
  }

  // ---- 层级水印：列表底部显示深度编号，位置指示焦点面板（左/中/右）----
  function _stampDepth(container, depth) {
    var stamp = document.createElement('div');
    var target = typeof window.__qqq_aiTarget === 'number' ? window.__qqq_aiTarget : 1;
    // 构建 CSS：左面板→靠左，中面板→居中，右面板→靠右
    var cssText = 'position:absolute; bottom:12px; ' +
      'font-size:64px; font-weight:900; line-height:1; font-family:Verdana,sans-serif; ' +
      'color:var(--text-primary); opacity:0.90; pointer-events:none; ' +
      'z-index:1; user-select:none; white-space:nowrap;';
    if (target === 0) {
      cssText += ' left:8px; transform:none;';
    } else if (target === 2) {
      cssText += ' left:auto; right:8px; transform:none;';
    } else {
      cssText += ' left:50%; transform:translateX(-50%);';
    }
    stamp.style.cssText = cssText;
    stamp.textContent = String(depth);
    container.appendChild(stamp);
  }

  // ---- render: directory tree dropdown ----
  function showDropdown(blockEl, project) {
    // ★ 先关闭旧的（会存快照）
    if (activeDropdown) { closeDropdown(); }
    if (!blockEl.isConnected) return;
    _activeBlockEl = blockEl;

    const rect = blockEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const dd = document.createElement('div');
    dd.className = 'aiv-dropdown';
    dd._depth = 1;
    const topPx = rect.bottom;
    dd.style.cssText =
      'position:fixed; z-index:99999; ' +
      'left:' + rect.left + 'px; top:' + topPx + 'px; ' +
      'min-width:240px; max-width:360px; height:' + Math.max(200, window.innerHeight - topPx - 8) + 'px;';

    blockEl.classList.add('aiv-block-active');

    dd._projectRoot = project.path;
    var ddScroll = _wrapScrollContainer(dd, 1);
    // ★ 快照还原：检查该目录是否有保存的展开链
    var snap = _treeSnapshots[project.path];
    if (snap && snap.length > 0) {
      ddScroll._pendingChain = snap.slice();
    }
    loadDirInto(ddScroll, project.path, project.path);
    _stampDepth(dd, 1);
    document.body.appendChild(dd);
    activeDropdown = dd;
    // ★ 遮罩 + 冻结 iframe（点击外部关闭）
    _aivEnsureBackdrop();
    _setAiIframesPointerEvents('none');
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
    if (['exe', 'msi', 'dll'].indexOf(ext) !== -1) return '⚙\ufe0f';
    return '📄';
  }

  async function loadDirInto(parentEl, dirPath, projectRoot) {
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
        'font-size:14px; font-weight:300; color:var(--text-primary); white-space:nowrap; position:relative; ' +
        'width:100%; box-sizing:border-box;';
      // ★ 标记行属性，供快照还原匹配
      row.dataset.name = ent.name;
      row.dataset.isDir = ent.isDir ? 'true' : 'false';
      const icon = document.createElement('span');
      icon.textContent = fileIconFor(ent.name, ent.isDir);
      icon.style.cssText = 'margin-right:6px; font-size:11px;';
      const label = document.createElement('span');
      label.textContent = truncMiddle(ent.name, 26, 12);
      label.title = ent.name;  // 完整名称在 hover tooltip 显示
      label.style.cssText = 'overflow:hidden; text-overflow:ellipsis;';
      row.appendChild(icon); row.appendChild(label);

      row._hovered = false;
      row.addEventListener('mouseenter', () => {
        if (!ent.isDir) return;
        // 1000ms 防抖：杀旧计时器，标 hovered，起新计时器
        cancelHover();
        row._hovered = true;
        var depth = (parentEl._depth || 0) + 1;
        var subPath = pathJoin(dirPath, ent.name);
        var outer = parentEl._outer || parentEl; // inner scroll wrapper → outer container
        _hoverTimer = setTimeout(() => {
          _hoverTimer = null;
          if (!row._hovered) return; // 光标已离开，跳过
          if (outer._childSub) { closeSubmenuTree(outer._childSub); outer._childSub = null; }
          const sub = openSubmenu(row, subPath, depth, projectRoot);
          if (sub) {
            sub._justOpened = Date.now();
            outer._childSub = sub;
          }
        }, 150);
      });
      row.addEventListener('mouseleave', () => {
        row._hovered = false;
      });

      const fullPath = pathJoin(dirPath, ent.name);

      // 左键 → 附加到 AI 对话 + 飞块动画
      row.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // 只响应左键
        e.stopPropagation();
        e.preventDefault();
        attachToAi(fullPath, ent.isDir);
        // 飞块动画：小矩形从点击行飞向目标 AI 面板
        var target = typeof window.__qqq_aiTarget === 'number' ? window.__qqq_aiTarget : 1;
        _animateFlyToPanel(row, target);
      });
      row.addEventListener('click', (e) => { e.stopPropagation(); });

      // 右键 → 弹出上下文菜单，保持当前行 hover 效果
      row.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        e.preventDefault();
        function _setRowHighlight(r) {
          var dk = document.documentElement.getAttribute('data-theme') === 'dark';
          r._origRowStyle = r.style.cssText;
          r.style.cssText += ';background:' + (dk ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)') + '!important;color:' + (dk ? '#fff' : '#000') + '!important;';
          _ctxMenuRow = r;
        }
        // 目录+文件：右键 → 打开新搜索标签（多实例）
        if (_ctxMenuRow) _ctxMenuRow.style.cssText = _ctxMenuRow._origRowStyle;
        _setRowHighlight(row);
        if (window.qqqideOpenSearch) window.qqqideOpenSearch(fullPath, true);
      });

      parentEl.appendChild(row);
    }
    // ★ 行全部挂载后重置防抖窗口，防止行刚出现时光标恰在其上触发连锁展开
    parentEl._justOpened = Date.now();

    // ★ 快照还原：若本层有待展开链，自动触发下一级
    if (parentEl._pendingChain && parentEl._pendingChain.length > 0) {
      var nextRel = parentEl._pendingChain[0];
      // ★ 提取最后一段（兼容 "src" 和 "src/app" 两种格式）
      var targetName = nextRel.split(/[\\/]/).pop();
      var rows3 = parentEl.querySelectorAll(':scope > .aiv-dd-row');
      var foundRow = null;
      for (var ri3 = 0; ri3 < rows3.length; ri3++) {
        if (rows3[ri3].dataset.isDir === 'true') {
          // 先精确匹配完整相对路径，再降级匹配 basename
          var matchName = targetName;
          if (rows3[ri3].dataset.name === matchName) { foundRow = rows3[ri3]; break; }
        }
      }
      if (foundRow) {
        var subPath3 = pathJoin(dirPath, targetName);
        var depth3 = (parentEl._depth || 0) + 1;
        var outer3 = parentEl._outer || parentEl;
        if (outer3._childSub) { closeSubmenuTree(outer3._childSub); }
        outer3._childSub = null;
        var sub3 = openSubmenu(foundRow, subPath3, depth3, projectRoot);
        if (sub3) {
          sub3._justOpened = Date.now();
          outer3._childSub = sub3;
          // 剩余链传递到下一级滚动容器
          parentEl._pendingChain.shift();
          if (parentEl._pendingChain.length > 0) {
            var nextScroll2 = sub3.querySelector('.aiv-scroll-inner');
            if (nextScroll2) {
              nextScroll2._pendingChain = parentEl._pendingChain;
            }
          }
        }
      }
      // 无论是否找到匹配行，清理链防止残留
      parentEl._pendingChain = null;
    }
  }

  // ── 文件右键上下文菜单 ──
  var _ctxMenu = null;
  var _ctxMenuRow = null; // 右键时高亮的行
  function closeCtxMenu() {
    if (_ctxMenuRow) {
      // ★ 恢复原始样式
      if (_ctxMenuRow._origRowStyle) _ctxMenuRow.style.cssText = _ctxMenuRow._origRowStyle;
      _ctxMenuRow._origRowStyle = null;
      _ctxMenuRow = null;
    }
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  }
  function showFileContextMenu(e, filePath, projectRoot) {
    closeCtxMenu();
    var pop = document.createElement('div');
    pop.className = 'aiv-file-ctx-menu';
    pop.style.cssText =
      'position:fixed; z-index:999999; ' +
      'left:' + e.clientX + 'px; top:' + e.clientY + 'px; ' +
      'min-width:140px; background:var(--card-bg); ' +
      'border:1px solid var(--border-color); border-radius:3px; ' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18); padding:4px 0;';

    function addRow(label, onClick) {
      var row = document.createElement('div');
      row.style.cssText =
        'display:flex; align-items:center; padding:5px 14px; ' +
        'cursor:pointer; font-size:12px; color:var(--text-primary); ' +
        'white-space:nowrap; user-select:none;';
      row.textContent = label;
      row.addEventListener('mouseenter', function () { row.style.background = 'var(--background-color)'; });
      row.addEventListener('mouseleave', function () { row.style.background = ''; });
      row.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeCtxMenu();
        onClick();
      });
      pop.appendChild(row);
    }

    // Row 1: editx — 编辑文件
    addRow(window._i('shell.viewport.editx', '编辑文件'), function () {
      document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: filePath, preview: true } }));
    });

    // Row 2: open — 在系统中打开
    addRow(window._i('shell.viewport.openInOs', '在系统中打开'), function () {
      try {
        if (bridge && bridge.shell) {
          if (bridge.shell.openPath) {
            bridge.shell.openPath(filePath);
          } else if (bridge.shell.openExternal) {
            bridge.shell.openExternal('file:///' + filePath.replace(/\\/g, '/'));
          }
        }
      } catch (_) { }
    });

    // Row 3: timeline — 时间线
    addRow(window._i('shell.viewport.timeline', '时间线'), function () {
      if (bridge && bridge.timeline && bridge.timeline.openDiffWindow) {
        bridge.timeline.openDiffWindow({ filePath: filePath, projectRoot: projectRoot });
      }
    });

    // Row 4: copy path — 复制路径
    addRow(window._i('shell.viewport.copyPath', '复制路径'), function () {
      var text = filePath;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
      } else {
        fallbackCopy(text);
      }
      function fallbackCopy(t) {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (_) { }
        document.body.removeChild(ta);
      }
    });

    document.body.appendChild(pop);
    _ctxMenu = pop;

    // 全局点击关闭
    setTimeout(function () {
      document.addEventListener('mousedown', function _dismiss(e) {
        if (_ctxMenu && !_ctxMenu.contains(e.target)) {
          closeCtxMenu();
          document.removeEventListener('mousedown', _dismiss, true);
        }
      }, true);
    }, 0);
  }

  function openSubmenu(rowEl, dirPath, depth, projectRoot) {
    if (!rowEl.isConnected) return null;
    const sub = document.createElement('div');
    sub.className = 'aiv-submenu';
    sub._depth = depth || 1;
    const rect = rowEl.getBoundingClientRect();
    const rootTop = activeDropdown ? activeDropdown.getBoundingClientRect().top : rect.top;
    const maxH = Math.max(200, window.innerHeight - rootTop - 8);
    sub.style.cssText =
      'position:fixed; z-index:100000; ' +
      'min-width:220px; max-width:340px; height:' + maxH + 'px;';
    // ★ 方向决策基于父容器边缘（空间够不够放 340px 列表）
    //    定位贴合父行边缘（用户视觉跟行走）
    var estW = 340;
    var gap = 0;
    var parentEdge = rowEl.parentElement.getBoundingClientRect();
    var parentDir = rowEl.parentElement && rowEl.parentElement._direction;
    var goRight;
    if (parentDir === undefined) {
      var spaceR = window.innerWidth - parentEdge.right;
      var spaceL = parentEdge.left;
      goRight = (spaceR >= spaceL);
    } else {
      if (parentDir) {
        goRight = (window.innerWidth - parentEdge.right >= estW);
      } else {
        goRight = !(parentEdge.left >= estW);
      }
    }
    sub._direction = goRight;
    // 背景色交替：右跳主色，左跳辅色（亮/暗主题各自成对），区分展开方向
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    sub.style.setProperty('background', goRight ? (isDark ? '#1e211e' : '#e7e4c2') : (isDark ? '#232a23' : '#ede4cf'), 'important');
    // 定位：右跳贴父容器右边缘，左跳用 CSS right 贴父容器左边缘（消除 estW≠实际宽度造成的空隙）
    if (goRight) {
      var leftX = parentEdge.right + gap;
      if (leftX + estW > window.innerWidth) leftX = window.innerWidth - estW;
      sub.style.left = leftX + 'px';
      sub.style.right = 'auto';
    } else {
      sub.style.right = (window.innerWidth - parentEdge.left) + 'px';
      sub.style.left = 'auto';
      // 如果左侧空间不够，退化为 left:0（不溢出屏幕）
      if (parentEdge.left < estW) {
        sub.style.left = '0px';
        sub.style.right = 'auto';
      }
    }
    sub.style.top = rootTop + 'px';

    // breadcrumb: mark the parent row so the path stays highlighted
    rowEl.classList.add('aiv-breadcrumb');
    sub._parentRow = rowEl;

    var subScroll = _wrapScrollContainer(sub, sub._depth);
    _stampDepth(sub, sub._depth);
    document.body.appendChild(sub);
    activeSubmenus.push(sub);

    // ★ 记录展开链到根下拉（用于关闭时快照）
    if (activeDropdown) {
      if (!activeDropdown._expandedChain) activeDropdown._expandedChain = [];
      // ★ splice(depth-1) 删除 depth-1 及之后的所有元素
      //    不会产生稀疏数组（.length = N 当数组更短时会产生空洞）
      // ★ splice(depth-2)：depth≥2，splice(depth-2) 清掉从本级开始之后的所有路径
      //    例如 depth=2(第1级) splice(0) 清空 → 同级切换不会残留旧路径
      activeDropdown._expandedChain.splice(depth - 2);
      var rel = dirPath.substring(projectRoot.length).replace(/^[\\/]+/, '');
      activeDropdown._expandedChain.push(rel);
    }

    loadDirInto(subScroll, dirPath, projectRoot);
    sub._projectRoot = projectRoot;
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
      // 主文件夹未可删除，显示 ★ 标记
      rmBtn.textContent = '★';
      rmBtn.title = window._i('shell.viewport.mainFolder', '主文件夹（未可移除）');
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

    // hover → 150ms 防抖后展开下拉（防止光标掠过误触 + 限制 readdir 频率）
    // 仅窗口有焦点时响应 hover，无焦点时靠 click 触发
    var _blockHoverTimer = null;
    block.addEventListener('mouseenter', () => {
      if (!document.hasFocus()) return;
      if (_blockHoverTimer) return; // 已在计时中
      _blockHoverTimer = setTimeout(() => {
        _blockHoverTimer = null;
        showDropdown(block, proj);
      }, 150);
    });
    block.addEventListener('mouseleave', () => {
      if (_blockHoverTimer) { clearTimeout(_blockHoverTimer); _blockHoverTimer = null; }
    });
    // 光标左键点击 → 立即展开下拉（不防抖，窗口有无焦点均可）
    block.addEventListener('click', () => {
      if (_blockHoverTimer) { clearTimeout(_blockHoverTimer); _blockHoverTimer = null; }
      showDropdown(block, proj);
    });
    // 右键 → 打开新搜索标签（多实例）
    block.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.qqqideOpenSearch) window.qqqideOpenSearch(proj.path, true);
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

    // 光标左键点击 → 原生对话框选择新文件夹（有无焦点均可）
    block.addEventListener('click', async (e) => {
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

    // hover → 即时展示最近 20 个主文件夹下拉（仅窗口有焦点时）
    block.addEventListener('mouseenter', () => {
      if (!document.hasFocus()) return;
      _showRecentDropdown(block);
    });


    return block;
  }

  // ---- recent folders dropdown (hover "+" block) ----
  function _showRecentDropdown(blockEl) {
    closeDropdown();
    if (!blockEl.isConnected) return;
    _activeBlockEl = blockEl;
    blockEl.classList.add('aiv-block-active');

    var rect = blockEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    var topPx = rect.bottom;
    var maxH = Math.max(200, window.innerHeight - topPx - 8);

    var dd = document.createElement('div');
    dd.className = 'aiv-dropdown aiv-recent-dropdown';
    dd.style.cssText =
      'position:fixed; z-index:99999; ' +
      'left:' + rect.left + 'px; top:' + topPx + 'px; ' +
      'min-width:280px; max-width:420px; height:' + maxH + 'px;';

    // 去重：同 path 只保留最靠前
    var seen = {};
    var deduped = _recentFolders.filter(function (f) {
      var p = (f.path || '').replace(/\\/g, '/').replace(/\/$/, '');
      if (seen[p]) return false;
      seen[p] = true;
      return true;
    });

    if (deduped.length === 0) {
      var emptyRow = document.createElement('div');
      emptyRow.style.cssText = 'padding:10px 12px; font-size:12px; color:var(--text-muted); font-style:italic;';
      emptyRow.textContent = window._i ? window._i('shell.viewport.noRecent', '暂无最近记录，点击 + 选择文件夹') : '暂无最近记录，点击 + 选择文件夹';
      dd.appendChild(emptyRow);
    } else {
      deduped.forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'aiv-row aiv-recent-row';
        row.style.cssText = 'padding:8px 12px; cursor:default; font-size:14px; font-weight:300; display:flex; align-items:center; gap:6px;';

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
    // ★ 遮罩 + 冻结 iframe（点击外部关闭）
    _aivEnsureBackdrop();
    _setAiIframesPointerEvents('none');
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
    // AI iframe（跨 frame 通信必须用 postMessage）—— 广播到左/中/右所有面板
    var zones = ['qqq-wing-left', 'qqq-ai-zone', 'qqq-wing-right'];
    for (var i = 0; i < zones.length; i++) {
      var zone = document.getElementById(zones[i]);
      if (!zone) continue;
      var aiFrame = zone.querySelector('iframe');
      if (aiFrame && aiFrame.contentWindow) {
        try {
          aiFrame.contentWindow.postMessage({ type: 'qqq-ai-viewport-changed', projects: projects }, '*');
        } catch (_) { }
      }
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
            console.warn('[ai-viewport] lock pre-check failed for ' + folderPath + ' (age=' + (age / 1000).toFixed(1) + 's)');
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
    // 主文件夹（索引 0）未可删除
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
    // ★ 关闭下拉：左键点击列表外任何位置（窗口内+窗口外）
    function _isOutsideDropdown(target) {
      if (!activeDropdown) return false;
      if (activeDropdown.contains(target)) return false;
      if (target.closest && target.closest('.aiv-submenu')) return false;
      if (target.closest && target.closest('.aiv-block')) return false;
      return true;
    }
    function _dismissDropdown() {
      if (!activeDropdown) return;
      closeDropdown();
      document.querySelectorAll('.aiv-block-active').forEach(function (el) { el.classList.remove('aiv-block-active'); });
    }
    // ★ 遮罩已内置到 showDropdown / _showRecentDropdown / closeDropdown（模块级）
    //    此处不再 monkey-patch，保持单一真理源
    window.qqqideViewport.closeDropdown = closeDropdown;
    // Escape 键关闭（任何情况下都可操作）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeDropdown) _dismissDropdown();
    });
    // 窗口失焦轮询兜底（100ms 间隔）
    setInterval(function () {
      if (activeDropdown && !document.hasFocus()) _dismissDropdown();
    }, 100);

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

  // ★ 焦点面板路由：文件附加到当前金色 q2 的 AI 面板
  window.__qqq_aiTarget = 1;  // 默认中面板
  window.__qqq_updateAiTarget = function (n) {
    if (typeof n === 'number' && n >= 0 && n <= 2) window.__qqq_aiTarget = n;
  };
  // （attachToAi 在模块顶部统一定义，此处不再重复）

  window.qqqideViewport = { build, addProject, removeProject, getProjects, getMainProject, closeDropdown };
})();
