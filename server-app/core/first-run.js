// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// first-run.js — 首次启动专家确认弹窗（唯一入口）
//
// 语义: 绿色包/程序数据（Data/alphal/global.sq3）首次启动弹一次——
//   声明行: 我是专家，我懂得每一个指令滴危害，我不用 qqqide 删除文件
//   链接行: 「借由 Roam 你可以快速操作文件，包括删除」→ QQQLinks 服务器下发链接（离线兜底）
//   同意并继续 → 双通道写标记（2026-09-08 双修：真实机器实锤「同意已落盘、重启后标记消失」→ sq3 文件级回滚）
//     ① qgs.simple('qqq.settings').setNow 写 firstRun.expertAgreed —— setNow 立即落盘（旧 fire-and-forget set：退出竞态/强杀即丢）
//     ② localStorage qqq.firstRun.expertAgreed.v1 —— sq3 的损坏恢复链（主→.prev→.bak）与整库回滚不碰它，双通道互相兜底
//   判定三态: 任一通道有 → 不弹（仅 sq3 缺失时后台 setNow 回写自愈）；两通道都无 → 弹；库暂不可用 → 1s/3s/8s 退避重试，仍不可用放弃（弹了同意也存不进，纯噪音）
//   退出      → bridge.app.quitAll()（不写标记，下次启动再弹）
// 持久化入口: qgs.simple('qqq.settings', {cloud:false}) = 程序级 global.sq3（§8.1 六入口之一）+ localStorage 兜底
// 依赖: core/qqq-links.js（先加载）
// ============================================================================

; (function () {
    'use strict';

    if (parent !== window) return;          // 仅主窗口
    if (!window.QQQLinks) return;           // 链接机器缺失 → 不弹（防御）

    var KEY = 'firstRun.expertAgreed';
    var LS_KEY = 'qqq.firstRun.expertAgreed.v1';   // 兜底通道 ②（localStorage，独立于 sq3 恢复链）
    var _h = null;
    var _overlay = null;

    function _handle() {
        if (!_h && window.qgs && window.qgs.simple) {
            try { _h = window.qgs.simple('qqq.settings', { cloud: false }); } catch (e) { _h = null; }
        }
        return _h;
    }

    function _lsGet() {
        try { return window.localStorage ? window.localStorage.getItem(LS_KEY) : null; } catch (e) { return null; }
    }
    function _lsSet() {
        try { if (window.localStorage) { window.localStorage.setItem(LS_KEY, '1'); return true; } } catch (e) { /* ignore */ }
        return false;
    }

    // 读同意态（三态）: 'agreed' = 任一通道有 / 'none' = 两通道都明确无 / 'unknown' = sq3 暂不可用且 LS 无
    // qgs get 可能同步可能异步（Promise），双形态兜底
    function _readAgreed(cb) {
        var h = _handle();
        var ls = _lsGet();
        if (!h) { cb(ls === '1' ? 'agreed' : 'unknown'); return; }
        var done = false;
        function fin(st) {
            if (done) return;
            done = true;
            if (ls === '1') {
                // sq3 无/不可用但 LS 有（sq3 曾被回滚）→ 视为已同意 + 后台回写自愈，防双通道全丢
                if (st !== 'agreed' && h) {
                    try {
                        var pp = h.setNow(KEY, '1');
                        if (pp && typeof pp.then === 'function') { pp.catch(function () { }); }
                    } catch (e2) { /* 回写失败：下次启动再自愈 */ }
                }
                cb('agreed');
            } else {
                cb(st);
            }
        }
        try {
            var p = h.get(KEY);
            if (p && typeof p.then === 'function') {
                p.then(function (v) { fin(!!v ? 'agreed' : 'none'); }, function () { fin('unknown'); });
            } else {
                fin(!!p ? 'agreed' : 'none');
            }
        } catch (e) { fin('unknown'); }
    }

    // 同意 = 双通道写入，至少一通道成功才算保存成功（doneCb(ok)）
    function _markAgreed(doneCb) {
        var h = _handle();
        var finished = false;
        function finish(ok) {
            if (finished) return;
            finished = true;
            doneCb(ok);
        }
        // 保险：bridge 挂起时 2s 兜底（结果 = LS 通道真实结果，LS 也失败则如实提示重试）
        setTimeout(function () { finish(lsOk); }, 2000);
        var lsOk = _lsSet();
        if (!h) { finish(lsOk); return; }
        try {
            var p = h.setNow(KEY, '1');
            if (p && typeof p.then === 'function') {
                p.then(function () { finish(true); }, function () { finish(lsOk); });
            } else {
                finish(true);
            }
        } catch (e) { finish(lsOk); }
    }

    // data-i18n 动态文案（失败提示/还原共用）
    function _setTextI18n(el, key, fallback) {
        el.setAttribute('data-i18n', key);
        el.textContent = fallback;
        try { if (window.i18n && window.i18n.updateDom) window.i18n.updateDom(el); } catch (e) { /* ignore */ }
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
        // 2026-09-03 用户定案：两按钮统一取消按钮原色（透明底+主题描边，黑白主题自适应），同意在左/退出在右
        btnAgree.style.cssText = 'padding:7px 20px;border:1px solid var(--border-strong);border-radius:6px;' +
            'background:transparent;color:var(--text-secondary);font-size:13px;';
        btnAgree.addEventListener('click', function (e) {
            e.preventDefault();
            if (btnAgree.disabled) return;   // busy 防连点（保存失败重试期间）
            btnAgree.disabled = true;
            _markAgreed(function (ok) {
                if (ok) {
                    _dismiss();
                    return;
                }
                // 双通道全失败（sq3 与 LS 均不可写）→ 不关闭弹窗，提示重试
                btnAgree.disabled = false;
                _setTextI18n(btnAgree, 'firstRun.saveFailed', '保存失败，请重试');
                setTimeout(function () { _setTextI18n(btnAgree, 'firstRun.agree', '同意并继续'); }, 3000);
            });
        });

        // 2026-09-03 用户定案：同意并继续在左（主操作先），退出在右
        row.appendChild(btnAgree);
        row.appendChild(btnExit);
        panel.appendChild(row);
        ov.appendChild(panel);
        document.body.appendChild(ov);
        _overlay = ov;

        // i18n: 按当前语言刷一次（data-i18n + 中文回退），语言切换停留期间再同步
        try { if (window.i18n && window.i18n.updateDom) window.i18n.updateDom(ov); } catch (e) { /* ignore */ }
        window.addEventListener('qqq-lang-change', _onLangChange);
    }

    var _bootRetries = 0;
    var _bootBackoff = [1000, 3000, 8000];

    function _boot() {
        _readAgreed(function (state) {
            if (state === 'agreed') return;
            if (state === 'none') { _show(); return; }
            // unknown = 持久化层暂不可用（启动早期/库异常）：退避重试 ≤3 次；仍不可用 → 放弃弹窗
            //   （库不可用时弹了也存不进同意，只会让用户反复看到；宁可漏弹不可误弹）
            _bootRetries++;
            if (_bootRetries <= _bootBackoff.length) {
                setTimeout(_boot, _bootBackoff[_bootRetries - 1]);
            } else {
                try { console.warn('[first-run] state store unavailable, skip expert dialog'); } catch (e2) { /* ignore */ }
            }
        });
    }

    // 首启弹窗等主窗口完全加载后再出（不干扰启动流水线）
    if (document.readyState === 'complete') {
        setTimeout(_boot, 4000);
    } else {
        window.addEventListener('load', function () { setTimeout(_boot, 4000); });
    }
})();
