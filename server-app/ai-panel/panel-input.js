'use strict';

// ── 排队按钮状态：有文字即可排队（不管 AI 是否在工作）──
function updateQueueBtn() {
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
// ① 所有鼠标点击 → 在 #input-area 或 #top-bar 内直接触发
document.addEventListener('mousedown', function (e) {
    if (_hasMainProject() || _selectingProject) return;
    var el = e.target;
    if (el.closest('#input-area') || el.closest('#top-bar')) {
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
var selectedTier = (typeof _getDefaultTier === 'function') ? _getDefaultTier() : 6;
function updateTierButtons(tierIndex) {
    document.querySelectorAll('.tier-btn').forEach(function (b) { b.classList.remove('sel'); });
    if (tierIndex === null || tierIndex === 0) {
        document.getElementById('tier-a').classList.add('sel');
    } else {
        var btn = document.querySelector('.tier-btn[data-tier="' + tierIndex + '"]');
        if (btn) btn.classList.add('sel');
    }
}

function selectTier(tierIndex) {
    selectedTier = tierIndex;
    updateTierButtons(tierIndex);
    if (questActiveId) {
        if (!questUIStates[questActiveId]) questUIStates[questActiveId] = {};
        questUIStates[questActiveId].selectedTier = tierIndex;
    }
}

// 初始化选中态
(function initTierUI() {
    selectTier((typeof _getDefaultTier === 'function') ? _getDefaultTier() : 6); // default, will be overridden by restoreQuestUIState
})();

document.getElementById('tier-a').onclick = function () { selectTier(null); };
document.querySelectorAll('.tier-btn[data-tier]').forEach(function (btn) {
    btn.onclick = function () { selectTier(parseInt(btn.dataset.tier)); };
});

// ═══ Token / 号池管理 ═══
var QQQ_KEY_POOL_KEY = 'qqq-ai-keys';  // JSON 数组 [{key, last429, addedAt}]
var QQQ_KEY_COOLDOWN_MS = 30000;        // 429 后冷却 30 秒

// 读取号池（兼容旧版单 key）
function _loadKeyPool() {
    try {
        var raw = localStorage.getItem(QQQ_KEY_POOL_KEY);
        if (raw) {
            var arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length) return arr;
        }
    } catch (_) { }
    // 兼容旧版：从 qqq-ai-token 迁移
    var old = localStorage.getItem('qqq-ai-token');
    if (old && old.trim()) {
        var pool = [{ key: old.trim(), addedAt: Date.now(), last429: 0 }];
        _saveKeyPool(pool);
        localStorage.removeItem('qqq-ai-token');
        return pool;
    }
    return [];
}

function _saveKeyPool(pool) {
    try { localStorage.setItem(QQQ_KEY_POOL_KEY, JSON.stringify(pool)); } catch (_) { }
}

// 获取一个可用的 key（跳过冷却中的 key），返回 { key, index }
function getTokenInfo() {
    var pool = _loadKeyPool();
    if (!pool.length) return { key: '', index: -1 };
    var now = Date.now();
    for (var i = 0; i < pool.length; i++) {
        var entry = pool[i];
        if (!entry.last429 || (now - entry.last429) >= QQQ_KEY_COOLDOWN_MS) {
            return { key: entry.key, index: i };
        }
    }
    // 全部在冷却中 → 返回冷却剩余最少的那个
    var bestIdx = 0;
    var bestRemain = Infinity;
    for (var j = 0; j < pool.length; j++) {
        var remain = (pool[j].last429 || 0) + QQQ_KEY_COOLDOWN_MS - now;
        if (remain < bestRemain) { bestRemain = remain; bestIdx = j; }
    }
    return { key: pool[bestIdx].key, index: bestIdx, cooldown: Math.max(0, Math.ceil(bestRemain / 1000)) };
}

// 向后兼容：原有调用方
function getToken() {
    return getTokenInfo().key;
}

// 标记当前 key 被 429（调用方在 _callGateway 中触发）
function markToken429(token) {
    var pool = _loadKeyPool();
    for (var i = 0; i < pool.length; i++) {
        if (pool[i].key === token) {
            pool[i].last429 = Date.now();
            _saveKeyPool(pool);
            return;
        }
    }
}

// 添加新 key 到号池
function addKeyToPool(newKey) {
    var pool = _loadKeyPool();
    newKey = newKey.trim();
    if (!newKey) return;
    // 去重
    for (var i = 0; i < pool.length; i++) {
        if (pool[i].key === newKey) return;
    }
    pool.push({ key: newKey, addedAt: Date.now(), last429: 0 });
    _saveKeyPool(pool);
}

// 移除 key
function removeKeyFromPool(key) {
    var pool = _loadKeyPool();
    var filtered = pool.filter(function (e) { return e.key !== key; });
    _saveKeyPool(filtered);
}

function saveToken(t) {
    addKeyToPool(t);
}

if ($tokenInput) $tokenInput.value = getToken() ? '••••••••' : '';
if ($tokenSave) $tokenSave.onclick = function () {
    if ($tokenInput) {
        var v = $tokenInput.value.trim();
        if (v && v !== '••••••••') {
            // 支持逗号/换行分隔多个 key
            var keys = v.split(/[,\n]+/).filter(function (k) { return k.trim(); });
            for (var ki = 0; ki < keys.length; ki++) {
                addKeyToPool(keys[ki]);
            }
            $tokenInput.value = '••••••••';
        }
    }
};

// ── 编辑框自适应高度：始终比内容多一行（最少两行），上限 333px ──
var _inputLineHeight = 0;
var _inputMaxHeight = 333;
function autoResizeInput() {
    var el = $input;
    if (!_inputLineHeight) {
        _inputLineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    }
    // 空键入 → 恢复默认两行高
    if (!el.value) {
        el.rows = 2;
        el.style.height = '';
        el.style.overflowY = 'hidden';
        return;
    }
    // 强制 rows=1 再 auto，让 scrollHeight = 真实内容高度（不被 rows 地板抬高）
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
}
$input.addEventListener('input', autoResizeInput);
// 兜底：程序改 value 时不触发 input 事件，劫持 value setter 自动调 autoResize
(function () {
    var _origValueDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (_origValueDesc && _origValueDesc.set) {
        var _origSet = _origValueDesc.set;
        Object.defineProperty($input, 'value', {
            get: function () { return _origValueDesc.get.call(this); },
            set: function (v) { _origSet.call(this, v); autoResizeInput(); },
            configurable: true, enumerable: true
        });
    }
})();
// 窗口大小变化或主题切换可能导致行高变化，重新计算
window.addEventListener('resize', function () { _inputLineHeight = 0; autoResizeInput(); });

// Enter to send
$input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (_switching) return;  // ★ quest 切换中 → 禁止一切操作
        if (_sending) return;
        if (_activeAgent && _activeAgent._compressing) return;
        if (streaming) { stopStream(); } else { sendMessage(); }
    }
});
// ══ 字符级 Undo/Redo（唯一真理逐字回退机器接管）══
if (window.qqqCharUndo) {
    window.qqqCharUndo.attach($input, { onChange: updateQueueBtn });
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

// 粘贴图片（> 2MB 自动压缩至 2048px 宽）/ 纯文本粘贴
$input.addEventListener('paste', function (e) {
    // 纯文本粘贴：如果有文本，先获取纯文本再处理图片
    var plainText = '';
    try {
        plainText = (e.clipboardData || window.clipboardData).getData('text/plain');
    } catch (_) { }

    // 检查是否有图片
    var hasImage = false;
    var items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.type.indexOf('image/') === 0) {
            hasImage = true;
            e.preventDefault();
            var file = item.getAsFile();
            var reader = new FileReader();
            reader.onload = function (ev) {
                var dataUrl = ev.target.result;
                if (file.size > 2 * 1024 * 1024) {
                    var img = new Image();
                    img.onload = function () {
                        var MAX_W = 2048;
                        var scale = img.width > MAX_W ? MAX_W / img.width : 1;
                        var canvas = document.createElement('canvas');
                        canvas.width = Math.round(img.width * scale);
                        canvas.height = Math.round(img.height * scale);
                        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                        var compressed = canvas.toDataURL('image/jpeg', 0.85);
                        addImage(compressed, compressed.split(',')[1]);
                    };
                    img.src = dataUrl;
                } else {
                    addImage(dataUrl, dataUrl.split(',')[1]);
                }
            };
            reader.readAsDataURL(file);
            break;
        }
    }
    // 无图片粘贴：强制纯文本（阻止富文本）
    if (!hasImage && plainText) {
        e.preventDefault();
        document.execCommand('insertText', false, plainText);
    }
});
$sendBtn.onclick = function () {
    if (_switching) return;  // ★ quest 切换中 → 禁止一切操作
    if (_activeAgent && _activeAgent._compressing) return;  // 压缩中 → 不响应
    if (streaming) { stopStream(); } else { sendMessage(); }
};
