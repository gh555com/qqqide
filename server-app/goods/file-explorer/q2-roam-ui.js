// ============================================================================
// q2-roam-ui.js — UI bindings, custom scrollbar, keyboard, create file/folder
// Split from q2-roam.js (2026-08-04). Load order: q2-roam.js -> q2-roam-ui.js -> q2-roam-boot.js
// ============================================================================
'use strict';

ctxMenu.querySelectorAll('.context-menu-item').forEach(function(el) {
	el.addEventListener('click', function() {
		var action = el.dataset.action;
		hideAllContextMenus();
		if (!ctxTarget) return;
		if (selectedItems.length > 1 && action !== 'copyPath' && action !== 'delete') {
			// Multi-select: only copyPath and delete work; others use first item
		}
		var item = ctxEntry ? { path: ctxTarget, name: ctxEntry.name, type: ctxEntry.isDir ? 'folder' : 'file' } : { path: ctxTarget, name: baseName(ctxTarget), type: 'file' };
		if (item.name === '..' && (action === 'rename' || action === 'delete' || action === 'ai')) return;
		switch (action) {
			case 'ai': _feedCurrentToAi(); break;
			case 'code': performCodeAction(item); break;
			case 'open': performOpenAction(item); break;
			case 'delete': performDeleteAction(item); break;
			case 'rename': performEditAction(item); break;
			case 'copyPath': performCopyPathAction(); break;
		}
	});
});

// ---- SCM buttons: toggle (re-click = cancel = default) ----
function updateSCMButtons() {
	document.querySelectorAll('#szModeGroup .scm-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.mode === szMode); });
	document.querySelectorAll('#sortByGroup .scm-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.sort === sortBy); });
	document.getElementById('filesOnTopBtn').classList.toggle('active', filesOnTop);
}
document.querySelectorAll('#szModeGroup .scm-btn').forEach(function(btn) {
	btn.addEventListener('click', function() {
		var m = btn.dataset.mode;
		szMode = (szMode === m) ? 'nothing' : m;
		updateSCMButtons();
		fineScmSet(currentPath, szMode === 'nothing' ? null : szMode, sortBy === 'name' ? null : sortBy, filesOnTop);
		if (currentPath) reloadCurrentDir();
	});
});
document.querySelectorAll('#sortByGroup .scm-btn').forEach(function(btn) {
	btn.addEventListener('click', function() {
		var s = btn.dataset.sort;
		sortBy = (sortBy === s) ? 'name' : s;
		updateSCMButtons();
		fineScmSet(currentPath, szMode === 'nothing' ? null : szMode, sortBy === 'name' ? null : sortBy, filesOnTop);
		if (currentPath) reloadCurrentDir();
	});
});
document.getElementById('filesOnTopBtn').addEventListener('click', function() {
	filesOnTop = !filesOnTop;
	updateSCMButtons();
	fineScmSet(currentPath, szMode === 'nothing' ? null : szMode, sortBy === 'name' ? null : sortBy, filesOnTop);
	if (currentPath) reloadCurrentDir();
});

// ---- Filter ----
var filterInput = document.getElementById('fileFilterInput');
filterInput.addEventListener('input', function() {
	var val = filterInput.value.toLowerCase();
	var items = document.querySelectorAll('#fileList .file-item');
	items.forEach(function(item) {
		var name = (item.dataset.name || '').toLowerCase();
		item.style.display = (!val || name.includes(val)) ? '' : 'none';
	});
});
filterInput.addEventListener('keydown', function(e) {
	if (e.key === 'Enter') {
		var v = filterInput.value.trim();
		if (v) {
			if (!_cmdHistory.fileFilter) _cmdHistory.fileFilter = [];
			var arr = _cmdHistory.fileFilter.filter(function(x) { return x !== v; });
			arr.unshift(v);
			if (arr.length > 20) arr.length = 20;
			_cmdHistory.fileFilter = arr;
			_cmdHistorySave();
		}
		filterInput.blur();
	}
});

// ---- Sidebar drives ----
var _driveList = [];
var _drivePollingTimer = null;

async function loadDrives() {
	var driveList = document.getElementById('driveList');
	driveList.innerHTML = '';
	try {
		_driveList = await rpc('fs.drives');
	} catch(e) {
		_driveList = [];
	}
	if (_driveList.length === 0) _driveList = ['C:\\'];

	// Create drive buttons
	for (var i = 0; i < _driveList.length; i++) {
		(function(d) {
			var letter = d.charAt(0);
			var btn = document.createElement('button');
			btn.className = 'nav-item';
			btn.id = 'drive-' + letter + '-btn';
			btn.textContent = letter + ':\\ ';
			btn.addEventListener('click', function() { navigateTo(d); });
			driveList.appendChild(btn);
		})(_driveList[i]);
	}

	// Desktop entry
	var deskBtn = document.createElement('button');
	deskBtn.className = 'nav-item';
	deskBtn.id = 'drive-DESKTOP-btn';
	deskBtn.textContent = 'Desktop';
	deskBtn.addEventListener('click', function() {
		rpc('boot.getInfo').then(function(info) {
			var home = (info && info.homedir) || 'C:\\Users\\Default';
			navigateTo(home + '\\Desktop');
		}).catch(function() {});
	});
	driveList.appendChild(deskBtn);

	// Recycle Bin entry (点击 → 打开系统回收站，与 q3 openRecycleBin 一致)
	var recycleBtn = document.createElement('button');
	recycleBtn.className = 'nav-item';
	recycleBtn.id = 'drive-RECYCLE-btn';
	recycleBtn.textContent = 'Recycle Bin';
	recycleBtn.addEventListener('click', function() {
		bridge.shell.openRecycleBin().catch(function(){});
	});
	driveList.appendChild(recycleBtn);

	// Fetch disk free info
	// (a) 立即触发一次（rpc forwarder 修了后立刻生效；200ms 让 iframe 先挂载完）
	setTimeout(updateDriveDisplay, 200);
	// (b) 30s 轮询
	if (_drivePollingTimer) clearInterval(_drivePollingTimer);
	_drivePollingTimer = setInterval(updateDriveDisplay, 30000);
}

async function updateDriveDisplay() {
	// ★ 仅可见时轮询（对齐 q3 isDiskFreePollingAllowed）
	if (document.visibilityState !== 'visible') return;
	try {
		var info = await rpc('fs.diskFree', _driveList);
		for (var i = 0; i < _driveList.length; i++) {
			var letter = _driveList[i].charAt(0);
			var btn = document.getElementById('drive-' + letter + '-btn');
			if (!btn) continue;
			var data = info[letter];
			if (!data) { btn.textContent = letter + ':\  '; continue; }
			var freeBytes = data.free || 0;
			var totalBytes = data.total || 0;
			var freeGB = freeBytes / (1024*1024*1024);
			// ★ 红色预警: <1% 或 <2GB（对齐 q3 DISK_FREE_WARNING）
			var isLow = (totalBytes > 0 && freeBytes / totalBytes < 0.01) || (freeBytes < 2147483648);
			// ★ q3 原版: 正常整数, 红色才显示两位小数, 无 'GB' 后缀, 两个空格
			var gbText = isLow ? freeGB.toFixed(2) : Math.floor(freeGB).toString();
			btn.textContent = letter + ':\  ' + gbText;
			btn.style.color = isLow ? 'rgb(248,48,0)' : '';
		}
		// Desktop used (GB, 对齐 q3)
		var deskBtn = document.getElementById('drive-DESKTOP-btn');
		if (deskBtn && info['DESKTOP']) {
			var usedGB = (info['DESKTOP'].used || 0) / (1024*1024*1024);
			var dgbText = usedGB < 0.01 ? '0' : (usedGB >= 1 ? Math.floor(usedGB).toString() : usedGB.toFixed(2));
			deskBtn.textContent = 'Desktop ' + dgbText;
		}
		// Recycle Bin (GB, 对齐 q3)
		var recycleBtn = document.getElementById('drive-RECYCLE-btn');
		if (recycleBtn && info['RECYCLE'] && info['RECYCLE'].used > 0) {
			var rGB = (info['RECYCLE'].used || 0) / (1024*1024*1024);
			var rgbText = rGB < 0.01 ? '0' : (rGB >= 1 ? Math.floor(rGB).toString() : rGB.toFixed(2));
			recycleBtn.textContent = 'Recycle Bin ' + rgbText;
		}
	} catch(e) { console.warn('[q2-roam] updateDriveDisplay:', e); }
}

// ---- Sidebar resizer ----
(function() {
	var resizer = document.getElementById('sidebarResizer');
	var sidebar = document.getElementById('sidebar');
	var content = document.getElementById('kyContent');
	var dragging = false, startX = 0, startW = 0;
	resizer.addEventListener('mousedown', function(e) {
		e.preventDefault();
		dragging = true; startX = e.clientX; startW = sidebarW;
		resizer.classList.add('active');
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	});
	function onMove(e) {
		if (!dragging) return;
		var delta = e.clientX - startX;
		sidebarW = Math.max(60, Math.min(400, startW + delta));
		sidebar.style.width = sidebarW + 'px';
		resizer.style.left = sidebarW + 'px';
		content.style.left = (sidebarW + 8) + 'px';
	}
	function onUp() {
		dragging = false;
		resizer.classList.remove('active');
		document.removeEventListener('mousemove', onMove);
		document.removeEventListener('mouseup', onUp);
		_sidebarSave();
	}
})();

// ---- Custom scrollbar (full) ----
(function setupCustomScrollbar() {
	var container = document.getElementById('fileList');
	var bar = document.getElementById('customScrollbar');
	var thumb = document.getElementById('customScrollbarThumb');
	if (!container || !bar || !thumb) return;

	function getThumbHeight() {
		var ch = container.clientHeight, sh = container.scrollHeight;
		return Math.max(20, (ch / sh) * bar.clientHeight);
	}

	function update() {
		var ch = container.clientHeight, sh = container.scrollHeight, st = container.scrollTop;
		var barH = bar.clientHeight;
		if (sh > ch) {
			bar.style.display = '';
			var th = getThumbHeight();
			thumb.style.height = th + 'px';
			thumb.style.top = (st / (sh - ch)) * (barH - th) + 'px';
		} else {
			bar.style.display = 'none';
		}
	}

	container.addEventListener('scroll', update);

	// Drag thumb
	var dragging = false, startY, startST;
	thumb.onmousedown = function(e) {
		dragging = true; startY = e.clientY; startST = container.scrollTop;
		e.preventDefault(); e.stopPropagation();
		document.onmousemove = function(e) {
			if (!dragging) return;
			var dy = e.clientY - startY;
			var barH = bar.clientHeight;
			var th = thumb.offsetHeight;
			var sh = container.scrollHeight, ch = container.clientHeight;
			container.scrollTop = startST + (dy / (barH - th)) * (sh - ch);
		};
		document.onmouseup = function() { dragging = false; document.onmousemove = null; };
	};

	// Click track: left=page, Shift+left or right=jump
	bar.style.pointerEvents = 'auto';
	bar.addEventListener('mousedown', function(e) {
		if (e.target === thumb) return;
		e.preventDefault();
		var rect = bar.getBoundingClientRect();
		var clickY = e.clientY - rect.top;
		var th = thumb.offsetHeight;
		if (e.shiftKey || e.button === 2) {
			// Jump to position
			var sh = container.scrollHeight, ch = container.clientHeight;
			var barH = bar.clientHeight;
			var ratio = (clickY - th / 2) / (barH - th);
			container.scrollTop = Math.max(0, Math.min(1, ratio)) * (sh - ch);
		} else if (e.button === 0) {
			// Page up/down
			var thumbTop = parseFloat(thumb.style.top) || 0;
			var ch = container.clientHeight;
			if (clickY < thumbTop) container.scrollTop = Math.max(0, container.scrollTop - ch);
			else container.scrollTop = Math.min(container.scrollHeight - ch, container.scrollTop + ch);
		}
	});

	bar.addEventListener('contextmenu', function(e) { e.preventDefault(); e.stopPropagation(); });

	// Mutations: update on content change
	var obs = new MutationObserver(update);
	obs.observe(container, { childList: true, subtree: true });
	window.addEventListener('resize', update);
	update();

	// JS hover (file items)
	var hovered = null;
	container.addEventListener('mousemove', function(e) {
		var item = e.target.closest('.file-item');
		if (item === hovered) return;
		if (hovered) hovered.classList.remove('js-hover');
		hovered = item;
		if (hovered) hovered.classList.add('js-hover');
	});
	container.addEventListener('mouseleave', function() {
		if (hovered) hovered.classList.remove('js-hover');
		hovered = null;
	});

	// Keys 1/2: scroll to top/bottom (split jump based on midpoint)
	document.addEventListener('keydown', function(e) {
		var active = document.activeElement;
		if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
		var maxScroll = container.scrollHeight - container.clientHeight;
		var midPoint = maxScroll / 2;
		var currentPos = container.scrollTop;
		var tolerance = 10;
		if (e.key === '1') {
			e.preventDefault();
			if (currentPos <= midPoint + tolerance) container.scrollTop = 0;
			else container.scrollTop = midPoint;
		} else if (e.key === '2') {
			e.preventDefault();
			if (currentPos >= midPoint - tolerance) container.scrollTop = maxScroll;
			else container.scrollTop = midPoint;
		}
	}, true);

	// Idle repaint: clear artifacts after scroll/mousemove
	var idleHandle = null;
	function scheduleIdleRepaint() {
		if (idleHandle) return;
		idleHandle = requestIdleCallback(function() {
			idleHandle = null;
			container.style.willChange = 'transform';
			requestAnimationFrame(function() { container.style.willChange = ''; });
		});
	}
	container.addEventListener('scroll', scheduleIdleRepaint);
	container.addEventListener('mousemove', scheduleIdleRepaint);
})();

// ---- Keyboard shortcuts (Q/W/D/E/Z/Escape/F2) ----
(function() {
	function isInputActive() {
		var a = document.activeElement;
		if (!a) return false;
		var tag = a.tagName.toLowerCase();
		return tag === 'input' || tag === 'textarea' || a.isContentEditable || (a.classList && a.classList.contains('rename-input'));
	}
	document.addEventListener('keydown', function(e) {
		if (isInputActive()) return;
		var k = (e.key || '').toLowerCase();

		// ★ M8.2: Ctrl+C → write CF_HDROP to clipboard (files, not just text paths)
		if ((e.ctrlKey || e.metaKey) && k === 'c') {
			var targets = selectedItems.length > 1
				? selectedItems.filter(function(s) { return s.name !== '..'; })
				: (selectedItem && selectedItem.name !== '..' ? [selectedItem] : []);
			if (targets.length > 0) {
				e.preventDefault();
				var paths = targets.map(function(s) { return s.path; });
				// ① CF_HDROP — primary: paste in Explorer / other apps
				bridge.clipboard.writeFiles(paths).catch(function() {});
				// ② Text paths — fallback: paste as text in editors
				bridge.clipboard.writeText(paths.join('\n')).catch(function() {
					if (navigator.clipboard) navigator.clipboard.writeText(paths.join('\n')).catch(function(){});
				});
				_playSfx('copy');
				return;
			}
		}

		// Ctrl+A: Select all files
		if ((e.ctrlKey || e.metaKey) && k === 'a') {
			e.preventDefault();
			selectAllFiles();
			return;
		}

		if (e.ctrlKey || e.metaKey) return;
		// ★ Backspace: 返回上层目录；若从 .lnk 跳转而来则回到来源目录
		if (k === 'backspace') {
			e.preventDefault();
			if (lnkJumpFromPath) {
				var srcPath = lnkJumpFromPath;
				lnkJumpFromPath = null;
				// 验证来源目录仍存在
				bridge.fs.list(srcPath).then(function() { navigateTo(srcPath); }).catch(function() {
					lnkJumpFromPath = null;
					goUpOneLevel();
				});
			} else {
				goUpOneLevel();
			}
			return;
		}
		if (k === 'escape') { cancelSelection(); return; }
		// ★ Space key: s request — get sizes for selected items (or all items if none selected)
		if (k === ' ') {
			e.preventDefault();
			_doSRequest();
			return;
		}
		// ★ 空白区快捷：a → 喂给焦点 AI 面板 / c → CMD / x → PowerShell（a 让位给 AI，CMD 改为 c）
		if (k === 'a') {
			e.preventDefault();
			_feedCurrentToAi();
			return;
		}
		if (k === 'c') {
			e.preventDefault();
			bridge.shell.openTerminal(currentPath, 'cmd').catch(function(){});
			_playSfx('terminal');
			return;
		}
		if (k === 'x') {
			e.preventDefault();
			bridge.shell.openTerminal(currentPath, 'powershell').catch(function(){});
			_playSfx('terminal');
			return;
		}
		if (!selectedItem) return;
		var si = selectedItem;
		if (k === 'q') {
			e.preventDefault();
			performCodeAction(si);
		} else if (k === 'w') {
			e.preventDefault();
			performOpenAction(si);
		} else if (k === 'd') {
			e.preventDefault();
			performDeleteAction(si);
		} else if (k === 'e' || k === 'f2') {
			e.preventDefault();
			if (selectedItems.length > 1) return;
			performEditAction(si);
		} else if (k === 'z') {
			e.preventDefault();
			performCopyPathAction();
		} else if (e.key === 'Delete' && e.shiftKey) {
			// Shift+Delete: permanent delete (no recycle bin)
			e.preventDefault();
			var targets = selectedItems.filter(function(s) { return s.name !== '..'; });
			if (targets.length === 0) return;
			targets.forEach(function(t) {
				var el = findItemByPath(t.path);
				if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
			});
			Promise.all(targets.map(function(t) { return bridge.fs.remove(t.path).catch(function(){}); }))
				.then(function() { if (currentPath) loadFileList(currentPath); });
			cancelSelection();
			_playSfx('purge');
		}
	});
})();

// ---- Space key s request: recursive size calculation (from q3) ----
var _sRequestVersion = 0;

async function _calcDirSizeRecursive(dir) {
	var total = 0;
	try {
		var entries = await bridge.fs.list(dir);
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i];
			var fp = pathJoin(dir, e.name);
			if (e.isDir) { total += await _calcDirSizeRecursive(fp); }
			else { total += (e.size || 0); }
		}
	} catch(ex) { /* skip */ }
	return total;
}

async function _calcAndUpdateSize(item, version) {
	var size = 0;
	try {
		if (item.type === 'folder') { size = await _calcDirSizeRecursive(item.path); }
		else { var st = await bridge.fs.stat(item.path); size = (st && st.size) || 0; }
	} catch(ex) { size = 0; }
	if (version !== _sRequestVersion) return;
	var info = formatFileSizeEx(size);
	sessionSizeCache[item.path] = info; // 仅会话内缓存 (q3 对齐, 不落盘)
	var el = findItemByPath(item.path);
	if (el) {
		var szArea = el.querySelector('.sz-area');
		if (szArea) {
			if (info.gbPart) szArea.innerHTML = '<span style="color:' + SZ_GB_COLOR + '">' + info.gbPart + '</span>' + info.restPart + ' ';
			else szArea.textContent = info.text + ' ';
		}
	}
}

function _doSRequest() {
	var thisVersion = ++_sRequestVersion;
	var itemsToRequest = [];
	if (selectedItems.length > 0) {
		itemsToRequest = selectedItems.filter(function(s) { return s.name !== '..'; });
	} else {
		var allFileItems = document.querySelectorAll('#fileList .file-item');
		allFileItems.forEach(function(el) {
			if (el.dataset.name === '..') return;
			itemsToRequest.push({ path: el.dataset.path, type: el.dataset.type, name: el.dataset.name });
		});
	}
	if (itemsToRequest.length === 0) return;
	// Show loading indicator
	itemsToRequest.forEach(function(item) {
		var el = findItemByPath(item.path);
		if (el) {
			var szArea = el.querySelector('.sz-area');
			if (szArea) szArea.textContent = '\u2022';
		}
	});
	// Fire all concurrently; each result renders independently when ready
	itemsToRequest.forEach(function(item) { _calcAndUpdateSize(item, thisVersion); });
}

// ---- New file / New folder ----
var filenameInput = document.getElementById('filenameInput');

// Init char-undo for Ctrl+Z per-character undo
if (window.qqqCharUndo && window.qqqCharUndo.attach) {
	window.qqqCharUndo.attach(filenameInput);
}

// Helper: generate 222 empty lines for new file
function _newFileTemplate() {
	var lines = [];
	for (var i = 0; i < 222; i++) lines.push('');
	return lines.join('\n');
}

// Helper: check if name exists in current directory
function _nameExists(name) {
	var all = document.querySelectorAll('#fileList .file-item');
	for (var i = 0; i < all.length; i++) {
		if ((all[i].dataset.name || '').toLowerCase() === name.toLowerCase()) return true;
	}
	return false;
}

// ★ 异步确认对话框 — 替代同步 confirm()（Electron 同步模态会导致窗口假死）
// 走主进程 dialog.showMessageBox（异步、非阻塞），返回 Promise<boolean>
function _confirmAsync(message, buttons) {
	return new Promise(function(resolve) {
		var btns = buttons || ['Overwrite', 'Cancel'];
		rpc('dialog.message', {
			type: 'warning',
			title: 'qqqide',
			message: message,
			buttons: btns,
			defaultId: 0,
			cancelId: 1,
			noLink: true
		}).then(function(r) {
			resolve(!!(r && r.response === 0));
		}).catch(function() {
			resolve(false);
		});
	});
}

// ★ 非阻塞通知 — 父窗口 qoast（铁律 §4.2 iframe 统一入口），失败降级 paste-tip
function _roamToast(message, type) {
	try {
		if (parent && parent.qqqideQoast && parent.qqqideQoast.show) {
			parent.qqqideQoast.show(message, { duration: 4000, type: type || 'error' });
			return;
		}
	} catch(e) {}
	var tip = document.getElementById('addressPasteTip');
	if (tip) {
		tip.textContent = message;
		tip.classList.add('show');
		setTimeout(function() { tip.classList.remove('show'); }, 3000);
	}
}

async function doCreateFile() {
	var name = filenameInput.value.trim();
	if (!name) { filenameInput.focus(); return; }
	// Duplicate detection (异步确认，不阻塞渲染线程)
	if (_nameExists(name)) {
		var ok = await _confirmAsync('"' + name + '" already exists. Overwrite?');
		if (!ok) return;
	}
	var fullPath = pathJoin(currentPath, name);
	var content = _newFileTemplate();
	bridge.fs.write(fullPath, content).then(function() {
		filenameInput.value = '';
		// Reset char-undo history
		if (window.qqqCharUndo && window.qqqCharUndo.reset) window.qqqCharUndo.reset(filenameInput);
		recordDirHistory(currentPath);
		loadFileList(currentPath);
		// Open in editor + focus
		parent.postMessage({ type: 'qqq-file-open', path: fullPath }, '*');
	}).catch(function(err) {
		_roamToast('Failed to create file: ' + (err.message || err));
	});
}

function doCreateFolder() {
	var name = filenameInput.value.trim();
	if (!name) { filenameInput.focus(); return; }
	if (_nameExists(name)) {
		// 与 q3 一致：重名文件夹不弹覆盖框（mkdir 无法覆盖），仅提示
		_roamToast('Folder "' + name + '" already exists.');
		return;
	}
	var fullPath = pathJoin(currentPath, name);
	bridge.fs.mkdir(fullPath).then(function() {
		filenameInput.value = '';
		if (window.qqqCharUndo && window.qqqCharUndo.reset) window.qqqCharUndo.reset(filenameInput);
		recordDirHistory(currentPath);
		loadFileList(currentPath);
	}).catch(function(err) {
		_roamToast('Failed to create folder: ' + (err.message || err));
	});
}

// Enter in filename input = create new file
filenameInput.addEventListener('keydown', function(e) {
	if (e.key === 'Enter') {
		e.preventDefault();
		doCreateFile();
	}
});
document.getElementById('btnNewFile').addEventListener('click', doCreateFile);
document.getElementById('btnNewFolder').addEventListener('click', doCreateFolder);
document.getElementById('openFolderBtn').addEventListener('click', function() {
	bridge.shell.openPath(currentPath).catch(function(){});
	_playSfx('enter');
});



// ---- Responsive layout (buttons retreat when window narrows) ----
// Cascade priority (low to high): filter - filesOnTop - sortBy - szMode - open.
// Address bar inner has highest priority, never hidden.
var MIN_FILTER_RW = 500;
var MIN_FILESTOP_RW = 440;
var MIN_SORT_RW = 380;
var MIN_SZ_RW = 300;
var MIN_OPEN_RW = 220;
var MIN_FOOTER_W = 240;  // hide new-file button → narrow
var MIN_FOOTER_EXTREME = 170; // below: hide new-folder button → extreme

function checkAndApplyResponsive() {
	var container = document.querySelector('.container');
	var kyContent = document.getElementById('kyContent');
	if (!container) return;
	var pageW = container.clientWidth;

	// Footer buttons
	var footer = document.querySelector('.footer');
	var saveBtn = footer ? footer.querySelector('.save-button') : null;
	var cancelBtn = footer ? footer.querySelector('.cancel-button') : null;

	if (saveBtn) saveBtn.style.display = (pageW < MIN_FOOTER_W) ? 'none' : '';
	if (cancelBtn) cancelBtn.style.display = (pageW < MIN_FOOTER_EXTREME) ? 'none' : '';
	if (footer) {
		footer.classList.toggle('responsive-narrow', pageW < MIN_FOOTER_W);
		footer.classList.toggle('responsive-extreme', pageW < MIN_FOOTER_EXTREME);
	}

	// Address bar row — based on right panel width (kyContent)
	if (kyContent) {
		var rw = kyContent.clientWidth;
		var sortByGroup = document.getElementById('sortByGroup');
		var szModeGroup = document.getElementById('szModeGroup');
		var filterWrapper = document.querySelector('.filter-input-wrapper');
		var filesOnTopBtn = document.getElementById('filesOnTopBtn');
		var openBtn = document.getElementById('openFolderBtn');

		// Cascade: hide lower-priority items first, address bar (flex:1) gets space
		if (filterWrapper) filterWrapper.style.display = (rw < MIN_FILTER_RW) ? 'none' : '';
		if (filesOnTopBtn) filesOnTopBtn.style.display = (rw < MIN_FILESTOP_RW) ? 'none' : '';
		if (sortByGroup) sortByGroup.style.display = (rw < MIN_SORT_RW) ? 'none' : '';
		if (szModeGroup) szModeGroup.style.display = (rw < MIN_SZ_RW) ? 'none' : '';
		if (openBtn) openBtn.style.display = (rw < MIN_OPEN_RW) ? 'none' : '';
	}

	// Recent section: hide when height too small
	setTimeout(calculateAndAdjustScroll, 50);
}

var _baseRecentHeight = 0;
function calculateAndAdjustScroll() {
	var recentSection = document.querySelector('.recent-section');
	var kyContent = document.getElementById('kyContent');
	var addressBar = document.querySelector('.address-bar');
	if (!recentSection || !addressBar || !kyContent) return;

	var footerHeight = 60;
	var editorHeight = window.innerHeight - footerHeight;

	if (!_baseRecentHeight && recentSection.style.display !== 'none') {
		_baseRecentHeight = recentSection.offsetHeight || recentSection.scrollHeight || 0;
	}
	var addressHeight = addressBar.offsetHeight || 0;
	var needHeight = (_baseRecentHeight || recentSection.offsetHeight || 0) + addressHeight + 100;

	recentSection.style.display = (editorHeight < needHeight) ? 'none' : '';
}

// ResizeObserver — fire on container resize
(function() {
	var container = document.querySelector('.container');
	if (!container) return;
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(function() { checkAndApplyResponsive(); }).observe(container);
	} else {
		window.addEventListener('resize', checkAndApplyResponsive);
	}
})();