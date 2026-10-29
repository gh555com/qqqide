// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ════════════════════════════════════════════════════════════════════════════
// share-machine.js —— 分享唯一机器（组包 / 脱敏 / 资产上传 / 三本账）
// ----------------------------------------------------------------------------
// 铁律：
//   · 快照自治：内容全进 bundle，源 quest 删除不影响阅读
//   · 不裁剪只折叠：默认收录整轮问答原文，读者可展开全部
//   · 脱敏即分享：默认开；本机路径 / IP / 密钥 / 令牌 一律替换为占位符
//   · 图片是「字节」不是「内容」→ 走分享自有资产域（sa/{uid}，随租约真删），
//     绝不上 bed（bed = 永久公开 CDN，租约到期后图片仍可访问 = 出城）
//   · 快照里只写 asset:N（与分享 id 解耦）：人投影由阅读器展开、.md 投影由服务端展开
//   · 图片采集双源（唯一清单 listImages）：① 条目 markdown 里的本机图片位 ② 回答正文 DOM 里
//     真正渲染出来的 <img>（工具卡/历史楼/无 _rawMarkdown 的楼层只有 DOM 有图）——同一张图按键归一去重
//   · 分享 ≠ 发布：默认不进搜索引擎，只有「公开可索引」档例外
// ════════════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ★ 写请求恒走 www（灰云直连），禁走 apex：apex = 橙云 + 边缘 Worker，写路径有 15s 硬上限，
    //   超时即回 503 "Origin unavailable"，而源站早已把分享建成 —— 前端假失败 + 真落库（已实锤）。
    //   www 直连源站无边缘超时；与既有登录 / goods / 推广写请求同一宿主（唯一口径）。
    var API = 'https://www.gh555.com/api';
    var BUNDLE_V = 1;
    var RENDERER = 's3'; // s3 = role=doc/sel + asset:N 图片引用
    var MAX_ITEMS = 200;
    var MAX_FILE_BYTES = 700000; // 快照解压上限 1 MiB（字节，非字符：中文 1 字 = 3 字节）；留出 JSON 包装余量

    // 资产上限（与服务端同值；客户端只做「上传前早提示」，裁决永远在服务端）
    var ASSET_MAX_EACH = 16 * 1024 * 1024;
    var ASSET_MAX_COUNT = 20;
    var ASSET_CAP_TRIAL = 16 * 1024 * 1024;
    var ASSET_CAP_PAID = 48 * 1024 * 1024;

    // UTF-8 字节数（快照上限按字节算，禁按字符估）
    function bytesOf(s) {
        try {
            if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
        } catch (_) { }
        return String(s == null ? '' : s).length;
    }

    function _qq(key, def, params) {
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

    function token() {
        try {
            if (window.parent && window.parent.qqqLogin && window.parent.qqqLogin.getAuthToken) {
                return window.parent.qqqLogin.getAuthToken() || '';
            }
        } catch (_) { }
        try {
            if (window.qqqLogin && window.qqqLogin.getAuthToken) return window.qqqLogin.getAuthToken() || '';
        } catch (_) { }
        return '';
    }

    function bridge() {
        try { return window.parent.qqqideBridge || null; } catch (_) { return null; }
    }

    // 网络层失败与「服务端明确驳回」必须分开：前者服务端可能已经成功（幂等重试可裁决），
    // 后者是终态（402/429/413…重试只会更糟）。所以统一标 transient。
    function api(path, opts) {
        opts = opts || {};
        var tk = token();
        if (!tk) return Promise.reject(new Error(_qq('ai.share.needLogin', '请先登录 qd 账号')));
        var headers = opts.headers || {};
        headers['Authorization'] = 'Bearer ' + tk;
        if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        var init = { method: opts.method || 'GET', headers: headers, body: opts.body };
        var ctrl = null, timer = null;
        if (opts.timeoutMs && typeof AbortController === 'function') {
            try {
                ctrl = new AbortController();
                init.signal = ctrl.signal;
                timer = setTimeout(function () { try { ctrl.abort(); } catch (_) { } }, opts.timeoutMs);
            } catch (_) { ctrl = null; }
        }
        function stop() { if (timer) { clearTimeout(timer); timer = null; } }
        return fetch(API + path, init).then(function (r) {
            return r.text().then(function (t) { stop(); return { r: r, t: t }; });
        }).then(function (x) {
            var j = null;
            try { j = x.t ? JSON.parse(x.t) : null; } catch (_) { }
            if (!x.r.ok || !j || j.ok === false) {
                var e = new Error((j && (j.error || j.code)) || ('HTTP ' + x.r.status));
                e.status = x.r.status;
                e.payload = j;
                throw e;
            }
            return j;
        }).catch(function (err) {
            stop();
            if (!err || err.status === undefined) {
                var e2 = new Error(ctrl && ctrl.signal && ctrl.signal.aborted
                    ? _qq('ai.share.timeout', '请求超时')
                    : ((err && err.message) || 'network'));
                e2.status = 0;
                e2.transient = true;
                throw e2;
            }
            throw err;
        });
    }

    // 幂等键：一次「生成」= 一个 cid；该次的全部重试共用同一个 cid。
    // 服务端按 (doer_id, cid) 唯一 → 重复请求返回同一条分享（既不重复建、也不重复扣费）。
    function newCid() {
        try {
            if (window.crypto && crypto.getRandomValues) {
                var a = new Uint8Array(12);
                crypto.getRandomValues(a);
                var s = '';
                for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
                return Date.now().toString(36) + '-' + s;
            }
        } catch (_) { }
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }

    function isTransient(err) {
        if (!err) return false;
        if (err.transient) return true;
        return err.status === 0 || (err.status >= 500 && err.status <= 599);
    }

    // ── 脱敏（客户端第一道网；服务端另有第二道） ───────────────────────
    var RULES = [
        { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, to: '⟨private-key⟩' },
        { kind: 'bearer', re: /Bearer\s+[A-Za-z0-9._\-]{16,}/gi, to: 'Bearer ⟨token⟩' },
        { kind: 'api-key', re: /\bsk-[A-Za-z0-9._\-]{16,}/g, to: '⟨api-key⟩' },
        { kind: 'secret', re: /((?:api[_-]?key|secret|passwd|password|access[_-]?token)\s*[:=]\s*["']?)[A-Za-z0-9._\-]{16,}/gi, to: '$1⟨redacted⟩' },
        { kind: 'ip', re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g, to: '⟨ip⟩' },
        { kind: 'win-path', re: /[A-Za-z]:[\\/][^\s"'<>|)`]+/g, to: '⟨本机路径⟩' },
        { kind: 'unix-path', re: /\/(?:srv|var\/www|root|opt|etc)\/[^\s"'<>|)`]*/g, to: '⟨服务器路径⟩' },
        { kind: 'file-url', re: /file:\/\/\/[^\s"'<>|)`]+/gi, to: '⟨本地文件⟩' }
    ];

    function redact(text, counts) {
        if (!text) return text;
        for (var i = 0; i < RULES.length; i++) {
            var r = RULES[i];
            var n = 0;
            text = text.replace(r.re, function (m) {
                // 已经是占位符 → 不重复计数
                if (m.indexOf('⟨') !== -1) return m;
                n++;
                return r.to;
            });
            if (n) counts[r.kind] = (counts[r.kind] || 0) + n;
        }
        return text;
    }

    // ── 采集：从 DOM 取原文（零内部状态耦合） ──────────────────────────
    // 提问气泡的文字必须剔掉图片行与角标：.msg-img-wrap 内既有缩略图也有 "#N" 角标，
    // textContent 会把两者一起收进来（历史 bug：提问正文里恒多出 "#1"）。
    function bubbleText(el) {
        if (!el) return '';
        try {
            var c = el.cloneNode(true);
            var rm = c.querySelectorAll('.msg-img-wrap, .msg-img-badge, .msg-user-copy');
            for (var i = 0; i < rm.length; i++) {
                if (rm[i].parentNode) rm[i].parentNode.removeChild(rm[i]);
            }
            return c.textContent || '';
        } catch (_) { return el.textContent || ''; }
    }

    // 楼层归属（恢复楼层在 _fDir 缺失时靠它把 fileName 解析成绝对路径）
    function floorCtxOf(msgEl, imgEl) {
        var wrap = imgEl && imgEl.closest ? imgEl.closest('.msg-img-wrap') : null;
        var row = wrap ? wrap.parentNode : null;
        var qid = (row && row.dataset && row.dataset.qid) || '';
        if (!qid) { try { qid = (typeof questActiveId !== 'undefined') ? questActiveId : ''; } catch (_) { qid = ''; } }
        var fn = (row && row.dataset && row.dataset.fn) || (msgEl && msgEl._floor) || 0;
        return { questId: String(qid || ''), floorNum: parseInt(fn, 10) || 0 };
    }

    // 提问气泡里的图片（唯一取图点）：dataUrl(base64) → localPath → fileName(按楼层目录解析)
    function collectBubbleImages(msgEl) {
        var out = [];
        if (!msgEl || !msgEl.querySelectorAll) return out;
        var wraps = msgEl.querySelectorAll('.msg-img-wrap');
        for (var i = 0; i < wraps.length; i++) {
            var imgEl = wraps[i].querySelector('img');
            var ref = imageRefOfEl(msgEl, imgEl);
            if (!ref) continue;
            var badge = wraps[i].querySelector('.msg-img-badge');
            var bid = parseInt(String((badge && badge.textContent) || '').replace(/[^0-9]/g, ''), 10) || (i + 1);
            out.push({ id: bid, ref: ref, name: ref.name || ('image' + (i + 1)) });
        }
        return out;
    }

    // 回答正文里真正渲染出来的图（DOM 唯一真相）：markdown 图 + 工具卡/历史楼的裸图。
    // 与 md 扫描按 refKey 去重；md 已带图片位的由 rewriteItems 就位，未被引用的追加到条目末尾。
    function harvestImages(aiEl) {
        var out = [];
        if (!aiEl || !aiEl.querySelectorAll) return out;
        var nodes = aiEl.querySelectorAll('.img-wrap > img, .msg-img-wrap > img');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            // 已裂图（md-render 的 onerror 会置 display:none）不入列：源文件没了就没必要占位报错
            if (el.style && el.style.display === 'none') continue;
            var ref = imageRefOfEl(aiEl, el);
            if (!ref) continue;
            out.push({ id: i + 1, ref: ref, name: ref.name || ('image' + (i + 1)) });
        }
        return out;
    }

    // aiEl = AI 回答元素（.msg-ai）；depth = 向前收多少轮（0=仅本轮）
    function collect(aiEl, depth) {
        var items = [];
        if (!aiEl || !aiEl.parentNode) return items;
        var sibs = Array.prototype.slice.call(aiEl.parentNode.children);
        var idx = sibs.indexOf(aiEl);
        if (idx < 0) return items;

        // ★ 配对唯一律：问题在前、答案在后 —— 遇到 .msg-user 只记「待配问题」，
        //   遇到下一个 .msg-ai 才成一轮。反模式（已废，禁回潮）：先把问题连同上一个
        //   答案一起 push —— 那样第 N 轮会被配成第 N-1 楼的答案（点五楼分享出四楼）。
        var turns = [];
        var pendQ = '', pendQImgs = [];
        for (var i = 0; i <= idx; i++) {
            var s = sibs[i];
            if (!s || !s.classList) continue;
            if (s.classList.contains('msg-user')) {
                pendQ = bubbleText(s);
                pendQImgs = collectBubbleImages(s);
            } else if (s.classList.contains('msg-ai')) {
                turns.push({ q: pendQ, qImgs: pendQImgs, a: s });
                pendQ = '';
                pendQImgs = [];
            }
        }
        // 当前回答恒为本轮答案（历史/机器楼层可能没有配对问题 → 问题留空，答案绝不丢）
        if (!turns.length || turns[turns.length - 1].a !== aiEl) turns.push({ q: pendQ, qImgs: pendQImgs, a: aiEl });
        var take = Math.max(1, Math.min(MAX_ITEMS, (depth || 0) + 1));
        turns = turns.slice(-take);

        var floorNum = 0;
        for (var t = 0; t < turns.length; t++) {
            var tr = turns[t];
            floorNum++;
            var qText = (tr.q || '').trim();
            if (qText) {
                var qi = { role: 'q', n: floorNum, md: qText };
                if (tr.qImgs && tr.qImgs.length) qi.imgs = tr.qImgs;
                items.push(qi);
            }
            var aEl = tr.a;
            var aMd = aEl ? (aEl._rawMarkdown || aEl._fullText || (aEl._contentWrap ? aEl._contentWrap.textContent : aEl.textContent) || '') : '';
            aMd = String(aMd || '').trim();
            var aimgs = harvestImages(aEl);
            if (aMd || aimgs.length > 0) {
                var tools = [];
                try {
                    if (aEl && aEl._contentWrap) {
                        var boxes = aEl._contentWrap.querySelectorAll('.tool-box, .tool-head, .msg-tool');
                        for (var b = 0; b < boxes.length && b < 40; b++) {
                            var name = (boxes[b].getAttribute('data-tool') || '').trim();
                            if (name) tools.push({ name: name, ok: true, brief: '' });
                        }
                    }
                } catch (_) { }
                var aItem = { role: 'a', n: floorNum, md: aMd, tools: tools };
                // ★ 回答里的图：DOM 是唯一真相源（任何看得见的图都要带得走，包括不在 markdown 里的）
                if (aimgs.length) aItem.imgs = aimgs;
                items.push(aItem);
            }
        }
        return items;
    }

    // ── 文件源（Roam / 编辑器）：文本 → 快照；图片 → 资产域 ────────────
    // 铁律：快照里永不写本机绝对路径（只留文件名）——分享内容一旦上公网，路径即泄密。
    var MD_RAW = { md: 1, markdown: 1, mdx: 1 };
    var LANG = {
        js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', mjs: 'javascript', cjs: 'javascript',
        json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
        html: 'html', htm: 'html', xml: 'xml', svg: 'xml', vue: 'vue', svelte: 'svelte',
        py: 'python', pyw: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
        c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
        sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'bat', cmd: 'bat', ps1: 'powershell',
        sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', conf: 'ini',
        php: 'php', rb: 'ruby', lua: 'lua', swift: 'swift', dart: 'dart',
        txt: 'text', log: 'text', csv: 'csv', tsv: 'text', env: 'ini'
    };
    var IMG_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, svg: 1 };
    var EXT_MIME = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
        gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml'
    };

    function baseName(p) {
        return String(p == null ? '' : p).split(/[\\/]/).pop() || '';
    }

    function extOf(p) {
        var n = baseName(p);
        var i = n.lastIndexOf('.');
        return i > 0 ? n.slice(i + 1).toLowerCase() : '';
    }

    function mimeOfExt(p) { return EXT_MIME[extOf(p)] || ''; }

    // 围栏长度动态：取正文里最长反引号串 +1（禁写死 ``` —— 含代码块的文件会被提前截断）
    function fenceWrap(text, lang) {
        var longest = 0, run = 0;
        for (var i = 0; i < text.length; i++) {
            if (text.charAt(i) === '`') { run++; if (run > longest) longest = run; }
            else run = 0;
        }
        var f = new Array(Math.max(3, longest + 1) + 1).join('`');
        return f + (lang || '') + '\n' + text.replace(/\s+$/, '') + '\n' + f;
    }

    function mdForFile(ext, text) {
        if (MD_RAW[ext]) return text;               // md 系原文直通（读者看到的 = 作者写的）
        return fenceWrap(text, LANG[ext] || '');     // 其余一切文本 → 围栏代码块（空格/缩进保真）
    }

    function modeForExt(ext) {
        if (IMG_EXT[ext]) return 'image';
        if (MD_RAW[ext]) return 'md';
        return 'code';
    }

    // 读多个文件 → 快照条目（图片只登记引用，字节在 create 前经资产域上传）
    // 返回 {items, failed, doc}
    function loadFiles(paths, onProgress) {
        var list = Array.isArray(paths) ? paths.slice(0, 20) : [];
        if (!list.length) return Promise.reject(new Error(_qq('ai.share.noFile', '没有可分享的文件')));
        var items = [], failed = [], seq = Promise.resolve();
        var usedBytes = 0;
        var b = bridge();
        list.forEach(function (p, idx) {
            seq = seq.then(function () {
                var name = baseName(p), ext = extOf(p);
                if (onProgress) onProgress(idx / list.length, name);
                if (IMG_EXT[ext]) {
                    items.push({
                        role: 'doc', n: idx + 1, name: name, md: '',
                        imgs: [{ id: 0, name: name, ref: { kind: 'path', v: p, mime: mimeOfExt(name), name: name } }]
                    });
                    return;
                }
                // 只收文本族（md / 代码 / 配置）：未登记扩展名 = 可能是二进制（.exe/.zip/.docx）——
                // 裸读会把乱码当正文发上公网，一律如实拒绝（多选时略过该件并报数）
                if (!MD_RAW[ext] && !LANG[ext]) {
                    if (list.length === 1) {
                        throw new Error(_qq('ai.share.unsupported', '{0} 暂不支持分享（仅文本 / Markdown / 代码 / 图片）', { 0: name }));
                    }
                    failed.push(name);
                    return;
                }
                if (!b || !b.fs || !b.fs.read) {
                    return Promise.reject(new Error(_qq('ai.share.noBridge', '当前环境无法读取本地文件')));
                }
                return Promise.resolve(b.fs.read(p)).then(function (text) {
                    if (text == null || !String(text).trim()) { failed.push(name); return; }
                    text = String(text);
                    var nBytes = bytesOf(text);
                    if (usedBytes + nBytes > MAX_FILE_BYTES) {
                        throw new Error(_qq('ai.share.fileTooLarge', '{0} 太大（{1} KB，上限 {2} KB）——请先截取或压缩',
                            { 0: name, 1: Math.round(nBytes / 1024), 2: Math.round(MAX_FILE_BYTES / 1024) }));
                    }
                    var md = mdForFile(ext, text);
                    usedBytes += bytesOf(md);
                    items.push({ role: 'doc', n: idx + 1, name: name, md: md });
                });
            });
        });
        return seq.then(function () {
            if (!items.length) throw new Error(_qq('ai.share.noFile', '没有可分享的文件'));
            var doc = null;
            if (list.length === 1) {
                var e1 = extOf(list[0]);
                doc = { name: baseName(list[0]), ext: e1, mode: modeForExt(e1) };
            }
            return { items: items, feeGe: 0, failed: failed, doc: doc };
        });
    }

    // ── 图片引用（唯一的图片形态） ─────────────────────────────────────
    // ref = {kind:'b64'|'path'|'floor', v, mime, name, ctx?}
    // ★ 本机图片目的地（唯一正则）：三种合法写法都必须认——漏认的后果不是报错，而是图片被脱敏
    //   规则（win-path / file-url）换成占位符后静默消失：
    //     ① ![](file:///E:/a.png)   ② ![](<file:///E:/a b.png>)（CommonMark 尖括号，路径带空格/中文）
    //     ③ ![](E:/a.png) / ![](E:\a.png)（模型漏写 file:/// 的裸盘符路径）
    var FILE_MD_RE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|(file:\/\/\/[^)]+?|file:\/\/[^)]+?|[A-Za-z]:[\\/][^)]+?))\s*\)/gi;

    // 捕获组归一：m[2] = <…> 内文，m[3] = 裸写法
    function pickDest(br, plain) {
        var d = (br != null && br !== '') ? br : (plain || '');
        return String(d || '').trim();
    }

    function dataUrlMime(u) {
        var m = /^data:([a-z0-9.+\/-]+)[;,]/i.exec(String(u || ''));
        return m ? m[1].toLowerCase() : '';
    }

    function sniffMime(b64) {
        var s = String(b64 || '').slice(0, 16);
        if (!s) return '';
        if (s.indexOf('iVBOR') === 0) return 'image/png';
        if (s.indexOf('/9j/') === 0) return 'image/jpeg';
        if (s.indexOf('R0lGOD') === 0) return 'image/gif';
        if (s.indexOf('UklGR') === 0) return 'image/webp';
        if (s.indexOf('Qk') === 0) return 'image/bmp';
        if (s.indexOf('PHN2Z') === 0) return 'image/svg+xml';
        return '';
    }

    function imageRefOfEl(msgEl, imgEl) {
        if (!imgEl) return null;
        var src = imgEl.getAttribute('src') || '';
        var ds = imgEl.dataset || {};
        var name = ds.fileName || baseName(ds.localPath || '') || 'image';
        if (ds.base64) return { kind: 'b64', v: ds.base64, mime: dataUrlMime(src) || mimeOfExt(name), name: name };
        if (ds.localPath) return { kind: 'path', v: ds.localPath, mime: mimeOfExt(ds.localPath), name: name };
        if (/^data:image\//i.test(src)) return { kind: 'b64', v: String(src).split(',')[1] || '', mime: dataUrlMime(src), name: name };
        if (/^file:\/\//i.test(src)) { var fp = fileURLToPath(src); return { kind: 'path', v: fp, mime: mimeOfExt(fp), name: (name === 'image' ? baseName(fp) : name) || 'image' }; }
        if (/^[A-Za-z]:[\\/]/.test(src)) return { kind: 'path', v: src, mime: mimeOfExt(src), name: baseName(src) };
        if (/^https?:/i.test(src)) return null;   // 已是公网地址 → 原样保留，不进资产域
        if (ds.fileName) return { kind: 'floor', v: ds.fileName, mime: mimeOfExt(ds.fileName), name: ds.fileName, ctx: floorCtxOf(msgEl, imgEl) };
        return null;
    }

    // 键归一：Windows 路径不分大小写、斜杠两种写法 → 同一张图必须只算一次（否则缩略图重复、
    // 正文里出现两遍、字节账翻倍）。禁把归一值当路径用（读取永远走 ref.v 原值）。
    function keyPath(p) { return String(p == null ? '' : p).replace(/\\/g, '/').toLowerCase(); }

    function refKey(ref) {
        if (!ref) return '';
        var v = String(ref.v || '');
        if (ref.kind === 'path' || ref.kind === 'floor') v = keyPath(v);
        return ref.kind + '|' + v;
    }

    // 待上传图片清单（UI 缩略图与上传共用同一份真相；禁各自再扫一遍 DOM/markdown）
    function listImages(items) {
        var seen = {}, out = [];
        function add(ref, alt, owner) {
            if (!ref) return;
            var k = refKey(ref);
            if (!k || seen[k]) return;
            seen[k] = 1;
            // bytes 只对已在内存的 base64 可算（零成本）；磁盘图先在 UI 上不报大小，真值由服务端实测
            out.push({
                key: k, name: ref.name || baseName(ref.v) || 'image', mime: ref.mime || '',
                ref: ref, alt: alt || '', owner: owner,
                bytes: (ref.kind === 'b64') ? b64Bytes(ref.v) : 0
            });
        }
        (items || []).forEach(function (it, ii) {
            var m;
            FILE_MD_RE.lastIndex = 0;
            while ((m = FILE_MD_RE.exec(it.md || ''))) {
                var p = fileURLToPath(pickDest(m[2], m[3]));
                if (!p) continue;
                add({ kind: 'path', v: p, mime: mimeOfExt(p), name: baseName(p) }, m[1], ii);
            }
            (it.imgs || []).forEach(function (im) { add(im.ref, im.name, ii); });
        });
        return out;
    }

    // 目的地 → 本机路径（唯一解析）：file:///E:/a.png · file://E:/a.png · <file:///E:/a b.png> · E:/a.png
    // 裸盘符路径不解码（% 在真实文件名里是普通字符，解码反而改坏路径）。
    function fileURLToPath(u) {
        var s = String(u == null ? '' : u).trim();
        if (s.charAt(0) === '<' && s.charAt(s.length - 1) === '>') s = s.slice(1, -1).trim();
        if (!/^file:/i.test(s)) return s;
        try {
            s = decodeURIComponent(s.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '').replace(/^file:/i, ''));
            if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
            return s;
        } catch (_) { return s; }
    }

    function base64Of(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        if (typeof res.base64 === 'string') return res.base64;
        if (typeof res.data === 'string') return res.data;
        if (res.ok && typeof res.data === 'string') return res.data;
        return '';
    }

    function b64Bytes(b64) {
        var s = String(b64 || '');
        if (!s) return 0;
        var pad = 0;
        if (s.charAt(s.length - 1) === '=') pad++;
        if (s.charAt(s.length - 2) === '=') pad++;
        return Math.floor(s.length * 3 / 4) - pad;
    }

    function readPath(p) {
        var b = bridge();
        if (!b || !b.fs || !b.fs.readBase64) return Promise.reject(new Error(_qq('ai.share.noBridge', '当前环境无法读取本地文件')));
        return Promise.resolve(b.fs.readBase64(p)).then(function (res) {
            var b64 = base64Of(res);
            if (!b64) return Promise.reject(new Error(_qq('ai.share.readFail', '读取图片失败：{0}', { 0: baseName(p) })));
            return b64;
        });
    }

    function readRef(ref) {
        if (!ref) return Promise.reject(new Error('no image ref'));
        if (ref.kind === 'b64') return Promise.resolve({ b64: ref.v, mime: ref.mime || '' });
        if (ref.kind === 'floor') {
            return Promise.resolve().then(function () {
                var qs = window.questStore;
                if (!qs || typeof qs.resolveFloorDir !== 'function' || !ref.ctx || !ref.ctx.questId) return '';
                return qs.resolveFloorDir(ref.ctx.questId, ref.ctx.floorNum).then(function (dir) {
                    return dir ? (dir + ref.v) : '';
                });
            }).then(function (path) {
                if (!path) return Promise.reject(new Error(_qq('ai.share.readFail', '读取图片失败：{0}', { 0: ref.v })));
                return readPath(path).then(function (b64) { return { b64: b64, mime: ref.mime || mimeOfExt(path) }; });
            });
        }
        return readPath(ref.v).then(function (b64) { return { b64: b64, mime: ref.mime || mimeOfExt(ref.v) }; });
    }

    function dimsOf(b64, mime) {
        return new Promise(function (resolve) {
            if (typeof Image !== 'function' || /svg/i.test(mime)) { resolve({ w: 0, h: 0 }); return; }
            var img = new Image(), done = false;
            function fin(w, h) { if (done) return; done = true; resolve({ w: w || 0, h: h || 0 }); }
            img.onload = function () { fin(img.naturalWidth, img.naturalHeight); };
            img.onerror = function () { fin(0, 0); };
            try { img.src = 'data:' + (mime || 'image/png') + ';base64,' + b64; } catch (_) { fin(0, 0); }
            setTimeout(function () { fin(0, 0); }, 4000);
        });
    }

    // sha256（有则作为强 ETag，让重复阅读零流量；不可用环境留空——服务端接受空值）
    function sha256Of(b64) {
        try {
            if (!(window.crypto && crypto.subtle && crypto.subtle.digest)) return Promise.resolve('');
            var bin = atob(b64), u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return crypto.subtle.digest('SHA-256', u8).then(function (buf) {
                var v = new Uint8Array(buf), s = '';
                for (var j = 0; j < v.length; j++) s += ('0' + v[j].toString(16)).slice(-2);
                return s;
            }, function () { return ''; });
        } catch (_) { return Promise.resolve(''); }
    }

    function reserveAssets(ready) {
        var payload = ready.map(function (r, i) {
            return { n: i + 1, bytes: r.bytes, mime: r.mime, w: r.w, h: r.h, sha256: r.sha || '' };
        });
        return api('/share/asset/reserve', {
            method: 'POST', body: JSON.stringify({ items: payload }), timeoutMs: 45000
        }).then(function (res) { return (res && res.items) || []; });
    }

    function putAsset(slot, b64, mime, onProgress) {
        return new Promise(function (resolve, reject) {
            var bin;
            try { bin = atob(b64); } catch (_) { reject(new Error('bad image data')); return; }
            var u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            var blob = new Blob([u8], { type: slot.mime || mime });
            var xhr = new XMLHttpRequest();
            xhr.open('PUT', slot.put_url, true);
            xhr.setRequestHeader('Content-Type', slot.mime || mime);
            xhr.upload.onprogress = function (ev) {
                if (onProgress && ev.lengthComputable && ev.total) onProgress(ev.loaded / ev.total);
            };
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) resolve(true);
                else reject(new Error(_qq('ai.share.uploadFail', '图片上传失败 HTTP {0}', { 0: xhr.status })));
            };
            xhr.onerror = function () { reject(new Error(_qq('ai.share.uploadBreak', '网络中断，图片未传完'))); };
            xhr.ontimeout = function () { reject(new Error(_qq('ai.share.timeout', '请求超时'))); };
            xhr.send(blob);
        });
    }

    // md 改写：本机图片 → asset:N；[img:N] 令牌就位；未引用的追加到末尾
    function rewriteItems(items, map) {
        var out = [];
        items.forEach(function (it) {
            var md = String(it.md || '');
            var used = {};   // 正文已就位的图（md 图片位 + [img:N] 令牌）——同一张图绝不出两次
            FILE_MD_RE.lastIndex = 0;
            md = md.replace(FILE_MD_RE, function (all, alt, br, plain) {
                var p = fileURLToPath(pickDest(br, plain));
                var k = 'path|' + keyPath(p);
                if (!p || !map[k]) return '';   // 上传失败 → 整行删除（不谎报、不留裂图）
                used[k] = 1;
                return '![' + alt + '](asset:' + map[k] + ')';
            });
            if (it.imgs && it.imgs.length) {
                md = md.replace(/\[img:(\d+)\]/g, function (all, d) {
                    var hit = null;
                    for (var i = 0; i < it.imgs.length; i++) {
                        if (String(it.imgs[i].id) === String(d)) { hit = it.imgs[i]; break; }
                    }
                    if (!hit) return all;
                    var k2 = refKey(hit.ref);
                    if (!map[k2] || used[k2]) return '';
                    used[k2] = 1;
                    return '![' + (hit.name || 'image') + '](asset:' + map[k2] + ')';
                });
                var rest = [];
                it.imgs.forEach(function (im) {
                    var k3 = refKey(im.ref);
                    if (!map[k3] || used[k3]) return;
                    used[k3] = 1;
                    rest.push('![' + (im.name || 'image') + '](asset:' + map[k3] + ')');
                });
                if (rest.length) md = (md.replace(/\s+$/, '') + '\n\n' + rest.join('\n')).replace(/^\s+/, '');
            }
            var mdTrim = String(md || '').trim();
            if (!mdTrim) return;
            var o = { role: it.role, n: it.n, md: mdTrim };
            if (it.name) o.name = it.name;
            if (it.tools && it.tools.length) o.tools = it.tools;
            out.push(o);
        });
        return out;
    }

    // 唯一上传入口：读字节 → 限额 → 预占 → 直传 → 返回 {items, assets, failed}
    // opt = { tier, drop: {key:1}, onProgress(pct, name) }
    function prepareAssets(items, opt) {
        opt = opt || {};
        var all = listImages(items);
        var drop = opt.drop || {};
        var keep = all.filter(function (r) { return !drop[r.key]; });
        var dropped = all.length - keep.length;
        if (!keep.length) {
            return Promise.resolve({
                items: rewriteItems(items, {}), assets: [], count: 0, bytes: 0,
                failed: [], dropped: dropped
            });
        }
        if (keep.length > ASSET_MAX_COUNT) {
            return Promise.reject(new Error(_qq('ai.share.imgTooMany', '一次最多 {0} 张图片', { 0: ASSET_MAX_COUNT })));
        }
        var cap = (opt.tier === 'trial') ? ASSET_CAP_TRIAL : ASSET_CAP_PAID;
        var failed = [], ready = [], total = 0;
        var seq = Promise.resolve();
        keep.forEach(function (r) {
            seq = seq.then(function () {
                return readRef(r.ref).then(function (got) {
                    if (!got || !got.b64) { failed.push(r.name); return; }
                    var mime = got.mime || sniffMime(got.b64) || 'image/png';
                    if (!EXT_MIME[(mime.split('/')[1] || '').replace('jpeg', 'jpg')] && mime !== 'image/svg+xml') {
                        failed.push(r.name);
                        return;
                    }
                    var bytes = b64Bytes(got.b64);
                    if (bytes <= 0) { failed.push(r.name); return; }
                    if (bytes > ASSET_MAX_EACH) {
                        throw new Error(_qq('ai.share.imgTooBig', '{0} 太大（{1} MB，单张上限 {2} MB）',
                            { 0: r.name, 1: (bytes / 1048576).toFixed(1), 2: Math.round(ASSET_MAX_EACH / 1048576) }));
                    }
                    total += bytes;
                    if (total > cap) {
                        throw new Error(_qq('ai.share.imgCap', '图片总量超过上限（{0} MB）——请减少图片，或选更长档位',
                            { 0: Math.round(cap / 1048576) }));
                    }
                    return Promise.all([dimsOf(got.b64, mime), sha256Of(got.b64)]).then(function (arr) {
                        ready.push({
                            key: r.key, name: r.name, b64: got.b64, mime: mime, bytes: bytes,
                            w: arr[0].w, h: arr[0].h, sha: arr[1] || ''
                        });
                    });
                }, function () { failed.push(r.name); });
            });
        });

        return seq.then(function () {
            if (!ready.length) {
                return { items: rewriteItems(items, {}), assets: [], count: 0, bytes: 0, failed: failed, dropped: dropped };
            }
            return reserveAssets(ready).then(function (slots) {
                var map = {};
                var done = 0;
                var seq2 = Promise.resolve();
                ready.forEach(function (r, i) {
                    seq2 = seq2.then(function () {
                        var slot = slots[i];
                        if (!slot) { failed.push(r.name); return; }
                        return putAsset(slot, r.b64, r.mime, function (pct) {
                            if (opt.onProgress) opt.onProgress((i + pct) / ready.length, r.name);
                        }).then(function () {
                            map[r.key] = slot.n;
                            done++;
                            if (opt.onProgress) opt.onProgress((i + 1) / ready.length, r.name);
                        }, function () { failed.push(r.name); });
                    });
                });
                return seq2.then(function () {
                    var assets = Object.keys(map).map(function (k) {
                        var n = map[k];
                        var slot = slots.filter(function (s) { return s.n === n; })[0];
                        return { n: n, uid: slot ? slot.uid : '' };
                    }).filter(function (a) { return !!a.uid; });
                    var bytes = 0;
                    ready.forEach(function (r) { if (map[r.key]) bytes += r.bytes; });
                    return {
                        items: rewriteItems(items, map),
                        assets: assets, count: done, bytes: bytes,
                        failed: failed, dropped: dropped
                    };
                });
            });
        });
    }

    // ── gzip（浏览器原生；无则诚实失败） ───────────────────────────────
    function gzipToBase64(str) {
        var bytes = new TextEncoder().encode(str);
        if (typeof CompressionStream !== 'function') {
            return Promise.reject(new Error(_qq('ai.share.noGzip', '当前环境不支持压缩上传')));
        }
        var cs = new CompressionStream('gzip');
        var stream = new Blob([bytes]).stream().pipeThrough(cs);
        return new Response(stream).arrayBuffer().then(function (ab) {
            var u8 = new Uint8Array(ab);
            var bin = '';
            var chunk = 0x8000;
            for (var i = 0; i < u8.length; i += chunk) {
                bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
            }
            return btoa(bin);
        });
    }

    // ── 组包 ────────────────────────────────────────────────────────────
    function buildBundle(opt) {
        var items = opt.items || [];
        var redCounts = {};
        if (opt.redact !== false) {
            items.forEach(function (it) {
                it.md = redact(it.md, redCounts);
                if (it.tools && it.tools.length) {
                    it.tools.forEach(function (t) {
                        if (t.brief) t.brief = redact(t.brief, redCounts);
                    });
                }
            });
        }
        var redactions = Object.keys(redCounts).map(function (k) {
            return { kind: k, n: redCounts[k], by: 'client' };
        });
        var bundle = {
            v: BUNDLE_V,
            renderer: RENDERER,
            kind: opt.kind || 'floor',
            generator: 'qd',
            created: new Date().toISOString(),
            title: opt.title || '',
            subtitle: opt.subtitle || '',
            quest: opt.quest || '',
            items: items.map(function (it) {
                var o = { role: it.role, n: it.n, md: it.md };
                if (it.name) o.name = it.name;
                if (it.tools && it.tools.length) o.tools = it.tools;
                return o;
            }),
            redactions: redactions
        };
        if (opt.doc) bundle.doc = opt.doc;
        return bundle;
    }

    // ── 对外 API ────────────────────────────────────────────────────────
    var Share = {
        token: token,
        collect: collect,
        listImages: listImages,
        prepareAssets: prepareAssets,
        loadFiles: loadFiles,
        bytesOf: bytesOf,
        baseName: baseName,
        extOf: extOf,
        mimeOfExt: mimeOfExt,
        redact: redact,
        buildBundle: buildBundle,
        gzipToBase64: gzipToBase64,

        newCid: newCid,

        // 创建 = 幂等一次（cid 恒定）＋ 网络层失败自动重试（同 cid → 服务端只会有一条）
        create: function (opt) {
            var bundle = opt.bundle || buildBundle(opt);
            var json = JSON.stringify(bundle);
            var cid = opt.cid || newCid();
            var ATTEMPTS = 3;
            return gzipToBase64(json).then(function (b64) {
                var body = JSON.stringify({
                    title: opt.title || bundle.title || '',
                    kind: opt.kind || bundle.kind || 'floor',
                    tier: opt.tier || 'trial',
                    visibility: opt.visibility || 'unlisted',
                    password: opt.password || '',
                    lang: (document.documentElement.lang || 'zh').slice(0, 8),
                    src_quest: opt.quest || '',
                    src_floors: opt.floors || [],
                    cid: cid,
                    assets: opt.assets || [],
                    bundle_b64: b64
                });
                var attempt = 0;
                function once() {
                    attempt++;
                    return api('/share/create', { method: 'POST', body: body, timeoutMs: 120000 })
                        .catch(function (err) {
                            if (attempt < ATTEMPTS && isTransient(err)) {
                                return new Promise(function (res) { setTimeout(res, 800 * attempt); }).then(once);
                            }
                            throw err;
                        });
                }
                return once().then(function (res) {
                    try { res.cid = cid; } catch (_) { }
                    return res;
                });
            });
        },

        mine: function () { return api('/share/mine'); },
        extend: function (id, tier) { return api('/share/extend', { method: 'POST', body: JSON.stringify({ id: id, tier: tier }) }); },
        revoke: function (id) { return api('/share/revoke', { method: 'POST', body: JSON.stringify({ id: id }) }); },
        remove: function (id) { return api('/share/delete', { method: 'POST', body: JSON.stringify({ id: id }) }); }
    };

    window.QqqShare = Share;
})();
