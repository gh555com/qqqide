// ============================================================================
// q2-roam.js — Roam file explorer logic
// Extracted from q2-roam.html to keep HTML under size limits.
// ============================================================================

// ---- Color scheme randomizer (runs immediately, sets --selection-bg/text) ----
(function() {
	var isDark = false;
	try { isDark = parent.document.documentElement.getAttribute('data-theme') === 'dark'; } catch(e) {}
	var lightSchemes = [
		{ name: 'Coral', bg: '#e8d0c0', text: '#000000', weight: 30 },
		{ name: 'Warm Apricot', bg: '#e8d0b0', text: '#000000', weight: 30 },
		{ name: 'Bean Paste', bg: '#e7e4c2', text: '#000000', weight: 30 },
		{ name: 'Vivid Red', bg: '#cb4b16', text: '#fdf6e3', weight: 10 }
	];
	var darkSchemes = [
		{ name: 'Ember', bg: '#5a3a2a', text: '#f0e8d8', weight: 30 },
		{ name: 'Bronze', bg: '#4a3520', text: '#e8d8c0', weight: 30 },
		{ name: 'Olive Night', bg: '#3a3a20', text: '#d8d0b0', weight: 30 },
		{ name: 'Dark Flame', bg: '#6a2a10', text: '#fdf6e3', weight: 10 }
	];
	var schemes = isDark ? darkSchemes : lightSchemes;
	var totalWeight = schemes.reduce(function(s, x) { return s + x.weight; }, 0);
	var rand = Math.random() * totalWeight, cumulative = 0, selected = schemes[0];
	for (var i = 0; i < schemes.length; i++) {
		cumulative += schemes[i].weight;
		if (rand < cumulative) { selected = schemes[i]; break; }
	}
	document.documentElement.style.setProperty('--selection-bg', selected.bg);
	document.documentElement.style.setProperty('--selection-text', selected.text);
})();

// ---- Main Roam logic ----
(function() {
'use strict';

// ---- RPC helper: call parent bridge methods via postMessage ----
let _rpcId = 0;
const _rpcPending = {};
function rpc(method, params) {
	return new Promise((ok, fail) => {
		const id = 'q2-' + (++_rpcId);
		_rpcPending[id] = { ok, fail };
		parent.postMessage({ type: 'qqq-rpc', qood: 'q2', method, id, params }, '*');
		setTimeout(() => { if (_rpcPending[id]) { delete _rpcPending[id]; fail(new Error('RPC timeout')); } }, 15000);
	});
}
window.addEventListener('message', function(e) {
	if (!e.data) return;
	if (e.data.type === 'qqq-rpc-reply' && _rpcPending[e.data.id]) {
		const p = _rpcPending[e.data.id];
		delete _rpcPending[e.data.id];
		if (e.data.error) p.fail(new Error(e.data.error.message));
		else p.ok(e.data.result);
		return;
	}
    // 主题同步（来自父窗口 qqq-theme.js 唯一真理配色机器）
    if (e.data && e.data.type === 'qqq-theme-change') {
      if (e.data.dark) document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
    }
});

// ★ 直连 parent.qgs.simple('roam') — 绕过 postMessage RPC，零超时零丢包
//   与 shell-rpc.js 的 store.* RPC handler 读写同一 global.sq3 namespace
var _roamDbDirect = null;
function _roamDb() {
	if (_roamDbDirect) return _roamDbDirect;
	try {
		if (parent && parent.qgs && parent.qgs.simple) {
			_roamDbDirect = parent.qgs.simple('roam');
			return _roamDbDirect;
		}
	} catch(e) {}
	return null;
}
async function _roamGet(key) {
	var db = _roamDb();
	if (db) {
		try { return await db.get(key); } catch(e) { console.warn('[roam] direct get failed:', key, e); }
	}
	// 降级到 RPC
	try { return await bridge.store.get(key); } catch(e) { return null; }
}
function _roamSet(key, value) {
	var db = _roamDb();
	if (db) {
		db.set(key, value).catch(function(e) { console.warn('[roam] direct set failed:', key, e); });
		return;
	}
	// 降级到 RPC
	bridge.store.set(key, value);
}

// RPC-based bridge proxy
// Single args pass directly; multi-args use { __spread: true, args: [...] }
var bridge = {
	fs: {
		list: (p) => rpc('fs.list', p),
		read: (p) => rpc('fs.read', p),
		readBase64: (p) => rpc('fs.readBase64', p),
		write: (p, c) => rpc('fs.write', { __spread: true, args: [p, c] }),
		mkdir: (p) => rpc('fs.mkdir', p),
		remove: (p) => rpc('fs.remove', p),
		rename: (o, n) => rpc('fs.rename', { __spread: true, args: [o, n] }),
	},
	clipboard: {
		writeText: (s) => rpc('clipboard.writeText', s),
	},
	shell: {
		openPath: (p) => rpc('shell.openPath', p),
	},
	store: {
		get: (k) => rpc('store.get', k),
		set: (k, v) => rpc('store.set', { key: k, value: v }),
		getLocal: (k) => rpc('store.getLocal', k),
		setLocal: (k, v) => rpc('store.setLocal', { key: k, value: v }),
	}
};

// 初始主题同步
(function(){
  try {
    if (parent && parent.qqqideTheme) {
      if (parent.qqqideTheme.isDark()) document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      var t = parent.document.documentElement.getAttribute('data-theme');
      if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch(e) { parent.postMessage({ type: 'qqq-theme-request' }, '*'); }
})();

// ---- Persistent state (loaded async on boot) ----
var currentPath = '';
var selectedItems = [];
var selectedItem = null;
var lastSelectedItem = null;
var lnkJumpFromPath = null; // ★ 从 .lnk 快捷方式跳转时记录来源目录，返回时回到这里而非上层
var sortBy = 'name', _globalSortBy = 'name';
var szMode = 'size', _globalSzMode = 'size';
var filesOnTop = false;
var sidebarW = 160;
var _qqiq = [];           // [{path,type}]
var _pinnedDirs = [];      // [path]
var _fineScm = {};         // { normalizedPath: {szMode,sortBy,filesOnTop,ts} }
var _cmdHistory = { address: [], fileFilter: [] };
var _lineSpacing = -2;
var FINE_SCM_MAX = 500;
var sessionSizeCache = {};

// ---- Persistence helpers ----
function _normPath(p) { return (p || '').toLowerCase().replace(/\//g, '\\').replace(/[\\]+$/, ''); }
function _fineScmSave() {
	// Evict oldest beyond 500
	var keys = Object.keys(_fineScm);
	if (keys.length > FINE_SCM_MAX) {
		var sorted = keys.sort(function(a, b) { return (_fineScm[a].ts || 0) - (_fineScm[b].ts || 0); });
		var toRemove = sorted.slice(0, keys.length - FINE_SCM_MAX);
		for (var i = 0; i < toRemove.length; i++) delete _fineScm[toRemove[i]];
	}
	_roamSet('roam.fineScm', _fineScm);
}
function _prefsSave() {
	_roamSet('roam.prefs', {
		lineSpacing: _lineSpacing, globalSzMode: _globalSzMode, globalSortBy: _globalSortBy
	});
}
function _qqiqSave() { _roamSet('roam.qqiq', _qqiq); }
function _pinnedSave() { _roamSet('roam.pinnedDirs', _pinnedDirs); }
function _historySave() { _roamSet('roam.lastVisitedDir', currentPath); }
function _cmdHistorySave() { _roamSet('roam.cmdHistory', _cmdHistory); }
function _sidebarSave() { bridge.store.setLocal('roam.sidebarWidth', sidebarW); }
function applySidebarWidth() {
	var sb = document.getElementById('sidebar');
	var rz = document.getElementById('sidebarResizer');
	var ct = document.getElementById('kyContent');
	if (!sb || !rz || !ct) return;
	sb.style.width = sidebarW + 'px';
	rz.style.left = sidebarW + 'px';
	ct.style.left = (sidebarW + 8) + 'px';
}

function fineScmGet(p) {
	var k = _normPath(p);
	return _fineScm[k] || { szMode: null, sortBy: null, filesOnTop: false };
}
function fineScmSet(p, sz, so, fot) {
	var k = _normPath(p);
	if (sz === null && so === null && !fot) { delete _fineScm[k]; }
	else { _fineScm[k] = { szMode: sz, sortBy: so, filesOnTop: !!fot, ts: Date.now() }; }
	_fineScmSave();
}

// Apply fine-grained SCM for current folder
function applyFineScm(p) {
	var f = fineScmGet(p);
	// Effective: fine > global > default
	szMode = f.szMode || _globalSzMode;
	if (szMode === 'nothing') szMode = 'size'; // never truly nothing
	sortBy = f.sortBy || _globalSortBy;
	filesOnTop = !!f.filesOnTop;
	updateSCMButtons();
}

// ---- Utility ----
function pathJoin(a, b) {
	if (!a) return b;
	var sep = a.includes('\\') ? '\\' : '/';
	if (a.endsWith('/') || a.endsWith('\\')) return a + b;
	return a + sep + b;
}
function baseName(p) {
	var parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
	return parts[parts.length - 1] || p;
}
var SZ_GB_THRESHOLD = 1000000000;
var SZ_GB_COLOR = 'rgb(248,48,0)';
function addThousandSep(num) {
	var s = String(Math.floor(num)), parts = [];
	for (var i = s.length; i > 0; i -= 3) parts.unshift(s.slice(Math.max(0, i - 3), i));
	return parts.join(',');
}
function formatFileSizeEx(bytes) {
	var formatted = addThousandSep(bytes);
	if (bytes >= SZ_GB_THRESHOLD) {
		var parts = formatted.split(',');
		if (parts.length >= 4) {
			var gbParts = parts.slice(0, parts.length - 3);
			var restParts = parts.slice(parts.length - 3);
			return { text: formatted, gbPart: gbParts.join(','), restPart: ',' + restParts.join(',') };
		}
	}
	return { text: formatted, gbPart: '', restPart: '' };
}
function formatDateTime(date) {
	if (!date) return '';
	var d = new Date(date);
	if (isNaN(d.getTime())) return '';
	var y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
	var h = String(d.getHours()).padStart(2, '0'), mi = String(d.getMinutes()).padStart(2, '0');
	return y + '.' + mo + '.' + da + ' ' + h + ':' + mi;
}
function getSzContent(entry) {
	if (szMode === 'nothing') return '';
	if (szMode === 'size') {
		if (entry.isDir) return '';
		var bytes = entry.size || 0;
		var info = formatFileSizeEx(bytes);
		if (info.gbPart) return '<span style="color:' + SZ_GB_COLOR + '">' + info.gbPart + '</span>' + info.restPart + ' ';
		return info.text + ' ';
	}
	if (szMode === 'ctime') return formatDateTime(entry.ctime) + ' ';
	if (szMode === 'mtime') return formatDateTime(entry.mtime) + ' ';
	return '';
}

// ---- Address bar ----
var addressInput = document.getElementById('addressInput');
var addressDisplay = document.getElementById('addressDisplay');

function updateAddressDisplay(p) {
	if (!addressDisplay) return;
	var parts = p.split(/[\\/]/).filter(Boolean);
	addressDisplay.innerHTML = parts.map(function(s) { return '<span>' + escHtml(s) + '</span>'; }).join('<span class="path-sep">›</span>');
}
function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

addressInput.addEventListener('keydown', function(e) {
	if (e.key === 'Enter') {
		e.preventDefault();
		var p = addressInput.value.trim();
		if (p) {
			// Save to history (dedup, cap 20)
			if (!_cmdHistory.address) _cmdHistory.address = [];
			var arr = _cmdHistory.address.filter(function(x) { return x !== p; });
			arr.unshift(p);
			if (arr.length > 20) arr.length = 20;
			_cmdHistory.address = arr;
			_cmdHistorySave();
			navigateTo(p);
		}
		addressInput.blur();
	}
});

// ---- Copy path button ----
document.getElementById('addressCopyBtn').addEventListener('click', function() {
	if (currentPath) bridge.clipboard.writeText(currentPath).catch(() => {
		if (navigator.clipboard) navigator.clipboard.writeText(currentPath).catch(() => {});
	});
});

// ---- Navigate ----
function navigateTo(p, opts) {
	opts = opts || {};
	// ★ 正常导航时清除 lnkJumpFromPath（lnk 跳转在调用后重新设置）
	if (!opts.keepLnkJump) lnkJumpFromPath = null;
	currentPath = p;
	applyFineScm(p);
	addressInput.value = p;
	updateAddressDisplay(p);
	loadFileList(p);
	recordDirHistory(p);
	_historySave();
}

// 返回上一层目录
function goUpOneLevel() {
	if (!currentPath) return;
	var parts = currentPath.replace(/[\\/]+$/, '').split(/[\\/]/);
	if (parts.length > 1) {
		parts.pop();
		var parent = parts.join(currentPath.indexOf('\\') >= 0 ? '\\' : '/');
		// Windows 盘符根目录补反斜杠（如 C: → C:\）
		if (currentPath.indexOf('\\') >= 0 && parent.length === 2 && parent[1] === ':') parent += '\\';
		navigateTo(parent);
	}
}

// ---- Windows .lnk 快捷方式解析（纯 JS，从 q3 移植）----
// 规范: MS-SHLLINK (Shell Link Binary File Format)
// 输入: base64 编码的 .lnk 文件内容
// 输出: 目标路径或 null
function parseLnkTargetFromBase64(base64) {
	try {
		var raw = atob(base64);
		var buf = new Uint8Array(raw.length);
		for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

		function uint32LE(off) { return buf[off] | (buf[off+1]<<8) | (buf[off+2]<<16) | (buf[off+3]<<24); }
		function uint16LE(off) { return buf[off] | (buf[off+1]<<8); }

		// 最小有效 .lnk 大小: 76 字节头
		if (buf.length < 76) return null;
		// 验证魔数: 4C 00 00 00
		if (uint32LE(0) !== 0x4C) return null;

		var linkFlags = uint32LE(0x14);
		var hasLinkTargetIDList = (linkFlags & 0x01) !== 0;
		var hasLinkInfo = (linkFlags & 0x02) !== 0;

		var offset = 76;
		// 跳过 LinkTargetIDList
		if (hasLinkTargetIDList) {
			if (offset + 2 > buf.length) return null;
			var idListSize = uint16LE(offset);
			offset += 2 + idListSize;
		}

		var ansiPath = null;
		// 从 LinkInfo 提取路径
		if (hasLinkInfo) {
			if (offset + 28 <= buf.length) {
				var linkInfoStart = offset;
				var linkInfoSize = uint32LE(offset);
				var linkInfoHeaderSize = uint32LE(offset + 4);
				var linkInfoFlags = uint32LE(offset + 8);
				var hasVolumeIDAndLocalBasePath = (linkInfoFlags & 0x01) !== 0;

				if (hasVolumeIDAndLocalBasePath && linkInfoSize >= 28) {
					var localBasePathOffset = uint32LE(offset + 16);

					// 先试 Unicode 路径（header size >= 0x24）
					if (linkInfoHeaderSize >= 0x24 && offset + 32 <= buf.length) {
						var unicodeOffset = uint32LE(offset + 28);
						if (unicodeOffset > 0 && unicodeOffset < linkInfoSize) {
							var uStart = linkInfoStart + unicodeOffset;
							var uEnd = uStart;
							while (uEnd + 1 < buf.length && !(buf[uEnd] === 0 && buf[uEnd + 1] === 0)) uEnd += 2;
							if (uEnd > uStart) {
								var utf16 = '';
								for (var j = uStart; j < uEnd; j += 2) utf16 += String.fromCharCode(buf[j] | (buf[j+1]<<8));
								if (utf16 && utf16.length > 2) return utf16;
							}
						}
					}

					// 再试 ANSI 路径
					if (localBasePathOffset > 0 && localBasePathOffset < linkInfoSize) {
						var aStart = linkInfoStart + localBasePathOffset;
						var aEnd = aStart;
						while (aEnd < buf.length && buf[aEnd] !== 0) aEnd++;
						if (aEnd > aStart) {
							ansiPath = '';
							for (var k = aStart; k < aEnd; k++) ansiPath += String.fromCharCode(buf[k]);
							if (ansiPath && ansiPath.length > 2) return ansiPath;
						}
					}
				}
			}
		}

		// 兜底: 扫描整个文件找 Unicode 路径模式 "X:\"（[A-Z] 00 3A 00 5C 00）
		for (var s = 0; s < buf.length - 10; s++) {
			var b0 = buf[s];
			if (b0 >= 0x41 && b0 <= 0x5A && buf[s+1] === 0 &&
			    buf[s+2] === 0x3A && buf[s+3] === 0 &&
			    buf[s+4] === 0x5C && buf[s+5] === 0) {
				var e = s;
				while (e + 1 < buf.length && !(buf[e] === 0 && buf[e+1] === 0)) e += 2;
				if (e > s + 4) {
					var path16 = '';
					for (var j = s; j < e; j += 2) path16 += String.fromCharCode(buf[j] | (buf[j+1]<<8));
					if (path16 && path16.length > 3 && /^[A-Z]:\.+/.test(path16)) return path16;
				}
			}
		}

		return ansiPath;
	} catch(_) { return null; }
}

// 异步解析 .lnk 文件，返回目标路径或 null
async function resolveLnkTarget(lnkPath) {
	try {
		var b64 = await bridge.fs.readBase64(lnkPath);
		if (!b64) return null;
		return parseLnkTargetFromBase64(b64);
	} catch(_) { return null; }
}

// ---- qqiq & pinnedDirs (client-side, persisted via store) ----
var QQ_IQ_MAX = 100, QQ_PIN_MAX = 6;

function _qqiqKey(p) { return _normPath(p); }

function recordDirHistory(dirPath) {
	if (!dirPath) return;
	var key = _qqiqKey(dirPath);
	// Skip if already pinned
	if (_pinnedDirs.some(function(d) { return _qqiqKey(d) === key; })) return;
	// Dedup & push to top
	_qqiq = _qqiq.filter(function(item) { return _qqiqKey(item.path) !== key; });
	_qqiq.unshift({ path: dirPath, type: 'dir' });
	if (_qqiq.length > QQ_IQ_MAX) _qqiq.length = QQ_IQ_MAX;
	_qqiqSave();
	renderQqiqSection();
}

function recordFileHistory(filePath) {
	if (!filePath) return;
	var dirPath = filePath.replace(/[\\/][^\\/]+$/, '');
	var dirKey = _qqiqKey(dirPath), fileKey = _qqiqKey(filePath);
	var pinnedKeys = _pinnedDirs.map(_qqiqKey);
	// Remove old
	_qqiq = _qqiq.filter(function(item) { var k = _qqiqKey(item.path); return k !== dirKey && k !== fileKey; });
	// Insert dir first (if not pinned), then file
	if (pinnedKeys.indexOf(dirKey) === -1) _qqiq.unshift({ path: dirPath, type: 'dir' });
	_qqiq.unshift({ path: filePath, type: 'file' });
	if (_qqiq.length > QQ_IQ_MAX) _qqiq.length = QQ_IQ_MAX;
	_qqiqSave();
	renderQqiqSection();
}

function pinDirectory(dirPath) {
	if (!dirPath) return;
	var key = _qqiqKey(dirPath);
	// Remove from qqiq
	_qqiq = _qqiq.filter(function(item) { return _qqiqKey(item.path) !== key; });
	// Dedup pinned, push to bottom
	_pinnedDirs = _pinnedDirs.filter(function(d) { return _qqiqKey(d) !== key; });
	_pinnedDirs.push(dirPath);
	// Overflow: oldest moves back to qqiq
	while (_pinnedDirs.length > QQ_PIN_MAX) {
		var removed = _pinnedDirs.shift();
		_qqiq.unshift({ path: removed, type: 'dir' });
	}
	_qqiqSave(); _pinnedSave();
	renderQqiqSection(); renderPinnedDirs();
}

function unpinDirectory(dirPath) {
	if (!dirPath) return;
	var key = _qqiqKey(dirPath);
	_pinnedDirs = _pinnedDirs.filter(function(d) { return _qqiqKey(d) !== key; });
	_qqiq = _qqiq.filter(function(item) { return _qqiqKey(item.path) !== key; });
	_qqiq.unshift({ path: dirPath, type: 'dir' });
	_pinnedSave(); _qqiqSave();
	renderQqiqSection(); renderPinnedDirs();
}

function movePinnedDir(dirPath, direction) {
	var key = _qqiqKey(dirPath);
	var idx = -1;
	for (var i = 0; i < _pinnedDirs.length; i++) { if (_qqiqKey(_pinnedDirs[i]) === key) { idx = i; break; } }
	if (idx === -1) return;
	var target = direction === 'up' ? idx - 1 : idx + 1;
	if (target < 0 || target >= _pinnedDirs.length) return;
	var tmp = _pinnedDirs[idx]; _pinnedDirs[idx] = _pinnedDirs[target]; _pinnedDirs[target] = tmp;
	_pinnedSave(); renderPinnedDirs();
}

function renderQqiqSection() {
	var driveList = document.getElementById('driveList');
	// Remove old
	var oldDiv = driveList.querySelector('.divider'); if (oldDiv) oldDiv.remove();
	var oldSec = driveList.querySelector('.qq-iq-section'); if (oldSec) oldSec.remove();
	if (_qqiq.length === 0) return;
	// Divider
	var divEl = document.createElement('div'); divEl.className = 'divider'; driveList.appendChild(divEl);
	// QQ section
	var sec = document.createElement('div'); sec.className = 'qq-iq-section';
	for (var i = 0; i < _qqiq.length; i++) {
		sec.appendChild(buildQqiqItem(_qqiq[i]));
	}
	driveList.appendChild(sec);
}

function buildQqiqItem(item) {
	var el = document.createElement('div');
	el.className = 'qq-item ' + (item.type === 'file' ? 'qq-file' : 'qq-dir');
	if (item.type === 'file') {
		var fileName = item.path.replace(/^.*[\\/]/, '');
		var text = document.createElement('span');
		text.className = 'qq-text'; text.textContent = fileName; text.title = item.path;
		el.appendChild(text);
		el.addEventListener('click', function() {
			parent.postMessage({ type: 'qqq-file-open', path: item.path }, '*');
			recordFileHistory(item.path);
		});
	} else {
		var text2 = document.createElement('span');
		text2.className = 'qq-text'; text2.textContent = item.path; text2.title = item.path;
		el.appendChild(text2);
		var pin = document.createElement('span');
		pin.className = 'pin-icon';
		pin.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14"><path d="M5 17 L15 5 M15 5 L5 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
		pin.title = 'Pin';
		pin.addEventListener('click', function(e) { e.stopPropagation(); pinDirectory(item.path); });
		el.appendChild(pin);
		text2.addEventListener('click', function() { navigateTo(item.path); });
	}
	return el;
}

function renderPinnedDirs() {
	var recentList = document.getElementById('recentList');
	recentList.innerHTML = '';
	for (var i = 0; i < _pinnedDirs.length; i++) {
		(function(dir, idx) {
			var el = document.createElement('div');
			el.className = 'recent-item';
			var del = document.createElement('span');
			del.className = 'delete-button'; del.textContent = '\u00d7';
			del.addEventListener('click', function(e) { e.stopPropagation(); unpinDirectory(dir); });
			el.appendChild(del);
			var sp = document.createElement('span'); sp.textContent = dir; sp.title = dir;
			el.appendChild(sp);
			var moveGrp = document.createElement('span');
			moveGrp.className = 'pin-move-group';
			var upBtn = document.createElement('span');
			upBtn.className = 'pin-move-btn'; upBtn.textContent = '\u25B2';
			upBtn.addEventListener('click', function(e) { e.stopPropagation(); movePinnedDir(dir, 'up'); });
			var dnBtn = document.createElement('span');
			dnBtn.className = 'pin-move-btn'; dnBtn.textContent = '\u25BC';
			dnBtn.addEventListener('click', function(e) { e.stopPropagation(); movePinnedDir(dir, 'down'); });
			moveGrp.appendChild(upBtn); moveGrp.appendChild(dnBtn);
			el.appendChild(moveGrp);
			el.addEventListener('click', function() { navigateTo(dir); });
			recentList.appendChild(el);
		})(_pinnedDirs[i], i);
	}
}

// ★ 自然排序：数字部分按数值比较
function naturalCompare(a, b) {
	var re = /(\d+)|(\D+)/g;
	var aParts = String(a).match(re) || [];
	var bParts = String(b).match(re) || [];
	var maxLen = Math.max(aParts.length, bParts.length);
	for (var i = 0; i < maxLen; i++) {
		var ap = aParts[i] || '';
		var bp = bParts[i] || '';
		var aNum = parseInt(ap, 10);
		var bNum = parseInt(bp, 10);
		if (!isNaN(aNum) && !isNaN(bNum)) {
			if (aNum !== bNum) return aNum - bNum;
		} else {
			if (ap !== bp) return ap < bp ? -1 : 1;
		}
	}
	return 0;
}

// ---- Load file list ----
async function loadFileList(p) {
	var fileList = document.getElementById('fileList');
	fileList.innerHTML = '';
	selectedItems = [];
	selectedItem = null;
	lastSelectedItem = null;
	try {
		// ★ Parent directory ".." entry
		var isRoot = false;
		if (p.includes('\\')) { isRoot = /^[A-Za-z]:\\$/.test(p); }
		else { isRoot = (p === '/' || p === ''); }
		if (!isRoot) {
			var parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
			parts.pop();
			var parentDir = parts.join(p.includes('\\') ? '\\' : '/');
			if (p.includes('\\') && parentDir.length === 2 && parentDir.endsWith(':')) parentDir += '\\';
			if (!parentDir && !p.includes('\\')) parentDir = '/';
			var parentEntry = { name: '..', isDir: true, size: 0, ctime: 0, mtime: 0 };
			fileList.appendChild(buildFileItem(parentEntry, parentDir));
		}

		var entries = await bridge.fs.list(p);
		entries.sort(function(a, b) {
			if (filesOnTop) {
				if (!a.isDir && b.isDir) return -1;
				if (a.isDir && !b.isDir) return 1;
			} else {
				if (a.isDir && !b.isDir) return -1;
				if (!a.isDir && b.isDir) return 1;
			}
			switch (sortBy) {
				case 'size': return (b.size||0) - (a.size||0);
				case 'ctime': return (b.ctime||0) - (a.ctime||0);
				case 'mtime': return (b.mtime||0) - (a.mtime||0);
				default: return naturalCompare(String(a.name), String(b.name));
			}
		});
		for (var i = 0; i < entries.length; i++) {
			fileList.appendChild(buildFileItem(entries[i], pathJoin(p, entries[i].name)));
		}
	} catch(err) {
		fileList.innerHTML = '<div style="padding:20px;color:var(--red);">' + escHtml(String(err)) + '</div>';
	}
}

function buildFileItem(entry, fullPath) {
	var item = document.createElement('div');
	item.className = 'file-item';
	item.dataset.path = fullPath;
	item.dataset.type = entry.isDir ? 'folder' : 'file';
	item.dataset.name = entry.name;

	// sz area (size/date) — HTML mode for red GB
	var sz = document.createElement('div');
	sz.className = 'sz-area';
	var szHtml = getSzContent(entry);
	if (szHtml) sz.innerHTML = szHtml;
	// Check cache
	if (sessionSizeCache[fullPath] && szMode !== 'nothing') {
		var c = sessionSizeCache[fullPath];
		if (c.gbPart) sz.innerHTML = '<span style="color:' + SZ_GB_COLOR + '">' + c.gbPart + '</span>' + c.restPart + ' ';
		else sz.textContent = c.text;
	}
	item.appendChild(sz);

	if (entry.isDir) {
		var selectArea = document.createElement('div');
		selectArea.className = 'file-select-area';
		var icon = document.createElement('span');
		icon.className = 'file-icon';
		icon.textContent = '📁';
		selectArea.appendChild(icon);
		item.appendChild(selectArea);
		var nameArea = document.createElement('div');
		nameArea.className = 'folder-name-area';
		nameArea.textContent = entry.name;
		item.appendChild(nameArea);
	} else {
		var nameArea2 = document.createElement('div');
		nameArea2.className = 'file-name-area';
		var icon2 = document.createElement('span');
		icon2.className = 'file-icon';
		icon2.textContent = '📄';
		nameArea2.appendChild(icon2);
		var nameSpan = document.createElement('span');
		nameSpan.textContent = ' ' + entry.name;
		nameArea2.appendChild(nameSpan);
		item.appendChild(nameArea2);
	}

	// Click — selection-aware
	item.addEventListener('click', function(e) {
		// ".." parent entry always navigates
		if (entry.name === '..') { navigateTo(fullPath); return; }
		var isSzClick = e.target.classList.contains('sz-area');
		if (entry.isDir && !isSzClick) {
			navigateTo(fullPath);
			return;
		}
		selectFileItem(item, e.shiftKey);
	});

	// Double-click on file → open
	item.addEventListener('dblclick', function(e) {
		if (!entry.isDir) {
			parent.postMessage({ type: 'qqq-file-open', path: fullPath }, '*');
			recordFileHistory(fullPath);
		}
	});

	// Context menu
	item.addEventListener('contextmenu', function(e) {
		e.preventDefault();
		if (!item.classList.contains('selected')) selectFileItem(item, false);
		showContextMenu(e.clientX, e.clientY, fullPath, entry);
	});

	return item;
}

// ---- Selection system ----
function cancelSelection() {
	var prev = document.querySelectorAll('#fileList .file-item.selected');
	prev.forEach(function(el) { el.classList.remove('selected'); });
	selectedItems = [];
	selectedItem = null;
	lastSelectedItem = null;
}
function selectFileItem(fileItem, shiftKey) {
	if (!fileItem) return;
	var type = fileItem.dataset.type, path = fileItem.dataset.path, name = fileItem.dataset.name;
	if (!shiftKey || !lastSelectedItem) {
		cancelSelection();
		fileItem.classList.add('selected');
		selectedItem = { type: type, path: path, name: name };
		selectedItems = [selectedItem];
		lastSelectedItem = fileItem;
	} else {
		// Shift range select — save lastSelectedItem before clearing selection
		var _last = lastSelectedItem;
		cancelSelection();
		var all = Array.from(document.querySelectorAll('#fileList .file-item'));
		var si = all.indexOf(_last), ei = all.indexOf(fileItem);
		if (si === -1 || ei === -1) { selectFileItem(fileItem, false); return; }
		var start = Math.min(si, ei), end = Math.max(si, ei);
		selectedItems = [];
		for (var i = start; i <= end; i++) {
			var el = all[i];
			el.classList.add('selected');
			var sel = { type: el.dataset.type, path: el.dataset.path, name: el.dataset.name };
			selectedItems.push(sel);
		}
		selectedItem = { type: type, path: path, name: name };
		lastSelectedItem = fileItem;
	}
}
function findItemByPath(p) {
	var all = document.querySelectorAll('#fileList .file-item');
	for (var i = 0; i < all.length; i++) { if (all[i].dataset.path === p) return all[i]; }
	return null;
}

// ---- Inline rename -------
var _renameMouseHandler = null;
var _renameCtxHandler = null;
var _renameWheelHandler = null;
var _renameMidClickHandler = null;

function startRename(itemPath, itemName, itemType) {
	var itemEl = findItemByPath(itemPath);
	if (!itemEl) return;
	// Cancel any existing rename
	var prevSel = document.querySelector('#fileList .file-item.selected');
	if (prevSel && prevSel !== itemEl) {
		if (prevSel.querySelector('.rename-input')) cancelRename(prevSel);
		prevSel.classList.remove('selected');
	}
	itemEl.classList.add('selected');
	selectedItem = { type: itemType, path: itemPath, name: itemName };
	selectedItems = [selectedItem];
	lastSelectedItem = itemEl;

	var nameArea = itemEl.querySelector(itemType === 'file' ? '.file-name-area' : '.folder-name-area');
	if (!nameArea || nameArea.querySelector('.rename-input')) return;

	var originalHTML = nameArea.innerHTML;
	var input = document.createElement('input');
	input.type = 'text';
	input.className = 'rename-input';
	input.value = itemName;
	nameArea.innerHTML = '';
	nameArea.appendChild(input);
	input.focus();

	// Init char-undo for Ctrl+Z
	if (window.qqqCharUndo && window.qqqCharUndo.attach) {
		window.qqqCharUndo.attach(input);
		window.qqqCharUndo.reset(input);
	}

	// Select name without extension
	var dotIdx = itemName.lastIndexOf('.');
	if (dotIdx > 0) input.setSelectionRange(0, dotIdx);
	else input.select();

	var handleKeyDown = function(e) {
		if (e.key === 'Enter') {
			e.preventDefault(); e.stopPropagation();
			commitRename(itemEl, itemPath, itemType, input.value.trim());
		} else if (e.key === 'Escape') {
			e.preventDefault(); e.stopPropagation();
			cancelRename(itemEl, originalHTML);
		}
	};

	// Click outside = commit
	_renameMouseHandler = function(e) {
		if (e.button !== 0) return;
		if (input.contains(e.target) || e.target === input) return;
		e.preventDefault(); e.stopPropagation();
		commitRename(itemEl, itemPath, itemType, input.value.trim());
	};

	// Block right-click during edit
	_renameCtxHandler = function(e) { e.preventDefault(); e.stopPropagation(); };

	// Block wheel during edit
	_renameWheelHandler = function(e) { e.preventDefault(); e.stopPropagation(); };

	// Block middle-click during edit
	_renameMidClickHandler = function(e) {
		if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
	};

	document.addEventListener('mousedown', _renameMouseHandler, true);
	document.addEventListener('contextmenu', _renameCtxHandler, true);
	document.addEventListener('wheel', _renameWheelHandler, { capture: true, passive: false });
	document.addEventListener('auxclick', _renameMidClickHandler, true);

	input.addEventListener('keydown', handleKeyDown);
	itemEl.dataset.originalContent = originalHTML;
}

function cleanupRenameHandlers() {
	if (_renameMouseHandler) { document.removeEventListener('mousedown', _renameMouseHandler, true); _renameMouseHandler = null; }
	if (_renameCtxHandler) { document.removeEventListener('contextmenu', _renameCtxHandler, true); _renameCtxHandler = null; }
	if (_renameWheelHandler) { document.removeEventListener('wheel', _renameWheelHandler, { capture: true, passive: false }); _renameWheelHandler = null; }
	if (_renameMidClickHandler) { document.removeEventListener('auxclick', _renameMidClickHandler, true); _renameMidClickHandler = null; }
}

function commitRename(itemEl, oldPath, itemType, newName) {
	var input = itemEl.querySelector('.rename-input');
	if (!input) return;
	cleanupRenameHandlers();
	var oldName = itemEl.dataset.name;
	if (newName && newName !== oldName) {
		var dir = oldPath.substring(0, oldPath.length - oldName.length);
		bridge.fs.rename(oldPath, pathJoin(dir, newName)).then(function() {
			if (currentPath) loadFileList(currentPath);
		}).catch(function() {
			cancelRename(itemEl, itemEl.dataset.originalContent);
		});
	} else {
		cancelRename(itemEl, itemEl.dataset.originalContent);
	}
}

function cancelRename(itemEl, originalHTML) {
	var input = itemEl.querySelector('.rename-input');
	if (!input) return;
	cleanupRenameHandlers();
	var itemType = itemEl.dataset.type;
	var nameArea = itemEl.querySelector(itemType === 'file' ? '.file-name-area' : '.folder-name-area');
	if (nameArea) {
		nameArea.innerHTML = originalHTML || ('<span>' + escHtml(itemEl.dataset.name) + '</span>');
	}
}

// ---- Reload preserving selection ----
function reloadCurrentDir() {
	if (!currentPath) return;
	var selPaths = selectedItems.map(function(s) { return s.path; });
	var lastPath = lastSelectedItem ? lastSelectedItem.dataset.path : null;
	loadFileList(currentPath);
	// Restore selection after DOM update (defer)
	setTimeout(function() {
		var restored = false, newLast = null;
		selPaths.forEach(function(sp) {
			var el = findItemByPath(sp);
			if (el) { el.classList.add('selected'); restored = true; }
			if (sp === lastPath && el) newLast = el;
		});
		if (restored) {
			if (newLast) lastSelectedItem = newLast;
		} else { cancelSelection(); }
	}, 50);
}

// ---- Context menu ----
var ctxMenu = document.getElementById('itemContextMenu');
var ctxTarget = null;
var ctxEntry = null;

function showContextMenu(x, y, path, entry) {
	ctxTarget = path;
	ctxEntry = entry;
	ctxMenu.style.display = 'flex';
	ctxMenu.style.left = x + 'px';
	ctxMenu.style.top = y + 'px';
}

document.addEventListener('click', function() { ctxMenu.style.display = 'none'; });

ctxMenu.querySelectorAll('.context-menu-item').forEach(function(el) {
	el.addEventListener('click', function() {
		var action = el.dataset.action;
		if (!ctxTarget) return;
		switch (action) {
			case 'code':
				parent.postMessage({ type: 'qqq-file-open', path: ctxTarget }, '*');
				break;
				case 'open':
				if (ctxEntry && ctxEntry.isDir) navigateTo(ctxTarget);
				else parent.postMessage({ type: 'qqq-file-open', path: ctxTarget }, '*');
				break;
			case 'delete':
				if (confirm('Delete ' + baseName(ctxTarget) + '?')) {
					bridge.fs.remove(ctxTarget).then(function() { loadFileList(currentPath); });
				}
				break;
			case 'rename':
				if (ctxEntry && ctxEntry.name === '..') return;
				startRename(ctxTarget, baseName(ctxTarget), ctxEntry.isDir ? 'folder' : 'file');
				break;
			case 'copyPath':
				bridge.clipboard.writeText(ctxTarget).catch(() => {
					if (navigator.clipboard) navigator.clipboard.writeText(ctxTarget).catch(() => {});
				});
				break;
		}
		ctxMenu.style.display = 'none';
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
			btn.title = d;
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

	// Recycle Bin entry
	var recycleBtn = document.createElement('button');
	recycleBtn.className = 'nav-item';
	recycleBtn.id = 'drive-RECYCLE-btn';
	recycleBtn.textContent = 'Recycle Bin';
	recycleBtn.title = 'Recycle Bin';
	driveList.appendChild(recycleBtn);

	// Fetch disk free info
	// (a) 立即触发一次（rpc forwarder 修了后立刻生效；200ms 让 iframe 先挂载完）
	setTimeout(updateDriveDisplay, 200);
	// (b) 30s 轮询
	if (_drivePollingTimer) clearInterval(_drivePollingTimer);
	_drivePollingTimer = setInterval(updateDriveDisplay, 30000);
}

async function updateDriveDisplay() {
	try {
		var info = await rpc('fs.diskFree', _driveList);
		for (var i = 0; i < _driveList.length; i++) {
			var letter = _driveList[i].charAt(0);
			var btn = document.getElementById('drive-' + letter + '-btn');
			if (!btn) continue;
			var data = info[letter];
			if (!data) { btn.textContent = letter + ':\\ '; continue; }
			var freeGB = (data.free / (1024*1024*1024)).toFixed(1);
			var totalGB = (data.total / (1024*1024*1024)).toFixed(1);
			var pct = data.total > 0 ? (data.free / data.total) : 1;
			btn.textContent = letter + ':\\ ' + freeGB + ' GB';
			// Red warning if free < 1% or < 2GB
			if (pct < 0.01 || data.free < 2*1024*1024*1024) {
				btn.style.color = 'var(--red)';
			} else {
				btn.style.color = '';
			}
		}
		// Desktop used
		var deskBtn = document.getElementById('drive-DESKTOP-btn');
		if (deskBtn && info['DESKTOP']) {
			var usedMB = (info['DESKTOP'].used / (1024*1024)).toFixed(0);
			deskBtn.textContent = 'Desktop  ' + usedMB + ' MB';
		}
		// Recycle Bin
		var recycleBtn = document.getElementById('drive-RECYCLE-btn');
		if (recycleBtn && info['RECYCLE'] && info['RECYCLE'].used > 0) {
			var rMB = (info['RECYCLE'].used / (1024*1024)).toFixed(0);
			recycleBtn.textContent = 'Recycle Bin  ' + rMB + ' MB';
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

	// Keys 1/2: scroll to top/bottom
	document.addEventListener('keydown', function(e) {
		var active = document.activeElement;
		if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
		if (e.key === '1') {
			var maxScroll = container.scrollHeight - container.clientHeight;
			if (container.scrollTop <= maxScroll / 2 + 10) container.scrollTop = 0;
			else container.scrollTop = maxScroll / 2;
		} else if (e.key === '2') {
			var maxScroll = container.scrollHeight - container.clientHeight;
			if (container.scrollTop >= maxScroll / 2 - 10) container.scrollTop = maxScroll;
			else container.scrollTop = maxScroll / 2;
		}
	}, true);
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
		if (!selectedItem) return;
		var si = selectedItem;
		if (k === 'q') {
			e.preventDefault();
			parent.postMessage({ type: 'qqq-file-open', path: si.path }, '*');
			// ★ q=编辑：文件及父目录入 qq 区
			recordFileHistory(si.path);
		} else if (k === 'w') {
			e.preventDefault();
			if (si.type === 'folder') { navigateTo(si.path); }
			else if (si.path && /\.lnk$/i.test(si.path)) {
				// ★ .lnk 快捷方式：异步解析目标，若指向文件夹则在 Roam 内导航
				var srcDir = currentPath;
				resolveLnkTarget(si.path).then(function(target) {
					if (target) {
						// 先导航到目标，再设 lnkJumpFromPath（navigateTo 会清除它）
						navigateTo(target);
						lnkJumpFromPath = srcDir;
					} else {
						// 解析失败→按普通文件打开
						parent.postMessage({ type: 'qqq-file-open', path: si.path }, '*');
						recordFileHistory(si.path);
					}
				});
			}
			else { parent.postMessage({ type: 'qqq-file-open', path: si.path }, '*'); recordFileHistory(si.path); }
		} else if (k === 'd') {
			e.preventDefault();
			var targets = selectedItems.filter(function(s) { return s.name !== '..'; });
			if (targets.length === 0) return;
			if (!confirm('Delete ' + targets.length + ' item(s)?')) return;
			targets.forEach(function(t) {
				var el = findItemByPath(t.path);
				if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
			});
			Promise.all(targets.map(function(t) { return bridge.fs.remove(t.path).catch(function(){}); }))
				.then(function() { if (currentPath) loadFileList(currentPath); });
			cancelSelection();
		} else if (k === 'e') {
			e.preventDefault();
			if (selectedItems.length > 1) return;
			if (si.name === '..') return;
			startRename(si.path, si.name, si.type);
		} else if (k === 'f2') {
			e.preventDefault();
			if (selectedItems.length > 1) return;
			if (si.name === '..') return;
			startRename(si.path, si.name, si.type);
		} else if (k === 'z') {
			e.preventDefault();
			var paths = selectedItems.filter(function(s) { return s.name !== '..'; }).map(function(s) { return s.path; });
			if (paths.length > 0) bridge.clipboard.writeText(paths.join('\n')).catch(function(){});
		}
	});
})();

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

function doCreateFile() {
	var name = filenameInput.value.trim();
	if (!name) { filenameInput.focus(); return; }
	// Duplicate detection
	if (_nameExists(name)) {
		if (!confirm('"' + name + '" already exists. Overwrite?')) return;
	}
	var fullPath = pathJoin(currentPath, name);
	var content = _newFileTemplate();
	bridge.fs.write(fullPath, content).then(function() {
		filenameInput.value = '';
		// Reset char-undo history
		if (window.qqqCharUndo && window.qqqCharUndo.reset) window.qqqCharUndo.reset(filenameInput);
		loadFileList(currentPath);
		// Open in editor + focus
		parent.postMessage({ type: 'qqq-file-open', path: fullPath }, '*');
	}).catch(function(err) {
		alert('Failed to create file: ' + (err.message || err));
	});
}

function doCreateFolder() {
	var name = filenameInput.value.trim();
	if (!name) { filenameInput.focus(); return; }
	if (_nameExists(name)) {
		if (!confirm('"' + name + '" already exists. Overwrite?')) return;
	}
	var fullPath = pathJoin(currentPath, name);
	bridge.fs.mkdir(fullPath).then(function() {
		filenameInput.value = '';
		if (window.qqqCharUndo && window.qqqCharUndo.reset) window.qqqCharUndo.reset(filenameInput);
		loadFileList(currentPath);
	}).catch(function(err) {
		alert('Failed to create folder: ' + (err.message || err));
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



// ---- Responsive layout (buttons retreat when window narrows) ----
var MIN_ADDRESS_RW = 340;  // below: hide sortBy + filter + filesOnTop
var MIN_SZ_RW = 200;       // below: hide szMode group
var MIN_FOOTER_W = 240;   // below: hide new-file button → narrow
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

		if (sortByGroup) sortByGroup.style.display = (rw < MIN_ADDRESS_RW) ? 'none' : '';
		if (filesOnTopBtn) filesOnTopBtn.style.display = (rw < MIN_ADDRESS_RW) ? 'none' : '';
		if (filterWrapper) filterWrapper.style.display = (rw < MIN_ADDRESS_RW) ? 'none' : '';
		if (openBtn) openBtn.style.display = (rw < MIN_ADDRESS_RW) ? 'none' : '';
		if (szModeGroup) szModeGroup.style.display = (rw < MIN_SZ_RW) ? 'none' : '';
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

// ---- Boot ----
(async function boot() {
	// ★ 直连 parent.qgs 读取持久化数据（绕过 RPC，零超时零丢包）
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
	try {
		var sw = await bridge.store.getLocal('roam.sidebarWidth');
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
	navigateTo(root);
	updateSCMButtons();

	// ---- Initial responsive check ----
	checkAndApplyResponsive();

	// ---- KeyHook iframe adapter (unified Roam shortcut routing) ----
	// Attach as scope='iframe:roam' so window-side dispatcher matches Q/W/Space/1/2/Tab
	try {
		if (parent && parent.qqqideKeyHookAdapter && parent.qqqideKeyHookAdapter.attach) {
			parent.qqqideKeyHookAdapter.attach({ scope: 'iframe:roam', swallow: true });
		}
	} catch(e) { console.warn('[q2-roam] keyhook adapter attach failed:', e); }

	// ---- Listen for parent → iframe cmd dispatch ----
	window.addEventListener('message', function(e) {
		if (!e.data || e.data.type !== 'qqq-roam-cmd') return;
		var cmd = e.data.cmd;
		// Best-effort: dispatch as window event so feature handlers below can react.
		document.dispatchEvent(new CustomEvent('qqq-roam-cmd', { detail: { cmd: cmd } }));
	});
})();

})();