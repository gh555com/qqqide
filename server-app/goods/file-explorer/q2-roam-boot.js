// ============================================================================
// q2-roam-boot.js — boot() async init: persistence load, keyhook, tooltips, paste
// Split from q2-roam.js (2026-08-04). Load order: q2-roam.js -> q2-roam-ui.js -> q2-roam-boot.js
// ============================================================================
'use strict';

// ---- Boot ----
(async function boot() {
	// ★ 首次启动: 从旧 per-green-pack 迁移到 OS 级 roam.sq3
	await _roamMigrateIfNeeded();


	// ═══ Roam Paste Handler (M8) ═══
	// Intercepts Ctrl+V in Roam, copies files to current directory.
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

			// Fast path: DOM clipboardData already shows file items → skip async probe
			if (hasFileItem) {
				_pasteFilesFromEvent(evtClip);
				return;
			}

			// Slow path: async probe for CF_HDROP (PowerShell-spawned files from Explorer)
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

	async function _copyPathsToCurrentDir(paths) {
		var tip = document.getElementById('addressPasteTip');
		if (tip) { tip.textContent = 'Pasting ' + paths.length + ' files...'; tip.classList.add('show'); }

		var sep = currentPath.indexOf('\\') >= 0 ? '\\' : '/';
		var successCount = 0;
		var failCount = 0;

		for (var i = 0; i < paths.length; i++) {
			var src = paths[i];
			var name = src.replace(/\\/g, '/').split('/').pop();
			var dest = currentPath + sep + name;
			try {
				await bridge.fs.copyFile(src, dest);
				successCount++;
				if (tip) tip.textContent = 'Pasting ' + (i + 1) + '/' + paths.length + ': ' + name;
			} catch(err) {
				failCount++;
			}
		}

		loadFileList(currentPath);

		if (tip) {
			tip.textContent = successCount + ' copied' + (failCount > 0 ? ', ' + failCount + ' failed' : '');
			setTimeout(function() { tip.classList.remove('show'); }, 3000);
		}

		_playSfx('copy');
	}

	async function _copyFilesToCurrentDir(files) {
		var tip = document.getElementById('addressPasteTip');
		if (tip) { tip.textContent = 'Pasting ' + files.length + ' files...'; tip.classList.add('show'); }

		var sep = currentPath.indexOf('\\') >= 0 ? '\\' : '/';
		var successCount = 0;
		var failCount = 0;

		for (var i = 0; i < files.length; i++) {
			var f = files[i];
			var dest = currentPath + sep + (f.name || ('paste_' + i));
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
				if (bridge.fs.writeBase64) {
					await bridge.fs.writeBase64(dest, b64);
				} else {
					await bridge.fs.write(dest, b64);
				}
				successCount++;
				if (tip) tip.textContent = 'Pasting ' + (i + 1) + '/' + files.length + ': ' + f.name;
			} catch(err) {
				console.warn('[roam] paste file failed:', f.name, err);
				failCount++;
			}
		}

		loadFileList(currentPath);

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
	var sc = await _roamGet('roam.sizeCache');
	if (sc && typeof sc === 'object') sessionSizeCache = sc;
	var prefs = await _roamGet('roam.prefs');
	if (prefs && typeof prefs === 'object') {
		if (typeof prefs.lineSpacing === 'number') _lineSpacing = prefs.lineSpacing;
		if (prefs.globalSzMode) _globalSzMode = prefs.globalSzMode;
		if (prefs.globalSortBy) _globalSortBy = prefs.globalSortBy;
	}
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

	// ---- KeyHook iframe adapter (unified Roam shortcut routing) ----
	// ★ 修复：必须在 iframe 内部监听 keydown，而非父窗口 document。
	//   父窗口的 document.activeElement 是 <iframe>，永远不识别 iframe 内的 input。
	//   结果：Ctrl+V 等编辑操作被 swallow 吃掉，Roam 一切编辑框无法粘贴。
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
		//   绝不 stopPropagation——Roam 内部键盘处理器在 bubble 阶段，必须收到事件
		if (!editing && !isModKey) { e.preventDefault(); }
		}, true);
	})();

	// ---- Listen for parent → iframe cmd dispatch ----
	window.addEventListener('message', function(e) {
		if (!e.data || e.data.type !== 'qqq-roam-cmd') return;
		var cmd = e.data.cmd;
		// Best-effort: dispatch as window event so feature handlers below can react.
		document.dispatchEvent(new CustomEvent('qqq-roam-cmd', { detail: { cmd: cmd } }));
	});

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
			if (!target) { _currentTarget = null; gt.style.display = 'none'; return; }
			_currentTarget = target;
			var text = target.getAttribute('data-tooltip');
			if (!text) { gt.style.display = 'none'; return; }

			var pageW = window.innerWidth;
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

			var pageW = window.innerWidth;
			var vh = window.innerHeight;
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
	var _ptEl = null, _ptVisible = false;
	function _ensurePathTooltip() {
		if (_ptEl) return;
		_ptEl = document.getElementById('pathTooltip');
		if (!_ptEl) { _ptEl = document.createElement('div'); _ptEl.className = 'path-tooltip'; _ptEl.style.display = 'none'; document.body.appendChild(_ptEl); }
	}
	function hidePathTooltip() { if (_ptEl) _ptEl.style.display = 'none'; _ptVisible = false; }
	function _isEllipsis(el) {
		if (!el) return false;
		if (el.scrollWidth > el.clientWidth + 1) return true;
		try {
			var r = document.createRange(); r.selectNodeContents(el);
			var cs = getComputedStyle(el);
			return r.getBoundingClientRect().width > el.clientWidth - parseFloat(cs.paddingLeft||0) - parseFloat(cs.paddingRight||0) + 1;
		} catch(_) { return false; }
	}
	function showPathTooltip(text, cx, cy) {
		if (!text) { hidePathTooltip(); return; }
		var tp = _zoomFix(cx, cy); cx = tp.left; cy = tp.top;
		_ensurePathTooltip();
		_ptEl.textContent = text;
		var margin = 8, vw = window.innerWidth, vh = window.innerHeight;
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
		hidePathTooltip();
	}
	var _sideEl = document.querySelector('.sidebar');
	if (_sideEl) { _sideEl.addEventListener('mousemove', handlePathTooltipHover); _sideEl.addEventListener('mouseleave', hidePathTooltip); }
	var _kyEl = document.getElementById('kyContent');
	if (_kyEl) { _kyEl.addEventListener('mousemove', handlePathTooltipHover); _kyEl.addEventListener('mouseleave', hidePathTooltip); }


	// Attach paste handler on load
	_attachRoamPaste();

})();
