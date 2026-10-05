// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// ── 排队按钮状态：有文字或图片即可排队（fatal 态禁用）──
// ★ 2026-08-16 闭环重构：刷新收敛于两个统一出口（autoResizeInput = value 变更出口 / renderImageStrip = 图片增删出口），
//   打字/粘贴文本/粘贴图片/删图/undo/redo/切 quest 恢复/发送清空/换行按钮全部自动覆盖，零漏网。
// ★ 2026-08-20：自动暂停（草稿保护）整体废除——队列发送改为直通载荷不触碰编辑框，此处仅管按钮可用性
function updateQueueBtn() {
    var _ag = (typeof _activeAgent !== 'undefined') ? _activeAgent : null;
    if (_ag && _ag._stopState === 'fatal') { $queueBtn.disabled = true; return; }
    var hasText = $input.value.trim().length > 0;
    var hasImages = (typeof pendingImages !== 'undefined') && pendingImages.length > 0;
    $queueBtn.disabled = !(hasText || hasImages);
    // ★ 2026-08-20 修订：自动暂停已整体废除（队列直通发送不触碰编辑框），此处无自愈逻辑
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
        // ★ 三键档位（2026-09-16）：data-tier = 组代表值 1/3/5（显示 1/2/3）——旧存量 2/4/6 自动换算到组代表
        var _rep = (typeof _tierRepOf === 'function') ? _tierRepOf(tierIndex) : tierIndex;
        var btn = document.querySelector('.tier-btn[data-tier="' + _rep + '"]');
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
        // ★ per-quest 等级偏好独立落盘（ai.questTier.{questId}，三面板共享同一 key）：
        //   selectTier 即写，不依赖 saveQuestUIState 触发时机（切 quest/发送/关闭）
        //   → 切面板/切后台/刷新/重启均保持用户明确选择的等级，不被全局默认覆盖
        try {
            if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
                onlyStore.set('ai.questTier.' + questActiveId, tierIndex);
            }
        } catch (_) { }
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
// ★ 三键档位绑定等级选择（显示 1/2/3 = 组代表 1/3/5；2026-09-16）
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
    // ★ 断电安全：任何键入变更统一排程高频草稿保存（text 通道 800ms 节流）
    _scheduleDraftSave();
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
    // 粘贴类提示豁免 3s 防抖：可与键入上限提示连续出现（不同原因不互相吞）
    if (reason !== 'paste-truncated' && reason !== 'paste-full') {
        if (now - _lastLimitQoastTs < _LIMIT_QOAST_COOLDOWN) return;
    }
    _lastLimitQoastTs = now;
    var msg;
    if (reason === 'paste-full') {
        msg = _i18nQ('ai.inputLimitQoastFull', '已达编辑框字符上限，无法继续粘贴');
    } else if (reason === 'paste-truncated') {
        msg = _i18nQ('ai.inputLimitQoastTruncated', '已达编辑框字符上限，多余内容已截断');
    } else if (reason === 'send-busy') {
        msg = _i18nQ('ai.inputSendBusy', 'AI 正在处理中，请稍候…');
    } else if (reason === 'paste-busy') {
        msg = _i18nQ('ai.inputPasteBusy', '粘贴处理中，请稍候再发送');
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

// 直接展示一条警告 qoast（组装文案专用；不加冷却——内容为单条汇总，防重复弹靠调用方收敛）
function _limitQoastMsg(msg) {
    if (!msg) return;
    _lastLimitQoastTs = Date.now();
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

// ═══ 按下即冻结发送（Enter 与发送按钮共用唯一入口；2026-09-30）═══
// 核心语义：按下的那一瞬，编辑框全部内容（文字 + pendingImages 快照）就地冻结成消息，编辑条同步清空——
// 此后窗口内的一切操作（删图/贴新图/打字/切 quest）都与本条消息无关：本条用快照，编辑条留给下一条。
// 失败回滚（管线拒绝/楼层创建失败）由 panel-pipeline._restoreImagesToStrip 把图片放回编辑条。
function _freezeAndSendFromInput() {
    var _txtNow = $input.value;
    var _imgsNow = (typeof pendingImages !== 'undefined' && pendingImages.length > 0)
        ? pendingImages.map(function (img) { return { id: img.id, base64: img.base64, dataUrl: img.dataUrl, fileName: img.fileName || '' }; })
        : [];
    var _hasText = !!(_txtNow && _txtNow.trim());
    // 空消息（无文字无图）→ 零副作用（不消费/不建楼；旧路径被管线空值校验静默丢弃）
    if (!_hasText && _imgsNow.length === 0) return;
    // ① 气泡 + 图行即时回显（零 IPC；渲染异常整步回滚，编辑框/图片条零损失）
    var _bubble = null;
    var _rowEl = null;
    try {
        _bubble = addMessageEl('user', _txtNow);
        if (_bubble && _imgsNow.length > 0 && typeof _renderBubbleImgRow === 'function') {
            _rowEl = _renderBubbleImgRow(_bubble, _imgsNow);
        }
    } catch (_fb) {
        try { if (_bubble && _bubble.remove) _bubble.remove(); } catch (_) { }
        try { if (_rowEl && _rowEl.parentNode) _rowEl.parentNode.removeChild(_rowEl); } catch (_) { }
        if ($input.value !== _txtNow) $input.value = _txtNow;
        return;
    }
    // （2026-10-01 修订）气泡/图行引用不再走全局槽——随 sendMessage 载荷随身传入（见下方 ③）。
    //   旧全局槽（__qqq_userBubbleEl/ImgRow/Q）在多 quest 并行链下会被后一次冻结覆盖 →
    //   本条预建气泡变孤儿 + 重复新建；随身引用天然归属本意图，零串号。
    // ② 同步清空编辑框 + 图片条（内容已移入消息；图片条清空 = 「✕ 删掉在飞图片」的竞态窗口结构性闭合）
    if (_txtNow !== '') $input.value = '';
    _clearDraftTextNow(questActiveId);  // 发送即清高频草稿键（防断电窗口旧文本复活）
    if ($input._resetUndo) $input._resetUndo();
    if (_imgsNow.length > 0) {
        pendingImages = [];
        renderImageStrip();
    }
    if (typeof autoResizeInput === 'function') autoResizeInput();
    if (typeof updateQueueBtn === 'function') updateQueueBtn();
    if (typeof $input.focus === 'function') $input.focus();
    // ③ 入链（快照 + 气泡/图行引用随行——管线只管用快照，永不再读编辑条）
    sendMessage(_txtNow, {
        images: (_imgsNow.length > 0) ? _imgsNow : null,
        bubbleEl: _bubble || null,        // ★ 2026-10-01 随身引用：跨 quest 并行链零串号（替代旧全局槽）
        bubbleImgRow: _rowEl || null
    });
}

// Enter to send
$input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (_switching) return;  // ★ quest 切换中 → 禁止一切操作
        // ★ 2026-10-03：静默档补可见反馈——「按回车没反应」黑洞根治（q401 事故实锤）；3s 节流防刷屏
        if (_sending) { _limitQoast('send-busy'); return; }
        if (_activeAgent && _activeAgent._compressing) { _limitQoast('send-busy'); return; }
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
            try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show(_qq('ai.needLogin', '请先在菜单栏点击登录'), { type: 'warning', duration: 6000 }); } catch (_e2) { }
            return;
        }
        // ★ 粘贴在飞拦截（2026-09-30）：大图/剪贴板读取处理中按回车 → 图尚未入条，本条会静默漏图。
        //   同步拦下（内容零消费），处理完成后再发送即可带上图片。
        if (_pasteInFlight > 0) { _limitQoast('paste-busy'); return; }
        // ★ 按下即冻结（2026-09-30 重构）：文本+图片在按下的同一同步段冻结为消息快照 → 气泡（含图行）即时回显
        //   → 同步清空编辑框/图片条 → 快照随 intent 入链。管线阶段永不再读编辑条。
        //   旧缺陷（q386 f1 实锤）：图片不冻结、留给 _executeSend 在晋升/附件处理之后「活读」→
        //   窗口内点 ✕ 删图 = 静默丢图；窗口内贴新图被本条顺走；窗口内打字被迟到清理擦除。
        _freezeAndSendFromInput();
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

// ══ 多图粘贴硬帽（2026-10-05 重构：原图直通，仅在会撞硬限时才重编码）══
// 口径：识图服务对单条 data-uri 有 20MiB 上限（≈ 文件 14MiB，实测边界）；链路单请求 ≈50MiB。
// 所以废除「>2MB 一律压 2048」的画质预损——阈值内原图直通；越界就近重编码（保最大分辨率，
// JPEG 白底 q0.92 起、带透明通道优先 PNG）；仅 >64MiB 才跳过（FileReader 全量读入内存硬帽）。
var PASS_MAX_BYTES = 14 * 1024 * 1024;   // 直通上限：文件字节（base64 ≈19.5MB，贴 data-uri 20MiB 上限内留余量）
var PASS_MAX_EDGE = 16384;               // 直通上限：长边像素（超 → 等比重编码）
var PASS_MAX_PIXELS = 64 * 1000 * 1000;  // 直通上限：总面积 64MP（防解码内存炸弹；超 → 重编码）
var HARD_LOAD_BYTES = 64 * 1024 * 1024;  // 读取硬帽：>64MiB 直接跳过（全量读入内存，防卡死/OOM）
var ENC_TARGET_B64 = 19200000;           // 重编码目标：base64 字符数（20MiB 上限内留足余量）
var _IMG_STEP_TIMEOUT = 90000;           // 单步超时：读取/解码/头部嗅探（防粘贴链被挂死 promise 永久堵死）
var _pasteChain = Promise.resolve();     // 粘贴串行队列：防快速连按 Ctrl+V 并发乱序
var _pasteInFlight = 0;                  // ★ 2026-09-30：粘贴/拖放处理在飞计数（>0 时发送入口一律拦下——内容尚未入条）

// 粘贴队列入口：所有异步粘贴路径（Ctrl+V / 右键菜单）串行执行
function _enqueuePaste(fn) {
    _pasteChain = _pasteChain.then(fn, fn);
    return _pasteChain;
}

// ★ 处理在飞包装（唯一实现，2026-09-30）：粘贴/拖放处理期间 _pasteInFlight > 0，
//   发送入口（Enter/发送按钮/队列/引导）据此拦下——图/文件尚未入条时发送会静默漏内容。
//   成功/失败/同步抛错三路径都保证计数归还。
function _enqueuePasteBusy(fn) {
    return _enqueuePaste(function () {
        _pasteInFlight++;
        var _p;
        try { _p = fn(); } catch (e) { _pasteInFlight = Math.max(0, _pasteInFlight - 1); throw e; }
        return Promise.resolve(_p).then(
            function (r) { _pasteInFlight = Math.max(0, _pasteInFlight - 1); return r; },
            function (e) { _pasteInFlight = Math.max(0, _pasteInFlight - 1); throw e; }
        );
    });
}

// 单步超时包装（2026-10-05）：粘贴链任何一环挂死不得永久占住串行队列
// （旧症状：一次读取/解码卡死 → 后续所有 Ctrl+V 全哑 + 发送恒被 paste-busy 拦下，无看门狗可救）
function _withStepTimeout(p, ms, tag) {
    return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
            if (done) return; done = true;
            reject(new Error(tag + ' timed out'));
        }, ms);
        Promise.resolve(p).then(
            function (v) { if (done) return; done = true; clearTimeout(timer); resolve(v); },
            function (e) { if (done) return; done = true; clearTimeout(timer); reject(e); }
        );
    });
}

function _readAsDataURL(blob) {
    return _withStepTimeout(new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error || new Error('read failed')); };
        r.readAsDataURL(blob);
    }), _IMG_STEP_TIMEOUT, 'read');
}

function _loadImage(src) {
    return _withStepTimeout(new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('img decode failed')); };
        img.src = src;
    }), _IMG_STEP_TIMEOUT, 'decode');
}

// ══ 图片头部嗅探（只读 ≤64KB，不整图解码）——拿宽高/透明通道 ══
// 返回 {w,h,alpha} 或 null（识别不了 → 走解码探测回退）
async function _sniffImageDims(blob) {
    try {
        var buf = await _withStepTimeout(blob.slice(0, 65536).arrayBuffer(), 15000, 'sniff');
        var b = new Uint8Array(buf), n = b.length;
        function u16(o) { return (b[o] << 8) | b[o + 1]; }
        function u32(o) { return b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
        // PNG
        if (n >= 26 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
            var ct = b[25];
            return { w: u32(16), h: u32(20), alpha: (ct === 4 || ct === 6) };
        }
        // GIF
        if (n >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
            return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8), alpha: true };
        }
        // JPEG：扫段找 SOF
        if (n >= 4 && b[0] === 0xFF && b[1] === 0xD8) {
            var i = 2;
            while (i + 9 < n) {
                if (b[i] !== 0xFF) { i++; continue; }
                var m = b[i + 1];
                if (m === 0xFF) { i++; continue; }
                if (m === 0x01 || (m >= 0xD0 && m <= 0xD9)) { i += 2; continue; }
                if (m === 0xDA) break;
                var len = (b[i + 2] << 8) | b[i + 3];
                if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
                    return { w: u16(i + 7), h: u16(i + 5), alpha: false };
                }
                i += 2 + len;
            }
            return null;
        }
        // WebP（VP8X 需读到 b[29]；VP8/VP8L 更短，统一 n ≥ 30 门槛）
        if (n >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
            var cc = String.fromCharCode(b[12], b[13], b[14], b[15]);
            if (cc === 'VP8X') {
                return {
                    w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
                    h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
                    alpha: !!(b[20] & 0x10)
                };
            }
            if (cc === 'VP8L') {
                return {
                    w: 1 + ((b[21] | (b[22] << 8)) & 0x3FFF),
                    h: 1 + ((((b[22] >> 6) | (b[23] << 2) | (b[24] << 10)) & 0x3FFF)),
                    alpha: true
                };
            }
            if (cc === 'VP8 ') {
                return { w: (b[26] | (b[27] << 8)) & 0x3FFF, h: (b[28] | (b[29] << 8)) & 0x3FFF, alpha: false };
            }
            return null;
        }
        // BMP
        if (n >= 26 && b[0] === 0x42 && b[1] === 0x4D) {
            var bw = b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24);
            var bh = b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24);
            return { w: bw, h: Math.abs(bh), alpha: false };
        }
        return null;
    } catch (_) { return null; }
}

// ══ 重编码（越界路径）：保最大分辨率，压回链路安全区 ══
// 透明通道优先 PNG（保住 alpha）；PNG 两轮仍压不动 → JPEG 白底（防透明区变黑）
function _encodeScaled(img, scale, usePng, quality) {
    var w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    var h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    if (!usePng) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    return usePng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
}
function _reencodeToTarget(img, hasAlpha) {
    var w0 = img.naturalWidth || 0, h0 = img.naturalHeight || 0;
    var edge = Math.max(w0, h0) || 1;
    var px = (w0 * h0) || 1;
    var scale = Math.min(1, PASS_MAX_EDGE / edge, Math.sqrt(PASS_MAX_PIXELS / px));
    var quality = 0.92;
    var usePng = !!hasAlpha;
    var out = '';
    for (var step = 0; step < 6; step++) {
        out = _encodeScaled(img, scale, usePng, quality);
        var b64len = ((out.split(',')[1]) || '').length;
        if (b64len <= ENC_TARGET_B64) return out;
        if (usePng) {
            if (step >= 1) { usePng = false; quality = 0.9; continue; }
            scale *= 0.8;
            continue;
        }
        if (quality > 0.5) { quality -= 0.1; }
        else { scale *= 0.75; quality = 0.82; }
    }
    return out;
}

// 单张图片处理（2026-10-05 重构）：原图直通优先，只有会撞链路/内存/服务硬限时才重编码
// 返回 {added:true} 或 {skipped:'size'|'fail'|'cap'}
async function _processImageFile(blob) {
    if (blob.size > HARD_LOAD_BYTES) return { skipped: 'size' };
    try {
        var dims = await _sniffImageDims(blob);
        var dataUrl = null, img = null;
        // 头部拿不到尺寸的格式（AVIF/SVG 等）→ 解码探测兜底
        if (!dims || !(dims.w > 0) || !(dims.h > 0)) {
            dataUrl = await _readAsDataURL(blob);
            img = await _loadImage(dataUrl);
            var w0 = img.naturalWidth || 0, h0 = img.naturalHeight || 0;
            if (!(w0 > 0 && h0 > 0)) {
                // SVG 等无 intrinsic size → 原样入条
                return addImage(dataUrl, dataUrl.split(',')[1] || '') ? { added: true } : { skipped: 'cap' };
            }
            dims = { w: w0, h: h0, alpha: false };
        }
        var over = blob.size > PASS_MAX_BYTES
            || Math.max(dims.w, dims.h) > PASS_MAX_EDGE
            || (dims.w * dims.h) > PASS_MAX_PIXELS;
        if (!over) {
            // 直通：不做整图解码（超大位图解码是内存炸弹来源）；小文件（≤2MiB）做一次解码校验，坏图尽早如实报
            if (!dataUrl) {
                dataUrl = await _readAsDataURL(blob);
                if (blob.size <= 2 * 1024 * 1024) {
                    try { await _loadImage(dataUrl); } catch (_de) { return { skipped: 'fail' }; }
                }
            }
            return addImage(dataUrl, dataUrl.split(',')[1] || '') ? { added: true } : { skipped: 'cap' };
        }
        // 越界 → 重编码（保最大分辨率）
        if (!dataUrl) dataUrl = await _readAsDataURL(blob);
        if (!img) img = await _loadImage(dataUrl);
        var out = _reencodeToTarget(img, dims.alpha);
        return addImage(out, out.split(',')[1] || '') ? { added: true } : { skipped: 'cap' };
    } catch (_e) {
        return { skipped: 'fail' };
    }
}

// 批量粘贴图片：槽位上限裁剪 + 逐张串行保序 + 失败隔离 + 单条分桶汇总提示（2026-10-05）
// 分桶语义（各自如实、不再互相冒充）：cap=槽位满 / size=超出体积硬帽（>64MiB）/ fail=无法读取（损坏或超时）
async function _pasteImages(imageFiles) {
    if (!imageFiles || imageFiles.length === 0) return;
    var slot = MAX_IMAGES - pendingImages.length;
    var toProcess = imageFiles;
    var capDropped = 0;
    if (slot <= 0) {
        _pasteSkipQoast(imageFiles.length, 0, 0);
        return;
    } else if (imageFiles.length > slot) {
        capDropped = imageFiles.length - slot;
        toProcess = imageFiles.slice(0, slot);
    }
    var sizeSkip = 0, failSkip = 0;
    for (var k = 0; k < toProcess.length; k++) {
        try {
            var r = await _processImageFile(toProcess[k]);
            if (!r || !r.added) {
                if (r && r.skipped === 'size') sizeSkip++;
                else if (r && r.skipped === 'cap') capDropped++;
                else failSkip++;
            }
        } catch (_e) { failSkip++; }
    }
    if (capDropped || sizeSkip || failSkip) _pasteSkipQoast(capDropped, sizeSkip, failSkip);
}

// 粘贴跳过汇总（唯一实现）：组装成单条 qoast（防「槽位满 + 超大小」各弹一条）
function _pasteSkipQoast(capN, sizeN, failN) {
    var parts = [];
    if (capN > 0) parts.push(_i18nQ('ai.inputLimitQoastImageCap', '图片已达上限（{0} 张），多余图片未粘贴').replace('{0}', String(MAX_IMAGES)));
    if (sizeN > 0) parts.push(_i18nQ('ai.inputLimitQoastImageSize', '有 {0} 张图片超出单张大小上限，已跳过').replace('{0}', String(sizeN)));
    if (failN > 0) parts.push(_i18nQ('ai.inputLimitQoastImageFail', '有 {0} 张图片无法读取（格式不支持或已损坏），已跳过').replace('{0}', String(failN)));
    if (parts.length === 0) return;
    _limitQoastMsg(parts.join('；'));
}

function addImage(dataUrl, base64) {
    if (pendingImages.length >= MAX_IMAGES) return false;
    var id = pendingImages.length + 1;
    pendingImages.push({ id: id, base64: base64, dataUrl: dataUrl });
    renderImageStrip();
    _scheduleDraftSave(true);  // ★ 图片变更 → 完整快照（低频，1.2s 合并）
    return true;
}

function removeImage(idx) {
    var _removedId = (pendingImages[idx] && typeof pendingImages[idx].id === 'number') ? pendingImages[idx].id : null;
    pendingImages.splice(idx, 1);
    pendingImages.forEach(function (img, i) { img.id = i + 1; });
    // ★ 2026-09-30 令牌同步：删除的图 → 编辑框里它的 [img:N] 令牌一并移除；其余图前移重编号 → 令牌改指新号。
    //   否则残留令牌指向不存在的图（AI 收到暗号白找）或错指别的图（删图后序号重排）。
    if (_removedId != null) _syncImgTokensAfterRemove(_removedId);
    renderImageStrip();
    _scheduleDraftSave(true);  // ★ 图片变更 → 完整快照（低频，1.2s 合并）
}

// 删除图 N 后的令牌校正（唯一实现）：[img:N] 移除；[img:M>N] → [img:M-1]。光标按替换量平移，零落点跳变。
function _syncImgTokensAfterRemove(removedId) {
    try {
        var _nativeGet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').get;
        var _nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        var _cur = _nativeGet.call($input);
        if (!_cur || _cur.indexOf('[img:') === -1) return;
        var _sel = ($input.selectionStart === null || $input.selectionStart === undefined) ? _cur.length : $input.selectionStart;
        var _delta = 0;
        var _newVal = _cur.replace(/\[img:(\d+)\]/g, function (m, d, off) {
            var _d = parseInt(d, 10);
            if (_d === removedId) {
                if (off < _sel) _delta -= m.length;
                return '';
            }
            if (_d > removedId) {
                var _nm = '[img:' + (_d - 1) + ']';
                if (off < _sel) _delta += (_nm.length - m.length);
                return _nm;
            }
            return m;
        });
        if (_newVal === _cur) return;
        _nativeSet.call($input, _newVal);
        var _newSel = Math.max(0, Math.min(_newVal.length, _sel + _delta));
        try { $input.setSelectionRange(_newSel, _newSel); } catch (_) { }
        if (typeof autoResizeInput === 'function') autoResizeInput();
        if ($input._resetUndo) $input._resetUndo();
    } catch (_) { }
}

// ══ 剪贴板文件附加（唯一实现，2026-10-05）：非图片文件 → 📎"path" 锚点（多选按序，与拖放同语义）══
// 路径解析：① 事件的 File.path（Electron）→ ② 系统剪贴板文件表直读（CF_HDROP，子毫秒、覆盖目录/多选）
async function _attachClipboardFiles(files) {
    var paths = [];
    for (var i = 0; i < files.length; i++) {
        try { if (files[i].path) paths.push(String(files[i].path)); } catch (_) { }
    }
    if (paths.length < files.length) {
        try {
            var b = (window.parent && window.parent.qqqideBridge) || window.qqqideBridge;
            if (b && b.clipboard && b.clipboard.readFiles) {
                var more = await _withStepTimeout(b.clipboard.readFiles(), 10000, 'clipFiles');
                if (more && more.length) {
                    for (var j = 0; j < more.length; j++) {
                        if (paths.indexOf(more[j]) === -1) paths.push(more[j]);
                    }
                }
            }
        } catch (_) { }
    }
    if (paths.length === 0) {
        _limitQoastMsg(_i18nQ('ai.inputLimitQoastFilePath', '有 {0} 个文件无法获取路径，未附加').replace('{0}', String(files.length)));
        return;
    }
    if (typeof insertChipAtCursor !== 'function') return;
    var b2 = (window.parent && window.parent.qqqideBridge) || window.qqqideBridge;
    for (var k = 0; k < paths.length; k++) {
        try {
            var isDir = null;
            if (b2 && b2.fs && b2.fs.stat) {
                try { var st = await b2.fs.stat(paths[k]); isDir = !!(st && st.isDir); } catch (_) { isDir = null; }
            }
            insertChipAtCursor(paths[k], isDir, null);
        } catch (_) { }
    }
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
        wrap.appendChild(imgEl);        var num = document.createElement('span');
        num.className = 'img-thumb-num';
        num.textContent = '#' + img.id;
        num.onclick = function (e) {
            e.stopPropagation();
            // 翻页上下文 = 编辑框图片条（拟发送批次，按条内顺序）
            var _nav = null;
            try {
                if (pendingImages.length > 1) {
                    _nav = { list: pendingImages.map(function (im) { return { src: im.dataUrl, localPath: null }; }), index: idx };
                }
            } catch (_) { }
            openLightbox(img.dataUrl, img.base64, null, _nav);
        };
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

// ═══ 纯文本插入（唯一实现，2026-10-03）：Ctrl+V / 右键菜单 / 外拖文本 三条入口共用 ═══
// 口径：光标处插入（有选区则替换，与原生粘贴一致）；字符上限硬帽（超出截断 + qoast）；resize/progress 同步。
function _insertPlainText(text) {
    if (!text) return;
    // ★ 直接用原生 getter 读当前值（绕过自定义属性，绝对可靠）
    var nativeGet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').get;
    var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    var cur = nativeGet.call($input);
    var selStart = $input.selectionStart || 0;
    var selEnd = $input.selectionEnd || 0;
    var before = cur.substring(0, selStart);
    var after = cur.substring(selEnd);
    var available = INPUT_CAP_CHARS - before.length - after.length;
    if (available <= 0) { _limitQoast('paste-full'); return; }
    var wasTruncated = text.length > available;
    var insertText = wasTruncated ? text.substring(0, available) : text;
    // ★ 用原生 setter 直设值，然后手动触发 resize + progress
    nativeSet.call($input, before + insertText + after);
    $input.setSelectionRange(selStart + insertText.length, selStart + insertText.length);
    autoResizeInput();
    _updateInputProgress();
    if (wasTruncated) _limitQoast('paste-truncated');
}

// 粘贴图片（多图全量收集 + 串行保序 + 直通/重编码硬帽）/ 纯文本 / 文件锚点粘贴
$input.addEventListener('paste', function (e) {
    // ★ 铁律：任何粘贴一律先阻止原生行为，再由我们手动插入
    e.preventDefault();

    // ★ 同步收集剪贴板（clipboardData 仅事件回调内有效，必须同步读）
    var plainText = '';
    var imageFiles = [];
    var otherFiles = [];   // ★ 2026-10-05：非图片文件（资源管理器复制的文件/文件夹）→ 📎 锚点附加
    try {
        var cd = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
        if (!cd) return;
        plainText = cd.getData('text/plain') || '';
        var items = cd.items;
        if (items) {
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it.kind === 'file') {
                    var f = it.getAsFile();
                    if (!f) continue;
                    if (it.type && it.type.indexOf('image/') === 0) imageFiles.push(f);
                    else otherFiles.push(f);
                }
            }
        }
    } catch (_) { return; }

    // ★ 串行队列：快速连按 Ctrl+V 时逐次处理，防并发乱序/超限（busy 包装：处理期间发送入口拦截）
    _enqueuePasteBusy(async function () {
        // 图片分支：串行处理保序（原图直通硬帽 + 越界重编码）
        if (imageFiles.length > 0) {
            await _pasteImages(imageFiles);
        }

        // 纯文本分支：硬上限保护（唯一插入机 _insertPlainText——右键菜单/外拖文本同源）
        if (plainText) _insertPlainText(plainText);

        // 文件分支（2026-10-05）：非图片文件 → 📎 锚点附加（与拖放同语义；路径经系统剪贴板文件表直读）
        if (otherFiles.length > 0) {
            await _attachClipboardFiles(otherFiles);
        }
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
        // ★ 串行队列：与 Ctrl+V 共用同一队列，防并发乱序（busy 包装：处理期间发送入口拦截）
        _enqueuePasteBusy(async function () {
        // ★ 先尝试读剪贴板图片（navigator.clipboard.read 支持 text+image）——15s 超时兜底（防挂死堵住串行队列）
        var imageBlobs = [], txt = '';
        try {
            var items = await _withStepTimeout(navigator.clipboard.read(), 15000, 'clipboard.read');
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
                    txt = await _withStepTimeout(b.clipboard.readText(), 8000, 'clipboard.readText');
                } else {
                    txt = await _withStepTimeout(navigator.clipboard.readText(), 8000, 'clipboard.readText');
                }
            } catch (_2) { return; }
        }

        // 图片分支：复用 _pasteImages（串行保序 + 直通/重编码硬帽）
        if (imageBlobs.length > 0) {
            await _pasteImages(imageBlobs);
        }

        // 纯文本分支（图片+文本共存时，图片先入条，文本走此分支插入一次；唯一插入机同源）
        if (!txt) return;
        _insertPlainText(txt);
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
    // ★ 2026-10-03：静默档补可见反馈（与 Enter 同规）
    if (_activeAgent && _activeAgent._compressing) { _limitQoast('send-busy'); return; }

    if (_activeAgent && _activeAgent._stopState === 'fatal' && !streaming) {
        if (typeof _capRedBoxAndSeal === 'function') _capRedBoxAndSeal();
        return;
    }

    if (streaming) { stopStream(); }
    // ★ 2026-10-03：静默档补可见反馈——旧实现直接 return，点发送零反应（q401 事故实锤）
    else if (_activeAgent && _activeAgent._stopState === 'sending') { _limitQoast('send-busy'); return; }
    else {
        // ★ 发送活跃检查：同 quest 忙 → 拒（内容保留编辑框）；不同 quest 三翼并发不受阻
        if (typeof _sendActive === 'function' && _sendActive(questActiveId)) {
            _limitQoast('send-busy');  // ★ 2026-08-11: 拦截 → 节流提示
            return;
        }
        // ★ 登录闸门（2026-09-30）：按下即冻结会消费编辑框——未登录必须在冻结前拦截（与 Enter 同规）
        if (!_isLoggedIn()) {
            try { if (window.parent && window.parent.qqqideQoast) window.parent.qqqideQoast.show(_qq('ai.needLogin', '请先在菜单栏点击登录'), { type: 'warning', duration: 6000 }); } catch (_e2) { }
            return;
        }
        // ★ 粘贴在飞拦截（2026-09-30，与 Enter 同规）：处理中不消费
        if (_pasteInFlight > 0) { _limitQoast('paste-busy'); return; }
        // ★ 按下即冻结（与 Enter 共用唯一入口）
        _freezeAndSendFromInput();
    }
};

// ═══ 断电安全草稿高频落盘（2026-08-26）═══
// 根因：编辑框内容原先仅 saveQuestUIState（切 quest/关闭/发送）时落盘，
//       连续打字期间只在内存 → 断电（beforeunload 不执行）全丢。
// 设计（性能最优）：
//   text 通道：800ms 节流写 ai.draftText.{panelId}（纯文本几 KB，零图片负载），
//              走 onlyStore 延迟刷盘（500ms 空闲/3s 强制）→ 断电最多丢最后 ~3s
//   full 通道：图片增删（低频）1.2s 节流写完整快照（setNow，一次性成本可接受）
//   merge：panel-quest.js 启动恢复时 draftText 覆盖 ai.uiStates 的 inputValue
//   清理：发送/晋升/删除时 _clearDraftTextNow 删键，防断电窗口旧文本复活
var _draftSaveTimer = null;
var _draftSaveFull = false;
var _draftTextCache = null;      // 会话内高频草稿 map 缓存（首次读 DB，之后纯内存）
var _draftTextLoaded = false;

// 首次读 DB，之后纯内存（避免每 800ms 一次 IPC 读）
async function _ensureDraftTextMap() {
    if (_draftTextLoaded) return _draftTextCache || {};
    try {
        var _m = await onlyStore.getAsync('ai.draftText.' + _panelId);
        _draftTextCache = (_m && typeof _m === 'object') ? _m : {};
    } catch (_) { _draftTextCache = {}; }
    _draftTextLoaded = true;
    return _draftTextCache;
}

function _scheduleDraftSave(full) {
    if (full) _draftSaveFull = true;
    if (_draftSaveTimer) { clearTimeout(_draftSaveTimer); _draftSaveTimer = null; }
    _draftSaveTimer = setTimeout(function () {
        _draftSaveTimer = null;
        var _fullNow = _draftSaveFull;
        _draftSaveFull = false;
        if (_fullNow) {
            if (typeof saveQuestUIState === 'function') saveQuestUIState(questActiveId);
        } else {
            _saveDraftText();
        }
    }, full ? 1200 : 800);
}

// 轻量文本草稿保存（仅文本，不含图片 base64）
async function _saveDraftText() {
    if (!questActiveId) return;
    try {
        if (!questUIStates[questActiveId]) questUIStates[questActiveId] = {};
        questUIStates[questActiveId].inputValue = $input.value;
        if (typeof $input.selectionStart === 'number') {
            questUIStates[questActiveId].inputCaret = $input.selectionStart;
        }
        var _m = await _ensureDraftTextMap();
        _m[questActiveId] = $input.value;
        if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
            onlyStore.set('ai.draftText.' + _panelId, _m);
        }
        if (typeof _updateDraftFlag === 'function') _updateDraftFlag(questActiveId);
    } catch (_) { }
}

// 同步清除某 quest 的高频草稿键（发送/晋升/删除时调用，防断电恢复旧文本）
async function _clearDraftTextNow(id) {
    if (!id) return;
    try {
        var _m = await _ensureDraftTextMap();
        if (_m[id] !== undefined) {
            delete _m[id];
            if (typeof onlyStore !== 'undefined' && onlyStore.isInited()) {
                onlyStore.set('ai.draftText.' + _panelId, _m);
            }
        }
    } catch (_) { }
}
