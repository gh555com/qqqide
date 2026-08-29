// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-statusbar.js — 状态栏时钟 + 免费时段指示器（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window._i, window._sseTimeAnchor (AI 面板推送)
// ============================================================================

function bootStatusbar(boot) {
  var bridge = window.qqqideBridge;
  var $ver = document.getElementById('qqq-status-version');
  var $onl = document.getElementById('qqq-status-online');
  var $clk = document.getElementById('qqq-status-clock');
  if ($ver) $ver.textContent = 'v' + (boot.version || '?');
	if ($onl) $onl.textContent = '0';

	// ═══ 赞助商轮换（状态栏左下角）— 大20s/中10s/小5s，瞬间替换文字（无滚动动画，防视觉分散）═══
	// 数据源: GET /api/sponsor/current（三档位当前小时胜出者；无人竞拍 → 默认成都知佳）
	// 拉取限频 1 次/分钟（轮播完刷新与失败重试共用）；失败保持默认品牌；点击打开当前品牌超链接
	(function () {
		var $link = document.getElementById('qqq-sponsor-link');
		if (!$link) return;
		var DEFAULT_BRAND = '知佳'; // 离线兜底（服务器不可达时）；正常以 /api/sponsor/current 返回为准（服务端 sponsor_config 可配置）
		var DEFAULT_URL = 'http://www.zhijiaip.com/por.jsp?id=1&_jcp=5_1';
		var items = [];
		var idx = -1;
		var timer = null;

		function applyItem(item) {
			// 瞬间替换文字 + 超链接（零动画，位置/样式与静态版完全一致）
			$link.textContent = item.brand || DEFAULT_BRAND;
			$link.href = item.url || DEFAULT_URL;
		}

		var _lastFetchAt = 0;
		function fetchCurrent() {
			var now = Date.now();
			if (now - _lastFetchAt < 60000) return Promise.resolve(); // 限频 1 次/分钟
			_lastFetchAt = now;
			return fetch('https://direct-cn.gh555.com/api/sponsor/current', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (d) {
					if (d && d.ok && d.items && d.items.length) {
						items = d.items;
						idx = -1;
					}
				})
				.catch(function () { /* 静默 */ });
		}

		function scheduleNext() {
			if (timer) clearTimeout(timer);
			if (items.length) {
				idx = (idx + 1) % items.length;
				applyItem(items[idx]);
				var secs = (items[idx].display_seconds || 5) * 1000;
				timer = setTimeout(scheduleNext, secs);
				if (idx === items.length - 1) fetchCurrent(); // 一轮播完刷新
			} else {
				timer = setTimeout(function () {
					fetchCurrent().then(scheduleNext);
				}, 60000); // 失败重试 60s（与限频同频）
			}
		}

		$link.addEventListener('click', function (e) {
			e.preventDefault();
			var url = $link.getAttribute('href') || DEFAULT_URL;
			if (bridge && bridge.shell && bridge.shell.openExternal) {
				bridge.shell.openExternal(url);
			} else {
				window.open(url, '_blank');
			}
		});

		// 首显默认品牌（fetch 返回前）
		$link.textContent = DEFAULT_BRAND;
		$link.href = DEFAULT_URL;
		fetchCurrent().then(scheduleNext);
	})();

  // ★ 硬刷新按钮 — 菜单行2，等价 Ctrl+Shift+R
  var $rf = document.getElementById('qqq-refresh-btn');
 	if ($rf) {
		$rf.addEventListener('click', function () {
			if (bridge && bridge.shell && bridge.shell.hardRefresh) {
				bridge.shell.hardRefresh();
			} else {
				// Fallback: clear caches then reload (hardRefresh IPC not available = shell not recompiled yet)
				if (window.caches) { window.caches.keys().then(function(ks){ return Promise.all(ks.map(function(k){ return window.caches.delete(k); })); }).catch(function(){}); }
				location.reload();
			}
		});
	}

	// ═══ 全球在线人数 — fetch 极轻轮询（30字节/5分钟，跨窗口稳定）═══
	// ★ 隐藏链接：hover 零外观零 tooltip，点击仍打开在线用户面板
	(function () {
		if (!$onl) return;

		var _onlLastFetch = 0;
		var _onlUsersOpen = false;
		var _onlOverlay = null;
		var _onlPanel = null;
		var _onlFetching = false;

		function fetchOnline() {
			var now = Date.now();
			if (now - _onlLastFetch < 240000) return;
			_onlLastFetch = now;
			fetch('https://direct-cn.gh555.com/api/qqqide/online-total', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (data) {
					if (data && data.ok && typeof data.total === 'number') {
						$onl.textContent = data.total > 0 ? data.total.toLocaleString() : '0';
					}
				})
				.catch(function () { /* 静默 */ });
		}

		// ═══ 点击弹出在线用户列表 ═══
		function buildOnlineUsersPanel() {
			var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
			var bg = isDark ? '#1e1e1e' : '#fdf6e3';
			var border = isDark ? '#333' : '#d3c6aa';

			_onlOverlay = document.createElement('div');
			_onlOverlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:9998;';
			_onlOverlay.addEventListener('click', function (e) { if (e.target === _onlOverlay) closeOnlineUsers(); });

			_onlPanel = document.createElement('div');
			_onlPanel.className = 'qqq-onl-panel';
			_onlPanel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:700px;max-width:94vw;max-height:80vh;overflow-y:auto;z-index:9999;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.35);background:' + bg + ';font-size:13px;';
			_onlPanel.innerHTML =
				'<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid ' + border + ';position:sticky;top:0;background:' + bg + ';">' +
				'<span style="font-weight:bold;">在线用户</span>' +
				'<button id="qqq-onl-close" style="width:22px;height:22px;border:1px solid ' + border + ';border-radius:3px;background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:center;">✕</button>' +
				'</div>' +
				'<div id="qqq-onl-body" style="padding:8px 12px;"></div>';
			_onlOverlay.appendChild(_onlPanel);
			document.body.appendChild(_onlOverlay);
			document.getElementById('qqq-onl-close').addEventListener('click', closeOnlineUsers);
		}

		function closeOnlineUsers() {
			_onlUsersOpen = false;
			if (_onlOverlay) _onlOverlay.style.display = 'none';
		}

		function openOnlineUsers() {
			if (!_onlOverlay) buildOnlineUsersPanel();
			if (_onlUsersOpen) { closeOnlineUsers(); return; }
			_onlUsersOpen = true;
			_onlOverlay.style.display = '';
			fetchOnlineUsers();
		}

		function fetchOnlineUsers() {
			if (_onlFetching) return;
			_onlFetching = true;
			var $body = document.getElementById('qqq-onl-body');
			if ($body) $body.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">加载中...</div>';

			fetch('https://direct-cn.gh555.com/api/qqqide/online-users', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (data) {
					_onlFetching = false;
					if (!data || !data.ok || !$body) return;
					var users = data.users || [];
					if (users.length === 0) {
						$body.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">暂无用户</div>';
						return;
					}
					// ★ 统计在线人数，同步更新左下角（比 online-total 缓存更实时）
				var onlineCount = 0;
				for (var j = 0; j < users.length; j++) { if (users[j].online) onlineCount++; }
				if ($onl) $onl.textContent = onlineCount > 0 ? onlineCount.toLocaleString() : '0';
				var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
			var html = '<table style="width:100%;border-collapse:collapse;">';
				html += '<thead><tr style="border-bottom:1px solid ' + (isDark ? '#333' : '#d3c6aa') + ';">';
				html += '<th style="padding:4px 6px;text-align:left;">手机号</th>';
				html += '<th style="padding:4px 6px;text-align:right;">day</th>';
				html += '<th style="padding:4px 6px;text-align:right;">消耗</th>';
				html += '<th style="padding:4px 6px;text-align:right;">独立消耗</th>';
				html += '<th style="padding:4px 6px;text-align:right;">最近在线</th>';
				html += '<th style="padding:4px 6px;text-align:right;">连续(m)</th>';
				html += '<th style="padding:4px 6px;text-align:right;">独立</th>';
				html += '<th style="padding:4px 6px;text-align:right;">版本</th>';
				html += '<th style="padding:4px 6px;text-align:right;">累计(h)</th>';	html += '</tr></thead><tbody>';
						for (var i = 0; i < users.length; i++) {
					var u = users[i];
					var lastSeen = new Date(u.last_seen_at * 1000);
					var yr = lastSeen.getFullYear();
					var mon = ('0' + (lastSeen.getMonth() + 1)).slice(-2);
					var day = ('0' + lastSeen.getDate()).slice(-2);
					var timeStr = yr + '-' + mon + '-' + day + ' ' + ('0' + lastSeen.getHours()).slice(-2) + ':' + ('0' + lastSeen.getMinutes()).slice(-2);
					var contM = typeof u.continuous_m === 'number' ? Math.round(u.continuous_m) : 0;
					var contStr = contM + 'm';
					var totalH = typeof u.total_m === 'number' ? Math.round(u.total_m / 60) : '-';
					var totalStr = typeof totalH === 'number' ? totalH + 'h' : '-';
					var ver = u.client_ver || '-';
					var daysReg = typeof u.days_since_register === 'number' ? u.days_since_register : '-';
					var paidGe = typeof u.total_consumed_ge === 'number' ? u.total_consumed_ge : 0;
					var freeGe = typeof u.free_consumed_ge === 'number' ? u.free_consumed_ge : 0;
					var geStr = paidGe + '+' + freeGe;
					var indPaidGe = typeof u.independent_consumed === 'number' ? u.independent_consumed : 0;
					var indFreeGe = typeof u.independent_free === 'number' ? u.independent_free : 0;
					var indGeStr = indPaidGe + '+' + indFreeGe;
					html += '<tr style="border-bottom:1px solid ' + (isDark ? '#2a2a2a' : '#eee8d5') + ';">';
					html += '<td style="padding:4px 6px;font-family:monospace;">' + u.phone + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + daysReg + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + geStr + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + indGeStr + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;font-size:12px;white-space:nowrap;">' + timeStr + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + contStr + '</td>';
					var indep = typeof u.independent === 'number' ? u.independent : '-';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + indep + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;font-size:11px;">' + ver + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + totalStr + '</td>';
					html += '</tr>';				}
				html += '</tbody></table>';
					$body.innerHTML = html;
				})
				.catch(function () {
					_onlFetching = false;
					var $body = document.getElementById('qqq-onl-body');
					if ($body) $body.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">加载失败，请重试</div>';
				});
		}

		$onl.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openOnlineUsers(); });

		// ═══ 启动包内存显示 — 主进程 mem-meter 真理机器广播（2026-08-29 v2），一包多窗口同值零重复统计 ═══
		// 口径 = 专用工作集 Private WS（任务管理器「内存」列同口径，三值合一唯一值，F12/F13 定案）
		// hover 细节 = core/shell-mem-hover.js 高科技面板（24h 曲线），此元素零 title
		var $mem = document.getElementById('qqq-status-mem');
		if ($mem && bridge && bridge.mem) {
			function renderMem(m) {
				if (!m || typeof m.mb !== 'number' || m.mb <= 0) return;
				$mem.textContent = m.mb + ' MB';
			}
			if (bridge.mem.getMetrics) bridge.mem.getMetrics().then(renderMem).catch(function () { /* 静默 */ });
			bridge.mem.onMetrics(renderMem);
		}

		// ═══ 总在线时间（累计陪伴小时）— 纯展示，hover 零外观零 tooltip ═══
		// 数据源: /api/qqqide/online-users 当前用户行 total_m（分钟，服务端 companion_seconds 权威累计）
		// 口径: Math.round(total_m/60)+'h' 与在线面板「累计(h)」完全一致；客户端零记录，直接打印服务器值
		var $tot = document.getElementById('qqq-status-total');

		// 与服务端 maskPhone 同款（phone[:5] + **** + 后4位）
		function maskPhoneLikeServer(p) {
			if (!p || p.length < 9) return p;
			return p.slice(0, 5) + '****' + p.slice(p.length - 4);
		}

		function fetchMyTotal() {
			if (!$tot) return;
			var target = '';
			try { if (window.qqqLogin) target = window.qqqLogin.getPhone() || ''; } catch (e) { }
			target = maskPhoneLikeServer(target);
			if (!target) { $tot.textContent = '--'; return; }
			fetch('https://direct-cn.gh555.com/api/qqqide/online-users', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (data) {
					if (!data || !data.ok || !data.users || !data.users.length) return;
					for (var i = 0; i < data.users.length; i++) {
						if (data.users[i].phone === target && typeof data.users[i].total_m === 'number') {
							$tot.textContent = Math.round(data.users[i].total_m / 60) + 'h';
							return;
						}
					}
					$tot.textContent = '--';
				})
				.catch(function () { /* 静默 */ });
		}
		// 登录状态变化 → 立即刷新（登录/登出都走这里）
		try { if (window.qqqLogin && window.qqqLogin.onStateChange) window.qqqLogin.onStateChange(fetchMyTotal); } catch (e) { }

		// ★ 版本号隐藏链接 — 点击打开更新日志，hover 零外观零 tooltip（与在线人数同款）
		if ($ver) {
			$ver.addEventListener('click', function (e) {
				e.preventDefault();
				var url = 'https://www.gh555.com/gaea/d/qqqide#changelog';
				if (bridge && bridge.shell && bridge.shell.openExternal) {
					bridge.shell.openExternal(url);
				} else {
					window.open(url, '_blank');
				}
			});
		}

		fetchOnline();
		fetchMyTotal();
		setInterval(fetchOnline, 300000);
		setInterval(fetchMyTotal, 300000);
	})();

  // ═══ 单调时钟锚点（变速齿轮免疫，三保险） ═══
  // 优先级：SSE(gh555.com) > Cloudflare trace > timeapi.io
  var _timeAnchor = null; // { perfNow, utcMs, source: 'sse'|'cf'|'timeapi' }
  var _lastSseAnchor = null; // 最新 SSE 锚点（最高优先级）

  // 从 SSE 获取时间（AI 面板通过 parent._sseTimeAnchor 推送）
  function pollSseAnchor() {
    if (window._sseTimeAnchor && window._sseTimeAnchor !== _lastSseAnchor) {
      _lastSseAnchor = window._sseTimeAnchor;
      _timeAnchor = {
        perfNow: window._sseTimeAnchor.perfNow,
        utcMs: window._sseTimeAnchor.utcMs,
        source: 'sse'
      };
    }
  }

  // 从公共时间服务器获取 UTC 时间（不请求我们服务器）
  function calibrateFromPublicTime() {
    // 首先检查是否有新的 SSE 锚点（最高优先级）
    pollSseAnchor();

    // 如果已有 SSE 锚点且不超过 10 分钟，跳过公共校准
    if (_timeAnchor && _timeAnchor.source === 'sse') {
      var age = performance.now() - _timeAnchor.perfNow;
      if (age < 600000) return; // SSE 锚点 < 10 分钟，够新鲜
    }

    // 主：Cloudflare trace（全球 CDN，含中国）→ 解析 ts=Unix秒
    fetch('https://www.cloudflare.com/cdn-cgi/trace', { cache: 'no-cache' })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var m = text.match(/^ts=([\d.]+)/m);
        if (m) {
          _timeAnchor = {
            perfNow: performance.now(),
            utcMs: parseFloat(m[1]) * 1000,
            source: 'cf'
          };
          return;
        }
        throw new Error('no ts');
      })
      .catch(function () {
        // 备：timeapi.io（JSON，CORS 友好）
        return fetch('https://timeapi.io/api/Time/current/zone?timeZone=UTC', { cache: 'no-cache' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.dateTime) {
              var dt = data.dateTime;
              if (!/[Zz+\-]\d{2}:\d{2}$/.test(dt) && !/[Zz]$/.test(dt)) dt += 'Z';
              _timeAnchor = {
                perfNow: performance.now(),
                utcMs: new Date(dt).getTime(),
                source: 'timeapi'
              };
            }
          });
      })
      .catch(function () { /* 两次都失败，沿用旧锚点 */ });
  }

  // 从单调锚点推算当前 UTC 毫秒
  function getCalibratedUtcMs() {
    if (_timeAnchor && _timeAnchor.perfNow && _timeAnchor.utcMs) {
      return _timeAnchor.utcMs + (performance.now() - _timeAnchor.perfNow);
    }
    return Date.now(); // 降级：未校准前用本地时间
  }

  if ($clk) {
    // 首次校准
    calibrateFromPublicTime();
    // 每 1 分钟重新校准
    setInterval(calibrateFromPublicTime, 60000);

    var tick = function () {
      pollSseAnchor(); // 每秒检查是否有新的 SSE 时间（最高优先级）
      var utcMs = getCalibratedUtcMs();
      var d = new Date(utcMs);
      $clk.textContent =
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
    };
    tick();
    setInterval(tick, 1000);
  }

  // ═══ 窄窗口退避 — 状态区恒一行，窗口变窄逐级隐藏非核心区块 ═══
  var $statusArea = document.querySelector('.qqq-status-area');
  function updateStatusDensity() {
    if (!$statusArea) return;
    var w = window.innerWidth;
    $statusArea.classList.toggle('qqq-dense-1', w < 1180); // 赞助商
    $statusArea.classList.toggle('qqq-dense-2', w < 1020); // 活动名（保留图标+进度条+数字）
    $statusArea.classList.toggle('qqq-dense-3', w < 900);  // wq + 版本
    $statusArea.classList.toggle('qqq-dense-4', w < 780);  // 在线 + 网关点
  }
  window.addEventListener('resize', updateStatusDensity);
  updateStatusDensity();
}
