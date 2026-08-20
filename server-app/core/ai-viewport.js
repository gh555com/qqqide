// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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

  // ── git 未提交计数 badge ──
  var _gitBadgeCache = {};       // path → { count, error }
  var _gitBadgeEls = {};         // path → badge DOM element (direct reference)
  var _gitBadgeTimer = null;
  var _gitBadgePollMs = 15000;

  function _pollGitBadges() {
    if (!projects.length) return;
    var idx = 0;
    function next() {
      if (idx >= projects.length) return;
      var p = projects[idx++];
      _checkOneGitBadge(p).finally(next);
    }
    next();
  }

  async function _checkOneGitBadge(proj) {
    try {
      var gitBin = 'git';
      if (bridge.components && bridge.components.getBin) {
        try { var bin = await bridge.components.getBin('git'); if (bin) gitBin = bin; } catch(_) {}
      }
      var r = await bridge.qz.spawn({
        cmd: gitBin,
        args: ['-C', proj.path, 'status', '--porcelain'],
        timeout: 8000
      });
      if (r.exitCode !== 0) { _gitBadgeCache[proj.path] = { error: true }; return; }
      var count = (r.stdout || '').split('\n').filter(Boolean).length;
      _gitBadgeCache[proj.path] = { count: count, error: false };
      _updateBadgeDOM(proj.path, count);
    } catch (e) {
      _gitBadgeCache[proj.path] = { error: true };
    }
  }

  function _updateBadgeDOM(path, count) {
    var el = _gitBadgeEls[path];
    if (!el) return;
    if (count > 0) {
      el.style.display = '';
      el.textContent = count > 99 ? '99+' : String(count);
    } else {
      el.style.display = 'none';
    }
  }

  function _startGitBadgePolling() {
    if (_gitBadgeTimer) return;
    _pollGitBadges();
    _gitBadgeTimer = setInterval(_pollGitBadges, _gitBadgePollMs);
  }

  // ---- module-level state (dropdown stays forever until explicit dismiss) ----
  let _activeBlockEl = null;
  let _dirCache = new Map(); // per-dropdown cache: key=dirPath, value=entries[]
  let _hoverTimer = null;
  function cancelHover() { if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; } }

  // ★ 模糊匹配：空格 = AND，逐字符顺序匹配
  function _fuzzyMatch(query, target) {
    var lower = target.toLowerCase();
    var pos = 0;
    for (var i = 0; i < query.length; i++) {
      pos = lower.indexOf(query[i], pos);
      if (pos === -1) return false;
      pos++;
    }
    return true;
  }

  // ★ 每目录独立快照 + 滚动位置
  var _lastHoveredSubdirByPath = {};
  var _scrollPosByPath = {};
  var SNAPSHOT_MAX_ENTRIES = 500;

  function _setSnapshot(parentDir, childName) {
    _lastHoveredSubdirByPath[parentDir] = childName;
    var keys = Object.keys(_lastHoveredSubdirByPath);
    if (keys.length > SNAPSHOT_MAX_ENTRIES) { delete _lastHoveredSubdirByPath[keys[0]]; }
  }

  // ★ 每目录排序偏好：'n'=文件名倒序(默认), 'm'=修改时间倒序
  var _sortPrefByPath = {};
  var SORT_PREFS_KEY = 'ai.viewport.sortPrefs';
  // ★ 树展开快照（项目级，key=主文件夹自身路径 → 树的宿主=项目，跟项目走）
  var TREE_SNAPS_KEY = 'ai.viewport.treeSnapshots';
  // ★ 滚动位置（OS 级，key=任意目录绝对路径 → 偏好属于目录本身）
  var SCROLL_POS_KEY = 'ai.viewport.scrollPositions';

  // ★ OS 级持久化桥 (2026-08-07 F3): %LOCALAPPDATA%/qqqide/ai.sq3
  //   语义: key=目录/文件绝对路径 → 偏好属于目录，跨主文件夹/跨绿色包/跨窗口一致
  function _osBridge() {
    var b = bridge.aiState;
    if (!b || typeof b.get !== 'function') return null;
    return b;
  }

  function _getOnlyDb() {
    var mainProj = projects[0];
    if (!mainProj || !mainProj.path) return null;
    if (!window.qgs || typeof window.qgs.project !== 'function') return null;
    var onlyPath = mainProj.path.replace(/\\/g, '/').replace(/\/$/, '') + '/_qqq/alphal/only.sq3';
    return window.qgs.project(onlyPath, 'qqq.only', { v: 1, form: 'doc' });
  }

  function _loadSortPrefs() {
    var os = _osBridge();
    if (os) {
      // ★ OS 级主通道
      os.get(SORT_PREFS_KEY).then(function (data) {
        if (data && typeof data === 'object') { _sortPrefByPath = data; return; }
        // ★ 迁移：OS 无数据 → 读旧 only.sq3 → 写入 OS → 删旧 key
        _migrateFromOnlyDb(SORT_PREFS_KEY, function (v) { _sortPrefByPath = v; });
      }).catch(function () { });
      return;
    }
    // 降级: 旧项目级通道（无 OS 桥环境）
    var db = _getOnlyDb();
    if (!db) return;
    db.get(SORT_PREFS_KEY).then(function (data) {
      if (data && typeof data === 'object') { _sortPrefByPath = data; }
    }).catch(function () { });
  }

  // ★ 一次性迁移：旧 only.sq3 → OS 级 ai.sq3，成功后删除旧 key
  function _migrateFromOnlyDb(key, apply) {
    var db = _getOnlyDb();
    if (!db) return;
    db.get(key).then(function (data) {
      if (!data || typeof data !== 'object' || !Object.keys(data).length) return;
      apply(data);
      var os = _osBridge();
      if (os) {
        os.set(key, data).catch(function () { });
        if (db.del) { db.del(key).catch(function () { }); }
      }
    }).catch(function () { });
  }

  function _saveSortPrefs() {
    var os = _osBridge();
    if (os) { os.set(SORT_PREFS_KEY, _sortPrefByPath).catch(function () { }); return; }
    var db = _getOnlyDb();
    if (!db) return;
    // ★ setNow 而非 set：确保 Ctrl+R 热重载前已刷盘
    if (db.setNow) db.setNow(SORT_PREFS_KEY, _sortPrefByPath).catch(function () { });
    else db.set(SORT_PREFS_KEY, _sortPrefByPath).catch(function () { });
  }

  // ★ 树展开快照：项目级持久化到 only.sq3（key=主文件夹自身路径 → 跟项目走正确）
  function _loadViewportState() {
    var db = _getOnlyDb();
    if (!db) return;
    db.get(TREE_SNAPS_KEY).then(function (data) {
      if (data && typeof data === 'object') { _treeSnapshots = data; }
    }).catch(function () { });
    // ★ 滚动位置: OS 级读取（原项目级 key 不再读）
    var os = _osBridge();
    if (os) {
      os.get(SCROLL_POS_KEY).then(function (data) {
        if (data && typeof data === 'object') { _scrollPosByPath = data; return; }
        // ★ 迁移：旧 only.sq3 → OS
        _migrateFromOnlyDb(SCROLL_POS_KEY, function (v) { _scrollPosByPath = v; });
      }).catch(function () { });
    }
  }

  function _saveViewportState() {
    var db = _getOnlyDb();
    if (db) {
      if (db.setNow) {
        db.setNow(TREE_SNAPS_KEY, _treeSnapshots).catch(function () { });
      } else {
        db.set(TREE_SNAPS_KEY, _treeSnapshots).catch(function () { });
      }
    }
    // ★ 滚动位置: OS 级写入
    var os = _osBridge();
    if (os) { os.set(SCROLL_POS_KEY, _scrollPosByPath).catch(function () { }); }
  }

  // ★ 滚动位置防抖落盘：滚动中高频触发，关闭下拉/beforeunload 兜底全量刷
  var _scrollPersistTimer = null;
  function _scheduleScrollPersist() {
    if (_scrollPersistTimer) return;
    _scrollPersistTimer = setTimeout(function () {
      _scrollPersistTimer = null;
      _saveScrollPosOnly();
    }, 800);
  }
  function _saveScrollPosOnly() {
    var os = _osBridge();
    if (os) { os.set(SCROLL_POS_KEY, _scrollPosByPath).catch(function () { }); }
  }

  // ★ 筛选框：模糊匹配+空格AND，筛选时清除子列表。右边 N/M 排序按钮。
  function _createFilterBar(scrollContainer, dirPath) {
    var bar = document.createElement('div');
    bar.className = 'aiv-filter-bar';
    bar.style.cssText = 'display:flex; padding:4px 6px; flex-shrink:0; border-bottom:1px solid var(--border-color); align-items:center; gap:4px;';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'aiv-filter-input';
    input.placeholder = '\u7b5b\u9009...';
    input.style.cssText =
      'flex:1; background:var(--base2); border:1px solid var(--border-color); ' +
      'border-radius:2px; padding:4px 6px; font-size:12px; color:var(--text-primary); ' +
      'outline:none; box-sizing:border-box;';
    input.addEventListener('input', function () {
      var val = this.value;
      var outer = scrollContainer._outer || scrollContainer.parentElement;
      _closeDescendantSubmenus(outer);
      var rows = scrollContainer.querySelectorAll(':scope > .aiv-dd-row');
      if (!val) {
        rows.forEach(function (r) { r.style.display = ''; });
        return;
      }
      var tokens = val.toLowerCase().split(/\s+/).filter(Boolean);
      rows.forEach(function (row) {
        var name = (row.dataset.name || '').toLowerCase();
        var match = tokens.every(function (t) { return _fuzzyMatch(t, name); });
        row.style.display = match ? '' : 'none';
      });
    });
    bar.appendChild(input);

    // ---- N / M 排序按钮 ----
    function _makeSortBtn(label, mode) {
      var btn = document.createElement('button');
      btn.className = 'aiv-sort-btn';
      btn.textContent = label;
      btn.title = mode === 'n' ? '\u6309\u6587\u4ef6\u540d\u6392\u5e8f' : '\u6309\u4fee\u6539\u65f6\u95f4\u6392\u5e8f';
      btn.style.cssText =
        'width:24px; height:24px; border:1px solid var(--border-color); border-radius:2px; ' +
        'color:var(--text-primary); font-size:12px; font-weight:bold; ' +
        'cursor:pointer; padding:0; line-height:22px; text-align:center; flex-shrink:0; ' +
        'transition:none;';
      btn.style.background = 'transparent';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        var cur = _sortPrefByPath[dirPath] || 'n';
        if (cur === mode) return;
        // ★ 只持久化非默认值：m 存，n 删（默认即 n，省存储）
        if (mode === 'm') {
          _sortPrefByPath[dirPath] = 'm';
        } else {
          delete _sortPrefByPath[dirPath];
        }
        _saveSortPrefs();
        _dirCache.delete(dirPath + '|n');
        _dirCache.delete(dirPath + '|m');
        _dirCache.delete(dirPath);  // 清理旧 key（无 mode 后缀）
        // ★ 切换按钮高亮：只有 mode 匹配的亮，其余透明
        var allBtns = bar.querySelectorAll('.aiv-sort-btn');
        allBtns.forEach(function (b) { b.style.background = 'transparent'; });
        btn.style.background = 'var(--gold-accent-bg)';
        // ★ 重新渲染本列表：清空 + 重新 loadDirInto
        var outer = scrollContainer._outer || scrollContainer.parentElement;
        _closeDescendantSubmenus(outer);
        while (scrollContainer.firstChild) { scrollContainer.removeChild(scrollContainer.firstChild); }
        loadDirInto(scrollContainer, dirPath, outer._projectRoot);
      });
      return btn;
    }
    var nBtn = _makeSortBtn('N', 'n');
    var mBtn = _makeSortBtn('M', 'm');
    var curMode = _sortPrefByPath[dirPath] || 'n';
    if (curMode === 'n') {
      nBtn.style.background = 'var(--gold-accent-bg)';
    } else {
      mBtn.style.background = 'var(--gold-accent-bg)';
    }
    bar.appendChild(nBtn);
    bar.appendChild(mBtn);

    return bar;
  }

  function _closeDescendantSubmenus(outer) {
    if (!outer) return;
    if (outer._childSub) { closeSubmenuTree(outer._childSub); outer._childSub = null; }
  }

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
  async function listDir(p, sortMode) {
    var mode = sortMode || _sortPrefByPath[p] || 'n';
    var cacheKey = p + '|' + mode;
    var cached = _dirCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.entries;
    try {
      // ★ bridge.fs.list 主进程已并行 stat，直接返回 mtimeMs
      var entries = await bridge.fs.list(p);
      entries.sort(function (x, y) {
        if (x.isDir !== y.isDir) return x.isDir ? -1 : 1;
        if (mode === 'm') {
          return (y.mtimeMs || 0) - (x.mtimeMs || 0);
        }
        // 默认 'n'：文件名倒序（数字大的在上）
        return naturalCompare(y.name, x.name);
      });
      _dirCache.set(cacheKey, { entries, ts: Date.now() });
      return entries;
    } catch (e) {
      return [];
    }
  }

  // ---- recent folders (global + OS ws.sq3 双写, 上限 100, 永久记忆 2026-08-16) ----
  var RECENT_KEY = 'recent_folders';
  var MAX_RECENT = 100;
  var _recentFolders = []; // [{path, name, atime}]
  var _recentsReady = null; // Promise — resolve 后 _recentFolders 才是真实数据
  var _recentsLoaded = false; // load 完成标记（失败也置 true）→ 防空数组在 load 完成前覆盖 OS recentFolders

  function _qgsNs() {
    if (window.qgs && typeof window.qgs.ns === 'function') {
      return window.qgs.ns('qqqide', { v: 1, form: 'doc' });
    }
    return null;
  }

  function _loadRecents() {
    _recentsLoaded = false;
    _recentsReady = new Promise(function (resolve) {
      try {
        var s = _qgsNs();
        if (s) {
          s.get(RECENT_KEY).then(function (data) {
            if (data && Array.isArray(data)) {
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
    }).then(function () { _recentsLoaded = true; });
  }

  function _saveRecents() {
    try {
      var s = _qgsNs();
      if (s) s.set(RECENT_KEY, _recentFolders).catch(function () { });
      // ★ OS 级双写 (2026-08-16): 与 ws.sq3 同步 — 任意启动目录添加过的目录永久留存
      var ws = _wsBridge();
      if (ws && _recentsLoaded) {
        ws.set(WS_RECENT_KEY, _recentFolders.slice(0, MAX_RECENT)).catch(function () { });
      }
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

  // 异步校验主文件夹锁：若该项目已被其他实例/窗口锁定，从视口移除
  // 仅在 ?folder= 新窗口场景使用，作为主进程 claimProject 仲裁的兜底（2026-08-10 改 query）
  function _verifyFolderLock(folderPath) {
    // 延迟 2s 再检查（主进程仲裁先行，渲染层只做展示层兜底）
    setTimeout(function () {
      var pl = bridge && bridge.projectLock;
      if (!pl) return;
      pl.query(folderPath).then(function (res) {
        if (!res || !res.locked) return; // 无锁/僵尸/本实例无锁 → 安全
        if (res.self) return; // 本实例自己的锁（主进程仲裁已持有）→ 跳过，避免自误判
        var idx = -1;
        for (var i = 0; i < projects.length; i++) {
          if (projects[i].path === folderPath) { idx = i; break; }
        }
        if (idx > 0) {
          console.warn('[ai-viewport] locked by another instance for ' + folderPath + ' (pid=' + (res.holder && res.holder.pid) + '), removing from viewport');
          projects.splice(idx, 1);
          saveProjects();
          render();
          _notifyChanged();
        } else if (idx === 0) {
          // ★ 主文件夹被占用 → 清空整个视口（2026-08-13 定案，替代旧「保留+警告」）：
          //   旧行为留下残血窗口——视口带整套成员但面板永不绑定，边界漏洞黑洞。
          //   清空 = 干净新窗口，用户手动添加其他项目即可重新开始。
          clearAllProjects(folderPath);
        }
      }).catch(function () { /* 查询失败不阻断 */ });
    }, 2000);
  }

  // ★ URL 显式指定主文件夹（?restore=1&folder=X / ?fresh=1&folder=X）→ 不参与全局恢复点竞争
  function _urlSpecifiesMain() {
    try { return window.location.search.indexOf('folder=') !== -1; } catch (_) { return false; }
  }

  // ★ fresh=1 空白新窗口同样不参与全局恢复点竞争（铁律 8.3：restore/fresh 窗口不写 last_main_folder）
  //   修复（2026-08-08）：?fresh=1 无 folder= 时 _urlSpecifiesMain() 为 false → 原守卫漏放行
  function _isFreshWindow() {
    try { return window.location.search.indexOf('fresh=1') !== -1; } catch (_) { return false; }
  }

  // ═══ OS 级工作空间唯一真理源（2026-08-08 定案: 独立 ws.sq3）═══
  //   语义: 主文件夹 + 出战阵营 = 工作空间记忆，存 %LOCALAPPDATA%/qqqide/ws.sq3
  //   （kope/roam/ai 同款：OS 级独立单库，跨绿色包/跨 dev/跨窗口一致，异常退出不丢）
  //   ★ 独立库意义: 彻底删除工作空间记忆 = 删 ws.sq3，不污染 ai.sq3 的
  //     sortPrefs/scrollPositions/recent 等其他记忆块
  //   key 设计: lastMainFolder 单值 + formation.{mainPath} 每主文件夹一条阵营
  //   → 不同主文件夹阵营天然隔离，无互相覆盖竞态；同主文件夹仅一窗口（项目锁）→ 无并发写
  //   恢复优先级: 启动目录 global.sq3（last_main_folder）→ OS ws.sq3 兜底 + 回写 global.sq3
  var WS_LAST_KEY = 'lastMainFolder';
  var WS_FORM_PREFIX = 'formation.';
  var WS_RECENT_KEY = 'recentFolders';  // 最近打开过的主文件夹列表（OS 兜底，本地 recent_folders 丢失时拉回）

  // ★ 工作空间 OS 桥（独立 ws.sq3；老壳层无 wsState 桥 → null，降级本地链，不写回 ai.sq3）
  function _wsBridge() {
    if (!bridge || !bridge.wsState || typeof bridge.wsState.get !== 'function') return null;
    return bridge.wsState;
  }

  function _normPath(p) {
    return (p || '').replace(/\\/g, '/').replace(/\/$/, '');
  }

  // ★ 路径存在性校验（恢复记忆前验证，防死路径 → 面板永久空白轮询；网络盘暂时不可达 → 跳过本次恢复）
  function _pathExists(p) {
    if (!bridge || !bridge.fs || typeof bridge.fs.stat !== 'function') return Promise.resolve(true);
    return bridge.fs.stat(p).then(function (st) { return !!st; }).catch(function () { return false; });
  }

  // 写 OS：lastMainFolder + 本主文件夹的阵营（ipc-ws-state set = 立即 tmp+rename 原子落盘）
  //   lastMainFolder 仅空白启动窗口写（与 _persistLastMainFolder 同规则，防 restore/fresh 窗口覆盖全局恢复点）；
  //   formation 按 mainPath 隔离，任何窗口写自己的阵营，无竞争
  function _saveWorkspaceToOs() {
    var ws = _wsBridge();
    if (!ws) return;
    if (projects.length === 0 || !projects[0].path) return;
    var mainFolder = _normPath(projects[0].path);
    // lastMainFolder 仅空白启动窗口写（铁律 8.3）；restore 窗口 URL 必带 folder= 已挡，
    //   fresh=1 无 folder 时 _urlSpecifiesMain() 为 false → 显式补 fresh 判定（2026-08-08）
    if (!_urlSpecifiesMain() && !_isFreshWindow()) {
      ws.set(WS_LAST_KEY, mainFolder).catch(function () { });
    }
    var auxs = [];
    for (var _wi = 1; _wi < projects.length; _wi++) {
      var _ap = _normPath(projects[_wi].path);
      if (_ap) auxs.push(_ap);
    }
    ws.set(WS_FORM_PREFIX + mainFolder, auxs).catch(function () { });
    // ★ recentFolders OS 兜底（recent = "打开过"记录，任何窗口都同步；等 load 完成防空数组覆盖磁盘）
    var ready = _recentsReady || Promise.resolve();
    ready.then(function () {
      if (!_recentsLoaded || _recentFolders.length === 0) return;
      ws.set(WS_RECENT_KEY, _recentFolders.slice(0, MAX_RECENT)).catch(function () { });
    });
  }

  // 恢复收尾（统一路径）: 排序偏好 + 视口状态 + 落盘（回写 local global.sq3 + 刷新 OS）+ 渲染
  function _finishRestore() {
    _loadSortPrefs();
    _loadViewportState();
    saveProjects();
    render();
    _notifyChanged();
    _restoreRecentsFromOs();
    // ★ 空白启动恢复后锁自检（2026-08-13 定案）：主文件夹被另一窗口/实例占用
    //   → 清空整个视口得干净新窗口（杜绝残血窗口）。面板 claim 失败兜底见 panel-quest。
    if (projects.length > 0 && projects[0].path) {
      _verifyFolderLock(projects[0].path);
    }
  }

  // ★ recent_folders OS 并集合并（2026-08-16 整改）: 任意启动目录点击 + 添加过的目录永久记录
  //   local(global.sq3) ∪ OS(ws.sq3), 同路径 atime 取新, 按 atime 降序, cap MAX_RECENT
  //   合并后双写回 local + OS → 跨启动目录/跨包零丢失记忆; 统一收尾点 _finishRestore 调用
  function _restoreRecentsFromOs() {
    var ws = _wsBridge();
    if (!ws) return;
    var ready = _recentsReady || Promise.resolve();
    ready.then(function () {
      if (!_recentsLoaded) return;
      ws.get(WS_RECENT_KEY).then(function (list) {
        var osList = (list && Array.isArray(list)) ? list : [];
        var map = {};
        function put(p, name, atime) {
          p = _normPath(p || '');
          if (!p) return;
          atime = atime || 0;
          var ex = map[p];
          if (!ex) { map[p] = { path: p, name: name || basename(p) || '', atime: atime }; }
          else if (atime >= ex.atime) { ex.atime = atime; if (name) ex.name = name; }
          else if (!ex.name && name) { ex.name = name; }
        }
        _recentFolders.forEach(function (f) { put(f.path, f.name, f.atime); });
        for (var i = 0; i < osList.length; i++) put(osList[i].path, osList[i].name, osList[i].atime);
        var merged = Object.keys(map).map(function (k) { return map[k]; });
        merged.sort(function (a, b) { return (b.atime || 0) - (a.atime || 0); });
        if (merged.length > MAX_RECENT) merged.length = MAX_RECENT;
        // 内容相同且 OS 已有数据 → 跳过写盘; OS 为空 → 回写建立 OS 真理
        var same = merged.length === _recentFolders.length;
        if (same) {
          for (var j = 0; j < merged.length; j++) {
            if (merged[j].path !== _recentFolders[j].path) { same = false; break; }
          }
        }
        if (!same || osList.length === 0) {
          _recentFolders = merged;
          _saveRecents(); // 回写本地 global.sq3 + OS ws.sq3
        }
      }).catch(function () { });
    });
  }

  // 恢复：OS ws.sq3 兜底（main + formation 一起）；saveProjects → _persistLastMainFolder 自动回写本地 global.sq3
  function _restoreWorkspaceFromOs() {
    var ws = _wsBridge();
    if (!ws) {
      _restoreLastMainFolder();
      return;
    }
    ws.get(WS_LAST_KEY).then(function (mainFolder) {
      if (!mainFolder || typeof mainFolder !== 'string') {
        // ★ OS 无记忆 → global.sq3 旧链恢复
        _restoreLastMainFolder();
        return;
      }
      mainFolder = _normPath(mainFolder);
      // ★ 死路径校验: OS 记忆指向已删除目录 → 本地链再试（同样校验），防恢复死项目永久空白
      _pathExists(mainFolder).then(function (exists) {
        if (!exists) { _restoreLastMainFolder(); return; }
        if (!projects.some(function (p) { return p.path === mainFolder; })) {
          projects.push({ path: mainFolder, name: basename(mainFolder) });
          _bumpRecent(mainFolder);
        }
        // 阵营恢复（OS 优先，only.sq3 兜底）
        ws.get(WS_FORM_PREFIX + mainFolder).then(function (auxs) {
          if (auxs && Array.isArray(auxs)) {
            for (var _fi = 0; _fi < auxs.length; _fi++) {
              var _fp = _normPath(auxs[_fi]);
              if (!_fp || projects.some(function (p) { return p.path === _fp; })) continue;
              projects.push({ path: _fp, name: basename(_fp) });
            }
          } else {
            _restoreFormationFromOnlyStore(mainFolder);
          }
          _finishRestore();
        }).catch(function () {
          _restoreFormationFromOnlyStore(mainFolder);
          _finishRestore();
        });
      });
    }).catch(function () { _restoreLastMainFolder(); });
  }

  // ★ 空白启动恢复链（2026-08-08 定案）:
  //   ① 启动目录 global.sq3（last_main_folder）有记忆 → 本地优先直接用
  //      （本地记忆 = 本包/本目录曾用过的真实历史，多绿色包互不串）
  //   ② 本地无记忆 → OS ws.sq3 兜底（跨包/目录迁移恢复）→ saveProjects 自动回写本地 global.sq3
  function _restoreWorkspaceLocalFirst() {
    var s = _qgsNs();
    var tryLocal = function () {
      if (!s || typeof s.get !== 'function') return Promise.resolve(false);
      return s.get('last_main_folder').then(function (folderPath) {
        if (!folderPath || typeof folderPath !== 'string') return false;
        folderPath = _normPath(folderPath);
        // ★ 死路径校验: 本地记忆指向已删除目录 → 跳过（交给 OS 链/空白自愈），防恢复死项目永久空白
        return _pathExists(folderPath).then(function (exists) {
          if (!exists) return false;
          if (!projects.some(function (p) { return p.path === folderPath; })) {
            projects.push({ path: folderPath, name: basename(folderPath) });
            _bumpRecent(folderPath);
          }
          // 阵营: OS ws.sq3 → only.sq3 兜底
          var ws = _wsBridge();
          var done = function () { _finishRestore(); };
          if (!ws) { _restoreFormationFromOnlyStore(folderPath); done(); return true; }
          ws.get(WS_FORM_PREFIX + folderPath).then(function (auxs) {
            if (auxs && Array.isArray(auxs)) {
              for (var _fi = 0; _fi < auxs.length; _fi++) {
                var _fp = _normPath(auxs[_fi]);
                if (!_fp || projects.some(function (p) { return p.path === _fp; })) continue;
                projects.push({ path: _fp, name: basename(_fp) });
              }
            } else {
              _restoreFormationFromOnlyStore(folderPath);
            }
            done();
          }).catch(function () {
            _restoreFormationFromOnlyStore(folderPath);
            done();
          });
          return true;
        });
      }).catch(function () { return false; });
    };
    tryLocal().then(function (usedLocal) {
      if (!usedLocal) _restoreWorkspaceFromOs();
    });
  }

  // ★ 持久化"上次主文件夹"到 global.sq3（供空白启动恢复）
  //   资格：仅空白启动窗口（无 folder= 参数）写入（F-2026-08-06 时序防护）：
  //   restore/fresh 窗口写入会与旧窗口互相覆盖全局恢复点，多窗口下最后写入者赢
  //   → 空白启动恢复到错误主文件夹（本次主从错乱 bug 的直接原因之一）
  function _persistLastMainFolder() {
    // ★ fresh=1 空白新窗口同样不写全局恢复点（铁律 8.3，2026-08-08 补漏）
    if (_urlSpecifiesMain() || _isFreshWindow()) return;
    if (projects.length === 0 || !projects[0].path) return;
    try {
      var s = _qgsNs();
      // ★ setNow 确保 Ctrl+R 前已刷盘（非 debounced set）
      if (s) {
        if (s.setNow) s.setNow('last_main_folder', projects[0].path).catch(function () { });
        else s.set('last_main_folder', projects[0].path).catch(function () { });
      }
    } catch (_) { }
  }

  function _restoreLastMainFolder() {
    try {
      var s = _qgsNs();
      if (!s) return;
      s.get('last_main_folder').then(function (folderPath) {
        if (!folderPath || typeof folderPath !== 'string') return;
        folderPath = _normPath(folderPath);
        // ★ 死路径校验: 本地记忆指向已删除目录 → 空白窗口（用户手动添加自愈），防面板永久空转
        _pathExists(folderPath).then(function (exists) {
          if (!exists) return;
          if (projects.some(function (p) { return p.path === folderPath; })) return;
          projects.push({ path: folderPath, name: basename(folderPath) });
          _bumpRecent(folderPath);
          _restoreFormationFromOnlyStore(folderPath);
          // ★ 此时 projects[0] 已就位，加载排序偏好 + 视口状态
          _loadSortPrefs();
          _loadViewportState();
          saveProjects();
          render();
          _notifyChanged();
          _restoreRecentsFromOs();
          // ★ 降级链同样锁自检（2026-08-13）：主文件夹被占用 → 清空视口
          _verifyFolderLock(folderPath);
        });
      }).catch(function () { });
    } catch (_) { }
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
            // ★ 2026-08-20: fresh 窗口同样恢复出战阵营（OS 优先 → only.sq3 兜底）
            _restoreFormationForMain(folderPath);
          }
        } catch (_) { }
      }
      return;
    }
    // restore 模式（?restore=1&folder=xxx）：从 URL 取主文件夹，only.sq3 恢复阵营
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
            // ★ 2026-08-20: restore 统一走 OS 优先链（旧只查 only.sq3, OS 权威数据丢失）
            _restoreFormationForMain(rFolderPath);
          }
        } catch (_) { }
      }
      render();
      _notifyChanged();
      return;
    }
    // ★ 空白启动：启动目录 global.sq3 优先 → OS ws.sq3 兑底回写（本地优先，跨包不串）
    _restoreWorkspaceLocalFirst();
  }

  // ★ 出战阵营持久化：写入主项目的 only.sq3（项目级资产，随目录迁移）
  function _saveFormationToOnlyStore() {
    var mainProj = projects[0];
    if (!mainProj || !mainProj.path) return;
    try {
      if (!window.qgs || typeof window.qgs.project !== 'function') return;
      var onlyPath = mainProj.path.replace(/\\/g, '/').replace(/\/$/, '') + '/_qqq/alphal/only.sq3';
      var auxPaths = [];
      for (var i = 1; i < projects.length; i++) {
        auxPaths.push(projects[i].path);
      }
      var onlyDb = window.qgs.project(onlyPath, 'qqq.only', { v: 1, form: 'doc' });
      if (onlyDb) onlyDb.set('ai.formation', auxPaths).catch(function () { });
    } catch (_) { }
  }

  // ★ 主文件夹阵营恢复统一入口（2026-08-20 定案: 加号选中 / restore / fresh 三路径共用）
  //   链: OS ws.sq3 formation.{main} 优先（工作空间唯一真理源）→ only.sq3 ai.formation 兜底（项目资产）
  //   收尾统一 saveProjects: formation 一次写完整（杜绝 "先写空再补" 瞬时污染 → 恢复失败永久丢失 b/c）
  //   调用方必须传主文件夹路径（内部 _normPath 归一, 与 _saveWorkspaceToOs 写入 key 同形态）
  function _restoreFormationForMain(mainFolderPath) {
    mainFolderPath = _normPath(mainFolderPath);
    var ws = _wsBridge();
    var fromOnly = function () { _restoreFormationFromOnlyStore(mainFolderPath); };
    if (!ws) { fromOnly(); return; }
    ws.get(WS_FORM_PREFIX + mainFolderPath).then(function (auxs) {
      if (!auxs || !Array.isArray(auxs)) { fromOnly(); return; }
      // OS 权威（含空数组 = 用户明确无辅文件夹, 不走 only.sq3 兜底）
      for (var _fi = 0; _fi < auxs.length; _fi++) {
        var _fp = _normPath(auxs[_fi]);
        if (!_fp || projects.some(function (p) { return p.path === _fp; })) continue;
        projects.push({ path: _fp, name: basename(_fp) });
      }
      _dedupProjects();
      saveProjects();
      render();
      _notifyChanged();
    }).catch(function () { fromOnly(); });
  }

  // ★ 从主项目 only.sq3 恢复出战阵营（项目级资产，跨重启/跨迁移）
  function _restoreFormationFromOnlyStore(mainFolderPath) {
    try {
      if (!window.qgs || typeof window.qgs.project !== 'function') return;
      var onlyPath = mainFolderPath.replace(/\\/g, '/').replace(/\/$/, '') + '/_qqq/alphal/only.sq3';
      var onlyDb = window.qgs.project(onlyPath, 'qqq.only', { v: 1, form: 'doc' });
      if (!onlyDb) return;
      onlyDb.get('ai.formation').then(function (auxPaths) {
        if (!auxPaths || !Array.isArray(auxPaths) || auxPaths.length === 0) return;
        _dedupProjects();
        for (var i = 0; i < auxPaths.length; i++) {
          var aux = auxPaths[i];
          if (typeof aux !== 'string' || !aux) continue;
          if (!projects.some(function (p) { return p.path === aux; })) {
            projects.push({ path: aux, name: basename(aux) });
          }
        }
        saveProjects();
        render();
        _notifyChanged();
      }).catch(function () { });
    } catch (_) { }
  }

  // ★ 去重兜底：确保 projects 中无重复路径
  function _dedupProjects() {
    var seen = {};
    var clean = [];
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i].path;
      if (!seen[p]) { seen[p] = true; clean.push(projects[i]); }
    }
    if (clean.length !== projects.length) {
      console.warn('[ai-viewport] dedup: ' + projects.length + ' → ' + clean.length);
      projects = clean;
      return true;
    }
    return false;
  }

  function saveProjects() {
    _dedupProjects();
    _saveFormationToOnlyStore();
    _persistLastMainFolder();
    // ★ OS 级工作空间唯一真理（异常退出不丢）
    _saveWorkspaceToOs();
  }
  // beforeunload：阵营 + recent + 排序偏好 + 视口状态 + 上次主文件夹同步刷盘
  window.addEventListener('beforeunload', function () {
    try {
      if (_recentFolders.length > 0) {
        var s = _qgsNs();
        if (s) s.setNow(RECENT_KEY, _recentFolders).catch(function () { });
      }
      _persistLastMainFolder();
      // 阵营 + 树展开快照 → only.sq3（项目资产）
      var mainProj = projects[0];
      if (mainProj && mainProj.path && window.qgs && typeof window.qgs.project === 'function') {
        var onlyPath = mainProj.path.replace(/\\/g, '/').replace(/\/$/, '') + '/_qqq/alphal/only.sq3';
        var onlyDb = window.qgs.project(onlyPath, 'qqq.only', { v: 1, form: 'doc' });
        if (onlyDb && onlyDb.setNow) {
          var auxPaths = [];
          for (var i = 1; i < projects.length; i++) { auxPaths.push(projects[i].path); }
          onlyDb.setNow('ai.formation', auxPaths);
          onlyDb.setNow(TREE_SNAPS_KEY, _treeSnapshots);
        }
      }
      // 排序偏好 + 滚动位置 → OS 级 ai.sq3（key=目录绝对路径，跨项目一致）
      var os = _osBridge();
      if (os) {
        os.set(SORT_PREFS_KEY, _sortPrefByPath).catch(function () { });
        os.set(SCROLL_POS_KEY, _scrollPosByPath).catch(function () { });
      }
      // ★ OS 级工作空间唯一真理（beforeunload 同步刷盘）
      _saveWorkspaceToOs();
    } catch (_) { }
  });
  // ---- close active dropdown: save snapshot then destroy ----
  function closeDropdown() {
    // ★ 关闭前快照：将当前展开路径链存入 _treeSnapshots → 持久化
    if (activeDropdown && activeDropdown._projectRoot) {
      if (activeDropdown._expandedChain && activeDropdown._expandedChain.length > 0) {
        _treeSnapshots[activeDropdown._projectRoot] = activeDropdown._expandedChain.slice();
        _saveViewportState();
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

  // ---- 滚动容器包装：外层不滚 + 自定义变形滚动条（照抄 q3 roam）----
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
    sbOuter.style.cssText = 'position:absolute; right:0; top:0; bottom:0; width:12px; z-index:50; pointer-events:none; background:var(--base2);';
    var sbThumb = document.createElement('div');
    sbThumb.className = 'qh-scroll-thumb';
    function _qhCol() {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { c: isDark ? '#fff' : '#000' };
    }
    var _co = _qhCol();
    sbThumb.style.cssText = 'position:absolute; right:2px; width:3px; min-height:20px; border-radius:0; ' +
      'display:none; background:' + _co.c + '; cursor:pointer; opacity:0.6; forced-color-adjust:none; pointer-events:auto; ' +
      'transition: width 0.1s ease, right 0.1s ease, opacity 0.1s ease;';
    var _sbDragging = false;   // ★ F107: 拖拽期间保持粗态，光标移出滑轨 x 范围也不收缩
    sbOuter.addEventListener('mouseenter', function () {
      sbThumb.style.width = '12px'; sbThumb.style.right = '0'; sbThumb.style.opacity = '1';
    });
    sbOuter.addEventListener('mouseleave', function () {
      if (_sbDragging) return;
      sbThumb.style.width = '3px'; sbThumb.style.right = '2px'; sbThumb.style.opacity = '0.6';
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
    inner.addEventListener('scroll', function () {
      _syncSB();
      if (inner._dirPath) { _scrollPosByPath[inner._dirPath] = inner.scrollTop; }
      _scheduleScrollPersist();
    });
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
      _sbDragging = true;   // ★ F107: 抓住即粗
      sbThumb.style.width = '12px'; sbThumb.style.right = '0'; sbThumb.style.opacity = '1';
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
    document.addEventListener('mouseup', function (e) {
      if (!_dr) return;
      _dr = false; _sbDragging = false;
      // 松开：光标仍落在滑轨上 → 保持粗态；已离开 → 收缩
      var at = (e && e.clientX != null) ? document.elementFromPoint(e.clientX, e.clientY) : null;
      if (at && sbOuter.contains(at)) {
        sbThumb.style.width = '12px'; sbThumb.style.right = '0'; sbThumb.style.opacity = '1';
      } else {
        sbThumb.style.width = '3px'; sbThumb.style.right = '2px'; sbThumb.style.opacity = '0.6';
      }
    });
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
    // ★ 最顶层列表也加筛选框
    var filterBar = _createFilterBar(ddScroll, project.path);
    dd.insertBefore(filterBar, dd.firstChild);
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
    parentEl._dirPath = dirPath;  // ★ 标记路径，供滚动保存+快照还原
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
      row._dirFullPath = pathJoin(dirPath, ent.name);  // ★ 全路径标记，供快照还原精确匹配
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
          // ★ 每目录快照：记住最后展开的子目录
          _lastHoveredSubdirByPath[dirPath] = ent.name;
          const sub = openSubmenu(row, subPath, depth, projectRoot);        if (sub) {
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
        if (_ctxMenuRow) _ctxMenuRow.style.cssText = _ctxMenuRow._origRowStyle;
        _setRowHighlight(row);
        if (ent.isDir) {
          // 文件夹：右键 → 打开新搜索标签（多实例）
          if (window.qqqideOpenSearch) window.qqqideOpenSearch(fullPath, true);
        } else {
          // 文件：右键 → 弹出文件上下文菜单
          showFileContextMenu(e, fullPath, projectRoot);
        }
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
          // 先精确匹配完整相对路径（含父级路径，防同名目录串号），再降级匹配 basename
          var matchName = targetName;
          var fullRel = pathJoin(dirPath, targetName).replace(/\\/g, '/');
          var rowFull = (rows3[ri3]._dirFullPath || pathJoin(dirPath, rows3[ri3].dataset.name)).replace(/\\/g, '/');
          if (rowFull === fullRel) { foundRow = rows3[ri3]; break; }
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
      parentEl._pendingChainRestored = true;  // ★ 标记旧系统已完成还原
      // 无论是否找到匹配行，清理链防止残留
      parentEl._pendingChain = null;
    }
    // ★ 每目录独立快照还原：旧系统未处理时，按每个目录自己记忆的最终子目录展开
    if (!parentEl._pendingChainRestored) {
      var savedChild = _lastHoveredSubdirByPath[dirPath];
      if (savedChild && (parentEl._depth || 0) < 20) {
        var rows5 = parentEl.querySelectorAll(':scope > .aiv-dd-row');
        for (var ri5 = 0; ri5 < rows5.length; ri5++) {
          if (rows5[ri5].dataset.isDir === 'true' && rows5[ri5].dataset.name === savedChild &&
              rows5[ri5].style.display !== 'none') {
            var subPath5 = pathJoin(dirPath, savedChild);
            var depth5 = (parentEl._depth || 0) + 1;
            var outer5 = parentEl._outer || parentEl;
            if (outer5._childSub) { closeSubmenuTree(outer5._childSub); }
            outer5._childSub = null;
            var sub5 = openSubmenu(rows5[ri5], subPath5, depth5, projectRoot);
            if (sub5) {
              sub5._justOpened = Date.now();
              outer5._childSub = sub5;
              // ★ 还原下级列表的滚动位置
              if (_scrollPosByPath[subPath5] !== undefined) {
                var si5 = sub5.querySelector('.aiv-scroll-inner');
                if (si5) {
                  var c5 = setInterval(function () {
                    if (si5.scrollHeight > _scrollPosByPath[subPath5] || si5.scrollHeight <= si5.clientHeight) {
                      si5.scrollTop = Math.min(_scrollPosByPath[subPath5], si5.scrollHeight);
                      clearInterval(c5);
                    }
                  }, 50);
                  setTimeout(function () { clearInterval(c5); }, 2000);
                }
              }
            }
            break;
          }
        }
      }
    }
    // ★ 还原本列表的滚动位置
    if (_scrollPosByPath[dirPath] !== undefined) {
      parentEl.scrollTop = Math.min(_scrollPosByPath[dirPath], parentEl.scrollHeight || 0);
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
    // 所有层级统一用黄色 f0e9a0；暗主题方向成对
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      sub.style.setProperty('background', goRight ? '#1e211e' : '#232a23', 'important');
    } else {
      sub.style.setProperty('background', '#f0e9a0', 'important');
    }
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
    sub._projectRoot = projectRoot;  // ★ 必须在 filterBar 之前设置，sort 按钮需要

    var subScroll = _wrapScrollContainer(sub, sub._depth);
    // ★ 子列表也加筛选框
    var filterBar2 = _createFilterBar(subScroll, dirPath);
    sub.insertBefore(filterBar2, sub.firstChild);
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
    return sub;
  }

  // ---- render: blocks ----
  function render() {
    if (!container) return;
    container.innerHTML = '';
    _dedupProjects(); // ★ 兜底：渲染前强制去重，防异步竞态导入重复项目

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

    // git uncommitted badge
    var badge = document.createElement('span');
    badge.className = 'aiv-git-badge';
    badge.style.display = 'none';
    badge.textContent = '';
    _gitBadgeEls[proj.path] = badge;
    block.appendChild(badge);

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
    _dedupProjects(); // ★ 先去重，再判断重复
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
    // ★ 空视口 → 该文件夹将成为主文件夹（2026-08-20 修复: 随从阵营丢失）
    //   旧逻辑立即 saveProjects → formation.{main} 被写空（projects 只有主文件夹）
    //   → 异步恢复又覆盖（瞬时污染, 恢复失败则 b/c 永久丢失）。
    //   现先渲染主文件夹, 阵营恢复完成后才统一落盘（formation 一次写完整）。
    var becameMain = projects.length === 0;
    projects.push({ path: folderPath, name: name });
    _bumpRecent(folderPath);
    if (becameMain) {
      render();
      _notifyChanged();
      _restoreFormationForMain(folderPath);
      return;
    }
    saveProjects();
    render();
    _notifyChanged();
  }

  // 空视口添加主文件夹前的锁预检（2026-08-10 改 query：主进程原子仲裁先行，此处仅预检展示层）
  function _verifyFolderLockBeforeAdd(folderPath, name) {
    var pl = bridge && bridge.projectLock;
    if (!pl) { _doAddProject(folderPath, name); return; }
    pl.query(folderPath).then(function (res) {
      if (res && res.locked && !res.self) {
        // 其他实例活锁 → 拒绝添加
        console.warn('[ai-viewport] lock pre-check failed for ' + folderPath + ' (pid=' + (res.holder && res.holder.pid) + ')');
        if (window.qqqideQoast) {
          window.qqqideQoast.show('⚠️ 该项目已在另一个窗口作为主文件夹打开', { duration: 6000, type: 'warn' });
        }
        return;
      }
      // 无锁 / 僵尸锁 / 本实例自己的锁 → 允许添加（最终仲裁 = 面板 claimProject）
      _doAddProject(folderPath, name);
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
    _loadSortPrefs();
    _loadViewportState();
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

    // ★ 跨窗口同步 (2026-08-07 F3): 其他窗口写入 OS ai.sq3 → 广播 → 本窗口内存态跟随
    if (bridge.aiState && bridge.aiState.onChanged) {
      bridge.aiState.onChanged(function (msg) {
        if (!msg || msg.deleted) return;
        if (msg.key === SORT_PREFS_KEY && typeof msg.value === 'object') {
          _sortPrefByPath = msg.value;
        } else if (msg.key === SCROLL_POS_KEY && typeof msg.value === 'object') {
          _scrollPosByPath = msg.value;
        }
      });
    }

    // ★ git badge 轮询
    _startGitBadgePolling();
    // Escape 键关闭（任何情况下都可操作）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeDropdown) _dismissDropdown();
    });
    // 窗口失焦轮询兜底（100ms 间隔）
    setInterval(function () {
      if (activeDropdown && !document.hasFocus()) _dismissDropdown();
    }, 100);

  }

  // ★ 锁冲突全清（2026-08-13 定案）：主文件夹被占用 → 清空整个视口（干净新窗口）。
  //   幂等：projects 已空直接返回。同时清除恢复源（global last_main_folder + OS
  //   lastMainFolder/formation），防下次启动又恢复同一被锁项目 → 无限残血。
  //   only.sq3 ai.formation 不动（项目资产，占用方窗口仍在用，其保存 LWW 收敛）。
  function clearAllProjects(blockedPath) {
    if (projects.length === 0) return false;
    var blocked = blockedPath || (projects[0] && projects[0].path) || '';
    console.warn('[ai-viewport] lock conflict on MAIN project, clearing entire viewport: ' + blocked);
    projects = [];
    closeDropdown();
    // 清除恢复源（防下次启动又恢复被锁项目）
    try {
      var s = _qgsNs();
      if (s && s.del) { s.del('last_main_folder').catch(function () { }); }
    } catch (_) { }
    var ws = _wsBridge();
    if (ws) {
      if (blocked) { ws.del(WS_FORM_PREFIX + _normPath(blocked)).catch(function () { }); }
      ws.del(WS_LAST_KEY).catch(function () { });
    }
    saveProjects(); // projects 空 → 空守卫不写 only.sq3/lastMainFolder，只收敛
    render();
    _notifyChanged();
    if (window.qqqideQoast) {
      window.qqqideQoast.show('⚠️ 主文件夹已被另一窗口占用，AI 视口已清空为干净窗口', { duration: 6000, type: 'warn' });
    }
    return true;
  }

  // 监听 AI 面板发来的锁冲突通知：从视口移除被锁的项目 / 清空整个视口
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'qqq-ai-viewport-clear-all') {
      // ★ 面板 claim 失败/锁丢失重仲裁失败兜底 → 清空整个视口（幂等）
      clearAllProjects(e.data.path);
      return;
    }
    if (e.data && e.data.type === 'qqq-ai-viewport-remove-project' && e.data.path) {
      var p = e.data.path;
      var idx = -1;
      for (var i = 0; i < projects.length; i++) {
        if (projects[i].path === p) { idx = i; break; }
      }
      if (idx > 0) {
        console.warn('[ai-viewport] lock conflict: removing project ' + p);
        projects.splice(idx, 1);
        saveProjects();
        render();
        _notifyChanged();
      } else if (idx === 0) {
        // ★ 主文件夹不可因锁冲突移除（F-2026-08-06）：移除即 AI 面板绑定错乱 + quest 全空
        console.warn('[ai-viewport] lock conflict on MAIN project ' + p + ', keeping');
      }
    }
  });

  // ★ 焦点面板路由：文件附加到当前金色 q2 的 AI 面板
  window.__qqq_aiTarget = 1;  // 默认中面板
  window.__qqq_updateAiTarget = function (n) {
    if (typeof n === 'number' && n >= 0 && n <= 2) window.__qqq_aiTarget = n;
  };
  // （attachToAi 在模块顶部统一定义，此处不再重复）

  // ★ 暴露清除所有快照的入口
  function clearSnapshots() {
    _lastHoveredSubdirByPath = {};
    _scrollPosByPath = {};
    var os = _osBridge();
    if (os) { os.set(SCROLL_POS_KEY, _scrollPosByPath).catch(function () { }); }
  }
  window.qqqideViewport = { build, addProject, removeProject, getProjects, getMainProject, closeDropdown, clearSnapshots, clearAllProjects };
})();
