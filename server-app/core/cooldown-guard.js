// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

/**
 * CooldownGuard 冷却护盾 — 唯一真理防抖机器
 *
 * 零配置自动覆盖：所有 button / [onclick] / [role="button"] / input[submit|reset]
 * 默认冷却 1800ms，关闭/取消按钮自动 400ms
 * 视觉反馈：白色高光蒙版淡出 + 按钮内左下角 4×4 红点
 * Enter/Space 键在冷却期内被吞掉（捕获阶段拦截）
 *
 * 自定义：
 *   data-cd="5000"    → 延长冷却至 5s
 *   data-no-cd         → 跳过冷却（准许狂点的按钮）
 *
 * 升级只改这一处，全站所有按钮自动生效。
 */
(function () {
    var CD_DEFAULT = 800;
    var _cdMap = new WeakMap();

    // ── 冷却 CSS ──
    var css = document.createElement('style');
    css.textContent =
        '@keyframes btnCdFade{from{opacity:1}to{opacity:0}}' +
        '.btn-cd-mask{position:absolute;inset:0;pointer-events:none;border-radius:inherit;' +
        'background:rgba(255,255,255,0.38);overflow:hidden;' +
        'animation:btnCdFade var(--cd-ms,1.8s) linear forwards}' +
        '.btn-cd-dot{position:absolute;left:4px;bottom:4px;width:4px;height:4px;' +
        'background:rgb(255,0,0);pointer-events:none;z-index:2;border-radius:1px}' +
        '.btn-cd-pos{position:relative!important}';
    document.head.appendChild(css);

    function findTarget(el) {
        var t = el.closest('button, [onclick], [role="button"], input[type="submit"], input[type="reset"]');
        if (!t) return null;
        if (t.tagName === 'A' && t.href && !t.hasAttribute('onclick')) return null;
        return t;
    }

    function isQuickBtn(el) {
        var txt = (el.textContent || '').trim();
        return /^[×✕✖&times;]$/.test(txt) || /^(关闭|取消|close|cancel)$/i.test(txt);
    }

    // 捕获阶段拦截 click
    document.addEventListener('click', function (e) {
        var t = findTarget(e.target);
        if (!t) return;
        if (t.hasAttribute('data-no-cd')) return;
        if (t.disabled) return;

        if (_cdMap.has(t)) {
            e.stopImmediatePropagation();
            e.preventDefault();
            return;
        }

        var cd = parseInt(t.getAttribute('data-cd')) || (isQuickBtn(t) ? 400 : CD_DEFAULT);
        _cdMap.set(t, true);

        var needPos = getComputedStyle(t).position === 'static';
        if (needPos) t.classList.add('btn-cd-pos');
        var mask = document.createElement('div');
        mask.className = 'btn-cd-mask';
        mask.style.setProperty('--cd-ms', cd + 'ms');
        var dot = document.createElement('div');
        dot.className = 'btn-cd-dot';
        t.appendChild(mask);
        t.appendChild(dot);

        setTimeout(function () {
            _cdMap.delete(t);
            if (mask.parentNode) mask.parentNode.removeChild(mask);
            if (dot.parentNode) dot.parentNode.removeChild(dot);
            if (needPos) t.classList.remove('btn-cd-pos');
        }, cd);
    }, true);

    // 捕获阶段拦截 Enter/Space 键
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var t = findTarget(e.target);
        if (!t) return;
        if (t.hasAttribute('data-no-cd')) return;
        if (_cdMap.has(t)) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true);
})();
