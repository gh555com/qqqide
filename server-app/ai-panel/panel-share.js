// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ════════════════════════════════════════════════════════════════════════════
// panel-share.js —— 分享面板（唯一 UI 入口）
// ----------------------------------------------------------------------------
// 左 = 公网预览（所见即读者所见，复用面板渲染机 renderMarkdown）
// 右 = 标题 / 范围 / 可见性 / 期限 / 口令 / 脱敏 / 图片（缩略图 · 逐张可取消）
// 底 = 脱敏报告 + 费用 + 生成
// 第二页 = 我的分享（延长 / 撤销 / 删除）
// 样式全部在 index.html（禁自注入样式）；颜色只用主题变量
// ════════════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var S = window.QqqShare;
    if (!S) return;

    // 分享域根（唯一真理源）：/p = page（读者看到的那一页），服务端 sharePathPrefix 与之同值。
    // 宿主用 www：全站 canonical 空间，灰云直连 = 打开即看、撤销即死（apex 走 Worker 边缘缓存）。
    var SHARE_WEB = 'https://www.gh555.com/p/';

    function T(key, def, params) {
        try {
            if (typeof window._qq === 'function') return window._qq(key, def, params);
        } catch (_) { }
        var s = def || key;
        if (params) {
            Object.keys(params).forEach(function (k) {
                s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
            });
        }
        return s;
    }

    function host() {
        try { return window.parent; } catch (_) { return null; }
    }

    function qoast(msg, type) {
        try {
            var h = host();
            if (h && h.qqqideQoast && h.qqqideQoast.show) {
                h.qqqideQoast.show(msg, { duration: 3200, type: type || 'success' });
                return;
            }
        } catch (_) { }
        console.log('[share] ' + msg);
    }

    function copyText(txt) {
        try {
            var b = host() && host().qqqideBridge;
            if (b && b.clipboard && b.clipboard.writeText) { b.clipboard.writeText(txt); return true; }
        } catch (_) { }
        try { navigator.clipboard.writeText(txt); return true; } catch (_) { }
        return false;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function money(n) {
        var v = Math.round((parseFloat(n) || 0) * 100) / 100;
        return String(v);
    }

    // 定价的意义是「边界」不是「收入」：一份纯文本快照在存储上的真实成本约 0.0003 元/年。
    // 所以：30 天免费（成本几乎为零，换体验）/ 1 年 1 ge / 永久 2 ge（2 年即回本 →
    // 让「永久」成为默认选择 = 少一档决策）。计费维度 = 分享条数，不是楼层数、不是文件数：
    // 一次生成 = 一条快照 = 一个租约。
    var TIERS = [
        { key: 'trial', label: '30 天', fee: 0, hint: '免费' },
        { key: 'year', label: '1 年', fee: 1, hint: '1 ge' },
        { key: 'forever', label: '永久', fee: 2, hint: '2 ge' }
    ];
    var AI_SCOPES = [
        { key: 0, label: '本轮问答' },
        { key: 2, label: '最近 3 轮' },
        { key: 999, label: '整段对话' }
    ];
    var SEL_SCOPE = { key: -1, label: '仅选中内容' };
    var VIS = [
        { key: 'unlisted', label: '持链接可读', hint: '不进搜索引擎' },
        { key: 'password', label: '口令保护', hint: '需输入口令' },
        { key: 'public', label: '公开可索引', hint: '可被搜索' }
    ];

    // ─── 状态 ───
    var st = {
        src: null,        // {type:'ai', el, selText} | {type:'file', paths, selText, doc, feeGe}
        aiEl: null,
        selText: '',
        scope: 0,
        tier: 'trial',
        vis: 'unlisted',
        redact: true,
 

        title: '',
        password: '',
 		items: [],
		imgList: [],     // 当前可分享图片（S.listImages 唯一清单；缩略图与上传共用）
		drop: {},        // 逐图排除（key → 1）；默认空 = 全含
		docMeta: null,
		fileItems: [],    // 文件源的整份条目（scope 切回 0 时复原）

        loading: false,
        loadErr: '',
        busy: false
    };

    var $mask = null;
    var $dlg = null;

    function ensureDom() {
        if ($mask) return;
        $mask = document.createElement('div');
        $mask.className = 'sh-mask';
        $mask.style.display = 'none';
        $dlg = document.createElement('div');
        $dlg.className = 'sh-dlg';
        $mask.appendChild($dlg);
        document.body.appendChild($mask);
        $mask.addEventListener('mousedown', function (e) {
            if (e.target === $mask && !st.busy) close();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && $mask && $mask.style.display !== 'none' && !st.busy) close();
        });
    }

    function reset(src) {
        st.src = src || null;
        st.aiEl = (src && src.type === 'ai') ? (src.el || null) : null;
        st.selText = (src && src.selText) || '';
        st.scope = 0;
        st.tier = 'trial';
        st.vis = 'unlisted';
        st.redact = true;

 		st.password = '';
		st.busy = false;
		st.imgList = [];
		st.drop = {};
		st.docMeta = (src && src.doc) || null;

        st.items = (src && src.items && src.items.length) ? src.items : [];
        st.fileItems = st.items.slice();   // 文件源的整份内容（切回「整份」时复原）
        st.loading = !!(src && src.type === 'file' && !st.items.length);
        st.loadErr = '';
        if (!st.loading) refreshItems();
        st.title = defaultTitle();
    }

    function openAi(el, selText) {
        ensureDom();
        reset({ type: 'ai', el: el, selText: selText || '' });
        renderNew();
        $mask.style.display = 'flex';
    }

    // 文件源（Roam / 编辑器）：读盘与组包全在 share-machine 唯一处；快照里永不写本机绝对路径
    function openFiles(opt) {
        ensureDom();
        opt = opt || {};
        var paths = Array.isArray(opt.paths) ? opt.paths : [];
        if (!paths.length) { qoast(T('ai.share.noFile', '没有可分享的文件'), 'error'); return; }
        reset({ type: 'file', paths: paths, selText: String(opt.selText || ''), doc: null });
        renderNew();
        $mask.style.display = 'flex';
        S.loadFiles(paths, function (pct) {
            var go = $dlg && $dlg.querySelector('#sh-go');
            if (go) go.textContent = T('ai.share.reading', '读取中… {0}%', { 0: Math.round(pct * 100) });
        }).then(function (r) {
            st.loading = false;
            st.items = r.items;
            st.fileItems = r.items.slice();
            st.docMeta = r.doc;

            if (r.failed && r.failed.length) {
                qoast(T('ai.share.fileSkipped', '{0} 个文件读取失败，已略过', { 0: r.failed.length }), 'error');
            }
            st.title = defaultTitle();
            refreshItems();
            renderNew();
        }).catch(function (err) {
            st.loading = false;
            st.loadErr = (err && err.message) || 'failed';
            renderNew();
        });
    }

    function close() {
        if ($mask) $mask.style.display = 'none';
        st.aiEl = null;
        st.src = null;
    }

    function questTitle() {
        try {
            if (typeof _favQuestTitle === 'function' && typeof questActiveId !== 'undefined') {
                return _favQuestTitle(questActiveId) || '';
            }
        } catch (_) { }
        return '';
    }

    function stripExt(n) {
        return String(n || '').replace(/\.[^.]+$/, '');
    }

    function defaultTitle() {
        if (st.src && st.src.type === 'file') {
            if (st.docMeta && st.docMeta.name) return stripExt(st.docMeta.name);
            if (st.items.length > 1) {
                return T('ai.share.filesTitle', '{0} 等 {1} 个文件', { 0: stripExt(st.items[0].name), 1: st.items.length });
            }
            if (st.items.length === 1) return stripExt(st.items[0].name);
            return T('ai.share.fileTitle', '分享的文件');
        }
        var items = S.collect(st.aiEl, 0);
        var q = '';
        for (var i = 0; i < items.length; i++) {
            if (items[i].role === 'q') { q = items[i].md; break; }
        }
        var base = (q || questTitle() || '').replace(/\s+/g, ' ').trim();
        if (base.length > 48) base = base.slice(0, 48) + '…';
        return base || '分享的对话';
    }

    function refreshItems() {
        var isFile = !!(st.src && st.src.type === 'file');
        if (st.scope === -1) {
            // 精确截取：只带选中文本
            st.items = [{ role: 'sel', n: 1, md: st.selText }];
        } else if (isFile) {
            st.items = st.fileItems.slice();
        } else {
            st.items = S.collect(st.aiEl, st.scope);
        }
        // 图片清单只有一只真相源（提问气泡图 + md 内的本机图片 + 文件源图片）
        st.imgList = S.listImages(st.items);
        Object.keys(st.drop).forEach(function (k) {
            var still = st.imgList.some(function (x) { return x.key === k; });
            if (!still) delete st.drop[k];
        });
    }

    // 实际要上传的图片（排除用户逐张取消的）
    function pickedImages() {
        return st.imgList.filter(function (x) { return !st.drop[x.key]; });
    }

    function pickedBytes() {
        var n = 0;
        pickedImages().forEach(function (x) { n += (x.bytes || 0); });
        return n;
    }

    function previewSrcOf(ref) {
        if (!ref) return '';
        if (ref.kind === 'b64') return 'data:' + (ref.mime || 'image/png') + ';base64,' + ref.v;
        if (ref.kind === 'path') return ref.v;
        return '';   // floor（需异步解析楼层目录）→ 用占位块
    }

    function mb(n) { return (Math.round((n || 0) / 104857.6) / 10).toFixed(1); }

    // 可选范围：AI = 本轮/近三轮/整段（有选区时多一项）；文件 = 整份/仅选中（有选区时）
    function scopesFor() {
        if (!st.src) return AI_SCOPES;
        if (st.src.type === 'file') {
            if (!st.selText) return [];
            return [{ key: 0, label: T('ai.share.scopeWhole', '整份文件') }, SEL_SCOPE];
        }
        var list = AI_SCOPES.slice();
        if (st.selText) list.unshift(SEL_SCOPE);
        return list;
    }

    function tierOf(key) {
        return TIERS.filter(function (t) { return t.key === key; })[0] || TIERS[0];
    }

    // 计费维度恒为「分享条数」：一次生成 = 一条快照 = 一个租约；图片随租约，不单独收存储费
    function totalFee() {
        return (tierOf(st.tier).fee || 0);
    }

    // 估算快照原始字节（永久档 512 KB 闸门的前置提示；真实裁决在服务端）——按 UTF-8 字节，不按字符
    function roughBytes() {
        try { return S.bytesOf(JSON.stringify(st.items)); } catch (_) { return 0; }
    }

    // ─── 渲染：新建 ───
    function renderNew() {
        var tier = tierOf(st.tier);
        var scopes = scopesFor();
        if (!scopes.length) st.scope = 0;
        else if (!scopes.some(function (s) { return s.key === st.scope; })) st.scope = scopes[0].key;

        // 永久档的体积闸：客户端先亮红灯（真裁决在服务端，不靠前端把关）
        var tooBigForForever = st.tier === 'forever' && roughBytes() > 512 * 1024;

        $dlg.innerHTML =
            '<div class="sh-hd">' +
            '<div class="sh-tabs"><b class="on" data-tab="new">' + esc(T('ai.share.tabNew', '分享')) + '</b>' +
            '<b data-tab="mine">' + esc(T('ai.share.tabMine', '我的分享')) + '</b></div>' +
            '<span class="sh-x" data-act="close" title="' + esc(T('ai.share.close', '关闭')) + '">✕</span>' +
            '</div>' +
            '<div class="sh-body">' +
            '<div class="sh-left"><div class="sh-prev" id="sh-prev"></div></div>' +
            '<div class="sh-right">' +
            '<label class="sh-lb">' + esc(T('ai.share.title', '标题')) + '</label>' +
            '<input class="sh-in" id="sh-title" maxlength="120" value="' + esc(st.title) + '"/>' +

            (scopes.length
                ? '<label class="sh-lb">' + esc(T('ai.share.scope', '范围')) + '</label>' +
                '<div class="sh-seg" data-grp="scope">' + scopes.map(function (s) {
                    return '<b data-v="' + s.key + '"' + (s.key === st.scope ? ' class="on"' : '') + '>' + esc(s.label) + '</b>';
                }).join('') + '</div>'
                : '') +

            '<label class="sh-lb">' + esc(T('ai.share.vis', '可见性')) + '</label>' +
            '<div class="sh-seg col" data-grp="vis">' + VIS.map(function (v) {
                return '<b data-v="' + v.key + '"' + (v.key === st.vis ? ' class="on"' : '') + '>' +
                    esc(v.label) + '<i>' + esc(v.hint) + '</i></b>';
            }).join('') + '</div>' +
            (st.vis === 'password'
                ? '<input class="sh-in" id="sh-pw" type="password" placeholder="' + esc(T('ai.share.pwPh', '设置口令（至少 4 位）')) + '" value="' + esc(st.password) + '"/>'
                : '') +

            '<label class="sh-lb">' + esc(T('ai.share.tier', '期限')) + '</label>' +
            '<div class="sh-seg" data-grp="tier">' + TIERS.map(function (t) {
                return '<b data-v="' + t.key + '"' + (t.key === st.tier ? ' class="on"' : '') + '>' +
                    esc(t.label) + '<i>' + esc(t.hint) + '</i></b>';
            }).join('') + '</div>' +
            '<div class="sh-note">' + esc(T('ai.share.pricing', '按分享条数计费：一次生成 = 一条快照（与楼层数 / 文件数无关）；永久档仅纯文本 ≤512 KB')) + '</div>' +
            (tooBigForForever
                ? '<div class="sh-warn">' + esc(T('ai.share.foreverTooBig', '内容超过 512 KB，永久档不可用：请选 1 年档，或缩小范围')) + '</div>'
                : '') +

            '<label class="sh-chk"><input type="checkbox" id="sh-redact"' + (st.redact ? ' checked' : '') + '/>' +
            '<span>' + esc(T('ai.share.redact', '自动脱敏（本机路径 / IP / 密钥 / 令牌）')) + '</span></label>' +

            imgsBlock() +

            '<div class="sh-report" id="sh-report"></div>' +
            '</div></div>' +
            '<div class="sh-ft">' +
            '<span class="sh-cost" id="sh-cost">' + esc(costLabel(totalFee())) + '</span>' +
            '<button class="sh-btn" data-act="close">' + esc(T('ai.share.cancel', '取消')) + '</button>' +
            '<button class="sh-btn primary" data-act="go" id="sh-go"' +
            (st.loading || st.loadErr || tooBigForForever ? ' disabled' : '') + '>' +
            esc(st.loading ? T('ai.share.reading0', '读取中…') : T('ai.share.go', '生成链接')) + '</button>' +
            '</div>';

        renderPreview();
        renderReport();
        bindCommon();
    }

    function costLabel(fee) {
        if (fee <= 0) return T('ai.share.costFree', '免费 · 30 天后自动清理');
        return T('ai.share.costFee', '本次 {0} ge · 一次性，不退', { 0: money(fee) });
    }

    // 图片区（唯一形态：缩略图 + 逐张取消 + 总量闸 + 隐私常显小字）
    // 图片进「分享自有资产域」：随租约生灭（到期/撤销 = 字节真删），永不进 bed 永久存储。
    function imgsBlock() {
        if (!st.imgList.length) return '';
        var picked = pickedImages();
        var cap = (st.tier === 'trial') ? 16 : 48;
        var over = pickedBytes() > cap * 1048576;
        var h = '<label class="sh-lb">' + esc(T('ai.share.images', '图片')) + '</label>';
        h += '<div class="sh-imgs">' + st.imgList.map(function (x) {
            var off = !!st.drop[x.key];
            var src = previewSrcOf(x.ref);
            return '<div class="sh-img' + (off ? ' off' : '') + '" data-key="' + esc(x.key) + '" title="' + esc(x.name) + '">' +
                (src ? '<img src="' + esc(src) + '" alt=""/>' : '<span class="sh-img-ph">' + esc(x.name) + '</span>') +
                '<b class="sh-img-x" data-imact="drop" data-key="' + esc(x.key) + '" title="' + esc(T('ai.share.imgOff', '不分享这张')) + '">✕</b>' +
                (x.bytes ? '<i class="sh-img-sz">' + esc(mb(x.bytes) + ' MB') + '</i>' : '') +
                '</div>';
        }).join('') + '</div>';
        h += '<div class="sh-note">' + esc(T('ai.share.imgCount', '{0} 张 · {1} MB / 上限 {2} MB',
            { 0: picked.length, 1: mb(pickedBytes()), 2: cap })) + '</div>';
        if (over) h += '<div class="sh-warn">' + esc(T('ai.share.imgCap', '图片总量超过上限（{0} MB）——请减少图片，或选更长档位', { 0: cap })) + '</div>';
        // 常显、不做弹窗：粘贴的图常含个人信息，而公开链接一旦发出去就收不回
        h += '<div class="sh-note sh-priv">' + esc(T('ai.share.imgPrivacy', '图片一旦公开，即使撤销分享，也可能已被他人保存 / 缓存')) + '</div>';
        return h;
    }

    function renderPreview() {
        var box = $dlg.querySelector('#sh-prev');
        if (!box) return;
        if (st.loading) {
            box.innerHTML = '<div class="sh-empty">' + esc(T('ai.share.reading1', '正在读取文件…')) + '</div>';
            return;
        }
        if (st.loadErr) {
            box.innerHTML = '<div class="sh-warn">' + esc(st.loadErr) + '</div>';
            return;
        }
        var html = '';
        var items = st.items;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var isDoc = it.role === 'doc' || it.role === 'sel';
            var isQ = it.role === 'q';
            var label = isDoc ? (it.role === 'sel' ? T('ai.share.selLabel', '选中') : (it.name || T('ai.share.fileLabel', '文件')))
                : (isQ ? T('ai.share.q', '问') : T('ai.share.a', '答'));
            var meta = isDoc ? '' : (it.n ? '#' + it.n : '');
            var body;
            try {
                body = (typeof renderMarkdown === 'function') ? renderMarkdown(it.md) : '<pre>' + esc(it.md) + '</pre>';
            } catch (_) {
                body = '<pre>' + esc(it.md) + '</pre>';
            }
            // 图片文件源：正文尚未生成（asset:N 在上传后写入）→ 预览直接给缩略图
            if ((!it.md || !String(it.md).trim()) && it.imgs && it.imgs.length) {
                body = it.imgs.map(function (im) {
                    var s2 = previewSrcOf(im.ref);
                    return s2
                        ? '<img src="' + esc(s2) + '" alt=""/>'
                        : '<span class="sh-imgph">' + esc(im.name || 'image') + '</span>';
                }).join('');
            }
            html += '<div class="sh-it ' + (isQ ? 'q' : 'a') + (isDoc ? ' doc' : '') + '">' +
                '<div class="sh-it-hd"><b>' + esc(label) + '</b>' +
                '<span>' + esc(meta) + '</span></div>' +
                '<div class="sh-it-bd">' + body + '</div></div>';
        }
        box.innerHTML = html || '<div class="sh-empty">' + esc(T('ai.share.empty', '没有可分享的内容')) + '</div>';
        // 预览内的本机 md 图片位（![](file:///…)）先显示占位：它们会在生成时换成 asset:N
        var imgs = box.querySelectorAll('img');
        for (var k = 0; k < imgs.length; k++) {
            var src = imgs[k].getAttribute('src') || '';
            if (!/^https:/i.test(src) && !/^data:image\//i.test(src)) {
                var ph = document.createElement('span');
                ph.className = 'sh-imgph';
                ph.textContent = '（本地图片：生成时上传，预览不读本机路径）';
                imgs[k].parentNode.replaceChild(ph, imgs[k]);
            }
        }
    }

    function renderReport() {
        var box = $dlg.querySelector('#sh-report');
        if (!box) return;
        if (!st.redact) {
            box.innerHTML = '<div class="sh-warn">' + esc(T('ai.share.noRedactWarn', '未开启脱敏：回答中的本机路径与服务地址会原样公开')) + '</div>';
            return;
        }
        var counts = {};
        st.items.forEach(function (it) { S.redact(it.md || '', counts); });
        var kinds = Object.keys(counts);
        if (!kinds.length) {
            box.innerHTML = '<div class="sh-ok">' + esc(T('ai.share.clean', '未发现敏感信息')) + '</div>';
            return;
        }
        var NAMES = {
            'private-key': '私钥', 'bearer': '令牌', 'api-key': '密钥', 'secret': '口令/密钥',
            'ip': 'IP 地址', 'win-path': '本机路径', 'unix-path': '服务器路径', 'file-url': '本地文件'
        };
        box.innerHTML = '<div class="sh-hd2">' + esc(T('ai.share.redactReport', '将脱敏 {0} 处', {
            0: kinds.reduce(function (a, k) { return a + counts[k]; }, 0)
        })) + '</div><div class="sh-tags">' + kinds.map(function (k) {
            return '<span>' + esc(NAMES[k] || k) + ' ×' + counts[k] + '</span>';
        }).join('') + '</div>';
    }

    function bindCommon() {
        var tabs = $dlg.querySelectorAll('.sh-tabs b');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener('click', function (e) {
                var t = e.currentTarget.getAttribute('data-tab');
                if (t === 'mine') renderMine(); else renderNew();
            });
        }
        var acts = $dlg.querySelectorAll('[data-act]');
        for (var j = 0; j < acts.length; j++) {
            acts[j].addEventListener('click', function (e) {
                var a = e.currentTarget.getAttribute('data-act');
                if (a === 'close') close();
                else if (a === 'go') doCreate();
                else if (a === 'copy') copyText(e.currentTarget.getAttribute('data-url') || '');
                else if (a === 'open') {
                    try { host().qqqideBridge.shell.openExternal(e.currentTarget.getAttribute('data-url')); } catch (_) { }
                }
            });
        }
        var titleIn = $dlg.querySelector('#sh-title');
        if (titleIn) titleIn.addEventListener('input', function (e) { st.title = e.target.value; });
        var pwIn = $dlg.querySelector('#sh-pw');
        if (pwIn) pwIn.addEventListener('input', function (e) { st.password = e.target.value; });
        var rd = $dlg.querySelector('#sh-redact');
        if (rd) rd.addEventListener('change', function (e) {
            st.redact = !!e.target.checked;
            renderReport();
        });
        // 图片逐张取消/恢复（唯一手势：缩略图右上 ✕）
        var imBox = $dlg.querySelector('.sh-imgs');
        if (imBox) imBox.addEventListener('click', function (e) {
            var b = e.target.closest('[data-imact="drop"]');
            if (!b) return;
            var key = b.getAttribute('data-key') || '';
            if (!key) return;
            if (st.drop[key]) delete st.drop[key]; else st.drop[key] = 1;
            renderNew();
        });
        var segs = $dlg.querySelectorAll('.sh-seg');
        for (var s = 0; s < segs.length; s++) {
            segs[s].addEventListener('click', function (e) {
                var b = e.target.closest('b[data-v]');
                if (!b) return;
                var grp = e.currentTarget.getAttribute('data-grp');
                var v = b.getAttribute('data-v');
                if (grp === 'scope') {
                    st.scope = parseInt(v, 10) || 0;
                    refreshItems();
                } else if (grp === 'vis') {
                    st.vis = v;
                } else if (grp === 'tier') {
                    st.tier = v;
                }
                renderNew();
            });
        }
    }

    // ─── 创建 ───
    function doCreate() {
        if (st.busy || st.loading) return;
        if (st.loadErr) { qoast(st.loadErr, 'error'); return; }
        if (!S.token()) { qoast(T('ai.share.needLogin', '请先登录 qd 账号'), 'error'); return; }
        if (st.vis === 'password' && (st.password || '').trim().length < 4) {
            qoast(T('ai.share.pwShort', '口令至少 4 位'), 'error');
            return;
        }
        if (!st.items.length) { qoast(T('ai.share.empty', '没有可分享的内容'), 'error'); return; }

        // kind 只影响阅读页的呈现语义（问/答 或 文件）；计费维度恒为「分享条数」
        var kind = 'floor';
        if (st.src && st.src.type === 'file') kind = (st.scope === -1) ? 'selection' : 'file';
        else if (st.scope === -1) kind = 'selection';
        else if (st.scope === 999) kind = 'thread';
        // 永久档体积闸的前置提示（真裁决在服务端：FOREVER_TOO_LARGE）
        if (st.tier === 'forever' && roughBytes() > 512 * 1024) {
            qoast(T('ai.share.foreverTooBig', '内容超过 512 KB，永久档不可用：请选 1 年档，或缩小范围'), 'error');
            return;
        }

        st.busy = true;
        // 幂等键：本次「生成」的全部重试共用一一——服务端按 (doer_id, cid) 唯一，
        // 网络抽风 / 超时重试只会回到同一条分享（不重复建、不重复扣费、不多占名额）。
        var cid = S.newCid();
        var go = $dlg.querySelector('#sh-go');
        var cost = $dlg.querySelector('#sh-cost');
        if (go) { go.disabled = true; go.textContent = T('ai.share.working', '正在生成…'); }

        // 浅拷贝（图片引用是只读的；深拷贝会把 base64 整份复制一遍）
        var items = st.items.map(function (it) {
            var o = { role: it.role, n: it.n, md: it.md };
            if (it.name) o.name = it.name;
            if (it.tools) o.tools = it.tools;
            if (it.imgs) o.imgs = it.imgs;
            return o;
        });

        var quest = questTitle();
        var floors = [];
        st.items.forEach(function (it) { if (it.role === 'a' && typeof it.n === 'number') floors.push(it.n); });

        // 图片先走资产域（预占 → 直传 R2 → create 时绑定）；失败/取消的图从快照里整行剔除
        S.prepareAssets(items, {
            tier: st.tier,
            drop: st.drop,
            onProgress: function (pct) {
                if (cost) cost.textContent = T('ai.share.uploadingImg', '图片上传 {0}%', { 0: Math.round(pct * 100) });
            }
        }).then(function (prep) {
            if (prep.failed && prep.failed.length) {
                qoast(T('ai.share.imgPartial', '{0} 张图片未能随快照上传，已略过', { 0: prep.failed.length }), 'error');
            }
            if (!prep.items.length) throw new Error(T('ai.share.empty', '没有可分享的内容'));
            if (go) go.textContent = T('ai.share.working2', '正在签名…');
            var bundle = S.buildBundle({
                items: prep.items,
                title: st.title,
                quest: quest,
                redact: st.redact,
                kind: kind,
                doc: st.docMeta
            });
            return S.create({
                bundle: bundle,
                assets: prep.assets,
                cid: cid,
                title: st.title,
                kind: kind,
                tier: st.tier,
                visibility: st.vis,
                password: st.password,
                quest: quest,
                floors: floors
            }).then(function (res) {
                try { res._images = prep.count || 0; } catch (_) { }
                return res;
            });
        }).then(function (res) {
            st.busy = false;
            renderDone(res);
        }).catch(function (err) {
            // 网络层失败 / 5xx / 超时不等于「没建成」——服务端可能已落库（历史实锤）。
            // 此时不谎报失败，而是对账：找到就把链接交给用户，找不到才敢说失败。
            var unsure = !err || err.transient || err.status === 0 || (err.status >= 500 && err.status <= 599);
            if (!unsure) { failOut(err); return; }
            if (go) go.textContent = T('ai.share.checking', '正在核对…');
            reconcileCreate(cid).then(function (row) {
                st.busy = false;
                if (!row) { failOut(err); return; }
                renderDone({
                    id: row.id,
                    url: row.url || (SHARE_WEB + row.id),
                    tier: row.tier,
                    expires_at: row.expires_at,
                    bytes: row.bytes,
                    sha256: row.sha256 || '',
                    redactions: [],
                    warnings: []
                }, T('ai.share.reconciled', '首次请求未回执，但服务端已生成——链接已在下方（未重复创建）'));
            });
        });
    }

    // 失败终态上报（只有拿到服务端明确驳回，或对账也找不到时才走这里）
    function failOut(err) {
        st.busy = false;
        var go = $dlg && $dlg.querySelector('#sh-go');
        var cost = $dlg && $dlg.querySelector('#sh-cost');
        if (go) { go.disabled = false; go.textContent = T('ai.share.go', '生成链接'); }
        if (cost) cost.textContent = costLabel(0);
        var msg = (err && err.message) || 'failed';
        if (err && err.status === 402) msg = T('ai.share.noBalance', '余额不足，需要 {0} ge', { 0: (err.payload && err.payload.needed_ge) || '?' });
        else if (err && err.status === 429) msg = T('ai.share.quota', '名额已满或今日新建过多，请稍后再试或延长已有分享');
        else if (err && err.payload && err.payload.code === 'FOREVER_TOO_LARGE') {
            msg = T('ai.share.foreverTooBig', '内容超过 512 KB，永久档不可用：请选 1 年档，或缩小范围');
        } else if (err && err.payload && err.payload.code === 'BYTES_QUOTA') {
            msg = T('ai.share.bytesQuota', '在架体积已满（上限 {0} MB）：请撤销旧分享，或选更长档位',
                { 0: Math.round(((err.payload.max_bytes || 0) / 1048576)) });
        } else if (err && err.payload && err.payload.code === 'ASSET_QUOTA') {
            msg = T('ai.share.imgCap', '图片总量超过上限（{0} MB）——请减少图片，或选更长档位',
                { 0: Math.round(((err.payload.max_bytes || 0) / 1048576)) });
        } else if (err && err.payload && /^ASSET_/.test(String(err.payload.code || ''))) {
            msg = T('ai.share.imgFail', '图片上传未完成，请重试');
        }
        qoast(T('ai.share.fail', '分享失败：{0}', { 0: msg }), 'error');
    }

    // 对账唯一机：先按 cid 精确匹配（同一次生成），再按「同标题 + 15 分钟内」兑底。
    // 两条都是「只读」——绝不因对账再发起一次创建。
    function reconcileCreate(cid) {
        return S.mine().then(function (res) {
            var list = (res && res.list) || [];
            for (var i = 0; i < list.length; i++) {
                if (cid && list[i] && list[i].cid && list[i].cid === cid) return list[i];
            }
            var now = Date.now();
            for (var j = 0; j < list.length; j++) {
                var it = list[j];
                if (!it || it.revoked) continue;
                if (String(it.title || '') !== String(st.title || '')) continue;
                var t = Date.parse(it.created_at || '');
                if (t && now - t < 15 * 60 * 1000) return it;
            }
            return null;
        }).catch(function () { return null; });
    }

    function renderDone(res, note) {
        var url = res.url || (SHARE_WEB + res.id);
        var reds = (res.redactions || []).filter(function (r) { return r && r.n; });
        $dlg.innerHTML =
            '<div class="sh-hd"><div class="sh-tabs"><b class="on">' + esc(T('ai.share.done', '链接已生成')) + '</b></div>' +
            '<span class="sh-x" data-act="close">✕</span></div>' +
            '<div class="sh-body one">' +
            '<div class="sh-done">' +
            '<div class="sh-url">' + esc(url) + '</div>' +
            '<div class="sh-meta">' +
            '<span>' + esc(res.tier === 'forever' ? T('ai.share.forever', '永久有效') : T('ai.share.expires', '到期 {0}', { 0: (res.expires_at || '').slice(0, 10) })) + '</span>' +
            '<span>' + esc(T('ai.share.visLabel', '可见性')) + '：' + esc(st.vis) + '</span>' +
            '<span>' + esc(T('ai.share.sizeLabel', '快照')) + '：' + esc(Math.max(1, Math.round((res.bytes || 0) / 1024)) + ' KB') + '</span>' +
            (res._images ? '<span>' + esc(T('ai.share.imgN', '含图片 {0} 张', { 0: res._images })) + '</span>' : '') +
            '</div>' +
            (note ? '<div class="sh-ok">' + esc(note) + '</div>' : '') +
            (reds.length ? '<div class="sh-report"><div class="sh-hd2">' + esc(T('ai.share.redacted', '已脱敏（客户端 + 服务端）')) + '</div><div class="sh-tags">' +
                reds.map(function (r) { return '<span>' + esc(r.kind) + ' ×' + r.n + '</span>'; }).join('') + '</div></div>' : '') +
            (res.warnings && res.warnings.length ? '<div class="sh-warn">' + esc(T('ai.share.pathWarn', '快照中仍含本机路径（服务端未改写）')) + '</div>' : '') +
            '<div class="sh-sha">sha256 <code>' + esc((res.sha256 || '').slice(0, 32)) + '…</code></div>' +
            '</div></div>' +
            '<div class="sh-ft">' +
            '<span class="sh-cost"></span>' +
            '<button class="sh-btn" data-act="open" data-url="' + esc(url) + '">' + esc(T('ai.share.open', '在浏览器打开')) + '</button>' +
            '<button class="sh-btn primary" data-act="copy" data-url="' + esc(url) + '">' + esc(T('ai.share.copy', '复制链接')) + '</button>' +
            '</div>';
        bindCommon();
        copyText(url);
        qoast(T('ai.share.copied', '链接已复制'), 'success');
    }

    // ─── 我的分享 ───
    function renderMine() {
        $dlg.innerHTML =
            '<div class="sh-hd"><div class="sh-tabs"><b data-tab="new">' + esc(T('ai.share.tabNew', '分享')) + '</b>' +
            '<b class="on" data-tab="mine">' + esc(T('ai.share.tabMine', '我的分享')) + '</b></div>' +
            '<span class="sh-x" data-act="close">✕</span></div>' +
            '<div class="sh-body one"><div class="sh-list" id="sh-list">' +
            '<div class="sh-empty">' + esc(T('ai.share.loading', '加载中…')) + '</div></div></div>' +
            '<div class="sh-ft"><span class="sh-cost"></span><button class="sh-btn" data-act="close">' +
            esc(T('ai.share.close', '关闭')) + '</button></div>';
        bindCommon();

        S.mine().then(function (res) {
            var list = (res && res.list) || [];
            var box = $dlg.querySelector('#sh-list');
            if (!box) return;
            if (!list.length) {
                box.innerHTML = '<div class="sh-empty">' + esc(T('ai.share.none', '还没有分享过')) + '</div>';
                return;
            }
            box.innerHTML = list.map(function (it) {
                var dead = it.revoked || it.expired;
                // 免费档不可续（否则=永久免费在架）；永久档无需续——只在付费且有期限时亮续期钮
                var canExtend = !dead && it.tier !== 'trial' && it.tier !== 'forever';
                return '<div class="sh-row' + (dead ? ' dead' : '') + '" data-id="' + esc(it.id) + '">' +
                    '<div class="sh-row-main">' +
                    '<div class="sh-row-t">' + esc(it.title || '(无标题)') + '</div>' +
                    '<div class="sh-row-m">' +
                    '<span>' + esc((it.created_at || '').slice(0, 10)) + '</span>' +
                    '<span>' + esc(it.revoked ? T('ai.share.revoked', '已撤销') : (it.expired ? T('ai.share.expired', '已到期') : T('ai.share.expires', '到期 {0}', { 0: (it.expires_at || '').slice(0, 10) }))) + '</span>' +
                    '<span>' + esc(T('ai.share.viewsShort', '{0} 次阅读', { 0: it.views || 0 })) + '</span>' +
                    '</div></div>' +
                    '<div class="sh-row-act">' +
                    '<b data-rowact="copy">' + esc(T('ai.share.copy', '复制链接')) + '</b>' +
                    (canExtend ? '<b data-rowact="extend">' + esc(T('ai.share.extend', '续期 1 年（1 ge）')) + '</b>' : '') +
                    (it.revoked ? '' : '<b data-rowact="revoke" class="danger">' + esc(T('ai.share.revoke', '撤销')) + '</b>') +
                    '<b data-rowact="remove" class="danger">' + esc(T('ai.share.remove', '删除')) + '</b>' +
                    '</div></div>';
            }).join('');
            box.addEventListener('click', function (e) {
                var b = e.target.closest('b[data-rowact]');
                if (!b) return;
                var row = b.closest('.sh-row');
                if (!row) return;
                var id = row.getAttribute('data-id');
                var act = b.getAttribute('data-rowact');
                if (act === 'copy') { copyText(SHARE_WEB + id); qoast(T('ai.share.copied', '链接已复制'), 'success'); }
                else if (act === 'extend') {
                    S.extend(id, 'year').then(function () { qoast(T('ai.share.extended', '已续期'), 'success'); renderMine(); })
                        .catch(function (err) { qoast(T('ai.share.fail', '操作失败：{0}', { 0: (err && err.message) || '' }), 'error'); });
                } else if (act === 'revoke') {
                    S.revoke(id).then(function () { qoast(T('ai.share.revoked2', '已撤销'), 'success'); renderMine(); })
                        .catch(function (err) { qoast(T('ai.share.fail', '操作失败：{0}', { 0: (err && err.message) || '' }), 'error'); });
                } else if (act === 'remove') {
                    S.remove(id).then(function () { qoast(T('ai.share.removed', '已删除'), 'success'); renderMine(); })
                        .catch(function (err) { qoast(T('ai.share.fail', '操作失败：{0}', { 0: (err && err.message) || '' }), 'error'); });
                }
            });
        }).catch(function (err) {
            var box = $dlg.querySelector('#sh-list');
            if (box) box.innerHTML = '<div class="sh-warn">' + esc((err && err.message) || 'failed') + '</div>';
        });
    }

    // ─── 一键继问（深链 qqqide://share/{id} 落地）───────────────────────
    var IMPORT_CAP = 60000;

    function claimShare(mid) {
        try {
            var H = window.parent;
            H.__qqqShareDone = H.__qqqShareDone || {};
            if (H.__qqqShareDone[mid]) return !!document.hasFocus();
            H.__qqqShareDone[mid] = Date.now();
            return true;
        } catch (_) { return true; }
    }

    function importShare(mid) {
        if (!mid) return;
 		fetch(SHARE_WEB + encodeURIComponent(mid) + '.json', {
            credentials: 'omit', mode: 'cors'
 		}).then(function (r) {
			if (r.status === 403) throw new Error(T('ai.share.importPw', '该分享受口令保护，请先在浏览器里用口令打开'));
			if (r.status === 410) throw new Error(T('ai.share.importGone', '该分享已到期或被撤销'));
			if (!r.ok) throw new Error('HTTP ' + r.status);
			return r.json();
	        }).then(function (b) {
			var items = (b && b.items) || [];
            var assetBase = SHARE_WEB + encodeURIComponent(mid) + '/a/';
            var parts = [];
            var used = 0;
            for (var i = 0; i < items.length; i++) {
                var it = items[i] || {};
                var md = String(it.md || '').trim();
                if (!md) continue;
                // 快照里图片是 asset:N（与 id 解耦）→ 导入时按本条分享的 id 展开为公网地址
                md = md.replace(/\]\(\s*asset:(\d{1,3})\s*\)/g, '](' + assetBase + '$1)');
                var seg = (String(it.role).toLowerCase() === 'q' ? '问：' : '答：') + md;
                if (used + seg.length > IMPORT_CAP) {
                    parts.push('（后续内容因长度限制已省略——原始快照：' + SHARE_WEB + mid + '）');
                    break;
                }
                parts.push(seg);
                used += seg.length;
            }
            var text = '以下是一份分享的对话快照（原始链接 ' + SHARE_WEB + mid +
                '），请把它当作背景资料，继续我的提问：\n\n' + parts.join('\n\n') + '\n\n我的问题：';
            try {
                if (typeof $input !== 'undefined' && $input) {
                    var cur = $input.value || '';
                    $input.value = cur.trim() ? (cur.replace(/\s*$/, '') + '\n\n' + text) : text;
                    if (typeof autoResizeInput === 'function') autoResizeInput();
                    $input.focus();
                    try { $input.setSelectionRange($input.value.length, $input.value.length); } catch (_) { }
                }
            } catch (_) { }
            qoast(T('ai.share.imported', '已导入分享快照，可直接追问'), 'success');
        }).catch(function (err) {
            qoast(T('ai.share.importFail', '导入失败：{0}', { 0: (err && err.message) || '' }), 'error');
        });
    }

    try {
        var H = window.parent;
        if (H && H.qqqideBridge && H.qqqideBridge.sync && H.qqqideBridge.sync.on) {
            H.qqqideBridge.sync.on('share-open', function (data) {
                var mid = data && data.id ? String(data.id) : '';
                if (!mid) return;
                if (!claimShare(mid)) return;
                importShare(mid);
            });
        }
    } catch (_) { }

    // ─── 对外导出（唯一入口：AI 楼层 / 编辑器 / Roam 三个触发面共用同一台面板）───
    window.shareOpen = function (el, selText) { openAi(el, selText); };
    // 文件源：{ paths: [绝对路径...], selText?: '编辑器选区' }——读盘/组包在 share-machine 唯一处
    window.shareOpenFiles = function (opt) { openFiles(opt); };
    window.shareImport = importShare;
    window.shareOpenMine = function () {
        ensureDom();
        renderMine();
        $mask.style.display = 'flex';
    };
})();
