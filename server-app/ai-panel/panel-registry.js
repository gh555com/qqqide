'use strict';
// ═══ panel-registry.js ═══
// 中央建楼状态机 — 跨面板唯一真理源
// 职责: 1) 追踪哪些 quest 正在建楼（前台+后台）
//       2) 区分每个 quest 的 stopState / panelId / foreground
//       3) 提供每 quest 独立沙箱状态查询
//
// 铁律:
//   - 一个 quest 同一时刻只能在一个面板建楼（所有权系统保证）
//   - 前台/后台由建楼所在面板与当前查询面板比对得出
//   - "能发消息吗" = 当前 quest 不在建楼 OR 当前 quest 自己正在建楼（引导/排队）
//   - 彗星环绕 = 所有 stopState='sending' 的 quest 均显示

// ═══ 父窗口共享注册表（跨 iframe 唯一真理源） ═══
// 挂在父窗口上，三面板共享同一引用
function _ensureParentRegistry() {
    if (!window.parent) return;
    if (!window.parent.__qqq_buildingRegistry) {
        window.parent.__qqq_buildingRegistry = {};
    }
    return window.parent.__qqq_buildingRegistry;
}

// ── 登记一个 quest 开始建楼 ──
// panelId: 0=左翼, 1=中, 2=右翼
function _registerBuilding(questId, panelId) {
    var reg = _ensureParentRegistry();
    if (!reg) return;
    reg[questId] = {
        stopState: 'sending',
        panelId: panelId,
        startedAt: Date.now()
    };
    _broadcastRegistry();
}

// ── 登记一个 quest 停止建楼（完成/错误/手动停止） ──
function _unregisterBuilding(questId) {
    var reg = _ensureParentRegistry();
    if (!reg) return;
    if (reg[questId]) {
        delete reg[questId];
        _broadcastRegistry();
    }
}

// ── 查询：某个 quest 是否正在建楼（全局，不限面板） ──
function _isQuestBuilding(questId) {
    var reg = _ensureParentRegistry();
    if (!reg) return false;
    return !!(reg[questId] && reg[questId].stopState === 'sending');
}

// ── 查询：所有正在建楼的 questId 列表 ──
function _getRunningQuestIds() {
    var reg = _ensureParentRegistry();
    if (!reg) return [];
    var ids = [];
    var keys = Object.keys(reg);
    for (var i = 0; i < keys.length; i++) {
        if (reg[keys[i]].stopState === 'sending') ids.push(keys[i]);
    }
    return ids;
}

// ── 查询：当前面板前台 quest 是否可以发送消息 ──
//   原则：当前 quest 如果是建楼中的（主动触发引导/排队），允许发
//         当前 quest 空闲且无其他建楼 → 允许
//         当前 quest 空闲但有其他 quest 在后台建楼 → 允许（每 quest 独立沙箱）
function _canCurrentQuestSend(questId) {
    if (!questId) return true;  // draft → 允许
    var reg = _ensureParentRegistry();
    if (!reg) return true;
    // 如果当前 quest 自己正在建楼，仍允许（引导注入需要 send）
    // 如果当前 quest 空闲，任何时候都允许发送
    return true;  // ★ per-quest 沙箱：每个 quest 独立，不互斥
}

// ── 面板级通知：告知同窗口其他面板注册表已更新 ──
function _broadcastRegistry() {
    try {
        if (window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.sync) {
            window.parent.qqqideBridge.sync.broadcast('qqq-registry-changed', {});
        }
    } catch (_) { }
}

// ★ 监听来自其他面板的注册表更新（彗星环绕刷新）
if (window.parent && window.parent.qqqideBridge && window.parent.qqqideBridge.sync) {
    try {
        window.parent.qqqideBridge.sync.on('qqq-registry-changed', function () {
            if (typeof updateQuestTofu === 'function') updateQuestTofu();
        });
    } catch (_) { }
}

// ═══ 导出到 window ═══
window._registerBuilding = _registerBuilding;
window._unregisterBuilding = _unregisterBuilding;
window._isQuestBuilding = _isQuestBuilding;
window._getRunningQuestIds = _getRunningQuestIds;
window._canCurrentQuestSend = _canCurrentQuestSend;
