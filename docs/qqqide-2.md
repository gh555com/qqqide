# qqqide 滴上下文背包操作

![](/static/docs/51/img_ce6eda96.png)

> 产品英文名：**context backpack**（上下文背包）/ **grid**（格子）。

## 起源

AI 对话越长，上下文越臃肿。50 层楼之后，每次 API 调用光上下文就要 150K+ tokens——其中 70% 是过期的终端输出、重复的文件内容、再也用不到的搜索摘要。

早期方案尝试让 AI 自己压缩上下文（V3-V10），结果：AI 语义压缩质量不稳定、JSON 输出格式经常出错、thinking 过程吃掉大量预算、压缩结果污染前缀缓存。结论：**大键入 + AI 语义压缩 = 死路。**

V11 转向纯本地机械筛——每层楼完结时自动把对话摘要成 Q/A/工具行，零网络零费用。V12 修复了 splice 导致的前缀缓存断裂。V13 引入双包装盒体系（温柔盒 + 绝对盒）和阀值压缩。V14 修复了 biscuit 重排序带来的缓存全断 bug。V15 引入三按钮压缩体系 + fx 记忆区域。

## 背包结构（小白视角）

每次你按回车发送消息 = 一层"楼"。一楼可能包含多次 AI 调用（房子）和多次工具调用（房间）。

楼层完结后，qqqide 自动把你的对话**机械压缩**成"压缩饼干"：

```
=== F1 2026-07-18 13:26:08 UTC+8 ===
Q: 你查查数据库里那个用户激活没有？
[A → run_command] ssh q@47 psql ... 2318c
[A → read_file] /server-app/foo.js L:1-50/200
A: 已激活，用户 8615802858204 在 2026-07-17 完成激活。
```

- **Q:** = 你说的原话（一字不差）
- **[A → xxx]** = AI 调用了什么工具，结果摘要
- **╔K...╚** = "绝对包装盒"——无法从磁盘复现的工具输出（如终端命令结果），用盒子包起来
- **A:** = AI 的最终回复

饼干逐层追加，永不重写旧内容。这意味着前 20 层楼的饼干在 API 缓存中一字不变 → **前缀缓存命中率 ~90%**。

## 三个压缩按钮怎么用

打开方式：AI 面板右下角点「上下文」→「管理」→ 打开 X 区背包标签页。

背包页面有三个按钮，按性价比从高到低排列：

### 1. absolut — 剔除绝对包装盒

**做什么**：把 ╔K...╚ 盒子里的内容删掉（通常是过期的终端输出），但保留盒子头行（命令本身）和一切温柔包装盒。

**如果没有**：饼干里塞满过期 SQL 输出、build log、40KB 的 JSON 响应——这些内容 5 层楼之后就没用了，但永远留在饼干里，每次 API 调用都带着。

**什么时候用**：日常使用。饼干超过 100K tokens 时点一下，立竿见影。

### 2. edit only — 仅保留写操作

**做什么**：在 absolut 基础上，进一步去掉一切读操作（read_file、search_text、find_files…）的头行，只保留真正改了文件的操作（edit_file、write_file、create_file、delete_file、revert_file）。

**如果没有**：饼干里有几百行 `[A → read_file] /foo.js L:60-70/200`——这些信息对后续对话几乎没用（AI 可以重新读）。

**什么时候用**：长对话后期，饼干臃肿但你只关心「改了什么文件」。

### 3. only facts — AI 提取关键事实

**做什么**：在前两者基础上，把对话原文砍掉一半（只保留最近的一半），让 AI（tier 4）从老的那一半里提取关键 facts，存为 fx（记忆区域）。之后 AI 既能看到最近的完整对话，又能快速回顾早期的关键事实。

**如果没有**：100+ 层楼的对话，AI 很容易"遗忘"早期做出的关键决策。

**什么时候用**：超长对话（50+ 层楼），或者跨多个相关问题的对话。

## 三种压缩分别失去什么、保留什么

### absolut — 剔除绝对包装盒体部

**失去**：5 种不可复现工具的完整输出体——终端命令的输出内容、AI 生成的图片描述/风格信息、图片视觉分析的全部结果、抠图结果。

**保留**：
- 上述 5 种工具的**头行**（工具名 + 参数 + 结果长度摘要）——AI 仍然知道「调了什么工具、传了什么参数、输出有多长」
- 全部 15 种温柔包装盒（读/写/搜索/网络等）——毫发无损
- Q/A/楼层分隔等全部对话结构

**有影响的场景**：
- 你在上一个楼层看到一份巨大 JSON 响应（比如 `psql` 查表结构），下一层想让 AI 引用其中的某个字段名 —— absolut 后 AI 看不到那份 JSON 了
- 你让 AI 分析一张图片 → AI 调用 analyze_image → 下一层想让 AI 基于之前的视觉分析继续工作 —— absolut 后分析结果没了

**没影响的场景**：命令本身还在，AI 可以重跑重新获取输出。

### edit only — 仅保留写操作

**在 absolut 基础上，再额外失去**：
- 全部 15 种温柔工具的头行（read_file、search_text、fetch_webpage 等），包括它们的路径和结果摘要
- 5 种绝对工具的头行（run_command 等 "[A → xxx]" 那一行）

**保留**：
- 5 种写工具的头行（edit_file、write_file、create_file、delete_file、revert_file）——包括改了哪个文件、改了多少行、SHA256（[基于自研timeline体系](https://www.gh555.com/gaea/d/qqqide?lang=zh#docs/timeline-diff-ai-capability)） 
- Q/A/楼层分隔行

**用户理解**：整个对话的「调查过程」消失——AI 不知道之前读过哪些文件、搜过什么关键词、跑过什么命令 （读消失），AI 只知道最后改了什么文件（写保留）。你在编辑框里送出滴一切提问、AI 滴回复（一切结论）保留。

### only facts — AI 提取关键事实 

**在 edit only 基础上，再额外失去**：
- 一半的对话原文， 老的一半对话被砍掉（会尽量按字符数对半分），只剩 AI 提取的 facts。如果 AI 提取遗漏了关键信息，它就永远丢失了。**这是不可逆的。**
- 此外 only facts 需要一次 tier-4 AI 调用，正常计费。

**保留**：
- 最近一半对话的：大Q（用户编辑框送出滴原文）、5 种写工具的头行、大A（AI 滴最终回复即一切结论）。
- 如果压缩成功则新得到 AI 提取的 facts（任务级记忆区域 fx:f3）

**自限机制**：h 原料（老的一半）必须 ≥32K chars 才准许压缩。这意味着当一次压缩滴收益小于32k 时将不再能进行一次"only facts" 压缩。


## 进阶：底层设计原理

### 背包物理结构

```
[0] Z (规则/铁律) — 永不压缩，100% 缓存命中
[1] 压缩饼干 (biscuit) — 逐层追加，前缀缓存命中
[2] fx (facts 记忆区域) — 手动触发，跨楼层持久
[3+] 当前楼层原始消息 — 唯一变化的部分
```

### 机械筛规则

| 原始消息 | 饼干格式 |
|---------|---------|
| user | `Q: [全量内容]`（剥离文件注入块和 CURRENT TIME） |
| assistant 纯文本 | `A: [全量内容]` |
| assistant 含 tool_calls | 先 `A:` 行，再 `[A → xxx] file1, file2` |
| tool 返回（可复现） | 摘要追加到上一工具行 |
| tool 返回（不可复现） | 摘要 + ╔K...╚ 完整输出 |
| system | `[S] [全量内容]` |

### 双包装盒体系

**温柔包装盒**（15 个工具 — 可复现）：read_file、edit_file、write_file、create_file、delete_file、search_text、search_content、find_files、list_files、get_diagnostics、fetch_webpage、search_web、timeline_versions、diff_versions、revert_file。

结果可从磁盘重读或 sha256 引用复现 → 饼干仅保留一行摘要。

**绝对包装盒**（5 个工具 — 不可复现）：run_command、generate_image、remove_background、analyze_image、get_vision_context。

结果不可精确复现（终端输出、模型随机、云端处理）→ ╔K...╚ 包裹，4K 硬帽。

### 三个按钮在底层干了什么

#### absolut（纯本地，零网络零费用）

遍历 biscuitLines，对每一层的 biscuit 文本执行正则 `/\n╔K\n[\s\S]*?\n╚(?=\n|$)/g` 精准剥离绝对盒体部。头行（如 `[A → run_command] "ssh q@47 psql" 2318c`）和温柔盒毫发无损。

替换 biscuit 消息 content 为剥离后的文本 → 持久化 ctx.json → 完成。

#### edit only（纯本地，零网络零费用）

在 absolut 基础上，逐行过滤 biscuit 文本。保留规则：
- `=== F... ===` 楼层分隔行
- `Q:` / `A:` 行
- `[S]` 系统行
- 含 edit_file / write_file / create_file / delete_file / revert_file 的工具头行保留 

其余工具头行（read_file、search_text、run_command 等 15 种）全部丢弃。╔K...╚ 体部已在 absolut 阶段剥离。

#### only facts（本地 + AI 调用，正常计费）

1. 依次执行 absolut + edit only → 得到精简饼干
2. 按字符数对半切：找中间楼层分界（`=== F` 行），下半保留为 r（新饼干基座），上半作为 h 原料
3. h 原料 < 32K chars → 拒绝（收益不足，自然收敛）
4. h 原料写入子弹文件 → 建一层新楼（`_compressFloor: true`，tier 4，az 区外观正常，GE 账单 type=f3）
5. AI 从 h 原料提取 facts → A 回复为 facts 列表
6. 楼层完结 → `_rebuildBackpack` 检测 `_compressFloor` → 跳过（不进饼干），facts 注入 fx 区（biscuit 之后）
7. fx 消息格式：`═══ FACTS 2026-07-18 14:06:40 UTC+8 ═══\n- fact 1\n- fact 2`
8. 多次 only facts → 多个 `═══ FACTS timestamp ═══` 块追加到同一 fx 消息

### 缓存经济学

- Z 消息永不变化 → **100% 缓存命中**
- 饼干逐层尾部追加，旧行字节不变 → **前缀缓存命中**（仅最后一行新）
- fx 仅在手动 only facts 时变化 → 几乎 100% 命中
- 每层实际计费 ~2-4K tokens（仅饼干末行 + 用户新消息）

### 阀值压缩（自动）

建楼中如果 `_lastApiPromptTokens > 600K`（可在设置中调整），自动触发 absolut。防止 61 间 house 的大楼层把饼干撑爆。这是纯生存机制，日常不会触发。
