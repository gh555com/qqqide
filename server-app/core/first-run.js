// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// first-run.js — 首次启动专家确认弹窗（唯一入口）
//
// 语义: 绿色包/程序数据（Data/alphal/global.sq3）首次启动弹一次——
//   声明行: 我是专家，我懂得每一个指令滴危害，我不用 qqqide 删除文件
//   链接行: 「借由 Roam 你可以快速操作文件，包括删除」→ QQQLinks 服务器下发链接（离线兜底）
//   同意并继续 → qgs.simple('qqq.settings') 写 firstRun.expertAgreed（随保险库跨更新保留，永不再弹）
//   退出      → bridge.app.quitAll()（不写标记，下次启动再弹）
// 持久化入口: qgs.simple('qqq.settings', {cloud:false}) = 程序级 global.sq3（§8.1 六入口之一）
// 依赖: core/qqq-links.js（先加载）
// ============================================================================

; (function () {
    'use strict';

    if (parent !== window) return;          // 仅主窗口
    if (!window.QQQLinks) return;           // 链接机器缺失 → 不弹（防御）

    var KEY = 'firstRun.expertAgreed';
    var _h = null;
    var _overlay = null;

    function _handle() {
        if (!_h && window.qgs && window.qgs.simple) {
            try { _h = window.qgs.simple('qqq.settings', { cloud: false }); } catch (e) { _h = null; }
        }
        return _h;
    }

    // qgs get 可能同步可能异步（Promise），双形态兜底
    function _readAgreed(cb) {
        var h = _handle();
        if (!h) { cb(false); return; }
        var done = false;
        function fin(v) { if (!done) { done = true; cb(!!v); } }
        try {
            var p = h.get(KEY);
            if (p && typeof p.then === 'function') {
                p.then(fin, function () { fin(false); });
            } else {
                fin(p);
            }
        } catch (e) { fin(false); }
    }

    function _markAgreed() {
        var h = _handle();
        if (h) { try { h.set(KEY, '1'); } catch (e) { /* 内存标记失败不阻塞弹窗消失 */ } }
    }

    function _quitApp() {
        try {
            if (window.qqqideBridge && window.qqqideBridge.app && window.qqqideBridge.app.quitAll) {
                window.qqqideBridge.app.quitAll();
                return;
            }
        } catch (e) { /* fallthrough */ }
        try { window.close(); } catch (e) { /* browser-mode */ }
    }

    function _linkUrl() {
        try {
            var u = window.QQQLinks.url('roam_delete_video');
            if (u) return u;
        } catch (e) { /* fallthrough */ }
        return 'https://www.bilibili.com/video/BV1PD826SEMT';
    }

    function _dismiss() {
        if (_overlay && _overlay.parentNode) {
            _overlay.parentNode.removeChild(_overlay);
        }
        _overlay = null;
    }

    function _onLangChange() {
        if (_overlay && window.i18n && window.i18n.updateDom) {
            try { window.i18n.updateDom(_overlay); } catch (e) { /* ignore */ }
        }
    }

    function _show() {
        if (_overlay || document.body.contains(document.getElementById('qqq-firstrun-overlay'))) return;

        var ov = document.createElement('div');
        ov.id = 'qqq-firstrun-overlay';
        ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);' +
            'z-index:100000;display:flex;align-items:center;justify-content:center;';

        var panel = document.createElement('div');
        panel.style.cssText = 'width:500px;max-width:92vw;box-sizing:border-box;' +
            'background:var(--background-color);color:var(--text-primary);' +
            'border:1px solid var(--border-strong);border-radius:10px;' +
            'box-shadow:0 12px 48px rgba(0,0,0,0.5);padding:26px 28px 20px;' +
            'font-size:14px;line-height:1.7;';

        // ── 专家声明行 ──
        var p = document.createElement('p');
        p.setAttribute('data-i18n', 'firstRun.expert');
        p.textContent = '我是专家，我懂得每一个指令滴危害，我不用 qqqide 删除文件';
        p.style.cssText = 'margin:0;font-size:15px;font-weight:600;';
        panel.appendChild(p);

        // ── Roam 提示行 = 超链接（服务器下发，离线回退 B 站视频）──
        var a = document.createElement('a');
        a.setAttribute('data-i18n', 'firstRun.roamHint');
        a.textContent = '借由 Roam 你可以快速操作文件，包括删除';
        a.href = _linkUrl();
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.style.cssText = 'display:inline-block;margin-top:14px;' +
            'color:var(--primary-color);text-decoration:underline;word-break:break-all;';
        panel.appendChild(a);

        // ── 按钮行 ──
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:26px;';

        var btnExit = document.createElement('button');
        btnExit.setAttribute('data-i18n', 'firstRun.exit');
        btnExit.textContent = '退出';
        btnExit.style.cssText = 'padding:7px 20px;border:1px solid var(--border-strong);border-radius:6px;' +
            'background:transparent;color:var(--text-secondary);font-size:13px;';
        btnExit.addEventListener('click', function (e) {
            e.preventDefault();
            _dismiss();
            _quitApp();
        });

        var btnAgree = document.createElement('button');
        btnAgree.setAttribute('data-i18n', 'firstRun.agree');
        btnAgree.textContent = '同意并继续';
        btnAgree.style.cssText = 'padding:7px 20px;border:1px solid var(--button-ok-bg);border-radius:6px;' +
            'background:var(--button-ok-bg);color:var(--button-ok-text);font-size:13px;font-weight:600;';
        btnAgree.addEventListener('click', function (e) {
            e.preventDefault();
            _markAgreed();
            _dismiss();
        });

        row.appendChild(btnExit);
        row.appendChild(btnAgree);
        panel.appendChild(row);
        ov.appendChild(panel);
        document.body.appendChild(ov);
        _overlay = ov;

        // i18n: 按当前语言刷一次（data-i18n + 中文回退），语言切换停留期间再同步
        try { if (window.i18n && window.i18n.updateDom) window.i18n.updateDom(ov); } catch (e) { /* ignore */ }
        window.addEventListener('qqq-lang-change', _onLangChange);
    }

    function _boot() {
        _readAgreed(function (agreed) {
            if (!agreed) _show();
        });
    }

    // 首启弹窗等主窗口完全加载后再出（不干扰启动流水线）
    if (document.readyState === 'complete') {
        setTimeout(_boot, 4000);
    } else {
        window.addEventListener('load', function () { setTimeout(_boot, 4000); });
    }
})();
