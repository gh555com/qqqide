// ============================================================================
// update-ui.js — Hot update UI: check button + progress + swap
//
// Hooks into bridge.update.* and wires the toolbar update button.
// ============================================================================
(function () {
    'use strict';

    const bridge = window.qqqideBridge;
    if (!bridge || !bridge.update) {
        console.warn('[update-ui] bridge.update unavailable');
        return;
    }

    const CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
    let btnEl = null;

    function getBtn() {
        if (!btnEl) btnEl = document.getElementById('qqq-update-btn');
        return btnEl;
    }

    async function init() {
        // ★ 永久隐藏更新按钮（2026-07-23）
        // 自动更新管线已全覆盖：
        //   壳层冷更 → checkAndDownloadShellUpdate() boot时非阻塞检查
        //   载荷热更 → backgroundCheckWebappUpdate() boot 20s 后检查
        // 按钮手动触发带来边界问题（swap EPERM / 版本号谎报 / 陈旧显示），不再需要。
        const btn = getBtn();
        if (btn) { btn.style.display = 'none'; }
    }



    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
