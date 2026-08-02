// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// service-worker.js v237 — online-popup: +day +ge columns, no color diff, sync bottom-left
// PWA strategy:
//   - index.html / navigation : network-first(2s), fallback cache, last-resort 503
//   - core/* qoods/* assets   : stale-while-revalidate
//   - health                  : network-only (no cache)
//   - qqqide-asset://*           : passthrough (electron handles it)
// Cache version bumps on each shell.css/js change.
// ========================================================================
const CACHE_NAME = 'qqq-shell-v326'; // v326: fix ViewZone _attached stale after tab close → reopen no images; anchor-map re-attach cleanup; editor.js onDidDispose calls viewzone/anchor-map/paste-router dispose
const PRECACHE_URLS = [
  './',
  './index.html',
  './core/shell.css',
  './core/shell.js',
  './core/shell-lang.js',
  './core/shell-menu.js',
  './core/shell-wings.js',
  './core/shell-overlay.js',
  './core/shell-statusbar.js',
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
