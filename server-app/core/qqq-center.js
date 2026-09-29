// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-center.js — qqq 设置中心（工作台大齿轮按钮的弹出大卡片）
//
// 2026-09-28 用户定案：
//   · 工作台卡（core/qqq-tools.js）：[↑][↓] 云同步按钮原样 + 齿轮（点击 → 打开本卡片）；
//     云同步机械由本文件导出（window.qqqCenter.doSync / open）供其桥接
//   · 本卡片 = 网站「设置」标签全量本地化（gaea-good-qqqide「设置」标签移除后的唯一设置入口）；
//     卡内不含云同步区——数据同步 [↑][↓] 仅在工作台卡（设置上传为后台自动）
//   · 样式 = 类似右上角齿轮设置面板（qd 风格：主题变量自适应 + 无轨现代滚动条 +
//     点面板外阴影 / Esc 关闭、无右上角关闭按钮——铁律 §4.1 内置面板统一规范）
//   · 下拉控件 = 自绘（.qc-select/.qc-pop）——原生 <select> 展开列表选中/悬停高亮在 Windows 上
//     恒为系统蓝且 CSS 不可覆盖（option:hover/:checked 无效），唯一可控解 = 完全自绘（qd 风格零蓝）
//     ★ 行悬停高亮 = var(--gold-hover-bg)（qd 金饰系，同 squad/login 下拉行；禁回退 --hover-bg 白亮——冷感，2026-09-28 用户定案）
//
// 数据机器: window.qqqPrefs（本地持久化 + 激活用户云同步 GET/PATCH /api/profile）
// 正版门: 💎 行（removeWatermark / roamName）未激活 = 锁 + 点击走 qqqEntitlement.guard(注册表 def.feat)
//
// 暴露: window.qqqCenter = { open, close, toggle, isOpen, doSync }
// ============================================================================

; (function () {
  'use strict';

  var PANEL_W = 640;

  var _overlay = null;
  var _panel = null;
  var _open = false;

  // ── 通用小工具 ──
  function _i(key, fb) { try { return window._i ? window._i(key, fb) : fb; } catch (e) { return fb; } }
  function _T(key, fb, map) {
    var v = _i(key, fb);
    if (map) { for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) { v = v.split('{' + k + '}').join(String(map[k])); } } }
    return v;
  }
  function _qoast(m, o) { try { if (window.qqqideQoast) { window.qqqideQoast.show(m, o || {}); } } catch (e) { } }
  function _el(tag, css, cls, text) {
    var d = document.createElement(tag);
    if (css) { d.style.cssText = css; }
    if (cls) { d.className = cls; }
    if (text !== undefined && text !== null) { d.textContent = text; }
    return d;
  }

  // ── 图标 ──
  //   齿轮 = 老项目 .icon-all-settings 原版 path（q4.js settingsCard 同款），currentColor 全主题自适应
  var _GEAR_PATH = 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22l-1.92 3.32c-.12.2-.07.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';
  function _gearSvg(size) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"><path d="' + _GEAR_PATH + '" fill="currentColor"/></svg>';
  }


  // ── 卡片内样式（组件自有小件；面板滚动条/拖选由 shell-base.css「内嵌弹窗统一块」提供）──
  var _styleDone = false;
  function _ensureStyle() {
    if (_styleDone || document.getElementById('qqq-center-style')) { _styleDone = true; return; }
    var s = document.createElement('style');
    s.id = 'qqq-center-style';
    s.textContent = [
      '.qc-btn { transition: border-color .12s ease, background .12s ease; }',
      '.qc-btn:hover:not(:disabled) { border-color: var(--primary-color, #b58900); }',
      '.qc-btn:disabled { opacity: .5; }',
      '.qqq-center-panel input[type="number"], .qqq-center-panel input[type="text"] { font-family: inherit; }',
      '.qqq-center-panel input:focus { outline: none; border-color: var(--primary-color, #b58900); }',
      '.qc-select { transition: border-color .12s ease; }',
      '.qc-select:hover, .qc-select.open, .qc-select:focus { outline: none; border-color: var(--primary-color, #b58900); }',
      '.qc-pop { position: fixed; z-index: 99999; background: var(--card-bg, #eee8d5); border: 1px solid var(--border-color, #d3c6aa); border-radius: 6px; box-shadow: 0 6px 22px rgba(0,0,0,0.18); padding: 4px; box-sizing: border-box; font-size: 12px; line-height: 1.4; max-height: 280px; overflow-y: auto; }',
      '.qc-pop-item { display: flex; align-items: flex-start; gap: 7px; padding: 5px 9px; border-radius: 4px; color: var(--text-primary, #656360); white-space: normal; word-break: break-word; }',
            '.qc-pop-item:hover, .qc-pop-item.act { background: var(--gold-hover-bg, #ddca88); }',
      '.qc-pop-item.sel:hover, .qc-pop-item.sel.act { color: var(--text-primary, #656360); }',
      '.qc-pop-item.sel { color: var(--primary-color, #b58900); }',
      '.qc-pop-item .qc-tick { flex-shrink: 0; width: 12px; visibility: hidden; }',
      '.qc-pop-item.sel .qc-tick { visibility: visible; }',
      '.qc-pop:focus { outline: none; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── 云数据同步（老 qqq AQ 按钮 100% 语义；相位自 qqq-tools.js 搬入） ──
  var _syncBusy = false;

  function _syncMiniIcon(svgHtml, size) {
    var ic = document.createElement('span');
    ic.style.cssText = 'display:inline-flex;width:' + (size || 15) + 'px;height:' + (size || 15) + 'px;align-items:center;justify-content:center;flex-shrink:0;';
    ic.innerHTML = svgHtml;
    return ic;
  }
  function _qcBtn(svgHtml, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'qc-btn';
    b.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:5px 10px;font-size:12px;' +
      'border:1px solid var(--border-color);border-radius:4px;background:var(--base3, rgba(128,128,128,0.06));' +
      'color:var(--text-primary);flex-shrink:0;';
    if (svgHtml) { b.appendChild(_syncMiniIcon(svgHtml)); }
    var sp = document.createElement('span');
    sp.textContent = label;
    b.appendChild(sp);
    if (onClick) { b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); }); }
    return b;
  }

  function _syncLabels(mode) {
    // ★ skipConfirm: 渲染层已用内置确认弹框完成法律确认——壳层收到后跳过原生模态（新壳层）；
    //   旧壳层忽略此字段（一次性双确认，重启后消失）。文案保留 = 旧壳层原生框也显示本地化文本。
    if (mode === 'push') {
      return {
        title: _i('sync.uploadConfirmTitle', '上传数据到云端'),
        message: _i('sync.uploadConfirmMsg', '我确认：\n1、我是正版用户；\n2、我的剪切板、文件记录偏好中不包括任何个人敏感信息（如密码），且不包括任何违法反动信息。'),
        ok: _i('sync.uploadConfirmBtn', '我确认并上传'),
        cancel: _i('sync.uploadCancel', '取消'),
        skipConfirm: true,
      };
    }
    return {
      title: _i('sync.pullConfirmTitle', '从云端合并数据'),
      message: _i('sync.pullConfirmMsg', '下载云端数据，将与本地漫游偏好和剪贴板历史合并（取并集，不丢失），是否继续？'),
      ok: _i('sync.pullConfirmBtn', '确认下载'),
      cancel: _i('sync.uploadCancel', '取消'),
      skipConfirm: true,
    };
  }
  function _syncReasonText(reason) {
    switch (reason) {
      case 'no-auth': return _i('sync.noAuth', '当前未登录，请先登录');
      case 'not-purchased': return _i('sync.errNotPurchased', '该用户非正版用户');
      case 'rate-limit': return _i('sync.errRateLimit', '请求太频繁，请稍后再试');
      case 'quota': return _i('sync.errQuota', '数据超出配额限制');
      case 'not-registered': return _i('sync.errNotRegistered', '该手机号未注册');
      case 'auth-expired': return _i('sync.errAuthExpired', '登录已过期，请重新登录');
      case 'no-data': return _i('sync.noData', '云端暂无数据');
      case 'network': return _i('sync.errNetwork', '网络错误，请检查网络连接');
      default: return _i('sync.errServer', '服务端错误，请稍后再试');
    }
  }

  // ── 内置确认弹框（first-run 同款风格；云同步法律确认 + 恢复默认共用）──
  //   语义保持：确认=true / 取消|Esc=false / 遮罩点击不关闭（法律确认防误触）；
  //   语言切换实时刷新；防重入（已有弹窗 → false）。
  var _confirmOv = null;
  function _closeConfirm() {
    if (_confirmOv) { try { if (_confirmOv.parentNode) { _confirmOv.parentNode.removeChild(_confirmOv); } } catch (e) { } }
    _confirmOv = null;
  }
  function _askConfirm(getTexts) {
    return new Promise(function (resolve) {
      if (_confirmOv) { resolve(false); return; }
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);' +
        'z-index:1000001;display:flex;align-items:center;justify-content:center;';
      var panel = document.createElement('div');
      panel.style.cssText = 'width:500px;max-width:92vw;box-sizing:border-box;' +
        'background:var(--background-color);color:var(--text-primary);' +
        'border:1px solid var(--border-strong);border-radius:10px;' +
        'box-shadow:0 12px 48px rgba(0,0,0,0.5);padding:26px 28px 20px;' +
        'font-size:14px;line-height:1.7;';

      var h = document.createElement('div');
      h.style.cssText = 'font-size:15px;font-weight:600;margin:0 0 12px;';
      var msg = document.createElement('div');
      msg.style.cssText = 'margin:0;white-space:pre-line;';

      var btnOk = document.createElement('button');
      btnOk.type = 'button';
      btnOk.style.cssText = 'padding:7px 20px;border:1px solid var(--border-strong);border-radius:6px;' +
        'background:transparent;color:var(--text-secondary);font-size:13px;';
      var btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.style.cssText = btnOk.style.cssText;

      function _fill() {   // i18n 填充（语言切换时重刷——开着弹窗切语言不锁旧文案）
        var t = {};
        try { t = getTexts() || {}; } catch (e) { t = {}; }
        h.textContent = t.title || '';
        msg.textContent = t.msg || '';
        btnOk.textContent = t.ok || _i('prefs.resetOk', '确认');
        btnCancel.textContent = t.cancel || _i('sync.uploadCancel', '取消');
      }
      _fill();

      function _close(result) {
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('qqq-lang-change', _fill);
        _closeConfirm();
        resolve(result);
      }
      var onKey = function (e) { if (e && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); _close(false); } };
      btnOk.addEventListener('click', function (e) { e.stopPropagation(); _close(true); });
      btnCancel.addEventListener('click', function (e) { e.stopPropagation(); _close(false); });
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('qqq-lang-change', _fill);

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:22px;';
      row.appendChild(btnOk);      // 布局与 first-run 一致：主操作在左
      row.appendChild(btnCancel);
      panel.appendChild(h);
      panel.appendChild(msg);
      panel.appendChild(row);
      ov.appendChild(panel);
      document.body.appendChild(ov);
      _confirmOv = ov;
    });
  }

  function _doSync(mode) {
    if (_syncBusy) { _qoast(_i('sync.lok', '正在同步中，请稍候…'), { duration: 4000 }); return; }
    var ud = null;
    try { ud = window.qqqideBridge && window.qqqideBridge.userData; } catch (e) { }
    if (!ud || !ud.push) {
      _qoast(_i('sync.bridgeMissing', '云同步不可用（需重启实例）'), { type: 'error', duration: 9000 });
      return;
    }
    var isPush = (mode === 'push');
    // 内置确认弹框先行（first-run 同款 UI 风格）；取消 = 静默返回（与原生 cancelled 语义一致）
    _askConfirm(function () {
      return {
        title: _i(isPush ? 'sync.uploadConfirmTitle' : 'sync.pullConfirmTitle', isPush ? '上传数据到云端' : '从云端合并数据'),
        msg: _i(isPush ? 'sync.uploadConfirmMsg' : 'sync.pullConfirmMsg', isPush
          ? '我确认：\n1、我是正版用户；\n2、我的剪切板、文件记录偏好中不包括任何个人敏感信息（如密码），且不包括任何违法反动信息。'
          : '下载云端数据，将与本地漫游偏好和剪贴板历史合并（取并集，不丢失），是否继续？'),
        ok: _i(isPush ? 'sync.uploadConfirmBtn' : 'sync.pullConfirmBtn', isPush ? '我确认并上传' : '确认下载'),
        cancel: _i('sync.uploadCancel', '取消'),
      };
    }).then(function (go) {
      if (!go) { return; }
      _runSync(mode, ud);
    });
  }
  function _runSync(mode, ud) {
    var isPush = (mode === 'push');
    _syncBusy = true;
    var io = null; try { io = window.qqqideIoast || null; } catch (e) { }
    var taskId = 'sync-' + mode + '-' + Date.now();
    var busyTitle = isPush ? _i('sync.uploading', '正在上传数据到云端...') : _i('sync.pulling', '正在从云端拉取数据...');
    if (io) { try { io.task(taskId, { title: '☁ ' + (isPush ? '↑' : '↓'), subtitle: busyTitle, progress: 0 }); } catch (e) { } }
    var p;
    try { p = isPush ? ud.push(_syncLabels('push')) : ud.pull(_syncLabels('pull')); }
    catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (r) {
      _syncBusy = false;
      if (r && r.ok) {
        var timeStr = new Date().toLocaleString();
        var msg = isPush
          ? _T('sync.uploadSuccess', '已上传到云端 ({0})', { 0: timeStr })
          : _T('sync.pullSuccess', '已从云端合并数据，新增 {1} 条 ({0})', { 0: timeStr, 1: (r.added || 0) });
        if (io) { try { io.done(taskId, { summary: msg }); } catch (e) { } }
        _qoast(msg, { type: 'success', duration: 8000 });
        return;
      }
      var reason = (r && r.reason) || 'unknown';
      if (reason === 'cancelled') { if (io) { try { io.remove(taskId); } catch (e) { } } return; }
      if (reason === 'busy') {
        if (io) { try { io.remove(taskId); } catch (e) { } }
        _qoast(_i('sync.lok', '正在同步中，请稍候…'), { duration: 4000 });
        return;
      }
      var emsg = isPush
        ? _T('sync.uploadFailed', '上传失败：{0}', { 0: _syncReasonText(reason) })
        : _T('sync.pullFailed', '恢复失败：{0}', { 0: _syncReasonText(reason) });
      if (io) { try { io.fail(taskId, { summary: emsg }); } catch (e) { } }
      _qoast(emsg, { type: 'error', duration: 9000 });
    }).catch(function (e) {
      _syncBusy = false;
      var em = String((e && e.message) || e || 'unknown');
      if (io) { try { io.fail(taskId, { summary: em }); } catch (e2) { } }
      _qoast(em, { type: 'error', duration: 9000 });
    });
  }

  // ── 设置描述表（网站「设置」标签全量本地化；主题/语言由客户端既有机器管理不入卡片）──
  // 组内条目 = { k: 注册表键, lab/desc: 完整键字面量 }（★ 键恒静态字面量——审计 ⑦ 动态拼接必须为零）
  var GROUPS = [
    { title: 'prefs.g.roam', fb: '🛸 Roam 漫游', items: [
      { k: 'szDisplayMode', lab: 'prefs.lab.szDisplayMode', desc: 'prefs.desc.szDisplayMode' },
      { k: 'sortBy', lab: 'prefs.lab.sortBy', desc: 'prefs.desc.sortBy' },
      { k: 'autoWatchChanges', lab: 'prefs.lab.autoWatchChanges', desc: 'prefs.desc.autoWatchChanges' },
      { k: 'roamName', lab: 'prefs.lab.roamName', desc: 'prefs.desc.roamName' },
    ] },
    { title: 'prefs.g.observe', fb: '👁️ Observer 观察者', items: [
      { k: 'performanceMode', lab: 'prefs.lab.performanceMode', desc: 'prefs.desc.performanceMode' },
      { k: 'frameSizeMode', lab: 'prefs.lab.frameSizeMode', desc: 'prefs.desc.frameSizeMode' },
      { k: 'enlargeSmallImages', lab: 'prefs.lab.enlargeSmallImages', desc: 'prefs.desc.enlargeSmallImages' },
      { k: 'textSlideColorScheme', lab: 'prefs.lab.textSlideColorScheme', desc: 'prefs.desc.textSlideColorScheme' },
      { k: 'textSlideFontSize', lab: 'prefs.lab.textSlideFontSize', desc: 'prefs.desc.textSlideFontSize' },
      { k: 'codelensLevel', lab: 'prefs.lab.codelensLevel', desc: 'prefs.desc.codelensLevel' },
    ] },
    { title: 'prefs.g.html', fb: '🍌 HTML & Rich Text', items: [
      { k: 'downloadSecurityLevel', lab: 'prefs.lab.downloadSecurityLevel', desc: 'prefs.desc.downloadSecurityLevel' },
      { k: 'forceTextFlowScheme', lab: 'prefs.lab.forceTextFlowScheme', desc: 'prefs.desc.forceTextFlowScheme' },
      { k: 'autoDownload', lab: 'prefs.lab.autoDownload', desc: 'prefs.desc.autoDownload' },
    ] },
    { title: 'prefs.g.doc', fb: '📦 Doc Export 文档导出', items: [
      { k: 'docExportImageResolution', lab: 'prefs.lab.docExportImageResolution', desc: 'prefs.desc.docExportImageResolution' },
      { k: 'docExportIncludeCipher', lab: 'prefs.lab.docExportIncludeCipher', desc: 'prefs.desc.docExportIncludeCipher' },
    ] },
    { title: 'prefs.g.premium', fb: '💎 Premium 正版专属', items: [
      { k: 'removeWatermark', lab: 'prefs.lab.removeWatermark', desc: 'prefs.desc.removeWatermark' },
    ] },
  ];

  // 枚举选项的中文标签键（值 = 注册表原值）
  var OPTS = {
    performanceMode: [['extreme', 'prefs.opt.performanceMode.extreme', 'Extreme：仅保留首帧，质量47'], ['accelerated', 'prefs.opt.performanceMode.accelerated', 'Accelerated：动图/视频最多前2秒，7fps，质量47'], ['optmum', 'prefs.opt.performanceMode.optmum', 'Optimum：短媒体（<10s）完整时长·原帧率；长媒体首/中/尾共4秒·15fps；质量71']],
    szDisplayMode: [['nothing', 'prefs.opt.szDisplayMode.nothing', '不显示'], ['size', 'prefs.opt.szDisplayMode.size', '显示文件大小'], ['ctime', 'prefs.opt.szDisplayMode.ctime', '显示创建时间'], ['mtime', 'prefs.opt.szDisplayMode.mtime', '显示修改时间']],
    sortBy: [['name', 'prefs.opt.sortBy.name', '按名字排序（文件夹在前）'], ['size', 'prefs.opt.sortBy.size', '按大小排序（文件夹在前，文件按大小降序）'], ['ctime', 'prefs.opt.sortBy.ctime', '按创建时间排序（降序）'], ['mtime', 'prefs.opt.sortBy.mtime', '按修改时间排序（降序）']],
    frameSizeMode: [['large', 'prefs.opt.frameSizeMode.large', '大框架：512×288'], ['small', 'prefs.opt.frameSizeMode.small', '小框架：256×144'], ['fix', 'prefs.opt.frameSizeMode.fix', '自适应：根据图片尺寸自动选择']],
    textSlideColorScheme: [['light', 'prefs.opt.textSlideColorScheme.light', '浅色'], ['dark', 'prefs.opt.textSlideColorScheme.dark', '深色']],
    codelensLevel: [['0', 'prefs.opt.codelensLevel.none', '无'], ['1', 'prefs.opt.codelensLevel.open', '仅打开文件'], ['7', 'prefs.opt.codelensLevel.full', '全套：文件夹/重命名/复制/信息行/qqqide']],
    downloadSecurityLevel: [['0: 最宽松', 'prefs.opt.downloadSecurityLevel.l0', '0：最宽松 — 全部11个安全开关关闭'], ['1: 平衡', 'prefs.opt.downloadSecurityLevel.l1', '1：平衡 — 4个开关打开，7个关闭'], ['2: 最严格', 'prefs.opt.downloadSecurityLevel.l2', '2：最严格 — 全部11个安全开关打开']],
    docExportImageResolution: [['original', 'prefs.opt.docExportImageResolution.original', '原始分辨率 — 完整精度'], ['frame', 'prefs.opt.docExportImageResolution.frame', '框架分辨率 — 文件更小，缩略图完整对应']],
  };

  // 标签/描述的中文回退（i18n 缺键时兜底；zh.json 为唯一真理源）
  var LAB_FB = {
    performanceMode: 'Performance Mode 性能模式',
    szDisplayMode: 'sz Column Display', sortBy: 'Sort By 排序', autoWatchChanges: 'Auto Watch Changes',
    roamName: 'Roam Name',
    frameSizeMode: 'Frame Size Mode', enlargeSmallImages: 'Enlarge Small Images',
    textSlideColorScheme: 'Text Slide Color Scheme', textSlideFontSize: 'Text Slide Font Size',
    codelensLevel: 'CodeLens Level',
    downloadSecurityLevel: 'Download Security Level', forceTextFlowScheme: 'Force Text Flow Scheme', autoDownload: 'Auto Download',
    docExportImageResolution: 'Image Resolution', docExportIncludeCipher: 'Include Cipher',
    removeWatermark: 'Remove Watermark 消除水印',
  };
  var DESC_FB = {
    performanceMode: '👁️ 决定「qqq相框」的渲染质量和速度',
    szDisplayMode: '🛸 sz列显示内容',
    sortBy: '🛸 文件列表排序方式',
    autoWatchChanges: '🛸 勾选：外部程序修改当前目录时自动刷新文件列表；不勾选：零性能开销',
    roamName: '🛸 自定义漫游名字（最多 12 字，显示在 Roam 标签上）',
    frameSizeMode: '👁️ 预览图尺寸模式',
    enlargeSmallImages: '👁️ 勾选：小于框架的预览图放大填充；不勾选：保持原尺寸居中',
    textSlideColorScheme: '👁️ 文本胶片底色',
    textSlideFontSize: '👁️ 文本胶片字号（1-218）',
    codelensLevel: '👁️ CodeLens 显示级别',
    downloadSecurityLevel: '🍌 下载视频失败时，可在此尝试更宽松的策略',
    forceTextFlowScheme: '🍌 强制修复HTML乱码（仅在顽固乱码时勾选，代价是布局精度降低）',
    autoDownload: '🍌 检测到视频时自动下载',
    docExportImageResolution: '📦 导出时使用的图片分辨率',
    docExportIncludeCipher: '📦 导出时包含图片密码串',
    removeWatermark: '💎 取消勾选后将显示水印（如果您想看水印的话）',
  };
  // 正版门提示文案（每 premium 键一行；guard 特性 id 读注册表 def.feat）
  var PREMIUM_NEED = {
    removeWatermark: ['prefs.wmNeed', '水印自定义是正版功能（激活后可用）'],
    roamName: ['prefs.rnNeed', '自定义漫游名字是正版功能（激活后可用）'],
  };
  function _needMsg(key) { var n = PREMIUM_NEED[key] || PREMIUM_NEED.removeWatermark; return _i(n[0], n[1]); }

  // ── 数据读写桥（qqqPrefs 未就绪时诚实提示）──
  function _P() { try { return window.qqqPrefs || null; } catch (e) { return null; } }
  function _needRefresh() { _qoast(_i('prefs.needRefresh', '偏好模块未就绪（需刷新窗口）'), { type: 'error', duration: 8000 }); }
  function _getVal(key) {
    var P = _P();
    if (!P) { return undefined; }
    try { return P.get(key); } catch (e) { return undefined; }
  }
  function _activated() {
    try { return !!(window.qqqPrefs && window.qqqPrefs.isActivated && window.qqqPrefs.isActivated()); } catch (e) { return false; }
  }
  function _commit(key, val) {
    var P = _P();
    if (!P) { _needRefresh(); return; }
    var ok = false;
    try { ok = P.set(key, val); } catch (e) { ok = false; }
    if (!ok) {
      var def = P.REGISTRY ? P.REGISTRY[key] : null;
      if (def && def.premium && !_activated()) { _qoast(_needMsg(key), { type: 'info', duration: 9000 }); }
      _syncControl(key);
      return;
    }
    _syncControl(key);
  }
  function _syncControl(key) {
    if (!_panel) { return; }
    if (_selInst[key]) { try { _selInst[key].set(_getVal(key)); } catch (e) { } return; }
    var el = null;
    try { el = _panel.querySelector('[data-qc-key="' + key + '"]'); } catch (e) { return; }
    if (!el) { return; }
    var v = _getVal(key);
    try {
      if (el.type === 'checkbox') { el.checked = !!v; }
      else { el.value = (v === undefined || v === null) ? '' : String(v); }
    } catch (e) { }
  }
  function _readVal(el) {
    if (el.type === 'checkbox') { return el.checked; }
    if (el.type === 'number') { var n = parseInt(el.value, 10); return isFinite(n) ? n : el.value; }
    return el.value;
  }
  function _onPanelChange(e) {
    var el = e.target;
    if (!el || !el.dataset || !el.dataset.qcKey) { return; }
    _commit(el.dataset.qcKey, _readVal(el));
  }
  function _onPanelInput(e) {
    var el = e.target;
    if (!el || !el.dataset || !el.dataset.qcKey) { return; }
    if (el.type !== 'number' && el.type !== 'text') { return; }
    if (el._qcTimer) { clearTimeout(el._qcTimer); }
    el._qcTimer = setTimeout(function () {
      el._qcTimer = null;
      _commit(el.dataset.qcKey, _readVal(el));
    }, 600);
  }

  function _doReset() {
    var P = _P();
    if (!P) { _needRefresh(); return; }
    _askConfirm(function () {
      return {
        title: _i('prefs.resetTitle', '恢复默认设置'),
        msg: _i('prefs.resetMsg', '将清除本机全部设置改动（如已开启云同步，云端配置也会一并清除）。确定继续吗？'),
        ok: _i('prefs.resetOk', '确认恢复'),
        cancel: _i('sync.uploadCancel', '取消'),
      };
    }).then(function (go) {
      if (!go) { return; }
      try { P.resetAll(); } catch (e) { }
      _render();
      _qoast(_i('prefs.resetDone', '已恢复默认设置'), { type: 'success', duration: 6000 });
    });
  }

  // ── 自绘下拉（qd 风格 · 零蓝）──
  //   ★ 弃用原生 <select>：Windows 上展开列表的选中/悬停高亮恒为系统蓝（option:hover/:checked CSS 无效）。
  //   popup 挂 body——面板自身带 transform 与 overflow:auto，fixed 浮层会被其捕获并裁剪，不可挂面板内。
  //   交互对齐原生：点击开合 / 点选提交 / Esc·外点·面板滚动·resize·失焦关闭 / ↑↓+Enter 键盘。
  var _pop = null;       // 打开中的下拉浮层 { pop, btn }
  var _selInst = {};     // key → { el, set(v) }（_syncControl 回滚用）
  var _popGlobals = false;

  function _closePop() {
    if (!_pop) { return; }
    var p = _pop;
    _pop = null;
    try { p.btn.classList.remove('open'); } catch (e) { }
    try { if (p.pop.parentNode) { p.pop.parentNode.removeChild(p.pop); } } catch (e) { }
  }
  function _onDocDownPop(e) {
    if (!_pop) { return; }
    try { if (_pop.pop.contains(e.target) || _pop.btn.contains(e.target)) { return; } } catch (e2) { }
    _closePop();
  }
  function _bindPopGlobals() {
    if (_popGlobals) { return; }
    _popGlobals = true;
    document.addEventListener('mousedown', _onDocDownPop, true);
    window.addEventListener('resize', _closePop);
    window.addEventListener('blur', _closePop);
  }

  function _qcSelect(opts, curVal, onPick) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qc-select';
    btn.style.cssText = 'width:100%;display:flex;align-items:center;gap:6px;text-align:left;' +
      'padding:4px 8px;font-size:12px;font-family:inherit;border:1px solid var(--border-color);border-radius:3px;' +
      'background:var(--background-color);color:var(--text-primary);box-sizing:border-box;line-height:1.5;';
    var txt = document.createElement('span');
    txt.style.cssText = 'flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    var caret = document.createElement('span');
    caret.style.cssText = 'flex-shrink:0;display:inline-flex;color:var(--text-secondary);';
    caret.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    btn.appendChild(txt);
    btn.appendChild(caret);
    wrap.appendChild(btn);

    var value = (curVal === undefined || curVal === null) ? '' : String(curVal);
    var items = [];
    var actIdx = 0;

    function _labelOf(v) {
      for (var i = 0; i < opts.length; i++) { if (String(opts[i][0]) === String(v)) { return _i(opts[i][1], opts[i][2] || String(v)); } }
      return String(v);
    }
    function _paint() { txt.textContent = _labelOf(value); }
    _paint();

    function _setAct(i) {
      actIdx = i;
      for (var k = 0; k < items.length; k++) { try { items[k].classList.toggle('act', k === i); } catch (e) { } }
      try { if (items[i]) { items[i].scrollIntoView({ block: 'nearest' }); } } catch (e) { }
    }

    function _openP() {
      if (_pop && _pop.btn === btn) { _closePop(); return; }   // 再点 = 收起
      _closePop();
      var pop = document.createElement('div');
      pop.className = 'qc-pop';
      pop.tabIndex = -1;
      items = [];
      for (var i = 0; i < opts.length; i++) {
        (function (ov, oi) {
          var it = document.createElement('div');
          it.className = 'qc-pop-item' + (String(ov) === value ? ' sel' : '');
          var tick = document.createElement('span');
          tick.className = 'qc-tick';
          tick.textContent = '✓';
          var lb = document.createElement('span');
          lb.textContent = _i(opts[oi][1], opts[oi][2] || String(ov));
          it.appendChild(tick);
          it.appendChild(lb);
          it.addEventListener('click', function (e) {
            e.stopPropagation();
            value = String(ov);
            _paint();
            _closePop();
            try { onPick(ov); } catch (e2) { }
          });
          pop.appendChild(it);
          items.push(it);
        })(opts[i][0], i);
      }
      // 键盘（浮层聚焦后接管；Esc 由面板级捕获处理——第一击先关浮层）
      pop.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); _setAct(Math.min(actIdx + 1, items.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); _setAct(Math.max(actIdx - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (items[actIdx]) { items[actIdx].click(); } }
        else if (e.key === 'Tab') { _closePop(); }
      });
      document.body.appendChild(pop);
      // 先量后位（按钮下缘 → 越界翻上 → 越界贴边；四边距恒 ≥8px）
      var r = btn.getBoundingClientRect();
      pop.style.width = Math.max(r.width, 160) + 'px';
      pop.style.left = '0px';
      pop.style.top = '0px';
      pop.style.visibility = 'hidden';
      var pr = pop.getBoundingClientRect();
      var vw = window.innerWidth, vh = window.innerHeight;
      var top = r.bottom + 2;
      if (top + pr.height > vh - 8) { top = r.top - pr.height - 2; }
      if (top < 8) { top = 8; }
      var left = r.left;
      if (left + pr.width > vw - 8) { left = Math.max(8, vw - 8 - pr.width); }
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      pop.style.visibility = '';
      btn.classList.add('open');
      _pop = { pop: pop, btn: btn };
      var curIdx = 0;
      for (var j = 0; j < opts.length; j++) { if (String(opts[j][0]) === value) { curIdx = j; break; } }
      _setAct(curIdx);
      try { pop.focus({ preventScroll: true }); } catch (e) { }
    }

    btn.addEventListener('click', function (e) { e.stopPropagation(); _openP(); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        _openP();
      }
    });

    return {
      el: wrap,
      set: function (v) { value = (v === undefined || v === null) ? '' : String(v); _paint(); },
      get: function () { return value; },
    };
  }

  // ── 面板 DOM ──
  function _ensurePanel() {
    if (_overlay) { return; }
    _ensureStyle();
    _overlay = _el('div', 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:9998;');
    _overlay.addEventListener('click', function (e) { if (e.target === _overlay) { close(); } });
    _panel = _el('div', 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:' + PANEL_W + 'px;max-width:92vw;' +
      'max-height:84vh;overflow-y:auto;z-index:9999;padding:0;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.35);' +
      'background:var(--background-color);color:var(--text-primary);font-size:13px;line-height:1.5;');
    _panel.className = 'qqq-center-panel';   // ★ 内嵌弹窗统一块钩子（滚动条/拖选——铁律 §4.1）
    _panel.addEventListener('change', _onPanelChange);
    _panel.addEventListener('input', _onPanelInput);
    _panel.addEventListener('scroll', _closePop, true);   // 面板滚动 → 下拉浮层关闭（防错位）
    _bindPopGlobals();
    _overlay.appendChild(_panel);
    document.body.appendChild(_overlay);
  }

  function _secTitle(text) {
    return _el('div', 'font-size:12px;font-weight:bold;color:var(--text-secondary);margin:16px 0 8px;', '', text);
  }


  function _buildItem(it) {
    var key = it.k;
    var P = _P();
    var def = P && P.REGISTRY ? P.REGISTRY[key] : null;
    if (!def) { return null; }
    var premiumLocked = !!(def.premium && !_activated());

    var box = _el('div', 'padding:10px 12px;border:1px solid var(--border-color);border-radius:4px;background:var(--card-bg);margin-bottom:10px;');

    // 标题行（标题 + 描述同行单线——铁律 §4.4 长译文布局韧性：描述省略号 + 悬停看全文）
    var head = _el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px;min-width:0;');
    head.appendChild(_el('span', 'font-size:13px;font-weight:bold;color:var(--text-primary);white-space:nowrap;flex-shrink:0;',
      '', _i(it.lab, LAB_FB[key] || key)));
    var dtext = _i(it.desc, DESC_FB[key] || def.desc || '');
    var dEl = _el('span', 'font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 0;min-width:0;', '', dtext);
    dEl.title = dtext;
    head.appendChild(dEl);
    if (premiumLocked) {
      var lk = _el('span', 'flex-shrink:0;font-size:12px;color:var(--text-dim);', '', '💎');
      lk.title = _needMsg(key);
      head.appendChild(lk);
    }
    box.appendChild(head);

    // 控件
    var ctl = null;
    if (def.type === 'enum') {
      // 自绘下拉（qd 风格；点击即提交——不走 change 事件委托）
      var inst = _qcSelect(OPTS[key] || [], String(_getVal(key)), function (v) { _commit(key, v); });
      ctl = inst.el;
      _selInst[key] = inst;
    } else if (def.type === 'bool') {
      ctl = document.createElement('input');
      ctl.type = 'checkbox';
      ctl.checked = !!_getVal(key);
      ctl.style.cssText = 'margin:0;accent-color:var(--primary-color, #b58900);width:15px;height:15px;vertical-align:middle;';
      if (premiumLocked) { ctl.disabled = true; }
    } else if (def.type === 'int') {
      ctl = document.createElement('input');
      ctl.type = 'number';
      if (def.min !== undefined) { ctl.min = String(def.min); }
      if (def.max !== undefined) { ctl.max = String(def.max); }
      ctl.value = String(_getVal(key));
      ctl.style.cssText = 'width:120px;padding:4px 8px;font-size:12px;border:1px solid var(--border-color);border-radius:3px;background:var(--background-color);color:var(--text-primary);box-sizing:border-box;';
    } else {
      ctl = document.createElement('input');
      ctl.type = 'text';
      ctl.value = (_getVal(key) === undefined || _getVal(key) === null) ? '' : String(_getVal(key));
      ctl.style.cssText = 'width:100%;padding:4px 8px;font-size:12px;border:1px solid var(--border-color);border-radius:3px;background:var(--background-color);color:var(--text-primary);box-sizing:border-box;';
      if (def.maxlen) { ctl.maxLength = def.maxlen; }   // 文本项硬上限（roamName=12；与 qqq-prefs _sanitizeStr 同口径）
      if (def.placeholder) { ctl.placeholder = def.placeholder; }   // 占位范例（roamName='的梦gaea'——注册表字面量，专名不译）
      if (premiumLocked) { ctl.disabled = true; }
    }
    if (def.type !== 'enum') { ctl.dataset.qcKey = key; }
    box.appendChild(ctl);

    // 正版行未激活：整行点按 → 权限门（guard：拒绝 = 提示 + 激活页；与显示楼层同款语义）
    if (premiumLocked) {
      box.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var ent = null; try { ent = window.qqqEntitlement || null; } catch (err) { ent = null; }
        if (ent && ent.guard) {
          ent.guard(def.feat || 'no-watermark', { onDeny: function () { _qoast(_needMsg(key), { type: 'info', duration: 9000 }); } });
        } else {
          _qoast(_needMsg(key), { type: 'info', duration: 9000 });
        }
      });
    }
    return box;
  }

  function _buildGroup(g) {
    var sec = _el('div', '');
    sec.appendChild(_secTitle(_i(g.title, g.fb)));
    for (var i = 0; i < g.items.length; i++) {
      var el = _buildItem(g.items[i]);
      if (el) { sec.appendChild(el); }
    }
    return sec;
  }

  function _buildFooter() {
    var f = _el('div', 'display:flex;align-items:center;justify-content:space-between;margin-top:16px;padding-top:12px;border-top:1px solid var(--border-color);');
    var rb = _qcBtn(null, _i('prefs.reset', '恢复默认设置'), _doReset);
    f.appendChild(rb);
    var tip = _el('span', 'font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', '');
    f.appendChild(tip);
    return f;
  }

  function _render() {
    if (!_panel) { return; }
    _closePop();
    _selInst = {};
    while (_panel.firstChild) { _panel.removeChild(_panel.firstChild); }

    // 标题行（图形齿轮 + 标题；无关闭按钮——点面板外 / Esc 关闭，铁律 §4.1）
    var head = _el('div', 'padding:14px 20px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:10px;');
    var gic = _el('span', 'display:inline-flex;width:18px;height:18px;color:var(--primary-color);');
    gic.innerHTML = _gearSvg(18);
    head.appendChild(gic);
    head.appendChild(_el('span', 'font-size:15px;font-weight:bold;color:var(--text-primary);', '', _i('prefs.title', 'qqq 设置')));
    _panel.appendChild(head);

    var body = _el('div', 'padding:12px 20px 18px;');
    _panel.appendChild(body);

    for (var i = 0; i < GROUPS.length; i++) { body.appendChild(_buildGroup(GROUPS[i])); }
    body.appendChild(_buildFooter());
  }

  function _onEsc(e) {
    if (!e || e.key !== 'Escape') { return; }
    if (_pop) { _closePop(); e.stopPropagation(); e.preventDefault(); return; }   // Esc 第一击：关下拉，不关面板
    e.stopPropagation();
    close();
  }
  // 打开即静默复查激活态（服务端每窗口一次；归来重渲染 + 未拉过的云端配置补拉一次）
  function _activationProbe() {
    var login = null;
    try { login = window.qqqLogin || null; } catch (e) { login = null; }
    if (!login || !login.isLoggedIn || !login.isLoggedIn() || !login.checkPurchased) { return; }
    try {
      login.checkPurchased().then(function () {
        if (_open) { _render(); }
        try {
          var P = _P();
          if (P && P.isActivated && P.isActivated() && P.cloudInfo && !P.cloudInfo().loaded) { P.pullCloud(); }
        } catch (e) { }
      }).catch(function () { });
    } catch (e) { }
  }

  function open() {
    _ensurePanel();
    _render();
    _overlay.style.display = '';
    _open = true;
    document.addEventListener('keydown', _onEsc, true);
    _activationProbe();
  }
  function close() {
    _closePop();
    if (_overlay) { _overlay.style.display = 'none'; }
    _open = false;
    document.removeEventListener('keydown', _onEsc, true);
  }
  function toggle() { if (_open) { close(); } else { open(); } }
  function isOpen() { return !!_open; }

  // 语言 / 主题切换 → 打开中即时重渲染（与设置面板同规）
  window.addEventListener('qqq-lang-change', function () { if (_open) { _render(); } });
  try {
    if (window.qqqideTheme && window.qqqideTheme.onChange) {
      window.qqqideTheme.onChange(function () { if (_open) { _render(); } });
    }
  } catch (e) { }

  window.qqqCenter = { open: open, close: close, toggle: toggle, isOpen: isOpen, doSync: _doSync };
})();
