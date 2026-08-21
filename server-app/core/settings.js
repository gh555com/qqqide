// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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

  // ── 设置定义（元数据）── 默认值从 window.QQQ_DEFAULTS 读取 ──
  var _D = window.qqqideDefaults || {};
  var SETTINGS_DEF = [
    {
      key: 'editor.undoMode',
      label: '编辑器撤销模式',
      desc: 'Ctrl+Z 在代码编辑器中撤销的粒度',
      type: 'radio',
      tab: 'general',
      defaultValue: _D['editor.undoMode'] || 'char',
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
      tab: 'general',
      defaultValue: String(_D['ai.defaultTier'] || 3),
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
      label: '上下文背包自动 absolut 压缩',
      desc: 'absolut 可回收收益超此值 → 自动剥离绝对包装盒（做absolut 压缩）',
      type: 'number',
      tab: 'general',
      defaultValue: String(_D['ai.compressThreshold'] || 600),
      min: 100,
      max: 1000,
      unit: 'k'
    },
    {
      key: 'audio.volume',
      label: '音量',
      desc: 'IDE 窗口及所有 goods 的音量（独立音量 goods 走旁路，不受此控制）。出厂默认 25%。',
      type: 'slider-stepped',
      tab: 'general',
      defaultValue: _D['audio.volume'] || '25',
      stops: ['0', '25', '50', '75', '100']
    },
    {
      key: 'desktop.shortcut',
      label: '自动生成快捷方式',
      type: 'bool',
      tab: 'general',
      defaultValue: _D['desktop.shortcut'] !== undefined ? String(_D['desktop.shortcut']) : 'true'
    },
    {
      key: 'timeline.trackRunCommand',
      label: '追踪命令文件变更',
      desc: '开启后，AI 执行的 shell 命令修改的文件会自动记录到版本时间线。关闭可减少 timeline 快照噪音。',
      type: 'bool',
      tab: 'advanced',
      defaultValue: _D['timeline.trackRunCommand'] || false
    },
    {
      key: 'secret.maskHelp',
      label: '协助密钥脱敏',
      desc: '发现项目有未提交更改时，自动识别并抹除其中的密钥（API Key/密码/Token 等）。无法自动确认的会弹窗请你协同处理。',
      type: 'bool',
      tab: 'advanced',
      defaultValue: 'true'
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
    // ★ 插到菜单行2，灯泡左边
    var $bulb1 = document.getElementById('qqq-bulb-1');
    if (!$bulb1) return;
    var $bulbs = $bulb1.parentNode; // qqq-bulbs span
    _$btn = document.createElement('button');
    _$btn.className = 'qqq-settings-btn';
    _$btn.setAttribute('data-i18n-title', 'settings.title');
    _$btn.title = '设置';
    _$btn.textContent = '\u2699'; // ⚙ gear
    _$btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (_$overlay && _$overlay.style.display !== 'none') {
        close();
      } else {
        open();
      }
    });
    // ★ 右键齿轮按钮 → 打开开发者工具
    _$btn.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var bridge = window.qqqideBridge;
      if (bridge && bridge.window && bridge.window.toggleDevTools) {
        bridge.window.toggleDevTools();
      }
    });
    $bulbs.parentNode.insertBefore(_$btn, $bulbs);
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

  var _activeTab = 'general'; // 'general' | 'advanced'

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
    // 标题行
    html += '<div style="padding:16px 20px; border-bottom:1px solid ' + border + '; display:flex; align-items:center; justify-content:space-between;">';
    html += '<div style="display:flex; align-items:center; gap:12px;">';
    html += '<span style="font-size:15px; font-weight:bold; color:' + text + ';">设置</span>';
    html += '<button id="qqq-settings-restart" style="padding:3px 10px; border:1px solid ' + accent + '; border-radius:3px; background:transparent; color:' + accent + '; font-size:11px; cursor:default; white-space:nowrap;">重置窗口</button>';
    // ★ 构建戳（与重置窗口成对）：SW缓存旧代码 → 红色⚠️ → 按「重置窗口」
    html += '<span id="qqq-status-build" style="font-family:Consolas,monospace;font-size:11px;color:' + textDim + ';">stamp: --</span>';
    html += '</div>';
    html += '<button id="qqq-settings-close" style="width:24px; height:24px; border:1px solid ' + border + '; border-radius:3px; background:transparent; color:' + textDim + '; font-size:14px; line-height:22px; text-align:center;">✕</button>';
    html += '</div>';

    // ★ 标签栏
    html += '<div style="display:flex; border-bottom:1px solid ' + border + ';">';
    html += '<button id="qqq-settings-tab-general" class="qqq-settings-tab" style="flex:1; padding:8px 0; border:none; border-bottom:2px solid ' + (_activeTab === 'general' ? accent : 'transparent') + '; background:transparent; color:' + (_activeTab === 'general' ? text : textDim) + '; font-size:13px; font-weight:' + (_activeTab === 'general' ? 'bold' : 'normal') + ';">常规</button>';
    html += '<button id="qqq-settings-tab-advanced" class="qqq-settings-tab" style="flex:1; padding:8px 0; border:none; border-bottom:2px solid ' + (_activeTab === 'advanced' ? accent : 'transparent') + '; background:transparent; color:' + (_activeTab === 'advanced' ? text : textDim) + '; font-size:13px; font-weight:' + (_activeTab === 'advanced' ? 'bold' : 'normal') + ';">高级</button>';
    html += '</div>';

    html += '<div style="padding:12px 20px;">';

    // 筛选当前 tab 的设置项
    var tabDefs = [];
    for (var i = 0; i < SETTINGS_DEF.length; i++) {
      var dTab = SETTINGS_DEF[i].tab || 'general';
      if (dTab === _activeTab) tabDefs.push(SETTINGS_DEF[i]);
    }

    if (tabDefs.length === 0) {
      html += '<div style="font-size:12px; color:' + textDim + '; text-align:center; padding:40px 0;">此标签页暂无设置项</div>';
    }

    // 渲染每个设置项
    for (var i = 0; i < tabDefs.length; i++) {
      var def = tabDefs[i];
      var currentVal = get(def.key, def.defaultValue);
      html += '<div class="qqq-setting-item" style="margin-bottom:16px; padding:12px; border:1px solid ' + border + '; border-radius:4px; background:' + bg2 + ';">';
      html += '<div style="font-size:13px; font-weight:bold; color:' + text + '; margin-bottom:4px;">' + def.label + '</div>';
      // ★ 无 desc 项不渲染描述行（防 undefined）
      if (def.desc) html += '<div style="font-size:11px; color:' + textDim + '; margin-bottom:10px;">' + def.desc + '</div>';

      if (def.type === 'slider-stepped') {
        var stops = def.stops || ['0', '25', '50', '75', '100'];
        var curIdx = stops.indexOf(String(currentVal));
        if (curIdx < 0) curIdx = stops.length - 1;
        var pct = Math.round((curIdx / (stops.length - 1)) * 100);
        // ★ 紧凑一行：左边标签 + 右边拉杆（无刻度数字）
        html += '<div style="display:flex; align-items:center; gap:12px;">';
        html += '<span style="font-size:12px; color:' + textDim + '; white-space:nowrap; min-width:32px;">' + stops[curIdx] + '%</span>';
        html += '<div class="qqq-vol-slider" style="position:relative;flex:1;height:24px;display:flex;align-items:center;user-select:none;" data-setting-key="' + def.key + '" data-stops="' + stops.join(',') + '">';
        html += '<div style="position:absolute;left:0;right:0;height:4px;border-radius:2px;background:' + border + ';"></div>';
        html += '<div style="position:absolute;left:0;height:4px;border-radius:2px;background:' + accent + ';width:' + pct + '%;"></div>';
        for (var si = 0; si < stops.length; si++) {
          var sp = Math.round((si / (stops.length - 1)) * 100);
          var isActive = si <= curIdx;
          html += '<div style="position:absolute;left:' + sp + '%;transform:translateX(-50%);width:12px;height:12px;border-radius:50%;border:2px solid ' + (isActive ? accent : border) + ';background:' + (isActive ? accent : bg) + ';z-index:1;"></div>';
        }
        html += '</div></div>';
      } else if (def.type === 'bool') {
        // 开关切换
        var boolOn = (currentVal === true || currentVal === 'true');
        var toggleId = 'qqq-setting-' + def.key.replace(/\./g, '-');
        html += '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;">';
        html += '<div style="position:relative; width:44px; height:24px; border-radius:12px; background:' + (boolOn ? green : border) + '; transition:background 150ms; flex-shrink:0;">';
        html += '<div style="position:absolute; top:2px; left:' + (boolOn ? '22px' : '2px') + '; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.3); transition:left 150ms;"></div>';
        html += '</div>';
        html += '<input type="checkbox" id="' + toggleId + '" ' + (boolOn ? 'checked' : '') + ' data-setting-key="' + def.key + '" style="position:absolute; opacity:0; pointer-events:none;">';
        html += '<span style="font-size:12px; color:' + text + ';">' + (boolOn ? '已开启' : '已关闭') + '</span>';
        html += '</label>';
      } else if (def.type === 'radio') {
        // ★ 默认 AI 等级：6 个水平格子（紧凑1-2行），选中打勾 ✓
        if (def.key === 'ai.defaultTier') {
          html += '<div style="display:flex; gap:6px;">';
          for (var j = 0; j < def.options.length; j++) {
            var opt = def.options[j];
            var checked = (currentVal === opt.value);
            html += '<label style="flex:1; min-width:40px; box-sizing:border-box; display:flex; align-items:center; justify-content:center; gap:4px; padding:6px 4px; border-radius:4px; border:2px solid ' + (checked ? accent : border) + '; background:' + (checked ? accent + '20' : 'transparent') + '; cursor:pointer; font-size:12px; color:' + text + '; user-select:none;">';
            html += '<input type="radio" name="' + def.key + '" value="' + opt.value + '" ' + (checked ? 'checked' : '') + ' data-setting-key="' + def.key + '" style="display:none;">';
            html += checked ? '<span style="font-weight:bold; color:' + accent + ';">\u2713</span>' : '';
            html += '<span>' + opt.label + '</span>';
            html += '</label>';
          }
          html += '</div>';
        } else {
          // 其他 radio 项保持原样
          for (var j = 0; j < def.options.length; j++) {
            var opt = def.options[j];
            var checked = (currentVal === opt.value);
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
        // 数字键入（范围 100-1000，单位 k）
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

    // 绑定重置窗口按钮（等价 Ctrl+Shift+R）
    var $restart = document.getElementById('qqq-settings-restart');
    if ($restart) {
      $restart.addEventListener('click', function () {
        $restart.textContent = '重置中...';
        $restart.style.opacity = '0.6';
        $restart.style.pointerEvents = 'none';

        // ★ 设旁路标签：主窗口 + 所有 iframe → beforeunload 全线放行
        window.__qqq_reloading = true;
        var iframes = document.querySelectorAll('iframe');
        for (var fi = 0; fi < iframes.length; fi++) {
          try { iframes[fi].contentWindow.__qqq_reloading = true; } catch (_) {}
        }
        // 直接走 location.reload()——不经过 IPC，减少故障点
        location.reload();
        // 兜底：800ms/2s 后还在 → 再试
        setTimeout(function () { location.reload(); }, 800);
        setTimeout(function () { location.reload(); }, 2000);
      });
    }

    // ★ 绑定标签页切换
    var $tabGeneral = document.getElementById('qqq-settings-tab-general');
    var $tabAdvanced = document.getElementById('qqq-settings-tab-advanced');
    if ($tabGeneral) {
      $tabGeneral.addEventListener('click', function () {
        if (_activeTab !== 'general') { _activeTab = 'general'; _renderPanel(); }
      });
    }
    if ($tabAdvanced) {
      $tabAdvanced.addEventListener('click', function () {
        if (_activeTab !== 'advanced') { _activeTab = 'advanced'; _renderPanel(); }
      });
    }

    // 绑定 bool checkbox 变更
    var checkboxes = _$panel.querySelectorAll('input[type="checkbox"]');
    for (var c = 0; c < checkboxes.length; c++) {
      checkboxes[c].addEventListener('change', function () {
        var key = this.getAttribute('data-setting-key');
        set(key, this.checked);
        _renderPanel();
      });
    }

    // 绑定 radio 变更
    var radios = _$panel.querySelectorAll('input[type="radio"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener('change', function () {
        var key = this.getAttribute('data-setting-key');
        var val = this.value;
        set(key, val);
        _renderPanel();
      });
    }

    // 绑定 stepped slider 点击
    var sliderTracks = _$panel.querySelectorAll('[data-stops]');
    for (var st = 0; st < sliderTracks.length; st++) {
      (function (track) {
        var key = track.getAttribute('data-setting-key');
        var stopsStr = track.getAttribute('data-stops');
        var stops = stopsStr.split(',');
        track.addEventListener('click', function (e) {
          var rect = track.getBoundingClientRect();
          var x = e.clientX - rect.left;
          var pct = x / rect.width;
          var idx = Math.round(pct * (stops.length - 1));
          if (idx < 0) idx = 0;
          if (idx >= stops.length) idx = stops.length - 1;
          set(key, stops[idx]);
          _renderPanel();
        });
      })(sliderTracks[st]);
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
        clearTimeout(self._debounceTimer);
        self._debounceTimer = setTimeout(function () {
          set(key, String(val));
        }, 500);
      });
    }

    // 构建戳刷新（渲染到标题行·重置窗口右侧，与重置按钮成对）
    if (window.__qqqBuildStampRefresh) window.__qqqBuildStampRefresh();
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
    // 同时刷新 tier info 弹出窗（如果打开）
    if (_tierOverlay && _tierOverlay.style.display !== 'none' && _tierOverlay.style.display !== '') {
      _renderTierPopup();
    }
  }

  // ── 桌面快捷方式同步 ──
  function _syncDesktopShortcut() {
    if (window.qqqideBridge && window.qqqideBridge.desktop && window.qqqideBridge.desktop.syncShortcut) {
      var enabled = get('desktop.shortcut', 'true');
      window.qqqideBridge.desktop.syncShortcut(enabled === true || enabled === 'true');
    }
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
    // 桌面快捷方式：初始同步 + 变更监听
    setTimeout(function () { _syncDesktopShortcut(); }, 2000);
    onChange('desktop.shortcut', function () { _syncDesktopShortcut(); });
  }

  // 自动初始化（DOM 就绪后）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(init, 50); // 等菜单渲染完
    });
  } else {
    setTimeout(init, 50);
  }

  // ════════════════════════════════════════════════════
  // Tier Info 弹出窗（AI 面板 A 按钮触发，居中窗口）
  // ════════════════════════════════════════════════════

  var _tierOverlay = null, _tierPanel = null, _tierExpanded = false;

  function _ensureTierPopup() {
    if (_tierOverlay) return;
    _tierOverlay = document.createElement('div');
    _tierOverlay.style.cssText = 'display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.45); z-index:9998;';
    _tierOverlay.addEventListener('click', function(e) {
      if (e.target === _tierOverlay) _closeTierPopup();
    });
    _tierPanel = document.createElement('div');
    _tierPanel.className = 'tier-popup-panel';
    _tierOverlay.appendChild(_tierPanel);
    document.body.appendChild(_tierOverlay);
    // 自定义现代化无轨滚动块（窄 5px、轨道透明）+ 文字可选中复制（全局 user-select:none 需显式覆盖）
    var _tierStyle = document.createElement('style');
    _tierStyle.textContent = '.tier-popup-panel{user-select:text;-webkit-user-select:text;}' +
      '.tier-popup-panel::-webkit-scrollbar{width:5px;height:5px;}' +
      '.tier-popup-panel::-webkit-scrollbar-track{background:transparent;}' +
      '.tier-popup-panel::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.35);border-radius:3px;}' +
      '.tier-popup-panel::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,0.55);}' +
      '.tier-popup-panel::-webkit-scrollbar-corner{background:transparent;}';
    document.head.appendChild(_tierStyle);
  }

  window.openTierPopup = function() {
    _ensureTierPopup();
    _tierExpanded = false;
    _renderTierPopup();
    _tierOverlay.style.display = '';
    document.addEventListener('keydown', _tierOnEsc);
  };

  function _closeTierPopup() {
    if (_tierOverlay) _tierOverlay.style.display = 'none';
    document.removeEventListener('keydown', _tierOnEsc);
  }

  function _tierOnEsc(e) {
    if (e.key === 'Escape') _closeTierPopup();
  }

  function _expandTierPopup() {
    _tierExpanded = true;
    _renderTierPopup();
    _tierPanel.scrollTop = 0;
  }

  function _renderTierPopup() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var bg = isDark ? '#1e1e1e' : '#fdf6e3';
    var text = isDark ? '#dcd8d0' : '#656360';
    var textDim = isDark ? '#6a6660' : '#a8a6a2';
    var border = isDark ? '#333333' : '#d3c6aa';
    var accent = isDark ? '#d4a017' : '#e8a030';
    var red = isDark ? '#ff4444' : '#dc322f';

    var _w = _tierExpanded ? '1040px' : '520px';
    _tierPanel.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:' + _w + '; max-width:92vw; max-height:82vh; overflow-y:auto; z-index:9999; padding:0; border-radius:6px; box-shadow:0 8px 32px rgba(0,0,0,0.35); background:' + bg + '; user-select:text; -webkit-user-select:text;';

    var html = '';
    // 标题行
    html += '<div style="padding:14px 20px; border-bottom:1px solid ' + border + '; display:flex; align-items:center; justify-content:space-between;">';
    html += '<span style="font-size:15px; font-weight:bold; color:' + text + ';">AI 等级说明</span>';
    html += '<button id="tier-popup-close" style="width:24px; height:24px; border:1px solid ' + border + '; border-radius:3px; background:transparent; color:' + textDim + '; font-size:14px; line-height:22px; text-align:center; cursor:pointer;">✕</button>';
    html += '</div>';

    html += '<div style="padding:16px 20px; font-size:13px; line-height:1.9; color:' + text + ';">';

    if (!_tierExpanded) {
      // ── 收拢态 ──
      html += '<div style="margin-bottom:12px;"><b style="color:' + accent + ';">1档：</b>最低智能，快、便宜。</div>';
      html += '<div style="margin-bottom:14px;"><b style="color:' + accent + ';">6档：</b>最高智能，慢、贵。</div>';
      html += '<div style="margin-bottom:4px;">qqqide 不再提供自动换档功能，';
      html += '<span id="tier-reason-link" style="color:' + red + '; text-decoration:underline; cursor:pointer;">理由</span>';
      html += '</div>';
    } else {
      // ── 展开态：完整说明 ──
      html += '<div style="margin-bottom:10px;"><b style="color:' + accent + ';">1档：</b>最低智能，快、便宜。</div>';
      html += '<div style="margin-bottom:14px;"><b style="color:' + accent + ';">6档：</b>最高智能，慢、贵。</div>';
      html += '<div style="margin-bottom:10px;">qqqide 不再提供自动换档功能，理由：</div>';

      html += '<div style="color:' + textDim + '; line-height:1.8;">';
      html += '<p style="margin-top:0;">为了方便你理解，我们划分出了如下架构：</p>';
      html += '<p style="text-align:center; font-weight:bold; color:' + text + ';">project → quest → floor → house → room</p>';
      html += '<p>一个 project 就是一个项目你也可以理解为就是一个文件夹，一个 quest 就是一个任务，你可以在一个任务里盖多层楼，你每发送出去一次消息就等于是盖了一层楼，也就是一个 floor，那你同时可以开多个任务（quest），每一个任务又可以盖多层楼，这很好理解。</p>';
      html += '<p>而在你看不到的后台，其实每一层楼都会跟服务器往返多次消息，也就是表面上你只按了一次发送，但实际上会做多次发送、和接收。</p>';
      html += '<p>为什么会那样？假想一种情况，比如你让服务器改一个超大项目的代码，服务器大概会多次返回查询指定代码的指令，以尽可能地了解你的本地代码，服务器的这种要求可以并行也可以串行，对于串行，服务器发送一个指令回来，你本地接收指令、按指令查询指令要求的代码（结果），再将结果发送回服务器，这样的一来一回我们叫做一个 <b>house</b>。</p>';
      html += '<p>而实际上，服务器可以一次提出多个要求，也就是服务器送回一次消息，你本地会「并行地」去执行多个指令，那么每一个指令我们叫他一个 <b>room</b>，每一个 room 返回一个结果，那看上去「多间 room」就组成了一个 house（对应了跟服务器的一来一回）。但非常重要的一点是，表面上看你只按了一次发送按钮：house 和 room 都是静默、自动地进行的（与服务器的交互）。</p>';
      html += '<p>最终看上去，一个 project 可以包含多个 quest，一个 quest 可以包含多个 floor，一个 floor 可以包含多个 house，一个 house 可以包含多个 room。</p>';
      html += '<p style="margin-top:18px;"><b style="color:' + text + ';">你可以休息一会儿，因为接下来就是重点。</b></p>';
      html += '<p>首先，你最难接受但必须接受的一个事实是：</p>';
      html += '<p style="font-weight:bold; border-left:3px solid ' + red + '; padding-left:12px; color:' + text + ';">别说 project 和 quest，哪怕是同一个 floor 里面的不同 house（对应物理上的一次服务器往返），它们请求的可能都是物理隔绝的服务器（大模型），简单讲就是，服务器那边即便有缓存，但你也要假设服务器那边根本不会存在任何关于你本次任务（project、quest 或 floor）的任何记忆，也就是你首先必须要颠覆的一点认知是：<span style="color:' + red + ';">AI 根本不存在记忆。</span></p>';
      html += '<p>那你可能好奇，AI 是怎么记住 50 层楼之前你们的聊天内容的？你很难接受但必须接受的事实是：每一间 house，也就是哪怕是最细分的一次服务器往返，你发送给服务器的，都尽可能地带上了你之前每一层楼的所有对话、甚至工具查询结果，注意，每一次最细分的服务器往返，代表你即便不是按发送按钮而是后台自动静默的 house 级别的往返，都会尽量带上之前的一切，更别说 floor 级别的发送。而「一切」是指从第一层楼到现在的一切对话、工具调用结果，那样的一个集合也就是「上下文」。</p>';
      html += '<p>你的第一个问题是，那为什么没有盖两层楼就把 1M 的上下文总空间撑爆，主要原因是，根据 IDE 的策略选择不同，即便最保守的 AI IDE，也不会把 200KB 的源代码查询结果直接放进上下文，实际上大概只会截取里面 2KB 的关键行代码，而其他的工具结果，比如日志，基本都会被做成摘要，同样回到 KB 级别。</p>';
      html += '<p>而且 AI IDE 基本都会有自己的压缩策略，qqqide 的压缩策略是保留最近 6 层楼的完整信息，假设压缩时在最近 6 层楼之前有 200 层楼，那那 200 层楼会被压缩成最大 32KB 的摘要。压缩是一次专门的 AI 请求，就比如给 AI 1M 的文本（上下文），要求 AI 总结，返回不超过 32KB 的文本。</p>';
      html += '<p>我希望这就解释了，为什么在一个 quest 里，当你楼修到第 5 层，你放着不管过半年回来，你再按一次发送按钮，AI 还能跟你接着聊（似乎之前的一切它都记得），即便过了半年、模型早已更新换代……因为大模型是无状态的（不会保存关于你的任何记录），而你每一次都会发送完整上下文（它们不是储存在你本地硬盘，就是储存在中转服务器的硬盘里）。</p>';
      html += '<p>你可能还有一点不相信：「AI（大模型）总应该记得些什么？」。没有，什么都不记得。你认为的那些「记得」，只是你本地硬盘或者中转服务器偷偷在记的「小本本」，下次按发送按钮小本本会一起发给 AI。</p>';
      html += '<p style="margin-top:18px;">ok，有了上面的认知，你可以得到第一个让你放心的结论：</p>';
      html += '<p style="font-weight:bold; border-left:3px solid ' + accent + '; padding-left:12px; color:' + text + ';">「无论怎样切换模型档位都不会导致记忆丢失」</p>';
      html += '<p>即：在任何时间点切换模型档位 → 记忆不会丢失 → 但会左右中间推论的质量。</p>';
      html += '<p style="margin-top:18px;">回到最原始的问题：qqqide 为什么不再提供自动换档功能。</p>';
      html += '<p>答案有两点：</p>';
      html += '<p><b>1、</b>不能保证「用最高的智能去写最重要的代码」，我们知道这一点至关重要，但总会有边界情况。</p>';
      html += '<p><b>2、</b>自动换档本质上是让最高智能的 AI 来评估问题复杂度（再来选择实际干活的 AI），但长远来看，每一层楼都会凭空增加至少一次「最高智能 AI」的调用，这是一笔长远账单，但如果反之，我们不用最高智能去做评估，又会增加第一点对应的风险。</p>';
      html += '<p style="font-weight:bold; margin-top:16px;">最终 qqqide 决定做一个更好用的换档杆，将换档权，百分百地只交在你手里。</p>';
      html += '</div>';
    }

    html += '</div>';
    _tierPanel.innerHTML = html;
    _tierPanel.style.backgroundColor = bg;

    // 绑定事件
    var $close = document.getElementById('tier-popup-close');
    if ($close) $close.addEventListener('click', _closeTierPopup);
    if (!_tierExpanded) {
      var link = document.getElementById('tier-reason-link');
      if (link) link.addEventListener('click', _expandTierPopup);
    }
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
