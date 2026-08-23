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
const CACHE_NAME = 'qqq-shell-v605'; // v605: 删除 SW controllerchange 自动 reload（2026-08-23 q220 f10）——F5 加的「SW 切换控制权自动刷新」在 SW 首次接管页面时同样触发（无控制→有控制），每次启动（缓存清空/SW 字节变化）无条件 location.reload → 「启动完立即又重启一次/闪两个窗口」实锤。删 reload 保留 skipWaiting：资源 network-first 旧 SW 控制期间照样回源拿最新，Ctrl+R 一次生效承诺不受影响 // v604: secret.maskHelp 出厂默认关（2026-08-23）——绿色包首装不自动开 dsecret（settings.js defaultValue + secret-guard.js get 兜底 + catch 兜底三处同步 false），用户设置→高级手动开启 // v603: Monaco 右键菜单左右退避真终局（2026-08-23）——F2-F8 五轮 document 层 clamp 全失效根因：Monaco 0.34.1 useShadowDOM 默认 true → 右键菜单 .context-view 渲染在编辑器 shadow root 内，document.querySelector 恒 null、body observer 不可见、closest/contains 不穿透 shadow root → clamp 从未执行过（颜色/箭头走主题色+addAction 内部链路所以正常，用户观察完美吻合）。修：_makeEditorBaseOptions 显式 useShadowDOM:false（主编辑器+split view 唯一真理源一处生效），diff-edit.js/diff-render.js/git-diff-window.html 同修——菜单回 document，F8 三件套（style 属性观察+rect-delta 相对修正+编辑器边界兜底）与 shell-main.css .context-view 规则全部生效 // v602: Monaco 右键菜单左右退避终局修复（2026-08-23）——F3 childList 观察只在 render 时触发一次 + Monaco doLayout 相对偏移语义（style 值 = 目标 - 当前页面位置）会吃掉修正值 + closest('.monaco-editor') 失败退化窗口边界（Monaco 自身也按窗口避让 → 双双认为放得下 → 菜单悬在编辑器右缘外）三重失效。修：①attribute observer 观察 style 写入（每次 Monaco 定位后 microtask 修正，永不被覆盖）②rect-delta 相对修正（fixed/absolute/container 偏移全免疫，delta=0 防自激循环）③编辑器边界兑底（_allMonacoEditors contains 判定）；每次右键重试挂 observer // v601: 右键菜单 hover 对调（2026-08-23）——editor 白主题 hover 改 AI 面板大中小搜索色 #fdf6e3（qqqide-theme.js + diff-edit.js fallback 同步），AI 面板黑主题大中小搜索 hover 改 editor 金 #b58900（ai-panel/index.html）// v600: secret-guard 四防线（2026-08-23 q215 f9）——① T2 降级协同（五次误伤全是 T2 自动抹除）② 语法门自动回滚（抹除后语法验证失败 → 不落盘转协同 + GATE-FAIL 审计）③ 引擎陈旧自检（SG_VER 比对，stale → 零自动抹除只读协同）④ 文件类型分流（自动抹除仅限配置/文档类，源码类一律协同）；_skipValue 收紧全大写枚举/冒号组合；_eraseOne 人工路径同过语法门 // v598: 喂给 AI 方向箭头接线修复（2026-08-23）——__qqq_aiTarget 恒为默认 1 根因：面板发 qqq-ai-panel-focused 但父窗口从未监听 → ai-viewport.js 补消息监听（焦点面板 0左/1中/2右 → 更新 __qqq_aiTarget），编辑器右键「喂给 AI」标签箭头 + 层级水印 + Roam AI 项 + 视口注入目标全部跟随 // v596: secret-guard 五次误伤修复（2026-08-23 q178 f93）——panel-quest-ui.js L1369 `var token = ***REDACTED*** && ...` 二次被 T2 抹成 ***REDACTED***（04:43:14 UTC 旧引擎扫描，F85 补丁后热更前）+ secret-guard.js 自己中招；已恢复原值 + 确认 /^[([]/ 规则在磁盘完好；全仓残留扫描干净 // v595: Monaco 右键菜单边缘躲避升级（2026-08-23）——边界从窗口改为触发菜单的编辑器 DOM：光标靠右缘 → 右上角锚定向左展开（旧实现只钳 window 边界，菜单照样盖住编辑器右侧区域）；同步修正零闪烁（MutationObserver 渲染前触发，弃 rAF 晚一帧）+ 子菜单 holder 排除 + fixed/absolute 双坐标系换算 // v594: Monaco 右键菜单 Solarized 配色（menu.* 主题色，Monaco inline style 唯一来源）+ 喂给 AI 方向箭头（←📎 喂给 AI / 📎 喂给 AI→） // v592: 自动 onlyFacts 结算修复（2026-08-23 F88）——pending 立即落盘 + settlePending 无条件结算（q178 f87：per-quest full 档触发后取消勾选 → lastAutoExtract 永不记录 → G1 冷却失效实锤） 项目主题色 var(--blue)（:root 已定义为橙金 #e8a030/#d4a017，与设置页滑杆同色，亮暗主题自动跟随） // v590: 独立滴压缩策略（2026-08-23）——压缩卡片新增勾选框：勾选后展开三点拉杆（关闭/中等/全托管）仅对当前任务生效立即生效；覆盖值存 ctx.json compressLevel（panel-quest.js payload + panel-floor restore 恢复），compress-machine getLevel(agent) 优先读覆盖再回退全局；取消勾选删除覆盖立即回退全局设置 // v589: 自动压缩设置项精修（2026-08-23）——标题改「自动压缩 上下文背包」+ 描述改一句话「默认值为中等」+ stopsLabels 中度→中等；标题右侧加问号按钮（外观照搬 ctx-panel #ctx-help，点击跳转 docs/qqqide-2）；拉杆宽度 = 音量 5 点拉杆的一半（flex:0 0 calc(50% - 22px)，点间距与音量百分百一致） // v588: 自动压缩机器 compress-machine.js（2026-08-23）——三档滑杆 ai.compressLevel（off/medium/full）替代 ai.compressThreshold 阀门值：V23 preHouse absolut 自动压缩退役（F80 一锅端定案，从不单独做 absolut）；楼层完结后 editOnly 自动一锅端（medium 收益≥64K / full ≥32K）+ full 档自动 onlyFacts（原料≥32K、距上次成功≥5 正常楼层、失败重试≤2/周期、postFloor 主 + preFloor 兜底、G5 定序 editOnly→onlyFacts）；settings 滑杆 showLabel 变体（关闭/中度/全托管）；agent-context 死代码 _readCompressThreshold/_stripAbsoluteBoxes/_estimateAbsolutBenefit/_tryAutoValveCompress 删除 // v585: absolut 自动压缩阀值出厂默认 100→50k，范围 100~1000→0~1000（defaults.js 真理源 + settings.js min + agent-context/agent-loop/content-gateway 校验与兑底同步） // v584: 上下文压缩卡片文案重写（2026-08-23）——标题「上下文背包 V24 引擎」，正文改为用户友好短文案（长程任务点管理减重 + 最佳实践 100k 阈值建议），删机械筛/三按钮/fx Grid 内部术语 // v581: renderMarkdown 表格转义管道符二次根治（2026-08-21）——_splitRowCells 从占位符替换升级为逐字符扫描（\| → 字面 | 不拆列；\\ → 字面 \；\\| → 字面 \ + 拆列，GFM 严格语义）；gaea 网站 docs-viewer.js renderTable 同源缺陷同步修复（split('|') 不识别 \| → panel_re{l|c|r}.json 破表实锤）。测试 9/9 + 8/8 PASS // v580: renderMarkdown 表格转义管道符修复（2026-08-21）——单元格内 \| 不再被 split('|') 当列分隔符（破表根因），改占位符替换后还原为字面 |；表头/表体统一走 _splitRowCells；GFM 语义 \\| = 字面 \ + 分隔符。AI 面板 + 悬浮预览层（open-table 复用中面板 HTML）双处同时生效 // v579: dsecret goods（2026-08-21）——密钥脱敏专职控制台：goods/dsecret/{dsecret.js,dsecret-ui.html} X 区 custom tab（菜单行2 按钮），中转 core/secret-guard.js 新导出 __qqqSecretGuard API（scanProject dirty/full / act / getData / removeWl / gitLogSearch / gitIgnoreAdd / setEnabled / onDirty）；gaea-host toolbarIds + dsecret；secret-guard 抽 _parsePorcelain + _processFile 返回 auto + 全量遍历 _walkFiles // v578: 悬浮预览层底层 bug 三修（2026-08-21）——① renderMarkdown 代码块/行内代码延迟恢复（[文字](URL) 不再被 Links 规则误转成真实链接，悬浮预览里代码变蓝色链接实锤）；② 主窗口全局 target=_blank 链接 capture 拦截 → 外部浏览器（shell.js）；③ 预览层链接主题色禁蓝（shell-overlay.js）；④ secret-guard 表达式误伤修复（parsed.xxx.get('token') 不再被抹坏源码） // v577: 协助密钥脱敏（secret-guard.js 新增，订阅 ai-viewport qqq:git-dirty 事件；settings 高级页新增 secret.maskHelp 开关；zh.json 新增 secretGuard 文案段） // v571: vibe 弹窗历史充能框 v5（2026-08-20）——填充改固定纯色层（.qqq-vibe-hist-fill 宽度=百分比，颜色恒 rgba(42,161,152,.85)，不再按填充长度压缩蓝→黄渐变）；标题行样式恢复 F57 删除前版本（12.5px/700/#8fa3c8/margin 0 0 8px） // v568: vibe 弹窗历史充能框 v3（2026-08-20）——删标题行「前 8 次免费窗口」；框 56×30→54×28（上下窄 2px 左右窄 2px）、间距 2→4px；配色换绿黄系（填充 rgba(42,161,152,.85)→rgba(133,153,0,.8)，边框 rgba(133,153,0,.55)，原蓝系）；删 act.vibe.histTitle 键 // v567: vibe 弹窗历史充能框 v2（2026-08-20）——单行 8 个 56×30 圆角矩形仅显数字（摇出额度），背景填充百分比=充能（剩余比例，满=没用过），hover 瞬间弹出框只显示该窗口实际已用额度（data-used）；删 track/fill/used 样式与 act.vibe.histUsed 键 // v566: 赞助商状态栏回归静态位置（2026-08-20）——品牌名恢复单 <a> 基线对齐（原 roll 盒 vertical-align:bottom+height 1.25em 致下偏 2px）；轮换去跑马灯动画改瞬间替换文字（防视觉分散）；hover 变色恢复（.qqq-sponsor-link:hover 重新可命中）；CSS 删 .qqq-sponsor-roll/-track 盒样式 // v565: vibe 弹窗「前8次免费窗口」充能框区域（2026-08-20）——服务端 /api/qqq/free-budget 新增 history 数组（最近 8 个历史窗口，排除当前，时间正序，每项 budget_ge/consumed_ge/remaining_ge，ledger FreeBudgetHistory 方法）；客户端弹窗内圆角矩形充能框一行：大数字=该窗口摇到滴额度（1 位小数），充能条=剩余比例（vibe 蓝渐变），小字=实际已用；弹窗打开强制拉最新（fetchVibeBudget force 参数）+ 失败旧缓存兜底；zh.json 新增 act.vibe.histTitle/histUsed // v564: vibe 弹窗免费时段行时区化（2026-08-20）——先显示「免费时段：(UTC) 周日全天+每日01:00-03:00/13:00-15:00」2 秒后渐隐（0.6s opacity），切换为「(用户系统时区) 周日全天+每日{本地换算区间}」渐显固定（Intl.DateTimeFormat().resolvedOptions().timeZone 权威，失败兑底 UTC；区间按 getTimezoneOffset 分钟换算跨日取模，如 +8 → 09:00-11:00/21:00-23:00）；新增 act.vibe.popWindowLocal 键，旧 popWindow 文案同步改 UTC 版 // v563: 队列直通发送定案（2026-08-20）——排队消息不再经过编辑框（直接 intent 载荷）：编辑框草稿（文字/图片）永不被队列触碰/覆盖，草稿保护机制整体废除，自动暂停唯一来源=人工点暂停；点「继续」只清标志+排水，不再把未完成草稿入队发送（用户实锤 bug）；_executeSend 图片源 intent.images 优先 + fromQueue 不清空编辑框/图片条 + fatal 拦截复位排水锁；_rescueDraftToQueue/ai.queue.draftKept 删除 // v562: 修复图片预览「文件/路径」按钮误报无本地文件（2026-08-20）——楼层图片恢复/在线渲染时 dataUrl 缩略图优先，磁盘路径（_fDir+fileName）丢失，overlay 解析不出路径。修复：open-image 消息新增 localPath 字段（card-pool.js 恢复渲染 dataset.localPath + badge/展开按钮透传、panel-pipeline.js 在线 badge 动态 resolveFloorDir、panel-send.js openLightbox 第三参），overlay 三按钮优先 _ovLocalPath。v560 为图片专用三按钮（内存/文件/路径）。链路：shell-overlay.js 三按钮 → 主进程新增 qqqide:clipboard:writeImage（ipc-misc.ts nativeImage）+ 既有 writeFiles/writeText。// v561: 修复图片预览「文件/路径」按钮误报无本地文件（2026-08-20）——楼层图片恢复/在线渲染时 dataUrl 缩略图优先，磁盘路径（_fDir+fileName）丢失，overlay 解析不出路径。修复：open-image 消息新增 localPath 字段（card-pool.js 恢复渲染 dataset.localPath + badge/展开按钮透传、panel-pipeline.js 在线 badge 动态 resolveFloorDir、panel-send.js openLightbox 第三参），overlay 三按钮优先 _ovLocalPath。v560 为图片专用三按钮（内存/文件/路径）。链路：shell-overlay.js 三按钮 → 主进程新增 qqqide:clipboard:writeImage（ipc-misc.ts nativeImage）+ 既有 writeFiles/writeText。// v559: Roam 标签恢复大写 R（2026-08-20）——tab-manager 硬创建 + rage.js 注册 title 改回 'Roam'（品牌全小写化时被改），文字左移 2px 宽度不变（shell-main.css .qqq-tab-name translateX(-2px)）。v558: AI 面板图片 hover 新增「Roam」按钮（2026-08-20）——点击激活 roam tab + 聚焦 + 跳到图片所在目录并选中（q211 f8）；链路：ai-panel card-pool/panel-render → shell-overlay reveal-in-roam → q2-roam qqq-roam-cmd roam.revealFile。表格/代码块零改动。v557: 队列自动暂停自愈（2026-08-20）——暂停分人工/自动两态：仅暂停按钮置 _queuePausedManual，草稿（文字/图片）触发的自动暂停在楼层完结（panel-pipeline 自愈）或草稿清空（updateQueueBtn 自愈）时强制恢复，永不粘死；点「继续」草稿随行入队尾零丢失（队列满保持等待+qoast）；纯图片草稿不再被队列发送静默覆盖；死代码 _continueQueue 删除 // v556: AI 面板输入区布局定案（2026-08-20）——队列信封移到图片条上方（历史→队列→当前输入 时间序）：图片属于当前编辑消息应紧贴编辑框，队列是已提交待发消息组应贴近消息区；DOM 顺序交换（queue-strip 在 image-strip 前），两条 display 互控独立、getElementById 零兄弟依赖，无边界情况 // v555: 原料活动二选一锁定 UI（2026-08-20）——领过任一项后两按钮同时置灰不可点（claimable && !claimedGe && !claimedPhone，服务端 claimable 同步排除已领）；已选过 qoast（act.ge50.already/alreadyOther）及相关逻辑删除，already 分支改静默同步状态；充值门槛服务器 .env 5→50 // v554: 在线用户弹窗新增「独立」列（2026-08-18）——连续(m) 与 版本 之间，数据 = doer_state.independent_count（断开>1h 再上线 +1，服务端 migration 0031） // v553: kope-a 离线横幅选择器作用域修复（2026-08-18）——横幅挂 historyContainer 但查重/隐藏查 historyList 永远查不到 → 每次断线叠加新横幅（434 多次打印根因）+ kope 在他处启动后横幅永不消失；查重改同层，隐藏改 querySelectorAll 清历史残留 // v552: conv 格子选中色改传统黄（2026-08-18）——::selection 从 kmd 灰系（#d6d6d6/#073642）改为项目主流黄色系（light #ffd301/#000 · dark #6a5a10/#f0e8d8，git/search/roam/overlay 同款），用户要求 editor 传统黄底 // v550: conv 背包页刷新机制定案（2026-08-18）——① 删手动刷新按钮 + 删整个 toolbar 行（回收 y 轴）；2s 轮询升级为 conversation 指纹检测自动重建（消息数+尾部3条 content/tool_calls+ctx 饼干/facts 条数，流式/新消息/压缩/恢复全部覆盖，格子永远实时）② ⊞⊟ 移到压缩工具栏最左（margin 0 / 0 4px 0 2px，goods search 同款）——旧 .toolbar button 特异性覆盖 .cbtn 致 18px 小方钮从未生效（丑的根因），删 toolbar 后 cbtn 样式真正落地 // v549: conv 背包页微调（2026-08-18）——① tab 标题去 📋 前缀（固定文本「qxxx 上下文背包」纯文字）② 复制按钮不再独占一行——仿编辑器面包屑同款：hover 格子文本区时 📋 悬浮浮现于内容右上角（cell-copy-btn 绝对定位，删除 cell-actions 行） // v548: conv 背包页工具栏重构（2026-08-18）——① tab 标题固定文本「qxxx 上下文背包」（弃 questStore.list 异步补齐）② 删全选/取消/搜索框/「选中格子→新对话」整条链（选中机制+openNewQuest+selectAndGo+panel-state qqq-conv-new-quest 监听全删——格子内容本就全在 AI 上下文，显式再注入零增量；保留「复制此格」）③ 全部展开/折叠改 cbtn 小按钮 ⊞/⊟（仿 goods search 百分百同外观）④ bottombar 删除回收 y 轴 // v547: run_command 多行命令静默失败根治（2026-08-18 F146 实测）——Windows 整串 shell:true 时 cmd /d /s /c "python -c "a\nb"" 嵌套引号配对错乱 → 输出消失+后续命令被吞（多行 python -c/node -e 全静默）；tools-exec-effect.js 多行命令安全分词 → 数组 spawn（shell:false CreateProcess 直传，换行在参数里合法），仅引号外无 cmd 语义元字符（&|<>^% / cd 开头）才走数组，保守分流 // v546: conv 背包页顶部信息行整体删除（回收 y 轴；格子/字符/估算/API 统计 + 标题行全移除，刷新按钮移入 toolbar 仅图标+title tooltip）；tab 标题修复 questStore.getTitle 不存在→异步 list() 补齐（tab 恒显纯 qid 根因） // v545: 全局 x 键召回 kmd（2026-08-18）——非编辑态 x 立即打开一个新 kmd（key-bindings 新增 window.activateKmd + shell-menu handler：路径优先级 = iframe 转发携带 path（kmd 自转发=自身 cwd）→ 活跃文件 tab 父目录 → 工作空间根；shell.js 兜底直连同款双保险）；kmd 多开语义定案——roam x/右键/全局 x 一律新建 kmd tab（弃 cd 复用）+ 播放终端音效 zs861（_playRoamSfx 300ms 去重）；kmd-ui 转发块 x 带自身 cwd（window.__kmdCwdGet）；其余 7 个 goods iframe 转发块（ai-panel/conv/dm/git/kope/rage/search）同步支持 x；菜单行2 kmd 按钮 hover 大字号 tooltip「按 x 键打开一个新 kmd」（复用 .qqq-roam-tip 样式 + data-owner 重建清理） // v543: inbox sidebar 精简（2026-08-18）——删 Messages 标题行回收 y 轴空间；搜索框去放大镜图标，placeholder 改英文 find，筛选框置顶 // v542: inbox 在线/离线状态整体弃用（2026-08-18）——1h ping 窗口有 15min 上报间隔 + 1h 滞后下线，无法百分百闭环（用户定案删干净）；私聊头部不再显示在线状态，服务端 fillPeersOnline 删除 // v541: kmd 正方形菜单 hover 展开（2026-08-18）——killWrap mouseenter 即展开（不用点两次），mouseleave 500ms 延迟收起（enter 清除定时器防闪烁，菜单是 wrap 子元素视觉间隙 4px 也顺滑）；click toggle 与 toggleKillMenu 函数删除（废弃即删）；菜单项点击后关闭不自动重开（鼠标仍在 wrap 内无 enter 事件，移出再移入重开） // v540: kmd 右键菜单（2026-08-18）——custom tab 同普通文件标签：在右侧/左侧再开（onReopen 回调优先，kmd.js openKmdTab(side) 新会话+标题序号自管；未注册则 tab-manager 通用复刻 renderFn）+ 关闭其他/关闭所有；openFileCustomTab 新增 opts.group（'right'/'left'/组对象）指定目标分组；tab._custom 保存渲染闭包；contextmenu 挂载条件 filePath || custom // v539: 压缩动画 stale 缓存根治（2026-08-18 q181 f77 实锤）——_estBackpackChars 强制绕过 _estimateTokensFull 缓存（edit only 压缩不改饼干首尾 40 chars + biscuitLines 条数不变 → 缓存 key 全同 → after 返回压缩前旧值 → 动画「182k→182k/100%」静止假象，真实收益 81k tokens）；动画百分比收益 <0.5% 时显示一位小数（99.8% 诚实显示，不再裸 100% 误导） // v539: 压缩动画 stale 缓存根治（2026-08-18 q181 f77 实锤）——_estBackpackChars 强制绕过 _estimateTokensFull 缓存（edit only 压缩不改饼干首尾 40 chars + biscuitLines 条数不变 → 缓存 key 全同 → after 返回压缩前旧值 → 动画「182k→182k/100%」静止假象，真实收益 81k tokens）；动画百分比收益 <0.5% 时显示一位小数（99.8% 诚实显示，不再裸 100% 误导） // v538: 清爽从2026 已满弹窗大标题插入脱敏手机号（恭喜！86158xxxx8204 充能已满，tp 插值 {phone} + maskPhone 前5后4，方便用户截图自证） // v537: kmd 多窗口 + 命名输入框（2026-08-18）——openFileCustomTab 支持 allowMulti（每次点击开新 kmd tab，customId 自增 kmd-N）；新增 setCustomTabTitle（空标题忽略 + code point 40 截断 + textContent 防注入）；kmd-ui 工具栏 Clear 按钮收进正方形菜单第一项（原位改命名输入框，输入即 kmd:title → 标签标题实时同步，maxlength+JS 双边界保护）；roam x 键多开后只对最近 kmd 会话 kmd:cd 不再广播 // v536: 两活动弹窗副标题字号 15→17px 放大 2px（清爽「从2026开始，更轻，更快」+ 原料「你滴上下文资产现在归你」） // v534: hover 背包图解卡片右移量 10→18px（用户要求整个卡片再往右） // v532: 背包重量显示唯一真理（2026-08-18）——按钮/Free/图解 displayTotal 恒用当前背包 localTotal，弃 _lastApiPromptTokens 偏好（上次请求账单数含已压缩楼层 → 楼层间窗口/重启后僵尸数字，q178 实测 179k vs Local 64k）；hover 卡片右移 20→14px（回左 6px）；彩色格子起点回最左边界 left:-12px（空气墙恢复） // v531: hover 背包图解卡片整体右移 20px（卡片总宽 406px > 面板可用宽，左缘被面板左边界截断，q178 f59）；absolut/edit only 无可压缩内容（收益 <300 tokens）→ 拒绝不再播动画（消灭「重量减小至 100%」逻辑漏洞）；压缩动画弹窗加宽 340→460px（进度条随之左右增宽） // v530: 压缩动画底部说明行删除（用户要求）；ctx-breakdown 条形图 left:-12px→0（竖条不再侵入文字左侧 padding 区，消除「文字左移被截断」观感，q178 f58） // v528: 原料弹窗文案回归——task3 简化「累计充值满 X 元」（删历史累计注释+已累计小字）；已领取按钮恢复「额外再领取」前缀 // v527: 背包数字闭环四修（2026-08-17 q178 截图实锤）——① fx 重启后 "[object Object]" 根因（ctx.facts 是对象 {source,extracted_at,text}，restore 重建/管理页摘要直接 join 对象数组 → 15 字符 = 6 tokens，3936 字符事实全丢）；② 压缩动画 before/after 改整个上下文背包（旧=饼干 chars，用户看到 110k→11k 与右下角全背包数字对不上）；③ 饼干子项闭环——╔K 行统计=头行+体部（旧只计体部，q158 缺口 23k tokens 大头=362 个头行 15.5k）+ 新增结构行（=== F 分隔/时间戳/[S]）= 饼干总−Σ子项数学恒等 // v526: only facts 压缩白做三连修（2026-08-17 F52）——① ctx.biscuitLines 本地解析（_parseBiscuitFromContent 在 agent-context IIFE 内不可见 → 压缩后磁盘饼干保持完整，q158 f46 实锤）；② V21 截断位置 fx 注入后重定位（旧 floorStart 误删 biscuit 消息）；③ 守卫回原料口径 hText≥32K（F50 收益口径虚高 5-9 倍，q158 显示 -98k 实际原料 11k），conv-ui computeBenefits 同步 hChars // v525: 原料充值门槛口径修正（2026-08-17）——充值统计从废弃的 tx_type='recharge'（Xsolla 表线上零记录，恒 0）改为 tips 表已支付订单（geflow 充值入口，微信/PayPal，amount_cny 累计）；历史累计语义与消费达标先后无关（下周 .env 改 50 即历史累计充 50 元）；客户端第三行文案改「累计充值满 X 元（历史累计，非再充）」+ 未达标行尾显示已累计充值金额 // v524: only facts 目标 agent 解析 + streaming 闸门豁免 + 拦截回滚（2026-08-17 F51）——_executeSend 旧代码全程用面板活跃 agent：用户在别 quest 建楼时点背包页 only facts → streaming 闸门误拦（q154 实锤：子弹已写/饼干已砍半/楼层未建/toast 假成功）+ compress 标志串号活跃 agent（V21 泄漏重演）。修：① _executeSend 开头从 pool 解析 intent.questId 目标 agent（正常路径零变化）② streaming 闸门豁免 compress ③ 所有权拦截 compress 显式 qoast ④ onlyfacts handler 建楼未开始时恢复饼干+落盘+显式报错 // v523: only facts 守卫口径修正（2026-08-17）——守卫与实际收益统一：收益 = 原始 biscuit − editonly 过滤后切半的后半段；旧口径 _hText（过滤后前半段）与估算端 afterAbsolut 切半不一致，q154 显示 -33k 实际 29.6K 拒绝（实际收益 70.4K）；conv-ui computeBenefits Step3 同步同口径 // v522: 原料领取按钮文案重写——左=手机号+「额外再领取 50 元话费」（已领=「50 元话费 · 已领取」），右=「额外再领取 50 ge」（已领=「50 ge · 已领取」），删「额外再领取 已领取」不通顺组合 // v521: 恢复链接不死锁五处闭环（q198 服务中断 429 事故：_startRecovery 早退复位 busy / 渲染复用链接整体复位 class+cssText+busy / 恢复中只允许光块 / onToken 清断引用 / _finishRecovery 双类搜索） // v520: 原料弹窗新增副标题「你滴上下文资产现在归你」+ 领取按钮前加「额外再领取」 // v517: kope-a 离线提示简化——横幅改「当前面板：kope-a 未启动」，空列表不显示 Clipboard history will appear here（2026-08-17） // v516: kmd 正方形菜单 tooltip 遮盖修复（2026-08-16）——tooltip 与菜单同位置重叠（z-index 99999 vs 500）→ 菜单打开时自动隐藏 tooltip、关闭后恢复；tooltip 文案精简为一行（提示菜单用法）；hover 加 killMenuOpen 守卫（菜单打开期间不弹 tooltip）； // v515: kmd 工具栏定案（2026-08-16）——Clear + 正方形菜单都回右侧、左右互换（Clear 左、正方形右），左侧只剩 3 个 shell 按钮；键盘 Ctrl+C 全区域只专注复制（输出区/键入行：有选区=原生复制，无选区=空操作，键入行发 \x03 分支已删），中断唯一入口 = 正方形菜单第一成员 Ctrl+C； // v514: kmd Ctrl+C 语义收口——键盘输出区只复制，指令编辑框有选区复制/无选区中断；正方形菜单新增 Ctrl+C 中断项，Terminate 保持强杀； // v513: kmd 工具栏调整——Clear 固定左侧；Terminate 改为自绘正方形按钮，点击只展开危险操作菜单，菜单内仅保留无图标 Terminate；v510: kmd 全局 Ctrl+V → 指令编辑区（2026-08-16）——只要 kmd 获焦点（输出区/工具栏/空白处均生效）：document capture 拦截 → bridge.clipboard.readText()（主进程读剪贴板零权限问题）→ insertToInput 光标位插入；键入框/查找框保留原生粘贴语义不劫持；输出区 paste 事件转发（右键菜单粘贴也生效） // v509: Roam path-tooltip Area 4 补漏（q3 移植缺口 2026-08-16）——handlePathTooltipHover 只有盘符/qq区/历史区三分支，主资源列表区 .file-item 分支缺失 → 文件名被省略号截断时 hover 不弹完整路径；补 .file-item 分支（.folder-name-area/.file-name-area ellipsis 判定 → data-path 完整路径，q3 Area 4 同款逻辑，#fileList 已在 #kyContent 委托范围内无需新绑定） // v509: Roam path-tooltip Area 4 补漏（q3 移植缺口 2026-08-16）——handlePathTooltipHover 只有盘符/qq区/历史区三分支，主资源列表区 .file-item 分支缺失 → 文件名被省略号截断时 hover 不弹完整路径；补 .file-item 分支（.folder-name-area/.file-name-area ellipsis 判定 → data-path 完整路径，q3 Area 4 同款逻辑，#fileList 已在 #kyContent 委托范围内无需新绑定） // v508: only facts 修复 CPT is not defined（_CPT_loc 局部变量，panel-quest-ui.js onlyfacts handler 作用域隔离） // v508: only facts 修复 CPT is not defined（_CPT_loc 局部变量，panel-quest-ui.js onlyfacts handler 作用域隔离） // v507: kmd 切换 gitbash 无主目录时空目录不显示空行（switchShell 空 cwd 无路径抬头）（2026-08-15）——switchShell 成功后追加一行 ❯ /path // v505: kmd placeholder 淡黄色（2026-08-15）——--ph 改 solarized yellow 系：亮 #b58900 / 暗 #c9a227（经 opacity .5/.7 呈淡黄），替换 v502 的 base01 灰 // v504: kmd gitbash 路径抬头回归（2026-08-15）——F43 提示符块整块丢弃把路径也丢了（bash 每次提示符前写 OSC 标题 \x1b]0;MINGW64:/path\x07，被 cleanAnsi 剥掉）；新增 extractOscTitle 在 cleanAnsi 之前拦截 OSC 标题提取当前目录 gbCwd（跨 chunk 切碎续接同款状态机，仅接受 MSYS 路径形态防其他程序设标题污染），命令回显行渲染 ❯ [路径] 命令（gbpath span dim 灰，cmd/PS 提示符同款形态），cd 后下次提示符 OSC 自动更新；winToMsys Windows→MSYS 路径转换，init/cd/切换 shell 三处初始化；回归测试 14/14 PASS // v503: 楼层分配「先 mkdir 成功再落号」+ f1 空壳预创建删除 + 分配失败内容诚实恢复（gaea q145 f1/f2/f4/f3/f5 事故根治——nextFloorNum 只读探号零写入/commitFloorNum 单调落号，物化抛错号不蒸发；草稿晋升不再预建 f1 目录；qoast 假文案「内容已保留在编辑框」改为真恢复：编辑框空→恢复原文/非空→error 气泡保留原文；alloc-fail stack 落盘 agent-*.log 复现钉死真抛点） // v502: kmd placeholder 颜色对齐 AI 聊天编辑框（2026-08-13）——亮色 #586e75（solarized base01）+ opacity .5（AI 编辑框同款语义），暗色 #7a7670 + opacity .7；旧 --ph 近背景色（亮 #e0d8c4 / 暗 #3a372f）太淡用户反馈 // v501: AI 视口下拉背景两色交错 // v501: AI 视口下拉背景两色交错（2026-08-13）——第1层=f0e9a0 黄（dropdown CSS），子菜单按 depth 奇偶交替：depth 偶数=e7e4c2 / 奇数=f0e9a0（ai-viewport.js openSubmenu 内联，替代旧 goRight 方向双色 #e7e4c2/#ede4cf）；暗主题保持方向成对 #1e211e/#232a23 不变 // v500: kmd 键入行 textarea 化（2026-08-13）——input→textarea：默认 3 行高 / 最大 8 行高 / 自动换行（长命令多行显示），autoResize 高度自适应（内容增长到 8 行封顶滚动，提交/历史填充/命令召回后重置）；placeholder 极淡（--ph 近背景色，弱于一切正文/边框色，亮 #e0d8c4 / 暗 #3a372f）；line-wrap 改顶部对齐（多行时提示符 ❯ 贴首行） // v499: kmd 渲染管线三修（2026-08-13）——① 流式路径 ANSI 剥离漏接根治（F41 只测了 stripAnsi 函数本身，渲染管线 segInto 从未调用 → gitbash 原始提示符转义序列 [32m/]0; 原样上屏）；新增 cleanAnsi 跨 chunk 未闭合 OSC 状态保持；② gitbash 提示符块丢弃（OSC 标题 \x1b]0; = MSYS bash 默认 PS1 前导 → 置位丢弃到 $ 行，bash 提示符自带 2 个 \n 的三行噪音归零，每回车一行）；③ 双击让位原生选词（旧双击=召回 preventDefault 拦原生扩选）→ 召回改点击 ❯ 箭头 span；新增选区全局匹配高亮（selectionchange 250ms 防抖 → findAllRanges 精确大小写 → 独立 Highlight 集 kmd-sel-hits，流式追加自动重算）；回归测试 14/14 PASS // v498: 菱形描边回到 a 版——inset 0.5px 亚像素细线（q 版=border:1px solid #000，shell-menu.js 注释记录可随时切回） // v497: 菱形描边回滚到 q 版——0.5px 亚像素 inset 阴影 → 1px border（用户对比后回 a） // v496: goods 指示灯描边再细——border:1px 改 inset 0 0 0 0.5px 亚像素阴影（10px 元素 1px 边框占 20% 视觉偏粗，半像素阴影抗锯齿渲染更细） // v495: goods 指示灯描边定案——1px 纯黑，黑白主题统一（用户 2026-08-13 定案，删 [data-theme=dark] 白框覆盖） // v494: goods 指示灯描边根治——clip-path 会裁剪同元素 filter 输出（前两轮 drop-shadow 描边从未渲染的根因），改 rotate(45deg) 正方形 + border 2px（border 随旋转天然形成菱形描边），白主题黑框/黑主题白框，万花筒 1.2s 旋转不变 // v492: goods 指示灯万花筒改柔和五色 + 菱形描边主题化（白主题黑框/黑主题白框，4 正交 drop-shadow 合成清晰 1px 描边，替换旧模糊 1px 阴影） // v491: kmd 输出纯文本化 + Ctrl+F 检索三修（2026-08-13）——行内 SGR 彩色 span 结构整体放弃（每行单一文本节点：选中/复制/检索零干扰，ANSI 全剥离防乱码，颜色降级行级 class err/self/dim）；findAllRanges 三 bug 根治：① nodes.push 漏写（节点从未收集 → 检索恒空，Ctrl+F 外壳根因）② 跨行匹配加行分隔符 + 分隔符位段起点归零（负偏移毁 Range）③ 空查询守卫（indexOf('',pos) 死循环）；回归测试 22/22 PASS // v490: AI 视口配色全量回滚（2026-08-13）——F96/F98/F101 三波马卡龙/豆腐块色系系统全部还原到 08-09 状态，白主题下拉背景 e7e4c2→f0e9a0 改黄一点；品牌小写注释保留 // v489: goods 品牌名全小写化（2026-08-13）——search/git/kmd/inbox/roam/rage/wysiwyg 显示层+注释层+文档层全小写（外部专名 Git for Windows/GitHub/Git Bash/i18n 翻译值保留），杜绝编码认知分裂 // v488: AI 视口色系 v2（2026-08-13）——色系改 HSL 基色程序化生成：每档 = 基色 hue ± 偏移（相邻色相过渡，流动动画肉眼可见），S 48-67% / L 89-95% 保持非常淡雅；色系随机绑定逻辑不变（进入视口随机一次、窗口生命周期绑定、相邻异色、层级色系内随机） // v487: kmd Ctrl+F 全文检索高亮（2026-08-13）——CSS Custom Highlight API（Chromium 108 原生，零 DOM 改动）：全匹配 #ffe792/暗 #4a4412 + 当前匹配 #b58900 反色，选区/光标词自动填入查找条（capture 拦截 Electron 原生 find bar），Enter/Shift+Enter/F3/Shift+F3 导航，Aa 大小写切换，Esc/✕ 关闭；输出流式追加 MutationObserver 120ms 防抖重算保 idx；输出区 ::selection 对齐 editor solarized（light #d6d6d6 / dark #274642）+ caret 同步 accent // v486: goods 指示灯万花筒加黑边 + 颜色改鲜艳高饱和（drop-shadow 跟随 clip-path 菱形，黄/灰态不变） // v485: kmd 输出区只读编辑器化（2026-08-13）——#out contenteditable="plaintext-only"：点击任意位置出闪烁光标（原生）、拖选/Shift+左键选区、任意复制；键盘拦截禁编辑（放行导航/选区/Ctrl+A/Ctrl+C，可打印字符自动注入键入行并聚焦，Enter/Tab 回键入行）；单击=放光标（删 mousedown 抢焦点，选中根因）、双击=命令召回（旧单击召回与光标冲突） // v484: AI 视口豆腐块色系系统（2026-08-13）——豆腐块进入视口随机一次、窗口生命周期绑定、相邻块异色、每个展开层级色系内随机取色（--aiv-c0..c4 内联变量，删 6 套 aiv-macaron-N）；goods 指示灯万花筒改淡暖色 + 1.2s 快转 // v483: 粘贴文件夹全线修复（2026-08-13）——主进程 qqqide:fs:copyFile 目录感知（递归复制 8 路并发 + 字节级进度，单一引擎 Roam/编辑框共用）；Roam 粘贴 readFiles-first（CF_HDROP 完整路径 → 文件夹+文件混合一次粘贴，4 路并发）；编辑框 paste-router 文件分支升级（CF_HDROP 完整路径 → 递归复制进 _qqqvault/ + 锚点带真实 path = 所见即所得粘贴文件夹，DOM-only 降级文件名锚点） // v482: kmd gitbash 输出三修（2026-08-13）——bash 无 TTY 交互把提示符/回显/警告全写 stderr → ① err 流不再标红（满屏红字根因）② bash 自身回显按 lastSentCmd 去重（与 UI 蓝色 ❯ 行重复）③ 启动警告两行（cannot set terminal process group / no job control）纯噪音丢弃 // v481: Roam 空区右键菜单排序调整（喂给AI→kmd→PowerShell→CMD，快捷键随项不动：m=CMD p=PowerShell） // v480: goods 进程指示灯马卡龙→鲜艳五色万花筒（2.5s 快转）；AI 视口下拉/子菜单/最近列表背景改马卡龙流线随机背景（6 套变体 JS 随机挂载，9s 流动动画，暗色主题保持原样） // v479: 服务端甲壳兜底 4 处 21691→21354 对齐 guard-meta FALLBACK_CHARS（F20 漏改，铁律 10.1 唯一入口） // v478: kmd cmd 命令回显修复（2026-08-12）——cmd 启动参数去掉 /q（关闭回显）→ 用户发的命令在输出区消失只看到返回（q181 f30 实锤）；去 /q 后 cmd 原生回显提示符+命令，与 PowerShell/gitbash 行为统一 // v477: ctx-panel 弹窗文案更新（V16→V22 + f1/f2/f3 三级 facts→fx 唯一一条增量追加）+ 按钮行左侧新增帮助按钮（外观照搬排行榜问号，无 hover 提示，点击跳转上下文背包文档 URL 去 lang 参数） // v476: aq 图解 AI text 互斥分类——assistant 消息带 tool_calls 且正文非空（2026-08-11 起原生 tool_calls 带 content）时旧逻辑双计（AI tool_calls + AI text）；改 error > tool_calls > text 互斥链 // v475: kmd-ui 补 F2/Tab 非编辑态转发父窗口（同 ai-panel/conv-ui 模式，iframe 内按键不冒泡父窗口；kmd 08-10 创建晚于 F126 补漏 → 漏网）——焦点在 #input（终端键入框=编辑态）不转发保留终端语义，输出区/工具栏/空白处按 Tab/F2 一键召回 Roam // v474: goods 进程指示灯运行态改马卡龙万花筒（conic-gradient 六色旋转，黄/灰不变） // v473: kmd 移到 X 区 file 分组（2026-08-12）——gaea-host open() 新增 opener 路由（goods 声明 opener 函数完全接管打开）；tab-manager 新增 openFileCustomTab（file 分组 custom tab 单例，无 filePath 不进 Monaco/不持久化/无右键菜单）；kmd.js tabs 声明 → opener（qqqTabs.openFileCustomTab('kmd')，菜单行2 按钮 + Roam x 键同路由）；kmd-ui.html body 显式 user-select:text（主窗口 shell-base body user-select:none 向 iframe 传播 → 输出文字无法选中复制的根因） // v471: Roam 空区右键菜单 4 行（①喂给 AI 带左右箭头=当前文件夹 ②kmd=x 打开 kmd 终端并定位当前目录 ③CMD=m ④PowerShell=p）+ 快捷键同步（x→kmd / m→CMD / p→PowerShell）；kmd goods 支持指定目录启动（_pendingKmdCwd 一次性消费 + kmd:cd 原地切目录 kill+重 spawn） // v470: q181 f21 三连事故根治（2026-08-12）——①工具执行活跃标志 _toolExecActive（agent-exec，长工具上传/长命令无 onToken/onCost 信号被 20min 停滞看门狗误判拉断，q181 f21 67:42 中断实锤：h24 后上传 116MB 发布包被 abort）；停滞看门狗工具续命一次（~40min 工具窗口上限防死循环）+ ghrun 15min 失速兜底；②绿时钟根治：_capAbort 手动 className 复位是一次性的——startFloorTimer setInterval 每秒填回时间+改回 clock-ai 绿色（永动机复活，q184 修复后仍复发），改调 stopFloorTimer（clearInterval+黑色+饼图定格）；③abort 路径合成 error log（_questErrorLogByFloor/_questErrorState/conversation _error 三处 + _renderQuestErrorBox）——abort 不写任何 error → 红框+继续任务链接永不渲染，用户只见 qoast 却无红框可点（F36 只修了恢复路径，运行中 abort 路径漏网） // v469: 孤儿 tool 400 根治（q1 f17 客户事故 + q181 f14/f17 样本实锤）——fatal 楼层最后一条 tool 残留 → 恢复楼层 slice 开头孤儿 tool → 重启 restore → 发送 400 "tool must be a response to a preceding message with 'tool_calls'"。四层防线：① 恢复 _repairOrphanedToolCalls 实现（agent-exec，铁律 6.3 预检曾是死调用）——发送前双向扫描删无配对 tool；② auto-repair 400 分支先净化再弹组（孤儿在开头/中间弹不掉 → house2 仍 400）；③ 落盘防线（panel-a4 floorConv 剥离开头 tool）；④ restore 拼接净化（panel-floor）。另 fatal→idle 合法化（守卫失败路径，消除 unexpected 警告噪音）。 // v468: fatal 死胡同根治（q184 重启后发消息无反应实锤）——恢复路径 floorFatal 且 exitReason 空/零 _error 消息时合成 error log（panel-floor，保证红框+继续任务链接必渲染）；_executeSend fatal 闸门拦截加 qoast 显式提示「点击楼层红框继续任务」（panel-pipeline，不再静默吞 Enter） // v467: 发送停滞看门狗（q184 20 分钟强拉断事故修案）——20min 总时长上限 → 20min 零进展上限：onToken（内容流）/onCost（每 house 完结）/onToolCall（每工具开始）三信号续命，长任务（60 houses/深思考/压缩）永不被拉断，仅真静默（网关风暴/IPC 挂死/SSE 哑火）才终止 // v466: 发送管线大动脉重构——锁表→per-quest 串行执行器（q182/q184/f28 同根因三次发作根治：agent._sendChain Promise 链 + 面板级 promoting 窗口，结构零并发；删锁表五函数+看门狗）+ 20min abort 时钟复位（q184 绿时钟）+ SSE 内容级看门狗 45s（心跳不重置，上游挂起自愈） // v465: kmd 终止按钮根治——kill+restart 旧进程 exit 竞态误删新会话（截图"进程已退出(code=1)+会话未就绪"根因）→ 会话身份校验；死会话点击⏹=重启；终止按钮自定义即时 tooltip（零延迟 solar 配色） // v464: V10 旧格式 biscuit unshift→splice 定序修复（Z→fx→biscuit 铁律 10.1，panel-floor）+ aq 图解 JSON overhead msgCount 含 fx/biscuit（口径一致，panel-quest-ui） // v463: quest 级发送锁（三通开工回归修复：__qqq_sendBusyMap 按 quest 隔离，不同 quest 三翼并发）+ reasoning_content 原样回传（q178 f29 http_400 根治：assistant 消息挂载思维链、agent-gateway 禁 strip、_estimateMsgTokens 计入）+ 楼层分配-物化窗口 try 包裹（f28 编号蒸发静默死亡→显式报错）biscuit 标记） // v461: kmd 自绘 shell 下拉（弃原生 select 弹出层白底蓝条，改 solar 配色自定义菜单）+ 移除 kmd 工具栏 cursor:pointer // v460: Inbox 在线状态并入 conversations 批量下发——删除独立 GET /api/dm/online 接口 + 客户端 checkOnline 网络查询（同表同窗口唯一真理，打开会话零额外往返）；收到对方消息直接标在线 // v458: goods kmd 终端（v1 行模式，分裂架构——输出日志式渲染器 + 键入原生控件点击定位；多 shell 宿主 cmd/powershell/gitbash；X 区 tab + 菜单行2 按钮） // v457: 服务端甲壳档1损坏修复（残句/重复/劈词）+ E-FLOW 模板 A/B 合并去重（Variant 结构）；fx 提取提示词英文化 // v456: 服务端甲壳字符数动态化（core/guard-meta.js 唯一入口 + /api/v3/ai/guard-meta 拉取 + 出厂快照兑底，4 处 14964 硬编码清除）// v455: only facts 增量提取（提示词带 fx 参照只提新增/变化）+ 清理死代码（_intent 残留）+ backpackEstK 补位 // v454: 上下文背包 UI 事实格顺序对齐背包容序（fx → biscuit）+ fx 专用标签；restore 从 ctx.facts 重建 fx 消息 // v453: Inbox 逐字回退（char-undo 唯一真理机器接管编辑框 Ctrl+Z/Y）+ 空态占位根治（data-empty-hint：新消息到达即移除，「暂无消息」不再压在已发消息上方） // v452: 热更新 UI 删除（2026-08-10 版本=清单编号重构，update-ui.js 移除，更新 100% 由 C 启动器随 r 托管） // v451: Inbox 联系人列表去重+分割线铁律——conv-flag 头像列删除（国旗+号码直贴左边界，不再双份国旗）；splitter hover 不再变色不换光标形态（光标外观全站铁律：任何元素不自定义 cursor）；splitter 拖动反馈仅背景高亮 // v450: 改名/空壳/tmp 三线根治——lazyRenameScan 改名成功后失效楼层缓存 + 关闭时再扫（会话中改名即落盘）；写路径 _fDir 过期校验（防幽灵目录重建，q174 事故）；归档空 quest 同步移除索引（防 q177 幽灵复活）；all.json.tmp 三防线（parent 级跨实例写锁 + rename 失败清 tmp + 启动清扫 .name 修复） // v449: openFile 无 onRender 时广播 qqq-file-open-in-pane（diff 窗口 open in qqqide 空白修复——tab-manager 直建 pane 不渲染，shell-rpc 监听器未触发） // v448: timeline diff op 菜单——① 第一行改名 open in qqqide（避免与下方编辑按钮大脑分裂）② hover 背景透明修复（--hover-bg rgba 透明叠加→实色 #e2dbc4 亮 / #3a3a3a 暗，op/fuzzy/v-dropdown 三处下拉同步受益） // v447: timeline diff op 菜单——① 打开文件→编辑文件（= Roam Q 键 open in qqqide）② 喂给 AI 动态标签（←喂给 AI/喂给 AI/喂给 AI→ 按焦点面板，Roam 右键传统）③ 主进程宿主窗口定位修复（_hostWindow parent 链优先 + /qqqide/ URL 兜底，根治 getAllWindows()[0] 取错窗口导致 executeJavaScript 静默失败）④ 新增 getAiTarget IPC // v446: 群聊（q150 F16）——服务端 0125 migration + 7 条 /api/group/* + ws group_msg 推送；客户端 dm-ui/网站 dm 群列表/建群/加人/群消息发送者名/群未读，SW 强制刷新 // v445: Inbox 本地缓存+历史分页——dm-ui 会话/消息 localStorage 防抖缓存（启动秒开/离线可读/单会话300条/全会话3000条裁剪）+ 加载更早消息游标分页（?before=<id> 前插合并去重） // v444: Inbox 节能模式——窗口不可见断 WS 转 60s REST 轮询（dm-ui 断 WS 只维护未读数 / gaea-host 徽章 WS 同款节能 + 重连指数退避 5s×2 封顶 30s，根治服务器重启重连风暴）+ 双 WS 未读数通道分工（gaea-host=后台徽章常驻通道, iframe=前台实时渲染） // v443: Roam 标签 hover 召回提示——X 区 gaea 分组最左 Roam 标签悬停瞬间弹出大字号 tooltip「按 Tab 或 F2 键召回我」（.qqq-roam-tip 固定定位 20px 粗体，贴按钮下方，底部越界自动翻到上方；tab-manager.js addGaeaTab 内绑定 mouseenter/leave） // v442: 全部 goods iframe 页补 F2/Tab 非编辑态转发（rage/search-ui/git-ui/dm-ui/kope-a panel.html 五页，同 conv-ui 模式——iframe 内按键不冒泡父窗口）→ 任意 goods 面板一键跳 Roam // v441: 上下文背包 conv-ui.html 补 F2/Tab 非编辑态转发父窗口（同 ai-panel 模式，iframe 内按键不冒泡 → 背包页也能一键跳 Roam） // v440: V23 自动阀值触发条件改为 absolut 可回收收益（按钮一数字）超阈值，出厂默认 600→100K tokens // v439: 背包图解 ╔K 统计修复——多工具合并行（[A → run_command+read_file]）拆分归属绝对工具 + ╔K 判定窗口 80→160（长头行边界漏判），图解绝对盒体部与 absolut 按钮收益对齐 // v438: vibe 豆腐块名称免费窗口内替换为「剩余/预算」数字（1 位小数，如 1.3 / 4.1），非免费恢复活动名 // v437: 原料弹窗文字/按钮全链路 #d98a86→#d9645c（标题/数字/高亮/关闭/CTA/领取钮，外边框保持淡红）+ 网站徽章同步 #d9645c // v435: 原料弹窗全窗淡红（标题/数字/高亮/关闭/CTA 归位 #d98a86，消灭绿色残留） // v434: 原料与基本权利淡红定案（#d98a86 纯色无渐变，v430 已落地，本号强制刷新旧缓存） // v433: Roam 崩溃根治（frag 变量提升陷阱）——loadFileList 的 frag.appendChild('..' 项) 在 var frag 声明之前执行（var 提升为 undefined）→ TypeError reading 'appendChild' → 列表区只显示报错行；frag 创建提前到 try 块首行 // v432: // v432: Roam 按钮 tooltip 原汁原味——szMode/sortBy/open/filesOnTop 8 按钮补 data-tooltip（q3 i18n 中文原文）+ New file/folder 改中文 + paste-tip 已粘贴 + tooltip 单位修复（zoom 0.85 下 innerWidth/clientX 报物理 px 而 fixed/maxWidth 用 CSS px，_ttZoom 统一 → 右边界保护失效/退避错 17.6% 根治）+ mouseenter 未命中不隐藏（q3 语义防闪烁） // v431: F121 三处防崩加固（card-pool getOrCreate _container 兜底 / _appendToCard $messages guard / _buildFloorDOM userEl guard）+ frame-renderer 图片文件名 `_` 变体容错（旧格式 token 引用新格式文件 404 破图 → exists 校验后切换） // v430: 原料与基本权利配色回归淡红 #d98a86 纯色无渐变（外框+状态区条+弹窗条+领取按钮），网站徽章同步 + 星火计划黑底白字 // v428: Inbox 永久联系人+国旗（服务端随消息下发 phone_e164+country_iso2，联系人一次建联永久展示，国旗本地 flags/{cc}.png 照登录区机制；历史会话重启即恢复） // v427: 原料与基本权利配色淡红→橙 // v427: 原料与基本权利配色淡红→橙（边框/进度条/弹窗/按钮全链路 #cb4b16，与网站徽章一致；2026-08-09） // v425: Roam 喂 AI 支持多选——a 键/右键 AI 项遍历全部选中项（selectedItems 逐个 __qqq_aiFeedFile，排除 '..'；单选/右键兜底不变） // v424: 空壳自愈加固——楼层空壳仅归档真空壳（含 all.txt/snapshot/img 的数据目录不归档）+ quest 级空壳归档（_healFloorCounters 零楼层目录 30min → .trash，草稿晋升崩溃残留收敛） // v423: 活动豆腐块清爽↔vibe 配色互换（清爽绿/vibe 蓝）+ 暗色主题进度槽浅色区分 + 弹窗进度槽可见度提升 // v422: Roam 自动感知防幻影闪烁——loadFileList diff 签名（name+type+sz 动态列）无变化零重建 + replaceChildren 原子换入（无 innerHTML='' 空白帧）+ 主进程 250ms 事件突发合并 // v421: 空壳楼层目录自愈（loadAllFloors 无 all.json + mtime>30min → 移入 _qqq/quests/.trash 归档，根治空目录永久残留） // v420: 国旗永久化（login.js 同账号永不重渲染徽章，根治偶发闪烁）+ 徽章图失败重试一次 + 白嫖榜 {ge} ReferenceError 修复 // v419: 内嵌弹窗统一滚动条 100% 等同 a 窗口（设置/排行榜/在线用户/活动弹窗/AI悬浮预览/开新窗口下拉/语言下拉，shell-base.css 一处定义） // v417: 字符→token 估算系数 2.7→2.5 全系统统一（唯一真理源 ContentGateway.CHAR_PER_TOKEN） // v416: 背包压缩按钮数字左侧改 3px 空气墙（-13k 与 absolut 不再粘连）+ 压缩动画时长翻倍（0.8s→1.6s）定格加长（3s→6s） // v415: 工作空间记忆边界加固——recentFolders OS 兜底（本地 recent_folders 丢失拉回+回写）+ fresh=1 不写全局恢复点 + 死路径记忆跳过（防面板永久空白）+ ws.sq3 跨进程 LWW 合并（防双进程丢 key） // v414: 工作空间记忆独立 ws.sq3（%LOCALAPPDATA%/qqqide/ws.sq3，删工作空间记忆不污染 ai.sq3 其他记忆块）+ 恢复链改本地优先（启动目录 global.sq3 → OS ws.sq3 兑底回写，多绿色包不串）+ ai.sq3 ai.workspace.* 一次性迁移 // v413: 工作空间记忆 OS 级唯一真理（ai.workspace.*，异常退出不丢）+ 面板绑定兑底轮询（空白窗口手动加主文件夹后不再全空）+ 主文件夹变更自动重载重绑 // v412: F13 关闭确认根治——废除 beforeunload 拦截-重试收敛（三面板全拦截 + hidden iframe setTimeout 节流 60s → 回车后窗口永不关/60s 自动关误认闪退），改 fire-and-forget 尽力保存 + 不 preventDefault → 确认后窗口立即关闭 // v411: // v411: quest-store 降噪——loadAllFloors 孤儿/新发现/缺失楼层逐行打印改汇总（一次启动 200+ 行 → 3 行）；repair 改名与 loadAllFloors 并发竞态重试（防 70+ FAIL + 双 rebuild 风暴）；floor_counter 键缺失 seed（heal 启动对账 + nextFloorNum 运行时自愈） // v410: Roam 滚动块再左移 2px（thumb right 7px→9px） // v409: new_log 双日志限容回归——toolpush 逐house快照恢复（目录 4MB FIFO 删最旧）+ render-log.jsonl 恢复（主进程 append 侧 2MB 双代轮转 .1，总量 ≤4MB） // v408: F107 滚动块——① Roam thumb right 1px→7px 左移 6px 对齐老板 ② 三处自定义滚动条（Roam customScrollbar / AI 面板 qh / AI 视口 qh）拖拽期间保持粗态：左键按住不松开时光标移出滑轨 x 范围也不再收缩（drag-active class / _thumbDragging / _sbDragging 门控） // v407: new_log 精简——删 toolpush-f*.json 逐house快照（7160文件/143MB）+ render-log.jsonl（标注用后即删）；agent-*.log 保留但 30 天自动轮转 // v406: F10 楼层丢失根治——①编号统一（recovery 楼层 totalFloors 同步目录号，biscuit 不再错位）②完结密封（压缩后禁重复保存，conv=0 覆盖根治）③恢复路径清 _compressFloor ④V21 截断收紧（仅当前楼层 compress 才截断）⑤rename 失败降级复制 // v405: Roam 粘贴二进制损坏根治（F106：iframe RPC proxy 缺 fs.writeBase64 → base64 被当 UTF-8 文本写入 → zip/png/mp3 全部打不开；已补 writeBase64 代理 + 禁静默降级） // v404: Roam 自动感知外部变化（q3 autoWatchChanges 移植，默认开）：主进程 fs.watch 当前目录（6s 冷却 + 临时下载文件智能过滤 .crdownload/.part/.tmp）→ qqqide:roam:fs-changed → iframe reloadCurrentDir；Roam 手动刷新 watchMark 重置冷却防双刷 // v403: 关闭确认 F10 根治——panel-send 保存完成重试改走主进程 IPC closeConfirmed（iframe 内 window.close() 是 no-op 永不关窗）+ Enter 主路径 force 隐藏确认框 // v402: quest-store 洪泛根治 // v402: quest-store 洪泛根治（同号目录 all.json 优先解析 + 仅真实重复告警 + _fDir 跨项目写保护）+ 面板启动主项目稳定性绑定 + 移除 Space+Q global 死绑定 // v401: F2/Tab 根因修复（bootKeyHook 把 key-bindings.json 对象误清成空数组 → 零绑定 → F75/F99 handler 从未被触发；现保持 {version,bindings} 对象直传 init） // v400: F2/Tab 激活 Roam 兜底直连（shell.js bootRoamKeyFallback 独立 capture 监听，key-hook 配置链失效也不静默） // v399: 1/8按钮只显示编队字符（去 ■ 前缀） // v398: 关闭确认无限循环根治（panel-send.js beforeunload 一次性拦截：保存完成前只挡一次，window.close() 重试不再被二次拦截 → 回车/确认后窗口必关，X 不再失灵） // v397: 关闭确认修复三件套——主窗口关闭不再连带销毁其他窗口 + 确认关闭走 close() 触发 beforeunload 持久化刷盘 + Enter/Esc 改 webContents 级捕获（iframe 焦点 100% 响应） // v396: Monaco TS/JS worker stub（诊断全禁后零职责，根治 Could not find source file e%3A 噪音） // v395: 窗口编队 squad（squad-btn.js 菜单行2 LV 左侧按钮+下拉，标题 x■ 前缀，Space+key 召回） // v394: activateRoam 诊断日志 + qoast 可见反馈 // v392: Roam Q 键=开新窗口(主文件夹=选中目录,restore 工作空间) W 键=系统资源管理器打开目录 // v391: Roam 左侧栏文字左移 6px（盘符 nav-item / qq-item / qq-text / qq-file 四规则 padding 10→4 / 18→12） // v390: 背包图解 Q/A ×1 bug 修复（楼层分割正则少一个等号，lookahead 永远不匹配 → 93 层只统计 1 个 Q/A） // v389: F2/Tab 激活 Roam 修复（F99: activateRoam 改走 qqTabs.activateTab，旧实现 btnEl/paneEl 字段不存在导致切换从不生效）+ AI 面板 iframe 转发 F2/Tab // v388: V21 onlyfacts 守卫恢复 32K + compress 楼层跳过 biscuit 占位 + 防 _compressFloor 泄漏 + compress 消息全量清理 // v387: 压缩按钮收益数字去除左侧空格（'-13k' 紧贴按钮文字） // v386: Roam btnNewFolder 按钮标签粘连修复(F73残留) + 619 null防护 // v385: 右键菜单粘贴去重（图片+文本共存只插一次文本，修重复插入） // v384: AI 面板多图粘贴（Ctrl+V 全量收集 + 串行保序 + 三重硬帽） // v383: 三活动豆腐块边框换色（清爽淡蓝 #3f96d8 / 原料淡红 #d98a86 / vibe 绿 #859900） // v382: 国旗唯一渲染机（login.js 竞态根治 + flag 归一 + onerror） // v381: F2 key binding + window.activateRoam handler now activates X-zone tab + focuses iframe // v380: Roam dark theme hover highlight + path-tooltip distinction // v379: Roam empty ctx menu click fix + btnNewFile/btnNewFolder data-tooltip + doCreateFile blur // v378: 修复活动豆腐块 CSS 损坏(注释吞掉 done-fill/.qqq-act-txt 规则) + 满格不再把原料边框改绿 + 赞助商链接常态同色永不下划线 + forced-color-adjust 兼容 Windows 高对比度(进度条渐变被强制抹空) // v377: newline-btn 移到编辑框外右上角（子弹按钮上方） // v376: Roam 文件菜单仅 6 项(AI/code/open/delete/rename/copyPath), 空区菜单复活(CMD=c/PowerShell=x 仅两项) // v374: AI 等级弹窗自定义无轨滚动条(5px)+文字可选中复制 // v373: newline-btn 移到编辑框右上角外侧（子弹按钮左侧） // v372: 赞助商拆分（前缀不带链接+公司名超链接）+ 原料活动边框偏红 + vibe 前缀文字与赞助商 100% 同外观 // v371: vibe 豆腐块常态发光+边框统一 + 状态区免费/非免费统一显示剩余时间 + 距下次/剩前缀同赞助商文字外观 // v369: 赞助商链接改为 por.jsp?id=1&_jcp=5_1 // v368: 赞助商移至三盏绿灯之右 // v367: 状态区排序还原 + vibe 豆腐块边框统一 // v366: 状态区单行 + 窄窗口退避隐藏 + vibe 余额解析修复 // v364: 赞助商 hover 橙色 // v363: 状态栏左下角赞助商文字（zhijiaip.com） // v362: index.html 恢复 klipzap.js + wq-stats.js 加载（F73 误删） // v361: Roam 文件/文件夹名左移 2px // v360: Roam 右键 AI 菜单项（←AI/AI/AI→ 焦点面板）+ CMD 快捷键 a→c

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
  // wysiwyg paste pipeline (v306)
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

