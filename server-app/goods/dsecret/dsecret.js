// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// goods/dsecret/dsecret.js — dsecret goods manifest（密钥脱敏专职控制台）
//
// 定位（2026-08-21）: secret-guard.js（core/，后台事件驱动懒惰脱敏引擎）的
//   专职控制台 —— 干净独立应用（同 kmd 模式，X 区 file 分组 custom tab）。
//   引擎仍跑在后台（git badge 上升沿自动抹除 T1/T2 + T3 常驻 qoast），
//   dsecret 提供: 主动扫描（未提交/全量体检）、T3 协同队列、自动抹除审计、
//   白名单管理、.gitignore 忽略工具、历史暴露检查（git log -S）。
//
// 打开入口 = qqqGaea.open('dsecret') → def.opener → qqqTabs.openFileCustomTab
//   （菜单行2 按钮 / gaea-host toolbarIds 同路由）
//
// 职责双份：
//   ① goods 注册（opener 路由，打开 file 分组 custom tab，单例）
//   ② iframe 中转器：iframe 请求 → window.__qqqSecretGuard（parent 引擎）
//      + qqq:git-dirty 事件桥实时推送（tab 打开时订阅，关闭即退订）
//
// iframe 通信协议：
//   iframe → parent: {type:'dsecret:ready'} / {type:'dsecret:init'}
//                     {type:'dsecret:scan', mode} / {type:'dsecret:act', action, item}
//                     {type:'dsecret:data'} / {type:'dsecret:wl-remove', kind, key}
//                     {type:'dsecret:git-log', value} / {type:'dsecret:gitignore', relPath, rmCached}
//                     {type:'dsecret:toggle', on} / {type:'dsecret:open-file', relPath, line, path}
//   parent → iframe: {type:'dsecret:init', enabled, projects, current}
//                     {type:'dsecret:enabled', on}（设置面板侧改开关 → 本页实时同步）
//                     {type:'dsecret:scan-result', result} / {type:'dsecret:act-result', pending}
//                     {type:'dsecret:data', data} / {type:'dsecret:git-dirty', path, count}
//                     {type:'dsecret:git-log-result', result} / {type:'dsecret:gitignore-result', relPath, result}
// ============================================================================
(function () {
  'use strict';

  if (!window.qqqGaea) {
    window.addEventListener('DOMContentLoaded', function () {
      if (window.qqqGaea) registerDsecret();
    });
    return;
  }

  registerDsecret();

  function registerDsecret() {
    var bridge = window.qqqideBridge;
    var _iframe = null;     // 当前 dsecret tab 的 contentWindow（单例）
    var _offDirty = null;   // git-dirty 事件桥退订函数
    var _offSetting = null; // secret.maskHelp 设置变更退订函数

    var _previewPath = null;   // 本控制台开出的只读预览路径（重复点同一文件保持只读）

    // ── 第二行点击 → 右侧 editor 只读预览 + 跳行（纯查看：不写盘、不改文件）──
    //   ① 文件已在编辑器里开着（用户自己的 tab）→ 只跳行、不动它的可编辑性；
    //   ② 需要新开 → readOnly；且只读不是死状态：下次普通打开会自动恢复可编辑（tab-manager._applyPaneOpts）。
    function openPreview(projPath, relPath, line) {
      try {
        if (!projPath || !relPath) return false;
        var abs = String(projPath).replace(/\\/g, '/').replace(/\/$/, '') + '/' + String(relPath).replace(/\\/g, '/');
        var live = null;
        try { if (window.qqqEditor && window.qqqEditor.getEditorForFile) live = window.qqqEditor.getEditorForFile(abs); } catch (_) {}
        var keepRO = (!live) || (_previewPath === abs);
        window._nextPaneOpts = { line: parseInt(line, 10) || 1, col: 1, readOnly: keepRO };
        if (window.qqqTabs && window.qqqTabs.openFileInRightGroup) window.qqqTabs.openFileInRightGroup(abs);
        else document.dispatchEvent(new CustomEvent('qqq-file-open', { detail: { path: abs } }));
        _previewPath = keepRO ? abs : null;
        if (keepRO && window.qqqideQoast) {
          window.qqqideQoast.show(window._i ? window._i('goods.dsecret.previewTip', '只读预览（不可编辑）— 要改这个文件请从文件树打开') : '只读预览（不可编辑）', { duration: 4000 });
        }
        return true;
      } catch (_) { return false; }
    }

    // ── 打开 dsecret：X 区 file 分组 custom tab（单例，同 kmd 模式） ──
    function openDsecretTab(side) {
      if (!window.qqqTabs || !window.qqqTabs.openFileCustomTab) return false;
      var tab = window.qqqTabs.openFileCustomTab('dsecret', 'dsecret', function (pane) {
        pane.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
        var iframe = document.createElement('iframe');
        iframe.src = '/qqqide/goods/dsecret/dsecret-ui.html';
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        iframe.setAttribute('frameborder', '0');
        pane.appendChild(iframe);
        _iframe = iframe.contentWindow;

        // iframe ready → init（enabled + 项目列表 + 当前项目）
        var dsecretInit = function (e) {
          if (!e.data || e.data.type !== 'dsecret:ready') return;
          if (e.source !== iframe.contentWindow) return;
          window.removeEventListener('message', dsecretInit);
          postInit(iframe.contentWindow);
        };
        window.addEventListener('message', dsecretInit);

        // iframe → 引擎中转
        window.addEventListener('message', function (e) {
          if (!e.data || e.source !== iframe.contentWindow) return;
          var d = e.data;
          var sg = window.__qqqSecretGuard;
          if (!sg) return;
          var win = iframe.contentWindow;
          if (d.type === 'dsecret:init') { postInit(win); return; }
          if (d.type === 'dsecret:scan') {
            sg.scanProject(d.path, d.mode).then(function (res) {
              post(win, 'dsecret:scan-result', { path: d.path, mode: d.mode, result: res });
            }).catch(function (err) {
              post(win, 'dsecret:scan-result', { path: d.path, mode: d.mode, error: String(err && err.message || err) });
            });
            return;
          }
          if (d.type === 'dsecret:act') {
            sg.act(d.path, d.action, d.item).then(function (pending) {
              post(win, 'dsecret:act-result', { action: d.action, pending: pending });
            }).catch(function (err) {
              post(win, 'dsecret:act-result', { action: d.action, error: String(err && err.message || err) });
            });
            return;
          }
          if (d.type === 'dsecret:data') {
            sg.getData(d.path).then(function (data) { post(win, 'dsecret:data', { data: data }); });
            return;
          }
          if (d.type === 'dsecret:wl-remove') {
            sg.removeWl(d.path, d.kind, d.key).then(function () { post(win, 'dsecret:data-updated', {}); });
            return;
          }
          if (d.type === 'dsecret:git-log') {
            sg.gitLogSearch(d.path, d.value).then(function (res) { post(win, 'dsecret:git-log-result', { result: res }); });
            return;
          }
          if (d.type === 'dsecret:gitignore') {
            sg.gitIgnoreAdd(d.path, d.relPath, d.rmCached).then(function (res) { post(win, 'dsecret:gitignore-result', { relPath: d.relPath, result: res }); });
            return;
          }
          if (d.type === 'dsecret:toggle') { sg.setEnabled(d.on); return; }
          if (d.type === 'dsecret:open-file') { openPreview(d.path, d.relPath, d.line); return; }
        });

        // tab 关闭（pane 从 DOM 移除）→ 退订事件桥
        var mo = new MutationObserver(function () {
          if (!pane.isConnected) {
            mo.disconnect();
            if (_offDirty) { try { _offDirty(); } catch (_) {} _offDirty = null; }
            _iframe = null;
          }
        });
        mo.observe(pane.parentNode || document.body, { childList: true });
      }, { closable: true });
      if (tab) tab.onReopen = function (s) { return openDsecretTab(s); };
      return !!tab;
    }

    function post(win, type, extra) {
      try { win.postMessage(Object.assign({ type: type }, extra || {}), '*'); } catch (_) {}
    }

    // 初始化数据：开关 + AI 视口项目列表 + 当前项目
    function postInit(win) {
      var enabled = true;
      try { enabled = !!(window.__qqqSecretGuard && window.__qqqSecretGuard.isEnabled()); } catch (_) {}
      var projects = [];
      var current = null;
      try {
        if (window.qqqideViewport && window.qqqideViewport.getProjects) {
          projects = window.qqqideViewport.getProjects().map(function (p) { return { path: p.path, name: p.name }; });
        }
        if (window.qqqideViewport && window.qqqideViewport.getMainProject) {
          var m = window.qqqideViewport.getMainProject();
          if (m) current = m.path;
        }
      } catch (_) {}
      ensureSettingBridge();
      post(win, 'dsecret:init', { enabled: enabled, projects: projects, current: current });
    }

    // ── git-dirty 事件桥：后台 badge 轮询 → dsecret tab 实时刷新 ──
    if (window.__qqqSecretGuard && !_offDirty) {
      _offDirty = window.__qqqSecretGuard.onDirty(function (ev) {
        if (!_iframe) return;
        post(_iframe, 'dsecret:git-dirty', { path: ev.path, count: ev.count });
      });
    }

    // ── 开关双向同步：设置面板侧改「协助密钥脱敏」→ 本页勾选框实时跟随 ──
    //   懒绑定（首次 init 时才订）：保证 qqqSettings 已就位，且不会在模块先于它加载时静默漏订。
    function ensureSettingBridge() {
      if (_offSetting || !window.qqqSettings || !window.qqqSettings.onChange) return;
      _offSetting = window.qqqSettings.onChange('secret.maskHelp', function (v) {
        if (!_iframe) return;
        post(_iframe, 'dsecret:enabled', { on: (v !== false && v !== 'false') });
      });
    }

    window.qqqGaea.register({
      id: 'dsecret',
      title: 'dsecret',
      version: '1.0.0',
      protoVer: 2,

      // ★ 打开路由：gaea-host.open('dsecret') → opener → file 分组 custom tab
      opener: function () { return openDsecretTab(); },

      commands: ['dsecret.open'],
      provides: ['dsecret'],
      uses: []
    });
  }
})();
