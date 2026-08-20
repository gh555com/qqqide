// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';

// GATEWAY_URL 由 system-prompt.js 全局声明（先于本文件加载），此处不再重复

// ═══ 前向声明：被早期文件（panel-input.js）在加载时引用 ═══
// 真正的初始化在 panel-quest.js，var 重复声明安全无冲突
var questActiveId;
var questUIStates = {};

// ★ 前向声明：panel-quest-ui.js 定义，但 panel-floor.js / panel-quest.js 更早引用
//   var 重复声明安全，真正逻辑在 panel-quest-ui.js 中用 Object.defineProperty 覆盖
var _queueFallback = [];
var _queuePausedFallback = false;
var _queuePausedManualFallback = false; // ★ 人工暂停标志（2026-08-20）：仅暂停按钮置位，楼层完结/草稿清空绝不自动恢复
var _queueBusy = false;
var _qa = function () { return (typeof _activeAgent !== 'undefined' && _activeAgent); };
Object.defineProperty(window, '_queuePaused', {
    get: function () { return _qa() ? _qa()._queuePaused : _queuePausedFallback; },
    set: function (v) { if (_qa()) _qa()._queuePaused = v; else _queuePausedFallback = v; },
    enumerable: true, configurable: true
});
// ★ 人工暂停标志（2026-08-20）：与 _queuePaused 并存——
//   _queuePaused = 显示态（暂停/继续按钮）；_queuePausedManual = 暂停来源（人工 or 草稿自动）
//   草稿保护型自动暂停只置 _queuePaused；楼层完结/草稿清空时自动恢复（见 panel-pipeline 完结自愈 + panel-input updateQueueBtn）
Object.defineProperty(window, '_queuePausedManual', {
    get: function () { return _qa() ? _qa()._queuePausedManual : _queuePausedManualFallback; },
    set: function (v) { if (_qa()) _qa()._queuePausedManual = v; else _queuePausedManualFallback = v; },
    enumerable: true, configurable: true
});
var _queueSaveTimer = null;
var QUEUE_MAX = 3;
Object.defineProperty(window, '_queue', {
    get: function () { return _qa() ? _qa()._queue : _queueFallback; },
    set: function (v) { if (_qa()) _qa()._queue = v; else _queueFallback = v; },
    enumerable: true, configurable: true
});
// ★ 前向声明：panel-quest-ui.js 定义 renderQueueStrip，panel-quest.js 更早调用
function renderQueueStrip() { }

// State
//   _sending = derived getter（单一真相源：_activeAgent._stopState === 'sending'）
//   streaming = per-agent proxy（通过 _activeAgent 透明路由，后台 quest 流式不阻塞前台发送）
Object.defineProperty(window, 'streaming', {
    get: function () { return (typeof _activeAgent !== 'undefined' && _activeAgent) ? _activeAgent._streaming : false; },
    set: function (v) { if (typeof _activeAgent !== 'undefined' && _activeAgent) _activeAgent._streaming = v; },
    enumerable: true, configurable: true
});
// ★ 唯一真理机器：_sending 完全由 _activeAgent._stopState 派生，零存储，零 setter
//   _floorCompletedCleanly 守卫：防止已完成但未复位 stopState 的后台 agent 假报 sending
Object.defineProperty(window, '_sending', {
    get: function () { return !!(typeof _activeAgent !== 'undefined' && _activeAgent && _activeAgent._stopState === 'sending' && !_activeAgent._floorCompletedCleanly); },
    enumerable: true, configurable: true
});
var _renderPending = false;
var _scrollPending = false;

// ★ 面板 ID：从 URL ?panel=0(左) ?panel=1(中) ?panel=2(右)，默认 1(中)
var _panelId = (function () {
    try {
        var m = location.search.match(/panel=(\d)/);
        if (m) { var v = parseInt(m[1], 10); if (v >= 0 && v <= 2) return v; }
    } catch (_) { }
    return 1;
})();

// ═══ 跨窗口同步：窗口身份 + 通知总线 ═══
// ★ _windowId 持久化到 onlyStore（ai.panel.{panelId}.windowId），iframe 销毁重建不变
//   初始化阶段用临时 ID（onlyStore 就绪前不会用到 _windowId）
var _windowId = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '_p' + _panelId;
// _windowId 在 _initWorkspace 中从 onlyStore 恢复真实值（见 _restoreWindowId）

var _workspaceRoot = null;  // 当前工作空间（主文件夹路径）
var _syncUnsub = null;

// ★ workspace-scoped sync channel
function _syncChannel() {
    var s = (_workspaceRoot || '').replace(/[^a-zA-Z0-9]/g, '_');
    return 'qqq-sync:' + s;
}

function _getSyncBridge() {
    try {
        if (parent && parent.qqqideBridge && parent.qqqideBridge.sync) return parent.qqqideBridge.sync;
    } catch (_) { }
    return null;
}

function _broadcast(type, questId, extra) {
    var sb = _getSyncBridge();
    if (!sb || !_workspaceRoot) return;
    var msg = { type: type, questId: questId, windowId: _windowId };
    if (extra) Object.assign(msg, extra);
    try { sb.broadcast(_syncChannel(), msg); } catch (_) { }
}

// ═══ 父窗口 quest 所有权注册表（同步、零 TTL、不依赖 IPC/store） ═══
function _parentClaimQuest(questId) {
    try { if (parent && parent.__qqq_claimQuest) parent.__qqq_claimQuest(questId, _panelId); } catch (_) { }
}
function _parentReleaseQuest(questId) {
    try { if (parent && parent.__qqq_releaseQuest) parent.__qqq_releaseQuest(questId, _panelId); } catch (_) { }
}
// 同步查询：返回 panelId (0/1/2) 或 undefined
function _parentGetQuestOwner(questId) {
    try { if (parent && parent.__qqq_getQuestOwner) return parent.__qqq_getQuestOwner(questId); } catch (_) { }
    return undefined;
}
// ★ 原子申领：仅当 quest 无人持有时成功。消灭 check-then-claim 竞态窗口
function _parentTryClaimQuest(questId) {
    try { if (parent && parent.__qqq_tryClaimQuest) return parent.__qqq_tryClaimQuest(questId, _panelId); } catch (_) { }
    return false;
}
// ★ 中心机器：读取所有正在建楼的 questId 列表（跨面板共享，只读）

// ★ 全局默认 AI 等级：settings.js → qqqideDefaults → 兜底 3
//   改默认值只改 core/defaults.js
function _getDefaultTier() {
    try {
        if (parent && parent.window && parent.window.qqqSettings && parent.window.qqqSettings.get) {
            var t = parent.window.qqqSettings.get('ai.defaultTier');
            var n = parseInt(t, 10);
            if (n >= 1 && n <= 6) return n;
        }
    } catch (_) { }
    try {
        if (parent && parent.window &parent.window.qqqideDefaults) {
            return parent.window.qqqideDefaults['ai.defaultTier'];
        }
    } catch (_) { }
    return 3;
}

var _panelFocused = false;  // 当前面板是否获得焦点（金光边框 + 快捷键激活）

// ═══ 焦点边框：通知父窗口添加/移除金光 ═══
// ★ _panelFocused 仅管视觉（金光边框+快捷键）。子弹金色独立于焦点，由 _setBulletGold 管理。
function _setPanelFocus(on) {
    if (_panelFocused === on) return;
    _panelFocused = on;
    if (on) {
        document.body.classList.add('panel-focused');
    } else {
        document.body.classList.remove('panel-focused');
    }
    if (on) {
        try { parent.postMessage({ type: 'qqq-ai-panel-focused', panel: _panelId }, '*'); } catch (_) { }
    }
}

// ★ 子弹金色：与面板焦点解耦。代表「视口文件注入目标」，非窗口焦点。
// 获取焦点时自动设金、blur 不褪、仅当另一面板接管（defocus 消息）才褪金。
function _setBulletGold(on) {
    try {
        var _bi = document.querySelector('#bullet-btn img');
        if (_bi) {
            if (on) {
                if (document.documentElement.getAttribute('data-theme') === 'dark') {
                    // 暗主题：亮金（还原最初 OK 版本）
                    _bi.style.cssText = 'filter: invert(1) sepia(1) saturate(30) hue-rotate(335deg) !important';
                } else {
                    // 浅主题：深黄暗金，白底清晰
                    _bi.style.cssText = 'filter: invert(1) sepia(1) saturate(70) hue-rotate(330deg) brightness(0.55) !important';
                }
            } else {
                _bi.style.cssText = '';
            }
        }
    } catch(_) {}
}

// 点击/按键 → 获得焦点，同时成为视口注入目标（设金色子弹）
window.addEventListener('focus', function () { _setPanelFocus(true); _setBulletGold(true); });
window.addEventListener('blur', function () { _setPanelFocus(false); /* 保持子弹金色，不解绑 */
    // ★ 老代码技巧：窗口失焦时才 touch 当前 quest，避免点击卡片时立即弹顶
    if (typeof questActiveId !== 'undefined' && questActiveId && typeof questStore !== 'undefined' && questStore) {
        questStore.touch(questActiveId);
    }
});
document.addEventListener('mousedown', function () { _setPanelFocus(true); _setBulletGold(true); });
// ★ 主题切换 → 重绘子弹金色
var _themeWatchObs = new MutationObserver(function(){if(_panelFocused)_setBulletGold(true);});
try{_themeWatchObs.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});}catch(e){}

// ★ 互斥焦点：收到父窗口 defocus 通知时撤除金色边框
window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.type === 'qqq-ai-panel-defocus') {
        _setPanelFocus(false);
        _setBulletGold(false);  // ★ 另一面板接管：褪去子弹金色
    }
});

// 通用 postMessage
var _fwSeq = 0;
function _postToHost(msg) {
    msg._fwId = 'fw' + (++_fwSeq) + '_' + Date.now().toString(36);
    try { parent.postMessage(msg, '*'); } catch (_) { }
}

// 获取可用的 bridge
function _getBridge() {
    return parent.qqqideBridge;
}

// DOM
const $messages = document.getElementById('messages');
// ═══ Card Pool 滚动追踪（用户手动上滚 → 停止自动滚动） ═══
// ═══ 滚动追踪：wheel 方向 + scroll 底部检测 ═══
$messages.addEventListener('wheel', function (e) {
    if (cardPool) cardPool.onUserWheel(e);
});
$messages.addEventListener('scroll', function () {
    if (cardPool) cardPool.onUserScroll();
});

const $input = document.getElementById('input');
const $sendBtn = document.getElementById('send-btn');
const $guideBtn = document.getElementById('guide-btn');
const $queueBtn = document.getElementById('queue-btn');
const $ctxBtn = document.getElementById('ctx-btn');
const $queueStrip = document.getElementById('queue-strip');
// 引导按钮 tooltip（i18n 支持，语言切换时同步更新）
(function () {
    var _tipFallback = '立即用当下消息引导 AI 而不起新楼层！';
    function _setGuideTip() {
        try { if (parent.window && parent.window._i) $guideBtn.title = parent.window._i('ai.guideBtnTooltip', _tipFallback); }
        catch (_) { $guideBtn.title = _tipFallback; }
    }
    _setGuideTip();
    window.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'qqq-lang-change') _setGuideTip();
    });
})();

// ★ 初始网关状态上报 → 父窗口状态栏色点（此时所有脚本已加载完毕）
(function () {
    try {
        if (!window.parent) return;
        window.parent.postMessage({
            type: 'qqq-gw-status',
            panel: _panelId,
            fallback: (typeof _gwUsingFallback !== 'undefined') ? _gwUsingFallback : false,
            url: (typeof GATEWAY_URL !== 'undefined') ? GATEWAY_URL : ''
        }, '*');
    } catch (_) { }
})();

// ★ 跨面板网关状态协同：兄弟面板切回主线路成功 → 本面板也立即尝试切回
window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'qqq-gw-status') return;
    if (e.data.panel === _panelId) return;  // 忽略自身
    // 兄弟面板正在使用主线路 且 本面板在备用线路 → 尝试切回
    if (!e.data.fallback && typeof _gwUsingFallback !== 'undefined' && _gwUsingFallback) {
        if (typeof _gwTryPrimary === 'function') {
            if (typeof _gwFallbackAt !== 'undefined') {
                _gwFallbackAt = 0;  // 强制 _gwTryPrimary 认为已过 5 分钟
            }
        }
    }
    // ★ 兄弟面板报告备用线路未可达 → 本面板也标记备用为可疑，优先坚守主线路
    if (e.data.fallbackDead && typeof _gwUsingFallback !== 'undefined' && !_gwUsingFallback) {
        // 延长 _gwFallbackAt 防本面板误切到已死的备用
        if (typeof _gwFallbackAt !== 'undefined') {
            _gwFallbackAt = Date.now() + 10 * 60 * 1000;  // 10 分钟内不主动切备用
        }
    }
});

// ★ 记账埋点：调试开关（控制台键入 _toggleBillingDebug() 切换）
//   开启后每层楼完结时打印完整账单明细（wgeCost + model + token 量 + cache 命中率）
//   默认关闭。数据始终存储于 houses[] 中，开关只控制 console.log 噪音
window._toggleBillingDebug = function () {
    var ag = _activeAgent;
    if (ag) {
        ag._billingDebug = !ag._billingDebug;
        var st = ag._billingDebug ? '✅ ON' : '❌ OFF';
        console.log('[billing debug] ' + st + ' — 楼层完结时打印全账单明细');
        if (typeof window.parent !== 'undefined' && window.parent.qqqideQoast) {
            window.parent.qqqideQoast.show('记账调试 ' + (ag._billingDebug ? '已开启' : '已关闭'), { duration: 2000 });
        }
        return ag._billingDebug;
    }
    console.warn('[billing debug] 无活跃 agent，请先打开一个 quest');
    return false;
};
