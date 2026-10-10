// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// shell-statusbar.js — 状态栏时钟 + 免费时段指示器（从 shell.js 拆分）
// 依赖: window.qqqideBridge, window._i, window._sseTimeAnchor (AI 面板推送)
// ============================================================================function bootStatusbar(boot) {
  var bridge = window.qqqideBridge;

  // i18n 助手：翻译 + 中文回退 + {x} 参数（i18n 未就绪/缺失时回退原样）
  function _T(k, fb, p) {
    var v = null;
    try { if (window.i18n && window.i18n.t) { var r = window.i18n.t(k, p); if (r && r !== k) v = r; } } catch (e) { }
    if (v === null) { v = fb; if (p) { for (var x in p) v = v.split('{' + x + '}').join(String(p[x])); } }
    return v;
  }
  var $ver = document.getElementById('qqq-status-version');
  var $onl = document.getElementById('qqq-status-online');
  var $clk = document.getElementById('qqq-status-clock');
  if ($ver) $ver.textContent = 'v' + (boot.version || '?');
	if ($onl) $onl.textContent = '0';
		// ═══ 赞助商轮换（状态栏左下角）— 大20s/中10s/小5s，瞬间替换文字（无滚动动画，防视觉分散）═══
	// 数据源: GET /api/sponsor/current（三档位当前小时胜出者；无人竞拍 → 默认成都知佳）
	// ★ 2026-10-02 请求治理：拉取限频 10 分钟（数据每整点才轮换，60s→10min；"成功才计门"——
	//   失败重试仍 1 分钟级不受阻碍）；失败保持默认品牌；点击打开当前品牌超链接
	// ★ 版本分流（2026-09-08）：请求带 ?app_ver=本地版本 → 服务端对 ≥eol_min 的客户端返回正常广告轮播；
	//   无版本参数（旧客户端代码）一律被服务端视为 EOL → 恒显官方升级公告。
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

		var _lastOkAt = 0; // 上次成功拉取时间（失败不计门 → 失败重试仍 1 分钟级，成功刷新 ≥10 分钟）
		function fetchCurrent() {
			var now = Date.now();
			if (now - _lastOkAt < 600000) return Promise.resolve(); // ★ 成功限频 10 分钟（数据整点才换）
			var _verQ = (boot && boot.version && boot.version !== '?') ? ('?app_ver=' + encodeURIComponent(String(boot.version).replace(/^v/i, ''))) : '';
			return fetch('https://direct-cn.gh555.com/api/sponsor/current' + _verQ, { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (d) {
					if (d && d.ok && d.items && d.items.length) {
						items = d.items;
						idx = -1;
						_lastOkAt = Date.now(); // 仅成功计门
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
				}, 60000); // 无数据（失败/首拉）→ 60s 重试（成功才计门，失败重试不受 10min 限频阻碍）
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
		var _onlDailyHist = null;  // 最近一次每日均值快照（服务端 avg_daily ≤201 行；旧服务端回退 avg_daily_30；弹窗 30d/180d 曲线数据，零重复请求）
		var _onlRange = '30';      // 曲线回看窗口档位：'30'=近30天(31点) / '180'=近180天(181点≈半年，2026-09-08 新增)
		var _onlSparkSvg = null;   // 微型曲线 <svg>（懒创建一次复用，仅弹窗可见时渲染）
		var _onlShowBal = false;   // ★ 隐藏功能：弹窗开启时连按 3 下 q → day 右侧显示「余额」列（服务端 balance_ge 四舍五入取整）
		var _onlQCount = 0;        // 连按计数（超时/弹窗关闭清零）
		var _onlQAt = 0;
		// ★ 定宽列配比（2026-10-05 用户定案；勿随手改）：table-layout:fixed 由 <colgroup> 百分比驱动——
		//   任何语言列宽恒一致、永不横向滚动条。值 = 同引擎实测：13 语言最坏列头/数据 + 5px 滚动条在场余量；
		//   10 列 = 含余额列（三连 q 展开）/ 9 列 = 余额隐藏。改值必须重跑实测（列内文本恒不得裁切）。
		var _ONL_COLS10 = [13.4, 5.0, 7.8, 11.6, 10.7, 15.2, 10.1, 10.7, 8.8, 6.7];
		var _ONL_COLS9 = [14.5, 5.4, 12.6, 11.6, 16.5, 11.0, 11.6, 9.5, 7.3];

		function fetchOnline(force) {
			if (!force && document.hidden) return; // ★ 2026-10-02: 隐藏窗零请求（回前台 visibilitychange 补拉）
			var now = Date.now();
			if (!force && now - _onlLastFetch < 240000) return;
			_onlLastFetch = now;
			fetch('https://direct-cn.gh555.com/api/qqqide/online-total', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (data) {
					if (!data || !data.ok) return;
					if (typeof data.total === 'number') {
						var _ot = data.total > 0 ? data.total.toLocaleString() : '0';
						if ($onl.textContent !== _ot) $onl.textContent = _ot; // ★ 值同零写（2026-10-02 审计）
					}
					// ★ 弹窗首行：当前人数（与左下角同值）+ ※最近24小时平均
					var $now = document.getElementById('qqq-onl-now');
					if ($now && $onl) $now.textContent = $onl.textContent || '0';
					var $avg = document.getElementById('qqq-onl-avg24');
					if ($avg) {
						var pts = data.sample_points || 0;
						if (pts > 0 && typeof data.avg_24h === 'number') {
							// 值来自服务端 number（avg_24h 经 Math.round 纯数字），innerHTML 无注入面；_fmt1 强制一位小数（整数也显 .0）
							$avg.innerHTML = _T('shell.onl.avg24', '※最近24小时平均：') + '<b>' + _fmt1(data.avg_24h) + '</b>';
							$avg.title = pts >= 288 ? '' : _T('shell.onl.sampling', '数据采样中（{p}/288 点，满 24 小时后精确）', { p: pts });
						} else {
							$avg.textContent = _T('shell.onl.avg24', '※最近24小时平均：') + '--';
							$avg.title = _T('shell.onl.samplingShort', '数据采集中');
						}
					}
					// ★ 每日均值曲线数据（服务端 avg_daily 全量 ≤201 行；旧服务端回退 avg_daily_30。
					//   尾点 == 当前24h平均同值；弹窗开着才绘制，30d/180d 档位切片在 _renderSpark 内）
					var _daily = Array.isArray(data.avg_daily) ? data.avg_daily
						: (Array.isArray(data.avg_daily_30) ? data.avg_daily_30 : null);
					if (_daily && _daily.length) {
						_onlDailyHist = _daily;
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
				'<span class="qqq-onl-title">' + _T('shell.onl.title', '在线人数') + ' <b id="qqq-onl-now">0</b></span>' +
				'<span class="qqq-onl-avg" id="qqq-onl-avg24">' + _T('shell.onl.avg24', '※最近24小时平均：') + '--</span>' +
				'</div>' +
				'<span class="qqq-onl-spark" id="qqq-onl-spark">' +
				'<span class="qqq-onl-zoom" id="qqq-onl-zoom">' +
				'<button type="button" data-r="30">30d</button>' +
				'<button type="button" data-r="180">180d</button>' +
				'</span>' +
				'</span>' +
				'<span class="qqq-onl-scale" id="qqq-onl-scale"></span>' +
				'</div>' +
				'<div id="qqq-onl-body" class="qqq-onl-body"></div>';
			_onlOverlay.appendChild(_onlPanel);
			document.body.appendChild(_onlOverlay);

			// ★ 30d/180d 档位（2026-09-08）：图表左上角微型按钮点按切换回看窗口（重渲染零请求；弹窗内点击不关闭；档位会话内保持）
			var $zoom = document.getElementById('qqq-onl-zoom');
			if ($zoom) {
				$zoom.addEventListener('click', function (e) {
					var b = e.target && e.target.closest ? e.target.closest('button') : null;
					if (!b) return;
					var r = b.getAttribute('data-r');
					if (r && r !== _onlRange) {
						_onlRange = r;
						_syncZoomBtns();
						_renderSpark();
					}
				});
			}
			_syncZoomBtns();
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

		// ★ 档位按钮激活态同步（2026-09-08）：当前档位实心高亮，另一档描边暗显
		function _syncZoomBtns() {
			var $zoom = document.getElementById('qqq-onl-zoom');
			if (!$zoom) return;
			var btns = $zoom.querySelectorAll('button');
			for (var i = 0; i < btns.length; i++) {
				btns[i].className = btns[i].getAttribute('data-r') === _onlRange ? 'on' : '';
			}
		}

		function _renderSpark() {
			if (!_onlUsersOpen || !_onlOverlay || _onlOverlay.style.display === 'none') return;
			var $spark = document.getElementById('qqq-onl-spark');
			var $scale = document.getElementById('qqq-onl-scale');
			if (!$spark || !_onlDailyHist || _onlDailyHist.length < 2) { // <2 点 = 数据积累中（首点 5min 内出现）
				if ($scale) $scale.innerHTML = '';
				return;
			}
			// ★ 档位回看窗口（2026-09-08）：30d=尾部31点（今天+30天）/ 180d=尾部181点（今天+180天 ≈ 半年）
			var maxN = _onlRange === '180' ? 181 : 31;
			var daily = _onlDailyHist.length > maxN ? _onlDailyHist.slice(_onlDailyHist.length - maxN) : _onlDailyHist;
			var rangeName = _onlRange === '180' ? _T('shell.onl.range180', '近180天') : _T('shell.onl.range30', '近30天');
			var n = daily.length;
			var ns = 'http://www.w3.org/2000/svg';
			if (!_onlSparkSvg) {
				_onlSparkSvg = document.createElementNS(ns, 'svg');
				$spark.appendChild(_onlSparkSvg);
			}
			var w = $spark.clientWidth || 240;
			var h = $spark.clientHeight || 30;
			var pad = 2;
			var iw = w - pad * 2, ih = h - pad * 2;
			var min = daily[0].v, max = daily[0].v;
			for (var i = 1; i < n; i++) {
				var vi = daily[i].v;
				if (vi < min) min = vi;
				if (vi > max) max = vi;
			}
			var rawMax = max, rawMin = min; // 刻度显示真实极值（曲线满幅映射时极值恰好贴上下边）
			if (max - min < 1e-6) { max += 0.5; min -= 0.5; } // 全平数据守卫（防除零）
			var span = max - min;
			var pts = [];
			for (var j = 0; j < n; j++) {
				var x = Math.round((pad + j * iw / (n - 1)) * 10) / 10;
				var y = Math.round((pad + ih - ((daily[j].v - min) / span) * ih) * 10) / 10;
				pts.push(x + ',' + y);
			}
			var lastY = Math.round((pad + ih - ((daily[n - 1].v - min) / span) * ih) * 10) / 10;
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
				$scale.title = _T('shell.onl.scaleTip', '顶峰 {max} · 谷底 {min}（{r}日均在线）', { max: _fmt1(rawMax), min: _fmt1(rawMin), r: rangeName });
			}
			$spark.title = _T('shell.onl.sparkTip', '{r}日均在线曲线（{a} → {b}，尾点 = 当前24h平均；点 30d/180d 切换回看窗口）', { r: rangeName, a: daily[0].d, b: daily[n - 1].d });
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

		// ★ 语言切换：面板销毁重建（建一次永久缓存的面板禁烧字——与状态区内存卡同规；开着则原态恢复）
		try { window.addEventListener('qqq-lang-change', function () {
			try {
				if (!_onlOverlay) { return; }
				var _wasOpen = !!_onlUsersOpen;
				try { if (_onlOverlay.parentNode) { _onlOverlay.parentNode.removeChild(_onlOverlay); } } catch (_) { }
				_onlOverlay = null; _onlPanel = null; _onlSparkSvg = null; _onlUsersOpen = false;
				if (!_wasOpen) { return; }
				buildOnlineUsersPanel();
				_onlUsersOpen = true;
				_onlOverlay.style.display = '';
				if (_onlUsersCache && _onlUsersCache.length) { renderOnlineUsers(_onlUsersCache); }   // 缓存数据重放（零额外请求）
				_renderSpark();
				fetchOnline(true);   // 首行人数/24h平均按新语言回填
			} catch (_) { }
		}); } catch (_) { }

		function renderOnlineUsers(users) {
			_onlUsersCache = users;
			var $body = document.getElementById('qqq-onl-body');
			if (!$body) return;
			// ★ 统计在线人数，同步更新左下角（比 online-total 缓存更实时）
			var onlineCount = 0;
			for (var j = 0; j < users.length; j++) { if (users[j].online) onlineCount++; }
			if ($onl) {
				var _oc = onlineCount > 0 ? onlineCount.toLocaleString() : '0';
				if ($onl.textContent !== _oc) $onl.textContent = _oc; // ★ 值同零写（2026-10-02 审计）
			}
			// 弹窗首行当前人数与左下角恒同值（同源更新，防两数字打架）
			var $now = document.getElementById('qqq-onl-now');
			if ($now && $onl) $now.textContent = $onl.textContent || '0';
			var balTh = _onlShowBal ? '<th class="r">' + _T('shell.onl.thBalance', '余额') + '</th>' : '';
			// ★ 定宽列（禁改）：colgroup 百分比 → 列宽与语言/内容无关（配比唯一源 = _ONL_COLS*，样式契约在 shell-base.css）
			var _cw = _onlShowBal ? _ONL_COLS10 : _ONL_COLS9;
			var colHtml = '<colgroup>';
			for (var ci = 0; ci < _cw.length; ci++) colHtml += '<col style="width:' + _cw[ci] + '%">';
			colHtml += '</colgroup>';
			var html = '<table class="qqq-onl-table">' + colHtml + '<thead><tr>' +
				'<th>' + _T('shell.onl.thPhone', '手机号') + '</th><th class="r">' + _T('shell.onl.thDay', 'day') + '</th>' + balTh + '<th class="r">' + _T('shell.onl.thCost', '消耗') + '</th><th class="r">' + _T('shell.onl.thIndepCost', '独立消耗') + '</th>' +
				'<th class="r">' + _T('shell.onl.thLastSeen', '最近在线') + '</th><th class="r">' + _T('shell.onl.thCont', '连续(m)') + '</th><th class="r">' + _T('shell.onl.thIndep', '独立') + '</th><th class="r">' + _T('shell.onl.thVer', '版本') + '</th><th class="r">' + _T('shell.onl.thTotal', '累计(h)') + '</th>' +
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
				// 独立列括号 = 本次独立距上次最后在线的小时数（服务端 independent_gap_h 四舍五入取整；0/缺省不显示括号）
				var indGapTxt = (typeof u.independent_gap_h === 'number' && u.independent_gap_h > 0) ? '(' + u.independent_gap_h + ')' : '';
				var balCell = _onlShowBal ? '<td class="r mono">' + (typeof u.balance_ge === 'number' ? u.balance_ge : '-') + '</td>' : '';
				html += '<tr>' +
					'<td class="mono">' + u.phone + '</td>' +
					'<td class="r mono">' + daysReg + '</td>' +
					balCell +
					'<td class="r mono">' + geStr + '</td>' +
					'<td class="r mono">' + indGeStr + '</td>' +
					'<td class="r mono sm">' + timeStr + '</td>' +
					'<td class="r mono">' + contStr + '</td>' +
					'<td class="r mono">' + (typeof u.independent === 'number' ? u.independent : '-') + indGapTxt + '</td>' +
					'<td class="r mono xs">' + ver + '</td>' +
					'<td class="r mono">' + totalStr + '</td>' +
					'</tr>';
			}
			html += '</tbody></table>';
			$body.innerHTML = html;
		}

		// ★ 隐藏功能（2026-09-06）：弹窗开启时连按 3 下 q（单次间隔 ≤1.2s）→ day 右侧显示「余额」列，再按三下隐藏
		//   弹窗关闭/焦点在下层键入区/长按 repeat 均忽略；列切换用最近快照重渲染，零重复请求
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
			if ($body) $body.innerHTML = '<div class="qqq-onl-msg">' + _T('shell.onl.loading', '加载中...') + '</div>';

			fetch('https://direct-cn.gh555.com/api/qqqide/online-users', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (data) {
					_onlFetching = false;
					if (!data || !data.ok || !$body) return;
					var users = data.users || [];
					if (users.length === 0) {
						$body.innerHTML = '<div class="qqq-onl-msg">' + _T('shell.onl.empty', '暂无用户') + '</div>';
						return;
					}
					renderOnlineUsers(users);
				})
				.catch(function () {
					_onlFetching = false;
					var $body = document.getElementById('qqq-onl-body');
					if ($body) $body.innerHTML = '<div class="qqq-onl-msg">' + _T('shell.onl.loadFail', '加载失败，请重试') + '</div>';
				});
		}

		$onl.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openOnlineUsers(); });

		// ═══ 启动包监控 a 区域渲染 — 唯一渲染者 = core/shell-mem-hover.js（icon+内存+CPU 文字全量接管，2026-08-30）═══
		// 2026-08-30 修复：此处曾用 $mem.textContent 整体覆盖 → 图标与 CPU 文字被清空只剩裸数字（用户实锤），双写已删

		// ═══ 总在线时间（累计陪伴小时）— 纯展示，hover 零外观零 tooltip ═══
		// 数据源: /api/qqqide/online-users 当前用户行 total_m（分钟，服务端 companion_seconds 权威累计）
		// 口径: Math.round(total_m/60)+'h' 与在线面板「累计(h)」完全一致；客户端零记录，直接打印服务器值
		var $tot = document.getElementById('qqq-status-total');
		// ★ 值同零写（2026-10-02 审计）：减少文本节点替换 → 状态区实测退避零多余触发
		function _setTot(txt) { if ($tot && $tot.textContent !== txt) $tot.textContent = txt; }

		// 与服务端 maskPhone 同款（phone[:5] + **** + 后4位）
		function maskPhoneLikeServer(p) {
			if (!p || p.length < 9) return p;
			return p.slice(0, 5) + '****' + p.slice(p.length - 4);
		}

		// ★ 节流（2026-10-01）：auth 状态广播（余额/LV 每 60s 刷新）会高频重入本函数——
		//   该接口为重量级聚合查询，多窗口级联会把服务端放大成 PG 洪峰（事故根因，实测 24.6s/次查询）。
		//   未显式 force 时 4 分钟内只发一次请求（登录态切换等场景由 5 分钟轮询兜底）。
		//   注意门序：先算 target（未登录只刷 '--' 不占门），再过节流门——否则登录瞬间的首拉会被吃掉。
		var _myTotalLastFetch = 0;
		function fetchMyTotal(force) {
			if (!$tot) return;
			var target = '';
			try { if (window.qqqLogin) target = window.qqqLogin.getPhone() || ''; } catch (e) { }
			target = maskPhoneLikeServer(target);
			if (!target) { _setTot('--'); return; }
			if (!force && document.hidden) return; // ★ 2026-10-02: 隐藏窗零请求（回前台 visibilitychange 补拉）
			var _mtNow = Date.now();
			if (!force && _mtNow - _myTotalLastFetch < 240000) return;
			_myTotalLastFetch = _mtNow;
			fetch('https://direct-cn.gh555.com/api/qqqide/online-users', { cache: 'no-cache' })
				.then(function (r) { if (!r.ok) return null; return r.json(); })
				.then(function (data) {
					if (!data || !data.ok || !data.users || !data.users.length) return;
					for (var i = 0; i < data.users.length; i++) {
						if (data.users[i].phone === target && typeof data.users[i].total_m === 'number') {
							_setTot(Math.round(data.users[i].total_m / 60) + 'h');
							return;
						}
					}
					_setTot('--');
				})
				.catch(function () { /* 静默 */ });
		}
		// 登录状态变化 → 刷新（登录/登出都走这里）；★ 包装吞掉回调参数（onStateChange 会传 loggedIn/phoneTail 等实参——
		// 直接挂 fetchMyTotal 会把 loggedIn 当作 force=true 绕过节流门，2026-10-01 自审修复）
		try { if (window.qqqLogin && window.qqqLogin.onStateChange) window.qqqLogin.onStateChange(function () { fetchMyTotal(); }); } catch (e) { }

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
		// ★ 2026-10-02 请求治理：两轮询合一（同 5 分钟节拍）+ 隐藏窗零请求 —— 回前台经 visibilitychange
		//   立即补拉（两函数各自 4 分钟门防抖）；多窗口后台驻留不再把重量级在线接口放大成服务端洪峰
		setInterval(function () {
			if (document.hidden) return;
			fetchOnline();
			fetchMyTotal();
		}, 300000);
		document.addEventListener('visibilitychange', function () {
			if (document.hidden) return;
			fetchOnline();
			fetchMyTotal();
		});
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
    // ★ 2026-10-02 请求治理：任何来源新鲜锚点（<10 分钟）→ 跳过公共校准
    //   （旧实现只认 'sse' 源 → 无 SSE 时每分钟重拉一次 cloudflare trace；单调钟漂移可忽略）
    if (_timeAnchor && _timeAnchor.perfNow) {
      var age = performance.now() - _timeAnchor.perfNow;
      if (age < 600000) return; // 锚点 < 10 分钟，够新鲜
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

  // ═══ 窄窗口退避（实测级联 v2 · 2026-10-02：4 级 → 8 级 + 增量重算，稳态零 DOM 写）═══════════
  // 旧固定宽度阈值只对中文宽度成立（fr 1100px 超界 377px 实锤）→ 改「实测内容宽 vs 可用宽」逐级隐藏。
  // 级序: 1 赞助商 → 2 活动名 → 3 wq+陪伴+内存 → 4 在线 → 5 vibe → 6 原料 → 7 眼睛 → 8 清爽；
  // 版本号+通知点永驻（通知中心永远可达）；时钟/缩放徽章天然豁免；再窄 = 应用物理下限（兜底裁切）。
  // ★ 性能（q397 审计）：旧实现每次触发「全移除→逐级重加」= 5~9 次强制回流，且被时钟/vibe
  //   每秒文本 tick 打一次；v2 增量重算——稳态只做 1 次实测零 DOM 写；释放试放由「受阻水位」
  //   门控（余量增长 >4px 才再试），文本 tick 不再产生 class 抖动。诊断 = window.qqqStatusFit.stats()
  var $statusArea = document.querySelector('.qqq-status-area');
  var STATUS_DENSE_LEVELS = ['qqq-dense-1', 'qqq-dense-2', 'qqq-dense-3', 'qqq-dense-4', 'qqq-dense-5', 'qqq-dense-6', 'qqq-dense-7', 'qqq-dense-8'];
  var _sdLvl = 0;           // 当前密度级（增量重算锚）
  var _sdBlockSlack = -1;   // 释放受阻水位（上次试放失败时的余量；-1 = 无阻碍）
  var _sdRaf = null;
  function _sdRow() { return $statusArea ? $statusArea.querySelector('.qqq-status-row') : null; }
  function _statusRowFits() {
    var row = _sdRow();
    if (!row) return true;
    var lim = row.getBoundingClientRect().right - (parseFloat(getComputedStyle(row).paddingRight) || 0);
    var kids = row.children, maxRight = -Infinity;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (r.width > 0 && r.right > maxRight) maxRight = r.right;
    }
    return maxRight <= lim + 0.5;
  }
  function _sdSlack() {
    var row = _sdRow();
    if (!row) return 0;
    var s = row.clientWidth - row.scrollWidth; // 整数口径，仅作释放门控
    return s > 0 ? s : 0;
  }
  function _sdApply() {
    if (!$statusArea) return;
    for (var i = 0; i < STATUS_DENSE_LEVELS.length; i++) {
      $statusArea.classList.toggle(STATUS_DENSE_LEVELS[i], i < _sdLvl);
    }
  }
  function updateStatusDensity() {
    if (!$statusArea) return;
    var fits = _statusRowFits();
    if (fits) {
      if (_sdLvl === 0) return; // 稳态：仅 1 次实测，零 DOM 写
      var sl = _sdSlack();
      if (_sdBlockSlack >= 0 && sl <= _sdBlockSlack + 4) return; // 余量未涨 → 不试放（防抖）
      while (_sdLvl > 0) {
        _sdLvl--; _sdApply();
        if (!_statusRowFits()) { _sdLvl++; _sdApply(); _sdBlockSlack = _sdSlack(); return; }
      }
      _sdBlockSlack = -1; // 全释放
    } else {
      while (_sdLvl < STATUS_DENSE_LEVELS.length) {
        _sdLvl++; _sdApply();
        if (_statusRowFits()) break;
      }
      _sdBlockSlack = _sdSlack(); // 刚装下 → 试放必失败，先钉水位（防下次 tick 空试放）
    }
  }
  function _scheduleStatusDensity() {
    if (_sdRaf) return;
    _sdRaf = requestAnimationFrame(function () { _sdRaf = null; updateStatusDensity(); });
  }
  window.addEventListener('resize', _scheduleStatusDensity);
  updateStatusDensity();
  // 文本动态变化（i18n 切换 / 活动名换字 / 版本号到位）后重算 —— 防首次判定后长译挤出裁切
  window.addEventListener('qqq-lang-change', function () { setTimeout(updateStatusDensity, 60); });
  (function () {
    var row = _sdRow();
    if (!row || typeof MutationObserver === 'undefined') return;
    var t = null;
    new MutationObserver(function () {
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; updateStatusDensity(); }, 400);
    }).observe(row, { subtree: true, childList: true, characterData: true });
  })();
  try {
    window.qqqStatusFit = {
      refresh: _scheduleStatusDensity,
      stats: function () { return { lvl: _sdLvl, blockSlack: _sdBlockSlack, fits: _statusRowFits() }; }
    };
  } catch (e) { }
  // ═══ 窄窗口退避（实测级联 v2）END ═══
}
