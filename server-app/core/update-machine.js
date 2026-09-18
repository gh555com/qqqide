// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// update-machine.js — mac 应用内更新 UI 机器（2026-09-18）
//
// 壳层 mac-updater 的状态（检查/下载/暂存/就绪/换装）→ 主窗口两处出口:
//   ① 菜单行2 更新按钮（#qqq-update-btn）: 常态=手动检查；就绪=点击直接换装；下载中=仅提示
//   ② qoast: 就绪（常驻 + 「重启更新」按钮）/ 已更新 / 已回滚 / 检查结果反馈
//
// Windows 无此机制（更新由 C 启动器托管）→ 本模块在非 mac 平台整体静默返回。
// 依赖: qqqideBridge.update.*（preload）+ qqqideQoast + window._i。
// ============================================================================
(function () {
  'use strict';
  if (String(navigator.platform || '').indexOf('Mac') !== 0) { return; }
  var b = null;
  try { b = window.qqqideBridge; } catch (_) { }
  if (!b || !b.update || !b.update.macState) { return; }

  var _state = { phase: 'idle' };
  var _notified = '';        // 一次性通知去重（版本 / upd:版本 / rb）
  var _btn = null;
  var _applying = false;

  function t(key, fb, params) {
    try { if (typeof window._i === 'function') return window._i(key, fb, params); } catch (_) { }
    var s = String(fb == null ? '' : fb);
    if (params) { for (var k in params) { s = s.split('{' + k + '}').join(String(params[k])); } }
    return s;
  }
  function qoast(msg, opts) {
    try { if (window.qqqideQoast && window.qqqideQoast.show) { window.qqqideQoast.show(msg, opts || {}); } } catch (_) { }
  }

  function apply() {
    if (_state.phase !== 'ready' || _applying) { return; }
    _applying = true;
    qoast(t('shell.update.applying', '正在更新，应用即将重启…'), { duration: 0, type: 'info' });
    try {
      var p = b.update.macApply();
      // 失败快速路径（not-ready / spawn 失败）→ 解除锁 + 提示
      if (p && p.then) {
        p.then(function (r) {
          if (!r || !r.ok) { _applying = false; qoast(t('shell.update.failed', '更新检查失败，稍后自动重试'), { duration: 8000, type: 'warn' }); }
        })['catch'](function () { _applying = false; });
      }
    } catch (_) { _applying = false; }
  }

  function readyToast(ver) {
    _notified = ver || '?';
    qoast(t('shell.update.toast', '新版本 v{version} 已就绪，重启后生效', { version: _notified }), {
      duration: 0, type: 'info',
      action: { label: t('shell.update.apply', '重启更新'), onClick: apply }
    });
  }

  function renderBtn() {
    if (!_btn) { return; }
    var s = _state;
    var title = t('shell.update.check', '检查更新');
    if (s.phase === 'checking') { title = t('shell.update.checking', '正在检查更新…'); }
    else if (s.phase === 'downloading') { title = t('shell.update.downloading', '正在下载新版本 {pct}%', { pct: (s.pct == null ? 0 : s.pct) }); }
    else if (s.phase === 'staging') { title = t('shell.update.staging', '正在准备新版本…'); }
    else if (s.phase === 'ready') { title = t('shell.update.readyBtn', '新版 v{version} 已就绪，点击更新', { version: s.version || '?' }); }
    else if (s.phase === 'applying') { title = t('shell.update.applying', '正在更新，应用即将重启…'); }
    _btn.title = title;
    _btn.classList.toggle('qqq-update-ready', s.phase === 'ready');
    _btn.classList.toggle('qqq-update-busy', s.phase === 'downloading' || s.phase === 'staging' || s.phase === 'applying' || s.phase === 'checking');
  }

  function render(s) {
    if (!s || !s.phase) { return; }
    _state = s;
    renderBtn();
    if (s.phase === 'ready' && s.version && _notified !== s.version) { readyToast(s.version); }
    if (s.phase === 'updated' && _notified !== 'upd:' + (s.version || '?')) {
      _notified = 'upd:' + (s.version || '?');
      qoast(t('shell.update.done', '已更新到 v{version}', { version: s.version || '?' }), { duration: 9000, type: 'success' });
    }
    if (s.phase === 'rolledback' && _notified !== 'rb') {
      _notified = 'rb';
      qoast(t('shell.update.rolledback', '本次更新未完成，已回到上一版本'), { duration: 0, type: 'warn' });
    }
  }

  function onClick() {
    if (_applying) { return; }
    if (_state.phase === 'ready') { apply(); return; }
    if (_state.phase === 'downloading' || _state.phase === 'staging' || _state.phase === 'checking') {
      qoast(t('shell.update.busy', '新版本正在后台下载，完成后会提示'), { duration: 6000, type: 'info' });
      return;
    }
    qoast(t('shell.update.checking', '正在检查更新…'), { duration: 4000, type: 'info' });
    Promise.resolve(b.update.macCheck()).then(function (r) {
      r = r || {};
      if (r.ready) { return; }   // 状态事件会弹就绪提示
      if (r.upToDate) { qoast(t('shell.update.latest', '已是最新版本 v{version}', { version: r.version || '?' }), { duration: 6000, type: 'success' }); }
      else if (r.found) { qoast(t('shell.update.found', '发现新版本 v{version}，正在后台下载…', { version: r.version || '?' }), { duration: 6000, type: 'info' }); }
      else if (r.unsupported) { qoast(t('shell.update.unavailable', '当前安装位置不支持应用内更新'), { duration: 8000, type: 'warn' }); }
      else if (r.busy) { /* 状态事件自会刷新按钮 */ }
      else { qoast(t('shell.update.failed', '更新检查失败，稍后自动重试'), { duration: 6000, type: 'warn' }); }
    })['catch'](function () {
      qoast(t('shell.update.failed', '更新检查失败，稍后自动重试'), { duration: 6000, type: 'warn' });
    });
  }

  function boot() {
    _btn = document.getElementById('qqq-update-btn');
    if (_btn) {
      _btn.style.display = '';
      // 标题由本模块接管（动态状态文案）→ 摘除 data-i18n-title 防语言切换回写
      try { _btn.removeAttribute('data-i18n-title'); } catch (_) { }
      _btn.addEventListener('click', onClick);
      renderBtn();
    }
    try { b.update.onMacState(render); } catch (_) { }
    Promise.resolve(b.update.macState()).then(render)['catch'](function () { });
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); }
  else { boot(); }
})();
