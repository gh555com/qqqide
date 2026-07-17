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
                // 优先壳层更新（需重启），其次载荷更新（热更）
                if (bridge.update.upgradeShell && btn.dataset.mode === 'shell') {
                    const result = await bridge.update.upgradeShell();
                    if (result && result.success) {
                        btn.textContent = '\u2713';
                        btn.title = '壳层已更新到 ' + (result.version || '') + '，重启后生效';
                        setTimeout(() => { btn.textContent = '\u21BB'; btn.disabled = false; }, 5000);
                    } else {
                        btn.textContent = '\u2717';
                        btn.title = (result && result.error) || '壳层更新失败';
                        setTimeout(() => { btn.textContent = '\u21BB'; btn.disabled = false; }, 3000);
                    }
                    return;
                }
                const result = await bridge.update.apply();
                if (result && result.success) {
                    btn.textContent = '\u2713';
                    btn.title = '载荷已更新到 ' + (result.version || '') + '，重启后生效';
                    setTimeout(() => { btn.textContent = '\u21BB'; btn.disabled = false; }, 5000);
                } else {
                    btn.textContent = '\u2717';
                    btn.title = (result && result.error) || window._i('shell.update.failed', '更新失败');
                    setTimeout(() => { btn.textContent = '\u21BB'; btn.disabled = false; }, 3000);
                }
            } catch (e) {
                btn.textContent = '\u2717';
                btn.title = window._i('shell.update.failedWith', '更新失败') + ': ' + (e.message || e);
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

            // ★ 壳层已 staging → 绿色，无需点击（自动下载已完成）
            if (result && result.needShellUpdate && result.shellStaged) {
                btn.style.display = '';
                btn.style.color = 'var(--green)';
                btn.dataset.mode = '';
                btn.title = '壳层已就绪，重启后生效 (' + (result.latestShellVersion || '?') + ')';
                return;
            }
            // ★ 壳层需要更新但未 staging → 红色，可点击手动下载
            if (result && result.needShellUpdate) {
                btn.style.display = '';
                btn.style.color = 'var(--red)';
                btn.dataset.mode = 'shell';
                btn.title = '壳层新版本 ' + (result.latestShellVersion || '?') + ' 可用（点击更新，重启生效）';
                return;
            }
            btn.dataset.mode = '';
            // ★ 载荷已 staging → 绿色
            if (result && result.needUpdate && result.webappStaged) {
                btn.style.display = '';
                btn.style.color = 'var(--green)';
                btn.title = '载荷已就绪，重启后生效 (' + (result.latestVersion || '?') + ')';
                return;
            }
            // ★ 载荷需要更新但未 staging → 黄色（如果壳层已是最新则标注「载荷」）
            if (result && result.needUpdate) {
                btn.style.display = '';
                btn.style.color = 'var(--yellow)';
                var label = (!result.needShellUpdate) ? '载荷更新 ' + result.latestVersion + ' 可用 (当前 ' + result.currentVersion + ')' : ('新版本 ' + result.latestVersion + ' 可用 (当前 ' + result.currentVersion + ')');
                btn.title = window.i18n.t('shell.update.newVersion', { latest: result.latestVersion, current: result.currentVersion }) || label;
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
