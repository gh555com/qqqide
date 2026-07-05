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

// ★ A 按钮：弹出信息框，不再选中
document.getElementById('tier-a').onclick = function () { _openTierPopup(); };
document.querySelectorAll('.tier-btn[data-tier]').forEach(function (btn) {
    btn.onclick = function () { selectTier(parseInt(btn.dataset.tier)); };
});

// ── Tier Info 弹出框 ──
var _tierOverlay = null, _tierPanel = null, _tierExpanded = false;

function _ensureTierPopup() {
    if (_tierOverlay) return;

    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var bg = isDark ? '#1e1e1e' : '#fdf6e3';
    var text = isDark ? '#dcd8d0' : '#656360';
    var textDim = isDark ? '#6a6660' : '#a8a6a2';
    var border = isDark ? '#333333' : '#d3c6aa';
    var accent = isDark ? '#d4a017' : '#e8a030';

    _tierOverlay = document.createElement('div');
    _tierOverlay.className = 'tier-info-overlay';
    _tierOverlay.style.cssText = 'display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.45); z-index:9998;';
    _tierOverlay.addEventListener('click', function (e) {
        if (e.target === _tierOverlay) _closeTierPopup();
    });

    _tierPanel = document.createElement('div');
    _tierPanel.className = 'tier-info-panel';
    _tierPanel.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:520px; max-width:92vw; max-height:82vh; overflow-y:auto; z-index:9999; padding:0; border-radius:6px; box-shadow:0 8px 32px rgba(0,0,0,0.35); background:' + bg + '; color:' + text + ';';

    _tierOverlay.appendChild(_tierPanel);
    document.body.appendChild(_tierOverlay);
}

function _openTierPopup() {
    _ensureTierPopup();
    _tierExpanded = false;
    _renderTierPopup();
    _tierOverlay.style.display = 'block';
}

function _closeTierPopup() {
    if (_tierOverlay) _tierOverlay.style.display = 'none';
}

function _expandTierPopup() {
    _tierExpanded = true;
    _renderTierPopup();
    _tierPanel.scrollTop = 0;
}

function _renderTierPopup() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var bg = isDark ? '#1e1e1e' : '#fdf6e3';
    var text = isDark ? '#dcd8d0' : '#656360';
    var textDim = isDark ? '#6a6660' : '#a8a6a2';
    var border = isDark ? '#333333' : '#d3c6aa';
    var accent = isDark ? '#d4a017' : '#e8a030';
    var red = isDark ? '#ff4444' : '#dc322f';

    var html = '';
    // 标题行
    html += '<div style="padding:14px 20px; border-bottom:1px solid ' + border + '; display:flex; align-items:center; justify-content:space-between;">';
    html += '<span style="font-size:15px; font-weight:bold; color:' + text + ';">AI 等级说明</span>';
    html += '<button onclick="_closeTierPopup()" style="width:24px; height:24px; border:1px solid ' + border + '; border-radius:3px; background:transparent; color:' + textDim + '; font-size:14px; line-height:22px; text-align:center;">✕</button>';
    html += '</div>';

    html += '<div style="padding:16px 20px; font-size:13px; line-height:1.9;">';

    if (!_tierExpanded) {
        // ── 收拢态 ──
        html += '<div style="margin-bottom:12px;"><b style="color:' + accent + ';">1档：</b>最低智能，快、便宜。</div>';
        html += '<div style="margin-bottom:14px;"><b style="color:' + accent + ';">6档：</b>最高智能，慢、贵。</div>';
        html += '<div style="margin-bottom:4px;">qqqide 不再提供自动换挡功能，';
        html += '<span id="tier-reason-link" style="color:' + red + '; text-decoration:underline; cursor:pointer;">理由</span>';
        html += '</div>';
    } else {
        // ── 展开态：完整说明 ──
        html += '<div style="margin-bottom:10px;"><b style="color:' + accent + ';">1档：</b>最低智能，快、便宜。</div>';
        html += '<div style="margin-bottom:14px;"><b style="color:' + accent + ';">6档：</b>最高智能，慢、贵。</div>';
        html += '<div style="margin-bottom:10px;">qqqide 不再提供自动换挡功能，理由：</div>';

        html += '<div style="color:' + textDim + '; line-height:1.8;">';
        html += '<p style="margin-top:0;">为了方便你理解，我们划分出了如下架构：</p>';
        html += '<p style="text-align:center; font-weight:bold; color:' + text + ';">project → quest → floor → house → room</p>';
        html += '<p>一个 project 就是一个项目你也可以理解为就是一个文件夹，一个 quest 就是一个任务，你可以在一个任务里盖多层楼，你每发送出去一次消息就等于是盖了一层楼，也就是一个 floor，那你同时可以开多个任务（quest），每一个任务又可以盖多层楼，这很好理解。</p>';
        html += '<p>而在你看不到的后台，其实每一层楼都会跟服务器往返多次消息，也就是表面上你只按了一次发送，但实际上会做多次发送、和接收。</p>';
        html += '<p>为什么会那样？假想一种情况，比如你让服务器改一个超大项目的代码，服务器大概会多次返回查询指定代码的指令，以尽可能地了解你的本地代码，服务器的这种要求可以并行也可以串行，对于串行，服务器发送一个指令回来，你本地接收指令、按指令查询指令要求的代码（结果），再将结果发送回服务器，这样的一来一回我们叫做一个 <b>house</b>。</p>';
        html += '<p>而实际上，服务器可以一次提出多个要求，也就是服务器送回一次消息，你本地会「并行地」去执行多个指令，那么每一个指令我们叫他一个 <b>room</b>，每一个 room 返回一个结果，那看上去「多间 room」就组成了一个 house（对应了跟服务器的一来一回）。但非常重要的一点是，表面上看你只按了一次发送按钮：house 和 room 都是静默、自动地进行的（与服务器的交互）。</p>';
        html += '<p>最终看上去，一个 project 可以包含多个 quest，一个 quest 可以包含多个 floor，一个 floor 可以包含多个 house，一个 house 可以包含多个 room。</p>';
        html += '<p style="margin-top:18px;"><b style="color:' + text + ';">你可以休息一会儿，因为接下来就是重点。</b></p>';
        html += '<p>首先，你最难接受但必须接受的一个事实是：</p>';
        html += '<p style="font-weight:bold; border-left:3px solid ' + red + '; padding-left:12px; color:' + text + ';">别说 project 和 quest，哪怕是同一个 floor 里面的不同 house（对应物理上的一次服务器往返），它们请求的可能都是物理隔绝的服务器（大模型），简单讲就是，服务器那边即便有缓存，但你也要假设服务器那边根本不会存在任何关于你本次任务（project、quest 或 floor）的任何记忆，也就是你首先必须要颠覆的一点认知是：<span style="color:' + red + ';">AI 根本不存在记忆。</span></p>';
        html += '<p>那你可能好奇，AI 是怎么记住 50 层楼之前你们的聊天内容的？你很难接受但必须接受的事实是：每一间 house，也就是哪怕是最细分的一次服务器往返，你发送给服务器的，都尽可能地带上了你之前每一层楼的所有对话、甚至工具查询结果，注意，每一次最细分的服务器往返，代表你即便不是按发送按钮而是后台自动静默的 house 级别的往返，都会尽量带上之前的一切，更别说 floor 级别的发送。而「一切」是指从第一层楼到现在的一切对话、工具调用结果，那样的一个集合也就是「上下文」。</p>';
        html += '<p>你的第一个问题是，那为什么没有盖两层楼就把 1M 的上下文总空间撑爆，主要原因是，根据 IDE 的策略选择不同，即便最保守的 AI IDE，也不会把 200KB 的源代码查询结果直接放进上下文，实际上大概只会截取里面 2KB 的关键行代码，而其他的工具结果，比如日志，基本都会被做成摘要，同样回到 KB 级别。</p>';
        html += '<p>而且 AI IDE 基本都会有自己的压缩策略，qqqide 的压缩策略是保留最近 6 层楼的完整信息，假设压缩时在最近 6 层楼之前有 200 层楼，那那 200 层楼会被压缩成最大 32KB 的摘要。压缩是一次专门的 AI 请求，就比如给 AI 1M 的文本（上下文），要求 AI 总结，返回不超过 32KB 的文本。</p>';
        html += '<p>我希望这就解释了，为什么在一个 quest 里，当你楼修到第 5 层，你放着不管过半年回来，你再按一次发送按钮，AI 还能跟你接着聊（似乎之前的一切它都记得），即便过了半年、模型早已更新换代……因为大模型是无状态的（不会保存关于你的任何记录），而你每一次都会发送完整上下文（它们不是储存在你本地硬盘，就是储存在中转服务器的硬盘里）。</p>';
        html += '<p>你可能还有一点不相信：「AI（大模型）总应该记得些什么？」。没有，什么都不记得。你认为的那些「记得」，只是你本地硬盘或者中转服务器偷偷在记的「小本本」，下次按发送按钮小本本会一起发给 AI。</p>';
        html += '<p style="margin-top:18px;">ok，有了上面的认知，你可以得到第一个让你放心的结论：</p>';
        html += '<p style="font-weight:bold; border-left:3px solid ' + accent + '; padding-left:12px; color:' + text + ';">「无论怎样切换模型档位都不会导致记忆丢失」</p>';
        html += '<p>即：在任何时间点切换模型档位 → 记忆不会丢失 → 但会左右中间推论的质量。</p>';
        html += '<p style="margin-top:18px;">回到最原始的问题：qqqide 为什么不再提供自动换挡功能。</p>';
        html += '<p>答案有两点：</p>';
        html += '<p><b>1、</b>不能保证「用最高的智能去写最重要的代码」，我们知道这一点至关重要，但总会有边界情况。</p>';
        html += '<p><b>2、</b>自动换挡本质上是让最高智能的 AI 来评估问题复杂度（再来选择实际干活的 AI），但长远来看，每一层楼都会凭空增加至少一次「最高智能 AI」的调用，这是一笔长远账单，但如果反之，我们不用最高智能去做评估，又会增加第一点对应的风险。</p>';
        html += '<p style="font-weight:bold; margin-top:16px;">最终 qqqide 决定做一个更好用的换挡杆，将换挡权，百分百地只交在你手里。</p>';
        html += '</div>';
    }

    html += '</div>';

    _tierPanel.innerHTML = html;

    // 绑定「理由」链接（收拢态）
    if (!_tierExpanded) {
        var link = document.getElementById('tier-reason-link');
        if (link) link.onclick = _expandTierPopup;
    }
}

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
