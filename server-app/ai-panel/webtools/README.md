# webtools — 受控浏览器工具链（AI 操作网页的标配）

qd 自带内核即浏览器：**零外部依赖**（无需 Chrome/Edge、无需装任何驱动），新电脑、
Win7、干净系统全可用。同时支持**用用户机器上已有的 Chrome/Edge 内核**跑同一套工具链
（内核够新）。本目录 = 「受控浏览器」的用法协议 + 现成驱动代码。

```
webtools/
├── README.md         ← 本文件：AI 面向的作业协议（先读这个）
└── kit/
    ├── qdbrowser.py      # 档案槽 × 内核：确保就绪 / 查询 / 停止 / 列举（核心）
    ├── browser_engine.py # 外部内核（Chrome/Edge/Brave/Chromium）发现与启动
    ├── cdp.py            # 最小 CDP 客户端（自动发现端口 + 身份槽）
    ├── fill.py           # 三档填框（React 吃字治理）
    ├── pin.py            # 剪贴板注入（富文本粘贴；Windows/macOS/Linux 全平台）
    ├── probe.py          # 页面探针（到新站第一步）
    ├── demo.py           # 30 秒验通
    ├── selftest.py       # 端到端自检（内置内核域：可见/隐藏/二次实例/空闲自退/exit-with）
    └── cdp_launch.py     # 外部内核启动（命令行兼容壳，逻辑全在 browser_engine + qdbrowser）
```

## 快速开始（三步）

```bash
# ① 确保受控浏览器就绪（没有就起，有就复用）——打印端点 JSON（含 cdpPort / engine / slot）
python kit/qdbrowser.py ensure

# ② 验通链路（连上 → 导航 → 读回 → 截图）
python kit/demo.py

# ③（推荐）整机自检：可见/隐藏/二次实例/空闲自退/exit-with 一把过（约 4 分钟）
python kit/selftest.py
```

依赖（仅两个，标准环境一次装好）：`pip install requests websocket-client`
（缺依赖时 pip 装到当前解释器即可；在 qd 里运行会自动用内置 Python。）

系统小工具（可选增强，缺失只降级不报错）：
- **Linux**：`xclip`/`wl-copy`（富文本剪贴板）、`xdotool`（最小化窗口自动恢复）、`xprop`（窗口状态检测）。
- **macOS / Windows**：剪贴板与窗口恢复均用系统自带能力，无需额外安装。

## 两个维度：档案槽 × 内核

**内核是消耗品，档案是资产。**

| 维度 | 是什么 | 谁拥有 | 换掉会怎样 |
|---|---|---|---|
| **档案槽（slot）** | 身份：cookie / 登录态 / storage | 用户（落在 qd 的 Data 下，可备份、可迁移、不上云） | 换槽 = 换身份（要重新登录） |
| **内核（engine）** | 跑这份档案的浏览器引擎 | 不是我们的（外部=厂商的；内置=随 qd 发布走） | 换内核 = 换档案罐子（**登录态不跨内核通用**） |

因此：**槽位首次使用后即钉住内核**；显式换内核必须 `--rebind`（旧档案原样保留，随时可换回）。

### 内核选谁

| engine | 是什么 | 优点 | 代价 |
|---|---|---|---|
| `builtin` | qd 自带内核（Electron） | 零依赖；Win7 可用；**受控最严**（权限白名单三项 / 导航白名单 / 下载恒落 Data / 隐藏档 / 空闲自退 / 监督跟随） | 内核版本随 qd 发布走（不是最新） |
| `external` | 用户机器已装的 Chrome / Edge / Brave / Chromium | **内核够新**（主流站点零兼容债）；多标签原生 | 没有上面的实例级受控能力；用户机器上没装就用不了 |
| `auto`（默认） | 槽有档案 → 按档案；新槽 → 有外部内核用外部，否则内置 | 两头好处 | —— |

外部内核发现在此顺序：`--browser` / 环境变量 `CDP_BROWSER` → 系统注册表 App Paths
（Chrome/Edge 安装器必写）→ 标准安装路径 → `PATH`。便携版浏览器（不在注册表）用前两者指定。

### 档案布局（`{Data}` = 装包数据根）

```
{Data}/browser-host/                         ← 槽 default + 引擎 builtin（历史路径，登录态原地保留）
{Data}/browser-profiles/<槽>/slot.json        ← 槽元数据 {slot, label, active, engines}
{Data}/browser-profiles/<槽>/builtin/         ← 内置内核档案（Electron userData）
{Data}/browser-profiles/<槽>/external/        ← 外部内核档案（Chrome --user-data-dir）
```

## 多身份（多账号并行）——这是它存在的理由

AI 需要「我在哪个身份里操作」，不是「碰运气开个浏览器」。一个槽 = 一个身份，可同时在线：

```bash
# 两个账号并行（各起一个内核、各占一个端口、cookie 完全隔离）
python kit/qdbrowser.py ensure --profile aliyun-a --label "阿里云 divaci" --url https://www.aliyun.com
python kit/qdbrowser.py ensure --profile aliyun-b --label "阿里云 192"    --url https://www.aliyun.com

# 看全部槽位与存活状态
python kit/qdbrowser.py list

# 之后任何 kit 脚本只要设一个环境变量，就恒在那个身份里操作
set CDP_PROFILE=aliyun-a
python kit/probe.py aliyun.com
```

Python 里：

```python
import qdbrowser, cdp
ep = qdbrowser.ensure_started(profile="aliyun-a")   # 起/复用该身份
cdp.use_profile("aliyun-a")                         # 之后一切调用恒走它
```

**身份铁律：槽位绝不自动回退到别的槽**（算不出就报错，不猜）。工具链全部走
`CDP_PROFILE` / `--profile` 单一入口。

## 受控浏览器域（它是什么）

- **端口自选**：外部内核 `--remote-debugging-port=0`，端口由内核写进档案目录的
  `DevToolsActivePort`（零竞态）；内置内核从 8335 段探空口。**你不需要记端口**。
- **端点唯一契约**：`{档案目录}/host.json`——内置由壳层每 4s 心跳写，外部由 kit 启动时写；
  存活由 CDP 探测 + 实例身份（内置按 pid / 外部按 wsId）裁决。`cdp.py` 自动读取，
  两个 kit 各自 TEMP 不同也能互见同一实例。
- **窗口**：默认可见（人可监工；AI 干活、人看效果）。批处理用 `ensure --hidden` 开静默档。
- **登录态持久**：扫码登录一次，长期免登（存在该槽档案里）。
- **退出**：关掉浏览器窗口即退出（登录态保留）；或 `python kit/qdbrowser.py stop --profile <槽>`。
- **换机器**：什么都不用配——qd 装在哪，浏览器就在哪（内核路径由工具包自身位置推导，
  三平台一致；多装包并存用 `--shell` 或环境变量 `QQQIDE_SHELL` 指定）。
  ★ 同装优先：启动器广播的 `QQQIDE_PYTHON_DIR` 与本 kit 位置推出不同安装时，
  以「{Data} 与本 kit 一致」的那个为准（防「开发树的数据 + 绿色包的壳层」）。

### 静默档（--hidden）

- **内置内核**：hidden 是**实例级属性**——隐藏档实例**不会被任何二次请求弹出/抢焦点**
  （防批量任务中途冒窗），`window.open` 子窗也继承隐藏。
- **外部内核**：hidden ≈ `--headless=new`（无窗口），语义不同（没有「随时唤醒那个可见窗」这回事）。
- **需要用户看时**（扫码/验证码）：先 `stop` 再 `ensure`（可见）——登录态在档案里，不丢。
- **空闲自退**：仅内置。隐藏档默认 **30 分钟**无 CDP 客户端连接且无页面活动 → 自行退出。
  覆盖：`ensure --hidden --idle-exit 120`（分钟；`0` = 关闭）。可见档默认不自动退出。
  外部内核**没有**自退（Chrome 关掉最后一个标签页即退出；headless 档必须显式 `stop`）。
- **任务跟随**（可选，仅内置）：`ensure --exit-with <pid>`——监督进程退出时浏览器跟着退出。

### ensure --url 语义

- 新起实例：窗口直接加载该网址。
- 复用现有实例：**内置** = 导航主窗（不开新窗）；**外部** = 新开一个标签页（不夺你正看着的那页）。

## cdp.py 速查

| 调用 | 作用 |
|---|---|
| `cdp.use_profile("aliyun-a")` | 切身份槽（之后一切调用恒走它） |
| `cdp.tab_for_url("baike.baidu.com")` | 按 URL 子串定位页（**永远这样定位，绝不按序号**） |
| `cdp.first_page()` | 取第一个页（兜底） |
| `cdp.version()` | 当前端点的内核标识（`Chrome/138.0.7204.158` 这种） |
| `cdp.Tab(t["webSocketDebuggerUrl"])` | 连接该页 |
| `tab.goto(url, wait=3)` | 导航 |
| `tab.js("document.title")` | 执行 JS 并取回值 |
| `tab.insert_text("文字")` | **可信打字**（insertText——React 也认；先聚焦目标元素） |
| `tab.click_xy(x, y)` / `tab.hover_xy(x, y)` | 真鼠标（坐标先 `tab.clamp(x, y)` 钳进视口） |
| `tab.press_key("Enter", vk=13, code="Enter")` | 按键 |
| `tab.shot("x.png")` | 截图（窗口被遮挡/失焦照样出图；最小化自动无焦点恢复；隐藏档自动唤醒帧） |
| `tab.viewport()` | 取视口尺寸 |

## 铁律（违反=白干，血泪版）

1. **先探再动**：到新站先 `probe.py`，别按猜测写选择器。
2. **写后必验**："没报错" ≠ "成功"——填框读回值、上传数产物、点确定查弹窗+扫报错词。
3. **坐标必钳制**：真鼠标坐标超出视口会**静默落空**（`tab.clamp`）。
4. **打字用 `insert_text`**；直接 `js("el.value=...")` 会被 React 吃字（要写值就用三档填框 `fill.py`）。
5. **抓取竞态**：页面自动抓取/校验会**清空你刚填的字段**——等状态尘埃落定再确认；确认前复检关键字段。
6. **同名控件先 dump 再选**；一切元素先过滤"可见"（`offsetHeight>0 && rect.width>0`）。
7. **hover 才挂载的菜单**：先 `hover_xy` 等出现，再对菜单项用 JS `click()` 或量坐标点击。
8. **登录/验证码/人脸 = 唯一叫人项**：停下来把窗口留给用户操作，完成后再继续。不硬闯风控。
9. **花钱/不可逆动作**（提交/发布/付款/删除）：停下等用户一句确认（除非已明确预授权）。
10. **身份恒带槽**：多身份场景每次调用都要明确 `--profile` / `CDP_PROFILE`；绝不靠"默认槽"
    猜（猜错 = 拿别人的登录态操作，最坏的错法）。
11. 每个关键动作前一句话说明"我在干什么"（用户屏幕是直播状态）。

## 平台与实态（实话）

| 平台 | 受控浏览器（内置） | 外部内核 |
|---|---|---|
| Windows | ✅ 真机全量实测 | ✅ 真机实测（Chrome 138：起/停/复用/导航/新标签/CDP 读写/截图） |
| macOS | ✅ 真机全量实测（macOS 12 x64） | 路径发现已覆盖（.app 三处），待真机复跑 |
| Linux | ✅ 真机全量实测（Ubuntu 24.04 · Wayland/XWayland） | 路径发现已覆盖（`PATH` 系），待真机复跑 |

其余边界：

- 内置内核 = qd 壳层内核（版本随 qd 发布走）。主流站点全兼容；个别强风控/新版特性站点用外部内核。
- 下载文件（内置）：自动落 `{档案目录}/Downloads/`（重名 `name_1.ext`），不落 C 盘；
  启动后台浅清：30 天龄直清 + 总量 2GB 硬线按最老优先清到 1.5GB（不碰 24 小时内的新文件）。
  外部内核的下载走它自己的下载目录（不受我们控）。
- 内置受控窗口开可见窗期间，qd 的自动更新会等窗口关闭后再换装（正常现象）；隐藏档无可见窗，不推迟。
- 该窗口**设计上不可最小化**（最小化会暂停渲染 → 截图等待）：Windows/Linux 里系统级手段仍可能
  把它收起来——截图前会自动恢复（Windows 无焦点恢复；Linux 需 `xdotool`，无则截图会明确报错
  「渲染帧停产」）；macOS 里这条路径结构性不可达（窗口没有最小化能力）。想收起来请直接关闭窗口——
  下次任务自动重开，登录态保留。被别家窗口遮挡不影响截图（本窗帧供给不因遮挡中断）。
- 外部内核会显示浏览器自己的「受自动测试软件控制」提示条——那是内核行为，去不掉，但不影响操作。
- 旧版 qd 的包里没有这套能力时，`qdbrowser.py` 会**明确报错**（不会误启动老包）；具名槽还要求
  壳层支持档案槽开关，老壳层同样明确拒绝（绝不静默落回默认档案）。
- 完整教材（原理/14 个操作模式/12 个真实坑/场景作战手册）＝ qd 源码仓 `do/CDP自动化经验包/`
  （分发 zip 同名；本目录是其中「机器可直接用」的那部分）。

## 一句话

让 AI 自己开浏览器、自己连网站、自己操作一切——**身份是参数，内核是可换件**，人只扫码、只点头。
