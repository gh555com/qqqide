// ============================================================================
// q2-roam-boot.js — boot() async init: persistence load, keyhook, tooltips, paste
// Split from q2-roam.js (2026-08-04). Load order: q2-roam.js -> q2-roam-ui.js -> q2-roam-boot.js
// ============================================================================
'use strict';

// ---- Boot ----
(async function boot() {
	// ★ 首次启动: 从旧 per-green-pack 迁移到 OS 级 roam.sq3
	await _roamMigrateIfNeeded();


	// ═══ roam paste handler (M8) ═══
	// Intercepts Ctrl+V in roam, copies files to current directory.
	// ★ Key: preventDefault() must be synchronous (before first await) otherwise
	//    the browser's default paste fires before our async probe completes.
	var _pasteHandlerAttached = false;
	function _attachRoamPaste() {
		if (_pasteHandlerAttached) return;
		var target = document.body;
		if (!target) return;
		_pasteHandlerAttached = true;

		// Capture-phase paste: sync preventDefault, then async probe+copy
		target.addEventListener('paste', function(e) {
			if (!currentPath) return;

			var evtClip = e.clipboardData;
			var hasFileItem = false;
			if (evtClip && evtClip.items) {
				for (var i = 0; i < evtClip.items.length; i++) {
					if (evtClip.items[i].kind === 'file') { hasFileItem = true; break; }
				}
			}

			// ★ 如果正在编辑框内且没有文件项：让文本粘贴正常走，不做拦截
			var el = document.activeElement;
			var tag = el && el.tagName ? el.tagName.toUpperCase() : '';
			var editing = el && (el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA');
			if (editing && !hasFileItem) return;

			// ★ Sync block: prevent default immediately, then spawn async work
			e.preventDefault();
			e.stopPropagation();

			// ★ 2026-08-13: 统一走 CF_HDROP 完整路径（readFiles-first）——
			//   支持 文件夹+文件 混合复制（主进程 copyFile 目录感知递归复制），
			//   DOM File 无完整路径且读不了文件夹，仅作兜底。
			if (hasFileItem) {
				_pasteFilesFromEvent(evtClip);
				return;
			}

			// No DOM file items: async probe for CF_HDROP (PowerShell-spawned files from Explorer)
			_asyncProbeAndPaste();
		}, true);

		// ★ Also listen on window for when body doesn't have focus
		window.addEventListener('paste', function(e) {
			if (!currentPath) return;
			// Only handle if body handler didn't already catch it
			if (e.target && e.target !== document.body && !document.body.contains(e.target)) return;
		}, true);
	}

	async function _pasteFilesFromEvent(evtClip) {
		// ★ 2026-08-13: CF_HDROP 完整路径优先（支持文件夹递归复制 + 原生流式，统一引擎）。
		//   DOM File 读不了文件夹（readAsArrayBuffer 失败）且无完整路径 → 仅兜底纯文件场景。
		var paths = null;
		try { paths = await bridge.clipboard.readFiles(); } catch (err) { paths = null; }
		if (paths && paths.length > 0) {
			await _copyPathsToCurrentDir(paths);
			return;
		}

		// DOM File 兜底（无 CF_HDROP 场景：拖拽等）—— 仅文件
		var files = [];
		if (evtClip && evtClip.items) {
			for (var i = 0; i < evtClip.items.length; i++) {
				var it = evtClip.items[i];
				if (it.kind === 'file') {
					var f = it.getAsFile();
					if (f) files.push(f);
				}
			}
		}
		if (files.length === 0) return;
		await _copyFilesToCurrentDir(files);
	}

	async function _asyncProbeAndPaste() {
		var probe;
		try { probe = await bridge.clipboard.probe(); } catch(err) { return; }
		if (!probe || !probe.hasFile) return;

		var filePaths;
		try { filePaths = await bridge.clipboard.readFiles(); } catch(err) { return; }
		if (!filePaths || filePaths.length === 0) return;

		await _copyPathsToCurrentDir(filePaths);
	}

	// ★ 2026-08-24: q3 getUniquePath 语义——目标已存在（含同目录粘贴 src===dest）→ 追加 " (n)" 改名。
	//   防覆盖同名文件 + 防同目录粘贴 createReadStream+createWriteStream 同一路径截断源文件。
	async function _uniqueDestPath(dest) {
		try {
			var exists = await bridge.fs.exists(dest);
			if (!exists) return dest;
		} catch (e) { return dest; }
		var sep = dest.indexOf('\\') >= 0 ? '\\' : '/';
		var slash = dest.lastIndexOf(sep);
		var dir = slash >= 0 ? dest.slice(0, slash) : '';
		var name = slash >= 0 ? dest.slice(slash + 1) : dest;
		var dot = name.lastIndexOf('.');
		// .gitignore 等隐藏文件: extname 返回全名 → 特殊处理（q3 同款）
		var base, ext;
		if (dot > 0 && dot < name.length - 1) { base = name.slice(0, dot); ext = name.slice(dot); }
		else if (dot === 0) { base = name; ext = ''; }
		else { base = name; ext = ''; }
		for (var n = 1; n < 1000; n++) {
			var cand = (dir ? dir + sep : '') + base + ' (' + n + ')' + ext;
			try {
				var ok = await bridge.fs.exists(cand);
				if (!ok) return cand;
			} catch (e) { return cand; }
		}
		return dest;
	}

	// ★ 字节格式化（B/KB/MB/GB，q3 formatBytesCompact 对齐）
	function _fmtBytes(b) {
		if (b >= 1073741824) return (b / 1073741824).toFixed(1) + 'GB';
		if (b >= 1048576) return (b / 1048576).toFixed(1) + 'MB';
		if (b >= 1024) return Math.round(b / 1024) + 'KB';
		return b + 'B';
	}

	async function _copyPathsToCurrentDir(paths) {
		var tip = document.getElementById('addressPasteTip');
		if (tip) { tip.textContent = 'Pasting ' + paths.length + ' files...'; tip.classList.add('show'); }

		// ★ 2026-08-24: ioast 任务坞（独立于 qoast 的任务卡）——
		//   统一 streamId → 主进程聚合 4 路并发进度（copied/total 全任务字节）；
		//   取消按钮 → cancelCopy → 主进程中止所有该 streamId 复制 + 清理半成品。
		var ioast = (window.parent && window.parent.qqqideIoast) || null;
		var streamId = 'roam-paste-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
		var cancelled = false;
		var startTs = Date.now();
		var elapsedTimer = null;
		var successCount = 0;
		var failCount = 0;
		var cancelCount = 0;
		var lastSubtitle = '';
		var lastProgress = null;

		function _ioastPush(extra) {
			if (!ioast) return;
			var opts = {
				title: '粘贴 ' + paths.length + ' 项',
				count: { done: successCount + failCount + cancelCount, total: paths.length },
				elapsed: (Date.now() - startTs) / 1000
			};
			if (lastSubtitle) opts.subtitle = lastSubtitle;
			if (typeof lastProgress === 'number') opts.progress = lastProgress;
			if (extra) { for (var k in extra) opts[k] = extra[k]; }
			ioast.task(streamId, opts);
		}
		function _ioastStart() {
			if (!ioast) return;
			ioast.task(streamId, {
				title: '粘贴 ' + paths.length + ' 项',
				cancelable: true,
				onCancel: function() {
					cancelled = true;
					try { bridge.fs.cancelCopy(streamId); } catch(e) {}
					_ioastPush({ cancelable: false, subtitle: '正在取消…' });
				}
			});
			elapsedTimer = setInterval(_ioastPush, 500);
		}
		function _ioastFinish() {
			if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
			if (!ioast) return;
			if (cancelCount > 0) {
				ioast.fail(streamId, { summary: '已取消 · ' + successCount + ' 项完成' + (failCount > 0 ? '，' + failCount + ' 失败' : '') });
			} else if (failCount > 0) {
				ioast.fail(streamId, { summary: successCount + ' 项成功，' + failCount + ' 项失败' });
			} else {
				ioast.done(streamId, { summary: successCount + ' 项已复制' });
			}
		}

		_ioastStart();

		var sep = currentPath.indexOf('\\') >= 0 ? '\\' : '/';
		// ★ 2026-08-13: 并发复制（4 路）—— 多文件+文件夹混合一次粘贴不串行等待
		var CONC = 4, qi = 0;
		async function _pasteWorker() {
			while (true) {
				if (cancelled) return;
				var i = qi++;
				if (i >= paths.length) return;
				var src = paths[i];
				var name = src.replace(/\\/g, '/').split('/').pop();
				// ★ 2026-08-24: 唯一化/去重决策上移主进程 copyFile（单一真理）——
				//   不再预查 _uniqueDestPath：同内容已存在文件可零复制去重命中；
				//   不同内容自动 " (n)" 唯一化；返回值为最终落盘路径（去重/改名后仍正确）。
				var dest = currentPath + sep + name;
				try {
					// ★ 2026-08-24: 必须检查返回值——主进程 ENOENT 曾静默 return false，
					//   不检查即 "1 copied 假成功"（中文路径 GBK 乱码事故根因链）。
					// ★ 2026-08-24: 统一 streamId → 主进程聚合多路进度 + 支持取消。
					var ok = await bridge.fs.copyFile(src, dest, function(p) {
						if (!p) return;
						lastProgress = p.total > 0 ? Math.min(1, p.copied / p.total) : null;
						lastSubtitle = name + ' (' + _fmtBytes(p.copied) + '/' + _fmtBytes(p.total) + ')';
						if (tip) tip.textContent = 'Pasting ' + (successCount + failCount + cancelCount + 1) + '/' + paths.length + ': ' + lastSubtitle;
						_ioastPush();
					}, streamId);
					if (ok === false) throw new Error('copy returned false');
					// 去重命中/唯一化改名 → 最终路径可能与 dest 不同，用返回值刷新显示
					if (typeof ok === 'string' && ok !== dest) {
						var lname = ok.replace(/\\/g, '/').split('/').pop();
						if (lname) name = lname;
					}
					successCount++;
				} catch(err) {
					if (cancelled || (err && err.message && err.message.indexOf('cancelled') >= 0)) cancelCount++;
					else { failCount++; console.warn('[roam] paste copy failed:', src, err && err.message); }
				}
				lastSubtitle = name;
				lastProgress = null;
				if (tip) tip.textContent = 'Pasting ' + (successCount + failCount + cancelCount) + '/' + paths.length + ': ' + name;
				_ioastPush();
			}
		}
		await Promise.all(Array.from({ length: Math.min(CONC, paths.length || 1) }, function() { return _pasteWorker(); }));

		// ★ 2026-08-24: 事务终结——主进程 copy-tx 记录（半成品已由引擎清理；
		//   若进程此刻崩溃，pending 记录由下次启动 _txRecover 兜底精确清理）
		try { if (bridge.fs && bridge.fs.copyTxEnd) bridge.fs.copyTxEnd(streamId); } catch(e) {}

		loadFileList(currentPath);
		_ioastFinish();

		if (tip) {
			tip.textContent = successCount + ' copied' + (failCount > 0 ? ', ' + failCount + ' failed' : '') + (cancelCount > 0 ? ', ' + cancelCount + ' cancelled' : '');
			setTimeout(function() { tip.classList.remove('show'); }, 3000);
		}

		_playSfx('copy');
	}

	async function _copyFilesToCurrentDir(files) {
		var tip = document.getElementById('addressPasteTip');
		if (tip) { tip.textContent = 'Pasting ' + files.length + ' files...'; tip.classList.add('show'); }

		// ★ 2026-08-24: ioast 任务坞（DOM File 路径：无字节进度 → 文件级计数 + 取消）
		var ioast = (window.parent && window.parent.qqqideIoast) || null;
		var ioastId = 'roam-paste-dom-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
		var cancelled = false;

		if (ioast) {
			ioast.task(ioastId, {
				title: '粘贴 ' + files.length + ' 个文件',
				count: { done: 0, total: files.length },
				cancelable: true,
				onCancel: function() { cancelled = true; }
			});
		}

		var sep = currentPath.indexOf('\\') >= 0 ? '\\' : '/';
		var successCount = 0;
		var failCount = 0;

		for (var i = 0; i < files.length; i++) {
			if (cancelled) break;
			var f = files[i];
			var dest = await _uniqueDestPath(currentPath + sep + (f.name || ('paste_' + i)));
			try {
				// For DOM File objects, read as ArrayBuffer and write via bridge
				var ab = await new Promise(function(resolve, reject) {
					var reader = new FileReader();
					reader.onload = function() { resolve(reader.result); };
					reader.onerror = reject;
					reader.readAsArrayBuffer(f);
				});
				var bytes = new Uint8Array(ab);
				var bin = '';
				for (var j = 0; j < bytes.length; j += 0x8000) {
					bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
				}
				var b64 = btoa(bin);
				// ★ 2026-08-08 F106: 二进制必须走 writeBase64（主进程 base64 解码）。
				//   禁止降级到 fs.write —— base64 字符串会被当 UTF-8 文本写入 → 文件损坏。
				if (!bridge.fs.writeBase64) {
					console.error('[roam] paste: bridge.fs.writeBase64 missing — binary write would corrupt file, skipping', f.name);
					failCount++;
					continue;
				}
				await bridge.fs.writeBase64(dest, b64);
				successCount++;
				if (tip) tip.textContent = 'Pasting ' + (i + 1) + '/' + files.length + ': ' + f.name;
			} catch(err) {
				console.warn('[roam] paste file failed:', f.name, err);
				failCount++;
			}
			if (ioast) {
				ioast.task(ioastId, { count: { done: successCount + failCount, total: files.length }, subtitle: f.name || '' });
			}
		}

		loadFileList(currentPath);

		if (ioast) {
			if (cancelled) ioast.fail(ioastId, { summary: '已取消 · ' + successCount + ' 个完成' });
			else if (failCount > 0) ioast.fail(ioastId, { summary: successCount + ' 个成功，' + failCount + ' 个失败' });
			else ioast.done(ioastId, { summary: successCount + ' 个已复制' });
		}

		if (tip) {
			tip.textContent = successCount + ' copied' + (failCount > 0 ? ', ' + failCount + ' failed' : '');
			setTimeout(function() { tip.classList.remove('show'); }, 3000);
		}

		_playSfx('copy');
	}

	// ★ 读取持久化数据（OS 级 roam.sq3, 跨窗口唯一真理）
	var f = await _roamGet('roam.fineScm'); if (f && typeof f === 'object') _fineScm = f;
	var q = await _roamGet('roam.qqiq'); if (Array.isArray(q)) _qqiq = q;
	var p = await _roamGet('roam.pinnedDirs'); if (Array.isArray(p)) _pinnedDirs = p;
	var h = await _roamGet('roam.cmdHistory'); if (h && typeof h === 'object') _cmdHistory = h;
	var prefs = await _roamGet('roam.prefs');
	if (prefs && typeof prefs === 'object') {
		if (typeof prefs.lineSpacing === 'number') _lineSpacing = prefs.lineSpacing;
		if (prefs.globalSzMode) _globalSzMode = prefs.globalSzMode;
		if (prefs.globalSortBy) _globalSortBy = prefs.globalSortBy;
	}
	_applyLineSpacing();
	try {
		var sw = await _roamGet('roam.sidebarWidth');
		if (typeof sw === 'number' && sw > 50 && sw < 500) { sidebarW = sw; applySidebarWidth(); }
	} catch(e) {}

	var bootInfo = {};
	try { bootInfo = parent.qqqBootInfo || {}; } catch(e) {}
	if (!bootInfo.cwd) {
		try { bootInfo = await rpc('boot.getInfo'); } catch(e) {}
	}
	// Determine start directory
	var root = bootInfo.cwd || bootInfo.workingDir || '.';
	var lastDir = await _roamGet('roam.lastVisitedDir');
	if (lastDir && typeof lastDir === 'string') {
		try { await bridge.fs.list(lastDir); root = lastDir; } catch(e) {}
	}

	await loadDrives();
	renderQqiqSection();
	renderPinnedDirs();
	initQqFilter();
	navigateTo(root);
	updateSCMButtons();

	// ---- Initial responsive check ----
	checkAndApplyResponsive();

	// ---- KeyHook iframe adapter (unified roam shortcut routing) ----
	// ★ 修复：必须在 iframe 内部监听 keydown，而非父窗口 document。
	//   父窗口的 document.activeElement 是 <iframe>，永远不识别 iframe 内的 input。
	//   结果：Ctrl+V 等编辑操作被 swallow 吃掉，roam 一切编辑框无法粘贴。
	//   现在直接在 iframe 的 document 上捕获，editing 判断基于真实的 activeElement。
	(function() {
		var scope = 'iframe:roam';
		document.addEventListener('keydown', function(e) {
			// 构建加速器字符串（与 key-hook.js canonAccel 一致）
			var parts = [];
			if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
			if (e.shiftKey) parts.push('Shift');
			if (e.altKey) parts.push('Alt');
			var key = e.key;
			if (!key) return;
			if (key.length === 1) { key = key.toUpperCase(); }
			else if (key === ' ') { key = 'Space'; }
			if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return;
			parts.push(key);
			var accel = parts.join('+');

			// 转发给父窗口 key-hook dispatching（处理 Q/W/Space/1/2 等快捷键）
			try { parent.postMessage({ type: 'qqq-key', accel: accel, scope: scope }, '*'); } catch(_) {}

		// ★ 仅当不在编辑框内时吞掉事件，防止快捷键触发默认行为
		//   但是：Ctrl/Meta 组合键绝不吞——它们是标准剪贴板操作（Ctrl+C/V/X/A/Z 等）
		var el = document.activeElement;
		var tag = el && el.tagName ? el.tagName.toUpperCase() : '';
		var editing = el && (el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA');
		var isModKey = e.ctrlKey || e.metaKey;
		// ★ 仅 preventDefault 防浏览器默认行为（Space 滚屏/Backspace 回退），
		//   绝不 stopPropagation——roam 内部键盘处理器在 bubble 阶段，必须收到事件
		if (!editing && !isModKey) { e.preventDefault(); }
		}, true);
	})();

	// ---- Listen for parent → iframe cmd dispatch ----
	window.addEventListener('message', function(e) {
		if (!e.data || e.data.type !== 'qqq-roam-cmd') return;
		var cmd = e.data.cmd;
		// Best-effort: dispatch as window event so feature handlers below can react.
		// path 透传（roam.revealFile 定位用）
		document.dispatchEvent(new CustomEvent('qqq-roam-cmd', { detail: { cmd: cmd, path: e.data.path } }));
	});

	// ★ zoom 单位换算（2026-08-09）：html { zoom:0.85 } 下 innerWidth/clientX 报物理 px，而 fixed 定位/maxWidth/offsetWidth 用 CSS px（F113 实测 Electron22: zoom 生效但 clientX=物理注入值、innerWidth 不变）→ 物理/CSS 必须统一，否则右边界保护失效 + maxWidth 退避错 17.6%
	function _ttZoom() {
		var z = 1;
		try { var cz = getComputedStyle(document.documentElement).zoom; if (cz && cz !== '' && cz !== '1') z = parseFloat(cz) || 1; } catch (e) {}
		return z;
	}

	// ---- 全局自定义 tooltip（从 q3 百分百移植）----
	(function bootGlobalTooltip() {
		var gt = document.getElementById('globalTooltip');
		if (!gt) return;
		var _currentTarget = null;

		// mouseenter → 显示 tooltip（data-tooltip）
				document.addEventListener('mouseenter', function(e) {
			var t = e.target;
			if (!t || !t.closest) return;
			var target = t.closest('[data-tooltip]');
			if (!target) return;   // ★ q3 语义：未命中不隐藏（mouseleave 负责隐藏），防按钮间隙移动闪烁
			_currentTarget = target;
			var text = target.getAttribute('data-tooltip');
			if (!text) { gt.style.display = 'none'; return; }

			var pageW = window.innerWidth / _ttZoom();   // ★ CSS px（zoom 下 innerWidth 报物理值）
			gt.style.whiteSpace = 'pre-wrap';
			gt.style.maxWidth = (pageW - 20) + 'px';

			if (target.getAttribute('data-use-html') === 'true') {
				gt.innerHTML = text;
			} else {
				gt.textContent = text;
			}
			gt.style.display = 'block';
		}, true);

		// mousemove → 定位 + 边缘回避
		document.addEventListener('mousemove', function(e) {
			if (gt.style.display !== 'block' || !_currentTarget) return;

			var pageW = window.innerWidth / _ttZoom();   // ★ CSS px 统一（边界保护/maxWidth 与 fixed 定位同单位）
			var vh = window.innerHeight / _ttZoom();
			var padL = 10, padR = 0;
			gt.style.whiteSpace = 'pre-wrap';
			gt.style.maxWidth = (pageW - padL - padR) + 'px';

			// ★ 判断是左侧按钮（scm S/C/M）还是右侧按钮
			var isLeftBtn = _currentTarget.classList.contains('scm-btn') && _currentTarget.closest('#szModeGroup');
			var isOpenBtn = _currentTarget.classList.contains('open-btn');
			var isRightBtn = _currentTarget.classList.contains('save-button') || _currentTarget.classList.contains('cancel-button')
				|| (_currentTarget.classList.contains('scm-btn') && _currentTarget.closest('#sortByGroup'));

// 垂直定位：save/cancel 向上偏移
		var gp = _zoomFix(e.clientX, e.clientY); var gx = gp.left, gy = gp.top;
		if (_currentTarget.classList.contains('save-button') || _currentTarget.classList.contains('cancel-button')) {
			gt.style.top = (gy - 44) + 'px';
		} else {
			gt.style.top = (gy + 22) + 'px';
		}

		var tw = gt.offsetWidth;
		var leftPos;
		if (isLeftBtn || isOpenBtn) {
			leftPos = gx - 11;
		} else if (isRightBtn) {
			leftPos = gx - tw + 11;
		} else {
			// ★ qq item / recent item / 通用元素：居中，然后做边界保护
			leftPos = gx - tw / 2;
		}

			// 边界保护
			if (leftPos + tw > pageW - padR) leftPos = pageW - tw - padR;
			if (leftPos < padL) leftPos = padL;

			gt.style.left = leftPos + 'px';
		}, true);

		// mouseleave → 隐藏
		document.addEventListener('mouseleave', function(e) {
			var t = e.target;
			if (!t || !t.closest) return;
			var target = t.closest('[data-tooltip]');
			if (target) {
				_currentTarget = null;
				gt.style.display = 'none';
			}
		}, true);
	})();

	// ---- path-tooltip（白底黑字，文件夹/盘符/最近项超长截断时使用）----
	var _ptEl = null, _ptVisible = false, _lastPathTooltipTs = 0;
	function _ensurePathTooltip() {
		if (_ptEl) return;
		_ptEl = document.getElementById('pathTooltip');
		if (!_ptEl) { _ptEl = document.createElement('div'); _ptEl.className = 'path-tooltip'; _ptEl.style.display = 'none'; document.body.appendChild(_ptEl); }
	}
	function hidePathTooltip() { if (_ptEl) _ptEl.style.display = 'none'; _ptVisible = false; }
	function _isEllipsis(el) { return el && el.scrollWidth > el.clientWidth + 1; } // 2026-08-05 去慢路径(Range+getComputedStyle强制layout)
	function showPathTooltip(text, cx, cy) {
		if (!text) { hidePathTooltip(); return; }
		var tp = _zoomFix(cx, cy); cx = tp.left; cy = tp.top;
		_ensurePathTooltip();
		_ptEl.textContent = text;
		var margin = 8, vw = window.innerWidth / _ttZoom(), vh = window.innerHeight / _ttZoom();   // ★ CSS px 统一（同 globalTooltip）
		_ptEl.style.whiteSpace = 'nowrap'; _ptEl.style.maxWidth = 'none'; _ptEl.style.display = 'block'; _ptVisible = true;
		var nw = _ptEl.scrollWidth, maxW = vw - 20;
		if (nw > maxW) {
			_ptEl.style.whiteSpace = 'pre-wrap'; _ptEl.style.wordBreak = 'break-all'; _ptEl.style.maxWidth = maxW + 'px';
			var l = Math.max(4, Math.min(cx - maxW / 2, vw - maxW - 4));
			_ptEl.style.left = l + 'px';
		} else {
			var okL = (cx + margin + nw) <= vw - 4, okR = (cx - margin - nw) >= 4;
			_ptEl.style.whiteSpace = 'nowrap'; _ptEl.style.maxWidth = 'none'; _ptEl.style.wordBreak = '';
			_ptEl.style.left = (okL ? cx + margin : okR ? cx - margin - nw : Math.max(4, (vw - nw) / 2)) + 'px';
		}
		_ptEl.style.top = (cy + margin) + 'px';
		var rect = _ptEl.getBoundingClientRect();
		if (rect.bottom > vh - 4) _ptEl.style.top = Math.max(4, vh - rect.height - 4) + 'px';
	}
	function handlePathTooltipHover(e) {
		var _now = Date.now(); if (_now - _lastPathTooltipTs < 50) return; _lastPathTooltipTs = _now; // 50ms throttle
		var t = e.target; if (!t || !t.closest) return;
		// 盘符按钮
		var ni = t.closest('.nav-item');
		if (ni) { _isEllipsis(ni) ? showPathTooltip(ni.textContent.trim(), e.clientX, e.clientY) : hidePathTooltip(); return; }
		// qq 文件夹
		var qi = t.closest('.qq-item');
		if (qi) {
			if (qi.classList.contains('qq-file')) { hidePathTooltip(); return; }
			var qtx = qi.querySelector('.qq-text');
			var tip = qi.getAttribute('data-fullpath') || (qtx ? qtx.textContent : qi.textContent || '').trim();
			_isEllipsis(qtx || qi) ? showPathTooltip(tip, e.clientX, e.clientY) : hidePathTooltip();
			return;
		}
		// 最近项
		var ri = t.closest('.recent-item');
		if (ri) {
			var rsp = ri.querySelector('span:not(.delete-button):not(.pin-move-btn)');
			_isEllipsis(rsp || ri) ? showPathTooltip(rsp ? rsp.textContent.trim() : ri.textContent.trim(), e.clientX, e.clientY) : hidePathTooltip();
			return;
		}
		// ★ 主资源列表区（q3 Area 4 补漏 2026-08-16）：文件/文件夹名被省略号截断 → 显示完整路径
		var fi = t.closest('.file-item');
		if (fi) {
			var nameArea = fi.querySelector('.folder-name-area, .file-name-area');
			if (nameArea && _isEllipsis(nameArea)) {
				showPathTooltip(fi.getAttribute('data-path') || fi.getAttribute('data-name') || '', e.clientX, e.clientY);
			} else if (_ptVisible) { hidePathTooltip(); }
			return;
		}
		hidePathTooltip();
	}
	var _sideEl = document.querySelector('.sidebar');
	if (_sideEl) { _sideEl.addEventListener('mousemove', handlePathTooltipHover); _sideEl.addEventListener('mouseleave', hidePathTooltip); }
	var _kyEl = document.getElementById('kyContent');
	if (_kyEl) { _kyEl.addEventListener('mousemove', handlePathTooltipHover); _kyEl.addEventListener('mouseleave', hidePathTooltip); }


	// Attach paste handler on load
	_attachRoamPaste();

	// ★ 拖放复制入口暴露（2026-08-24）: q2-roam.js document 级 drop 使用。
	//   旧实现 fl 级 drop 直接引用本 IIFE 内函数 → ReferenceError，拖放复制从未生效。
	window.qqqRoamCopyPaths = _copyPathsToCurrentDir;
	window.qqqRoamCopyFiles = _copyFilesToCurrentDir;

})();
