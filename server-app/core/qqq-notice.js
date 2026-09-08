// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-notice.js — 客户端通知唯一入口（2026-09-07 立项，版本号旁圆点）
//
// 机制: 服务器静态 JSON 下发（与 qqq-links.js 同通道，改动即生效零部署零重启）
//   真理源: https://direct-cn.gh555.com/static/qqqide/notices.json（www 备线）
//   运维控制台: gaea/cf/qqqide/客户端通知.py（PySide2，SFTP 直写 + 公网回读）
//   兜底: 无（拉取失败 = 零打扰；本系统不做任何客户端内置公告）
//
// 条目 schema（★ 只增不改：老客户端忽略未知字段；未来新场景只加字段/加过滤函数）
//   id          [A-Za-z0-9._-]{1,48} 必填
//   rev         int 内容版本；编辑内容后 +1 = 已读用户重新提醒（缺省 0）
//   level       info | warn | critical（三级封顶，永不扩展）
//   title/text  字符串 或 {lang: 文案} 对象（zh/en/ja…，取当前语言 → zh → en → 首值）
//   link        可选动作 http/https（未知动作类型 = 无按钮，UI 永不破）
//   min / max   版本门控（语义数字段比较，如 max:"0.3.183" = 仅 0.3.183 以下可见；缺省不限）
//   langs       [] 显示语言白名单（缺省 = 全语言）
//   pct         1-100 采样百分比（按 id 稳定哈希，同 id 跨刷新恒定；缺省 100）
//   need_login  true = 仅登录用户可见（缺省 false）
//   ts          发布时间（面板显示用，epoch 秒）
//   ts_from/ts_until  生效起止（epoch 秒；0 = 不限；到期条目自动消失零回收）
//   once        true = 知道了即已读消失；false = 知道了后空心点常驻直到版本窗/时间窗清除（升级类）
//   enabled     false = 停用（客户端整条丢弃，管理台保留历史；缺省 true）
//   客户端解析未知字段一律忽略；未知 level 按 info 渲染 → 一万年兼容
//
// 打扰阶梯（用户只可能被最重一级打扰一次；词表固定三级）
//   info        → 版本号旁灰点，零主动打扰
//   warn        → 黄点 + 首次胶囊条 8s 自动收回（同一次运行同 id 不重复）
//   critical    → 红点 + 模态（未确认条目每次启动弹一次，一次列出全部；点「知道了」转点常驻）
//   点任意点    → 通知中心面板（全部可见条目：未处理置顶 / 已读灰显）
//   版本区间外/时间窗外/langs 外/pct 外 → 整条过滤不占位（不存在"区间外怎么办"）
//
// 已读/确认状态: 程序级 global.sq3（六入口 qgs.simple，ns=qqq.notice，key=acks → {id: rev}）
//   随保险库跨更新保留；服务端 rev+1 = 内容更新 → 自动重新提醒
// 刷新: 启动即拉 + 30min 静默；失败 60s 后单次重试再回周期
// 加载点: server-app/index.html（主窗口，shell.js 之后任意位置）
// ============================================================================

; (function () {
    'use strict';

    if (parent !== window) return;           // 仅主窗口
    if (!window.qqqideQoast) return;         // 依赖缺失 → 静默（通知非关键路径，永不阻塞任何流程）

    var _URLS = [
        'https://direct-cn.gh555.com/static/qqqide/notices.json',
        'https://www.gh555.com/static/qqqide/notices.json'
    ];
    var REFRESH_MS = 30 * 60 * 1000;         // 30min 静默刷新
    var RETRY_MS = REFRESH_MS;               // 拉取失败静默等下一个周期（服务器文件由管理台主动下发，无需密集重试）
    var MAX_ITEMS = 60;                      // 服务端条目数量防御上限
    var ACK_KEY = 'acks';                    // 存储 key: {id: rev}

    var _items = null;        // 清洗后的服务器条目（null = 尚未成功拉取）
    var _acks = {};           // 本地已确认 {id: rev}
    var _acksLoaded = false;
    var _disturbed = {};      // 本次运行已打扰过的 id（模态/胶囊同 id 只一次）
    var _modalShownRun = false; // 本次运行模态是否已弹过（此后新 critical 只亮红点）
    var _loading = false;
    var _dot = null;
    var _overlay = null;      // 通知中心（懒建）
    var _modal = null;        // 紧急模态（懒建）

    // ── 本地化 ──────────────────────────────────────────────────────────
    function _lang() {
        try { if (window.i18n && window.i18n.getLang) return window.i18n.getLang(); } catch (e) { }
        return 'zh';
    }
    function _t(key, fallback) {
        try { if (window._i) return window._i(key, fallback); } catch (e) { }
        return fallback;
    }
    function _pick(doc) {
        // title/text 支持字符串或 {lang: 文案} 对象
        if (!doc) return '';
        if (typeof doc === 'string') return doc;
        if (typeof doc === 'object') {
            var lang = _lang();
            if (typeof doc[lang] === 'string' && doc[lang]) return doc[lang];
            if (typeof doc.zh === 'string' && doc.zh) return doc.zh;
            if (typeof doc.en === 'string' && doc.en) return doc.en;
            var ks = Object.keys(doc);
            for (var i = 0; i < ks.length; i++) {
                if (typeof doc[ks[i]] === 'string' && doc[ks[i]]) return doc[ks[i]];
            }
        }
        return '';
    }

    // ── 存储（程序级 global.sq3；跨项目/跨窗口一致）────────────────────
    var _h = null;
    function _handle() {
        if (!_h && window.qgs && window.qgs.simple) {
            try { _h = window.qgs.simple('qqq.notice', { cloud: false }); } catch (e) { _h = null; }
        }
        return _h;
    }
    // qgs get 同步/异步双形态兜底（first-run.js 同款）
    function _loadAcks(cb) {
        var h = _handle();
        if (!h) { _acksLoaded = true; cb(); return; }
        var done = false;
        function fin(v) {
            if (done) return;
            done = true;
            if (v && typeof v === 'object') _acks = v;
            _acksLoaded = true;
            cb();
        }
        try {
            var p = h.get(ACK_KEY);
            if (p && typeof p.then === 'function') { p.then(fin, function () { fin(null); }); }
            else { fin(p); }
        } catch (e) { fin(null); }
    }
    function _saveAcks() {
        var h = _handle();
        if (h) { try { h.set(ACK_KEY, _acks); } catch (e) { /* 内存态已生效，落盘失败下次再写 */ } }
    }

    // ── 本地版本（boot.version = versions.json id，与左下角同源）────────
    function _curVer() {
        try {
            var b = window.qqqBootInfo;
            if (b && b.version && b.version !== '?') return String(b.version).replace(/^v/i, '');
        } catch (e) { }
        var el = document.getElementById('qqq-status-version');
        if (el) {
            var t = (el.textContent || '').replace(/^v/i, '');
            if (t && t !== '0.0.3') return t; // 0.0.3 = 静态占位（bootStatusbar 未跑），视为未知
        }
        return null;
    }
    // boot 完成前轮询等待（≤6s，之后按占位值处理）
    function _waitVer(cb) {
        if (_curVer()) { cb(); return; }
        var n = 0;
        var iv = setInterval(function () {
            n++;
            if (_curVer() || n > 24) { clearInterval(iv); cb(); }
        }, 250);
    }
    // 语义数字段比较（0.3.183 → [0,3,183]），非数字段按 0
    function _cmp(a, b) {
        var pa = String(a || '').replace(/^v/i, '').split('.');
        var pb = String(b || '').replace(/^v/i, '').split('.');
        var n = Math.max(pa.length, pb.length);
        for (var i = 0; i < n; i++) {
            var na = parseInt(pa[i], 10), nb = parseInt(pb[i], 10);
            if (isNaN(na)) na = 0;
            if (isNaN(nb)) nb = 0;
            if (na !== nb) return na < nb ? -1 : 1;
        }
        return 0;
    }

    // ── 清洗（脏条目静默丢弃；未知字段忽略）────────────────────────────
    var _idRe = /^[A-Za-z0-9._-]{1,48}$/;
    var _verRe = /^[\d.]+$/;
    function _str(v) { return typeof v === 'string' ? v : ''; }
    function _int(v) { return typeof v === 'number' && isFinite(v) ? Math.floor(v) : 0; }
    function _url(v) {
        var s = _str(v).trim();
        if (!s) return '';
        try {
            var u = new URL(s, 'https://gh555.com/');
            return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
        } catch (e) { return ''; }
    }
    function _verField(v) {
        var s = _str(v).replace(/^v/i, '');
        return _verRe.test(s) ? s : '';
    }
    function _clean(j) {
        if (!j || typeof j !== 'object' || !Array.isArray(j.items)) return null;
        var out = [];
        var list = j.items;
        var n = Math.min(list.length, MAX_ITEMS);
        for (var i = 0; i < n; i++) {
            var it = list[i];
            if (!it || typeof it !== 'object') continue;
            var id = _str(it.id);
            if (!id || !_idRe.test(id)) continue;
            var level = _str(it.level);
            if (level !== 'info' && level !== 'warn' && level !== 'critical') level = 'info';
            if (it.enabled === false) continue; // 停用条目不下发展示（防御：管理台源头已过滤）
            var langs = Array.isArray(it.langs) ? it.langs.filter(function (x) { return typeof x === 'string' && x; }) : [];
            var pct = _int(it.pct);
            if (!(pct >= 1 && pct <= 100)) pct = 100;
            out.push({
                id: id,
                rev: _int(it.rev),
                level: level,
                title: it.title,          // 原样保留，渲染时 _pick
                text: it.text,
                link: _url(it.link),
                min: _verField(it.min),
                max: _verField(it.max),
                langs: langs,
                pct: pct,
                need_login: !!it.need_login,
                ts: _int(it.ts),
                ts_from: _int(it.ts_from),
                ts_until: _int(it.ts_until),
                once: !!it.once
            });
        }
        return out; // 空数组合法（服务器已清空 = 真理）
    }

    // ── 受众过滤（过滤维度本地化 = 老客户端忽略新字段，优雅降级）────────
    function _loggedIn() {
        try {
            var L = window.qqqLogin;
            return !!(L && typeof L.getPhone === 'function' && L.getPhone());
        } catch (e) { return false; }
    }
    function _hashPct(id) { // 1..100 稳定哈希（同 id 恒同值）
        var s = 0;
        for (var i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
        return (s % 100) + 1;
    }
    function _visible(nowMs) {
        if (!_items) return [];
        var now = Math.floor((nowMs || Date.now()) / 1000); // 时间窗字段为 epoch 秒
        var v = _curVer();
        var lang = _lang();
        var out = [];
        for (var i = 0; i < _items.length; i++) {
            var it = _items[i];
            if (it.min && (!v || _cmp(v, it.min) < 0)) continue;
            if (it.max && (!v || _cmp(v, it.max) > 0)) continue;
            if (it.langs.length && it.langs.indexOf(lang) < 0) continue;
            if (it.pct < 100 && _hashPct(it.id) > it.pct) continue;
            if (it.need_login && !_loggedIn()) continue;
            if (it.ts_from && now < it.ts_from) continue;
            if (it.ts_until && now > it.ts_until) continue;
            out.push(it);
        }
        return out;
    }
    function _rank(l) { return l === 'critical' ? 2 : l === 'warn' ? 1 : 0; }
    function _sort(a, b) {
        var d = _rank(b.level) - _rank(a.level);
        if (d) return d;
        return (b.ts || 0) - (a.ts || 0);
    }
    function _acked(it) { return _acks[it.id] === it.rev; }
    // 需要点亮 = 未确认 或 已确认但 once=false（常驻提醒升级未完成）
    function _needsDot(it) { return !_acked(it) || !it.once; }

    // ── 圆点 ────────────────────────────────────────────────────────────
    function _ensureDot() {
        if (_dot) return _dot;
        var ver = document.getElementById('qqq-status-version');
        if (!ver || !ver.parentNode) return null;
        var d = document.createElement('span');
        d.id = 'qqq-notice-dot';
        d.className = 'qqq-notice-dot';
        d.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            _openPanel();
        });
        ver.parentNode.insertBefore(d, ver.nextSibling);
        _dot = d;
        return d;
    }
    function _renderDot(list) {
        var d = _ensureDot();
        if (!d) return;
        var show = false, top = 'info', ring = false, anyUnacked = false;
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (!_needsDot(it)) continue;
            show = true;
            var r = _rank(it.level);
            if (r > _rank(top)) { top = it.level; ring = false; }
            if (r === _rank(top) && !_acked(it)) { ring = false; }
            if (!_acked(it)) anyUnacked = true;
        }
        if (!show) { d.style.display = 'none'; return; }
        // 等级最高的条目若全部已确认（once=false 常驻）→ 空心点
        var topUnacked = false;
        for (var j = 0; j < list.length; j++) {
            if (_rank(list[j].level) === _rank(top) && !_acked(list[j])) { topUnacked = true; break; }
        }
        d.style.display = '';
        d.className = 'qqq-notice-dot lv-' + top + (topUnacked ? '' : ' ring');
        d.title = anyUnacked ? _t('notice.dotPending', '有未读通知') : _t('notice.dot', '通知');
    }

    // ── 通知中心面板 ────────────────────────────────────────────────────
    function _openExt(url) {
        try {
            if (window.qqqideBridge && window.qqqideBridge.shell && window.qqqideBridge.shell.openExternal) {
                window.qqqideBridge.shell.openExternal(url);
                return;
            }
        } catch (e) { }
        try { window.open(url, '_blank'); } catch (e) { }
    }

    function _buildOverlay(cls) {
        var ov = document.createElement('div');
        ov.className = cls;
        ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);' +
            'z-index:99940;display:none;align-items:center;justify-content:center;';
        ov.addEventListener('click', function (e) { if (e.target === ov) ov.style.display = 'none'; });
        document.body.appendChild(ov);
        return ov;
    }

    function _ensurePanel() {
        if (_overlay) return _overlay;
        _overlay = _buildOverlay('qqq-notice-overlay');
        _overlay.innerHTML =
            '<div class="qqq-notice-panel">' +
            '<div class="qqq-notice-head"><span class="qqq-notice-title"></span></div>' +
            '<div class="qqq-notice-body"></div>' +
            '</div>';
        return _overlay;
    }

    function _timeText(ts) {
        if (!ts) return '';
        try {
            var d = new Date(ts * 1000);
            var p = function (x) { return (x < 10 ? '0' : '') + x; };
            return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        } catch (e) { return ''; }
    }

    function _ack(it) {
        if (typeof _acks[it.id] === 'number' && _acks[it.id] > it.rev) return; // 不降级
        _acks[it.id] = it.rev;
        _saveAcks();
    }

    // 行内容（面板与模态共用骨架）
    function _rowEl(it, inModal) {
        var title = _pick(it.title);
        var text = _pick(it.text);
        if (!title && text) title = text.length > 48 ? text.slice(0, 48) + '…' : text;

        var row = document.createElement('div');
        row.className = 'qqq-notice-row' + (_acked(it) ? ' acked' : '') + (inModal ? ' in-modal' : '');

        var lv = document.createElement('span');
        lv.className = 'qqq-notice-lv lv-' + it.level;
        row.appendChild(lv);

        var main = document.createElement('div');
        main.className = 'qqq-notice-main';

        var th = document.createElement('div');
        th.className = 'qqq-notice-rtitle';
        th.textContent = title || _t('notice.title', '通知');
        var metaTxt = _timeText(it.ts);
        if (_acked(it)) metaTxt = (metaTxt ? metaTxt + ' · ' : '') + _t('notice.read', '已读');
        if (metaTxt) {
            var meta = document.createElement('span');
            meta.className = 'qqq-notice-meta';
            meta.textContent = metaTxt;
            th.appendChild(meta);
        }
        main.appendChild(th);

        if (text) {
            var tx = document.createElement('div');
            tx.className = 'qqq-notice-rtext';
            tx.textContent = text;
            main.appendChild(tx);
        }
        row.appendChild(main);

        if (!_acked(it) || it.link) {
            var acts = document.createElement('div');
            acts.className = 'qqq-notice-acts';
            if (it.link) {
                var a = document.createElement('a');
                a.className = 'qqq-notice-btn';
                a.href = it.link;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = _t('notice.open', '打开链接');
                acts.appendChild(a);
            }
            if (!_acked(it)) {
                var b = document.createElement('button');
                b.className = 'qqq-notice-btn';
                b.textContent = _t('notice.ack', '知道了');
                b.addEventListener('click', function () {
                    _ack(it);
                    if (inModal) {
                        // 留在模态内继续处理余下条目；全部确认后才收起
                        _renderModalBody();
                        var mb = _modal && _modal.querySelector('.qqq-notice-body');
                        if (!mb || !mb.childNodes.length) _closeModal();
                    } else {
                        if (_overlay && _overlay.style.display !== 'none') _renderPanelBody();
                    }
                    _apply();
                });
                acts.appendChild(b);
            }
            row.appendChild(acts);
        }
        return row;
    }

    // 面板打开时：未处理置顶（级别→时间），已读灰显其后
    function _renderPanelBody() {
        var ov = _ensurePanel();
        var body = ov.querySelector('.qqq-notice-body');
        var headT = ov.querySelector('.qqq-notice-title');
        if (!body) return;
        var list = _visible(Date.now()).sort(_sort);
        headT.textContent = _t('notice.title', '通知');
        body.innerHTML = '';
        if (!list.length) {
            var e = document.createElement('div');
            e.className = 'qqq-notice-empty';
            e.textContent = _t('notice.empty', '暂无通知');
            body.appendChild(e);
            return;
        }
        var pending = list.filter(function (x) { return !_acked(x); });
        var rest = list.filter(function (x) { return _acked(x); });
        var ordered = pending.concat(rest);
        for (var i = 0; i < ordered.length; i++) body.appendChild(_rowEl(ordered[i], false));
    }

    function _openPanel() {
        var ov = _ensurePanel();
        ov.style.display = 'flex';
        _renderPanelBody();
    }

    // ── 紧急模态（一次列出全部未确认 critical）─────────────────────────
    function _ensureModal() {
        if (_modal) return _modal;
        _modal = _buildOverlay('qqq-notice-modal-overlay');
        _modal.style.zIndex = '99950';
        _modal.innerHTML =
            '<div class="qqq-notice-modal">' +
            '<div class="qqq-notice-head"><span class="qqq-notice-title"></span></div>' +
            '<div class="qqq-notice-body"></div>' +
            '<div class="qqq-notice-modal-hint"></div>' +
            '</div>';
        return _modal;
    }
    function _renderModalBody() {
        var m = _ensureModal();
        var headT = m.querySelector('.qqq-notice-title');
        var hint = m.querySelector('.qqq-notice-modal-hint');
        var body = m.querySelector('.qqq-notice-body');
        headT.textContent = _t('notice.modalTitle', '重要通知');
        hint.textContent = _t('notice.modalHint', '处理后可随时点击版本号旁的圆点查看全部通知');
        var list = _visible(Date.now()).filter(function (x) { return x.level === 'critical' && !_acked(x); });
        body.innerHTML = '';
        for (var i = 0; i < list.length; i++) body.appendChild(_rowEl(list[i], true));
    }
    function _showModal() {
        _renderModalBody();
        var m = _ensureModal();
        var body = m.querySelector('.qqq-notice-body');
        if (!body.childNodes.length) { m.style.display = 'none'; return; }
        m.style.display = 'flex';
    }
    function _closeModal() {
        if (_modal) _modal.style.display = 'none';
    }

    // ── 打扰（核心规则：同一运行期同一 id 只扰一次；critical > warn 不叠加）─
    function _disturb(list) {
        var crits = list.filter(function (x) { return x.level === 'critical' && !_acked(x) && !_disturbed[x.id]; });
        if (crits.length) {
            for (var i = 0; i < crits.length; i++) _disturbed[crits[i].id] = 1;
            if (!_modalShownRun) {
                _modalShownRun = true;
                _showModal();
            } else {
                // 本次运行已弹过模态：只亮红点（modal 内已确认过的用户不会再被打扰）
                var stillUnacked = list.some(function (x) { return x.level === 'critical' && !_acked(x); });
                if (stillUnacked) return;
            }
            return; // critical 在场时 warn 不弹胶囊（只被最重一级打扰）
        }
        var warns = list.filter(function (x) { return x.level === 'warn' && !_acked(x) && !_disturbed[x.id]; });
        var anyCritUnacked = list.some(function (x) { return x.level === 'critical' && !_acked(x); });
        if (!anyCritUnacked && warns.length) {
            var w = warns[0];
            _disturbed[w.id] = 1;
            var title = _pick(w.title);
            var text = _pick(w.text);
            var msg = title || '';
            if (text) msg = msg ? msg + '：' + text : text;
            if (msg.length > 120) msg = msg.slice(0, 120) + '…';
            window.qqqideQoast.show(msg, {
                type: 'warn',
                duration: 8000,
                action: { label: _t('notice.view', '查看'), onClick: _openPanel }
            });
        }
    }

    // ── 主流程 ──────────────────────────────────────────────────────────
    function _apply() {
        if (!_acksLoaded) return; // 待 ack 就绪
        _waitVer(function () {
            var list = _visible(Date.now()).sort(_sort);
            _renderDot(list);
            _disturb(list);
            if (_overlay && _overlay.style.display !== 'none') _renderPanelBody();
        });
    }

    function _refresh() {
        if (_loading) return;
        _loading = true;
        (function _try(i) {
            if (i >= _URLS.length) { _loading = false; setTimeout(_refresh, RETRY_MS); return; }
            fetch(_URLS[i] + '?_=' + Date.now(), { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    var c = _clean(j);
                    if (c !== null) {
                        _items = c;
                        _loading = false;
                        _apply();
                    } else {
                        _try(i + 1);
                    }
                })
                .catch(function () { _try(i + 1); });
        })(0);
    }

    // 语言切换 → 开着面板/模态按新语言重渲染；圆点 title 刷新
    window.addEventListener('qqq-lang-change', function () {
        if (_overlay && _overlay.style.display !== 'none') _renderPanelBody();
        if (_modal && _modal.style.display !== 'none') _renderModalBody();
        var d = _ensureDot();
        if (d && d.style.display !== 'none') {
            var list = _visible(Date.now());
            var anyUnacked = list.some(function (x) { return !_acked(x); });
            d.title = anyUnacked ? _t('notice.dotPending', '有未读通知') : _t('notice.dot', '通知');
        }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (_modal && _modal.style.display !== 'none') { _modal.style.display = 'none'; return; }
        if (_overlay && _overlay.style.display !== 'none') { _overlay.style.display = 'none'; }
    });

    // 启动：acks 加载 → 拉取 → 30min 周期
    _loadAcks(function () {
        _refresh();
        setInterval(_refresh, REFRESH_MS);
    });
})();
