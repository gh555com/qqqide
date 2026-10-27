// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ════════════════════════════════════════════════════════════════════════════
// share-machine.js —— 分享唯一机器（组包 / 脱敏 / 附图上传 / 三本账）
// ----------------------------------------------------------------------------
// 铁律：
//   · 快照自治：内容全进 bundle，源 quest 删除不影响阅读
//   · 不裁剪只折叠：默认收录整轮问答原文，读者可展开全部
//   · 脱敏即分享：默认开；本机路径 / IP / 密钥 / 令牌 一律替换为占位符
//   · 计费边界：文字（≤1 MiB）随租约；图片走图床（1 ge / 10MB，独立存储费）
//   · 分享 ≠ 发布：默认不进搜索引擎，只有「公开可索引」档例外
// ════════════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ★ 写请求恒走 www（灰云直连），禁走 apex：apex = 橙云 + 边缘 Worker，写路径有 15s 硬上限，
    //   超时即回 503 "Origin unavailable"，而源站早已把分享建成 —— 前端假失败 + 真落库（已实锤）。
    //   www 直连源站无边缘超时；与既有登录 / goods / 推广写请求同一宿主（唯一口径）。
    var API = 'https://www.gh555.com/api';
    var BUNDLE_V = 1;
    var RENDERER = 's2'; // s2 = 支持 role=doc/sel（文件源与选区快照）
    var MAX_ITEMS = 200;
    var MAX_FILE_BYTES = 700000; // 快照解压上限 1 MiB（字节，非字符：中文 1 字 = 3 字节）；留出 JSON 包装余量

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
        var pendQ = '';
        for (var i = 0; i <= idx; i++) {
            var s = sibs[i];
            if (!s || !s.classList) continue;
            if (s.classList.contains('msg-user')) {
                pendQ = s.textContent || '';
            } else if (s.classList.contains('msg-ai')) {
                turns.push({ q: pendQ, a: s });
                pendQ = '';
            }
        }
        // 当前回答恒为本轮答案（历史/机器楼层可能没有配对问题 → 问题留空，答案绝不丢）
        if (!turns.length || turns[turns.length - 1].a !== aiEl) turns.push({ q: pendQ, a: aiEl });
        var take = Math.max(1, Math.min(MAX_ITEMS, (depth || 0) + 1));
        turns = turns.slice(-take);

        var floorNum = 0;
        for (var t = 0; t < turns.length; t++) {
            var tr = turns[t];
            floorNum++;
            var qText = (tr.q || '').trim();
            if (qText) {
                items.push({ role: 'q', n: floorNum, md: qText });
            }
            var aEl = tr.a;
            var aMd = aEl ? (aEl._rawMarkdown || aEl._fullText || (aEl._contentWrap ? aEl._contentWrap.textContent : aEl.textContent) || '') : '';
            aMd = String(aMd || '').trim();
            if (aMd) {
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
                items.push({ role: 'a', n: floorNum, md: aMd, tools: tools });
            }
        }
        return items;
    }

    // ── 文件源（Roam / 编辑器）：文本 → 快照；图片 → 图床 ────────────
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

    function baseName(p) {
        return String(p == null ? '' : p).split(/[\\/]/).pop() || '';
    }

    function extOf(p) {
        var n = baseName(p);
        var i = n.lastIndexOf('.');
        return i > 0 ? n.slice(i + 1).toLowerCase() : '';
    }

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

    // 读多个文件 → 快照条目（图片走图床；文本进 bundle）
    // 返回 {items, feeGe, failed, doc}
    function loadFiles(paths, onProgress) {
        var list = Array.isArray(paths) ? paths.slice(0, 20) : [];
        if (!list.length) return Promise.reject(new Error(_qq('ai.share.noFile', '没有可分享的文件')));
        var items = [], fee = 0, failed = [], seq = Promise.resolve();
        var usedBytes = 0;
        var b = bridge();
        list.forEach(function (p, idx) {
            seq = seq.then(function () {
                var name = baseName(p), ext = extOf(p);
                if (onProgress) onProgress(idx / list.length, name);
                if (IMG_EXT[ext]) {
                    return uploadOneFile(p, null).then(function (r) {
                        fee += parseFloat(r.fee || '0') || 0;
                        items.push({ role: 'doc', n: idx + 1, name: name, md: '![' + name + '](' + r.url + ')' });
                    }).catch(function () { failed.push(name); });
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
            return { items: items, feeGe: fee, failed: failed, doc: doc };
        });
    }

    // ── 附图：本机图片 → 图床（走既有三步上传，唯一字节通道） ──────────
    var IMG_RE = /!\[([^\]]*)\]\((file:\/\/\/[^)\s]+|file:\/\/\/[^)]+)\)/gi;

    function collectLocalImages(items) {
        var seen = {}, list = [];
        items.forEach(function (it) {
            var m;
            IMG_RE.lastIndex = 0;
            while ((m = IMG_RE.exec(it.md || ''))) {
                var url = m[2];
                if (!seen[url]) { seen[url] = 1; list.push(url); }
            }
        });
        return list;
    }

    function fileURLToPath(u) {
        try {
            var s = decodeURIComponent(String(u).replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, ''));
            if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
            return s;
        } catch (_) { return ''; }
    }

    function mimeOf(p) {
        var e = (p.split('.').pop() || '').toLowerCase();
        if (e === 'png') return 'image/png';
        if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
        if (e === 'gif') return 'image/gif';
        if (e === 'webp') return 'image/webp';
        if (e === 'bmp') return 'image/bmp';
        if (e === 'svg') return 'image/svg+xml';
        return 'application/octet-stream';
    }

    function base64ToBlob(b64, mime) {
        var bin = atob(b64);
        var len = bin.length;
        var buf = new Uint8Array(len);
        for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
        return new Blob([buf], { type: mime });
    }

    function base64Of(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        if (typeof res.base64 === 'string') return res.base64;
        if (typeof res.data === 'string') return res.data;
        if (res.ok && typeof res.data === 'string') return res.data;
        return '';
    }

    function uploadOneFile(path, onProgress) {
        var b = bridge();
        if (!b || !b.fs || !b.fs.readBase64) return Promise.reject(new Error(_qq('ai.share.noBridge', '当前环境无法读取本地文件')));
        var name = path.split(/[\\/]/).pop() || 'image.png';
        var mime = mimeOf(name);
        return Promise.resolve(b.fs.readBase64(path)).then(function (res) {
            var b64 = base64Of(res);
            if (!b64) throw new Error(_qq('ai.share.readFail', '读取图片失败：{0}', { 0: name }));
            var blob = base64ToBlob(b64, mime);
            return api('/upload/init', {
                method: 'POST',
                body: JSON.stringify({
                    filename: name, size: blob.size, content_type: mime,
                    standalone: true, folder: 'share/' + new Date().getFullYear()
                })
            }).then(function (d0) {
                return new Promise(function (resolve, reject) {
                    var xhr = new XMLHttpRequest();
                    xhr.open('PUT', d0.upload_url, true);
                    xhr.setRequestHeader('Content-Type', mime);
                    xhr.upload.onprogress = function (ev) {
                        if (onProgress && ev.lengthComputable && ev.total) onProgress(ev.loaded / ev.total);
                    };
                    xhr.onload = function () {
                        if (xhr.status >= 200 && xhr.status < 300) resolve(d0);
                        else reject(new Error(_qq('ai.share.uploadFail', '图片上传失败 HTTP {0}', { 0: xhr.status })));
                    };
                    xhr.onerror = function () { reject(new Error(_qq('ai.share.uploadBreak', '网络中断，图片未传完'))); };
                    xhr.send(blob);
                });
            }).then(function (d0) {
                return api('/upload/complete', { method: 'POST', body: JSON.stringify({ r2_key: d0.r2_key }) })
                    .then(function (d1) { return { url: d1.url || d0.cdn_url, fee: d0.storage_fee_ge || '0' }; });
            });
        });
    }

    // 把 items 里的本机图片替换为图床 URL；返回 {items, used, feeGe, failed}
    function uploadImages(items, onProgress) {
        var urls = collectLocalImages(items);
        if (!urls.length) return Promise.resolve({ items: items, used: 0, feeGe: 0, failed: [] });
        var map = {}, failed = [], fee = 0, done = 0;
        var seq = Promise.resolve();
        urls.forEach(function (u) {
            seq = seq.then(function () {
                var p = fileURLToPath(u);
                if (!p) { failed.push(u); return; }
                return uploadOneFile(p, function (pct) {
                    if (onProgress) onProgress(urls.length ? (done + pct) / urls.length : 0);
                }).then(function (r) {
                    map[u] = r.url;
                    fee += parseFloat(r.fee || '0') || 0;
                    done++;
                    if (onProgress) onProgress(done / urls.length);
                }).catch(function () {
                    failed.push(u);
                    done++;
                });
            });
        });
        return seq.then(function () {
            items.forEach(function (it) {
                IMG_RE.lastIndex = 0;
                it.md = String(it.md || '').replace(IMG_RE, function (all, alt, url) {
                    if (map[url]) return '![' + alt + '](' + map[url] + ')';
                    return '![' + alt + '](about:blank#image-omitted)';
                });
            });
            return { items: items, used: Object.keys(map).length, feeGe: fee, failed: failed };
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
        collectLocalImages: collectLocalImages,
        uploadImages: uploadImages,
        loadFiles: loadFiles,
        bytesOf: bytesOf,
        baseName: baseName,
        extOf: extOf,
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
