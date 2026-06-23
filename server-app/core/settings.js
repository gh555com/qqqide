// ============================================================================
// settings.js — 设置界面（唯一真理设置机器）
//
// 入口：
//   window.qqqSettings.init()  — 初始化（注入按钮 + 加载状态）
//
// API：
//   window.qqqSettings.get(key, fallback)   — 读取设置（内存缓存，同步）
//   window.qqqSettings.set(key, value)      — 写入设置
//   window.qqqSettings.toggle(key)          — 布尔翻转
//   window.qqqSettings.onChange(key, fn)    — 订阅变更
//   window.qqqSettings.open()               — 打开设置面板
//   window.qqqSettings.close()              — 关闭设置面板
//
// 铁律：
//   · 接入 §3 配色机器，不自定义颜色
//   · 设置持久化走 qgs.simple('qqq.settings')
//   · 不触碰 cursor 样式（§19）
// ============================================================================

(function () {
  'use strict';

  // ── 状态 ──
  var _cache = {};           // 内存缓存
  var _qgsHandle = null;
  var _initDone = false;
  var _listeners = {};       // key → [fn]
  var _$overlay = null;
  var _$panel = null;
  var _$btn = null;

  // ── 设置定义（元数据） ──
  var SETTINGS_DEF = [
    {
      key: 'editor.undoMode',
      label: '编辑器撤销模式',
      desc: 'Ctrl+Z 在代码编辑器中撤销的粒度',
      type: 'radio',
      defaultValue: 'char',
      options: [
        { value: 'char', label: '逐字回退', desc: '每按一次 Ctrl+Z 撤销一个字符' },
        { value: 'word', label: '单词回退', desc: 'Monaco 原生撤销，按编辑操作分组（推荐用于代码）' }
      ]
    },
    {
      key: 'ai.defaultTier',
      label: '默认 AI 等级',
      desc: '数字越大=思考越深、质量越高、越慢、越贵',
      type: 'radio',
      defaultValue: '6',
      options: [
        { value: '1', label: '1', desc: '轻量' },
        { value: '2', label: '2', desc: '轻量+推理' },
        { value: '3', label: '3', desc: '轻量+深度推理' },
        { value: '4', label: '4', desc: '专业' },
        { value: '5', label: '5', desc: '专业+推理' },
        { value: '6', label: '6', desc: '专业+深度推理' }
      ]
    },
    {
      key: 'ai.compressThreshold',
      label: '自动压缩阈值',
      desc: '上下文 token 数超过此值自动触发压缩。单位 k（千 tokens），接收范围 100-1000',
      type: 'number',
      defaultValue: '200',
      min: 100,
      max: 1000,
      unit: 'k'
    }
  ];

  // ── qgs 句柄（延迟初始化） ──
  function _qgs() {
    if (!_qgsHandle && window.qgs && window.qgs.simple) {
      _qgsHandle = window.qgs.simple('qqq.settings', { cloud: false });
    }
    return _qgsHandle;
  }

  // ── 读取 ──
  function get(key, fallback) {
    if (key in _cache) return _cache[key];
    // 查默认值
    for (var i = 0; i < SETTINGS_DEF.length; i++) {
      if (SETTINGS_DEF[i].key === key) {
        return SETTINGS_DEF[i].defaultValue;
      }
    }
    return fallback;
  }

  // ── 写入 ──
  function set(key, value) {
    var old = _cache[key];
    _cache[key] = value;
    // 异步持久化
    var h = _qgs();
    if (h) {
      try { h.set(key, value); } catch (e) { /* ignore */ }
    }
    // 通知监听器
    if (value !== old) {
      _fireListeners(key, value, old);
    }
  }

  // ── 布尔翻转 ──
  function toggle(key) {
    set(key, !get(key, false));
  }

  // ── 监听变更 ──
  function onChange(key, fn) {
    if (!_listeners[key]) _listeners[key] = [];
    _listeners[key].push(fn);
    // 返回取消订阅函数
    return function () {
      var arr = _listeners[key];
      if (arr) {
        var idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  function _fireListeners(key, newVal, oldVal) {
    var arr = _listeners[key];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](newVal, oldVal); } catch (e) { /* ignore */ }
    }
  }

  // ── 从持久层加载 ──
  function _loadFromQgs() {
    var h = _qgs();
    if (!h) return;
    for (var i = 0; i < SETTINGS_DEF.length; i++) {
      var key = SETTINGS_DEF[i].key;
      try {
        h.get(key).then(function (k) {
          return function (v) {
            if (v !== undefined && v !== null) {
              _cache[k] = v;
            }
          };
        }(key));
      } catch (e) { /* ignore */ }
    }
  }

  // ── 按钮注入 ──
  function _injectButton() {
    if (_$btn) return;
    // 插到菜单行1，缩放比例标签后面、语言按钮前面
    var $zoomLabel = document.getElementById('qqq-zoom-label');
    if (!$zoomLabel) return;
    _$btn = document.createElement('button');
    _$btn.className = 'qqq-settings-btn';
    _$btn.setAttribute('data-i18n-title', 'settings.title');
    _$btn.title = '设置';
    _$btn.textContent = '\u2699'; // ⚙ gear
    _$btn.addEventListener('click', function (e) {
      e.preventDefault();
      // ★ 用 overlay 的 display 判断，而非 panel.style.display（close 只隐藏 overlay）
      if (_$overlay && _$overlay.style.display !== 'none') {
        close();
      } else {
        open();
      }
    });
    $zoomLabel.parentNode.insertBefore(_$btn, $zoomLabel.nextSibling);
  }

  // ── 创建设置面板 DOM ──
  function _ensurePanel() {
    if (_$overlay) return;

    // 遮罩
    _$overlay = document.createElement('div');
    _$overlay.className = 'qqq-settings-overlay';
    _$overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.45); z-index:9998;';
    _$overlay.addEventListener('click', function (e) {
      if (e.target === _$overlay) close();
    });

    // 面板
    _$panel = document.createElement('div');
    _$panel.className = 'qqq-settings-panel';
    _$panel.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:480px; max-width:90vw; max-height:80vh; overflow-y:auto; z-index:9999; padding:0; border-radius:6px; box-shadow:0 8px 32px rgba(0,0,0,0.35);';

    // 面板内容由 _renderPanel 生成
    _$overlay.appendChild(_$panel);
    document.body.appendChild(_$overlay);
  }

  function _renderPanel() {
    if (!_$panel) return;
    // 获取主题色
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var bg = isDark ? '#1e1e1e' : '#fdf6e3';
    var bg2 = isDark ? '#2a2a2a' : '#eee8d5';
    var text = isDark ? '#dcd8d0' : '#656360';
    var textDim = isDark ? '#6a6660' : '#a8a6a2';
    var border = isDark ? '#333333' : '#d3c6aa';
    var accent = isDark ? '#d4a017' : '#e8a030';
    var green = isDark ? '#8fbc5a' : '#859900';
    var red = isDark ? '#ff4444' : '#dc322f';

    var html = '';
    html += '<div style="padding:16px 20px; border-bottom:1px solid ' + border + '; display:flex; align-items:center; justify-content:space-between;">';
    html += '<span style="font-size:15px; font-weight:bold; color:' + text + ';">设置</span>';
    html += '<button id="qqq-settings-close" style="width:24px; height:24px; border:1px solid ' + border + '; border-radius:3px; background:transparent; color:' + textDim + '; font-size:14px; line-height:22px; text-align:center;">✕</button>';
    html += '</div>';

    html += '<div style="padding:12px 20px;">';

    // 渲染每个设置项
    for (var i = 0; i < SETTINGS_DEF.length; i++) {
      var def = SETTINGS_DEF[i];
      var currentVal = get(def.key, def.defaultValue);
      html += '<div class="qqq-setting-item" style="margin-bottom:16px; padding:12px; border:1px solid ' + border + '; border-radius:4px; background:' + bg2 + ';">';
      html += '<div style="font-size:13px; font-weight:bold; color:' + text + '; margin-bottom:4px;">' + def.label + '</div>';
      html += '<div style="font-size:11px; color:' + textDim + '; margin-bottom:10px;">' + def.desc + '</div>';

      if (def.type === 'radio') {
        // ★ 默认 AI 等级：6 个水平格子（紧凑1-2行），选中打勾 ✓
        if (def.key === 'ai.defaultTier') {
          html += '<div style="display:flex; gap:6px;">';
          for (var j = 0; j < def.options.length; j++) {
            var opt = def.options[j];
            var checked = (currentVal === opt.value);
            html += '<label style="flex:1; min-width:40px; box-sizing:border-box; display:flex; align-items:center; justify-content:center; gap:4px; padding:6px 4px; border-radius:4px; border:2px solid ' + (checked ? accent : border) + '; background:' + (checked ? accent + '20' : 'transparent') + '; cursor:pointer; font-size:12px; color:' + text + '; user-select:none;">';
            html += '<input type="radio" name="' + def.key + '" value="' + opt.value + '" ' + (checked ? 'checked' : '') + ' data-setting-key="' + def.key + '" style="display:none;">';
            html += checked ? '<span style="font-weight:bold; color:' + accent + ';">\u2713</span>' : '<span style="opacity:0.3;">\u25cb</span>';
            html += '<span>' + opt.label + '</span>';
            html += '</label>';
          }
          html += '</div>';
        } else {
          // 其他 radio 项保持原样
          for (var j = 0; j < def.options.length; j++) {
            var opt = def.options[j];
            var checked = (currentVal === opt.value);
            var radioId = 'qqq-setting-' + def.key.replace(/\./g, '-') + '-' + opt.value;
            html += '<label style="display:flex; align-items:flex-start; margin-bottom:6px; padding:6px 8px; border-radius:3px; background:' + (checked ? accent + '20' : 'transparent') + '; border:1px solid ' + (checked ? accent : 'transparent') + ';">';
            html += '<input type="radio" name="' + def.key + '" value="' + opt.value + '" ' + (checked ? 'checked' : '') + ' data-setting-key="' + def.key + '" style="margin-top:2px; margin-right:8px; accent-color:' + accent + ';">';
            html += '<div>';
            html += '<div style="font-size:12px; color:' + text + ';">' + opt.label + '</div>';
            html += '<div style="font-size:10px; color:' + textDim + ';">' + opt.desc + '</div>';
            html += '</div>';
            html += '</label>';
          }
        }
      } else if (def.type === 'number') {
        // 数字输入（范围 100-1000，单位 k）
        var numId = 'qqq-setting-' + def.key.replace(/\./g, '-');
        var min = def.min || 100;
        var max = def.max || 1000;
        var unit = def.unit || '';
        html += '<div style="display:flex; align-items:center; gap:8px;">';
        html += '<input type="number" id="' + numId + '" value="' + currentVal + '" min="' + min + '" max="' + max + '" step="10" data-setting-key="' + def.key + '" style="width:100px; padding:6px 8px; border:2px solid ' + border + '; border-radius:4px; background:' + bg + '; color:' + text + '; font-size:13px; outline:none;" onfocus="this.style.borderColor=\'' + accent + '\'" onblur="this.style.borderColor=\'' + border + '\'">';
        html += '<span style="font-size:13px; color:' + textDim + ';">' + unit + '</span>';
        html += '<span style="font-size:11px; color:' + textDim + ';">（' + min + '–' + max + '）</span>';
        html += '</div>';
      }

      html += '</div>';
    }

    html += '</div>';

    _$panel.innerHTML = html;
    // 设置背景色（必须在 innerHTML 后，否则被覆盖）
    _$panel.style.backgroundColor = bg;
    _$panel.style.color = text;

    // 绑定关闭按钮
    var $close = document.getElementById('qqq-settings-close');
    if ($close) {
      $close.addEventListener('click', close);
    }

    // 绑定 radio 变更
    var radios = _$panel.querySelectorAll('input[type="radio"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener('change', function () {
        var key = this.getAttribute('data-setting-key');
        var val = this.value;
        set(key, val);
        // 实时刷新面板以反映选中状态
        _renderPanel();
      });
    }

    // 绑定 number 变更（debounce 500ms 后写入）
    var numInputs = _$panel.querySelectorAll('input[type="number"]');
    for (var n = 0; n < numInputs.length; n++) {
      numInputs[n].addEventListener('input', function () {
        var self = this;
        var key = self.getAttribute('data-setting-key');
        var def = null;
        for (var d = 0; d < SETTINGS_DEF.length; d++) {
          if (SETTINGS_DEF[d].key === key) { def = SETTINGS_DEF[d]; break; }
        }
        var val = parseInt(self.value, 10);
        if (isNaN(val)) return;
        var min = def ? (def.min || 100) : 100;
        var max = def ? (def.max || 1000) : 1000;
        if (val < min) val = min;
        if (val > max) val = max;
        // debounce 写入
        clearTimeout(self._debounceTimer);
        self._debounceTimer = setTimeout(function () {
          set(key, String(val));
        }, 500);
      });
    }
  }

  // ── 打开/关闭 ──
  function open() {
    _ensurePanel();
    _renderPanel();
    if (_$overlay) _$overlay.style.display = '';
    // Esc 关闭
    document.addEventListener('keydown', _onEsc);
  }

  function close() {
    if (_$overlay) _$overlay.style.display = 'none';
    document.removeEventListener('keydown', _onEsc);
  }

  function _onEsc(e) {
    if (e.key === 'Escape') {
      close();
    }
  }

  // ── 主题同步 ──
  function _syncTheme() {
    if (!_$panel || _$panel.style.display === 'none') return;
    _renderPanel(); // 重绘以获取最新主题色
  }

  // ── 初始化 ──
  function init() {
    if (_initDone) return;
    _initDone = true;
    _injectButton();
    _loadFromQgs();
    // 监听主题变更
    if (window.qqqideTheme) {
      window.qqqideTheme.onChange(function () {
        _syncTheme();
      });
    }
  }

  // 自动初始化（DOM 就绪后）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(init, 50); // 等菜单渲染完
    });
  } else {
    setTimeout(init, 50);
  }

  // ── 导出 API ──
  window.qqqSettings = {
    init: init,
    get: get,
    set: set,
    toggle: toggle,
    onChange: onChange,
    open: open,
    close: close
  };

})();
