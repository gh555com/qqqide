// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// service-worker.js v333 — 国旗唯一渲染机：login.js 竞态根治 + 排行榜 flag 归一 + onerror 静默
// PWA strategy:
//   - index.html / navigation : network-first(2s), fallback cache, last-resort 503
//   - core/* qoods/* assets   : stale-while-revalidate
//   - health                  : network-only (no cache)
//   - qqqide-asset://*           : passthrough (electron handles it)
// Cache version bumps on each shell.css/js change.
// ========================================================================
// v426: inbox 发送方重复消息根治——REST 响应与 WS 回显双路径 id 去重（cacheHas），发送方不再看到两条相同气泡
const CACHE_NAME = 'qqq-shell-v458'; // v458: goods kmd 终端（v1 行模式，分裂架构——输出日志式渲染器 + 输入原生控件点击定位；多 shell 宿主 cmd/powershell/gitbash；X 区 tab + 菜单行2 按钮） // v457: 服务端甲壳档1损坏修复（残句/重复/劈词）+ E-FLOW 模板 A/B 合并去重（Variant 结构）；fx 提取提示词英文化 // v456: 服务端甲壳字符数动态化（core/guard-meta.js 唯一入口 + /api/v3/ai/guard-meta 拉取 + 出厂快照兑底，4 处 14964 硬编码清除）// v455: only facts 增量提取（提示词带 fx 参照只提新增/变化）+ 清理死代码（_intent 残留）+ backpackEstK 补位 // v454: 上下文背包 UI 事实格顺序对齐背包容序（fx → biscuit）+ fx 专用标签；restore 从 ctx.facts 重建 fx 消息 // v453: Inbox 逐字回退（char-undo 唯一真理机器接管编辑框 Ctrl+Z/Y）+ 空态占位根治（data-empty-hint：新消息到达即移除，「暂无消息」不再压在已发消息上方） // v452: 热更新 UI 删除（2026-08-10 版本=清单编号重构，update-ui.js 移除，更新 100% 由 C 启动器随 r 托管） // v451: Inbox 联系人列表去重+分割线铁律——conv-flag 头像列删除（国旗+号码直贴左边界，不再双份国旗）；splitter hover 不再变色不换光标形态（光标外观全站铁律：任何元素不自定义 cursor）；splitter 拖动反馈仅背景高亮 // v450: 改名/空壳/tmp 三线根治——lazyRenameScan 改名成功后失效楼层缓存 + 关闭时再扫（会话中改名即落盘）；写路径 _fDir 过期校验（防幽灵目录重建，q174 事故）；归档空 quest 同步移除索引（防 q177 幽灵复活）；all.json.tmp 三防线（parent 级跨实例写锁 + rename 失败清 tmp + 启动清扫 .name 修复） // v449: openFile 无 onRender 时广播 qqq-file-open-in-pane（diff 窗口 open in qqqide 空白修复——tab-manager 直建 pane 不渲染，shell-rpc 监听器未触发） // v448: timeline diff op 菜单——① 第一行改名 open in qqqide（避免与下方编辑按钮大脑分裂）② hover 背景透明修复（--hover-bg rgba 透明叠加→实色 #e2dbc4 亮 / #3a3a3a 暗，op/fuzzy/v-dropdown 三处下拉同步受益） // v447: timeline diff op 菜单——① 打开文件→编辑文件（= Roam Q 键 open in qqqide）② 喂给 AI 动态标签（←喂给 AI/喂给 AI/喂给 AI→ 按焦点面板，Roam 右键传统）③ 主进程宿主窗口定位修复（_hostWindow parent 链优先 + /qqqide/ URL 兜底，根治 getAllWindows()[0] 取错窗口导致 executeJavaScript 静默失败）④ 新增 getAiTarget IPC // v446: 群聊（q150 F16）——服务端 0125 migration + 7 条 /api/group/* + ws group_msg 推送；客户端 dm-ui/网站 dm 群列表/建群/加人/群消息发送者名/群未读，SW 强制刷新 // v445: Inbox 本地缓存+历史分页——dm-ui 会话/消息 localStorage 防抖缓存（启动秒开/离线可读/单会话300条/全会话3000条裁剪）+ 加载更早消息游标分页（?before=<id> 前插合并去重） // v444: Inbox 节能模式——窗口不可见断 WS 转 60s REST 轮询（dm-ui 断 WS 只维护未读数 / gaea-host 徽章 WS 同款节能 + 重连指数退避 5s×2 封顶 30s，根治服务器重启重连风暴）+ 双 WS 未读数通道分工（gaea-host=后台徽章常驻通道, iframe=前台实时渲染） // v443: Roam 标签 hover 召回提示——X 区 gaea 分组最左 Roam 标签悬停瞬间弹出大字号 tooltip「按 Tab 或 F2 键召回我」（.qqq-roam-tip 固定定位 20px 粗体，贴按钮下方，底部越界自动翻到上方；tab-manager.js addGaeaTab 内绑定 mouseenter/leave） // v442: 全部 goods iframe 页补 F2/Tab 非编辑态转发（rage/search-ui/git-ui/dm-ui/kope-a panel.html 五页，同 conv-ui 模式——iframe 内按键不冒泡父窗口）→ 任意 goods 面板一键跳 Roam // v441: 上下文背包 conv-ui.html 补 F2/Tab 非编辑态转发父窗口（同 ai-panel 模式，iframe 内按键不冒泡 → 背包页也能一键跳 Roam） // v440: V23 自动阀值触发条件改为 absolut 可回收收益（按钮一数字）超阈值，出厂默认 600→100K tokens // v439: 背包图解 ╔K 统计修复——多工具合并行（[A → run_command+read_file]）拆分归属绝对工具 + ╔K 判定窗口 80→160（长头行边界漏判），图解绝对盒体部与 absolut 按钮收益对齐 // v438: vibe 豆腐块名称免费窗口内替换为「剩余/预算」数字（1 位小数，如 1.3 / 4.1），非免费恢复活动名 // v437: 原料弹窗文字/按钮全链路 #d98a86→#d9645c（标题/数字/高亮/关闭/CTA/领取钮，外边框保持淡红）+ 网站徽章同步 #d9645c // v435: 原料弹窗全窗淡红（标题/数字/高亮/关闭/CTA 归位 #d98a86，消灭绿色残留） // v434: 原料与基本权利淡红定案（#d98a86 纯色无渐变，v430 已落地，本号强制刷新旧缓存） // v433: Roam 崩溃根治（frag 变量提升陷阱）——loadFileList 的 frag.appendChild('..' 项) 在 var frag 声明之前执行（var 提升为 undefined）→ TypeError reading 'appendChild' → 列表区只显示报错行；frag 创建提前到 try 块首行 // v432: // v432: Roam 按钮 tooltip 原汁原味——szMode/sortBy/open/filesOnTop 8 按钮补 data-tooltip（q3 i18n 中文原文）+ New file/folder 改中文 + paste-tip 已粘贴 + tooltip 单位修复（zoom 0.85 下 innerWidth/clientX 报物理 px 而 fixed/maxWidth 用 CSS px，_ttZoom 统一 → 右边界保护失效/退避错 17.6% 根治）+ mouseenter 未命中不隐藏（q3 语义防闪烁） // v431: F121 三处防崩加固（card-pool getOrCreate _container 兜底 / _appendToCard $messages guard / _buildFloorDOM userEl guard）+ frame-renderer 图片文件名 `_` 变体容错（旧格式 token 引用新格式文件 404 破图 → exists 校验后切换） // v430: 原料与基本权利配色回归淡红 #d98a86 纯色无渐变（外框+状态区条+弹窗条+领取按钮），网站徽章同步 + 星火计划黑底白字 // v428: Inbox 永久联系人+国旗（服务端随消息下发 phone_e164+country_iso2，联系人一次建联永久展示，国旗本地 flags/{cc}.png 照登录区机制；历史会话重启即恢复） // v427: 原料与基本权利配色淡红→橙 // v427: 原料与基本权利配色淡红→橙（边框/进度条/弹窗/按钮全链路 #cb4b16，与网站徽章一致；2026-08-09） // v425: Roam 喂 AI 支持多选——a 键/右键 AI 项遍历全部选中项（selectedItems 逐个 __qqq_aiFeedFile，排除 '..'；单选/右键兜底不变） // v424: 空壳自愈加固——楼层空壳仅归档真空壳（含 all.txt/snapshot/img 的数据目录不归档）+ quest 级空壳归档（_healFloorCounters 零楼层目录 30min → .trash，草稿晋升崩溃残留收敛） // v423: 活动豆腐块清爽↔vibe 配色互换（清爽绿/vibe 蓝）+ 暗色主题进度槽浅色区分 + 弹窗进度槽可见度提升 // v422: Roam 自动感知防幻影闪烁——loadFileList diff 签名（name+type+sz 动态列）无变化零重建 + replaceChildren 原子换入（无 innerHTML='' 空白帧）+ 主进程 250ms 事件突发合并 // v421: 空壳楼层目录自愈（loadAllFloors 无 all.json + mtime>30min → 移入 _qqq/quests/.trash 归档，根治空目录永久残留） // v420: 国旗永久化（login.js 同账号永不重渲染徽章，根治偶发闪烁）+ 徽章图失败重试一次 + 白嫖榜 {ge} ReferenceError 修复 // v419: 内嵌弹窗统一滚动条 100% 等同 a 窗口（设置/排行榜/在线用户/活动弹窗/AI悬浮预览/开新窗口下拉/语言下拉，shell-base.css 一处定义） // v417: 字符→token 估算系数 2.7→2.5 全系统统一（唯一真理源 ContentGateway.CHAR_PER_TOKEN） // v416: 背包压缩按钮数字左侧改 3px 空气墙（-13k 与 absolut 不再粘连）+ 压缩动画时长翻倍（0.8s→1.6s）定格加长（3s→6s） // v415: 工作空间记忆边界加固——recentFolders OS 兜底（本地 recent_folders 丢失拉回+回写）+ fresh=1 不写全局恢复点 + 死路径记忆跳过（防面板永久空白）+ ws.sq3 跨进程 LWW 合并（防双进程丢 key） // v414: 工作空间记忆独立 ws.sq3（%LOCALAPPDATA%/qqqide/ws.sq3，删工作空间记忆不污染 ai.sq3 其他记忆块）+ 恢复链改本地优先（启动目录 global.sq3 → OS ws.sq3 兑底回写，多绿色包不串）+ ai.sq3 ai.workspace.* 一次性迁移 // v413: 工作空间记忆 OS 级唯一真理（ai.workspace.*，异常退出不丢）+ 面板绑定兑底轮询（空白窗口手动加主文件夹后不再全空）+ 主文件夹变更自动重载重绑 // v412: F13 关闭确认根治——废除 beforeunload 拦截-重试收敛（三面板全拦截 + hidden iframe setTimeout 节流 60s → 回车后窗口永不关/60s 自动关误认闪退），改 fire-and-forget 尽力保存 + 不 preventDefault → 确认后窗口立即关闭 // v411: // v411: quest-store 降噪——loadAllFloors 孤儿/新发现/缺失楼层逐行打印改汇总（一次启动 200+ 行 → 3 行）；repair 改名与 loadAllFloors 并发竞态重试（防 70+ FAIL + 双 rebuild 风暴）；floor_counter 键缺失 seed（heal 启动对账 + nextFloorNum 运行时自愈） // v410: Roam 滚动块再左移 2px（thumb right 7px→9px） // v409: new_log 双日志限容回归——toolpush 逐house快照恢复（目录 4MB FIFO 删最旧）+ render-log.jsonl 恢复（主进程 append 侧 2MB 双代轮转 .1，总量 ≤4MB） // v408: F107 滚动块——① Roam thumb right 1px→7px 左移 6px 对齐老板 ② 三处自定义滚动条（Roam customScrollbar / AI 面板 qh / AI 视口 qh）拖拽期间保持粗态：左键按住不松开时光标移出滑轨 x 范围也不再收缩（drag-active class / _thumbDragging / _sbDragging 门控） // v407: new_log 精简——删 toolpush-f*.json 逐house快照（7160文件/143MB）+ render-log.jsonl（标注用后即删）；agent-*.log 保留但 30 天自动轮转 // v406: F10 楼层丢失根治——①编号统一（recovery 楼层 totalFloors 同步目录号，biscuit 不再错位）②完结密封（压缩后禁重复保存，conv=0 覆盖根治）③恢复路径清 _compressFloor ④V21 截断收紧（仅当前楼层 compress 才截断）⑤rename 失败降级复制 // v405: Roam 粘贴二进制损坏根治（F106：iframe RPC proxy 缺 fs.writeBase64 → base64 被当 UTF-8 文本写入 → zip/png/mp3 全部打不开；已补 writeBase64 代理 + 禁静默降级） // v404: Roam 自动感知外部变化（q3 autoWatchChanges 移植，默认开）：主进程 fs.watch 当前目录（6s 冷却 + 临时下载文件智能过滤 .crdownload/.part/.tmp）→ qqqide:roam:fs-changed → iframe reloadCurrentDir；Roam 手动刷新 watchMark 重置冷却防双刷 // v403: 关闭确认 F10 根治——panel-send 保存完成重试改走主进程 IPC closeConfirmed（iframe 内 window.close() 是 no-op 永不关窗）+ Enter 主路径 force 隐藏确认框 // v402: quest-store 洪泛根治 // v402: quest-store 洪泛根治（同号目录 all.json 优先解析 + 仅真实重复告警 + _fDir 跨项目写保护）+ 面板启动主项目稳定性绑定 + 移除 Space+Q global 死绑定 // v401: F2/Tab 根因修复（bootKeyHook 把 key-bindings.json 对象误清成空数组 → 零绑定 → F75/F99 handler 从未被触发；现保持 {version,bindings} 对象直传 init） // v400: F2/Tab 激活 Roam 兜底直连（shell.js bootRoamKeyFallback 独立 capture 监听，key-hook 配置链失效也不静默） // v399: 1/8按钮只显示编队字符（去 ■ 前缀） // v398: 关闭确认无限循环根治（panel-send.js beforeunload 一次性拦截：保存完成前只挡一次，window.close() 重试不再被二次拦截 → 回车/确认后窗口必关，X 不再失灵） // v397: 关闭确认修复三件套——主窗口关闭不再连带销毁其他窗口 + 确认关闭走 close() 触发 beforeunload 持久化刷盘 + Enter/Esc 改 webContents 级捕获（iframe 焦点 100% 响应） // v396: Monaco TS/JS worker stub（诊断全禁后零职责，根治 Could not find source file e%3A 噪音） // v395: 窗口编队 squad（squad-btn.js 菜单行2 LV 左侧按钮+下拉，标题 x■ 前缀，Space+key 召回） // v394: activateRoam 诊断日志 + qoast 可见反馈 // v392: Roam Q 键=开新窗口(主文件夹=选中目录,restore 工作空间) W 键=系统资源管理器打开目录 // v391: Roam 左侧栏文字左移 6px（盘符 nav-item / qq-item / qq-text / qq-file 四规则 padding 10→4 / 18→12） // v390: 背包图解 Q/A ×1 bug 修复（楼层分割正则少一个等号，lookahead 永远不匹配 → 93 层只统计 1 个 Q/A） // v389: F2/Tab 激活 Roam 修复（F99: activateRoam 改走 qqTabs.activateTab，旧实现 btnEl/paneEl 字段不存在导致切换从不生效）+ AI 面板 iframe 转发 F2/Tab // v388: V21 onlyfacts 守卫恢复 32K + compress 楼层跳过 biscuit 占位 + 防 _compressFloor 泄漏 + compress 消息全量清理 // v387: 压缩按钮收益数字去除左侧空格（'-13k' 紧贴按钮文字） // v386: Roam btnNewFolder 按钮标签粘连修复(F73残留) + 619 null防护 // v385: 右键菜单粘贴去重（图片+文本共存只插一次文本，修重复插入） // v384: AI 面板多图粘贴（Ctrl+V 全量收集 + 串行保序 + 三重硬帽） // v383: 三活动豆腐块边框换色（清爽淡蓝 #3f96d8 / 原料淡红 #d98a86 / vibe 绿 #859900） // v382: 国旗唯一渲染机（login.js 竞态根治 + flag 归一 + onerror） // v381: F2 key binding + window.activateRoam handler now activates X-zone tab + focuses iframe // v380: Roam dark theme hover highlight + path-tooltip distinction // v379: Roam empty ctx menu click fix + btnNewFile/btnNewFolder data-tooltip + doCreateFile blur // v378: 修复活动豆腐块 CSS 损坏(注释吞掉 done-fill/.qqq-act-txt 规则) + 满格不再把原料边框改绿 + 赞助商链接常态同色永不下划线 + forced-color-adjust 兼容 Windows 高对比度(进度条渐变被强制抹空) // v377: newline-btn 移到编辑框外右上角（子弹按钮上方） // v376: Roam 文件菜单仅 6 项(AI/code/open/delete/rename/copyPath), 空区菜单复活(CMD=c/PowerShell=x 仅两项) // v374: AI 等级弹窗自定义无轨滚动条(5px)+文字可选中复制 // v373: newline-btn 移到编辑框右上角外侧（子弹按钮左侧） // v372: 赞助商拆分（前缀不带链接+公司名超链接）+ 原料活动边框偏红 + vibe 前缀文字与赞助商 100% 同外观 // v371: vibe 豆腐块常态发光+边框统一 + 状态区免费/非免费统一显示剩余时间 + 距下次/剩前缀同赞助商文字外观 // v369: 赞助商链接改为 por.jsp?id=1&_jcp=5_1 // v368: 赞助商移至三盏绿灯之右 // v367: 状态区排序还原 + vibe 豆腐块边框统一 // v366: 状态区单行 + 窄窗口退避隐藏 + vibe 余额解析修复 // v364: 赞助商 hover 橙色 // v363: 状态栏左下角赞助商文字（zhijiaip.com） // v362: index.html 恢复 klipzap.js + wq-stats.js 加载（F73 误删） // v361: Roam 文件/文件夹名左移 2px // v360: Roam 右键 AI 菜单项（←AI/AI/AI→ 焦点面板）+ CMD 快捷键 a→c
const PRECACHE_URLS = [
  './',
  './index.html',
  './core/shell-base.css',
  './core/shell-main.css',
  './core/shell-widgets.css',
  './core/shell.js',
  './core/shell-lang.js',
  './core/shell-menu.js',
  './core/shell-wings.js',
  './core/shell-overlay.js',
  './core/shell-statusbar.js',
  './core/shell-activities.js',
  './core/shell-rpc.js',
  './core/ipc-bridge.js',
  './core/menu-schema.js',
  './core/editor.js',
  './core/editor-breadcrumb.js',
  './core/guard-meta.js',
  // WYSIWYG paste pipeline (v306)
  './core/__stamp.js',
  './core/klipzap.js',
  './core/wq-stats.js',
  './core/anchor-map.js',
  './core/frame-renderer.js',
  './core/thumbnail-cache.js',
  './core/content-widget.js',
  './core/qqq-viewzone.js',
  './core/paste-router.js',
  './core/transaction-manager.js',
  './core/batch-ops.js',
  './core/progress-service.js',
  './goods/file-explorer/file-explorer.js',
  './goods/git/git-diff-window.html',
  './goods/git/git-ui.html',
  './goods/git/git.js',
  './goods/kmd/kmd.js',
  './goods/kmd/kmd-ui.html',
];

// ----------------------------------------------------------------------------
// Install: precache critical shell. Failures must NOT block install.
// ----------------------------------------------------------------------------
self.addEventListener('install', evt => {
  evt.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // Use individual put() so a single 404 doesn't fail the whole batch.
      await Promise.all(PRECACHE_URLS.map(async url => {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res && res.ok) { await cache.put(url, res.clone()); }
        } catch (_) { /* ignore single asset miss */ }
      }));
    } catch (_) { /* ignore */ }
    await self.skipWaiting();
  })());
});

// ----------------------------------------------------------------------------
// Activate: clean old cache versions, claim clients.
// ----------------------------------------------------------------------------
self.addEventListener('activate', evt => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function isHealth(url) { return url.pathname.endsWith('/health'); }
function isHTML(req) {
  return req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
}
function isAssetScheme(url) {
  // Skip our custom electron-served scheme entirely.
  return url.protocol === 'qqqide-asset:' || url.protocol === 'devtools:' || url.protocol === 'chrome:' || url.protocol === 'file:';
}
function isLocalService(url) {
  // Bypass localhost / 127.0.0.1 — these are local goods APIs (kope, etc.), not web assets.
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}
function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

// network-first with timeout, write-through cache.
async function networkFirst(req, ms) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await Promise.race([fetch(req), timeout(ms)]);
    if (res && res.ok) {
      try { await cache.put(req, res.clone()); } catch (_) { }
    }
    return res;
  } catch (_) {
    const cached = await cache.match(req) || await cache.match('./index.html') || await cache.match('./');
    if (cached) { return cached; }
    return new Response(
      '<!doctype html><meta charset=utf-8><title>offline</title>' +
      '<style>body{background:#fdf6e3;color:#586e75;font-family:sans-serif;padding:40px;text-align:center}</style>' +
      '<h2>qqq-shell · offline</h2><p>无可用缓存。请稍后再试。</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// ★ Network-first with cache fallback (2026-08-02 fix).
//   旧逻辑 cached || fetched 导致永远返回缓存->开发时改磁盘文件不生效。
//   新: 优先网络->成功后更新缓存; 网络失败->回退缓存(ignoreSearch 去 _v 参数)。
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      try { cache.put(req, res.clone()); } catch (_) { }
    }
    return res;
  } catch (_) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return new Response('', { status: 502, statusText: 'Gateway Error' });
  }
}

// ----------------------------------------------------------------------------
// Fetch routing
// ----------------------------------------------------------------------------
self.addEventListener('fetch', evt => {
  const req = evt.request;
  if (req.method !== 'GET') { return; }
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Skip schemes we shouldn't touch.
  if (isAssetScheme(url)) { return; }
  // health: never cache.
  if (isHealth(url)) { return; }
  // ★ API 调用：不拦截（登录轮询、AI 网关等）
  if (url.pathname.indexOf('/api/') !== -1) { return; }
  // ★ 构建戳记：永不缓存（百分百稳妥机器）
  if (url.pathname.indexOf('_BUILD_STAMP.json') !== -1) { return; }
  // ★ 本地服务：不拦截（goods 进程 API，如 kope-a:19820-19829）
  if (isLocalService(url)) { return; }

  if (isHTML(req)) {
    evt.respondWith(networkFirst(req, 2500));
    return;
  }

  // Same-origin static -> SWR.
  if (url.origin === self.location.origin) {
    evt.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Cross-origin (e.g. CDN font) -> cache-first best-effort.
  evt.respondWith(staleWhileRevalidate(req));
});

// ----------------------------------------------------------------------------
// Message: allow page to trigger skipWaiting / clear-cache from devtools.
// ----------------------------------------------------------------------------
self.addEventListener('message', evt => {
  const data = evt.data || {};
  if (data.type === 'skipWaiting') { self.skipWaiting(); }
  if (data.type === 'clearCache') {
    evt.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    })());
  }
});
