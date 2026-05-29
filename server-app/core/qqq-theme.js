// ============================================================================
// qqq-theme.js — 唯一真理配色机器
//
// 铁律：
//   1. 整个 IDE 的一切配色，必须经由此机器。任何组件不得私自定义颜色。
//   2. 只支持 Solarized Light 和 Solarized Dark 两种主题。
//   3. 配色照抄 q2.html；editor token 照抄 VS Code solarized-light/dark。
//   4. forced-color-adjust:none 破系统高对比度。
//   5. 性能至上：零依赖，同步注入，单次 CSS 变量批量设置。
//
// API:
//   window.qqqTheme.PALETTE          — 当前调色板（只读）
//   window.qqqTheme.isDark()         — 当前是否暗色
//   window.qqqTheme.apply(dark)      — 切换主题（唯一入口）
//   window.qqqTheme.onChange(fn)     — 订阅主题变更
//   window.qqqTheme.getMonacoTheme() — 返回 'solarized-light'|'solarized-dark'
//   window.qqqTheme.defineMonacoThemes(monaco) — 向 Monaco 注册两个主题
//   window.qqqTheme.injectTo(iframeDoc) — 向 iframe 注入 CSS 变量
// ============================================================================

(function () {
  'use strict';
  if (window.qqqTheme) return; // 幂等：已初始化则跳过

  // ==========================================================================
  // §1 配色盘 — 精确照抄 q2.html
  // ==========================================================================
  const SOLARIZED_LIGHT = Object.freeze({
    base03: '#002b36', base02: '#073642', base01: '#777777', base00: '#7a7874',
    base0:  '#7a7874', base1:  '#a8a6a2', base2:  '#eee8d5', base3:  '#fdf6e3',
    yellow: '#b58900', orange: '#cb4b16', red:    '#dc322f', magenta:'#d33682',
    violet: '#6c71c4', blue:   '#e8a030', cyan:   '#2aa198', green:  '#859900',
  });

  const SOLARIZED_DARK = Object.freeze({
    base03: '#fdf6e3', base02: '#eee8d5', base01: '#93a1a1', base00: '#c8c4b8',
    base0:  '#a8a49c', base1:  '#6a6660', base2:  '#2a2a2a', base3:  '#1e1e1e',
    yellow: '#d4a017', orange: '#e07020', red:    '#ff4444', magenta:'#c06080',
    violet: '#a08060', blue:   '#d4a017', cyan:   '#5abfb5', green:  '#8fbc5a',
  });

  // ==========================================================================
  // §2 语义变量推导 — 照抄 q2.html 的角色映射
  // ==========================================================================
  function buildSemanticVars(p, dark) {
    return {
      // 基础色盘（组件可直接引用）
      '--base03': p.base03, '--base02': p.base02, '--base01': p.base01,
      '--base00': p.base00, '--base0':  p.base0,  '--base1':  p.base1,
      '--base2':  p.base2,  '--base3':  p.base3,
      '--yellow': p.yellow, '--orange': p.orange, '--red':    p.red,
      '--magenta':p.magenta,'--violet': p.violet, '--blue':   p.blue,
      '--cyan':   p.cyan,   '--green':  p.green,

      // 语义角色（一切组件只应引用这些）
      '--background-color': dark ? '#1e1e1e'     : p.base3,
      '--card-bg':          dark ? '#2a2a2a'     : p.base2,
      '--text-primary':     dark ? '#d4d0c8'     : p.base00,
      '--text-secondary':   dark ? '#a8a49c'     : p.base01,
      '--text-dim':         dark ? '#6a6660'     : p.base1,
      '--border-color':     dark ? '#333333'     : '#d3c6aa',
      '--border-strong':    dark ? '#555555'     : p.base1,
      '--primary-color':    p.yellow,

      // 选择
      '--selection-bg':   dark ? '#5a3a2a'     : '#e8a090',
      '--selection-text': dark ? '#f0e8d8'     : '#000000',

      // 按钮
      '--button-primary': p.blue,
      '--button-text':    dark ? '#1e1e1e'     : p.base3,

      // Sash 拖拽条
      '--sash-bg':        dark ? '#333333'     : p.base3,
      '--sash-bg-hover':  dark ? '#6a6660'     : p.base1,
      '--sash-bg-active': dark ? '#93a1a1'     : p.base01,
      '--sash-saturated': p.red,

      // 图标
      '--icon-subtle':    dark ? '#5a5650'     : '#c0bab0',

      // 金饰（q2 兼容）
      '--gold-accent':        dark ? '#5a4d2a' : '#DEC987',
      '--gold-accent-hover':  dark ? '#6a5a30' : '#d4c079',
      '--gold-accent-bg':     dark ? '#4a3d20' : 'rgb(223,202,136)',
      '--gold-hover-bg':      dark ? '#3a3520' : '#ddca88',
      '--pin-hover-bg':       dark ? '#3a3a3a' : '#d3d1c4',

      // tooltip
      '--tooltip-bg':   dark ? '#2a2520'       : 'rgb(35,30,0)',
      '--tooltip-text': dark ? '#d4d0c8'       : p.base2,

      // 布局（JS 可变）
      '--a-zone-w':    '220px',
      '--ai-zone-w':   '389px',
      '--output-h':    '200px',
      '--menu-row-h':  '30px',
      '--status-row-h':'24px',
      '--panel-min':   '123px',
      '--sash-w':      '6px',
      '--tab-bar-h':   '30px',
    };
  }

  // ==========================================================================
  // §3 Monaco Editor 主题定义 — 照抄 VS Code solarized-light/dark tokenColors
  // ==========================================================================
  const MONACO_LIGHT_RULES = [
    { token: '', foreground: '657B83', background: 'FDF6E3' },
    { token: 'comment', foreground: '93A1A1', fontStyle: 'italic' },
    { token: 'string', foreground: '2AA198' },
    { token: 'string.regexp', foreground: 'DC322F' },
    { token: 'number', foreground: 'D33682' },
    { token: 'variable', foreground: '268BD2' },
    { token: 'keyword', foreground: '859900' },
    { token: 'storage', foreground: '586E75', fontStyle: 'bold' },
    { token: 'type', foreground: 'CB4B16' },
    { token: 'namespace', foreground: 'CB4B16' },
    { token: 'function', foreground: '268BD2' },
    { token: 'variable.predefined', foreground: 'B58900' },
    { token: 'constant', foreground: 'CB4B16' },
    { token: 'tag', foreground: '268BD2' },
    { token: 'attribute.name', foreground: '93A1A1' },
    { token: 'support.function', foreground: '268BD2' },
    { token: 'support.type', foreground: '859900' },
    { token: 'support', foreground: '839496' },
    { token: 'invalid', foreground: 'DC322F' },
  ];

  const MONACO_DARK_RULES = [
    { token: '', foreground: 'd4d0c8', background: '1e1e1e' },
    { token: 'comment', foreground: '6a6660', fontStyle: 'italic' },
    { token: 'string', foreground: '8fbc5a' },
    { token: 'string.regexp', foreground: 'ff4444' },
    { token: 'number', foreground: 'c06080' },
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
  const STORE_KEY = 'qqq-theme';
  let _dark = false;
  const _listeners = [];

  function _persist() {
    try { localStorage.setItem(STORE_KEY, _dark ? 'dark' : 'light'); } catch (_) {}
  }

  function _load() {
    try { return localStorage.getItem(STORE_KEY); } catch (_) { return null; }
  }

  // ==========================================================================
  // §5 CSS 变量批量注入（一次性 innerHTML，零回流）
  // ==========================================================================
  let _styleEl = null;

  function _ensureStyleEl() {
    if (_styleEl) return _styleEl;
    // 防止重复加载
    _styleEl = document.getElementById('qqq-theme-vars');
    if (_styleEl) return _styleEl;
    _styleEl = document.createElement('style');
    _styleEl.id = 'qqq-theme-vars';
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
      '/* qqq-theme — 唯一真理配色机器 */',
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
          'editor.foreground': '#657B83',
          'editor.lineHighlightBackground': '#EEE8D5',
          'editorCursor.foreground': '#586E75',
          'editor.selectionBackground': '#E8A090',
          'editor.inactiveSelectionBackground': '#E8C8B8',
        },
        rules: MONACO_LIGHT_RULES,
      });

      monaco.editor.defineTheme('solarized-dark', {
        base: 'vs-dark',
        inherit: false,
        colors: {
          'editor.background': '#1e1e1e',
          'editor.foreground': '#d4d0c8',
          'editor.lineHighlightBackground': '#2a2a2a',
          'editorCursor.foreground': '#c8c4b8',
          'editor.selectionBackground': '#5a3a2a',
          'editor.inactiveSelectionBackground': '#4a3020',
        },
        rules: MONACO_DARK_RULES,
      });
    } catch (e) {
      console.warn('[qqq-theme] defineMonacoThemes failed:', e && e.message);
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
          type: 'qqq-theme-change',
          dark: _dark,
        }, '*');
      } catch (_) {}
    }
  }

  // 监听来自 iframe 的请求（iframe onload 时请求初始主题）
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'qqq-theme-request') {
      // iframe 请求初始主题，回复当前状态
      const src = e.source;
      if (src && src.postMessage) {
        src.postMessage({ type: 'qqq-theme-change', dark: _dark }, '*');
      }
    }
  });

  // ==========================================================================
  // §7 初始化
  // ==========================================================================
  function init() {
    // 首次注入 CSS
    _injectCSS(SOLARIZED_DARK, SOLARIZED_LIGHT);

    // 恢复持久化状态
    const saved = _load();
    _dark = saved === 'dark';
    if (_dark) {
      ROOT.setAttribute('data-theme', 'dark');
    } else {
      ROOT.removeAttribute('data-theme');
    }
  }

  init();

  // ==========================================================================
  // §8 公开 API
  // ==========================================================================
  window.qqqTheme = Object.freeze({
    get PALETTE() { return getCurrentPalette(); },
    isDark,
    apply,
    onChange,
    getMonacoTheme,
    defineMonacoThemes,
    injectTo,
  });

})();
