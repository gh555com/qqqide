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
		var _onlUsersCache = null; // 最近一次 users 快照（三连 q 切列重渲染用，零重复请求）
		var _onlDaily30 = null;    // 最近一次 avg_daily_30 快照（近30天每日均值，弹窗微型曲线数据，零重复请求）
		var _onlSparkSvg = null;   // 微型曲线 <svg>（懒创建一次复用，仅弹窗可见时渲染）
		var _onlShowBal = false;   // ★ 隐藏功能：弹窗开启时连按 3 下 q → day 右侧显示「余额」列（服务端 balance_ge 四舍五入取整）
		var _onlQCount = 0;        // 连按计数（超时/弹窗关闭清零）
		var _onlQAt = 0;

		function fetchOnline(force) {
			var now = Date.now();
			if (!force && now - _onlLastFetch < 240000) return;
			_onlLastFetch = now;
			fetch('https://direct-cn.gh555.com/api/qqqide/online-total', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (data) {
					if (!data || !data.ok) return;
					if (typeof data.total === 'number') {
						$onl.textContent = data.total > 0 ? data.total.toLocaleString() : '0';
					}
					// ★ 弹窗首行：当前人数（与左下角同值）+ ※最近24小时平均
					var $now = document.getElementById('qqq-onl-now');
					if ($now && $onl) $now.textContent = $onl.textContent || '0';
					var $avg = document.getElementById('qqq-onl-avg24');
					if ($avg) {
						var pts = data.sample_points || 0;
						if (pts > 0 && typeof data.avg_24h === 'number') {
							// 值来自服务端 number（avg_24h 经 Math.round 纯数字），innerHTML 无注入面；_fmt1 强制一位小数（整数也显 .0）
							$avg.innerHTML = '※最近24小时平均：<b>' + _fmt1(data.avg_24h) + '</b>';
							$avg.title = pts >= 288 ? '' : '数据采样中（' + pts + '/288 点，满 24 小时后精确）';
						} else {
							$avg.textContent = '※最近24小时平均：--';
							$avg.title = '数据采集中';
						}
					}
					// ★ 近30天日均曲线数据（服务端 avg_daily_30，尾点 == 当前24h平均同值，弹窗开着才绘制）
					if (Array.isArray(data.avg_daily_30) && data.avg_daily_30.length) {
						_onlDaily30 = data.avg_daily_30;
						_renderSpark();
					}
				})
				.catch(function () { /* 静默 */ });
		}

		// ═══ 点击弹出在线用户列表 ═══
		// ★ 配色 2026-09-03 修复：样式全收敛 .qqq-onl-* CSS 类 + 主题语义变量（唯一入口 qqqide-theme.js）。
		//   旧实现 inline 硬编码色仅面板首次构建时读一次 data-theme——面板构建后跨主题切换（浅→暗）恒残留浅底，
		//   叠加暗主题继承的浅色文字 → 白底浅字根本看不清楚（实锤）。CSS 变量随 [data-theme] 即时切换，
		//   面板复用/开合/换主题零残留，无需任何 JS 重刷。
		function buildOnlineUsersPanel() {
			_onlOverlay = document.createElement('div');
			_onlOverlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);z-index:9998;';
			_onlOverlay.addEventListener('click', function (e) { if (e.target === _onlOverlay) closeOnlineUsers(); });

			_onlPanel = document.createElement('div');
			_onlPanel.className = 'qqq-onl-panel';
			_onlPanel.innerHTML =
				'<div class="qqq-onl-head">' +
				'<div class="qqq-onl-lines">' +
				'<span class="qqq-onl-title">在线人数 <b id="qqq-onl-now">0</b></span>' +
				'<span class="qqq-onl-avg" id="qqq-onl-avg24">※最近24小时平均：--</span>' +
				'</div>' +
				'<span class="qqq-onl-spark" id="qqq-onl-spark"></span>' +
				'<span class="qqq-onl-scale" id="qqq-onl-scale"></span>' +
				'</div>' +
				'<div id="qqq-onl-body" class="qqq-onl-body"></div>';
			_onlOverlay.appendChild(_onlPanel);
			document.body.appendChild(_onlOverlay);
		}

		function closeOnlineUsers() {
			_onlUsersOpen = false;
			if (_onlOverlay) _onlOverlay.style.display = 'none';
		}

		// ★ 微型 30 天日均曲线（2026-09-06）——首行均值左移后，右侧细长区画近30天每日均值变迁；
		//   尾点 = 今天行 = 当前 24h 滚动平均 → 与首行数字恒同值（服务端同一 refresh 周期写入同一值）。
		//   零定时器零动画：数据刷新（fetchOnline then）/ 弹窗打开 / 窗口缩放 三路重绘；SVG 懒创建复用。
		// ★ 一位小数格式化（峰/谷刻度 + 24h 平均同口径；整数也显 .0，2026-09-07 一切数字一位小数定案）
		function _fmt1(x) {
			return (Math.round(x * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
		}

		function _renderSpark() {
			if (!_onlUsersOpen || !_onlOverlay || _onlOverlay.style.display === 'none') return;
			var $spark = document.getElementById('qqq-onl-spark');
			var $scale = document.getElementById('qqq-onl-scale');
			if (!$spark || !_onlDaily30 || _onlDaily30.length < 2) { // <2 点 = 数据积累中（首点 5min 内出现）
				if ($scale) $scale.innerHTML = '';
				return;
			}
			var n = _onlDaily30.length;
			var ns = 'http://www.w3.org/2000/svg';
			if (!_onlSparkSvg) {
				_onlSparkSvg = document.createElementNS(ns, 'svg');
				$spark.appendChild(_onlSparkSvg);
			}
			var w = $spark.clientWidth || 240;
			var h = $spark.clientHeight || 30;
			var pad = 2;
			var iw = w - pad * 2, ih = h - pad * 2;
			var min = _onlDaily30[0].v, max = _onlDaily30[0].v;
			for (var i = 1; i < n; i++) {
				var vi = _onlDaily30[i].v;
				if (vi < min) min = vi;
				if (vi > max) max = vi;
			}
			var rawMax = max, rawMin = min; // 刻度显示真实极值（曲线满幅映射时极值恰好贴上下边）
			if (max - min < 1e-6) { max += 0.5; min -= 0.5; } // 全平数据守卫（防除零）
			var span = max - min;
			var pts = [];
			for (var j = 0; j < n; j++) {
				var x = Math.round((pad + j * iw / (n - 1)) * 10) / 10;
				var y = Math.round((pad + ih - ((_onlDaily30[j].v - min) / span) * ih) * 10) / 10;
				pts.push(x + ',' + y);
			}
			var lastY = Math.round((pad + ih - ((_onlDaily30[n - 1].v - min) / span) * ih) * 10) / 10;
			_onlSparkSvg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
			// 面积底 + 折线 + 尾点（全主题语义变量 → 随 [data-theme] 即时切换零残留）
			_onlSparkSvg.innerHTML =
				'<polygon points="' + pad + ',' + (pad + ih) + ' ' + pts.join(' ') + ' ' + (pad + iw) + ',' + (pad + ih) + '" fill="var(--text-dim)" fill-opacity="0.12"/>' +
				'<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--text-primary)" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>' +
				'<circle cx="' + (pad + iw) + '" cy="' + lastY + '" r="1.8" fill="var(--text-primary)"/>';
			// ★ 峰/谷刻度（2026-09-07）：图表右侧竖排两数字 = 数据极大/极小值，一位小数
			if ($scale) {
				$scale.innerHTML =
					'<i class="pk">' + _fmt1(rawMax) + '</i>' +
					'<i>' + _fmt1(rawMin) + '</i>';
				$scale.title = '顶峰 ' + _fmt1(rawMax) + ' · 谷底 ' + _fmt1(rawMin) + '（近30天日均在线）';
			}
			$spark.title = '近30天日均在线曲线（' + _onlDaily30[0].d + ' → ' + _onlDaily30[n - 1].d + '，尾点 = 当前24h平均）';
		}

		function openOnlineUsers() {
			if (!_onlOverlay) buildOnlineUsersPanel();
			if (_onlUsersOpen) { closeOnlineUsers(); return; }
			_onlUsersOpen = true;
			_onlOverlay.style.display = '';
			_renderSpark(); // 先画缓存曲线（开箱即见），随后 fetchOnline 刷新重绘
			fetchOnline(true); // 弹窗打开即拉最新（绕过 240s 轮询限频，面板首行人数+24h平均立即刷新）
			fetchOnlineUsers();
		}

		function renderOnlineUsers(users) {
			_onlUsersCache = users;
			var $body = document.getElementById('qqq-onl-body');
			if (!$body) return;
			// ★ 统计在线人数，同步更新左下角（比 online-total 缓存更实时）
			var onlineCount = 0;
			for (var j = 0; j < users.length; j++) { if (users[j].online) onlineCount++; }
			if ($onl) $onl.textContent = onlineCount > 0 ? onlineCount.toLocaleString() : '0';
			// 弹窗首行当前人数与左下角恒同值（同源更新，防两数字打架）
			var $now = document.getElementById('qqq-onl-now');
			if ($now && $onl) $now.textContent = $onl.textContent || '0';
			var balTh = _onlShowBal ? '<th class="r">余额</th>' : '';
			var html = '<table class="qqq-onl-table"><thead><tr>' +
				'<th>手机号</th><th class="r">day</th>' + balTh + '<th class="r">消耗</th><th class="r">独立消耗</th>' +
				'<th class="r">最近在线</th><th class="r">连续(m)</th><th class="r">独立</th><th class="r">版本</th><th class="r">累计(h)</th>' +
				'</tr></thead><tbody>';
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
				var balCell = _onlShowBal ? '<td class="r mono">' + (typeof u.balance_ge === 'number' ? u.balance_ge : '-') + '</td>' : '';
				html += '<tr>' +
					'<td class="mono">' + u.phone + '</td>' +
					'<td class="r mono">' + daysReg + '</td>' +
					balCell +
					'<td class="r mono">' + geStr + '</td>' +
					'<td class="r mono">' + indGeStr + '</td>' +
					'<td class="r mono sm">' + timeStr + '</td>' +
					'<td class="r mono">' + contStr + '</td>' +
					'<td class="r mono">' + (typeof u.independent === 'number' ? u.independent : '-') + '</td>' +
					'<td class="r mono xs">' + ver + '</td>' +
					'<td class="r mono">' + totalStr + '</td>' +
					'</tr>';
			}
			html += '</tbody></table>';
			$body.innerHTML = html;
		}

		// ★ 隐藏功能（2026-09-06）：弹窗开启时连按 3 下 q（单次间隔 ≤1.2s）→ day 右侧显示「余额」列，再按三下隐藏
		//   弹窗关闭/焦点在下层输入区/长按 repeat 均忽略；列切换用最近快照重渲染，零重复请求
		// 窗口缩放 → 面板宽度变化（max-width 94vw）→ 曲线按新宽度重绘（_renderSpark 内已判弹窗可见性，零额外成本）
		window.addEventListener('resize', _renderSpark);

		document.addEventListener('keydown', function (e) {
			if (!_onlUsersOpen || !_onlOverlay || _onlOverlay.style.display === 'none') { _onlQCount = 0; return; }
			if (e.repeat) return;
			var k = e.key;
			// ★ ✕ 关闭按钮已删（2026-09-07 用户定案：点外面即关闭），Esc 兜底同效
			if (k === 'Escape') { _onlQCount = 0; closeOnlineUsers(); return; }
			if (k !== 'q' && k !== 'Q') return;
			var ae = document.activeElement;
			if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) { _onlQCount = 0; return; }
			var now = Date.now();
			if (now - _onlQAt > 1200) _onlQCount = 0;
			_onlQAt = now;
			_onlQCount++;
			if (_onlQCount >= 3) {
				_onlQCount = 0;
				_onlShowBal = !_onlShowBal;
				if (_onlUsersCache && _onlUsersCache.length) renderOnlineUsers(_onlUsersCache);
			}
		});

		function fetchOnlineUsers() {
			if (_onlFetching) return;
			_onlFetching = true;
			var $body = document.getElementById('qqq-onl-body');
			if ($body) $body.innerHTML = '<div class="qqq-onl-msg">加载中...</div>';

			fetch('https://direct-cn.gh555.com/api/qqqide/online-users', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (data) {
					_onlFetching = false;
					if (!data || !data.ok || !$body) return;
					var users = data.users || [];
					if (users.length === 0) {
						$body.innerHTML = '<div class="qqq-onl-msg">暂无用户</div>';
						return;
					}
					renderOnlineUsers(users);
				})
				.catch(function () {
					_onlFetching = false;
					var $body = document.getElementById('qqq-onl-body');
					if ($body) $body.innerHTML = '<div class="qqq-onl-msg">加载失败，请重试</div>';
				});
		}

		$onl.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openOnlineUsers(); });

		// ═══ 启动包监控 a 区域渲染 — 唯一渲染者 = core/shell-mem-hover.js（icon+内存+CPU 文字全量接管，2026-08-30）═══
		// 2026-08-30 修复：此处曾用 $mem.textContent 整体覆盖 → 图标与 CPU 文字被清空只剩裸数字（用户实锤），双写已删

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
