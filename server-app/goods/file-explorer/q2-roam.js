// ============================================================================
// q2-roam.js — core logic: state, fs ops, selection, context menus
// Split from q2-roam.js (2026-08-04). Load order: q2-roam.js -> q2-roam-ui.js -> q2-roam-boot.js
// ============================================================================
// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

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
    if (e.data && e.data.type === 'qqqide-theme-change') {
      if (e.data.dark) document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
    }
    // ★ Roam 跨窗口同步: 其他窗口改了 OS 级数据 → 重载对应 key
    if (e.data && e.data.type === 'qqqide-roam-changed') {
      _onRoamChanged(e.data.key, e.data.value);
    }
});

// ★ OS 级持久化: 优先 parent.qqqideBridge.roam (OS 级 roam.sq3, 跨窗口唯一真理)
//   降级: parent.qgs.simple('roam') (旧 per-green-pack, 迁移用)
//   兜底: bridge.store RPC
var _roamOsBridge = null;
function _roamOs() {
	if (_roamOsBridge) return _roamOsBridge;
	try {
		if (parent && parent.qqqideBridge && parent.qqqideBridge.roam) {
			_roamOsBridge = parent.qqqideBridge.roam;
			return _roamOsBridge;
		}
	} catch(e) {}
	return null;
}
var _roamOldDb = null;
function _roamOld() {
	if (_roamOldDb) return _roamOldDb;
	try {
		if (parent && parent.qgs && parent.qgs.simple) {
			_roamOldDb = parent.qgs.simple('roam');
			return _roamOldDb;
		}
	} catch(e) {}
	return null;
}
var _roamMigrated = false;
async function _roamMigrateIfNeeded() {
	if (_roamMigrated) return;
	_roamMigrated = true;
	var os = _roamOs();
	var old = _roamOld();
	if (!os || !old) return;
	try {
		// 检查 OS 级是否已有数据
		var existing = await os.getAll();
		if (existing && Object.keys(existing).length > 0) return; // 已有数据，不覆盖
		// 从旧 per-green-pack 迁移
		var oldKeys = ['roam.fineScm','roam.qqiq','roam.pinnedDirs','roam.cmdHistory','roam.prefs','roam.lastVisitedDir','roam.sidebarWidth'];
		for (var i = 0; i < oldKeys.length; i++) {
			try {
				var val = await old.get(oldKeys[i]);
				if (val !== null && val !== undefined) {
					await os.set(oldKeys[i], val);
				}
			} catch(e) { /* skip */ }
		}
		console.log('[roam] migrated from per-green-pack → OS-level roam.sq3');
	} catch(e) { console.warn('[roam] migration skipped:', e); }
}
async function _roamGet(key) {
	// OS 级优先
	var os = _roamOs();
	if (os) {
		try { return await os.get(key); } catch(e) { console.warn('[roam] OS get failed:', key, e); }
	}
	// 降级: 旧 per-green-pack
	var old = _roamOld();
	if (old) {
		try { return await old.get(key); } catch(e) { console.warn('[roam] old get failed:', key, e); }
	}
	// 兜底: RPC
	try { return await bridge.store.get(key); } catch(e) { return null; }
}
function _roamSet(key, value) {
	var os = _roamOs();
	if (os) {
		os.set(key, value).catch(function(e) { console.warn('[roam] OS set failed:', key, e); });
		return;
	}
	// 降级: RPC
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
		stat: (p) => rpc('fs.stat', p),
		copyFile: (src, dest) => rpc('fs.copyFile', { __spread: true, args: [src, dest] }),
	},
	clipboard: {
		writeText: (s) => rpc('clipboard.writeText', s),
		probe: () => rpc('clipboard.probe'),
		readFiles: () => rpc('clipboard.readFiles'),
		writeFiles: (paths) => rpc('clipboard.writeFiles', paths),
		readImage: () => rpc('clipboard.readImage'),
	},
	shell: {
		openPath: (p) => rpc('shell.openPath', p),
		openTerminal: (p, t) => rpc('shell.openTerminal', { __spread: true, args: [p, t] }),
		openRecycleBin: () => rpc('shell.openRecycleBin'),
		openExternal: (url) => rpc('shell.openExternal', url),
	},
	store: {
		get: (k) => rpc('store.get', k),
		set: (k, v) => rpc('store.set', { key: k, value: v }),
		getLocal: (k) => rpc('store.getLocal', k),
		setLocal: (k, v) => rpc('store.setLocal', { key: k, value: v }),
	},
	roam: {
		get: (k) => rpc('roam.get', k),
		set: (k, v) => rpc('roam.set', { __spread: true, args: [k, v] }),
		getAll: () => rpc('roam.getAll'),
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
  } catch(e) { parent.postMessage({ type: 'qqqide-theme-request' }, '*'); }
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
var _cmdHistory = { address: [], fileFilter: [], qqFilter: [] };
var _lineSpacing = -2;
var FINE_SCM_MAX = 500;
var sessionSizeCache = {};   // ★ 仅会话内: Space 强制尺寸, 切目录/切 SCM 模式即清空 (q3 对齐, 不持久化)
var _lastRenderedDir = null;  // 上次渲染目录 — 用于强制尺寸失效判定
var _lastRenderSzMode = null; // 上次渲染 SCM 模式 — 用于强制尺寸失效判定

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
function _applyLineSpacing() {
	try { document.documentElement.style.setProperty('--roam-ls', _lineSpacing + 'px'); } catch(e) {}
}
function _qqiqSave() { _roamSet('roam.qqiq', _qqiq); }
function _pinnedSave() { _roamSet('roam.pinnedDirs', _pinnedDirs); }
function _historySave() { _roamSet('roam.lastVisitedDir', currentPath); }
function _cmdHistorySave() { _roamSet('roam.cmdHistory', _cmdHistory); }
function _sidebarSave() { _roamSet('roam.sidebarWidth', sidebarW); }
// ★ 跨窗口同步: 其他窗口改了 OS 级数据 → 重载对应 key
function _onRoamChanged(key, value) {
	if (value === undefined || value === null) return;
	switch (key) {
		case 'roam.fineScm': if (typeof value === 'object') _fineScm = value; break;
		case 'roam.qqiq': if (Array.isArray(value)) { _qqiq = value; renderQqiqSection(); } break;
		case 'roam.pinnedDirs': if (Array.isArray(value)) _pinnedDirs = value; break;
		case 'roam.cmdHistory': if (value && typeof value === 'object') _cmdHistory = value; break;
		case 'roam.prefs':
			if (value && typeof value === 'object') {
				if (typeof value.lineSpacing === 'number') _lineSpacing = value.lineSpacing;
				if (value.globalSzMode) _globalSzMode = value.globalSzMode;
				if (value.globalSortBy) _globalSortBy = value.globalSortBy;
			}
			_applyLineSpacing();
			break;
		case 'roam.lastVisitedDir': if (typeof value === 'string') {} break;
		case 'roam.sidebarWidth':
			if (typeof value === 'number' && value > 50 && value < 500) { sidebarW = value; applySidebarWidth(); }
			break;
	}
}
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

// ---- Binary detection (from q3, enhanced: no false-positive on .ts/.js/.py) ----
var _KNOWN_BINARY_EXTS = {
	'.png':1, '.jpg':1, '.jpeg':1, '.gif':1, '.bmp':1, '.webp':1, '.ico':1, '.svg':1, '.tif':1, '.tiff':1,
	'.mp3':1, '.mp4':1, '.avi':1, '.mov':1, '.mkv':1, '.wmv':1, '.flv':1, '.webm':1, '.ogg':1, '.wav':1, '.flac':1, '.aac':1, '.m4a':1, '.wma':1, '.opus':1,
	'.exe':1, '.dll':1, '.so':1, '.dylib':1, '.bin':1, '.sys':1, '.ocx':1, '.drv':1,
	'.zip':1, '.tar':1, '.gz':1, '.bz2':1, '.7z':1, '.rar':1, '.xz':1, '.lz4':1, '.zst':1,
	'.pdf':1, '.doc':1, '.docx':1, '.xls':1, '.xlsx':1, '.ppt':1, '.pptx':1,
	'.psd':1, '.ai':1, '.ttf':1, '.otf':1, '.woff':1, '.woff2':1, '.eot':1,
	'.db':1, '.sqlite':1, '.sq3':1, '.mdb':1,
};
// Known text extensions (whitelist, never binary)
var _KNOWN_TEXT_EXTS = {
	'.txt':1, '.md':1, '.js':1, '.mjs':1, '.cjs':1, '.ts':1, '.tsx':1, '.jsx':1, '.json':1, '.jsonc':1,
	'.html':1, '.htm':1, '.css':1, '.scss':1, '.less':1, '.xml':1, '.svg':1, '.yml':1, '.yaml':1,
	'.py':1, '.pyw':1, '.rs':1, '.go':1, '.c':1, '.h':1, '.cpp':1, '.hpp':1, '.cc':1, '.java':1,
	'.rb':1, '.php':1, '.pl':1, '.pm':1, '.sh':1, '.bash':1, '.zsh':1, '.bat':1, '.cmd':1, '.ps1':1,
	'.sql':1, '.r':1, '.lua':1, '.swift':1, '.kt':1, '.kts':1, '.dart':1, '.scala':1, '.clj':1,
	'.toml':1, '.ini':1, '.cfg':1, '.conf':1, '.log':1, '.csv':1, '.tsv':1,
	'.vue':1, '.svelte':1, '.astro':1, '.gitignore':1, '.dockerfile':1, '.env':1,
};
function isBinaryByName(name) {
	if (!name) return false;
	var n = name.toLowerCase();
	var dot = n.lastIndexOf('.');
	if (dot === -1) return false;
	var ext = n.substring(dot);
	if (_KNOWN_TEXT_EXTS[ext]) return false;
	if (_KNOWN_BINARY_EXTS[ext]) return true;
	return null;
}
// Content-based check: read first 512 bytes, look for null bytes
async function isBinaryByContent(filePath) {
	try { var d = await bridge.fs.read(filePath); if (!d) return false;
		var n = Math.min(d.length, 512); for (var i = 0; i < n; i++) if (d.charCodeAt(i) === 0) return true;
		return false;
	} catch(e) { return false; }
}
// Combined: ext whitelist > ext blacklist > null-byte content check
async function isProbablyBinary(entry) {
	if (!entry || entry.isDir) return false;
	var byName = isBinaryByName(entry.name);
	if (byName !== null) return byName;
	return await isBinaryByContent(entry.path);
}

// ---- Sound effects (from q3) ----
function _playSfx(name) {
	try { parent.postMessage({ type: 'qqq-sfx', name: name }, '*'); } catch(e) {}
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
// 2026-08-05 性能: 格式化缓存(纯函数,同输入必同输出). Cap 800 entries 防泄漏
var _fmtCacheSz = {}, _fmtCacheDate = {}, _fmtCacheCount = 0;
function addThousandSep(num) {
	var s = String(Math.floor(num)), parts = [];
	for (var i = s.length; i > 0; i -= 3) parts.unshift(s.slice(Math.max(0, i - 3), i));
	return parts.join(',');
}
function formatFileSizeEx(bytes) {
	if (_fmtCacheSz[bytes]) return _fmtCacheSz[bytes];
	var formatted = addThousandSep(bytes);
	var result;
	if (bytes >= SZ_GB_THRESHOLD) {
		var parts = formatted.split(',');
		if (parts.length >= 4) {
			var gbParts = parts.slice(0, parts.length - 3);
			var restParts = parts.slice(parts.length - 3);
			result = { text: formatted, gbPart: gbParts.join(','), restPart: ',' + restParts.join(',') };
		} else { result = { text: formatted, gbPart: '', restPart: '' }; }
	} else { result = { text: formatted, gbPart: '', restPart: '' }; }
	_fmtCacheSz[bytes] = result;
	if (++_fmtCacheCount > 800) { _fmtCacheSz = {}; _fmtCacheDate = {}; _fmtCacheCount = 0; }
	return result;
}
function formatDateTime(date) {
	if (!date) return '';
	if (_fmtCacheDate[date]) return _fmtCacheDate[date];
	var d = new Date(date);
	if (isNaN(d.getTime())) return '';
	var y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
	var h = String(d.getHours()).padStart(2, '0'), mi = String(d.getMinutes()).padStart(2, '0');
	var result = y + '.' + mo + '.' + da + ' ' + h + ':' + mi;
	_fmtCacheDate[date] = result;
	if (++_fmtCacheCount > 800) { _fmtCacheSz = {}; _fmtCacheDate = {}; _fmtCacheCount = 0; }
	return result;
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
	var abi = document.getElementById('addressBarInner'); if (abi) abi.setAttribute('data-tooltip', p || '');
	loadFileList(p);
	// ★ 纯浏览不记录 qq 区——与 q3 一致：只有做实际操作（新建/删除/重命名/Q编辑/W系统打开）才进 qq 区
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
// 键入: base64 编码的 .lnk 文件内容
// 输出: { candidates: [...], ansiPath: '...' } — candidates 按优先级排序（Unicode 来源优先）
// ★ 关键教训（q3 已验证）: 解析阶段不做存在性判断（浏览器无 fs.existsSync），
//   交由 resolveLnkTarget 用 bridge.fs.stat 异步校验——与 q3 的 fs.existsSync 完全等价。
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

		var candidates = [];
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

					// ① Unicode 路径（header size >= 0x24）—— 最优先
					if (linkInfoHeaderSize >= 0x24 && offset + 32 <= buf.length) {
						var unicodeOffset = uint32LE(offset + 28);
						if (unicodeOffset > 0 && unicodeOffset < linkInfoSize) {
							var uStart = linkInfoStart + unicodeOffset;
							var uEnd = uStart;
							while (uEnd + 1 < buf.length && !(buf[uEnd] === 0 && buf[uEnd + 1] === 0)) uEnd += 2;
							if (uEnd > uStart) {
								var utf16 = '';
								for (var j = uStart; j < uEnd; j += 2) utf16 += String.fromCharCode(buf[j] | (buf[j+1]<<8));
								if (utf16 && utf16.length > 2) candidates.push(utf16);
							}
						}
					}

					// ② ANSI 路径（先收集，不立即返回——中文系统 GBK→Latin-1=乱码）
					if (localBasePathOffset > 0 && localBasePathOffset < linkInfoSize) {
						var aStart = linkInfoStart + localBasePathOffset;
						var aEnd = aStart;
						while (aEnd < buf.length && buf[aEnd] !== 0) aEnd++;
						if (aEnd > aStart) {
							ansiPath = '';
							for (var k = aStart; k < aEnd; k++) ansiPath += String.fromCharCode(buf[k]);
							// 纯 ASCII 路径直接进 candidates（高优先级）
							if (ansiPath && ansiPath.length > 2 && /^[A-Z]:\\.+/.test(ansiPath) && !/[^\x00-\x7F]/.test(ansiPath)) {
								candidates.push(ansiPath);
							}
						}
					}
				}
			}
		}

		// ③ 兜底: 扫描整个文件找 Unicode 路径模式 "X:\"（[A-Z] 00 3A 00 5C 00）
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
					if (path16 && path16.length > 3 && /^[A-Z]:\\.+/.test(path16)) candidates.push(path16);
				}
			}
		}

		return { candidates: candidates, ansiPath: ansiPath };
	} catch(_) { return null; }
}

// 异步解析 .lnk 文件，返回目标路径或 null
// ★ 与 q3 parseLnkTarget 完全等价：解析所有候选路径，用 bridge.fs.stat 逐个校验（= q3 的 fs.existsSync）
async function resolveLnkTarget(lnkPath) {
	try {
		var b64 = await bridge.fs.readBase64(lnkPath);
		if (!b64) return null;
		var result = parseLnkTargetFromBase64(b64);
		if (!result) return null;

		// q3 核心逻辑：fs.existsSync 逐候选校验（浏览器用 bridge.fs.stat 异步等价）
		var cands = result.candidates || [];
		for (var i = 0; i < cands.length; i++) {
			try {
				var st = await bridge.fs.stat(cands[i]);
				if (st) return cands[i];
			} catch(_) {}
		}

		// ANSI 路径（含中文会乱码→stat 返回 null→自然跳过）
		if (result.ansiPath && result.ansiPath.length > 2) {
			try {
				var st2 = await bridge.fs.stat(result.ansiPath);
				if (st2) return result.ansiPath;
			} catch(_) {}
		}

		// 最后兜底：返回 ANSI 路径（即使不存在，与 q3 行为一致）
		return result.ansiPath;
	} catch(_) { return null; }
}

// ---- qqiq & pinnedDirs (client-side, persisted via store) ----
var QQ_IQ_DISPLAY = 33;   // 默认显示条数
var QQ_IQ_MAX = 400;       // 数据库保存上限（find 从这 400 条里搜）
var QQ_PIN_MAX = 6;

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
	var oldFc = driveList.querySelector('.qq-filter-container'); if (oldFc) oldFc.remove();
	var oldSec = driveList.querySelector('.qq-iq-section'); if (oldSec) oldSec.remove();
	if (_qqiq.length === 0) return;
	// Divider
	var divEl = document.createElement('div'); divEl.className = 'divider'; driveList.appendChild(divEl);
	// ★ 筛选框永远显示
	var fc = document.createElement('div');
	fc.className = 'qq-filter-container';
	fc.innerHTML = '<input type="text" class="qq-filter-input" id="qqFilterInput" placeholder="find" spellcheck="false"><div id="qqFilterHistoryDropdown" class="history-dropdown"></div>';
	driveList.appendChild(fc);
	// ★ 渲染全部条目（上限 QQ_IQ_MAX），超出 QQ_IQ_DISPLAY 的初始隐藏
	//    筛选时由 applyqqiqFilter 在 DOM 内原地 show/hide，不重建键入框
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
		// ★ 文件 tooltip: 黑色背景白色文字，最后反斜杠红色加粗
		var lastBS = item.path.lastIndexOf('\\');
		var tooltipHtml;
		if (lastBS !== -1) {
			tooltipHtml = _escAttr(item.path.substring(0, lastBS))
				+ ' <span style="font-weight:bold;color:#dc322f;">\\</span> '
				+ _escAttr(item.path.substring(lastBS + 1));
		} else {
			tooltipHtml = _escAttr(item.path);
		}
		el.setAttribute('data-tooltip', tooltipHtml);
		el.setAttribute('data-use-html', 'true');

		var text = document.createElement('span');
		text.className = 'qq-text'; text.textContent = fileName;
		el.appendChild(text);
		el.addEventListener('click', function() {
			parent.postMessage({ type: 'qqq-file-open', path: item.path }, '*');
			recordFileHistory(item.path);
		});
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

// ★ qq 筛选器：原地过滤 DOM（不重建，不破坏键入框焦点）；AND 多词模糊匹配
function applyqqiqFilter(keyword) {
	var section = document.querySelector('.qq-iq-section');
	if (!section) return;
	var kw = (keyword || '').trim().toLowerCase();
	var terms = kw ? kw.split(/\s+/).filter(Boolean) : [];
	var items = section.querySelectorAll('.qq-item');
	for (var i = 0; i < items.length; i++) {
		var item = items[i];
		if (terms.length === 0) {
			// 无筛选：前 QQ_IQ_DISPLAY 显示，其余隐藏
			item.style.display = (i < QQ_IQ_DISPLAY) ? '' : 'none';
			continue;
		}
		// AND 多词模糊匹配：在 data-fullpath + textContent 中搜索
		var fullpath = (item.getAttribute('data-fullpath') || '').toLowerCase();
		var text = (item.textContent || '').toLowerCase();
		var hay = fullpath + ' ' + text;
		var match = true;
		for (var t = 0; t < terms.length; t++) {
			if (hay.indexOf(terms[t]) === -1) { match = false; break; }
		}
		item.style.display = match ? '' : 'none';
	}
}

// ---- 下拉框工具函数 ----
function hideAllDropdowns() {
	var dds = document.querySelectorAll('.history-dropdown');
	for (var i = 0; i < dds.length; i++) dds[i].style.display = 'none';
}

function showFilterHistory(inputEl, key) {
	hideAllDropdowns();
	if (document.activeElement !== inputEl) return;
	var hist = _cmdHistory[key] || [];
	if (!hist.length) return;
	var dd = document.getElementById(key === 'qqFilter' ? 'qqFilterHistoryDropdown' : 'fileFilterHistoryDropdown');
	if (!dd) return;
	dd.innerHTML = '';
	for (var i = 0; i < hist.length; i++) {
		var div = document.createElement('div');
		div.className = 'history-dropdown-item';
		div.textContent = hist[i];
		dd.appendChild(div);
	}
	dd.style.display = 'block';
}

// ★ 初始化 qq 筛选框事件
function initQqFilter() {
	var sidebar = document.querySelector('.sidebar');
	if (!sidebar) return;

	// input → 筛选 + 隐藏下拉
	sidebar.addEventListener('input', function(e) {
		var t = e.target;
		if (!t || t.id !== 'qqFilterInput') return;
		hideAllDropdowns();
		applyqqiqFilter(t.value);
		if (t.value === '') showFilterHistory(t, 'qqFilter');
	});

	// focus → 空时显示历史
	sidebar.addEventListener('focusin', function(e) {
		var t = e.target;
		if (!t || t.id !== 'qqFilterInput') return;
		if (t.value === '') showFilterHistory(t, 'qqFilter');
	});

	// blur → 隐藏下拉
	sidebar.addEventListener('focusout', function(e) {
		var t = e.target;
		if (!t || t.id !== 'qqFilterInput') return;
		setTimeout(function() { hideAllDropdowns(); }, 120);
	});

	// mousedown on dropdown → 防失焦
	sidebar.addEventListener('mousedown', function(e) {
		if (e.target && e.target.closest && e.target.closest('#qqFilterHistoryDropdown')) e.preventDefault();
	});

	// keydown → Enter/Escape
	sidebar.addEventListener('keydown', function(e) {
		var t = e.target;
		if (!t || t.id !== 'qqFilterInput') return;
		if (e.key === 'Enter') {
			var val = t.value.trim();
			if (val) {
				var arr = _cmdHistory.qqFilter.filter(function(x) { return x !== val; });
				arr.unshift(val); if (arr.length > 20) arr.length = 20;
				_cmdHistory.qqFilter = arr; _cmdHistorySave();
			}
			hideAllDropdowns(); t.blur();
		} else if (e.key === 'Escape') {
			t.value = ''; applyqqiqFilter(''); hideAllDropdowns(); t.blur();
		}
	});

	// click on dropdown item
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
			var el = document.createElement('div');
			el.className = 'recent-item';
			var del = document.createElement('span');
			del.className = 'delete-button'; del.textContent = '\u00d7';
			del.addEventListener('click', function(e) { e.stopPropagation(); unpinDirectory(dir); });
			el.appendChild(del);
			var sp = document.createElement('span'); sp.textContent = dir;
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

// ★ 自然排序：数字部分按数值比较，大小写不敏感（匹配 Windows readdir 原生顺序）
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
			var apLower = ap.toLowerCase();
			var bpLower = bp.toLowerCase();
			if (apLower !== bpLower) return apLower < bpLower ? -1 : 1;
			if (ap !== bp) return ap < bp ? -1 : 1;
		}
	}
	return 0;
}

// ---- Load file list ----
async function loadFileList(p) {
	// ★ q3 对齐: Space 强制尺寸仅会话内有效 — 切换目录或 SCM 模式 → 立即丢失强制
	if (p !== _lastRenderedDir || szMode !== _lastRenderSzMode) {
		sessionSizeCache = {};
		_sRequestVersion++; // 取消在途 sRequest, 防旧结果回填新渲染
	}
	_lastRenderedDir = p;
	_lastRenderSzMode = szMode;
	var fileList = document.getElementById('fileList');
	fileList.innerHTML = '';
	var frag = document.createDocumentFragment(); // ★ 2026-08-04: 批量插入一次 layout
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
			var parentEntry = { name: '..', isDir: true, size: 0, ctimeMs: 0, mtimeMs: 0 };
		frag.appendChild(buildFileItem(parentEntry, parentDir));
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
			case 'ctime': return (b.ctimeMs||0) - (a.ctimeMs||0);
			case 'mtime': return (b.mtimeMs||0) - (a.mtimeMs||0);
			default: return naturalCompare(String(a.name), String(b.name));
			}
		});
		for (var i = 0; i < entries.length; i++) {
			frag.appendChild(buildFileItem(entries[i], pathJoin(p, entries[i].name)));
		}
		fileList.appendChild(frag); // ★ 一次性插入，单次 layout
	} catch(err) {
		fileList.innerHTML = '<div style="padding:20px;color:var(--red);">' + escHtml(String(err)) + '</div>';
	}
}

// 2026-08-05 性能: 预建 template, cloneNode 替代 createElement 链 (N×5 DOM API→N×1)
var _folderTpl = document.createElement('template');
_folderTpl.innerHTML = '<div class="sz-area"></div><div class="file-select-area"><span class="file-icon">📁</span></div><div class="folder-name-area"></div>';
var _fileTpl = document.createElement('template');
_fileTpl.innerHTML = '<div class="sz-area"></div><div class="file-name-area"><span class="file-icon">🗈</span><span></span></div>';

function buildFileItem(entry, fullPath) {
	var item = document.createElement('div');
	item.className = 'file-item';
	item.dataset.path = fullPath;
	item.dataset.type = entry.isDir ? 'folder' : 'file';
	item.dataset.name = entry.name;

	var clone = document.importNode(entry.isDir ? _folderTpl.content : _fileTpl.content, true);

	// sz area — HTML mode for red GB
	var sz = clone.querySelector('.sz-area');
	var szHtml = getSzContent(entry);
	if (szHtml) sz.innerHTML = szHtml;
	if (sessionSizeCache[fullPath] && szMode !== 'nothing') {
		var c = sessionSizeCache[fullPath];
		if (c.gbPart) sz.innerHTML = '<span style="color:' + SZ_GB_COLOR + '">' + c.gbPart + '</span>' + c.restPart + ' ';
		else sz.textContent = c.text;
	}

	if (entry.isDir) {
		clone.querySelector('.folder-name-area').textContent = entry.name;
	} else {
		clone.querySelector('.file-name-area > span:last-child').textContent = ' ' + entry.name;
	}

	item.appendChild(clone);

	// ★ 2026-08-04 性能修复：不再每项绑定 click/contextmenu（大目录 N×2 监听），
	//   改为容器级事件委托（见 buildFileItem 之后 _fileListEl 委托绑定）

	return item;
}

// ★ 容器级事件委托（2026-08-04 性能修复）：替代每项 2 个 listener
var _fileListEl = document.getElementById('fileList');
if (_fileListEl) {
	_fileListEl.addEventListener('click', function(e) {
		var itemEl = e.target.closest('.file-item');
		if (!itemEl) {
			// ★ 点击空白取消选中（q3 对齐）：若正在重命名先取消，再清空选中态
			var _prevSel = document.querySelectorAll('#fileList .file-item.selected');
			for (var _i = 0; _i < _prevSel.length; _i++) {
				if (_prevSel[_i].querySelector('.rename-input')) cancelRename(_prevSel[_i]);
			}
			cancelSelection();
			return;
		}
		if (itemEl.dataset.name === '..') { navigateTo(itemEl.dataset.path); return; }
		var isSzClick = e.target.classList.contains('sz-area');
		if (itemEl.dataset.type === 'folder' && !isSzClick) {
			navigateTo(itemEl.dataset.path);
			return;
		}
		selectFileItem(itemEl, e.shiftKey);
	});
	_fileListEl.addEventListener('contextmenu', function(e) {
		var itemEl = e.target.closest('.file-item');
		if (!itemEl) return; // 空白区由下方 empty-context-menu IIFE 处理
		e.preventDefault();
		if (!itemEl.classList.contains('selected')) selectFileItem(itemEl, false);
		showContextMenu(e.clientX, e.clientY, itemEl.dataset.path, { name: itemEl.dataset.name, isDir: itemEl.dataset.type === 'folder' });
	});
}

// ---- Selection system ----
function cancelSelection() {
	var prev = document.querySelectorAll('#fileList .file-item.selected');
	prev.forEach(function(el) { el.classList.remove('selected'); });
	selectedItems = [];
	selectedItem = null;
	lastSelectedItem = null;
}
function selectAllFiles() {
	cancelSelection();
	var all = document.querySelectorAll('#fileList .file-item');
	selectedItems = [];
	for (var i = 0; i < all.length; i++) {
		var el = all[i];
		if (el.dataset.name === '..') continue;
		el.classList.add('selected');
		selectedItems.push({ type: el.dataset.type, path: el.dataset.path, name: el.dataset.name });
	}
	if (selectedItems.length > 0) {
		selectedItem = selectedItems[0];
		lastSelectedItem = findItemByPath(selectedItem.path);
	}
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
	// Prevent click from bubbling to file item (which would navigate into folder)
	input.addEventListener('click', function(e) { e.stopPropagation(); });

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
			recordDirHistory(currentPath);
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
function hideAllContextMenus() {
	var m = document.getElementById('itemContextMenu'); if (m) m.style.display = 'none';
	var e = document.getElementById('emptyContextMenu'); if (e) e.style.display = 'none';
}

// ★ Chrome 108 zoom→fixed 坐标空间归一。唯一真理入口，所有 fixed 定位必经此函数。
// 原理: html{zoom:0.85} 下 clientX/Y 与 position:fixed 走不同坐标空间，此处除以 zoom 因子补偿。
// 改 zoom 值只需改 CSS 一处，本函数自动跟随（getComputedStyle 实时读）。
function _zoomFix(x, y) {
	var z = getComputedStyle(document.documentElement).zoom;
	if (z === '1' || z === '') return { left: x, top: y };
	z = parseFloat(z);
	return { left: x / z, top: y / z };
}

// ===== Actions (from q3, 100% ported) =====
function performCodeAction(item) {
	if (!item) return;
	if (item.name === '..') return;
	if (item.type === 'folder') {
		navigateTo(item.path);
		_playSfx('enter');
		return;
	}
	// Q 键唯一职责：在编辑器中打开文件（文本文件）
	// 已知二进制文件 → 仅播放错误音效，不打开（不混入 W 键的职责）
	if (isBinaryByName(item.name) === true) {
		_playSfx('error');
		return;
	}
	parent.postMessage({ type: 'qqq-file-open', path: item.path }, '*');
	recordFileHistory(item.path);
	_playSfx('enter');
}
function performOpenAction(item) {
	if (!item) return;
	if (item.name === '..') return;
	if (item.type === 'folder') { navigateTo(item.path); _playSfx('enter'); return; }
	if (item.path && /\.lnk$/i.test(item.path)) {
		// .lnk 快捷方式：照抄 q3 逻辑——解析目标，是文件夹（且存在）则导航，否则交给系统
		var srcDir = currentPath;
		var lnkPath = item.path;
		resolveLnkTarget(lnkPath).then(function(target) {
			if (target) {
				// q3 关键判断：目标必须存在且是文件夹才在 Roam 内导航
				bridge.fs.stat(target).then(function(st) {
					if (st && st.isDir) { navigateTo(target); lnkJumpFromPath = srcDir; }
					else { bridge.shell.openPath(lnkPath).catch(function(){}); }
				}).catch(function() { bridge.shell.openPath(lnkPath).catch(function(){}); });
			} else {
				bridge.shell.openPath(lnkPath).catch(function(){});
			}
		});
	} else {
	// W 键唯一职责：用操作系统默认程序打开文件
	// 不 fallback 到编辑器（与 Q 键职责彻底分离）
	bridge.shell.openPath(item.path).catch(function(){});
}
// ★ q3 百分百移植：W 键只记录当前工作目录（parent dir），不记录文件本身
// Q=编辑（recordFileHistory 记录文件+父目录），W=系统打开（recordDirHistory 仅记录父目录）
recordDirHistory(currentPath);
_playSfx('enter');
}
function performDeleteAction(item) {
	if (!item) return;
	if (item.name === '..') return;
	// Multi-select delete
	var targets = selectedItems.length > 1
		? selectedItems.filter(function(s) { return s.name !== '..'; })
		: [item];
	if (targets.length === 0) return;
	// Fade items without confirmation (from q3)
	targets.forEach(function(t) {
		var el = findItemByPath(t.path);
		if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
	});
	// Move to recycle bin (no confirmation dialog)
	Promise.all(targets.map(function(t) { return bridge.fs.remove(t.path).catch(function(){}); }))
		.then(function() { recordDirHistory(currentPath); if (currentPath) loadFileList(currentPath); });
	_playSfx('delete');
	if (selectedItems.length > 1) { selectedItem = null; selectedItems = []; }
	else selectedItem = null;
}
function performEditAction(item) {
	if (!item) return;
	if (item.name === '..') return;
	startRename(item.path, item.name, item.type);
	_playSfx('enter');
}
function performCopyPathAction() {
	var paths = [];
	// ★ 优先使用 selectedItems（键盘 z 键时 ctxTarget 可能为 stale）
	if (selectedItems.length > 1) {
		paths = selectedItems.filter(function(s) { return s.name !== '..'; }).map(function(s) { return s.path; });
	} else if (selectedItem && selectedItem.name !== '..') {
		paths = [selectedItem.path];
	} else if (ctxTarget) {
		// 从右键菜单触发且无选中项时兜底
		paths = [ctxTarget];
	}
	if (paths.length > 0) {
		bridge.clipboard.writeText(paths.join('\n')).catch(function() {
			if (navigator.clipboard) navigator.clipboard.writeText(paths.join('\n')).catch(function(){});
		});
	}
	_playSfx('enter');
}

var ctxMenu = document.getElementById('itemContextMenu');
var ctxTarget = null;
var ctxEntry = null;

function showContextMenu(x, y, path, entry) {
	ctxTarget = path;
	ctxEntry = entry;
	// ★ AI 项标签 = 当前焦点面板（父窗口 __qqq_aiTarget: 0左/1中/2右）
	//    左: ←AI · 中: AI · 右: AI→ — 让用户清楚喂给哪一个面板
	_updateAiMenuItem();
	// ★ 从 q3 百分百移植：先设位置再显示，避免闪烁
	//    光标在菜单左上角（left/top 对齐 clientX/clientY）
	var p = _zoomFix(x, y);
	ctxMenu.style.left = p.left + 'px';
	ctxMenu.style.top = p.top + 'px';
	ctxMenu.style.display = 'flex';
}

function _getAiTargetPanel() {
	try {
		if (window.parent && typeof window.parent.__qqq_aiTarget === 'number') {
			return window.parent.__qqq_aiTarget;
		}
	} catch (_) { }
	return 1; // 默认中面板
}

function _updateAiMenuItem() {
	var item = ctxMenu.querySelector('[data-action="ai"]');
	if (!item) return;
	var t = _getAiTargetPanel();
	var label = t === 0 ? '←AI' : t === 2 ? 'AI→' : 'AI';
	var sp = item.querySelector('span');
	if (sp) sp.textContent = label;
}

function _feedCurrentToAi() {
	// 优先选中项，无选中项时退回 ctxTarget（右键目标）
	var p = null, isDir = false;
	if (selectedItem && selectedItem.name !== '..') {
		p = selectedItem.path;
		isDir = selectedItem.type === 'folder';
	} else if (ctxTarget) {
		p = ctxTarget;
		isDir = ctxEntry ? !!ctxEntry.isDir : false;
	}
	if (!p) return;
	// ★ 唯一真理喂 AI 管线: ai-viewport.js window.__qqq_aiFeedFile (路由到焦点面板)
	try {
		if (window.parent && typeof window.parent.__qqq_aiFeedFile === 'function') {
			window.parent.__qqq_aiFeedFile(p, isDir, null);
		} else if (window.parent) {
			window.parent.postMessage({ type: 'qqq-ai-attach', path: p, isDir: isDir }, '*');
		}
	} catch (_) { }
	_playSfx('enter');
}

document.addEventListener('click', function() { ctxMenu.style.display = 'none'; var e = document.getElementById('emptyContextMenu'); if (e) e.style.display = 'none'; });

// ---- Empty context menu (right-click on empty area, from q3) ----
var emptyCtxMenu = document.getElementById('emptyContextMenu');
if (emptyCtxMenu) {
	emptyCtxMenu.querySelectorAll('.context-menu-item').forEach(function(el) {
		el.addEventListener('click', function() {
			var act = el.dataset.action;
			hideAllContextMenus();
			if (act === 'openAdminCmd') { bridge.shell.openTerminal(currentPath, 'cmd').catch(function(){}); _playSfx('terminal'); }
			else if (act === 'openAdminPowershell') { bridge.shell.openTerminal(currentPath, 'powershell').catch(function(){}); _playSfx('terminal'); }
		});
	});
}

// Show empty context menu on right-click on empty area of file list
(function() {
	var fl = document.getElementById('fileList');
	if (!fl) return;
	fl.addEventListener('contextmenu', function(e) {
		var itemEl = e.target.closest('.file-item');
		if (itemEl) return; // Let item handler deal with it
		// Empty area right-click
		e.preventDefault(); e.stopPropagation();
		hideAllContextMenus();
		var em = document.getElementById('emptyContextMenu');
		if (!em) return;
		var ep = _zoomFix(e.clientX, e.clientY);
		em.style.left = ep.left + 'px';
		em.style.top = ep.top + 'px';
		em.style.display = 'flex';
	});

	// ---- Drag & drop paste (M8.3) ----
	fl.addEventListener('dragover', function(e) {
		e.preventDefault();
		e.stopPropagation();
	});
	fl.addEventListener('drop', function(e) {
		e.preventDefault();
		e.stopPropagation();
		if (!currentPath) return;
		var dt = e.dataTransfer;
		if (!dt || !dt.files || dt.files.length === 0) return;
		var paths = [];
		for (var i = 0; i < dt.files.length; i++) {
			if (dt.files[i].path) paths.push(dt.files[i].path);
		}
		if (paths.length > 0) {
			_copyPathsToCurrentDir(paths);
		}
	});
})();