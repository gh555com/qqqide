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
//   · 面板只有标题（一行），没有副标题、没有描述行——信息越少越快做决定
//   · 卡片悬停说明 = 这句提词本身（sanitize 里 desc := prompt；服务端 desc 字段一律不采纳 →
//     「说明」永远就是将要发出去的那句话，不可能与消息不一致）
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
    var FETCH_TIMEOUT = 6000;              // 单源上限
    var HEDGE_MS = 900;                    // 高优先级源 900ms 未答 → 并行拉起下一源（优先级仍是仲裁者）
    var BUDGET_MS = 9000;                  // 整链上限（最坏 9s 收工，不再 4×6s 串成 24s）
    var REFRESH_MS = 30 * 60 * 1000;       // 30min 静默刷新（与通知机同节奏）
    var MAX_CARDS = 8;
    var CACHE_KEY = 'tasks';               // qgs ns = qqq.tasks
    var PANE_ID = 'task-pane';
    // 条件卡（when）本地判定：只认白名单条件，未知条件恒 true（老客户端/新条件不互噬）
    var WHEN_TTL = 5 * 60 * 1000;          // 判定结果缓存 5min（进空白面板不反复读盘）

    // ★ 出厂兜底（运维台 gaea/cf/qqqide/默认任务.py 的 DEFAULT_TASKS 双写同步点）
    //   提词一律「用户口吻一句话」——它就是楼层里用户气泡的原文。
    var TASK_FALLBACK = {
        title: { zh: '一键任务', en: 'Quick tasks' },
        tasks: [
            {
                id: 'clean-c', icon: 'trash', platforms: ['win'],
                title: { zh: '清理 C 盘', en: 'Clean C drive' },
                prompt: '帮我清一清 C 盘，顺便看看电脑里有没有类似 360 那种流氓软件（全家桶），能清的先列个清单给我看，我同意了再清。'
            },
            {
                id: 'autostart-qd', icon: 'clock', platforms: ['win'],
                title: { zh: 'qd 开机自启', en: 'Start qd on boot' },
                prompt: '把 qd 设成开机自启，以后开机就自动打开。'
            },
            {
                // 全局接管的唯一主入口（发现层）：点一下 = 发一句话 = 把文档地基交给 qd 管。
                // 已经开了 → 整张卡不出现（when 由客户端本地判定，见 _ensureWhen），不当广告。
                // ★ 接上 = 写 global.txt 契约段 + 开开关：AI 先 action=ask 把那句固定话术原样问一遍，
                //   用户回「1」才动手；不是 1 的一切回复 = 什么都不做（暗号只有一种，不分语言）。
                id: 'eflow-adopt', icon: 'compass', platforms: ['win', 'mac', 'linux'], when: ['eflow.off'],
                title: { zh: 'E-Flow', en: 'E-Flow' },
                // 提词就是暗号本身（完整一句，不解释）：AI 收到这句才会走「全局接管」两段式确认。
                prompt: '一切项目接入 E-Flow'
            },
            {
                id: 'install-everything', icon: 'search', platforms: ['win'],
                title: { zh: '装 Everything', en: 'Install Everything' },
                prompt: '帮我装个 Everything 文件搜索工具，装好以后在桌面放个快捷方式。'
            },
            {
                id: 'startup-clean', icon: 'snow', platforms: ['win', 'mac', 'linux'],
                title: { zh: '电脑卡顿？', en: 'Slow PC?' },
                prompt: '我的电脑有点卡，帮我看看开机自启里有什么能关的，先列清单，我同意了再关。'
            },
            {
                // macOS 没有 Everything，等价物是系统自带 Spotlight 索引（要的是把索引弄好，不是「随便找个文件」）
                id: 'spotlight-search', icon: 'search', platforms: ['mac'],
                title: { zh: 'Spotlight 搜索', en: 'Spotlight search' },
                prompt: '帮我检查这台 Mac 的 Spotlight 索引正不正常（mdfind 能不能立刻搜到文件），不正常就修好；修完用一个真实的搜索演示给我看。'
            },
            {
                // Linux 没有 Everything，等价物是 locate（plocate/mlocate）索引
                id: 'locate-search', icon: 'search', platforms: ['linux'],
                title: { zh: 'locate 文件搜索', en: 'locate search' },
                prompt: '帮我在这台 Linux 上装好 locate（优先 plocate）并建好索引，需要管理员权限的命令你告诉我，我自己执行；装完用一个真实的搜索演示给我看。'
            }
        ]
    };

    // ★ 卡片标题的多语言键（静态字面量——禁动态拼 'ai.tasks.'+id，键名必须可 grep）：
    //   只覆盖「内置卡」；运维台新增的自定义卡永远显示服务器下发的原文（下发即生效）。
    var CARD_TITLE_KEYS = {
        'clean-c': 'ai.tasks.cardCleanC',
        'autostart-qd': 'ai.tasks.cardAutostartQd',
        'install-everything': 'ai.tasks.cardEverything',
        'startup-clean': 'ai.tasks.cardStartupClean',
        'spotlight-search': 'ai.tasks.cardSpotlight',
        'locate-search': 'ai.tasks.cardLocate'
    };
    // ★ 卡片提词的多语言键（静态字面量，同标题一套口径）：
    //   提词 = 用户气泡原文，人看到的是「自己说的话」——非中文用户看到中文气泡 = 谎报他说过什么，
    //   所以出厂提词跟着界面语言走；服务端改过的一律原文（见下方基线判定）。
    //   ★ 唯一例外：eflow-adopt 不上表 —— 那是接管暗号（一句中文 + 回复「1」才生效），
    //     整套契约（确认话术 + 令牌）都是中文锁定的，半译只会更怪。
    var CARD_PROMPT_KEYS = {
        'clean-c': 'ai.tasks.promptCleanC',
        'autostart-qd': 'ai.tasks.promptAutostartQd',
        'install-everything': 'ai.tasks.promptEverything',
        'startup-clean': 'ai.tasks.promptStartupClean',
        'spotlight-search': 'ai.tasks.promptSpotlight',
        'locate-search': 'ai.tasks.promptLocate'
    };
    // 出厂中文标题基线（判定「服务器有没有改过这张卡」的唯一依据）：
    //   文案 == 出厂值 → 用本机语言译文；被运营改过 → 一律照服务器原文（禁译文盖掉下发）。
    var CARD_DEFAULT_TITLE = {};
    var CARD_DEFAULT_PROMPT = {};
    (function () {
        for (var _i = 0; _i < TASK_FALLBACK.tasks.length; _i++) {
            var _t0 = TASK_FALLBACK.tasks[_i];
            if (!_t0 || !_t0.id) continue;
            if (_t0.title && _t0.title.zh) CARD_DEFAULT_TITLE[_t0.id] = _t0.title.zh;
            if (_t0.prompt) CARD_DEFAULT_PROMPT[_t0.id] = _t0.prompt;
        }
    })();

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
    function _saveCache(raw, at) {
        var h = _handle();
        if (!h) return;
        try { h.set(CACHE_KEY, { at: at || Date.now(), raw: raw }); } catch (_) { }
    }
    // 缓存信封 {at, raw}；旧格式（裸表，无 at）→ at=0 = 当作过期（下次启动立刻拉网络）
    function _unwrapCache(c) {
        if (!c || typeof c !== 'object') return null;
        if (c.raw && typeof c.raw === 'object') return { at: Number(c.at) || 0, raw: c.raw };
        return { at: 0, raw: c };
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
            if (title && CARD_TITLE_KEYS[id] && CARD_DEFAULT_TITLE[id] && title === CARD_DEFAULT_TITLE[id]) {
                title = _t(CARD_TITLE_KEYS[id], title);   // 内置卡 = 出厂文案 → 吃译文（zh 时与原句相同）
            }
            if (!title) continue;
            // 旧版卡（kind=action / 无 prompt）一律丢弃：本面板只负责「说一句话」，
            // 干活由对话里的 AI 决定（老客户端读旧表照旧，契约只增不改）
            if (!t.prompt || typeof t.prompt !== 'string') continue;
            // 条件卡（可选）：服务器只给条件名，判定在客户端本地（见 _ensureWhen）
            var when = [];
            if (t.when) {
                var ws = Array.isArray(t.when) ? t.when : [t.when];
                for (var wi = 0; wi < ws.length; wi++) {
                    if (typeof ws[wi] === 'string' && ws[wi]) when.push(ws[wi]);
                }
            }
            // 提词同理：出厂原句 → 吃译文；服务器改过 → 原样发出去（下发永远赢过翻译）
            var prompt = t.prompt;
            if (CARD_PROMPT_KEYS[id] && CARD_DEFAULT_PROMPT[id] && prompt === CARD_DEFAULT_PROMPT[id]) {
                prompt = _t(CARD_PROMPT_KEYS[id], prompt);
            }
            seen[id] = 1;
            out.push({
                id: id,
                title: title,
                desc: prompt,          // 说明 := 将要发出去的那句话（唯一来源；服务端 desc 不采纳）
                icon: String(t.icon || ''),
                prompt: prompt,
                when: when
            });
        }
        if (!out.length) return null;
        // 副标题旧字段一律不采纳（面板只有一行标题）
        var paneTitle = _pick(raw.title);
        if (!paneTitle || paneTitle === TASK_FALLBACK.title.zh) paneTitle = _t('ai.tasks.title', TASK_FALLBACK.title.zh);
        return { title: paneTitle, tasks: out };
    }
    function _fallback() {
        var f = _sanitize(TASK_FALLBACK);
        return f || { title: _t('ai.tasks.title', TASK_FALLBACK.title.zh), tasks: [] };
    }

    // ── 拉取（优先级 + 对冲，失败静默）────────────────────────────────────
    //   老实现逐级串行：慢网时最坏 4×6s = 24s 才到底（三个面板各自跑，日志成堆、卡表迟迟不出）。
    //   现实现：按优先级错峰 900ms 并行拉起，先到先上屏；主源在预算内回来则覆盖（优先级仍是仲裁者）。
    function _fetchOne(url, ctl) {
        return new Promise(function (resolve, reject) {
            var settled = false;
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
    // 返回 Promise<boolean>；任何情况都不 reject（失败 = 沿用屏上数据 / 出厂兜底）
    function _fetch() {
        return new Promise(function (resolve) {
            var best = -1, open = 0, finished = false;
            var timers = [], ctls = [];

            function stop() {
                finished = true;
                for (var i = 0; i < timers.length; i++) { try { clearTimeout(timers[i]); } catch (_) { } }
                for (var j = 0; j < ctls.length; j++) { try { ctls[j].abort(); } catch (_) { } }
            }
            function fin(ok) { if (finished) return; stop(); resolve(!!ok); }
            function settle() { if (--open <= 0) fin(best >= 0); }

            timers.push(setTimeout(function () { fin(best >= 0); }, BUDGET_MS));   // 整链封顶
            URLS.forEach(function (url, i) {
                timers.push(setTimeout(function () {
                    if (finished) return;
                    open++;
                    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
                    if (ctl) ctls.push(ctl);
                    _fetchOne(url, ctl).then(function (raw) {
                        if (finished) return;
                        var clean = null;
                        try { clean = _sanitize(raw); } catch (_) { clean = null; }
                        if (!clean) {
                            console.warn('[tasks] source ' + i + ' 空表/坏表');
                        } else if (best < 0 || i < best) {
                            best = i;
                            _data = clean;
                            _saveCache(raw, Date.now());
                            _loadedOnce = true;
                            _paint();
                            if (i === 0) { fin(true); return; }    // 主源到手 = 收工
                        }
                        settle();
                    }, function (e) {
                        if (finished) return;
                        console.warn('[tasks] source ' + i + ' failed: ' + (e && e.message));
                        settle();
                    });
                }, i * HEDGE_MS));
            });
        });
    }
    var _inflight = null;
    function _reload() {
        if (_inflight) return _inflight;          // 单飞：定时器与手动 reload 不叠链
        _inflight = _fetch().then(function (ok) {
            if (!ok && !_loadedOnce) { _data = _fallback(); _paint(); }
            _inflight = null;
            return !!ok;
        });
        return _inflight;
    }

    // ── 条件卡：本地判定「这张卡现在值得出现吗」──────────────────────────
    // 只认白名单条件（未知条件 = 恒 true，新条件不会把老客户端卡全灭）：
    //   eflow.off — 全局接管还没开（开了这张卡就不出现：它只是一次性开关）
    // 失败一律 fail-open（显示）：卡片本身零副作用，点了 AI 也会先看状态再动手。
    var _whenState = null;          // { root, at, map }
    var _whenBusy = false;
    function _whenHit(t) {
        if (!t.when || !t.when.length) return true;
        if (!_whenState) return false;    // 未判定：先不画（避免“出现再消失”的闪动）
        var map = _whenState.map || {};
        for (var i = 0; i < t.when.length; i++) {
            if (map[t.when[i]] === false) return false;
        }
        return true;
    }
    function _visibleTasks() {
        var list = (_data && _data.tasks) || [];
        var out = [];
        for (var i = 0; i < list.length; i++) { if (_whenHit(list[i])) out.push(list[i]); }
        return out;
    }
    function _needWhen() {
        var list = (_data && _data.tasks) || [];
        for (var i = 0; i < list.length; i++) { if (list[i].when && list[i].when.length) return true; }
        return false;
    }
    function _ensureWhen() {
        if (!_needWhen()) return;
        var root = '';
        try { if (typeof questStore !== 'undefined' && questStore.getProjectRoot) root = String(questStore.getProjectRoot() || '').replace(/\\/g, '/'); } catch (_) { root = ''; }
        if (_whenState && _whenState.root === root && (Date.now() - _whenState.at) < WHEN_TTL) return;
        if (_whenBusy) return;
        var ef = (typeof ExpertFlow !== 'undefined' && ExpertFlow && ExpertFlow.globalOn) ? ExpertFlow : null;
        if (!root || !ef) {
            _whenState = { root: root, at: Date.now(), map: { 'eflow.off': true } };   // fail-open（显示）
            _paint();
            return;
        }
        _whenBusy = true;
        (async function () {
            var map = { 'eflow.off': true };
            try {
                map['eflow.off'] = !(await ef.globalOn());     // 全局接管已开 → 这张卡不出现
            } catch (_) {
                map['eflow.off'] = true;                       // fail-open
            }
            _whenState = { root: root, at: Date.now(), map: map };
            _whenBusy = false;
            _paint();
        })();
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
            '  <div class="tp-head"><span class="tp-title"></span></div>' +
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
        if (q) q.textContent = data.title || '';
        var grid = _pane.querySelector('.tp-grid');
        if (!grid) return;
        grid.innerHTML = '';
        var shown = _visibleTasks();
        if (!shown.length) { _pane.style.display = 'none'; return; }   // 全被条件过滤 = 回到纯空白（不留空标题）
        for (var i = 0; i < shown.length; i++) {
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
                // 卡片只留标题；悬停说明 = 将要发出去的那句话（不占版面）
                if (t.prompt) card.title = t.prompt;
                grid.appendChild(card);
            })(shown[i]);
        }
    }
    function _refresh() {
        var show = _isBlankDraft();
        if (show && !_pane) { _pane = _build(); }
        var was = _pane ? (_pane.style.display !== 'none') : false;
        if (_pane) _pane.style.display = show ? '' : 'none';
        if (show && !_data) { _data = _fallback(); _paint(); }
        // 只在「从无到有」时重绘（空白↔有内容的变化由 MutationObserver 驱动，不是每次都要重排）
        else if (show && !was) { _paint(); }
        if (show) { _ensureWhen(); }
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
            var wrap = _unwrapCache(cached);
            var c = wrap ? _sanitize(wrap.raw) : null;
            if (c) { _data = c; }
            if (!_data) _data = _fallback();
            _refresh();
            // 缓存够新 → 启动不打网络（三个面板 × 四线路的启动洪峰归零）；首次刷新排在缓存到期点，
            // 服务端改表的可见延迟恒 ≤ REFRESH_MS（与「30 分钟内静默刷新」的对外口径一致）
            var age = c ? (Date.now() - wrap.at) : REFRESH_MS;
            function loop() { _reload(); _timer = setTimeout(loop, REFRESH_MS); }
            if (age >= REFRESH_MS) loop();
            else _timer = setTimeout(loop, Math.max(5000, REFRESH_MS - age));
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
