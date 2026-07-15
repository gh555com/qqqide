// ============================================================================
// q2-roam.js — Roam file explorer logic (clean transplant from q3)
// ============================================================================

// ---- Color scheme randomizer ----
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

// Binary file extensions (from q3)
var BINARY_EXTS = {
	'.exe':1,'.dll':1,'.bin':1,'.dat':1,'.iso':1,'.msi':1,'.bat':1,'.cmd':1,'.ps1':1,
	'.zip':1,'.rar':1,'.7z':1,'.tar':1,'.gz':1,'.bz2':1,
	'.png':1,'.jpg':1,'.jpeg':1,'.gif':1,'.bmp':1,'.webp':1,'.ico':1,'.tiff':1,'.tif':1,'.svg':1,'.ai':1,'.eps':1,'.cdr':1,'.psd':1,
	'.mp4':1,'.mkv':1,'.webm':1,'.avi':1,'.mov':1,'.wmv':1,'.flv':1,'.rmvb':1,'.mpeg':1,'.mpg':1,'.3gp':1,'.m4v':1,'.f4v':1,'.mts':1,'.m2ts':1,'.vob':1,
	'.mp3':1,'.wav':1,'.flac':1,'.m4a':1,'.aac':1,'.ogg':1,'.wma':1,
	'.pdf':1
};
function isBinaryFile(p) {
	var ext = p.substring(p.lastIndexOf('.')).toLowerCase();
	return !!BINARY_EXTS[ext];
}

// RPC helper
var _rpcId = 0;
var _rpcPending = {};
function rpc(method, params) {
	return new Promise(function(ok, fail) {
		var id = 'q2-' + (++_rpcId);
		_rpcPending[id] = { ok: ok, fail: fail };
		parent.postMessage({ type: 'qqq-rpc', qood: 'q2', method: method, id: id, params: params }, '*');
		setTimeout(function() { if (_rpcPending[id]) { delete _rpcPending[id]; fail(new Error('RPC timeout')); } }, 15000);
	});
}
window.addEventListener('message', function(e) {
	if (!e.data) return;
	if (e.data.type === 'qqq-rpc-reply' && _rpcPending[e.data.id]) {
		var p = _rpcPending[e.data.id];
		delete _rpcPending[e.data.id];
		if (e.data.error) p.fail(new Error(e.data.error.message));
		else p.ok(e.data.result);
		return;
	}
	if (e.data && (e.data.type === 'qqqide-theme-change' || e.data.type === 'qqq-theme-change')) {
		if (e.data.dark) document.documentElement.setAttribute('data-theme', 'dark');
		else document.documentElement.removeAttribute('data-theme');
	}
});

// Bridge proxy via RPC
var bridge = {
	fs: {
		list: function(p) { return rpc('fs.list', p); },
		read: function(p) { return rpc('fs.read', p); },
		readBase64: function(p) { return rpc('fs.readBase64', p); },
		write: function(p, c) { return rpc('fs.write', { __spread: true, args: [p, c] }); },
		mkdir: function(p) { return rpc('fs.mkdir', p); },
		remove: function(p) { return rpc('fs.remove', p); },
		rename: function(o, n) { return rpc('fs.rename', { __spread: true, args: [o, n] }); }
	},
	clipboard: { writeText: function(s) { return rpc('clipboard.writeText', s); } },
	shell: { openPath: function(p) { return rpc('shell.openPath', p); } },
	store: {
		get: function(k) { return rpc('store.get', k); },
		set: function(k, v) { return rpc('store.set', { key: k, value: v }); },
		getLocal: function(k) { return rpc('store.getLocal', k); },
		setLocal: function(k, v) { return rpc('store.setLocal', { key: k, value: v }); }
	}
};

// Direct parent.qgs persistence
var _roamDbDirect = null;
function _roamDb() {
	if (_roamDbDirect) return _roamDbDirect;
	try { if (parent && parent.qgs && parent.qgs.simple) { _roamDbDirect = parent.qgs.simple('roam'); return _roamDbDirect; } } catch(e) {}
	return null;
}
async function _roamGet(key) {
	var db = _roamDb();
	if (db) { try { return await db.get(key); } catch(e) {} }
	try { return await bridge.store.get(key); } catch(e) { return null; }
}
function _roamSet(key, value) {
	var db = _roamDb();
	if (db) { db.set(key, value).catch(function(e) {}); return; }
	bridge.store.set(key, value);
}

// Initial theme sync
(function(){
	try {
		if (parent && parent.qqqideTheme) {
			if (parent.qqqideTheme.isDark()) document.documentElement.setAttribute('data-theme', 'dark');
		} else {
			var t = parent.document.documentElement.getAttribute('data-theme');
			if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
		}
	} catch(e) { parent.postMessage({ type: 'qqqide-theme-request' }, '*'); }
})();

// Persistent state
var currentPath = '';
var selectedItems = [];
var selectedItem = null;
var lastSelectedItem = null;
var lnkJumpFromPath = null;
var sortBy = 'name', _globalSortBy = 'name';
var szMode = 'size', _globalSzMode = 'size';
var filesOnTop = false;
var sidebarW = 160;
var _qqiq = [];
var _pinnedDirs = [];
var _fineScm = {};
var _cmdHistory = { address: [], fileFilter: [], qqFilter: [] };
var FINE_SCM_MAX = 500;
var sessionSizeCache = {};

// Persistence
function _normPath(p) { return (p || '').toLowerCase().replace(/\//g, '\\').replace(/[\\]+$/, ''); }
function _fineScmSave() {
	var keys = Object.keys(_fineScm);
	if (keys.length > FINE_SCM_MAX) {
		var sorted = keys.sort(function(a, b) { return (_fineScm[a].ts || 0) - (_fineScm[b].ts || 0); });
		for (var i = 0; i < keys.length - FINE_SCM_MAX; i++) delete _fineScm[sorted[i]];
	}
	_roamSet('roam.fineScm', _fineScm);
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

function fineScmGet(p) { var k = _normPath(p); return _fineScm[k] || { szMode: null, sortBy: null, filesOnTop: false }; }
function fineScmSet(p, sz, so, fot) {
	var k = _normPath(p);
	if (sz === null && so === null && !fot) { delete _fineScm[k]; }
	else { _fineScm[k] = { szMode: sz, sortBy: so, filesOnTop: !!fot, ts: Date.now() }; }
	_fineScmSave();
}
function applyFineScm(p) {
	var f = fineScmGet(p);
	szMode = f.szMode || _globalSzMode;
	if (szMode === 'nothing') szMode = 'size';
	sortBy = f.sortBy || _globalSortBy;
	filesOnTop = !!f.filesOnTop;
	updateSCMButtons();
}

// Utility
function pathJoin(a, b) {
	if (!a) return b;
	var sep = a.indexOf('\\') >= 0 ? '\\' : '/';
	if (a.charAt(a.length-1) === '/' || a.charAt(a.length-1) === '\\') return a + b;
	return a + sep + b;
}
function baseName(p) { var parts = p.replace(/[\\/]+$/, '').split(/[\\/]/); return parts[parts.length - 1] || p; }

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
	if (szMode === 'ctime') return formatDateTime(entry.ctimeMs) + ' ';
	if (szMode === 'mtime') return formatDateTime(entry.mtimeMs) + ' ';
	return '';
}

// Address bar
var addressInput = document.getElementById('addressInput');
var addressDisplay = document.getElementById('addressDisplay');

function updateAddressDisplay(p) {
	if (!addressDisplay) return;
	var parts = p.split(/[\\/]/).filter(Boolean);
	addressDisplay.innerHTML = parts.map(function(s) { return '<span>' + escHtml(s) + '</span>'; }).join('<span class="path-sep">\\</span>');
}
function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

addressInput.addEventListener('keydown', function(e) {
	if (e.key === 'Enter') {
		e.preventDefault();
		var pt = addressInput.value.trim();
		if (pt) {
			if (!_cmdHistory.address) _cmdHistory.address = [];
			var arr = _cmdHistory.address.filter(function(x) { return x !== pt; });
			arr.unshift(pt); if (arr.length > 20) arr.length = 20;
			_cmdHistory.address = arr; _cmdHistorySave();
			navigateTo(pt);
		}
		addressInput.blur();
	}
});

document.getElementById('addressCopyBtn').addEventListener('click', function() {
	if (currentPath) bridge.clipboard.writeText(currentPath).catch(function() {
		if (navigator.clipboard) navigator.clipboard.writeText(currentPath).catch(function() {});
	});
});

// Navigation
function navigateTo(p, opts) {
	opts = opts || {};
	if (!opts.keepLnkJump) lnkJumpFromPath = null;
	currentPath = p;
	applyFineScm(p);
	addressInput.value = p;
	updateAddressDisplay(p);
	loadFileList(p);
	_historySave();
}

function goUpOneLevel() {
	if (!currentPath) return;
	var parts = currentPath.replace(/[\\/]+$/, '').split(/[\\/]/);
	if (parts.length > 1) {
		parts.pop();
		var parentDir = parts.join(currentPath.indexOf('\\') >= 0 ? '\\' : '/');
		if (currentPath.indexOf('\\') >= 0 && parentDir.length === 2 && parentDir[1] === ':') parentDir += '\\';
		navigateTo(parentDir);
	}
}

// .lnk parser (from q3)
function parseLnkTargetFromBase64(base64) {
	try {
		var raw = atob(base64);
		var buf = new Uint8Array(raw.length);
		for (var i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

		function u32(off) { return buf[off] | (buf[off+1]<<8) | (buf[off+2]<<16) | (buf[off+3]<<24); }
		function u16(off) { return buf[off] | (buf[off+1]<<8); }

		if (buf.length < 76) return null;
		if (u32(0) !== 0x4C) return null;

		var linkFlags = u32(0x14);
		var hasIDList = (linkFlags & 0x01) !== 0;
		var hasLinkInfo = (linkFlags & 0x02) !== 0;

		var offset = 76;
		if (hasIDList) { if (offset + 2 > buf.length) return null; offset += 2 + u16(offset); }

		var ansiPath = null;
		if (hasLinkInfo && offset + 28 <= buf.length) {
			var liStart = offset, liSize = u32(offset), liHdrSize = u32(offset + 4);
			var liFlags = u32(offset + 8);
			if ((liFlags & 0x01) && liSize >= 28) {
				var lbpOff = u32(offset + 16);
				if (liHdrSize >= 0x24 && offset + 32 <= buf.length) {
					var uniOff = u32(offset + 28);
					if (uniOff > 0 && uniOff < liSize) {
						var us = liStart + uniOff, ue = us;
						while (ue + 1 < buf.length && !(buf[ue] === 0 && buf[ue+1] === 0)) ue += 2;
						if (ue > us) { var u16s = ''; for (var j = us; j < ue; j += 2) u16s += String.fromCharCode(buf[j] | (buf[j+1]<<8)); if (u16s && u16s.length > 2) return u16s; }
					}
				}
				if (lbpOff > 0 && lbpOff < liSize) {
					var as = liStart + lbpOff, ae = as;
					while (ae < buf.length && buf[ae] !== 0) ae++;
					if (ae > as) { ansiPath = ''; for (var k = as; k < ae; k++) ansiPath += String.fromCharCode(buf[k]); if (ansiPath && ansiPath.length > 2) return ansiPath; }
				}
			}
		}

		for (var s = 0; s < buf.length - 10; s++) {
			if (buf[s] >= 0x41 && buf[s] <= 0x5A && buf[s+1] === 0 && buf[s+2] === 0x3A && buf[s+3] === 0 && buf[s+4] === 0x5C && buf[s+5] === 0) {
				var e = s;
				while (e + 1 < buf.length && !(buf[e] === 0 && buf[e+1] === 0)) e += 2;
				if (e > s + 4) { var p16 = ''; for (var j2 = s; j2 < e; j2 += 2) p16 += String.fromCharCode(buf[j2] | (buf[j2+1]<<8)); if (p16 && p16.length > 3 && /^[A-Z]:\\.+/.test(p16)) return p16; }
			}
		}
		return ansiPath;
	} catch(_) { return null; }
}

async function resolveLnkTarget(lnkPath) {
	try { var b64 = await bridge.fs.readBase64(lnkPath); if (!b64) return null; return parseLnkTargetFromBase64(b64); } catch(_) { return null; }
}

// qqiq & pinnedDirs
var QQ_IQ_DISPLAY = 33, QQ_IQ_MAX = 400, QQ_PIN_MAX = 6;
function _qqiqKey(p) { return _normPath(p); }

function recordDirHistory(dirPath) {
	if (!dirPath) return;
	var key = _qqiqKey(dirPath);
	if (_pinnedDirs.some(function(d) { return _qqiqKey(d) === key; })) return;
	_qqiq = _qqiq.filter(function(item) { return _qqiqKey(item.path) !== key; });
	_qqiq.unshift({ path: dirPath, type: 'dir' });
	if (_qqiq.length > QQ_IQ_MAX) _qqiq.length = QQ_IQ_MAX;
	_qqiqSave(); renderQqiqSection();
}

function recordFileHistory(filePath) {
	if (!filePath) return;
	var dirPath = filePath.replace(/[\\/][^\\/]+$/, '');
	var dirKey = _qqiqKey(dirPath), fileKey = _qqiqKey(filePath);
	var pinnedKeys = _pinnedDirs.map(_qqiqKey);
	_qqiq = _qqiq.filter(function(item) { var k = _qqiqKey(item.path); return k !== dirKey && k !== fileKey; });
	if (pinnedKeys.indexOf(dirKey) === -1) _qqiq.unshift({ path: dirPath, type: 'dir' });
	_qqiq.unshift({ path: filePath, type: 'file' });
	if (_qqiq.length > QQ_IQ_MAX) _qqiq.length = QQ_IQ_MAX;
	_qqiqSave(); renderQqiqSection();
}

function pinDirectory(dirPath) {
	if (!dirPath) return;
	var key = _qqiqKey(dirPath);
	_qqiq = _qqiq.filter(function(item) { return _qqiqKey(item.path) !== key; });
	_pinnedDirs = _pinnedDirs.filter(function(d) { return _qqiqKey(d) !== key; });
	_pinnedDirs.push(dirPath);
	while (_pinnedDirs.length > QQ_PIN_MAX) { _qqiq.unshift({ path: _pinnedDirs.shift(), type: 'dir' }); }
	_qqiqSave(); _pinnedSave(); renderQqiqSection(); renderPinnedDirs();
}

function unpinDirectory(dirPath) {
	if (!dirPath) return;
	var key = _qqiqKey(dirPath);
	_pinnedDirs = _pinnedDirs.filter(function(d) { return _qqiqKey(d) !== key; });
	_qqiq = _qqiq.filter(function(item) { return _qqiqKey(item.path) !== key; });
	_qqiq.unshift({ path: dirPath, type: 'dir' });
	_pinnedSave(); _qqiqSave(); renderQqiqSection(); renderPinnedDirs();
}

function movePinnedDir(dirPath, direction) {
	var key = _qqiqKey(dirPath), idx = -1;
	for (var i = 0; i < _pinnedDirs.length; i++) { if (_qqiqKey(_pinnedDirs[i]) === key) { idx = i; break; } }
	if (idx === -1) return;
	var target = direction === 'up' ? idx - 1 : idx + 1;
	if (target < 0 || target >= _pinnedDirs.length) return;
	var tmp = _pinnedDirs[idx]; _pinnedDirs[idx] = _pinnedDirs[target]; _pinnedDirs[target] = tmp;
	_pinnedSave(); renderPinnedDirs();
}

function renderQqiqSection() {
	var driveList = document.getElementById('driveList');
	var oldDiv = driveList.querySelector('.divider'); if (oldDiv) oldDiv.remove();
	var oldFc = driveList.querySelector('.qq-filter-container'); if (oldFc) oldFc.remove();
	var oldSec = driveList.querySelector('.qq-iq-section'); if (oldSec) oldSec.remove();
	if (_qqiq.length === 0) return;
	var divEl = document.createElement('div'); divEl.className = 'divider'; driveList.appendChild(divEl);
	var fc = document.createElement('div');
	fc.className = 'qq-filter-container';
	fc.innerHTML = '<input type="text" class="qq-filter-input" id="qqFilterInput" placeholder="find" spellcheck="false"><div id="qqFilterHistoryDropdown" class="history-dropdown"></div>';
	driveList.appendChild(fc);
	var sec = document.createElement('div'); sec.className = 'qq-iq-section';
	var total = Math.min(_qqiq.length, QQ_IQ_MAX);
	for (var i = 0; i < total; i++) {
		var itemEl = buildQqiqItem(_qqiq[i]);
		if (i >= QQ_IQ_DISPLAY) itemEl.style.display = 'none';
		sec.appendChild(itemEl);
	}
	driveList.appendChild(sec);
}

function _escAttr(s) { return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildQqiqItem(item) {
	var el = document.createElement('div');
	el.className = 'qq-item ' + (item.type === 'file' ? 'qq-file' : 'qq-dir');
	el.setAttribute('data-fullpath', item.path);
	if (item.type === 'file') {
		var fileName = item.path.replace(/^.*[\\/]/, '');
		var lastBS = item.path.lastIndexOf('\\');
		var tipHtml;
		if (lastBS !== -1) {
			tipHtml = _escAttr(item.path.substring(0, lastBS)) + ' <span style="font-weight:bold;color:#dc322f;">\\</span> ' + _escAttr(item.path.substring(lastBS + 1));
		} else { tipHtml = _escAttr(item.path); }
		el.setAttribute('data-tooltip', tipHtml);
		el.setAttribute('data-use-html', 'true');
		var text = document.createElement('span');
		text.className = 'qq-text'; text.textContent = fileName;
		el.appendChild(text);
		el.addEventListener('click', function() { parent.postMessage({ type: 'qqq-file-open', path: item.path }, '*'); recordFileHistory(item.path); });
	} else {
		var text2 = document.createElement('span');
		text2.className = 'qq-text'; text2.textContent = item.path;
		el.appendChild(text2);
		var pin = document.createElement('span');
		pin.className = 'pin-icon';
		pin.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14"><path d="M5 17 L15 5 M15 5 L5 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
		pin.addEventListener('click', function(e) { e.stopPropagation(); pinDirectory(item.path); });
		el.appendChild(pin);
		text2.addEventListener('click', function() { navigateTo(item.path); });
	}
	return el;
}

function applyqqiqFilter(keyword) {
	var section = document.querySelector('.qq-iq-section');
	if (!section) return;
	var kw = (keyword || '').trim().toLowerCase();
	var terms = kw ? kw.split(/\s+/).filter(Boolean) : [];
	var items = section.querySelectorAll('.qq-item');
	for (var i = 0; i < items.length; i++) {
		var item = items[i];
		if (terms.length === 0) { item.style.display = (i < QQ_IQ_DISPLAY) ? '' : 'none'; continue; }
		var fp = (item.getAttribute('data-fullpath') || '').toLowerCase();
		var txt = (item.textContent || '').toLowerCase();
		var hay = fp + ' ' + txt;
		var match = true;
		for (var t = 0; t < terms.length; t++) { if (hay.indexOf(terms[t]) === -1) { match = false; break; } }
		item.style.display = match ? '' : 'none';
	}
}

function hideAllDropdowns() { var dds = document.querySelectorAll('.history-dropdown'); for (var i = 0; i < dds.length; i++) dds[i].style.display = 'none'; }

function showFilterHistory(inputEl, key) {
	hideAllDropdowns();
	if (document.activeElement !== inputEl) return;
	var hist = _cmdHistory[key] || [];
	if (!hist.length) return;
	var dd = document.getElementById(key === 'qqFilter' ? 'qqFilterHistoryDropdown' : 'fileFilterHistoryDropdown');
	if (!dd) return;
	dd.innerHTML = '';
	for (var i = 0; i < hist.length; i++) { var div = document.createElement('div'); div.className = 'history-dropdown-item'; div.textContent = hist[i]; dd.appendChild(div); }
	dd.style.display = 'block';
}

function initQqFilter() {
	var sidebar = document.querySelector('.sidebar');
	if (!sidebar) return;
	sidebar.addEventListener('input', function(e) {
		var t = e.target; if (!t || t.id !== 'qqFilterInput') return;
		hideAllDropdowns(); applyqqiqFilter(t.value); if (t.value === '') showFilterHistory(t, 'qqFilter');
	});
	sidebar.addEventListener('focusin', function(e) {
		var t = e.target; if (!t || t.id !== 'qqFilterInput') return; if (t.value === '') showFilterHistory(t, 'qqFilter');
	});
	sidebar.addEventListener('focusout', function(e) {
		var t = e.target; if (!t || t.id !== 'qqFilterInput') return; setTimeout(function() { hideAllDropdowns(); }, 120);
	});
	sidebar.addEventListener('mousedown', function(e) { if (e.target && e.target.closest && e.target.closest('#qqFilterHistoryDropdown')) e.preventDefault(); });
	sidebar.addEventListener('keydown', function(e) {
		var t = e.target; if (!t || t.id !== 'qqFilterInput') return;
		if (e.key === 'Enter') {
			var val = t.value.trim();
			if (val) { var arr = _cmdHistory.qqFilter.filter(function(x) { return x !== val; }); arr.unshift(val); if (arr.length > 20) arr.length = 20; _cmdHistory.qqFilter = arr; _cmdHistorySave(); }
			hideAllDropdowns(); t.blur();
		} else if (e.key === 'Escape') { t.value = ''; applyqqiqFilter(''); hideAllDropdowns(); t.blur(); }
	});
	sidebar.addEventListener('click', function(e) {
		var item = e.target && e.target.closest && e.target.closest('.history-dropdown-item');
		if (!item) return;
		var input = document.getElementById('qqFilterInput');
		if (input) { input.value = item.textContent; applyqqiqFilter(item.textContent); hideAllDropdowns(); input.focus(); }
	});
}

function renderPinnedDirs() {
	var recentList = document.getElementById('recentList');
	recentList.innerHTML = '';
	for (var i = 0; i < _pinnedDirs.length; i++) {
		(function(dir, idx) {
			var el = document.createElement('div'); el.className = 'recent-item';
			var del = document.createElement('span'); del.className = 'delete-button'; del.textContent = '\u00d7';
			del.addEventListener('click', function(e) { e.stopPropagation(); unpinDirectory(dir); });
			el.appendChild(del);
			var sp = document.createElement('span'); sp.textContent = dir; el.appendChild(sp);
			var moveGrp = document.createElement('span'); moveGrp.className = 'pin-move-group';
			var upBtn = document.createElement('span'); upBtn.className = 'pin-move-btn'; upBtn.textContent = '\u25B2';
			upBtn.addEventListener('click', function(e) { e.stopPropagation(); movePinnedDir(dir, 'up'); });
			var dnBtn = document.createElement('span'); dnBtn.className = 'pin-move-btn'; dnBtn.textContent = '\u25BC';
			dnBtn.addEventListener('click', function(e) { e.stopPropagation(); movePinnedDir(dir, 'down'); });
			moveGrp.appendChild(upBtn); moveGrp.appendChild(dnBtn); el.appendChild(moveGrp);
			el.addEventListener('click', function() { navigateTo(dir); });
			recentList.appendChild(el);
		})(_pinnedDirs[i], i);
	}
}

// Natural sort
function naturalCompare(a, b) {
	var re = /(\d+)|(\D+)/g;
	var aParts = String(a).match(re) || [], bParts = String(b).match(re) || [];
	var maxLen = Math.max(aParts.length, bParts.length);
	for (var i = 0; i < maxLen; i++) {
		var ap = aParts[i] || '', bp = bParts[i] || '';
		var aNum = parseInt(ap, 10), bNum = parseInt(bp, 10);
		if (!isNaN(aNum) && !isNaN(bNum)) { if (aNum !== bNum) return aNum - bNum; }
		else { if (ap !== bp) return ap < bp ? -1 : 1; }
	}
	return 0;
}

// File list
async function loadFileList(p) {
	var fileList = document.getElementById('fileList');
	fileList.innerHTML = '';
	selectedItems = []; selectedItem = null; lastSelectedItem = null;
	try {
		var isRoot = p.indexOf('\\') >= 0 ? /^[A-Za-z]:\\$/.test(p) : (p === '/' || p === '');
		if (!isRoot) {
			var parts = p.replace(/[\\/]+$/, '').split(/[\\/]/); parts.pop();
			var parentDir = parts.join(p.indexOf('\\') >= 0 ? '\\' : '/');
			if (p.indexOf('\\') >= 0 && parentDir.length === 2 && parentDir.endsWith(':')) parentDir += '\\';
			if (!parentDir && p.indexOf('\\') < 0) parentDir = '/';
			fileList.appendChild(buildFileItem({ name: '..', isDir: true, size: 0, ctimeMs: 0, mtimeMs: 0 }, parentDir));
		}
		var entries = await bridge.fs.list(p);
		entries.sort(function(a, b) {
			if (filesOnTop) { if (!a.isDir && b.isDir) return -1; if (a.isDir && !b.isDir) return 1; }
			else { if (a.isDir && !b.isDir) return -1; if (!a.isDir && b.isDir) return 1; }
			switch (sortBy) {
				case 'size': return (b.size||0) - (a.size||0);
				case 'ctime': return (b.ctimeMs||0) - (a.ctimeMs||0);
				case 'mtime': return (b.mtimeMs||0) - (a.mtimeMs||0);
				default: return naturalCompare(String(a.name), String(b.name));
			}
		});
		for (var i = 0; i < entries.length; i++) fileList.appendChild(buildFileItem(entries[i], pathJoin(p, entries[i].name)));
	} catch(err) { fileList.innerHTML = '<div style="padding:20px;color:var(--red);">' + escHtml(String(err)) + '</div>'; }
}

function buildFileItem(entry, fullPath) {
	var item = document.createElement('div');
	item.className = 'file-item';
	item.dataset.path = fullPath; item.dataset.type = entry.isDir ? 'folder' : 'file'; item.dataset.name = entry.name;

	var sz = document.createElement('div'); sz.className = 'sz-area';
	var szHtml = getSzContent(entry); if (szHtml) sz.innerHTML = szHtml;
	if (sessionSizeCache[fullPath] && szMode !== 'nothing') {
		var c = sessionSizeCache[fullPath];
		if (c.gbPart) sz.innerHTML = '<span style="color:' + SZ_GB_COLOR + '">' + c.gbPart + '</span>' + c.restPart + ' ';
		else sz.textContent = c.text;
	}
	item.appendChild(sz);

	var selectArea = document.createElement('div'); selectArea.className = 'file-select-area';
	var icon = document.createElement('span'); icon.className = 'file-icon';
	icon.textContent = entry.isDir ? '\uD83D\uDCC1' : '\uD83D\uDDC8';
	selectArea.appendChild(icon); item.appendChild(selectArea);

	if (entry.isDir) {
		var nameArea = document.createElement('div'); nameArea.className = 'folder-name-area';
		nameArea.textContent = entry.name; item.appendChild(nameArea);
	} else {
		var nameArea2 = document.createElement('div'); nameArea2.className = 'file-name-area';
		var nameSpan = document.createElement('span'); nameSpan.textContent = entry.name;
		nameArea2.appendChild(nameSpan); item.appendChild(nameArea2);
	}

	item.addEventListener('click', function(e) {
		if (entry.name === '..') { navigateTo(fullPath); return; }
		if (entry.isDir && !e.target.classList.contains('sz-area')) { navigateTo(fullPath); return; }
		selectFileItem(item, e.shiftKey);
	});
	item.addEventListener('dblclick', function(e) {
		if (!entry.isDir) { parent.postMessage({ type: 'qqq-file-open', path: fullPath }, '*'); recordDirHistory(currentPath); }
	});
	item.addEventListener('contextmenu', function(e) {
		e.preventDefault(); if (!item.classList.contains('selected')) selectFileItem(item, false);
		showContextMenu(e.clientX, e.clientY, fullPath, entry);
	});
	return item;
}

// Selection
function cancelSelection() {
	document.querySelectorAll('#fileList .file-item.selected').forEach(function(el) { el.classList.remove('selected'); });
	selectedItems = []; selectedItem = null; lastSelectedItem = null;
}
function selectFileItem(fileItem, shiftKey) {
	if (!fileItem) return;
	var type = fileItem.dataset.type, path = fileItem.dataset.path, name = fileItem.dataset.name;
	if (!shiftKey || !lastSelectedItem) {
		cancelSelection(); fileItem.classList.add('selected');
		selectedItem = { type: type, path: path, name: name }; selectedItems = [selectedItem]; lastSelectedItem = fileItem;
	} else {
		var _last = lastSelectedItem; cancelSelection();
		var all = Array.from(document.querySelectorAll('#fileList .file-item'));
		var si = all.indexOf(_last), ei = all.indexOf(fileItem);
		if (si === -1 || ei === -1) { selectFileItem(fileItem, false); return; }
		var start = Math.min(si, ei), end = Math.max(si, ei); selectedItems = [];
		for (var i = start; i <= end; i++) { var el = all[i]; el.classList.add('selected'); selectedItems.push({ type: el.dataset.type, path: el.dataset.path, name: el.dataset.name }); }
		selectedItem = { type: type, path: path, name: name }; lastSelectedItem = fileItem;
	}
}
function findItemByPath(p) { var all = document.querySelectorAll('#fileList .file-item'); for (var i = 0; i < all.length; i++) { if (all[i].dataset.path === p) return all[i]; } return null; }

// Context menu
var ctxMenu = document.getElementById('itemContextMenu'), ctxTarget = null, ctxEntry = null;

function showContextMenu(x, y, path, entry) {
	ctxTarget = path; ctxEntry = entry; ctxMenu.style.display = 'flex';
	var zw = 0.85, mw = ctxMenu.offsetWidth || 150, mh = ctxMenu.offsetHeight || 120;
	var left = x / zw, top = y / zw;
	var vw = window.innerWidth / zw, vh = window.innerHeight / zw;
	if (left + mw > vw) left = vw - mw - 4;
	if (top + mh > vh) top = y / zw - mh - 4;
	if (left < 4) left = 4; if (top < 4) top = 4;
	ctxMenu.style.left = left + 'px'; ctxMenu.style.top = top + 'px';
}
document.addEventListener('click', function() { ctxMenu.style.display = 'none'; });

ctxMenu.querySelectorAll('.context-menu-item').forEach(function(el) {
	el.addEventListener('click', function() {
		var action = el.dataset.action; if (!ctxTarget) return;
		switch (action) {
			case 'code':
				if (isBinaryFile(ctxTarget)) { alert('Binary file - cannot open in editor'); break; }
				parent.postMessage({ type: 'qqq-file-open', path: ctxTarget }, '*'); recordFileHistory(ctxTarget); break;
			case 'open':
				if (ctxEntry && ctxEntry.isDir) { navigateTo(ctxTarget); }
				else { bridge.shell.openPath(ctxTarget).catch(function() {}); recordDirHistory(currentPath); }
				break;
			case 'delete':
				if (confirm('Delete ' + baseName(ctxTarget) + '?')) { bridge.fs.remove(ctxTarget).then(function() { recordDirHistory(currentPath); loadFileList(currentPath); }); }
				break;
			case 'rename':
				if (ctxEntry && ctxEntry.name === '..') return;
				startRename(ctxTarget, baseName(ctxTarget), ctxEntry.isDir ? 'folder' : 'file'); break;
			case 'copyPath':
				bridge.clipboard.writeText(ctxTarget).catch(function() { if (navigator.clipboard) navigator.clipboard.writeText(ctxTarget).catch(function() {}); }); break;
		}
		ctxMenu.style.display = 'none';
	});
});

// SCM buttons
function updateSCMButtons() {
	document.querySelectorAll('#szModeGroup .scm-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.mode === szMode); });
	document.querySelectorAll('#sortByGroup .scm-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.sort === sortBy); });
	var fotBtn = document.getElementById('filesOnTopBtn'); if (fotBtn) fotBtn.classList.toggle('active', filesOnTop);
}
document.querySelectorAll('#szModeGroup .scm-btn').forEach(function(btn) {
	btn.addEventListener('click', function() { var m = btn.dataset.mode; szMode = (szMode === m) ? 'nothing' : m; updateSCMButtons(); fineScmSet(currentPath, szMode === 'nothing' ? null : szMode, sortBy === 'name' ? null : sortBy, filesOnTop); if (currentPath) reloadCurrentDir(); });
});
document.querySelectorAll('#sortByGroup .scm-btn').forEach(function(btn) {
	btn.addEventListener('click', function() { var s = btn.dataset.sort; sortBy = (sortBy === s) ? 'name' : s; updateSCMButtons(); fineScmSet(currentPath, szMode === 'nothing' ? null : szMode, sortBy === 'name' ? null : sortBy, filesOnTop); if (currentPath) reloadCurrentDir(); });
});
var fotBtn2 = document.getElementById('filesOnTopBtn');
if (fotBtn2) fotBtn2.addEventListener('click', function() { filesOnTop = !filesOnTop; updateSCMButtons(); fineScmSet(currentPath, szMode === 'nothing' ? null : szMode, sortBy === 'name' ? null : sortBy, filesOnTop); if (currentPath) reloadCurrentDir(); });

// Filter
var filterInput = document.getElementById('fileFilterInput');
filterInput.addEventListener('input', function() {
	var val = filterInput.value.toLowerCase();
	document.querySelectorAll('#fileList .file-item').forEach(function(item) {
		item.style.display = (!val || (item.dataset.name || '').toLowerCase().indexOf(val) >= 0) ? '' : 'none';
	});
});
filterInput.addEventListener('keydown', function(e) {
	if (e.key === 'Enter') {
		var v = filterInput.value.trim();
		if (v) { if (!_cmdHistory.fileFilter) _cmdHistory.fileFilter = []; var arr = _cmdHistory.fileFilter.filter(function(x) { return x !== v; }); arr.unshift(v); if (arr.length > 20) arr.length = 20; _cmdHistory.fileFilter = arr; _cmdHistorySave(); }
		filterInput.blur();
	}
});

// Keyboard shortcuts
(function() {
	function isInputActive() {
		var a = document.activeElement; if (!a) return false;
		var tag = a.tagName.toLowerCase();
		return tag === 'input' || tag === 'textarea' || a.isContentEditable || (a.classList && a.classList.contains('rename-input'));
	}
	document.addEventListener('keydown', function(e) {
		if (isInputActive()) return;
		var k = (e.key || '').toLowerCase();
		if (e.ctrlKey || e.metaKey) return;
		if (k === 'backspace') {
			e.preventDefault();
			if (lnkJumpFromPath) { var sp = lnkJumpFromPath; lnkJumpFromPath = null; bridge.fs.list(sp).then(function() { navigateTo(sp); }).catch(function() { lnkJumpFromPath = null; goUpOneLevel(); }); }
			else { goUpOneLevel(); }
			return;
		}
		if (k === 'escape') { cancelSelection(); return; }
		if (k === ' ' || e.key === ' ') {
			e.preventDefault();
			var _lr = [];
			if (selectedItems.length > 0) { _lr = selectedItems.filter(function(s) { return s.name !== '..'; }).map(function(s) { return { path: s.path, type: s.type }; }); }
			else { var _aitems = document.querySelectorAll('#fileList .file-item'); for (var _j = 0; _j < _aitems.length; _j++) { var _it = _aitems[_j]; if (_it.dataset.name === '..') continue; _lr.push({ path: _it.dataset.path, type: _it.dataset.type }); } }
			for (var _k = 0; _k < _lr.length; _k++) {
				var _el2 = findItemByPath(_lr[_k].path); var _sz2 = _el2 ? _el2.querySelector('.sz-area') : null;
				if (_sz2) _sz2.textContent = '    \u2022    ';
				(function(_p) {
					rpc('fs.stat', _p).then(function(_s) {
						if (!_s || _s.size === undefined) return;
						var _info = formatFileSizeEx(_s.size);
						sessionSizeCache[_p] = { text: _info.text + ' ', gbPart: _info.gbPart, restPart: _info.restPart };
						var _el3 = findItemByPath(_p); if (!_el3) return;
						var _sz3 = _el3.querySelector('.sz-area'); if (!_sz3) return;
						if (_info.gbPart) _sz3.innerHTML = '<span style="color:' + SZ_GB_COLOR + '">' + _info.gbPart + '</span>' + _info.restPart + ' ';
						else _sz3.textContent = _info.text + ' ';
					}).catch(function() {});
				})(_lr[_k].path);
			}
			return;
		}
		if (!selectedItem) return;
		var si = selectedItem;
		if (k === 'q') { e.preventDefault(); if (isBinaryFile(si.path)) { alert('Binary file'); return; } parent.postMessage({ type: 'qqq-file-open', path: si.path }, '*'); recordFileHistory(si.path); }
		else if (k === 'w') { e.preventDefault();
			if (si.type === 'folder') { navigateTo(si.path); }
			else if (si.path && /\.lnk$/i.test(si.path)) { var sd = currentPath; resolveLnkTarget(si.path).then(function(t) { if (t) { navigateTo(t); lnkJumpFromPath = sd; } else { bridge.shell.openPath(si.path).catch(function() {}); recordDirHistory(currentPath); } }); }
			else { bridge.shell.openPath(si.path).catch(function() {}); recordDirHistory(currentPath); }
		}
		else if (k === 'd') { e.preventDefault(); var tgs = selectedItems.filter(function(s) { return s.name !== '..'; }); if (!tgs.length) return; if (!confirm('Delete ' + tgs.length + ' item(s)?')) return; tgs.forEach(function(t) { var el = findItemByPath(t.path); if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; } }); Promise.all(tgs.map(function(t) { return bridge.fs.remove(t.path).catch(function(){}); })).then(function() { if (currentPath) { recordDirHistory(currentPath); loadFileList(currentPath); } }); cancelSelection(); }
		else if (k === 'e' || k === 'f2') { e.preventDefault(); if (selectedItems.length > 1) return; if (si.name === '..') return; startRename(si.path, si.name, si.type); }
		else if (k === 'z') { e.preventDefault(); var pths = selectedItems.filter(function(s) { return s.name !== '..'; }).map(function(s) { return s.path; }); if (pths.length > 0) bridge.clipboard.writeText(pths.join('\n')).catch(function(){}); }
	});
})();

// Inline rename
function startRename(itemPath, itemName, itemType) {
	var itemEl = findItemByPath(itemPath); if (!itemEl) return;
	var prevSel = document.querySelector('#fileList .file-item.selected');
	if (prevSel && prevSel !== itemEl) { if (prevSel.querySelector('.rename-input')) cancelRename(prevSel, ''); prevSel.classList.remove('selected'); }
	itemEl.classList.add('selected'); selectedItem = { type: itemType, path: itemPath, name: itemName }; selectedItems = [selectedItem]; lastSelectedItem = itemEl;
	var nameArea = itemEl.querySelector(itemType === 'file' ? '.file-name-area' : '.folder-name-area');
	if (!nameArea || nameArea.querySelector('.rename-input')) return;
	var origHTML = nameArea.innerHTML;
	var input = document.createElement('input'); input.type = 'text'; input.className = 'rename-input'; input.value = itemName;
	nameArea.innerHTML = ''; nameArea.appendChild(input); input.focus();
	if (window.qqqCharUndo && window.qqqCharUndo.attach) { window.qqqCharUndo.attach(input); window.qqqCharUndo.reset(input); }
	var dotIdx = itemName.lastIndexOf('.'); if (dotIdx > 0) input.setSelectionRange(0, dotIdx); else input.select();
	var hkd = function(e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitRename(itemEl, itemPath, itemType, input.value.trim()); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(itemEl, origHTML); } };
	var rmh = function(e) { if (e.button !== 0) return; if (input.contains(e.target) || e.target === input) return; e.preventDefault(); e.stopPropagation(); commitRename(itemEl, itemPath, itemType, input.value.trim()); };
	var rch = function(e) { e.preventDefault(); e.stopPropagation(); };
	var rwh = function(e) { e.preventDefault(); e.stopPropagation(); };
	var rmc = function(e) { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); } };
	document.addEventListener('mousedown', rmh, true); document.addEventListener('contextmenu', rch, true);
	document.addEventListener('wheel', rwh, { capture: true, passive: false }); document.addEventListener('auxclick', rmc, true);
	input.addEventListener('keydown', hkd); itemEl.dataset.originalContent = origHTML;
}

function commitRename(itemEl, oldPath, itemType, newName) {
	var input = itemEl.querySelector('.rename-input'); if (!input) return;
	var oldName = itemEl.dataset.name;
	if (newName && newName !== oldName) {
		var dir = oldPath.substring(0, oldPath.length - oldName.length);
		bridge.fs.rename(oldPath, pathJoin(dir, newName)).then(function() { if (currentPath) { recordDirHistory(currentPath); loadFileList(currentPath); } }).catch(function() { cancelRename(itemEl, itemEl.dataset.originalContent); });
	} else { cancelRename(itemEl, itemEl.dataset.originalContent); }
}

function cancelRename(itemEl, origHTML) {
	var input = itemEl.querySelector('.rename-input'); if (!input) return;
	var itemType = itemEl.dataset.type;
	var nameArea = itemEl.querySelector(itemType === 'file' ? '.file-name-area' : '.folder-name-area');
	if (nameArea) { nameArea.innerHTML = origHTML || ('<span>' + escHtml(itemEl.dataset.name) + '</span>'); }
}

function reloadCurrentDir() {
	if (!currentPath) return;
	var selPaths = selectedItems.map(function(s) { return s.path; });
	var lastPath = lastSelectedItem ? lastSelectedItem.dataset.path : null;
	loadFileList(currentPath);
	setTimeout(function() {
		var restored = false, newLast = null;
		selPaths.forEach(function(sp) { var el = findItemByPath(sp); if (el) { el.classList.add('selected'); restored = true; } if (sp === lastPath && el) newLast = el; });
		if (restored) { if (newLast) lastSelectedItem = newLast; } else { cancelSelection(); }
	}, 50);
}

// Drives
var _driveList = [], _drivePollingTimer = null;
async function loadDrives() {
	var driveList = document.getElementById('driveList'); driveList.innerHTML = '';
	try { _driveList = await rpc('fs.drives'); } catch(e) { _driveList = []; }
	if (_driveList.length === 0) _driveList = ['C:\\'];
	for (var i = 0; i < _driveList.length; i++) {
		(function(d) { var letter = d.charAt(0); var btn = document.createElement('button'); btn.className = 'nav-item'; btn.id = 'drive-' + letter + '-btn'; btn.textContent = letter + ':\\ '; btn.title = d; btn.addEventListener('click', function() { navigateTo(d); }); driveList.appendChild(btn); })(_driveList[i]);
	}
	var deskBtn = document.createElement('button'); deskBtn.className = 'nav-item'; deskBtn.id = 'drive-DESKTOP-btn'; deskBtn.textContent = 'Desktop';
	deskBtn.addEventListener('click', function() { rpc('boot.getInfo').then(function(info) { navigateTo((info && info.homedir || 'C:\\Users\\Default') + '\\Desktop'); }).catch(function() {}); });
	driveList.appendChild(deskBtn);
	var recycleBtn = document.createElement('button'); recycleBtn.className = 'nav-item'; recycleBtn.id = 'drive-RECYCLE-btn'; recycleBtn.textContent = 'Recycle Bin'; driveList.appendChild(recycleBtn);
	setTimeout(updateDriveDisplay, 200);
	if (_drivePollingTimer) clearInterval(_drivePollingTimer);
	_drivePollingTimer = setInterval(updateDriveDisplay, 30000);
}
async function updateDriveDisplay() {
	try {
		var info = await rpc('fs.diskFree', _driveList);
		for (var i = 0; i < _driveList.length; i++) {
			var letter = _driveList[i].charAt(0), btn = document.getElementById('drive-' + letter + '-btn'); if (!btn) continue;
			var data = info[letter]; if (!data) { btn.textContent = letter + ':\\ '; continue; }
			btn.textContent = letter + ':\\ ' + (data.free / (1024*1024*1024)).toFixed(1) + ' GB';
			var pct = data.total > 0 ? (data.free / data.total) : 1;
			btn.style.color = (pct < 0.01 || data.free < 2*1024*1024*1024) ? 'var(--red)' : '';
		}
		if (info['DESKTOP']) { var db2 = document.getElementById('drive-DESKTOP-btn'); if (db2) db2.textContent = 'Desktop  ' + (info['DESKTOP'].used / (1024*1024)).toFixed(0) + ' MB'; }
		if (info['RECYCLE'] && info['RECYCLE'].used > 0) { var rb = document.getElementById('drive-RECYCLE-btn'); if (rb) rb.textContent = 'Recycle Bin  ' + (info['RECYCLE'].used / (1024*1024)).toFixed(0) + ' MB'; }
	} catch(e) {}
}

// Sidebar resizer
(function() {
	var resizer = document.getElementById('sidebarResizer'), sidebar = document.getElementById('sidebar'), content = document.getElementById('kyContent');
	var dragging = false, startX = 0, startW = 0;
	resizer.addEventListener('mousedown', function(e) { e.preventDefault(); dragging = true; startX = e.clientX; startW = sidebarW; resizer.classList.add('active'); document.addEventListener('mousemove', om); document.addEventListener('mouseup', ou); });
	function om(e) { if (!dragging) return; sidebarW = Math.max(60, Math.min(400, startW + e.clientX - startX)); sidebar.style.width = sidebarW + 'px'; resizer.style.left = sidebarW + 'px'; content.style.left = (sidebarW + 8) + 'px'; }
	function ou() { dragging = false; resizer.classList.remove('active'); document.removeEventListener('mousemove', om); document.removeEventListener('mouseup', ou); _sidebarSave(); }
})();

// New file/folder
var filenameInput = document.getElementById('filenameInput');
if (window.qqqCharUndo && window.qqqCharUndo.attach) { window.qqqCharUndo.attach(filenameInput); }
function _newFileTemplate() { var l = []; for (var i = 0; i < 222; i++) l.push(''); return l.join('\n'); }
function _nameExists(name) { var all = document.querySelectorAll('#fileList .file-item'); for (var i = 0; i < all.length; i++) { if ((all[i].dataset.name || '').toLowerCase() === name.toLowerCase()) return true; } return false; }
function doCreateFile() { var name = filenameInput.value.trim(); if (!name) { filenameInput.focus(); return; } if (_nameExists(name)) { if (!confirm('"' + name + '" already exists. Overwrite?')) return; } var fp = pathJoin(currentPath, name); bridge.fs.write(fp, _newFileTemplate()).then(function() { filenameInput.value = ''; if (window.qqqCharUndo && window.qqqCharUndo.reset) window.qqqCharUndo.reset(filenameInput); recordDirHistory(currentPath); loadFileList(currentPath); parent.postMessage({ type: 'qqq-file-open', path: fp }, '*'); }).catch(function(err) { alert('Failed to create file: ' + (err.message || err)); }); }
function doCreateFolder() { var name = filenameInput.value.trim(); if (!name) { filenameInput.focus(); return; } if (_nameExists(name)) { if (!confirm('"' + name + '" already exists. Overwrite?')) return; } var fp = pathJoin(currentPath, name); bridge.fs.mkdir(fp).then(function() { filenameInput.value = ''; if (window.qqqCharUndo && window.qqqCharUndo.reset) window.qqqCharUndo.reset(filenameInput); recordDirHistory(currentPath); loadFileList(currentPath); }).catch(function(err) { alert('Failed to create folder: ' + (err.message || err)); }); }
filenameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); doCreateFile(); } });
document.getElementById('btnNewFile').addEventListener('click', doCreateFile);
document.getElementById('btnNewFolder').addEventListener('click', doCreateFolder);

// Responsive
var MIN_ADDRESS_RW = 340, MIN_SZ_RW = 200, MIN_FOOTER_W = 240, MIN_FOOTER_EXTREME = 170;
function checkAndApplyResponsive() {
	var container = document.querySelector('.container'); if (!container) return;
	var pageW = container.clientWidth;
	var footer = document.querySelector('.footer'); var saveBtn = footer ? footer.querySelector('.save-button') : null; var cancelBtn = footer ? footer.querySelector('.cancel-button') : null;
	if (saveBtn) saveBtn.style.display = (pageW < MIN_FOOTER_W) ? 'none' : ''; if (cancelBtn) cancelBtn.style.display = (pageW < MIN_FOOTER_EXTREME) ? 'none' : '';
	if (footer) { footer.classList.toggle('responsive-narrow', pageW < MIN_FOOTER_W); footer.classList.toggle('responsive-extreme', pageW < MIN_FOOTER_EXTREME); }
	var kyContent = document.getElementById('kyContent');
	if (kyContent) { var rw = kyContent.clientWidth; var sb2 = document.getElementById('sortByGroup'); if (sb2) sb2.style.display = (rw < MIN_ADDRESS_RW) ? 'none' : ''; var fb = document.getElementById('filesOnTopBtn'); if (fb) fb.style.display = (rw < MIN_ADDRESS_RW) ? 'none' : ''; var fiw = document.querySelector('.filter-input-wrapper'); if (fiw) fiw.style.display = (rw < MIN_ADDRESS_RW) ? 'none' : ''; var ob = document.getElementById('openFolderBtn'); if (ob) ob.style.display = (rw < MIN_ADDRESS_RW) ? 'none' : ''; var sm = document.getElementById('szModeGroup'); if (sm) sm.style.display = (rw < MIN_SZ_RW) ? 'none' : ''; }
	setTimeout(calculateAndAdjustScroll, 50);
}
var _baseRecentHeight = 0;
function calculateAndAdjustScroll() { var rs = document.querySelector('.recent-section'), kc = document.getElementById('kyContent'), ab = document.querySelector('.address-bar'); if (!rs || !ab || !kc) return; var eh = window.innerHeight - 60; if (!_baseRecentHeight && rs.style.display !== 'none') _baseRecentHeight = rs.offsetHeight || rs.scrollHeight || 0; rs.style.display = (eh < (_baseRecentHeight || rs.offsetHeight || 0) + (ab.offsetHeight || 0) + 100) ? 'none' : ''; }
(function() { var c2 = document.querySelector('.container'); if (!c2) return; if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function() { checkAndApplyResponsive(); }).observe(c2); else window.addEventListener('resize', checkAndApplyResponsive); })();

// Boot
(async function boot() {
	var f = await _roamGet('roam.fineScm'); if (f && typeof f === 'object') _fineScm = f;
	var q = await _roamGet('roam.qqiq'); if (Array.isArray(q)) _qqiq = q;
	var p = await _roamGet('roam.pinnedDirs'); if (Array.isArray(p)) _pinnedDirs = p;
	var h = await _roamGet('roam.cmdHistory'); if (h && typeof h === 'object') _cmdHistory = h;
	var prefs = await _roamGet('roam.prefs');
	if (prefs && typeof prefs === 'object') { if (typeof prefs.lineSpacing === 'number') _lineSpacing = prefs.lineSpacing; if (prefs.globalSzMode) _globalSzMode = prefs.globalSzMode; if (prefs.globalSortBy) _globalSortBy = prefs.globalSortBy; }
	try { var sw = await bridge.store.getLocal('roam.sidebarWidth'); if (typeof sw === 'number' && sw > 50 && sw < 500) { sidebarW = sw; applySidebarWidth(); } } catch(e) {}
	var bootInfo = {}; try { bootInfo = parent.qqqBootInfo || {}; } catch(e) {}
	if (!bootInfo.cwd) { try { bootInfo = await rpc('boot.getInfo'); } catch(e) {} }
	var root = bootInfo.cwd || bootInfo.workingDir || '.';
	var lastDir = await _roamGet('roam.lastVisitedDir');
	if (lastDir && typeof lastDir === 'string') { try { await bridge.fs.list(lastDir); root = lastDir; } catch(e) {} }
	await loadDrives(); renderQqiqSection(); renderPinnedDirs(); initQqFilter(); navigateTo(root); updateSCMButtons(); checkAndApplyResponsive();
	try { if (parent && parent.qqqideKeyHookAdapter && parent.qqqideKeyHookAdapter.attach) parent.qqqideKeyHookAdapter.attach({ scope: 'iframe:roam', swallow: true }); } catch(e) {}
	window.addEventListener('message', function(e) { if (!e.data || e.data.type !== 'qqq-roam-cmd') return; document.dispatchEvent(new CustomEvent('qqq-roam-cmd', { detail: { cmd: e.data.cmd } })); });
})();

})();
