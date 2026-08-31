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
// v619: 右下角 ResizeGrip 移植（2026-08-25）——q.py 百分百同款：36x36 命中区 + 两条黄色平行斜线（SVG 照抄 q.py 坐标）+ nwse-resize 光标 + mousedown 拖拽同时改宽高（左上角固定，最小尺寸主进程钳制），替代旧 16x16 实心三角渐变装饰（bootResizeGrip 曾是空函数，功能彻底没有）。链路：index.html grip 内 SVG + shell-main.css .qqq-resize-grip + shell.js bootResizeGrip
// v625: kmd 焦点态虚线框改橙色 2px（2026-08-25）——--accent 绿 → --orange（亮 #cb4b16 / 暗 #d06e2e，solarized orange 系）+ 虚线加粗 1px→2px；kmd 键入行新增换行按钮（对齐 AI 聊天编辑框 newline-btn 形态：⏎ 字符点击光标处插入换行 + autoResize，回车仍是发送）；顺带根治 Shift+Enter 被发送拦截（keydown Enter 分支加 !e.shiftKey 放行 textarea 原生换行）；placeholder 文案补 Shift+Enter 换行提示
// v627: kmd 焦点态虚线换回 accent 绿（2026-08-25）——F87 橙色 #cb4b16 用户要求回退绿色，粗细保持 2px；--orange 变量零引用后删除（铁律废弃即删）；选区自动匹配高亮 kmd-sel-hits 加强（用户反馈两主题都看不清）：亮 #e2e8b5 → #b6c04a（饱和黄绿，米黄底上跳出来）/ 暗 #35412b → #6d8033（亮一档的橄榄绿，深底上可辨），与 Ctrl+F 的 find-all/find-cur 色相区分不混淆
// v628: kmd 滚动条刻度 + 暗色选区高亮偏亮黄（2026-08-25）——① 黑色主题 kmd-sel-hits #6d8033 → #c9a227 偏亮黄（solarized yellow 亮版）+ 配深色文字 #1e1e1e 保可读（浅黄背景上浅字不可读）② 新增 #out-marks 滚动条刻度层（AI 面板同款）：renderMarks 合并 Ctrl+F findRanges + 选区匹配 selHlRanges 全部命中，比例 = 内容坐标/scrollHeight 打刻度（贴 #out 右缘 5px 滚动条区，pointer-events:none 零交互）；触发点 updateFind/updateSelHl/clearOut/MutationObserver 流式追加/resize rAF 节流；刻度色亮 #b58900 / 暗 #c9a227
const CACHE_NAME = 'qqq-shell-v682'; // v682: MEM 面板 v22（2026-08-31 q209 f57）——① 两条内存告警 qoast 改常规自动消失（默认 9s，删 duration:0 常驻+知道了按钮，用户定案「不要常驻，自动消失滴常规滴那种」）② 启动包 label 修正：旧实现取 userData 上级 basename（绿色包=gh555.com，那是托管目录不是包根）→ 改含 qqqide.exe 的包根目录完整路径（从 appPath 上探：E:\s\w\qqqide-win-x64；dev 回落项目根）③ CPU y 轴新常态跟随（p95 天然忽略最高 5% 点——持续升高要攒够 5% 才抬坐标，期间曲线贴顶成平线；最近 5 点均值 ×1.5 参与上界，持续 ≥5min 的升高立即反映，单点尖峰被均值摊平不拉高） // v681: Roam 家目录恒红（2026-08-31）——_qqq/_qqqvault 文件夹行加粗变红（roam-home-dir，!important 压过选中文字色）；随机选中配色池删除红系（light Vivid Red / dark Dark Flame），选中背景永不红 → 家目录红字任何状态不变色 // v680: 家目录（_qqq/_qqqvault）恒红补全（2026-08-31）——子菜单打开时父行被加 aiv-breadcrumb（color:#000 !important）压过行内红色，光标移进下一层后文字变黑；恒红规则覆盖 常态+hover+面包屑 三态含暗色版 // v679: 图片工具 MUST-DISPLAY 铁律（2026-08-31）——generate_image/remove_background 云端返回图片路径必须立即在 AI 面板回复正文打印（tools-defs.js 工具描述强制 + 服务端甲壳同步），除非用户明确说不要打印 // v678: 抠图工具文件名斜杠 bug 修复（JPEG b64 前缀 /9j/ 被拆目录致 curl 静默失败假成功）+ 下载失败报真错 // v677: 眼睛文案去「会」字——「当视频播放量逐渐增大，会自动接入星火计划」→「…自动接入星火计划」（网站+客户端同步，q158 活动） // v676: 原料弹窗副标题加长文案「即便你不再用 qqqide，一切历史，仍在你手上」（q158 活动） // v675: MEM 均值档告警文案加「均值」二字（2026-08-31 q209 f54 后续）——「当前总内存（含一切子进程）占用超 1g」→「当前总内存（含一切子进程）均值占用超 1g」，前缀「独立启动包：xx」不变（用户定案：均值档语义=抗尖峰均值持续超限，与暴涨档「达 N MB」区分） // v674: MEM 面板告警文案（2026-08-31 q209 f53 后续）——两处 qoast 文案「当前滴总内存（含子模块）暴涨至 N MB」→「当前总内存（含一切子进程）达 N MB」、「当前滴总内存（含子模块）占用超 1g」→「当前总内存（含一切子进程）占用超 1g」（用户定案：口径 = 启动包进程树全部后代专用工作集 Σ，与列表头「包含一切子进程」同款措辞统一） // v673: MEM 面板 v21（2026-08-31 q209 f53）——★当前值暴涨告警补档：原设计只盯抗尖峰均值（556M<1G 不触发），当前值 1384MB 暴涨无提醒（用户实锤「内存一直在暴涨 1300MB 却没弹」）→ 新增 checkCurThreshold：每次 5s 广播用当前值 3 点平滑 > 1536MB（1.5GB，dev 常态 1.3G 不误报，本次峰值 1570MB 恰好命中）→ 弹 qoast「独立启动包：xx 当前滴总内存（含子模块）暴涨至 N MB」（边沿触发 + 1h 冷却防刷屏，常驻+知道了按钮）；均值 >1GB 红徽章+告警保留原语义不变（持续压力 vs 瞬时暴涨双档独立） // v672: MEM 面板 v20（2026-08-30 q209 f51）——① q 行第二行格式定案「■已启动 10min」：■ 与已启动之间空格去掉 + 已启动与时长之间加一个空格（旧 '　■ 已启动10min'，用户实锤）② ★进程列表空白 ~10s 根治：show() 缺 renderRows()——列表只在 5s 广播/history promise 完成时渲染，面板每次打开瞬间即使 rows 已在内存也不画，空白等到下个广播（用户实锤「hover 打开下方一片空白等十来秒」）；show() 补 renderRows()（rows 无数据显示采样中…兜底，有数据立即画，无需等广播） // v671: MEM 面板 v19（2026-08-30 q209 f50）——① ★mem reset 连带 CPU 显示重置根治：renderCurve n<2 分支（mem 清空后）把 CPU 图/统计/均值一并清掉（用户实锤「内存一重置 CPU 也被重置」+「图线消失/采样中/过一会儿才回来」）→ CPU 段抽出独立 renderCpuCurve()（图+峰值谷值+均值徽章一体，均值窗口改用 CPU 流自身运行时长），n<2 分支只清 MEM 段 + drawBoots 按流各自保留——mem reset 后 CPU 曲线/统计/均值毫发无损（CPU 数据从未丢，纯显示连带清空 bug）② 峰值/谷值时间戳 tip 改默认恒在光标下方 12px（用户定案「现在还是在上方」），近面板底缘自动翻上方防出界 + 水平钳制面板内 ③ 白色主题进程行 hover 改白色提亮 rgba(255,255,255,0.55)（用户定案「变得更白而不是更暗」，原微加深 rgba(0,0,0,0.055) 已废） // v670: MEM 面板 v18（2026-08-30 q209 f49）——① 峰值/谷值时间戳 tip 改跟随光标：旧实现相对 span 上弹（bottom:calc(100%+6px)），用户实锤出现在光标之下 → stats 容器改定位祖先（span 不再 relative），tip left/top 由 mousemove 每帧设置（恒在光标上方 8px，transform translateX(-50%) 居中保留，transition 只作用于 opacity/transform 位置瞬时跟随）；② 状态区 a 区域豆腐块加右边框+右边距（margin-right:16px + padding-right:12px + border-right:1px var(--border-color)——F40 合并时 class 换 qqq-mem-block 丢 margin-right，右边贴死下一元素「一点间距都没有」实锤） // v669: MEM 面板 v17（2026-08-30 q209 f48）——① hover 高亮反色根治：基础色盘低阶档（base03/base02/base01/base00/base0/base1）LIGHT/DARK 命名反置实锤（LIGHT 对象里 base02='#07362e' 深绿黑、DARK 对象里 base02='#eee8d5' 米白）→ 浅色主题 hover=黑色块、暗色主题=白色块，用户双主题观察全反；新增语义变量 --hover-bg（theme.js 唯一入口）：暗色 rgba(238,232,213,0.09) 微提亮 / 浅色 rgba(0,0,0,0.055) 微加深，真正'略微高亮'，prow hover 改引 --hover-bg（引用面仅 1 处，未动基础色盘——全局互换会连带改 --text-secondary 等次要文字色，超范围）② MEM reset 按钮补 data-scope='mem'（F47 发现的落地遗漏：旧实现回落 'all' 点 MEM reset 清全部，现 MEM 只清 mem-curve.log+内存曲线，CPU 曲线/累计时间不受影响，双 reset 完全分开） // v668: MEM 面板 v16（2026-08-30 q209 f47）——① q 行第二行 ■ 与已启动之间加空格（　■ 已启动）② 峰值/谷值 hover 时间戳修复：tip 是 pointer-events:none+opacity:0 纯展示元素，鼠标事件永远命中不了它 → 旧判定 e.target.classList.contains('qqq-mem-hover-tip') 恒假 → [MM-DD HH:MM] 永不显示（用户实锤）；改 closest('span') 命中「包含 tip 的 span」——hover 峰值/谷值文字整块即显示，tip 保持 pointer-events:none 纯展示 ③ 进程列表内存列+CPU 列各左移 6px（plist padding-right 4→10px，内容整体左移，滚动条位置不变）④ 进程行 hover 高亮（background:var(--base02) Solarized 双主题自适应 + 3px 圆角 + 0.12s 过渡）// v667: MEM 面板 v11（2026-08-30 q209 f46） // v667: MEM 面板 v11（2026-08-30 q209 f46）——① 进程打印区回落 180px（912→732，用户定案「太宽了」，JS PANEL_H+CSS 双同步）② q 行第二行加 ■ 分隔（10（峰值21）进程　■已启动1min，全角空格+■U+25A0）③ MEM 标题点恒绿色——删除 pinned 金色覆写（.qqq-mem-hover-pinned .qqq-mem-hover-dot #b58900 就是用户看到的橙黄源，锁定时 dot 不再变色）④ 峰值/谷值不再打印 [MM-DD HH:MM]——hover 自定义瞬间弹出（.qqq-mem-hover-tip 绝对定位+90ms 过渡，事件委托挂 stats 容器防 60s 重建丢监听），峰值/谷值居中靠近（justify-content:center + gap 26px） // v666: MEM 合并卡 v15（2026-08-30 q209 f45）——① ★历史永不加载 bug 根治：F42 主进程 history 改返 memPts/cpuPts 双流后渲染层旧守卫 `!h.pts` 恒真 → 历史快照整体丢弃 → 重启后曲线空等 2 个 live 点（~1-2min 才出现），用户实锤「启动后一分钟没有曲线」（数据没清——mem-curve.log 1109 点最后一点 13:58:25 持续在写）；② 进程打印区再增高 300px（612→912，flex:1 吃全部增量）——F44 只改了 JS PANEL_H 未改 CSS height，实际面板从未涨过；③ CPU 主题色偏黄定案：新增 --cpu 语义变量（浅 #bd7d0a / 暗 #d9a020，比 --orange 黄一档，颜色唯一入口 qqqide-theme.js），CPU 段全部 var(--orange)→var(--cpu)（仅本卡使用，不污染 qoast/secret-guard 等橙色位）；④ q 行拆两行：行1 标题「qqqide 专用工作集（包含一切子进程）」/ 行2 「N（峰值M）进程 已启动 X」 // v665: MEM 合并卡 v14（2026-08-30 q209 f44）——① 修 F43 致命 bug：$phUp 声明丢失（strict 模式 L162 赋值抛 ReferenceError）→ ensurePanel 中断 → $grid 等全 null → renderCurve $grid._ylbl 连环 TypeError（bullet 实锤两条）；② q 行字号/外观恢复 12px 原貌（F43 改 11px + margin 4→8px + 删 letter-spacing 0.5px 全回退，nowrap/ellipsis 保留——三段单行必需）；③ 卡片 PANEL_H 612→712 增高 100px 全部给下方进程打印区（plist flex:1 自动吃增量，多显示 ~5 行） // v664: MEM 合并卡 v13 // v664: MEM 合并卡 v13（2026-08-30 q209 f43）——① q 行（进程列表头）合并三要素：进程数「10（峰值21）进程」从 MEM 顶部移入 + 「已启动 X」从简介行移入（5s 广播同步刷新），MEM 头行只剩 MEM+脉冲点；② 简介行空间增大后峰值/谷值时间戳带日期：[MM-DD HH:MM]（MEM/CPU 双段同改，hm 纯时分已删）；③ q 行单行 nowrap + 11px 三段同排（内容宽 336px 恰好容纳，超长省略号兜底） // v663: MEM/CPU 双流拆分 + 独立 reset（2026-08-30 q209 f42 用户定案「reset 应该内存区和 CPU 区各一个」）——① 曲线持久化拆双文件：mem-curve.log {ts,mb,n}（内存流）+ cpu-curve.log {ts,cu}（CPU 流），同 tick 同 ts 各写各文件；reset(scope 'mem'/'cpu'/'all') 各自清各自文件+环形缓冲互不影响（cpu reset 后 mem 曲线完整保留，反之亦然）；旧一体行 {ts,mb,n,cu} 读回时 cu 一次性迁移进 cpu 流零成本兼容；boot 垂线两文件各写读回去重；② CPU 段头新增独立 reset 按钮（MEM 段右上原有 reset 保留，data-scope 区分，各自 title 提示各自日志文件）；③ 渲染层双流（memPts/cpuPts 独立环形去重/独立弹性窗口——cpu reset 后曲线从零铺满不受 mem 窗口影响，垂线按各自流换算，drawChart 加 span 参数）；④ 进程列表头「进程 · 内存 / CPU时间（会话累计）」→「qqqide 专用工作集（包含一切子进程）」（用户原话，口径 = 树内全部进程专用工作集 Σ，任务管理器「内存」列同源）；模拟测试 6/6 PASS // v662: // v662: MEM+CPU 合并卡三修（2026-08-30 q209 f41 用户实锤）——① 状态区 a 区域只剩裸内存数字根因：shell-statusbar.js renderMem 用 $mem.textContent 整体覆盖把图标+CPU 文字全清（F40 合并后遗留双写），删双写改唯一渲染者 shell-mem-hover.js（icon+内存+CPU 文字全量接管）；② 图表 y 轴空间 +16px/图（SVG H 118→134）→ 卡片高度同步增高 32（580→612，用户定案「增加多少 y 轴空间就增高多少」）；③ 进程列表独立三列（用户实锤 space-between 歪歪扭扭）：名称 flex:1 左对齐 / 内存右对齐固定宽 58px / CPU 右对齐固定宽 64px + margin-right:6px 整体左移 6px，每行三列位置恒同 // v661: MEM+CPU 合并卡片（2026-08-30 q209 f40）——① 状态区 a 区域 = 内存图标+内存文字+CPU文字（CPU 图标移除，CPU 文字加 CPU 前缀），hover/点击弹同一张合并卡；② 卡片合二为一：上区两层（MEM 图+打印 green/cyan 系不变 / CPU 图+打印 橙色系 var(--orange)），下方共用同一进程列表（每行 名称+内存MB+会话累计CPU时间，列头「进程 · 内存 / CPU时间（会话累计）」），宽度 360 不变高度 450→580 固定，进程数统一「当前（峰值N）进程」（原 CPU 面板无峰值显示，用户实锤两卡不一致）；③ ★ x 轴改累计运行时长（用户实锤「把关机时间算进去了」）：断档 >3min 空洞不推进 x 轴——程序未运行的时间不占图宽，曲线恒铺满；刻度语义 = 运行时长（-24h = 24h 运行时长前）；60s 一点 × 1440 cap = 24h 运行时长（点数即运行时长，墙钟修剪删除）；重启垂线落断档衔接处；均值徽章/窗口跨度同口径改运行时长；④ shell-cpu-hover.js/css 删除（废弃即删），index.html 引入移除，dense-3 规则清理 // v660: CPU 面板彻底独立 + 核数口径 // v660: CPU 面板彻底独立 + 核数口径（2026-08-29 q209 f38）——① mem-meter v6 CPU 改核数：单核百分比 64 核机 1%=0.64 核四舍五入全 0% 无价值（用户实锤），改三量化维度——瞬时核数（ΣΔ(ut+kt)/1e7/Δwall 不除 ncpu，行级钳 1.0 树级顶封 ncpu）/ 累计 CPU 时间（会话内树级差分累积，任务管理器 CPU 列 hover 同款）/ 平均核数（累计秒÷运行秒）；曲线点 c→cu（核数，持久化 {ts,mb,n,cu} 旧 v5 百分比 c 停止读取），广播 cpu:{cores,totalSec,avgCores} + rows 行级 cs 累计秒；② 双 tab MEM|CPU 废除（用户定案「CPU 面板彻底独立，不带任何联系，不用一个 UI，仅卡片尺寸一致」）——shell-mem-hover.js 回退纯 MEM（删 tab/CPU 曲线/CPU 列/CPU 豆腐块渲染），新独立面板 shell-cpu-hover.js + 独立 CSS shell-cpu-hover.css（.qqq-cpu-* 独立类名独立 DOM 独立交互，数据同源同一真理机器）：大数字=累计 CPU 时间（45s/12m34s/1h23m）+ 徽章=均占 X核（窗口均值）+ 曲线=瞬时核数（min=0 + p95 上界顶封 ncpu，PAD_L 40 容纳 '12.5核'）+ 列表=每进程会话累计 CPU 时间 + 状态区豆腐块=CPU X.X核（3 点平均）；cyan 系配色与 MEM green 区分，尺寸 360×450 一致 // v659: CPU 统计豆腐块 + 双 tab hover 面板（2026-08-29 q209 F36/F37）——① py-broker NtQuery 快照行级加 ut@0x28+kt@0x30（100ns ticks，同结构体链实测）+ ncpu；mem-meter v5 每 5s 差分 → 树级 CPU 平均利用率 = ΣΔticks/1e7s/Δwall/ncpu×100（任务管理器「性能」页同口径，64 核机实测字段命中），行级带每进程 CPU%（无基线 --），曲线点 c=分钟采样均值（{ts,mb,n,c} 持久化旧行兼容）；② 状态区 mem 旁新增手绘 CPU 芯片图标（7×7 主体+四向引脚，--mem-icon 同色）+ CPU 豆腐块（3 点移动平均防抖）；③ hover 面板双 tab MEM|CPU（hover 状态区豆腐块自动切 tab，pin 后可点 tab 按钮）：CPU 曲线 min=0 + p95 动态上界顶封 100（不做内存 4× 抗尖峰），y 轴 % 刻度，均值/峰值/谷值/已启动按 tab 取值，进程列表加 CPU% 列；④ 修 yDomain 上界污染 bug（max 提升循环把 100% 尖峰当上界） // v658: 状态区内存图标+数字统一中间色——--mem-icon 改浅色 #302f2c→#4b4a46（浅一档）/ 暗色 #e8e4da→#e2ded6；#qqq-status-mem 显式 color:var(--mem-icon)（原继承 --text-primary #656360，现深一档），图标文字完全同色 // v658: 状态区内存图标+数字统一中间色——--mem-icon 改浅色 #302f2c→#4b4a46（浅一档）/ 暗色 #e8e4da→#e2ded6；#qqq-status-mem 显式 color:var(--mem-icon)（原继承 --text-primary #656360，现深一档），图标文字完全同色; // v656: 状态区内存图标改版（2026-08-29 q209 f33）——14×14 芯片+引脚 → 11×11 斜电阻：zigzag 折线 clip-path 纯 CSS 手绘 + rotate(45deg) 斜置（无伪元素零额外 DOM），纯色 var(--text-primary) 主题自适应，dense-3 同步隐藏 // v655: 状态区内存图标（2026-08-29 q209 f32）——内存豆腐块前手绘 CSS 内存条（主体圆角矩形 + 4 引脚 box-shadow 复制，纯色 var(--text-primary) 主题自适应：浅色碳灰 #656360 / 暗色偏白 #dcd8d0，别太黑太白）；dense-3 与 #qqq-status-mem 同步隐藏 // v654: MEM 面板 v12（2026-08-29 q209 f31）——均值徽章文字再下移 1px（padding 1→2px，豆腐块位置不动）+ 平均内存 > 1GB 时豆腐块主题色转红（var(--red) 边框/背景/文字，.hot 类）+ 触发点弹 qoast「独立启动包：xx 当前滴总内存（含子模块）占用超 1g」（抗尖峰均值口径、边沿触发 + 1h 冷却防刷屏、常驻+知道了按钮；主进程广播 label = 包根目录名） // v653: MEM 面板 v12（2026-08-29 q209 f30）——① 进程列表滚动条右移 4px（plist margin-right:-4px 容器右扩 + padding-right:4px 内容原位，滚动条更贴右缘）② 进程数「13（峰值15）进程」前加 4px 空格空隙 ③ procs 去粗体（继承 MEM 标题 bold → font-weight:normal，字号 12px/颜色不变） // v652: MEM 面板 v11（2026-08-29 q209）——① 百分位坐标（p5/p95 中央 90% 数据）定 y 轴：重负载期 ~565M 段（≈2.3× 中位数够不着 4× 尖峰阈值）旧算法定坐标 max=565M → 常态曲线压成地平线「墙」，现常态铺满全图、墙/尖峰钳顶端仍真实可见；② 标题行重构：进程数「10（峰值11）进程」移到 MEM 旁，右上角原位置放 reset 按钮（pin 后可点，清 mem-curve.log + 内存缓冲 + 重启垂线，广播全窗口同步清空从零重记）；③ 进程列表头「进程 · 专用工作集」→「进程 · qqqide工作集」；④ 均值徽章下移 1px（-5→-4）+ 内容下移 1px（padding 1px 6px 0 修 y 轴不居中） // v651: MEM 面板 v10（2026-08-29 q209 f27）——① 抗尖峰坐标/均值（城墙根治）：>4×中位数视为异常尖峰（打包/构建瞬态重负载，实测 3.4GB×25 点），不参与坐标与均值，绘制钳顶端+8% 余量——曲线不再被单次尖峰压成地平线；峰值/谷值保持真实值 ② 均值改抗尖峰口径（1041M→246M 型失真消除）③ 统计行左侧显示「已启动 X」（原趋势行位置，主进程 bootAt 广播，跨 Ctrl+R 持续）④ 均值徽章 translateY -6→-5px // v650: MEM 面板 v9（2026-08-29 q209 f26）——① y 轴刻度去粗体（字号 12px 不变）+ max/mid 各下移 2px（min 不动）② 均值徽章 translateY(-8px)→(-6px) 回移 2px + 跨度格式紧凑无空格（1h10m，旧 '1h 10m' 与 '10m' 间距不一致）③ 趋势行删除（曲线已表达内存变迁，stats 只剩峰值/谷值）④ 进程数增强: 10 进程（峰值 18 进程）——曲线点带 n 字段（60s 窗口进程数峰值，mem-curve.log 持久化 {ts,mb,n} 旧行兼容），峰值 = max(曲线点 n, 当前瞬时) // v649: MEM 面板 v9（2026-08-29 q209 f25）——点击卡片外任意区域关闭补全覆盖：三面板/编辑器/goods/roam 均为独立 iframe document，主窗口 document click 收不到 iframe 内部点击（旧版只有点状态区等主窗口 DOM 才关，q209 实锤）→ 逐 iframe 绑定 click（contentDocument 同源 qqqide-webapp://；标记挂 doc 上，iframe 导航后新 doc 由 load 重绑；MutationObserver 覆盖动态新建；跨域 try-catch 静默跳过）；主窗口 document click + iframe click 共用同一 closeByOutsideClick（取消固定+立即隐藏） // v648: MEM 面板 v8（2026-08-29 q209 f24）——① 均值徽章字号 13→15px + translateY(-8px) 上移 + padding 上下归零 line-height 1.3（放大不增占用，num 行 margin 3/5→1/3px 整体更紧凑）② y 轴刻度 10→12px（SVG 内放大零布局影响，PAD_L 34 仍容纳 299M 12px 粗体）③ 趋势语义修正：上升 ▲=红 var(--red)（占用增加）/ 下降 ▼=绿 var(--green)（占用减少）——旧版 up 绿/down 青语义反 // v647: MEM 面板 v7（2026-08-29 q209 f23）——①卡片上移根治：position 高度改实测 offsetHeight（CSS content-box 实际 466px ≠ PANEL_H 450 → 底部超出 16px 盖住状态区）+ 间隙 8→10px 双保险；②均值徽章字号 12→13 + 数字粗体；③状态区内存豆腐块字号 11→12 点击弹卡；④点击卡片外任何区域关闭卡片（document click，卡片内滚动/内存块自身除外）；⑤重启垂线：每次实例启动写 mem-curve.log {boot:ts}，曲线画浅白虚线垂线（暗色浅白/浅色蓝灰半透明，path 多段一次画完） // v646: MEM 面板固定 + 上移（2026-08-29 q209 f21）——① 点击状态区内存块 = 固定/取消固定（pinned 时面板 pointer-events:auto 可滚动进程列表，金色锁定视觉：渐变边框/dot/高光线变金，鼠标移开不消失；再点取消）② 定位恒上弹不遮状态区（空间不足贴顶 4px，删下弹分支）③ dense 窄窗隐藏时 pinned 面板同步消失状态保留 // v645 // v645: MEM 面板三修（2026-08-29 q209 f19 实锤）——① closeSeg 残留 PAD 常量（F17 改 PAD_L/PAD_R/PAD_T/PAD_B 时漏改）→ pts≥2 时 renderCurve 抛 ReferenceError 曲线/面积/均值全断，已改 PAD_B；② history 竞态根治：onMetrics 无条件置 inited → 首条 5s 广播先到即丢弃持久化快照 → 历史永不加载只剩 1 个采样点（截图实锤），改按 t 去重合并语义；③ 上区文字字号全提至与下区一致（title/procs/avg/stats 11→12px，y 刻度 9→10，curval/labels 10→11，plist-head 10.5→12，pmb 10.5→11.5） // v644: MEM hover 面板四修（2026-08-29 q209）——固定高度 450px flex（进程区 flex:1 恒高不再自动扩大）+ 统一 IDE 5px 滚动条 + 全文字号 +1~2px 对比度升档 + 去 foot 文案 + 曲线恒从左缘铺满（删 MIN_SPAN 钳制，起点不再落中间）+ y 轴刻度（max/mid/min）+ 最新点 halo 值标签 // v643: MEM 面板均值徽章 + 进程列表 + 弹性曲线（2026-08-29）——树序进程行（root 加粗/后代缩进/名称取自 NtQuery ImageName 零额外 API）+ 右上 24h 均值徽章（未满写实际跨度）+ 弹性窗口 span=5min~24h 先填满再改刻度 + 动态左/中刻度 + 面板空间不足自动下弹 // v642: MEM v3（2026-08-29）——冷启动修复（校准 pid 集变化作废重试/进程数增长立即重校准/无锚点期间显示上次持久化值）+ 30s 校准周期 + ΔWS 漂移钳制 ±25% + mem-curve.log 持久化（60s 一点 512KB 轮转，跨重启连续断档分段）// v641: MEM 三合一 + 24h 曲线 hover 面板（2026-08-29 F13）——显示值改专用工作集 Private WS（WMI Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate 60s 校准真值 + getAppMetrics WS 增量平滑，任务管理器「内存」列同口径，三值合一）；hover 换高科技自定义面板 shell-mem-hover.js（零延迟瞬间弹出 + SVG 1440 点 24h 曲线 + 渐变描边/面积/尾点脉冲/峰值谷值趋势，pointer-events:none 纯展示，dense-3 同步消失）// v640: 状态栏启动包内存显示（2026-08-29）——mem-meter 主进程真理机器 5s 聚合 app.getAppMetrics()（工作集 ΣworkingSetSize，任务管理器「工作集」列同口径）广播 qqqide:mem:metrics → 状态栏陪伴时间旁显示 x MB（tooltip: 工作集/提交/进程数），一包多窗口同值零重复统计，窄窗口 dense-3 随陪伴时间隐藏 // v639: AI 面板数学公式 KaTeX 渲染（2026-08-29）——renderMarkdown 行内 $...$/独立 $$...$$ 扫描（行内代码占位后/表格前，守卫防货币误判），KaTeX 0.18.4 本地打包 vendor/katex（JS+CSS+20 woff2 字体零网络），主窗口同步加载 CSS 使悬浮预览层公式样式化；system-prompt 提示公式用 $ 包裹 // v638: 星火计划去引号强制刷新（v637 已全链路无引号——源码/线上doc/绿色包副本三处实测，旧缓存残留致用户仍见引号，bump 清旧 precache） // v637: 眼睛弹窗文案联网同步服务器（doc qqqide-video，双线路 failover；离线/失败兑底 zh.json，弹窗打开自动重试）；星火计划去引号（网站+客户端同步）；清爽从2026 ◆列表（2026-08-28） // v636: 赞助商兜底改服务器配置（sponsor_config），离线兜底文案改「知佳」 'Type here'→'here'（2026-08-28 用户要求）——border/padding 2px 8px 不变；定位 top -2 → -1（豆腐块整体下移 1px） // v634: 眼睛弹窗明细加星火徽章（2026-08-26）——spark_enabled 且已结>0 的成交行追加银色「✨星火已入 ¥x」徽章（act.eye.sparkPaid 键）；服务端 /api/qqqide/activity eye_paid_list 带 spark_enabled/spark_paid_yuan // v632: 在线用户弹窗新增「独立消耗」列（2026-08-26）——消耗列右侧，格式 实扣+白嫖，数据 = 独立会话窗口（session_started_at 起）内消费：服务端按 ledger_entries.created_at ≥ session_started_at 精确过滤（ai_turn 负 + ai_turn_free 冲正正 → 净实扣；Σ ai_turn_free = 白嫖，与 doer_free_budgets 同源同额） // v631: kmd here 指示牌 padding 5px 9px → 2px 8px（上下大幅收窄）+ 定位上移 2px（中线对齐提示符行） // v629: kmd here 指示牌放大 + Type here（2026-08-25）——padding 2px 5px → 5px 9px（变宽变长）+ 圆角 4px；文字 'here' → 'Type here'（纠正拼写：Typing here 是动名词不自然，Type here 祈使句才是终端提示标准写法）+ 字号 10px → 11px // v626: renderMarkdown 行内代码扫描器重写（2026-08-25，q229 实锤）——旧 /`([^`]+)`/g 只认单反引号定界 + [^`]+ 跨换行贪婪：PowerShell 行尾 `` ` ``（双定界包裹字面反引号，标准 GFM 写法）第三游程错配后一路吞到全文下一个反引号 → 表格截断成 3 行 + 后续文本变无格式干打印（q181 f87 实锤）。新 _scanInlineCodes：反引号游程等长配对（GFM 严格语义，开闭定界符必须等长）+ 无闭合 → 字面输出零吞噬 + GFM 空格归一（首尾空格各剥一）；回归 13/13 PASS // v623: kmd here 指示牌定位根治（2026-08-25）——末尾空行（流式空壳/空 .line）无行框 → Chrome 空 range rect 全零 (0,0,0,0) → marker 定位到 body 原点 (6,0) = 左上角 cmd 按钮处（实锤截图）。修：锚定最后一个非空行（从后往前扫）+ range 零矩形时元素 rect 兜底（右边缘=行尾）；kmd:init 文件名预填加 rAF 双保险（下一帧 value 空才补回，零冲突）；roam x 键判定 ===1 → <=1（覆盖 selectedItem 有值但数组未同步边缘路径，多选仍拒绝）；回归 8/8 PASS // v6 // v643: MEM hover v4（2026-08-29 F16）——弹性曲线（span=max(5min,数据跨度) 恒铺满全宽随运行拉伸至 24h，刻度动态改标）+ 右上均值徽章（窗口跟随实际跨度，满 24h 即「24h 均值」）+ 进程列表（树序主进程加粗后代缩进，NtQuery ImageName 名称 + 专用工作集 MB，快照 rows 原样透传零额外查询）+ foot 统计来源说明（NtQuery 内核快照 5s 刷新）；面板高度自适应上弹下弹 // v642: // v642: MEM 曲线持久化 + 时间轴真实（2026-08-29 F14）——mem-curve.log 落盘跨重启连续（crash-net 同族 512KB 轮转）；冷启动修复（首校准 pid 集不全作废 + 无锚点显示上次持久化值 + ΔWS 漂移钳制 ±25%）；曲线点带真实时间戳 x 轴时间线性 + 重启断档分段 // v641: MEM 三合一 + 24h 曲线 hover 面板（2026-08-29 F13）——显示值改专用工作集 Private WS（WMI Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate 60s 校准真值 + getAppMetrics WS 增量平滑，任务管理器「内存」列同口径，三值合一）；hover 换高科技自定义面板 shell-mem-hover.js（零延迟瞬间弹出 + SVG 1440 点 24h 曲线 + 渐变描边/面积/尾点脉冲/峰值谷值趋势，pointer-events:none 纯展示，dense-3 同步消失）// v640: 状态栏启动包内存显示（2026-08-29）——mem-meter 主进程真理机器 5s 聚合 app.getAppMetrics()（工作集 ΣworkingSetSize，任务管理器「工作集」列同口径）广播 qqqide:mem:metrics → 状态栏陪伴时间旁显示 x MB（tooltip: 工作集/提交/进程数），一包多窗口同值零重复统计，窄窗口 dense-3 随陪伴时间隐藏 // v639: AI 面板数学公式 KaTeX 渲染（2026-08-29）——renderMarkdown 行内 $...$/独立 $$...$$ 扫描（行内代码占位后/表格前，守卫防货币误判），KaTeX 0.18.4 本地打包 vendor/katex（JS+CSS+20 woff2 字体零网络），主窗口同步加载 CSS 使悬浮预览层公式样式化；system-prompt 提示公式用 $ 包裹 // v638: 星火计划去引号强制刷新（v637 已全链路无引号——源码/线上doc/绿色包副本三处实测，旧缓存残留致用户仍见引号，bump 清旧 precache） // v637: 眼睛弹窗文案联网同步服务器（doc qqqide-video，双线路 failover；离线/失败兑底 zh.json，弹窗打开自动重试）；星火计划去引号（网站+客户端同步）；清爽从2026 ◆列表（2026-08-28） // v636: 赞助商兜底改服务器配置（sponsor_config），离线兜底文案改「知佳」 'Type here'→'here'（2026-08-28 用户要求）——border/padding 2px 8px 不变；定位 top -2 → -1（豆腐块整体下移 1px） // v634: 眼睛弹窗明细加星火徽章（2026-08-26）——spark_enabled 且已结>0 的成交行追加银色「✨星火已入 ¥x」徽章（act.eye.sparkPaid 键）；服务端 /api/qqqide/activity eye_paid_list 带 spark_enabled/spark_paid_yuan // v632: 在线用户弹窗新增「独立消耗」列（2026-08-26）——消耗列右侧，格式 实扣+白嫖，数据 = 独立会话窗口（session_started_at 起）内消费：服务端按 ledger_entries.created_at ≥ session_started_at 精确过滤（ai_turn 负 + ai_turn_free 冲正正 → 净实扣；Σ ai_turn_free = 白嫖，与 doer_free_budgets 同源同额） // v631: kmd here 指示牌 padding 5px 9px → 2px 8px（上下大幅收窄）+ 定位上移 2px（中线对齐提示符行） // v629: kmd here 指示牌放大 + Type here（2026-08-25）——padding 2px 5px → 5px 9px（变宽变长）+ 圆角 4px；文字 'here' → 'Type here'（纠正拼写：Typing here 是动名词不自然，Type here 祈使句才是终端提示标准写法）+ 字号 10px → 11px // v626: renderMarkdown 行内代码扫描器重写（2026-08-25，q229 实锤）——旧 /`([^`]+)`/g 只认单反引号定界 + [^`]+ 跨换行贪婪：PowerShell 行尾 `` ` ``（双定界包裹字面反引号，标准 GFM 写法）第三游程错配后一路吞到全文下一个反引号 → 表格截断成 3 行 + 后续文本变无格式干打印（q181 f87 实锤）。新 _scanInlineCodes：反引号游程等长配对（GFM 严格语义，开闭定界符必须等长）+ 无闭合 → 字面输出零吞噬 + GFM 空格归一（首尾空格各剥一）；回归 13/13 PASS // v623: kmd here 指示牌定位根治（2026-08-25）——末尾空行（流式空壳/空 .line）无行框 → Chrome 空 range rect 全零 (0,0,0,0) → marker 定位到 body 原点 (6,0) = 左上角 cmd 按钮处（实锤截图）。修：锚定最后一个非空行（从后往前扫）+ range 零矩形时元素 rect 兜底（右边缘=行尾）；kmd:init 文件名预填加 rAF 双保险（下一帧 value 空才补回，零冲突）；roam x 键判定 ===1 → <=1（覆盖 selectedItem 有值但数组未同步边缘路径，多选仍拒绝）；回归 8/8 PASS // v622: kmd render error 时序陷阱修复（2026-08-25）——openFileCustomTab 在 return 之前同步执行 renderFn(pane, tab) → kmd.js 闭包 var tab 恒 undefined → tab._onVisible 赋值抛 "Cannot set properties of undefined (setting '_onVisible')" → pane.textContent='render error:' 截图实锤。修：renderFn 改收第二参数 _tab（tab-manager 侧本就传了），tab = _tab || tab + 空守卫，返回值仅外层兜底（同一对象引用）；回归测试 6/6 PASS（同步时序/异步回调/防御分支） // v621: ResizeGrip v2 根治（2026-08-25）——pointer capture（鼠标拖出窗口后 move/up 仍派发到 grip，松手必退拖拽态，根治 v1 永锁）+ rAF 节流（125-1000Hz mousemove 只每帧执行一次 resize，根治同步 resizeTo 事件雪崩卡顿）+ 主进程 setBounds 链路（qqqide:window:resize-grip fire-and-forget，主进程 clamp 翼 min 宽度后 setBounds，左上角固定，窗口拖动期间渲染 JS 零阻塞）；CSS 补 touch-action:none // v620: kmd 可输入态 + here 指示牌（2026-08-25）——tab 可见性事件驱动零轮询（tab-manager.activateTab 唯一中心：custom tab _onVisible 回调 + active 标志，kmd:init 带 active 兑底快速切走窗口期）；kmd-ui 双信号 AND（kmd:active 消息 && iframe 原生 focus/blur）= 可输入态 → 编辑框亮背景 + 四边滚动虚线动画（repeating-linear-gradient ×4 + background-position 无缝循环）+ here 红豆腐块（#here-marker 浮层锚定最后一行行尾 = q 位置，仅可输入态+滚到底显示；浮层在 #out 外 + pointer-events:none + user-select:none + ::after 生成文本 → 百分百不可选中不可复制，Ctrl+F 检索不到）；scroll rAF 节流 + 非激活态零 rect 早退（性能最优）；同 tab 重复激活零派发 // v619: 右下角 ResizeGrip 移植（2026-08-25）——q.py 百分百同款：36x36 命中区 + 两条黄色平行斜线（SVG 照抄 q.py 坐标）+ nwse-resize 光标 + mousedown 拖拽同时改宽高（左上角固定，最小尺寸主进程钳制），替代旧 16x16 实心三角渐变装饰（bootResizeGrip 曾是空函数，功能彻底没有）。链路：index.html grip 内 SVG + shell-main.css .qqq-resize-grip + shell.js bootResizeGrip（2026-08-25）——Roam 选中单个文件按 x → kmd cd 当前目录 + 键入行预填文件名（不带路径，任何类型都填；多选/文件夹/无选中 → 只 cd 不预填）。链路：q2-roam-ui x 键 selectedItems.length===1 && type==='file' → _openKmdAt(path, name) → postMessage fileName → kmd.js _pendingKmd={cwd,fileName} → kmd:init 带 fileName → kmd-ui 预填输入行（focus+光标末尾）。// v617: 赞助商 label 跳转改 #sponsors（2026-08-25，F12）——gaea 标签激活走 hash，?sponsors query 参数不生效 → 直接跳转赞助商页 // v616: 赞助商 label 拆分（2026-08-25）——「赞助商」三字独立超链接跳转 gaea 赞助商页 + hover 变红，冒号独立不带链接（index.html + shell-main.css + zh.json sponsorLabelWord/Colon） // v609: 文件拖放接收（2026-08-24）——AI 三面板/roam/编辑器统一橙色虚线接收框：AI 面板拖入=图片走多图粘贴管线+其他文件/文件夹喂 AI 锚点（panel-drop.js）；roam document 级拖放复制修复（qqqRoamCopyPaths 暴露，旧 fl 级 drop 引用 IIFE 内函数致 ReferenceError 从未生效）+ 橙框（q2-roam.js）；编辑器拖入=paste-router.handleDrop 粘贴一切（copyFile 进 _qqqvault/ 保原名+锚点 WYSIWYG）+ 主窗口 drop-overlay.js 橙框贴编辑器边界 // v607: 活动豆腐块 v8（2026-08-24）——清爽/原料已完成 → 精简豆腐块（活动名+✓，进度条/数字/图标隐藏，外边框不变）；新增隐藏活动「美丽滴眼睛」（清爽达标才显示，位置紧跟最右已完成豆腐块，点击弹窗=介绍文案+已入累计金额；服务端 qqqide_eye_paid 表运营手动录入） // v606: ioast 任务坞（2026-08-24）——独立于 qoast 的任务卡（复制进度/耗时/取消/摘要）挂 X 区右下，空闲零占用；主进程 copyFile 聚合进度 + cancelCopy 取消（streamId 调用方传入，roam 粘贴接入） // v605: 删除 SW controllerchange 自动 reload（2026-08-23 q220 f10）——F5 加的「SW 切换控制权自动刷新」在 SW 首次接管页面时同样触发（无控制→有控制），每次启动（缓存清空/SW 字节变化）无条件 location.reload → 「启动完立即又重启一次/闪两个窗口」实锤。删 reload 保留 skipWaiting：资源 network-first 旧 SW 控制期间照样回源拿最新，Ctrl+R 一次生效承诺不受影响 // v604: secret.maskHelp 出厂默认关（2026-08-23）——绿色包首装不自动开 dsecret（settings.js defaultValue + secret-guard.js get 兜底 + catch 兜底三处同步 false），用户设置→高级手动开启 // v603: Monaco 右键菜单左右退避真终局（2026-08-23）——F2-F8 五轮 document 层 clamp 全失效根因：Monaco 0.34.1 useShadowDOM 默认 true → 右键菜单 .context-view 渲染在编辑器 shadow root 内，document.querySelector 恒 null、body observer 不可见、closest/contains 不穿透 shadow root → clamp 从未执行过（颜色/箭头走主题色+addAction 内部链路所以正常，用户观察完美吻合）。修：_makeEditorBaseOptions 显式 useShadowDOM:false（主编辑器+split view 唯一真理源一处生效），diff-edit.js/diff-render.js/git-diff-window.html 同修——菜单回 document，F8 三件套（style 属性观察+rect-delta 相对修正+编辑器边界兜底）与 shell-main.css .context-view 规则全部生效 // v602: Monaco 右键菜单左右退避终局修复（2026-08-23）——F3 childList 观察只在 render 时触发一次 + Monaco doLayout 相对偏移语义（style 值 = 目标 - 当前页面位置）会吃掉修正值 + closest('.monaco-editor') 失败退化窗口边界（Monaco 自身也按窗口避让 → 双双认为放得下 → 菜单悬在编辑器右缘外）三重失效。修：①attribute observer 观察 style 写入（每次 Monaco 定位后 microtask 修正，永不被覆盖）②rect-delta 相对修正（fixed/absolute/container 偏移全免疫，delta=0 防自激循环）③编辑器边界兑底（_allMonacoEditors contains 判定）；每次右键重试挂 observer // v601: 右键菜单 hover 对调（2026-08-23）——editor 白主题 hover 改 AI 面板大中小搜索色 #fdf6e3（qqqide-theme.js + diff-edit.js fallback 同步），AI 面板黑主题大中小搜索 hover 改 editor 金 #b58900（ai-panel/index.html）// v600: secret-guard 四防线（2026-08-23 q215 f9）——① T2 降级协同（五次误伤全是 T2 自动抹除）② 语法门自动回滚（抹除后语法验证失败 → 不落盘转协同 + GATE-FAIL 审计）③ 引擎陈旧自检（SG_VER 比对，stale → 零自动抹除只读协同）④ 文件类型分流（自动抹除仅限配置/文档类，源码类一律协同）；_skipValue 收紧全大写枚举/冒号组合；_eraseOne 人工路径同过语法门 // v598: 喂给 AI 方向箭头接线修复（2026-08-23）——__qqq_aiTarget 恒为默认 1 根因：面板发 qqq-ai-panel-focused 但父窗口从未监听 → ai-viewport.js 补消息监听（焦点面板 0左/1中/2右 → 更新 __qqq_aiTarget），编辑器右键「喂给 AI」标签箭头 + 层级水印 + Roam AI 项 + 视口注入目标全部跟随 // v596: secret-guard 五次误伤修复（2026-08-23 q178 f93）——panel-quest-ui.js L1369 `var token = ***REDACTED*** && ...` 二次被 T2 抹成 ***REDACTED***（04:43:14 UTC 旧引擎扫描，F85 补丁后热更前）+ secret-guard.js 自己中招；已恢复原值 + 确认 /^[([]/ 规则在磁盘完好；全仓残留扫描干净 // v595: Monaco 右键菜单边缘躲避升级（2026-08-23）——边界从窗口改为触发菜单的编辑器 DOM：光标靠右缘 → 右上角锚定向左展开（旧实现只钳 window 边界，菜单照样盖住编辑器右侧区域）；同步修正零闪烁（MutationObserver 渲染前触发，弃 rAF 晚一帧）+ 子菜单 holder 排除 + fixed/absolute 双坐标系换算 // v594: Monaco 右键菜单 Solarized 配色（menu.* 主题色，Monaco inline style 唯一来源）+ 喂给 AI 方向箭头（←📎 喂给 AI / 📎 喂给 AI→） // v592: 自动 onlyFacts 结算修复（2026-08-23 F88）——pending 立即落盘 + settlePending 无条件结算（q178 f87：per-quest full 档触发后取消勾选 → lastAutoExtract 永不记录 → G1 冷却失效实锤） 项目主题色 var(--blue)（:root 已定义为橙金 #e8a030/#d4a017，与设置页滑杆同色，亮暗主题自动跟随） // v590: 独立滴压缩策略（2026-08-23）——压缩卡片新增勾选框：勾选后展开三点拉杆（关闭/中等/全托管）仅对当前任务生效立即生效；覆盖值存 ctx.json compressLevel（panel-quest.js payload + panel-floor restore 恢复），compress-machine getLevel(agent) 优先读覆盖再回退全局；取消勾选删除覆盖立即回退全局设置 // v589: 自动压缩设置项精修（2026-08-23）——标题改「自动压缩 上下文背包」+ 描述改一句话「默认值为中等」+ stopsLabels 中度→中等；标题右侧加问号按钮（外观照搬 ctx-panel #ctx-help，点击跳转 docs/qqqide-2）；拉杆宽度 = 音量 5 点拉杆的一半（flex:0 0 calc(50% - 22px)，点间距与音量百分百一致） // v588: 自动压缩机器 compress-machine.js（2026-08-23）——三档滑杆 ai.compressLevel（off/medium/full）替代 ai.compressThreshold 阀门值：V23 preHouse absolut 自动压缩退役（F80 一锅端定案，从不单独做 absolut）；楼层完结后 editOnly 自动一锅端（medium 收益≥64K / full ≥32K）+ full 档自动 onlyFacts（原料≥32K、距上次成功≥5 正常楼层、失败重试≤2/周期、postFloor 主 + preFloor 兜底、G5 定序 editOnly→onlyFacts）；settings 滑杆 showLabel 变体（关闭/中度/全托管）；agent-context 死代码 _readCompressThreshold/_stripAbsoluteBoxes/_estimateAbsolutBenefit/_tryAutoValveCompress 删除 // v585: absolut 自动压缩阀值出厂默认 100→50k，范围 100~1000→0~1000（defaults.js 真理源 + settings.js min + agent-context/agent-loop/content-gateway 校验与兑底同步） // v584: 上下文压缩卡片文案重写（2026-08-23）——标题「上下文背包 V24 引擎」，正文改为用户友好短文案（长程任务点管理减重 + 最佳实践 100k 阈值建议），删机械筛/三按钮/fx Grid 内部术语 // v581: renderMarkdown 表格转义管道符二次根治（2026-08-21）——_splitRowCells 从占位符替换升级为逐字符扫描（\| → 字面 | 不拆列；\\ → 字面 \；\\| → 字面 \ + 拆列，GFM 严格语义）；gaea 网站 docs-viewer.js renderTable 同源缺陷同步修复（split('|') 不识别 \| → panel_re{l|c|r}.json 破表实锤）。测试 9/9 + 8/8 PASS // v580: renderMarkdown 表格转义管道符修复（2026-08-21）——单元格内 \| 不再被 split('|') 当列分隔符（破表根因），改占位符替换后还原为字面 |；表头/表体统一走 _splitRowCells；GFM 语义 \\| = 字面 \ + 分隔符。AI 面板 + 悬浮预览层（open-table 复用中面板 HTML）双处同时生效 // v579: dsecret goods（2026-08-21）——密钥脱敏专职控制台：goods/dsecret/{dsecret.js,dsecret-ui.html} X 区 custom tab（菜单行2 按钮），中转 core/secret-guard.js 新导出 __qqqSecretGuard API（scanProject dirty/full / act / getData / removeWl / gitLogSearch / gitIgnoreAdd / setEnabled / onDirty）；gaea-host toolbarIds + dsecret；secret-guard 抽 _parsePorcelain + _processFile 返回 auto + 全量遍历 _walkFiles // v578: 悬浮预览层底层 bug 三修（2026-08-21）——① renderMarkdown 代码块/行内代码延迟恢复（[文字](URL) 不再被 Links 规则误转成真实链接，悬浮预览里代码变蓝色链接实锤）；② 主窗口全局 target=_blank 链接 capture 拦截 → 外部浏览器（shell.js）；③ 预览层链接主题色禁蓝（shell-overlay.js）；④ secret-guard 表达式误伤修复（parsed.xxx.get('token') 不再被抹坏源码） // v577: 协助密钥脱敏（secret-guard.js 新增，订阅 ai-viewport qqq:git-dirty 事件；settings 高级页新增 secret.maskHelp 开关；zh.json 新增 secretGuard 文案段） // v571: vibe 弹窗历史充能框 v5（2026-08-20）——填充改固定纯色层（.qqq-vibe-hist-fill 宽度=百分比，颜色恒 rgba(42,161,152,.85)，不再按填充长度压缩蓝→黄渐变）；标题行样式恢复 F57 删除前版本（12.5px/700/#8fa3c8/margin 0 0 8px） // v568: vibe 弹窗历史充能框 v3（2026-08-20）——删标题行「前 8 次免费窗口」；框 56×30→54×28（上下窄 2px 左右窄 2px）、间距 2→4px；配色换绿黄系（填充 rgba(42,161,152,.85)→rgba(133,153,0,.8)，边框 rgba(133,153,0,.55)，原蓝系）；删 act.vibe.histTitle 键 // v567: vibe 弹窗历史充能框 v2（2026-08-20）——单行 8 个 56×30 圆角矩形仅显数字（摇出额度），背景填充百分比=充能（剩余比例，满=没用过），hover 瞬间弹出框只显示该窗口实际已用额度（data-used）；删 track/fill/used 样式与 act.vibe.histUsed 键 // v566: 赞助商状态栏回归静态位置（2026-08-20）——品牌名恢复单 <a> 基线对齐（原 roll 盒 vertical-align:bottom+height 1.25em 致下偏 2px）；轮换去跑马灯动画改瞬间替换文字（防视觉分散）；hover 变色恢复（.qqq-sponsor-link:hover 重新可命中）；CSS 删 .qqq-sponsor-roll/-track 盒样式 // v565: vibe 弹窗「前8次免费窗口」充能框区域（2026-08-20）——服务端 /api/qqq/free-budget 新增 history 数组（最近 8 个历史窗口，排除当前，时间正序，每项 budget_ge/consumed_ge/remaining_ge，ledger FreeBudgetHistory 方法）；客户端弹窗内圆角矩形充能框一行：大数字=该窗口摇到滴额度（1 位小数），充能条=剩余比例（vibe 蓝渐变），小字=实际已用；弹窗打开强制拉最新（fetchVibeBudget force 参数）+ 失败旧缓存兜底；zh.json 新增 act.vibe.histTitle/histUsed // v564: vibe 弹窗免费时段行时区化（2026-08-20）——先显示「免费时段：(UTC) 周日全天+每日01:00-03:00/13:00-15:00」2 秒后渐隐（0.6s opacity），切换为「(用户系统时区) 周日全天+每日{本地换算区间}」渐显固定（Intl.DateTimeFormat().resolvedOptions().timeZone 权威，失败兑底 UTC；区间按 getTimezoneOffset 分钟换算跨日取模，如 +8 → 09:00-11:00/21:00-23:00）；新增 act.vibe.popWindowLocal 键，旧 popWindow 文案同步改 UTC 版 // v563: 队列直通发送定案（2026-08-20）——排队消息不再经过编辑框（直接 intent 载荷）：编辑框草稿（文字/图片）永不被队列触碰/覆盖，草稿保护机制整体废除，自动暂停唯一来源=人工点暂停；点「继续」只清标志+排水，不再把未完成草稿入队发送（用户实锤 bug）；_executeSend 图片源 intent.images 优先 + fromQueue 不清空编辑框/图片条 + fatal 拦截复位排水锁；_rescueDraftToQueue/ai.queue.draftKept 删除 // v562: 修复图片预览「文件/路径」按钮误报无本地文件（2026-08-20）——楼层图片恢复/在线渲染时 dataUrl 缩略图优先，磁盘路径（_fDir+fileName）丢失，overlay 解析不出路径。修复：open-image 消息新增 localPath 字段（card-pool.js 恢复渲染 dataset.localPath + badge/展开按钮透传、panel-pipeline.js 在线 badge 动态 resolveFloorDir、panel-send.js openLightbox 第三参），overlay 三按钮优先 _ovLocalPath。v560 为图片专用三按钮（内存/文件/路径）。链路：shell-overlay.js 三按钮 → 主进程新增 qqqide:clipboard:writeImage（ipc-misc.ts nativeImage）+ 既有 writeFiles/writeText。// v561: 修复图片预览「文件/路径」按钮误报无本地文件（2026-08-20）——楼层图片恢复/在线渲染时 dataUrl 缩略图优先，磁盘路径（_fDir+fileName）丢失，overlay 解析不出路径。修复：open-image 消息新增 localPath 字段（card-pool.js 恢复渲染 dataset.localPath + badge/展开按钮透传、panel-pipeline.js 在线 badge 动态 resolveFloorDir、panel-send.js openLightbox 第三参），overlay 三按钮优先 _ovLocalPath。v560 为图片专用三按钮（内存/文件/路径）。链路：shell-overlay.js 三按钮 → 主进程新增 qqqide:clipboard:writeImage（ipc-misc.ts nativeImage）+ 既有 writeFiles/writeText。// v559: Roam 标签恢复大写 R（2026-08-20）——tab-manager 硬创建 + rage.js 注册 title 改回 'Roam'（品牌全小写化时被改），文字左移 2px 宽度不变（shell-main.css .qqq-tab-name translateX(-2px)）。v558: AI 面板图片 hover 新增「Roam」按钮（2026-08-20）——点击激活 roam tab + 聚焦 + 跳到图片所在目录并选中（q211 f8）；链路：ai-panel card-pool/panel-render → shell-overlay reveal-in-roam → q2-roam qqq-roam-cmd roam.revealFile。表格/代码块零改动。v557: 队列自动暂停自愈（2026-08-20）——暂停分人工/自动两态：仅暂停按钮置 _queuePausedManual，草稿（文字/图片）触发的自动暂停在楼层完结（panel-pipeline 自愈）或草稿清空（updateQueueBtn 自愈）时强制恢复，永不粘死；点「继续」草稿随行入队尾零丢失（队列满保持等待+qoast）；纯图片草稿不再被队列发送静默覆盖；死代码 _continueQueue 删除 // v556: AI 面板输入区布局定案（2026-08-20）——队列信封移到图片条上方（历史→队列→当前输入 时间序）：图片属于当前编辑消息应紧贴编辑框，队列是已提交待发消息组应贴近消息区；DOM 顺序交换（queue-strip 在 image-strip 前），两条 display 互控独立、getElementById 零兄弟依赖，无边界情况 // v555: 原料活动二选一锁定 UI（2026-08-20）——领过任一项后两按钮同时置灰不可点（claimable && !claimedGe && !claimedPhone，服务端 claimable 同步排除已领）；已选过 qoast（act.ge50.already/alreadyOther）及相关逻辑删除，already 分支改静默同步状态；充值门槛服务器 .env 5→50 // v554: 在线用户弹窗新增「独立」列（2026-08-18）——连续(m) 与 版本 之间，数据 = doer_state.independent_count（断开>1h 再上线 +1，服务端 migration 0031） // v553: kope-a 离线横幅选择器作用域修复（2026-08-18）——横幅挂 historyContainer 但查重/隐藏查 historyList 永远查不到 → 每次断线叠加新横幅（434 多次打印根因）+ kope 在他处启动后横幅永不消失；查重改同层，隐藏改 querySelectorAll 清历史残留 // v552: conv 格子选中色改传统黄（2026-08-18）——::selection 从 kmd 灰系（#d6d6d6/#073642）改为项目主流黄色系（light #ffd301/#000 · dark #6a5a10/#f0e8d8，git/search/roam/overlay 同款），用户要求 editor 传统黄底 // v550: conv 背包页刷新机制定案（2026-08-18）——① 删手动刷新按钮 + 删整个 toolbar 行（回收 y 轴）；2s 轮询升级为 conversation 指纹检测自动重建（消息数+尾部3条 content/tool_calls+ctx 饼干/facts 条数，流式/新消息/压缩/恢复全部覆盖，格子永远实时）② ⊞⊟ 移到压缩工具栏最左（margin 0 / 0 4px 0 2px，goods search 同款）——旧 .toolbar button 特异性覆盖 .cbtn 致 18px 小方钮从未生效（丑的根因），删 toolbar 后 cbtn 样式真正落地 // v549: conv 背包页微调（2026-08-18）——① tab 标题去 📋 前缀（固定文本「qxxx 上下文背包」纯文字）② 复制按钮不再独占一行——仿编辑器面包屑同款：hover 格子文本区时 📋 悬浮浮现于内容右上角（cell-copy-btn 绝对定位，删除 cell-actions 行） // v548: conv 背包页工具栏重构（2026-08-18）——① tab 标题固定文本「qxxx 上下文背包」（弃 questStore.list 异步补齐）② 删全选/取消/搜索框/「选中格子→新对话」整条链（选中机制+openNewQuest+selectAndGo+panel-state qqq-conv-new-quest 监听全删——格子内容本就全在 AI 上下文，显式再注入零增量；保留「复制此格」）③ 全部展开/折叠改 cbtn 小按钮 ⊞/⊟（仿 goods search 百分百同外观）④ bottombar 删除回收 y 轴 // v547: run_command 多行命令静默失败根治（2026-08-18 F146 实测）——Windows 整串 shell:true 时 cmd /d /s /c "python -c "a\nb"" 嵌套引号配对错乱 → 输出消失+后续命令被吞（多行 python -c/node -e 全静默）；tools-exec-effect.js 多行命令安全分词 → 数组 spawn（shell:false CreateProcess 直传，换行在参数里合法），仅引号外无 cmd 语义元字符（&|<>^% / cd 开头）才走数组，保守分流 // v546: conv 背包页顶部信息行整体删除（回收 y 轴；格子/字符/估算/API 统计 + 标题行全移除，刷新按钮移入 toolbar 仅图标+title tooltip）；tab 标题修复 questStore.getTitle 不存在→异步 list() 补齐（tab 恒显纯 qid 根因） // v545: 全局 x 键召回 kmd（2026-08-18）——非编辑态 x 立即打开一个新 kmd（key-bindings 新增 window.activateKmd + shell-menu handler：路径优先级 = iframe 转发携带 path（kmd 自转发=自身 cwd）→ 活跃文件 tab 父目录 → 工作空间根；shell.js 兜底直连同款双保险）；kmd 多开语义定案——roam x/右键/全局 x 一律新建 kmd tab（弃 cd 复用）+ 播放终端音效 zs861（_playRoamSfx 300ms 去重）；kmd-ui 转发块 x 带自身 cwd（window.__kmdCwdGet）；其余 7 个 goods iframe 转发块（ai-panel/conv/dm/git/kope/rage/search）同步支持 x；菜单行2 kmd 按钮 hover 大字号 tooltip「按 x 键打开一个新 kmd」（复用 .qqq-roam-tip 样式 + data-owner 重建清理） // v543: inbox sidebar 精简（2026-08-18）——删 Messages 标题行回收 y 轴空间；搜索框去放大镜图标，placeholder 改英文 find，筛选框置顶 // v542: inbox 在线/离线状态整体弃用（2026-08-18）——1h ping 窗口有 15min 上报间隔 + 1h 滞后下线，无法百分百闭环（用户定案删干净）；私聊头部不再显示在线状态，服务端 fillPeersOnline 删除 // v541: kmd 正方形菜单 hover 展开（2026-08-18）——killWrap mouseenter 即展开（不用点两次），mouseleave 500ms 延迟收起（enter 清除定时器防闪烁，菜单是 wrap 子元素视觉间隙 4px 也顺滑）；click toggle 与 toggleKillMenu 函数删除（废弃即删）；菜单项点击后关闭不自动重开（鼠标仍在 wrap 内无 enter 事件，移出再移入重开） // v540: kmd 右键菜单（2026-08-18）——custom tab 同普通文件标签：在右侧/左侧再开（onReopen 回调优先，kmd.js openKmdTab(side) 新会话+标题序号自管；未注册则 tab-manager 通用复刻 renderFn）+ 关闭其他/关闭所有；openFileCustomTab 新增 opts.group（'right'/'left'/组对象）指定目标分组；tab._custom 保存渲染闭包；contextmenu 挂载条件 filePath || custom // v539: 压缩动画 stale 缓存根治（2026-08-18 q181 f77 实锤）——_estBackpackChars 强制绕过 _estimateTokensFull 缓存（edit only 压缩不改饼干首尾 40 chars + biscuitLines 条数不变 → 缓存 key 全同 → after 返回压缩前旧值 → 动画「182k→182k/100%」静止假象，真实收益 81k tokens）；动画百分比收益 <0.5% 时显示一位小数（99.8% 诚实显示，不再裸 100% 误导） // v539: 压缩动画 stale 缓存根治（2026-08-18 q181 f77 实锤）——_estBackpackChars 强制绕过 _estimateTokensFull 缓存（edit only 压缩不改饼干首尾 40 chars + biscuitLines 条数不变 → 缓存 key 全同 → after 返回压缩前旧值 → 动画「182k→182k/100%」静止假象，真实收益 81k tokens）；动画百分比收益 <0.5% 时显示一位小数（99.8% 诚实显示，不再裸 100% 误导） // v538: 清爽从2026 已满弹窗大标题插入脱敏手机号（恭喜！86158xxxx8204 充能已满，tp 插值 {phone} + maskPhone 前5后4，方便用户截图自证） // v537: kmd 多窗口 + 命名输入框（2026-08-18）——openFileCustomTab 支持 allowMulti（每次点击开新 kmd tab，customId 自增 kmd-N）；新增 setCustomTabTitle（空标题忽略 + code point 40 截断 + textContent 防注入）；kmd-ui 工具栏 Clear 按钮收进正方形菜单第一项（原位改命名输入框，输入即 kmd:title → 标签标题实时同步，maxlength+JS 双边界保护）；roam x 键多开后只对最近 kmd 会话 kmd:cd 不再广播 // v536: 两活动弹窗副标题字号 15→17px 放大 2px（清爽「从2026开始，更轻，更快」+ 原料「你滴上下文资产现在归你」） // v534: hover 背包图解卡片右移量 10→18px（用户要求整个卡片再往右） // v532: 背包重量显示唯一真理（2026-08-18）——按钮/Free/图解 displayTotal 恒用当前背包 localTotal，弃 _lastApiPromptTokens 偏好（上次请求账单数含已压缩楼层 → 楼层间窗口/重启后僵尸数字，q178 实测 179k vs Local 64k）；hover 卡片右移 20→14px（回左 6px）；彩色格子起点回最左边界 left:-12px（空气墙恢复） // v531: hover 背包图解卡片整体右移 20px（卡片总宽 406px > 面板可用宽，左缘被面板左边界截断，q178 f59）；absolut/edit only 无可压缩内容（收益 <300 tokens）→ 拒绝不再播动画（消灭「重量减小至 100%」逻辑漏洞）；压缩动画弹窗加宽 340→460px（进度条随之左右增宽） // v530: 压缩动画底部说明行删除（用户要求）；ctx-breakdown 条形图 left:-12px→0（竖条不再侵入文字左侧 padding 区，消除「文字左移被截断」观感，q178 f58） // v528: 原料弹窗文案回归——task3 简化「累计充值满 X 元」（删历史累计注释+已累计小字）；已领取按钮恢复「额外再领取」前缀 // v527: 背包数字闭环四修（2026-08-17 q178 截图实锤）——① fx 重启后 "[object Object]" 根因（ctx.facts 是对象 {source,extracted_at,text}，restore 重建/管理页摘要直接 join 对象数组 → 15 字符 = 6 tokens，3936 字符事实全丢）；② 压缩动画 before/after 改整个上下文背包（旧=饼干 chars，用户看到 110k→11k 与右下角全背包数字对不上）；③ 饼干子项闭环——╔K 行统计=头行+体部（旧只计体部，q158 缺口 23k tokens 大头=362 个头行 15.5k）+ 新增结构行（=== F 分隔/时间戳/[S]）= 饼干总−Σ子项数学恒等 // v526: only facts 压缩白做三连修（2026-08-17 F52）——① ctx.biscuitLines 本地解析（_parseBiscuitFromContent 在 agent-context IIFE 内不可见 → 压缩后磁盘饼干保持完整，q158 f46 实锤）；② V21 截断位置 fx 注入后重定位（旧 floorStart 误删 biscuit 消息）；③ 守卫回原料口径 hText≥32K（F50 收益口径虚高 5-9 倍，q158 显示 -98k 实际原料 11k），conv-ui computeBenefits 同步 hChars // v525: 原料充值门槛口径修正（2026-08-17）——充值统计从废弃的 tx_type='recharge'（Xsolla 表线上零记录，恒 0）改为 tips 表已支付订单（geflow 充值入口，微信/PayPal，amount_cny 累计）；历史累计语义与消费达标先后无关（下周 .env 改 50 即历史累计充 50 元）；客户端第三行文案改「累计充值满 X 元（历史累计，非再充）」+ 未达标行尾显示已累计充值金额 // v524: only facts 目标 agent 解析 + streaming 闸门豁免 + 拦截回滚（2026-08-17 F51）——_executeSend 旧代码全程用面板活跃 agent：用户在别 quest 建楼时点背包页 only facts → streaming 闸门误拦（q154 实锤：子弹已写/饼干已砍半/楼层未建/toast 假成功）+ compress 标志串号活跃 agent（V21 泄漏重演）。修：① _executeSend 开头从 pool 解析 intent.questId 目标 agent（正常路径零变化）② streaming 闸门豁免 compress ③ 所有权拦截 compress 显式 qoast ④ onlyfacts handler 建楼未开始时恢复饼干+落盘+显式报错 // v523: only facts 守卫口径修正（2026-08-17）——守卫与实际收益统一：收益 = 原始 biscuit − editonly 过滤后切半的后半段；旧口径 _hText（过滤后前半段）与估算端 afterAbsolut 切半不一致，q154 显示 -33k 实际 29.6K 拒绝（实际收益 70.4K）；conv-ui computeBenefits Step3 同步同口径 // v522: 原料领取按钮文案重写——左=手机号+「额外再领取 50 元话费」（已领=「50 元话费 · 已领取」），右=「额外再领取 50 ge」（已领=「50 ge · 已领取」），删「额外再领取 已领取」不通顺组合 // v521: 恢复链接不死锁五处闭环（q198 服务中断 429 事故：_startRecovery 早退复位 busy / 渲染复用链接整体复位 class+cssText+busy / 恢复中只允许光块 / onToken 清断引用 / _finishRecovery 双类搜索） // v520: 原料弹窗新增副标题「你滴上下文资产现在归你」+ 领取按钮前加「额外再领取」 // v517: kope-a 离线提示简化——横幅改「当前面板：kope-a 未启动」，空列表不显示 Clipboard history will appear here（2026-08-17） // v516: kmd 正方形菜单 tooltip 遮盖修复（2026-08-16）——tooltip 与菜单同位置重叠（z-index 99999 vs 500）→ 菜单打开时自动隐藏 tooltip、关闭后恢复；tooltip 文案精简为一行（提示菜单用法）；hover 加 killMenuOpen 守卫（菜单打开期间不弹 tooltip）； // v515: kmd 工具栏定案（2026-08-16）——Clear + 正方形菜单都回右侧、左右互换（Clear 左、正方形右），左侧只剩 3 个 shell 按钮；键盘 Ctrl+C 全区域只专注复制（输出区/键入行：有选区=原生复制，无选区=空操作，键入行发 \x03 分支已删），中断唯一入口 = 正方形菜单第一成员 Ctrl+C； // v514: kmd Ctrl+C 语义收口——键盘输出区只复制，指令编辑框有选区复制/无选区中断；正方形菜单新增 Ctrl+C 中断项，Terminate 保持强杀； // v513: kmd 工具栏调整——Clear 固定左侧；Terminate 改为自绘正方形按钮，点击只展开危险操作菜单，菜单内仅保留无图标 Terminate；v510: kmd 全局 Ctrl+V → 指令编辑区（2026-08-16）——只要 kmd 获焦点（输出区/工具栏/空白处均生效）：document capture 拦截 → bridge.clipboard.readText()（主进程读剪贴板零权限问题）→ insertToInput 光标位插入；键入框/查找框保留原生粘贴语义不劫持；输出区 paste 事件转发（右键菜单粘贴也生效） // v509: Roam path-tooltip Area 4 补漏（q3 移植缺口 2026-08-16）——handlePathTooltipHover 只有盘符/qq区/历史区三分支，主资源列表区 .file-item 分支缺失 → 文件名被省略号截断时 hover 不弹完整路径；补 .file-item 分支（.folder-name-area/.file-name-area ellipsis 判定 → data-path 完整路径，q3 Area 4 同款逻辑，#fileList 已在 #kyContent 委托范围内无需新绑定） // v509: Roam path-tooltip Area 4 补漏（q3 移植缺口 2026-08-16）——handlePathTooltipHover 只有盘符/qq区/历史区三分支，主资源列表区 .file-item 分支缺失 → 文件名被省略号截断时 hover 不弹完整路径；补 .file-item 分支（.folder-name-area/.file-name-area ellipsis 判定 → data-path 完整路径，q3 Area 4 同款逻辑，#fileList 已在 #kyContent 委托范围内无需新绑定） // v508: only facts 修复 CPT is not defined（_CPT_loc 局部变量，panel-quest-ui.js onlyfacts handler 作用域隔离） // v508: only facts 修复 CPT is not defined（_CPT_loc 局部变量，panel-quest-ui.js onlyfacts handler 作用域隔离） // v507: kmd 切换 gitbash 无主目录时空目录不显示空行（switchShell 空 cwd 无路径抬头）（2026-08-15）——switchShell 成功后追加一行 ❯ /path // v505: kmd placeholder 淡黄色（2026-08-15）——--ph 改 solarized yellow 系：亮 #b58900 / 暗 #c9a227（经 opacity .5/.7 呈淡黄），替换 v502 的 base01 灰 // v504: kmd gitbash 路径抬头回归（2026-08-15）——F43 提示符块整块丢弃把路径也丢了（bash 每次提示符前写 OSC 标题 \x1b]0;MINGW64:/path\x07，被 cleanAnsi 剥掉）；新增 extractOscTitle 在 cleanAnsi 之前拦截 OSC 标题提取当前目录 gbCwd（跨 chunk 切碎续接同款状态机，仅接受 MSYS 路径形态防其他程序设标题污染），命令回显行渲染 ❯ [路径] 命令（gbpath span dim 灰，cmd/PS 提示符同款形态），cd 后下次提示符 OSC 自动更新；winToMsys Windows→MSYS 路径转换，init/cd/切换 shell 三处初始化；回归测试 14/14 PASS // v503: 楼层分配「先 mkdir 成功再落号」+ f1 空壳预创建删除 + 分配失败内容诚实恢复（gaea q145 f1/f2/f4/f3/f5 事故根治——nextFloorNum 只读探号零写入/commitFloorNum 单调落号，物化抛错号不蒸发；草稿晋升不再预建 f1 目录；qoast 假文案「内容已保留在编辑框」改为真恢复：编辑框空→恢复原文/非空→error 气泡保留原文；alloc-fail stack 落盘 agent-*.log 复现钉死真抛点） // v502: kmd placeholder 颜色对齐 AI 聊天编辑框（2026-08-13）——亮色 #586e75（solarized base01）+ opacity .5（AI 编辑框同款语义），暗色 #7a7670 + opacity .7；旧 --ph 近背景色（亮 #e0d8c4 / 暗 #3a372f）太淡用户反馈 // v501: AI 视口下拉背景两色交错 // v501: AI 视口下拉背景两色交错（2026-08-13）——第1层=f0e9a0 黄（dropdown CSS），子菜单按 depth 奇偶交替：depth 偶数=e7e4c2 / 奇数=f0e9a0（ai-viewport.js openSubmenu 内联，替代旧 goRight 方向双色 #e7e4c2/#ede4cf）；暗主题保持方向成对 #1e211e/#232a23 不变 // v500: kmd 键入行 textarea 化（2026-08-13）——input→textarea：默认 3 行高 / 最大 8 行高 / 自动换行（长命令多行显示），autoResize 高度自适应（内容增长到 8 行封顶滚动，提交/历史填充/命令召回后重置）；placeholder 极淡（--ph 近背景色，弱于一切正文/边框色，亮 #e0d8c4 / 暗 #3a372f）；line-wrap 改顶部对齐（多行时提示符 ❯ 贴首行） // v499: kmd 渲染管线三修（2026-08-13）——① 流式路径 ANSI 剥离漏接根治（F41 只测了 stripAnsi 函数本身，渲染管线 segInto 从未调用 → gitbash 原始提示符转义序列 [32m/]0; 原样上屏）；新增 cleanAnsi 跨 chunk 未闭合 OSC 状态保持；② gitbash 提示符块丢弃（OSC 标题 \x1b]0; = MSYS bash 默认 PS1 前导 → 置位丢弃到 $ 行，bash 提示符自带 2 个 \n 的三行噪音归零，每回车一行）；③ 双击让位原生选词（旧双击=召回 preventDefault 拦原生扩选）→ 召回改点击 ❯ 箭头 span；新增选区全局匹配高亮（selectionchange 250ms 防抖 → findAllRanges 精确大小写 → 独立 Highlight 集 kmd-sel-hits，流式追加自动重算）；回归测试 14/14 PASS // v498: 菱形描边回到 a 版——inset 0.5px 亚像素细线（q 版=border:1px solid #000，shell-menu.js 注释记录可随时切回） // v497: 菱形描边回滚到 q 版——0.5px 亚像素 inset 阴影 → 1px border（用户对比后回 a） // v496: goods 指示灯描边再细——border:1px 改 inset 0 0 0 0.5px 亚像素阴影（10px 元素 1px 边框占 20% 视觉偏粗，半像素阴影抗锯齿渲染更细） // v495: goods 指示灯描边定案——1px 纯黑，黑白主题统一（用户 2026-08-13 定案，删 [data-theme=dark] 白框覆盖） // v494: goods 指示灯描边根治——clip-path 会裁剪同元素 filter 输出（前两轮 drop-shadow 描边从未渲染的根因），改 rotate(45deg) 正方形 + border 2px（border 随旋转天然形成菱形描边），白主题黑框/黑主题白框，万花筒 1.2s 旋转不变 // v492: goods 指示灯万花筒改柔和五色 + 菱形描边主题化（白主题黑框/黑主题白框，4 正交 drop-shadow 合成清晰 1px 描边，替换旧模糊 1px 阴影） // v491: kmd 输出纯文本化 + Ctrl+F 检索三修（2026-08-13）——行内 SGR 彩色 span 结构整体放弃（每行单一文本节点：选中/复制/检索零干扰，ANSI 全剥离防乱码，颜色降级行级 class err/self/dim）；findAllRanges 三 bug 根治：① nodes.push 漏写（节点从未收集 → 检索恒空，Ctrl+F 外壳根因）② 跨行匹配加行分隔符 + 分隔符位段起点归零（负偏移毁 Range）③ 空查询守卫（indexOf('',pos) 死循环）；回归测试 22/22 PASS // v490: AI 视口配色全量回滚（2026-08-13）——F96/F98/F101 三波马卡龙/豆腐块色系系统全部还原到 08-09 状态，白主题下拉背景 e7e4c2→f0e9a0 改黄一点；品牌小写注释保留 // v489: goods 品牌名全小写化（2026-08-13）——search/git/kmd/inbox/roam/rage/wysiwyg 显示层+注释层+文档层全小写（外部专名 Git for Windows/GitHub/Git Bash/i18n 翻译值保留），杜绝编码认知分裂 // v488: AI 视口色系 v2（2026-08-13）——色系改 HSL 基色程序化生成：每档 = 基色 hue ± 偏移（相邻色相过渡，流动动画肉眼可见），S 48-67% / L 89-95% 保持非常淡雅；色系随机绑定逻辑不变（进入视口随机一次、窗口生命周期绑定、相邻异色、层级色系内随机） // v487: kmd Ctrl+F 全文检索高亮（2026-08-13）——CSS Custom Highlight API（Chromium 108 原生，零 DOM 改动）：全匹配 #ffe792/暗 #4a4412 + 当前匹配 #b58900 反色，选区/光标词自动填入查找条（capture 拦截 Electron 原生 find bar），Enter/Shift+Enter/F3/Shift+F3 导航，Aa 大小写切换，Esc/✕ 关闭；输出流式追加 MutationObserver 120ms 防抖重算保 idx；输出区 ::selection 对齐 editor solarized（light #d6d6d6 / dark #274642）+ caret 同步 accent // v486: goods 指示灯万花筒加黑边 + 颜色改鲜艳高饱和（drop-shadow 跟随 clip-path 菱形，黄/灰态不变） // v485: kmd 输出区只读编辑器化（2026-08-13）——#out contenteditable="plaintext-only"：点击任意位置出闪烁光标（原生）、拖选/Shift+左键选区、任意复制；键盘拦截禁编辑（放行导航/选区/Ctrl+A/Ctrl+C，可打印字符自动注入键入行并聚焦，Enter/Tab 回键入行）；单击=放光标（删 mousedown 抢焦点，选中根因）、双击=命令召回（旧单击召回与光标冲突） // v484: AI 视口豆腐块色系系统（2026-08-13）——豆腐块进入视口随机一次、窗口生命周期绑定、相邻块异色、每个展开层级色系内随机取色（--aiv-c0..c4 内联变量，删 6 套 aiv-macaron-N）；goods 指示灯万花筒改淡暖色 + 1.2s 快转 // v483: 粘贴文件夹全线修复（2026-08-13）——主进程 qqqide:fs:copyFile 目录感知（递归复制 8 路并发 + 字节级进度，单一引擎 Roam/编辑框共用）；Roam 粘贴 readFiles-first（CF_HDROP 完整路径 → 文件夹+文件混合一次粘贴，4 路并发）；编辑框 paste-router 文件分支升级（CF_HDROP 完整路径 → 递归复制进 _qqqvault/ + 锚点带真实 path = 所见即所得粘贴文件夹，DOM-only 降级文件名锚点） // v482: kmd gitbash 输出三修（2026-08-13）——bash 无 TTY 交互把提示符/回显/警告全写 stderr → ① err 流不再标红（满屏红字根因）② bash 自身回显按 lastSentCmd 去重（与 UI 蓝色 ❯ 行重复）③ 启动警告两行（cannot set terminal process group / no job control）纯噪音丢弃 // v481: Roam 空区右键菜单排序调整（喂给AI→kmd→PowerShell→CMD，快捷键随项不动：m=CMD p=PowerShell） // v480: goods 进程指示灯马卡龙→鲜艳五色万花筒（2.5s 快转）；AI 视口下拉/子菜单/最近列表背景改马卡龙流线随机背景（6 套变体 JS 随机挂载，9s 流动动画，暗色主题保持原样） // v479: 服务端甲壳兜底 4 处 21691→21354 对齐 guard-meta FALLBACK_CHARS（F20 漏改，铁律 10.1 唯一入口） // v478: kmd cmd 命令回显修复（2026-08-12）——cmd 启动参数去掉 /q（关闭回显）→ 用户发的命令在输出区消失只看到返回（q181 f30 实锤）；去 /q 后 cmd 原生回显提示符+命令，与 PowerShell/gitbash 行为统一 // v477: ctx-panel 弹窗文案更新（V16→V22 + f1/f2/f3 三级 facts→fx 唯一一条增量追加）+ 按钮行左侧新增帮助按钮（外观照搬排行榜问号，无 hover 提示，点击跳转上下文背包文档 URL 去 lang 参数） // v476: aq 图解 AI text 互斥分类——assistant 消息带 tool_calls 且正文非空（2026-08-11 起原生 tool_calls 带 content）时旧逻辑双计（AI tool_calls + AI text）；改 error > tool_calls > text 互斥链 // v475: kmd-ui 补 F2/Tab 非编辑态转发父窗口（同 ai-panel/conv-ui 模式，iframe 内按键不冒泡父窗口；kmd 08-10 创建晚于 F126 补漏 → 漏网）——焦点在 #input（终端键入框=编辑态）不转发保留终端语义，输出区/工具栏/空白处按 Tab/F2 一键召回 Roam // v474: goods 进程指示灯运行态改马卡龙万花筒（conic-gradient 六色旋转，黄/灰不变） // v473: kmd 移到 X 区 file 分组（2026-08-12）——gaea-host open() 新增 opener 路由（goods 声明 opener 函数完全接管打开）；tab-manager 新增 openFileCustomTab（file 分组 custom tab 单例，无 filePath 不进 Monaco/不持久化/无右键菜单）；kmd.js tabs 声明 → opener（qqqTabs.openFileCustomTab('kmd')，菜单行2 按钮 + Roam x 键同路由）；kmd-ui.html body 显式 user-select:text（主窗口 shell-base body user-select:none 向 iframe 传播 → 输出文字无法选中复制的根因） // v471: Roam 空区右键菜单 4 行（①喂给 AI 带左右箭头=当前文件夹 ②kmd=x 打开 kmd 终端并定位当前目录 ③CMD=m ④PowerShell=p）+ 快捷键同步（x→kmd / m→CMD / p→PowerShell）；kmd goods 支持指定目录启动（_pendingKmdCwd 一次性消费 + kmd:cd 原地切目录 kill+重 spawn） // v470: q181 f21 三连事故根治（2026-08-12）——①工具执行活跃标志 _toolExecActive（agent-exec，长工具上传/长命令无 onToken/onCost 信号被 20min 停滞看门狗误判拉断，q181 f21 67:42 中断实锤：h24 后上传 116MB 发布包被 abort）；停滞看门狗工具续命一次（~40min 工具窗口上限防死循环）+ ghrun 15min 失速兜底；②绿时钟根治：_capAbort 手动 className 复位是一次性的——startFloorTimer setInterval 每秒填回时间+改回 clock-ai 绿色（永动机复活，q184 修复后仍复发），改调 stopFloorTimer（clearInterval+黑色+饼图定格）；③abort 路径合成 error log（_questErrorLogByFloor/_questErrorState/conversation _error 三处 + _renderQuestErrorBox）——abort 不写任何 error → 红框+继续任务链接永不渲染，用户只见 qoast 却无红框可点（F36 只修了恢复路径，运行中 abort 路径漏网） // v469: 孤儿 tool 400 根治（q1 f17 客户事故 + q181 f14/f17 样本实锤）——fatal 楼层最后一条 tool 残留 → 恢复楼层 slice 开头孤儿 tool → 重启 restore → 发送 400 "tool must be a response to a preceding message with 'tool_calls'"。四层防线：① 恢复 _repairOrphanedToolCalls 实现（agent-exec，铁律 6.3 预检曾是死调用）——发送前双向扫描删无配对 tool；② auto-repair 400 分支先净化再弹组（孤儿在开头/中间弹不掉 → house2 仍 400）；③ 落盘防线（panel-a4 floorConv 剥离开头 tool）；④ restore 拼接净化（panel-floor）。另 fatal→idle 合法化（守卫失败路径，消除 unexpected 警告噪音）。 // v468: fatal 死胡同根治（q184 重启后发消息无反应实锤）——恢复路径 floorFatal 且 exitReason 空/零 _error 消息时合成 error log（panel-floor，保证红框+继续任务链接必渲染）；_executeSend fatal 闸门拦截加 qoast 显式提示「点击楼层红框继续任务」（panel-pipeline，不再静默吞 Enter） // v467: 发送停滞看门狗（q184 20 分钟强拉断事故修案）——20min 总时长上限 → 20min 零进展上限：onToken（内容流）/onCost（每 house 完结）/onToolCall（每工具开始）三信号续命，长任务（60 houses/深思考/压缩）永不被拉断，仅真静默（网关风暴/IPC 挂死/SSE 哑火）才终止 // v466: 发送管线大动脉重构——锁表→per-quest 串行执行器（q182/q184/f28 同根因三次发作根治：agent._sendChain Promise 链 + 面板级 promoting 窗口，结构零并发；删锁表五函数+看门狗）+ 20min abort 时钟复位（q184 绿时钟）+ SSE 内容级看门狗 45s（心跳不重置，上游挂起自愈） // v465: kmd 终止按钮根治——kill+restart 旧进程 exit 竞态误删新会话（截图"进程已退出(code=1)+会话未就绪"根因）→ 会话身份校验；死会话点击⏹=重启；终止按钮自定义即时 tooltip（零延迟 solar 配色） // v464: V10 旧格式 biscuit unshift→splice 定序修复（Z→fx→biscuit 铁律 10.1，panel-floor）+ aq 图解 JSON overhead msgCount 含 fx/biscuit（口径一致，panel-quest-ui） // v463: quest 级发送锁（三通开工回归修复：__qqq_sendBusyMap 按 quest 隔离，不同 quest 三翼并发）+ reasoning_content 原样回传（q178 f29 http_400 根治：assistant 消息挂载思维链、agent-gateway 禁 strip、_estimateMsgTokens 计入）+ 楼层分配-物化窗口 try 包裹（f28 编号蒸发静默死亡→显式报错）biscuit 标记） // v461: kmd 自绘 shell 下拉（弃原生 select 弹出层白底蓝条，改 solar 配色自定义菜单）+ 移除 kmd 工具栏 cursor:pointer // v460: Inbox 在线状态并入 conversations 批量下发——删除独立 GET /api/dm/online 接口 + 客户端 checkOnline 网络查询（同表同窗口唯一真理，打开会话零额外往返）；收到对方消息直接标在线 // v458: goods kmd 终端（v1 行模式，分裂架构——输出日志式渲染器 + 键入原生控件点击定位；多 shell 宿主 cmd/powershell/gitbash；X 区 tab + 菜单行2 按钮） // v457: 服务端甲壳档1损坏修复（残句/重复/劈词）+ E-FLOW 模板 A/B 合并去重（Variant 结构）；fx 提取提示词英文化 // v456: 服务端甲壳字符数动态化（core/guard-meta.js 唯一入口 + /api/v3/ai/guard-meta 拉取 + 出厂快照兑底，4 处 14964 硬编码清除）// v455: only facts 增量提取（提示词带 fx 参照只提新增/变化）+ 清理死代码（_intent 残留）+ backpackEstK 补位 // v454: 上下文背包 UI 事实格顺序对齐背包容序（fx → biscuit）+ fx 专用标签；restore 从 ctx.facts 重建 fx 消息 // v453: Inbox 逐字回退（char-undo 唯一真理机器接管编辑框 Ctrl+Z/Y）+ 空态占位根治（data-empty-hint：新消息到达即移除，「暂无消息」不再压在已发消息上方） // v452: 热更新 UI 删除（2026-08-10 版本=清单编号重构，update-ui.js 移除，更新 100% 由 C 启动器随 r 托管） // v451: Inbox 联系人列表去重+分割线铁律——conv-flag 头像列删除（国旗+号码直贴左边界，不再双份国旗）；splitter hover 不再变色不换光标形态（光标外观全站铁律：任何元素不自定义 cursor）；splitter 拖动反馈仅背景高亮 // v450: 改名/空壳/tmp 三线根治——lazyRenameScan 改名成功后失效楼层缓存 + 关闭时再扫（会话中改名即落盘）；写路径 _fDir 过期校验（防幽灵目录重建，q174 事故）；归档空 quest 同步移除索引（防 q177 幽灵复活）；all.json.tmp 三防线（parent 级跨实例写锁 + rename 失败清 tmp + 启动清扫 .name 修复） // v449: openFile 无 onRender 时广播 qqq-file-open-in-pane（diff 窗口 open in qqqide 空白修复——tab-manager 直建 pane 不渲染，shell-rpc 监听器未触发） // v448: timeline diff op 菜单——① 第一行改名 open in qqqide（避免与下方编辑按钮大脑分裂）② hover 背景透明修复（--hover-bg rgba 透明叠加→实色 #e2dbc4 亮 / #3a3a3a 暗，op/fuzzy/v-dropdown 三处下拉同步受益） // v447: timeline diff op 菜单——① 打开文件→编辑文件（= Roam Q 键 open in qqqide）② 喂给 AI 动态标签（←喂给 AI/喂给 AI/喂给 AI→ 按焦点面板，Roam 右键传统）③ 主进程宿主窗口定位修复（_hostWindow parent 链优先 + /qqqide/ URL 兜底，根治 getAllWindows()[0] 取错窗口导致 executeJavaScript 静默失败）④ 新增 getAiTarget IPC // v446: 群聊（q150 F16）——服务端 0125 migration + 7 条 /api/group/* + ws group_msg 推送；客户端 dm-ui/网站 dm 群列表/建群/加人/群消息发送者名/群未读，SW 强制刷新 // v445: Inbox 本地缓存+历史分页——dm-ui 会话/消息 localStorage 防抖缓存（启动秒开/离线可读/单会话300条/全会话3000条裁剪）+ 加载更早消息游标分页（?before=<id> 前插合并去重） // v444: Inbox 节能模式——窗口不可见断 WS 转 60s REST 轮询（dm-ui 断 WS 只维护未读数 / gaea-host 徽章 WS 同款节能 + 重连指数退避 5s×2 封顶 30s，根治服务器重启重连风暴）+ 双 WS 未读数通道分工（gaea-host=后台徽章常驻通道, iframe=前台实时渲染） // v443: Roam 标签 hover 召回提示——X 区 gaea 分组最左 Roam 标签悬停瞬间弹出大字号 tooltip「按 Tab 或 F2 键召回我」（.qqq-roam-tip 固定定位 20px 粗体，贴按钮下方，底部越界自动翻到上方；tab-manager.js addGaeaTab 内绑定 mouseenter/leave） // v442: 全部 goods iframe 页补 F2/Tab 非编辑态转发（rage/search-ui/git-ui/dm-ui/kope-a panel.html 五页，同 conv-ui 模式——iframe 内按键不冒泡父窗口）→ 任意 goods 面板一键跳 Roam // v441: 上下文背包 conv-ui.html 补 F2/Tab 非编辑态转发父窗口（同 ai-panel 模式，iframe 内按键不冒泡 → 背包页也能一键跳 Roam） // v440: V23 自动阀值触发条件改为 absolut 可回收收益（按钮一数字）超阈值，出厂默认 600→100K tokens // v439: 背包图解 ╔K 统计修复——多工具合并行（[A → run_command+read_file]）拆分归属绝对工具 + ╔K 判定窗口 80→160（长头行边界漏判），图解绝对盒体部与 absolut 按钮收益对齐 // v438: vibe 豆腐块名称免费窗口内替换为「剩余/预算」数字（1 位小数，如 1.3 / 4.1），非免费恢复活动名 // v437: 原料弹窗文字/按钮全链路 #d98a86→#d9645c（标题/数字/高亮/关闭/CTA/领取钮，外边框保持淡红）+ 网站徽章同步 #d9645c // v435: 原料弹窗全窗淡红（标题/数字/高亮/关闭/CTA 归位 #d98a86，消灭绿色残留） // v434: 原料与基本权利淡红定案（#d98a86 纯色无渐变，v430 已落地，本号强制刷新旧缓存） // v433: Roam 崩溃根治（frag 变量提升陷阱）——loadFileList 的 frag.appendChild('..' 项) 在 var frag 声明之前执行（var 提升为 undefined）→ TypeError reading 'appendChild' → 列表区只显示报错行；frag 创建提前到 try 块首行 // v432: // v432: Roam 按钮 tooltip 原汁原味——szMode/sortBy/open/filesOnTop 8 按钮补 data-tooltip（q3 i18n 中文原文）+ New file/folder 改中文 + paste-tip 已粘贴 + tooltip 单位修复（zoom 0.85 下 innerWidth/clientX 报物理 px 而 fixed/maxWidth 用 CSS px，_ttZoom 统一 → 右边界保护失效/退避错 17.6% 根治）+ mouseenter 未命中不隐藏（q3 语义防闪烁） // v431: F121 三处防崩加固（card-pool getOrCreate _container 兜底 / _appendToCard $messages guard / _buildFloorDOM userEl guard）+ frame-renderer 图片文件名 `_` 变体容错（旧格式 token 引用新格式文件 404 破图 → exists 校验后切换） // v430: 原料与基本权利配色回归淡红 #d98a86 纯色无渐变（外框+状态区条+弹窗条+领取按钮），网站徽章同步 + 星火计划黑底白字 // v428: Inbox 永久联系人+国旗（服务端随消息下发 phone_e164+country_iso2，联系人一次建联永久展示，国旗本地 flags/{cc}.png 照登录区机制；历史会话重启即恢复） // v427: 原料与基本权利配色淡红→橙 // v427: 原料与基本权利配色淡红→橙（边框/进度条/弹窗/按钮全链路 #cb4b16，与网站徽章一致；2026-08-09） // v425: Roam 喂 AI 支持多选——a 键/右键 AI 项遍历全部选中项（selectedItems 逐个 __qqq_aiFeedFile，排除 '..'；单选/右键兜底不变） // v424: 空壳自愈加固——楼层空壳仅归档真空壳（含 all.txt/snapshot/img 的数据目录不归档）+ quest 级空壳归档（_healFloorCounters 零楼层目录 30min → .trash，草稿晋升崩溃残留收敛） // v423: 活动豆腐块清爽↔vibe 配色互换（清爽绿/vibe 蓝）+ 暗色主题进度槽浅色区分 + 弹窗进度槽可见度提升 // v422: Roam 自动感知防幻影闪烁——loadFileList diff 签名（name+type+sz 动态列）无变化零重建 + replaceChildren 原子换入（无 innerHTML='' 空白帧）+ 主进程 250ms 事件突发合并 // v421: 空壳楼层目录自愈（loadAllFloors 无 all.json + mtime>30min → 移入 _qqq/quests/.trash 归档，根治空目录永久残留） // v420: 国旗永久化（login.js 同账号永不重渲染徽章，根治偶发闪烁）+ 徽章图失败重试一次 + 白嫖榜 {ge} ReferenceError 修复 // v419: 内嵌弹窗统一滚动条 100% 等同 a 窗口（设置/排行榜/在线用户/活动弹窗/AI悬浮预览/开新窗口下拉/语言下拉，shell-base.css 一处定义） // v417: 字符→token 估算系数 2.7→2.5 全系统统一（唯一真理源 ContentGateway.CHAR_PER_TOKEN） // v416: 背包压缩按钮数字左侧改 3px 空气墙（-13k 与 absolut 不再粘连）+ 压缩动画时长翻倍（0.8s→1.6s）定格加长（3s→6s） // v415: 工作空间记忆边界加固——recentFolders OS 兜底（本地 recent_folders 丢失拉回+回写）+ fresh=1 不写全局恢复点 + 死路径记忆跳过（防面板永久空白）+ ws.sq3 跨进程 LWW 合并（防双进程丢 key） // v414: 工作空间记忆独立 ws.sq3（%LOCALAPPDATA%/qqqide/ws.sq3，删工作空间记忆不污染 ai.sq3 其他记忆块）+ 恢复链改本地优先（启动目录 global.sq3 → OS ws.sq3 兑底回写，多绿色包不串）+ ai.sq3 ai.workspace.* 一次性迁移 // v413: 工作空间记忆 OS 级唯一真理（ai.workspace.*，异常退出不丢）+ 面板绑定兑底轮询（空白窗口手动加主文件夹后不再全空）+ 主文件夹变更自动重载重绑 // v412: F13 关闭确认根治——废除 beforeunload 拦截-重试收敛（三面板全拦截 + hidden iframe setTimeout 节流 60s → 回车后窗口永不关/60s 自动关误认闪退），改 fire-and-forget 尽力保存 + 不 preventDefault → 确认后窗口立即关闭 // v411: // v411: quest-store 降噪——loadAllFloors 孤儿/新发现/缺失楼层逐行打印改汇总（一次启动 200+ 行 → 3 行）；repair 改名与 loadAllFloors 并发竞态重试（防 70+ FAIL + 双 rebuild 风暴）；floor_counter 键缺失 seed（heal 启动对账 + nextFloorNum 运行时自愈） // v410: Roam 滚动块再左移 2px（thumb right 7px→9px） // v409: new_log 双日志限容回归——toolpush 逐house快照恢复（目录 4MB FIFO 删最旧）+ render-log.jsonl 恢复（主进程 append 侧 2MB 双代轮转 .1，总量 ≤4MB） // v408: F107 滚动块——① Roam thumb right 1px→7px 左移 6px 对齐老板 ② 三处自定义滚动条（Roam customScrollbar / AI 面板 qh / AI 视口 qh）拖拽期间保持粗态：左键按住不松开时光标移出滑轨 x 范围也不再收缩（drag-active class / _thumbDragging / _sbDragging 门控） // v407: new_log 精简——删 toolpush-f*.json 逐house快照（7160文件/143MB）+ render-log.jsonl（标注用后即删）；agent-*.log 保留但 30 天自动轮转 // v406: F10 楼层丢失根治——①编号统一（recovery 楼层 totalFloors 同步目录号，biscuit 不再错位）②完结密封（压缩后禁重复保存，conv=0 覆盖根治）③恢复路径清 _compressFloor ④V21 截断收紧（仅当前楼层 compress 才截断）⑤rename 失败降级复制 // v405: Roam 粘贴二进制损坏根治（F106：iframe RPC proxy 缺 fs.writeBase64 → base64 被当 UTF-8 文本写入 → zip/png/mp3 全部打不开；已补 writeBase64 代理 + 禁静默降级） // v404: Roam 自动感知外部变化（q3 autoWatchChanges 移植，默认开）：主进程 fs.watch 当前目录（6s 冷却 + 临时下载文件智能过滤 .crdownload/.part/.tmp）→ qqqide:roam:fs-changed → iframe reloadCurrentDir；Roam 手动刷新 watchMark 重置冷却防双刷 // v403: 关闭确认 F10 根治——panel-send 保存完成重试改走主进程 IPC closeConfirmed（iframe 内 window.close() 是 no-op 永不关窗）+ Enter 主路径 force 隐藏确认框 // v402: quest-store 洪泛根治 // v402: quest-store 洪泛根治（同号目录 all.json 优先解析 + 仅真实重复告警 + _fDir 跨项目写保护）+ 面板启动主项目稳定性绑定 + 移除 Space+Q global 死绑定 // v401: F2/Tab 根因修复（bootKeyHook 把 key-bindings.json 对象误清成空数组 → 零绑定 → F75/F99 handler 从未被触发；现保持 {version,bindings} 对象直传 init） // v400: F2/Tab 激活 Roam 兜底直连（shell.js bootRoamKeyFallback 独立 capture 监听，key-hook 配置链失效也不静默） // v399: 1/8按钮只显示编队字符（去 ■ 前缀） // v398: 关闭确认无限循环根治（panel-send.js beforeunload 一次性拦截：保存完成前只挡一次，window.close() 重试不再被二次拦截 → 回车/确认后窗口必关，X 不再失灵） // v397: 关闭确认修复三件套——主窗口关闭不再连带销毁其他窗口 + 确认关闭走 close() 触发 beforeunload 持久化刷盘 + Enter/Esc 改 webContents 级捕获（iframe 焦点 100% 响应） // v396: Monaco TS/JS worker stub（诊断全禁后零职责，根治 Could not find source file e%3A 噪音） // v395: 窗口编队 squad（squad-btn.js 菜单行2 LV 左侧按钮+下拉，标题 x■ 前缀，Space+key 召回） // v394: activateRoam 诊断日志 + qoast 可见反馈 // v392: Roam Q 键=开新窗口(主文件夹=选中目录,restore 工作空间) W 键=系统资源管理器打开目录 // v391: Roam 左侧栏文字左移 6px（盘符 nav-item / qq-item / qq-text / qq-file 四规则 padding 10→4 / 18→12） // v390: 背包图解 Q/A ×1 bug 修复（楼层分割正则少一个等号，lookahead 永远不匹配 → 93 层只统计 1 个 Q/A） // v389: F2/Tab 激活 Roam 修复（F99: activateRoam 改走 qqTabs.activateTab，旧实现 btnEl/paneEl 字段不存在导致切换从不生效）+ AI 面板 iframe 转发 F2/Tab // v388: V21 onlyfacts 守卫恢复 32K + compress 楼层跳过 biscuit 占位 + 防 _compressFloor 泄漏 + compress 消息全量清理 // v387: 压缩按钮收益数字去除左侧空格（'-13k' 紧贴按钮文字） // v386: Roam btnNewFolder 按钮标签粘连修复(F73残留) + 619 null防护 // v385: 右键菜单粘贴去重（图片+文本共存只插一次文本，修重复插入） // v384: AI 面板多图粘贴（Ctrl+V 全量收集 + 串行保序 + 三重硬帽） // v383: 三活动豆腐块边框换色（清爽淡蓝 #3f96d8 / 原料淡红 #d98a86 / vibe 绿 #859900） // v382: 国旗唯一渲染机（login.js 竞态根治 + flag 归一 + onerror） // v381: F2 key binding + window.activateRoam handler now activates X-zone tab + focuses iframe // v380: Roam dark theme hover highlight + path-tooltip distinction // v379: Roam empty ctx menu click fix + btnNewFile/btnNewFolder data-tooltip + doCreateFile blur // v378: 修复活动豆腐块 CSS 损坏(注释吞掉 done-fill/.qqq-act-txt 规则) + 满格不再把原料边框改绿 + 赞助商链接常态同色永不下划线 + forced-color-adjust 兼容 Windows 高对比度(进度条渐变被强制抹空) // v377: newline-btn 移到编辑框外右上角（子弹按钮上方） // v376: Roam 文件菜单仅 6 项(AI/code/open/delete/rename/copyPath), 空区菜单复活(CMD=c/PowerShell=x 仅两项) // v374: AI 等级弹窗自定义无轨滚动条(5px)+文字可选中复制 // v373: newline-btn 移到编辑框右上角外侧（子弹按钮左侧） // v372: 赞助商拆分（前缀不带链接+公司名超链接）+ 原料活动边框偏红 + vibe 前缀文字与赞助商 100% 同外观 // v371: vibe 豆腐块常态发光+边框统一 + 状态区免费/非免费统一显示剩余时间 + 距下次/剩前缀同赞助商文字外观 // v369: 赞助商链接改为 por.jsp?id=1&_jcp=5_1 // v368: 赞助商移至三盏绿灯之右 // v367: 状态区排序还原 + vibe 豆腐块边框统一 // v366: 状态区单行 + 窄窗口退避隐藏 + vibe 余额解析修复 // v364: 赞助商 hover 橙色 // v363: 状态栏左下角赞助商文字（zhijiaip.com） // v362: index.html 恢复 klipzap.js + wq-stats.js 加载（F73 误删） // v361: Roam 文件/文件夹名左移 2px // v360: Roam 右键 AI 菜单项（←AI/AI/AI→ 焦点面板）+ CMD 快捷键 a→c

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
  './core/shell-mem-hover.js',
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

