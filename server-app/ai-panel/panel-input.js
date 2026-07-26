// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// ── 排队按钮状态：有文字即可排队（不管 AI 是否在工作；fatal 态禁用）──
function updateQueueBtn() {
    var _ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    if (_ag && _ag._stopState === 'fatal') { $queueBtn.disabled = true; return; }
    var hasText = $input.value.trim().length > 0;
    $queueBtn.disabled = !hasText;
}

// ── 无主文件夹时直接弹文件夹选择 ──
var _selectingProject = false;
function _hasMainProject() {
    try {
        if (parent && parent.qqqideViewport && parent.qqqideViewport.getMainProject()) return true;
    } catch (_) { }
    return !!_workspaceRoot;
}
async function _triggerSelectMainProject() {
    if (_selectingProject) return;
    _selectingProject = true;
    try {
        if (parent === window) {
            // [silent] rules standalone window
            return;
        }
        var bridge = parent && parent.qqqideBridge;
        if (!bridge) return;
        var title = '请选择一个主文件夹';
        try { if (parent.window && parent.window._i) title = parent.window._i('ai.onboarding.selectFolderTitle', title); } catch (_) { }
        var result = await bridge.dialog.open({
            properties: ['openDirectory'],
            title: title
        });
        if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
            if (parent.qqqideViewport && parent.qqqideViewport.addProject) {
                parent.qqqideViewport.addProject(result.filePaths[0]);
            }
        }
    } catch (_) {
    } finally {
        _selectingProject = false;
    }
}

// ═══ 统一守卫管线：无主项目时直接弹文件夹选择 ═══
// ① 所有鼠标点击 → 在 #input-area 内直接触发
document.addEventListener('mousedown', function (e) {
    if (_hasMainProject() || _selectingProject) return;
    var el = e.target;
    if (el.closest('#input-area')) {
        _triggerSelectMainProject();
        e.stopImmediatePropagation();
        e.preventDefault();
    }
}, true);
// ② Enter 键发送
document.addEventListener('keydown', function (e) {
    if (_hasMainProject() || _selectingProject) return;
    if (e.key === 'Enter' && !e.shiftKey && e.target.closest('#input')) {
        _triggerSelectMainProject();
        e.stopImmediatePropagation();
        e.preventDefault();
    }
}, true);
// ③ 粘贴拦截
$input.addEventListener('paste', function (e) {
    if (!_hasMainProject() && !_selectingProject) {
        _triggerSelectMainProject();
        e.stopImmediatePropagation();
        e.preventDefault();
    }
}, true);

// ── 递归复制 alphal 目录（copy+delete 代替 rename，避免文件锁）──
async function _copyAlphalDir(srcDir, dstDir) {
    var entries = await window.parent.qqqideBridge.fs.list(srcDir);
    for (var i = 0; i < entries.length; i++) {
        var name = entries[i].name;
        var isDir = entries[i].isDir;
        var srcPath = srcDir + '/' + name;
        var dstPath = dstDir + '/' + name;
        try {
            if (isDir) {
                await window.parent.qqqideBridge.fs.mkdir(dstPath);
                await _copyAlphalDir(srcPath, dstPath);
                await window.parent.qqqideBridge.fs.remove(srcPath);
            } else {
                var content = await window.parent.qqqideBridge.fs.read(srcPath);
                await window.parent.qqqideBridge.fs.write(dstPath, content);
                await window.parent.qqqideBridge.fs.remove(srcPath);
            }
        } catch (e) {
            console.warn('[quests] copy fail for ' + name, e);
        }
    }
}

// ── 智能等级选择（per-quest）──
// ★ 全局默认等级由父窗口 settings 机器提供，兜底 6
var selectedTier = (typeof _getDefaultTier === 'function') ? _getDefaultTier() : 3;
function updateTierButtons(tierIndex) {
    document.querySelectorAll('.tier-btn').forEach(function (b) { b.classList.remove('sel'); });
    if (tierIndex && tierIndex >= 1 && tierIndex <= 6) {
        var btn = document.querySelector('.tier-btn[data-tier="' + tierIndex + '"]');
        if (btn) btn.classList.add('sel');
    }
}

function selectTier(tierIndex) {
    // ★ A 按钮已改为信息弹窗，不再可选中；null→回退默认档
    if (tierIndex == null || tierIndex === 0) {
        tierIndex = (typeof _getDefaultTier === 'function') ? _getDefaultTier() : 3;
    }
    selectedTier = tierIndex;
    updateTierButtons(tierIndex);
    if (questActiveId) {
        if (!questUIStates[questActiveId]) questUIStates[questActiveId] = {};
        questUIStates[questActiveId].selectedTier = tierIndex;
    }
}

// 初始化选中态
(function initTierUI() {
    selectTier((typeof _getDefaultTier === 'function') ? _getDefaultTier() : 3);
})();

// ★ A 按钮：通知父窗口弹出等级说明
//    弹出窗在 parent window（同设置按钮），不在 AI iframe 内
document.getElementById('tier-a').onclick = function () {
    try { if (parent && parent.window && parent.window.openTierPopup) parent.window.openTierPopup(); } catch (_) { }
};
// ★ 1-6 按钮绑定等级选择
document.querySelectorAll('.tier-btn[data-tier]').forEach(function (btn) {
    btn.onclick = function () { selectTier(parseInt(btn.dataset.tier)); };
});
// ═══ 登录守卫：无登录不许聊天 ═══
function _isLoggedIn() {
    try {
        if (parent && parent.window && parent.window.qqqLogin && parent.window.qqqLogin.isLoggedIn) {
            return parent.window.qqqLogin.isLoggedIn();
        }
    } catch (_) { }
    return false;
}

function getLoginToken() {
    try {
        if (parent && parent.window && parent.window.qqqLogin && parent.window.qqqLogin.getAuthToken) {
            return parent.window.qqqLogin.getAuthToken();
        }
    } catch (_) { }
    return '';
}

// ── 编辑框自适应高度：双路径（空→rows=2原生高 / 非空→rows=1+scrollHeight），零抖动 ═══
var _inputLineHeight = 0;
var _inputMaxHeight = 333;
function autoResizeInput() {
    var el = $input;
    if (!_inputLineHeight) {
        _inputLineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    }
    if (!el.value) {
        el.rows = 2;
        el.style.height = '';
        el.style.overflowY = 'hidden';
        _updateInputProgress();
        return;
    }
    el.rows = 1;
    el.style.height = 'auto';
    var sh = el.scrollHeight;
    var newH = sh + _inputLineHeight;
    if (newH >= _inputMaxHeight) {
        el.style.height = _inputMaxHeight + 'px';
        el.style.overflowY = 'auto';
    } else {
        el.style.height = newH + 'px';
        el.style.overflowY = 'hidden';
    }
    _updateInputProgress();
    // 安全网：原生 setter 直设，防绕过 paste 处理器的异常路径
    if (el.value.length > INPUT_CAP_CHARS) {
        var _ns = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        _ns.call(el, el.value.substring(0, INPUT_CAP_CHARS));
        _updateInputProgress();
    }
}
$input.addEventListener('input', autoResizeInput);
// 兜底：程序改 value 时触发 autoResizeInput（发完消息清空/切 quest 恢复）
(function () {
    var _desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (_desc && _desc.set) {
        Object.defineProperty($input, 'value', {
            get: function () { return _desc.get.call(this); },
            set: function (v) {
                _desc.set.call(this, v);
                autoResizeInput();
            },
            configurable: true
        });
    }
})();
// 窗口大小变化或主题切换可能导致行高变化，重新计算
window.addEventListener('resize', function () { _inputLineHeight = 0; autoResizeInput(); });

// ═══ 键入进度条 — 底部 2px 单线填色 #ff3d00 ═══
function _updateInputProgress() {
    var fill = document.getElementById('input-progress-fill');
    if (!fill) return;
    var len = $input.value.length;
    var pct = Math.min(len / INPUT_CAP_CHARS * 100, 100);
    fill.style.width = pct + '%';
    // 触顶才弹 qoast（防抖 3s）
    if (pct >= 100) _limitQoast('typed');
}

// ═══ 上限 qoast 防抖（3s 冷却）══
var _lastLimitQoastTs = 0;
var _LIMIT_QOAST_COOLDOWN = 3000;
function _i18nQ(key, fallback) {
    try {
        if (parent && parent._i) return parent._i(key, fallback);
    } catch (_) { }
    return fallback;
}

function _limitQoast(reason) {
    var now = Date.now();
    if (reason !== 'paste-truncated' && reason !== 'paste-full') {
        if (now - _lastLimitQoastTs < _LIMIT_QOAST_COOLDOWN) return;
    }
    _lastLimitQoastTs = now;
    var msg;
    if (reason === 'paste-full') {
        msg = _i18nQ('ai.inputLimitQoastFull', '已达编辑框字符上限，无法继续粘贴');
    } else if (reason === 'paste-truncated') {
        msg = _i18nQ('ai.inputLimitQoastTruncated', '已达编辑框字符上限，多余内容已截断');
    } else {
        msg = _i18nQ('ai.inputLimitQoastCap', '已达编辑框字符上限（约 {0}K 字符，非文件字节）');
        msg = msg.replace('{0}', (INPUT_CAP_CHARS / 1000).toFixed(1));
    }
    try {
        if (parent && parent.window && parent.window.qqqideQoast) {
            parent.window.qqqideQoast.show(msg, { duration: 3500, type: 'warning' });
        }
    } catch (_) { }
}

// ═══ 硬上限键前拦截：已达上限且键入可打印字符→阻止（防字母先入再截）══
$input.addEventListener('keydown', function (e) {
    // 可打印字符：key.length===1 且非修饰键；Backspace/Delete/Enter/方向键等 length>1 放行
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if ($input.value.length >= INPUT_CAP_CHARS) {
        e.preventDefault();
        _limitQoast('typed');
    }
}, true);

// Enter to send
$input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (_switching) return;  // ★ quest 切换中 → 禁止一切操作
        if (_sending) return;
        if (_activeAgent && _activeAgent._compressing) return;
        // ★ 发送锁：防连点回车重复发送
        if (typeof _execSendBusy !== 'undefined' && _execSendBusy) return;
        if (streaming) { stopStream(); } else { sendMessage(); }
    }
});
// ══ 字符级 Undo/Redo（唯一真理逐字回退机器接管）══
if (window.qqqCharUndo) {
    window.qqqCharUndo.attach($input, { onChange: updateQueueBtn });
}

// ══ 换行按钮：在光标位置插入换行 ══
var $newlineBtn = document.getElementById('newline-btn');
if ($newlineBtn) {
    $newlineBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (_switching) return;
        var ta = $input;
        var s = ta.selectionStart, end = ta.selectionEnd;
        var v = ta.value;
        ta.value = v.slice(0, s) + '\n' + v.slice(end);
        // 光标移到换行符之后
        ta.selectionStart = ta.selectionEnd = s + 1;
        ta.focus();
        // 触发布局更新（auto-resize）
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

// ══ 多图管理 ══
var pendingImages = []; // [{id, base64, dataUrl}]
var MAX_IMAGES = 20;

function addImage(dataUrl, base64) {
    if (pendingImages.length >= MAX_IMAGES) return;
    var id = pendingImages.length + 1;
    pendingImages.push({ id: id, base64: base64, dataUrl: dataUrl });
    renderImageStrip();
}

function removeImage(idx) {
    pendingImages.splice(idx, 1);
    pendingImages.forEach(function (img, i) { img.id = i + 1; });
    renderImageStrip();
}

function renderImageStrip() {
    var strip = document.getElementById('image-strip');
    strip.innerHTML = '';
    if (pendingImages.length === 0) {
        strip.style.display = 'none';
        return;
    }
    strip.style.display = 'flex';
    pendingImages.forEach(function (img, idx) {
        var wrap = document.createElement('div');
        wrap.className = 'img-thumb-wrap';
        var imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        wrap.appendChild(imgEl);
        var num = document.createElement('span');
        num.className = 'img-thumb-num';
        num.textContent = '#' + img.id;
        num.onclick = function (e) { e.stopPropagation(); openLightbox(img.dataUrl, img.base64); };
        wrap.appendChild(num);
        var del = document.createElement('button');
        del.className = 'img-thumb-del';
        del.textContent = '\u00d7';
        del.onclick = function () { removeImage(idx); };
        wrap.appendChild(del);
        var embed = document.createElement('button');
        embed.className = 'img-thumb-embed';
        embed.textContent = (parent && parent._i) ? parent._i('ai.embedImage', '嵌入') : '嵌入';
        embed.onclick = function () {
            $input.focus();
            document.execCommand('insertText', false, '[img:' + img.id + ']');
        };
        wrap.appendChild(embed);
        strip.appendChild(wrap);
    });
}

// ═══ 编辑框硬上限（字符数 = str.length；唯一真理源 content-gateway.js EDITOR_CAP_CHARS）══
var INPUT_CAP_CHARS = 16000;
// 尝试从 ContentGateway 同步（如果有），但本地 16000 是硬兜底
if (typeof ContentGateway !== 'undefined' && typeof ContentGateway.EDITOR_CAP_CHARS === 'number') {
    INPUT_CAP_CHARS = ContentGateway.EDITOR_CAP_CHARS;
}

// 粘贴图片（> 2MB 自动压缩至 2048px 宽）/ 纯文本粘贴
$input.addEventListener('paste', function (e) {
    // ★ 铁律：任何粘贴一律先阻止原生行为，再由我们手动插入
    e.preventDefault();

    var plainText = '';
    var hasImage = false;
    var imageFile = null;

    // 读取剪贴板（try-catch 全包裹，任何异常都安全退出）
    try {
        var cd = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
        if (!cd) return;
        plainText = cd.getData('text/plain') || '';
        var items = cd.items;
        if (items) {
            for (var i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image/') === 0) {
                    hasImage = true;
                    imageFile = items[i].getAsFile();
                    break;
                }
            }
        }
    } catch (_) { return; }

    // 图片分支
    if (hasImage && imageFile) {
        var reader = new FileReader();
        reader.onload = function (ev) {
            var dataUrl = ev.target.result;
            if (imageFile.size > 2 * 1024 * 1024) {
                var img = new Image();
                img.onload = function () {
                    var scale = img.width > 2048 ? 2048 / img.width : 1;
                    var canvas = document.createElement('canvas');
                    canvas.width = Math.round(img.width * scale);
                    canvas.height = Math.round(img.height * scale);
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    addImage(canvas.toDataURL('image/jpeg', 0.85), canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
                };
                img.src = dataUrl;
            } else {
                addImage(dataUrl, dataUrl.split(',')[1]);
            }
        };
        reader.readAsDataURL(imageFile);
        return;
    }

    // 纯文本分支：硬上限保护
    if (!plainText) return;

    // ★ 直接用原生 getter 读当前值（绕过自定义属性，绝对可靠）
    var nativeGet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').get;
    var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var cur = nativeGet.call($input);
    var selStart = $input.selectionStart || 0;
    var selEnd = $input.selectionEnd || 0;
    var before = cur.substring(0, selStart);
    var after = cur.substring(selEnd);
    var available = INPUT_CAP_CHARS - before.length - after.length;

    if (available <= 0) {
        _limitQoast('paste-full');
        return;
    }

    var wasTruncated = plainText.length > available;
    var insertText = wasTruncated ? plainText.substring(0, available) : plainText;
    var newVal = before + insertText + after;

    // ★ 用原生 setter 直设值，然后手动触发 resize + progress
    nativeSet.call($input, newVal);
    $input.setSelectionRange(selStart + insertText.length, selStart + insertText.length);
    autoResizeInput();
    _updateInputProgress();

    if (wasTruncated) _limitQoast('paste-truncated');
});

// ═══ 右键菜单：Copy / Paste（无障碍，替代 Ctrl+C/Ctrl+V）══
var _inputCtxMenu = null;
function _closeInputCtxMenu() {
    if (_inputCtxMenu) { _inputCtxMenu.remove(); _inputCtxMenu = null; }
}
$input.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    _closeInputCtxMenu();

    var menu = document.createElement('div');
    menu.id = 'input-ctx-menu';
    // 先贴在远处测高，再移位到光标上方
    menu.style.cssText = 'position:fixed;z-index:99999;visibility:hidden;background:var(--card-bg,#eee8d5);border:1px solid var(--border-color,#d3c6aa);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.18);padding:0;min-width:120px;font-size:13px;';
    menu.style.left = '-9999px'; menu.style.top = '-9999px';
    document.body.appendChild(menu);
    _inputCtxMenu = menu;

    function _addRow(label, action) {
        var row = document.createElement('div');
        row.textContent = label;
        // padding 上下 6px（原8px减20%）
        row.style.cssText = 'padding:6px 16px;cursor:pointer;white-space:nowrap;color:var(--text-primary,#656360);';
        row.addEventListener('mouseenter', function () { row.style.background = 'var(--base3,#fdf6e3)'; });
        row.addEventListener('mouseleave', function () { row.style.background = ''; });
        row.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); _closeInputCtxMenu(); action(); });
        menu.appendChild(row);
    }

    _addRow('Ctrl+C', function () {
        $input.focus();
        if ($input.selectionStart === $input.selectionEnd) $input.select();
        try { document.execCommand('copy'); } catch (_) { }
    });

    _addRow('Ctrl+V', async function () {
        $input.focus();
        var txt = '';
        // ★ 走 IPC bridge（Electron 主进程 clipboard），绕过 iframe 权限限制
        try {
            var b = _getBridge();
            if (b && b.clipboard && b.clipboard.readText) {
                txt = await b.clipboard.readText();
            } else {
                txt = await navigator.clipboard.readText();
            }
        } catch (_) { return; }
        if (!txt) return;
        var nd = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        var cur = nd.get.call($input);
        var ss = $input.selectionStart || 0, se = $input.selectionEnd || 0;
        var avail = INPUT_CAP_CHARS - cur.substring(0, ss).length - cur.substring(se).length;
        if (avail <= 0) { _limitQoast('paste-full'); return; }
        var ins = txt.length > avail ? txt.substring(0, avail) : txt;
        nd.set.call($input, cur.substring(0, ss) + ins + cur.substring(se));
        $input.setSelectionRange(ss + ins.length, ss + ins.length);
        autoResizeInput(); _updateInputProgress();
        if (txt.length > avail) _limitQoast('paste-truncated');
    });

    // 测宽高 → 避开屏幕边缘
    var mr = menu.getBoundingClientRect();
    var mw = mr.width || 120, mh = mr.height || 56;
    var l = e.clientX, t = e.clientY - mh / 2;
    // 太靠右 → 移到光标左边；太靠下 → 上移
    if (l + mw > window.innerWidth - 4) l = e.clientX - mw;
    if (t + mh > window.innerHeight - 4) t = window.innerHeight - mh - 4;
    menu.style.visibility = 'visible';
    menu.style.left = Math.max(4, l) + 'px';
    menu.style.top = Math.max(4, t) + 'px';
});

// 点击外部或 Esc 关闭
document.addEventListener('mousedown', function (e) {
    if (_inputCtxMenu && !_inputCtxMenu.contains(e.target)) _closeInputCtxMenu();
}, true);
$input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') _closeInputCtxMenu();
});

$sendBtn.onclick = function () {
    if (_switching) return;
    if (_activeAgent && _activeAgent._compressing) return;

    if (_activeAgent && _activeAgent._stopState === 'fatal' && !streaming) {
        if (typeof _capRedBoxAndSeal === 'function') _capRedBoxAndSeal();
        return;
    }

    if (streaming) { stopStream(); }
    else if (_activeAgent && _activeAgent._stopState === 'sending') { return; }
    else {
        // ★ _execSendBusy 仅挡同 agent 的并发 Send，不同 quest 互不阻塞
        if (typeof _execSendBusy !== 'undefined' && _execSendBusy && _execSendBusyAgent === _activeAgent) return;
        sendMessage();
    }
};
