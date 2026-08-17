// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// ── 排队按钮状态：有文字或图片即可排队（fatal 态禁用）──
// ★ 2026-08-16 闭环重构：刷新收敛于两个统一出口（autoResizeInput = value 变更出口 / renderImageStrip = 图片增删出口），
//   打字/粘贴文本/粘贴图片/删图/undo/redo/切 quest 恢复/发送清空/换行按钮全部自动覆盖，零漏网。
function updateQueueBtn() {
    var _ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    if (_ag && _ag._stopState === 'fatal') { $queueBtn.disabled = true; return; }
    var hasText = $input.value.trim().length > 0;
    var hasImages = (typeof pendingImages !== 'undefined') && pendingImages.length > 0;
    $queueBtn.disabled = !(hasText || hasImages);
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
        updateQueueBtn();
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
    updateQueueBtn();
    // 安全网：原生 setter 直设，防绕过 paste 处理器的异常路径
    if (el.value.length > INPUT_CAP_CHARS) {
        var _ns = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        _ns.call(el, el.value.substring(0, INPUT_CAP_CHARS));
        _updateInputProgress();
        updateQueueBtn();
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

function _limitQoast(reason, args) {
    var now = Date.now();
    // 图片类提示豁免 3s 防抖：可与字符上限提示连续出现（不同原因不互相吞）
    if (reason !== 'paste-truncated' && reason !== 'paste-full'
        && reason !== 'image-cap' && reason !== 'image-size') {
        if (now - _lastLimitQoastTs < _LIMIT_QOAST_COOLDOWN) return;
    }
    _lastLimitQoastTs = now;
    var msg;
    if (reason === 'paste-full') {
        msg = _i18nQ('ai.inputLimitQoastFull', '已达编辑框字符上限，无法继续粘贴');
    } else if (reason === 'paste-truncated') {
        msg = _i18nQ('ai.inputLimitQoastTruncated', '已达编辑框字符上限，多余内容已截断');
    } else if (reason === 'image-cap') {
        msg = _i18nQ('ai.inputLimitQoastImageCap', '图片已达上限（{0} 张），多余图片未粘贴');
    } else if (reason === 'image-size') {
        msg = _i18nQ('ai.inputLimitQoastImageSize', '有 {0} 张图片超出单张大小上限，已跳过');
    } else if (reason === 'send-busy') {
        msg = _i18nQ('ai.inputSendBusy', 'AI 正在处理中，请稍候…');
    } else {
        msg = _i18nQ('ai.inputLimitQoastCap', '已达编辑框字符上限（约 {0}K 字符，非文件字节）');
        msg = msg.replace('{0}', (INPUT_CAP_CHARS / 1000).toFixed(1));
    }
    if (args && args.length) {
        msg = msg.replace(/\{(\d+)\}/g, function (m, idx) {
            return (args[idx] != null) ? String(args[idx]) : m;
        });
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
        // ★ 发送活跃检查（同 quest 任何面板链在执行/本面板草稿晋升中 → 拒；不同 quest 三翼并发 → 三通开工）
        //   链串行结构上不可能并发（2026-08-11 重构替代锁表），此检查仅给用户即时反馈
        if (typeof _sendActive === 'function' && _sendActive(questActiveId)) {
            _limitQoast('send-busy');  // ★ 2026-08-11: 拦截 → 节流提示（防"按回车没反应"被误解为卡死）
            return;
        }
        // streaming 时 Enter = 停止生成（不发送）
        if (streaming) { stopStream(); return; }
        // 登录闸门
        if (!_isLoggedIn()) {
            try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show('请先在菜单栏点击登录', { type: 'warning', duration: 6000 }); } catch (_e2) { }
            return;
        }
        // ★ 立即反馈前置：发送意图经 sendMessage → _enqueueSend 入链（同步段完成，任何 await 之前）
        //   竞态语义：同 quest 忙时 _sendActive 已拦（编辑框内容保留零丢失）；
        //   通过后链追加原子 → 本意图必被执行，无双发可能
        // ★ 立即反馈（2026-08-10）：同步插入用户气泡 + 清空编辑框（零 IPC 等待）
        //   旧行为：draft 晋升（create/rename/mkdir 多条慢 IPC）后才清空编辑框 →
        //   用户感知"按了回车没反应"（5-15 秒）→ 窗口内重复按 Enter → 并发发送 → 多层楼
        var _txtNow = $input.value;
        if (_txtNow && _txtNow.trim()) {
            try {
                var _bubble = addMessageEl('user', _txtNow);
                if (_bubble) {
                    window.__qqq_userBubbleEl = _bubble;
                    if (typeof scrollToBottom === 'function') scrollToBottom(true);
                }
            } catch (_fb) {
                // 渲染异常（如绑定中 cardPool 未就绪）→ 恢复编辑框，内容零丢失（链无需释放，无锁）
                $input.value = _txtNow;
                return;
            }
            $input.value = '';
            if ($input._resetUndo) $input._resetUndo();
            if (typeof autoResizeInput === 'function') autoResizeInput();
            if (typeof updateQueueBtn === 'function') updateQueueBtn();
        }
        sendMessage(_txtNow);
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

// ══ 多图粘贴三重硬帽（2026-08-07 多图粘贴架构）══
var MAX_SINGLE_IMAGE_BYTES = 30 * 1024 * 1024; // 单张硬帽：FileReader 全量读入内存，防卡死/OOM
var MAX_IMG_EDGE = 4096;                       // 像素保护边：<2MB 但像素爆炸图（纯色大 PNG）→ canvas 崩溃点
var COMPRESS_EDGE = 2048;                      // >2MB 压缩目标最长边（原行为：2048 宽）
var _pasteChain = Promise.resolve();           // 粘贴串行队列：防快速连按 Ctrl+V 并发乱序

// 粘贴队列入口：所有异步粘贴路径（Ctrl+V / 右键菜单）串行执行
function _enqueuePaste(fn) {
    _pasteChain = _pasteChain.then(fn, fn);
    return _pasteChain;
}

function _readAsDataURL(blob) {
    return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error || new Error('read failed')); };
        r.readAsDataURL(blob);
    });
}

function _loadImage(src) {
    return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('img decode failed')); };
        img.src = src;
    });
}

// 单张图片处理：30MB 硬帽 → 解码 → 像素保护/2MB 压缩 → 入条
// 返回 {added:true} 或 {skipped:'size'}；解码失败直接 throw（外层隔离）
async function _processImageFile(blob) {
    if (blob.size > MAX_SINGLE_IMAGE_BYTES) return { skipped: 'size' };
    var dataUrl = await _readAsDataURL(blob);
    var img = await _loadImage(dataUrl);
    var w = img.naturalWidth || 0;
    var h = img.naturalHeight || 0;
    var needCompress = blob.size > 2 * 1024 * 1024;
    var edge = COMPRESS_EDGE;
    // 像素保护：文件小但像素爆炸（纯色大图 PNG）→ 防 canvas 崩溃
    if (!needCompress && (w > MAX_IMG_EDGE || h > MAX_IMG_EDGE)) {
        needCompress = true;
        edge = MAX_IMG_EDGE;
    }
    if (needCompress && w > 0 && h > 0) {
        // 按最长边等比缩放（修复原 bug：>2MB 竖长图只缩宽不缩高）
        var scale = Math.min(1, edge / w, edge / h);
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        var out = canvas.toDataURL('image/jpeg', 0.85);
        addImage(out, out.split(',')[1]);
    } else {
        // SVG 等无 intrinsic size 或无需压缩 → 原样入条
        addImage(dataUrl, dataUrl.split(',')[1]);
    }
    return { added: true };
}

// 批量粘贴图片：槽位上限裁剪 + 逐张串行保序 + 失败隔离 + 汇总提示
async function _pasteImages(imageFiles) {
    if (!imageFiles || imageFiles.length === 0) return;
    var slot = MAX_IMAGES - pendingImages.length;
    var toProcess = imageFiles;
    if (slot <= 0) {
        _limitQoast('image-cap', [MAX_IMAGES]);
        return;
    } else if (imageFiles.length > slot) {
        toProcess = imageFiles.slice(0, slot);
        _limitQoast('image-cap', [MAX_IMAGES]);
    }
    var skip = 0;
    for (var k = 0; k < toProcess.length; k++) {
        try {
            var r = await _processImageFile(toProcess[k]);
            if (!r || !r.added) skip++;
        } catch (_e) { skip++; }
    }
    if (skip > 0) _limitQoast('image-size', [skip]);
}

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
        updateQueueBtn();
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
    updateQueueBtn();
}

// ═══ 编辑框硬上限（字符数 = str.length；唯一真理源 content-gateway.js EDITOR_CAP_CHARS）══
var INPUT_CAP_CHARS = 16000;
// 尝试从 ContentGateway 同步（如果有），但本地 16000 是硬兜底
if (typeof ContentGateway !== 'undefined' && typeof ContentGateway.EDITOR_CAP_CHARS === 'number') {
    INPUT_CAP_CHARS = ContentGateway.EDITOR_CAP_CHARS;
}

// 粘贴图片（多图全量收集 + 串行保序 + 三重硬帽）/ 纯文本粘贴
$input.addEventListener('paste', function (e) {
    // ★ 铁律：任何粘贴一律先阻止原生行为，再由我们手动插入
    e.preventDefault();

    // ★ 同步收集剪贴板（clipboardData 仅事件回调内有效，必须同步读）
    var plainText = '';
    var imageFiles = [];
    try {
        var cd = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
        if (!cd) return;
        plainText = cd.getData('text/plain') || '';
        var items = cd.items;
        if (items) {
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
                    var f = it.getAsFile();
                    if (f) imageFiles.push(f);
                }
            }
        }
    } catch (_) { return; }

    // ★ 串行队列：快速连按 Ctrl+V 时逐次处理，防并发乱序/超限
    _enqueuePaste(async function () {
        // 图片分支：串行处理保序，三重硬帽（30MB / 4096px / 20张槽位）
        if (imageFiles.length > 0) {
            await _pasteImages(imageFiles);
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

    _addRow('Ctrl+V', function () {
        $input.focus();
        // ★ 串行队列：与 Ctrl+V 共用同一队列，防并发乱序
        _enqueuePaste(async function () {
        // ★ 先尝试读剪贴板图片（navigator.clipboard.read 支持 text+image）
        var imageBlobs = [], txt = '';
        try {
            var items = await navigator.clipboard.read();
            for (var i = 0; i < items.length; i++) {
                for (var t = 0; t < items[i].types.length; t++) {
                    var mt = items[i].types[t];
                    if (mt.indexOf('image/') === 0) {
                        // 全量收集（不再 break），保剪贴板顺序
                        try { imageBlobs.push(await items[i].getType(mt)); } catch (_) {}
                    } else if (mt === 'text/plain') {
                        try { txt = await (await items[i].getType('text/plain')).text(); } catch (_) {}
                    }
                }
            }
        } catch (_) {
            // clipboard.read 失败 → 回退到纯文本
            try {
                var b = _getBridge();
                if (b && b.clipboard && b.clipboard.readText) {
                    txt = await b.clipboard.readText();
                } else {
                    txt = await navigator.clipboard.readText();
                }
            } catch (_2) { return; }
        }

        // 图片分支：复用 _pasteImages（串行保序 + 三重硬帽）
        if (imageBlobs.length > 0) {
            await _pasteImages(imageBlobs);
        }

        // 纯文本分支（图片+文本共存时，图片先入条，文本走此分支插入一次）
        if (!txt) return;
        var nd2 = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        var cur2 = nd2.get.call($input);
        var ss2 = $input.selectionStart || 0, se2 = $input.selectionEnd || 0;
        var avail2 = INPUT_CAP_CHARS - cur2.substring(0, ss2).length - cur2.substring(se2).length;
        if (avail2 <= 0) { _limitQoast('paste-full'); return; }
        var ins2 = txt.length > avail2 ? txt.substring(0, avail2) : txt;
        nd2.set.call($input, cur2.substring(0, ss2) + ins2 + cur2.substring(se2));
        $input.setSelectionRange(ss2 + ins2.length, ss2 + ins2.length);
        autoResizeInput(); _updateInputProgress();
        if (txt.length > avail2) _limitQoast('paste-truncated');
        });
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
        // ★ 发送活跃检查：同 quest 忙 → 拒（内容保留编辑框）；不同 quest 三翼并发不受阻
        if (typeof _sendActive === 'function' && _sendActive(questActiveId)) {
            _limitQoast('send-busy');  // ★ 2026-08-11: 拦截 → 节流提示
            return;
        }
        sendMessage();
    }
};
