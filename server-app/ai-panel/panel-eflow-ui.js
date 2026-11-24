// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// panel-eflow-ui.js — 「文档地基」面板（AI 面板内的显式入口）
//
// 定位：E-Flow 的唯一手动操作面。用户不必知道任何命令、不必先跟 AI 说话——
//   打开面板 → 看数字 → 点按钮。四个动作全部落到同一个内核：
//     server-app/eflow/eflow-core.js（EflowCore.run）
//   ★ 本文件禁止写第二份算术 / 第二套闸门（字数、预算、生成区同步一律由内核给）。
//   ★ 禁止任何「假成功」：内核返回什么就上屏什么；失败原样转述。
//
// 入口：AI 面板底排 #eflow-btn（任何时刻可达，含已有对话时）
//       ~New quest~ 空白面板的卡片（发现层，见 panel-tasks.js）
//       AI 工具 eflow（对话层，见 tools-exec-eflow.js）
// 关闭：点面板外 / Esc（无关闭钮——内置面板统一规范）
// ═══════════════════════════════════════════════════════════════════════════

(function () {
    if (window.qqqEflowPanel) return;   // 幂等（热重载 / 重复脚本标签）

    var OPS = ['upgrade', 'check', 'rotate', 'detach'];
    var CONFIRM_FOR = { upgrade: 1, detach: 1 };   // 会改 project.txt 的动作：二次点击确认

    var _ov = null;      // overlay
    var _pre = null;     // 输出区
    var _statusEl = null;
    var _btns = {};
    var _busy = false;
    var _armed = '';     // 正处于「再点一次确认」的动作
    var _armTimer = null;
    var _root = '';

    // ── i18n（zh.json 为唯一真理源；缺键用中文回退）────────────────────────
    function _t(key, fb) {
        try { if (typeof _qq === 'function') { var v = _qq(key, fb); if (v) return v; } } catch (_) { }
        return fb;
    }

    // ── 项目根 / IO ──────────────────────────────────────────────────────
    function _projectRoot() {
        try {
            if (typeof questStore !== 'undefined' && questStore.getProjectRoot) {
                var r = questStore.getProjectRoot();
                if (r) return String(r).replace(/\\/g, '/').replace(/\/+$/, '');
            }
        } catch (_) { }
        try { if (parent && parent.__qqq_projectRoot) return String(parent.__qqq_projectRoot).replace(/\\/g, '/'); } catch (_) { }
        return '';
    }
    function _bridge() {
        try { if (typeof getBridge === 'function') return getBridge(); } catch (_) { }
        try { return (window.qqqideBridge) || null; } catch (_) { }
        return null;
    }
    function _io(br) {
        return {
            read: function (p) { return br.fs.read(p); },
            write: function (p, t) { return br.fs.write(p, t); },
            list: function (p) { return br.fs.list(p); },
            exists: function (p) { return br.fs.exists(p); },
            mkdir: function (p) { return br.fs.mkdir(p); },
            remove: function (p) { return br.fs.remove(p); },
            rename: function (p, q) { return br.fs.rename(p, q); }
        };
    }

    // ── DOM ──────────────────────────────────────────────────────────────
    function _el(tag, cls, text) {
        var d = document.createElement(tag);
        if (cls) d.className = cls;
        if (text != null) d.textContent = text;
        return d;
    }

    function _build() {
        var ov = _el('div', 'ef-ov');
        var box = _el('div', 'ef-box');

        var head = _el('div', 'ef-head');
        var icName = 'compass';
        try { if (window.qqqIcons && window.qqqIcons.has && !window.qqqIcons.has('compass')) icName = 'package'; } catch (_) { }
        var ic = _el('span', 'qqi qqi-' + icName + ' ef-ico');
        head.appendChild(ic);
        head.appendChild(_el('span', 'ef-title', _t('ai.eflow.title', '文档地基')));
        box.appendChild(head);

        var rootEl = _el('div', 'ef-root', '');
        rootEl.title = '';
        box.appendChild(rootEl);

        var st = _el('div', 'ef-status');
        st.appendChild(_el('span', 'ef-st-num', '—'));
        st.appendChild(_el('span', 'ef-st-lab', _t('ai.eflow.loading', '正在读取…')));
        box.appendChild(st);

        var acts = _el('div', 'ef-acts');
        var defs = [
            ['upgrade', _t('ai.eflow.upgrade', '接入 / 升级'), 'EflowCore.run(\'upgrade\')'],
            ['check', _t('ai.eflow.check', '体检'), 'EflowCore.run(\'check\')'],
            ['rotate', _t('ai.eflow.rotate', '整理归档'), 'EflowCore.run(\'rotate\')'],
            ['detach', _t('ai.eflow.detach', '卸载'), 'EflowCore.run(\'detach\')']
        ];
        for (var i = 0; i < defs.length; i++) {
            (function (id, label, tip) {
                var b = _el('button', 'ef-btn ef-btn-' + id, label);
                b.type = 'button';
                b.setAttribute('data-id', id);
                b.title = tip;
                b.addEventListener('click', function (e) { e.preventDefault(); _onAction(id); });
                acts.appendChild(b);
                _btns[id] = b;
            })(defs[i][0], defs[i][1], defs[i][2]);
        }
        box.appendChild(acts);

        var pre = _el('pre', 'ef-out');
        pre.style.display = 'none';
        box.appendChild(pre);

        box.appendChild(_el('div', 'ef-hint', _t('ai.eflow.hint',
            '只动这个项目的 _qqq/alphal/expert/ 与 project.txt 里那一行；你自己的规则和文件不会被改。')));

        ov.appendChild(box);
        ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
        document.body.appendChild(ov);
        return ov;
    }

    function _paintStatus(text, num, tone) {
        if (!_statusEl) return;
        var n = _statusEl.querySelector('.ef-st-num');
        var l = _statusEl.querySelector('.ef-st-lab');
        if (n) n.textContent = (num == null ? '—' : num);
        if (l) l.textContent = text || '';
        _statusEl.className = 'ef-status' + (tone ? ' ' + tone : '');
    }

    function _showOut(text, ok) {
        if (!_pre) return;
        _pre.style.display = '';
        _pre.textContent = text || '';
        _pre.className = 'ef-out' + (ok ? '' : ' ef-out-bad');
    }

    // ── 状态：只跑内核 status ─────────────────────────────────────────────
    async function _refresh() {
        var br = _bridge();
        var core = (typeof EflowCore !== 'undefined' && EflowCore && EflowCore.run) ? EflowCore : null;
        if (!br || !br.fs || !core) {
            _paintStatus(_t('ai.eflow.noBridge', '当前窗口不可用（缺文件通道）'), '—', 'ef-st-bad');
            return;
        }
        var rootEl = document.querySelector('.ef-root');
        if (rootEl) { rootEl.textContent = _root; rootEl.title = _root; }
        try {
            var r = await core.run('status', _io(br), _root, {});
            var d = (r && r.data) || {};
            var inject = (typeof d.inject === 'number') ? d.inject : null;
            var ruleLines = (typeof d.ruleLines === 'number') ? d.ruleLines : 0;
            var l0 = (typeof d.l0 === 'number') ? d.l0 : 0;
            if (inject == null) {
                _paintStatus(_t('ai.eflow.stUnknown', '状态未知'), '—', 'ef-st-bad');
                return;
            }
            // 三种状态只看两个事实：有没有自己的 rule 行（ruleLines）、有没有 qd 背包的 L0（l0）
            if (ruleLines === 0 && inject === 0) {
                _paintStatus(_t('ai.eflow.stBlank', '未接入 · 每轮不注入任何文档'), '0', '');
            } else if (l0 > 0 && ruleLines > 0) {
                _paintStatus(_t('ai.eflow.stOn', '已接入 · 每轮注入'), String(inject), '');
            } else if (ruleLines > 0) {
                _paintStatus(_t('ai.eflow.stCustom', '自定义规则 · 每轮注入'), String(inject), '');
            } else {
                _paintStatus(_t('ai.eflow.stBlank', '未接入 · 每轮不注入任何文档'), String(inject), '');
            }
            if (_pre && _pre.style.display === 'none' && r.text) { /* 状态不抢输出区 */ }
        } catch (e) {
            _paintStatus(_t('ai.eflow.stFail', '读取失败') + '：' + ((e && e.message) || e), '—', 'ef-st-bad');
        }
    }

    // ── 动作 ─────────────────────────────────────────────────────────────
    function _arm(id, b) {
        var fb = {
            upgrade: _t('ai.eflow.confirmUpgrade', '再点一次：会往 project.txt 写一行 rule'),
            detach: _t('ai.eflow.confirmDetach', '再点一次：只摘掉那一行，文件不删')
        }[id] || _t('ai.eflow.confirm', '再点一次确认');
        _armed = id;
        var old = b.textContent;
        b.setAttribute('data-old', old);
        b.textContent = fb;
        b.classList.add('ef-btn-armed');
        if (_armTimer) clearTimeout(_armTimer);
        _armTimer = setTimeout(function () {
            _armed = '';
            b.textContent = b.getAttribute('data-old') || old;
            b.classList.remove('ef-btn-armed');
        }, 6000);
    }

    async function _onAction(id) {
        if (_busy) return;
        var br = _bridge();
        var core = (typeof EflowCore !== 'undefined' && EflowCore && EflowCore.run) ? EflowCore : null;
        if (!br || !br.fs || !core) { _showOut(_t('ai.eflow.noBridge', '当前窗口不可用（缺文件通道）'), false); return; }
        var b = _btns[id];
        if (CONFIRM_FOR[id] && _armed !== id) { _arm(id, b); return; }
        _armed = '';
        if (_armTimer) { clearTimeout(_armTimer); _armTimer = null; }
        if (b && b.getAttribute('data-old')) { b.textContent = b.getAttribute('data-old'); b.classList.remove('ef-btn-armed'); }

        _busy = true;
        for (var k in _btns) { if (_btns[k]) _btns[k].disabled = true; }
        _showOut(_t('ai.eflow.running', '正在执行…'), true);
        try {
            var opts = {};
            if (id === 'rotate') { opts.apply = true; opts.days = 0; }
            var r = await core.run(id, _io(br), _root, opts);
            _showOut((r && r.text) || _t('ai.eflow.noOut', '（没有输出）'), !!(r && r.ok));
            if (id === 'upgrade' || id === 'detach') {
                try { if (typeof ExpertFlow !== 'undefined' && ExpertFlow.autoDetect) await ExpertFlow.autoDetect(_root); } catch (_) { }
                try { if (typeof window.qqqTaskPane !== 'undefined' && window.qqqTaskPane.reload) window.qqqTaskPane.reload(); } catch (_) { }
            }
        } catch (e) {
            _showOut(_t('ai.eflow.failed', '失败') + '：' + ((e && e.message) || e), false);
        } finally {
            _busy = false;
            for (var k2 in _btns) { if (_btns[k2]) _btns[k2].disabled = false; }
            _refresh();
        }
    }

    // ── 开关 ─────────────────────────────────────────────────────────────
    function _onKey(e) {
        if (!e || e.key !== 'Escape') return;
        e.stopPropagation();
        close();
    }

    function open() {
        _root = _projectRoot();
        if (!_root) { try { _qoast(_t('ai.eflow.noRoot', '没有打开的项目'), { type: 'info' }); } catch (_) { } return; }
        if (!_ov) _ov = _build();
        _statusEl = _ov.querySelector('.ef-status');
        _pre = _ov.querySelector('.ef-out');
        if (_pre) { _pre.style.display = 'none'; _pre.textContent = ''; }
        _ov.style.display = '';
        document.addEventListener('keydown', _onKey, true);
        _refresh();
    }

    function close() {
        if (_ov) _ov.style.display = 'none';
        document.removeEventListener('keydown', _onKey, true);
        if (_armTimer) { clearTimeout(_armTimer); _armTimer = null; }
        _armed = '';
    }

    window.qqqEflowPanel = { open: open, close: close, refresh: _refresh };

    // 底排入口按钮（脚本在 index.html 里位于按钮之后 → DOMContentLoaded 后再绑）
    function _bindBtn() {
        var b = document.getElementById('eflow-btn');
        if (!b) return;
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(); });
    }
    _bindBtn();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _bindBtn);   // 脚本在按钮之后 → 通常首调即成；前置加载时再补一次
})();
