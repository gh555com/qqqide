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
 * ★ 语言决议（2026-09-16 重做）：localStorage 同步镜像 → qgs.simple('qqq.i18n') 权威库（异步）
 *   → OS 语言 navigator.language → 'en' 兜底。首启 = OS 检测结果双通道落盘（= 用户偏好默认
 *   语言），此后启动恒沿用，直到用户手动切换（手动切换同样双通道落盘）。
 *   旧机制（window.qgs('ns') 同步调用）为死代码：qgs 是对象非函数 → TypeError 被吞 → 从未生效。
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
    var _EN_BUILTIN = {"common":{"close":"Close","confirm":"Confirm","cancel":"Cancel","search":"Search","copy":"Copy","delete":"Delete","save":"Save","retry":"Retry","error":"Error","ok":"OK","yes":"Yes","no":"No","loading":"Loading...","copied":"Copied","failed":"Failed","more":"More","back":"Back","next":"Next","open":"Open","edit":"Edit","rename":"Rename","download":"Download","refresh":"Refresh","preview":"Preview","unknown":"Unknown","enabled":"Enabled","disabled":"Disabled","on":"On","off":"Off","seconds":"Seconds","minutes":"Minutes","hours":"Hours","bytes":"Bytes","kb":"KB","mb":"MB","gb":"GB"},"shell":{"title":"qqq","menu":{"file":"File","fileNew":"New","fileOpen":"Open","fileNewWindow":"New Window","fileExit":"Exit","tools":"Tools","devTools":"Developer Tools","activate":"Activate","activated":"Activated","evangelist":"Mentor","lockedHint":"⚠️ This item is already open in another window. Please use that window directly, or close it before opening here."},"window":{"minimize":"Minimize","maximize":"Maximize","restore":"Restore","close":"Close"},"zoom":{"in":"Zoom In (Ctrl+=)","out":"Zoom Out (Ctrl+-)","reset":"Reset Zoom"},"theme":{"toggle":"Toggle Light/Dark Mode","switchToLight":"Switch to Light Mode","switchToDark":"Switch to Dark Mode"},"lang":{"switch":"Switch Language"},"status":{"version":"Version","engineOn":"Engine Online","engineOff":"Engine Offline"},"output":{"title":"Output","hide":"Hide Output"},"update":{"check":"Check for Updates","updatedTo":"Updated to {version}. Reloading...","failed":"Update Failed","failedWith":"Update Failed","newVersion":"New version {latest} available (current: {current})"},"overlay":{"copy":"Copy to Clipboard","copied":"Copied","copyFailed":"Copy Failed","zoomIn":"Zoom In","zoomOut":"Zoom Out","close":"Close (Esc or Right-Click)","resetPosition":"Reset Position","mem":"Memory","file":"File","path":"Path","memTitle":"Image loaded into memory (clipboard image); can be pasted directly into chat or canvas","fileTitle":"Copy image file; can be pasted into chat/Roam/File Explorer","pathTitle":"Copy Image Path","memOk":"Image is in memory, ready to paste","fileOk":"File copied. You can paste it directly.","noLocalFile":"This image has no local file and cannot be copied","noLocalPath":"This image has no local path","roamNoFile":"This image has no local file and cannot be located in Roam","roamUnavailable":"Roam positioning is currently unavailable. Please try again later.","roamNoPath":"No local files at this path; cannot locate in Roam","roamMoved":"Path no longer exists (may have been moved or deleted):","roamMoved2":" → Located in recent directory ","roamNotFound":"Not found on disk:"},"about":{"title":"About qqq","version":"qqq-shell v2","desc":"Portable / Win7+ / Server Hot Update"},"tab":{"openRight":"Open Another on Right","openLeft":"Open Another on Left"},"viewport":{"mainFolder":"Main Folder (Cannot be removed)","removeProject":"Remove This Project","addProject":"Add Project Folder to AI Viewport","selectFolder":"Select Folder to Add to AI Viewport","searchFolder":"Search This Folder","recentFolders":"Recently Opened Main Folders","noRecent":"No recent history. Click + to select a folder.","editx":"Edit File","openInOs":"Open in System","timeline":"Timeline","copyPath":"Copy Path","empty":"(Empty)","removeTitle":"Remove Item","removeConfirm":"Are you sure you want to remove \"{n}\" from the AI Viewport?","removeBtn":"Remove","removeAsk":"Remove \"{n}\"?","openElsewhere":"⚠️ This item is already open as the main folder in another window","clearedBusy":"⚠️ Main folder is occupied by another window; AI viewport cleared to a clean state"},"dev":"Dev Mode","gaeaHostLoading":"Loading gaea host...","onl":{"title":"Online Users","avg24":"※ Avg. last 24h:","sampling":"Data sampling in progress ({p}/288 points, accurate after 24 hours)","samplingShort":"Collecting data","range180":"Last 180 Days","range30":"Last 30 Days","scaleTip":"Peak {max} · Trough {min} ({r}-day avg. online)","sparkTip":"{r} Daily Average Online Trend ({a} → {b}, last point = current 24h average; click 30d/180d to switch lookback window)","thPhone":"Phone Number","thDay":"day","thBalance":"Balance","thCost":"Consumption","thIndepCost":"Independent Consumption","thLastSeen":"Last Seen","thCont":"Duration (m)","thIndep":"Independent","thVer":"Version","thTotal":"Total (h)","loading":"Loading...","empty":"No users yet","loadFail":"Load failed, please retry"},"mem":{"qTitle":"qqqide Dedicated Working Set (includes all child processes)","coresUnit":"Cores","resetMem":"Clear memory curve history and restart recording (deletes mem-curve.log; does not affect CPU curve)","resetCpu":"Clear CPU history and restart from zero (deletes cpu-curve.log)","cpuSoloUnit":"CPU Single-Core Time","plistTitle":"qqqide Dedicated Working Set (Package Processes)","winUnit":"Window","peak":"Peak","valley":"Minimum","avg24h":"24h Avg Usage","sampling":"Sampling...","samplingDetail":"Sampling · One point every 60s","mean24h":"24h Mean","alertCur":"Standalone Package: Total memory for {label} (current package processes) reached {mb} MB","alertAvg":"Standalone Launch Package: The current average memory usage of the total memory (processes in this package) for {label} exceeds 1GB.","procsPeakPrefix":"(Peak ","procsSuffix":") processes","procsSuffix2":" Processes","uptime":"Uptime","avgBadge":"{v} Avg Usage","meanBadge":"{v} Mean"},"gp":{"stop":"Stop","start":"Start","autoStart":"Auto-start","runStop":"Start/Stop"},"mv":{"notLoggedIn":"Please log in before assigning a mentor","yourMentor":"Your mentor is {p}","designateTitle":"Assign Mentor","designateDesc":"Enter the mentor's full phone number (e.g., 8618283073262)","needPhone":"Please enter the mentor's phone number","badPhone":"Invalid phone number format. Please enter digits only (e.g., 8618283073262)","confirmTitle":"Confirm Mentor Binding","confirmWarn":"Binding is permanent and can only be done once. Please confirm.","confirmPhone":"Mentor Phone Number: {p}","confirmBtn":"Confirm Binding","submitting":"Submitting...","ok":"Mentor assigned successfully!","fail":"Assignment failed","netErr":"Network error, please retry","myMentor":"My Mentor: {v}","none":"None","label":"Mentor: {p}"},"st":{"myStudents":"My Students: {n}","notLoggedIn":"Please log in before claiming a student","claimTitle":"➕ Claim Student","claimHint":"Enter the student's phone number and load date. You can only try once.","phoneLabel":"Student's Full Phone Number","phonePh":"e.g., 8615812345678","dateLabel":"Student Import Date","claimBtn":"Confirm Claim","needPhone":"Please enter the student's phone number","badPhone":"Invalid phone number format","needDate":"Please select a load date","submitting":"Submitting...","ok":"Claimed successfully!","fail":"Claim failed"},"gs":{"titleKopea":"kope-a Settings","titleWinThere":"Window There Settings","kopeaIntro":"Use the card in the bottom-right corner, or an audio cue to confirm successful copying. Click the lower half of the bottom-right card to toggle edit mode.","winThereIntro":"Record and restore window position and size. To Record: 1. Ensure the target window is visible on screen but not focused (i.e., it is not the active window). 2. Move the cursor over the window. 3. Press the 'W' key three times. To Restore: 1. Ensure the target window is visible on screen but not focused. 2. Move the cursor over the window. 3. Press the 'X' key three times.","enableCard":"Enable Card","cardTip":"Show card popup"},"dl":{"failed":"Download failed: ","saved":"Saved:","file":"File","roamLocate":"📂 Locate in Roam","downloading":"Downloading...","preparing":"Preparing…","saving":"Saving…","waitSaveAs":"Waiting to select save location...","cannotStart":"Cannot start download:","cannotStartBare":"Unable to start download"},"prog":{"copyingN":"Copying {n} files…","done":"Done","cancelled":"Cancelled","fail":"Failed"},"exit":{"confirm":"Confirm exit?","ok":"Confirm Exit"},"free":{}},"editor":{"copyPath":"Copy Path","minimap":"Minimap","tabs":{"close":"Close Tab","closeOthers":"Close Other Tabs","closeRight":"Close Tabs to the Right","closeAll":"Close All","closeSaved":"Close Saved Tabs","revealInExplorer":"Reveal in File Explorer","copyPath":"Copy Path","copyRelativePath":"Copy Relative Path","splitRight":"Split Right","splitDown":"Split Down","encScheme":"Encoding Scheme…","encReopen":"Reopen with encoding (reread from disk)","encSaveAs":"Save Content As (Convert Encoding)","encAuto":"Auto-detect","encAutoReset":"Auto-Detect (Clear Fixed)","encAutoCur":"Auto-detect","encFixedAt":"Encoding fixed to {v} (Escape Hatch) — Click to modify or restore automatic detection","encAutoAt":"Encoding: {v} (Auto-detected) — Click to specify manually","readFail":"Read failed: File does not exist or is not readable","redecoded":"Re-decoded using {v}","switchFail":"Switch decoding failed:","noEditor":"No editor content found for this file","savedAs":"Saved as {v}","saveAsFail":"Save As failed:","dirtyFirst":"File has unsaved changes — Please press Ctrl+S to save before switching encoding (will reload from disk)","recallTip":"Press Tab or F2 to recall me"},"contextMenu":{"cut":"Cut","copy":"Copy","paste":"Paste","selectAll":"Select All","undo":"Undo","redo":"Redo","feedToAi":"📎 Feed to AI"},"undo":"Undo (Ctrl+Z)","redo":"Redo (Ctrl+Y)","unsaved":"Unsaved","saved":"Saved","saving":"Saving...","saveFailed":"Save Failed","fileTooLarge":"File Too Large","binaryFile":"Binary file, cannot edit","line":"Line","col":"Col","spaces":"Spaces","indent":"Indent","encoding":"Encoding","eol":"EOL","language":"Language","readOnly":"Read-only","codelens":{"openFile":"Open File","openFolder":"Open Folder","copyPath":"Copy Path","copyImage":"Copy Image Binary","rename":"Rename","copyFile":"Copy File","openRight":"Open file in right group and enter edit mode","created":"Created","modified":"Modified","codec":"Codec","aspectRatio":"Aspect Ratio","originalDuration":"Original duration","calculatingFolderSize":"Calculating folder size...","noExtension":"No extension","filesCount":"{0} files","filesCountWithBreakdown":"{0} files: {1}","emptyFolder":"Empty folder","fileNameEmpty":"File name cannot be empty","targetFileExists":"Target file already exists","renameSuccess":"Renamed successfully: {0}","renameFailed":"Rename failed: {0}","copyPathSuccess":"Copied successfully — plain text path","copyPathFailed":"Copy failed — Plain text path: {0}","copyFileSuccess":"Copied successfully — File","copyFileFailed":"Copy failed — File: {0}","copyImageSuccess":"Copied successfully — bitmap binary","copyImageFailed":"Copy failed — Bitmap binary: {0}"}},"login":{"title":"Login","waiting":"Waiting for browser login...","success":"Login Successful","timeout":"Login timed out, please try again","loggedOut":"Logged out","btn":"🔒 Login","loggingIn":"⏳ Logging in...","loggingInTip":"Logging in, click to reopen browser","menuTip":"Logged in — Click to open menu","geFlow":"ge Transaction History","logoutBtn":"Log Out","copyHint":"Please copy the link and complete login in your browser. You will be automatically returned to the IDE after successful login.","copyLink":"Copy Login Link","linkCopied":"Link copied. Please paste it into your browser's address bar","browserOpened":"Browser opened. If not logged in automatically, please copy and paste the link.","timeoutRetry":"Login timed out. Please check your connection and try again","unavailable":"Login is currently unavailable. Please restart the IDE","openFail":"Unable to open login window, please check your network connection","secondAuthMsg":"🔐 Secondary authentication required\nClick the button to proceed with the standard login flow (same as the top-right login)","secondAuthBtn":"🛡️ Secondary Authentication","lvRules":{"title":"Level & Free Quota Rules","periods":"There are 13 free slots per week:","p1":"Mon–Sat: 12 two-hour slots","p2":"Sunday × one 24-hour segment","perCap":"Free quota per time slot","capFormula":"= Random value (max 1000 ge) + {base}","base":"This Week's Base","season":"One UTC week constitutes a season,","seasonEg":"Example: 2026_28W1 represents the 28th week of 2026,","seasonEg2":"The corresponding first season of the total viewing history is: W1.","baseDecide":"{base} is determined by your final level from last season:","baseFormula":"Base = Last Season (Spend + Companion Conversion) ÷ 100","baseEg":"Example: If last season's spend was 100 ge → This week's Base = 1","monSat":"Mon–Sat: Random + Base × 1","sun":"Sunday: Random + Base × 2 (Double)","level":"Level","levelDecide":"{level} = (Spending + Companionship Conversion) ÷ 10","comp":"Companionship Conversion: Every 24 hours = 1 Level","nextBase":"Estimated Base for Next Week","nextBaseDecide":"{nb} = This week's (spending + companionship conversion) ÷ 100"},"lbr":{"freebie":"🍀 Free Tier Leaderboard","allTime":"🏆 All-Time Ranking","lastSeason":"📅 Last Season Rankings","current":"⚔️ This Week's Ranking","currentSub":"Pending Settlement · Top 10 get spend refunded on settlement day (20% ↓ 5%)","refunded":"Refunded {v}","prep":"Preparing data","noJoin":"No participation this week","rate":"Refund {p}%","meNone":"Me: Not participating this week","me":"Me: Rank {rank} · Lv {lv}","meEst":"Estimated cashback: {v}","meSettle":"Rewards returned by rank on settlement day","meOut":"Not in top 10 (no cashback)","cd":"{cd} until settlement (UTC Monday) · Season {pct}% complete","settling":"Processing settlement...","err":"Failed to load","load":"Loading...","header":"My final level last week: {last}, this week's base increase: {rise}. Estimated base increase for next week: {proj}"}},"ai":{"title":"AI","send":"Send","stop":"Stop","guide":"Guide","queue":{"full":"Queue limit is 3. Please wait for the previous message to be sent.","save":"Save","delete":"Delete","cancel":"Cancel","pause":"Pause","resume":"Resume","clear":"Clear","header":"Queue","editTitle":"Click to edit or delete","imageOnly":"(Image only)","resumeTip":"Resume auto-send","pauseTip":"Pause auto-send","clearTip":"Clear all queued messages","imageN":"Image #{0}"},"context":"Context","compress":"Compress","snap":"Snapshot","error":{"continueTask":"Continue Task","noActiveAgent":"Please send a message first to create a conversation","buildingFloor":"AI is currently building the floor. Please wait for the current floor to complete before compressing."},"compressing":"🧠 Compressing...","compressSuccess":"✅ Compression complete","compressFail":"✗ Compression failed","ctx":{"title":"You can choose to compress the context","benefit":"Benefits:","benefitText":"Reduces costs from the next conversation onwards; helps AI focus more on the current problem and reduces hallucinations.","cost":"Costs:","costText":"Conversations prior to the last six floors will be compressed, losing details, with AI retaining only summaries. The last six floors will be preserved in full.","whatIf":"What if I never manually compress?","auto":"qqqide will compress automatically. The default threshold is 600k. Click <Settings> in the top-right corner to change the default value.","noLoss":"Regardless of whether you compress or who performs the compression, it will neither overflow AI memory nor cause memory loss.","compress":"Compress","snap":"Snapshot","breakdown":"Context Usage","used":"Used","free":"Free","snapOk":"Snapshot saved","snapFail":"Failed to save snapshot","backpack":"Context Backpack","bdFacts":"Compress · Facts (fx) × {0}","bdBiscuit":"Compression Biscuit × {0} floors","bdStructure":"Structure lines (=== F separators / timestamps / [S] etc.)"},"inputPlaceholder":"Ask qqq AI... (Ctrl+V to paste image)","inputLimitWarn":"Input has reached the character limit for the editor (not file size in bytes)","inputLimitQoastCap":"Character limit for the editor reached (approx. {0}K characters, not file bytes)","inputLimitQoastFull":"Character limit reached. Cannot paste more content.","inputLimitQoastTruncated":"Character limit for the editor reached; excess content has been truncated","inputLimitQoastImageCap":"Image limit reached ({0} images); excess images were not pasted","inputLimitQoastImageSize":"{0} image(s) exceed the single-file size limit and have been skipped","inputSendBusy":"AI is processing, please wait…","embedImage":"Embed","level":{"a":"Conservative","1":"Light","2":"Medium","3":"Smart","4":"Strong","5":"Extreme","6":"Pro Max"},"floor":"Floor","house":"House","room":"Room","ttfb":"Network Wait","work":"Work Time","total":"Total","tokens":"Token Usage","confirmConnect":"Confirm Connection","thinking":"Thinking...","streaming":"Generating...","tools":{"readFile":"Read File","editFile":"Edit File","createFile":"Create File","deleteFile":"Delete File","writeFile":"Write File","searchText":"Search Text","findFiles":"Find Files","listFiles":"List Files","getDiagnostics":"Get Diagnostics","runCommand":"Run Command","fetchWebpage":"Fetch Webpage","getVision":"Get Visual Context"},"output":{"empty":"Waiting for input...","compressInProgress":"Compressing...","compressDone":"Compression complete","tokenLimit":"Token limit reached"},"rules":{"title":"Project Rules","edit":"Edit Rules","empty":"No rules yet","globalRule":"Global Rules (.qqq-rules.txt)","projectRule":"Project Rules (project.txt)"},"quest":{"switch":"Switch Project","newQuest":"New Chat","history":"History","noHistory":"No history yet","saveFailed":"Save failed","renameTitle":"Edit Name"},"lock":{"locked":"Project is already open in another window","stale":"Lock expired","heartbeat":"Heartbeat","holderInfo":"(Holder pid={0}, instance {1}…)"},"onboarding":{"selectFolder":"Please select a root folder first!","selectFolderTitle":"Select a Root Folder"},"guideBtnTooltip":"Guide AI with the current message without starting a new turn!","draftBean":"Unsent edits detected","billing":{"number":"ID","type":"Type","toolCount":"Tool Count","time":"Time Spent","wge":"wge","aiLv":"AI Level","cacheHit":"Cache Hit Rate","promptTokens":"prompt_tokens","completionTokens":"completion_tokens","totalTokens":"total_tokens","receipt":"Billing Receipt (10,000 wge = 1 ge)","title":"Billing Details"},"search":{"clear":"Clear","caseSensitive":"Case sensitive","noMatch":"No matches"},"bulletTip":"Bullet","newline":"Insert newline","ctxPanel":{"title":"Context Backpack V24 Engine","hint":"For long-range (high-floor) tasks, click Manage to lighten the context backpack.","best":"Best practice: Keep backpack weight under 100k before entering the next floor. This significantly reduces costs and improves AI focus.","perQuest":"Independent compression strategy","perQuestFor":"For {0}","manage":"Manage"},"compressErr":{"notOwner":"This task is held by another panel; please operate in the corresponding panel","tooFew":"Insufficient floors (requires ≥2)","small":"History < 64K tokens; no need to extract facts.","bullet":"Bullet write failed: {0}","blocked":"Sending blocked (other floor-building tasks are active or state disallows). Content restored. Please try again later.","facts":"Facts extraction failed: {0}","nothing":"No content to compress (backpack is already minimized).","internal":"Internal error: {0}","shortFail":"(Compression failed: content too short)"},"bullet":{"clipFail":"Cannot read clipboard. Please grant permissions and try again.","clipEmpty":"Clipboard is empty; please copy content first","fired":"Bullet fired {0} → {1}","writeFail":"Bullet write failed: {0}"},"pipeline":{"netInterrupt":"Network interrupted: Task halted. Queued messages retained—click the red box \"Resume Task\" to restore and continue sending automatically.","taskInterrupted":"This task has been interrupted. Please click \"Resume Task\" in the red floor frame to continue.","questFail":"Failed to create Quest: {0}","onlyfactsBusy":"Only facts: This task is being processed in another panel. Please switch to the corresponding panel or try again later.","allocRestored":"— Content has been restored to the edit box. Please try again.","sendFailPrefix":"Send failed (floor creation error): {0}","notSent":". The following content was not sent:","allocShown":"— Unsent content is displayed in the message area above.","stallAbort":"Send stalled (>20 minutes without progress); automatically terminated","stallAbortQoast":"Send stalled (>20 minutes without progress); automatically terminated. Click the layer's red box \"Resume Task\" to restore."},"needLogin":"Please log in via the menu bar first","errUnknown":"Unknown error","errUnknownReason":"Unknown reason","errNoReply":"No AI response received","recovery":{"bubble":"Continue"},"status":{"printInterrupted":"⏳ Print interrupted (auto-saved)","floorInterrupted":"⚠️ Layer abnormally interrupted; conversation saved.","floorInterruptedReason":"⚠️ Layer abnormally interrupted ({0}); conversation saved."},"guideInfo":"Guide Info","guideAck":"Guide received","guideAckFail":"Guide confirmation error; skipped.","guideAckTimeout":"Guide confirmation timed out; skipped.","toolsDone":"Tool execution complete","toolsDoneCount":"({0} calls)","roamLocate":"Locate this file in Roam","roamOpen":"Open in Roam","billingDebugQoast":"Billing debug {0}","billingDebugOn":"Enabled","billingDebugOff":"Disabled","gwFallback":"AI gateway automatically switched to backup route","gwPrimary":"AI gateway switched back to primary route","byok":{"tag":"Use Your Own Key","errReach":"Unable to connect to your configured AI endpoint","balance":"Insufficient API Key balance (using your own key)","authFail":"Built-in key authentication failed (Invalid API Key or insufficient permissions)","testNeedFill":"Please enter the Address, Key, and Model Name first","testing":"Testing...","testOk":"Connection successful","tipOn":"Bring Your Own API Key: Enabled","tipOff":"Bring Your Own API Key: Disabled (Click to configure)","title":"Use Your Own API Key","subtitle":"Configure your own AI service endpoint; chat requests connect directly to your provider.","enable":"Enable (Chat uses your Key; no ge fees)","baseUrl":"API Base URL (OpenAI Compatible)","apiKey":"API Key","showKey":"Show/Hide","model":"Model Name","modelPh":"Model name from provider documentation","think":"Send thinking parameters (thinking / reasoning_effort; disable if unsupported by provider)","test":"Test Connection","save":"Save","saved":"Saved","hint":"When enabled: Chat requests connect directly to the specified address (bypassing platform servers and not counting towards ge usage). Image recognition, generation, background removal, and search still use the built-in channel. Keys are encrypted and stored locally (protected by system credentials).","lockedBridge":"Key stored encrypted (decryption unsupported in current instance; will unlock automatically after IDE restart)","lockedDecrypt":"Key cannot be decrypted on this device (possibly from another device), please re-enter"},"gwWait":{"title":"⏳ Upstream unresponsive {0}","subtitle":"Layer {0} · {1}","serverAck":"Awaiting server acknowledgment","firstToken":"Waiting for first token output","hangCount":"(Attempt {0})","hangBroken":"Network channel suspected damaged{0}; all routes have been automatically attempted. Layer saved. Recommended: Press Ctrl+R to refresh the window, then click \"Resume Task\"."},"gw":{"hangTimeout":"Connection timed out (automatically tried all routes; conversation preserved. Click \"Resume Task\" to retry).","keysDepleted":"AI service temporarily unavailable; please try again later (all API key balances exhausted)","authFail":"Authentication failed; please check Token","geInsufficient":"Insufficient ge balance; please sponsor","tooFrequent":"Requests too frequent. Please try again later.","serviceUnavailable":"Service temporarily unavailable ({0}) — possibly due to exhausted billing/quota or server overload","allLinesDown":", all routes unreachable","retriedSuffix":"(Retried {0} times + switched {1} routes; conversation saved)"},"secondAuth":{"continueMsg":"Secondary authentication required. Complete verification to continue.","qoast":"Secondary authentication required: Click the login button in the top-right corner to verify"},"taskAborted":"Task aborted (floor ended abnormally)","autoCompressFacts":"Auto-compress: Facts extracted per fully managed tier (one-time only; no further auto-extraction within 5-layer cooldown)","allTxtTooBig":"⚠️ all.txt {0}MB exceeds the {1}MB limit. Archiving paused (SQLite intact).","featureWip":"This feature is under construction","auditBtn":"Audit","translateBtn":"Translate","auditCopied":"Audit text copied to clipboard ({0} KB). You can paste it into any AI chat."},"goods":{"conv":{"title":"Context Pack","cells":"Cells","chars":"Characters","estimate":"Estimate","api":"API","refresh":"Refresh","expandAll":"Expand all","collapseAll":"Collapse All","noData":"No cell data","noDataHint":"After opening a conversation, click 'Context' → 'Manage' in the bottom-right corner of the AI panel","copyCell":"Copy this cell","toastCopied":"Copied","compressByValue":"Compress Inventory by Cost-Effectiveness","compressIdleOnly":"Compression is only available when the floor is idle","compressAgentNotFound":"Agent not found. Please open the corresponding quest first.","compressSending":"AI is building the structure, please wait for completion before compressing","compressNoBiscuit":"No compression biscuits found","compressAbsolutHover":"Remove absolute wrapper boxes (╔K...╚ body), keeping header lines and all gentle wrapper boxes","compressEditonlyHover":"Strip everything except edits from the previous context: keep only Q/A and header lines for edit_file / write_file / create_file / delete_file / revert_file","compressOnlyfactsHover":"On top of the previous two options, this cuts half of the original conversation text (but extracts and retains the facts). It removes the older half while keeping the most recent half intact. Requires AI call (billable).","compressAbsolutOk":"🧹 Absolute packaging removed","compressEditonlyOk":"✂️ Streamlined to edit-only packaging","compressOnlyfactsOk":"✅ Facts extracted and injected into fx memory area","compressNoChange":"No removable content found; inventory is already minimized","compressFailed":"Compression failed","compressTimeout":"Compression timed out, please try again","compressCostLink":"What is the cost of each compression?","factsExtracting":"⏳ Extracting facts with AI…","factsExtractingTitle":"🧠 Extracting Facts…","compressing":"Compressing…","compressDone":"✅ Compression complete"},"navigator":{"inputPlaceholder":"Type path segments, Enter to open / Esc to close","noRecent":"No recent files yet. Open some files in the file tree first.","noMatch":"No matches found"},"pasteImage":{"saveFailed":"Failed to save pasted image","saved":"Image saved to"},"bar":{},"fileExplorer":{},"wysiwyg":{},"rage":{"clip":{},"captain":{},"search":{}}},"dialog":{"about":{"title":"About qqq","message":"qqq-shell v2","detail":"Portable / Win7+ / Server Hot Update"},"confirmDelete":{"title":"Confirm Deletion","message":"Are you sure you want to delete? This action cannot be undone."},"unsaved":{"title":"Unsaved Changes","message":"There are unsaved changes. Do you want to save before closing?","save":"Save","discard":"Discard","cancel":"Cancel"}},"shortcuts":{"ctrlS":"Save","ctrlZ":"Undo","ctrlShiftZ":"Redo","ctrlX":"Cut","ctrlC":"Copy","ctrlV":"Paste","ctrlA":"Select All","ctrlF":"Find","ctrlH":"Replace","ctrlN":"New File","ctrlO":"Open File","ctrlW":"Close Tab","ctrlShiftE":"Show File Explorer","ctrlShiftF":"Search Files","ctrlBackslash":"Split Right","ctrlPlus":"Zoom In","ctrlMinus":"Zoom Out","ctrl0":"Reset Zoom","f12":"Developer Tools","f1":"Command Palette","altLeft":"Back","altRight":"Forward"},"wings":{"redrawing":"Redrawing"},"timeline":{"filePathPlaceholder":"File path…","searchHistory":"Search History","dragHandle":"Drag to move window","maximize":"Maximize","full":"📋 Full Text","diff":"📌 Diff","acceptLeft":"← Move to Right","save":"💾 Save","changes":"{n} change(s)","modeFull":"Full Text","modeDiff":"Diff","loading":"Loading…","noVersions":"No historical versions for this file","missingParams":"Missing parameters","loadingVersions":"Loading version list…","monacoTimeout":"Monaco load timed out. Please check your network or restart the window.","monacoFailed":"Monaco failed to load","saved":"Saved","saveFailed":"Save failed","copyRow":"Copy this line","closeHint":"= Right-click to close","diffOnly":"Diff Only","editBtn":"Edit","cancelEdit":"Exit edit mode","editTooltip":"Edit the latest file on disk (not any historical snapshot)","editTooltipExit":"Changes are not saved automatically when exiting edit mode","editing":"Editing","unsaved":"Unsaved","snapshot":"📸 Take Snapshot","snapUnchanged":"Content unchanged; no snapshot needed","snapping":"Taking snapshot…","snapOk":"Snapshot #{seq} taken at {time} diff edit","snapNoNew":"No new snapshot generated; content may be unchanged or in cooldown period","snapFailed":"Failed to take snapshot","vaultLoading":"Loading memory vault...","vaultEmpty":"No records in Memory Vault","vaultNoMatch":"No matches · Try shorter keywords","vaultHint":"Memory Vault contains {n} files · 🗑️ = Deleted (Click to recover)","vaultMatch":"Matched {m} / {n} files total","vaultMore":"⬇ Load more ({n} remaining)","browseVault":"Browse memory vault by directory (full window)","vaultSearchPh":"Search memory vault: filename or path fragment…","vaultOnlyGone":"Show Deleted Only","vaultBack":"✕ Back to Compare","vaultUp":"⬆ Up one level","vaultRoot":"🏠 All","vaultEmptyDir":"No memory records in this folder","vaultCountBrowse":"{d} folders · {f} files","deletedBadge":"🗑️ Deleted","editDisabledTip":"File deleted—use op → \"Restore File\" to recover before editing","opRestore":"Restore File","opWriteback":"Revert to this version","opRestoreTip":"Rebuild this deleted file using the selected snapshot on the right","opWritebackTip":"Write the selected historical version on the right back to the file (a protection snapshot is automatically recorded before overwriting)","restoreConfirm":"Reverting to this version will overwrite the current file (the current content will be saved as a protection snapshot first):","restoreReadFail":"Failed to read snapshot content","restoreWriteFail":"Write failed: {err}","restoreDir":"This path is occupied by a folder and cannot be written to","relJustNow":"Just now","relMin":"{n} minutes ago","relHour":"{n} hours ago","relDay":"{n} days ago"},"act":{"sponsorLabelWord":"Sponsor","sponsorLabelColon":":","sponsorName":"Zhijia","cool":{"name":"Fresh Start from 2026","tip":"Cool from 2026","popSub":"Spend a total of 10 ge to claim a 10 CNY red packet","loginDesc":"Log in to check your spending progress. Fill the progress bar to claim a ¥10 red packet.","p1":"Progress bar full = Total spending reaches <b>10 ge</b> (includes both paid and free usage)!<br>Even if it's all free usage, as long as the progress bar is full, you can now join QQ Group <b>524906522</b> to claim a <b>10 CNY red packet</b>.","p2Title":"Congratulations! {phone} is fully charged","p2Subtitle":"Starting from 2026, lighter and faster","p2":"Your total spending has reached <b>10 ge</b> (including free usage)!<br>Join QQ Group <b>524906522</b>, send a screenshot of this window, and receive a <b>10 CNY red packet</b>.","copyGroup":"Join QQ Group 524906522 to claim a 10 CNY red packet","copyGroup2":"Copy Group ID 524906522","copied":"QQ group ID 524906522 copied. Search and join on QQ."},"ge50":{"name":"Raw Materials & Basic Rights","subtitle":"Your context assets are now yours. Even if you stop using qqqide, all history remains in your hands.","tip":"Total spending reaches 50 ge · Select a sponsorship to claim double ge","eitherOr":"Choose One","popSub":"Claim when the sum of actual deductions and free acquisitions reaches 50 ge.","loginDesc":"Log in to check task progress. Claim when you reach 50 ge.","task1":"Download and log in to qqqide","task2":"Total spending reaches 50 ge (actual deduction + free usage combined)","task3":"At least one sponsorship","task3Go":"Sponsor →","task3GoTitle":"Click to sponsor, unlimited times","claimPhone":"Claim an extra 50 CNY phone credit","claimGe":"Claim an extra 50 ge","claimPhoneClaimed":"Extra 50 RMB Phone Credit · Claimed","claimGeClaimed":"Extra 50 ge · Claimed","claimed":"Claimed","loginBtn":"Log In","phoneModalTitle":"50 Yuan Phone Credit","phoneModalDesc":"The phone credit will be automatically credited within 2 business days. Please ensure the phone number {phone} is active.","geModalTitle":"50 ge Credited Instantly","geModalDesc":"50 ge has been credited to your account instantly!","err":"Claim failed, please try again later","claimSwap":"Claim Double ge","claimSwapDone":"✓ Claimed double +{ge} ge","claim":"Claim Double","claimConfirm":"Confirm +{ge} ge","claimHint":"One-time lifetime offer: Click confirm again to instantly receive an extra +{ge} ge","pick":"Select a past sponsorship, click \"Claim Double\", then click \"Confirm\" again to receive it. One-time lifetime offer.","already":"You have already claimed the double reward (once per lifetime)","locked":"Claim double after spending a total of {target} ge (Current: {cur} ge)","noBills":"You haven't made any sponsorships yet","loading":"Loading data, please wait a moment before clicking again","claimChecking":"Fetching sponsorship records…","claimSlow":"Connection is slow, still fetching…","claiming":"Claiming…","doneTitle":"Claim Complete","doneDesc":"Extra +{ge} ge credited. Thanks for your support!"},"eye":{"name":"Beautiful Eyes","tip":"Beautiful Eyes · Exclusive perks for real qqqide users","sub":"qqqide Real User Perks","loginDesc":"Log in to view credited amount","intro":"Share the little moments in qqqide that touched you. Quality and view count don't matter. Just post a video to your Bilibili space. Each video earns at least 80 RMB (no less than 80 RMB, but videos not involving actual functionality/live operation may be halved). Cash paid instantly.","linkRecords":"View transaction records","tail":"Automatically integrates as video views increase","linkSpark":"Spark Program","tailEnd":".","paid":"Joined: {v}","sparkPaid":"✨ Sparkle credited ¥{v}"},"vibe":{"name":"2026, Me, Vibe Coding","tipFree":"💎 Free Mode · Free trial ends in {time} · Balance {ge} ge","tipNext":"🤍 Next free session in {time}","shortNext":"Until next","shortFree":"Left","popFreeNow":"🟢 Free session · Ends in {time}","popInWindow":"🟢 Free Period Active · Random Free Balance Enabled","popNext":"⏳ Next free session in {time}","popNotInWindow":"Currently not in a free session period","popWindow":"📅 Free Hours: (UTC) All day Sunday + Daily 01:00-03:00 / 13:00-15:00","popWindowLocal":"📅 ({tz}) All day Sunday + Daily {span}","histTitle":"First 8 free windows: {used} / {budget}","popBonus":"Seasonal bonus +{v} ge","popLogin":"Log in to check your random free balance drop","popLoading":"Loading random free balance…","popNoBudget":"Random free quota is distributed during free hours"}},"secretGuard":{"qoastMsg":"⚠️ Detected {n} potential secret(s) (cannot be auto-confirmed). Please review before submitting.","btnGo":"Handle","panelTitle":"Secret Masking · Collaborative Handling","panelDesc":"The following content appears to contain secrets and cannot be automatically confirmed. It has been redacted; please review and handle manually.","btnErase":"Erase","btnKeep":"Keep","btnIgnoreFile":"Ignore this file","btnEraseAll":"Erase All","btnKeepAll":"Keep All","editorOpenHint":"Note: Files already open in the editor will be skipped to avoid overwriting unsaved changes.","autoRedacted":"Auto-redacted (Configuration class T1 replaced with ***REDACTED***)","fullHit":"T1/T2 Match (Full Scan · Read-Only, Unprocessed)","syntaxJson":"JSON Syntax Error: ","syntaxJs":"JS Syntax Error: ","staleEngine":"STALE-ENGINE rule updated. This instance is downgraded to read-only collaboration (refresh page to apply).","gitNoHit":"(Zero hits in full history, no exposure)","gitignoreRmFail":"Added to .gitignore (rm --cached failed: ","ignoredUntracked":"Ignored and untracked","addedGitignore":"Added to .gitignore"},"firstRun":{"expert":"I am an expert. I understand the risks of every command. I do not use qqqide to delete files.","roamHint":"With Roam, you can quickly manage files, including deletion","agree":"Agree and Continue","exit":"Exit","saveFailed":"Save failed, please try again"},"notice":{"title":"Notifications","empty":"No notifications","ack":"Got it","open":"Open Link","view":"View","read":"Read","modalTitle":"Important Notice","modalHint":"After handling, you can click the dot next to the version number at any time to view all notifications","dot":"Notifications","dotPending":"Unread notifications available"},"help":{"email":"Email","phone":"Phone Number","copied":"Copied","comments":"Comments","changelog":"Changelog","announcements":"Announcements","docs":"Official Docs","activity":"Activity"},"audio":{"sfx":{"floor-ok":{"label":"Normal Floor Completion Sound","desc":"Sound played when a floor is successfully completed"},"floor-bad":{"label":"Floor Abnormal Termination Sound","desc":"Error/Stop/Stall completion sound"},"muyu":{"label":"Wooden Fish · Free Period Notification","desc":"Plays instantly upon entering a free slot"},"roam":{"label":"File Operation Sounds","desc":"Roam enter/delete/clear/pin/unpin + terminal"},"bullet":{"label":"Bullet Q&A Gunshot","desc":"Bullet button after AI response"},"lv":{"label":"Level Up Sound","desc":"Level bar tier-ups and milestones"},"summon":{"label":"Window Recall Sound","desc":"Successful window recall via squad hotkey"}}},"settings":{"title":"Settings","restart":"Reset Window","restarting":"Resetting...","tabGeneral":"General","tabAdvanced":"Advanced","empty":"No settings available for this tab","on":"On","off":"Off","needActivation":"Activation required for this feature","sfxTitle":"Sound Effects","sfxSubtitle":"All enabled by default · Takes effect immediately","sfxTooltip":"Toggle sound effects individually","undoMode":{"label":"Editor Undo Mode","desc":"Granularity of Ctrl+Z undo in the code editor","char":"Character-by-character undo","charDesc":"Each Ctrl+Z press undoes one character","word":"Word Backspace","wordDesc":"Monaco native undo, grouped by edit operations (recommended for code)"},"defaultTier":{"label":"Default AI Level","desc":"Higher number = Deeper thinking, higher quality, slower, more expensive","d1":"Lightweight","d2":"Light + Reasoning","d3":"Lightweight + Deep Reasoning","d4":"Professional","d5":"Pro + Reasoning","d6":"Pro + Deep Reasoning"},"compress":{"label":"Auto-compress Context Backpack","desc":"Default is Medium","off":"Off","medium":"Medium","full":"Fully Managed"},"floorCap":{"label":"Show Floor"},"volume":{"label":"Volume","desc":"Volume for the IDE window and all goods (independent volume goods bypass this control). Factory default is 25%."},"shortcut":{"label":"Auto-generate Shortcut"},"trackRun":{"label":"Track Command File Changes","desc":"When enabled, files modified by AI-executed shell commands are automatically recorded in the version timeline. Disabling this reduces timeline snapshot noise."},"secret":{"label":"Assist with Key Masking","desc":"Automatically identifies and removes secrets (API Keys/passwords/tokens, etc.) when uncommitted changes are detected in the project. Cases that cannot be automatically confirmed will prompt a dialog for your assistance."},"tier":{"title":"AI Level Explanation","lv1":"Gear 1:","t1":"Lowest intelligence, fast and cheap.","lv6":"Gear 6:","t6":"Highest intelligence: Slow and expensive.","noAuto":"qqqide no longer provides automatic tier switching,","noAutoReason":"qqqide no longer provides automatic gear-shifting functionality. Reasons:","reason":"Reasoning","arch":"To help you understand, we have defined the following architecture:","p1":"A project is just a project, which you can also understand as a folder. A quest is a task. You can build multiple layers within a task. Each time you send a message, it's equivalent to building one layer, or a floor. You can have multiple quests open simultaneously, and each quest can have multiple layers. This is easy to understand.","p2":"In the background, each layer actually exchanges multiple messages with the server. So while it appears you only pressed send once, multiple send and receive operations actually occur.","p3":"Why does this happen? Imagine a scenario where you ask the server to modify code in a large project. The server will likely return multiple queries for specific code segments to better understand your local codebase. These server requests can be parallel or sequential. For sequential processing, the server sends an instruction, your client receives it, queries the required code based on the instruction, and sends the result back. We call this round-trip a <b>house</b>.","p4":"In reality, the server can issue multiple requests at once. When the server sends back a message, your local client executes multiple instructions \"in parallel.\" We call each instruction a <b>room</b>. Each room returns a result, so multiple \"rooms\" appear to form a house (corresponding to one round-trip with the server). Crucially, although it looks like you only pressed send once, houses and rooms operate silently and automatically (interacting with the server).","p5":"Ultimately, a project can contain multiple quests, a quest can contain multiple floors, a floor can contain multiple houses, and a house can contain multiple rooms.","p6":"Take a short break, because the important part comes next.","p7":"First, the hardest fact to accept but which you must is:","p8a":"Not just projects and quests, but even different houses within the same floor (corresponding to a single physical server round-trip) may request physically isolated servers (large models). Simply put, even if the server has caching, you must assume it retains no memory of your current task (project, quest, or floor). The first cognitive shift you must make is:","p8b":"AI has no inherent memory.","p9":"You might wonder how AI remembers conversations from 50 floors ago. The hard truth you must accept is that for every house—i.e., even the most granular server round-trip—you send as much context as possible, including all previous dialogues and tool query results. Note that every granular server round-trip, whether triggered manually or silently in the background at the house level, attempts to include all prior context, let alone floor-level submissions. \"All\" refers to the collection of all dialogues and tool call results from the first floor to the present, known as the \"context.\"","p10":"Your first question might be: Why doesn't the 1M context space fill up after just two layers? The main reason is that, depending on the IDE's strategy, even the most conservative AI IDE won't put a 200KB source code query result directly into the context. In practice, it only extracts about 2KB of key lines. Other tool results, such as logs, are essentially summarized, also reducing them to the KB level.","p11":"Additionally, most AI IDEs have their own compression strategies. qqqide's strategy retains complete information for the last 6 floors. If there were 200 floors prior to these 6 during compression, those 200 floors are compressed into a summary of max 32KB. Compression is a dedicated AI request—for example, giving the AI 1MB of text (context) and asking it to summarize, returning no more than 32KB of text.","p12":"This explains why, in a quest, if you build up to the 5th floor and leave it idle for six months, when you return and click Send again, the AI can continue the conversation as if it remembers everything—even though six months have passed and the model has long been updated. This is because large language models are stateless (they don’t retain any records about you), and you send the full context every time (stored either on your local hard drive or on the relay server’s hard drive).","p13":"You might still doubt: \"Shouldn't the AI (LLM) remember something?\" No, it remembers nothing. What you perceive as \"memory\" is just a \"notebook\" secretly kept on your local hard drive or relay server. This notebook is sent to the AI along with your next message.","p14":"OK, with this understanding, you can reach the first reassuring conclusion:","p15":"\"Switching model tiers will never cause memory loss.\"","p16":"In short: Switching model tiers at any point does not lose memory, but it does affect the quality of intermediate reasoning.","p17":"Back to the original question: Why does qqqide no longer provide automatic gear shifting?","p18":"There are two key points:","p19":"We cannot guarantee \"using the highest intelligence to write the most critical code.\" We know this is crucial, but edge cases will always exist.","p20":"Automatic gear shifting essentially lets the highest-intelligence AI assess problem complexity (and choose the actual working AI). However, in the long run, each floor incurs at least one extra call to the \"highest-intelligence AI,\" adding to the cost. Conversely, not using the highest intelligence for assessment increases the risks mentioned in point one.","p21":"Ultimately, qqqide decided to create a better gear shifter, placing 100% of the shifting control in your hands."}},"squad":{"tipActive":"Squad {sq} — Space+{sq} to recall (click to change squad)","tipNone":"Squad: none (cannot recall) — Click to select group","tipFull":"No available squad (More than 8 windows, recall disabled) — Click to select a group","idle":"Idle","windowN":"Window #{n}","current":"Current","occupiedTip":"Occupied by: {x}","noneRow":"none (No group specified)","occupied":"This squad is occupied"},"qqq":{"user":{"copy":"Copy"},"ai":{"copy":"Copy Markdown"}},"main":{"boot":{"firstBoot":"Starting up…","connecting":"Connecting to server…","parsing":"Parsing page…","structure":"Loading page structure...","scripts":"Loading component scripts…","styles":"Loading style resources…","init":"Initializing IDE…","starting":"Starting IDE...","almost":"Almost done…","restartApp":"Please restart the application","noServer":"Cannot connect to server. The network may be disconnected or the server is not ready.","retry":"Retry Now","portableHint":"Shell remains in portable mode. All data is written only to the application directory.","firstWait":"First-time connection may take a moment...","reason":"Reason: {r}","retrying":"Retrying...","stillFail":"Still unable to connect, please try again later...","retryFail":"Retry failed: {e}"},"update":{"title":"Update Required","message":"Your qqqide version is too low. Please reinstall and download again.","current":"Current version: {v}","min":"Minimum required: {v}","why":"Due to architecture upgrades, older versions cannot be updated automatically.","get":"Please visit the download page to get the latest portable package.","installTitle":"[Installation Instructions]","s1":"① Close the IDE","s2":"2. Download the latest portable package (approx. 94MB)","s3":"3. Extract and overwrite to the original location (recommended)","prefsTitle":"[Preference Retention]","prefs1":"Project data (chat logs/settings) is located in the qqq/ directory within the project folder,","prefs2":"Overwriting the installation will not cause data loss. Login status and app preferences need to be reconfigured.","prefs3":"To preserve data: Back up the gh555.com\\Data\\alphal\\ folder first,","prefs4":"Install, run for the first time, then copy back.","cleanTitle":"[Clean Install]","clean1":"Delete the old qqqide-win-x64 folder → Extract the new portable package.","download":"Go to Download","exit":"Exit"},"enc":{"saveRejected":"Save rejected: Character \"{ch}\" ({cp}) cannot be encoded with {enc}. Content was not saved. Solutions: ① Delete the character and save again; ② Select \"Save As UTF-8/GB18030\" from the tab encoding menu (supports all characters, no data loss)."},"search":{"rgMissing":"ripgrep is not installed. Run: python op/components.py ensure ripgrep","rgSpawn":"Failed to start ripgrep: {err}","rgError":"ripgrep process error: {err}","timeout":"Search timed out","rgExit2":"ripgrep exit code 2","noQuery":"Missing search keyword or path"},"term":{"noBash":"No usable Git Bash found (git component missing; restart IDE to auto-repair)","bashBroken":"Bash detected but failed to run (Git component error; restart IDE to auto-fix)","unavailable":"Unavailable"},"gaea":{"anotherRunning":"Another instance is running, please try again later","starting":"Startup in progress, please retry later","noPython":"Python is not installed. It will be downloaded automatically after restarting the IDE.","runtimeMissing":"Runtime not found: {p}","scriptMissing":"Script not found: {p}","startFail":"Failed to start: {err}"},"dlg":{"saveConsole":"Save Console Logs","logFile":"Log File","saveFile":"Save File"},"browser":{"openFailTitle":"Unable to open browser automatically — qd (qqqide)","openFailMsg":"Failed to open browser automatically. Please copy the following link into your browser's address bar:","copyLink":"Copy Link","close":"Close"}}};

    // ── 状态 ──
    var _cache = {};
    var _currentLang = null;
    var _loading = null;
    var _i18nState = null; // qgs handle, set lazily

    function _getState() {
        if (!_i18nState) {
            try {
                // ★ qgs 是对象非函数（window.qgs('ns') 曾抛 TypeError 被吞 → 持久化从未生效）
                //   正确入口 = qgs.simple('qqq.i18n')（同 first-run.js 范式）
                if (window.qgs) {
                    if (window.qgs.simple) { _i18nState = window.qgs.simple('qqq.i18n', { cloud: false }); }
                    else if (typeof window.qgs === 'function') { _i18nState = window.qgs('qqq.i18n'); }
                }
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

    // ── 语言持久化双通道（2026-09-16 重做）───────────────────────────
    // ① localStorage 同步镜像（跨刷新/跨窗口；Electron 下持久于 Data/Local Storage，随交换备份）
    // ② qgs.simple('qqq.i18n') 权威库（异步；localStorage 被清时兜底恢复）
    // 决议链：localStorage → qgs → OS 语言 → 'en'；首启（两通道皆空）＝ OS 检测结果双通道落盘
    var LS_KEY = 'qqq.i18n.lang.v1';

    function _lsGetLang() {
        try {
            var v = window.localStorage.getItem(LS_KEY);
            return (v && LANG_ENABLED[v]) ? v : null;
        } catch (e) { return null; }
    }
    function _lsSetLang(lang) {
        try { window.localStorage.setItem(LS_KEY, lang); } catch (e) { /* ignore */ }
    }
    function _qgsGetLang() {
        var st = _getState();
        if (!st || !st.get) return Promise.resolve(null);
        return Promise.race([
            Promise.resolve(st.get('lang')).then(function (v) {
                return (v && typeof v === 'string' && LANG_ENABLED[v]) ? v : null;
            }).catch(function () { return null; }),
            new Promise(function (res) { setTimeout(function () { res(null); }, 2500); })
        ]);
    }
    function _qgsSetLang(lang) {
        try {
            var st = _getState();
            if (st && st.set) {
                var p = st.set('lang', lang);
                if (p && p.catch) { p.catch(function () { /* 写失败：LS 通道仍保底 */ }); }
            }
        } catch (e) { /* ignore */ }
    }
    // state-sdk.js 在 i18n.js 之后同步加载 → 首启等待句柄就绪（正常运行 ~25ms 内命中）
    function _waitQgs(maxMs) {
        if (window.qgs && window.qgs.simple) return Promise.resolve(true);
        return new Promise(function (res) {
            var t0 = Date.now();
            var iv = setInterval(function () {
                if (window.qgs && window.qgs.simple) { clearInterval(iv); res(true); }
                else if (Date.now() - t0 > maxMs) { clearInterval(iv); res(false); }
            }, 25);
        });
    }

    // ── 语言决议（异步；LS 命中零等待，未命中最多等 qgs 600ms）──
    function _resolveLang() {
        var ls = _lsGetLang();
        if (ls) return Promise.resolve(ls);
        return _waitQgs(600).then(function (ok) {
            return ok ? _qgsGetLang() : null;
        }).then(function (persisted) {
            if (persisted) {
                _lsSetLang(persisted);   // 回写镜像（下次启动秒读）
                return persisted;
            }
            // 首启：OS 语言检测 → 设为用户偏好默认语言（双通道落盘）
            var mapped = mapOsLang(navigator.language || navigator.userLanguage || '');
            var chosen = mapped || 'en';   // 识别不到系统语言 → 英文默认
            _lsSetLang(chosen);
            _qgsSetLang(chosen);
            return chosen;
        });
    }

    // ── 语言检测（同步尽力而为——完整异步链在 _resolveLang）──
    function detectLang() {
        var ls = _lsGetLang();
        if (ls) return ls;
        var browserLang = (navigator.language || navigator.userLanguage || '');
        var mapped = mapOsLang(browserLang);
        if (mapped) return mapped;
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

        // 持久化双通道：① localStorage 同步镜像（下次启动零 IPC 秒读）② qgs 权威库（异步兜底）
        _lsSetLang(lang);
        _qgsSetLang(lang);

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
            // 全部 iframe 一体覆盖（AI 面板/左右翼/X 区 goods 标签页）：广播消息 + 同源 DOM 直刷
            var frames = document.querySelectorAll('iframe');
            for (var i = 0; i < frames.length; i++) {
                var fr = frames[i];
                if (!fr || !fr.contentWindow) continue;
                try {
                    fr.contentWindow.postMessage({ type: 'qqq-lang-change', lang: lang }, '*');
                } catch (_) { /* ignore */ }
                try {
                    if (fr.contentDocument) updateDom(fr.contentDocument);
                } catch (_) { /* ignore cross-origin */ }
            }
        } catch (e) { /* ignore cross-origin restrictions */ }
    }

    // ── 初始化 ──
    function init() {
        if (_loading) return _loading;

        _loading = (function () {
            return _resolveLang().then(function (chosen) {
                _currentLang = chosen;
                return loadLang(chosen);
            }).then(function () {
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
        _resolveLang: _resolveLang,
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
