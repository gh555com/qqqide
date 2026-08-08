// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// service-worker.js v333 — 国旗唯一渲染机：login.js 竞态根治 + 排行榜 flag 归一 + onerror 静默
// PWA strategy:
//   - index.html / navigation : network-first(2s), fallback cache, last-resort 503
//   - core/* qoods/* assets   : stale-while-revalidate
//   - health                  : network-only (no cache)
//   - qqqide-asset://*           : passthrough (electron handles it)
// Cache version bumps on each shell.css/js change.
// ========================================================================
const CACHE_NAME = 'qqq-shell-v400'; // v400: F2/Tab 激活 Roam 兜底直连（shell.js bootRoamKeyFallback 独立 capture 监听，key-hook 配置链失效也不静默） // v399: 1/8按钮只显示编队字符（去 ■ 前缀） // v398: 关闭确认无限循环根治（panel-send.js beforeunload 一次性拦截：保存完成前只挡一次，window.close() 重试不再被二次拦截 → 回车/确认后窗口必关，X 不再失灵） // v397: 关闭确认修复三件套——主窗口关闭不再连带销毁其他窗口 + 确认关闭走 close() 触发 beforeunload 持久化刷盘 + Enter/Esc 改 webContents 级捕获（iframe 焦点 100% 响应） // v396: Monaco TS/JS worker stub（诊断全禁后零职责，根治 Could not find source file e%3A 噪音） // v395: 窗口编队 squad（squad-btn.js 菜单行2 LV 左侧按钮+下拉，标题 x■ 前缀，Space+key 召回） // v394: activateRoam 诊断日志 + qoast 可见反馈 // v392: Roam Q 键=开新窗口(主文件夹=选中目录,restore 工作空间) W 键=系统资源管理器打开目录 // v391: Roam 左侧栏文字左移 6px（盘符 nav-item / qq-item / qq-text / qq-file 四规则 padding 10→4 / 18→12） // v390: 背包图解 Q/A ×1 bug 修复（楼层分割正则少一个等号，lookahead 永远不匹配 → 93 层只统计 1 个 Q/A） // v389: F2/Tab 激活 Roam 修复（F99: activateRoam 改走 qqTabs.activateTab，旧实现 btnEl/paneEl 字段不存在导致切换从不生效）+ AI 面板 iframe 转发 F2/Tab // v388: V21 onlyfacts 守卫恢复 32K + compress 楼层跳过 biscuit 占位 + 防 _compressFloor 泄漏 + compress 消息全量清理 // v387: 压缩按钮收益数字去除左侧空格（'-13k' 紧贴按钮文字） // v386: Roam btnNewFolder 按钮标签粘连修复(F73残留) + 619 null防护 // v385: 右键菜单粘贴去重（图片+文本共存只插一次文本，修重复插入） // v384: AI 面板多图粘贴（Ctrl+V 全量收集 + 串行保序 + 三重硬帽） // v383: 三活动豆腐块边框换色（清爽淡蓝 #3f96d8 / 原料淡红 #d98a86 / vibe 绿 #859900） // v382: 国旗唯一渲染机（login.js 竞态根治 + flag 归一 + onerror） // v381: F2 key binding + window.activateRoam handler now activates X-zone tab + focuses iframe // v380: Roam dark theme hover highlight + path-tooltip distinction // v379: Roam empty ctx menu click fix + btnNewFile/btnNewFolder data-tooltip + doCreateFile blur // v378: 修复活动豆腐块 CSS 损坏(注释吞掉 done-fill/.qqq-act-txt 规则) + 满格不再把原料边框改绿 + 赞助商链接常态同色永不下划线 + forced-color-adjust 兼容 Windows 高对比度(进度条渐变被强制抹空) // v377: newline-btn 移到编辑框外右上角（子弹按钮上方） // v376: Roam 文件菜单仅 6 项(AI/code/open/delete/rename/copyPath), 空区菜单复活(CMD=c/PowerShell=x 仅两项) // v374: AI 等级弹窗自定义无轨滚动条(5px)+文字可选中复制 // v373: newline-btn 移到编辑框右上角外侧（子弹按钮左侧） // v372: 赞助商拆分（前缀不带链接+公司名超链接）+ 原料活动边框偏红 + vibe 前缀文字与赞助商 100% 同外观 // v371: vibe 豆腐块常态发光+边框统一 + 状态区免费/非免费统一显示剩余时间 + 距下次/剩前缀同赞助商文字外观 // v369: 赞助商链接改为 por.jsp?id=1&_jcp=5_1 // v368: 赞助商移至三盏绿灯之右 // v367: 状态区排序还原 + vibe 豆腐块边框统一 // v366: 状态区单行 + 窄窗口退避隐藏 + vibe 余额解析修复 // v364: 赞助商 hover 橙色 // v363: 状态栏左下角赞助商文字（zhijiaip.com） // v362: index.html 恢复 klipzap.js + wq-stats.js 加载（F73 误删） // v361: Roam 文件/文件夹名左移 2px // v360: Roam 右键 AI 菜单项（←AI/AI/AI→ 焦点面板）+ CMD 快捷键 a→c
const PRECACHE_URLS = [
  './',
  './index.html',
  './core/shell-base.css',
  './core/shell-main.css',
  './core/shell-widgets.css',
  './core/shell.js',
  './core/shell-lang.js',
  './core/shell-menu.js',
  './core/shell-wings.js',
  './core/shell-overlay.js',
  './core/shell-statusbar.js',
  './core/shell-activities.js',
  './core/shell-rpc.js',
  './core/ipc-bridge.js',
  './core/menu-schema.js',
  './core/editor.js',
  './core/editor-breadcrumb.js',
  // WYSIWYG paste pipeline (v306)
  './core/__stamp.js',
  './core/klipzap.js',
  './core/wq-stats.js',
  './core/anchor-map.js',
  './core/frame-renderer.js',
  './core/thumbnail-cache.js',
  './core/content-widget.js',
  './core/qqq-viewzone.js',
  './core/paste-router.js',
  './core/transaction-manager.js',
  './core/batch-ops.js',
  './core/progress-service.js',
  './goods/file-explorer/file-explorer.js',
  './goods/git/git-diff-window.html',
  './goods/git/git-ui.html',
  './goods/git/git.js',
];

// ----------------------------------------------------------------------------
// Install: precache critical shell. Failures must NOT block install.
// ----------------------------------------------------------------------------
self.addEventListener('install', evt => {
  evt.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // Use individual put() so a single 404 doesn't fail the whole batch.
      await Promise.all(PRECACHE_URLS.map(async url => {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res && res.ok) { await cache.put(url, res.clone()); }
        } catch (_) { /* ignore single asset miss */ }
      }));
    } catch (_) { /* ignore */ }
    await self.skipWaiting();
  })());
});

// ----------------------------------------------------------------------------
// Activate: clean old cache versions, claim clients.
// ----------------------------------------------------------------------------
self.addEventListener('activate', evt => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function isHealth(url) { return url.pathname.endsWith('/health'); }
function isHTML(req) {
  return req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
}
function isAssetScheme(url) {
  // Skip our custom electron-served scheme entirely.
  return url.protocol === 'qqqide-asset:' || url.protocol === 'devtools:' || url.protocol === 'chrome:' || url.protocol === 'file:';
}
function isLocalService(url) {
  // Bypass localhost / 127.0.0.1 — these are local goods APIs (kope, etc.), not web assets.
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}
function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

// network-first with timeout, write-through cache.
async function networkFirst(req, ms) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await Promise.race([fetch(req), timeout(ms)]);
    if (res && res.ok) {
      try { await cache.put(req, res.clone()); } catch (_) { }
    }
    return res;
  } catch (_) {
    const cached = await cache.match(req) || await cache.match('./index.html') || await cache.match('./');
    if (cached) { return cached; }
    return new Response(
      '<!doctype html><meta charset=utf-8><title>offline</title>' +
      '<style>body{background:#fdf6e3;color:#586e75;font-family:sans-serif;padding:40px;text-align:center}</style>' +
      '<h2>qqq-shell · offline</h2><p>无可用缓存。请稍后再试。</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// ★ Network-first with cache fallback (2026-08-02 fix).
//   旧逻辑 cached || fetched 导致永远返回缓存->开发时改磁盘文件不生效。
//   新: 优先网络->成功后更新缓存; 网络失败->回退缓存(ignoreSearch 去 _v 参数)。
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      try { cache.put(req, res.clone()); } catch (_) { }
    }
    return res;
  } catch (_) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return new Response('', { status: 502, statusText: 'Gateway Error' });
  }
}

// ----------------------------------------------------------------------------
// Fetch routing
// ----------------------------------------------------------------------------
self.addEventListener('fetch', evt => {
  const req = evt.request;
  if (req.method !== 'GET') { return; }
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Skip schemes we shouldn't touch.
  if (isAssetScheme(url)) { return; }
  // health: never cache.
  if (isHealth(url)) { return; }
  // ★ API 调用：不拦截（登录轮询、AI 网关等）
  if (url.pathname.indexOf('/api/') !== -1) { return; }
  // ★ 构建戳记：永不缓存（百分百稳妥机器）
  if (url.pathname.indexOf('_BUILD_STAMP.json') !== -1) { return; }
  // ★ 本地服务：不拦截（goods 进程 API，如 kope-a:19820-19829）
  if (isLocalService(url)) { return; }

  if (isHTML(req)) {
    evt.respondWith(networkFirst(req, 2500));
    return;
  }

  // Same-origin static -> SWR.
  if (url.origin === self.location.origin) {
    evt.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Cross-origin (e.g. CDN font) -> cache-first best-effort.
  evt.respondWith(staleWhileRevalidate(req));
});

// ----------------------------------------------------------------------------
// Message: allow page to trigger skipWaiting / clear-cache from devtools.
// ----------------------------------------------------------------------------
self.addEventListener('message', evt => {
  const data = evt.data || {};
  if (data.type === 'skipWaiting') { self.skipWaiting(); }
  if (data.type === 'clearCache') {
    evt.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    })());
  }
});
