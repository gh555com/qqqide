// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// panel-tasks.js — 空白面板「一键任务」卡（~New quest~ 时中间区域的默认内容）
//
// 唯一职责：把任务卡画进 #messages-wrap 的空白层；点一张卡 = 替用户说一句话。
//   ★ 点击 = 与「打字 + Enter」完全同一条发送管线（_gateBeforeSend → _freezeAndSendFromInput）：
//     用户气泡即时上屏 → 建第一楼 → AI 正常流式开工。卡片本身不含任何可执行动作——
//     干什么、怎么干，全部交给对话（AI 侧工具 run_task / 常规工具）。
//
// 任务列表 = 服务器真理源（静态 JSON，改服务器即下发，零发版零重启）：
//   ① https://cdn.gh555.com/qqqide-up/tasks.json         （主源：内容层不缓存位置，发布即生效）
//   ② https://cdn.gh555.com/qqqide/tasks.json            （兼容源：nginx 缓存 1 天）
//   ③ https://direct-cn.gh555.com/static/qqqide/tasks.json（服务器静态：与通知/超链接同通道）
//   ④ https://www.gh555.com/static/qqqide/tasks.json      （备线）
//   ⑤ 出厂兜底 TASK_FALLBACK（离线/全线路失败时）——与运维台 DEFAULT_TASKS 双写同步
//
// 契约（只增不改，老客户端永远不炸）：
//   · 未知字段一律忽略；没 prompt 的卡整条丢弃（点了没话说的卡不显示）
//   · 卡片只有一句话（title）+ 一个提词（prompt），没有描述行——信息越少越快做决定
//   · 显示层文案支持字符串或 {lang: 文案} 对象（取当前语言 → zh → en → 首值）
// ═══════════════════════════════════════════════════════════════════════════

(function () {
    'use strict';
    if (window.__qqqTasksInited) return;
    window.__qqqTasksInited = true;

    // ★ 主源必须走「不缓存」位置（cdn 的 /qqqide-up/ 在 nginx 里是 proxy_cache off）：
    //   /qqqide/* 会被 nginx 本地缓存 1 天（proxy_cache_key 只认 $uri，query 破不了缓存）
    //   → 发布后最多晚一天才生效；两条都发（qqqide-up 即时生效，qqqide 兼容老客户端）。
    var URLS = [
        'https://cdn.gh555.com/qqqide-up/tasks.json',
        'https://cdn.gh555.com/qqqide/tasks.json',
        'https://direct-cn.gh555.com/static/qqqide/tasks.json',
        'https://www.gh555.com/static/qqqide/tasks.json'
    ];
    var FETCH_TIMEOUT = 6000;
    var REFRESH_MS = 30 * 60 * 1000;       // 30min 静默刷新（与通知机同节奏）
    var MAX_CARDS = 8;
    var CACHE_KEY = 'tasks';               // qgs ns = qqq.tasks
    var PANE_ID = 'task-pane';

    // ★ 出厂兜底（运维台 gaea/cf/qqqide/默认任务.py 的 DEFAULT_TASKS 双写同步点）
    //   提词一律「用户口吻一句话」——它就是楼层里用户气泡的原文。
    var TASK_FALLBACK = {
        title: { zh: '一键任务', en: 'Quick tasks' },
        subtitle: { zh: '点一下就开始', en: 'One click to start' },
        tasks: [
            {
                id: 'clean-c', icon: 'trash', platforms: ['win'],
                title: { zh: '清理 C 盘', en: 'Clean C drive' },
                desc: { zh: '先列清单，你同意了再删', en: 'Lists first, deletes after you approve' },
                prompt: '帮我清一清 C 盘，先把能删的东西列出来给我看，我同意了再删。'
            },
            {
                id: 'autostart-qd', icon: 'clock', platforms: ['win'],
                title: { zh: '开机自启', en: 'Start on boot' },
                desc: { zh: 'qd 开机自动打开', en: 'Launch qd automatically after sign-in' },
                prompt: '把 qd 设成开机自启，以后开机就自动打开。'
            },
            {
                id: 'eflow-upgrade', icon: 'download', platforms: ['win', 'mac', 'linux'],
                title: { zh: '升级 E-Flow', en: 'Upgrade E-Flow' },
                desc: { zh: '把本机 E-Flow 升到最新', en: 'Upgrade local E-Flow to latest' },
                prompt: '帮我把本机的 E-Flow 升级到最新版。'
            },
            {
                id: 'install-everything', icon: 'search', platforms: ['win'],
                title: { zh: '装 Everything', en: 'Install Everything' },
                desc: { zh: '秒级全盘搜索 + 桌面快捷方式', en: 'Instant file search + desktop shortcut' },
                prompt: '帮我装个 Everything 文件搜索工具，装好以后在桌面放个快捷方式。'
            },
            {
                id: 'startup-clean', icon: 'snow', platforms: ['win', 'mac', 'linux'],
                title: { zh: '电脑卡顿', en: 'Slow PC' },
                desc: { zh: '列出自启项，你同意了再关', en: 'Lists startup items, closes after you approve' },
                prompt: '我的电脑有点卡，帮我看看开机自启里有什么能关的，先列清单，我同意了再关。'
            },
            {
                // macOS 没有 Everything，等价物是系统自带 Spotlight 索引（要的是把索引弄好，不是「随便找个文件」）
                id: 'spotlight-search', icon: 'search', platforms: ['mac'],
                title: { zh: '启用 Spotlight', en: 'Enable Spotlight' },
                desc: { zh: '检查索引，坏了就修好', en: 'Check and repair the Spotlight index' },
                prompt: '帮我检查这台 Mac 的 Spotlight 索引正不正常（mdfind 能不能立刻搜到文件），不正常就修好；修完用一个真实的搜索演示给我看。'
            },
            {
                // Linux 没有 Everything，等价物是 locate（plocate/mlocate）索引
                id: 'locate-search', icon: 'search', platforms: ['linux'],
                title: { zh: '装 locate', en: 'Install locate' },
                desc: { zh: '装 plocate 建索引，秒查文件', en: 'Install plocate and build the index' },
                prompt: '帮我在这台 Linux 上装好 locate（优先 plocate）并建好索引，需要管理员权限的命令你告诉我，我自己执行；装完用一个真实的搜索演示给我看。'
            }
        ]
    };

    var _data = null;         // 已清洗的任务数据
    var _pane = null;
    var _loadedOnce = false;
    var _timer = null;

    // ── 基础工具 ─────────────────────────────────────────────────────────
    function _boot() {
        try { if (parent && parent.qqqBootInfo) return parent.qqqBootInfo; } catch (_) { }
        return window.qqqBootInfo || null;
    }
    function _plat() {
        var p = (_boot() && _boot().platform) || '';
        if (p === 'win32' || p === 'win') return 'win';
        if (p === 'darwin' || p === 'mac') return 'mac';
        if (p === 'linux') return 'linux';
        return 'win';
    }
    function _arch() {
        var b = _boot();
        return (b && b.arch) ? String(b.arch) : '';
    }
    function _lang() {
        try { if (window.i18n && window.i18n.getLang) return window.i18n.getLang(); } catch (_) { }
        try { if (parent && parent.i18n && parent.i18n.getLang) return parent.i18n.getLang(); } catch (_) { }
        return 'zh';
    }
    function _pick(v) {
        if (!v) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'object') {
            var lang = _lang();
            if (typeof v[lang] === 'string' && v[lang]) return v[lang];
            if (typeof v.zh === 'string' && v.zh) return v.zh;
            if (typeof v.en === 'string' && v.en) return v.en;
            var ks = Object.keys(v);
            for (var i = 0; i < ks.length; i++) {
                if (typeof v[ks[i]] === 'string' && v[ks[i]]) return v[ks[i]];
            }
        }
        return '';
    }
    function _t(key, fb) {
        try { if (typeof _qq === 'function') return _qq(key, fb); } catch (_) { }
        return fb;
    }
    function _qoast(msg, type, ms) {
        try {
            if (parent && parent.qqqideQoast && parent.qqqideQoast.show) {
                parent.qqqideQoast.show(msg, { type: type || 'info', duration: ms || 5000 });
                return;
            }
        } catch (_) { }
        console.log('[tasks] ' + msg);
    }
    function _platMatch(plats) {
        if (!plats || !plats.length) return true;
        var plat = _plat(), arch = _arch();
        for (var i = 0; i < plats.length; i++) {
            var p = String(plats[i] || '').toLowerCase();
            if (p === 'all' || p === plat) return true;
            if (arch && p === plat + '-' + arch.toLowerCase()) return true;
        }
        return false;
    }

    // ── 本地缓存（程序级 global.sq3；离线也能出卡）──────────────────────
    var _h = null;
    function _handle() {
        if (!_h) {
            try { if (window.qgs && window.qgs.simple) _h = window.qgs.simple('qqq.tasks', { cloud: false }); }
            catch (_) { _h = null; }
        }
        return _h;
    }
    function _loadCache(cb) {
        var h = _handle();
        if (!h) { cb(null); return; }
        var done = false;
        function fin(v) { if (done) return; done = true; cb(v && typeof v === 'object' ? v : null); }
        try {
            var p = h.get(CACHE_KEY);
            if (p && typeof p.then === 'function') { p.then(fin, function () { fin(null); }); }
            else fin(p);
        } catch (_) { fin(null); }
    }
    function _saveCache(raw) {
        var h = _handle();
        if (!h) return;
        try { h.set(CACHE_KEY, raw); } catch (_) { }
    }

    // ── 数据清洗 ─────────────────────────────────────────────────────────
    function _sanitize(raw) {
        if (!raw || !raw.tasks || !raw.tasks.length) return null;
        var out = [];
        var seen = {};
        for (var i = 0; i < raw.tasks.length && out.length < MAX_CARDS; i++) {
            var t = raw.tasks[i];
            if (!t || typeof t !== 'object') continue;
            if (t.enabled === false) continue;
            var id = String(t.id || '').trim();
            if (!id || seen[id]) continue;
            if (!_platMatch(t.platforms)) continue;
            var title = _pick(t.title);
            if (!title) continue;
            // 旧版卡（kind=action / 无 prompt）一律丢弃：本面板只负责「说一句话」，
            // 干活由对话里的 AI 决定（老客户端读旧表照旧，契约只增不改）
            if (!t.prompt || typeof t.prompt !== 'string') continue;
            seen[id] = 1;
            out.push({
                id: id,
                title: title,
                desc: _pick(t.desc),
                icon: String(t.icon || ''),
                prompt: t.prompt
            });
        }
        if (!out.length) return null;
        return {
            title: _pick(raw.title) || TASK_FALLBACK.title.zh,
            subtitle: _pick(raw.subtitle) || TASK_FALLBACK.subtitle.zh,
            tasks: out
        };
    }
    function _fallback() {
        var f = _sanitize(TASK_FALLBACK);
        return f || { title: '一键任务', subtitle: '', tasks: [] };
    }

    // ── 拉取（三级线路，逐级降级，失败静默）──────────────────────────────
    function _fetchOne(url) {
        return new Promise(function (resolve, reject) {
            var settled = false;
            var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            var to = setTimeout(function () {
                if (settled) return;
                settled = true;
                try { if (ctl) ctl.abort(); } catch (_) { }
                reject(new Error('timeout'));
            }, FETCH_TIMEOUT);
            var opt = { cache: 'no-store' };
            if (ctl) opt.signal = ctl.signal;
            fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now(), opt)
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (j) {
                    if (settled) return;
                    settled = true; clearTimeout(to); resolve(j);
                })
                .catch(function (e) {
                    if (settled) return;
                    settled = true; clearTimeout(to); reject(e);
                });
        });
    }
    function _fetchAll(i) {
        i = i || 0;
        if (i >= URLS.length) return Promise.reject(new Error('all sources failed'));
        return _fetchOne(URLS[i]).catch(function (e) {
            console.warn('[tasks] source ' + i + ' failed: ' + (e && e.message));
            return _fetchAll(i + 1);
        });
    }
    function _reload() {
        return _fetchAll(0).then(function (raw) {
            var clean = _sanitize(raw);
            if (!clean) throw new Error('empty payload');
            _data = clean;
            _saveCache(raw);
            _loadedOnce = true;
            _paint();
            return true;
        }).catch(function () {
            if (!_loadedOnce) { _data = _fallback(); _paint(); }
            return false;
        });
    }

    // ── 可见性：只在「空白草稿面板」出现（唯一判定）────────────────────
    function _isBlankDraft() {
        try {
            if (typeof _switching !== 'undefined' && _switching) return false;
            if (typeof cardPool !== 'undefined' && cardPool && cardPool.getActive) {
                var c = cardPool.getActive();
                if (c && c.dom && c.dom.style.display !== 'none' && c._contentWrap && c._contentWrap.childNodes.length > 0) return false;
            }
            var qid = (typeof questActiveId !== 'undefined') ? questActiveId : null;
            if (qid && typeof _isDraft === 'function') return !!_isDraft(qid);
            return !qid;
        } catch (_) { return false; }
    }

    // ── 渲染 ─────────────────────────────────────────────────────────────
    function _iconEl(name) {
        var sp = document.createElement('span');
        var known = false;
        try { known = !!(window.qqqIcons && window.qqqIcons.has && window.qqqIcons.has(name)); } catch (_) { }
        sp.className = 'qqi qqi-' + (known ? name : 'package');
        sp.className += ' tp-ico';
        return sp;
    }
    function _build() {
        var wrap = document.getElementById('messages-wrap');
        if (!wrap) return null;
        var el = document.createElement('div');
        el.id = PANE_ID;
        el.className = 'tp-wrap';
        el.style.display = 'none';
        el.innerHTML =
            '<div class="tp-inner">' +
            '  <div class="tp-head"><span class="tp-title"></span><span class="tp-sub"></span></div>' +
            '  <div class="tp-grid"></div>' +
            '</div>';
        // 点击委托（卡片全部动态重绘，恒在容器上监听一次）
        el.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('.tp-card') : null;
            if (!btn) return;
            var id = btn.getAttribute('data-id');
            var list = (_data && _data.tasks) || [];
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === id) { _say(list[i]); return; }
            }
        });
        wrap.appendChild(el);
        return el;
    }
    function _paint() {
        if (!_pane) _pane = _build();
        if (!_pane) return;
        var data = _data || _fallback();
        var q = _pane.querySelector('.tp-title');
        var s = _pane.querySelector('.tp-sub');
        if (q) q.textContent = data.title || '';
        if (s) s.textContent = data.subtitle || '';
        var grid = _pane.querySelector('.tp-grid');
        if (!grid) return;
        grid.innerHTML = '';
        for (var i = 0; i < data.tasks.length; i++) {
            (function (t) {
                var card = document.createElement('button');
                card.type = 'button';
                card.className = 'tp-card';
                card.setAttribute('data-id', t.id);
                card.appendChild(_iconEl(t.icon));
                var txt = document.createElement('span');
                txt.className = 'tp-txt';
                var tt = document.createElement('span');
                tt.className = 'tp-t';
                tt.textContent = t.title;
                txt.appendChild(tt);
                card.appendChild(txt);
                // 卡片只留标题；描述只作悬停提示，不占版面
                if (t.desc) card.title = t.desc;
                grid.appendChild(card);
            })(data.tasks[i]);
        }
    }
    function _refresh() {
        var show = _isBlankDraft();
        if (show && !_pane) { _pane = _build(); }
        if (_pane) _pane.style.display = show ? '' : 'none';
        if (show && !_data) { _data = _fallback(); _paint(); }
    }

    // ── 执行：替用户说一句话（等同打字 + Enter，唯一发送管线）────────────
    function _say(t) {
        var inp = document.getElementById('input');
        if (!inp) return;
        if (inp.value && inp.value.trim()) {
            _qoast(_t('ai.tasks.inputBusy', '编辑框里已有内容，先发送或清空再点任务'), 'warning', 5000);
            try { inp.focus(); } catch (_) { }
            return;
        }
        inp.value = t.prompt;
        try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { }
        try { if (typeof autoResizeInput === 'function') autoResizeInput(); } catch (_) { }
        var okGate = true;
        try { okGate = (typeof _gateBeforeSend === 'function') ? _gateBeforeSend() : true; } catch (_) { okGate = false; }
        if (!okGate) {                    // 闸门已给出可见反馈；提词留在编辑框里，用户处理后按 Enter 即可
            try { inp.focus(); } catch (_) { }
            return;
        }
        try { if (typeof _freezeAndSendFromInput === 'function') _freezeAndSendFromInput(); } catch (_) { }
    }

    // ── 变化侦听：卡池增删 = 空白↔有内容（唯一信号，禁散点回调）──────────
    function _watch() {
        var msgs = document.getElementById('messages');
        if (!msgs || typeof MutationObserver === 'undefined') return;
        var pend = null;
        var obs = new MutationObserver(function () {
            if (pend) return;
            pend = setTimeout(function () { pend = null; _refresh(); }, 60);
        });
        obs.observe(msgs, { childList: true });   // 只看直接子节点（card 增删），不跟楼内流式更新
    }

    function _boot2() {
        _loadCache(function (cached) {
            if (cached) {
                var c = _sanitize(cached);
                if (c) { _data = c; }
            }
            if (!_data) _data = _fallback();
            _refresh();
            _reload();                       // 后台拉服务器真理源（不阻塞首次绘制）
            _timer = setInterval(function () { _reload(); }, REFRESH_MS);
        });
        _watch();
        try {
            window.addEventListener('qqq-lang-change', function () { _paint(); });
        } catch (_) { }
    }

    window.qqqTaskPane = {
        refresh: _refresh,
        reload: _reload,
        isBlankDraft: _isBlankDraft
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _boot2);
    else _boot2();
})();
