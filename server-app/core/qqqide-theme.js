// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqqide-theme.js — 唯一真理配色机器
//
// 铁律：
//   1. 整个 IDE 的一切配色，必须经由此机器。任何组件不得私自定义颜色。
//   2. 只支持 Solarized Light 和 Solarized Dark 两种主题。
//   3. 配色照抄 q2.html；editor token 照抄 VS Code solarized-light/dark。
//   4. forced-color-adjust:none 破系统高对比度。
//   5. 性能至上：零依赖，同步注入，单次 CSS 变量批量设置。
//
// API:
//   window.qqqideTheme.PALETTE          — 当前调色板（只读）
//   window.qqqideTheme.isDark()         — 当前是否暗色
//   window.qqqideTheme.apply(dark)      — 切换主题（唯一入口）
//   window.qqqideTheme.onChange(fn)     — 订阅主题变更
//   window.qqqideTheme.getMonacoTheme() — 返回 'solarized-light'|'solarized-dark'
//   window.qqqideTheme.defineMonacoThemes(monaco) — 向 Monaco 注册两个主题
//   window.qqqideTheme.injectTo(iframeDoc) — 向 iframe 注入 CSS 变量
// ============================================================================

(function () {
  'use strict';
  if (window.qqqideTheme) return; // 幂等：已初始化则跳过

  // ==========================================================================
  // §1 配色盘 — 精确照抄 q2.html
  // ==========================================================================
  const SOLARIZED_LIGHT = Object.freeze({
    base03: '#002d20', base02: '#07362e', base01: '#777777', base00: '#7a7874',
    base0: '#7a7874', base1: '#a8a6a2', base2: '#eee8d5', base3: '#fdf6e3',
    yellow: '#b58900', orange: '#cb4b16', red: '#dc322f', magenta: '#c83070',
    violet: '#7e6c8e', blue: '#e8a030', cyan: '#2a9a78', green: '#859900',
  });

  const SOLARIZED_DARK = Object.freeze({
    base03: '#fdf6e3', base02: '#eee8d5', base01: '#97978a', base00: '#c8c4b8',
    base0: '#a8a49c', base1: '#6a6660', base2: '#2a2a2a', base3: '#1e1e1e',
    yellow: '#d4a017', orange: '#e07020', red: '#ff4444', magenta: '#b85872',
    violet: '#a08060', blue: '#d4a017', cyan: '#5ab890', green: '#8fbc5a',
  });

  // ==========================================================================
  // §2 语义变量推导 — 照抄 q2.html 的角色映射
  // ==========================================================================
  function buildSemanticVars(p, dark) {
    return {
      // 基础色盘（组件可直接引用）
      '--base03': p.base03, '--base02': p.base02, '--base01': p.base01,
      '--base00': p.base00, '--base0': p.base0, '--base1': p.base1,
      '--base2': p.base2, '--base3': p.base3,
      '--yellow': p.yellow, '--orange': p.orange, '--red': p.red,
      '--magenta': p.magenta, '--violet': p.violet, '--blue': p.blue,
      '--cyan': p.cyan, '--green': p.green,

      // 语义角色（一切组件只应引用这些）
      '--background-color': dark ? '#1e1e1e' : p.base3,
      '--card-bg': dark ? '#2a2a2a' : p.base2,
      '--quest-tofu-bg': dark ? '#211f1c' : '#ebe3ca',  // 置顶卡片背景（暖米色，介于 base2/base3 之间）
      '--text-primary': dark ? '#dcd8d0' : '#656360',
      '--text-secondary': dark ? '#a8a49c' : p.base01,
      '--text-dim': dark ? '#6a6660' : p.base1,
      '--border-color': dark ? '#333333' : '#d3c6aa',
      '--border-strong': dark ? '#555555' : p.base1,
      '--primary-color': p.yellow,

      // 选择
      '--selection-bg': dark ? '#5a3a2a' : '#e8a090',
      '--selection-text': dark ? '#f0e8d8' : '#000000',

      // 按钮
      '--button-primary': p.blue,
      '--button-text': dark ? '#1e1e1e' : p.base3,

      // Sash 拖拽条
      '--sash-bg': dark ? '#333333' : '#d3c6aa',
      '--sash-bg-hover': dark ? '#6a6660' : p.base1,
      '--sash-bg-active': dark ? '#93a1a1' : p.base01,
      '--sash-saturated': p.red,

      // 图标
      '--icon-subtle': dark ? '#5a5650' : '#c0bab0',

      // 金饰（q2 兼容）
      '--gold-accent': dark ? '#5a4d2a' : '#DEC987',
      '--gold-accent-hover': dark ? '#6a5a30' : '#d4c079',
      '--gold-accent-bg': dark ? '#4a3d20' : 'rgb(223,202,136)',
      '--gold-hover-bg': dark ? '#3a3520' : '#ddca88',
      '--pin-hover-bg': dark ? '#3a3a3a' : '#d3d1c4',

      // tooltip
      '--tooltip-bg': dark ? '#2a2520' : 'rgb(35,30,0)',
      '--tooltip-text': dark ? '#dcd8d0' : p.base2,

      // 布局（JS 可变）
      '--a-zone-w': '123px',
      '--ai-zone-w': '389px',
      '--output-h': '200px',
      '--menu-row-h': '30px',
      '--status-row-h': '24px',
      '--panel-min': '123px',
      '--sash-w': '6px',
      '--tab-bar-h': '24px',
    };
  }

  // ==========================================================================
  // §3 Monaco Editor 主题定义 — 照抄 VS Code solarized-light/dark tokenColors
  // ==========================================================================
  const MONACO_LIGHT_RULES = [
    { token: '', foreground: '5c7060', background: 'FDF6E3' },
    { token: 'comment', foreground: '95958a', fontStyle: 'italic' },
    { token: 'string', foreground: '2a9a78' },
    { token: 'string.regexp', foreground: 'DC322F' },
    { token: 'number', foreground: 'c83070' },
    { token: 'variable', foreground: '4078a0' },
    { token: 'keyword', foreground: '859900' },
    { token: 'storage', foreground: '58685e', fontStyle: 'bold' },
    { token: 'type', foreground: 'CB4B16' },
    { token: 'namespace', foreground: 'CB4B16' },
    { token: 'function', foreground: '4078a0' },
    { token: 'variable.predefined', foreground: 'B58900' },
    { token: 'constant', foreground: 'CB4B16' },
    { token: 'tag', foreground: '4078a0' },
    { token: 'attribute.name', foreground: '95958a' },
    { token: 'support.function', foreground: '4078a0' },
    { token: 'support.type', foreground: '859900' },
    { token: 'support', foreground: '839080' },
    { token: 'invalid', foreground: 'DC322F' },
  ];

  const MONACO_DARK_RULES = [
    { token: '', foreground: 'dcd8d0', background: '1e1e1e' },
    { token: 'comment', foreground: '6a6660', fontStyle: 'italic' },
    { token: 'string', foreground: '8fbc5a' },
    { token: 'string.regexp', foreground: 'ff4444' },
    { token: 'number', foreground: 'b85872' },
    { token: 'variable', foreground: 'd4a017' },
    { token: 'keyword', foreground: '8fbc5a' },
    { token: 'storage', foreground: 'c8c4b8', fontStyle: 'bold' },
    { token: 'type', foreground: 'e07020' },
    { token: 'namespace', foreground: 'e07020' },
    { token: 'function', foreground: 'd4a017' },
    { token: 'variable.predefined', foreground: 'd4a017' },
    { token: 'constant', foreground: 'e07020' },
    { token: 'tag', foreground: 'e07020' },
    { token: 'attribute.name', foreground: 'c8c4b8' },
    { token: 'support.function', foreground: 'd4a017' },
    { token: 'support.type', foreground: '8fbc5a' },
    { token: 'support', foreground: 'a8a49c' },
    { token: 'invalid', foreground: 'ff4444' },
  ];

  // ==========================================================================
  // §4 状态
  // ==========================================================================
  const ROOT = document.documentElement;
  let _dark = false;
  const _listeners = [];

  // ★ 主题持久化 → only.sq3（项目资产，唯一真理源）
  function _themeFolderFromUrl() {
    var m = window.location.search.match(/[?&]folder=([^&]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]).replace(/\\/g, '/').replace(/\/$/, ''); }
      catch (_) { }
    }
    return null;
  }

  function _onlyDb() {
    var root = window._workspaceRoot || _themeFolderFromUrl();
    if (!root || !window.qgs || typeof window.qgs.project !== 'function') return null;
    return window.qgs.project(root + '/_qqq/alphal/only.sq3', 'qqq.only', { v: 1, form: 'doc' });
  }

  function _persist() {
    var db = _onlyDb();
    if (db) db.set('theme', _dark ? 'dark' : 'light').catch(function () { });
  }

  // ★ 从 only.sq3 同步主题（项目切换/首次绑定主文件夹时调用）
  function syncFromProject() {
    var db = _onlyDb();
    if (!db) return;
    db.get('theme').then(function (v) {
      if (v === 'dark' || v === 'light') {
        var target = v === 'dark';
        if (target !== _dark) apply(target);
      }
    }).catch(function () { });
  }

  // ★ 监听 _workspaceRoot 出现，自动同步项目主题
  var _themeWatchTimer = null;
  var _themeRootSynced = false;
  function _watchRoot() {
    if (_themeRootSynced) return;
    if (typeof window._workspaceRoot === 'string' && window._workspaceRoot) {
      _themeRootSynced = true;
      if (_themeWatchTimer) { clearInterval(_themeWatchTimer); _themeWatchTimer = null; }
      syncFromProject();
      return;
    }
    if (!_themeWatchTimer) {
      _themeWatchTimer = setInterval(function () {
        if (typeof window._workspaceRoot === 'string' && window._workspaceRoot) {
          clearInterval(_themeWatchTimer);
          _themeWatchTimer = null;
          _themeRootSynced = true;
          syncFromProject();
        }
      }, 300);
    }
  }
  // 启动监听
  _watchRoot();

  // ==========================================================================
  // §5 CSS 变量批量注入（一次性 innerHTML，零回流）
  // ==========================================================================
  let _styleEl = null;

  function _ensureStyleEl() {
    if (_styleEl) return _styleEl;
    // 防止重复加载
    _styleEl = document.getElementById('qqqide-theme-vars');
    if (_styleEl) return _styleEl;
    _styleEl = document.createElement('style');
    _styleEl.id = 'qqqide-theme-vars';
    document.head.appendChild(_styleEl);
    return _styleEl;
  }

  // Inject :root + [data-theme="dark"] + forced-color-adjust:none
  function _injectCSS(pDark, pLight) {
    const el = _ensureStyleEl();
    const L = buildSemanticVars(pLight, false);
    const D = buildSemanticVars(pDark, true);

    const lightVars = Object.entries(L).map(([k, v]) => `${k}:${v};`).join('');
    const darkVars = Object.entries(D).map(([k, v]) => `${k}:${v};`).join('');

    el.textContent = [
      '/* qqqide-theme — 唯一真理配色机器 */',
      'html{forced-color-adjust:none!important}',
      '@media (forced-colors:active){html,body,*{forced-color-adjust:none!important}}',
      `:root{${lightVars}}`,
      `[data-theme="dark"]{${darkVars}}`,
    ].join('\n');
  }

  // ==========================================================================
  // §6 核心 API
  // ==========================================================================

  function isDark() { return _dark; }

  function getCurrentPalette() { return _dark ? SOLARIZED_DARK : SOLARIZED_LIGHT; }

  function apply(dark) {
    const wasDark = _dark;
    _dark = !!dark;
    if (_dark) {
      ROOT.setAttribute('data-theme', 'dark');
    } else {
      ROOT.removeAttribute('data-theme');
    }
    _persist();

    // 通知 iframe（AI 面板）
    _notifyIframes();

    // 通知 diff 窗口（timeline 等独立 BrowserWindow）
    if (typeof window !== 'undefined' && window.qqqideBridge && window.qqqideBridge.sync) {
      try { window.qqqideBridge.sync.broadcast('theme-change', { dark: _dark }); } catch (_) { }
    }

    // 通知订阅者
    if (wasDark !== _dark) {
      for (const fn of _listeners) {
        try { fn(_dark); } catch (e) { /* 吞掉，不影���主流程 */ }
      }
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return;
    _listeners.push(fn);
    // 返回取消订阅函数
    return () => {
      const i = _listeners.indexOf(fn);
      if (i >= 0) _listeners.splice(i, 1);
    };
  }

  function getMonacoTheme() {
    return _dark ? 'solarized-dark' : 'solarized-light';
  }

  // 向 Monaco 注册两个主题（仅在 monaco 可用时调用）
  function defineMonacoThemes(monaco) {
    if (!monaco || !monaco.editor) return;
    try {
      monaco.editor.defineTheme('solarized-light', {
        base: 'vs',
        inherit: false,
        colors: {
          'editor.background': '#FDF6E3',
          'editor.foreground': '#5c7060',
          'editor.lineHighlightBackground': '#EEE8D5',
          'editorLineNumber.foreground': '#777777',
          'editorCursor.foreground': '#58685e',
          'editor.selectionBackground': '#E8A090',
          'editor.inactiveSelectionBackground': '#E8C8B8',
          'editorOverviewRuler.border': '#00000000',
          // ═══ Find Widget 配色 — Solarized Light ═══
          'focusBorder': '#b58900',
          'editorWidget.background': '#eee8d5',
          'editorWidget.foreground': '#5c7060',
          'editorWidget.border': '#d3c6aa',
          'input.background': '#fdf6e3',
          'input.foreground': '#5c7060',
          'input.border': '#d3c6aa',
          'inputOption.activeBorder': '#b58900',
          'inputOption.activeBackground': '#eee8d5',
          'editor.findMatchBackground': '#e0a010cc',
          'editor.findMatchHighlightBackground': '#e0a01066',
          'editor.findRangeHighlightBackground': '#e0a01025',
        },
        rules: MONACO_LIGHT_RULES,
      });

      monaco.editor.defineTheme('solarized-dark', {
        base: 'vs-dark',
        inherit: false,
        colors: {
          'editor.background': '#1e1e1e',
          'editor.foreground': '#dcd8d0',
          'editor.lineHighlightBackground': '#2a2a2a',
          'editorLineNumber.foreground': '#97978a',
          'editorCursor.foreground': '#c8c4b8',
          'editor.selectionBackground': '#5a3a2a',
          'editor.inactiveSelectionBackground': '#4a3020',
          'editorOverviewRuler.border': '#00000000',
          // ═══ Find Widget 配色 — Solarized Dark ═══
          'focusBorder': '#d4a017',
          'editorWidget.background': '#2a2a2a',
          'editorWidget.foreground': '#dcd8d0',
          'editorWidget.border': '#333333',
          'input.background': '#1e1e1e',
          'input.foreground': '#dcd8d0',
          'input.border': '#555555',
          'inputOption.activeBorder': '#d4a017',
          'inputOption.activeBackground': '#3a3520',
          'editor.findMatchBackground': '#d4a017cc',
          'editor.findMatchHighlightBackground': '#d4a01766',
          'editor.findRangeHighlightBackground': '#d4a01725',
        },
        rules: MONACO_DARK_RULES,
      });
    } catch (e) {
      console.warn('[qqqide-theme] defineMonacoThemes failed:', e && e.message);
    }
  }

  // 向 iframe 注入 CSS 变量（iframe 内部调用此函数）
  function injectTo(iframeDoc) {
    if (!iframeDoc || !iframeDoc.documentElement) return;
    const root = iframeDoc.documentElement;
    const p = getCurrentPalette();
    const vars = buildSemanticVars(p, _dark);
    // 同步 data-theme 属性
    if (_dark) root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    // 注入 forced-color-adjust
    root.style.setProperty('forced-color-adjust', 'none');
    // 批量注入 CSS 变量
    for (const [k, v] of Object.entries(vars)) {
      root.style.setProperty(k, v);
    }
  }

  // 通知所有 iframe
  function _notifyIframes() {
    const frames = document.querySelectorAll('iframe');
    for (const f of frames) {
      try {
        f.contentWindow && f.contentWindow.postMessage({
          type: 'qqqide-theme-change',
          dark: _dark,
        }, '*');
      } catch (_) { }
    }
  }

  // 监听来自 iframe 的请求（iframe onload 时请求初始主题）
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'qqqide-theme-request') {
      // iframe 请求初始主题，回复当前状态
      const src = e.source;
      if (src && src.postMessage) {
        src.postMessage({ type: 'qqqide-theme-change', dark: _dark }, '*');
      }
    }
  });

  // ==========================================================================
  // §7 初始化
  // ==========================================================================
  function init() {
    _injectCSS(SOLARIZED_DARK, SOLARIZED_LIGHT);
    // 默认亮色；_workspaceRoot 就绪后 _watchRoot 自动读取 only.sq3 覆盖
  }

  init();

  // ==========================================================================
  // §8 公开 API
  // ==========================================================================
  window.qqqideTheme = Object.freeze({
    get PALETTE() { return getCurrentPalette(); },
    isDark,
    apply,
    syncFromProject,
    onChange,
    getMonacoTheme,
    defineMonacoThemes,
    injectTo,
  });

})();
