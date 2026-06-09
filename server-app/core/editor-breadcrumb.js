// ============================================================================
// editor-breadcrumb.js — 编辑器面包屑导航条
//
// 在编辑器顶部显示文件路径面包屑，支持：
//   1. 路径段点击 → 弹出目录列表（可逐级深入）
//   2. 文件名段点击 → 触发 Monaco 内置面包屑（文档大纲）
//   3. 右侧工具图标区 → undo/redo 按钮（支持按住连点）
//
// API: window.qqqEditorBreadcrumb = { create(host, filePath, monacoEditor, monaco) }
// ============================================================================
(function () {
  'use strict';

  var bridge = window.qqqideBridge;
  var i18n = window._i;

  // ── 按住连点引擎 ──
  var _repeatTimer = null;
  var _repeatInterval = null;

  function startRepeat(callback) {
    stopRepeat();
    _repeatTimer = setTimeout(function () {
      _repeatTimer = null;
      try { callback(); } catch (_) { }
      _repeatInterval = setInterval(function () {
        try { callback(); } catch (_) { }
      }, 50);
    }, 300);
  }

  function stopRepeat() {
    if (_repeatTimer) { clearTimeout(_repeatTimer); _repeatTimer = null; }
    if (_repeatInterval) { clearInterval(_repeatInterval); _repeatInterval = null; }
  }

  // ── 关闭所有弹出层 ──
  function closeAllPopups() {
    document.querySelectorAll('.qqq-bc-popup').forEach(function (p) { p.remove(); });
  }

  // ── 目录列表弹出层 ──
  function showDirPopup(anchorEl, dirPath, onNavigate) {
    closeAllPopups();

    var pop = document.createElement('div');
    pop.className = 'qqq-bc-popup';
    pop.style.cssText =
      'position:fixed; z-index:99990; min-width:200px; max-width:420px; max-height:320px; ' +
      'overflow-y:auto; overflow-x:hidden; ' +
      'background:var(--card-bg); border:1px solid var(--border-color); border-radius:4px; ' +
      'box-shadow:0 6px 24px rgba(0,0,0,.22); padding:4px 0; font-size:13px;';

    var rect = anchorEl.getBoundingClientRect();
    pop.style.left = rect.left + 'px';
    pop.style.top = (rect.bottom + 4) + 'px';

    pop.innerHTML = '<div style="padding:12px 16px; color:var(--text-secondary);">' +
      (i18n ? i18n('common.loading', '加载中...') : '...') + '</div>';
    document.body.appendChild(pop);

    bridge.fs.list(dirPath).then(function (entries) {
      entries.sort(function (a, b) {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

      pop.innerHTML = '';

      // 父目录
      var normPath = dirPath.replace(/[\\/]$/, '');
      var parentPath = normPath.replace(/[\\/][^\\/]+$/, '');
      var sep = dirPath.indexOf('\\') >= 0 ? '\\' : '/';
      if (parentPath && parentPath !== normPath) {
        var backItem = mkPopupItem('..', function () {
          closeAllPopups();
          showDirPopup(anchorEl, parentPath + sep, onNavigate);
        }, 'var(--text-secondary)');
        pop.appendChild(backItem);
      }

      if (entries.length === 0) {
        var emptyItem = document.createElement('div');
        emptyItem.style.cssText = 'padding:12px 16px; color:var(--text-secondary);';
        emptyItem.textContent = i18n ? i18n('common.empty', '(空)') : '(空)';
        pop.appendChild(emptyItem);
      } else {
        entries.forEach(function (entry) {
          var fullPath = normPath + sep + entry.name;
          var item = mkPopupItem(
            (entry.isDir ? '\uD83D\uDCC1 ' : '\uD83D\uDCC4 ') + entry.name,
            function () {
              closeAllPopups();
              if (entry.isDir) {
                showDirPopup(anchorEl, fullPath + sep, onNavigate);
              } else {
                // 通过标准事件打开文件，确保 onRender 等完整流程
                document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: fullPath } }));
              }
            },
            entry.isDir ? 'var(--text-primary)' : 'var(--text-secondary)'
          );
          if (entry.isDir) item.style.fontWeight = '600';
          pop.appendChild(item);
        });
      }
    }).catch(function () {
      pop.innerHTML = '<div style="padding:12px 16px; color:var(--text-error);">' +
        (i18n ? i18n('common.error', '读取失败') : '读取失败') + '</div>';
    });

    // 外部点击关闭
    setTimeout(function () {
      document.addEventListener('mousedown', function onDoc(e) {
        if (!pop.contains(e.target)) {
          closeAllPopups();
          document.removeEventListener('mousedown', onDoc);
        }
      });
    }, 0);
  }

  function mkPopupItem(text, onClick, color) {
    var item = document.createElement('div');
    item.className = 'qqq-bc-popup-item';
    item.style.cssText =
      'padding:6px 16px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; ' +
      'color:' + (color || 'var(--text-primary)') + '; user-select:none;';
    item.textContent = text;
    item.addEventListener('mouseenter', function () { item.style.background = 'var(--background-color)'; });
    item.addEventListener('mouseleave', function () { item.style.background = ''; });
    item.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
    return item;
  }

  // ── 触发 Monaco 内置面包屑（文档大纲） ──
  function triggerMonacoBreadcrumbs(monacoEditor) {
    try {
      var bc = monacoEditor.getContribution('editor.contrib.breadcrumbs');
      if (bc) {
        if (typeof bc.toggle === 'function') { bc.toggle(); return; }
        if (typeof bc.show === 'function') { bc.show(); return; }
        if (bc.widget && bc.widget._items && bc.widget._items.length > 0) {
          var lastItem = bc.widget._items[bc.widget._items.length - 1];
          if (lastItem && typeof lastItem.onClick === 'function') { lastItem.onClick(); return; }
        }
      }
      var domNode = monacoEditor.getDomNode();
      if (domNode) {
        var bcDom = domNode.querySelector('.monaco-breadcrumbs');
        if (bcDom) {
          var items = bcDom.querySelectorAll('.monaco-breadcrumb-item');
          if (items.length > 0) { items[items.length - 1].click(); return; }
        }
      }
    } catch (_) { }
  }

  // ── 解析路径段 ──
  function parsePathSegments(filePath) {
    if (!filePath) return [{ name: '(未命名)', fullPath: '' }];
    var isWin = filePath.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(filePath);
    var sep = isWin ? '\\' : '/';
    var parts = filePath.replace(/[\\/]+$/, '').split(sep);
    if (isWin && parts.length > 0 && /^[A-Za-z]:$/.test(parts[0])) {
      parts[0] = parts[0] + '\\';
    }
    var segments = [];
    var cumulative = '';
    for (var i = 0; i < parts.length; i++) {
      cumulative = i === 0 ? parts[0] : cumulative + sep + parts[i];
      segments.push({ name: parts[i], fullPath: cumulative });
    }
    return segments;
  }

  // ── 创建面包屑条 ──
  function createBreadcrumbBar(hostPane, filePath, monacoEditor, monaco) {
    // 清理旧元素
    var existingBar = hostPane.querySelector('.qqq-editor-breadcrumb-bar');
    if (existingBar) existingBar.remove();
    var existingContainer = hostPane.querySelector('.qqq-editor-monaco-container');
    if (existingContainer) {
      var monacoDom = existingContainer.querySelector('.monaco-editor');
      if (monacoDom && monacoDom.parentNode === existingContainer && existingContainer.parentNode === hostPane) {
        hostPane.appendChild(monacoDom);
      }
      existingContainer.remove();
    }

    // 设置 hostPane 为 flex 列布局
    hostPane.style.display = 'flex';
    hostPane.style.flexDirection = 'column';
    hostPane.style.overflow = 'hidden';

    // ── 面包屑条 ──
    var bar = document.createElement('div');
    bar.className = 'qqq-editor-breadcrumb-bar';

    // 左侧路径区
    var pathEl = document.createElement('div');
    pathEl.className = 'qqq-editor-breadcrumb-path';

    var segments = parsePathSegments(filePath);

    function renderSegments() {
      pathEl.innerHTML = '';
      segments.forEach(function (seg, i) {
        var isLast = i === segments.length - 1;

        if (i > 0) {
          var sepSpan = document.createElement('span');
          sepSpan.className = 'qqq-editor-breadcrumb-sep';
          sepSpan.textContent = '\u203A';
          sepSpan.style.cssText = 'color:var(--text-secondary); opacity:0.5; flex-shrink:0; margin:0 2px;';
          pathEl.appendChild(sepSpan);
        }

        var segEl = document.createElement('span');
        segEl.className = 'qqq-editor-breadcrumb-seg';
        segEl.textContent = seg.name;
        segEl.title = seg.fullPath;
        segEl.style.cssText =
          'cursor:pointer; white-space:nowrap; padding:2px 4px; border-radius:3px;' +
          (isLast ? 'font-weight:600;' : '');

        segEl.addEventListener('mouseenter', function () { segEl.style.background = 'var(--background-color)'; });
        segEl.addEventListener('mouseleave', function () { segEl.style.background = ''; });

        segEl.addEventListener('click', function (e) {
          e.stopPropagation();
          if (isLast) {
            triggerMonacoBreadcrumbs(monacoEditor);
          } else {
            showDirPopup(segEl, seg.fullPath, function () {});
          }
        });

        pathEl.appendChild(segEl);
      });
    }

    renderSegments();

    // 右侧工具区
    var toolsEl = document.createElement('div');
    toolsEl.className = 'qqq-editor-breadcrumb-tools';

    // Undo
    var undoBtn = document.createElement('button');
    undoBtn.className = 'qqq-editor-breadcrumb-btn';
    undoBtn.title = i18n ? i18n('editor.undo', '撤销 (Ctrl+Z)') : '撤销 (Ctrl+Z)';
    undoBtn.textContent = '\u21A9';
    undoBtn.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      try { monacoEditor.trigger('keyboard', 'undo', null); } catch (_) { }
      startRepeat(function () {
        try { monacoEditor.trigger('keyboard', 'undo', null); } catch (_) { }
      });
    });
    undoBtn.addEventListener('mouseup', stopRepeat);
    undoBtn.addEventListener('mouseleave', stopRepeat);
    undoBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // Redo
    var redoBtn = document.createElement('button');
    redoBtn.className = 'qqq-editor-breadcrumb-btn';
    redoBtn.title = i18n ? i18n('editor.redo', '重做 (Ctrl+Y)') : '重做 (Ctrl+Y)';
    redoBtn.textContent = '\u21AA';
    redoBtn.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      try { monacoEditor.trigger('keyboard', 'redo', null); } catch (_) { }
      startRepeat(function () {
        try { monacoEditor.trigger('keyboard', 'redo', null); } catch (_) { }
      });
    });
    redoBtn.addEventListener('mouseup', stopRepeat);
    redoBtn.addEventListener('mouseleave', stopRepeat);
    redoBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    toolsEl.appendChild(undoBtn);
    toolsEl.appendChild(redoBtn);
    bar.appendChild(pathEl);
    bar.appendChild(toolsEl);

    // ── Monaco 容器 ──
    var monacoContainer = document.createElement('div');
    monacoContainer.className = 'qqq-editor-monaco-container';

    // 将 Monaco 编辑器 DOM 移入容器
    var monacoDom = monacoEditor.getDomNode();
    if (monacoDom && monacoDom.parentNode === hostPane) {
      monacoContainer.appendChild(monacoDom);
    }

    hostPane.appendChild(bar);
    hostPane.appendChild(monacoContainer);

    return bar;
  }

  // ── 公开 API ──
  window.qqqEditorBreadcrumb = {
    create: createBreadcrumbBar,
    closeAllPopups: closeAllPopups,
  };

})();
