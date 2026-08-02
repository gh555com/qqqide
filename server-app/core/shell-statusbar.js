// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-statusbar.js — 状态栏时钟 + 免费时段指示器（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window._i, window._sseTimeAnchor (AI 面板推送)
// ============================================================================

function bootStatusbar(boot) {
  var bridge = window.qqqideBridge;
  var $ver = document.getElementById('qqq-status-version');
  var $onl = document.getElementById('qqq-status-online');
  var $eng = document.getElementById('qqq-status-engine');
  var $clk = document.getElementById('qqq-status-clock');
  var $freeInd = document.getElementById('qqq-status-free');
  var $freeBadge = document.getElementById('qqq-status-free-badge');
  if ($ver) $ver.textContent = 'v' + (boot.version || '?');
  if ($eng) $eng.textContent = 'engine: ' + (boot.engineAlive ? 'on' : 'off');
	if ($onl) $onl.textContent = '0';

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
	(function () {
		if (!$onl) return;
		$onl.style.cursor = 'pointer';
		$onl.title = '点击查看在线用户';

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
				html += '<th style="padding:4px 6px;text-align:right;">最近在线</th>';
				html += '<th style="padding:4px 6px;text-align:right;">连续(m)</th>';
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
					html += '<tr style="border-bottom:1px solid ' + (isDark ? '#2a2a2a' : '#eee8d5') + ';">';
					html += '<td style="padding:4px 6px;font-family:monospace;">' + u.phone + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + daysReg + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + geStr + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;font-size:12px;white-space:nowrap;">' + timeStr + '</td>';
					html += '<td style="padding:4px 6px;text-align:right;font-family:monospace;">' + contStr + '</td>';
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

		fetchOnline();
		setInterval(fetchOnline, 300000);
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

  // 判断是否在免费时段
  function isFreeWindow(utcMs) {
    var d = new Date(utcMs);
    var day = d.getUTCDay();
    if (day === 0) return true; // 周日全天
    var h = d.getUTCHours();
    return (h >= 1 && h < 3) || (h >= 13 && h < 15);
  }

  // 下次免费开始/结束时间（UTC ms）
  function nextFreeBoundary(utcMs) {
    var d = new Date(utcMs);
    var day = d.getUTCDay();
    var h = d.getUTCHours();
    if (isFreeWindow(utcMs)) {
      if (day === 0) { d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); }
      if (h >= 1 && h < 3) { d.setUTCHours(3, 0, 0, 0); return d.getTime(); }
      d.setUTCHours(15, 0, 0, 0); return d.getTime();
    }
    if (h < 1) { d.setUTCHours(1, 0, 0, 0); return d.getTime(); }
    if (h < 13) { d.setUTCHours(13, 0, 0, 0); return d.getTime(); }
    d.setUTCHours(1, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); return d.getTime();
  }

  function fmtHMS(ms) {
    if (ms <= 0) return '00:00:00';
    var s = Math.ceil(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function updateFreeIndicator() {
    if (!$freeInd || !$freeBadge) return;
    var utcMs = getCalibratedUtcMs();
    var free = isFreeWindow(utcMs);
    var boundary = nextFreeBoundary(utcMs);
    var remaining = boundary - utcMs;
    var t = window._i || function (k, d) { return d; };

    if (free) {
      $freeInd.style.display = 'inline-flex';
      if (remaining < 300000) {
        $freeBadge.textContent = t('shell.free.ending', '🎈免费将结束') + ' ' + fmtHMS(remaining);
        $freeBadge.className = 'qqq-free-badge qqq-free-ending';
      } else {
        $freeBadge.textContent = t('shell.free.active', '💎 免费中') + ' ' + fmtHMS(remaining);
        $freeBadge.className = 'qqq-free-badge qqq-free-on';
      }
    } else if (remaining > 0 && remaining < 43200000) {
      $freeInd.style.display = 'inline-flex';
      $freeBadge.textContent = t('shell.free.soonPrefix', '🤍距离下次免费') + ' ' + fmtHMS(remaining);
      $freeBadge.className = 'qqq-free-badge qqq-free-soon';
    } else {
      $freeInd.style.display = 'none';
    }
  }

  // ═══ 免费预算血条 ═══
  var $freeBudgetBar = document.getElementById('qqq-status-free-budget');
  var $freeBudgetFill = document.getElementById('qqq-status-free-budget-fill');
  var $freeBudgetLabel = document.getElementById('qqq-status-free-budget-label');
  var _freeBudgetData = null;
  var _freeBudgetLastFetch = 0;

  function fetchFreeBudget() {
    var token = '';
    try {
      if (window.qqqLogin && window.qqqLogin.getAuthToken) {
        token = window.qqqLogin.getAuthToken();
      }
    } catch (e) { /* ignore */ }
    if (!token) return;

    var now = Date.now();
    if (now - _freeBudgetLastFetch < 30000) return; // 30s 冷却
    _freeBudgetLastFetch = now;

    fetch('https://direct-cn.gh555.com/api/qqq/free-budget', {
      headers: { 'Authorization': 'Bearer ' + token }
    })
      .then(function (r) { if (!r.ok) return null; return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          _freeBudgetData = data;
          updateFreeBudgetUI();
        }
      })
      .catch(function () { /* ignore */ });
  }

  function updateFreeBudgetUI() {
    if (!$freeBudgetBar) return;
    var d = _freeBudgetData;
    if (d && d.in_free_window && parseFloat(d.remaining_ge) >= 0) {
      $freeBudgetBar.style.display = 'inline-flex';
      var budgetGe = parseFloat(d.budget_ge) || 0;
      var remainingGe = parseFloat(d.remaining_ge) || 0;
      if (budgetGe > 0) {
        var remainingPct = remainingGe / budgetGe * 100;
        if ($freeBudgetFill) $freeBudgetFill.style.width = Math.max(remainingPct, 1) + '%';
      }
      if ($freeBudgetLabel) {
        var lbl = '💎' + remainingGe.toFixed(1) + '/' + budgetGe.toFixed(1);
        if (d.season_bonus > 0) lbl += '(+' + parseFloat(d.season_bonus).toFixed(1) + ')';
        $freeBudgetLabel.textContent = lbl;
      }
    } else {
      $freeBudgetBar.style.display = 'none';
    }
  }

  if ($clk) {
    // 首次校准
    calibrateFromPublicTime();
    // 每 1 分钟重新校准
    setInterval(calibrateFromPublicTime, 60000);
    // 免费预算每 30s 拉一次
    setInterval(fetchFreeBudget, 30000);
    fetchFreeBudget();

    var tick = function () {
      pollSseAnchor(); // 每秒检查是否有新的 SSE 时间（最高优先级）
      var utcMs = getCalibratedUtcMs();
      var d = new Date(utcMs);
      $clk.textContent =
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
      updateFreeIndicator();
    };
    tick();
    setInterval(tick, 1000);
  }
}
