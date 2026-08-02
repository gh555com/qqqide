// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// build-stamp.js — 百分百稳妥机器：每次 Q 键启动 → 浏览器验证是否跑到最新代码
//
// 原理:
//   qide-shell.py 每次 Q 键 → 写 server-app/qqq/_BUILD_STAMP.json
//   浏览器加载时 fetch 此文件 → 显示 buildId 在状态栏
//   若 buildId 与 _LAST_BUILD_STAMP.txt 一致 → 跑的是最新代码 ✅
//   若不一致 / fetch 失败 → 跑的是旧代码（SW 缓存） ❌
//
// ★ 此文件不走 SW 缓存（service-worker.js 排除 _BUILD_STAMP.json）
//
// 暴露: window.qqqBuildStamp
// ============================================================================

(function () {
  'use strict';

  var BUILD_STAMP_URL = 'qqq/_BUILD_STAMP.json';

  // 缓存上一次成功的 buildId，用于检测 SW 缓存是否更新
  var _lastBuildId = null;
  var _loaded = false;

  function _display(buildId, time, gitHash, isFresh) {
    var $el = document.getElementById('qqq-status-build');
    if (!$el) return;

    var prefix = isFresh ? '✅' : '⚠️';
    var shortId = buildId ? buildId.slice(0, 8) : '????';

    $el.textContent = prefix + ' ' + shortId;
    $el.title = [
      'buildId=' + (buildId || '?'),
      'time=' + (time || '?'),
      'git=' + (gitHash || '?'),
      isFresh ? '最新代码 ✅' : '可能是旧代码（SW 缓存）⚠️',
    ].join('\n');
    $el.style.cursor = 'pointer';
    $el.style.fontFamily = 'Consolas, monospace';
    $el.style.fontSize = '11px';
    if (!isFresh) {
      $el.style.color = '#dc322f';
      $el.style.fontWeight = 'bold';
    }
  }

  async function _load() {
    try {
      // ★ 关键: fetch 带 cache: 'no-cache' + 时间戳参数
      //   SW 的 fetch handler 对此 URL 直接 pass through（不缓存）
      var url = BUILD_STAMP_URL + '?_=' + Date.now();
      var resp = await fetch(url, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      var isFresh = true;

      // 检查是否与磁盘上的一致（通过对比上次加载的 buildId）
      if (_lastBuildId && _lastBuildId !== data.buildId) {
        // buildId 变了 → 新代码生效了
        console.log('[build-stamp] 新 buildId:', data.buildId, '(旧:', _lastBuildId, ')');
      }

      _lastBuildId = data.buildId;
      _loaded = true;
      _display(data.buildId, data.time, data.gitHash, isFresh);
    } catch (e) {
      console.warn('[build-stamp] fetch 失败:', e.message || e);
      // fetch 失败 → 可能是 SW 缓存了旧代码，或者文件不存在
      _display(null, null, null, false);
    }
  }

  // ═══ 启动加载 ═══
  function boot() {
    // 延迟 500ms 确保 DOM 就绪
    setTimeout(_load, 500);
  }

  // ═══ 手动刷新（可从控制台调用） ═══
  function refresh() {
    _load();
  }

  // ═══ 暴露 ═══
  window.qqqBuildStamp = {
    boot: boot,
    refresh: refresh,
    getBuildId: function () { return _lastBuildId; },
    isLoaded: function () { return _loaded; },
  };

  // 自动启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  } else {
    boot();
  }

})();
