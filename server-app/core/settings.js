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

  // ── i18n 助手（key 缺失回退中文；i18n 未就绪时直接用回退）──
  function _i(k, fb) {
    return (typeof window._i === 'function') ? window._i(k, fb) : (fb || k);
  }

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
      labelKey: 'settings.undoMode.label',
      desc: 'Ctrl+Z 在代码编辑器中撤销的粒度',
      descKey: 'settings.undoMode.desc',
      type: 'radio',
      tab: 'general',
      defaultValue: _D['editor.undoMode'] || 'char',
      options: [
        { value: 'char', label: '逐字回退', labelKey: 'settings.undoMode.char', desc: '每按一次 Ctrl+Z 撤销一个字符', descKey: 'settings.undoMode.charDesc' },
        { value: 'word', label: '单词回退', labelKey: 'settings.undoMode.word', desc: 'Monaco 原生撤销，按编辑操作分组（推荐用于代码）', descKey: 'settings.undoMode.wordDesc' }
      ]
    },
    {
      key: 'ai.defaultTier',
      label: '默认 AI 等级',
      labelKey: 'settings.defaultTier.label',
      desc: '数字越大=思考越深、质量越高、越慢、越贵',
      descKey: 'settings.defaultTier.desc',
      type: 'radio',
      tab: 'general',
      defaultValue: String(_D['ai.defaultTier'] || 3),
      options: [
        { value: '1', label: '1', desc: '轻量', descKey: 'settings.defaultTier.d1' },
        { value: '3', label: '2', desc: '轻量+推理', descKey: 'settings.defaultTier.d2' },
        { value: '5', label: '3', desc: '专业+深度推理', descKey: 'settings.defaultTier.d6' }
      ]
    },
    {
      key: 'sys.interp',
      label: '系统解释器',
      labelKey: 'settings.sysInterp.label',
      type: 'interp',
      tab: 'general',
      defaultValue: ''
    },
    {
      key: 'ai.compressLevel',
      label: '自动压缩 上下文背包',
      labelKey: 'settings.compress.label',
      desc: '默认值为全托管',
      descKey: 'settings.compress.desc',
      type: 'slider-stepped',
      tab: 'general',
      defaultValue: _D['ai.compressLevel'] || 'full',
      showLabel: true,
      stopsLabels: ['关闭', '中等', '全托管'],
      stopsLabelKeys: ['settings.compress.off', 'settings.compress.medium', 'settings.compress.full'],
      stops: ['off', 'medium', 'full']
    },
    {
      key: 'ai.floorCap',
      label: '显示楼层',
      labelKey: 'settings.floorCap.label',
      desc: '',
      type: 'slider-stepped',
      tab: 'general',
      defaultValue: _D['ai.floorCap'] !== undefined ? String(_D['ai.floorCap']) : '16',
      showLabel: true,
      stopsLabels: ['16', '32', '64'],
      stops: ['16', '32', '64']
    },
    {
      key: 'audio.volume',
      label: '音量',
      labelKey: 'settings.volume.label',
      desc: 'IDE 窗口及所有 goods 的音量（独立音量 goods 走旁路，不受此控制）。出厂默认 25%。',
      descKey: 'settings.volume.desc',
      type: 'slider-stepped',
      tab: 'general',
      defaultValue: _D['audio.volume'] || '25',
      stops: ['0', '25', '50', '75', '100']
    },
    {
      key: 'mdview.auto',
      label: '自动打开 Markdown 预览',
      labelKey: 'settings.mdviewAuto.label',
      type: 'bool',
      tab: 'general',
      defaultValue: _D['mdview.auto'] !== undefined ? String(_D['mdview.auto']) : 'true'
    },
    {
      key: 'desktop.shortcut',
      label: '自动生成快捷方式',
      labelKey: 'settings.shortcut.label',
      type: 'bool',
      tab: 'general',
      defaultValue: _D['desktop.shortcut'] !== undefined ? String(_D['desktop.shortcut']) : 'true'
    },
    {
      key: 'timeline.trackRunCommand',
      label: '追踪命令文件变更',
      labelKey: 'settings.trackRun.label',
      desc: '开启后，AI 执行的 shell 命令修改的文件会自动记录到版本时间线。关闭可减少 timeline 快照噪音。',
      descKey: 'settings.trackRun.desc',
      type: 'bool',
      tab: 'advanced',
      defaultValue: _D['timeline.trackRunCommand'] || false
    },
    {
      key: 'secret.maskHelp',
      label: '协助密钥脱敏',
      labelKey: 'settings.secret.label',
      desc: '发现项目有未提交更改时，自动识别并抹除其中的密钥（API Key/密码/Token 等）。无法自动确认的会弹窗请你协同处理。',
      descKey: 'settings.secret.desc',
      type: 'bool',
      tab: 'advanced',
      defaultValue: 'false'
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
    // 异步持久化（★ 2026-09-17: 补 catch —— 旧实现 promise rejection 裸奔进控制台）
    var h = _qgs();
    if (h) {
      try {
        var _p = h.set(key, value);
        if (_p && typeof _p.catch === 'function') { _p.catch(function () { /* 内存值仍在，下次变更重写 */ }); }
      } catch (e) { /* ignore */ }
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
  // ★ 2026-09-17: 加载失败不再静默——旧实现无 catch 无重试（rejection 被裸吞 / 句柄未就绪时直接 return）
  //   → 整个会话 get() 恒返默认值，用户看到「齿轮里配置全丢」（即使库本身完好）。
  //   现在：失败退避重试 ≤3 次 + 值到位后重绘打开中的面板。
  var _loadRetryCount = 0;
  var _loadRetryTimer = null;
  var _rerenderTimer = null;

  function _scheduleLoadRetry() {
    if (_loadRetryTimer) return;
    if (_loadRetryCount >= 3) {
      try { console.warn('[qqqSettings] load from state store failed after retries — defaults this session'); } catch (e) { /* ignore */ }
      return;
    }
    var delay = [1000, 3000, 8000][_loadRetryCount] || 8000;
    _loadRetryCount++;
    _loadRetryTimer = setTimeout(function () {
      _loadRetryTimer = null;
      _loadFromQgs();
    }, delay);
  }

  // 值到位后重绘打开中的面板（拖杆/弹窗位置不受影响：面板尚未渲染时不重建）
  function _rerenderIfOpen() {
    if (!_$panel || !_$overlay || _$overlay.style.display === 'none') return;
    if (_rerenderTimer) return;
    _rerenderTimer = setTimeout(function () {
      _rerenderTimer = null;
      try { _renderPanel(); } catch (e) { /* ignore */ }
    }, 80);
  }

  function _loadFromQgs() {
    var h = _qgs();
    if (!h) { _scheduleLoadRetry(); return; }
    for (var i = 0; i < SETTINGS_DEF.length; i++) {
      (function (k) {
        try {
          h.get(k).then(function (v) {
            if (v !== undefined && v !== null && _cache[k] !== v) {
              _cache[k] = v;
              _rerenderIfOpen();
            }
          }, function () { _scheduleLoadRetry(); });
        } catch (e) { _scheduleLoadRetry(); }
      })(SETTINGS_DEF[i].key);
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
    _$btn.title = _i('settings.title', '设置');
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

  // ── ★ 音效开关子卡片（1 by 1 展开体，2026-09-04）──
  //   场景清单唯一真理 = window.qqqAudio.sfxScenes()（audio-volume.js 导出），此处只做展示
  function _sfxCardHtml(bg, text, textDim, border, accent) {
    var q = window.qqqAudio;
    var scenes = (q && q.sfxScenes) ? q.sfxScenes() : [];
    var h = '<div style="margin-top:10px; padding:10px 12px; border:1px solid ' + border + '; border-radius:4px; background:' + bg + ';">';
    h += '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">';
    h += '<span style="font-size:12px; font-weight:bold; color:' + text + ';">' + _i('settings.sfxTitle', '音效开关') + '</span>';
    h += '<span style="display:flex; align-items:center; gap:12px;">';
    h += '<a href="javascript:void(0)" class="qqq-sfx-all" style="font-size:11px; color:' + accent + '; text-decoration:underline;">' + _i('settings.sfxAll', 'All') + '</a>';
    h += '<a href="javascript:void(0)" class="qqq-sfx-none" style="font-size:11px; color:' + accent + '; text-decoration:underline;">' + _i('settings.sfxNone', 'None') + '</a>';
    h += '</span>';
    h += '</div>';
    for (var i = 0; i < scenes.length; i++) {
      var sc = scenes[i];
      var on = (q && q.sfxOn) ? q.sfxOn(sc.key) : true;
      var _scLabel = sc.lk ? _i(sc.lk, sc.label) : sc.label;
      var _scDesc = sc.dk ? _i(sc.dk, sc.desc || '') : (sc.desc || '');
      h += '<label style="display:flex; align-items:center; gap:8px; padding:3px 0; cursor:pointer; user-select:none;" title="' + _scDesc + '">';
      h += '<input type="checkbox" class="qqq-sfx-check" data-sfx-key="' + sc.key + '"' + (on ? ' checked' : '') + ' style="margin:0; accent-color:' + accent + '; flex-shrink:0;">';
      h += '<span style="font-size:12px; color:' + text + '; white-space:normal; word-break:break-word; line-height:1.3;">' + _scLabel + '</span>';
      h += '<span style="font-size:10px; color:' + textDim + '; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + sc.file + ' · ' + _scDesc + '</span>';
      h += '</label>';
    }
    h += '</div>';
    return h;
  }

  // ── ★ 音效开关 All / None 批量（子卡片右上角超链接按钮，2026-09-23）──
  //   点击 = 全部选中 / 全部不选 + 即时生效（qgs 一次写 + 闸门一次推）；只原地刷勾选框，不整面板重渲染（防拉杆跳动）
  function _sfxApplyAll(on) {
    var q = window.qqqAudio;
    if (q && q.sfxSetAll) {
      q.sfxSetAll(on);
    } else if (q && q.sfxSet && q.sfxScenes) {
      var scenes = q.sfxScenes();
      for (var i = 0; i < scenes.length; i++) q.sfxSet(scenes[i].key, on);
    }
    var boxes = _$panel ? _$panel.querySelectorAll('.qqq-sfx-check') : [];
    for (var j = 0; j < boxes.length; j++) boxes[j].checked = on;
  }

  // ── ★ 显示楼层 32/64 = 激活（VIP）功能选值守卫（2026-09-05；64 档 2026-09-06）──
  //   2026-09-07 起守卫收敛进唯一真理机器 qqqEntitlement.guard（权限门 + 激活页 URL
  //   唯一源）；此处只保留 16 免费档直写 + 拒绝红字展示（onDeny）。值域校验与权限门分离。
  function _trySelectFloorCapVal(_val) {
    var ent = window.qqqEntitlement;
    var _deniedHint = function () {
      _floorCapHintOn = true;
      _renderPanel();
      clearTimeout(_floorCapHintTimer);
      _floorCapHintTimer = setTimeout(function () {
        if (!_floorCapHintOn) return;
        _floorCapHintOn = false;
        if (_$panel && _$panel.style.display !== 'none') _renderPanel();
      }, 5000);
    };
    // 16 = 免费档：直写零门卫
    if (!ent || _val <= 16) {
      _floorCapHintOn = false;
      set('ai.floorCap', _val);
      _renderPanel();
      return;
    }
    ent.guard('floor-cap-' + _val, { onDeny: _deniedHint }).then(function (ok) {
      if (ok) {
        _floorCapHintOn = false;
        set('ai.floorCap', _val);
        _renderPanel();
      }
    });
  }

  // ── ★ 系统解释器（.py/.js 关联 → 绿色包内置 Python/Node；唯一后端 shell/ipc-syspy.ts）──
  //   语义（2026-09-26）：一次性写入只管当——HKCU PATH + Classes 关联 + UserChoice hash 强写；
  //   系统已有其他解释器 → 先弹「将覆盖当前系统解释器」二确认；已是我们的 → 选中态（右下角圆勾徽章）
  //   → 再点 = 必出「取消作为系统 xx 解释器」确认 → 解除 = 纯清空一锤子买卖（不还原旧值，白板化）。
  function _interpSetState(t, busy, phase, kind, msg) {
    var st = _interpState[t];
    if (!st) return;
    st.busy = !!busy;
    st.phase = phase || 'idle';
    st.kind = kind || '';
    st.msg = msg || '';
    if (_$panel && _$overlay && _$overlay.style.display !== 'none') _renderPanel();
  }

  function _pyQoast(msg, type) {
    try {
      if (window.qqqideQoast && window.qqqideQoast.show) window.qqqideQoast.show(msg, { type: type || 'info', duration: 9000 });
    } catch (e) { /* ignore */ }
  }

  function _interpErrText(t, code) {
    var pfx = (t === 'node') ? 'settings.nodeInterp.' : 'settings.pyInterp.';
    var map = {
      'no-python': [pfx + 'errNoPython', '内置 Python 未就绪'],
      'no-node': [pfx + 'errNoNode', '内置 Node 未就绪'],
      'denied': [pfx + 'errDenied', '权限被拒绝（可能被安全软件拦截）'],
      'verify-failed': [pfx + 'errVerify', '写入未生效'],
      'uac-cancelled': [pfx + 'errUac', '已取消（未授权）'],
      'busy': [pfx + 'errBusy', '正在处理中，请稍候'],
      'unsupported': [pfx + 'errGeneric', '当前系统不支持'],
      'timeout': [pfx + 'errGeneric', '操作超时'],
      'spawn-failed': [pfx + 'errGeneric', '无法启动系统组件'],
      'check-failed': [pfx + 'errGeneric', '检查失败'],
      'ps-init-failed': [pfx + 'errGeneric', '系统组件初始化失败']
    };
    if (t === 'node' && code === 'no-python') code = 'no-node';
    var hit = map[code] || [pfx + 'errGeneric', '未知错误'];
    return _i(hit[0], hit[1]);
  }

  // ★ 串行操作链：静默探测（打开面板复查徽章真值）与点击流共用——绝不并发撞壳层 _inFlight
  var _interpOpChain = Promise.resolve();

  function _interpProbeOne(t) {
    var st = _interpState[t];
    var bridge = null;
    try { bridge = window.qqqideBridge && window.qqqideBridge.sysPy; } catch (e) { /* ignore */ }
    if (!bridge || !bridge.check || !st || st.busy) return Promise.resolve();
    return bridge.check(t).then(function (res) {
      if (res && res.ok && !st.busy) {
        var next = res.mode || '';
        if (st.mode !== next) {
          st.mode = next;
          if (_$panel && _$overlay && _$overlay.style.display !== 'none') _renderPanel();
        }
      }
    }, function () { /* silent */ });
  }

  function _interpSilentProbe() {
    _interpOpChain = _interpOpChain
      .then(function () { return _interpProbeOne('python'); }, function () { return _interpProbeOne('python'); })
      .then(function () { return _interpProbeOne('node'); }, function () { return _interpProbeOne('node'); });
  }

  function _onInterpClick(t) {
    var st = _interpState[t];
    if (!st || st.busy) return;
    var pfx = (t === 'node') ? 'settings.nodeInterp.' : 'settings.pyInterp.';
    var bridge = null;
    try { bridge = window.qqqideBridge && window.qqqideBridge.sysPy; } catch (e) { /* ignore */ }
    if (!bridge || !bridge.check) {
      _interpSetState(t, false, 'idle', 'fail', _i(pfx + 'errBridge', '需重启本窗口后可用'));
      return;
    }
    _interpSetState(t, true, 'checking', '', '');
    _interpOpChain = _interpOpChain
      .then(function () { return _interpClickFlow(bridge, t); }, function () { return _interpClickFlow(bridge, t); });
  }

  function _interpClickFlow(bridge, t) {
    var st = _interpState[t];
    var pfx = (t === 'node') ? 'settings.nodeInterp.' : 'settings.pyInterp.';
    return bridge.check(t).then(function (res) {
      if (!res || !res.ok) { _interpSetState(t, false, 'idle', 'fail', _interpErrText(t, res && res.code)); return; }
      if (res.mode) st.mode = res.mode;
      if (res.mode === 'unsupported') { _interpSetState(t, false, 'idle', 'fail', _interpErrText(t, 'unsupported')); return; }
      // 已是我们的（选中态）→ 解除流程：必出「取消作为系统 xx 解释器」确认 → 纯清空
      if (res.mode === 'ours') {
        _interpAsk(t, 'remove').then(function (go) {
          if (!go) { _interpSetState(t, false, 'idle', '', ''); return; }
          if (!bridge.remove) { _interpSetState(t, false, 'idle', 'fail', _i(pfx + 'errBridge', '需重启本窗口后可用')); return; }
          _interpRemove(bridge, t);
        });
        return;
      }
      if (!res.exeOk) { _interpSetState(t, false, 'idle', 'fail', _i(pfx + (t === 'node' ? 'errNoNode' : 'errNoPython'), t === 'node' ? '内置 Node 未就绪' : '内置 Python 未就绪')); return; }
      // 系统已有其他解释器（已设过 PATH / 已能双击打开）→ 二次确认「将覆盖」；否则直接干
      if (res.mode === 'other') {
        _interpAsk(t, 'override').then(function (go) {
          if (!go) { _interpSetState(t, false, 'idle', '', ''); return; }
          _interpApply(bridge, t, res.mode);
        });
      } else {
        _interpApply(bridge, t, res.mode);
      }
    }, function () { _interpSetState(t, false, 'idle', 'fail', _i(pfx + 'errGeneric', '未知错误')); });
  }

  function _interpRemove(bridge, t) {
    var pfx = (t === 'node') ? 'settings.nodeInterp.' : 'settings.pyInterp.';
    _interpSetState(t, true, 'removing', '', '');
    bridge.remove(t).then(function (res) {
      if (res && res.ok) {
        _interpState[t].mode = '';
        var okMsg = _i(pfx + 'okRemove', (t === 'node') ? '✅ 已解除：内置 Node 不再作为系统解释器' : '✅ 已解除：内置 Python 不再作为系统解释器');
        _interpSetState(t, false, 'idle', 'ok', okMsg);
        _pyQoast(okMsg, 'success');
        _interpSilentProbe();   // 真值复查（徽章/状态随真值收敛）
      } else {
        var failMsg = _i(pfx + 'failRemove', '❌ 解除失败：') + _interpErrText(t, res && res.code);
        _interpSetState(t, false, 'idle', 'fail', failMsg);
        _pyQoast(failMsg, 'error');
      }
    }, function () {
      var failMsg = _i(pfx + 'failRemove', '❌ 解除失败：') + _i(pfx + 'errGeneric', '未知错误');
      _interpSetState(t, false, 'idle', 'fail', failMsg);
      _pyQoast(failMsg, 'error');
    });
  }

  function _interpApply(bridge, t, mode) {
    var pfx = (t === 'node') ? 'settings.nodeInterp.' : 'settings.pyInterp.';
    var isNode = (t === 'node');
    _interpSetState(t, true, 'applying', '', '');
    bridge.apply(t).then(function (res) {
      if (res && res.ok) {
        _interpState[t].mode = 'ours';
        var okMsg = (mode === 'ours')
          ? _i(pfx + 'okRefresh', isNode ? '✅ 已刷新：内置 Node 已接管 .js' : '✅ 已刷新：内置 Python 已接管 .py')
          : _i(pfx + 'ok', isNode ? '✅ 已设置：双击 .js 由内置 Node 运行' : '✅ 已设置：双击 .py 由内置 Python 运行');
        _interpSetState(t, false, 'idle', 'ok', okMsg);
        _pyQoast(okMsg, 'success');
        _interpSilentProbe();   // 真值复查（徽章随真值收敛）
      } else {
        var failMsg = _i(pfx + 'fail', '❌ 设置失败：') + _interpErrText(t, res && res.code);
        _interpSetState(t, false, 'idle', 'fail', failMsg);
        _pyQoast(failMsg, 'error');
      }
    }, function () {
      var failMsg = _i(pfx + 'fail', '❌ 设置失败：') + _i(pfx + 'errGeneric', '未知错误');
      _interpSetState(t, false, 'idle', 'fail', failMsg);
      _pyQoast(failMsg, 'error');
    });
  }

  // 内置确认弹框（first-run 同款：CSS 变量自适应 / 主操作左 / Esc=取消 / 语言切换实时刷新 / 防重入）
  //   titleText 缺省 = 「将覆盖当前系统解释器」；解除场景传「取消作为系统 xx 解释器」
  function _interpConfirm(titleText) {
    return new Promise(function (resolve) {
      if (_pyConfirmOv) { resolve(false); return; }
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:1000001;display:flex;align-items:center;justify-content:center;';
      var panel = document.createElement('div');
      panel.style.cssText = 'width:420px;max-width:92vw;box-sizing:border-box;background:var(--background-color);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,0.5);padding:26px 28px 20px;font-size:14px;line-height:1.7;';
      var h = document.createElement('div');
      h.style.cssText = 'font-size:15px;font-weight:600;margin:0 0 4px;text-align:center;white-space:pre-line;';
      var btnOk = document.createElement('button');
      btnOk.type = 'button';
      btnOk.style.cssText = 'padding:7px 20px;border:1px solid var(--border-strong);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:13px;';
      var btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.style.cssText = btnOk.style.cssText;
      function _fill() {
        h.textContent = titleText || _i('settings.sysInterp.confirmTitle', '将覆盖当前系统解释器');
        btnOk.textContent = _i('settings.sysInterp.confirmOk', '确认');
        btnCancel.textContent = _i('settings.sysInterp.confirmCancel', '取消');
      }
      _fill();
      function _close(result) {
        document.removeEventListener('keydown', _onKey, true);
        window.removeEventListener('qqq-lang-change', _fill);
        if (_pyConfirmOv && _pyConfirmOv.parentNode) { try { _pyConfirmOv.parentNode.removeChild(_pyConfirmOv); } catch (e) { /* ignore */ } }
        _pyConfirmOv = null;
        resolve(result);
      }
      var _onKey = function (e) { if (e && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); _close(false); } };
      btnOk.addEventListener('click', function (e) { e.stopPropagation(); _close(true); });
      btnCancel.addEventListener('click', function (e) { e.stopPropagation(); _close(false); });
      document.addEventListener('keydown', _onKey, true);
      window.addEventListener('qqq-lang-change', _fill);
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:44px;';   // 用户定案：消息与按钮间两换行（≈2 行高）
      row.appendChild(btnOk);      // 布局与 first-run 一致：主操作在左
      row.appendChild(btnCancel);
      panel.appendChild(h);
      panel.appendChild(row);
      ov.appendChild(panel);
      document.body.appendChild(ov);
      _pyConfirmOv = ov;
    });
  }

  // ★ 确认框出口（AI 工具链 sys_python / sys_node 复用——与按钮同一弹框）：kind='override'（将覆盖）/ 'remove'（取消作为系统 xx 解释器）
  function _interpAsk(t, kind) {
    var pfx = 'settings.' + (t === 'node' ? 'nodeInterp.' : 'pyInterp.');
    if (kind === 'remove') {
      return _interpConfirm(_i(pfx + 'confirmRemove', (t === 'node') ? '取消作为系统 Node 解释器' : '取消作为系统 Python 解释器'));
    }
    return _interpConfirm();
  }
  try { window.qqqSysInterpConfirm = _interpConfirm; } catch (_) { /* ignore */ }
  try { window.qqqSysPyConfirm = _interpConfirm; } catch (_) { /* ignore */ }
  try { window.qqqSysInterpAsk = _interpAsk; } catch (_) { /* ignore */ }

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
  var _sfxOpen = false;       // ★ 音效开关子卡片展开态（音量卡片的 1 by 1）
  var _floorCapHintOn = false;    // ★ 显示楼层 32/64（激活功能）未激活红字提示态（2026-09-05；64 档 2026-09-06）
  var _floorCapHintTimer = null;
  // ★ 系统解释器状态（python/node 双目标；跨重渲染保留，唯一后端 shell/ipc-syspy.ts）
  var _interpState = {
    python: { busy: false, phase: 'idle', kind: '', msg: '', mode: '' },
    node: { busy: false, phase: 'idle', kind: '', msg: '', mode: '' }
  };
  var _pyConfirmOv = null;

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
    html += '<div style="padding:16px 20px; border-bottom:1px solid ' + border + '; display:flex; align-items:center;">';
    html += '<div style="display:flex; align-items:center; gap:12px;">';
    html += '<span style="font-size:15px; font-weight:bold; color:' + text + ';">' + _i('settings.title', '设置') + '</span>';
    html += '<button id="qqq-settings-restart" style="padding:3px 10px; border:1px solid ' + accent + '; border-radius:3px; background:transparent; color:' + accent + '; font-size:11px; cursor:default; white-space:nowrap;">' + _i('settings.restart', '重置窗口') + '</button>';
    // ★ 升级健康位（2026-09-22）：壳层快照（版本/更新状态/失败数/暂存态）+ 构建戳比对
    //   → 胶囊 + 悬停明细；SW 缓存旧 → 红色⚠️ 提示按「重置窗口」（core/update-health.js 唯一入口）
    html += '<span id="qqq-upd-health" style="font-family:Consolas,monospace;font-size:11px;color:' + textDim + ';">···</span>';
    html += '</div>';
    html += '</div>';

    // ★ 标签栏
    html += '<div style="display:flex; border-bottom:1px solid ' + border + ';">';
    html += '<button id="qqq-settings-tab-general" class="qqq-settings-tab" style="flex:1; padding:8px 0; border:none; border-bottom:2px solid ' + (_activeTab === 'general' ? accent : 'transparent') + '; background:transparent; color:' + (_activeTab === 'general' ? text : textDim) + '; font-size:13px; font-weight:' + (_activeTab === 'general' ? 'bold' : 'normal') + ';">' + _i('settings.tabGeneral', '常规') + '</button>';
    html += '<button id="qqq-settings-tab-advanced" class="qqq-settings-tab" style="flex:1; padding:8px 0; border:none; border-bottom:2px solid ' + (_activeTab === 'advanced' ? accent : 'transparent') + '; background:transparent; color:' + (_activeTab === 'advanced' ? text : textDim) + '; font-size:13px; font-weight:' + (_activeTab === 'advanced' ? 'bold' : 'normal') + ';">' + _i('settings.tabAdvanced', '高级') + '</button>';
    html += '</div>';

    html += '<div style="padding:12px 20px;">';

    // 筛选当前 tab 的设置项
    var tabDefs = [];
    for (var i = 0; i < SETTINGS_DEF.length; i++) {
      var dTab = SETTINGS_DEF[i].tab || 'general';
      if (dTab === _activeTab) tabDefs.push(SETTINGS_DEF[i]);
    }

    if (tabDefs.length === 0) {
      html += '<div style="font-size:12px; color:' + textDim + '; text-align:center; padding:40px 0;">' + _i('settings.empty', '此标签页暂无设置项') + '</div>';
    }

    // 渲染每个设置项
    for (var i = 0; i < tabDefs.length; i++) {
      var def = tabDefs[i];
      var currentVal = get(def.key, def.defaultValue);
      // ★ 系统解释器行（2026-09-26 用户定案）：零文字/零卡片框——纯左右两个大彩按钮
      var _isInterpRow = (def.type === 'interp');
      html += '<div class="qqq-setting-item" style="margin-bottom:16px;' + (_isInterpRow ? '' : ' padding:12px; border:1px solid ' + border + '; border-radius:4px; background:' + bg2 + ';') + '">';
      if (def.key === 'ai.compressLevel') {
        // ★ 标题行右侧问号按钮（外观照搬 ctx-panel #ctx-help），点击跳转上下文背包文档
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">';
        html += '<span style="font-size:13px;font-weight:bold;color:' + text + ';">' + _i(def.labelKey, def.label) + '</span>';
        html += '<button class="qqq-compress-help" style="display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:22px;position:relative;vertical-align:middle;font-size:13px;font-weight:bold;border:1px solid var(--border-color,#555);border-radius:3px;padding:0 6px;background:transparent;color:var(--text-primary,#eee);line-height:1;">?</button>';
        html += '</div>';
      } else if (def.key !== 'audio.volume' && def.type !== 'interp') {
        // 音量卡片的标题行由下方 flex 分支渲染（右侧挂 1 by 1 按钮）
        html += '<div style="font-size:13px; font-weight:bold; color:' + text + '; margin-bottom:4px;">' + _i(def.labelKey, def.label) + '</div>';
      }
      // ★ 音量卡片：标题行右侧挂「1 by 1」按钮（音效开关子卡片开合）
      if (def.key === 'audio.volume') {
        html += '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">';
        html += '<span style="font-size:13px; font-weight:bold; color:' + text + ';">' + _i(def.labelKey, def.label) + '</span>';
        html += '<button id="qqq-sfx-1x1" style="padding:2px 10px; border:1px solid ' + (_sfxOpen ? accent : border) + '; border-radius:3px; background:' + (_sfxOpen ? accent + '22' : 'transparent') + '; color:' + (_sfxOpen ? accent : textDim) + '; font-size:11px; cursor:default; white-space:nowrap; margin-left:20px;" title="' + _i('settings.sfxTooltip', '逐个音效开关') + '">1 by 1</button>';
        html += '</div>';
      }
      // ★ 无 desc 项不渲染描述行（防 undefined）
      if (def.desc && def.type !== 'interp') html += '<div style="font-size:11px; color:' + textDim + '; margin-bottom:10px;">' + _i(def.descKey, def.desc) + '</div>';

      if (def.type === 'slider-stepped') {
        var stops = def.stops || ['0', '25', '50', '75', '100'];
        var curIdx = stops.indexOf(String(currentVal));
        // ★ 显示楼层：异常存量值回落 16（免费档），防未激活用户 UI 默认闪 32
        if (curIdx < 0) curIdx = (def.key === 'ai.floorCap') ? 0 : stops.length - 1;
        var pct = Math.round((curIdx / (stops.length - 1)) * 100);
        // ★ 紧凑一行：左边标签 + 右边拉杆（无刻度数字）
        // ★ 2026-08-23: showLabel 变体（压缩档位三档）——左侧显示 stopsLabels 中文，非百分比
        var _sliderLabel = def.showLabel
          ? (def.stopsLabels ? (def.stopsLabelKeys ? _i(def.stopsLabelKeys[curIdx], def.stopsLabels[curIdx]) : def.stopsLabels[curIdx]) : stops[curIdx])
          : (stops[curIdx] + '%');
        html += '<div style="display:flex; align-items:center; gap:12px;">';
        html += '<span style="font-size:12px; color:' + (def.key === 'ai.floorCap' ? green : textDim) + '; white-space:nowrap; min-width:32px;">' + _sliderLabel + '</span>';
        // ★ 压缩档位 3 点拉杆宽度 = 音量 5 点拉杆的一半（点间距百分百一致：calc(50%-22px) = (X-44)/2，X=行宽）
        // ★ 显示楼层：拉杆几何与「自动压缩 上下文背包」完全同宽 calc(50%-22px)（2026-09-06 定版：三档点距=音量五档同一音长，每格长度三杆一致）
        var _sliderFlex = 'flex:1;';
        if (def.key === 'ai.compressLevel' || def.key === 'ai.floorCap') _sliderFlex = 'flex:0 0 calc(50% - 22px);';
        // ★ 显示楼层 专属暖绿色（2026-09-06 用户定案：VIP 功能标识色，与音量/压缩金橙色区分；左侧数值标签+圆点+已选填充一体）
        var _sliderColor = accent;
        var _dotIdle = border;
        if (def.key === 'ai.floorCap') {
          _sliderColor = green;
          _dotIdle = isDark ? 'rgba(143,188,90,0.5)' : 'rgba(133,153,0,0.5)';
        }
        html += '<div class="qqq-vol-slider" style="position:relative;' + _sliderFlex + 'height:24px;display:flex;align-items:center;user-select:none;" data-setting-key="' + def.key + '" data-stops="' + stops.join(',') + '">';
        html += '<div style="position:absolute;left:0;right:0;height:4px;border-radius:2px;background:' + border + ';"></div>';
        html += '<div style="position:absolute;left:0;height:4px;border-radius:2px;background:' + _sliderColor + ';width:' + pct + '%;"></div>';
        for (var si = 0; si < stops.length; si++) {
          var sp = Math.round((si / (stops.length - 1)) * 100);
          var isActive = si <= curIdx;
          html += '<div style="position:absolute;left:' + sp + '%;transform:translateX(-50%);width:12px;height:12px;border-radius:50%;border:2px solid ' + (isActive ? _sliderColor : _dotIdle) + ';background:' + (isActive ? _sliderColor : bg) + ';z-index:1;"></div>';
        }
        html += '</div>';
        // ★ 显示楼层：未激活用户点 32/64 → 拉杆右侧红字提示（2026-09-05；64 档 2026-09-06）
        if (def.key === 'ai.floorCap' && _floorCapHintOn) {
          // ★ 长译文布局韧性（2026-09-16）：允许换行回卷，防法语/俄语长译戳出面板（实测 fr 535px>480px）
          html += '<span style="font-size:11px; color:' + red + '; white-space:normal; word-break:break-word; line-height:1.3;">' + _i('settings.needActivation', '该功能需先激活') + '</span>';
        }
        html += '</div>';
        // ★ 音效开关子卡片（音量 1 by 1 展开态，紧随拉杆下方）
        if (def.key === 'audio.volume' && _sfxOpen) {
          html += _sfxCardHtml(bg, text, textDim, border, accent);
        }
      } else if (def.type === 'bool') {
        // 开关切换
        var boolOn = (currentVal === true || currentVal === 'true');
        var toggleId = 'qqq-setting-' + def.key.replace(/\./g, '-');
        html += '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;">';
        html += '<div style="position:relative; width:44px; height:24px; border-radius:12px; background:' + (boolOn ? green : border) + '; transition:background 150ms; flex-shrink:0;">';
        html += '<div style="position:absolute; top:2px; left:' + (boolOn ? '22px' : '2px') + '; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.3); transition:left 150ms;"></div>';
        html += '</div>';
        html += '<input type="checkbox" id="' + toggleId + '" ' + (boolOn ? 'checked' : '') + ' data-setting-key="' + def.key + '" style="position:absolute; opacity:0; pointer-events:none;">';
        html += '<span style="font-size:12px; color:' + text + ';">' + (boolOn ? _i('settings.on', '已开启') : _i('settings.off', '已关闭')) + '</span>';
        html += '</label>';
      } else if (def.type === 'radio') {
        // ★ 默认 AI 等级：3 个水平格子（显示 1/2/3 = 线上值 1/3/5；旧存量 2/4/6 自动换算到同组）
        if (def.key === 'ai.defaultTier') {
          // ★ 三格三选一（满行；系统解释器按钮已移至独立行——2026-09-26）
          html += '<div style="display:flex; gap:6px;">';
          var _tierRep = function (v) { var n = parseInt(v, 10); if (!(n >= 1)) return ''; return String(Math.ceil(n / 2) * 2 - 1); };
          for (var j = 0; j < def.options.length; j++) {
            var opt = def.options[j];
            var checked = (_tierRep(currentVal) === opt.value);
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
            html += '<div style="font-size:12px; color:' + text + ';">' + (opt.labelKey ? _i(opt.labelKey, opt.label) : opt.label) + '</div>';
            html += '<div style="font-size:10px; color:' + textDim + ';">' + (opt.descKey ? _i(opt.descKey, opt.desc) : opt.desc) + '</div>';
            html += '</div>';
            html += '</label>';
          }
        }
      } else if (def.type === 'interp') {
        // ★ 系统解释器行（2026-09-26 用户定案 v4）：零文字/零卡片框——左右两个大按钮；
        //   标准描边按钮样式（1px 边 + 3px 小圆角 + 透明底，同面板 restart/1by1 按钮语言）；
        //   颜色差异：Node=绿（冻结）/ Python=红；选中态（已接管）→ 右下角圆勾徽章；无渐变/无投影
        html += '<div style="display:flex; align-items:stretch; gap:14px;">';
        var _interpCols = [['node', 'qqq-sysnode-btn'], ['python', 'qqq-syspy-btn']];
        var _interpSkins = [
          { c: green, hov: isDark ? '#8fbc5a1e' : '#8599001e' },
          { c: red,   hov: isDark ? '#ff44441e' : '#dc322f1e' }
        ];
        for (var _ic = 0; _ic < _interpCols.length; _ic++) {
          var _t = _interpCols[_ic][0];
          var _st = _interpState[_t];
          var _pfx = 'settings.' + (_t === 'node' ? 'nodeInterp.' : 'pyInterp.');
          var _skin = _interpSkins[_ic];
          var _busyKey = (_st.phase === 'checking') ? 'busyChecking' : (_st.phase === 'removing' ? 'busyRemoving' : 'busyApplying');
          var _busyFb = (_st.phase === 'checking') ? '正在检查…' : (_st.phase === 'removing' ? '正在解除…' : '正在设置…');
          var _btnText = _st.busy
            ? _i(_pfx + _busyKey, _busyFb)
            : _i(_pfx + 'btn', _t === 'node' ? '做系统 Node 解释器' : '做系统 Python 解释器');
          html += '<div style="flex:1 1 0; min-width:0; display:flex; flex-direction:column; gap:6px;">';
          html += '<button id="' + _interpCols[_ic][1] + '" ' + (_st.busy ? 'disabled ' : '') + 'style="width:100%; box-sizing:border-box; min-height:58px; padding:10px 12px; position:relative; display:flex; align-items:center; justify-content:center; border:1px solid ' + _skin.c + '; border-radius:3px; background:transparent; color:' + _skin.c + '; font-size:13px; font-weight:bold; line-height:1.35; white-space:normal; word-break:break-word; text-align:center;' + (_st.busy ? ' opacity:0.55;' : '') + '"' + (_st.busy ? '' : ' onmouseover="this.style.background=&quot;' + _skin.hov + '&quot;" onmouseout="this.style.background=&quot;transparent&quot;"') + '>';
          html += _btnText;
          // ★ 选中态徽章（用户定案）：内置解释器接管中 → 右下角圆+大勾
          if (_st.mode === 'ours') {
            html += '<span aria-hidden="true" style="position:absolute; right:6px; bottom:6px; width:22px; height:22px; border-radius:50%; background:' + _skin.c + '; color:#fff; font-size:15px; line-height:22px; text-align:center; font-weight:bold; pointer-events:none;">✓</span>';
          }
          html += '</button>';
          if (_st.msg) {
            html += '<div style="font-size:11px; line-height:1.35; word-break:break-word; text-align:center; color:' + (_st.kind === 'ok' ? green : (_st.kind === 'fail' ? red : textDim)) + ';">' + _st.msg + '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
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

    // 关闭仅：点面板外阴影 / Esc（铁律 §4.1——内置面板不设 ✕）

    // 绑定重置窗口按钮（等价 Ctrl+Shift+R）
    var $restart = document.getElementById('qqq-settings-restart');
    if ($restart) {
      $restart.addEventListener('click', function () {
        $restart.textContent = _i('settings.restarting', '重置中...');
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

    // 绑定 bool checkbox 变更（data-setting-key 守卫：音效卡片的 qqq-sfx-check 无此属性，防空 key 写入）
    var checkboxes = _$panel.querySelectorAll('input[type="checkbox"]');
    for (var c = 0; c < checkboxes.length; c++) {
      checkboxes[c].addEventListener('change', function () {
        var key = this.getAttribute('data-setting-key');
        if (!key) return;
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
          var targetVal = stops[idx];
          // ★ 显示楼层：点拉杆先清未激活红字提示
          if (key === 'ai.floorCap') {
            _floorCapHintOn = false;
            clearTimeout(_floorCapHintTimer);
            if (targetVal === '32' || targetVal === '64') { _trySelectFloorCapVal(targetVal); return; }  // 32/64=激活功能，守卫接管
          }
          set(key, targetVal);
          _renderPanel();
        });
      })(sliderTracks[st]);
    }

    // ★ 系统解释器按钮（.py/.js 关联 → 内置解释器，唯一后端 shell/ipc-syspy.ts；独立行：左 node 右 Python）
    var $sysnodeBtn = document.getElementById('qqq-sysnode-btn');
    if ($sysnodeBtn) $sysnodeBtn.addEventListener('click', function () { _onInterpClick('node'); });
    var $syspyBtn = document.getElementById('qqq-syspy-btn');
    if ($syspyBtn) $syspyBtn.addEventListener('click', function () { _onInterpClick('python'); });

    // ★ 绑定 1 by 1 音效开关（按钮开合 + 勾选框即时生效，不整面板重渲染防拉杆跳动）
    var $sfx1x1 = document.getElementById('qqq-sfx-1x1');
    if ($sfx1x1) {
      $sfx1x1.addEventListener('click', function () { _sfxOpen = !_sfxOpen; _renderPanel(); });
    }
    var sfxChecks = _$panel.querySelectorAll('.qqq-sfx-check');
    for (var sc2 = 0; sc2 < sfxChecks.length; sc2++) {
      sfxChecks[sc2].addEventListener('change', function () {
        var k = this.getAttribute('data-sfx-key');
        if (window.qqqAudio && window.qqqAudio.sfxSet) window.qqqAudio.sfxSet(k, this.checked);
      });
    }
    // ★ All / None 超链接按钮（子卡片右上角）：一键全选 / 全不选（即时生效）
    var $sfxAll = _$panel.querySelector('.qqq-sfx-all');
    if ($sfxAll) $sfxAll.addEventListener('click', function (e) { e.preventDefault(); _sfxApplyAll(true); });
    var $sfxNone = _$panel.querySelector('.qqq-sfx-none');
    if ($sfxNone) $sfxNone.addEventListener('click', function (e) { e.preventDefault(); _sfxApplyAll(false); });

    // 绑定自动压缩帮助问号（跳转上下文背包文档，无 hover 提示）
    var helpBtns = _$panel.querySelectorAll('.qqq-compress-help');
    for (var hb = 0; hb < helpBtns.length; hb++) {
      helpBtns[hb].addEventListener('click', function () {
        var _docLang = (window.i18n && window.i18n.getLang) ? window.i18n.getLang() : 'zh';
        window.open('https://www.gh555.com/gaea/d/qqqide?lang=' + encodeURIComponent(_docLang) + '#docs/qqqide-backpack-ops', '_blank');
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
        clearTimeout(self._debounceTimer);
        self._debounceTimer = setTimeout(function () {
          set(key, String(val));
        }, 500);
      });
    }

    // 升级健康刷新（渲染到标题行·重置窗口右侧；core/update-health.js 唯一入口）
    if (window.__qqqUpdHealthRefresh) window.__qqqUpdHealthRefresh();
  }

  // ── 打开/关闭 ──
  function open() {
    _ensurePanel();
    _renderPanel();
    if (_$overlay) _$overlay.style.display = '';
    // Esc 关闭
    document.addEventListener('keydown', _onEsc);
    _interpSilentProbe();   // ★ 打开即静默复查（纯读）——「已接管」徽章与真值对齐
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
    // ★ 语言切换 → 打开中的面板/弹窗即时按新语言重渲染（i18n.setLang 广播 qqq-lang-change）
    window.addEventListener('qqq-lang-change', function () {
      if (_$overlay && _$overlay.style.display !== 'none') _renderPanel();
      if (_tierOverlay && _tierOverlay.style.display !== 'none') _renderTierPopup();
    });
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
    // 滚动条 / 文字可选中 / 拖选色统一由 shell-base.css「内嵌弹窗统一块」提供（铁律 §4.1——禁面板自注入）
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
    _tierPanel.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:' + _w + '; max-width:92vw; max-height:82vh; overflow-y:auto; z-index:9999; padding:0; border-radius:6px; box-shadow:0 8px 32px rgba(0,0,0,0.35); background:' + bg + ';';

    var html = '';
    // 标题行
    html += '<div style="padding:14px 20px; border-bottom:1px solid ' + border + '; display:flex; align-items:center;">';
    html += '<span style="font-size:15px; font-weight:bold; color:' + text + ';">' + _i('settings.tier.title', 'AI 等级说明') + '</span>';
    html += '</div>';

    html += '<div style="padding:16px 20px; font-size:13px; line-height:1.9; color:' + text + ';">';

    if (!_tierExpanded) {
      // ── 收拢态 ──
      html += '<div style="margin-bottom:12px;"><b style="color:' + accent + ';">' + _i('settings.tier.lv1', '1档：') + '</b>' + _i('settings.tier.t1', '最低智能，快、便宜。') + '</div>';
      html += '<div style="margin-bottom:14px;"><b style="color:' + accent + ';">' + _i('settings.tier.lv6', '3档：') + '</b>' + _i('settings.tier.t6', '最高智能，慢、贵。') + '</div>';
      html += '<div style="margin-bottom:4px;">' + _i('settings.tier.noAuto', 'qqqide 不再提供自动换档功能，');
      html += '<span id="tier-reason-link" style="color:' + red + '; text-decoration:underline; cursor:pointer;">' + _i('settings.tier.reason', '理由') + '</span>';
      html += '</div>';
    } else {
      // ── 展开态：完整说明 ──
      html += '<div style="margin-bottom:10px;"><b style="color:' + accent + ';">' + _i('settings.tier.lv1', '1档：') + '</b>' + _i('settings.tier.t1', '最低智能，快、便宜。') + '</div>';
      html += '<div style="margin-bottom:14px;"><b style="color:' + accent + ';">' + _i('settings.tier.lv6', '3档：') + '</b>' + _i('settings.tier.t6', '最高智能，慢、贵。') + '</div>';
      html += '<div style="margin-bottom:10px;">' + _i('settings.tier.noAutoReason', 'qqqide 不再提供自动换档功能，理由：') + '</div>';

      html += '<div style="color:' + textDim + '; line-height:1.8;">';
      html += '<p style="margin-top:0;">' + _i('settings.tier.arch', '为了方便你理解，我们划分出了如下架构：') + '</p>';
      html += '<p style="text-align:center; font-weight:bold; color:' + text + ';">project → quest → floor → house → room</p>';
      html += '<p>' + _i('settings.tier.p1', '一个 project 就是一个项目你也可以理解为就是一个文件夹，一个 quest 就是一个任务，你可以在一个任务里盖多层楼，你每发送出去一次消息就等于是盖了一层楼，也就是一个 floor，那你同时可以开多个任务（quest），每一个任务又可以盖多层楼，这很好理解。') + '</p>';
      html += '<p>' + _i('settings.tier.p2', '而在你看不到的后台，其实每一层楼都会跟服务器往返多次消息，也就是表面上你只按了一次发送，但实际上会做多次发送、和接收。') + '</p>';
      html += '<p>' + _i('settings.tier.p3', '为什么会那样？假想一种情况，比如你让服务器改一个超大项目的代码，服务器大概会多次返回查询指定代码的指令，以尽可能地了解你的本地代码，服务器的这种要求可以并行也可以串行，对于串行，服务器发送一个指令回来，你本地接收指令、按指令查询指令要求的代码（结果），再将结果发送回服务器，这样的一来一回我们叫做一个 <b>house</b>。') + '</p>';
      html += '<p>' + _i('settings.tier.p4', '而实际上，服务器可以一次提出多个要求，也就是服务器送回一次消息，你本地会「并行地」去执行多个指令，那么每一个指令我们叫他一个 <b>room</b>，每一个 room 返回一个结果，那看上去「多间 room」就组成了一个 house（对应了跟服务器的一来一回）。但非常重要的一点是，表面上看你只按了一次发送按钮：house 和 room 都是静默、自动地进行的（与服务器的交互）。') + '</p>';
      html += '<p>' + _i('settings.tier.p5', '最终看上去，一个 project 可以包含多个 quest，一个 quest 可以包含多个 floor，一个 floor 可以包含多个 house，一个 house 可以包含多个 room。') + '</p>';
      html += '<p style="margin-top:18px;"><b style="color:' + text + ';">' + _i('settings.tier.p6', '你可以休息一会儿，因为接下来就是重点。') + '</b></p>';
      html += '<p>' + _i('settings.tier.p7', '首先，你最难接受但必须接受的一个事实是：') + '</p>';
      html += '<p style="font-weight:bold; border-left:3px solid ' + red + '; padding-left:12px; color:' + text + ';">' + _i('settings.tier.p8a', '别说 project 和 quest，哪怕是同一个 floor 里面的不同 house（对应物理上的一次服务器往返），它们请求的可能都是物理隔绝的服务器（大模型），简单讲就是，服务器那边即便有缓存，但你也要假设服务器那边根本不会存在任何关于你本次任务（project、quest 或 floor）的任何记忆，也就是你首先必须要颠覆的一点认知是：') + '<span style="color:' + red + ';">' + _i('settings.tier.p8b', 'AI 根本不存在记忆。') + '</span></p>';
      html += '<p>' + _i('settings.tier.p9', '那你可能好奇，AI 是怎么记住 50 层楼之前你们的聊天内容的？你很难接受但必须接受的事实是：每一间 house，也就是哪怕是最细分的一次服务器往返，你发送给服务器的，都尽可能地带上了你之前每一层楼的所有对话、甚至工具查询结果，注意，每一次最细分的服务器往返，代表你即便不是按发送按钮而是后台自动静默的 house 级别的往返，都会尽量带上之前的一切，更别说 floor 级别的发送。而「一切」是指从第一层楼到现在的一切对话、工具调用结果，那样的一个集合也就是「上下文」。') + '</p>';
      html += '<p>' + _i('settings.tier.p10', '你的第一个问题是，那为什么没有盖两层楼就把 1M 的上下文总空间撑爆，主要原因是，根据 IDE 的策略选择不同，即便最保守的 AI IDE，也不会把 200KB 的源代码查询结果直接放进上下文，实际上大概只会截取里面 2KB 的关键行代码，而其他的工具结果，比如日志，基本都会被做成摘要，同样回到 KB 级别。') + '</p>';
      html += '<p>' + _i('settings.tier.p11', '而且 AI IDE 基本都会有自己的压缩策略，qqqide 的压缩策略是保留最近 6 层楼的完整信息，假设压缩时在最近 6 层楼之前有 200 层楼，那那 200 层楼会被压缩成最大 32KB 的摘要。压缩是一次专门的 AI 请求，就比如给 AI 1M 的文本（上下文），要求 AI 总结，返回不超过 32KB 的文本。') + '</p>';
      html += '<p>' + _i('settings.tier.p12', '我希望这就解释了，为什么在一个 quest 里，当你楼修到第 5 层，你放着不管过半年回来，你再按一次发送按钮，AI 还能跟你接着聊（似乎之前的一切它都记得），即便过了半年、模型早已更新换代……因为大模型是无状态的（不会保存关于你的任何记录），而你每一次都会发送完整上下文（它们不是储存在你本地硬盘，就是储存在中转服务器的硬盘里）。') + '</p>';
      html += '<p>' + _i('settings.tier.p13', '你可能还有一点不相信：「AI（大模型）总应该记得些什么？」。没有，什么都不记得。你认为的那些「记得」，只是你本地硬盘或者中转服务器偷偷在记的「小本本」，下次按发送按钮小本本会一起发给 AI。') + '</p>';
      html += '<p style="margin-top:18px;">' + _i('settings.tier.p14', 'ok，有了上面的认知，你可以得到第一个让你放心的结论：') + '</p>';
      html += '<p style="font-weight:bold; border-left:3px solid ' + accent + '; padding-left:12px; color:' + text + ';">' + _i('settings.tier.p15', '「无论怎样切换模型档位都不会导致记忆丢失」') + '</p>';
      html += '<p>' + _i('settings.tier.p16', '即：在任何时间点切换模型档位 → 记忆不会丢失 → 但会左右中间推论的质量。') + '</p>';
      html += '<p style="margin-top:18px;">' + _i('settings.tier.p17', '回到最原始的问题：qqqide 为什么不再提供自动换档功能。') + '</p>';
      html += '<p>' + _i('settings.tier.p18', '答案有两点：') + '</p>';
      html += '<p><b>1、</b>' + _i('settings.tier.p19', '不能保证「用最高的智能去写最重要的代码」，我们知道这一点至关重要，但总会有边界情况。') + '</p>';
      html += '<p><b>2、</b>' + _i('settings.tier.p20', '自动换档本质上是让最高智能的 AI 来评估问题复杂度（再来选择实际干活的 AI），但长远来看，每一层楼都会凭空增加至少一次「最高智能 AI」的调用，这是一笔长远账单，但如果反之，我们不用最高智能去做评估，又会增加第一点对应的风险。') + '</p>';
      html += '<p style="font-weight:bold; margin-top:16px;">' + _i('settings.tier.p21', '最终 qqqide 决定做一个更好用的换档杆，将换档权，百分百地只交在你手里。') + '</p>';
      html += '</div>';
    }

    html += '</div>';
    _tierPanel.innerHTML = html;
    _tierPanel.style.backgroundColor = bg;

    // 绑定事件（关闭仅：点面板外阴影 / Esc，铁律 §4.1）
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
