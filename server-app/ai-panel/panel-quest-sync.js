// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
// panel-quest-sync.js — 跨面板同步机（2026-10-03 从 panel-quest.js 原样搬移，行为零改动）
'use strict';

async function _handleSyncMessage(msg) {
    if (!msg || msg.windowId === _windowId) return;
    // focus-request：焦点跳转
    if (msg.type === 'focus-request') {
        if (msg.targetWindow === _windowId || msg.targetPanel === _panelId) {
            // [silent] focus-request received
            _postToHost({ type: 'qqq-focus-window' });
            _setPanelFocus(true);
        }
        return;
    }
    // quest 列表变更
    if (msg.type === 'quest-created' || msg.type === 'quest-deleted' || msg.type === 'quest-renamed') {
        await questStore.invalidateIndex();  // ★ await：等 in-flight load 完成后再 null，防 updateQuestTofu 读到旧缓存
        await updateQuestTofu();
        // ★ 已开则原地刷新（2026-09-26）：禁止 closeQuestDrop——本 handler 经 await 后到达这里，
        //   用户此刻可能已在 hover 新开的下拉，迟到关闭 =「面板自己消失」
        if (typeof refreshQuestDropIfOpen === 'function') refreshQuestDropIfOpen();
        return;
    }
    // ★ 彗星电子钟：跨面板建楼状态同步 — 必须在 _isDraft 检查之前
    //   否则 draft 面板的广播全被拦截，永远收不到其他面板的建楼通知
    if (msg.type === 'building-changed') {
        (window.__qqq_localBuildingQuests = window.__qqq_localBuildingQuests || {})[msg.questId] = !!msg.building;
        if (typeof updateQuestTofu === 'function') updateQuestTofu();
        if (typeof _updateQuestClock === 'function') _updateQuestClock();
        // ★ 已开则原地刷新（含新建楼状态/下拉行时钟）——禁止关闭：用户正 hover 会被当场击中
        if (typeof refreshQuestDropIfOpen === 'function') refreshQuestDropIfOpen();
        // ★ 建楼结束后检查是否还有活跃建楼 quest，没有则停止彗星电子钟定时器
        if (!msg.building && typeof _maybeStopCometClockTimer === 'function') _maybeStopCometClockTimer();
        return;
    }
    // ★ 豆沙包：草稿状态同步 — 来自其他面板的 draft-changed 广播
    if (msg.type === 'draft-changed') {
        // ★ 已开则原地刷新（含新豆沙包状态）——禁止关闭
        if (typeof refreshQuestDropIfOpen === 'function') refreshQuestDropIfOpen();
        return;
    }
    if (_isDraft(questActiveId)) return;
    // [silent] sync recv
    try {
        switch (msg.type) {
            case 'quest-saved':
            case 'floor-saved':
                if (msg.questId === questActiveId && typeof msg.floorNum === 'number' && agent && agent._ctx) {
                    agent._ctx.totalFloors = Math.max(agent._ctx.totalFloors, msg.floorNum);
                }
                if (msg.questId === questActiveId) {
                    updateCostDisplay();
                    updateCtxBtn();
                }
                break;
            case 'floor-completed':
                // ★ 另一面板楼层建完 → 若本面板有此 quest card 且非建楼发起方，从磁盘重载最终数据
                {
                    var _fcCard = cardPool._cards[msg.questId];
                    if (_fcCard && _fcCard.buildingFloor === null && questStore) {
                        // ★ 保存滚动位置（清卡会触发 DOM 坍缩，scrollTop 丢失）
                        var _fcScrollTop = 0;
                        try {
                            var _fcContainer = _fcCard.dom && _fcCard.dom.parentNode;
                            if (_fcContainer) _fcScrollTop = _fcContainer.scrollTop;
                        } catch (_) { }
                        _fcCard._contentWrap.innerHTML = '';
                        _fcCard.floorDOM = {};
                        _fcCard.totalFloors = 0;
                        _fcCard.floors = [];
                        _fcCard._floorMetaMap = {};
                        _fcCard._keepFloors = {};
                        _fcCard._floorNodes = {};
                        await cardPool._loadCardData(_fcCard);
                        // ★ 恢复滚动位置（跨面板重建卡片后用户不应被打断）
                        try {
                            var _fcContainer2 = _fcCard.dom && _fcCard.dom.parentNode;
                            if (_fcContainer2) {
                                _fcContainer2.scrollTop = _fcScrollTop;
                                // 递进兜底：渲染帧落地后再设一次
                                requestAnimationFrame(function () {
                                    if (_fcContainer2) _fcContainer2.scrollTop = _fcScrollTop;
                                });
                            }
                        } catch (_) { }
                        // ★ 若为当前活跃 quest，重连 _activeAiDiv
                        if (msg.questId === questActiveId && _activeAgent) {
                            var _lastNums = Object.keys(_fcCard.floorDOM || {}).map(Number).sort(function (a, b) { return b - a; });
                            if (_lastNums.length > 0 && _fcCard.floorDOM[_lastNums[0]].aiEl) {
                                _activeAgent._activeAiDiv = _fcCard.floorDOM[_lastNums[0]].aiEl;
                            }
                        }
                    }
                }
                break;
            case 'owner-claimed':
                // 另一面板抢走了我们正在看的 quest → 自动卸载，跳回空白
                if (msg.questId === questActiveId && msg.windowId !== _windowId) {
                    // [silent] quest claimed by other panel, unloading
                    _unloadQuest();
                }
                break;
            case 'owner-released':
                // 另一面板释放了 quest — 不做任何事（我们不自动加载）
                break;
        }
    } catch (e) {
        console.warn('[quests] _handleSyncMessage error:', e && e.message);
    }
}
