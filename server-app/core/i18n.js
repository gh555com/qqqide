// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

/**
 * i18n 国际化运行时 — qqq-shell-v2 唯一真理机器
 *
 * 支持 13 语言：zh, zh-tw, en, ja, de, ko, ru, ar, es, fr, pt-BR, hi, vi
 * 唯一真理源：server-app/locales/zh.json（开发者只写中文）
 *
 * HTML 占位符：
 *   <span data-i18n="key">中文</span>           — textContent
 *   <input data-i18n-placeholder="key" placeholder="搜索">  — placeholder
 *   <button data-i18n-title="key" title="关闭">            — title
 *   <div data-i18n-html="key"></div>                       — innerHTML（富文本）
 *   <span data-i18n="key" data-i18n-params="n=5,name=qqq"> — 插值
 *
 * JS API：
 *   i18n.t('common.close')              → "关闭" / "Close"
 *   i18n.t('time.ago', {n: 5})          → "5 分钟前" / "5 minutes ago"
 *   i18n.setLang('en')                  → 切换语言 + 更新 DOM
 *   i18n.getLang()                      → 当前语言代码
 *   i18n.updateDom(root)                → 扫描并更新 data-i18n 元素
 *
 * 全局快捷: window._i(key, fallback) → i18n.t(key) || fallback
 *
 * 语言检测：qgs('qqq.i18n') 持久化 → navigator.language → 'en' 默认
 * 英语内嵌兜底：en.json 所有 key 内嵌，离线永不显示占位符
 */
const i18n = (function () {
    'use strict';

    // ── locales 基础路径：相对当前脚本 core/i18n.js 计算，避免 base URL 问题 ──
    var _LOCALES_BASE = 'locales/';
    (function () {
        try {
            var s = document.currentScript && document.currentScript.src;
            if (s) {
                var idx = s.lastIndexOf('/core/i18n.js');
                if (idx >= 0) { _LOCALES_BASE = s.substring(0, idx) + '/locales/'; }
            }
        } catch (_) { }
    })();

    // ── 13 语言 ──
    const ALL_LANGS = ['zh', 'zh-tw', 'en', 'ja', 'de', 'ko', 'ru', 'ar', 'es', 'fr', 'pt-BR', 'hi', 'vi'];
    const LANG_ENABLED = {
        'zh': true, 'zh-tw': true, 'en': true, 'ja': true, 'de': true,
        'ko': true, 'ru': true, 'ar': true, 'es': true, 'fr': true,
        'pt-BR': true, 'hi': true, 'vi': true
    };
    const ENABLED_LANGS = ALL_LANGS.filter(function (l) { return LANG_ENABLED[l]; });

    const LANG_NAMES = {
        'zh': '简体中文', 'zh-tw': '繁體中文', 'en': 'English', 'ja': '日本語',
        'de': 'Deutsch', 'ko': '한국어', 'ru': 'Русский', 'ar': 'العربية',
        'es': 'Español', 'fr': 'Français', 'pt-BR': 'Português',
        'hi': 'हिन्दी', 'vi': 'Tiếng Việt'
    };

    // ── 英语内嵌兜底 ──
    // 由 op/qky.py 翻译后 sync_en_builtin() 自动替换
    var _EN_BUILTIN = {"common":{"close":"Close","confirm":"Confirm","cancel":"Cancel","search":"Search","copy":"Copy","delete":"Delete","save":"Save","retry":"Retry","error":"Error","ok":"OK","yes":"Yes","no":"No","loading":"Loading...","copied":"Copied","failed":"Failed","more":"More","back":"Back","next":"Next","open":"Open","edit":"Edit","rename":"Rename","download":"Download","refresh":"Refresh","preview":"Preview","unknown":"Unknown","enabled":"Enabled","disabled":"Disabled","on":"On","off":"Off","seconds":"Seconds","minutes":"Minutes","hours":"Hours","bytes":"Bytes","kb":"KB","mb":"MB","gb":"GB"},"shell":{"title":"qqq","menu":{"file":"File","fileNew":"New","fileOpen":"Open","fileNewWindow":"New Window","fileExit":"Exit","tools":"Tools","devTools":"Developer Tools"},"window":{"minimize":"Minimize","maximize":"Maximize","restore":"Restore","close":"Close"},"zoom":{"in":"Zoom In (Ctrl+=)","out":"Zoom Out (Ctrl+-)","reset":"Reset Zoom"},"theme":{"toggle":"Toggle Light/Dark Mode","switchToLight":"Switch to Light Mode","switchToDark":"Switch to Dark Mode"},"lang":{"switch":"Switch Language"},"status":{"version":"Version","engineOn":"Engine Online","engineOff":"Engine Offline"},"output":{"title":"Output","hide":"Hide Output"},"update":{"check":"Check for Updates","updatedTo":"Updated to {version}. Reloading...","failed":"Update Failed","failedWith":"Update Failed","newVersion":"New version {latest} available (current: {current})"},"overlay":{"copy":"Copy to Clipboard","copied":"Copied","copyFailed":"Copy Failed","zoomIn":"Zoom In","zoomOut":"Zoom Out","close":"Close (Esc or Right-Click)","resetPosition":"Reset Position"},"about":{"title":"About qqq","version":"qqq-shell v2","desc":"Portable / Win7+ / Server Hot Update"},"tab":{"openRight":"Open Another on Right","openLeft":"Open Another on Left"},"viewport":{"mainFolder":"Main Folder (Cannot be removed)","removeProject":"Remove This Project","addProject":"Add Project Folder to AI Viewport","selectFolder":"Select Folder to Add to AI Viewport","searchFolder":"Search This Folder","recentFolders":"Recently Opened Main Folders","noRecent":"No recent history. Click + to select a folder.","editx":"Edit File","openInOs":"Open in System","timeline":"Timeline","copyPath":"Copy Path"},"dev":"Dev Mode","gaeaHostLoading":"Loading gaea host...","free":{"active":"💎 Free Tier Active","ending":"🎈 Free Tier Ending Soon","soonPrefix":"🤍 Time Until Next Free Tier"}},"editor":{"minimap":"Minimap","tabs":{"close":"Close Tab","closeOthers":"Close Other Tabs","closeRight":"Close Tabs to the Right","closeAll":"Close All Tabs","closeSaved":"Close Saved Tabs","revealInExplorer":"Reveal in File Explorer","copyPath":"Copy Path","copyRelativePath":"Copy Relative Path","splitRight":"Split Right","splitDown":"Split Down"},"contextMenu":{"cut":"Cut","copy":"Copy","paste":"Paste","selectAll":"Select All","undo":"Undo","redo":"Redo","feedToAi":"📎 Feed to AI"},"undo":"Undo (Ctrl+Z)","redo":"Redo (Ctrl+Y)","unsaved":"Unsaved","saved":"Saved","saving":"Saving...","saveFailed":"Save Failed","fileTooLarge":"File Too Large","binaryFile":"Binary file, cannot edit","line":"Line","col":"Col","spaces":"Spaces","indent":"Indent","encoding":"Encoding","eol":"EOL","language":"Language","readOnly":"Read-only","codelens":{"openFile":"Open File","openFolder":"Open Folder","copyPath":"Copy Path","copyImage":"Copy Image Binary"}},"login":{"title":"Login","waiting":"Waiting for browser login...","success":"Login Successful","timeout":"Login timed out, please try again","loggedOut":"Logged out"},"ai":{"title":"AI","send":"Send","stop":"Stop","guide":"Guide","queue":{"full":"Queue limit is 3. Please wait for the previous message to be sent.","save":"Save","delete":"Delete","cancel":"Cancel","pause":"Pause","resume":"Resume","clear":"Clear","header":"Queue","editTitle":"Click to edit or delete"},"context":"Context","compress":"Compress","snap":"Snapshot","error":{"continueTask":"Continue Task","noActiveAgent":"Please send a message first to create a conversation","buildingFloor":"AI is currently building the floor. Please wait for the current floor to complete before compressing."},"compressing":"🧠 Compressing...","compressSuccess":"✅ Compression complete","compressFail":"✗ Compression failed","ctx":{"title":"You can choose to compress the context","benefit":"Benefits:","benefitText":"Reduces costs from the next conversation onwards; helps AI focus more on the current problem and reduces hallucinations.","cost":"Costs:","costText":"Conversations prior to the last six floors will be compressed, losing details, with AI retaining only summaries. The last six floors will be preserved in full.","whatIf":"What if I never manually compress?","auto":"qqqide automatically compresses using an optimal strategy, which is usually better than manual compression.","noLoss":"Regardless of whether you compress or who performs the compression, it will neither overflow AI memory nor cause memory loss.","compress":"Compress","snap":"Snapshot","breakdown":"Context Usage","used":"Used","free":"Free","snapOk":"Snapshot saved","snapFail":"Failed to save snapshot"},"inputPlaceholder":"Ask qqq AI... (Ctrl+V to paste image)","inputLimitWarn":"Input limit reached (58KB). Cannot type further.","embedImage":"Embed","level":{"a":"Conservative","1":"Light","2":"Medium","3":"Smart","4":"Strong","5":"Extreme","6":"Pro Max"},"floor":"Floor","house":"House","room":"Room","ttfb":"Network Wait","work":"Work Time","total":"Total","tokens":"Token Usage","confirmConnect":"Confirm Connection","thinking":"Thinking...","streaming":"Generating...","tools":{"readFile":"Read File","editFile":"Edit File","createFile":"Create File","deleteFile":"Delete File","writeFile":"Write File","searchText":"Search Text","findFiles":"Find Files","listFiles":"List Files","getDiagnostics":"Get Diagnostics","runCommand":"Run Command","fetchWebpage":"Fetch Webpage","getVision":"Get Visual Context"},"output":{"empty":"Waiting for input...","compressInProgress":"Compressing...","compressDone":"Compression complete","tokenLimit":"Token limit reached"},"rules":{"title":"Project Rules","edit":"Edit Rules","empty":"No rules yet","globalRule":"Global Rules (.qqq-rules.txt)","projectRule":"Project Rules (project.txt)"},"quest":{"switch":"Switch Project","newQuest":"New Chat","history":"History","noHistory":"No history yet","saveFailed":"Save failed"},"lock":{"locked":"Project is already open in another window","stale":"Lock expired","heartbeat":"Heartbeat"},"onboarding":{"selectFolder":"Please select a root folder first!","selectFolderTitle":"Select a Root Folder"},"guideBtnTooltip":"Guide AI with the current message without starting a new turn!","billing":{"number":"ID","type":"Type","toolCount":"Tool Count","time":"Time Spent","wge":"wge","aiLv":"AI Level","cacheHit":"Cache Hit Rate","promptTokens":"prompt_tokens","completionTokens":"completion_tokens","totalTokens":"total_tokens","receipt":"Billing Receipt (10,000 wge = 1 ge)","title":"Billing Details"}},"goods":{"bar":{"title":"Feature Toggle"},"fileExplorer":{"title":"File Explorer","openFile":"Open File","openInIde":"Open in IDE","refresh":"Refresh Directory","parentDir":"Parent Directory","name":"Name","size":"Size","modified":"Modified","type":"Type","folder":"Folder","file":"File","empty":"Empty Directory","loading":"Loading...","loadFailed":"Load failed","noAccess":"No access"},"navigator":{"title":"Navigation","explorer":"Explorer","search":"Search files","openEditors":"Open Editors","outline":"Outline","timeline":"Timeline","inputPlaceholder":"Type path segments, Enter to open / Esc to close","noRecent":"No recent files yet. Open some files in the file tree first.","noMatch":"No matches found"},"pasteImage":{"title":"Paste Image","pasteHint":"Ctrl+V to paste image","pasting":"Pasting...","pasteOk":"Image pasted","pasteFailed":"Paste failed","saveFailed":"Failed to save pasted image","saved":"Image saved to","noImage":"No image in clipboard"},"wysiwyg":{"title":"WYSIWYG","bold":"Bold","italic":"Italic","underline":"Underline","strikethrough":"Strikethrough","heading":"Heading","paragraph":"Paragraph","list":"List","orderedList":"Ordered List","quote":"Quote","code":"Code","link":"Link","image":"Image","table":"Table","horizontalRule":"Horizontal Rule","clearFormat":"Clear Formatting","undo":"Undo","redo":"Redo"},"rage":{"title":"Clipboard","clip":{"title":"Clipboard History","empty":"No clipboard content","search":"Search clipboard...","pin":"Pin","unpin":"Unpin","delete":"Delete","clearAll":"Clear All","count":"{n} items","text":"Text","image":"Image","html":"Rich Text","link":"Link","file":"File","unknown":"Unknown type"},"captain":{"paste":"Paste","roam":"Roam","video":"Video","weave":"Weave","exportDoc":"Export Document","pure":"Pure","exportZip":"Export ZIP","audio":"Audio"},"search":{"hint":"Search with multiple keywords (AND)","noResults":"No matching results"}}},"dialog":{"about":{"title":"About qqq","message":"qqq-shell v2","detail":"Portable / Win7+ / Server Hot Update"},"confirmDelete":{"title":"Confirm Deletion","message":"Are you sure you want to delete? This action cannot be undone."},"unsaved":{"title":"Unsaved Changes","message":"There are unsaved changes. Do you want to save before closing?","save":"Save","discard":"Discard","cancel":"Cancel"}},"shortcuts":{"ctrlS":"Save","ctrlZ":"Undo","ctrlShiftZ":"Redo","ctrlX":"Cut","ctrlC":"Copy","ctrlV":"Paste","ctrlA":"Select All","ctrlF":"Find","ctrlH":"Replace","ctrlN":"New File","ctrlO":"Open File","ctrlW":"Close Tab","ctrlShiftE":"Show File Explorer","ctrlShiftF":"Search Files","ctrlBackslash":"Split Right","ctrlPlus":"Zoom In","ctrlMinus":"Zoom Out","ctrl0":"Reset Zoom","f12":"Developer Tools","f1":"Command Palette","altLeft":"Back","altRight":"Forward"},"wings":{"redrawing":"Redrawing"},"timeline":{"filePathPlaceholder":"File path…","searchHistory":"Search History","dragHandle":"Drag to move window","maximize":"Maximize","full":"📋 Full Text","diff":"📌 Diff","acceptLeft":"← Move to Right","save":"💾 Save","changes":"{n} change(s)","modeFull":"Full Text","modeDiff":"Diff","loading":"Loading…","noVersions":"No historical versions for this file","missingParams":"Missing parameters","loadingVersions":"Loading version list…","monacoTimeout":"Monaco load timed out. Please check your network or restart the window.","monacoFailed":"Monaco failed to load","saved":"Saved","saveFailed":"Save failed","copyRow":"Copy this line","closeHint":"= Right-click to close","diffOnly":"Diff Only","editBtn":"Edit","cancelEdit":"Cancel Edit","editTooltip":"Edit the latest file on disk (not any historical snapshot)","editTooltipExit":"Changes are not saved automatically when exiting edit mode","editing":"Editing","unsaved":"Unsaved","snapshot":"📸 Take Snapshot","snapUnchanged":"Content unchanged; no snapshot needed","snapping":"Taking snapshot…","snapOk":"Snapshot #{seq} taken at {time} diff edit","snapNoNew":"No new snapshot generated; content may be unchanged or in cooldown period","snapFailed":"Failed to take snapshot"}};

    // ── 状态 ──
    var _cache = {};
    var _currentLang = null;
    var _loading = null;
    var _i18nState = null; // qgs handle, set lazily

    function _getState() {
        if (!_i18nState) {
            try {
                if (window.qgs) { _i18nState = window.qgs('qqq.i18n'); }
            } catch (e) { /* ignore */ }
        }
        return _i18nState;
    }

    // ── OS 语言映射 ──
    function mapOsLang(osLang) {
        if (!osLang) return null;
        var lang = osLang.toLowerCase();
        var mapped = null;
        if (lang === 'zh-cn' || lang === 'zh-hans' || lang === 'zh-hans-cn') {
            mapped = 'zh';
        } else if (lang === 'zh-tw' || lang === 'zh-hant' || lang === 'zh-hant-tw' || lang === 'zh-hk') {
            mapped = 'zh-tw';
        } else if (lang === 'pt-br') {
            mapped = 'pt-BR';
        } else {
            var prefix = lang.split('-')[0];
            if (ALL_LANGS.indexOf(prefix) !== -1) {
                mapped = prefix;
            } else if (prefix === 'zh') {
                mapped = 'zh';
            }
        }
        return (mapped && LANG_ENABLED[mapped]) ? mapped : null;
    }

    // ── 语言检测 ──
    function detectLang() {
        // 1. qgs 持久化偏好（跨会话）
        try {
            var st = _getState();
            if (st) {
                var persisted = st.get('lang');
                // qgs get 可能是同步也可能是异步，尽力而为
                if (persisted && typeof persisted === 'string' && LANG_ENABLED[persisted]) {
                    return persisted;
                }
            }
        } catch (e) { /* ignore */ }

        // 2. 浏览器/OS 语言
        var browserLang = (navigator.language || navigator.userLanguage || '');
        var mapped = mapOsLang(browserLang);
        if (mapped) return mapped;

        // 3. 默认英语
        return 'en';
    }

    // ── 加载语言文件 ──
    function loadLang(lang) {
        if (_cache[lang]) return Promise.resolve(_cache[lang]);

        // 英语优先尝试内嵌兜底
        if (lang === 'en' && Object.keys(_EN_BUILTIN).length > 0) {
            _cache['en'] = _EN_BUILTIN;
            return Promise.resolve(_EN_BUILTIN);
        }

        return fetch(_LOCALES_BASE + lang + '.json')
            .then(function (resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.json();
            })
            .then(function (data) {
                _cache[lang] = data;
                return data;
            })
            .catch(function (e) {
                console.warn('[i18n] Failed to load ' + lang + '.json:', e && e.message);
                // 英语内嵌兜底永远可用
                if (lang === 'en' && Object.keys(_EN_BUILTIN).length > 0) {
                    _cache['en'] = _EN_BUILTIN;
                    return _EN_BUILTIN;
                }
                return null;
            });
    }

    // ── 嵌套取值 ──
    function getNested(obj, path) {
        if (!obj || !path) return null;
        var keys = path.split('.');
        var cur = obj;
        for (var i = 0; i < keys.length; i++) {
            if (cur === null || cur === undefined) return null;
            cur = cur[keys[i]];
        }
        return cur;
    }

    // ── 核心翻译函数 ──
    function t(key, params) {
        if (!key) return '';

        // 当前语言 → 英文 → 返回 key
        var data = _cache[_currentLang];
        var text = getNested(data, key);

        if ((text === null || text === undefined) && _currentLang !== 'en') {
            var enData = _cache['en'] || _EN_BUILTIN;
            text = getNested(enData, key);
        }

        if (text === null || text === undefined) {
            console.warn('[i18n] Missing: ' + key + ' (' + _currentLang + ')');
            return key;
        }

        // 插值 {name} → value
        if (params && typeof text === 'string') {
            Object.keys(params).forEach(function (k) {
                text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
            });
        }

        return text;
    }

    // ── 切换语言 ──
    function setLang(lang, reload) {
        if (!LANG_ENABLED[lang]) {
            console.warn('[i18n] Language not enabled: ' + lang);
            return Promise.resolve();
        }

        // 持久化到 qgs
        try {
            var st = _getState();
            if (st && st.set) { st.set('lang', lang); }
        } catch (e) { /* ignore */ }

        _currentLang = lang;

        return loadLang(lang).then(function () {
            updateDom();
            _notifyIframes(lang);
        });
    }

    // ── 获取当前语言 ──
    function getLang() {
        return _currentLang || detectLang();
    }

    // ── 解析 data-i18n-params ──
    function parseParams(str) {
        if (!str) return {};
        var params = {};
        str.split(',').forEach(function (pair) {
            var parts = pair.split('=');
            if (parts[0] && parts[1] !== undefined) {
                params[parts[0].trim()] = parts[1].trim();
            }
        });
        return params;
    }

    // ── 更新 DOM ──
    function updateDom(root) {
        root = root || document;

        // data-i18n → textContent
        var els = root.querySelectorAll('[data-i18n]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var key = el.getAttribute('data-i18n');
            var paramsStr = el.getAttribute('data-i18n-params');
            var params = parseParams(paramsStr);
            if (key) {
                if (el.hasAttribute('data-i18n-html')) {
                    el.innerHTML = t(key, params);
                } else {
                    el.textContent = t(key, params);
                }
            }
        }

        // data-i18n-placeholder → placeholder
        var phEls = root.querySelectorAll('[data-i18n-placeholder]');
        for (var j = 0; j < phEls.length; j++) {
            var phEl = phEls[j];
            var phKey = phEl.getAttribute('data-i18n-placeholder');
            if (phKey) phEl.placeholder = t(phKey);
        }

        // data-i18n-title → title
        var tEls = root.querySelectorAll('[data-i18n-title]');
        for (var k = 0; k < tEls.length; k++) {
            var tEl = tEls[k];
            var tKey = tEl.getAttribute('data-i18n-title');
            if (tKey) tEl.title = t(tKey);
        }
    }

    // ── 获取支持的语言 ──
    function getSupportedLangs() {
        return ENABLED_LANGS.slice();
    }

    function getLangName(lang) {
        return LANG_NAMES[lang] || lang;
    }

    // ── 通知 iframe 语言变更 ──
    function _notifyIframes(lang) {
        try {
            window.dispatchEvent(new CustomEvent('qqq-lang-change', { detail: { lang: lang } }));
            var aiFrame = document.querySelector('#qqq-ai-zone iframe');
            if (aiFrame && aiFrame.contentWindow) {
                aiFrame.contentWindow.postMessage({ type: 'qqq-lang-change', lang: lang }, '*');
            }
            // 也通知左右翼面板
            var wings = document.querySelectorAll('.qqq-wing iframe');
            for (var i = 0; i < wings.length; i++) {
                if (wings[i] && wings[i].contentWindow) {
                    wings[i].contentWindow.postMessage({ type: 'qqq-lang-change', lang: lang }, '*');
                }
            }
        } catch (e) { /* ignore cross-origin restrictions */ }
    }

    // ── 初始化 ──
    function init() {
        if (_loading) return _loading;

        _loading = (function () {
            _currentLang = detectLang();
            return loadLang(_currentLang).then(function () {
                if (document.readyState === 'loading') {
                    return new Promise(function (resolve) {
                        document.addEventListener('DOMContentLoaded', function () {
                            updateDom();
                            _notifyIframes(_currentLang);
                            resolve(_currentLang);
                        });
                    });
                } else {
                    updateDom();
                    _notifyIframes(_currentLang);
                    return _currentLang;
                }
            });
        })();

        return _loading;
    }

    // ── 自动初始化 ──
    init();

    // ── 导出 ──
    var api = {
        t: t,
        setLang: setLang,
        getLang: getLang,
        updateDom: updateDom,
        getSupportedLangs: getSupportedLangs,
        getLangName: getLangName,
        init: init,
        _detectLang: detectLang,
        _mapOsLang: mapOsLang
    };

    window.i18n = api;

    // 全局快捷: _i('key', 'fallback')
    window._i = function (key, fallback) {
        var result = t(key);
        return (result !== key) ? result : (fallback || key);
    };

    return api;
})();
