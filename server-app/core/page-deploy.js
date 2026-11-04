// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ════════════════════════════════════════════════════════════════════════════
// page-deploy.js —— 页面发布唯一机器（主窗口模态）
// ----------------------------------------------------------------------------
// 定位：让读者【访问一个页面】（作者的排版，原样执行）—— 与 AI 对话分享（/p/{id}，让读者
// 读一篇文章）是两件事。文件类动作的宿主恒为主窗口，禁挂进左中右任何一台 AI 面板。
//
// 铁律：
//   · 发布的不是「一个 html」，是「一个目录」：进了范围的文件按【原相对路径】直传，
//     路径一个字符不改 ⇒ 路径保真由构造保证，不依赖任何解析/构建。
//   · 搬运层与选择层彻底分开：静态扫描只决定**默认勾选谁**，永不当正确性来源；
//     它漏了 = 页面某处 404（看得见、能改），不是静默残页。
//   · 搬运 = 字节原样：禁改写 / 禁压缩 / 禁注入 / 禁重写引用。
//   · 默认勾「引用集」而不是整目录：整目录会把草稿/notes 一起推上公网（泄露），
//     少发只是残页 —— 两种错的代价不对等，所以默认站在「可能少发」这一侧。
//   · 不重造上传器：其它文件一律走 bed（goods 网页），本模块只管「发布一页」。
// ════════════════════════════════════════════════════════════════════════════

(function () {
    'use strict';
    if (window.top !== window) return;   // 只在主窗口存在

    // ★ 写请求恒走 www（灰云直连源站，无边缘超时）；与分享/登录/goods 写路径同一宿主口径
    var API = 'https://www.gh555.com/api';
    var WEB = 'https://www.gh555.com';

    // 与服务端同值（客户端只做"上传前早提示"，裁决永远在服务端）
    var MAX_SITE = 5 * 1024 * 1024;
    var MAX_FILES = 400;
    var MAX_SCAN_FILES = 200;
    var READ_CAP = 512 * 1024;          // 只对 ≤512KB 的文本做引用扫描
    var SKIP_DIRS = { '.git': 1, '.svn': 1, '.hg': 1, 'node_modules': 1, '__pycache__': 1, '.idea': 1, '_qqq': 1 };
    var TEXT_EXT = { '.html': 1, '.htm': 1, '.css': 1, '.js': 1, '.mjs': 1, '.cjs': 1 };

    function T(key, def, params) {
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                var s = window.i18n.t(key, params);
                if (s && s !== key) return s;
            }
        } catch (_) { }
        var out = def || key;
        if (params) {
            Object.keys(params).forEach(function (k) {
                out = out.split('{' + k + '}').join(String(params[k]));
            });
        }
        return out;
    }

    function bridge() { try { return window.qqqideBridge || null; } catch (_) { return null; } }
    function fsApi() { var b = bridge(); return b && b.fs ? b.fs : null; }

    function token() {
        try { if (window.qqqLogin && window.qqqLogin.getAuthToken) return window.qqqLogin.getAuthToken() || ''; } catch (_) { }
        return '';
    }

    function qoast(msg, kind) {
        try {
            if (window.qqqQoast && window.qqqQoast.show) { window.qqqQoast.show(msg, { type: kind || 'info' }); return; }
        } catch (_) { }
        try { if (window.qqqideQoast && window.qqqideQoast.show) window.qqqideQoast.show(msg); } catch (_) { }
    }

    // ── 路径工具（本机路径恒按两种分隔符处理；相对路径恒用 /）──
    function dirName(p) {
        var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return i <= 0 ? '' : p.slice(0, i);
    }
    function baseName(p) {
        var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        return i < 0 ? p : p.slice(i + 1);
    }
    function extOf(p) { var b = baseName(p).toLowerCase(); var i = b.lastIndexOf('.'); return i < 0 ? '' : b.slice(i); }
    function toSlash(p) { return String(p || '').replace(/\\/g, '/'); }
    function fmtBytes(n) {
        if (!n) return '0 B';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    function relOf(root, abs) {
        var r = toSlash(root), a = toSlash(abs);
        if (a.slice(0, r.length + 1) === r + '/') return a.slice(r.length + 1);
        if (a === r) return '';
        return a;
    }

    // ── 发布根的哈希（"这个文件夹是否已发布"的唯一判据；明文路径永不上服务器）──
    //   大小写仅 Windows 形态路径归一（盘符/反斜杠）—— POSIX 上 /a/Proj 与 /a/proj 是两个不同目录，
    //   降大小写 = 误判「已发布」（判据用形态而非平台探测，同 share-machine.keyPath）。
    function rootKeyOf(root) {
        var raw = String(root || '');
        var norm = toSlash(root).replace(/\/+$/, '');
        if (raw.indexOf('\\') >= 0 || /^[A-Za-z]:\//.test(norm)) { norm = norm.toLowerCase(); }
        return sha256Hex(norm).then(function (h) { return h ? h.slice(0, 24) : ''; }, function () { return ''; });
    }
    function sha256Hex(s) {
        try {
            if (!(window.crypto && crypto.subtle && window.TextEncoder)) return Promise.resolve('');
            var u8 = new TextEncoder().encode(s);
            return crypto.subtle.digest('SHA-256', u8).then(function (buf) {
                var v = new Uint8Array(buf), out = '';
                for (var i = 0; i < v.length; i++) out += ('0' + v[i].toString(16)).slice(-2);
                return out;
            }, function () { return ''; });
        } catch (_) { return Promise.resolve(''); }
    }

    // ── 目录扫描（黑名单 + 深度/数量上限；只列文件，不跟随符号链接目录）──
    function scanDir(root) {
        var fs = fsApi();
        if (!fs || !fs.list) return Promise.reject(new Error(T('deploy.noBridge', '主进程接口不可用（请重启实例）')));
        var out = [];
        var truncated = false;
        function walk(absDir, relDir, depth) {
            if (truncated) return Promise.resolve();
            if (depth > 8) return Promise.resolve();
            return fs.list(absDir).then(function (entries) {
                var names = (entries || []).slice().sort(function (a, b) {
                    return String(a.name).localeCompare(String(b.name));
                });
                var chain = Promise.resolve();
                names.forEach(function (e) {
                    chain = chain.then(function () {
                        if (truncated) return;
                        var nm = String(e.name || '');
                        if (!nm || nm === '.' || nm === '..') return;
                        var rel = relDir ? relDir + '/' + nm : nm;
                        var abs = toSlash(absDir).replace(/\/+$/, '') + '/' + nm;
                        if (e.isDir) {
                            if (SKIP_DIRS[nm.toLowerCase()] || nm.charAt(0) === '.') return;
                            return walk(abs, rel, depth + 1);
                        }
                        if (nm.charAt(0) === '.') return;
                        if (out.length >= MAX_FILES) { truncated = true; return; }
                        out.push({ rel: rel, abs: abs, size: Number(e.size) || 0, ext: extOf(nm) });
                    });
                });
                return chain;
            }, function () { return; });
        }
        return walk(toSlash(root).replace(/\/+$/, ''), '', 0).then(function () {
            out.sort(function (a, b) { return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0; });
            return { files: out, truncated: truncated };
        });
    }

    // ── 引用解析（静态扫描只出默认值：漏了 = 某处 404，用户看得见、能改）──
    function dirOfRel(rel) { var i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); }

    function resolveRef(fromRel, raw) {
        var ref = String(raw == null ? '' : raw).trim();
        if (!ref) return { skip: true };
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) || ref.charAt(0) === '#') return { skip: true };
        if (ref.charAt(0) === '/') return { rootAbs: true };
        var q = ref.indexOf('?'); if (q >= 0) ref = ref.slice(0, q);
        var h = ref.indexOf('#'); if (h >= 0) ref = ref.slice(0, h);
        if (!ref) return { skip: true };
        var base = dirOfRel(fromRel);
        var parts = (base ? base.split('/') : []).concat(ref.split('/'));
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var s = parts[i];
            if (!s || s === '.') continue;
            if (s === '..') { if (!out.length) return { outside: true }; out.pop(); continue; }
            out.push(s);
        }
        if (!out.length) return { skip: true };
        return { rel: out.join('/') };
    }

    function refsOfText(rel, text) {
        var ext = extOf(rel), found = [];
        var push = function (m) { if (m && m[1]) found.push(m[1]); };
        if (ext === '.html' || ext === '.htm') {
            var re = /\b(?:href|src|poster|data|action)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, m;
            while ((m = re.exec(text))) found.push(m[1] != null ? m[1] : m[2]);
            var re2 = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
            while ((m = re2.exec(text))) {
                String(m[1] != null ? m[1] : m[2]).split(',').forEach(function (part) {
                    var u = part.trim().split(/\s+/)[0];
                    if (u) found.push(u);
                });
            }
            var re3 = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
            while ((m = re3.exec(text))) found.push(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]));
        } else if (ext === '.css') {
            var re4 = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi, m4;
            while ((m4 = re4.exec(text))) found.push(m4[1] != null ? m4[1] : (m4[2] != null ? m4[2] : m4[3]));
            var re5 = /@import\s+(?:url\()?\s*(?:"([^"]*)"|'([^']*)')/gi, m5;
            while ((m5 = re5.exec(text))) found.push(m5[1] != null ? m5[1] : m5[2]);
        } else {
            // JS：只认"像资源路径"的字符串字面量（拼出来的路径静态扫不到 —— 那正是默认值可能不全的原因）
            var re6 = /["'`]([^"'`\n]{1,160}?\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|avif|json|woff2?|ttf|mp4|webm|mp3|ogg))["'`]/gi, m6;
            while ((m6 = re6.exec(text))) found.push(m6[1]);
        }
        return found;
    }

    function pickEntry(files, preferred) {
        if (preferred) {
            for (var i = 0; i < files.length; i++) if (files[i].rel === preferred) return preferred;
        }
        for (var j = 0; j < files.length; j++) if (files[j].rel === 'index.html') return 'index.html';
        var pool = files.filter(function (f) { return f.ext === '.html' || f.ext === '.htm'; });
        pool.sort(function (a, b) {
            var da = a.rel.indexOf('/') < 0 ? 0 : 1, db = b.rel.indexOf('/') < 0 ? 0 : 1;
            if (da !== db) return da - db;
            return a.rel < b.rel ? -1 : 1;
        });
        return pool.length ? pool[0].rel : '';
    }

    // 默认勾选集 = 入口 + 静态引用命中（递归，上限 MAX_SCAN_FILES）
    function defaultSet(root, files, entry) {
        var fs = fsApi(), byRel = {};
        files.forEach(function (f) { byRel[f.rel] = f; });
        var sel = {}, missing = {}, outside = 0, rootAbs = 0;
        if (!entry) return Promise.resolve({ sel: sel, missing: 0, outside: 0, rootAbs: 0 });
        sel[entry] = 1;
        var queue = [entry], processed = 0;
        function step() {
            if (!queue.length || processed >= MAX_SCAN_FILES) return Promise.resolve();
            var rel = queue.shift();
            processed++;
            var f = byRel[rel];
            if (!f || !TEXT_EXT[f.ext] || f.size > READ_CAP || !fs || !fs.read) return step();
            return fs.read(f.abs).then(function (text) {
                if (typeof text === 'string' && text) {
                    refsOfText(rel, text).forEach(function (raw) {
                        var r = resolveRef(rel, raw);
                        if (r.skip) return;
                        if (r.outside) { outside++; return; }
                        if (r.rootAbs) { rootAbs++; return; }
                        var target = byRel[r.rel] ? r.rel : (byRel[r.rel + '/index.html'] ? r.rel + '/index.html' : '');
                        if (!target) { missing[r.rel] = 1; return; }
                        if (sel[target]) return;
                        sel[target] = 1;
                        queue.push(target);
                    });
                }
                return step();
            }, function () { return step(); });
        }
        return step().then(function () {
            return { sel: sel, missing: Object.keys(missing).length, outside: outside, rootAbs: rootAbs };
        });
    }

    // ── .md 单文件：渲染成一页文档（复用公网唯一渲染机；不挂文章模板的题头/签章）──
    function buildMdDoc(root, abs, mdText, title) {
        var t = String(title || baseName(abs) || 'document').replace(/[<>&"]/g, function (c) {
            return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
        });
        var payload = JSON.stringify(String(mdText || '')).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
        return '<!doctype html>\n<html lang="zh"><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>' + t + '</title><style>' +
            ':root{color-scheme:light dark}' +
            'body{margin:0;background:#fdfdfb;color:#242424;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}' +
            'main{max-width:820px;margin:0 auto;padding:48px 22px 90px}' +
            'h1,h2,h3,h4{line-height:1.32;margin:1.7em 0 .6em;font-weight:600}' +
            'h1{font-size:1.85em;margin-top:0;padding-bottom:.35em;border-bottom:1px solid #e6e4df}' +
            'h2{font-size:1.42em;padding-bottom:.28em;border-bottom:1px solid #efedE8}' +
            'p,ul,ol,blockquote,table,pre{margin:0 0 1.05em}' +
            'a{color:#b58900;text-decoration:none}a:hover{text-decoration:underline}' +
            'code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:.9em;background:#f1efe9;padding:.14em .38em;border-radius:3px}' +
            'pre{background:#f6f4ee;border:1px solid #e6e4df;border-radius:5px;padding:14px 16px;overflow:auto}' +
            'pre code{background:none;padding:0;font-size:.88em;line-height:1.62}' +
            'blockquote{margin-left:0;padding:.1em 1em;border-left:3px solid #ddd9cf;color:#5a564e}' +
            'table{border-collapse:collapse;width:100%;font-size:.94em}' +
            'th,td{border:1px solid #e2dfd8;padding:7px 10px;text-align:left}th{background:#f6f4ee}' +
            'img{max-width:100%;height:auto}' +
            'hr{border:0;border-top:1px solid #e6e4df;margin:2em 0}' +
            '@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#dcd9d2}a{color:#e0b341}' +
            'h1,h2{border-color:#33322f}code{background:#2a2927}pre{background:#232220;border-color:#33322f}' +
            'blockquote{border-color:#3c3a36;color:#a8a49b}th,td{border-color:#33322f}th{background:#232220}hr{border-color:#33322f}}' +
            '</style></head><body><main id="doc"><pre id="fallback"></pre></main>' +
            '<script type="application/json" id="qqq-md">' + payload + '</script>' +
            '<script src="' + WEB + '/static/docs-md-render.js"></script>' +
            '<script>(function(){var m="";try{m=JSON.parse(document.getElementById("qqq-md").textContent||"\\"\\"")}catch(e){}' +
            'var host=document.getElementById("doc"),fb=document.getElementById("fallback");' +
            'try{if(window.DocsMdRender&&DocsMdRender.render){host.innerHTML=DocsMdRender.render(m);fb=null;}}catch(e){}' +
            'if(fb)fb.textContent=m;})();</script>' +
            '</body></html>';
    }

    // ── 状态 ──
    var st = null;
    var ov = null;

    function resetState() {
        st = {
            phase: 'scan',
            root: '', name: '', entry: '', mode: 'dir', preferred: '',
            files: [], sel: {}, selBytes: 0, truncated: false,
            missing: 0, outside: 0, rootAbs: 0, oversize: 0,
            adv: false, err: '', url: '', id: '', existing: null,
            pct: 0, cur: '', busy: false, confirmRevoke: 0
        };
    }

    // ── API ──
    function api(path, opts) {
        opts = opts || {};
        var tk = token();
        if (!tk) return Promise.reject({ status: 401, code: 'NEED_LOGIN' });
        var headers = opts.headers || {};
        headers['Authorization'] = 'Bearer ' + tk;
        if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        var init = { method: opts.method || 'GET', headers: headers, body: opts.body };
        return fetch(API + path, init).then(function (r) {
            return r.text().then(function (t) { return { r: r, t: t }; });
        }).then(function (x) {
            var j = null;
            try { j = x.t ? JSON.parse(x.t) : null; } catch (_) { }
            if (!x.r.ok || !j || j.ok === false) {
                var e = { status: x.r.status, code: (j && j.code) || ('HTTP ' + x.r.status), payload: j };
                throw e;
            }
            return j;
        });
    }

    function putFile(url, u8, mime, onProgress) {
        return new Promise(function (resolve, reject) {
            var blob = new Blob([u8], { type: mime || 'application/octet-stream' });
            var xhr = new XMLHttpRequest();
            xhr.open('PUT', url, true);
            try { xhr.setRequestHeader('Content-Type', mime || 'application/octet-stream'); } catch (_) { }
            xhr.upload.onprogress = function (ev) {
                if (onProgress && ev.lengthComputable && ev.total) onProgress(ev.loaded / ev.total);
            };
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) resolve(true);
                else reject({ code: 'PUT_' + xhr.status, status: xhr.status });
            };
            xhr.onerror = function () { reject({ code: 'NET', status: 0 }); };
            xhr.send(blob);
        });
    }

    function b64ToU8(b64) {
        var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
        for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
        return u;
    }

    // ══════════════════════════════════════════════
    // 入口：Roam 右键 → 主窗口模态
    // ══════════════════════════════════════════════
    function open(target) {
        if (ov) return;                       // 防重入（已有弹窗就不叠第二个）
        resetState();
        var p = toSlash((target && target.path) || '');
        var isDir = !!(target && target.isDir);
        if (!p) return;
        if (isDir) {
            st.root = p.replace(/\/+$/, '');
            st.name = baseName(st.root) || st.root;
            st.mode = 'dir';
        } else {
            var ext = extOf(p);
            if (ext === '.md' || ext === '.markdown') {
                st.mode = 'doc';
                st.root = dirName(p) || p;
                st.name = baseName(p);
                st.preferred = '';        // doc 模式没有目录入口
            } else if (ext === '.html' || ext === '.htm') {
                st.root = dirName(p) || p;
                st.name = baseName(st.root) || 'site';
                st.mode = 'dir';
                st.preferred = relOf(st.root, p);
            } else {
                return;                   // 其它文件走 bed（不是本模块的活）
            }
        }
        _mount();
        render();
        Promise.all([loadFiles(), loadExisting()]).then(function () {
            if (!st) return;
            st.phase = st.phase === 'error' ? 'error' : 'ready';
            render();
        }, function (e) {
            if (!st) return;
            st.phase = 'error';
            st.err = (e && e.message) || T('deploy.scanFail', '读取目录失败');
            render();
        });
    }

    function loadFiles() {
        var fs = fsApi();
        if (st.mode === 'doc') {
            if (!fs || !fs.read) return Promise.reject(new Error(T('deploy.noBridge', '主进程接口不可用（请重启实例）')));
            var abs = toSlash(st.root).replace(/\/+$/, '') + '/' + st.name;
            return fs.read(abs).then(function (text) {
                if (typeof text !== 'string') throw new Error(T('deploy.mdUnreadable', '读不到这个 Markdown 文件'));
                var html = buildMdDoc(st.root, abs, text, baseName(st.name).replace(/\.(md|markdown)$/i, ''));
                st.files = [{ rel: 'index.html', abs: '', size: 0, ext: '.html', inline: html }];
                st.files[0].size = new TextEncoder().encode(html).length;
                st.entry = 'index.html';
                st.sel = { 'index.html': 1 };
                st.oversize = 0;
                recompute();
            });
        }
        return scanDir(st.root).then(function (res) {
            var fs2 = fsApi();
            // 超上限的单文件：结构性不可发（勾不动），先剔出候选
            var usable = [], oversize = 0, truncated = res.truncated;
            res.files.forEach(function (f) {
                if (f.size > MAX_SITE) { oversize++; return; }
                usable.push(f);
            });
            if (usable.length > MAX_FILES) { usable = usable.slice(0, MAX_FILES); truncated = true; }
            st.files = usable;
            st.truncated = truncated;
            st.oversize = oversize;
            st.entry = pickEntry(usable, st.preferred);
            if (!st.entry) {
                st.phase = 'error';
                st.err = T('deploy.noEntry', '这个目录里没有 .html 文件 —— 发布的是"一个网页"，不是任意目录');
                return;
            }
            return defaultSet(st.root, usable, st.entry).then(function (d) {
                st.sel = d.sel; st.missing = d.missing; st.outside = d.outside; st.rootAbs = d.rootAbs;
                recompute();
            });
        });
    }

    // 是否已发布过这个目录（root_key 精确匹配；服务器是真理源，本地不存任何状态）
    function loadExisting() {
        if (!token()) return Promise.resolve();
        return rootKeyOf(st.root).then(function (rk) {
            st.rootKey = rk;
            if (!rk) return;
            return api('/deploy/mine').then(function (res) {
                var list = (res && res.list) || [];
                for (var i = 0; i < list.length; i++) {
                    var it = list[i];
                    if (it.root_key === rk && !it.revoked && !it.expired) { st.existing = it; return; }
                }
            }, function () { return; });
        });
    }

    function recompute() {
        var n = 0, b = 0;
        st.files.forEach(function (f) {
            if (st.sel[f.rel]) { n++; b += f.size; }
        });
        st.selCount = n;
        st.selBytes = b;
    }

    // ══════════════════════════════════════════════
    // 模态 DOM（内置样式恒定：圆角 6 / 5 / 3，禁原生 modal）
    // ══════════════════════════════════════════════
    function _mount() {
        ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000001;' +
            'display:flex;align-items:center;justify-content:center;';
        var panel = document.createElement('div');
        panel.id = 'qqq-deploy-panel';
        panel.style.cssText = 'width:520px;max-width:92vw;max-height:88vh;display:flex;flex-direction:column;' +
            'box-sizing:border-box;background:var(--background-color,#1e1e1e);color:var(--text-primary,#e8e8e8);' +
            'border:1px solid var(--border-strong,#444);border-radius:6px;box-shadow:0 12px 48px rgba(0,0,0,.5);' +
            'font-size:14px;line-height:1.6;padding:22px 24px 18px;';
        ov.appendChild(panel);
        document.body.appendChild(ov);
        ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
        document.addEventListener('keydown', _onKey, true);
        window.addEventListener('qqq-lang-change', _onLang);
    }

    function _onKey(e) {
        if (e && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
    }
    function _onLang() { if (ov) render(); }

    function close() {
        try { document.removeEventListener('keydown', _onKey, true); } catch (_) { }
        try { window.removeEventListener('qqq-lang-change', _onLang); } catch (_) { }
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        ov = null; st = null;
    }

    function el(tag, css, text) {
        var e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (text != null) e.textContent = text;
        return e;
    }

    var BTN = 'padding:7px 18px;border:1px solid var(--border-strong,#444);border-radius:3px;' +
        'background:transparent;color:var(--text-secondary,#aaa);font-size:13px;cursor:pointer;';
    var BTN_MAIN = 'padding:8px 26px;border:1px solid var(--gold-accent,#b58900);border-radius:3px;' +
        'background:var(--gold-accent,#b58900);color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
    var BTN_OFF = BTN_MAIN + 'opacity:.4;cursor:not-allowed;';

    function render() {
        if (!ov || !st) return;
        var panel = document.getElementById('qqq-deploy-panel');
        if (!panel) return;
        while (panel.firstChild) panel.removeChild(panel.firstChild);

        // 标题行
        var head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;');
        head.appendChild(el('div', 'font-size:15px;font-weight:600;', T('deploy.title', '发布页面')));
        var x = el('div', 'cursor:pointer;color:var(--text-dim,#888);font-size:17px;line-height:1;padding:2px 4px;', '\u00d7');
        x.addEventListener('click', function (e) { e.stopPropagation(); close(); });
        head.appendChild(x);
        panel.appendChild(head);

        if (st.phase === 'scan') {
            panel.appendChild(el('div', 'color:var(--text-secondary,#aaa);padding:12px 0 16px;',
                T('deploy.scanning', '正在读取目录…')));
            return;
        }

        if (st.phase === 'error') {
            var ebox = el('div', 'color:#e07020;padding:6px 0 16px;white-space:pre-line;', st.err || T('deploy.fail', '发布失败'));
            panel.appendChild(ebox);
            panel.appendChild(_rowBtns([{ label: T('common.close', '关闭'), main: false, fn: close }]));
            return;
        }

        if (st.phase === 'done') {
            panel.appendChild(el('div', 'font-size:15px;font-weight:600;color:var(--gold-accent,#b58900);margin-bottom:8px;',
                '\u2713 ' + T('deploy.ok', '已发布')));
            var link = el('div', 'word-break:break-all;user-select:text;padding:8px 10px;border:1px solid var(--border-color,#3a3a3a);' +
                'border-radius:3px;background:rgba(127,127,127,.06);margin-bottom:10px;font-size:13px;', st.url);
            panel.appendChild(link);
            panel.appendChild(el('div', 'color:var(--text-dim,#888);font-size:12px;margin-bottom:16px;',
                T('deploy.expiry', '30 天后自动删除（含全部字节）')));
 			panel.appendChild(_rowBtns([
				{ label: T('common.copy', '复制链接'), main: true, fn: function () { copyLink(); } },
				{ label: T('deploy.open', '打开'), main: false, fn: function () { openUrl(); } },
				{
					label: st.confirmRevoke ? T('deploy.revokeConfirm', '再点一次确认撤销') : T('deploy.revoke', '撤销发布'),
					main: false, danger: !!st.confirmRevoke,
					fn: function () {
						if (!st.confirmRevoke) { st.confirmRevoke = 1; render(); setTimeout(function () { if (st) { st.confirmRevoke = 0; render(); } }, 3000); return; }
						st.confirmRevoke = 0; revoke(st.id, true);
					}
				},
				{ label: T('common.close', '关闭'), main: false, fn: close }
			]));
            return;
        }

        if (st.phase === 'upload') {
            var bar = el('div', 'height:3px;background:rgba(127,127,127,.2);border-radius:3px;overflow:hidden;margin:6px 0 10px;');
            var fill = el('div', 'height:100%;width:' + Math.round((st.pct || 0) * 100) + '%;background:var(--gold-accent,#b58900);transition:width .2s;');
            bar.appendChild(fill);
            panel.appendChild(bar);
            panel.appendChild(el('div', 'color:var(--text-secondary,#aaa);font-size:12.5px;margin-bottom:8px;',
                (st.cur || T('deploy.uploading', '正在上传…')) + '  ' + Math.round((st.pct || 0) * 100) + '%'));
            return;
        }

        // phase = ready：已发布过这个目录 → 直接给管理态
        if (st.existing) {
            panel.appendChild(el('div', 'color:var(--text-secondary,#aaa);font-size:12.5px;margin-bottom:6px;',
                T('deploy.already', '这个文件夹已经发布过了')));
            panel.appendChild(el('div', 'word-break:break-all;user-select:text;padding:8px 10px;border:1px solid var(--border-color,#3a3a3a);' +
                'border-radius:3px;background:rgba(127,127,127,.06);margin-bottom:10px;font-size:13px;', st.existing.url));
            panel.appendChild(el('div', 'color:var(--text-dim,#888);font-size:12px;margin-bottom:16px;',
                T('deploy.expiry', '30 天后自动删除（含全部字节）')));
            var rowEx = _rowBtns([
                { label: T('common.copy', '复制链接'), main: true, fn: function () { copyText(st.existing.url); } },
                { label: T('deploy.open', '打开'), main: false, fn: function () { openExternal(st.existing.url); } },
                { label: st.confirmRevoke ? T('deploy.revokeConfirm', '确认撤销？') : T('deploy.revoke', '撤销发布'), main: false, danger: !!st.confirmRevoke, fn: function () { revoke(st.existing.id, true); } },
                { label: T('common.close', '关闭'), main: false, fn: close }
            ]);
            panel.appendChild(rowEx);
            return;
        }

        // ── 一屏（L0）：目录名 / 一行字节 / 唯一主按钮 / 一行小字 ──
        var pathRow = el('div', 'font-size:13px;word-break:break-all;margin-bottom:4px;');
        var par = dirName(st.root);
        if (par && st.mode !== 'doc') pathRow.appendChild(el('span', 'color:var(--text-dim,#888);', par + '/'));
        pathRow.appendChild(el('span', 'color:var(--text-primary,#e8e8e8);',
            st.mode === 'doc' ? st.name : (baseName(st.root) || st.root)));
        panel.appendChild(pathRow);

        if (st.mode === 'doc') {
            panel.appendChild(el('div', 'color:var(--text-secondary,#aaa);font-size:12.5px;margin-bottom:10px;',
                T('deploy.docMode', '单篇文档 · 渲染成一页')));
        }

        var warnBits = [];
        if (st.missing > 0) warnBits.push(T('deploy.warn404', '{n} 个文件会 404', { n: st.missing }));
        if (st.outside > 0) warnBits.push(T('deploy.warnOutside', '{n} 处引用在目录外', { n: st.outside }));
        if (st.oversize > 0) warnBits.push(T('deploy.warnBig', '{n} 个文件太大', { n: st.oversize }));
        if (st.selBytes > MAX_SITE) warnBits.push(T('deploy.warnOver', '超过 {m} 上限', { m: fmtBytes(MAX_SITE) }));

        var summary = el('div', 'font-size:13px;color:var(--text-secondary,#aaa);margin-bottom:10px;',
            T('deploy.summary', '{n} 个文件 · {s}', { n: st.selCount || 0, s: fmtBytes(st.selBytes || 0) }));
        panel.appendChild(summary);

        if (warnBits.length) {
            var w = el('div', 'cursor:pointer;font-size:12.5px;color:#e07020;margin-bottom:10px;',
                '\u26a0 ' + warnBits[0] + (warnBits.length > 1 ? ' …' : '') + '  \u25b8');
            w.addEventListener('click', function (e) { e.stopPropagation(); st.adv = true; render(); });
            panel.appendChild(w);
        }
        if (st.truncated) {
            panel.appendChild(el('div', 'font-size:12px;color:var(--text-dim,#888);margin-bottom:10px;',
                T('deploy.truncated', '目录很大，只列出了前 {n} 个文件（可手动勾选）', { n: MAX_FILES })));
        }

        // 高级（点开才出现）：文件清单
        if (st.adv) {
            panel.appendChild(_fileList());
        }

        var canPublish = (st.selCount > 0) && st.selBytes <= MAX_SITE;
        var btns = [{
            label: T('deploy.publish', '发布'), main: true, off: !canPublish,
            fn: function () { if (canPublish) publish(); }
        }, {
            label: st.adv ? T('deploy.advHide', '收起') : T('deploy.adv', '高级'), main: false,
            fn: function () { st.adv = !st.adv; render(); }
        }];
        panel.appendChild(_rowBtns(btns, true));

        panel.appendChild(el('div', 'font-size:12px;color:var(--text-dim,#888);margin-top:2px;',
            T('deploy.expiry', '30 天后自动删除（含全部字节）')));
    }

    function _fileList() {
        var wrap = el('div', 'border:1px solid var(--border-color,#3a3a3a);border-radius:5px;max-height:34vh;overflow:auto;' +
            'margin-bottom:12px;background:rgba(127,127,127,.04);');
        var head = el('div', 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;' +
            'border-bottom:1px solid var(--border-color,#3a3a3a);font-size:12px;color:var(--text-dim,#888);');
        head.appendChild(el('span', '', T('deploy.files', '文件清单')));
        var all = el('span', 'cursor:pointer;', T('deploy.toggleAll', '全选 / 反选'));
        all.addEventListener('click', function (e) {
            e.stopPropagation();
            var allOn = st.selCount === st.files.length;
            st.sel = {};
            if (!allOn) st.files.forEach(function (f) { st.sel[f.rel] = 1; });
            recompute(); render();
        });
        head.appendChild(all);
        wrap.appendChild(head);

        st.files.forEach(function (f) {
            var on = !!st.sel[f.rel];
            var row = el('div', 'display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:12.5px;cursor:pointer;' +
                (on ? '' : 'opacity:.5;'));
            var box = el('span', 'width:12px;flex:0 0 12px;text-align:center;', on ? '\u2713' : '\u00a0');
            row.appendChild(box);
            var nm = el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', f.rel);
            row.appendChild(nm);
            if (f.rel === st.entry) row.appendChild(el('span', 'flex:0 0 auto;color:var(--gold-accent,#b58900);font-size:11px;', 'ENTRY'));
            row.appendChild(el('span', 'flex:0 0 auto;color:var(--text-dim,#888);font-size:11.5px;', fmtBytes(f.size)));
            row.addEventListener('click', function (e) {
                e.stopPropagation();
                if (f.rel === st.entry) return;      // 入口必发（它不在 = 没有页面）
                if (st.sel[f.rel]) delete st.sel[f.rel]; else st.sel[f.rel] = 1;
                recompute(); render();
            });
            wrap.appendChild(row);
        });
        if (!st.files.length) wrap.appendChild(el('div', 'padding:10px;color:var(--text-dim,#888);', T('deploy.noFiles', '没有可发布的文件')));
        return wrap;
    }

    function _rowBtns(list, withGap) {
        var row = el('div', 'display:flex;justify-content:flex-end;gap:10px;' + (withGap ? 'margin:14px 0 10px;' : ''));
        list.forEach(function (b) {
            var btn = el('button', b.main ? (b.off ? BTN_OFF : BTN_MAIN) : (BTN + (b.danger ? 'border-color:#e07020;color:#e07020;' : '')), b.label);
            btn.type = 'button';
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (b.off) return;
                b.fn();
            });
            row.appendChild(btn);
        });
        return row;
    }

    // ══════════════════════════════════════════════
    // 发布（reserve → 逐文件 PUT → create）
    // ══════════════════════════════════════════════
    function publish() {
        if (st.busy) return;
        if (!token()) {
            st.phase = 'error';
            st.err = T('deploy.needLogin', '请先登录 qd 账号（发布需要归属一个账号）');
            render();
            return;
        }
        var fs = fsApi();
        if (!fs || !fs.readBase64) {
            st.phase = 'error'; st.err = T('deploy.noBridge', '主进程接口不可用（请重启实例）'); render();
            return;
        }
        st.busy = true;
        st.phase = 'upload';
        st.pct = 0;
        st.cur = T('deploy.reading', '正在读取文件…');
        render();

        // 顺序：入口在前（进度观感 + 失败早停）
        var list = st.files.filter(function (f) { return st.sel[f.rel]; });
        list.sort(function (a, b) {
            if (a.rel === st.entry) return -1;
            if (b.rel === st.entry) return 1;
            return a.rel < b.rel ? -1 : 1;
        });

        var ready = [];
        var seq = Promise.resolve();
        list.forEach(function (f) {
            seq = seq.then(function () {
                if (f.inline != null) {
                    var u8 = new TextEncoder().encode(f.inline);
                    ready.push({ rel: f.rel, u8: u8, size: u8.length, mime: 'text/html; charset=utf-8' });
                    return;
                }
                return fs.readBase64(f.abs).then(function (b64) {
                    if (!b64) throw { code: 'READ_FAIL', rel: f.rel };
                    var u8 = b64ToU8(b64);
                    ready.push({ rel: f.rel, u8: u8, size: u8.length, mime: mimeOfRel(f.rel) });
                });
            });
        });

		// 模态可能在任意阶段被关掉（Esc / 遮罩）——后续回调一律先验活，禁向已销毁的状态写
		function alive() { if (!st) throw { code: 'ABORTED' }; }

		var siteId = '';
		seq.then(function () {
			alive();
			if (!ready.length) throw { code: 'EMPTY' };
            st.cur = T('deploy.reserving', '正在准备上传…');
            st.pct = 0.02;
            render();
            return rootKeyOf(st.root).then(function (rk) {
                return api('/deploy/reserve', {
                    method: 'POST',
                    body: JSON.stringify({
                        name: st.mode === 'doc' ? st.name : (baseName(st.root) || st.name),
                        root_key: rk || '',
                        entry: st.entry,
                        kind: st.mode === 'doc' ? 'doc' : 'dir',
                        tier: 'trial',
                        files: ready.map(function (r) { return { path: r.rel, bytes: r.size }; })
                    })
                });
 			}).then(function (res) {
				alive();
				siteId = res.id;
                var slots = (res && res.files) || [];
                var byPath = {};
                slots.forEach(function (s) { byPath[s.path] = s; });
                var done = 0;
                var chain = Promise.resolve();
 				ready.forEach(function (r) {
					chain = chain.then(function () {
						alive();
						var slot = byPath[r.rel];
                        if (!slot) throw { code: 'NO_SLOT', rel: r.rel };
                        st.cur = T('deploy.uploadingFile', '正在上传 {n}', { n: r.rel });
                        return putFile(slot.put_url, r.u8, r.mime, function (p) {
                            st.pct = (done + p) / ready.length * 0.96 + 0.02;
                            render();
                        }).then(function () {
                            done++;
                            st.pct = done / ready.length * 0.96 + 0.02;
                            render();
                        }, function (e) {
                            throw { code: (e && e.code) || 'PUT', rel: r.rel };
                        });
                    });
                });
 				return chain;
			}).then(function () {
				alive();
				st.cur = T('deploy.finishing', '正在完成…');
                st.pct = 0.99;
                render();
                return api('/deploy/create', { method: 'POST', body: JSON.stringify({ id: siteId, tier: 'trial' }) });
 			}).then(function (res) {
				if (!st) return;
				st.busy = false;
				st.phase = 'done';
                st.id = res.id;
                st.url = res.url;
                st.existing = null;
                render();
            });
 		}).catch(function (e) {
			if (!st || (e && e.code === 'ABORTED')) return;
			st.busy = false;
			st.phase = 'error';
			st.err = explainErr(e, siteId);
			render();
		});
	}

	function mimeOfRel(rel) {
        var e = extOf(rel);
        var m = {
            '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
            '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
            '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
            '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
            '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
            '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
            '.pdf': 'application/pdf'
        };
        return m[e] || 'application/octet-stream';
    }

    // 失败必须说人话（禁只说「失败」）
    function explainErr(e, siteId) {
        var c = (e && e.code) || '';
        if (c === 'NEED_LOGIN') return T('deploy.needLogin', '请先登录 qd 账号（发布需要归属一个账号）');
        if (c === 'NET' || (e && e.status === 0)) return T('deploy.netFail', '网络中断，页面没有发布成功（可重试）');
        if (c === 'READ_FAIL') return T('deploy.readFail', '读不到文件：{f}', { f: (e && e.rel) || '' });
        if (c === 'PUT' || /^PUT_/.test(c)) return T('deploy.putFail', '上传失败：{f}（可重试）', { f: (e && e.rel) || '' });
        if (c === 'QUOTA_EXCEEDED') return T('deploy.quota', '免费额度已满（在架 2 页 / 每天 5 页）——撤销一个旧页面再发');
        if (c === 'BYTES_QUOTA') return T('deploy.bytesQuota', '在架字节额度已满——先撤销一个旧页面');
        if (c === 'PAGE_TOO_LARGE') return T('deploy.tooLarge', '这个页面超过 {m}（单页上限）', { m: fmtBytes(MAX_SITE) });
        if (c === 'FILE_TOO_LARGE') return T('deploy.fileTooLarge', '有单个文件超过上限');
        if (c === 'FILE_MISSING') return T('deploy.fileMissing', '有文件没传成功：{f}', { f: ((e.payload && e.payload.path) || '') });
        if (c === 'BAD_ENTRY') return T('deploy.noEntry', '这个目录里没有 .html 文件 —— 发布的是"一个网页"，不是任意目录');
        if (e && e.status === 402) return T('deploy.noBalance', '余额不足');
        return T('deploy.failDetail', '发布失败：{c}', { c: c || 'unknown' });
    }

    // ── 撤销（第一次点击 = 待确认，3 秒后回落；禁静默真删）──
    function revoke(id, fromExisting) {
        var targetId = id || st.id;
        if (!targetId) return;
        if (!fromExisting && !st.confirmRevoke) {
            st.confirmRevoke = 1;
            render();
            setTimeout(function () { if (st) { st.confirmRevoke = 0; render(); } }, 3000);
            return;
        }
 		api('/deploy/revoke', { method: 'POST', body: JSON.stringify({ id: targetId, purge: true }) }).then(function () {
			if (!st) return;
			qoast(T('deploy.revoked', '已撤销（30 秒内全网失效）'), 'info');
            st.existing = null; st.confirmRevoke = 0;
            if (st.phase === 'done') { st.phase = 'ready'; st.url = ''; st.id = ''; }
            if (!st.files.length) { close(); return; }
            render();
 		}, function (e) {
			if (!st) return;
			st.phase = 'error';
			st.err = T('deploy.revokeFail', '撤销失败：{c}', { c: (e && e.code) || 'unknown' });
			render();
		});
    }

    function copyLink() { copyText(st.url); }
    function copyText(txt) {
        try {
            var b = bridge();
            if (b && b.clipboard && b.clipboard.writeText) {
                b.clipboard.writeText(txt);
                qoast(T('common.copied', '已复制'), 'info');
                return;
            }
        } catch (_) { }
        try { navigator.clipboard.writeText(txt); qoast(T('common.copied', '已复制'), 'info'); } catch (_) { }
    }
    function openUrl() { openExternal(st.url); }
    function openExternal(u) {
        try {
            var b = bridge();
            if (b && b.openExternal) { b.openExternal(u); return; }
        } catch (_) { }
        try { window.open(u, '_blank'); } catch (_) { }
    }

    // 页面里点「在 bed 取链接」时用（唯一去处：goods 网页，禁在 qd 再造第二个上传器）
    function openBed() { openExternal('https://www.gh555.com/gaea/d/bed?lang=zh&folder=inbox'); }

    window.qqqPageDeploy = { open: open, openBed: openBed };
})();
