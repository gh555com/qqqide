// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// first-run.js — 首次启动弹窗链（唯一入口）
//
// 链: 第一层专家声明 → 点「同意并继续」→ 第二层游戏宣言/社区引导（点「那很好」收工）
//   第一层: 专家声明行（主题 = 指令危害认知）
//   第二层: 原创游戏宣言 + 「利用 Roam 跳出项目文件夹滴限制」教学视频（新行；硬编码 B 站 URL → shell.js 全局链接兜底 = 外部浏览器）+ help 社区一对一引导
//   退出（第一层） → bridge.app.quitAll()（不写标记，下次启动再弹）
//   标记: 两层各自独立、各双通道（任一通道有 → 该层不弹）——2026-09-08 双修：真实机器实锤「同意已落盘、重启后标记消失」→ sq3 文件级回滚
//     ① qgs.simple('qqq.settings').setNow 写 firstRun.expertAgreed / firstRun.gameIntro —— setNow 立即落盘（旧 fire-and-forget set：退出竞态/强杀即丢）
//     ② localStorage qqq.firstRun.expertAgreed.v1 / qqq.firstRun.gameIntro.v1 —— sq3 的损坏恢复链（主→.prev→.bak）与整库回滚不碰它，双通道互相兜底
//   判定: !expertAgreed → 第一层；已同意且 !gameIntro → 第二层（同意当场紧接弹 / 老用户与断链重入启动补弹一次）；两标记齐 → 静默
//         库暂不可用 → 1s/3s/8s 退避重试，仍不可用放弃（弹了同意也存不进，纯噪音）
// 持久化入口: qgs.simple('qqq.settings', {cloud:false}) = 程序级 global.sq3（§8.1 六入口之一）+ localStorage 兜底
// ============================================================================

; (function () {
    'use strict';

    if (parent !== window) return;          // 仅主窗口

    var KEY = 'firstRun.expertAgreed';
    var LS_KEY = 'qqq.firstRun.expertAgreed.v1';   // 兜底通道 ②（localStorage，独立于 sq3 恢复链）
    var INTRO_KEY = 'firstRun.gameIntro';
    var LS_INTRO_KEY = 'qqq.firstRun.gameIntro.v1';
    var INTRO_VIDEO_URL = 'https://www.bilibili.com/video/BV1PD826SEMT';
    var _h = null;
    var _overlay = null;

    function _handle() {
        if (!_h && window.qgs && window.qgs.simple) {
            try { _h = window.qgs.simple('qqq.settings', { cloud: false }); } catch (e) { _h = null; }
        }
        return _h;
    }

    function _lsGet(lsKey) {
        try { return window.localStorage ? window.localStorage.getItem(lsKey) : null; } catch (e) { return null; }
    }
    function _lsSet(lsKey) {
        try { if (window.localStorage) { window.localStorage.setItem(lsKey, '1'); return true; } } catch (e) { /* ignore */ }
        return false;
    }

    // 读标记态（三态）: 'has' = 任一通道有 / 'none' = 两通道都明确无 / 'unknown' = sq3 暂不可用且 LS 无
    // qgs get 可能同步可能异步（Promise），双形态兜底
    function _readMark(key, lsKey, cb) {
        var h = _handle();
        var ls = _lsGet(lsKey);
        if (!h) { cb(ls === '1' ? 'has' : 'unknown'); return; }
        var done = false;
        function fin(st) {
            if (done) return;
            done = true;
            if (ls === '1') {
                // sq3 无/不可用但 LS 有（sq3 曾被回滚）→ 视为已有 + 后台回写自愈，防双通道全丢
                if (st !== 'has' && h) {
                    try {
                        var pp = h.setNow(key, '1');
                        if (pp && typeof pp.then === 'function') { pp.catch(function () { }); }
                    } catch (e2) { /* 回写失败：下次启动再自愈 */ }
                }
                cb('has');
            } else {
                cb(st);
            }
        }
        try {
            var p = h.get(key);
            if (p && typeof p.then === 'function') {
                p.then(function (v) { fin(!!v ? 'has' : 'none'); }, function () { fin('unknown'); });
            } else {
                fin(!!p ? 'has' : 'none');
            }
        } catch (e) { fin('unknown'); }
    }

    // 写标记 = 双通道写入，至少一通道成功才算保存成功（doneCb(ok)）
    function _writeMark(key, lsKey, doneCb) {
        var h = _handle();
        var finished = false;
        var lsOk = _lsSet(lsKey);
        function finish(ok) {
            if (finished) return;
            finished = true;
            doneCb(ok);
        }
        // 保险：bridge 挂起时 2s 兜底（结果 = LS 通道真实结果，LS 也失败则如实提示重试）
        setTimeout(function () { finish(lsOk); }, 2000);
        if (!h) { finish(lsOk); return; }
        try {
            var p = h.setNow(key, '1');
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

    // ── 弹窗外壳（两层共用；同 id 幂等） ──
    function _makeOverlay() {
        if (_overlay || document.body.contains(document.getElementById('qqq-firstrun-overlay'))) return null;

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

        ov.appendChild(panel);
        document.body.appendChild(ov);
        _overlay = ov;
        return panel;
    }

    function _afterShow() {
        // i18n: 按当前语言刷一次（data-i18n + 中文回退），语言切换停留期间再同步
        try { if (window.i18n && window.i18n.updateDom) window.i18n.updateDom(_overlay); } catch (e) { /* ignore */ }
        window.addEventListener('qqq-lang-change', _onLangChange);
    }

    function _mkButton(textKey, fallback) {
        var b = document.createElement('button');
        b.setAttribute('data-i18n', textKey);
        b.textContent = fallback;
        // 2026-09-03 用户定案：按钮统一取消按钮原色（透明底+主题描边，黑白主题自适应）
        b.style.cssText = 'padding:7px 20px;border:1px solid var(--border-strong);border-radius:6px;' +
            'background:transparent;color:var(--text-secondary);font-size:13px;';
        return b;
    }

    function _mkBtnRow() {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:26px;';
        return row;
    }

    // ── 第一层：专家声明 ──
    function _showExpert() {
        var panel = _makeOverlay();
        if (!panel) return;

        var p = document.createElement('p');
        p.setAttribute('data-i18n', 'firstRun.expert');
        p.textContent = '我是专家，我懂得每一个指令滴危害，我不用 qqqide 删除文件';
        p.style.cssText = 'margin:0;font-size:15px;font-weight:600;';
        panel.appendChild(p);

        var row = _mkBtnRow();

        var btnExit = _mkButton('firstRun.exit', '退出');
        btnExit.addEventListener('click', function (e) {
            e.preventDefault();
            _dismiss();
            _quitApp();
        });

        var btnAgree = _mkButton('firstRun.agree', '同意并继续');
        btnAgree.addEventListener('click', function (e) {
            e.preventDefault();
            if (btnAgree.disabled) return;   // busy 防连点（保存失败重试期间）
            btnAgree.disabled = true;
            _writeMark(KEY, LS_KEY, function (ok) {
                if (ok) {
                    _dismiss();
                    _showIntro();            // 2026-09-23 定案：同意并继续 → 紧接着弹第二层
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
        _afterShow();
    }

    // ── 第二层：游戏宣言 / 社区引导（「那很好」收工；终身只弹一次） ──
    function _showIntro() {
        var panel = _makeOverlay();
        if (!panel) return;

        var p1 = document.createElement('p');
        p1.setAttribute('data-i18n', 'firstRun.intro1');
        p1.textContent = '你可以把 qd 当做一个游戏来慢慢地品味，注意，是一个原创游戏，而不是一个换皮游戏，如果你喜欢换皮游戏，现在就可以放心地离开。';
        p1.style.cssText = 'margin:0 0 12px;';
        panel.appendChild(p1);

        // 教学视频（独立行；target=_blank → shell.js 全局链接兜底 = 外部浏览器打开）
        var p2 = document.createElement('p');
        p2.style.cssText = 'margin:0 0 12px;';
        var a = document.createElement('a');
        a.href = INTRO_VIDEO_URL;
        a.target = '_blank';
        a.setAttribute('data-i18n', 'firstRun.introLink');
        a.textContent = '利用 Roam 跳出项目文件夹滴限制';
        a.style.cssText = 'color:var(--blue);text-decoration:underline;';
        p2.appendChild(a);
        panel.appendChild(p2);

        var p3 = document.createElement('p');
        p3.setAttribute('data-i18n', 'firstRun.intro2');
        p3.textContent = '另一方面，我希望你从上方滴 help 按钮中找到社区滴链接，我们能确保你滴任何一个微小滴问题，都能有专人为你一对一滴解答';
        p3.style.cssText = 'margin:0;';
        panel.appendChild(p3);

        var row = _mkBtnRow();
        var btnOk = _mkButton('firstRun.introOk', '那很好');
        btnOk.addEventListener('click', function (e) {
            e.preventDefault();
            if (btnOk.disabled) return;
            btnOk.disabled = true;
            _writeMark(INTRO_KEY, LS_INTRO_KEY, function (ok) {
                if (ok) { _dismiss(); return; }
                btnOk.disabled = false;
                _setTextI18n(btnOk, 'firstRun.saveFailed', '保存失败，请重试');
                setTimeout(function () { _setTextI18n(btnOk, 'firstRun.introOk', '那很好'); }, 3000);
            });
        });
        row.appendChild(btnOk);
        panel.appendChild(row);
        _afterShow();
    }

    var _bootRetries = 0;
    var _bootBackoff = [1000, 3000, 8000];

    function _boot() {
        _readMark(KEY, LS_KEY, function (state) {
            if (state === 'has') {
                // 已同意过 → 第二层补弹判定（老用户 / 上次断链：恰好补一次；已看过 → 静默收工）
                _readMark(INTRO_KEY, LS_INTRO_KEY, function (st2) {
                    if (st2 === 'has') return;
                    if (st2 === 'none') { _showIntro(); return; }
                    _retryBoot();
                });
                return;
            }
            if (state === 'none') { _showExpert(); return; }
            _retryBoot();
        });
    }

    // unknown = 持久化层暂不可用（启动早期/库异常）：退避重试 ≤3 次；仍不可用 → 放弃弹窗
    //   （库不可用时弹了也存不进同意，只会让用户反复看到；宁可漏弹不可误弹）
    function _retryBoot() {
        _bootRetries++;
        if (_bootRetries <= _bootBackoff.length) {
            setTimeout(_boot, _bootBackoff[_bootRetries - 1]);
        } else {
            try { console.warn('[first-run] state store unavailable, skip first-run dialog'); } catch (e2) { /* ignore */ }
        }
    }

    // 首启弹窗等主窗口完全加载后再出（不干扰启动流水线）
    if (document.readyState === 'complete') {
        setTimeout(_boot, 4000);
    } else {
        window.addEventListener('load', function () { setTimeout(_boot, 4000); });
    }
})();
