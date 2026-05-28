// ============================================================================
// update-ui.js — Hot update UI: check button + progress + swap
//
// Hooks into bridge.update.* and wires the toolbar update button.
// ============================================================================
(function () {
    'use strict';

    const bridge = window.qqqBridge;
    if (!bridge || !bridge.update) {
        console.warn('[update-ui] bridge.update unavailable');
        return;
    }

    const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
    let btnEl = null;

    function getBtn() {
        if (!btnEl) btnEl = document.getElementById('qqq-update-btn');
        return btnEl;
    }

    async function init() {
        const btn = getBtn();
        if (!btn) return;

        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '...';
            try {
                const result = await bridge.update.apply();
                if (result && result.success) {
                    btn.textContent = '\u2713';
                    btn.title = '已更新到 ' + result.version + '，即将重载...';
                    setTimeout(() => {
                        if (bridge.window) bridge.window.close();
                        // Electron will restart via tray or user
                    }, 1500);
                } else {
                    btn.textContent = '\u2717';
                    btn.title = (result && result.error) || '更新失败';
                    setTimeout(() => { btn.textContent = '\u21BB'; btn.disabled = false; }, 3000);
                }
            } catch (e) {
                btn.textContent = '\u2717';
                btn.title = '更新失败: ' + (e.message || e);
                setTimeout(() => { btn.textContent = '\u21BB'; btn.disabled = false; }, 3000);
            }
        });

        // Initial check
        await checkAndHighlight();
        // Periodic check
        setInterval(checkAndHighlight, CHECK_INTERVAL);
    }

    async function checkAndHighlight() {
        try {
            const result = await bridge.update.check();
            const btn = getBtn();
            if (!btn) return;

            if (result && result.needUpdate) {
                btn.style.display = '';
                btn.style.color = 'var(--yellow)'; // solarized yellow
                btn.title = '新版本 ' + result.latestVersion + ' 可用 (当前 ' + result.currentVersion + ')';
            } else {
                btn.style.display = 'none';
            }
        } catch (e) {
            console.warn('[update-ui] check failed:', e && e.message);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
